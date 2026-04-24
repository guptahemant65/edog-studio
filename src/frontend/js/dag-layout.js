/**
 * DagLayout — Sugiyama layered graph layout algorithm.
 *
 * Pure algorithm module: nodes + edges in, positioned nodes + routed edges out.
 * Five steps: layer assignment, dummy insertion, crossing minimization,
 * coordinate assignment, edge routing. O(V² + E).
 */
class DagLayout {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.layerSpacing=200]      Horizontal gap between layers (px)
   * @param {number} [opts.nodeSpacing=80]         Vertical gap between nodes in a layer (px)
   * @param {number} [opts.nodeWidth=160]          Node card width (px)
   * @param {number} [opts.nodeHeight=56]          Node card height (px)
   * @param {number} [opts.edgeControlOffset=40]   Bezier control point offset (px)
   */
  constructor(opts = {}) {
    this.layerSpacing = opts.layerSpacing ?? 200;
    this.nodeSpacing = opts.nodeSpacing ?? 80;
    this.nodeWidth = opts.nodeWidth ?? 160;
    this.nodeHeight = opts.nodeHeight ?? 56;
    this.edgeControlOffset = opts.edgeControlOffset ?? 40;
  }

  /**
   * Run the full layout pipeline.
   *
   * @param {Array<{id: string, name?: string, kind?: string}>} nodes
   * @param {Array<{from: string, to: string}>} edges
   * @returns {{
   *   nodes: Array<{id: string, name: string, kind: string, x: number, y: number, w: number, h: number}>,
   *   edges: Array<{from: string, to: string, points: Array<{x: number, y: number}>}>,
   *   layers: number,
   *   bounds: {x: number, y: number, w: number, h: number}
   * }}
   */
  layout(nodes, edges) {
    if (!nodes || nodes.length === 0) {
      return { nodes: [], edges: [], layers: 0, bounds: { x: 0, y: 0, w: 0, h: 0 } };
    }

    // Filter self-edges
    const cleanEdges = edges.filter(e => e.from !== e.to);

    // Build adjacency structures
    const nodeMap = new Map();
    for (const n of nodes) {
      nodeMap.set(n.id, { ...n, _children: [], _parents: [] });
    }
    for (const e of cleanEdges) {
      const src = nodeMap.get(e.from);
      const tgt = nodeMap.get(e.to);
      if (src && tgt) {
        src._children.push(tgt.id);
        tgt._parents.push(src.id);
      }
    }

    // Step 1 — Layer assignment
    const layerOf = this._assignLayers(nodeMap);

    // Step 2 — Dummy node insertion
    const { allNodes, allEdges, dummyChains } = this._insertDummies(nodeMap, cleanEdges, layerOf);

    // Step 3 — Build layer buckets and minimize crossings
    const layerBuckets = this._buildLayerBuckets(allNodes, layerOf);
    this._minimizeCrossings(layerBuckets, allEdges, layerOf);

    // Step 4 — Coordinate assignment
    const positions = this._assignCoordinates(layerBuckets);

    // Step 5 — Edge routing
    const routedEdges = this._routeEdges(cleanEdges, dummyChains, positions, nodeMap);

    // Build final output
    const totalLayers = layerBuckets.length;
    return this._buildResult(nodes, positions, routedEdges, totalLayers);
  }

  // ── Step 1: Layer Assignment (Kahn's topological sort) ────────────────

  /**
   * Assign each node to a layer using longest-path layering.
   * @param {Map} nodeMap
   * @returns {Map<string, number>} nodeId -> layer
   */
  _assignLayers(nodeMap) {
    const layerOf = new Map();
    const inDegree = new Map();

    for (const [id, n] of nodeMap) {
      inDegree.set(id, n._parents.length);
    }

    // Seed queue with roots (in-degree 0)
    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) {
        queue.push(id);
        layerOf.set(id, 0);
      }
    }

    // BFS — assign layer = max(parent layers) + 1
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      const node = nodeMap.get(id);
      const myLayer = layerOf.get(id);

      for (const childId of node._children) {
        const childLayer = Math.max(layerOf.get(childId) ?? 0, myLayer + 1);
        layerOf.set(childId, childLayer);

        const remaining = inDegree.get(childId) - 1;
        inDegree.set(childId, remaining);
        if (remaining === 0) {
          queue.push(childId);
        }
      }
    }

    // Handle disconnected nodes with no parents and no children (isolates)
    for (const [id] of nodeMap) {
      if (!layerOf.has(id)) {
        layerOf.set(id, 0);
      }
    }

    return layerOf;
  }

  // ── Step 2: Dummy Node Insertion ──────────────────────────────────────

  /**
   * Insert dummy nodes for edges that span more than one layer.
   * @returns {{ allNodes: Map, allEdges: Array, dummyChains: Map }}
   */
  _insertDummies(nodeMap, edges, layerOf) {
    const allNodes = new Map(nodeMap);
    const allEdges = [];
    const dummyChains = new Map(); // "from->to" -> [dummyId, ...]
    let dummyCounter = 0;

    for (const e of edges) {
      const srcLayer = layerOf.get(e.from);
      const tgtLayer = layerOf.get(e.to);

      if (srcLayer == null || tgtLayer == null) continue;

      const span = tgtLayer - srcLayer;
      if (span <= 1) {
        allEdges.push({ from: e.from, to: e.to });
        continue;
      }

      // Insert chain of dummy nodes
      const chain = [];
      let prev = e.from;
      for (let layer = srcLayer + 1; layer < tgtLayer; layer++) {
        const dummyId = `__dummy_${dummyCounter++}`;
        chain.push(dummyId);
        allNodes.set(dummyId, {
          id: dummyId,
          _dummy: true,
          _edgeFrom: e.from,
          _edgeTo: e.to,
          _children: [],
          _parents: [prev],
        });
        layerOf.set(dummyId, layer);
        allEdges.push({ from: prev, to: dummyId });
        prev = dummyId;
      }
      allEdges.push({ from: prev, to: e.to });
      dummyChains.set(`${e.from}->${e.to}`, chain);
    }

    return { allNodes, allEdges, dummyChains };
  }

  // ── Step 3: Crossing Minimization (Barycenter Heuristic) ──────────────

  /** Build array-of-arrays: layerBuckets[layer] = [nodeId, ...] */
  _buildLayerBuckets(allNodes, layerOf) {
    const buckets = [];
    for (const [id] of allNodes) {
      const layer = layerOf.get(id);
      if (layer == null) continue;
      while (buckets.length <= layer) buckets.push([]);
      buckets[layer].push(id);
    }
    return buckets;
  }

  /** Two-pass barycenter crossing minimization (top-down then bottom-up). */
  _minimizeCrossings(layerBuckets, allEdges, layerOf) {
    // Build adjacency for fast lookup
    const childrenOf = new Map();
    const parentsOf = new Map();
    for (const e of allEdges) {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from).push(e.to);
      if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
      parentsOf.get(e.to).push(e.from);
    }

    // Top-down pass: order each layer based on parent positions
    for (let i = 1; i < layerBuckets.length; i++) {
      this._sortByBarycenter(layerBuckets, i, parentsOf, layerBuckets[i - 1]);
    }

    // Bottom-up pass: order each layer based on child positions
    for (let i = layerBuckets.length - 2; i >= 0; i--) {
      this._sortByBarycenter(layerBuckets, i, childrenOf, layerBuckets[i + 1]);
    }
  }

  /**
   * Sort nodes in layerBuckets[layerIdx] by their barycenter w.r.t. adjacentLayer.
   * @param {Map} adjacencyMap  Maps nodeId -> [connected nodeIds in adjacent layer]
   * @param {Array} refLayer    The adjacent layer used for position reference
   */
  _sortByBarycenter(layerBuckets, layerIdx, adjacencyMap, refLayer) {
    const posInRef = new Map();
    for (let i = 0; i < refLayer.length; i++) {
      posInRef.set(refLayer[i], i);
    }

    const barycenters = new Map();
    for (const nodeId of layerBuckets[layerIdx]) {
      const neighbors = adjacencyMap.get(nodeId) || [];
      const positions = neighbors
        .map(n => posInRef.get(n))
        .filter(p => p != null);

      if (positions.length > 0) {
        const avg = positions.reduce((a, b) => a + b, 0) / positions.length;
        barycenters.set(nodeId, avg);
      } else {
        // Keep original relative order for unconnected nodes
        barycenters.set(nodeId, layerBuckets[layerIdx].indexOf(nodeId));
      }
    }

    layerBuckets[layerIdx].sort((a, b) => barycenters.get(a) - barycenters.get(b));
  }

  // ── Step 4: Coordinate Assignment ─────────────────────────────────────

  /**
   * Assign (x, y) coordinates. Horizontal = layers, vertical = position in layer.
   * @returns {Map<string, {x: number, y: number}>}
   */
  _assignCoordinates(layerBuckets) {
    const positions = new Map();

    for (let layer = 0; layer < layerBuckets.length; layer++) {
      const bucket = layerBuckets[layer];
      const x = layer * this.layerSpacing;
      const totalHeight = (bucket.length - 1) * this.nodeSpacing;
      const startY = -totalHeight / 2;

      for (let pos = 0; pos < bucket.length; pos++) {
        positions.set(bucket[pos], {
          x,
          y: startY + pos * this.nodeSpacing,
        });
      }
    }

    return positions;
  }

  // ── Step 5: Edge Routing ──────────────────────────────────────────────

  /**
   * Route each original edge through its dummy nodes to build waypoints.
   * @returns {Array<{from: string, to: string, points: Array<{x: number, y: number}>}>}
   */
  _routeEdges(originalEdges, dummyChains, positions, nodeMap) {
    const routed = [];
    const hw = this.nodeWidth / 2;
    const hh = this.nodeHeight / 2;

    for (const e of originalEdges) {
      const srcPos = positions.get(e.from);
      const tgtPos = positions.get(e.to);
      if (!srcPos || !tgtPos) continue;

      const points = [];

      // Source: right-center of source node
      points.push({ x: srcPos.x + hw, y: srcPos.y });

      // Dummy waypoints (center of each dummy)
      const chainKey = `${e.from}->${e.to}`;
      const chain = dummyChains.get(chainKey);
      if (chain) {
        for (const dummyId of chain) {
          const dp = positions.get(dummyId);
          if (dp) points.push({ x: dp.x, y: dp.y });
        }
      }

      // Target: left-center of target node
      points.push({ x: tgtPos.x - hw, y: tgtPos.y });

      routed.push({ from: e.from, to: e.to, points });
    }

    return routed;
  }

  // ── Result Builder ────────────────────────────────────────────────────

  /** Assemble the final layout result (only real nodes, no dummies). */
  _buildResult(originalNodes, positions, routedEdges, totalLayers) {
    const positionedNodes = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const n of originalNodes) {
      const pos = positions.get(n.id);
      if (!pos) continue;

      const node = {
        id: n.id,
        name: n.name || n.id,
        kind: n.kind || 'unknown',
        x: pos.x,
        y: pos.y,
        w: this.nodeWidth,
        h: this.nodeHeight,
      };
      positionedNodes.push(node);

      // Track bounding box (using node rectangle)
      const left = pos.x - this.nodeWidth / 2;
      const right = pos.x + this.nodeWidth / 2;
      const top = pos.y - this.nodeHeight / 2;
      const bottom = pos.y + this.nodeHeight / 2;
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (top < minY) minY = top;
      if (bottom > maxY) maxY = bottom;
    }

    const bounds = positionedNodes.length > 0
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : { x: 0, y: 0, w: 0, h: 0 };

    return {
      nodes: positionedNodes,
      edges: routedEdges,
      layers: totalLayers,
      bounds,
    };
  }
}
