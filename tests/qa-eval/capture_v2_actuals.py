#!/usr/bin/env python3
"""F27 P9 T1f-b — capture V2 pipeline actuals for the gold-corpus PRs.

Drives the EdogQaE2E ``gold-corpus-baseline`` harness once per fixture
under ``tests/qa-eval/ground-truth/`` with ``--write-actual``, producing
the per-PR ``actual.json`` files that ``score_eval.py`` consumes to
compute recall / precision against the hand-graded ``expected.json``.

This script makes **real outbound HTTPS calls** to Azure OpenAI and
**spends real money**. It is NOT part of the pytest gauntlet — it is a
manual operator turn invoked on demand to refresh the corpus scores.

Required env (read once at start; harness emits CONFIG_MISSING if absent):

    set AZURE_OPENAI_ENDPOINT=https://...cognitiveservices.azure.com
    set AZURE_OPENAI_API_KEY=...
    set EDOG_FLT_BIN=...\\Service\\Microsoft.LiveTable.Service.EntryPoint\\bin\\Debug\\net8.0\\win-x64

Usage::

    # Default — capture all 3 fixtures.
    python tests/qa-eval/capture_v2_actuals.py

    # Single fixture.
    python tests/qa-eval/capture_v2_actuals.py --fixture PR-977882

    # Dry-run: print intended invocations without spending money.
    python tests/qa-eval/capture_v2_actuals.py --dry-run

After capture, run::

    python tests/qa-eval/score_eval.py --output tests/qa-eval/score_report.json
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH_DIR = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
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


def _find_fixtures(only: list[str] | None = None) -> list[Path]:
    if not GROUND_TRUTH_DIR.exists():
        return []
    out = sorted(
        p for p in GROUND_TRUTH_DIR.iterdir()
        if p.is_dir() and (p / "pr.json").is_file() and (p / "diff.patch").is_file()
    )
    if only:
        out = [p for p in out if p.name in only]
    return out


def _parse_envelope(stdout: str) -> dict | None:
    begin = stdout.find(HARNESS_JSON_BEGIN)
    end = stdout.find(HARNESS_JSON_END)
    if begin < 0 or end < 0 or end <= begin:
        return None
    body = stdout[begin + len(HARNESS_JSON_BEGIN):end].strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def _invoke_harness(harness_dll: Path, fixture_dir: Path, actual_path: Path, timeout_s: int) -> dict:
    cmd = [
        "dotnet",
        str(harness_dll),
        "gold-corpus-baseline",
        "--fixture",
        str(fixture_dir),
        "--write-actual",
        str(actual_path),
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    envelope = _parse_envelope(proc.stdout or "")
    if envelope is None:
        return {
            "ok": False,
            "status": "HARNESS_OUTPUT_UNPARSEABLE",
            "exit_code": proc.returncode,
            "stderr_tail": (proc.stderr or "")[-2000:],
            "stdout_tail": (proc.stdout or "")[-2000:],
        }
    envelope.setdefault("exit_code", proc.returncode)
    return envelope


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="F27 P9 T1f-b actuals capture")
    parser.add_argument(
        "--harness-dll",
        type=Path,
        default=DEFAULT_HARNESS_DLL,
        help="Path to the EdogQaE2E test harness DLL.",
    )
    parser.add_argument(
        "--fixture",
        action="append",
        dest="fixtures",
        help="Limit capture to one or more fixture names (e.g., PR-977882). Repeatable.",
    )
    parser.add_argument(
        "--timeout-s",
        type=int,
        default=900,
        help="Per-fixture timeout in seconds (default 900 = 15 min).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print intended invocations without spending money.",
    )
    args = parser.parse_args(argv)

    fixtures = _find_fixtures(args.fixtures)
    if not fixtures:
        print(f"[capture_v2_actuals] no matching fixtures under {GROUND_TRUTH_DIR}", file=sys.stderr)
        return 2

    if args.dry_run:
        for fx in fixtures:
            actual_path = fx / "actual.json"
            print(f"[capture_v2_actuals] (dry-run) would run harness against {fx.name} -> {actual_path}")
        return 0

    if not args.harness_dll.exists():
        print(
            f"[capture_v2_actuals] harness DLL not found: {args.harness_dll}\n"
            "Build first: dotnet build tests/_csbuild/EdogDevModeBuild.csproj -p:FltBin=$EDOG_FLT_BIN",
            file=sys.stderr,
        )
        return 2

    if not (os.environ.get("AZURE_OPENAI_API_KEY") or os.environ.get("AZURE_OPENAI_ARCHITECT_API_KEY")):
        print(
            "[capture_v2_actuals] AZURE_OPENAI_API_KEY (or AZURE_OPENAI_ARCHITECT_API_KEY) not set",
            file=sys.stderr,
        )
        return 2

    overall_status = "CAPTURED"
    for fx in fixtures:
        actual_path = fx / "actual.json"
        t0 = _dt.datetime.now(_dt.timezone.utc)
        print(f"[capture_v2_actuals] {t0.strftime('%H:%M:%SZ')} running harness against {fx.name}…", file=sys.stderr)
        result = _invoke_harness(args.harness_dll, fx, actual_path, args.timeout_s)
        status = result.get("status", "UNKNOWN")
        elapsed = (_dt.datetime.now(_dt.timezone.utc) - t0).total_seconds()
        print(f"[capture_v2_actuals]   {fx.name} status={status} elapsed={elapsed:.1f}s", file=sys.stderr)
        if status != "OK":
            overall_status = "CAPTURED_WITH_ERRORS"
            print(
                f"[capture_v2_actuals]   harness envelope: {json.dumps(result, indent=2)[:1500]}",
                file=sys.stderr,
            )
        elif not actual_path.exists():
            overall_status = "CAPTURED_WITH_ERRORS"
            print(
                f"[capture_v2_actuals]   WARNING: harness OK but {actual_path} missing",
                file=sys.stderr,
            )

    print(f"[capture_v2_actuals] overall_status={overall_status}", file=sys.stderr)
    return 0 if overall_status == "CAPTURED" else 1


if __name__ == "__main__":
    sys.exit(main())
