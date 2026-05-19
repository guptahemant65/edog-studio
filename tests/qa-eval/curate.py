#!/usr/bin/env python3
"""F27 P9 T4-D — gold-corpus curator workbench.

Walks a curator through promoting PENDING_HUMAN_GRADING fixtures to
GRADED_PASS_1 without hand-editing JSON envelopes. Three subcommands:

    list                          show all fixtures + their grading status
    prepare PR-NNN [--from-actual] write a draft expected.json + open editor
    finalize PR-NNN [--basis B]    validate draft and flip curator_state

Blind grading discipline:
    Default ``prepare`` mode emits an EMPTY scenarios list with a guidance
    comment block — the curator drafts each scenario from diff.patch alone,
    without seeing the LLM's actual.json. This matches the existing graded
    fixtures' ``pass_1_basis = "diff_inspection_blind"``.

    ``--from-actual`` mode seeds the draft with the LLM's captured scenarios
    (carrying over id, category, verb, topic→title, grounding_changed_lines)
    so the curator only fills behavior_key + rationale + criticality and
    deletes rejected rows. Faster but anchor-biased — pass_1_basis becomes
    ``"actual_review_anchored"`` and the scorer flags it accordingly.

    ``finalize`` enforces required fields (behavior_key non-empty, rationale
    non-empty, criticality ∈ {P0,P1,P2,P3}) and stamps curator + curated_at.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GROUND_TRUTH = ROOT / "ground-truth"

VALID_CRITICALITY = {"P0", "P1", "P2", "P3"}
VALID_CURATOR_STATES = {"PENDING_HUMAN_GRADING", "GRADED_PASS_1"}
VALID_BASIS = {"diff_inspection_blind", "actual_review_anchored"}


def _fixture_dir(pr_number: str) -> Path:
    name = pr_number if pr_number.startswith("PR-") else f"PR-{pr_number}"
    p = GROUND_TRUTH / name
    if not p.is_dir():
        raise SystemExit(f"[curate] fixture directory not found: {p}")
    return p


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _cmd_list(args: argparse.Namespace) -> int:
    rows = []
    for fx in sorted(GROUND_TRUTH.iterdir()):
        if not fx.is_dir() or not fx.name.startswith("PR-"):
            continue
        exp_path = fx / "expected.json"
        if not exp_path.exists():
            continue
        exp = _load_json(exp_path)
        has_actual = (fx / "actual.json").exists()
        has_plan = (fx / "architect_plan.json").exists()
        rows.append(
            (
                fx.name,
                exp.get("curator_state", "?"),
                len(exp.get("scenarios", []) or []),
                "Y" if has_actual else "-",
                "Y" if has_plan else "-",
            )
        )

    if args.pending:
        rows = [r for r in rows if r[1] == "PENDING_HUMAN_GRADING"]
    if args.graded:
        rows = [r for r in rows if r[1] == "GRADED_PASS_1"]

    print(f"{'PR':<14} {'state':<24} {'scenarios':>9}  {'actual':>6}  {'plan':>4}")
    print("-" * 64)
    for name, state, n, ha, hp in rows:
        print(f"{name:<14} {state:<24} {n:>9}  {ha:>6}  {hp:>4}")
    return 0


def _scenario_template(index: int, pr_number: str) -> dict:
    """Empty scenario row for blind drafting."""
    return {
        "id": f"{pr_number}-s{index:02d}",
        "behavior_key": "REPLACE_ME_stable_snake_case",
        "category": "HappyPath",
        "verb": "FieldMatch",
        "title": "REPLACE_ME — what the scenario asserts on the wire",
        "rationale": "REPLACE_ME — why this matters, link to the load-bearing change",
        "criticality": "P1",
        "discovered_by": "diff_inspection",
        "grounding_changed_lines": [{"path": "REPLACE_ME/path/relative/to/repo.cs", "side": "right", "lines": [0]}],
    }


def _seed_from_actual(actual: dict, pr_number: str) -> list[dict]:
    """Carry over fields from the LLM's actual.json for the anchored path."""
    out = []
    for i, sc in enumerate(actual.get("scenarios", []) or [], start=1):
        out.append(
            {
                "id": f"{pr_number}-s{i:02d}",
                "behavior_key": "REPLACE_ME_stable_snake_case",
                "category": sc.get("category", "HappyPath"),
                "verb": sc.get("verb", "FieldMatch"),
                "title": sc.get("topic") or sc.get("title") or "REPLACE_ME",
                "rationale": "REPLACE_ME — anchored from LLM scenario; confirm grounding",
                "criticality": "P1",
                "discovered_by": "diff_inspection",
                "grounding_changed_lines": sc.get("grounding_changed_lines", []),
                "_source_llm_stage": sc.get("stage"),
                "_source_llm_id": sc.get("id"),
            }
        )
    return out


def _open_in_editor(path: Path) -> None:
    """Open path in $EDITOR (or notepad on Windows fallback). Best-effort."""
    editor = os.environ.get("EDITOR") or os.environ.get("VISUAL")
    if not editor:
        editor = "notepad" if os.name == "nt" else "vi"
    try:
        subprocess.run([editor, str(path)], check=False)
    except Exception as ex:
        print(f"[curate] could not launch editor '{editor}': {ex}", file=sys.stderr)
        print(f"[curate] edit manually: {path}", file=sys.stderr)


def _cmd_prepare(args: argparse.Namespace) -> int:
    fx = _fixture_dir(args.pr_number)
    pr_number = fx.name.removeprefix("PR-")
    exp_path = fx / "expected.json"

    if not exp_path.exists():
        raise SystemExit(f"[curate] expected.json missing — fixture not initialized: {exp_path}")
    exp = _load_json(exp_path)

    if exp.get("curator_state") == "GRADED_PASS_1" and not args.force:
        raise SystemExit(
            f"[curate] {fx.name} is already GRADED_PASS_1. Pass --force to re-prepare "
            "(destructive: overwrites curated scenarios)."
        )

    backup = fx / "expected.json.bak"
    shutil.copy2(exp_path, backup)

    if args.from_actual:
        actual_path = fx / "actual.json"
        if not actual_path.exists():
            raise SystemExit(f"[curate] --from-actual requires actual.json (missing: {actual_path})")
        scenarios = _seed_from_actual(_load_json(actual_path), pr_number)
        basis = "actual_review_anchored"
        n_seed = len(scenarios)
    else:
        scenarios = [_scenario_template(i, pr_number) for i in range(1, args.empty_rows + 1)]
        basis = "diff_inspection_blind"
        n_seed = args.empty_rows

    draft = {
        "schema_version": "2.0",
        "pr_number": pr_number,
        "curator_state": "PENDING_HUMAN_GRADING",
        "curated_at": None,
        "curator": None,
        "pass_1_basis": basis,
        "scenarios": scenarios,
    }
    _write_json(exp_path, draft)

    print(f"[curate] {fx.name} drafted ({n_seed} {'seeded' if args.from_actual else 'blank'} scenarios, basis={basis})")
    print(f"[curate] backup -> {backup}")
    print(f"[curate] diff   -> {fx / 'diff.patch'}")
    if (fx / "actual.json").exists() and not args.from_actual:
        print(f"[curate] (LLM actual at {fx / 'actual.json'} — keep CLOSED until blind draft is done)")
    if not args.no_editor:
        _open_in_editor(exp_path)
    print(f"[curate] when done editing: python tests/qa-eval/curate.py finalize {fx.name}")
    return 0


def _validate_scenario(sc: dict, idx: int) -> list[str]:
    errors: list[str] = []
    bk = sc.get("behavior_key", "")
    if not bk or bk.startswith("REPLACE_ME"):
        errors.append(f"scenarios[{idx}].behavior_key missing or template-placeholder")
    rat = sc.get("rationale", "")
    if not rat or rat.startswith("REPLACE_ME"):
        errors.append(f"scenarios[{idx}].rationale missing or template-placeholder")
    crit = sc.get("criticality", "")
    if crit not in VALID_CRITICALITY:
        errors.append(f"scenarios[{idx}].criticality must be one of {sorted(VALID_CRITICALITY)} (got '{crit}')")
    title = sc.get("title", "")
    if not title or title.startswith("REPLACE_ME"):
        errors.append(f"scenarios[{idx}].title missing or template-placeholder")
    if len(title) > 200:
        errors.append(f"scenarios[{idx}].title exceeds 200 chars")
    gcl = sc.get("grounding_changed_lines", [])
    if not isinstance(gcl, list) or len(gcl) == 0:
        errors.append(f"scenarios[{idx}].grounding_changed_lines must be a non-empty list")
    else:
        for j, anchor in enumerate(gcl):
            path = anchor.get("path", "")
            if not path or path.startswith("REPLACE_ME"):
                errors.append(f"scenarios[{idx}].grounding_changed_lines[{j}].path placeholder/empty")
            lines = anchor.get("lines", [])
            if not isinstance(lines, list) or len(lines) == 0 or 0 in lines:
                errors.append(
                    f"scenarios[{idx}].grounding_changed_lines[{j}].lines must be a non-empty list of positive ints"
                )
    return errors


def _cmd_finalize(args: argparse.Namespace) -> int:
    fx = _fixture_dir(args.pr_number)
    exp_path = fx / "expected.json"
    exp = _load_json(exp_path)

    scenarios = exp.get("scenarios", []) or []
    if not scenarios and not args.allow_empty:
        raise SystemExit(
            f"[curate] {fx.name}: expected.json has 0 scenarios. "
            "If this PR has no testable behavioural changes (e.g. Dependabot bump), pass --allow-empty."
        )

    errors: list[str] = []
    for i, sc in enumerate(scenarios):
        errors.extend(_validate_scenario(sc, i))

    seen_keys: set[str] = set()
    for i, sc in enumerate(scenarios):
        bk = sc.get("behavior_key", "")
        if bk and bk in seen_keys:
            errors.append(f"scenarios[{i}].behavior_key '{bk}' is duplicated")
        seen_keys.add(bk)

    if errors:
        print(f"[curate] FAIL: {fx.name} has {len(errors)} validation error(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 2

    basis = args.basis or exp.get("pass_1_basis") or "diff_inspection_blind"
    if basis == "pending_curator_review":
        # Untouched initialization sentinel — assume blind if curator skipped prepare.
        basis = "diff_inspection_blind"
    if basis not in VALID_BASIS:
        raise SystemExit(f"[curate] --basis must be one of {sorted(VALID_BASIS)} (got '{basis}')")

    exp["curator_state"] = "GRADED_PASS_1"
    exp["curated_at"] = _dt.date.today().isoformat()
    exp["curator"] = args.curator or os.environ.get("EDOG_CURATOR") or "hemant"
    exp["pass_1_basis"] = basis

    # strip the optional debug fields we added in --from-actual seed
    for sc in exp["scenarios"]:
        sc.pop("_source_llm_stage", None)
        sc.pop("_source_llm_id", None)

    _write_json(exp_path, exp)
    backup = fx / "expected.json.bak"
    if backup.exists():
        backup.unlink()

    n = len(exp["scenarios"])
    print(f"[curate] {fx.name} -> GRADED_PASS_1 ({n} scenarios, basis={basis}, curator={exp['curator']})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="curate", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="show all fixtures with grading status")
    p_list.add_argument("--pending", action="store_true", help="only show PENDING_HUMAN_GRADING")
    p_list.add_argument("--graded", action="store_true", help="only show GRADED_PASS_1")
    p_list.set_defaults(fn=_cmd_list)

    p_prep = sub.add_parser("prepare", help="write a draft expected.json + open editor")
    p_prep.add_argument("pr_number", help="PR number (with or without PR- prefix)")
    p_prep.add_argument(
        "--from-actual", action="store_true", help="seed scenarios from LLM actual.json (anchored mode)"
    )
    p_prep.add_argument(
        "--empty-rows", type=int, default=3, help="number of blank scenario templates to emit in blind mode (default 3)"
    )
    p_prep.add_argument("--no-editor", action="store_true", help="skip launching $EDITOR")
    p_prep.add_argument(
        "--force", action="store_true", help="re-prepare a fixture that is already GRADED_PASS_1 (destructive)"
    )
    p_prep.set_defaults(fn=_cmd_prepare)

    p_fin = sub.add_parser("finalize", help="validate draft and flip state to GRADED_PASS_1")
    p_fin.add_argument("pr_number", help="PR number (with or without PR- prefix)")
    p_fin.add_argument(
        "--basis", choices=sorted(VALID_BASIS), help="override pass_1_basis (defaults to whatever prepare set)"
    )
    p_fin.add_argument("--curator", help="curator name (defaults to $EDOG_CURATOR or 'hemant')")
    p_fin.add_argument(
        "--allow-empty", action="store_true", help="allow finalizing a fixture with 0 scenarios (no-test anchor)"
    )
    p_fin.set_defaults(fn=_cmd_finalize)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
