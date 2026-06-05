"""
EdogNodeExecutorWrapper — AsyncLocal context structural + patch-generator tests.

The wrapper exists to set ``EdogNodeExecutionContext.Current`` for HTTP-pipeline
fault scoping. The contract is non-obvious: ``Current.NodeId`` MUST be the FLT
``Guid`` (as a string), because the Error Code Simulator frontend sends the
Guid string as the rule's nodeId, and ``EdogHttpFaultStore.TryMatchFault``
does case-insensitive equality between rule.NodeId and ``Current.NodeId``.

Historical bug (silently broke every node-targeted Channel 1/2 rule):
The original wrapper set ``NodeId = node.Name`` (the display string) in TWO
places — once in the edog.py-inserted AsyncLocal block, and again inside
``EdogNodeExecutorWrapper.ExecuteNodeAsync`` from the wrapper's ``_nodeId``
field (constructed from ``node.Name``). Fixing only one was not enough — the
wrapper overwrote the earlier set. This test pins the contract at every layer.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR = REPO / "src" / "backend" / "DevMode" / "EdogDagExecutionInterceptor.cs"
CONTEXT = REPO / "src" / "backend" / "DevMode" / "EdogNodeExecutionContext.cs"

_spec = importlib.util.spec_from_file_location("edog", str(REPO / "edog.py"))
edog = importlib.util.module_from_spec(_spec)
sys.path.insert(0, str(REPO))
_cwd = os.getcwd()
try:
    os.chdir(REPO)
    _spec.loader.exec_module(edog)
finally:
    os.chdir(_cwd)


# ── Synthetic FLT source fixture ─────────────────────────────────────────────
# Mirrors the relevant slice of DagExecutionHandlerV2.cs that the patch
# function anchors on. Keep this minimal so the assertions stay focused on
# the patched fragments rather than ambient FLT noise.

_FLT_FIXTURE = """\
namespace Microsoft.LiveTable.Service.Core.V2
{
    public class DagExecutionHandlerV2
    {
        public async Task ExecuteAsync(Dag dag, DagExecutionInstance dagExecInstance)
        {
            Check.AssertArgumentNotNull(dag, nameof(dag));

            foreach (var node in dag.Nodes)
            {
                Task.Run(async () =>
                {
                    var cts = await cascadingCancellation.AddOrGetAsync(node.NodeId);

                    try
                    {
                        await nodeExecutor.ExecuteNodeAsync(cts.Token);
                    }
                    finally
                    {
                        NodeExecutionMetrics currentNodeExecutionMetrics = dagExecInstance.GetNodeExecutionMetrics(node.NodeId);
                    }
                });
            }
        }
    }
}
"""


# ── Source-file structural checks (the C# wrapper itself) ────────────────────


@pytest.fixture(scope="module")
def interceptor_source() -> str:
    assert INTERCEPTOR.exists(), "EdogDagExecutionInterceptor.cs missing"
    return INTERCEPTOR.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def context_source() -> str:
    assert CONTEXT.exists(), "EdogNodeExecutionContext.cs missing"
    return CONTEXT.read_text(encoding="utf-8")


class TestNodeExecutionContext:
    def test_context_class_exists(self, context_source):
        assert "class EdogNodeExecutionContext" in context_source

    def test_context_has_async_local(self, context_source):
        assert "AsyncLocal<EdogNodeExecutionContext>" in context_source

    def test_context_has_current_property(self, context_source):
        assert "static EdogNodeExecutionContext Current" in context_source

    def test_context_has_node_fields(self, context_source):
        for field in ("NodeId", "NodeName", "DagId", "IterationId"):
            assert field in context_source, f"Missing field: {field}"


class TestNodeExecutorWrapperAsyncLocal:
    def test_sets_context_before_inner(self, interceptor_source):
        match = re.search(r"public\s+async\s+Task\s+ExecuteNodeAsync", interceptor_source)
        assert match
        body = interceptor_source[match.start() :]
        ctx_set = body.find("EdogNodeExecutionContext.Current = new")
        inner_call = body.find("_inner.ExecuteNodeAsync")
        assert ctx_set > 0 and inner_call > 0, "Both context set and inner call must exist"
        assert ctx_set < inner_call, "Context must be set BEFORE calling _inner"

    def test_clears_context_in_finally(self, interceptor_source):
        assert re.search(
            r"finally\s*\{[^}]*EdogNodeExecutionContext\.Current\s*=\s*null",
            interceptor_source,
            re.DOTALL,
        ), "ExecuteNodeAsync must clear context in finally block"

    def test_wrapper_has_separate_nodeid_and_nodename_fields(self, interceptor_source):
        # Bug A regression: wrapper used to set NodeName = _nodeId (same value).
        # The fix splits them into distinct private fields so the AsyncLocal
        # set can use the Guid for NodeId and the display name for NodeName.
        assert "private readonly string _nodeId;" in interceptor_source
        assert "private readonly string _nodeName;" in interceptor_source, (
            "Wrapper must have a separate _nodeName field — Bug A regression"
        )

    def test_wrapper_constructor_accepts_both_id_and_name(self, interceptor_source):
        ctor_match = re.search(
            r"public\s+EdogNodeExecutorWrapper\s*\(([^)]*)\)",
            interceptor_source,
        )
        assert ctor_match, "Wrapper constructor declaration not found"
        params = ctor_match.group(1)
        assert "string nodeId" in params and "string nodeName" in params, (
            f"Wrapper ctor must take both nodeId and nodeName — got: {params}"
        )

    def test_wrapper_sets_nodename_from_nodename(self, interceptor_source):
        # The AsyncLocal block inside ExecuteNodeAsync must source NodeName
        # from _nodeName, NOT _nodeId. The pre-fix code did `NodeName = _nodeId`
        # which collapsed both fields to the same (wrong) value.
        body_match = re.search(
            r"EdogNodeExecutionContext\.Current\s*=\s*new\s+EdogNodeExecutionContext\s*\{([^}]+)\}",
            interceptor_source,
            re.DOTALL,
        )
        assert body_match, "AsyncLocal initializer not found"
        body = body_match.group(1)
        assert re.search(r"NodeId\s*=\s*_nodeId\s*,", body), "NodeId must be assigned from _nodeId (the Guid string)"
        assert re.search(r"NodeName\s*=\s*_nodeName\s*,", body), (
            "NodeName must be assigned from _nodeName (the display name) — Bug A regression"
        )
        assert "NodeName = _nodeId" not in body, "NodeName must NOT be assigned from _nodeId — Bug A regression"


# ── Patch generator behaviour (mutation-style) ───────────────────────────────


class TestPatchFunctions:
    def test_apply_patch_function_exists(self):
        assert hasattr(edog, "apply_node_executor_wrapper_patch")

    def test_revert_patch_function_exists(self):
        assert hasattr(edog, "revert_node_executor_wrapper_patch")


class TestApplyPatchGeneratesGuidNodeId:
    """Regression coverage for the historical NodeId=node.Name bug.

    The patch inserts an AsyncLocal context block AND replaces the
    ``await nodeExecutor.ExecuteNodeAsync`` call with a wrapper instantiation.
    Both must use ``node.NodeId.ToString()`` for the Guid-based identity.
    """

    @pytest.fixture(scope="class")
    def patched(self):
        patched, status = edog.apply_node_executor_wrapper_patch(_FLT_FIXTURE)
        assert status == "applied", f"Patch did not apply: {status}"
        return patched

    def test_asynclocal_uses_guid_for_nodeid(self, patched):
        assert "NodeId = node.NodeId.ToString()," in patched, (
            "AsyncLocal must assign NodeId = node.NodeId.ToString() (the Guid). "
            "Using node.Name silently breaks Channels 1 & 2 — Bug A regression."
        )

    def test_asynclocal_preserves_display_name(self, patched):
        assert "NodeName = node.Name," in patched, (
            "AsyncLocal must keep NodeName = node.Name for diagnostics + "
            "Channel 3 by-name fallback in EdogHttpFaultStore."
        )

    def test_asynclocal_does_not_use_name_as_nodeid(self, patched):
        assert "NodeId = node.Name," not in patched, "Bug A regression: NodeId must NOT be assigned from node.Name."

    def test_wrapper_call_passes_guid_first_then_name(self, patched):
        # The new wrapper signature is (inner, nodeId, nodeName, dagId, iterationId).
        # The previous (buggy) signature was (inner, nodeId-from-Name, dagId, iterationId).
        # Match indent-agnostically — apply preserves the original line's indent.
        pattern = re.compile(
            r"new Microsoft\.LiveTable\.Service\.DevMode\.EdogNodeExecutorWrapper\(\s*\n"
            r"\s+nodeExecutor, node\.NodeId\.ToString\(\), node\.Name, "
            r"dagExecInstance\.Dag\?\.Name \?\? string\.Empty, dagExecInstance\.IterationId\);"
        )
        assert pattern.search(patched), "Wrapper call must pass Guid as nodeId and node.Name as nodeName"

    def test_wrapper_call_does_not_use_name_as_first_arg(self, patched):
        # Pre-fix the wrapper call was `nodeExecutor, node.Name, dagExecInstance...`
        # That signature is gone — flagging its presence catches the regression.
        assert "nodeExecutor, node.Name, dagExecInstance" not in patched, (
            "Bug A regression: wrapper call must not pass node.Name as the "
            "nodeId argument; that defeats the AsyncLocal NodeId=Guid fix."
        )

    def test_guardrail_comment_present(self, patched):
        # The patch ships with a comment explaining WHY NodeId must be the
        # Guid — required by Donna Rule #6 so future refactors don't undo it.
        assert "NodeId MUST be node.NodeId.ToString()" in patched, (
            "Guardrail comment missing — without it a future engineer "
            "'cleaning up' the patch could silently re-introduce Bug A."
        )


class TestApplyIdempotent:
    def test_already_applied_returns_unchanged(self):
        patched_once, status1 = edog.apply_node_executor_wrapper_patch(_FLT_FIXTURE)
        assert status1 == "applied"
        patched_twice, status2 = edog.apply_node_executor_wrapper_patch(patched_once)
        assert status2 == "already_applied"
        assert patched_twice == patched_once

    def test_missing_marker_no_change(self):
        _result, status = edog.apply_node_executor_wrapper_patch("namespace X { public class Y { } }")
        assert status == "pattern_not_found"


class TestRevertRoundtrip:
    def test_apply_then_revert_restores_original(self):
        patched, status = edog.apply_node_executor_wrapper_patch(_FLT_FIXTURE)
        assert status == "applied"
        reverted = edog.revert_node_executor_wrapper_patch(patched)
        # Normalize trailing whitespace per-line — revert removes inserted
        # blocks cleanly but the surrounding indentation is preserved.
        assert reverted == _FLT_FIXTURE, (
            "apply+revert must be a roundtrip. If the patch shape changes, the revert regex must change in lockstep."
        )
