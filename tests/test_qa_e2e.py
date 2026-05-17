"""F27 P3 — End-to-End Integration Test for the QA pipeline.

This gate proves that the QA Code Analyzer, Scenario Linter, and Result
Aggregator **compose** — i.e. their contracts match at every seam — by
exercising them with deterministic fakes against the ``pr-baseline``
fixture (the 60-day strict-date Insights PR) and asserting on the
JSON they emit on stdout.

The actual harness is a tiny .NET console binary (built by the
``tests/dotnet/EdogQaE2E.Tests`` csproj) with three subcommands:

* ``analyze``    — full analyzer pipeline with fake L1/L2/L3/L4/L5 providers
* ``aggregate``  — aggregator over mixed-verdict canned ScenarioResults
* ``compose``    — analyzer → aggregator chained, asserts no scenario IDs drift

Each subcommand emits one JSON block delimited by
``---HARNESS-JSON-BEGIN---`` / ``---HARNESS-JSON-END---``. This wrapper
parses the block and asserts on its contents.

The test is gated on local FLT availability (same convention as
``test_devmode_csbuild.py``). CI integration lands in F27 P9.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

# ─── Paths ────────────────────────────────────────────────────────────────

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


# ─── Helpers ──────────────────────────────────────────────────────────────


def _find_flt_bin() -> Path | None:
    env_value = os.environ.get("EDOG_FLT_BIN")
    if env_value:
        candidate = Path(env_value)
        if (candidate / "Microsoft.LiveTable.Service.dll").exists():
            return candidate
    if (DEFAULT_FLT_BIN / "Microsoft.LiveTable.Service.dll").exists():
        return DEFAULT_FLT_BIN
    return None


def _find_dotnet() -> str | None:
    return shutil.which("dotnet")


def _extract_json_block(stdout: str) -> dict:
    """Pull the JSON payload between the begin/end markers."""
    if HARNESS_JSON_BEGIN not in stdout or HARNESS_JSON_END not in stdout:
        raise AssertionError(
            f"Harness output missing JSON markers.\n--- stdout (last 4K):\n{stdout[-4000:]}",
        )
    begin = stdout.index(HARNESS_JSON_BEGIN) + len(HARNESS_JSON_BEGIN)
    end = stdout.index(HARNESS_JSON_END, begin)
    raw = stdout[begin:end].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"Harness emitted invalid JSON: {exc}\n--- payload:\n{raw[:4000]}",
        ) from exc


# ─── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def harness_environment() -> dict:
    if not CSPROJ.exists():
        pytest.fail(f"E2E csproj missing: {CSPROJ}")

    dotnet = _find_dotnet()
    if dotnet is None:
        pytest.skip("`dotnet` CLI is not on PATH — install the .NET 8 SDK.")

    flt_bin = _find_flt_bin()
    if flt_bin is None:
        pytest.skip(
            "FLT bin not found. Set EDOG_FLT_BIN, or clone+build the "
            f"workload-fabriclivetable repo to {DEFAULT_FLT_BIN}. "
            "CI integration for this gate lands in F27 P9.",
        )

    return {"dotnet": dotnet, "flt_bin": flt_bin}


@pytest.fixture(scope="module")
def built_harness(harness_environment) -> Path:
    """Build the harness binary once per test module and return its path."""
    env = harness_environment
    cmd = [
        env["dotnet"],
        "build",
        str(CSPROJ),
        f"-p:FltBin={env['flt_bin']}",
        "--nologo",
        "--verbosity",
        "minimal",
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=PROJECT_DIR,
    )
    if result.returncode != 0:
        pytest.fail(
            "E2E harness build failed.\n"
            f"--- exit code: {result.returncode}\n"
            f"--- stdout (last 4K):\n{result.stdout[-4000:]}\n"
            f"--- stderr (last 2K):\n{result.stderr[-2000:]}",
        )

    if not BUILT_DLL.exists():
        pytest.fail(f"Build succeeded but DLL not at expected path: {BUILT_DLL}")

    return BUILT_DLL


def _run_harness(dotnet: str, dll: Path, subcommand: str) -> dict:
    """Invoke the harness with the given subcommand and parse its JSON block."""
    result = subprocess.run(
        [dotnet, str(dll), subcommand],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=dll.parent,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"Harness subcommand '{subcommand}' exited {result.returncode}.\n"
            f"--- stdout:\n{result.stdout[-4000:]}\n"
            f"--- stderr:\n{result.stderr[-2000:]}",
        )
    return _extract_json_block(result.stdout)


# ─── Tests ────────────────────────────────────────────────────────────────


def test_analyzer_pipeline_against_golden_fixture(harness_environment, built_harness) -> None:
    """The 5-layer analyzer pipeline with golden fakes must produce 3
    scenarios over 1 impact zone, with zero degradation flags and zero
    lint-error findings. This is the canonical "green path" run.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "analyze")
    assert data["ok"] is True, data
    assert data["impactZoneCount"] == 1, data
    assert data["scenarioCount"] == 3, data
    assert data["hasGraphNodes"] is True, data
    assert data["degradationFlags"] == [], data
    assert data["lintErrorCount"] == 0, data
    assert set(data["scenarioIds"]) == {
        "scn-insights-range-within-60d-pass",
        "scn-insights-range-exceed-60d-reject",
        "scn-insights-range-exactly-60d-pass",
    }, data["scenarioIds"]


def test_no_synthetic_fallback_in_golden_path(harness_environment, built_harness) -> None:
    """On the golden path with a working LLM contract, the analyzer must
    never tag scenarios as ``stub_llm`` or ``synthetic`` (those tags
    indicate a fallback path under F27 P0 telemetry).
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "analyze")
    forbidden = {"stub_llm", "synthetic"}
    seen = set(data["generatedByValues"])
    assert seen == {"ai"}, (
        f"generatedBy values must be exactly {{'ai'}} on the golden path; "
        f"got {seen}"
    )
    assert seen.isdisjoint(forbidden), (
        f"Forbidden fallback tags appeared: {seen & forbidden}"
    )
    flags = " ".join(data["degradationFlags"])
    assert "stub_llm_provider_active" not in flags, data["degradationFlags"]
    assert "stub_graph_provider_active" not in flags, data["degradationFlags"]


def test_aggregator_verdict_rollup(harness_environment, built_harness) -> None:
    """Aggregator must compute correct pass/fail/skip totals, identify the
    slowest scenario, and produce non-empty PR-comment + JUnit XML exports.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "aggregate")
    assert data["ok"] is True, data
    assert data["totalScenarios"] == 4, data
    assert data["summaryPassed"] == 2, data
    assert data["summaryFailed"] == 1, data
    assert data["summarySkipped"] == 1, data
    assert data["summaryTotal"] == 4, data
    # scn-b is the slowest at 1500ms in the fixture.
    assert data["slowestScenarioId"] == "scn-b", data
    assert data["slowestScenarioMs"] == 1500, data
    assert data["prCommentLength"] > 0, data
    assert data["prCommentContainsRunId"] is True, data
    assert data["junitContainsTestcase"] is True, data


def test_analyzer_to_aggregator_pipeline_wiring(harness_environment, built_harness) -> None:
    """The compose harness chains analyzer → aggregator and proves that
    *every* analyzer-produced scenario ID survives untouched into the
    aggregator's run result. This catches any property rename or wiring
    drift between the two stages.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "compose")
    assert data["ok"] is True, data
    assert data["analyzerScenarioCount"] > 0, "Analyzer produced zero scenarios"
    assert data["analyzerScenarioCount"] == data["aggregatorScenarioCount"], (
        "Scenario count drifted between analyzer and aggregator: "
        f"analyzer={data['analyzerScenarioCount']} "
        f"aggregator={data['aggregatorScenarioCount']}"
    )
    assert data["idsMatch"] is True, (
        "Scenario IDs differ between analyzer and aggregator.\n"
        f"  analyzer:   {data['analyzerIds']}\n"
        f"  aggregator: {data['aggregatorIds']}"
    )
    assert data["aggregatorVerdictAllPassed"] is True, data
    assert data["analyzerDegradationFlags"] == [], data


def test_harness_project_is_well_formed() -> None:
    """The csproj must declare the correct AssemblyName so FLT's
    InternalsVisibleTo grant unlocks the internal types we exercise.
    """
    content = CSPROJ.read_text(encoding="utf-8")
    assert "<TargetFramework>net8.0</TargetFramework>" in content
    assert "<OutputType>Exe</OutputType>" in content
    assert (
        "<AssemblyName>Microsoft.LiveTable.Service.UnitTests</AssemblyName>"
        in content
    ), "AssemblyName must match FLT's InternalsVisibleTo grant."
    assert "Microsoft.AspNetCore.App" in content
