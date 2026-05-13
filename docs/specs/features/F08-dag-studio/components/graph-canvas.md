# Graph Canvas — Component Spec

> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Owner:** Pixel (Frontend)
> **Reviewer:** Sentinel
> **Depends On:** `spec.md` § 2.3, F08 research docs (Node.cs, Edge.cs, NodeExecutionMetrics)
> **State Matrix:** `../states/graph-canvas.md`
> **Source file:** `src/frontend/js/dag-graph.js`
> **Rendering:** Canvas 2D with 3-level LOD (confirmed)

---

## 1. Purpose

The Graph Canvas is the centerpiece of DAG Studio. It renders a directed acyclic graph of FLT nodes (tables) and edges (dependencies) onto an HTML Canvas element, providing engineers with a live, interactive visualization of their data pipeline topology and execution state.

The canvas solves three problems simultaneously: (1) understanding pipeline structure at a glance via spatial layout, (2) monitoring execution progress in real-time via status-colored nodes, and (3) navigating to specific nodes for inspection via click/keyboard interaction. It replaces the need to mentally reconstruct DAG topology from code or terminal output.

Design lineage: Airflow grid view (DAG structure), dbt DAG explorer (lineage), Chrome DevTools Performance panel (canvas rendering with LOD).

---

## 2. Layout

### 2.1 Position in DAG Studio

```
+--------------------------------------------------------------+
|  DAG Studio Toolbar (execution controls)                      |
+----------------------------------------------+---------------+
|                                              |               |
|                                              | Node Detail   |
|          Graph Canvas                        | Panel         |
|          (this component)                    | (optional     |
|          fills remaining space               |  340px)       |
|                                              |               |
+----------------------------------------------+               |
|  Bottom Panel (Gantt / History / Compare)     |               |
|  (tabbed, collapsible)                        |               |
+----------------------------------------------+---------------+
```

### 2.2 Sizing Rules

| Property | Value | Notes |
|----------|-------|-------|
| Position | Fills parent `.dag-graph-panel` | Top portion of vertical split |
| Min width | 400px | Below this, layout is unusable |
| Min height | 200px | Prevents collapse |
| Resize trigger | `ResizeObserver` on parent | Also fires on split-handle drag, sidebar toggle |

### 2.3 DOM Structure

```html
<div class="dag-graph-panel" id="dagGraphPanel">
  <canvas id="dagCanvas" tabindex="0" role="img"
    aria-label="DAG execution graph"></canvas>
  <div id="dagAriaFallback" class="sr-only" role="table"
    aria-label="DAG nodes and statuses"></div>
  <canvas id="dagMinimap" class="dag-minimap"
    aria-hidden="true"></canvas>
</div>
```

The main canvas is a single `<canvas>` element. A hidden ARIA fallback table provides screen reader access. A smaller minimap canvas renders a viewport indicator.

---

## 3. Data Contract

### 3.1 Node Data (from Node.cs)

Each node in the graph maps to an FLT `Node` entity:

| Field | Type | Canvas Use |
|-------|------|------------|
| `NodeId` | Guid | Unique key for hit-testing, selection |
| `Name` | string | Display label (format: `schema.table`) |
| `Kind` | string | `"sql"` or `"pyspark"` — determines type badge |
| `TableType` | TableType | `MANAGED` (source) vs `MATERIALIZED_LAKE_VIEW` (executable) |
| `Executable` | bool? | Drives visual treatment (executable vs read-only) |
| `RefreshPolicy` | string | `"FullRefresh"` or `"IncrementalRefresh"` — shown in LOD 2 |
| `IsFaulted` | bool | Pre-execution error state — red border treatment |
| `FLTErrorCode` | ErrorCode? | Faulted reason — tooltip content |
| `Children` | List\<Guid\> | Downstream edges (outgoing) |
| `Parents` | List\<Guid\> | Upstream edges (incoming) |
| `ExternalWorkspaceId` | Guid? | Non-null = cross-workspace (non-executable) |
| `ExternalLakehouseId` | Guid? | Non-null = cross-lakehouse (non-executable) |
| `IsShortcut` | bool? | Shortcut tables are non-executable |

**Executability rule:** `Executable = IsMaterializedLakeView && !ExternalLakehouseId.HasValue && IsShortcut != true`

### 3.2 Edge Data (from Edge.cs)

| Field | Type | Canvas Use |
|-------|------|------------|
| `EdgeId` | Guid | Unique edge key |
| `From` | Guid | Source node (parent/upstream) |
| `To` | Guid | Target node (child/downstream) |

### 3.3 Execution Metrics (from NodeExecutionMetrics)

| Field | Type | Canvas Use |
|-------|------|------------|
| `Status` | NodeExecutionStatus | Node fill color, status indicator |
| `StartedAt` | DateTime? | Duration calculation |
| `EndedAt` | DateTime? | Duration calculation |
| `AddedRowsCount` | long | LOD 2 row count display |
| `ErrorCode` | string | Error badge on node |
| `ErrorMessage` | string | Tooltip content |

### 3.4 Internal Layout Data

After Sugiyama layout, each node gets computed position:

```javascript
// LayoutNode — internal to DagLayout
{
  nodeId: string,       // maps to Node.NodeId
  x: number,            // computed world-space X
  y: number,            // computed world-space Y
  layer: number,        // Sugiyama layer (column in LTR)
  order: number,        // position within layer
  width: number,        // LOD-dependent render width
  height: number        // LOD-dependent render height
}
```

---

## 4. Visual Encoding

### 4.1 Node Status Colors

All colors reference design system tokens. Background color is determined by `NodeExecutionStatus`:

| Status | Fill | Border | Text | Token |
|--------|------|--------|------|-------|
| None (idle) | `var(--color-bg)` | `var(--color-border)` | `var(--color-text)` | — |
| Running | `var(--accent-dim)` | `var(--accent)` | `var(--color-text)` | `--accent` family |
| Completed | `rgba(24,160,88,0.08)` | `var(--status-succeeded)` | `var(--color-text)` | `--status-succeeded` |
| Failed | `rgba(229,69,59,0.08)` | `var(--status-failed)` | `var(--color-text)` | `--status-failed` |
| Cancelled | `rgba(229,148,12,0.08)` | `var(--status-cancelled)` | `var(--color-text)` | `--status-cancelled` |
| Skipped | `var(--color-bg-secondary)` | `var(--status-pending)` | `var(--color-text-tertiary)` | `--status-pending` |

### 4.2 Node Type Badges

| TableType | Badge Text | Badge Color |
|-----------|-----------|-------------|
| MATERIALIZED_LAKE_VIEW + sql | `SQL` | `var(--accent)` text on `var(--accent-dim)` bg |
| MATERIALIZED_LAKE_VIEW + pyspark | `PY` | `var(--accent)` text on `var(--accent-dim)` bg |
| MANAGED (source) | `SRC` | `var(--color-text-tertiary)` text on `var(--color-bg-tertiary)` bg |
| External (cross-workspace) | `EXT` | `var(--color-text-tertiary)` text, dashed border |

### 4.3 Edge Visual Encoding

| Condition | Stroke | Width | Style |
|-----------|--------|-------|-------|
| Default | `var(--color-border)` | 1px | Solid |
| Highlighted (hover source/target) | `var(--accent)` | 2px | Solid |
| Active (data flowing during execution) | `var(--accent)` | 2px | Animated dash |
| Error path (parent failed) | `var(--status-failed)` | 1.5px | Solid |
| Cross-workspace | `var(--color-text-tertiary)` | 1px | Dashed |

### 4.4 Selection & Focus

| State | Visual Treatment |
|-------|------------------|
| Hovered | Border brightens, subtle shadow: `0 0 0 2px var(--accent-glow)` |
| Selected | 2px border `var(--accent)`, background tint `var(--accent-dim)` |
| Focused (keyboard) | 2px focus ring `var(--accent-glow)`, matches selection visual |
| Multi-selected | Same as selected, applied to each node in selection set |

---

## 5. LOD System (Level of Detail)

### 5.1 LOD Thresholds

| Level | Zoom Range | Node Size | Rendering |
|-------|-----------|-----------|-----------|
| LOD 0 — Dot | zoom < 0.3 | 4–6px circle | Status-colored dot only |
| LOD 1 — Mini | 0.3 <= zoom < 0.8 | 60 x 24px rect | Colored rect + 8-char truncated name |
| LOD 2 — Detail | zoom >= 0.8 | 140 x 52px card | Full card: name, type badge, duration, status bar |

### 5.2 LOD 0 — Dot Rendering

```javascript
// Minimal: status-colored circle
ctx.beginPath();
ctx.arc(node.x, node.y, 3 * dpr, 0, Math.PI * 2);
ctx.fillStyle = statusColor;   // resolved from NodeExecutionStatus
ctx.fill();
```

No text, no border detail. Used for distant nodes or extreme zoom-out. Edges rendered as 0.5px lines.

### 5.3 LOD 1 — Mini Rendering

```javascript
// Compact rectangle with truncated name
ctx.fillStyle = statusBgColor;
ctx.fillRect(node.x, node.y, 60, 24);
ctx.strokeStyle = statusBorderColor;
ctx.strokeRect(node.x, node.y, 60, 24);
ctx.fillStyle = textColor;      // var(--color-text)
ctx.font = '10px system-ui';
ctx.fillText(truncate(node.name, 8), node.x + 4, node.y + 16);
```

60x24px rectangle with 8-character truncated name. Status color on border only.

### 5.4 LOD 2 — Detail Card Rendering

```
+------------------------------------+
| [SQL]  dbo.fact_sales         1m23s |
| ████████████░░░░░░  IncrRefresh    |
+------------------------------------+
  140px wide, 52px tall
```

Elements rendered in order:
1. **Background fill** — status-tinted (see § 4.1)
2. **Border** — 1px status-colored, 4px radius
3. **Type badge** — top-left, 6px font, pill shape
4. **Name** — primary text, 11px, truncated with ellipsis at ~18 chars
5. **Duration** — top-right, secondary text color, `Xm Xs` format
6. **Status bar** — bottom 3px strip, solid status color (animated pulse for Running)
7. **Refresh policy** — bottom-right, 9px tertiary text

### 5.5 LOD Transition

LOD transitions are instant (no animation). When zoom crosses a threshold, all nodes re-render at the new LOD on the next frame. Layout positions remain constant — only rendering detail changes.

---

## 6. Layout Engine (Sugiyama)

### 6.1 Algorithm Steps

1. **Layer assignment** — Kahn's algorithm (topological sort). Each node assigned to a layer based on longest path from sources.
2. **Crossing minimization** — Barycenter heuristic. Iteratively reorder nodes within each layer to minimize edge crossings.
3. **Coordinate assignment** — Brandes-Kopf for compact, balanced positioning.
4. **Edge routing** — Orthogonal routing with rounded corners (8px radius).

### 6.2 Layout Direction

**Left-to-right (LTR).** Sources on the left, sinks on the right. Matches natural reading direction and data flow mental model (raw -> transformed -> output).

### 6.3 Spacing Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `LAYER_GAP` | 180px | Horizontal distance between layers |
| `NODE_GAP` | 32px | Vertical distance between nodes in same layer |
| `EDGE_PADDING` | 16px | Minimum clearance between edge and node |
| `MARGIN` | 40px | Canvas margin around entire graph |

### 6.4 Layout Caching

Layout is recomputed only when:
- DAG topology changes (nodes/edges added or removed)
- Container resizes (recalculates but preserves relative positions)
- User triggers "reset layout" action

Layout is NOT recomputed during execution — node positions are stable while status colors animate.

---

## 7. Camera Model

### 7.1 State

```javascript
{
  offsetX: number,    // pan offset (world units)
  offsetY: number,
  zoom: number,       // scale factor (0.1 to 3.0)
}
```

### 7.2 Transforms

```javascript
// World -> Screen
screenX = (worldX + camera.offsetX) * camera.zoom;
screenY = (worldY + camera.offsetY) * camera.zoom;

// Screen -> World (for hit testing)
worldX = screenX / camera.zoom - camera.offsetX;
worldY = screenY / camera.zoom - camera.offsetY;
```

### 7.3 Zoom Constraints

| Property | Value |
|----------|-------|
| Min zoom | 0.1 |
| Max zoom | 3.0 |
| Zoom step (wheel) | x1.1 per tick |
| Zoom anchor | Mouse cursor position (zoom-to-point) |
| Fit-to-view | Calculates zoom to fit all nodes with 40px margin |

---

## 8. Interaction Model

### 8.1 Mouse Interactions

| Action | Behavior | State Change |
|--------|----------|--------------|
| Click node | Select node, open Node Detail Panel | `node.selected` -> fire `node:select` event |
| Click empty canvas | Deselect all, close detail panel | Clear selection |
| Ctrl+Click node | Toggle node in multi-selection | Add/remove from selection set |
| Double-click node | Fit-to-node (zoom + center on node) | Camera animate to node |
| Mouse wheel | Zoom in/out anchored to cursor | Camera zoom change |
| Click + drag (empty) | Pan canvas | Camera offset change |
| Click + drag (node) | No-op (nodes are not draggable) | — |
| Hover node | Highlight node + connected edges | `node.hovered` visual state |
| Right-click node | Context menu (Run Node, View Code, Copy Name) | Menu open |

### 8.2 Keyboard Navigation

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle through nodes in topological order |
| `Arrow keys` | Navigate to adjacent node (left=upstream, right=downstream, up/down within layer) |
| `Enter` | Select focused node (open detail panel) |
| `Escape` | Deselect / close detail panel |
| `+` / `-` | Zoom in / out |
| `0` | Fit all nodes in view |
| `F` | Fit selected node(s) in view |
| `Ctrl+A` | Select all executable nodes |

### 8.3 Touch Interactions (tablet)

| Gesture | Behavior |
|---------|----------|
| Tap node | Select |
| Pinch | Zoom |
| Two-finger drag | Pan |
| Long press | Context menu |

---

## 9. Minimap

### 9.1 Layout

Positioned bottom-right of the graph panel, 160x100px, with `var(--color-bg-secondary)` background and `var(--color-border)` border.

### 9.2 Rendering

- All nodes rendered as 2px colored dots (using status color)
- Viewport rectangle: 1px `var(--accent)` stroke showing visible area
- Click on minimap: pan canvas to clicked location
- Drag viewport rectangle: pan canvas in real-time

### 9.3 Visibility

Hidden when total nodes < 20 (minimap adds no value for small graphs).

---

## 10. Real-Time Updates (SignalR)

### 10.1 Event Handling

| SignalR Event | Canvas Response |
|---------------|-----------------|
| `NodeStarted` | Set node status -> Running, start pulse animation, update status color |
| `NodeCompleted` | Set node status -> Completed, stop pulse, set green border, update duration text |
| `NodeFailed` | Set node status -> Failed, stop pulse, set red border, add error badge |
| `DagTerminal` | Update all remaining nodes (cascade: failed parent -> child Skipped) |

### 10.2 Animation

**Running pulse:** A 2-second pulse on the node's status bar (opacity oscillates 0.4 -> 1.0 -> 0.4). Implemented via `requestAnimationFrame` with timestamp-based interpolation.

```javascript
// Running node pulse (LOD 2 status bar)
const pulse = 0.4 + 0.6 * Math.abs(Math.sin(timestamp / 1000 * Math.PI));
ctx.globalAlpha = pulse;
ctx.fillStyle = accentColor;   // var(--accent)
ctx.fillRect(node.x, node.y + 49, 140, 3);
ctx.globalAlpha = 1.0;
```

**Completion flash:** On `NodeCompleted`, a 300ms brightness flash (border goes full opacity, then settles to normal).

### 10.3 Batch Updates

During execution, multiple `NodeStarted`/`NodeCompleted` events may arrive within a single frame. The canvas batches all pending status updates and applies them in a single `requestAnimationFrame` callback to avoid redundant redraws.

---

## 11. Error States

| Error Condition | Visual Treatment | User Action |
|-----------------|------------------|-------------|
| Faulted node (`IsFaulted=true`) | Red dashed border, `!` badge, tooltip shows `FLTErrorCode` | Hover for error details |
| Failed execution | Red solid border, error icon top-right (LOD 2) | Click to open detail panel |
| No DAG data | Centered message: "No DAG loaded" in `var(--color-text-secondary)` | — |
| Layout computation error | Fallback to linear layout (nodes in a row) | Retry button |
| WebSocket disconnect | Top banner: "Connection lost — reconnecting..." amber background | Auto-retry with backoff |
| Canvas context lost | Re-initialize canvas, restore camera state | Automatic recovery |

---

## 12. Accessibility

### 12.1 ARIA Fallback Table

Since Canvas is opaque to screen readers, a hidden `role="table"` is maintained in sync with the graph:

```html
<div id="dagAriaFallback" class="sr-only" role="table"
  aria-label="DAG nodes and statuses">
  <div role="row">
    <span role="cell">dbo.fact_sales</span>
    <span role="cell">SQL</span>
    <span role="cell">Completed</span>
    <span role="cell">1m 23s</span>
  </div>
  <!-- one row per node -->
</div>
```

### 12.2 Focus Management

- Canvas element is focusable (`tabindex="0"`)
- Active node announced via `aria-live="polite"` region
- Focus ring rendered on canvas around focused node (2px `var(--accent-glow)`)
- `Tab` cycles through nodes in topological order

### 12.3 Reduced Motion

When `prefers-reduced-motion: reduce` is active:
- Running pulse replaced by static `var(--accent)` status bar
- Completion flash disabled
- Camera animations replaced by instant jumps

---

## 13. Performance

### 13.1 Budget

| Metric | Target |
|--------|--------|
| Render frame (100 nodes) | < 4ms (250fps headroom) |
| Render frame (500 nodes) | < 8ms |
| Render frame (1000 nodes) | < 16ms (60fps floor) |
| Layout computation (500 nodes) | < 200ms |
| Memory (1000 nodes) | < 20MB total canvas state |

### 13.2 Optimization Strategies

1. **Off-screen culling** — Skip rendering nodes outside the visible viewport (check AABB intersection before drawing).
2. **LOD-based rendering** — Distant/small nodes render as dots (LOD 0), saving text rendering cost.
3. **Dirty-rect rendering** — During execution, only redraw nodes whose status changed (track dirty set per frame).
4. **Layout caching** — Sugiyama layout computed once, cached until topology changes. Execution status changes never trigger re-layout.
5. **High-DPI awareness** — Use `devicePixelRatio` for crisp rendering without doubling draw calls.
6. **Object pooling** — Reuse `Path2D` objects for repeated shapes (node rects, badges).

### 13.3 High-DPI Rendering

```javascript
const dpr = window.devicePixelRatio || 1;
canvas.width = rect.width * dpr;
canvas.height = rect.height * dpr;
canvas.style.width = rect.width + 'px';
canvas.style.height = rect.height + 'px';
ctx.scale(dpr, dpr);
```

---

## 14. Hit Testing

### 14.1 Algorithm

Point-in-rectangle test for nodes, using world-space coordinates:

```javascript
hitTest(screenX, screenY) {
  const wx = screenX / camera.zoom - camera.offsetX;
  const wy = screenY / camera.zoom - camera.offsetY;
  for (const node of this._nodes.reverse()) {
    if (wx >= node.x && wx <= node.x + node.width &&
        wy >= node.y && wy <= node.y + node.height) {
      return node;
    }
  }
  return null;
}
```

### 14.2 Spatial Index

For graphs > 200 nodes, a simple grid-based spatial index partitions world space into cells. Hit testing checks only the cell containing the cursor, reducing O(n) to O(1) average.

---

## 15. Background & Grid

### 15.1 Background

Solid fill `var(--color-bg)` (white in light theme). No texture, no gradient.

### 15.2 Dot Grid

At zoom > 0.5, render a subtle dot grid:
- Dot spacing: 20px (world space)
- Dot size: 1px
- Dot color: `var(--color-border)` at 40% opacity
- Provides spatial reference during pan/zoom without visual noise

---

## 16. Cross-Workspace Nodes

Nodes with `ExternalWorkspaceId != null` or `ExternalLakehouseId != null` are rendered with:
- Dashed border (`setLineDash([4, 4])`)
- `EXT` badge instead of `SQL`/`PY`
- Dimmed text color (`var(--color-text-tertiary)`)
- Non-interactive during execution (no status updates, always show as idle)
- Tooltip: "External node (workspace: {ExternalWorkspaceName})"

These nodes are NEVER executable. They provide lineage context only.

---

## 17. API Dependencies

| Endpoint / Channel | Method | Purpose |
|--------------------|--------|---------|
| `GET /api/dag/{dagId}` | REST | Fetch DAG topology (nodes + edges) |
| `GET /api/dag/{dagId}/metrics` | REST | Fetch latest execution metrics per node |
| SignalR `"dag"` topic | WebSocket | Real-time execution events |
| `POST /api/dag/{dagId}/execute` | REST | Trigger execution (toolbar, not canvas) |

---

## 18. Public API (JavaScript)

```javascript
class DagCanvasRenderer {
  constructor(container, options)
  setData(nodes, edges)               // Set DAG topology
  updateNodeStatus(nodeId, status)    // Update single node execution status
  selectNode(nodeId)                  // Programmatic selection
  fitToView(nodeIds?)                 // Zoom to fit all or specific nodes
  getSelectedNodes()                  // Returns current selection
  setCamera(offsetX, offsetY, zoom)   // Programmatic camera control
  destroy()                           // Cleanup, release canvas context

  // Events (EventTarget-based)
  // 'node:select'   — { nodeId }
  // 'node:hover'    — { nodeId }
  // 'node:context'  — { nodeId, x, y }
  // 'camera:change' — { offsetX, offsetY, zoom }
}
```

---

## 19. Memory Management

| Resource | Lifecycle |
|----------|-----------|
| Canvas context | Created on mount, released on `destroy()` |
| Layout cache | Invalidated on topology change |
| Animation frame | Cancelled on `destroy()` or when no running nodes |
| Event listeners | Removed on `destroy()` (resize, mouse, keyboard, wheel) |
| Spatial index | Rebuilt on layout change |

The `destroy()` method MUST be called when DAG Studio unmounts to prevent memory leaks from retained canvas contexts and animation loops.
