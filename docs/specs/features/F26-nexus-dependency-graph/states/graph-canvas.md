# Nexus Graph Canvas — State Matrix

> **Component:** `NexusTab` canvas renderer (`src/frontend/js/tab-nexus.js`)
> **Owner:** Pixel (Frontend Engineer)
> **Total states:** 19
> **Companion:** `components/C06-tab-nexus.md` (S01–S18 scenarios)
> **Data source:** `nexus` topic via SignalR (1 Hz snapshots + out-of-band alerts)
> **Rendering:** Canvas 2D — no external libraries
> **Status:** SPEC COMPLETE

---

## Table of Contents

1. [Canvas Lifecycle States](#1-canvas-lifecycle-states) (6 states)
2. [Interaction States](#2-interaction-states) (6 states)
3. [Layout & Animation States](#3-layout--animation-states) (3 states)
4. [Performance Degradation States](#4-performance-degradation-states) (2 states)
5. [Data Freshness States](#5-data-freshness-states) (2 states)
6. [State Transition Diagram](#6-state-transition-diagram)
7. [Compound State Rules](#7-compound-state-rules)
8. [Full Event × State Matrix](#8-full-event--state-matrix)

---

## Legend

Each state entry follows this structure:

| Field | Description |
|-------|-------------|
| **ID** | Unique state identifier (dot-separated hierarchy) |
| **Entry conditions** | What triggers entry into this state |
| **Exit conditions** | What triggers exit from this state |
| **Visual** | What the user sees on the canvas |
| **Canvas commands** | Key `ctx` calls that produce the visual |
| **Keyboard** | Active keyboard shortcuts in this state |
| **Data requirements** | What data / SignalR subscriptions must be present |
| **Transitions** | Where this state can go next, with triggers |
| **Error recovery** | What happens on failure while in this state |

---

## 1. Canvas Lifecycle States

These are **mutually exclusive** — the canvas is always in exactly one lifecycle state.

---

### State: `canvas.empty`

No snapshot data has been received. The tab was activated but the backend has not yet published to the `nexus` topic, or the received snapshot contains zero dependency nodes.

| Field | Value |
|-------|-------|
| **ID** | `canvas.empty` |
| **Entry conditions** | (1) `activate()` called, `this._snapshot === null`. (2) Snapshot received but `nodes` contains only `flt-local` and no dependency nodes. (3) Snapshot received with `nodes: []` or `edges: []`. |
| **Exit conditions** | `_onSnapshot()` receives a snapshot with at least one dependency node (a node where `kind !== 'core'`) → `canvas.animating-layout`. SignalR disconnects → `canvas.error`. |
| **Visual** | Canvas element hidden (`nexus-canvas-wrap.hidden`). Overlay `div.nexus-empty` visible: inline SVG graph icon (48x48, `stroke="currentColor"`), title "No dependency data yet" in `--text-dim` / `--text-md` / 500 weight, subtitle "Nexus will populate once FLT begins making outbound calls." in `--text-muted` / `--text-sm`. No spinner — data arrives via push. Toolbar visible but Internals toggle has no visual effect. Toast container active (alerts can still arrive). |
| **Canvas commands** | None — canvas is hidden. No RAF loop running. |
| **Keyboard** | `Tab` / `Shift+Tab` — no-op (no nodes). `Escape` — no-op. `Enter` — no-op. |
| **Data requirements** | SignalR subscription to `nexus` topic active (`signalr.on('nexus', _onSnapshot)` + `signalr.subscribeTopic('nexus')`). `this._snapshot === null` or snapshot with 0 dependency nodes. |
| **Transitions** | → `canvas.animating-layout` (first non-empty snapshot arrives, layout must compute) · → `canvas.error` (SignalR disconnects) |
| **Error recovery** | If SignalR is null at activate time (disconnected phase): show empty state, not error. Subscription will be established when SignalR connects. |

---

### State: `canvas.loading`

Tab is activated, SignalR is connected, but the first snapshot has not yet arrived. Distinct from `canvas.empty` by the presence of an active connection — the user expects data imminently.

| Field | Value |
|-------|-------|
| **ID** | `canvas.loading` |
| **Entry conditions** | `activate()` called, `this._snapshot === null`, and `signalr.status === 'connected'`. The `SubscribeToTopic` stream is established and the snapshot history phase is in progress. |
| **Exit conditions** | First snapshot arrives → `canvas.empty` (if no deps) or `canvas.animating-layout` (if deps present). SignalR disconnects → `canvas.error`. Timeout: if no snapshot received within 10 s of subscribe, remain in loading (backend may not have aggregated yet). |
| **Visual** | Canvas element hidden. Overlay `div.nexus-loading` visible: text "Waiting for Nexus data..." in `--text-muted` / `--text-sm` with a subtle CSS opacity pulse animation (0.4–1.0 over 2 s cycle). No spinner, no skeleton. Toolbar visible. Toast container active. |
| **Canvas commands** | None — canvas is hidden. |
| **Keyboard** | `Tab` / `Shift+Tab` — no-op. `Escape` — no-op. |
| **Data requirements** | Active SignalR connection + `nexus` topic subscription. `this._snapshot === null`. `this._signalr.status === 'connected'`. |
| **Transitions** | → `canvas.animating-layout` (first snapshot with dependency nodes) · → `canvas.empty` (snapshot with no deps) · → `canvas.error` (SignalR disconnect) |
| **Error recovery** | If SignalR reconnects (auto-reconnect cycle), the `_resubscribeAll()` in `signalr-manager.js` re-streams the topic. Handler tolerates re-delivery of initial snapshot. |

---

### State: `canvas.idle`

Graph is rendered and stable. No user interaction in progress. This is the primary operating state — the user sees the full interactive topology.

| Field | Value |
|-------|-------|
| **ID** | `canvas.idle` |
| **Entry conditions** | (1) Layout computation completes and first frame renders (`canvas.animating-layout` → converged). (2) User finishes an interaction (hover moves off, deselect). (3) Snapshot update processed where node set is unchanged (metrics-only update). |
| **Exit conditions** | Mouse enters a node hit area → `canvas.node-hovered`. Mouse enters an edge hit zone → `canvas.edge-hovered`. User clicks a node → `canvas.node-selected`. User clicks an edge → `canvas.edge-selected`. New snapshot changes node set → `canvas.snapshot-transitioning`. Tab key pressed → `canvas.node-selected` (first navigable node). No snapshot for 3 s → `canvas.stale`. SignalR disconnect → `canvas.error`. Render budget exceeded → `canvas.degraded-30fps`. |
| **Visual** | Full graph rendered on canvas. FLT center node at canvas center (28 px radius, `--accent` 2 px border, `--surface` fill, "FLT" label inside). Dependency nodes on ring 1 at radius `min(w,h) * 0.35`, sized by volume (`clamp(16, 16 + sqrt(volume) * 2, 48)` px). Edges as quadratic bezier curves from FLT to each dependency, color by health (`--status-succeeded` / `--status-cancelled` / `--status-failed`), thickness by throughput (`clamp(1, throughputPerMin / 10, 6)` px), arrowhead at dependency end. Labels below each node in `--text-dim` / `--font-mono` / `--text-xs`. Non-healthy edges pulse (continuous RAF loop while pulsing edges exist). Cursor: `default` on empty space, implicit pointer on node/edge via CSS on overlay. Toolbar at top. Toast container at top-right. |
| **Canvas commands** | Full render pipeline: `ctx.clearRect()` → `ctx.scale(dpr, dpr)` → draw edges (healthy first, degraded second, critical last for z-order) → draw nodes → draw labels → `ctx.restore()`. If non-healthy edges exist, `_scheduleRender()` re-queues RAF for pulse animation. |
| **Keyboard** | `Tab` — select first navigable node (alphabetical order, filtered by `_showInternals`). `Shift+Tab` — select last navigable node. `Escape` — no-op (nothing selected). `Enter` — no-op (nothing selected). |
| **Data requirements** | `this._snapshot` (latest NexusSnapshot). `this._nodes` (Map: nodeId → `{x, y, volume, kind, radius}`). `this._edges` (EdgeState[]). `this._selectedNode === null`. `this._selectedEdge === null`. `this._hoveredNode === null`. `this._hoveredEdge === null`. SignalR `nexus` subscription active. |
| **Transitions** | → `canvas.node-hovered` (mousemove hit test → node) · → `canvas.edge-hovered` (mousemove hit test → edge within 8 px) · → `canvas.node-selected` (click node, or Tab key) · → `canvas.edge-selected` (click edge) · → `canvas.snapshot-transitioning` (snapshot changes node set) · → `canvas.stale` (no snapshot for >3 s) · → `canvas.error` (SignalR disconnects) · → `canvas.degraded-30fps` (frame time exceeds 16 ms budget consistently) |
| **Error recovery** | If canvas context is lost (`ctx === null`), attempt `canvas.getContext('2d')` once. If still null → `canvas.error`. |

---

### State: `canvas.error`

A rendering or connectivity error prevents the graph from being displayed. Fallback UI shown.

| Field | Value |
|-------|-------|
| **ID** | `canvas.error` |
| **Entry conditions** | (1) SignalR disconnects while tab is active. (2) Canvas 2D context cannot be acquired (`getContext('2d')` returns null). (3) Uncaught exception in `_renderGraph()` (caught by try/catch in render pipeline). |
| **Exit conditions** | SignalR reconnects and a new snapshot arrives → `canvas.animating-layout` or `canvas.idle`. Canvas context re-acquired after retry → previous data state. |
| **Visual** | Canvas hidden. Overlay `div.nexus-error` visible: "Connection lost" text in `--text-dim` with reconnect status indicator matching the `rt-conn-dot` pattern from the Runtime View header (pulsing amber dot during reconnect attempts). If the error is a canvas context failure: "Rendering error — your browser may not support Canvas 2D" in `--text-muted`. Toolbar visible but non-functional. Existing toasts remain visible. |
| **Canvas commands** | None — canvas is hidden. RAF loop stopped (`_renderPending = false`). |
| **Keyboard** | All keys → no-op. |
| **Data requirements** | `this._signalr.status !== 'connected'` for connectivity errors. `this._ctx === null` for rendering errors. Previous snapshot may be retained in memory for recovery. |
| **Transitions** | → `canvas.loading` (SignalR reconnects, awaiting first snapshot from re-subscribe) · → `canvas.idle` (snapshot arrives after reconnect, node set matches previous — no layout needed) · → `canvas.animating-layout` (snapshot arrives after reconnect, node set differs) |
| **Error recovery** | SignalR auto-reconnect schedule `[0, 1000, 2000, 5000, 10000, 30000]` ms handles connectivity. `_resubscribeAll()` re-streams `nexus` topic. For canvas context loss: retry `getContext('2d')` on each snapshot arrival. If retry succeeds, resume rendering. If not, remain in error. |

---

### State: `canvas.snapshot-transitioning`

A new snapshot arrived that changes the node topology (nodes added or removed). The graph animates node positions from old layout to new layout.

| Field | Value |
|-------|-------|
| **ID** | `canvas.snapshot-transitioning` |
| **Entry conditions** | `_onSnapshot()` detects node set change: `newNodeIds` differs from `prevNodeIds` (node added or removed). `_layoutDirty = true` and `_computeLayout()` produces new positions. |
| **Exit conditions** | Layout animation completes (force relaxation converges in 8 iterations, effectively instant — no async animation). Transitions immediately to `canvas.idle` or `canvas.node-selected` (if a selected node still exists). |
| **Visual** | Node positions update. New nodes appear at their computed ring position. Removed nodes simply disappear (no fade — V1 simplicity). Edge paths recompute to follow new node positions. If selected node was removed, detail panel closes. Label positions update. This is a synchronous layout recompute within a single `_onSnapshot()` call — no multi-frame animation in V1. |
| **Canvas commands** | `_computeLayout()` runs 8 force-relaxation iterations synchronously. `_scheduleRender()` queues a single RAF. The render pipeline draws at the new positions. |
| **Keyboard** | Same as `canvas.idle` — transition is synchronous and effectively instant. |
| **Data requirements** | Previous `this._nodes` positions (for diffing). New snapshot `data.nodes[]` and `data.edges[]`. `this._layoutSeed` for deterministic placement. |
| **Transitions** | → `canvas.idle` (layout complete, no selection active) · → `canvas.node-selected` (layout complete, `_selectedNode` still present in new node set) · → `canvas.empty` (new snapshot has no dependency nodes) |
| **Error recovery** | If `_computeLayout()` throws (e.g., division by zero with 0-size canvas), catch the error, set `_layoutDirty = true`, and retry on next `_onResize()` or next snapshot. Do not transition to `canvas.error` — the data is valid, only the canvas sizing is problematic. |

---

### State: `canvas.animating-layout`

The initial layout computation is in progress. This is the first-render state after data arrives for the first time (or after a full reset).

| Field | Value |
|-------|-------|
| **ID** | `canvas.animating-layout` |
| **Entry conditions** | (1) First non-empty snapshot received — transitioning from `canvas.empty` or `canvas.loading`. (2) Canvas resized while `_layoutDirty === true`. |
| **Exit conditions** | `_computeLayout()` completes (8 force-relaxation iterations) and first frame renders → `canvas.idle`. |
| **Visual** | Canvas becomes visible (remove `.hidden` from `nexus-canvas-wrap`, add `.hidden` to `nexus-empty`). The graph appears fully formed at computed positions — no progressive reveal in V1. FLT at center, dependencies on ring, edges drawn. This state is effectively a single-frame transition. |
| **Canvas commands** | `_resizeCanvas()` sets canvas dimensions. `_computeLayout()` runs synchronously. `_scheduleRender()` queues RAF. First frame: full render pipeline. |
| **Keyboard** | Same as `canvas.idle` — state is instantaneous. |
| **Data requirements** | `this._snapshot` with non-empty nodes. Canvas element sized (`width > 0`, `height > 0`). `this._dpr` for HiDPI scaling. |
| **Transitions** | → `canvas.idle` (first render complete) |
| **Error recovery** | If canvas dimensions are 0 (tab hidden at compute time): set `_layoutDirty = true`, skip layout, remain in `canvas.empty`. Layout will recompute on next `activate()` which calls `_resizeCanvas()`. |

---

## 2. Interaction States

Interaction states are **concurrent sub-states** active only within `canvas.idle`, `canvas.node-selected`, or `canvas.edge-selected`. At most one interaction state is active at a time. The interaction state is independent of the lifecycle state (except that interactions only occur in data-present lifecycle states).

---

### State: `canvas.node-hovered`

Mouse cursor is over a node's hit area (within the node circle radius).

| Field | Value |
|-------|-------|
| **ID** | `canvas.node-hovered` |
| **Entry conditions** | `mousemove` event on canvas → hit test (`_hitTestNode(x, y)`) returns a node ID. The hit area is the node circle: `distance(mouse, node.center) <= node.radius + 4` (4 px tolerance). |
| **Exit conditions** | `mousemove` hit test returns a different node → re-enter `canvas.node-hovered` for new node. Hit test returns null and edge hit test also returns null → `canvas.idle`. Hit test returns an edge → `canvas.edge-hovered`. User clicks → `canvas.node-selected`. Mouse leaves canvas → `canvas.idle`. |
| **Visual** | Cursor: `pointer`. Hovered node: fill alpha increases from 0.85 → 1.0 (brighter). If FLT node: subtle accent glow. Connected edges become more opaque. Non-connected elements unchanged. Tooltip: DOM-based `div.nexus-tooltip` positioned near cursor (`clientX + 12, clientY + 12`), clamped to viewport. Tooltip content: dependency display name, health badge, p50 latency, throughput/min. Tooltip appears after 0 ms delay (instant). If another node was hovered previously, its highlight clears. |
| **Canvas commands** | `_drawNode()` with `isHovered = true` → `ctx.globalAlpha = 1.0` (vs 0.85 normal). Selection ring not drawn (hover ≠ selection). Edge draw pass unchanged but edge to this node gets `ctx.globalAlpha = 1.0` (vs 0.7 normal). |
| **Keyboard** | `Tab` — selects the hovered node (or next in tab order). `Enter` — if a node is already selected, opens detail for that node (not the hovered one). `Escape` — clears selection if any. Hover is mouse-only. |
| **Data requirements** | Node position and radius for hit test. Edge data for tooltip content (`this._edges.find(e => e.toId === hoveredId)`). Display name mapping. |
| **Transitions** | → `canvas.idle` (mouse leaves all interactive areas) · → `canvas.node-hovered` (mouse moves to different node) · → `canvas.edge-hovered` (mouse moves to edge hit zone) · → `canvas.node-selected` (click on hovered node) |
| **Error recovery** | If hit test returns a node ID not in `this._nodes` (stale reference): treat as null hit, return to `canvas.idle`. |

---

### State: `canvas.edge-hovered`

Mouse cursor is near an edge's path (within 8 px perpendicular distance of the bezier curve).

| Field | Value |
|-------|-------|
| **ID** | `canvas.edge-hovered` |
| **Entry conditions** | `mousemove` event on canvas → node hit test returns null → edge hit test (`_hitTestEdge(x, y)`) returns an edge index. Edge hit zone: perpendicular distance from mouse to the quadratic bezier curve is ≤ 8 px (sampled at 20 points along the curve). |
| **Exit conditions** | `mousemove` → hit test returns a node → `canvas.node-hovered`. Hit test returns a different edge → re-enter for new edge. Hit test returns null for both → `canvas.idle`. User clicks → `canvas.edge-selected`. Mouse leaves canvas → `canvas.idle`. |
| **Visual** | Cursor: `pointer`. Hovered edge: opacity increases to 1.0, thickness increases by 1 px. A floating tooltip appears near cursor: dependency name, health status, p50/p95 latency, error rate, throughput. Source and target nodes get a subtle brightness increase (fill alpha 0.9 vs 0.85). Other edges and nodes unchanged. |
| **Canvas commands** | Hovered edge drawn with `ctx.globalAlpha = 1.0`, `ctx.lineWidth = baseThickness + 1`. Connected nodes drawn with `ctx.globalAlpha = 0.9`. Tooltip: DOM element positioned at cursor. |
| **Keyboard** | Same as `canvas.idle`. Edge hover is mouse-only; edges are not keyboard-navigable in V1. |
| **Data requirements** | Edge path geometry for hit test (bezier control points). Edge metrics for tooltip. |
| **Transitions** | → `canvas.idle` (mouse leaves interactive areas) · → `canvas.node-hovered` (mouse enters a node) · → `canvas.edge-hovered` (mouse moves to different edge) · → `canvas.edge-selected` (click on hovered edge) |
| **Error recovery** | If edge references nodes not in `this._nodes` (from → to mapping broken): skip this edge in hit test, treat as null. |

---

### State: `canvas.node-selected`

A node has been clicked or keyboard-selected. The detail panel is open showing that node's metrics.

| Field | Value |
|-------|-------|
| **ID** | `canvas.node-selected` |
| **Entry conditions** | (1) User clicks a node on canvas (`_onCanvasClick` → hit test returns node ID). (2) User presses `Tab`/`Shift+Tab` to cycle to a node. (3) User presses `Enter` while a node is keyboard-focused. (4) "Other" aggregate node clicked. |
| **Exit conditions** | User clicks a different node → re-enter `canvas.node-selected` for new node. User clicks empty canvas space → `canvas.idle`. User clicks an edge → `canvas.edge-selected`. User presses `Escape` → detail panel closes → `canvas.idle`. User clicks detail panel close button (`✕`) → `canvas.idle`. Selected node removed by snapshot update → `canvas.idle` (detail panel closes). |
| **Visual** | Selected node: 3 px `--accent` solid ring + dashed selection ring at `radius + 5` (4/3 dash pattern). Node fill at full opacity. Connected edge drawn at full opacity with `--accent` tint. Detail panel slides in from right: 320 px wide, `--surface` background, `--border` left border. Panel header: dependency display name + close `✕` button. Panel body: metrics table (Health badge, p50, p95, p99, error rate, retry rate, throughput, baseline delta). Panel footer: deep-link buttons ("View in HTTP Pipeline ▸", optionally "View in Spark Sessions ▸" for `spark-gts`, "View in Retries ▸" if `retryRate > 0`). If "Other" aggregate node: panel lists all collapsed dependencies with individual metrics. `aria-pressed` not set on canvas — selection is visual. |
| **Canvas commands** | Standard render + selection overlay: `ctx.arc(node.x, node.y, r + 5, 0, PI*2); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);`. Edge to selected node: `ctx.globalAlpha = 1.0` + slight accent tint via `ctx.strokeStyle` blend. |
| **Keyboard** | `Escape` — close detail panel, deselect, → `canvas.idle`. `Tab` — cycle to next navigable node (wraps). `Shift+Tab` — cycle to previous. `Enter` — no-op (panel already open). Arrow keys — reserved for future pan. Deep-link buttons in DOM panel receive standard Tab focus for keyboard activation. |
| **Data requirements** | `this._selectedNode` = clicked node ID. Edge data for selected dependency (`this._edges.find(e => e.toId === nodeId)`). Display name mapping. `this._els.detail` panel DOM elements. |
| **Transitions** | → `canvas.node-selected` (different node clicked or Tab'd to) · → `canvas.edge-selected` (edge clicked) · → `canvas.idle` (Escape, close button, click empty space) · → `canvas.snapshot-transitioning` (selected node removed by new snapshot — auto-close detail) |
| **Error recovery** | If selected node has no corresponding edge (newly appeared node with no traffic yet): show "No traffic observed" in metrics area. If `window.edogApp` unavailable when deep-link clicked: log warning via `console.warn()`, button is no-op. |

---

### State: `canvas.edge-selected`

An edge has been clicked. The detail panel is open showing that edge's metrics.

| Field | Value |
|-------|-------|
| **ID** | `canvas.edge-selected` |
| **Entry conditions** | User clicks an edge on canvas (node hit test returns null, edge hit test returns an edge index). |
| **Exit conditions** | User clicks a node → `canvas.node-selected`. User clicks empty canvas → `canvas.idle`. User clicks a different edge → re-enter `canvas.edge-selected`. `Escape` → `canvas.idle`. Close button → `canvas.idle`. Selected edge removed by snapshot update → `canvas.idle`. |
| **Visual** | Selected edge: drawn at full opacity, thickness + 2 px, with `--accent` color tint and subtle canvas shadow (`shadowBlur: 4, shadowColor: accent`). Source and target nodes get brightness increase (alpha 0.95). Detail panel slides in (same 320 px panel) with edge-specific content: same metrics table as node detail but titled with the dependency name and prefixed "Edge: FLT → {name}". Baseline delta shown prominently if > 1.0 ("3.0x above baseline" in `--status-cancelled`). Deep-link buttons same as node selection (scoped to the edge's target dependency). |
| **Canvas commands** | Selected edge: `ctx.lineWidth = baseThickness + 2; ctx.strokeStyle = accentBlend; ctx.shadowBlur = 4; ctx.shadowColor = css('--accent');` then draw bezier. `ctx.shadowBlur = 0;` after. |
| **Keyboard** | `Escape` — close panel, deselect, → `canvas.idle`. `Tab` — moves focus into detail panel DOM buttons. Other keys: no-op. |
| **Data requirements** | `this._selectedEdge` = edge index. Edge metrics. Display name of target dependency. |
| **Transitions** | → `canvas.node-selected` (node clicked) · → `canvas.edge-selected` (different edge clicked) · → `canvas.idle` (Escape, close button, click empty space) |
| **Error recovery** | If selected edge index out of bounds after snapshot update (edges array re-created): deselect edge, close panel, → `canvas.idle`. |

---

### State: `canvas.node-keyboard-focused`

A node is highlighted via keyboard navigation (`Tab`/`Shift+Tab`) but the detail panel is not yet open. The user is browsing nodes with the keyboard.

| Field | Value |
|-------|-------|
| **ID** | `canvas.node-keyboard-focused` |
| **Entry conditions** | User presses `Tab`/`Shift+Tab` from `canvas.idle` or cycles from another focused node. `_selectedNode` is set but detail panel remains closed. |
| **Exit conditions** | `Enter` → `canvas.node-selected` (opens detail panel). `Escape` → clear focus, → `canvas.idle`. `Tab`/`Shift+Tab` → move focus to next/previous node (re-enter state for new node). User clicks anything → replaces keyboard focus with click-based state. |
| **Visual** | Focused node gets a 2 px dashed `--accent` ring at `radius + 5` (same visual as `canvas.node-selected` selection ring). No detail panel. No other elements highlighted. Screen reader: `canvas` element gets `aria-activedescendant` set to a hidden label element for the focused node (for ARIA compliance). |
| **Canvas commands** | `ctx.setLineDash([4, 3]); ctx.arc(node.x, node.y, r + 5, 0, PI*2); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);` |
| **Keyboard** | `Tab` — next node (alphabetical, wrapping). `Shift+Tab` — previous node. `Enter` — open detail panel → `canvas.node-selected`. `Escape` — deselect → `canvas.idle`. |
| **Data requirements** | `_getNavigableNodeIds()` — sorted list of visible node IDs (filtered by `_showInternals`). |
| **Transitions** | → `canvas.node-selected` (Enter pressed) · → `canvas.node-keyboard-focused` (Tab to different node) · → `canvas.idle` (Escape) · → `canvas.node-selected` / `canvas.edge-selected` (mouse click overrides) |
| **Error recovery** | If navigable node list is empty (all nodes removed by snapshot): reset `_selectedNode = null`, → `canvas.idle`. |

---

### State: `canvas.detail-panel-focused`

The detail panel is open and keyboard focus has moved into the panel's DOM elements (deep-link buttons, close button). The canvas node/edge remains visually selected but keyboard events target the panel.

| Field | Value |
|-------|-------|
| **ID** | `canvas.detail-panel-focused` |
| **Entry conditions** | Detail panel is open (`canvas.node-selected` or `canvas.edge-selected`), and user presses `Tab` which moves DOM focus into the panel's focusable elements (close button, deep-link buttons). |
| **Exit conditions** | `Escape` → close panel, return focus to canvas, → `canvas.idle`. User `Tab`s past all panel buttons → focus wraps back to first panel button (focus trap within panel). User clicks canvas → `canvas.idle` or new selection state. Deep-link button activated → tab switch, panel closes. |
| **Visual** | Same as `canvas.node-selected` or `canvas.edge-selected` — the graph selection ring remains visible. Inside the panel, the focused button has a standard focus outline (`outline: 2px solid var(--accent)`). |
| **Canvas commands** | Same as the parent selection state. Canvas render is unchanged — DOM focus changes do not trigger canvas re-render. |
| **Keyboard** | `Escape` — close panel, deselect, → `canvas.idle`. `Tab` — cycle through panel buttons. `Shift+Tab` — cycle backward. `Enter` / `Space` — activate focused button (deep link or close). |
| **Data requirements** | Panel DOM elements must exist and contain focusable buttons. |
| **Transitions** | → `canvas.idle` (Escape or deep-link navigation closes panel) · → `canvas.node-selected` / `canvas.edge-selected` (user clicks canvas, re-establishing canvas-level selection) |
| **Error recovery** | If panel DOM is unexpectedly empty (e.g., snapshot removed the selected node mid-focus): close panel, → `canvas.idle`. |

---

## 3. Layout & Animation States

These states describe the graph's visual motion and layout computation. They are **concurrent** with lifecycle states (occur within `canvas.idle` or its sub-states).

---

### State: `canvas.layout-stable`

The force simulation has converged and node positions are final. No layout recomputation is pending.

| Field | Value |
|-------|-------|
| **ID** | `canvas.layout-stable` |
| **Entry conditions** | `_computeLayout()` completes its 8 force-relaxation iterations and sets `_layoutDirty = false`. No pending canvas resize. No pending node set change. |
| **Exit conditions** | New snapshot changes node set → `_layoutDirty = true`. Canvas resized → `_layoutDirty = true`. Internals toggle changes → `_layoutDirty = true`. |
| **Visual** | No visual change — nodes are at their computed positions. This is the steady state. Metrics updates from 1 Hz snapshots change edge colors/thickness/pulse but do not move nodes. |
| **Canvas commands** | Standard render pipeline. No position interpolation. |
| **Keyboard** | Standard keyboard shortcuts active. |
| **Data requirements** | `_layoutDirty === false`. Valid node positions in `this._nodes`. |
| **Transitions** | → `canvas.snapshot-transitioning` (node set changes) · → `canvas.animating-layout` (resize event) |
| **Error recovery** | If a render reveals NaN positions (corruption): set `_layoutDirty = true`, force recompute on next frame. |

---

### State: `canvas.pulse-animating`

Non-healthy edges exist, and the RAF loop is running continuously to animate their opacity pulse.

| Field | Value |
|-------|-------|
| **ID** | `canvas.pulse-animating` |
| **Entry conditions** | `_hasPulsingEdges()` returns true — at least one edge has `health !== 'healthy'`. The RAF loop continues via `_scheduleRender()` at the end of each frame. |
| **Exit conditions** | All edges return to `health === 'healthy'` → `_hasPulsingEdges()` returns false → RAF loop stops after current frame. Tab deactivated → `_active = false` stops RAF. |
| **Visual** | Degraded edges: opacity oscillates 0.6–1.0 over 2 s period (`sin(t * PI * 2)` at `performance.now() % 2000`). Thickness 1.5x normal. Critical edges: opacity oscillates 0.4–1.0 over 1 s period. Thickness 2x normal. Red canvas glow (`shadowColor = --status-failed, shadowBlur = 8`). Alert badge: `!` indicator at top-right of affected node circles. |
| **Canvas commands** | Per non-healthy edge: `const period = health === 'critical' ? 1000 : 2000; const minAlpha = health === 'critical' ? 0.4 : 0.6; const t = (performance.now() % period) / period; ctx.globalAlpha = minAlpha + (1 - minAlpha) * (0.5 + 0.5 * Math.sin(t * PI * 2));`. Critical: `ctx.shadowColor = healthColor; ctx.shadowBlur = 8;`. After: `ctx.shadowBlur = 0;`. |
| **Keyboard** | Standard shortcuts active. Pulse animation does not block interaction. |
| **Data requirements** | At least one edge with `health !== 'healthy'`. `performance.now()` for animation timing. |
| **Transitions** | → (RAF stops) when all edges healthy · → `canvas.degraded-30fps` (if frame budget consistently exceeded by pulse overhead) |
| **Error recovery** | If `performance.now()` returns unexpected values: fall back to static opacity (no pulse). If too many edges pulsing causes jank: performance monitor triggers degradation. |

---

### State: `canvas.collapsed`

Node count exceeds `_MAX_NODES` (30). Low-volume nodes have been collapsed into an "Other" aggregate bucket.

| Field | Value |
|-------|-------|
| **ID** | `canvas.collapsed` |
| **Entry conditions** | `_onSnapshot()` calls `_collapseIfNeeded()` and the result has an `_other` node. Node count in snapshot exceeds `_MAX_NODES`. |
| **Exit conditions** | Subsequent snapshot reduces node count below `_MAX_NODES` → collapse removed, all nodes render individually. |
| **Visual** | Top N−2 dependencies render as individual nodes (sorted by volume, descending). An "Other (K)" node appears on the ring, where K is the collapsed count. "Other" node: dashed border, `--text-muted` fill, label "Other (K)". Its radius = `clamp(16, 16 + sqrt(sumVolume) * 2, 48)`. Its edge health = worst health among collapsed. A small "+ K more" label below the node. Hidden edges (beyond `_MAX_VISIBLE_EDGES` = 50): a text indicator "N hidden edges" drawn near the bottom of the canvas in `--text-muted` / `--text-xs`. |
| **Canvas commands** | "Other" node drawn with `ctx.setLineDash([3, 3])` border. Standard `_drawNode()` otherwise. Hidden edge indicator: `ctx.fillText()` at bottom center. |
| **Keyboard** | `Tab` navigates to "Other" node. `Enter` on "Other" opens detail panel listing all collapsed dependencies. |
| **Data requirements** | `_collapseIfNeeded()` output: collapsed node IDs, merged edges, aggregate volume. |
| **Transitions** | → (collapsed removed) when node count drops below threshold · → `canvas.node-selected` (user clicks "Other" node — detail panel shows collapsed list) |
| **Error recovery** | If collapse logic produces inconsistent edges (e.g., edge to non-existent node): filter out orphaned edges before render. |

---

## 4. Performance Degradation States

Degradation states are **mutually exclusive** and represent tiered performance fallbacks. They are concurrent with lifecycle states.

---

### State: `canvas.degraded-30fps`

Frame render time consistently exceeds 16 ms. The rendering pipeline reduces fidelity to maintain usability.

| Field | Value |
|-------|-------|
| **ID** | `canvas.degraded-30fps` |
| **Entry conditions** | Moving average of last 10 frame times exceeds 16 ms (measured via `performance.now()` delta in render loop). Trigger: 5 consecutive frames above budget. |
| **Exit conditions** | Moving average of last 10 frame times drops below 12 ms → return to full 60 fps rendering. Tab deactivated → degradation state reset. |
| **Visual** | Reduced fidelity: (1) Edge bezier curves replaced with straight lines (skip `quadraticCurveTo`, use `lineTo`). (2) Canvas shadow effects disabled (`shadowBlur = 0` always). (3) Arrowheads simplified (single triangle, no fill). (4) Pulse animation period doubled (2 s → 4 s for degraded, 1 s → 2 s for critical). (5) Label rendering skipped for non-hovered/non-selected nodes. (6) Small indicator in toolbar: "30fps" badge in `--text-muted` / `--text-xs`. |
| **Canvas commands** | `ctx.shadowBlur = 0` unconditionally. Edges: `ctx.lineTo(to.x, to.y)` instead of `ctx.quadraticCurveTo(...)`. Labels: only for hovered/selected nodes. |
| **Keyboard** | All shortcuts remain active. |
| **Data requirements** | `this._frameTimes[]` — circular buffer of last 10 frame durations. `this._degradationTier = 1`. |
| **Transitions** | → (full 60 fps) when frame times recover · → `canvas.degraded-static` (frame times exceed 33 ms consistently — budget for 30 fps also blown) |
| **Error recovery** | If frame time measurement is unreliable (e.g., `performance.now()` jitter): use conservative thresholds. Never degrade below static tier. |

---

### State: `canvas.degraded-static`

Frame render time exceeds 33 ms even at reduced fidelity. The graph renders as a static image — no animation, no continuous RAF loop.

| Field | Value |
|-------|-------|
| **ID** | `canvas.degraded-static` |
| **Entry conditions** | While in `canvas.degraded-30fps`, moving average of last 10 frame times exceeds 33 ms. 5 consecutive frames above 30 fps budget. |
| **Exit conditions** | Tab deactivated and re-activated → degradation state reset, fresh measurement. Manual reset: browser tab becomes foreground after background throttling clears. |
| **Visual** | Minimal rendering: (1) All animation disabled — no pulse, no opacity oscillation. Non-healthy edges rendered with static distinguishing color (no glow). (2) Edge labels completely removed. (3) Node labels only for FLT center. (4) Render only on snapshot update or user interaction — no continuous RAF loop. (5) Toolbar indicator: "Static" badge in `--status-cancelled` / `--text-xs`. (6) Tooltip still works (DOM-based, not canvas-dependent). (7) Detail panel still works (DOM-based). |
| **Canvas commands** | Single render call per snapshot or interaction. No `_scheduleRender()` chaining. `ctx.globalAlpha = 1.0` always (no animation). Edges as straight lines, no shadow, no arrowheads. |
| **Keyboard** | All shortcuts remain active. Keyboard navigation may feel less responsive (no hover highlights during static mode — cursor movements not tracked). |
| **Data requirements** | `this._degradationTier = 2`. Same data as `canvas.idle` but rendered with minimal fidelity. |
| **Transitions** | → `canvas.degraded-30fps` (tab re-activated — fresh performance assessment) · → `canvas.idle` (if fresh assessment shows frame times < 12 ms) |
| **Error recovery** | If the canvas cannot render even a static frame (hard crash): transition to `canvas.error` with message "Rendering performance too low for this graph size. Try closing other tabs." |

---

## 5. Data Freshness States

These are **concurrent overlay states** that apply on top of the current lifecycle/interaction state.

---

### State: `canvas.stale`

No snapshot received for more than 3 seconds. The last known data is displayed with a staleness indicator.

| Field | Value |
|-------|-------|
| **ID** | `canvas.stale` |
| **Entry conditions** | `performance.now() - this._lastSnapshotTime > 3000`. Checked via a periodic timer (every 1 s) or on each RAF frame. |
| **Exit conditions** | New snapshot arrives → `_lastSnapshotTime` updated → staleness clears. SignalR disconnects → `canvas.error` (staleness superseded by error). |
| **Visual** | Existing graph remains fully visible and interactive. Overlay: semi-transparent amber bar at top of canvas area (below toolbar): "Data may be stale — last update {N}s ago" in `--status-cancelled` / `--text-xs`. The bar uses `position: absolute; top: 0;` within the canvas wrapper. After 10 s of staleness: bar text changes to "No data received for {N}s — backend may have stopped". Node pulse animations continue if present (they are driven by `performance.now()`, not snapshot cadence). |
| **Canvas commands** | Normal render pipeline unchanged. Staleness indicator is DOM-based (not drawn on canvas) for click-through transparency. |
| **Keyboard** | All shortcuts remain active. Staleness is informational only. |
| **Data requirements** | `this._lastSnapshotTime` (set on each `_onSnapshot()` call). Timer or RAF check. |
| **Transitions** | → (staleness clears) on new snapshot · → `canvas.error` (SignalR disconnects — staleness escalates) |
| **Error recovery** | If the timer fires but `_lastSnapshotTime` is 0 (never set): ignore — this means we are in `canvas.empty` or `canvas.loading`, not stale. |

---

### State: `canvas.internals-visible`

The Internals toggle is ON, showing the `filesystem` dependency node and its edge.

| Field | Value |
|-------|-------|
| **ID** | `canvas.internals-visible` |
| **Entry conditions** | User clicks "Internals" toggle button → `this._showInternals = true`. |
| **Exit conditions** | User clicks "Internals" toggle again → `this._showInternals = false`. Tab deactivated (state persists in memory for re-activate). |
| **Visual** | `filesystem` node appears on ring 1. Its edge renders with the same health-color/thickness encoding as other edges. Layout recomputes to include it (ring redistributes angles). Toggle button shows active state: `--accent-dim` background, `--accent` text, `--accent` border. `aria-pressed="true"`. Navigable node list now includes `filesystem` for Tab cycling. |
| **Canvas commands** | `_renderGraph()` no longer skips `id === 'filesystem'` in edge and node loops. `_computeLayout()` includes `filesystem` in ring-1 node list. |
| **Keyboard** | Toggle button itself is a DOM button, standard keyboard accessible. `Tab` in canvas now cycles through `filesystem` node. |
| **Data requirements** | `this._showInternals = true`. Snapshot must contain a `filesystem` node (if not present, toggle has no visual effect on graph). |
| **Transitions** | → `canvas.internals-visible` = false (toggle off) — triggers layout recompute, filesystem node disappears |
| **Error recovery** | If `filesystem` node is missing from snapshot but toggle is ON: no error — graph simply shows no filesystem node. Toggle remains active for when data arrives. If filesystem has `critical` health and is hidden: alerts for filesystem still appear as toasts (only graph rendering is suppressed, not alert processing). |

---

## 6. State Transition Diagram

```
                           ┌──────────────────┐
                           │   canvas.empty    │
                           │ (no data / no     │
                           │  dep nodes)       │
                           └────────┬──────────┘
                                    │ first non-empty snapshot
                                    ▼
                           ┌──────────────────┐
         ┌────────────────►│canvas.animating-  │
         │ (resize/toggle) │    layout         │
         │                 └────────┬──────────┘
         │                          │ layout complete
         │                          ▼
         │                 ┌──────────────────┐
         │     ┌──────────►│   canvas.idle     │◄───────────────┐
         │     │           │ (steady state)    │                │
         │     │           └──┬──┬──┬──┬──┬────┘                │
         │     │              │  │  │  │  │                     │
         │     │  mouse node  │  │  │  │  │  Tab key            │
         │     │              ▼  │  │  │  ▼                     │
         │     │  ┌───────────┐  │  │  │  ┌──────────────┐     │
         │     │  │canvas.node│  │  │  │  │canvas.node-  │     │
         │     │  │ -hovered  │  │  │  │  │keyboard-     │     │
         │     │  └─────┬─────┘  │  │  │  │focused       │     │
         │     │   click│        │  │  │  └──────┬───────┘     │
         │     │        ▼        │  │  │   Enter │             │
         │     │  ┌───────────┐  │  │  │         ▼             │
         │  Esc│  │canvas.node│  │  │  │  ┌───────────┐       │
         │     │  │ -selected │──┘  │  └─►│  (same)   │       │
         │     │  └───────────┘     │     └───────────┘       │
         │     │                    │                          │
         │     │  mouse edge        │  click edge              │
         │     │        ┌───────────┘                          │
         │     │        ▼                                      │
         │     │  ┌───────────┐         ┌──────────────┐      │
         │     │  │canvas.edge│────────►│canvas.edge-  │      │
         │     │  │ -hovered  │  click  │  selected    │──────┘
         │     │  └───────────┘         └──────────────┘ Esc
         │     │
         │     │  node set change
         │     │        ┌──────────────────┐
         │     └────────│canvas.snapshot-  │
         │              │  transitioning   │
         │              └──────────────────┘
         │
         │  SignalR disconnect (from any state)
         │              ┌──────────────────┐
         └──────────────│  canvas.error    │
                        └──────────────────┘

  Concurrent states (can overlay any data-present state):
  ┌────────────────────────┐  ┌──────────────────────┐
  │ canvas.pulse-animating │  │   canvas.stale       │
  │ (non-healthy edges)    │  │  (>3s no snapshot)   │
  └────────────────────────┘  └──────────────────────┘
  ┌────────────────────────┐  ┌──────────────────────┐
  │ canvas.degraded-30fps  │  │ canvas.internals-    │
  │ (frame budget blown)   │  │   visible            │
  └────────────────────────┘  └──────────────────────┘
  ┌────────────────────────┐  ┌──────────────────────┐
  │ canvas.degraded-static │  │ canvas.collapsed     │
  │ (severe perf issue)    │  │ (>30 nodes)          │
  └────────────────────────┘  └──────────────────────┘
```

---

## 7. Compound State Rules

Multiple states can be active simultaneously. These rules define valid combinations:

### 7.1 Lifecycle State (exactly one)

At any time, the canvas is in exactly one of:
- `canvas.empty`
- `canvas.loading`
- `canvas.idle`
- `canvas.error`
- `canvas.snapshot-transitioning`
- `canvas.animating-layout`

### 7.2 Interaction State (at most one, only in data-present lifecycle states)

Active only when lifecycle is `canvas.idle`:
- `canvas.node-hovered`
- `canvas.edge-hovered`
- `canvas.node-selected`
- `canvas.edge-selected`
- `canvas.node-keyboard-focused`
- `canvas.detail-panel-focused`

### 7.3 Concurrent Overlay States (any combination, independent)

These can be active alongside any data-present lifecycle + interaction state:
- `canvas.pulse-animating` — active when non-healthy edges exist
- `canvas.stale` — active when no snapshot for >3 s
- `canvas.internals-visible` — active when Internals toggle is ON
- `canvas.collapsed` — active when node count exceeds _MAX_NODES
- `canvas.layout-stable` — active when `_layoutDirty === false`

### 7.4 Degradation Tier (at most one, independent)

- (none) — full 60 fps
- `canvas.degraded-30fps` — tier 1
- `canvas.degraded-static` — tier 2

### 7.5 Valid Compound Examples

| Lifecycle | Interaction | Overlay(s) | Degradation | Description |
|-----------|------------|------------|-------------|-------------|
| `idle` | `node-selected` | `pulse-animating`, `layout-stable` | (none) | Normal: user inspecting a node while critical edges pulse |
| `idle` | `edge-hovered` | `stale`, `pulse-animating` | `degraded-30fps` | Stale data, reduced fidelity, user hovering an edge |
| `idle` | (none) | `collapsed`, `internals-visible`, `layout-stable` | (none) | Large graph with filesystem visible, no interaction |
| `error` | (none) | (none) | (none) | Disconnected — only error overlay visible |
| `idle` | `node-keyboard-focused` | `pulse-animating` | (none) | Keyboard user browsing nodes during health incident |

### 7.6 Invalid Combinations

- `canvas.empty` + any interaction state → **INVALID** (no nodes to interact with)
- `canvas.error` + any interaction state → **INVALID** (canvas hidden)
- `canvas.node-selected` + `canvas.edge-selected` → **INVALID** (mutually exclusive)
- `canvas.degraded-30fps` + `canvas.degraded-static` → **INVALID** (tiers are exclusive)

---

## 8. Full Event × State Matrix

Every event that the canvas can receive, mapped against every state. Cell values:
- **→ STATE** = transition to that state
- **update** = state unchanged but visual/data update
- **no-op** = event is ignored
- **—** = event cannot occur in this state (structurally impossible)

### 8.1 Lifecycle Events

| Event | `empty` | `loading` | `idle` | `error` | `snapshot-transitioning` | `animating-layout` |
|-------|---------|-----------|--------|---------|--------------------------|---------------------|
| Snapshot (with deps) | → `animating-layout` | → `animating-layout` | update (metrics) or → `snapshot-transitioning` (node set change) | → `animating-layout` | update (queued, applied after transition) | update (re-run layout with latest data) |
| Snapshot (no deps) | no-op (stay empty) | → `empty` | → `empty` | → `empty` | → `empty` | → `empty` |
| Snapshot (malformed) | no-op | no-op | no-op | no-op | no-op | no-op |
| Alert message | process toast | process toast | process toast | no-op (no toast when disconnected) | process toast | process toast |
| SignalR disconnect | → `error` | → `error` | → `error` | no-op (already error) | → `error` | → `error` |
| SignalR reconnect | → `loading` | no-op | — | → `loading` | — | — |
| activate() | enter `empty` | — | — | — | — | — |
| deactivate() | stop all | stop all | stop RAF, clear listeners | stop all | stop all | stop all |
| resize | no-op | no-op | recompute layout, re-render | no-op | re-run layout | re-run layout |
| destroy() | release ctx, clear state | same | same | same | same | same |

### 8.2 Mouse Events (only meaningful in `canvas.idle` or interaction sub-states)

| Event | `idle` | `node-hovered` | `edge-hovered` | `node-selected` | `edge-selected` | `keyboard-focused` |
|-------|--------|----------------|----------------|-----------------|-----------------|---------------------|
| mousemove → node hit | → `node-hovered` | update (same node) or → `node-hovered` (different node) | → `node-hovered` | update tooltip | update tooltip | → `node-hovered` (override keyboard focus) |
| mousemove → edge hit | → `edge-hovered` | → `edge-hovered` | update (same edge) or → `edge-hovered` (different edge) | → `edge-hovered` | update tooltip | → `edge-hovered` |
| mousemove → empty | no-op | → `idle` | → `idle` | no-op (selection persists) | no-op (selection persists) | no-op |
| click → node hit | → `node-selected` | → `node-selected` | → `node-selected` | → `node-selected` (same or different node) | → `node-selected` | → `node-selected` |
| click → edge hit | → `edge-selected` | → `edge-selected` | → `edge-selected` | → `edge-selected` | → `edge-selected` (same or different edge) | → `edge-selected` |
| click → empty | no-op | → `idle` | → `idle` | → `idle` (close detail) | → `idle` (close detail) | → `idle` |
| mouseleave canvas | no-op | → `idle` (clear hover) | → `idle` (clear hover) | no-op | no-op | no-op |

### 8.3 Keyboard Events (only when tab is active)

| Event | `empty` | `idle` | `node-hovered` | `node-selected` | `edge-selected` | `keyboard-focused` | `detail-panel-focused` |
|-------|---------|--------|----------------|-----------------|-----------------|---------------------|------------------------|
| `Tab` | no-op | → `keyboard-focused` (first node) | → `keyboard-focused` (next node) | → `keyboard-focused` (next node) | → `detail-panel-focused` (focus into panel) | → `keyboard-focused` (next node) | cycle panel buttons |
| `Shift+Tab` | no-op | → `keyboard-focused` (last node) | → `keyboard-focused` (prev node) | → `keyboard-focused` (prev node) | → `detail-panel-focused` | → `keyboard-focused` (prev node) | cycle panel buttons backward |
| `Enter` | no-op | no-op | no-op | no-op (panel already open) | no-op (panel already open) | → `node-selected` (open detail) | activate focused button |
| `Escape` | no-op | no-op | no-op | → `idle` (close detail, deselect) | → `idle` (close detail, deselect) | → `idle` (clear focus) | → `idle` (close detail, deselect) |

### 8.4 Data & Performance Events

| Event | Any data-present state |
|-------|------------------------|
| Snapshot arrives (metrics only, no node change) | Update `_edges`, re-render. Refresh detail panel if open. Reset `_lastSnapshotTime`. Clear stale indicator if present. |
| Snapshot arrives (node set change) | → `canvas.snapshot-transitioning`. Diff nodes, add/remove, recompute layout. If selected node removed, close detail. |
| Staleness timer fires (>3 s) | Enable `canvas.stale` overlay. Show amber bar. |
| Staleness clears (new snapshot) | Remove `canvas.stale` overlay. Hide amber bar. |
| Frame time > 16 ms (5 consecutive) | → `canvas.degraded-30fps`. Reduce fidelity. |
| Frame time < 12 ms (10 consecutive, in degraded-30fps) | → (full 60 fps). Restore fidelity. |
| Frame time > 33 ms (5 consecutive, in degraded-30fps) | → `canvas.degraded-static`. Minimal rendering. |
| Internals toggle ON | Set `_showInternals = true`. → `canvas.internals-visible`. Recompute layout. |
| Internals toggle OFF | Set `_showInternals = false`. Remove `canvas.internals-visible`. Recompute layout. If `filesystem` was selected, close detail. |
| Node count > _MAX_NODES | → `canvas.collapsed`. Run `_collapseIfNeeded()`. Create "Other" aggregate. |
| Node count ≤ _MAX_NODES | Remove `canvas.collapsed`. Render all nodes individually. |
