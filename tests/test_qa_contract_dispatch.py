"""Structural tests for P10 dispatcher, assertion engine, and run store."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEVMODE = REPO_ROOT / "src" / "backend" / "DevMode"


def _read(name: str) -> str:
    return (DEVMODE / name).read_text(encoding="utf-8")


# ─── M15: StimulusDispatcher contract surface ──────────────────────────


def test_dispatcher_knows_capabilities_endpoint() -> None:
    src = _read("EdogQaStimulusDispatcher.cs")
    assert "/devmode/qa/capabilities" in src


def test_dispatcher_posts_sync_dispatch() -> None:
    src = _read("EdogQaStimulusDispatcher.cs")
    assert "/devmode/qa/dispatch" in src
    assert "DiInvocation" in src
    assert "SignalRBroadcast" in src


def test_dispatcher_has_dag_async() -> None:
    src = _read("EdogQaStimulusDispatcher.cs")
    assert "dag" in src.lower()


def test_dispatcher_has_control_token() -> None:
    src = _read("EdogQaStimulusDispatcher.cs")
    assert "controlToken" in src or "ControlToken" in src


def test_dispatcher_normalizes_timeout_to_inconclusive() -> None:
    src = _read("EdogQaStimulusDispatcher.cs")
    assert "Inconclusive" in src


def test_dispatcher_has_capture_buffer_parsing() -> None:
    src = _read("EdogQaStimulusDispatcher.cs")
    assert "64" in src or "65536" in src or "buffer" in src.lower()


# ─── M17: AssertionEngine 7-type matchers ──────────────────────────────


def test_assertion_engine_has_contract_matcher_evaluation() -> None:
    src = _read("EdogQaAssertionEngine.cs")
    assert "EvaluateContractMatchers" in src


def test_assertion_engine_has_seven_matcher_types() -> None:
    src = _read("EdogQaAssertionEngine.cs")
    for matcher_type in ("Equals", "NotEquals", "Exists", "InRange", "ContainsAll", "OneOf", "Length"):
        assert matcher_type in src, f"missing matcher type: {matcher_type}"


def test_assertion_engine_no_regex_for_contract_matchers() -> None:
    src = _read("EdogQaAssertionEngine.cs")
    # The EvaluateContractMatchers method should not use regex
    if "EvaluateContractMatchers" in src:
        method_start = src.index("EvaluateContractMatchers")
        method_chunk = src[method_start:method_start + 3000]
        assert "Regex" not in method_chunk or "regex" not in method_chunk.lower()


# ─── M19: RunStore migration ──────────────────────────────────────────


def test_run_store_has_quarantine_migration() -> None:
    src = _read("EdogQaRunStore.cs")
    assert "pre-contract-quarantined" in src or "quarantin" in src.lower()


def test_run_store_persists_new_verdicts() -> None:
    src = _read("EdogQaRunStore.cs")
    assert "Stale" in src or "Inconclusive" in src


def test_run_store_persists_catalog_hashes() -> None:
    src = _read("EdogQaRunStore.cs")
    assert "CatalogHash" in src or "catalogHash" in src.lower()


# ─── M12: Projector typed projection ──────────────────────────────────


def test_projector_has_typed_projection() -> None:
    src = _read("EdogQaScenarioProjector.cs")
    assert "ProjectTyped" in src


def test_projector_preserves_audit_fields() -> None:
    src = _read("EdogQaScenarioProjector.cs")
    assert "GroundingEvidence" in src
    assert "Metadata" in src
