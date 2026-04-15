# DAG Graph Canvas — State Matrix

> **Component:** `DagCanvasRenderer`
> **Owner:** Pixel (Frontend Engineer)
> **Total states:** 26
> **Companion:** `components/graph-canvas.md` (rendering spec)
> **Status:** SPEC COMPLETE

---

## Table of Contents

1. [Graph Lifecycle States](#1-graph-lifecycle-states) (5 states)
2. [Camera Interaction States](#2-camera-interaction-states) (4 states)
3. [Node Visual States](#3-node-visual-states) (8 states)
4. [Edge Visual States](#4-edge-visual-states) (4 states)
5. [Execution Overlay States](#5-execution-overlay-states) (3 states)
6. [Minimap States](#6-minimap-states) (2 states)
7. [State Transition Diagram](#7-state-transition-diagram)
8. [Compound State Rules](#8-compound-state-rules)

---

## Legend

Each state entry follows this structure:

| Field | Description |
|-------|-------------|
| **ID** | Unique state identifier (dot-separated hierarchy) |
| **Entry conditions** | What triggers entry into this state |
| **Exit conditions** | What triggers exit from this state |
| **Visual** | What the user sees on the canvas |
| **Canvas commands** | Key `ctx` calls that produce the visual |
| **Keyboard** | Active keyboard shortcuts in this state |
| **Data requirements** | What data must be present for this state |
| **Transitions** | Where this state can go next, with triggers |

---

## 1. Graph Lifecycle States

These are mutually exclusive — the graph is always in exactly one lifecycle state.

---

### State: `graph.empty`

The default state when DAG Studio first opens or when no DAG data is available.

| Field | Value |
|-------|-------|
| **ID** | `graph.empty` |
| **Entry conditions** | (1) Component constructed, no `setData()` called yet. (2) `setData()` called with empty node array. (3) API returns 404 — lakehouse has no DAG. |
| **Exit conditions** | `setData()` called with non-empty node/edge arrays → transitions to `graph.loaded`. API call initiated → transitions to `graph.loading`. |
| **Visual** | Empty canvas with background dot grid. Centered placeholder: light grey circuit-diagram outline icon (64×64px). Below icon: "No DAG loaded" in `--color-text-secondary` (14px, 600 weight). Below that: "Deploy to a lakehouse to view the DAG" in `--color-text-tertiary` (12px, 400 weight). Minimap hidden. Zoom controls visible but disabled (greyed out). |
| **Canvas commands** | `ctx.fillRect(0, 0, w, h)` with `#0D0D0D` background. Draw dot grid. Draw icon via path commands centered at `(w/2, h/2 - 40)`. `ctx.fillText('No DAG loaded', w/2, h/2 + 20)`. `ctx.fillText('Deploy to a lakehouse...', w/2, h/2 + 40)`. |
| **Keyboard** | `F` — no-op (nothing to fit). `Ctrl+K` — command palette (handled by parent). |
| **Data requirements** | None. |
| **Transitions** | → `graph.loading` (API fetch initiated) · → `graph.loaded` (data provided via `setData()`) |

---

### State: `graph.loading`

DAG data is being fetched from the FLT API.

| Field | Value |
|-------|-------|
| **ID** | `graph.loading` |
| **Entry conditions** | `DagStudio._loadDag()` initiated → `GET /liveTable/getLatestDag?showExtendedLineage=true` in flight. |
| **Exit conditions** | API response received (success → `graph.loaded`, error → `graph.error`). |
| **Visual** | Canvas shows a skeleton loading state: 8 grey placeholder rectangles (80×32px, `#1A1A1A` fill, 0.5 opacity) arranged in a 3-layer Sugiyama-like layout (2-3-3 pattern). Grey placeholder bezier curves connecting them. All elements pulse with a shimmer animation (opacity oscillates 0.3–0.6 over 1.5s). Text below skeleton: "Loading DAG..." in `--color-text-secondary`. Minimap hidden. Zoom controls disabled. |
| **Canvas commands** | For each placeholder rect: `ctx.beginPath(); ctx.roundRect(x, y, 80, 32, 6); ctx.fillStyle = 'rgba(26,26,26,shimmerAlpha)'; ctx.fill();`. Shimmer: `shimmerAlpha = 0.3 + 0.3 * Math.sin(timestamp * 0.003)`. Placeholder edges: `ctx.beginPath(); ctx.moveTo(...); ctx.bezierCurveTo(...); ctx.strokeStyle = 'rgba(58,58,58,shimmerAlpha)'; ctx.stroke();` |
| **Keyboard** | `Escape` — cancel fetch (if supported by API client). |
| **Data requirements** | None. Previous camera state is preserved if transitioning from `graph.loaded`. |
| **Transitions** | → `graph.loaded` (API success + layout computed) · → `graph.error` (API failure) · → `graph.empty` (API returns empty DAG) |

---

### State: `graph.loaded`

DAG is rendered and idle. This is the primary operating state — the user sees the full interactive graph.

| Field | Value |
|-------|-------|
| **ID** | `graph.loaded` |
| **Entry conditions** | `setData()` called with valid nodes/edges. Layout computed by `DagLayout.layout()`. First frame rendered. |
| **Exit conditions** | Never exits to a different lifecycle state unless data is cleared (`graph.empty`) or re-fetched (`graph.loading`). Sub-states (camera, node, edge states) are active concurrently within `graph.loaded`. |
| **Visual** | Full DAG graph rendered: nodes at LOD 0/1/2 based on zoom and distance, edges as bezier curves, background dot grid, minimap in bottom-left. Cursor is `grab` on empty space, `pointer` on nodes. |
| **Canvas commands** | Full render pipeline per `components/graph-canvas.md` Section 4: clear → camera transform → grid → edges (5 batches) → nodes (3 LOD passes) → minimap → HUD. |
| **Keyboard** | `F` — fit to screen. `Shift+F` — jump to first failed node. `Escape` — deselect. `↑↓←→` — navigate nodes (if one is selected). `+/-` — zoom in/out. `Tab/Shift+Tab` — cycle node selection. `Enter` — open detail panel for selected node. |
| **Data requirements** | `this._nodes` (PositionedNode[]), `this._edges` (RoutedEdge[]), `this._nodeStates` (Map\<nodeId, status\>), `this._positions` (Map\<nodeId, {x,y}\>). |
| **Transitions** | → `graph.loading` (user clicks Refresh DAG) · → `graph.empty` (data cleared) · Sub-states: `graph.panning`, `graph.zooming`, `graph.fitting`, `graph.node.*`, `graph.edge.*`, `graph.execution.*`, `graph.minimap.*` |

---

### State: `graph.error`

API call failed. The graph cannot be rendered.

| Field | Value |
|-------|-------|
| **ID** | `graph.error` |
| **Entry conditions** | API error during `getLatestDag()`: 401 (auth), 403 (forbidden), 404 (not found), 429 (rate limited), 500 (server error), network error. |
| **Exit conditions** | User clicks "Retry" button → `graph.loading`. User clicks "Refresh DAG" toolbar button → `graph.loading`. |
| **Visual** | Canvas shows error state centered: Red circle outline icon (48×48px). Error title in `--color-text-primary`: depends on error code — "Authentication Required" (401/403), "DAG Not Found" (404), "Rate Limited" (429), "Service Error" (500), "Connection Lost" (network). Error description in `--color-text-secondary` (12px): actionable message explaining what to do. "Retry" button rendered as a rounded rectangle pill (`#0A84FF` fill, "Retry" white text, 80×32px) centered below the description. Dotted border around the error area (200×120px). |
| **Canvas commands** | Error icon: `ctx.beginPath(); ctx.arc(w/2, h/2 - 30, 24, 0, TWO_PI); ctx.strokeStyle = '#FF453A'; ctx.lineWidth = 2; ctx.stroke();`. Cross inside circle: two lines. Title: `ctx.font = '600 14px Inter'; ctx.fillStyle = '#E5E5E5'; ctx.fillText(title, w/2, h/2 + 10);`. Description: `ctx.font = '400 12px Inter'; ctx.fillStyle = '#808080';`. Retry button: `ctx.roundRect(...); ctx.fillStyle = '#0A84FF'; ctx.fill(); ctx.fillText('Retry', ...);`. |
| **Keyboard** | `Enter` or `R` — retry (same as clicking Retry button). |
| **Data requirements** | `this._error = { code: number, message: string, retryable: boolean }` |
| **Transitions** | → `graph.loading` (retry initiated) |

**Error-specific messages:**

| Code | Title | Description |
|------|-------|-------------|
| 401 | Authentication Required | "Your session has expired. Re-authenticate to continue." |
| 403 | Access Denied | "You don't have permission to view this DAG." |
| 404 | DAG Not Found | "No DAG exists for this lakehouse. Deploy tables first." |
| 429 | Rate Limited | "Too many requests. Retrying in {Retry-After}s..." (auto-retry) |
| 500 | Service Error | "FLT service returned an error. Check service logs." |
| 0 | Connection Lost | "Cannot reach the FLT service. Check that it's running." |

---

### State: `graph.refreshing`

A special sub-state of `graph.loaded` — the graph is visible but a DAG refresh is in progress. Exists to provide visual feedback during re-fetch without destroying the current graph.

| Field | Value |
|-------|-------|
| **ID** | `graph.refreshing` |
| **Entry conditions** | User clicks "Refresh DAG" button while graph is loaded. |
| **Exit conditions** | API response received → layout recomputed → `graph.loaded` with animated position transition. API error → `graph.loaded` (keep existing graph) + toast notification with error. |
| **Visual** | Existing graph remains fully visible and interactive. Thin progress bar (2px height) at the top of the canvas area, `--color-accent` blue, animated indeterminate (sliding gradient). "Refresh DAG" toolbar button shows a spinner. |
| **Canvas commands** | Normal render pipeline + overlay: `ctx.save(); ctx.setTransform(dpr,0,0,dpr,0,0);` (screen space). Draw 2px bar: `ctx.fillStyle = '#0A84FF'; ctx.fillRect(barX, 0, barWidth, 2);` where `barX` animates left-to-right. `ctx.restore();` |
| **Keyboard** | All normal `graph.loaded` shortcuts remain active. |
| **Data requirements** | Previous `this._nodes` and `this._edges` remain in memory. |
| **Transitions** | → `graph.loaded` (success — nodes animate to new positions via layout transition) · → `graph.loaded` (error — keep existing, show toast) |

---

## 2. Camera Interaction States

Camera states are concurrent sub-states within `graph.loaded`. They describe user interaction with the viewport. At most one camera state is active at a time.

---

### State: `graph.panning`

User is dragging the canvas to pan the viewport.

| Field | Value |
|-------|-------|
| **ID** | `graph.panning` |
| **Entry conditions** | `mousedown` on empty canvas space (hit test returns null). Touch: `touchstart` with two fingers. |
| **Exit conditions** | `mouseup` or `mouseleave`. Touch: `touchend`. |
| **Visual** | Cursor changes to `grabbing`. Graph translates in real-time following the mouse delta. Nodes, edges, grid all move together (camera transform). Minimap viewport rectangle updates in real-time. |
| **Canvas commands** | Each `mousemove`: `this._camera.x = e.clientX - this._panOrigin.x; this._camera.y = e.clientY - this._panOrigin.y;` → `this._dirty = true;`. Normal render pipeline with updated camera transform. |
| **Keyboard** | `Escape` — cancel pan (restore camera to pre-pan position). All other shortcuts disabled during active drag. |
| **Data requirements** | `this._panOrigin = { x, y }` — mouse position at drag start minus camera position. |
| **Transitions** | → (camera idle) on `mouseup`. Camera position is retained; no snap-back. |

---

### State: `graph.zooming`

User is actively scrolling the mouse wheel to zoom, or a zoom animation is in progress.

| Field | Value |
|-------|-------|
| **ID** | `graph.zooming` |
| **Entry conditions** | `wheel` event on canvas. `+`/`-` key press. Zoom button click. Pinch gesture. |
| **Exit conditions** | Wheel events stop (implicit — no explicit exit, each wheel tick is a discrete zoom step). Animated zoom completes (keyboard/button zoom is animated over 200ms). |
| **Visual** | Graph scales toward the zoom focal point (cursor position for wheel, viewport center for keyboard/buttons). Zoom display in toolbar updates: "85%", "100%", "150%", etc. LOD levels re-evaluate per node — nodes may visually transition between dot/mini/detail as zoom changes. |
| **Canvas commands** | Per wheel tick: compute `newScale = clamp(scale * factor, 0.15, 3.0)`. Compute focal point in world space. Update `camera.x`, `camera.y`, `camera.scale`. Set dirty. For animated zoom (keyboard): `_animateCamera(targetX, targetY, targetScale, 200)`. |
| **Keyboard** | `Ctrl+0` — reset to 100% zoom + center graph. |
| **Data requirements** | Current `this._camera`. Zoom bounds: `[0.15, 3.0]`. |
| **Transitions** | → (camera idle) after wheel stops. → (camera idle) after animated zoom completes. Can transition directly to `graph.panning` if user drags during zoom. |

**Zoom factors:**

| Input | Factor | Animation |
|-------|--------|-----------|
| Wheel tick (up) | × 1.1 | Instant |
| Wheel tick (down) | × 0.9 | Instant |
| `+` key / Zoom In button | × 1.25 | 200ms ease-out |
| `-` key / Zoom Out button | × 0.8 | 200ms ease-out |
| Pinch | Continuous | Proportional to finger distance delta |

---

### State: `graph.fitting`

Animated camera transition to fit the entire graph in the viewport.

| Field | Value |
|-------|-------|
| **ID** | `graph.fitting` |
| **Entry conditions** | User presses `F` key. User clicks "Fit to Screen" button. First load of DAG data (auto-fit). |
| **Exit conditions** | Animation completes (400ms). User starts panning or zooming during animation (cancels animation, keeps current position). |
| **Visual** | Camera smoothly zooms and pans over 400ms (ease-out cubic) until all nodes are visible with 48px padding. If the graph fits at scale ≤ 1.2, it's shown at that scale. If it's already fitted, the animation is a no-op (no visual change). |
| **Canvas commands** | `_animateCamera(targetX, targetY, targetScale, 400)`. Each frame: `camera.x = xTween.update(t); camera.y = yTween.update(t); camera.scale = sTween.update(t);`. When all tweens are done, clear `_cameraTween`. |
| **Keyboard** | `Escape` — cancel fit animation, keep current camera position. |
| **Data requirements** | Graph bounds: `_getGraphBounds()` returns `{ minX, minY, maxX, maxY }`. |
| **Transitions** | → (camera idle, within `graph.loaded`) after 400ms. → (camera idle) if user interrupts with pan/zoom. |

---

### State: `graph.jumpToFailed`

Animated camera transition to center on the first failed node and select it.

| Field | Value |
|-------|-------|
| **ID** | `graph.jumpToFailed` |
| **Entry conditions** | User presses `Shift+F`. At least one node has `failed` status. |
| **Exit conditions** | Animation completes (400ms). Camera centered on failed node. Node is selected. |
| **Visual** | Camera pans and zooms to center the first failed node (sorted by layer order — leftmost failed node first). Zoom adjusts to show the failed node at LOD 2 detail level. After animation: node is selected (accent border), connected edges highlighted, detail panel opens showing error info. If no failed nodes exist: brief flash of the canvas border in `--color-text-tertiary` (200ms) to indicate "nothing to jump to." |
| **Canvas commands** | Same as `graph.fitting` but targeting a specific node's position: `_animateCamera(nodeScreenX, nodeScreenY, Math.max(0.8, camera.scale), 400)`. After animation completes: `selectNode(failedNodeId)`. |
| **Keyboard** | `Escape` — cancel animation. |
| **Data requirements** | At least one node in `this._nodeStates` with value `'failed'`. |
| **Transitions** | → `graph.loaded` + `graph.node.selected` (animation complete, node selected). → `graph.loaded` (no failed nodes — flash border, stay in current state). |

---

## 3. Node Visual States

Node visual states are per-node and independent. Each node has exactly one interaction state and one execution state simultaneously.

### Interaction States (mutually exclusive per node)

---

### State: `graph.node.idle`

The default state for a node with no user interaction.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.idle` |
| **Entry conditions** | Default state after render. Mouse leaves node's hit area. A different node is selected (this node loses selection). |
| **Exit conditions** | Mouse enters hit area → `graph.node.hovered`. Click on node → `graph.node.selected`. |
| **Visual** | Node rendered at its LOD level with standard styling. No highlight, no elevation. LOD 2: card with shadow, left bar, name, badge, status dot. LOD 1: colored rectangle with truncated name. LOD 0: colored dot. |
| **Canvas commands** | Standard `_drawDetailNode()`, `_drawMiniNode()`, or `_drawDotNode()` per LOD — no additional highlight passes. |
| **Keyboard** | `Tab` — if this is the next node in tab order, transitions to `graph.node.selected`. |
| **Data requirements** | Node position, LOD level, execution status for color. |
| **Transitions** | → `graph.node.hovered` (mouse enters hit area) · → `graph.node.selected` (click, Tab, or programmatic selection via `selectNode()`) |

---

### State: `graph.node.hovered`

Mouse cursor is over the node's hit area.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.hovered` |
| **Entry conditions** | `mousemove` hit test returns this node's ID. |
| **Exit conditions** | `mousemove` hit test returns a different node or null → `graph.node.idle`. `click` → `graph.node.selected`. |
| **Visual** | Cursor changes to `pointer`. LOD 2: subtle hover highlight — thin white border (`rgba(255,255,255,0.1)`, 1px) drawn around the card. Connected edges become slightly more opaque (0.4 → 0.6). LOD 1: same color rect but with a 1px white border stroke. LOD 0: dot radius increases by 1px. Tooltip appears near cursor showing: node name, status, duration (if available). |
| **Canvas commands** | Standard node draw + overlay: `ctx.roundRect(x-1, y-1, w+2, h+2, r+1); ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.stroke();`. Tooltip: DOM element positioned at `(e.clientX + 16, e.clientY + 16)` with `class="dag-tooltip visible"`. |
| **Keyboard** | None specific to hover — hover is mouse-only. |
| **Data requirements** | Node position, LOD level, status for tooltip content. Connected edges for highlight. |
| **Transitions** | → `graph.node.idle` (mouse leaves) · → `graph.node.selected` (click) |

---

### State: `graph.node.selected`

Node is actively selected — the primary focus of user attention.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.selected` |
| **Entry conditions** | User clicks the node. User presses `Tab`/`Shift+Tab` to cycle to this node. User presses arrow key to navigate to this node. Programmatic: `selectNode(nodeId)` called (e.g., from Gantt cross-highlight, or jumpToFailed). |
| **Exit conditions** | User clicks a different node → that node becomes `selected`, this one returns to `idle`. User clicks empty space → `graph.node.idle`. User presses `Escape` → `graph.node.idle`. |
| **Visual** | Strong visual distinction. LOD 2: bright accent-blue border (2px, `#0A84FF`) drawn outside the card. Shadow increased. LOD 1: accent-blue stroke on the rectangle. LOD 0: accent-blue ring around the dot. All connected edges re-classified: edges touching this node drawn in `selected` style (`#0A84FF`, 0.8 opacity, 2.5px). Unconnected edges dim slightly (0.4 → 0.3 opacity). Detail panel slides in from the right (or updates if already open) showing this node's data. ARIA: `canvas.setAttribute('aria-activedescendant', nodeId)`. |
| **Canvas commands** | Standard node draw + selection ring: `ctx.beginPath(); ctx.roundRect(x-2, y-2, w+4, h+4, r+2); ctx.strokeStyle = '#0A84FF'; ctx.lineWidth = 2; ctx.stroke();`. Edge reclassification: `_classifyEdges()` moves this node's edges to `selectedEdges` batch. |
| **Keyboard** | `Escape` — deselect. `↑/↓/←/→` — navigate to adjacent node (if exists). `Enter` — ensure detail panel is open. `Delete` or `Backspace` — no-op (nodes are read-only). |
| **Data requirements** | Full node data for detail panel. Connected edge IDs for highlighting. |
| **Transitions** | → `graph.node.idle` (deselect via Escape, click empty space, or different node selected). Emits `nodeSelected` event with `{ nodeId, node }` payload. Emits `nodeDeselected` on exit. |

---

### Execution States (mutually exclusive per node, concurrent with interaction state)

---

### State: `graph.node.pending`

Node has not started executing. Default state before and outside of execution.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.pending` |
| **Entry conditions** | Default execution state for all nodes. Execution loaded but this node's `NodeExecutionStatus` is `'none'`. No execution data loaded. |
| **Exit conditions** | Execution starts → node transitions to `graph.node.running` when AutoDetector detects `Executing node {name}`. |
| **Visual** | Muted styling. LOD 2: left bar is layer-colored (bronze/silver/gold), not status-colored. Status dot is grey (`#6B6B6B`). Card has lower contrast. LOD 1: rectangle filled with layer color at 0.6 opacity. LOD 0: grey dot. Edges from/to this node: thin, 0.2 opacity (pending batch). |
| **Canvas commands** | `_drawDetailNode(node, 'pending')` — uses `LAYER_COLORS[node.layerType]` for left bar, `#6B6B6B` for status dot. |
| **Keyboard** | No node-specific keyboard. General graph shortcuts apply. |
| **Data requirements** | Node metadata only. No execution metrics. |
| **Transitions** | → `graph.node.running` (AutoDetector: `Executing node {name}` detected). Color transition: grey → blue over 300ms ease-out. |

---

### State: `graph.node.running`

Node is currently executing. Pulse animation active.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.running` |
| **Entry conditions** | AutoDetector fires `onExecutionUpdated` with this node status = `'running'`. Or: execution metrics loaded showing `NodeExecutionStatus.Running`. |
| **Exit conditions** | Node completes → `graph.node.succeeded`. Node fails → `graph.node.failed`. Node cancelled → `graph.node.cancelled`. |
| **Visual** | Animated pulse. LOD 2: left bar is blue (`#0A84FF`). Outer glow border pulses: `rgba(10, 132, 255, alpha)` where `alpha = 0.3 + 0.5 × sin(t × 2π/1500)`, period = 1.5s. Status dot is blue. Duration counter shows elapsed time, updating every second. LOD 1: blue rectangle with pulsing border. LOD 0: blue dot with pulsing outer ring. Edges from completed parents to this node show animated dashes (flowing state). |
| **Canvas commands** | Node: standard draw + pulse overlay: `const pulseAlpha = 0.3 + 0.5 * Math.sin(timestamp * 0.00419); ctx.roundRect(x-3, y-3, w+6, h+6, r+3); ctx.strokeStyle = 'rgba(10,132,255,' + pulseAlpha + ')'; ctx.lineWidth = 2; ctx.stroke();`. Duration: `ctx.fillText(formatElapsed(now - startedAt), ...)`. This state sets `this._animating = true` to keep the render loop running every frame. |
| **Keyboard** | Same as idle. Clicking a running node shows live metrics in the detail panel. |
| **Data requirements** | `nodeExecMetrics.startedAt` for elapsed time calculation. |
| **Transitions** | → `graph.node.succeeded` (color: blue → green, 300ms). → `graph.node.failed` (color: blue → red, 300ms). → `graph.node.cancelled` (color: blue → amber, 300ms). → `graph.node.skipped` (if upstream failure causes skip). |

---

### State: `graph.node.succeeded`

Node execution completed successfully.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.succeeded` |
| **Entry conditions** | AutoDetector: `Executed node {name}` with success status. Execution metrics: `NodeExecutionStatus.Completed`. |
| **Exit conditions** | New execution started → resets to `graph.node.pending`. Different execution loaded from history → re-evaluated. |
| **Visual** | Green accent. LOD 2: left bar is green (`#32D74B`). Status dot is green. Duration shows final time (e.g., "12.3s"). No animation. LOD 1: green rectangle. LOD 0: green dot. Edges from this node to children: normal style (grey) or flowing (if child is running). |
| **Canvas commands** | `_drawDetailNode(node, 'completed')` — `STATUS_COLORS.completed.main = '#32D74B'` for left bar and status dot. |
| **Keyboard** | Standard. |
| **Data requirements** | `nodeExecMetrics.status`, `nodeExecMetrics.startedAt`, `nodeExecMetrics.endedAt`, `addedRowsCount`, `droppedRowsCount` for detail panel. |
| **Transitions** | → `graph.node.pending` (new execution or execution data cleared). |

---

### State: `graph.node.failed`

Node execution failed.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.failed` |
| **Entry conditions** | AutoDetector: error detected for this node. Execution metrics: `NodeExecutionStatus.Failed`. |
| **Exit conditions** | New execution started → `graph.node.pending`. Different execution loaded. |
| **Visual** | High-salience red. LOD 2: left bar is red (`#FF453A`). Red glow halo behind status dot (`rgba(255,69,58,0.3)`, 8px radius). Status dot is red. Error count badge (if multiple errors): red circle with white number in top-right of card. If `errorCode` is present: small error code text below duration (e.g., "MLV_STALE_METADATA" truncated to 18 chars). LOD 1: red rectangle. LOD 0: red dot with glow halo (radius 10px). Edges from this node: dashed red (`[6,4]`, 0.5 opacity) — error propagation path. This node is a primary target for `Shift+F` jump-to-failed. |
| **Canvas commands** | LOD 2: Standard card + glow: `ctx.arc(statusX, statusY, 8, 0, TWO_PI); ctx.fillStyle = 'rgba(255,69,58,0.3)'; ctx.fill();`. Error badge: `ctx.arc(x+W-8, y+8, 7, 0, TWO_PI); ctx.fillStyle = '#FF453A'; ctx.fill(); ctx.fillText(errorCount, ...);`. LOD 0: `ctx.arc(x, y, 10, 0, TWO_PI); ctx.fillStyle = 'rgba(255,69,58,0.3)'; ctx.fill();` + `ctx.arc(x, y, 6, 0, TWO_PI); ctx.fillStyle = '#FF453A'; ctx.fill();`. |
| **Keyboard** | `Shift+F` — if this is the first failed node, camera animates to it and selects it. |
| **Data requirements** | `nodeExecMetrics.errorCode`, `nodeExecMetrics.errorMessage`, `nodeErrorDetails.failureType`. |
| **Transitions** | → `graph.node.pending` (new execution or data cleared). |

---

### State: `graph.node.skipped`

Node was skipped because an upstream dependency failed.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.skipped` |
| **Entry conditions** | AutoDetector: `[DAG_FAULTED_NODES]` list includes this node. Execution metrics: `NodeExecutionStatus.Skipped`. An upstream parent node is `failed` and this node was never started. |
| **Exit conditions** | New execution → `graph.node.pending`. |
| **Visual** | Dimmed, de-emphasized. LOD 2: entire card at 50% opacity. Left bar is grey with dotted pattern (`ctx.setLineDash([3,3])`). Status dot is grey. Text is `--color-text-tertiary`. Faint label "Skipped" below duration area. LOD 1: grey rectangle at 40% opacity. LOD 0: grey dot at 50% opacity (small, 3px radius). Edges to/from this node: very faint (0.15 opacity). |
| **Canvas commands** | `ctx.globalAlpha = 0.5;` before all draw calls for this node. Left bar: `ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(x+2, y); ctx.lineTo(x+2, y+H); ctx.stroke(); ctx.setLineDash([]);`. |
| **Keyboard** | Standard. Clicking shows "Skipped due to upstream failure" in detail panel. |
| **Data requirements** | Node metadata. Upstream failed node IDs (for detail panel explanation). |
| **Transitions** | → `graph.node.pending` (new execution). |

---

### State: `graph.node.cancelled`

Node execution was cancelled.

| Field | Value |
|-------|-------|
| **ID** | `graph.node.cancelled` |
| **Entry conditions** | Execution metrics: `NodeExecutionStatus.Cancelled`. AutoDetector: cancellation detected while node was running or pending. |
| **Exit conditions** | New execution → `graph.node.pending`. |
| **Visual** | Amber styling. LOD 2: left bar is amber (`#FF9F0A`). Status dot is amber. No glow, no animation. Duration shows time until cancellation. LOD 1: amber rectangle. LOD 0: amber dot. Edges: normal grey. |
| **Canvas commands** | `_drawDetailNode(node, 'cancelled')` — `STATUS_COLORS.cancelled.main = '#FF9F0A'`. |
| **Keyboard** | Standard. |
| **Data requirements** | `nodeExecMetrics.cancellationRequestedAt`. |
| **Transitions** | → `graph.node.pending` (new execution). |

---

## 4. Edge Visual States

Edge states are derived from the execution states of their source and target nodes. Not directly user-controllable.

---

### State: `graph.edge.idle`

Default edge state — no special visual treatment.

| Field | Value |
|-------|-------|
| **ID** | `graph.edge.idle` |
| **Entry conditions** | Both endpoints are `pending`, `succeeded`, `skipped`, or `cancelled` (not `running` or `failed`). Neither endpoint is selected. |
| **Exit conditions** | Source or target node changes status. Either endpoint becomes selected. |
| **Visual** | Thin grey bezier curve. Stroke: `#3A3A3A`, opacity 0.4, width 1.5px (scaled by `1/camera.scale`). Arrowhead at target end (if zoom > 0.4). |
| **Canvas commands** | `ctx.strokeStyle = '#3A3A3A'; ctx.globalAlpha = 0.4; ctx.lineWidth = 1.5 / scale;` → `_drawBezier(edge)`. Arrowhead: filled triangle at target anchor. |
| **Keyboard** | None. |
| **Data requirements** | Edge source/target anchors and control points from layout. |
| **Transitions** | → `graph.edge.flowing` (source completed, target running). → `graph.edge.error` (source or target failed). → `graph.edge.selected` (source or target node selected by user). |

---

### State: `graph.edge.flowing`

Animated dashes showing data flow during execution — the parent completed and the child is running.

| Field | Value |
|-------|-------|
| **ID** | `graph.edge.flowing` |
| **Entry conditions** | Source node status = `completed` AND target node status = `running`. |
| **Exit conditions** | Target node completes, fails, or is cancelled → reverts to `graph.edge.idle` (or `graph.edge.error`). |
| **Visual** | Blue animated dashes flowing left-to-right (parent → child direction). Stroke: `#0A84FF`, opacity 0.6, width 2.0px. Dash pattern: `[8, 6]`. Dash offset animates at -50px/s (dashes move toward the child). This creates the visual impression of data flowing through the pipeline. |
| **Canvas commands** | `ctx.strokeStyle = '#0A84FF'; ctx.globalAlpha = 0.6; ctx.lineWidth = 2.0 / scale; ctx.setLineDash([8, 6]); ctx.lineDashOffset = -timestamp * 0.05;` → `_drawBezier(edge)`. `ctx.setLineDash([]); ctx.lineDashOffset = 0;`. This state contributes to `this._animating = true`. |
| **Keyboard** | None. |
| **Data requirements** | Source and target node execution statuses. |
| **Transitions** | → `graph.edge.idle` (target completes/cancels). → `graph.edge.error` (target fails). |

---

### State: `graph.edge.error`

Red dashed edge indicating error propagation path.

| Field | Value |
|-------|-------|
| **ID** | `graph.edge.error` |
| **Entry conditions** | Source node status = `failed` OR target node status = `failed`. |
| **Exit conditions** | New execution clears all statuses → `graph.edge.idle`. Different execution data loaded. |
| **Visual** | Red dashed line. Stroke: `#FF453A`, opacity 0.5, width 1.5px. Dash pattern: `[6, 4]`. Not animated (static dashes). This traces the failure path through the DAG — from the failed node through its children (which may be `skipped`). |
| **Canvas commands** | `ctx.strokeStyle = '#FF453A'; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5 / scale; ctx.setLineDash([6, 4]);` → `_drawBezier(edge)`. `ctx.setLineDash([]);`. |
| **Keyboard** | None. |
| **Data requirements** | Source and target node execution statuses. |
| **Transitions** | → `graph.edge.idle` (execution cleared or new execution). |

---

### State: `graph.edge.selected`

Edge is part of the selected node's connection graph.

| Field | Value |
|-------|-------|
| **ID** | `graph.edge.selected` |
| **Entry conditions** | Source OR target of this edge is the currently selected node (`this._selectedNodeId`). |
| **Exit conditions** | Node deselected. Different node selected (and this edge is not connected to the new selection). |
| **Visual** | Bright accent blue. Stroke: `#0A84FF`, opacity 0.8, width 2.5px. Drawn on top of all other edges (last in edge render order). Arrowhead is also accent blue. This highlights the selected node's dependencies (incoming) and dependents (outgoing). |
| **Canvas commands** | `ctx.strokeStyle = '#0A84FF'; ctx.globalAlpha = 0.8; ctx.lineWidth = 2.5 / scale;` → `_drawBezier(edge)`. Drawn in Batch 5 (after all other edge batches). |
| **Keyboard** | None directly. Arrow keys on the selected node traverse these highlighted edges. |
| **Data requirements** | `this._selectedNodeId` to determine if this edge is connected. |
| **Transitions** | → `graph.edge.idle` (deselect). → (previous execution state) when selection changes away. Note: `selected` overrides `flowing` and `error` visually — if an edge is both `error` and `selected`, it renders as `selected`. |

---

## 5. Execution Overlay States

These states describe the overall DAG execution lifecycle, overlaid on the graph.

---

### State: `graph.execution.idle`

No active execution. The graph shows static structure, possibly with historical execution data overlaid.

| Field | Value |
|-------|-------|
| **ID** | `graph.execution.idle` |
| **Entry conditions** | Default state. Execution completed, failed, or cancelled. User clears execution overlay. |
| **Exit conditions** | User clicks "Run DAG" → `graph.execution.running`. User loads a historical execution → nodes show that execution's statuses (still `idle` — viewing history, not live). |
| **Visual** | All nodes in their default visual states (pending if no execution data, or historical statuses if execution data is loaded). No pulse animations. No flowing edges. Toolbar status shows "Idle" (grey dot). |
| **Canvas commands** | Standard render pipeline. No animation tweens active. `this._animating` may be false (frame loop sleeps until dirty). |
| **Keyboard** | All standard shortcuts. `R` or "Run DAG" button available. |
| **Data requirements** | Optionally: `DagExecutionInstance` for historical overlay. |
| **Transitions** | → `graph.execution.running` (new execution started). |

---

### State: `graph.execution.running`

A DAG execution is in progress. Nodes update in real-time.

| Field | Value |
|-------|-------|
| **ID** | `graph.execution.running` |
| **Entry conditions** | `DagStudio._runDag()` triggered (POST succeeded with 202). AutoDetector detects `[DAG STATUS] Running`. |
| **Exit conditions** | All nodes finish → `graph.execution.completed`. Error terminates execution → `graph.execution.completed`. User cancels → eventually `graph.execution.completed`. |
| **Visual** | Live execution visualization. Multiple nodes may be in `running` state simultaneously (up to `parallelNodeLimit`). Pulse animations active on running nodes. Flowing edge animations active. Toolbar shows: pulsing blue dot + "Running" + elapsed timer (updates every second). Elapsed timer: `formatDuration(now - executionStartedAt)`. "Run DAG" button disabled (greyed out). "Cancel DAG" button enabled (red ghost style). The render loop runs continuously (`this._animating = true`) to drive pulse and flow animations. |
| **Canvas commands** | Full render pipeline every frame. Running nodes: pulse glow. Flowing edges: animated dash offset. Each `onExecutionUpdated` callback: `updateNodeState(nodeId, newStatus)` → color transition animation (300ms). |
| **Keyboard** | `Shift+F` — jump to first failed node (if any have failed so far). All navigation shortcuts active. |
| **Data requirements** | Active `iterationId`. AutoDetector subscribed. `dagExecutionMetrics.startedAt` for elapsed timer. Per-node statuses updating via callbacks. |
| **Transitions** | → `graph.execution.completed` (all nodes reach terminal state: completed/failed/cancelled/skipped). |

---

### State: `graph.execution.completed`

Execution has finished. All nodes are in terminal states.

| Field | Value |
|-------|-------|
| **ID** | `graph.execution.completed` |
| **Entry conditions** | AutoDetector: `[DAG STATUS] Completed` or `[DAG STATUS] Failed` or `[DAG STATUS] Cancelled`. All running node animations have completed their final color transitions. |
| **Exit conditions** | User starts a new execution → `graph.execution.running`. User clears execution data → `graph.execution.idle`. |
| **Visual** | Static result visualization. All nodes show final statuses (green/red/amber/grey). No pulse animations. No flowing edges. Final durations displayed on all nodes. Toolbar shows final status: green dot + "Completed" + total duration, OR red dot + "Failed" + error summary, OR amber dot + "Cancelled". "Run DAG" button re-enabled. "Cancel DAG" button disabled. If any nodes failed: `Shift+F` shortcut hint appears briefly as a toast: "Press Shift+F to jump to failure". |
| **Canvas commands** | Standard render pipeline. `this._animating = false` — frame loop sleeps until next dirty trigger. All color transitions completed. |
| **Keyboard** | `Shift+F` — jump to first failed node. `R` or "Run DAG" — start new execution. |
| **Data requirements** | Complete `DagExecutionInstance` with all `NodeExecutionMetrics`. |
| **Transitions** | → `graph.execution.running` (new Run DAG). → `graph.execution.idle` (clear overlay). |

---

## 6. Minimap States

---

### State: `graph.minimap.visible`

Minimap is shown in the bottom-left corner of the canvas.

| Field | Value |
|-------|-------|
| **ID** | `graph.minimap.visible` |
| **Entry conditions** | Default state when `graph.loaded`. Graph has at least 1 node. |
| **Exit conditions** | `graph.empty` or `graph.loading` → minimap hidden. User could toggle minimap (future feature — not in MVP). |
| **Visual** | 180×100px semi-transparent panel at bottom-left (16px margin). Background: `rgba(13,13,13,0.9)`. Border: `#2A2A2A`, 1px. All nodes rendered as 2px colored dots (sampled at `max(1, floor(nodes/100))` rate for large DAGs). Viewport rectangle: `rgba(10,132,255,0.15)` fill + `#0A84FF` 1px stroke, showing the currently visible area of the main canvas. The viewport rectangle updates in real-time during pan/zoom. |
| **Canvas commands** | See Section 9 of `components/graph-canvas.md`. Rendered after `ctx.restore()` in screen space. |
| **Keyboard** | No dedicated keyboard shortcuts for minimap in MVP. |
| **Data requirements** | All node positions. Graph bounds. Current camera state for viewport rectangle. |
| **Transitions** | → `graph.minimap.dragging` (mousedown inside minimap bounds). |

---

### State: `graph.minimap.dragging`

User is clicking/dragging within the minimap to reposition the viewport.

| Field | Value |
|-------|-------|
| **ID** | `graph.minimap.dragging` |
| **Entry conditions** | `mousedown` event where hit test returns a point inside the minimap bounds (16 ≤ x ≤ 196, height-116 ≤ y ≤ height-16). |
| **Exit conditions** | `mouseup` or `mouseleave`. |
| **Visual** | Same as `graph.minimap.visible`, but the viewport rectangle follows the cursor position within the minimap. The main canvas pans in real-time to match the new viewport position. Cursor: `move` while dragging. Minimap border briefly flashes `#0A84FF` (200ms) on mousedown to confirm the interaction started on the minimap. |
| **Canvas commands** | Each `mousemove`: convert minimap pixel to world coordinate → update `this._camera.x` and `this._camera.y` → set dirty. Same minimap render but with cursor-following viewport rectangle. |
| **Keyboard** | `Escape` — cancel drag, restore camera to pre-drag position. |
| **Data requirements** | Minimap bounds, graph bounds, minimap-to-world coordinate mapping. |
| **Transitions** | → `graph.minimap.visible` (mouseup — camera stays at new position). |

---

## 7. State Transition Diagram

```
                    ┌─────────────┐
                    │ graph.empty │
                    └──────┬──────┘
                           │ setData() / API fetch
                    ┌──────▼──────┐
              ┌─────│graph.loading│─────┐
              │     └──────┬──────┘     │
              │            │ success    │ error
              │     ┌──────▼──────┐     │
              │     │graph.loaded │     │
              │     │             │  ┌──▼───────────┐
              │     │  ┌────────┐ │  │ graph.error  │
              │     │  │CAMERA  │ │  │ (retry → ↑)  │
              │     │  │panning │ │  └──────────────┘
              │     │  │zooming │ │
              │     │  │fitting │ │
              │     │  └────────┘ │
              │     │             │
              │     │  ┌─────────────────────────┐
              │     │  │NODES (per node)          │
              │     │  │ idle ↔ hovered ↔ selected│
              │     │  │                          │
              │     │  │ pending → running →      │
              │     │  │   succeeded / failed /   │
              │     │  │   cancelled / skipped    │
              │     │  └─────────────────────────┘
              │     │             │
              │     │  ┌─────────────────────────┐
              │     │  │EDGES (per edge)          │
              │     │  │ idle / flowing / error / │
              │     │  │ selected                 │
              │     │  └─────────────────────────┘
              │     │             │
              │     │  ┌─────────────────────────┐
              │     │  │EXECUTION                 │
              │     │  │ idle → running →         │
              │     │  │       completed          │
              │     │  └─────────────────────────┘
              │     │             │
              │     │  ┌─────────────────────────┐
              │     │  │MINIMAP                   │
              │     │  │ visible ↔ dragging       │
              │     │  └─────────────────────────┘
              │     └─────────────┘
              │            │ refresh
              │     ┌──────▼───────┐
              └─────│graph.refreshing│ (overlay on loaded)
                    └──────────────┘
```

---

## 8. Compound State Rules

Multiple state dimensions are active simultaneously. Rules for combining them:

### Priority Order (visual conflicts)

When multiple states want to affect the same visual property, higher-priority states win:

| Priority | State Dimension | Affects |
|----------|----------------|---------|
| 1 (highest) | Node interaction: `selected` | Border color, edge highlight |
| 2 | Node interaction: `hovered` | Border opacity, cursor, tooltip |
| 3 | Node execution: `running` | Pulse animation, left bar color |
| 4 | Node execution: `failed` | Glow halo, error badge, left bar red |
| 5 | Node execution: `succeeded`/`cancelled`/`skipped` | Left bar color, opacity |
| 6 (lowest) | Node execution: `pending` + layer color | Default left bar |

**Example:** A running node that is also selected:
- Left bar: blue (running, priority 3)
- Border: accent blue selection ring (selected, priority 1)
- Pulse animation: active (running, priority 3)
- Connected edges: selected style (priority 1, overrides flowing)

**Example:** A failed node that is hovered:
- Left bar: red (failed, priority 4)
- Glow halo: active (failed, priority 4)
- Hover border: white opacity border (hovered, priority 2) — drawn INSIDE the glow halo
- Tooltip: visible (hovered, priority 2)

### Edge State Priority

| Priority | State | Visual |
|----------|-------|--------|
| 1 | `selected` | Accent blue, 2.5px |
| 2 | `flowing` | Blue animated dashes |
| 3 | `error` | Red dashed |
| 4 | `idle` | Grey, thin |

An edge connected to a selected node always renders as `selected`, even if it would otherwise be `flowing` or `error`.

### Execution + Lifecycle Combinations

| Lifecycle | Execution | Behavior |
|-----------|-----------|----------|
| `graph.loaded` | `execution.idle` | Static graph, historical data (if loaded) |
| `graph.loaded` | `execution.running` | Live updates, animations active |
| `graph.loaded` | `execution.completed` | Final results shown, static |
| `graph.loading` | (any) | Skeleton shown, execution state preserved for restore |
| `graph.refreshing` | `execution.running` | Graph visible with live updates + refresh progress bar overlay |
| `graph.error` | (any) | Error screen, execution state irrelevant |
| `graph.empty` | (any) | Empty state, execution state irrelevant |

### Animation Stacking

Multiple animations can run simultaneously:
- Camera tween (fit-to-screen) + node pulse (running) + edge flow (flowing) — all independent
- Color transition (node status change) + camera tween — both update every frame
- Layout transition (node positions moving) + execution status updates — both animate concurrently

The `_animating` flag is `true` if ANY animation is active. It's set to `false` only when ALL animations have completed their tweens and no nodes are in `running` status.

---

## State Count Summary

| Category | Count | States |
|----------|:-----:|--------|
| Graph lifecycle | 5 | empty, loading, loaded, error, refreshing |
| Camera | 4 | panning, zooming, fitting, jumpToFailed |
| Node interaction | 3 | idle, hovered, selected |
| Node execution | 5 | pending, running, succeeded, failed, skipped, cancelled |
| Edge | 4 | idle, flowing, error, selected |
| Execution overlay | 3 | idle, running, completed |
| Minimap | 2 | visible, dragging |
| **Total** | **26** | |

---

*"State is the enemy of rendering. Every state combination is a potential bug. This matrix makes the enemy visible."*

— Pixel, Frontend Engineer
