/**
 * AutoLayoutEngine — Sugiyama-lite layout for DAG nodes.
 *
 * Hand-rolled layout engine (no Dagre dependency for MVP).
 * Algorithm: topological sort → rank by depth → group by rank → fixed spacing → center ranks.
 *
 * @author Pixel — EDOG Studio hivemind
 */

var AutoLayoutEngine = (function () {
  'use strict';

  // ── Layout constants ──────────────────────────────────────────────
  var NODE_WIDTH = 180;
  var NODE_HEIGHT = 72;
  var HORIZONTAL_GAP = 60;
  var VERTICAL_GAP = 80;
  var PADDING = 40;
  var MIN_ZOOM = 0.25;
  var MAX_ZOOM = 4.0;

  function AutoLayoutEngine() {
    this._nodeWidth = NODE_WIDTH;
    this._nodeHeight = NODE_HEIGHT;
    this._horizontalGap = HORIZONTAL_GAP;
    this._verticalGap = VERTICAL_GAP;
    this._padding = PADDING;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Compute positions for all nodes.
   * @param {Array} nodes  — DagNodeData[] from WizardState
   * @param {Array} connections — ConnectionData[] from WizardState
   * @returns {{ positions: Object<string, {x: number, y: number}>, viewport: {panX: number, panY: number, zoom: number} }}
   */
  AutoLayoutEngine.prototype.layout = function (nodes, connections) {
    if (!nodes || nodes.length === 0) {
      return { positions: {}, viewport: { panX: 0, panY: 0, zoom: 1.0 } };
    }

    // Single node fast-path
    if (nodes.length === 1) {
      var singleId = nodes[0].id;
      var positions = {};
      positions[singleId] = { x: this._padding, y: this._padding };
      return { positions: positions, viewport: { panX: 0, panY: 0, zoom: 1.0 } };
    }

    var conns = connections || [];

    // Discover disconnected components and lay them out independently
    var components = this._findComponents(nodes, conns);

    if (components.length === 1) {
      return this._layoutComponent(components[0].nodes, conns);
    }

    // Multiple disconnected components — lay them out side by side
    return this._layoutMultipleComponents(components, conns);
  };

  /**
   * Calculate viewport to fit all nodes.
   * @param {Object} positions — node ID -> {x, y}
   * @param {number} canvasWidth  — available canvas width
   * @param {number} canvasHeight — available canvas height
   * @returns {{ panX: number, panY: number, zoom: number }}
   */
  AutoLayoutEngine.prototype.fitToViewport = function (positions, canvasWidth, canvasHeight) {
    var ids = Object.keys(positions);
    if (ids.length === 0) {
      return { panX: 0, panY: 0, zoom: 1.0 };
    }

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;

    for (var i = 0; i < ids.length; i++) {
      var pos = positions[ids[i]];
      if (pos.x < minX) { minX = pos.x; }
      if (pos.y < minY) { minY = pos.y; }
      if (pos.x + this._nodeWidth > maxX) { maxX = pos.x + this._nodeWidth; }
      if (pos.y + this._nodeHeight > maxY) { maxY = pos.y + this._nodeHeight; }
    }

    // Add padding on all sides
    minX -= this._padding;
    minY -= this._padding;
    maxX += this._padding;
    maxY += this._padding;

    var boundingWidth = maxX - minX;
    var boundingHeight = maxY - minY;

    // Calculate zoom to fit
    var zoom = Math.min(canvasWidth / boundingWidth, canvasHeight / boundingHeight);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

    // Center the bounding box in the canvas
    var centerX = (minX + maxX) / 2;
    var centerY = (minY + maxY) / 2;
    var panX = (canvasWidth / 2) - (centerX * zoom);
    var panY = (canvasHeight / 2) - (centerY * zoom);

    return { panX: panX, panY: panY, zoom: zoom };
  };

  // ── Internal: Component discovery ─────────────────────────────────

  /**
   * Find disconnected components via union-find.
   * @param {Array} nodes
   * @param {Array} connections
   * @returns {Array<{nodes: Array}>}
   */
  AutoLayoutEngine.prototype._findComponents = function (nodes, connections) {
    var nodeMap = {};
    var parent = {};

    for (var i = 0; i < nodes.length; i++) {
      var nid = nodes[i].id;
      nodeMap[nid] = nodes[i];
      parent[nid] = nid;
    }

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }

    function union(a, b) {
      var ra = find(a);
      var rb = find(b);
      if (ra !== rb) { parent[ra] = rb; }
    }

    for (var c = 0; c < connections.length; c++) {
      var conn = connections[c];
      if (nodeMap[conn.sourceNodeId] && nodeMap[conn.targetNodeId]) {
        union(conn.sourceNodeId, conn.targetNodeId);
      }
    }

    // Group by root
    var groups = {};
    for (var j = 0; j < nodes.length; j++) {
      var root = find(nodes[j].id);
      if (!groups[root]) { groups[root] = []; }
      groups[root].push(nodes[j]);
    }

    var components = [];
    var keys = Object.keys(groups);
    for (var k = 0; k < keys.length; k++) {
      components.push({ nodes: groups[keys[k]] });
    }
    return components;
  };

  // ── Internal: Layout a single connected component ─────────────────

  AutoLayoutEngine.prototype._layoutComponent = function (nodes, allConnections) {
    // Filter connections to only those within this component
    var nodeSet = {};
    for (var i = 0; i < nodes.length; i++) {
      nodeSet[nodes[i].id] = true;
    }
    var conns = [];
    for (var c = 0; c < allConnections.length; c++) {
      var conn = allConnections[c];
      if (nodeSet[conn.sourceNodeId] && nodeSet[conn.targetNodeId]) {
        conns.push(conn);
      }
    }

    var sortedIds = this._topologicalSort(nodes, conns);
    var ranks = this._assignRanks(sortedIds, conns);
    var positions = this._calculatePositions(ranks, sortedIds);
    positions = this._centerRanks(positions, ranks);

    return { positions: positions, viewport: { panX: 0, panY: 0, zoom: 1.0 } };
  };

  // ── Internal: Layout multiple disconnected components side by side ─

  AutoLayoutEngine.prototype._layoutMultipleComponents = function (components, connections) {
    var allPositions = {};
    var offsetX = 0;

    for (var i = 0; i < components.length; i++) {
      var result = this._layoutComponent(components[i].nodes, connections);
      var compPositions = result.positions;
      var ids = Object.keys(compPositions);

      // Find bounding box of this component
      var minX = Infinity;
      var maxX = -Infinity;
      for (var j = 0; j < ids.length; j++) {
        var pos = compPositions[ids[j]];
        if (pos.x < minX) { minX = pos.x; }
        if (pos.x + this._nodeWidth > maxX) { maxX = pos.x + this._nodeWidth; }
      }

      // Shift component to avoid overlap
      var shiftX = offsetX - minX;
      for (var k = 0; k < ids.length; k++) {
        allPositions[ids[k]] = {
          x: compPositions[ids[k]].x + shiftX,
          y: compPositions[ids[k]].y
        };
      }

      offsetX = offsetX + (maxX - minX) + this._horizontalGap;
    }

    return { positions: allPositions, viewport: { panX: 0, panY: 0, zoom: 1.0 } };
  };

  // ── Phase 1: Topological Sort (Kahn's algorithm) ──────────────────

  /**
   * @param {Array} nodes
   * @param {Array} connections
   * @returns {Array<string>} sorted node IDs
   */
  AutoLayoutEngine.prototype._topologicalSort = function (nodes, connections) {
    var adjacency = {};   // source -> [targets]
    var inDegree = {};

    // Initialize
    for (var i = 0; i < nodes.length; i++) {
      var nid = nodes[i].id;
      adjacency[nid] = [];
      inDegree[nid] = 0;
    }

    // Build graph
    for (var c = 0; c < connections.length; c++) {
      var src = connections[c].sourceNodeId;
      var tgt = connections[c].targetNodeId;
      if (adjacency[src] && inDegree[tgt] !== undefined) {
        adjacency[src].push(tgt);
        inDegree[tgt] = inDegree[tgt] + 1;
      }
    }

    // Build lookup for tiebreaking
    var nodeById = {};
    for (var n = 0; n < nodes.length; n++) {
      nodeById[nodes[n].id] = nodes[n];
    }

    // Tiebreak comparator: createdAt ascending, then id ascending
    function tiebreak(a, b) {
      var nodeA = nodeById[a];
      var nodeB = nodeById[b];
      var tA = nodeA && nodeA.createdAt ? nodeA.createdAt : '';
      var tB = nodeB && nodeB.createdAt ? nodeB.createdAt : '';
      if (tA < tB) { return -1; }
      if (tA > tB) { return 1; }
      if (a < b) { return -1; }
      if (a > b) { return 1; }
      return 0;
    }

    // Collect initial zero in-degree nodes
    var queue = [];
    var allIds = Object.keys(inDegree);
    for (var q = 0; q < allIds.length; q++) {
      if (inDegree[allIds[q]] === 0) {
        queue.push(allIds[q]);
      }
    }
    queue.sort(tiebreak);

    var result = [];
    while (queue.length > 0) {
      var current = queue.shift();
      result.push(current);

      var neighbors = adjacency[current];
      var newReady = [];
      for (var nb = 0; nb < neighbors.length; nb++) {
        inDegree[neighbors[nb]] = inDegree[neighbors[nb]] - 1;
        if (inDegree[neighbors[nb]] === 0) {
          newReady.push(neighbors[nb]);
        }
      }

      if (newReady.length > 0) {
        newReady.sort(tiebreak);
        // Insert into queue maintaining sorted order
        for (var nr = 0; nr < newReady.length; nr++) {
          var inserted = false;
          for (var qi = 0; qi < queue.length; qi++) {
            if (tiebreak(newReady[nr], queue[qi]) < 0) {
              queue.splice(qi, 0, newReady[nr]);
              inserted = true;
              break;
            }
          }
          if (!inserted) { queue.push(newReady[nr]); }
        }
      }
    }

    // Cycle detection: if we didn't visit all nodes, there is a cycle
    // Return what we have (graceful degradation)
    if (result.length < nodes.length) {
      // Append remaining nodes that were not reachable (cycle participants)
      var inResult = {};
      for (var r = 0; r < result.length; r++) {
        inResult[result[r]] = true;
      }
      for (var m = 0; m < nodes.length; m++) {
        if (!inResult[nodes[m].id]) {
          result.push(nodes[m].id);
        }
      }
    }

    return result;
  };

  // ── Phase 2: Rank Assignment ──────────────────────────────────────

  /**
   * Assign rank (depth) to each node. Roots = rank 0.
   * rank[node] = max(rank[parent] + 1) for each incoming edge.
   *
   * @param {Array<string>} sortedIds — topologically sorted node IDs
   * @param {Array} connections
   * @returns {Object<string, number>} node ID -> rank
   */
  AutoLayoutEngine.prototype._assignRanks = function (sortedIds, connections) {
    // Build reverse adjacency: target -> [sources]
    var incoming = {};
    for (var i = 0; i < sortedIds.length; i++) {
      incoming[sortedIds[i]] = [];
    }
    for (var c = 0; c < connections.length; c++) {
      var tgt = connections[c].targetNodeId;
      var src = connections[c].sourceNodeId;
      if (incoming[tgt]) {
        incoming[tgt].push(src);
      }
    }

    var ranks = {};
    for (var s = 0; s < sortedIds.length; s++) {
      var nid = sortedIds[s];
      var parents = incoming[nid];
      if (!parents || parents.length === 0) {
        ranks[nid] = 0;
      } else {
        var maxParentRank = 0;
        for (var p = 0; p < parents.length; p++) {
          var parentRank = ranks[parents[p]];
          if (parentRank !== undefined && parentRank + 1 > maxParentRank) {
            maxParentRank = parentRank + 1;
          }
        }
        ranks[nid] = maxParentRank;
      }
    }

    return ranks;
  };

  // ── Phase 3: Position Calculation ─────────────────────────────────

  /**
   * Calculate x,y positions for each node.
   * Nodes are grouped by rank, ordered within rank by topo-sort position.
   *
   * @param {Object<string, number>} ranks — node ID -> rank
   * @param {Array<string>} sortedIds — topo-sort order (determines intra-rank ordering)
   * @returns {Object<string, {x: number, y: number}>}
   */
  AutoLayoutEngine.prototype._calculatePositions = function (ranks, sortedIds) {
    // Group nodes by rank, preserving topo-sort order
    var rankGroups = {};
    var maxRank = 0;

    for (var i = 0; i < sortedIds.length; i++) {
      var nid = sortedIds[i];
      var rank = ranks[nid];
      if (rank === undefined) { rank = 0; }
      if (!rankGroups[rank]) { rankGroups[rank] = []; }
      rankGroups[rank].push(nid);
      if (rank > maxRank) { maxRank = rank; }
    }

    var positions = {};

    for (var r = 0; r <= maxRank; r++) {
      var group = rankGroups[r];
      if (!group) { continue; }

      var y = this._padding + r * (this._nodeHeight + this._verticalGap);

      for (var g = 0; g < group.length; g++) {
        var x = this._padding + g * (this._nodeWidth + this._horizontalGap);
        positions[group[g]] = { x: x, y: y };
      }
    }

    return positions;
  };

  // ── Phase 4: Center Ranks ─────────────────────────────────────────

  /**
   * Center each rank horizontally relative to the widest rank.
   *
   * @param {Object<string, {x: number, y: number}>} positions
   * @param {Object<string, number>} ranks — node ID -> rank
   * @returns {Object<string, {x: number, y: number}>} adjusted positions
   */
  AutoLayoutEngine.prototype._centerRanks = function (positions, ranks) {
    // Group node IDs by rank
    var rankGroups = {};
    var maxRank = 0;
    var ids = Object.keys(ranks);

    for (var i = 0; i < ids.length; i++) {
      var rank = ranks[ids[i]];
      if (!rankGroups[rank]) { rankGroups[rank] = []; }
      rankGroups[rank].push(ids[i]);
      if (rank > maxRank) { maxRank = rank; }
    }

    // Find the width of each rank and the widest rank
    var widestWidth = 0;

    for (var r = 0; r <= maxRank; r++) {
      var group = rankGroups[r];
      if (!group || group.length === 0) { continue; }
      var rankWidth = group.length * this._nodeWidth + (group.length - 1) * this._horizontalGap;
      if (rankWidth > widestWidth) { widestWidth = rankWidth; }
    }

    // Center each rank relative to the widest rank
    for (var cr = 0; cr <= maxRank; cr++) {
      var crGroup = rankGroups[cr];
      if (!crGroup || crGroup.length === 0) { continue; }
      var currentWidth = crGroup.length * this._nodeWidth + (crGroup.length - 1) * this._horizontalGap;
      var offset = (widestWidth - currentWidth) / 2;

      for (var g = 0; g < crGroup.length; g++) {
        var nid = crGroup[g];
        positions[nid] = {
          x: this._padding + offset + g * (this._nodeWidth + this._horizontalGap),
          y: positions[nid].y
        };
      }
    }

    return positions;
  };

  return AutoLayoutEngine;
})();

window.AutoLayoutEngine = AutoLayoutEngine;
