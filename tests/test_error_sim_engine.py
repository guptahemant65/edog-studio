"""
EdogErrorSimEngine — structural tests.

Verifies the engine class exists with the required public surface,
correctly references the underlying fault store, uses reflection for
Channel 3 (pre-GTS) injection, and emits the expected GTS Status
Forge body shape.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
ENGINE = REPO / "src" / "backend" / "DevMode" / "EdogErrorSimEngine.cs"


@pytest.fixture(scope="module")
def source() -> str:
    assert ENGINE.exists(), f"Missing engine file: {ENGINE}"
    return ENGINE.read_text(encoding="utf-8")


class TestClassExists:
    def test_engine_class_declared(self, source: str) -> None:
        assert "class EdogErrorSimEngine" in source

    def test_engine_is_static(self, source: str) -> None:
        assert "static class EdogErrorSimEngine" in source

    def test_namespace(self, source: str) -> None:
        assert "namespace Microsoft.LiveTable.Service.DevMode" in source

    def test_devmode_pragmas(self, source: str) -> None:
        assert "#nullable disable" in source
        assert "#pragma warning disable" in source


class TestRequiredMethods:
    @pytest.mark.parametrize(
        "method",
        [
            "AddRule",
            "RemoveRule",
            "ClearAll",
            "GetActiveRules",
            "ApplyPreGtsFaults",
            "GetCatalogJson",
            "ComputeBlastRadius",
        ],
    )
    def test_method_present(self, source: str, method: str) -> None:
        assert f" {method}(" in source, f"Method {method} not found"


class TestErrorSimRule:
    def test_class_declared(self, source: str) -> None:
        assert "class ErrorSimRule" in source

    @pytest.mark.parametrize(
        "field",
        [
            "RuleId",
            "NodeId",
            "NodeName",
            "NodeKind",
            "ErrorCode",
            "CatalogEntry",
            "CreatedAt",
        ],
    )
    def test_field_present(self, source: str, field: str) -> None:
        assert f"{field} {{ get; init; }}" in source, f"Field {field} missing"


class TestFaultStoreIntegration:
    def test_calls_add_error_sim_rule(self, source: str) -> None:
        assert "EdogHttpFaultStore.AddErrorSimRule(" in source

    def test_calls_remove_error_sim_rule(self, source: str) -> None:
        assert "EdogHttpFaultStore.RemoveErrorSimRule(" in source

    def test_calls_clear_error_sim_rules(self, source: str) -> None:
        assert "EdogHttpFaultStore.ClearErrorSimRules()" in source

    def test_delegates_catalog_json(self, source: str) -> None:
        assert "EdogErrorCodeCatalog.GetCatalogJson()" in source

    def test_looks_up_catalog_by_code(self, source: str) -> None:
        assert "EdogErrorCodeCatalog.GetByCode(" in source


class TestChannelDispatch:
    def test_channel_1_status_forge_body(self, source: str) -> None:
        # Channel 1 builds an HTTP 200 + Failed state JSON body.
        assert '\\"state\\":\\"Failed\\"' in source
        assert '\\"error\\"' in source or '"error"' in source

    def test_channel_1_uses_status_200(self, source: str) -> None:
        # GTS Status Forge fires as http_error with 200 status.
        assert '"http_error", 200' in source

    def test_channel_2_uses_submit_error_body(self, source: str) -> None:
        # Channel 2 wraps the failure in an {"error":{...}} envelope.
        assert '{\\"error\\":{' in source

    def test_channel_3_stored_in_pre_gts_dict(self, source: str) -> None:
        assert "_preGtsRules" in source

    def test_channel_4_uses_timeout_fault(self, source: str) -> None:
        assert '"timeout"' in source

    def test_target_substring_is_custom_transform(self, source: str) -> None:
        assert "customTransformExecution" in source


class TestReflectionUsage:
    def test_uses_reflection_namespace(self, source: str) -> None:
        assert "using System.Reflection;" in source

    def test_uses_get_property(self, source: str) -> None:
        assert "GetProperty(" in source

    def test_uses_set_value(self, source: str) -> None:
        assert "SetValue(" in source

    def test_sets_is_faulted(self, source: str) -> None:
        assert '"IsFaulted"' in source

    def test_sets_flt_error_code(self, source: str) -> None:
        assert '"FLTErrorCode"' in source

    def test_sets_error_message(self, source: str) -> None:
        assert '"ErrorMessage"' in source

    def test_reads_nodes_property(self, source: str) -> None:
        assert '"Nodes"' in source


class TestRuleIdFormat:
    def test_rule_id_prefix(self, source: str) -> None:
        # "esim-" + 8 hex chars of a fresh GUID.
        assert '"esim-"' in source
        assert "Guid.NewGuid()" in source


# ── Bug B coverage: synthetic telemetry for pre-GTS faulted nodes ────────────
#
# When a Channel 3 rule sets node.IsFaulted via reflection, FLT aborts the
# entire DAG (MLV_DAG_HAS_FAULTED_NODES) BEFORE any node executes, so no real
# NodeExecution telemetry is ever emitted for the targeted node. Without a
# synthetic telemetry emit, the frontend leaves the node in 'pending' /
# "Not Started" with no error code — even though the backend correctly
# injected the fault. Tests below pin the synthetic emit at the engine level.


class TestApplyPreGtsFaultsSignature:
    def test_accepts_dag_exec_instance_for_iteration_id(self, source: str) -> None:
        # The engine needs the IterationId off DagExecutionInstance so the
        # synthetic telemetry is iteration-scoped (frontend filters by it).
        assert re.search(
            r"ApplyPreGtsFaults\s*\(\s*object\s+dag\s*,\s*object\s+dagExecInstance",
            source,
        ), (
            "ApplyPreGtsFaults must accept (object dag, object dagExecInstance) — "
            "otherwise the synthetic telemetry cannot stamp the active IterationId "
            "and the frontend filters it out."
        )

    def test_dag_exec_instance_param_is_optional(self, source: str) -> None:
        # Keep it optional so the engine works even if a caller forgets to
        # pass it (defensive — frontend's no-iteration branch still accepts).
        assert re.search(
            r"ApplyPreGtsFaults\s*\([^)]*dagExecInstance\s*=\s*null",
            source,
        ), "dagExecInstance must be optional (default null) for backward compat"

    def test_reads_iteration_id_via_reflection(self, source: str) -> None:
        assert "GetProperty(" in source and '"IterationId"' in source, (
            "Engine must reflect IterationId off dagExecInstance"
        )


class TestSyntheticTelemetryEmit:
    @pytest.fixture(scope="class")
    def inject_body(self, source: str) -> str:
        match = re.search(
            r"private\s+static\s+void\s+InjectNodeFault\s*\([^)]*\)\s*\{",
            source,
        )
        assert match, "InjectNodeFault method not found"
        # Grab a generous slice — InjectNodeFault is ~70 lines after the fix.
        return source[match.start() : match.start() + 5000]

    def test_publishes_to_telemetry_topic(self, source: str) -> None:
        assert 'EdogTopicRouter.Publish("telemetry"' in source, (
            "Engine must publish synthetic NodeExecution telemetry to the "
            "'telemetry' topic — that's the channel the frontend's "
            "ExecutionStateManager subscribes to. Pre-GTS faulted nodes are "
            "invisible in the UI without this — Bug B regression."
        )

    def test_synthetic_event_uses_nodeexecution_activity(self, source: str) -> None:
        assert re.search(
            r'new\s+TelemetryEvent\s*\(\s*[^,]+,\s*"NodeExecution"\s*,\s*"Failed"',
            source,
        ), (
            "Synthetic event must be ActivityName=NodeExecution, ActivityStatus=Failed "
            "— that's the exact shape the frontend's _processNodeTelemetry matches."
        )

    def test_synthetic_emit_wrapped_in_try_catch(self, inject_body: str) -> None:
        # InjectNodeFault must never throw — DAG construction must continue
        # even if synthetic telemetry fails (e.g., missing topic buffer).
        assert "EmitSyntheticNodeFailedTelemetry" in inject_body, (
            "Synthetic emit must be a separate helper for clean try/catch wrapping"
        )

    def test_attributes_carry_both_id_and_name(self, source: str) -> None:
        # Frontend resolves nodes by either NodeId (Guid) or NodeName.
        # Carry both so resolution succeeds regardless of which path is used.
        assert '"NodeId"' in source and '"NodeName"' in source
        assert '"ErrorCode"' in source
        assert '"InjectedBy"' in source, "Attribution string lets users see this was synthetic"

    def test_iteration_id_threaded_through(self, source: str) -> None:
        # If the engine extracts IterationId but never stamps it on the
        # TelemetryEvent, the frontend filter still drops it.
        assert re.search(
            r"telemetryEvent\.IterationId\s*=\s*iterationId",
            source,
        ), "IterationId must be stamped on the synthetic TelemetryEvent"
