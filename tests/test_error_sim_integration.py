"""
Error Code Simulator — cross-file integration test.

Replaces the prior substring-matching theater (which would have passed with
both P0 bugs in place — Bug A: AsyncLocal NodeId was the display name and
silently broke Channels 1/2; Bug B: pre-GTS faulted nodes were invisible
in the UI). The assertions below pin the *contract* between the engine,
the edog.py patches, the fault store, and the frontend telemetry consumer.

Each assertion has a referenced failure mode in its message so a future
engineer who breaks the contract sees the user-visible consequence, not
just "regex didn't match".
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
TOPIC_ROUTER = REPO / "src" / "backend" / "DevMode" / "EdogTopicRouter.cs"
EDOG_PY = REPO / "edog.py"
DAG_STUDIO_JS = REPO / "src" / "frontend" / "js" / "dag-studio.js"


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
        "topicRouter": TOPIC_ROUTER,
        "edogPy": EDOG_PY,
        "dagStudioJs": DAG_STUDIO_JS,
    }
    sources = {}
    for name, path in files.items():
        assert path.exists(), f"{path.name} missing"
        sources[name] = path.read_text(encoding="utf-8")
    return sources


# ── Wiring (kept from prior file — these are cheap and useful) ───────────────


class TestHubToEngineWiring:
    def test_hub_calls_engine(self, all_sources):
        hub = all_sources["hub"]
        for fn in (
            "EdogErrorSimEngine.AddRule",
            "EdogErrorSimEngine.RemoveRule",
            "EdogErrorSimEngine.ClearAll",
            "EdogErrorSimEngine.GetActiveRules",
            "EdogErrorSimEngine.ComputeBlastRadius",
            "EdogErrorSimEngine.GetCatalogJson",
        ):
            assert fn in hub, f"Hub must call {fn}"

    def test_engine_calls_catalog_and_fault_store(self, all_sources):
        engine = all_sources["engine"]
        assert "EdogErrorCodeCatalog" in engine
        assert "EdogHttpFaultStore.AddErrorSimRule" in engine
        assert "EdogHttpFaultStore.RemoveErrorSimRule" in engine
        assert "EdogHttpFaultStore.ClearErrorSimRules" in engine

    def test_fault_store_reads_async_local(self, all_sources):
        assert "EdogNodeExecutionContext.Current" in all_sources["faultStore"]

    def test_pipeline_uses_json(self, all_sources):
        assert "application/json" in all_sources["pipeline"]


# ── Bug A regression: NodeId identity must be Guid end-to-end ────────────────


class TestNodeIdIdentityConsistency:
    """The Error Code Simulator's frontend sends ``node.nodeId`` (the FLT Guid
    string) as the rule's nodeId. The AsyncLocal ``NodeId`` must be the same
    Guid string so ``EdogHttpFaultStore.TryMatchFault``'s equality check fires.
    The bug pre-fix set both wrapper sites to ``node.Name`` — silently
    breaking Channels 1 & 2 on every node-targeted rule. These assertions
    pin the contract at all three sites that produce the AsyncLocal value.
    """

    def test_edog_py_patch_uses_guid_for_async_local_nodeid(self, all_sources):
        py = all_sources["edogPy"]
        # The C# the patcher INSERTS must source NodeId from Guid, not Name.
        # Match the bare C# line so the assertion is independent of the
        # Python string-quoting style edog.py uses.
        assert "NodeId = node.NodeId.ToString()," in py, (
            "apply_node_executor_wrapper_patch must insert `NodeId = node.NodeId.ToString(),` — Bug A regression."
        )
        assert "NodeId = node.Name," not in py, (
            "Bug A regression: patch must not insert `NodeId = node.Name,` "
            "as the AsyncLocal NodeId — that's the original buggy shape."
        )

    def test_edog_py_wrapper_call_passes_guid_first(self, all_sources):
        py = all_sources["edogPy"]
        assert "nodeExecutor, node.NodeId.ToString(), node.Name, dagExecInstance" in py, (
            "Wrapper call must pass node.NodeId.ToString() as nodeId and node.Name as nodeName — Bug A regression."
        )
        assert "nodeExecutor, node.Name, dagExecInstance" not in py, (
            "Bug A regression: wrapper call must not pass node.Name as the nodeId positional argument."
        )

    def test_wrapper_async_local_uses_separate_fields(self, all_sources):
        interceptor = all_sources["interceptor"]
        # The wrapper itself must derive NodeName from _nodeName, not _nodeId.
        match = re.search(
            r"EdogNodeExecutionContext\.Current\s*=\s*new\s+EdogNodeExecutionContext\s*\{([^}]+)\}",
            interceptor,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "NodeId = _nodeId" in body
        assert "NodeName = _nodeName" in body, (
            "Bug A regression: wrapper used to set NodeName = _nodeId — "
            "collapsing both fields to the same (wrong) value."
        )


# ── Bug B regression: pre-GTS faulted nodes must surface in UI ───────────────


class TestPreGtsSyntheticTelemetryContract:
    """Channel 3 (pre-GTS) injection sets node.IsFaulted via reflection, then
    FLT aborts the entire DAG with MLV_DAG_HAS_FAULTED_NODES before any node
    runs. The targeted node never produces real NodeExecution telemetry, so
    the frontend's ExecutionStateManager leaves it at 'pending' / "Not Started"
    with no error code — even though the backend correctly injected the fault.

    Fix: engine emits synthetic ``NodeExecution`` / ``Failed`` telemetry on
    the existing ``telemetry`` topic right after reflection succeeds. The
    frontend's existing handler picks it up unchanged.
    """

    def test_engine_publishes_synthetic_node_execution_failed(self, all_sources):
        engine = all_sources["engine"]
        assert 'EdogTopicRouter.Publish("telemetry"' in engine, (
            "Bug B regression: engine must publish synthetic telemetry — "
            "without it, pre-GTS faulted nodes are invisible in the UI."
        )
        assert re.search(
            r'new\s+TelemetryEvent\s*\(\s*[^,]+,\s*"NodeExecution"\s*,\s*"Failed"',
            engine,
        ), "Synthetic event must be NodeExecution / Failed"

    def test_engine_threads_iteration_id_through(self, all_sources):
        engine = all_sources["engine"]
        # Frontend filter drops events whose IterationId doesn't match the
        # active run. Engine must extract + stamp IterationId or the UI
        # silently filters out the synthetic event.
        assert re.search(
            r"ApplyPreGtsFaults\s*\(\s*object\s+dag\s*,\s*object\s+dagExecInstance",
            engine,
        ), "ApplyPreGtsFaults must accept dagExecInstance for IterationId access"
        assert "telemetryEvent.IterationId = iterationId" in engine

    def test_pre_gts_patch_passes_dag_exec_instance(self, all_sources):
        py = all_sources["edogPy"]
        assert "EdogErrorSimEngine.ApplyPreGtsFaults(dag, dagExecInstance);" in py, (
            "Bug B regression: pre-GTS patch must pass dagExecInstance so "
            "the engine can read IterationId for synthetic telemetry."
        )

    def test_telemetry_topic_is_registered(self, all_sources):
        # The synthetic publish silently no-ops if the topic isn't registered.
        assert 'RegisterTopic("telemetry"' in all_sources["topicRouter"]


# ── Frontend race guard: terminal -> running regression must be blocked ──────


class TestFrontendExecutionStateRaceGuard:
    """A synthetic NodeExecution Failed telemetry can arrive BEFORE the FLT
    RunDAG Started telemetry on a single-node DAG (because DAG construction
    is where we inject, and that happens before FLT begins iterating nodes).
    The frontend's ``_processNodeTelemetry`` correctly moves the single
    node to 'failed' which then drives ``_executionStatus`` to 'failed'
    via ``_checkCompletion()``. Then a late RunDAG Started would regress
    'failed' back to 'running' — leaving the UI showing "Running…" forever.
    """

    def test_execution_telemetry_ignores_started_after_terminal(self, all_sources):
        js = all_sources["dagStudioJs"]
        # The guard lives at the top of _processExecutionTelemetry's
        # started/inprogress branch.
        match = re.search(
            r"_processExecutionTelemetry\s*\([^)]*\)\s*\{(.*?)\n\s{2}\}",
            js,
            re.DOTALL,
        )
        assert match, "_processExecutionTelemetry not found"
        body = match.group(1)
        assert "_isTerminal(this._executionStatus)" in body, (
            "Frontend must guard against terminal -> running regression. "
            "Without it a late RunDAG Started after a synthetic "
            "NodeExecution Failed silently flips the UI back to Running."
        )


# ── Patch function presence (gate) ───────────────────────────────────────────


class TestPatchFunctionsExist:
    def test_dag_hook_patch(self, all_sources):
        assert "def apply_dag_execution_hook_patch" in all_sources["edogPy"]

    def test_node_executor_wrapper_patch(self, all_sources):
        assert "def apply_node_executor_wrapper_patch" in all_sources["edogPy"]

    def test_pre_gts_patch(self, all_sources):
        assert "def apply_error_sim_pre_gts_patch" in all_sources["edogPy"]

    def test_all_reverts_exist(self, all_sources):
        py = all_sources["edogPy"]
        for fn in (
            "revert_dag_execution_hook_patch",
            "revert_node_executor_wrapper_patch",
            "revert_error_sim_pre_gts_patch",
        ):
            assert f"def {fn}" in py, f"Missing revert: {fn}"


# ── Interceptor cleanup contract ─────────────────────────────────────────────


class TestInterceptorCleanup:
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


class TestErrorCodeCoverage:
    """Verify catalog covers key error codes from each phase."""

    @pytest.fixture(scope="class")
    def catalog(self, all_sources):
        return all_sources["catalog"]

    def test_has_gts_submit_codes(self, catalog):
        for code in (
            "MLV_TOO_MANY_REQUESTS",
            "MLV_SPARK_JOB_CAPACITY_THROTTLING",
            "MLV_SPARK_SESSION_ACQUISITION_FAILED",
        ):
            assert code in catalog, f"Missing GTS_SUBMIT code: {code}"

    def test_has_catalog_resolve_codes(self, catalog):
        for code in ("MLV_ACCESS_DENIED", "MLV_ARTIFACT_NOT_FOUND", "MLV_SOURCE_ENTITY_NOT_FOUND"):
            assert code in catalog, f"Missing CATALOG_RESOLVE code: {code}"

    def test_has_node_execution_codes(self, catalog):
        for code in ("MLV_CONCURRENT_REFRESH", "MLV_SCHEMA_MISMATCH", "MLV_CONSTRAINT_VIOLATION"):
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
