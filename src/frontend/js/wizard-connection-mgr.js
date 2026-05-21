/**
 * ConnectionManager — Manages directed edges between DAG nodes.
 *
 * Renders SVG paths for connections between node ports.
 * Handles connection creation (port-to-port drag), deletion, and cycle detection.
 * Uses cubic bezier curves for smooth connection rendering.
 *
 * @author Pixel — EDOG Studio hivemind
 */

var SVG_NS = 'http://www.w3.org/2000/svg';

// eslint-disable-next-line no-unused-vars
class ConnectionManager {
  /**
   * @param {object} options
   * @param {SVGGElement} options.connectionLayer — <g class="iw-dag-connections"> element
   * @param {object} options.eventBus — WizardEventBus instance
   * @param {Function} options.getNodeById — function(nodeId) returns DagNode instance or null
   */
  constructor(options) {
    this._connectionLayer = options.connectionLayer;
    this._eventBus = options.eventBus;
    this._getNodeById = options.getNodeById;

    this._connections = {};
    this._previewPath = null;
    this._previewSource = null;
    this._previewStart = null;
    this._selectedId = null;
    this._nextId = 1;

    // Path cache: connId -> { d: string, sx: number, sy: number, tx: number, ty: number }
    this._pathCache = {};
    // When true, use straight lines instead of cubic bezier
    this._simplePaths = false;
  }

  /**
   * Add a connection. Validates: no self-loops, no duplicates, no cycles.
   * Renders the SVG path.
   * @param {object} connectionData — {id, sourceNodeId, targetNodeId}
   * @returns {boolean} true if added, false if rejected
   */
  addConnection(connectionData) {
    var src = connectionData.sourceNodeId;
    var tgt = connectionData.targetNodeId;

    // No self-loops
    if (src === tgt) return false;

    // No duplicate source->target pair
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var existing = this._connections[connIds[i]].data;
      if (existing.sourceNodeId === src && existing.targetNodeId === tgt) {
        return false;
      }
    }

    // No cycles
    if (this.wouldCreateCycle(src, tgt)) return false;

    var sourceNode = this._getNodeById(src);
    var targetNode = this._getNodeById(tgt);
    if (!sourceNode || !targetNode) return false;

    var sourcePort = sourceNode.getOutputPort();
    var targetPort = targetNode.getInputPort();
    if (!sourcePort || !targetPort) return false;

    var id = connectionData.id;
    var idNum = parseInt(id.replace('conn-', ''), 10);
    if (!isNaN(idNum) && idNum >= this._nextId) {
      this._nextId = idNum + 1;
    }

    var groupEl = this._createConnectionGroup(id, sourcePort.x, sourcePort.y, targetPort.x, targetPort.y);
    this._connectionLayer.appendChild(groupEl);

    this._connections[id] = {
      data: { id: id, sourceNodeId: src, targetNodeId: tgt },
      groupEl: groupEl
    };

    return true;
  }

  /**
   * Remove a connection by ID. Removes SVG path.
   * @param {string} connectionId
   * @returns {object|null} The removed ConnectionData, or null
   */
  removeConnection(connectionId) {
    var entry = this._connections[connectionId];
    if (!entry) return null;

    if (entry.groupEl && entry.groupEl.parentNode) {
      entry.groupEl.parentNode.removeChild(entry.groupEl);
    }

    var data = entry.data;
    delete this._connections[connectionId];
    delete this._pathCache[connectionId];

    if (this._selectedId === connectionId) {
      this._selectedId = null;
    }

    return data;
  }

  /**
   * Remove all connections involving a specific node.
   * @param {string} nodeId
   * @returns {Array} Array of removed ConnectionData objects
   */
  removeConnectionsForNode(nodeId) {
    var removed = [];
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var conn = this._connections[connIds[i]].data;
      if (conn.sourceNodeId === nodeId || conn.targetNodeId === nodeId) {
        var data = this.removeConnection(connIds[i]);
        if (data) removed.push(data);
      }
    }
    return removed;
  }

  /**
   * Update all connection paths (after node move/layout).
   * Batches DOM writes for minimal reflows.
   */
  updateAllPaths() {
    var connIds = Object.keys(this._connections);
    // Collect all path data first, then write DOM once
    var updates = [];
    for (var i = 0; i < connIds.length; i++) {
      var id = connIds[i];
      var d = this._computePathData(id);
      if (d !== null) {
        updates.push({ id: id, d: d });
      }
    }
    // Apply all DOM updates
    for (var j = 0; j < updates.length; j++) {
      var entry = this._connections[updates[j].id];
      if (!entry) continue;
      var paths = entry.groupEl.querySelectorAll('path');
      for (var k = 0; k < paths.length; k++) {
        paths[k].setAttribute('d', updates[j].d);
      }
    }
  }

  /**
   * Update paths for connections involving a specific node.
   * Only recomputes paths connected to that node.
   * @param {string} nodeId
   */
  updatePathsForNode(nodeId) {
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var conn = this._connections[connIds[i]].data;
      if (conn.sourceNodeId === nodeId || conn.targetNodeId === nodeId) {
        this._updateConnectionPath(connIds[i]);
      }
    }
  }

  /**
   * Enable or disable simple (straight-line) paths for low-zoom rendering.
   * When enabled, connections use straight lines instead of cubic bezier curves.
   * @param {boolean} simple
   */
  setSimplePaths(simple) {
    if (this._simplePaths === simple) return;
    this._simplePaths = simple;
    // Invalidate cache and redraw
    this._pathCache = {};
    this.updateAllPaths();
  }

  /**
   * Start a connection preview (during port-to-port drag).
   * @param {string} sourceNodeId
   * @param {number} startX — port center X in canvas space
   * @param {number} startY — port center Y in canvas space
   */
  startConnectionPreview(sourceNodeId, startX, startY) {
    this._removePreview();

    this._previewSource = sourceNodeId;
    this._previewStart = { x: startX, y: startY };

    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'iw-dag-connection-preview');
    path.setAttribute('d', this._calculateBezierPath(startX, startY, startX, startY));
    path.setAttribute('fill', 'none');
    this._connectionLayer.appendChild(path);
    this._previewPath = path;
  }

  /**
   * Update connection preview endpoint (mouse move during drag).
   * @param {number} endX — cursor X in canvas space
   * @param {number} endY — cursor Y in canvas space
   */
  updateConnectionPreview(endX, endY) {
    if (!this._previewPath || !this._previewStart) return;
    var d = this._calculateBezierPath(
      this._previewStart.x, this._previewStart.y,
      endX, endY
    );
    this._previewPath.setAttribute('d', d);
  }

  /**
   * End connection preview. Removes the preview path.
   * @param {string|null} targetNodeId — null if dropped on empty space (cancel)
   * @returns {object|null} Created ConnectionData, or null if cancelled/rejected
   */
  endConnectionPreview(targetNodeId) {
    var sourceNodeId = this._previewSource;
    this._removePreview();

    if (!targetNodeId || !sourceNodeId) return null;

    var id = 'conn-' + this._nextId;
    this._nextId += 1;

    var connectionData = {
      id: id,
      sourceNodeId: sourceNodeId,
      targetNodeId: targetNodeId
    };

    var added = this.addConnection(connectionData);
    if (!added) return null;

    return connectionData;
  }

  /**
   * Check if adding a connection would create a cycle.
   * DFS from targetNodeId following outgoing edges — if sourceNodeId is reachable, it's a cycle.
   * @param {string} sourceNodeId
   * @param {string} targetNodeId
   * @returns {boolean} true if cycle would be created
   */
  wouldCreateCycle(sourceNodeId, targetNodeId) {
    var visited = {};
    var stack = [targetNodeId];

    while (stack.length > 0) {
      var current = stack.pop();
      if (current === sourceNodeId) return true;
      if (visited[current]) continue;
      visited[current] = true;

      var connIds = Object.keys(this._connections);
      for (var i = 0; i < connIds.length; i++) {
        var conn = this._connections[connIds[i]].data;
        if (conn.sourceNodeId === current) {
          stack.push(conn.targetNodeId);
        }
      }
    }
    return false;
  }

  /**
   * Get all connections as an array of ConnectionData.
   * @returns {Array}
   */
  getConnections() {
    var result = [];
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      result.push(this._connections[connIds[i]].data);
    }
    return result;
  }

  /**
   * Get connections where nodeId is the source.
   * @param {string} nodeId
   * @returns {Array}
   */
  getOutgoingConnections(nodeId) {
    var result = [];
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var conn = this._connections[connIds[i]].data;
      if (conn.sourceNodeId === nodeId) result.push(conn);
    }
    return result;
  }

  /**
   * Get connections where nodeId is the target.
   * @param {string} nodeId
   * @returns {Array}
   */
  getIncomingConnections(nodeId) {
    var result = [];
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var conn = this._connections[connIds[i]].data;
      if (conn.targetNodeId === nodeId) result.push(conn);
    }
    return result;
  }

  /**
   * Walk all upstream ancestors of a node via BFS.
   * Handles diamond patterns via visited set; safe on deep graphs.
   * @param {string} nodeId
   * @returns {Array<string>} Upstream node IDs (does NOT include nodeId itself)
   */
  getUpstreamChain(nodeId) {
    var visited = {};
    var result = [];
    var queue = [nodeId];
    visited[nodeId] = true;
    while (queue.length > 0) {
      var current = queue.shift();
      var incoming = this.getIncomingConnections(current);
      for (var i = 0; i < incoming.length; i++) {
        var src = incoming[i].sourceNodeId;
        if (!visited[src]) {
          visited[src] = true;
          result.push(src);
          queue.push(src);
        }
      }
    }
    return result;
  }

  /**
   * Walk all downstream descendants of a node via BFS.
   * Handles diamond patterns via visited set; safe on deep graphs.
   * @param {string} nodeId
   * @returns {Array<string>} Downstream node IDs (does NOT include nodeId itself)
   */
  getDownstreamChain(nodeId) {
    var visited = {};
    var result = [];
    var queue = [nodeId];
    visited[nodeId] = true;
    while (queue.length > 0) {
      var current = queue.shift();
      var outgoing = this.getOutgoingConnections(current);
      for (var i = 0; i < outgoing.length; i++) {
        var tgt = outgoing[i].targetNodeId;
        if (!visited[tgt]) {
          visited[tgt] = true;
          result.push(tgt);
          queue.push(tgt);
        }
      }
    }
    return result;
  }

  /**
   * Get connection IDs forming the lineage chain (upstream + downstream)
   * for a node. Includes every edge where both endpoints are in the lineage
   * (the node, its ancestors, or its descendants).
   * @param {string} nodeId
   * @returns {Array<string>} Connection IDs
   */
  getLineageConnections(nodeId) {
    var upstream = this.getUpstreamChain(nodeId);
    var downstream = this.getDownstreamChain(nodeId);
    var inLineage = {};
    inLineage[nodeId] = true;
    var i;
    for (i = 0; i < upstream.length; i++) inLineage[upstream[i]] = true;
    for (i = 0; i < downstream.length; i++) inLineage[downstream[i]] = true;

    var result = [];
    var connIds = Object.keys(this._connections);
    for (i = 0; i < connIds.length; i++) {
      var conn = this._connections[connIds[i]].data;
      if (inLineage[conn.sourceNodeId] && inLineage[conn.targetNodeId]) {
        result.push(connIds[i]);
      }
    }
    return result;
  }

  /**
   * Add/remove the lineage highlight class on a connection's SVG group.
   * @param {string} connectionId
   * @param {boolean} active
   */
  setConnectionLineage(connectionId, active) {
    var entry = this._connections[connectionId];
    if (!entry || !entry.groupEl) return;
    if (active) {
      entry.groupEl.classList.add('iw-conn--in-lineage');
    } else {
      entry.groupEl.classList.remove('iw-conn--in-lineage');
    }
  }

  /**
   * Clear the lineage highlight class from every connection.
   */
  clearAllConnectionLineage() {
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var entry = this._connections[connIds[i]];
      if (entry && entry.groupEl) {
        entry.groupEl.classList.remove('iw-conn--in-lineage');
      }
    }
  }

  /**
   * Load connections from state (e.g., template hydration).
   * @param {Array} connections — ConnectionData[]
   */
  loadConnections(connections) {
    this._clearAll();
    for (var i = 0; i < connections.length; i++) {
      this.addConnection(connections[i]);
    }
  }

  /**
   * Select/deselect a connection visually.
   * @param {string|null} connectionId — null to clear selection
   */
  selectConnection(connectionId) {
    // Deselect previous
    if (this._selectedId && this._connections[this._selectedId]) {
      var prevGroup = this._connections[this._selectedId].groupEl;
      prevGroup.setAttribute('class', 'iw-dag-connection');
    }

    this._selectedId = connectionId;

    // Select new
    if (connectionId && this._connections[connectionId]) {
      var newGroup = this._connections[connectionId].groupEl;
      newGroup.setAttribute('class', 'iw-dag-connection iw-dag-connection-selected');
    }
  }

  /**
   * Destroy — remove all SVG elements, clean up.
   */
  destroy() {
    this._clearAll();
    this._removePreview();
    this._pathCache = {};
    this._connectionLayer = null;
    this._eventBus = null;
    this._getNodeById = null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Calculate path string for vertical-flow connection.
   * Uses cubic bezier by default, or straight line when _simplePaths is true.
   * @param {number} x1 — source X
   * @param {number} y1 — source Y
   * @param {number} x2 — target X
   * @param {number} y2 — target Y
   * @returns {string}
   */
  _calculateBezierPath(x1, y1, x2, y2) {
    if (this._simplePaths) {
      return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;
    }
    var offset = Math.max(40, Math.abs(y2 - y1) * 0.4);
    return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + offset) + ', ' + x2 + ' ' + (y2 - offset) + ', ' + x2 + ' ' + y2;
  }

  /**
   * Create SVG group with hit-area path + visible path.
   * @param {string} id — connection ID
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @returns {SVGGElement}
   */
  _createConnectionGroup(id, x1, y1, x2, y2) {
    var d = this._calculateBezierPath(x1, y1, x2, y2);
    var self = this;

    var group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'iw-dag-connection');
    group.setAttribute('data-connection-id', id);

    var hitPath = document.createElementNS(SVG_NS, 'path');
    hitPath.setAttribute('class', 'iw-dag-connection-hit');
    hitPath.setAttribute('d', d);
    hitPath.setAttribute('stroke-width', '12');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('fill', 'none');

    var linePath = document.createElementNS(SVG_NS, 'path');
    linePath.setAttribute('class', 'iw-dag-connection-line iw-conn--entering');
    linePath.setAttribute('d', d);
    linePath.setAttribute('fill', 'none');

    // Remove entering class after animation completes
    setTimeout(function() {
      linePath.classList.remove('iw-conn--entering');
    }, 300);

    hitPath.addEventListener('click', function(e) {
      e.stopPropagation();
      self.selectConnection(id);
      if (self._eventBus) {
        self._eventBus.emit('connection:selected', { connectionId: id });
      }
    });

    group.appendChild(hitPath);
    group.appendChild(linePath);

    return group;
  }

  /**
   * Compute SVG path `d` attribute for a connection, using cache.
   * Returns null if nodes/ports are unavailable.
   * @param {string} connectionId
   * @returns {string|null}
   */
  _computePathData(connectionId) {
    var entry = this._connections[connectionId];
    if (!entry) return null;

    var sourceNode = this._getNodeById(entry.data.sourceNodeId);
    var targetNode = this._getNodeById(entry.data.targetNodeId);
    if (!sourceNode || !targetNode) return null;

    var sourcePort = sourceNode.getOutputPort();
    var targetPort = targetNode.getInputPort();
    if (!sourcePort || !targetPort) return null;

    // Check cache — only recompute if port positions changed
    var cached = this._pathCache[connectionId];
    if (cached &&
        cached.sx === sourcePort.x && cached.sy === sourcePort.y &&
        cached.tx === targetPort.x && cached.ty === targetPort.y) {
      return cached.d;
    }

    var d = this._calculateBezierPath(sourcePort.x, sourcePort.y, targetPort.x, targetPort.y);
    this._pathCache[connectionId] = {
      d: d, sx: sourcePort.x, sy: sourcePort.y, tx: targetPort.x, ty: targetPort.y
    };
    return d;
  }

  /**
   * Re-read port positions and update path `d` attribute for a single connection.
   * @param {string} connectionId
   */
  _updateConnectionPath(connectionId) {
    var d = this._computePathData(connectionId);
    if (d === null) return;

    var entry = this._connections[connectionId];
    if (!entry) return;
    var paths = entry.groupEl.querySelectorAll('path');
    for (var i = 0; i < paths.length; i++) {
      paths[i].setAttribute('d', d);
    }
  }

  /**
   * Remove the preview path element from DOM and clear preview state.
   */
  _removePreview() {
    if (this._previewPath && this._previewPath.parentNode) {
      this._previewPath.parentNode.removeChild(this._previewPath);
    }
    this._previewPath = null;
    this._previewSource = null;
    this._previewStart = null;
  }

  /**
   * Remove all rendered connections from DOM and clear storage.
   */
  _clearAll() {
    var connIds = Object.keys(this._connections);
    for (var i = 0; i < connIds.length; i++) {
      var entry = this._connections[connIds[i]];
      if (entry.groupEl && entry.groupEl.parentNode) {
        entry.groupEl.parentNode.removeChild(entry.groupEl);
      }
    }
    this._connections = {};
    this._pathCache = {};
    this._selectedId = null;
  }
}

window.ConnectionManager = ConnectionManager;