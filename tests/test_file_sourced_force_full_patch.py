"""
File-sourced force-FULL + node-completion telemetry — patch generator tests.

These two patches together close the "armed fault never fires on file-sourced
MLVs" bug:

  1. ``apply_file_sourced_force_full_patch`` — at the top of
     ``ExecuteFileSourcedNodeAsync`` in DagExecutionHandlerV2.cs, consults
     ``EdogHttpFaultStore.HasArmedFaultForNode`` and treats the run as FULL
     when a Channel 1/2/4 rule is armed. This is what guarantees a
     ``/customTransformExecution`` call happens (NO_NEW_DATA short-circuit
     skipped) so the HTTP fault store can intercept.

     Correctness pin: BOTH ``if (isFullRefreshMode)`` (the FULL-path branch)
     AND ``if (!isFullRefreshMode)`` (the finalization guard) must be
     redirected to the new ``effectiveFullRefreshMode``. Replacing only the
     first is a real bug — finalization would run APPEND/MIRROR logic against
     a FULL-mode submission. The rubber-duck reviewer caught this and the
     tests below pin both replacements.

  2. ``apply_node_completion_telemetry_patch`` — right after FLT fetches
     ``currentNodeExecutionMetrics`` (the canonical place where final
     NodeExecutionStatus is known, even for "fail without throwing" nodes),
     calls ``EdogErrorSimEngine.OnNodeExecutionCompleted`` so the engine can
     publish per-rule match telemetry to the ``dag`` topic. This is what
     drives the armed/matched/unmatched status pills in the Active
     Injections panel.

The tests use minimal synthetic fixtures so failures point at a specific
patched line, not at ambient FLT noise.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("edog", str(REPO / "edog.py"))
edog = importlib.util.module_from_spec(_spec)
sys.path.insert(0, str(REPO))
_cwd = os.getcwd()
try:
    os.chdir(REPO)
    _spec.loader.exec_module(edog)
finally:
    os.chdir(_cwd)


# ── Synthetic FLT slice for the force-FULL patch ─────────────────────────────
# Mirrors the relevant block from ExecuteFileSourcedNodeAsync. The patch
# anchors on `bool isFullRefreshMode = string.Equals(\n` and the closing
# `node.FileSourceInfo?.RefreshMode, "FULL", ...);` line, then redirects the
# two `if (isFullRefreshMode)` / `if (!isFullRefreshMode)` usages.
#
# NOTE: the opener line ("bool isFullRefreshMode") and the closing
# continuation line have DIFFERENT indents in real FLT source (the
# continuation is indented deeper for readability). The patcher must
# use the OPENER's indent for new sibling declarations or StyleCop
# SA1137 will fail the build. The fixture mirrors that asymmetric shape.

_FORCE_FULL_FIXTURE = """\
                // Check refresh mode — FULL skips change detection entirely.
                bool isFullRefreshMode = string.Equals(
                    node.FileSourceInfo?.RefreshMode, "FULL", StringComparison.OrdinalIgnoreCase);

                if (isFullRefreshMode)
                {
                    await this.fileIngestionHandler.SubmitFullRefreshAsync(node, dagExecInstance, token);
                    return NodeExecutionStatus.Completed;
                }

                var refreshResult = await this.fileIngestionHandler.ExecuteAsync(node, dagExecInstance, token);
                if (refreshResult == null || !refreshResult.HasChanges)
                {
                    return NodeExecutionStatus.Completed;
                }

                if (!isFullRefreshMode)
                {
                    await this.fileIngestionHandler.FinalizeAppendAsync(node, dagExecInstance, token);
                }
                return NodeExecutionStatus.Completed;
"""


# ── Synthetic FLT slice for the completion-telemetry patch ───────────────────

_COMPLETION_FIXTURE = """\
foreach (var node in dag.Nodes)
{
    Task.Run(async () =>
    {
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
"""


def _normalize(s: str) -> str:
    """Strip per-line trailing whitespace and force a single trailing newline."""
    return re.sub(r"[ \t]+\n", "\n", s).rstrip() + "\n"


# ─────────────────────────────────────────────────────────────────────────────
# apply_file_sourced_force_full_patch
# ─────────────────────────────────────────────────────────────────────────────


class TestForceFullPatchGenerator:
    def test_apply_function_exists(self):
        assert hasattr(edog, "apply_file_sourced_force_full_patch")

    def test_revert_function_exists(self):
        assert hasattr(edog, "revert_file_sourced_force_full_patch")

    @pytest.fixture(scope="class")
    def patched(self):
        patched, status = edog.apply_file_sourced_force_full_patch(_FORCE_FULL_FIXTURE)
        assert status == "applied", f"Patch did not apply: {status}"
        return patched

    def test_inserts_edog_force_full_bool(self, patched):
        assert "bool edogForceFullRefresh = " in patched
        assert "EdogHttpFaultStore.HasArmedFaultForNode(node.NodeId.ToString())" in patched

    def test_inserts_effective_mode_disjunction(self, patched):
        # The effective mode is the OR of the existing flag and the EDOG flag.
        # If we ever changed this to AND or replaced the original, every
        # genuine FULL refresh would be subject to the EDOG check — a bug.
        assert "bool effectiveFullRefreshMode = isFullRefreshMode || edogForceFullRefresh;" in patched

    def test_redirects_full_branch(self, patched):
        # The FULL-path branch must be driven by the effective mode so an
        # armed fault triggers it even when the source mode is APPEND/MIRROR.
        assert "if (effectiveFullRefreshMode)" in patched
        # And the original must be gone for that occurrence.
        assert patched.count("if (isFullRefreshMode)") == 0, (
            "Old `if (isFullRefreshMode)` must be replaced — using the original "
            "skips the FULL submit when the user armed a fault on a file-sourced node."
        )

    def test_redirects_finalization_guard(self, patched):
        # CORRECTNESS PIN: the finalization guard ALSO must reference the
        # effective mode. Replacing only the first if-branch leaves
        # finalization running APPEND/MIRROR logic against a FULL submission.
        # The rubber-duck reviewer caught this exact bug — keep it pinned.
        assert "if (!effectiveFullRefreshMode)" in patched
        assert patched.count("if (!isFullRefreshMode)") == 0, (
            "Finalization guard must reference effectiveFullRefreshMode, not "
            "the raw mode flag. Bug caught in code review — do not regress."
        )

    def test_preserves_original_isFullRefreshMode_declaration(self, patched):
        # We only add a new declaration; the original `bool isFullRefreshMode = ...`
        # must remain because the disjunction reads from it.
        assert "bool isFullRefreshMode = string.Equals(" in patched

    def test_guardrail_comment_present(self, patched):
        # The patch ships with a long-form comment explaining the bug — this
        # prevents a future engineer from "tidying" the code and losing the
        # context that explains why this OR exists.
        assert "EDOG DevMode" in patched
        assert "Error Simulator" in patched

    def test_inserted_lines_share_opener_indent(self, patched):
        """SA1137 regression pin.

        StyleCop SA1137 fails the FLT build when sibling statements use
        different indents. The opener `bool isFullRefreshMode = ...` sits at
        16 spaces in the real FLT source; the continuation line is indented
        deeper (20 spaces) for readability. The patcher MUST use the OPENER's
        indent for the new sibling declarations — using the continuation
        line's indent (the old bug) produces:
            DagExecutionHandlerV2.cs(1494,1): error SA1137
        """
        # Pull the opener indent from the fixture directly.
        opener_line = next(
            line for line in _FORCE_FULL_FIXTURE.splitlines()
            if "bool isFullRefreshMode = string.Equals(" in line
        )
        opener_indent = opener_line[: len(opener_line) - len(opener_line.lstrip(" "))]

        # The two new bools must start at the SAME column as the opener.
        for marker in ("bool edogForceFullRefresh =", "bool effectiveFullRefreshMode ="):
            line = next(
                (line for line in patched.splitlines() if marker in line),
                None,
            )
            assert line is not None, f"Patched output missing: {marker}"
            actual_indent = line[: len(line) - len(line.lstrip(" "))]
            assert actual_indent == opener_indent, (
                f"SA1137 regression: `{marker}` is indented {len(actual_indent)} "
                f"spaces but the opener (`bool isFullRefreshMode`) is indented "
                f"{len(opener_indent)} spaces. Sibling statements MUST share "
                f"indentation or StyleCop fails the FLT build."
            )


class TestForceFullPatchIdempotent:
    def test_already_applied_returns_unchanged(self):
        patched_once, status1 = edog.apply_file_sourced_force_full_patch(_FORCE_FULL_FIXTURE)
        assert status1 == "applied"
        patched_twice, status2 = edog.apply_file_sourced_force_full_patch(patched_once)
        assert status2 == "already_applied"
        assert patched_twice == patched_once

    def test_missing_marker_no_change(self):
        _result, status = edog.apply_file_sourced_force_full_patch(
            "namespace X { public class Y { } }"
        )
        assert status == "pattern_not_found"


class TestForceFullRevertRoundtrip:
    def test_apply_then_revert_restores_original(self):
        patched, status = edog.apply_file_sourced_force_full_patch(_FORCE_FULL_FIXTURE)
        assert status == "applied"
        reverted = edog.revert_file_sourced_force_full_patch(patched)
        # Normalize trailing whitespace per line; the regex revert can leave
        # a single trailing newline difference at the splice site.
        assert _normalize(reverted) == _normalize(_FORCE_FULL_FIXTURE), (
            "Revert must restore the file byte-for-byte (modulo trailing whitespace)."
        )

    def test_revert_leaves_unrelated_text_alone(self):
        unrelated = "// totally unrelated file\nvoid Foo() { }\n"
        assert edog.revert_file_sourced_force_full_patch(unrelated) == unrelated


# ─────────────────────────────────────────────────────────────────────────────
# apply_node_completion_telemetry_patch
# ─────────────────────────────────────────────────────────────────────────────


class TestCompletionTelemetryPatchGenerator:
    def test_apply_function_exists(self):
        assert hasattr(edog, "apply_node_completion_telemetry_patch")

    def test_revert_function_exists(self):
        assert hasattr(edog, "revert_node_completion_telemetry_patch")

    @pytest.fixture(scope="class")
    def patched(self):
        patched, status = edog.apply_node_completion_telemetry_patch(_COMPLETION_FIXTURE)
        assert status == "applied", f"Patch did not apply: {status}"
        return patched

    def test_invokes_engine_method(self, patched):
        assert "EdogErrorSimEngine.OnNodeExecutionCompleted(" in patched

    def test_passes_guid_nodeid(self, patched):
        # nodeId must be the Guid string — same contract as the AsyncLocal
        # context fix. Using node.Name would silently break match telemetry
        # for Channel 1/2 rules (which are registered by Guid).
        assert "node.NodeId.ToString()" in patched

    def test_passes_display_name(self, patched):
        assert "node.Name" in patched

    def test_passes_status_with_null_fallback(self, patched):
        # FLT can fail a node without throwing; reading the metrics object
        # is the only authoritative way to know the final state. The
        # null-fallback is required because the metrics object can be null
        # on early-skip paths.
        assert (
            'currentNodeExecutionMetrics?.Status.ToString() ?? "Unknown"' in patched
        ), "Status must be read from metrics with a defensive null-coalesce."

    def test_wraps_in_try_catch(self, patched):
        # Telemetry must never propagate exceptions back into the FLT host —
        # if EDOG breaks, FLT keeps running.
        match = re.search(
            r"try\s*\{[^}]*EdogErrorSimEngine\.OnNodeExecutionCompleted[^}]*\}\s*catch\s*\{",
            patched,
            re.DOTALL,
        )
        assert match, "OnNodeExecutionCompleted must be wrapped in try/catch."

    def test_inserted_after_metrics_fetch(self, patched):
        # The hook MUST come after FLT computes currentNodeExecutionMetrics
        # so we have the final status. If the patch ever moves earlier, the
        # status arg becomes garbage.
        fetch_idx = patched.find("NodeExecutionMetrics currentNodeExecutionMetrics")
        call_idx = patched.find("EdogErrorSimEngine.OnNodeExecutionCompleted")
        assert fetch_idx > -1 and call_idx > -1
        assert call_idx > fetch_idx, (
            "Telemetry call must be inserted AFTER metrics fetch — otherwise "
            "currentNodeExecutionMetrics is null/uninitialized at call time."
        )


class TestCompletionTelemetryIdempotent:
    def test_already_applied_returns_unchanged(self):
        patched_once, status1 = edog.apply_node_completion_telemetry_patch(_COMPLETION_FIXTURE)
        assert status1 == "applied"
        patched_twice, status2 = edog.apply_node_completion_telemetry_patch(patched_once)
        assert status2 == "already_applied"
        assert patched_twice == patched_once

    def test_missing_marker_no_change(self):
        _result, status = edog.apply_node_completion_telemetry_patch(
            "namespace X { public class Y { } }"
        )
        assert status == "pattern_not_found"


class TestCompletionTelemetryRevertRoundtrip:
    def test_apply_then_revert_restores_original(self):
        patched, status = edog.apply_node_completion_telemetry_patch(_COMPLETION_FIXTURE)
        assert status == "applied"
        reverted = edog.revert_node_completion_telemetry_patch(patched)
        assert _normalize(reverted) == _normalize(_COMPLETION_FIXTURE), (
            "Revert must restore the original metrics fetch line untouched."
        )


# ─────────────────────────────────────────────────────────────────────────────
# Wiring: both patches must be invoked from apply_all_changes / revert_all_changes
# ─────────────────────────────────────────────────────────────────────────────


class TestWiringIntoApplyAll:
    @pytest.fixture(scope="class")
    def edog_source(self) -> str:
        return (REPO / "edog.py").read_text(encoding="utf-8")

    def test_apply_all_invokes_force_full(self, edog_source):
        assert "apply_file_sourced_force_full_patch(" in edog_source

    def test_apply_all_invokes_completion_telemetry(self, edog_source):
        assert "apply_node_completion_telemetry_patch(" in edog_source

    def test_revert_all_invokes_force_full(self, edog_source):
        assert "revert_file_sourced_force_full_patch(" in edog_source

    def test_revert_all_invokes_completion_telemetry(self, edog_source):
        assert "revert_node_completion_telemetry_patch(" in edog_source
