# Logs View — Product Gap Analysis

> **Reviewer:** Senior PM — Log Viewer & Observability UX
> **Date:** 2025-07-16
> **Scope:** Product capabilities of the EDOG Studio Logs View (not UI/CSS — Phantom covered that)
> **Methodology:** Compared against Datadog Log Explorer, Grafana Loki, Seq, Chrome DevTools Console, Azure Monitor / App Insights

---

## What's Already Strong

EDOG Studio's logs view is **surprisingly capable** for an internal dev tool. Several features are at or above parity with production observability tools:

1. **Virtual scroll with DOM recycling** (`renderer.js` RowPool) — Handles thousands of entries with constant memory. Comparable to Datadog's virtualized log table. The ring buffer (`state.js` RingBuffer, 50K capacity) with incremental `FilterIndex` is well-architected.

2. **Multi-axis filtering** — Level toggle (V/M/W/E), component presets (All/FLT/DAG/Spark), text search, time range, endpoint filter, component filter, RAID/IterationId filter, and correlation filter. This is *more* filter axes than Chrome DevTools Console offers and competitive with Datadog's faceted approach.

3. **Correlation-based tracing** — Clicking a telemetry correlation ID filters logs to that RAID. The detail panel has "→ Find in SSR" cross-linking. This is a workflow Grafana Loki doesn't natively support without Tempo integration.

4. **Regex breakpoints with visual markers** (`logs-enhancements.js`) — Color-coded pattern markers with match counts, jump-to-match, enable/disable toggle, marker-wise filtering. This is a power-user feature that doesn't exist in Datadog or Grafana — it's closer to Chrome DevTools' "break on..." but for logs.

5. **Error clustering** — Consecutive error grouping with signature-based deduplication (≥3 threshold). Datadog has "Log Patterns" which is similar but ML-powered; EDOG's heuristic approach is appropriate for a local dev tool.

6. **Anomaly detection** (`anomaly.js`) — Proactive detection of slow polling, retry storms, slow nodes, timeout risks. This is *ahead* of most log viewers — Azure Monitor has "Smart Detection" but that's cloud-side ML, not real-time local.

7. **Bookmarks with export** — Pin specific entries, export as JSON, navigate via drawer. Seq has "signals" which is conceptually similar.

8. **Component category coloring** — Auto-classifies components (controller, dag, onelake, dq, retry) with distinct badge colors. This is a small but meaningful information density improvement.

---

## Critical Gaps (MVP)

These are things developers debugging FLT pipeline issues will immediately notice are missing, or will hit as friction within their first debugging session.

| ID | Gap | Why it matters | Industry reference | Build effort |
|----|-----|---------------|-------------------|-------------|
| G-01 | **No log line wrapping / expansion** — Messages are truncated at 500 chars with `text-overflow: ellipsis` (`renderer.js:397`). Clicking opens the detail panel, but there's no inline expand. FLT error messages often contain stack traces, JSON payloads, and multi-line exception details. | Devs debugging pipeline failures need to see the full error message *in context* — not in a separate panel where they lose their scroll position. A collapsed/expanded toggle per row (or at minimum, a wider message on hover) is table stakes. | **Seq**: Click-to-expand inline. **Chrome DevTools**: Console messages expand in-place with disclosure triangle. **Datadog**: Expandable log lines with full message + parsed fields. | **M** — Requires dynamic row heights in the virtual scroll, which means abandoning the fixed 34px assumption in `_renderVirtualScroll`. Could use a simpler approach: double-click to expand into a 3-4 line mini-view. |
| G-02 | **No structured log field extraction** — Log messages are treated as opaque strings. FLT logs contain structured data (JSON in `customData`, key-value pairs in messages like `RequestId=abc, Duration=1234ms`), but this is only visible in the detail panel after clicking. | Datadog's entire value proposition is structured log facets. When a dev sees `MLV_SPARK_SESSION_ACQUISITION_FAILED`, they need to instantly see *which workspace*, *which artifact*, *what duration* — without clicking. The current flat-string model forces linear scanning. | **Datadog**: Auto-parsed facets, clickable to filter. **Seq**: Structured properties shown as pills next to message. **Grafana Loki**: Label-based log model with instant filter-by-label. | **L** — Requires: (1) parser to extract key-value pairs from messages, (2) UI to show extracted fields as pills/badges on the row, (3) click-to-filter-by-field. The data is already there in `entry.customData` — it just needs surfacing. |
| G-03 | **No search highlighting** — When `state.searchText` is set, matching rows are shown but the match location within the message is not highlighted. `passesFilter` (`renderer.js:589-599`) does case-insensitive `includes()` but never marks what matched. | With 1000+ visible log lines after filtering, devs still need to visually locate *where* in the message the search term appears. This is basic find-in-page UX that every text-based tool provides. | **Every log viewer**: All highlight search terms. Chrome DevTools, Datadog, Seq, Grafana — all of them. This is universal. | **S** — On row population, wrap matched substring in `<mark>` element. Must use `textContent` replacement carefully (current code uses `textContent` not `innerHTML` for security — need to switch to controlled `innerHTML` with escaping for matched rows only). |
| G-04 | **No log tail / live tail mode indicator** — Auto-scroll exists (scroll FAB), but there's no explicit "Live Tail" mode like Grafana Loki's. The current behavior silently switches between tailing and historical when the user scrolls, with no clear affordance beyond the "Resume auto-scroll" button appearing. | Devs need to know at a glance: "Am I seeing real-time data or am I looking at history?" When debugging, they often want to freeze the view, inspect, then resume. The Pause button exists but its state isn't prominent. | **Grafana Loki**: Explicit "Live" toggle in toolbar with animated indicator. **Datadog**: "Live Tail" is a distinct mode with streaming indicator. **Chrome DevTools**: "Scroll to bottom" icon with auto-scroll indicator. | **S** — Add a pulsing dot or "LIVE" badge near the status bar when auto-scroll is active. Change Pause button to a more prominent toggle with visual state (not just text swap). |
| G-05 | **No persistent filter state / saved views** — Every time the user opens EDOG Studio, all filters reset. There's no way to save a filter combination like "show only DAG errors from the last 5 minutes with component=DagExecution". | Pipeline engineers often debug the same categories of issues repeatedly. Datadog's "Saved Views" and Seq's "Signals" let teams share common filter presets. Even a simple browser localStorage persistence of the last-used filter set would help. | **Datadog**: Saved Views, shareable via URL. **Seq**: Saved filters + signals. **Grafana**: Dashboard panels with pre-configured queries. | **M** — Store filter state in `localStorage` keyed by session. Add a "Save View" button that names and persists the current filter combination. Start with localStorage, graduate to exportable JSON. |
| G-06 | **Export has no format options and no feedback** — `exportLogs()` (`main.js:1014`) dumps everything as JSON with no progress, no success toast, and no option for CSV/TSV. The exported JSON includes raw internal state (`stats`, `filters`) mixed with log data. | When devs share logs with teammates or attach to bug reports, they need clean, readable output. JSON is good for machines but CSV is better for quick Excel/Sheets analysis. The silent export (TD-01.9 already noted) needs addressing alongside format flexibility. | **Datadog**: Export as CSV or JSON, with column selection. **Seq**: Export as JSON lines, CSV, or plain text. **Chrome DevTools**: Copy table, save as HAR. | **S** — Add format selector (JSON/CSV/Text), filter the export to only visible (filtered) logs, and show a toast with count. Already partially noted in TD-01.9 but the format gap is a product issue, not just UX polish. |

---

## Important Gaps (V1.1)

Features that would make the experience significantly better — devs can work without them but will ask for them after the first week.

| ID | Gap | Why it matters | Industry reference | Build effort |
|----|-----|---------------|-------------------|-------------|
| G-07 | **No log-to-telemetry correlation in the log view** — The detail panel shows RAID and has "→ Find in SSR", but there's no way to see which SSR activity a log entry belongs to *without* clicking into the detail panel. No timeline view showing logs overlaid on telemetry activities. | FLT debugging is fundamentally about understanding what happened during a DAG execution. Logs and telemetry are two views of the same execution. Showing "this log happened during node X's execution" inline would dramatically speed up root cause analysis. | **Datadog**: Unified traces + logs view with waterfall. **Azure Monitor**: Transaction diagnostics correlating traces, logs, and dependencies. **Grafana Tempo + Loki**: Trace-to-logs jump. | **L** — Requires matching log timestamps to telemetry activity time ranges, then showing an inline indicator (e.g., a node name badge or activity color stripe). Data is available via `rootActivityId` cross-reference. |
| G-08 | **No multi-line / stack trace rendering** — Error messages containing `\n` or stack traces display as a single truncated line. The detail panel shows the full message but in a `<div>` without stack trace formatting (no class/method highlighting, no frame collapsing). | .NET developers reading `System.InvalidOperationException` stack traces expect syntax-highlighted frames with clickable source references. Showing a 50-frame stack trace as a flat string is hostile. | **Seq**: Stack trace parser with frame highlighting. **Azure Monitor**: Exception drill-down with call stack tree. **Chrome DevTools**: Expandable error stacks with source links. | **M** — Parse `\n`-separated stack frames from error messages, render as a collapsible list with monospace formatting. Highlight exception type vs. frame info. No source linking needed (FLT runs server-side). |
| G-09 | **No log frequency / histogram** — No visual representation of log volume over time. The status bar shows "X of Y" but there's no sense of *when* the logs happened or whether there are bursts of activity. | When investigating a DAG failure, devs need to see "there was a burst of errors at 14:32:07" at a glance. A histogram shows patterns that scanning individual rows can't reveal: periodic spikes, sudden silence, error storms. | **Datadog**: Log volume histogram above log list (signature feature). **Grafana Loki**: Histogram in explore view. **Kibana**: Time-based histogram. | **M** — Time-bucketed bar chart (30-60 bars) above the log list, colored by level. Click a bar to filter to that time window. Can reuse the time range filter infrastructure. The data is all in the `RingBuffer` — just needs aggregation. |
| G-10 | **No regex search** — `passesFilter` (`renderer.js:589-599`) uses `String.includes()` for search. There's no option for regex search (despite breakpoints supporting regex). Devs can't search for patterns like `Duration=\d{4,}ms` (slow operations) or `node '.*' failed`. | Regex breakpoints exist in `logs-enhancements.js` but the main search bar is literal-only. This is inconsistent and limits power users. Datadog and Seq both support regex in search. | **Datadog**: `/regex/` syntax in search bar. **Seq**: SQL-like `like` expressions. **Grafana Loki**: Full LogQL with regex matchers. | **S** — Detect `/pattern/` syntax in search input. If valid regex, use `RegExp.test()` instead of `includes()`. Fall back to literal search otherwise. The breakpoint code in `logs-enhancements.js:650-657` already has the regex validation pattern to reuse. |
| G-11 | **No negative search / exclusion** — Search is additive only. There's no way to say "show me all errors *except* those containing 'health check'" or "exclude messages matching pattern X". Component exclusion exists (click component pill to exclude) but message-level exclusion doesn't. | Log noise is the #1 complaint in any high-volume log viewer. Health checks, heartbeats, and routine operations flood the view. Devs need to subtract noise as much as they need to add signal. | **Datadog**: `-field:value` exclusion syntax. **Grafana Loki**: `!~` regex exclusion operator. **Chrome DevTools**: `-url:` negative filter. | **S** — Support `-` prefix in search bar for exclusion. Parse search text: if starts with `-`, invert the match in `passesFilter`. Could also add "Exclude this message" to right-click context menu. |
| G-12 | **No context lines around filtered results** — When filtering (search, level, component), matching rows are shown in isolation. There's no way to see the N lines before/after a match — the surrounding context that explains *why* an error happened. | grep has `-C` (context lines). Every developer expects this. When you find an error, you need to see what happened in the 5 lines leading up to it — the setup, the request, the intermediate state. Without context, filtered views lose causal information. | **Datadog**: "View in context" button per log line — jumps to unfiltered view centered on that entry. **Seq**: "Show surrounding events" link. **grep**: `-C N` context flag. | **M** — Add a "Show context" action per row (or in detail panel) that temporarily removes filters and scrolls to that entry's position in the unfiltered view. Could also show ±N rows inline with a visual separator. |
| G-13 | **No log diffing between executions** — No way to compare logs from execution A vs. execution B. When a DAG that worked yesterday fails today, devs need to see what changed. | This is the "what's different?" question that consumes the majority of debugging time. If the dev can see "execution A had 400 logs, execution B had 380 logs, and these 20 entries are new/different", they find the root cause 10× faster. | **Azure Monitor**: Compare time ranges. **Datadog**: Saved views for A/B comparison. **Custom**: This is where EDOG could differentiate — no mainstream log viewer does execution-level diffing well. | **L** — Requires: (1) execution-scoped log capture (RAID filter already enables this), (2) two-pane or overlay diff view, (3) diff algorithm on log sequences (ignoring timestamps/IDs). This is a V2 differentiator. |

---

## Nice to Have (V2+)

Power user features and advanced analytics that would make EDOG Studio a best-in-class dev tool.

| ID | Gap | Why it matters | Industry reference | Build effort |
|----|-----|---------------|-------------------|-------------|
| G-14 | **No log pattern detection / deduplication** — Error clustering (`detectClusters`) groups *consecutive* errors, but there's no detection of repeated patterns across the full log stream (e.g., "this warning appeared 847 times across 12 different components"). | Reduces noise dramatically. Instead of scrolling through 847 identical warnings, you see "warning X: 847 occurrences, first at 14:30, last at 14:35" with an expand button. | **Datadog Log Patterns**: ML-based pattern grouping. **Seq**: Automatic signal deduplication. | **L** — Signature-based grouping (reuse `_errorSignature` approach for all levels). Show as collapsible groups in the log view with occurrence counts. |
| G-15 | **No query language** — Filtering is done through UI controls (buttons, dropdowns, text input). There's no text-based query language for complex filter expressions like `level:error AND component:DagExecution AND message:"timeout" AND NOT message:"health"`. | Power users always outgrow UI-based filtering. A query language is the step function from "tool for beginners" to "tool for experts". KQL, LogQL, and Seq's query language all demonstrate this. | **Azure Monitor**: KQL. **Grafana Loki**: LogQL. **Seq**: Seq query syntax. **Datadog**: Faceted query bar. | **L** — Define a simple grammar: `level:X component:Y "literal" -"exclude" /regex/`. Parse into filter predicates. The filter infrastructure in `passesFilter` already supports all these axes — this is just a unified syntax layer. |
| G-16 | **No log metrics / aggregation** — No way to answer "how many errors per minute?" or "what's the average log rate by component?" without exporting and analyzing externally. | Turns logs from a debugging tool into an observability tool. "Error rate jumped from 2/min to 50/min at 14:32" is an insight you can't get from scanning individual rows. | **Datadog**: Log-based metrics, graphs. **Grafana**: LogQL `rate()`, `count_over_time()`. **Kibana**: Aggregation visualizations. | **L** — Time-series aggregation over the ring buffer. Could piggyback on the histogram feature (G-09) to also show counts by level/component. |
| G-17 | **No right-click context menu** — All interactions are left-click or keyboard. There's no context menu for common actions: copy message, copy as JSON, exclude component, filter by level, bookmark, add breakpoint from selection. | Right-click is the universal "what can I do with this?" affordance. Chrome DevTools' console context menu has 15+ actions. Even a 5-action menu would reduce the click-path for common workflows. | **Chrome DevTools**: Rich context menu on console entries. **Seq**: Context menu with "Exclude", "Show only", "Copy". | **M** — Custom context menu on log rows. Actions: Copy message, Copy JSON, Exclude component, Filter to this level, Bookmark, Add breakpoint from selected text. |
| G-18 | **No log entry linking / sharing** — No way to share a deep link to a specific log entry (e.g., `localhost:5555/#log-seq-12345`). When a dev finds a problematic log, they can't send a link to a teammate. | Less critical for a localhost tool, but relevant when multiple devs debug the same deployment or when pasting into Slack/Teams. Even just "Copy link to this entry" that includes the filter state would help. | **Datadog**: Shareable log URLs. **Seq**: Permalink per event. **Grafana**: Share panel link. | **S** — Generate a URL hash with `seq` ID + filter state. On load, parse hash, restore filters, scroll to entry. Since it's localhost, this is mostly useful for copy-paste. |
| G-19 | **No bookmark annotations** — Bookmarks store the raw entry but don't allow user comments. Devs can't annotate "this is where the OneLake timeout starts" on a bookmarked entry. | Bookmarks become investigation notes when annotated. Without annotations, they're just pins. F04 spec's "Moonshot Vision" section already identifies this. | **Seq**: Signal notes. **Datadog**: Log notes (team feature). | **S** — Add an optional text field to `BookmarkEntry`. Show in drawer. Export includes annotations. |
| G-20 | **No automatic error code hyperlinking** — `error-intel.js` detects error codes for alert cards, but individual error codes in log messages aren't highlighted or clickable inline. F12 spec covers this but it's not implemented yet. | FLT error codes like `MLV_SPARK_SESSION_ACQUISITION_FAILED` should be immediately recognizable and decodable inline. This is the core F12 feature — including it here for completeness. | **Seq**: Clickable signal identifiers. **Azure Monitor**: Error code links to documentation. | **M** — Already scoped in F12. Ensure the implementation covers both log row inline view AND detail panel. |

---

## Recommended F12 Scope Additions

Based on this analysis, F12 ("Error Code Decoder") should expand beyond tooltip-on-error-code to include these concrete, actionable items:

### 1. Search term highlighting in log messages (G-03)

**Rationale:** This is prerequisite UX for error code highlighting. If you're going to underline error codes, you should also highlight search matches. Build the generic "highlight substring in log message" infrastructure once, then error code decoration and search highlighting both use it.

**Concrete scope:**
- Modify `_populateRow` to support a `highlights: [{start, end, className}]` array
- Search highlighting: wrap matches in `<mark class="search-hit">`
- Error code highlighting: wrap known codes in `<span class="error-code-hint">` (CSS already exists in `logs.css:271-276`)
- Both must work with `textContent`-based rendering (switch to controlled `innerHTML` with proper escaping)

### 2. Inline error context card (expand G-01 for error rows specifically)

**Rationale:** When a log row contains a known error code, F12 should show more than a tooltip. It should offer an inline expandable card showing: error description, classification (user/system), suggested fix, and "N other occurrences of this error" with a filter-to-all button.

**Concrete scope:**
- On hover/click of a decorated error code, show a popover card (not a tooltip — a card with actions)
- Card content: error title, description, severity, suggested fix (from `error-codes.json`)
- Card actions: "Filter to all [CODE]" (sets search), "Copy error details", "View in detail panel"
- Count of occurrences of this error code in the current buffer

### 3. Error frequency indicator (subset of G-09)

**Rationale:** Error codes in isolation are less useful than error codes with frequency context. "This error happened 47 times in the last 2 minutes" is fundamentally different from "this error happened once." F12 should include a lightweight error-specific frequency counter in the cluster summary bar.

**Concrete scope:**
- Extend `le-cluster-summary` to show per-error-code counts (not just consecutive clusters)
- Show first-seen / last-seen timestamps per code
- Badge on error cluster pills showing trend: ↑ (increasing) / ↓ (decreasing) / → (stable)

### 4. Error-to-node mapping

**Rationale:** FLT errors are often specific to a DAG node. The current `ErrorIntelligence` class (`error-intel.js:25-35`) already extracts `latestError.node` and `exec.skippedNodes`. F12 should expose this node context in the error decoder — "this error occurred in node 'LoadCustomer' and caused 3 downstream nodes to skip."

**Concrete scope:**
- Error decoder card includes: "Occurred in node: [NodeName]" with link to filter by that node
- Show downstream impact: "Skipped nodes: [list]"
- If node appears in DAG tab, add "View in DAG" cross-link

### 5. Error runbook links (V2 but design for it now)

**Rationale:** F12's "Moonshot Vision" mentions "Link error codes to runbooks." Design the `error-codes.json` schema now to include a `runbookUrl` field so it's ready when runbook content exists. Even placeholder links to internal wiki pages would help.

**Concrete scope:**
- Add `runbookUrl?: string` to the error code JSON schema
- If present, show "View runbook →" link in the error decoder card
- No content creation needed — just the plumbing

---

## Summary Priorities

| Priority | IDs | Theme |
|----------|-----|-------|
| **Ship with F12** | G-03, G-06 | Search highlighting (infrastructure for F12), export formats |
| **Fast follows** | G-04, G-05, G-10, G-11 | Live tail indicator, saved filters, regex search, negative search |
| **V1.1 milestone** | G-01, G-07, G-08, G-09, G-12 | Row expansion, log-telemetry correlation, stack traces, histogram, context lines |
| **V2 differentiators** | G-13, G-14, G-15, G-16, G-17 | Execution diff, log patterns, query language, metrics, context menu |
| **Polish** | G-18, G-19, G-20 | Linking, annotations, error code decoration (F12 core) |

---

*This analysis is complementary to Phantom's Logs & Telemetry UI Design Review (which covers visual/CSS gaps) and the TD-01 tech debt items in F25 (which covers implementation quality issues). Together, these three documents provide a complete picture of the Logs View's current state and improvement roadmap.*
