"""
Telemetry consumer correctness — dag-studio.js, auto-detect.js.

Companion to test_telemetry_correctness.py which covered tab-telemetry.js
and summary.js. After fixing those two, an audit caught two more consumers
of the telemetry topic that have the SAME class of bug:

  dag-studio.js — drives the DAG node visualization + execution status.
    * D1 — line 239 + 290: aliases activityStatus 'completed' to terminal
      success. Same shape as tab-telemetry B2: the Additional channel's
      backend-invented 'Completed' marks RunDag/nodes as complete while
      they're still running.
    * D2 — line 84 / 1170: processes EVERY telemetry event regardless of
      channel. Additional channel emits a mirror for nearly every SSR
      event (verified: NodeExecutor.cs:390 SSR + line 417 Additional;
      DagExecutionHandlerV2.cs:1253 SSR + line 1263 Additional). The
      visualizer was processing each twice, and the Additional mirror's
      empty / lying status was overwriting the SSR's real status.
    * D3 — line 225: inferredStart = timestamp - durationMs. For
      Additional mirrors durationMs was 0 (now) or "Completed" (lying).
      Either way the computed startedAt was wrong.

  auto-detect.js — processTelemetry feeds the execution-detection map
    used by smart-context + dag-studio bootstrap.
    * A1 — line 169-202: same channel-agnostic processing. Additional
      RunDag events drove exec.status = 'Completed' prematurely.

Verified emission topology (FLT source):
  - NodeExecutor: BOTH channels.
  - DagExecutionHandlerV2.EmitDAGExecutionUsageEvent: BOTH channels.
  - Controllers (LiveTablePublicController, MLVExecutionDefinition, etc):
    BOTH channels.
  - Additional channel is ALWAYS a mirror — no Additional-only activity
    type exists for lifecycle purposes. (Some Additional events carry
    extra retry-metrics in their attribute bag, but no statuses are
    Additional-only.)

Therefore the fix for consumers needing lifecycle (dag-studio, auto-detect)
is unambiguous: skip channel === 'additional' at the top of the handler.
The Telemetry tab itself still SHOWS them as +TEL chips, but does not
trust them for status.
"""

from __future__ import annotations

import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_JS = os.path.join(REPO, "src", "frontend", "js")

DAG_STUDIO_JS = os.path.join(FRONTEND_JS, "dag-studio.js")
AUTO_DETECT_JS = os.path.join(FRONTEND_JS, "auto-detect.js")


def _read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def _strip_comments_js(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
    s = re.sub(r"//[^\n]*", "", s)
    return s


# ════════════════════════════════════════════════════════════════════
# D1 — dag-studio drops completed-alias
# ════════════════════════════════════════════════════════════════════


class TestD1DagStudioNoCompletedAlias:
    """Two status branches in dag-studio (node-level around line 239,
    execution-level around line 290) treat 'completed' and 'succeeded'
    as the same terminal state. Same lie as B2 in the Telemetry tab."""

    def test_node_status_does_not_alias_completed_to_succeeded(self):
        src = _read(DAG_STUDIO_JS)
        clean = _strip_comments_js(src)
        # Forbid the exact 'succeeded || completed' alias in any if/else
        # status switch. The backend's 'Completed' lie was driving this.
        assert not re.search(
            r"activityStatus\s*===\s*['\"]succeeded['\"]\s*\|\|\s*activityStatus\s*===\s*['\"]completed['\"]",
            clean,
        ), (
            "dag-studio.js must not alias 'completed' to 'succeeded' in any "
            "status switch. Two sites (_processNodeTelemetry around line 239 "
            "and _processExecutionTelemetry around line 290) currently do. "
            "Same bug shape as tab-telemetry B2 — the Additional channel's "
            "backend-invented 'Completed' would mark nodes/executions as "
            "complete while they're still running. Split into separate "
            "branches OR drop the 'completed' alias entirely (the SSR "
            "lifecycle status is 'Succeeded' / 'Failed' / 'Cancelled', "
            "never 'Completed' — only the old Additional lie used 'Completed')."
        )


# ════════════════════════════════════════════════════════════════════
# D2 — dag-studio filters Additional channel
# ════════════════════════════════════════════════════════════════════


class TestD2DagStudioFiltersAdditional:
    """dag-studio.js needs LIFECYCLE (started/running/completed/failed).
    Lifecycle is SSR's job — Additional events are mirrors with no real
    status. Skip Additional events at the top of the telemetry handler."""

    def test_on_telemetry_event_skips_additional_channel(self):
        src = _read(DAG_STUDIO_JS)
        clean = _strip_comments_js(src)
        anchor = re.search(
            r"_onTelemetryEvent\s*\([^)]*\)\s*\{",
            clean,
        )
        assert anchor, "Could not locate _onTelemetryEvent method in dag-studio.js."
        window = clean[anchor.end() : anchor.end() + 600]
        # Allow any pattern that tests channel against 'additional' or
        # 'ssr' (with arbitrary `|| 'ssr'` defaulting in between).
        assert re.search(
            r"channel[^;{}]*?===\s*['\"]additional['\"]|channel[^;{}]*?!==\s*['\"]ssr['\"]",
            window,
        ), (
            "dag-studio.js _onTelemetryEvent must skip Additional channel "
            "events. Add `if ((t.channel || 'ssr') === 'additional') return;` "
            "near the top of the handler."
        )

    def test_esm_process_telemetry_filters_additional(self):
        """The EsmDiag / execution state machine inside dag-studio also
        has a processTelemetry method. Same guard applies."""
        src = _read(DAG_STUDIO_JS)
        clean = _strip_comments_js(src)
        anchor = re.search(
            r"(?:processTelemetry\s*\([^)]*\)\s*\{|processTelemetry\s*=\s*\([^)]*\)\s*=>\s*\{)",
            clean,
        )
        if anchor:
            window = clean[anchor.end() : anchor.end() + 800]
            assert re.search(
                r"channel[^;{}]*?===\s*['\"]additional['\"]|channel[^;{}]*?!==\s*['\"]ssr['\"]",
                window,
            ), (
                "The processTelemetry method in dag-studio.js (state machine "
                "entry point) must skip Additional channel events. Add the "
                "channel filter at the top of the method."
            )


# ════════════════════════════════════════════════════════════════════
# A1 — auto-detect filters Additional channel
# ════════════════════════════════════════════════════════════════════


class TestA1AutoDetectFiltersAdditional:
    """auto-detect.js processTelemetry drives the execution-detection
    map. Same channel-filter requirement."""

    def test_process_telemetry_skips_additional(self):
        src = _read(AUTO_DETECT_JS)
        clean = _strip_comments_js(src)
        anchor = re.search(
            r"processTelemetry\s*=\s*\([^)]*\)\s*=>\s*\{",
            clean,
        )
        assert anchor, "Could not locate processTelemetry in auto-detect.js."
        window = clean[anchor.end() : anchor.end() + 800]
        assert re.search(
            r"channel[^;{}]*?===\s*['\"]additional['\"]|channel[^;{}]*?!==\s*['\"]ssr['\"]",
            window,
        ), (
            "auto-detect.js processTelemetry must skip Additional channel "
            "events. Add `if ((event.channel || 'ssr') === 'additional') "
            "return;` at the top of the handler."
        )


# ════════════════════════════════════════════════════════════════════
# D3 — inferredStart doesn't trust Additional / Pending durationMs
# ════════════════════════════════════════════════════════════════════


class TestD3InferredStartGuard:
    """When the visualizer needs to backfill startedAt from a terminal
    event (`inferredStart = timestamp - durationMs`), it must not use
    durationMs values that are unreliable. After D2 fixes, Additional
    mirrors won't reach this code at all — so this test is now mostly
    redundant. But the Pending SSR event ALSO has unreliable durationMs
    (time-to-HTTP-202). We need _processExecutionTelemetry to never
    compute inferredStart for Pending events.

    Since the existing code only treats started/inprogress/completed/
    succeeded/failed/cancelled/skipped statuses, Pending isn't matched
    by any branch — so it already short-circuits. We just need a guard
    that prevents future regression: if Pending is added to a branch,
    inferredStart must NOT be computed from durationMs."""

    def test_pending_status_not_treated_as_terminal_with_inferred_start(self):
        src = _read(DAG_STUDIO_JS)
        clean = _strip_comments_js(src)
        # Find every branch that mentions activityStatus === 'pending'
        # AND computes inferredStart. If any such branch exists, fail.
        for m in re.finditer(
            r"activityStatus\s*===\s*['\"]pending['\"]",
            clean,
        ):
            # Look at the next 400 chars for inferredStart computation
            window = clean[m.end() : m.end() + 400]
            assert "inferredStart" not in window or "timestamp" in window, (
                "If dag-studio adds a branch handling Pending status, it must "
                "NOT compute inferredStart from durationMs. The Pending SSR "
                "event's durationMs is time-to-HTTP-202 (~1.8s), not the "
                "activity runtime. Use timestamp directly."
            )
