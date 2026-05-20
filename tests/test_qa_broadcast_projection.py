"""F27 — Contract test for the QA scenario broadcast projection.

Pins the wire shape between ``EdogPlaygroundHub.QaScenarioGenerated``
(server → curator) and ``EdogPlaygroundHub.ConvertSubmittedToEngineScenario``
(curator → server) so that the lossy hand-projection that previously
stripped every non-HttpRequest stimulus variant + every expectation
sub-object cannot regress.

The harness drives, for each of the six ``StimulusType`` discriminator
values, the full round-trip and asserts canonical-JSON equality on the
typed ``Stimulus`` and ``Expectations`` before and after the wire hop.

Gated on local FLT availability — same convention as ``test_qa_e2e.py``.
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

EXPECTED_CASES = {
    "http_request",
    "signalr_broadcast",
    "dag_trigger",
    "file_event",
    "timer_tick",
    "di_invocation",
}


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
            f"workload-fabriclivetable repo to {DEFAULT_FLT_BIN}.",
        )

    return {"dotnet": dotnet, "flt_bin": flt_bin}


@pytest.fixture(scope="module")
def built_harness(harness_environment) -> Path:
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


def _diff(case: dict) -> str:
    """Render a small diff for assertion messages so failures are actionable."""
    return (
        f"\n  case={case.get('name')!r}"
        f"\n  conversionError={case.get('conversionError')!r}"
        f"\n  stimulusEquals={case.get('stimulusEquals')}"
        f"\n  expectationsEquals={case.get('expectationsEquals')}"
        f"\n  original Stimulus      = {case.get('originalStimulus')}"
        f"\n  round-tripped Stimulus = {case.get('roundTrippedStimulus')}"
        f"\n  original Expectations      = {case.get('originalExpectations')}"
        f"\n  round-tripped Expectations = {case.get('roundTrippedExpectations')}"
    )


def test_broadcast_projection_round_trip_preserves_all_stimulus_variants(
    harness_environment, built_harness,
) -> None:
    """Every StimulusType variant (HttpRequest / SignalRBroadcast /
    DagTrigger / FileEvent / TimerTick / DiInvocation) must survive
    the QaScenarioGenerated → QaSubmitCuratedScenarios → engine round
    trip with canonical-JSON equality on the typed Stimulus.

    Regression guard for the bug where the hand-rolled anonymous
    projection at EdogPlaygroundHub.cs:1425 dropped five of the six
    union variants entirely, silently breaking end-to-end execution
    for every non-HttpRequest scenario.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "broadcast-projection")
    assert data["ok"] is True, data

    cases = {c["name"]: c for c in data["cases"]}
    assert set(cases.keys()) == EXPECTED_CASES, (
        f"Harness emitted unexpected case set: {set(cases.keys())}. "
        f"Expected: {EXPECTED_CASES}."
    )

    failures = []
    for name in sorted(EXPECTED_CASES):
        case = cases[name]
        if case.get("conversionError"):
            failures.append(
                f"[{name}] conversion threw: {case['conversionError']}" + _diff(case),
            )
            continue
        if not case["stimulusEquals"]:
            failures.append(
                f"[{name}] typed Stimulus did NOT survive the wire round-trip" + _diff(case),
            )
        if not case["expectationsEquals"]:
            failures.append(
                f"[{name}] typed Expectations did NOT survive the wire round-trip" + _diff(case),
            )

    if failures:
        raise AssertionError("Broadcast projection contract violations:\n\n" + "\n\n".join(failures))


def test_broadcast_projection_includes_all_union_variants_in_wire_payload(
    harness_environment, built_harness,
) -> None:
    """The projected wire envelope MUST mention every union variant
    discriminator key — even when the active variant is set, the
    other five must be present as null. This guards against a future
    "optimization" that drops nulls and accidentally narrows the
    contract back to the legacy single-variant projection.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "broadcast-projection")
    union_keys = {
        "httpRequest",
        "signalRBroadcast",
        "dagTrigger",
        "fileEvent",
        "timerTick",
        "diInvocation",
    }
    for case in data["cases"]:
        wire = case["projectedStimulusJson"]
        missing = [k for k in union_keys if f'"{k}"' not in wire]
        assert not missing, (
            f"[{case['name']}] projected wire payload is missing union variant key(s) "
            f"{missing}. Full wire: {wire}"
        )
