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
    """F27 P9 §3.6 — the capability probe defines stable error codes that
    the orchestrator + hub key off when refusing to flip LlmV2 to
    shadow/on. The codes are part of our wire contract and must not drift.

    T1a expands the matrix beyond the four AOAI capability codes to cover
    config and transport failures so the orchestrator can render a clear,
    actionable inline error instead of a generic "probe failed"."""
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaCapabilityProbe.cs"
    ).read_text(encoding="utf-8")
    required_codes = (
        "AOAI_DEPLOYMENT_NOT_FOUND",
        "AOAI_RESPONSES_API_UNAVAILABLE",
        "AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED",
        "AOAI_REASONING_UNSUPPORTED",
        # T1a additions — config + transport + parse failures.
        "PROBE_CONFIG_MISSING",
        "PROBE_NETWORK_ERROR",
        "PROBE_RESPONSE_UNPARSEABLE",
    )
    for code in required_codes:
        assert code in src, f"EdogQaCapabilityProbe must declare {code}."
    # IsAzureOpenAiReadyForV2 is the single gating boolean — it MUST exist
    # so the orchestrator has one obvious branch point.
    assert "IsAzureOpenAiReadyForV2" in src, (
        "EdogQaCapabilityProbe must expose IsAzureOpenAiReadyForV2 — the "
        "single gate the orchestrator consults before honouring EDOG_QA_LLM_V2."
    )
    # T1a: the T0 sentinel must be gone (replaced by real codes).
    assert "PROBE_STUB_T0" not in src, (
        "EdogQaCapabilityProbe must no longer carry the T0 stub sentinel — "
        "T1a replaced it with a real handshake. Drop ErrorCodeStubT0."
    )


def test_qa_capability_probe_real_handshake() -> None:
    """T1a — the probe must POST to /openai/responses with strict
    json_schema + reasoning.effort=low. Verified by source-grep so the
    test runs without FLT bin and is fast in CI."""
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaCapabilityProbe.cs"
    ).read_text(encoding="utf-8")
    assert "/openai/responses?api-version=" in src, (
        "Probe must POST to the Responses API endpoint with api-version "
        "(not the legacy Chat Completions endpoint)."
    )
    assert "ProbeOnceAsync" in src, (
        "Probe must expose a no-cache ProbeOnceAsync overload so tests can "
        "exercise each capability branch without mutating the process cache."
    )
    assert 'type = "json_schema"' in src, (
        "Probe must request strict json_schema constrained decoding."
    )
    assert "strict = true" in src, (
        "Probe must set strict=true on the json_schema format."
    )
    assert 'effort = "low"' in src, (
        "Probe must set reasoning.effort=\"low\" so probe cost is negligible."
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


# ─── F27 P9 T1a — Capability probe behavioural matrix ─────────────────────


def test_capability_probe_matrix(harness_environment, built_harness) -> None:
    """T1a — every branch of EdogQaCapabilityProbe.ProbeOnceAsync must
    populate the expected fields and accumulate the right error codes.
    The harness exercises 9 cases via an injected HttpMessageHandler:
    happy path, two config-missing flavours, network error, four HTTP
    rejection shapes, and a 200-with-unparseable-body case.

    This is the gate that proves the probe is wire-correct before T1b
    can flip ``EDOG_QA_LLM_V2`` to ``shadow``."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "capability-probe")
    assert data["ok"] is True, data
    cases = {c["caseId"]: c for c in data["cases"]}

    # ── Happy path: all four capabilities confirmed, IsReady=true ──
    c = cases["happy_path"]
    assert c["isReady"] is True, c
    assert c["responsesApiAvailable"] is True, c
    assert c["jsonSchemaStrictSupported"] is True, c
    assert c["reasoningSupported"] is True, c
    assert c["maxOutputTokensVerified"] == 2048, c
    assert c["errorCount"] == 0, c
    assert c["handlerInvocations"] == 1, c
    assert c["deployment"] == "gpt-5.4", c
    assert c["endpointHost"] == "aoai.example.test", c

    # ── Config missing: probe must NOT call the handler ──
    for case_id in ("config_missing_no_endpoint", "config_missing_no_key"):
        c = cases[case_id]
        assert c["isReady"] is False, c
        assert "PROBE_CONFIG_MISSING" in c["errorCodes"], c
        assert c["handlerInvocations"] == 0, (
            f"{case_id} must short-circuit before any HTTP call"
        )

    # ── Network error: handler throws, probe must classify cleanly ──
    c = cases["network_error"]
    assert c["isReady"] is False, c
    assert "PROBE_NETWORK_ERROR" in c["errorCodes"], c
    assert c["handlerInvocations"] == 1, c

    # ── 404 with DeploymentNotFound → AOAI_DEPLOYMENT_NOT_FOUND ──
    c = cases["deployment_not_found"]
    assert c["isReady"] is False, c
    assert "AOAI_DEPLOYMENT_NOT_FOUND" in c["errorCodes"], c
    assert "AOAI_RESPONSES_API_UNAVAILABLE" not in c["errorCodes"], (
        "404 with DeploymentNotFound must NOT be misclassified as Responses-API absent."
    )

    # ── 404 without DeploymentNotFound → AOAI_RESPONSES_API_UNAVAILABLE ──
    c = cases["responses_api_unavailable"]
    assert c["isReady"] is False, c
    assert "AOAI_RESPONSES_API_UNAVAILABLE" in c["errorCodes"], c

    # ── 400 mentioning text.format → AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED ──
    c = cases["json_schema_unsupported"]
    assert c["isReady"] is False, c
    assert "AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED" in c["errorCodes"], c

    # ── 200 without usage.output_tokens_details → AOAI_REASONING_UNSUPPORTED ──
    c = cases["reasoning_unsupported"]
    assert c["isReady"] is False, c
    assert c["responsesApiAvailable"] is True, (
        "200 envelope must still promote ResponsesApiAvailable even when "
        "reasoning is unsupported."
    )
    assert c["jsonSchemaStrictSupported"] is True, c
    assert c["reasoningSupported"] is False, c
    assert "AOAI_REASONING_UNSUPPORTED" in c["errorCodes"], c

    # ── 200 with unparseable body → PROBE_RESPONSE_UNPARSEABLE ──
    c = cases["response_unparseable"]
    assert c["isReady"] is False, c
    assert "PROBE_RESPONSE_UNPARSEABLE" in c["errorCodes"], c
    assert c["responsesApiAvailable"] is False, c


def test_capability_probe_request_shape(harness_environment, built_harness) -> None:
    """T1a — the wire payload the probe emits must contain strict
    json_schema + reasoning.effort=low + max_output_tokens=2048, and
    must hit /openai/responses?api-version=... with an api-key header.

    These are the contract promises the orchestrator depends on; if any
    drift, the probe is no longer a faithful proxy for the V2 pipeline's
    behaviour and the readiness signal becomes a lie."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "capability-probe")
    shape = data["requestShape"]
    assert shape["hitsResponsesEndpoint"] is True, shape
    assert shape["hasApiKeyHeader"] is True, shape
    assert shape["hasStrictJsonSchema"] is True, shape
    assert shape["hasReasoningEffort"] is True, shape
    assert shape["hasMaxOutputTokens"] is True, shape


# ─── F27 P9 T1a — Gold-corpus fixture shape ───────────────────────────────


def test_gold_corpus_fixtures_present() -> None:
    """T1a ships three ground-truth PR fixtures under
    ``tests/qa-eval/ground-truth/``. Each fixture must carry ``pr.json``
    (metadata), ``diff.patch`` (the LLM input), ``expected.json``
    (gold-standard scenarios, placeholder until hand-graded), and
    ``notes.md`` (curator notes).

    These three PRs come from the same FLT clone Hemant uses for QA
    sessions. Adding more PRs (different domain shapes — DAG, retry,
    schema migration) lands in T2 once the V2 pipeline is live."""
    import json as _json

    ground_truth_dir = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
    required_prs = ("PR-977882", "PR-976609", "PR-975848")
    for pr in required_prs:
        d = ground_truth_dir / pr
        assert d.is_dir(), f"Missing fixture directory: {d.relative_to(REPO_ROOT)}"
        for required_file in ("pr.json", "diff.patch", "expected.json", "notes.md"):
            f = d / required_file
            assert f.exists() and f.stat().st_size > 0, (
                f"Fixture {pr}/{required_file} missing or empty."
            )
        # pr.json must declare a non-empty diff.
        with (d / "pr.json").open(encoding="utf-8") as fh:
            meta = _json.load(fh)
        assert meta.get("pr_number") == pr.split("-")[1], meta
        assert meta.get("diff_size_bytes", 0) > 0, meta
        assert meta.get("files_changed", 0) > 0, meta


def test_gold_corpus_baseline_scaffold_exists() -> None:
    """T1a created ``tests/qa-eval/baseline.json`` as a placeholder
    scaffold; T1c-c populates it via the live ``capture_baseline.py``
    pass against the gold corpus. This test guards the scaffold-level
    invariants (file present, JSON-parseable, prs is a list); the
    deeper shape assertions live in
    ``test_qa_baseline_json_captured_with_v2_pipeline``.
    """
    import json as _json

    baseline = REPO_ROOT / "tests" / "qa-eval" / "baseline.json"
    assert baseline.exists(), (
        "tests/qa-eval/baseline.json must exist. "
        "Run `python tests/qa-eval/capture_baseline.py` to capture or "
        "`python tests/qa-eval/capture_baseline.py --dry-run` for a scaffold."
    )
    with baseline.open(encoding="utf-8") as fh:
        data = _json.load(fh)
    # Schema_version may be 1.0 (T1a scaffold pre-capture) or 1.1
    # (T1c-c captured). Pre-T1c-c statuses are tolerated to let a
    # checkout-with-stale-baseline still pass this scaffold-level test.
    assert data.get("schema_version") in {"1.0", "1.1"}, data
    assert data.get("status") in (
        "PENDING_T1B", "PENDING", "CAPTURED", "CAPTURED_WITH_ERRORS", "DRY_RUN",
    ), data
    assert isinstance(data.get("prs"), list), data


# ─── F27 P9 T1b — EdogQaLlmClient (Architect + Editor) ────────────────────


def test_qa_llm_client_declares_required_error_codes() -> None:
    """The V2 client (F27 P9 §3.1) must export nine wire-stable error
    codes. The orchestrator + UI inline-error renderer (T1c/T1d) read
    these by exact string match; changing them is a breaking change.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
    ).read_text(encoding="utf-8")
    required = (
        "CLIENT_CONFIG_MISSING_ARCHITECT",
        "CLIENT_CONFIG_MISSING_EDITOR",
        "ARCHITECT_NETWORK_ERROR",
        "ARCHITECT_RESPONSE_UNPARSEABLE",
        "ARCHITECT_PLAN_INVALID",
        "EDITOR_NETWORK_ERROR",
        "EDITOR_RESPONSE_UNPARSEABLE",
        "EDITOR_SCHEMA_VIOLATION",
        "EDITOR_GROUNDING_VIOLATION",
    )
    for code in required:
        assert code in src, f"EdogQaLlmClient must declare error code '{code}'"


def test_qa_llm_client_uses_strict_json_schema_not_json_object() -> None:
    """Defect #1 from spec §1 — the legacy provider's
    ``response_format = json_object`` is unconstrained. The V2 client
    must use ``json_schema`` strict-mode constrained decoding so the
    wire output is well-formed by construction.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
    ).read_text(encoding="utf-8")
    assert '"json_object"' not in src, (
        "EdogQaLlmClient must not use response_format=json_object — that is the "
        "defect P9 exists to fix. Use strict json_schema constrained decoding."
    )
    assert 'type = "json_schema"' in src, (
        "EdogQaLlmClient must request text.format.type=\"json_schema\"."
    )
    assert "strict = true" in src, (
        "EdogQaLlmClient must set strict=true on the json_schema format."
    )


def test_qa_llm_client_architect_editor_split_present() -> None:
    """Spec §3.1 mandates the Architect/Editor split. Both paths must
    be visible in the source as separate methods + separate configs
    + distinct prompt cache keys.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
    ).read_text(encoding="utf-8")
    assert "ArchitectOnceAsync" in src, "missing Architect test-entry method"
    assert "EditorOnceAsync" in src, "missing Editor test-entry method"
    assert "ArchitectConfig" in src, "missing ArchitectConfig record"
    assert "EditorConfig" in src, "missing EditorConfig record"
    assert "PromptCacheKeyArchitect" in src and "PromptCacheKeyEditor" in src, (
        "Architect and Editor must declare distinct prompt_cache_key constants "
        "so cache hits are reported per-role (spec §3.4)."
    )
    assert 'ArchitectReasoningEffort = "high"' in src, (
        "Architect must default to reasoning.effort=high (spec §3.1)."
    )
    assert 'EditorReasoningEffort = "low"' in src, (
        "Editor must default to reasoning.effort=low (spec §3.1)."
    )
    assert "ArchitectMaxOutputTokens = 65536" in src, (
        "Architect must allow ≥65536 max_output_tokens — the original "
        "NO_SCENARIOS_GENERATED bug was a 8192 budget starved by reasoning."
    )


def test_qa_llm_client_diff_marked_untrusted() -> None:
    """Spec §14 security envelope: diff content authored by the PR
    submitter must be framed as untrusted in the prompt envelope.
    The field name + the prompt markers carry that constraint.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
    ).read_text(encoding="utf-8")
    assert "UntrustedRedactedDiff" in src, (
        "ZoneContext must name the diff field UntrustedRedactedDiff so "
        "downstream callers cannot mistake it for trusted content."
    )
    assert "BEGIN UNTRUSTED DIFF" in src and "END UNTRUSTED DIFF" in src, (
        "Architect + Editor user messages must wrap the diff in "
        "BEGIN/END UNTRUSTED DIFF sentinels (spec §14)."
    )


def test_llm_client_architect_matrix(harness_environment, built_harness) -> None:
    """T1b — every Architect branch must classify cleanly. Seven cases
    via injected HttpMessageHandler: happy path, config missing, network
    error, response unparseable, status=incomplete (truncation), plan
    invalid (testable + zero sketches), and the explicit no_testable_changes
    signal.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "llm-client")
    assert data["ok"] is True, data
    cases = {c["caseId"]: c for c in data["architectCases"]}

    c = cases["happy_path"]
    assert c["status"] == "Ok", c
    assert c["planNonNull"] is True, c
    assert c["planOutcome"] == "testable", c
    assert c["sketchCount"] >= 1, c
    assert c["evidenceCount"] >= 1, c
    assert c["errorCount"] == 0, c
    assert c["handlerInvocations"] == 1, c
    assert c["architectReasoningTokens"] > 0, c

    c = cases["config_missing"]
    assert c["status"] == "Failed", c
    assert "CLIENT_CONFIG_MISSING_ARCHITECT" in c["errorCodes"], c
    assert c["handlerInvocations"] == 0, "config-missing must short-circuit before HTTP"

    c = cases["network_error"]
    assert c["status"] == "Failed", c
    assert "ARCHITECT_NETWORK_ERROR" in c["errorCodes"], c
    assert c["handlerInvocations"] == 1, c

    c = cases["response_unparseable"]
    assert c["status"] == "Failed", c
    assert "ARCHITECT_RESPONSE_UNPARSEABLE" in c["errorCodes"], c

    c = cases["truncated_status"]
    assert c["status"] == "Failed", c
    assert "ARCHITECT_RESPONSE_UNPARSEABLE" in c["errorCodes"], (
        "status=incomplete must surface as unparseable so the orchestrator "
        "knows the output is not safe to consume."
    )

    c = cases["plan_invalid_zero_sketches"]
    assert c["status"] == "Failed", c
    assert "ARCHITECT_PLAN_INVALID" in c["errorCodes"], c

    c = cases["no_testable_changes"]
    assert c["status"] == "NoTestableChanges", c
    assert c["errorCount"] == 0, c
    assert c["planOutcome"] == "no_testable_changes", c
    assert c["sketchCount"] == 0, c


def test_llm_client_editor_matrix(harness_environment, built_harness) -> None:
    """T1b — every Editor branch must classify cleanly. Six cases.
    The evidence-binding rule (spec §3.3) is the headline assertion:
    a scenario referencing an evidenceId NOT in the Architect plan
    must produce EDITOR_GROUNDING_VIOLATION and emit zero scenarios.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "llm-client")
    cases = {c["caseId"]: c for c in data["editorCases"]}

    c = cases["happy_path"]
    assert c["status"] == "Ok", c
    assert c["scenarioCount"] >= 1, c
    assert c["errorCount"] == 0, c

    c = cases["config_missing"]
    assert c["status"] == "Failed", c
    assert "CLIENT_CONFIG_MISSING_EDITOR" in c["errorCodes"], c
    assert c["handlerInvocations"] == 0, c

    c = cases["network_error"]
    assert c["status"] == "Failed", c
    assert "EDITOR_NETWORK_ERROR" in c["errorCodes"], c

    c = cases["schema_violation"]
    assert c["status"] == "Failed", c
    assert "EDITOR_SCHEMA_VIOLATION" in c["errorCodes"], c
    assert c["scenarioCount"] == 0, "schema-violating batches must produce zero accepted scenarios"

    c = cases["grounding_violation"]
    assert c["status"] == "Failed", c
    assert "EDITOR_GROUNDING_VIOLATION" in c["errorCodes"], (
        "Editor referencing an evidenceId not in the Architect plan must "
        "produce EDITOR_GROUNDING_VIOLATION — spec §3.3 forbids the Editor "
        "from introducing new grounding citations."
    )
    assert c["scenarioCount"] == 0, "grounding violations must drop the entire batch"

    c = cases["response_unparseable"]
    assert c["status"] == "Failed", c
    assert "EDITOR_RESPONSE_UNPARSEABLE" in c["errorCodes"], c


def test_llm_client_architect_request_shape(harness_environment, built_harness) -> None:
    """T1b wire contract for the Architect request — pin every field
    that orchestrator + UI + capability probe consume so any future
    refactor that drifts the wire shape fails this gate before it
    reaches production.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "llm-client")
    shape = data["architectRequestShape"]
    assert shape["hitsResponsesEndpoint"] is True, shape
    assert shape["hasApiKeyHeader"] is True, shape
    assert shape["hasStrictJsonSchema"] is True, shape
    assert shape["hasReasoningEffortHigh"] is True, shape
    assert shape["hasMaxOutputTokens"] is True, (
        "Architect must request max_output_tokens=65536 — undersizing here "
        "is the root cause of NO_SCENARIOS_GENERATED. shape=" + repr(shape)
    )
    assert shape["hasPromptCacheKey"] is True, shape
    assert shape["modelMentioned"] is True, shape
    assert shape["schemaNamePinned"] is True, shape


def test_llm_client_editor_request_shape(harness_environment, built_harness) -> None:
    """T1b wire contract for the Editor request — model, effort, schema,
    cache key, and the security-envelope markers (plan + UNTRUSTED DIFF).
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "llm-client")
    shape = data["editorRequestShape"]
    assert shape["hitsResponsesEndpoint"] is True, shape
    assert shape["hasApiKeyHeader"] is True, shape
    assert shape["hasStrictJsonSchema"] is True, shape
    assert shape["hasReasoningEffortLow"] is True, shape
    assert shape["hasMaxOutputTokens"] is True, shape
    assert shape["hasPromptCacheKey"] is True, shape
    assert shape["modelMentioned"] is True, shape
    assert shape["schemaNamePinned"] is True, shape
    assert shape["planInPrompt"] is True, (
        "Editor user message must include the Architect plan so the Editor "
        "can ground its scenarios in the plan's evidence pool."
    )
    assert shape["diffMarkedUntrusted"] is True, (
        "Editor user message must frame the diff as UNTRUSTED (spec §14)."
    )


def test_llm_client_schemas_pass_strict_mode_validator(
    harness_environment, built_harness
) -> None:
    """Defense-in-depth: OpenAI strict-mode rejects ``additionalProperties:true``
    + any property missing from ``required`` + ``type`` arrays at runtime.
    The harness recursively walks both schemas — Architect plan and Editor
    scenario batch — and reports any violation BEFORE we send a real
    request.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "llm-client")
    strictness = data["schemaStrictness"]
    assert strictness["architectViolations"] == [], (
        "Architect plan schema violates OpenAI strict-mode rules: "
        + repr(strictness["architectViolations"])
    )
    assert strictness["scenarioViolations"] == [], (
        "Editor scenario batch schema violates OpenAI strict-mode rules: "
        + repr(strictness["scenarioViolations"])
    )






# ── F27 P9 T1c-a — Scenario Validator ───────────────────────────────────

VALIDATOR_REQUIRED_CODES = [
    "GROUNDING_REF_UNKNOWN",
    "GROUNDING_LINE_NOT_IN_DIFF",
    "GROUNDING_SIDE_MISMATCH",
    "GROUNDING_MISSING",
    "FIELD_EMPTY",
    "FIELD_TOO_LONG",
    "FIELD_OUT_OF_RANGE",
    "ENUM_VALUE_INVALID",
    "EXPECTATIONS_MISSING",
    "TOPIC_UNKNOWN",
    "CONFIDENCE_CAPPED",
    "DUPLICATE_IN_BATCH",
]


def test_qa_scenario_validator_class_present() -> None:
    """T1c-a — the defense-in-depth Validator (spec ~A73.2) ships as a
    pure static class with one entry point: `Validate(plan, scenarios,
    diff, context) -> ValidationResult`. Quarantines on failure rather
    than throws, so the Orchestrator can record per-scenario reasons.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaScenarioValidator.cs"
    ).read_text(encoding="utf-8")
    assert "internal static class EdogQaScenarioValidator" in src, (
        "Validator must be a static class within DevMode assembly."
    )
    assert "public static ValidationResult Validate(" in src, (
        "Validator must expose a single Validate entry point."
    )
    assert "public sealed class ValidationResult" in src, (
        "ValidationResult must be a public sealed class so harness + "
        "orchestrator can consume it."
    )
    assert "public sealed class QuarantineReason" in src
    assert "public sealed class AcceptedScenario" in src
    assert "public sealed class QuarantinedScenario" in src


def test_qa_scenario_validator_declares_required_codes() -> None:
    """All twelve wire-stable codes must exist as string constants.
    Reused by the UI inline-error renderer and the orchestrator's
    audit log; renaming them is a breaking change.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaScenarioValidator.cs"
    ).read_text(encoding="utf-8")
    for code in VALIDATOR_REQUIRED_CODES:
        assert f"\"{code}\"" in src, f"Validator missing stable code: {code}"


def test_grounding_evidence_carries_source_evidence_id() -> None:
    """The engine `GroundingEvidence` record must carry an optional
    `SourceEvidenceId` field so the Projector (T1c-a-2) can forward the
    Architect's `evidenceId` into engine-shape scenarios for the audit
    trail. Null on the legacy bridge path.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaModels.cs"
    ).read_text(encoding="utf-8")
    assert "SourceEvidenceId" in src, (
        "GroundingEvidence must carry SourceEvidenceId for the V2 audit "
        "trail; the Projector populates it when EDOG_QA_LLM_V2 is on."
    )


def test_validator_gate_matrix(harness_environment, built_harness) -> None:
    """T1c-a — every gate must trip the expected code on its dedicated
    canned input. Thirteen cases, each scoped to one Validator
    behaviour: 5 grounding gates, 4 schema gates, 1 topic gate, 1
    confidence-clamp accept, 1 dedup, 1 multi-failure scenario.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "validator")
    assert data["ok"] is True, data
    cases = {c["caseId"]: c for c in data["cases"]}

    expected = {
        "happy_path": (1, 0, []),
        "grounding_ref_unknown": (0, 1, ["GROUNDING_REF_UNKNOWN"]),
        "grounding_line_not_in_diff": (0, 1, ["GROUNDING_LINE_NOT_IN_DIFF"]),
        "grounding_side_mismatch": (0, 1, ["GROUNDING_SIDE_MISMATCH"]),
        "grounding_missing": (0, 1, ["GROUNDING_MISSING"]),
        "title_too_long": (0, 1, ["FIELD_TOO_LONG"]),
        "priority_out_of_range": (0, 1, ["FIELD_OUT_OF_RANGE"]),
        "enum_value_invalid": (0, 1, ["ENUM_VALUE_INVALID"]),
        "expectations_missing": (0, 1, ["EXPECTATIONS_MISSING"]),
        "topic_unknown": (0, 1, ["TOPIC_UNKNOWN"]),
        "confidence_clamped": (1, 0, []),
        "duplicate_in_batch": (1, 1, ["DUPLICATE_IN_BATCH"]),
    }
    for case_id, (accepted, quarantined, codes) in expected.items():
        c = cases[case_id]
        assert c["acceptedCount"] == accepted, (case_id, c)
        assert c["quarantinedCount"] == quarantined, (case_id, c)
        if codes:
            actual_codes = []
            for q in c["quarantined"]:
                actual_codes.extend(q["codes"])
            for required in codes:
                assert required in actual_codes, (case_id, required, actual_codes)


def test_validator_multi_failure_reports_all_reasons(
    harness_environment, built_harness
) -> None:
    """When a single scenario trips multiple gates, EVERY reason must be
    recorded so curation has the full picture for repair. The
    'multi_failure' case deliberately violates four gates; the
    Validator must surface all four codes on the single quarantined
    record.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "validator")
    cases = {c["caseId"]: c for c in data["cases"]}
    multi = cases["multi_failure"]
    assert multi["quarantinedCount"] == 1, multi
    codes = set(multi["quarantined"][0]["codes"])
    # title empty + priority out of range + grounding ref unknown +
    # topic unknown — four codes, distinct gates.
    assert "FIELD_EMPTY" in codes, codes
    assert "FIELD_OUT_OF_RANGE" in codes, codes
    assert "GROUNDING_REF_UNKNOWN" in codes, codes
    assert "TOPIC_UNKNOWN" in codes, codes


def test_validator_semantic_hash_is_deterministic(
    harness_environment, built_harness
) -> None:
    """The semantic-hash dedup key must be deterministic: the same
    scenario (same stimulus + sorted expectations) hashed twice
    produces an identical hex digest. The 'happy_path' and
    'confidence_clamped' cases share an identical structural scenario
    — only the confidence value differs (which is intentionally
    excluded from the hash) — so their digests MUST match.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "validator")
    cases = {c["caseId"]: c for c in data["cases"]}
    happy_hash = cases["happy_path"]["accepted"][0]["semanticHash"]
    clamped_hash = cases["confidence_clamped"]["accepted"][0]["semanticHash"]
    dedup_hash = cases["duplicate_in_batch"]["accepted"][0]["semanticHash"]
    assert happy_hash == clamped_hash, (
        "Semantic hash must EXCLUDE confidence — same structure with "
        "different confidence must hash identically."
    )
    assert happy_hash == dedup_hash, (
        "Semantic hash must EXCLUDE title — the duplicate case has a "
        "different title but identical stimulus + expectations."
    )
    # Hash format: lowercase hex, 64 chars (SHA-256 full).
    assert len(happy_hash) == 64, happy_hash
    assert all(ch in "0123456789abcdef" for ch in happy_hash), happy_hash


def test_validator_confidence_is_clamped_to_unit_interval(
    harness_environment, built_harness
) -> None:
    """Gate 4 must clamp confidence into [0.0, 1.0] silently. Source
    value 1.7 ⇒ 1.0. This guards against an LLM producing an
    out-of-band probability that would otherwise crash downstream
    Bayesian aggregation.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "validator")
    cases = {c["caseId"]: c for c in data["cases"]}
    clamped = cases["confidence_clamped"]
    assert clamped["acceptedCount"] == 1, clamped
    assert clamped["accepted"][0]["calibratedConfidence"] == 1.0, clamped


def test_validator_parses_unified_diff_correctly(
    harness_environment, built_harness
) -> None:
    """The grounding-existence gate depends on a correct unified-diff
    parser. The canonical sample has 3 added lines (right side) at
    12/13/14 and 1 deleted line (left side) at 12. Garbage input
    must yield an empty set, not throw.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "validator")
    samples = {s["label"]: s for s in data["diffParseSamples"]}

    canonical = samples["canonical"]
    right_lines = [r["Line"] for r in canonical["rightLines"]]
    left_lines = [item["Line"] for item in canonical["leftLines"]]
    assert right_lines == [12, 13, 14], canonical
    assert left_lines == [12], canonical
    assert all(r["Path"] == "src/Foo.cs" for r in canonical["rightLines"]), canonical

    assert samples["empty_diff"]["changedLineCount"] == 0
    assert samples["garbage_input"]["changedLineCount"] == 0


def test_validator_enum_vocabularies_are_published(
    harness_environment, built_harness
) -> None:
    """The Validator exposes its enum vocabularies for the orchestrator
    + UI to share. The harness captures them so this test pins the
    canonical sets — a careless rename surfaces here.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "validator")
    enum_vocab = data["enumVocabulary"]
    assert "DirectInvoke" in enum_vocab["stimulusTypes"]
    assert "HttpRequest" in enum_vocab["stimulusTypes"]
    assert len(enum_vocab["stimulusTypes"]) == 6, enum_vocab["stimulusTypes"]
    assert len(enum_vocab["expectationTypes"]) >= 6, enum_vocab["expectationTypes"]
    assert "HappyPath" in enum_vocab["categories"], enum_vocab["categories"]

# ── F27 P9 T1c-a-2 — Scenario Projector ─────────────────────────────────

PROJECTOR_REQUIRED_CODES = [
    "PROJECTION_STIMULUS_SPEC_MALFORMED",
    "PROJECTION_STIMULUS_SPEC_MISSING_FIELD",
    "PROJECTION_STIMULUS_SPEC_FIELD_TYPE",
    "PROJECTION_MATCHER_SPEC_MALFORMED",
    "PROJECTION_MATCHER_SPEC_EMPTY",
    "PROJECTION_ENUM_PARSE_FAILED",
    "PROJECTION_GROUNDING_REF_UNRESOLVED",
]


def test_qa_scenario_projector_class_present() -> None:
    """T1c-a-2 — the V2-to-engine Projector (spec section 3.3 inputs) ships
    as a pure static class with one entry point: Project(plan, accepted)
    -> ProjectionResult, reusing Validator's QuarantineReason shape so
    the orchestrator can merge both lists.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaScenarioProjector.cs"
    ).read_text(encoding="utf-8")
    assert "internal static class EdogQaScenarioProjector" in src
    assert "public static ProjectionResult Project(" in src
    assert "public sealed class ProjectionResult" in src
    assert "EdogQaScenarioValidator.QuarantinedScenario" in src
    assert "EdogQaScenarioValidator.AcceptedScenario" in src


def test_qa_scenario_projector_declares_required_codes() -> None:
    """All seven wire-stable projection codes must exist as string
    constants. Wire-stable means renaming them is a breaking change.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaScenarioProjector.cs"
    ).read_text(encoding="utf-8")
    for code in PROJECTOR_REQUIRED_CODES:
        assert f'"{code}"' in src, f"Projector missing stable code: {code}"


def test_projector_happy_paths_cover_all_six_stimulus_types(
    harness_environment, built_harness
) -> None:
    """Every StimulusType discriminator (HttpRequest, SignalrInvoke,
    DagTrigger, FileEvent, TimerTick, DirectInvoke) must round-trip
    through the Projector to engine shape with exactly one typed payload
    record non-null. The harness drives one happy-path case per type.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    assert data["ok"] is True, data
    cases = {c["caseId"]: c for c in data["cases"]}

    expected = {
        "happy_http_request": ("HttpRequest", "projectedHasHttpPayload"),
        "happy_signalr_invoke": ("SignalrInvoke", "projectedHasSignalrPayload"),
        "happy_dag_trigger": ("DagTrigger", "projectedHasDagPayload"),
        "happy_file_event": ("FileEvent", "projectedHasFileEventPayload"),
        "happy_timer_tick": ("TimerTick", "projectedHasTimerTickPayload"),
        "happy_direct_invoke": ("DirectInvoke", "projectedHasDirectInvokePayload"),
    }
    for case_id, (stimulus_type, payload_flag) in expected.items():
        c = cases[case_id]
        assert c["acceptedCount"] == 1, (case_id, c)
        assert c["rejectedCount"] == 0, (case_id, c)
        assert c["projectedStimulusType"] == stimulus_type, (case_id, c)
        assert c[payload_flag] is True, (case_id, c)
        # Exactly one payload non-null: the others must all be false.
        for other_flag in (
            "projectedHasHttpPayload",
            "projectedHasSignalrPayload",
            "projectedHasDagPayload",
            "projectedHasFileEventPayload",
            "projectedHasTimerTickPayload",
            "projectedHasDirectInvokePayload",
        ):
            if other_flag != payload_flag:
                assert c[other_flag] is False, (case_id, other_flag, c)


def test_projector_matcher_dispatches_all_five_branches(
    harness_environment, built_harness
) -> None:
    """Each happy-path case uses a different matcher branch: Exact,
    Exists, Contains, Regex, Range, Exact. Across the six happy paths
    every Matcher discriminator must be exercised at least once. This
    pins the dictionary-based parser against silent dropping of a
    branch.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    cases = {c["caseId"]: c for c in data["cases"]}
    seen_branches = set()
    for case_id in (
        "happy_http_request", "happy_signalr_invoke", "happy_dag_trigger",
        "happy_file_event", "happy_timer_tick", "happy_direct_invoke",
    ):
        c = cases[case_id]
        for branch in ("Exact", "Contains", "Regex", "Range", "Exists"):
            if c[f"projectedFirstMatcherHas{branch}"]:
                seen_branches.add(branch)
    assert seen_branches == {"Exact", "Contains", "Regex", "Range", "Exists"}, (
        f"Matcher branches not exhaustively exercised; saw {seen_branches}"
    )


def test_projector_rejects_malformed_stimulus_spec(
    harness_environment, built_harness
) -> None:
    """A StimulusSpec that is not valid JSON must produce a single
    quarantined record with code PROJECTION_STIMULUS_SPEC_MALFORMED
    bound to fieldPath 'stimulusSpec'. No engine scenario is emitted.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    cases = {c["caseId"]: c for c in data["cases"]}
    c = cases["stimulus_spec_malformed"]
    assert c["acceptedCount"] == 0, c
    assert c["rejectedCount"] == 1, c
    assert "PROJECTION_STIMULUS_SPEC_MALFORMED" in c["rejectedCodes"], c
    assert "stimulusSpec" in c["rejectedFieldPaths"], c


def test_projector_rejects_missing_required_stimulus_field(
    harness_environment, built_harness
) -> None:
    """A typed-shape requirement that the LLM client schema cannot
    enforce (e.g. HttpRequest needs 'path') surfaces as
    PROJECTION_STIMULUS_SPEC_MISSING_FIELD bound to the dotted
    field path 'stimulusSpec.path'.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    cases = {c["caseId"]: c for c in data["cases"]}
    c = cases["stimulus_spec_missing_field"]
    assert c["acceptedCount"] == 0, c
    assert "PROJECTION_STIMULUS_SPEC_MISSING_FIELD" in c["rejectedCodes"], c
    assert "stimulusSpec.path" in c["rejectedFieldPaths"], c


def test_projector_rejects_malformed_or_empty_matcher(
    harness_environment, built_harness
) -> None:
    """Both modes of broken matcher specification must be rejected:
    invalid JSON (PROJECTION_MATCHER_SPEC_MALFORMED) and a JSON
    object with none of exact/contains/regex/range/exists
    (PROJECTION_MATCHER_SPEC_EMPTY). FieldPath in both cases is
    scoped to the expectation index.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    cases = {c["caseId"]: c for c in data["cases"]}
    malformed = cases["matcher_spec_malformed"]
    assert "PROJECTION_MATCHER_SPEC_MALFORMED" in malformed["rejectedCodes"], malformed
    assert "expectations[0].matcherSpec" in malformed["rejectedFieldPaths"], malformed

    empty = cases["matcher_spec_empty"]
    assert "PROJECTION_MATCHER_SPEC_EMPTY" in empty["rejectedCodes"], empty
    assert "expectations[0].matcherSpec" in empty["rejectedFieldPaths"], empty


def test_projector_forwards_source_evidence_id_to_engine_grounding(
    harness_environment, built_harness
) -> None:
    """The audit trail forward-carry: an Architect plan's evidenceId
    must surface on the projected scenario's GroundingEvidence as
    SourceEvidenceId. This is the bridge between the LLM client's
    opaque ref-by-id and the engine's typed evidence record.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    cases = {c["caseId"]: c for c in data["cases"]}
    c = cases["source_evidence_id_forwarded"]
    assert c["acceptedCount"] == 1, c
    assert c["rejectedCount"] == 0, c
    assert c["groundingSourceEvidenceId"] == "ev-trail-1", c
    assert c["groundingFile"] == "src/Foo.cs", c
    assert c["groundingStartLine"] == 12, c
    assert c["projectedGeneratedBy"] == "ai", c
    assert c["projectedLifecycle"] == "Generated", c


def test_projector_processes_mixed_outcomes_per_scenario(
    harness_environment, built_harness
) -> None:
    """A batch with one well-formed scenario and one broken one must
    yield exactly one projected + one rejected, with each scenario's
    id surfacing on its own side of the result. No cross-contamination
    of error reasons from the bad scenario into the good one.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "projector")
    cases = {c["caseId"]: c for c in data["cases"]}
    c = cases["multiple_scenarios_mixed_outcome"]
    assert c["acceptedCount"] == 1, c
    assert c["rejectedCount"] == 1, c
    assert c["projectedIds"] == ["sk-ok"], c
    assert c["rejectedIds"] == ["sk-bad"], c
    assert "PROJECTION_STIMULUS_SPEC_MISSING_FIELD" in c["rejectedCodes"], c

# ── F27 P9 T1c-b — Scenario Orchestrator + LlmV2 wire-in ────────────────

ORCHESTRATOR_REQUIRED_CODES = [
    "BUDGET_EXCEEDED_COST",
    "BUDGET_EXCEEDED_TIME",
    "ORCH_DELEGATE_RETURNED_NULL",
    "ORCH_UNEXPECTED_EXCEPTION",
]


def test_qa_scenario_orchestrator_class_present() -> None:
    """T1c-b: orchestrator must exist as an internal class with the
    public RunAsync entry point and the cancellation-safe contract
    documented in its summary.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaScenarioOrchestrator.cs"
    ).read_text(encoding="utf-8")
    assert "internal sealed class EdogQaScenarioOrchestrator" in src
    assert "public async Task<OrchestratorResult> RunAsync(" in src
    assert "SemaphoreSlim" in src, "bounded concurrency must use SemaphoreSlim"
    assert "Interlocked.CompareExchange" in src, "first-tripped budget claim must use CompareExchange"
    assert "Stopwatch" in src, "deadline must use monotonic Stopwatch"


def test_qa_scenario_orchestrator_declares_required_codes() -> None:
    """All four wire-stable codes must be present as string literals
    so SignalR consumers can pattern-match without re-parsing.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaScenarioOrchestrator.cs"
    ).read_text(encoding="utf-8")
    for code in ORCHESTRATOR_REQUIRED_CODES:
        assert code in src, f"orchestrator must declare {code}"


def test_orchestrator_happy_single_zone(harness_environment, built_harness) -> None:
    """Single zone, valid stubs ⇒ 1 merged scenario, 0 duplicates,
    0 projection rejects, no budget trip.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["happy_single_zone"]
    assert c["mergedScenarioCount"] == 1, c
    assert c["duplicateCount"] == 0, c
    assert c["projectionRejectedCount"] == 0, c
    assert c["budgetGateTripped"] is False, c


def test_orchestrator_happy_multi_zone_no_dedup(harness_environment, built_harness) -> None:
    """Three zones with semantically distinct scenarios ⇒ 3 merged,
    0 duplicates. Proves the orchestrator only dedupes on actual
    SemanticHash collisions, not zone count.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["happy_multi_zone"]
    assert c["mergedScenarioCount"] == 3, c
    assert c["duplicateCount"] == 0, c


def test_orchestrator_cross_zone_dedup_keeps_one_winner(
    harness_environment, built_harness
) -> None:
    """Two zones producing the same SemanticHash ⇒ 1 winner +
    1 duplicate after the deterministic cross-zone reducer.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["cross_zone_dedup"]
    assert c["mergedScenarioCount"] == 1, c
    assert c["duplicateCount"] == 1, c


def test_orchestrator_dedup_winner_is_first_zone_index(
    harness_environment, built_harness
) -> None:
    """When two zones collide on hash, the winner must be the zone
    with the lower ZoneInputIndex regardless of completion time.
    Determinism guarantee for the curation UI.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["dedup_winner_is_first_zone"]
    assert c["duplicateWinnerZoneId"] == "z-0", c
    assert c["duplicateLoserZoneId"] == "z-1", c


def test_orchestrator_no_testable_changes_emits_zero(
    harness_environment, built_harness
) -> None:
    """planOutcome=no_testable_changes ⇒ editor skipped, 0 merged."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["architect_no_testable_changes"]
    assert c["mergedScenarioCount"] == 0, c


def test_orchestrator_architect_failure_isolated(
    harness_environment, built_harness
) -> None:
    """One zone's architect throwing must not poison sibling zones."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["architect_failure_isolation"]
    assert c["mergedScenarioCount"] == 1, c


def test_orchestrator_editor_failure_isolated(
    harness_environment, built_harness
) -> None:
    """One zone's editor throwing must not poison sibling zones."""
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["editor_failure_isolation"]
    assert c["mergedScenarioCount"] == 1, c


def test_orchestrator_projector_rejects_winner_surfaces_reject(
    harness_environment, built_harness
) -> None:
    """When a winner has a stimulus the projector cannot decode,
    it must surface as ProjectionRejected rather than silently
    appearing in MergedScenarios with garbage fields.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["projector_rejects_winner"]
    assert c["mergedScenarioCount"] == 0, c
    assert c["projectionRejectedCount"] == 1, c


def test_orchestrator_bounded_concurrency_le_3(
    harness_environment, built_harness
) -> None:
    """6 zones with MaxConcurrentZones=3 ⇒ observed peak parallelism
    must be ≤ 3. SemaphoreSlim is the only thing standing between
    a 100-zone PR and a 100-RPS LLM flood.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["bounded_concurrency_le_3"]
    assert c["observedMaxConcurrent"] <= 3, c


def test_orchestrator_budget_cost_exceeded_emits_canonical_reason(
    harness_environment, built_harness
) -> None:
    """Aggressive pricing + tiny budget ⇒ BudgetGateTripped=true,
    reason=BUDGET_EXCEEDED_COST, at least one zone skipped.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["budget_cost_exceeded"]
    assert c["budgetGateTripped"] is True, c
    assert c["budgetGateReason"] == "BUDGET_EXCEEDED_COST", c
    assert c["skippedCount"] >= 1, c


def test_orchestrator_budget_time_exceeded_emits_canonical_reason(
    harness_environment, built_harness
) -> None:
    """Sub-second deadline + slow architect ⇒ BudgetGateTripped=true,
    reason=BUDGET_EXCEEDED_TIME, at least one zone skipped.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["budget_time_exceeded"]
    assert c["budgetGateTripped"] is True, c
    assert c["budgetGateReason"] == "BUDGET_EXCEEDED_TIME", c
    assert c["skippedCount"] >= 1, c


def test_orchestrator_emits_required_progress_event_kinds(
    harness_environment, built_harness
) -> None:
    """ZoneStarted, ZoneCompleted, and BatchCompleted are non-negotiable
    for live SignalR progress. Other event kinds (Validated, etc.) are
    additive but the three above must always fire on a happy run.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["progress_events_emitted"]
    assert c["hasZoneStarted"] is True, c
    assert c["hasZoneCompleted"] is True, c
    assert c["hasBatchCompleted"] is True, c
    assert c["lastKind"] == "BatchCompleted", c


def test_orchestrator_external_cancellation_throws_oce(
    harness_environment, built_harness
) -> None:
    """External CancellationToken.Cancel() ⇒ OperationCanceledException
    propagates to the caller. Per-zone failures DO NOT throw — they
    become ZoneOutcome=Failed. Only the external CT throws OCE.
    """
    data = _run_harness(harness_environment["dotnet"], built_harness, "orchestrator")
    c = {x["caseId"]: x for x in data["cases"]}["cancellation_throws_oce"]
    assert c["threwOce"] is True, c


def test_codeanalyzer_wirein_branches_on_llmv2_flag() -> None:
    """T1c-b wire-in: the analyzer must read EdogQaFeatureFlags.LlmV2,
    consult EdogQaCapabilityProbe.IsAzureOpenAiReadyForV2 as a hard
    gate, and branch on LlmV2Mode.On / Shadow / (else=Off). Shadow
    must use a linked CTS so its fire-and-forget cannot outlive the
    caller's cancellation.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaCodeAnalyzer.cs"
    ).read_text(encoding="utf-8")
    assert "EdogQaFeatureFlags.LlmV2" in src, "must read the V2 flag"
    assert "EdogQaCapabilityProbe.IsAzureOpenAiReadyForV2" in src, "capability probe must hard-gate"
    assert "LlmV2Mode.On" in src
    assert "LlmV2Mode.Shadow" in src
    assert "LlmV2Mode.Off" in src
    assert "RunV2OrchestratorAsync" in src, "On / Shadow must delegate to V2"
    assert "CreateLinkedTokenSource" in src, "shadow must use a linked CTS"


def test_codeanalyzer_v2_wirein_uses_orchestrator_and_validator() -> None:
    """V2 wire-in must instantiate the orchestrator with the validator's
    ValidationContext + ValidTopics, not invent a new validation
    surface. Reuse keeps the validation gates uniform between unit
    tests and production paths.
    """
    src = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaCodeAnalyzer.cs"
    ).read_text(encoding="utf-8")
    assert "new EdogQaScenarioOrchestrator(" in src
    assert "EdogQaScenarioValidator.ValidationContext" in src
    assert "EdogQaLlmClient.ReadArchitectConfigFromEnv" in src
    assert "EdogQaLlmClient.ReadEditorConfigFromEnv" in src

# ── F27 P9 T1c-c — SECURITY.md threat model presence ────────────────────


def test_qa_security_doc_exists_with_required_sections() -> None:
    """SECURITY.md is the canonical threat model the spec §14.3 promised
    to create in T0 but never actually shipped on disk. T1c-c lands it.

    The doc MUST cover trust boundaries, the five named attack vectors,
    a clearly identified owner of record (Sentinel), and a status row
    for every shipped mitigation so a quarterly review can be performed
    against the live commit log.
    """
    sec = (
        REPO_ROOT
        / "docs"
        / "specs"
        / "features"
        / "F27-qa-testing"
        / "SECURITY.md"
    )
    assert sec.exists(), f"SECURITY.md missing: {sec}"
    text = sec.read_text(encoding="utf-8")

    # Owner + cadence
    assert "Owner of record" in text or "Owner of record:" in text
    assert "Sentinel" in text, "Sentinel must be the named owner of record"
    assert "Quarterly" in text or "quarterly" in text, "review cadence must be stated"

    # Trust boundaries (§2)
    assert "Trust boundaries" in text
    for required_party in (
        "ADO PR diff",
        "EdogQaLlmClient",
        "Validator",
        "Projector",
        "Curation UI",
        "execution engine",
        "Telemetry",
    ):
        assert required_party in text, f"trust boundary table must mention {required_party!r}"

    # Attack vectors (§3) — five named families plus scenario-execution
    for vector in (
        "Prompt injection",
        "Secret",
        "Denial-of-wallet",
        "Provider exfiltration",
        "Judge corruption",
        "Scenario-execution",
    ):
        assert vector in text, f"attack vector {vector!r} must be enumerated"

    # Untrusted-diff envelope (M1.1) is the highest-leverage mitigation;
    # the doc must reference the wire shape so a reviewer can verify it.
    assert "UntrustedRedactedDiff" in text
    assert "BEGIN UNTRUSTED DIFF" in text or "---BEGIN UNTRUSTED DIFF---" in text

    # Capability-probe + Azure-OpenAI-only posture
    assert "Azure OpenAI ONLY" in text
    assert "EdogQaCapabilityProbe" in text

    # Budget/concurrency caps mentioned by their wire-stable surfaces
    assert "BUDGET_EXCEEDED_COST" in text
    assert "BUDGET_EXCEEDED_TIME" in text
    assert "MaxConcurrentZones" in text or "SemaphoreSlim" in text


def test_qa_security_doc_status_summary_present() -> None:
    """The §6 status summary is what makes the doc actionable for the
    quarterly review — it forces every mitigation row to be marked as
    shipped, partial, or pending, with a commit hash where it shipped.
    Without this, the doc rots into prose.
    """
    sec = (
        REPO_ROOT
        / "docs"
        / "specs"
        / "features"
        / "F27-qa-testing"
        / "SECURITY.md"
    )
    text = sec.read_text(encoding="utf-8")
    assert "Status summary" in text
    assert "Shipped:" in text
    assert "Pending" in text
    # At least one commit hash from the P9 series must be cited so the
    # status column is grounded in real code, not aspiration.
    import re
    commits = re.findall(r"`[0-9a-f]{7}`", text)
    assert len(commits) >= 3, f"status summary must cite shipped commits; saw {commits}"


# ── F27 P9 T1c-c — gold-corpus baseline.json shape pin ──────────────


def test_qa_baseline_json_captured_with_v2_pipeline() -> None:
    """baseline.json is the floor V2 must beat. T1c-c populates it by
    driving the real V2 pipeline (Architect → Editor → Validator →
    Projector) against the 3-PR gold corpus and recording per-PR
    token / latency / scenario-count / violation-count metrics.

    Schema version 1.1 was introduced for T1c-c; v1.0 was a PENDING
    placeholder. Any future schema change must bump the version and
    update this test.
    """
    baseline_path = REPO_ROOT / "tests" / "qa-eval" / "baseline.json"
    assert baseline_path.exists(), f"baseline.json missing: {baseline_path}"

    import json
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))

    assert baseline.get("schema_version") == "1.1", (
        f"expected schema_version=1.1, got {baseline.get('schema_version')!r}"
    )
    assert baseline.get("pipeline") == "v2_architect_editor"
    assert baseline.get("status") in {"CAPTURED", "CAPTURED_WITH_ERRORS", "DRY_RUN"}, (
        f"unexpected status: {baseline.get('status')!r}"
    )

    components = baseline.get("pipeline_components") or {}
    for required_component in ("architect", "editor", "validator", "projector"):
        assert required_component in components, (
            f"pipeline_components missing {required_component!r}: {components}"
        )

    prs = baseline.get("prs") or []
    assert len(prs) == 3, f"baseline must cover all 3 gold-corpus PRs; got {len(prs)}"

    expected_pr_numbers = {"975848", "976609", "977882"}
    captured_pr_numbers = {str(p.get("pr_number")) for p in prs}
    assert captured_pr_numbers == expected_pr_numbers, (
        f"unexpected PRs in baseline: {captured_pr_numbers}"
    )

    required_per_pr_keys = {
        "pr_number", "status",
        "architect_elapsed_ms", "architect_input_tokens", "architect_output_tokens",
        "architect_reasoning_tokens", "architect_plan_outcome",
        "editor_elapsed_ms", "editor_input_tokens", "editor_output_tokens",
        "scenarios_emitted", "scenarios_after_validation", "scenarios_after_projection",
        "grounding_violations", "schema_violations",
        "recall", "precision",
    }
    for pr in prs:
        missing = required_per_pr_keys - set(pr.keys())
        assert not missing, f"PR {pr.get('pr_number')!r} missing keys: {missing}"
        # recall/precision are intentionally null at T1c-c — they require
        # human-graded expected.json files. Confirm they were not silently
        # populated with fake numbers (which would lie to the regression
        # detector). T2 lifts this once expected.json grading completes.
        assert pr["recall"] is None, "recall must be null at T1c-c (expected.json PENDING_HUMAN_GRADING)"
        assert pr["precision"] is None, "precision must be null at T1c-c (expected.json PENDING_HUMAN_GRADING)"


def test_qa_baseline_capture_script_present() -> None:
    """The capture script is what an authorised operator runs to refresh
    the baseline. Keep its path stable so SECURITY.md §6 + the runbook
    in p9-production-grade-llm.md stay accurate.
    """
    script = REPO_ROOT / "tests" / "qa-eval" / "capture_baseline.py"
    assert script.exists(), f"capture_baseline.py missing: {script}"
    text = script.read_text(encoding="utf-8")
    # Pin the harness subcommand the script invokes — drift here means
    # the script silently fails to capture and writes empty records.
    assert "gold-corpus-baseline" in text, "capture script must invoke the gold-corpus-baseline harness"
    # Pin the dry-run gate — operators sanity-check the schema without
    # burning AOAI tokens via `python capture_baseline.py --dry-run`.
    assert "--dry-run" in text


def test_qa_editor_prompt_declares_topic_vocabulary() -> None:
    """The Editor system prompt MUST enumerate the closed 16-topic
    interceptor vocabulary (T1c-c bug fix). Without it, the Editor
    invents arbitrary topics and the validator quarantines every
    scenario as TOPIC_UNKNOWN — discovered during gold-corpus baseline
    capture and the reason 0/17 scenarios passed before this fix.
    """
    src = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
    text = src.read_text(encoding="utf-8")
    # Spot-check a few topics that span the vocabulary. The validator's
    # ValidTopics list lives in EdogQaCodeAnalyzer.cs — drift between
    # the two surfaces is what this test exists to catch.
    for topic in ("http", "telemetry", "retry", "flt-ops", "capacity", "spark"):
        assert topic in text, f"Editor prompt must mention topic {topic!r}"
    assert "CLOSED SET" in text, "Editor prompt must declare topic vocabulary as closed set"


def test_qa_editor_prompt_declares_stimulus_spec_format() -> None:
    """The Editor system prompt MUST explain that stimulusSpec and
    matcherSpec are JSON-encoded STRINGS, with the per-StimulusType
    required fields enumerated. Without this guidance the Editor emits
    invalid JSON inside the spec field and 100% of scenarios are
    PROJECTION_STIMULUS_SPEC_MALFORMED — discovered during gold-corpus
    baseline capture.
    """
    src = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
    text = src.read_text(encoding="utf-8")
    assert "STIMULUS_SPEC FORMAT" in text
    assert "MATCHER_SPEC FORMAT" in text
    # Pin the six StimulusType branches the prompt must describe — drift
    # here means the LLM no longer gets schema instructions for that
    # branch and the projector starts rejecting it.
    for stim in ("HttpRequest", "SignalrInvoke", "DagTrigger", "FileEvent", "TimerTick", "DirectInvoke"):
        assert stim in text, f"Editor prompt must describe {stim} stimulusSpec shape"
    # Pin the five matcher branches.
    for matcher in ("exact", "contains", "regex", "range", "exists"):
        assert matcher in text, f"Editor prompt must describe {matcher!r} matcher branch"
