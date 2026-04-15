# C13 — AutoLayoutEngine: Component Deep Spec

> **Component:** AutoLayoutEngine
> **Feature:** F16 New Infra Wizard — DAG Canvas (Page 3)
> **Complexity:** HIGH
> **Owner:** Pixel (Frontend Agent)
> **Depends On:** P0.4 (Canvas Interaction Research), P0.6 (DAG Builder Research)
> **Consumers:** C4 (DagCanvas), C8 (CodePreviewPanel), C14 (UndoRedoManager)
> **Status:** P1 — Component Deep Spec

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Spec](#6-visual-spec)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

AutoLayoutEngine is the algorithmic core responsible for calculating optimal node positions within the DAG canvas. It takes a graph (nodes with dimensions + directed edges) and produces a set of (x, y) coordinates that arrange nodes in a clean, readable top-to-bottom layered layout using the Dagre library (Sugiyama/dot algorithm). It also provides topological sorting — a dependency-ordered list of node IDs used by both the layout animation choreography and the CodePreviewPanel for generating correctly-ordered notebook cells.

AutoLayoutEngine is a **stateless computation module** — it does not own any DOM, does not persist positions, and does not manage canvas state. It receives inputs, runs algorithms, and returns results. The DagCanvas is responsible for reading and applying results to the actual node elements.

### 1.2 Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **Dagre layout calculation** | Create a dagre.graphlib.Graph, configure it, feed in nodes + edges, run `dagre.layout()`, and return computed positions |
| **Topological sort** | Produce a dependency-ordered list of node IDs (roots → leaves) using Kahn's algorithm |
| **Layout configuration** | Manage rankdir, nodesep, ranksep, marginx, marginy parameters with sensible defaults |
| **Node dimension measurement** | Provide a helper to measure actual DOM node dimensions before layout |
| **Animated repositioning choreography** | Calculate animation delays and sequencing for staggered topological-order animation |
| **Viewport fit calculation** | Compute the bounding box of laid-out nodes and return zoom/pan values to fit all nodes in view |
| **Cycle detection** | Validate that the graph is acyclic before layout (Dagre requires a DAG) |
| **Disconnected subgraph handling** | Correctly layout graphs with multiple root nodes and disconnected components |

### 1.3 What AutoLayoutEngine Does NOT Own

| Not Owned | Owner |
|-----------|-------|
| DOM node elements | DagCanvas (C4) / DagNode (C6) |
| SVG edge paths | ConnectionManager (C7) |
| Canvas zoom/pan state | DagCanvas (C4) |
| Undo/redo stack | UndoRedoManager (C14) |
| Node data model (names, types, schemas) | DagCanvas (C4) |
| Triggering layout (button click, template load) | DagCanvas (C4) toolbar |
| Applying CSS transitions / animations to DOM | DagCanvas (C4) |

### 1.4 Design Principles

1. **Pure computation** — No side effects. Input → Output. Testable without DOM.
2. **Single responsibility** — Layout math only. No UI concerns leak in.
3. **Deterministic** — Same input always produces the same output positions.
4. **Framework-agnostic** — Works with any rendering layer (JointJS, raw SVG, HTML divs).
5. **Fail-safe** — Invalid inputs (cycles, empty graphs) produce graceful results, never throw uncaught.

---

## 2. Data Model

### 2.1 Input Types

```typescript
/**
 * Minimal node description for layout computation.
 * Positions (x, y) are optional — only needed if computing deltas for animation.
 */
interface LayoutNode {
  id: string;           // Unique node identifier (e.g., 'node_01', 'customers')
  width: number;        // Measured DOM width in pixels (including padding/border)
  height: number;       // Measured DOM height in pixels
  x?: number;           // Current x position (top-left corner) — for animation delta
  y?: number;           // Current y position (top-left corner) — for animation delta
}

/**
 * Directed edge between two nodes.
 * Source flows into target (source is parent/upstream, target is child/downstream).
 */
interface LayoutEdge {
  source: string;       // Source node ID (parent)
  target: string;       // Target node ID (child)
  weight?: number;      // Edge weight for layout priority (default: 1)
}

/**
 * Configuration for the Dagre layout algorithm.
 * All values have sensible defaults — callers can override any subset.
 */
interface LayoutConfig {
  rankdir: 'TB' | 'BT' | 'LR' | 'RL';   // Layout direction (default: 'TB')
  nodesep: number;      // Horizontal pixel spacing between nodes in same rank (default: 60)
  ranksep: number;      // Vertical pixel spacing between ranks (default: 80)
  marginx: number;      // Horizontal margin around the entire graph (default: 40)
  marginy: number;      // Vertical margin around the entire graph (default: 40)
  align?: 'UL' | 'UR' | 'DL' | 'DR' | undefined;  // Node alignment within rank (default: undefined = center)
  acyclicer?: 'greedy';  // Dagre cycle removal strategy (default: 'greedy')
  ranker?: 'network-simplex' | 'tight-tree' | 'longest-path';  // Rank assignment algorithm (default: 'network-simplex')
}
```

### 2.2 Output Types

```typescript
/**
 * Computed position for a single node after layout.
 * Coordinates are top-left corner (Dagre returns center; we convert).
 */
interface LayoutResult {
  id: string;           // Node ID (matches input)
  x: number;            // Computed x position (top-left corner)
  y: number;            // Computed y position (top-left corner)
  width: number;        // Original width (passed through)
  height: number;       // Original height (passed through)
  rank: number;         // Assigned rank/layer (0 = root level)
  order: number;        // Position within rank (left-to-right index)
}

/**
 * Complete output from a layout computation.
 */
interface LayoutOutput {
  nodes: LayoutResult[];              // Positioned nodes
  boundingBox: BoundingBox;           // Enclosing rectangle of all nodes
  topologicalOrder: string[];         // Node IDs in dependency order (roots first)
  ranks: Map<number, string[]>;       // Rank → node IDs at that rank
  graphWidth: number;                 // Total graph width (including margins)
  graphHeight: number;                // Total graph height (including margins)
  computationTimeMs: number;          // Layout computation time for diagnostics
}

/**
 * Bounding box enclosing all laid-out nodes.
 */
interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;         // maxX = rightmost node's x + width
  maxY: number;         // maxY = bottommost node's y + height
  width: number;        // maxX - minX
  height: number;       // maxY - minY
  centerX: number;      // minX + width / 2
  centerY: number;      // minY + height / 2
}

/**
 * Animation choreography for a single node.
 */
interface AnimationEntry {
  id: string;           // Node ID
  fromX: number;        // Starting x position
  fromY: number;        // Starting y position
  toX: number;          // Target x position (from layout)
  toY: number;          // Target y position (from layout)
  delay: number;        // Animation start delay in ms (staggered by topological order)
  duration: number;     // Animation duration in ms
  rank: number;         // Node's rank (for stagger calculation)
}

/**
 * Complete animation plan for all nodes.
 */
interface AnimationPlan {
  entries: AnimationEntry[];   // Per-node animation instructions
  totalDuration: number;       // Total animation time (last delay + last duration)
  staggerInterval: number;     // Delay between ranks (ms)
}

/**
 * Viewport fit parameters — zoom and pan to show all nodes.
 */
interface ViewportFit {
  scale: number;        // Zoom level to fit all nodes
  translateX: number;   // Pan X offset
  translateY: number;   // Pan Y offset
  padding: number;      // Padding around the bounding box
}

/**
 * Topological sort result.
 */
interface TopologicalSortResult {
  order: string[];        // Node IDs in topological order (roots first, leaves last)
  ranks: Map<number, string[]>;  // Rank/level assignments (rank 0 = roots)
  isDAG: boolean;         // False if a cycle was detected
  cycleNodes?: string[];  // Node IDs involved in cycle (if !isDAG)
}
```

### 2.3 Default Configuration Constants

```javascript
const LAYOUT_DEFAULTS = {
  rankdir: 'TB',          // Top-to-bottom: sources at top, MLVs flow down
  nodesep: 60,            // 60px horizontal gap between siblings in same rank
  ranksep: 80,            // 80px vertical gap between ranks (layers)
  marginx: 40,            // 40px left/right canvas margin
  marginy: 40,            // 40px top/bottom canvas margin
  align: undefined,       // Center alignment within ranks (Dagre default)
  acyclicer: 'greedy',    // Greedy cycle removal (shouldn't be needed — we prevent cycles)
  ranker: 'network-simplex', // Best rank assignment algorithm for readability
};

const ANIMATION_DEFAULTS = {
  duration: 400,          // 400ms per-node animation duration
  staggerInterval: 60,    // 60ms delay between successive rank groups
  easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', // Spring overshoot curve
  maxTotalDuration: 2000, // Cap total animation at 2 seconds for large graphs
};

const VIEWPORT_FIT_DEFAULTS = {
  padding: 60,            // 60px padding around bounding box when fitting to view
  minScale: 0.25,         // Don't zoom out beyond 25%
  maxScale: 1.0,          // Don't zoom in beyond 100% when fitting (user can zoom further manually)
  animationDuration: 500, // 500ms smooth zoom/pan transition
};

const NODE_SIZE_DEFAULTS = {
  width: 200,             // Default node width if DOM measurement unavailable
  height: 80,             // Default node height if DOM measurement unavailable
  minWidth: 120,          // Minimum node width for layout
  minHeight: 48,          // Minimum node height for layout
};
```

### 2.4 Internal Dagre Graph Representation

The Dagre library uses its own `graphlib.Graph` structure internally. AutoLayoutEngine creates this as a transient object — constructed, used for one computation, then discarded. It is never cached or reused across layout calls.

```
dagre.graphlib.Graph (transient)
├── Graph options: { directed: true, multigraph: false, compound: false }
├── Graph label: { rankdir, nodesep, ranksep, marginx, marginy, ... }
├── Nodes: Map<nodeId → { width, height }>
├── Edges: Map<(source, target) → { weight: 1 }>
└── After dagre.layout():
    ├── Node positions: { x: centerX, y: centerY, width, height }
    └── Edge points: { points: [{x,y}, ...] } (we don't use these — ConnectionManager handles edge routing)
```

---

## 3. API Surface

### 3.1 Class Definition

```javascript
/**
 * AutoLayoutEngine — stateless DAG layout computation module.
 *
 * Usage:
 *   const engine = new AutoLayoutEngine();
 *   const layout = engine.computeLayout(nodes, edges);
 *   const animPlan = engine.computeAnimationPlan(nodes, layout);
 *   const fit = engine.computeViewportFit(layout.boundingBox, viewportWidth, viewportHeight);
 *   const sorted = engine.topologicalSort(nodes, edges);
 */
class AutoLayoutEngine {

  /** @type {LayoutConfig} */
  #config;

  /**
   * @param {Partial<LayoutConfig>} [config] — Override default layout parameters
   */
  constructor(config = {}) { /* ... */ }

  // ── Core Layout ──────────────────────────────────────────

  /**
   * Compute optimal positions for all nodes using Dagre (Sugiyama algorithm).
   *
   * @param {LayoutNode[]} nodes — Nodes with measured dimensions
   * @param {LayoutEdge[]} edges — Directed edges (source → target)
   * @param {Partial<LayoutConfig>} [configOverride] — Per-call config override
   * @returns {LayoutOutput} — Positioned nodes, bounding box, topological order
   * @throws {CycleDetectedError} — If graph contains cycles (should never happen if UI prevents them)
   */
  computeLayout(nodes, edges, configOverride = {}) { /* ... */ }

  // ── Topological Sort ──────────────────────────────────────

  /**
   * Topological sort using Kahn's algorithm.
   * Returns nodes in dependency order: roots (no parents) first, leaves last.
   * Handles multiple roots and disconnected subgraphs.
   *
   * @param {LayoutNode[] | string[]} nodes — Node objects or just node IDs
   * @param {LayoutEdge[]} edges — Directed edges
   * @returns {TopologicalSortResult} — Ordered IDs, rank assignments, DAG validity
   */
  topologicalSort(nodes, edges) { /* ... */ }

  // ── Animation Choreography ────────────────────────────────

  /**
   * Compute staggered animation plan for moving nodes from current to target positions.
   * Nodes animate in topological order: roots first, then rank 1, rank 2, etc.
   *
   * @param {LayoutNode[]} currentPositions — Nodes with current (x, y) on canvas
   * @param {LayoutOutput} layoutOutput — Computed layout with target positions
   * @param {object} [options] — Animation timing overrides
   * @param {number} [options.duration=400] — Per-node animation duration in ms
   * @param {number} [options.staggerInterval=60] — Delay between rank groups in ms
   * @param {string} [options.easing] — CSS easing function
   * @returns {AnimationPlan} — Per-node animation instructions with delays
   */
  computeAnimationPlan(currentPositions, layoutOutput, options = {}) { /* ... */ }

  // ── Viewport Fit ──────────────────────────────────────────

  /**
   * Compute zoom/pan values to fit all nodes within the visible viewport.
   *
   * @param {BoundingBox} boundingBox — Bounding box of all laid-out nodes
   * @param {number} viewportWidth — Canvas viewport width in pixels
   * @param {number} viewportHeight — Canvas viewport height in pixels
   * @param {object} [options] — Fit parameters
   * @param {number} [options.padding=60] — Padding around bounding box
   * @param {number} [options.minScale=0.25] — Minimum zoom level
   * @param {number} [options.maxScale=1.0] — Maximum zoom level for auto-fit
   * @returns {ViewportFit} — Scale, translateX, translateY
   */
  computeViewportFit(boundingBox, viewportWidth, viewportHeight, options = {}) { /* ... */ }

  // ── Node Measurement ──────────────────────────────────────

  /**
   * Measure actual DOM dimensions of all node elements.
   * Uses getBoundingClientRect() on each node's DOM element.
   *
   * @param {Map<string, HTMLElement>} nodeElements — Map of nodeId → DOM element
   * @returns {LayoutNode[]} — Nodes with measured width/height
   */
  measureNodeDimensions(nodeElements) { /* ... */ }

  // ── Cycle Detection ───────────────────────────────────────

  /**
   * Check if adding an edge would create a cycle.
   * Uses DFS from target to see if source is reachable.
   *
   * @param {LayoutEdge[]} existingEdges — Current edges in the graph
   * @param {string} source — Proposed edge source
   * @param {string} target — Proposed edge target
   * @returns {boolean} — True if the proposed edge would create a cycle
   */
  wouldCreateCycle(existingEdges, source, target) { /* ... */ }

  // ── Configuration ─────────────────────────────────────────

  /**
   * Update layout configuration. Changes apply to subsequent computeLayout() calls.
   *
   * @param {Partial<LayoutConfig>} config — Configuration overrides
   */
  updateConfig(config) { /* ... */ }

  /**
   * Get current layout configuration (merged defaults + overrides).
   *
   * @returns {LayoutConfig}
   */
  getConfig() { /* ... */ }

  // ── Utilities ─────────────────────────────────────────────

  /**
   * Get the rank (layer depth) of each node based on longest path from a root.
   * Useful for understanding graph depth without running full layout.
   *
   * @param {string[]} nodeIds
   * @param {LayoutEdge[]} edges
   * @returns {Map<string, number>} — nodeId → rank (0 = root)
   */
  computeRanks(nodeIds, edges) { /* ... */ }

  /**
   * Find all root nodes (nodes with no incoming edges).
   *
   * @param {string[]} nodeIds
   * @param {LayoutEdge[]} edges
   * @returns {string[]} — IDs of root nodes
   */
  findRoots(nodeIds, edges) { /* ... */ }

  /**
   * Find all leaf nodes (nodes with no outgoing edges).
   *
   * @param {string[]} nodeIds
   * @param {LayoutEdge[]} edges
   * @returns {string[]} — IDs of leaf nodes
   */
  findLeaves(nodeIds, edges) { /* ... */ }

  /**
   * Identify disconnected subgraphs (connected components).
   *
   * @param {string[]} nodeIds
   * @param {LayoutEdge[]} edges
   * @returns {string[][]} — Array of connected components (each is an array of node IDs)
   */
  findConnectedComponents(nodeIds, edges) { /* ... */ }
}
```

### 3.2 Events Emitted

AutoLayoutEngine itself does not emit events (it's a pure computation module). However, the DagCanvas integration layer emits these events when using AutoLayoutEngine:

| Event | Payload | When |
|-------|---------|------|
| `layout:started` | `{ nodeCount, edgeCount, config }` | Layout computation begins |
| `layout:completed` | `{ output: LayoutOutput, durationMs }` | Layout computation finished |
| `layout:animationStarted` | `{ plan: AnimationPlan }` | Node repositioning animation begins |
| `layout:animationCompleted` | `{ totalDurationMs }` | All nodes finished animating |
| `layout:viewportFitted` | `{ fit: ViewportFit }` | Viewport zoom/pan adjusted to fit |
| `layout:error` | `{ error, type: 'cycle' | 'invalid_input' | 'dagre_error' }` | Layout computation failed |

### 3.3 Integration Points

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DagCanvas (C4)                               │
│                                                                     │
│  "Auto Arrange" button click                                        │
│  ──────────┬────────────────────────────────────────────────────     │
│            │                                                        │
│            ▼                                                        │
│  ┌──────────────────┐     ┌──────────────────────────────────┐     │
│  │ measureNodeDims() │────▸│ AutoLayoutEngine.computeLayout() │     │
│  │ (reads DOM)       │     │ (pure computation, no DOM)       │     │
│  └──────────────────┘     └──────────────┬───────────────────┘     │
│                                           │                         │
│            ┌──────────────────────────────┘                         │
│            │                                                        │
│            ▼                                                        │
│  ┌────────────────────────┐     ┌─────────────────────────────┐    │
│  │ computeAnimationPlan() │     │ UndoRedoManager.push(       │    │
│  │ (stagger by topo order)│     │   AutoLayoutCommand {       │    │
│  └───────────┬────────────┘     │     oldPositions,           │    │
│              │                  │     newPositions             │    │
│              ▼                  │   }                          │    │
│  ┌────────────────────────┐     │ )                            │    │
│  │ Apply CSS transitions  │     └─────────────────────────────┘    │
│  │ per AnimationPlan      │                                        │
│  └───────────┬────────────┘                                        │
│              │                                                      │
│              ▼                                                      │
│  ┌────────────────────────┐                                        │
│  │ computeViewportFit()   │                                        │
│  │ Zoom/pan to show all   │                                        │
│  └────────────────────────┘                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    CodePreviewPanel (C8)                             │
│                                                                     │
│  "Refresh" button click                                             │
│  ──────────┬────────────────────────────────────────────────────     │
│            │                                                        │
│            ▼                                                        │
│  ┌───────────────────────────────────────────┐                     │
│  │ AutoLayoutEngine.topologicalSort(nodes,   │                     │
│  │   edges)                                  │                     │
│  │ → ordered list of node IDs                │                     │
│  │ → generate notebook cells in this order   │                     │
│  └───────────────────────────────────────────┘                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    ConnectionManager (C7)                            │
│                                                                     │
│  Before accepting new edge:                                         │
│  ──────────┬────────────────────────────────────────────────────     │
│            │                                                        │
│            ▼                                                        │
│  ┌───────────────────────────────────────────┐                     │
│  │ AutoLayoutEngine.wouldCreateCycle(        │                     │
│  │   existingEdges, sourceId, targetId       │                     │
│  │ )                                         │                     │
│  │ → boolean (reject if true)                │                     │
│  └───────────────────────────────────────────┘                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.4 AutoLayoutCommand (UndoRedoManager Integration)

```javascript
/**
 * Command object for the undo/redo stack.
 * Stores all node positions before and after auto-layout so the entire
 * operation can be undone/redone as a single atomic action.
 */
class AutoLayoutCommand {

  /** @type {string} */
  type = 'AUTO_LAYOUT';

  /** @type {Map<string, {x: number, y: number}>} */
  #oldPositions;

  /** @type {Map<string, {x: number, y: number}>} */
  #newPositions;

  /**
   * @param {Map<string, {x: number, y: number}>} oldPositions
   * @param {Map<string, {x: number, y: number}>} newPositions
   */
  constructor(oldPositions, newPositions) {
    this.#oldPositions = new Map(oldPositions);
    this.#newPositions = new Map(newPositions);
  }

  /**
   * Execute: move all nodes to layout-computed positions.
   * @param {DagCanvas} canvas
   */
  execute(canvas) {
    for (const [nodeId, pos] of this.#newPositions) {
      canvas.setNodePosition(nodeId, pos.x, pos.y);
    }
  }

  /**
   * Undo: restore all nodes to their pre-layout positions.
   * @param {DagCanvas} canvas
   */
  undo(canvas) {
    for (const [nodeId, pos] of this.#oldPositions) {
      canvas.setNodePosition(nodeId, pos.x, pos.y);
    }
  }

  /**
   * Description for undo/redo UI tooltip.
   * @returns {string}
   */
  describe() {
    return `Auto-arrange ${this.#newPositions.size} nodes`;
  }
}
```

---

## 4. State Machine

AutoLayoutEngine is a stateless computation module, so it does not have a traditional persistent state machine. Instead, the **layout operation lifecycle** follows a well-defined sequence of states that the DagCanvas orchestrates:

### 4.1 Layout Operation Lifecycle

```
                          ┌───────────────────┐
                          │       IDLE         │
                          │                    │
                          │  Canvas is static. │
                          │  User can interact │
                          │  freely.           │
                          └────────┬───────────┘
                                   │
                          User clicks "Auto Arrange"
                          OR template loads
                                   │
                                   ▼
                          ┌───────────────────┐
                          │    MEASURING       │
                          │                    │
                          │  Read DOM dims     │
                          │  for all nodes.    │
                          │  (~1ms)            │
                          └────────┬───────────┘
                                   │
                                   ▼
                          ┌───────────────────┐
                          │   COMPUTING        │
                          │                    │
                          │  Dagre layout      │
                          │  algorithm runs.   │
                          │  (~5-50ms)         │
                          └────────┬───────────┘
                                   │
                       ┌───────────┴───────────┐
                       │                       │
                  Success                   Failure
                       │                       │
                       ▼                       ▼
              ┌─────────────────┐    ┌──────────────────┐
              │  ANIMATING       │    │  ERROR            │
              │                  │    │                   │
              │  Nodes animate   │    │  Show error toast │
              │  to new positions│    │  Log diagnostics  │
              │  in topo order.  │    │  Return to IDLE   │
              │  (~400-2000ms)   │    │                   │
              └────────┬─────────┘    └──────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  FITTING         │
              │                  │
              │  Zoom/pan to fit │
              │  all nodes in    │
              │  viewport.       │
              │  (~500ms)        │
              └────────┬─────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  COMPLETE        │
              │                  │
              │  Push command to │
              │  undo stack.     │
              │  Return to IDLE. │
              └──────────────────┘
```

### 4.2 State Details

| State | Duration | User Interaction | Canvas Blocked? | Description |
|-------|----------|-----------------|-----------------|-------------|
| **IDLE** | Indefinite | Full interaction | No | Normal canvas state. User can drag nodes, create edges, etc. |
| **MEASURING** | <1ms | Frozen | Yes (briefly) | Engine reads `getBoundingClientRect()` for each node DOM element. Synchronous. |
| **COMPUTING** | 5–50ms | Frozen | Yes (briefly) | Dagre algorithm runs synchronously. At 100 nodes this takes <50ms — well under a single frame budget. |
| **ANIMATING** | 400–2000ms | Partially blocked | Drag disabled | Nodes animate from current positions to computed positions. User can still zoom/pan but cannot drag nodes or create edges during animation. |
| **FITTING** | ~500ms | Partially blocked | Pan/zoom animating | Canvas smoothly zooms/pans to fit all nodes in view with padding. |
| **COMPLETE** | Instant | Full interaction | No | AutoLayoutCommand is pushed to UndoRedoManager stack. State returns to IDLE. |
| **ERROR** | Instant | Full interaction | No | Error is logged and displayed in toast notification. Canvas remains unchanged. State returns to IDLE. |

### 4.3 State Transitions

| From | Event | To | Guard / Side Effect |
|------|-------|----|---------------------|
| IDLE | `autoArrangeRequested` | MEASURING | Graph must have ≥2 nodes; disabled if already animating |
| IDLE | `templateLoaded` | MEASURING | Template contains node/edge data |
| MEASURING | `measurementComplete` | COMPUTING | All node dimensions collected |
| MEASURING | `measurementFailed` | ERROR | DOM element not found for a node |
| COMPUTING | `layoutComplete` | ANIMATING | Valid layout output produced |
| COMPUTING | `cycleDetected` | ERROR | Graph has cycles (should never happen) |
| COMPUTING | `dagreError` | ERROR | Dagre threw an exception |
| ANIMATING | `animationComplete` | FITTING | All node transitions finished |
| ANIMATING | `animationCancelled` | IDLE | User pressed Escape — snap to final positions immediately |
| FITTING | `fitComplete` | COMPLETE | Viewport adjusted |
| COMPLETE | (immediate) | IDLE | Push to undo stack, emit `layout:completed` |
| ERROR | (immediate) | IDLE | Display error, emit `layout:error` |

### 4.4 Concurrency Guards

```javascript
// The DagCanvas wraps layout calls with a simple lock:
#layoutInProgress = false;

async autoArrange() {
  if (this.#layoutInProgress) return;   // Reject overlapping layout requests
  this.#layoutInProgress = true;
  try {
    await this.#runLayoutPipeline();
  } finally {
    this.#layoutInProgress = false;
  }
}
```

---

## 5. Scenarios

### 5.1 Scenario: Manual "Auto Arrange" — Happy Path

**Precondition:** Canvas has 8 nodes with edges, manually placed in a messy arrangement.

```
Step 1: User clicks "Auto Arrange" button in canvas toolbar.
        → DagCanvas enters MEASURING state.
        → All node DOM elements measured via getBoundingClientRect().

Step 2: DagCanvas calls engine.computeLayout(measuredNodes, edges).
        → Dagre creates internal graph, assigns ranks (layers), minimizes edge crossings,
          positions nodes within ranks.
        → Returns LayoutOutput with 8 positioned nodes, bounding box, topo order.
        → Computation takes ~8ms.

Step 3: DagCanvas snapshots current positions (for undo) into Map<nodeId, {x, y}>.

Step 4: DagCanvas calls engine.computeAnimationPlan(currentPositions, layoutOutput).
        → Engine produces AnimationPlan:
          - Rank 0 (2 root nodes): delay=0ms, duration=400ms
          - Rank 1 (3 nodes):      delay=60ms, duration=400ms
          - Rank 2 (2 nodes):      delay=120ms, duration=400ms
          - Rank 3 (1 leaf node):  delay=180ms, duration=400ms
        → totalDuration = 180 + 400 = 580ms

Step 5: DagCanvas applies CSS transitions per AnimationPlan:
        → Each node gets:
          transition: transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1);
          transition-delay: {computed delay}ms;
          transform: translate({toX}px, {toY}px);
        → Nodes animate in waterfall from top (roots) to bottom (leaves).
        → Spring easing gives slight overshoot then settle — feels organic.

Step 6: After animation completes (580ms), DagCanvas calls
        engine.computeViewportFit(boundingBox, viewportW, viewportH).
        → Returns scale=0.85, translateX=120, translateY=40.

Step 7: DagCanvas smoothly animates zoom/pan to fit values (500ms transition).

Step 8: DagCanvas creates AutoLayoutCommand(oldPositions, newPositions) and
        pushes to UndoRedoManager.

Step 9: Layout complete. User sees clean, layered DAG. Ctrl+Z would restore
        the messy arrangement.
```

### 5.2 Scenario: Template Load with Auto-Layout

**Precondition:** User selects a template with 12 nodes from the template picker.

```
Step 1: TemplateManager loads template data: 12 nodes + 15 edges.
        All nodes initially have position (0, 0) — no prior layout.

Step 2: DagCanvas creates DOM elements for all 12 nodes at (0, 0),
        then immediately triggers auto-layout.

Step 3: engine.computeLayout() runs on all 12 nodes.
        → Produces layered arrangement: 3 source tables at top, 5 SQL MLVs
          in middle, 4 PySpark MLVs at bottom.

Step 4: Since all nodes start at (0, 0), the animation shows nodes
        "exploding" outward from the center to their final positions.
        → Stagger still applies (roots first).

Step 5: Viewport fit adjusts zoom to show all 12 nodes.

Step 6: No undo command pushed for template-load layout
        (this is the initial state — nothing to undo to).
```

### 5.3 Scenario: Single Node on Canvas

**Precondition:** Canvas has exactly 1 node, no edges.

```
Step 1: User clicks "Auto Arrange".

Step 2: engine.computeLayout([singleNode], []).
        → Dagre places the single node at (marginx, marginy) = (40, 40).
        → Bounding box is just the node's dimensions.

Step 3: Node animates to (40, 40) if not already there.

Step 4: Viewport fit centers the single node in the viewport.

Step 5: Result is valid but minimal — single node centered on canvas.
```

### 5.4 Scenario: Disconnected Subgraphs

**Precondition:** Canvas has 10 nodes forming 3 disconnected subgraphs:
- Subgraph A: 4 nodes (linear chain)
- Subgraph B: 4 nodes (diamond pattern)
- Subgraph C: 2 nodes (single edge)

```
Step 1: User clicks "Auto Arrange".

Step 2: engine.computeLayout() runs.
        → Dagre handles disconnected components natively.
        → Each subgraph is laid out internally with correct layering.
        → Subgraphs are placed side-by-side horizontally (Dagre's default
          behavior for disconnected components in TB mode).

Step 3: Result:
        ┌──────────┐   ┌──────────────────┐   ┌──────────┐
        │ A1       │   │  B1              │   │ C1       │
        │  ↓       │   │ ↙ ↘             │   │  ↓       │
        │ A2       │   │B2   B3           │   │ C2       │
        │  ↓       │   │ ↘ ↙             │   └──────────┘
        │ A3       │   │  B4              │
        │  ↓       │   └──────────────────┘
        │ A4       │
        └──────────┘

Step 4: Animation staggers across all three subgraphs based on combined
        topological order. Roots of all subgraphs animate first (rank 0),
        then all rank 1 nodes, etc.

Step 5: Viewport fit encompasses all three subgraphs.
```

### 5.5 Scenario: Undo Auto-Layout

**Precondition:** User ran auto-layout on 6 nodes. Nodes are now in clean arrangement.

```
Step 1: User presses Ctrl+Z.

Step 2: UndoRedoManager pops AutoLayoutCommand from stack.

Step 3: AutoLayoutCommand.undo() is called:
        → Iterates oldPositions Map, sets each node to its pre-layout position.
        → Nodes snap back immediately (no animation for undo — instant feels more "undo-like").

Step 4: Canvas shows the original messy arrangement.
        → Ctrl+Y would redo the layout (move back to computed positions).
```

### 5.6 Scenario: Cycle Detection During Edge Creation

**Precondition:** Canvas has: A → B → C. User tries to connect C → A.

```
Step 1: User drags from C's output port toward A's input port.

Step 2: ConnectionManager calls engine.wouldCreateCycle(edges, 'C', 'A').

Step 3: Engine runs DFS from 'A' (target) following existing edges:
        A → B → C → (C is the source of proposed edge)
        → 'C' is reachable from 'A' → cycle would form.
        → Returns true.

Step 4: ConnectionManager rejects the connection:
        → A's input port turns red (invalid target indicator).
        → Connection preview line turns red/dashed.
        → User releases mouse — no edge created.
        → Toast: "Cannot connect: would create a circular dependency."
```

### 5.7 Scenario: Large Graph (100 Nodes)

**Precondition:** Canvas has exactly 100 nodes with ~150 edges forming a deep DAG (15 ranks).

```
Step 1: User clicks "Auto Arrange".

Step 2: MEASURING phase: reads 100 DOM rects.
        → ~2ms (getBoundingClientRect is fast, batched in one read cycle).

Step 3: COMPUTING phase: Dagre layout with 100 nodes, 150 edges.
        → ~30-50ms. Well under the 100ms budget. No UI jank.

Step 4: ANIMATING phase:
        → 15 ranks × 60ms stagger = 900ms delay for deepest rank.
        → Plus 400ms animation = 1300ms total animation.
        → Under the 2000ms cap. No adjustment needed.
        → Animation is smooth — CSS transitions are GPU-composited.

Step 5: FITTING phase:
        → Bounding box is large. Scale computes to ~0.45 to fit all nodes.
        → Viewport zooms out smoothly over 500ms.

Step 6: Total time from click to settled: ~2000ms.
        → Acceptable for a deliberate "rearrange everything" action.
```

### 5.8 Scenario: Empty Canvas

**Precondition:** Canvas has 0 nodes.

```
Step 1: User clicks "Auto Arrange".

Step 2: DagCanvas checks: nodes.length === 0.
        → Silently no-ops. No error, no toast, no state change.
        → "Auto Arrange" button should be visually disabled when canvas is empty.
```

### 5.9 Scenario: Cancel Animation (Escape Key)

**Precondition:** Auto-layout animation is in progress (30 of 50 nodes have animated).

```
Step 1: User presses Escape.

Step 2: DagCanvas cancels all running CSS transitions:
        → Remove transition property from all nodes.
        → Set each node's final computed position immediately (snap to targets).
        → All nodes are now at their layout-computed positions.

Step 3: Viewport fit still runs (abbreviated, 200ms instead of 500ms).

Step 4: AutoLayoutCommand is still pushed to undo stack
        (the layout computation was valid; we just skipped the animation).
```

### 5.10 Scenario: Repeated Auto-Layout (Idempotent)

**Precondition:** User already ran auto-layout. Nodes are in computed positions. No changes made.

```
Step 1: User clicks "Auto Arrange" again.

Step 2: Engine computes layout — produces identical positions (deterministic).

Step 3: AnimationPlan has zero-distance moves for all nodes.
        → DagCanvas detects: all deltas < 1px threshold.
        → Skip animation entirely.
        → No undo command pushed (nothing changed).

Step 4: Brief viewport fit check (already fitted) — no-op.
```

### 5.11 Scenario: Wide DAG (Many Nodes in Same Rank)

**Precondition:** 20 source tables (all roots, no edges between them), plus 1 MLV node connected to all 20.

```
Step 1: Auto-layout computation.

Step 2: Dagre places all 20 source tables in rank 0.
        → With nodesep=60 and nodeWidth=200:
        → Total width = 20 × 200 + 19 × 60 = 5,140px
        → Plus margins: 5,220px wide.

Step 3: MLV node placed in rank 1, centered below.
        → x = 5,220/2 - 100 = 2,510px (centered)

Step 4: Viewport fit zooms out significantly:
        → If viewport is 1200px wide: scale = 1200 / 5,340 ≈ 0.22
        → Clamped to minScale (0.25) if below threshold.

Step 5: User sees all nodes. Some may be small at this zoom level.
        → They can zoom into areas of interest manually.
```

### 5.12 Scenario: Auto-Layout After Node Addition

**Precondition:** User manually placed 5 nodes and ran auto-layout. Then adds a 6th node by dragging from palette.

```
Step 1: New node appears at drop position.
        → No auto-layout triggered (auto-layout is always opt-in).

Step 2: User manually connects the new node to existing nodes.

Step 3: User clicks "Auto Arrange" again.

Step 4: Engine computes layout for all 6 nodes + edges.
        → The 5 existing nodes may shift slightly to accommodate the new node.
        → New node is positioned in its correct rank.

Step 5: Animation shows all 6 nodes moving — existing nodes adjust, new node slides into place.

Step 6: Undo would restore ALL 6 nodes to pre-layout positions
        (including the new node at its original drop position).
```

---

## 6. Visual Spec

### 6.1 Auto Arrange Button

```
Canvas Toolbar (left side):
┌──────────┐
│ [+SQL]   │  ← Node creation buttons
│ [+MLV]   │
│ [+Spark] │
│──────────│
│ [≡ Auto  │  ← Auto Arrange button
│  Arrange]│     Icon: tree/hierarchy icon (▦ or similar)
│──────────│     Label: "Auto Arrange" (text visible, not icon-only)
│ [⊞ Fit]  │     State: disabled when canvas empty or animation in progress
│ [↩ Undo] │
│ [↪ Redo] │
└──────────┘
```

**Button States:**

| State | Visual | Interaction |
|-------|--------|-------------|
| **Default** | Standard toolbar button, muted icon | Click to trigger layout |
| **Hover** | Subtle highlight, tooltip: "Auto-arrange nodes (Dagre layout)" | — |
| **Disabled (empty canvas)** | Dimmed, `opacity: 0.4`, `cursor: not-allowed` | Click does nothing |
| **Disabled (animating)** | Dimmed with subtle pulse animation | Click does nothing |
| **Active (computing)** | Button shows tiny spinner replacing icon | — |

**Button CSS:**

```css
.auto-arrange-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid oklch(0.80 0.02 240);
  border-radius: 6px;
  background: oklch(0.97 0.005 240);
  color: oklch(0.35 0.02 240);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}

.auto-arrange-btn:hover:not(:disabled) {
  background: oklch(0.93 0.01 240);
  border-color: oklch(0.70 0.04 240);
}

.auto-arrange-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.auto-arrange-btn[data-computing] {
  pointer-events: none;
}

.auto-arrange-btn[data-computing] .btn-icon {
  animation: spin 600ms linear infinite;
}
```

### 6.2 Animation Choreography — Visual Timeline

```
Time →   0ms    60ms   120ms  180ms  ··· 400ms  460ms  520ms  580ms
         │      │      │      │           │      │      │      │
Rank 0:  ├──────────────────────────────────┤
         │ Root nodes animate (400ms)       │
         │                                  │
Rank 1:  │      ├──────────────────────────────────┤
         │      │ Rank 1 nodes animate (400ms)     │
         │      │                                  │
Rank 2:  │      │      ├──────────────────────────────────┤
         │      │      │ Rank 2 nodes (400ms)             │
         │      │      │                                  │
Rank 3:  │      │      │      ├──────────────────────────────────┤
         │      │      │      │ Leaf nodes (400ms)               │
         │      │      │      │                                  │
         │      │      │      │                             Viewport
         │      │      │      │                             fit begins
         │      │      │      │                             (500ms)
```

**Easing Curve:**

```
cubic-bezier(0.34, 1.56, 0.64, 1) — "Spring overshoot"

Position
  ▲
  │        ╭───── Overshoot peak (~12% beyond target)
  │       ╱  ╲
  │      ╱    ╲─── Settles at target
  │     ╱
  │    ╱
  │   ╱
  │──╱
  └──────────────────▸ Time
  0ms              400ms
```

This easing produces a natural, physical feel — nodes slightly overshoot their target position then spring back. The 12% overshoot is subtle enough to feel polished without being distracting.

### 6.3 Layout Direction Visual

```
Top-to-Bottom (TB) — Default:

     ┌──────────┐   ┌──────────┐   ┌──────────┐    ← Rank 0 (Sources)
     │ orders   │   │customers │   │ products │
     └────┬─────┘   └────┬─────┘   └────┬─────┘
          │              │              │
          ▼              ▼              ▼
     ┌──────────────────────────────────────────┐   ← Rank 1 (SQL MLVs)
     │           order_summary                  │
     └─────────────────────┬────────────────────┘
                           │
                           ▼
     ┌──────────────────────────────────────────┐   ← Rank 2 (PySpark MLVs)
     │          customer_analytics              │
     └──────────────────────────────────────────┘

     ▲ marginx=40px                              ▲ marginy=40px
     ├────────────── nodesep=60px ──────────────┤
     │                                           │
     ├────── ranksep=80px ─────┤                 │
```

### 6.4 Disconnected Subgraph Placement

```
When multiple disconnected components exist, Dagre lays them out
side-by-side with nodesep spacing:

  ┌───── Component A ─────┐  ◄─ nodesep ─►  ┌─── Component B ───┐
  │  ┌─────┐              │                  │  ┌─────┐          │
  │  │ A1  │              │                  │  │ B1  │          │
  │  └──┬──┘              │                  │  └──┬──┘          │
  │     ▼                 │                  │     ▼             │
  │  ┌─────┐  ┌─────┐    │                  │  ┌─────┐          │
  │  │ A2  │  │ A3  │    │                  │  │ B2  │          │
  │  └──┬──┘  └──┬──┘    │                  │  └─────┘          │
  │     └────┬───┘       │                  │                    │
  │          ▼            │                  └────────────────────┘
  │       ┌─────┐         │
  │       │ A4  │         │
  │       └─────┘         │
  └───────────────────────┘
```

### 6.5 Before/After Auto-Layout

```
BEFORE (messy manual placement):

    ┌─────┐
    │  C  │─────────┐
    └─────┘         │         ┌─────┐
                    │    ┌───▸│  E  │
         ┌─────┐   │    │    └─────┘
         │  A  │───┐│   │
         └─────┘   ││   │
                   ▼▼   │
    ┌─────┐     ┌─────┐─┘
    │  B  │────▸│  D  │
    └─────┘     └─────┘


AFTER auto-layout (TB, clean Sugiyama):

    ┌─────┐   ┌─────┐   ┌─────┐     ← Rank 0
    │  A  │   │  B  │   │  C  │
    └──┬──┘   └──┬──┘   └──┬──┘
       │         │         │
       └────┬────┘─────────┘
            ▼
         ┌─────┐                     ← Rank 1
         │  D  │
         └──┬──┘
            │
            ▼
         ┌─────┐                     ← Rank 2
         │  E  │
         └─────┘
```

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+Shift+L` | Trigger auto-layout | Canvas focused |
| `Escape` | Cancel in-progress animation (snap to final) | During layout animation |
| `Ctrl+Z` | Undo auto-layout (restores previous positions) | After layout completes |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo auto-layout | After undoing layout |

### 7.2 Screen Reader Announcements

Auto-layout produces screen reader announcements at each phase via an `aria-live="polite"` region:

| Phase | Announcement |
|-------|-------------|
| Layout started | "Auto-arranging {N} nodes." |
| Layout computed | "Layout computed. Nodes repositioning." |
| Animation complete | "Auto-arrange complete. {N} nodes repositioned into {R} layers." |
| Viewport fitted | "View adjusted to show all nodes." |
| Layout cancelled | "Auto-arrange cancelled." |
| Layout error | "Auto-arrange failed: {reason}." |
| Undo layout | "Auto-arrange undone. Nodes restored to previous positions." |
| Redo layout | "Auto-arrange redone." |

### 7.3 Focus Management

```
After auto-layout completes:
1. Focus returns to the "Auto Arrange" button (it was the trigger).
2. If the user triggered layout via keyboard (Ctrl+Shift+L),
   focus goes to the first node in topological order.
3. Tab order of nodes updates to match topological order
   (roots first, leaves last) — this is the natural reading order
   for a top-to-bottom DAG.
```

### 7.4 Reduced Motion

```javascript
// Respect prefers-reduced-motion media query
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (prefersReducedMotion) {
  // Skip animation entirely — snap nodes to final positions
  // Still compute layout, just don't animate the transition
  animationDuration = 0;
  staggerInterval = 0;
  viewportFitDuration = 0;
}
```

### 7.5 ARIA Attributes for Layout State

```html
<!-- Auto Arrange button -->
<button class="auto-arrange-btn"
        aria-label="Auto-arrange nodes"
        aria-disabled="false"
        aria-busy="false"
        title="Arrange nodes in layered hierarchy (Ctrl+Shift+L)">
  <svg class="btn-icon" aria-hidden="true"><!-- tree icon --></svg>
  Auto Arrange
</button>

<!-- During computation/animation, update: -->
<button class="auto-arrange-btn"
        aria-busy="true"
        aria-disabled="true">
  <!-- spinner icon -->
  Arranging...
</button>

<!-- Canvas region during animation -->
<div class="dag-canvas"
     role="application"
     aria-label="DAG canvas"
     aria-busy="true"
     aria-roledescription="Node layout in progress">
```

---

## 8. Error Handling

### 8.1 Error Taxonomy

| Error | Severity | Cause | Recovery |
|-------|----------|-------|----------|
| **Cycle detected** | HIGH | Graph contains a cycle (should be impossible if ConnectionManager validates) | Log error, show toast, abort layout. Do not modify node positions. |
| **Empty graph** | LOW | Canvas has 0 nodes | Silently no-op. Disable "Auto Arrange" button proactively. |
| **Single node** | LOW | Canvas has 1 node (no meaningful layout) | Layout to (marginx, marginy). Minimal animation. |
| **Node dimension missing** | MEDIUM | DOM element not found for a node ID | Use default dimensions (200×80). Log warning. Continue layout. |
| **Dagre internal error** | HIGH | Dagre library throws exception | Catch, log full error with graph state, show toast: "Layout calculation failed." |
| **Invalid edge reference** | MEDIUM | Edge references a node ID that doesn't exist | Filter out invalid edges before feeding to Dagre. Log warning. |
| **Animation frame dropped** | LOW | Browser tab backgrounded during animation | CSS transitions handle this gracefully — animation completes when tab returns. |
| **Viewport dimensions zero** | MEDIUM | Canvas not visible (hidden modal, collapsed panel) | Use fallback dimensions (800×600). Log warning. |

### 8.2 Error Handling Pseudocode

```javascript
computeLayout(nodes, edges, configOverride = {}) {
  // ── Validation Phase ───────────────────────────────────
  if (!nodes || nodes.length === 0) {
    return this.#emptyLayoutOutput();
  }

  // Filter out edges referencing non-existent nodes
  const nodeIdSet = new Set(nodes.map(n => n.id));
  const validEdges = edges.filter(e => {
    const valid = nodeIdSet.has(e.source) && nodeIdSet.has(e.target);
    if (!valid) {
      console.warn(`[AutoLayoutEngine] Skipping invalid edge: ${e.source} → ${e.target}`);
    }
    return valid;
  });

  // Filter out self-loops
  const noSelfLoops = validEdges.filter(e => {
    if (e.source === e.target) {
      console.warn(`[AutoLayoutEngine] Skipping self-loop: ${e.source} → ${e.source}`);
      return false;
    }
    return true;
  });

  // Deduplicate edges (same source+target)
  const edgeKey = (e) => `${e.source}→${e.target}`;
  const seen = new Set();
  const dedupedEdges = noSelfLoops.filter(e => {
    const key = edgeKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cycle detection (defensive — should never happen)
  const topoResult = this.topologicalSort(nodes, dedupedEdges);
  if (!topoResult.isDAG) {
    const err = new CycleDetectedError(topoResult.cycleNodes);
    console.error('[AutoLayoutEngine] Cycle detected:', topoResult.cycleNodes);
    throw err;
  }

  // ── Node Dimension Fallback ────────────────────────────
  const normalizedNodes = nodes.map(n => ({
    ...n,
    width: n.width > 0 ? n.width : NODE_SIZE_DEFAULTS.width,
    height: n.height > 0 ? n.height : NODE_SIZE_DEFAULTS.height,
  }));

  // ── Dagre Computation ──────────────────────────────────
  const startTime = performance.now();

  try {
    const result = this.#runDagre(normalizedNodes, dedupedEdges, configOverride);
    result.computationTimeMs = performance.now() - startTime;
    result.topologicalOrder = topoResult.order;
    result.ranks = topoResult.ranks;
    return result;
  } catch (err) {
    console.error('[AutoLayoutEngine] Dagre layout failed:', err);
    throw new LayoutComputationError(err.message, { nodes, edges });
  }
}
```

### 8.3 Custom Error Classes

```javascript
class CycleDetectedError extends Error {
  /** @param {string[]} cycleNodes */
  constructor(cycleNodes) {
    super(`Cycle detected involving nodes: ${cycleNodes.join(', ')}`);
    this.name = 'CycleDetectedError';
    this.cycleNodes = cycleNodes;
  }
}

class LayoutComputationError extends Error {
  /** @param {string} message @param {object} graphState */
  constructor(message, graphState) {
    super(`Layout computation failed: ${message}`);
    this.name = 'LayoutComputationError';
    this.graphState = graphState;
  }
}
```

### 8.4 Toast Messages

| Condition | Toast Text | Style |
|-----------|-----------|-------|
| Cycle detected | "Cannot arrange: circular dependency detected between {nodes}." | Error (red) |
| Dagre error | "Layout calculation failed. Try removing a node and retrying." | Error (red) |
| Layout success (silent) | *(no toast — success is visual)* | — |
| Animation cancelled | *(no toast — user initiated)* | — |

---

## 9. Performance

### 9.1 Performance Budget

| Operation | Budget | Measured Expectation | Notes |
|-----------|--------|---------------------|-------|
| DOM measurement (100 nodes) | <5ms | ~2ms | Batched `getBoundingClientRect()` calls |
| Cycle detection (Kahn's algorithm, 100 nodes) | <2ms | <1ms | O(V+E), trivial at this scale |
| Dagre layout (100 nodes, 150 edges) | <100ms | 30–50ms | Synchronous, single-threaded |
| Dagre layout (50 nodes, 80 edges) | <50ms | 10–25ms | Typical graph size |
| Dagre layout (10 nodes, 12 edges) | <10ms | 2–5ms | Small starter graph |
| Animation plan computation | <1ms | <0.5ms | Simple arithmetic |
| Viewport fit computation | <1ms | <0.1ms | Simple arithmetic |
| Total layout pipeline (excl. animation) | <110ms | ~55ms | MEASURING + COMPUTING |
| Animation rendering (CSS transitions) | 60fps | 60fps | GPU-composited, no JS per frame |
| Animation total time (100 nodes) | <2000ms | ~1300ms | Stagger + duration |
| Viewport fit animation | <500ms | 500ms | Single CSS transition on container |
| Memory (layout objects, 100 nodes) | <100KB | ~20KB | Transient — GC'd after layout |

### 9.2 Why Synchronous is Fine

Dagre's layout algorithm runs synchronously on the main thread. For our 100-node maximum, this is the correct choice:

```
At 100 nodes / 150 edges:
- Dagre computation: ~30-50ms
- 16ms frame budget: Dagre takes ~3 frames worst case
- User perception: imperceptible (sub-100ms is "instant" to humans)
- Trade-off: Async (Web Worker) adds ~5ms overhead for message passing
             + complexity of transferring graph data back and forth
             + not worth it for <50ms computation

At 500 nodes (hypothetical future):
- Dagre computation: ~200-500ms
- Would need Web Worker to avoid frame drops during interaction
- But F16 caps at 100 nodes — this is a non-concern
```

### 9.3 Memory Profile

```javascript
// Memory usage per layout call (transient):
//
// Input:    100 LayoutNode objects       ≈  4 KB
// Input:    150 LayoutEdge objects       ≈  3 KB
// Dagre:    graphlib.Graph instance      ≈  8 KB (internal adjacency lists)
// Output:   100 LayoutResult objects     ≈  5 KB
// Output:   BoundingBox + metadata       ≈  0.1 KB
// Animation: 100 AnimationEntry objects  ≈  4 KB
// Undo:     200 position entries (old+new)≈ 3 KB
// ─────────────────────────────────────────────
// Total:                                 ≈ 27 KB (all transient, GC-eligible)
//
// The dagre.graphlib.Graph is discarded after layout.
// The LayoutOutput is kept by DagCanvas until the next layout call.
// The AutoLayoutCommand is kept in the undo stack (capped at 50 entries).
```

### 9.4 Animation Performance

```css
/*
 * CSS transitions are GPU-composited when using transform property.
 * We translate nodes via transform (not top/left) for 60fps animation.
 *
 * The browser's compositor handles interpolation — no JavaScript runs
 * per frame during the animation. This means:
 * - 100 nodes animating simultaneously = still 60fps
 * - Background tab = animation pauses, resumes when tab returns
 * - Low-end hardware = browser may drop to 30fps but handles gracefully
 */
.dag-node {
  will-change: transform;   /* Promote to compositor layer */
  transition: transform var(--layout-duration) var(--layout-easing);
  transition-delay: var(--layout-delay);
}

/*
 * After animation completes, remove will-change to free GPU memory.
 * Do this in the transitionend handler.
 */
.dag-node.layout-settled {
  will-change: auto;
  transition: none;
}
```

### 9.5 Optimization Strategies

| Strategy | Description | When |
|----------|-------------|------|
| **Skip no-ops** | If all node deltas < 1px, skip animation entirely | Repeated auto-layout without changes |
| **Batch DOM reads** | Read all `getBoundingClientRect()` before any writes | MEASURING phase |
| **Single Dagre instance** | Create Graph, compute, discard — no caching | Every layout call |
| **Animation batching** | Set all node transition properties in one rAF, then set positions in next rAF | Avoid layout thrashing |
| **Compositor promotion** | Use `will-change: transform` only during animation | ANIMATING phase only |
| **Reduced motion** | Skip animation entirely for `prefers-reduced-motion` | System preference |
| **Debounced viewport fit** | Don't recompute fit during animation — only after settle | FITTING phase |

---

## 10. Implementation Notes

### 10.1 Dagre Integration — Full Pseudocode

```javascript
/**
 * Core Dagre layout computation.
 * This is the heart of AutoLayoutEngine.
 *
 * @private
 * @param {LayoutNode[]} nodes
 * @param {LayoutEdge[]} edges
 * @param {Partial<LayoutConfig>} configOverride
 * @returns {LayoutOutput}
 */
#runDagre(nodes, edges, configOverride) {
  // ── 1. Create Dagre graph ──────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    ...LAYOUT_DEFAULTS,
    ...this.#config,
    ...configOverride,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // ── 2. Add nodes with dimensions ───────────────────────
  for (const node of nodes) {
    g.setNode(node.id, {
      width: Math.max(node.width, NODE_SIZE_DEFAULTS.minWidth),
      height: Math.max(node.height, NODE_SIZE_DEFAULTS.minHeight),
      // Dagre uses these dimensions to calculate spacing.
      // It returns (x, y) as the CENTER of the node, not top-left.
    });
  }

  // ── 3. Add edges ───────────────────────────────────────
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target, {
      weight: edge.weight ?? 1,
      // All edges equal weight. No priority edges in F16.
      // Dagre uses weight to influence how "straight" an edge is —
      // higher weight = Dagre tries harder to keep edge short/straight.
    });
  }

  // ── 4. Run Dagre layout ────────────────────────────────
  // This is the Sugiyama algorithm:
  //   Phase 1: Rank assignment (which layer/rank each node belongs to)
  //            Uses network-simplex algorithm for optimal rank assignment
  //   Phase 2: Ordering (minimize edge crossings within ranks)
  //            Uses barycenter heuristic + transposition
  //   Phase 3: Position assignment (x-coordinate within rank)
  //            Uses Brandes-Köpf algorithm for balanced positioning
  //   Phase 4: Edge routing (compute edge bend points)
  //            We ignore this — ConnectionManager handles edge paths
  dagre.layout(g);

  // ── 5. Read computed positions ─────────────────────────
  // IMPORTANT: Dagre returns (x, y) as the CENTER of the node.
  // We convert to top-left corner for CSS positioning.
  const positioned = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const node of nodes) {
    const dagreNode = g.node(node.id);
    const topLeftX = dagreNode.x - dagreNode.width / 2;
    const topLeftY = dagreNode.y - dagreNode.height / 2;

    positioned.push({
      id: node.id,
      x: topLeftX,
      y: topLeftY,
      width: dagreNode.width,
      height: dagreNode.height,
      rank: dagreNode.rank ?? 0,
      order: dagreNode.order ?? 0,
    });

    // Track bounding box
    minX = Math.min(minX, topLeftX);
    minY = Math.min(minY, topLeftY);
    maxX = Math.max(maxX, topLeftX + dagreNode.width);
    maxY = Math.max(maxY, topLeftY + dagreNode.height);
  }

  // ── 6. Compute bounding box ────────────────────────────
  const boundingBox = {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: minX + (maxX - minX) / 2,
    centerY: minY + (maxY - minY) / 2,
  };

  // ── 7. Build rank map ──────────────────────────────────
  const ranks = new Map();
  for (const p of positioned) {
    if (!ranks.has(p.rank)) {
      ranks.set(p.rank, []);
    }
    ranks.get(p.rank).push(p.id);
  }

  // ── 8. Compute graph dimensions ────────────────────────
  const graphLabel = g.graph();
  const graphWidth = graphLabel.width ?? boundingBox.width;
  const graphHeight = graphLabel.height ?? boundingBox.height;

  return {
    nodes: positioned,
    boundingBox,
    topologicalOrder: [],  // Filled by caller from topologicalSort()
    ranks,
    graphWidth,
    graphHeight,
    computationTimeMs: 0,  // Filled by caller
  };
}
```

### 10.2 Topological Sort — Full Pseudocode (Kahn's Algorithm)

```javascript
/**
 * Kahn's algorithm for topological sorting.
 *
 * Why Kahn's over DFS-based:
 * - Produces a "natural" ordering (BFS-like, layer by layer)
 * - Cycle detection is built-in (if not all nodes are processed)
 * - Level/rank assignment comes for free
 * - Easier to understand and debug
 *
 * Time complexity:  O(V + E)
 * Space complexity: O(V + E)
 *
 * @param {LayoutNode[] | string[]} nodes
 * @param {LayoutEdge[]} edges
 * @returns {TopologicalSortResult}
 */
topologicalSort(nodes, edges) {
  // ── 1. Normalize node IDs ──────────────────────────────
  const nodeIds = nodes.map(n => typeof n === 'string' ? n : n.id);
  const nodeIdSet = new Set(nodeIds);

  // ── 2. Build adjacency list and in-degree map ──────────
  // adjacency: source → [targets]
  // inDegree:  nodeId → count of incoming edges
  const adjacency = new Map();
  const inDegree = new Map();

  for (const id of nodeIds) {
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }

  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;
    if (edge.source === edge.target) continue;  // Skip self-loops

    adjacency.get(edge.source).push(edge.target);
    inDegree.set(edge.target, inDegree.get(edge.target) + 1);
  }

  // ── 3. Initialize queue with all roots (in-degree 0) ──
  // Use a regular array as a queue (shift is O(n) but V≤100 so it's fine).
  const queue = [];
  for (const id of nodeIds) {
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  }

  // Sort roots alphabetically for deterministic output.
  queue.sort();

  // ── 4. Process queue (BFS) ─────────────────────────────
  const order = [];           // Final topological order
  const ranks = new Map();    // rank → [nodeIds]
  let currentRank = 0;

  // Process level by level for rank assignment.
  // Each "level" of the BFS corresponds to a rank in the DAG.
  while (queue.length > 0) {
    // Snapshot the current queue — all nodes at this rank.
    const currentLevel = [...queue];
    queue.length = 0;

    // Sort within level for deterministic ordering.
    currentLevel.sort();

    ranks.set(currentRank, currentLevel);

    for (const nodeId of currentLevel) {
      order.push(nodeId);

      // Reduce in-degree of all children.
      for (const child of adjacency.get(nodeId)) {
        const newDegree = inDegree.get(child) - 1;
        inDegree.set(child, newDegree);

        if (newDegree === 0) {
          queue.push(child);
        }
      }
    }

    currentRank++;
  }

  // ── 5. Cycle detection ─────────────────────────────────
  // If not all nodes were processed, there's a cycle.
  if (order.length !== nodeIds.length) {
    // Find nodes involved in cycle (those not in `order`).
    const processedSet = new Set(order);
    const cycleNodes = nodeIds.filter(id => !processedSet.has(id));

    return {
      order,           // Partial order (nodes before the cycle)
      ranks,           // Partial ranks
      isDAG: false,
      cycleNodes,
    };
  }

  return {
    order,
    ranks,
    isDAG: true,
    cycleNodes: undefined,
  };
}
```

### 10.3 Cycle Detection for Edge Validation — Full Pseudocode

```javascript
/**
 * Check if adding an edge (source → target) would create a cycle.
 *
 * Algorithm: DFS from target following existing edges.
 * If we can reach source from target, adding source → target would create a cycle.
 *
 * Why DFS instead of re-running Kahn's:
 * - We only need a boolean answer, not a full sort.
 * - DFS can short-circuit as soon as source is found.
 * - At 100 nodes, both are instant, but DFS is more semantically clear for this check.
 *
 * Time complexity: O(V + E) worst case, often much less (short-circuit).
 *
 * @param {LayoutEdge[]} existingEdges
 * @param {string} source — Proposed edge source
 * @param {string} target — Proposed edge target
 * @returns {boolean} — true if cycle would be created
 */
wouldCreateCycle(existingEdges, source, target) {
  // Self-loop check
  if (source === target) return true;

  // Build adjacency list from existing edges
  const adjacency = new Map();
  for (const edge of existingEdges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
  }

  // DFS from target: can we reach source?
  // If yes → adding source→target would close a cycle.
  const visited = new Set();
  const stack = [target];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === source) return true;  // Found cycle!

    if (visited.has(current)) continue;
    visited.add(current);

    const children = adjacency.get(current) || [];
    for (const child of children) {
      if (!visited.has(child)) {
        stack.push(child);
      }
    }
  }

  return false;  // Source not reachable from target — no cycle
}
```

### 10.4 Animation Plan Computation — Full Pseudocode

```javascript
/**
 * Compute staggered animation plan.
 *
 * Choreography:
 * - Nodes animate in topological order (roots first).
 * - Within each rank, all nodes animate simultaneously.
 * - Each successive rank starts after a stagger interval.
 * - Duration per node is constant (400ms default).
 * - Easing: spring curve for organic feel.
 *
 * The result is an AnimationPlan that the DagCanvas can apply directly
 * to CSS transition-delay properties.
 *
 * @param {LayoutNode[]} currentPositions
 * @param {LayoutOutput} layoutOutput
 * @param {object} options
 * @returns {AnimationPlan}
 */
computeAnimationPlan(currentPositions, layoutOutput, options = {}) {
  const duration = options.duration ?? ANIMATION_DEFAULTS.duration;
  const staggerInterval = options.staggerInterval ?? ANIMATION_DEFAULTS.staggerInterval;
  const easing = options.easing ?? ANIMATION_DEFAULTS.easing;

  // Build a map of current positions for quick lookup.
  const currentPosMap = new Map();
  for (const node of currentPositions) {
    currentPosMap.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  // Build a map of target positions from layout output.
  const targetPosMap = new Map();
  const rankMap = new Map();
  for (const node of layoutOutput.nodes) {
    targetPosMap.set(node.id, { x: node.x, y: node.y });
    rankMap.set(node.id, node.rank);
  }

  // Determine the maximum rank for stagger calculation.
  const maxRank = Math.max(...layoutOutput.nodes.map(n => n.rank), 0);

  // Calculate total stagger time.
  let totalStagger = maxRank * staggerInterval;

  // If total animation exceeds cap, compress stagger intervals.
  const maxTotal = ANIMATION_DEFAULTS.maxTotalDuration;
  let effectiveStagger = staggerInterval;
  if (totalStagger + duration > maxTotal && maxRank > 0) {
    effectiveStagger = Math.max(10, (maxTotal - duration) / maxRank);
    totalStagger = maxRank * effectiveStagger;
  }

  // Build animation entries.
  const entries = [];
  let hasMovement = false;

  for (const node of layoutOutput.nodes) {
    const current = currentPosMap.get(node.id) || { x: 0, y: 0 };
    const target = targetPosMap.get(node.id);
    const rank = rankMap.get(node.id) ?? 0;
    const delay = rank * effectiveStagger;

    // Check if this node actually needs to move.
    const dx = Math.abs(current.x - target.x);
    const dy = Math.abs(current.y - target.y);
    if (dx > 0.5 || dy > 0.5) {
      hasMovement = true;
    }

    entries.push({
      id: node.id,
      fromX: current.x,
      fromY: current.y,
      toX: target.x,
      toY: target.y,
      delay,
      duration,
      rank,
    });
  }

  // If no node moved more than 0.5px, return empty plan (skip animation).
  if (!hasMovement) {
    return {
      entries: [],
      totalDuration: 0,
      staggerInterval: 0,
    };
  }

  return {
    entries,
    totalDuration: totalStagger + duration,
    staggerInterval: effectiveStagger,
  };
}
```

### 10.5 Viewport Fit Computation — Full Pseudocode

```javascript
/**
 * Compute zoom and pan to fit all nodes in the viewport with padding.
 *
 * The computed scale ensures the entire bounding box is visible.
 * The computed translate centers the bounding box in the viewport.
 *
 * @param {BoundingBox} boundingBox
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {object} options
 * @returns {ViewportFit}
 */
computeViewportFit(boundingBox, viewportWidth, viewportHeight, options = {}) {
  const padding = options.padding ?? VIEWPORT_FIT_DEFAULTS.padding;
  const minScale = options.minScale ?? VIEWPORT_FIT_DEFAULTS.minScale;
  const maxScale = options.maxScale ?? VIEWPORT_FIT_DEFAULTS.maxScale;

  // Available space after padding.
  const availableWidth = viewportWidth - 2 * padding;
  const availableHeight = viewportHeight - 2 * padding;

  // Handle degenerate cases.
  if (boundingBox.width <= 0 || boundingBox.height <= 0) {
    return {
      scale: 1.0,
      translateX: viewportWidth / 2,
      translateY: viewportHeight / 2,
      padding,
    };
  }

  if (availableWidth <= 0 || availableHeight <= 0) {
    return {
      scale: minScale,
      translateX: 0,
      translateY: 0,
      padding,
    };
  }

  // Scale to fit the larger dimension.
  const scaleX = availableWidth / boundingBox.width;
  const scaleY = availableHeight / boundingBox.height;
  const rawScale = Math.min(scaleX, scaleY);

  // Clamp to min/max.
  const scale = Math.max(minScale, Math.min(maxScale, rawScale));

  // Center the bounding box in the viewport.
  const translateX = (viewportWidth / 2) - (boundingBox.centerX * scale);
  const translateY = (viewportHeight / 2) - (boundingBox.centerY * scale);

  return {
    scale,
    translateX,
    translateY,
    padding,
  };
}
```

### 10.6 Node Dimension Measurement — Full Pseudocode

```javascript
/**
 * Measure actual DOM dimensions of node elements.
 *
 * This must be called BEFORE computeLayout() to provide accurate node sizes.
 * Dagre needs width/height to correctly space nodes within ranks.
 *
 * IMPORTANT: This triggers a browser layout/reflow if the DOM is dirty.
 * Call it once, batch all reads, then proceed to computation.
 * Do NOT interleave reads and writes (layout thrashing).
 *
 * @param {Map<string, HTMLElement>} nodeElements — nodeId → DOM element
 * @returns {LayoutNode[]}
 */
measureNodeDimensions(nodeElements) {
  const measured = [];

  // Batch all reads in a single pass (avoids layout thrashing).
  for (const [id, element] of nodeElements) {
    const rect = element.getBoundingClientRect();
    measured.push({
      id,
      width: Math.max(rect.width, NODE_SIZE_DEFAULTS.minWidth),
      height: Math.max(rect.height, NODE_SIZE_DEFAULTS.minHeight),
      x: parseFloat(element.style.left) || 0,
      y: parseFloat(element.style.top) || 0,
    });
  }

  return measured;
}
```

### 10.7 Connected Components Detection — Full Pseudocode

```javascript
/**
 * Find disconnected subgraphs using Union-Find.
 *
 * This is useful for:
 * 1. Understanding graph structure before layout.
 * 2. Displaying warnings ("Your graph has 3 disconnected groups").
 * 3. Potentially laying out components separately with custom spacing.
 *
 * @param {string[]} nodeIds
 * @param {LayoutEdge[]} edges
 * @returns {string[][]} — Array of connected components
 */
findConnectedComponents(nodeIds, edges) {
  // Union-Find (disjoint set) for efficiency.
  const parent = new Map();
  const rankUF = new Map();  // Union-Find rank (not DAG rank)

  // Initialize: each node is its own parent.
  for (const id of nodeIds) {
    parent.set(id, id);
    rankUF.set(id, 0);
  }

  function find(x) {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)));  // Path compression
    }
    return parent.get(x);
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;

    // Union by rank
    const rA = rankUF.get(rootA);
    const rB = rankUF.get(rootB);
    if (rA < rB) {
      parent.set(rootA, rootB);
    } else if (rA > rB) {
      parent.set(rootB, rootA);
    } else {
      parent.set(rootB, rootA);
      rankUF.set(rootA, rA + 1);
    }
  }

  // Merge components connected by edges (treat as undirected).
  for (const edge of edges) {
    if (parent.has(edge.source) && parent.has(edge.target)) {
      union(edge.source, edge.target);
    }
  }

  // Group nodes by their root.
  const components = new Map();
  for (const id of nodeIds) {
    const root = find(id);
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root).push(id);
  }

  return [...components.values()];
}
```

### 10.8 Complete DagCanvas Integration — Orchestration Pseudocode

```javascript
/**
 * Full auto-layout pipeline as orchestrated by DagCanvas.
 * This is NOT part of AutoLayoutEngine — it lives in DagCanvas (C4).
 * Shown here for completeness of the integration story.
 */
class DagCanvas {
  /** @type {AutoLayoutEngine} */
  #layoutEngine = new AutoLayoutEngine();

  /** @type {boolean} */
  #layoutInProgress = false;

  /**
   * "Auto Arrange" button handler.
   */
  async autoArrange() {
    // ── Guard: prevent concurrent layouts ────────────────
    if (this.#layoutInProgress) return;
    if (this.#nodes.size < 2) return;  // Nothing meaningful to arrange

    this.#layoutInProgress = true;
    this.#setToolbarState('arranging');
    this.emit('layout:started', {
      nodeCount: this.#nodes.size,
      edgeCount: this.#edges.size,
    });

    try {
      // ── Phase 1: MEASURING ─────────────────────────────
      const nodeElements = this.#getNodeElements();  // Map<id, HTMLElement>
      const measuredNodes = this.#layoutEngine.measureNodeDimensions(nodeElements);

      // ── Phase 2: COMPUTING ─────────────────────────────
      const edges = this.#getEdgesAsArray();  // LayoutEdge[]
      const layoutOutput = this.#layoutEngine.computeLayout(measuredNodes, edges);

      console.debug(
        `[DagCanvas] Layout computed in ${layoutOutput.computationTimeMs.toFixed(1)}ms ` +
        `for ${measuredNodes.length} nodes, ${edges.length} edges`
      );

      // ── Phase 3: Snapshot for undo ─────────────────────
      const oldPositions = new Map();
      for (const node of measuredNodes) {
        oldPositions.set(node.id, { x: node.x, y: node.y });
      }
      const newPositions = new Map();
      for (const result of layoutOutput.nodes) {
        newPositions.set(result.id, { x: result.x, y: result.y });
      }

      // ── Phase 4: ANIMATING ─────────────────────────────
      const animPlan = this.#layoutEngine.computeAnimationPlan(
        measuredNodes, layoutOutput
      );

      if (animPlan.entries.length > 0) {
        await this.#animateLayout(animPlan);
      } else {
        // No movement needed — skip animation
        for (const result of layoutOutput.nodes) {
          this.setNodePosition(result.id, result.x, result.y);
        }
      }

      // ── Phase 5: FITTING ───────────────────────────────
      const viewportFit = this.#layoutEngine.computeViewportFit(
        layoutOutput.boundingBox,
        this.#canvas.clientWidth,
        this.#canvas.clientHeight
      );
      await this.#animateViewportFit(viewportFit);

      // ── Phase 6: COMPLETE ──────────────────────────────
      // Push undo command (only if positions actually changed).
      if (animPlan.entries.length > 0) {
        this.#undoManager.push(
          new AutoLayoutCommand(oldPositions, newPositions)
        );
      }

      this.emit('layout:completed', {
        output: layoutOutput,
        durationMs: layoutOutput.computationTimeMs,
      });

      // Screen reader announcement
      this.#announce(
        `Auto-arrange complete. ${measuredNodes.length} nodes repositioned ` +
        `into ${layoutOutput.ranks.size} layers.`
      );

    } catch (err) {
      if (err instanceof CycleDetectedError) {
        this.#showToast('Cannot arrange: circular dependency detected.', 'error');
      } else {
        this.#showToast('Layout calculation failed. Try again.', 'error');
        console.error('[DagCanvas] Auto-layout failed:', err);
      }
      this.emit('layout:error', { error: err });
    } finally {
      this.#layoutInProgress = false;
      this.#setToolbarState('idle');
    }
  }

  /**
   * Apply animation plan to DOM nodes using CSS transitions.
   *
   * @param {AnimationPlan} plan
   * @returns {Promise<void>} — Resolves when all animations complete
   */
  #animateLayout(plan) {
    return new Promise((resolve) => {
      const prefersReducedMotion =
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Set up Escape key handler for cancellation.
      let cancelled = false;
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          cancelled = true;
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);

      if (prefersReducedMotion || cancelled) {
        // Snap all nodes to target positions immediately.
        for (const entry of plan.entries) {
          this.setNodePosition(entry.id, entry.toX, entry.toY);
        }
        document.removeEventListener('keydown', escHandler);
        resolve();
        return;
      }

      // Apply CSS transitions in a single rAF batch.
      requestAnimationFrame(() => {
        for (const entry of plan.entries) {
          const el = this.#getNodeElement(entry.id);
          if (!el) continue;

          el.style.transition =
            `transform ${entry.duration}ms ${ANIMATION_DEFAULTS.easing}`;
          el.style.transitionDelay = `${entry.delay}ms`;
        }

        // Set target positions in the NEXT frame (after transitions are set).
        requestAnimationFrame(() => {
          for (const entry of plan.entries) {
            this.setNodePosition(entry.id, entry.toX, entry.toY);
          }

          // Wait for the last animation to complete.
          setTimeout(() => {
            // Clean up transition properties.
            for (const entry of plan.entries) {
              const el = this.#getNodeElement(entry.id);
              if (!el) continue;
              el.style.transition = '';
              el.style.transitionDelay = '';
              el.classList.add('layout-settled');
            }
            document.removeEventListener('keydown', escHandler);
            resolve();
          }, plan.totalDuration + 50);  // +50ms buffer
        });
      });
    });
  }
}
```

### 10.9 Dagre Library Loading Strategy

```javascript
/**
 * Dagre is ~50KB gzipped. In our single-HTML-file architecture,
 * it is inlined during the build step (scripts/build-html.py).
 *
 * Loading strategy:
 * 1. Dagre is bundled into the wizard modal's JavaScript section.
 * 2. It is NOT loaded on page load — only when the wizard modal opens.
 * 3. The wizard modal is lazy-loaded (only its JS executes when the
 *    user clicks "New Environment" in the workspace explorer).
 * 4. Dagre has zero runtime dependencies — it's pure JS.
 *
 * Build integration:
 * - dagre.min.js is placed in lib/ or vendor/
 * - build-html.py inlines it into the wizard section
 * - Total wizard JS budget: ~280KB (JointJS ~180KB + Dagre ~50KB + our code ~50KB)
 *
 * Alternative: if bundle size becomes a concern, Dagre could be loaded
 * as an external script tag with a CDN fallback. But for V1, inlining
 * keeps things simple and avoids network dependencies.
 */
```

### 10.10 Sugiyama Algorithm — How Dagre Works Internally

Understanding Dagre's internals helps debug unexpected layouts:

```
The Sugiyama algorithm (also called "layered graph drawing") has 4 phases:

Phase 1: RANK ASSIGNMENT
──────────────────────────────────────────────────────────────────
Goal: Assign each node to a vertical layer (rank).
Algorithm: network-simplex (default) — minimizes total edge length.
Result: Nodes get integer ranks: 0 (roots), 1, 2, ..., N (leaves).

Example:
  A → D, B → D, C → D, D → E
  Ranks: A=0, B=0, C=0, D=1, E=2

Config that affects this:
  - rankdir: 'TB' means rank 0 is at top, higher ranks go down
  - ranksep: vertical distance between ranks (80px default)
  - ranker: 'network-simplex' (best), 'tight-tree', 'longest-path'

Phase 2: ORDERING (Edge Crossing Minimization)
──────────────────────────────────────────────────────────────────
Goal: Order nodes within each rank to minimize edge crossings.
Algorithm: Barycenter heuristic with transposition.
  - For each node, compute the average position of its neighbors
    in the adjacent rank (barycenter).
  - Sort nodes in each rank by their barycenter values.
  - Apply transposition: swap adjacent nodes if it reduces crossings.
  - Iterate multiple passes (top-down, bottom-up) until stable.

Example:
  If A→D and C→E, but B→E and B→D:
  Order rank 0 as [A, B, C] and rank 1 as [D, E] minimizes crossings.

This phase is NP-hard in general, but the heuristic works well for
practical graphs. At 100 nodes, it converges in <10ms.

Phase 3: POSITION ASSIGNMENT (X-Coordinate)
──────────────────────────────────────────────────────────────────
Goal: Assign x-coordinates to nodes within each rank.
Algorithm: Brandes-Köpf (4-pass median alignment).
  - Computes 4 candidate alignments (UL, UR, DL, DR).
  - Picks the one that best balances the graph.
  - Ensures nodesep spacing between adjacent nodes.

Config that affects this:
  - nodesep: minimum horizontal distance between nodes (60px)
  - align: force a specific alignment ('UL', 'UR', 'DL', 'DR', undefined=auto)

Phase 4: EDGE ROUTING
──────────────────────────────────────────────────────────────────
Goal: Compute bend points for edges that span multiple ranks.
Algorithm: Edge labels are positioned, long edges get "dummy nodes"
           inserted at intermediate ranks for proper routing.

We IGNORE this phase — our ConnectionManager (C7) handles edge
path computation using Bézier curves. We only use Dagre for node
positions.
```

### 10.11 Edge Cases & Defensive Measures

| Edge Case | Handling | Test |
|-----------|----------|------|
| **0 nodes** | `computeLayout()` returns empty `LayoutOutput` with zero-size bounding box | `test_empty_graph` |
| **1 node** | Dagre places at (marginx, marginy); animation is minimal move | `test_single_node` |
| **2 nodes, no edge** | Dagre places side-by-side in rank 0 (both are roots) | `test_two_unconnected` |
| **2 nodes, 1 edge** | Source at rank 0, target at rank 1 (vertical layout) | `test_simple_edge` |
| **100 nodes, linear chain** | Dagre produces 100 ranks, single node per rank; very tall layout | `test_linear_chain` |
| **100 nodes, star pattern** | 1 root → 99 children; very wide rank 1 | `test_star_pattern` |
| **Diamond pattern** | A → B, A → C, B → D, C → D; D should be centered below B and C | `test_diamond` |
| **Self-loop** | Filtered out before Dagre (self-loops are not DAG edges) | `test_self_loop` |
| **Duplicate edges** | Deduplicated before Dagre (A→B twice becomes A→B once) | `test_duplicate_edges` |
| **Invalid edge (missing node)** | Edge filtered out with console warning | `test_invalid_edge` |
| **Cycle** | Detected by Kahn's algorithm; `CycleDetectedError` thrown | `test_cycle_detection` |
| **All nodes same size** | Layout is symmetric and clean | `test_uniform_size` |
| **Mixed node sizes** | Dagre respects per-node dimensions; larger nodes get more space | `test_mixed_sizes` |
| **Node with 0 width/height** | Clamped to `NODE_SIZE_DEFAULTS.minWidth/minHeight` | `test_zero_dimensions` |
| **Negative dimensions** | Treated same as zero (clamped to minimum) | `test_negative_dimensions` |
| **Disconnected subgraphs** | Dagre lays out independently; placed side-by-side | `test_disconnected` |
| **Wide rank (20 nodes at rank 0)** | Viewport fit zooms out; user scrolls into detail | `test_wide_rank` |
| **Deep DAG (15+ ranks)** | Animation stagger compressed to stay under 2-second cap | `test_deep_dag` |
| **Identical layout (re-run)** | Animation plan detects zero movement; skips animation entirely | `test_idempotent` |
| **Tab backgrounded during animation** | CSS transitions complete when tab returns (browser handles this) | `test_background_tab` |
| **prefers-reduced-motion** | All animations skipped; nodes snap to final positions | `test_reduced_motion` |
| **Viewport dimensions 0** | Fallback to 800×600; log warning | `test_zero_viewport` |

### 10.12 Testing Strategy

```
Unit Tests (AutoLayoutEngine in isolation, no DOM):
─────────────────────────────────────────────────────
1. computeLayout() — correct positions for known graph topologies
2. topologicalSort() — correct ordering for various DAGs
3. topologicalSort() — cycle detection for cyclic graphs
4. wouldCreateCycle() — true/false for various edge additions
5. computeAnimationPlan() — correct delays and durations
6. computeViewportFit() — correct scale and translate for various bounding boxes
7. findRoots() / findLeaves() — correct for various graphs
8. findConnectedComponents() — correct grouping
9. Edge cases: empty graph, single node, self-loops, duplicate edges

Integration Tests (AutoLayoutEngine + DagCanvas mock):
─────────────────────────────────────────────────────
1. Auto-layout button click → nodes end up at computed positions
2. Undo after auto-layout → nodes return to previous positions
3. Template load → auto-layout applied on initial render
4. Multiple auto-layout calls → idempotent (no unnecessary animation)

Visual Tests (screenshot comparison):
─────────────────────────────────────────────────────
1. Known 5-node diamond DAG → matches reference screenshot
2. Known 10-node multi-root DAG → matches reference screenshot
3. Animation at 50% progress → nodes visually between start and end
```

### 10.13 File Structure

```
src/
└── wizard/
    ├── auto-layout-engine.js      ← This component (pure computation)
    ├── auto-layout-command.js     ← AutoLayoutCommand for undo stack
    └── ...

lib/
└── dagre.min.js                   ← Dagre library (~50KB gzipped)

tests/
└── wizard/
    └── auto-layout-engine.test.js ← Unit tests
```

### 10.14 Dependencies

| Dependency | Version | Size (gzip) | License | Purpose |
|------------|---------|-------------|---------|---------|
| `@dagrejs/dagre` | ^1.1.4 | ~50 KB | MIT | Sugiyama layout algorithm |

**No other runtime dependencies.** AutoLayoutEngine is pure JS with a single library dependency.

### 10.15 Future Considerations (Non-Goals for V1)

| Feature | Why Deferred | When to Revisit |
|---------|-------------|-----------------|
| Left-to-right layout (LR) | TB is sufficient for V1. The infra mentions LR as a "stretch goal" option. Config already supports `rankdir: 'LR'` — just needs a dropdown in toolbar. | V2 polish pass |
| Layout algorithm picker | Research notes mention offering "L-R hierarchy" vs "T-B hierarchy" vs "Compact" in a dropdown. V1 ships TB only. | V2 polish pass |
| Web Worker for layout | At 100 nodes, Dagre is <50ms synchronous. Worker adds complexity for no gain. | If node limit increases to 500+ |
| Incremental layout | Re-layout only affected subgraph when one node is added/removed. Dagre doesn't support this natively — would require a custom wrapper. | V2 if full re-layout feels slow |
| Edge routing from Dagre | Dagre computes edge bend points, but we ignore them in favor of ConnectionManager's Bézier curves. Could use Dagre's edge points for orthogonal routing. | V2 if edge overlap is a complaint |
| Animation with FLIP technique | Use FLIP (First, Last, Invert, Play) for even smoother animation. Current CSS transitions are adequate. | V2 polish pass |
| Layout presets | "Compact", "Spacious", "Presentation" presets that adjust nodesep/ranksep/margins. | V2 polish pass |
| Group/cluster layout | Dagre supports compound graphs (clusters). Could group nodes by schema (dbo, bronze, silver, gold) into visual clusters. | V3 if schema grouping is requested |

---

*End of C13-AutoLayoutEngine Component Deep Spec.*
*Next: P1.14 — UndoRedoManager component spec.*
