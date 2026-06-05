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


class TestArmedFaultLookup:
    """``HasArmedFaultForNode`` powers the file-sourced force-FULL patch.

    The patch in ``apply_file_sourced_force_full_patch`` calls this method to
    decide whether to bypass change detection and force a GTS submit. Strict
    filtering matters: a Channel 3 rule (pre-GTS reflection) or a chaos rule
    must NOT pull the file-sourced executor onto the FULL path — those rules
    don't depend on a /customTransformExecution call to fire.
    """

    def test_method_exists(self, store_source):
        assert "public static bool HasArmedFaultForNode" in store_source

    def test_takes_node_id_string(self, store_source):
        assert "HasArmedFaultForNode(string nodeId)" in store_source

    def test_filters_by_error_sim_scenario(self, store_source):
        # Only error-sim-scenario rules should count — chaos/QA rules that
        # happen to be node-scoped must not poison the file-sourced check.
        match = re.search(
            r"HasArmedFaultForNode\s*\([^)]*\)\s*\{.*?return\s+(?:true|false);\s*\}",
            store_source,
            re.DOTALL,
        )
        assert match, "Could not isolate HasArmedFaultForNode body"
        body = match.group(0)
        assert '"error-sim"' in body, (
            "HasArmedFaultForNode must restrict the scan to ScenarioId == 'error-sim' — "
            "otherwise chaos/QA rules would force unnecessary FULL refreshes."
        )

    def test_filters_by_custom_transform_target(self, store_source):
        match = re.search(
            r"HasArmedFaultForNode\s*\([^)]*\)\s*\{.*?return\s+(?:true|false);\s*\}",
            store_source,
            re.DOTALL,
        )
        assert match
        body = match.group(0)
        assert "customTransformExecution" in body, (
            "Must filter to rules whose TargetSubstring contains "
            "'customTransformExecution' — that's the only GTS endpoint the "
            "force-FULL trick can deliver to."
        )

    def test_checks_enabled_state(self, store_source):
        match = re.search(
            r"HasArmedFaultForNode\s*\([^)]*\)\s*\{.*?return\s+(?:true|false);\s*\}",
            store_source,
            re.DOTALL,
        )
        assert match
        body = match.group(0)
        assert "Enabled" in body, (
            "Disabled rules must not count as armed — otherwise toggling a "
            "rule off wouldn't disarm the file-sourced force-FULL behaviour."
        )

    def test_null_safe(self, store_source):
        # Defensive: file-sourced path passes node.NodeId.ToString() which is
        # never null in practice, but a null check prevents NREs from
        # bubbling into FLT's node executor.
        match = re.search(
            r"HasArmedFaultForNode\s*\([^)]*\)\s*\{[^}]*",
            store_source,
            re.DOTALL,
        )
        assert match
        body = match.group(0)
        assert "IsNullOrEmpty(nodeId)" in body, (
            "HasArmedFaultForNode must short-circuit on null/empty nodeId."
        )


class TestGetMatchCount:
    """``GetMatchCount`` is the source of truth for OnNodeExecutionCompleted.

    The engine uses it to decide whether a rule matched (count > 0) or not,
    and publishes the count back to the frontend so the pill can show
    "Fired xN" for rules that match multiple times in one iteration.
    """

    def test_method_exists(self, store_source):
        assert "public static int GetMatchCount" in store_source

    def test_takes_rule_id_string(self, store_source):
        assert "GetMatchCount(string ruleId)" in store_source

    def test_uses_volatile_read(self, store_source):
        # FireCount is mutated by HTTP pipeline threads using Interlocked.
        # GetMatchCount must use Volatile.Read for a memory-safe read.
        match = re.search(
            r"GetMatchCount\s*\([^)]*\)\s*\{.*?return\s+[^;]+;\s*\}",
            store_source,
            re.DOTALL,
        )
        assert match
        body = match.group(0)
        assert "Volatile.Read" in body, (
            "GetMatchCount must use Volatile.Read on FireCount — plain reads "
            "can return stale values across threads on weak-memory-model CPUs."
        )

    def test_null_safe(self, store_source):
        match = re.search(
            r"GetMatchCount\s*\([^)]*\)\s*\{[^}]*",
            store_source,
            re.DOTALL,
        )
        assert match
        body = match.group(0)
        assert "IsNullOrEmpty(ruleId)" in body


class TestPipelineJsonContentType:
    def test_synthesize_uses_json(self, pipeline_source):
        assert "application/json" in pipeline_source, "SynthesizeErrorResponse must use application/json content type"
