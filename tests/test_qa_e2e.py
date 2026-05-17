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


# ─── F27 P4 — Kill Silent Fallbacks ───────────────────────────────────────


def test_llm_provider_classifier_matrix(harness_environment, built_harness) -> None:
    """LlmProviderExceptionClassifier must map each transport / parse
    failure to the correct typed kind + wire-stable error code. The
    classification matrix here is the SignalR contract — the studio UI
    keys off these errorCode strings to render actionable inline panels."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "classify-llm")
    assert data["ok"] is True, data
    cases = {c["caseId"]: c for c in data["cases"]}

    # Auth (401/403) → non-retryable.
    for case_id in ("auth_401", "auth_403"):
        c = cases[case_id]
        assert c["kindCode"] == "auth", c
        assert c["errorCode"] == "LLM_PROVIDER_AUTH", c
        assert c["retryable"] is False, c

    # Rate limit (429) → retryable.
    c = cases["rate_limit_429"]
    assert c["kindCode"] == "rate_limit"
    assert c["errorCode"] == "LLM_PROVIDER_RATE_LIMIT"
    assert c["retryable"] is True

    # 5xx → retryable network failure.
    for case_id in ("network_500", "network_503"):
        c = cases[case_id]
        assert c["kindCode"] == "network", c
        assert c["errorCode"] == "LLM_PROVIDER_NETWORK", c
        assert c["retryable"] is True, c

    # Non-429 4xx → non-retryable network/protocol failure.
    c = cases["client_400"]
    assert c["kindCode"] == "network"
    assert c["retryable"] is False

    # Transport (no status code) → retryable.
    c = cases["transport_no_status"]
    assert c["kindCode"] == "network"
    assert c["retryable"] is True
    assert c["hasStatusCode"] is False

    # Timeout (TaskCanceled w/ token not cancelled) → retryable.
    c = cases["timeout_taskcancel"]
    assert c["kindCode"] == "timeout"
    assert c["errorCode"] == "LLM_PROVIDER_TIMEOUT"
    assert c["retryable"] is True

    # Parse (JsonException) → non-retryable.
    c = cases["parse_jsonexception"]
    assert c["kindCode"] == "parse"
    assert c["errorCode"] == "LLM_PROVIDER_PARSE"
    assert c["retryable"] is False

    # Unknown fallback.
    c = cases["unknown_invalidop"]
    assert c["kindCode"] == "unknown"
    assert c["errorCode"] == "LLM_PROVIDER_UNKNOWN"


def test_fallback_policy_env_gate(harness_environment, built_harness) -> None:
    """QaAnalysisFallbackPolicy must enable demo mode if and only if the
    env var equals "1" exactly. Loose truthiness ("true", "yes", "1 ")
    must NOT enable demo mode — preventing accidental re-enable of the
    silent synthetic fallback through environment drift."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "fallback-policy")
    assert data["ok"] is True, data
    assert data["envVarName"] == "EDOG_QA_DEMO_FALLBACK", data
    assert data["expectedGeneratedBy"] == "demo_synthetic", data
    assert data["expectedTitlePrefix"] == "[DEMO] ", data

    env = {c["label"]: c["enabled"] for c in data["envCases"]}
    assert env["unset"] is False
    assert env["empty"] is False
    assert env["zero"] is False
    assert env["one"] is True, "EDOG_QA_DEMO_FALLBACK=1 must enable demo mode"
    assert env["true_string"] is False, "'true' must NOT enable demo mode (strict match)"
    assert env["yes_string"] is False
    assert env["uppercase_one"] is False, "'1 ' (trailing space) must NOT enable"


def test_fallback_policy_tag_as_demo(harness_environment, built_harness) -> None:
    """TagAsDemo() must prefix every title with '[DEMO] ' and rewrite
    metadata.generatedBy to 'demo_synthetic' so the curation UI badges
    show through. Must be idempotent (no double-prefix) and null-safe."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "fallback-policy")
    tagged = data["tagged"]
    assert tagged["titles"] == ["[DEMO] Happy path", "[DEMO] Error path"], tagged
    assert tagged["generatedBy"] == ["demo_synthetic", "demo_synthetic"], tagged
    assert tagged["doublePrefixed"] is False, "TagAsDemo must be idempotent"

    mixed = data["mixedTagged"]
    assert mixed["skippedNullEntry"] is True
    assert mixed["titles"][1] == "[DEMO] Edge case"


# ─── F27 P4 — Static contract guards (no harness needed) ──────────────────


def test_llm_provider_rethrows_typed_exception() -> None:
    """EdogQaLlmProvider.GenerateScenariosAsync must surface failures as
    typed LlmProviderException (P4) instead of swallowing into an empty
    list (pre-P4). Verified by source-grep so the test runs without FLT
    bin being available."""
    src = (REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmProvider.cs").read_text(
        encoding="utf-8"
    )
    assert "throw new LlmProviderException(" in src or "throw LlmProviderExceptionClassifier" in src, (
        "EdogQaLlmProvider must throw typed LlmProviderException — the silent "
        "fallback to an empty scenario list was the P4 target."
    )
    # The pre-P4 silent return must be gone.
    assert "return new List<Scenario>();" not in src.split("GenerateScenariosAsync")[1].split("private")[0], (
        "GenerateScenariosAsync still returns empty list on exception — P4 must rethrow."
    )


def test_hub_gates_synthetic_fallback_behind_env_var() -> None:
    """RunAnalysisPipelineAsync must consult QaAnalysisFallbackPolicy
    before emitting synthetic scenarios, and emit a NO_SCENARIOS_GENERATED
    QaError when the env var is off."""
    src = (REPO_ROOT / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs").read_text(
        encoding="utf-8"
    )
    assert "QaAnalysisFallbackPolicy.IsDemoFallbackEnabled()" in src, (
        "Hub must call IsDemoFallbackEnabled() to gate synthetic generation."
    )
    assert "NO_SCENARIOS_GENERATED" in src, (
        "Hub must emit NO_SCENARIOS_GENERATED QaError when demo fallback is disabled."
    )
    assert "QaAnalysisFallbackPolicy.TagAsDemo(scenarios)" in src, (
        "Synthetic scenarios produced in demo mode must be tagged via TagAsDemo."
    )


# ─── F27 P9 T0 — Production-grade LLM pipeline scaffold ───────────────────


def test_qa_feature_flags_llm_v2_kill_switch_exists() -> None:
    """F27 P9 §8 — the LLM V2 rollout MUST be gated behind a kill switch
    env var so the new pipeline can be flipped off in production without
    a redeploy. Verified by source-grep so the test runs without FLT bin."""
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaFeatureFlags.cs"
    ).read_text(encoding="utf-8")
    assert 'EnvVarLlmV2 = "EDOG_QA_LLM_V2"' in src, (
        "EdogQaFeatureFlags must declare EnvVarLlmV2 = \"EDOG_QA_LLM_V2\" — the "
        "kill switch from F27 P9 §8."
    )
    # The three-state rollout (off | shadow | on) is non-negotiable: a
    # boolean flag would skip the mandatory shadow phase and is forbidden
    # by §8.
    assert "enum LlmV2Mode" in src, "LlmV2Mode enum must exist."
    for required in ("Off", "Shadow", "On"):
        assert required in src, f"LlmV2Mode must declare {required}."


def test_qa_capability_probe_declares_required_error_codes() -> None:
    """F27 P9 §3.6 — the capability probe defines four stable error codes
    that the orchestrator + hub key off when refusing to flip LlmV2 to
    shadow/on. The codes are part of our wire contract and must not drift."""
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaCapabilityProbe.cs"
    ).read_text(encoding="utf-8")
    required_codes = (
        "AOAI_DEPLOYMENT_NOT_FOUND",
        "AOAI_RESPONSES_API_UNAVAILABLE",
        "AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED",
        "AOAI_REASONING_UNSUPPORTED",
    )
    for code in required_codes:
        assert code in src, f"EdogQaCapabilityProbe must declare {code}."
    # IsAzureOpenAiReadyForV2 is the single gating boolean — it MUST exist
    # so the orchestrator has one obvious branch point.
    assert "IsAzureOpenAiReadyForV2" in src, (
        "EdogQaCapabilityProbe must expose IsAzureOpenAiReadyForV2 — the "
        "single gate the orchestrator consults before honouring EDOG_QA_LLM_V2."
    )


def test_qa_llm_provider_default_deployment_is_gpt54() -> None:
    """The hardcoded default deployment must match the GA Azure OpenAI
    deployment name (gpt-5.4), not the pre-GA placeholder (gpt-5.4-pro).
    Hosts without AZURE_OPENAI_PRO_DEPLOYMENT/AZURE_OPENAI_DEPLOYMENT set
    were resolving to a non-existent deployment, causing 404 / empty
    content. The capability probe (F27 P9 §3.6) is the proper guard but
    the default must still be a real model name."""
    cs_src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmProvider.cs"
    ).read_text(encoding="utf-8")
    assert '"gpt-5.4-pro"' not in cs_src, (
        "EdogQaLlmProvider must not default to 'gpt-5.4-pro' (a pre-GA placeholder "
        "that does not exist as an Azure deployment name). Use 'gpt-5.4'."
    )
    assert '?? "gpt-5.4"' in cs_src, (
        "EdogQaLlmProvider default deployment must be 'gpt-5.4'."
    )

    py_src = (REPO_ROOT / "scripts" / "dev-server.py").read_text(encoding="utf-8")
    assert '"gpt-5.4-pro"' not in py_src, (
        "dev-server.py must not default to 'gpt-5.4-pro' — same reason as above."
    )
    assert 'or "gpt-5.4"' in py_src, (
        "dev-server.py default deployment must be 'gpt-5.4'."
    )

