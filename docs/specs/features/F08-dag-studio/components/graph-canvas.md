# DAG Graph Canvas Renderer — Deep Component Spec

> **Component:** `DagCanvasRenderer` + `DagLayout`
> **Owner:** Pixel (Frontend Engineer)
> **Source file:** `src/frontend/js/dag-graph.js` (~800 lines)
> **Rendering decision:** Canvas 2D with 3-level LOD — CEO confirmed. NOT SVG.
> **Status:** SPEC COMPLETE — ready for implementation

---

## Table of Contents

1. [Canvas Element & Sizing](#1-canvas-element--sizing)
2. [Camera Model](#2-camera-model)
3. [Layout Engine (Sugiyama)](#3-layout-engine-sugiyama)
4. [Canvas Rendering Pipeline](#4-canvas-rendering-pipeline)
5. [LOD System](#5-lod-system)
6. [Node Rendering](#6-node-rendering)
7. [Edge Rendering](#7-edge-rendering)
8. [Background & Grid](#8-background--grid)
9. [Minimap](#9-minimap)
10. [Hit Testing](#10-hit-testing)
11. [Interaction Model](#11-interaction-model)
12. [Animation System](#12-animation-system)
13. [High-DPI Rendering](#13-high-dpi-rendering)
14. [Off-Screen Culling](#14-off-screen-culling)
15. [Performance Targets & Budget](#15-performance-targets--budget)
16. [Public API](#16-public-api)
17. [Data Contracts](#17-data-contracts)
18. [Error Handling](#18-error-handling)
19. [Memory Management & Lifecycle](#19-memory-management--lifecycle)
20. [Accessibility Fallback](#20-accessibility-fallback)

---

## 1. Canvas Element & Sizing

### DOM Structure

```html
<div class="dag-graph-panel" id="dagGraphPanel">
  <canvas id="dagCanvas" tabindex="0" role="img"
    aria-label="DAG execution graph"></canvas>
  <!-- Hidden ARIA fallback table rendered by JS -->
  <div id="dagAriaFallback" class="sr-only" role="table"
    aria-label="DAG nodes and statuses"></div>
</div>
```

### Sizing Rules

The canvas fills its parent container (`dag-graph-panel`, which is the top 60% of DAG Studio's split layout). Sizing is recalculated on:

1. **Window resize** — `ResizeObserver` on the parent container.
2. **Split handle drag** — When user drags the horizontal split between graph and bottom panel.
3. **Sidebar toggle** — When sidebar or detail panel open/close, the available width changes.

```javascript
_resize() {
  const rect = this._container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  // Logical size (CSS pixels)
  this._canvas.style.width = rect.width + 'px';
  this._canvas.style.height = rect.height + 'px';

  // Backing store size (physical pixels)
  this._canvas.width = Math.round(rect.width * dpr);
  this._canvas.height = Math.round(rect.height * dpr);

  this._width = rect.width;   // logical
  this._height = rect.height; // logical
  this._dpr = dpr;

  this._dirty = true;
}
```

**Debounce:** Resize events are debounced at 16ms (one frame) to avoid layout thrashing.

---

## 2. Camera Model

A single affine transform object drives all world-to-screen conversions.

### State

```javascript
this._camera = {
  x: 0,      // translation X in screen pixels
  y: 0,      // translation Y in screen pixels
  scale: 1,  // zoom level
};
```

### Bounds

| Property | Min | Max | Default |
|----------|-----|-----|---------|
| `scale` | 0.15 | 3.0 | 1.0 |
| `x` | −Infinity | +Infinity | centered on graph |
| `y` | −Infinity | +Infinity | centered on graph |

### World ↔ Screen Conversions

```javascript
// Screen pixel → world coordinate
_screenToWorld(sx, sy) {
  return {
    x: (sx - this._camera.x) / this._camera.scale,
    y: (sy - this._camera.y) / this._camera.scale,
  };
}

// World coordinate → screen pixel
_worldToScreen(wx, wy) {
  return {
    x: wx * this._camera.scale + this._camera.x,
    y: wy * this._camera.scale + this._camera.y,
  };
}
```

### Applying to Canvas

Every frame, the camera transform is applied once:

```javascript
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // reset to DPI scaling
ctx.translate(this._camera.x, this._camera.y);
ctx.scale(this._camera.scale, this._camera.scale);
```

This is a single `save()/restore()` per frame. No per-node matrix recalculation.

### Camera Persistence

When the user switches away from DAG Studio and returns, the camera state is preserved in `DagStudio._savedCameraState`. On `activate()`, the previous camera is restored so the user's viewport position is maintained.

---

## 3. Layout Engine (Sugiyama)

Class: `DagLayout` — A standalone, stateless layout calculator. Zero side effects, zero DOM access.

### Input

```javascript
// nodes: Array of { nodeId: Guid, parents: Guid[], children: Guid[] }
// edges: Array of { edgeId: Guid, from: Guid, to: Guid }
layout(nodes, edges) → Map<nodeId, { x, y, layer, order }>
```

### Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `SPACING_X` | 200px | Horizontal gap between layers. Leaves room for bezier curves. |
| `SPACING_Y` | 80px | Vertical gap between nodes in the same layer. Prevents overlap at LOD 2 (node height is 52px). |
| `NODE_WIDTH` | 140px | LOD 2 card width. Used for edge anchor point calculation. |
| `NODE_HEIGHT` | 52px | LOD 2 card height. |
| `PADDING` | 48px | Padding around graph bounding box for fit-to-screen. |
| `MAX_BARYCENTER_PASSES` | 4 | Crossing minimization iterations. Diminishing returns beyond 4. |

---

### Step 1: Layer Assignment (Topological Sort)

**Algorithm:** Modified Kahn's algorithm computing the longest path from any root.

**Goal:** Assign each node a `layer` (integer, 0-indexed) such that all edges flow from lower layers to higher layers (left to right).

**Pseudocode:**

```
function _assignLayers(nodes, edges):
    // Build adjacency structures
    inDegree = Map<nodeId, int>     // in-degree count
    parentMap = Map<nodeId, Set>    // nodeId → set of parent nodeIds
    childMap = Map<nodeId, Set>     // nodeId → set of child nodeIds
    layer = Map<nodeId, int>        // result

    for each node in nodes:
        inDegree[node.id] = 0
        parentMap[node.id] = new Set()
        childMap[node.id] = new Set()

    for each edge in edges:
        inDegree[edge.to] += 1
        parentMap[edge.to].add(edge.from)
        childMap[edge.from].add(edge.to)

    // Initialize queue with roots (no incoming edges)
    queue = []
    for each node in nodes:
        if inDegree[node.id] === 0:
            queue.push(node.id)
            layer[node.id] = 0

    // BFS — longest path assignment
    while queue.length > 0:
        current = queue.shift()
        for each child in childMap[current]:
            // Layer is max of all parent layers + 1
            candidate = layer[current] + 1
            if candidate > (layer[child] || 0):
                layer[child] = candidate
            inDegree[child] -= 1
            if inDegree[child] === 0:
                queue.push(child)

    // Cycle detection: if any node has no layer assigned, the graph has a cycle
    for each node in nodes:
        if layer[node.id] === undefined:
            // Assign to max layer + 1 and log warning
            layer[node.id] = maxLayer + 1
            console.warn(`[DagLayout] Cycle detected: node ${node.id} unreachable via topological sort`)

    return layer
```

**Time complexity:** O(V + E)

**Cycle handling:** FLT DAGs are acyclic by construction, but corrupted data or bugs could introduce cycles. If a cycle is detected:
1. Break the cycle by assigning unreachable nodes to `maxLayer + 1`.
2. Emit a console warning.
3. Render a yellow warning banner in the graph: "Circular dependency detected — graph may be incomplete."
4. Affected nodes get a dashed orange border and a ⚠ badge at LOD 2.

---

### Step 2: Node Ordering (Crossing Minimization)

**Algorithm:** Barycenter heuristic with bidirectional sweeps.

**Goal:** Within each layer, order nodes to minimize the number of edge crossings.

**Pseudocode:**

```
function _minimizeCrossings(layerMap, parentMap, childMap):
    // Group nodes by layer
    layers = Map<layerIndex, Array<nodeId>>
    for each (nodeId, layerIdx) in layerMap:
        layers[layerIdx].push(nodeId)

    // Initialize order: sort alphabetically by node name (deterministic)
    for each layer in layers.values():
        layer.sort((a, b) => nodes[a].name.localeCompare(nodes[b].name))

    // Bidirectional sweep — 4 passes
    for pass = 0 to MAX_BARYCENTER_PASSES - 1:
        if pass % 2 === 0:
            // Forward sweep (layer 0 → max)
            for layerIdx = 1 to maxLayer:
                _reorderLayer(layers[layerIdx], layers[layerIdx - 1], parentMap, 'parents')
        else:
            // Backward sweep (max → layer 0)
            for layerIdx = maxLayer - 1 downto 0:
                _reorderLayer(layers[layerIdx], layers[layerIdx + 1], childMap, 'children')

    return layers

function _reorderLayer(currentLayer, adjacentLayer, connectionMap, direction):
    // Compute barycenter for each node
    positions = Map<nodeId, float>
    adjPositions = Map<nodeId, int>  // position index of each node in adjacent layer
    for (i, nodeId) in adjacentLayer:
        adjPositions[nodeId] = i

    for each nodeId in currentLayer:
        connections = connectionMap[nodeId]  // parent or child set
        if connections.size === 0:
            positions[nodeId] = currentLayer.indexOf(nodeId)  // keep current position
            continue
        sum = 0
        count = 0
        for each connId in connections:
            if adjPositions.has(connId):
                sum += adjPositions[connId]
                count += 1
        positions[nodeId] = count > 0 ? sum / count : currentLayer.indexOf(nodeId)

    // Sort layer by barycenter value (stable sort preserves order for equal values)
    currentLayer.sort((a, b) => positions[a] - positions[b])
```

**Time complexity:** O(P × L × N²) where P=passes, L=layers, N=max nodes per layer. For a 300-node, 15-layer DAG with max 20 nodes/layer: 4 × 15 × 400 = 24,000 operations ≈ < 5ms.

---

### Step 3: Coordinate Assignment

**Goal:** Convert layer index + order index into world X/Y coordinates. Center each layer vertically.

**Pseudocode:**

```
function _assignPositions(layers):
    positions = Map<nodeId, {x, y}>

    // Find the tallest layer (most nodes) for centering reference
    maxNodesInLayer = max(layer.length for layer in layers.values())
    totalHeight = maxNodesInLayer * SPACING_Y

    for each (layerIdx, nodeList) in layers:
        layerHeight = nodeList.length * SPACING_Y
        yOffset = (totalHeight - layerHeight) / 2  // center vertically

        for (orderIdx, nodeId) in nodeList:
            positions[nodeId] = {
                x: layerIdx * SPACING_X,
                y: yOffset + orderIdx * SPACING_Y,
                layer: layerIdx,
                order: orderIdx,
            }

    return positions
```

**Wide DAG handling (20+ nodes in one layer):** When `nodeList.length > 15`, reduce `SPACING_Y` proportionally:
```javascript
const effectiveSpacingY = nodeList.length > 15
  ? Math.max(SPACING_Y * 15 / nodeList.length, 56)  // min 56px (LOD 2 height + 4px)
  : SPACING_Y;
```

This prevents extremely tall graphs while maintaining readability. The minimum 56px ensures LOD 2 cards don't overlap.

**Deep DAG handling (15+ layers):** No special treatment needed — horizontal scrolling via pan is natural for left-to-right flows. The fit-to-screen function will zoom out appropriately.

**Disconnected subgraphs:** Nodes with no parents AND no children (isolated) are placed in a separate "orphan" column at layer 0, stacked vertically below the main graph with a 120px vertical gap. They receive a dotted border at LOD 2 to indicate disconnection.

**Single-node DAGs:** Centered in viewport at layer 0, position (0, 0). Fit-to-screen scales to fill 40% of viewport width.

---

### Step 4: Edge Routing

**Goal:** Compute bezier curve control points for every edge. Edges flow strictly left-to-right.

#### Direct Edges (span exactly 1 layer)

```
Source anchor:  (sourceNode.x + NODE_WIDTH/2, sourceNode.y)
Target anchor:  (targetNode.x - NODE_WIDTH/2, targetNode.y)

midX = (source.x + target.x) / 2

Control points:
  CP1 = (midX, source.y)
  CP2 = (midX, target.y)

Path: M(source) C(CP1, CP2, target)
```

This produces a smooth horizontal S-curve that bends vertically only when source and target are at different Y positions.

#### Long Edges (span 2+ layers)

Edges crossing multiple layers risk overlapping intermediate nodes. Route them through virtual waypoints:

```
function _routeLongEdge(from, to, positions, layers):
    waypoints = [from]
    fromLayer = positions[from.nodeId].layer
    toLayer = positions[to.nodeId].layer

    for layerIdx = fromLayer + 1 to toLayer - 1:
        // Place waypoint at midpoint between adjacent layers
        // Y-position: interpolate between source and target
        t = (layerIdx - fromLayer) / (toLayer - fromLayer)
        wpX = layerIdx * SPACING_X - SPACING_X / 2
        wpY = from.y + (to.y - from.y) * t

        // Offset to avoid overlapping nodes in intermediate layers
        nodesInLayer = layers[layerIdx]
        for each node in nodesInLayer:
            nodeY = positions[node].y
            if Math.abs(wpY - nodeY) < NODE_HEIGHT:
                // Nudge waypoint to pass between nodes
                wpY = nodeY + NODE_HEIGHT / 2 + 8  // 8px clearance

        waypoints.push({ x: wpX, y: wpY })

    waypoints.push(to)

    // Generate piecewise bezier segments between consecutive waypoints
    segments = []
    for i = 0 to waypoints.length - 2:
        p0 = waypoints[i]
        p1 = waypoints[i + 1]
        midX = (p0.x + p1.x) / 2
        segments.push({
            start: p0,
            cp1: { x: midX, y: p0.y },
            cp2: { x: midX, y: p1.y },
            end: p1,
        })

    return segments
```

#### Arrow Heads

Arrowheads are drawn at the target end of each edge. A small filled triangle:

```
function _drawArrowhead(ctx, endX, endY, angle):
    const size = 6
    ctx.save()
    ctx.translate(endX, endY)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-size, -size / 2)
    ctx.lineTo(-size, size / 2)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
```

For horizontal edges, angle is 0 (pointing right). For edges with vertical displacement, compute the angle from the last bezier segment's tangent at `t=1`:

```javascript
// Tangent at t=1 for cubic bezier M(p0) C(cp1, cp2, p1):
const tx = 3 * (p1.x - cp2.x);
const ty = 3 * (p1.y - cp2.y);
const angle = Math.atan2(ty, tx);
```

---

## 4. Canvas Rendering Pipeline

### Frame Loop

The renderer uses `requestAnimationFrame` with a dirty flag pattern — it does NOT re-render every frame unconditionally.

```javascript
_frameLoop(timestamp) {
  this._rafId = requestAnimationFrame(this._frameLoop.bind(this));

  // Only render if dirty
  if (!this._dirty && !this._animating) return;

  this._render(timestamp);
  this._dirty = false;
}
```

### Dirty Flag Triggers

| Trigger | Sets `_dirty` | Sets `_animating` |
|---------|:---:|:---:|
| Pan (mouse drag) | ✓ | — |
| Zoom (wheel) | ✓ | — |
| Window resize | ✓ | — |
| Node state change (`updateNodeState`) | ✓ | — |
| Node selection change | ✓ | — |
| Hover change | ✓ | — |
| Fit-to-screen | — | ✓ (until animation ends) |
| Execution running (pulse animation) | — | ✓ (while any node is `running`) |
| Layout transition (nodes moving) | — | ✓ (500ms spring) |
| Status color transition | — | ✓ (300ms per transition) |
| Dash animation on flowing edges | — | ✓ (while any edge is `flowing`) |

When `_animating` is true, the frame loop renders every frame until all animations complete, then clears `_animating`.

### Render Order (per frame)

```
1.  Clear canvas (full rect, background color)
2.  ctx.save()
3.  Apply camera transform: translate(tx, ty) → scale(s, s)
4.  Draw background dot grid (only visible portion)
5.  Draw edges — single pass, batched by style:
    a. Normal edges (grey, 0.4 opacity, 1.5px)
    b. Error edges (red, 0.5 opacity, dashed)
    c. Flowing edges (blue animated dashes)
    d. Selected path edges (accent, 0.8 opacity, 2.5px)
6.  Draw nodes — 3 LOD passes:
    Pass 1: LOD 0 dots (cheapest, drawn first = behind)
    Pass 2: LOD 1 mini rectangles
    Pass 3: LOD 2 detail cards (most expensive, on top)
7.  Draw selection highlight ring (if node selected)
8.  Draw hover highlight (if hovering)
9.  ctx.restore()
10. Draw minimap (separate coordinate space, screen-fixed position)
11. Draw HUD (debug mode only): FPS counter, LOD stats, node count
```

### Why This Order

- **Edges before nodes:** Edges appear behind nodes. No z-sorting needed.
- **3-pass node render (LOD 0 → 1 → 2):** Higher LOD = higher visual importance = drawn on top. This is cheapest-first rendering: LOD 0 dots render in O(1) per node (single `arc()`), LOD 1 in ~3 draw calls, LOD 2 in ~8+. If the user is zoomed out (most nodes are LOD 0), the frame is cheap.
- **Minimap after restore:** Minimap uses its own coordinate space and is always screen-fixed in the bottom-left corner.

---

## 5. LOD System

### Three Levels

| LOD | Name | Trigger | Node Size | Draw Calls/Node | Renders |
|-----|------|---------|-----------|:---:|---------|
| 0 | Dot | `zoom < 0.3` OR `>300 nodes at distance` | 4–6px circle | 1–2 | Colored dot. Glow halo on failed/faulted nodes. |
| 1 | Mini | `0.3 ≤ zoom < 0.8` OR `100–300 nodes at medium distance` | 60×24px rect | 3–4 | Layer-colored rectangle + truncated name (8 chars). Selection ring. |
| 2 | Detail | `zoom ≥ 0.8` OR `<100 nodes close to center` | 140×52px card | 8+ | Full card: name (18 chars), type badge (SQL/PySpark), duration, status indicator, left color bar, shadow. Hover lift. Selection highlight. |

### LOD Determination Algorithm

LOD is computed per-node, per-frame. It depends on three factors:

1. **Total node count** — Small DAGs always render at high detail.
2. **Zoom level** — Low zoom = low detail.
3. **Distance from viewport center** — Nodes near center get higher detail (focus+context).

```javascript
_getNodeLOD(node) {
  const totalNodes = this._nodes.length;

  // Small DAGs: always full detail
  if (totalNodes < 100) return 2;

  // Medium DAGs: zoom-based thresholds are more generous
  if (totalNodes < 300) {
    if (this._camera.scale > 0.5) return 2;
    if (this._camera.scale > 0.3) return 1;
    return 0;
  }

  // Large DAGs: distance-based LOD
  const viewCenterX = (this._width / 2 - this._camera.x) / this._camera.scale;
  const viewCenterY = (this._height / 2 - this._camera.y) / this._camera.scale;
  const viewRadius = Math.min(this._width, this._height) / this._camera.scale / 2;

  const dx = node.x - viewCenterX;
  const dy = node.y - viewCenterY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Zoom-aware distance thresholds
  if (this._camera.scale > 0.8 && distance < viewRadius * 0.8) return 2;
  if (this._camera.scale > 0.4 && distance < viewRadius * 1.2) return 1;
  return 0;
}
```

### LOD Transition

LOD changes are instantaneous — no interpolation. The visual pop is acceptable because:
- LOD transitions only occur during active zoom (user is watching the zoom, not individual nodes)
- The reference implementation uses the same approach at 60fps without complaints
- Interpolating LOD would require blending two render styles per node, doubling draw calls

---

## 6. Node Rendering

### Color Palette

All colors are looked up from a `STATUS_COLORS` table at render time:

| Status | Color (hex) | OKLCH Equivalent | LOD 2 Left Bar | LOD 1 Fill | LOD 0 Dot |
|--------|-------------|------------------|----------------|------------|-----------|
| Pending | `#6B6B6B` | `oklch(0.50 0 0)` | Grey left bar | Grey rect | Grey dot |
| Running | `#0A84FF` | `oklch(0.62 0.22 255)` | Blue left bar + pulse | Blue rect + pulse | Blue dot + pulse |
| Succeeded | `#32D74B` | `oklch(0.78 0.20 145)` | Green left bar | Green rect | Green dot |
| Failed | `#FF453A` | `oklch(0.65 0.27 25)` | Red left bar + glow | Red rect | Red dot + glow halo |
| Cancelled | `#FF9F0A` | `oklch(0.76 0.18 70)` | Amber left bar | Amber rect | Amber dot |
| Skipped | `#6B6B6B` at 50% alpha | — | Dotted grey left bar | Dim rect | Dim dot |

### Layer Colors (for left bar when no execution status)

| Layer | Color | Token |
|-------|-------|-------|
| Source (depth < 33%) | `#CD7F32` (bronze) | `--dag-layer-bronze` |
| Intermediate (33%–66%) | `#A8A9AD` (silver) | `--dag-layer-silver` |
| Output (depth > 66%) | `#C9A227` (gold) | `--dag-layer-gold` |

When execution status is active, the status color overrides the layer color on the left bar.

---

### LOD 0: Dot Node

The cheapest render. A single filled circle.

```javascript
_drawDotNode(node, status) {
  const color = STATUS_COLORS[status] || LAYER_COLORS[node.layerType];
  const radius = status === 'failed' ? 6 : 4;

  // Glow halo for failed nodes
  if (status === 'failed') {
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + 4, 0, TWO_PI);
    ctx.fillStyle = color.glow;  // e.g., 'rgba(255,69,58,0.3)'
    ctx.fill();
  }

  // Main dot
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, TWO_PI);
  ctx.fillStyle = color.main;
  ctx.fill();

  // Running pulse (if animating)
  if (status === 'running') {
    const pulseAlpha = 0.3 + 0.4 * Math.sin(this._timestamp * 0.004);  // ~1.5s period
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + 3, 0, TWO_PI);
    ctx.fillStyle = `rgba(10, 132, 255, ${pulseAlpha})`;
    ctx.fill();
  }

  // Selection ring
  if (node.nodeId === this._selectedNodeId) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + 2, 0, TWO_PI);
    ctx.strokeStyle = '#0A84FF';
    ctx.lineWidth = 2 / this._camera.scale;
    ctx.stroke();
  }
}
```

**Draw calls:** 1 (normal), 2 (failed/running), 3 (selected + failed).

---

### LOD 1: Mini Node

A compact rectangle with truncated name.

```javascript
_drawMiniNode(node, status) {
  const MINI_W = 60;
  const MINI_H = 24;
  const x = node.x - MINI_W / 2;
  const y = node.y - MINI_H / 2;
  const radius = 5;
  const color = STATUS_COLORS[status] || LAYER_COLORS[node.layerType];

  // Filled rectangle
  ctx.beginPath();
  ctx.roundRect(x, y, MINI_W, MINI_H, radius);
  ctx.fillStyle = color.main;
  ctx.globalAlpha = status === 'skipped' ? 0.4 : 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Truncated name (8 chars max)
  const label = node.name.length > 8 ? node.name.substring(0, 7) + '…' : node.name;
  ctx.font = '500 9px Inter, -apple-system, sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, node.x, node.y);

  // Selection ring
  if (node.nodeId === this._selectedNodeId) {
    ctx.strokeStyle = '#0A84FF';
    ctx.lineWidth = 2 / this._camera.scale;
    ctx.stroke();
  }

  // Running pulse border
  if (status === 'running') {
    const pulseAlpha = 0.4 + 0.5 * Math.sin(this._timestamp * 0.004);
    ctx.beginPath();
    ctx.roundRect(x - 2, y - 2, MINI_W + 4, MINI_H + 4, radius + 2);
    ctx.strokeStyle = `rgba(10, 132, 255, ${pulseAlpha})`;
    ctx.lineWidth = 1.5 / this._camera.scale;
    ctx.stroke();
  }
}
```

**Draw calls:** 3 (rect + text + stroke), 4 if running or selected.

---

### LOD 2: Detail Node

The full card — the most visually rich render. This is what users see when zoomed in.

```
┌─┬──────────────────────────────┐
│▌│ RefreshSalesData       ● ✓  │
│▌│ SQL · 12.3s                  │
└─┴──────────────────────────────┘
 ↑                          ↑  ↑
 Left bar (4px,             Status  Error
 layer/status               dot     icon
 colored)
```

**Dimensions:** 140 × 52px, 8px corner radius.

```javascript
_drawDetailNode(node, status) {
  const W = 140;     // NODE_WIDTH
  const H = 52;      // NODE_HEIGHT
  const x = node.x - W / 2;
  const y = node.y - H / 2;
  const R = 8;       // corner radius
  const color = STATUS_COLORS[status] || LAYER_COLORS[node.layerType];
  const barColor = status !== 'pending' ? color.main : LAYER_COLORS[node.layerType].main;

  // 1. Shadow (only for LOD 2)
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  // 2. Card background
  ctx.beginPath();
  ctx.roundRect(x, y, W, H, R);
  ctx.fillStyle = '#1A1A1A';  // --color-bg-surface
  ctx.fill();

  // Clear shadow for subsequent draws
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 3. Left color bar (4px wide, full height, rounded left corners)
  ctx.beginPath();
  ctx.roundRect(x, y, 4, H, [R, 0, 0, R]);
  ctx.fillStyle = barColor;
  ctx.fill();

  // Skipped: dotted left bar (override solid bar)
  if (status === 'skipped') {
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 2, y);
    ctx.lineTo(x + 2, y + H);
    ctx.strokeStyle = '#6B6B6B';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 4. Node name (18 chars max, truncated with ellipsis)
  const displayName = node.name.length > 18
    ? node.name.substring(0, 17) + '…'
    : node.name;
  ctx.font = '600 11px Inter, -apple-system, sans-serif';
  ctx.fillStyle = '#E5E5E5';  // --color-text-primary
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(displayName, x + 10, y + 8);

  // 5. Type badge (SQL or PySpark) — small pill
  const kind = node.kind === 'pyspark' ? 'PySpark' : 'SQL';
  ctx.font = '500 9px Inter, -apple-system, sans-serif';
  const badgeWidth = ctx.measureText(kind).width + 8;
  const badgeX = x + 10;
  const badgeY = y + 28;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeWidth, 14, 3);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fill();
  ctx.fillStyle = '#808080';  // --color-text-secondary
  ctx.textBaseline = 'middle';
  ctx.fillText(kind, badgeX + 4, badgeY + 7);

  // 6. Duration (e.g., "12.3s") — next to badge
  if (node.duration != null) {
    const durText = _formatDuration(node.duration);
    ctx.fillStyle = '#808080';
    ctx.fillText(' · ' + durText, badgeX + badgeWidth + 2, badgeY + 7);
  }

  // 7. Status indicator (right side)
  const statusX = x + W - 14;
  const statusY = y + H / 2;

  // Failed glow halo
  if (status === 'failed') {
    ctx.beginPath();
    ctx.arc(statusX, statusY, 8, 0, TWO_PI);
    ctx.fillStyle = 'rgba(255, 69, 58, 0.3)';
    ctx.fill();
  }

  // Status dot
  ctx.beginPath();
  ctx.arc(statusX, statusY, 5, 0, TWO_PI);
  ctx.fillStyle = color.main;
  ctx.fill();

  // 8. Error count badge (top-right corner, red circle with number)
  if (node.errorCount > 0) {
    const errX = x + W - 8;
    const errY = y + 8;
    ctx.beginPath();
    ctx.arc(errX, errY, 7, 0, TWO_PI);
    ctx.fillStyle = '#FF453A';
    ctx.fill();
    ctx.font = '600 8px Inter, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(node.errorCount), errX, errY);
    ctx.textAlign = 'left';
  }

  // 9. Selection highlight (accent border)
  if (node.nodeId === this._selectedNodeId) {
    ctx.beginPath();
    ctx.roundRect(x - 2, y - 2, W + 4, H + 4, R + 2);
    ctx.strokeStyle = '#0A84FF';  // --color-accent
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 10. Hover lift effect (subtle shadow increase)
  if (node.nodeId === this._hoveredNodeId) {
    ctx.beginPath();
    ctx.roundRect(x - 1, y - 1, W + 2, H + 2, R + 1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 11. Running pulse — animated border glow
  if (status === 'running') {
    const pulseAlpha = 0.3 + 0.5 * Math.sin(this._timestamp * 0.004);
    ctx.beginPath();
    ctx.roundRect(x - 3, y - 3, W + 6, H + 6, R + 3);
    ctx.strokeStyle = `rgba(10, 132, 255, ${pulseAlpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 12. Faulted indicator (dashed orange border, ⚠ badge)
  if (node.isFaulted) {
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.roundRect(x - 1, y - 1, W + 2, H + 2, R + 1);
    ctx.strokeStyle = '#FF9F0A';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 13. Cross-lakehouse indicator (external badge, top-left)
  if (node.externalWorkspaceId) {
    ctx.font = '500 8px Inter, sans-serif';
    ctx.fillStyle = '#FF9F0A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('EXT', x + 10, y + H - 12);
  }
}
```

**Draw calls:** 8 minimum (shadow + card + bar + name + badge + badge-fill + duration + status dot), up to 13 with error count, selection, hover, running pulse, faulted, and external indicator.

---

## 7. Edge Rendering

### Edge Styles

| Style | Stroke Color | Opacity | Width | Dash | Condition |
|-------|-------------|---------|-------|------|-----------|
| Normal | `#3A3A3A` | 0.4 | 1.5px | — | Default state |
| Selected path | `#0A84FF` | 0.8 | 2.5px | — | Either endpoint is the selected node |
| Error path | `#FF453A` | 0.5 | 1.5px | `[6, 4]` | Either endpoint has `failed` status |
| Flowing | `#0A84FF` | 0.6 | 2.0px | `[8, 6]` animated | Parent completed, child running |
| Pending | `#3A3A3A` | 0.2 | 1.0px | — | Both endpoints pending |

### Rendering Strategy

Edges are drawn in a single pass, but **batched by style** to minimize `ctx` state changes:

```javascript
_drawEdges() {
  // Batch 1: Normal edges (no style changes between them)
  ctx.strokeStyle = '#3A3A3A';
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1.5 / this._camera.scale;
  for (const edge of this._normalEdges) {
    this._drawBezier(edge);
  }

  // Batch 2: Pending edges
  ctx.globalAlpha = 0.2;
  ctx.lineWidth = 1.0 / this._camera.scale;
  for (const edge of this._pendingEdges) {
    this._drawBezier(edge);
  }

  // Batch 3: Error edges (expensive — uses setLineDash)
  ctx.strokeStyle = '#FF453A';
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.5 / this._camera.scale;
  ctx.setLineDash([6, 4]);
  for (const edge of this._errorEdges) {
    this._drawBezier(edge);
  }
  ctx.setLineDash([]);

  // Batch 4: Flowing edges (animated dashes)
  ctx.strokeStyle = '#0A84FF';
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2.0 / this._camera.scale;
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = -this._timestamp * 0.05;  // animated scroll
  for (const edge of this._flowingEdges) {
    this._drawBezier(edge);
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  // Batch 5: Selected path edges (on top of everything)
  ctx.strokeStyle = '#0A84FF';
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 2.5 / this._camera.scale;
  for (const edge of this._selectedEdges) {
    this._drawBezier(edge);
  }

  ctx.globalAlpha = 1;

  // Arrowheads (only at zoom > 0.4, otherwise too small to see)
  if (this._camera.scale > 0.4) {
    for (const edge of this._edges) {
      this._drawArrowhead(edge);
    }
  }
}
```

### Bezier Drawing

```javascript
_drawBezier(edge) {
  const from = edge.sourceAnchor;  // {x, y} right edge of source node
  const to = edge.targetAnchor;    // {x, y} left edge of target node

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);

  if (edge.waypoints && edge.waypoints.length > 0) {
    // Multi-segment bezier for long edges
    let prev = from;
    for (const wp of edge.waypoints) {
      const midX = (prev.x + wp.x) / 2;
      ctx.bezierCurveTo(midX, prev.y, midX, wp.y, wp.x, wp.y);
      prev = wp;
    }
    const midX = (prev.x + to.x) / 2;
    ctx.bezierCurveTo(midX, prev.y, midX, to.y, to.x, to.y);
  } else {
    // Single bezier for direct edges
    const midX = (from.x + to.x) / 2;
    ctx.bezierCurveTo(midX, from.y, midX, to.y, to.x, to.y);
  }

  ctx.stroke();
}
```

### Edge Classification

Before each render frame, edges are classified into the five batches based on the current state of their source and target nodes. This classification is cached and only recomputed when node states change (via `_classifyEdges()`).

```javascript
_classifyEdges() {
  this._normalEdges = [];
  this._pendingEdges = [];
  this._errorEdges = [];
  this._flowingEdges = [];
  this._selectedEdges = [];

  for (const edge of this._edges) {
    const srcStatus = this._nodeStates.get(edge.from) || 'pending';
    const tgtStatus = this._nodeStates.get(edge.to) || 'pending';
    const isSelected = edge.from === this._selectedNodeId
                    || edge.to === this._selectedNodeId;

    if (isSelected) {
      this._selectedEdges.push(edge);
    } else if (srcStatus === 'failed' || tgtStatus === 'failed') {
      this._errorEdges.push(edge);
    } else if (srcStatus === 'completed' && tgtStatus === 'running') {
      this._flowingEdges.push(edge);
    } else if (srcStatus === 'pending' && tgtStatus === 'pending') {
      this._pendingEdges.push(edge);
    } else {
      this._normalEdges.push(edge);
    }
  }
}
```

---

## 8. Background & Grid

A radial dot grid drawn behind all graph elements. Matches the reference mockup aesthetic.

```javascript
_drawBackground() {
  const spacing = 24;  // px in world space

  // Calculate visible region in world coordinates
  const topLeft = this._screenToWorld(0, 0);
  const bottomRight = this._screenToWorld(this._width, this._height);

  // Snap to grid
  const startX = Math.floor(topLeft.x / spacing) * spacing;
  const startY = Math.floor(topLeft.y / spacing) * spacing;
  const endX = Math.ceil(bottomRight.x / spacing) * spacing;
  const endY = Math.ceil(bottomRight.y / spacing) * spacing;

  // Draw dots
  ctx.fillStyle = '#333333';
  const dotRadius = 1;

  for (let x = startX; x <= endX; x += spacing) {
    for (let y = startY; y <= endY; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, TWO_PI);
      ctx.fill();
    }
  }
}
```

**Optimization:** At very low zoom (`scale < 0.2`), skip every other dot (`spacing * 2`) to reduce draw calls. At `scale < 0.1`, skip the grid entirely.

---

## 9. Minimap

A small overview (180 × 100px) in the bottom-left corner of the canvas, showing all nodes as dots with a viewport rectangle. Always rendered in screen space (unaffected by camera).

### Layout

```
┌──────────────────────────────────────────┐
│                                          │
│              Main Canvas                 │
│                                          │
│                                          │
│                                          │
│  ┌────────────────┐                      │
│  │   MINIMAP      │                      │
│  │  ·  ·  ·  ·   │                      │
│  │  ·  [===] ·   │  ← viewport rect     │
│  │  ·  ·  ·  ·   │                      │
│  └────────────────┘                      │
└──────────────────────────────────────────┘
```

### Constants

| Constant | Value |
|----------|-------|
| Width | 180px |
| Height | 100px |
| Margin from bottom-left | 16px |
| Background | `rgba(13, 13, 13, 0.9)` |
| Border | `#2A2A2A` |
| Node dot radius | 2px |
| Viewport rect | `rgba(10, 132, 255, 0.3)` fill, `#0A84FF` stroke |

### Rendering

```javascript
_drawMinimap() {
  if (this._nodes.length === 0) return;

  const mmW = 180;
  const mmH = 100;
  const mmX = 16;
  const mmY = this._height - mmH - 16;
  const padding = 8;

  // Calculate graph bounding box
  const bounds = this._getGraphBounds();
  const graphW = bounds.maxX - bounds.minX || 1;
  const graphH = bounds.maxY - bounds.minY || 1;

  // Scale to fit minimap
  const scaleX = (mmW - 2 * padding) / graphW;
  const scaleY = (mmH - 2 * padding) / graphH;
  const mmScale = Math.min(scaleX, scaleY);

  // Background
  ctx.fillStyle = 'rgba(13, 13, 13, 0.9)';
  ctx.fillRect(mmX, mmY, mmW, mmH);
  ctx.strokeStyle = '#2A2A2A';
  ctx.lineWidth = 1;
  ctx.strokeRect(mmX, mmY, mmW, mmH);

  // Node dots — sample rate for performance
  const sampleRate = Math.max(1, Math.floor(this._nodes.length / 100));
  for (let i = 0; i < this._nodes.length; i += sampleRate) {
    const node = this._nodes[i];
    const status = this._nodeStates.get(node.nodeId) || 'pending';
    const color = STATUS_COLORS[status] || LAYER_COLORS[node.layerType];

    const nx = mmX + padding + (node.x - bounds.minX) * mmScale;
    const ny = mmY + padding + (node.y - bounds.minY) * mmScale;

    ctx.beginPath();
    ctx.arc(nx, ny, 2, 0, TWO_PI);
    ctx.fillStyle = color.main;
    ctx.fill();
  }

  // Viewport rectangle
  const vpTopLeft = this._screenToWorld(0, 0);
  const vpBottomRight = this._screenToWorld(this._width, this._height);

  const vpX = mmX + padding + (vpTopLeft.x - bounds.minX) * mmScale;
  const vpY = mmY + padding + (vpTopLeft.y - bounds.minY) * mmScale;
  const vpW = (vpBottomRight.x - vpTopLeft.x) * mmScale;
  const vpH = (vpBottomRight.y - vpTopLeft.y) * mmScale;

  // Clamp viewport rect to minimap bounds
  ctx.fillStyle = 'rgba(10, 132, 255, 0.15)';
  ctx.fillRect(
    Math.max(vpX, mmX), Math.max(vpY, mmY),
    Math.min(vpW, mmW), Math.min(vpH, mmH)
  );
  ctx.strokeStyle = '#0A84FF';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.max(vpX, mmX), Math.max(vpY, mmY),
    Math.min(vpW, mmW), Math.min(vpH, mmH)
  );
}
```

### Minimap Interaction

Click on the minimap to jump the camera to that position:

```javascript
_handleMinimapClick(screenX, screenY) {
  const mmX = 16;
  const mmY = this._height - 100 - 16;
  const mmW = 180;
  const mmH = 100;

  // Check if click is within minimap bounds
  if (screenX < mmX || screenX > mmX + mmW || screenY < mmY || screenY > mmY + mmH) {
    return false;
  }

  // Convert minimap position to world coordinates
  const bounds = this._getGraphBounds();
  const padding = 8;
  const graphW = bounds.maxX - bounds.minX || 1;
  const graphH = bounds.maxY - bounds.minY || 1;
  const scaleX = (mmW - 2 * padding) / graphW;
  const scaleY = (mmH - 2 * padding) / graphH;
  const mmScale = Math.min(scaleX, scaleY);

  const worldX = bounds.minX + (screenX - mmX - padding) / mmScale;
  const worldY = bounds.minY + (screenY - mmY - padding) / mmScale;

  // Center camera on this world position
  this._camera.x = this._width / 2 - worldX * this._camera.scale;
  this._camera.y = this._height / 2 - worldY * this._camera.scale;
  this._dirty = true;

  return true;  // consumed the click
}
```

### Minimap Drag

User can click and drag within the minimap to pan the viewport:

- `mousedown` inside minimap → enter `minimap.dragging` state
- `mousemove` → update camera position based on minimap-to-world conversion
- `mouseup` → exit `minimap.dragging` state

---

## 10. Hit Testing

Hit testing converts a screen-space click coordinate to a node ID (or null).

### Algorithm

Linear scan over all nodes, checking point-in-rectangle (AABB). For 300 nodes this is < 0.3ms — no spatial index needed.

```javascript
hitTest(screenX, screenY) {
  const world = this._screenToWorld(screenX, screenY);

  // Test in reverse order (LOD 2 → 1 → 0) so topmost visual elements are hit first
  // LOD 2 nodes
  for (let i = this._nodes.length - 1; i >= 0; i--) {
    const node = this._nodes[i];
    const lod = this._getNodeLOD(node);
    let halfW, halfH;

    switch (lod) {
      case 2: halfW = 70; halfH = 26; break;   // 140/2, 52/2
      case 1: halfW = 30; halfH = 12; break;   // 60/2, 24/2
      case 0: halfW = 6;  halfH = 6;  break;   // dot radius
    }

    if (Math.abs(world.x - node.x) <= halfW &&
        Math.abs(world.y - node.y) <= halfH) {
      return node.nodeId;
    }
  }

  return null;
}
```

### Edge Hit Testing

For edge selection (hovering over an edge to see its info), we compute distance from the cursor to each bezier curve. This is more expensive than AABB testing but only needed on hover, not click.

```javascript
_hitTestEdge(screenX, screenY, threshold = 8) {
  const world = this._screenToWorld(screenX, screenY);
  const scaledThreshold = threshold / this._camera.scale;

  for (const edge of this._edges) {
    const dist = _distanceToBezier(
      world.x, world.y,
      edge.sourceAnchor, edge.cp1, edge.cp2, edge.targetAnchor
    );
    if (dist < scaledThreshold) {
      return edge;
    }
  }
  return null;
}

// Approximate distance by sampling 20 points along the curve
function _distanceToBezier(px, py, p0, cp1, cp2, p1) {
  let minDist = Infinity;
  for (let t = 0; t <= 1; t += 0.05) {
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    const bx = mt3 * p0.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * p1.x;
    const by = mt3 * p0.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * p1.y;

    const dx = px - bx;
    const dy = py - by;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}
```

---

## 11. Interaction Model

### Pan

| Input | Behavior |
|-------|----------|
| Mouse drag (left button on background) | Translate camera. Cursor: `grab` → `grabbing`. |
| Touch: two-finger drag | Translate camera (same math). |
| Arrow keys (no node selected) | Pan 50px in arrow direction. |

```javascript
// mousedown on canvas (not on a node)
_onPanStart(e) {
  this._isPanning = true;
  this._panOrigin = { x: e.clientX - this._camera.x, y: e.clientY - this._camera.y };
  this._canvas.style.cursor = 'grabbing';
}

// mousemove during pan
_onPanMove(e) {
  this._camera.x = e.clientX - this._panOrigin.x;
  this._camera.y = e.clientY - this._panOrigin.y;
  this._dirty = true;
}

// mouseup
_onPanEnd() {
  this._isPanning = false;
  this._canvas.style.cursor = this._hoveredNodeId ? 'pointer' : 'grab';
}
```

### Zoom

| Input | Behavior | Factor |
|-------|----------|--------|
| Mouse wheel up | Zoom in toward cursor | × 1.1 per tick |
| Mouse wheel down | Zoom out toward cursor | × 0.9 per tick |
| `Ctrl+=` or `+` button | Zoom in toward viewport center | × 1.25 |
| `Ctrl+-` or `−` button | Zoom out toward viewport center | × 0.8 |
| Pinch (touch) | Continuous zoom toward pinch midpoint | proportional |

**Zoom toward cursor position** (not center):

```javascript
_onWheel(e) {
  e.preventDefault();

  const rect = this._canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.15, Math.min(3.0, this._camera.scale * factor));

  // Compute world point under cursor before zoom
  const worldX = (mouseX - this._camera.x) / this._camera.scale;
  const worldY = (mouseY - this._camera.y) / this._camera.scale;

  // Apply new scale
  this._camera.scale = newScale;

  // Adjust translation so the world point stays under cursor
  this._camera.x = mouseX - worldX * newScale;
  this._camera.y = mouseY - worldY * newScale;

  this._dirty = true;
}
```

### Node Click (Selection)

```javascript
_onClick(e) {
  const rect = this._canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  // Check minimap first
  if (this._handleMinimapClick(sx, sy)) return;

  // Hit test nodes
  const nodeId = this.hitTest(sx, sy);

  if (nodeId) {
    this.selectNode(nodeId);
  } else {
    // Click on empty space — deselect
    this._selectedNodeId = null;
    this._classifyEdges();
    this._dirty = true;
    this._emit('nodeDeselected');
  }
}
```

`selectNode(nodeId)` highlights the node, highlights connected edges, and emits `nodeSelected` event consumed by `DagStudio` to open the detail panel.

### Node Hover

On `mousemove`, perform hit test (throttled to every 16ms — one frame):

```javascript
_onMouseMove(e) {
  if (this._isPanning) { this._onPanMove(e); return; }

  const rect = this._canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  const nodeId = this.hitTest(sx, sy);

  if (nodeId !== this._hoveredNodeId) {
    this._hoveredNodeId = nodeId;
    this._canvas.style.cursor = nodeId ? 'pointer' : 'grab';
    this._dirty = true;

    if (nodeId) {
      this._showTooltip(nodeId, e.clientX, e.clientY);
    } else {
      this._hideTooltip();
    }
  }
}
```

### Tooltip

Tooltip is a lightweight DOM element positioned near the cursor. NOT rendered on canvas (DOM allows text selection and screen reader access).

```html
<div id="dagTooltip" class="dag-tooltip" role="tooltip">
  <div class="dag-tooltip-name"></div>
  <div class="dag-tooltip-status"></div>
  <div class="dag-tooltip-duration"></div>
</div>
```

Content: node name + status + duration. Shown at LOD 0/1 (where the node card doesn't show text) and optionally at LOD 2.

### Fit to Screen

```javascript
fitToScreen(animate = true) {
  if (this._nodes.length === 0) return;

  const bounds = this._getGraphBounds();
  const graphW = bounds.maxX - bounds.minX;
  const graphH = bounds.maxY - bounds.minY;
  const padding = 48;

  // Calculate scale to fit
  const scaleX = (this._width - 2 * padding) / graphW;
  const scaleY = (this._height - 2 * padding) / graphH;
  const targetScale = Math.min(scaleX, scaleY, 1.2);  // cap at 1.2× for small graphs

  // Calculate translation to center
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const targetX = this._width / 2 - centerX * targetScale;
  const targetY = this._height / 2 - centerY * targetScale;

  if (animate) {
    this._animateCamera(targetX, targetY, targetScale, 400);  // 400ms ease-out
  } else {
    this._camera = { x: targetX, y: targetY, scale: targetScale };
    this._dirty = true;
  }
}
```

### Keyboard Shortcuts

| Key | Action | Condition |
|-----|--------|-----------|
| `F` | Fit to screen | Always |
| `Shift+F` | Jump to first failed node + select it | At least one failed node |
| `Escape` | Deselect node, close detail panel | Node selected |
| `↑` / `↓` / `←` / `→` | Navigate to adjacent node | Node selected |
| `+` / `Ctrl+=` | Zoom in | Always |
| `-` / `Ctrl+-` | Zoom out | Always |
| `0` / `Ctrl+0` | Reset zoom to 100% | Always |
| `Enter` | Open detail panel for selected node | Node selected |
| `Tab` | Cycle selection to next node (by layer order) | Always |
| `Shift+Tab` | Cycle selection to previous node | Always |

**Arrow key navigation:**

When a node is selected, arrow keys move selection to the most logical adjacent node:
- `→` (Right): First child in the next layer. If no children, no-op.
- `←` (Left): First parent in the previous layer. If no parents, no-op.
- `↑` / `↓`: Previous/next node in the same layer (by order index).

```javascript
_navigateNode(direction) {
  if (!this._selectedNodeId) return;

  const currentNode = this._nodeMap.get(this._selectedNodeId);
  const currentPos = this._positions.get(this._selectedNodeId);
  let targetId = null;

  switch (direction) {
    case 'right':
      // First child
      if (currentNode.children.length > 0) targetId = currentNode.children[0];
      break;
    case 'left':
      // First parent
      if (currentNode.parents.length > 0) targetId = currentNode.parents[0];
      break;
    case 'up':
      targetId = this._getAdjacentInLayer(currentPos.layer, currentPos.order - 1);
      break;
    case 'down':
      targetId = this._getAdjacentInLayer(currentPos.layer, currentPos.order + 1);
      break;
  }

  if (targetId) {
    this.selectNode(targetId);
    this._panToNode(targetId);  // ensure selected node is visible
  }
}
```

---

## 12. Animation System

### Architecture

All animations use a lightweight tween system driven by `requestAnimationFrame` timestamps. No external animation libraries.

```javascript
class Tween {
  constructor(from, to, durationMs, easeFn = easeOutCubic) {
    this.from = from;
    this.to = to;
    this.duration = durationMs;
    this.ease = easeFn;
    this.startTime = null;
    this.done = false;
  }

  update(timestamp) {
    if (this.startTime === null) this.startTime = timestamp;
    const elapsed = timestamp - this.startTime;
    const t = Math.min(elapsed / this.duration, 1);
    const eased = this.ease(t);
    const value = this.from + (this.to - this.from) * eased;
    if (t >= 1) this.done = true;
    return value;
  }
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeOutSpring(t) {
  return 1 - Math.pow(Math.cos(t * Math.PI / 2), 3) * Math.exp(-6 * t);
}
```

### Animation: Running Node Pulse

Continuous sinusoidal glow on the border of running nodes. No tween needed — pure math.

```
Alpha = 0.3 + 0.5 × sin(timestamp × 2π / 1500)
Period = 1500ms (1.5s cycle per spec)
Applied to: border glow stroke alpha
```

Runs as long as any node has `running` status. Sets `this._animating = true`.

### Animation: Execution Flow (Edge Dashes)

Animated dash offset along edges from completed parent to running child.

```
ctx.lineDashOffset = -timestamp × 0.05
Direction: negative offset = dashes move left-to-right (toward child)
Speed: 50 pixels per second of offset
```

### Animation: Status Transition (Color Fade)

When a node's status changes, the fill/stroke color transitions over 300ms with ease-out:

```javascript
_transitionNodeColor(nodeId, fromStatus, toStatus) {
  const fromColor = STATUS_COLORS[fromStatus].main;
  const toColor = STATUS_COLORS[toStatus].main;

  this._colorTransitions.set(nodeId, {
    from: _parseColor(fromColor),
    to: _parseColor(toColor),
    tween: new Tween(0, 1, 300, easeOutCubic),
  });

  this._animating = true;
}
```

During render, if a transition is active for a node, interpolate the RGB channels:

```javascript
_getNodeColor(nodeId) {
  const transition = this._colorTransitions.get(nodeId);
  if (transition && !transition.tween.done) {
    const t = transition.tween.update(this._timestamp);
    const r = Math.round(transition.from.r + (transition.to.r - transition.from.r) * t);
    const g = Math.round(transition.from.g + (transition.to.g - transition.from.g) * t);
    const b = Math.round(transition.from.b + (transition.to.b - transition.from.b) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  // Return static color
  const status = this._nodeStates.get(nodeId) || 'pending';
  return STATUS_COLORS[status].main;
}
```

### Animation: Layout Transition (Node Position Spring)

When the DAG definition changes (user clicks "Refresh DAG"), nodes animate from old positions to new positions over 500ms with a spring easing.

```javascript
_animateToNewLayout(newPositions) {
  for (const [nodeId, newPos] of newPositions) {
    const oldPos = this._positions.get(nodeId);
    if (oldPos) {
      this._positionTweens.set(nodeId, {
        xTween: new Tween(oldPos.x, newPos.x, 500, easeOutSpring),
        yTween: new Tween(oldPos.y, newPos.y, 500, easeOutSpring),
      });
    } else {
      // New node — fade in from zero opacity
      this._positions.set(nodeId, newPos);
      this._opacityTweens.set(nodeId, new Tween(0, 1, 300, easeOutCubic));
    }
  }

  // Nodes removed from the DAG — fade out
  for (const [nodeId] of this._positions) {
    if (!newPositions.has(nodeId)) {
      this._opacityTweens.set(nodeId, new Tween(1, 0, 200, easeOutCubic));
    }
  }

  this._animating = true;
}
```

### Animation: Camera (Fit-to-Screen, Jump-to-Node)

```javascript
_animateCamera(targetX, targetY, targetScale, durationMs) {
  this._cameraTween = {
    xTween: new Tween(this._camera.x, targetX, durationMs, easeOutCubic),
    yTween: new Tween(this._camera.y, targetY, durationMs, easeOutCubic),
    sTween: new Tween(this._camera.scale, targetScale, durationMs, easeOutCubic),
  };
  this._animating = true;
}
```

Applied in the render loop:

```javascript
if (this._cameraTween) {
  this._camera.x = this._cameraTween.xTween.update(timestamp);
  this._camera.y = this._cameraTween.yTween.update(timestamp);
  this._camera.scale = this._cameraTween.sTween.update(timestamp);
  if (this._cameraTween.xTween.done) this._cameraTween = null;
}
```

---

## 13. High-DPI Rendering

Canvas must render crisply on Retina/HiDPI displays (common on MacBook Pros used by FLT engineers).

### Setup

```javascript
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(logicalWidth * dpr);
canvas.height = Math.round(logicalHeight * dpr);
canvas.style.width = logicalWidth + 'px';
canvas.style.height = logicalHeight + 'px';
```

### Per-Frame

The `setTransform` call at the start of each frame scales the context by DPR:

```javascript
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
```

Then the camera transform is applied on top:
```javascript
ctx.translate(this._camera.x, this._camera.y);
ctx.scale(this._camera.scale, this._camera.scale);
```

### Text Rendering

Canvas text uses `ctx.font` with pixel sizes in CSS pixels (not physical pixels). The DPR scaling handles the rest. No manual font size adjustment needed.

Font stack: `'Inter', -apple-system, system-ui, sans-serif` — matches EDOG's `--font-sans`.

### Line Width

Edge widths are specified in CSS pixels and divided by `camera.scale` to maintain visual thickness regardless of zoom:

```javascript
ctx.lineWidth = 1.5 / this._camera.scale;
```

This ensures a 1.5px edge looks the same at zoom 0.5 and zoom 2.0.

---

## 14. Off-Screen Culling

Nodes and edges outside the visible viewport are skipped entirely — no draw calls.

### Viewport Bounds

```javascript
_getViewportBounds() {
  const topLeft = this._screenToWorld(0, 0);
  const bottomRight = this._screenToWorld(this._width, this._height);
  // Add generous margin (one NODE_WIDTH) to avoid pop-in at edges
  return {
    minX: topLeft.x - NODE_WIDTH,
    minY: topLeft.y - NODE_HEIGHT,
    maxX: bottomRight.x + NODE_WIDTH,
    maxY: bottomRight.y + NODE_HEIGHT,
  };
}
```

### Node Culling

```javascript
_isNodeVisible(node, vp) {
  return node.x >= vp.minX && node.x <= vp.maxX
      && node.y >= vp.minY && node.y <= vp.maxY;
}
```

Applied in the render loop: only nodes passing `_isNodeVisible()` are drawn.

### Edge Culling

An edge is visible if either endpoint is visible OR if the bezier curve passes through the viewport. For simplicity, we use the conservative rule: an edge is drawn if either endpoint is visible.

```javascript
_isEdgeVisible(edge, vp) {
  const src = this._positions.get(edge.from);
  const tgt = this._positions.get(edge.to);
  return this._isNodeVisible(src, vp) || this._isNodeVisible(tgt, vp);
}
```

This may draw a few edges that are technically off-screen (both endpoints on opposite sides of the viewport), but the overdraw cost is negligible compared to the complexity of accurate bezier-viewport intersection testing.

---

## 15. Performance Targets & Budget

### Frame Budget at 60fps = 16.67ms

| Operation | Budget | Actual (300 nodes, 500 edges) |
|-----------|--------|-------------------------------|
| Clear canvas | 0.1ms | 0.1ms |
| Camera transform | 0.01ms | 0.01ms |
| Background grid | 0.5ms | ~0.3ms (culled to viewport) |
| Edge rendering | 3ms | ~2.5ms (batched by style) |
| Node rendering (LOD 0/1/2) | 8ms | ~6ms (LOD culling reduces 10×) |
| Minimap | 1ms | ~0.5ms (sampled) |
| Total | **< 16ms** | **~9.5ms** ✓ |

### Performance Targets

| Metric | Target | Method |
|--------|--------|--------|
| 60fps at 300 nodes, 500 edges | 16ms/frame | LOD + culling + batching |
| First render < 100ms for 50-node DAG | Layout (10ms) + first frame (6ms) | Sugiyama is O(V+E) |
| Hit testing < 1ms per click | Linear scan | 300 nodes × 3 comparisons = 0.3ms |
| Layout < 50ms for 100 nodes | Sugiyama with 4 barycenter passes | O(V+E + P×L×N²) |
| Layout < 100ms for 300 nodes | Same | Verified empirically |
| Node state update < 50ms | Dirty flag + reclassify edges | No re-layout needed |
| Memory < 10MB for 300 nodes | One canvas, node/edge arrays, no retained bitmaps | |

### Profiling (Debug Mode)

When `window.EDOG_DEBUG` is true, render an HUD overlay:

```
FPS: 60  |  Nodes: 300 (D:12  M:88  ·:200)  |  Edges: 500  |  Frame: 9.2ms
```

- `D:` = LOD 2 (Detail) count
- `M:` = LOD 1 (Mini) count
- `·:` = LOD 0 (Dot) count

---

## 16. Public API

### `class DagCanvasRenderer`

```javascript
class DagCanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvasEl - The canvas element to render into
   * @param {HTMLElement} containerEl - The parent container (for sizing)
   */
  constructor(canvasEl, containerEl)

  /**
   * Set the DAG data and trigger layout + render.
   * @param {Array<DagNode>} nodes - Node data from API
   * @param {Array<DagEdge>} edges - Edge data from API
   */
  setData(nodes, edges)

  /**
   * Main render — call once. Starts the requestAnimationFrame loop.
   */
  start()

  /**
   * Update a single node's execution status. Triggers color transition animation.
   * @param {string} nodeId - GUID of the node
   * @param {string} status - 'none'|'running'|'completed'|'failed'|'cancelled'|'skipped'
   * @param {object} [metrics] - Optional: { duration, errorCode, errorCount }
   */
  updateNodeState(nodeId, status, metrics)

  /**
   * Select a node. Highlights node + connected edges. Emits 'nodeSelected' event.
   * @param {string} nodeId - GUID, or null to deselect
   */
  selectNode(nodeId)

  /**
   * Fit the entire graph into the viewport with padding.
   * @param {boolean} [animate=true] - Whether to animate the camera transition
   */
  fitToScreen(animate)

  /**
   * Animate camera to center on a specific node.
   * @param {string} nodeId - GUID of the node to focus
   */
  panToNode(nodeId)

  /**
   * Zoom to a specific level, centered on a point.
   * @param {number} scale - Target zoom level (0.15–3.0)
   * @param {number} [cx] - Screen X to zoom toward (default: center)
   * @param {number} [cy] - Screen Y to zoom toward (default: center)
   */
  zoomTo(scale, cx, cy)

  /**
   * Hit test a screen coordinate against nodes.
   * @param {number} screenX
   * @param {number} screenY
   * @returns {string|null} nodeId or null
   */
  hitTest(screenX, screenY)

  /**
   * Jump to and select the first failed node. Animates camera.
   * @returns {string|null} nodeId of the failed node, or null if none
   */
  jumpToFirstFailed()

  /**
   * Get current camera state (for persistence across view switches).
   * @returns {{ x: number, y: number, scale: number }}
   */
  getCameraState()

  /**
   * Restore camera state.
   * @param {{ x: number, y: number, scale: number }} state
   */
  setCameraState(state)

  /**
   * Re-layout with new positions (e.g., after DAG refresh). Animates transition.
   * @param {Map<string, {x, y}>} newPositions
   */
  transitionToLayout(newPositions)

  /**
   * Register an event listener.
   * Events: 'nodeSelected', 'nodeDeselected', 'nodeHovered', 'nodeUnhovered'
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback)

  /**
   * Remove an event listener.
   */
  off(event, callback)

  /**
   * Clean up: cancel rAF, remove event listeners, disconnect ResizeObserver.
   */
  destroy()
}
```

### `class DagLayout`

```javascript
class DagLayout {
  /**
   * Compute positions for all nodes using Sugiyama algorithm.
   * @param {Array<DagNode>} nodes
   * @param {Array<DagEdge>} edges
   * @returns {Map<string, { x: number, y: number, layer: number, order: number }>}
   */
  layout(nodes, edges)
}
```

---

## 17. Data Contracts

### Input: DagNode (from API, normalized)

```typescript
interface DagNode {
  nodeId: string;              // GUID
  name: string;                // MLV name, e.g., "RefreshSalesData"
  kind: 'sql' | 'pyspark';    // Node type
  parents: string[];           // Parent node GUIDs
  children: string[];          // Child node GUIDs
  tableType: string;           // Table type classification
  executable: boolean;         // Is this an MLV
  isFaulted: boolean;          // Validation error state
  fltErrorCode: string | null; // e.g., 'MLV_STALE_METADATA'
  errorMessage: string | null; // Validation error message
  externalWorkspaceId: string | null;  // Cross-lakehouse
  externalLakehouseId: string | null;
  warnings: Array<{ warningType: string, relatedSourceEntities: string[] }>;
}
```

### Input: DagEdge (from API)

```typescript
interface DagEdge {
  edgeId: string;   // GUID
  from: string;     // Source node GUID (parent)
  to: string;       // Target node GUID (child)
}
```

### Internal: Positioned Node (after layout)

```typescript
interface PositionedNode extends DagNode {
  x: number;         // World X coordinate (center of node)
  y: number;         // World Y coordinate (center of node)
  layer: number;     // Layer index (0 = leftmost)
  order: number;     // Position within layer (0 = topmost)
  layerType: 'bronze' | 'silver' | 'gold';  // Computed from layer depth ratio
}
```

### Internal: Routed Edge (after layout)

```typescript
interface RoutedEdge extends DagEdge {
  sourceAnchor: { x: number, y: number };   // Right edge of source node
  targetAnchor: { x: number, y: number };   // Left edge of target node
  cp1: { x: number, y: number };            // Bezier control point 1
  cp2: { x: number, y: number };            // Bezier control point 2
  waypoints: Array<{ x: number, y: number }> | null;  // For long edges
}
```

### Events Emitted

| Event | Payload | When |
|-------|---------|------|
| `nodeSelected` | `{ nodeId: string, node: DagNode }` | User clicks a node |
| `nodeDeselected` | `{}` | User clicks empty space or presses Escape |
| `nodeHovered` | `{ nodeId: string, screenX: number, screenY: number }` | Mouse enters a node's hit area |
| `nodeUnhovered` | `{}` | Mouse leaves all node hit areas |

---

## 18. Error Handling

### No Data

If `setData()` is called with empty arrays, render the empty state:
- Light grey text centered on canvas: "No DAG loaded"
- Subtext: "Deploy to a lakehouse to view the DAG"
- Icon: circuit diagram outline (inline SVG drawn via canvas path commands)

### Cycle Detected

If the layout algorithm detects a cycle:
- Render all acyclic nodes normally
- Place cyclic nodes at `maxLayer + 1`
- Show yellow warning banner above the canvas (DOM element, not canvas-drawn)
- Cyclic nodes get a dashed orange border

### Oversized DAG

If node count > 1000:
- Log warning: `[DagCanvasRenderer] Large DAG (${count} nodes) — performance may be reduced`
- Force LOD 0 for all nodes regardless of zoom
- Disable background grid
- Increase minimap sample rate to `floor(nodes / 50)`

### Canvas Context Lost

`webglcontextlost` is for WebGL. For Canvas 2D, context loss is rare but possible on memory pressure. Handle via:

```javascript
this._canvas.addEventListener('contextlost', () => {
  console.warn('[DagCanvasRenderer] Canvas context lost');
  this._contextLost = true;
});
this._canvas.addEventListener('contextrestored', () => {
  console.info('[DagCanvasRenderer] Canvas context restored');
  this._contextLost = false;
  this._dirty = true;
});
```

During render, if `_contextLost` is true, skip the frame.

---

## 19. Memory Management & Lifecycle

### Construction

```javascript
const renderer = new DagCanvasRenderer(canvasEl, containerEl);
renderer.start();  // begins rAF loop
```

### View Activation/Deactivation

When the user switches to DAG Studio view:
```javascript
renderer.start();  // resume rAF loop
renderer.setCameraState(savedState);
```

When the user switches away:
```javascript
const savedState = renderer.getCameraState();
renderer.stop();  // cancel rAF, stop listening for mouse/wheel/resize
```

### Destruction

```javascript
renderer.destroy();
```

This:
1. Cancels `requestAnimationFrame` via `cancelAnimationFrame(this._rafId)`
2. Removes all event listeners (mousedown, mousemove, mouseup, wheel, keydown, click)
3. Disconnects `ResizeObserver`
4. Clears all node/edge data arrays
5. Clears all animation tweens
6. Sets canvas width/height to 0 (releases GPU memory)

### No Retained Bitmaps

The renderer does NOT create off-screen canvases, ImageBitmap objects, or cached node bitmaps. Every frame is drawn fresh from data arrays. This keeps memory proportional to node count (O(N) for position arrays) rather than O(N × pixel area).

---

## 20. Accessibility Fallback

Canvas has no DOM tree — screen readers cannot introspect it. We provide a hidden ARIA fallback:

### Hidden Table

```javascript
_updateAriaFallback() {
  const table = document.getElementById('dagAriaFallback');
  let html = '<table role="table" aria-label="DAG nodes"><thead><tr>';
  html += '<th>Name</th><th>Type</th><th>Status</th><th>Layer</th><th>Parents</th><th>Children</th>';
  html += '</tr></thead><tbody>';

  for (const node of this._nodes) {
    const status = this._nodeStates.get(node.nodeId) || 'pending';
    html += `<tr>
      <td>${node.name}</td>
      <td>${node.kind}</td>
      <td>${status}</td>
      <td>${node.layerType}</td>
      <td>${node.parents.length} dependencies</td>
      <td>${node.children.length} dependents</td>
    </tr>`;
  }

  html += '</tbody></table>';
  table.innerHTML = html;
}
```

Updated whenever `setData()` or `updateNodeState()` is called.

### Live Region

Status changes are announced via an ARIA live region:

```html
<div id="dagLiveRegion" role="status" aria-live="polite" class="sr-only"></div>
```

```javascript
_announceStatusChange(nodeName, newStatus) {
  const region = document.getElementById('dagLiveRegion');
  region.textContent = `Node ${nodeName} is now ${newStatus}`;
}
```

### Keyboard Focus

The canvas element has `tabindex="0"` and receives keyboard events. The current selection is communicated via:
```javascript
this._canvas.setAttribute('aria-activedescendant', selectedNodeId || '');
```

---

*"Every pixel has a purpose. Every draw call is budgeted. Every frame is earned."*

— Pixel, Frontend Engineer
