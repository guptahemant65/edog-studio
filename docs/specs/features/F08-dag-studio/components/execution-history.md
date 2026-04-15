# Execution History — Component Spec

> **Feature:** F08 DAG Studio — Section 2.4 Execution History
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend) + Vex (Backend) + Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `spec.md` §2.4, `p0-foundation.md` (APIs 2–3, DagExecutionIteration, DagExecutionInstance), `auto-detect.js`
> **Feeds Into:** `states/execution-history.md`, `dag-studio.js`

---

## 0. Overview

The Execution History is a tabbed panel (sharing the bottom 40% with Gantt chart) that shows past DAG runs, supports loading any run's data into the graph + Gantt, and provides a comparison mode to diff two executions side-by-side.

**Design principle:** The history list is the engineer's flight recorder. Every run is one click away from full re-inspection. Comparison is the killer feature — "what changed between yesterday's good run and today's failure?" should be answerable in under 5 seconds.

---

## 1. Layout

### 1.1 Tab Position

The bottom panel has 3 tabs:

| Tab | Label | Icon | Shortcut |
|-----|-------|------|----------|
| 1 | Gantt | Timeline bars | `Alt+1` |
| 2 | **History** | Clock icon | `Alt+2` |
| 3 | Node Detail | Card icon | `Alt+3` (or auto-opens on node select) |

### 1.2 History Panel Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ Filter: [All ▾] [Status ▾] [Invoked By ▾]   [Compare (2)] [↻]    │  ← Filter bar
├────────────────────────────────────────────────────────────────────┤
│ ☐ │ ● │ a1b2c3d4 │ 2m ago    │ 1m 23s │ 28/30 (2✕) │ Manual │  │  ← Row (selected bg)
│ ☐ │ ● │ e5f6a7b8 │ 1h ago    │ 45s    │ 30/30      │ Sched  │  │  ← Row
│ ☐ │ ● │ c9d0e1f2 │ 3h ago    │ 2m 07s │ 25/30 (5✕) │ Manual │  │  ← Row
│   │   │          │           │        │            │        │  │
│   │ ── Load More (17 remaining) ───────────────────────────── │  │  ← Pagination
└────────────────────────────────────────────────────────────────────┘
```

- **Row height:** 36px
- **Column widths:** Fixed layout, no resizing (simpler than Traffic Monitor — fewer columns)
- **Scroll:** Vertical scroll within panel. Sticky header row.
- **Max visible:** Depends on panel height (typically 6–10 rows at default split)

---

## 2. Columns

| # | Column | Width | Content | Sort | Notes |
|---|--------|-------|---------|------|-------|
| 1 | Select | 32px | Checkbox | — | For compare mode. Max 2 selected. |
| 2 | Status | 28px | Color dot (●) | — | Color-coded by `DagExecutionStatus` |
| 3 | Iteration ID | 80px | First 8 chars of UUID | — | Click to copy full UUID. Monospace. Tooltip: full UUID |
| 4 | Started | 80px | Relative time | Sortable (default: newest first) | "2m ago", "1h ago", "3d ago". Hover tooltip: absolute ISO 8601 |
| 5 | Duration | 72px | Formatted time | Sortable | "45s", "1m 23s", "12m 7s". In-progress: live counter. |
| 6 | Nodes | 96px | `completed/total` | Sortable (by completion ratio) | Failed count in red: `28/30 (2✕)`. Skipped in grey if any. |
| 7 | Invoked By | 64px | Type badge | Filterable | "Manual" / "Sched" / "API" — compact labels |
| 8 | Error | flex | Error code | — | Only shown if failed. `MLV_RUNTIME_ERROR` etc. Truncated with tooltip. |

### 2.1 Status Color Mapping

| DagExecutionStatus | Dot Color | Dot Style |
|--------------------|-----------|-----------|
| `completed` | `var(--status-succeeded)` (green) | Solid ● |
| `failed` | `var(--status-failed)` (red) | Solid ● |
| `cancelled` | `var(--color-warning)` (amber) | Solid ● |
| `running` | `var(--color-accent)` (blue) | Pulsing ● |
| `cancelling` | `var(--color-warning)` (amber) | Pulsing ● |
| `notStarted` | `var(--color-text-tertiary)` (grey) | Hollow ○ |
| `skipped` | `var(--color-text-tertiary)` (grey) | Dimmed ● |

### 2.2 Relative Time Formatting

| Age | Format | Example |
|-----|--------|---------|
| < 60s | "{N}s ago" | "12s ago" |
| < 60min | "{N}m ago" | "47m ago" |
| < 24h | "{N}h ago" | "3h ago" |
| < 7d | "{N}d ago" | "2d ago" |
| >= 7d | Date | "Jul 23" |

**Refresh:** Relative times update every 30s via a single `setInterval` that batch-updates all visible rows.

### 2.3 Duration Formatting

| Duration | Format |
|----------|--------|
| < 60s | `{N}s` — e.g., "45s" |
| 1–59min | `{M}m {S}s` — e.g., "1m 23s" |
| >= 60min | `{H}h {M}m` — e.g., "1h 12m" |
| In progress | Live counter with pulsing animation |

---

## 3. Data Source

### 3.1 Initial Load

```
GET /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/listDAGExecutionIterationIds
  ?historyCount=20
```

**Response:** `List<DagExecutionIteration>` — lightweight iteration metadata (no per-node metrics).

### 3.2 Pagination

The API returns a `x-ms-continuation-token` response header when more results exist.

- **"Load More" row:** Shown at the bottom of the list when continuation token is present
- **Click "Load More":** Fetches next page with `?continuationToken={token}&historyCount=20`
- **Remaining count:** If known, show "(N remaining)". If unknown, show "Load more..."
- **Append:** New rows append below existing rows (no re-sort)
- **Max pages:** Cap at 5 pages (100 total rows) to prevent unbounded memory growth

### 3.3 Full Execution Detail (On Row Click)

```
GET /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/getDAGExecMetrics/{iterationId}
```

**Response:** `DagExecutionInstance` — full execution with per-node metrics.

This is the heavyweight call — only made when the user clicks a specific row. Cached in memory: `Map<iterationId, DagExecutionInstance>`.

### 3.4 Status Filtering

```
GET .../listDAGExecutionIterationIds?statuses=failed,cancelled&historyCount=20
```

The API supports filtering by status. The UI dropdown maps to API query params.

---

## 4. Interactions

### 4.1 Row Click — Load Execution

| Step | Action |
|------|--------|
| 1 | Row gets selection highlight (accent background at 10% opacity) |
| 2 | Show loading spinner in the row (replacing status dot temporarily) |
| 3 | Fetch `getDAGExecMetrics/{iterationId}` |
| 4 | On success: overlay execution data onto the DAG graph (node statuses, timing) |
| 5 | Render Gantt chart for this execution (auto-switch to Gantt tab if user preference) |
| 6 | Status dot returns. Row stays highlighted as "loaded execution" |

**Cache hit:** If execution data is already cached (same session), skip fetch — instant overlay.

**Error handling:**
- 404: Toast "Execution not found — may have been cleaned up". Remove row from list.
- 401/500: Toast with error. Row deselects.

### 4.2 Row Double-Click — Load + Switch to Gantt

Same as single click, but after loading, automatically switch to the Gantt tab. This is the "I want to see the timeline" shortcut.

### 4.3 Click to Copy Iteration ID

Clicking the iteration ID cell copies the full UUID to clipboard:
- Visual feedback: cell background flashes green (200ms), tooltip shows "Copied!"
- `navigator.clipboard.writeText(fullIterationId)`
- On clipboard API failure: select the text for manual copy

---

## 5. Compare Mode

### 5.1 Selection

- Checkboxes in column 1 allow selecting up to 2 rows
- **0 selected:** Compare button disabled, greyed text "Compare"
- **1 selected:** Compare button disabled, text "Compare (1/2)"
- **2 selected:** Compare button enabled, text "Compare ▸", accent color
- **3+ attempt:** Third checkbox click deselects the oldest selection (FIFO)
- **Keyboard:** `Space` on focused row toggles checkbox

### 5.2 Compare Button

- **Position:** Right side of filter bar
- **Style:** Ghost button → primary accent when 2 selected
- **Shortcut:** `Ctrl+Shift+C` (when History tab active and 2 rows selected)

### 5.3 Comparison View

Clicking "Compare" replaces the history list with a comparison panel.

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Back to History    Comparing: a1b2c3d4 vs e5f6a7b8              │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  SUMMARY                                                           │
│  ┌─────────────────────┐  ┌─────────────────────┐                 │
│  │ Run A: a1b2c3d4     │  │ Run B: e5f6a7b8     │                 │
│  │ ● Completed         │  │ ● Failed             │                 │
│  │ Duration: 45s       │  │ Duration: 2m 07s     │                 │
│  │ Nodes: 30/30        │  │ Nodes: 25/30 (5✕)   │                 │
│  │ 2h ago              │  │ 47m ago              │                 │
│  └─────────────────────┘  └─────────────────────┘                 │
│                                                                    │
│  DIFF: 8 nodes changed                                             │
│  ┌──────────────┬───────────┬───────────┬──────────────────────┐  │
│  │ Node         │ Run A     │ Run B     │ Delta                │  │
│  ├──────────────┼───────────┼───────────┼──────────────────────┤  │
│  │ SalesData    │ ● 2.1s    │ ● 45.2s   │ ▲ 21× slower (red)  │  │
│  │ JoinCustomer │ ● 1.3s    │ ✕ Failed  │ ▲ Status change (red)│  │
│  │ NewNode      │ —         │ ● 0.8s    │ ◆ Added (blue)       │  │
│  │ OldNode      │ ● 3.2s    │ —         │ ◆ Removed (grey)     │  │
│  └──────────────┴───────────┴───────────┴──────────────────────┘  │
│                                                                    │
│  Only showing changed nodes. [Show all nodes]                      │
└────────────────────────────────────────────────────────────────────┘
```

### 5.4 Comparison Data

Both executions must be fetched via `getDAGExecMetrics` (may already be cached).

**Diff algorithm:**

1. Build a union set of all node IDs from both runs
2. For each node, compare:

| Comparison | Condition | Visual |
|------------|-----------|--------|
| Status changed | `runA.status ≠ runB.status` | Red row if regression (was green, now red). Green if improvement. |
| Duration regression | `runB.duration > runA.duration × 2` | Red text with multiplier "21× slower" |
| Duration improvement | `runB.duration < runA.duration × 0.5` | Green text with multiplier "3× faster" |
| New node | Node in B but not in A | Blue "Added" badge |
| Removed node | Node in A but not in B | Grey "Removed" badge |
| New error | Error in B, no error in A | Red row with error code |
| Error resolved | Error in A, no error in B | Green row "Resolved" |
| Unchanged | Same status, similar duration (within 2×) | Hidden by default (toggle to show) |

### 5.5 Compare → Graph Interaction

- Clicking a diff row selects that node in the DAG graph
- The graph overlays Run B's execution data (the newer run by default)
- A toggle in the comparison header allows switching the graph overlay between Run A and Run B
- Nodes that changed status get a split-color border: left half = Run A color, right half = Run B color

### 5.6 Exit Compare Mode

- "← Back to History" link at top of comparison panel
- `Escape` key
- Clicking any tab other than History
- On exit: graph overlay reverts to the most recent loaded execution (or clears if none was loaded pre-compare)

---

## 6. Auto-Refresh

### 6.1 New Execution Detection

Two sources detect new executions:

1. **AutoDetector:** Parses log stream for `[DAG STATUS]` patterns → fires `onExecutionDetected(id, exec)`
2. **Polling:** Re-fetch `listDAGExecutionIterationIds` every 30s (same interval as lock polling)

### 6.2 New Execution Appearance

When a new execution is detected:
- A new row slides in at the top of the list (200ms ease-out animation)
- Row has subtle highlight pulse (accent glow, fades over 3s) to draw attention
- If the list was scrolled down, a "1 new execution ▲" pill appears at the top
- Click the pill → scroll to top

### 6.3 Live Execution Updates

For currently running executions (status = `running` or `cancelling`):
- Status dot: pulsing animation
- Duration: live counter (updates every 1s)
- Node count: updates as `onExecutionUpdated` fires with new node completions
- When execution completes: row updates in-place (no flicker), pulsing stops, final status/duration shown

### 6.4 Auto-Refresh Debouncing

- Polling and AutoDetector may report the same execution. Deduplicate by `iterationId`.
- If a new execution ID from AutoDetector is not yet in the polled list, add it with the partial data from AutoDetector.
- On next poll, the full `DagExecutionIteration` data replaces the partial AutoDetector data.

---

## 7. Filters

### 7.1 Status Filter Dropdown

| Option | API `statuses` param |
|--------|---------------------|
| All | (omit param) |
| Completed | `completed` |
| Failed | `failed` |
| Cancelled | `cancelled` |
| Running | `running` |
| Failed + Cancelled | `failed,cancelled` |

- **Behavior:** Selecting a filter re-fetches the history list with the status filter
- **Visual:** Active filter shown as pill in filter bar

### 7.2 Invoked By Filter

Client-side filter (no API param). Filters the already-loaded list.

| Option | Matches `jobInvokeType` |
|--------|------------------------|
| All | (no filter) |
| Manual | `"Manual"` |
| Scheduled | `"Scheduled"` |
| API | `"Api"` / other |

### 7.3 Definition Filter (Future — V2)

Filter by MLV Execution Definition. Requires API param `mlvExecutionDefinitionIds`.

---

## 8. Empty States

### 8.1 No Executions Ever

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│                  ○ (muted clock icon, 48px)                        │
│                                                                    │
│            No DAG executions yet                                   │
│                                                                    │
│     Click "Run DAG" to trigger your first execution.               │
│     Execution history will appear here.                            │
│                                                                    │
│               [▸ Run DAG]                                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- "Run DAG" button mirrors the toolbar button (same action)
- CTA is primary accent color

### 8.2 No Executions Match Filter

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│            No executions match your filters                        │
│                                                                    │
│     Try changing the status or invoked-by filter.                  │
│                                                                    │
│               [Clear Filters]                                      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 8.3 Loading State

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│            (Spinner, 16px accent)                                  │
│            Loading execution history...                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 8.4 Error State

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│            ✕ Failed to load execution history                      │
│                                                                    │
│     {error message}                                                │
│                                                                    │
│               [Retry]                                              │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 9. Keyboard Navigation

| Shortcut | Action | Context |
|----------|--------|---------|
| `↑` / `↓` | Move row focus | History list focused |
| `Enter` | Load focused execution | Row focused |
| `Space` | Toggle compare checkbox | Row focused |
| `Ctrl+Shift+C` | Open comparison | 2 rows checked |
| `Escape` | Exit compare mode / clear selection | Compare mode or selection active |
| `Alt+2` | Switch to History tab | Bottom panel visible |
| `Home` | Focus first row | History list focused |
| `End` | Focus last loaded row | History list focused |
| `Page Up/Down` | Scroll by visible page height | History list focused |

### 9.1 Focus Management

- Tab into the history list → focus goes to the first row (or the currently loaded execution's row)
- Arrow keys move a focus ring (2px accent outline) between rows
- `Enter` loads, `Space` toggles checkbox — distinct actions on the same element
- When compare view opens, focus moves to the "Back to History" link

---

## 10. Performance

| Metric | Target | Strategy |
|--------|--------|----------|
| Initial history load | < 500ms | `listDAGExecutionIterationIds` is lightweight (no node metrics) |
| Row render | < 1ms per row | Static DOM, no virtual scroll needed (max ~100 rows) |
| Execution detail load | < 1s | `getDAGExecMetrics` is heavier — cache aggressively |
| Compare diff calculation | < 100ms | O(n) node merge, n ≤ 300 nodes |
| Relative time refresh | < 5ms | Batch DOM update, single reflow |
| Auto-refresh poll | < 200ms overhead | Lightweight API call, merge-not-replace |

---

## 11. API Reference Summary

| Action | Method | Endpoint | Response |
|--------|--------|----------|----------|
| List history | GET | `.../liveTable/listDAGExecutionIterationIds?historyCount=20` | `List<DagExecutionIteration>` |
| Load execution | GET | `.../liveTable/getDAGExecMetrics/{iterationId}` | `DagExecutionInstance` |
| Filter by status | GET | `.../listDAGExecutionIterationIds?statuses=failed&historyCount=20` | `List<DagExecutionIteration>` |
| Paginate | GET | `.../listDAGExecutionIterationIds?continuationToken={token}` | `List<DagExecutionIteration>` |

---

## 12. Accessibility

- **Table:** `role="grid"`, `aria-label="DAG Execution History"`
- **Rows:** `role="row"`, `aria-selected` for loaded execution, `aria-checked` for compare checkbox
- **Cells:** `role="gridcell"` with appropriate `aria-label` for status dots ("Completed", "Failed", etc.)
- **Status dots:** `aria-label="{status}"` — screen reader announces status, not just color
- **Compare button:** `aria-disabled` when < 2 selected, label includes count "Compare 2 executions"
- **Live updates:** `aria-live="polite"` on the list container — announces new executions
- **Loading state:** `aria-busy="true"` on row while fetching execution detail
- **Relative times:** `datetime` attribute with ISO 8601 value for machine-readability, `aria-label` with absolute time

---

*"History is not a log dump. It's an indexed, searchable, comparable record of every DAG run — the engineer's instant answer to 'what happened?'"*
