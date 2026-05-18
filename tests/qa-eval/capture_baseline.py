#!/usr/bin/env python3
"""F27 P9 T1c-c — capture baseline.json from the gold corpus.

Drives the EdogQaE2E ``gold-corpus-baseline`` harness once per fixture
under ``tests/qa-eval/ground-truth/`` and aggregates per-PR metrics into
``tests/qa-eval/baseline.json``.

This script makes **real outbound HTTPS calls** to Azure OpenAI and
**spends real money**. It is intentionally NOT part of the default
pytest gauntlet (``test_qa_e2e.py`` only pins the resulting baseline
shape, not this script's runtime behaviour). The capture is performed
manually when an authorised operator wants to refresh the baseline:

    set AZURE_OPENAI_ENDPOINT=https://...cognitiveservices.azure.com
    set AZURE_OPENAI_API_KEY=...
    set EDOG_FLT_BIN=...\\Service\\...\\bin\\Debug\\net8.0\\win-x64
    python tests\\qa-eval\\capture_baseline.py

Honest framing for the captured numbers:
* This is the **V2 pipeline snapshot** (Architect→Editor→Validator→Projector)
  as of the current commit — the floor V2 must beat in future tuning.
* recall / precision are intentionally NOT computed here. Those require
  the ground-truth ``expected.json`` files to complete human grading
  (T2). Recording fake recall/precision before that would lie to the
  regression detector.
* A "legacy_chat_completions" baseline (the original spec request)
  requires invoking ``EdogQaCodeAnalyzer.AnalyzeAsync`` end-to-end —
  which needs the full FLT DI container + invariants + graph providers
  and is out of scope for T1c-c. The deferral is documented in
  ``SECURITY.md`` §6 and the baseline ``notes`` field below.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH_DIR = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
BASELINE_PATH = REPO_ROOT / "tests" / "qa-eval" / "baseline.json"
DEFAULT_HARNESS_DLL = (
    REPO_ROOT
    / "tests"
    / "dotnet"
    / "EdogQaE2E.Tests"
    / "bin"
    / "Debug"
    / "net8.0"
    / "Microsoft.LiveTable.Service.UnitTests.dll"
)

HARNESS_JSON_BEGIN = "---HARNESS-JSON-BEGIN---"
HARNESS_JSON_END = "---HARNESS-JSON-END---"


def _find_fixtures() -> list[Path]:
    if not GROUND_TRUTH_DIR.exists():
        return []
    fixtures = sorted(
        p for p in GROUND_TRUTH_DIR.iterdir()
        if p.is_dir() and (p / "pr.json").is_file() and (p / "diff.patch").is_file()
    )
    return fixtures


def _parse_harness_output(stdout: str) -> dict | None:
    begin = stdout.find(HARNESS_JSON_BEGIN)
    end = stdout.find(HARNESS_JSON_END)
    if begin < 0 or end < 0 or end <= begin:
        return None
    body = stdout[begin + len(HARNESS_JSON_BEGIN):end].strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def _run_harness_for_fixture(harness_dll: Path, fixture_dir: Path, timeout_s: int) -> dict:
    cmd = [
        "dotnet",
        str(harness_dll),
        "gold-corpus-baseline",
        "--fixture",
        str(fixture_dir),
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    parsed = _parse_harness_output(proc.stdout or "")
    if parsed is None:
        return {
            "ok": False,
            "harness": "gold-corpus-baseline",
            "status": "HARNESS_OUTPUT_UNPARSEABLE",
            "exit_code": proc.returncode,
            "stderr_tail": (proc.stderr or "")[-2000:],
        }
    parsed.setdefault("exit_code", proc.returncode)
    return parsed


def _project_pr_record(fixture_dir: Path, harness_result: dict) -> dict:
    pr_meta_path = fixture_dir / "pr.json"
    try:
        pr_meta = json.loads(pr_meta_path.read_text(encoding="utf-8"))
    except Exception:
        pr_meta = {}

    summary = harness_result.get("summary") or {}
    architect = harness_result.get("architect") or {}
    editor = harness_result.get("editor") or {}
    validator = harness_result.get("validator") or {}
    projector = harness_result.get("projector") or {}

    return {
        "pr_number": str(pr_meta.get("pr_number") or harness_result.get("pr_number") or fixture_dir.name),
        "status": harness_result.get("status", "UNKNOWN"),
        "diff_bytes": harness_result.get("diff_bytes"),
        "architect_elapsed_ms": architect.get("elapsed_ms"),
        "architect_input_tokens": architect.get("input_tokens"),
        "architect_output_tokens": architect.get("output_tokens"),
        "architect_reasoning_tokens": architect.get("reasoning_tokens"),
        "architect_plan_outcome": architect.get("plan_outcome"),
        "architect_evidence_count": architect.get("evidence_count"),
        "architect_sketches": architect.get("scenario_sketches"),
        "editor_elapsed_ms": editor.get("elapsed_ms"),
        "editor_input_tokens": editor.get("input_tokens"),
        "editor_output_tokens": editor.get("output_tokens"),
        "scenarios_emitted": editor.get("scenarios_emitted"),
        "scenarios_after_validation": validator.get("accepted"),
        "scenarios_quarantined": validator.get("quarantined"),
        "scenarios_after_projection": projector.get("projected"),
        "scenarios_rejected_in_projection": projector.get("rejected"),
        "grounding_violations": summary.get("grounding_violations"),
        "schema_violations": summary.get("schema_violations"),
        "recall": None,
        "precision": None,
        "errors": (architect.get("errors") or []) + (editor.get("errors") or []),
    }


def _read_git_head_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        return (out.stdout or "").strip() or None
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="F27 P9 T1c-c gold-corpus baseline capture")
    parser.add_argument(
        "--harness-dll",
        type=Path,
        default=DEFAULT_HARNESS_DLL,
        help="Path to the EdogQaE2E test harness DLL (default: ./bin/Debug build output)",
    )
    parser.add_argument(
        "--timeout-s",
        type=int,
        default=900,
        help="Per-fixture timeout in seconds (default 900 = 15 min — Architect can spend 200s+ on the largest PR)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip live LLM calls; emit a baseline.json with status=DRY_RUN and null metrics.",
    )
    args = parser.parse_args(argv)

    fixtures = _find_fixtures()
    if not fixtures:
        print(f"no fixtures found under {GROUND_TRUTH_DIR}", file=sys.stderr)
        return 2

    captured_at = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pipeline_commit = _read_git_head_sha()

    pr_records: list[dict] = []

    if args.dry_run:
        for fx in fixtures:
            pr_meta = {}
            with contextlib.suppress(Exception):
                pr_meta = json.loads((fx / "pr.json").read_text(encoding="utf-8"))
            pr_records.append({
                "pr_number": str(pr_meta.get("pr_number") or fx.name),
                "status": "DRY_RUN",
                "diff_bytes": None,
                "architect_elapsed_ms": None,
                "architect_input_tokens": None,
                "architect_output_tokens": None,
                "architect_reasoning_tokens": None,
                "architect_plan_outcome": None,
                "architect_evidence_count": None,
                "architect_sketches": None,
                "editor_elapsed_ms": None,
                "editor_input_tokens": None,
                "editor_output_tokens": None,
                "scenarios_emitted": None,
                "scenarios_after_validation": None,
                "scenarios_quarantined": None,
                "scenarios_after_projection": None,
                "scenarios_rejected_in_projection": None,
                "grounding_violations": None,
                "schema_violations": None,
                "recall": None,
                "precision": None,
                "errors": [],
            })
    else:
        if not args.harness_dll.exists():
            print(f"harness DLL not found: {args.harness_dll}\n"
                  "Build first: `cd tests/dotnet/EdogQaE2E.Tests && dotnet build -p:FltBin=$EDOG_FLT_BIN`",
                  file=sys.stderr)
            return 2

        for fx in fixtures:
            print(f"[capture] running harness against {fx.name}…", file=sys.stderr)
            harness_result = _run_harness_for_fixture(args.harness_dll, fx, args.timeout_s)
            pr_records.append(_project_pr_record(fx, harness_result))

    overall_status = "DRY_RUN" if args.dry_run else (
        "CAPTURED" if all(r.get("status") == "OK" for r in pr_records) else "CAPTURED_WITH_ERRORS"
    )

    baseline = {
        "schema_version": "1.1",
        "captured_at": captured_at,
        "pipeline": "v2_architect_editor",
        "pipeline_commit": pipeline_commit,
        "pipeline_components": {
            "architect": "EdogQaLlmClient.ArchitectOnceAsync (gpt-5.4, high reasoning, strict json_schema)",
            "editor": "EdogQaLlmClient.EditorOnceAsync (gpt-5.4-mini, low reasoning, strict json_schema)",
            "validator": "EdogQaScenarioValidator.Validate (T1c-a-1)",
            "projector": "EdogQaScenarioProjector.Project (T1c-a-2)",
        },
        "status": overall_status,
        "notes": (
            "Per-fixture V2-pipeline snapshot captured against the 3 PR gold corpus. "
            "Floor V2 must beat in future tuning. recall/precision deferred until "
            "expected.json files complete human grading (T2). A 'legacy_chat_completions' "
            "baseline (the original spec phrasing) requires invoking EdogQaCodeAnalyzer.AnalyzeAsync "
            "end-to-end with the full FLT DI / graph / invariants stack — that scaffold is "
            "out of T1c-c scope and is documented as a deferred slice in SECURITY.md §6."
        ),
        "prs": pr_records,
    }

    BASELINE_PATH.write_text(
        json.dumps(baseline, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"[capture] wrote {BASELINE_PATH} (status={overall_status})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
