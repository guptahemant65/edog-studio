# C05 — NodePalette: Component Deep Spec

> **Component:** NodePalette (C05)
> **Feature:** F16 New Infra Wizard — Page 3 DAG Canvas
> **Priority:** P1 (Component Deep Spec)
> **Complexity:** MEDIUM
> **Owner:** Pixel (Frontend Agent)
> **Dependencies:** P0.6 Canvas Interaction Research (complete), P0.4 DAG Builder Research (complete)
> **Spec Version:** 1.0
> **Date:** 2025-07-18

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Specification](#6-visual-specification)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

NodePalette is the collapsible left sidebar on the DAG Canvas page (Page 3) of the Infra Wizard. It serves as the primary drag source from which users add new nodes to the DAG canvas. The palette contains three draggable node type cards — Plain SQL Table, SQL MLV, and PySpark MLV — and provides multiple node-creation pathways: drag-and-drop (primary), double-click quick-add, and keyboard shortcut command palette.

NodePalette is the first point of interaction for building a DAG. It must be immediately discoverable, visually communicate that items are draggable, and provide rich feedback throughout the entire drag-and-drop lifecycle.

### 1.2 Scope

NodePalette **owns:**

| Concern | Details |
|---------|---------|
| **Sidebar container** | Vertical left panel, 180px wide, full DAG page height, collapsible |
| **Header** | "Add Nodes" title with collapse/expand toggle button |
| **3 node type cards** | Draggable cards for Plain SQL Table, SQL MLV, PySpark MLV |
| **Drag ghost element** | Semi-transparent floating clone that follows the cursor during drag |
| **Drop zone feedback** | Canvas highlight and cursor changes during drag-over |
| **Node count display** | Live counter: "N / 100 nodes" |
| **Disabled state** | Entire palette greys out when 100-node limit reached |
| **Quick-add** | Double-click on a palette card to place node at next available position |
| **Command palette** | `/` keyboard shortcut opens a quick-add search popup |
| **Collapse/expand** | Toggle sidebar between full width and collapsed icon strip |

NodePalette **does NOT own:**

| Concern | Owner |
|---------|-------|
| Canvas zoom/pan | DagCanvas (C04) |
| Node rendering on canvas | DagNode (C06) |
| Connection/edge drawing | ConnectionManager (C07) |
| Node editing popover | DagNode (C06) |
| Auto-layout | AutoLayoutEngine (C13) |
| Undo/redo for node creation | UndoRedoManager (C14) |
| Screen-to-canvas coordinate conversion | DagCanvas (C04) |
| Node ID generation | DagCanvas (C04) |

### 1.3 Design References

| Reference | Location |
|-----------|----------|
| CEO-approved mock (Page 3) | `mocks/infra-wizard.html` — `.dag-toolbar` section |
| DAG builder UX research | `research/p0-dag-builder-research.md` §3.1 |
| Canvas interaction research | `research/p0-canvas-interaction.md` §2.1, §2.4, §2.6 |
| Design Bible 4b | Overlay and component styling |
| Master spec | `spec.md` §2 Page 3, §8 (max 100 nodes) |

### 1.4 Design Decision Summary

The CEO-approved mock establishes a **sidebar palette** as the primary node-placement mechanism. Research (P0.4, P0.6) independently validated this as the most discoverable pattern (n8n, NiFi precedent). While the canvas interaction research noted a sidebar "feels heavy for only 3 node types," the mock overrides that concern — the sidebar also houses toolbar actions (Auto Arrange, Undo/Redo) and serves as a persistent reference for available node types.

We supplement the sidebar drag with:
- **Double-click quick-add** — fastest single action for power users
- **`/` command palette** — keyboard-driven flow matching Notion/VS Code muscle memory
- **Right-click context menu** — owned by DagCanvas, not this component

---

## 2. Data Model

### 2.1 Node Type Definitions

Three immutable node type definitions drive the palette content:

```typescript
/**
 * Static definition of a node type available in the palette.
 * These are compile-time constants — never modified at runtime.
 */
interface NodeTypeDefinition {
  /** Unique identifier used in data-type attributes and DAG model */
  id: 'sql-table' | 'sql-mlv' | 'pyspark';

  /** Display name shown on palette card and ghost element */
  displayName: string;

  /** One-line description shown below the name */
  description: string;

  /** Unicode symbol used as icon (no emoji per project rules) */
  iconSymbol: string;

  /** CSS class suffix for color theming (maps to .node-type-icon.{cssClass}) */
  cssClass: string;

  /** OKLCH-based foreground color for the icon */
  iconColor: string;

  /** OKLCH-based background tint for the icon container */
  iconBgColor: string;

  /** Whether this node type can have parent nodes (input ports) */
  canHaveParents: boolean;

  /** Whether this node type can have child nodes (output ports) */
  canHaveChildren: boolean;

  /** Default auto-generated name prefix for new nodes of this type */
  namePrefix: string;

  /** Tooltip text for the palette card */
  tooltip: string;
}
```

**Concrete definitions:**

```javascript
const NODE_TYPES = Object.freeze([
  {
    id: 'sql-table',
    displayName: 'SQL Table',
    description: 'Source table with sample data',
    iconSymbol: '◇',
    cssClass: 'sql-table',
    iconColor: '#2d7ff9',                       // oklch(0.62 0.18 255)
    iconBgColor: 'rgba(45, 127, 249, 0.08)',    // oklch(0.62 0.18 255 / 0.08)
    canHaveParents: false,
    canHaveChildren: true,
    namePrefix: 'table',
    tooltip: 'Add a source SQL table. Always a root node (no parents). Generates CREATE TABLE + INSERT with themed sample data (10 rows).',
  },
  {
    id: 'sql-mlv',
    displayName: 'SQL MLV',
    description: 'CREATE MATERIALIZED LAKE VIEW (SQL)',
    iconSymbol: '◆',
    cssClass: 'sql-mlv',
    iconColor: 'var(--accent)',                  // #6d5cff — oklch(0.52 0.25 285)
    iconBgColor: 'rgba(109, 92, 255, 0.08)',    // oklch(0.52 0.25 285 / 0.08)
    canHaveParents: true,
    canHaveChildren: true,
    namePrefix: 'mlv',
    tooltip: 'Add a SQL Materialized Lake View. Must have at least one parent. Generates CREATE MATERIALIZED LAKE VIEW AS SELECT with JOINs to parent tables.',
  },
  {
    id: 'pyspark',
    displayName: 'PySpark MLV',
    description: 'PySpark materialized_lake_view decorator',
    iconSymbol: '◆',
    cssClass: 'pyspark',
    iconColor: 'var(--status-warn)',             // #e5940c — oklch(0.72 0.17 70)
    iconBgColor: 'rgba(229, 148, 12, 0.08)',    // oklch(0.72 0.17 70 / 0.08)
    canHaveParents: true,
    canHaveChildren: true,
    namePrefix: 'spark_mlv',
    tooltip: 'Add a PySpark Materialized Lake View. Must have at least one parent. Generates @fmlv.materialized_lake_view decorated function with DataFrame construction.',
  },
]);
```

### 2.2 Palette State Model

```typescript
/**
 * Runtime state of the NodePalette component.
 * Updated via setState() — never mutated directly.
 */
interface NodePaletteState {
  /** Current lifecycle state (see State Machine §4) */
  phase: 'expanded' | 'collapsed' | 'dragging' | 'disabled' | 'command-palette-open';

  /** Total node count on canvas (drives counter display + disabled state) */
  nodeCount: number;

  /** Maximum allowed nodes — hardcoded to 100 */
  maxNodes: number;

  /** Which node type card is being dragged, or null if no drag active */
  activeDragType: NodeTypeDefinition['id'] | null;

  /** Current ghost element position during drag (viewport coordinates) */
  ghostPosition: { x: number; y: number } | null;

  /** Whether the cursor is currently over the canvas drop zone */
  isOverDropZone: boolean;

  /** Command palette filter text (when command palette is open) */
  commandPaletteQuery: string;

  /** Filtered node types in command palette (computed from query) */
  commandPaletteResults: NodeTypeDefinition[];

  /** Index of currently highlighted item in command palette (keyboard nav) */
  commandPaletteSelectedIndex: number;
}
```

### 2.3 Drag Transfer Data

Data transferred during drag-and-drop uses a structured payload:

```typescript
/**
 * Payload attached to the drag operation.
 * Stored in the pointer event tracking object (NOT HTML5 dataTransfer —
 * we use pointer events for full control over the ghost element).
 */
interface DragPayload {
  /** The node type being dragged */
  nodeTypeId: NodeTypeDefinition['id'];

  /** Offset from the cursor to the top-left of the ghost element */
  cursorOffset: { x: number; y: number };

  /** The DOM element of the source palette card (for visual feedback) */
  sourceElement: HTMLElement;

  /** Timestamp of drag start (for distinguishing click vs drag) */
  startTime: number;

  /** Starting cursor position (for dead-zone calculation) */
  startPosition: { x: number; y: number };
}
```

### 2.4 Events Emitted

NodePalette communicates with DagCanvas and other components via a custom event bus:

| Event Name | Payload | Trigger | Consumer |
|-----------|---------|---------|----------|
| `palette:drag-start` | `{ nodeTypeId, ghostPosition }` | Drag begins (after dead-zone threshold) | DagCanvas |
| `palette:drag-move` | `{ nodeTypeId, viewportPosition }` | Cursor moves during drag | DagCanvas |
| `palette:drag-end` | `{ nodeTypeId, viewportPosition, cancelled }` | Drag completes or cancels | DagCanvas |
| `palette:drop` | `{ nodeTypeId, canvasPosition }` | Successful drop on canvas | DagCanvas |
| `palette:quick-add` | `{ nodeTypeId }` | Double-click on palette card | DagCanvas |
| `palette:command-select` | `{ nodeTypeId }` | Enter pressed in command palette | DagCanvas |
| `palette:collapse-changed` | `{ collapsed: boolean }` | Sidebar toggled | DagCanvas (layout) |

### 2.5 Events Consumed

| Event Name | Source | Effect |
|-----------|--------|--------|
| `canvas:node-count-changed` | DagCanvas | Updates `nodeCount`, may trigger disabled state |
| `canvas:drop-zone-enter` | DagCanvas | Sets `isOverDropZone = true`, updates ghost styling |
| `canvas:drop-zone-leave` | DagCanvas | Sets `isOverDropZone = false`, updates ghost styling |
| `wizard:page-changed` | InfraWizardDialog | If leaving Page 3, cancel any active drag |
| `undo:node-removed` | UndoRedoManager | May re-enable palette if count drops below max |

---

## 3. API Surface

### 3.1 Class Definition

```javascript
/**
 * NodePalette — Sidebar palette for dragging node types onto the DAG canvas.
 *
 * @class
 * @extends {EventTarget}
 *
 * Usage:
 *   const palette = new NodePalette(containerEl, dagCanvas, eventBus);
 *   palette.mount();
 *   // later:
 *   palette.destroy();
 */
class NodePalette extends EventTarget {
  /**
   * @param {HTMLElement} container — Parent element to render palette into
   * @param {DagCanvas} dagCanvas — Reference to the canvas for coordinate conversion
   * @param {EventBus} eventBus — Shared event bus for inter-component communication
   */
  constructor(container, dagCanvas, eventBus) {}
}
```

### 3.2 Public Methods

```typescript
interface NodePalettePublicAPI {
  /**
   * Mount the palette into the DOM. Creates all child elements,
   * attaches event listeners, and renders initial state.
   * Idempotent — calling mount() twice has no effect.
   */
  mount(): void;

  /**
   * Tear down the palette. Removes all DOM elements, detaches
   * all event listeners, clears ghost element, cancels any active drag.
   */
  destroy(): void;

  /**
   * Collapse the sidebar to a narrow icon strip (24px wide).
   * Emits 'palette:collapse-changed' event.
   * @param {boolean} [animate=true] — Whether to animate the transition
   */
  collapse(animate?: boolean): void;

  /**
   * Expand the sidebar to full width (180px).
   * Emits 'palette:collapse-changed' event.
   * @param {boolean} [animate=true] — Whether to animate the transition
   */
  expand(animate?: boolean): void;

  /**
   * Toggle between collapsed and expanded state.
   */
  toggleCollapse(): void;

  /**
   * Update the node count display. Called by DagCanvas when nodes
   * are added/removed. Triggers disabled state check.
   * @param {number} count — Current total node count on canvas
   */
  setNodeCount(count: number): void;

  /**
   * Open the command palette popup.
   * @param {string} [initialQuery=''] — Pre-fill the search field
   */
  openCommandPalette(initialQuery?: string): void;

  /**
   * Close the command palette popup.
   */
  closeCommandPalette(): void;

  /**
   * Force-cancel any active drag operation. Used when the wizard
   * navigates away from Page 3 or the dialog is minimized.
   */
  cancelDrag(): void;

  /**
   * Check whether a drag is currently in progress.
   * @returns {boolean}
   */
  isDragging(): boolean;

  /**
   * Get the current state of the palette.
   * @returns {Readonly<NodePaletteState>}
   */
  getState(): Readonly<NodePaletteState>;

  /**
   * Enable or disable the entire palette programmatically.
   * @param {boolean} enabled — If false, all cards become non-draggable
   */
  setEnabled(enabled: boolean): void;
}
```

### 3.3 Constructor Options

```typescript
interface NodePaletteOptions {
  /** Maximum number of nodes allowed on the canvas. Default: 100 */
  maxNodes?: number;

  /** Initial collapsed state. Default: false (expanded) */
  initialCollapsed?: boolean;

  /** Dead-zone threshold in pixels before drag starts. Default: 4 */
  dragDeadZone?: number;

  /** Delay in ms before showing ghost element after drag threshold. Default: 0 */
  ghostDelay?: number;

  /** Whether to enable the command palette shortcut. Default: true */
  enableCommandPalette?: boolean;

  /** Whether to enable double-click quick-add. Default: true */
  enableQuickAdd?: boolean;

  /** Custom node placement strategy for quick-add.
   *  Receives current canvas state, returns {x, y} in canvas coordinates.
   *  Default: places at center of visible viewport with offset stacking. */
  quickAddPlacement?: (canvasState: CanvasState) => { x: number; y: number };
}
```

### 3.4 CSS Custom Properties (Theming API)

NodePalette exposes CSS custom properties for theming without JS changes:

```css
.node-palette {
  /* Layout */
  --palette-width: 180px;
  --palette-collapsed-width: 44px;
  --palette-padding: var(--sp-4);           /* 16px */
  --palette-gap: var(--sp-3);               /* 12px */

  /* Card styling */
  --palette-card-padding: var(--sp-3);      /* 12px */
  --palette-card-radius: var(--r-md);       /* 6px */
  --palette-card-border-width: 1.5px;
  --palette-card-border-style: dashed;
  --palette-card-border-color: var(--border-bright);

  /* Ghost element */
  --palette-ghost-opacity: 0.85;
  --palette-ghost-scale: 1.02;
  --palette-ghost-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  --palette-ghost-radius: var(--r-md);

  /* Drop zone */
  --palette-dropzone-color: var(--accent);
  --palette-dropzone-opacity: 0.06;
  --palette-dropzone-border-color: var(--accent);
  --palette-dropzone-border-opacity: 0.20;

  /* Transition */
  --palette-collapse-duration: 200ms;
  --palette-collapse-easing: var(--ease);
}
```

---

## 4. State Machine

### 4.1 States

```
┌──────────────────────────────────────────────────────────────────────┐
│                      NodePalette State Machine                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐    collapse()    ┌───────────┐                        │
│  │ EXPANDED │ ──────────────→ │ COLLAPSED │                        │
│  │          │ ←────────────── │           │                        │
│  └────┬─────┘    expand()     └─────┬─────┘                        │
│       │                              │                               │
│       │ mousedown+                   │ (no drag from collapsed)      │
│       │ mousemove                    │                               │
│       │ (past dead zone)             │                               │
│       ▼                              │                               │
│  ┌──────────┐                        │                               │
│  │ DRAGGING │ ───── mouseup ────→ (back to EXPANDED)                │
│  │          │ ───── Escape ─────→ (back to EXPANDED)                │
│  │          │ ───── page change ─→ (back to EXPANDED)               │
│  └──────────┘                                                        │
│       ▲                                                              │
│       │ (cannot drag)                                                │
│  ┌──────────┐                                                        │
│  │ DISABLED │ (nodeCount >= maxNodes)                                │
│  │          │ ←─── setNodeCount(n >= 100) ──── EXPANDED             │
│  │          │ ───→ setNodeCount(n < 100)  ──── EXPANDED             │
│  └──────────┘                                                        │
│                                                                      │
│  ┌────────────────────┐                                              │
│  │ COMMAND_PALETTE_OPEN│ (modal overlay on palette area)             │
│  │                    │ ←── '/' key (from EXPANDED)                  │
│  │                    │ ──→ Escape / Enter / click-outside           │
│  │                    │     (back to EXPANDED)                       │
│  └────────────────────┘                                              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 State Definitions

| State | Entry Condition | Visual | User Can... |
|-------|----------------|--------|-------------|
| **EXPANDED** | Initial mount, expand(), drag end, command palette close | Full 180px sidebar, all 3 cards visible with dashed borders, node count visible | Drag cards, double-click cards, collapse, press `/` |
| **COLLAPSED** | collapse() called, or toggle button clicked | 44px narrow strip showing only node type icons vertically, tooltip on hover | Click icons (expand + quick-add), expand, press `/` |
| **DRAGGING** | mousedown + mousemove past 4px dead zone on a palette card | Source card dimmed (opacity 0.4), ghost element follows cursor, canvas shows drop zone overlay | Move cursor to drop, release to place node, press Escape to cancel |
| **DISABLED** | `setNodeCount(n)` where `n >= 100` | All cards greyed out (opacity 0.35), cursor: `not-allowed`, counter shows "100 / 100" in red, tooltip: "Maximum 100 nodes reached" | Nothing — all drag/click/keyboard interactions blocked |
| **COMMAND_PALETTE_OPEN** | `/` key pressed when palette is focused or canvas is focused | Floating popup with search input + 3 node type options, arrow-key navigable | Type to filter, arrow keys to select, Enter to place, Escape to close |

### 4.3 Transition Table

| From State | Trigger | To State | Side Effects |
|-----------|---------|----------|-------------|
| EXPANDED | `collapse()` or toggle button click | COLLAPSED | Animate width 180px → 44px, emit `palette:collapse-changed` |
| COLLAPSED | `expand()` or toggle button click | EXPANDED | Animate width 44px → 180px, emit `palette:collapse-changed` |
| COLLAPSED | Click on collapsed icon | EXPANDED | Expand first, then (optionally) no additional action |
| EXPANDED | mousedown + mousemove > 4px on card | DRAGGING | Create ghost, dim source card, emit `palette:drag-start`, add `pointer-events: none` to palette cards |
| DRAGGING | mouseup over canvas | EXPANDED | Emit `palette:drop`, remove ghost, un-dim source card, request DagCanvas to create node |
| DRAGGING | mouseup outside canvas | EXPANDED | Emit `palette:drag-end { cancelled: true }`, remove ghost, un-dim source card |
| DRAGGING | Escape key | EXPANDED | Cancel drag, remove ghost, emit `palette:drag-end { cancelled: true }` |
| DRAGGING | `wizard:page-changed` event | EXPANDED | Force-cancel drag |
| EXPANDED | `setNodeCount(100)` | DISABLED | Grey out all cards, update counter color to red |
| DISABLED | `setNodeCount(99)` (or lower) | EXPANDED | Restore all card styling, counter back to normal |
| DISABLED | mousedown on card | DISABLED | No-op (show "Maximum 100 nodes" tooltip) |
| EXPANDED | `/` key | COMMAND_PALETTE_OPEN | Show command palette popup, focus search input |
| COMMAND_PALETTE_OPEN | Escape, click outside, Enter (on selection) | EXPANDED | Close popup, optionally emit `palette:command-select` on Enter |
| COMMAND_PALETTE_OPEN | mousedown on card | COMMAND_PALETTE_OPEN | Close command palette first, then begin drag sequence |

### 4.4 Guard Conditions

| Guard | Condition | Effect |
|-------|-----------|--------|
| `canDrag` | `state.phase !== 'disabled' && state.phase !== 'dragging' && state.nodeCount < state.maxNodes` | Prevents starting a new drag when disabled or already dragging |
| `canQuickAdd` | `state.phase === 'expanded' && state.nodeCount < state.maxNodes` | Prevents double-click add when collapsed/disabled/dragging |
| `canOpenCommandPalette` | `state.phase === 'expanded' || state.phase === 'collapsed'` | Prevents opening command palette during drag or when disabled |
| `isValidDrop` | `cursor is over canvas element && state.phase === 'dragging'` | Determines whether drop creates a node or cancels |
| `pastDeadZone` | `sqrt((dx*dx) + (dy*dy)) > dragDeadZone` | Prevents accidental drags from clicks — must move ≥ 4px |

---

## 5. Scenarios

### 5.1 Scenario A — Primary Drag-and-Drop (Happy Path)

**Preconditions:** Palette is EXPANDED, node count < 100, user is on Page 3.

**Flow:**

```
USER                          PALETTE                           CANVAS
 │                              │                                 │
 ├── mousedown on               │                                 │
 │   "SQL MLV" card ──────────→ │ Record startPosition,           │
 │                              │ startTime, nodeTypeId           │
 │                              │ BEGIN TRACKING (no visual        │
 │                              │ change yet — dead zone)          │
 │                              │                                 │
 ├── mousemove (dx=2, dy=1) ──→ │ distance=2.24 < 4px             │
 │                              │ Still in dead zone, no-op       │
 │                              │                                 │
 ├── mousemove (dx=5, dy=3) ──→ │ distance=5.83 > 4px             │
 │                              │ ★ DRAG STARTS:                  │
 │                              │ 1. Create ghost element          │
 │                              │ 2. Dim source card (opacity 0.4) │
 │                              │ 3. Set cursor: grabbing          │
 │                              │ 4. Emit palette:drag-start ────→│ Show drop zone overlay
 │                              │                                 │ (subtle blue tint)
 │                              │                                 │
 ├── mousemove (over palette)──→ │ Update ghost position            │
 │                              │ Ghost follows cursor             │
 │                              │ Cursor: grabbing                 │
 │                              │                                 │
 ├── mousemove (enters canvas)─→ │ ──── palette:drag-move ────────→│ Drop zone pulses
 │                              │ Ghost gets green tint            │ "ready" indicator
 │                              │ isOverDropZone = true            │ Cursor: copy
 │                              │                                 │
 ├── mousemove (over canvas) ──→ │ Update ghost position            │ Drop zone position
 │                              │ continuously                     │ indicator follows
 │                              │                                 │
 ├── mouseup (on canvas) ──────→ │ ★ DROP:                         │
 │                              │ 1. Get viewport position         │
 │                              │ 2. Emit palette:drop ──────────→│ ★ CREATE NODE:
 │                              │ 3. Animate ghost → shrink to     │ 1. screenToCanvas(pos)
 │                              │    node position (150ms)         │ 2. createNode(type, pos)
 │                              │ 4. Remove ghost element          │ 3. Select new node
 │                              │ 5. Un-dim source card            │ 4. Open naming popover
 │                              │ 6. Increment node count          │ 5. Emit node-count-changed
 │                              │                                 │ 6. Remove drop zone overlay
 │                              │                                 │
 │                              │ ★ DRAG ENDS                     │
 │                              │ phase → EXPANDED                │
```

### 5.2 Scenario B — Drag Cancelled (Release Outside Canvas)

**Preconditions:** Drag is in progress, ghost element is visible.

```
USER                          PALETTE                           CANVAS
 │                              │                                 │
 ├── mousemove (leave canvas) ─→ │ isOverDropZone = false           │ Remove drop zone
 │                              │ Ghost: red tint, "not-allowed"  │ overlay
 │                              │ cursor                          │
 │                              │                                 │
 ├── mouseup (outside canvas) ─→ │ ★ CANCEL:                       │
 │                              │ 1. Animate ghost → fade out     │
 │                              │    (100ms ease-out)              │
 │                              │ 2. Remove ghost element          │
 │                              │ 3. Un-dim source card            │
 │                              │ 4. Restore cursor               │
 │                              │ 5. Emit palette:drag-end         │
 │                              │    { cancelled: true }           │
 │                              │ phase → EXPANDED                │
```

### 5.3 Scenario C — Drag Cancelled via Escape Key

```
USER                          PALETTE
 │                              │
 ├── [Escape] key ─────────────→ │ ★ IMMEDIATE CANCEL:
 │                              │ 1. Snap ghost back to source
 │                              │    card position (120ms spring)
 │                              │ 2. Remove ghost element
 │                              │ 3. Un-dim source card
 │                              │ 4. Emit palette:drag-end
 │                              │    { cancelled: true }
 │                              │ 5. Announce "Drag cancelled"
 │                              │    via aria-live
 │                              │ phase → EXPANDED
```

### 5.4 Scenario D — Double-Click Quick-Add

**Preconditions:** Palette is EXPANDED, node count < 100.

```
USER                          PALETTE                           CANVAS
 │                              │                                 │
 ├── dblclick on                │                                 │
 │   "PySpark MLV" card ──────→ │ Guard: canQuickAdd?             │
 │                              │ YES → emit palette:quick-add    │
 │                              │ { nodeTypeId: 'pyspark' } ─────→│ 1. Calculate next
 │                              │                                 │    available position
 │                              │ Card flashes accent border      │ 2. createNode('pyspark',
 │                              │ (200ms pulse animation)         │    computedPosition)
 │                              │                                 │ 3. Select new node
 │                              │                                 │ 4. Open naming popover
 │                              │                                 │ 5. Emit node-count-changed
```

**Quick-add position algorithm:**

```javascript
/**
 * Calculate the next available position for a quick-add node.
 * Places nodes in a staggered grid pattern, avoiding overlap with
 * existing nodes.
 */
function computeQuickAddPosition(canvasState) {
  const GRID_STEP_X = 200;   // horizontal spacing
  const GRID_STEP_Y = 120;   // vertical spacing
  const MAX_PER_ROW = 5;

  // Get center of current viewport in canvas coordinates
  const viewportCenter = canvasState.getViewportCenter();

  // Count existing nodes to determine offset
  const n = canvasState.getNodeCount();
  const col = n % MAX_PER_ROW;
  const row = Math.floor(n / MAX_PER_ROW);

  return {
    x: viewportCenter.x - (MAX_PER_ROW * GRID_STEP_X / 2) + (col * GRID_STEP_X),
    y: viewportCenter.y - 100 + (row * GRID_STEP_Y),
  };
}
```

### 5.5 Scenario E — Command Palette (`/` Shortcut)

**Preconditions:** Canvas or palette has focus, palette not disabled.

```
USER                          PALETTE                         CANVAS
 │                              │                               │
 ├── Press "/" key ────────────→ │ Guard: canOpenCommandPalette? │
 │                              │ YES → phase = COMMAND_PALETTE │
 │                              │ 1. Create floating popup at   │
 │                              │    cursor position (or center │
 │                              │    of viewport if no cursor)  │
 │                              │ 2. Render search input +      │
 │                              │    3 node type options         │
 │                              │ 3. Focus search input          │
 │                              │ 4. selectedIndex = 0           │
 │                              │                               │
 ├── Type "py" ───────────────→ │ Filter: "pyspark" matches     │
 │                              │ Show only PySpark MLV option  │
 │                              │ selectedIndex = 0 (first match)│
 │                              │                               │
 ├── Press Enter ─────────────→ │ 1. Emit palette:command-select│
 │                              │    { nodeTypeId: 'pyspark' }  │
 │                              │ 2. Close command palette ─────→│ Create node at
 │                              │ 3. phase → EXPANDED            │ cursor position
 │                              │                               │ (or viewport center)
 │                              │                               │
 │ OR:                          │                               │
 ├── Press Escape ────────────→ │ Close command palette          │
 │                              │ phase → EXPANDED               │
 │                              │                               │
 │ OR:                          │                               │
 ├── Press ↓ (arrow down) ────→ │ selectedIndex++ (wrap around) │
 ├── Press ↑ (arrow up) ──────→ │ selectedIndex-- (wrap around) │
```

**Command palette filtering algorithm:**

```javascript
/**
 * Fuzzy-match filter for node types.
 * Matches against displayName, description, and id.
 * Case-insensitive, supports substring matching.
 */
function filterNodeTypes(query, nodeTypes) {
  if (!query.trim()) return [...nodeTypes];

  const q = query.toLowerCase().trim();
  return nodeTypes.filter(nt =>
    nt.displayName.toLowerCase().includes(q) ||
    nt.description.toLowerCase().includes(q) ||
    nt.id.toLowerCase().includes(q)
  );
}
```

### 5.6 Scenario F — Max Nodes Reached (100/100)

```
USER                          PALETTE
 │                              │
 │ (canvas:node-count-changed   │
 │  fires with count=100) ─────→│ ★ DISABLE:
 │                              │ 1. phase → DISABLED
 │                              │ 2. All cards: opacity 0.35
 │                              │ 3. All cards: cursor not-allowed
 │                              │ 4. All cards: pointer-events none
 │                              │ 5. Counter turns red: "100 / 100"
 │                              │ 6. Show inline message:
 │                              │    "Maximum nodes reached"
 │                              │ 7. Disable command palette shortcut
 │                              │
 ├── mousedown on card ────────→│ No-op (pointer-events: none)
 │                              │ Tooltip: "Maximum 100 nodes reached.
 │                              │  Delete a node to add more."
 │                              │
 ├── Press "/" ────────────────→│ No-op (guard: canOpenCommandPalette
 │                              │  returns false)
```

### 5.7 Scenario G — Collapse and Expand

```
USER                          PALETTE
 │                              │
 ├── Click collapse toggle ───→ │ ★ COLLAPSE:
 │                              │ 1. Animate width 180px → 44px
 │                              │    (200ms ease)
 │                              │ 2. Hide card labels + descriptions
 │                              │    (opacity 0 at 100ms, then
 │                              │     display:none at 200ms)
 │                              │ 3. Show only icon column
 │                              │ 4. Toggle icon rotates (▸ → ◂)
 │                              │ 5. Emit palette:collapse-changed
 │                              │ 6. phase → COLLAPSED
 │                              │
 │ In collapsed state:          │
 │                              │
 ├── Hover over icon ─────────→ │ Show tooltip with node type name
 │                              │
 ├── Click on icon ───────────→ │ Expand palette (phase → EXPANDED)
 │                              │
 ├── Click expand toggle ─────→ │ ★ EXPAND:
 │                              │ 1. Animate width 44px → 180px
 │                              │    (200ms ease)
 │                              │ 2. Fade in labels (opacity 0→1)
 │                              │ 3. phase → EXPANDED
```

### 5.8 Scenario H — Drag with Page Navigation (Edge Case)

```
USER                          PALETTE                       WIZARD
 │                              │                             │
 │ (drag in progress)           │                             │
 ├── Click "Back" button ──────→│                             │ Emit wizard:page-changed
 │                              │ ←── wizard:page-changed ───│
 │                              │ ★ FORCE CANCEL:             │
 │                              │ 1. Immediately remove ghost │
 │                              │ 2. Reset all drag state     │
 │                              │ 3. Un-dim source card       │
 │                              │ 4. phase → EXPANDED         │
```

### 5.9 Scenario I — Rapid Sequential Drags

**Preconditions:** User quickly drags and drops multiple nodes in succession.

```
USER                          PALETTE                           CANVAS
 │                              │                                 │
 ├── Drag SQL Table → drop ────→│ Complete first drag cycle       │ Node 1 created
 │                              │ phase → EXPANDED                │
 │                              │                                 │
 ├── Immediately drag           │                                 │
 │   SQL MLV → drop ──────────→ │ Complete second drag cycle      │ Node 2 created
 │                              │ (no debounce between drags —    │
 │                              │  each drag is independent)      │
 │                              │                                 │
 │ Note: No cooldown between    │                                 │
 │ drags. Each mouseup fully    │                                 │
 │ resets state before next     │                                 │
 │ mousedown can begin a new    │                                 │
 │ drag.                        │                                 │
```

### 5.10 Scenario J — Touch Device Drag (Tablet/Touchscreen)

```
USER                          PALETTE
 │                              │
 ├── touchstart on card ───────→│ Record startPosition, startTime
 │                              │ (same as mousedown)
 │                              │
 ├── touchmove (past 8px       │
 │   dead zone — larger for    │
 │   touch to prevent scroll   │
 │   hijacking) ───────────────→│ ★ DRAG STARTS:
 │                              │ 1. Call e.preventDefault()
 │                              │    to cancel scroll
 │                              │ 2. Create ghost at touch point
 │                              │ 3. Same visual flow as mouse
 │                              │
 ├── touchend (on canvas) ────→ │ ★ DROP (same as mouseup)
 │                              │
 ├── touchcancel ─────────────→ │ ★ CANCEL (same as Escape)
```

---

## 6. Visual Specification

### 6.1 Palette Container (Expanded)

```
┌────────────────────────┐
│  ADD NODES         ◂   │ ← Header: uppercase, 10px, 700wt, muted
│                        │    ◂ = collapse toggle (rotates to ▸)
│ ┌────────────────────┐ │
│ │ ◇  SQL Table       │ │ ← Card 1: dashed border, grab cursor
│ │    Source table     │ │    12px name, 10px description
│ │    with sample data │ │
│ └────────────────────┘ │
│                        │
│ ┌────────────────────┐ │
│ │ ◆  SQL MLV         │ │ ← Card 2: accent color
│ │    CREATE MATERIAL- │ │
│ │    IZED LAKE VIEW   │ │
│ └────────────────────┘ │
│                        │
│ ┌────────────────────┐ │
│ │ ◆  PySpark MLV     │ │ ← Card 3: orange/warning color
│ │    PySpark material-│ │
│ │    ized_lake_view   │ │
│ └────────────────────┘ │
│                        │
│          ···           │ ← Spacer (flex: 1)
│                        │
│  3 / 100 nodes         │ ← Node count: 10px, muted text
│                        │
│ ┌────────────────────┐ │
│ │ ▦  Auto Arrange    │ │ ← Toolbar actions (existing in mock)
│ ├──────────┬─────────┤ │
│ │ ↺ Undo   │ ↻ Redo  │ │
│ └──────────┴─────────┘ │
└────────────────────────┘
```

**Container CSS:**

```css
.node-palette {
  width: var(--palette-width);           /* 180px */
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--sp-4);                  /* 16px */
  gap: var(--sp-3);                      /* 12px */
  background: var(--surface);            /* #ffffff */
  border-right: 1px solid var(--border); /* rgba(0,0,0,0.06) */
  transition: width var(--palette-collapse-duration) var(--palette-collapse-easing);
  overflow: hidden;
  user-select: none;
  position: relative;
  z-index: 5;                           /* Above canvas, below popover */
}

.node-palette.collapsed {
  width: var(--palette-collapsed-width); /* 44px */
  padding: var(--sp-2);                  /* 8px */
  align-items: center;
}
```

### 6.2 Header

```css
.node-palette__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 20px;
}

.node-palette__title {
  font-size: var(--text-xs);             /* 10px */
  font-weight: 700;
  color: var(--text-muted);             /* #8e95a5 */
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
  overflow: hidden;
  transition: opacity var(--t-fast) var(--ease);
}

.node-palette.collapsed .node-palette__title {
  opacity: 0;
  width: 0;
}

.node-palette__collapse-toggle {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-sm);           /* 4px */
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
  flex-shrink: 0;
}

.node-palette__collapse-toggle:hover {
  background: var(--surface-2);
  color: var(--text);
}

.node-palette.collapsed .node-palette__collapse-toggle {
  transform: rotate(180deg);            /* ◂ becomes ▸ */
}
```

### 6.3 Node Type Cards

Each card is a draggable element with four visual states.

**HTML structure (per card):**

```html
<div class="node-palette__card"
     data-node-type="sql-mlv"
     role="button"
     tabindex="0"
     aria-label="SQL MLV — CREATE MATERIALIZED LAKE VIEW (SQL). Drag to canvas or double-click to add."
     aria-grabbed="false">
  <div class="node-palette__card-icon sql-mlv" aria-hidden="true">◆</div>
  <div class="node-palette__card-content">
    <div class="node-palette__card-name">SQL MLV</div>
    <div class="node-palette__card-desc">CREATE MATERIALIZED LAKE VIEW (SQL)</div>
  </div>
</div>
```

**Card CSS — All States:**

```css
/* ─── Default State ─── */
.node-palette__card {
  padding: var(--palette-card-padding);  /* 12px */
  border-radius: var(--palette-card-radius); /* 6px */
  border: var(--palette-card-border-width) var(--palette-card-border-style) var(--palette-card-border-color);
                                          /* 1.5px dashed rgba(0,0,0,0.12) */
  background: var(--surface);            /* #ffffff */
  cursor: grab;
  display: flex;
  align-items: center;
  gap: var(--sp-2);                      /* 8px */
  transition: all var(--t-fast) var(--ease); /* 80ms */
  position: relative;
}

/* ─── Hover State ─── */
.node-palette__card:hover {
  border-color: var(--accent);           /* #6d5cff */
  border-style: solid;
  background: var(--accent-hover);       /* rgba(109,92,255,0.04) */
}

/* ─── Active/Pressed State ─── */
.node-palette__card:active {
  cursor: grabbing;
  transform: scale(0.97);
  border-style: solid;
  border-color: var(--accent);
}

/* ─── Focus State (keyboard) ─── */
.node-palette__card:focus-visible {
  outline: none;
  border-color: var(--accent);
  border-style: solid;
  box-shadow: 0 0 0 2px var(--accent-glow); /* rgba(109,92,255,0.15) */
}

/* ─── Drag-Source State (while this card's type is being dragged) ─── */
.node-palette__card.is-drag-source {
  opacity: 0.4;
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-dim);         /* rgba(109,92,255,0.07) */
  cursor: grabbing;
  transform: scale(0.95);
}

/* ─── Disabled State ─── */
.node-palette__card.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
  border-color: var(--border);
  border-style: dashed;
}

/* ─── Quick-Add Flash (after double-click) ─── */
.node-palette__card.is-flash {
  animation: paletteFlash 200ms var(--ease);
}

@keyframes paletteFlash {
  0%   { border-color: var(--accent); box-shadow: 0 0 0 0 var(--accent-glow); }
  50%  { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-glow); }
  100% { border-color: var(--palette-card-border-color); box-shadow: none; }
}
```

**Card icon CSS:**

```css
.node-palette__card-icon {
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);           /* 4px */
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}

/* Color variants per node type */
.node-palette__card-icon.sql-table {
  background: rgba(45, 127, 249, 0.08);
  color: #2d7ff9;
}

.node-palette__card-icon.sql-mlv {
  background: rgba(109, 92, 255, 0.08);
  color: var(--accent);                  /* #6d5cff */
}

.node-palette__card-icon.pyspark {
  background: rgba(229, 148, 12, 0.08);
  color: var(--status-warn);             /* #e5940c */
}
```

**Card text CSS:**

```css
.node-palette__card-name {
  font-size: var(--text-sm);             /* 12px */
  font-weight: 600;
  color: var(--text);                    /* #1a1d23 */
  line-height: 1.3;
}

.node-palette__card-desc {
  font-size: var(--text-xs);             /* 10px */
  color: var(--text-muted);             /* #8e95a5 */
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

### 6.4 Ghost Element (During Drag)

The ghost element is a simplified, semi-transparent clone of the palette card that follows the cursor during drag. It provides spatial preview of what the user is about to drop.

**Ghost element structure:**

```html
<!-- Appended to document.body during drag (removed on drop/cancel) -->
<div class="node-palette__ghost" role="presentation" aria-hidden="true">
  <div class="node-palette__ghost-icon sql-mlv">◆</div>
  <div class="node-palette__ghost-name">SQL MLV</div>
</div>
```

**Ghost element CSS:**

```css
.node-palette__ghost {
  position: fixed;                       /* Viewport-relative positioning */
  z-index: 10000;                        /* Above everything */
  pointer-events: none;                  /* Pass-through for drop detection */
  display: flex;
  align-items: center;
  gap: var(--sp-2);                      /* 8px */
  padding: 8px 14px;
  border-radius: var(--palette-ghost-radius); /* 6px */
  background: var(--surface);            /* #ffffff */
  border: 1.5px solid var(--accent);     /* #6d5cff */
  box-shadow: var(--palette-ghost-shadow); /* 0 8px 32px rgba(0,0,0,0.15) */
  opacity: var(--palette-ghost-opacity); /* 0.85 */
  transform: scale(var(--palette-ghost-scale)) rotate(-1deg); /* 1.02, slight rotation */
  transition: opacity 80ms ease, transform 80ms ease,
              border-color 80ms ease, box-shadow 80ms ease;
  white-space: nowrap;
  font-family: var(--font);
  will-change: transform, left, top;     /* GPU-accelerated positioning */
}

/* ─── Ghost over valid drop zone (canvas) ─── */
.node-palette__ghost.is-over-dropzone {
  border-color: var(--status-ok);        /* #18a058 */
  box-shadow: 0 8px 32px rgba(24, 160, 88, 0.20),
              0 0 0 2px rgba(24, 160, 88, 0.12);
  transform: scale(1.05) rotate(0deg);
}

/* ─── Ghost over invalid area (outside canvas) ─── */
.node-palette__ghost.is-invalid {
  border-color: var(--status-fail);      /* #e5453b */
  opacity: 0.6;
  transform: scale(0.95) rotate(-1deg);
}

/* ─── Ghost entering (appear animation) ─── */
.node-palette__ghost.is-entering {
  animation: ghostAppear 120ms var(--spring) both;
}

@keyframes ghostAppear {
  from {
    opacity: 0;
    transform: scale(0.7) rotate(-3deg);
  }
  to {
    opacity: var(--palette-ghost-opacity);
    transform: scale(var(--palette-ghost-scale)) rotate(-1deg);
  }
}

/* ─── Ghost drop animation (shrinks into node position) ─── */
.node-palette__ghost.is-dropping {
  animation: ghostDrop 150ms var(--ease) forwards;
}

@keyframes ghostDrop {
  to {
    opacity: 0;
    transform: scale(0.5) rotate(0deg);
  }
}

/* ─── Ghost cancel animation (fade out) ─── */
.node-palette__ghost.is-cancelling {
  animation: ghostCancel 100ms var(--ease-out) forwards;
}

@keyframes ghostCancel {
  to {
    opacity: 0;
    transform: scale(0.8) rotate(-2deg);
  }
}

/* ─── Ghost icon inherits card icon styling ─── */
.node-palette__ghost-icon {
  width: 20px;
  height: 20px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}

.node-palette__ghost-icon.sql-table { background: rgba(45,127,249,0.12); color: #2d7ff9; }
.node-palette__ghost-icon.sql-mlv   { background: rgba(109,92,255,0.12); color: var(--accent); }
.node-palette__ghost-icon.pyspark   { background: rgba(229,148,12,0.12); color: var(--status-warn); }

.node-palette__ghost-name {
  font-size: var(--text-sm);             /* 12px */
  font-weight: 600;
  color: var(--text);
}
```

### 6.5 Drop Zone Feedback on Canvas

When a drag is in progress, the canvas displays visual feedback indicating it's a valid drop target.

**Drop zone overlay CSS (applied to DagCanvas, triggered by NodePalette events):**

```css
/* ─── Drop zone: full canvas overlay (during any palette drag) ─── */
.dag-canvas.is-drop-target::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--palette-dropzone-color);  /* var(--accent) */
  opacity: var(--palette-dropzone-opacity);   /* 0.06 */
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  animation: dropZonePulse 1.5s ease-in-out infinite;
}

@keyframes dropZonePulse {
  0%, 100% { opacity: 0.04; }
  50%      { opacity: 0.08; }
}

/* ─── Drop zone border (dashed border around canvas) ─── */
.dag-canvas.is-drop-target::after {
  content: '';
  position: absolute;
  inset: 8px;
  border: 2px dashed var(--palette-dropzone-border-color); /* var(--accent) */
  opacity: var(--palette-dropzone-border-opacity);          /* 0.20 */
  border-radius: var(--r-lg);                               /* 10px */
  pointer-events: none;
  z-index: 1;
  animation: dropZoneBorderPulse 1.5s ease-in-out infinite;
}

@keyframes dropZoneBorderPulse {
  0%, 100% { opacity: 0.15; }
  50%      { opacity: 0.30; }
}

/* ─── Drop position indicator (crosshair at cursor position) ─── */
.dag-canvas__drop-indicator {
  position: absolute;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: var(--accent-dim);
  pointer-events: none;
  z-index: 2;
  transform: translate(-50%, -50%);
  animation: dropIndicatorPulse 1s ease-in-out infinite;
  /* Position set via JS: left, top */
}

@keyframes dropIndicatorPulse {
  0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.7; }
  50%      { transform: translate(-50%, -50%) scale(1.3); opacity: 0.3; }
}

/* ─── "Drop here" text hint (shown once, first time user drags) ─── */
.dag-canvas__drop-hint {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--accent);
  opacity: 0.5;
  pointer-events: none;
  z-index: 2;
  white-space: nowrap;
  animation: fadeIn 200ms ease both;
}
```

### 6.6 Node Count Display

```css
.node-palette__counter {
  font-size: var(--text-xs);             /* 10px */
  font-weight: 600;
  color: var(--text-muted);             /* #8e95a5 */
  padding: 0 var(--sp-1);
  text-align: center;
  transition: color var(--t-fast) var(--ease);
}

/* ─── Warning state (90-99 nodes) ─── */
.node-palette__counter.is-warning {
  color: var(--status-warn);             /* #e5940c */
}

/* ─── Limit reached (100 nodes) ─── */
.node-palette__counter.is-limit {
  color: var(--status-fail);             /* #e5453b */
  font-weight: 700;
}
```

### 6.7 Command Palette Popup

```
┌──────────────────────────────────────┐
│ 🔍 Search nodes...                   │ ← Input with auto-focus
├──────────────────────────────────────┤
│ ▸ ◇  Plain SQL Table                │ ← Arrow indicates selected
│   ◆  SQL MLV                         │
│   ◆  PySpark MLV                     │
└──────────────────────────────────────┘
```

```css
.node-palette__command-palette {
  position: fixed;
  z-index: 10001;
  width: 280px;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--r-lg);            /* 10px */
  box-shadow: var(--shadow-xl);
  padding: var(--sp-2);                  /* 8px */
  animation: scaleSpring 200ms var(--spring) both;
}

.node-palette__command-input {
  width: 100%;
  padding: var(--sp-2) var(--sp-3);      /* 8px 12px */
  border: 1px solid var(--border-bright);
  border-radius: var(--r-md);            /* 6px */
  font-size: var(--text-sm);             /* 12px */
  color: var(--text);
  background: var(--surface-2);
  margin-bottom: var(--sp-2);
}

.node-palette__command-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
  outline: none;
}

.node-palette__command-input::placeholder {
  color: var(--text-muted);
}

.node-palette__command-option {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-dim);
  transition: all var(--t-fast) var(--ease);
}

.node-palette__command-option:hover,
.node-palette__command-option.is-selected {
  background: var(--accent-hover);
  color: var(--text);
}

.node-palette__command-option.is-selected {
  background: var(--accent-dim);
}

.node-palette__command-option .node-palette__card-icon {
  width: 20px;
  height: 20px;
  font-size: 10px;
}

.node-palette__command-empty {
  padding: var(--sp-3);
  text-align: center;
  font-size: var(--text-xs);
  color: var(--text-muted);
}
```

### 6.8 Collapsed State

```
┌────┐
│ ◂  │ ← Expand toggle (or ▸ depending on direction)
│    │
│ ◇  │ ← SQL Table icon only (tooltip on hover)
│ ◆  │ ← SQL MLV icon only
│ ◆  │ ← PySpark MLV icon only
│    │
│    │ ← Spacer
│    │
│ 3  │ ← Count (number only, no "/ 100")
│    │
│ ▦  │ ← Auto Arrange icon
│↺ ↻│ ← Undo/Redo icons
└────┘
```

```css
.node-palette.collapsed .node-palette__card {
  padding: var(--sp-2);
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--r-sm);
  width: 28px;
  height: 28px;
}

.node-palette.collapsed .node-palette__card:hover {
  background: var(--surface-2);
}

.node-palette.collapsed .node-palette__card-content {
  display: none;
}

.node-palette.collapsed .node-palette__card-icon {
  width: 20px;
  height: 20px;
  font-size: 10px;
}
```

### 6.9 Color Reference Table

| Node Type | Icon Symbol | Icon FG | Icon BG | Border (hover) | Badge |
|-----------|-------------|---------|---------|----------------|-------|
| **Plain SQL Table** | ◇ | `#2d7ff9` | `rgba(45,127,249,0.08)` | `var(--accent)` | `SQL Table` in blue |
| **SQL MLV** | ◆ | `var(--accent)` / `#6d5cff` | `rgba(109,92,255,0.08)` | `var(--accent)` | `SQL MLV` in purple |
| **PySpark MLV** | ◆ | `var(--status-warn)` / `#e5940c` | `rgba(229,148,12,0.08)` | `var(--accent)` | `PySpark` in orange |

### 6.10 Spacing & Dimensions Reference

| Element | Property | Value | Token |
|---------|----------|-------|-------|
| Sidebar width (expanded) | `width` | 180px | `--palette-width` |
| Sidebar width (collapsed) | `width` | 44px | `--palette-collapsed-width` |
| Sidebar padding | `padding` | 16px | `--sp-4` |
| Card padding | `padding` | 12px | `--sp-3` |
| Card gap (between cards) | `gap` | 12px | `--sp-3` |
| Card border radius | `border-radius` | 6px | `--r-md` |
| Card border width | `border-width` | 1.5px | — |
| Icon size | `width × height` | 24×24px | — |
| Icon border-radius | `border-radius` | 4px | `--r-sm` |
| Icon font-size | `font-size` | 12px | — |
| Card name font-size | `font-size` | 12px | `--text-sm` |
| Card desc font-size | `font-size` | 10px | `--text-xs` |
| Ghost element padding | `padding` | 8px 14px | — |
| Ghost element shadow | `box-shadow` | `0 8px 32px rgba(0,0,0,0.15)` | `--palette-ghost-shadow` |
| Counter font-size | `font-size` | 10px | `--text-xs` |
| Command palette width | `width` | 280px | — |

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Navigation

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Palette | Move focus to next palette card (cycles through 3 cards) |
| `Shift+Tab` | Palette | Move focus to previous palette card |
| `Enter` | Focused card | Quick-add node to canvas (same as double-click) |
| `Space` | Focused card | Quick-add node to canvas (same as Enter) |
| `/` | Canvas or palette focused | Open command palette popup |
| `Escape` | During drag | Cancel drag, return ghost to source |
| `Escape` | Command palette open | Close command palette |
| `↓` | Command palette | Move selection down (wraps to first) |
| `↑` | Command palette | Move selection up (wraps to last) |
| `Enter` | Command palette (option selected) | Add selected node type to canvas |
| `Backspace` | Command palette (input empty) | Close command palette |

### 7.2 Focus Management

```
Tab order within palette:
1. Collapse/expand toggle button
2. SQL Table card
3. SQL MLV card
4. PySpark MLV card
5. Auto Arrange button
6. Undo button
7. Redo button
```

**Focus trap in command palette:**
- When command palette opens, focus moves to search input
- Tab cycles within the command palette (input → options → input)
- Escape closes and returns focus to the card that was focused before opening

### 7.3 ARIA Attributes

**Palette container:**
```html
<nav class="node-palette"
     role="toolbar"
     aria-label="Node palette — drag node types to the canvas"
     aria-orientation="vertical">
```

**Individual card:**
```html
<div class="node-palette__card"
     role="button"
     tabindex="0"
     aria-label="SQL MLV — CREATE MATERIALIZED LAKE VIEW (SQL). Drag to canvas or press Enter to add."
     aria-grabbed="false"
     aria-roledescription="draggable node type">
```

**During drag:**
```html
<!-- aria-grabbed changes to true on the source card -->
<div class="node-palette__card is-drag-source"
     aria-grabbed="true">

<!-- Live region announces drag state changes -->
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
  <!-- Updated dynamically: -->
  <!-- "Dragging SQL MLV. Move to canvas and release to place." -->
  <!-- "SQL MLV dropped on canvas. Node created." -->
  <!-- "Drag cancelled." -->
</div>
```

**Node count:**
```html
<div class="node-palette__counter"
     role="status"
     aria-live="polite"
     aria-label="3 of 100 maximum nodes placed on canvas">
  3 / 100 nodes
</div>
```

**Command palette:**
```html
<div class="node-palette__command-palette"
     role="listbox"
     aria-label="Add node — type to filter">
  <input class="node-palette__command-input"
         role="combobox"
         aria-expanded="true"
         aria-controls="node-palette-options"
         aria-autocomplete="list"
         aria-activedescendant="node-opt-0"
         placeholder="Search nodes...">
  <div id="node-palette-options" role="listbox">
    <div id="node-opt-0"
         role="option"
         aria-selected="true"
         class="node-palette__command-option is-selected">
      ...
    </div>
  </div>
</div>
```

### 7.4 Screen Reader Announcements

| Event | Announcement (via `aria-live` region) |
|-------|--------------------------------------|
| Drag starts | "Dragging {nodeType}. Move to the canvas and release to place the node." |
| Cursor enters canvas during drag | "Over canvas. Release to place {nodeType} here." |
| Cursor leaves canvas during drag | "Outside canvas. Release here to cancel." |
| Drop succeeds | "{nodeType} placed on canvas. {count} of {max} nodes." |
| Drag cancelled (Escape) | "Drag cancelled." |
| Drag cancelled (outside canvas) | "Drop cancelled — released outside canvas." |
| Quick-add (double-click/Enter) | "{nodeType} added to canvas. {count} of {max} nodes." |
| Command palette opens | "Node search palette open. Type to filter 3 node types." |
| Command palette filters | "{n} results for '{query}'." |
| Command palette selects | "{nodeType} selected. Press Enter to add." |
| Max nodes reached | "Maximum node limit reached. 100 of 100 nodes. Delete a node to add more." |
| Palette collapsed | "Node palette collapsed." |
| Palette expanded | "Node palette expanded." |

### 7.5 Visual Accessibility

| Requirement | Implementation |
|-------------|---------------|
| **Color independence** | Node types differentiated by icon symbol (◇ vs ◆), not just color. SQL Table uses ◇ (diamond outline), MLVs use ◆ (diamond filled). |
| **Contrast ratio** | All text meets WCAG AA 4.5:1. Card name `#1a1d23` on `#ffffff` = 15.3:1. Muted description `#8e95a5` on `#ffffff` = 3.7:1 (enhanced with larger nearby name text). |
| **Focus indicator** | 2px accent ring (`box-shadow: 0 0 0 2px var(--accent-glow)`) on all focusable elements. Passes WCAG 2.2 focus appearance criteria. |
| **Motion** | All animations respect `prefers-reduced-motion: reduce`. Ghost element snaps to position instead of animating. Drop zone pulse becomes static tint. |
| **Touch targets** | All cards ≥ 44px tall (meeting WCAG 2.2 Target Size). Collapsed icons are 28px — enhanced with 44px touch padding via `::before` pseudo-element. |

```css
@media (prefers-reduced-motion: reduce) {
  .node-palette__ghost,
  .node-palette__ghost.is-entering,
  .node-palette__ghost.is-dropping,
  .node-palette__ghost.is-cancelling {
    animation: none;
    transition: none;
  }

  .dag-canvas.is-drop-target::before,
  .dag-canvas.is-drop-target::after,
  .dag-canvas__drop-indicator {
    animation: none;
  }

  .node-palette__card.is-flash {
    animation: none;
  }
}
```

---

## 8. Error Handling

### 8.1 Error Taxonomy

| # | Error | Trigger | Severity | User Experience |
|---|-------|---------|----------|----------------|
| E1 | **Max nodes exceeded** | `setNodeCount(n)` where `n >= 100` during drag or quick-add | Medium | Ghost turns red, drops cancelled. Palette enters DISABLED state. Counter turns red. |
| E2 | **Drop outside canvas** | mouseup fires outside `.dag-canvas` element | Low | Ghost fade-out animation. No node created. No error message (this is normal UX, not an error). |
| E3 | **Canvas not mounted** | Palette attempts to reference `dagCanvas` but it's null | High | Log error. Disable palette. Show "Canvas not ready" in counter area. |
| E4 | **Ghost element leak** | Browser tab loses focus during drag, or unexpected DOM mutation | Medium | Defensive cleanup: on `visibilitychange` event, check for orphaned ghost elements and remove them. |
| E5 | **Coordinate conversion failure** | `screenToCanvas()` returns NaN or Infinity | High | Fallback to canvas center coordinates. Log warning. |
| E6 | **Event bus disconnected** | `eventBus` is null or `emit()` throws | High | Wrap all emits in try-catch. Log error. Continue palette operation in degraded mode (no canvas communication). |
| E7 | **Concurrent drag conflict** | Two pointer events attempt to start drags simultaneously (multi-touch) | Low | Ignore second pointer. Only one drag at a time. First pointer wins. |

### 8.2 Error Recovery Pseudocode

```javascript
/**
 * Defensive ghost cleanup — prevents ghost element leaks.
 * Called on: visibilitychange, blur, wizard page change, component destroy.
 */
function cleanupOrphanedGhosts() {
  const ghosts = document.querySelectorAll('.node-palette__ghost');
  ghosts.forEach(ghost => {
    ghost.remove();
  });
  this._state.activeDragType = null;
  this._state.ghostPosition = null;
  this._state.isOverDropZone = false;
}

/**
 * Safe coordinate conversion with fallback.
 */
function safeScreenToCanvas(viewportX, viewportY) {
  try {
    const canvasPos = this._dagCanvas.screenToCanvas(viewportX, viewportY);
    if (!Number.isFinite(canvasPos.x) || !Number.isFinite(canvasPos.y)) {
      throw new Error(`Invalid canvas coordinates: (${canvasPos.x}, ${canvasPos.y})`);
    }
    return canvasPos;
  } catch (err) {
    console.warn('[NodePalette] Coordinate conversion failed, using viewport center:', err);
    const center = this._dagCanvas.getViewportCenter();
    return center || { x: 400, y: 300 }; // absolute fallback
  }
}

/**
 * Safe event emission with error isolation.
 */
function safeEmit(eventName, payload) {
  try {
    this._eventBus.emit(eventName, payload);
  } catch (err) {
    console.error(`[NodePalette] Failed to emit ${eventName}:`, err);
  }
}
```

### 8.3 Edge Case Handling

| Edge Case | Behavior |
|-----------|----------|
| **Drag starts, browser tab loses focus** | `visibilitychange` listener cancels drag, removes ghost |
| **Drag starts, wizard dialog minimized** | `wizard:minimize` event cancels drag |
| **Double-click while drag in progress** | Ignored (guard: `phase !== 'dragging'`) |
| **`/` key while typing in a text input elsewhere** | Only triggers if canvas or palette element has focus, NOT if an `<input>` or `<textarea>` is focused |
| **Window resize during drag** | Ghost position continues to track cursor (fixed positioning). Drop zone recalculates on resize. |
| **Zoom/pan canvas during drag** | Ghost position is viewport-relative. Canvas coordinate conversion on drop accounts for current zoom/pan state. |
| **Mouse button release missed** (e.g., mouse leaves browser window) | `pointerup` on `document` catches it. If pointer leaves window entirely, `pointerleave` on `document` cancels drag. |
| **Rapid double-click vs drag confusion** | Double-click detection: if two clicks within 300ms and no significant movement between them (< 4px), treat as double-click, not drag. |
| **Node count goes from 100 to 99 during disabled state** | Watch for `canvas:node-count-changed` — if count drops below max, transition from DISABLED → EXPANDED. |

---

## 9. Performance

### 9.1 Performance Budgets

| Metric | Budget | Measurement |
|--------|--------|-------------|
| **Ghost element creation** | < 2ms | From mousedown+dead-zone to ghost visible |
| **Ghost position update** | < 1ms per frame | Must maintain 60fps during drag |
| **Drop zone overlay activation** | < 3ms | From `palette:drag-start` to overlay visible |
| **Node creation after drop** | < 5ms | From mouseup to new node in DOM (excluding undo stack) |
| **Command palette open** | < 5ms | From `/` key to popup visible with focus |
| **Command palette filter** | < 1ms | Per keystroke (trivial with 3 items) |
| **Collapse/expand animation** | 200ms | CSS transition, GPU-composited |
| **Memory (palette steady state)** | < 50 KB | DOM nodes + event listeners + state object |

### 9.2 Drag Performance Strategy

The drag-and-drop interaction is the most performance-sensitive part of NodePalette. The ghost element repositioning must run at 60fps (16.67ms per frame) without jank.

**Strategy: `requestAnimationFrame` batching**

```javascript
/**
 * Pointer event handler — schedules ghost position update.
 * Raw pointer events can fire at 120Hz+ on some devices.
 * We batch to one update per animation frame.
 */
class DragTracker {
  constructor() {
    this._pendingPosition = null;
    this._rafId = null;
  }

  onPointerMove(e) {
    // Store the latest position — don't update DOM here
    this._pendingPosition = { x: e.clientX, y: e.clientY };

    // Schedule a single rAF update (coalesces multiple pointer events)
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._updateGhostPosition(this._pendingPosition);
        this._rafId = null;
      });
    }
  }

  _updateGhostPosition(pos) {
    // Single DOM write per frame — no layout thrashing
    const ghost = this._ghostElement;
    if (!ghost) return;

    // Use transform instead of left/top for GPU compositing
    ghost.style.transform = `translate(${pos.x - this._cursorOffset.x}px, ${pos.y - this._cursorOffset.y}px) scale(${this._isOverDropZone ? 1.05 : 1.02}) rotate(${this._isOverDropZone ? '0deg' : '-1deg'})`;
  }

  cancel() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._pendingPosition = null;
  }
}
```

### 9.3 DOM Efficiency

| Concern | Strategy |
|---------|----------|
| **Ghost element lifecycle** | Create once on drag start, remove on drop/cancel. Never pool or pre-create. |
| **Ghost positioning** | Use CSS `transform: translate()` — GPU-composited, avoids layout recalculation |
| **Drop zone overlay** | Use CSS `::before` / `::after` pseudo-elements — zero additional DOM nodes |
| **Command palette** | Created on demand, destroyed on close. 3 option items = trivial DOM. |
| **Event listeners** | Attach `pointermove` and `pointerup` to `document` ONLY during active drag. Detach immediately on drag end. |
| **Pointer capture** | Use `element.setPointerCapture(pointerId)` on drag start to ensure all pointer events route to our handler, even when cursor leaves the browser window. |

### 9.4 Memory Management

```javascript
/**
 * Cleanup checklist — executed on destroy() and on each drag end.
 */
function cleanupDragState() {
  // 1. Cancel any pending rAF
  if (this._rafId) {
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  // 2. Remove ghost element from DOM
  if (this._ghostElement) {
    this._ghostElement.remove();
    this._ghostElement = null;
  }

  // 3. Release pointer capture
  if (this._capturedPointerId !== null) {
    try {
      document.releasePointerCapture(this._capturedPointerId);
    } catch (e) { /* already released */ }
    this._capturedPointerId = null;
  }

  // 4. Remove document-level listeners
  document.removeEventListener('pointermove', this._onPointerMove);
  document.removeEventListener('pointerup', this._onPointerUp);
  document.removeEventListener('keydown', this._onDragKeyDown);

  // 5. Reset state
  this._state.activeDragType = null;
  this._state.ghostPosition = null;
  this._state.isOverDropZone = false;
}
```

---

## 10. Implementation Notes

### 10.1 Why Pointer Events (Not HTML5 Drag-and-Drop API)

The HTML5 Drag-and-Drop API (`dragstart`, `dragover`, `drop`) is **not used** for this component. Reasons:

| Limitation of HTML5 D&D | Impact |
|-------------------------|--------|
| Browser-native ghost (the translucent clone) cannot be styled or customized | We need a branded ghost with node type icon, name, and color theming |
| `dragImage` is a static bitmap — no animations during drag | We need dynamic ghost styling changes (green when over canvas, red when outside) |
| `dragover` events throttled in some browsers (250ms intervals on Chrome) | We need 60fps ghost tracking for smooth UX |
| No touch support (HTML5 D&D is mouse-only) | Must support tablet/touch devices |
| `dataTransfer` types are limited | We need structured payload objects |
| Cannot prevent default browser drag behaviors on images/links inside palette | Conflicts with custom drag handling |

**Our approach:** Raw pointer events (`pointerdown`, `pointermove`, `pointerup`) with manual ghost element management. This gives us:
- Full control over the ghost element appearance and animations
- 60fps tracking via `requestAnimationFrame`
- Touch support via pointer events (which unify mouse, touch, and pen)
- Dynamic styling changes during drag (green/red drop zone feedback)
- Clean Escape key cancellation with spring-back animation

### 10.2 Complete Drag Lifecycle Pseudocode

```javascript
class NodePalette {
  // ─── PHASE 1: MOUSEDOWN ───────────────────────────────────────
  _onCardPointerDown(e, nodeTypeId) {
    // Guard: can we start a drag?
    if (!this._canDrag()) return;
    if (e.button !== 0) return; // left-click only

    // Record starting conditions
    this._dragPayload = {
      nodeTypeId,
      startPosition: { x: e.clientX, y: e.clientY },
      startTime: performance.now(),
      cursorOffset: { x: 0, y: 0 },
      sourceElement: e.currentTarget,
    };

    // Capture pointer to receive events even outside the element
    e.currentTarget.setPointerCapture(e.pointerId);
    this._capturedPointerId = e.pointerId;

    // Listen for move and up on document (removed on drag end)
    document.addEventListener('pointermove', this._onPointerMove);
    document.addEventListener('pointerup', this._onPointerUp);

    // Prevent default to avoid text selection
    e.preventDefault();
  }

  // ─── PHASE 2: MOUSEMOVE (PRE-DRAG — DEAD ZONE) ───────────────
  _onPointerMove = (e) => {
    if (!this._dragPayload) return;

    const dx = e.clientX - this._dragPayload.startPosition.x;
    const dy = e.clientY - this._dragPayload.startPosition.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (this._state.phase !== 'dragging') {
      // Still in dead zone
      if (distance < this._options.dragDeadZone) return;

      // ★ Dead zone exceeded — START DRAG
      this._startDrag(e);
      return;
    }

    // ★ Already dragging — update ghost position
    this._updateDrag(e);
  };

  // ─── PHASE 3: DRAG STARTS ────────────────────────────────────
  _startDrag(e) {
    const nodeType = this._getNodeType(this._dragPayload.nodeTypeId);

    // 1. Create ghost element
    this._ghostElement = this._createGhostElement(nodeType);
    document.body.appendChild(this._ghostElement);

    // 2. Calculate cursor offset (ghost center aligns with cursor)
    const ghostRect = this._ghostElement.getBoundingClientRect();
    this._dragPayload.cursorOffset = {
      x: ghostRect.width / 2,
      y: ghostRect.height / 2,
    };

    // 3. Position ghost at cursor
    this._positionGhost(e.clientX, e.clientY);

    // 4. Animate ghost entrance
    this._ghostElement.classList.add('is-entering');
    requestAnimationFrame(() => {
      this._ghostElement.classList.remove('is-entering');
    });

    // 5. Dim the source card
    this._dragPayload.sourceElement.classList.add('is-drag-source');
    this._dragPayload.sourceElement.setAttribute('aria-grabbed', 'true');

    // 6. Set body cursor
    document.body.style.cursor = 'grabbing';

    // 7. Update state
    this._state.phase = 'dragging';
    this._state.activeDragType = this._dragPayload.nodeTypeId;

    // 8. Listen for Escape to cancel
    document.addEventListener('keydown', this._onDragKeyDown);

    // 9. Notify canvas
    this._safeEmit('palette:drag-start', {
      nodeTypeId: this._dragPayload.nodeTypeId,
      ghostPosition: { x: e.clientX, y: e.clientY },
    });

    // 10. Announce to screen readers
    this._announce(`Dragging ${nodeType.displayName}. Move to the canvas and release to place the node.`);
  }

  // ─── PHASE 4: DRAG MOVE ──────────────────────────────────────
  _updateDrag(e) {
    // Schedule position update (coalesced via rAF)
    this._pendingPosition = { x: e.clientX, y: e.clientY };

    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._positionGhost(this._pendingPosition.x, this._pendingPosition.y);
        this._rafId = null;
      });
    }

    // Check if cursor is over the canvas
    const canvasEl = this._dagCanvas.getCanvasElement();
    const canvasRect = canvasEl.getBoundingClientRect();
    const isOver = (
      e.clientX >= canvasRect.left &&
      e.clientX <= canvasRect.right &&
      e.clientY >= canvasRect.top &&
      e.clientY <= canvasRect.bottom
    );

    if (isOver !== this._state.isOverDropZone) {
      this._state.isOverDropZone = isOver;
      this._ghostElement.classList.toggle('is-over-dropzone', isOver);
      this._ghostElement.classList.toggle('is-invalid', !isOver);

      if (isOver) {
        this._safeEmit('canvas:drop-zone-enter', {});
      } else {
        this._safeEmit('canvas:drop-zone-leave', {});
      }
    }

    // Notify canvas of cursor position (for drop indicator)
    this._safeEmit('palette:drag-move', {
      nodeTypeId: this._dragPayload.nodeTypeId,
      viewportPosition: { x: e.clientX, y: e.clientY },
    });
  }

  // ─── PHASE 5: MOUSEUP (DROP OR CANCEL) ───────────────────────
  _onPointerUp = (e) => {
    if (!this._dragPayload) return;

    if (this._state.phase === 'dragging') {
      if (this._state.isOverDropZone) {
        // ★ SUCCESSFUL DROP
        this._completeDrop(e);
      } else {
        // ★ CANCELLED (released outside canvas)
        this._cancelDrag('released-outside');
      }
    } else {
      // Never exceeded dead zone — this was a click, not a drag
      // Check for double-click
      this._handlePossibleDoubleClick(e);
    }

    this._cleanupDragState();
  };

  // ─── PHASE 6: SUCCESSFUL DROP ────────────────────────────────
  _completeDrop(e) {
    const nodeType = this._getNodeType(this._dragPayload.nodeTypeId);

    // 1. Convert viewport → canvas coordinates
    const canvasPos = this._safeScreenToCanvas(e.clientX, e.clientY);

    // 2. Animate ghost → shrink into drop position
    this._ghostElement.classList.add('is-dropping');

    // 3. Wait for animation, then remove ghost
    setTimeout(() => {
      if (this._ghostElement) this._ghostElement.remove();
      this._ghostElement = null;
    }, 150);

    // 4. Un-dim source card
    this._dragPayload.sourceElement.classList.remove('is-drag-source');
    this._dragPayload.sourceElement.setAttribute('aria-grabbed', 'false');

    // 5. Restore cursor
    document.body.style.cursor = '';

    // 6. Emit drop event → DagCanvas creates the node
    this._safeEmit('palette:drop', {
      nodeTypeId: this._dragPayload.nodeTypeId,
      canvasPosition: canvasPos,
    });

    // 7. Announce
    this._announce(`${nodeType.displayName} placed on canvas.`);
  }

  // ─── PHASE 7: CANCEL DRAG ───────────────────────────────────
  _cancelDrag(reason) {
    const nodeType = this._getNodeType(this._dragPayload.nodeTypeId);

    // 1. Animate ghost → fade out (or spring back for Escape)
    if (reason === 'escape') {
      this._ghostElement.classList.add('is-cancelling');
    } else {
      this._ghostElement.classList.add('is-cancelling');
    }

    // 2. Remove ghost after animation
    setTimeout(() => {
      if (this._ghostElement) this._ghostElement.remove();
      this._ghostElement = null;
    }, 100);

    // 3. Un-dim source card
    this._dragPayload.sourceElement.classList.remove('is-drag-source');
    this._dragPayload.sourceElement.setAttribute('aria-grabbed', 'false');

    // 4. Restore cursor
    document.body.style.cursor = '';

    // 5. Emit cancelled event
    this._safeEmit('palette:drag-end', {
      nodeTypeId: this._dragPayload.nodeTypeId,
      cancelled: true,
    });

    // 6. Announce
    this._announce(reason === 'escape' ? 'Drag cancelled.' : 'Drop cancelled — released outside canvas.');
  }

  // ─── GHOST ELEMENT CREATION ──────────────────────────────────
  _createGhostElement(nodeType) {
    const ghost = document.createElement('div');
    ghost.className = 'node-palette__ghost';
    ghost.setAttribute('role', 'presentation');
    ghost.setAttribute('aria-hidden', 'true');

    ghost.innerHTML = `
      <div class="node-palette__ghost-icon ${nodeType.cssClass}">${nodeType.iconSymbol}</div>
      <div class="node-palette__ghost-name">${nodeType.displayName}</div>
    `;

    return ghost;
  }

  // ─── GHOST POSITIONING ───────────────────────────────────────
  _positionGhost(clientX, clientY) {
    if (!this._ghostElement) return;

    const x = clientX - this._dragPayload.cursorOffset.x;
    const y = clientY - this._dragPayload.cursorOffset.y;

    // Use transform for GPU compositing (not left/top)
    const scale = this._state.isOverDropZone ? 1.05 : 1.02;
    const rotation = this._state.isOverDropZone ? 0 : -1;
    this._ghostElement.style.transform =
      `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`;
  }
}
```

### 10.3 Double-Click vs Drag Disambiguation

The palette card must distinguish between single clicks (no action), double-clicks (quick-add), and drags (start drag). The events overlap in time.

```javascript
/**
 * Double-click detection strategy:
 *
 * - On pointerdown: record time + position
 * - On pointerup (within dead zone): check if this is a second click
 *   within 300ms of the first click
 *   - YES → double-click → quick-add
 *   - NO → record as first click, start 300ms timer
 * - On pointermove past dead zone: this is a drag, cancel click tracking
 */
class ClickTracker {
  constructor() {
    this._lastClickTime = 0;
    this._lastClickType = null;
    this.DOUBLE_CLICK_THRESHOLD = 300; // ms
  }

  onPointerUp(nodeTypeId, e) {
    const now = performance.now();
    const elapsed = now - this._lastClickTime;

    if (elapsed < this.DOUBLE_CLICK_THRESHOLD && this._lastClickType === nodeTypeId) {
      // Double-click detected
      this._lastClickTime = 0;
      this._lastClickType = null;
      return 'double-click';
    }

    // Record as first click
    this._lastClickTime = now;
    this._lastClickType = nodeTypeId;
    return 'single-click';
  }

  cancelTracking() {
    this._lastClickTime = 0;
    this._lastClickType = null;
  }
}
```

### 10.4 Command Palette Implementation

```javascript
class CommandPalette {
  constructor(palette, eventBus) {
    this._palette = palette;
    this._eventBus = eventBus;
    this._element = null;
    this._inputEl = null;
    this._query = '';
    this._selectedIndex = 0;
    this._results = [...NODE_TYPES];
  }

  open(anchorPosition) {
    // 1. Create popup DOM
    this._element = document.createElement('div');
    this._element.className = 'node-palette__command-palette';
    this._element.setAttribute('role', 'listbox');
    this._element.setAttribute('aria-label', 'Add node — type to filter');

    // 2. Position at cursor or viewport center
    const { x, y } = anchorPosition || this._getViewportCenter();
    this._element.style.left = `${Math.min(x, window.innerWidth - 300)}px`;
    this._element.style.top = `${Math.min(y, window.innerHeight - 200)}px`;

    // 3. Render input + options
    this._render();
    document.body.appendChild(this._element);

    // 4. Focus input
    this._inputEl.focus();

    // 5. Listen for outside clicks
    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', this._onOutsideClick);
    });
  }

  close() {
    if (this._element) {
      this._element.remove();
      this._element = null;
    }
    document.removeEventListener('pointerdown', this._onOutsideClick);
  }

  _onInput(e) {
    this._query = e.target.value;
    this._results = filterNodeTypes(this._query, NODE_TYPES);
    this._selectedIndex = Math.min(this._selectedIndex, Math.max(0, this._results.length - 1));
    this._renderOptions();
  }

  _onKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._selectedIndex = (this._selectedIndex + 1) % this._results.length;
        this._renderOptions();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._selectedIndex = (this._selectedIndex - 1 + this._results.length) % this._results.length;
        this._renderOptions();
        break;
      case 'Enter':
        e.preventDefault();
        if (this._results.length > 0) {
          const selected = this._results[this._selectedIndex];
          this._eventBus.emit('palette:command-select', { nodeTypeId: selected.id });
          this.close();
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
      case 'Backspace':
        if (this._query === '') {
          this.close();
        }
        break;
    }
  }

  _onOutsideClick = (e) => {
    if (this._element && !this._element.contains(e.target)) {
      this.close();
    }
  };
}
```

### 10.5 Coordinate System: Screen → Canvas

When the user drops a node, the viewport (screen) coordinates must be converted to canvas coordinates (accounting for zoom and pan).

```javascript
/**
 * Convert viewport coordinates to canvas coordinates.
 *
 * The canvas uses CSS transforms for zoom/pan:
 *   transform: scale(zoom) translate(panX, panY)
 *
 * Inverse transform:
 *   canvasX = (viewportX - canvasRect.left - panX * zoom) / zoom
 *   canvasY = (viewportY - canvasRect.top  - panY * zoom) / zoom
 *
 * This is DagCanvas's responsibility — NodePalette calls it via:
 *   dagCanvas.screenToCanvas(viewportX, viewportY) → { x, y }
 */
```

**Important:** NodePalette does NOT do coordinate conversion itself. It passes viewport coordinates to DagCanvas via the `palette:drop` event, and DagCanvas handles the conversion using its current zoom/pan state.

### 10.6 Integration Points

| Component | Integration | Direction |
|-----------|-------------|-----------|
| **DagCanvas (C04)** | Drop handling, coordinate conversion, drop zone overlay, node creation | Palette → Canvas (events) |
| **DagNode (C06)** | After drop, canvas creates a DagNode and opens its naming popover | Canvas → Node (internal) |
| **UndoRedoManager (C14)** | Node creation from palette drop is an undoable action | Canvas → UndoRedo |
| **InfraWizardDialog (C01)** | Page navigation cancels active drags; wizard state determines palette enabled/disabled | Dialog → Palette (events) |
| **AutoLayoutEngine (C13)** | Auto Arrange button is in the palette toolbar area (below node cards) | User → Layout engine |

### 10.7 File Structure

```
src/
  features/
    infra-wizard/
      components/
        node-palette.js          ← Main class (NodePalette)
        node-palette.css         ← All styles (inlined at build time)
        command-palette.js       ← CommandPalette sub-component
        drag-tracker.js          ← DragTracker (rAF batching, dead zone)
        click-tracker.js         ← ClickTracker (double-click detection)
      constants/
        node-types.js            ← NODE_TYPES array definition
```

### 10.8 CSS Architecture

All NodePalette CSS uses the BEM-like naming convention established in the EDOG design system:

```
.node-palette                         ← Block
.node-palette__header                 ← Element
.node-palette__card                   ← Element
.node-palette__card.is-drag-source    ← State modifier
.node-palette__card.is-disabled       ← State modifier
.node-palette__ghost                  ← Block (separate, appended to body)
.node-palette__ghost.is-over-dropzone ← State modifier
.node-palette__command-palette        ← Block (separate, appended to body)
```

### 10.9 Testing Strategy

| Test Category | Count | Examples |
|---------------|-------|---------|
| **Unit tests** | 12 | Node type filtering, dead zone calculation, click vs double-click disambiguation, state transitions |
| **Integration tests** | 8 | Drag start → ghost created, drop on canvas → event emitted with correct coordinates, Escape → drag cancelled |
| **Visual regression** | 6 | Card states (default, hover, active, focus, disabled, drag-source), ghost element appearance, collapsed state |
| **Accessibility** | 5 | Keyboard navigation order, ARIA attributes, screen reader announcements, focus management in command palette |
| **Edge cases** | 4 | Max nodes disable/re-enable, page navigation during drag, tab visibility change, rapid sequential drags |

### 10.10 Dependencies

| Dependency | Type | Purpose |
|-----------|------|---------|
| **EventBus** (internal) | Runtime | Inter-component communication |
| **DagCanvas** (C04) | Runtime | Coordinate conversion, drop zone management |
| **Design tokens** (CSS) | Build-time | Colors, spacing, typography, shadows from `:root` variables |
| **No external libraries** | — | Vanilla JS per ADR-002. Pointer events are native. |

### 10.11 Open Questions

| # | Question | Impact | Proposed Answer |
|---|----------|--------|----------------|
| Q1 | Should collapsed palette icons be draggable? | UX | **No** — collapsed icons click to expand. Drag requires spatial context (seeing the full card). |
| Q2 | Should the command palette position at cursor or at center of canvas? | UX | **Cursor position** if the `/` key was pressed while mouse was over the canvas, otherwise **center of canvas viewport**. |
| Q3 | Should there be a "first-time" tutorial tooltip on the palette? | UX | **Yes** — show a one-time tooltip "Drag a node type to the canvas to begin" on first visit. Dismisses on first drag or click. Persist via `localStorage`. |
| Q4 | Should quick-add (double-click) auto-arrange the new node? | UX | **No** — place at computed grid position, do not trigger auto-layout. User can manually arrange or click Auto Arrange. |
| Q5 | Should palette show node type counts? (e.g., "SQL MLV (3)") | UX | **Stretch goal** — not in V1. The aggregate counter "N / 100" is sufficient. |

---

## Appendix A: Node Type Icon Design

Since we use Unicode symbols (no emoji per project rules), each node type gets a distinct geometric symbol:

| Type | Symbol | Meaning | Visual Distinction |
|------|--------|---------|-------------------|
| **Plain SQL Table** | `◇` (U+25C7, White Diamond) | Open/source — a table is a data source | Outline shape = "open/leaf/source" |
| **SQL MLV** | `◆` (U+25C6, Black Diamond) | Filled/derived — an MLV transforms data | Filled shape = "derived/computed" |
| **PySpark MLV** | `◆` (U+25C6, Black Diamond) | Filled/derived — same semantic as SQL MLV | Same shape, different color (orange vs purple) |

**Color carries meaning:**
- **Blue** (`#2d7ff9`) — Data at rest (tables, storage)
- **Purple** (`#6d5cff` / accent) — SQL transformation
- **Orange** (`#e5940c`) — Code/spark computation

This color mapping is consistent across the palette, canvas nodes, and all badges/labels throughout the wizard.

---

## Appendix B: Cursor States During Drag Lifecycle

| Phase | Cursor | CSS Value |
|-------|--------|-----------|
| Palette card (default) | Open hand | `cursor: grab` |
| Palette card (mousedown) | Closed hand | `cursor: grabbing` |
| Dragging (over palette) | Closed hand | `cursor: grabbing` (on `body`) |
| Dragging (over canvas) | Copy/add | `cursor: copy` |
| Dragging (outside canvas, outside palette) | Not allowed | `cursor: not-allowed` |
| Disabled card | Not allowed | `cursor: not-allowed` |
| Collapse toggle | Pointer | `cursor: pointer` |
| Command palette input | Text | `cursor: text` |
| Command palette option | Pointer | `cursor: pointer` |

---

## Appendix C: Animation Timing Reference

| Animation | Duration | Easing | Trigger |
|-----------|----------|--------|---------|
| Ghost appear | 120ms | `var(--spring)` — `cubic-bezier(0.34, 1.56, 0.64, 1)` | Drag starts (dead zone exceeded) |
| Ghost follow cursor | per-frame | None (transform updates) | `pointermove` via `rAF` |
| Ghost drop (shrink) | 150ms | `var(--ease)` — `cubic-bezier(0.4, 0, 0.2, 1)` | Successful drop on canvas |
| Ghost cancel (fade) | 100ms | `var(--ease-out)` — `cubic-bezier(0, 0, 0.2, 1)` | Drop outside canvas or Escape |
| Card hover border | 80ms | `var(--ease)` | CSS `:hover` |
| Card pressed scale | 80ms | `var(--ease)` | CSS `:active` |
| Card quick-add flash | 200ms | `var(--ease)` | After double-click |
| Sidebar collapse | 200ms | `var(--ease)` | Toggle button click |
| Sidebar expand | 200ms | `var(--ease)` | Toggle button click |
| Command palette appear | 200ms | `var(--spring)` | `/` key |
| Drop zone overlay pulse | 1500ms | `ease-in-out` | CSS animation (infinite) |
| Drop position indicator pulse | 1000ms | `ease-in-out` | CSS animation (infinite) |

---

## Appendix D: Event Flow Diagram

```
NodePalette                    EventBus                    DagCanvas
    │                             │                            │
    │── palette:drag-start ──────→│───────────────────────────→│
    │                             │                            │ Show drop zone overlay
    │── palette:drag-move ───────→│───────────────────────────→│
    │                             │                            │ Update drop indicator
    │                             │                            │
    │                             │←── canvas:drop-zone-enter ─│ (cursor entered canvas)
    │←───────────────────────────│                            │
    │ (update ghost: green)       │                            │
    │                             │                            │
    │── palette:drop ────────────→│───────────────────────────→│
    │                             │                            │ 1. screenToCanvas()
    │                             │                            │ 2. createNode()
    │                             │                            │ 3. selectNode()
    │                             │                            │ 4. openNamingPopover()
    │                             │←── canvas:node-count ──────│
    │←───────────────────────────│                            │
    │ setNodeCount(n+1)           │                            │
    │                             │                            │
```

---

*Spec complete. Ready for implementation at Layer 4 per spec.md §13.*
