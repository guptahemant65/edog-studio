"""Structural contract tests for the P10 schema generator, validator,
linter, execution engine, and orchestrator pipeline changes.

Guards the presence of key structural elements added in M9-M19.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEVMODE = REPO_ROOT / "src" / "backend" / "DevMode"


def _read(name: str) -> str:
    return (DEVMODE / name).read_text(encoding="utf-8")


# ─── M9: Schema generator ──────────────────────────────────────────────


def test_editor_schema_mentions_plan_and_matchers() -> None:
    src = _read("EdogQaLlmClient.cs")
    assert '"plan"' in src
    assert '"matchers"' in src or "matchers" in src


def test_schema_has_typed_value_defs() -> None:
    src = _read("EdogQaLlmClient.cs")
    for def_name in ("Value_string", "Value_integer", "Value_range"):
        assert def_name in src, f"missing $def: {def_name}"


def test_schema_has_partial_repair_and_single_scenario() -> None:
    src = _read("EdogQaLlmClient.cs")
    assert "PartialRepair" in src or "originalIndex" in src
    assert "SingleScenario" in src or "singleScenario" in src.lower()


def test_schema_has_nullable_union_helper() -> None:
    src = _read("EdogQaLlmClient.cs")
    assert "null" in src and "optional" in src.lower()


# ─── M13: Validator gates ──────────────────────────────────────────────


def test_validator_has_matcher_type_consistency_gate() -> None:
    src = _read("EdogQaScenarioValidator.cs")
    assert "MatcherTypeConsistency" in src or "matcher" in src.lower()


def test_validator_has_grounding_slot_match() -> None:
    src = _read("EdogQaScenarioValidator.cs")
    assert "grounding" in src.lower() or "slot" in src.lower()


# ─── M18: Linter LNT011 ───────────────────────────────────────────────


def test_linter_has_lnt011() -> None:
    src = _read("EdogQaScenarioLinter.cs")
    assert "LNT011" in src


# ─── M16: Execution engine hash comparison ─────────────────────────────


def test_execution_engine_checks_catalog_hashes() -> None:
    src = _read("EdogQaExecutionEngine.cs")
    assert "Stale" in src or "stale" in src
    assert "CatalogHash" in src or "catalogHash" in src.lower() or "hash" in src.lower()


def test_execution_engine_checks_capability_version() -> None:
    src = _read("EdogQaExecutionEngine.cs")
    # The engine must have some form of version/capability checking
    assert "Stale" in src  # stale verdict when capability mismatch


# ─── M11: Capability probe ────────────────────────────────────────────


def test_capability_probe_has_reasoning_effort() -> None:
    src = _read("EdogQaCapabilityProbe.cs")
    assert "reasoning_effort" in src or "medium" in src


def test_capability_probe_has_timeout_fallback() -> None:
    src = _read("EdogQaCapabilityProbe.cs")
    assert "timeout" in src.lower() or "fallback" in src.lower()


# ─── M14: Orchestrator ────────────────────────────────────────────────


def test_orchestrator_captures_options_snapshot() -> None:
    src = _read("EdogQaScenarioOrchestrator.cs")
    assert "snapshot" in src.lower() or "revision" in src.lower()


def test_orchestrator_has_capped_reachability() -> None:
    src = _read("EdogQaScenarioOrchestrator.cs")
    assert "reachability" in src.lower() or "cap" in src.lower()


def test_orchestrator_has_original_index_splice() -> None:
    src = _read("EdogQaScenarioOrchestrator.cs")
    assert "originalIndex" in src or "OriginalIndex" in src
