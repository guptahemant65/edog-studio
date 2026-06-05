"""
EdogNodeExecutorWrapper — AsyncLocal context structural test.

Verifies that ExecuteNodeAsync sets EdogNodeExecutionContext.Current
before calling _inner and clears it in a finally block.
"""
from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR = REPO / "src" / "backend" / "DevMode" / "EdogDagExecutionInterceptor.cs"
CONTEXT = REPO / "src" / "backend" / "DevMode" / "EdogNodeExecutionContext.cs"


@pytest.fixture()
def interceptor_source():
    assert INTERCEPTOR.exists(), "EdogDagExecutionInterceptor.cs missing"
    return INTERCEPTOR.read_text(encoding="utf-8")


@pytest.fixture()
def context_source():
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
        body = interceptor_source[match.start():]
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


class TestPatchFunctions:
    def test_apply_patch_function_exists(self):
        edog_py = REPO / "edog.py"
        src = edog_py.read_text(encoding="utf-8")
        assert "def apply_node_executor_wrapper_patch" in src

    def test_revert_patch_function_exists(self):
        edog_py = REPO / "edog.py"
        src = edog_py.read_text(encoding="utf-8")
        assert "def revert_node_executor_wrapper_patch" in src
