"""F27 P0 — Telemetry & observability foundation shape tests.

These tests pin the observability surface added in P0 of the F27 production-
readiness plan. They are *structural* (regex over C# / JS sources) — runtime
behaviour is exercised by the integration tests added in P3.

Tests in this module assert:
1. ``EdogQaTelemetry`` static class exists with every required counter and
   the Increment helpers, plus ``Snapshot`` / ``ResetForTesting`` entry points.
2. ``QaTelemetrySnapshot`` POCO is defined in ``QaSignalRModels.cs`` with one
   property per counter so the wire payload is stable.
3. The ``QaGetTelemetry`` hub method is exposed by ``EdogPlaygroundHub``.
4. Every one of the six fallback sites identified in the F27 audit
   increments the matching telemetry counter.
5. The synthetic-scenarios fallback in ``EdogPlaygroundHub`` emits an explicit
   ``QaAnalysisWarning`` SignalR event with warning code
   ``synthetic_scenarios_used`` BEFORE the synthetic generator is invoked.
6. The stub-provider degradation flags (``stub_llm_provider_active``,
   ``stub_omnisharp_provider_active``, ``stub_graph_provider_active``) are
   added to ``AnalysisResult.DegradationFlags`` at the top of
   ``AnalyzeInternalAsync`` so the existing warning emitter surfaces them.
7. The frontend curation UI renders a ``PLACEHOLDER`` badge for scenarios
   whose ``metadata.generatedBy`` is ``stub_llm`` or ``synthetic``.
8. ``StubLlmProvider`` truthfully tags its scenarios with
   ``GeneratedBy = "stub_llm"`` (the previous value, ``"ai"``, was a lie).
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEVMODE = ROOT / "src" / "backend" / "DevMode"
FRONTEND_JS = ROOT / "src" / "frontend" / "js"
FRONTEND_CSS = ROOT / "src" / "frontend" / "css"

TELEMETRY = DEVMODE / "EdogQaTelemetry.cs"
SIGNALR_MODELS = DEVMODE / "QaSignalRModels.cs"
HUB = DEVMODE / "EdogPlaygroundHub.cs"
ANALYZER = DEVMODE / "EdogQaCodeAnalyzer.cs"
EXEC_ENGINE = DEVMODE / "EdogQaExecutionEngine.cs"
LLM_PROVIDER = DEVMODE / "EdogQaLlmProvider.cs"
QA_CURATION = FRONTEND_JS / "qa-curation.js"
QA_PANEL_CSS = FRONTEND_CSS / "qa-panel.css"


def _read(path: Path) -> str:
    assert path.exists(), f"Expected file does not exist: {path}"
    return path.read_text(encoding="utf-8")


# ─── 1. EdogQaTelemetry surface ───────────────────────────────────────────

REQUIRED_COUNTERS = [
    "SyntheticScenariosFallback",
    "StubLlmProviderCall",
    "StubOmniSharpProviderCall",
    "StubGraphProviderCall",
    "GraphStubConnectivityEdge",
    "ChaosNoOp",
    "FlagOverrideNoOp",
    "LlmCall",
    "LlmError",
    "AnalysisStarted",
    "AnalysisCompleted",
    "RunStarted",
    "RunCompleted",
    # F27 P5 — capability counters (added when chaos/flag wiring stopped
    # silently passing scenarios that needed unavailable primitives).
    "FlagOverrideApplied",
    "FlagOverrideRestored",
    "FlagOverrideUnavailable",
    "ChaosApplied",
    "ChaosUnavailable",
    "ScenariosSkippedForCapability",
]


@pytest.fixture(scope="module")
def telemetry_src() -> str:
    return _read(TELEMETRY)


@pytest.mark.parametrize("counter", REQUIRED_COUNTERS)
def test_telemetry_increment_helper_defined(telemetry_src: str, counter: str) -> None:
    """Each counter has a public Increment{Name} helper using Interlocked."""
    helper = f"Increment{counter}"
    assert helper in telemetry_src, f"Missing Increment helper: {helper}"


def test_telemetry_uses_interlocked(telemetry_src: str) -> None:
    """Counters must be incremented via Interlocked for thread safety."""
    assert "Interlocked.Increment" in telemetry_src
    assert "Interlocked.Read" in telemetry_src
    assert "using System.Threading" in telemetry_src


def test_telemetry_snapshot_and_reset(telemetry_src: str) -> None:
    """Snapshot returns QaTelemetrySnapshot; ResetForTesting clears state."""
    assert "public static QaTelemetrySnapshot Snapshot()" in telemetry_src
    assert "public static void ResetForTesting()" in telemetry_src
    # Reset must clear every counter.
    for counter in REQUIRED_COUNTERS:
        field = f"_{counter[0].lower()}{counter[1:]}Count"
        assert field in telemetry_src, f"Reset must touch field {field}"


# ─── 2. QaTelemetrySnapshot wire model ────────────────────────────────────


@pytest.fixture(scope="module")
def models_src() -> str:
    return _read(SIGNALR_MODELS)


def test_snapshot_poco_defined(models_src: str) -> None:
    assert "public sealed class QaTelemetrySnapshot" in models_src
    assert "public DateTimeOffset StartedAt" in models_src
    assert "public DateTimeOffset CapturedAt" in models_src


@pytest.mark.parametrize("counter", REQUIRED_COUNTERS)
def test_snapshot_poco_carries_counter(models_src: str, counter: str) -> None:
    """Every counter must be serialised so the studio UI can render it."""
    prop = f"public long {counter}Count"
    assert prop in models_src, f"Missing wire property: {prop}"


# ─── 3. QaGetTelemetry hub method ─────────────────────────────────────────


@pytest.fixture(scope="module")
def hub_src() -> str:
    return _read(HUB)


def test_qa_get_telemetry_hub_method(hub_src: str) -> None:
    assert "public Task<QaTelemetrySnapshot> QaGetTelemetry()" in hub_src
    assert "EdogQaTelemetry.Snapshot()" in hub_src


# ─── 4. Telemetry hooks at all six fallback sites ─────────────────────────


def test_synthetic_fallback_increments_counter(hub_src: str) -> None:
    """The synthetic-scenarios fallback site fires the counter."""
    assert "EdogQaTelemetry.IncrementSyntheticScenariosFallback()" in hub_src


def test_run_lifecycle_counters(hub_src: str) -> None:
    """QaStartRun should increment RunStarted; the Task.Run finally must
    increment RunCompleted."""
    assert "EdogQaTelemetry.IncrementRunStarted()" in hub_src
    assert "EdogQaTelemetry.IncrementRunCompleted()" in hub_src


@pytest.fixture(scope="module")
def analyzer_src() -> str:
    return _read(ANALYZER)


def test_stub_graph_provider_increments(analyzer_src: str) -> None:
    """StubGraphProvider increments both the call counter and the fake-edge
    counter so the studio can quantify how much of the graph is fabricated."""
    assert "EdogQaTelemetry.IncrementStubGraphProviderCall()" in analyzer_src
    assert "EdogQaTelemetry.IncrementGraphStubConnectivityEdge()" in analyzer_src


def test_stub_omnisharp_increments(analyzer_src: str) -> None:
    assert "EdogQaTelemetry.IncrementStubOmniSharpProviderCall()" in analyzer_src


def test_stub_llm_increments(analyzer_src: str) -> None:
    assert "EdogQaTelemetry.IncrementStubLlmProviderCall()" in analyzer_src


def test_analyzer_tracks_llm_call_and_error(analyzer_src: str) -> None:
    """Real LLM attempts (including the single retry) must be counted, and
    every failed attempt must increment the error counter."""
    assert analyzer_src.count("EdogQaTelemetry.IncrementLlmCall()") >= 2
    assert analyzer_src.count("EdogQaTelemetry.IncrementLlmError()") >= 2


def test_analyzer_lifecycle_counters(analyzer_src: str) -> None:
    assert "EdogQaTelemetry.IncrementAnalysisStarted()" in analyzer_src
    assert "EdogQaTelemetry.IncrementAnalysisCompleted()" in analyzer_src


@pytest.fixture(scope="module")
def exec_engine_src() -> str:
    return _read(EXEC_ENGINE)


def test_chaos_stub_increments(exec_engine_src: str) -> None:
    """ChaosIntegration.ApplyChaosRuleAsync refuses unsupported chaos rules
    via ChaosUnavailableException (P5). The legacy NoOp counter still fires
    on the refusal path so users see "the request was a no-op" — but the
    engine no longer silently proceeds: the scenario is marked Skipped."""
    assert "EdogQaTelemetry.IncrementChaosNoOp()" in exec_engine_src


def test_flag_override_stub_increments(exec_engine_src: str) -> None:
    """FlagOverrideStore.ApplyOverrideAsync still fires the legacy NoOp
    counter on the refusal path (force-OFF in V1). The accepted path now
    pushes through EdogFeatureOverrideStore.MergeOverrides — verified by
    test_qa_capabilities.test_flag_override_pushes_to_real_store."""
    assert "EdogQaTelemetry.IncrementFlagOverrideNoOp()" in exec_engine_src


@pytest.fixture(scope="module")
def llm_provider_src() -> str:
    return _read(LLM_PROVIDER)


def test_llm_provider_tracks_errors(llm_provider_src: str) -> None:
    """The unconfigured and exception paths both increment LlmError so a
    misconfigured Azure OpenAI deployment is visible in the snapshot."""
    assert llm_provider_src.count("EdogQaTelemetry.IncrementLlmError()") >= 2


# ─── 5. Synthetic fallback emits explicit warning ─────────────────────────


def test_synthetic_fallback_broadcasts_warning(hub_src: str) -> None:
    """The synthetic fallback must broadcast QaAnalysisWarning BEFORE calling
    the synthetic generator so the studio UI shows a degradation banner."""
    # The warning code is the contract the frontend will key off.
    assert "synthetic_scenarios_used" in hub_src
    # Sanity: the warning event uses the standard broadcaster.
    assert 'BroadcastQaEventAsync("QaAnalysisWarning"' in hub_src


# ─── 6. Stub providers surface as DegradationFlags ────────────────────────


@pytest.mark.parametrize(
    "flag",
    [
        "stub_graph_provider_active",
        "stub_omnisharp_provider_active",
        "stub_llm_provider_active",
    ],
)
def test_stub_provider_degradation_flag(analyzer_src: str, flag: str) -> None:
    """AnalyzeInternalAsync detects each stub provider and pushes a
    DegradationFlag — those flags ride the existing QaAnalysisWarning emitter
    in EdogPlaygroundHub:1109+ so the studio UI surfaces them automatically.
    """
    assert flag in analyzer_src


# ─── 7. Frontend PLACEHOLDER badge for stub/synthetic scenarios ───────────


def test_curation_renders_placeholder_badge() -> None:
    src = _read(QA_CURATION)
    assert "qa-placeholder-badge" in src
    # Both fallback origins must show the badge.
    assert "stub_llm" in src
    assert "synthetic" in src
    assert "PLACEHOLDER" in src


def test_placeholder_badge_styled() -> None:
    css = _read(QA_PANEL_CSS)
    assert ".qa-placeholder-badge" in css


# ─── 8. StubLlmProvider truthfully tags its output ────────────────────────


def test_stub_llm_provider_tags_generated_by_stub(analyzer_src: str) -> None:
    """StubLlmProvider must not claim its scenarios were generated by 'ai'.
    The metadata badge in qa-curation.js keys off this exact string."""
    # Pull just the StubLlmProvider class block to scope the assertion.
    marker = "public sealed class StubLlmProvider"
    start = analyzer_src.index(marker)
    end = analyzer_src.find("public sealed class", start + 1)
    block = analyzer_src[start : end if end != -1 else len(analyzer_src)]
    assert 'GeneratedBy = "stub_llm"' in block
    assert 'GeneratedBy = "ai"' not in block
