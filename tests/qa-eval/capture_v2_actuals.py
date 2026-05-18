"""F27 P9 T1f-b — capture V2 pipeline actuals for the gold-corpus PRs.

This is the operator script that lights up the recall/precision numbers
in ``baseline.json``. It does NOT run in pytest because each invocation
hits real Azure OpenAI deployments (Architect ``gpt-5.4`` high-reasoning
+ Editor ``gpt-5.4-mini`` low-reasoning) for every fixture in
``tests/qa-eval/ground-truth/``. Per-fixture cost ~$0.30; full 3-PR pass
~$1.00.

The script drives the same EdogQaE2E harness subcommand
(``gold-corpus-baseline``) that was used to capture the v2 pipeline
aggregates in T1c-c, but here we ask the harness to also emit per-PR
``actual.json`` files with the full scenario payloads the deterministic
scorer needs:

    {
      "captured_at": "2026-05-18T00:00:00Z",
      "pipeline": "v2_architect_editor",
      "scenarios": [
        {
          "id": "<projector-assigned id>",
          "topic": "<canonical interceptor topic>",
          "category": "<ScenarioCategory enum value>",
          "verb": "<primary ExpectationType enum value>",
          "stage": "emitted|validated|projected",
          "grounding_changed_lines": [
            {"path": "...", "side": "right", "lines": [n, n+1, ...]}
          ]
        },
        ...
      ]
    }

T1f-b OPERATOR FLOW (run this script, not pytest):

    1. set EDOG_QA_LLM_V2=on
    2. set DONNA_AOAI_ENDPOINT=https://donna.cognitiveservices.azure.com
    3. set DONNA_AOAI_API_KEY=<key>
    4. set EDOG_FLT_BIN=C:\\Users\\<you>\\newrepo\\workload-fabriclivetable\\Service\\Microsoft.LiveTable.Service.EntryPoint\\bin\\Debug\\net8.0\\win-x64
    5. python tests\\qa-eval\\capture_v2_actuals.py --fixture PR-977882
    6. python tests\\qa-eval\\score_eval.py --json --output tests/qa-eval/score_report.json

The harness subcommand ``gold-corpus-baseline`` is wired in T1c-c
(``tests/dotnet/EdogQaE2E.Tests/Program.cs``) and shells the V2
pipeline; extending it to emit ``actual.json`` is part of the T1f-b
slice. THIS script is the operator entry point that wraps the harness.

This file is intentionally executable but the embedded fixture-runner
is a stub until T1f-b lands the actual.json emitter. Running it today
prints the planned invocation rather than spending money.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
HARNESS_PROJECT = REPO_ROOT / "tests" / "dotnet" / "EdogQaE2E.Tests"


def _flt_bin() -> Path | None:
    raw = os.environ.get("EDOG_FLT_BIN")
    if raw:
        return Path(raw)
    fallback = REPO_ROOT.parent / "workload-fabriclivetable" / "Service" / "Microsoft.LiveTable.Service.EntryPoint" / "bin" / "Debug" / "net8.0" / "win-x64"
    return fallback if fallback.exists() else None


def _fixtures() -> list[Path]:
    return sorted(p for p in GROUND_TRUTH.iterdir() if p.is_dir() and p.name.startswith("PR-"))


def _build_harness() -> int:
    """Build the EdogQaE2E test harness (no-op if cached)."""
    proc = subprocess.run(
        ["dotnet", "build", str(HARNESS_PROJECT / "EdogQaE2E.Tests.csproj"), "-c", "Debug", "-v", "quiet", "--nologo"],
        cwd=REPO_ROOT,
        check=False,
    )
    return proc.returncode


def _invoke_harness(fixture: Path, timeout_s: int = 900) -> dict:
    """Invoke the gold-corpus-baseline subcommand for one fixture.

    T1f-b will extend the harness to write actual.json alongside
    expected.json. Until then this prints the planned command.
    """
    cmd = [
        "dotnet",
        "run",
        "--project",
        str(HARNESS_PROJECT / "EdogQaE2E.Tests.csproj"),
        "--no-build",
        "-c",
        "Debug",
        "--",
        "gold-corpus-baseline",
        "--fixture",
        fixture.name,
        "--write-actual",
    ]
    print(f"[capture_v2_actuals] would invoke: {' '.join(cmd)}", flush=True)
    return {
        "captured_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        "pipeline": "v2_architect_editor",
        "fixture": fixture.name,
        "scenarios": [],
        "_t1f_a_stub": True,
        "_t1f_b_will_populate": "actual.json with full scenario payloads",
    }


def run(fixture_names: list[str] | None = None, *, dry_run: bool = True) -> int:
    flt_bin = _flt_bin()
    if not dry_run and flt_bin is None:
        print(
            "[capture_v2_actuals] EDOG_FLT_BIN not set and default path missing — set it or pass --dry-run",
            file=sys.stderr,
        )
        return 2

    if not os.environ.get("DONNA_AOAI_API_KEY") and not dry_run:
        print(
            "[capture_v2_actuals] DONNA_AOAI_API_KEY not set — V2 pipeline cannot run; set it or pass --dry-run",
            file=sys.stderr,
        )
        return 2

    targets = _fixtures()
    if fixture_names:
        targets = [f for f in targets if f.name in fixture_names]
    if not targets:
        print("[capture_v2_actuals] no matching fixtures found")
        return 1

    if not dry_run:
        rc = _build_harness()
        if rc != 0:
            print(f"[capture_v2_actuals] harness build failed rc={rc}", file=sys.stderr)
            return rc

    for fixture in targets:
        result = _invoke_harness(fixture)
        out = fixture / "actual.json"
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"[capture_v2_actuals] wrote {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--fixture",
        action="append",
        dest="fixtures",
        help="Limit capture to one or more fixture names (e.g., PR-977882). Repeatable.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Print intended invocations without spending money (default; T1f-a behaviour).",
    )
    parser.add_argument(
        "--no-dry-run",
        dest="dry_run",
        action="store_false",
        help="Actually invoke the harness against Azure OpenAI (T1f-b operator turn).",
    )
    args = parser.parse_args(argv)
    return run(args.fixtures, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
