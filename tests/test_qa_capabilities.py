"""F27 P5 — Capability registry & honesty-gate shape tests.

These tests pin the P5 production-readiness surface: the QA execution
engine MUST refuse setup steps that require unavailable host primitives
(chaos, force-OFF flag overrides) instead of silently incrementing a
"no-op" counter and proceeding to evaluate assertions as if the fault
had been injected.

Tests are *structural* (regex over C# sources) — runtime behaviour is
exercised by the E2E integration tests in P3.

Tests in this module assert:
1. ``EdogQaCapabilityRegistry`` static class exists with the documented
   surface (``IsChaosFaultSupported``, ``IsFlagOverrideSupported``,
   ``GetChaosUnavailableReason``, ``GetFlagOverrideUnavailableReason``,
   ``BuildReport``) and exposes the stable error-code constants.
2. ``ChaosUnavailableException`` and ``FlagOverrideUnavailableException``
   are defined and inherit from ``InvalidOperationException``.
3. ``EdogHttpFaultStore`` exists with the documented public surface
   (``AddRule``, ``RemoveRulesForScenario``, ``TryMatchFault``,
   ``ActiveRuleCount``, ``ResetForTesting``).
4. ``EdogFeatureOverrideStore`` exposes ``MergeOverrides`` and
   ``RemoveOverrides`` so the execution engine can wire per-scenario
   flag overrides without clobbering the dev-server control plane.
5. ``ChaosIntegration.ApplyChaosRuleAsync`` consults the capability
   registry and throws ``ChaosUnavailableException`` when unsupported.
6. ``FlagOverrideStore.ApplyOverrideAsync`` pushes accepted overrides
   into ``EdogFeatureOverrideStore.MergeOverrides`` (no longer silently
   counts a NoOp on the happy path).
7. ``FlagOverrideStore.ClearOverridesForScenarioAsync`` removes per-
   scenario keys via ``EdogFeatureOverrideStore.RemoveOverrides``.
8. The Setup loop in ``EdogQaExecutionEngine`` catches both new
   exceptions specifically and emits the stable
   ``CAPABILITY_UNAVAILABLE_*`` error codes in ``ErrorMessage``.
9. The hub exposes ``QaGetCapabilities`` returning ``QaCapabilityReport``,
   and the POCO carries the documented fields.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEVMODE = ROOT / "src" / "backend" / "DevMode"

CAP_REGISTRY = DEVMODE / "EdogQaCapabilityRegistry.cs"
FAULT_STORE = DEVMODE / "EdogHttpFaultStore.cs"
FEATURE_STORE = DEVMODE / "EdogFeatureOverrideStore.cs"
EXEC_ENGINE = DEVMODE / "EdogQaExecutionEngine.cs"
HUB = DEVMODE / "EdogPlaygroundHub.cs"
SIGNALR_MODELS = DEVMODE / "QaSignalRModels.cs"


def _read(path: Path) -> str:
    assert path.exists(), f"Expected file does not exist: {path}"
    return path.read_text(encoding="utf-8")


# ─── 1. EdogQaCapabilityRegistry surface ──────────────────────────────────


@pytest.fixture(scope="module")
def registry_src() -> str:
    return _read(CAP_REGISTRY)


def test_capability_registry_class(registry_src: str) -> None:
    assert "internal static class EdogQaCapabilityRegistry" in registry_src


def test_capability_registry_error_codes(registry_src: str) -> None:
    """Stable error codes the studio UI greps for to render badges."""
    assert 'const string ErrorCodeChaosUnavailable = "CAPABILITY_UNAVAILABLE_CHAOS"' in registry_src
    assert 'const string ErrorCodeFlagOverrideUnavailable = "CAPABILITY_UNAVAILABLE_FLAG"' in registry_src


def test_capability_registry_env_var(registry_src: str) -> None:
    """The HTTP-chaos opt-in env var is the documented control."""
    assert 'EnvVarHttpChaos = "EDOG_QA_CHAOS_HTTP"' in registry_src


@pytest.mark.parametrize(
    "method",
    [
        "IsChaosFaultSupported",
        "IsFlagOverrideSupported",
        "GetChaosUnavailableReason",
        "GetFlagOverrideUnavailableReason",
        "IsHttpChaosBackendEnabled",
        "BuildReport",
    ],
)
def test_capability_registry_method(registry_src: str, method: str) -> None:
    """Every documented entry point exists with the expected name."""
    assert "public static" in registry_src and method in registry_src


def test_capability_exceptions_defined(registry_src: str) -> None:
    """The two exception types are defined and inherit from InvalidOperationException
    so they propagate naturally through the engine's existing catch chain."""
    assert "internal sealed class ChaosUnavailableException : InvalidOperationException" in registry_src
    assert "internal sealed class FlagOverrideUnavailableException : InvalidOperationException" in registry_src


# ─── 2. EdogHttpFaultStore surface ────────────────────────────────────────


@pytest.fixture(scope="module")
def fault_store_src() -> str:
    return _read(FAULT_STORE)


def test_fault_store_class(fault_store_src: str) -> None:
    assert "internal static class EdogHttpFaultStore" in fault_store_src


@pytest.mark.parametrize(
    "method",
    [
        "AddRule",
        "RemoveRulesForScenario",
        "TryMatchFault",
        "ResetForTesting",
    ],
)
def test_fault_store_method(fault_store_src: str, method: str) -> None:
    assert "public static" in fault_store_src and method in fault_store_src


def test_fault_store_uses_frozen_dictionary(fault_store_src: str) -> None:
    """Same lock-free snapshot pattern as EdogFeatureOverrideStore."""
    assert "FrozenDictionary" in fault_store_src
    assert "Volatile.Write" in fault_store_src
    assert "Interlocked.Increment" in fault_store_src


def test_fault_entry_carries_required_fields(fault_store_src: str) -> None:
    """HttpFaultEntry must expose the fields the pipeline handler (Stage 2)
    will read to synthesize the response."""
    assert "internal sealed class HttpFaultEntry" in fault_store_src
    for prop in ["ScenarioId", "TargetSubstring", "Fault", "StatusCode", "ResponseBody", "LatencyMs"]:
        assert prop in fault_store_src, f"HttpFaultEntry missing {prop}"


# ─── 3. EdogFeatureOverrideStore — surgical merge/remove APIs ─────────────


@pytest.fixture(scope="module")
def feature_store_src() -> str:
    return _read(FEATURE_STORE)


def test_feature_store_merge_overrides(feature_store_src: str) -> None:
    """The QA engine merges per-scenario overrides into the global snapshot
    without clobbering pre-existing entries from the dev-server."""
    assert "public static (long revision, string hash, int count) MergeOverrides(" in feature_store_src


def test_feature_store_remove_overrides(feature_store_src: str) -> None:
    """Teardown removes per-scenario keys only, preserving other entries."""
    assert "public static (long revision, string hash, int count) RemoveOverrides(" in feature_store_src


def test_feature_store_merge_rejects_force_off(feature_store_src: str) -> None:
    """MergeOverrides must enforce the force-ON-only invariant — defense in
    depth even though the capability registry already filters."""
    assert "Force-OFF is not supported" in feature_store_src


# ─── 4. ChaosIntegration consults the registry ────────────────────────────


@pytest.fixture(scope="module")
def exec_engine_src() -> str:
    return _read(EXEC_ENGINE)


def test_chaos_consults_capability_registry(exec_engine_src: str) -> None:
    """ChaosIntegration.ApplyChaosRuleAsync must consult the registry before
    accepting any rule — the heart of the honesty gate."""
    assert "EdogQaCapabilityRegistry.IsChaosFaultSupported" in exec_engine_src


def test_chaos_throws_unavailable(exec_engine_src: str) -> None:
    """When unsupported, ApplyChaosRuleAsync throws — the engine catches
    and marks the scenario Skipped instead of silently passing."""
    assert "throw new ChaosUnavailableException(" in exec_engine_src


def test_chaos_increments_unavailable_counter(exec_engine_src: str) -> None:
    assert "EdogQaTelemetry.IncrementChaosUnavailable()" in exec_engine_src


def test_chaos_increments_applied_counter(exec_engine_src: str) -> None:
    """The accepted path increments the truthful counter so the studio UI
    can distinguish requested-vs-applied."""
    assert "EdogQaTelemetry.IncrementChaosApplied()" in exec_engine_src


def test_chaos_wires_into_fault_store(exec_engine_src: str) -> None:
    """Stage 2 hook: accepted chaos rules push into EdogHttpFaultStore."""
    assert "EdogHttpFaultStore.AddRule(" in exec_engine_src
    assert "EdogHttpFaultStore.RemoveRulesForScenario(" in exec_engine_src


# ─── 5. FlagOverrideStore — real wiring ───────────────────────────────────


def test_flag_override_consults_registry(exec_engine_src: str) -> None:
    assert "EdogQaCapabilityRegistry.IsFlagOverrideSupported" in exec_engine_src


def test_flag_override_throws_unavailable(exec_engine_src: str) -> None:
    assert "throw new FlagOverrideUnavailableException(" in exec_engine_src


def test_flag_override_pushes_to_real_store(exec_engine_src: str) -> None:
    """The accepted path pushes through EdogFeatureOverrideStore.MergeOverrides
    — the actual wiring that makes flag-override scenarios real tests."""
    assert "EdogFeatureOverrideStore.MergeOverrides(" in exec_engine_src


def test_flag_override_teardown_calls_remove(exec_engine_src: str) -> None:
    """Per-scenario teardown removes only this scenario's keys."""
    assert "EdogFeatureOverrideStore.RemoveOverrides(" in exec_engine_src


def test_flag_override_applied_counter(exec_engine_src: str) -> None:
    assert "EdogQaTelemetry.IncrementFlagOverrideApplied()" in exec_engine_src


def test_flag_override_restored_counter(exec_engine_src: str) -> None:
    assert "EdogQaTelemetry.IncrementFlagOverrideRestored()" in exec_engine_src


def test_flag_override_unavailable_counter(exec_engine_src: str) -> None:
    assert "EdogQaTelemetry.IncrementFlagOverrideUnavailable()" in exec_engine_src


# ─── 6. Setup loop catches the new exceptions specifically ────────────────


def test_setup_loop_catches_chaos_unavailable(exec_engine_src: str) -> None:
    assert "catch (ChaosUnavailableException" in exec_engine_src


def test_setup_loop_catches_flag_override_unavailable(exec_engine_src: str) -> None:
    assert "catch (FlagOverrideUnavailableException" in exec_engine_src


def test_setup_loop_emits_stable_error_codes(exec_engine_src: str) -> None:
    """The Skipped verdict's ErrorMessage starts with the stable code so
    the studio UI can grep for it without parsing prose."""
    assert "EdogQaCapabilityRegistry.ErrorCodeChaosUnavailable" in exec_engine_src
    assert "EdogQaCapabilityRegistry.ErrorCodeFlagOverrideUnavailable" in exec_engine_src


def test_setup_loop_increments_skipped_for_capability(exec_engine_src: str) -> None:
    """Each capability-driven skip increments the dedicated counter so the
    studio can distinguish capability skips from other Skipped verdicts."""
    assert "EdogQaTelemetry.IncrementScenariosSkippedForCapability()" in exec_engine_src


# ─── 7. Hub QaGetCapabilities + wire POCO ─────────────────────────────────


@pytest.fixture(scope="module")
def hub_src() -> str:
    return _read(HUB)


def test_hub_exposes_capabilities_method(hub_src: str) -> None:
    assert "public Task<QaCapabilityReport> QaGetCapabilities()" in hub_src
    assert "EdogQaCapabilityRegistry.BuildReport()" in hub_src


@pytest.fixture(scope="module")
def models_src() -> str:
    return _read(SIGNALR_MODELS)


def test_capability_report_poco(models_src: str) -> None:
    assert "public sealed class QaCapabilityReport" in models_src


@pytest.mark.parametrize(
    "field",
    [
        "public DateTimeOffset CapturedAt",
        "public bool FlagOverrideSupported",
        "public bool FlagOverrideForceOffSupported",
        "public string FlagOverrideReason",
        "public bool HttpChaosSupported",
        "public string HttpChaosReason",
        "public List<string> SupportedChaosFaults",
    ],
)
def test_capability_report_field(models_src: str, field: str) -> None:
    assert field in models_src


# ─── 8. Stage-1 honesty gate: chaos pipeline not yet wired ────────────────


def test_chaos_pipeline_wire_gate_constant(registry_src: str) -> None:
    """Stage 2 has shipped: EdogHttpPipelineHandler now consults
    EdogHttpFaultStore.TryMatchFault. The wire-gate constant must be
    true so IsChaosFaultSupported can authorise chaos rules when the
    runtime env var (EDOG_QA_CHAOS_HTTP=1) is set.

    Stage 1 set this to false to prevent silent-pass while the pipeline
    was un-wired. Flipping back to false in a future build would
    automatically reactivate the honesty refusal — that property is
    pinned by ``test_chaos_support_short_circuits_on_pipeline_wire``.
    """
    assert "private const bool HttpChaosPipelineWired = true;" in registry_src, (
        "Stage 2 must set HttpChaosPipelineWired=true so chaos rules can be honoured when EDOG_QA_CHAOS_HTTP=1."
    )


def test_chaos_support_short_circuits_on_pipeline_wire(registry_src: str) -> None:
    """IsChaosFaultSupported checks HttpChaosPipelineWired before the env
    var, so flipping EDOG_QA_CHAOS_HTTP=1 in a Stage-1 build cannot
    re-enable silent passes."""
    body = registry_src.split("IsChaosFaultSupported(", 1)[1]
    body = body.split("public static", 1)[0]
    assert "HttpChaosPipelineWired" in body, "IsChaosFaultSupported must consult HttpChaosPipelineWired in its body"
    # The pipeline check must precede the env-var check; otherwise the env
    # var alone would gate support, which is the regression we're guarding.
    wire_idx = body.find("HttpChaosPipelineWired")
    env_idx = body.find("IsHttpChaosBackendEnabled")
    assert 0 <= wire_idx < env_idx, (
        "HttpChaosPipelineWired guard must come BEFORE IsHttpChaosBackendEnabled "
        "in IsChaosFaultSupported so the wire-gate cannot be bypassed by env var."
    )


def test_chaos_unavailable_reason_mentions_pipeline(registry_src: str) -> None:
    """The Skipped scenario's ErrorMessage must tell the user the truth:
    Stage 2 is missing. 'env var off' alone is misleading because flipping
    it would not help."""
    assert "Stage" in registry_src and "pipeline" in registry_src.lower(), (
        "GetChaosUnavailableReason should mention the missing pipeline / Stage 2"
    )


# ─── 9. Flag teardown preserves pre-existing dev-server overrides ────────


def test_flag_apply_snapshots_prior_value(exec_engine_src: str) -> None:
    """Before merging the scenario's override, capture whether the key
    already had a value in EdogFeatureOverrideStore. The snapshot is
    consulted at teardown to avoid wiping externally-owned overrides."""
    assert "EdogFeatureOverrideStore.TryGet(" in exec_engine_src, (
        "ApplyOverrideAsync must call EdogFeatureOverrideStore.TryGet to "
        "capture pre-existing state before MergeOverrides."
    )


def test_flag_entry_stores_original_value(exec_engine_src: str) -> None:
    """FlagOverrideEntry must persist the prior state so teardown can
    decide whether the key was scenario-owned or externally-owned."""
    assert "OriginalValue = hadPriorOverride" in exec_engine_src, (
        "FlagOverrideEntry.OriginalValue must be populated at Setup time "
        "from the snapshot captured via EdogFeatureOverrideStore.TryGet."
    )


def test_flag_teardown_preserves_external_overrides(exec_engine_src: str) -> None:
    """ClearOverridesForScenarioAsync must skip keys where OriginalValue is
    set — those were owned by the dev-server control plane or a prior
    scenario, and QA must not wipe them."""
    # Find the METHOD DEFINITION (not the call sites).
    sig = "public Task ClearOverridesForScenarioAsync(string scenarioId)"
    clear_idx = exec_engine_src.find(sig)
    assert clear_idx > 0, f"Method definition not found: {sig}"
    body = exec_engine_src[clear_idx : clear_idx + 4000]
    assert "OriginalValue" in body, (
        "ClearOverridesForScenarioAsync must read OriginalValue to decide "
        "whether to remove a key or leave it for its external owner."
    )
    assert "HasValue" in body, "Teardown should branch on OriginalValue.HasValue (pre-existing ⇒ preserve)."


# ─── 10. Stage 2 — EdogHttpPipelineHandler wires chaos fault store ────────


PIPELINE_HANDLER = DEVMODE / "EdogHttpPipelineHandler.cs"


@pytest.fixture(scope="module")
def pipeline_src() -> str:
    return _read(PIPELINE_HANDLER)


def test_pipeline_consults_fault_store(pipeline_src: str) -> None:
    """SendAsync must consult EdogHttpFaultStore.TryMatchFault BEFORE
    forwarding to base.SendAsync. This is the contract that converts a
    QA chaos rule into observable behaviour."""
    assert "EdogHttpFaultStore.TryMatchFault" in pipeline_src, (
        "EdogHttpPipelineHandler.SendAsync must consult the QA fault store."
    )
    # Wire check must precede the base call so the synthesise/delay/throw
    # branches can pre-empt or wrap the upstream invocation.
    tm_idx = pipeline_src.find("EdogHttpFaultStore.TryMatchFault")
    base_idx = pipeline_src.find("base.SendAsync")
    assert 0 <= tm_idx < base_idx, "TryMatchFault must come BEFORE base.SendAsync in SendAsync"


def test_pipeline_synthesises_http_error(pipeline_src: str) -> None:
    """The handler must own a SynthesizeErrorResponse helper that builds
    an HttpResponseMessage from the fault entry — never calling base."""
    assert "SynthesizeErrorResponse" in pipeline_src
    assert "new HttpResponseMessage(" in pipeline_src


def test_pipeline_latency_uses_task_delay(pipeline_src: str) -> None:
    """Latency fault delays via Task.Delay before forwarding."""
    assert "Task.Delay(chaosFault.LatencyMs" in pipeline_src or "Task.Delay(fault.LatencyMs" in pipeline_src, (
        "Latency fault must use Task.Delay with the configured LatencyMs"
    )


def test_pipeline_timeout_throws_task_cancelled(pipeline_src: str) -> None:
    """Timeout fault throws TaskCanceledException so HttpClient surfaces
    the cancellation the same way a real timeout would."""
    assert "throw new TaskCanceledException(" in pipeline_src


def test_pipeline_publishes_chaos_metadata(pipeline_src: str) -> None:
    """The http topic event carries a chaos object so the studio UI can
    highlight synthesised events with their fault family + scenario id.
    The no-fault publish path must NOT include the chaos property so
    existing topic consumers see the same wire shape as before Stage 2."""
    publish_helper_idx = pipeline_src.find("private void PublishHttpEvent")
    assert publish_helper_idx > 0, "PublishHttpEvent helper missing"
    # Narrow to the helper body: closing brace of method comes before the next
    # method definition (CaptureBodyPreview, CaptureHeaders, etc.).
    next_method_idx = pipeline_src.find("\n        private", publish_helper_idx + 50)
    if next_method_idx < 0:
        next_method_idx = pipeline_src.find("\n    }\n}", publish_helper_idx)
    body = pipeline_src[publish_helper_idx:next_method_idx]

    assert "chaos = new" in body, "Fault-matched publish path must attach a chaos metadata object."

    # Locate the else branch of the if (chaosFault != null) dispatch and
    # ensure it does NOT assemble a `chaos = ...` property. This pins the
    # zero-wire-shape-regression guarantee on the no-fault path.
    else_idx = body.find("else")
    assert else_idx > 0, "PublishHttpEvent must dispatch on chaosFault != null"
    else_block = body[else_idx:]
    assert "chaos = " not in else_block, (
        "No-fault publish path must NOT include a `chaos = ...` property — "
        "keep the wire shape identical to the pre-Stage-2 baseline."
    )


# ─── P10 Contract capability events ────────────────────────────────────


def test_capability_mismatch_event_exists() -> None:
    src = (DEVMODE / "EdogQaTelemetry.cs").read_text(encoding="utf-8")
    assert "qa.contract.flt.capability_mismatch" in src


def test_catalog_fetches_capabilities_once_per_run() -> None:
    src = (DEVMODE / "EdogQaContractCatalog.cs").read_text(encoding="utf-8")
    assert "_capabilitiesForRun" in src
