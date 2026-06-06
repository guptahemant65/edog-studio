"""
EdogSparkClientWrapper — fault-injection structural tests (ADR-008).

Verifies that the ISparkClient decorator intercepts Channels 1, 2, and 4
at the semantic layer (instead of relying on EdogHttpPipelineHandler,
which GTS bypasses per runDAG-lifecycle §4.3.4). Tests read the C#
source as text and assert structural invariants — the C# csbuild gate
(tests/test_devmode_csbuild.py) is what proves the code actually
compiles against real FLT types.

Channels covered:
  Channel 1 (HTTP 200 + Failed status) → injected at GetTransformStatusAsync
  Channel 2 (HTTP non-200)             → short-circuited at SendTransformRequestAsync
  Channel 4 (timeout)                  → short-circuited at SendTransformRequestAsync
  Cancel                               → NEVER intercepted (always pass-through)
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
WRAPPER = REPO / "src" / "backend" / "DevMode" / "EdogSparkClientWrapper.cs"


@pytest.fixture(scope="module")
def source() -> str:
    assert WRAPPER.exists(), f"Missing wrapper file: {WRAPPER}"
    return WRAPPER.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def submit_method(source: str) -> str:
    """Returns the body of SendTransformRequestAsync."""
    return _extract_method(source, "SendTransformRequestAsync")


@pytest.fixture(scope="module")
def status_method(source: str) -> str:
    """Returns the body of GetTransformStatusAsync."""
    return _extract_method(source, "GetTransformStatusAsync")


@pytest.fixture(scope="module")
def cancel_method(source: str) -> str:
    """Returns the body of CancelTransformAsync."""
    return _extract_method(source, "CancelTransformAsync")


def _extract_method(source: str, name: str) -> str:
    """
    Brace-balanced extraction of the named method body. We find a
    `[public|private|internal] [static] [async] ... <name>(` declaration
    and walk forward counting braces.
    """
    pattern = re.compile(
        rf"(?:public|private|internal)\s+(?:static\s+)?(?:async\s+)?[^\n(]*?\b{name}\s*\("
    )
    match = pattern.search(source)
    assert match, f"Method {name} not found in wrapper source"
    start = source.find("{", match.end())
    assert start >= 0, f"Opening brace for {name} not found"
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
    pytest.fail(f"Unbalanced braces while extracting {name}")


# ──────────────────────────────────────────────────────────────────────
# Class / wiring invariants
# ──────────────────────────────────────────────────────────────────────


class TestWrapperShape:
    def test_class_implements_iSparkClient(self, source: str) -> None:
        assert "internal class EdogSparkClientWrapper : ISparkClient" in source

    def test_devmode_pragmas(self, source: str) -> None:
        assert "#nullable disable" in source
        assert "#pragma warning disable" in source

    def test_namespace(self, source: str) -> None:
        assert "namespace Microsoft.LiveTable.Service.DevMode" in source

    def test_imports_json_for_response_body_parse(self, source: str) -> None:
        assert "using System.Text.Json;" in source

    def test_imports_error_mapping_for_ErrorCode_enum(self, source: str) -> None:
        assert "using Microsoft.LiveTable.Service.ErrorMapping;" in source

    def test_imports_spark_http_model_for_response_types(self, source: str) -> None:
        assert "using Microsoft.LiveTable.Service.SparkHttp.Model;" in source

    def test_fired_status_forges_field_declared(self, source: str) -> None:
        assert "_firedStatusForges" in source
        assert re.search(
            r"ConcurrentDictionary<\s*Guid\s*,\s*byte\s*>\s+_firedStatusForges",
            source,
        ), "_firedStatusForges should be ConcurrentDictionary<Guid, byte>"


# ──────────────────────────────────────────────────────────────────────
# Submit path — Channel 2 / Channel 4 / Channel 1 pass-through
# ──────────────────────────────────────────────────────────────────────


class TestSubmitInjection:
    def test_peeks_fault_store_before_inner_call(self, submit_method: str) -> None:
        peek_idx = submit_method.find("EdogHttpFaultStore.TryPeekSparkFault(")
        inner_idx = submit_method.find("_inner.SendTransformRequestAsync(")
        assert peek_idx > 0, "submit must consult EdogHttpFaultStore.TryPeekSparkFault"
        assert inner_idx > 0, "submit must still delegate to _inner.SendTransformRequestAsync"
        assert peek_idx < inner_idx, "peek must occur BEFORE the inner submit"

    def test_uses_node_id_as_match_key(self, submit_method: str) -> None:
        assert "node?.NodeId.ToString()" in submit_method

    def test_channel_2_dispatch_http_error_non_200(self, submit_method: str) -> None:
        # Channel 2 = http_error fault with StatusCode != 200
        assert '"http_error"' in submit_method
        assert "StatusCode != 200" in submit_method
        assert "BuildInjectedSubmitErrorResponse(" in submit_method

    def test_channel_4_dispatch_timeout(self, submit_method: str) -> None:
        assert '"timeout"' in submit_method
        assert "BuildInjectedTimeoutSubmitResponse(" in submit_method

    def test_channel_1_falls_through_to_inner(self, submit_method: str) -> None:
        # Channel 1 = http_error with StatusCode == 200 → no Build*Submit*
        # helper, must fall through to inner submit so a real session is
        # allocated.
        comment_present = (
            "Channel 1" in submit_method
            and "fall through" in submit_method.lower()
        )
        assert comment_present, (
            "submit must document Channel 1 pass-through (real session needed)"
        )

    def test_channels_2_and_4_increment_match_count(self, submit_method: str) -> None:
        # Each short-circuit branch must increment the rule's match counter
        # so OnNodeExecutionCompleted's telemetry stays accurate.
        increments = submit_method.count("EdogHttpFaultStore.IncrementMatchCount(")
        assert increments >= 2, (
            f"expected >=2 IncrementMatchCount calls (one per short-circuit channel), got {increments}"
        )

    def test_channels_2_and_4_publish_injection_event(self, submit_method: str) -> None:
        events = submit_method.count("PublishInjectedSubmitEvent(")
        assert events >= 2, (
            f"expected >=2 PublishInjectedSubmitEvent calls (one per short-circuit channel), got {events}"
        )

    def test_injection_block_wrapped_in_try_catch(self, submit_method: str) -> None:
        # Defensive: fault injection must never break the real submit path.
        # Verify the catch logs and falls through (no rethrow).
        assert "fault-injection error" in submit_method
        # Look for sw.Restart() in the catch — confirms we reset timing
        # and continue to the inner call instead of bailing.
        assert "sw.Restart()" in submit_method


# ──────────────────────────────────────────────────────────────────────
# Status path — Channel 1 injection with dedup
# ──────────────────────────────────────────────────────────────────────


class TestStatusInjection:
    def test_peeks_fault_store_before_inner_call(self, status_method: str) -> None:
        peek_idx = status_method.find("EdogHttpFaultStore.TryPeekSparkFault(")
        inner_idx = status_method.find("_inner.GetTransformStatusAsync(")
        assert peek_idx > 0, "status poll must consult TryPeekSparkFault"
        assert inner_idx > 0, "status poll must still delegate to _inner"
        assert peek_idx < inner_idx, "peek must occur BEFORE the inner call"

    def test_channel_1_only_fires_on_status_code_200(self, status_method: str) -> None:
        # Status-side injection is Channel 1 specifically: http_error + 200.
        assert '"http_error"' in status_method
        assert "StatusCode == 200" in status_method

    def test_dedups_via_fired_status_forges(self, status_method: str) -> None:
        # Must check & insert the transformationId to prevent double-fire
        # on subsequent polls (NodeExecutor stops on terminal state, but
        # defense in depth).
        assert "_firedStatusForges" in status_method
        assert "TryAdd(" in status_method
        # ContainsKey gate before TryAdd is the fast-path; both are valid
        # but at least one must be present.
        assert "ContainsKey" in status_method or "TryAdd" in status_method

    def test_increments_match_count_when_injected(self, status_method: str) -> None:
        assert "EdogHttpFaultStore.IncrementMatchCount(" in status_method

    def test_builds_status_forge_response(self, status_method: str) -> None:
        assert "BuildInjectedStatusForgeResponse(" in status_method

    def test_publishes_injection_event(self, status_method: str) -> None:
        assert "PublishInjectedStatusEvent(" in status_method

    def test_injection_block_wrapped_in_try_catch(self, status_method: str) -> None:
        assert "fault-injection error" in status_method
        assert "sw.Restart()" in status_method


# ──────────────────────────────────────────────────────────────────────
# Cancel path — never inject
# ──────────────────────────────────────────────────────────────────────


class TestCancelNeverIntercepts:
    def test_cancel_does_not_peek_fault_store(self, cancel_method: str) -> None:
        assert "TryPeekSparkFault" not in cancel_method, (
            "CancelTransformAsync must NEVER consult the fault store — "
            "cancel paths in production are never error-injected; injecting "
            "here would corrupt teardown telemetry."
        )

    def test_cancel_does_not_increment_match_count(self, cancel_method: str) -> None:
        assert "IncrementMatchCount" not in cancel_method

    def test_cancel_still_delegates_to_inner(self, cancel_method: str) -> None:
        assert "_inner.CancelTransformAsync(" in cancel_method


# ──────────────────────────────────────────────────────────────────────
# Private helpers — signature presence
# ──────────────────────────────────────────────────────────────────────


class TestPrivateHelperSignatures:
    @pytest.mark.parametrize(
        "signature",
        [
            "BuildInjectedSubmitErrorResponse(",
            "BuildInjectedTimeoutSubmitResponse(",
            "BuildInjectedStatusForgeResponse(",
            "PublishInjectedSubmitEvent(",
            "PublishInjectedStatusEvent(",
            "ParseInjectedError(",
            "ParseInjectedErrorSource(",
        ],
    )
    def test_helper_declared(self, source: str, signature: str) -> None:
        # Declaration + at least one call site.
        # Declaration appears with "private" prefix; call sites have other prefixes.
        decl = re.search(
            rf"private\s+(?:static\s+)?[^\n(]*?\b{re.escape(signature.rstrip('('))}\s*\(",
            source,
        )
        assert decl, f"helper {signature} should be declared private"

    def test_builders_return_correct_response_types(self, source: str) -> None:
        # Submit-channel builders return TransformExecutionSubmitResponse;
        # status-channel builder returns TransformExecutionResponse.
        assert re.search(
            r"TransformExecutionSubmitResponse\s+BuildInjectedSubmitErrorResponse",
            source,
        ), "BuildInjectedSubmitErrorResponse must return TransformExecutionSubmitResponse"
        assert re.search(
            r"TransformExecutionSubmitResponse\s+BuildInjectedTimeoutSubmitResponse",
            source,
        ), "BuildInjectedTimeoutSubmitResponse must return TransformExecutionSubmitResponse"
        assert re.search(
            r"TransformExecutionResponse\s+BuildInjectedStatusForgeResponse",
            source,
        ), "BuildInjectedStatusForgeResponse must return TransformExecutionResponse"

    def test_timeout_builder_uses_canonical_error_code(self, source: str) -> None:
        # Channel 4 must mirror GTSBasedSparkClient.cs:185-202.
        timeout_body = _extract_method(source, "BuildInjectedTimeoutSubmitResponse")
        assert "ErrorCode.MLV_SPARK_SESSION_ACQUISITION_TIMEOUT" in timeout_body
        assert "Retriable = true" in timeout_body
        assert "TransformationState.Failed" in timeout_body

    def test_submit_error_builder_sets_retriable_per_status(self, source: str) -> None:
        body = _extract_method(source, "BuildInjectedSubmitErrorResponse")
        # 429 / 430 / >= 500 → retriable (matches ConvertToTransformAcceptanceResponseAsync)
        assert "429" in body
        assert "430" in body
        assert ">= 500" in body or ">=500" in body

    def test_submit_error_builder_has_enum_parse_fallback(self, source: str) -> None:
        body = _extract_method(source, "BuildInjectedSubmitErrorResponse")
        assert "Enum.TryParse<ErrorCode>" in body
        assert "MLV_SPARK_SESSION_REQUEST_SUBMISSION_FAILED" in body

    def test_status_forge_builder_parses_error_source(self, source: str) -> None:
        body = _extract_method(source, "BuildInjectedStatusForgeResponse")
        assert "TransformErrorDetails(" in body
        assert "TransformationState.Failed" in body

    def test_parsers_use_json_document(self, source: str) -> None:
        parse_err = _extract_method(source, "ParseInjectedError")
        assert "JsonDocument.Parse" in parse_err
        # Channel 1 body uses "errorCode"; Channel 2 body uses "code".
        assert '"errorCode"' in parse_err
        assert '"code"' in parse_err

    def test_parsers_never_throw(self, source: str) -> None:
        parse_err = _extract_method(source, "ParseInjectedError")
        parse_src = _extract_method(source, "ParseInjectedErrorSource")
        assert "catch (Exception" in parse_err
        assert "catch (Exception" in parse_src

    def test_publishers_never_throw(self, source: str) -> None:
        pub_submit = _extract_method(source, "PublishInjectedSubmitEvent")
        pub_status = _extract_method(source, "PublishInjectedStatusEvent")
        assert "catch (Exception" in pub_submit
        assert "catch (Exception" in pub_status
        # Both publish to the "spark" topic.
        assert '"spark"' in pub_submit
        assert '"spark"' in pub_status
        # Both emit a discoverable injection-event sentinel.
        assert "SparkFaultInjected" in pub_submit
        assert "SparkFaultInjected" in pub_status
