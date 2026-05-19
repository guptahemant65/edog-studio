"""F27 P7 — Server-side history store + run-to-run comparison behavioural test.

This module verifies that ``EdogQaRunStore`` survives a simulated FLT
process restart, evicts the oldest record at the 100-cap, quarantines
corrupt / future-version files, and produces correct comparison output
across the hash/id matching strategies. The heavy lifting is done by the
``history-store`` subcommand of the .NET E2E harness in
``tests/dotnet/EdogQaE2E.Tests``.

Gated on FLT bin availability — same convention as the rest of the
F27 E2E suite. CI integration lands in F27 P9.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIR = REPO_ROOT / "tests" / "dotnet" / "EdogQaE2E.Tests"
CSPROJ = PROJECT_DIR / "EdogQaE2E.Tests.csproj"
BUILT_DLL = PROJECT_DIR / "bin" / "Debug" / "net8.0" / "Microsoft.LiveTable.Service.UnitTests.dll"

DEFAULT_FLT_BIN = (
    Path.home()
    / "newrepo"
    / "workload-fabriclivetable"
    / "Service"
    / "Microsoft.LiveTable.Service.EntryPoint"
    / "bin"
    / "Debug"
    / "net8.0"
    / "win-x64"
)

HARNESS_JSON_BEGIN = "---HARNESS-JSON-BEGIN---"
HARNESS_JSON_END = "---HARNESS-JSON-END---"


def _find_flt_bin() -> Path | None:
    env_value = os.environ.get("EDOG_FLT_BIN")
    if env_value:
        candidate = Path(env_value)
        if (candidate / "Microsoft.LiveTable.Service.dll").exists():
            return candidate
    if (DEFAULT_FLT_BIN / "Microsoft.LiveTable.Service.dll").exists():
        return DEFAULT_FLT_BIN
    return None


def _extract_json_block(stdout: str) -> dict:
    if HARNESS_JSON_BEGIN not in stdout or HARNESS_JSON_END not in stdout:
        raise AssertionError(
            f"Harness output missing JSON markers.\n--- stdout (last 4K):\n{stdout[-4000:]}",
        )
    begin = stdout.index(HARNESS_JSON_BEGIN) + len(HARNESS_JSON_BEGIN)
    end = stdout.index(HARNESS_JSON_END, begin)
    raw = stdout[begin:end].strip()
    return json.loads(raw)


@pytest.fixture(scope="module")
def harness() -> dict:
    if not CSPROJ.exists():
        pytest.fail(f"E2E csproj missing: {CSPROJ}")

    dotnet = shutil.which("dotnet")
    if dotnet is None:
        pytest.skip("`dotnet` CLI is not on PATH — install the .NET 8 SDK.")

    flt_bin = _find_flt_bin()
    if flt_bin is None:
        pytest.skip(
            "FLT bin not found. Set EDOG_FLT_BIN, or clone+build the "
            f"workload-fabriclivetable repo to {DEFAULT_FLT_BIN}. "
            "CI integration for this gate lands in F27 P9.",
        )

    build = subprocess.run(
        [dotnet, "build", str(CSPROJ), f"-p:FltBin={flt_bin}", "--nologo", "--verbosity", "minimal"],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=PROJECT_DIR,
    )
    if build.returncode != 0:
        pytest.fail(
            f"Harness build failed.\n--- stdout:\n{build.stdout[-4000:]}\n--- stderr:\n{build.stderr[-2000:]}",
        )
    if not BUILT_DLL.exists():
        pytest.fail(f"Build succeeded but DLL not at {BUILT_DLL}")

    result = subprocess.run(
        [dotnet, str(BUILT_DLL), "history-store"],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=BUILT_DLL.parent,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"history-store exited {result.returncode}.\n"
            f"--- stdout:\n{result.stdout[-4000:]}\n--- stderr:\n{result.stderr[-2000:]}",
        )
    return _extract_json_block(result.stdout)


def test_round_trip_survives_process_restart(harness: dict) -> None:
    """Three runs added, file flushed, in-memory state cleared via
    reflection, then EnsureLoaded re-reads from disk. All three must come
    back — that is the entire reason F27 P7 exists."""
    case = harness["round_trip"]
    assert case["total"] == 3, case
    # Newest CompletedAt first → run-C (PR 200), run-B, run-A.
    assert case["ordered_ids"] == "run-C,run-B,run-A", case
    assert case["pr100_count"] == 2, case
    assert case["first_run_id_after_reload"] == "run-C", case


def test_eviction_caps_at_max_records(harness: dict) -> None:
    """Adding 105 runs must result in exactly 100 retained — the oldest
    5 (by CompletedAt) drop off. This prevents the file from growing
    without bound across long developer sessions."""
    case = harness["eviction_cap"]
    assert case["total"] == 100, case
    assert case["newest_id"] == "run-evict-104", case
    # First five evicted: 000, 001, 002, 003, 004 → oldest remaining is 005.
    assert case["oldest_id"] == "run-evict-005", case


def test_corrupt_json_is_quarantined(harness: dict) -> None:
    """A malformed JSON file must NOT crash the store. It is moved to
    qa-runs.corrupt-{ts}.json and the store starts empty — guaranteeing
    QA execution can always persist even after manual file edits."""
    case = harness["corruption_quarantine"]
    assert case["still_started_empty"] == 0, case
    assert case["quarantined_count"] >= 1, case
    assert case["original_exists"] is False, case


def test_orphan_tmp_file_is_cleaned_up(harness: dict) -> None:
    """An interrupted writer leaves a ``.tmp`` file behind. The next
    hydration must delete it so subsequent writes do not see stale data."""
    case = harness["orphan_tmp_cleanup"]
    assert case["orphan_remaining"] is False, case


def test_hash_match_wins_over_id(harness: dict) -> None:
    """When the same scenario hash appears under two different scenario
    ids, the matcher must treat them as the same scenario and emit a
    single status flip — not "removed + added". This is what catches
    real regressions across runs."""
    case = harness["hash_match_priority"]
    assert case["success"] is True, case
    assert case["added"] == 0, case
    assert case["removed"] == 0, case
    assert case["flips"] == 1, case
    assert case["flip_base"] == "Passed", case
    assert case["flip_target"] == "Failed", case
    # All hashes present → no degraded-confidence warning; PrIds match.
    assert case["warning_count"] == 0, case


def test_id_fallback_emits_warning(harness: dict) -> None:
    """Runs that lack scenario hashes still produce a comparison via
    ScenarioId fallback, but MUST surface a warning so the UI can render
    a degraded-confidence banner instead of presenting a content-aware
    diff that may secretly reflect edits."""
    case = harness["id_fallback_warning"]
    assert case["success"] is True, case
    assert case["flips"] == 1, case
    assert case["warning_count"] >= 1, case
    assert case["first_warning_mentions_hash"] is True, case


def test_unscoped_runs_emit_warning(harness: dict) -> None:
    """Two runs with prId=0 (ad-hoc, no PR) should compare but warn so
    users know the comparison is only meaningful if both runs targeted
    the same code state."""
    case = harness["unscoped_warning"]
    assert case["success"] is True, case
    assert case["warning_count"] >= 1, case
    assert case["mentions_unscoped"] is True, case


def test_future_schema_version_quarantines_file(harness: dict) -> None:
    """A file written by a newer edog-studio binary MUST NOT be silently
    overwritten — that would lose the user's history on a downgrade.
    Quarantine + start-empty is the safe behaviour."""
    case = harness["future_schema_quarantine"]
    assert case["quarantined_count"] >= 1, case
    assert case["started_empty"] == 0, case


def test_resolved_storage_path_respects_env_var(harness: dict) -> None:
    """The harness sets EDOG_QA_HISTORY_DIR before running. The store
    MUST resolve under that directory, not the user's real LocalAppData."""
    path = harness["resolved_path"]
    assert "edog-qa-history-harness-" in path, path
    assert path.endswith("qa-runs.json"), path
