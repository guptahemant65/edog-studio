/**
 * NexusTab — Real-time Dependency Graph for EDOG Studio Runtime View.
 *
 * Canvas 2D visualization of FLT's cross-workload dependency health.
 * Hub-spoke topology: FLT center node, dependency nodes on a ring,
 * edges color-coded by health with animated flow dots.
 *
 * Architecture: constructor(containerEl, signalr) -> activate() / deactivate()
 * Topic: `nexus`  |  Event shape: NexusSnapshot (see EdogNexusModels.cs)
 *
 * Data contract (camelCase from SignalR JSON):
 *   NexusSnapshot: { generatedAt, windowSec, nodes[], edges[], alerts[] }
 *   NexusNodeInfo: { id, kind, volume }
 *   NexusEdgeStats: { from, to, volume, throughputPerMin, p50Ms, p95Ms,
 *                     p99Ms, errorRate, retryRate, baselineDelta, health }
 *   NexusAlert:    { severity, dependencyId, message, timestamp }
 */
class NexusTab {
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // State
    this._snapshot = null;
    this._nodes = new Map();        // nodeId -> { x, y, volume, kind, radius }
    this._edges = [];               // processed edge objects
    this._selectedNode = null;
    this._selectedEdge = null;
    this._hoveredNode = null;
    this._hoveredEdge = null;
    this._active = false;
    this._showInternals = false;
    this._alerts = [];

    // Canvas
    this._canvas = null;
    this._ctx = null;
    this._dpr = window.devicePixelRatio || 1;

    // Layout
    this._layoutSeed = 42;
    this._layoutDirty = true;

    // Animation
    this._animFrame = null;
    this._flowOffset = 0;

    // DOM cache
    this._els = {};

    // Bound handlers
    this._onSnapshot = this._onSnapshot.bind(this);
    this._onCanvasClick = this._onCanvasClick.bind(this);
    this._onCanvasMove = this._onCanvasMove.bind(this);
    this._onCanvasLeave = this._onCanvasLeave.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onResize = this._onResize.bind(this);
    this._animLoop = this._animLoop.bind(this);

    // Display name mapping
    this._nameMap = {
      'flt-local': 'FLT',
      'spark-gts': 'Spark (GTS)',
      'fabric-api': 'Fabric APIs',
      'platform-api': 'Platform APIs',
      'auth': 'Auth',
      'capacity': 'Capacity',
      'cache': 'Cache',
      'retry-system': 'Retry System',
      'filesystem': 'File System',
      'unknown': 'Unknown'
    };

    // CSS value cache (refreshed once per activate or theme change)
    this._cssCache = {};
    this._cssCacheDirty = true;

    this._buildDOM();
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  /** Called when tab becomes visible. Subscribe to `nexus` topic. */
  activate() {
    if (this._active) return;
    this._active = true;
    this._cssCacheDirty = true;
    this._resizeCanvas();
    if (this._signalr) {
      this._signalr.on('nexus', this._onSnapshot);
      this._signalr.subscribeTopic('nexus');
    }
    document.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize', this._onResize);
    this._startAnimLoop();
  }

  /** Called when tab is hidden. Unsubscribe to save resources. */
  deactivate() {
    this._active = false;
    document.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize', this._onResize);
    if (this._signalr) {
      this._signalr.off('nexus', this._onSnapshot);
      this._signalr.unsubscribeTopic('nexus');
    }
    this._stopAnimLoop();
  }

  /** Full teardown for GC. */
  destroy() {
    this.deactivate();
    this._ctx = null;
    this._canvas = null;
    this._nodes.clear();
    this._edges = [];
    this._snapshot = null;
    this._container.innerHTML = '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // SIGNALR SNAPSHOT HANDLER
  // ═══════════════════════════════════════════════════════════════════

  _onSnapshot(envelope) {
    try {
      var data = envelope && envelope.data ? envelope.data : envelope;
      if (!data || !data.nodes) return;

      this._snapshot = data;
      var prevNodeIds = new Set(this._nodes.keys());
      var newNodeIds = new Set();

      // Upsert nodes
      for (var i = 0; i < data.nodes.length; i++) {
        var n = data.nodes[i];
        newNodeIds.add(n.id);
        if (this._nodes.has(n.id)) {
          var existing = this._nodes.get(n.id);
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
      for (var staleId of prevNodeIds) {
        if (!newNodeIds.has(staleId)) {
          this._nodes.delete(staleId);
          this._layoutDirty = true;
          if (this._selectedNode === staleId) this._closeDetail();
        }
      }

      // Replace edges with curve direction alternation
      this._edges = (data.edges || []).map(function(e, idx) {
        return {
          fromId: e.from,
          toId: e.to,
          volume: e.volume || 0,
          throughputPerMin: e.throughputPerMin || 0,
          p50Ms: e.p50Ms || 0,
          p95Ms: e.p95Ms || 0,
          p99Ms: e.p99Ms || 0,
          errorRate: e.errorRate || 0,
          retryRate: e.retryRate || 0,
          baselineDelta: e.baselineDelta || 0,
          health: e.health || 'healthy',
          _curveDir: (idx % 2 === 0) ? 1 : -1
        };
      });

      // Recompute layout if node set changed
      if (this._layoutDirty) {
        this._computeLayout();
      }

      // Process anomaly alerts
      this._processAlerts(data.alerts || []);

      // Update detail panel if still relevant
      if (this._selectedNode) {
        var edge = this._findEdgeForNode(this._selectedNode);
        if (edge) {
          this._els.detailBody.innerHTML = this._renderMetricsTable(edge);
          this._els.detailLinks.innerHTML = this._renderDeepLinks(this._selectedNode, edge);
        }
      }

      // Update toolbar status
      this._updateToolbarStatus();

      // Toggle empty state
      var hasData = this._nodes.size > 0 &&
        !(this._nodes.size === 1 && this._nodes.has('flt-local') && this._edges.length === 0);
      this._els.empty.classList.toggle('hidden', hasData);

    } catch (err) {
      console.error('[NexusTab] snapshot error:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOM CONSTRUCTION
  // ═══════════════════════════════════════════════════════════════════

  _buildDOM() {
    var c = this._container;
    c.innerHTML = '';

    var root = document.createElement('div');
    root.className = 'nexus-container';

    // Toolbar
    root.appendChild(this._buildToolbar());

    // Canvas area with empty state overlay
    var canvasWrap = document.createElement('div');
    canvasWrap.className = 'nexus-canvas-wrap';

    // Empty state
    canvasWrap.appendChild(this._buildEmptyState());

    // Canvas
    var canvas = document.createElement('canvas');
    canvasWrap.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');

    // Tooltip (positioned fixed, appended to canvas wrap)
    var tooltip = document.createElement('div');
    tooltip.className = 'nexus-tooltip';
    canvasWrap.appendChild(tooltip);
    this._els.tooltip = tooltip;

    // Detail panel (slides in from right)
    canvasWrap.appendChild(this._buildDetailPanel());

    // Alert toast stack
    canvasWrap.appendChild(this._buildAlertStack());

    root.appendChild(canvasWrap);
    this._els.canvasWrap = canvasWrap;

    c.appendChild(root);

    // Canvas interaction events
    canvas.addEventListener('click', this._onCanvasClick);
    canvas.addEventListener('mousemove', this._onCanvasMove);
    canvas.addEventListener('mouseleave', this._onCanvasLeave);
  }

  _buildToolbar() {
    var toolbar = document.createElement('div');
    toolbar.className = 'nexus-toolbar';

    // Status indicator
    var status = document.createElement('div');
    status.className = 'nexus-toolbar-status';
    var dot = document.createElement('span');
    dot.className = 'nexus-status-dot';
    status.appendChild(dot);
    var label = document.createElement('span');
    label.textContent = 'Waiting for data';
    status.appendChild(label);
    toolbar.appendChild(status);
    this._els.statusDot = dot;
    this._els.statusLabel = label;

    toolbar.appendChild(this._makeSep());

    // Internals toggle (shows/hides filesystem node)
    var toggle = document.createElement('button');
    toggle.className = 'nexus-internals-toggle';
    toggle.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5">' +
        '<circle cx="8" cy="8" r="3"/>' +
        '<path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5S1 8 1 8z"/>' +
      '</svg> Internals';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.title = 'Toggle filesystem dependency visibility';
    toolbar.appendChild(toggle);
    this._els.internalsToggle = toggle;

    var self = this;
    toggle.addEventListener('click', function() {
      self._showInternals = !self._showInternals;
      toggle.setAttribute('aria-pressed', String(self._showInternals));
      toggle.classList.toggle('active', self._showInternals);
      self._layoutDirty = true;
      self._computeLayout();
    });

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'nexus-toolbar-spacer';
    toolbar.appendChild(spacer);

    // Window label (e.g. "300s window")
    var windowLabel = document.createElement('span');
    windowLabel.className = 'nexus-window-label';
    windowLabel.textContent = '';
    toolbar.appendChild(windowLabel);
    this._els.windowLabel = windowLabel;

    return toolbar;
  }

  _buildEmptyState() {
    var empty = document.createElement('div');
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
    this._els.empty = empty;
    return empty;
  }

  _buildDetailPanel() {
    var panel = document.createElement('div');
    panel.className = 'nexus-detail';

    var header = document.createElement('div');
    header.className = 'nexus-detail-header';

    var title = document.createElement('span');
    title.className = 'nexus-detail-title';
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'nexus-detail-close';
    closeBtn.textContent = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close detail panel');
    header.appendChild(closeBtn);

    panel.appendChild(header);

    var body = document.createElement('div');
    body.className = 'nexus-detail-body';
    panel.appendChild(body);

    var links = document.createElement('div');
    links.className = 'nexus-detail-links';
    panel.appendChild(links);

    this._els.detail = panel;
    this._els.detailTitle = title;
    this._els.detailBody = body;
    this._els.detailLinks = links;
    this._els.detailClose = closeBtn;

    var self = this;
    closeBtn.addEventListener('click', function() { self._closeDetail(); });
    links.addEventListener('click', function(e) { self._onDeepLinkClick(e); });

    return panel;
  }

  _buildAlertStack() {
    var stack = document.createElement('div');
    stack.className = 'nexus-alert-stack';
    this._els.alertStack = stack;
    return stack;
  }

  _makeSep() {
    var s = document.createElement('div');
    s.className = 'nexus-sep';
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════
  // LAYOUT — Hybrid rings + local force relaxation
  // ═══════════════════════════════════════════════════════════════════

  _computeLayout() {
    if (!this._canvas) return;
    var w = this._canvas.width / this._dpr;
    var h = this._canvas.height / this._dpr;
    if (w === 0 || h === 0) { this._layoutDirty = true; return; }

    var cx = w / 2;
    var cy = h / 2;
    var radius = Math.min(w, h) * 0.35;

    // Place FLT center node
    var flt = this._nodes.get('flt-local');
    if (flt) {
      flt.x = cx;
      flt.y = cy;
    }

    // Collect ring-1 nodes, sorted alphabetically for determinism
    var ring1 = [];
    for (var pair of this._nodes) {
      var nid = pair[0];
      if (nid === 'flt-local') continue;
      if (!this._showInternals && nid === 'filesystem') continue;
      ring1.push(nid);
    }
    ring1.sort();

    var n = ring1.length;
    if (n === 0) { this._layoutDirty = false; return; }

    // Initial even angular distribution from golden-angle seed
    var baseAngle = (this._layoutSeed * 137.508) % 360;
    for (var i = 0; i < n; i++) {
      var angle = (baseAngle + (360 / n) * i) * (Math.PI / 180);
      var nd = this._nodes.get(ring1[i]);
      nd.x = cx + radius * Math.cos(angle);
      nd.y = cy + radius * Math.sin(angle);
    }

    // Local force relaxation: repulsion-only, constrained to ring
    for (var iter = 0; iter < 8; iter++) {
      for (var fi = 0; fi < n; fi++) {
        var a = this._nodes.get(ring1[fi]);
        var fx = 0, fy = 0;
        for (var fj = 0; fj < n; fj++) {
          if (fi === fj) continue;
          var b = this._nodes.get(ring1[fj]);
          var dx = a.x - b.x;
          var dy = a.y - b.y;
          var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          var repulsion = 800 / (dist * dist);
          fx += (dx / dist) * repulsion;
          fy += (dy / dist) * repulsion;
        }
        a.x += fx;
        a.y += fy;
        // Project back onto ring (radial constraint)
        var dxp = a.x - cx;
        var dyp = a.y - cy;
        var d = Math.sqrt(dxp * dxp + dyp * dyp) || 1;
        a.x = cx + (dxp / d) * radius;
        a.y = cy + (dyp / d) * radius;
      }
    }

    this._layoutDirty = false;
  }

  _nodeRadius(volume, id) {
    if (id === 'flt-local') return 28;
    return Math.max(16, Math.min(48, 16 + Math.sqrt(volume || 0) * 2));
  }

  _resizeCanvas() {
    if (!this._canvas || !this._els.canvasWrap) return;
    var rect = this._els.canvasWrap.getBoundingClientRect();
    var w = Math.floor(rect.width);
    var h = Math.floor(rect.height);
    if (w === 0 || h === 0) return;

    this._dpr = window.devicePixelRatio || 1;
    this._canvas.width = w * this._dpr;
    this._canvas.height = h * this._dpr;
    this._canvas.style.width = w + 'px';
    this._canvas.style.height = h + 'px';
    this._cssCacheDirty = true;
    this._layoutDirty = true;
    this._computeLayout();
  }

  // ═══════════════════════════════════════════════════════════════════
  // ANIMATION LOOP — 60fps via requestAnimationFrame
  // ═══════════════════════════════════════════════════════════════════

  _startAnimLoop() {
    if (this._animFrame) return;
    this._animLoop();
  }

  _stopAnimLoop() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }

  _animLoop() {
    if (!this._active) { this._animFrame = null; return; }
    this._flowOffset = (this._flowOffset + 0.004) % 1;
    this._renderGraph();
    this._animFrame = requestAnimationFrame(this._animLoop);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CANVAS RENDERING
  // ═══════════════════════════════════════════════════════════════════

  _renderGraph() {
    if (!this._ctx || !this._canvas) return;
    var w = this._canvas.width / this._dpr;
    var h = this._canvas.height / this._dpr;
    if (w === 0 || h === 0) return;

    var ctx = this._ctx;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

    if (this._nodes.size === 0) return;

    ctx.save();
    ctx.scale(this._dpr, this._dpr);

    if (this._cssCacheDirty) this._refreshCssCache();

    // Sort edges: healthy -> degraded -> critical (critical drawn last = on top)
    var sortedEdges = this._edges.slice().sort(function(a, b) {
      var order = { 'healthy': 0, 'degraded': 1, 'critical': 2 };
      return (order[a.health] || 0) - (order[b.health] || 0);
    });

    // Pass 1: Draw edges
    for (var ei = 0; ei < sortedEdges.length; ei++) {
      var edge = sortedEdges[ei];
      if (!this._showInternals && edge.toId === 'filesystem') continue;
      this._drawEdge(ctx, edge);
    }

    // Pass 2: Flow dots on edges with throughput
    for (var di = 0; di < sortedEdges.length; di++) {
      var dotEdge = sortedEdges[di];
      if (!this._showInternals && dotEdge.toId === 'filesystem') continue;
      if (dotEdge.throughputPerMin > 0) this._drawFlowDots(ctx, dotEdge);
    }

    // Pass 3: Draw nodes (on top of edges)
    for (var pair of this._nodes) {
      var id = pair[0], node = pair[1];
      if (!this._showInternals && id === 'filesystem') continue;
      this._drawNode(ctx, id, node);
    }

    ctx.restore();
  }

  _drawEdge(ctx, edge) {
    var from = this._nodes.get(edge.fromId);
    var to = this._nodes.get(edge.toId);
    if (!from || !to) return;

    var baseThick = edge.throughputPerMin > 0
      ? Math.max(1, Math.min(6, edge.throughputPerMin / 10))
      : 1;
    var thickness = baseThick;
    if (edge.health === 'critical') thickness *= 2;
    else if (edge.health === 'degraded') thickness *= 1.5;

    var isHovered = this._hoveredEdge === edge;
    var isSelected = this._selectedEdge === edge;

    var color = this._healthColor(edge.health);
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;

    // Pulse opacity for non-healthy edges
    if (edge.health === 'degraded' || edge.health === 'critical') {
      var period = edge.health === 'critical' ? 1000 : 2000;
      var minAlpha = edge.health === 'critical' ? 0.4 : 0.6;
      var t = (performance.now() % period) / period;
      var pulse = minAlpha + (1 - minAlpha) * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
      ctx.globalAlpha = pulse;
    } else {
      ctx.globalAlpha = isHovered || isSelected ? 1.0 : 0.6;
    }

    // Critical glow effect
    if (edge.health === 'critical') {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
    }

    // Dashed style for zero-throughput edges
    if (edge.throughputPerMin <= 0) {
      ctx.setLineDash([4, 4]);
    }

    // Quadratic bezier with offset for visual separation
    var mx = (from.x + to.x) / 2;
    var my = (from.y + to.y) / 2;
    var offset = 20 * edge._curveDir;

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(mx + offset, my + offset, to.x, to.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;

    // Arrowhead at target node
    ctx.fillStyle = color;
    var toNode = this._nodes.get(edge.toId);
    this._drawArrowhead(ctx, from.x, from.y, to.x, to.y, toNode ? toNode.radius : 16);
  }

  _drawArrowhead(ctx, fromX, fromY, toX, toY, nodeRadius) {
    var angle = Math.atan2(toY - fromY, toX - fromX);
    var tipX = toX - (nodeRadius + 2) * Math.cos(angle);
    var tipY = toY - (nodeRadius + 2) * Math.sin(angle);
    var size = 6;
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

  _drawFlowDots(ctx, edge) {
    var from = this._nodes.get(edge.fromId);
    var to = this._nodes.get(edge.toId);
    if (!from || !to) return;

    var numDots = 3;
    var color = this._healthColor(edge.health);
    var offset = 20 * edge._curveDir;
    var cpX = (from.x + to.x) / 2 + offset;
    var cpY = (from.y + to.y) / 2 + offset;

    ctx.fillStyle = color;
    for (var d = 0; d < numDots; d++) {
      var t = (this._flowOffset + d / numDots) % 1;
      // Quadratic bezier point: B(t) = (1-t)^2*P0 + 2(1-t)t*P1 + t^2*P2
      var u = 1 - t;
      var x = u * u * from.x + 2 * u * t * cpX + t * t * to.x;
      var y = u * u * from.y + 2 * u * t * cpY + t * t * to.y;

      // Fade at endpoints for smooth appearance/disappearance
      ctx.globalAlpha = 0.8 * Math.sin(t * Math.PI);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }

  _drawNode(ctx, id, node) {
    var r = id === 'flt-local' ? 28 : node.radius;
    var isSelected = this._selectedNode === id;
    var isHovered = this._hoveredNode === id;

    // Node fill
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = this._getNodeFill(id, isHovered);
    ctx.globalAlpha = isHovered ? 1.0 : 0.85;
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Node border
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = id === 'flt-local'
      ? this._cssCache.accent
      : this._worstEdgeColor(id);
    ctx.lineWidth = isSelected ? 3 : (id === 'flt-local' ? 2 : 1.5);
    ctx.stroke();

    // Selection ring (dashed accent ring)
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = this._cssCache.accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Critical alert badge (red dot with "!" at top-right)
    if (id !== 'flt-local') {
      var worstH = this._worstEdgeHealth(id);
      if (worstH === 'critical') {
        ctx.fillStyle = this._cssCache.critical;
        ctx.beginPath();
        ctx.arc(node.x + r * 0.7, node.y - r * 0.7, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', node.x + r * 0.7, node.y - r * 0.7);
      }
    }

    // Label
    ctx.textBaseline = 'alphabetic';
    var label = this._displayName(id);
    if (id === 'flt-local') {
      ctx.font = 'bold 11px ' + this._cssCache.fontMono;
      ctx.fillStyle = this._cssCache.text;
      ctx.textAlign = 'center';
      ctx.fillText(label, node.x, node.y + 4);
    } else {
      ctx.font = '10px ' + this._cssCache.fontMono;
      ctx.fillStyle = this._cssCache.textDim;
      ctx.textAlign = 'center';
      // Truncate long labels with ellipsis
      var maxLabelW = 80;
      if (ctx.measureText(label).width > maxLabelW) {
        while (ctx.measureText(label + '\u2026').width > maxLabelW && label.length > 1) {
          label = label.slice(0, -1);
        }
        label += '\u2026';
      }
      ctx.fillText(label, node.x, node.y + r + 14);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HIT TESTING — Distance-based node/edge detection
  // ═══════════════════════════════════════════════════════════════════

  _nodeHitTest(x, y) {
    for (var pair of this._nodes) {
      var id = pair[0], node = pair[1];
      if (!this._showInternals && id === 'filesystem') continue;
      var r = id === 'flt-local' ? 28 : node.radius;
      var dx = x - node.x;
      var dy = y - node.y;
      if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return id;
    }
    return null;
  }

  _edgeHitTest(x, y) {
    var hitDist = 8;
    for (var i = 0; i < this._edges.length; i++) {
      var edge = this._edges[i];
      if (!this._showInternals && edge.toId === 'filesystem') continue;
      var from = this._nodes.get(edge.fromId);
      var to = this._nodes.get(edge.toId);
      if (!from || !to) continue;

      // Sample 20 points along the quadratic bezier for hit detection
      var offset = 20 * edge._curveDir;
      var cpX = (from.x + to.x) / 2 + offset;
      var cpY = (from.y + to.y) / 2 + offset;
      for (var t = 0; t <= 1; t += 0.05) {
        var u = 1 - t;
        var px = u * u * from.x + 2 * u * t * cpX + t * t * to.x;
        var py = u * u * from.y + 2 * u * t * cpY + t * t * to.y;
        var dx = x - px;
        var dy = y - py;
        if (dx * dx + dy * dy <= hitDist * hitDist) return i;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CANVAS INTERACTION — Click, hover, keyboard
  // ═══════════════════════════════════════════════════════════════════

  _canvasCoords(e) {
    var rect = this._canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onCanvasClick(e) {
    var pos = this._canvasCoords(e);

    // Check node hit first (nodes are on top)
    var nodeId = this._nodeHitTest(pos.x, pos.y);
    if (nodeId) {
      if (this._selectedNode === nodeId) {
        this._closeDetail();
      } else {
        this._openNodeDetail(nodeId);
      }
      return;
    }

    // Check edge hit
    var edgeIdx = this._edgeHitTest(pos.x, pos.y);
    if (edgeIdx !== null) {
      this._openEdgeDetail(edgeIdx);
      return;
    }

    // Click on background closes detail
    if (this._selectedNode || this._selectedEdge !== null) {
      this._closeDetail();
    }
  }

  _onCanvasMove(e) {
    var pos = this._canvasCoords(e);
    var prevNode = this._hoveredNode;
    var prevEdge = this._hoveredEdge;

    // Priority: node hover > edge hover
    this._hoveredNode = this._nodeHitTest(pos.x, pos.y);
    this._hoveredEdge = null;

    if (!this._hoveredNode) {
      var edgeIdx = this._edgeHitTest(pos.x, pos.y);
      this._hoveredEdge = edgeIdx !== null ? this._edges[edgeIdx] : null;
    }

    // Cursor style
    var hasTarget = this._hoveredNode || this._hoveredEdge;
    this._canvas.classList.toggle('pointer', !!hasTarget);

    // Tooltip management
    if (this._hoveredEdge && this._hoveredEdge !== prevEdge) {
      this._showEdgeTooltip(this._hoveredEdge, e);
    } else if (this._hoveredNode && this._hoveredNode !== prevNode) {
      this._showNodeTooltip(this._hoveredNode, e);
    } else if (!hasTarget) {
      this._els.tooltip.style.display = 'none';
    }

    // Reposition tooltip while hovering
    if (hasTarget && this._els.tooltip.style.display === 'block') {
      this._positionTooltip(e);
    }
  }

  _onCanvasLeave() {
    this._hoveredNode = null;
    this._hoveredEdge = null;
    this._els.tooltip.style.display = 'none';
    if (this._canvas) this._canvas.classList.remove('pointer');
  }

  _showNodeTooltip(nodeId, e) {
    var edge = this._findEdgeForNode(nodeId);
    var html = '<div class="nexus-tooltip-title">' + this._escHtml(this._displayName(nodeId)) + '</div>';
    if (edge) {
      html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">Health</span><span>' + edge.health + '</span></div>';
      html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">Volume</span><span>' + edge.volume + '</span></div>';
      html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">p50</span><span>' + this._fmtMs(edge.p50Ms) + '</span></div>';
    } else if (nodeId === 'flt-local') {
      html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">Role</span><span>Hub node</span></div>';
    }
    this._els.tooltip.innerHTML = html;
    this._els.tooltip.style.display = 'block';
    this._positionTooltip(e);
  }

  _showEdgeTooltip(edge, e) {
    var html = '<div class="nexus-tooltip-title">' + this._escHtml(this._displayName(edge.toId)) + '</div>';
    html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">Health</span><span>' + edge.health + '</span></div>';
    html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">p50 / p95</span><span>' +
      this._fmtMs(edge.p50Ms) + ' / ' + this._fmtMs(edge.p95Ms) + '</span></div>';
    html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">Error rate</span><span>' +
      this._fmtPct(edge.errorRate) + '</span></div>';
    html += '<div class="nexus-tooltip-row"><span class="nexus-tooltip-label">Throughput</span><span>' +
      (edge.throughputPerMin || 0).toFixed(1) + '/min</span></div>';
    this._els.tooltip.innerHTML = html;
    this._els.tooltip.style.display = 'block';
    this._positionTooltip(e);
  }

  _positionTooltip(e) {
    var tip = this._els.tooltip;
    var x = e.clientX + 12;
    var y = e.clientY + 12;
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    if (x + tw > window.innerWidth) x = e.clientX - tw - 8;
    if (y + th > window.innerHeight) y = e.clientY - th - 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  _onKeyDown(e) {
    if (!this._active) return;
    var rtContent = this._container.closest('.rt-tab-content');
    if (rtContent && !rtContent.classList.contains('active')) return;

    if (e.key === 'Escape') {
      if (this._selectedNode || this._selectedEdge !== null) {
        this._closeDetail();
        e.stopPropagation();
      }
    }
  }

  _onResize() {
    this._resizeCanvas();
  }

  // ═══════════════════════════════════════════════════════════════════
  // DETAIL PANEL — Slide-in from right with metrics + deep links
  // ═══════════════════════════════════════════════════════════════════

  _openNodeDetail(nodeId) {
    this._selectedNode = nodeId;
    this._selectedEdge = null;
    var edge = this._findEdgeForNode(nodeId);

    this._els.detailTitle.textContent = this._displayName(nodeId);
    if (nodeId === 'flt-local') {
      this._els.detailBody.innerHTML =
        '<div style="color:var(--text-dim);font-size:var(--text-xs);padding:var(--space-2) 0">' +
        'FLT Local is the hub node. Select a dependency node to see metrics.</div>';
      this._els.detailLinks.innerHTML = '';
    } else if (edge) {
      this._els.detailBody.innerHTML = this._renderMetricsTable(edge);
      this._els.detailLinks.innerHTML = this._renderDeepLinks(nodeId, edge);
    } else {
      this._els.detailBody.innerHTML =
        '<div style="color:var(--text-muted);font-size:var(--text-xs);padding:var(--space-2) 0">' +
        'No traffic observed for this dependency.</div>';
      this._els.detailLinks.innerHTML = '';
    }
    this._els.detail.classList.add('open');
  }

  _openEdgeDetail(edgeIdx) {
    var edge = this._edges[edgeIdx];
    if (!edge) return;
    this._selectedEdge = edge;
    this._selectedNode = edge.toId;

    this._els.detailTitle.textContent = this._displayName(edge.toId);
    this._els.detailBody.innerHTML = this._renderMetricsTable(edge);
    this._els.detailLinks.innerHTML = this._renderDeepLinks(edge.toId, edge);
    this._els.detail.classList.add('open');
  }

  _closeDetail() {
    this._selectedNode = null;
    this._selectedEdge = null;
    this._els.detail.classList.remove('open');
  }

  _renderMetricsTable(edge) {
    var fmt = this._fmtMs.bind(this);
    var pct = this._fmtPct.bind(this);
    return '<table class="nexus-metrics">' +
      '<tr><td class="nexus-metric-label">Health</td>' +
        '<td><span class="nexus-health-badge h-' + edge.health + '">' +
        edge.health + '</span></td></tr>' +
      '<tr><td class="nexus-metric-label">Volume</td><td>' +
        (edge.volume || 0) + '</td></tr>' +
      '<tr><td class="nexus-metric-label">p50</td><td>' +
        fmt(edge.p50Ms) + '</td></tr>' +
      '<tr><td class="nexus-metric-label">p95</td><td>' +
        fmt(edge.p95Ms) + '</td></tr>' +
      '<tr><td class="nexus-metric-label">p99</td><td>' +
        fmt(edge.p99Ms || edge.p95Ms) + '</td></tr>' +
      '<tr><td class="nexus-metric-label">Error rate</td><td>' +
        pct(edge.errorRate) + '</td></tr>' +
      '<tr><td class="nexus-metric-label">Retry rate</td><td>' +
        pct(edge.retryRate) + '</td></tr>' +
      '<tr><td class="nexus-metric-label">Throughput</td><td>' +
        (edge.throughputPerMin || 0).toFixed(1) + '/min</td></tr>' +
      (edge.baselineDelta > 1 ?
        '<tr><td class="nexus-metric-label">Baseline</td>' +
          '<td class="nexus-baseline-warn">' +
          edge.baselineDelta.toFixed(1) + 'x above baseline</td></tr>' : '') +
      '</table>';
  }

  _renderDeepLinks(nodeId, edge) {
    var html = '';

    // HTTP Pipeline — always available
    html += '<button class="nexus-link-btn" data-action="http" data-dep="' +
      nodeId + '">View in HTTP Pipeline \u25B8</button>';

    // Spark — only for spark-gts dependency
    if (nodeId === 'spark-gts') {
      html += '<button class="nexus-link-btn" data-action="spark">' +
        'View in Spark Sessions \u25B8</button>';
    }

    // Retries — only when retry traffic exists
    if (edge && edge.retryRate > 0) {
      html += '<button class="nexus-link-btn" data-action="retries">' +
        'View in Retries \u25B8</button>';
    }

    return html;
  }

  _onDeepLinkClick(e) {
    var btn = e.target.closest('.nexus-link-btn');
    if (!btn) return;
    var action = btn.dataset.action;
    this._closeDetail();
    if (window.edogViewer && window.edogViewer.runtimeView) {
      window.edogViewer.runtimeView.switchTab(action);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ALERTS — Toast notifications for anomaly alerts
  // ═══════════════════════════════════════════════════════════════════

  _processAlerts(alerts) {
    if (!alerts || alerts.length === 0) return;
    var seenKeys = {};
    for (var ai = 0; ai < this._alerts.length; ai++) {
      seenKeys[this._alerts[ai]._key] = true;
    }

    for (var i = 0; i < alerts.length; i++) {
      var alert = alerts[i];
      var key = (alert.dependencyId || '') + ':' + (alert.severity || '') + ':' + (alert.message || '');
      if (seenKeys[key]) continue;
      this._showAlert(alert, key);
    }
  }

  _showAlert(alert, key) {
    var el = document.createElement('div');
    el.className = 'nexus-alert ' + (alert.severity || 'warning');
    el.innerHTML =
      '<span class="nexus-alert-icon">' +
        (alert.severity === 'critical' ? '\u25C6' : '\u25C7') +
      '</span>' +
      '<span class="nexus-alert-text">' +
        this._escHtml(alert.message || '') +
      '</span>' +
      '<button class="nexus-alert-close" aria-label="Dismiss">\u2715</button>';

    this._alerts.push({ _key: key, el: el });
    this._els.alertStack.appendChild(el);

    var self = this;
    el.querySelector('.nexus-alert-close').addEventListener('click', function() {
      self._removeAlert(el);
    });

    // Auto-dismiss after 8 seconds
    setTimeout(function() { self._removeAlert(el); }, 8000);
  }

  _removeAlert(el) {
    if (!el.parentNode) return;
    el.classList.add('out');
    var self = this;
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
      self._alerts = self._alerts.filter(function(a) { return a.el !== el; });
    }, 300);
  }

  // ═══════════════════════════════════════════════════════════════════
  // TOOLBAR STATUS
  // ═══════════════════════════════════════════════════════════════════

  _updateToolbarStatus() {
    if (!this._snapshot) return;

    // Overall health = worst edge health
    var worstHealth = 'healthy';
    for (var i = 0; i < this._edges.length; i++) {
      var h = this._edges[i].health;
      if (h === 'critical') { worstHealth = 'critical'; break; }
      if (h === 'degraded') worstHealth = 'degraded';
    }

    this._els.statusDot.className = 'nexus-status-dot ' + worstHealth;
    this._els.statusLabel.textContent =
      this._nodes.size + ' node' + (this._nodes.size !== 1 ? 's' : '') +
      ' \u00B7 ' + this._edges.length + ' edge' + (this._edges.length !== 1 ? 's' : '');

    // Window label
    var ws = this._snapshot.windowSec;
    this._els.windowLabel.textContent = ws ? (ws + 's window') : '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  _displayName(depId) {
    return this._nameMap[depId] || depId;
  }

  _healthColor(health) {
    switch (health) {
      case 'healthy':  return this._cssCache.healthy || '#22c55e';
      case 'degraded': return this._cssCache.degraded || '#f59e0b';
      case 'critical': return this._cssCache.critical || '#ef4444';
      default:         return this._cssCache.textMuted || '#666';
    }
  }

  _worstEdgeColor(nodeId) {
    return this._healthColor(this._worstEdgeHealth(nodeId));
  }

  _worstEdgeHealth(nodeId) {
    var worst = 'healthy';
    for (var i = 0; i < this._edges.length; i++) {
      var e = this._edges[i];
      if (e.toId === nodeId || e.fromId === nodeId) {
        if (e.health === 'critical') return 'critical';
        if (e.health === 'degraded') worst = 'degraded';
      }
    }
    return worst;
  }

  _getNodeFill(id, isHovered) {
    return isHovered
      ? (this._cssCache.surface3 || '#282d3a')
      : (this._cssCache.surface2 || '#1c2029');
  }

  _findEdgeForNode(nodeId) {
    for (var i = 0; i < this._edges.length; i++) {
      if (this._edges[i].toId === nodeId) return this._edges[i];
    }
    return null;
  }

  _refreshCssCache() {
    var s = getComputedStyle(this._container);
    this._cssCache = {
      healthy: s.getPropertyValue('--status-succeeded').trim() || '#22c55e',
      degraded: s.getPropertyValue('--status-cancelled').trim() || '#f59e0b',
      critical: s.getPropertyValue('--status-failed').trim() || '#ef4444',
      accent: s.getPropertyValue('--accent').trim() || '#6d5cff',
      text: s.getPropertyValue('--text').trim() || '#e0e0e0',
      textDim: s.getPropertyValue('--text-dim').trim() || '#8a91a3',
      textMuted: s.getPropertyValue('--text-muted').trim() || '#555',
      surface: s.getPropertyValue('--surface').trim() || '#14171f',
      surface2: s.getPropertyValue('--surface-2').trim() || '#1c2029',
      surface3: s.getPropertyValue('--surface-3').trim() || '#282d3a',
      fontMono: s.getPropertyValue('--font-mono').trim() || 'monospace'
    };
    this._cssCacheDirty = false;
  }

  _fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '--';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  }

  _fmtPct(r) {
    if (r == null || isNaN(r)) return '--';
    return (r * 100).toFixed(1) + '%';
  }

  _escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
