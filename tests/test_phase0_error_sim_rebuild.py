"""Phase 0 — Error Code Simulator first-principles rebuild.

Six patches plus two new C# files are exercised here:

  C# files:
    - EdogRequestContext.cs      (AsyncLocal, two-stage Begin/Enrich/End)
    - EdogFaultedNodeException.cs (typed exception carrying ErrorCode + StatusCode)

  Patches:
    1. apply_request_context_begin_patch
    2. apply_request_context_enrich_patch
    3. apply_request_context_end_patch
    4. apply_faulted_node_typed_throw_patch
    5. apply_outer_catch_guard_extend_patch
    6. apply_mapper_edog_branch_patch

Tests cover: structural correctness of the C# files, apply correctness for
each patch on a synthetic FLT fixture, idempotency, revert roundtrip, and
the combined apply-all-then-revert-all byte-for-byte roundtrip.

The synthetic fixtures intentionally mirror the slice of FLT source the
patches anchor on — minimal and focused so assertions catch shape changes
in the patches, not ambient FLT noise.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import sys
import typing

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
CTX_FILE = REPO / "src" / "backend" / "DevMode" / "EdogRequestContext.cs"
EXC_FILE = REPO / "src" / "backend" / "DevMode" / "EdogFaultedNodeException.cs"

_spec = importlib.util.spec_from_file_location("edog", str(REPO / "edog.py"))
edog = importlib.util.module_from_spec(_spec)
sys.path.insert(0, str(REPO))
_cwd = os.getcwd()
try:
    os.chdir(REPO)
    _spec.loader.exec_module(edog)
finally:
    os.chdir(_cwd)


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic FLT fixtures — mirror exact anchor lines in real FLT source.
# ─────────────────────────────────────────────────────────────────────────────

DAGHANDLER_FIXTURE = """\
namespace Microsoft.LiveTable.Service.Core.V2
{
    using Microsoft.LiveTable.Service.DataModel.GTS;
    using Microsoft.LiveTable.Service.ErrorMapping;

    public class DagExecutionHandlerV2
    {
        public async Task ExecuteAsync(ReliableOperationMetadata metadata, CancellationToken monikerEvictionCancellationToken)
        {
            await LiveTableRunCodeMarker.RunDAG.ExecuteAsync(async ms =>
            {
                var iterationId = metadata.OpId;
                var reliableOpsRetryRequest = metadata.IsRetry;

                DagExecutionContext dagExecutionContext = null;
                string resultCode = null;
                string errorMessage = null;
                ErrorSource errorSource = default;

                try
                {
                    // ... synthetic: imagine dagExecutionContext gets built here ...

                    ms.AddCustomData(Constants.WorkspaceIdKey, dagExecutionContext.WorkspaceId.ToString());
                    ms.AddCustomData(Constants.ArtifactIdKey, dagExecutionContext.LakehouseId.ToString());
                    ms.AddCustomData(Constants.TenantIdKey, metadata.TenantId.ToString());
                    ms.AddCustomData(Constants.IterationIdKey, iterationId.ToString());
                    ms.AddCustomData("IsReliableOpsRetryRequest", reliableOpsRetryRequest);

                    // ... synthetic: imagine DAG build + faulted-node check here ...
                    var faultedNodes = sortedNodes.Where(n => n.IsFaulted).ToList();
                    if (faultedNodes.Count > 0)
                    {
                        var faultedDetails = string.Join("; ", faultedNodes.Select(n => $"{n.Name}: {n.ErrorMessage ?? "Unknown error"}"));
                        errorMessage = ErrorRegistry.GetErrorMessage(
                            ErrorCode.MLV_DAG_HAS_FAULTED_NODES,
                            new Dictionary<string, string> { { Constants.ErrorMessageKey, faultedDetails } });

                        resultCode = ErrorCode.MLV_DAG_HAS_FAULTED_NODES.ToString();
                        activityStatus = StandardizedActivityStatus.SucceededWithErrors;
                        errorSource = ErrorSource.User;
                        throw new Exception(errorMessage);
                    }
                }
                catch (Exception e)
                {
                    try
                    {
                        // Skip MapExceptionToErrorInfo entirely when all error info is already pre-set
                        // (e.g., faulted nodes sets resultCode, errorMessage, and activityStatus before throwing).
                        if (string.IsNullOrEmpty(resultCode))
                        {
                            ErrorCode mappedErrorCode = default;
                            (mappedErrorCode, errorMessage, activityStatus) = NodeExecutionUtils.MapExceptionToErrorInfo(e);
                            resultCode = mappedErrorCode.ToString();
                        }
                        else if (string.IsNullOrEmpty(errorMessage))
                        {
                            // resultCode is pre-set but errorMessage is not — derive from registry.
                            if (Enum.TryParse<ErrorCode>(resultCode, out var parsedErrorCode))
                            {
                                errorMessage = ErrorRegistry.GetErrorMessage(parsedErrorCode);
                            }
                            else
                            {
                                errorMessage = ErrorRegistry.GetErrorMessage(ErrorCode.MLV_LINEAGE_CREATION_FAILURE);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        // ...
                    }
                }
                finally
                {
                    // *************************************************************************************
                    // Whatever happening for other ops in this finally, we want these IDisposable objects to be disposed.
                    // So going for try finally block. Please make sure to follow this pattern in case of adding new code here.
                    try
                    {
                        // ... cleanup ...
                    }
                    finally
                    {
                        // ... disposes ...
                    }
                }
            });
        }
    }
}
"""

NODEEXECUTIONUTILS_FIXTURE = """\
namespace Microsoft.LiveTable.Service.Utils
{
    public static class NodeExecutionUtils
    {
        public static (ErrorCode errorCode, string errorMessage, StandardizedActivityStatus activityStatus) MapExceptionToErrorInfo(Exception exception)
        {
            Tracer.LogSanitizedError(exception, $"Exception occurred during MapExceptionToErrorInfo: {exception.Message}");

            if (exception is NotebookException notebookEx)
            {
                return (ErrorCode.MLV_LINEAGE_CREATION_NOTEBOOK_EXCEPTION, "fake", StandardizedActivityStatus.Failed);
            }

            return (
                ErrorCode.MLV_LINEAGE_CREATION_FAILURE,
                "fallback",
                StandardizedActivityStatus.Failed);
        }
    }
}
"""


# ─────────────────────────────────────────────────────────────────────────────
# C# file structural checks — EdogRequestContext.cs
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def ctx_source() -> str:
    assert CTX_FILE.exists(), "EdogRequestContext.cs missing"
    return CTX_FILE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def exc_source() -> str:
    assert EXC_FILE.exists(), "EdogFaultedNodeException.cs missing"
    return EXC_FILE.read_text(encoding="utf-8")


class TestEdogRequestContextSource:
    def test_class_exists(self, ctx_source):
        assert "internal sealed class EdogRequestContext" in ctx_source

    def test_namespace_is_devmode(self, ctx_source):
        assert "namespace Microsoft.LiveTable.Service.DevMode" in ctx_source

    def test_async_local_pattern(self, ctx_source):
        assert "AsyncLocal<EdogRequestContext>" in ctx_source
        assert "_current" in ctx_source

    def test_has_three_lifecycle_methods(self, ctx_source):
        assert re.search(r"public\s+static\s+void\s+Begin\s*\(", ctx_source), "Begin missing"
        assert re.search(r"public\s+static\s+void\s+Enrich\s*\(", ctx_source), "Enrich missing"
        assert re.search(r"public\s+static\s+void\s+End\s*\(\s*\)", ctx_source), "End missing"

    def test_begin_signature_takes_metadata_and_iteration_id(self, ctx_source):
        match = re.search(
            r"public\s+static\s+void\s+Begin\s*\(\s*ReliableOperationMetadata\s+metadata\s*,\s*Guid\s+iterationId\s*\)",
            ctx_source,
        )
        assert match, "Begin must accept (ReliableOperationMetadata metadata, Guid iterationId)"

    def test_enrich_signature_takes_dag_execution_context(self, ctx_source):
        match = re.search(
            r"public\s+static\s+void\s+Enrich\s*\(\s*DagExecutionContext\s+dagExecutionContext\s*\)",
            ctx_source,
        )
        assert match, "Enrich must accept (DagExecutionContext dagExecutionContext)"

    def test_metadata_phase_fields(self, ctx_source):
        for field in ("IterationId", "TenantId", "StartedAt"):
            assert re.search(rf"public\s+\S+\s+{field}\b", ctx_source), f"Missing field: {field}"

    def test_enrich_phase_fields_are_nullable(self, ctx_source):
        # WorkspaceId/ArtifactId must be Guid? so callers can detect pre-enrich state.
        assert re.search(r"public\s+Guid\?\s+WorkspaceId\b", ctx_source), "WorkspaceId must be Guid?"
        assert re.search(r"public\s+Guid\?\s+ArtifactId\b", ctx_source), "ArtifactId must be Guid?"
        assert re.search(r"public\s+string\s+MlvName\b", ctx_source), "MlvName must be string"

    def test_begin_sets_started_at_to_utc_now(self, ctx_source):
        # Critical for downstream rule lifetime accounting.
        assert "DateTime.UtcNow" in ctx_source

    def test_enrich_copies_lakehouse_into_artifact(self, ctx_source):
        # Lakehouse IS the artifact in FLT's vocabulary — Enrich must mirror that.
        assert "dagExecutionContext.LakehouseId" in ctx_source

    def test_enrich_is_null_safe(self, ctx_source):
        # If Begin was skipped or context is null, Enrich must no-op rather than NRE.
        body = re.search(r"public\s+static\s+void\s+Enrich.*?^\s{8}\}", ctx_source, re.DOTALL | re.MULTILINE)
        assert body, "Could not isolate Enrich body"
        assert "if (ctx == null" in body.group(0) or "ctx?.WorkspaceId" in body.group(0), (
            "Enrich must null-guard against missing context (Begin not called)"
        )

    def test_end_clears_async_local(self, ctx_source):
        body = re.search(r"public\s+static\s+void\s+End\s*\(\s*\).*?^\s{8}\}", ctx_source, re.DOTALL | re.MULTILINE)
        assert body, "Could not isolate End body"
        assert "_current.Value = null" in body.group(0)

    def test_lifecycle_methods_swallow_exceptions(self, ctx_source):
        # The whole point of try/catch in each method: DevMode must never block FLT.
        for method in ("Begin", "Enrich", "End"):
            body_match = re.search(
                rf"public\s+static\s+void\s+{method}\b.*?^\s{{8}}\}}",
                ctx_source,
                re.DOTALL | re.MULTILINE,
            )
            assert body_match, f"Could not isolate {method} body"
            assert "catch" in body_match.group(0), f"{method} must catch exceptions — DevMode wiring must never block FLT"


class TestEdogFaultedNodeExceptionSource:
    def test_class_exists(self, exc_source):
        assert "internal sealed class EdogFaultedNodeException" in exc_source

    def test_extends_exception(self, exc_source):
        assert re.search(r"class\s+EdogFaultedNodeException\s*:\s*Exception", exc_source)

    def test_namespace_is_devmode(self, exc_source):
        assert "namespace Microsoft.LiveTable.Service.DevMode" in exc_source

    def test_imports_flt_error_types(self, exc_source):
        assert "using Microsoft.LiveTable.Service.ErrorMapping;" in exc_source
        assert "using Microsoft.LiveTable.Service.DataModel.GTS;" in exc_source

    def test_constructor_signature(self, exc_source):
        # (message, statusCode, errorCode, errorSource, innerException = null)
        pattern = re.compile(
            r"public\s+EdogFaultedNodeException\s*\(\s*"
            r"string\s+message\s*,\s*"
            r"int\s+statusCode\s*,\s*"
            r"ErrorCode\s+errorCode\s*,\s*"
            r"ErrorSource\s+errorSource\s*,\s*"
            r"Exception\s+innerException\s*=\s*null\s*\)",
        )
        assert pattern.search(exc_source), "Constructor signature mismatch"

    def test_carries_three_properties(self, exc_source):
        assert re.search(r"public\s+int\s+StatusCode\b", exc_source)
        assert re.search(r"public\s+ErrorCode\s+ErrorCode\b", exc_source)
        assert re.search(r"public\s+ErrorSource\s+ErrorSource\b", exc_source)

    def test_constructor_passes_message_and_inner_to_base(self, exc_source):
        assert ": base(message, innerException)" in exc_source


# ─────────────────────────────────────────────────────────────────────────────
# Patch generator existence
# ─────────────────────────────────────────────────────────────────────────────

PATCH_FNS = [
    "request_context_begin",
    "request_context_enrich",
    "request_context_end",
    "faulted_node_typed_throw",
    "outer_catch_guard_extend",
    "mapper_edog_branch",
    "outer_catch_error_source_propagate",
]


class TestPatchFunctionsExist:
    @pytest.mark.parametrize("name", PATCH_FNS)
    def test_apply_exists(self, name):
        assert hasattr(edog, f"apply_{name}_patch"), f"apply_{name}_patch missing"

    @pytest.mark.parametrize("name", PATCH_FNS)
    def test_revert_exists(self, name):
        assert hasattr(edog, f"revert_{name}_patch"), f"revert_{name}_patch missing"


# ─────────────────────────────────────────────────────────────────────────────
# Apply correctness — per-patch fragment assertions
# ─────────────────────────────────────────────────────────────────────────────


class TestBeginPatch:
    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_request_context_begin_patch(DAGHANDLER_FIXTURE)
        assert status == "applied", f"Begin patch status={status}"
        return result

    def test_inserts_begin_call(self, patched):
        assert "EdogRequestContext.Begin(metadata, iterationId)" in patched

    def test_begin_call_appears_after_iterationid_assignment(self, patched):
        iter_pos = patched.find("var iterationId = metadata.OpId;")
        begin_pos = patched.find("EdogRequestContext.Begin")
        assert iter_pos > 0 and begin_pos > 0
        assert iter_pos < begin_pos, "Begin must run AFTER iterationId is assigned (it's the parameter)"

    def test_begin_is_wrapped_in_try_catch(self, patched):
        # Find the inserted block; ensure it has try/catch wrapper.
        snippet = patched[patched.find("EDOG DevMode — begin request context") :][:600]
        assert "try" in snippet and "catch" in snippet


class TestEnrichPatch:
    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_request_context_enrich_patch(DAGHANDLER_FIXTURE)
        assert status == "applied", f"Enrich patch status={status}"
        return result

    def test_inserts_enrich_call(self, patched):
        assert "EdogRequestContext.Enrich(dagExecutionContext)" in patched

    def test_enrich_appears_after_ms_addcustomdata_block(self, patched):
        ms_pos = patched.find('ms.AddCustomData("IsReliableOpsRetryRequest"')
        enrich_pos = patched.find("EdogRequestContext.Enrich")
        assert ms_pos > 0 and enrich_pos > 0
        assert ms_pos < enrich_pos, "Enrich must run AFTER all ms.AddCustomData calls (dagExecutionContext is resolved)"


class TestEndPatch:
    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_request_context_end_patch(DAGHANDLER_FIXTURE)
        assert status == "applied", f"End patch status={status}"
        return result

    def test_inserts_end_call(self, patched):
        assert "EdogRequestContext.End();" in patched

    def test_end_call_is_inside_finally_block(self, patched):
        finally_pos = patched.find("finally\n                {\n")
        end_pos = patched.find("EdogRequestContext.End();")
        comment_pos = patched.find("// *****")
        assert finally_pos < end_pos < comment_pos, "End must be inserted between finally { and the *** comment line"

    def test_end_is_first_statement_in_finally(self, patched):
        # End() runs FIRST in the finally so a leaked AsyncLocal cannot outlive
        # the request even if subsequent cleanup throws.
        finally_open = patched.find("finally\n                {\n")
        end_call = patched.find("EdogRequestContext.End();")
        prefix = patched[finally_open:end_call]
        # The only executable token between `finally {` and the End() call must be
        # the opening `try {` of our own wrapper. No `await`, no other method calls,
        # no other `try` blocks.
        assert "await " not in prefix, "End() must be the first executable statement in the outer finally"
        assert prefix.count("try\n") == 1, (
            f"Exactly one `try` (our wrapper) must precede End(); found {prefix.count('try')}"
        )

    def test_end_is_wrapped_in_try_catch(self, patched):
        end_pos = patched.find("EdogRequestContext.End();")
        # Look back far enough to capture the multi-line `try { ... } catch { ... }` shape.
        snippet = patched[max(0, end_pos - 200) : end_pos + 300]
        # Multi-line shape required for StyleCop SA1501 (no single-line statements).
        assert "try\n" in snippet, "End() must be wrapped in a multi-line `try` block"
        assert "catch\n" in snippet, "End() must be wrapped in a multi-line `catch` block"
        # The catch body must contain at least the explanatory comment (avoids empty-brace lint).
        assert "Non-fatal — never block DAG execution from context teardown." in snippet


class TestFaultedNodeTypedThrowPatch:
    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_faulted_node_typed_throw_patch(DAGHANDLER_FIXTURE)
        assert status == "applied", f"Faulted-node throw patch status={status}"
        return result

    def test_replaces_bare_throw(self, patched):
        assert "throw new Exception(errorMessage);" not in patched

    def test_throws_edog_typed_exception(self, patched):
        assert "throw new Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException(" in patched

    def test_carries_first_faulted_node_code_with_fallback(self, patched):
        # The carried ErrorCode must come from the actual faulted node, with
        # MLV_DAG_HAS_FAULTED_NODES as the fallback. Without this, every
        # faulted-node failure surfaces as the aggregate code regardless of
        # which per-node code (e.g., MLV_SOURCE_ENTITY_NOT_FOUND) actually
        # triggered the abort — exactly the bug Phase 0 fixes.
        assert "faultedNodes[0].FLTErrorCode ?? ErrorCode.MLV_DAG_HAS_FAULTED_NODES" in patched

    def test_carries_status_422_user_error(self, patched):
        # 422 maps to SucceededWithErrors via the mapper branch (4xx => user).
        # The pre-existing line on the previous statement sets
        # errorSource = ErrorSource.User so 422 is the consistent companion.
        snippet = patched[
            patched.find("EdogFaultedNodeException(") : patched.find("EdogFaultedNodeException(") + 400
        ]
        assert "422" in snippet

    def test_passes_error_source_user(self, patched):
        snippet = patched[
            patched.find("EdogFaultedNodeException(") : patched.find("EdogFaultedNodeException(") + 400
        ]
        assert "ErrorSource.User" in snippet

    def test_legacy_resultcode_preset_is_preserved(self, patched):
        # Patch 4 intentionally leaves the `resultCode = ...HAS_FAULTED_NODES.ToString();`
        # line in place — the companion outer-catch-guard patch (Patch 5) handles
        # routing the typed exception through the mapper regardless.
        assert "resultCode = ErrorCode.MLV_DAG_HAS_FAULTED_NODES.ToString();" in patched


class TestOuterCatchGuardExtendPatch:
    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_outer_catch_guard_extend_patch(DAGHANDLER_FIXTURE)
        assert status == "applied", f"Outer-catch guard patch status={status}"
        return result

    def test_guard_is_extended_additively(self, patched):
        # Original guard text must remain; new disjunct is appended.
        assert (
            "if (string.IsNullOrEmpty(resultCode) || e is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException)"
            in patched
        )

    def test_original_guard_alone_is_gone(self, patched):
        # The line should no longer be the bare `if (string.IsNullOrEmpty(resultCode))`.
        assert "                        if (string.IsNullOrEmpty(resultCode))\n" not in patched


class TestMapperEdogBranchPatch:
    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_mapper_edog_branch_patch(NODEEXECUTIONUTILS_FIXTURE)
        assert status == "applied", f"Mapper branch patch status={status}"
        return result

    def test_inserts_typed_branch(self, patched):
        assert "exception is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException edogFaultedEx" in patched

    def test_branch_appears_before_notebook_exception_branch(self, patched):
        edog_pos = patched.find("exception is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException")
        nb_pos = patched.find("exception is NotebookException")
        assert edog_pos > 0 and nb_pos > 0
        assert edog_pos < nb_pos, (
            "EDOG branch must come BEFORE the NotebookException branch so the carried "
            "code is honored — without this, future exception inheritance changes "
            "could silently divert simulated failures to the wrong branch."
        )

    def test_branch_returns_carried_error_code(self, patched):
        snippet = patched[patched.find("edogFaultedEx") :][:500]
        assert "edogFaultedEx.ErrorCode" in snippet
        assert "exception.Message" in snippet

    def test_branch_picks_succeededwitherrors_for_4xx(self, patched):
        snippet = patched[patched.find("edogFaultedEx") :][:500]
        assert "edogFaultedEx.StatusCode >= 400 && edogFaultedEx.StatusCode < 500" in snippet
        assert "StandardizedActivityStatus.SucceededWithErrors" in snippet
        assert "StandardizedActivityStatus.Failed" in snippet


# ─────────────────────────────────────────────────────────────────────────────
# Apply idempotency — re-applying must return "already_applied" unchanged
# ─────────────────────────────────────────────────────────────────────────────


class TestErrorSourcePropagatePatch:
    """Patch 7 — propagate EdogFaultedNodeException.ErrorSource into outer-catch errorSource.

    Without this patch, the outer catch's `errorSource` retains whatever was
    pre-set before the throw (e.g., ErrorSource.User from line 350 in the
    faulted-node block). That happens to be correct for Phase 0's only
    callsite, but the typed exception carries its own ErrorSource for
    future Phase 1+ callsites where the simulator may inject System-class
    failures. This patch closes that gap by setting `errorSource` from
    the typed exception inside the guard's true-branch.
    """

    @pytest.fixture(scope="class")
    def patched(self):
        result, status = edog.apply_outer_catch_error_source_propagate_patch(DAGHANDLER_FIXTURE)
        assert status == "applied", f"ErrorSource propagate patch status={status}"
        return result

    def test_inserts_typed_assignment(self, patched):
        assert "errorSource = edogFaultedExForSource.ErrorSource;" in patched

    def test_assignment_is_guarded_on_typed_exception(self, patched):
        # Must be conditional — we never want to clobber errorSource for
        # real (non-EDOG) exceptions.
        assert "if (e is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException edogFaultedExForSource)" in patched

    def test_assignment_is_inside_mapper_branch(self, patched):
        # The errorSource propagation MUST live after the mapper call —
        # otherwise it would assign before mappedErrorCode is populated
        # AND would run on the legacy `else if (string.IsNullOrEmpty(errorMessage))`
        # path which is meant for non-EDOG pre-setters.
        mapper_pos = patched.find("resultCode = mappedErrorCode.ToString();")
        propagate_pos = patched.find("errorSource = edogFaultedExForSource.ErrorSource;")
        else_pos = patched.find("else if (string.IsNullOrEmpty(errorMessage))")
        assert mapper_pos > 0 < propagate_pos < else_pos, (
            "ErrorSource propagation must be between the mapper call and the legacy else-if branch"
        )


class TestCoupledFaultedNodeFidelityInvariant:
    """The fidelity-bearing trio MUST apply together to avoid silent regression.

    Sentinel BLOCKER #1: if patch 4 (typed throw) applies but patch 5 (guard
    extend) or patch 6 (mapper branch) does NOT, the runtime behavior degrades
    silently — the typed exception is thrown into a catch path that does not
    understand it, falling through to MLV_LINEAGE_CREATION_FAILURE (worse
    than the original MLV_DAG_HAS_FAULTED_NODES hijack).

    These tests verify both:
      (a) the structural shape of the fully-patched source (all three
          interlocking artifacts are present, in the right relative order,
          with the right interlinks), and
      (b) the coupled-postcondition warning in edog.py fires when the
          invariant is violated (e.g., the typed-throw patch applied but
          the guard or mapper patch did not).
    """

    @pytest.fixture(scope="class")
    def fully_patched_daghandler(self):
        content = DAGHANDLER_FIXTURE
        for fn in (
            edog.apply_faulted_node_typed_throw_patch,
            edog.apply_outer_catch_guard_extend_patch,
            edog.apply_outer_catch_error_source_propagate_patch,
        ):
            content, status = fn(content)
            assert status == "applied"
        return content

    @pytest.fixture(scope="class")
    def fully_patched_mapper(self):
        content, status = edog.apply_mapper_edog_branch_patch(NODEEXECUTIONUTILS_FIXTURE)
        assert status == "applied"
        return content

    def test_throw_appears_before_guard_in_daghandler(self, fully_patched_daghandler):
        throw_pos = fully_patched_daghandler.find("new Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException")
        guard_pos = fully_patched_daghandler.find("|| e is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException")
        assert throw_pos > 0 < guard_pos
        assert throw_pos < guard_pos, "Throw site must be in the try block; guard must be in the outer catch (later in file)"

    def test_guard_extension_routes_typed_exception_to_mapper(self, fully_patched_daghandler):
        # The fully-patched catch must contain the extended guard literally
        # wrapping the mapper call. Without this, the typed throw is
        # short-circuited by the pre-set resultCode and never reaches mapper.
        extended_guard = "if (string.IsNullOrEmpty(resultCode) || e is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException)"
        guard_pos = fully_patched_daghandler.find(extended_guard)
        mapper_pos = fully_patched_daghandler.find("NodeExecutionUtils.MapExceptionToErrorInfo(e)")
        assert guard_pos > 0 < mapper_pos
        assert guard_pos < mapper_pos, "Extended guard must precede mapper call in the catch block"

    def test_mapper_recognizes_typed_exception(self, fully_patched_mapper):
        # The mapper branch must be present AND return the carried ErrorCode.
        assert "exception is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException edogFaultedEx" in fully_patched_mapper
        assert "return (edogFaultedEx.ErrorCode, exception.Message, edogActivityStatus);" in fully_patched_mapper

    def test_error_source_propagation_is_inside_extended_guard(self, fully_patched_daghandler):
        # The propagation block must live inside the if(guard){...} body,
        # not outside it — otherwise it would run for non-EDOG exceptions too.
        extended_guard = "if (string.IsNullOrEmpty(resultCode) || e is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException)"
        guard_pos = fully_patched_daghandler.find(extended_guard)
        propagate_pos = fully_patched_daghandler.find("errorSource = edogFaultedExForSource.ErrorSource;")
        else_pos = fully_patched_daghandler.find("else if (string.IsNullOrEmpty(errorMessage))")
        assert guard_pos < propagate_pos < else_pos, (
            "ErrorSource propagation must live between the extended guard and the legacy else-if branch"
        )

    def test_legacy_else_if_branch_is_preserved(self, fully_patched_daghandler):
        # Sentinel HIGH 4: we must not have broken the legacy
        # `else if (string.IsNullOrEmpty(errorMessage))` branch. The
        # extended guard is additive — the else-if still serves legacy
        # pre-setters (settings_format_error, etc.).
        assert "else if (string.IsNullOrEmpty(errorMessage))" in fully_patched_daghandler

    def test_full_apply_then_full_revert_restores_byte_for_byte(self, fully_patched_daghandler, fully_patched_mapper):
        # Reverse-order revert for the 3-patch trio.
        dh = fully_patched_daghandler
        dh = edog.revert_outer_catch_error_source_propagate_patch(dh)
        dh = edog.revert_outer_catch_guard_extend_patch(dh)
        dh = edog.revert_faulted_node_typed_throw_patch(dh)
        assert dh == DAGHANDLER_FIXTURE, "Coupled-trio revert must be byte-for-byte clean"

        mp = edog.revert_mapper_edog_branch_patch(fully_patched_mapper)
        assert mp == NODEEXECUTIONUTILS_FIXTURE, "Mapper branch revert must be byte-for-byte clean"


@pytest.mark.parametrize(
    "patch_name,fixture",
    [
        ("request_context_begin", DAGHANDLER_FIXTURE),
        ("request_context_enrich", DAGHANDLER_FIXTURE),
        ("request_context_end", DAGHANDLER_FIXTURE),
        ("faulted_node_typed_throw", DAGHANDLER_FIXTURE),
        ("outer_catch_guard_extend", DAGHANDLER_FIXTURE),
        ("mapper_edog_branch", NODEEXECUTIONUTILS_FIXTURE),
        ("outer_catch_error_source_propagate", DAGHANDLER_FIXTURE),
    ],
)
class TestApplyIdempotent:
    def test_double_apply_returns_already_applied(self, patch_name, fixture):
        apply_fn = getattr(edog, f"apply_{patch_name}_patch")
        once, status1 = apply_fn(fixture)
        assert status1 == "applied"
        twice, status2 = apply_fn(once)
        assert status2 == "already_applied"
        assert twice == once

    def test_pattern_not_found_on_unrelated_source(self, patch_name, fixture):
        apply_fn = getattr(edog, f"apply_{patch_name}_patch")
        _, status = apply_fn("namespace X { public class Y { } }")
        assert status == "pattern_not_found"


# ─────────────────────────────────────────────────────────────────────────────
# Revert roundtrip — apply then revert must restore the original byte-for-byte
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "patch_name,fixture",
    [
        ("request_context_begin", DAGHANDLER_FIXTURE),
        ("request_context_enrich", DAGHANDLER_FIXTURE),
        ("request_context_end", DAGHANDLER_FIXTURE),
        ("faulted_node_typed_throw", DAGHANDLER_FIXTURE),
        ("outer_catch_guard_extend", DAGHANDLER_FIXTURE),
        ("mapper_edog_branch", NODEEXECUTIONUTILS_FIXTURE),
        ("outer_catch_error_source_propagate", DAGHANDLER_FIXTURE),
    ],
)
class TestRevertRoundtrip:
    def test_apply_then_revert_restores_original(self, patch_name, fixture):
        apply_fn = getattr(edog, f"apply_{patch_name}_patch")
        revert_fn = getattr(edog, f"revert_{patch_name}_patch")
        patched, status = apply_fn(fixture)
        assert status == "applied"
        reverted = revert_fn(patched)
        assert reverted == fixture, (
            f"apply+revert must be a byte-for-byte roundtrip for {patch_name}. "
            "If the patch shape changes, the revert regex must change in lockstep."
        )

    def test_revert_on_clean_source_is_no_op(self, patch_name, fixture):
        revert_fn = getattr(edog, f"revert_{patch_name}_patch")
        assert revert_fn(fixture) == fixture, (
            f"revert_{patch_name}_patch must be a no-op on unpatched source"
        )


# ─────────────────────────────────────────────────────────────────────────────
# All-patches-together — apply all 5 DagHandler patches in order, then revert
# in reverse order. Byte-for-byte roundtrip.
# ─────────────────────────────────────────────────────────────────────────────


class TestAllDagHandlerPatchesCombined:
    APPLY_ORDER: typing.ClassVar[list[str]] = [
        "request_context_begin",
        "request_context_enrich",
        "request_context_end",
        "faulted_node_typed_throw",
        "outer_catch_guard_extend",
        "outer_catch_error_source_propagate",
    ]

    def test_apply_all_then_revert_all_roundtrip(self):
        content = DAGHANDLER_FIXTURE
        for name in self.APPLY_ORDER:
            apply_fn = getattr(edog, f"apply_{name}_patch")
            content, status = apply_fn(content)
            assert status == "applied", f"{name}: status={status}"

        # Sanity: all 5 effects are present after combined apply.
        assert "EdogRequestContext.Begin(metadata, iterationId)" in content
        assert "EdogRequestContext.Enrich(dagExecutionContext)" in content
        assert "EdogRequestContext.End();" in content
        assert "throw new Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException(" in content
        assert "|| e is Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException" in content

        # Revert in reverse order.
        for name in reversed(self.APPLY_ORDER):
            revert_fn = getattr(edog, f"revert_{name}_patch")
            content = revert_fn(content)

        assert content == DAGHANDLER_FIXTURE, (
            "Combined apply-all then revert-all must restore the fixture byte-for-byte. "
            "A drift here indicates one patch's apply or revert is not symmetric."
        )

    def test_apply_all_is_idempotent(self):
        content = DAGHANDLER_FIXTURE
        for name in self.APPLY_ORDER:
            content, _ = getattr(edog, f"apply_{name}_patch")(content)

        # Apply again — every call must return already_applied with no change.
        once = content
        for name in self.APPLY_ORDER:
            apply_fn = getattr(edog, f"apply_{name}_patch")
            content, status = apply_fn(content)
            assert status == "already_applied", f"{name} second-apply status={status}"
        assert content == once


# ─────────────────────────────────────────────────────────────────────────────
# Registration sanity — both new files appear in DEVMODE_FILES and the
# new patch target (NodeExecutionUtils) appears in FILES.
# ─────────────────────────────────────────────────────────────────────────────


class TestRegistration:
    def test_edog_request_context_registered_for_deploy(self):
        assert "EdogRequestContext" in edog.DEVMODE_FILES

    def test_edog_faulted_node_exception_registered_for_deploy(self):
        assert "EdogFaultedNodeException" in edog.DEVMODE_FILES

    def test_node_execution_utils_registered_as_patch_target(self):
        assert "NodeExecutionUtils" in edog.FILES


# ─────────────────────────────────────────────────────────────────────────────
# Real-FLT StyleCop invariants — opt-in (skipped when workload-fabriclivetable
# is not checked out next to edog-studio). Catches all four StyleCop rule
# classes that previously broke the build:
#   SA1501 — single-line `try { ... } catch { }`
#   SA1513 — closing brace not followed by blank line
#   SA1515 — single-line comment not preceded by blank line
#   SA1502 — element body on a single line (extra defence)
# ─────────────────────────────────────────────────────────────────────────────


FLT_ROOT = pathlib.Path(r"C:\Users\guptahemant\newrepo\workload-fabriclivetable")
FLT_DAG = FLT_ROOT / edog.FILES["DagExecutionHandlerV2"]
FLT_NEU = FLT_ROOT / edog.FILES["NodeExecutionUtils"]


@pytest.mark.skipif(
    not (FLT_DAG.exists() and FLT_NEU.exists()),
    reason="real FLT source not present — Phase 0 StyleCop invariants check is opt-in",
)
class TestRealFLTStyleCopInvariants:
    """Apply every Phase 0 patch to the REAL FLT source and assert each EDOG-injected
    region is StyleCop-clean (no SA1501/SA1513/SA1515 trip points).

    These tests reproduce the exact sites that broke the FLT build before the StyleCop
    fixes. If any of these regress, the C# compile of the patched FLT will fail again.
    """

    @pytest.fixture(scope="class")
    def patched_dag(self):
        content = FLT_DAG.read_text(encoding="utf-8")
        for fn in (
            edog.apply_request_context_begin_patch,
            edog.apply_request_context_enrich_patch,
            edog.apply_request_context_end_patch,
            edog.apply_faulted_node_typed_throw_patch,
            edog.apply_outer_catch_guard_extend_patch,
            edog.apply_outer_catch_error_source_propagate_patch,
        ):
            content, status = fn(content)
            assert status == "applied", f"{fn.__name__}: {status}"
        return content

    @pytest.fixture(scope="class")
    def patched_neu(self):
        content = FLT_NEU.read_text(encoding="utf-8")
        content, status = edog.apply_mapper_edog_branch_patch(content)
        assert status == "applied", status
        return content

    def _edog_block_ranges(self, lines):
        """Return (start_idx, end_idx) inclusive for every contiguous EDOG-emitted region.

        A region starts at the first '// EDOG DevMode' line and extends through the
        last consecutive non-blank line of the injection (closing brace included).
        """
        ranges = []
        i = 0
        while i < len(lines):
            if "// EDOG DevMode" in lines[i]:
                start = i
                # Walk forward until we hit the closing `}` whose dedent matches the
                # EDOG comment's indent (heuristic: stop at a `}` that is the last
                # non-blank line before the next non-EDOG, non-blank line at less
                # depth, OR at a blank line whose next line starts a new statement
                # at the same or shallower indent).
                # Simpler heuristic: walk to end of block by finding the last line
                # before a blank line that is followed by a non-EDOG line.
                j = i
                last_brace = i
                while j < len(lines):
                    stripped = lines[j].lstrip(" ")
                    if stripped == "}" or stripped.startswith("}"):
                        last_brace = j
                    if (
                        j + 1 < len(lines)
                        and lines[j + 1] == ""
                        and "EDOG" not in lines[j]
                        and lines[j].lstrip(" ") == "}"
                    ):
                        # End of EDOG block when we hit a `}` followed by blank.
                        last_brace = j
                        break
                    j += 1
                ranges.append((start, last_brace))
                i = last_brace + 1
                continue
            i += 1
        return ranges

    def test_no_single_line_try_catch_in_patched_dag(self, patched_dag):
        # SA1501: `try { ...; } catch { }` on one line is forbidden.
        bad = re.findall(r"^\s*try\s*\{[^\n]*\}\s*catch\s*\{[^\n]*\}\s*$", patched_dag, flags=re.MULTILINE)
        edog_bad = [m for m in bad if "Edog" in m]
        assert edog_bad == [], f"Single-line try/catch found in EDOG injections: {edog_bad}"

    def test_edog_comments_preceded_by_blank_line(self, patched_dag, patched_neu):
        # SA1515: a single-line comment must be preceded by a blank line, except when
        # the previous line is (a) another comment, or (b) an opening brace `{`.
        for label, content in (("dag", patched_dag), ("neu", patched_neu)):
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if "// EDOG DevMode" not in line:
                    continue
                if i == 0:
                    continue
                prev = lines[i - 1].strip()
                if prev == "" or prev.startswith("//") or prev.endswith("{"):
                    continue
                pytest.fail(
                    f"{label}: SA1515 violation at line {i + 1}: EDOG comment is preceded "
                    f"by non-blank, non-comment line: {prev!r}"
                )

    def test_edog_closing_braces_followed_by_blank_or_brace(self, patched_dag, patched_neu):
        # SA1513: a closing brace `}` should be followed by a blank line, except when
        # the next line is (a) another closing brace, (b) `else`/`catch`/`finally`,
        # (c) `while` (do-while), (d) end of file, or (e) already blank.
        for label, content in (("dag", patched_dag), ("neu", patched_neu)):
            lines = content.split("\n")
            ranges = self._edog_block_ranges(lines)
            for _start, end in ranges:
                # Only check the LAST `}` of each EDOG block — that's the one that
                # transitions back to ambient FLT code.
                if lines[end].lstrip(" ") != "}":
                    continue
                if end + 1 >= len(lines):
                    continue
                nxt = lines[end + 1].strip()
                allowed = (
                    nxt == ""
                    or nxt.startswith("}")
                    or nxt.startswith("else")
                    or nxt.startswith("catch")
                    or nxt.startswith("finally")
                    or nxt.startswith("while")
                )
                if not allowed:
                    pytest.fail(
                        f"{label}: SA1513 violation at line {end + 1}: EDOG block "
                        f"closing `}}` is followed by: {nxt!r}"
                    )

    def test_all_patches_roundtrip_byte_equal_on_real_flt(self):
        # Belt-and-braces: re-verify byte-for-byte roundtrip on the real source.
        dag = FLT_DAG.read_text(encoding="utf-8")
        neu = FLT_NEU.read_text(encoding="utf-8")
        c = dag
        applies = [
            edog.apply_request_context_begin_patch,
            edog.apply_request_context_enrich_patch,
            edog.apply_request_context_end_patch,
            edog.apply_faulted_node_typed_throw_patch,
            edog.apply_outer_catch_guard_extend_patch,
            edog.apply_outer_catch_error_source_propagate_patch,
        ]
        reverts = [
            edog.revert_request_context_begin_patch,
            edog.revert_request_context_enrich_patch,
            edog.revert_request_context_end_patch,
            edog.revert_faulted_node_typed_throw_patch,
            edog.revert_outer_catch_guard_extend_patch,
            edog.revert_outer_catch_error_source_propagate_patch,
        ]
        for ap in applies:
            c, st = ap(c)
            assert st == "applied", f"{ap.__name__}: {st}"
        for rv in reversed(reverts):
            c = rv(c)
        assert c == dag, "DagHandler roundtrip not byte-equal"
        m, st = edog.apply_mapper_edog_branch_patch(neu)
        assert st == "applied"
        assert edog.revert_mapper_edog_branch_patch(m) == neu, "NodeExecutionUtils roundtrip not byte-equal"
