# P0.4 — Industry Research: Visual DAG Builder UX Patterns

> **Author:** Sana (Architecture & Research Agent)
> **Date:** 2025-07-17
> **Status:** Complete
> **Purpose:** Inform F16 New Infra Wizard DAG canvas design decisions

---

## Executive Summary

After researching 16 industry-leading tools across data pipeline orchestrators, general visual builders, and data lineage platforms, the following best-practice synthesis emerges for F16:

**Node Placement:** Drag from a categorized sidebar palette with fuzzy search (n8n + NiFi pattern). Supplement with a right-click context menu on canvas for power users. Avoid click-then-pick modals — they break flow.

**Connection Drawing:** Drag from output port to input port with real-time visual validation (React Flow pattern). Highlight valid targets, dim invalid ones. Prevent cycles at draw-time, not after. Generous port hit targets (≥16px).

**Node Editing:** Click-to-open popover anchored to the node (not a full side panel, not inline). This keeps spatial context while providing enough room for configuration. The popover pattern from n8n's NDV (Node Detail View) is the gold standard.

**Canvas Navigation:** Scroll-to-zoom centered on cursor, spacebar+drag to pan, minimap bottom-right. Zoom-to-fit button. This is the Figma standard and users already have muscle memory for it.

**Auto-Layout:** Dagre algorithm (Sugiyama layered), left-to-right flow direction, user-triggered via button (not automatic). Animate transitions with 300ms ease-out. ELK is overkill for ≤100 nodes.

**Visual Design:** Rounded rectangles, color-coded by node type (3 colors for 3 types), connection lines as smooth cubic Bézier curves, clear selected/hover states. No 3D effects, no shadows on lines. OKLCH color palette per EDOG design system.

**Rendering:** SVG for nodes + edges (DOM-based for accessibility, CSS-styled, event-handling built in). At 100 nodes, SVG performs well. Canvas API is overkill and kills accessibility.

**Key Differentiator:** What will make our DAG builder extraordinary is *constraint-aware intelligence*: the system understands data pipeline semantics (sources can't have parents, MLVs need at least one parent, cycles are impossible) and communicates this through the visual language itself — dimming invalid drop targets, coloring valid ports, auto-suggesting logical next nodes. This is what separates a *data pipeline designer* from a generic flowchart tool.

---

## 1. Tool-by-Tool Analysis

### 1.1 dbt Cloud — DAG / Lineage Explorer

**Context:** dbt Cloud's DAG is primarily a *read-only lineage visualization* of models defined in code, not a drag-and-drop builder. However, its visualization patterns are best-in-class for data pipeline graphs.

**Node Placement UX:**
- Nodes are auto-placed by the layout engine — users don't manually place nodes since models are defined in code
- Layout uses a hierarchical Sugiyama-style algorithm, positioning parent nodes left of dependents (left-to-right flow)
- Grouping by folder, database, or custom tags with collapsible clusters

**Connection Drawing:**
- Connections are auto-derived from SQL `ref()` calls — no manual drawing
- Edges rendered as smooth curves between nodes

**Node Editing:**
- Click opens a side panel (drawer) with model metadata: SQL preview, run history, tags, owner, docs link
- Hover shows quick summary popup with status
- Right-click context menu for "Run from here," "Open in IDE"

**Canvas Navigation:**
- Scroll-to-zoom, click-drag to pan
- Minimap in corner for large graphs
- Search bar to locate and zoom to any node
- "F" key to focus/zoom-to-fit selected node
- Keyboard arrow navigation between upstream/downstream

**Auto-Layout:**
- Fully automatic hierarchical layout (Sugiyama-based)
- Left-to-right flow direction
- Collapsible groups reduce visual complexity
- Filter by type, tag, or status to declutter

**Visual Design:**
- Different shapes per node type: models (rounded rectangles), sources (circles/pills), seeds (diamonds), tests (hexagons)
- Color coding: models (blue/green), sources (purple/grey), seeds (yellow/orange), tests (red)
- Status overlays: red border for failed, green halo for success
- Clicking a node highlights full upstream+downstream lineage with bolder lines
- Hover de-emphasizes unrelated nodes for focus

**What Makes It Extraordinary:**
- **Lineage-first focus:** Selecting any node instantly reveals the complete data dependency chain in both directions with smooth visual emphasis. The "impact highlighting" — where upstream and downstream paths glow while the rest fades — is the single best pattern for understanding data flow at a glance.

---

### 1.2 Apache Airflow — DAG Graph View

**Context:** Airflow's DAG UI has historically been read-only (DAGs defined in Python code), but the 2024 experimental Visual DAG Editor adds drag-and-drop authoring capabilities.

**Node Placement UX:**
- Traditional: Nodes auto-placed from code-defined DAGs
- New Visual Editor (experimental): Drag tasks from toolbar onto canvas
- Add/delete nodes via toolbar or context menu

**Connection Drawing:**
- Traditional: Edges derived from task dependencies in code
- Visual Editor: Drag from one node to another to create dependency; right-click edges for deletion
- Edge manipulation with connector handles

**Node Editing:**
- Click opens a drawer/modal with logs, code, XComs, retries
- Hover shows quick summary popup (status, owner, last run)
- Action buttons within modal: Clear, Run, Mark Success

**Canvas Navigation:**
- Click-drag on empty space to pan
- Scroll-wheel to zoom
- Task search to locate and highlight specific nodes

**Auto-Layout:**
- Automatic hierarchical layout for code-defined DAGs
- Visual editor supports manual positioning with grid alignment

**Visual Design:**
- Color-coded by task state: success (green), failed (red), running (yellow), skipped (pink)
- Task groups can be expanded/collapsed
- Rectangular nodes with status-colored backgrounds
- Multi-select with Shift/Ctrl+click for batch operations

**What Makes It Extraordinary:**
- **State-centric visualization:** Every node is a live window into execution state. The color coding is deeply ingrained — data engineers worldwide read Airflow's color language fluently. The graph view doubles as an operational dashboard, not just a design tool.

---

### 1.3 Prefect — Flow Visualization

**Context:** Prefect 2.x/Orion offers an interactive DAG visualization for flows and tasks, primarily as a monitoring/debugging view.

**Node Placement UX:**
- Nodes auto-placed from code-defined flows — not a visual builder
- Layout engine positions tasks in dependency order

**Connection Drawing:**
- Edges auto-derived from task dependencies
- Smooth directional arrows between nodes

**Node Editing:**
- Click opens side panel with logs, configuration, and run details
- Hover shows mini-popover with task status summary
- "Adjacency controls" show/hide to filter to direct dependencies only

**Canvas Navigation:**
- Zoom and pan with standard mouse controls
- Search bar to find tasks by name/tag, auto-centers result on canvas
- Filter by state, tags, or retry counts

**Auto-Layout:**
- Automatic hierarchical layout
- Experimental drag-to-rearrange (layout-only, doesn't affect execution order)

**Visual Design:**
- Nodes change color/shape by state: queued, running, succeeded, failed, retried
- Clicking failed node highlights all affected downstream nodes
- Expandable/collapsible subflows for large graphs
- Gantt-style timeline overlay option for execution duration visualization

**What Makes It Extraordinary:**
- **Gantt overlay on the DAG:** Prefect uniquely overlays execution timing on the dependency graph, letting you see not just *what* depends on *what*, but *how long* each step took and where bottlenecks are. This dual-view (structure + time) is a powerful debugging pattern.

---

### 1.4 Dagster — Asset Graph

**Context:** Dagster's Asset Graph visualizes "software-defined assets" and their dependencies. It's a read-and-operate view, not a drag-and-drop builder.

**Node Placement UX:**
- Auto-layout from code-defined asset dependencies
- Grouping by project, domain, or custom tags
- Custom views: by job, partition, or freshness policy

**Connection Drawing:**
- Edges auto-derived from asset dependencies
- Directional edges showing upstream/downstream

**Node Editing:**
- Click to focus, opens side panel with metadata, freshness info, last materialization, code location
- Right-click context menu: run, materialize, view details
- Multi-select with drag-to-select for bulk operations

**Canvas Navigation:**
- Zoom and pan with standard controls
- Minimap navigator for large graphs
- Search and filter by name or tag
- Dependency highlighting on selection

**Auto-Layout:**
- Automatic layered layout
- Improved layout algorithms in 2024 for reduced edge crossings

**Visual Design:**
- Nodes show real-time status: materialized, stale, failed
- Shareable links to specific graph views/states
- Clean, modern design with consistent visual language

**What Makes It Extraordinary:**
- **Asset-centric thinking:** Dagster doesn't think in "tasks" but in "assets" (the data artifacts). This reframes the DAG as a *data topology* rather than a *workflow*. Nodes represent the *outputs* (tables, files, models), not the *processes*. This is directly analogous to our F16 use case where nodes are tables/MLVs, not transformation steps.

---

### 1.5 n8n — Visual Workflow Builder

**Context:** n8n is the most relevant *visual builder* reference — it's a true drag-and-drop node-based workflow canvas where users construct flows visually.

**Node Placement UX:**
- **Searchable node palette:** Press Tab or click "+" to open a categorized, fuzzy-searchable node menu
- **Drag-and-drop:** Drag from palette onto canvas with free positioning
- **Snap-to-grid:** Optional alignment with clean grid snapping
- **Smart insertion:** Drop a node near an existing connection → auto-inserts it between connected nodes, rewiring automatically
- **Quick-add from node:** Click "+" on an existing node's output to add a connected node inline

**Connection Drawing:**
- Drag from output dot to input dot with smooth Bézier curves
- **Auto-connect:** After placing a new node, one-click to connect to nearest compatible node
- **Visual feedback:** Compatible ports glow/highlight on hover during drag
- Dynamic connection lines reroute elegantly when nodes move
- Labels/tooltips on connections for conditional/data-mapping nodes

**Node Editing:**
- **Node Detail View (NDV):** Click a node to open a slide-over panel from the right with full configuration
- NDV shows: parameters, input/output data preview, settings, documentation
- Changes apply in real-time — no "save" button needed
- Close NDV to return to canvas

**Canvas Navigation:**
- Fluid zoom with trackpad/mouse wheel
- Click-drag on empty space to pan
- Minimap in corner for complex workflows
- Undo/redo buttons in toolbar

**Auto-Layout:**
- Not prominent — users arrange nodes manually
- Snap-to-grid and alignment guides help keep things tidy
- No one-click auto-arrange

**Visual Design:**
- Rectangular nodes with rounded corners, brand-colored headers
- Each node type has a distinct icon and color accent
- Selected nodes have glowing border
- Grouped nodes get soft background highlight
- Light-gray grid canvas background
- Smooth curved connection lines with directional arrows

**What Makes It Extraordinary:**
- **Smart insertion between existing connections.** Drop a node onto a wire, and it auto-inserts with rewiring. This single interaction eliminates the most tedious part of graph editing — disconnect, add node, reconnect. No other tool does this as smoothly. Also, the inline "+" button on every node output makes building linear chains effortless.

---

### 1.6 Apache NiFi — Data Flow Designer

**Context:** NiFi is a mature data flow visual designer with a full-featured canvas for building data processing pipelines.

**Node Placement UX:**
- **Drag from toolbar:** Processors are dragged from a categorized palette onto the canvas
- **Searchable palette:** Filter/search in the processor list for quick discovery
- **Click-to-place alternative:** Click processor in palette, then click on canvas to place
- **Snap-to-grid** for alignment
- **Immediate configuration prompt:** Optionally prompts for name/properties on initial placement

**Connection Drawing:**
- Click and drag from a processor's output port to target's input port
- **Port highlighting:** Valid targets highlight when dragging a connection
- **Directional arrows** show data flow direction
- **Auto-routing:** Lines intelligently avoid crossing processors
- Multiple connections per processor supported
- Escape or right-click cancels connection in progress
- **Inline labels** on connections for clarity

**Node Editing:**
- **Double-click** to open configuration dialog (full modal with tabs for properties, scheduling, settings)
- Right-click context menu: edit, delete, configure, view status
- Selected processor shows status/stats in header bar

**Canvas Navigation:**
- Pan with click-drag on empty space
- Scroll-wheel zoom
- Minimap for large flows
- Breadcrumb navigation for nested process groups (sub-flows)

**Auto-Layout:**
- Manual arrangement is primary
- Optional "tidy up" / auto-layout function
- Process groups (sub-canvases) for modular organization

**Visual Design:**
- Rectangular processors with status bar (bytes in/out, queue depth)
- Color coding by status: running (green), stopped (red), disabled (grey)
- Connection queues shown on edges (unique to NiFi — edges have "weight")
- Error/warning indicators on nodes

**What Makes It Extraordinary:**
- **Connections as first-class citizens.** NiFi treats edges not just as arrows but as *queues* with back-pressure, prioritization, and size limits. While we don't need queue semantics, the principle of making connections meaningful (not just lines) is valuable — in our case, connections carry the semantic meaning of "this table depends on that table."

---

### 1.7 Retool Workflows — Visual Workflow Canvas

**Context:** Retool Workflows is a low-code visual builder targeting non-engineers, making its UX patterns exceptionally polished for approachability.

**Node Placement UX:**
- Drag-and-drop from categorized node palette
- Snap-to-grid with alignment guidelines
- Context-aware placement suggestions

**Connection Drawing:**
- Drag from output to input with animated path preview
- Connection handles are large and clearly visible
- Wire highlighting during connection drawing
- Visual feedback for valid/invalid connections

**Node Editing:**
- Click opens a properties panel (right-side)
- Inline parameter configuration
- Real-time preview of node behavior

**Canvas Navigation:**
- Smooth zoom and pan
- Minimap for navigation
- Undo/redo support

**Auto-Layout:**
- Auto-spacing/arrangement tools
- Grid snapping keeps layouts clean

**Visual Design:**
- Clean, modern aesthetic with rounded node shapes
- Color-coded connection types
- Animated path drawing when creating connections
- Generous whitespace, large click targets

**What Makes It Extraordinary:**
- **Approachability and forgiveness.** Retool's canvas is designed so that it's *nearly impossible to make an error* — connections validate in real-time, node placement is guided, and everything feels gentle and forgiving. This "safe sandbox" feel is what we should aim for in F16, since users are building topologies for code generation, not writing code.

---

### 1.8 Figma — Canvas Interactions

**Context:** While not a DAG tool, Figma defines the gold standard for infinite canvas interactions that every visual tool now emulates.

**Canvas Navigation (the reference standard):**
- **Scroll to zoom** centered on cursor position (Ctrl/Cmd + scroll)
- **Pinch-to-zoom** on trackpad
- **Space + drag** to pan (Hand tool)
- **Middle-mouse drag** to pan
- **Minimap** bottom-right corner
- **Zoom presets:** Ctrl+0 (100%), Ctrl+1 (fit all), Ctrl+2 (fit selection)
- **Keyboard shortcuts:** +/- for zoom, arrow keys for nudge
- Smooth, eased transitions between zoom levels — never jarring

**Selection Patterns:**
- Click to select, Shift+click for multi-select
- Drag marquee on empty space for area select
- Click empty space to deselect
- Clear bounding box with resize handles on selection

**What Makes It Extraordinary:**
- **Kinesthetic fluidity.** Every interaction in Figma feels *physically correct* — zoom has the right easing, pan has the right momentum, selection has the right feedback latency. This isn't about features; it's about *feel*. We should match Figma's physics for our canvas interactions.

---

### 1.9 Miro — Infinite Canvas

**Context:** Miro is a collaborative whiteboard with excellent connector drawing patterns.

**Connection Drawing:**
- **Drag-and-connect:** Drag from node port to target
- **Click-to-connect (sequential):** Click source port, then click target — good for touch devices
- **Contextual quick-connect:** Right-click → "Connect to..." or "Create and connect new node"
- Auto-routing with real-time smoothing as nodes move
- Edge style options: curved, straight, step (orthogonal)

**Canvas Navigation:**
- Infinite canvas with smooth zoom/pan
- Edge scrolling: dragging near canvas edge auto-pans
- Minimap overview

**What Makes It Extraordinary:**
- **"Create and connect" from context menu.** Right-clicking a node and selecting "Create and connect new node" is a workflow accelerator — it combines two actions into one. We should steal this for F16: right-click a node → "Add child SQL MLV" creates the node AND the connection in one action.

---

### 1.10 draw.io (diagrams.net) — Diagramming Tool

**Context:** draw.io is the most widely-used free diagramming tool, with mature canvas interaction patterns.

**Node Placement UX:**
- Drag from sidebar shape palette
- Search within palette
- Snap-to-grid with smart alignment guides
- Click node → drag from edge handle to auto-create connected node

**Connection Drawing:**
- Drag from connection points (green dots on shape edges)
- Auto-routing: orthogonal, curved, or straight — configurable per edge
- Smart routing avoids node overlaps

**Auto-Layout:**
- Multiple algorithms: Circle, Organic, Grid, Vertical Tree, Horizontal Tree, Compact Tree
- One-click re-layout via Arrange → Layout menu
- Select-all + layout for instant reorganization

**Node Editing:**
- Double-click to edit label inline
- Right-click context menu for properties
- Style panel on the right for visual properties

**Visual Design:**
- Huge shape library with customization
- Smart guides during placement (alignment lines appear dynamically)
- Distribute/equalize spacing tools

**What Makes It Extraordinary:**
- **Multiple layout algorithms accessible via one menu.** Users can try different layouts instantly and pick what works. For F16, we should offer at least two: "left-to-right hierarchy" (dagre) and "top-to-bottom hierarchy" as options in the auto-layout button.

---

### 1.11 React Flow (xyflow) — Open Source Library

**Context:** React Flow is *the* dominant open-source library for building node-based UIs in React. While we're building in vanilla JS (ADR-002), its design patterns are the industry reference.

**Core Capabilities:**
- Custom nodes as components — any HTML/SVG content inside nodes
- Custom edges — Bézier, step, smoothstep, straight
- Built-in: panning, zooming, multi-select, drag-and-drop, snap-to-grid
- MiniMap and Controls as optional plugins
- Controlled and uncontrolled state modes

**Connection Validation:**
- `isValidConnection` callback for custom rules (prevent self-edges, type checking, cycle detection)
- Dynamic visual feedback: ports highlight when valid target during drag
- Per-port validation granularity

**Performance:**
- Handles thousands of nodes via virtualization and minimal re-renders
- Change detection for efficient DOM updates
- Web Worker offloading for layout calculations

**Auto-Layout Integration:**
- Not built-in, but provides examples for Dagre and ELK integration
- Layout computed externally, then positions applied to React Flow state
- Documented patterns for web worker offloading of layout calculations

**What Makes It Extraordinary:**
- **`isValidConnection` pattern.** The ability to define a validation function that runs *during* the drag — before the user even releases — and visually signals validity is the best connection UX in any library. We must implement this exact pattern: as the user drags a wire, only valid target ports glow, invalid ones dim, and the wire itself changes color to signal validity.

---

### 1.12 Unreal Blueprints / Unity Visual Scripting — Node Graph Editors

**Context:** Game engine visual scripting editors handle the most complex node graphs (hundreds of nodes, many connection types) and have decades of UX refinement.

**Node Placement UX:**
- Right-click on canvas opens categorized node search palette
- Fuzzy search with category browsing
- Drag from pin (unconnected) → opens context menu filtered to compatible node types

**Connection Drawing:**
- Drag from pin to pin with type-matched color coding
- **Pin colors encode data types:** bool (red), int (teal), float (green), string (magenta), object (blue)
- Smooth Bézier curves for wires
- **Reroute nodes:** Double-click a wire to insert a "reroute point" for cable management
- Alt+click on wire for quick disconnection

**Node Editing:**
- Click to select, details appear in Properties panel (separate dockable window)
- Some nodes have inline editable values (small fields directly on the node)
- Double-click to "dive into" a subgraph (for macro/function nodes)

**Canvas Navigation:**
- Mouse wheel zoom, middle-mouse pan
- Right-click drag to pan
- "F" key to zoom-to-fit selected nodes
- Minimap toggle for large graphs

**Auto-Layout:**
- No built-in auto-layout — manual arrangement is primary
- **Comment boxes** (colored rectangles) for grouping related nodes with titles
- Reroute nodes for wire organization

**Visual Design:**
- Nodes have title bar (colored by category), collapsible pin sections
- Pin shapes encode type (circle, diamond, hexagon, etc.)
- Wires: smooth Bézier curves, color-matched to pin type
- Selected nodes: bright outline, bold header

**What Makes It Extraordinary:**
- **"Drag from unconnected pin → filtered context menu" pattern.** When you drag a wire from an output and release on empty canvas, the node search menu opens pre-filtered to nodes that accept that output type. This is the most efficient node-creation-with-connection pattern ever designed. For F16: drag from a source table's output and release on empty space → menu shows only "SQL MLV" and "PySpark MLV" (the valid child types).

---

### 1.13 Databricks Unity Catalog — Lineage Visualization

**Context:** Databricks Unity Catalog provides native automated lineage visualization for tables, views, notebooks, and ML objects.

**Key Patterns:**
- Click-to-focus centers and expands node's direct lineage
- Column-level lineage drill-down (unique — most tools only show table-level)
- Path tracing: selecting a node highlights all upstream/downstream paths
- Filter by lineage direction (upstream only, downstream only), object type, time range
- Group/cluster nodes by schema for complex graphs
- Deep links to SQL Editor or Catalog Explorer from nodes

**What Makes It Extraordinary:**
- **Column-level lineage.** While we don't need column-level lineage in F16, the principle of *multi-resolution zoom* — seeing the coarse graph then drilling into finer detail — is powerful. In our case, this could mean zooming in to a node to see its columns, schema, or generated code preview without opening a separate view.

---

### 1.14 Microsoft Fabric Data Factory — Pipeline Visual Editor

**Context:** Fabric Data Factory is the closest competitor to what we're building — a visual pipeline editor for data integration within the Microsoft ecosystem.

**Node Placement UX:**
- Drag activities from left toolbox onto canvas
- Snap-to-grid with alignment guidelines
- Auto-arrange tool for multi-selected nodes
- Copy/paste and multi-select with keyboard shortcuts

**Connection Drawing:**
- Click small arrow at activity edge → drag to target activity
- Smart connector routing avoids overlaps
- Conditional paths: success/failure/completion with icons and color coding
- Connector anchor points can be dragged for manual rerouting

**Node Editing:**
- Select node → properties pane opens below/right without losing canvas position
- Tabbed properties: General, Settings, Parameters, User Properties
- Validation errors shown inline on nodes

**Canvas Navigation:**
- Zoom and pan with standard controls
- Node grouping for visual compactness

**Visual Design:**
- Rectangular activity nodes with icon + label
- Conditional edge indicators (green = success, red = failure, blue = completion)
- Clear validation error badges
- Clean, professional Microsoft design language

**What Makes It Extraordinary:**
- **Conditional edge semantics baked into the visual language.** Edges aren't just "depends on" — they carry execution conditions (on success, on failure, on completion). While F16 edges are simpler (pure data dependency), the principle of *typed edges with distinct visual treatment* could be useful if we later support optional vs. required dependencies.

---

### 1.15 Azure Data Factory — Pipeline Canvas

**Context:** ADF is the predecessor to Fabric Data Factory, with a well-established visual pipeline authoring canvas.

**Key Patterns (additive to Fabric):**
- Activities pane on left with categorized list
- Arrow connectors from activity edge with drag-to-target
- Container support: If Condition, Switch, ForEach with nested activities
- Debug run directly from canvas with per-activity status visualization
- Right-click context menu for quick actions
- Annotation support on canvas (text labels attached to nodes)

**What Makes It Extraordinary:**
- **In-canvas debugging.** Run the pipeline and watch each node turn green/red in real-time on the same canvas you designed it on. While F16 doesn't execute pipelines, we can borrow this for *validation*: show a visual pass/fail state on each node based on whether its configuration is complete and valid.

---

### 1.16 Snowflake — Data Lineage (Snowsight)

**Context:** Snowflake's lineage visualization in Snowsight is a newer entrant (2024), providing native automated lineage for tables, views, and ML objects.

**Key Patterns:**
- Interactive directed graph of upstream/downstream dependencies
- Click into nodes for object and column-level lineage
- Filter by time, object type, relationship strength
- Integration with tags and masking policies — governance metadata visible on the graph
- `GET_LINEAGE()` SQL function for programmatic access
- Impact analysis: "blast radius" visualization of a change's effect

**What Makes It Extraordinary:**
- **Governance-integrated lineage.** Tags, masking policies, and access controls are visible directly on the lineage graph. For F16, we could show node-level metadata (lakehouse, schema, estimated row count) directly on or near nodes, making the topology informative at a glance.

---

## 2. Pattern Comparison Matrix

| Pattern | dbt Cloud | Airflow | Prefect | Dagster | n8n | NiFi | Retool | Figma | React Flow | Blueprints | Fabric DF | ADF |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Node Placement** | Auto (code) | Auto / drag (exp.) | Auto (code) | Auto (code) | Palette drag + search | Toolbar drag + search | Palette drag | N/A | Custom (lib) | Right-click menu | Toolbox drag | Toolbox drag |
| **Connection Drawing** | Auto (code) | Auto / drag (exp.) | Auto (code) | Auto (code) | Port-to-port drag | Port-to-port drag | Port-to-port drag | N/A | Port-to-port drag | Pin-to-pin drag | Edge arrow drag | Edge arrow drag |
| **Node Editing** | Side drawer | Modal/drawer | Side panel | Side panel | Slide-over NDV | Double-click modal | Right panel | N/A | Custom | Properties panel | Properties pane | Properties pane |
| **Canvas Zoom** | Scroll | Scroll | Scroll | Scroll | Scroll/pinch | Scroll | Scroll | Scroll (Cmd) | Scroll | Wheel | Scroll | Scroll |
| **Canvas Pan** | Click-drag | Click-drag | Click-drag | Click-drag | Click-drag | Click-drag | Click-drag | Space+drag | Click-drag | Middle/right | Click-drag | Click-drag |
| **Minimap** | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (plugin) | ✓ (toggle) | ✗ | ✗ |
| **Auto-Layout** | Automatic | Automatic | Automatic | Automatic | Manual (grid) | Manual (tidy) | Auto-space | N/A | External (dagre) | Manual | Auto-arrange | Auto-arrange |
| **Layout Direction** | Left→Right | Top→Bottom | Top→Bottom | Left→Right | Left→Right | Free | Left→Right | N/A | Configurable | Free | Left→Right | Left→Right |
| **Connection Validation** | N/A | Limited | N/A | N/A | Type hints | Port highlight | Feedback | N/A | `isValidConnection` | Type-matched pins | Error cues | Validation |
| **Undo/Redo** | N/A | Limited | N/A | N/A | ✓ | ✓ (Ctrl+Z) | ✓ | ✓ | Custom | ✓ | ✓ | ✓ |
| **Node Shapes** | Multi-shape | Rectangle | Rectangle | Rectangle | Rounded rect | Rectangle | Rounded rect | N/A | Custom | Title bar + pins | Rectangle + icon | Rectangle + icon |
| **Color by Type** | ✓ (5 types) | State-based | State-based | State-based | ✓ (node type) | Status-based | ✓ | N/A | Custom | Pin-type colors | Activity-type | Activity-type |
| **Edge Style** | Smooth curves | Straight/step | Smooth curves | Smooth curves | Bézier curves | Orthogonal | Animated Bézier | N/A | Bézier/step/smooth | Bézier curves | Smart route | Smart route |

---

## 3. Best-in-Class Recommendations for F16

### 3.1 Node Placement — Recommended Approach

**Pattern: Sidebar palette + contextual quick-add**

1. **Primary:** A collapsible left sidebar with 3 node types (Plain SQL Table, SQL MLV, PySpark MLV), each with icon, label, and brief description. Drag from palette onto canvas.

2. **Secondary:** Right-click on empty canvas → context menu with "Add Plain SQL Table," "Add SQL MLV," "Add PySpark MLV."

3. **Power-user:** Drag from an existing node's output port and release on empty canvas → context menu opens, pre-filtered to valid child node types only (stealing from Unreal Blueprints).

4. **Smart insertion (stretch goal):** Drop a node onto an existing edge → auto-insert between the two connected nodes.

**Rationale:** n8n and NiFi prove that sidebar palettes are the most discoverable pattern for new users. The Unreal "drag from pin" pattern is the fastest for experienced users. Combining both serves all skill levels.

**Details:**
- Palette should be collapsible to maximize canvas space
- Each node type card shows: icon (color-coded), name, one-line description
- No search needed (only 3 types) — but if we add more types later, add fuzzy search
- Drop position is where the cursor releases — no "placement mode"

---

### 3.2 Connection Drawing — Recommended Approach

**Pattern: Port-to-port drag with real-time validation**

1. Nodes have clearly visible **output ports** (right edge, small circle) and **input ports** (left edge, small circle)
2. User clicks+drags from output port → a Bézier curve follows the cursor
3. While dragging, **valid target ports glow** (green pulse), **invalid ones dim** (e.g., source-to-source, would-create-cycle)
4. Release on valid port → connection created with smooth animation
5. Release on empty space → (a) discard wire, or (b) open "add node" context menu (Unreal pattern)
6. **Cycle prevention:** Real-time detection during drag — if connecting would create a cycle, target port shows red, cursor shows "not allowed" icon
7. **Self-connection prevention:** Output port of a node cannot connect to its own input

**Connection Rules (F16-specific):**
- Plain SQL Tables (sources): output ports only, no input ports (they have no parents)
- SQL MLV and PySpark MLV: both input and output ports (can be parents and children)
- Multiple parents per node: unlimited (multiple input connections allowed)
- Multiple children per node: unlimited (multiple output connections allowed)
- No cycles: enforced at draw-time

**Visual feedback during drag:**
- Wire color: neutral (grey) while dragging, green on valid hover, red on invalid hover
- Valid targets: port scales up slightly (1.2×) + subtle glow
- Invalid targets: port remains dim, cursor changes to "no-drop"
- Existing connections: semi-transparent during drag to reduce visual clutter

---

### 3.3 Node Editing — Recommended Approach

**Pattern: Click-to-open anchored popover**

1. Click on a node → a **popover panel** appears anchored to the node (not a full side panel, not a modal)
2. Popover contains:
   - Node name (editable inline)
   - Type indicator (icon + label, read-only)
   - Type-specific fields (table name, schema, lakehouse, query details)
   - "Delete node" action at bottom
3. Click outside popover or press Escape to close
4. Changes auto-save (no explicit save button — React-style controlled state)

**Why popover, not side panel:**
- **Spatial context:** User sees the node and its connections while editing — no context switch
- **Focus:** Popover draws attention to the specific node being configured
- **Space efficiency:** Doesn't consume permanent screen real estate like a side panel
- **Precedent:** n8n's NDV pattern (slide-over from node) is the most liked by users in surveys

**Why not inline editing on nodes:**
- Nodes need to stay compact on the canvas (especially at 100 nodes)
- Configuration has enough fields that inline editing would bloat node size
- Inline editing makes it unclear when you're "in edit mode" vs. "in navigation mode"

---

### 3.4 Canvas Navigation — Recommended Approach

**Pattern: Figma-standard canvas controls**

| Action | Input | Notes |
|--------|-------|-------|
| Zoom in/out | Scroll wheel (Ctrl+scroll on trackpad) | Zoom centered on cursor position |
| Pan | Space + left-click drag | Or middle-mouse drag |
| Zoom to fit all | Ctrl+1 or toolbar button | Animated transition |
| Zoom to selection | Ctrl+2 or double-click node | Centers and zooms to selected node(s) |
| Zoom 100% | Ctrl+0 | |
| Select node | Click | |
| Multi-select | Shift+click or drag marquee | |
| Deselect | Click empty canvas | |
| Delete selected | Delete or Backspace key | With confirmation for nodes with connections |

**Minimap:**
- Position: bottom-right corner of canvas
- Shows: all nodes as colored dots, viewport rectangle
- Interactive: click/drag on minimap to navigate
- Toggle: can be hidden via toolbar button
- Size: ~150×100px, semi-transparent background

**Zoom range:** 25% to 400%, with smooth eased transitions (CSS `transition: transform 200ms ease-out`)

---

### 3.5 Auto-Layout — Recommended Approach

**Pattern: User-triggered dagre layout with animated transition**

1. **Button** in toolbar: "Auto-arrange" (icon: grid/tree icon)
2. **Algorithm:** Dagre (Sugiyama layered layout)
   - Direction: left-to-right (matches data flow mental model: sources on left, derived on right)
   - Node separation: 80px horizontal, 60px vertical
   - Rank separation: 200px (space between "layers")
3. **Trigger:** User clicks button → all nodes animate to computed positions over 300ms with ease-out
4. **Preserve manual adjustments:** Auto-layout is opt-in, never automatic. Moving a node after auto-layout is allowed — the system doesn't snap it back
5. **Layout options dropdown (stretch goal):**
   - Left-to-right (default)
   - Top-to-bottom
   - Compact (reduced spacing)

**Why dagre, not ELK:**
- Dagre: 80KB, synchronous, fast (30-200ms for 100 nodes), simple API, pure JS
- ELK: 1MB, async (WASM), 50-500ms, complex API, overkill for ≤100 nodes
- Our constraint is ≤100 nodes — dagre handles this trivially
- ELK's advanced features (edge routing, group nodes, constraint-based layout) aren't needed for F16

**Why not automatic layout:**
- Users form spatial mental models ("my fact tables are on the left, my aggregations are top-right")
- Auto-layout on every change is disorienting and destroys spatial memory
- dbt/Dagster use auto-layout because they're read-only views — we're a builder

---

### 3.6 Visual Design — Recommended Approach

**Node design:**
```
┌─────────────────────────┐
│ ● [icon] Node Name      │  ← Color-coded header bar (type-specific)
│                         │
│  lakehouse: lh_sales    │  ← Subtitle / key metadata
│  schema: dbo            │
└─────────────────────────┘
  ○                     ○     ← Input port (left), Output port (right)
```

- **Shape:** Rounded rectangle (8px border-radius)
- **Size:** ~200px wide, ~80px tall (compact but readable)
- **Header bar:** Full-width, color-coded by type:
  - Plain SQL Table (source): `oklch(0.75 0.12 220)` (blue)
  - SQL MLV: `oklch(0.75 0.12 150)` (green)
  - PySpark MLV: `oklch(0.75 0.12 310)` (purple)
- **Body:** Node name in semibold, key metadata in secondary text
- **Ports:** 12px circles, positioned at vertical center of left (input) and right (output) edges
  - Sources: output port only (right side)
  - MLVs: input port (left) + output port (right)

**Connection lines:**
- Style: Cubic Bézier curves (smooth S-curves)
- Color: `oklch(0.55 0.02 240)` (muted blue-grey) for normal state
- Width: 2px normal, 3px on hover
- Arrow: Small arrowhead at target end (6px)
- Selected: highlighted with accent color, 3px width

**Canvas:**
- Background: subtle dot grid pattern (`oklch(0.95 0 0)` dots on `oklch(0.98 0 0)` background)
- Grid spacing: 20px

**States:**
| State | Visual Treatment |
|-------|-----------------|
| Default | Normal colors, 1px border |
| Hover | Subtle shadow, border brightens |
| Selected | Accent-color border (2px), subtle shadow, ports visible/enlarged |
| Dragging | Slight opacity reduction (0.85), drop shadow |
| Invalid drop target | Red border flash |
| Incomplete config | Warning badge (▲) top-right corner |

---

## 4. Technical Implementation Notes

### 4.1 Rendering Approach: SVG + HTML Hybrid

**Recommended:** SVG for edges (paths), HTML `<div>` elements for nodes, all within a single transform-group `<div>` for zoom/pan.

**Why this hybrid:**
- **Nodes as HTML:** Rich content (text, badges, icons), CSS styling, native event handling, accessible to screen readers
- **Edges as SVG:** Bézier curves are trivial in SVG (`<path d="M... C...">`), crisp at any zoom, CSS-styleable
- **Zoom/Pan:** Apply CSS `transform: scale(X) translate(Y, Z)` to a wrapper `<div>` — GPU-accelerated, smooth

**Why not Canvas API:**
- Canvas loses DOM accessibility (no screen reader support)
- Hit testing requires manual computation
- No CSS styling for nodes
- At ≤100 nodes, Canvas performance advantage is negligible

**Why not pure SVG:**
- Rich node content (forms, inputs in popovers) is awkward in SVG `<foreignObject>`
- CSS layout within SVG is limited

### 4.2 Recommended Libraries (Vanilla JS Compatible)

| Library | Purpose | Size | Notes |
|---------|---------|------|-------|
| **dagre** | Auto-layout algorithm | ~80KB | Pure JS, no dependencies, Sugiyama layout |
| **dagre-d3** | Skip — we don't need D3 | — | D3 dependency is heavy and unnecessary |
| **Custom SVG** | Edge rendering | 0KB | Write our own `<path>` generation — it's ~50 lines of code for cubic Bézier |
| **No framework lib** | Node rendering | 0KB | Vanilla JS class-based modules per ADR-002 |

**We do NOT need React Flow / xyflow** — it's React-only. We take its *design patterns* but implement in vanilla JS:
- Port validation callback pattern → implement as `isValidConnection(sourceNode, targetNode)` method
- Zoom/pan → CSS transforms on wrapper div
- Node positioning → absolute positioning with `left`/`top` styles
- Edge paths → SVG `<path>` elements with computed Bézier control points

### 4.3 Performance Considerations (100 Nodes)

| Concern | Mitigation |
|---------|-----------|
| DOM elements | ~100 node divs + ~150 SVG paths = ~250 elements — trivial for modern browsers |
| Zoom/Pan smoothness | CSS `transform` on single wrapper — GPU-composited, 60fps |
| Layout computation | Dagre at 100 nodes: <200ms — can run synchronously without blocking UI |
| Edge re-rendering on node drag | Debounce at 16ms (requestAnimationFrame), only recompute affected edges |
| Memory | Negligible at this scale — no virtualization needed |
| Large DAGs (future) | If we ever need >500 nodes, add viewport culling (only render visible nodes). SVG supports this via `getBBox()` checks |

### 4.4 Undo/Redo Architecture

**Command pattern:**
```
UndoStack = [
  { type: 'ADD_NODE', data: { node } },
  { type: 'MOVE_NODE', data: { nodeId, fromPos, toPos } },
  { type: 'ADD_EDGE', data: { edge } },
  { type: 'REMOVE_NODE', data: { node, connectedEdges } },
  { type: 'EDIT_NODE', data: { nodeId, oldProps, newProps } },
]
```
- Each action pushes a command object onto the stack
- Undo pops and applies inverse
- Redo re-applies from redo stack
- Stack limit: 50 operations
- `Ctrl+Z` / `Ctrl+Y` keyboard shortcuts

### 4.5 Accessibility Considerations

1. **Keyboard navigation:**
   - Tab through nodes in topological order
   - Arrow keys to navigate between connected nodes
   - Enter to open node editor popover
   - Delete to remove selected node
   - Space to start/cancel connection mode

2. **Screen reader support:**
   - Nodes as `role="listitem"` within `role="list"` container
   - `aria-label` on each node: "SQL MLV node: customer_orders, 2 parents, 1 child"
   - Connection announcements via `aria-live` region: "Connected sales_raw to customer_orders"
   - Graph summary accessible via shortcut: "Graph contains 5 nodes: 2 sources, 2 SQL MLVs, 1 PySpark MLV"

3. **Visual accessibility:**
   - Node type differentiation not solely by color — also by icon and shape variation
   - Minimum contrast ratio 4.5:1 for all text (WCAG AA)
   - Focus ring on all interactive elements (2px solid, high-contrast color)
   - Port hit targets ≥16px diameter (minimum touch target)

---

## 5. Anti-Patterns to Avoid

### 5.1 "Spaghetti Wires" — The #1 Enemy
**Problem:** Large graphs become unreadable wire tangles.
**Solution:** Auto-layout button + Bézier curves (not straight lines) + sufficient node spacing. Consider reroute points for complex topologies (stretch goal).

### 5.2 Tiny Port Hit Targets
**Problem:** Small connection ports (< 12px) are frustrating, especially on laptops without a mouse.
**Solution:** Ports are 12px visible but 20px hit area (invisible padding). Enlarge to 16px visible on hover.

### 5.3 No Undo
**Problem:** Users are terrified of making mistakes in complex graphs without undo.
**Solution:** Full undo/redo stack (Command pattern) from day one. Non-negotiable.

### 5.4 Forced Auto-Layout
**Problem:** Automatic re-layout after every change destroys spatial memory.
**Solution:** Auto-layout is always opt-in (button click). Never rearrange nodes without user request.

### 5.5 Modal Overload for Node Editing
**Problem:** Full-screen modals for editing break canvas context entirely.
**Solution:** Anchored popover that keeps the canvas visible. User can see connected nodes while editing.

### 5.6 No Visual Feedback During Connection Drag
**Problem:** User drags a wire and has no idea what's a valid target.
**Solution:** Real-time validation with visual signals (glow valid, dim invalid, prevent cycles visually).

### 5.7 Generic Flowchart Aesthetics
**Problem:** Tool looks like draw.io — rectangles, blue lines, no personality.
**Solution:** Color-coded node types, custom OKLCH palette, smooth animations, subtle grid, polished interactions. This is a *data pipeline designer*, not a generic diagramming tool.

### 5.8 No Keyboard Support
**Problem:** Mouse-only interactions exclude users and slow down power users.
**Solution:** Full keyboard navigation from launch. Tab order, arrow key traversal, keyboard shortcuts for all actions.

### 5.9 Overloaded Nodes
**Problem:** Cramming too much info into node rectangles makes them unreadable at scale.
**Solution:** Nodes show only: type icon, name, key metadata (1 line). All details in the editor popover. At 100 nodes, compact nodes are essential.

### 5.10 Invisible Node State
**Problem:** No visual indicator of whether a node's configuration is complete or has errors.
**Solution:** Warning badge (▲) on nodes with incomplete configuration. Green checkmark on fully valid nodes (stretch goal). This is borrowed from ADF's in-canvas validation pattern.

---

## 6. Summary: The F16 DAG Builder Design DNA

Our DAG builder should feel like:
- **n8n** for node placement and connection UX (drag, snap, smart insertion)
- **Figma** for canvas physics (zoom, pan, selection feel)
- **Unreal Blueprints** for power-user connection patterns (drag-from-port → filtered context menu)
- **dbt Cloud** for lineage visualization (impact highlighting, node type shapes)
- **Retool** for approachability (impossible to make errors, forgiving interactions)

Built with:
- **dagre** for auto-layout
- **SVG** for edges + **HTML divs** for nodes
- **CSS transforms** for zoom/pan
- **Command pattern** for undo/redo
- **Vanilla JS classes** per ADR-002

The key differentiator: **semantic awareness.** Our canvas *understands* that it's building a data pipeline — it knows sources can't have parents, MLVs need parents, cycles are impossible. Every interaction communicates these constraints visually, before the user even tries. This turns the builder from a generic canvas into an intelligent topology designer.

---

*End of research document. Next step: P0.5 — Detailed wireframes and interaction specifications.*
