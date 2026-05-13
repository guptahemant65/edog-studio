# Execution History — Component Spec

> **Feature:** F08 DAG Studio — Section 2.4 Execution History
> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `spec.md` §2.4, `p0-foundation.md` (APIs 2–3, §4.8 SignalR), `architecture.md` (Flows 1/4)
> **Feeds Into:** `states/execution-history.md`, `dag-studio.js` HistoryPanel module
> **State Matrix:** See `states/execution-history.md` (62 states)

---

## 0. Overview

The Execution History panel is the engineer's **flight recorder** — an indexed, searchable, comparable record of every DAG run. It occupies the bottom 40% tabbed panel (shared with Gantt and Node Detail) and answers: *"What happened, when, and why?"*

Every run is one click away from full re-inspection. The graph lights up, the Gantt renders, the node detail populates. Historical runs are first-class citizens — indistinguishable from a live execution in inspection depth.

**Comparison is the killer feature.** When a DAG that worked yesterday fails today, the engineer checks two boxes, clicks Compare, and in under 5 seconds sees which nodes regressed, which gained new errors, and which were added or removed. This transforms DAG Studio from a monitoring UI into a diagnostic instrument.

---

## 1. Layout

### 1.1 Tab Position

| Tab | Label | Shortcut |
|-----|-------|----------|
| 1 | Gantt | `Alt+1` |
| 2 | **History** | `Alt+2` |
| 3 | Node Detail | `Alt+3` |

Active tab: `var(--color-text)`, 2px bottom border `var(--accent)`. Inactive: `var(--color-text-secondary)`, no border.

### 1.2 Panel Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [All Statuses ▾] [All Invokers ▾]          [Compare (0/2)] [↻ Refresh] │ ← Filter bar (36px)
├────┬────┬──────────┬──────────┬────────┬────────────┬────────┬─────────┤
│ ☐  │ ●  │ Iter. ID │ Started  │ Dur.   │ Nodes      │ By     │ Error   │ ← Headers (28px, sticky)
├────┼────┼──────────┼──────────┼────────┼────────────┼────────┼─────────┤
│ ☐  │ ●  │ a1b2c3d4 │ 2m ago   │ 1m 23s │ 28/30 (2✕) │ Manual │ MLV_... │ ← Row (36px)
│ ☐  │ ●  │ e5f6a7b8 │ 1h ago   │ 45s    │ 30/30      │ Sched  │         │
│ ☐  │ ●  │ c9d0e1f2 │ 3h ago   │ 2m 07s │ 25/30 (5✕) │ Manual │ MLV_... │
│ ── Load More (17 remaining) ────────────────────────────────────────── │ ← Pagination
└─────────────────────────────────────────────────────────────────────────┘
```

| Element | Value |
|---------|-------|
| Filter bar | 36px height, `var(--color-bg-secondary)`, bottom border `var(--color-border)` |
| Header row | 28px, 11px uppercase `var(--color-text-secondary)`, sticky |
| Data row | 36px, vertically centered |
| Loaded row | 3px left border `var(--accent)`, background `var(--accent-dim)` |
| Scroll | Vertical within panel. 6–10 rows visible at default split. |
| Load More | 32px, centered `var(--accent)` link |

---

## 2. Columns

| # | Column | Width | Content | Sort | Notes |
|---|--------|-------|---------|------|-------|
| 1 | Select | 32px | Checkbox | — | Compare mode. Max 2. FIFO on 3rd. |
| 2 | Status | 28px | Color dot ● | — | By `DagExecutionStatus` (§2.1) |
| 3 | Iteration ID | 80px | First 8 UUID chars | — | Monospace. Click → copy full UUID. Tooltip: full GUID. |
| 4 | Started | 80px | Relative time | Default desc | Tooltip: ISO 8601. See §2.2. |
| 5 | Duration | 72px | Formatted time | Yes | Live counter if running. See §2.3. |
| 6 | Nodes | 96px | `done/total` | By ratio | Failed in red: `(2✕)`. Skipped in `var(--color-text-tertiary)`. |
| 7 | Invoked By | 64px | Badge | Filterable | `Manual` / `Sched` / `API`. Pill, 10px. |
| 8 | Error | flex | Error code | — | Failed only. Truncated, tooltip: full message. |

### 2.1 Status Color Mapping

| Status | Token | Dot |
|--------|-------|-----|
| `Completed` | `var(--status-succeeded)` #18a058 | Solid ● |
| `Failed` | `var(--status-failed)` #e5453b | Solid ● |
| `Cancelled` | `var(--status-cancelled)` #e5940c | Solid ● |
| `Running` | `var(--accent)` #6d5cff | Pulsing ● (1.5s) |
| `Cancelling` | `var(--status-cancelled)` #e5940c | Pulsing ● (1.5s) |
| `NotStarted` | `var(--status-pending)` #8e95a5 | Hollow ○ |
| `Skipped` | `var(--status-pending)` #8e95a5 | Dimmed ● (50%) |

Pulsing: `opacity` 1.0↔0.3 over 1.5s ease-in-out. CSS class `.status-pulsing`.

### 2.2 Relative Time

| Age | Format |
|-----|--------|
| < 60s | `{N}s ago` |
| < 60min | `{N}m ago` |
| < 24h | `{N}h ago` |
| < 7d | `{N}d ago` |
| >= 7d | `Jul 23` |

Single `setInterval(30s)` batch-updates all visible relative times.

### 2.3 Duration Format

| Duration | Format |
|----------|--------|
| < 60s | `45s` |
| 1–59min | `1m 23s` |
| >= 60min | `1h 12m` |
| Running | Live counter, pulsing text, 1s updates |

---

## 3. Data Source

### 3.1 Initial Load

```
GET /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/listDAGExecutionIterationIds
    ?historyCount=20
```

Returns `List<DagExecutionIteration>` — lightweight metadata (iterationId, status, startedAt, endedAt, dagName, jobInvokeType, errorCode). No per-node metrics. Source: `LiveTableController.cs:379-519`.

### 3.2 Pagination

API returns `x-ms-continuation-token` header when more records exist.

- **Trigger:** Click "Load More" row at bottom
- **Request:** Same endpoint + `&continuationToken={token}&historyCount=20`
- **Append:** New rows below existing. No re-sort.
- **Cap:** Max 5 pages (100 rows) to bound memory
- **Loading:** Spinner replaces "Load More" text. Error → "Failed — Retry" link.

### 3.3 Full Detail (On Row Click)

```
GET /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/getDAGExecMetrics/{iterationId}
```

Returns `DagExecutionInstance` with full `DagExecutionMetrics` + `List<NodeExecutionMetrics>`. Per node: Status, StartedAt/EndedAt, SessionId, ReplId, AddedRowsCount, DroppedRowsCount, TotalRowsProcessed, ErrorCode/ErrorMessage, RefreshPolicy, Warnings, DqCheckResults.

**Cache:** `Map<string, DagExecutionInstance>`, LRU-20, session lifetime (~10 min matches OneLake cache).

### 3.4 Status Filter (Server-Side)

```
GET .../listDAGExecutionIterationIds?statuses=failed,cancelled&historyCount=20
```

Resets pagination. Dropdown maps to comma-separated `statuses` param.

---

## 4. Interactions

### 4.1 Row Click — Load Execution

| Step | Action |
|------|--------|
| 1 | Row highlights: `var(--accent-dim)` bg, 3px left accent border |
| 2 | Previous loaded row loses styling |
| 3 | If not cached: 12px spinner replaces status dot |
| 4 | Fetch `getDAGExecMetrics/{iterationId}` |
| 5 | Overlay execution on graph (node statuses + timing) + Gantt |
| 6 | Spinner → status dot. Row keeps loaded styling. |

Cache hit: skip fetch, instant overlay (<16ms).

**Errors:** 404 → toast + remove row. 401/403 → "Auth expired" toast. 429 → "Rate limited" toast. 500 → error toast. All deselect the row.

### 4.2 Double-Click — Load + Gantt

Same as click, then auto-switch to Gantt tab.

### 4.3 Copy Iteration ID

Click column 3 → `navigator.clipboard.writeText(fullId)`. Text flashes `var(--status-succeeded)` 200ms, tooltip "Copied!". Fallback: select for manual copy.

### 4.4 Row Hover

Background → `var(--color-bg-tertiary)` (100ms). Cursor: pointer. 500ms delay → tooltip on ID cell.

---

## 5. Compare Mode — The Killer Feature

Compare mode is the reason DAG Studio exists as a diagnostic tool, not just a monitoring UI. When a DAG that worked yesterday fails today, or a normally-fast DAG takes 10× longer, the engineer needs "what changed?" in under 5 seconds.

**User story:** Engineer triggers a DAG. It fails. Yesterday's run succeeded. Two checkboxes, one click, 5 seconds later: node `SalesData` regressed 21× slower, `JoinCustomer` went from Completed to Failed with `MLV_STALE_METADATA`, and a new `AuditLog` node was added. Click `JoinCustomer` in the diff → graph highlights it, detail panel shows the error. Root cause: 8 seconds.

### 5.1 Selection Mechanics

| Checked | Button State | Visual |
|---------|-------------|--------|
| 0 | Disabled, text `Compare` | All unchecked |
| 1 | Disabled, text `Compare (1/2)`, `var(--color-text-secondary)` | One checked |
| 2 | **Enabled**, text `Compare ▸`, `var(--accent)` bg, white text | Two checked |
| 3rd click | **FIFO:** oldest unchecks (150ms fade), new checks | Always exactly 2 |

FIFO: internal array `[oldestId, newestId]`. On 3rd check → shift/push. `Space` on focused row toggles checkbox with same FIFO rules.

### 5.2 Compare Button

- **Position:** Right of filter bar, before refresh
- **Inactive:** Ghost button, border `var(--color-border)`
- **Active:** `var(--accent)` bg, white text, subtle shadow
- **Shortcut:** `Ctrl+Shift+C` (History tab active, 2 checked)
- **Focus ring:** 2px `var(--accent-glow)` outline, offset 2px

### 5.3 Comparison View

Replaces history list. Tab bar remains visible.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Back to History        Comparing: a1b2c3d4  vs  e5f6a7b8            │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────┐    ┌──────────────────────────┐          │
│  │ Run A (Baseline)         │    │ Run B (Current)          │          │
│  │ ● Completed    45s       │    │ ● Failed    2m 07s (2.8×)│          │
│  │ Nodes: 30/30             │    │ Nodes: 25/30 (5✕)        │          │
│  │ Jul 29 14:23 · Scheduled │    │ Jul 30 09:17 · Manual    │          │
│  └──────────────────────────┘    └──────────────────────────┘          │
│                                                                         │
│  NODE DIFF: 8 of 31 changed                   [Show unchanged (23)]   │
│  ┌───────────────┬───────────┬───────────────┬─────────────────────┐   │
│  │ Node          │ Run A     │ Run B         │ Delta               │   │
│  ├───────────────┼───────────┼───────────────┼─────────────────────┤   │
│  │ SalesData     │ ● 2.1s    │ ● 45.2s       │ ▲ 21.5× slower     │   │ ← red
│  │ JoinCustomer  │ ● 1.3s    │ ✕ Failed      │ ▲ Regression       │   │ ← red
│  │ AuditLog      │ —         │ ● 0.8s        │ ◆ Added            │   │ ← accent
│  │ OldExport     │ ● 3.2s    │ —             │ ◆ Removed          │   │ ← grey
│  │ Cleanup       │ ✕ Failed  │ ● 0.4s        │ ▼ Resolved         │   │ ← green
│  │ BigJoin       │ ● 12.4s   │ ● 3.1s        │ ▼ 4.0× faster     │   │ ← green
│  │ IngestRaw     │ ● 1.0s    │ ✕ ERR_TIMEOUT │ ▲ New error        │   │ ← red
│  └───────────────┴───────────┴───────────────┴─────────────────────┘   │
│  Graph overlay: [Run A] (Run B)                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

Summary cards: `var(--color-bg-secondary)` bg, 1px `var(--color-border)`, 6px radius, `calc(50% - 6px)` width each.

### 5.4 Diff Algorithm

Both executions fetched via `getDAGExecMetrics` (may already be cached). **O(n) where n = union of node IDs:**

1. **Build union set** of all node IDs from both runs
2. **Index** both run's nodes into `Map<nodeId, NodeExecutionMetrics>` for O(1) lookup
3. **Compare each node** against the rules below
4. **Sort** by severity (regressions first, then errors, then structural, then improvements)

**Per-node comparison rules:**

| # | Condition | Delta Text | Color |
|---|-----------|------------|-------|
| 1 | A succeeded, B failed | `▲ Regression` | Row tint `var(--status-failed)` 8% |
| 2 | A no error, B has `errorCode` | `▲ New error: {code}` | Row tint `var(--status-failed)` 8% |
| 3 | B.duration > A.duration × 2.0 | `▲ {N}× slower` | Text `var(--status-failed)` |
| 4 | Node in A, absent in B | `◆ Removed` | Text `var(--color-text-tertiary)` |
| 5 | Absent in A, node in B | `◆ Added` | Text `var(--accent)` |
| 6 | A has error, B has none | `▼ Resolved` | Text `var(--status-succeeded)` |
| 7 | B.duration < A.duration × 0.5 | `▼ {N}× faster` | Text `var(--status-succeeded)` |
| 8 | A failed, B succeeded | `▼ Fixed` | Row tint `var(--status-succeeded)` 8% |
| 9 | Same status, duration within 0.5×–2.0×, same errors | `(unchanged)` | Hidden by default |

**Multiplier calculation:**

```javascript
const ratio = durationB / durationA;
if (ratio > 2.0) deltaText = `▲ ${ratio.toFixed(1)}× slower`;   // regression
if (ratio < 0.5) deltaText = `▼ ${(1/ratio).toFixed(1)}× faster`; // improvement
```

**"Show unchanged" toggle:** Default OFF. Unchanged nodes appear at bottom in `var(--color-text-tertiary)`. Label: `Show unchanged (N)`.

### 5.5 Graph Interaction

| Action | Behavior |
|--------|----------|
| Click diff row | Select node in graph. Graph pans to center it. Node detail opens. |
| Hover diff row | Node gets 3px highlight ring `var(--accent-glow)` in graph. |
| Graph overlay toggle | Radio: `[Run A] (Run B)`. Default: Run B. Switches which execution colors graph nodes. |
| Changed-node styling | Split left-bar on graph nodes: top half = Run A color, bottom half = Run B color. |

### 5.6 Data Fetching

| Scenario | Behavior |
|----------|----------|
| Both cached | Instant diff, <100ms |
| One cached | Fetch missing. Skeleton card for loading run. |
| Neither cached | `Promise.all` both. Skeleton for both cards. |
| Fetch error | Error in failed card: "Failed to load — Retry". Other card renders. |

### 5.7 Exit Compare

| Trigger | Behavior |
|---------|----------|
| "← Back to History" | Return to list. Graph reverts to last loaded execution (or clears). |
| `Escape` | Same. |
| Switch to Gantt/Detail tab | Exit compare, switch tab. Graph reverts. |

Transition: 200ms slide-out right / slide-in left.

---

## 6. Auto-Refresh

### 6.1 SignalR Events (Primary)

Updates arrive via the `"dag"` SignalR topic (subscribed at `DagStudio.activate()`, architecture.md Flow 1 step 11).

| Event | Emitter | Payload | History Action |
|-------|---------|---------|----------------|
| `NodeStarted` | `EdogNodeExecutorWrapper` | `{ nodeId, dagId, iterationId, timestamp }` | New `iterationId` → insert row at top. Known → increment active count. |
| `NodeCompleted` | `EdogNodeExecutorWrapper` | `{ nodeId, dagId, iterationId, durationMs }` | Update Nodes column (`12/30` → `13/30`), update duration. |
| `NodeFailed` | `EdogNodeExecutorWrapper` | `{ nodeId, dagId, iterationId, durationMs, errorType, errorMessage }` | Update node count, show error code in Error column, increment failed count. |
| `DagTerminal` | `EdogDagExecutionHook` | `{ dagId, iterationId, status, totalNodes, completedNodes, failedNodes, skippedNodes, parallelLimit, durationMs, errorCode, errorMessage, errorSource }` | Finalize row: set final status dot, stop counter, show final counts + error. Pulsing stops (300ms settle). |

**New execution:** First `NodeStarted` for unknown `iterationId` → insert row at top with 200ms slide-in, 3s `var(--accent-glow)` fade. If scrolled down → floating pill `1 new execution ▲`.

**Data flow:**

```
FLT DagExecutionHandlerV2
  ├─ EdogDagExecutionHook     → "dag" topic → DagTerminal
  └─ EdogNodeExecutorWrapper  → "dag" topic → NodeStarted/Completed/Failed
       ↓
EdogTopicRouter → TopicBuffer → EdogPlaygroundHub → WebSocket
       ↓
SignalRManager.on('dag', cb) → DagStudio → HistoryPanel.updateRow(iterationId)
```

### 6.2 Polling Fallback

| Property | Value |
|----------|-------|
| Interval | 30s (consolidated with lock polling) |
| Endpoint | `listDAGExecutionIterationIds?historyCount=20` |
| Strategy | Merge-not-replace: new iterations slide in, updated ones update in-place |
| Suppression | Skip poll if `DagTerminal` received in last 30s |

### 6.3 Live Row Updates

For `Running` / `Cancelling` rows:

| Cell | Source | Frequency |
|------|--------|-----------|
| Status dot | `DagTerminal` | On terminal event |
| Duration | `requestAnimationFrame` | Display: 1s |
| Node count | `NodeCompleted` / `NodeFailed` | Per event |
| Error | `NodeFailed` / `DagTerminal` | Per event |

### 6.4 Deduplication

Deduplicate by `iterationId` via `Set<string>`. SignalR and poll may overlap:
- Known `iterationId` from SignalR → update row, don't duplicate
- Poll data replaces partial SignalR data (server wins, has `jobInvokeType` etc.)

---

## 7. Filters

### 7.1 Status (Server-Side)

| Option | API `statuses` |
|--------|---------------|
| All Statuses | *(omit)* |
| Completed | `completed` |
| Failed | `failed` |
| Cancelled | `cancelled` |
| Running | `running` |
| Failed + Cancelled | `failed,cancelled` |

Re-fetches list on change. Resets pagination. Active filter shown as pill with `var(--accent-dim)` bg.

### 7.2 Invoked By (Client-Side)

| Option | Matches `jobInvokeType` |
|--------|------------------------|
| All Invokers | *(no filter)* |
| Manual | `"Manual"` |
| Scheduled | `"Scheduled"` |
| API | `"Api"` / other |

Instantly hides non-matching rows. No re-fetch.

### 7.3 Combined + Clear

Both filters active = intersection (server filters status, client filters invoker). When any filter is active, "✕ Clear" link appears. Click → reset both + re-fetch unfiltered.

---

## 8. Empty States

### 8.1 No Executions

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│                  ○  (muted clock, 48px)                             │
│             No DAG executions yet                                   │
│    Run your first DAG to see execution history here.                │
│                   [▸ Run DAG]                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.2 No Match

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│          No executions match your filters                           │
│    Try changing the status or invoked-by filter.                    │
│                 [Clear Filters]                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.3 Loading

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│               (Spinner, 16px, var(--accent))                        │
│               Loading execution history...                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Filter bar visible, controls dimmed (40% opacity, `pointer-events: none`). Column headers visible for layout stability.

### 8.4 Error

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│            ✕  Failed to load execution history                      │
│            {error.message}                                          │
│                      [Retry]                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 9. Keyboard Navigation

| Shortcut | Action | Context |
|----------|--------|---------|
| `↑` / `↓` | Move row focus | History list |
| `Enter` | Load execution | Row focused |
| `Space` | Toggle compare checkbox | Row focused |
| `Ctrl+Shift+C` | Open comparison | 2 checked |
| `Escape` | Exit compare / clear | Compare active |
| `Alt+2` | Switch to History tab | Panel visible |
| `Home` / `End` | First / last row | List focused |
| `Page Up/Down` | Scroll by page | List focused |

**Focus management:** Tab → first (or loaded) row. Arrows move 2px `var(--accent-glow)` focus ring. `Enter` loads, `Space` toggles — distinct. Compare opens → focus to "← Back". Compare closes → focus to last checked row.

---

## 10. Performance Budgets

| Metric | Target | Strategy |
|--------|--------|----------|
| History load → visible | < 500ms | Lightweight `listDAGExecutionIterationIds`, 20 rows |
| Row render | < 1ms/row | Static DOM, no virtual scroll (max 100 rows) |
| Detail fetch → overlay | < 1s | `getDAGExecMetrics`, LRU-20 cache |
| Diff calculation | < 100ms | O(n) merge, n ≤ 300 nodes |
| Time refresh | < 5ms | Batch DOM write, single reflow |
| SignalR → row update | < 50ms | Direct cell DOM update, no list re-render |
| Compare transition | < 300ms | CSS `translateX` animation |

---

## 11. API Reference

| Action | Method | Endpoint | Response |
|--------|--------|----------|----------|
| List iterations | GET | `.../liveTable/listDAGExecutionIterationIds?historyCount=20` | `List<DagExecutionIteration>` |
| Load execution | GET | `.../liveTable/getDAGExecMetrics/{iterationId}` | `DagExecutionInstance` |
| Filter by status | GET | `.../listDAGExecutionIterationIds?statuses=failed&historyCount=20` | `List<DagExecutionIteration>` |
| Paginate | GET | `.../listDAGExecutionIterationIds?continuationToken={token}` | `List<DagExecutionIteration>` |

**OneLake persistence:**

```
{Lakehouse}/LiveTableSystem/DagExecutionMetrics/
├── {iterationId}/
│   ├── dag.json                 ← DAG structure snapshot
│   ├── dag_metrics.json         ← DagExecutionMetrics
│   └── node_{nodeId}_metrics.json
├── Index_StartTime_{artifactId}/
```

Max 500 records per lakehouse. In-memory cache ~10 min TTL.

---

## 12. Accessibility

| Aspect | Implementation |
|--------|---------------|
| Table | `role="grid"`, `aria-label="DAG Execution History"` |
| Rows | `role="row"`, `aria-selected` (loaded), `aria-checked` (compare) |
| Cells | `role="gridcell"`, descriptive `aria-label` for non-text content |
| Status dots | `aria-label="{status}"` — announces status name, not color |
| Compare button | `aria-disabled` when < 2 selected. `"Compare 2 executions"` when active. |
| Live updates | `aria-live="polite"` on list. Announces new/completed executions. |
| Loading | `aria-busy="true"` on panel/row during fetch |
| Times | `<time datetime="...">` with ISO 8601. `aria-label` with absolute time. |
| Compare view | `aria-live="assertive"` on entry. Focus trap. `Escape` exits. |

---

## 13. SignalR Event Reference

All events on the `"dag"` topic. Subscribed during `DagStudio.activate()`.

| Event | Emitter | Payload |
|-------|---------|---------|
| `NodeStarted` | `EdogNodeExecutorWrapper` | `{ nodeId, dagId, iterationId, timestamp }` |
| `NodeCompleted` | `EdogNodeExecutorWrapper` | `{ nodeId, dagId, iterationId, durationMs }` |
| `NodeFailed` | `EdogNodeExecutorWrapper` | `{ nodeId, dagId, iterationId, durationMs, errorType, errorMessage }` |
| `DagTerminal` | `EdogDagExecutionHook` | `{ dagId, iterationId, status, totalNodes, completedNodes, failedNodes, skippedNodes, parallelLimit, durationMs, errorCode, errorMessage, errorSource }` |

---

*"History is not a log dump. It is an indexed, searchable, comparable record of every DAG run — the engineer's instant answer to 'what happened?' Compare mode is the feature that transforms DAG Studio from a dashboard into a diagnostic instrument."*
