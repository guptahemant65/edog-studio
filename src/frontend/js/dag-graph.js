/**
 * DagCanvasRenderer — hybrid DOM + Canvas renderer for DAG graph.
 *
 * Canvas 2D renders: dot grid background, Bezier edge curves with arrowheads, minimap.
 * DOM overlay renders: node cards (.dag-node divs) with CSS styling, hover, selection.
 * Camera system: pan, zoom (wheel + buttons), fit-to-screen.
 * 3-level LOD: zoom < 0.35 = dot mode, 0.35-0.7 = mini, >= 0.7 = full detail.
 */
class DagCanvasRenderer {
  /**
   * @param {HTMLElement} container - The .dag-graph-panel element
   */
  constructor(container) {
    this._container = container;
    this._canvas = container.querySelector('#dagCanvas');
    this._ctx = this._canvas.getContext('2d');
    this._miniCanvas = container.querySelector('#dagMinimap');
    this._miniCtx = this._miniCanvas.getContext('2d');
    this._nodesLayer = container.querySelector('#dagNodesLayer');

    this._camera = { x: 0, y: 0, scale: 1.0 };
    this._dpr = window.devicePixelRatio || 1;
    this._nodes = [];
    this._edges = [];
    this._nodeMap = new Map();
    this._selectedNodeId = null;
    this._selectedNodeIds = new Set();
    this._highlightedNodeId = null;
    this._isPanning = false;
    this._panStart = { x: 0, y: 0 };
    this._camStart = { x: 0, y: 0 };
    this._animFrame = 0;
    this._rafId = null;
    this._paused = false;
    this._dirty = true;       // a repaint is pending
    this._lastLOD = -1;       // last level-of-detail applied to node DOM
    this._nodeEls = null;     // cached .dag-node element list (refreshed on rebuild)
    this._renderBound = this._render.bind(this);  // bind once, not per frame

    // Callbacks
    this.onNodeSelected = null;
    this.onSelectionChanged = null;   // (nodeIds: string[]) — fires for any selection mutation
    this.onNodeHovered = null;
    this.onNodeUnhovered = null;
    this.onNodeContextMenu = null;
    this.onViewportChanged = null;

    // Bind event handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onResize = this._onResize.bind(this);

    this._bindEvents();
    this._resize();
  }

  /* ── Status helpers ── */

  /** Map numeric layer index to a named category based on position in total layers. */
  _layerName(layerIndex, totalLayers) {
    var names = ['raw', 'staging', 'transform', 'aggregate', 'report'];
    if (totalLayers <= 1) return names[0];
    var ratio = layerIndex / (totalLayers - 1);
    var idx = Math.round(ratio * (names.length - 1));
    return names[idx];
  }

  _statusColor(status) {
    return {
      pending: '#8e95a5', running: '#6d5cff', completed: '#18a058',
      failed: '#e5453b', cancelled: '#e5940c', cancelling: '#e5940c',
      skipped: '#b08d57', none: '#5b6170'
    }[status] || '#8e95a5';
  }

  _statusBg(status) {
    return {
      pending: 'rgba(142,149,165,0.06)', running: 'rgba(109,92,255,0.08)',
      completed: 'rgba(24,160,88,0.06)', failed: 'rgba(229,69,59,0.06)',
      cancelled: 'rgba(229,148,12,0.06)', cancelling: 'rgba(229,148,12,0.08)',
      skipped: 'rgba(176,141,87,0.05)', none: 'rgba(91,97,112,0.04)'
    }[status] || 'rgba(142,149,165,0.06)';
  }

  /* ── Public API ── */

  setData(nodes, edges) {
    this._nodes = nodes;
    this._edges = edges;
    this._nodeMap.clear();
    var maxLayer = 0;
    for (const n of nodes) {
      if (n.layer != null && n.layer > maxLayer) maxLayer = n.layer;
    }
    this._totalLayers = maxLayer + 1;
    for (const n of nodes) {
      n.status = n.status || 'pending';
      this._nodeMap.set(n.id, n);
    }
    this._createDOMNodes();
    this._resize();
    this.fitToScreen();
    this._startRenderLoop();
  }

  fitToScreen() {
    if (this._nodes.length === 0) return;
    var cw = this._canvas.width / this._dpr;
    var ch = this._canvas.height / this._dpr;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this._nodes) {
      minX = Math.min(minX, n.x - n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    var pad = 80;
    var rangeX = maxX - minX + pad * 2;
    var rangeY = maxY - minY + pad * 2;
    this._camera.scale = Math.min(cw / rangeX, ch / rangeY, 1.5);
    this._camera.x = (cw - rangeX * this._camera.scale) / 2 - (minX - pad) * this._camera.scale;
    this._camera.y = (ch - rangeY * this._camera.scale) / 2 - (minY - pad) * this._camera.scale;
    if (this.onViewportChanged) this.onViewportChanged({ x: this._camera.x, y: this._camera.y, scale: this._camera.scale });
    this._requestRender();
  }

  updateNodeState(nodeId, status) {
    var node = this._nodeMap.get(nodeId);
    if (!node) return;
    node.status = status;
    var el = this._nodesLayer.querySelector('[data-id="' + nodeId + '"]');
    if (el) {
      // Rebuild className but preserve the classes the (now LOD-gated) render
      // loop no longer re-applies every frame: non-executable + current LOD.
      var cls = 'dag-node status-' + status;
      if (node.executable === false) cls += ' non-executable';
      if (this._lastLOD === 1) cls += ' lod-mini';
      else if (this._lastLOD === 2) cls += ' lod-detail';
      if (this._selectedNodeIds.has(nodeId)) cls += ' selected';
      if (this._highlightedNodeId === nodeId) cls += ' highlighted';
      el.className = cls;
      var dot = el.querySelector('.dag-node-status-dot');
      if (dot) dot.style.background = this._statusColor(status);
    }
    this._requestRender();
  }

  highlightNode(nodeId) {
    this.clearHighlight();
    this._highlightedNodeId = nodeId;
    var el = this._nodesLayer.querySelector('[data-id="' + nodeId + '"]');
    if (el) el.classList.add('highlighted');
    this._requestRender();
  }

  clearHighlight() {
    if (this._highlightedNodeId) {
      var el = this._nodesLayer.querySelector('[data-id="' + this._highlightedNodeId + '"]');
      if (el) el.classList.remove('highlighted');
      this._highlightedNodeId = null;
      this._requestRender();
    }
  }

  pauseRendering() {
    this._paused = true;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  resumeRendering() {
    if (this._paused) {
      this._paused = false;
      var self = this;
      requestAnimationFrame(function() {
        self._resize();
        if (self._nodes.length > 0) self.fitToScreen();
        self._startRenderLoop();
      });
    }
  }

  destroy() {
    this.pauseRendering();
    this._canvas.removeEventListener('mousedown', this._onMouseDown);
    this._canvas.removeEventListener('mousemove', this._onMouseMove);
    this._canvas.removeEventListener('mouseup', this._onMouseUp);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
    this._container.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
    this._nodesLayer.innerHTML = '';
  }

  /* ── Resize / DPR ── */

  _resize() {
    var w = this._container.clientWidth;
    var h = this._container.clientHeight;
    if (w === 0 || h === 0) return;

    this._dpr = window.devicePixelRatio || 1;
    this._canvas.width = w * this._dpr;
    this._canvas.height = h * this._dpr;
    this._canvas.style.width = w + 'px';
    this._canvas.style.height = h + 'px';
    this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

    this._miniCanvas.width = 180 * this._dpr;
    this._miniCanvas.height = 100 * this._dpr;
    this._miniCtx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  }

  /* ── DOM node cards ── */

  _createDOMNodes() {
    this._nodesLayer.innerHTML = '';
    for (const n of this._nodes) {
      var color = this._statusColor(n.status);
      var el = document.createElement('div');
      el.className = 'dag-node status-' + n.status + (n.executable === false ? ' non-executable' : '');
      el.dataset.id = n.id;
      el.dataset.layer = this._layerName(n.layer || 0, this._totalLayers || 1);
      el.style.cssText = 'left:' + (n.x - n.w / 2) + 'px;top:' + (n.y - n.h / 2) + 'px;width:' + n.w + 'px;height:' + n.h + 'px;';

      // Badge: MLV nodes show kind (SQL/PySpark), source tables show TABLE
      var badgeText = '';
      var badgeClass = '';
      if (n.kind && n.kind.toLowerCase() !== 'unknown') {
        badgeText = n.kind.toUpperCase();
        badgeClass = n.kind.toLowerCase();
      } else if (n.tableType) {
        var tt = (typeof n.tableType === 'string' ? n.tableType : '').toUpperCase();
        if (tt === 'MATERIALIZED_LAKE_VIEW' || tt === 'MATERIALIZED_VIEW') {
          badgeText = 'MLV';
          badgeClass = 'sql';
        } else {
          badgeText = 'TABLE';
          badgeClass = 'table';
        }
      }

      var durStr = n.duration != null ? '<span class="dag-node-dur">' + n.duration.toFixed(1) + 's</span>' : '';
      el.innerHTML = '<div class="dag-node-body">' +
        '<div class="dag-node-header">' +
          '<span class="dag-node-name">' + (n.name || n.id) + '</span>' +
          '<span class="dag-node-status-dot" style="background:' + color + '"></span>' +
        '</div>' +
        '<div class="dag-node-meta">' +
          (badgeText ? '<span class="dag-node-badge ' + badgeClass + '">' + badgeText + '</span>' : '') +
          durStr +
        '</div>' +
      '</div>';

      el.addEventListener('mousedown', (function(self, nodeId, nodeEl) {
        return function(e) {
          e.stopPropagation();
          e.preventDefault();
          var mode = e.shiftKey ? 'add' : ((e.ctrlKey || e.metaKey) ? 'toggle' : 'single');
          self._selectNode(nodeId, mode);
          // Start drag tracking (only when single-selecting — shift/ctrl shouldn't drag)
          if (mode !== 'single') return;
          var node = self._nodeMap.get(nodeId);
          if (!node) return;
          var startX = e.clientX, startY = e.clientY;
          var origX = node.x, origY = node.y;
          var moved = false;

          function onMove(me) {
            var dx = (me.clientX - startX) / self._camera.scale;
            var dy = (me.clientY - startY) / self._camera.scale;
            if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            moved = true;
            node.x = origX + dx;
            node.y = origY + dy;
            nodeEl.style.left = (node.x - node.w / 2) + 'px';
            nodeEl.style.top = (node.y - node.h / 2) + 'px';
            // Update edge points that reference this node
            self._updateEdgesForNode(nodeId);
            self._requestRender();
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };
      })(this, n.id, el));

      el.addEventListener('contextmenu', (function(self, nodeId) {
        return function(e) {
          e.preventDefault();
          e.stopPropagation();
          if (self.onNodeContextMenu) self.onNodeContextMenu(nodeId, e.clientX, e.clientY);
        };
      })(this, n.id));

      el.addEventListener('mouseenter', (function(self, id) {
        return function() {
          if (self.onNodeHovered) self.onNodeHovered(id);
        };
      })(this, n.id));

      el.addEventListener('mouseleave', (function(self) {
        return function() {
          if (self.onNodeUnhovered) self.onNodeUnhovered();
        };
      })(this));

      this._nodesLayer.appendChild(el);
    }
    // Refresh the cached element list + force LOD re-apply for the new node set.
    this._nodeEls = this._nodesLayer.querySelectorAll('.dag-node');
    this._lastLOD = -1;
  }

  /* ── Transform & LOD ── */

  _updateNodesTransform() {
    var cam = this._camera;
    this._nodesLayer.style.transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.scale + ')';
    this._nodesLayer.style.transformOrigin = '0 0';

    // LOD only changes when the scale crosses a threshold. Re-applying the
    // per-node opacity/pointer/class writes every frame was the second-worst
    // lag source; gate it so the O(nodes) DOM loop runs only on LOD change.
    var lod = this._getLOD(cam.scale);
    if (lod === this._lastLOD) return;
    this._lastLOD = lod;

    var nodeEls = this._nodeEls ||
      (this._nodeEls = this._nodesLayer.querySelectorAll('.dag-node'));
    for (const el of nodeEls) {
      if (lod === 0) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      } else if (lod === 1) {
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
        el.classList.add('lod-mini');
        el.classList.remove('lod-detail');
      } else {
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
        el.classList.remove('lod-mini');
        el.classList.add('lod-detail');
      }
    }
  }

  _getLOD(scale) {
    if (scale < 0.35) return 0;
    if (scale < 0.7) return 1;
    return 2;
  }

  /* ── Canvas: dot grid ── */

  _drawGrid(w, h) {
    var ctx = this._ctx;
    var cam = this._camera;
    ctx.save();
    var spacing = 24;
    var dotR = 0.8;
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    var startX = (cam.x % (spacing * cam.scale)) - spacing * cam.scale;
    var startY = (cam.y % (spacing * cam.scale)) - spacing * cam.scale;
    for (var x = startX; x < w; x += spacing * cam.scale) {
      for (var y = startY; y < h; y += spacing * cam.scale) {
        ctx.beginPath();
        ctx.arc(x, y, dotR * cam.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ── Canvas: edges with Bezier curves ── */

  _drawEdges() {
    var ctx = this._ctx;
    var cam = this._camera;

    for (const edge of this._edges) {
      var pts = edge.points;
      if (!pts || pts.length < 2) continue;

      var fromNode = this._nodeMap.get(edge.from);
      var toNode = this._nodeMap.get(edge.to);

      // Transform points to screen coordinates
      var screenPts = pts.map(function(p) {
        return {
          x: p.x * cam.scale + cam.x,
          y: p.y * cam.scale + cam.y
        };
      });

      // Draw smooth curve through dagre waypoints.
      // dagre provides well-computed waypoints — we draw gentle curves through
      // each pair using horizontal-tension Bézier (keeps edges clean in LR layouts).
      ctx.beginPath();
      ctx.moveTo(screenPts[0].x, screenPts[0].y);

      if (screenPts.length === 2) {
        var sx = screenPts[0].x, sy = screenPts[0].y;
        var ex = screenPts[1].x, ey = screenPts[1].y;
        var gapX = Math.abs(ex - sx);
        var tension = Math.max(gapX * 0.3, 20 * cam.scale);
        ctx.bezierCurveTo(sx + tension, sy, ex - tension, ey, ex, ey);
      } else {
        // dagre gives 3+ points (start, midpoints, end). Draw a cubic Bézier
        // between each consecutive pair using horizontal tension.
        for (var i = 1; i < screenPts.length; i++) {
          var sp = screenPts[i - 1];
          var ep = screenPts[i];
          var segGap = Math.abs(ep.x - sp.x);
          var segTension = Math.max(segGap * 0.3, 15 * cam.scale);
          ctx.bezierCurveTo(sp.x + segTension, sp.y, ep.x - segTension, ep.y, ep.x, ep.y);
        }
      }

      // Style based on node states and selection
      var isSelected = this._selectedNodeId &&
        (edge.from === this._selectedNodeId || edge.to === this._selectedNodeId);
      var isHighlighted = this._highlightedNodeId &&
        (edge.from === this._highlightedNodeId || edge.to === this._highlightedNodeId);
      var isFailed = (fromNode && fromNode.status === 'failed') || (toNode && toNode.status === 'failed');
      var isRunning = (fromNode && fromNode.status === 'running') || (toNode && toNode.status === 'running');
      // Downstream of a terminal non-success node: convey the cascade by fading
      // the edge so skipped/cancelled branches read as "did not run".
      var isInert = !isFailed && !isRunning && (
        (fromNode && (fromNode.status === 'skipped' || fromNode.status === 'cancelled')) ||
        (toNode && (toNode.status === 'skipped' || toNode.status === 'cancelled')));

      if (isSelected || isHighlighted) {
        ctx.strokeStyle = '#6d5cff';
        ctx.lineWidth = 2.5 * cam.scale;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([]);
      } else if (isFailed) {
        ctx.strokeStyle = '#e5453b';
        ctx.lineWidth = 1.5 * cam.scale;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([6 * cam.scale, 4 * cam.scale]);
      } else if (isRunning) {
        ctx.strokeStyle = '#6d5cff';
        ctx.lineWidth = 1.5 * cam.scale;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([6 * cam.scale, 3 * cam.scale]);
        ctx.lineDashOffset = -this._animFrame * 0.5;
      } else if (isInert) {
        ctx.strokeStyle = '#6b7280';
        ctx.lineWidth = 1.3 * cam.scale;
        ctx.globalAlpha = 0.28;
        ctx.setLineDash([3 * cam.scale, 3 * cam.scale]);
      } else {
        ctx.strokeStyle = '#6b7280';
        ctx.lineWidth = 1.4 * cam.scale;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([]);
      }

      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // Arrowhead — use curve tangent at endpoint for accurate direction
      var arrowLen = 7 * cam.scale;
      var endPt = screenPts[screenPts.length - 1];
      // For our horizontal-dominant Bézier, the tangent at the endpoint
      // points from the last control point toward the endpoint.
      // For 2-point edges: last CP is (ex - tension, ey), so tangent ≈ horizontal.
      // For multi-point: use Catmull-Rom tangent at last segment.
      var tdx, tdy;
      if (screenPts.length === 2) {
        // Tangent is always roughly horizontal for 2-point edges
        tdx = 1; tdy = 0;
      } else {
        var prevPt = screenPts[screenPts.length - 2];
        tdx = endPt.x - prevPt.x;
        tdy = endPt.y - prevPt.y;
        var tdist = Math.sqrt(tdx * tdx + tdy * tdy);
        if (tdist < 0.1) { tdx = 1; tdy = 0; } else { tdx /= tdist; tdy /= tdist; }
      }

      // Place arrowhead slightly before the endpoint so it doesn't hide behind node card
      var tipX = endPt.x - tdx * 2 * cam.scale;
      var tipY = endPt.y - tdy * 2 * cam.scale;
      var angle = Math.atan2(tdy, tdx);
      var halfAngle = 0.4;

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - arrowLen * Math.cos(angle - halfAngle), tipY - arrowLen * Math.sin(angle - halfAngle));
      ctx.lineTo(tipX - arrowLen * Math.cos(angle + halfAngle), tipY - arrowLen * Math.sin(angle + halfAngle));
      ctx.closePath();
      ctx.fillStyle = (isSelected || isHighlighted) ? '#6d5cff' : isFailed ? '#e5453b' : '#5a6070';
      ctx.globalAlpha = (isSelected || isHighlighted) ? 0.8 : 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* ── Canvas: minimap ── */

  _drawMinimap() {
    var mw = 180, mh = 100;
    var miniCtx = this._miniCtx;
    miniCtx.clearRect(0, 0, mw, mh);
    miniCtx.fillStyle = '#ffffff';
    miniCtx.fillRect(0, 0, mw, mh);

    if (this._nodes.length === 0) return;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this._nodes) {
      minX = Math.min(minX, n.x - n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }

    var pad = 20;
    var rangeX = maxX - minX + pad * 2;
    var rangeY = maxY - minY + pad * 2;
    var scaleM = Math.min(mw / rangeX, mh / rangeY) * 0.9;
    var offX = (mw - rangeX * scaleM) / 2;
    var offY = (mh - rangeY * scaleM) / 2;

    // Draw edges
    miniCtx.strokeStyle = 'rgba(0,0,0,0.1)';
    miniCtx.lineWidth = 0.5;
    for (const edge of this._edges) {
      var a = this._nodeMap.get(edge.from);
      var b = this._nodeMap.get(edge.to);
      if (!a || !b) continue;
      miniCtx.beginPath();
      miniCtx.moveTo(offX + (a.x + a.w / 2 - minX + pad) * scaleM, offY + (a.y - minY + pad) * scaleM);
      miniCtx.lineTo(offX + (b.x - b.w / 2 - minX + pad) * scaleM, offY + (b.y - minY + pad) * scaleM);
      miniCtx.stroke();
    }

    // Draw nodes as dots
    for (const n of this._nodes) {
      var nx = offX + (n.x - minX + pad) * scaleM;
      var ny = offY + (n.y - minY + pad) * scaleM;
      miniCtx.beginPath();
      miniCtx.arc(nx, ny, 2.5, 0, Math.PI * 2);
      miniCtx.fillStyle = this._statusColor(n.status);
      miniCtx.fill();
    }

    // Viewport rect
    var cw = this._canvas.width / this._dpr;
    var ch = this._canvas.height / this._dpr;
    var cam = this._camera;
    var vx = offX + (-cam.x / cam.scale - minX + pad) * scaleM;
    var vy = offY + (-cam.y / cam.scale - minY + pad) * scaleM;
    var vw = (cw / cam.scale) * scaleM;
    var vh = (ch / cam.scale) * scaleM;
    miniCtx.strokeStyle = 'rgba(109,92,255,0.6)';
    miniCtx.lineWidth = 1.5;
    miniCtx.strokeRect(vx, vy, vw, vh);
    miniCtx.fillStyle = 'rgba(109,92,255,0.05)';
    miniCtx.fillRect(vx, vy, vw, vh);
  }

  /* ── Render loop ── */

  /**
   * Render one frame. The loop is demand-driven: it only re-schedules itself
   * while something is actually animating (a running node drives the flowing
   * edge-dash via _animFrame) or another frame was explicitly requested via
   * _requestRender(). When the DAG is idle it stops entirely instead of
   * burning a full canvas repaint at 60fps forever.
   */
  _render() {
    this._rafId = null;
    if (this._paused) return;

    var animating = this._anyRunning();
    if (!this._dirty && !animating) return;  // idle — sleep until _requestRender()
    this._dirty = false;

    this._animFrame++;
    var w = this._canvas.width / this._dpr;
    var h = this._canvas.height / this._dpr;

    this._ctx.clearRect(0, 0, w, h);
    this._ctx.fillStyle = '#f4f5f7';
    this._ctx.fillRect(0, 0, w, h);

    this._drawGrid(w, h);
    this._drawEdges();
    this._updateNodesTransform();

    // Minimap every 3rd frame
    if (this._animFrame % 3 === 0) this._drawMinimap();

    // Keep looping only while a node is running (flowing-dash animation) or a
    // frame was requested mid-render; otherwise fall idle.
    if (animating || this._dirty) {
      this._rafId = requestAnimationFrame(this._renderBound);
    }
  }

  /** Request a single repaint, waking the render loop if it is asleep. */
  _requestRender() {
    this._dirty = true;
    if (!this._rafId && !this._paused) {
      this._rafId = requestAnimationFrame(this._renderBound);
    }
  }

  /** True while any node is running (drives the per-frame edge animation). */
  _anyRunning() {
    var nodes = this._nodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].status === 'running') return true;
    }
    return false;
  }

  _startRenderLoop() {
    this._paused = false;
    this._requestRender();
  }

  /* ── Event handling ── */

  _bindEvents() {
    this._canvas.addEventListener('mousedown', this._onMouseDown);
    this._canvas.addEventListener('mousemove', this._onMouseMove);
    this._canvas.addEventListener('mouseup', this._onMouseUp);
    this._canvas.addEventListener('mouseleave', this._onMouseLeave);
    this._container.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('resize', this._onResize);

    // Zoom buttons
    var zoomIn = this._container.querySelector('#dagZoomIn');
    var zoomOut = this._container.querySelector('#dagZoomOut');
    var fitBtn = this._container.querySelector('#dagFitBtn');
    if (zoomIn) zoomIn.addEventListener('click', this._zoomAt.bind(this, 1.25));
    if (zoomOut) zoomOut.addEventListener('click', this._zoomAt.bind(this, 0.8));
    if (fitBtn) fitBtn.addEventListener('click', this.fitToScreen.bind(this));
  }

  _onMouseDown(e) {
    this._isPanning = true;
    this._panStart = { x: e.clientX, y: e.clientY };
    this._camStart = { x: this._camera.x, y: this._camera.y };
    this._canvas.style.cursor = 'grabbing';
    // Deselect on canvas click (unless modifier — keeps selection during shift-marquee in future)
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    this._selectedNodeId = null;
    this._selectedNodeIds.clear();
    this._nodesLayer.querySelectorAll('.dag-node.selected').forEach(function(el) { el.classList.remove('selected'); });
    if (this.onNodeSelected) this.onNodeSelected(null);
    if (this.onSelectionChanged) this.onSelectionChanged([]);
    this._requestRender();
  }

  _onMouseMove(e) {
    if (this._isPanning) {
      this._camera.x = this._camStart.x + (e.clientX - this._panStart.x);
      this._camera.y = this._camStart.y + (e.clientY - this._panStart.y);
      this._requestRender();
    }
  }

  _onMouseUp() {
    this._isPanning = false;
    this._canvas.style.cursor = 'default';
    if (this.onViewportChanged) this.onViewportChanged({ x: this._camera.x, y: this._camera.y, scale: this._camera.scale });
  }

  _onMouseLeave() {
    if (this._isPanning) {
      this._isPanning = false;
      this._canvas.style.cursor = 'default';
    }
  }

  _onWheel(e) {
    e.preventDefault();
    var rect = this._container.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    var newScale = this._clamp(this._camera.scale * delta, 0.15, 3.0);
    var ratio = newScale / this._camera.scale;
    this._camera.x = mx - (mx - this._camera.x) * ratio;
    this._camera.y = my - (my - this._camera.y) * ratio;
    this._camera.scale = newScale;
    if (this.onViewportChanged) this.onViewportChanged({ x: this._camera.x, y: this._camera.y, scale: this._camera.scale });
    this._requestRender();
  }

  _onResize() {
    this._resize();
    this._requestRender();
  }

  _zoomAt(factor) {
    var cw = this._canvas.width / this._dpr / 2;
    var ch = this._canvas.height / this._dpr / 2;
    var newScale = this._clamp(this._camera.scale * factor, 0.15, 3.0);
    var ratio = newScale / this._camera.scale;
    this._camera.x = cw - (cw - this._camera.x) * ratio;
    this._camera.y = ch - (ch - this._camera.y) * ratio;
    this._camera.scale = newScale;
    if (this.onViewportChanged) this.onViewportChanged({ x: this._camera.x, y: this._camera.y, scale: this._camera.scale });
    this._requestRender();
  }

  /* ── Helpers ── */

  _clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  _selectNode(nodeId, mode) {
    // mode: 'single' (default) — replace selection; 'add' — add (shift); 'toggle' — toggle (ctrl/cmd)
    mode = mode || 'single';
    var ids = this._selectedNodeIds;
    if (mode === 'single') {
      ids.clear();
      ids.add(nodeId);
      this._selectedNodeId = nodeId;
    } else if (mode === 'add') {
      ids.add(nodeId);
      // Keep _selectedNodeId as the most-recently primary-clicked node
      this._selectedNodeId = nodeId;
    } else if (mode === 'toggle') {
      if (ids.has(nodeId)) {
        ids.delete(nodeId);
        if (this._selectedNodeId === nodeId) {
          this._selectedNodeId = ids.size ? ids.values().next().value : null;
        }
      } else {
        ids.add(nodeId);
        this._selectedNodeId = nodeId;
      }
    }
    // Repaint selection classes
    var self = this;
    this._nodesLayer.querySelectorAll('.dag-node.selected').forEach(function(el) { el.classList.remove('selected'); });
    ids.forEach(function(id) {
      var el = self._nodesLayer.querySelector('[data-id="' + id + '"]');
      if (el) el.classList.add('selected');
    });
    if (this.onNodeSelected) this.onNodeSelected(this._selectedNodeId);
    if (this.onSelectionChanged) this.onSelectionChanged(Array.from(ids));
    this._requestRender();
  }

  /** Returns the current multi-selection as a plain array (may be empty). */
  getSelectedNodeIds() {
    return Array.from(this._selectedNodeIds);
  }

  /** Recalculate edge endpoints when a node is dragged. */
  _updateEdgesForNode(nodeId) {
    var node = this._nodeMap.get(nodeId);
    if (!node) return;
    var hw = node.w / 2;
    for (var i = 0; i < this._edges.length; i++) {
      var edge = this._edges[i];
      if (edge.from === nodeId) {
        // Update source point (right-center)
        if (edge.points && edge.points.length >= 1) {
          edge.points[0] = { x: node.x + hw, y: node.y };
        }
      }
      if (edge.to === nodeId) {
        // Update target point (left-center)
        if (edge.points && edge.points.length >= 2) {
          edge.points[edge.points.length - 1] = { x: node.x - hw, y: node.y };
        }
      }
    }
  }
}
