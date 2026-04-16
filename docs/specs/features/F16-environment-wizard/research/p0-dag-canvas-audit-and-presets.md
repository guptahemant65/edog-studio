# P0 Research: DAG Canvas Mock Audit & Structure Presets

> **Feature:** F16 — New Infra Wizard, Page 3 — DAG Canvas
> **Author:** DAG Editor UX Researcher & Auditor
> **Date:** 2025-07-21
> **Status:** COMPLETE
> **Mock under audit:** `mocks/dag-canvas.html`
> **Specs referenced:** C04, C05, C06, C07, C08, `states/canvas-system.md`
> **Purpose:** Feed the surgical fix agent with precise, actionable findings

---

## Table of Contents

1. [Part 1: Mock Audit](#part-1-mock-audit)
   - [P0 — Broken/Missing Core Functionality](#p0--brokenmissing-core-functionality)
   - [P1 — Missing Interactions](#p1--missing-interactions)
   - [P2 — Polish Gaps](#p2--polish-gaps)
   - [P3 — Nice-to-Haves](#p3--nice-to-haves)
2. [Part 2: Presets Research](#part-2-presets-research)
   - [A. Common Data Pipeline Topologies](#a-common-data-pipeline-topologies)
   - [B. Industry DAG Scaffolding Analysis](#b-industry-dag-scaffolding-analysis)
   - [C. UX Patterns for Structure Selection](#c-ux-patterns-for-structure-selection)
   - [D. Smart Defaults](#d-smart-defaults)
   - [E. Recommended Structure Types](#e-recommended-structure-types)
   - [F. UX Integration Recommendation](#f-ux-integration-recommendation)
3. [Part 3: Surgical Fix Plan](#part-3-surgical-fix-plan)

---

# Part 1: Mock Audit

## P0 — Broken/Missing Core Functionality

### P0-1: Connections are nearly invisible — opacity 0.45 is far too subtle

**What's wrong:** The `.cp` class (line 132) sets `opacity: 0.45` on connection paths. Combined with `stroke: var(--text-muted)` (a gray), connections between nodes are essentially invisible on the light grid background. The CEO feedback explicitly called this out — "edges/connections between nodes not visible or not obvious." This is the single biggest problem. Users see disconnected nodes floating on a canvas with no apparent relationship.

**What it should do:** Per C07 spec §6 (Visual Spec), permanent connections should have:
- Default state: `stroke-width: 2`, `opacity: 1.0` (not 0.45)
- Color: schema-based coloring (bronze → bronze color, etc.) — the code does this (`stroke: sc` on line 665) but opacity kills it
- Flow animation dashes should be visible but secondary — the `cf` class (line 135) at `opacity: 0.25` is completely invisible

**Surgical fix:**
- Line 132: Change `.cp` opacity from `0.45` to `0.7` (default), hover to `1.0`
- Line 135: Change `.cf` opacity from `0.25` to `0.4`
- Line 132: Increase `stroke-width` from `2` to `2.5` for default state
- Add `stroke-linecap: round` and `stroke-linejoin: round` for polish
- The arrowhead marker (line 347, `fill="rgba(142,149,165,0.45)"`) is also nearly invisible — change to match the connection stroke color with `0.8` opacity

### P0-2: Arrowhead markers use hardcoded gray instead of connection color

**What's wrong:** Lines 347-348 define two static `<marker>` elements with hardcoded fill colors (`rgba(142,149,165,0.45)` and `rgba(109,92,255,0.7)`). Every connection uses `marker-end="url(#ah)"` (line 666) which is always the gray one. This means regardless of connection color (bronze, silver, gold), the arrowhead is always a faded gray.

**What it should do:** Per C07 spec, arrowheads should match the connection stroke color. Since SVG markers inherit from the element they're applied to when using `fill="context-stroke"` (not universally supported), the practical solution is to generate markers per color or use CSS.

**Surgical fix:**
- Create one marker per schema color (bronze, silver, gold, dbo), or
- Use a single marker with `fill: currentColor` and set `color` on the path element, or
- Simply increase the default marker opacity to `0.8` for visibility, and create a per-schema marker set:
  ```
  marker-bronze: fill #b87333
  marker-silver: fill #7b8794
  marker-gold: fill #c5a038
  ```
- In `renderConns()` (line 666): set marker-end based on source node's schema

### P0-3: Table → Table connection is not blocked during interactive drag

**What's wrong:** CEO feedback: "Table→Table connection should be invalid." The code at line 806 correctly blocks SQL Tables from being *targets* (`if (nodeById(tgtId).type === 'sql-table')`), and line 714 prevents dragging from the *top* port of a table. However, there's a gap:

1. **Table → Table via bottom-to-top is correctly blocked** (table has no input port, line 714 blocks top port drag, line 806 blocks target if table). ✅ This actually works.
2. **BUT: there's no visual feedback during the drag.** When a user drags from a table's output port toward another table's top port, the port still appears (line 720: `el.classList.add('sel')` makes ALL ports visible on ALL nodes, including the fake top port of tables). The user sees a port, tries to connect, and only gets an error toast AFTER releasing. This is terrible UX.

**What it should do:** Per C07 spec §4.1 (state machine), during DRAGGING state, invalid target ports should be dimmed (opacity 0.3). SQL Table nodes should not show their input port at all during a connection drag, because they don't have one. The current code (line 720-721) makes ALL nodes show selected state (which shows all ports) — it doesn't distinguish between valid and invalid targets.

**Surgical fix:**
- In `onPortMouseDown` (line 713), when starting a connection drag:
  - Do NOT just add `sel` class to all nodes
  - Instead, iterate nodes and only show the relevant port:
    - If dragging from output: show input ports (top) on valid targets only
    - SQL Tables should NOT show a top port at all (they have `canHaveParents: false`)
  - Add `it` (invalid target) class to ports on table nodes during drag
- In the move handler (line 743-765), the port validation logic already checks `valid = isOutput ? tPort === 'top' : tPort === 'bottom'`, but it doesn't check the TARGET NODE TYPE. Add: if target node is `sql-table` and target port is `top`, mark as invalid regardless.

### P0-4: Connection paths use wrong SVG structure — `<svg>` has `width:0; height:0`

**What's wrong:** Line 131: `.csv { position:absolute; top:0; left:0; width:0; height:0; overflow:visible }`. The connection SVG element has zero dimensions and relies on `overflow: visible` to render. While this "works" visually, it breaks:
1. **Hit testing** — `pointer-events: stroke` on paths inside a zero-sized SVG may not register click events in all browsers (particularly Safari)
2. **getBBox()** / **getBoundingClientRect()** calls on the SVG element return `{0,0,0,0}`, making programmatic path inspection impossible
3. **Screen readers** cannot determine the spatial extent of the connection layer

**What it should do:** Per C04 spec §1.3, the connection SVG should be a full-size overlay within the `world` coordinate system, or use `viewBox` to match the canvas coordinate system.

**Surgical fix:**
- Change `.csv` dimensions to `width: 100%; height: 100%` — BUT since it's position:absolute inside `world` (which has no explicit size), we need:
  - Either give `.csv` explicit large dimensions (`width: 10000px; height: 10000px` with `overflow: visible`), or
  - Dynamically resize `.csv` to match the bounding box of all nodes plus padding
  - Simplest: set a large fixed size and let overflow handle the rest:
    ```css
    .csv { position:absolute; top:0; left:0; width:10000px; height:10000px; overflow:visible; pointer-events:none; z-index:0 }
    ```
  - This ensures hit testing works on path elements

### P0-5: Connection creation has no type-aware validation for Table→Table during drag preview

**What's wrong:** The `wouldCycle()` function (line 698) correctly detects graph cycles, and line 806 blocks Table targets on mouseup. But there's NO validation that prevents showing a valid-looking preview when dragging between two tables. The drag preview (line 722-765) doesn't check node types at all — it only checks port positions and cycles.

**What it should do:** Per C06 spec §2.3 (Port Configuration):
- Plain SQL Table: Output ONLY (no input port)
- SQL MLV / PySpark MLV: Input + Output

During drag, port validation (line 749-751) only checks positional validity (`isOutput ? tPort === 'top' : tPort === 'bottom'`), not type validity. The fix needs to add type checking.

**Surgical fix:**
- In the `onMove` handler inside `onPortMouseDown` (around line 743):
  - After `const tId = tEl.dataset.id;` (line 746)
  - Add: `const tNode = nodeById(tId);`
  - Add: `if (isOutput && tNode.type === 'sql-table') { pel.classList.add('it'); return; }` — this marks the input port of tables as invalid during output→input drags
  - This gives immediate red feedback instead of letting the user complete the drag

---

## P1 — Missing Interactions

### P1-1: No port hover feedback when NOT in connection-drag mode

**What's wrong:** Ports (`.pt`, line 122) are hidden by default (`opacity: 0; transform: scale(0.5)`) and only appear on node hover (`.nd:hover .pt`, line 123). But when they DO appear on hover, there's no additional hover feedback on the port itself — the `:hover` style (line 126) provides visual feedback, but there's no cursor change or tooltip indicating "drag to connect." A user hovering a node might not realize the small circles are interactive drag handles.

**What it should do:** Per C06 spec §1.2 and C07 spec §4.1, ports should:
- Show a tooltip on hover ("Drag to connect" or "Output" / "Input")
- Pulse gently to indicate interactivity when hovered
- Change cursor to crosshair (already done via CSS, line 122)

**Surgical fix:**
- Add `title="Drag to connect"` to port elements in `createNodeEl()` (line 593-594)
- Consider adding a subtle pulse animation on port hover (can reuse the `ppg` keyframe)

### P1-2: No connection-created animation (snap/draw effect)

**What's wrong:** When a connection is successfully created (line 808-811), the connection just appears in the next `renderConns()` call with no visual celebration. In contrast, node creation has a spring animation (`nsi`, line 547).

**What it should do:** Per C07 spec §5.1 step 6, on connection creation:
- The permanent path should animate in — drawing from source to target (stroke-dashoffset animation)
- A brief flash/glow on the path
- The `cd` (connection draw) keyframe already exists (line 269) but is never used

**Surgical fix:**
- In `renderConns()`, detect newly-created connections (compare to previous render)
- Apply `animation: cd 400ms var(--ease)` + `stroke-dasharray` + `stroke-dashoffset` on new paths
- OR: in `addConnRaw()`, after appending the path, add a one-time animation class
- Simplest approach: after creating a connection in `onPortMouseDown.onUp()`, set a flag `S.lastCreatedConn = conn.id`, then in `renderConns()` check if each conn.id matches and apply the draw animation

### P1-3: No connection hover tooltip showing source→target names

**What's wrong:** Connection paths have hover styles (line 133: `stroke-width: 3.5; opacity: 0.8`) and click/dblclick handlers, but no tooltip or popover showing which nodes the connection links. A user hovering a curved line has no way to understand the relationship without tracing it visually.

**What it should do:** Per C07 spec §3.9, `connection:hover-start` should provide feedback. At minimum, a title attribute or tooltip showing `"orders → order_summary"`.

**Surgical fix:**
- In `renderConns()` (around line 663-671), add a `<title>` child element to each `<path>`:
  ```javascript
  const title = document.createElementNS(svgNS, 'title');
  title.textContent = `${src.name} → ${tgt.name}`;
  p.appendChild(title);
  ```
- This is native SVG tooltip — zero cost, immediate value

### P1-4: Marquee selection requires Shift+drag, not plain drag on empty canvas

**What's wrong:** Line 1043-1046: marquee selection only activates with `e.shiftKey`. Plain click-drag on empty canvas pans instead. Per C04 spec (canvas-system.md §1.1), the intended behavior is:
- Left-click drag on empty canvas → marquee select (selection rectangle)
- Middle-mouse drag OR Space+left-drag → pan

The mock inverts this — left-drag = pan, Shift+left-drag = marquee. This contradicts every major DAG tool (Figma, n8n, React Flow all use left-drag for marquee, middle/space for pan).

**What it should do:** Per canvas-system.md §canvas.interaction.idle:
- `pointerdown(button=0)` on empty → `select-pending` → marquee-selecting
- `pointerdown(button=1)` on empty → `panning`
- `pointerdown(button=0, spaceHeld=true)` → `panning`

**Surgical fix (IMPORTANT: medium risk — changes core interaction):**
- In viewport mousedown handler (line 1039-1056):
  - `button === 0, no Space held` → start marquee (currently requires Shift)
  - `button === 1` OR `button === 0 AND spaceHeld` → pan
- Track `spaceHeld` state via keydown/keyup on Space
- This is a significant UX change — may want to defer to CEO confirmation

### P1-5: No "Delete" key handling for selected connections

**What's wrong:** The Delete key handler (line 1517) calls `deleteSelected()`, which checks `S.selConn` first (line 1024). This works for connection deletion. BUT: there's no way to select a connection via keyboard (Tab navigation). The only selection path is mouse click on the path, which is hard due to the thin stroke and low opacity (P0-1 compounds this).

**What it should do:** Per C07 spec §7 (Keyboard & Accessibility), connections should be selectable via keyboard Tab navigation and have ARIA roles.

**Surgical fix:**
- Connection paths already have `pointer-events: stroke` and click handlers
- The primary fix is P0-1 (make them visible) — once visible, clicking to select works
- Keyboard accessibility is P3 scope (add `tabindex`, `role="link"`, aria-labels)

### P1-6: No double-click-to-add from palette items

**What's wrong:** Actually, double-click IS implemented (line 1172-1176). Listing this as VERIFIED OK.

### P1-7: Right-click context menu on a connection is missing

**What's wrong:** Connections have click (select) and dblclick (delete) handlers, but no contextmenu handler. Right-clicking a connection does nothing (or opens the canvas context menu behind it).

**What it should do:** Per C07 spec, connection right-click should show a context menu with:
- "Delete Connection" with shortcut hint
- "Select Source Node" / "Select Target Node" for navigation

**Surgical fix:**
- In `renderConns()`, add a contextmenu handler on each path:
  ```javascript
  p.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    selectConn(c.id);
    ctxHandler = action => {
      if (action === 'delete') deleteConn(c.id);
      if (action === 'select-src') { S.sel.clear(); S.sel.add(c.src); renderAllNodes(); }
      if (action === 'select-tgt') { S.sel.clear(); S.sel.add(c.tgt); renderAllNodes(); }
    };
    showCtx(e.clientX, e.clientY, [
      { label: 'Delete Connection', action: 'delete', cls: 'dng', shortcut: 'Del' },
      '---',
      { label: 'Select Source: ' + src.name, action: 'select-src' },
      { label: 'Select Target: ' + tgt.name, action: 'select-tgt' },
    ]);
  });
  ```

### P1-8: Code preview panel auto-refreshes on timer, spec says on-demand only

**What's wrong:** `scheduleCodeRefresh()` (line 1465) is called after nearly every state change — node add, delete, move, rename, type change, schema change, connection add/remove. It uses a 300ms debounce (`CFG.DEBOUNCE_CODE`). Per C08 spec §1.4 principle 1: "Code regenerates ONLY when the user clicks Refresh. This is a deliberate design choice."

**What it should do:** The spec explicitly says on-demand refresh via Refresh button only. However, the mock's approach (auto-refresh with debounce) may be the better UX — this needs CEO input. For now, flag as spec deviation.

**Surgical fix:** Two options:
1. **Match spec:** Remove all `scheduleCodeRefresh()` calls, add a "stale" indicator when DAG changes, refresh only on button click
2. **Keep auto-refresh (preferred for mock):** Document as intentional spec deviation. The debounced auto-refresh provides better live feedback.

Recommendation: Keep auto-refresh for the mock. Note the deviation.

---

## P2 — Polish Gaps

### P2-1: Connection flow animation dashes are invisible

**What's wrong:** The `.cf` class (line 135) has `opacity: 0.25` — nearly invisible. The `fd` animation (line 259, `stroke-dashoffset` animation) works but nobody can see it.

**Surgical fix:** Increase `.cf` opacity to `0.35`–`0.45`. Consider making flow animation only visible on hover or for selected connections, not all connections at once (visual noise).

### P2-2: Selected connection uses accent color but no glow

**What's wrong:** `.cp.sel` (line 134) gets `stroke: var(--accent); stroke-width: 2.5; opacity: 0.85`. This is decent but lacks the glow ring that selected nodes have (`box-shadow: 0 0 0 3px var(--accent-glow)`). SVG doesn't have box-shadow, but can use filters.

**Surgical fix:** Add an SVG filter for glow, or use `filter: drop-shadow(0 0 4px var(--accent))` on `.cp.sel`. CSS `filter` works on SVG elements in all modern browsers.

### P2-3: Node popover editor is missing (only inline rename via dblclick)

**What's wrong:** The mock has double-click → inline rename (line 879-910) and right-click context menu for type/schema change. But there's no popover editor panel as described in C06 spec §1.2 ("Popover editor opens on click; contains name field, type dropdown, schema dropdown, delete button"). The context menu is the only way to change type/schema.

**Surgical fix:** This is a bigger feature — a floating popover that appears on node click with form fields for name, type dropdown, schema dropdown, and delete button. For mock purposes, the context menu approach works. Flag for future enhancement.

### P2-4: No node validation state indicator

**What's wrong:** Per C06 spec §2.1, MLV nodes without parent connections should show as "incomplete" (they need at least one source). The mock has no visual indicator for this — an orphan MLV looks identical to a connected one.

**Surgical fix:**
- Add a small warning icon or dimmed state for MLV nodes with no incoming connections
- In `renderNode()`, check if node type is MLV and `S.conns.filter(c => c.tgt === n.id).length === 0`
- If orphan MLV: add a subtle visual — perhaps a dashed border instead of solid, or a small `⚠` indicator

### P2-5: Code preview doesn't highlight the node's cell when node is selected

**What's wrong:** When a node is selected on the canvas, the code preview panel doesn't scroll to or highlight the corresponding cell. This is a missed opportunity for spatial-code linkage.

**Surgical fix:**
- When `S.sel` changes, find the code cell for the selected node and add a highlight class
- Add a `.cc.highlighted { border-left: 2px solid var(--accent); background: var(--accent-dim); }` class
- In `renderAllNodes()` or selection handlers, update code panel highlighting

### P2-6: Minimap doesn't show connections

**What's wrong:** The minimap (line 1290-1342) renders connections as simple straight lines (`ctx.moveTo → ctx.lineTo`). While connections on the canvas are Bézier curves, straight lines in the minimap are acceptable at that scale. However, connection lines use `rgba(0,0,0,0.1)` (line 1307) — nearly invisible.

**Surgical fix:** Increase minimap connection line opacity to `rgba(0,0,0,0.25)` and stroke width to `1.5`.

### P2-7: No animated transition when panning to fit view

**What's wrong:** `fitView()` (line 1145) instantly snaps zoom and pan. No smooth transition.

**Surgical fix:** Animate the pan/zoom change over ~300ms using requestAnimationFrame, similar to the autoArrange animation pattern (line 1258-1286).

### P2-8: Schema badge text says "SQL TABLE" for table nodes but spec says "SQL TABLE" is the type badge

**What's wrong:** Actually this is correct — the node shows both a type badge (SQL TABLE / SQL MLV / PYSPARK) and a schema badge (BRONZE / SILVER / GOLD). Both are present. Verified OK.

---

## P3 — Nice-to-Haves

### P3-1: No command palette (`/` key) for quick-add

Per C05 spec §1.2: "`/` keyboard shortcut opens a quick-add search popup." Not implemented in mock.

### P3-2: No palette collapse/expand toggle

Per C05 spec §1.2: "collapsible" palette. The mock always shows the palette at 200px. No collapse button.

### P3-3: No resize handle on code preview panel

Per C08 spec §2.1: `panelWidth` is resizable (min 220, max 480). Mock has fixed 280px width.

### P3-4: No keyboard navigation between nodes (Tab/Arrow keys)

Per C06 spec §7 (Keyboard & Accessibility): nodes should be focusable via Tab, navigable via Arrow keys.

### P3-5: No ARIA roles on nodes, connections, or ports

Per multiple specs, accessibility is specified but not implemented in mock.

### P3-6: No undo/redo keyboard indicator in the toolbar

The status bar mentions "Ctrl+Z undo" but the toolbar buttons don't show keyboard shortcuts.

### P3-7: The `initECommerce()` function should be more prominent as a demo

The e-commerce demo initializes automatically. Consider making this a selectable "template" — this directly feeds into the Presets research in Part 2.

---

# Part 2: Presets Research

## A. Common Data Pipeline Topologies

### A.1 Medallion Architecture (Bronze → Silver → Gold)

```
TABLES (Bronze)          MLVs (Silver)           MLVs (Gold)
┌──────────┐          ┌──────────────┐         ┌─────────────┐
│ orders   │────────▸│ orders_clean │───┐     │             │
└──────────┘          └──────────────┘   ├───▸│ customer_360│
┌──────────┐          ┌──────────────┐   │     │             │
│customers │────────▸│ customers_   │───┘     └─────────────┘
└──────────┘          │ enriched     │
                      └──────────────┘
```

**When used:** Most common pattern in Fabric/Databricks lakehouse. Every tutorial starts here. Default choice for 80% of users.
**Node counts:** 2-5 Tables, 2-4 Silver MLVs, 1-2 Gold MLVs
**Complexity:** ★★☆☆☆

### A.2 Star Schema

```
                    ┌─────────────┐
                    │ dim_product │
                    └──────┬──────┘
                           │
┌─────────────┐     ┌──────▼──────┐     ┌─────────────┐
│ dim_customer│────▸│ fact_sales  │◂────│ dim_date    │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │ dim_store   │
                    └─────────────┘
```

**When used:** Analytics/BI workloads. Central fact table surrounded by dimension tables. Multiple dimension tables feed into one or more fact MLVs.
**Node counts:** 3-8 Dimension Tables (bronze), 1-3 Fact MLVs (silver/gold)
**Complexity:** ★★★☆☆

### A.3 Snowflake Schema

Extension of star schema where dimension tables have sub-dimensions:

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│ region   │────▸│ store_region │────▸│ fact_sales   │◂────│ product     │
└──────────┘     └──────────────┘     └──────────────┘     └──────┬──────┘
                                                                   │
                                                            ┌──────▼──────┐
                                                            │ category    │
                                                            └─────────────┘
```

**When used:** Complex dimensional modeling with normalized dimensions. Less common in lakehouse (denormalization preferred).
**Node counts:** 5-12 Tables, 3-6 MLVs
**Complexity:** ★★★★☆

### A.4 Linear Chain (Simple Pipeline)

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ raw_data │────▸│ cleaned      │────▸│ enriched     │────▸│ aggregated   │
└──────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

**When used:** Simple ETL. Single source, sequential transformations. Beginner-friendly.
**Node counts:** 1 Table, 2-4 MLVs
**Complexity:** ★☆☆☆☆

### A.5 Fan-Out (One-to-Many)

```
                 ┌──────────────┐
            ┌───▸│ sales_us     │
            │    └──────────────┘
┌──────────┐│    ┌──────────────┐
│ raw_sales│├───▸│ sales_eu     │
└──────────┘│    └──────────────┘
            │    ┌──────────────┐
            └───▸│ sales_apac   │
                 └──────────────┘
```

**When used:** Region/segment splits. One source, multiple filtered views. Common for geo-partitioned data.
**Node counts:** 1-2 Tables, 3-6 MLVs
**Complexity:** ★★☆☆☆

### A.6 Fan-In / Merge (Many-to-One)

```
┌──────────┐
│ source_a │────┐
└──────────┘    │    ┌──────────────┐
┌──────────┐    ├───▸│ unified_view │
│ source_b │────┤    └──────────────┘
└──────────┘    │
┌──────────┐    │
│ source_c │────┘
└──────────┘
```

**When used:** Data consolidation. Multiple sources merged into one view. Common for reporting.
**Node counts:** 2-6 Tables, 1-2 MLVs
**Complexity:** ★★☆☆☆

### A.7 Diamond (Fork-Join)

```
                 ┌──────────────┐
            ┌───▸│ view_a       │───┐
┌──────────┐│    └──────────────┘   │    ┌──────────────┐
│ source   │├                       ├───▸│ combined     │
└──────────┘│    ┌──────────────┐   │    └──────────────┘
            └───▸│ view_b       │───┘
                 └──────────────┘
```

**When used:** When same source needs different transformations that are then recombined. Common in feature engineering.
**Node counts:** 1-2 Tables, 2-4 Silver MLVs, 1 Gold MLV
**Complexity:** ★★★☆☆

### A.8 Hub-and-Spoke

```
                    ┌──────────────┐
               ┌───▸│ dept_finance │
               │    └──────────────┘
┌──────────┐   │    ┌──────────────┐
│ central_ │───├───▸│ dept_hr      │
│ data     │   │    └──────────────┘
└──────────┘   │    ┌──────────────┐
               └───▸│ dept_eng     │
                    └──────────────┘
```

**When used:** Centralized data governance with domain-specific views. Data mesh lite.
**Node counts:** 1-3 Tables (hub), 3-8 MLVs (spokes)
**Complexity:** ★★☆☆☆

### A.9 Wide Independent (Parallel Lanes)

```
┌──────────┐     ┌──────────────┐
│ orders   │────▸│ order_metrics│
└──────────┘     └──────────────┘

┌──────────┐     ┌──────────────┐
│ products │────▸│ product_stats│
└──────────┘     └──────────────┘

┌──────────┐     ┌──────────────┐
│ customers│────▸│ cust_profile │
└──────────┘     └──────────────┘
```

**When used:** Independent data domains that don't interact. Each table has its own view. Simplest multi-table pattern.
**Node counts:** 2-6 Tables, 2-6 MLVs (1:1)
**Complexity:** ★☆☆☆☆

### A.10 Lambda Pattern (Speed + Batch Layers)

```
              ┌───────────────┐     ┌──────────────┐
         ┌───▸│ batch_process │────▸│              │
┌────────┤    └───────────────┘     │  merged_view │
│ source │                          │              │
└────────┤    ┌───────────────┐     └──────────────┘
         └───▸│ stream_process│────▸       ▲
              └───────────────┘            │
                                    (both feed in)
```

**When used:** Hybrid batch/streaming. Not common for pure lakehouse MLV patterns but appears in mixed environments.
**Node counts:** 1-2 Tables, 2-4 MLVs
**Complexity:** ★★★☆☆

---

## B. Industry DAG Scaffolding Analysis

### B.1 dbt (Data Build Tool)

- **Templates:** `dbt init` creates starter project with `models/staging/`, `models/intermediate/`, `models/marts/` directories
- **Scaffolding:** No visual builder. Templating via `dbt_project.yml` and file-based model creation
- **Key pattern:** Medallion by convention (staging → intermediate → marts). The community `dbt_utils` package provides common patterns
- **What we can learn:** dbt's staging/intermediate/marts folder structure maps perfectly to bronze/silver/gold. Users think in tiers.

### B.2 Databricks DLT (Delta Live Tables)

- **Templates:** "DLT Quickstart" notebooks with pre-built medallion pipelines
- **Scaffolding:** Visual pipeline graph auto-generated from notebook code. No visual drag-and-drop builder.
- **Key pattern:** `STREAMING LIVE TABLE` and `MATERIALIZED VIEW` declarations in SQL notebooks
- **What we can learn:** DLT emphasizes **"declare, don't orchestrate"** — the code IS the DAG. Our code preview panel mirrors this philosophy.

### B.3 Azure Data Factory (ADF)

- **Templates:** "Template Gallery" in the portal — pre-built pipelines searchable by scenario (e.g., "Copy data from SQL to Blob")
- **Scaffolding:** ~50+ templates organized by category. Each template creates a full pipeline with parameterized activities.
- **Key UX pattern:** Modal gallery with visual preview → one-click deploy → customize
- **What we can learn:** ADF's template gallery is the closest industry precedent for what we're building. Key insight: users want to SEE the shape before committing.

### B.4 Apache Airflow

- **Templates:** No built-in visual templates. DAG Factory pattern (code-based dynamic DAG generation from YAML configs)
- **Scaffolding:** Community-driven — `airflow-dag-factory`, `astronomer-cosmos` for dbt DAGs
- **What we can learn:** Airflow's DAG Factory shows that users want configuration-driven generation, not always manual construction.

### B.5 n8n / Prefect / Dagster

- **n8n:** Template gallery with 1000+ community workflows. "Browse Templates" button in empty canvas.
- **Prefect:** No visual builder. Focuses on decorators/flow definitions.
- **Dagster:** Asset graph auto-generated from code. "Materialize All" button. No drag-and-drop builder.
- **What we can learn:** n8n's empty-canvas "Browse Templates" UX is the gold standard for template discovery.

### B.6 Fivetran / Airbyte

- **Connector patterns:** Pre-built source→destination pairs, not DAGs per se
- **What we can learn:** Users want to say "I have Salesforce + Stripe + PostgreSQL → give me a dashboard-ready schema." Source-count drives the pattern.

### B.7 Google Dataform

- **Templates:** `dataform init` creates project with `sources/`, `transformations/`, `outputs/` structure
- **What we can learn:** Similar tier-based organization to dbt. Reinforces the medallion pattern as dominant.

---

## C. UX Patterns for Structure Selection

### C.1 Visual Preview Cards (RECOMMENDED)

Show each structure type as a card with:
- Mini ASCII/SVG diagram showing the topology
- Name and one-line description
- Node count indicators (e.g., "3 Tables → 2 MLVs → 1 MLV")
- Complexity rating (stars or simple/moderate/complex)

**Precedent:** ADF Template Gallery, n8n Template Browser, GitHub repo templates

### C.2 "Quick Start" Button on Empty Canvas (RECOMMENDED)

When the canvas is empty, the existing empty state message ("Build Your DAG — Drag nodes from the palette...") should also show a "Quick Start" button that opens the structure picker.

**Precedent:** n8n's empty canvas, Figma's community templates, VS Code's Welcome tab

### C.3 Stepwise Configuration

1. **Choose Structure Type** (visual cards)
2. **Configure Counts** (sliders: "Number of source tables: [3]", "Number of silver MLVs: [2]", "Number of gold MLVs: [1]")
3. **Preview** (live mini-diagram updates as counts change)
4. **Generate** (creates nodes + connections on canvas)

**Precedent:** Azure Resource Manager template parameters, GitHub Actions starter workflows

### C.4 Integration with Existing Flow

- Presets should APPEND to existing canvas or REPLACE (user choice)
- After generation, nodes should be fully editable (rename, retype, reconnect)
- "Reset Canvas" should be available but with confirmation
- Undo should be able to reverse the entire preset generation as one action

---

## D. Smart Defaults

### D.1 Auto-Naming by Tier

| Tier | Naming Pattern | Examples |
|------|---------------|----------|
| Bronze (Tables) | `{domain}_raw` or `raw_{domain}` | `orders_raw`, `customers_raw`, `products_raw` |
| Silver (First MLVs) | `{domain}_clean` or `{domain}_enriched` | `orders_clean`, `customers_enriched` |
| Gold (Final MLVs) | `{domain}_summary` or `{domain}_360` | `sales_summary`, `customer_360` |

For generic presets (no domain context), use:
- Tables: `source_1`, `source_2`, `source_3`
- Silver: `transform_1`, `transform_2`
- Gold: `aggregate_1`, `report_1`

### D.2 Auto-Schema Assignment

| Node Position in DAG | Schema |
|-----------------------|--------|
| Root nodes (Tables) | `bronze` |
| Layer 1 MLVs (direct from Tables) | `silver` |
| Layer 2+ MLVs (from other MLVs) | `gold` |

### D.3 Auto-Connection Rules

Connections are deterministic based on topology:
- **Medallion:** Each table connects to one silver MLV. Silver MLVs connect to gold MLV(s).
- **Star:** All dimension tables connect to the fact MLV.
- **Fan-out:** Source table connects to all downstream MLVs.
- **Fan-in:** All source tables connect to the merge MLV.
- **Linear:** Chain connections sequentially.

### D.4 Auto-Layout

After preset generation, automatically run `autoArrange()` to position nodes cleanly, then `fitView()`.

### D.5 Modifiable After Generation

Critical: presets create a STARTING POINT. Every aspect is editable:
- Rename any node
- Change any node's type or schema
- Add/remove connections
- Add more nodes from the palette
- Delete preset nodes

---

## E. Recommended Structure Types

### E.1 Simple Pipeline

```
┌────────┐     ┌─────────┐     ┌─────────┐
│ source │────▸│ cleaned │────▸│ output  │
└────────┘     └─────────┘     └─────────┘
```

- **Description:** Single source table, one transformation, one output. The simplest possible DAG.
- **When picked:** First-time users, tutorials, single-table scenarios, learning the tool
- **Default counts:** 1 Table, 1 Silver MLV, 1 Gold MLV (range: 1T, 1-2M)
- **Complexity:** ★☆☆☆☆
- **MLV type:** SQL MLV (default), user can change to PySpark

### E.2 Medallion (Bronze → Silver → Gold)

```
┌──────┐     ┌──────────┐
│ T1   │────▸│ Silver_1 │───┐
└──────┘     └──────────┘   │   ┌─────────┐
┌──────┐     ┌──────────┐   ├──▸│ Gold_1  │
│ T2   │────▸│ Silver_2 │───┘   └─────────┘
└──────┘     └──────────┘
┌──────┐     ┌──────────┐
│ T3   │────▸│ Silver_3 │──────▸(Gold_1)
└──────┘     └──────────┘
```

- **Description:** Classic lakehouse medallion. Each source gets a cleaning view, all feed into a golden aggregate.
- **When picked:** Most common real-world pattern. Default recommendation.
- **Default counts:** 3 Tables, 3 Silver MLVs, 1 Gold MLV (range: 2-8T, 1-8S, 1-3G)
- **Complexity:** ★★☆☆☆
- **MLV type:** SQL MLV for silver, PySpark MLV for gold (default)

### E.3 Star Schema

```
        ┌────┐
        │ D1 │───┐
        └────┘   │
┌────┐           │   ┌─────────┐
│ D2 │───────────├──▸│  Fact   │
└────┘           │   └─────────┘
        ┌────┐   │
        │ D3 │───┘
        └────┘
```

- **Description:** Multiple dimension tables feeding a central fact MLV. Classic BI pattern.
- **When picked:** Analytics dashboards, reporting, BI use cases
- **Default counts:** 4 Tables (dimensions), 1 Gold MLV (fact) (range: 3-8T, 1-3M)
- **Complexity:** ★★★☆☆
- **MLV type:** SQL MLV (all)

### E.4 Fan-Out (Split)

```
            ┌──────────┐
       ┌───▸│ View_A   │
┌────┐ │    └──────────┘
│ T1 │─├───▸│ View_B   │
└────┘ │    └──────────┘
       └───▸│ View_C   │
            └──────────┘
```

- **Description:** One source table split into multiple filtered/transformed views. Region splits, segment views.
- **When picked:** Geo-partitioned data, user segments, product categories
- **Default counts:** 1 Table, 3 Silver MLVs (range: 1-2T, 2-6M)
- **Complexity:** ★★☆☆☆
- **MLV type:** SQL MLV (default)

### E.5 Merge (Fan-In)

```
┌────┐
│ T1 │───┐
└────┘   │   ┌──────────┐
┌────┐   ├──▸│ Unified  │
│ T2 │───┤   └──────────┘
└────┘   │
┌────┐   │
│ T3 │───┘
└────┘
```

- **Description:** Multiple source tables merged into one unified view. Data consolidation, union patterns.
- **When picked:** Multi-source reporting, consolidated dashboards, data lake aggregation
- **Default counts:** 3 Tables, 1 Gold MLV (range: 2-8T, 1-2M)
- **Complexity:** ★★☆☆☆
- **MLV type:** SQL MLV or PySpark MLV (user choice)

### E.6 Diamond (Fork-Join)

```
            ┌──────────┐
       ┌───▸│ Branch_A │───┐
┌────┐ │    └──────────┘   │   ┌──────────┐
│ T1 │─┤                   ├──▸│ Combined │
└────┘ │    ┌──────────┐   │   └──────────┘
       └───▸│ Branch_B │───┘
            └──────────┘
```

- **Description:** Source splits into branches (different transformations), then recombines. Feature engineering pattern.
- **When picked:** ML feature pipelines, A/B data comparisons, multi-perspective analysis
- **Default counts:** 1 Table, 2 Silver MLVs, 1 Gold MLV (range: 1-3T, 2-4S, 1-2G)
- **Complexity:** ★★★☆☆
- **MLV type:** PySpark MLV (gold), SQL MLV (silver)

### E.7 Independent Lanes

```
┌────┐     ┌──────────┐
│ T1 │────▸│ View_1   │
└────┘     └──────────┘

┌────┐     ┌──────────┐
│ T2 │────▸│ View_2   │
└────┘     └──────────┘

┌────┐     ┌──────────┐
│ T3 │────▸│ View_3   │
└────┘     └──────────┘
```

- **Description:** Parallel independent pipelines with no cross-connections. Each source has its own view.
- **When picked:** Domain separation, independent metrics, microservice-style data
- **Default counts:** 3 Tables, 3 Silver MLVs (range: 2-8T, 2-8M, 1:1 ratio)
- **Complexity:** ★☆☆☆☆
- **MLV type:** SQL MLV (default)

---

## F. UX Integration Recommendation

### F.1 Where It Lives: Empty State + Toolbar Button

**Primary entry:** The empty canvas state (`.es`, line 227) should add a "Quick Start with a Template" button below the existing hint text. This is the most discoverable placement — every new user sees it.

**Secondary entry:** A toolbar button (add to `.tb`, line 179) labeled with a template/scaffold icon. Allows template access even after the canvas has content.

**Tertiary entry:** The palette bottom section (`.pal-bot`, line 75) — "Templates" button alongside Auto Arrange and Undo/Redo.

### F.2 Modal Design

When triggered, show a **modal overlay** with:

```
┌─────────────────────────────────────────────────────────────┐
│  Quick Start: Choose a Structure                      [✕]  │
│─────────────────────────────────────────────────────────────│
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ ★☆☆☆☆      │  │ ★★☆☆☆      │  │ ★★★☆☆      │        │
│  │  ○─○─○     │  │  ○─○─┐     │  │    ○─┐      │        │
│  │             │  │  ○─○─┼─○   │  │  ○───┼─○    │        │
│  │ Simple      │  │  ○─○─┘     │  │    ○─┘      │        │
│  │ Pipeline    │  │ Medallion   │  │ Star Schema  │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ ★★☆☆☆      │  │ ★★☆☆☆      │  │ ★★★☆☆      │        │
│  │  ○─┬─○     │  │  ○─┐       │  │  ○─○─┐      │        │
│  │    ├─○     │  │  ○─┼─○     │  │      ├─○    │        │
│  │    └─○     │  │  ○─┘       │  │  ○─○─┘      │        │
│  │ Fan-Out     │  │ Merge       │  │ Diamond      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                             │
│  ┌─────────────┐                                           │
│  │ ★☆☆☆☆      │     ┌─────────────────────────────┐       │
│  │  ○─○       │     │ Tables:  [3] ←─────→        │       │
│  │  ○─○       │     │ MLVs:    [2] ←─────→        │       │
│  │  ○─○       │     │ Gold:    [1] ←─────→        │       │
│  │ Independent │     │                             │       │
│  │ Lanes       │     │ [Preview]  [Generate DAG]   │       │
│  └─────────────┘     └─────────────────────────────┘       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### F.3 Interaction Flow

1. User clicks "Quick Start" on empty canvas (or toolbar button)
2. Modal opens showing 7 structure cards with mini-diagrams
3. User clicks a card → right panel shows configuration:
   - Number of tables (slider, default from preset)
   - Number of silver MLVs (slider)
   - Number of gold MLVs (slider)
   - Live mini-preview updates
4. User clicks "Generate DAG"
5. Modal closes
6. Nodes and connections are created on canvas with spring animation
7. Auto-arrange runs automatically
8. Fit-to-view runs automatically
9. Code preview refreshes
10. Toast: "Created Medallion pipeline with 3 tables and 4 views"

### F.4 Replace vs Append

If canvas already has nodes:
- Show a confirmation: "This will replace all existing nodes. Continue?"
- OR offer "Append" option that adds template nodes alongside existing ones

### F.5 Undo Support

The entire preset generation should be a single undo action. Pressing Ctrl+Z should remove ALL preset-generated nodes and connections at once, not one by one.

---

# Part 3: Surgical Fix Plan

Ordered by priority. Each fix preserves the existing design language and craziness of the mock.

## Fix Order

### Phase 1: Connection Visibility (CEO Blocker)

| # | Fix | Issue | Effort | Risk |
|---|-----|-------|--------|------|
| 1 | **Increase connection path opacity** from 0.45 → 0.7, hover → 1.0 | P0-1 | 5 min | None |
| 2 | **Increase connection stroke-width** from 2 → 2.5 | P0-1 | 2 min | None |
| 3 | **Increase flow animation opacity** from 0.25 → 0.4 | P2-1 | 2 min | None |
| 4 | **Fix arrowhead marker opacity** from 0.45 → 0.8 | P0-2 | 5 min | None |
| 5 | **Create per-schema arrowhead markers** (bronze, silver, gold, dbo) | P0-2 | 15 min | Low |
| 6 | **Add SVG `<title>` to connection paths** for hover tooltips | P1-3 | 5 min | None |
| 7 | **Add glow filter to selected connections** via CSS `filter: drop-shadow()` | P2-2 | 5 min | None |

### Phase 2: Connection Validation & Port Feedback (CEO Blocker)

| # | Fix | Issue | Effort | Risk |
|---|-----|-------|--------|------|
| 8 | **Hide Table input ports during connection drag** — don't show top port on SQL Table nodes | P0-3, P0-5 | 15 min | Low |
| 9 | **Add type-aware validation in drag move handler** — mark Table input ports as `it` (invalid target) | P0-5 | 10 min | Low |
| 10 | **Add port tooltip text** `title="Drag to connect"` / `title="Output"` / `title="Input"` | P1-1 | 5 min | None |
| 11 | **Show connection draw animation** on new connections using `cd` keyframe | P1-2 | 15 min | Low |

### Phase 3: SVG Structure Fix

| # | Fix | Issue | Effort | Risk |
|---|-----|-------|--------|------|
| 12 | **Fix SVG container dimensions** from `width:0;height:0` to `width:10000px;height:10000px` | P0-4 | 5 min | Low — test hit detection |

### Phase 4: Connection Interaction Enhancements

| # | Fix | Issue | Effort | Risk |
|---|-----|-------|--------|------|
| 13 | **Add right-click context menu on connections** | P1-7 | 20 min | Low |
| 14 | **Add orphan MLV visual indicator** (dashed border + ⚠ badge) | P2-4 | 15 min | Low |
| 15 | **Increase minimap connection visibility** | P2-6 | 2 min | None |

### Phase 5: Quick Start / Presets (New Feature)

| # | Fix | Issue | Effort | Risk |
|---|-----|-------|--------|------|
| 16 | **Add "Quick Start" button to empty state** | Part 2 | 15 min | None |
| 17 | **Build structure picker modal** with 7 topology cards | Part 2 | 2-3 hrs | Medium |
| 18 | **Build preset generation engine** (node/connection creation from topology config) | Part 2 | 1-2 hrs | Medium |
| 19 | **Integrate count sliders + live preview** | Part 2 | 1 hr | Low |
| 20 | **Add undo-as-batch for preset generation** | Part 2 | 30 min | Low |

### Phase 6: Polish

| # | Fix | Issue | Effort | Risk |
|---|-----|-------|--------|------|
| 21 | **Animate fitView transitions** | P2-7 | 15 min | Low |
| 22 | **Add code panel cell highlighting** when node selected | P2-5 | 20 min | Low |

---

## Summary

**Total P0 issues:** 5 (all connection-related — visibility, validation, SVG structure)
**Total P1 issues:** 7 (interaction gaps — port feedback, connection menu, animation)
**Total P2 issues:** 7 (polish — glow, indicators, minimap, transitions)
**Total P3 issues:** 7 (nice-to-haves — command palette, accessibility, resize)

**Estimated effort for Phase 1-4 (critical fixes):** ~2-3 hours of focused implementation
**Estimated effort for Phase 5 (presets):** ~4-6 hours

**The single most impactful fix:** Increasing connection opacity from 0.45 to 0.7 (Fix #1). This 2-second CSS change resolves the CEO's primary complaint and makes the entire DAG canvas comprehensible.
