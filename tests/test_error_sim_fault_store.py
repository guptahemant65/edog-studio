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


# ──────────────────────────────────────────────────────────────────────
# ADR-008 SPARK FAULT HELPERS
# ──────────────────────────────────────────────────────────────────────
#
# TryPeekSparkFault + IncrementMatchCount are the API surface
# EdogSparkClientWrapper consumes. They split the "look up + record"
# operation that HasArmedFaultForNode performs in one shot, because
# the wrapper needs to peek FIRST (it dispatches by Fault + StatusCode)
# and record SECOND (only after the synthetic response is built).


class TestSparkFaultHelpers:
    def test_try_peek_method_declared(self, store_source):
        assert re.search(
            r"public\s+static\s+bool\s+TryPeekSparkFault\s*\(\s*string\s+nodeId\s*,"
            r"\s*out\s+HttpFaultEntry\s+match\s*\)",
            store_source,
        ), "TryPeekSparkFault must be `public static bool TryPeekSparkFault(string nodeId, out HttpFaultEntry match)`"

    def test_try_peek_filters_by_error_sim_scenario(self, store_source):
        body = _extract_method_body(store_source, "TryPeekSparkFault")
        assert 'ScenarioId != "error-sim"' in body, (
            "TryPeekSparkFault must only match rules registered by the Error "
            "Code Simulator scenario — never global/HTTP-pipeline rules."
        )

    def test_try_peek_filters_by_customTransformExecution_target(self, store_source):
        body = _extract_method_body(store_source, "TryPeekSparkFault")
        assert "customTransformExecution" in body, (
            "TryPeekSparkFault must only match GTS transform-execution rules — "
            "the ISparkClient layer doesn't intercept other GTS endpoints."
        )

    def test_try_peek_filters_by_node_id_match(self, store_source):
        body = _extract_method_body(store_source, "TryPeekSparkFault")
        assert "StringComparison.OrdinalIgnoreCase" in body
        assert "rule.NodeId" in body

    def test_try_peek_respects_rule_state_enabled_flag(self, store_source):
        body = _extract_method_body(store_source, "TryPeekSparkFault")
        assert "_ruleStates" in body
        assert "Enabled" in body, (
            "TryPeekSparkFault must skip disabled rules — toggling a rule off "
            "in the studio must immediately disarm it."
        )

    def test_try_peek_does_not_increment_fire_count(self, store_source):
        # Peek semantics: SEPARATES lookup from accounting. The wrapper's
        # IncrementMatchCount call is the only path that may bump FireCount
        # via this helper pair — TryPeekSparkFault itself must be side-
        # effect-free so callers can decide whether to fire.
        body = _extract_method_body(store_source, "TryPeekSparkFault")
        assert "Interlocked.Increment" not in body
        assert "FireCount" not in body, (
            "TryPeekSparkFault is a PEEK — it must not mutate FireCount. "
            "Callers (e.g. EdogSparkClientWrapper) bump the counter via "
            "IncrementMatchCount only after the synthetic response is built."
        )

    def test_try_peek_null_safe(self, store_source):
        body = _extract_method_body(store_source, "TryPeekSparkFault")
        assert "IsNullOrEmpty(nodeId)" in body

    def test_increment_method_declared(self, store_source):
        assert re.search(
            r"public\s+static\s+void\s+IncrementMatchCount\s*\(\s*string\s+ruleId\s*\)",
            store_source,
        ), "IncrementMatchCount must be `public static void IncrementMatchCount(string ruleId)`"

    def test_increment_uses_interlocked(self, store_source):
        body = _extract_method_body(store_source, "IncrementMatchCount")
        assert "Interlocked.Increment" in body, (
            "IncrementMatchCount must use Interlocked — fire counts must be "
            "thread-safe under concurrent submits."
        )
        assert "FireCount" in body

    def test_increment_null_safe(self, store_source):
        body = _extract_method_body(store_source, "IncrementMatchCount")
        assert "IsNullOrEmpty(ruleId)" in body, (
            "IncrementMatchCount must short-circuit on null/empty ruleId — "
            "rules sourced from legacy files may lack an ID."
        )


def _extract_method_body(source: str, name: str) -> str:
    """Brace-balanced extraction of a named method body."""
    pattern = re.compile(rf"(?:public|private|internal)\s+(?:static\s+)?[^\n(]*?\b{name}\s*\(")
    match = pattern.search(source)
    assert match, f"Method {name} not found"
    start = source.find("{", match.end())
    assert start >= 0
    depth = 0
    i = start
    while i < len(source):
        c = source[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
        i += 1
    raise AssertionError(f"Unbalanced braces in {name}")
