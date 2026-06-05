"""
EdogHttpFaultStore — structural tests for error simulator extensions.

Verifies node-scoped fault matching, mutable FaultRuleState,
and error-sim-specific CRUD methods.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
FAULT_STORE = REPO / "src" / "backend" / "DevMode" / "EdogHttpFaultStore.cs"
PIPELINE = REPO / "src" / "backend" / "DevMode" / "EdogHttpPipelineHandler.cs"


@pytest.fixture(scope="module")
def store_source():
    assert FAULT_STORE.exists()
    return FAULT_STORE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def pipeline_source():
    assert PIPELINE.exists()
    return PIPELINE.read_text(encoding="utf-8")


class TestFaultEntryExtensions:
    def test_node_id_field(self, store_source):
        assert "public string NodeId" in store_source

    def test_rule_id_field(self, store_source):
        assert "public string RuleId" in store_source


class TestFaultRuleState:
    def test_class_exists(self, store_source):
        assert "class FaultRuleState" in store_source

    def test_enabled_field(self, store_source):
        assert "volatile bool Enabled" in store_source

    def test_fire_count_field(self, store_source):
        assert "int FireCount" in store_source

    def test_rule_states_dictionary(self, store_source):
        assert "ConcurrentDictionary<string, FaultRuleState>" in store_source


class TestTryMatchFaultNodeScoping:
    def test_reads_async_local(self, store_source):
        # TryMatchFault must read EdogNodeExecutionContext.Current
        match = re.search(r"TryMatchFault.*?\{", store_source, re.DOTALL)
        assert match
        body_start = match.end()
        body = store_source[body_start : body_start + 2000]
        assert "EdogNodeExecutionContext.Current" in body, "TryMatchFault must read AsyncLocal node context"

    def test_checks_node_id(self, store_source):
        assert "rule.NodeId" in store_source, "TryMatchFault must check rule.NodeId for node scoping"

    def test_checks_enabled(self, store_source):
        assert "state.Enabled" in store_source or "Enabled" in store_source, (
            "TryMatchFault must check FaultRuleState.Enabled"
        )

    def test_reads_current_node_name_for_fallback(self, store_source):
        # Defensive: the frontend sends Guid as rule.NodeId, and the AsyncLocal
        # NodeId is the Guid string (post Bug A fix). But if a manual hub
        # caller or legacy code sends a display name as rule.NodeId, the
        # exact Guid equality would silently no-op. The fallback compares
        # rule.NodeId against the current NodeName too, so a name-based
        # rule still fires. Better to over-match a known rule than to
        # silently drop it.
        match = re.search(r"TryMatchFault.*?return\s+false;\s*\}", store_source, re.DOTALL)
        assert match, "Could not isolate TryMatchFault body"
        body = match.group(0)
        assert "currentNodeName" in body, (
            "TryMatchFault must read nodeCtx?.NodeName so name-vs-guid "
            "drift doesn't silently break node-targeted rules."
        )
        assert re.search(
            r"string\.Equals\s*\(\s*rule\.NodeId\s*,\s*currentNodeName",
            body,
        ), "Defensive Name fallback must compare rule.NodeId against currentNodeName"


class TestErrorSimCrudMethods:
    def test_add_error_sim_rule(self, store_source):
        assert "AddErrorSimRule" in store_source

    def test_remove_error_sim_rule(self, store_source):
        assert "RemoveErrorSimRule" in store_source

    def test_clear_error_sim_rules(self, store_source):
        assert "ClearErrorSimRules" in store_source

    def test_get_rule_state(self, store_source):
        assert "GetRuleState" in store_source


class TestPipelineJsonContentType:
    def test_synthesize_uses_json(self, pipeline_source):
        assert "application/json" in pipeline_source, "SynthesizeErrorResponse must use application/json content type"
