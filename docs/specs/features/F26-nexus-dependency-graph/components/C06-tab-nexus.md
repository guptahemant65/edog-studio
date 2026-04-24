# C06 — Nexus Frontend Tab

> **Component:** `src/frontend/js/tab-nexus.js` (new) + `src/frontend/css/tab-nexus.css` (new) + HTML modifications
> **Phase:** P1 — Nexus Core
> **Owner:** Pixel
> **Priority:** P1-MVP
> **Dependencies:** Backend `nexus` topic (C01–C04), `signalr-manager.js` topic bus, `runtime-view.js` tab lifecycle, `main.js` bootstrap
> **Design tokens:** `variables.css` — `--surface`, `--surface-2`, `--surface-3`, `--text`, `--text-dim`, `--text-muted`, `--accent`, `--status-succeeded`, `--status-failed`, `--status-cancelled`, `--status-pending`, `--border`, `--border-bright`, `--radius-*`, `--space-*`, `--text-*`, `--font-mono`

---

## 1. Overview

The Nexus tab is a real-time dependency topology view in the EDOG Studio Runtime View. It renders backend-aggregated `nexus` topic snapshots as an interactive graph: FLT at the center, dependency nodes around it, edges encoding health/throughput/latency. Click any node or edge to open a detail panel with p50/p95/p99, error rates, retry counts, and deep links to Spark/HTTP/Retries tabs.

**Architectural constraint:** Backend `EdogNexusAggregator` publishes condensed 1 Hz snapshots to the `nexus` topic. The frontend does NOT derive the graph from raw `http`/`spark`/`token` topics — it consumes the pre-aggregated snapshot only. This aligns with the rejected "pure client-side graph derivation" pattern from P0 research (`docs/specs/features/F26-nexus-dependency-graph/research/p0-foundation.md:62-63`).

**Rendering technology:** `<canvas>` 2D context for graph rendering (nodes, edges, labels). No external graph libraries (d3, cytoscape). Canvas is chosen over SVG for performance under high edge counts and animation.

**Module pattern:** Class-based `NexusTab` matching existing `HttpPipelineTab` and `SparkSessionsTab` — `constructor(containerEl, signalr)`, `activate()`, `deactivate()`, `destroy()`.

---

## 2. Scenarios

### S01 — Tab Module Structure

**ID:** `C06-S01`
**Description:** `NexusTab` class follows the established tab pattern: constructor receives container element and SignalR manager, builds DOM imperatively, exposes `activate()`/`deactivate()` lifecycle methods.
**Priority:** P1-MVP

**Trigger:** `main.js` instantiates `NexusTab` during bootstrap, passing the container element and `signalr` instance. `RuntimeView.registerTab('nexus', nexusTab)` wires it into the tab lifecycle.

**Expected behavior:**
- Constructor builds all DOM (canvas, toolbar, detail panel, empty state) into `containerEl`.
- No SignalR subscriptions or global listeners until `activate()`.
- `deactivate()` fully tears down subscriptions and global listeners.
- `destroy()` releases canvas context and clears internal state for GC.

**Technical mechanism:**

```javascript
class NexusTab {
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // State
    this._snapshot = null;          // latest NexusSnapshot
    this._nodes = new Map();        // nodeId -> NodeState (position, size, etc.)
    this._edges = [];               // EdgeState[] (from, to, health, metrics)
    this._selectedNode = null;      // nodeId or null
    this._selectedEdge = null;      // edgeIndex or null
    this._hoveredNode = null;
    this._hoveredEdge = null;
    this._active = false;
    this._showInternals = false;    // filesystem hidden by default
    this._alerts = [];              // active anomaly alerts

    // Canvas
    this._canvas = null;
    this._ctx = null;
    this._dpr = window.devicePixelRatio || 1;

    // Layout
    this._layoutSeed = 42;         // deterministic seed
    this._layoutDirty = true;

    // Perf
    this._renderPending = false;
    this._MAX_VISIBLE_EDGES = 50;
    this._MAX_NODES = 30;

    // DOM cache
    this._els = {};

    // Bound handlers
    this._onSnapshot = this._onSnapshot.bind(this);
    this._onCanvasClick = this._onCanvasClick.bind(this);
    this._onCanvasMove = this._onCanvasMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onResize = this._onResize.bind(this);

    this._buildDOM();
  }
}
```

**Source path:** `src/frontend/js/tab-nexus.js:1–50` (constructor)
**Edge cases:**
- `containerEl` may be hidden at construct time (tab not active). Canvas sizing must defer to `activate()`.
- `signalr` may be null in disconnected phase; guard all subscription calls.
**Interactions:** `runtime-view.js:122-128` (`registerTab`), `main.js:205-215` (registration block).
**Revert:** Remove `NexusTab` class; unregister from `RuntimeView`.

---

### S02 — Topic Subscription Lifecycle

**ID:** `C06-S02`
**Description:** Subscribe to `nexus` topic on activate, unsubscribe on deactivate. Matches the `http`/`spark` subscription pattern exactly.
**Priority:** P1-MVP

**Trigger:** `RuntimeView.switchTab('nexus')` calls `activate()`. Switching away calls `deactivate()`.

**Expected behavior:**
- `activate()` calls `signalr.on('nexus', this._onSnapshot)` then `signalr.subscribeTopic('nexus')`.
- `deactivate()` calls `signalr.off('nexus', this._onSnapshot)` then `signalr.unsubscribeTopic('nexus')`.
- Global keyboard and resize listeners are added on activate, removed on deactivate.
- After activate, the first snapshot from the backend hydrates the graph (snapshot + live semantics from `SubscribeToTopic` channel).

**Technical mechanism:**

```javascript
activate() {
  this._active = true;
  this._resizeCanvas();
  if (this._signalr) {
    this._signalr.on('nexus', this._onSnapshot);
    this._signalr.subscribeTopic('nexus');
  }
  document.addEventListener('keydown', this._onKeyDown);
  window.addEventListener('resize', this._onResize);
  this._scheduleRender();
}

deactivate() {
  this._active = false;
  document.removeEventListener('keydown', this._onKeyDown);
  window.removeEventListener('resize', this._onResize);
  if (this._signalr) {
    this._signalr.off('nexus', this._onSnapshot);
    this._signalr.unsubscribeTopic('nexus');
  }
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (activate/deactivate methods)
**Edge cases:**
- Double `activate()` without intervening `deactivate()` must not double-subscribe. Guard with `this._active` flag (already true → skip).
- SignalR reconnect triggers `_resubscribeAll()` in `signalr-manager.js:147-158` which re-streams active topics. `_onSnapshot` handler must tolerate re-delivery of the initial snapshot.
**Interactions:** `signalr-manager.js:170-173` (on/off), `signalr-manager.js:185-193` (subscribeTopic), `runtime-view.js:130-170` (switchTab lifecycle).

---

### S03 — Graph Rendering: Empty State

**ID:** `C06-S03`
**Description:** When no snapshot has been received (tab activated before backend starts publishing), show a purposeful empty state.
**Priority:** P1-MVP

**Trigger:** `activate()` called, `this._snapshot` is null.

**Expected behavior:**
- Canvas is hidden. An overlay `div.nexus-empty` is shown.
- Content: Graph SVG icon (inline), title "No dependency data yet", subtitle "Nexus will populate once FLT begins making outbound calls."
- No spinner (data arrives via push, not poll).

**Technical mechanism:**

```javascript
_buildEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'nexus-empty';
  empty.innerHTML =
    '<svg class="nexus-empty-icon" viewBox="0 0 48 48" width="48" height="48" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="24" cy="24" r="6"/>' +
      '<circle cx="10" cy="10" r="4"/><line x1="18" y1="18" x2="14" y2="14"/>' +
      '<circle cx="38" cy="10" r="4"/><line x1="30" y1="18" x2="34" y2="14"/>' +
      '<circle cx="24" cy="42" r="4"/><line x1="24" y1="30" x2="24" y2="38"/>' +
    '</svg>' +
    '<div class="nexus-empty-title">No dependency data yet</div>' +
    '<div class="nexus-empty-desc">' +
      'Nexus will populate once FLT begins making outbound calls.' +
    '</div>';
  return empty;
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_buildEmptyState)
**Edge cases:**
- If backend sends an empty snapshot (`nodes: [], edges: []`), treat it the same as no snapshot — show empty state.
- Transition: once a non-empty snapshot arrives, hide empty state with `classList.add('hidden')` and show canvas.
**Interactions:** Matches pattern from `tab-http.js:786-789` (empty state toggle).

---

### S04 — Graph Rendering: Healthy Topology

**ID:** `C06-S04`
**Description:** When snapshot contains nodes and edges with `health: "healthy"`, render a calm, readable graph. Green edges, proportional node sizes, throughput-weighted edge thickness.
**Priority:** P1-MVP

**Trigger:** `_onSnapshot(envelope)` receives a snapshot with `data.edges[].health === 'healthy'`.

**Expected behavior:**
- FLT center node: fixed at canvas center, distinctive styling (larger, accent-colored ring).
- Dependency nodes: positioned on concentric rings based on kind (core ring 0, dependency ring 1).
- Edges: drawn as quadratic bezier curves from FLT to each dependency.
- Edge color: `--status-succeeded` (green) for healthy.
- Edge thickness: `Math.max(1, Math.min(6, edge.throughputPerMin / 10))` — proportional to throughput, clamped 1–6px.
- Node size: `Math.max(16, Math.min(48, 16 + Math.sqrt(node.volume) * 2))` — proportional to volume, clamped 16–48px radius.
- Labels: dependency name centered below node, `--text-dim`, `--text-xs` monospace.

**Technical mechanism:**

```javascript
_renderGraph() {
  const ctx = this._ctx;
  const w = this._canvas.width / this._dpr;
  const h = this._canvas.height / this._dpr;

  ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  ctx.save();
  ctx.scale(this._dpr, this._dpr);

  // Draw edges first (behind nodes)
  for (const edge of this._edges) {
    if (!this._showInternals && edge.toId === 'filesystem') continue;
    this._drawEdge(ctx, edge);
  }

  // Draw nodes on top
  for (const [id, node] of this._nodes) {
    if (!this._showInternals && id === 'filesystem') continue;
    this._drawNode(ctx, id, node);
  }

  ctx.restore();
}

_drawEdge(ctx, edge) {
  const from = this._nodes.get(edge.fromId);
  const to = this._nodes.get(edge.toId);
  if (!from || !to) return;

  const thickness = Math.max(1, Math.min(6, edge.throughputPerMin / 10));
  ctx.beginPath();
  ctx.strokeStyle = this._healthColor(edge.health);
  ctx.lineWidth = thickness;
  ctx.globalAlpha = edge === this._hoveredEdge ? 1.0 : 0.7;

  // Quadratic bezier with control point offset for visual separation
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const offset = 20 * edge._curveDir;  // alternate curve direction
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(mx + offset, my + offset, to.x, to.y);
  ctx.stroke();
  ctx.globalAlpha = 1.0;
}

_healthColor(health) {
  // Read CSS custom properties at render time for theme support
  const s = getComputedStyle(this._container);
  switch (health) {
    case 'healthy':  return s.getPropertyValue('--status-succeeded').trim();
    case 'degraded': return s.getPropertyValue('--status-cancelled').trim();
    case 'critical': return s.getPropertyValue('--status-failed').trim();
    default:         return s.getPropertyValue('--text-muted').trim();
  }
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_renderGraph, _drawEdge, _drawNode, _healthColor)
**Edge cases:**
- Canvas not yet sized (width=0): skip render, mark `_layoutDirty = true` for next `activate()`.
- Single node (FLT only, no dependencies): render FLT center node alone with "No dependencies observed" label.
**Interactions:** Reads CSS variables from `variables.css` for theme-aware colors.

---

### S05 — Graph Rendering: Degraded/Critical State

**ID:** `C06-S05`
**Description:** When edges have `health: "degraded"` or `health: "critical"`, apply visual urgency encoding: amber/red colors, pulse animation, and triage ranking (worst-first visual prominence).
**Priority:** P1-MVP

**Trigger:** Snapshot contains edges where `edge.health !== 'healthy'`.

**Expected behavior:**
- **Degraded edge:** amber (`--status-cancelled`), 1.5x normal thickness, slow pulse (opacity oscillation 0.6–1.0, 2s cycle).
- **Critical edge:** red (`--status-failed`), 2x normal thickness, fast pulse (opacity 0.4–1.0, 1s cycle), red glow effect (shadow on canvas).
- **Triage ranking:** Critical edges drawn last (on top), with higher z-order. Critical nodes get a subtle red ring.
- **Alert badge:** nodes connected to critical edges show a small `!` indicator at top-right of node circle.

**Technical mechanism:**

```javascript
_drawEdge(ctx, edge) {
  // ... base drawing from S04 ...

  // Pulse animation for non-healthy
  if (edge.health === 'degraded' || edge.health === 'critical') {
    const period = edge.health === 'critical' ? 1000 : 2000;
    const minAlpha = edge.health === 'critical' ? 0.4 : 0.6;
    const t = (performance.now() % period) / period;
    const pulse = minAlpha + (1 - minAlpha) * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
    ctx.globalAlpha = pulse;

    // Critical glow
    if (edge.health === 'critical') {
      ctx.shadowColor = this._healthColor('critical');
      ctx.shadowBlur = 8;
    }
  }

  // ... draw path ...
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1.0;
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_drawEdge pulse branch)
**Edge cases:**
- Multiple critical edges may overlap; draw order must be: healthy → degraded → critical.
- When all edges return to healthy, pulse animation stops naturally (no explicit "stop pulse" needed — RAF loop just draws static).
**Interactions:** Triage ranking aligns with "hot edge first" pattern from P0 research (`p0-foundation.md:66-69`).

---

### S06 — Graph Layout: Hybrid Rings + Local Force + Deterministic Seed

**ID:** `C06-S06`
**Description:** Nodes are positioned using a hybrid layout: fixed concentric rings for service classes with bounded local force simulation to reduce overlap. Deterministic seed ensures identical snapshots produce identical layouts.
**Priority:** P1-MVP

**Trigger:** `_computeLayout()` called when snapshot changes or canvas resizes.

**Expected behavior:**
1. **Ring assignment:** FLT center node at canvas center (ring 0). All dependency nodes on ring 1 at radius = `min(canvasW, canvasH) * 0.35`.
2. **Initial angular placement:** Nodes distributed evenly around ring circumference, starting from angle derived from `_layoutSeed`. Angular order: alphabetical by `dependencyId` for determinism.
3. **Local force relaxation:** 5–10 iterations of repulsion-only force between ring-1 nodes to reduce label overlap. Nodes are constrained to stay on their ring (radial projection after each force step).
4. **Deterministic result:** Same node set + same seed = same positions. No random jitter.

**Technical mechanism:**

```javascript
_computeLayout() {
  const w = this._canvas.width / this._dpr;
  const h = this._canvas.height / this._dpr;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.35;

  // Place FLT center
  this._nodes.get('flt-local').x = cx;
  this._nodes.get('flt-local').y = cy;

  // Collect ring-1 nodes, sorted alphabetically for determinism
  const ring1 = [...this._nodes.keys()]
    .filter(id => id !== 'flt-local')
    .filter(id => this._showInternals || id !== 'filesystem')
    .sort();

  const n = ring1.length;
  if (n === 0) return;

  // Initial even distribution from seed angle
  const baseAngle = (this._layoutSeed * 137.508) % 360;  // golden angle
  for (let i = 0; i < n; i++) {
    const angle = (baseAngle + (360 / n) * i) * (Math.PI / 180);
    const node = this._nodes.get(ring1[i]);
    node.x = cx + radius * Math.cos(angle);
    node.y = cy + radius * Math.sin(angle);
  }

  // Local force relaxation (repulsion only, constrained to ring)
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < n; i++) {
      const a = this._nodes.get(ring1[i]);
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = this._nodes.get(ring1[j]);
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const repulsion = 800 / (dist * dist);
        fx += (dx / dist) * repulsion;
        fy += (dy / dist) * repulsion;
      }
      a.x += fx;
      a.y += fy;
      // Project back onto ring
      const dx = a.x - cx;
      const dy = a.y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      a.x = cx + (dx / d) * radius;
      a.y = cy + (dy / d) * radius;
    }
  }

  this._layoutDirty = false;
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_computeLayout)
**Edge cases:**
- 1 dependency node: placed at 12 o'clock position (no force needed).
- Canvas resize: re-run layout. Positions scale proportionally — same topology, new coordinates.
- Node added/removed between snapshots: full layout recompute (not incremental).
**Interactions:** Aligns with design spec §6.1 hybrid layout (`2026-04-24-nexus-design.md:163-168`).

---

### S07 — Node Rendering: FLT Center + Dependency Nodes

**ID:** `C06-S07`
**Description:** Render FLT as a distinctive center node and each dependency as a volume-proportional circle with label and health indicator.
**Priority:** P1-MVP

**Trigger:** `_renderGraph()` iterates `this._nodes`.

**Expected behavior:**
- **FLT node:** Filled circle, `--accent` border (2px), `--surface` fill. Fixed radius 28px. Label "FLT" centered inside. Subtle accent glow when hovered.
- **Dependency nodes:** Filled circle, border color from edge health (worst edge wins). Radius: `Math.max(16, Math.min(48, 16 + Math.sqrt(volume) * 2))`. Label below: dependency display name in `--text-dim`, `--font-mono`, `--text-xs`.
- **Display names:** `spark-gts` → "Spark (GTS)", `fabric-api` → "Fabric APIs", `platform-api` → "Platform APIs", `auth` → "Auth", `capacity` → "Capacity", `cache` → "Cache", `filesystem` → "File System", `unknown` → "Unknown".
- **Selected state:** 3px accent ring + detail panel opens.
- **Hovered state:** Cursor changes to pointer, node brightens (fill alpha 1.0 vs 0.85).

**Technical mechanism:**

```javascript
_drawNode(ctx, id, node) {
  const r = id === 'flt-local' ? 28 : node.radius;
  const isSelected = this._selectedNode === id;
  const isHovered = this._hoveredNode === id;

  // Fill
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
  ctx.fillStyle = this._getNodeFill(id, isHovered);
  ctx.globalAlpha = isHovered ? 1.0 : 0.85;
  ctx.fill();
  ctx.globalAlpha = 1.0;

  // Border
  ctx.strokeStyle = id === 'flt-local'
    ? this._css('--accent')
    : this._worstEdgeColor(id);
  ctx.lineWidth = isSelected ? 3 : (id === 'flt-local' ? 2 : 1.5);
  ctx.stroke();

  // Selection ring
  if (isSelected) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = this._css('--accent');
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Label
  const label = id === 'flt-local' ? 'FLT' : this._displayName(id);
  ctx.font = id === 'flt-local'
    ? 'bold 11px var(--font-mono)'
    : '10px var(--font-mono)';
  ctx.fillStyle = this._css(id === 'flt-local' ? '--text' : '--text-dim');
  ctx.textAlign = 'center';
  if (id === 'flt-local') {
    ctx.fillText(label, node.x, node.y + 4);
  } else {
    ctx.fillText(label, node.x, node.y + r + 14);
  }
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_drawNode, _displayName, _worstEdgeColor)
**Edge cases:**
- Label truncation: if display name > 14 chars, truncate with ellipsis (canvas `measureText`).
- Overlapping labels at small canvas sizes: acceptable degradation — labels may overlap but nodes remain clickable.
**Interactions:** Node click → S09 (detail panel). Node hover → cursor + tooltip.

---

### S08 — Edge Rendering: Health Colors, Throughput Thickness, Anomaly Animation

**ID:** `C06-S08`
**Description:** Edges encode three dimensions: health (color), throughput (thickness), and anomaly (pulse animation). Edge labels show p50 latency on hover.
**Priority:** P1-MVP

**Trigger:** `_renderGraph()` iterates `this._edges`.

**Expected behavior:**
- **Color mapping:** `healthy` → `--status-succeeded`, `degraded` → `--status-cancelled`, `critical` → `--status-failed`, `unknown` → `--text-muted`.
- **Thickness:** `clamp(1, throughputPerMin / 10, 6)` px. A zero-throughput edge renders at 1px with dashed style.
- **Anomaly pulse:** Non-healthy edges pulse opacity (see S05). Critical edges also get a canvas shadow glow.
- **Hover label:** When mouse is near an edge (within 8px hit zone), show a floating tooltip with: dependency name, p50/p95, error rate, throughput.
- **Arrow direction:** Small arrowhead at the dependency end (FLT → dependency direction).

**Technical mechanism:**

```javascript
_drawArrowhead(ctx, fromX, fromY, toX, toY, nodeRadius) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const tipX = toX - nodeRadius * Math.cos(angle);
  const tipY = toY - nodeRadius * Math.sin(angle);
  const size = 6;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - size * Math.cos(angle - 0.4),
    tipY - size * Math.sin(angle - 0.4)
  );
  ctx.lineTo(
    tipX - size * Math.cos(angle + 0.4),
    tipY - size * Math.sin(angle + 0.4)
  );
  ctx.closePath();
  ctx.fill();
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_drawEdge, _drawArrowhead, _edgeHitTest)
**Edge cases:**
- Zero-throughput edge (dependency exists but no traffic in window): dashed 1px line, `--text-muted` color.
- Self-loop (FLT → FLT): should not occur in data; if present, ignore.
- Overlapping edges to same node from different paths: each edge gets a unique `_curveDir` offset to visually separate.
**Interactions:** Edge click → S09 (detail panel with edge context). Edge hover → tooltip.

---

### S09 — Detail Panel: Click Node/Edge for Metrics + Deep Links

**ID:** `C06-S09`
**Description:** Clicking a node or edge opens a slide-in detail panel showing dependency metrics and deep-link buttons to related tabs.
**Priority:** P1-MVP

**Trigger:** Click on a canvas node or edge (hit-tested).

**Expected behavior:**
- Panel slides in from the right, 320px wide, over the canvas (not pushing layout).
- **Node detail:** Dependency name, health badge, volume count, then metrics table: p50, p95, p99, error rate, retry rate, throughput/min. Below: deep-link buttons.
- **Edge detail:** Same metrics as node but specific to the edge. Shows `baselineDelta` if > 1.0 ("3.0x above baseline").
- **Close:** Click `\u2715` button, press Escape, or click canvas background.
- **Deep link buttons:** "View in Spark" (if `spark-gts`), "View in HTTP Pipeline" (always), "View in Retries" (if retryRate > 0). Buttons styled as ghost buttons.

**Technical mechanism:**

```javascript
_buildDetailPanel() {
  const panel = document.createElement('div');
  panel.className = 'nexus-detail closed';

  const header = document.createElement('div');
  header.className = 'nexus-detail-header';
  header.innerHTML =
    '<span class="nexus-detail-title"></span>' +
    '<button class="nexus-detail-close" aria-label="Close detail panel">\u2715</button>';
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'nexus-detail-body';
  panel.appendChild(body);

  const links = document.createElement('div');
  links.className = 'nexus-detail-links';
  panel.appendChild(links);

  this._els.detail = panel;
  this._els.detailTitle = header.querySelector('.nexus-detail-title');
  this._els.detailBody = body;
  this._els.detailLinks = links;
  this._els.detailClose = header.querySelector('.nexus-detail-close');

  this._els.detailClose.addEventListener('click', () => this._closeDetail());

  return panel;
}

_openNodeDetail(nodeId) {
  this._selectedNode = nodeId;
  this._selectedEdge = null;
  const edge = this._edges.find(e => e.toId === nodeId);
  if (!edge) return;

  this._els.detailTitle.textContent = this._displayName(nodeId);
  this._els.detailBody.innerHTML = this._renderMetricsTable(edge);
  this._els.detailLinks.innerHTML = this._renderDeepLinks(nodeId, edge);
  this._els.detail.classList.remove('closed');
  this._scheduleRender();
}

_renderMetricsTable(edge) {
  const fmt = (ms) => ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  const pct = (r) => (r * 100).toFixed(1) + '%';
  return '<table class="nexus-metrics">' +
    '<tr><td class="nexus-metric-label">Health</td>' +
      '<td><span class="nexus-health-badge h-' + edge.health + '">' +
      edge.health + '</span></td></tr>' +
    '<tr><td class="nexus-metric-label">p50</td><td>' + fmt(edge.p50Ms) + '</td></tr>' +
    '<tr><td class="nexus-metric-label">p95</td><td>' + fmt(edge.p95Ms) + '</td></tr>' +
    '<tr><td class="nexus-metric-label">p99</td>' +
      '<td>' + fmt(edge.p99Ms || edge.p95Ms) + '</td></tr>' +
    '<tr><td class="nexus-metric-label">Error rate</td>' +
      '<td>' + pct(edge.errorRate) + '</td></tr>' +
    '<tr><td class="nexus-metric-label">Retry rate</td>' +
      '<td>' + pct(edge.retryRate) + '</td></tr>' +
    '<tr><td class="nexus-metric-label">Throughput</td>' +
      '<td>' + edge.throughputPerMin.toFixed(1) + '/min</td></tr>' +
    (edge.baselineDelta > 1 ?
      '<tr><td class="nexus-metric-label">Baseline</td>' +
        '<td class="nexus-baseline-warn">' +
        edge.baselineDelta.toFixed(1) + 'x above baseline</td></tr>' : '') +
    '</table>';
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_buildDetailPanel, _openNodeDetail, _renderMetricsTable, _renderDeepLinks)
**Edge cases:**
- Node with no edges yet (newly appeared): show "No traffic observed" in metrics area.
- Multiple edges to same dependency (should not occur in V1 model, but guard): show first edge.
- Detail panel open when snapshot updates: re-render detail content if selected node/edge still exists; close if removed.
**Interactions:** Deep links → S10. Close → S16 (Escape key).

---

### S10 — Deep Links: Navigate to Spark/HTTP/Retries Tabs

**ID:** `C06-S10`
**Description:** Deep-link buttons in the detail panel navigate to related tabs with pre-applied filters.
**Priority:** P1-MVP

**Trigger:** User clicks "View in HTTP Pipeline", "View in Spark", or "View in Retries" button in the detail panel.

**Expected behavior:**
- **HTTP Pipeline link:** Calls `window.edogApp.runtimeView.switchTab('http')`. The HTTP tab should receive a URL filter hint matching the dependency's endpoint patterns. Mechanism: set a shared filter intent on `window.edogApp` or emit a custom event.
- **Spark link:** Only shown for `spark-gts` node. Calls `switchTab('spark')`.
- **Retries link:** Only shown when `retryRate > 0`. Calls `switchTab('retries')`.
- After navigation, the Nexus detail panel closes and the target tab activates.

**Technical mechanism:**

```javascript
_renderDeepLinks(nodeId, edge) {
  let html = '<div class="nexus-deeplinks">';

  // HTTP Pipeline (always available)
  html += '<button class="nexus-link-btn" data-action="http" data-dep="' +
    nodeId + '">View in HTTP Pipeline \u25B8</button>';

  // Spark (only for spark-gts)
  if (nodeId === 'spark-gts') {
    html += '<button class="nexus-link-btn" data-action="spark">' +
      'View in Spark Sessions \u25B8</button>';
  }

  // Retries (only when retry traffic exists)
  if (edge.retryRate > 0) {
    html += '<button class="nexus-link-btn" data-action="retries">' +
      'View in Retries \u25B8</button>';
  }

  html += '</div>';
  return html;
}

// Event delegation on detail links container
_onDeepLinkClick(e) {
  const btn = e.target.closest('.nexus-link-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  this._closeDetail();
  if (window.edogApp && window.edogApp.runtimeView) {
    window.edogApp.runtimeView.switchTab(action);
  }
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_renderDeepLinks, _onDeepLinkClick)
**Edge cases:**
- `window.edogApp` not available (defensive): log warning, no-op.
- Target tab not yet registered: `switchTab` gracefully handles missing tabs (no-op in `runtime-view.js`).
**Interactions:** `runtime-view.js:130-170` (switchTab), `tab-http.js:60-66` (activate with pending filter), `tab-spark.js:46-51` (activate).

---

### S11 — Internals Toggle: Filesystem Hidden by Default

**ID:** `C06-S11`
**Description:** The `filesystem` dependency node is hidden by default. It becomes visible when the user enables the Internals toggle, matching the existing RuntimeView internals pattern.
**Priority:** P1-MVP

**Trigger:** User clicks "Show Internals" toggle button in the Nexus toolbar.

**Expected behavior:**
- Default: `this._showInternals = false`. Filesystem node and its edge are skipped in render loop.
- Toggle ON: filesystem node appears on the ring. Layout recomputes to include it.
- Toggle OFF: filesystem node disappears. Layout recomputes without it.
- Toggle button: ghost-style button with eye icon. Text: "Internals" / "Internals (on)".

**Technical mechanism:**

```javascript
_buildToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'nexus-toolbar';

  // ... other toolbar items ...

  // Internals toggle
  const toggle = document.createElement('button');
  toggle.className = 'nexus-internals-toggle';
  toggle.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="8" cy="8" r="3"/>' +
      '<path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5S1 8 1 8z"/>' +
    '</svg> Internals';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => {
    this._showInternals = !this._showInternals;
    toggle.setAttribute('aria-pressed', String(this._showInternals));
    toggle.classList.toggle('active', this._showInternals);
    toggle.querySelector('span') || null;
    this._layoutDirty = true;
    this._computeLayout();
    this._scheduleRender();
  });
  toolbar.appendChild(toggle);

  return toolbar;
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_buildToolbar internals toggle)
**Edge cases:**
- No filesystem node in snapshot: toggle button still visible but has no visual effect.
- Filesystem with critical health: when hidden, do NOT suppress filesystem alerts (toast still shows). Only the graph node/edge is hidden.
**Interactions:** Aligns with `runtime-view.js:26-27` internals concept and P0 research §4.3 item 5 (`p0-foundation.md:101`).

---

### S12 — Snapshot Updates: Incremental Graph Update from 1 Hz Snapshots

**ID:** `C06-S12`
**Description:** Each incoming snapshot incrementally updates the graph state. Nodes/edges that exist are updated in-place; new nodes are added; removed nodes are cleaned up. Layout is only recomputed when node set changes.
**Priority:** P1-MVP

**Trigger:** `_onSnapshot(envelope)` receives a new snapshot (approximately every 1 second).

**Expected behavior:**
1. Parse `envelope.data` as `NexusSnapshot` (nodes[], edges[], alerts[]).
2. **Node diff:** Compare incoming `nodes` against `this._nodes`. Add new nodes (with layout pending). Remove nodes no longer present. Update volume on existing nodes.
3. **Edge update:** Replace `this._edges` with new edge array. Update health, metrics, throughput.
4. **Layout trigger:** If node set changed (added/removed), set `_layoutDirty = true` and recompute. If only metrics changed, skip layout.
5. **Alert processing:** Pass `alerts[]` to S13 alert handler.
6. Schedule RAF render.

**Technical mechanism:**

```javascript
_onSnapshot(envelope) {
  const data = envelope && envelope.data ? envelope.data : envelope;
  if (!data || !data.nodes) return;

  this._snapshot = data;
  const prevNodeIds = new Set(this._nodes.keys());
  const newNodeIds = new Set();

  // Upsert nodes
  for (const n of data.nodes) {
    newNodeIds.add(n.id);
    if (this._nodes.has(n.id)) {
      const existing = this._nodes.get(n.id);
      existing.volume = n.volume;
      existing.kind = n.kind;
      existing.radius = this._nodeRadius(n.volume, n.id);
    } else {
      this._nodes.set(n.id, {
        x: 0, y: 0,
        volume: n.volume,
        kind: n.kind,
        radius: this._nodeRadius(n.volume, n.id)
      });
      this._layoutDirty = true;
    }
  }

  // Remove stale nodes
  for (const id of prevNodeIds) {
    if (!newNodeIds.has(id)) {
      this._nodes.delete(id);
      this._layoutDirty = true;
      if (this._selectedNode === id) this._closeDetail();
    }
  }

  // Update edges
  this._edges = (data.edges || []).map((e, i) => ({
    fromId: e.from,
    toId: e.to,
    volume: e.volume,
    throughputPerMin: e.throughputPerMin,
    p50Ms: e.p50Ms,
    p95Ms: e.p95Ms,
    p99Ms: e.p99Ms || e.p95Ms,
    errorRate: e.errorRate,
    retryRate: e.retryRate,
    health: e.health,
    baselineDelta: e.baselineDelta || 0,
    _curveDir: i % 2 === 0 ? 1 : -1
  }));

  // Process alerts
  this._processAlerts(data.alerts || []);

  // Recompute layout only if node topology changed
  if (this._layoutDirty) this._computeLayout();

  // Update detail panel if open
  if (this._selectedNode || this._selectedEdge !== null) {
    this._refreshDetailContent();
  }

  this._scheduleRender();
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_onSnapshot)
**Edge cases:**
- Snapshot with `type: "alert"` instead of `type: "snapshot"`: route to alert handler only, skip graph update.
- Malformed snapshot (missing `nodes`): ignore entirely, log warning.
- Rapid snapshots (> 1 Hz burst): RAF coalesces renders — no extra work.
**Interactions:** Backend publishes at 1 Hz (`2026-04-24-nexus-design.md:217`). SignalR delivers via topic stream.

---

### S13 — Alert Rendering: Visual Pulse + Toast

**ID:** `C06-S13`
**Description:** Anomaly alerts from the snapshot trigger two visual effects: (1) edge/node pulse on the graph, and (2) a DOM-based toast notification above the graph.
**Priority:** P1-MVP

**Trigger:** `_processAlerts(alerts)` receives non-empty `alerts[]` from snapshot.

**Expected behavior:**
- **Graph pulse:** Already handled by health-based edge rendering (S05). Alert data provides the health signal.
- **Toast:** A DOM element `div.nexus-toast` appears at top-right of the Nexus container. Shows alert severity icon + message. Auto-dismisses after 8 seconds. Max 3 visible toasts (oldest dismissed first).
- **Severity icons:** warning → `\u26A0` (amber), critical → `\u25CF` (red dot).
- **No emoji.** Unicode symbols only.

**Technical mechanism:**

```javascript
_processAlerts(alerts) {
  for (const alert of alerts) {
    // Deduplicate: skip if identical alert already shown in last 10s
    const key = alert.dependencyId + ':' + alert.severity + ':' + alert.message;
    if (this._recentAlertKeys.has(key)) continue;
    this._recentAlertKeys.add(key);
    setTimeout(() => this._recentAlertKeys.delete(key), 10000);

    this._showToast(alert);
  }
}

_showToast(alert) {
  const toast = document.createElement('div');
  toast.className = 'nexus-toast severity-' + alert.severity;
  const icon = alert.severity === 'critical' ? '\u25CF' : '\u26A0';
  toast.innerHTML =
    '<span class="nexus-toast-icon">' + icon + '</span>' +
    '<span class="nexus-toast-msg">' + this._esc(alert.message) + '</span>' +
    '<button class="nexus-toast-close">\u2715</button>';

  toast.querySelector('.nexus-toast-close').addEventListener('click', () => {
    toast.classList.add('exiting');
    setTimeout(() => toast.remove(), 200);
  });

  this._els.toastContainer.appendChild(toast);

  // Auto-dismiss after 8s
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('exiting');
      setTimeout(() => toast.remove(), 200);
    }
  }, 8000);

  // Cap at 3 visible toasts
  const toasts = this._els.toastContainer.children;
  while (toasts.length > 3) {
    toasts[0].remove();
  }
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_processAlerts, _showToast)
**Edge cases:**
- Alert storm (10+ alerts in one snapshot): only 3 newest toasts visible. Rest are dismissed.
- Same alert repeated every snapshot: dedup by `dependencyId + severity + message` within 10s window.
- Tab deactivated: toasts stop appearing (no processing when `_active === false`).
**Interactions:** Aligns with anomaly system design (`spec.md:56-59`).

---

### S14 — Performance: RAF Throttling, Bounded State

**ID:** `C06-S14`
**Description:** All rendering is gated through `requestAnimationFrame`. State buffers are bounded. Canvas operations are optimized for 60fps under normal load.
**Priority:** P1-MVP

**Trigger:** Any state change (snapshot, interaction, resize).

**Expected behavior:**
- `_scheduleRender()` coalesces multiple updates into a single RAF callback. Identical to `tab-http.js:768-776`.
- Maximum nodes: 30. If snapshot exceeds this, collapse least-significant nodes into an "Other" aggregate node.
- Maximum visible edges: 50. If exceeded, hide lowest-throughput edges and show "N hidden edges" indicator.
- Canvas render budget: target < 8ms per frame (half of 16ms budget). Measure with `performance.now()` in dev builds.
- No continuous RAF loop. Animation (pulse) requests the next frame only when non-healthy edges exist.

**Technical mechanism:**

```javascript
_scheduleRender() {
  if (this._renderPending) return;
  this._renderPending = true;
  requestAnimationFrame(() => {
    this._renderPending = false;
    if (this._active) {
      this._render();
      // Continue animation loop only if pulsing edges exist
      if (this._hasPulsingEdges()) this._scheduleRender();
    }
  });
}

_render() {
  if (!this._snapshot || !this._ctx) return;

  const hasData = this._nodes.size > 1; // more than just FLT
  this._els.empty.classList.toggle('hidden', hasData);
  this._els.canvasWrap.classList.toggle('hidden', !hasData);

  if (!hasData) return;
  this._renderGraph();
}

_hasPulsingEdges() {
  return this._edges.some(e => e.health !== 'healthy');
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_scheduleRender, _render, _hasPulsingEdges)
**Edge cases:**
- Tab hidden (deactivated): `_active = false` prevents render. No wasted frames.
- Device with low DPR (1.0): no scaling needed. High DPR (2.0, 3.0): canvas scaled by `devicePixelRatio` for crisp rendering.
**Interactions:** Matches RAF pattern in `tab-http.js:768-776`. Bounded state matches `tab-http.js:42` (_MAX_EVENTS=2000), `tab-spark.js:32` (_maxSessions=200).

---

### S15 — Graceful Degradation: Too Many Edges Collapse to "Other"

**ID:** `C06-S15`
**Description:** When the dependency count exceeds `_MAX_NODES` or edge count exceeds `_MAX_VISIBLE_EDGES`, the system collapses low-signal nodes into an aggregate "Other" group.
**Priority:** P1-MVP

**Trigger:** Snapshot contains more nodes than `_MAX_NODES` (30).

**Expected behavior:**
- Sort dependencies by `volume` descending.
- Top N-1 nodes render individually.
- Remaining nodes collapse into a single "Other (K)" node where K is the collapsed count.
- The "Other" node's volume = sum of collapsed volumes. Its edge health = worst health among collapsed.
- A small label "+ K more" indicates collapsed nodes.
- Clicking "Other" node opens a detail panel listing all collapsed dependencies with their metrics.

**Technical mechanism:**

```javascript
_collapseIfNeeded(nodes, edges) {
  if (nodes.length <= this._MAX_NODES) return { nodes, edges };

  // Sort by volume desc, keep top N-1 + FLT
  const deps = nodes.filter(n => n.id !== 'flt-local')
    .sort((a, b) => b.volume - a.volume);
  const keep = new Set(['flt-local']);
  for (let i = 0; i < this._MAX_NODES - 2; i++) {
    if (deps[i]) keep.add(deps[i].id);
  }

  const collapsed = deps.filter(d => !keep.has(d.id));
  const otherVolume = collapsed.reduce((s, n) => s + n.volume, 0);

  const otherNode = {
    id: '_other',
    kind: 'aggregate',
    volume: otherVolume,
    _collapsedIds: collapsed.map(n => n.id),
    _collapsedCount: collapsed.length
  };

  const keptNodes = nodes.filter(n => keep.has(n.id)).concat([otherNode]);
  // Merge edges: remap collapsed -> _other
  const keptEdges = edges.map(e => ({
    ...e,
    to: keep.has(e.to) ? e.to : '_other'
  }));

  return { nodes: keptNodes, edges: keptEdges };
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_collapseIfNeeded)
**Edge cases:**
- All dependencies have equal volume: collapse is arbitrary but deterministic (alphabetical tiebreak).
- "Other" node clicked: detail panel shows a scrollable list of collapsed dependencies.
- Collapsed node becomes critical: "Other" node reflects the worst health among its members.
**Interactions:** Matches codebase bounded-state philosophy (`p0-foundation.md:119-121`).

---

### S16 — Keyboard Accessibility

**ID:** `C06-S16`
**Description:** Nexus tab supports keyboard navigation: Tab cycles through nodes, Enter opens detail, Escape closes detail.
**Priority:** P1-MVP

**Trigger:** Keyboard input while Nexus tab is active.

**Expected behavior:**
- **Tab / Shift+Tab:** Cycles `_selectedNode` through nodes in layout order (ring-1 sorted alphabetically, then FLT). Selected node gets visual ring (S07).
- **Enter:** Opens detail panel for the selected node (S09).
- **Escape:** Closes detail panel if open. If closed, deselects current node.
- **Arrow keys (optional P2):** Reserved for future pan/zoom.
- Focus indicator: selected node gets a dashed accent ring (S07 selection ring).

**Technical mechanism:**

```javascript
_onKeyDown(e) {
  if (!this._active) return;

  if (e.key === 'Escape') {
    if (!this._els.detail.classList.contains('closed')) {
      this._closeDetail();
    } else {
      this._selectedNode = null;
      this._selectedEdge = null;
      this._scheduleRender();
    }
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const ids = this._getNavigableNodeIds();
    if (ids.length === 0) return;
    const curIdx = ids.indexOf(this._selectedNode);
    const dir = e.shiftKey ? -1 : 1;
    const nextIdx = curIdx === -1
      ? 0
      : (curIdx + dir + ids.length) % ids.length;
    this._selectedNode = ids[nextIdx];
    this._scheduleRender();
    return;
  }

  if (e.key === 'Enter' && this._selectedNode) {
    this._openNodeDetail(this._selectedNode);
    return;
  }
}

_getNavigableNodeIds() {
  return [...this._nodes.keys()]
    .filter(id => this._showInternals || id !== 'filesystem')
    .sort();
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_onKeyDown, _getNavigableNodeIds)
**Edge cases:**
- No nodes: Tab key is no-op.
- Detail panel has focusable deep-link buttons: once panel is open, Tab cycles through buttons inside the panel (standard DOM focus flow). Escape returns to canvas.
**Interactions:** Matches keyboard patterns in `tab-http.js:686-714` (Escape close, Arrow navigate, Enter open).

---

### S17 — Empty/Loading/Error States

**ID:** `C06-S17`
**Description:** Three distinct non-data states with appropriate visual feedback.
**Priority:** P1-MVP

**Trigger:** Various lifecycle conditions.

**Expected behavior:**

| State | Condition | Visual |
|-------|-----------|--------|
| **Empty** | `_snapshot === null` or snapshot has 0 non-FLT nodes | Graph icon + "No dependency data yet" (S03) |
| **Loading** | Tab activated, snapshot not yet received, SignalR connected | "Waiting for Nexus data..." with subtle opacity pulse on text |
| **Error** | SignalR disconnected while tab is active | "Connection lost" with reconnect indicator matching `rt-conn-dot` state |

**Technical mechanism:**

```javascript
_updateOverlayState() {
  const connected = this._signalr && this._signalr.status === 'connected';
  const hasData = this._snapshot && this._nodes.size > 1;

  // Error state: disconnected
  this._els.errorState.classList.toggle('hidden', connected);

  // Loading state: connected but no data yet
  this._els.loadingState.classList.toggle('hidden', !connected || hasData);

  // Empty state: connected, have snapshot, but no deps
  this._els.empty.classList.toggle('hidden',
    !connected || !this._snapshot || hasData);

  // Canvas: only when we have data
  this._els.canvasWrap.classList.toggle('hidden', !hasData);
}
```

**Source path:** `src/frontend/js/tab-nexus.js` (_updateOverlayState)
**Edge cases:**
- SignalR reconnects mid-view: transition from error → loading → data as snapshot arrives.
- Backend restart: snapshot history replays via `SubscribeToTopic`; should transition smoothly from error → loading → data.
**Interactions:** Connection state from `signalr-manager.js:161-166` (setStatus).

---

### S18 — CSS Structure: tab-nexus.css with Design Tokens

**ID:** `C06-S18`
**Description:** All Nexus tab styles live in `tab-nexus.css`, using exclusively design system tokens. No raw color values, no raw pixel sizes outside the 4px grid.
**Priority:** P1-MVP

**Trigger:** Build pipeline inlines CSS into the single HTML output.

**Expected behavior:**
- File: `src/frontend/css/tab-nexus.css`
- All colors via `var(--*)` tokens.
- All spacing via `var(--space-*)`.
- All font sizes via `var(--text-*)`.
- All radii via `var(--radius-*)`.
- Dark mode: automatic via existing `[data-theme="dark"]` token swaps.

**Technical mechanism:**

```css
/* ── Nexus Tab ────────────────────────────────────── */

.nexus-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.nexus-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

.nexus-canvas-wrap {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.nexus-canvas-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Empty / Loading / Error states ── */

.nexus-empty,
.nexus-loading,
.nexus-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.nexus-empty.hidden,
.nexus-loading.hidden,
.nexus-error.hidden,
.nexus-canvas-wrap.hidden {
  display: none;
}

.nexus-empty-icon { color: var(--text-muted); opacity: 0.5; }
.nexus-empty-title { font-size: var(--text-md); color: var(--text-dim); font-weight: 500; }
.nexus-empty-desc { font-size: var(--text-sm); color: var(--text-muted); }

/* ── Detail Panel ── */

.nexus-detail {
  position: absolute;
  top: 0;
  right: 0;
  width: 320px;
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  transform: translateX(0);
  transition: transform 0.15s ease;
  z-index: 10;
}
.nexus-detail.closed {
  transform: translateX(100%);
  pointer-events: none;
}

.nexus-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3);
  border-bottom: 1px solid var(--border);
}
.nexus-detail-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text);
}
.nexus-detail-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--text-md);
  padding: var(--space-1);
  border-radius: var(--radius-sm);
}
.nexus-detail-close:hover { color: var(--text); background: var(--surface-2); }

.nexus-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3);
}

/* ── Metrics Table ── */

.nexus-metrics {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.nexus-metrics td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border);
}
.nexus-metric-label {
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  width: 100px;
}

/* ── Health Badges ── */

.nexus-health-badge {
  display: inline-block;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
}
.nexus-health-badge.h-healthy {
  background: rgba(24, 160, 88, 0.08);
  color: var(--status-succeeded);
}
.nexus-health-badge.h-degraded {
  background: rgba(229, 148, 12, 0.08);
  color: var(--status-cancelled);
}
.nexus-health-badge.h-critical {
  background: rgba(229, 69, 59, 0.08);
  color: var(--status-failed);
}

.nexus-baseline-warn {
  color: var(--status-cancelled);
  font-weight: 600;
}

/* ── Deep Link Buttons ── */

.nexus-detail-links {
  padding: var(--space-3);
  border-top: 1px solid var(--border);
}
.nexus-deeplinks {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.nexus-link-btn {
  background: transparent;
  border: 1px solid var(--border-bright);
  color: var(--text-dim);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  cursor: pointer;
  text-align: left;
  transition: background 0.1s, color 0.1s;
}
.nexus-link-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* ── Toolbar ── */

.nexus-internals-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.nexus-internals-toggle:hover {
  background: var(--surface-2);
  color: var(--text-dim);
}
.nexus-internals-toggle.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: var(--accent);
}

/* ── Toast Notifications ── */

.nexus-toast-container {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  z-index: 20;
  pointer-events: none;
}
.nexus-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  box-shadow: var(--shadow-md);
  animation: nexus-toast-in 0.2s ease;
}
.nexus-toast.exiting {
  animation: nexus-toast-out 0.2s ease forwards;
}
.nexus-toast.severity-warning .nexus-toast-icon {
  color: var(--status-cancelled);
}
.nexus-toast.severity-critical .nexus-toast-icon {
  color: var(--status-failed);
}
.nexus-toast-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--text-xs);
  padding: 0 var(--space-1);
}
.nexus-toast-close:hover { color: var(--text); }

@keyframes nexus-toast-in {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes nexus-toast-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-8px); }
}
```

**Source path:** `src/frontend/css/tab-nexus.css` (entire file)
**Edge cases:**
- Dark mode: all tokens swap automatically. No additional dark-mode overrides needed for graph colors because canvas reads CSS variables at render time (S04 `_healthColor`).
- RTL: detail panel should stay on the right (graph content is directional, not locale-dependent).
**Interactions:** Inlined into single HTML via `scripts/build-html.py`. Design tokens from `docs/DESIGN_SYSTEM.md`.

---

## 3. HTML Modifications

### 3.1 Tab Bar Entry

Add a `nexus` tab to the Runtime View tab bar in `src/frontend/index.html`, between "Spark Sessions" and the "Internals" dropdown:

```html
<!-- After the Spark Sessions tab, before rt-tab-internals -->
<div class="rt-tab" data-tab="nexus">Nexus</div>
```

**Source path:** `src/frontend/index.html:143` (after `data-tab="spark"` line)

### 3.2 Tab Content Container

Add a content container for the Nexus tab within the runtime content area:

```html
<div id="rt-tab-nexus" class="rt-tab-content">
  <!-- NexusTab builds its DOM here -->
</div>
```

**Source path:** `src/frontend/index.html` (inside `rt-content`, alongside other `rt-tab-*` containers)

### 3.3 runtime-view.js Modifications

Add `'nexus'` to the `_topTabIds` array:

```javascript
this._topTabIds = ['logs', 'telemetry', 'sysfiles', 'spark', 'nexus'];
```

**Source path:** `src/frontend/js/runtime-view.js:24`

### 3.4 main.js Modifications

Instantiate and register the Nexus tab:

```javascript
// After SparkSessionsTab instantiation
this.nexusTab = new NexusTab(
  document.getElementById('rt-tab-nexus'),
  this.ws
);
this.runtimeView.registerTab('nexus', this.nexusTab);
```

**Source path:** `src/frontend/js/main.js:206` (registration block)

---

## 4. File Manifest

| File | Action | Description |
|------|--------|-------------|
| `src/frontend/js/tab-nexus.js` | **Create** | NexusTab class — full tab module |
| `src/frontend/css/tab-nexus.css` | **Create** | All Nexus tab styles |
| `src/frontend/index.html` | **Modify** | Add tab bar entry + content container |
| `src/frontend/js/runtime-view.js` | **Modify** | Add `'nexus'` to `_topTabIds` |
| `src/frontend/js/main.js` | **Modify** | Instantiate + register NexusTab |

---

## 5. Data Contract Reference

### 5.1 Snapshot Payload (from backend `nexus` topic)

```json
{
  "topic": "nexus",
  "type": "snapshot",
  "data": {
    "generatedAt": "2026-04-24T04:10:12.000Z",
    "windowSec": 300,
    "nodes": [
      { "id": "flt-local", "kind": "core", "volume": 0 },
      { "id": "spark-gts", "kind": "dependency", "volume": 186 }
    ],
    "edges": [
      {
        "from": "flt-local",
        "to": "spark-gts",
        "volume": 186,
        "throughputPerMin": 37.2,
        "p50Ms": 180,
        "p95Ms": 690,
        "p99Ms": 720,
        "errorRate": 0.07,
        "retryRate": 0.11,
        "health": "degraded",
        "baselineDelta": 3.0
      }
    ],
    "alerts": [
      {
        "severity": "warning",
        "dependencyId": "spark-gts",
        "message": "Latency 3.0x above baseline"
      }
    ]
  }
}
```

Source: `docs/superpowers/specs/2026-04-24-nexus-design.md:121-157`

### 5.2 Canonical Dependency IDs (V1)

| ID | Display Name | Hidden by Default |
|----|-------------|-------------------|
| `flt-local` | FLT | No (always center) |
| `spark-gts` | Spark (GTS) | No |
| `fabric-api` | Fabric APIs | No |
| `platform-api` | Platform APIs | No |
| `auth` | Auth | No |
| `capacity` | Capacity | No |
| `cache` | Cache | No |
| `retry-system` | Retry System | No |
| `filesystem` | File System | Yes (Internals) |
| `unknown` | Unknown | No |

Source: `docs/superpowers/specs/2026-04-24-nexus-design.md:91-101`

---

## 6. Priority Summary

| Scenario | ID | Priority |
|----------|----|----------|
| Tab module structure | S01 | P1-MVP |
| Topic subscription lifecycle | S02 | P1-MVP |
| Empty state rendering | S03 | P1-MVP |
| Healthy topology rendering | S04 | P1-MVP |
| Degraded/critical rendering | S05 | P1-MVP |
| Hybrid layout algorithm | S06 | P1-MVP |
| Node rendering | S07 | P1-MVP |
| Edge rendering | S08 | P1-MVP |
| Detail panel | S09 | P1-MVP |
| Deep links | S10 | P1-MVP |
| Internals toggle | S11 | P1-MVP |
| Incremental snapshot updates | S12 | P1-MVP |
| Alert rendering | S13 | P1-MVP |
| Performance / RAF | S14 | P1-MVP |
| Graceful degradation | S15 | P1-MVP |
| Keyboard accessibility | S16 | P1-MVP |
| Empty/loading/error states | S17 | P1-MVP |
| CSS structure | S18 | P1-MVP |
