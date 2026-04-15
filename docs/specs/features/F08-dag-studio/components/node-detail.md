# Node Detail Panel — Component Spec

> **Status:** DRAFT
> **Owner:** Pixel (Frontend) + Sana (Architecture)
> **Reviewer:** Sentinel
> **Depends On:** `spec.md` § 2.5, `research/p0-foundation.md` (Node model, NodeExecutionMetrics)
> **State Matrix:** `../states/node-detail.md`

---

## 1. Purpose

When an engineer clicks a node in the DAG graph or Gantt chart, the Node Detail Panel answers every question about that node in one place: what it is, how it ran, why it failed, and where to go next. No context switch, no terminal grepping. The engineer's eyes stay on the DAG; the detail slides in alongside it.

Design lineage: VS Code's Peek Definition (contextual overlay, not a full navigation), Chrome DevTools' Elements sidebar (tabbed sections, computed values), Datadog's trace detail (timing, metadata, error, linked spans).

---

## 2. Position & Layout

### 2.1 Panel Placement

**Right-side slide-in panel** within the DAG Studio view. NOT a modal, NOT a bottom panel.

```
┌──────────────────────────────────────────────────────┐
│  Execution Controls (toolbar)                         │
├──────────────────────────────────┬───────────────────┤
│                                  │  Node Detail       │
│     DAG Graph (Canvas)           │  Panel             │
│                                  │  (right slide-in)  │
│                                  │  340px default     │
│                                  │                    │
├──────────────────────────────────┤                    │
│  Gantt / History / Compare       │                    │
│  (bottom tabbed panel)           │                    │
└──────────────────────────────────┴───────────────────┘
```

**Why right, not bottom:**
- Bottom space is already occupied by Gantt/History tabs — stacking panels vertically would compress both to unusable heights.
- Right panel preserves the graph's vertical real estate (node relationships flow left-to-right, so horizontal compression is less damaging than vertical).
- Matches VS Code's outline/peek pattern that FLT engineers use daily.

### 2.2 Dimensions

| Property | Value | Notes |
|----------|-------|-------|
| Default width | 340px | Enough for metadata table without horizontal scroll |
| Minimum width | 280px | Below this, table labels truncate unreadably |
| Maximum width | 50% of DAG Studio container | Prevents graph from becoming unusable |
| Height | 100% of DAG Studio vertical area | Spans from toolbar bottom to view bottom |
| Resize handle | Left edge, 4px drag zone | `cursor: col-resize` on hover |

### 2.3 Slide-in Animation

| Property | Value |
|----------|-------|
| Duration | 160ms |
| Easing | `cubic-bezier(0.4, 0, 0.2, 1)` (Design Bible standard) |
| Transform | `translateX(100%)` → `translateX(0)` |
| Graph resize | Graph canvas width shrinks simultaneously (no overlay) |
| Close animation | Reverse: `translateX(0)` → `translateX(100%)`, graph expands back |

The graph canvas must re-render at the new width during/after the transition. Fire a single `resize` recalculation on `transitionend`, not per-frame.

---

## 3. Panel Structure

### 3.1 Header (Fixed — Always Visible)

```
┌─────────────────────────────────────────┐
│ [●] RefreshSalesData         [SQL] [✕]  │
│ ● Completed · 2.3s · 2m ago             │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ [Overview][Metrics][Logs][Code][Deps][⋯] │
└─────────────────────────────────────────┘
```

| Element | Details |
|---------|---------|
| **Status dot** | Color-coded circle matching node status. Same palette as graph nodes. |
| **Node name** | `node.name`. Truncate with ellipsis at ~24 chars. Full name in `title` attribute. |
| **Type badge** | `SQL` or `PySpark` from `node.kind`. Pill shape, muted background. |
| **Close button** | `✕` (Unicode U+2715). `Escape` key also closes. |
| **Status line** | Status text + duration (if execution data) + relative time. |
| **Error banner** | If node failed: red banner below status line (see § 3.8). |
| **Tab bar** | Horizontal tabs. Scroll if overflow. Active tab underlined. |

### 3.2 Tab Bar

| Tab | Label | Icon | Visible When |
|-----|-------|------|-------------|
| Overview | "Overview" | — | Always |
| Metrics | "Metrics" | — | Execution data loaded |
| Logs | "Logs" | — | Always (shows empty state if no logs) |
| Code | "Code" | — | Always (shows placeholder if unavailable) |
| Dependencies | "Deps" | — | Always |
| History | "History" | — | Execution history available |

**Overflow:** If panel is narrow, tabs collapse into a `⋯` overflow menu (dropdown). Priority order: Overview, Metrics, Deps are always visible; Logs, Code, History overflow first.

**Keyboard:** `Ctrl+[` / `Ctrl+]` to cycle tabs within the panel when it has focus.

---

## 4. Tab Content

### 4.1 Overview Tab

The default tab. Shows node identity + static metadata + execution summary.

**Section: Identity**

| Field | Value | Source |
|-------|-------|--------|
| Node ID | UUID (first 8 chars). Click → copy full UUID. | `node.nodeId` |
| Name | Full node name | `node.name` |
| Kind | `SQL` or `PySpark` | `node.kind` |
| Table Type | Classification badge | `node.tableType` |
| Executable | Yes / No | `node.executable` |
| Is Shortcut | Yes / No / N/A (null) | `node.isShortcut` |
| ABFS Path | Truncated. Click → copy full path. Monospace. | `node.abfsPath` |
| Format | Table format string | `node.format` |
| Last Refresh | Timestamp (relative + absolute on hover) | `node.lastRefreshTime` |

**Section: Execution Summary** (only when execution data is loaded)

| Field | Value | Source |
|-------|-------|--------|
| Status | Colored pill | `nodeExecMetrics.status` |
| Started | Timestamp (absolute) | `nodeExecMetrics.startedAt` |
| Ended | Timestamp (absolute) | `nodeExecMetrics.endedAt` |
| Duration | Calculated: `endedAt - startedAt`, formatted as `Xm Ys` or `X.Xs` | Computed |
| Refresh Policy | `Full` or `Incremental` | `nodeExecMetrics.refreshPolicy` |
| Retry Count | Number (if > 0, amber highlight) | Derived from execution history |

**Section: Cross-Lakehouse** (only when `node.externalWorkspaceId` is set)

```
┌─────────────────────────────────────┐
│ ◇ External Source                   │
│   Workspace: SalesWorkspace         │
│   Lakehouse: SalesLakehouse         │
└─────────────────────────────────────┘
```

Dashed border, distinct background tint. External icon (◇) prefix.

**Section: Validation Errors** (only when `node.isFaulted === true`)

```
┌─────────────────────────────────────┐
│ ⚠ Validation Error                  │
│ MLV_STALE_METADATA                  │
│ Stale metadata on source table...   │
└─────────────────────────────────────┘
```

Amber background. Shows `node.fltErrorCode` + `node.errorMessage`.

**Section: Warnings** (only when `node.warnings.length > 0`)

Each warning rendered as a row:

| Field | Value |
|-------|-------|
| Warning type | `CDFDisabled` or `DeleteWithoutHints` — human-readable label |
| Related entities | Comma-separated `"workspace.lakehouse.schema.table"` strings |

---

### 4.2 Metrics Tab

Deep execution metrics. Only available when `nodeExecMetrics` exists for this node in the current execution.

**Empty state:** "No execution data. Run the DAG or select a historical execution to see metrics."

**Section: Row Counts**

| Metric | Value | Visual |
|--------|-------|--------|
| Rows Added | Formatted number with commas | Green if > 0 |
| Rows Dropped | Formatted number with commas | Amber if > 0 |
| Total Rows Processed | Formatted number with commas | — |
| DQ Violations | Count | Red if > 0, with severity indicator |

**Note:** Values of `-1` from the API mean "not applicable." Display as `N/A` (muted text), not `-1`.

**Section: DQ Violation Breakdown** (if `totalViolations > 0`)

Parse `nodeExecMetrics.violationsPerConstraint` (JSON string) into a table:

| Constraint | Violations |
|------------|-----------|
| `not_null_check` | 42 |
| `range_check` | 7 |

**Section: Spark**

| Field | Value | Action |
|-------|-------|--------|
| Session ID | UUID (truncated) | Click → "Open in Spark Inspector" (cross-link to F-Spark view if available) |
| Request ID | UUID (truncated) | Click → copy |
| REPL ID | UUID (truncated) | Click → copy |
| Details Page | URL | Click → opens `detailsPageLink` in browser tab |

**Section: Timing Breakdown**

| Metric | Value |
|--------|-------|
| Start | Absolute timestamp |
| End | Absolute timestamp |
| Duration | Formatted |
| Refresh Date | Date if available |
| Refresh Timestamp | Timestamp if available |

**Section: MLV Identity**

| Field | Value |
|-------|-------|
| MLV Name | `nodeExecMetrics.mlvName` |
| MLV ID | `nodeExecMetrics.mlvId` |
| MLV Namespace | `nodeExecMetrics.mlvNamespace` |
| Message | `nodeExecMetrics.message` (if present) |

---

### 4.3 Logs Tab

Shows log entries relevant to this node, filtered from the existing log stream.

**Filtering strategy:**
1. Match log entries where the message contains `node.name` (case-insensitive)
2. If execution data exists: also filter by time window `[nodeExecMetrics.startedAt - 5s, nodeExecMetrics.endedAt + 5s]` (5-second buffer on each side for setup/teardown logs)
3. If iteration context exists: filter by `iterationId` in the log entry metadata
4. Cap at 200 most recent matching entries

**Layout:**

```
┌─────────────────────────────────────┐
│ [Filter: level ▾] [Search: ______] │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ 14:23:01.234 INFO  Executing node.. │
│ 14:23:02.891 INFO  Reading source.. │
│ 14:23:05.112 WARN  CDF disabled...  │
│ 14:23:45.001 ERROR MLV_RUNTIME_ERR  │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ Showing 47 of 47 entries            │
│ [Open in Logs View →]              │
└─────────────────────────────────────┘
```

| Element | Behavior |
|---------|----------|
| Level filter | Dropdown: All, Error, Warn, Info, Debug. Default: All. |
| Search | Text filter within already-filtered entries. Debounced 200ms. |
| Log entries | Compact single-line format: timestamp + level badge + truncated message. |
| Click entry | Opens full log detail inline (expandable row) |
| Double-click entry | Opens in the main Logs view (F03) with this entry focused |
| "Open in Logs View" | Switches to F03 Logs, pre-filtered to this node's name + time window |
| Empty state | "No matching log entries." If disconnected: "Connect to FLT service to see logs." |

**Loading state:** Skeleton lines (3 animated placeholder rows) while filtering the log stream.

**Live updates:** If execution is currently running, new matching log entries append at the bottom. Auto-scroll if user is at the bottom; show "N new entries" badge if scrolled up.

---

### 4.4 Code Tab

Shows the SQL or PySpark code that defines this node's materialized view.

**V1 behavior (current):**
- `node.codeReference` contains `{ notebookId, cellIndices }` — a reference, NOT the actual code.
- V1 shows a placeholder:

```
┌─────────────────────────────────────┐
│ Code Reference                      │
│                                     │
│ Notebook: a1b2c3d4-...             │
│ Cells: [0, 1, 3]                   │
│                                     │
│ [Open Notebook in Fabric Portal →] │
│                                     │
│ ℹ Code preview available in a      │
│   future release.                   │
└─────────────────────────────────────┘
```

**V2 behavior (future — requires Notebook API):**
- Fetch code from Fabric Notebook API using `notebookId` + `cellIndices`.
- Display with syntax highlighting: SQL (keywords, strings, numbers) or PySpark (Python keywords, Spark API calls).
- Read-only. No editing.
- Syntax highlighting: custom tokenizer (no library). Highlight: keywords (blue), strings (green), numbers (amber), comments (muted).
- Line numbers in gutter.
- Click line number → copy that line.
- "Copy All" button in top-right corner.

**Unavailable state** (no `codeReference` on node):

```
┌─────────────────────────────────────┐
│ No code reference available for     │
│ this node.                          │
│                                     │
│ This node may be a source table or  │
│ shortcut without associated code.   │
└─────────────────────────────────────┘
```

---

### 4.5 Dependencies Tab

Shows this node's parents (upstream) and children (downstream) with status and navigation.

**Layout:**

```
┌─────────────────────────────────────┐
│ Parents (3)                         │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ [●] RawSalesData      [SQL]  → ✓   │
│ [●] RawInventory      [SQL]  → ✓   │
│ [●] ExternalPricing   [Py]   → ●   │
│                                     │
│ Children (2)                        │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ [●] AggregatedSales   [SQL]  → ⊘   │
│ [●] SalesReport       [SQL]  → ⊘   │
└─────────────────────────────────────┘
```

| Element | Behavior |
|---------|----------|
| Status dot | Color-coded by execution status (green/red/blue/grey) |
| Node name | Click → selects that node in graph + updates this panel |
| Type badge | `SQL` / `PySpark` pill |
| Execution indicator | `✓` completed, `✕` failed, `●` running, `⊘` pending/none, `—` skipped |
| Arrow icon | `→` on hover for parent (navigate downstream), `←` for child |
| Empty section | "No parents" or "No children" (muted text) |
| Keyboard | `Enter` on focused row → navigate to that node. Arrow keys to move between rows. |

**Dependency chain view** (future V2):
- Expand button to show full upstream/downstream chain (transitive closure).
- Critical path highlighting.

---

### 4.6 History Tab

Performance of this specific node across the last N executions. Answers: "Is this node usually this slow?"

**Mini sparkline:**

```
┌─────────────────────────────────────┐
│ Duration Trend (last 20 runs)       │
│ ┈┈┈╱╲┈┈┈┈┈┈┈┈╱╲╱╲┈┈┈┈┈╱▉┈┈┈┈┈┈  │
│ avg: 2.1s    this run: 45.2s ⚠      │
│                                     │
│ ⚠ 21× slower than average           │
└─────────────────────────────────────┘
```

| Element | Details |
|---------|---------|
| Sparkline | Canvas-rendered mini line chart. X = execution index, Y = duration. 100×40px. |
| Current run marker | Solid bar or highlighted dot on the sparkline for this execution. |
| Average line | Horizontal dashed line at the mean duration. |
| Anomaly detection | If `currentDuration > 3 × avgDuration`: show amber warning "N× slower than average." If `currentDuration > 10 × avgDuration`: red warning. |
| Stats row | `avg: Xs`, `min: Xs`, `max: Xs`, `p95: Xs` |

**History table:**

| Column | Value |
|--------|-------|
| Execution | Iteration ID (first 8 chars) + relative time |
| Status | Color pill |
| Duration | Formatted time |
| Rows Processed | Count |
| Delta | Compared to average: `+12%`, `-5%`, `+2100%` (red if > 200%) |

**Data source:** Extracted from the last N `DagExecutionInstance` objects already loaded by Execution History. No additional API call — reuse cached data mapped by `nodeId`.

**Empty state:** "Run the DAG at least twice to see performance trends."

---

## 5. Error Detail

When a node's execution status is `failed`, error information gets special treatment.

### 5.1 Error Banner (Header Area)

Displayed below the status line in the header, visible regardless of active tab.

```
┌─────────────────────────────────────┐
│ ✕ MLV_RUNTIME_ERROR                 │
│ Stale metadata on source table      │
│ "Sales.FactOrders" — schema changed │
│                                     │
│ Failure: UserError                  │
│ [Copy Error] [Jump to Logs →]      │
└─────────────────────────────────────┘
```

| Element | Source |
|---------|--------|
| Error code | `nodeExecMetrics.errorCode` or `nodeExecMetrics.nodeErrorDetails.errorCode` |
| Error message | `nodeExecMetrics.errorMessage` or `nodeExecMetrics.nodeErrorDetails.errorMessage` |
| Failure type | `nodeExecMetrics.nodeErrorDetails.failureType` — `UserError` (amber label) or `SystemError` (red label) |
| "Copy Error" | Copies formatted error block: `[ERROR_CODE] message\nfailureType: X\nnodeId: Y` |
| "Jump to Logs" | Switches to Logs tab, auto-scrolls to first error-level entry |

### 5.2 Validation Error (Node-level, No Execution)

When `node.isFaulted === true` (structural issue, not execution failure):

```
┌─────────────────────────────────────┐
│ ⚠ Node Validation Error             │
│ Code: MLV_STALE_METADATA            │
│ Source table schema has changed.     │
│ Re-sync metadata to resolve.        │
└─────────────────────────────────────┘
```

Amber background (not red — this is a pre-condition issue, not a runtime failure). Shown in Overview tab and as a persistent header badge.

---

## 6. Cross-Linking

Every piece of data in the panel connects to deeper views. Zero dead ends.

| Action | Behavior | Target |
|--------|----------|--------|
| "Open in Logs" | Switch to F03 Logs view with filter: `source:contains(nodeName) AND time:[startedAt-5s, endedAt+5s]` | F03 Enhanced Logs |
| "Open in Telemetry" | Switch to telemetry view filtered by `iterationId` + `nodeName` | F-Telemetry (if available) |
| "Open in Spark" | Switch to Spark Inspector view filtered by `sessionId` | F-Spark Inspector (if available) |
| Spark Session ID click | Same as "Open in Spark" | F-Spark Inspector |
| Details Page link | Open `detailsPageLink` URL in new browser tab | External (Fabric portal) |
| "Open Notebook" | Open `https://app.fabric.microsoft.com/.../{notebookId}` in new tab | External (Fabric portal) |
| Parent/child node click | Select that node in graph, update detail panel content | Same view |
| Log entry double-click | Switch to F03 Logs with that entry focused | F03 Enhanced Logs |
| History row click | Load that execution's data into graph + Gantt | Execution History |

**Unavailable cross-links:** If a target view doesn't exist yet (e.g., Spark Inspector), show the link as disabled with tooltip: "Available when Spark Inspector is connected."

---

## 7. Actions

Toolbar actions in the panel header (icon buttons, right-aligned).

| Action | Icon | Keyboard | Behavior |
|--------|------|----------|----------|
| Copy node info | Copy icon | `Ctrl+Shift+C` (when panel focused) | Copies full node data as formatted JSON to clipboard |
| Copy error | — | — | Copies error block (only visible when error exists) |
| Open notebook | External link icon | — | Opens Fabric portal notebook URL. Disabled if no `codeReference`. |
| Pin panel | Pin icon | — | Keeps panel open when clicking empty space. Default: unpinned (Escape/empty-click closes). |
| Resize to default | — | — | Resets panel width to 340px |

**Copy node info JSON format:**

```json
{
  "nodeId": "a1b2c3d4-...",
  "name": "RefreshSalesData",
  "kind": "sql",
  "status": "failed",
  "duration": "45.2s",
  "error": {
    "code": "MLV_RUNTIME_ERROR",
    "message": "Stale metadata on source table",
    "failureType": "UserError"
  },
  "metrics": {
    "rowsAdded": 0,
    "rowsDropped": 0,
    "totalRowsProcessed": 0,
    "dqViolations": 0
  },
  "sparkSessionId": "e5f6a7b8-...",
  "parents": ["RawSalesData", "RawInventory"],
  "children": ["AggregatedSales"]
}
```

---

## 8. Node Changed Transition

When the user selects a different node while the panel is open:

1. **Content crossfade:** Current content fades out (80ms, opacity 1→0), new content fades in (80ms, opacity 0→1). Total: 160ms.
2. **Tab preservation:** Stay on the same tab if it exists for the new node. If the active tab is unavailable (e.g., Metrics tab but new node has no execution data), fall back to Overview.
3. **Scroll reset:** Each tab's scroll position resets to top on node change.
4. **Header updates immediately** (no fade — node name/status should feel instant).
5. **History tab data:** Cleared and re-derived from cached execution data for the new node.

---

## 9. Keyboard Interaction

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Panel open | Close panel, deselect node |
| `Escape` | Panel open, sub-element focused (log entry expanded) | Close sub-element first, then panel on second press |
| `Ctrl+[` | Panel focused | Previous tab |
| `Ctrl+]` | Panel focused | Next tab |
| `Tab` | Panel focused | Cycle through interactive elements within current tab |
| `Enter` | Dependency row focused | Navigate to that node |
| `Enter` | Log entry focused | Expand/collapse log detail |
| `Ctrl+Shift+C` | Panel focused | Copy node info as JSON |
| `Home` | Tab content focused | Scroll to top |
| `End` | Tab content focused | Scroll to bottom |

**Focus management:**
- When panel opens: focus moves to the panel container. Screen reader announces "Node detail: {nodeName}, {status}".
- When panel closes: focus returns to the previously selected node in the graph (or the canvas if node was deselected).
- Tab content is a focus trap — `Tab` cycles within the panel, not out to the graph.
- `Escape` is the exit path (or clicking the close button).

---

## 10. Responsive Behavior

| Viewport Width | Behavior |
|----------------|----------|
| >= 1400px | Full panel (340px), all tabs visible |
| 1200–1399px | Panel at 300px, tabs may overflow to `⋯` menu |
| < 1200px | Panel overlays graph (position: absolute) instead of pushing it. Close button more prominent. Semi-transparent scrim on graph. |

---

## 11. Performance Constraints

| Metric | Target | Rationale |
|--------|--------|-----------|
| Panel open (slide-in + first render) | < 200ms | Must feel instant on node click |
| Tab switch | < 50ms | Keyboard tab cycling must be fluid |
| Node change (content swap) | < 100ms | Crossfade budget: 160ms, but data must be ready in < 100ms |
| Log filtering | < 100ms for 10,000 log entries | String matching on name + time range filter |
| History sparkline render | < 16ms | Single Canvas frame for the mini chart |
| Scroll (log entries, dependencies) | 60fps | Virtual scroll if > 100 log entries in filtered set |
| Memory overhead | < 5MB per panel instance | Panel is single-instance, recycled on node change |

---

## 12. Accessibility

| Requirement | Implementation |
|-------------|----------------|
| ARIA role | `role="complementary"` on panel container, `aria-label="Node detail panel"` |
| Tab bar | `role="tablist"` with `role="tab"` per tab, `aria-selected` on active tab |
| Tab panels | `role="tabpanel"` with `aria-labelledby` pointing to tab |
| Status announcement | `aria-live="polite"` region announces node name + status on selection |
| Error announcement | `aria-live="assertive"` for error banners |
| Focus visible | All interactive elements have visible focus ring (2px solid accent) |
| Color independence | Status uses color + text + icon (not color alone) |
| Resize handle | `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` with current width |

---

## 13. CSS Custom Properties

All panel styles use existing Design Bible tokens. New panel-specific properties:

```css
/* Node Detail Panel */
--node-detail-width: 340px;
--node-detail-min-width: 280px;
--node-detail-max-width: 50%;
--node-detail-header-height: 88px;
--node-detail-tab-height: 36px;
--node-detail-transition: 160ms cubic-bezier(0.4, 0, 0.2, 1);

/* Error banner */
--node-detail-error-bg: var(--color-error-surface);
--node-detail-error-border: var(--color-error);

/* Validation warning */
--node-detail-warning-bg: var(--color-warning-surface);
--node-detail-warning-border: var(--color-warning);
```

---

## 14. Data Flow

```
User clicks node in Graph/Gantt
        │
        ▼
DagStudio._onNodeSelected(nodeId)
        │
        ├── 1. Lookup node from cached DAG: this._dag.nodes.find(n => n.nodeId === nodeId)
        │
        ├── 2. Lookup execution metrics (if loaded):
        │      this._currentExecution?.nodeExecutionMetrices?.[nodeId]
        │
        ├── 3. Open/update NodeDetailPanel:
        │      nodeDetailPanel.show(node, execMetrics, executionHistory)
        │
        └── 4. Cross-highlight:
               graph.selectNode(nodeId)
               gantt.highlightNode(nodeId)

NodeDetailPanel.show(node, execMetrics, history)
        │
        ├── Update header (name, type, status)
        ├── Render active tab content
        ├── If error: render error banner
        ├── If logs tab: filter log stream for node
        └── If history tab: extract node metrics from cached executions
```

No additional API calls from the panel itself. All data comes from:
- **Static node data:** Cached `Dag` object from `getLatestDag`.
- **Execution metrics:** Cached `DagExecutionInstance` from `getDAGExecMetrics`.
- **Log entries:** Existing in-memory log stream from the WebSocket connection.
- **History:** Cached execution instances already loaded by Execution History tab.

---

## 15. Open Questions

| # | Question | Impact | Status |
|---|----------|--------|--------|
| 1 | Should the panel support multi-node selection (Ctrl+click)? | Would need comparison sub-view within the panel. | **Deferred to V2** |
| 2 | Should "Re-run from here" be a V1 placeholder or omitted entirely? | Placeholder adds visual noise with no function. | **V1: Omit. V2: Add when partial execution API is available.** |
| 3 | Notebook API authentication — does the current MWC token have scope for Notebook content? | Blocks V2 Code tab. | **Needs Sana research** |
| 4 | Should DQ violation breakdown be expandable or always visible? | Space concern in Metrics tab. | **Expandable — collapsed by default, expand on click.** |
