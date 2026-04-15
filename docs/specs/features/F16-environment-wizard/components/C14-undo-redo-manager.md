# C14 — UndoRedoManager: Command Pattern & State History

> **Component:** `UndoRedoManager`
> **Owner:** Pixel (Frontend Engineer)
> **Target file:** `src/frontend/js/infra-wizard/undo-redo-manager.js`
> **Pattern:** Command (GoF) with dual-stack history and composite BatchCommand
> **Complexity:** MEDIUM (well-defined pattern, but edge cases in cascading undo are non-trivial)
> **Status:** P1 SPEC COMPLETE — ready for implementation
> **Dependencies:** C4-DagCanvas, C6-DagNode, C7-ConnectionManager, C13-AutoLayoutEngine
> **Spec version:** 1.0

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

UndoRedoManager is the single authority for reversible state mutations on the DAG canvas (Page 3 of the Infra Wizard). Every user action that modifies the graph — adding nodes, deleting connections, moving elements, renaming, changing types, auto-layout — is wrapped in a Command object and routed through this manager. The manager maintains two stacks (undo and redo) that allow users to step backwards and forwards through their editing history.

### 1.2 Scope Boundary

**IN SCOPE — Canvas operations only:**
- Node CRUD (add, delete, rename, change type, change schema)
- Connection CRUD (add, delete)
- Node position changes (drag-move, auto-layout)
- Batch operations (multi-select delete, auto-layout of all nodes)

**OUT OF SCOPE — Not managed by this component:**
- Page 1 form fields (workspace name, capacity, lakehouse name, notebook name)
- Page 2 selections (theme, schema toggles)
- Page navigation (Next/Back buttons)
- Template save/load/delete operations
- Wizard dialog resize/drag/minimize
- Zoom/pan state (viewport transform is not undoable — industry standard)

### 1.3 Design Rationale

**Why Command Pattern over Snapshot Pattern?**

Per P0 research (p0-canvas-interaction.md §6), a 100-node graph with full properties serializes to ~10–50 KB as JSON. With 50 undo levels of full snapshots, that's 0.5–2.5 MB in memory — manageable but wasteful. The Command pattern stores only deltas (typically <1 KB per action), is architecturally cleaner, and maps naturally to our discrete action types.

| Criterion | Command Pattern | Snapshot Pattern |
|-----------|----------------|-----------------|
| Memory per action | ~0.1–2 KB (delta only) | ~10–50 KB (full state) |
| Memory at 50 levels | ~5–100 KB total | ~0.5–2.5 MB total |
| Implementation complexity | Medium (one class per action) | Low (JSON clone) |
| Granularity | Per-action (precise descriptions) | Per-action (opaque blobs) |
| Extensibility | Add new command class | No change needed |
| Debug inspectability | Each command has type + description | Diff two snapshots |
| Compound operations | Native (BatchCommand) | Implicit (snapshot boundaries) |
| **Verdict** | **Selected** | Rejected |

**Why 50-level limit?**

Industry standard for visual editors. Figma uses 50, VS Code uses unlimited but with memory pressure eviction, Photoshop uses 50 (configurable). At 50 commands with our delta-based storage, worst-case memory is ~100 KB (an AutoLayoutCommand storing 100 node positions). This is negligible.

### 1.4 Architectural Position

```
┌────────────────────────────────────────────────────┐
│                   DagCanvas (C4)                   │
│                                                    │
│  User Action ──→ Create Command ──→ UndoRedoMgr   │
│                                     │              │
│                     ┌───────────────┤              │
│                     │               │              │
│              ┌──────▼──────┐  ┌─────▼──────┐       │
│              │  Undo Stack │  │ Redo Stack  │       │
│              │  (max 50)   │  │ (cleared on │       │
│              │             │  │  new action)│       │
│              └─────────────┘  └────────────┘       │
│                                                    │
│  Toolbar [Undo] [Redo]  ◄── canUndo / canRedo      │
│  Keyboard Ctrl+Z / Ctrl+Y  ◄── bound in DagCanvas  │
└────────────────────────────────────────────────────┘
```

UndoRedoManager does NOT directly manipulate the DOM or graph model. Each Command object holds a reference to the DagCanvas (or relevant sub-components) and performs mutations through the canvas's public API. This keeps the manager decoupled from rendering concerns.

---

## 2. Data Model

### 2.1 Command Interface

Every command object implements this contract. Commands are plain objects with closures or class instances — vanilla JS, no framework.

```javascript
/**
 * @interface Command
 * All canvas-mutating actions implement this interface.
 * Commands are immutable after construction — they capture
 * before/after state at creation time.
 */
class Command {
  /**
   * @readonly
   * @type {string}
   * Machine-readable action type. Used for debugging, logging,
   * and potential future analytics.
   * Examples: 'add-node', 'delete-node', 'move-node', 'batch'
   */
  get type() { throw new Error('Not implemented'); }

  /**
   * @readonly
   * @type {string}
   * Human-readable description for toolbar tooltips and
   * accessibility announcements.
   * Examples: "Add SQL Table 'orders'", "Move 'customers' to (340, 220)"
   */
  get description() { throw new Error('Not implemented'); }

  /**
   * Apply the forward mutation. Called on first execution
   * and on redo. Must be idempotent — calling execute() on
   * an already-executed command must produce the same result.
   * @returns {void}
   */
  execute() { throw new Error('Not implemented'); }

  /**
   * Reverse the mutation. Called on undo. Must perfectly
   * restore the state that existed before execute().
   * @returns {void}
   */
  undo() { throw new Error('Not implemented'); }
}
```

### 2.2 UndoRedoManager Internal State

```javascript
class UndoRedoManager {
  /** @type {Command[]} — LIFO stack of executed commands */
  #undoStack = [];

  /** @type {Command[]} — LIFO stack of undone commands (cleared on new execute) */
  #redoStack = [];

  /** @type {number} — Maximum undo depth. Oldest commands evicted when exceeded. */
  #maxDepth = 50;

  /** @type {Function|null} — Callback invoked on every state change */
  #onStateChange = null;

  /** @type {boolean} — Guard against re-entrant execute during undo/redo */
  #isApplying = false;

  /** @type {DagCanvas} — Reference to the canvas for event dispatch */
  #canvas = null;
}
```

### 2.3 Concrete Command Classes — Complete Data Model

Each command class captures exactly the data required to reverse itself. Commands reference nodes and connections by **ID** (string), never by object reference, to avoid stale reference bugs when graph state changes between undo/redo operations.

#### 2.3.1 AddNodeCommand

```javascript
class AddNodeCommand extends Command {
  /** @type {string} */
  #nodeId;

  /** @type {Object} — Full node data snapshot at creation time */
  #nodeData;
  // {
  //   id: string,           // e.g., 'node_7'
  //   type: string,         // 'sql-table' | 'sql-mlv' | 'pyspark-mlv'
  //   name: string,         // e.g., 'orders'
  //   schema: string,       // e.g., 'dbo', 'bronze', 'silver', 'gold'
  //   x: number,            // Canvas X position
  //   y: number,            // Canvas Y position
  //   width: number,        // Node width (default 220)
  //   height: number,       // Node height (default 80)
  // }

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'add-node'; }
  get description() {
    const typeLabel = {
      'sql-table': 'SQL Table',
      'sql-mlv': 'SQL MLV',
      'pyspark-mlv': 'PySpark MLV'
    }[this.#nodeData.type];
    return `Add ${typeLabel} '${this.#nodeData.name}'`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {Object} nodeData — Complete node data object
   */
  constructor(canvas, nodeData) {
    super();
    this.#canvas = canvas;
    this.#nodeId = nodeData.id;
    this.#nodeData = structuredClone(nodeData);
  }

  execute() {
    this.#canvas.addNodeDirect(this.#nodeData);
  }

  undo() {
    // When undoing an add, remove the node.
    // Any connections created AFTER this node was added would have
    // their own separate commands — they are NOT cascaded here.
    // The undo stack ordering guarantees those connection commands
    // are undone BEFORE this AddNodeCommand is reached.
    this.#canvas.removeNodeDirect(this.#nodeId);
  }
}
```

**Memory per instance:** ~200 bytes (node data object + string references).

#### 2.3.2 DeleteNodeCommand

This is the most complex command because deleting a node also removes all its connections. The command must capture the full connection state to restore on undo.

```javascript
class DeleteNodeCommand extends Command {
  /** @type {string} */
  #nodeId;

  /** @type {Object} — Full node data snapshot before deletion */
  #nodeData;

  /** @type {Object[]} — All connections involving this node, captured before deletion */
  #affectedConnections;
  // Each connection: {
  //   id: string,           // e.g., 'conn_3'
  //   sourceNodeId: string, // Source node ID
  //   targetNodeId: string, // Target node ID
  //   sourcePortId: string, // Source port identifier
  //   targetPortId: string, // Target port identifier
  // }

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'delete-node'; }
  get description() {
    const count = this.#affectedConnections.length;
    const connSuffix = count > 0 ? ` (+ ${count} connection${count > 1 ? 's' : ''})` : '';
    return `Delete '${this.#nodeData.name}'${connSuffix}`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {string} nodeId — ID of node to delete
   * @param {Object} nodeData — Full node data snapshot (captured BEFORE deletion)
   * @param {Object[]} affectedConnections — All connections touching this node
   */
  constructor(canvas, nodeId, nodeData, affectedConnections) {
    super();
    this.#canvas = canvas;
    this.#nodeId = nodeId;
    this.#nodeData = structuredClone(nodeData);
    this.#affectedConnections = structuredClone(affectedConnections);
  }

  execute() {
    // Remove all connections first (order matters for graph integrity)
    for (const conn of this.#affectedConnections) {
      this.#canvas.removeConnectionDirect(conn.id);
    }
    // Then remove the node
    this.#canvas.removeNodeDirect(this.#nodeId);
  }

  undo() {
    // Restore node first
    this.#canvas.addNodeDirect(this.#nodeData);
    // Then restore all connections
    for (const conn of this.#affectedConnections) {
      this.#canvas.addConnectionDirect(conn);
    }
  }
}
```

**Memory per instance:** ~400 bytes base + ~100 bytes per affected connection. Worst case (node with 20 connections): ~2.4 KB.

#### 2.3.3 MoveNodeCommand

Captures before/after position for a single node drag operation.

```javascript
class MoveNodeCommand extends Command {
  /** @type {string} */
  #nodeId;

  /** @type {string} — Node name for description */
  #nodeName;

  /** @type {{x: number, y: number}} — Position before move */
  #oldPosition;

  /** @type {{x: number, y: number}} — Position after move */
  #newPosition;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'move-node'; }
  get description() {
    return `Move '${this.#nodeName}'`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {string} nodeId
   * @param {string} nodeName
   * @param {{x: number, y: number}} oldPosition — Position before drag
   * @param {{x: number, y: number}} newPosition — Position after drag
   */
  constructor(canvas, nodeId, nodeName, oldPosition, newPosition) {
    super();
    this.#canvas = canvas;
    this.#nodeId = nodeId;
    this.#nodeName = nodeName;
    this.#oldPosition = { ...oldPosition };
    this.#newPosition = { ...newPosition };
  }

  execute() {
    this.#canvas.setNodePositionDirect(this.#nodeId, this.#newPosition);
  }

  undo() {
    this.#canvas.setNodePositionDirect(this.#nodeId, this.#oldPosition);
  }
}
```

**Memory per instance:** ~150 bytes. This is the most common command (users drag nodes frequently).

**Important: Drag coalescing.** During a drag operation, the canvas fires many intermediate position updates (every mousemove frame). The MoveNodeCommand is created ONCE, at `pointerup`, capturing the position at `pointerdown` (old) and `pointerup` (new). Intermediate positions are NOT recorded as separate commands.

#### 2.3.4 AddConnectionCommand

```javascript
class AddConnectionCommand extends Command {
  /** @type {Object} — Full connection data */
  #connectionData;
  // {
  //   id: string,
  //   sourceNodeId: string,
  //   targetNodeId: string,
  //   sourcePortId: string,
  //   targetPortId: string,
  // }

  /** @type {string} — Source node name for description */
  #sourceNodeName;

  /** @type {string} — Target node name for description */
  #targetNodeName;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'add-connection'; }
  get description() {
    return `Connect '${this.#sourceNodeName}' → '${this.#targetNodeName}'`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {Object} connectionData
   * @param {string} sourceNodeName
   * @param {string} targetNodeName
   */
  constructor(canvas, connectionData, sourceNodeName, targetNodeName) {
    super();
    this.#canvas = canvas;
    this.#connectionData = structuredClone(connectionData);
    this.#sourceNodeName = sourceNodeName;
    this.#targetNodeName = targetNodeName;
  }

  execute() {
    this.#canvas.addConnectionDirect(this.#connectionData);
  }

  undo() {
    this.#canvas.removeConnectionDirect(this.#connectionData.id);
  }
}
```

**Memory per instance:** ~180 bytes.

#### 2.3.5 DeleteConnectionCommand

```javascript
class DeleteConnectionCommand extends Command {
  /** @type {Object} — Full connection data snapshot (captured before deletion) */
  #connectionData;

  /** @type {string} */
  #sourceNodeName;

  /** @type {string} */
  #targetNodeName;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'delete-connection'; }
  get description() {
    return `Disconnect '${this.#sourceNodeName}' → '${this.#targetNodeName}'`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {Object} connectionData — Full snapshot captured BEFORE deletion
   * @param {string} sourceNodeName
   * @param {string} targetNodeName
   */
  constructor(canvas, connectionData, sourceNodeName, targetNodeName) {
    super();
    this.#canvas = canvas;
    this.#connectionData = structuredClone(connectionData);
    this.#sourceNodeName = sourceNodeName;
    this.#targetNodeName = targetNodeName;
  }

  execute() {
    this.#canvas.removeConnectionDirect(this.#connectionData.id);
  }

  undo() {
    this.#canvas.addConnectionDirect(this.#connectionData);
  }
}
```

**Memory per instance:** ~180 bytes.

#### 2.3.6 RenameNodeCommand

```javascript
class RenameNodeCommand extends Command {
  /** @type {string} */
  #nodeId;

  /** @type {string} — Name before change */
  #oldName;

  /** @type {string} — Name after change */
  #newName;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'rename-node'; }
  get description() {
    return `Rename '${this.#oldName}' → '${this.#newName}'`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {string} nodeId
   * @param {string} oldName
   * @param {string} newName
   */
  constructor(canvas, nodeId, oldName, newName) {
    super();
    this.#canvas = canvas;
    this.#nodeId = nodeId;
    this.#oldName = oldName;
    this.#newName = newName;
  }

  execute() {
    this.#canvas.setNodePropertyDirect(this.#nodeId, 'name', this.#newName);
  }

  undo() {
    this.#canvas.setNodePropertyDirect(this.#nodeId, 'name', this.#oldName);
  }
}
```

**Memory per instance:** ~120 bytes.

#### 2.3.7 ChangeNodeTypeCommand

Changing a node's type (e.g., SQL Table → SQL MLV) may also affect its schema or generated code. The command captures the full before/after type and any dependent property changes.

```javascript
class ChangeNodeTypeCommand extends Command {
  /** @type {string} */
  #nodeId;

  /** @type {string} */
  #nodeName;

  /** @type {string} — Type before change ('sql-table' | 'sql-mlv' | 'pyspark-mlv') */
  #oldType;

  /** @type {string} — Type after change */
  #newType;

  /** @type {string} — Schema before change (type change may reset schema) */
  #oldSchema;

  /** @type {string} — Schema after change */
  #newSchema;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'change-node-type'; }
  get description() {
    const labels = {
      'sql-table': 'SQL Table',
      'sql-mlv': 'SQL MLV',
      'pyspark-mlv': 'PySpark MLV'
    };
    return `Change '${this.#nodeName}' from ${labels[this.#oldType]} to ${labels[this.#newType]}`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {string} nodeId
   * @param {string} nodeName
   * @param {string} oldType
   * @param {string} newType
   * @param {string} oldSchema
   * @param {string} newSchema
   */
  constructor(canvas, nodeId, nodeName, oldType, newType, oldSchema, newSchema) {
    super();
    this.#canvas = canvas;
    this.#nodeId = nodeId;
    this.#nodeName = nodeName;
    this.#oldType = oldType;
    this.#newType = newType;
    this.#oldSchema = oldSchema;
    this.#newSchema = newSchema;
  }

  execute() {
    this.#canvas.setNodePropertyDirect(this.#nodeId, 'type', this.#newType);
    if (this.#oldSchema !== this.#newSchema) {
      this.#canvas.setNodePropertyDirect(this.#nodeId, 'schema', this.#newSchema);
    }
  }

  undo() {
    this.#canvas.setNodePropertyDirect(this.#nodeId, 'type', this.#oldType);
    if (this.#oldSchema !== this.#newSchema) {
      this.#canvas.setNodePropertyDirect(this.#nodeId, 'schema', this.#oldSchema);
    }
  }
}
```

**Memory per instance:** ~200 bytes.

#### 2.3.8 ChangeNodeSchemaCommand

```javascript
class ChangeNodeSchemaCommand extends Command {
  /** @type {string} */
  #nodeId;

  /** @type {string} */
  #nodeName;

  /** @type {string} — Schema before change ('dbo' | 'bronze' | 'silver' | 'gold') */
  #oldSchema;

  /** @type {string} — Schema after change */
  #newSchema;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'change-node-schema'; }
  get description() {
    return `Change '${this.#nodeName}' schema: ${this.#oldSchema} → ${this.#newSchema}`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {string} nodeId
   * @param {string} nodeName
   * @param {string} oldSchema
   * @param {string} newSchema
   */
  constructor(canvas, nodeId, nodeName, oldSchema, newSchema) {
    super();
    this.#canvas = canvas;
    this.#nodeId = nodeId;
    this.#nodeName = nodeName;
    this.#oldSchema = oldSchema;
    this.#newSchema = newSchema;
  }

  execute() {
    this.#canvas.setNodePropertyDirect(this.#nodeId, 'schema', this.#newSchema);
  }

  undo() {
    this.#canvas.setNodePropertyDirect(this.#nodeId, 'schema', this.#oldSchema);
  }
}
```

**Memory per instance:** ~120 bytes.

#### 2.3.9 AutoLayoutCommand

Auto-layout is a compound operation that repositions ALL nodes simultaneously. The command captures every node's position before and after layout, enabling a single undo to restore the entire canvas to its pre-layout state.

```javascript
class AutoLayoutCommand extends Command {
  /**
   * @type {Map<string, {x: number, y: number}>}
   * Maps nodeId → position BEFORE layout
   */
  #oldPositions;

  /**
   * @type {Map<string, {x: number, y: number}>}
   * Maps nodeId → position AFTER layout
   */
  #newPositions;

  /** @type {number} — Number of nodes affected */
  #nodeCount;

  /** @type {DagCanvas} */
  #canvas;

  get type() { return 'auto-layout'; }
  get description() {
    return `Auto-arrange ${this.#nodeCount} node${this.#nodeCount !== 1 ? 's' : ''}`;
  }

  /**
   * @param {DagCanvas} canvas
   * @param {Map<string, {x: number, y: number}>} oldPositions
   * @param {Map<string, {x: number, y: number}>} newPositions
   */
  constructor(canvas, oldPositions, newPositions) {
    super();
    this.#canvas = canvas;
    this.#oldPositions = new Map(oldPositions);
    this.#newPositions = new Map(newPositions);
    this.#nodeCount = oldPositions.size;
  }

  execute() {
    for (const [nodeId, pos] of this.#newPositions) {
      this.#canvas.setNodePositionDirect(nodeId, pos);
    }
  }

  undo() {
    for (const [nodeId, pos] of this.#oldPositions) {
      this.#canvas.setNodePositionDirect(nodeId, pos);
    }
  }
}
```

**Memory per instance:** ~24 bytes per node position entry × 2 maps. At 100 nodes: ~4.8 KB. This is the heaviest single command, and the reason we use a 50-level cap rather than unlimited.

**Animation note:** When execute() or undo() is called, the canvas may optionally animate nodes to their new positions (300ms transition). The command itself does NOT handle animation — it sets final positions, and the canvas's `setNodePositionDirect` method can optionally animate if an `animate` flag is set. During rapid undo/redo (holding Ctrl+Z), animation should be suppressed (see §9.3).

#### 2.3.10 BatchCommand

BatchCommand is the composite pattern — it wraps N sub-commands into a single undoable unit. Used for:
- **Multi-select delete:** User selects 5 nodes + Backspace → one BatchCommand containing 5 DeleteNodeCommands (each with its connections)
- **Multi-select move:** Drag-move a selection of nodes → one BatchCommand containing N MoveNodeCommands
- Any future compound operation

```javascript
class BatchCommand extends Command {
  /** @type {Command[]} — Sub-commands in execution order */
  #commands;

  /** @type {string} — Batch-level description override */
  #batchDescription;

  get type() { return 'batch'; }
  get description() { return this.#batchDescription; }

  /** @type {number} — How many sub-commands are in this batch */
  get size() { return this.#commands.length; }

  /**
   * @param {Command[]} commands — Sub-commands (must be in correct execution order)
   * @param {string} [batchDescription] — Override description
   *   If not provided, auto-generates from sub-commands.
   */
  constructor(commands, batchDescription) {
    super();
    if (!commands || commands.length === 0) {
      throw new Error('BatchCommand requires at least one sub-command');
    }
    this.#commands = [...commands]; // Shallow copy — commands are immutable
    this.#batchDescription = batchDescription ||
      BatchCommand.#generateDescription(commands);
  }

  execute() {
    // Execute sub-commands in forward order
    for (const cmd of this.#commands) {
      cmd.execute();
    }
  }

  undo() {
    // Undo sub-commands in REVERSE order — critical for correctness
    for (let i = this.#commands.length - 1; i >= 0; i--) {
      this.#commands[i].undo();
    }
  }

  /**
   * Generate a human-readable description from sub-commands.
   * @param {Command[]} commands
   * @returns {string}
   */
  static #generateDescription(commands) {
    if (commands.length === 1) {
      return commands[0].description;
    }

    // Group by type for compact description
    const typeCounts = {};
    for (const cmd of commands) {
      typeCounts[cmd.type] = (typeCounts[cmd.type] || 0) + 1;
    }

    const parts = [];
    const typeLabels = {
      'add-node': 'node addition',
      'delete-node': 'node deletion',
      'move-node': 'node move',
      'add-connection': 'connection',
      'delete-connection': 'disconnection',
      'rename-node': 'rename',
      'change-node-type': 'type change',
      'change-node-schema': 'schema change',
    };

    for (const [type, count] of Object.entries(typeCounts)) {
      const label = typeLabels[type] || type;
      parts.push(`${count} ${label}${count > 1 ? 's' : ''}`);
    }

    return `Batch: ${parts.join(', ')}`;
  }
}
```

**Memory per instance:** Overhead is ~50 bytes + the sum of all sub-command memory. For a multi-select delete of 5 nodes with 10 total connections: ~50 + (5 × 400) + (10 × 100) = ~3 KB.

**Reverse-order undo is critical.** If sub-commands are [AddNode_A, AddConnection_A→B], then undo must be [RemoveConnection_A→B, RemoveNode_A]. Reversing the order ensures connections are removed before the nodes they reference, preventing dangling-reference errors.

### 2.4 Memory Budget Analysis

Worst-case memory analysis for a full 50-level undo stack:

| Scenario | Avg. Command Size | Stack Memory |
|----------|-------------------|--------------|
| 50 × MoveNodeCommand | 150 bytes | 7.5 KB |
| 50 × AddNodeCommand | 200 bytes | 10 KB |
| 50 × DeleteNodeCommand (avg 3 conns) | 700 bytes | 35 KB |
| 50 × AutoLayoutCommand (100 nodes) | 4.8 KB | 240 KB |
| 50 × BatchCommand (5 deletes, 10 conns each) | 3 KB | 150 KB |
| **Realistic mixed workload** | ~500 bytes avg | **~25 KB** |

**Conclusion:** Even in the absolute worst case (50 auto-layout operations on a 100-node graph), the undo stack consumes ~240 KB. In a realistic workflow, the stack is ~25 KB. This is negligible relative to the JointJS graph model and SVG DOM, which consume 5–20 MB for a 100-node canvas.

The redo stack is bounded by the undo stack (it can never be larger), so total maximum memory for both stacks combined is ~480 KB worst-case, ~50 KB realistic.

---

## 3. API Surface

### 3.1 UndoRedoManager — Public Methods

```javascript
class UndoRedoManager {
  // ──────────────────────────────────────────
  // Construction & Lifecycle
  // ──────────────────────────────────────────

  /**
   * Create a new UndoRedoManager.
   * @param {DagCanvas} canvas — Reference to the owning canvas
   * @param {Object} [options]
   * @param {number} [options.maxDepth=50] — Maximum undo stack size
   * @param {Function} [options.onStateChange] — Called on every stack mutation
   */
  constructor(canvas, options = {}) { }

  /**
   * Tear down the manager. Clears both stacks and removes
   * all references. Called when leaving Page 3 or closing the wizard.
   * @returns {void}
   */
  destroy() { }

  // ──────────────────────────────────────────
  // Core Operations
  // ──────────────────────────────────────────

  /**
   * Execute a command and push it onto the undo stack.
   * Clears the redo stack (forking the timeline).
   * Enforces maxDepth by evicting the oldest command if needed.
   *
   * @param {Command} command — The command to execute
   * @returns {void}
   * @throws {Error} If called during an undo/redo operation (re-entrancy guard)
   */
  execute(command) { }

  /**
   * Undo the most recent command.
   * Pops from undo stack, calls command.undo(), pushes to redo stack.
   * No-op if undo stack is empty.
   *
   * @returns {boolean} — true if an undo was performed, false if stack was empty
   */
  undo() { }

  /**
   * Redo the most recently undone command.
   * Pops from redo stack, calls command.execute(), pushes to undo stack.
   * No-op if redo stack is empty.
   *
   * @returns {boolean} — true if a redo was performed, false if stack was empty
   */
  redo() { }

  // ──────────────────────────────────────────
  // State Queries
  // ──────────────────────────────────────────

  /**
   * Whether the undo stack has any commands.
   * Used to enable/disable the Undo button.
   * @type {boolean}
   */
  get canUndo() { }

  /**
   * Whether the redo stack has any commands.
   * Used to enable/disable the Redo button.
   * @type {boolean}
   */
  get canRedo() { }

  /**
   * Number of commands in the undo stack.
   * @type {number}
   */
  get undoDepth() { }

  /**
   * Number of commands in the redo stack.
   * @type {number}
   */
  get redoDepth() { }

  /**
   * Description of the next command that would be undone.
   * Used for tooltip: "Undo: Move 'orders'"
   * @type {string|null} — null if undo stack is empty
   */
  get undoDescription() { }

  /**
   * Description of the next command that would be redone.
   * Used for tooltip: "Redo: Add SQL Table 'customers'"
   * @type {string|null} — null if redo stack is empty
   */
  get redoDescription() { }

  // ──────────────────────────────────────────
  // Stack Management
  // ──────────────────────────────────────────

  /**
   * Clear both undo and redo stacks. Called when:
   * - User leaves Page 3 (DAG confirmed)
   * - Template is loaded (replaces entire graph state)
   * - Canvas is reset to empty
   *
   * @returns {void}
   */
  clear() { }

  /**
   * Replace the maximum stack depth. If current stack
   * exceeds the new limit, oldest commands are evicted.
   * @param {number} depth — New maximum (must be >= 1)
   * @returns {void}
   */
  setMaxDepth(depth) { }

  /**
   * Get a read-only snapshot of the current undo stack
   * for debugging/inspector purposes.
   * @returns {Array<{type: string, description: string}>}
   */
  getUndoHistory() { }

  /**
   * Get a read-only snapshot of the current redo stack
   * for debugging/inspector purposes.
   * @returns {Array<{type: string, description: string}>}
   */
  getRedoHistory() { }
}
```

### 3.2 Full Implementation — Core Methods

```javascript
execute(command) {
  // Re-entrancy guard: prevent execute() calls triggered
  // by event handlers during undo/redo
  if (this.#isApplying) {
    console.warn(
      `[UndoRedoManager] Ignored re-entrant execute('${command.type}') ` +
      `during active ${this.#isApplying} operation`
    );
    return;
  }

  // Execute the command
  command.execute();

  // Push to undo stack
  this.#undoStack.push(command);

  // Clear redo stack — new action forks the timeline
  this.#redoStack.length = 0;

  // Enforce max depth — evict oldest if over limit
  while (this.#undoStack.length > this.#maxDepth) {
    this.#undoStack.shift();
  }

  // Notify UI of state change
  this.#notifyStateChange();
}

undo() {
  if (this.#undoStack.length === 0) return false;

  const command = this.#undoStack.pop();

  this.#isApplying = 'undo';
  try {
    command.undo();
  } finally {
    this.#isApplying = false;
  }

  this.#redoStack.push(command);

  this.#notifyStateChange();
  return true;
}

redo() {
  if (this.#redoStack.length === 0) return false;

  const command = this.#redoStack.pop();

  this.#isApplying = 'redo';
  try {
    command.execute();
  } finally {
    this.#isApplying = false;
  }

  this.#undoStack.push(command);

  this.#notifyStateChange();
  return true;
}

clear() {
  this.#undoStack.length = 0;
  this.#redoStack.length = 0;
  this.#notifyStateChange();
}

destroy() {
  this.clear();
  this.#canvas = null;
  this.#onStateChange = null;
}

get canUndo() { return this.#undoStack.length > 0; }
get canRedo() { return this.#redoStack.length > 0; }
get undoDepth() { return this.#undoStack.length; }
get redoDepth() { return this.#redoStack.length; }

get undoDescription() {
  if (this.#undoStack.length === 0) return null;
  return this.#undoStack[this.#undoStack.length - 1].description;
}

get redoDescription() {
  if (this.#redoStack.length === 0) return null;
  return this.#redoStack[this.#redoStack.length - 1].description;
}

getUndoHistory() {
  return this.#undoStack.map(cmd => ({
    type: cmd.type,
    description: cmd.description
  }));
}

getRedoHistory() {
  return this.#redoStack.map(cmd => ({
    type: cmd.type,
    description: cmd.description
  }));
}

setMaxDepth(depth) {
  if (depth < 1) throw new RangeError('maxDepth must be >= 1');
  this.#maxDepth = depth;
  while (this.#undoStack.length > this.#maxDepth) {
    this.#undoStack.shift();
  }
  this.#notifyStateChange();
}

/**
 * Notify the UI that undo/redo state has changed.
 * The callback receives a frozen snapshot of the current state.
 * @private
 */
#notifyStateChange() {
  if (this.#onStateChange) {
    this.#onStateChange({
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoDepth: this.undoDepth,
      redoDepth: this.redoDepth,
      undoDescription: this.undoDescription,
      redoDescription: this.redoDescription,
    });
  }
}
```

### 3.3 DagCanvas — Required "Direct" API

The UndoRedoManager and its Command objects call these methods on DagCanvas. These are "direct" (non-undoable) mutations — they modify the graph model and DOM without creating new commands. This prevents infinite recursion (command.execute() → canvas action → new command → execute...).

```javascript
// Required methods on DagCanvas for undo/redo support:

class DagCanvas {
  /**
   * Add a node to the graph without creating an undo command.
   * Used by AddNodeCommand.execute() and DeleteNodeCommand.undo().
   * @param {Object} nodeData — Full node data object
   */
  addNodeDirect(nodeData) { }

  /**
   * Remove a node from the graph without creating an undo command.
   * Does NOT cascade-remove connections (caller handles that).
   * Used by AddNodeCommand.undo() and DeleteNodeCommand.execute().
   * @param {string} nodeId
   */
  removeNodeDirect(nodeId) { }

  /**
   * Add a connection without creating an undo command.
   * Used by AddConnectionCommand.execute() and DeleteConnectionCommand.undo().
   * @param {Object} connectionData — Full connection data
   */
  addConnectionDirect(connectionData) { }

  /**
   * Remove a connection without creating an undo command.
   * Used by AddConnectionCommand.undo() and DeleteConnectionCommand.execute().
   * @param {string} connectionId
   */
  removeConnectionDirect(connectionId) { }

  /**
   * Set a node's position without creating an undo command.
   * Used by MoveNodeCommand and AutoLayoutCommand.
   * @param {string} nodeId
   * @param {{x: number, y: number}} position
   */
  setNodePositionDirect(nodeId, position) { }

  /**
   * Set a single property on a node without creating an undo command.
   * Used by RenameNodeCommand, ChangeNodeTypeCommand, ChangeNodeSchemaCommand.
   * @param {string} nodeId
   * @param {string} property — 'name' | 'type' | 'schema'
   * @param {*} value
   */
  setNodePropertyDirect(nodeId, property, value) { }

  /**
   * Get a snapshot of a node's data. Used when constructing
   * delete commands (need to capture state before deletion).
   * @param {string} nodeId
   * @returns {Object} — Deep copy of node data
   */
  getNodeData(nodeId) { }

  /**
   * Get all connections involving a node. Used when constructing
   * DeleteNodeCommand (need to capture affected connections).
   * @param {string} nodeId
   * @returns {Object[]} — Array of connection data objects
   */
  getNodeConnections(nodeId) { }

  /**
   * Get all node positions. Used by AutoLayoutCommand to
   * capture before-positions.
   * @returns {Map<string, {x: number, y: number}>}
   */
  getAllNodePositions() { }
}
```

### 3.4 Integration Pattern — How Canvas Creates Commands

The DagCanvas exposes "public" action methods that users trigger through the UI. These methods create commands and route them through the UndoRedoManager:

```javascript
// In DagCanvas:

/** User-facing: add a node (creates undo command) */
addNode(type, name, schema, position) {
  const nodeData = {
    id: this.#generateNodeId(),
    type,
    name,
    schema,
    x: position.x,
    y: position.y,
    width: 220,
    height: 80,
  };
  const cmd = new AddNodeCommand(this, nodeData);
  this.#undoRedoManager.execute(cmd);
  return nodeData.id;
}

/** User-facing: delete a node (creates undo command with cascading connections) */
deleteNode(nodeId) {
  const nodeData = this.getNodeData(nodeId);
  const connections = this.getNodeConnections(nodeId);
  const cmd = new DeleteNodeCommand(this, nodeId, nodeData, connections);
  this.#undoRedoManager.execute(cmd);
}

/** User-facing: move a node (creates undo command after drag completes) */
onNodeDragEnd(nodeId, nodeName, startPos, endPos) {
  // Only create command if position actually changed
  if (startPos.x === endPos.x && startPos.y === endPos.y) return;
  const cmd = new MoveNodeCommand(this, nodeId, nodeName, startPos, endPos);
  this.#undoRedoManager.execute(cmd);
}

/** User-facing: add connection (creates undo command) */
addConnection(sourceNodeId, targetNodeId, sourcePortId, targetPortId) {
  const connectionData = {
    id: this.#generateConnectionId(),
    sourceNodeId,
    targetNodeId,
    sourcePortId,
    targetPortId,
  };
  const sourceNode = this.getNodeData(sourceNodeId);
  const targetNode = this.getNodeData(targetNodeId);
  const cmd = new AddConnectionCommand(
    this, connectionData, sourceNode.name, targetNode.name
  );
  this.#undoRedoManager.execute(cmd);
  return connectionData.id;
}

/** User-facing: delete selected nodes (creates batch command) */
deleteSelectedNodes(selectedNodeIds) {
  if (selectedNodeIds.length === 0) return;

  if (selectedNodeIds.length === 1) {
    this.deleteNode(selectedNodeIds[0]);
    return;
  }

  // Multi-select delete → BatchCommand
  const subCommands = [];
  for (const nodeId of selectedNodeIds) {
    const nodeData = this.getNodeData(nodeId);
    const connections = this.getNodeConnections(nodeId);
    subCommands.push(new DeleteNodeCommand(this, nodeId, nodeData, connections));
  }

  const description = `Delete ${selectedNodeIds.length} selected nodes`;
  const batchCmd = new BatchCommand(subCommands, description);
  this.#undoRedoManager.execute(batchCmd);
}

/** User-facing: auto-layout (creates compound undo command) */
autoLayout() {
  const oldPositions = this.getAllNodePositions();

  // Compute new positions via dagre (C13-AutoLayoutEngine)
  const newPositions = this.#layoutEngine.computeLayout(
    this.getNodes(),
    this.getConnections()
  );

  const cmd = new AutoLayoutCommand(this, oldPositions, newPositions);
  this.#undoRedoManager.execute(cmd);
}
```

### 3.5 Event Interface — onStateChange Callback

The `onStateChange` callback is the primary integration point between UndoRedoManager and the canvas toolbar UI:

```javascript
// In DagCanvas initialization:
this.#undoRedoManager = new UndoRedoManager(this, {
  maxDepth: 50,
  onStateChange: (state) => {
    // Update toolbar button states
    this.#undoButton.disabled = !state.canUndo;
    this.#redoButton.disabled = !state.canRedo;

    // Update tooltips
    this.#undoButton.title = state.undoDescription
      ? `Undo: ${state.undoDescription} (Ctrl+Z)`
      : 'Nothing to undo';
    this.#redoButton.title = state.redoDescription
      ? `Redo: ${state.redoDescription} (Ctrl+Y)`
      : 'Nothing to redo';

    // Update aria attributes
    this.#undoButton.setAttribute('aria-label',
      state.undoDescription
        ? `Undo: ${state.undoDescription}`
        : 'Undo (nothing to undo)'
    );
    this.#redoButton.setAttribute('aria-label',
      state.redoDescription
        ? `Redo: ${state.redoDescription}`
        : 'Redo (nothing to redo)'
    );

    // Announce to screen readers on undo/redo action
    // (handled separately in the undo/redo keyboard handler)
  }
});
```

---

## 4. State Machine

### 4.1 Manager States

UndoRedoManager has 4 primary states, determined by stack contents and the `#isApplying` guard:

```
                    ┌───────────────┐
          ┌────────►│     EMPTY     │◄────── clear() / destroy()
          │         │ canUndo=false │
          │         │ canRedo=false │
          │         └───────┬───────┘
          │                 │ execute(cmd)
          │                 ▼
          │         ┌───────────────┐
          │         │  HAS_UNDO     │◄────── execute(cmd)
  clear() │         │ canUndo=true  │        [clears redo]
          │         │ canRedo=false │
          │         └───┬───────┬───┘
          │     undo()  │       │ execute(cmd) [stays here]
          │             ▼       │
          │         ┌───────────────┐
          │         │  HAS_BOTH     │
          ├─────────│ canUndo=true  │
          │         │ canRedo=true  │
          │         └───┬───────┬───┘
          │     redo()  │       │ undo() [last undo item?]
          │     [goes   │       │
          │      back   │       ▼
          │      up]    │   ┌───────────────┐
          │             │   │  HAS_REDO     │
          └─────────────┘   │ canUndo=false │
                            │ canRedo=true  │
                            └───────┬───────┘
                                    │ execute(cmd) → HAS_UNDO
                                    │ redo() → may go to HAS_BOTH
                                    │ redo() [last item] → HAS_UNDO
```

### 4.2 Transition Table

| Current State | Action | Condition | Next State | Side Effects |
|---------------|--------|-----------|------------|--------------|
| EMPTY | `execute(cmd)` | — | HAS_UNDO | Push to undoStack |
| EMPTY | `undo()` | — | EMPTY | No-op, return false |
| EMPTY | `redo()` | — | EMPTY | No-op, return false |
| EMPTY | `clear()` | — | EMPTY | No-op |
| HAS_UNDO | `execute(cmd)` | undoStack.length < maxDepth | HAS_UNDO | Push to undoStack, clear redoStack |
| HAS_UNDO | `execute(cmd)` | undoStack.length >= maxDepth | HAS_UNDO | Evict oldest, push to undoStack, clear redoStack |
| HAS_UNDO | `undo()` | undoStack.length > 1 | HAS_BOTH | Pop from undoStack, push to redoStack |
| HAS_UNDO | `undo()` | undoStack.length === 1 | HAS_REDO | Pop from undoStack, push to redoStack |
| HAS_UNDO | `redo()` | — | HAS_UNDO | No-op (redoStack empty), return false |
| HAS_UNDO | `clear()` | — | EMPTY | Clear both stacks |
| HAS_BOTH | `execute(cmd)` | — | HAS_UNDO | Push to undoStack, clear redoStack |
| HAS_BOTH | `undo()` | undoStack.length > 1 | HAS_BOTH | Pop undo, push redo |
| HAS_BOTH | `undo()` | undoStack.length === 1 | HAS_REDO | Pop undo, push redo |
| HAS_BOTH | `redo()` | redoStack.length > 1 | HAS_BOTH | Pop redo, push undo |
| HAS_BOTH | `redo()` | redoStack.length === 1 | HAS_UNDO | Pop redo, push undo |
| HAS_BOTH | `clear()` | — | EMPTY | Clear both stacks |
| HAS_REDO | `execute(cmd)` | — | HAS_UNDO | Push to undoStack, clear redoStack |
| HAS_REDO | `undo()` | — | HAS_REDO | No-op (undoStack empty), return false |
| HAS_REDO | `redo()` | redoStack.length > 1 | HAS_BOTH | Pop redo, push undo |
| HAS_REDO | `redo()` | redoStack.length === 1 | HAS_UNDO | Pop redo, push undo |
| HAS_REDO | `clear()` | — | EMPTY | Clear both stacks |

### 4.3 Re-Entrancy Guard States

During undo/redo, the `#isApplying` flag prevents command execution from event handlers that fire as a side effect of DOM mutations:

```
    IDLE ──execute(cmd)──→ IDLE
      │
      ├──undo()──→ APPLYING_UNDO ──→ IDLE
      │                │
      │                └── execute() called inside? → IGNORED (warn)
      │
      └──redo()──→ APPLYING_REDO ──→ IDLE
                       │
                       └── execute() called inside? → IGNORED (warn)
```

This guard is essential because JointJS fires `change:position`, `add`, `remove` events during programmatic mutations. Without the guard, undoing a node move would trigger the canvas's "node moved" handler, which would create a NEW MoveNodeCommand, corrupting the stack.

### 4.4 Redo Invalidation (Timeline Forking)

When the user performs undo (creating a redo stack) and then performs a NEW action, the redo stack is cleared. This is the standard "forking timeline" behavior used by every major editor:

```
Timeline:  A → B → C → D
                        ↑ current

User does Undo twice:
Timeline:  A → B → [C] → [D]
                ↑ current    redo stack: [C, D]

User does NEW action E:
Timeline:  A → B → E
                    ↑ current    redo stack: [] (cleared!)

C and D are permanently lost. This is intentional — the user chose
a different future by taking action E. Keeping C and D would require
a tree-based history model (like Vim's undotree), which is out of scope.
```

---

## 5. Scenarios

### 5.1 Scenario: Basic Add → Undo → Redo

```
Given: Empty canvas
When:  User drags "SQL Table" from palette onto canvas
Then:  AddNodeCommand executed
       undoStack = [AddNode('orders')]
       redoStack = []
       Undo button: enabled
       Redo button: disabled

When:  User presses Ctrl+Z
Then:  AddNodeCommand.undo() called — node removed from canvas
       undoStack = []
       redoStack = [AddNode('orders')]
       Undo button: disabled
       Redo button: enabled
       Screen reader: "Undone: Add SQL Table 'orders'"

When:  User presses Ctrl+Y
Then:  AddNodeCommand.execute() called — node re-added to canvas
       undoStack = [AddNode('orders')]
       redoStack = []
       Undo button: enabled
       Redo button: disabled
       Screen reader: "Redone: Add SQL Table 'orders'"
```

### 5.2 Scenario: Delete Node with Cascading Connections

```
Given: Canvas with nodes A, B, C
       Connections: A→B, A→C
When:  User deletes node A
Then:  DeleteNodeCommand captures:
         nodeData: { id: 'A', name: 'orders', type: 'sql-table', ... }
         affectedConnections: [
           { id: 'conn_1', sourceNodeId: 'A', targetNodeId: 'B', ... },
           { id: 'conn_2', sourceNodeId: 'A', targetNodeId: 'C', ... }
         ]
       DeleteNodeCommand.execute():
         1. Remove connection conn_1
         2. Remove connection conn_2
         3. Remove node A
       Canvas shows: B and C remain, no connections
       undoStack = [..., DeleteNode('orders' + 2 connections)]

When:  User presses Ctrl+Z
Then:  DeleteNodeCommand.undo():
         1. Re-add node A at its original position
         2. Re-add connection conn_1 (A→B)
         3. Re-add connection conn_2 (A→C)
       Canvas shows: A, B, C with A→B and A→C restored
```

### 5.3 Scenario: Multi-Select Delete (BatchCommand)

```
Given: Canvas with 5 nodes: A, B, C, D, E
       Connections: A→C, B→C, C→D, C→E
When:  User selects nodes A and B (multi-select with Ctrl+Click)
       User presses Delete key
Then:  BatchCommand created with:
         subCommands: [
           DeleteNodeCommand(A, connections=[A→C]),
           DeleteNodeCommand(B, connections=[B→C])
         ]
       BatchCommand.execute():
         1. DeleteNode(A): remove A→C, remove A
         2. DeleteNode(B): remove B→C, remove B
       Canvas shows: C, D, E with C→D and C→E intact
       undoStack = [..., Batch("Delete 2 selected nodes")]

When:  User presses Ctrl+Z
Then:  BatchCommand.undo() — reverse order:
         1. DeleteNode(B).undo(): re-add B, re-add B→C
         2. DeleteNode(A).undo(): re-add A, re-add A→C
       Canvas shows: all 5 nodes, all 4 connections restored
```

### 5.4 Scenario: Auto-Layout Compound Undo

```
Given: Canvas with 10 nodes manually positioned by user
When:  User clicks "Auto Arrange" button
Then:  AutoLayoutCommand captures:
         oldPositions: Map { node_1 → {x:50,y:30}, node_2 → {x:300,y:80}, ... }
         newPositions: Map { node_1 → {x:100,y:20}, node_2 → {x:100,y:140}, ... }
       AutoLayoutCommand.execute():
         All 10 nodes animate to dagre-computed positions (300ms transition)
       undoStack = [..., AutoLayout(10 nodes)]

When:  User presses Ctrl+Z
Then:  AutoLayoutCommand.undo():
         All 10 nodes animate back to their original manual positions
       User's manual layout is perfectly restored
```

### 5.5 Scenario: Timeline Fork (Redo Invalidation)

```
Given: undoStack = [AddNode(A), AddConn(A→B), MoveNode(B)]
       redoStack = []
When:  User presses Ctrl+Z twice
Then:  undoStack = [AddNode(A)]
       redoStack = [MoveNode(B), AddConn(A→B)]
       // MoveNode undone first (LIFO), then AddConn

When:  User adds new node C (instead of redoing)
Then:  undoStack = [AddNode(A), AddNode(C)]
       redoStack = []  ← CLEARED
       // MoveNode(B) and AddConn(A→B) are permanently lost
       Redo button: disabled
```

### 5.6 Scenario: Stack Overflow — 51st Command Evicts Oldest

```
Given: undoStack has exactly 50 commands (at capacity)
       undoStack[0] = AddNode('node_1')  ← oldest
       undoStack[49] = MoveNode('node_50')  ← newest
When:  User adds a new node ('node_51')
Then:  AddNode('node_1') is evicted (shifted from front)
       AddNode('node_51') is pushed to back
       undoStack.length === 50 (still at cap)
       undoStack[0] = original command #2 (now oldest)
       undoStack[49] = AddNode('node_51') (newest)
       // Ctrl+Z can undo back 50 steps, but NOT to the very first action
```

### 5.7 Scenario: Template Load Clears History

```
Given: undoStack = [cmd1, cmd2, cmd3]
       redoStack = [cmd4]
When:  User loads a template (replaces entire graph)
Then:  UndoRedoManager.clear() is called
       undoStack = []
       redoStack = []
       // Template load is a "fresh start" — can't undo back to pre-template state
       // This is intentional: the old graph no longer exists, undo references
       // would point to non-existent nodes
```

### 5.8 Scenario: Rename → Change Type → Undo × 2

```
Given: Node 'orders' (SQL Table, schema 'dbo')
When:  User renames to 'customer_orders'
Then:  undoStack = [..., RenameNode('orders' → 'customer_orders')]

When:  User changes type to SQL MLV
Then:  undoStack = [..., RenameNode, ChangeNodeType('customer_orders': SQL Table → SQL MLV)]

When:  User presses Ctrl+Z
Then:  ChangeNodeType.undo(): type restored to SQL Table
       Node shows as SQL Table again
       undoStack = [..., RenameNode]
       redoStack = [ChangeNodeType]

When:  User presses Ctrl+Z again
Then:  RenameNode.undo(): name restored to 'orders'
       Node shows name 'orders'
       undoStack = [...]
       redoStack = [ChangeNodeType, RenameNode]

When:  User presses Ctrl+Y
Then:  RenameNode.execute(): name changed back to 'customer_orders'
       undoStack = [..., RenameNode]
       redoStack = [ChangeNodeType]
```

### 5.9 Scenario: Page Navigation — Leaving Page 3

```
Given: User is on Page 3 (DAG Canvas)
       undoStack has 15 commands
When:  User clicks "Next: Review & Save" (navigates to Page 4)
Then:  UndoRedoManager.clear() is called
       Both stacks emptied
       // Rationale: Page 4 shows a read-only summary. If user goes Back
       // to Page 3, it's a fresh editing session. The DAG state is preserved
       // in the canvas data model — only the undo HISTORY is cleared.
       // This prevents confusion where undo on a "resumed" session
       // could reference commands from a previous editing pass.

When:  User clicks "Back" from Page 4 to return to Page 3
Then:  Canvas shows the DAG as it was left
       undoStack = [] (empty — fresh history)
       New edits start a new command history
```

### 5.10 Scenario: Rapid Undo (Holding Ctrl+Z)

```
Given: undoStack has 20 commands
When:  User holds Ctrl+Z (key repeat fires ~30 times/second)
Then:  Each keydown event triggers one undo() call
       Commands are undone at ~30/second
       Animation is suppressed (no 300ms transitions during rapid undo)
       After ~0.7 seconds, all 20 commands are undone
       undoStack = []
       redoStack = [20 commands in reverse order]
       Undo button transitions to disabled
       Screen reader: "Nothing to undo" (announced once, not 20 times)
```

### 5.11 Scenario: Connection Undo with Node Already Deleted

This edge case cannot occur in our architecture because:

1. Undo is strictly LIFO — you cannot skip commands
2. If a node was deleted AFTER a connection was added, the delete command is above the add-connection command on the stack
3. Undoing proceeds top-down: first the delete is undone (node restored), THEN the connection command is undone

The stack ordering inherently prevents stale-reference issues:

```
Stack (bottom to top):
  [0] AddNode(A)
  [1] AddNode(B)
  [2] AddConnection(A→B)
  [3] DeleteNode(A)  ← includes A→B in its captured connections

Undo sequence:
  Step 1: Undo DeleteNode(A) → A restored, A→B restored
  Step 2: Undo AddConnection(A→B) → A→B removed ← node A exists, safe!
  Step 3: Undo AddNode(B) → B removed
  Step 4: Undo AddNode(A) → A removed
```

If this ordering invariant were ever violated (e.g., by a bug), the error handling in §8 catches it.

---

## 6. Visual Spec

### 6.1 Toolbar Integration

The undo/redo buttons live in the canvas toolbar (left sidebar panel), below the node palette controls:

```
┌──────────┐
│  +SQL    │  ← Node palette (C5)
│  +MLV    │
│  +Spark  │
│──────────│
│ [Arrange]│  ← Auto-layout (C13)
│ [Fit]    │
│──────────│
│ [↶ Undo] │  ← Undo button
│ [↷ Redo] │  ← Redo button
│──────────│
│          │
└──────────┘
```

### 6.2 Button States

#### Undo Button

| State | Visual | Behavior |
|-------|--------|----------|
| **Enabled** | Icon: `↶` (U+21B6), `oklch(0.25 0 0)` text, `oklch(0.97 0 0)` background | Click → undo last command |
| **Disabled** | Icon: `↶`, `oklch(0.70 0 0)` text, `oklch(0.95 0 0)` background, `cursor: default` | Click → no-op, no visual feedback |
| **Hover (enabled)** | Background: `oklch(0.93 0 0)`, subtle elevation | Tooltip: "Undo: Move 'orders' (Ctrl+Z)" |
| **Active (click)** | Background: `oklch(0.90 0 0)`, pressed appearance, 100ms transition | — |
| **Focus (keyboard)** | 2px `oklch(0.55 0.20 250)` focus ring, matches design system | — |

#### Redo Button

| State | Visual | Behavior |
|-------|--------|----------|
| **Enabled** | Icon: `↷` (U+21B7), same colors as undo enabled | Click → redo last undone command |
| **Disabled** | Same disabled styling as undo | Click → no-op |
| **Hover (enabled)** | Tooltip: "Redo: Add SQL Table 'customers' (Ctrl+Y)" | — |
| **Active / Focus** | Same patterns as undo | — |

### 6.3 Tooltip Content

Tooltips are dynamic, showing the specific action that will be undone/redone:

```
Undo enabled:    "Undo: Move 'orders' (Ctrl+Z)"
Undo disabled:   "Nothing to undo"
Redo enabled:    "Redo: Add SQL Table 'customers' (Ctrl+Y)"
Redo disabled:   "Nothing to redo"
```

For BatchCommand:

```
Undo enabled:    "Undo: Delete 3 selected nodes (Ctrl+Z)"
```

For AutoLayoutCommand:

```
Undo enabled:    "Undo: Auto-arrange 10 nodes (Ctrl+Z)"
```

### 6.4 Button DOM Structure

```html
<button class="dag-toolbar-btn dag-undo-btn"
        type="button"
        disabled
        aria-label="Undo (nothing to undo)"
        aria-keyshortcuts="Control+Z"
        title="Nothing to undo">
  <span class="dag-toolbar-icon" aria-hidden="true">↶</span>
  <span class="dag-toolbar-label">Undo</span>
</button>

<button class="dag-toolbar-btn dag-redo-btn"
        type="button"
        disabled
        aria-label="Redo (nothing to redo)"
        aria-keyshortcuts="Control+Y"
        title="Nothing to redo">
  <span class="dag-toolbar-icon" aria-hidden="true">↷</span>
  <span class="dag-toolbar-label">Redo</span>
</button>
```

### 6.5 CSS

```css
.dag-toolbar-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid oklch(0.88 0 0);
  border-radius: 6px;
  background: oklch(0.97 0 0);
  color: oklch(0.25 0 0);
  font-size: 13px;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: background 100ms ease, border-color 100ms ease;
  user-select: none;
  width: 100%;
}

.dag-toolbar-btn:hover:not(:disabled) {
  background: oklch(0.93 0 0);
  border-color: oklch(0.82 0 0);
}

.dag-toolbar-btn:active:not(:disabled) {
  background: oklch(0.90 0 0);
}

.dag-toolbar-btn:focus-visible {
  outline: 2px solid oklch(0.55 0.20 250);
  outline-offset: 2px;
}

.dag-toolbar-btn:disabled {
  color: oklch(0.70 0 0);
  background: oklch(0.95 0 0);
  border-color: oklch(0.92 0 0);
  cursor: default;
}

.dag-toolbar-icon {
  font-size: 16px;
  line-height: 1;
}
```

### 6.6 No Emoji Rule

Per project rules: no emoji anywhere. The undo/redo icons use Unicode arrows (↶ U+21B6, ↷ U+21B7) or inline SVG, never emoji. The icons `↶` and `↷` are loop arrows — visually distinct from navigation arrows, universally understood as undo/redo.

**SVG fallback** (if Unicode rendering is inconsistent):

```html
<!-- Undo SVG (16×16) -->
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M4 7l-3 3 3 3" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M1 10h9a4 4 0 000-8H6" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round"/>
</svg>

<!-- Redo SVG (16×16) -->
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M12 7l3 3-3 3" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15 10H6a4 4 0 010-8h4" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round"/>
</svg>
```

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Shortcuts

| Shortcut | Action | Condition |
|----------|--------|-----------|
| `Ctrl+Z` | Undo | Canvas has focus, canUndo === true |
| `Ctrl+Y` | Redo | Canvas has focus, canRedo === true |
| `Ctrl+Shift+Z` | Redo (alternate) | Canvas has focus, canRedo === true |

**Scope:** Shortcuts are active ONLY when the DAG canvas (Page 3) has focus. They do NOT fire when:
- A text input inside a node popover has focus (user typing a name)
- The code preview panel has focus
- A modal dialog is open over the canvas
- The wizard is on a different page (1, 2, 4, or 5)

### 7.2 Keyboard Handler Implementation

```javascript
// Bound on the canvas container element, NOT document.
// This prevents interference with other wizard fields.

#handleKeyDown(e) {
  // Skip if focus is inside a text input, textarea, or contenteditable
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
  if (document.activeElement?.isContentEditable) return;

  // Undo: Ctrl+Z (not Shift)
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
    e.preventDefault();
    e.stopPropagation();
    const undone = this.#undoRedoManager.undo();
    if (undone) {
      this.#announceToScreenReader(
        `Undone: ${this.#undoRedoManager.redoDescription}`
      );
    } else {
      this.#announceToScreenReader('Nothing to undo');
    }
    return;
  }

  // Redo: Ctrl+Y OR Ctrl+Shift+Z
  if ((e.ctrlKey && e.key === 'y') ||
      (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
    e.preventDefault();
    e.stopPropagation();
    const redone = this.#undoRedoManager.redo();
    if (redone) {
      this.#announceToScreenReader(
        `Redone: ${this.#undoRedoManager.undoDescription}`
      );
    } else {
      this.#announceToScreenReader('Nothing to redo');
    }
    return;
  }
}
```

### 7.3 Screen Reader Announcements

An `aria-live="polite"` region in the canvas announces undo/redo actions:

```html
<div id="dagCanvasLiveRegion"
     class="sr-only"
     aria-live="polite"
     aria-atomic="true">
</div>
```

```javascript
#announceToScreenReader(message) {
  const region = document.getElementById('dagCanvasLiveRegion');
  if (region) {
    region.textContent = message;
    // Clear after 3 seconds to avoid stale announcements
    setTimeout(() => { region.textContent = ''; }, 3000);
  }
}
```

**Announcement examples:**
- Undo: `"Undone: Move 'orders'"`
- Redo: `"Redone: Add SQL Table 'customers'"`
- Undo at empty stack: `"Nothing to undo"`
- Redo at empty stack: `"Nothing to redo"`
- Batch undo: `"Undone: Delete 3 selected nodes"`

### 7.4 Button ARIA Attributes

| Attribute | Value (when enabled) | Value (when disabled) |
|-----------|---------------------|----------------------|
| `role` | `button` (implicit) | `button` (implicit) |
| `aria-label` | `"Undo: Move 'orders'"` | `"Undo (nothing to undo)"` |
| `aria-disabled` | `false` (omitted) | `true` (via `disabled` attribute) |
| `aria-keyshortcuts` | `"Control+Z"` / `"Control+Y"` | Same (always present) |
| `title` | `"Undo: Move 'orders' (Ctrl+Z)"` | `"Nothing to undo"` |

### 7.5 Tab Order

The undo/redo buttons participate in the toolbar's tab order:

```
Tab sequence within toolbar:
  [+SQL Table] → [+SQL MLV] → [+PySpark MLV] →
  [Auto Arrange] → [Fit to Screen] →
  [Undo] → [Redo]
```

Disabled buttons are still focusable via Tab (they have `disabled` attribute but remain in tab order). This is intentional — screen reader users need to discover the buttons exist even when they can't be activated.

### 7.6 Rapid Key Repeat Debouncing

When the user holds Ctrl+Z, `keydown` fires at the OS key-repeat rate (~30 Hz). Each event triggers one undo. This is the correct behavior — no artificial debouncing. However, screen reader announcements are debounced:

```javascript
#lastAnnouncement = 0;
#ANNOUNCEMENT_COOLDOWN = 500; // ms

#announceToScreenReader(message) {
  const now = Date.now();
  if (now - this.#lastAnnouncement < this.#ANNOUNCEMENT_COOLDOWN) {
    // Skip rapid announcements — screen reader can't keep up
    return;
  }
  this.#lastAnnouncement = now;
  const region = document.getElementById('dagCanvasLiveRegion');
  if (region) {
    region.textContent = message;
    setTimeout(() => { region.textContent = ''; }, 3000);
  }
}
```

This ensures a rapid Ctrl+Z hold announces once ("Undone: ...") instead of flooding the screen reader with 30 announcements per second.

---

## 8. Error Handling

### 8.1 Error Categories

| # | Error | Cause | Severity | Handling |
|---|-------|-------|----------|----------|
| E1 | **Stale node reference** | Command references a node ID that no longer exists | HIGH | Catch, log warning, skip command, remove from stack |
| E2 | **Stale connection reference** | Command references a connection ID that no longer exists | HIGH | Catch, log warning, skip the connection step only |
| E3 | **Duplicate node ID on undo-add** | Node with same ID already exists when restoring | MEDIUM | Catch, generate new ID, update connection references |
| E4 | **Duplicate connection on undo-add** | Connection between same nodes already exists | LOW | Skip silently (idempotent) |
| E5 | **Re-entrancy** | execute() called during undo/redo (event handler side effect) | MEDIUM | Guard flag, log warning, ignore call |
| E6 | **Empty stack operation** | undo()/redo() called on empty stack | NONE | Return false, no error |
| E7 | **Invalid command** | Command object missing execute/undo methods | HIGH | Throw TypeError at execute() time |
| E8 | **Cycle created on undo** | Restoring a deleted connection would create a cycle | HIGH | Validate before restore, skip connection if cycle detected |
| E9 | **Canvas destroyed during undo** | User navigated away while undo was in progress | MEDIUM | Check canvas reference, abort gracefully |
| E10 | **BatchCommand with failed sub-command** | One sub-command in a batch throws | HIGH | Roll back already-applied sub-commands, remove batch from stack |

### 8.2 Error Handling Implementation

```javascript
execute(command) {
  if (this.#isApplying) {
    console.warn(
      `[UndoRedoManager] Re-entrant execute('${command.type}') blocked ` +
      `during ${this.#isApplying}`
    );
    return;
  }

  // Validate command interface
  if (typeof command.execute !== 'function' || typeof command.undo !== 'function') {
    throw new TypeError(
      `[UndoRedoManager] Invalid command: missing execute() or undo() method`
    );
  }

  try {
    command.execute();
  } catch (err) {
    console.error(
      `[UndoRedoManager] Command execute failed: ${command.type}`,
      err
    );
    // Do NOT push to undo stack — command didn't complete
    // Canvas may be in inconsistent state — attempt recovery
    this.#attemptRecovery(command, 'execute', err);
    return;
  }

  this.#undoStack.push(command);
  this.#redoStack.length = 0;

  while (this.#undoStack.length > this.#maxDepth) {
    this.#undoStack.shift();
  }

  this.#notifyStateChange();
}

undo() {
  if (this.#undoStack.length === 0) return false;
  if (!this.#canvas) return false; // Canvas destroyed

  const command = this.#undoStack.pop();

  this.#isApplying = 'undo';
  try {
    command.undo();
  } catch (err) {
    console.error(
      `[UndoRedoManager] Undo failed: ${command.type}`,
      err
    );
    // Push back to undo stack — undo didn't complete
    this.#undoStack.push(command);
    this.#isApplying = false;
    return false;
  }
  this.#isApplying = false;

  this.#redoStack.push(command);
  this.#notifyStateChange();
  return true;
}

redo() {
  if (this.#redoStack.length === 0) return false;
  if (!this.#canvas) return false; // Canvas destroyed

  const command = this.#redoStack.pop();

  this.#isApplying = 'redo';
  try {
    command.execute();
  } catch (err) {
    console.error(
      `[UndoRedoManager] Redo failed: ${command.type}`,
      err
    );
    // Push back to redo stack — redo didn't complete
    this.#redoStack.push(command);
    this.#isApplying = false;
    return false;
  }
  this.#isApplying = false;

  this.#undoStack.push(command);
  this.#notifyStateChange();
  return true;
}
```

### 8.3 BatchCommand Error Handling — Partial Rollback

```javascript
// In BatchCommand:
execute() {
  const executed = [];
  try {
    for (const cmd of this.#commands) {
      cmd.execute();
      executed.push(cmd);
    }
  } catch (err) {
    // Partial failure — roll back already-executed sub-commands
    console.error(
      `[BatchCommand] Sub-command failed at index ${executed.length}:`,
      err
    );
    for (let i = executed.length - 1; i >= 0; i--) {
      try {
        executed[i].undo();
      } catch (rollbackErr) {
        console.error(
          `[BatchCommand] Rollback of sub-command ${i} also failed:`,
          rollbackErr
        );
        // At this point, canvas state may be inconsistent.
        // Log for debugging but continue rollback attempt.
      }
    }
    throw err; // Propagate to UndoRedoManager, which will NOT push to stack
  }
}
```

### 8.4 Stale Reference Recovery

When a command references a node or connection ID that no longer exists (should not happen in normal operation, but possible through bugs or external graph mutations):

```javascript
// In DagCanvas — example guard in removeNodeDirect:
removeNodeDirect(nodeId) {
  const node = this.#graph.getNode(nodeId);
  if (!node) {
    console.warn(
      `[DagCanvas] removeNodeDirect: node '${nodeId}' not found (already removed?)`
    );
    return; // Idempotent — no-op if already gone
  }
  // ... proceed with removal
}

// In DagCanvas — example guard in addConnectionDirect:
addConnectionDirect(connectionData) {
  const source = this.#graph.getNode(connectionData.sourceNodeId);
  const target = this.#graph.getNode(connectionData.targetNodeId);
  if (!source || !target) {
    console.warn(
      `[DagCanvas] addConnectionDirect: source or target node missing for ` +
      `connection '${connectionData.id}'. Skipping.`
    );
    return; // Cannot restore connection if nodes don't exist
  }

  // Cycle check before restoring connection
  if (this.#wouldCreateCycle(connectionData.sourceNodeId, connectionData.targetNodeId)) {
    console.warn(
      `[DagCanvas] addConnectionDirect: restoring connection '${connectionData.id}' ` +
      `would create a cycle. Skipping.`
    );
    return;
  }

  // ... proceed with connection creation
}
```

### 8.5 Edge Case: Undo After Schema Removal

If the user goes back to Page 2 and removes the "Gold" schema, then returns to Page 3 and undoes a schema change (node was changed FROM gold TO silver, undo would set it BACK to gold):

**Design decision:** This scenario is prevented architecturally:
- Navigating away from Page 3 clears the undo stack (§5.9)
- When the user returns to Page 3 after changing schemas, it's a fresh editing session
- If the user HAS NOT left Page 3, the schema set is immutable (can't change Page 2 without going back)

Therefore, undo will never attempt to set a schema that doesn't exist in the current schema set.

---

## 9. Performance

### 9.1 Performance Targets

| Operation | Target | Budget | Approach |
|-----------|--------|--------|----------|
| `execute(command)` | <2ms | <1ms for push + <1ms for command.execute() | Array push is O(1) |
| `undo()` | <50ms total | <1ms for pop + <50ms for command.undo() + DOM | DOM mutations dominate |
| `redo()` | <50ms total | Same as undo | Same as undo |
| `clear()` | <1ms | Array truncation | `stack.length = 0` is O(1) |
| Stack eviction | <0.01ms | Array shift | O(n) but n≤50, negligible |
| `onStateChange` callback | <1ms | Property reads + DOM attribute updates | Minimal computation |
| Memory (50 commands) | <250 KB worst case | See §2.4 memory budget | Command pattern delta storage |

### 9.2 Why Performance Is Not a Risk

The undo/redo system is not a performance-critical path. The dominant cost is in the DOM mutations performed by individual command objects (adding/removing SVG elements, updating attributes). These costs are owned by the DagCanvas, not the UndoRedoManager.

The manager itself performs only:
- Array push/pop (O(1))
- Array shift for eviction (O(n) where n ≤ 50 — negligible)
- One function call to `onStateChange`

At 50 commands maximum, there is zero risk of performance issues in the manager itself.

### 9.3 Animation Suppression During Rapid Undo/Redo

When the user holds Ctrl+Z and undoes multiple commands rapidly, animating each intermediate state (300ms node transitions) would cause visual chaos and lag. The canvas should suppress animation during rapid undo/redo:

```javascript
// In DagCanvas:
#lastUndoRedoTime = 0;
#RAPID_THRESHOLD = 200; // ms

setNodePositionDirect(nodeId, position) {
  const now = Date.now();
  const isRapid = (now - this.#lastUndoRedoTime) < this.#RAPID_THRESHOLD;
  this.#lastUndoRedoTime = now;

  const node = this.#graph.getNode(nodeId);
  if (!node) return;

  if (isRapid) {
    // Instant position update — no animation
    node.set('position', { x: position.x, y: position.y });
  } else {
    // Animated transition (300ms ease-out)
    node.transition('position', { x: position.x, y: position.y }, {
      duration: 300,
      timingFunction: 'ease-out'
    });
  }
}
```

### 9.4 Structural Sharing

Command objects use `structuredClone()` to capture node/connection data at creation time. This creates deep copies, preventing mutations to the original data from corrupting the command's stored state.

**Why not structural sharing (immutable data)?** Our data objects are small (< 500 bytes each) and short-lived. The overhead of implementing an immutable data layer (like Immer) outweighs the memory savings. `structuredClone()` is fast (< 0.1ms for our objects) and provides the necessary isolation guarantee.

### 9.5 Stack Eviction Strategy

When the undo stack exceeds `maxDepth`, the oldest command (index 0) is evicted via `Array.shift()`. This is O(n) because JavaScript arrays shift all elements. For n ≤ 50, this takes < 0.01ms — not a concern.

**Alternative considered:** Using a circular buffer (ring buffer) for O(1) eviction. Rejected because the additional complexity is not justified for a 50-element array. If `maxDepth` were ever increased to 1000+, a ring buffer would be appropriate.

### 9.6 Garbage Collection Friendliness

Evicted commands and cleared stacks become eligible for garbage collection immediately because:
- Commands hold only primitive data (strings, numbers) and `structuredClone`'d objects
- No circular references between commands
- The `DagCanvas` reference is a weak dependency (the canvas outlives all commands)
- `destroy()` nullifies all references explicitly

No `WeakRef` or `FinalizationRegistry` is needed — standard GC handles this correctly.

---

## 10. Implementation Notes

### 10.1 File Structure

```
src/frontend/js/infra-wizard/
├── undo-redo-manager.js      ← UndoRedoManager class
├── commands/
│   ├── command.js             ← Base Command class (interface)
│   ├── add-node-command.js
│   ├── delete-node-command.js
│   ├── move-node-command.js
│   ├── add-connection-command.js
│   ├── delete-connection-command.js
│   ├── rename-node-command.js
│   ├── change-node-type-command.js
│   ├── change-node-schema-command.js
│   ├── auto-layout-command.js
│   └── batch-command.js
└── ... (other infra-wizard modules)
```

**Build note:** All files are concatenated into the single HTML output by `scripts/build-html.py` (per ADR-003). No ES module imports at runtime — all classes are in global scope within the IIFE.

### 10.2 Implementation Order

```
Step 1: Command base class (interface definition)
Step 2: UndoRedoManager (core stack logic + onStateChange)
Step 3: MoveNodeCommand (simplest, most testable)
Step 4: AddNodeCommand + DeleteNodeCommand (pair, test together)
Step 5: AddConnectionCommand + DeleteConnectionCommand (pair)
Step 6: RenameNodeCommand + ChangeNodeSchemaCommand (simple property changes)
Step 7: ChangeNodeTypeCommand (compound property change)
Step 8: BatchCommand (composite pattern)
Step 9: AutoLayoutCommand (requires C13 integration)
Step 10: Keyboard shortcut binding + toolbar button wiring
Step 11: Screen reader announcements + ARIA attributes
Step 12: Edge case testing (§5.11, §8.4, §8.5)
```

**Estimated effort:** 2 dev-days (per P0 research estimate).

### 10.3 Testing Strategy

#### Unit Tests (commands/ — each command class)

```javascript
// test: AddNodeCommand
test('execute adds node to canvas', () => {
  const canvas = createMockCanvas();
  const cmd = new AddNodeCommand(canvas, {
    id: 'n1', type: 'sql-table', name: 'orders',
    schema: 'dbo', x: 100, y: 200, width: 220, height: 80
  });
  cmd.execute();
  assert(canvas.addNodeDirect.calledOnce);
  assert.deepEqual(canvas.addNodeDirect.firstCall.args[0].id, 'n1');
});

test('undo removes node from canvas', () => {
  const canvas = createMockCanvas();
  const cmd = new AddNodeCommand(canvas, { id: 'n1', ... });
  cmd.execute();
  cmd.undo();
  assert(canvas.removeNodeDirect.calledWith('n1'));
});

// test: DeleteNodeCommand with cascading connections
test('undo restores node AND all connections', () => {
  const canvas = createMockCanvas();
  const connections = [
    { id: 'c1', sourceNodeId: 'n1', targetNodeId: 'n2', ... },
    { id: 'c2', sourceNodeId: 'n3', targetNodeId: 'n1', ... }
  ];
  const cmd = new DeleteNodeCommand(canvas, 'n1', nodeData, connections);
  cmd.execute();
  cmd.undo();
  assert(canvas.addNodeDirect.calledWith(nodeData));
  assert(canvas.addConnectionDirect.calledTwice);
});

// test: BatchCommand reverse order
test('undo applies sub-commands in reverse order', () => {
  const canvas = createMockCanvas();
  const callOrder = [];
  const cmd1 = { execute: () => callOrder.push('e1'), undo: () => callOrder.push('u1'), ... };
  const cmd2 = { execute: () => callOrder.push('e2'), undo: () => callOrder.push('u2'), ... };
  const batch = new BatchCommand([cmd1, cmd2]);
  batch.execute();
  assert.deepEqual(callOrder, ['e1', 'e2']);
  callOrder.length = 0;
  batch.undo();
  assert.deepEqual(callOrder, ['u2', 'u1']); // Reverse!
});

// test: AutoLayoutCommand preserves all positions
test('undo restores all original positions', () => {
  const canvas = createMockCanvas();
  const old = new Map([['n1', {x:10,y:20}], ['n2', {x:30,y:40}]]);
  const nw = new Map([['n1', {x:100,y:50}], ['n2', {x:100,y:170}]]);
  const cmd = new AutoLayoutCommand(canvas, old, nw);
  cmd.execute();
  cmd.undo();
  assert(canvas.setNodePositionDirect.calledWith('n1', {x:10,y:20}));
  assert(canvas.setNodePositionDirect.calledWith('n2', {x:30,y:40}));
});
```

#### Integration Tests (UndoRedoManager)

```javascript
// test: execute → undo → redo cycle
test('full execute-undo-redo cycle', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  const cmd = new AddNodeCommand(mockCanvas, nodeData);
  mgr.execute(cmd);
  assert(mgr.canUndo);
  assert(!mgr.canRedo);

  mgr.undo();
  assert(!mgr.canUndo);
  assert(mgr.canRedo);

  mgr.redo();
  assert(mgr.canUndo);
  assert(!mgr.canRedo);
});

// test: new action clears redo stack
test('execute clears redo stack', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  mgr.execute(cmd1);
  mgr.execute(cmd2);
  mgr.undo(); // redoStack = [cmd2]
  assert(mgr.canRedo);
  mgr.execute(cmd3); // New action
  assert(!mgr.canRedo); // Redo cleared!
});

// test: stack depth limit
test('evicts oldest when exceeding maxDepth', () => {
  const mgr = new UndoRedoManager(mockCanvas, { maxDepth: 3 });
  mgr.execute(cmd1);
  mgr.execute(cmd2);
  mgr.execute(cmd3);
  mgr.execute(cmd4); // Exceeds 3 → cmd1 evicted
  assert.equal(mgr.undoDepth, 3);
  // Undo 3 times, verify cmd1 is gone
  mgr.undo(); mgr.undo(); mgr.undo();
  assert(!mgr.canUndo);
});

// test: re-entrancy guard
test('blocks re-entrant execute during undo', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  const sneakyCmd = {
    type: 'sneaky', description: 'sneaky',
    execute() {},
    undo() { mgr.execute(anotherCmd); } // Re-entrant!
  };
  mgr.execute(sneakyCmd);
  mgr.undo(); // Should NOT throw, should log warning
  assert.equal(mgr.undoDepth, 0); // sneakyCmd undone, anotherCmd blocked
});

// test: clear empties both stacks
test('clear resets everything', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  mgr.execute(cmd1);
  mgr.execute(cmd2);
  mgr.undo();
  mgr.clear();
  assert(!mgr.canUndo);
  assert(!mgr.canRedo);
  assert.equal(mgr.undoDepth, 0);
  assert.equal(mgr.redoDepth, 0);
});

// test: description accessors
test('undoDescription returns top command description', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  mgr.execute({ type: 'move-node', description: "Move 'orders'", execute(){}, undo(){} });
  assert.equal(mgr.undoDescription, "Move 'orders'");
  assert.equal(mgr.redoDescription, null);
});

// test: undo on empty stack returns false
test('undo returns false when stack empty', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  assert.equal(mgr.undo(), false);
});

// test: redo on empty stack returns false
test('redo returns false when stack empty', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  assert.equal(mgr.redo(), false);
});

// test: destroy nullifies references
test('destroy prevents further operations', () => {
  const mgr = new UndoRedoManager(mockCanvas);
  mgr.execute(cmd1);
  mgr.destroy();
  assert(!mgr.canUndo);
  assert.equal(mgr.undo(), false);
});
```

#### Edge Case Tests

```javascript
// test: BatchCommand with empty array throws
test('BatchCommand rejects empty sub-command array', () => {
  assert.throws(() => new BatchCommand([]), /at least one sub-command/);
});

// test: BatchCommand partial failure rolls back
test('BatchCommand rolls back on partial failure', () => {
  const failCmd = {
    type: 't', description: 'd',
    execute() { throw new Error('boom'); },
    undo() {}
  };
  const batch = new BatchCommand([cmd1, failCmd]);
  assert.throws(() => batch.execute());
  // cmd1 should have been rolled back
  assert(cmd1.undo.calledOnce);
});

// test: MoveNodeCommand with zero displacement is skipped
test('no MoveNodeCommand created for zero-distance drag', () => {
  // This is tested in DagCanvas.onNodeDragEnd(), not in the command
  // The canvas skips command creation if startPos === endPos
});

// test: double execute is idempotent
test('command.execute() called twice produces same state', () => {
  const canvas = createMockCanvas();
  const cmd = new AddNodeCommand(canvas, nodeData);
  cmd.execute();
  cmd.execute(); // Second call — canvas.addNodeDirect should handle idempotently
  // Canvas implementation guards against duplicate node IDs
});
```

### 10.4 Interaction with Other Components

| Component | Interaction | Direction |
|-----------|------------|-----------|
| **C4-DagCanvas** | Creates commands, owns UndoRedoManager instance, provides `*Direct` API | Canvas → Manager |
| **C5-NodePalette** | Triggers `canvas.addNode()` which creates AddNodeCommand | Palette → Canvas → Manager |
| **C6-DagNode** | Node popover actions trigger rename/type/schema commands | Node → Canvas → Manager |
| **C7-ConnectionManager** | Connection creation/deletion triggers AddConnection/DeleteConnectionCommand | ConnMgr → Canvas → Manager |
| **C13-AutoLayoutEngine** | Layout result passed to AutoLayoutCommand constructor | Layout → Canvas → Manager |
| **C12-TemplateManager** | Template load triggers `undoRedoManager.clear()` | Template → Canvas → Manager |
| **C1-InfraWizardDialog** | Page navigation triggers `undoRedoManager.clear()` on leaving Page 3 | Dialog → Canvas → Manager |

### 10.5 DAG Constraint Preservation During Undo/Redo

The DAG canvas enforces a critical invariant: **no cycles allowed.** This constraint must be preserved during undo/redo operations.

**Normal operation:** When a user creates a connection, the canvas runs a cycle check (topological sort) BEFORE accepting the connection.

**Undo scenario that could theoretically break the invariant:**
1. User creates connection A→B (valid, no cycle)
2. User creates connection B→C (valid)
3. User deletes connection A→B
4. User creates connection C→A (valid because A→B is gone)
5. User undoes step 4 (C→A removed — fine)
6. User undoes step 3 (A→B restored — fine, C→A is gone)

This sequence is safe because undo is strictly LIFO. The user cannot undo step 3 without first undoing step 4.

**However, the `addConnectionDirect` method should still perform a cycle check** as a safety net (see §8.4). If a bug in the manager allows an out-of-order undo, the cycle check prevents graph corruption.

### 10.6 Memory Lifecycle

```
Canvas opens (Page 3 entered):
  → UndoRedoManager created (empty stacks)

User edits graph:
  → Commands accumulate in undoStack (max 50)
  → Evicted commands are GC'd

User navigates to Page 4:
  → undoRedoManager.clear() — both stacks emptied
  → All command objects become GC-eligible

User navigates back to Page 3:
  → Empty stacks — fresh history session

Template loaded:
  → undoRedoManager.clear() — same as page navigation

Wizard closed / dialog destroyed:
  → undoRedoManager.destroy() — all references nullified
  → UndoRedoManager instance itself becomes GC-eligible
```

### 10.7 Interaction Timing: When Commands Are Created

| User Action | When Command Is Created | Why Not Earlier/Later |
|-------------|------------------------|----------------------|
| Drag node from palette | On drop (node placed) | Drag preview is ephemeral |
| Drag-move existing node | On `pointerup` (drag end) | Intermediate positions are not meaningful |
| Draw connection | On valid port drop | Preview curve is ephemeral |
| Delete node (via popover) | On confirmation click | Before click, nothing has changed |
| Delete node (via Delete key) | Immediately (no confirmation for single node) | Key press is the user intent |
| Delete selected nodes (multi) | Immediately (no confirmation) | Consistent with single delete |
| Rename node | On blur / Enter in text field | Intermediate typing is not meaningful |
| Change type | On dropdown selection | Selection is the atomic action |
| Change schema | On dropdown selection | Selection is the atomic action |
| Auto-layout | On "Auto Arrange" click | Button click is the trigger |

### 10.8 structuredClone Usage

All command constructors that capture state use `structuredClone()` to create deep copies. This prevents a class of bugs where the original object is mutated after the command is created:

```javascript
// CORRECT — deep copy prevents mutation bugs
constructor(canvas, nodeData) {
  this.#nodeData = structuredClone(nodeData);
}

// WRONG — shared reference, original could be mutated
constructor(canvas, nodeData) {
  this.#nodeData = nodeData; // BUG: if nodeData.name is changed later,
                              // command's stored state is corrupted
}
```

`structuredClone()` is available in all modern browsers (Chrome 98+, Firefox 94+, Safari 15.4+). Our target environment (Chromium-based Edge in Fabric) supports it.

### 10.9 No Persistence

Undo/redo state is ephemeral — it exists only in memory for the current editing session. It is NOT:
- Saved to localStorage
- Saved to the template file
- Saved to the server
- Preserved across page refreshes

This is intentional and matches industry behavior (Figma, VS Code, Photoshop all lose undo history on close).

### 10.10 Future Extensions (Out of Scope for V1)

| Extension | Description | Complexity |
|-----------|-------------|------------|
| **Undo history panel** | Visual dropdown showing all commands in the stack, click to jump to any point | LOW — read `getUndoHistory()`, render as list |
| **Selective undo** | Undo a specific command without undoing everything after it | HIGH — requires conflict resolution between commands |
| **Undo tree** | Branch-based history (like Vim undotree) instead of linear stack | HIGH — requires tree data structure and UI |
| **Collaborative undo** | Per-user undo in multi-user editing | VERY HIGH — requires operational transform or CRDTs |
| **Persistent undo** | Survive page refresh by serializing command stack | MEDIUM — commands must be serializable to JSON |

None of these are planned for V1. The linear dual-stack model is sufficient for a single-user wizard flow.

### 10.11 Design Decision Log

| # | Decision | Rationale | Alternatives Rejected |
|---|----------|-----------|----------------------|
| D1 | Command pattern over snapshot | Lower memory, better granularity, cleaner architecture (see §1.3) | Snapshot pattern, hybrid |
| D2 | 50-command stack limit | Industry standard, memory budget stays under 250 KB worst-case | Unlimited (memory risk), 20 (too shallow), 100 (unnecessary) |
| D3 | Clear stacks on page navigation | Prevents stale-reference bugs, matches user's mental model of "confirming" the DAG | Keep stacks (would need to handle schema removals on Page 2), archive stacks (complexity) |
| D4 | Reference by ID, not by object | Avoids stale object references when graph model is rebuilt | Object references with WeakRef (overengineered) |
| D5 | `structuredClone` for state capture | Prevents mutation bugs, zero perf impact at our scale | Manual deep copy (error-prone), Immer (dependency overhead) |
| D6 | Coalesce drag events into single MoveNodeCommand | Intermediate positions are meaningless, would flood the undo stack | Per-frame commands (unusable UX), debounced commands (lossy) |
| D7 | Re-entrancy guard with boolean flag | Simple, effective, zero overhead | Event queue (over-engineered), mutex (wrong abstraction for single-threaded JS) |
| D8 | Animation suppression during rapid undo | Prevents visual chaos when holding Ctrl+Z | Always animate (laggy), never animate (jarring for single undo) |
| D9 | `onStateChange` callback instead of EventEmitter | Single consumer (toolbar), simpler API, no event name management | CustomEvent dispatching (heavier), EventEmitter class (unnecessary for 1:1) |
| D10 | BatchCommand reverse undo order | Guarantees referential integrity (connections before nodes) | Forward order (breaks graph), interleaved order (unpredictable) |

---

*End of C14-UndoRedoManager component deep spec.*
*Next: Implementation per Layer 8 in the F16 implementation order.*
