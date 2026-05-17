/**
 * DagLayout — dagre-based layered graph layout.
 *
 * Thin wrapper around dagre (Sugiyama with Brandes-Kopf coordinate
 * assignment and proper crossing minimization). Translates between
 * our data model and dagre's graphlib API.
 */
class DagLayout {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.layerSpacing=200]  Horizontal gap between layers (px)
   * @param {number} [opts.nodeSpacing=80]    Vertical gap between nodes in a layer (px)
   * @param {number} [opts.nodeWidth=160]     Node card width (px)
   * @param {number} [opts.nodeHeight=56]     Node card height (px)
   */
  constructor(opts = {}) {
    this.layerSpacing = opts.layerSpacing ?? 160;
    this.nodeSpacing = opts.nodeSpacing ?? 40;
    this.nodeWidth = opts.nodeWidth ?? 160;
    this.nodeHeight = opts.nodeHeight ?? 56;
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

    var g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'LR',
      ranksep: this.layerSpacing,
      nodesep: this.nodeSpacing,
      edgesep: 20,
      marginx: 40,
      marginy: 40,
    });
    g.setDefaultEdgeLabel(function () { return {}; });

    var nodeById = new Map();
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      nodeById.set(n.id, n);
      g.setNode(n.id, { width: this.nodeWidth, height: this.nodeHeight });
    }

    var cleanEdges = [];
    for (var j = 0; j < edges.length; j++) {
      var e = edges[j];
      if (e.from !== e.to && nodeById.has(e.from) && nodeById.has(e.to)) {
        g.setEdge(e.from, e.to);
        cleanEdges.push(e);
      }
    }

    dagre.layout(g);

    // Read positioned nodes — dagre returns center coords, we keep center
    // coords since the renderer positions DOM with top-left = (x - w/2, y - h/2)
    var positionedNodes = [];
    var maxRank = 0;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    var nodeIds = g.nodes();
    for (var k = 0; k < nodeIds.length; k++) {
      var id = nodeIds[k];
      var gn = g.node(id);
      var orig = nodeById.get(id);
      if (!orig || !gn) continue;

      var rank = gn.rank || 0;
      if (rank > maxRank) maxRank = rank;

      var node = {
        id: orig.id,
        name: orig.name || orig.id,
        kind: orig.kind || 'unknown',
        tableType: orig.tableType || null,
        layer: rank,
        x: gn.x,
        y: gn.y,
        w: this.nodeWidth,
        h: this.nodeHeight,
      };
      positionedNodes.push(node);

      var left = gn.x - this.nodeWidth / 2;
      var right = gn.x + this.nodeWidth / 2;
      var top = gn.y - this.nodeHeight / 2;
      var bottom = gn.y + this.nodeHeight / 2;
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (top < minY) minY = top;
      if (bottom > maxY) maxY = bottom;
    }

    // Read routed edges — dagre provides waypoints including border connection
    var routedEdges = [];
    for (var m = 0; m < cleanEdges.length; m++) {
      var ce = cleanEdges[m];
      var ge = g.edge(ce.from, ce.to);
      if (!ge) continue;
      routedEdges.push({
        from: ce.from,
        to: ce.to,
        points: ge.points || [],
      });
    }

    var bounds = positionedNodes.length > 0
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : { x: 0, y: 0, w: 0, h: 0 };

    return {
      nodes: positionedNodes,
      edges: routedEdges,
      layers: maxRank + 1,
      bounds: bounds,
    };
  }
}
