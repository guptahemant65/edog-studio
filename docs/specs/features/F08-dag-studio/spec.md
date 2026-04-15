# F08: DAG Studio — Master Spec

> **Status:** P0–P3 COMPLETE — P4 (Interactive Mocks) next
> **Owner:** Sana Reeves (Architecture) + Pixel (Frontend) + Vex (Backend)
> **CEO:** Hemant Gupta
> **Rule:** Smallest unit possible. No implementation until every prep item is DONE.
> **Rendering Decision:** Canvas 2D with 3-level LOD — CEO confirmed. NOT SVG.

---

## 1. Why This Exists

DAG execution is the single most important operation in FabricLiveTable. Every table refresh, every materialized view update, every incremental load — it all flows through the DAG. Today, when an FLT engineer runs a DAG, here's what they experience:

1. Click "Run" in some UI or call the API
2. Stare at raw telemetry logs scrolling in a terminal
3. Grep for `[DAG STATUS]` to see if it started
4. Grep for `Executing node` to track individual nodes
5. Grep for `MLV_RUNTIME_ERROR` when something fails
6. Mentally reconstruct which nodes ran in parallel, which waited, which failed
7. Manually compare two execution logs side-by-side to find regressions
8. Have no idea what the DAG even looks like until they read the notebook code

This is unacceptable for an operation that engineers trigger dozens of times per day. The execution graph — the most important data structure in FLT — is completely invisible.

**DAG Studio makes the invisible visible.**

The engineer opens DAG Studio. They see their 30-node DAG as an interactive graph — sources on the left, transformations in the middle, final materialized views on the right. They click "Run DAG." Nodes start lighting up: blue for running, green for completed, red for failed. The Gantt chart below shows parallelism in real-time — five nodes executing simultaneously, then a sequential bottleneck at the merge step. A node fails. They click it. The detail panel shows the error: `MLV_STALE_METADATA` — stale metadata on the source table. They click "Compare with yesterday" and instantly see that yesterday's run succeeded in 45 seconds but today's failed at node 7, which was 3× slower before it errored. The problem is obvious: someone changed the source table schema.

Total time from "what happened?" to "I know exactly what happened": **10 seconds**. Down from 5 minutes of log-grepping.

---

## 2. What The User Sees

DAG Studio is the 3rd sidebar view (circuit/diamond icon). Available in **connected mode only** — requires a local FLT service running to provide DAG data and telemetry.

The layout is split: **top 60%** is the interactive DAG graph on Canvas, **bottom 40%** is a tabbed panel with Gantt chart, execution history, and node detail. The split is resizable via drag handle.

### 2.1 DAG Graph (Canvas 2D with LOD)

The centerpiece. An interactive directed acyclic graph rendered on an HTML5 `<canvas>` element using the Canvas 2D API. This is NOT SVG — the CEO decision is Canvas 2D for 300+ node scalability.

**Rendering — 3-Level LOD System:**

| LOD Level | Trigger | Node Size | Renders | Performance |
|-----------|---------|-----------|---------|-------------|
| **LOD 0 — Dot** | Zoom < 0.3 or > 300 nodes at distance | 4–6px circle | Colored dot. Glow halo on failed nodes. | 1000+ nodes at 60fps |
| **LOD 1 — Mini** | Zoom 0.3–0.8 or 100–300 nodes at medium distance | 60×24px rect | Layer-colored rectangle with truncated name (8 chars). | 300 nodes at 60fps |
| **LOD 2 — Detail** | Zoom > 0.8 or < 100 nodes close to viewport center | 140×52px card | Full card: name (18 chars), type badge (SQL/PySpark), duration, status indicator, left color bar, shadow. Hover/selection highlight. | 100 nodes at 60fps |

LOD determination is zoom-aware AND distance-aware: nodes near the viewport center get higher detail than nodes at the periphery. For small DAGs (< 100 nodes), all nodes render at LOD 2 regardless of zoom.

**Node visual encoding:**

| Status | Color | LOD 2 Border | LOD 1 Fill | LOD 0 Dot | Animation |
|--------|-------|-------------|-----------|-----------|-----------|
| Pending | `--color-text-tertiary` (grey) | Left bar grey | Grey rect | Grey dot | None |
| Running | `--color-accent` (blue) | Left bar blue | Blue rect | Blue dot | Pulsing opacity (1.5s cycle) |
| Succeeded | `--status-succeeded` (green) | Left bar green | Green rect | Green dot | None |
| Failed | `--status-failed` (red) | Left bar red, glow halo | Red rect | Red dot + glow halo | None |
| Cancelled | `--status-failed` (amber) | Left bar amber | Amber rect | Amber dot | None |
| Skipped | Muted, 50% opacity | Dotted left bar | Dim rect | Dim dot | None |

**Node badges (LOD 2 only):**
- Type badge: `SQL` or `PySpark` — small pill in the card
- Duration: elapsed time (e.g., "12.3s") — shown during/after execution
- Error count: red circle with count if node has errors
- Layer color: left 4px bar colored by DAG depth — bronze (source), silver (intermediate), gold (output)

**Edge rendering:**
- Bezier curves via `ctx.bezierCurveTo()` with horizontal midpoint control points
- Direction: strictly left-to-right (parent → child), matching FLT DAG semantics
- Normal edges: `#3A3A3A`, 0.4 opacity, 1.5px width
- Selected path: `--color-accent` (#0A84FF), 0.8 opacity, 2.5px width
- Error path: `--status-failed` (#FF453A), 0.5 opacity, dashed `[6, 4]`
- During execution: animated dash offset on running edges showing data flow direction

**Interaction model:**

| Interaction | Input | Behavior |
|-------------|-------|----------|
| Pan | Mouse drag (left button) | Translate camera. Grab cursor during drag. |
| Zoom | Mouse wheel | Scale 0.9×/1.1× per tick, toward cursor position. Bounds: 0.15–3.0 |
| Zoom In | `+` button or `Ctrl+=` | Scale ×1.25, toward viewport center |
| Zoom Out | `−` button or `Ctrl+-` | Scale ×0.8, toward viewport center |
| Fit to screen | `F` key or button | Calculate all-node bounds → center → scale to fit with 48px padding |
| Select node | Click | Hit-test (rectangular AABB). Selects node, highlights connected edges, opens detail panel. |
| Hover node | Mousemove | `cursor: pointer` feedback. LOD 2: subtle lift shadow. Tooltip with name + status if LOD 0/1. |
| Jump to failed | `Shift+F` | Pan + zoom to first failed node, select it |
| Deselect | `Escape` or click empty space | Clear selection, close detail panel |
| Keyboard nav | Arrow keys (when node selected) | Move selection to adjacent node in that direction |

**Camera:** Single transform object `{x, y, scale}` applied via `ctx.translate()` + `ctx.scale()` per frame. Stored and restored across view switches.

**Background:** Radial gradient dot grid (24px spacing) — matches the reference mockup aesthetic.

**Minimap:** Small (180×100px) overview in the bottom-left corner of the canvas. Shows all nodes as dots with a viewport rectangle. Click minimap to jump. Sample rate: `max(1, floor(nodes/100))` for performance.

**Layout Algorithm:** Sugiyama (layered), left-to-right flow. See Section 3 for implementation details.

---

### 2.2 Execution Controls

A toolbar strip above the graph canvas with execution actions and status indicators.

**Buttons:**

| Button | Label | Action | Endpoint | State Requirements |
|--------|-------|--------|----------|-------------------|
| Primary (accent) | Run DAG | Generate UUID v4 → POST `/liveTableSchedule/runDAG/{uuid}` | `POST .../liveTableSchedule/runDAG/{iterationId}` | Enabled when: idle or completed/failed/cancelled. Disabled during running/cancelling. |
| Ghost/destructive | Cancel DAG | Cancel active run → GET `/liveTableSchedule/cancelDAG/{iterationId}` | `GET .../liveTableSchedule/cancelDAG/{iterationId}` ⚠ (GET not POST — FLT convention) | Enabled only during active execution. Requires confirmation popover. |
| Ghost | Refresh DAG | Re-fetch DAG definition and re-layout | `GET .../liveTable/getLatestDag?showExtendedLineage=true` | Always enabled. Shows spinner during fetch. |
| Ghost/warning | Force Unlock | Clear stuck execution lock | `POST .../liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}` ⚠ (typo in URL is real) | Shown only when lock is detected. Requires confirmation dialog with lock age and locked iteration ID. |
| Ghost | Settings | Open DAG settings panel (parallel limit, refresh mode, environment) | `GET/PATCH .../liveTable/settings` | Always enabled. |

**Status indicator (right side of toolbar):**

| State | Visual | Description |
|-------|--------|-------------|
| Idle | Grey dot + "Idle" | No execution in progress |
| Running | Pulsing blue dot + "Running" + elapsed timer | Active DAG execution |
| Completed | Green dot + "Completed" + duration | Last run succeeded |
| Failed | Red dot + "Failed" + error summary | Last run failed |
| Cancelled | Amber dot + "Cancelled" | Last run was cancelled |
| Cancelling | Pulsing amber dot + "Cancelling..." | Cancel requested, waiting for confirmation |
| Locked | Red lock icon + "Locked" + lock age | DAG execution is locked — stuck. Shows Force Unlock button. |
| Not Started | Grey dot + "Not Started" | Execution queued but hasn't begun |

**Lock detection:** Poll `GET .../liveTableMaintanance/getLockedDAGExecutionIteration` every 30 seconds when DAG Studio is active. If a lock is detected with age > 5 minutes, show the locked state with Force Unlock button.

**MLV Execution Definitions:** A dropdown next to "Run DAG" showing named subsets:
- "Full DAG" (default) — run everything
- Named definitions from `GET .../liveTable/mlvExecutionDefinitions` — e.g., "Sales tables only"
- "Create new..." — opens a dialog to create a definition by selecting nodes

---

### 2.3 Gantt Chart

A horizontal timeline view showing per-node execution as colored bars on a shared time axis.

**Layout:**
- X-axis: time (auto-scaled based on execution duration)
- Y-axis: one row per node, sorted by start time (earliest first), grouped by layer
- Each bar: left edge = start time, right edge = end time, colored by status
- Bar height: 20px, row height: 28px (4px top/bottom padding)

**Visual encoding:**

| Element | Appearance |
|---------|------------|
| Succeeded bar | Green fill, 0.8 opacity |
| Running bar | Blue fill, pulsing animation, grows rightward in real-time |
| Failed bar | Red fill, hatched pattern |
| Cancelled bar | Amber fill, striped pattern |
| Skipped bar | Grey fill, dotted border |
| Pending bar | No bar — empty row with grey dashed line |

**Time axis:**
- Auto-scale: seconds for fast DAGs (< 2 min), minutes for slow DAGs (2+ min)
- Tick marks every N seconds/minutes with labels
- Current time cursor (vertical line) during active execution, animated rightward
- Total duration label at the right end

**Parallelism visualization:**
- Concurrent nodes stacked vertically — visually obvious which nodes ran in parallel
- Parallel limit line: horizontal marker at the configured `parallelNodeLimit` (default 5)
- Bottleneck highlighting: if a single node blocked the entire pipeline, its bar gets a contrasting border

**Cross-highlighting:**
- Click a Gantt bar → selects that node in the graph (pans + highlights)
- Select a node in the graph → highlights its Gantt bar (scrolls into view if needed)
- Hover a bar → tooltip with node name, duration, start/end time, status

**Real-time updates during execution:**
- Running bars grow rightward with the current time
- New nodes appearing as they start executing
- Completed nodes get their final color

**Rendering:** Canvas 2D for the bars/grid (continuous horizontal rendering). DOM overlay for the time axis labels and tooltips.

---

### 2.4 Execution History

A table showing the last N DAG executions, below/beside the Gantt chart (tabbed with it).

**Columns:**

| Column | Content | Sort |
|--------|---------|------|
| Status | Color-coded pill: ● Completed, ● Failed, ● Cancelled, ● Running | Default sort: most recent first |
| Iteration ID | UUID (first 8 chars, click to copy full) | — |
| Started | Relative time ("2m ago", "1h ago") + absolute on hover | Sortable |
| Duration | Formatted (e.g., "1m 23s", "45s", "12m 7s") | Sortable |
| Nodes | `completed/total` (e.g., "28/30") with failed count in red if any | Sortable |
| Invoked By | "Manual" / "Scheduled" / "API" | Filterable |
| MLV Definition | Named subset if applicable, or "Full DAG" | Filterable |
| Error | Error code (e.g., `MLV_RUNTIME_ERROR`) — only shown if failed | — |

**Data source:** `GET .../liveTable/listDAGExecutionIterationIds` with `historyCount=20`. Supports pagination via `x-ms-continuation-token` header for loading more.

**Interactions:**

| Action | Behavior |
|--------|----------|
| Click row | Loads that execution's full data (`GET .../liveTable/getDAGExecMetrics/{iterationId}`) → overlays node metrics onto graph + renders Gantt |
| Double-click row | Same as click + switches to Gantt tab |
| Select two rows | Enables "Compare" button |
| Compare button | Opens comparison view (see below) |
| Load more | Fetches next page via continuation token |
| Filter by status | Dropdown: All, Completed, Failed, Cancelled |

**Comparison view:**
When two executions are selected and "Compare" is clicked:
- Side-by-side summary: overall status, duration diff, node count diff
- Per-node diff table:
  - Nodes that changed status (was green, now red)
  - Timing differences (node X: 2.1s → 45.2s — **21× slower**)
  - New errors vs previous errors
  - Nodes added/removed between runs (DAG definition changed)
- Color coding: green for improvements, red for regressions, grey for unchanged
- Click a diff row → selects that node in both graph views

---

### 2.5 Node Detail Panel

A slide-in panel (right side, 340px wide) that appears when a node is selected in the graph or Gantt chart.

**Sections:**

**Header:**
- Node name (e.g., "RefreshSalesData")
- Type badge: `SQL` or `PySpark`
- Status pill with color
- Close button (×)

**Metadata:**

| Field | Value | Source |
|-------|-------|-------|
| Node ID | UUID | `node.nodeId` |
| Table Type | Classification | `node.tableType` |
| Executable | Yes/No | `node.executable` |
| Is Shortcut | Yes/No/N/A | `node.isShortcut` |
| ABFS Path | Truncated path, click to copy | `node.abfsPath` |
| Last Refresh | Timestamp | `node.lastRefreshTime` |
| Format | Table format | `node.format` |
| Parents | Count + names (clickable → navigate) | `node.parents` |
| Children | Count + names (clickable → navigate) | `node.children` |

**Execution metrics (when execution data is loaded):**

| Field | Value | Source |
|-------|-------|-------|
| Status | Colored pill | `nodeExecMetrics.status` |
| Started At | Timestamp | `nodeExecMetrics.startedAt` |
| Ended At | Timestamp | `nodeExecMetrics.endedAt` |
| Duration | Calculated | `endedAt - startedAt` |
| Refresh Policy | Full / Incremental | `nodeExecMetrics.refreshPolicy` |
| Rows Added | Count | `nodeExecMetrics.addedRowsCount` |
| Rows Dropped | Count | `nodeExecMetrics.droppedRowsCount` |
| Total Rows Processed | Count | `nodeExecMetrics.totalRowsProcessed` |
| DQ Violations | Count | `nodeExecMetrics.totalViolations` |
| Spark Session ID | UUID (link to Spark Inspector) | `nodeExecMetrics.sessionId` |
| Spark Request ID | UUID | `nodeExecMetrics.requestId` |
| Details Page | Link | `nodeExecMetrics.detailsPageLink` |

**Error section (if failed):**

| Field | Value | Source |
|-------|-------|-------|
| Error Code | e.g., `MLV_RUNTIME_ERROR` | `nodeExecMetrics.errorCode` |
| Error Message | Full text | `nodeExecMetrics.errorMessage` |
| Failure Type | UserError / SystemError | `nodeErrorDetails.failureType` |
| Error Source | Computed | `nodeErrorDetails.errorSource` |

**Warnings section (if present):**
- Warning type: `CDFDisabled`, `DeleteWithoutHints`
- Related source entities: `"workspace.lakehouse.schema.table"` format

**Validation errors (if faulted):**
- Shown when `node.isFaulted === true`
- Error message from `node.errorMessage`
- FLT error code from `node.fltErrorCode` (e.g., `MLV_STALE_METADATA`, `MLV_ACCESS_DENIED`)

**Filtered log entries:**
- Show the last 50 log entries where the log message mentions this node's name
- Filtered from the existing log stream using AutoDetector pattern matching
- Click a log entry → opens it in the Logs view (F03)

**Code reference (future — V2):**
- If `node.codeReference` is present, show notebook ID + cell indices
- "View Code" button → calls Notebook API to fetch SQL/PySpark code (requires Feature 18/21)
- V1: Show "Code available in future release" placeholder

**"Re-run from here" button (future — V2):**
- Placeholder button, disabled in V1
- V2: Triggers partial DAG execution starting from this node

**Cross-lakehouse indicator:**
- If `node.externalWorkspaceId` is set, show a badge: "External: {workspaceName}/{lakehouseName}"
- Different visual treatment (dashed border, external icon) for cross-lakehouse nodes

---

## 3. Architecture

### 3.1 Component Structure

```
dag-graph.js (NEW — ~800 lines estimated)
├── class DagCanvasRenderer     — Canvas 2D rendering engine with LOD
│   ├── constructor(canvasEl)
│   ├── setData(nodes, edges)   — Set positioned node/edge data
│   ├── render()                — Main render loop (requestAnimationFrame)
│   ├── updateNodeState(id, s)  — Update node status during execution
│   ├── selectNode(nodeId)      — Select + highlight connected edges
│   ├── fitToScreen()           — Calculate bounds → center → scale
│   ├── panTo(x, y)             — Animate camera to position
│   ├── zoomTo(scale, cx, cy)   — Zoom toward point
│   ├── hitTest(screenX, screenY) → nodeId|null
│   ├── _drawDetailNode(node)   — LOD 2: full card
│   ├── _drawMiniNode(node)     — LOD 1: colored rect + name
│   ├── _drawDotNode(node)      — LOD 0: colored dot
│   ├── _drawEdges(edges)       — Bezier curves with status coloring
│   ├── _drawMinimap()          — Overview rectangle
│   ├── _drawBackground()       — Dot grid
│   ├── _getNodeLOD(node)       — Zoom + distance → LOD level
│   └── destroy()               — Cleanup: cancel rAF, remove listeners

├── class DagLayout             — Sugiyama layout algorithm
│   ├── layout(nodes, edges)    → Map<nodeId, {x, y, layer, order}>
│   ├── _assignLayers(nodes, edges) — Kahn's algorithm: longest path
│   ├── _minimizeCrossings(layers)  — Barycenter heuristic, 2–4 passes
│   ├── _assignPositions(layers)    — X/Y from layer + order
│   └── _routeEdges(edges, positions) — Bezier control points

dag-gantt.js (NEW — ~400 lines estimated)
├── class DagGantt              — Gantt timeline renderer
│   ├── constructor(containerEl)
│   ├── renderExecution(metrics) — Full Gantt from DagExecutionInstance
│   ├── updateBar(nodeId, state) — Real-time bar updates
│   ├── highlightNode(nodeId)    — Cross-highlight with graph
│   ├── renderComparison(run1, run2) — Side-by-side diff
│   ├── _calculateTimeScale(start, end) — Auto-scale time axis
│   ├── _renderBar(node, start, dur, status)
│   └── destroy()

dag-studio.js (REFACTOR from control-panel.js — ~600 lines estimated)
├── class DagStudio             — Orchestrator
│   ├── constructor(containerEl, {apiClient, autoDetector, stateManager})
│   ├── activate()              — View shown: load DAG, start polling
│   ├── deactivate()            — View hidden: pause rendering, stop polling
│   ├── _loadDag()              — Fetch → layout → render
│   ├── _runDag()               — Generate UUID → POST → subscribe
│   ├── _cancelDag()            — Cancel with confirmation
│   ├── _forceUnlock()          — Unlock with confirmation + lock ID
│   ├── _loadHistory()          — Fetch iteration list
│   ├── _loadExecution(iterId)  — Fetch metrics → overlay on graph + Gantt
│   ├── _compareExecutions(id1, id2) — Diff two runs
│   ├── _onExecutionUpdated(id, exec) — AutoDetector callback → update graph + Gantt
│   ├── _onNodeSelected(nodeId) — Open detail panel
│   ├── _checkLockState()       — Poll lock endpoint
│   └── destroy()
```

### 3.2 Layout Engine: Sugiyama Algorithm

The Sugiyama (layered) layout is the standard for DAG visualization. Left-to-right flow matching FLT's parent → child data direction.

**Step 1 — Layer Assignment** (O(V + E)):
```
Input:  nodes[], edges[]
Method: Kahn's algorithm (topological sort)
Rule:   layer[node] = max(layer[parent] + 1) for all parents
        Source nodes (no parents) → layer 0
Output: Map<nodeId, layerIndex>
```

**Step 2 — Crossing Minimization** (O(L × N² × P)):
```
Method: Barycenter heuristic
        For each node: position = average(positions of connected nodes in adjacent layer)
        Iterate top-down then bottom-up, 2–4 passes
        Each pass reorders nodes within their layer
Why:    Reduces visual clutter from edge crossings
```

**Step 3 — Coordinate Assignment** (O(V)):
```
spacingX = 200px  (between layers, horizontal)
spacingY = 80px   (between nodes in same layer, vertical)
x = layer * spacingX
y = orderInLayer * spacingY
Each layer centered vertically within the viewport
```

**Step 4 — Edge Routing**:
```
Bezier curves with horizontal midpoint control points:
  midX = (fromNode.x + toNode.x) / 2
  path: M(from.x, from.y) C(midX, from.y, midX, to.y, to.x, to.y)
Long edges (spanning 2+ layers): add virtual waypoints to avoid node overlap
```

**Performance budget:**
- Layout time for 50 nodes: < 10ms
- Layout time for 100 nodes: < 25ms
- Layout time for 300 nodes: < 100ms
- Layout is computed ONCE on load and cached. Re-layout only on DAG definition change or manual trigger.

### 3.3 Canvas Rendering Pipeline

Every frame (60fps via `requestAnimationFrame`):

```
1. Clear canvas (fillRect with background color)
2. ctx.save()
3. Apply camera transform: ctx.translate(tx, ty) + ctx.scale(s, s)
4. Draw background dot grid
5. Draw edges (all in single pass, batch by style)
6. Draw nodes in 3 LOD passes:
   Pass 1: LOD 0 dots (cheapest, drawn first / behind)
   Pass 2: LOD 1 mini rects
   Pass 3: LOD 2 detail cards (most expensive, on top)
7. ctx.restore()
8. Draw minimap (separate transform)
9. Draw HUD: FPS counter, LOD stats (debug mode only)
10. requestAnimationFrame(next frame)
```

**Performance techniques from reference mockup:**
- 3-pass render (cheapest first → correct z-ordering without sort)
- Single `ctx.save()/restore()` per frame (no per-node matrix recalculation)
- `setLineDash` only for failed edges (expensive operation)
- LOD culling: reduces draw calls 10×+ at low zoom
- Minimap sampling: only render every Nth node for overview

### 3.4 Execution State Manager

Connects the real-time telemetry stream to DAG node states.

**Data sources:**
1. **AutoDetector** (existing module) — Parses log stream for DAG execution patterns
   - `[DAG STATUS]` → overall execution state transitions
   - `Executing node` / `Executed node` → per-node status + timing
   - `[DAG_FAULTED_NODES]` → skipped/faulted nodes
   - Error codes: `MLV_*`, `FLT_*`, `SPARK_*` → error classification
2. **Telemetry topic** (future) — SignalR real-time events from `EdogTelemetryInterceptor`
   - `ActivityName === 'RunDAG'` + `IterationId` → execution tracking
   - More reliable than log parsing but requires C# telemetry interceptor work

**State transitions for nodes:**

```
none → running         (Executing node detected)
running → completed    (Executed node + success status)
running → failed       (Error detected or Executed node + failed status)
running → cancelled    (Cancellation detected)
running → cancelling   (Cancel requested but not yet confirmed)
none → skipped         (DAG_FAULTED_NODES or dependency failed)
```

**Callback flow:**
```
SignalR → log message
  → AutoDetector.processMessage(msg)
    → onExecutionDetected(id, exec)    [new execution started]
    → onExecutionUpdated(id, exec)     [state changed]
      → DagStudio._onExecutionUpdated(id, exec)
        → DagCanvasRenderer.updateNodeState(nodeId, newStatus)
        → DagGantt.updateBar(nodeId, {status, startedAt, endedAt})
```

### 3.5 API Client Methods

Extensions to `api-client.js` (or reused from existing `ControlPanel`):

| Method | Endpoint | Returns | Notes |
|--------|----------|---------|-------|
| `getLatestDag(showExtended)` | `GET .../liveTable/getLatestDag?showExtendedLineage={bool}` | `Dag` | Primary DAG structure. Always call with `showExtendedLineage=true`. |
| `runDag(iterationId, body?)` | `POST .../liveTableSchedule/runDAG/{iterationId}` | 202 Accepted | Body optional: `ArtifactJobRequest` for targeted runs. |
| `cancelDag(iterationId)` | `GET .../liveTableSchedule/cancelDAG/{iterationId}` | `DagExecutionStatus` | ⚠ GET not POST. FLT convention. |
| `getDagExecMetrics(iterationId)` | `GET .../liveTable/getDAGExecMetrics/{iterationId}` | `DagExecutionInstance` | Full execution detail: per-node metrics, timing, errors. |
| `listDagExecutions(opts)` | `GET .../liveTable/listDAGExecutionIterationIds` | `List<DagExecutionIteration>` | Params: `historyCount`, `statuses[]`, `startTime`, `endTime`, `continuationToken`. |
| `getLockedExecution()` | `GET .../liveTableMaintanance/getLockedDAGExecutionIteration` | `string\|List<Guid>` | ⚠ URL typo is real (`Maintanance`). |
| `forceUnlockDag(lockedIterId)` | `POST .../liveTableMaintanance/forceUnlockDAGExecution/{lockedIterId}` | `string` | Returns `"Force unlocked Dag"`. ⚠ URL typo. |
| `getDagSettings()` | `GET .../liveTable/settings` | `DagSettingsResponseBody` | Parallel limit, refresh mode, environment. |
| `updateDagSettings(body)` | `PATCH .../liveTable/settings` | `DagSettingsResponseBody` | Update settings. |
| `listMlvDefinitions()` | `GET .../liveTable/mlvExecutionDefinitions` | `List<MLVExecDefResponse>` | Named execution subsets. |
| `createMlvDefinition(body)` | `POST .../liveTable/mlvExecutionDefinitions` | `MLVExecDefResponse` | Create named subset. |

**Error handling strategy:**
- 401/403: Show "Authentication required" → redirect to re-auth flow
- 404: Show "DAG not found — deploy a lakehouse first"
- 429: Show "Rate limited — retry in {Retry-After}s" with auto-retry
- 500: Show "FLT service error" with error details and manual retry button
- Network errors: Show "Connection lost" with reconnect timer

### 3.6 SignalR Integration

Real-time execution updates arrive via the existing SignalR hub (`/hub/playground`), filtered by the telemetry topic.

**Telemetry events relevant to DAG Studio:**

| Event Pattern | Data Extracted | Maps To |
|---------------|---------------|---------|
| `ActivityName = 'RunDAG'` | IterationId, status | Overall execution state |
| `ActivityName contains node name` | Node status, timing | Per-node state |
| `[DAG STATUS] Running` | IterationId | Execution started |
| `[DAG STATUS] Completed` | IterationId, duration | Execution finished |
| `[DAG STATUS] Failed` | IterationId, errorCode | Execution failed |
| `Executing node {name}` | Node name, timestamp | Node started |
| `Executed node {name}` | Node name, status, duration | Node finished |

**Note:** V1 relies on AutoDetector log parsing (already working). SignalR telemetry topic integration for more reliable real-time updates is a future enhancement (requires `EdogTelemetryInterceptor` work).

---

## 4. Folder Structure

```
F08-dag-studio/
├── spec.md                          ← YOU ARE HERE (master spec + product vision)
├── research/
│   └── p0-foundation.md             ← DONE — API deep dive, UI audit, rendering reference
├── components/
│   └── node-detail.md               ← DONE — Deep component spec (position, tabs, cross-links, actions)
├── states/
│   ├── graph-canvas.md              ← Canvas renderer states (LOD transitions, zoom, selection)
│   ├── execution-controls.md        ← Toolbar button states (idle→running→completed→failed)
│   ├── gantt-chart.md               ← Gantt rendering states (empty, loading, active, historical)
│   ├── execution-history.md         ← History table states (empty, loaded, comparing)
│   └── node-detail.md               ← DONE — Detail panel states (19 states, transition matrix, invariants)
└── mocks/
    ├── dag-studio-shell.html        ← Full layout: canvas + toolbar + tabbed bottom panel
    ├── dag-graph.html               ← Standalone Canvas 2D graph with LOD + pan/zoom + mock data
    └── gantt-chart.html             ← Standalone Gantt renderer with mock execution data
```

---

## 5. Prep Checklist

### Phase 0: Foundation Research

| # | Task | Owner | Output | Depends On | Status |
|---|------|-------|--------|-----------|--------|
| P0.1 | FLT DAG API Deep Dive — all endpoints, models, enums | Sana | `research/p0-foundation.md` § 1 | — | ✅ DONE |
| P0.2 | Existing EDOG DAG UI Audit — ControlPanel, AutoDetector, dag.css reusability | Sana | `research/p0-foundation.md` § 2 | — | ✅ DONE |
| P0.3 | Graph Rendering Reference Analysis — Canvas 2D, LOD, layout, interactions | Sana | `research/p0-foundation.md` § 3 | — | ✅ DONE |

### Phase 1: Component Deep Specs

Each spec must contain:
- Every visual state with transitions
- Keyboard interactions
- Error states and recovery
- Performance constraints
- Canvas drawing pseudocode (for graph/Gantt)
- API call sequences with request/response examples

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P1.1 | DAG Graph Canvas | `components/graph-canvas.md` | 26 | P0.3 | ✅ DONE |
| P1.2 | Execution Controls | `components/execution-controls.md` | 15 | P0.1 | ✅ DONE |
| P1.3 | Gantt Chart | `components/gantt-chart.md` | 12 | P0.1 | ✅ DONE |
| P1.4 | Execution History | `components/execution-history.md` | 10 | P0.1 | ✅ DONE |
| P1.5 | Node Detail Panel | `components/node-detail.md` + `states/node-detail.md` | 19 | P0.1 | ✅ DONE |

### Phase 2: Architecture

| # | Task | Owner | Output | Depends On | Status |
|---|------|-------|--------|-----------|--------|
| P2.1 | DagCanvasRenderer class design — LOD thresholds, render pipeline, memory management | Pixel | Within `components/graph-canvas.md` | P1.1 | ✅ DONE |
| P2.2 | DagLayout class design — Sugiyama implementation, virtual nodes, spacing constants | Pixel | Within `components/graph-canvas.md` | P1.1 | ✅ DONE |
| P2.3 | DagStudio orchestrator — lifecycle, AutoDetector wiring, view activation/deactivation | Vex | Inline in `components/execution-controls.md` | P1.1, P1.2 | ✅ DONE |
| P2.4 | API client extensions — new methods, error handling, retry logic | Vex | Inline in `components/execution-controls.md` | P0.1 | ✅ DONE |

### Phase 3: State Matrices

Each matrix lists: every state, every transition, every trigger, every visual, every error.

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P3.1 | Canvas Graph | `states/graph-canvas.md` | 26 | P2.1, P2.2 | ✅ DONE |
| P3.2 | Execution Controls | `states/execution-controls.md` | 15 | P2.3 | ✅ DONE |
| P3.3 | Gantt Chart | `states/gantt-chart.md` | 12 | P2.1 | ✅ DONE |
| P3.4 | Execution History | `states/execution-history.md` | 10 | P2.4 | ✅ DONE |
| P3.5 | Node Detail | `states/node-detail.md` | 19 | P2.4 | ✅ DONE |

### Phase 4: Interactive Mocks

CEO reviews and approves before ANY implementation begins.

| # | Mock | Output | Depends On | Status |
|---|------|--------|-----------|--------|
| P4.1 | DAG Studio Shell | `mocks/dag-studio-shell.html` | P3.1, P3.2 | ⬜ |
| P4.2 | DAG Graph (Canvas 2D) | `mocks/dag-graph.html` | P3.1 | ⬜ |
| P4.3 | Gantt Chart | `mocks/gantt-chart.html` | P3.3 | ⬜ |

---

## 6. Implementation Order (AFTER all prep is done)

```
Layer 0: DagCanvasRenderer — Canvas 2D engine
         ├── 3-level LOD system (dot / mini / detail)
         ├── Pan (mouse drag) + Zoom (wheel, toward cursor)
         ├── Background dot grid
         ├── Node drawing (all 3 LOD levels)
         ├── Edge drawing (bezier curves, status coloring)
         ├── Hit-test (click → node selection)
         ├── Minimap
         └── Fit-to-screen

Layer 1: DagLayout — Sugiyama layout engine
         ├── Topological sort (Kahn's algorithm)
         ├── Layer assignment (longest path)
         ├── Crossing minimization (barycenter, 2-4 passes)
         ├── Coordinate assignment (spacing, centering)
         └── Edge routing (bezier control points)

Layer 2: API Integration
         ├── getLatestDag() → parse nodes/edges → layout → render
         ├── getDagExecMetrics() → overlay metrics onto graph
         ├── listDagExecutions() → history table
         ├── getDagSettings() / updateDagSettings()
         └── Error handling (401/404/429/500)

Layer 3: Execution Controls
         ├── Run DAG button (UUID generation, POST)
         ├── Cancel DAG button (with confirmation)
         ├── Refresh DAG button
         ├── Force Unlock button (with confirmation + lock detection)
         ├── Status indicator (idle/running/completed/failed/locked)
         ├── MLV Execution Definition dropdown
         └── Settings panel (parallel limit, refresh mode, environment)

Layer 4: Real-time Execution Updates
         ├── Wire AutoDetector callbacks → DagCanvasRenderer.updateNodeState()
         ├── Node status transitions: none→running→completed/failed/skipped
         ├── Animated edges during execution (dash offset animation)
         ├── Pulsing running nodes
         ├── Live elapsed time counter
         └── Auto-scroll to first failed node on failure

Layer 5: Gantt Chart
         ├── Time axis (auto-scaled: seconds or minutes)
         ├── Per-node horizontal bars (colored by status)
         ├── Real-time bar growth during execution
         ├── Cross-highlighting with graph (bidirectional)
         ├── Parallelism visualization (concurrent node stacking)
         └── Bottleneck highlighting

Layer 6: Execution History + Comparison
         ├── History table (last 20 executions)
         ├── Click row → load execution data into graph + Gantt
         ├── Pagination via continuation token
         ├── Status filtering
         ├── Compare mode: select two runs → diff view
         └── Per-node diff: status changes, timing regressions, new errors

Layer 7: Node Detail Panel
         ├── Metadata section (name, type, table, parents, children)
         ├── Execution metrics section (timing, row counts, DQ violations)
         ├── Error section (error code, message, failure type)
         ├── Warnings section (CDF, delete hints)
         ├── Filtered log entries (from log stream)
         ├── Cross-lakehouse indicator
         └── Code reference placeholder (V2)

Layer 8: Keyboard Shortcuts + Accessibility
         ├── Arrow keys: navigate between nodes (when selected)
         ├── F: fit-to-screen
         ├── Shift+F: jump to first failed node
         ├── Escape: deselect / close detail panel
         ├── Tab: cycle through interactive elements
         ├── ARIA: canvas fallback content listing all nodes
         └── Screen reader announcements for status changes
```

Each layer is independently testable. Each layer is one PR. Each layer passes `make lint && make test && make build`.

---

## 7. Data Model Reference

Key FLT types consumed by DAG Studio (full details in `research/p0-foundation.md`):

### Dag
```
{ name, workspaceId, lakehouseId, workspaceName, lakehouseName,
  nodes: [Node], edges: [Edge] }
```

### Node
```
{ nodeId: Guid, name, kind: "sql"|"pyspark",
  parents: [Guid], children: [Guid],
  tableType, executable, isShortcut, abfsPath, format,
  lastRefreshTime, isFaulted, fltErrorCode, errorMessage,
  codeReference: { notebookId, cellIndices },
  externalWorkspaceId?, externalLakehouseId?,
  warnings: [{ warningType, relatedSourceEntities }] }
```

### DagExecutionInstance
```
{ iterationId: Guid, dag: Dag,
  dagExecutionMetrics: { jobId, status, startedAt, endedAt,
    errorCode, errorMessage, refreshMode, parallelNodeLimit,
    displayName, jobInvokeType, submitUser },
  nodeExecutionMetrices: Map<Guid, NodeExecutionMetrics> }
```
**⚠ Note:** `nodeExecutionMetrices` has a typo (should be "Metrics") — this is the actual FLT field name. Do not "fix" it in JS; use the real name.

### NodeExecutionMetrics
```
{ status, startedAt, endedAt, errorCode, errorMessage,
  nodeErrorDetails: { errorCode, errorMessage, failureType },
  requestId, sessionId, replId,
  addedRowsCount, droppedRowsCount, totalRowsProcessed,
  totalViolations, refreshPolicy, mlvName, mlvId,
  detailsPageLink, warnings, message }
```

### Enums
```
DagExecutionStatus: notStarted | running | completed | failed | cancelled | cancelling | skipped | notFound
NodeExecutionStatus: none | running | completed | failed | cancelled | skipped | cancelling
ExecutionMode: CurrentLakehouse | SelectedOnly | FullLineage
RefreshMode: Optimal | Full
```

---

## 8. Files Modified / Created

### New Files

| File | Owner | Lines (est.) | Purpose |
|------|-------|-------------|---------|
| `src/frontend/js/dag-graph.js` | Pixel | ~800 | `DagCanvasRenderer` + `DagLayout` classes |
| `src/frontend/js/dag-gantt.js` | Pixel | ~400 | `DagGantt` class |
| `src/frontend/js/dag-studio.js` | Pixel + Vex | ~600 | `DagStudio` orchestrator class |

### Modified Files

| File | Owner | Changes |
|------|-------|---------|
| `src/frontend/js/api-client.js` | Vex | Add 10 DAG API methods (getLatestDag, runDag, cancelDag, getDagExecMetrics, listDagExecutions, getLockedExecution, forceUnlockDag, getDagSettings, updateDagSettings, listMlvDefinitions) |
| `src/frontend/css/dag.css` | Pixel | Already mostly done (134 lines). Add Canvas-specific styles, minimap positioning, comparison view styles. |
| `src/frontend/js/main.js` | Pixel | Wire DagStudio into view switching. `if (viewId === 'dag') dagStudio.activate()` |
| `src/frontend/index.html` | Pixel | Add `#view-dag` container with Canvas element + bottom panel tabs |
| `scripts/build-html.py` | Vex | Add dag-graph.js, dag-gantt.js, dag-studio.js to JS build order (after control-panel.js, before main.js) |
| `src/frontend/js/mock-data.js` | Pixel | Expand DAG mock data to 50+ nodes for performance testing |

### Reused (No Changes)

| File | What We Reuse |
|------|---------------|
| `src/frontend/js/auto-detect.js` | All execution pattern detection + callbacks. Direct integration. |
| `src/frontend/js/control-panel.js` | API calling patterns, token management, DAG data normalization. May be deprecated once DagStudio replaces it. |

---

## 9. Risk Assessment

| Risk | Severity | Probability | Mitigation |
|------|----------|-------------|------------|
| Canvas hit-test is O(N) — slow for 500+ nodes | Medium | Low | Spatial index (quadtree) as Layer 8+ optimization. 300 nodes @ O(N) is < 1ms. |
| Canvas text rendering is blurry on high-DPI | Medium | High | Render at `devicePixelRatio` scale: `canvas.width = el.width * dpr`, `ctx.scale(dpr, dpr)`. |
| Edge crossings in dense DAGs make graph unreadable | Medium | Medium | Sugiyama crossing minimization handles most cases. Add manual node reordering as V2 feature. |
| Long edges spanning 3+ layers overlap nodes | Medium | Medium | Virtual (dummy) nodes per layer for edge routing. Adds visual waypoints. |
| Stale execution data after reconnect | Low | Medium | Auto-refresh DAG + execution data on view activation. Manual refresh button always available. |
| Race condition: run + cancel in rapid succession | Medium | Low | Disable Run during active execution. Debounce Cancel (500ms). Server-side idempotency handles the rest. |
| `cancelDAG` is GET not POST — confusing | Low | Certain | Document the FLT quirk in code comments. Wrap in confirmation dialog. |
| `liveTableMaintanance` URL typo | Low | Certain | Use the actual URL including typo. Comment: `// FLT typo: "Maintanance" not "Maintenance"` |
| `nodeExecutionMetrices` field typo | Low | Certain | Use the actual field name. Comment: `// FLT typo: "Metrices" not "Metrics"` |
| Canvas lacks native accessibility (no DOM tree) | High | Certain | ARIA fallback: hidden table listing all nodes + statuses. Screen reader announcements for state changes. Keyboard navigation via arrow keys on selected node. |
| AutoDetector log parsing is fragile (regex-based) | Medium | Medium | V1: Use AutoDetector (proven, already working). V2: Direct telemetry topic via SignalR for reliable real-time updates. |
| 300+ node DAGs cause layout to be slow | Low | Low | Sugiyama is O(V+E) for layer assignment, O(L×N²×P) for crossing minimization. For 300 nodes: < 100ms. Cache layout; re-layout only on DAG definition change. |

---

## 10. Dependencies

| Dependency | Why | Hard/Soft |
|------------|-----|-----------|
| Feature 2 (Deploy to Lakehouse) | Must be in connected phase to access FLT APIs (`getLatestDag` requires MWC token) | **Hard** — DAG Studio is disabled without connection |
| Feature 5 (Top Bar) | Service status should show "running" before DAG Studio is usable | **Soft** — DAG Studio can work without top bar |
| Feature 3 (Enhanced Logs) | Filtered log entries in Node Detail Panel come from the log stream | **Soft** — Panel works without logs, just shows "No logs" |
| Feature 6 (Sidebar Navigation) | DAG Studio needs a sidebar entry (3rd position, circuit icon) | **Soft** — Can test with direct URL |
| `auto-detect.js` | Real-time execution tracking via log pattern matching | **Hard** — Without this, no live execution updates |
| `api-client.js` | DAG API methods (10 endpoints) | **Hard** — DAG Studio is data-driven from API |

---

## 11. Success Criteria

An FLT engineer opens DAG Studio and within 60 seconds:

1. **Sees** their DAG as an interactive graph — sources on the left, transforms in the middle, outputs on the right
2. **Recognizes** the structure — "yes, that's my 28-node sales pipeline"
3. **Clicks "Run DAG"** — UUID generated, execution starts
4. **Watches nodes light up** in real-time — blue pulsing for running, green for completed, one by one
5. **Sees the Gantt chart** build in real-time — five bars growing simultaneously, then a bottleneck, then the final nodes
6. **Notices a failed node** (red) — clicks it
7. **Reads the error** in the detail panel: `MLV_STALE_METADATA` — stale metadata on `Sales.FactOrders`
8. **Opens execution history** — sees yesterday's run was successful
9. **Clicks "Compare"** between today's failure and yesterday's success
10. **Sees the diff** — node 7 is the regression: succeeded yesterday (2.1s), failed today after 45s

That's the MVP. From "what happened?" to "I know exactly what happened" in **seconds, not minutes**.

### Performance targets:
- 50-node DAG: render in < 16ms (60fps), layout in < 10ms
- 100-node DAG: render in < 16ms (60fps), layout in < 25ms
- 300-node DAG: render in < 16ms (60fps) with LOD, layout in < 100ms
- First meaningful paint (DAG visible after API response): < 200ms
- Node state update (AutoDetector callback → visual change): < 50ms

### Quality targets:
- Keyboard navigable: every action reachable via keyboard
- Accessible: ARIA fallback for screen readers
- Works in Edge + Chrome at 1200px minimum width
- No jank during pan/zoom at any zoom level
- All API errors handled with actionable messages

---

*"The DAG is the heartbeat of FLT. Every table, every transformation, every dependency — it's all in the graph. Today it's invisible. Tomorrow, the engineer sees everything: structure, state, timing, errors, history. One click to run. One click to see why it failed. One click to compare with yesterday. The whole board is visible now."*

— Sana Reeves, Architect
