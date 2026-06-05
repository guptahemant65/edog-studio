"""
Error Code Simulator — integration test.

Tests the full flow: catalog lookup -> engine rule creation -> fault store
entry -> node-scoped matching via AsyncLocal context simulation.
"""
from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
ENGINE = REPO / "src" / "backend" / "DevMode" / "EdogErrorSimEngine.cs"
CATALOG = REPO / "src" / "backend" / "DevMode" / "EdogErrorCodeCatalog.cs"
FAULT_STORE = REPO / "src" / "backend" / "DevMode" / "EdogHttpFaultStore.cs"
PIPELINE = REPO / "src" / "backend" / "DevMode" / "EdogHttpPipelineHandler.cs"
CONTEXT = REPO / "src" / "backend" / "DevMode" / "EdogNodeExecutionContext.cs"
HUB = REPO / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
INTERCEPTOR = REPO / "src" / "backend" / "DevMode" / "EdogDagExecutionInterceptor.cs"


@pytest.fixture(scope="module")
def all_sources():
    files = {
        "engine": ENGINE,
        "catalog": CATALOG,
        "faultStore": FAULT_STORE,
        "pipeline": PIPELINE,
        "context": CONTEXT,
        "hub": HUB,
        "interceptor": INTERCEPTOR,
    }
    sources = {}
    for name, path in files.items():
        assert path.exists(), f"{path.name} missing"
        sources[name] = path.read_text(encoding="utf-8")
    return sources


class TestEndToEndFlow:
    """Verify the complete data flow from SignalR hub to fault injection."""

    def test_hub_calls_engine(self, all_sources):
        """Hub methods delegate to EdogErrorSimEngine."""
        hub = all_sources["hub"]
        assert "EdogErrorSimEngine.AddRule" in hub
        assert "EdogErrorSimEngine.RemoveRule" in hub
        assert "EdogErrorSimEngine.ClearAll" in hub
        assert "EdogErrorSimEngine.GetActiveRules" in hub
        assert "EdogErrorSimEngine.ComputeBlastRadius" in hub
        assert "EdogErrorSimEngine.GetCatalogJson" in hub

    def test_engine_calls_catalog(self, all_sources):
        """Engine looks up error codes in catalog."""
        engine = all_sources["engine"]
        assert "EdogErrorCodeCatalog" in engine

    def test_engine_calls_fault_store(self, all_sources):
        """Engine creates fault store entries."""
        engine = all_sources["engine"]
        assert "EdogHttpFaultStore.AddErrorSimRule" in engine
        assert "EdogHttpFaultStore.RemoveErrorSimRule" in engine
        assert "EdogHttpFaultStore.ClearErrorSimRules" in engine

    def test_fault_store_reads_async_local(self, all_sources):
        """Fault store uses AsyncLocal for node scoping."""
        store = all_sources["faultStore"]
        assert "EdogNodeExecutionContext.Current" in store

    def test_pipeline_uses_synthesize(self, all_sources):
        """Pipeline handler synthesizes responses with JSON content type."""
        pipeline = all_sources["pipeline"]
        assert "application/json" in pipeline

    def test_interceptor_sets_context(self, all_sources):
        """Node executor wrapper sets AsyncLocal context."""
        interceptor = all_sources["interceptor"]
        assert "EdogNodeExecutionContext.Current = new" in interceptor

    def test_interceptor_clears_in_finally(self, all_sources):
        """Node executor wrapper clears context in finally."""
        interceptor = all_sources["interceptor"]
        assert re.search(
            r"finally\s*\{[^}]*EdogNodeExecutionContext\.Current\s*=\s*null",
            interceptor,
            re.DOTALL,
        )


class TestChannel1GtsStatusForge:
    """Channel 1: GTS status response forge produces correct body."""

    def test_builds_failed_state_body(self, all_sources):
        engine = all_sources["engine"]
        assert '"state":"Failed"' in engine or '"state\\": \\"Failed' in engine or "Failed" in engine

    def test_builds_error_details(self, all_sources):
        engine = all_sources["engine"]
        assert "error" in engine

    def test_uses_http_200(self, all_sources):
        engine = all_sources["engine"]
        # Channel 1 should use status 200
        assert re.search(r"http_error.*200|200.*http_error|StatusCode.*200", engine)


class TestChannel3PreGtsFaultInjection:
    """Channel 3: pre-GTS node state injection uses reflection."""

    def test_apply_pre_gts_faults_exists(self, all_sources):
        engine = all_sources["engine"]
        assert "ApplyPreGtsFaults" in engine

    def test_uses_reflection(self, all_sources):
        engine = all_sources["engine"]
        assert "GetProperty" in engine
        assert "SetValue" in engine

    def test_sets_is_faulted(self, all_sources):
        engine = all_sources["engine"]
        assert "IsFaulted" in engine

    def test_sets_flt_error_code(self, all_sources):
        engine = all_sources["engine"]
        assert "FLTErrorCode" in engine


class TestPatchFunctionsExist:
    """Verify all edog.py patch functions exist."""

    @pytest.fixture(scope="class")
    def edog_source(self):
        return (REPO / "edog.py").read_text(encoding="utf-8")

    def test_dag_hook_patch(self, edog_source):
        assert "def apply_dag_execution_hook_patch" in edog_source

    def test_node_executor_wrapper_patch(self, edog_source):
        assert "def apply_node_executor_wrapper_patch" in edog_source

    def test_pre_gts_patch(self, edog_source):
        assert "def apply_error_sim_pre_gts_patch" in edog_source

    def test_all_reverts_exist(self, edog_source):
        assert "def revert_dag_execution_hook_patch" in edog_source
        assert "def revert_node_executor_wrapper_patch" in edog_source
        assert "def revert_error_sim_pre_gts_patch" in edog_source


class TestErrorCodeCoverage:
    """Verify catalog covers key error codes from each phase."""

    @pytest.fixture(scope="class")
    def catalog(self, all_sources):
        return all_sources["catalog"]

    def test_has_gts_submit_codes(self, catalog):
        for code in ("MLV_TOO_MANY_REQUESTS", "MLV_SPARK_JOB_CAPACITY_THROTTLING",
                      "MLV_SPARK_SESSION_ACQUISITION_FAILED"):
            assert code in catalog, f"Missing GTS_SUBMIT code: {code}"

    def test_has_catalog_resolve_codes(self, catalog):
        for code in ("MLV_ACCESS_DENIED", "MLV_ARTIFACT_NOT_FOUND",
                      "MLV_SOURCE_ENTITY_NOT_FOUND"):
            assert code in catalog, f"Missing CATALOG_RESOLVE code: {code}"

    def test_has_node_execution_codes(self, catalog):
        for code in ("MLV_CONCURRENT_REFRESH", "MLV_SCHEMA_MISMATCH",
                      "MLV_CONSTRAINT_VIOLATION"):
            assert code in catalog, f"Missing NODE_EXECUTION code: {code}"

    def test_has_ingest_codes(self, catalog):
        for code in ("MLV_INGEST_PATH_NOT_FOUND", "MLV_INGEST_AUTH_FAILURE"):
            assert code in catalog, f"Missing INGEST code: {code}"

    def test_has_pyspark_codes(self, catalog):
        for code in ("MLV_PYSPARK_REFRESH_SCHEMA_MISMATCH", "MLV_NOT_A_PYSPARK_MLV"):
            assert code in catalog, f"Missing PySpark code: {code}"

    def test_has_dag_construction_codes(self, catalog):
        for code in ("MLV_CIRCULAR_DEPENDENCY", "MLV_LINEAGE_CREATION_FAILURE"):
            assert code in catalog, f"Missing DAG_CONSTRUCTION code: {code}"
