# C04 — DagCanvas: Component Deep Spec

> **Component:** DagCanvas
> **Feature:** F16 — New Infra Wizard (Page 3)
> **Complexity:** VERY HIGH
> **Owner:** Pixel (Frontend Agent)
> **Reviewed by:** Sana (Architecture)
> **Status:** P1 (Component Deep Spec) — DRAFT
> **Depends on:** P0.4 (DAG Builder Research), P0.6 (Canvas Interaction Research)
> **Research refs:** `research/p0-dag-builder-research.md`, `research/p0-canvas-interaction.md`
> **Mock ref:** `mocks/infra-wizard.html` (Page 3 — DAG Canvas section)

---

## 1. Overview

### 1.1 Purpose

DagCanvas is the core SVG infinite-canvas component on Page 3 of the New Infra Wizard. It provides the visual surface on which users build their data pipeline topology by placing nodes (SQL Tables, SQL MLVs, PySpark MLVs), drawing connections between them, and arranging the resulting directed acyclic graph. It is the spatial "stage" — every other Page 3 component (NodePalette, DagNode, ConnectionManager, CodePreviewPanel) either renders inside it or communicates through it.

### 1.2 Responsibilities

DagCanvas **owns:**

| # | Responsibility | Details |
|---|---------------|---------|
| 1 | SVG root element | The `<svg>` element with `viewBox` attribute that defines the canvas coordinate system |
| 2 | Viewport transform | Translation (pan) and scale (zoom) applied to the root `<g>` transform group |
| 3 | Screen ↔ Canvas coordinate conversion | All mouse/pointer positions are converted from screen (client) coordinates to canvas (SVG) coordinates |
| 4 | Pan interaction | Middle-mouse drag or Space+left-drag to translate the viewport |
| 5 | Zoom interaction | Scroll-wheel zoom centered on cursor position, 25%–400% range with smooth easing |
| 6 | Zoom controls UI | Floating panel: zoom-in (+), zoom-out (−), fit-to-view (⊞), zoom percentage display |
| 7 | Grid/dot background | Subtle dot-pattern grid that scrolls and scales with the viewport |
| 8 | Node drop target | Receives drop events from NodePalette, computes canvas-space position, delegates node creation |
| 9 | Canvas click handler | Click on empty canvas area → deselect all nodes and connections |
| 10 | Canvas right-click menu | Context menu with "Add Node" submenu (3 node types) + "Auto Arrange" + "Zoom to Fit" |
| 11 | Node container group | The `<g id="nodes-layer">` group that holds all DagNode SVG groups |
| 12 | Connection layer | The `<g id="connections-layer">` group below the nodes layer, managed by ConnectionManager |
| 13 | Selection rectangle | Marquee/rubber-band multi-select when dragging on empty canvas |
| 14 | Max 100 nodes enforcement | Rejects node creation when limit is reached, emits error event |
| 15 | Canvas state | The authoritative state object: `{ nodes[], connections[], viewport: {x, y, zoom} }` |
| 16 | AutoLayoutEngine integration | Calls auto-layout, applies computed positions with animation |
| 17 | UndoRedoManager integration | All mutations (add/remove/move node, add/remove connection) go through the undo stack |
| 18 | Serialization | `toJSON()` / `fromJSON()` for template save/load and review page consumption |

DagCanvas **does NOT own:**

| Delegated To | What |
|-------------|------|
| **DagNode** (C06) | Individual node rendering, node popover, inline rename, type/schema badges |
| **ConnectionManager** (C07) | Connection path calculation (Bézier curves), drag-to-connect interaction, connection validation (cycle detection), arrowhead markers |
| **NodePalette** (C05) | Drag source UI, node type catalog, drag ghost preview |
| **CodePreviewPanel** (C08) | Code generation, syntax highlighting, refresh/collapse |
| **AutoLayoutEngine** (C13) | Dagre algorithm execution, position computation |
| **UndoRedoManager** (C14) | Command stack, undo/redo logic, keyboard shortcut binding |

### 1.3 Design Decisions (Settled)

| Decision | Choice | Rationale | Reference |
|----------|--------|-----------|-----------|
| Rendering technology | Pure SVG with `foreignObject` for rich node content | DOM interactivity, CSS styling, accessibility, crisp at any zoom, trivial perf at ≤100 nodes | ADR-002, P0.6 §4.2 |
| External library | **None for MVP** — vanilla SVG with helper utilities | Zero dependency risk, total control, 100 nodes is trivially within SVG comfort zone. JointJS Core identified as backup if hand-rolled proves too costly. | P0.6 §9.1 |
| Coordinate system | SVG `viewBox` with `<g transform>` for zoom/pan | Single transform group = GPU-composited, 60fps zoom/pan | P0.6 §7.1 |
| Layout direction | Top-to-bottom (TB) | Matches data-flow mental model (sources at top, derived views at bottom), matches mock | P0.4 §3.5 |
| Auto-layout algorithm | Dagre (Sugiyama layered) via `@dagrejs/dagre` | Purpose-built for DAGs, ~50 KB, proven, < 50ms for 100 nodes | P0.6 §5.2 |
| Undo/redo architecture | Command pattern with reversible command objects | Low memory (delta-only), granular, extensible | P0.6 §6.2 |
| Node placement | Hybrid: sidebar palette drag + right-click context menu + keyboard shortcut | Discoverable for beginners, fast for power users | P0.4 §3.1 |
| Connection style | Cubic Bézier curves (smooth S-curves), top-to-bottom port flow | Industry standard for DAG visualization, matches mock | P0.4 §3.2 |

---

## 2. Data Model

### 2.1 Canvas State

The single source of truth for everything visible on the canvas. This state is what gets serialized for templates, consumed by the review page, and tracked by undo/redo.

```typescript
/**
 * Root canvas state — serializable to JSON.
 * All coordinates are in CANVAS space (not screen space).
 */
interface CanvasState {
  /** All nodes on the canvas, keyed by unique ID */
  nodes: DagNodeData[];

  /** All connections between nodes */
  connections: ConnectionData[];

  /** Current viewport transform */
  viewport: ViewportState;

  /** Monotonically increasing counter for generating unique node IDs */
  nextNodeId: number;

  /** Monotonically increasing counter for generating unique connection IDs */
  nextConnectionId: number;
}

interface DagNodeData {
  /** Unique identifier, e.g. "node-1", "node-2" */
  id: string;

  /** Display name, e.g. "orders", "customer_360" */
  name: string;

  /** Node type determines rendering, port configuration, and code generation */
  type: 'sql-table' | 'sql-mlv' | 'pyspark-mlv';

  /** Schema assignment from Page 2 selections */
  schema: 'dbo' | 'bronze' | 'silver' | 'gold';

  /** Position in canvas coordinates (top-left corner of node bounding box) */
  x: number;
  y: number;

  /** Dimensions (set by DagNode renderer, read by canvas for layout/hit-testing) */
  width: number;   // default: 180
  height: number;  // default: 72
}

interface ConnectionData {
  /** Unique identifier, e.g. "conn-1" */
  id: string;

  /** Source node ID (the parent / upstream node) */
  sourceNodeId: string;

  /** Target node ID (the child / downstream node) */
  targetNodeId: string;
}

interface ViewportState {
  /** Horizontal translation in canvas units (negative = panned right) */
  panX: number;

  /** Vertical translation in canvas units (negative = panned down) */
  panY: number;

  /** Zoom level as a multiplier: 0.25 = 25%, 1.0 = 100%, 4.0 = 400% */
  zoom: number;
}
```

### 2.2 Transient State (Not Serialized)

State that exists only during the current session, not saved to templates or consumed externally.

```typescript
interface CanvasTransientState {
  /** Currently selected node IDs (multi-select possible) */
  selectedNodeIds: Set<string>;

  /** Currently selected connection IDs */
  selectedConnectionIds: Set<string>;

  /** Current interaction mode */
  interactionMode: InteractionMode;

  /** Active selection rectangle (during marquee drag) */
  selectionRect: { startX: number, startY: number, endX: number, endY: number } | null;

  /** Node currently being dragged (for move operation) */
  dragTarget: { nodeId: string, offsetX: number, offsetY: number, startX: number, startY: number } | null;

  /** Active pan operation */
  panState: { startClientX: number, startClientY: number, startPanX: number, startPanY: number } | null;

  /** Whether Space key is held (for space+drag panning) */
  spaceHeld: boolean;

  /** Whether the canvas context menu is open */
  contextMenuOpen: boolean;

  /** Position of open context menu in screen coords */
  contextMenuPosition: { clientX: number, clientY: number } | null;

  /** Available schemas from Page 2 (injected by wizard) */
  availableSchemas: string[];

  /** Data theme from Page 2 (injected by wizard) */
  dataTheme: string;
}

type InteractionMode =
  | 'idle'              // Default — click to select, drag to marquee
  | 'panning'           // Active pan via middle-mouse or space+drag
  | 'dragging-node'     // Moving a selected node
  | 'selecting-rect'    // Drawing a selection rectangle
  | 'connecting'        // Drawing a connection (delegated to ConnectionManager)
  | 'context-menu';     // Context menu is open
```

### 2.3 Node Defaults

When a node is created, it receives these defaults based on type:

| Property | SQL Table | SQL MLV | PySpark MLV |
|----------|-----------|---------|-------------|
| `name` | Auto: `table_{N}` | Auto: `mlv_{N}` | Auto: `spark_mlv_{N}` |
| `schema` | First available (`dbo`) | First available (`dbo`) | First available (`dbo`) |
| `width` | 180 | 180 | 180 |
| `height` | 72 | 72 | 72 |
| Has input port | No | Yes | Yes |
| Has output port | Yes | Yes | Yes (except terminal nodes) |

### 2.4 Coordinate Systems

DagCanvas operates with two coordinate systems and must convert between them for every pointer interaction.

```
SCREEN SPACE (clientX, clientY)                CANVAS SPACE (cx, cy)
┌─────────────────────────────┐               ┌─────────────────────────────────────┐
│ Browser viewport            │               │ Infinite canvas (virtual)            │
│                             │               │                                     │
│   ┌─────────────────┐      │    viewBox     │     Node at (400, 300)              │
│   │ SVG element      │ ────────────────────▸│                                     │
│   │ (.dag-canvas-svg)│      │   transform   │                                     │
│   │                  │      │               │                                     │
│   └─────────────────┘      │               │                                     │
│                             │               │                                     │
└─────────────────────────────┘               └─────────────────────────────────────┘
```

**Conversion formulas:**

```javascript
/**
 * Convert screen (client) coordinates to canvas coordinates.
 *
 * @param {number} clientX - Mouse X in browser viewport
 * @param {number} clientY - Mouse Y in browser viewport
 * @returns {{ canvasX: number, canvasY: number }}
 */
screenToCanvas(clientX, clientY) {
  const svgRect = this._svgEl.getBoundingClientRect();

  // 1. Position relative to SVG element's top-left
  const relX = clientX - svgRect.left;
  const relY = clientY - svgRect.top;

  // 2. Account for zoom (scale) and pan (translation)
  const canvasX = (relX / this._viewport.zoom) - this._viewport.panX;
  const canvasY = (relY / this._viewport.zoom) - this._viewport.panY;

  return { canvasX, canvasY };
}

/**
 * Convert canvas coordinates to screen (client) coordinates.
 *
 * @param {number} canvasX - X in canvas space
 * @param {number} canvasY - Y in canvas space
 * @returns {{ clientX: number, clientY: number }}
 */
canvasToScreen(canvasX, canvasY) {
  const svgRect = this._svgEl.getBoundingClientRect();

  const clientX = (canvasX + this._viewport.panX) * this._viewport.zoom + svgRect.left;
  const clientY = (canvasY + this._viewport.panY) * this._viewport.zoom + svgRect.top;

  return { clientX, clientY };
}
```

### 2.5 SVG Transform Application

The viewport state maps to a single CSS/SVG transform on the root content group:

```javascript
/**
 * Apply current viewport to the root <g> transform.
 * This is the ONLY place where pan/zoom affect the DOM.
 */
_applyViewportTransform() {
  const { panX, panY, zoom } = this._viewport;
  this._contentGroup.setAttribute(
    'transform',
    `scale(${zoom}) translate(${panX}, ${panY})`
  );
}
```

**Important:** Scale is applied BEFORE translate in SVG transforms. This means `panX` and `panY` are in **canvas units** (pre-scale), not screen pixels. When the user pans by 100 screen pixels at 2× zoom, that's 50 canvas units of translation.

---

## 3. API Surface

### 3.1 Constructor & Lifecycle

```javascript
class DagCanvas {
  /**
   * @param {HTMLElement} containerEl - The wrapper div (.dag-canvas-wrapper)
   * @param {object} options
   * @param {string[]} options.availableSchemas - ['dbo', 'bronze', 'silver', 'gold']
   * @param {string} options.dataTheme - 'ecommerce' | 'sales' | ...
   * @param {UndoRedoManager} options.undoManager - Shared undo/redo manager instance
   * @param {function} options.onStateChange - Callback when canvas state changes
   */
  constructor(containerEl, options) { }

  /** Initialize SVG, layers, event listeners, grid. Called once after construction. */
  async init() { }

  /**
   * Tear down: remove event listeners, detach DOM, clear state.
   * Called when wizard navigates away from Page 3 or closes.
   */
  destroy() { }
}
```

### 3.2 Node Operations

All node operations go through the UndoRedoManager. The public methods create commands and execute them.

```javascript
/**
 * Add a node to the canvas.
 * @param {string} type - 'sql-table' | 'sql-mlv' | 'pyspark-mlv'
 * @param {number} canvasX - X position in canvas coordinates
 * @param {number} canvasY - Y position in canvas coordinates
 * @param {object} [overrides] - Optional overrides: { name, schema }
 * @returns {DagNodeData} The created node data
 * @throws {Error} If node limit (100) reached
 */
addNode(type, canvasX, canvasY, overrides = {}) { }

/**
 * Remove a node and all its connections.
 * @param {string} nodeId
 */
removeNode(nodeId) { }

/**
 * Remove all currently selected nodes and their connections.
 */
removeSelectedNodes() { }

/**
 * Move a node to a new position.
 * @param {string} nodeId
 * @param {number} newX - New X in canvas coordinates
 * @param {number} newY - New Y in canvas coordinates
 */
moveNode(nodeId, newX, newY) { }

/**
 * Update a node's properties (name, type, schema).
 * @param {string} nodeId
 * @param {Partial<DagNodeData>} updates
 */
updateNode(nodeId, updates) { }

/**
 * Get a node by ID.
 * @param {string} nodeId
 * @returns {DagNodeData | null}
 */
getNode(nodeId) { }

/**
 * Get all nodes.
 * @returns {DagNodeData[]}
 */
getNodes() { }

/**
 * Get the count of nodes currently on the canvas.
 * @returns {number}
 */
getNodeCount() { }
```

### 3.3 Connection Operations

These methods delegate to ConnectionManager but maintain state ownership in DagCanvas.

```javascript
/**
 * Add a connection between two nodes.
 * @param {string} sourceNodeId - Parent (upstream) node
 * @param {string} targetNodeId - Child (downstream) node
 * @returns {ConnectionData} The created connection
 * @throws {Error} If connection is invalid (cycle, self-loop, duplicate)
 */
addConnection(sourceNodeId, targetNodeId) { }

/**
 * Remove a connection.
 * @param {string} connectionId
 */
removeConnection(connectionId) { }

/**
 * Get all connections for a node (both incoming and outgoing).
 * @param {string} nodeId
 * @returns {{ incoming: ConnectionData[], outgoing: ConnectionData[] }}
 */
getNodeConnections(nodeId) { }

/**
 * Get all connections.
 * @returns {ConnectionData[]}
 */
getConnections() { }
```

### 3.4 Selection

```javascript
/**
 * Select a node (replaces current selection unless additive=true).
 * @param {string} nodeId
 * @param {boolean} [additive=false] - If true, adds to selection (Shift+click)
 */
selectNode(nodeId, additive = false) { }

/**
 * Select multiple nodes within a rectangle (canvas coordinates).
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
selectNodesInRect(x1, y1, x2, y2) { }

/**
 * Deselect all nodes and connections.
 */
deselectAll() { }

/**
 * Select all nodes (Ctrl+A).
 */
selectAll() { }

/**
 * Get currently selected node IDs.
 * @returns {string[]}
 */
getSelectedNodeIds() { }
```

### 3.5 Viewport Control

```javascript
/**
 * Set zoom level, centered on a point.
 * @param {number} newZoom - Zoom multiplier (0.25 to 4.0)
 * @param {number} [centerClientX] - Screen X to zoom toward (default: SVG center)
 * @param {number} [centerClientY] - Screen Y to zoom toward (default: SVG center)
 * @param {boolean} [animate=false] - Whether to animate the transition
 */
setZoom(newZoom, centerClientX, centerClientY, animate = false) { }

/**
 * Get current zoom level.
 * @returns {number}
 */
getZoom() { }

/**
 * Increment zoom by one step (each step = ×1.15).
 */
zoomIn() { }

/**
 * Decrement zoom by one step (each step = ÷1.15).
 */
zoomOut() { }

/**
 * Pan the viewport by a delta (in screen pixels).
 * @param {number} deltaScreenX
 * @param {number} deltaScreenY
 */
pan(deltaScreenX, deltaScreenY) { }

/**
 * Fit all nodes into view with padding.
 * @param {number} [padding=60] - Padding in canvas units around the bounding box
 * @param {boolean} [animate=true] - Animate the transition
 */
fitToView(padding = 60, animate = true) { }

/**
 * Reset zoom to 100% and center the content.
 */
resetView() { }

/**
 * Get the current viewport state.
 * @returns {ViewportState}
 */
getViewport() { }
```

### 3.6 Serialization

```javascript
/**
 * Serialize the complete canvas state to JSON.
 * Used by TemplateManager (save) and ReviewSummary (read-only render).
 * @returns {CanvasState}
 */
toJSON() { }

/**
 * Restore canvas state from JSON.
 * Used by TemplateManager (load) and for undo/redo snapshots.
 * @param {CanvasState} state
 * @param {boolean} [animate=false] - Animate node positions
 */
fromJSON(state, animate = false) { }

/**
 * Clear the canvas — remove all nodes, connections, reset viewport.
 * Shows confirmation dialog before clearing if nodes exist.
 */
clear() { }
```

### 3.7 Layout Integration

```javascript
/**
 * Trigger auto-layout using Dagre.
 * Computes optimal positions for all nodes and animates them.
 * This is an undoable operation (single compound command).
 * @param {object} [options]
 * @param {'TB' | 'LR'} [options.direction='TB'] - Layout direction
 * @param {number} [options.nodeSep=60] - Horizontal spacing
 * @param {number} [options.rankSep=80] - Vertical spacing (between layers)
 */
autoLayout(options = {}) { }
```

### 3.8 Events / Callbacks

DagCanvas communicates state changes to the parent wizard via callbacks (following the EDOG codebase pattern — no event bus).

```javascript
/**
 * Callback signature: called whenever canvas state changes.
 * Parent (InfraWizardDialog) uses this to update the "Next" button
 * enabled state, node count display, etc.
 *
 * @callback onStateChange
 * @param {CanvasStateChangeEvent} event
 */

interface CanvasStateChangeEvent {
  type: 'node-added' | 'node-removed' | 'node-moved' | 'node-updated'
      | 'connection-added' | 'connection-removed'
      | 'selection-changed' | 'viewport-changed'
      | 'layout-applied' | 'canvas-cleared' | 'state-restored';

  /** Current node count */
  nodeCount: number;

  /** Current connection count */
  connectionCount: number;

  /** Whether the DAG is valid (≥1 node, all MLVs have ≥1 parent) */
  isValid: boolean;

  /** Validation errors (if any) */
  validationErrors: string[];

  /** The full canvas state (for serialization) */
  state: CanvasState;
}
```

---

## 4. State Machine

### 4.1 Interaction Mode FSM

The canvas's primary interaction is governed by a finite state machine that determines how pointer events are interpreted.

```
                              ┌──────────────┐
                              │              │
            ┌────────────────▸│     IDLE     │◂────────────────┐
            │                 │              │                 │
            │                 └──┬───┬───┬───┘                 │
            │                    │   │   │                     │
            │     ┌──────────────┘   │   └──────────────┐      │
            │     │ middle-mouse     │ left-click        │      │
            │     │ OR space+left    │ on empty          │ Escape/
            │     ▼                  │ canvas            │ pointerup
        ┌────────────┐              │              ┌────────────┐
        │            │              │              │            │
        │  PANNING   │              │              │ SELECTING  │
        │            │              │              │    RECT    │
        └────────────┘              │              └────────────┘
            │                       │                     ▲
            │ pointerup             │                     │
            │                       │ left-click          │ left-drag
            ▼                       │ on empty            │ on empty
        ┌────────────┐              │ (no movement)       │
        │    IDLE    │              │              ┌──────┴─────┐
        └────────────┘              ▼              │ IDLE       │
                              ┌────────────┐       │ (drag      │
                              │ DESELECT   │       │  detected) │
                              │    ALL     │       └────────────┘
                              └────────────┘

        ┌──────────────────────────────────────────────────┐
        │           LEFT-CLICK ON NODE                      │
        │                                                   │
        │  From IDLE:                                       │
        │    no Shift → selectNode(id, false) → IDLE        │
        │    with Shift → selectNode(id, true) → IDLE       │
        │                                                   │
        │  LEFT-DRAG ON NODE (from IDLE):                   │
        │    → DRAGGING_NODE                                │
        │    pointerup → commit move → IDLE                 │
        │    Escape → cancel move → IDLE                    │
        └──────────────────────────────────────────────────┘

        ┌──────────────────────────────────────────────────┐
        │           RIGHT-CLICK ON CANVAS                   │
        │                                                   │
        │  From IDLE:                                       │
        │    → CONTEXT_MENU                                 │
        │    click menu item → execute action → IDLE        │
        │    click outside / Escape → dismiss → IDLE        │
        └──────────────────────────────────────────────────┘

        ┌──────────────────────────────────────────────────┐
        │           CONNECTION DRAWING                      │
        │                                                   │
        │  From IDLE (pointerdown on output port):          │
        │    → CONNECTING (delegated to ConnectionManager)  │
        │    pointerup on valid input port → add conn → IDLE│
        │    pointerup elsewhere → cancel → IDLE            │
        │    Escape → cancel → IDLE                         │
        └──────────────────────────────────────────────────┘
```

### 4.2 State Transition Table

| Current State | Trigger | Guard | Action | Next State |
|--------------|---------|-------|--------|------------|
| `idle` | `pointerdown` on empty canvas (button=0) | — | Record drag start position | `idle` (wait for movement threshold) |
| `idle` | `pointermove` after pointerdown on empty | Distance > 4px | Begin selection rectangle | `selecting-rect` |
| `idle` | `pointerup` on empty canvas (no drag) | — | `deselectAll()` | `idle` |
| `idle` | `pointerdown` on empty canvas (button=1) | — | Begin pan | `panning` |
| `idle` | `pointerdown` on empty canvas (button=0) | `spaceHeld === true` | Begin pan | `panning` |
| `idle` | `pointerdown` on node | — | Select node, record drag offset | `idle` (wait for movement) |
| `idle` | `pointermove` after pointerdown on node | Distance > 4px | Begin node drag | `dragging-node` |
| `idle` | `pointerdown` on output port | — | Delegate to ConnectionManager | `connecting` |
| `idle` | `contextmenu` on empty canvas | — | Show context menu at position | `context-menu` |
| `idle` | `wheel` | — | `handleZoom(event)` | `idle` |
| `idle` | `keydown` Space | — | Set `spaceHeld = true`, cursor → grab | `idle` |
| `panning` | `pointermove` | — | Update pan offset, apply transform | `panning` |
| `panning` | `pointerup` / `pointercancel` | — | End pan, cursor → default | `idle` |
| `panning` | `keyup` Space | Was space-initiated | End pan | `idle` |
| `dragging-node` | `pointermove` | — | Move node(s) to new position, update connections | `dragging-node` |
| `dragging-node` | `pointerup` | — | Commit move (create MoveNodeCommand) | `idle` |
| `dragging-node` | `Escape` | — | Revert to start position | `idle` |
| `selecting-rect` | `pointermove` | — | Update rectangle, highlight enclosed nodes | `selecting-rect` |
| `selecting-rect` | `pointerup` | — | Commit selection of enclosed nodes | `idle` |
| `selecting-rect` | `Escape` | — | Cancel selection rectangle | `idle` |
| `connecting` | (managed by ConnectionManager) | — | — | `idle` (on complete/cancel) |
| `context-menu` | Click menu item | — | Execute action (addNode, autoLayout, etc.) | `idle` |
| `context-menu` | Click outside / Escape | — | Dismiss menu | `idle` |

### 4.3 Zoom State

Zoom is not a separate interaction mode — it fires instantaneously from `idle` and returns to `idle`.

```
ZOOM RANGE:  0.25 ◂───────────────────────────────────▸ 4.0
              25%    50%    75%   100%   150%   200%   400%

ZOOM STEPS:  Each wheel tick multiplies/divides by 1.15
             100% → 115% → 132% → 152% → 175% → 201% → ...
             100% →  87% →  76% →  66% →  57% →  50% → ...

SNAP:        Zoom snaps to 100% when within ±3% (97%–103% → 100%)
```

---

## 5. Interaction Scenarios

### 5.1 Scenario: Zoom at Cursor Position

**The most critical interaction** — zoom must feel natural by keeping the point under the cursor visually stationary.

**Mathematical derivation:**

```
Given:
  - Current viewport: { panX, panY, zoom: oldZoom }
  - Scroll event at screen position: (clientX, clientY)
  - New zoom level: newZoom

Goal:
  The canvas point under the cursor before zooming must remain
  under the cursor after zooming.

Step 1: Find the canvas point under the cursor (before zoom)
  svgRect = svg.getBoundingClientRect()
  relX = clientX - svgRect.left
  relY = clientY - svgRect.top
  canvasPtX = (relX / oldZoom) - panX
  canvasPtY = (relY / oldZoom) - panY

Step 2: After changing zoom, that same canvas point must map
        back to the same screen position.
  relX = (canvasPtX + newPanX) * newZoom
  relY = (canvasPtY + newPanY) * newZoom

Step 3: Solve for newPanX, newPanY
  newPanX = (relX / newZoom) - canvasPtX
  newPanY = (relY / newZoom) - canvasPtY

  Substituting canvasPtX = (relX / oldZoom) - panX:
  newPanX = (relX / newZoom) - (relX / oldZoom) + panX
  newPanX = relX * (1/newZoom - 1/oldZoom) + panX
  newPanY = relY * (1/newZoom - 1/oldZoom) + panY
```

**Pseudocode implementation:**

```javascript
/**
 * Handle scroll-wheel zoom, keeping the point under the cursor fixed.
 * @param {WheelEvent} evt
 */
_handleWheel(evt) {
  evt.preventDefault();

  // 1. Determine zoom direction and compute new zoom
  const direction = evt.deltaY < 0 ? 1 : -1;  // up = zoom in
  const ZOOM_STEP = 1.15;
  const factor = direction > 0 ? ZOOM_STEP : (1 / ZOOM_STEP);
  let newZoom = this._viewport.zoom * factor;

  // 2. Clamp to range [0.25, 4.0]
  newZoom = Math.max(0.25, Math.min(4.0, newZoom));

  // 3. Snap to 100% if close
  if (Math.abs(newZoom - 1.0) < 0.03) {
    newZoom = 1.0;
  }

  // 4. Bail if zoom didn't change (at limits)
  if (newZoom === this._viewport.zoom) return;

  // 5. Compute cursor position relative to SVG element
  const svgRect = this._svgEl.getBoundingClientRect();
  const relX = evt.clientX - svgRect.left;
  const relY = evt.clientY - svgRect.top;

  // 6. Adjust pan so the canvas point under the cursor stays fixed
  const oldZoom = this._viewport.zoom;
  this._viewport.panX += relX * (1 / newZoom - 1 / oldZoom);
  this._viewport.panY += relY * (1 / newZoom - 1 / oldZoom);

  // 7. Apply new zoom
  this._viewport.zoom = newZoom;
  this._applyViewportTransform();
  this._updateZoomDisplay();
  this._updateGridPattern();

  // 8. Notify listeners
  this._emitStateChange('viewport-changed');
}
```

### 5.2 Scenario: Pan via Middle-Mouse Drag

```javascript
_handlePanStart(evt) {
  // Only middle-mouse (button=1) or space+left-click
  if (evt.button === 1 || (evt.button === 0 && this._transient.spaceHeld)) {
    evt.preventDefault();
    this._transient.panState = {
      startClientX: evt.clientX,
      startClientY: evt.clientY,
      startPanX: this._viewport.panX,
      startPanY: this._viewport.panY
    };
    this._transient.interactionMode = 'panning';
    this._svgEl.style.cursor = 'grabbing';
  }
}

_handlePanMove(evt) {
  if (this._transient.interactionMode !== 'panning') return;
  const ps = this._transient.panState;

  // Delta in screen pixels → convert to canvas units (divide by zoom)
  const dx = (evt.clientX - ps.startClientX) / this._viewport.zoom;
  const dy = (evt.clientY - ps.startClientY) / this._viewport.zoom;

  this._viewport.panX = ps.startPanX + dx;
  this._viewport.panY = ps.startPanY + dy;

  this._applyViewportTransform();
}

_handlePanEnd(evt) {
  if (this._transient.interactionMode !== 'panning') return;
  this._transient.panState = null;
  this._transient.interactionMode = 'idle';
  this._svgEl.style.cursor = this._transient.spaceHeld ? 'grab' : 'default';
  this._emitStateChange('viewport-changed');
}
```

### 5.3 Scenario: Node Drop from Palette

```javascript
/**
 * Handle drop event from NodePalette drag.
 * @param {DragEvent} evt
 */
_handleDrop(evt) {
  evt.preventDefault();

  // 1. Extract node type from dataTransfer
  const nodeType = evt.dataTransfer.getData('application/x-dag-node-type');
  if (!nodeType) return;

  // 2. Check node limit
  if (this._state.nodes.length >= 100) {
    this._showToast('Maximum 100 nodes reached', 'error');
    return;
  }

  // 3. Convert drop position to canvas coordinates
  const { canvasX, canvasY } = this.screenToCanvas(evt.clientX, evt.clientY);

  // 4. Center the node on the drop position
  const NODE_WIDTH = 180;
  const NODE_HEIGHT = 72;
  const placementX = canvasX - NODE_WIDTH / 2;
  const placementY = canvasY - NODE_HEIGHT / 2;

  // 5. Snap to grid (20px grid)
  const snappedX = Math.round(placementX / 20) * 20;
  const snappedY = Math.round(placementY / 20) * 20;

  // 6. Create the node (goes through undo manager)
  this.addNode(nodeType, snappedX, snappedY);
}
```

### 5.4 Scenario: Right-Click Context Menu

```javascript
_handleContextMenu(evt) {
  evt.preventDefault();

  // Only show on empty canvas (not on nodes — nodes have their own popover)
  const target = evt.target;
  if (this._isNodeElement(target) || this._isPortElement(target)) return;

  const { canvasX, canvasY } = this.screenToCanvas(evt.clientX, evt.clientY);

  const menuItems = [
    {
      label: 'Add Plain SQL Table',
      icon: '◇',
      iconClass: 'sql-table',
      action: () => this.addNode('sql-table', canvasX, canvasY)
    },
    {
      label: 'Add SQL MLV',
      icon: '◆',
      iconClass: 'sql-mlv',
      action: () => this.addNode('sql-mlv', canvasX, canvasY)
    },
    {
      label: 'Add PySpark MLV',
      icon: '◆',
      iconClass: 'pyspark',
      action: () => this.addNode('pyspark-mlv', canvasX, canvasY)
    },
    { separator: true },
    {
      label: 'Auto Arrange',
      icon: '⊞',
      action: () => this.autoLayout(),
      disabled: this._state.nodes.length < 2
    },
    {
      label: 'Zoom to Fit',
      icon: '⊟',
      action: () => this.fitToView(),
      disabled: this._state.nodes.length === 0
    },
    { separator: true },
    {
      label: 'Select All',
      shortcut: 'Ctrl+A',
      action: () => this.selectAll()
    }
  ];

  this._showContextMenu(evt.clientX, evt.clientY, menuItems);
}
```

### 5.5 Scenario: Marquee Selection

```javascript
_handleSelectionRectStart(startClientX, startClientY) {
  const startCanvas = this.screenToCanvas(startClientX, startClientY);
  this._transient.selectionRect = {
    startX: startCanvas.canvasX,
    startY: startCanvas.canvasY,
    endX: startCanvas.canvasX,
    endY: startCanvas.canvasY
  };
  this._transient.interactionMode = 'selecting-rect';
  this._renderSelectionRect();
}

_handleSelectionRectMove(clientX, clientY) {
  if (this._transient.interactionMode !== 'selecting-rect') return;
  const currentCanvas = this.screenToCanvas(clientX, clientY);
  this._transient.selectionRect.endX = currentCanvas.canvasX;
  this._transient.selectionRect.endY = currentCanvas.canvasY;
  this._renderSelectionRect();
  this._highlightEnclosedNodes();
}

_handleSelectionRectEnd() {
  if (this._transient.interactionMode !== 'selecting-rect') return;
  const rect = this._transient.selectionRect;

  // Normalize rect (startX may be > endX if user dragged right-to-left)
  const x1 = Math.min(rect.startX, rect.endX);
  const y1 = Math.min(rect.startY, rect.endY);
  const x2 = Math.max(rect.startX, rect.endX);
  const y2 = Math.max(rect.startY, rect.endY);

  this.selectNodesInRect(x1, y1, x2, y2);
  this._hideSelectionRect();
  this._transient.selectionRect = null;
  this._transient.interactionMode = 'idle';
}
```

### 5.6 Scenario: Node Drag (Move)

```javascript
_handleNodeDragStart(nodeId, clientX, clientY) {
  const node = this.getNode(nodeId);
  if (!node) return;

  const canvas = this.screenToCanvas(clientX, clientY);
  this._transient.dragTarget = {
    nodeId,
    offsetX: canvas.canvasX - node.x,
    offsetY: canvas.canvasY - node.y,
    startX: node.x,
    startY: node.y
  };
  this._transient.interactionMode = 'dragging-node';

  // If dragged node is not selected, select it (replace selection)
  if (!this._transient.selectedNodeIds.has(nodeId)) {
    this.selectNode(nodeId, false);
  }
}

_handleNodeDragMove(clientX, clientY) {
  if (this._transient.interactionMode !== 'dragging-node') return;
  const dt = this._transient.dragTarget;
  const canvas = this.screenToCanvas(clientX, clientY);

  // Compute new position
  let newX = canvas.canvasX - dt.offsetX;
  let newY = canvas.canvasY - dt.offsetY;

  // Snap to grid (20px)
  newX = Math.round(newX / 20) * 20;
  newY = Math.round(newY / 20) * 20;

  // Compute delta for multi-select drag
  const deltaX = newX - this.getNode(dt.nodeId).x;
  const deltaY = newY - this.getNode(dt.nodeId).y;

  // Move all selected nodes by the same delta
  for (const selectedId of this._transient.selectedNodeIds) {
    const selectedNode = this.getNode(selectedId);
    this._setNodePositionImmediate(selectedId,
      selectedNode.x + deltaX,
      selectedNode.y + deltaY
    );
  }

  // Update connections for all moved nodes (via requestAnimationFrame)
  this._scheduleConnectionUpdate();
}

_handleNodeDragEnd() {
  if (this._transient.interactionMode !== 'dragging-node') return;
  const dt = this._transient.dragTarget;

  // Create undo command(s) for all moved nodes
  const commands = [];
  for (const selectedId of this._transient.selectedNodeIds) {
    const node = this.getNode(selectedId);
    // Only create command if position actually changed
    const startX = selectedId === dt.nodeId ? dt.startX : /* compute from delta */;
    const startY = selectedId === dt.nodeId ? dt.startY : /* compute from delta */;
    if (node.x !== startX || node.y !== startY) {
      commands.push(new MoveNodeCommand(this, selectedId, startX, startY, node.x, node.y));
    }
  }

  if (commands.length > 0) {
    this._undoManager.execute(
      commands.length === 1 ? commands[0] : new BatchCommand(commands)
    );
  }

  this._transient.dragTarget = null;
  this._transient.interactionMode = 'idle';
  this._emitStateChange('node-moved');
}
```

### 5.7 Scenario: Fit-to-View

```javascript
fitToView(padding = 60, animate = true) {
  if (this._state.nodes.length === 0) {
    this.resetView();
    return;
  }

  // 1. Compute bounding box of all nodes in canvas space
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of this._state.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  // 2. Add padding
  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;

  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;

  // 3. Compute zoom to fit content in SVG element
  const svgRect = this._svgEl.getBoundingClientRect();
  const scaleX = svgRect.width / contentWidth;
  const scaleY = svgRect.height / contentHeight;
  let newZoom = Math.min(scaleX, scaleY);

  // 4. Clamp zoom to valid range, cap at 100% (don't zoom past 1:1)
  newZoom = Math.max(0.25, Math.min(1.0, newZoom));

  // 5. Compute pan to center the content
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const newPanX = (svgRect.width / (2 * newZoom)) - centerX;
  const newPanY = (svgRect.height / (2 * newZoom)) - centerY;

  // 6. Apply (with optional animation)
  if (animate) {
    this._animateViewport(newPanX, newPanY, newZoom, 300);
  } else {
    this._viewport.panX = newPanX;
    this._viewport.panY = newPanY;
    this._viewport.zoom = newZoom;
    this._applyViewportTransform();
    this._updateZoomDisplay();
  }

  this._emitStateChange('viewport-changed');
}
```

### 5.8 Scenario: Auto-Layout with Animation

```javascript
autoLayout(options = {}) {
  const { direction = 'TB', nodeSep = 60, rankSep = 80 } = options;

  if (this._state.nodes.length < 2) return;

  // 1. Save old positions for undo
  const oldPositions = this._state.nodes.map(n => ({
    id: n.id, x: n.x, y: n.y
  }));

  // 2. Run Dagre layout
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: nodeSep, ranksep: rankSep,
               marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of this._state.nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const conn of this._state.connections) {
    g.setEdge(conn.sourceNodeId, conn.targetNodeId);
  }

  dagre.layout(g);

  // 3. Read computed positions
  const newPositions = this._state.nodes.map(n => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      x: Math.round((pos.x - n.width / 2) / 20) * 20,   // snap to grid
      y: Math.round((pos.y - n.height / 2) / 20) * 20
    };
  });

  // 4. Create compound undo command
  const cmd = new AutoLayoutCommand(this, oldPositions, newPositions);
  this._undoManager.execute(cmd);

  // 5. Animate nodes to new positions
  this._animateNodePositions(newPositions, 300);

  // 6. Fit to view after layout
  setTimeout(() => this.fitToView(40, true), 350);
}
```

### 5.9 Scenario: Delete Selected Nodes

```javascript
removeSelectedNodes() {
  const selectedIds = [...this._transient.selectedNodeIds];
  if (selectedIds.length === 0) return;

  // Collect all affected connections
  const commands = [];
  const affectedConnections = new Set();

  for (const nodeId of selectedIds) {
    const conns = this.getNodeConnections(nodeId);
    for (const c of [...conns.incoming, ...conns.outgoing]) {
      affectedConnections.add(c.id);
    }
  }

  // 1. Create commands for connection removal (before node removal)
  for (const connId of affectedConnections) {
    const conn = this._state.connections.find(c => c.id === connId);
    if (conn) {
      commands.push(new RemoveConnectionCommand(this, conn));
    }
  }

  // 2. Create commands for node removal
  for (const nodeId of selectedIds) {
    const node = this.getNode(nodeId);
    if (node) {
      commands.push(new RemoveNodeCommand(this, { ...node }));
    }
  }

  // 3. Execute as single batch (one undo step)
  if (commands.length > 0) {
    this._undoManager.execute(new BatchCommand(commands));
  }

  this._transient.selectedNodeIds.clear();
  this._emitStateChange('node-removed');
}
```

---

## 6. Visual Specification

### 6.1 SVG Structure Diagram

The complete SVG DOM hierarchy, showing the layer ordering and nesting.

```
<div class="dag-canvas-wrapper">                    ← Container div (overflow:hidden)
│
├── <svg class="dag-canvas-svg"                     ← Root SVG element
│       width="100%" height="100%"
│       xmlns="http://www.w3.org/2000/svg">
│   │
│   ├── <defs>                                      ← SVG definitions (reusable)
│   │   ├── <pattern id="grid-dots" .../>           ← Dot grid background pattern
│   │   ├── <marker id="arrowhead" .../>            ← Connection arrowhead (default)
│   │   ├── <marker id="arrowhead-active" .../>     ← Connection arrowhead (selected)
│   │   ├── <marker id="arrowhead-hover" .../>      ← Connection arrowhead (hover)
│   │   ├── <filter id="drop-shadow" .../>          ← Node drop shadow
│   │   └── <clipPath id="node-clip" .../>          ← Node content clipping
│   │
│   ├── <rect id="grid-bg"                          ← Grid background (full canvas)
│   │       width="10000" height="10000"
│   │       x="-5000" y="-5000"
│   │       fill="url(#grid-dots)"/>
│   │
│   ├── <g id="canvas-content"                      ← ROOT TRANSFORM GROUP
│   │     transform="scale(Z) translate(X, Y)">     ← Viewport transform applied here
│   │   │
│   │   ├── <g id="connections-layer">              ← LAYER 1: Connections (below nodes)
│   │   │   ├── <path class="connection" .../>      ← Individual Bézier connection
│   │   │   ├── <path class="connection" .../>
│   │   │   ├── <path class="connection-preview"/>  ← Temporary path during drag-connect
│   │   │   └── ...
│   │   │
│   │   ├── <g id="nodes-layer">                    ← LAYER 2: Nodes (above connections)
│   │   │   ├── <g class="dag-node" id="node-1"    ← Individual node group
│   │   │   │     transform="translate(X, Y)">
│   │   │   │   ├── <rect class="node-bg" .../>     ← Node background rectangle
│   │   │   │   ├── <rect class="node-accent" .../>  ← Type-colored top accent bar
│   │   │   │   ├── <foreignObject ...>              ← Rich HTML content container
│   │   │   │   │   └── <div class="node-content">
│   │   │   │   │       ├── <div class="node-header">
│   │   │   │   │       │   ├── <span class="node-type-icon">◇</span>
│   │   │   │   │       │   └── <span class="node-name">orders</span>
│   │   │   │   │       └── <div class="node-meta">
│   │   │   │   │           ├── <span class="type-badge">SQL Table</span>
│   │   │   │   │           └── <span class="schema-badge">bronze</span>
│   │   │   │   │       </div>
│   │   │   │   │   </div>
│   │   │   │   ├── </foreignObject>
│   │   │   │   ├── <circle class="port port-in" .../>   ← Input port (top center)
│   │   │   │   └── <circle class="port port-out" .../>  ← Output port (bottom center)
│   │   │   │
│   │   │   ├── <g class="dag-node" id="node-2" .../>
│   │   │   └── ...
│   │   │
│   │   └── <g id="ui-layer">                       ← LAYER 3: Interaction UI (topmost)
│   │       ├── <rect id="selection-rect" .../>      ← Marquee selection rectangle
│   │       └── <g id="drag-ghost" .../>             ← Drop preview during palette drag
│   │
│   └── </g>  ← end #canvas-content
│
├── <div class="zoom-controls">                     ← Zoom controls (HTML overlay, not SVG)
│   ├── <button class="zoom-btn" data-action="zoom-out">−</button>
│   ├── <span class="zoom-display">100%</span>
│   ├── <button class="zoom-btn" data-action="zoom-in">+</button>
│   └── <button class="zoom-btn" data-action="fit-view">⊞</button>
│
├── <div class="canvas-context-menu" hidden>         ← Context menu (HTML overlay)
│   └── ...
│
└── </div>  ← end .dag-canvas-wrapper
```

### 6.2 Layer Ordering (Paint Order)

Layers are rendered bottom-to-top. This ensures correct visual stacking:

```
TOPMOST   ─── 5. Zoom controls (HTML, position:absolute, bottom-right)
          ─── 4. Context menu (HTML, position:fixed, at cursor)
          ─── 3. UI layer: selection rect, drag ghost (SVG, inside transform group)
          ─── 2. Nodes layer: all DagNode groups (SVG, inside transform group)
          ─── 1. Connections layer: all Bézier paths (SVG, inside transform group)
BOTTOMMOST── 0. Grid background: dot pattern (SVG, fill="url(#grid-dots)")
```

### 6.3 Grid Pattern

The background dot grid provides spatial reference. It must scale with zoom but maintain visual consistency.

```xml
<pattern id="grid-dots"
         width="20" height="20"
         patternUnits="userSpaceOnUse">
  <circle cx="10" cy="10" r="0.8"
          fill="oklch(0.78 0 0 / 0.35)" />
</pattern>
```

**Grid behavior by zoom level:**

| Zoom | Dot spacing (screen px) | Dot size (screen px) | Behavior |
|------|------------------------|---------------------|----------|
| 25% | 5px | 0.2px | Very subtle — dots barely visible |
| 50% | 10px | 0.4px | Subtle dots |
| 100% | 20px | 0.8px | Clear, comfortable grid |
| 200% | 40px | 1.6px | Prominent grid |
| 400% | 80px | 3.2px | Very prominent — consider capping visual size |

The grid pattern is applied to a large background rect (10000×10000, centered at origin) so it covers the entire pannable area. Because it uses `patternUnits="userSpaceOnUse"`, it transforms correctly with the viewport.

### 6.4 Node Visual Design (from Mock)

Each node is rendered as an SVG `<g>` group with the following visual structure:

```
┌──────────────────────────────────┐  ← 180×72, border-radius 10px
│ ┌──┐                             │
│ │◇ │  orders                     │  ← 18×18 icon + 13px semibold mono name
│ └──┘                             │
│  SQL Table   bronze              │  ← 9px uppercase badges
│                                  │
│              ●                   │  ← Output port (bottom center, 8px circle)
└──────────────────────────────────┘
     ●                                ← Input port (top center, only for MLVs)
```

**Node dimensions:**

| Property | Value |
|----------|-------|
| Width | 180px (canvas units) |
| Height | 72px (canvas units) |
| Border radius | 10px (`--r-lg`) |
| Background | `#ffffff` (`--surface`) |
| Border | 1.5px solid `rgba(0,0,0,0.12)` (`--border-bright`) |
| Shadow | `0 2px 8px rgba(0,0,0,0.04)` (`--shadow-sm`) |
| Padding | 12px 16px |

**Node states:**

| State | Border | Shadow | Other |
|-------|--------|--------|-------|
| Default | 1.5px `--border-bright` | `--shadow-sm` | — |
| Hover | 1.5px `rgba(0,0,0,0.18)` | `--shadow-md` | `transform: translateY(-1px)` |
| Selected | 1.5px `--accent` | `0 0 0 3px var(--accent-glow), var(--shadow-md)` | Pulse animation (2.5s) |
| Dragging | 1.5px `--accent` | `--shadow-lg` | `opacity: 0.85` |
| Error/incomplete | 1.5px `--status-fail` | — | Warning badge ▲ top-right |

**Port design:**

| Property | Default | Hover | Active (connecting) |
|----------|---------|-------|-------------------|
| Radius | 4px | 6px (with transition) | 6px |
| Fill | `--text-muted` | `--accent` | `--accent` |
| Border | 1.5px `--surface` | 1.5px `--surface` | 2px `--accent-glow` |
| Hit area | 16px radius (invisible) | 16px radius | 16px radius |

**Port positions (canvas coordinates, relative to node origin):**

| Port | cx | cy | Notes |
|------|----|----|-------|
| Input (top) | `width / 2` = 90 | 0 | Only present on MLV nodes |
| Output (bottom) | `width / 2` = 90 | `height` = 72 | Present on all node types |

### 6.5 Connection Visual Design

Connections are cubic Bézier SVG `<path>` elements in the connections layer.

**Path calculation (vertical/TB flow):**

```javascript
/**
 * Compute cubic Bézier path from source output port to target input port.
 * Uses vertical S-curve with dynamic control point offset.
 */
function computeConnectionPath(sourceNode, targetNode) {
  // Source port: bottom-center of source node
  const sx = sourceNode.x + sourceNode.width / 2;
  const sy = sourceNode.y + sourceNode.height;

  // Target port: top-center of target node
  const tx = targetNode.x + targetNode.width / 2;
  const ty = targetNode.y;

  // Control point offset: proportional to vertical distance, minimum 40px
  const verticalDist = Math.abs(ty - sy);
  const cpOffset = Math.max(40, verticalDist * 0.4);

  // For upward connections (target above source), flip control points
  const cp1y = sy + cpOffset;
  const cp2y = ty - cpOffset;

  return `M ${sx},${sy} C ${sx},${cp1y} ${tx},${cp2y} ${tx},${ty}`;
}
```

**Connection appearance:**

| State | Stroke | Width | Marker | Other |
|-------|--------|-------|--------|-------|
| Default | `oklch(0.60 0.02 250 / 0.50)` | 1.5px | `url(#arrowhead)` | — |
| Hover | `oklch(0.55 0.05 250 / 0.80)` | 2.5px | `url(#arrowhead-hover)` | Show delete button at midpoint |
| Selected | `--accent` | 2px | `url(#arrowhead-active)` | — |
| Active flow | `--accent` at 25% opacity | 2px | — | Dashed animation (`stroke-dasharray: 6 4`, animated offset) |
| Preview (drag) | `--text-muted` at 40% opacity | 2px | — | `stroke-dasharray: 4 4` |

**Arrowhead marker:**

```xml
<marker id="arrowhead" markerWidth="8" markerHeight="6"
        refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
  <polygon points="0 0, 8 3, 0 6" fill="oklch(0.60 0.02 250 / 0.50)" />
</marker>
```

### 6.6 Selection Rectangle

```xml
<rect id="selection-rect"
      fill="oklch(0.65 0.20 280 / 0.06)"
      stroke="oklch(0.65 0.20 280 / 0.40)"
      stroke-width="1"
      stroke-dasharray="4 2"
      rx="2" />
```

### 6.7 Zoom Controls

From the mock — floating bottom-right panel:

```
┌─────────────────────────────┐
│  [−]  [+]  [⊞]   100%      │
└─────────────────────────────┘
```

| Element | Size | Style |
|---------|------|-------|
| Container | auto × 30px | `background: --surface`, `border: 1px solid --border-bright`, `border-radius: --r-md`, `box-shadow: --shadow-md` |
| Buttons | 30 × 30px | `border-radius: --r-sm`, hover: `background: --surface-2` |
| Percentage | — | `font-size: --text-sm`, `font-weight: 600`, `color: --text-dim`, `min-width: 40px`, `text-align: center` |

### 6.8 Context Menu

Styled consistently with workspace-explorer context menu pattern:

```
┌─────────────────────────────────┐
│  ◇  Add Plain SQL Table         │
│  ◆  Add SQL MLV                 │
│  ◆  Add PySpark MLV             │
│ ─────────────────────────────── │
│  ⊞  Auto Arrange                │
│  ⊟  Zoom to Fit                 │
│ ─────────────────────────────── │
│     Select All        Ctrl+A    │
└─────────────────────────────────┘
```

| Property | Value |
|----------|-------|
| Background | `--surface` |
| Border | `1px solid --border-bright` |
| Border radius | `--r-lg` (10px) |
| Shadow | `--shadow-lg` |
| Min width | 200px |
| Item padding | `8px 12px` |
| Item font | `--text-sm`, `--font` |
| Item hover | `background: --surface-2` |
| Separator | `1px solid --border`, `margin: 4px 0` |
| Disabled | `opacity: 0.4`, `pointer-events: none` |
| Entry animation | `scaleSpring 250ms var(--spring)` |

### 6.9 Canvas Empty State

When no nodes exist on the canvas, show a centered hint:

```
┌─────────────────────────────────────────┐
│                                         │
│                                         │
│         Drag nodes from the             │
│         palette to get started          │
│                                         │
│    or right-click for quick add         │
│                                         │
│                                         │
└─────────────────────────────────────────┘
```

| Property | Value |
|----------|-------|
| Text | "Drag nodes from the palette to get started" |
| Subtext | "or right-click for quick add" |
| Font | `--text-md`, `color: --text-muted` |
| Position | Centered in SVG viewport |
| Visibility | Hidden when `nodes.length > 0` |

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Shortcuts

| Key | Action | Guard |
|-----|--------|-------|
| `Delete` / `Backspace` | Delete selected node(s) and their connections | Selection exists |
| `Ctrl+Z` / `Cmd+Z` | Undo | Undo stack non-empty |
| `Ctrl+Shift+Z` / `Cmd+Shift+Z` | Redo | Redo stack non-empty |
| `Ctrl+Y` / `Cmd+Y` | Redo (alt) | Redo stack non-empty |
| `Ctrl+A` / `Cmd+A` | Select all nodes | Canvas has focus |
| `Escape` | Cancel current operation / Deselect all | Depends on mode |
| `Space` (hold) | Enable pan mode (cursor → grab) | Canvas has focus |
| `+` / `=` | Zoom in one step | Canvas has focus |
| `−` / `_` | Zoom out one step | Canvas has focus |
| `Ctrl+0` | Reset zoom to 100% | Canvas has focus |
| `Ctrl+1` | Fit to view | Canvas has focus |
| `Tab` | Focus next node (topological order) | Canvas has focus |
| `Shift+Tab` | Focus previous node | Canvas has focus |
| `Enter` | Open node popover for focused node | Node has focus |
| `Arrow keys` | Nudge selected node(s) by 20px (1 grid unit) | Selection exists |
| `Shift+Arrow keys` | Nudge selected node(s) by 4px (fine) | Selection exists |

### 7.2 Focus Management

```
Tab order within Page 3:
  1. Node Palette items (sidebar)
  2. Canvas SVG element (receives focus)
  3. Within canvas: nodes in topological order
  4. Zoom control buttons
  5. Code preview panel toggle
```

When the canvas SVG receives focus:
- Visual: `outline: 2px solid var(--accent)` with `3px offset`
- The first node (or last selected) gets focus ring
- Arrow keys navigate between connected nodes

### 7.3 ARIA Attributes

```html
<!-- SVG root -->
<svg role="application"
     aria-label="DAG canvas — {N} nodes, {M} connections"
     tabindex="0">

  <!-- Node group -->
  <g role="listbox"
     aria-label="Nodes"
     aria-multiselectable="true">

    <!-- Individual node -->
    <g role="option"
       aria-label="SQL MLV node: order_summary, schema: silver, 2 parents, 1 child"
       aria-selected="true"
       tabindex="-1">
    </g>
  </g>
</svg>

<!-- Live region for announcing changes -->
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
  <!-- Dynamically updated: -->
  <!-- "Added SQL Table node: orders" -->
  <!-- "Connected orders to order_summary" -->
  <!-- "Deleted node: products and 2 connections" -->
  <!-- "Zoom: 75%" -->
</div>
```

### 7.4 Screen Reader Announcements

| Action | Announcement |
|--------|-------------|
| Node added | "Added {type} node: {name}" |
| Node deleted | "Deleted node: {name} and {N} connections" |
| Connection added | "Connected {source} to {target}" |
| Connection deleted | "Disconnected {source} from {target}" |
| Selection changed | "{N} nodes selected" |
| Zoom changed | "Zoom: {percent}%" |
| Auto-layout | "Auto-arranged {N} nodes" |
| Undo | "Undid: {description}" |
| Redo | "Redid: {description}" |
| Node limit | "Cannot add node — maximum 100 nodes reached" |

### 7.5 Color Accessibility

Node types must be distinguishable by more than color alone:

| Node Type | Color | Icon | Badge Text |
|-----------|-------|------|-----------|
| SQL Table | Blue `#2d7ff9` | ◇ (diamond outline) | "SQL Table" |
| SQL MLV | Purple `--accent` | ◆ (diamond filled) | "SQL MLV" |
| PySpark MLV | Amber `--status-warn` | ◆ (diamond filled) | "PySpark" |

Triple redundancy: color + icon shape + text label. WCAG AA compliant.

---

## 8. Error Handling

### 8.1 Error Categories

| # | Error | Trigger | User Feedback | Recovery |
|---|-------|---------|---------------|----------|
| E1 | Node limit reached | `addNode()` when count=100 | Toast: "Maximum 100 nodes reached" (warning) | Dismiss toast, delete unused nodes |
| E2 | Duplicate connection | Drag connect to already-connected port | Toast: "Connection already exists" (info) | Cancel connection preview |
| E3 | Self-loop attempt | Drag from output to own input port | Target port dims, cursor "not-allowed" | Release cancels connection |
| E4 | Cycle detected | Connection would create cycle | Target port turns red, toast: "Cannot create cycle in DAG" | Release cancels connection |
| E5 | Invalid drop target | Non-node-type data dropped on canvas | Ignore silently (no visual feedback) | — |
| E6 | Invalid node name | Duplicate name or empty string | Inline validation: red border + message | Focus input, show requirements |
| E7 | Node name collision | Two nodes with same name | Yellow warning badge on both nodes | User renames one |
| E8 | Orphan MLV (no parents) | MLV node with zero incoming connections | Warning badge ▲ on node, validation error | User must connect a parent |
| E9 | Template load failure | Corrupted or incompatible JSON | Toast: "Failed to load template: {reason}" (error) | Clear canvas, show error details |
| E10 | Undo stack overflow | >50 commands in stack | Oldest commands silently evicted | — (transparent to user) |

### 8.2 Validation Rules

The canvas continuously validates the DAG topology and reports errors via the `onStateChange` callback.

```javascript
/**
 * Validate the current canvas state.
 * @returns {{ isValid: boolean, errors: string[] }}
 */
validate() {
  const errors = [];

  // V1: At least one node required
  if (this._state.nodes.length === 0) {
    errors.push('Add at least one node to the canvas');
  }

  // V2: All MLV nodes must have at least one parent
  for (const node of this._state.nodes) {
    if (node.type === 'sql-mlv' || node.type === 'pyspark-mlv') {
      const incoming = this._state.connections.filter(c => c.targetNodeId === node.id);
      if (incoming.length === 0) {
        errors.push(`${node.name} (${node.type}) has no parent — connect a source`);
      }
    }
  }

  // V3: No duplicate node names within the same schema
  const nameMap = new Map();
  for (const node of this._state.nodes) {
    const key = `${node.schema}.${node.name}`;
    if (nameMap.has(key)) {
      errors.push(`Duplicate name: ${node.schema}.${node.name}`);
    }
    nameMap.set(key, node.id);
  }

  // V4: No cycles (should be prevented at draw-time, but verify)
  if (this._hasCycles()) {
    errors.push('DAG contains a cycle — this should not happen');
  }

  // V5: Node names are valid SQL identifiers
  for (const node of this._state.nodes) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node.name)) {
      errors.push(`Invalid name: "${node.name}" — use letters, numbers, underscores`);
    }
  }

  return { isValid: errors.length === 0, errors };
}
```

### 8.3 Cycle Detection Algorithm

```javascript
/**
 * Check if adding an edge from sourceId → targetId would create a cycle.
 * Uses DFS from targetId: if we can reach sourceId, it's a cycle.
 * O(V + E) — instant at ≤100 nodes.
 *
 * @param {string} sourceId - Node the edge would come FROM
 * @param {string} targetId - Node the edge would go TO
 * @returns {boolean} true if the edge would create a cycle
 */
wouldCreateCycle(sourceId, targetId) {
  if (sourceId === targetId) return true;  // Self-loop

  // DFS from targetId, following outgoing edges
  const visited = new Set();
  const stack = [targetId];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (nodeId === sourceId) return true;  // Found source via downstream path = cycle
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    // Follow all outgoing connections from this node
    for (const conn of this._state.connections) {
      if (conn.sourceNodeId === nodeId) {
        stack.push(conn.targetNodeId);
      }
    }
  }

  return false;
}

/**
 * Check if the entire graph has any cycles (paranoid validation).
 * Uses Kahn's algorithm (topological sort).
 * @returns {boolean}
 */
_hasCycles() {
  const inDegree = new Map();
  for (const node of this._state.nodes) {
    inDegree.set(node.id, 0);
  }
  for (const conn of this._state.connections) {
    inDegree.set(conn.targetNodeId, (inDegree.get(conn.targetNodeId) || 0) + 1);
  }

  const queue = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const nodeId = queue.shift();
    processed++;
    for (const conn of this._state.connections) {
      if (conn.sourceNodeId === nodeId) {
        const newDegree = inDegree.get(conn.targetNodeId) - 1;
        inDegree.set(conn.targetNodeId, newDegree);
        if (newDegree === 0) queue.push(conn.targetNodeId);
      }
    }
  }

  return processed !== this._state.nodes.length;
}
```

---

## 9. Performance

### 9.1 Performance Budget

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Initial render (empty canvas) | < 10ms | `performance.now()` around `init()` |
| Initial render (100 nodes + connections) | < 100ms | `performance.now()` around `fromJSON()` |
| Node add (single) | < 5ms | Time from `addNode()` to DOM update |
| Node drag (per frame) | < 8ms | `requestAnimationFrame` callback duration |
| Zoom/Pan (per frame) | < 2ms | Single `setAttribute('transform')` call |
| Connection path update (per frame) | < 4ms | Path recalculation for affected edges |
| Auto-layout (Dagre, 100 nodes) | < 50ms | `dagre.layout()` execution |
| Auto-layout animation | 300ms total | CSS transition / rAF animation |
| Selection rectangle update | < 2ms | Rect attribute update + intersection test |
| Serialization (`toJSON()`) | < 5ms | JSON construction |
| Deserialization (`fromJSON()`) | < 100ms | DOM construction + layout |
| FPS during interaction | ≥ 60fps | Chrome DevTools Performance panel |
| Memory (100 nodes) | < 5 MB | Chrome DevTools Memory snapshot |

### 9.2 Rendering Optimization Strategy

**Principle: One transform, not N transforms.**

The single most important optimization: zoom and pan are applied as a SINGLE `transform` attribute on the root `<g id="canvas-content">` group. The browser's GPU compositor handles scaling all children — we never iterate over nodes to update individual transforms during zoom/pan.

```javascript
// FAST: One DOM mutation for zoom/pan
this._contentGroup.setAttribute('transform', `scale(${z}) translate(${px},${py})`);

// SLOW (anti-pattern): Iterating all nodes
// this._state.nodes.forEach(n => n.element.setAttribute('transform', ...));
```

**Principle: Lazy connection updates during drag.**

When a node is being dragged, only connections attached to the dragged node(s) need path recalculation. Use `requestAnimationFrame` to batch these:

```javascript
_scheduleConnectionUpdate() {
  if (this._connectionUpdateScheduled) return;
  this._connectionUpdateScheduled = true;
  requestAnimationFrame(() => {
    this._connectionUpdateScheduled = false;
    this._updateAffectedConnections();
  });
}

_updateAffectedConnections() {
  const draggedIds = this._transient.selectedNodeIds;
  for (const conn of this._state.connections) {
    if (draggedIds.has(conn.sourceNodeId) || draggedIds.has(conn.targetNodeId)) {
      const pathEl = this._connectionElements.get(conn.id);
      if (pathEl) {
        const sourceNode = this.getNode(conn.sourceNodeId);
        const targetNode = this.getNode(conn.targetNodeId);
        pathEl.setAttribute('d', computeConnectionPath(sourceNode, targetNode));
      }
    }
  }
}
```

**Principle: CSS `will-change` for compositor optimization.**

```css
.dag-canvas-svg {
  will-change: transform;  /* Hint: this element will be transformed */
}

#canvas-content {
  will-change: transform;  /* Promote to compositor layer */
}

.dag-node {
  will-change: transform;  /* During drag only — remove after */
}
```

**Principle: No virtualization needed at ≤100 nodes.**

100 SVG `<g>` groups + 150 SVG `<path>` elements = ~250 DOM elements. Modern browsers handle 10,000+ SVG elements before performance degrades. Virtualization (viewport culling) is unnecessary for our scale.

### 9.3 Debouncing Strategy

| Operation | Debounce | Rationale |
|-----------|----------|-----------|
| Node position during drag | `requestAnimationFrame` (16ms) | 60fps cap on DOM updates |
| Connection path during drag | `requestAnimationFrame` (16ms) | Batch with node position |
| State change callback | 50ms debounce | Prevent excessive parent re-renders |
| Grid pattern update | On zoom end only | Grid pattern recalc is cheap but unnecessary during zoom |
| Validation | 200ms debounce | Validation involves iteration — not per-frame |
| Serialization (for code preview) | 300ms debounce | JSON construction + code gen is heavier |
| Accessibility announcement | 500ms debounce | Don't overwhelm screen readers |

### 9.4 Memory Budget

| Data Structure | Size at 100 Nodes | Notes |
|---------------|-------------------|-------|
| `CanvasState.nodes[]` | ~20 KB | 100 nodes × ~200 bytes each |
| `CanvasState.connections[]` | ~5 KB | ~150 connections × ~40 bytes each |
| DOM elements (SVG) | ~300 KB | 250 elements with attributes, styles |
| Undo stack (50 commands) | ~50 KB | Delta-only commands, ~1 KB each |
| Event listeners | ~5 KB | ~30 listeners |
| **Total** | ~380 KB | Well within budget |

### 9.5 Stress Test Scenarios

| Scenario | Nodes | Connections | Expected FPS | Notes |
|----------|-------|-------------|-------------|-------|
| Empty canvas | 0 | 0 | 60 | Baseline |
| Small DAG | 10 | 12 | 60 | Typical use case |
| Medium DAG | 30 | 45 | 60 | Complex pipeline |
| Large DAG | 100 | 150 | 60 | Maximum allowed |
| Drag 50 selected nodes | 50 moving | 75 updating | ≥55 | Most demanding scenario |
| Rapid zoom (fast scroll) | 100 | 150 | 60 | Transform-only, GPU-composited |
| Auto-layout 100 nodes | 100 | 150 | N/A | <50ms computation, then 300ms animation |

---

## 10. Implementation Notes

### 10.1 File Structure

```
src/frontend/js/
├── infra-wizard/
│   ├── dag-canvas.js           ← This component (DagCanvas class)
│   ├── dag-node.js             ← C06: DagNode class
│   ├── connection-manager.js   ← C07: ConnectionManager class
│   ├── node-palette.js         ← C05: NodePalette class
│   ├── code-preview-panel.js   ← C08: CodePreviewPanel class
│   ├── auto-layout-engine.js   ← C13: AutoLayoutEngine class
│   ├── undo-redo-manager.js    ← C14: UndoRedoManager class
│   ├── commands/               ← Undo/redo command classes
│   │   ├── add-node-command.js
│   │   ├── remove-node-command.js
│   │   ├── move-node-command.js
│   │   ├── add-connection-command.js
│   │   ├── remove-connection-command.js
│   │   ├── edit-node-command.js
│   │   ├── auto-layout-command.js
│   │   └── batch-command.js
│   └── dag-utils.js            ← Shared utilities (coordinate math, path calc, etc.)
```

### 10.2 Class Skeleton

```javascript
/**
 * DagCanvas — Core SVG canvas for DAG topology building.
 *
 * Manages the SVG root, viewport transforms, node/connection layers,
 * and user interactions (zoom, pan, drop, select, context menu).
 *
 * @class DagCanvas
 * @module infra-wizard
 * @see C04-dag-canvas.md
 */
class DagCanvas {
  // ═══════════════════════════════════════════════
  //  Construction & Lifecycle
  // ═══════════════════════════════════════════════

  constructor(containerEl, options) {
    this._container = containerEl;
    this._undoManager = options.undoManager;
    this._onStateChange = options.onStateChange || (() => {});
    this._availableSchemas = options.availableSchemas || ['dbo'];
    this._dataTheme = options.dataTheme || 'ecommerce';

    // DOM references (populated in init)
    this._svgEl = null;
    this._contentGroup = null;
    this._connectionsLayer = null;
    this._nodesLayer = null;
    this._uiLayer = null;
    this._selectionRectEl = null;
    this._gridBgEl = null;
    this._zoomControlsEl = null;
    this._contextMenuEl = null;
    this._emptyStateEl = null;
    this._announceEl = null;  // aria-live region

    // State
    this._state = {
      nodes: [],
      connections: [],
      viewport: { panX: 0, panY: 0, zoom: 1.0 },
      nextNodeId: 1,
      nextConnectionId: 1
    };
    this._viewport = this._state.viewport;

    // Transient state
    this._transient = {
      selectedNodeIds: new Set(),
      selectedConnectionIds: new Set(),
      interactionMode: 'idle',
      selectionRect: null,
      dragTarget: null,
      panState: null,
      spaceHeld: false,
      contextMenuOpen: false,
      contextMenuPosition: null,
      availableSchemas: this._availableSchemas,
      dataTheme: this._dataTheme
    };

    // DOM element maps (for fast lookup)
    this._nodeElements = new Map();       // nodeId → SVG <g> element
    this._connectionElements = new Map(); // connectionId → SVG <path> element

    // Debounce handles
    this._connectionUpdateScheduled = false;
    this._stateChangeDebounce = null;
    this._validationDebounce = null;

    // Child components (injected after construction)
    this._connectionManager = null;

    // Bound event handlers (for cleanup)
    this._boundHandlers = {};
  }

  async init() { /* ... */ }
  destroy() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  SVG Construction
  // ═══════════════════════════════════════════════

  _createSvgStructure() { /* Build full SVG DOM per §6.1 */ }
  _createDefs() { /* Patterns, markers, filters */ }
  _createGridBackground() { /* Dot pattern rect */ }
  _createZoomControls() { /* HTML overlay */ }
  _createContextMenu() { /* HTML overlay */ }
  _createEmptyState() { /* Centered hint text */ }
  _createAnnounceRegion() { /* aria-live div */ }

  // ═══════════════════════════════════════════════
  //  Event Binding
  // ═══════════════════════════════════════════════

  _bindEvents() { /* Attach all pointer, keyboard, wheel, drag events */ }
  _unbindEvents() { /* Remove all listeners */ }
  _handleWheel(evt) { /* Zoom — see §5.1 */ }
  _handlePointerDown(evt) { /* Route to pan/select/drag based on target + button */ }
  _handlePointerMove(evt) { /* Route to active interaction mode */ }
  _handlePointerUp(evt) { /* Complete active interaction */ }
  _handleKeyDown(evt) { /* Keyboard shortcuts — see §7.1 */ }
  _handleKeyUp(evt) { /* Space release for pan mode */ }
  _handleDrop(evt) { /* Node drop from palette — see §5.3 */ }
  _handleDragOver(evt) { /* Allow drop */ }
  _handleContextMenu(evt) { /* Right-click menu — see §5.4 */ }

  // ═══════════════════════════════════════════════
  //  Coordinate Math
  // ═══════════════════════════════════════════════

  screenToCanvas(clientX, clientY) { /* See §2.4 */ }
  canvasToScreen(canvasX, canvasY) { /* See §2.4 */ }
  _applyViewportTransform() { /* See §2.5 */ }

  // ═══════════════════════════════════════════════
  //  Node Operations (public API — see §3.2)
  // ═══════════════════════════════════════════════

  addNode(type, canvasX, canvasY, overrides = {}) { /* ... */ }
  removeNode(nodeId) { /* ... */ }
  removeSelectedNodes() { /* ... */ }
  moveNode(nodeId, newX, newY) { /* ... */ }
  updateNode(nodeId, updates) { /* ... */ }
  getNode(nodeId) { /* ... */ }
  getNodes() { /* ... */ }
  getNodeCount() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Node DOM Rendering
  // ═══════════════════════════════════════════════

  _renderNode(nodeData) { /* Create SVG <g> with foreignObject, ports */ }
  _updateNodeDOM(nodeId) { /* Update existing node's visual state */ }
  _removeNodeDOM(nodeId) { /* Remove SVG <g> from DOM */ }
  _setNodePositionImmediate(nodeId, x, y) { /* Direct transform, no undo */ }
  _renderNodeSelectionState(nodeId) { /* Apply/remove selected class */ }

  // ═══════════════════════════════════════════════
  //  Connection Operations (public API — see §3.3)
  // ═══════════════════════════════════════════════

  addConnection(sourceNodeId, targetNodeId) { /* ... */ }
  removeConnection(connectionId) { /* ... */ }
  getNodeConnections(nodeId) { /* ... */ }
  getConnections() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Connection DOM Rendering
  // ═══════════════════════════════════════════════

  _renderConnection(connData) { /* Create SVG <path> */ }
  _updateConnectionPath(connectionId) { /* Recompute + update <path> d attr */ }
  _removeConnectionDOM(connectionId) { /* Remove <path> from DOM */ }
  _scheduleConnectionUpdate() { /* rAF-batched update — see §9.2 */ }
  _updateAffectedConnections() { /* Recompute paths for moved nodes */ }

  // ═══════════════════════════════════════════════
  //  Selection (public API — see §3.4)
  // ═══════════════════════════════════════════════

  selectNode(nodeId, additive = false) { /* ... */ }
  selectNodesInRect(x1, y1, x2, y2) { /* ... */ }
  deselectAll() { /* ... */ }
  selectAll() { /* ... */ }
  getSelectedNodeIds() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Selection Rectangle
  // ═══════════════════════════════════════════════

  _handleSelectionRectStart(startX, startY) { /* see §5.5 */ }
  _handleSelectionRectMove(x, y) { /* ... */ }
  _handleSelectionRectEnd() { /* ... */ }
  _renderSelectionRect() { /* Update <rect> attributes */ }
  _hideSelectionRect() { /* Hide <rect> */ }
  _highlightEnclosedNodes() { /* Temporary highlight during marquee */ }

  // ═══════════════════════════════════════════════
  //  Node Drag (Move)
  // ═══════════════════════════════════════════════

  _handleNodeDragStart(nodeId, clientX, clientY) { /* see §5.6 */ }
  _handleNodeDragMove(clientX, clientY) { /* ... */ }
  _handleNodeDragEnd() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Viewport Control (public API — see §3.5)
  // ═══════════════════════════════════════════════

  setZoom(newZoom, centerX, centerY, animate = false) { /* ... */ }
  getZoom() { /* ... */ }
  zoomIn() { /* ... */ }
  zoomOut() { /* ... */ }
  pan(deltaScreenX, deltaScreenY) { /* ... */ }
  fitToView(padding = 60, animate = true) { /* see §5.7 */ }
  resetView() { /* ... */ }
  getViewport() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Viewport Helpers
  // ═══════════════════════════════════════════════

  _handlePanStart(evt) { /* see §5.2 */ }
  _handlePanMove(evt) { /* ... */ }
  _handlePanEnd(evt) { /* ... */ }
  _updateZoomDisplay() { /* Update "100%" text */ }
  _updateGridPattern() { /* Adjust grid visibility at zoom extremes */ }
  _animateViewport(panX, panY, zoom, durationMs) { /* Smooth transition */ }

  // ═══════════════════════════════════════════════
  //  Auto-Layout (see §5.8)
  // ═══════════════════════════════════════════════

  autoLayout(options = {}) { /* ... */ }
  _animateNodePositions(positions, durationMs) { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Serialization (public API — see §3.6)
  // ═══════════════════════════════════════════════

  toJSON() { /* ... */ }
  fromJSON(state, animate = false) { /* ... */ }
  clear() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Validation (see §8.2)
  // ═══════════════════════════════════════════════

  validate() { /* ... */ }
  wouldCreateCycle(sourceId, targetId) { /* see §8.3 */ }
  _hasCycles() { /* Kahn's algorithm — see §8.3 */ }

  // ═══════════════════════════════════════════════
  //  Context Menu
  // ═══════════════════════════════════════════════

  _showContextMenu(clientX, clientY, items) { /* ... */ }
  _hideContextMenu() { /* ... */ }

  // ═══════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════

  _isNodeElement(el) { /* Check if element is part of a node group */ }
  _isPortElement(el) { /* Check if element is a port circle */ }
  _getNodeIdFromElement(el) { /* Walk up DOM to find node group id */ }
  _generateNodeName(type) { /* Auto-name: "table_1", "mlv_2", etc. */ }
  _showToast(message, type) { /* Delegate to wizard toast system */ }
  _announce(text) { /* Update aria-live region */ }
  _emitStateChange(type) { /* Debounced callback to parent */ }
  _updateEmptyState() { /* Show/hide empty state hint */ }
}
```

### 10.3 Construction Sequence (init())

```javascript
async init() {
  // 1. Create SVG structure
  this._createSvgStructure();

  // 2. Create HTML overlays (zoom controls, context menu, empty state)
  this._createZoomControls();
  this._createContextMenu();
  this._createEmptyState();
  this._createAnnounceRegion();

  // 3. Bind all event listeners
  this._bindEvents();

  // 4. Set initial viewport
  this._viewport.panX = 0;
  this._viewport.panY = 0;
  this._viewport.zoom = 1.0;
  this._applyViewportTransform();
  this._updateZoomDisplay();

  // 5. Show empty state
  this._updateEmptyState();

  // 6. Focus SVG for keyboard events
  this._svgEl.focus({ preventScroll: true });
}
```

### 10.4 Destruction Sequence (destroy())

```javascript
destroy() {
  // 1. Unbind all event listeners
  this._unbindEvents();

  // 2. Cancel any pending animation frames
  if (this._connectionUpdateScheduled) {
    cancelAnimationFrame(this._connectionUpdateRAF);
  }

  // 3. Clear debounce timers
  clearTimeout(this._stateChangeDebounce);
  clearTimeout(this._validationDebounce);

  // 4. Clear element maps
  this._nodeElements.clear();
  this._connectionElements.clear();

  // 5. Remove DOM
  this._container.innerHTML = '';

  // 6. Null out references
  this._svgEl = null;
  this._contentGroup = null;
  this._state = null;
  this._transient = null;
}
```

### 10.5 Integration with UndoRedoManager

All canvas mutations must go through the undo manager. Direct state mutation is forbidden in public methods.

```javascript
addNode(type, canvasX, canvasY, overrides = {}) {
  // 1. Validate
  if (this._state.nodes.length >= 100) {
    this._showToast('Maximum 100 nodes reached', 'warning');
    throw new Error('Node limit reached');
  }

  // 2. Create node data
  const nodeData = {
    id: `node-${this._state.nextNodeId++}`,
    name: overrides.name || this._generateNodeName(type),
    type,
    schema: overrides.schema || this._availableSchemas[0] || 'dbo',
    x: Math.round(canvasX / 20) * 20,  // snap to grid
    y: Math.round(canvasY / 20) * 20,
    width: 180,
    height: 72
  };

  // 3. Execute through undo manager
  const cmd = new AddNodeCommand(this, nodeData);
  this._undoManager.execute(cmd);

  // 4. Select the new node
  this.selectNode(nodeData.id);

  // 5. Announce for screen readers
  this._announce(`Added ${type.replace('-', ' ')} node: ${nodeData.name}`);

  return nodeData;
}
```

**AddNodeCommand implementation:**

```javascript
class AddNodeCommand {
  constructor(canvas, nodeData) {
    this._canvas = canvas;
    this._nodeData = { ...nodeData };
    this.description = `Add ${nodeData.type}: ${nodeData.name}`;
  }

  execute() {
    this._canvas._state.nodes.push({ ...this._nodeData });
    this._canvas._renderNode(this._nodeData);
    this._canvas._updateEmptyState();
    this._canvas._emitStateChange('node-added');
  }

  undo() {
    const idx = this._canvas._state.nodes.findIndex(n => n.id === this._nodeData.id);
    if (idx !== -1) this._canvas._state.nodes.splice(idx, 1);
    this._canvas._removeNodeDOM(this._nodeData.id);
    this._canvas._transient.selectedNodeIds.delete(this._nodeData.id);
    this._canvas._updateEmptyState();
    this._canvas._emitStateChange('node-removed');
  }
}
```

### 10.6 Integration with InfraWizardDialog

The parent wizard dialog creates and manages the DagCanvas lifecycle:

```javascript
// In InfraWizardDialog, when navigating to Page 3:
_activatePage3() {
  const container = this._el.querySelector('.dag-canvas-wrapper');
  this._dagCanvas = new DagCanvas(container, {
    availableSchemas: this._wizardState.schemas,  // from Page 2
    dataTheme: this._wizardState.theme,            // from Page 2
    undoManager: this._undoManager,
    onStateChange: (event) => {
      this._wizardState.dagState = event.state;
      this._updateNextButtonState(event.isValid);
      this._updateNodeCount(event.nodeCount);
    }
  });
  this._dagCanvas.init();

  // If returning from Page 4 (back navigation), restore state
  if (this._wizardState.dagState) {
    this._dagCanvas.fromJSON(this._wizardState.dagState);
  }
}

_deactivatePage3() {
  // Save state before leaving
  this._wizardState.dagState = this._dagCanvas.toJSON();
  this._dagCanvas.destroy();
  this._dagCanvas = null;
}
```

### 10.7 Integration with ConnectionManager

DagCanvas delegates connection-drawing interaction to ConnectionManager but retains state ownership:

```javascript
// In init():
this._connectionManager = new ConnectionManager(this._connectionsLayer, {
  getNode: (id) => this.getNode(id),
  isValidConnection: (sourceId, targetId) => {
    // No self-loops
    if (sourceId === targetId) return false;
    // No duplicates
    if (this._state.connections.some(c =>
      c.sourceNodeId === sourceId && c.targetNodeId === targetId)) return false;
    // No cycles
    if (this.wouldCreateCycle(sourceId, targetId)) return false;
    return true;
  },
  onConnectionCreated: (sourceId, targetId) => {
    this.addConnection(sourceId, targetId);
  },
  onConnectionCancelled: () => {
    this._transient.interactionMode = 'idle';
  }
});
```

### 10.8 CSS Requirements

All CSS for DagCanvas must follow EDOG design system rules: OKLCH colors, 4px spacing grid, CSS custom properties. The styles are inlined in the single HTML output via `build-html.py`.

Key CSS custom properties consumed:

```css
/* From the mock and design system */
--surface: #ffffff;
--surface-2: #f8f9fb;
--surface-3: #ebedf0;
--border: rgba(0,0,0,0.06);
--border-bright: rgba(0,0,0,0.12);
--text: #1a1d23;
--text-dim: #5a6070;
--text-muted: #8e95a5;
--accent: #6d5cff;
--accent-dim: rgba(109,92,255,0.07);
--accent-glow: rgba(109,92,255,0.15);
--status-ok: #18a058;
--status-fail: #e5453b;
--status-warn: #e5940c;
--bronze: #b87333;
--silver: #7b8794;
--gold: #c5a038;
--r-sm: 4px;
--r-md: 6px;
--r-lg: 10px;
--shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
--shadow-md: 0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
--shadow-lg: 0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
--font: 'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif;
--mono: 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace;
--ease: cubic-bezier(0.4, 0, 0.2, 1);
--spring: cubic-bezier(0.34, 1.56, 0.64, 1);
--t-fast: 80ms;
--t-normal: 150ms;
```

### 10.9 Dependencies

| Dependency | Purpose | Size | Load Strategy |
|-----------|---------|------|---------------|
| `@dagrejs/dagre` | Auto-layout algorithm | ~50 KB gzip | Bundled inline (loaded with wizard) |
| No other external deps | — | — | — |

### 10.10 Test Strategy

| Test Category | Count (est.) | Framework | What to Test |
|--------------|-------------|-----------|-------------|
| Unit: Coordinate math | 8 | pytest/JS test | `screenToCanvas()`, `canvasToScreen()` at various zoom/pan |
| Unit: Zoom math | 6 | JS test | Zoom-at-cursor formula correctness, clamping, snap-to-100% |
| Unit: Cycle detection | 10 | JS test | `wouldCreateCycle()` — diamond, chain, self-loop, disconnected |
| Unit: Validation | 8 | JS test | All validation rules (V1–V5) |
| Unit: Serialization | 4 | JS test | `toJSON()` → `fromJSON()` round-trip |
| Unit: Node name generation | 4 | JS test | Auto-naming, collision avoidance |
| Integration: Add/remove node | 6 | JS test | Via undo manager, DOM presence verified |
| Integration: Connection | 6 | JS test | Add/remove with cycle prevention |
| Integration: Undo/redo | 8 | JS test | All command types, batch commands |
| Integration: Auto-layout | 4 | JS test | Dagre produces valid positions, animation fires |
| E2E: Drag-and-drop | 4 | Playwright | Palette → canvas drop, position correct |
| E2E: Pan/zoom | 4 | Playwright | Scroll zoom, middle-mouse pan |
| E2E: Full DAG build | 2 | Playwright | 6-node e-commerce DAG from scratch |
| **Total** | ~74 | | |

### 10.11 Edge Cases & Gotchas

| # | Edge Case | Handling |
|---|-----------|---------|
| 1 | Drop outside canvas bounds | Clamp to visible canvas area |
| 2 | Zoom while dragging node | Prevent zoom during drag (ignore wheel events) |
| 3 | Pan while connecting | Allow pan during connection drag (move viewport, keep connection preview) |
| 4 | Browser resize during interaction | `ResizeObserver` on container, recalculate `svgRect` cache |
| 5 | Rapid successive undo/redo | Debounce DOM updates, batch if < 50ms apart |
| 6 | `fromJSON()` with invalid data | Validate schema before applying, reject with error toast |
| 7 | Two nodes at exact same position | Offset by one grid unit (20px) on creation, or let user overlap |
| 8 | Connection to node being deleted | Remove all connections before removing node (batch command) |
| 9 | Schema change from Page 2 (back nav) | Update `availableSchemas`, validate existing nodes, revert any that use a removed schema to `dbo` |
| 10 | Touch devices | Translate touch events to pointer events (browser handles via `pointerdown/move/up`). Long-press = right-click for context menu |
| 11 | Right-to-left (RTL) languages | Canvas layout is spatial, not text-directional. Node names may be RTL — handle via `dir="auto"` on `foreignObject` content |
| 12 | Copy-paste nodes (future) | Not in V1 scope. Reserve Ctrl+C/V keybindings, show "Coming soon" toast |
| 13 | Window blur during drag | Cancel active drag on `window.blur`, revert to pre-drag state |
| 14 | High-DPI displays | SVG is resolution-independent. `getBoundingClientRect()` returns CSS pixels, which is correct for our coordinate math |

### 10.12 Implementation Order (within DagCanvas)

```
Step 1: SVG structure + grid background + zoom controls UI
Step 2: Viewport transforms — zoom (scroll) + pan (middle-mouse/space+drag)
Step 3: Coordinate math (screenToCanvas, canvasToScreen)
Step 4: Node rendering (SVG <g> with foreignObject) + addNode()
Step 5: Node selection (click, shift+click, deselect-on-empty-click)
Step 6: Node drag (move with snap-to-grid)
Step 7: Selection rectangle (marquee multi-select)
Step 8: Context menu (right-click add node)
Step 9: Drop handler (receive from NodePalette drag)
Step 10: Connection rendering (SVG <path> Bézier) + addConnection()
Step 11: Undo/redo command integration
Step 12: Serialization (toJSON / fromJSON)
Step 13: Auto-layout integration (Dagre)
Step 14: Fit-to-view + viewport animation
Step 15: Keyboard shortcuts + accessibility
Step 16: Validation + error handling
Step 17: Empty state + polish
```

### 10.13 Open Questions

| # | Question | Options | Decision Needed By |
|---|----------|---------|-------------------|
| Q1 | Should we use JointJS Core or hand-roll SVG? | Research recommends JointJS as primary, hand-roll as backup. Spec assumes hand-roll for maximum control. Re-evaluate after Step 5 (node rendering). | P2 (Architecture) |
| Q2 | Should nodes snap to grid during drag or only on release? | During: more precise but feels "sticky". On release: smoother but less controlled. Mock shows grid dots at 20px. | P2 (Architecture) |
| Q3 | Should `fitToView()` cap zoom at 100% or allow zoom > 100% for very small DAGs? | Cap at 100% (no magnification of nodes beyond natural size). | Resolved: cap at 100% |
| Q4 | Should undo/redo history persist across page navigation (Page 3 → Page 4 → back to Page 3)? | Option A: Preserve undo stack. Option B: Clear on page leave. Leaning toward A for better UX. | P2 (Architecture) |

---

*End of C04-DagCanvas Component Deep Spec.*
*Next: C05-NodePalette, C06-DagNode, C07-ConnectionManager specs.*
