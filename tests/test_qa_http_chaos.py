"""F27 P5 Stage 2 — HTTP chaos pipeline behavioural test.

This module verifies that ``EdogHttpPipelineHandler.SendAsync`` consults
``EdogHttpFaultStore`` and materialises each fault family correctly. The
heavy lifting is done by the ``pipeline-chaos`` subcommand of the .NET
E2E harness in ``tests/dotnet/EdogQaE2E.Tests`` — this Python module
parses the harness JSON and asserts on the documented behaviour:

* ``http_error`` fault → synthesised response with configured status
  code and body; the inner HttpMessageHandler is never called.
* ``latency`` fault → ``Task.Delay`` before the inner handler is
  called; the real response flows through.
* ``timeout`` fault → ``TaskCanceledException`` thrown without the
  inner handler being called.
* No fault rule → request flows through unmodified.
* ``RemoveRulesForScenario`` empties the store so subsequent matches
  miss.

Gated on FLT bin availability — same convention as the rest of P3.
CI integration lands in F27 P9.
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
        capture_output=True, text=True, timeout=300, cwd=PROJECT_DIR,
    )
    if build.returncode != 0:
        pytest.fail(
            "Harness build failed.\n"
            f"--- stdout:\n{build.stdout[-4000:]}\n--- stderr:\n{build.stderr[-2000:]}",
        )
    if not BUILT_DLL.exists():
        pytest.fail(f"Build succeeded but DLL not at {BUILT_DLL}")

    result = subprocess.run(
        [dotnet, str(BUILT_DLL), "pipeline-chaos"],
        capture_output=True, text=True, timeout=120, cwd=BUILT_DLL.parent,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"pipeline-chaos exited {result.returncode}.\n"
            f"--- stdout:\n{result.stdout[-4000:]}\n--- stderr:\n{result.stderr[-2000:]}",
        )
    return _extract_json_block(result.stdout)


def test_harness_smoke(harness: dict) -> None:
    """The harness ran to completion and emitted the expected shape."""
    assert harness["ok"] is True, harness
    assert harness["harness"] == "pipeline-chaos", harness


def test_no_fault_request_flows_through(harness: dict) -> None:
    """When no fault rule matches, the request reaches the inner handler
    and the real response is returned. This baseline proves the
    interception path doesn't accidentally short-circuit normal traffic."""
    case = harness["noFault"]
    assert case["statusCode"] == 200, case
    assert case["body"] == "real", case
    assert case["innerInvocations"] == 1, (
        "Inner handler must be called exactly once on the no-fault path"
    )


def test_http_error_synthesises_response_without_calling_base(harness: dict) -> None:
    """The ``http_error`` fault MUST synthesise the response from the
    rule's StatusCode + ResponseBody and never invoke the inner
    handler — that is the entire point of failure-path injection."""
    case = harness["httpError"]
    assert case["statusCode"] == 503, case
    assert "qa synthesized" in case["body"], case
    assert "chaos" in case["reason"].lower(), case
    assert case["innerInvocations"] == 0, (
        "Inner handler must NOT be called when http_error fault matches"
    )


def test_latency_delays_then_calls_base(harness: dict) -> None:
    """The ``latency`` fault MUST delay before the inner handler is
    called. The real response flows through unmodified."""
    case = harness["latency"]
    assert case["statusCode"] == 201, case
    assert case["body"] == "real-after-delay", case
    assert case["innerInvocations"] == 1, (
        "Inner handler must be called once after the latency delay"
    )
    # Configured for 120ms — allow some scheduler slack but require at
    # least the floor; otherwise the delay short-circuited.
    assert case["elapsedMs"] >= 100, (
        f"latency fault elapsed {case['elapsedMs']}ms — expected ≥ 100ms"
    )


def test_timeout_throws_without_calling_base(harness: dict) -> None:
    """The ``timeout`` fault MUST raise a ``TaskCanceledException``
    without ever invoking the inner handler. The studio UI keys off
    this exception type to render the timeout state on the http event."""
    case = harness["timeout"]
    assert case["exceptionType"] == "TaskCanceledException", case
    assert case["exceptionMessageContains"] is True, case
    assert case["innerInvocations"] == 0, (
        "Inner handler must NOT be called when timeout fault matches"
    )


def test_teardown_removes_rules(harness: dict) -> None:
    """``RemoveRulesForScenario`` must clear the store atomically so
    later requests on the same target do not match the stale rule."""
    case = harness["teardown"]
    assert case["beforeCount"] == 1, case
    assert case["matchedBefore"] is True, case
    assert case["afterCount"] == 0, case
    assert case["matchedAfter"] is False, case
