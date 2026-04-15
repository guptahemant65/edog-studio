# P0.6 — Canvas Interaction Research: Node Placement & Visual Graph Building

**Author:** Pixel (Frontend Agent)
**Date:** 2025-07-15
**Status:** Research Complete
**Scope:** F16 New Infra Wizard — DAG Canvas Implementation

---

## Executive Summary

**Recommended Stack:**
- **Library:** JointJS Core (open-source, MPL-2.0) — SVG-based, vanilla JS native, rich port/connection system, extensible node rendering, active maintenance (5.2K GitHub stars)
- **Rendering:** DOM nodes (HTML divs) for node content + SVG for connections (hybrid approach via JointJS's SVG renderer with foreignObject for rich HTML content)
- **Node Placement:** Hybrid — quick-add toolbar (primary) + right-click context menu + keyboard shortcut (`/`)
- **Connection Drawing:** Port-based drag with Bézier preview curves and snap-to-port feedback
- **Auto-Layout:** Dagre (layered DAG layout, ~50 KB gzipped, Sugiyama-based algorithm)
- **Undo/Redo:** Command pattern with reversible command objects

**Why not Drawflow?** Despite being ultra-lightweight (9 KB), Drawflow has critical limitations: ports cannot be customized (fixed left/right placement), no per-port HTML/icons, no auto-layout, no undo/redo, and limited extensibility. For a "best DAG builder ever" aspiration, it's too constrained.

**Why not Cytoscape.js?** Canvas-rendered (not SVG), so custom HTML inside nodes requires hacky overlays (`cytoscape-node-html-label`). Designed for graph *visualization*, not graph *editing*. No built-in ports or connection drawing.

**Why JointJS Core?** SVG-based (crisp at any zoom), native port system, native connection routing (Manhattan/smooth/straight), built-in events, vanilla JS, extensible shape definitions, JSON serialization, and a well-documented API. The open-source core provides everything we need; we do NOT need the commercial Rappid/JointJS+ tier.

**Backup Pick:** Build from scratch with D3.js + custom SVG. More control, more effort (3–4× implementation time), but zero dependency risk.

---

## 1. Library Evaluation

### 1.1 Comprehensive Comparison Matrix

| Library | Vanilla JS | Rendering | Connections | Ports | Zoom/Pan | Auto-Layout | Undo/Redo | Bundle (gzip) | License | GitHub Stars | Verdict |
|---------|-----------|-----------|-------------|-------|----------|-------------|-----------|---------------|---------|-------------|---------|
| **JointJS Core** | ✅ Native | SVG | ✅ Rich (routers, connectors) | ✅ Native | ✅ Built-in | ❌ (integrate Dagre) | ❌ (build it) | ~180 KB | MPL-2.0 | 5.2K | ⭐ **RECOMMENDED** |
| **Drawflow** | ✅ Native | DOM+SVG | ✅ Basic | ⚠️ Fixed L/R only | ✅ Built-in | ❌ None | ❌ None | ~9 KB | MIT | 6K | Too limited |
| **Cytoscape.js** | ✅ Native | Canvas | ✅ Basic | ❌ No ports | ✅ Built-in | ✅ (Dagre plugin) | ❌ None | ~150 KB | MIT | 10K+ | Visualization focus |
| **D3.js** | ✅ Native | SVG | 🔨 Manual | 🔨 Manual | 🔨 Manual | 🔨 Manual | 🔨 Manual | ~80 KB | ISC | 110K+ | Too low-level |
| **Konva.js** | ✅ Native | Canvas | 🔨 Manual | 🔨 Manual | ✅ Built-in | ❌ None | ❌ None | ~80 KB | MIT | 11K+ | Canvas limitation |
| **Fabric.js** | ✅ Native | Canvas | 🔨 Manual | 🔨 Manual | ✅ Built-in | ❌ None | ❌ None | ~250 KB | MIT | 30K+ | Wrong paradigm |
| **Litegraph.js** | ✅ Native | Canvas | ✅ Built-in | ✅ Built-in | ✅ Built-in | ❌ None | ❌ None | ~120 KB | MIT | 6K+ | Dark-themed, gaming focus |
| **GoJS** | ✅ Native | Canvas+SVG | ✅ Rich | ✅ Native | ✅ Built-in | ✅ Built-in | ✅ Built-in | ~280 KB | **Commercial** | 8K+ | License blocker |
| **jsPlumb CE** | ✅ Native | SVG+DOM | ✅ Rich | ✅ Endpoints | ⚠️ Basic | ❌ None | ❌ None | ~56 KB | MIT/GPL-2 | 7.6K | CE too limited |
| **maxGraph** | ✅ Native | SVG | ✅ Rich | ✅ Native | ✅ Built-in | ✅ Built-in | ✅ Built-in | ~200 KB* | Apache 2.0 | 1K+ | Still 0.x, unstable |
| **xyflow (React Flow)** | ❌ **React only** | SVG+DOM | ✅ Rich | ✅ Native | ✅ Built-in | ✅ (Dagre) | ❌ None | ~150 KB | MIT | 36K+ | Framework blocker |

**Legend:** ✅ = Built-in | ⚠️ = Partial | ❌ = Not available | 🔨 = Must build yourself

### 1.2 Deep-Dive: Top 3 Candidates

#### 🥇 JointJS Core (Open Source)

**Why it's the top pick:**
- **SVG-based rendering** — every node is an SVG group, every connection is an SVG `<path>`. This means crisp rendering at any zoom level, native DOM events, CSS styling capability, and the ability to embed `<foreignObject>` for rich HTML content inside nodes.
- **Native port system** — define input/output ports per node with full control over position, markup, styling, and grouping. Ports are first-class citizens, not afterthoughts.
- **Connection routing** — built-in routers: Manhattan (orthogonal), Metro, Normal (straight), Smooth (Bézier). Custom router support. Arrowhead markers included.
- **Event system** — rich event API for node/link/port interactions: `cell:pointerdown`, `link:connect`, `element:pointermove`, etc.
- **JSON serialization** — `graph.toJSON()` / `graph.fromJSON()` for save/load.
- **Custom shapes** — define node templates with arbitrary SVG markup, including text, icons, badges, and rich layouts.
- **Paper (viewport)** — handles zoom, pan, grid, background. `paper.scale()`, `paper.translate()`.
- **No framework dependency** — pure ES6, works with a `<script>` tag.

**Gaps we need to fill:**
1. **Auto-layout** — integrate Dagre externally (well-documented pattern, JointJS docs even show how)
2. **Undo/redo** — build command pattern on top of JointJS events (listen to `add`, `remove`, `change`)
3. **Minimap** — build ourselves (render scaled-down clone of paper into a small container)

**Bundle:** ~180 KB gzipped (includes core + standard shapes). Acceptable for an inlined SPA.

**Risk:** JointJS has a commercial tier (JointJS+/Rappid). The open-source core is MPL-2.0 — we can use it freely, but we must not modify the library source without disclosing changes. Consuming it as a dependency is fine.

#### 🥈 D3.js + Custom SVG (Build from Scratch)

**Why it's compelling:**
- **Total control** — every pixel is ours. No library constraints, no style fights.
- **Battle-tested SVG primitives** — D3's `d3-drag`, `d3-zoom`, `d3-selection` are world-class.
- **Tiny footprint** — import only the D3 modules we need (~30 KB total for drag+zoom+selection).
- **No licensing concerns** — ISC license, 110K+ GitHub stars.

**What we'd need to build:**
1. Node rendering (SVG groups with foreignObject for HTML content)
2. Port system (SVG circles at node edges with hit areas)
3. Connection drawing (SVG `<path>` with cubic Bézier curves)
4. Drag-to-connect interaction (mousedown on port → track mouse → snap to target port)
5. Selection (click, shift+click, box-select)
6. Zoom/pan (`d3-zoom` handles this well)
7. Auto-layout (Dagre integration — same as JointJS approach)
8. Undo/redo (command pattern — same as JointJS approach)
9. Serialization (custom JSON format)

**Effort estimate:** 3–4× more than JointJS. A full node editor from scratch with D3 is a proven pattern (Mermaid, many custom tools), but it's significant engineering.

**Verdict:** Best for teams that want zero dependency risk and have the time. A viable fallback if JointJS's MPL-2.0 license is problematic.

#### 🥉 Drawflow (Lightweight Contender)

**Why it's tempting:**
- **9 KB gzipped** — impossibly small.
- **4 lines of code** to get a working editor.
- **Zero dependencies** — vanilla JS, MIT license.
- **Touch support** — works on mobile.
- **JSON import/export** — trivial save/load.

**Why it falls short for our use case:**
- **Port limitations** — inputs always on left, outputs always on right. No top/bottom ports. No custom port HTML or per-port styling. No port grouping. For a DAG where data flows top-to-bottom, this is a problem.
- **No auto-layout** — no integration point for layout algorithms.
- **No undo/redo** — not even events granular enough to build it easily.
- **Connection styling** — basic SVG curves only. No routing algorithms (Manhattan, smooth Bézier).
- **Customization ceiling** — custom HTML nodes are powerful for *content*, but the editor chrome (ports, connections, selection) is rigid.
- **Maintainer activity** — last major release was 2022. Community PRs are slow to merge.

**Verdict:** Perfect for a quick prototype or simple workflow editor. Not sufficient for "the best DAG builder anyone has ever used."

### 1.3 Libraries Eliminated

| Library | Reason for Elimination |
|---------|----------------------|
| **xyflow/React Flow** | Requires React. No official vanilla JS/Web Components version exists (despite earlier rumors of `@xyflow/xyflow-web`, this was never officially released or supported). |
| **GoJS** | Commercial license required for production. Perpetual license is expensive. Watermark without license. |
| **Konva.js / Fabric.js** | Canvas-based general 2D libraries — no built-in diagramming, ports, or connections. Would require building everything from scratch, same effort as D3 but with Canvas API's interactivity limitations. |
| **Litegraph.js** | Designed for visual programming with a dark, gaming-oriented aesthetic. Hardcoded visual style (dark background, neon wires) would clash with our clean white aesthetic. Deep style customization requires forking. |
| **maxGraph** | Still in 0.x (v0.21.0). API is unstable, documentation is sparse, community is small (~1K stars). The modernization of mxGraph is promising but not production-ready. |
| **jsPlumb CE** | Community Edition lacks auto-layout, minimap, and many features reserved for the commercial Toolkit. Connection-only library — doesn't manage nodes. |

---

## 2. Node Placement Models

### 2.1 Model A: Sidebar Palette Drag

**Pattern:** Icon-labeled node types in a vertical sidebar panel. User drags a node type from the sidebar onto the canvas. Node appears where dropped.

**Examples:** n8n, Node-RED, Unreal Blueprints, Unity Shader Graph, AWS Step Functions designer.

**Implementation:**
```
[Sidebar]          [Canvas]
┌──────────┐      ┌─────────────────────────┐
│ 📊 SQL   │ ───→ │                         │
│ 🔄 MLV   │ drag │    [dropped node]       │
│ 🐍 Spark │      │                         │
└──────────┘      └─────────────────────────┘
```

- Use HTML5 Drag and Drop API or pointer events.
- `dragstart` on sidebar item stores node type in `dataTransfer`.
- `drop` on canvas reads type + drop coordinates → creates node at position.

**Pros:**
- Discoverable — all node types visible at a glance
- Familiar — users expect this from flow editors
- Supports categorization with sections/accordion

**Cons:**
- Takes horizontal space (sidebar width)
- Less useful when only 3 node types (our case — feels heavy)
- Requires good drag ghost preview

**Complexity:** Low-Medium

### 2.2 Model B: Click-to-Place

**Pattern:** Click "+ Add Node" button → modal/dropdown appears → select node type → click on canvas to place.

**Implementation:** Two-step interaction. Button click enters "placement mode" with cursor change, then canvas click places the node.

**Pros:**
- Simple to implement
- No drag mechanics needed
- Clear separation of "choose" and "place"

**Cons:**
- Two-step process feels slow
- "Placement mode" is a hidden state that can confuse users
- No spatial preview until final click

**Complexity:** Low

### 2.3 Model C: Context Menu (Right-Click)

**Pattern:** Right-click on empty canvas space → context menu with node types → click type → node appears at click position.

**Examples:** Blender Shader Editor, Godot Visual Script, many CAD tools.

**Implementation:**
```
Right-click at (x, y) →
┌─────────────────┐
│ ▸ Plain SQL Table │
│ ▸ SQL MLV         │
│ ▸ PySpark MLV     │
├─────────────────┤
│ ▸ Auto-Arrange    │
│ ▸ Zoom to Fit     │
└─────────────────┘
```

**Pros:**
- Zero UI chrome — canvas stays uncluttered
- Node appears exactly where the user wants it
- Natural for power users
- Easy to extend with other canvas actions

**Cons:**
- Not discoverable for beginners (right-click is hidden)
- Touch devices don't have right-click (need long-press fallback)
- Context menus can feel dated if not styled well

**Complexity:** Low

### 2.4 Model D: Command Palette (Keyboard Shortcut)

**Pattern:** Press `/` or `Space` → search/filter popup appears at cursor → type to filter node types → Enter to place.

**Examples:** Notion's `/` commands, VS Code command palette, Figma quick actions.

**Implementation:**
```
Press "/" →
┌────────────────────────┐
│ 🔍 Search nodes...     │
│ ▸ Plain SQL Table      │
│ ▸ SQL MLV              │
│ ▸ PySpark MLV          │
└────────────────────────┘
```

**Pros:**
- Fastest for keyboard-heavy users
- Scales well if node types grow
- Feels modern and polished

**Cons:**
- Not discoverable without hints/tooltips
- Overkill for 3 node types
- Requires keyboard event management

**Complexity:** Medium

### 2.5 Model E: Quick-Add Toolbar

**Pattern:** Floating toolbar at bottom (or top) of canvas with labeled buttons for each node type. Click a button → node appears at canvas center (or near last interaction point).

**Examples:** Miro shapes toolbar, FigJam sticky notes, Lucidchart shape bar.

**Implementation:**
```
┌─────────────────────────────────────┐
│              Canvas                 │
│                                     │
│                                     │
│   ┌─────────────────────────────┐   │
│   │ [+ SQL] [+ MLV] [+ Spark]  │   │
│   └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

**Pros:**
- Highly discoverable — buttons are always visible
- Single-click to add
- Works great for small node type counts (our case: 3 types)
- Doesn't consume sidebar space
- Mobile-friendly

**Cons:**
- Node placement isn't spatial (appears at center, user must drag to position)
- Toolbar takes vertical space
- Can feel simplistic for power users

**Complexity:** Low

### 2.6 Model F: Hybrid Combination

**Recommended hybrid for our 3-node-type DAG builder:**

| Method | Purpose | Discoverability | Speed |
|--------|---------|----------------|-------|
| **Quick-Add Toolbar** (primary) | Bottom toolbar with 3 labeled buttons | ⭐⭐⭐ High | ⭐⭐ Medium |
| **Right-Click Context Menu** | Right-click on canvas → node type submenu | ⭐ Low | ⭐⭐⭐ High |
| **Keyboard Shortcut** | `Tab` or `/` → quick menu at cursor | ⭐ Low | ⭐⭐⭐ High |

**Rationale:**
- With only 3 node types, a full sidebar palette is overkill.
- The quick-add toolbar provides instant discoverability for first-time users.
- Right-click context menu gives power users spatial placement.
- Keyboard shortcut appeals to keyboard-centric developers.
- All three share the same underlying `createNode(type, position)` function.

---

## 3. Connection Drawing

### 3.1 Pattern Comparison

| Pattern | Visual Feedback | Validation | UX Quality | Implementation |
|---------|----------------|------------|------------|----------------|
| **Port-based drag** | Bézier ghost line from port to cursor; target port highlights on hover | Prevent self-loops, type checking, duplicate checking | ⭐⭐⭐ Best | Medium |
| **Edge-based click** | Click source → click target → edge appears | Same validation | ⭐⭐ Good | Low |
| **Free-draw** | Drag from anywhere on node → snap to nearest port | Auto-port selection | ⭐⭐ Good | High |
| **Auto-connect** | Drag node near another → suggest connection | Proximity detection | ⭐ Novelty | High |

### 3.2 Recommended Approach: Port-Based Drag

**Why:** It's the industry standard for node editors. Users intuitively understand "drag from output port to input port." It provides the richest feedback during the interaction.

**Visual Design:**
```
  ┌─────────────────────┐
  │   Plain SQL Table   │
  │   [sales_raw]       │
  │                     │
  │              (out) ●─────╮
  └─────────────────────┘    │  ← Bézier curve
                              │     follows mouse
  ┌─────────────────────┐    │
  │   SQL MLV           │    │
  │   [sales_agg]       │    │
  │                     │    ╰──→ highlights
  │  ● (in)             │         when near
  └─────────────────────┘
```

**Port placement for our DAG (top-to-bottom flow):**
- **Input ports:** Top edge of node (centered)
- **Output ports:** Bottom edge of node (centered)
- Port visual: 10px circle, `oklch(0.75 0 0)` (gray) idle, `oklch(0.65 0.20 250)` (blue) on hover/active

**Interaction sequence:**
1. `pointerdown` on output port → enter "connecting" mode
2. Render temporary SVG `<path>` (cubic Bézier) from port center to cursor
3. As cursor moves over valid input ports, highlight them (scale up, color change)
4. `pointerup` on valid input port → create connection, fire command for undo stack
5. `pointerup` elsewhere → cancel, remove temporary path
6. `Escape` key → cancel

**Validation rules:**
- No self-loops (source node ≠ target node)
- No duplicate connections (same source port → same target port)
- No cycles (maintain DAG invariant — run topological sort check before accepting)
- Direction enforcement: can only drag from output to input (not reverse)

**Bézier curve formula (vertical DAG):**
```javascript
const dx = 0;
const dy = (targetY - sourceY) * 0.5;
const path = `M ${sourceX},${sourceY}
              C ${sourceX},${sourceY + dy}
                ${targetX},${targetY - dy}
                ${targetX},${targetY}`;
```

**Connection appearance:**
- Stroke: `oklch(0.60 0.05 250)` (subtle blue-gray)
- Stroke-width: 2px
- Animated dash pattern during drag preview
- Arrowhead at target end (SVG `<marker>`)
- Hover state: stroke-width 3px, brighter color, show delete button at midpoint

---

## 4. Rendering Architecture

### 4.1 SVG vs Canvas vs DOM Analysis

| Approach | Node Rendering | Connection Rendering | Events | Zoom | CSS | Accessibility | 100-Node Perf |
|----------|---------------|---------------------|--------|------|-----|--------------|--------------|
| **Pure SVG** | SVG `<g>` groups | SVG `<path>` | ✅ Native DOM | ✅ `viewBox` | ✅ Full | ✅ ARIA on SVG | ✅ Excellent |
| **Canvas API** | Canvas draw calls | Canvas draw calls | ❌ Manual hit-test | ✅ Transform | ❌ None | ❌ None | ✅ Excellent |
| **DOM + SVG hybrid** | HTML `<div>` | SVG `<path>` overlay | ✅ Native | ⚠️ CSS transform both | ✅ Full | ✅ Full | ✅ Excellent |
| **DOM + Canvas hybrid** | HTML `<div>` | Canvas lines | Mixed | ⚠️ Sync issue | ✅ Nodes only | ⚠️ Nodes only | ✅ Excellent |

### 4.2 Recommended Approach: SVG with foreignObject

**JointJS uses pure SVG rendering.** Nodes are `<g>` groups containing SVG shapes (`<rect>`, `<text>`, `<circle>` for ports). Connections are `<path>` elements.

For rich HTML content inside nodes (dropdowns, badges, multi-line text), we use SVG `<foreignObject>`:

```xml
<g class="dag-node" transform="translate(100, 200)">
  <rect width="220" height="80" rx="8" fill="white" stroke="#e0e0e0"/>
  <foreignObject width="220" height="80">
    <div class="node-content">
      <span class="node-type-badge">SQL MLV</span>
      <span class="node-name">sales_aggregated</span>
    </div>
  </foreignObject>
  <circle class="port port-in" cx="110" cy="0" r="5"/>
  <circle class="port port-out" cx="110" cy="80" r="5"/>
</g>
```

**Why SVG over Canvas for our case:**
1. **100 nodes is trivially within SVG's comfort zone.** SVG handles up to ~500-1000 elements before performance degrades. We're well under.
2. **Native events.** Click, hover, drag — all work on SVG elements without manual hit-testing. Critical for port interactions.
3. **CSS styling.** OKLCH colors, transitions, hover states — all work natively on SVG elements.
4. **Zoom quality.** SVG scales infinitely without pixelation. Canvas requires re-rendering at different resolutions.
5. **Accessibility.** SVG elements can have ARIA attributes, roles, and keyboard focus.
6. **CSS animations.** Connection hover effects, port pulse animations, selection highlights — all CSS.
7. **JointJS native approach.** No fighting the library.

**Why NOT Canvas for our case:**
- Manual hit-testing for every port and node interaction
- No native DOM events per element
- No CSS styling — all visual state must be programmatic
- Re-rendering entire canvas on every state change (or complex dirty-rect tracking)
- Accessibility requires a shadow DOM or ARIA live regions

---

## 5. Auto-Layout

### 5.1 Algorithm Comparison

| Algorithm | Implementation | Bundle Size (gzip) | Quality | Speed (100 nodes) | Vanilla JS | Features |
|-----------|---------------|-------------------|---------|-------------------|-----------|----------|
| **Dagre** | `@dagrejs/dagre` | ~50 KB | ⭐⭐⭐ Good | <50ms | ✅ | Rank direction, node/edge spacing, edge label placement |
| **ELK (elkjs)** | `elkjs` | ~500 KB | ⭐⭐⭐⭐ Excellent | <100ms | ✅ | Many algorithms (layered, force, stress), extensive options |
| **Sugiyama (custom)** | Hand-written | 0 KB | ⭐⭐ Basic | ~20ms | ✅ | Just rank assignment + simple positioning |
| **Custom topo sort + grid** | Hand-written | 0 KB | ⭐ Minimal | <10ms | ✅ | Topological ordering, uniform grid placement |

### 5.2 Recommended Approach: Dagre

**Why Dagre:**
- **Purpose-built for DAGs.** The Sugiyama/dot algorithm produces clean, readable layered layouts — exactly what we need.
- **50 KB gzipped.** Acceptable for our single-HTML-file architecture. ELK at 500 KB is too heavy.
- **Well-proven.** Used by React Flow, Mermaid, and dozens of graph visualization tools.
- **Simple API:**

```javascript
import dagre from '@dagrejs/dagre';

function autoLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',      // Top-to-bottom (matches our DAG flow)
    nodesep: 60,         // Horizontal spacing between nodes
    ranksep: 80,         // Vertical spacing between ranks
    marginx: 20,
    marginy: 20
  });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach(n => g.setNode(n.id, { width: n.width, height: n.height }));
  edges.forEach(e => g.setEdge(e.source, e.target));

  dagre.layout(g);

  // Read computed positions
  return nodes.map(n => {
    const pos = g.node(n.id);
    return { ...n, x: pos.x - n.width / 2, y: pos.y - n.height / 2 };
  });
}
```

**Animation during layout:**
- Compute new positions via Dagre
- Animate each node from current position to target position using CSS transitions or `requestAnimationFrame`
- JointJS supports `element.transition('position', ...)` for smooth animated moves
- Duration: 300ms, easing: `cubic-bezier(0.4, 0, 0.2, 1)` (Material Design standard)

**When to trigger auto-layout:**
- "Auto-arrange" button in toolbar (explicit)
- Optionally: after adding first 3+ nodes (gentle suggestion, not forced)
- Never: automatically on every change (disruptive to manual positioning)

---

## 6. Undo/Redo Architecture

### 6.1 Approach Comparison

| Approach | Memory | Complexity | Granularity | Performance |
|----------|--------|-----------|-------------|-------------|
| **Command pattern** | Low (delta only) | Medium | Per-action | ⭐⭐⭐ Best |
| **Snapshot pattern** | High (full state) | Low | Per-action | ⭐ Worst at scale |
| **Hybrid** | Medium | Medium-High | Mixed | ⭐⭐ Good |

### 6.2 Recommended Approach: Command Pattern

For our scope (node CRUD + connection CRUD + property changes), the command pattern is ideal:

```javascript
class UndoManager {
  #undoStack = [];
  #redoStack = [];
  #maxDepth = 50;

  execute(command) {
    command.execute();
    this.#undoStack.push(command);
    this.#redoStack = [];           // Clear redo on new action
    if (this.#undoStack.length > this.#maxDepth) {
      this.#undoStack.shift();       // Evict oldest
    }
  }

  undo() {
    const cmd = this.#undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.#redoStack.push(cmd);
  }

  redo() {
    const cmd = this.#redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.#undoStack.push(cmd);
  }

  get canUndo() { return this.#undoStack.length > 0; }
  get canRedo() { return this.#redoStack.length > 0; }
}
```

**Command types needed:**

| Command | Execute | Undo |
|---------|---------|------|
| `AddNodeCommand` | Add node to graph | Remove node from graph |
| `RemoveNodeCommand` | Remove node + its connections | Re-add node + connections |
| `MoveNodeCommand` | Set node position to new coords | Set node position to old coords |
| `AddConnectionCommand` | Add edge to graph | Remove edge from graph |
| `RemoveConnectionCommand` | Remove edge | Re-add edge |
| `EditNodePropertyCommand` | Set property to new value | Set property to old value |
| `BatchCommand` | Execute all sub-commands | Undo all sub-commands in reverse |
| `AutoLayoutCommand` | Apply dagre layout (store old positions) | Restore old positions |

**Keyboard bindings:**
- `Ctrl+Z` / `Cmd+Z` → Undo
- `Ctrl+Shift+Z` / `Cmd+Shift+Z` → Redo
- `Ctrl+Y` / `Cmd+Y` → Redo (alternate)

**Why not snapshot pattern?**
At 100 nodes with properties, a full JSON snapshot is ~10–50 KB. With 50 undo levels, that's 0.5–2.5 MB in memory — manageable, but wasteful. The command pattern stores only deltas, typically <1 KB per action. It's also more architecturally clean and easier to extend.

---

## 7. Zoom & Pan

### 7.1 Implementation Strategy

JointJS provides built-in zoom/pan via the Paper class, but we need to configure and enhance it:

**Zoom (scroll wheel):**
```javascript
paper.on('blank:mousewheel', (evt, x, y, delta) => {
  evt.preventDefault();
  const oldScale = paper.scale().sx;
  const newScale = Math.max(0.25, Math.min(2.0, oldScale + delta * 0.1));
  paper.scale(newScale, newScale);
  // Zoom toward cursor position
  paper.translate(
    x - (x - paper.translate().tx) * (newScale / oldScale),
    y - (y - paper.translate().ty) * (newScale / oldScale)
  );
});
```

**Pan (click-drag on empty space):**
```javascript
let isPanning = false;
let panStart = { x: 0, y: 0 };

paper.on('blank:pointerdown', (evt, x, y) => {
  isPanning = true;
  panStart = { x: evt.clientX, y: evt.clientY };
  paper.el.style.cursor = 'grabbing';
});

document.addEventListener('pointermove', (evt) => {
  if (!isPanning) return;
  const dx = evt.clientX - panStart.x;
  const dy = evt.clientY - panStart.y;
  paper.translate(
    paper.translate().tx + dx,
    paper.translate().ty + dy
  );
  panStart = { x: evt.clientX, y: evt.clientY };
});

document.addEventListener('pointerup', () => {
  isPanning = false;
  paper.el.style.cursor = 'default';
});
```

**Zoom controls:**
- Zoom slider or +/− buttons in toolbar
- "Fit to view" button → calculate bounding box of all nodes, set scale and translate to fit
- Zoom percentage indicator (e.g., "75%")

**Zoom limits:**
- Minimum: 25% (0.25x) — see full graph overview
- Maximum: 200% (2.0x) — detail editing
- Default: 100% (1.0x)

**Touch/trackpad:**
- Pinch-to-zoom via `gesturechange` event or pointer event distance tracking
- Two-finger pan via pointer events
- JointJS handles most of this if configured properly

**Minimap:**
Build a minimap by rendering a scaled-down clone:
- Small container (150×100px) in corner of canvas
- Render all nodes as tiny rectangles (proportional position)
- Show viewport rectangle (what's currently visible)
- Click on minimap to navigate
- Implementation: canvas element with simplified draw of node bounding boxes

---

## 8. Performance Strategy

### 8.1 Performance Budget

At 100 nodes with connections, we're well within comfortable territory for SVG/DOM rendering. But we should design for smooth interactions:

| Metric | Target | Approach |
|--------|--------|----------|
| Initial render (100 nodes) | <100ms | Batch DOM creation, single SVG tree |
| Node drag (60fps) | <16ms/frame | Only update dragged node + connected edges |
| Zoom/pan (60fps) | <16ms/frame | CSS transform on container, not individual elements |
| Auto-layout animation | 300ms total | `requestAnimationFrame` with easing |
| Connection preview | <8ms/frame | Single SVG path update, no layout recalc |
| Undo/redo | <50ms | Direct DOM manipulation, no full re-render |

### 8.2 Optimization Techniques

**1. Efficient zoom/pan:**
- Apply `transform: scale() translate()` to the SVG container element, NOT to each child.
- This means the browser's compositor handles zoom — GPU-accelerated, 60fps.

**2. Lazy connection path updates:**
- During node drag, only recalculate paths for edges connected to the dragged node.
- Use `requestAnimationFrame` to batch path recalculations.

**3. Virtual rendering (not needed at 100 nodes, but design for it):**
- If we ever scale beyond 500 nodes, implement viewport culling:
  - Calculate which nodes are in the visible viewport
  - Hide/detach SVG groups outside viewport
  - Re-attach when they scroll into view
- JointJS doesn't do this natively, but it's achievable with `paper.on('render:done')` + bounding box checks.

**4. Connection path caching:**
- Store computed Bézier control points.
- Only recompute when source or target node moves.
- JointJS does this internally via its connector/router caching.

**5. Debounced operations:**
- Auto-layout recalculation: debounce 300ms after last change
- JSON serialization (for code preview): debounce 200ms
- Minimap update: debounce 100ms or use `requestAnimationFrame`

**6. GPU-accelerated transforms:**
- Use `will-change: transform` on the paper SVG element
- Use CSS `transform` for zoom/pan (compositor layer, not layout)
- Avoid properties that trigger layout: `width`, `height`, `top`, `left`

### 8.3 Benchmark Reference

Based on real-world testing with SVG-based graph editors:
- **100 SVG nodes** with event handlers: renders in <50ms on modern hardware
- **200 SVG connections** as `<path>`: renders in <30ms
- **Drag interaction** (node + 5 connected edges): maintains 60fps easily
- **Zoom/pan** via SVG viewBox or CSS transform: always 60fps

**Bottom line:** 100 nodes is a trivially small graph for SVG. Performance is not a risk here. Design clean code first; optimize only if profiling reveals issues.

---

## 9. Final Technical Recommendation

### 9.1 Recommended Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Graph Library** | JointJS Core (`@joint/core`, MPL-2.0) | Best vanilla JS graph editor with native ports, connections, and SVG rendering |
| **Rendering** | SVG (JointJS Paper) with `foreignObject` for rich node content | Crisp at any zoom, native events, CSS styling, accessible |
| **Node Placement** | Hybrid: Quick-add toolbar + right-click context menu + `/` keyboard shortcut | Discoverable for beginners, fast for power users |
| **Connection Drawing** | Port-based drag with Bézier preview (JointJS native) | Industry standard, rich visual feedback |
| **Auto-Layout** | Dagre (`@dagrejs/dagre`) | Purpose-built for DAGs, lightweight (50 KB), proven |
| **Undo/Redo** | Custom command pattern (built on JointJS events) | Low memory, granular, extensible |
| **Zoom/Pan** | JointJS Paper with custom scroll-zoom + drag-pan | Built-in support, just needs configuration |
| **Serialization** | `graph.toJSON()` → custom transform → code generation | JointJS native, round-trips cleanly |

### 9.2 Implementation Complexity Estimate

| Sub-system | Complexity | Effort (dev-days) | Notes |
|------------|-----------|-------------------|-------|
| JointJS setup + Paper config | Low | 1 | Boilerplate, well-documented |
| Custom node shapes (3 types) | Medium | 2 | SVG markup + foreignObject + ports |
| Node placement (toolbar + context menu) | Low | 1 | HTML buttons + custom context menu |
| Connection drawing + validation | Medium | 2 | Port config + cycle detection |
| Auto-layout (Dagre integration) | Low | 1 | Well-documented pattern |
| Undo/redo system | Medium | 2 | Command classes + JointJS event wiring |
| Zoom/pan + minimap | Medium | 2 | Zoom config + custom minimap widget |
| Node editing popover | Medium | 2 | Popover positioning + form fields |
| Code preview sync | Medium | 2 | Graph → SQL/PySpark code generation |
| Polish + animations | Medium | 2 | Transitions, hover states, keyboard nav |
| **Total** | | **~17 dev-days** | For a production-quality DAG canvas |

### 9.3 Risk Areas

| Risk | Severity | Mitigation |
|------|----------|------------|
| **JointJS MPL-2.0 license** | Low | We consume it as a dependency, not modify source. MPL-2.0 copyleft only applies to modified files of the library itself. Confirm with legal. |
| **JointJS bundle size in single HTML** | Medium | ~180 KB gzipped is significant for our inline architecture. Consider lazy-loading the wizard modal (only load JointJS when wizard opens). |
| **foreignObject browser support** | Low | Fully supported in all modern browsers. Our target is Edge/Chrome/Firefox — all fine. |
| **JointJS API stability** | Low | JointJS v4.x is stable. Major versions are infrequent. Pin version in package.json. |
| **Custom minimap** | Low | No library support; must build ourselves. But it's a small canvas rendering exercise (~50 lines). |
| **Undo/redo edge cases** | Medium | Batch operations (auto-layout, multi-select delete) need `BatchCommand` grouping. Test thoroughly. |
| **Cycle detection performance** | Low | Topological sort is O(V+E). At 100 nodes, this is instant (<1ms). |
| **DAG constraint enforcement** | Medium | Must prevent cycles during connection creation AND during undo/redo. Test edge cases: undo a delete that breaks a cycle, then redo. |

### 9.4 Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Wizard Modal                          │
│  ┌──────────┬────────────────────────┬───────────────┐   │
│  │ Toolbar  │     Canvas (JointJS    │  Code Preview │   │
│  │          │        Paper)          │    Panel      │   │
│  │ [+SQL]   │  ┌─────────┐          │               │   │
│  │ [+MLV]   │  │  Node A │──→       │  CREATE TABLE │   │
│  │ [+Spark] │  └─────────┘  │       │  ...          │   │
│  │          │        ┌──────▼──┐    │               │   │
│  │ [Arrange]│        │ Node B  │    │  CREATE MLV   │   │
│  │ [Fit]    │        └─────────┘    │  ...          │   │
│  │ [Undo]   │                       │               │   │
│  │ [Redo]   │  ┌──────┐ Minimap     │  [Collapse ▸] │   │
│  │          │  │ ·· · │             │               │   │
│  └──────────┴──┴──────┴─────────────┴───────────────┘   │
│  [Cancel]                        [Next: Review & Save]   │
└──────────────────────────────────────────────────────────┘
```

### 9.5 Dependency Summary

```
@joint/core          → Graph model, SVG rendering, Paper, shapes, ports, links
@dagrejs/dagre       → Auto-layout computation (Sugiyama/dot algorithm)
(no other deps)
```

Total added weight: ~230 KB gzipped. Both are vanilla JS, no transitive framework dependencies.

---

## Appendix A: JointJS Core Quick Reference

### Creating a custom node shape
```javascript
const DagNode = joint.dia.Element.define('dag.Node', {
  size: { width: 220, height: 80 },
  attrs: {
    body: {
      refWidth: '100%', refHeight: '100%',
      fill: 'white', stroke: '#e0e0e0', strokeWidth: 1, rx: 8, ry: 8
    },
    label: {
      textVerticalAnchor: 'middle', textAnchor: 'middle',
      refX: '50%', refY: '40%', fontSize: 14, fill: '#1a1a1a'
    },
    typeBadge: {
      textVerticalAnchor: 'middle', textAnchor: 'start',
      refX: 12, refY: 16, fontSize: 10, fill: '#666'
    }
  },
  ports: {
    groups: {
      in:  { position: 'top',    attrs: { circle: { r: 5, fill: '#ccc', stroke: '#999' } } },
      out: { position: 'bottom', attrs: { circle: { r: 5, fill: '#ccc', stroke: '#999' } } }
    },
    items: [
      { group: 'in',  id: 'in1' },
      { group: 'out', id: 'out1' }
    ]
  }
}, {
  markup: [
    { tagName: 'rect', selector: 'body' },
    { tagName: 'text', selector: 'typeBadge' },
    { tagName: 'text', selector: 'label' }
  ]
});
```

### Creating a connection
```javascript
const link = new joint.shapes.standard.Link({
  source: { id: nodeA.id, port: 'out1' },
  target: { id: nodeB.id, port: 'in1' },
  router: { name: 'manhattan' },
  connector: { name: 'rounded' },
  attrs: {
    line: {
      stroke: 'oklch(0.60 0.05 250)',
      strokeWidth: 2,
      targetMarker: { type: 'path', d: 'M 10 -5 0 0 10 5 z' }
    }
  }
});
graph.addCell(link);
```

---

## Appendix B: Cycle Detection for DAG Constraint

```javascript
function wouldCreateCycle(graph, sourceId, targetId) {
  // DFS from targetId — if we can reach sourceId, adding this edge creates a cycle
  const visited = new Set();
  const stack = [targetId];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (nodeId === sourceId) return true;   // Cycle detected!
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    // Get all successors (nodes this node points to)
    const successors = graph.getSuccessors(graph.getCell(nodeId));
    successors.forEach(s => stack.push(s.id));
  }
  return false;
}

// Usage: before accepting a connection
paper.on('link:connect', (linkView, evt, elementViewConnected) => {
  const sourceId = linkView.model.source().id;
  const targetId = linkView.model.target().id;
  if (wouldCreateCycle(graph, sourceId, targetId)) {
    linkView.model.remove();   // Reject the connection
    showToast('Cannot create cycle in DAG');
  }
});
```

---

*End of research document. Ready for implementation planning.*
