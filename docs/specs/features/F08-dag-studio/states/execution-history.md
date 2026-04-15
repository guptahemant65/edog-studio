# Execution History — Complete UX State Matrix

> **Feature:** F08 DAG Studio — Section 2.4 Execution History
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend Engineer) + Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `components/execution-history.md`, `p0-foundation.md` (APIs 2–3), `auto-detect.js`
> **States Documented:** 62

---

## How to Read This Document

Every state is documented as:

```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

Prefix key:
- `EH-LOAD-*` — Initial loading, data fetch lifecycle
- `EH-LIST-*` — List display, row rendering, scroll
- `EH-ROW-*` — Row interaction: focus, select, click, load
- `EH-FILT-*` — Filter bar, status dropdown, invoked-by dropdown
- `EH-AUTO-*` — Auto-refresh, new execution detection, live updates
- `EH-PAGE-*` — Pagination (load more)
- `EH-CMP-*` — Compare mode: selection, diff view, interaction
- `EH-EMPTY-*` — Empty states, error states
- `EH-KBD-*` — Keyboard navigation within history panel

---

## 1. State Diagram

```
                              ┌──────────────┐
                              │  EH-LOAD-001 │  Loading
                              │  (spinner)   │
                              └──────┬───────┘
                                     │
                        ┌────────────┼────────────┐
                        │ success    │ error       │ empty
                        ▼            ▼             ▼
                  ┌───────────┐ ┌──────────┐ ┌──────────────┐
                  │ EH-LIST-* │ │EH-EMPTY-3│ │ EH-EMPTY-001 │
                  │ (rows)    │ │ (error)  │ │ (no history) │
                  └─────┬─────┘ └──────────┘ └──────────────┘
                        │
            ┌───────────┼──────────────┐
            │           │              │
     Click row    Check 2 rows    Filter
            │           │              │
            ▼           ▼              ▼
      ┌───────────┐ ┌──────────┐ ┌───────────┐
      │ EH-ROW-*  │ │ EH-CMP-* │ │ EH-FILT-* │
      │ (loading  │ │ (compare │ │ (filtered │
      │  overlay) │ │  mode)   │ │  list)    │
      └───────────┘ └──────────┘ └───────────┘
```

---

## 2. LOADING STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-LOAD-001 | Initial loading | History tab activated (first time or data stale) | Panel body: centered spinner (16px, accent color) + "Loading execution history...". Filter bar visible but controls dimmed (40% opacity, non-interactive). Column headers visible (provides layout stability — no shift when data arrives). | EH-LOAD-002, EH-EMPTY-001, EH-EMPTY-003 |
| EH-LOAD-002 | Data received | `listDAGExecutionIterationIds` returns 200 with non-empty list | Spinner fades out (100ms). Rows render from top to bottom with staggered fade-in (30ms delay per row, max 600ms total for 20 rows). Filter bar controls enabled. Compare button visible (disabled, "Compare"). Pagination "Load more" appears at bottom if continuation token present. | EH-LIST-001 |
| EH-LOAD-003 | Background refresh | User switches away from History tab then returns (data > 30s old) | No spinner — list shows stale data immediately (instant perceived load). Subtle "Updating..." text in top-right corner. API fetch in background. When response arrives: rows merge (new rows slide in at top, updated rows update in-place, removed rows handled gracefully). "Updating..." text fades out. | EH-LIST-001 |

---

## 3. LIST DISPLAY STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-LIST-001 | Normal list display | Data loaded, no filters active, no row loaded | Rows in time-descending order (newest first). Each row: 36px height. Checkbox (unchecked), status dot (colored), iteration ID (monospace, first 8 chars), relative time, duration, node counts, invoked-by badge, error code (if failed). Alternating row backgrounds: odd rows get 2% lighter background for readability. Sticky column header row at top of scroll area. | EH-ROW-*, EH-FILT-*, EH-PAGE-*, EH-CMP-*, EH-AUTO-* |
| EH-LIST-002 | Row hover | Mouse enters a row | Row background: `var(--color-bg-hover)` (8% opacity accent). Cursor: `pointer`. Iteration ID cell: "Click to copy" tooltip appears on the ID cell after 500ms hover delay. Status dot: no change. Smooth transition (100ms). | EH-LIST-001 (mouse leaves) |
| EH-LIST-003 | Row — loaded execution | User previously loaded this execution's data | Row has persistent accent left border (3px, `var(--color-accent)`). Background: 5% accent tint. This row's execution data is currently overlaid on the graph + Gantt. Only one row can be in this state at a time. | EH-ROW-001 (click different row) |
| EH-LIST-004 | Row — running execution | Execution has status `running` or `cancelling` | Status dot: pulsing animation (1.5s cycle). Duration cell: live counter (updates every 1s, pulsing text). Node count: updates in real-time as AutoDetector reports node completions (e.g., "12/30" → "13/30"). Row has subtle blue tint for running, amber tint for cancelling. | EH-LIST-005 (completes), EH-LIST-006 (fails) |
| EH-LIST-005 | Row — execution just completed | AutoDetector reports running → completed | Dot pulse stops, dot color transitions to green (300ms crossfade). Duration counter freezes at final value. Node count shows final tally. Row highlight pulse: green glow (300ms, single pulse) to draw attention. If row was being live-tracked: toast "Execution completed — 30/30 nodes succeeded." | EH-LIST-001 |
| EH-LIST-006 | Row — execution just failed | AutoDetector reports running → failed | Dot pulse stops, dot color transitions to red. Error column populates with error code (slides in from right, 160ms). Node count shows final with failed count in red: "25/30 (5✕)". Row highlight pulse: red glow (300ms, single). | EH-LIST-001 |
| EH-LIST-007 | Scroll — more rows below | List has more rows than visible area | Standard scrollbar (thin, 6px, accent thumb on transparent track). Scroll shadows: subtle gradient at top/bottom edges of scrollable area when content extends beyond. Keyboard: `↑`/`↓` moves focus, `Page Up`/`Page Down` scrolls by visible height. | EH-PAGE-001 (scroll to bottom) |

---

## 4. ROW INTERACTION STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-ROW-001 | Row click — loading execution | Click on a row (anywhere except checkbox and iteration ID) | Clicked row: selection highlight (accent background 10%). Status dot temporarily replaced by 12px spinner (same position/size) to indicate data fetch. Other rows: deselected (only one loaded at a time). API call: `getDAGExecMetrics/{iterationId}`. Previous loaded execution overlay cleared from graph. | EH-ROW-002, EH-ROW-004 |
| EH-ROW-002 | Row click — execution loaded | `getDAGExecMetrics` returns 200 | Spinner replaced by original status dot. Row gets persistent accent left border (EH-LIST-003). DAG graph: node statuses overlay with execution colors. Gantt chart: renders this execution's timeline. Node detail panel: updates if a node is selected. Data cached in `Map<iterationId, DagExecutionInstance>` for instant re-load. | EH-LIST-001, EH-ROW-001 (click different row) |
| EH-ROW-003 | Row click — cache hit | Click row whose execution data is already cached | No spinner. Instant overlay on graph + Gantt (< 5ms). Same visual as EH-ROW-002 but perceived as instant. | EH-LIST-003 |
| EH-ROW-004 | Row click — load error | `getDAGExecMetrics` returns 404 | Spinner replaced by red ✕ icon (brief, 1s, then reverts to status dot). Toast: "Execution {id} not found — it may have been cleaned up." Row gets subtle red tint (2s, then fades to normal). Row remains in list (don't auto-remove — user may want to see it). | EH-LIST-001 |
| EH-ROW-005 | Row click — load error (other) | API returns 401/500/network error | Spinner replaced by status dot. Toast: "Failed to load execution: {error}." Row deselects. | EH-LIST-001 |
| EH-ROW-006 | Row double-click | Double-click on a row | Same as EH-ROW-001 (loads execution), but after load completes: auto-switch to Gantt tab (`Alt+1` equivalent). Gantt renders and receives focus. | EH-ROW-002 + auto Gantt switch |
| EH-ROW-007 | Iteration ID click — copy | Click specifically on the iteration ID cell (8-char truncated UUID) | Full UUID copied to clipboard via `navigator.clipboard.writeText()`. Cell background: flash green (200ms) with checkmark icon. Tooltip: "Copied!" (persists 2s). Does NOT trigger row load (cell is a separate click target). If clipboard API fails: select text in cell for manual copy, tooltip: "Ctrl+C to copy". | EH-LIST-001 |
| EH-ROW-008 | Row focus (keyboard) | Tab into list, or `↑`/`↓` arrow keys | Focused row gets 2px accent outline (focus ring). Background: same as hover state. Focus ring visible only on keyboard navigation (`focus-visible`), not on mouse click. | EH-ROW-001 (Enter), EH-CMP-002 (Space) |

---

## 5. FILTER STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-FILT-001 | No filters active | Default state | Filter bar: "All" dropdown (status), "All" dropdown (invoked by). No active filter pills. Status bar: "{N} executions" total count. Compare button at right. | EH-FILT-002, EH-FILT-005 |
| EH-FILT-002 | Status filter — dropdown open | Click "Status" dropdown | Dropdown appears below: checkboxes for All, Completed, Failed, Cancelled, Running. Current selection highlighted with checkmark. Click to select — dropdown closes. Multiple selection via holding Shift (OR logic). | EH-FILT-003 |
| EH-FILT-003 | Status filter active | User selects a status (not "All") | Dropdown closes. Filter pill appears: "Status: Failed" (accent pill, removable with ✕). API re-fetches with `?statuses=failed`. List replaces with filtered results (no merge — full replacement). Loading spinner in list area during fetch. Count updates: "3 of 20 executions". If 0 results: EH-EMPTY-002. | EH-FILT-001 (clear), EH-EMPTY-002 |
| EH-FILT-004 | Status filter cleared | Click ✕ on status filter pill | Pill removed. API re-fetches without status filter. List repopulates. | EH-FILT-001 |
| EH-FILT-005 | Invoked-by filter — dropdown open | Click "Invoked By" dropdown | Dropdown: All, Manual, Scheduled, API. Client-side filter (no API re-fetch). | EH-FILT-006 |
| EH-FILT-006 | Invoked-by filter active | User selects invoked-by type | Pill: "Invoked: Manual". Client-side filter: rows not matching are hidden (instant, no API call). Count updates: "8 of 20 executions (client filter)". | EH-FILT-001 (clear), EH-EMPTY-002 |
| EH-FILT-007 | Combined filters | Both status and invoked-by active | Two pills visible. Status filter applied server-side (API param), invoked-by filter applied client-side. Intersection of both filters shown. Count: "2 of 20 executions (2 filters)". | EH-FILT-001 (clear all) |
| EH-FILT-008 | Clear all filters | Click "Clear filters" (if visible) or `Escape` when filter dropdown focused | All pills removed. API re-fetches without filters. List repopulates with unfiltered data. | EH-FILT-001 |

---

## 6. AUTO-REFRESH STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-AUTO-001 | New execution detected — from AutoDetector | AutoDetector fires `onExecutionDetected(id, exec)` for a new iteration ID | New row slides in at top of list (200ms ease-out, translates from `translateY(-36px)` to `translateY(0)` with opacity 0→1). Row has accent glow pulse (3s fade-out) to draw attention. Status: based on AutoDetector data (usually "Running" with pulsing dot). Duration: starts at "0s" with live counter. If list was scrolled down: "1 new ▲" pill appears at top of list area. | EH-LIST-004 (running), EH-LIST-001 |
| EH-AUTO-002 | New execution detected — from poll | 30s poll returns new iteration ID not in list | Same as EH-AUTO-001 but data comes from API (full `DagExecutionIteration` fields). If AutoDetector already added a partial row for this ID: merge API data into existing row (no visual change, just data enrichment). | EH-LIST-001 |
| EH-AUTO-003 | Execution updated — progress | AutoDetector fires `onExecutionUpdated` with node count change | Running row updates in-place: node count cell animates from "12/30" → "13/30" (number roll, 200ms). Duration counter continues. No row reflow — only cell content changes. Efficient: only the 2 changed cells re-render, not the entire row. | EH-LIST-004 |
| EH-AUTO-004 | Execution updated — completed | AutoDetector fires `onExecutionUpdated` with status "completed" | See EH-LIST-005. Row updates in-place. If this execution is currently loaded (graph overlay): graph + Gantt update to final state. | EH-LIST-005 |
| EH-AUTO-005 | Execution updated — failed | AutoDetector fires `onExecutionUpdated` with status "failed" | See EH-LIST-006. Row updates with error code. | EH-LIST-006 |
| EH-AUTO-006 | New execution pill — click | User clicks "N new ▲" pill at top | Smooth scroll to top of list (200ms ease-out). Pill fades out. If > 5 new rows arrived while scrolled: instant jump (no animation — would be disorienting). | EH-LIST-001 |
| EH-AUTO-007 | Deduplication | Same iteration ID reported by both AutoDetector and poll | AutoDetector data (real-time, possibly partial) is replaced by poll data (complete `DagExecutionIteration`). No visual flicker. Row stays in same position. Any live counter/animation continues uninterrupted. | (current state) |
| EH-AUTO-008 | Poll error — silent | 30s poll returns error | Console log: "History poll failed: {error}". No toast (prevent spam). Existing list unchanged. Retry on next 30s interval. After 3 consecutive failures: subtle "Offline" indicator in filter bar (grey dot). Indicator clears on next successful poll. | (current state) |

---

## 7. PAGINATION STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-PAGE-001 | Load More visible | Continuation token present in last API response | Bottom of list: "Load more" row spanning full width. Text: "Load more (N remaining)" if count known, or "Load more..." if unknown. Style: ghost button styling, centered text, dashed top border to separate from data rows. | EH-PAGE-002 |
| EH-PAGE-002 | Load More — loading | User clicks "Load more" or scrolls to bottom (if lazy-load enabled) | "Load more" text → "Loading..." + spinner. API call: `?continuationToken={token}&historyCount=20`. Existing rows unchanged. | EH-PAGE-003, EH-PAGE-004 |
| EH-PAGE-003 | Load More — success | API returns next page | New rows append below existing rows (staggered fade-in, 30ms/row). "Load more" row moves down (or disappears if no more continuation token). Count updates. Scroll position preserved (new rows are below viewport if user didn't scroll). Page cap: after 5 pages (100 rows), hide "Load more" and show "Showing last 100 executions" text. | EH-LIST-001 |
| EH-PAGE-004 | Load More — error | API returns error | "Loading..." → "Failed to load more — [Retry]". Click "Retry" re-fetches same page. | EH-PAGE-002 (retry) |
| EH-PAGE-005 | All pages loaded | No continuation token in response, or 5-page cap reached | "Load more" row hidden. If cap reached: "Showing last 100 executions. Use status filter to find specific runs." | EH-LIST-001 |

---

## 8. COMPARE MODE STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-CMP-001 | Zero selected | Default or after clearing all selections | All checkboxes unchecked. Compare button: disabled, text "Compare", 40% opacity. | EH-CMP-002 |
| EH-CMP-002 | One selected | User checks one row's checkbox (click checkbox or `Space` on focused row) | Checked row: checkbox filled with accent color + checkmark. Row gets subtle accent tint (3% background). Compare button: still disabled, text "Compare (1/2)" — guides user to select second row. Other checkboxes: remain interactive. | EH-CMP-003, EH-CMP-001 (uncheck) |
| EH-CMP-003 | Two selected | User checks a second row's checkbox | Second row: same visual as first. Compare button: enabled, accent color, text "Compare ▸". Keyboard shortcut active: `Ctrl+Shift+C`. All other checkboxes still interactive — checking a third deselects the oldest (FIFO). | EH-CMP-004, EH-CMP-002 (uncheck one), EH-CMP-005 (third check) |
| EH-CMP-004 | Compare initiated — loading | User clicks "Compare ▸" or `Ctrl+Shift+C` | Both selected executions need full data (`DagExecutionInstance`). If cached: instant. If not cached: list area shows overlay spinner + "Loading comparison data...". Fetches `getDAGExecMetrics` for any uncached execution. | EH-CMP-006, EH-CMP-009 |
| EH-CMP-005 | Third checkbox — FIFO deselect | User checks a third row while 2 are already checked | Oldest selection (first checked) automatically unchecks. Animation: unchecked row's checkbox fades out the checkmark (100ms), tint removed. Newly checked row becomes the second selection. Compare button remains enabled. This prevents a "too many selected" error — keeps flow smooth. | EH-CMP-003 |
| EH-CMP-006 | Compare view — displayed | Both executions loaded | History list is replaced by comparison panel (animated crossfade, 200ms). Top: "← Back to History" link + "Comparing: {id1} vs {id2}". Summary cards side-by-side (Run A, Run B). Diff table below: only changed nodes shown. Color coding: red rows = regressions, green = improvements, blue = added, grey = removed. Focus moves to "Back to History" link. | EH-CMP-007, EH-CMP-008, EH-CMP-010 |
| EH-CMP-007 | Compare — diff row click | User clicks a diff row | Node selected in DAG graph (pans to node, highlights). Graph overlay: uses Run B data (newer run) by default. Run toggle in comparison header: "Show: [Run A] [Run B]" — lets user switch which execution overlays the graph. Clicked diff row gets accent left border. | EH-CMP-006 |
| EH-CMP-008 | Compare — toggle graph overlay | User clicks "Show Run A" or "Show Run B" in comparison header | Graph overlay switches to selected run's data. Gantt chart switches. Node colors update (300ms crossfade). Active toggle button: accent background. Inactive: ghost. | EH-CMP-006 |
| EH-CMP-009 | Compare — load error | One or both `getDAGExecMetrics` calls fail | Overlay spinner replaced by error: "Failed to load execution data for comparison — {error}". [Retry] button. If only one failed: "Loaded {id1} but failed to load {id2} — [Retry failed]". | EH-CMP-004 (retry), EH-CMP-011 (cancel) |
| EH-CMP-010 | Compare — show all nodes | User clicks "Show all nodes" toggle | Unchanged nodes (same status, similar duration) appear with grey/muted styling. Table expands. Toggle text changes to "Show changed only". Scroll to top of table. | EH-CMP-006 |
| EH-CMP-011 | Compare — exit | "← Back to History" clicked, `Escape` pressed, or different tab selected | Comparison panel fades out (160ms), history list fades in (160ms crossfade). Checkboxes cleared (both unchecked). Compare button: disabled. Graph overlay: reverts to most recently loaded execution (or clears if none was loaded pre-compare). Focus returns to list. | EH-LIST-001, EH-CMP-001 |
| EH-CMP-012 | Compare — no changes detected | Two executions selected but diff algorithm finds zero changed nodes | Comparison panel shows summary cards + message: "No differences found between these two runs. All {N} nodes completed with similar timing." [Show all nodes] button available. | EH-CMP-010, EH-CMP-011 |

---

## 9. EMPTY STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EH-EMPTY-001 | No executions ever | API returns empty list with no continuation token | Panel center: muted clock icon (48px, 30% opacity) + "No DAG executions yet" (primary text) + "Click 'Run DAG' to trigger your first execution." (secondary text) + [▸ Run DAG] button (accent, mirrors toolbar Run button). No filter bar controls. Clean, inviting — not an error state. | EH-AUTO-001 (new execution detected), EH-LOAD-001 (manual refresh) |
| EH-EMPTY-002 | No executions match filter | Filters active, but 0 results | Panel center: "No executions match your filters" + "Try changing the status or invoked-by filter." + [Clear Filters] button (ghost). Filter pills remain visible at top (so user knows what's filtering). | EH-FILT-001 (clear filters) |
| EH-EMPTY-003 | Load error | `listDAGExecutionIterationIds` returns error | Panel center: red ✕ icon (24px) + "Failed to load execution history" + "{error message}" (muted secondary text) + [Retry] button (accent). Filter bar visible but controls dimmed. | EH-LOAD-001 (retry) |
| EH-EMPTY-004 | No executions + running | Empty history but a new execution is starting (detected via AutoDetector before poll returns it) | Same as EH-EMPTY-001 but immediately transitions to EH-AUTO-001 as the new row slides in. Brief flash of empty state (< 1s) is acceptable — the running execution row replaces it. | EH-AUTO-001 |

---

## 10. KEYBOARD NAVIGATION STATES

| ID | State | Trigger | What User Sees | Behavior |
|----|-------|---------|----------------|----------|
| EH-KBD-001 | List focused — initial | Tab into history panel or `Alt+2` switches to History tab | Focus ring on first row (or currently loaded row if one exists). `aria-activedescendant` points to focused row. Screen reader: announces row summary "Completed, iteration a1b2, 2 minutes ago, 30 of 30 nodes". | Focus target established |
| EH-KBD-002 | Arrow navigation | `↑` or `↓` while list focused | Focus ring moves to adjacent row. Smooth: 0ms (instant). If moving past visible area: scroll to keep focused row visible (centered if possible). `Home` → first row. `End` → last loaded row. `Page Up/Down` → jump by visible page height. | Focus moves |
| EH-KBD-003 | Enter — load execution | `Enter` on focused row | Same as EH-ROW-001 (click to load). Focus remains on the row (not stolen by graph). | EH-ROW-001 |
| EH-KBD-004 | Space — toggle checkbox | `Space` on focused row | Toggle checkbox for compare mode. Same as clicking the checkbox. Announced to screen reader: "Selected for comparison" or "Deselected". | EH-CMP-002/003 |
| EH-KBD-005 | Ctrl+Shift+C — compare | Shortcut pressed with 2 rows checked | Same as clicking Compare button. If < 2 checked: no-op. | EH-CMP-004 |
| EH-KBD-006 | Escape — exit compare | `Escape` in compare view | Same as EH-CMP-011. Focus returns to list. | EH-CMP-011 |
| EH-KBD-007 | Escape — clear selection | `Escape` in list view with checked rows | All checkboxes unchecked. Compare button disabled. Focus remains in list. | EH-CMP-001 |
| EH-KBD-008 | Tab — move between zones | `Tab` from list rows | Focus moves to: filter bar → status dropdown → invoked-by dropdown → compare button → back to list. Standard tab order. | — |

---

## 11. TRANSITION ANIMATIONS

| Transition | Animation | Duration | Easing |
|------------|-----------|----------|--------|
| New row slide in (auto-refresh) | `translateY(-36px)` → `translateY(0)` + opacity 0→1 | 200ms | ease-out |
| New row attention pulse | Box-shadow glow: `0 0 0 2px var(--color-accent)` → transparent | 3000ms | ease-out |
| Row data load (stagger) | Opacity 0→1, per row delay 30ms | 160ms each | ease-out |
| Row hover | Background opacity 0→8% | 100ms | ease-out |
| Row selection (loaded) | Left border 0→3px accent + background 0→5% accent | 160ms | `var(--ease-standard)` |
| Checkbox check | Scale 0.8→1.0 + opacity 0→1 on checkmark | 120ms | ease-out |
| Checkbox uncheck | Opacity 1→0 on checkmark | 100ms | ease-in |
| Compare button enable | Opacity 0.4→1.0 + color: ghost→accent | 160ms | `var(--ease-standard)` |
| List ↔ Compare crossfade | List fades out + compare fades in, overlapping | 200ms | ease-in-out |
| Diff row color coding | Background fade-in (red/green/blue/grey) | 200ms | ease-out |
| Status dot color change | Background-color crossfade | 300ms | linear |
| Dot pulse start | `@keyframes status-pulse` activates | 1500ms loop | ease-in-out |
| Dot pulse stop | Pulse stops, opacity snaps to 1.0 | instant | — |
| Duration counter update | Number roll (outgoing digit slides up, incoming slides down) | 200ms | ease-out |
| Node count increment | Same number roll | 200ms | ease-out |
| Filter pill appear | `translateX(-8px)` → `translateX(0)` + opacity 0→1 | 160ms | ease-out |
| Filter pill remove | Opacity 1→0 + `translateX(8px)` | 120ms | ease-in |
| "N new" pill appear | Slide in from top + opacity 0→1 | 200ms | ease-out |
| "N new" pill dismiss | Opacity 1→0 | 160ms | ease-in |
| Clipboard flash (copy ID) | Cell background: transparent → green → transparent | 200ms×2 | ease-in-out |
| Loading spinner (row) | Replaces status dot with rotation animation | — | linear |
| Error row tint | Red tint fade in → hold 2s → fade out | 200ms+2000ms+300ms | ease-out |
| Pagination row appear | Staggered fade-in (same as initial load) | 30ms/row | ease-out |
| Empty state appear | Opacity 0→1 + `translateY(8px)` → `translateY(0)` | 300ms | ease-out |

---

## 12. ERROR STATE SUMMARY

| State ID | Error | Visual | Recovery |
|----------|-------|--------|----------|
| EH-EMPTY-003 | History list load failure | Centered error + Retry button | Retry |
| EH-ROW-004 | Execution detail 404 | Toast + row red tint (brief) | Row remains, may retry |
| EH-ROW-005 | Execution detail auth/server | Toast + row deselects | Fix auth, retry |
| EH-CMP-009 | Compare load failure | Overlay error + Retry | Retry or cancel compare |
| EH-PAGE-004 | Pagination failure | "Load more" → "Failed — Retry" | Retry link |
| EH-AUTO-008 | Poll failure (3+ consecutive) | Subtle "Offline" dot in filter bar | Auto-retries; clears on success |
| EH-FILT-003 (error) | Status filter API error | Toast + list shows stale data | Clear filter or retry |

---

*"62 states. From first load to comparison to live-tracking a running execution — every transition accounted for, every error recoverable."*
