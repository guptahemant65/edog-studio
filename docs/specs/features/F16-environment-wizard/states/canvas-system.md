# P3 State Matrices: DAG Canvas System (C04 / C05 / C06 / C07)

> **Phase:** P3 (State Matrices)
> **Feature:** F16 -- New Infra Wizard, Page 3 -- DAG Canvas
> **Components:** C04-DagCanvas, C05-NodePalette, C06-DagNode, C07-ConnectionManager
> **Author:** Pixel (Frontend Agent) + Sana (Architecture Review)
> **Status:** DRAFT
> **Date:** 2025-07-20
> **Spec Version:** 1.0.0

---

## Table of Contents

1. [C04 -- DagCanvas (28 states)](#1-c04--dagcanvas-28-states)
2. [C05 -- NodePalette (14 states)](#2-c05--nodepalette-14-states)
3. [C06 -- DagNode (22 states)](#3-c06--dagnode-22-states)
4. [C07 -- ConnectionManager (15 states)](#4-c07--connectionmanager-15-states)
5. [Cross-Component Interaction Matrix](#5-cross-component-interaction-matrix)

---

## 1. C04 -- DagCanvas (28 states)

### 1.0 State Namespace

All DagCanvas state IDs use the prefix `canvas.`. States are organized into four orthogonal
dimensions that compose at runtime:

| Dimension | Prefix | Description |
|-----------|--------|-------------|
| Interaction | `canvas.interaction.*` | What the pointer is doing right now |
| Viewport | `canvas.viewport.*` | Zoom/pan/fit visual state |
| Content | `canvas.content.*` | What is on the canvas |
| Selection | `canvas.selection.*` | What is currently selected |

---

### 1.1 Interaction States

#### canvas.interaction.idle

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.idle` |
| **Entry conditions** | Initial mount; return from any other interaction state via `pointerup`, `Escape`, or action completion |
| **Exit conditions** | `pointerdown` on empty canvas -> `canvas.interaction.pan-pending` or `canvas.interaction.select-pending`; `pointerdown` on node -> `canvas.interaction.node-drag-pending`; `pointerdown` on port -> `canvas.interaction.connecting`; `contextmenu` -> `canvas.interaction.context-menu-open`; `wheel` -> instant zoom (stays idle); `Space` keydown -> cursor changes to `grab` (stays idle, sets `spaceHeld` flag) |
| **Visual description** | Default cursor. Grid dot pattern visible. Zoom controls floating bottom-right. No active selection rectangle, no drag ghosts. |
| **Active DOM elements** | `.dag-canvas-svg` (visible), `.dag-zoom-controls` (visible), `.dag-grid-pattern` (visible), `.dag-context-menu` (hidden), `.dag-selection-rect` (hidden) |
| **Keyboard shortcuts** | `Ctrl+Z` undo, `Ctrl+Y`/`Ctrl+Shift+Z` redo, `Ctrl+A` select-all, `Delete`/`Backspace` delete selected, `Space` hold for pan mode, `/` open command palette, `Escape` deselect all, `Ctrl+Shift+L` auto-layout |
| **Data requirements** | `CanvasState` loaded (nodes[], connections[], viewport). `availableSchemas` from Page 2. `dataTheme` from Page 2. |
| **Transitions** | `pointerdown(button=0)` on empty -> `select-pending`; `pointerdown(button=1)` on empty -> `panning`; `pointerdown(button=0, spaceHeld=true)` -> `panning`; `pointerdown(button=0)` on node body -> `node-drag-pending`; `pointerdown` on output port -> `connecting`; `contextmenu` -> `context-menu-open`; `wheel` -> zoom (self-loop) |
| **Error recovery** | If state is corrupted (e.g., `interactionMode` mismatch), any `pointerup` or `Escape` forces return to idle. Orphaned ghost elements are garbage-collected on idle entry. |
| **Animation** | None on entry. Grid dot pattern uses `will-change: transform` for GPU compositing. |

#### canvas.interaction.panning

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.panning` |
| **Entry conditions** | Middle-mouse `pointerdown` (button=1) on empty canvas; OR left-click `pointerdown` (button=0) while `spaceHeld === true` |
| **Exit conditions** | `pointerup` or `pointercancel` -> `canvas.interaction.idle`; `keyup Space` (if space-initiated) -> `canvas.interaction.idle` |
| **Visual description** | Cursor changes to `grabbing`. Canvas translates smoothly following pointer delta. Grid scrolls with content. All nodes, connections, and overlays move in unison. |
| **Active DOM elements** | `.dag-canvas-svg` cursor=`grabbing`, all content layers translate via root `<g transform>` |
| **Keyboard shortcuts** | `Escape` -> cancel pan, return to idle. All other shortcuts suppressed during pan. |
| **Data requirements** | `panState: { startClientX, startClientY, startPanX, startPanY }` captured on entry. |
| **Transitions** | `pointermove` -> update pan offset (self-loop, 60fps rAF); `pointerup`/`pointercancel` -> idle; `keyup Space` (guard: was space-initiated) -> idle |
| **Error recovery** | If pointer is lost (e.g., pointer leaves window), `pointercancel` fires and state returns to idle. `panState` is nulled on exit. |
| **Animation** | No easing during live pan (1:1 pointer tracking). On exit, no momentum/inertia (instant stop). |

#### canvas.interaction.zooming

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.zooming` |
| **Entry conditions** | `wheel` event on canvas SVG element; OR click on zoom-in/zoom-out button in `.dag-zoom-controls` |
| **Exit conditions** | Immediate -- zoom is applied in a single frame, returns to previous state (idle) |
| **Visual description** | Zoom level changes around cursor position (wheel) or around canvas center (buttons). `.dag-zoom-display` text updates to show current percentage. Grid dot spacing scales proportionally. |
| **Active DOM elements** | `.dag-zoom-display` (text updates), `.dag-zoom-btn--in` / `.dag-zoom-btn--out` (button flash on click) |
| **Keyboard shortcuts** | `Ctrl+=` zoom in, `Ctrl+-` zoom out, `Ctrl+0` reset to 100% |
| **Data requirements** | Current `viewport.zoom` (range 0.25--4.0). Cursor position for focal-point zoom. |
| **Transitions** | Instant self-loop: apply zoom delta -> `canvas.interaction.idle`. Zoom snaps to 100% when within +/-3%. Clamped at 25% and 400% boundaries. |
| **Error recovery** | If zoom results in NaN or out-of-range, clamp to nearest valid value (0.25 or 4.0). |
| **Animation** | Wheel: no animation (instant per-frame). Button click: smooth ease 150ms `cubic-bezier(0.25, 0.1, 0.25, 1.0)`. Zoom display text fades old -> new (80ms crossfade). |

#### canvas.interaction.select-pending

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.select-pending` |
| **Entry conditions** | `pointerdown(button=0)` on empty canvas area (not on node, port, or connection), `spaceHeld === false` |
| **Exit conditions** | `pointermove` with distance > 4px from start -> `canvas.interaction.marquee-selecting`; `pointerup` without exceeding threshold -> `canvas.interaction.idle` (fires `deselectAll()`) |
| **Visual description** | No visual change from idle. Cursor remains `default`. Internal: start position recorded for dead-zone detection. |
| **Active DOM elements** | Same as idle. Start position stored in transient state. |
| **Keyboard shortcuts** | `Escape` -> cancel, return to idle |
| **Data requirements** | `{ startClientX, startClientY }` recorded on `pointerdown`. |
| **Transitions** | `pointermove` (distance > 4px) -> `marquee-selecting`; `pointerup` (distance <= 4px) -> idle + `deselectAll()` |
| **Error recovery** | If `pointerdown` target changes mid-detection (e.g., DOM mutation), abort and return to idle. |
| **Animation** | None. |

#### canvas.interaction.marquee-selecting

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.marquee-selecting` |
| **Entry conditions** | Transition from `select-pending` when pointer movement exceeds 4px dead zone |
| **Exit conditions** | `pointerup` -> commit selection, `canvas.interaction.idle`; `Escape` -> cancel selection, `canvas.interaction.idle` |
| **Visual description** | Semi-transparent blue rectangle (`.dag-selection-rect`) drawn from start to current pointer position. Nodes fully enclosed by the rectangle gain a temporary highlight ring (dashed accent border). |
| **Active DOM elements** | `.dag-selection-rect` (visible, updated on every `pointermove`), enclosed nodes get `.dag-node--marquee-highlight` class |
| **Keyboard shortcuts** | `Escape` -> cancel marquee, `Shift` held -> additive selection (add to existing) |
| **Data requirements** | `selectionRect: { startX, startY, endX, endY }` in canvas coordinates. Node bounding boxes for intersection test. |
| **Transitions** | `pointermove` -> update rectangle dimensions + highlight enclosed nodes (self-loop); `pointerup` -> commit: `selectNodesInRect(x1,y1,x2,y2)` -> idle; `Escape` -> cancel: hide rect -> idle |
| **Error recovery** | If pointer leaves canvas during marquee, extend rect to canvas edge. On `pointercancel`, treat as `Escape` (cancel). |
| **Animation** | Selection rect: no animation (instant resize). Node highlight: 100ms fade-in when entering rect, 100ms fade-out when leaving. `transition: opacity 100ms ease`. |

#### canvas.interaction.node-drag-pending

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.node-drag-pending` |
| **Entry conditions** | `pointerdown(button=0)` on a node body (not port, not popover) |
| **Exit conditions** | `pointermove` with distance > 4px -> `canvas.interaction.dragging-nodes`; `pointerup` (distance <= 4px) -> treat as click: select node -> `canvas.interaction.idle` |
| **Visual description** | No visual change. Node remains in current state (idle/selected). Dead-zone detection in progress. |
| **Active DOM elements** | Target node recorded. Offset from cursor to node top-left stored. |
| **Keyboard shortcuts** | `Escape` -> abort, return to idle |
| **Data requirements** | `dragTarget: { nodeId, offsetX, offsetY, startX, startY }`. Whether Ctrl/Shift held for additive selection. |
| **Transitions** | `pointermove` (>4px) -> `dragging-nodes`; `pointerup` (<= 4px, no Ctrl) -> `selectNode(id, false)` -> idle; `pointerup` (<=4px, Ctrl held) -> `selectNode(id, true)` -> idle |
| **Error recovery** | If target node is deleted during pending state (e.g., by undo), abort to idle. |
| **Animation** | None. |

#### canvas.interaction.dragging-nodes

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.dragging-nodes` |
| **Entry conditions** | Transition from `node-drag-pending` when movement exceeds 4px dead zone |
| **Exit conditions** | `pointerup` -> commit move (create `MoveNodeCommand`) -> `canvas.interaction.idle`; `Escape` -> revert all moved nodes to start positions -> `canvas.interaction.idle` |
| **Visual description** | Dragged node(s): opacity 0.92, elevated `drop-shadow(0 4px 12px rgba(0,0,0,0.15))`, cursor `grabbing`. All selected nodes move together by same delta. Connections attached to moving nodes update in real-time (60fps). Grid-snap: nodes snap to 20px grid during drag. |
| **Active DOM elements** | `.dag-node.is-dragging` (all selected nodes), connections re-routed per frame via rAF |
| **Keyboard shortcuts** | `Escape` -> revert to start positions, cancel drag |
| **Data requirements** | Start positions for all selected nodes (for undo). Current pointer position. Zoom level (for screen-to-canvas delta conversion). |
| **Transitions** | `pointermove` -> update positions of all selected nodes (self-loop, rAF-throttled); `pointerup` -> commit: create `MoveNodeCommand` (or `BatchCommand` for multi) -> idle; `Escape` -> revert all positions, no undo command -> idle |
| **Error recovery** | If a node is externally deleted during drag (e.g., undo from another context), remove it from drag set and continue with remaining. If drag set becomes empty, return to idle. |
| **Animation** | Node position: no easing during drag (1:1 tracking with grid snap). On `Escape` revert: 150ms spring ease `cubic-bezier(0.34, 1.56, 0.64, 1)` back to start position. Connection paths: no animation (instant rAF updates). |

#### canvas.interaction.receiving-drop

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.receiving-drop` |
| **Entry conditions** | NodePalette drag enters the canvas SVG element boundary (`palette:drag-move` event with cursor over canvas) |
| **Exit conditions** | `palette:drop` event -> create node -> `canvas.interaction.idle`; `palette:drag-end { cancelled: true }` -> `canvas.interaction.idle`; cursor leaves canvas boundary -> `canvas.interaction.idle` (palette still dragging) |
| **Visual description** | Canvas shows a subtle blue tint overlay (`.dag-canvas-drop-zone`, background `oklch(0.62 0.18 255 / 0.04)`). A position indicator (translucent node silhouette, 180x72px, dashed border) follows the cursor in canvas coordinates. Cursor shows `copy`. |
| **Active DOM elements** | `.dag-canvas-drop-zone` (visible, tinted), `.dag-drop-indicator` (follows cursor), ghost element from palette continues rendering |
| **Keyboard shortcuts** | `Escape` -> cancel drop (forwarded to NodePalette) |
| **Data requirements** | Node type being dragged (from palette event payload). Cursor position converted to canvas coordinates. Node count for limit check. |
| **Transitions** | `palette:drop` (guard: nodeCount < 100) -> create node at drop position -> idle; `palette:drop` (guard: nodeCount >= 100) -> show error toast "Max 100 nodes" -> idle; `palette:drag-end { cancelled }` -> hide drop zone -> idle; cursor leaves canvas -> hide drop zone -> idle (palette keeps dragging) |
| **Error recovery** | If node creation fails (unexpected error), show toast, remove drop indicator, return to idle. Drop zone overlay is always hidden on exit regardless of exit path. |
| **Animation** | Drop zone: fade-in 120ms `ease-out` on entry, fade-out 100ms `ease-in` on exit. Drop indicator: no animation (follows cursor). On successful drop: indicator morphs into real node with 150ms scale animation `cubic-bezier(0.34, 1.56, 0.64, 1)` from 0.9 to 1.0. |

#### canvas.interaction.connecting

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.connecting` |
| **Entry conditions** | `pointerdown` on an output port circle; delegated from `canvas.interaction.idle` to ConnectionManager |
| **Exit conditions** | Connection completed (valid drop on input port) -> `canvas.interaction.idle`; connection cancelled (drop on empty space, `Escape`, `pointercancel`) -> `canvas.interaction.idle` |
| **Visual description** | Preview Bezier path (dashed, accent color, opacity 0.6) follows cursor from source port. All valid target input ports glow accent. Invalid ports dimmed (opacity 0.3). Source node's own ports dimmed (no self-loop). Cursor: `crosshair`. |
| **Active DOM elements** | `.connection-preview` path (visible), all `.dag-node__port--in` ports get `.port--valid-target` or `.port--invalid-target`, source port gets `.port--source-active` |
| **Keyboard shortcuts** | `Escape` -> cancel connection |
| **Data requirements** | Source node ID, source port ID, source port position. All node positions and port positions for target evaluation. Graph adjacency for cycle detection. |
| **Transitions** | Fully managed by C07-ConnectionManager state machine (see [section 4](#4-c07--connectionmanager-17-states)). On exit, ConnectionManager signals canvas to return to idle. |
| **Error recovery** | If source node is deleted during connection drag (e.g., undo), cancel connection and return to idle. ConnectionManager handles all internal error states. |
| **Animation** | Preview path: no animation on position update (rAF). Valid port glow: 150ms `ease-out` fade-in. Port snap magnetism: 100ms spring ease for scale-up. |

#### canvas.interaction.context-menu-open

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.context-menu-open` |
| **Entry conditions** | `contextmenu` event (right-click) on empty canvas area (not on node or port) |
| **Exit conditions** | Click on menu item -> execute action -> `canvas.interaction.idle`; click outside menu -> dismiss -> `canvas.interaction.idle`; `Escape` -> dismiss -> `canvas.interaction.idle` |
| **Visual description** | Context menu appears at cursor position. Menu items: "Add Plain SQL Table" (icon `◇`), "Add SQL MLV" (icon `◆`), "Add PySpark MLV" (icon `◆`), separator, "Auto Arrange" (icon `◊`, disabled if < 2 nodes), "Zoom to Fit" (icon `⊟`, disabled if 0 nodes), separator, "Select All" (`Ctrl+A`). |
| **Active DOM elements** | `.dag-context-menu` (visible, positioned at `contextMenuPosition`), `.dag-context-menu__item` (interactive). All other canvas interactions suppressed. |
| **Keyboard shortcuts** | `ArrowDown`/`ArrowUp` navigate items, `Enter` select item, `Escape` dismiss |
| **Data requirements** | `contextMenuPosition: { clientX, clientY }` for positioning. Canvas coordinates for "Add Node" actions. `nodeCount` for menu item disabled states. |
| **Transitions** | Click item "Add SQL Table" -> `addNode('sql-table', canvasX, canvasY)` -> idle; Click "Auto Arrange" -> `autoLayout()` -> idle; Click outside / `Escape` -> dismiss -> idle |
| **Error recovery** | If menu position is off-screen, reposition to nearest visible corner. If addNode fails (limit reached), show error toast and dismiss menu. |
| **Animation** | Menu appear: `opacity 0->1, translateY(-4px)->0` in 120ms `ease-out`. Menu dismiss: `opacity 1->0` in 80ms `ease-in`. Item hover: background fade 60ms. |

#### canvas.interaction.auto-layouting

| Field | Value |
|-------|-------|
| **State ID** | `canvas.interaction.auto-layouting` |
| **Entry conditions** | `autoLayout()` called via toolbar button, context menu, or `Ctrl+Shift+L` keyboard shortcut |
| **Exit conditions** | Layout animation completes (400ms) -> `canvas.interaction.idle`; interrupted by `Escape` or pointer interaction -> freeze at current positions -> `canvas.interaction.idle` |
| **Visual description** | All nodes animate simultaneously from current positions to Dagre-computed positions. Connections re-route in real-time as nodes move (60fps). Subtle progress indicator on toolbar "Auto Arrange" button (spinner or pulse). Canvas interaction is suppressed during animation (no clicks, drags, or drops). |
| **Active DOM elements** | All `.dag-node` (animating `transform`), all `.connection` paths (re-routed per frame), `.dag-toolbar__auto-arrange-btn.is-running` (spinner) |
| **Keyboard shortcuts** | `Escape` -> interrupt, freeze at current interpolated positions |
| **Data requirements** | Dagre layout result: `Map<nodeId, { x, y }>`. Start positions for all nodes. Connections for re-routing. |
| **Transitions** | Animation completes -> `idle` (push `BatchCommand` of all `MoveNodeCommand`s to undo stack); `Escape` / click / scroll -> freeze at current positions -> `idle` (still push partial move to undo) |
| **Error recovery** | If Dagre computation fails (malformed graph), show toast "Auto-layout failed", stay at current positions, return to idle. If animation stalls (>1s), force-complete at target positions. |
| **Animation** | Nodes: 400ms `cubic-bezier(0.25, 0.1, 0.25, 1.0)` position interpolation. Connections: rAF re-route (no easing, follows nodes). Staggered start: 20ms offset per layer (top-to-bottom visual cascade). |

---

### 1.2 Viewport States

#### canvas.viewport.default

| Field | Value |
|-------|-------|
| **State ID** | `canvas.viewport.default` |
| **Entry conditions** | Initial mount; `resetView()` called; page navigation to Page 3 |
| **Exit conditions** | Any zoom or pan action -> `canvas.viewport.custom` |
| **Visual description** | Zoom 100%, pan (0,0). Canvas origin at top-left of SVG element. Grid dots at default spacing (20px). Zoom display shows "100%". |
| **Active DOM elements** | `.dag-zoom-display` shows "100%", `.dag-zoom-btn--reset` disabled (already at default) |
| **Data requirements** | `viewport: { panX: 0, panY: 0, zoom: 1.0 }` |
| **Transitions** | `wheel`/zoom button -> `custom`; `fitToView()` -> `fit-to-view`; pan action -> `custom` |
| **Animation** | None on entry from mount. 300ms `ease-in-out` when entering from `resetView()`. |

#### canvas.viewport.zoomed-in

| Field | Value |
|-------|-------|
| **State ID** | `canvas.viewport.zoomed-in` |
| **Entry conditions** | Zoom level > 1.0 (above 100%) |
| **Exit conditions** | Zoom returns to <= 1.0 -> `default` or `zoomed-out`; `fitToView()` -> `animating-to-fit` |
| **Visual description** | Content appears larger. Grid dots spaced wider. Zoom display shows ">100%" (e.g., "150%"). Zoom-in button: disabled at 400%. Node detail is crisper -- useful for connection work. |
| **Active DOM elements** | `.dag-zoom-display` shows percentage, `.dag-zoom-btn--in` (disabled at 400%) |
| **Data requirements** | `viewport.zoom` in range (1.0, 4.0] |
| **Transitions** | Further zoom in -> self-loop (capped at 400%); zoom out -> `default` (at 100%) or `zoomed-out` (below 100%); `fitToView()` -> `animating-to-fit` |
| **Animation** | Button zoom: 150ms `ease-out`. Wheel zoom: instant. |

#### canvas.viewport.zoomed-out

| Field | Value |
|-------|-------|
| **State ID** | `canvas.viewport.zoomed-out` |
| **Entry conditions** | Zoom level < 1.0 (below 100%) |
| **Exit conditions** | Zoom returns to >= 1.0 -> `default` or `zoomed-in`; `fitToView()` -> `animating-to-fit` |
| **Visual description** | Content appears smaller -- overview mode. Grid dots spaced tighter. Zoom display shows "<100%" (e.g., "50%"). Zoom-out button: disabled at 25%. Good for seeing full DAG topology. |
| **Active DOM elements** | `.dag-zoom-display` shows percentage, `.dag-zoom-btn--out` (disabled at 25%) |
| **Data requirements** | `viewport.zoom` in range [0.25, 1.0) |
| **Transitions** | Further zoom out -> self-loop (capped at 25%); zoom in -> `default` (at 100%) or `zoomed-in` (above 100%); `fitToView()` -> `animating-to-fit` |
| **Animation** | Same as zoomed-in. |

#### canvas.viewport.animating-to-fit

| Field | Value |
|-------|-------|
| **State ID** | `canvas.viewport.animating-to-fit` |
| **Entry conditions** | `fitToView()` called; OR "Zoom to Fit" clicked in context menu or toolbar |
| **Exit conditions** | Animation completes (300ms) -> `canvas.viewport.fit-to-view`; user interrupts with scroll/pan -> cancel animation, settle at current position -> `canvas.viewport.custom` |
| **Visual description** | Canvas smoothly animates zoom and pan to fit all nodes in view with 60px padding. Zoom capped at 100% (never zooms past 1:1 to fit). All nodes visible within viewport on completion. |
| **Active DOM elements** | All layers animating via `requestAnimationFrame` interpolation on root `<g transform>`. Zoom display animates between percentages. |
| **Data requirements** | Target `{ panX, panY, zoom }` computed from bounding box of all nodes. Current viewport as start values. |
| **Transitions** | Animation complete -> `fit-to-view`; `wheel` during animation -> cancel, freeze at current interpolated position -> `custom`; `pointerdown` -> cancel animation -> appropriate interaction state |
| **Error recovery** | If no nodes exist, `fitToView()` calls `resetView()` instead (-> `default`). If bounding box computation fails, fall back to `resetView()`. |
| **Animation** | 300ms `cubic-bezier(0.25, 0.1, 0.25, 1.0)`. Simultaneous pan + zoom interpolation. Uses rAF with elapsed-time calculation for frame-rate independence. |

#### canvas.viewport.fit-to-view

| Field | Value |
|-------|-------|
| **State ID** | `canvas.viewport.fit-to-view` |
| **Entry conditions** | `animating-to-fit` animation completes |
| **Exit conditions** | Any zoom/pan action -> `canvas.viewport.custom` |
| **Visual description** | All nodes visible within the viewport. Zoom is at computed fit level (<= 100%). Zoom display shows fit percentage. |
| **Active DOM elements** | Same as `default` but at computed fit zoom/pan values |
| **Data requirements** | Computed fit viewport state stored for potential re-fit on resize. |
| **Transitions** | Same as `default` -- any zoom/pan exits to `custom` |
| **Animation** | None (settled). |

#### canvas.viewport.custom

| Field | Value |
|-------|-------|
| **State ID** | `canvas.viewport.custom` |
| **Entry conditions** | Any user-initiated zoom or pan that results in non-default, non-fit viewport |
| **Exit conditions** | `resetView()` -> `default`; `fitToView()` -> `animating-to-fit` |
| **Visual description** | User-defined zoom and pan. Zoom display shows current percentage. Reset button enabled. |
| **Active DOM elements** | `.dag-zoom-btn--reset` (enabled) |
| **Data requirements** | `viewport: { panX, panY, zoom }` at user-defined values |
| **Transitions** | `resetView()` -> `default`; `fitToView()` -> `animating-to-fit`; further zoom/pan -> self-loop |
| **Animation** | Per interaction (see interaction states). |

---

### 1.3 Content States

#### canvas.content.empty

| Field | Value |
|-------|-------|
| **State ID** | `canvas.content.empty` |
| **Entry conditions** | Initial mount with no saved state; all nodes deleted; `clear()` called |
| **Exit conditions** | First node added -> `canvas.content.has-nodes` |
| **Visual description** | Empty state placeholder centered on canvas: muted icon (grid/flow icon), heading "Design Your Data Pipeline", subtext "Drag node types from the palette, or right-click to add nodes." Drop zone overlay subtle gradient. No connections layer content. |
| **Active DOM elements** | `.dag-empty-state` (visible, centered), `.dag-canvas-svg` still interactive (right-click, drop), `.dag-connections-layer` (empty) |
| **Data requirements** | `nodes.length === 0` |
| **Transitions** | Node added (palette drop, context menu, quick-add, template load) -> `has-nodes` |
| **Error recovery** | N/A |
| **Animation** | Placeholder: fade-in 200ms `ease-out` on mount. Fade-out 150ms when first node arrives. |

#### canvas.content.has-nodes

| Field | Value |
|-------|-------|
| **State ID** | `canvas.content.has-nodes` |
| **Entry conditions** | At least one node exists on canvas (`nodes.length >= 1 && nodes.length < 100`) |
| **Exit conditions** | All nodes deleted -> `canvas.content.empty`; 100th node added -> `canvas.content.max-nodes-reached` |
| **Visual description** | Normal operational state. Nodes rendered in nodes layer. Connections in connections layer. Empty-state placeholder hidden. Node count shown in palette as "N / 100 nodes". |
| **Active DOM elements** | `.dag-empty-state` (hidden), all nodes in `.dag-nodes-layer`, all connections in `.dag-connections-layer` |
| **Data requirements** | `1 <= nodes.length < 100` |
| **Transitions** | All nodes removed -> `empty`; 100th node added -> `max-nodes-reached` |
| **Animation** | None (steady state). |

#### canvas.content.max-nodes-reached

| Field | Value |
|-------|-------|
| **State ID** | `canvas.content.max-nodes-reached` |
| **Entry conditions** | 100th node added to canvas (`nodes.length === 100`) |
| **Exit conditions** | Any node deleted (`nodes.length < 100`) -> `canvas.content.has-nodes` |
| **Visual description** | Node counter shows "100 / 100" in `var(--status-fail)` red. NodePalette transitions to disabled. Context menu "Add" items disabled. Attempting to add a node (any method) shows toast: "Maximum 100 nodes reached. Delete a node to add more." |
| **Active DOM elements** | NodePalette disabled (greyed cards), context menu add items `disabled`, toast on attempted add |
| **Data requirements** | `nodes.length === 100` |
| **Transitions** | Node deleted -> `has-nodes` (palette re-enables) |
| **Error recovery** | If count exceeds 100 due to bug (e.g., race condition during template load), reject excess nodes and clamp to 100. Log error. |
| **Animation** | Counter text: color transition 200ms to red. Toast: standard toast animation (slide-in from top, 3s auto-dismiss). |

#### canvas.content.loading-template

| Field | Value |
|-------|-------|
| **State ID** | `canvas.content.loading-template` |
| **Entry conditions** | `fromJSON(state)` called during template load or wizard back-navigation to Page 3 with existing state |
| **Exit conditions** | Deserialization and rendering complete -> `canvas.content.has-nodes`; deserialization fails -> `canvas.content.empty` (with error toast) |
| **Visual description** | Brief loading state: canvas dims slightly (opacity 0.7). Overlay with "Loading..." spinner centered. Nodes and connections are created in batch (no individual animations). After load, `fitToView()` is called to frame all restored content. |
| **Active DOM elements** | `.dag-canvas-loading` (overlay with spinner), canvas content dims |
| **Keyboard shortcuts** | All suppressed during load. |
| **Data requirements** | Serialized `CanvasState` JSON from template or wizard state manager. |
| **Transitions** | Load success (nodes.length > 0) -> `has-nodes` (+ `fitToView()`); load success (nodes.length === 0) -> `empty`; load failure (invalid JSON, missing nodes) -> `empty` + error toast |
| **Error recovery** | If individual nodes fail to deserialize, skip them and log warning. If connections reference non-existent nodes, skip those connections. Partial load is accepted. On total failure, clear canvas to `empty` state. |
| **Animation** | Loading overlay: fade-in 100ms. Content appears: batch render (no per-node animation). After load: `fitToView()` with 300ms ease. Overlay fade-out: 100ms. |

---

### 1.4 Selection States

#### canvas.selection.none

| Field | Value |
|-------|-------|
| **State ID** | `canvas.selection.none` |
| **Entry conditions** | `deselectAll()` called; click on empty canvas; `Escape` pressed; initial mount |
| **Exit conditions** | Click on node -> `single-node`; Ctrl+click node -> `multi-node`; marquee select -> `multi-node`; click connection -> `single-connection` |
| **Visual description** | No nodes or connections have selection glow. Delete key does nothing. Property panel (if exists) shows "No selection." Undo/redo toolbar buttons reflect stack availability. |
| **Active DOM elements** | No `.dag-node.is-selected`, no `.connection.is-selected` |
| **Data requirements** | `selectedNodeIds.size === 0 && selectedConnectionIds.size === 0` |
| **Transitions** | Click node -> `single-node`; Ctrl+click -> `multi-node`; marquee -> `multi-node`; click connection -> `single-connection`; Ctrl+A -> `multi-node` (all nodes) |
| **Animation** | Selection ring fade-out 150ms `ease-in` on previously selected nodes. |

#### canvas.selection.single-node

| Field | Value |
|-------|-------|
| **State ID** | `canvas.selection.single-node` |
| **Entry conditions** | Click (without Ctrl) on a single node; node created via drop (auto-selected) |
| **Exit conditions** | Click on different node -> `single-node` (swap); Ctrl+click another -> `multi-node`; click empty -> `none`; `Escape` -> `none`; click connection -> `single-connection`; `Ctrl+A` -> `multi-node` |
| **Visual description** | Selected node shows accent border + glow ring (`0 0 0 3px var(--accent-glow)`). Ports visible on selected node. Delete key available. Clicking selected node again opens popover. |
| **Active DOM elements** | Exactly one `.dag-node.is-selected`. That node's ports visible. |
| **Data requirements** | `selectedNodeIds.size === 1` |
| **Transitions** | Click same node (already selected) -> open popover (stay `single-node`); Click different node -> deselect old, select new (stay `single-node`); Ctrl+click another -> `multi-node`; Click empty / `Escape` -> `none`; `Delete` -> delete node -> `none` |
| **Animation** | Selection ring: 150ms `cubic-bezier(0.34, 1.56, 0.64, 1)` spring scale-in (0.95 -> 1.0 with glow). |

#### canvas.selection.multi-node

| Field | Value |
|-------|-------|
| **State ID** | `canvas.selection.multi-node` |
| **Entry conditions** | Ctrl+click to add second node; marquee selection enclosing 2+ nodes; `Ctrl+A` with 2+ nodes |
| **Exit conditions** | Ctrl+click to deselect down to 1 -> `single-node`; deselect down to 0 -> `none`; click on empty -> `none`; `Escape` -> `none` |
| **Visual description** | Multiple nodes show accent border + glow rings. Popover does NOT open (ambiguous target). Dragging one selected node moves all. Delete removes all selected. Schema/type changes in batch mode (future). |
| **Active DOM elements** | Multiple `.dag-node.is-selected`, all their ports visible |
| **Data requirements** | `selectedNodeIds.size >= 2` |
| **Transitions** | Ctrl+click selected node -> toggle off, if remaining === 1 -> `single-node`, if 0 -> `none`; Click non-selected node (no Ctrl) -> deselect all, select clicked -> `single-node`; Click empty / `Escape` -> `none`; `Delete` -> delete all selected -> `none` |
| **Animation** | Same selection ring animation per node. Batch delete: staggered fade-out, 50ms offset per node, max 200ms total. |

#### canvas.selection.single-connection

| Field | Value |
|-------|-------|
| **State ID** | `canvas.selection.single-connection` |
| **Entry conditions** | Click on a connection path (hit-test: point-to-Bezier distance < 8px / zoomLevel) |
| **Exit conditions** | Click on node -> `single-node`; click on empty -> `none`; `Escape` -> `none`; `Delete` -> delete connection -> `none` |
| **Visual description** | Selected connection: stroke changes to `var(--accent)`, stroke-width 2.5px, opacity 1.0. Arrowhead uses `#arrowhead-active` marker. Source and target ports highlighted. |
| **Active DOM elements** | One `.connection.is-selected`, source/target port circles highlighted |
| **Data requirements** | `selectedConnectionIds.size === 1`, `selectedNodeIds.size === 0` |
| **Transitions** | `Delete`/`Backspace` -> remove connection -> `none`; click node -> `single-node`; click empty / `Escape` -> `none` |
| **Animation** | Connection highlight: 100ms `ease-out` stroke color + width transition. |

---

### 1.5 Cross-Cutting States

#### canvas.undo-available

| Field | Value |
|-------|-------|
| **State ID** | `canvas.undo-available` |
| **Entry conditions** | Any mutation pushed to undo stack (add/remove node, add/remove connection, move node, edit property) |
| **Exit conditions** | Undo stack emptied (all undone without new mutations) |
| **Visual description** | Undo button in toolbar/palette: enabled (full opacity). `Ctrl+Z` active. Badge or counter optionally showing stack depth. |
| **Active DOM elements** | `.dag-toolbar__undo-btn` (enabled, opacity 1.0) |
| **Transitions** | Orthogonal state -- composable with any other state. `Ctrl+Z` -> execute undo, if stack now empty -> `undo-unavailable`. |

#### canvas.redo-available

| Field | Value |
|-------|-------|
| **State ID** | `canvas.redo-available` |
| **Entry conditions** | Undo performed (redo stack gains an entry); redo stack is non-empty |
| **Exit conditions** | New mutation performed (redo stack cleared); all redo entries re-applied |
| **Visual description** | Redo button: enabled. `Ctrl+Y` / `Ctrl+Shift+Z` active. |
| **Active DOM elements** | `.dag-toolbar__redo-btn` (enabled, opacity 1.0) |
| **Transitions** | Orthogonal. `Ctrl+Y` -> execute redo. New mutation -> clear redo stack -> `redo-unavailable`. |

---

## 2. C05 -- NodePalette (14 states)

### 2.0 State Namespace

All NodePalette state IDs use the prefix `palette.`.

---

#### palette.expanded

| Field | Value |
|-------|-------|
| **State ID** | `palette.expanded` |
| **Entry conditions** | Initial mount (default); `expand()` called; drag ends; command palette closes; `setNodeCount(n < 100)` from disabled state |
| **Exit conditions** | `collapse()` or toggle button -> `palette.collapsed`; mousedown+move > 4px on card -> `palette.drag-started`; `setNodeCount(100)` -> `palette.disabled`; `/` key -> `palette.command-open` |
| **Visual description** | Full 180px wide sidebar. Header "Add Nodes" with collapse toggle `[<]`. 3 node type cards stacked vertically with dashed border, icon, name, and description. Node counter "N / 100 nodes" at bottom. Cards have `cursor: grab`. |
| **Active DOM elements** | `.dag-palette` (width 180px), `.dag-palette__header`, `.dag-palette__card` x3 (interactive), `.dag-palette__counter`, `.dag-palette__collapse-btn` |
| **Keyboard shortcuts** | `/` open command palette, `Tab` cycle cards, `Enter` on focused card -> quick-add |
| **Data requirements** | `NODE_TYPES` array (3 entries), `nodeCount`, `maxNodes: 100` |
| **Transitions** | Toggle button -> `collapsed`; mousedown on card -> `drag-pending`; double-click card -> quick-add (stays `expanded`); `/` key -> `command-open`; `setNodeCount(100)` -> `disabled` |
| **Error recovery** | If DOM is corrupted on expand, re-render full palette. |
| **Animation** | Expand from collapsed: width `44px -> 180px`, 200ms `cubic-bezier(0.25, 0.1, 0.25, 1.0)`. Card text fades in 150ms (staggered 30ms per card). |

#### palette.collapsed

| Field | Value |
|-------|-------|
| **State ID** | `palette.collapsed` |
| **Entry conditions** | `collapse()` called; toggle button clicked from expanded |
| **Exit conditions** | `expand()` or toggle button -> `palette.expanded`; click on collapsed icon -> `palette.expanded`; `/` key -> `palette.command-open` (auto-expands) |
| **Visual description** | Narrow 44px strip. Only node type icons visible vertically (no text). Tooltip on hover shows full name + description. Expand toggle `[>]` at top. |
| **Active DOM elements** | `.dag-palette.is-collapsed` (width 44px), `.dag-palette__icon-strip` (visible), `.dag-palette__card-text` (hidden) |
| **Keyboard shortcuts** | `/` open command palette, `Tab` cycle icons |
| **Data requirements** | Same as expanded. |
| **Transitions** | Toggle button -> `expanded`; click icon -> `expanded` + optional quick-add; `/` key -> expand first, then `command-open` |
| **Error recovery** | N/A |
| **Animation** | Collapse: width `180px -> 44px`, 200ms `cubic-bezier(0.25, 0.1, 0.25, 1.0)`. Card text fades out 100ms before width animation starts. Icons slide into centered position. |

#### palette.disabled

| Field | Value |
|-------|-------|
| **State ID** | `palette.disabled` |
| **Entry conditions** | `setNodeCount(n)` where `n >= 100`; OR `setEnabled(false)` called |
| **Exit conditions** | `setNodeCount(n)` where `n < 100` -> `palette.expanded`; OR `setEnabled(true)` |
| **Visual description** | All cards greyed out: opacity 0.35, cursor `not-allowed`. Counter shows "100 / 100" in `var(--status-fail)`. Tooltip on cards: "Maximum 100 nodes reached." No drag interaction. Command palette shortcut disabled. |
| **Active DOM elements** | `.dag-palette.is-disabled`, all `.dag-palette__card.is-disabled` |
| **Keyboard shortcuts** | None active. All palette shortcuts suppressed. |
| **Data requirements** | `nodeCount >= maxNodes` |
| **Transitions** | `setNodeCount(n < 100)` -> `expanded` (or `collapsed` if was collapsed before disabling); `setEnabled(true)` -> `expanded` |
| **Error recovery** | If `setNodeCount` receives NaN or negative, treat as 0 and enable. |
| **Animation** | Disable: cards fade to 0.35 opacity over 200ms. Counter text color transition to red 200ms. Enable: reverse animation, 200ms. |

#### palette.drag-pending

| Field | Value |
|-------|-------|
| **State ID** | `palette.drag-pending` |
| **Entry conditions** | `pointerdown` on a palette card in `expanded` state |
| **Exit conditions** | `pointermove` > 4px from start -> `palette.drag-started`; `pointerup` < 4px -> treat as click (no drag) -> `palette.expanded` |
| **Visual description** | No visual change. Card pressed state (subtle darken via `:active`). Dead-zone detection active. |
| **Active DOM elements** | Pressed card with `:active` pseudo-class |
| **Data requirements** | `{ startX, startY, startTime, nodeTypeId, sourceElement }` |
| **Transitions** | Mouse moves > 4px -> `drag-started`; mouse up -> `expanded` (treat as click) |
| **Error recovery** | `pointercancel` -> `expanded` |
| **Animation** | None (sub-100ms state). |

#### palette.drag-started

| Field | Value |
|-------|-------|
| **State ID** | `palette.drag-started` |
| **Entry conditions** | Movement exceeds 4px dead zone from `drag-pending` |
| **Exit conditions** | Immediate transition to `palette.dragging-over-palette` or `palette.dragging-over-canvas` depending on cursor position |
| **Visual description** | Ghost element created: semi-transparent clone of the card (opacity 0.8) positioned at cursor. Source card dims to opacity 0.4. Cursor: `grabbing`. `palette:drag-start` event emitted. |
| **Active DOM elements** | `.dag-palette__ghost` (created, follows cursor), source `.dag-palette__card.is-dragging-source` (dimmed) |
| **Data requirements** | `DragPayload { nodeTypeId, cursorOffset, sourceElement, startTime, startPosition }` |
| **Transitions** | Cursor over palette area -> `dragging-over-palette`; cursor over canvas -> `dragging-over-canvas`; `Escape` -> `drag-cancelled` |
| **Error recovery** | If ghost element creation fails, cancel drag and return to `expanded`. |
| **Animation** | Ghost: instant creation at cursor position. Source card: opacity `1.0 -> 0.4` in 80ms. |

#### palette.dragging-over-palette

| Field | Value |
|-------|-------|
| **State ID** | `palette.dragging-over-palette` |
| **Entry conditions** | Cursor is over palette area (not over canvas) during active drag |
| **Exit conditions** | Cursor enters canvas boundary -> `palette.dragging-over-canvas`; `mouseup` -> `palette.drag-cancelled`; `Escape` -> `palette.drag-cancelled` |
| **Visual description** | Ghost follows cursor. Ghost appearance: normal card styling, opacity 0.8. Cursor: `grabbing`. No drop zone indicator on canvas. |
| **Active DOM elements** | `.dag-palette__ghost` (following cursor), source card dimmed |
| **Data requirements** | Active `DragPayload`. Cursor position tracking. |
| **Transitions** | Cursor enters canvas -> `dragging-over-canvas`; cursor exits palette to non-canvas area -> `dragging-over-invalid`; `mouseup` here -> `drag-cancelled`; `Escape` -> `drag-cancelled` |
| **Error recovery** | If cursor tracking is lost, cancel drag. |
| **Animation** | Ghost: tracks cursor at 60fps via `pointermove`. No easing (1:1 tracking). |

#### palette.dragging-over-canvas

| Field | Value |
|-------|-------|
| **State ID** | `palette.dragging-over-canvas` |
| **Entry conditions** | Cursor enters canvas SVG boundary during active drag; canvas fires `canvas:drop-zone-enter` |
| **Exit conditions** | `mouseup` on canvas (nodeCount < 100) -> `palette.drop-completed`; cursor leaves canvas -> `palette.dragging-over-palette` or `palette.dragging-over-invalid`; `mouseup` on canvas (nodeCount >= 100) -> error toast -> `palette.drag-cancelled`; `Escape` -> `palette.drag-cancelled` |
| **Visual description** | Ghost gets green-tinted accent glow. Cursor: `copy`. Canvas shows drop zone overlay (subtle blue tint). Drop position indicator on canvas follows cursor (translucent node silhouette). |
| **Active DOM elements** | `.dag-palette__ghost.is-over-canvas` (accent glow), canvas `.dag-canvas-drop-zone` (visible) |
| **Data requirements** | Active `DragPayload` + `isOverDropZone: true`. Canvas viewport for coordinate conversion. |
| **Transitions** | `mouseup` (guard: count < 100) -> `drop-completed`; `mouseup` (guard: count >= 100) -> toast -> `drag-cancelled`; cursor leaves canvas -> `dragging-over-palette` or `dragging-over-invalid`; `Escape` -> `drag-cancelled` |
| **Error recovery** | If canvas rejects the drop (e.g., position calculation fails), fall back to `drag-cancelled`. |
| **Animation** | Ghost accent glow: 100ms `ease-out`. Drop zone overlay: fade-in 120ms. Position indicator: no animation (1:1 tracking). |

#### palette.dragging-over-invalid

| Field | Value |
|-------|-------|
| **State ID** | `palette.dragging-over-invalid` |
| **Entry conditions** | Cursor is outside both palette and canvas during active drag (e.g., over the wizard chrome, other panels) |
| **Exit conditions** | Cursor re-enters canvas -> `palette.dragging-over-canvas`; cursor re-enters palette -> `palette.dragging-over-palette`; `mouseup` -> `palette.drag-cancelled`; `Escape` -> `palette.drag-cancelled` |
| **Visual description** | Ghost has red tint / `not-allowed` overlay. Cursor: `not-allowed`. Canvas drop zone hidden. |
| **Active DOM elements** | `.dag-palette__ghost.is-invalid` (red tint, opacity 0.5) |
| **Data requirements** | Active `DragPayload`. `isOverDropZone: false`. |
| **Transitions** | Cursor re-enters canvas -> `dragging-over-canvas`; cursor re-enters palette -> `dragging-over-palette`; `mouseup` -> `drag-cancelled`; `Escape` -> `drag-cancelled` |
| **Error recovery** | Same as `dragging-over-palette`. |
| **Animation** | Ghost tint change: 80ms transition. |

#### palette.drop-completed

| Field | Value |
|-------|-------|
| **State ID** | `palette.drop-completed` |
| **Entry conditions** | `mouseup` on canvas with valid drop (nodeCount < 100) |
| **Exit conditions** | Automatic transition after animation -> `palette.expanded` |
| **Visual description** | Ghost element animates: shrinks toward drop position and fades out (150ms). Source card un-dims (opacity `0.4 -> 1.0`). Node count increments. Canvas creates the new node at drop position. `palette:drop` event emitted. |
| **Active DOM elements** | Ghost (animating out), source card (animating back to full opacity) |
| **Data requirements** | `{ nodeTypeId, canvasPosition }` for the `palette:drop` event. |
| **Transitions** | Automatic after 150ms -> `expanded` |
| **Error recovery** | If node creation fails on canvas side, show error toast. Ghost still cleaned up. Return to `expanded`. |
| **Animation** | Ghost: `scale(1) -> scale(0.5)` + `opacity 0.8 -> 0` in 150ms `ease-in`. Source card: `opacity 0.4 -> 1.0` in 150ms `ease-out`. |

#### palette.drag-cancelled

| Field | Value |
|-------|-------|
| **State ID** | `palette.drag-cancelled` |
| **Entry conditions** | `Escape` key during any drag state; `mouseup` outside canvas; `wizard:page-changed` event during drag; nodeCount >= 100 on attempted drop |
| **Exit conditions** | Automatic transition after animation -> `palette.expanded` |
| **Visual description** | Ghost animates back to source card position (spring snap-back, 120ms). Source card un-dims. Drop zone overlay removed from canvas. `palette:drag-end { cancelled: true }` event emitted. ARIA announcement: "Drag cancelled." |
| **Active DOM elements** | Ghost (animating back to source), source card (un-dimming) |
| **Data requirements** | Source card DOM rect for snap-back target. |
| **Transitions** | Automatic after 120ms -> `expanded` |
| **Error recovery** | If source card no longer exists (palette re-rendered), just fade ghost out in place. |
| **Animation** | Ghost snap-back: `translate(current) -> translate(sourceCardRect)` in 120ms `cubic-bezier(0.34, 1.56, 0.64, 1)` spring. Source card: `opacity 0.4 -> 1.0` in 120ms. |

#### palette.quick-add-flash

| Field | Value |
|-------|-------|
| **State ID** | `palette.quick-add-flash` |
| **Entry conditions** | Double-click on palette card (quick-add); OR `Enter` pressed on focused card via keyboard navigation |
| **Exit conditions** | Automatic transition after flash animation (200ms) -> `palette.expanded` |
| **Visual description** | Clicked card flashes accent border (pulse animation, 200ms): border color cycles `transparent -> var(--accent) -> transparent`. Card briefly scales to 1.02x and back. `palette:quick-add` event emitted. Canvas creates node at computed next-available position (staggered grid). Node counter increments. |
| **Active DOM elements** | `.dag-palette__card.is-quick-adding` (accent border pulse, scale pulse) |
| **Keyboard shortcuts** | None (sub-200ms transient state). |
| **Data requirements** | `nodeTypeId` of double-clicked card. Guard: `canQuickAdd` (expanded, count < 100). |
| **Transitions** | Automatic after 200ms -> `expanded` |
| **Error recovery** | If node creation fails (count >= 100, race condition), show toast, card flash turns red instead of accent. |
| **Animation** | Card border: `transparent -> var(--accent)` at 0ms, `var(--accent) -> transparent` at 200ms. Card scale: `1.0 -> 1.02 -> 1.0` in 200ms `ease-in-out`. |

#### palette.command-open

| Field | Value |
|-------|-------|
| **State ID** | `palette.command-open` |
| **Entry conditions** | `/` key pressed when palette is focused or canvas is focused (from `expanded` or `collapsed`) |
| **Exit conditions** | `Escape` -> `palette.expanded`; `Enter` on selection -> execute quick-add -> `palette.expanded`; click outside popup -> `palette.expanded` |
| **Visual description** | Floating popup anchored to palette top-right (or viewport center if palette collapsed). Search input field with placeholder "Add node...". List of 3 node types with icons, names. Arrow-key navigation highlights current selection with accent background. Filter text narrows visible options. |
| **Active DOM elements** | `.dag-command-palette` (visible), `.dag-command-palette__input` (focused), `.dag-command-palette__option` x3 (filterable), `.dag-command-palette__option.is-selected` (keyboard-highlighted) |
| **Keyboard shortcuts** | `ArrowDown`/`ArrowUp` navigate, `Enter` select, `Escape` close, typing filters list |
| **Data requirements** | `NODE_TYPES` for options. `commandPaletteQuery` for filtering. `commandPaletteSelectedIndex` for keyboard nav. |
| **Transitions** | Type text -> filter options (self-loop); `ArrowDown` -> increment index (self-loop, wrap); `ArrowUp` -> decrement index (self-loop, wrap); `Enter` -> emit `palette:command-select` -> `expanded`; `Escape` / click outside -> `expanded` |
| **Error recovery** | If no results match filter, show "No matching node types" message. `Enter` on empty results does nothing. |
| **Animation** | Popup appear: `opacity 0->1, scale(0.95)->scale(1)` in 120ms `ease-out`. Dismiss: `opacity 1->0` in 80ms. Selection highlight: 60ms background fade. |

#### palette.command-filtering

| Field | Value |
|-------|-------|
| **State ID** | `palette.command-filtering` |
| **Entry conditions** | User types in command palette search input |
| **Exit conditions** | Search cleared -> `palette.command-open` (full list); selection made -> `palette.expanded`; `Escape` -> `palette.expanded` |
| **Visual description** | Search input shows typed text. List filters in real-time. Non-matching options slide out. Matched options show highlighted matching characters (bold substring). Selected index resets to 0 on filter change. |
| **Active DOM elements** | `.dag-command-palette__input` (has text), filtered `.dag-command-palette__option` items |
| **Data requirements** | `commandPaletteQuery` (current filter text). `commandPaletteResults` (filtered `NODE_TYPES`). |
| **Transitions** | Continue typing -> self-loop (re-filter); backspace to empty -> `command-open`; `Enter` -> select filtered item -> `expanded`; `Escape` -> `expanded` |
| **Error recovery** | If all options filtered out, show "No matching node types." |
| **Animation** | Filter results: 80ms height transition per option (slide out/in). Match highlighting: instant (no animation). |

#### palette.command-selected

| Field | Value |
|-------|-------|
| **State ID** | `palette.command-selected` |
| **Entry conditions** | `Enter` pressed with a valid highlighted option in command palette |
| **Exit conditions** | Automatic transition after node creation -> `palette.expanded` |
| **Visual description** | Selected option flashes accent background (100ms pulse). Popup closes. Node created at cursor position (or viewport center). `palette:command-select` event emitted. |
| **Active DOM elements** | Selected option with `.is-confirmed` flash, then popup removed |
| **Data requirements** | Selected `nodeTypeId`. Cursor position or viewport center for placement. |
| **Transitions** | Automatic -> `expanded` (after popup close animation, 80ms) |
| **Error recovery** | If node creation fails (count >= 100), show toast, still close palette. |
| **Animation** | Option flash: accent background 100ms `ease-in-out`. Popup close: 80ms `ease-in` opacity fade. |

---

## 3. C06 -- DagNode (22 states)

### 3.0 State Namespace

All DagNode state IDs use the prefix `node.`. States are organized into four dimensions:

| Dimension | Prefix | Description |
|-----------|--------|-------------|
| Body | `node.body.*` | Core visual/interaction state of the node |
| Port | `node.port.*` | Connection port visibility and interaction |
| Popover | `node.popover.*` | Popover editor lifecycle |
| Name | `node.name.*` | Inline name editing states |

---

### 3.1 Body States

#### node.body.idle

| Field | Value |
|-------|-------|
| **State ID** | `node.body.idle` |
| **Entry conditions** | Node created and not hovered/selected/dragged. Click on empty canvas from selected state. `Escape` from selected. Another node selected (exclusive). |
| **Exit conditions** | Mouse enters node -> `node.body.hovered`; click on node -> `node.body.selected`; `Ctrl+A` -> `node.body.multi-selected`; canvas connection drag starts -> `node.body.connection-target-idle` |
| **Visual description** | Default border `rgba(0,0,0,0.12)` 1.5px, `fill: white`, `rx: 10`. No glow ring. Type icon in `.dag-node__icon`. Name in `.dag-node__name`. Type badge + schema badge in `.dag-node__meta`. Subtle `drop-shadow(0 1px 3px rgba(0,0,0,0.08))`. |
| **Active DOM elements** | `.dag-node__bg` (default stroke), `.dag-node__selection-ring` (opacity 0), `.dag-node__content` (visible), ports (opacity 0 -- hidden) |
| **Keyboard shortcuts** | None (node does not have focus) |
| **Data requirements** | `DagNodeData { id, name, type, schema, position, size }` |
| **Transitions** | `mouseenter` -> `hovered`; `pointerdown` -> `selected`; `canvas:connectiondragstart` -> `connection-target-idle`; external `selectNode(id)` -> `selected`; external `selectAll()` -> `multi-selected` |
| **Error recovery** | N/A (resting state) |
| **Animation** | None. |

#### node.body.hovered

| Field | Value |
|-------|-------|
| **State ID** | `node.body.hovered` |
| **Entry conditions** | Mouse pointer enters node bounding box |
| **Exit conditions** | Mouse leaves node -> `node.body.idle`; click -> `node.body.selected`; `pointerdown` + drag -> `node.body.dragging` |
| **Visual description** | Border brightens to `rgba(0,0,0,0.22)`. Shadow lifts: `drop-shadow(0 2px 8px rgba(0,0,0,0.12))`. Ports fade in (both input and output, where applicable). Cursor: `pointer`. |
| **Active DOM elements** | `.dag-node__bg` (brighter stroke), ports `.dag-node__port` (opacity 0 -> 1), `.dag-node__port-hit` (active for click detection) |
| **Keyboard shortcuts** | None |
| **Data requirements** | Same as idle. |
| **Transitions** | `mouseleave` -> `idle`; `pointerdown` (no movement) -> `selected`; `pointerdown` + move > 4px -> `dragging` |
| **Error recovery** | If `mouseleave` not fired (e.g., element removed), idle is restored on next global interaction. |
| **Animation** | Border: 100ms `ease-out`. Shadow: 100ms `ease-out`. Ports: `opacity 0 -> 1` in 150ms `ease-out`. |

#### node.body.selected

| Field | Value |
|-------|-------|
| **State ID** | `node.body.selected` |
| **Entry conditions** | Click on node (not port, not popover); node created (auto-selected); external `selectNode(id, false)` |
| **Exit conditions** | Click elsewhere -> `idle`; `Escape` -> `idle`; Ctrl+click another node -> `multi-selected`; `pointerdown` + drag -> `dragging`; click on already-selected node -> open popover (stays `selected`); another node clicked (no Ctrl) -> `idle` |
| **Visual description** | Accent border `var(--accent)`. Glow ring visible: `.dag-node__selection-ring` opacity 1.0 with `filter: url(#glow)`. Ports persistently visible. Cursor: `pointer` (over body), `grab` (if about to drag). |
| **Active DOM elements** | `.dag-node.is-selected`, `.dag-node__selection-ring` (opacity 1.0), ports visible |
| **Keyboard shortcuts** | `Delete`/`Backspace` -> delete node; `Enter` -> open popover; `Escape` -> deselect |
| **Data requirements** | Node in `selectedNodeIds` set. |
| **Transitions** | Click on selected node -> open popover; `pointerdown` + drag > 4px -> `dragging`; `Delete` -> `deleting`; `Escape` / click elsewhere -> `idle`; Ctrl+click another -> `multi-selected` |
| **Error recovery** | If selected node is deleted externally (undo by another component), remove from selection and return to idle. |
| **Animation** | Selection ring: `opacity 0 -> 1` + `scale(0.95) -> scale(1)` in 150ms `cubic-bezier(0.34, 1.56, 0.64, 1)`. |

#### node.body.multi-selected

| Field | Value |
|-------|-------|
| **State ID** | `node.body.multi-selected` |
| **Entry conditions** | Ctrl+click to add to selection (when another node already selected); marquee selection enclosing this node + others; `Ctrl+A` |
| **Exit conditions** | Ctrl+click this node -> `idle` (toggle off); click elsewhere -> `idle` (deselect all); click non-selected node (no Ctrl) -> `idle`; `Escape` -> `idle` |
| **Visual description** | Same accent border + glow ring as `selected`. All multi-selected nodes share the visual. Popover does NOT open in multi-select mode. Dragging one moves all. |
| **Active DOM elements** | `.dag-node.is-selected.is-multi` |
| **Keyboard shortcuts** | `Delete` -> delete all selected; `Escape` -> deselect all |
| **Data requirements** | This node's ID in `selectedNodeIds` where `selectedNodeIds.size >= 2` |
| **Transitions** | Ctrl+click this -> `idle` (removed from selection); drag any selected -> `dragging` (all move); `Delete` -> `deleting`; `Escape` -> `idle` |
| **Error recovery** | If this node deleted while multi-selected, remove from set. If set shrinks to 1, remaining transitions to `selected`. |
| **Animation** | Same as `selected`. |

#### node.body.dragging

| Field | Value |
|-------|-------|
| **State ID** | `node.body.dragging` |
| **Entry conditions** | `pointerdown` on node body + movement exceeds 4px dead zone |
| **Exit conditions** | `pointerup` -> commit position -> `node.body.selected`; `Escape` -> revert to start position -> `node.body.selected` |
| **Visual description** | Node opacity 0.92. Elevated shadow `drop-shadow(0 4px 12px rgba(0,0,0,0.15))`. Cursor: `grabbing`. Ports hidden. Popover auto-closed if was open. Position updates at 60fps snapped to 20px grid. |
| **Active DOM elements** | `.dag-node.is-dragging` (opacity 0.92, elevated shadow), ports (hidden) |
| **Keyboard shortcuts** | `Escape` -> revert drag to start position |
| **Data requirements** | `dragTarget { nodeId, offsetX, offsetY, startX, startY }`. All selected node IDs for multi-drag. |
| **Transitions** | `pointermove` -> update position (self-loop, 60fps rAF, 20px grid snap); `pointerup` -> commit `MoveNodeCommand` -> `selected`; `Escape` -> revert positions -> `selected` |
| **Error recovery** | If `pointercancel` fires, treat as `Escape` (revert). |
| **Animation** | Position: no easing (1:1 tracking with grid snap). On `Escape` revert: 150ms `cubic-bezier(0.34, 1.56, 0.64, 1)` spring back. Opacity/shadow changes: instant on enter, 150ms restore on exit. |

#### node.body.drag-complete

| Field | Value |
|-------|-------|
| **State ID** | `node.body.drag-complete` |
| **Entry conditions** | `pointerup` from `dragging` state (position actually changed from start) |
| **Exit conditions** | Immediate transition after undo command created -> `node.body.selected` |
| **Visual description** | Node settles at final grid-snapped position. Shadow returns to normal. Opacity returns to 1.0. `MoveNodeCommand` (or `BatchCommand` for multi-drag) pushed to undo stack. `node:dragend` event emitted. |
| **Active DOM elements** | `.dag-node` (removing `.is-dragging`), connections re-routed to final positions |
| **Data requirements** | Old position(s), new position(s) for undo command. |
| **Transitions** | Automatic -> `selected` (immediate) |
| **Error recovery** | If undo command creation fails, position still committed (just not undoable). Log error. |
| **Animation** | Shadow: `drop-shadow(elevated) -> drop-shadow(default)` in 150ms `ease-out`. Opacity: `0.92 -> 1.0` in 150ms. |

---

### 3.2 Port States

#### node.port.hidden

| Field | Value |
|-------|-------|
| **State ID** | `node.port.hidden` |
| **Entry conditions** | Default state when node is idle and not in connection mode. Mouse leaves node (after hover). Node drag starts. |
| **Exit conditions** | `mouseenter` on node -> `node.port.visible`; node selected -> `node.port.visible`; `canvas:connectiondragstart` -> `node.port.valid-target` or `node.port.invalid-target`; port already has connection -> `node.port.connected` (always visible) |
| **Visual description** | Port circles: `opacity: 0`. Hit areas still active (transparent circles with larger radius for potential interaction). |
| **Active DOM elements** | `.dag-node__port` (opacity 0), `.dag-node__port-hit` (transparent, r=12, still in DOM for future hit detection) |
| **Data requirements** | Port configuration from node type. |
| **Transitions** | Node hovered -> `visible`; node selected -> `visible`; connection drag starts globally -> `valid-target` or `invalid-target` |
| **Error recovery** | N/A |
| **Animation** | Fade-out from `visible`: `opacity 1 -> 0` in 150ms `ease-in`. |

#### node.port.visible

| Field | Value |
|-------|-------|
| **State ID** | `node.port.visible` |
| **Entry conditions** | Node hovered; node selected; connection drag ended (ports remain visible briefly) |
| **Exit conditions** | Node un-hovered + not selected -> `node.port.hidden`; connection drag starts -> `node.port.valid-target` or `node.port.invalid-target` |
| **Visual description** | Port circles visible: `fill: var(--text-muted)`, `stroke: white`, stroke-width 1.5px, r=4px. Neutral appearance -- no glow. |
| **Active DOM elements** | `.dag-node__port` (opacity 1), `.dag-node__port-hit` (active) |
| **Data requirements** | Port exists for this node type (SQL Tables: output only; MLVs: input + output). |
| **Transitions** | Node idle + not hovered -> `hidden`; connection drag starts -> `valid-target` or `invalid-target` |
| **Error recovery** | N/A |
| **Animation** | Fade-in: `opacity 0 -> 1` in 150ms `ease-out`. |

#### node.port.connection-source-active

| Field | Value |
|-------|-------|
| **State ID** | `node.port.connection-source-active` |
| **Entry conditions** | `pointerdown` on this specific port -- user is initiating a connection from this port |
| **Exit conditions** | Connection completed or cancelled -> `node.port.visible` |
| **Visual description** | Source port: filled `var(--accent)`, scale 1.2x, pulsing glow. This is the port from which the connection drag originates. |
| **Active DOM elements** | `.dag-node__port.is-source-active` (accent fill, scaled) |
| **Data requirements** | Port ID, port position (for Bezier start point). |
| **Transitions** | Connection created / cancelled -> `visible` |
| **Error recovery** | If connection manager state is reset externally, restore port to `visible`. |
| **Animation** | Scale: `1.0 -> 1.2` in 100ms spring. Glow: `box-shadow` pulse (subtle throb, 1s infinite). |

#### node.port.valid-target

| Field | Value |
|-------|-------|
| **State ID** | `node.port.valid-target` |
| **Entry conditions** | Global connection drag starts (`canvas:connectiondragstart`) AND this port is a valid target (correct polarity, no self-loop, no cycle, not already connected from same source) |
| **Exit conditions** | Connection drag ends -> `node.port.visible` or `node.port.hidden`; cursor enters magnetic radius -> `node.port.hovered-target` |
| **Visual description** | Port: `fill: var(--accent)`, stroke `var(--surface)`, 1.5px, r=4px. Gentle glow. Port is visually inviting. Rest of node at normal opacity. |
| **Active DOM elements** | `.dag-node__port.is-valid-target` |
| **Data requirements** | Validation result from ConnectionManager (this port passes all checks). |
| **Transitions** | Cursor within 20px (magnetic radius) -> `hovered-target`; connection drag ends -> `visible` or `hidden` |
| **Error recovery** | If validation is recalculated mid-drag (e.g., node type changes), update accordingly. |
| **Animation** | Glow: 150ms `ease-out` fade-in from `visible` state. |

#### node.port.invalid-target

| Field | Value |
|-------|-------|
| **State ID** | `node.port.invalid-target` |
| **Entry conditions** | Global connection drag starts AND this port is NOT a valid target (wrong polarity, self-loop, would create cycle, duplicate connection, node type has no input port) |
| **Exit conditions** | Connection drag ends -> `node.port.visible` or `node.port.hidden` |
| **Visual description** | Port: `fill: var(--text-muted)`, opacity 0.3. No glow. Visually dimmed/muted -- "you can't drop here." If a SQL Table's nonexistent input port area is approached, a subtle tooltip: "SQL Tables cannot receive connections." |
| **Active DOM elements** | `.dag-node__port.is-invalid-target` (dimmed) |
| **Data requirements** | Validation result with error code (for tooltip). |
| **Transitions** | Connection drag ends -> `visible` or `hidden` |
| **Error recovery** | N/A |
| **Animation** | Dim: 150ms `ease-out` transition to opacity 0.3. |

#### node.port.connected

| Field | Value |
|-------|-------|
| **State ID** | `node.port.connected` |
| **Entry conditions** | A connection is successfully created involving this port |
| **Exit conditions** | All connections to this port are removed -> `node.port.hidden` (or `visible` if node is hovered/selected) |
| **Visual description** | Port: `fill: var(--text-muted)`, always visible (even when node is idle), slightly larger (r=4.5px) to indicate "something is connected here." Dot in the center. |
| **Active DOM elements** | `.dag-node__port.has-connections` (always visible regardless of node hover state) |
| **Data requirements** | `connectionCount > 0` for this port. |
| **Transitions** | All connections removed -> `hidden` or `visible` depending on node state; connection drag starts -> `valid-target` or `invalid-target` (composable) |
| **Error recovery** | If connection count goes negative (bug), clamp to 0 and transition to hidden. |
| **Animation** | On first connection: port scale `1.0 -> 1.2 -> 1.0` pulse in 200ms. |

---

### 3.3 Popover States

#### node.popover.closed

| Field | Value |
|-------|-------|
| **State ID** | `node.popover.closed` |
| **Entry conditions** | Default state. Click outside popover + outside node. `Escape`. Select different node. Start dragging. Delete node. Canvas zoom/pan starts. |
| **Exit conditions** | Click on already-selected node -> `node.popover.open-name`; double-click any node -> `node.popover.open-name`; `Enter` key on selected node -> `node.popover.open-name` |
| **Visual description** | No popover DOM element visible. Node in idle/hover/selected visual as appropriate. |
| **Active DOM elements** | `.dag-node__popover` (removed from DOM or `display: none`) |
| **Data requirements** | None (popover-specific). |
| **Transitions** | Click selected node / double-click / `Enter` -> `open-name` |
| **Error recovery** | N/A |
| **Animation** | None. |

#### node.popover.open-name

| Field | Value |
|-------|-------|
| **State ID** | `node.popover.open-name` |
| **Entry conditions** | Click on already-selected node; double-click any node; `Enter` on selected node; popover first opens (name is the default active section) |
| **Exit conditions** | Click type dropdown -> `open-type`; click schema dropdown -> `open-schema`; click delete button -> `open-delete-confirm`; click outside / `Escape` / drag starts -> `closed` |
| **Visual description** | Popover panel appears below (or above if near bottom edge) the node. Contains: name input field (focused, text selected), type dropdown, schema dropdown, delete button (red, bottom). Popover has arrow pointing to node. Subtle border, `drop-shadow(0 4px 16px rgba(0,0,0,0.12))`. |
| **Active DOM elements** | `.dag-node__popover` (visible), `.dag-node__popover-name` (input, focused), `.dag-node__popover-type` (dropdown), `.dag-node__popover-schema` (dropdown), `.dag-node__popover-delete` (button) |
| **Keyboard shortcuts** | `Tab` cycle fields, `Escape` close popover, `Enter` commit name change + close |
| **Data requirements** | Current node `{ name, type, schema }`. Available schemas from Page 2. |
| **Transitions** | Type dropdown opened -> `open-type`; schema dropdown opened -> `open-schema`; delete clicked -> `open-delete-confirm`; `Escape` / outside click / drag -> `closed` |
| **Error recovery** | If name input loses focus without committing, auto-commit valid value or revert to previous. |
| **Animation** | Popover appear: `opacity 0->1, translateY(4px)->0` in 150ms `cubic-bezier(0.34, 1.56, 0.64, 1)`. Focus ring on name input: standard. |

#### node.popover.open-type

| Field | Value |
|-------|-------|
| **State ID** | `node.popover.open-type` |
| **Entry conditions** | User clicks type dropdown in popover |
| **Exit conditions** | Type selected -> commit change -> `open-name`; click outside dropdown -> `open-name`; destructive change confirmed -> `open-name`; `Escape` -> `open-name` |
| **Visual description** | Type dropdown expanded: 3 options (SQL Table `◇`, SQL MLV `◆`, PySpark MLV `◆`) with current type highlighted. If changing to SQL Table from MLV and incoming connections exist, inline warning appears: "Changing to SQL Table will remove N parent connections. Continue? [Cancel] [Change Type]" |
| **Active DOM elements** | `.dag-node__popover-type.is-open`, dropdown options visible, optional warning panel |
| **Data requirements** | Current type, incoming connection count (for destructive change warning). |
| **Transitions** | Select same type -> close dropdown -> `open-name`; select different type (no connections lost) -> commit -> `open-name`; select different type (connections lost) -> show warning, await confirm; `Escape` -> `open-name` |
| **Error recovery** | If type change fails (e.g., undo stack error), revert type, show toast. |
| **Animation** | Dropdown: `height: 0 -> auto` in 120ms `ease-out`. Warning panel: `height: 0 -> auto` in 150ms. |

#### node.popover.open-schema

| Field | Value |
|-------|-------|
| **State ID** | `node.popover.open-schema` |
| **Entry conditions** | User clicks schema dropdown in popover |
| **Exit conditions** | Schema selected -> commit change -> `open-name`; `Escape` -> `open-name`; click outside -> `open-name` |
| **Visual description** | Schema dropdown expanded showing available schemas (`dbo` always first, then bronze/silver/gold based on Page 2 selections). Each option shows schema name with colored dot. Current schema highlighted. |
| **Active DOM elements** | `.dag-node__popover-schema.is-open`, schema options with color indicators |
| **Data requirements** | `availableSchemas` from wizard state (Page 2). Current schema. Existing `{schema}.{name}` pairs for uniqueness check. |
| **Transitions** | Select schema -> validate uniqueness: if unique, commit -> `open-name`; if duplicate `{schema}.{name}`, show warning "Name 'silver.mlv_1' already exists" and prevent; `Escape` -> `open-name` |
| **Error recovery** | If selected schema no longer exists (Page 2 changed), show "Schema unavailable" and revert to `dbo`. |
| **Animation** | Dropdown: same as type dropdown. Schema badge color: 200ms transition. |

#### node.popover.open-delete-confirm

| Field | Value |
|-------|-------|
| **State ID** | `node.popover.open-delete-confirm` |
| **Entry conditions** | User clicks "Delete Node" button in popover; OR `Delete`/`Backspace` key with popover open |
| **Exit conditions** | "Cancel" clicked -> `open-name`; "Delete" confirmed -> `node.popover.closed` + `node.body.deleting`; `Escape` -> `open-name` |
| **Visual description** | Delete confirmation inline in popover (replaces content area): red-tinted panel. Text: "Delete '{nodeName}'?" If connections exist: "This will also remove N connections." Buttons: `[Cancel]` (neutral) `[Delete]` (red, destructive). |
| **Active DOM elements** | `.dag-node__popover-confirm` (visible, red-tinted), `.dag-node__popover-confirm-cancel`, `.dag-node__popover-confirm-delete` |
| **Keyboard shortcuts** | `Enter` -> confirm delete, `Escape` -> cancel |
| **Data requirements** | Node name, connection count. |
| **Transitions** | "Delete" clicked / `Enter` -> `closed` + `node.body.deleting`; "Cancel" / `Escape` -> `open-name` |
| **Error recovery** | If node is deleted externally during confirm, close popover gracefully. |
| **Animation** | Confirmation panel: swap animation -- current content slides out left, confirm slides in from right, 150ms `ease-out`. Red tint: background fade 100ms. |

---

### 3.4 Name Editing States

#### node.name.viewing

| Field | Value |
|-------|-------|
| **State ID** | `node.name.viewing` |
| **Entry conditions** | Default state. Name committed. Name input blurred. |
| **Exit conditions** | Click on name input in popover -> `node.name.editing`; popover opens (auto-focus) -> `node.name.editing` |
| **Visual description** | Name displayed as static text in popover input field. Text is selectable but not editable until clicked/focused. |
| **Active DOM elements** | `.dag-node__popover-name` (readonly appearance) |
| **Data requirements** | Current `name` value. |
| **Transitions** | Focus/click -> `editing` |
| **Error recovery** | N/A |
| **Animation** | None. |

#### node.name.editing

| Field | Value |
|-------|-------|
| **State ID** | `node.name.editing` |
| **Entry conditions** | Click on name field; popover opens (auto-focus on name); Tab into name field |
| **Exit conditions** | `Enter` -> validate -> `viewing` (if valid) or `error`; blur (focus leaves) -> validate -> `viewing` or `error`; `Escape` -> revert to previous value -> `viewing` |
| **Visual description** | Name input active: blue focus ring, text cursor visible, full text selected on initial focus. Live keystroke validation: border turns red on invalid characters, orange on duplicate. Character counter "N/63" shown when name length > 50. |
| **Active DOM elements** | `.dag-node__popover-name.is-editing` (focus ring, editable), optional `.dag-node__name-counter` |
| **Keyboard shortcuts** | `Enter` commit, `Escape` revert, standard text editing keys |
| **Data requirements** | Current value, original value (for revert). Validation regex `^[a-z][a-z0-9_]*$`. All existing `{schema}.{name}` pairs. |
| **Transitions** | Keystroke -> `validating` (per-keystroke, synchronous); `Enter`/blur -> commit if valid -> `viewing`; `Escape` -> revert -> `viewing` |
| **Error recovery** | If validation fails on commit, stay in `editing` with error displayed. Never commit invalid names. |
| **Animation** | Focus ring: standard 100ms. Input border color transitions: 100ms. |

#### node.name.validating

| Field | Value |
|-------|-------|
| **State ID** | `node.name.validating` |
| **Entry conditions** | Each keystroke in the name input; explicit commit (Enter/blur) |
| **Exit conditions** | Valid -> `node.name.editing` (continue editing); invalid -> `node.name.error`; commit + valid -> `node.name.viewing` |
| **Visual description** | Synchronous (sub-1ms) -- no visible state. Validation result immediately reflected in input border color and error message. |
| **Active DOM elements** | Same as `editing`. |
| **Data requirements** | Value to validate. Regex `^[a-z][a-z0-9_]{0,62}$`. Reserved word list. Existing names for uniqueness. |
| **Transitions** | Valid + still typing -> `editing`; invalid -> `error`; valid + commit -> `viewing` (emit `node:rename`) |
| **Error recovery** | N/A (synchronous). |
| **Animation** | None (instant). |

#### node.name.error

| Field | Value |
|-------|-------|
| **State ID** | `node.name.error` |
| **Entry conditions** | Validation fails: invalid characters, empty name, exceeds 63 chars, duplicate `{schema}.{name}` |
| **Exit conditions** | User corrects the input -> `node.name.editing`; `Escape` -> revert -> `node.name.viewing` |
| **Visual description** | Input border: `var(--status-fail)` red for hard errors, `var(--status-warn)` orange for warnings (reserved words, duplicates). Error message below input: e.g., "Only lowercase letters, numbers, and underscores allowed" or "Name 'silver.mlv_1' already exists." Shake animation on the input (subtle, 200ms). |
| **Active DOM elements** | `.dag-node__popover-name.has-error`, `.dag-node__name-error` (error text visible) |
| **Data requirements** | Error type and message. Original value for revert. |
| **Transitions** | Keystroke that resolves error -> `editing`; `Escape` -> revert to previous valid value -> `viewing` |
| **Error recovery** | If user attempts to commit with error, prevent commit. Show error persistently until corrected. |
| **Animation** | Input shake: `translateX(0) -> 3px -> -3px -> 2px -> -2px -> 0` in 200ms. Error text: `opacity 0->1, translateY(-4px)->0` in 100ms `ease-out`. Border color: 100ms transition. |

---

### 3.5 Composite State: Deleting

#### node.body.deleting

| Field | Value |
|-------|-------|
| **State ID** | `node.body.deleting` |
| **Entry conditions** | Delete confirmed (from popover confirm or `Delete` key on orphan node with no connections); multi-delete confirmed |
| **Exit conditions** | Animation completes -> node destroyed (removed from DOM and state) |
| **Visual description** | Node fades out: `opacity 1 -> 0`, `scale(1) -> scale(0.95)`, 200ms. Connected edges animate out simultaneously. Popover closed. Node removed from `selectedNodeIds`. |
| **Active DOM elements** | `.dag-node.is-deleting` (animating out). Post-animation: all elements removed from DOM. |
| **Data requirements** | Node data for undo command. Connected edges for cascade delete. |
| **Transitions** | Animation complete -> `destroy()`: DOM removed, `RemoveNodeCommand` pushed to undo stack. |
| **Error recovery** | If animation is interrupted (e.g., undo during animation), cancel animation and restore or complete delete based on what was requested. |
| **Animation** | `opacity 1->0` + `transform: scale(1)->scale(0.95)` in 200ms `ease-in`. Staggered for multi-delete: 50ms offset per node, max 200ms total. |

---

## 4. C07 -- ConnectionManager (15 states)

### 4.0 State Namespace

All ConnectionManager state IDs use the prefix `conn.`. States are organized into three dimensions:

| Dimension | Prefix | Description |
|-----------|--------|-------------|
| Creation | `conn.creation.*` | Connection creation drag lifecycle |
| Existing | `conn.existing.*` | State of already-created connections |
| Validation | `conn.validation.*` | DAG constraint checking |

---

### 4.1 Creation States

#### conn.creation.idle

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.idle` |
| **Entry conditions** | Default state. Connection created or cancelled. Rejected state auto-clears. |
| **Exit conditions** | `mousedown` on output port -> `conn.creation.port-hover` |
| **Visual description** | No preview path. No port highlights for connection mode. All connections in their resting visual state. Cursor default (or as determined by canvas interaction mode). |
| **Active DOM elements** | `.connection-preview` (removed from DOM), all `.dag-node__port` in normal state |
| **Keyboard shortcuts** | None (handled by canvas) |
| **Data requirements** | Full graph adjacency (for future validation). |
| **Transitions** | `mousedown` on output port (guard: port is type 'output') -> `port-hover`; hover over existing connection -> `conn.existing.hovered` |
| **Error recovery** | On entry: garbage-collect any orphaned preview paths, reset all port highlights. |
| **Animation** | None. Cleanup animations from previous creation/rejection complete before entry. |

#### conn.creation.port-hover

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.port-hover` |
| **Entry conditions** | `mousedown` on an output port. Button held but not yet moved. |
| **Exit conditions** | `mousemove` > 3px -> `conn.creation.drag-started`; `mouseup` (no movement) -> `conn.creation.idle`; `Escape` -> `conn.creation.idle` |
| **Visual description** | Source port slightly brightens (accent hint). Cursor: `crosshair`. No preview path yet -- waiting for drag threshold. |
| **Active DOM elements** | Source port with `.is-pressed` style. |
| **Data requirements** | `sourceNodeId`, `sourcePortId`, mouse start position. |
| **Transitions** | `mousemove` (distance > 3px from start) -> `drag-started`; `mouseup` -> `idle` (click, not drag); `Escape` -> `idle` |
| **Error recovery** | If source port/node is deleted during this state, return to idle. |
| **Animation** | Port brightness: instant. |

#### conn.creation.drag-started

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.drag-started` |
| **Entry conditions** | Movement exceeds 3px dead zone from `port-hover` state |
| **Exit conditions** | Immediate transition to `conn.creation.dragging-valid` (cursor is in valid area) or `conn.creation.dragging-invalid` (cursor is near invalid target) |
| **Visual description** | Preview Bezier `<path>` created in SVG connections layer. Dashed stroke `var(--accent)`, stroke-width 2, opacity 0.6. Source port activates (`connection-source-active`). All valid target ports highlighted. All invalid target ports dimmed. Source node's own input port dimmed (no self-loop). |
| **Active DOM elements** | `.connection-preview` (created), source `.dag-node__port.is-source-active`, all target ports classified (`.is-valid-target` or `.is-invalid-target`) |
| **Data requirements** | Source port position. All port positions + adjacency for target classification. |
| **Transitions** | Immediate -> `dragging-valid` or `dragging-invalid` based on cursor proximity |
| **Error recovery** | If preview path creation fails, cancel and return to idle. |
| **Animation** | Preview path: instant creation. Port highlights: 150ms `ease-out` fade-in. |

#### conn.creation.dragging-valid

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.dragging-valid` |
| **Entry conditions** | Cursor is not within magnetic radius of any port; or cursor is in empty canvas area during connection drag |
| **Exit conditions** | Cursor enters magnetic radius of valid port -> `conn.creation.snapping-to-port`; `mouseup` (no target) -> `conn.creation.idle` (cancel); `Escape` -> `conn.creation.idle` (cancel) |
| **Visual description** | Preview path: dashed line from source port to cursor position. Smooth cubic Bezier with control points calculated for top-to-bottom flow. Cursor: `crosshair`. Preview path updates at 60fps via rAF. |
| **Active DOM elements** | `.connection-preview` (dashed, following cursor), all port highlights maintained |
| **Keyboard shortcuts** | `Escape` -> cancel |
| **Data requirements** | Source port position. Current cursor position (canvas coords). |
| **Transitions** | `mousemove` (no port nearby) -> self-loop (update preview path); `mousemove` (valid port in magnetic radius) -> `snapping-to-port`; `mouseup` (no snap target) -> `idle` (cancel); `Escape` -> `idle` (cancel) |
| **Error recovery** | If rAF callback errors, fall back to `setTimeout` for path updates. |
| **Animation** | Preview path: no easing (instant per-frame update, <8ms budget). |

#### conn.creation.dragging-invalid

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.dragging-invalid` |
| **Entry conditions** | Cursor enters magnetic radius of an invalid target port (wrong polarity, self-loop, would create cycle) |
| **Exit conditions** | Cursor leaves magnetic radius -> `conn.creation.dragging-valid`; `mouseup` -> `conn.creation.idle` (cancel); `Escape` -> `conn.creation.idle` |
| **Visual description** | Preview path: changes to `var(--status-fail)` red, shorter dashes (4 4), opacity 0.4. Cursor: `not-allowed`. Invalid port does NOT snap/enlarge. Tooltip near cursor: "Would create a cycle" or "Cannot connect to SQL Table input." |
| **Active DOM elements** | `.connection-preview.is-invalid` (red dashes), invalid port unchanged (stays dimmed) |
| **Data requirements** | Invalid target port info + error code for tooltip. |
| **Transitions** | Cursor leaves invalid port vicinity -> `dragging-valid`; `mouseup` -> `idle`; `Escape` -> `idle` |
| **Error recovery** | N/A |
| **Animation** | Preview color change: 80ms transition. Tooltip: fade-in 100ms. |

#### conn.creation.snapping-to-port

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.snapping-to-port` |
| **Entry conditions** | Cursor enters magnetic radius (20px) of a valid target input port |
| **Exit conditions** | `mouseup` -> `conn.validation.checking-cycle`; cursor leaves magnetic radius -> `conn.creation.dragging-valid`; cursor moves to different valid port -> self-loop (snap to new port); `Escape` -> `conn.creation.idle` |
| **Visual description** | Preview path snaps endpoint to target port center (smooth interpolation, not jump). Preview changes from dashed to solid, opacity 0.9, stroke-width 2.5. Target port enlarges `r: 4 -> 6px`, border thickens, accent glow. Cursor: `copy` (indicating a valid drop). |
| **Active DOM elements** | `.connection-preview.is-snapped` (solid, thicker), target `.dag-node__port.is-snap-target` (enlarged, glowing) |
| **Keyboard shortcuts** | `Escape` -> cancel |
| **Data requirements** | Target port position (snap endpoint). Source port position. Magnetic radius (20px). |
| **Transitions** | `mouseup` -> `conn.validation.checking-cycle`; `mousemove` (leaves radius) -> `dragging-valid` (un-snap); `mousemove` (to different valid port) -> self-loop (snap to new); `Escape` -> `idle` |
| **Error recovery** | If target port is removed during snap (node deleted), cancel and return to idle. |
| **Animation** | Snap interpolation: 60ms `cubic-bezier(0.34, 1.56, 0.64, 1)` spring from cursor to port center. Port enlarge: 80ms spring `r: 4->6, stroke-width: 1.5->2`. Preview solid transition: 60ms. Un-snap: 60ms ease back to cursor tracking. |

#### conn.creation.created

| Field | Value |
|-------|-------|
| **State ID** | `conn.creation.created` |
| **Entry conditions** | Validation passes (`valid === true`) from `conn.validation.checking-cycle` |
| **Exit conditions** | Immediate transition to `conn.creation.idle` after cleanup |
| **Visual description** | Preview path morphs into permanent connection path (smooth transition from dashed/accent to solid/default). Permanent `<path>` element created with arrowhead marker. Source and target ports return to normal. All port highlights cleared. `connection:created` event emitted. Undo snapshot pushed. |
| **Active DOM elements** | New `.connection` path in connections layer, preview path removed, port highlights cleared |
| **Data requirements** | Validated `Connection` record. Source + target port positions for Bezier calculation. |
| **Transitions** | Immediate -> `idle` (cleanup complete) |
| **Error recovery** | If DOM insertion fails, retry once. If still fails, emit error event and return to idle without the connection. |
| **Animation** | Preview-to-permanent morph: `stroke-dasharray: 8 4 -> 0` + `opacity 0.6 -> 1.0` in 200ms `ease-out`. Port de-emphasis: 150ms return to normal. Success pulse: connection briefly flashes accent then settles to default stroke (300ms total). |

---

### 4.2 Existing Connection States

#### conn.existing.idle

| Field | Value |
|-------|-------|
| **State ID** | `conn.existing.idle` |
| **Entry conditions** | Default state for all created connections. Mouse leaves connection. Deselect. |
| **Exit conditions** | Mouse hover over path (hit-test: distance < 8px/zoom) -> `conn.existing.hovered`; click -> `conn.existing.selected` |
| **Visual description** | Connection path: `stroke: var(--border)` (`oklch(0.8 0.01 260)`), stroke-width 1.5px, opacity 0.7. Arrowhead: `#arrowhead-default` (muted). Gentle, unobtrusive presence. |
| **Active DOM elements** | `.connection` (default styling) |
| **Data requirements** | `Connection` record. Source and target port positions. |
| **Transitions** | Mouse proximity < 8px/zoom -> `hovered`; external `selectConnection(id)` -> `selected` |
| **Error recovery** | If source or target node no longer exists (deleted externally), auto-delete this connection. |
| **Animation** | None (resting state). |

#### conn.existing.hovered

| Field | Value |
|-------|-------|
| **State ID** | `conn.existing.hovered` |
| **Entry conditions** | Point-to-Bezier distance < 8px / zoomLevel (hit-test passes) |
| **Exit conditions** | Mouse moves away (distance > 12px/zoom, with hysteresis) -> `conn.existing.idle`; click -> `conn.existing.selected` |
| **Visual description** | Connection path: `stroke: var(--accent)`, stroke-width 2px, opacity 0.9. Arrowhead: `#arrowhead-active`. Cursor: `pointer`. Source and target ports subtly highlighted. |
| **Active DOM elements** | `.connection.is-hovered` (accent stroke, thicker), source/target ports with subtle accent dot |
| **Data requirements** | Hit-test calculation. Zoom level for tolerance adjustment. |
| **Transitions** | Mouse away -> `idle`; click -> `selected` |
| **Error recovery** | If connection DOM element is removed during hover (e.g., undo), state auto-resets. |
| **Animation** | Stroke color + width: 100ms `ease-out`. Arrowhead color: 100ms. |

#### conn.existing.selected

| Field | Value |
|-------|-------|
| **State ID** | `conn.existing.selected` |
| **Entry conditions** | Click on hovered connection; external `selectConnection(id)` |
| **Exit conditions** | Click elsewhere -> `conn.existing.idle`; `Escape` -> `conn.existing.idle`; `Delete`/`Backspace` -> `conn.existing.deleting`; click on different connection -> swap selection (this -> idle, other -> selected) |
| **Visual description** | Connection path: `stroke: var(--accent)`, stroke-width 2.5px, opacity 1.0. Arrowhead: `#arrowhead-active`. Source and target ports highlighted with accent glow. Optional: tiny delete "x" icon at midpoint of the curve. |
| **Active DOM elements** | `.connection.is-selected`, optional `.connection__delete-handle` (midpoint), source/target ports highlighted |
| **Keyboard shortcuts** | `Delete`/`Backspace` -> delete connection |
| **Data requirements** | Connection record. Selection state. |
| **Transitions** | `Delete` -> `deleting`; `Escape` / click elsewhere -> `idle`; click on midpoint delete handle -> `deleting` |
| **Error recovery** | If connection's source or target node is deleted, auto-delete connection and clear selection. |
| **Animation** | Selection: stroke-width `2 -> 2.5` in 100ms `ease-out`. Delete handle: fade-in 100ms. |

#### conn.existing.deleting

| Field | Value |
|-------|-------|
| **State ID** | `conn.existing.deleting` |
| **Entry conditions** | `Delete`/`Backspace` pressed with connection selected; click on midpoint delete handle; cascade delete from node removal |
| **Exit conditions** | Animation completes -> connection removed from DOM and store |
| **Visual description** | Connection path fades out: `opacity 1 -> 0`, stroke turns `var(--status-fail)` briefly (flash red). Arrowhead fades simultaneously. After animation: `<path>` removed from DOM. `connection:deleted` event emitted. Undo snapshot pushed. |
| **Active DOM elements** | `.connection.is-deleting` (animating out) |
| **Data requirements** | Connection record for undo. |
| **Transitions** | Animation complete -> connection `destroy()`: DOM removed, store updated. |
| **Error recovery** | If animation is interrupted by undo, restore immediately. |
| **Animation** | Flash red: `stroke: var(--accent) -> var(--status-fail)` in 80ms. Fade out: `opacity 1 -> 0` in 150ms `ease-in`. Total: 230ms. |

---

### 4.3 Validation States

#### conn.validation.checking-cycle

| Field | Value |
|-------|-------|
| **State ID** | `conn.validation.checking-cycle` |
| **Entry conditions** | `mouseup` on snapped target port during connection creation; OR programmatic `addConnection()` call |
| **Exit conditions** | Validation passes -> `conn.creation.created`; validation fails -> `conn.validation.cycle-detected` or `conn.validation.rejected` |
| **Visual description** | Synchronous for < 50 nodes (sub-1ms). For 50-100 nodes: preview path holds at snapped position. Very brief -- user should not perceive a delay. Validation pipeline runs: self-loop check -> polarity check -> duplicate check -> cycle detection (DFS O(V+E)). |
| **Active DOM elements** | Preview path frozen at snap position. Target port frozen in enlarged state. |
| **Data requirements** | Proposed `{ sourceNodeId, sourcePortId, targetNodeId, targetPortId }`. Full adjacency graph for DFS. |
| **Transitions** | All checks pass -> `conn.creation.created`; self-loop detected -> `rejected`; wrong polarity -> `rejected`; duplicate -> `rejected`; cycle found -> `cycle-detected` |
| **Error recovery** | If DFS hangs (>100ms, should never happen for <= 100 nodes), timeout and reject with "Validation timed out." |
| **Animation** | None (sub-frame). |

#### conn.validation.cycle-detected

| Field | Value |
|-------|-------|
| **State ID** | `conn.validation.cycle-detected` |
| **Entry conditions** | DFS cycle detection finds that adding this edge would create a cycle |
| **Exit conditions** | Auto-transition after error display (300ms) -> `conn.creation.idle` |
| **Visual description** | Preview path flashes red (`var(--status-fail)`) for 300ms. Toast notification: "Cannot create connection: would create a cycle (A -> B -> C -> A)." with the cycle path listed. Source port briefly flashes red. Target port returns to normal. All port highlights cleared. |
| **Active DOM elements** | `.connection-preview.is-rejected` (red flash), toast notification, source port red flash |
| **Data requirements** | Cycle path (list of involved node IDs/names) for error message. |
| **Transitions** | 300ms timeout -> `conn.creation.idle` |
| **Error recovery** | N/A (error IS the recovery). |
| **Animation** | Preview path: `stroke: var(--accent) -> var(--status-fail)` in 80ms, hold 220ms, then remove. Toast: slide-in from top, auto-dismiss 4s. Source port: red flash 300ms, then restore. |

#### conn.validation.valid

| Field | Value |
|-------|-------|
| **State ID** | `conn.validation.valid` |
| **Entry conditions** | All validation checks pass (self-loop: clear, polarity: correct, duplicate: none, cycle: none, port capacity: available) |
| **Exit conditions** | Immediate transition to `conn.creation.created` |
| **Visual description** | No visible state -- instant transition. This state exists in the model for completeness and potential future async validation (e.g., server-side rule checking). |
| **Active DOM elements** | Same as `checking-cycle` (frozen preview). |
| **Data requirements** | `ValidationResult { valid: true }` |
| **Transitions** | Immediate -> `conn.creation.created` |
| **Error recovery** | N/A |
| **Animation** | None (instant transition). |

#### conn.validation.rejected

| Field | Value |
|-------|-------|
| **State ID** | `conn.validation.rejected` |
| **Entry conditions** | Any non-cycle validation failure: self-loop, wrong polarity, duplicate edge, port at capacity, target has no input port |
| **Exit conditions** | Auto-transition after 300ms -> `conn.creation.idle` |
| **Visual description** | Same visual pattern as `cycle-detected`: preview path flashes red, toast shows specific error message. Error messages by code: `SELF_LOOP`: "Cannot connect a node to itself." `WRONG_POLARITY`: "Can only connect output to input ports." `DUPLICATE_EDGE`: "A connection between these ports already exists." `PORT_FULL`: "Target port has reached maximum connections." `TARGET_NO_INPUT`: "SQL Tables are source nodes and cannot receive connections." |
| **Active DOM elements** | `.connection-preview.is-rejected`, error toast |
| **Data requirements** | `ValidationResult { valid: false, errorCode, message }` |
| **Transitions** | 300ms timeout -> `conn.creation.idle` |
| **Error recovery** | N/A |
| **Animation** | Same as `cycle-detected`. |

---

## 5. Cross-Component Interaction Matrix

This matrix shows how state changes in one component trigger transitions in others.

### 5.1 Event Flow: Node Creation via Palette Drag

```
palette.drag-started
  |
  +--> canvas.interaction.receiving-drop
  |      |
  |      +--> [on drop] canvas.content.has-nodes (if was empty)
  |      |      |
  |      |      +--> node.body.selected (new node auto-selected)
  |      |      |      |
  |      |      |      +--> node.port.visible (selected node shows ports)
  |      |      |
  |      |      +--> canvas.selection.single-node
  |      |
  |      +--> palette.drop-completed
  |             |
  |             +--> palette.expanded (counter updated)
  |
  +--> [if cancelled] palette.drag-cancelled --> palette.expanded
```

### 5.2 Event Flow: Connection Creation

```
node.port.connection-source-active (mousedown on output port)
  |
  +--> canvas.interaction.connecting
  |      |
  |      +--> [all nodes] node.port.valid-target / node.port.invalid-target
  |      |
  |      +--> conn.creation.port-hover --> conn.creation.drag-started
  |             |
  |             +--> conn.creation.dragging-valid
  |             |      |
  |             |      +--> conn.creation.snapping-to-port (near valid port)
  |             |             |
  |             |             +--> [mouseup] conn.validation.checking-cycle
  |             |                    |
  |             |                    +--> [valid] conn.creation.created
  |             |                    |      |
  |             |                    |      +--> conn.creation.idle
  |             |                    |      +--> canvas.interaction.idle
  |             |                    |      +--> [all nodes] node.port.hidden/visible
  |             |                    |
  |             |                    +--> [invalid] conn.validation.cycle-detected
  |             |                           |
  |             |                           +--> conn.creation.idle
  |             |                           +--> canvas.interaction.idle
  |             |
  |             +--> [Escape] conn.creation.idle --> canvas.interaction.idle
```

### 5.3 Event Flow: Node Deletion

```
node.popover.open-delete-confirm
  |
  +--> [confirmed] node.body.deleting
         |
         +--> conn.existing.deleting (all connected edges)
         |
         +--> canvas.selection.none (removed from selection)
         |
         +--> [animation complete] node destroyed
         |
         +--> canvas.content.empty (if was last node)
         |    OR canvas.content.has-nodes (if count dropped below 100)
         |         |
         |         +--> palette.expanded (if was disabled, re-enable)
```

### 5.4 Event Flow: Undo/Redo

```
[Ctrl+Z pressed]
  |
  +--> canvas.undo-available (stack check)
         |
         +--> UndoRedoManager.undo()
                |
                +--> [AddNodeCommand] node.body.deleting (reverse: remove node)
                +--> [RemoveNodeCommand] node created, node.body.idle (reverse: add node)
                +--> [MoveNodeCommand] node position reverted (animated 150ms spring)
                +--> [AddConnectionCommand] conn.existing.deleting (reverse: remove)
                +--> [RemoveConnectionCommand] conn.creation.created (reverse: add)
                +--> [EditPropertyCommand] node property reverted, re-rendered
```

### 5.5 State Composition Rules

At any given moment, the system has exactly ONE state active in each dimension:

| Component | Dimensions | Example Composite State |
|-----------|-----------|------------------------|
| C04 Canvas | interaction + viewport + content + selection | `idle + zoomed-in + has-nodes + single-node` |
| C05 Palette | single dimension | `expanded` |
| C06 Node (per instance) | body + port + popover + name | `selected + visible + open-name + editing` |
| C07 Connection (per instance) | creation (global) + existing (per edge) + validation (global) | `creation.idle + existing.hovered + validation.valid` |

**Conflict resolution rules:**

1. Canvas interaction takes priority -- if canvas is in `panning` mode, node clicks are suppressed.
2. Connection mode (`canvas.interaction.connecting`) overrides normal node selection behavior.
3. Only one popover can be open at a time -- opening one closes any other.
4. Palette drag (`palette.dragging-*`) suppresses all palette keyboard shortcuts.
5. During `canvas.interaction.dragging-nodes`, all popovers close and port visibility is suppressed.
6. `Escape` key cascades: closes popover first, then deselects, then cancels drag -- one layer per press.

---

*End of P3 State Matrices for DAG Canvas System.*
