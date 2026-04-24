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
    this._highlightedNodeId = null;
    this._isPanning = false;
    this._panStart = { x: 0, y: 0 };
    this._camStart = { x: 0, y: 0 };
    this._animFrame = 0;
    this._rafId = null;
    this._paused = false;

    // Callbacks
    this.onNodeSelected = null;
    this.onNodeHovered = null;
    this.onNodeUnhovered = null;
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

  _statusColor(status) {
    return {
      pending: '#8e95a5', running: '#6d5cff', completed: '#18a058',
      failed: '#e5453b', cancelled: '#e5940c', skipped: '#8e95a5'
    }[status] || '#8e95a5';
  }

  _statusBg(status) {
    return {
      pending: 'rgba(142,149,165,0.06)', running: 'rgba(109,92,255,0.08)',
      completed: 'rgba(24,160,88,0.06)', failed: 'rgba(229,69,59,0.06)',
      cancelled: 'rgba(229,148,12,0.06)', skipped: 'rgba(142,149,165,0.04)'
    }[status] || 'rgba(142,149,165,0.06)';
  }

  /* ── Public API ── */

  setData(nodes, edges) {
    this._nodes = nodes;
    this._edges = edges;
    this._nodeMap.clear();
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
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    var pad = 80;
    var rangeX = maxX - minX + pad * 2;
    var rangeY = maxY - minY + pad * 2;
    this._camera.scale = Math.min(cw / rangeX, ch / rangeY, 1.5);
    this._camera.x = (cw - rangeX * this._camera.scale) / 2 - (minX - pad) * this._camera.scale;
    this._camera.y = (ch - rangeY * this._camera.scale) / 2 - (minY - pad) * this._camera.scale;
    if (this.onViewportChanged) this.onViewportChanged({ x: this._camera.x, y: this._camera.y, scale: this._camera.scale });
  }

  updateNodeState(nodeId, status) {
    var node = this._nodeMap.get(nodeId);
    if (!node) return;
    node.status = status;
    var el = this._nodesLayer.querySelector('[data-id="' + nodeId + '"]');
    if (el) {
      el.className = 'dag-node status-' + status;
      if (this._selectedNodeId === nodeId) el.classList.add('selected');
      if (this._highlightedNodeId === nodeId) el.classList.add('highlighted');
      var dot = el.querySelector('.dag-node-status-dot');
      if (dot) dot.style.background = this._statusColor(status);
    }
  }

  highlightNode(nodeId) {
    this.clearHighlight();
    this._highlightedNodeId = nodeId;
    var el = this._nodesLayer.querySelector('[data-id="' + nodeId + '"]');
    if (el) el.classList.add('highlighted');
  }

  clearHighlight() {
    if (this._highlightedNodeId) {
      var el = this._nodesLayer.querySelector('[data-id="' + this._highlightedNodeId + '"]');
      if (el) el.classList.remove('highlighted');
      this._highlightedNodeId = null;
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
      this._resize();
      this._startRenderLoop();
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
      el.className = 'dag-node status-' + n.status;
      el.dataset.id = n.id;
      el.dataset.layer = n.kind || 'unknown';
      el.style.cssText = 'left:' + n.x + 'px;top:' + n.y + 'px;width:' + n.w + 'px;height:' + n.h + 'px;';

      var durStr = n.duration != null ? '<span class="dag-node-dur">' + n.duration.toFixed(1) + 's</span>' : '';
      el.innerHTML = '<div class="dag-node-body">' +
        '<div class="dag-node-header">' +
          '<span class="dag-node-name">' + (n.name || n.id) + '</span>' +
          '<span class="dag-node-status-dot" style="background:' + color + '"></span>' +
        '</div>' +
        '<div class="dag-node-meta">' +
          '<span class="dag-node-badge ' + (n.kind || 'unknown').toLowerCase() + '">' + (n.kind || '') + '</span>' +
          durStr +
        '</div>' +
      '</div>';

      el.addEventListener('mousedown', (function(self, id) {
        return function(e) {
          e.stopPropagation();
          self._selectNode(id);
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
  }

  /* ── Transform & LOD ── */

  _updateNodesTransform() {
    var cam = this._camera;
    this._nodesLayer.style.transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.scale + ')';
    this._nodesLayer.style.transformOrigin = '0 0';

    var lod = this._getLOD(cam.scale);
    var nodeEls = this._nodesLayer.querySelectorAll('.dag-node');
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

      // Draw Bezier curve through points
      ctx.beginPath();
      ctx.moveTo(screenPts[0].x, screenPts[0].y);

      if (screenPts.length === 2) {
        var sx = screenPts[0].x, sy = screenPts[0].y;
        var ex = screenPts[1].x, ey = screenPts[1].y;
        var midX = (sx + ex) / 2;
        ctx.bezierCurveTo(midX, sy, midX, ey, ex, ey);
      } else {
        for (var i = 1; i < screenPts.length - 1; i++) {
          var prev = screenPts[i - 1];
          var curr = screenPts[i];
          var next = screenPts[i + 1];
          var midX2 = (curr.x + next.x) / 2;
          ctx.quadraticCurveTo(curr.x, curr.y, midX2, (curr.y + next.y) / 2);
        }
        var last = screenPts[screenPts.length - 1];
        ctx.lineTo(last.x, last.y);
      }

      // Style based on node states and selection
      var isSelected = this._selectedNodeId &&
        (edge.from === this._selectedNodeId || edge.to === this._selectedNodeId);
      var isHighlighted = this._highlightedNodeId &&
        (edge.from === this._highlightedNodeId || edge.to === this._highlightedNodeId);
      var isFailed = (fromNode && fromNode.status === 'failed') || (toNode && toNode.status === 'failed');
      var isRunning = (fromNode && fromNode.status === 'running') || (toNode && toNode.status === 'running');

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
      } else {
        ctx.strokeStyle = '#8e95a5';
        ctx.lineWidth = 1.2 * cam.scale;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([]);
      }

      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // Arrowhead at the last point
      var arrowLast = screenPts[screenPts.length - 1];
      var arrowPrev = screenPts[screenPts.length - 2];
      var angle = Math.atan2(arrowLast.y - arrowPrev.y, arrowLast.x - arrowPrev.x);
      var arrowLen = 6 * cam.scale;
      ctx.beginPath();
      ctx.moveTo(arrowLast.x, arrowLast.y);
      ctx.lineTo(arrowLast.x - arrowLen * Math.cos(angle - 0.35), arrowLast.y - arrowLen * Math.sin(angle - 0.35));
      ctx.lineTo(arrowLast.x - arrowLen * Math.cos(angle + 0.35), arrowLast.y - arrowLen * Math.sin(angle + 0.35));
      ctx.closePath();
      ctx.fillStyle = (isSelected || isHighlighted) ? '#6d5cff' : isFailed ? '#e5453b' : '#8e95a5';
      ctx.globalAlpha = (isSelected || isHighlighted) ? 0.8 : 0.55;
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
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
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
      miniCtx.moveTo(offX + (a.x + a.w - minX + pad) * scaleM, offY + (a.y + a.h / 2 - minY + pad) * scaleM);
      miniCtx.lineTo(offX + (b.x - minX + pad) * scaleM, offY + (b.y + b.h / 2 - minY + pad) * scaleM);
      miniCtx.stroke();
    }

    // Draw nodes as dots
    for (const n of this._nodes) {
      var nx = offX + (n.x + n.w / 2 - minX + pad) * scaleM;
      var ny = offY + (n.y + n.h / 2 - minY + pad) * scaleM;
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

  _render() {
    if (this._paused) return;

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

    this._rafId = requestAnimationFrame(this._render.bind(this));
  }

  _startRenderLoop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._paused = false;
    this._rafId = requestAnimationFrame(this._render.bind(this));
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
    // Deselect on canvas click
    this._selectedNodeId = null;
    this._nodesLayer.querySelectorAll('.dag-node.selected').forEach(function(el) { el.classList.remove('selected'); });
    if (this.onNodeSelected) this.onNodeSelected(null);
  }

  _onMouseMove(e) {
    if (this._isPanning) {
      this._camera.x = this._camStart.x + (e.clientX - this._panStart.x);
      this._camera.y = this._camStart.y + (e.clientY - this._panStart.y);
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
  }

  _onResize() {
    this._resize();
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
  }

  /* ── Helpers ── */

  _clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  _selectNode(nodeId) {
    this._selectedNodeId = nodeId;
    this._nodesLayer.querySelectorAll('.dag-node.selected').forEach(function(el) { el.classList.remove('selected'); });
    var el = this._nodesLayer.querySelector('[data-id="' + nodeId + '"]');
    if (el) el.classList.add('selected');
    if (this.onNodeSelected) this.onNodeSelected(nodeId);
  }
}
