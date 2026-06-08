"""
Telemetry semantics correctness — failing tests pinning 5 bugs.

Root cause discovered from live data + reading FLT source:

  DagExecutionHandlerV2.EmitDAGExecutionUsageEvent (line 1217-1267):
    Fires BOTH channels in lockstep, twice per RunDag:
      1. When request accepted (HTTP 202): SSR status=Pending, Additional with no status.
      2. When DAG finishes: SSR status=Succeeded/Failed, Additional with no status.

  ILiveTableAdditionalTelemetryReporter.EmitTelemetry signature:
    void EmitTelemetry(string eventId, string correlationId,
                      IReadOnlyDictionary<string,string> telemetryDetails);
    *** NO STATUS PARAMETER. NO DURATION PARAMETER. ***
    These are fire-and-forget feature-usage emissions.

  EdogAdditionalTelemetryInterceptor (my code, line ~99-110):
    Status fallback chain: NodeStatus / ActivityStatus / Status / OperationStatus / Outcome
    Falls back to "Completed" when none present (which is ALWAYS for RunDag).
    → INVENTS A LIE.

  tab-telemetry.js _mapEvent line 223:
    'completed' alias maps to 'succeeded'.
    → The lie becomes "this RunDag succeeded" in the UI while it's still running.

  tab-telemetry.js _onEvent line 162-181:
    "If new event arrives with non-running status AND existing is running, upgrade."
    → The fake Additional Completed (arriving after SSR Pending) upgrades to "succeeded".

  summary.js extractMetrics line 111-119:
    TERMINAL set includes 'completed'. ssrEvents filter (line 57) doesn't filter by channel.
    → Drawer reports DAG terminal while it's still running.

Bugs catalog:

  B1  Critical  Backend invents 'Completed' status on Additional events that have none.
  B2  Critical  Frontend maps 'completed' → 'succeeded' status, propagating the lie.
  B3  High      Catalog/spine status aggregates merge Additional 'Completed' into terminal.
  B4  High      summary.js drawer treats Additional 'Completed' as terminal RunDag status.
  B5  Medium    Activity catalog timing (p50/p95) includes Pending durationMs which
                represents "time to HTTP 202", not the activity runtime.
"""

from __future__ import annotations

import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(REPO, "src", "backend", "DevMode")
FRONTEND_JS = os.path.join(REPO, "src", "frontend", "js")

ADDL_INTERCEPTOR = os.path.join(BACKEND, "EdogAdditionalTelemetryInterceptor.cs")
TAB_TELEMETRY_JS = os.path.join(FRONTEND_JS, "tab-telemetry.js")
SUMMARY_JS = os.path.join(FRONTEND_JS, "summary.js")


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


def _strip_comments_cs(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
    s = re.sub(r"//[^\n]*", "", s)
    return s


def _strip_comments_js(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
    s = re.sub(r"//[^\n]*", "", s)
    return s


# ════════════════════════════════════════════════════════════════════
# B1 — Backend stops inventing status on Additional events
# ════════════════════════════════════════════════════════════════════


class TestB1AdditionalNoFakeStatus:
    """The Additional channel has NO status parameter on its EmitTelemetry
    signature. Anything we stamp is invention. Fix: ActivityStatus stays
    empty string; consumers must derive lifecycle from the paired SSR
    event with the same correlationId."""

    def test_interceptor_does_not_fall_back_to_completed(self):
        src = _read(ADDL_INTERCEPTOR)
        clean = _strip_comments_cs(src)
        # The hardcoded "Completed" fallback must be gone. Allowed in
        # comments (which we strip) but not in the executable body.
        assert 'var status = "Completed"' not in clean and 'status = "Completed"' not in clean, (
            "EdogAdditionalTelemetryInterceptor must not default ActivityStatus "
            "to 'Completed'. The Additional channel API "
            "(ILiveTableAdditionalTelemetryReporter.EmitTelemetry) has NO status "
            "parameter — stamping 'Completed' is a flat lie that the UI then "
            "reports as 'succeeded' for still-running activities. Fix: use empty "
            "string or null; let the UI resolve lifecycle from the paired SSR "
            "event."
        )

    def test_interceptor_does_not_probe_nodestatus_fallback_chain(self):
        src = _read(ADDL_INTERCEPTOR)
        clean = _strip_comments_cs(src)
        # The NodeStatus / ActivityStatus / Status / OperationStatus / Outcome
        # fallback chain is gone too. Even though some FLT call sites
        # MIGHT include one of these in attributes, treating them as
        # authoritative is structurally wrong — Additional events are
        # fire-and-forget. The single source of truth for lifecycle is
        # the paired SSR event.
        assert "NodeStatus" not in clean, (
            "Remove the NodeStatus fallback. Additional events are not "
            "lifecycle events — fishing for a status field in attributes "
            "creates inconsistent semantics across call sites."
        )

    def test_event_marked_as_mirror(self):
        """The Additional event must be marked so the frontend knows to
        derive its status from the paired SSR event rather than treat the
        empty string as 'unknown'."""
        src = _read(ADDL_INTERCEPTOR)
        # New field on the published event payload — call it `isMirror` or
        # `mirrorOfSsr`. Either is fine; we just need the marker.
        # IsMirror or mirrorOfSsr field (case-insensitive — C# convention
        # is PascalCase IsMirror; JSON-serialized as camelCase isMirror;
        # tests should accept either).
        assert re.search(r"\bisMirror\b|\bmirrorOfSsr\b", src, re.IGNORECASE), (
            "EdogAdditionalTelemetryInterceptor must mark its published events "
            "with `IsMirror = true` (or `MirrorOfSsr = true`). The frontend "
            "uses this to resolve status from the paired SSR event with the "
            "same correlationId."
        )


# ════════════════════════════════════════════════════════════════════
# B2 — Frontend stops aliasing 'completed' to 'succeeded'
# ════════════════════════════════════════════════════════════════════


class TestB2FrontendNoCompletedAlias:
    """Once the backend stops inventing 'Completed' for Additional events
    the alias is harmless for the new code path. But the alias is wrong
    on principle: 'Completed' is not the same as 'Succeeded' (a workflow
    can complete with failures). The current code conflates them, which
    hides real failures. Fix: keep 'completed' as its own status."""

    def test_completed_status_not_aliased_to_succeeded(self):
        src = _read(TAB_TELEMETRY_JS)
        clean = _strip_comments_js(src)
        # The current line: `rawStatus === 'succeeded' || rawStatus === 'completed' ? 'succeeded'`
        # The bug shape: a single ternary where 'succeeded' and 'completed'
        # both produce 'succeeded'. Forbid that exact aliasing.
        assert not re.search(
            r"rawStatus\s*===\s*['\"]succeeded['\"]\s*\|\|\s*rawStatus\s*===\s*['\"]completed['\"]\s*\?\s*['\"]succeeded['\"]",
            clean,
        ), (
            "_mapEvent must not alias 'completed' to 'succeeded'. The two are "
            "semantically distinct: a workflow can complete with failures. "
            "More urgently, the backend used to invent 'Completed' on "
            "Additional events that were still running — the alias turned "
            "those into a green 'succeeded' display lying about live state."
        )


# ════════════════════════════════════════════════════════════════════
# B3 — Catalog/spine status aggregates use SSR only
# ════════════════════════════════════════════════════════════════════


class TestB3StatusAggregatesUseSsrOnly:
    """Iteration spine status and activity catalog terminal-status counts
    must derive ONLY from SSR events. Additional events are fire-and-forget
    mirrors with no authoritative status. Including them in status
    aggregates is what made the UI report green for running iterations."""

    def test_iter_map_status_derivation_filters_by_channel(self):
        src = _read(TAB_TELEMETRY_JS)
        clean = _strip_comments_js(src)
        # Find the for-loop that walks iter.eventIds — that's the status
        # derivation block. Inside its body the fix must skip non-SSR.
        # Approach: locate the loop header, then scan the next ~600 chars
        # (loop is small) for either of the SSR-filter patterns.
        loop_anchor = re.search(
            r"for\s*\([^)]*iter\.eventIds[^)]*\)\s*\{",
            clean,
        )
        assert loop_anchor, (
            "Could not locate the iter.status derivation for-loop in "
            "_updateIterMap. The block that walks iter.eventIds and sets "
            "hasFailed/hasRunning must filter by channel."
        )
        # Loop body is between the `{` and the closing `}` of the for.
        # Scan a generous window; the loop has only a handful of statements.
        window = clean[loop_anchor.end() : loop_anchor.end() + 600]
        # SSR-filter pattern — accept any of:
        #   ev.channel === 'ssr'
        #   ev.channel !== 'additional'
        #   ev.channel !== 'ssr'    (negated form, equivalent semantic)
        assert re.search(
            r"channel\s*===\s*['\"]ssr['\"]|channel\s*!==\s*['\"](additional|ssr)['\"]",
            window,
        ), (
            "The for-loop in _updateIterMap that derives iter.status must "
            "skip non-SSR events. Today it processes ALL events including "
            "the Additional channel's empty / lying status. Add "
            "`if (ev.channel !== 'ssr') continue;` near the top of the "
            "loop body. (The unrelated `if (activity.channel === 'ssr') "
            "iter.ssrCount++` line above the loop does not satisfy this "
            "guard — the status-derivation loop must filter independently.)"
        )


# ════════════════════════════════════════════════════════════════════
# B4 — summary.js drawer extracts status from SSR events only
# ════════════════════════════════════════════════════════════════════


class TestB4SummaryUsesSsrOnly:
    """The lifecycle drawer's RunDag terminal-status detection (used to
    display 'Succeeded' / 'Failed' / 'Running' for the iteration) must
    not consider Additional events. Otherwise the same fake 'Completed'
    poisons the drawer too."""

    def test_extract_metrics_filters_run_dag_events_by_channel(self):
        src = _read(SUMMARY_JS)
        clean = _strip_comments_js(src)
        # Locate the ssrEvents assignment. Multiple ssrEvents references
        # exist; we want the assignment, not reads.
        anchor = re.search(
            r"(?:const|let|var)\s+ssrEvents\s*=\s*this\.state\.telemetry\.filter\s*\(",
            clean,
        )
        assert anchor, (
            "Could not locate `ssrEvents = this.state.telemetry.filter(...)` "
            "assignment in summary.js. Expected at the top of compute()."
        )
        # Scan a window after the assignment for the channel filter. The
        # filter callback is small (a few lines).
        window = clean[anchor.end() : anchor.end() + 500]
        assert re.search(
            r"channel\s*===\s*['\"]ssr['\"]|channel\s*!==\s*['\"]additional['\"]|channel\s*\|\|\s*['\"]ssr['\"]",
            window,
        ), (
            "The ssrEvents filter (drawer.compute) must exclude Additional "
            "channel events. Without this filter, runDagEvents downstream "
            "captures the Additional mirror events too. Add a check like "
            "`if ((e.channel || 'ssr') !== 'ssr') return false;` at the top "
            "of the filter callback."
        )


# ════════════════════════════════════════════════════════════════════
# B5 — Activity catalog timing excludes Pending durationMs
# ════════════════════════════════════════════════════════════════════


class TestB5CatalogExcludesPendingFromTiming:
    """The RunDag Pending SSR event has durationMs = ~1800 (time-to-202).
    Including it in activity p50/p95 lies about the activity's real
    runtime. The catalog must consider only terminal-status events for
    timing aggregates."""

    def test_cat_map_only_records_terminal_statuses(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(
            r"_updateCatMap\s*\(\s*activity\s*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        if not m:
            # Some implementations use arrow form.
            m = re.search(
                r"_updateCatMap\s*=\s*\([^)]*\)\s*=>\s*\{(.*?)\n  \}",
                src,
                re.DOTALL,
            )
        assert m, "Could not locate _updateCatMap method body."
        body = m.group(1)
        clean = _strip_comments_js(body)
        # The catalog timing recording must guard against status==='running'
        # OR status==='pending'. The simplest check: the body must reference
        # 'pending' OR have a status whitelist that doesn't include running/pending.
        # Allow either:
        #   if (activity.status === 'running' || activity.status === 'pending') return;
        #   if (!TERMINAL_STATUSES.has(activity.status)) return;
        guards_running_or_pending = re.search(r"status\s*===\s*['\"]running['\"]", clean) and re.search(
            r"status\s*===\s*['\"]pending['\"]", clean
        )
        # Or a terminal-set whitelist.
        has_terminal_set = re.search(r"TERMINAL|terminalStatus", clean)
        assert guards_running_or_pending or has_terminal_set, (
            "_updateCatMap must skip running AND pending events when "
            "aggregating activity timing. Pending SSR events carry "
            "durationMs ~= time-to-HTTP-202 (typically 1.5-3s), NOT the "
            "real activity runtime. Recording them in the catalog poisons "
            "p50/p95. Either guard at the top with "
            "`if (activity.status === 'running' || activity.status === 'pending') return;` "
            "or use a TERMINAL_STATUSES set."
        )

    def test_track_sparkline_excludes_pending(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(
            r"_trackSparkline\s*\(\s*activity\s*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        if not m:
            m = re.search(
                r"_trackSparkline\s*=\s*\([^)]*\)\s*=>\s*\{(.*?)\n  \}",
                src,
                re.DOTALL,
            )
        assert m, "Could not locate _trackSparkline method body."
        body = m.group(1)
        clean = _strip_comments_js(body)
        # Same reasoning — sparklines must not include Pending.
        assert re.search(r"['\"]pending['\"]", clean) or re.search(r"TERMINAL", clean), (
            "_trackSparkline must skip pending events. Pending durationMs is "
            "the time-to-HTTP-202, not the activity runtime."
        )


# ════════════════════════════════════════════════════════════════════
# B6 — Duration slider "all" must DISABLE the cap, not pin it at 5s
# ════════════════════════════════════════════════════════════════════


class TestB6DurationSliderAllMeansUnbounded:
    """Regression for the "showing 0 of N" bug.

    _getVisible drops events when `dMax > 0 && durMs > dMax`. The sentinel
    for "no upper bound" is therefore dMax === 0. Two failure points pinned:

      1. The default `dmax` fallback must be 0 (unbounded), NOT MAX_SLIDER_MS.
         A default of MAX_SLIDER_MS (5000) silently hides every event longer
         than 5s — i.e. every real DAG/Spark activity — on first load.
      2. The slider's far-right ("all") position must set _durMax = 0, NOT
         MAX_SLIDER_MS, so the label "all" actually means "no cap".
      3. _getVisible's cap must be inactive for dMax >= MAX_SLIDER_MS, so
         stale persisted dmax values (sitting in studioState/localStorage
         from an older build's default) auto-migrate to "unbounded" instead
         of hiding every event behind an "all" label.
    """

    def test_get_visible_treats_max_cap_as_unbounded(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(r"_getVisible\s*\(\s*\)\s*\{(.*?)\n  \}", src, re.DOTALL)
        assert m, "Could not locate _getVisible method body."
        body = _strip_comments_js(m.group(1))
        # The cap must only be active when dMax is STRICTLY below the slider
        # max — otherwise a stale persisted dMax == MAX_SLIDER_MS keeps hiding
        # every activity longer than the slider range ("showing 0 of N").
        assert re.search(r"dMax\s*<\s*TelemetryTab\.MAX_SLIDER_MS", body), (
            "_getVisible must gate the duration cap on `dMax < MAX_SLIDER_MS` "
            "(the slider max == 'all' == unbounded). Without this, a stale "
            "persisted dmax of MAX_SLIDER_MS hides all long activities while "
            "the UI reads 'all' — the 'showing 0 of N' bug after reload."
        )

    def test_default_dmax_is_unbounded_sentinel(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(r"_filterFallbacks\s*=\s*\{(.*?)\}", src, re.DOTALL)
        assert m, "Could not locate _filterFallbacks default block."
        block = m.group(1)
        dmax = re.search(r"dmax\s*:\s*([^,\n}]+)", block)
        assert dmax, "dmax default missing from _filterFallbacks."
        val = dmax.group(1).strip()
        assert val == "0", (
            "Default dmax must be 0 (unbounded sentinel — _getVisible treats "
            f"dMax > 0 as an active cap). Found {val!r}. A non-zero default "
            "(e.g. MAX_SLIDER_MS) hides every event longer than that on first "
            "load — the 'showing 0 of N' bug."
        )

    def test_slider_all_position_disables_cap(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(r"setFromX\s*=\s*\([^)]*\)\s*=>\s*\{(.*?)\n    \}", src, re.DOTALL)
        assert m, "Could not locate setFromX handler body."
        body = _strip_comments_js(m.group(1))
        # At the max ("all") position _durMax must resolve to 0, not MAX_SLIDER_MS.
        assert re.search(r"this\._durMax\s*=\s*[^;]*\b0\b", body), (
            "The duration slider's 'all' (far-right) position must set "
            "this._durMax = 0 (disabled). Setting it to MAX_SLIDER_MS pins a "
            "hidden 5s cap while the label reads 'all' — the 'showing 0 of N' bug."
        )
        assert (
            "MAX_SLIDER_MS" not in re.sub(r"Math\.round\([^)]*MAX_SLIDER_MS[^)]*\)", "", body)
            or "atMax ? 0" in body
            or "? 0 :" in body
        ), "_durMax must branch to 0 at the max position rather than being assigned MAX_SLIDER_MS directly."


# ════════════════════════════════════════════════════════════════════
# B7 — SSR-only stream: Additional (+TEL) events never become rows
# ════════════════════════════════════════════════════════════════════


class TestB7SsrOnlyStream:
    """Regression for the "MESS of unknown status", "wtf is mirror", and
    "older ones get redacted" reports.

    Ground truth (FLT NodeExecutor.cs:390 EmitStandardizedServerReporting +
    :417 EmitTelemetry; DagExecutionHandlerV2 likewise): every Additional
    (+TEL) emit shares the SAME activityName and correlationId as a paired
    SSR emit. There is NO Additional-only activity. +TEL carries no lifecycle
    status (backend stamps empty + isMirror=true).

    Rendering +TEL as its own stream row caused three bugs:
      1. empty-status mirrors mapped to 'unknown' → a wall of 'unknown' pills.
      2. two rows per activity (duplicates).
      3. both rows wrote _correlationMap[correlationId], so the
         running→terminal merge updated the WRONG row → "older ones redacted".

    Fix: drop channel === 'additional' at the TOP of _onEvent, before any
    push to _events / _correlationMap. Its only unique payload (retry-metric
    attributes) is merged into the SSR twin so nothing is lost.
    """

    def test_onevent_drops_additional_before_push(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(r"_onEvent\s*=\s*\([^)]*\)\s*=>\s*\{(.*?)\n  \};", src, re.DOTALL)
        assert m, "Could not locate _onEvent handler body."
        body = _strip_comments_js(m.group(1))

        guard = re.search(r"channel\s*===\s*['\"]additional['\"]", body)
        assert guard, (
            "_onEvent must drop Additional (+TEL) events at ingest with a "
            "`activity.channel === 'additional'` guard. Without it, +TEL "
            "mirrors enter the stream as duplicate 'unknown' rows and collide "
            "on _correlationMap (the 'older ones get redacted' bug)."
        )

        push = re.search(r"this\._events\.push", body)
        assert push, "Expected a this._events.push in _onEvent."
        # The drop guard must short-circuit (return) BEFORE the row is pushed.
        ret_after_guard = re.search(r"channel\s*===\s*['\"]additional['\"][^}]*?\breturn\b", body, re.DOTALL)
        assert ret_after_guard, (
            "The additional-channel guard must `return` (drop the event) — "
            "otherwise +TEL still falls through to this._events.push."
        )
        assert guard.start() < push.start(), (
            "The additional-channel drop guard must appear BEFORE "
            "this._events.push, so +TEL never becomes a stream row."
        )

    def test_displaystatus_has_no_mirror_label(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(r"_displayStatus\s*\(\s*a\s*\)\s*\{(.*?)\n  \}", src, re.DOTALL)
        assert m, "Could not locate _displayStatus method body."
        body = _strip_comments_js(m.group(1))
        assert "mirror" not in body.lower(), (
            "_displayStatus must not invent a 'mirror' badge. The stream is "
            "SSR-only now; every row carries a real status. 'mirror' is not a "
            "lifecycle status and confused users — it must be gone."
        )

    def test_additional_attributes_merge_into_twin(self):
        src = _read(TAB_TELEMETRY_JS)
        m = re.search(
            r"_mergeAdditionalIntoTwin\s*\(\s*activity\s*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        assert m, (
            "Expected a _mergeAdditionalIntoTwin method that folds a dropped "
            "+TEL mirror's unique attributes into its SSR twin (so retry "
            "metrics are not lost)."
        )
        body = _strip_comments_js(m.group(1))
        assert re.search(r"Object\.assign\s*\(\s*twin\.attributes", body), (
            "_mergeAdditionalIntoTwin must Object.assign the mirror's attributes onto the SSR twin's attributes."
        )
