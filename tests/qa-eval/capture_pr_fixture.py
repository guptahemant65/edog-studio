#!/usr/bin/env python3
"""F27 P9 T4-C-prep — capture a PR fixture for the gold corpus.

Given a (pr_number, merge_commit_sha) pair from a local FLT clone,
materializes a new ``tests/qa-eval/ground-truth/PR-NNN/`` directory
with the deterministic fixtures the scorer expects:

* ``pr.json``        — PR metadata (matches existing schema).
* ``diff.patch``     — ``git diff merge^1 merge_commit`` with stable
                       flags + SHA-256 footer for reproducibility.
* ``notes.md``       — curator-notes skeleton with title + SHAs +
                       files-changed list pre-populated; the
                       "Expected scenarios" + "Rejected alternatives"
                       sections are PENDING.
* ``expected.json``  — schema 2.0 with curator_state =
                       PENDING_HUMAN_GRADING and empty scenarios.

NO ``actual.json``, NO ``architect_plan.json`` are written — those
require paid V2 capture via ``capture_v2_actuals.py``.

This script makes NO outbound network calls and NO LLM calls. It
only reads from a local FLT git clone and writes files. Run it after
``pick_corpus_candidates.py`` produces the selection manifest.

Usage::

    # Single PR by number + sha:
    python tests/qa-eval/capture_pr_fixture.py \
        --flt-repo C:/Users/USER/newrepo/workload-fabriclivetable \
        --pr-number 960426 \
        --merge-commit-sha 1234abcd...

    # Bulk: capture every selected entry from the manifest:
    python tests/qa-eval/capture_pr_fixture.py \
        --flt-repo C:/Users/USER/newrepo/workload-fabriclivetable \
        --from-manifest tests/qa-eval/corpus_candidates.json

    # Dry-run (print plan, write nothing):
    python tests/qa-eval/capture_pr_fixture.py \
        --from-manifest tests/qa-eval/corpus_candidates.json --dry-run
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH_DIR = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
DEFAULT_MANIFEST = REPO_ROOT / "tests" / "qa-eval" / "corpus_candidates.json"
DEFAULT_FLT_REPO = Path("C:/Users/guptahemant/newrepo/workload-fabriclivetable")

EXPECTED_SCHEMA_VERSION = "2.0"
PENDING_STATE = "PENDING_HUMAN_GRADING"

DIFF_FLAGS = (
    "--no-ext-diff",
    "--find-renames",
    "--find-copies",
    "--unified=3",
)


def _run_git(repo: Path, *args: str) -> str:
    cmd = ["git", "-C", str(repo), "-c", "core.autocrlf=false", "-c", "diff.external=", *args]
    proc = subprocess.run(
        cmd, capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git command failed (exit {proc.returncode}): {' '.join(cmd)}\n"
            f"stderr: {(proc.stderr or '')[-2000:]}"
        )
    return proc.stdout or ""


def _git_remote_url(repo: Path) -> str:
    try:
        return _run_git(repo, "config", "--get", "remote.origin.url").strip()
    except RuntimeError:
        return "(no remote.origin.url configured)"


def _git_version() -> str:
    try:
        proc = subprocess.run(
            ["git", "--version"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", check=False,
        )
        return (proc.stdout or "").strip()
    except OSError:
        return "(git not available)"


def _resolve_sha(repo: Path, ref: str) -> str:
    return _run_git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()


def _commit_subject(repo: Path, sha: str) -> str:
    return _run_git(repo, "log", "-1", "--pretty=format:%s", sha).strip()


def _commit_authored_iso(repo: Path, sha: str) -> str:
    return _run_git(repo, "log", "-1", "--pretty=format:%aI", sha).strip()


def _commit_author_email(repo: Path, sha: str) -> str:
    return _run_git(repo, "log", "-1", "--pretty=format:%ae", sha).strip()


def _commit_body(repo: Path, sha: str) -> str:
    return _run_git(repo, "log", "-1", "--pretty=format:%b", sha).strip()


def _diff(repo: Path, base_sha: str, head_sha: str) -> str:
    return _run_git(repo, "diff", *DIFF_FLAGS, base_sha, head_sha)


def _numstat(repo: Path, base_sha: str, head_sha: str) -> list[dict[str, Any]]:
    out = _run_git(repo, "diff", "--no-ext-diff", "--find-renames", "--numstat", base_sha, head_sha)
    files: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        try:
            adds = int(parts[0]) if parts[0] != "-" else 0
            dels = int(parts[1]) if parts[1] != "-" else 0
        except ValueError:
            adds = dels = 0
        files.append({"path": parts[2], "additions": adds, "deletions": dels})
    return files


# ── fixture writers ────────────────────────────────────────────────


def _make_pr_json(
    *,
    pr_number: str,
    title: str,
    merge_commit_sha: str,
    base_sha: str,
    head_sha: str,
    files: list[dict[str, Any]],
    diff_size_bytes: int,
    diff_sha256: str,
    authored_date: str,
    author_email: str,
    body: str,
    flt_remote: str,
) -> dict[str, Any]:
    return {
        "pr_number": pr_number,
        "pr_url": f"(ADO; reconstruct from origin: {flt_remote})",
        "repo": flt_remote,
        "title": title,
        "description": body,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "merge_commit_sha": merge_commit_sha,
        "author_email": author_email,
        "authored_date": authored_date,
        "files_changed": len(files),
        "files": files,
        "diff_path": "diff.patch",
        "diff_size_bytes": diff_size_bytes,
        "diff_sha256": diff_sha256,
        "captured_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "captured_from": str(flt_remote),
        "capture_tool": "tests/qa-eval/capture_pr_fixture.py",
        "diff_command": "git diff " + " ".join(DIFF_FLAGS) + " <base_sha> <head_sha>",
        "git_version": _git_version(),
    }


def _make_expected_json(pr_number: str) -> dict[str, Any]:
    return {
        "schema_version": EXPECTED_SCHEMA_VERSION,
        "pr_number": pr_number,
        "curator_state": PENDING_STATE,
        "curated_at": None,
        "curator": None,
        "pass_1_basis": "pending_curator_review",
        "scenarios": [],
    }


def _make_notes_md(
    *,
    pr_number: str,
    title: str,
    base_sha: str,
    head_sha: str,
    files: list[dict[str, Any]],
    pr_description: str,
) -> str:
    lines: list[str] = []
    lines.append(f"# PR {pr_number} — Curator Notes")
    lines.append("")
    lines.append(f"**Title:** {title}")
    lines.append(f"**Base:** `{base_sha}`")
    lines.append(f"**Head:** `{head_sha}`")
    lines.append(f"**Files changed:** {len(files)}")
    lines.append("")
    lines.append("## PR description (from commit body)")
    lines.append("")
    if pr_description:
        for line in pr_description.splitlines():
            lines.append("> " + line if line else ">")
    else:
        lines.append("> _(no commit body)_")
    lines.append("")
    lines.append("## Files changed")
    lines.append("")
    for f in files[:50]:
        lines.append(f"- `{f['path']}` (+{f['additions']} / -{f['deletions']})")
    if len(files) > 50:
        lines.append(f"- _… {len(files) - 50} more, see pr.json_")
    lines.append("")
    lines.append("## Change-shape classification")
    lines.append("")
    lines.append("_Pending: classify per F27 P9 §6 (controller / retry / DAG / schema / config)._")
    lines.append("")
    lines.append("## Expected scenarios (hand-grade)")
    lines.append("")
    lines.append(
        "_Pending: enumerate the scenarios a production-grade LLM SHOULD generate"
    )
    lines.append(
        "for this diff, with grounding evidence. These become `expected.json`._"
    )
    lines.append("")
    lines.append("## Rejected alternatives")
    lines.append("")
    lines.append(
        "_Pending: scenarios the LLM might generate that should be rejected"
    )
    lines.append("(over-grounded, hallucinated, irrelevant, low-value)._")
    lines.append("")
    lines.append("## Curator workflow")
    lines.append("")
    lines.append("1. Read `diff.patch` carefully — identify every behavioural change.")
    lines.append("2. For each behavioural change, draft a scenario:")
    lines.append("   - `behavior_key`: stable snake_case identifier for the behavior.")
    lines.append("   - `category`: one of HappyPath, EdgeCase, ErrorPath, Regression, Performance.")
    lines.append("   - `verb`: one of FieldMatch, FieldRangeMatch, EventPresent, EventAbsent, … (closed 16-verb vocabulary; see EdogQaLlmClient.cs).")
    lines.append("   - `title`: one-line summary of what the scenario asserts.")
    lines.append("   - `rationale`: WHY this scenario matters — link to the load-bearing change.")
    lines.append("   - `criticality`: P0 / P1 / P2 / P3.")
    lines.append("   - `discovered_by`: 'diff_inspection' for hand-graded scenarios.")
    lines.append("   - `grounding_changed_lines`: list of `{path, side, lines}` pointing at the exact lines that motivate the scenario.")
    lines.append("3. Promote `expected.json` from `PENDING_HUMAN_GRADING` to `GRADED_PASS_1` by filling `curator_state`, `curated_at`, `curator`, `pass_1_basis`.")
    lines.append("4. Once promoted, run `python tests/qa-eval/capture_v2_actuals.py --fixture PR-{pr_number}` to capture the LLM's actual output (paid).")
    lines.append("5. Run `python tests/qa-eval/score_eval.py` to re-score the corpus.")
    lines.append("")
    return "\n".join(lines)


# ── main capture ────────────────────────────────────────────────────


def capture(
    *,
    flt_repo: Path,
    pr_number: str,
    merge_commit_sha: str,
    out_dir: Path | None = None,
    dry_run: bool = False,
    overwrite: bool = False,
) -> Path:
    """Capture a single PR fixture. Returns the output directory."""
    target = out_dir or (GROUND_TRUTH_DIR / f"PR-{pr_number}")

    if target.exists() and not overwrite:
        raise FileExistsError(
            f"Fixture dir already exists: {target}. Pass --overwrite to replace it."
        )

    # Resolve SHAs against the actual repo state.
    head_sha = _resolve_sha(flt_repo, merge_commit_sha)
    base_sha = _resolve_sha(flt_repo, f"{merge_commit_sha}^1")
    title = _commit_subject(flt_repo, head_sha)
    authored_date = _commit_authored_iso(flt_repo, head_sha)
    author_email = _commit_author_email(flt_repo, head_sha)
    body = _commit_body(flt_repo, head_sha)
    flt_remote = _git_remote_url(flt_repo)

    diff = _diff(flt_repo, base_sha, head_sha)
    diff_bytes = diff.encode("utf-8")
    diff_size = len(diff_bytes)
    diff_sha256 = hashlib.sha256(diff_bytes).hexdigest()

    files = _numstat(flt_repo, base_sha, head_sha)

    pr_json = _make_pr_json(
        pr_number=pr_number,
        title=title,
        merge_commit_sha=head_sha,
        base_sha=base_sha,
        head_sha=head_sha,
        files=files,
        diff_size_bytes=diff_size,
        diff_sha256=diff_sha256,
        authored_date=authored_date,
        author_email=author_email,
        body=body,
        flt_remote=flt_remote,
    )
    expected_json = _make_expected_json(pr_number)
    notes_md = _make_notes_md(
        pr_number=pr_number,
        title=title,
        base_sha=base_sha,
        head_sha=head_sha,
        files=files,
        pr_description=body,
    )

    if dry_run:
        print(f"DRY-RUN PR-{pr_number}: would write {target}")
        print(f"  base_sha={base_sha}")
        print(f"  head_sha={head_sha}")
        print(f"  files={len(files)}, diff_size={diff_size}, sha256={diff_sha256[:12]}…")
        return target

    target.mkdir(parents=True, exist_ok=overwrite)
    (target / "pr.json").write_text(
        json.dumps(pr_json, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (target / "diff.patch").write_text(diff, encoding="utf-8", newline="")
    (target / "expected.json").write_text(
        json.dumps(expected_json, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (target / "notes.md").write_text(notes_md, encoding="utf-8")
    print(f"  PR-{pr_number}: wrote {target.name} ({len(files)} files, {diff_size} bytes, state=PENDING_HUMAN_GRADING)")
    return target


def main() -> int:
    ap = argparse.ArgumentParser(description="Capture a PR fixture for the gold corpus (T4-C-prep).")
    ap.add_argument("--flt-repo", type=Path, default=DEFAULT_FLT_REPO,
                    help=f"Path to local FLT clone (default: {DEFAULT_FLT_REPO})")
    ap.add_argument("--pr-number", help="PR number (single-PR mode)")
    ap.add_argument("--merge-commit-sha", help="Merge commit SHA (single-PR mode)")
    ap.add_argument("--from-manifest", type=Path,
                    help="Read selected entries from a corpus_candidates.json manifest")
    ap.add_argument("--dry-run", action="store_true", help="Print plan, write nothing")
    ap.add_argument("--overwrite", action="store_true",
                    help="Overwrite existing fixture dirs (default: refuse)")
    args = ap.parse_args()

    if not args.flt_repo.exists():
        print(f"ERROR: FLT repo not found at {args.flt_repo}", file=sys.stderr)
        return 2

    if args.from_manifest:
        if not args.from_manifest.exists():
            print(f"ERROR: manifest not found: {args.from_manifest}", file=sys.stderr)
            return 2
        manifest = json.loads(args.from_manifest.read_text(encoding="utf-8"))
        selected = [c for c in manifest.get("selected", []) if c.get("selected")]
        if not selected:
            print("ERROR: manifest has no selected entries", file=sys.stderr)
            return 2
        print(f"Capturing {len(selected)} PRs from manifest {args.from_manifest.name}")
        for entry in selected:
            try:
                capture(
                    flt_repo=args.flt_repo,
                    pr_number=str(entry["pr_number"]),
                    merge_commit_sha=str(entry["merge_commit_sha"]),
                    dry_run=args.dry_run,
                    overwrite=args.overwrite,
                )
            except FileExistsError as exc:
                print(f"  SKIP {entry['pr_number']}: {exc}", file=sys.stderr)
            except RuntimeError as exc:
                print(f"  FAIL {entry['pr_number']}: {exc}", file=sys.stderr)
        return 0

    if not (args.pr_number and args.merge_commit_sha):
        print("ERROR: pass --from-manifest, OR (--pr-number AND --merge-commit-sha)",
              file=sys.stderr)
        return 2

    if not re.fullmatch(r"\d+", args.pr_number):
        print(f"ERROR: pr-number must be digits, got {args.pr_number!r}", file=sys.stderr)
        return 2

    capture(
        flt_repo=args.flt_repo,
        pr_number=args.pr_number,
        merge_commit_sha=args.merge_commit_sha,
        dry_run=args.dry_run,
        overwrite=args.overwrite,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
