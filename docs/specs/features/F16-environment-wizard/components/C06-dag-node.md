# C06 — DagNode: Component Deep Spec

> **Component:** DagNode (C06)
> **Feature:** F16 — New Infra Wizard
> **Owner:** Pixel (JS/CSS) + Vex (code-gen templates)
> **Complexity:** HIGH
> **Depends On:** P0.4 (DAG Builder Research), P0.6 (Canvas Interaction Research)
> **Status:** P1 — Deep Spec Complete
> **Last Updated:** 2025-07-18

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

DagNode is the atomic visual unit on the DAG canvas (Page 3 of the Infra Wizard). Each node represents a single data asset — either a **Plain SQL Table** (data source), a **SQL Materialized Lake View** (SQL-based derived asset), or a **PySpark Materialized Lake View** (PySpark-based derived asset). DagNode owns its own rendering (SVG foreignObject wrapping HTML), connection ports, selection state, drag behavior, popover editor, and code-generation output.

DagNode is the most user-interacted element in the entire wizard. It is the thing users click, drag, connect, rename, retype, re-schema, and delete. Every friction point on the node is a friction point on the entire product.

### 1.2 Component Boundaries

**DagNode owns:**
- Node container element (SVG `<g>` with `<foreignObject>` wrapping HTML content)
- Node visual rendering: rounded rectangle, type icon, name label, type badge, schema badge
- Connection ports: input port (top center), output port (bottom center)
- Port visibility logic (hidden → visible on hover or during connection drag)
- Node selection visual (blue glow ring)
- Node drag behavior (mousedown on body → update position)
- Popover editor (opens on click; contains name field, type dropdown, schema dropdown, delete button)
- Auto-generated name management (`table_1`, `mlv_2`, `spark_3`)
- Schema color indicator (colored badge matching schema tier)
- Node-level validation state (complete/incomplete configuration indicator)
- Code generation output for its own SQL/PySpark cell content

**DagNode does NOT own:**
- Canvas zoom/pan transforms (owned by DagCanvas C04)
- Connection line rendering between nodes (owned by ConnectionManager C07)
- Node placement from palette drag (owned by NodePalette C05)
- Auto-layout positioning (owned by AutoLayoutEngine C13)
- Undo/redo command history (owned by UndoRedoManager C14)
- Code preview panel display (owned by CodePreviewPanel C08)
- Multi-select marquee (owned by DagCanvas C04)

### 1.3 Node Type Summary

| # | Type | Badge Text | Badge Color | Icon | Port Config | Role |
|---|------|-----------|-------------|------|-------------|------|
| 1 | **Plain SQL Table** | `SQL TABLE` | Blue (`oklch(0.62 0.18 250)`) on `oklch(0.95 0.03 250)` bg | `◇` (diamond outline — table grid) | Output only | Root data source; generates `CREATE TABLE` + `INSERT` |
| 2 | **SQL MLV** | `SQL MLV` | Purple (`oklch(0.55 0.22 290)`) on `oklch(0.95 0.04 290)` bg | `◆` (filled diamond — view) | Input + Output | Derived via SQL; generates `CREATE MATERIALIZED LAKE VIEW` |
| 3 | **PySpark MLV** | `PYSPARK` | Orange (`oklch(0.68 0.18 70)`) on `oklch(0.95 0.04 70)` bg | `◆` (filled diamond — spark/code) | Input + Output | Derived via PySpark decorator; generates `@fmlv.materialized_lake_view` |

### 1.4 Critical SQL Rules

These are non-negotiable and must be reflected in every code template:

1. **It is `MATERIALIZED LAKE VIEW`, NOT `MATERIALIZED VIEW`.** This is a Fabric-specific DDL extension. Getting this wrong means the generated code will fail at runtime.
2. **SQL MLV pattern:** `CREATE MATERIALIZED LAKE VIEW {schema}.{name} AS SELECT * FROM {parent_schema}.{parent_name}`
3. **PySpark MLV pattern:** `@fmlv.materialized_lake_view(name="{schema}.{name}")` decorator on a function that returns a DataFrame.
4. **Multiple parents:** When an MLV has multiple parent connections, the SQL uses JOIN (or UNION) syntax referencing ALL parent tables. PySpark reads from multiple parent DataFrames.
5. **Schema prefix:** All table/view references are fully qualified: `{schema}.{name}`, never bare names.
6. **`fmlv` package:** PySpark MLVs require `import fmlv` — the notebook must have a `!pip install fmlv` cell if any PySpark MLV nodes exist.

---

## 2. Data Model

### 2.1 Node Data Object

```typescript
interface DagNodeData {
  /** Unique identifier — UUID v4, generated on creation */
  id: string;

  /** Display name — user-editable, auto-generated on creation.
   *  Naming pattern: {typePrefix}_{sequenceNumber}
   *  - Plain SQL Table: "table_1", "table_2", ...
   *  - SQL MLV: "mlv_1", "mlv_2", ...
   *  - PySpark MLV: "spark_1", "spark_2", ...
   *  Constraints: 1–63 chars, lowercase, [a-z0-9_], must start with letter.
   *  These constraints match Fabric table name rules. */
  name: string;

  /** Node type — determines visual, port config, and code generation */
  type: 'sql-table' | 'sql-mlv' | 'pyspark-mlv';

  /** Schema assignment — from ThemeSchemaPage (Page 2) selections.
   *  'dbo' is always available. Others depend on user's Page 2 choices. */
  schema: 'dbo' | 'bronze' | 'silver' | 'gold';

  /** Canvas position — top-left corner of the node bounding box, in canvas coordinates.
   *  Updated on drag-end. Used by auto-layout. */
  position: { x: number; y: number };

  /** Node dimensions — fixed width, variable height based on content.
   *  Width: 180px (fixed). Height: computed from content (typically 64–80px). */
  size: { width: number; height: number };

  /** Creation timestamp — for topological sort tiebreaking */
  createdAt: number;

  /** Sequence number — used in auto-naming. Monotonically increasing per type. */
  sequenceNumber: number;

  /** Whether the popover editor is currently open */
  popoverOpen: boolean;

  /** Validation state — derived, not stored. Computed from:
   *  - name is non-empty and valid
   *  - schema is assigned
   *  - MLV nodes have at least one parent connection
   *  Plain SQL Tables are always valid (they're sources). */
  readonly isValid: boolean;
}
```

### 2.2 Port Data Model

```typescript
interface PortData {
  /** Port identifier — 'in' or 'out' */
  id: 'in' | 'out';

  /** Port group — determines position and behavior */
  group: 'input' | 'output';

  /** Position relative to node bounding box — computed, not stored.
   *  Input port: (width/2, 0) — top center
   *  Output port: (width/2, height) — bottom center */
  readonly position: { x: number; y: number };

  /** Absolute position on canvas — computed from node position + relative offset.
   *  Used by ConnectionManager for path endpoints. */
  readonly absolutePosition: { x: number; y: number };

  /** Whether port is currently visible.
   *  Ports are hidden by default, shown on:
   *  - Node hover
   *  - Node selected
   *  - Active connection drag (global — all valid ports shown)
   *  - Port itself is hovered (stays visible) */
  visible: boolean;

  /** Whether this port is a valid target for the current connection drag.
   *  Set by ConnectionManager during drag. Affects port visual (glow vs dim). */
  validTarget: boolean;

  /** Whether this port is the currently hovered target during connection drag */
  hoveredTarget: boolean;

  /** Number of connections attached to this port.
   *  Input ports: number of parent connections (0..N)
   *  Output ports: number of child connections (0..N) */
  connectionCount: number;
}
```

### 2.3 Port Configuration by Node Type

| Node Type | Input Port | Output Port | Rationale |
|-----------|-----------|-------------|-----------|
| Plain SQL Table | ✗ None | ✓ Present | Sources have no parents — they generate root data |
| SQL MLV | ✓ Present | ✓ Present | Can be both a child (depends on parents) and a parent (feeds downstream) |
| PySpark MLV | ✓ Present | ✓ Present | Same as SQL MLV — bidirectional participation |

When a node's type changes (e.g., from SQL MLV to Plain SQL Table), its input port is removed and all incoming connections are deleted. This is a destructive operation — the undo manager must capture the removed connections for reversibility.

### 2.4 Schema Colors

| Schema | Text Color | Background Color | CSS Variable (text) | CSS Variable (bg) |
|--------|-----------|-----------------|--------------------|--------------------|
| `dbo` | `oklch(0.45 0.02 260)` | `oklch(0.95 0.01 260)` | `--dbo` (`#5a6070`) | `--dbo-dim` |
| `bronze` | `oklch(0.55 0.14 60)` | `oklch(0.95 0.03 60)` | `--bronze` (`#b87333`) | `--bronze-dim` |
| `silver` | `oklch(0.55 0.03 240)` | `oklch(0.95 0.01 240)` | `--silver` (`#7b8794`) | `--silver-dim` |
| `gold` | `oklch(0.60 0.14 85)` | `oklch(0.95 0.03 85)` | `--gold` (`#c5a038`) | `--gold-dim` |

### 2.5 Auto-Name Generation

Name generation uses a monotonically-increasing sequence counter **per type**, tracked at the DagCanvas (C04) level and passed into DagNode on creation:

```javascript
// DagCanvas maintains these counters:
const _nameCounters = { 'sql-table': 0, 'sql-mlv': 0, 'pyspark-mlv': 0 };

function generateName(type) {
  _nameCounters[type]++;
  const prefixes = {
    'sql-table': 'table',
    'sql-mlv':   'mlv',
    'pyspark-mlv': 'spark'
  };
  return `${prefixes[type]}_${_nameCounters[type]}`;
}
```

**Name validation rules:**
- Length: 1–63 characters
- Character set: `[a-z][a-z0-9_]*` (must start with lowercase letter)
- Reserved words: `null`, `true`, `false`, `select`, `from`, `where`, `create`, `drop`, `table`, `view` (show warning, not hard block)
- Uniqueness: No two nodes on the canvas may share the same `{schema}.{name}` fully qualified name. DagNode validates on rename by querying DagCanvas for conflicts.

### 2.6 Node Serialization (for Template Save/Load)

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "order_summary",
  "type": "sql-mlv",
  "schema": "silver",
  "position": { "x": 140, "y": 200 },
  "sequenceNumber": 1,
  "createdAt": 1721234567890
}
```

Connections are serialized separately by ConnectionManager (C07). The node serialization is intentionally minimal — only properties the user configured, plus position for layout restoration.

---

## 3. API Surface

### 3.1 DagNode Class

```javascript
class DagNode {
  // ─── Construction ─────────────────────────────────────────
  /**
   * @param {object} config
   * @param {string} config.id - UUID
   * @param {string} config.name - Auto-generated or restored name
   * @param {'sql-table'|'sql-mlv'|'pyspark-mlv'} config.type
   * @param {'dbo'|'bronze'|'silver'|'gold'} config.schema
   * @param {{x: number, y: number}} config.position
   * @param {number} config.sequenceNumber
   * @param {string[]} config.availableSchemas - ['dbo', 'bronze', ...]
   * @param {SVGGElement} config.parentGroup - SVG <g> to append into
   * @param {DagCanvas} config.canvas - Parent canvas reference
   */
  constructor(config) {}

  // ─── Identity & Data ──────────────────────────────────────
  /** @returns {string} UUID */
  get id() {}

  /** @returns {string} Current display name */
  get name() {}

  /** @param {string} newName - Validated name */
  set name(newName) {}

  /** @returns {'sql-table'|'sql-mlv'|'pyspark-mlv'} */
  get type() {}

  /** @param {'sql-table'|'sql-mlv'|'pyspark-mlv'} newType
   *  Side effects: updates ports, badge, icon, may remove input connections */
  set type(newType) {}

  /** @returns {'dbo'|'bronze'|'silver'|'gold'} */
  get schema() {}

  /** @param {'dbo'|'bronze'|'silver'|'gold'} newSchema */
  set schema(newSchema) {}

  /** @returns {{x: number, y: number}} */
  get position() {}

  /** @param {{x: number, y: number}} pos */
  set position(pos) {}

  /** @returns {{width: number, height: number}} */
  get size() {}

  /** @returns {boolean} True if node config is complete and valid */
  get isValid() {}

  /** @returns {DagNodeData} Full serializable snapshot */
  toJSON() {}

  // ─── Port Access ──────────────────────────────────────────
  /** @returns {PortData|null} Input port data, or null for Plain SQL Tables */
  get inputPort() {}

  /** @returns {PortData} Output port data (always present) */
  get outputPort() {}

  /**
   * Get the absolute canvas position of a port center.
   * Used by ConnectionManager for path endpoint coordinates.
   * @param {'in'|'out'} portId
   * @returns {{x: number, y: number}} Absolute canvas position
   */
  getPortPosition(portId) {}

  /**
   * Check if a point (in canvas coords) is within a port's hit area.
   * @param {number} x - Canvas X
   * @param {number} y - Canvas Y
   * @returns {{hit: boolean, portId: 'in'|'out'|null}}
   */
  hitTestPort(x, y) {}

  // ─── Visual State ─────────────────────────────────────────
  /** @param {boolean} selected */
  setSelected(selected) {}

  /** @returns {boolean} */
  get isSelected() {}

  /** Show all ports (called during connection drag mode) */
  showPorts() {}

  /** Hide ports (called when connection drag ends, if node not hovered/selected) */
  hidePorts() {}

  /**
   * Mark a port as a valid/invalid target during connection drag.
   * @param {'in'|'out'} portId
   * @param {boolean} valid
   */
  setPortValidity(portId, valid) {}

  /**
   * Set hover state on a port (during connection drag hover).
   * @param {'in'|'out'} portId
   * @param {boolean} hovered
   */
  setPortHovered(portId, hovered) {}

  /** Set the node to "dragging" visual state */
  setDragging(dragging) {}

  // ─── Popover ──────────────────────────────────────────────
  /** Open the popover editor below the node */
  openPopover() {}

  /** Close the popover editor */
  closePopover() {}

  /** @returns {boolean} */
  get isPopoverOpen() {}

  // ─── Code Generation ──────────────────────────────────────
  /**
   * Generate the notebook cell content for this node.
   * @param {DagNodeData[]} parentNodes - All parent node data (resolved via connections)
   * @param {string} theme - Current data theme name (e.g., 'e-commerce')
   * @returns {NotebookCell}
   */
  generateCode(parentNodes, theme) {}

  // ─── Lifecycle ────────────────────────────────────────────
  /** Remove the node from DOM and clean up event listeners */
  destroy() {}

  /** Re-render the node (after property changes) */
  render() {}
}
```

### 3.2 Events Emitted

DagNode emits events through a simple EventTarget (or custom event bus) pattern. All events bubble up to DagCanvas.

| Event | Payload | When |
|-------|---------|------|
| `node:select` | `{ nodeId, additive }` | User clicks node. `additive=true` when Ctrl held. |
| `node:deselect` | `{ nodeId }` | Node deselected (click elsewhere, or Escape) |
| `node:dragstart` | `{ nodeId, position }` | Mousedown on node body (not port), drag threshold exceeded |
| `node:dragmove` | `{ nodeId, position, delta }` | During drag — position is the new top-left |
| `node:dragend` | `{ nodeId, oldPosition, newPosition }` | Mouseup after drag — for undo command creation |
| `node:rename` | `{ nodeId, oldName, newName }` | Name changed via popover |
| `node:typechange` | `{ nodeId, oldType, newType, removedConnections }` | Type changed via popover. `removedConnections` populated if input port was removed. |
| `node:schemachange` | `{ nodeId, oldSchema, newSchema }` | Schema changed via popover |
| `node:delete` | `{ nodeId, confirmed }` | Delete requested. `confirmed=true` after confirmation dialog. |
| `node:popoveropen` | `{ nodeId }` | Popover editor opened |
| `node:popoverclose` | `{ nodeId }` | Popover editor closed |
| `port:dragstart` | `{ nodeId, portId, position }` | User starts dragging from a port — initiates connection drawing |
| `port:dragend` | `{ nodeId, portId }` | Connection drag ended (successfully or cancelled) |
| `port:hover` | `{ nodeId, portId }` | Mouse entered port hit area during connection drag |
| `port:leave` | `{ nodeId, portId }` | Mouse left port hit area during connection drag |

### 3.3 Events Consumed

| Event | Source | Handler |
|-------|--------|---------|
| `canvas:connectiondragstart` | DagCanvas/ConnectionManager | Show all ports, enter "connection mode" |
| `canvas:connectiondragend` | DagCanvas/ConnectionManager | Hide ports (if not hovered/selected), exit "connection mode" |
| `canvas:deselectall` | DagCanvas | `setSelected(false)`, close popover |
| `canvas:schemaschanged` | DagCanvas (from ThemeSchemaPage) | Update available schemas in popover dropdown |
| `canvas:zoomchanged` | DagCanvas | May adjust port hit-test radius for current zoom level |

### 3.4 NotebookCell Return Type

```typescript
interface NotebookCell {
  /** Cell type for the Fabric notebook API */
  cellType: 'sql' | 'code';

  /** Raw source content for the cell */
  source: string;

  /** Display order — determined by topological sort, not by DagNode itself */
  sortOrder?: number;

  /** Metadata for debugging */
  metadata: {
    nodeId: string;
    nodeName: string;
    nodeType: 'sql-table' | 'sql-mlv' | 'pyspark-mlv';
    schema: string;
  };
}
```

---

## 4. State Machine

### 4.1 Node States

```
                     ┌──────────────────────────────────────────────┐
                     │                                              │
    ┌────────┐  click│on node    ┌──────────┐   click on     ┌─────▼─────┐
    │  Idle  │──────────────────►│ Selected │──────────────►│  Editing  │
    │        │◄──────────────────│          │◄──────────────│ (Popover) │
    └───┬────┘  click elsewhere  └────┬─────┘   Esc/click   └─────┬─────┘
        │       or Esc                │         outside            │
        │                             │                            │
        │  mousedown on body          │  mousedown on body         │
        │  (drag threshold)           │  (drag threshold)          │
        ▼                             ▼                            │
    ┌────────┐                   ┌──────────┐                     │
    │Dragging│                   │ Selected │──── type change ────┘
    │        │                   │+Dragging │     triggers re-render
    └───┬────┘                   └────┬─────┘
        │  mouseup                    │  mouseup
        │                             │
        ▼                             ▼
    ┌────────┐                   ┌──────────┐
    │  Idle  │                   │ Selected │
    └────────┘                   └──────────┘
```

### 4.2 State Definitions

| State | Visual | Ports | Popover | Draggable | Description |
|-------|--------|-------|---------|-----------|-------------|
| **Idle** | Default border, no glow | Hidden (shown on hover) | Closed | Yes (body mousedown) | Node is at rest, not interacted with |
| **Hovered** | Border brightens, subtle shadow lift, ports fade in | Visible (fade-in, 150ms) | Closed | Yes | Mouse is over the node body |
| **Selected** | Accent border + glow ring (`0 0 0 3px var(--accent-glow)`), subtle pulse | Visible (persistent) | Closed or Open | Yes | Node is clicked/selected, waiting for further action |
| **Editing** | Same as Selected | Visible | **Open** | No (prevent accidental drag while editing) | Popover is open — user is editing name/type/schema |
| **Dragging** | Slight opacity (0.92), elevated shadow, cursor: `grabbing` | Hidden (during drag) | Closed (auto-close if was open) | In progress | User is moving the node on the canvas |
| **ConnectionTarget** | Normal + port glow (valid) or port dim (invalid) | Visible + validity styling | Closed | No | Another node's port is being dragged — this node shows port targets |
| **Invalid** | Warning indicator (▲) badge on top-right corner | Normal | Normal | Yes | Node configuration is incomplete (e.g., MLV with no parents) |
| **Deleting** | Fade-out animation (200ms) | Hidden | Closed | No | Delete confirmed — node is animating out |

### 4.3 Port States

```
                ┌──────────┐
                │  Hidden  │  ← Default: ports not visible
                └────┬─────┘
                     │  node hovered OR node selected
                     │  OR global connection drag active
                     ▼
                ┌──────────┐
                │ Visible  │  ← Port shown, neutral styling
                │ (Idle)   │
                └────┬─────┘
                     │  connection drag starts from another node
                     ▼
            ┌────────┴────────┐
            │                 │
       valid target?     invalid target?
            │                 │
            ▼                 ▼
    ┌───────────┐     ┌─────────────┐
    │  Valid     │     │  Invalid    │
    │  Target   │     │  Target     │
    │ (glow)    │     │ (dim/muted) │
    └─────┬─────┘     └─────────────┘
          │  cursor enters port hit area
          ▼
    ┌───────────┐
    │  Hovered  │  ← Port scales up (1.3×), bright glow
    │  Target   │
    └─────┬─────┘
          │  mouseup → connection created
          │  OR cursor leaves → back to Valid Target
          ▼
    ┌───────────┐
    │ Connected │  ← Connection accepted, port returns to Visible
    └───────────┘
```

### 4.4 Popover States

```
    ┌────────┐   click on selected node    ┌──────────┐
    │ Closed │────────────────────────────►│   Open   │
    │        │◄────────────────────────────│          │
    └────────┘   Esc / click-outside /     └────┬─────┘
                 Delete pressed                  │
                                                 │  user interacts
                                                 ▼
                                           ┌──────────┐
                                           │ Editing  │
                                           │ Field    │
                                           └──────────┘
```

**Popover open trigger:** Click on an already-selected node, OR double-click on any node (selects + opens in one action).

**Popover close triggers:**
1. Click outside the popover AND outside the node
2. Press `Escape`
3. Select a different node
4. Start dragging any node
5. Delete the node
6. Canvas zoom/pan starts

### 4.5 Composite State Table

| Scenario | Node Visual | Ports | Popover | Cursor |
|----------|------------|-------|---------|--------|
| Mouse nowhere near node | Idle | Hidden | Closed | default |
| Mouse over node body | Hovered | Visible (fade-in) | Closed | pointer |
| Mouse over port (no drag active) | Hovered | Visible, hovered port highlighted | Closed | pointer |
| Click on node (not already selected) | Selected (glow ring) | Visible | Closed | pointer |
| Click on already-selected node | Selected | Visible | Opens | pointer |
| Double-click on any node | Selected | Visible | Opens | pointer |
| Ctrl+click on node | Toggle selected (multi-select) | Visible if selected | Closed | pointer |
| Mousedown on body + drag | Dragging | Hidden | Closes | grabbing |
| Another node dragging a connection | ConnectionTarget | Visible + valid/invalid styling | Closed | default |
| Connection drag hovers over valid port | ConnectionTarget | Hovered port scales up + glow | Closed | copy |
| Connection drag hovers over invalid port | ConnectionTarget | Port stays dim, no scale | Closed | not-allowed |
| Node has no parents (MLV type) | Invalid badge (▲) | Normal behavior | Normal | pointer |
| Delete confirmed | Fade-out (200ms, opacity 0, scale 0.95) | Hidden | Closed | default |

---

## 5. Scenarios

### 5.1 Node Creation

**Trigger:** User drags a node type from NodePalette (C05) onto the canvas, or clicks a quick-add toolbar button, or right-click context menu.

**Flow:**
1. DagCanvas receives the drop event with `{ type, position }`.
2. DagCanvas generates a unique ID (`crypto.randomUUID()`) and auto-name (`generateName(type)`).
3. DagCanvas determines default schema: `'dbo'` (always available as default).
4. DagCanvas creates a new `DagNode` instance:
   ```javascript
   const node = new DagNode({
     id: crypto.randomUUID(),
     name: generateName(type),
     type: type,
     schema: 'dbo',
     position: dropPosition,
     sequenceNumber: _nameCounters[type],
     availableSchemas: getAvailableSchemas(),
     parentGroup: canvasSvgGroup,
     canvas: this
   });
   ```
5. DagNode renders itself into the SVG group.
6. DagNode is automatically selected (blue glow).
7. The popover does NOT auto-open on creation (user may want to place several nodes before editing).
8. DagCanvas pushes an `AddNodeCommand` to the undo stack.

### 5.2 Node Selection (Single)

**Trigger:** User clicks on a node.

**Flow:**
1. `pointerdown` on node body (not port).
2. DagNode emits `node:select` with `{ nodeId, additive: false }`.
3. DagCanvas receives event → deselects all other nodes → sets this node as selected.
4. Previous selected node: border reverts, glow removed, popover closed.
5. This node: accent border, glow ring animates in (150ms spring ease).
6. Ports fade in if not already visible (150ms).
7. If this node was already selected → toggle popover open.

### 5.3 Multi-Select

**Trigger:** User Ctrl+clicks on nodes.

**Flow:**
1. `pointerdown` with `event.ctrlKey === true` or `event.metaKey === true`.
2. DagNode emits `node:select` with `{ nodeId, additive: true }`.
3. DagCanvas adds this node to the selection set (does NOT deselect others).
4. All selected nodes show glow ring.
5. Popover is NOT opened during multi-select (ambiguous which node to edit).
6. Multi-selected nodes can be dragged together, deleted together, or schema-changed together.

### 5.4 Node Dragging

**Trigger:** User mousedown on node body and moves mouse beyond drag threshold (4px).

**Preconditions:**
- Mousedown target is the node body, NOT a port and NOT the popover.
- Drag threshold: 4px of mouse movement after mousedown before drag engages (prevents accidental drag on click).

**Flow:**
1. `pointerdown` on node body → record start position, set `_potentialDrag = true`.
2. `pointermove` → calculate distance from start. If < 4px, do nothing.
3. Distance ≥ 4px → enter drag mode:
   a. Close popover if open.
   b. Set `dragging` visual state (opacity 0.92, elevated shadow).
   c. Hide ports.
   d. Set cursor to `grabbing`.
   e. Emit `node:dragstart`.
4. Subsequent `pointermove` → update node position:
   ```javascript
   const dx = event.clientX - lastPointerX;
   const dy = event.clientY - lastPointerY;
   const scale = canvas.getZoomScale();
   this.position = {
     x: this.position.x + dx / scale,
     y: this.position.y + dy / scale
   };
   ```
   Emit `node:dragmove` (ConnectionManager listens to re-route connected edges).
5. `pointerup` → end drag:
   a. Restore normal visual state.
   b. Show ports (if still hovered or selected).
   c. Emit `node:dragend` with old and new positions.
   d. DagCanvas creates `MoveNodeCommand(nodeId, oldPos, newPos)` for undo stack.

**Multi-node drag:** If multiple nodes are selected and one is dragged, ALL selected nodes move by the same delta. Each emits `node:dragmove` independently so ConnectionManager updates all affected edges.

### 5.5 Popover Editing — Name

**Trigger:** User clicks the name field in the popover.

**Flow:**
1. Popover opens with current name in a text input, pre-selected.
2. User types new name.
3. On each keystroke: validate against naming rules (live feedback).
4. Invalid characters → input border turns red, error message below: "Only lowercase letters, numbers, and underscores allowed."
5. Duplicate `{schema}.{name}` → input border turns warning orange, message: "Name 'silver.mlv_1' already exists."
6. On `Enter` or blur (focus leaves input):
   a. If valid and changed → emit `node:rename` with old and new names.
   b. Node label in SVG updates immediately.
   c. DagCanvas creates `EditNodePropertyCommand(nodeId, 'name', oldName, newName)`.
7. On `Escape` → revert to original name, close popover.

### 5.6 Popover Editing — Type Change

**Trigger:** User selects a different type from the type dropdown in the popover.

**Flow:**
1. Dropdown shows all 3 types with icons. Current type is highlighted.
2. User selects a new type.
3. DagNode checks for destructive side effects:
   - **Changing TO `sql-table` (from any MLV):** The node will lose its input port. All incoming connections will be removed.
   - **Changing FROM `sql-table` (to any MLV):** An input port will be added. No connections lost.
   - **Changing between MLV types:** No port changes. Only code generation changes.
4. If connections will be removed → show inline confirmation in the popover:
   > "Changing to SQL Table will remove 2 parent connections. Continue?"
   > `[Cancel]` `[Change Type]`
5. On confirm:
   a. Update node type.
   b. Re-render node visual (icon, badge color, badge text).
   c. Add/remove input port as needed.
   d. Remove invalidated connections (if any).
   e. Emit `node:typechange` with `{ oldType, newType, removedConnections }`.
   f. DagCanvas creates compound undo command: `BatchCommand([EditTypeCommand, ...RemoveConnectionCommands])`.

### 5.7 Popover Editing — Schema Change

**Trigger:** User selects a different schema from the schema dropdown.

**Flow:**
1. Dropdown shows available schemas from ThemeSchemaPage selections. `dbo` is always first.
2. User selects a new schema.
3. Schema badge updates color and text immediately.
4. DagNode checks for `{schema}.{name}` uniqueness. If conflict → show warning and prevent change.
5. Emit `node:schemachange` with old and new schema.
6. DagCanvas creates `EditNodePropertyCommand(nodeId, 'schema', oldSchema, newSchema)`.

### 5.8 Node Deletion

**Trigger:** User clicks "Delete Node" in the popover, or presses `Delete`/`Backspace` with node selected.

**Flow:**
1. If node has any connections (parents or children):
   - Show confirmation in popover or as a toast:
     > "Delete 'order_summary'? This will also remove 3 connections."
     > `[Cancel]` `[Delete]`
2. If node has no connections → delete immediately (no confirmation for orphan nodes).
3. On confirmed delete:
   a. Emit `node:delete` with `{ confirmed: true }`.
   b. ConnectionManager removes all edges connected to this node.
   c. DagNode plays fade-out animation (200ms, opacity → 0, scale → 0.95).
   d. After animation → DagNode.destroy() removes DOM elements and event listeners.
   e. DagCanvas creates `RemoveNodeCommand(nodeData, removedConnections)` for undo.
4. Multi-select delete: If multiple nodes selected and Delete pressed → confirmation shows total:
   > "Delete 3 nodes and 5 connections?"

### 5.9 Connection Initiation from Port

**Trigger:** User mousedown on a port circle.

**Flow:**
1. `pointerdown` on port → DagNode emits `port:dragstart` with `{ nodeId, portId, position }`.
2. DagCanvas/ConnectionManager enters connection-drawing mode.
3. ALL nodes receive `canvas:connectiondragstart` → show their ports with validity styling:
   - This node's own input port (if dragging from output): marked invalid (no self-connections).
   - Other nodes' input ports with no existing connection from this source: marked valid.
   - Other nodes' input ports where connection would create cycle: marked invalid.
   - Nodes of type `sql-table`: their (nonexistent) input ports are naturally excluded.
4. User drags the connection wire across the canvas.
5. As the wire passes over valid ports → `port:hover` emitted → port scales up, glows.
6. Wire released on valid port → connection created.
7. Wire released on empty space → connection cancelled, all ports return to normal.

### 5.10 Code Generation — Plain SQL Table

**Input:** Node data + theme.

**Output:**
```sql
%%sql
CREATE TABLE IF NOT EXISTS {schema}.{name} (
    id INT,
    name STRING,
    value DECIMAL(10,2),
    created_at TIMESTAMP
);
INSERT INTO {schema}.{name} VALUES
    (1, 'sample_1', 100.00, '2024-01-01T00:00:00'),
    (2, 'sample_2', 200.00, '2024-01-02T00:00:00'),
    (3, 'sample_3', 150.00, '2024-01-03T00:00:00'),
    (4, 'sample_4', 175.00, '2024-01-04T00:00:00'),
    (5, 'sample_5', 225.00, '2024-01-05T00:00:00'),
    (6, 'sample_6', 130.00, '2024-01-06T00:00:00'),
    (7, 'sample_7', 310.00, '2024-01-07T00:00:00'),
    (8, 'sample_8', 90.00, '2024-01-08T00:00:00'),
    (9, 'sample_9', 265.00, '2024-01-09T00:00:00'),
    (10, 'sample_10', 180.00, '2024-01-10T00:00:00');
```

**Template logic:**
- Column names and types are theme-dependent (see §10.5 for theme column mapping).
- INSERT VALUES are theme-dependent sample data (10 rows always).
- Schema is fully qualified: `{schema}.{name}`.

### 5.11 Code Generation — SQL MLV

**Input:** Node data + parent nodes + theme.

**Single parent output:**
```sql
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{name} AS
SELECT * FROM {parent_schema}.{parent_name}
```

**Multiple parents output (JOIN pattern):**
```sql
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{name} AS
SELECT
    t1.*,
    t2.*
FROM {parent1_schema}.{parent1_name} t1
JOIN {parent2_schema}.{parent2_name} t2
    ON t1.id = t2.id
```

**Multiple parents output (UNION pattern — when parents share the same schema structure):**
```sql
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{name} AS
SELECT * FROM {parent1_schema}.{parent1_name}
UNION ALL
SELECT * FROM {parent2_schema}.{parent2_name}
```

**Template rules:**
- Default pattern for 2+ parents: JOIN on `id` column (safe assumption since all generated tables have an `id` column).
- Column selection: `SELECT *` for simplicity in auto-generated code.
- **CRITICAL:** The DDL keyword is `MATERIALIZED LAKE VIEW`, not `MATERIALIZED VIEW`.
- Parent references use each parent's own schema: `{parent_schema}.{parent_name}` (parents may be in different schemas).

### 5.12 Code Generation — PySpark MLV

**Input:** Node data + parent nodes + theme.

**Single parent output:**
```python
import fmlv
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DecimalType, TimestampType
from datetime import datetime

@fmlv.materialized_lake_view(name="{schema}.{name}")
def {name}():
    df = spark.sql("SELECT * FROM {parent_schema}.{parent_name}")
    return df
```

**Multiple parents output:**
```python
import fmlv
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DecimalType, TimestampType
from datetime import datetime

@fmlv.materialized_lake_view(name="{schema}.{name}")
def {name}():
    df1 = spark.sql("SELECT * FROM {parent1_schema}.{parent1_name}")
    df2 = spark.sql("SELECT * FROM {parent2_schema}.{parent2_name}")
    df = df1.join(df2, on="id", how="inner")
    return df
```

**No-parent PySpark MLV (standalone — generates own sample data):**
```python
import fmlv
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DecimalType, TimestampType
from datetime import datetime

@fmlv.materialized_lake_view(name="{schema}.{name}")
def {name}():
    schema = StructType([
        StructField("id", IntegerType(), False),
        StructField("name", StringType(), True),
        StructField("value", DecimalType(10,2), True),
        StructField("created_at", TimestampType(), True),
    ])
    data = [
        (1, "sample_1", 100.00, datetime(2024, 1, 1)),
        (2, "sample_2", 200.00, datetime(2024, 1, 2)),
        (3, "sample_3", 150.00, datetime(2024, 1, 3)),
        (4, "sample_4", 175.00, datetime(2024, 1, 4)),
        (5, "sample_5", 225.00, datetime(2024, 1, 5)),
        (6, "sample_6", 130.00, datetime(2024, 1, 6)),
        (7, "sample_7", 310.00, datetime(2024, 1, 7)),
        (8, "sample_8", 90.00, datetime(2024, 1, 8)),
        (9, "sample_9", 265.00, datetime(2024, 1, 9)),
        (10, "sample_10", 180.00, datetime(2024, 1, 10)),
    ]
    df = spark.createDataFrame(data, schema=schema)
    return df
```

**Template rules:**
- Function name is the node name: `def {name}():`
- Decorator: `@fmlv.materialized_lake_view(name="{schema}.{name}")`
- Parent reading: `spark.sql("SELECT * FROM {parent_schema}.{parent_name}")`
- Multiple parents: each gets its own `df` variable (`df1`, `df2`, ...) then joined.
- Standalone (no parents): generates sample data inline with StructType schema.

---

## 6. Visual Spec

### 6.1 Node Container Structure (SVG + HTML)

The node is rendered as an SVG `<g>` group containing:
1. A `<rect>` for the background shape (for hit-testing and border rendering).
2. A `<foreignObject>` wrapping HTML content (for rich text, badges, icons).
3. `<circle>` elements for ports.

```xml
<!-- Node group — positioned via transform -->
<g class="dag-node" data-node-id="{id}" transform="translate({x}, {y})">

  <!-- Background rect — rounded corners, border, shadow via filter -->
  <rect class="dag-node__bg"
        width="180" height="{computedHeight}"
        rx="10" ry="10"
        fill="white"
        stroke="rgba(0,0,0,0.12)"
        stroke-width="1.5" />

  <!-- Selection ring — hidden by default, shown when selected -->
  <rect class="dag-node__selection-ring"
        x="-3" y="-3"
        width="186" height="{computedHeight + 6}"
        rx="13" ry="13"
        fill="none"
        stroke="var(--accent)"
        stroke-width="2"
        opacity="0"
        filter="url(#glow)" />

  <!-- HTML content via foreignObject -->
  <foreignObject width="180" height="{computedHeight}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="dag-node__content">

      <!-- Header row: icon + name -->
      <div class="dag-node__header">
        <div class="dag-node__icon {typeClass}">
          {typeIcon}  <!-- ◇ or ◆ -->
        </div>
        <span class="dag-node__name">{name}</span>
      </div>

      <!-- Meta row: type badge + schema badge -->
      <div class="dag-node__meta">
        <span class="dag-node__type-badge {typeClass}">
          {badgeText}  <!-- SQL TABLE / SQL MLV / PYSPARK -->
        </span>
        <span class="dag-node__schema-badge" style="background:{schemaBgColor};color:{schemaTextColor};">
          {schema}
        </span>
      </div>

    </div>
  </foreignObject>

  <!-- Input port (top center) — conditional: only MLV types -->
  <circle class="dag-node__port dag-node__port--in"
          cx="90" cy="0" r="4"
          fill="var(--text-muted)"
          stroke="white" stroke-width="1.5"
          data-port-id="in"
          opacity="0" />
  <!-- Port hit area — invisible, larger target -->
  <circle class="dag-node__port-hit dag-node__port-hit--in"
          cx="90" cy="0" r="12"
          fill="transparent"
          data-port-id="in" />

  <!-- Output port (bottom center) — always present -->
  <circle class="dag-node__port dag-node__port--out"
          cx="90" cy="{computedHeight}" r="4"
          fill="var(--text-muted)"
          stroke="white" stroke-width="1.5"
          data-port-id="out"
          opacity="0" />
  <!-- Port hit area -->
  <circle class="dag-node__port-hit dag-node__port-hit--out"
          cx="90" cy="{computedHeight}" r="12"
          fill="transparent"
          data-port-id="out" />

  <!-- Validation badge (top-right corner) — shown when isValid === false -->
  <g class="dag-node__validation-badge" transform="translate(172, -4)" opacity="0">
    <circle r="8" fill="var(--status-warn)" />
    <text x="0" y="1" text-anchor="middle" dominant-baseline="middle"
          fill="white" font-size="10" font-weight="700">▲</text>
  </g>

</g>
```

### 6.2 Node Dimensions

| Measurement | Value | Notes |
|-------------|-------|-------|
| Width | 180px | Fixed — consistent across all node types |
| Height | 64px (compact) / 72px (with longer names) | Variable — driven by text wrapping |
| Min height | 56px | Floor to prevent tiny nodes |
| Max height | 80px | Ceiling to prevent oversized nodes |
| Border radius | 10px | `--r-lg` from design system |
| Border width | 1.5px (idle), 2px (selected) | Subtle default, pronounced selected |
| Padding | 12px horizontal, 8px vertical | `--sp-3` / `--sp-2` |

### 6.3 Node Type Visuals

#### Plain SQL Table

```
┌─────────────────────────────┐
│  ◇  orders                  │  ← Icon: ◇ (diamond outline), Name: monospace 12px semibold
│  ┌─────────┐ ┌────────┐    │
│  │SQL TABLE│ │ bronze │    │  ← Blue badge + Bronze schema badge
│  └─────────┘ └────────┘    │
└──────────────●──────────────┘  ← Output port only (bottom center)
```

- **Icon (◇):** 18×18px square, rounded 4px, background `rgba(45,127,249,0.08)`, color `#2d7ff9`
- **Badge:** `SQL TABLE`, 9px uppercase, weight 700, letter-spacing 0.04em, pill shape (`border-radius: 100px`), background `rgba(45,127,249,0.08)`, color `#2d7ff9`

#### SQL MLV

```
               ●                  ← Input port (top center)
┌─────────────────────────────┐
│  ◆  order_summary           │  ← Icon: ◆ (filled diamond), Name: monospace 12px semibold
│  ┌────────┐ ┌────────┐     │
│  │SQL MLV │ │ silver │     │  ← Purple badge + Silver schema badge
│  └────────┘ └────────┘     │
└──────────────●──────────────┘  ← Output port (bottom center)
```

- **Icon (◆):** 18×18px square, rounded 4px, background `rgba(109,92,255,0.08)`, color `var(--accent)` (`#6d5cff`)
- **Badge:** `SQL MLV`, 9px uppercase, weight 700, pill shape, background `rgba(109,92,255,0.08)`, color `var(--accent)`

#### PySpark MLV

```
               ●                  ← Input port (top center)
┌─────────────────────────────┐
│  ◆  customer_360            │  ← Icon: ◆ (filled diamond), Name: monospace 12px semibold
│  ┌─────────┐ ┌───────┐     │
│  │ PYSPARK │ │ gold  │     │  ← Orange badge + Gold schema badge
│  └─────────┘ └───────┘     │
└──────────────●──────────────┘  ← Output port (bottom center)
```

- **Icon (◆):** 18×18px square, rounded 4px, background `rgba(229,148,12,0.08)`, color `var(--status-warn)` (`#e5940c`)
- **Badge:** `PYSPARK`, 9px uppercase, weight 700, pill shape, background `rgba(229,148,12,0.08)`, color `var(--status-warn)`

### 6.4 Port Visual Design

| Property | Idle | Hovered | Valid Target | Invalid Target | Hovered Target |
|----------|------|---------|-------------|----------------|----------------|
| Visible radius | 4px | 5px | 5px | 4px | 6px |
| Hit-test radius | 12px | 12px | 16px (expanded during drag) | 12px | 16px |
| Fill color | `var(--text-muted)` | `var(--accent)` | `var(--accent)` | `oklch(0.75 0.02 0)` (dim gray) | `var(--accent)` |
| Stroke | 1.5px white | 1.5px white | 2px white | 1px `oklch(0.85 0 0)` | 2px white |
| Shadow | None | None | `0 0 6px var(--accent-glow)` | None | `0 0 8px var(--accent-glow)` |
| Scale | 1.0 | 1.15 | 1.0 | 0.9 | 1.3 |
| Transition | — | 150ms ease | 200ms ease | 200ms ease | 150ms spring |
| Opacity | 0 → 1 (on hover) | 1 | 1 | 0.4 | 1 |

### 6.5 Port Position Math

Ports are positioned at the center of the top and bottom edges of the node bounding box:

```javascript
// Input port position (top center of node)
getInputPortPosition() {
  return {
    x: this._position.x + this._size.width / 2,   // 90px from left
    y: this._position.y                             // top edge
  };
}

// Output port position (bottom center of node)
getOutputPortPosition() {
  return {
    x: this._position.x + this._size.width / 2,   // 90px from left
    y: this._position.y + this._size.height         // bottom edge
  };
}
```

**Port hit-testing:**
```javascript
hitTestPort(canvasX, canvasY) {
  const hitRadius = this._isConnectionDragActive ? 16 : 12;

  // Test input port (if exists)
  if (this.inputPort) {
    const ip = this.getInputPortPosition();
    const distIn = Math.hypot(canvasX - ip.x, canvasY - ip.y);
    if (distIn <= hitRadius) {
      return { hit: true, portId: 'in' };
    }
  }

  // Test output port
  const op = this.getOutputPortPosition();
  const distOut = Math.hypot(canvasX - op.x, canvasY - op.y);
  if (distOut <= hitRadius) {
    return { hit: true, portId: 'out' };
  }

  return { hit: false, portId: null };
}
```

### 6.6 Selection Visual

```css
/* Selected state — applied to the SVG rect */
.dag-node.selected .dag-node__bg {
  stroke: var(--accent);
  stroke-width: 2;
}

.dag-node.selected .dag-node__selection-ring {
  opacity: 1;
  animation: pulseGlow 2.5s ease-in-out infinite;
}

@keyframes pulseGlow {
  0%, 100% { stroke-opacity: 0.3; }
  50%      { stroke-opacity: 0.6; }
}
```

The selection ring is a slightly larger rect behind the node with the accent color and a pulsing glow animation. This matches the CEO-approved mock exactly (`box-shadow: 0 0 0 3px var(--accent-glow)`).

### 6.7 Hover Visual

```css
.dag-node:hover .dag-node__bg {
  stroke: rgba(0,0,0,0.18);
  filter: drop-shadow(0 2px 8px rgba(0,0,0,0.06));
}

/* Slight lift on hover — translateY(-1px) equivalent via SVG transform */
.dag-node:hover {
  transform: translate({x}px, {y - 1}px);
  transition: transform 200ms var(--ease);
}
```

### 6.8 Drag Visual

```css
.dag-node.dragging .dag-node__bg {
  opacity: 0.92;
  filter: drop-shadow(0 8px 24px rgba(0,0,0,0.12));
}

.dag-node.dragging {
  cursor: grabbing;
  /* z-index equivalent: move this <g> to end of parent to render on top */
}
```

During drag, the node's `<g>` element is re-appended to the end of its parent SVG group to ensure it renders on top of all other nodes (SVG z-ordering is paint-order based).

### 6.9 Popover Layout

The popover appears below the node, centered horizontally, with a 8px gap:

```
               ● (input port)
┌─────────────────────────────┐
│  ◆  order_summary           │  ← Selected node
│  SQL MLV   silver           │
└─────────────────────────────┘
               ● (output port)
               │
               ▼  8px gap
        ┌──────────────────┐
        │  ╔══ Popover ══╗ │
        │  ║              ║ │
        │  ║  [Name____]  ║ │  ← Editable text input, pre-filled
        │  ║              ║ │
        │  ║  Type:       ║ │
        │  ║  [SQL MLV ▾] ║ │  ← Dropdown: SQL Table / SQL MLV / PySpark MLV
        │  ║              ║ │
        │  ║  Schema:     ║ │
        │  ║  [silver  ▾] ║ │  ← Dropdown: dbo / bronze / silver / gold
        │  ║              ║ │
        │  ║  ─────────── ║ │  ← Separator
        │  ║              ║ │
        │  ║  🗑 Delete    ║ │  ← Danger action (red text)
        │  ║              ║ │
        │  ╚══════════════╝ │
        └──────────────────┘
```

**Popover positioning logic:**

```javascript
_computePopoverPosition() {
  const nodeBottom = this._position.y + this._size.height;
  const nodeCenterX = this._position.x + this._size.width / 2;
  const popoverWidth = 200;
  const popoverGap = 8;

  let popoverX = nodeCenterX - popoverWidth / 2;
  let popoverY = nodeBottom + popoverGap;

  // Clamp to canvas viewport bounds
  const viewport = this._canvas.getViewportBounds();
  const popoverHeight = 220; // estimated

  // If popover would overflow bottom → show above the node instead
  if (popoverY + popoverHeight > viewport.bottom) {
    popoverY = this._position.y - popoverHeight - popoverGap;
  }

  // If popover would overflow right → shift left
  if (popoverX + popoverWidth > viewport.right) {
    popoverX = viewport.right - popoverWidth - 8;
  }

  // If popover would overflow left → shift right
  if (popoverX < viewport.left) {
    popoverX = viewport.left + 8;
  }

  return { x: popoverX, y: popoverY };
}
```

**Popover HTML structure:**

```html
<div class="dag-node-popover" data-node-id="{id}">
  <!-- Name field -->
  <div class="popover-field">
    <label class="popover-label">Name</label>
    <input class="popover-input popover-input--name"
           type="text" value="{name}"
           spellcheck="false" autocomplete="off"
           maxlength="63"
           pattern="[a-z][a-z0-9_]*" />
    <span class="popover-error" hidden>Invalid name</span>
  </div>

  <!-- Type dropdown -->
  <div class="popover-field">
    <label class="popover-label">Type</label>
    <select class="popover-select popover-select--type">
      <option value="sql-table" {selected if type === 'sql-table'}>
        ◇ Plain SQL Table
      </option>
      <option value="sql-mlv" {selected if type === 'sql-mlv'}>
        ◆ SQL MLV
      </option>
      <option value="pyspark-mlv" {selected if type === 'pyspark-mlv'}>
        ◆ PySpark MLV
      </option>
    </select>
  </div>

  <!-- Schema dropdown -->
  <div class="popover-field">
    <label class="popover-label">Schema</label>
    <select class="popover-select popover-select--schema">
      <option value="dbo">dbo</option>
      <!-- Conditionally rendered based on Page 2 selections: -->
      <option value="bronze">bronze</option>
      <option value="silver">silver</option>
      <option value="gold">gold</option>
    </select>
  </div>

  <!-- Separator -->
  <div class="popover-separator"></div>

  <!-- Delete button -->
  <button class="popover-action popover-action--delete">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
    </svg>
    Delete Node
  </button>
</div>
```

**Popover CSS:**

```css
.dag-node-popover {
  position: absolute;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--r-lg);           /* 10px */
  padding: var(--sp-3);                 /* 12px */
  box-shadow: var(--shadow-lg);
  min-width: 200px;
  max-width: 240px;
  z-index: 10;
  animation: popoverIn 250ms var(--spring) both;
  font-family: var(--font);
}

@keyframes popoverIn {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.popover-field {
  margin-bottom: var(--sp-2);           /* 8px */
}

.popover-label {
  display: block;
  font-size: var(--text-xs);            /* 10px */
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--sp-1);           /* 4px */
}

.popover-input,
.popover-select {
  width: 100%;
  padding: var(--sp-1) var(--sp-2);     /* 4px 8px */
  border: 1px solid var(--border-bright);
  border-radius: var(--r-sm);           /* 4px */
  font-size: var(--text-sm);            /* 12px */
  font-family: var(--mono);
  color: var(--text);
  background: var(--surface);
  outline: none;
  transition: border-color var(--t-fast) var(--ease);
}

.popover-input:focus,
.popover-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}

.popover-input.error {
  border-color: var(--status-fail);
  box-shadow: 0 0 0 2px var(--status-fail-dim);
}

.popover-error {
  font-size: var(--text-xs);
  color: var(--status-fail);
  margin-top: 2px;
}

.popover-separator {
  height: 1px;
  background: var(--border);
  margin: var(--sp-2) 0;
}

.popover-action--delete {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--status-fail);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}

.popover-action--delete:hover {
  background: var(--status-fail-dim);
}
```

### 6.10 Delete Confirmation (Inline in Popover)

When the user clicks "Delete Node" and the node has connections, the delete button area transforms into a confirmation strip:

```
┌──────────────────────────┐
│  Delete 'mlv_1'?         │
│  2 connections removed   │
│                          │
│  [Cancel]  [Delete]      │  ← Cancel is ghost, Delete is red filled
└──────────────────────────┘
```

```css
.popover-confirm {
  padding: var(--sp-2);
  background: var(--status-fail-dim);
  border-radius: var(--r-sm);
  font-size: var(--text-sm);
}

.popover-confirm__text {
  color: var(--text);
  font-weight: 500;
  margin-bottom: var(--sp-1);
}

.popover-confirm__sub {
  color: var(--text-dim);
  font-size: var(--text-xs);
  margin-bottom: var(--sp-2);
}

.popover-confirm__actions {
  display: flex;
  gap: var(--sp-2);
  justify-content: flex-end;
}

.popover-confirm__cancel {
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border-bright);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--text-xs);
  color: var(--text-dim);
  cursor: pointer;
}

.popover-confirm__delete {
  padding: var(--sp-1) var(--sp-2);
  border: none;
  border-radius: var(--r-sm);
  background: var(--status-fail);
  color: white;
  font-size: var(--text-xs);
  font-weight: 600;
  cursor: pointer;
}
```

### 6.11 Fade-Out Animation (Delete)

```css
.dag-node.deleting {
  animation: nodeDeleteOut 200ms var(--ease) forwards;
  pointer-events: none;
}

@keyframes nodeDeleteOut {
  to {
    opacity: 0;
    transform: translate({x}px, {y}px) scale(0.95);
  }
}
```

After the animation completes (200ms), the `<g>` element is removed from the DOM.

### 6.12 Validation Badge

When `isValid === false`, a warning badge appears at the top-right corner of the node:

```
    ▲  ← 16px circle, --status-warn background, white ▲ symbol
┌────────────────────────────┐
│  ◆  mlv_1                  │
│  SQL MLV   dbo             │
└────────────────────────────┘
```

**Validation rules:**
- Plain SQL Table: **always valid** (no parents required, name auto-generated).
- SQL MLV: **invalid** if `connectionCount(input) === 0` (no parent tables connected).
- PySpark MLV: **invalid** if `connectionCount(input) === 0` (no parent tables connected).
- Any type: **invalid** if name is empty or violates naming rules.
- Any type: **invalid** if `{schema}.{name}` duplicates another node.

The badge shows a tooltip on hover: "This node needs at least one parent connection."

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Navigation

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Canvas focused | Move focus to next node (topological order, or creation order if no topology) |
| `Shift+Tab` | Canvas focused | Move focus to previous node |
| `Enter` | Node focused | Select node + open popover editor |
| `Space` | Node focused | Toggle selection (same as click) |
| `Escape` | Popover open | Close popover |
| `Escape` | Node(s) selected, no popover | Deselect all |
| `Delete` / `Backspace` | Node(s) selected | Delete selected node(s) with confirmation |
| `Arrow Up` | Node focused | Move focus to first parent node (upstream) |
| `Arrow Down` | Node focused | Move focus to first child node (downstream) |
| `Arrow Left` | Node focused | Move focus to sibling node (same rank, left) |
| `Arrow Right` | Node focused | Move focus to sibling node (same rank, right) |
| `Ctrl+A` | Canvas focused | Select all nodes |
| `F2` | Node selected | Open popover and focus name field (rename shortcut) |
| `Ctrl+D` | Node selected | Duplicate node (new ID, same config, offset position) |

### 7.2 Focus Management

```javascript
// Tab order: nodes in creation order (or topological order if available)
// Focus ring: 2px solid var(--accent), 2px offset, visible only on keyboard navigation

.dag-node:focus-visible .dag-node__bg {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

When the popover opens:
1. Focus moves to the name input field.
2. Tab cycles through: Name input → Type select → Schema select → Delete button → (back to Name).
3. Focus is trapped inside the popover (focus trap).
4. On close, focus returns to the node.

### 7.3 ARIA Attributes

```xml
<!-- Node group -->
<g class="dag-node"
   role="listitem"
   tabindex="0"
   aria-label="{typeLabel} node: {name}, schema: {schema}{parentCount > 0 ? ', ' + parentCount + ' parents' : ''}{childCount > 0 ? ', ' + childCount + ' children' : ''}"
   aria-selected="{isSelected}"
   aria-describedby="node-desc-{id}">

  <!-- Hidden description for screen readers -->
  <desc id="node-desc-{id}">
    {typeLabel} node named {name} in {schema} schema.
    {parentCount} parent connections, {childCount} child connections.
    {isValid ? 'Configuration complete.' : 'Configuration incomplete: needs parent connection.'}
    Press Enter to edit. Press Delete to remove.
  </desc>

  <!-- Port ARIA -->
  <circle class="dag-node__port--in"
          role="button"
          aria-label="Input port. Drag from another node's output port here to create a connection."
          tabindex="-1" />

  <circle class="dag-node__port--out"
          role="button"
          aria-label="Output port. Drag from here to another node's input port to create a connection."
          tabindex="-1" />
</g>
```

### 7.4 Live Region Announcements

State changes are announced via an `aria-live` region on the canvas:

```html
<div id="dag-live" aria-live="polite" aria-atomic="true" class="sr-only">
  <!-- Populated dynamically -->
</div>
```

| Event | Announcement |
|-------|-------------|
| Node selected | "Selected {name}, {type}, {schema} schema" |
| Node deselected | "Deselected {name}" |
| Node renamed | "Renamed to {newName}" |
| Node type changed | "Changed type to {newType}" |
| Node schema changed | "Changed schema to {newSchema}" |
| Node deleted | "Deleted {name} and {N} connections" |
| Node created | "Created {type} node: {name}" |
| Connection created | "Connected {sourceName} to {targetName}" |
| Validation warning | "{name} needs at least one parent connection" |

### 7.5 Screen Reader Node List

A hidden summary of all nodes is maintained for screen reader users:

```html
<div class="sr-only" role="list" aria-label="DAG nodes">
  <div role="listitem">orders: SQL Table in bronze schema, 0 parents, 2 children</div>
  <div role="listitem">customers: SQL Table in bronze schema, 0 parents, 1 child</div>
  <div role="listitem">order_summary: SQL MLV in silver schema, 2 parents, 1 child</div>
  <!-- ... -->
</div>
```

This list updates whenever the graph changes.

### 7.6 Color Independence

Node types are distinguishable by **three independent channels:**
1. **Color:** Blue / Purple / Orange badge backgrounds
2. **Icon:** ◇ (outline diamond) for SQL Table vs ◆ (filled diamond) for MLVs
3. **Text:** `SQL TABLE` / `SQL MLV` / `PYSPARK` badge labels

This ensures users with color vision deficiency can distinguish node types.

---

## 8. Error Handling

### 8.1 Name Validation Errors

| Error | Detection | Visual Feedback | Recovery |
|-------|-----------|----------------|----------|
| Empty name | `name.trim().length === 0` | Red border on input, error text: "Name cannot be empty" | User must type a name |
| Invalid characters | `!/^[a-z][a-z0-9_]*$/.test(name)` | Red border, error: "Only lowercase letters, numbers, and underscores. Must start with a letter." | User corrects input |
| Too long | `name.length > 63` | Red border, error: "Maximum 63 characters" | Input has `maxlength="63"` |
| Duplicate FQN | Another node has same `{schema}.{name}` | Orange border (warning), error: "'{schema}.{name}' already exists" | User changes name or schema |
| Reserved word | Name matches SQL keyword | Orange border (warning, non-blocking), hint: "'{name}' is a SQL reserved word — may cause issues" | Allowed but warned |

### 8.2 Type Change Errors

| Error | Detection | Handling |
|-------|-----------|---------|
| Change to SQL Table with existing input connections | `type === 'sql-table' && inputConnections.length > 0` | Show confirmation dialog listing connections to be removed. Undo-safe. |
| Change from SQL Table when it's the only source for a child MLV | Check if any child would become orphaned | Warning in popover: "This will leave 'mlv_1' without parents." Allow, but mark child as invalid. |

### 8.3 Schema Change Errors

| Error | Detection | Handling |
|-------|-----------|---------|
| Schema removed on Page 2 after assignment | User navigates back to Page 2 and deselects a schema that's in use | DagCanvas receives `canvas:schemaschanged`. Nodes with the removed schema get a validation error. User must reassign schema before proceeding. |
| Duplicate FQN after schema change | New `{schema}.{name}` conflicts with existing | Prevent schema change, show error in popover dropdown. |

### 8.4 Connection Validation Errors

| Error | Detection | Feedback |
|-------|-----------|----------|
| Self-connection | `sourceNodeId === targetNodeId` | Port stays dim, cursor shows `not-allowed`, wire turns red |
| Would create cycle | `wouldCreateCycle(graph, sourceId, targetId)` returns true | Target port turns red, tooltip: "Would create a cycle", wire turns red |
| Duplicate connection | Connection already exists between same source→target | Target port shows blue (existing), tooltip: "Already connected" |
| Input port on SQL Table | SQL Tables have no input port | No input port to target — naturally prevented |
| Connecting output-to-output or input-to-input | Direction mismatch | Ports of wrong type don't highlight as valid targets |

### 8.5 Edge Case: Orphaned Node After Connection Delete

When a connection is deleted (directly or via type change), check if the target node became an orphan MLV:
1. If target node is SQL MLV or PySpark MLV with 0 input connections → set `isValid = false`, show validation badge.
2. This is a **warning**, not a blocking error. The user can still proceed — the generated code will produce a standalone MLV.

### 8.6 Maximum Node Count

- Limit: 100 nodes on canvas (from spec §8).
- When user tries to add node #101:
  - NodePalette buttons become disabled.
  - Context menu "Add" options become disabled.
  - Toast message: "Maximum of 100 nodes reached."
  - This check is at the DagCanvas level, not DagNode.

---

## 9. Performance

### 9.1 Performance Budget

| Operation | Target | Approach |
|-----------|--------|----------|
| Node creation (render + insert into DOM) | < 5ms | Single `<g>` append with innerHTML for foreignObject |
| Node selection (visual update) | < 2ms | CSS class toggle (`.selected`) |
| Node drag (position update per frame) | < 4ms | Update `transform` attribute only |
| Port hover detection | < 1ms | Simple distance calculation (two `Math.hypot` calls) |
| Popover open (render + position) | < 8ms | Template string → innerHTML, position calc, append |
| Popover close (teardown) | < 2ms | Remove element, null references |
| Code generation (single node) | < 3ms | String template interpolation |
| Node re-render (after property change) | < 5ms | Update only changed DOM elements (badges, labels) |
| Full canvas render (100 nodes) | < 100ms | Batch DOM creation, single SVG tree, DocumentFragment |
| Delete animation | 200ms (visual) + < 2ms (DOM removal) | CSS animation, then `remove()` |

### 9.2 DOM Efficiency

Each DagNode creates the following DOM elements:
- 1 SVG `<g>` group
- 1 SVG `<rect>` (background)
- 1 SVG `<rect>` (selection ring)
- 1 SVG `<foreignObject>`
- 1 HTML `<div>` (content wrapper)
- 2-3 HTML `<div>` (header, meta, icon)
- 2-3 HTML `<span>` (name, badges)
- 2-4 SVG `<circle>` (ports + hit areas)
- 1 SVG `<g>` (validation badge, conditional)

**Total per node: ~12-15 DOM elements.**
**At 100 nodes: ~1,200-1,500 DOM elements** — trivial for modern browsers.

### 9.3 Event Delegation

Instead of attaching event listeners to each node, DagCanvas uses event delegation on the SVG container:

```javascript
// DagCanvas — single listener on the SVG root
this._svg.addEventListener('pointerdown', (e) => {
  const nodeGroup = e.target.closest('.dag-node');
  if (!nodeGroup) return;
  const nodeId = nodeGroup.dataset.nodeId;
  const node = this._nodes.get(nodeId);

  // Check if click was on a port
  const portEl = e.target.closest('.dag-node__port-hit');
  if (portEl) {
    node._handlePortPointerDown(e, portEl.dataset.portId);
    return;
  }

  // Click on node body
  node._handleBodyPointerDown(e);
});
```

This pattern means **zero per-node event listeners** — all events are handled by a single listener on the canvas SVG, with `closest()` lookups to determine the target node.

### 9.4 Render Batching

When multiple nodes need to update simultaneously (e.g., deselect all, or schema change broadcast):

```javascript
// Batch DOM writes using requestAnimationFrame
_batchUpdate(updates) {
  requestAnimationFrame(() => {
    for (const update of updates) {
      update();
    }
  });
}
```

### 9.5 Connection Path Updates During Drag

When a node is dragged, only the edges connected to that node need path recalculation:

```javascript
// In node:dragmove handler (ConnectionManager)
onNodeDragMove(nodeId, newPosition) {
  const affectedEdges = this._edges.filter(e =>
    e.sourceNodeId === nodeId || e.targetNodeId === nodeId
  );
  // Only recompute these edges' paths — not all edges
  for (const edge of affectedEdges) {
    edge.recomputePath();
  }
}
```

At 100 nodes, a single node typically has 1-5 connections. Recomputing 5 Bézier paths is <1ms.

### 9.6 Popover Lazy Rendering

The popover DOM is NOT pre-created with the node. It is created lazily when `openPopover()` is called and destroyed when `closePopover()` is called. This avoids 100 hidden popover DOMs sitting in memory.

```javascript
openPopover() {
  if (this._popoverEl) return; // Already open

  this._popoverEl = this._createPopoverDOM();
  this._positionPopover();
  this._canvas.getPopoverLayer().appendChild(this._popoverEl);
  this._popoverEl.querySelector('.popover-input--name').focus();
}

closePopover() {
  if (!this._popoverEl) return;
  this._popoverEl.remove();
  this._popoverEl = null;
}
```

---

## 10. Implementation Notes

### 10.1 Class Structure

```javascript
/**
 * DagNode — Individual node on the DAG canvas.
 *
 * Rendering: SVG <g> with foreignObject wrapping HTML content.
 * Ports: SVG circles at top-center (input) and bottom-center (output).
 * Popover: HTML div appended to a popover layer (above SVG, outside transform group).
 *
 * @fires node:select
 * @fires node:deselect
 * @fires node:dragstart
 * @fires node:dragmove
 * @fires node:dragend
 * @fires node:rename
 * @fires node:typechange
 * @fires node:schemachange
 * @fires node:delete
 * @fires node:popoveropen
 * @fires node:popoverclose
 * @fires port:dragstart
 * @fires port:dragend
 * @fires port:hover
 * @fires port:leave
 */
class DagNode {
  /** @type {string} */ #id;
  /** @type {string} */ #name;
  /** @type {'sql-table'|'sql-mlv'|'pyspark-mlv'} */ #type;
  /** @type {'dbo'|'bronze'|'silver'|'gold'} */ #schema;
  /** @type {{x: number, y: number}} */ #position;
  /** @type {{width: number, height: number}} */ #size;
  /** @type {number} */ #sequenceNumber;
  /** @type {number} */ #createdAt;
  /** @type {boolean} */ #selected;
  /** @type {boolean} */ #dragging;
  /** @type {boolean} */ #connectionDragActive;
  /** @type {string[]} */ #availableSchemas;

  // DOM references
  /** @type {SVGGElement} */ #groupEl;
  /** @type {SVGRectElement} */ #bgRect;
  /** @type {SVGRectElement} */ #selectionRing;
  /** @type {SVGForeignObjectElement} */ #foreignObject;
  /** @type {SVGCircleElement|null} */ #inputPort;
  /** @type {SVGCircleElement} */ #outputPort;
  /** @type {SVGCircleElement|null} */ #inputPortHit;
  /** @type {SVGCircleElement} */ #outputPortHit;
  /** @type {HTMLElement|null} */ #popoverEl;
  /** @type {SVGGElement|null} */ #validationBadge;

  // Parent references
  /** @type {DagCanvas} */ #canvas;
  /** @type {SVGGElement} */ #parentGroup;

  // Drag state
  /** @type {boolean} */ #potentialDrag;
  /** @type {{x: number, y: number}} */ #dragStartPointer;
  /** @type {{x: number, y: number}} */ #dragStartPosition;

  constructor(config) {
    this.#id = config.id;
    this.#name = config.name;
    this.#type = config.type;
    this.#schema = config.schema;
    this.#position = { ...config.position };
    this.#size = { width: 180, height: 64 };
    this.#sequenceNumber = config.sequenceNumber;
    this.#createdAt = Date.now();
    this.#selected = false;
    this.#dragging = false;
    this.#connectionDragActive = false;
    this.#availableSchemas = config.availableSchemas;
    this.#canvas = config.canvas;
    this.#parentGroup = config.parentGroup;
    this.#popoverEl = null;

    this.#render();
  }

  // ... methods as defined in §3.1
}
```

### 10.2 SVG Namespace Helpers

All SVG elements must be created with the correct namespace:

```javascript
const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function htmlEl(tag, attrs = {}) {
  const el = document.createElementNS(XHTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}
```

### 10.3 Coordinate Systems

DagNode operates in **canvas coordinates** (the coordinate system of the SVG viewport, before zoom/pan transforms). All position values stored in the data model are canvas coordinates.

**Canvas → Screen conversion** (needed for popover positioning, since popovers are HTML elements outside the SVG):

```javascript
canvasToScreen(canvasX, canvasY) {
  const zoom = this.#canvas.getZoomScale();
  const pan = this.#canvas.getPanOffset();
  return {
    x: canvasX * zoom + pan.x,
    y: canvasY * zoom + pan.y
  };
}

screenToCanvas(screenX, screenY) {
  const zoom = this.#canvas.getZoomScale();
  const pan = this.#canvas.getPanOffset();
  return {
    x: (screenX - pan.x) / zoom,
    y: (screenY - pan.y) / zoom
  };
}
```

The popover is positioned in **screen coordinates** (it's an HTML element in the popover layer, not inside the SVG transform group). So the popover position must be computed by converting the node's canvas-coordinate bottom-center to screen coordinates.

### 10.4 Type Icon Mapping

```javascript
const TYPE_CONFIG = {
  'sql-table': {
    icon: '◇',
    badgeText: 'SQL TABLE',
    iconClass: 'sql-table',
    iconBg: 'rgba(45,127,249,0.08)',
    iconColor: '#2d7ff9',
    badgeBg: 'rgba(45,127,249,0.08)',
    badgeColor: '#2d7ff9',
    hasInputPort: false,
    namePrefix: 'table',
    cellType: 'sql'
  },
  'sql-mlv': {
    icon: '◆',
    badgeText: 'SQL MLV',
    iconClass: 'sql-mlv',
    iconBg: 'rgba(109,92,255,0.08)',
    iconColor: '#6d5cff',
    badgeBg: 'rgba(109,92,255,0.08)',
    badgeColor: '#6d5cff',
    hasInputPort: true,
    namePrefix: 'mlv',
    cellType: 'sql'
  },
  'pyspark-mlv': {
    icon: '◆',
    badgeText: 'PYSPARK',
    iconClass: 'pyspark',
    iconBg: 'rgba(229,148,12,0.08)',
    iconColor: '#e5940c',
    badgeBg: 'rgba(229,148,12,0.08)',
    badgeColor: '#e5940c',
    hasInputPort: true,
    namePrefix: 'spark',
    cellType: 'code'
  }
};
```

### 10.5 Theme Column Mapping

Each data theme maps to a set of column definitions used in code generation. The code generation templates (§5.10–5.12) use generic columns by default — the theme system replaces them with domain-specific columns.

```javascript
const THEME_COLUMNS = {
  'e-commerce': {
    tables: {
      orders:     ['order_id INT', 'customer_id INT', 'product_id INT', 'quantity INT', 'total DECIMAL(10,2)', 'order_date TIMESTAMP'],
      customers:  ['customer_id INT', 'name STRING', 'email STRING', 'city STRING', 'signup_date TIMESTAMP'],
      products:   ['product_id INT', 'name STRING', 'price DECIMAL(10,2)', 'category STRING', 'in_stock BOOLEAN'],
      categories: ['category_id INT', 'name STRING', 'parent_id INT', 'description STRING'],
      reviews:    ['review_id INT', 'product_id INT', 'customer_id INT', 'rating INT', 'comment STRING', 'review_date TIMESTAMP']
    },
    defaultColumns: ['id INT', 'name STRING', 'value DECIMAL(10,2)', 'created_at TIMESTAMP']
  },
  'sales-marketing': {
    tables: {
      leads:      ['lead_id INT', 'name STRING', 'email STRING', 'source STRING', 'score INT', 'created_at TIMESTAMP'],
      campaigns:  ['campaign_id INT', 'name STRING', 'type STRING', 'budget DECIMAL(10,2)', 'start_date TIMESTAMP'],
      deals:      ['deal_id INT', 'lead_id INT', 'amount DECIMAL(10,2)', 'stage STRING', 'close_date TIMESTAMP'],
      accounts:   ['account_id INT', 'name STRING', 'industry STRING', 'revenue DECIMAL(12,2)', 'region STRING'],
      activities: ['activity_id INT', 'lead_id INT', 'type STRING', 'notes STRING', 'activity_date TIMESTAMP']
    },
    defaultColumns: ['id INT', 'name STRING', 'value DECIMAL(10,2)', 'created_at TIMESTAMP']
  },
  'iot-sensors': {
    tables: {
      devices:    ['device_id INT', 'name STRING', 'type STRING', 'location_id INT', 'status STRING'],
      readings:   ['reading_id INT', 'device_id INT', 'value DECIMAL(10,4)', 'unit STRING', 'timestamp TIMESTAMP'],
      alerts:     ['alert_id INT', 'device_id INT', 'severity STRING', 'message STRING', 'triggered_at TIMESTAMP'],
      locations:  ['location_id INT', 'name STRING', 'latitude DECIMAL(9,6)', 'longitude DECIMAL(9,6)', 'zone STRING'],
      thresholds: ['threshold_id INT', 'device_id INT', 'metric STRING', 'min_val DECIMAL(10,4)', 'max_val DECIMAL(10,4)']
    },
    defaultColumns: ['id INT', 'name STRING', 'value DECIMAL(10,4)', 'created_at TIMESTAMP']
  },
  'hr-people': {
    tables: {
      employees:   ['employee_id INT', 'name STRING', 'department_id INT', 'title STRING', 'hire_date TIMESTAMP'],
      departments: ['department_id INT', 'name STRING', 'manager_id INT', 'budget DECIMAL(12,2)', 'location STRING'],
      payroll:     ['payroll_id INT', 'employee_id INT', 'salary DECIMAL(10,2)', 'bonus DECIMAL(10,2)', 'pay_date TIMESTAMP'],
      attendance:  ['record_id INT', 'employee_id INT', 'date TIMESTAMP', 'status STRING', 'hours DECIMAL(4,2)'],
      reviews:     ['review_id INT', 'employee_id INT', 'reviewer_id INT', 'rating INT', 'review_date TIMESTAMP']
    },
    defaultColumns: ['id INT', 'name STRING', 'value DECIMAL(10,2)', 'created_at TIMESTAMP']
  },
  'finance': {
    tables: {
      transactions: ['transaction_id INT', 'account_id INT', 'amount DECIMAL(12,2)', 'type STRING', 'transaction_date TIMESTAMP'],
      accounts:     ['account_id INT', 'name STRING', 'type STRING', 'balance DECIMAL(12,2)', 'currency STRING'],
      invoices:     ['invoice_id INT', 'account_id INT', 'amount DECIMAL(12,2)', 'status STRING', 'due_date TIMESTAMP'],
      payments:     ['payment_id INT', 'invoice_id INT', 'amount DECIMAL(12,2)', 'method STRING', 'payment_date TIMESTAMP'],
      budgets:      ['budget_id INT', 'department STRING', 'amount DECIMAL(12,2)', 'fiscal_year INT', 'category STRING']
    },
    defaultColumns: ['id INT', 'name STRING', 'value DECIMAL(12,2)', 'created_at TIMESTAMP']
  },
  'healthcare': {
    tables: {
      patients:      ['patient_id INT', 'name STRING', 'dob TIMESTAMP', 'gender STRING', 'blood_type STRING'],
      appointments:  ['appointment_id INT', 'patient_id INT', 'provider_id INT', 'date TIMESTAMP', 'type STRING'],
      prescriptions: ['prescription_id INT', 'patient_id INT', 'medication STRING', 'dosage STRING', 'prescribed_date TIMESTAMP'],
      labs:          ['lab_id INT', 'patient_id INT', 'test_name STRING', 'result STRING', 'lab_date TIMESTAMP'],
      providers:     ['provider_id INT', 'name STRING', 'specialty STRING', 'department STRING', 'license_no STRING']
    },
    defaultColumns: ['id INT', 'name STRING', 'value DECIMAL(10,2)', 'created_at TIMESTAMP']
  }
};
```

When generating code for a node:
1. Look up the theme's table columns by node name (if the node name matches a known table name for the theme).
2. If no match → use `defaultColumns`.
3. Column types are used in `CREATE TABLE`, `StructType`, and sample data generation.

### 10.6 Code Generation Implementation

```javascript
class DagNodeCodeGenerator {
  /**
   * Generate notebook cell content for a single node.
   * @param {DagNodeData} node
   * @param {DagNodeData[]} parents - Resolved parent nodes
   * @param {string} theme - Theme key
   * @returns {NotebookCell}
   */
  static generate(node, parents, theme) {
    switch (node.type) {
      case 'sql-table':
        return this.#generateSqlTable(node, theme);
      case 'sql-mlv':
        return this.#generateSqlMlv(node, parents, theme);
      case 'pyspark-mlv':
        return this.#generatePySparkMlv(node, parents, theme);
      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  static #generateSqlTable(node, theme) {
    const columns = this.#getColumns(node.name, theme);
    const columnDefs = columns.map(c => `    ${c}`).join(',\n');
    const sampleRows = this.#generateSampleData(columns, theme, 10);
    const insertValues = sampleRows
      .map(row => `    (${row.join(', ')})`)
      .join(',\n');

    const source = [
      '%%sql',
      `CREATE TABLE IF NOT EXISTS ${node.schema}.${node.name} (`,
      columnDefs,
      ');',
      `INSERT INTO ${node.schema}.${node.name} VALUES`,
      insertValues + ';'
    ].join('\n');

    return {
      cellType: 'sql',
      source,
      metadata: {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        schema: node.schema
      }
    };
  }

  static #generateSqlMlv(node, parents, theme) {
    let selectClause;
    if (parents.length === 0) {
      // Orphan MLV — just SELECT 1 (should not happen if validation is enforced)
      selectClause = 'SELECT 1 AS placeholder';
    } else if (parents.length === 1) {
      selectClause = `SELECT * FROM ${parents[0].schema}.${parents[0].name}`;
    } else {
      // JOIN pattern: alias each parent as t1, t2, ...
      const fromClause = `${parents[0].schema}.${parents[0].name} t1`;
      const joinClauses = parents.slice(1).map((p, i) =>
        `JOIN ${p.schema}.${p.name} t${i + 2}\n    ON t1.id = t${i + 2}.id`
      ).join('\n');
      const selectCols = parents.map((_, i) => `t${i + 1}.*`).join(',\n    ');
      selectClause = `SELECT\n    ${selectCols}\nFROM ${fromClause}\n${joinClauses}`;
    }

    const source = [
      '%%sql',
      `CREATE MATERIALIZED LAKE VIEW ${node.schema}.${node.name} AS`,
      selectClause
    ].join('\n');

    return {
      cellType: 'sql',
      source,
      metadata: {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        schema: node.schema
      }
    };
  }

  static #generatePySparkMlv(node, parents, theme) {
    let body;
    if (parents.length === 0) {
      // Standalone PySpark MLV — generates its own sample data
      const columns = this.#getColumns(node.name, theme);
      const structFields = columns.map(c => {
        const [name, sparkType] = this.#toSparkType(c);
        return `        StructField("${name}", ${sparkType}, True)`;
      }).join(',\n');
      const sampleRows = this.#generateSampleData(columns, theme, 10);
      const dataRows = sampleRows
        .map(row => `        (${row.join(', ')})`)
        .join(',\n');

      body = [
        `    schema = StructType([`,
        structFields,
        `    ])`,
        `    data = [`,
        dataRows,
        `    ]`,
        `    df = spark.createDataFrame(data, schema=schema)`,
        `    return df`
      ].join('\n');
    } else if (parents.length === 1) {
      body = [
        `    df = spark.sql("SELECT * FROM ${parents[0].schema}.${parents[0].name}")`,
        `    return df`
      ].join('\n');
    } else {
      const dfAssignments = parents.map((p, i) =>
        `    df${i + 1} = spark.sql("SELECT * FROM ${p.schema}.${p.name}")`
      ).join('\n');
      const joinChain = parents.slice(1).reduce(
        (acc, _, i) => `${acc}.join(df${i + 2}, on="id", how="inner")`,
        'df1'
      );
      body = [
        dfAssignments,
        `    df = ${joinChain}`,
        `    return df`
      ].join('\n');
    }

    const source = [
      'import fmlv',
      'from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DecimalType, TimestampType',
      'from datetime import datetime',
      '',
      `@fmlv.materialized_lake_view(name="${node.schema}.${node.name}")`,
      `def ${node.name}():`,
      body
    ].join('\n');

    return {
      cellType: 'code',
      source,
      metadata: {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        schema: node.schema
      }
    };
  }

  static #getColumns(nodeName, theme) {
    const themeData = THEME_COLUMNS[theme];
    if (themeData && themeData.tables[nodeName]) {
      return themeData.tables[nodeName];
    }
    return themeData?.defaultColumns ?? [
      'id INT', 'name STRING', 'value DECIMAL(10,2)', 'created_at TIMESTAMP'
    ];
  }

  static #toSparkType(columnDef) {
    const parts = columnDef.split(' ');
    const name = parts[0];
    const sqlType = parts.slice(1).join(' ').toUpperCase();
    const mapping = {
      'INT': 'IntegerType()',
      'STRING': 'StringType()',
      'BOOLEAN': 'BooleanType()',
      'TIMESTAMP': 'TimestampType()'
    };
    // Handle DECIMAL(p,s)
    if (sqlType.startsWith('DECIMAL')) {
      return [name, sqlType.replace('DECIMAL', 'DecimalType')];
    }
    return [name, mapping[sqlType] ?? 'StringType()'];
  }

  static #generateSampleData(columns, theme, rowCount) {
    // Returns array of arrays: [[val1, val2, ...], [val1, val2, ...], ...]
    // Theme-aware sample data generation
    const rows = [];
    for (let i = 1; i <= rowCount; i++) {
      const row = columns.map(col => {
        const type = col.split(' ').slice(1).join(' ').toUpperCase();
        if (type === 'INT') return `${i}`;
        if (type === 'STRING') return `'sample_${i}'`;
        if (type === 'BOOLEAN') return i % 2 === 0 ? 'true' : 'false';
        if (type === 'TIMESTAMP') return `'2024-01-${String(i).padStart(2, '0')}T00:00:00'`;
        if (type.startsWith('DECIMAL')) return `${(i * 100 + i * 17.5).toFixed(2)}`;
        return `'sample_${i}'`;
      });
      rows.push(row);
    }
    return rows;
  }
}
```

### 10.7 Popover Focus Trap

The popover implements a focus trap to prevent keyboard navigation from escaping:

```javascript
_setupFocusTrap() {
  const focusable = this.#popoverEl.querySelectorAll(
    'input, select, button, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  this.#popoverEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closePopover();
    }
  });
}
```

### 10.8 Click-Outside Detection for Popover

```javascript
_setupClickOutside() {
  // Use a one-frame delay to avoid the opening click from immediately closing
  requestAnimationFrame(() => {
    this._clickOutsideHandler = (e) => {
      if (!this.#popoverEl) return;
      const clickedInPopover = this.#popoverEl.contains(e.target);
      const clickedOnNode = this.#groupEl.contains(e.target);
      if (!clickedInPopover && !clickedOnNode) {
        this.closePopover();
      }
    };
    document.addEventListener('pointerdown', this._clickOutsideHandler, true);
  });
}

closePopover() {
  if (!this.#popoverEl) return;
  document.removeEventListener('pointerdown', this._clickOutsideHandler, true);
  this._clickOutsideHandler = null;
  this.#popoverEl.remove();
  this.#popoverEl = null;
  this.#groupEl.focus(); // Return focus to node
  this.#canvas.emit('node:popoverclose', { nodeId: this.#id });
}
```

### 10.9 Drag Threshold Implementation

```javascript
_handleBodyPointerDown(event) {
  if (event.button !== 0) return; // Left click only
  event.preventDefault();

  this.#potentialDrag = true;
  this.#dragStartPointer = { x: event.clientX, y: event.clientY };
  this.#dragStartPosition = { ...this.#position };

  const onMove = (e) => {
    const dx = e.clientX - this.#dragStartPointer.x;
    const dy = e.clientY - this.#dragStartPointer.y;
    const distance = Math.hypot(dx, dy);

    if (this.#potentialDrag && distance >= 4) {
      // Threshold exceeded — enter drag mode
      this.#potentialDrag = false;
      this.#dragging = true;
      this.closePopover();
      this.setDragging(true);
      this.#canvas.emit('node:dragstart', {
        nodeId: this.#id,
        position: { ...this.#position }
      });
    }

    if (this.#dragging) {
      const scale = this.#canvas.getZoomScale();
      this.#position = {
        x: this.#dragStartPosition.x + dx / scale,
        y: this.#dragStartPosition.y + dy / scale
      };
      this.#groupEl.setAttribute('transform',
        `translate(${this.#position.x}, ${this.#position.y})`
      );
      this.#canvas.emit('node:dragmove', {
        nodeId: this.#id,
        position: { ...this.#position },
        delta: { x: dx / scale, y: dy / scale }
      });
    }
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);

    if (this.#dragging) {
      this.#dragging = false;
      this.setDragging(false);
      this.#canvas.emit('node:dragend', {
        nodeId: this.#id,
        oldPosition: { ...this.#dragStartPosition },
        newPosition: { ...this.#position }
      });
    } else if (this.#potentialDrag) {
      // Click without drag — handle selection
      this.#potentialDrag = false;
      this._handleClick(event);
    }
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
```

### 10.10 Integration Points

| Component | DagNode Provides | DagNode Consumes |
|-----------|-----------------|-----------------|
| **DagCanvas (C04)** | Node selection events, drag events, position data, serialization (`toJSON()`) | Zoom scale, pan offset, viewport bounds, available schemas, deselect-all commands |
| **NodePalette (C05)** | — | Creation config (type, initial position) via DagCanvas |
| **ConnectionManager (C07)** | Port positions (`getPortPosition()`), port hit-test results, port drag events | Connection drag state (to show/hide/style ports), parent node data (for code gen) |
| **CodePreviewPanel (C08)** | Generated code cells (`generateCode()`) | Refresh trigger |
| **ReviewSummary (C09)** | Node data (`toJSON()`) for summary display | — |
| **AutoLayoutEngine (C13)** | Node ID, current position, size | New position (layout result) |
| **UndoRedoManager (C14)** | Property change events (name, type, schema, position) | Undo/redo commands restore previous state via setters |

### 10.11 CSS Custom Properties Used

```css
/* All node CSS references these design system tokens */
:root {
  /* Surfaces */
  --surface: #ffffff;
  --surface-2: #f8f9fb;
  --surface-3: #ebedf0;

  /* Borders */
  --border: rgba(0,0,0,0.06);
  --border-bright: rgba(0,0,0,0.12);

  /* Text */
  --text: #1a1d23;
  --text-dim: #5a6070;
  --text-muted: #8e95a5;

  /* Accent */
  --accent: #6d5cff;
  --accent-glow: rgba(109,92,255,0.15);

  /* Status */
  --status-fail: #e5453b;
  --status-fail-dim: rgba(229,69,59,0.08);
  --status-warn: #e5940c;
  --status-warn-dim: rgba(229,148,12,0.08);

  /* Schema */
  --bronze: #b87333;
  --bronze-dim: rgba(184,115,51,0.08);
  --silver: #7b8794;
  --silver-dim: rgba(123,135,148,0.08);
  --gold: #c5a038;
  --gold-dim: rgba(197,160,56,0.08);
  --dbo: #5a6070;
  --dbo-dim: rgba(90,96,112,0.08);

  /* Typography */
  --font: 'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif;
  --mono: 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace;
  --text-xs: 10px;
  --text-sm: 12px;

  /* Spacing */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;

  /* Radius */
  --r-sm: 4px;
  --r-lg: 10px;
  --r-full: 100px;

  /* Shadows */
  --shadow-md: 0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);

  /* Transitions */
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --t-fast: 80ms;
  --t-normal: 150ms;
}
```

### 10.12 SVG Glow Filter Definition

The selection glow effect uses an SVG filter defined once in the canvas's `<defs>`:

```xml
<defs>
  <filter id="selectionGlow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur" />
    <feFlood flood-color="#6d5cff" flood-opacity="0.15" result="color" />
    <feComposite in="color" in2="blur" operator="in" result="glow" />
    <feMerge>
      <feMergeNode in="glow" />
      <feMergeNode in="SourceGraphic" />
    </feMerge>
  </filter>
</defs>
```

Applied to the node `<g>` when selected: `filter="url(#selectionGlow)"`.

### 10.13 File Location

```
src/
  features/
    infra-wizard/
      components/
        dag-node.js           ← DagNode class
        dag-node-code-gen.js   ← DagNodeCodeGenerator class
        dag-node.css           ← Node + popover styles (inlined at build)
```

### 10.14 Test Coverage Requirements

| Test Category | Test Cases | Priority |
|--------------|-----------|----------|
| **Rendering** | Each node type renders correct icon, badge, ports | P0 |
| **Rendering** | Schema badge shows correct color for each schema | P0 |
| **Rendering** | SQL Table has no input port; MLV types have both ports | P0 |
| **Selection** | Click selects, click-elsewhere deselects | P0 |
| **Selection** | Ctrl+click adds to multi-selection | P0 |
| **Selection** | Only one popover open at a time | P0 |
| **Dragging** | Drag updates position, emits events | P0 |
| **Dragging** | Drag threshold (4px) prevents accidental drag on click | P1 |
| **Dragging** | Multi-select drag moves all selected nodes | P1 |
| **Popover** | Open on click of selected node | P0 |
| **Popover** | Close on Escape, click-outside | P0 |
| **Popover** | Name validation: empty, invalid chars, duplicate FQN | P0 |
| **Popover** | Type change: SQL Table → MLV adds input port | P0 |
| **Popover** | Type change: MLV → SQL Table removes input port + connections | P0 |
| **Popover** | Schema change updates badge color | P0 |
| **Popover** | Delete with confirmation when connections exist | P0 |
| **Popover** | Delete without confirmation for orphan nodes | P1 |
| **Ports** | Ports hidden by default, visible on hover | P0 |
| **Ports** | Port hit-testing at 12px radius (16px during drag) | P1 |
| **Ports** | Valid/invalid target styling during connection drag | P0 |
| **Code Gen** | SQL Table generates correct CREATE TABLE + INSERT | P0 |
| **Code Gen** | SQL MLV generates `MATERIALIZED LAKE VIEW` (not `MATERIALIZED VIEW`) | P0 |
| **Code Gen** | SQL MLV with 1 parent generates correct SELECT FROM | P0 |
| **Code Gen** | SQL MLV with 2+ parents generates JOIN pattern | P0 |
| **Code Gen** | PySpark MLV generates correct decorator pattern | P0 |
| **Code Gen** | PySpark MLV with parents generates spark.sql reads | P0 |
| **Code Gen** | Schema prefix is always `{schema}.{name}` | P0 |
| **Code Gen** | Theme-specific columns used when node name matches theme table | P1 |
| **Accessibility** | ARIA labels include type, name, schema, connection counts | P1 |
| **Accessibility** | Keyboard Tab navigation between nodes | P1 |
| **Accessibility** | Enter opens popover, Escape closes | P1 |
| **Accessibility** | Focus trap inside popover | P1 |
| **Accessibility** | Screen reader announcements for state changes | P2 |
| **Performance** | 100 nodes render in < 100ms | P1 |
| **Performance** | Node drag maintains 60fps | P1 |
| **Serialization** | `toJSON()` produces correct output | P0 |
| **Serialization** | Restore from JSON recreates identical node | P0 |

### 10.15 Undo Command Definitions

Each user action on a DagNode generates a reversible command:

```javascript
class RenameNodeCommand {
  constructor(nodeId, oldName, newName, canvas) {
    this._nodeId = nodeId;
    this._oldName = oldName;
    this._newName = newName;
    this._canvas = canvas;
  }
  execute() {
    this._canvas.getNode(this._nodeId).name = this._newName;
  }
  undo() {
    this._canvas.getNode(this._nodeId).name = this._oldName;
  }
  get description() { return `Rename ${this._oldName} → ${this._newName}`; }
}

class ChangeTypeCommand {
  constructor(nodeId, oldType, newType, removedConnections, canvas) {
    this._nodeId = nodeId;
    this._oldType = oldType;
    this._newType = newType;
    this._removedConnections = removedConnections; // For undo restoration
    this._canvas = canvas;
  }
  execute() {
    this._canvas.getNode(this._nodeId).type = this._newType;
    // Connections already removed during type change
  }
  undo() {
    this._canvas.getNode(this._nodeId).type = this._oldType;
    // Restore removed connections
    for (const conn of this._removedConnections) {
      this._canvas.connectionManager.addConnection(conn);
    }
  }
}

class ChangeSchemaCommand {
  constructor(nodeId, oldSchema, newSchema, canvas) {
    this._nodeId = nodeId;
    this._oldSchema = oldSchema;
    this._newSchema = newSchema;
    this._canvas = canvas;
  }
  execute() {
    this._canvas.getNode(this._nodeId).schema = this._newSchema;
  }
  undo() {
    this._canvas.getNode(this._nodeId).schema = this._oldSchema;
  }
}

class MoveNodeCommand {
  constructor(nodeId, oldPosition, newPosition, canvas) {
    this._nodeId = nodeId;
    this._oldPosition = oldPosition;
    this._newPosition = newPosition;
    this._canvas = canvas;
  }
  execute() {
    this._canvas.getNode(this._nodeId).position = this._newPosition;
  }
  undo() {
    this._canvas.getNode(this._nodeId).position = this._oldPosition;
  }
}

class DeleteNodeCommand {
  constructor(nodeData, removedConnections, canvas) {
    this._nodeData = nodeData;         // Full node snapshot for restoration
    this._removedConnections = removedConnections;
    this._canvas = canvas;
  }
  execute() {
    this._canvas.removeNode(this._nodeData.id);
  }
  undo() {
    // Re-create the node from snapshot
    this._canvas.addNode(this._nodeData);
    // Re-create all connections
    for (const conn of this._removedConnections) {
      this._canvas.connectionManager.addConnection(conn);
    }
  }
}

class AddNodeCommand {
  constructor(nodeData, canvas) {
    this._nodeData = nodeData;
    this._canvas = canvas;
  }
  execute() {
    this._canvas.addNode(this._nodeData);
  }
  undo() {
    this._canvas.removeNode(this._nodeData.id);
  }
}
```

### 10.16 Known Limitations & Future Considerations

| Limitation | Impact | Future Path |
|-----------|--------|-------------|
| No inline editing on node label (must open popover) | Extra click to rename | Consider double-click to enter inline edit mode on the name label |
| Port position fixed at center of top/bottom edge | Multiple connections converge to same point | If >3 connections per port, consider fanning out port positions |
| No node duplication via UI (only keyboard Ctrl+D) | Discoverability | Add "Duplicate" to popover menu |
| No node grouping or sub-graphs | Large DAGs harder to organize | Out of scope for V1 — revisit at >50 node usage |
| PySpark MLV standalone code gen uses hardcoded sample data | Not theme-aware for standalone PySpark MLVs with parents | Theme integration already handles this via spark.sql reads |
| No connection labels (e.g., "depends on") | Connections are unlabeled arrows | Not needed for V1 — all connections mean "depends on" |
| Popover is HTML outside SVG transform group | Requires coordinate conversion | Necessary trade-off for rich form elements in popover |

---

*End of C06-DagNode Component Deep Spec.*
*Ready for P2 Architecture and P3 State Matrix phases.*
