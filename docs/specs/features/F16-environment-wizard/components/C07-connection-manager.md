# C07-ConnectionManager — Component Deep Spec

> **Component ID:** C07  
> **Feature:** F16 – New Infrastructure Wizard  
> **Owner Agent:** Pixel (SVG rendering, interaction) + Vex (data model, validation)  
> **Priority:** P1 — Critical path for DAG Canvas (Page 3)  
> **Status:** Draft  
> **Last Updated:** 2025-07-18  
> **Spec Version:** 1.0.0  

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

ConnectionManager (C07) is the authoritative system for creating, validating, rendering,
and managing all directed edges (connections) between nodes on the DAG Canvas in Page 3
of the F16 New Infrastructure Wizard. It owns the SVG `<path>` layer that sits between
the background grid and the foreground node layer, and it enforces DAG constraints
(no self-loops, no cycles, output→input polarity) on every connection mutation.

ConnectionManager is the **single source of truth** for the graph's edge set. No other
component may create, delete, or modify connections directly. All mutations flow through
ConnectionManager's public API, which emits events that other components (C01-NodeManager,
C03-CanvasRenderer, C08-ValidationEngine) consume.

### 1.2 Scope

ConnectionManager is responsible for:

| Responsibility | Description |
|---|---|
| **Connection creation** | Port-drag interaction from output port to input port with live Bézier preview |
| **Connection deletion** | Single delete, multi-select delete, cascade delete on node removal |
| **DAG validation** | Cycle detection (DFS-based), self-loop prevention, polarity checks |
| **SVG rendering** | Cubic Bézier `<path>` elements, arrowhead `<marker>` definitions, flow animation |
| **Hit testing** | Point-to-curve distance calculation for hover/selection of curved paths |
| **Connection state** | Visual states: default, hover, selected, invalid, animating, disabled |
| **Port magnetism** | Snap-to-port feedback when dragging near a valid target port |
| **Bulk operations** | Select-all, delete-selected, reconnect after node move |
| **Undo/redo integration** | Emit reversible commands for C10-UndoManager |
| **Serialization** | Export/import connection data for wizard state persistence |

### 1.3 Out of Scope

- Node creation/deletion (C01-NodeManager)
- Canvas pan/zoom transforms (C03-CanvasRenderer)
- Port definitions and node type rules (C05-NodeTypeRegistry)
- Layout algorithms / auto-arrange (C06-LayoutEngine)
- Global validation orchestration (C08-ValidationEngine)
- Undo/redo stack management (C10-UndoManager)

### 1.4 Dependencies

```
C07-ConnectionManager
├── DEPENDS ON
│   ├── C01-NodeManager        — node positions, port coordinates, node lifecycle events
│   ├── C03-CanvasRenderer     — SVG container element, zoom/pan transform matrix
│   ├── C05-NodeTypeRegistry   — port definitions, allowed connection rules per node type
│   └── C10-UndoManager        — command registration for undo/redo
├── DEPENDED ON BY
│   ├── C06-LayoutEngine       — reads edge list for Dagre layout calculation
│   ├── C08-ValidationEngine   — reads full graph for global validation
│   ├── C09-Toolbar            — triggers bulk delete, select-all connections
│   └── C12-WizardStateManager — serializes/deserializes connection data
└── PEER (event-based)
    ├── C02-PropertyPanel      — shows connection properties on selection
    └── C04-Minimap            — renders simplified connection lines
```

### 1.5 Design Principles

1. **Single Authority** — ConnectionManager is the only writer of edge data. Reads are
   free; writes go through validated API methods.
2. **Fail-Fast Validation** — Invalid connections are rejected at creation time with
   specific error codes. No invalid state can persist in the model.
3. **SVG-Native Rendering** — Connections are rendered as native SVG `<path>` elements
   (not Canvas 2D). This gives us CSS transitions, ARIA attributes, and DOM event handling
   for free.
4. **60fps Drag Preview** — During connection creation, the preview path updates at
   60fps with <8ms frame budget. Only the single preview path is mutated per frame.
5. **Defensive DAG** — Every mutation that could introduce a cycle runs the cycle
   detector. The detector runs in O(V + E) and is fast enough for 100-node graphs.

### 1.6 Terminology

| Term | Definition |
|---|---|
| **Connection** | A directed edge from one node's output port to another node's input port |
| **Edge** | Synonym for connection (used in graph theory context) |
| **Port** | A connection endpoint on a node — either input (top) or output (bottom) |
| **Source** | The node/port where a connection originates (always an output port) |
| **Target** | The node/port where a connection terminates (always an input port) |
| **Preview path** | The temporary Bézier curve shown while dragging to create a connection |
| **Ghost port** | Visual feedback showing a valid snap target during drag |
| **Magnetism** | Snap behavior when the cursor is within the port's magnetic radius |
| **Adjacency list** | Data structure mapping each node to its outgoing connections |
| **Reverse adjacency** | Data structure mapping each node to its incoming connections |

---

## 2. Data Model

### 2.1 Connection Record

Each connection is represented as an immutable data record. Mutations create new records
and replace the old ones in the connection store.

```typescript
/**
 * Canonical connection record.
 * Immutable — all mutations produce a new object.
 */
interface Connection {
  /** Unique identifier. Format: `conn-{nanoid(12)}` */
  readonly id: string;

  /** Source node ID (the node with the output port) */
  readonly sourceNodeId: string;

  /** Source port ID on the source node (always an output port) */
  readonly sourcePortId: string;

  /** Target node ID (the node with the input port) */
  readonly targetNodeId: string;

  /** Target port ID on the target node (always an input port) */
  readonly targetPortId: string;

  /** ISO-8601 timestamp of creation */
  readonly createdAt: string;

  /** Visual state metadata (not persisted to wizard state) */
  readonly _visual?: ConnectionVisualState;
}

/**
 * Transient visual state — lives in memory only, never serialized.
 */
interface ConnectionVisualState {
  /** Whether this connection is currently selected */
  selected: boolean;

  /** Whether the mouse is hovering over this connection */
  hovered: boolean;

  /** Whether this connection is part of a validation error */
  invalid: boolean;

  /** Error message if invalid */
  invalidReason?: string;

  /** Whether flow animation is active */
  animating: boolean;
}
```

### 2.2 Port Model

Ports are defined by the NodeTypeRegistry (C05) and positioned by NodeManager (C01).
ConnectionManager reads port data but never writes it.

```typescript
/**
 * Port definition — owned by C05-NodeTypeRegistry.
 * ConnectionManager consumes this read-only.
 */
interface PortDefinition {
  /** Unique port ID within the node (e.g., 'input-0', 'output-0') */
  readonly id: string;

  /** Port direction — determines valid connection polarity */
  readonly direction: 'input' | 'output';

  /** Display label (e.g., 'Input', 'Output') */
  readonly label: string;

  /** Maximum number of connections allowed on this port. -1 = unlimited */
  readonly maxConnections: number;

  /** Data type hint for type-based validation (future use) */
  readonly dataType?: string;
}

/**
 * Resolved port position in canvas coordinates.
 * Calculated by C01-NodeManager from node position + port offset.
 */
interface PortPosition {
  /** Port definition reference */
  readonly port: PortDefinition;

  /** Node that owns this port */
  readonly nodeId: string;

  /** Absolute X coordinate in canvas space */
  readonly x: number;

  /** Absolute Y coordinate in canvas space */
  readonly y: number;

  /** Port DOM element reference (for magnetic radius calculations) */
  readonly element: SVGCircleElement | null;
}
```

### 2.3 Adjacency Structures

ConnectionManager maintains two adjacency maps for O(1) lookups:

```typescript
/**
 * Forward adjacency: nodeId → Set of connections where node is source.
 * Used for: finding outgoing connections, DFS traversal.
 */
type ForwardAdjacency = Map<string, Set<Connection>>;

/**
 * Reverse adjacency: nodeId → Set of connections where node is target.
 * Used for: finding incoming connections, cascade delete.
 */
type ReverseAdjacency = Map<string, Set<Connection>>;

/**
 * Connection index: connectionId → Connection record.
 * Used for: O(1) lookup by ID, delete by ID.
 */
type ConnectionIndex = Map<string, Connection>;

/**
 * Duplicate detector: `${sourceNodeId}:${sourcePortId}→${targetNodeId}:${targetPortId}` → connectionId.
 * Used for: O(1) duplicate check on creation.
 */
type DuplicateIndex = Map<string, string>;
```

### 2.4 Internal Store Structure

```typescript
/**
 * Internal store — private to ConnectionManager.
 * All access through public API methods.
 */
class ConnectionStore {
  /** All connections indexed by ID */
  private _connections: ConnectionIndex = new Map();

  /** Forward adjacency list (source → connections) */
  private _forward: ForwardAdjacency = new Map();

  /** Reverse adjacency list (target → connections) */
  private _reverse: ReverseAdjacency = new Map();

  /** Duplicate connection detector */
  private _duplicates: DuplicateIndex = new Map();

  /** Snapshot stack for undo/redo (circular buffer, max 50 entries) */
  private _snapshots: ConnectionSnapshot[] = [];

  /** Current snapshot index */
  private _snapshotIndex: number = -1;

  // --- Counts (O(1) access) ---

  /** Total number of connections */
  get size(): number { return this._connections.size; }

  /** Number of selected connections */
  get selectedCount(): number {
    let count = 0;
    for (const conn of this._connections.values()) {
      if (conn._visual?.selected) count++;
    }
    return count;
  }
}
```

### 2.5 Connection Snapshot (for Undo/Redo)

```typescript
/**
 * Immutable snapshot of all connections at a point in time.
 * Used by C10-UndoManager for undo/redo.
 */
interface ConnectionSnapshot {
  /** Snapshot timestamp */
  readonly timestamp: string;

  /** Human-readable description of the action that produced this snapshot */
  readonly description: string;

  /** Full connection list (deep cloned) */
  readonly connections: ReadonlyArray<Connection>;
}
```

### 2.6 Serialization Format

When the wizard state is saved (by C12-WizardStateManager), connections are serialized
to a minimal JSON format:

```json
{
  "connections": [
    {
      "id": "conn-a8f3k2m9x1p4",
      "sourceNodeId": "node-bronze-customers",
      "sourcePortId": "output-0",
      "targetNodeId": "node-silver-customers-clean",
      "targetPortId": "input-0",
      "createdAt": "2025-07-18T14:30:00.000Z"
    }
  ],
  "version": "1.0.0"
}
```

**Serialization rules:**
- The `_visual` field is NEVER serialized (transient state)
- Connection IDs are stable across serialize/deserialize cycles
- The `version` field enables future schema migrations
- Maximum serialized size: ~100 connections × ~200 bytes = ~20KB

### 2.7 Validation Result

```typescript
/**
 * Result of a connection validation check.
 */
interface ValidationResult {
  /** Whether the connection is valid */
  readonly valid: boolean;

  /** Error code if invalid (see §8 Error Handling) */
  readonly errorCode?: ConnectionErrorCode;

  /** Human-readable error message */
  readonly message?: string;

  /** The nodes involved in the error (e.g., cycle path) */
  readonly involvedNodes?: string[];
}

/**
 * All possible connection error codes.
 */
type ConnectionErrorCode =
  | 'SELF_LOOP'           // Source and target are the same node
  | 'CYCLE_DETECTED'      // Adding this edge would create a cycle
  | 'WRONG_POLARITY'      // Trying to connect output→output or input→input
  | 'DUPLICATE_EDGE'      // This exact connection already exists
  | 'SOURCE_NOT_FOUND'    // Source node/port doesn't exist
  | 'TARGET_NOT_FOUND'    // Target node/port doesn't exist
  | 'PORT_FULL'           // Target port has reached maxConnections
  | 'SOURCE_NO_OUTPUT'    // Source node type has no output ports (e.g., sink node)
  | 'TARGET_NO_INPUT'     // Target node type has no input ports (e.g., Plain SQL Table)
  | 'MAX_CONNECTIONS'     // Global connection limit reached (100 nodes × ~5 edges each)
  | 'NODE_LOCKED';        // Node is in a locked/read-only state

```

---
## 3. API Surface

### 3.1 Constructor

```typescript
/**
 * Create a new ConnectionManager instance.
 * 
 * @param svgContainer - The SVG element that will contain connection paths
 * @param nodeManager  - Reference to C01-NodeManager for port positions
 * @param typeRegistry - Reference to C05-NodeTypeRegistry for validation rules
 * @param undoManager  - Reference to C10-UndoManager for command registration
 * @param options      - Configuration overrides
 */
constructor(
  svgContainer: SVGSVGElement,
  nodeManager: NodeManager,
  typeRegistry: NodeTypeRegistry,
  undoManager: UndoManager,
  options?: ConnectionManagerOptions
)
```

### 3.2 Configuration Options

```typescript
interface ConnectionManagerOptions {
  /** Magnetic snap radius in px (default: 20) */
  magneticRadius?: number;

  /** Hit test tolerance in px (default: 8) */
  hitTestTolerance?: number;

  /** Whether to animate flow on active connections (default: true) */
  enableFlowAnimation?: boolean;

  /** Maximum allowed connections in the graph (default: 500) */
  maxConnections?: number;

  /** Bézier curve tension factor (default: 0.5) */
  curveTension?: number;

  /** Minimum vertical distance for Bézier control points (default: 40) */
  minControlPointDistance?: number;

  /** Whether to show arrowheads on connections (default: true) */
  showArrowheads?: boolean;

  /** Preview path stroke style during drag (default: 'dashed') */
  previewStrokeStyle?: 'solid' | 'dashed' | 'dotted';

  /** Snap grid size for port alignment (default: 4, matches design system) */
  snapGrid?: number;

  /** Debounce delay for validation in ms (default: 0 — synchronous) */
  validationDebounce?: number;
}
```

### 3.3 Public Methods — Connection CRUD

```typescript
/**
 * Create a new connection between two ports.
 * 
 * Validates the connection before creation:
 * 1. Both nodes exist
 * 2. Both ports exist and have correct polarity (output → input)
 * 3. No self-loop
 * 4. No duplicate connection
 * 5. No cycle would be created
 * 6. Target port has not reached maxConnections
 * 
 * @param sourceNodeId - ID of the source node
 * @param sourcePortId - ID of the output port on the source node
 * @param targetNodeId - ID of the target node
 * @param targetPortId - ID of the input port on the target node
 * @returns The created Connection if valid, or a ValidationResult if invalid
 * @fires connection:created
 * @fires connection:validation-failed (if invalid)
 */
createConnection(
  sourceNodeId: string,
  sourcePortId: string,
  targetNodeId: string,
  targetPortId: string
): Connection | ValidationResult;

/**
 * Delete a connection by ID.
 * 
 * @param connectionId - ID of the connection to delete
 * @returns true if deleted, false if not found
 * @fires connection:deleted
 */
deleteConnection(connectionId: string): boolean;

/**
 * Delete multiple connections by ID.
 * Emits a single batch event instead of individual events.
 * 
 * @param connectionIds - Array of connection IDs to delete
 * @returns Number of connections actually deleted
 * @fires connection:batch-deleted
 */
deleteConnections(connectionIds: string[]): number;

/**
 * Delete all connections attached to a node (incoming and outgoing).
 * Called by C01-NodeManager when a node is deleted.
 * 
 * @param nodeId - ID of the node being removed
 * @returns Array of deleted connection IDs
 * @fires connection:batch-deleted
 */
deleteConnectionsForNode(nodeId: string): string[];

/**
 * Get a connection by ID.
 * 
 * @param connectionId - ID of the connection
 * @returns The connection or undefined
 */
getConnection(connectionId: string): Connection | undefined;

/**
 * Get all connections as an array.
 * Returns a shallow copy — callers cannot mutate the internal store.
 * 
 * @returns Array of all connections
 */
getAllConnections(): Connection[];

/**
 * Get all connections where the given node is the source.
 * 
 * @param nodeId - Source node ID
 * @returns Array of outgoing connections
 */
getOutgoingConnections(nodeId: string): Connection[];

/**
 * Get all connections where the given node is the target.
 * 
 * @param nodeId - Target node ID
 * @returns Array of incoming connections
 */
getIncomingConnections(nodeId: string): Connection[];

/**
 * Get all connections attached to a node (both incoming and outgoing).
 * 
 * @param nodeId - Node ID
 * @returns Array of all connections for this node
 */
getConnectionsForNode(nodeId: string): Connection[];

/**
 * Check if a proposed connection would be valid without creating it.
 * 
 * @param sourceNodeId - Source node ID
 * @param sourcePortId - Source port ID
 * @param targetNodeId - Target node ID
 * @param targetPortId - Target port ID
 * @returns ValidationResult with valid=true or valid=false with error details
 */
validateConnection(
  sourceNodeId: string,
  sourcePortId: string,
  targetNodeId: string,
  targetPortId: string
): ValidationResult;

/**
 * Check if adding an edge from sourceNodeId to targetNodeId would create a cycle.
 * Uses DFS-based reachability check.
 * 
 * @param sourceNodeId - Proposed source node
 * @param targetNodeId - Proposed target node
 * @returns true if a cycle would be created
 */
wouldCreateCycle(sourceNodeId: string, targetNodeId: string): boolean;
```

### 3.4 Public Methods — Selection

```typescript
/**
 * Select a connection (adds to selection, does not clear others).
 * 
 * @param connectionId - ID of the connection to select
 * @param exclusive - If true, deselect all others first (default: false)
 * @fires connection:selected
 */
selectConnection(connectionId: string, exclusive?: boolean): void;

/**
 * Deselect a connection.
 * 
 * @param connectionId - ID of the connection to deselect
 * @fires connection:deselected
 */
deselectConnection(connectionId: string): void;

/**
 * Clear all selections.
 * 
 * @fires connection:selection-cleared
 */
clearSelection(): void;

/**
 * Select all connections.
 * 
 * @fires connection:selection-changed
 */
selectAll(): void;

/**
 * Get all currently selected connections.
 * 
 * @returns Array of selected connections
 */
getSelectedConnections(): Connection[];

/**
 * Delete all currently selected connections.
 * 
 * @returns Number of connections deleted
 * @fires connection:batch-deleted
 */
deleteSelected(): number;
```

### 3.5 Public Methods — Rendering

```typescript
/**
 * Render all connections to the SVG container.
 * Called on initial load and after bulk changes.
 * 
 * Creates/updates SVG <path> elements for each connection.
 */
renderAll(): void;

/**
 * Update the SVG path for a single connection.
 * Called when a connected node moves.
 * 
 * @param connectionId - ID of the connection to update
 */
updateConnectionPath(connectionId: string): void;

/**
 * Update SVG paths for all connections attached to a node.
 * Called during node drag for live edge updates.
 * 
 * @param nodeId - ID of the node that moved
 */
updateConnectionsForNode(nodeId: string): void;

/**
 * Start the connection creation preview.
 * Shows a temporary Bézier path from the source port to the cursor.
 * 
 * @param sourceNodeId - Source node ID
 * @param sourcePortId - Source port ID
 * @param cursorX - Current cursor X in canvas coordinates
 * @param cursorY - Current cursor Y in canvas coordinates
 */
startPreview(
  sourceNodeId: string,
  sourcePortId: string,
  cursorX: number,
  cursorY: number
): void;

/**
 * Update the preview path endpoint as the cursor moves.
 * Called on every mousemove during connection creation.
 * Must complete in <8ms for 60fps.
 * 
 * @param cursorX - Current cursor X in canvas coordinates
 * @param cursorY - Current cursor Y in canvas coordinates
 * @param snapTarget - Port to snap to if within magnetic radius, or null
 */
updatePreview(
  cursorX: number,
  cursorY: number,
  snapTarget: PortPosition | null
): void;

/**
 * End the preview — either create the connection or cancel.
 * 
 * @param targetNodeId - Target node ID (null if cancelled)
 * @param targetPortId - Target port ID (null if cancelled)
 */
endPreview(
  targetNodeId: string | null,
  targetPortId: string | null
): void;

/**
 * Highlight valid target ports during connection drag.
 * Dims invalid ports and highlights valid ones.
 * 
 * @param sourceNodeId - Source node ID (to determine valid targets)
 * @param sourcePortId - Source port ID
 */
highlightValidTargets(sourceNodeId: string, sourcePortId: string): void;

/**
 * Clear all port highlighting.
 */
clearHighlights(): void;

/**
 * Apply flow animation to a connection (dashed stroke moving along path).
 * 
 * @param connectionId - Connection to animate
 * @param animate - true to start, false to stop
 */
setFlowAnimation(connectionId: string, animate: boolean): void;
```

### 3.6 Public Methods — Hit Testing

```typescript
/**
 * Find the connection nearest to a point, if within hit tolerance.
 * Uses point-to-Bézier distance algorithm.
 * 
 * @param x - Point X in canvas coordinates
 * @param y - Point Y in canvas coordinates
 * @param tolerance - Hit test tolerance in px (default: this.options.hitTestTolerance)
 * @returns The nearest connection and distance, or null
 */
hitTest(x: number, y: number, tolerance?: number): {
  connection: Connection;
  distance: number;
  t: number;  // Parameter on the Bézier curve [0, 1]
} | null;

/**
 * Find all connections within a rectangular region.
 * Used for marquee selection.
 * 
 * @param rect - Selection rectangle in canvas coordinates
 * @returns Array of connections that intersect the rectangle
 */
hitTestRect(rect: { x: number; y: number; width: number; height: number }): Connection[];

/**
 * Find the port nearest to a point, if within magnetic radius.
 * Used during connection drag for snap-to-port.
 * 
 * @param x - Point X in canvas coordinates
 * @param y - Point Y in canvas coordinates
 * @param excludeNodeId - Node to exclude from search (the source node)
 * @param portDirection - Only search ports of this direction
 * @returns Nearest port position or null
 */
findNearestPort(
  x: number,
  y: number,
  excludeNodeId: string,
  portDirection: 'input' | 'output'
): PortPosition | null;
```

### 3.7 Public Methods — Serialization

```typescript
/**
 * Export all connections as a serializable object.
 * Visual state is stripped — only persistent data is included.
 * 
 * @returns Serializable connection data
 */
serialize(): { connections: Connection[]; version: string };

/**
 * Import connections from serialized data.
 * Validates each connection on import. Invalid connections are skipped
 * and logged as warnings.
 * 
 * @param data - Serialized connection data
 * @returns Import result with counts
 * @fires connection:bulk-imported
 */
deserialize(data: { connections: Connection[]; version: string }): {
  imported: number;
  skipped: number;
  errors: Array<{ connection: Connection; reason: string }>;
};

/**
 * Clear all connections. Used when resetting the canvas.
 * 
 * @fires connection:all-cleared
 */
clear(): void;
```

### 3.8 Public Methods — Utility

```typescript
/**
 * Get the SVG path data (d attribute) for a connection.
 * 
 * @param connectionId - Connection ID
 * @returns SVG path d attribute string, or null if not found
 */
getPathData(connectionId: string): string | null;

/**
 * Get the bounding box of a connection path.
 * 
 * @param connectionId - Connection ID
 * @returns Bounding box or null
 */
getConnectionBounds(connectionId: string): DOMRect | null;

/**
 * Get the midpoint of a connection path (for label placement).
 * 
 * @param connectionId - Connection ID
 * @returns Point at t=0.5 on the Bézier curve
 */
getConnectionMidpoint(connectionId: string): { x: number; y: number } | null;

/**
 * Destroy the ConnectionManager and clean up all DOM elements and listeners.
 */
destroy(): void;
```

### 3.9 Events

ConnectionManager extends EventEmitter and fires the following events:

| Event | Payload | When |
|---|---|---|
| `connection:created` | `{ connection: Connection }` | A new connection was successfully created |
| `connection:deleted` | `{ connectionId: string, connection: Connection }` | A single connection was deleted |
| `connection:batch-deleted` | `{ connectionIds: string[], connections: Connection[] }` | Multiple connections were deleted |
| `connection:selected` | `{ connectionId: string }` | A connection was selected |
| `connection:deselected` | `{ connectionId: string }` | A connection was deselected |
| `connection:selection-changed` | `{ selected: string[] }` | Selection set changed |
| `connection:selection-cleared` | `{}` | All selections cleared |
| `connection:hover-start` | `{ connectionId: string }` | Mouse entered a connection path |
| `connection:hover-end` | `{ connectionId: string }` | Mouse left a connection path |
| `connection:validation-failed` | `{ result: ValidationResult }` | A connection creation was rejected |
| `connection:preview-started` | `{ sourceNodeId, sourcePortId }` | Connection drag preview started |
| `connection:preview-updated` | `{ cursorX, cursorY, snapTarget }` | Preview path updated |
| `connection:preview-ended` | `{ created: boolean }` | Preview ended (created or cancelled) |
| `connection:bulk-imported` | `{ imported, skipped, errors }` | Bulk import completed |
| `connection:all-cleared` | `{}` | All connections removed |
| `connection:path-updated` | `{ connectionId }` | SVG path recalculated (after node move) |

---
## 4. State Machine

### 4.1 Connection Creation State Machine

The connection creation flow is a finite state machine with 6 states.
All transitions are synchronous except for the validation step, which
may involve an asynchronous cycle detection on large graphs (>50 nodes).

```
                    ┌─────────────────────────────────────────────────────┐
                    │                                                     │
                    ▼                                                     │
              ┌──────────┐     mousedown        ┌──────────────┐          │
              │          │    on output port     │              │          │
              │   IDLE   │─────────────────────▸│  PORT_ACTIVE │          │
              │          │                       │              │          │
              └──────────┘                       └──────┬───────┘          │
                    ▲                                   │                  │
                    │                            mousemove                 │
                    │                            (>3px threshold)          │
                    │                                   │                  │
                    │                                   ▼                  │
                    │                            ┌──────────────┐          │
                    │          mouseup           │              │          │
                    ├◂───────(no target)─────────│   DRAGGING   │◂─┐      │
                    │                            │              │  │      │
                    │                            └──────┬───────┘  │      │
                    │                                   │          │      │
                    │                            enter magnetic    │      │
                    │                            radius of port    │      │
                    │                                   │          │      │
                    │                                   ▼          │      │
                    │                            ┌──────────────┐  │      │
                    │          mouseup           │              │  │leave  │
                    │◂───────(no target)─────────│  SNAPPING    │──┘mag.  │
                    │                            │              │  radius │
                    │                            └──────┬───────┘         │
                    │                                   │                 │
                    │                            mouseup on               │
                    │                            valid port               │
                    │                                   │                 │
                    │                                   ▼                 │
                    │                            ┌──────────────┐         │
                    │                            │              │         │
                    │                            │  VALIDATING  │         │
                    │                            │              │         │
                    │                            └──────┬───────┘         │
                    │                                   │                 │
                    │                        ┌──────────┴──────────┐      │
                    │                        │                     │      │
                    │                   valid=true            valid=false  │
                    │                        │                     │      │
                    │                        ▼                     ▼      │
                    │                 ┌──────────────┐     ┌────────────┐ │
                    │                 │              │     │            │ │
                    └◂────────────── │   CREATED    │     │  REJECTED  │─┘
                                     │              │     │            │
                                     └──────────────┘     └────────────┘
```

### 4.2 State Definitions

| State | Description | Entry Actions | Exit Actions |
|---|---|---|---|
| **IDLE** | No connection interaction in progress. Default resting state. | Clear all preview DOM elements. Reset cursor to default. | — |
| **PORT_ACTIVE** | User has pressed mouse button on an output port but hasn't moved yet. Waiting for drag threshold. | Store source port reference. Set `pointer-events: none` on source node to prevent self-drop. | — |
| **DRAGGING** | User is actively dragging to create a connection. Preview Bézier path follows cursor. Invalid target ports are dimmed. | Create preview `<path>` element in SVG. Call `highlightValidTargets()`. Start requestAnimationFrame loop. | — |
| **SNAPPING** | Cursor is within magnetic radius of a valid target port. Preview path snaps to port center. Port visual enlarges. | Snap preview endpoint to port center. Enlarge target port (scale 1.5×). Change preview stroke to solid. | Restore port to normal size. Change preview stroke back to dashed. |
| **VALIDATING** | User released mouse on a target port. Running validation checks. Typically <1ms but modeled as a state for clarity. | Run full validation pipeline (self-loop, polarity, duplicate, cycle detection). | — |
| **CREATED** | Connection passed validation and was created. Transient state — immediately transitions to IDLE. | Add connection to store. Render permanent SVG path. Emit `connection:created`. Push undo snapshot. | Remove preview path. Clear highlights. Transition to IDLE. |
| **REJECTED** | Connection failed validation. Show error feedback, then return to IDLE. | Show error toast/tooltip with rejection reason. Flash source port red. Emit `connection:validation-failed`. | Remove preview path. Clear highlights. Transition to IDLE after 300ms. |

### 4.3 Transition Table

| From | Event | Guard | To | Action |
|---|---|---|---|---|
| IDLE | `mousedown` on output port | Port exists and is type 'output' | PORT_ACTIVE | Store sourceNodeId, sourcePortId. Record mousedown position. |
| PORT_ACTIVE | `mousemove` | Distance from mousedown > 3px | DRAGGING | Create preview path. Highlight valid targets. |
| PORT_ACTIVE | `mouseup` | — | IDLE | Cancel — user clicked port without dragging. |
| PORT_ACTIVE | `keydown(Escape)` | — | IDLE | Cancel. |
| DRAGGING | `mousemove` | No port within magnetic radius | DRAGGING | Update preview path endpoint to cursor position. |
| DRAGGING | `mousemove` | Port within magnetic radius AND port is valid target | SNAPPING | Snap preview to port center. Enlarge port. |
| DRAGGING | `mouseup` | No snap target | IDLE | Cancel — released in empty space. |
| DRAGGING | `keydown(Escape)` | — | IDLE | Cancel drag. |
| SNAPPING | `mousemove` | Cursor leaves magnetic radius | DRAGGING | Un-snap. Restore port size. |
| SNAPPING | `mousemove` | Cursor moves to different valid port | SNAPPING | Snap to new port. |
| SNAPPING | `mouseup` | — | VALIDATING | Begin validation of proposed connection. |
| SNAPPING | `keydown(Escape)` | — | IDLE | Cancel drag. |
| VALIDATING | validation complete | `valid === true` | CREATED | Create connection, render path, emit event. |
| VALIDATING | validation complete | `valid === false` | REJECTED | Show error feedback. |
| CREATED | (immediate) | — | IDLE | Cleanup preview, reset state. |
| REJECTED | timeout (300ms) | — | IDLE | Cleanup preview, reset state. |

### 4.4 Drag Threshold

A 3-pixel drag threshold prevents accidental connection creation from click jitter.
The threshold is calculated using Euclidean distance from the initial mousedown point:

```javascript
const DRAG_THRESHOLD = 3; // pixels

function exceedsDragThreshold(startX, startY, currentX, currentY) {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD;
}
```

### 4.5 Magnetic Snap Behavior

When the cursor enters the magnetic radius (default: 20px) of a valid target port,
the preview path endpoint snaps to the port center. This provides a clear affordance
that releasing the mouse will create a connection.

```javascript
const MAGNETIC_RADIUS = 20; // pixels

function findSnapTarget(cursorX, cursorY, validPorts) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const port of validPorts) {
    const dx = cursorX - port.x;
    const dy = cursorY - port.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < MAGNETIC_RADIUS && distance < nearestDistance) {
      nearest = port;
      nearestDistance = distance;
    }
  }

  return nearest;
}
```

**Port visual feedback during snap:**

| State | Port Size | Port Color | Port Border |
|---|---|---|---|
| Normal | 8×8 px | `var(--text-muted)` | 1.5px solid `var(--surface)` |
| Valid target (highlighted) | 8×8 px | `var(--accent)` | 1.5px solid `var(--surface)` |
| Snapped (within magnetic radius) | 12×12 px | `var(--accent)` | 2px solid `var(--accent)` |
| Invalid target | 8×8 px | `var(--text-muted)` | 1.5px solid `var(--surface)`, opacity 0.3 |

### 4.6 Preview Path Styling

During connection creation, the preview path has distinct styling from permanent connections:

```css
/* Preview path — temporary, follows cursor */
.connection-preview {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 8 4;
  opacity: 0.6;
  pointer-events: none;  /* Don't interfere with port hit testing */
  transition: none;       /* No transitions during drag — raw performance */
}

/* Preview path when snapped to a valid port */
.connection-preview.snapped {
  stroke-dasharray: none;
  opacity: 0.9;
  stroke-width: 2.5;
}

/* Preview path when over an invalid target */
.connection-preview.invalid {
  stroke: var(--status-fail);
  stroke-dasharray: 4 4;
  opacity: 0.4;
}
```

---
## 5. Scenarios

### 5.1 Scenario: Create a Connection (Happy Path)

**Preconditions:**
- Canvas has at least 2 nodes
- Source node has an available output port
- Target node has an available input port
- No existing connection between the same source port and target port

**Steps:**

1. User hovers over the output port (bottom) of the source node.
   - Port highlights: background changes to `var(--accent)`.
   - Cursor changes to `crosshair`.

2. User presses mouse button on the output port.
   - State transitions: IDLE → PORT_ACTIVE.
   - Source port reference stored internally.

3. User moves mouse more than 3px from the mousedown point.
   - State transitions: PORT_ACTIVE → DRAGGING.
   - Preview Bézier path appears from the source port to the cursor position.
   - All valid target input ports are highlighted with `var(--accent)`.
   - All invalid target ports are dimmed (opacity 0.3).
   - Source node's own input ports are dimmed (no self-loops).

4. User moves cursor near a valid input port (within 20px magnetic radius).
   - State transitions: DRAGGING → SNAPPING.
   - Preview path snaps to the port center (smooth interpolation, not jump).
   - Target port enlarges from 8px to 12px with `var(--spring)` easing.
   - Preview path changes from dashed to solid.

5. User releases mouse button while snapped to the port.
   - State transitions: SNAPPING → VALIDATING.
   - Validation pipeline runs:
     a. ✅ Self-loop check: sourceNodeId !== targetNodeId
     b. ✅ Polarity check: source port is 'output', target port is 'input'
     c. ✅ Duplicate check: no existing connection with same endpoints
     d. ✅ Cycle check: DFS from targetNode does not reach sourceNode
     e. ✅ Port capacity: target port has room for another connection
   - All checks pass → State transitions: VALIDATING → CREATED.

6. Connection is created.
   - New `Connection` record added to store.
   - Adjacency lists updated.
   - Permanent SVG `<path>` element created with Bézier curve.
   - Arrowhead marker applied to the path.
   - Preview path removed.
   - Port highlights cleared.
   - Undo snapshot pushed.
   - Event `connection:created` emitted.
   - State transitions: CREATED → IDLE.

**Postconditions:**
- Connection visible on canvas with default styling.
- Connection data in the store matches the source/target ports.
- Graph remains a valid DAG.

### 5.2 Scenario: Create a Connection — Cycle Rejected

**Preconditions:**
- Node A → Node B connection exists
- Node B → Node C connection exists
- User tries to create Node C → Node A (would create cycle A→B→C→A)

**Steps:**

1. User drags from Node C's output port to Node A's input port.
2. Preview path appears and follows cursor through DRAGGING state.
3. Cursor enters Node A's input port magnetic radius → SNAPPING state.
4. User releases mouse → VALIDATING state.
5. Cycle detection runs:
   - DFS from Node A (proposed target) explores outgoing edges.
   - Visits Node B (A→B exists).
   - Visits Node C (B→C exists).
   - Node C is the proposed source — **cycle detected!**
6. State transitions: VALIDATING → REJECTED.
7. Error feedback:
   - Preview path flashes red (`var(--status-fail)`) for 300ms.
   - Toast notification: "Cannot create connection: would create a cycle (A → B → C → A)."
   - Source port briefly flashes red.
8. After 300ms, state transitions: REJECTED → IDLE.
   - Preview path removed.
   - All highlights cleared.

**Postconditions:**
- No new connection created.
- Existing connections unchanged.
- Graph remains a valid DAG.

### 5.3 Scenario: Create a Connection — Self-Loop Rejected

**Preconditions:**
- Node A has both input and output ports.

**Steps:**

1. User drags from Node A's output port.
2. User moves cursor toward Node A's own input port.
3. Node A's input port remains dimmed (invalid target) — it is never highlighted
   because the magnetic snap code excludes the source node.
4. If user somehow releases mouse over the source node's input port:
   - Validation catches the self-loop: sourceNodeId === targetNodeId.
   - State: VALIDATING → REJECTED.
   - Error: "Cannot connect a node to itself."

**Note:** The UI prevents this scenario in most cases by dimming the source node's
ports during drag. The validation is a safety net.

### 5.4 Scenario: Create a Connection — Plain SQL Table as Target

**Preconditions:**
- Node of type "Plain SQL Table" exists on the canvas.

**Steps:**

1. User drags from another node's output port.
2. During DRAGGING state, the Plain SQL Table's input port is not highlighted
   because Plain SQL Tables have no input ports (they are source-only nodes).
3. User cannot snap to this node — no magnetic snap target exists.
4. If the user releases mouse over the Plain SQL Table area:
   - No connection created (no target port was snapped to).
   - State: DRAGGING → IDLE (cancel).

**Postconditions:**
- No connection to the Plain SQL Table.
- Tooltip hint: "Plain SQL Tables are source nodes and cannot receive connections."

### 5.5 Scenario: Delete a Single Connection

**Steps:**

1. User hovers over a connection path.
   - Hit test identifies the nearest connection (point-to-Bézier distance < tolerance).
   - Connection path highlights: stroke changes to `var(--accent)`, width increases to 2.5px.
   - Cursor changes to `pointer`.

2. User clicks the connection.
   - Connection becomes selected: stroke color `var(--accent)`, opacity 1.0.
   - Selection handles or delete affordance appears.

3. User presses `Delete` or `Backspace` key.
   - `deleteSelected()` called.
   - Connection removed from store and adjacency lists.
   - SVG `<path>` element removed from DOM.
   - Undo snapshot pushed.
   - Event `connection:deleted` emitted.

### 5.6 Scenario: Delete a Node with Connections

**Preconditions:**
- Node B has incoming connections from A and C, and outgoing connection to D.

**Steps:**

1. User selects Node B and presses `Delete`.
2. C01-NodeManager calls `connectionManager.deleteConnectionsForNode('node-B')`.
3. ConnectionManager:
   - Finds all connections where B is source: [B→D]
   - Finds all connections where B is target: [A→B, C→B]
   - Deletes all three connections.
   - Removes SVG paths for all three.
   - Pushes a single undo snapshot with description "Delete node B and 3 connections".
   - Emits `connection:batch-deleted` with all three connection IDs.

4. After node deletion, the canvas shows A, C, D with no connections between them.

### 5.7 Scenario: Move a Node with Connections

**Preconditions:**
- Node B has connections: A→B and B→C.

**Steps:**

1. User begins dragging Node B.
2. C01-NodeManager fires `node:position-changed` event on each frame.
3. ConnectionManager receives the event:
   - Calls `updateConnectionsForNode('node-B')`.
   - For each connection involving B:
     - Gets updated port positions from NodeManager.
     - Recalculates Bézier control points.
     - Updates the SVG path `d` attribute.
   - Both A→B and B→C paths update in real-time.

4. User releases Node B at new position.
5. Final path update ensures pixel-perfect positioning.

**Performance target:** <16ms per frame (60fps) for updating all connections
attached to one node. With typical 2-4 connections per node, this is well
within budget (~2ms per path update).

### 5.8 Scenario: Marquee Selection of Connections

**Steps:**

1. User holds Shift and draws a rectangular selection on the canvas.
2. ConnectionManager receives the rectangle via `hitTestRect()`.
3. All connections whose Bézier path intersects the rectangle are selected.
4. Selected connections highlight with accent color and selection state.
5. User presses Delete → all selected connections are batch-deleted.

### 5.9 Scenario: Undo/Redo Connection Creation

**Steps:**

1. User creates a connection A→B.
   - ConnectionManager pushes undo command: `{ type: 'connection:create', data: connectionRecord }`.

2. User presses Ctrl+Z.
   - C10-UndoManager calls `connectionManager.deleteConnection(connectionId)`.
   - Connection A→B is removed. SVG path removed.

3. User presses Ctrl+Y.
   - C10-UndoManager calls `connectionManager.createConnection(...)` with the stored record.
   - Connection A→B is re-created with the same ID.
   - SVG path re-rendered.

### 5.10 Scenario: Canvas Zoom with Connections

**Preconditions:**
- Multiple connections visible on canvas.
- User zooms in/out.

**Steps:**

1. User scrolls to zoom. C03-CanvasRenderer updates the SVG `viewBox` or transform.
2. Because connections are SVG `<path>` elements inside the same `<g>` transform group,
   they scale automatically with the canvas — **no ConnectionManager action needed**.
3. Hit test tolerance is adjusted by the inverse of the zoom level:
   - At zoom 1.0x: tolerance = 8px
   - At zoom 0.5x: tolerance = 16px (more forgiving at small zoom)
   - At zoom 2.0x: tolerance = 4px (more precise at large zoom)

```javascript
function adjustedTolerance(baseTolerance, zoomLevel) {
  return baseTolerance / zoomLevel;
}
```

### 5.11 Scenario: Duplicate Connection Attempt

**Steps:**

1. Connection A(output-0) → B(input-0) already exists.
2. User drags from A's output-0 to B's input-0 again.
3. During SNAPPING state, the target port can optionally show a "already connected" indicator.
4. On mouseup → VALIDATING → duplicate check fails.
5. State: VALIDATING → REJECTED.
6. Error: "A connection between these ports already exists."

### 5.12 Scenario: Bulk Import from Saved State

**Steps:**

1. User navigates back to Page 3 (DAG Canvas) after visiting Page 4.
2. C12-WizardStateManager calls `connectionManager.deserialize(savedData)`.
3. ConnectionManager:
   - Clears existing connections (if any).
   - Iterates over saved connections.
   - For each connection: validates it can still be created (nodes still exist, no cycles).
   - Valid connections: created and rendered.
   - Invalid connections: skipped with warning logged.
   - Emits `connection:bulk-imported` with counts.

### 5.13 Scenario: Connection Creation Cancelled

**Steps:**

1. User starts dragging from an output port (enters DRAGGING state).
2. User presses Escape key.
3. State: DRAGGING → IDLE.
4. Preview path removed. Highlights cleared. No connection created.

**Alternative:** User releases mouse in empty space (not near any port).
Same result — state returns to IDLE, no connection created.

---
## 6. Visual Spec

### 6.1 SVG Layer Structure

Connections are rendered in a dedicated SVG layer between the background grid and
the node layer. The layer structure (bottom to top):

```
<svg class="dag-canvas" viewBox="0 0 1200 800">
  <!-- Layer 1: Grid background (owned by C03-CanvasRenderer) -->
  <g class="grid-layer">...</g>

  <!-- Layer 2: Connection paths (owned by C07-ConnectionManager) -->
  <g class="connection-layer" data-component="C07">
    <!-- Marker definitions for arrowheads -->
    <defs>
      <marker id="arrowhead-default" ... >
        <polygon points="0 0, 8 3, 0 6" />
      </marker>
      <marker id="arrowhead-active" ... >
        <polygon points="0 0, 8 3, 0 6" />
      </marker>
      <marker id="arrowhead-invalid" ... >
        <polygon points="0 0, 8 3, 0 6" />
      </marker>
    </defs>

    <!-- Permanent connection paths -->
    <path class="connection" data-connection-id="conn-abc123" d="M ..." />
    <path class="connection" data-connection-id="conn-def456" d="M ..." />

    <!-- Temporary preview path (only during drag) -->
    <path class="connection-preview" d="M ..." />
  </g>

  <!-- Layer 3: Node containers (owned by C01-NodeManager) -->
  <g class="node-layer">...</g>

  <!-- Layer 4: Interaction overlay (owned by C03-CanvasRenderer) -->
  <g class="interaction-layer">...</g>
</svg>
```

### 6.2 Arrowhead Marker Definitions

Arrowheads are defined as SVG `<marker>` elements and referenced via `marker-end`
on connection paths. Three variants for different visual states:

```svg
<!-- Default arrowhead: muted, semi-transparent -->
<marker
  id="arrowhead-default"
  markerWidth="8"
  markerHeight="6"
  refX="8"
  refY="3"
  orient="auto"
  markerUnits="strokeWidth"
>
  <polygon
    points="0 0, 8 3, 0 6"
    fill="rgba(142, 149, 165, 0.5)"
  />
</marker>

<!-- Active arrowhead: accent color, higher opacity -->
<marker
  id="arrowhead-active"
  markerWidth="8"
  markerHeight="6"
  refX="8"
  refY="3"
  orient="auto"
  markerUnits="strokeWidth"
>
  <polygon
    points="0 0, 8 3, 0 6"
    fill="rgba(109, 92, 255, 0.7)"
  />
</marker>

<!-- Invalid/error arrowhead: red -->
<marker
  id="arrowhead-invalid"
  markerWidth="8"
  markerHeight="6"
  refX="8"
  refY="3"
  orient="auto"
  markerUnits="strokeWidth"
>
  <polygon
    points="0 0, 8 3, 0 6"
    fill="rgba(229, 69, 59, 0.7)"
  />
</marker>
```

### 6.3 Connection Path Styling

All connection visual states, matching the CEO-approved mock:

```css
/* ═══════════════════════════════════════════════════════
   Connection Path Styles
   Source of truth: infra-wizard.html mock (CEO-approved)
   ═══════════════════════════════════════════════════════ */

/* Base connection path */
.connection {
  fill: none;
  stroke: var(--text-muted);     /* #8e95a5 */
  stroke-width: 1.5;
  opacity: 0.5;
  cursor: pointer;
  transition: stroke 150ms var(--ease),
              stroke-width 150ms var(--ease),
              opacity 150ms var(--ease);
  marker-end: url(#arrowhead-default);
}

/* Hovered connection */
.connection:hover,
.connection[data-hovered="true"] {
  stroke: var(--accent);         /* #6d5cff */
  stroke-width: 2;
  opacity: 0.7;
  marker-end: url(#arrowhead-active);
}

/* Selected connection */
.connection[data-selected="true"] {
  stroke: var(--accent);         /* #6d5cff */
  stroke-width: 2.5;
  opacity: 0.9;
  marker-end: url(#arrowhead-active);
}

/* Active/animated connection (data is flowing) */
.connection[data-animating="true"] {
  stroke: var(--accent);         /* #6d5cff */
  stroke-width: 2;
  opacity: 0.8;
  stroke-dasharray: 6 4;
  animation: flowDash 1.5s linear infinite;
  marker-end: url(#arrowhead-active);
}

/* Invalid connection (validation error) */
.connection[data-invalid="true"] {
  stroke: var(--status-fail);    /* #e5453b */
  stroke-width: 2;
  opacity: 0.6;
  stroke-dasharray: 4 4;
  marker-end: url(#arrowhead-invalid);
}

/* Disabled connection (node is locked) */
.connection[data-disabled="true"] {
  stroke: var(--text-muted);
  stroke-width: 1;
  opacity: 0.2;
  pointer-events: none;
  marker-end: url(#arrowhead-default);
}

/* Flow animation keyframes */
@keyframes flowDash {
  to {
    stroke-dashoffset: -20;
  }
}
```

### 6.4 Cubic Bézier Curve Mathematics

#### 6.4.1 The Bézier Formula

Connections use cubic Bézier curves for smooth, aesthetically pleasing paths.
A cubic Bézier curve is defined by four points:

- **P0** (x0, y0): Start point — center of the source output port
- **P1** (x1, y1): First control point — determines the curve's departure angle from source
- **P2** (x2, y2): Second control point — determines the curve's arrival angle at target
- **P3** (x3, y3): End point — center of the target input port

The parametric form of the cubic Bézier curve for parameter t in [0, 1]:

```
B(t) = (1-t)³·P0 + 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³·P3
```

Expanded for X and Y coordinates:

```
Bx(t) = (1-t)³·x0 + 3(1-t)²t·x1 + 3(1-t)t²·x2 + t³·x3
By(t) = (1-t)³·y0 + 3(1-t)²t·y1 + 3(1-t)t²·y2 + t³·y3
```

#### 6.4.2 Control Point Calculation

For top-to-bottom (TB) flow direction, control points are placed vertically
below/above the source/target to create smooth S-curves:

```javascript
/**
 * Calculate cubic Bezier control points for a top-to-bottom connection.
 *
 * The control points create a smooth vertical S-curve by offsetting
 * vertically from source (downward) and target (upward).
 *
 * @param sourceX - Source port X coordinate (center)
 * @param sourceY - Source port Y coordinate (center)
 * @param targetX - Target port X coordinate (center)
 * @param targetY - Target port Y coordinate (center)
 * @param tension  - Curve tension factor (0.0 to 1.0, default 0.5)
 * @returns Object with all four Bezier points
 */
function calculateControlPoints(sourceX, sourceY, targetX, targetY, tension = 0.5) {
  // Vertical distance between source and target
  const dy = Math.abs(targetY - sourceY);

  // Control point offset: proportional to vertical distance
  // Minimum offset prevents flat curves when nodes are close
  const offset = Math.max(dy * tension, 40);

  // For TB flow: source exits downward, target enters from above
  const cp1x = sourceX;                    // First control point: directly below source
  const cp1y = sourceY + offset;           // Offset downward from source

  const cp2x = targetX;                    // Second control point: directly above target
  const cp2y = targetY - offset;           // Offset upward from target

  return {
    p0: { x: sourceX, y: sourceY },        // Start (source port center)
    p1: { x: cp1x,    y: cp1y },           // Control 1 (below source)
    p2: { x: cp2x,    y: cp2y },           // Control 2 (above target)
    p3: { x: targetX, y: targetY },        // End (target port center)
  };
}
```

**Visual diagram of control point placement:**

```
    Source Port (P0)
         │
         │  offset (dy * tension)
         │
    Control 1 (P1) ← same X as source, offset Y below
         │
         │  (curve bends smoothly)
         │
    Control 2 (P2) ← same X as target, offset Y above
         │
         │  offset (dy * tension)
         │
    Target Port (P3)
```

#### 6.4.3 Edge Cases in Control Point Calculation

**Case 1: Target is above source (upward connection)**

When a connection goes upward (target Y < source Y), the control points
must be extended further to create a visible loop:

```javascript
function calculateControlPointsUpward(sourceX, sourceY, targetX, targetY) {
  const dy = Math.abs(targetY - sourceY);
  const offset = Math.max(dy * 0.8, 80);  // Larger offset for upward curves

  return {
    p0: { x: sourceX, y: sourceY },
    p1: { x: sourceX, y: sourceY + offset },  // Still goes DOWN from source
    p2: { x: targetX, y: targetY - offset },   // Still comes from ABOVE target
    p3: { x: targetX, y: targetY },
  };
}
```

**Case 2: Source and target at same Y level (horizontal connection)**

```javascript
function calculateControlPointsHorizontal(sourceX, sourceY, targetX, targetY) {
  const dx = Math.abs(targetX - sourceX);
  const offset = Math.max(dx * 0.5, 60);

  return {
    p0: { x: sourceX, y: sourceY },
    p1: { x: sourceX, y: sourceY + offset },
    p2: { x: targetX, y: targetY - offset },
    p3: { x: targetX, y: targetY },
  };
}
```

**Case 3: Source and target very close together**

```javascript
function calculateControlPointsClose(sourceX, sourceY, targetX, targetY) {
  // Minimum control point distance prevents degenerate curves
  const MIN_OFFSET = 40;

  return {
    p0: { x: sourceX, y: sourceY },
    p1: { x: sourceX, y: sourceY + MIN_OFFSET },
    p2: { x: targetX, y: targetY - MIN_OFFSET },
    p3: { x: targetX, y: targetY },
  };
}
```

#### 6.4.4 Unified Control Point Algorithm

The production implementation unifies all edge cases:

```javascript
/**
 * Production-grade control point calculation.
 * Handles all edge cases: TB flow, upward, horizontal, close nodes.
 *
 * @param sx - Source X
 * @param sy - Source Y
 * @param tx - Target X
 * @param ty - Target Y
 * @param opts - Options { tension, minOffset }
 * @returns { p0, p1, p2, p3 } Bezier control points
 */
function computeBezierPoints(sx, sy, tx, ty, opts = {}) {
  const tension = opts.tension ?? 0.5;
  const minOffset = opts.minOffset ?? 40;

  // Vertical distance (signed: positive = downward)
  const dy = ty - sy;

  // Base offset from vertical distance
  let offset;

  if (dy > 0) {
    // Normal case: target is below source (TB flow)
    offset = Math.max(dy * tension, minOffset);
  } else if (dy < 0) {
    // Upward case: target is above source
    // Use larger offset to create visible arc
    offset = Math.max(Math.abs(dy) * 0.8, minOffset * 2);
  } else {
    // Same level: use horizontal distance as reference
    const dx = Math.abs(tx - sx);
    offset = Math.max(dx * 0.5, minOffset * 1.5);
  }

  return {
    p0: { x: sx, y: sy },
    p1: { x: sx, y: sy + offset },
    p2: { x: tx, y: ty - offset },
    p3: { x: tx, y: ty },
  };
}
```

#### 6.4.5 SVG Path `d` Attribute Construction

The `d` attribute uses the SVG `M` (move to) and `C` (cubic Bézier curve to) commands:

```javascript
/**
 * Build the SVG path `d` attribute string from Bezier points.
 *
 * SVG cubic Bezier syntax:
 *   M x0,y0         — Move to start point
 *   C x1,y1 x2,y2 x3,y3  — Cubic Bezier curve
 *
 * @param points - The four Bezier control points { p0, p1, p2, p3 }
 * @returns SVG path d attribute string
 */
function buildPathD(points) {
  const { p0, p1, p2, p3 } = points;

  // Round to 1 decimal place for smaller DOM strings
  const r = (n) => Math.round(n * 10) / 10;

  return `M ${r(p0.x)},${r(p0.y)} C ${r(p1.x)},${r(p1.y)} ${r(p2.x)},${r(p2.y)} ${r(p3.x)},${r(p3.y)}`;
}

// Example output:
// "M 120,105 C 120,160 200,160 200,200"
//
// This matches the mock HTML format exactly:
//   M sourceX,sourceY C cp1X,cp1Y cp2X,cp2Y targetX,targetY
```

**Complete render pipeline for one connection:**

```javascript
/**
 * Full pipeline: connection record → SVG path element.
 */
function renderConnection(connection, nodeManager) {
  // 1. Get port positions from NodeManager
  const sourcePort = nodeManager.getPortPosition(
    connection.sourceNodeId,
    connection.sourcePortId
  );
  const targetPort = nodeManager.getPortPosition(
    connection.targetNodeId,
    connection.targetPortId
  );

  // 2. Calculate Bezier control points
  const points = computeBezierPoints(
    sourcePort.x, sourcePort.y,
    targetPort.x, targetPort.y
  );

  // 3. Build SVG path d attribute
  const d = buildPathD(points);

  // 4. Create or update SVG path element
  let pathEl = document.querySelector(
    `path[data-connection-id="${connection.id}"]`
  );

  if (!pathEl) {
    pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.classList.add('connection');
    pathEl.dataset.connectionId = connection.id;
    connectionLayer.appendChild(pathEl);
  }

  // 5. Set attributes
  pathEl.setAttribute('d', d);
  pathEl.setAttribute('marker-end', 'url(#arrowhead-default)');

  // 6. Set ARIA attributes
  pathEl.setAttribute('role', 'graphics-symbol');
  pathEl.setAttribute('aria-label',
    `Connection from ${connection.sourceNodeId} to ${connection.targetNodeId}`
  );

  return pathEl;
}
```

### 6.5 Point on Bézier Curve

Evaluating a point on the curve at parameter t (used for midpoint labels,
animation, and hit testing):

```javascript
/**
 * Evaluate a point on a cubic Bezier curve at parameter t.
 *
 * @param t - Parameter in [0, 1]. 0 = start, 1 = end, 0.5 = midpoint
 * @param p0 - Start point
 * @param p1 - Control point 1
 * @param p2 - Control point 2
 * @param p3 - End point
 * @returns { x, y } point on the curve
 */
function bezierPoint(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}
```

### 6.6 Bézier Curve Derivative (Tangent)

The first derivative gives the tangent direction at any point on the curve.
Used for arrowhead orientation and flow animation direction:

```javascript
/**
 * Evaluate the first derivative (tangent) of a cubic Bezier at parameter t.
 *
 * B'(t) = 3(1-t)^2(P1-P0) + 6(1-t)t(P2-P1) + 3t^2(P3-P2)
 *
 * @param t - Parameter in [0, 1]
 * @param p0, p1, p2, p3 - Bezier control points
 * @returns { x, y } tangent vector (not normalized)
 */
function bezierDerivative(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  return {
    x: 3 * mt2 * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t2 * (p3.x - p2.x),
    y: 3 * mt2 * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t2 * (p3.y - p2.y),
  };
}

/**
 * Get the angle of the tangent at parameter t (in radians).
 * Used for arrowhead rotation.
 */
function bezierAngle(t, p0, p1, p2, p3) {
  const d = bezierDerivative(t, p0, p1, p2, p3);
  return Math.atan2(d.y, d.x);
}
```

### 6.7 Bézier Curve Length (Arc Length Approximation)

Approximate the total length of the Bézier curve using recursive subdivision.
Used for dash-array normalization and animation timing:

```javascript
/**
 * Approximate the arc length of a cubic Bezier curve.
 * Uses recursive subdivision until segments are nearly linear.
 *
 * @param p0, p1, p2, p3 - Bezier control points
 * @param segments - Number of linear segments to subdivide into (default: 20)
 * @returns Approximate arc length in pixels
 */
function bezierLength(p0, p1, p2, p3, segments = 20) {
  let length = 0;
  let prev = bezierPoint(0, p0, p1, p2, p3);

  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const current = bezierPoint(t, p0, p1, p2, p3);
    const dx = current.x - prev.x;
    const dy = current.y - prev.y;
    length += Math.sqrt(dx * dx + dy * dy);
    prev = current;
  }

  return length;
}
```

### 6.8 Port Visual Specifications

Port rendering matches the CEO-approved mock exactly:

```css
/* Port base styles */
.port {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);    /* #8e95a5 */
  border: 1.5px solid var(--surface);
  position: absolute;
  z-index: 2;
  cursor: crosshair;
  transition: transform 200ms var(--spring),
              background 150ms var(--ease),
              border 150ms var(--ease),
              width 200ms var(--spring),
              height 200ms var(--spring);
}

/* Input port: centered on top edge of node */
.port-in {
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
}

/* Output port: centered on bottom edge of node */
.port-out {
  bottom: -4px;
  left: 50%;
  transform: translateX(-50%);
}

/* Port hover (when hovering the parent node) */
.dag-node:hover .port {
  background: var(--accent);        /* #6d5cff */
}

/* Port during connection drag: valid target */
.port[data-valid-target="true"] {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

/* Port during connection drag: invalid target */
.port[data-valid-target="false"] {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Port snapped (cursor within magnetic radius) */
.port[data-snapped="true"] {
  width: 12px;
  height: 12px;
  background: var(--accent);
  border: 2px solid var(--accent);
  box-shadow: 0 0 0 4px var(--accent-glow);
}

/* Input port snapped: adjust position for larger size */
.port-in[data-snapped="true"] {
  top: -6px;
}

/* Output port snapped: adjust position for larger size */
.port-out[data-snapped="true"] {
  bottom: -6px;
}
```

### 6.9 Connection Visual State Summary

| State | Stroke Color | Width | Opacity | Dash | Marker | Animation |
|---|---|---|---|---|---|---|
| Default | `var(--text-muted)` | 1.5px | 0.5 | none | `arrowhead-default` | none |
| Hovered | `var(--accent)` | 2px | 0.7 | none | `arrowhead-active` | none |
| Selected | `var(--accent)` | 2.5px | 0.9 | none | `arrowhead-active` | none |
| Active/Flowing | `var(--accent)` | 2px | 0.8 | 6 4 | `arrowhead-active` | `flowDash 1.5s` |
| Invalid | `var(--status-fail)` | 2px | 0.6 | 4 4 | `arrowhead-invalid` | none |
| Disabled | `var(--text-muted)` | 1px | 0.2 | none | `arrowhead-default` | none |
| Preview (dragging) | `var(--accent)` | 2px | 0.6 | 8 4 | none | none |
| Preview (snapped) | `var(--accent)` | 2.5px | 0.9 | none | none | none |
| Preview (invalid) | `var(--status-fail)` | 2px | 0.4 | 4 4 | none | none |

---
## 7. Keyboard & Accessibility

### 7.1 Keyboard Navigation

Connections must be fully operable via keyboard for accessibility compliance
(WCAG 2.1 AA). The keyboard interaction model treats connections as focusable
items in a logical order.

#### 7.1.1 Focus Order

Connections are focusable in DOM order (creation order). Tab navigation follows:

```
Canvas focus → First node → First node's ports → Second node → ...
                              ↕ (within node)
                         Connections tab ring
```

**Connection focus ring:**

| Key | Action |
|---|---|
| `Tab` | Focus next connection (or exit connection ring to next node) |
| `Shift+Tab` | Focus previous connection |
| `Enter` / `Space` | Select/deselect focused connection |
| `Delete` / `Backspace` | Delete focused connection |
| `Escape` | Clear selection and return focus to canvas |
| `Ctrl+A` | Select all connections |
| `Arrow Up/Down` | Navigate between connections attached to the focused node |

#### 7.1.2 Keyboard Connection Creation

Creating connections via keyboard (for users who cannot use mouse drag):

| Key | Action | State |
|---|---|---|
| `Enter` on output port | Begin connection creation mode | → PORT_ACTIVE |
| `Tab` / `Arrow` keys | Navigate to target input port | PORT_ACTIVE |
| `Enter` on input port | Confirm connection | → VALIDATING |
| `Escape` | Cancel connection creation | → IDLE |

**Keyboard creation flow:**

1. User focuses an output port and presses `Enter`.
2. Visual indicator shows "Connection mode active — navigate to target port."
3. Focus moves to the next valid input port (Tab order).
4. User navigates between valid input ports using Tab/Arrow keys.
5. Invalid ports are skipped in the Tab order.
6. User presses `Enter` on the desired input port → connection created.
7. Or presses `Escape` → cancelled.

#### 7.1.3 Keyboard Delete

| Key | Condition | Action |
|---|---|---|
| `Delete` | Connection focused | Delete focused connection |
| `Delete` | Multiple connections selected | Delete all selected |
| `Backspace` | Same as Delete | Same behavior |
| `Ctrl+Z` | After delete | Undo last delete |

### 7.2 ARIA Attributes

#### 7.2.1 Connection Path ARIA

Each SVG `<path>` element for a connection includes:

```html
<path
  class="connection"
  data-connection-id="conn-abc123"
  d="M 120,105 C 120,160 200,160 200,200"
  role="graphics-symbol"
  aria-label="Connection from Bronze Customers to Silver Customers Clean"
  aria-roledescription="data flow connection"
  tabindex="0"
  aria-selected="false"
  aria-describedby="conn-desc-abc123"
/>

<!-- Hidden description element for screen readers -->
<desc id="conn-desc-abc123">
  Data flows from Bronze Customers (output) to Silver Customers Clean (input).
  Press Delete to remove this connection.
</desc>
```

**ARIA attributes table:**

| Attribute | Value | Purpose |
|---|---|---|
| `role` | `graphics-symbol` | Identifies the path as a meaningful graphic element |
| `aria-label` | `"Connection from {source} to {target}"` | Screen-readable connection description |
| `aria-roledescription` | `"data flow connection"` | Describes the type of graphic element |
| `tabindex` | `"0"` | Makes the path keyboard-focusable |
| `aria-selected` | `"true"` / `"false"` | Reflects selection state |
| `aria-describedby` | `"conn-desc-{id}"` | Points to detailed description |
| `aria-invalid` | `"true"` (when invalid) | Indicates validation error |

#### 7.2.2 Connection Layer ARIA

The connection layer `<g>` element includes group-level ARIA:

```html
<g
  class="connection-layer"
  role="group"
  aria-label="Data flow connections"
  aria-describedby="connection-layer-desc"
>
  <desc id="connection-layer-desc">
    Contains all data flow connections between nodes on the DAG canvas.
    Use Tab to navigate between connections. Press Delete to remove a connection.
  </desc>
  <!-- Connection paths -->
</g>
```

#### 7.2.3 Port ARIA

Ports include ARIA attributes for connection creation:

```html
<!-- Output port -->
<div
  class="port port-out"
  role="button"
  aria-label="Output port of Bronze Customers. Press Enter to start creating a connection."
  tabindex="0"
  aria-haspopup="false"
  data-port-id="output-0"
  data-port-direction="output"
  data-node-id="node-bronze-customers"
/>

<!-- Input port -->
<div
  class="port port-in"
  role="button"
  aria-label="Input port of Silver Customers Clean. Press Enter to connect here."
  tabindex="0"
  data-port-id="input-0"
  data-port-direction="input"
  data-node-id="node-silver-customers-clean"
/>
```

### 7.3 Live Region Announcements

Screen readers are notified of connection events via a live region:

```html
<!-- Live region for connection announcements -->
<div
  id="connection-announcements"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  class="sr-only"
></div>
```

**Announcement messages:**

| Event | Announcement |
|---|---|
| Connection created | "Connection created from {source} to {target}" |
| Connection deleted | "Connection removed from {source} to {target}" |
| Multiple connections deleted | "{count} connections removed" |
| Connection creation started | "Connection mode active. Navigate to a target port and press Enter." |
| Connection creation cancelled | "Connection creation cancelled" |
| Connection rejected (cycle) | "Cannot create connection: would create a cycle" |
| Connection rejected (self-loop) | "Cannot create connection: cannot connect a node to itself" |
| Connection selected | "Connection from {source} to {target} selected" |

### 7.4 Focus Indicators

Connection focus indicators must be visible and high-contrast:

```css
/* Focus ring on connection path */
.connection:focus {
  outline: none; /* SVG paths don't support outline well */
}

.connection:focus-visible {
  stroke: var(--accent);
  stroke-width: 3;
  opacity: 1;
  filter: drop-shadow(0 0 3px var(--accent));
}

/* Focus ring on ports */
.port:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--accent-glow);
}
```

### 7.5 Reduced Motion Support

For users who prefer reduced motion, disable flow animations:

```css
@media (prefers-reduced-motion: reduce) {
  .connection[data-animating="true"] {
    animation: none;
    stroke-dasharray: none;
  }

  .port {
    transition: none;
  }

  .connection {
    transition: stroke 0ms, stroke-width 0ms, opacity 0ms;
  }
}
```

### 7.6 High Contrast Mode

Ensure connections are visible in Windows High Contrast mode:

```css
@media (forced-colors: active) {
  .connection {
    stroke: LinkText;
    forced-color-adjust: none;
  }

  .connection[data-selected="true"] {
    stroke: Highlight;
  }

  .connection[data-invalid="true"] {
    stroke: Mark;
  }

  .port {
    background: ButtonText;
    border-color: ButtonFace;
  }
}
```

---
## 8. Error Handling

### 8.1 Validation Pipeline

Every connection creation request passes through a sequential validation pipeline.
The pipeline stops at the first failure and returns the error. This is fail-fast:
cheaper checks run first.

```javascript
/**
 * Full validation pipeline for a proposed connection.
 * Checks are ordered by cost: cheapest first.
 *
 * @param sourceNodeId - Proposed source node
 * @param sourcePortId - Proposed source port
 * @param targetNodeId - Proposed target node
 * @param targetPortId - Proposed target port
 * @returns ValidationResult
 */
function validateConnection(sourceNodeId, sourcePortId, targetNodeId, targetPortId) {
  // ── Gate 1: Existence checks (O(1)) ──────────────────────────
  const sourceNode = nodeManager.getNode(sourceNodeId);
  if (!sourceNode) {
    return {
      valid: false,
      errorCode: 'SOURCE_NOT_FOUND',
      message: `Source node "${sourceNodeId}" does not exist.`,
    };
  }

  const targetNode = nodeManager.getNode(targetNodeId);
  if (!targetNode) {
    return {
      valid: false,
      errorCode: 'TARGET_NOT_FOUND',
      message: `Target node "${targetNodeId}" does not exist.`,
    };
  }

  // ── Gate 2: Self-loop check (O(1)) ───────────────────────────
  if (sourceNodeId === targetNodeId) {
    return {
      valid: false,
      errorCode: 'SELF_LOOP',
      message: 'Cannot connect a node to itself.',
    };
  }

  // ── Gate 3: Port existence and polarity (O(1)) ───────────────
  const sourcePort = typeRegistry.getPort(sourceNode.type, sourcePortId);
  if (!sourcePort || sourcePort.direction !== 'output') {
    return {
      valid: false,
      errorCode: 'WRONG_POLARITY',
      message: `Port "${sourcePortId}" on source node is not an output port.`,
    };
  }

  const targetPort = typeRegistry.getPort(targetNode.type, targetPortId);
  if (!targetPort || targetPort.direction !== 'input') {
    return {
      valid: false,
      errorCode: 'WRONG_POLARITY',
      message: `Port "${targetPortId}" on target node is not an input port.`,
    };
  }

  // ── Gate 4: Target port type check (O(1)) ────────────────────
  // Plain SQL Tables have no input ports — they are source-only nodes
  if (targetNode.type === 'plain-sql-table') {
    return {
      valid: false,
      errorCode: 'TARGET_NO_INPUT',
      message: 'Plain SQL Tables are source nodes and cannot receive connections.',
    };
  }

  // ── Gate 5: Duplicate check (O(1) with hash map) ─────────────
  const duplicateKey = `${sourceNodeId}:${sourcePortId}->${targetNodeId}:${targetPortId}`;
  if (store.duplicates.has(duplicateKey)) {
    return {
      valid: false,
      errorCode: 'DUPLICATE_EDGE',
      message: 'A connection between these ports already exists.',
    };
  }

  // ── Gate 6: Port capacity check (O(k) where k = connections on port) ──
  const existingOnTargetPort = getIncomingConnections(targetNodeId)
    .filter(c => c.targetPortId === targetPortId);
  if (targetPort.maxConnections !== -1 &&
      existingOnTargetPort.length >= targetPort.maxConnections) {
    return {
      valid: false,
      errorCode: 'PORT_FULL',
      message: `Target port "${targetPortId}" has reached its connection limit (${targetPort.maxConnections}).`,
    };
  }

  // ── Gate 7: Global connection limit (O(1)) ───────────────────
  if (store.size >= options.maxConnections) {
    return {
      valid: false,
      errorCode: 'MAX_CONNECTIONS',
      message: `Maximum number of connections (${options.maxConnections}) reached.`,
    };
  }

  // ── Gate 8: Cycle detection (O(V + E)) ───────────────────────
  // This is the most expensive check — runs last
  if (wouldCreateCycle(sourceNodeId, targetNodeId)) {
    const cyclePath = findCyclePath(sourceNodeId, targetNodeId);
    return {
      valid: false,
      errorCode: 'CYCLE_DETECTED',
      message: `Cannot create connection: would create a cycle (${cyclePath.join(' -> ')}).`,
      involvedNodes: cyclePath,
    };
  }

  // ── All gates passed ─────────────────────────────────────────
  return { valid: true };
}
```

### 8.2 Cycle Detection Algorithm

#### 8.2.1 Core Algorithm: DFS Reachability Check

To determine if adding an edge from `source` to `target` would create a cycle,
we check if `source` is reachable from `target` in the current graph. If it is,
adding the edge `source→target` would close the loop.

**Key insight:** In a DAG, adding edge `A→B` creates a cycle if and only if
there exists a path from B to A in the existing graph.

```javascript
/**
 * Check if adding an edge from sourceNodeId to targetNodeId would create a cycle.
 *
 * Algorithm: DFS from targetNodeId to see if we can reach sourceNodeId
 * through existing outgoing edges.
 *
 * Time complexity: O(V + E) where V = nodes, E = edges
 * Space complexity: O(V) for the visited set
 *
 * For 100-node graphs (our maximum): ~0.1ms typical, ~1ms worst case.
 *
 * @param sourceNodeId - Proposed source (the node the edge comes FROM)
 * @param targetNodeId - Proposed target (the node the edge goes TO)
 * @returns true if a cycle would be created
 */
function wouldCreateCycle(sourceNodeId, targetNodeId) {
  // If source === target, it is a self-loop (handled separately, but guard here too)
  if (sourceNodeId === targetNodeId) return true;

  // DFS: can we reach sourceNodeId starting from targetNodeId?
  const visited = new Set();
  const stack = [targetNodeId];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === sourceNodeId) {
      // Found a path from target back to source — cycle!
      return true;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    // Explore all outgoing edges from current node
    const outgoing = store.forward.get(current);
    if (outgoing) {
      for (const connection of outgoing) {
        if (!visited.has(connection.targetNodeId)) {
          stack.push(connection.targetNodeId);
        }
      }
    }
  }

  // source is not reachable from target — no cycle
  return false;
}
```

#### 8.2.2 Finding the Cycle Path (for Error Messages)

When a cycle is detected, we want to show the user the exact path that would
form the cycle. This uses a modified DFS that tracks the path:

```javascript
/**
 * Find the path that would form a cycle if edge source->target were added.
 *
 * Returns the path from target back to source through existing edges,
 * prefixed with source to show the full cycle.
 *
 * @param sourceNodeId - Proposed source
 * @param targetNodeId - Proposed target
 * @returns Array of node IDs forming the cycle, e.g., ['A', 'B', 'C', 'A']
 */
function findCyclePath(sourceNodeId, targetNodeId) {
  const visited = new Set();
  const parent = new Map();  // child -> parent for path reconstruction
  const stack = [targetNodeId];
  parent.set(targetNodeId, null);

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === sourceNodeId) {
      // Reconstruct path: source <- ... <- target <- source
      const path = [current];
      let node = targetNodeId;
      while (node !== null && node !== current) {
        path.push(node);
        node = parent.get(node);
      }
      // The cycle is: source -> target -> ... -> source
      // We need to reverse and add the closing source
      path.reverse();
      path.push(sourceNodeId);
      return path;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    const outgoing = store.forward.get(current);
    if (outgoing) {
      for (const connection of outgoing) {
        if (!visited.has(connection.targetNodeId)) {
          parent.set(connection.targetNodeId, current);
          stack.push(connection.targetNodeId);
        }
      }
    }
  }

  // Should not reach here if wouldCreateCycle returned true
  return [sourceNodeId, targetNodeId, sourceNodeId];
}
```

#### 8.2.3 Full Topological Sort (for Global Validation)

When C08-ValidationEngine requests a full DAG validation, ConnectionManager
provides a topological sort. If the sort cannot include all nodes, the graph
has a cycle (should never happen if all mutations go through the validated API).

```javascript
/**
 * Kahn's algorithm for topological sort.
 * Returns the sorted order, or null if a cycle exists.
 *
 * Time: O(V + E)
 * Space: O(V)
 *
 * @returns Array of node IDs in topological order, or null if cycle exists
 */
function topologicalSort() {
  const allNodes = nodeManager.getAllNodeIds();
  const inDegree = new Map();
  const queue = [];
  const result = [];

  // Initialize in-degree for all nodes
  for (const nodeId of allNodes) {
    inDegree.set(nodeId, 0);
  }

  // Calculate in-degrees
  for (const [nodeId, connections] of store.forward) {
    for (const conn of connections) {
      inDegree.set(
        conn.targetNodeId,
        (inDegree.get(conn.targetNodeId) || 0) + 1
      );
    }
  }

  // Enqueue all nodes with in-degree 0 (source nodes)
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  // Process queue
  while (queue.length > 0) {
    const current = queue.shift();
    result.push(current);

    const outgoing = store.forward.get(current);
    if (outgoing) {
      for (const conn of outgoing) {
        const newDegree = inDegree.get(conn.targetNodeId) - 1;
        inDegree.set(conn.targetNodeId, newDegree);
        if (newDegree === 0) {
          queue.push(conn.targetNodeId);
        }
      }
    }
  }

  // If result doesn't include all nodes, there's a cycle
  if (result.length !== allNodes.length) {
    return null;  // Cycle detected — should never happen in normal operation
  }

  return result;
}
```

### 8.3 Error Code Reference

| Code | Severity | User Message | Recovery |
|---|---|---|---|
| `SELF_LOOP` | Warning | "Cannot connect a node to itself." | Automatic — drag cancels. No user action needed. |
| `CYCLE_DETECTED` | Error | "Cannot create connection: would create a cycle ({path})." | User must choose a different target node. Toast shows the cycle path. |
| `WRONG_POLARITY` | Warning | "Connections must go from output ports to input ports." | Automatic — invalid ports are dimmed during drag. |
| `DUPLICATE_EDGE` | Info | "A connection between these ports already exists." | Automatic — drag cancels. Existing connection briefly highlights. |
| `SOURCE_NOT_FOUND` | Error | "Source node no longer exists." | Node was deleted during drag. Cancel operation. |
| `TARGET_NOT_FOUND` | Error | "Target node no longer exists." | Node was deleted during drag. Cancel operation. |
| `PORT_FULL` | Warning | "This input port has reached its connection limit." | User must connect to a different port. |
| `SOURCE_NO_OUTPUT` | Error | "This node type has no output ports." | Should not occur — output ports are the drag handle. |
| `TARGET_NO_INPUT` | Info | "This node type cannot receive connections." | Automatic — node's ports not shown as valid targets. |
| `MAX_CONNECTIONS` | Error | "Maximum number of connections ({limit}) reached." | User must delete connections before adding new ones. |
| `NODE_LOCKED` | Warning | "This node is locked and cannot be modified." | User must unlock the node first. |

### 8.4 Error Visual Feedback

#### 8.4.1 Connection Rejection Animation

When a connection is rejected, a brief visual animation indicates the failure:

```javascript
/**
 * Show rejection feedback on the canvas.
 *
 * @param errorCode - The validation error code
 * @param sourcePortEl - Source port DOM element
 * @param targetPortEl - Target port DOM element (may be null)
 * @param previewPath - Preview SVG path element
 */
function showRejectionFeedback(errorCode, sourcePortEl, targetPortEl, previewPath) {
  // 1. Flash the preview path red
  previewPath.classList.add('connection-preview--rejected');

  // 2. Flash the source port
  if (sourcePortEl) {
    sourcePortEl.style.background = 'var(--status-fail)';
  }

  // 3. Flash the target port (if it exists)
  if (targetPortEl) {
    targetPortEl.style.background = 'var(--status-fail)';
  }

  // 4. Show toast notification
  showToast({
    type: 'error',
    message: getErrorMessage(errorCode),
    duration: 3000,
    icon: 'warning',
  });

  // 5. For duplicate errors, highlight the existing connection
  if (errorCode === 'DUPLICATE_EDGE') {
    const existing = findExistingConnection(sourceNodeId, targetNodeId);
    if (existing) {
      highlightConnectionBriefly(existing.id, 'var(--accent)', 1000);
    }
  }

  // 6. For cycle errors, highlight the cycle path
  if (errorCode === 'CYCLE_DETECTED') {
    const cyclePath = findCyclePath(sourceNodeId, targetNodeId);
    for (const nodeId of cyclePath) {
      highlightNodeBriefly(nodeId, 'var(--status-fail)', 2000);
    }
  }

  // 7. Clean up after 300ms
  setTimeout(() => {
    previewPath.remove();
    if (sourcePortEl) sourcePortEl.style.background = '';
    if (targetPortEl) targetPortEl.style.background = '';
  }, 300);
}
```

#### 8.4.2 Rejection CSS

```css
/* Preview path rejection flash */
.connection-preview--rejected {
  stroke: var(--status-fail);
  stroke-width: 3;
  opacity: 0.8;
  animation: rejectFlash 300ms ease-out;
}

@keyframes rejectFlash {
  0% { opacity: 0.8; stroke-width: 3; }
  50% { opacity: 1.0; stroke-width: 4; }
  100% { opacity: 0; stroke-width: 3; }
}

/* Cycle path highlight on nodes */
.dag-node--cycle-highlight {
  box-shadow: 0 0 0 3px var(--status-fail),
              0 0 12px rgba(229, 69, 59, 0.3);
  transition: box-shadow 200ms var(--ease);
}
```

### 8.5 Error Recovery

| Scenario | Recovery Strategy |
|---|---|
| Node deleted during drag | Cancel drag, return to IDLE. Toast: "Connection cancelled — target node was removed." |
| Canvas unmounted during drag | `destroy()` cleans up all listeners and preview elements. |
| SVG render failure | Catch error, log warning, skip this connection's render. Other connections unaffected. |
| Corrupt serialized data | `deserialize()` validates each connection individually. Invalid entries skipped with error log. |
| Store inconsistency | `repairStore()` method rebuilds adjacency maps from connection index. Available in debug mode. |

---
## 9. Performance

### 9.1 Performance Budget

| Operation | Budget | Measured On | Notes |
|---|---|---|---|
| Connection preview update (per frame) | <8ms | 100-node graph | Single SVG path `d` attribute update |
| Node drag with connected edges | <16ms/frame | Node with 5 connections | Update all connected paths per frame |
| Connection creation (full pipeline) | <5ms | 100-node graph | Validation + DOM insertion |
| Cycle detection | <2ms | 100 nodes, 200 edges | DFS traversal |
| Hit test (single point) | <2ms | 50 connections | Point-to-Bezier distance for all connections |
| Initial render (all connections) | <100ms | 100 connections | Create all SVG path elements |
| Bulk delete | <50ms | 50 connections | Remove DOM elements + update store |
| Serialize | <10ms | 100 connections | JSON.stringify |
| Deserialize + render | <200ms | 100 connections | Parse + validate + render all |
| Undo/redo | <50ms | Any operation | Snapshot restore + re-render affected |

### 9.2 Hit Testing Algorithm

#### 9.2.1 Point-to-Bézier Distance

Hit testing determines which connection (if any) the user is hovering over or clicking.
Since connections are curved Bézier paths, we cannot use simple rectangle hit tests.
Instead, we find the minimum distance from the cursor to the nearest point on each curve.

**Algorithm: Iterative subdivision with early termination**

```javascript
/**
 * Calculate the minimum distance from a point to a cubic Bezier curve.
 *
 * Algorithm:
 * 1. Sample the curve at N evenly-spaced points
 * 2. Find the closest sample
 * 3. Refine around the closest sample using binary subdivision
 * 4. Return the minimum distance and the parameter t
 *
 * Time complexity: O(N + R * log(1/epsilon))
 *   where N = initial samples, R = refinement iterations
 *
 * For N=20, R=5: ~25 distance calculations per curve
 * For 50 connections: ~1250 calculations = ~0.5ms
 *
 * @param px - Point X coordinate
 * @param py - Point Y coordinate
 * @param p0, p1, p2, p3 - Bezier control points
 * @param initialSamples - Number of initial samples (default: 20)
 * @param refinementSteps - Number of binary refinement steps (default: 5)
 * @returns { distance, t, point } - Minimum distance, parameter t, closest point
 */
function pointToBezierDistance(px, py, p0, p1, p2, p3, initialSamples = 20, refinementSteps = 5) {
  let minDist = Infinity;
  let minT = 0;
  let minPoint = null;

  // ── Phase 1: Coarse sampling ────────────────────────────────
  // Sample the curve at evenly-spaced t values
  for (let i = 0; i <= initialSamples; i++) {
    const t = i / initialSamples;
    const point = bezierPoint(t, p0, p1, p2, p3);
    const dx = px - point.x;
    const dy = py - point.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < minDist) {
      minDist = dist;
      minT = t;
      minPoint = point;
    }
  }

  // ── Phase 2: Binary refinement ──────────────────────────────
  // Narrow the search around the best sample
  let tLow = Math.max(0, minT - 1 / initialSamples);
  let tHigh = Math.min(1, minT + 1 / initialSamples);

  for (let step = 0; step < refinementSteps; step++) {
    const tMid = (tLow + tHigh) / 2;
    const tQuarter = (tLow + tMid) / 2;
    const tThreeQuarter = (tMid + tHigh) / 2;

    const pointQ = bezierPoint(tQuarter, p0, p1, p2, p3);
    const pointM = bezierPoint(tMid, p0, p1, p2, p3);
    const pointTQ = bezierPoint(tThreeQuarter, p0, p1, p2, p3);

    const distQ = Math.hypot(px - pointQ.x, py - pointQ.y);
    const distM = Math.hypot(px - pointM.x, py - pointM.y);
    const distTQ = Math.hypot(px - pointTQ.x, py - pointTQ.y);

    // Find the minimum of the three
    if (distQ <= distM && distQ <= distTQ) {
      tHigh = tMid;
      if (distQ < minDist) {
        minDist = distQ;
        minT = tQuarter;
        minPoint = pointQ;
      }
    } else if (distTQ <= distM && distTQ <= distQ) {
      tLow = tMid;
      if (distTQ < minDist) {
        minDist = distTQ;
        minT = tThreeQuarter;
        minPoint = pointTQ;
      }
    } else {
      tLow = tQuarter;
      tHigh = tThreeQuarter;
      if (distM < minDist) {
        minDist = distM;
        minT = tMid;
        minPoint = pointM;
      }
    }
  }

  return {
    distance: minDist,
    t: minT,
    point: minPoint,
  };
}
```

#### 9.2.2 Full Hit Test Pipeline

The complete hit test checks all connections with early termination:

```javascript
/**
 * Find the connection nearest to a point, within tolerance.
 *
 * Optimization: Uses bounding box pre-filter to skip connections
 * that are obviously too far away.
 *
 * @param px - Cursor X in canvas coordinates
 * @param py - Cursor Y in canvas coordinates
 * @param tolerance - Maximum distance to consider a hit (default: 8px)
 * @returns Best hit result or null
 */
function hitTest(px, py, tolerance = 8) {
  // Adjust tolerance for zoom level
  const adjustedTolerance = tolerance / canvasRenderer.getZoomLevel();

  let bestHit = null;
  let bestDistance = adjustedTolerance;

  for (const connection of store.connections.values()) {
    // ── Bounding box pre-filter ──────────────────────────────
    const bounds = getConnectionBounds(connection.id);
    if (bounds) {
      const expandedBounds = {
        x: bounds.x - adjustedTolerance,
        y: bounds.y - adjustedTolerance,
        width: bounds.width + adjustedTolerance * 2,
        height: bounds.height + adjustedTolerance * 2,
      };

      // Skip if point is outside expanded bounding box
      if (px < expandedBounds.x || px > expandedBounds.x + expandedBounds.width ||
          py < expandedBounds.y || py > expandedBounds.y + expandedBounds.height) {
        continue;
      }
    }

    // ── Point-to-Bezier distance ─────────────────────────────
    const points = getCachedBezierPoints(connection.id);
    if (!points) continue;

    const result = pointToBezierDistance(
      px, py,
      points.p0, points.p1, points.p2, points.p3
    );

    if (result.distance < bestDistance) {
      bestDistance = result.distance;
      bestHit = {
        connection,
        distance: result.distance,
        t: result.t,
        point: result.point,
      };
    }
  }

  return bestHit;
}
```

#### 9.2.3 Rectangle Hit Test (Marquee Selection)

```javascript
/**
 * Find all connections that intersect a selection rectangle.
 *
 * Algorithm: Sample each Bezier curve at regular intervals and check
 * if any sample point falls within the rectangle.
 *
 * @param rect - Selection rectangle { x, y, width, height }
 * @returns Array of connections that intersect the rectangle
 */
function hitTestRect(rect) {
  const SAMPLES = 10;
  const results = [];
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;

  for (const connection of store.connections.values()) {
    const points = getCachedBezierPoints(connection.id);
    if (!points) continue;

    let intersects = false;

    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const point = bezierPoint(t, points.p0, points.p1, points.p2, points.p3);

      if (point.x >= rect.x && point.x <= rectRight &&
          point.y >= rect.y && point.y <= rectBottom) {
        intersects = true;
        break;
      }
    }

    if (intersects) {
      results.push(connection);
    }
  }

  return results;
}
```

### 9.3 Path Caching Strategy

Bézier control points are cached per connection and invalidated when
connected nodes move. This avoids recalculating control points on every
hit test or render.

```javascript
/**
 * Bezier point cache.
 * Key: connectionId
 * Value: { p0, p1, p2, p3, bounds, dirty }
 *
 * Invalidated when:
 * - Connected node moves (node:position-changed event)
 * - Connection is created or deleted
 * - Canvas zoom changes (bounds need recalculation)
 */
class BezierCache {
  constructor() {
    this._cache = new Map();
  }

  /**
   * Get cached Bezier points for a connection.
   * Recalculates if dirty or missing.
   */
  get(connectionId) {
    let entry = this._cache.get(connectionId);

    if (!entry || entry.dirty) {
      entry = this._recalculate(connectionId);
      this._cache.set(connectionId, entry);
    }

    return entry;
  }

  /**
   * Mark a connection's cache as dirty.
   * Does NOT recalculate immediately — lazy invalidation.
   */
  invalidate(connectionId) {
    const entry = this._cache.get(connectionId);
    if (entry) {
      entry.dirty = true;
    }
  }

  /**
   * Mark all connections attached to a node as dirty.
   * Called when a node moves.
   */
  invalidateForNode(nodeId) {
    const connections = connectionManager.getConnectionsForNode(nodeId);
    for (const conn of connections) {
      this.invalidate(conn.id);
    }
  }

  /**
   * Clear the entire cache.
   */
  clear() {
    this._cache.clear();
  }

  /** @private */
  _recalculate(connectionId) {
    const conn = connectionManager.getConnection(connectionId);
    if (!conn) return null;

    const sourcePos = nodeManager.getPortPosition(conn.sourceNodeId, conn.sourcePortId);
    const targetPos = nodeManager.getPortPosition(conn.targetNodeId, conn.targetPortId);

    const points = computeBezierPoints(sourcePos.x, sourcePos.y, targetPos.x, targetPos.y);

    // Calculate tight bounding box from control points
    const bounds = computeBezierBounds(points.p0, points.p1, points.p2, points.p3);

    return { ...points, bounds, dirty: false };
  }
}
```

### 9.4 Bézier Bounding Box

Tight bounding box for a cubic Bézier curve (used for hit test pre-filter):

```javascript
/**
 * Compute the tight axis-aligned bounding box of a cubic Bezier curve.
 *
 * Algorithm:
 * 1. Find the roots of the first derivative (extrema in X and Y)
 * 2. Evaluate the curve at t=0, t=1, and all extrema
 * 3. Return the min/max of all evaluated points
 *
 * @param p0, p1, p2, p3 - Bezier control points
 * @returns { x, y, width, height } bounding box
 */
function computeBezierBounds(p0, p1, p2, p3) {
  // Start with endpoints
  let minX = Math.min(p0.x, p3.x);
  let maxX = Math.max(p0.x, p3.x);
  let minY = Math.min(p0.y, p3.y);
  let maxY = Math.max(p0.y, p3.y);

  // Find extrema by solving B'(t) = 0 for X and Y independently
  // B'(t) = at^2 + bt + c (quadratic)
  const extremaT = [];

  // X extrema
  const ax = -3 * p0.x + 9 * p1.x - 9 * p2.x + 3 * p3.x;
  const bx = 6 * p0.x - 12 * p1.x + 6 * p2.x;
  const cx = 3 * p1.x - 3 * p0.x;
  solveQuadratic(ax, bx, cx, extremaT);

  // Y extrema
  const ay = -3 * p0.y + 9 * p1.y - 9 * p2.y + 3 * p3.y;
  const by = 6 * p0.y - 12 * p1.y + 6 * p2.y;
  const cy = 3 * p1.y - 3 * p0.y;
  solveQuadratic(ay, by, cy, extremaT);

  // Evaluate curve at each extremum
  for (const t of extremaT) {
    if (t > 0 && t < 1) {
      const point = bezierPoint(t, p0, p1, p2, p3);
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Solve quadratic equation at^2 + bt + c = 0.
 * Pushes real roots into the results array.
 */
function solveQuadratic(a, b, c, results) {
  if (Math.abs(a) < 1e-12) {
    // Linear: bt + c = 0
    if (Math.abs(b) > 1e-12) {
      results.push(-c / b);
    }
    return;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;

  const sqrtD = Math.sqrt(discriminant);
  results.push((-b + sqrtD) / (2 * a));
  results.push((-b - sqrtD) / (2 * a));
}
```

### 9.5 Rendering Optimization

#### 9.5.1 requestAnimationFrame Batching

During node drag, multiple connections need updating. Updates are batched
into a single requestAnimationFrame callback:

```javascript
/**
 * Batched connection path updates.
 * Collects dirty connections and updates them in one rAF callback.
 */
class RenderBatcher {
  constructor() {
    this._dirty = new Set();
    this._rafId = null;
  }

  /**
   * Mark a connection as needing a path update.
   */
  markDirty(connectionId) {
    this._dirty.add(connectionId);
    this._scheduleRender();
  }

  /**
   * Mark all connections for a node as dirty.
   */
  markDirtyForNode(nodeId) {
    const connections = connectionManager.getConnectionsForNode(nodeId);
    for (const conn of connections) {
      this._dirty.add(conn.id);
    }
    this._scheduleRender();
  }

  /** @private */
  _scheduleRender() {
    if (this._rafId !== null) return;  // Already scheduled

    this._rafId = requestAnimationFrame(() => {
      this._flush();
      this._rafId = null;
    });
  }

  /** @private */
  _flush() {
    for (const connectionId of this._dirty) {
      updateConnectionPath(connectionId);
    }
    this._dirty.clear();
  }

  /**
   * Cancel pending render.
   */
  cancel() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._dirty.clear();
  }
}
```

#### 9.5.2 SVG Path Attribute Minimization

Path `d` attribute strings are kept as short as possible to minimize
DOM mutation cost:

```javascript
// Round coordinates to 1 decimal place
// "M 120.3,105.7 C 120.3,160.2 200.1,160.2 200.1,200.0"
// vs. unrounded:
// "M 120.34567,105.67891 C 120.34567,160.23456 200.12345,160.23456 200.12345,200.00000"
//
// Saves ~50 bytes per path, ~5KB for 100 connections
const round = (n) => Math.round(n * 10) / 10;
```

#### 9.5.3 DOM Recycling

When connections are deleted and recreated (e.g., undo/redo), SVG path
elements are recycled from a pool instead of creating new DOM nodes:

```javascript
class PathPool {
  constructor(svgContainer) {
    this._pool = [];
    this._container = svgContainer;
  }

  acquire() {
    if (this._pool.length > 0) {
      const path = this._pool.pop();
      path.style.display = '';
      return path;
    }
    return document.createElementNS('http://www.w3.org/2000/svg', 'path');
  }

  release(pathEl) {
    pathEl.style.display = 'none';
    pathEl.removeAttribute('data-connection-id');
    pathEl.removeAttribute('d');
    pathEl.className = '';
    this._pool.push(pathEl);
  }
}
```

### 9.6 Memory Budget

| Data Structure | Size per Connection | Size at 100 Connections |
|---|---|---|
| Connection record | ~200 bytes | ~20 KB |
| Forward adjacency entry | ~50 bytes | ~5 KB |
| Reverse adjacency entry | ~50 bytes | ~5 KB |
| Duplicate index entry | ~80 bytes | ~8 KB |
| Bézier cache entry | ~150 bytes | ~15 KB |
| SVG `<path>` DOM element | ~500 bytes | ~50 KB |
| **Total** | **~1 KB** | **~103 KB** |

Maximum expected memory usage: ~103 KB for 100 connections.
Well within acceptable limits for a browser application.

---
## 10. Implementation Notes

### 10.1 File Structure

```
src/
  features/
    infra-wizard/
      components/
        connection-manager/
          ConnectionManager.js        # Main class (entry point)
          ConnectionStore.js           # Internal data store
          ConnectionRenderer.js        # SVG rendering logic
          ConnectionValidator.js       # Validation pipeline + cycle detection
          BezierMath.js               # All Bezier curve math utilities
          HitTester.js                # Point-to-curve and rectangle hit testing
          BezierCache.js              # Cached Bezier points + bounds
          RenderBatcher.js            # requestAnimationFrame batching
          PathPool.js                 # SVG path element recycling
          ConnectionDragHandler.js    # Mouse/touch event handling for drag
          ConnectionKeyHandler.js     # Keyboard event handling
          ConnectionA11y.js           # ARIA attribute management + announcements
          __tests__/
            ConnectionManager.test.js
            ConnectionValidator.test.js
            BezierMath.test.js
            HitTester.test.js
            CycleDetection.test.js
```

### 10.2 Class Hierarchy

```
EventEmitter (lib/EventEmitter.js)
  └── ConnectionManager
        ├── has-a ConnectionStore
        ├── has-a ConnectionRenderer
        ├── has-a ConnectionValidator
        ├── has-a BezierCache
        ├── has-a RenderBatcher
        ├── has-a PathPool
        ├── has-a ConnectionDragHandler
        ├── has-a ConnectionKeyHandler
        └── has-a ConnectionA11y
```

### 10.3 SVG `d` Attribute Reference

The SVG `d` attribute for connection paths uses exactly two commands:

| Command | Syntax | Description |
|---|---|---|
| `M` (Move To) | `M x,y` | Set the starting point of the path |
| `C` (Cubic Bézier) | `C cx1,cy1 cx2,cy2 x,y` | Draw a cubic Bézier curve |

**Complete `d` attribute format:**
```
M sourceX,sourceY C controlX1,controlY1 controlX2,controlY2 targetX,targetY
```

**Examples from the mock HTML:**
```
M 120,105 C 120,160 200,160 200,200
M 400,105 C 400,160 300,160 300,200
M 250,235 C 250,290 250,290 250,330
```

**Interpretation of `M 120,105 C 120,160 200,160 200,200`:**
- Start at (120, 105) — source port center
- Control point 1 at (120, 160) — same X as source, offset Y below
- Control point 2 at (200, 160) — same X as target, offset Y above
- End at (200, 200) — target port center

### 10.4 Port Coordinate Calculation

Port positions are calculated relative to the node's position in canvas coordinates.
The node's position is its top-left corner.

```javascript
/**
 * Calculate port center position in canvas coordinates.
 *
 * Ports are centered horizontally on the node.
 * Input ports are at the top edge; output ports are at the bottom edge.
 *
 * @param nodePosition - Node's top-left corner { x, y }
 * @param nodeSize - Node dimensions { width, height }
 * @param portDirection - 'input' or 'output'
 * @returns { x, y } port center in canvas coordinates
 */
function calculatePortPosition(nodePosition, nodeSize, portDirection) {
  const portX = nodePosition.x + nodeSize.width / 2;  // Centered horizontally

  let portY;
  if (portDirection === 'input') {
    portY = nodePosition.y;  // Top edge of node
  } else {
    portY = nodePosition.y + nodeSize.height;  // Bottom edge of node
  }

  return { x: portX, y: portY };
}
```

**Visual reference:**
```
              Port-In (input)
               ◦ ← (nodeX + width/2, nodeY)
         ┌─────────────┐
         │             │
         │  Node Body  │ ← nodePosition = top-left corner
         │             │
         └─────────────┘
               ◦ ← (nodeX + width/2, nodeY + height)
            Port-Out (output)
```

### 10.5 Canvas Coordinate Transform

All coordinates used by ConnectionManager are in **canvas space** (the untransformed
coordinate system). Mouse events provide screen coordinates that must be converted
to canvas coordinates using the inverse of the pan/zoom transform.

```javascript
/**
 * Convert screen coordinates to canvas coordinates.
 * Accounts for SVG viewBox, pan offset, and zoom level.
 *
 * @param screenX - Mouse X in screen/client coordinates
 * @param screenY - Mouse Y in screen/client coordinates
 * @param svgElement - The SVG canvas element
 * @returns { x, y } in canvas coordinates
 */
function screenToCanvas(screenX, screenY, svgElement) {
  const ctm = svgElement.getScreenCTM();
  if (!ctm) return { x: screenX, y: screenY };

  const inverse = ctm.inverse();
  const point = svgElement.createSVGPoint();
  point.x = screenX;
  point.y = screenY;

  const transformed = point.matrixTransform(inverse);
  return { x: transformed.x, y: transformed.y };
}
```

### 10.6 Event Listener Setup

ConnectionManager registers event listeners on the SVG container and
the document. All listeners are stored for cleanup in `destroy()`.

```javascript
/**
 * Register all event listeners.
 * Called once in the constructor.
 */
function setupEventListeners() {
  const listeners = [];

  // ── Mouse events on SVG container ────────────────────────────

  // Mousedown on ports: start connection creation
  listeners.push(
    on(svgContainer, 'mousedown', (e) => {
      const port = e.target.closest('.port-out');
      if (port) {
        const nodeId = port.dataset.nodeId;
        const portId = port.dataset.portId;
        dragHandler.start(nodeId, portId, e.clientX, e.clientY);
      }
    })
  );

  // Mousemove: update preview during drag, or hit test for hover
  listeners.push(
    on(svgContainer, 'mousemove', (e) => {
      if (dragHandler.isDragging()) {
        const canvasPos = screenToCanvas(e.clientX, e.clientY, svgContainer);
        const snapTarget = findNearestPort(
          canvasPos.x, canvasPos.y,
          dragHandler.sourceNodeId, 'input'
        );
        dragHandler.update(canvasPos.x, canvasPos.y, snapTarget);
      } else {
        // Hover hit test
        const canvasPos = screenToCanvas(e.clientX, e.clientY, svgContainer);
        const hit = hitTest(canvasPos.x, canvasPos.y);
        updateHoverState(hit);
      }
    })
  );

  // Mouseup: end connection creation
  listeners.push(
    on(svgContainer, 'mouseup', (e) => {
      if (dragHandler.isDragging()) {
        dragHandler.end();
      }
    })
  );

  // Click on connection path: select
  listeners.push(
    on(svgContainer, 'click', (e) => {
      const pathEl = e.target.closest('.connection');
      if (pathEl) {
        const connectionId = pathEl.dataset.connectionId;
        const exclusive = !e.ctrlKey && !e.metaKey;
        selectConnection(connectionId, exclusive);
      } else if (!e.target.closest('.dag-node')) {
        // Click on empty canvas: clear selection
        clearSelection();
      }
    })
  );

  // ── Keyboard events on document ──────────────────────────────

  listeners.push(
    on(document, 'keydown', (e) => {
      keyHandler.handle(e);
    })
  );

  // ── Node lifecycle events from C01-NodeManager ───────────────

  listeners.push(
    nodeManager.on('node:deleted', (e) => {
      deleteConnectionsForNode(e.nodeId);
    })
  );

  listeners.push(
    nodeManager.on('node:position-changed', (e) => {
      bezierCache.invalidateForNode(e.nodeId);
      renderBatcher.markDirtyForNode(e.nodeId);
    })
  );

  // Store listeners for cleanup
  this._listeners = listeners;
}

/**
 * Remove all event listeners.
 * Called in destroy().
 */
function teardownEventListeners() {
  for (const unsub of this._listeners) {
    unsub();
  }
  this._listeners = [];
}
```

### 10.7 Integration Points

#### 10.7.1 C01-NodeManager Integration

| Event from NodeManager | ConnectionManager Response |
|---|---|
| `node:created` | No action (connections require explicit user creation) |
| `node:deleted` | `deleteConnectionsForNode(nodeId)` — cascade delete all connections |
| `node:position-changed` | `updateConnectionsForNode(nodeId)` — recalculate and re-render paths |
| `node:type-changed` | Revalidate all connections for this node (port definitions may change) |
| `node:locked` | Set `data-disabled="true"` on all connections for this node |

#### 10.7.2 C03-CanvasRenderer Integration

| Event from CanvasRenderer | ConnectionManager Response |
|---|---|
| `canvas:zoom-changed` | Adjust hit test tolerance by zoom level. Invalidate all bounds cache. |
| `canvas:pan-changed` | No action (SVG transform handles this) |
| `canvas:resize` | No action (SVG viewBox handles this) |
| `canvas:initialized` | Get SVG container reference. Create `<defs>` with markers. |

#### 10.7.3 C10-UndoManager Integration

ConnectionManager pushes commands to UndoManager for every mutation:

```javascript
/**
 * Command objects pushed to C10-UndoManager.
 */

// Create connection
{
  type: 'connection:create',
  execute: () => connectionManager.createConnection(src, srcPort, tgt, tgtPort),
  undo: () => connectionManager.deleteConnection(connectionId),
  description: `Create connection ${srcNodeName} -> ${tgtNodeName}`,
}

// Delete connection
{
  type: 'connection:delete',
  execute: () => connectionManager.deleteConnection(connectionId),
  undo: () => connectionManager.restoreConnection(savedConnectionRecord),
  description: `Delete connection ${srcNodeName} -> ${tgtNodeName}`,
}

// Batch delete
{
  type: 'connection:batch-delete',
  execute: () => connectionManager.deleteConnections(connectionIds),
  undo: () => connectionManager.restoreConnections(savedRecords),
  description: `Delete ${count} connections`,
}
```

#### 10.7.4 C12-WizardStateManager Integration

```javascript
// Serialize: called when navigating away from Page 3
wizardState.connections = connectionManager.serialize();

// Deserialize: called when navigating back to Page 3
const result = connectionManager.deserialize(wizardState.connections);
if (result.errors.length > 0) {
  console.warn('Some connections could not be restored:', result.errors);
}
```

### 10.8 Touch Device Support

Connection creation supports touch events with the same state machine:

| Mouse Event | Touch Equivalent | Notes |
|---|---|---|
| `mousedown` | `touchstart` | Use first touch point |
| `mousemove` | `touchmove` | Prevent scroll during drag |
| `mouseup` | `touchend` | Use changedTouches[0] |
| hover | (none) | No hover on touch — show port labels on long-press |

```javascript
// Prevent scroll during connection drag
function onTouchMove(e) {
  if (dragHandler.isDragging()) {
    e.preventDefault();  // Prevent canvas scroll
    const touch = e.touches[0];
    const canvasPos = screenToCanvas(touch.clientX, touch.clientY, svgContainer);
    dragHandler.update(canvasPos.x, canvasPos.y);
  }
}
```

**Magnetic radius on touch:** Increased to 30px (from 20px) on touch devices
to account for finger imprecision.

### 10.9 Testing Strategy

| Test Category | Count | Framework | Notes |
|---|---|---|---|
| Unit: BezierMath | ~15 | Jest | Pure functions, easy to test |
| Unit: CycleDetection | ~10 | Jest | Various graph topologies |
| Unit: HitTester | ~8 | Jest | Known curves with known distances |
| Unit: ConnectionValidator | ~12 | Jest | All error codes covered |
| Unit: ConnectionStore | ~10 | Jest | CRUD, adjacency list integrity |
| Integration: ConnectionManager | ~20 | Jest + JSDOM | Full lifecycle with mocked DOM |
| Visual: Snapshot | ~5 | Jest + SVG snapshots | Path rendering consistency |
| E2E: Connection creation | ~8 | Playwright | Full drag flow with real browser |
| E2E: Connection deletion | ~4 | Playwright | Delete, undo, redo |
| E2E: Cycle rejection | ~3 | Playwright | Error feedback visible |
| **Total** | **~95** | | |

### 10.10 Open Questions

| # | Question | Status | Owner |
|---|---|---|---|
| 1 | Should connections support labels (e.g., showing transformation type)? | Deferred to v2 | Sana |
| 2 | Should there be a visual indicator of data volume on connections? | Deferred to v2 | Pixel |
| 3 | Should right-click on a connection show a context menu? | Design review needed | Pixel |
| 4 | Should connections support bendpoints (user-adjustable curve)? | Rejected — Bézier auto-routing is sufficient | Sana |
| 5 | Should multi-select connections with Ctrl+Click be supported? | Yes — included in spec (§3.4) | Pixel |
| 6 | Should connections animate on creation? | Yes — brief fade-in (200ms) | Pixel |
| 7 | Touch device: long-press on connection for context menu? | Design review needed | Pixel |

### 10.11 Dependencies and Library Versions

| Dependency | Version | Purpose | Size |
|---|---|---|---|
| nanoid | ^5.0.0 | Connection ID generation | ~1KB |
| (no other runtime deps) | — | All Bézier math is custom | — |

**Note:** JointJS is used by the canvas system (C03-CanvasRenderer) but
ConnectionManager implements its own SVG path rendering to avoid coupling
to JointJS's internal connection model. This allows us to:
1. Use our own Bézier control point calculation
2. Apply our exact CSS styling from the mock
3. Maintain our own hit testing with custom tolerance
4. Keep the connection data model decoupled from the rendering library

### 10.12 Migration Notes

If migrating from a prototype or different connection implementation:

1. **Data migration:** Convert old connection format to the `Connection` interface (§2.1).
2. **ID stability:** Preserve connection IDs if possible for undo history compatibility.
3. **Validation:** Run `validateConnection()` on each migrated connection.
4. **Re-render:** Call `renderAll()` after migration to rebuild all SVG paths.

### 10.13 Debug Mode

In development builds, ConnectionManager exposes debug utilities:

```javascript
// Enable debug mode
connectionManager.debug = true;

// Debug overlay: shows Bezier control points as dots
connectionManager.showControlPoints(true);

// Debug overlay: shows hit test radius around cursor
connectionManager.showHitTestRadius(true);

// Debug overlay: shows bounding boxes around connections
connectionManager.showBoundingBoxes(true);

// Console: dump store state
connectionManager.dumpStore();
// → { connections: 5, forward: Map(3), reverse: Map(4), duplicates: Map(5) }

// Console: validate graph integrity
connectionManager.validateIntegrity();
// → { valid: true, issues: [] }
// or
// → { valid: false, issues: ['Orphan connection conn-abc: target node not found'] }

// Repair store (rebuild adjacency maps from connection index)
connectionManager.repairStore();
```

---

## Appendix A: Complete CSS Reference

All CSS for ConnectionManager in one block, ready to copy into the build:

```css
/* ═══════════════════════════════════════════════════════════════════════
   C07-ConnectionManager — Complete CSS
   Design System: OKLCH colors, 4px spacing grid
   Source of truth: F16 infra-wizard mock (CEO-approved)
   ═══════════════════════════════════════════════════════════════════════ */

/* --- Connection Paths --- */
.connection {
  fill: none;
  stroke: var(--text-muted);
  stroke-width: 1.5;
  opacity: 0.5;
  cursor: pointer;
  transition: stroke 150ms var(--ease),
              stroke-width 150ms var(--ease),
              opacity 150ms var(--ease);
  marker-end: url(#arrowhead-default);
}

.connection:hover,
.connection[data-hovered="true"] {
  stroke: var(--accent);
  stroke-width: 2;
  opacity: 0.7;
  marker-end: url(#arrowhead-active);
}

.connection[data-selected="true"] {
  stroke: var(--accent);
  stroke-width: 2.5;
  opacity: 0.9;
  marker-end: url(#arrowhead-active);
}

.connection[data-animating="true"] {
  stroke: var(--accent);
  stroke-width: 2;
  opacity: 0.8;
  stroke-dasharray: 6 4;
  animation: flowDash 1.5s linear infinite;
  marker-end: url(#arrowhead-active);
}

.connection[data-invalid="true"] {
  stroke: var(--status-fail);
  stroke-width: 2;
  opacity: 0.6;
  stroke-dasharray: 4 4;
  marker-end: url(#arrowhead-invalid);
}

.connection[data-disabled="true"] {
  stroke: var(--text-muted);
  stroke-width: 1;
  opacity: 0.2;
  pointer-events: none;
  marker-end: url(#arrowhead-default);
}

.connection:focus-visible {
  stroke: var(--accent);
  stroke-width: 3;
  opacity: 1;
  filter: drop-shadow(0 0 3px var(--accent));
}

/* --- Preview Path --- */
.connection-preview {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 8 4;
  opacity: 0.6;
  pointer-events: none;
  transition: none;
}

.connection-preview.snapped {
  stroke-dasharray: none;
  opacity: 0.9;
  stroke-width: 2.5;
}

.connection-preview.invalid {
  stroke: var(--status-fail);
  stroke-dasharray: 4 4;
  opacity: 0.4;
}

.connection-preview--rejected {
  stroke: var(--status-fail);
  stroke-width: 3;
  opacity: 0.8;
  animation: rejectFlash 300ms ease-out;
}

/* --- Ports --- */
.port {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  border: 1.5px solid var(--surface);
  position: absolute;
  z-index: 2;
  cursor: crosshair;
  transition: transform 200ms var(--spring),
              background 150ms var(--ease),
              border 150ms var(--ease),
              width 200ms var(--spring),
              height 200ms var(--spring);
}

.port-in {
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
}

.port-out {
  bottom: -4px;
  left: 50%;
  transform: translateX(-50%);
}

.dag-node:hover .port {
  background: var(--accent);
}

.port[data-valid-target="true"] {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.port[data-valid-target="false"] {
  opacity: 0.3;
  cursor: not-allowed;
}

.port[data-snapped="true"] {
  width: 12px;
  height: 12px;
  background: var(--accent);
  border: 2px solid var(--accent);
  box-shadow: 0 0 0 4px var(--accent-glow);
}

.port-in[data-snapped="true"] {
  top: -6px;
}

.port-out[data-snapped="true"] {
  bottom: -6px;
}

.port:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--accent-glow);
}

/* --- Animations --- */
@keyframes flowDash {
  to { stroke-dashoffset: -20; }
}

@keyframes rejectFlash {
  0%  { opacity: 0.8; stroke-width: 3; }
  50% { opacity: 1.0; stroke-width: 4; }
  100% { opacity: 0; stroke-width: 3; }
}

/* --- Cycle highlight on nodes --- */
.dag-node--cycle-highlight {
  box-shadow: 0 0 0 3px var(--status-fail),
              0 0 12px rgba(229, 69, 59, 0.3);
  transition: box-shadow 200ms var(--ease);
}

/* --- Reduced Motion --- */
@media (prefers-reduced-motion: reduce) {
  .connection[data-animating="true"] {
    animation: none;
    stroke-dasharray: none;
  }
  .port { transition: none; }
  .connection { transition: stroke 0ms, stroke-width 0ms, opacity 0ms; }
}

/* --- High Contrast --- */
@media (forced-colors: active) {
  .connection { stroke: LinkText; forced-color-adjust: none; }
  .connection[data-selected="true"] { stroke: Highlight; }
  .connection[data-invalid="true"] { stroke: Mark; }
  .port { background: ButtonText; border-color: ButtonFace; }
}

/* --- Screen reader only --- */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

---

## Appendix B: Complete Bézier Math Reference

All Bézier math functions in one module:

```javascript
/**
 * BezierMath.js — Complete cubic Bezier curve utilities
 * Used by C07-ConnectionManager
 *
 * All functions are pure — no side effects, no DOM access.
 */

/** Round to 1 decimal place */
const R = (n) => Math.round(n * 10) / 10;

/**
 * Evaluate point on cubic Bezier at parameter t.
 * B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
 */
function point(t, p0, p1, p2, p3) {
  const mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt;
  const t2 = t * t, t3 = t2 * t;
  return {
    x: mt3*p0.x + 3*mt2*t*p1.x + 3*mt*t2*p2.x + t3*p3.x,
    y: mt3*p0.y + 3*mt2*t*p1.y + 3*mt*t2*p2.y + t3*p3.y,
  };
}

/**
 * First derivative (tangent) at parameter t.
 * B'(t) = 3(1-t)^2(P1-P0) + 6(1-t)t(P2-P1) + 3t^2(P3-P2)
 */
function derivative(t, p0, p1, p2, p3) {
  const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
  return {
    x: 3*mt2*(p1.x-p0.x) + 6*mt*t*(p2.x-p1.x) + 3*t2*(p3.x-p2.x),
    y: 3*mt2*(p1.y-p0.y) + 6*mt*t*(p2.y-p1.y) + 3*t2*(p3.y-p2.y),
  };
}

/**
 * Tangent angle at parameter t (radians).
 */
function angle(t, p0, p1, p2, p3) {
  const d = derivative(t, p0, p1, p2, p3);
  return Math.atan2(d.y, d.x);
}

/**
 * Approximate arc length via linear subdivision.
 */
function length(p0, p1, p2, p3, segments = 20) {
  let len = 0, prev = point(0, p0, p1, p2, p3);
  for (let i = 1; i <= segments; i++) {
    const cur = point(i / segments, p0, p1, p2, p3);
    len += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return len;
}

/**
 * Compute control points for TB (top-to-bottom) flow.
 */
function controlPoints(sx, sy, tx, ty, tension = 0.5, minOffset = 40) {
  const dy = ty - sy;
  let offset;
  if (dy > 0) offset = Math.max(dy * tension, minOffset);
  else if (dy < 0) offset = Math.max(Math.abs(dy) * 0.8, minOffset * 2);
  else offset = Math.max(Math.abs(tx - sx) * 0.5, minOffset * 1.5);

  return {
    p0: { x: sx, y: sy },
    p1: { x: sx, y: sy + offset },
    p2: { x: tx, y: ty - offset },
    p3: { x: tx, y: ty },
  };
}

/**
 * Build SVG path d attribute.
 */
function pathD(pts) {
  return `M ${R(pts.p0.x)},${R(pts.p0.y)} C ${R(pts.p1.x)},${R(pts.p1.y)} ${R(pts.p2.x)},${R(pts.p2.y)} ${R(pts.p3.x)},${R(pts.p3.y)}`;
}

/**
 * Minimum distance from point (px,py) to the curve.
 * Returns { distance, t, point }.
 */
function distanceTo(px, py, p0, p1, p2, p3, samples = 20, refine = 5) {
  let minD = Infinity, minT = 0, minPt = null;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pt = point(t, p0, p1, p2, p3);
    const d = Math.hypot(px - pt.x, py - pt.y);
    if (d < minD) { minD = d; minT = t; minPt = pt; }
  }

  let lo = Math.max(0, minT - 1/samples);
  let hi = Math.min(1, minT + 1/samples);

  for (let s = 0; s < refine; s++) {
    const mid = (lo + hi) / 2;
    const q1 = (lo + mid) / 2;
    const q3 = (mid + hi) / 2;

    const pq1 = point(q1, p0, p1, p2, p3);
    const pm  = point(mid, p0, p1, p2, p3);
    const pq3 = point(q3, p0, p1, p2, p3);

    const dq1 = Math.hypot(px - pq1.x, py - pq1.y);
    const dm  = Math.hypot(px - pm.x,  py - pm.y);
    const dq3 = Math.hypot(px - pq3.x, py - pq3.y);

    if (dq1 <= dm && dq1 <= dq3) {
      hi = mid; if (dq1 < minD) { minD = dq1; minT = q1; minPt = pq1; }
    } else if (dq3 <= dm) {
      lo = mid; if (dq3 < minD) { minD = dq3; minT = q3; minPt = pq3; }
    } else {
      lo = q1; hi = q3; if (dm < minD) { minD = dm; minT = mid; minPt = pm; }
    }
  }

  return { distance: minD, t: minT, point: minPt };
}

/**
 * Tight axis-aligned bounding box.
 */
function bounds(p0, p1, p2, p3) {
  let xMin = Math.min(p0.x, p3.x), xMax = Math.max(p0.x, p3.x);
  let yMin = Math.min(p0.y, p3.y), yMax = Math.max(p0.y, p3.y);

  const roots = [];
  _solveQ(-3*p0.x+9*p1.x-9*p2.x+3*p3.x, 6*p0.x-12*p1.x+6*p2.x, 3*p1.x-3*p0.x, roots);
  _solveQ(-3*p0.y+9*p1.y-9*p2.y+3*p3.y, 6*p0.y-12*p1.y+6*p2.y, 3*p1.y-3*p0.y, roots);

  for (const t of roots) {
    if (t > 0 && t < 1) {
      const pt = point(t, p0, p1, p2, p3);
      xMin = Math.min(xMin, pt.x); xMax = Math.max(xMax, pt.x);
      yMin = Math.min(yMin, pt.y); yMax = Math.max(yMax, pt.y);
    }
  }
  return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
}

function _solveQ(a, b, c, out) {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
    return;
  }
  const disc = b*b - 4*a*c;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  out.push((-b + sq) / (2*a));
  out.push((-b - sq) / (2*a));
}

export { point, derivative, angle, length, controlPoints, pathD, distanceTo, bounds };
```

---

*End of C07-ConnectionManager Component Deep Spec*