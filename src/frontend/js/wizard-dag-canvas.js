/**
 * DagCanvas — Central SVG canvas for the DAG builder.
 *
 * Orchestrates DagNode instances, ConnectionManager, viewport transforms (pan/zoom),
 * and node interactions (add, remove, select, drag, connect).
 *
 * SVG structure:
 *   <svg class="iw-dag-svg">
 *     <defs>
 *       <pattern id="iw-dag-grid" ...> ... </pattern>
 *     </defs>
 *     <rect class="iw-dag-grid-bg" ... />
 *     <g class="iw-dag-root" transform="translate(panX,panY) scale(zoom)">
 *       <g class="iw-dag-connections"> ... paths ... </g>
 *       <g class="iw-dag-nodes"> ... node groups ... </g>
 *     </g>
 *   </svg>
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* global DagNode, ConnectionManager, AutoLayoutEngine, WizardEventBus, UndoRedoManager, IW_EVENTS */

var DAG_CANVAS_SVG_NS = 'http://www.w3.org/2000/svg';
var DAG_CANVAS_MAX_NODES = 100;
var DAG_CANVAS_ZOOM_MIN = 0.25;
var DAG_CANVAS_ZOOM_MAX = 4.0;
var DAG_CANVAS_ZOOM_IN_FACTOR = 1.1;
var DAG_CANVAS_ZOOM_OUT_FACTOR = 0.9;

var DAG_CANVAS_DEFAULT_NAMES = {
  'sql-table': 'table_',
  'sql-mlv': 'mlv_',
  'pyspark-mlv': 'pyspark_'
};

var DAG_CANVAS_DEFAULT_SIZES = {
  'sql-table': { width: 180, height: 72 },
  'sql-mlv': { width: 180, height: 72 },
  'pyspark-mlv': { width: 180, height: 72 }
};

class DagCanvas {

  /**
   * @param {object} options
   * @param {HTMLElement} options.containerEl — DOM element to render SVG into
   * @param {object} options.eventBus — WizardEventBus instance
   * @param {object} options.undoManager — UndoRedoManager instance
   * @param {object} [options.schemas] — enabled schemas from WizardState
   */
  constructor(options) {
    var self = this;
    this._containerEl = options.containerEl;
    this._eventBus = options.eventBus;
    this._undoManager = options.undoManager;
    this._schemas = options.schemas || { dbo: true, bronze: false, silver: false, gold: false };

    // State
    this._nodes = {};           // nodeId -> DagNode instance
    this._nodeData = {};        // nodeId -> DagNodeData plain object
    this._selectedNodeId = null;
    this._nextNodeId = 1;
    this._nextConnectionId = 1;
    this._viewport = { panX: 0, panY: 0, zoom: 1.0 };
    this._seqCounters = { 'sql-table': 0, 'sql-mlv': 0, 'pyspark-mlv': 0 };

    // Sub-components
    this._connectionMgr = null;
    this._layoutEngine = new AutoLayoutEngine();

    // SVG elements
    this._svgEl = null;
    this._rootGroup = null;
    this._nodesGroup = null;
    this._connectionsGroup = null;

    // Pan state
    this._isPanning = false;
    this._panStart = null;

    // Connection-drag state
    this._isConnecting = false;
    this._connectSourceNodeId = null;

    // Bound handlers (stored for cleanup)
    this._boundWheel = function(e) { self._onWheel(e); };
    this._boundMouseDown = function(e) { self._onMouseDown(e); };
    this._boundMouseMove = function(e) { self._onMouseMove(e); };
    this._boundMouseUp = function(e) { self._onMouseUp(e); };
    this._boundKeyDown = function(e) { self._onKeyDown(e); };
    this._boundConnectMove = function(e) { self._onConnectMove(e); };
    this._boundConnectUp = function(e) { self._onConnectUp(e); };

    // Build
    this._buildSVG();
    this._bindEvents();
  }

  /* ═══════════════════════════════════════════════════════════════
     NODE OPERATIONS
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Add a node to the canvas.
   * @param {string} type — 'sql-table' | 'sql-mlv' | 'pyspark-mlv'
   * @param {object} [position] — {x, y} in canvas space. If null, auto-place.
   * @param {object} [overrides] — partial DagNodeData to override defaults
   * @returns {object|null} The created DagNodeData, or null if at limit
   */
  addNode(type, position, overrides) {
    var self = this;

    if (Object.keys(this._nodeData).length >= DAG_CANVAS_MAX_NODES) {
      console.warn('[DagCanvas] Node limit reached (' + DAG_CANVAS_MAX_NODES + ')');
      return null;
    }

    var id = (overrides && overrides.id) || ('node-' + this._nextNodeId++);
    var seq = ++this._seqCounters[type];
    var defaultName = (DAG_CANVAS_DEFAULT_NAMES[type] || 'node_') + seq;
    var pos = position || this._getAutoPosition();
    var sizes = DAG_CANVAS_DEFAULT_SIZES[type] || { width: 180, height: 72 };

    var nodeData = {
      id: id,
      name: (overrides && overrides.name) || defaultName,
      type: type,
      schema: (overrides && overrides.schema) || 'dbo',
      x: pos.x,
      y: pos.y,
      width: (overrides && overrides.width) || sizes.width,
      height: (overrides && overrides.height) || sizes.height,
      sequenceNumber: (overrides && overrides.sequenceNumber) || seq,
      createdAt: (overrides && overrides.createdAt) || Date.now()
    };

    // Track drag-start position for undo
    var dragStartPos = null;

    var node = new DagNode({
      data: nodeData,
      parentGroup: this._nodesGroup,
      eventBus: this._eventBus,
      schemas: this._schemas,
      onSelect: function() { self.selectNode(id); },
      onDelete: function() { self.removeNode(id); },
      onDragStart: function() {
        dragStartPos = { x: nodeData.x, y: nodeData.y };
      },
      onDragMove: function(info) {
        var zoom = self._viewport.zoom;
        var newX = dragStartPos.x + (info.clientX - info.startX) / zoom;
        var newY = dragStartPos.y + (info.clientY - info.startY) / zoom;
        node.setPosition(newX, newY);
        nodeData.x = newX;
        nodeData.y = newY;
        self._connectionMgr.updatePathsForNode(id);
      },
      onDragEnd: function() {
        if (!dragStartPos) return;
        var finalX = nodeData.x;
        var finalY = nodeData.y;
        var oldX = dragStartPos.x;
        var oldY = dragStartPos.y;
        // Only push undo if position actually changed
        if (Math.abs(finalX - oldX) > 0.5 || Math.abs(finalY - oldY) > 0.5) {
          self._undoManager.push({
            name: 'move-node',
            undo: function() {
              node.setPosition(oldX, oldY);
              nodeData.x = oldX;
              nodeData.y = oldY;
              self._connectionMgr.updatePathsForNode(id);
              self._emitStateChanged();
            },
            redo: function() {
              node.setPosition(finalX, finalY);
              nodeData.x = finalX;
              nodeData.y = finalY;
              self._connectionMgr.updatePathsForNode(id);
              self._emitStateChanged();
            }
          });
          self._eventBus.emit(IW_EVENTS.NODE_MOVED, { nodeId: id, x: finalX, y: finalY });
          self._emitStateChanged();
        }
        dragStartPos = null;
      },
      onPortMouseDown: function(info) {
        self._startConnectionDrag(info.nodeId, info.x, info.y);
      },
      onPortMouseEnter: function(info) {
        if (self._isConnecting && self._connectSourceNodeId !== info.nodeId) {
          self._connectionMgr.updateConnectionPreview(info.x, info.y);
          self._connectTargetNodeId = info.nodeId;
        }
      }
    });

    this._nodes[id] = node;
    this._nodeData[id] = nodeData;

    // Undo: remove node, Redo: re-add node
    var capturedData = this._cloneNodeData(nodeData);
    this._undoManager.push({
      name: 'add-node',
      undo: function() {
        self._removeNodeInternal(id);
        self._emitStateChanged();
      },
      redo: function() {
        self.addNode(capturedData.type, { x: capturedData.x, y: capturedData.y }, capturedData);
        self._emitStateChanged();
      }
    });

    this._eventBus.emit(IW_EVENTS.NODE_ADDED, { nodeId: id, type: type });
    this._emitStateChanged();

    return nodeData;
  }

  /**
   * Remove a node and all its connections.
   * @param {string} nodeId
   * @returns {object|null} The removed DagNodeData, or null
   */
  removeNode(nodeId) {
    var self = this;
    var node = this._nodes[nodeId];
    var data = this._nodeData[nodeId];
    if (!node || !data) return null;

    // Capture state for undo
    var capturedData = this._cloneNodeData(data);
    var removedConns = this._connectionMgr.removeConnectionsForNode(nodeId);

    node.destroy();
    delete this._nodes[nodeId];
    delete this._nodeData[nodeId];

    // Clear selection if this was the selected node
    if (this._selectedNodeId === nodeId) {
      this._selectedNodeId = null;
      this._eventBus.emit(IW_EVENTS.SELECTION_CLEARED);
    }

    // Undo: re-add node and connections
    this._undoManager.push({
      name: 'remove-node',
      undo: function() {
        self.addNode(capturedData.type, { x: capturedData.x, y: capturedData.y }, capturedData);
        for (var i = 0; i < removedConns.length; i++) {
          self._connectionMgr.addConnection(removedConns[i]);
        }
        self._emitStateChanged();
      },
      redo: function() {
        self.removeNode(nodeId);
      }
    });

    this._eventBus.emit(IW_EVENTS.NODE_REMOVED, { nodeId: nodeId });
    this._emitStateChanged();

    return capturedData;
  }

  /**
   * Select a node (deselects any previously selected).
   * @param {string|null} nodeId — null to clear selection
   */
  selectNode(nodeId) {
    // Deselect previous
    if (this._selectedNodeId && this._nodes[this._selectedNodeId]) {
      this._nodes[this._selectedNodeId].setSelected(false);
    }

    // Also clear connection selection
    this._connectionMgr.selectConnection(null);

    this._selectedNodeId = nodeId;

    if (nodeId && this._nodes[nodeId]) {
      this._nodes[nodeId].setSelected(true);
      this._eventBus.emit(IW_EVENTS.NODE_SELECTED, { nodeId: nodeId });
    } else {
      this._selectedNodeId = null;
      this._eventBus.emit(IW_EVENTS.SELECTION_CLEARED);
    }
  }

  /**
   * Get the currently selected node ID.
   * @returns {string|null}
   */
  getSelectedNodeId() {
    return this._selectedNodeId;
  }

  /* ═══════════════════════════════════════════════════════════════
     CONNECTION OPERATIONS
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Add a connection between two nodes (programmatic).
   * @param {string} sourceNodeId
   * @param {string} targetNodeId
   * @returns {object|null} Created ConnectionData, or null if rejected
   */
  addConnection(sourceNodeId, targetNodeId) {
    var self = this;
    var id = 'conn-' + this._nextConnectionId++;
    var connData = { id: id, sourceNodeId: sourceNodeId, targetNodeId: targetNodeId };

    var added = this._connectionMgr.addConnection(connData);
    if (!added) {
      this._nextConnectionId--;
      return null;
    }

    this._undoManager.push({
      name: 'add-connection',
      undo: function() {
        self._connectionMgr.removeConnection(id);
        self._emitStateChanged();
      },
      redo: function() {
        self._connectionMgr.addConnection(connData);
        self._emitStateChanged();
      }
    });

    this._eventBus.emit(IW_EVENTS.CONNECTION_CREATED, connData);
    this._emitStateChanged();

    return connData;
  }

  /* ═══════════════════════════════════════════════════════════════
     VIEWPORT
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Get current viewport state.
   * @returns {{ panX: number, panY: number, zoom: number }}
   */
  getViewport() {
    return {
      panX: this._viewport.panX,
      panY: this._viewport.panY,
      zoom: this._viewport.zoom
    };
  }

  /**
   * Set viewport (e.g., from saved state or fit-to-content).
   * @param {number} panX
   * @param {number} panY
   * @param {number} zoom
   */
  setViewport(panX, panY, zoom) {
    this._viewport.panX = panX;
    this._viewport.panY = panY;
    this._viewport.zoom = Math.max(DAG_CANVAS_ZOOM_MIN, Math.min(DAG_CANVAS_ZOOM_MAX, zoom));
    this._applyViewportTransform();
    this._eventBus.emit(IW_EVENTS.ZOOM_CHANGED, this.getViewport());
  }

  /**
   * Fit all nodes into view with padding.
   */
  fitToContent() {
    var ids = Object.keys(this._nodeData);
    if (ids.length === 0) {
      this.resetViewport();
      return;
    }

    var positions = {};
    for (var i = 0; i < ids.length; i++) {
      var nd = this._nodeData[ids[i]];
      positions[ids[i]] = { x: nd.x, y: nd.y };
    }

    var rect = this._svgEl.getBoundingClientRect();
    var vp = this._layoutEngine.fitToViewport(positions, rect.width, rect.height);
    this.setViewport(vp.panX, vp.panY, vp.zoom);
  }

  /**
   * Reset viewport to default (0, 0, 1.0).
   */
  resetViewport() {
    this.setViewport(0, 0, 1.0);
  }

  /* ═══════════════════════════════════════════════════════════════
     LAYOUT
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Run auto-layout on all nodes.
   */
  autoLayout() {
    var self = this;
    var ids = Object.keys(this._nodeData);
    if (ids.length === 0) return;

    // Capture old positions for undo
    var oldPositions = {};
    var nodes = [];
    for (var i = 0; i < ids.length; i++) {
      var nd = this._nodeData[ids[i]];
      oldPositions[ids[i]] = { x: nd.x, y: nd.y };
      nodes.push({ id: nd.id, name: nd.name, type: nd.type, width: nd.width, height: nd.height });
    }

    var connections = this._connectionMgr.getConnections();
    var result = this._layoutEngine.layout(nodes, connections);
    var newPositions = result.positions;

    // Apply new positions
    this._applyPositions(newPositions);

    // Fit viewport
    var rect = this._svgEl.getBoundingClientRect();
    var vp = this._layoutEngine.fitToViewport(newPositions, rect.width, rect.height);
    this.setViewport(vp.panX, vp.panY, vp.zoom);

    // Push compound undo
    this._undoManager.push({
      name: 'auto-layout',
      undo: function() {
        self._applyPositions(oldPositions);
        self._connectionMgr.updateAllPaths();
        self._emitStateChanged();
      },
      redo: function() {
        self._applyPositions(newPositions);
        self._connectionMgr.updateAllPaths();
        self._emitStateChanged();
      }
    });

    this._connectionMgr.updateAllPaths();
    this._eventBus.emit(IW_EVENTS.LAYOUT_COMPLETE);
    this._emitStateChanged();
  }

  /* ═══════════════════════════════════════════════════════════════
     STATE
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Collect current canvas state into WizardState.
   * @param {object} state — WizardState to update
   */
  collectState(state) {
    state.nodes = [];
    var ids = Object.keys(this._nodeData);
    for (var i = 0; i < ids.length; i++) {
      var nd = this._nodeData[ids[i]];
      state.nodes.push({
        id: nd.id, name: nd.name, type: nd.type, schema: nd.schema,
        x: nd.x, y: nd.y, width: nd.width, height: nd.height,
        sequenceNumber: nd.sequenceNumber, createdAt: nd.createdAt
      });
    }
    state.connections = this._connectionMgr.getConnections();
    state.nextNodeId = this._nextNodeId;
    state.nextConnectionId = this._nextConnectionId;
    state.viewport = {
      panX: this._viewport.panX,
      panY: this._viewport.panY,
      zoom: this._viewport.zoom
    };
  }

  /**
   * Load canvas state from WizardState (template hydration / page re-enter).
   * @param {object} state — WizardState to read from
   */
  loadState(state) {
    // Clear existing
    this._clearAll();

    this._nextNodeId = state.nextNodeId || 1;
    this._nextConnectionId = state.nextConnectionId || 1;

    // Reset sequence counters
    this._seqCounters = { 'sql-table': 0, 'sql-mlv': 0, 'pyspark-mlv': 0 };

    // Restore viewport
    if (state.viewport) {
      this._viewport.panX = state.viewport.panX || 0;
      this._viewport.panY = state.viewport.panY || 0;
      this._viewport.zoom = state.viewport.zoom || 1.0;
    }

    // Recreate nodes (without pushing undo commands)
    var stateNodes = state.nodes || [];
    for (var i = 0; i < stateNodes.length; i++) {
      var sn = stateNodes[i];
      // Update sequence counters to stay consistent
      if (sn.sequenceNumber && this._seqCounters[sn.type] !== undefined) {
        if (sn.sequenceNumber > this._seqCounters[sn.type]) {
          this._seqCounters[sn.type] = sn.sequenceNumber;
        }
      }
      this._createNodeInternal(sn);
    }

    // Restore connections
    var stateConns = state.connections || [];
    this._connectionMgr.loadConnections(stateConns);

    // Apply viewport
    this._applyViewportTransform();
  }

  /**
   * Get all nodes as DagNodeData array.
   * @returns {Array}
   */
  getNodes() {
    var result = [];
    var ids = Object.keys(this._nodeData);
    for (var i = 0; i < ids.length; i++) {
      result.push(this._cloneNodeData(this._nodeData[ids[i]]));
    }
    return result;
  }

  /**
   * Get all connections as ConnectionData array.
   * @returns {Array}
   */
  getConnections() {
    return this._connectionMgr.getConnections();
  }

  /**
   * Get node count.
   * @returns {number}
   */
  getNodeCount() {
    return Object.keys(this._nodeData).length;
  }

  /* ═══════════════════════════════════════════════════════════════
     LIFECYCLE
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Get the SVG container element.
   * @returns {SVGElement}
   */
  getElement() {
    return this._svgEl;
  }

  /**
   * Destroy — remove all nodes, connections, SVG, clean up.
   */
  destroy() {
    this._clearAll();

    // Unbind SVG events
    if (this._svgEl) {
      this._svgEl.removeEventListener('wheel', this._boundWheel);
      this._svgEl.removeEventListener('mousedown', this._boundMouseDown);
    }

    // Unbind document events
    document.removeEventListener('mousemove', this._boundMouseMove);
    document.removeEventListener('mouseup', this._boundMouseUp);
    document.removeEventListener('mousemove', this._boundConnectMove);
    document.removeEventListener('mouseup', this._boundConnectUp);
    document.removeEventListener('keydown', this._boundKeyDown);

    // Destroy connection manager
    if (this._connectionMgr) {
      this._connectionMgr.destroy();
      this._connectionMgr = null;
    }

    // Remove SVG from container
    if (this._svgEl && this._svgEl.parentNode) {
      this._svgEl.parentNode.removeChild(this._svgEl);
    }

    // Null references
    this._svgEl = null;
    this._rootGroup = null;
    this._nodesGroup = null;
    this._connectionsGroup = null;
    this._containerEl = null;
    this._eventBus = null;
    this._undoManager = null;
    this._layoutEngine = null;
    this._nodes = {};
    this._nodeData = {};
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — SVG Construction
     ═══════════════════════════════════════════════════════════════ */

  _buildSVG() {
    var self = this;
    var ns = DAG_CANVAS_SVG_NS;

    // Create SVG root
    this._svgEl = document.createElementNS(ns, 'svg');
    this._svgEl.setAttribute('class', 'iw-dag-svg');
    this._svgEl.setAttribute('xmlns', ns);
    this._svgEl.setAttribute('tabindex', '0');

    // Defs — grid pattern
    var defs = document.createElementNS(ns, 'defs');
    var pattern = document.createElementNS(ns, 'pattern');
    pattern.setAttribute('id', 'iw-dag-grid');
    pattern.setAttribute('width', '20');
    pattern.setAttribute('height', '20');
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');

    var patternPath = document.createElementNS(ns, 'path');
    patternPath.setAttribute('d', 'M 20 0 L 0 0 0 20');
    patternPath.setAttribute('fill', 'none');
    patternPath.setAttribute('stroke', 'var(--border)');
    patternPath.setAttribute('stroke-width', '0.5');
    patternPath.setAttribute('opacity', '0.3');
    pattern.appendChild(patternPath);
    defs.appendChild(pattern);
    this._svgEl.appendChild(defs);

    // Grid background rect (does NOT transform with pan/zoom)
    var gridBg = document.createElementNS(ns, 'rect');
    gridBg.setAttribute('class', 'iw-dag-grid-bg');
    gridBg.setAttribute('width', '100%');
    gridBg.setAttribute('height', '100%');
    gridBg.setAttribute('fill', 'url(#iw-dag-grid)');
    this._svgEl.appendChild(gridBg);

    // Root transform group
    this._rootGroup = document.createElementNS(ns, 'g');
    this._rootGroup.setAttribute('class', 'iw-dag-root');

    // Connections layer (below nodes)
    this._connectionsGroup = document.createElementNS(ns, 'g');
    this._connectionsGroup.setAttribute('class', 'iw-dag-connections');
    this._rootGroup.appendChild(this._connectionsGroup);

    // Nodes layer
    this._nodesGroup = document.createElementNS(ns, 'g');
    this._nodesGroup.setAttribute('class', 'iw-dag-nodes');
    this._rootGroup.appendChild(this._nodesGroup);

    this._svgEl.appendChild(this._rootGroup);

    // Instantiate ConnectionManager
    // Bridge method names: ConnectionManager expects getOutputPort()/getInputPort()
    // but DagNode exposes getOutputPortPosition()/getInputPortPosition()
    this._connectionMgr = new ConnectionManager({
      connectionLayer: this._connectionsGroup,
      eventBus: this._eventBus,
      getNodeById: function(nodeId) {
        var node = self._nodes[nodeId];
        if (!node) return null;
        return {
          getOutputPort: function() { return node.getOutputPortPosition(); },
          getInputPort: function() { return node.getInputPortPosition(); }
        };
      }
    });

    // Append to container
    this._containerEl.appendChild(this._svgEl);
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Event Binding
     ═══════════════════════════════════════════════════════════════ */

  _bindEvents() {
    this._svgEl.addEventListener('wheel', this._boundWheel, { passive: false });
    this._svgEl.addEventListener('mousedown', this._boundMouseDown);
    document.addEventListener('keydown', this._boundKeyDown);
  }

  _onWheel(event) {
    event.preventDefault();

    var rect = this._svgEl.getBoundingClientRect();
    var mouseX = event.clientX - rect.left;
    var mouseY = event.clientY - rect.top;

    var oldZoom = this._viewport.zoom;
    var delta = event.deltaY > 0 ? DAG_CANVAS_ZOOM_OUT_FACTOR : DAG_CANVAS_ZOOM_IN_FACTOR;
    var newZoom = Math.max(DAG_CANVAS_ZOOM_MIN, Math.min(DAG_CANVAS_ZOOM_MAX, oldZoom * delta));

    // Adjust pan to keep point under cursor fixed
    var canvasX = (mouseX - this._viewport.panX) / oldZoom;
    var canvasY = (mouseY - this._viewport.panY) / oldZoom;
    this._viewport.zoom = newZoom;
    this._viewport.panX = mouseX - canvasX * newZoom;
    this._viewport.panY = mouseY - canvasY * newZoom;

    this._applyViewportTransform();
    this._eventBus.emit(IW_EVENTS.ZOOM_CHANGED, this.getViewport());
  }

  _onMouseDown(event) {
    // Only pan on middle-click, or left-click directly on SVG/grid background
    var isMiddle = event.button === 1;
    var isBackground = event.target === this._svgEl ||
                       event.target.classList.contains('iw-dag-grid-bg');

    if (isMiddle || (event.button === 0 && isBackground)) {
      // Left-click on background also clears selection
      if (event.button === 0 && isBackground) {
        this.selectNode(null);
      }

      this._isPanning = true;
      this._panStart = {
        x: event.clientX,
        y: event.clientY,
        panX: this._viewport.panX,
        panY: this._viewport.panY
      };

      document.addEventListener('mousemove', this._boundMouseMove);
      document.addEventListener('mouseup', this._boundMouseUp);
      event.preventDefault();
    }
  }

  _onMouseMove(event) {
    if (!this._isPanning || !this._panStart) return;

    this._viewport.panX = this._panStart.panX + (event.clientX - this._panStart.x);
    this._viewport.panY = this._panStart.panY + (event.clientY - this._panStart.y);
    this._applyViewportTransform();
  }

  _onMouseUp(event) {
    if (this._isPanning) {
      this._isPanning = false;
      this._panStart = null;
      document.removeEventListener('mousemove', this._boundMouseMove);
      document.removeEventListener('mouseup', this._boundMouseUp);
    }
  }

  _onKeyDown(event) {
    // Only handle if canvas or a child has focus
    if (!this._svgEl) return;
    if (!this._svgEl.contains(document.activeElement) && document.activeElement !== this._svgEl) {
      return;
    }

    // Delete / Backspace — remove selected node or connection
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this._selectedNodeId) {
        this.removeNode(this._selectedNodeId);
        event.preventDefault();
      }
    }

    // Ctrl+Z — undo
    if (event.key === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      this._undoManager.undo();
      event.preventDefault();
    }

    // Ctrl+Y or Ctrl+Shift+Z — redo
    if ((event.key === 'y' && (event.ctrlKey || event.metaKey)) ||
        (event.key === 'z' && (event.ctrlKey || event.metaKey) && event.shiftKey)) {
      this._undoManager.redo();
      event.preventDefault();
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Connection Drag (port-to-port)
     ═══════════════════════════════════════════════════════════════ */

  _startConnectionDrag(sourceNodeId, portX, portY) {
    this._isConnecting = true;
    this._connectSourceNodeId = sourceNodeId;
    this._connectTargetNodeId = null;

    this._connectionMgr.startConnectionPreview(sourceNodeId, portX, portY);
    this._eventBus.emit(IW_EVENTS.CONNECTION_STARTED, { sourceNodeId: sourceNodeId });

    document.addEventListener('mousemove', this._boundConnectMove);
    document.addEventListener('mouseup', this._boundConnectUp);
  }

  _onConnectMove(event) {
    if (!this._isConnecting) return;
    var pos = this._screenToCanvas(event.clientX, event.clientY);
    this._connectionMgr.updateConnectionPreview(pos.x, pos.y);
    // Reset target unless a port hover sets it
    this._connectTargetNodeId = null;
  }

  _onConnectUp(event) {
    if (!this._isConnecting) return;

    document.removeEventListener('mousemove', this._boundConnectMove);
    document.removeEventListener('mouseup', this._boundConnectUp);

    var targetNodeId = this._connectTargetNodeId;
    var result = this._connectionMgr.endConnectionPreview(targetNodeId);

    if (result) {
      // Connection was created by ConnectionManager — push undo
      var self = this;
      var connData = result;
      this._undoManager.push({
        name: 'connect-via-drag',
        undo: function() {
          self._connectionMgr.removeConnection(connData.id);
          self._emitStateChanged();
        },
        redo: function() {
          self._connectionMgr.addConnection(connData);
          self._emitStateChanged();
        }
      });
      this._eventBus.emit(IW_EVENTS.CONNECTION_CREATED, connData);
      this._emitStateChanged();
    } else {
      this._eventBus.emit(IW_EVENTS.CONNECTION_CANCELLED);
    }

    this._isConnecting = false;
    this._connectSourceNodeId = null;
    this._connectTargetNodeId = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Viewport Transform
     ═══════════════════════════════════════════════════════════════ */

  _applyViewportTransform() {
    if (!this._rootGroup) return;
    this._rootGroup.setAttribute('transform',
      'translate(' + this._viewport.panX + ', ' + this._viewport.panY + ') scale(' + this._viewport.zoom + ')');
  }

  /**
   * Convert screen coordinates to canvas space.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ x: number, y: number }}
   */
  _screenToCanvas(clientX, clientY) {
    var rect = this._svgEl.getBoundingClientRect();
    var relX = clientX - rect.left;
    var relY = clientY - rect.top;
    return {
      x: (relX - this._viewport.panX) / this._viewport.zoom,
      y: (relY - this._viewport.panY) / this._viewport.zoom
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Helpers
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Find an empty position for a new node.
   * @returns {{ x: number, y: number }}
   */
  _getAutoPosition() {
    var ids = Object.keys(this._nodeData);
    if (ids.length === 0) {
      return { x: 40, y: 40 };
    }
    var maxY = 0;
    for (var i = 0; i < ids.length; i++) {
      var nd = this._nodeData[ids[i]];
      var bottom = nd.y + nd.height;
      if (bottom > maxY) maxY = bottom;
    }
    return { x: 40, y: maxY + 60 };
  }

  /**
   * Apply a positions map to all nodes.
   * @param {object} positions — nodeId -> {x, y}
   */
  _applyPositions(positions) {
    var ids = Object.keys(positions);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var pos = positions[id];
      var node = this._nodes[id];
      var data = this._nodeData[id];
      if (node && data) {
        node.setPosition(pos.x, pos.y);
        data.x = pos.x;
        data.y = pos.y;
      }
    }
  }

  /**
   * Clone a DagNodeData object (shallow).
   * @param {object} nd
   * @returns {object}
   */
  _cloneNodeData(nd) {
    return {
      id: nd.id,
      name: nd.name,
      type: nd.type,
      schema: nd.schema,
      x: nd.x,
      y: nd.y,
      width: nd.width,
      height: nd.height,
      sequenceNumber: nd.sequenceNumber,
      createdAt: nd.createdAt
    };
  }

  /**
   * Create a node internally (no undo push, no event emit).
   * Used by loadState.
   * @param {object} nodeData — DagNodeData
   */
  _createNodeInternal(nodeData) {
    var self = this;
    var id = nodeData.id;
    var dragStartPos = null;

    var node = new DagNode({
      data: nodeData,
      parentGroup: this._nodesGroup,
      eventBus: this._eventBus,
      schemas: this._schemas,
      onSelect: function() { self.selectNode(id); },
      onDelete: function() { self.removeNode(id); },
      onDragStart: function() {
        dragStartPos = { x: nodeData.x, y: nodeData.y };
      },
      onDragMove: function(info) {
        var zoom = self._viewport.zoom;
        var newX = dragStartPos.x + (info.clientX - info.startX) / zoom;
        var newY = dragStartPos.y + (info.clientY - info.startY) / zoom;
        node.setPosition(newX, newY);
        nodeData.x = newX;
        nodeData.y = newY;
        self._connectionMgr.updatePathsForNode(id);
      },
      onDragEnd: function() {
        if (!dragStartPos) return;
        var finalX = nodeData.x;
        var finalY = nodeData.y;
        var oldX = dragStartPos.x;
        var oldY = dragStartPos.y;
        if (Math.abs(finalX - oldX) > 0.5 || Math.abs(finalY - oldY) > 0.5) {
          self._undoManager.push({
            name: 'move-node',
            undo: function() {
              node.setPosition(oldX, oldY);
              nodeData.x = oldX;
              nodeData.y = oldY;
              self._connectionMgr.updatePathsForNode(id);
              self._emitStateChanged();
            },
            redo: function() {
              node.setPosition(finalX, finalY);
              nodeData.x = finalX;
              nodeData.y = finalY;
              self._connectionMgr.updatePathsForNode(id);
              self._emitStateChanged();
            }
          });
          self._eventBus.emit(IW_EVENTS.NODE_MOVED, { nodeId: id, x: finalX, y: finalY });
          self._emitStateChanged();
        }
        dragStartPos = null;
      },
      onPortMouseDown: function(info) {
        self._startConnectionDrag(info.nodeId, info.x, info.y);
      },
      onPortMouseEnter: function(info) {
        if (self._isConnecting && self._connectSourceNodeId !== info.nodeId) {
          self._connectionMgr.updateConnectionPreview(info.x, info.y);
          self._connectTargetNodeId = info.nodeId;
        }
      }
    });

    this._nodes[id] = node;
    this._nodeData[id] = nodeData;
  }

  /**
   * Remove a node internally (no undo push, no event emit).
   * @param {string} nodeId
   */
  _removeNodeInternal(nodeId) {
    var node = this._nodes[nodeId];
    if (!node) return;

    this._connectionMgr.removeConnectionsForNode(nodeId);
    node.destroy();
    delete this._nodes[nodeId];
    delete this._nodeData[nodeId];

    if (this._selectedNodeId === nodeId) {
      this._selectedNodeId = null;
    }
  }

  /**
   * Clear all nodes and connections.
   */
  _clearAll() {
    var ids = Object.keys(this._nodes);
    for (var i = 0; i < ids.length; i++) {
      var node = this._nodes[ids[i]];
      if (node) node.destroy();
    }
    this._nodes = {};
    this._nodeData = {};
    this._selectedNodeId = null;

    if (this._connectionMgr) {
      this._connectionMgr.loadConnections([]);
    }
  }

  /**
   * Emit a generic state-changed event.
   */
  _emitStateChanged() {
    if (this._eventBus) {
      this._eventBus.emit(IW_EVENTS.STATE_CHANGED);
    }
  }
}

window.DagCanvas = DagCanvas;
