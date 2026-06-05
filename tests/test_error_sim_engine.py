"""
EdogErrorSimEngine — structural tests.

Verifies the engine class exists with the required public surface,
correctly references the underlying fault store, uses reflection for
Channel 3 (pre-GTS) injection, and emits the expected GTS Status
Forge body shape.
"""
from __future__ import annotations

import pathlib

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
        assert '\\"errorDetails\\"' in source

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
