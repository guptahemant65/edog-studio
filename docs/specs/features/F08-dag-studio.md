# Feature 8: DAG Studio

> **Phase:** V1.1
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F08-dag-studio.md
> **Design Ref:** docs/specs/design-spec-v2.md §8

### Problem

DAG execution is the core FLT operation, but engineers currently have no visual representation of the DAG structure, no interactive way to trigger/cancel runs, and must read raw telemetry logs to understand node-level execution state.

### Objective

An interactive SVG-based DAG graph with execution controls, Gantt timeline, and run history comparison.

### Owner

**Primary:** Zara Okonkwo (JS graph rendering + controls)
**Reviewers:** Dev Patel (DAG data model), Kael Andersen (UX layout), Sana Reeves (architecture)

### Inputs

- `GET /liveTable/getLatestDag?showExtendedLineage=true` → nodes, edges, types
- `POST /liveTableSchedule/runDAG/{iterationId}` → trigger execution
- `POST /liveTableSchedule/cancelDAG/{iterationId}` → cancel execution
- Telemetry stream via WebSocket (`ActivityName === 'RunDAG'`) → execution state
- Existing `#view-dag` container with `control-panel` already wired

### Outputs

- **Files created:**
  - `src/frontend/js/dag-graph.js` — SVG DAG renderer with topological layout
  - `src/frontend/js/dag-gantt.js` — Gantt chart for per-node execution timing
- **Files modified:**
  - `src/frontend/js/control-panel.js` — Integrate with DAG graph, add run/cancel buttons
  - `src/frontend/css/dag.css` — Graph node styles, edge rendering, execution animation
  - `src/frontend/js/api-client.js` — Add `getLatestDag()`, `runDag()`, `cancelDag()` methods

### Technical Design

**JS — `dag-graph.js`:**

```
class DagGraph {
  constructor(containerEl, apiClient)

  async loadDag()                     // GET /liveTable/getLatestDag → parse nodes + edges
  renderGraph(nodes, edges)           // SVG render with topological layout
  updateNodeState(nodeId, state)      // Update node border color during execution
  selectNode(nodeId)                  // Highlight + show node detail panel
  fitToScreen()                       // Zoom to fit all nodes
  zoomIn() / zoomOut() / resetZoom()

  _topologicalSort(nodes, edges)      // Assign levels for layout
  _layoutNodes(sortedNodes)           // X/Y positions based on level + parallel count
  _renderNode(node, x, y)            // SVG rect + text + status badge
  _renderEdge(fromNode, toNode)      // SVG path with direction arrow
  _animateRunningNode(nodeEl)        // Pulsing border animation on running nodes
}
```

**JS — `dag-gantt.js`:**

```
class DagGantt {
  constructor(containerEl)

  renderGantt(executionData)          // Horizontal bars on time axis
  highlightNode(nodeId)               // Cross-highlight between graph and Gantt
  renderComparison(run1, run2)        // Side-by-side diff of two executions

  _calculateTimeScale(startTime, endTime)
  _renderBar(node, startTime, duration, status)
}
```

### Acceptance Criteria

- [ ] DAG graph renders as SVG from `getLatestDag` API response
- [ ] Nodes show name, type badge (SQL/PySpark), status-colored border
- [ ] Edges show dependency direction with arrows
- [ ] During execution: running nodes have animated/pulsing border
- [ ] Clicking a node shows detail panel (metrics, timing, error info)
- [ ] "Run DAG" button generates UUID and triggers execution
- [ ] "Cancel DAG" button cancels the active execution
- [ ] Gantt chart shows per-node execution timing as horizontal bars
- [ ] History table shows last 10 executions with click-to-load
- [ ] Zoom/pan controls work on the SVG graph
- [ ] Fit-to-screen button centers and scales the graph
- [ ] Graph handles 50+ nodes without performance degradation

### Dependencies

- **Feature 2 (Deploy):** Must be in connected phase to access FLT APIs
- **Feature 5 (Top Bar):** Service status must show "running"

### Risks

| Risk | Mitigation |
|------|------------|
| SVG rendering is slow for large DAGs (>50 nodes) | Level-based layout (no force simulation). Lazy render off-screen nodes. |
| No framework for graph layout (dagre-d3 can't be imported) | Custom topological sort + level assignment. Simple but effective. |
| Node SQL code unavailable from DAG response | Show "Code available in V2" placeholder. `codeReference` has notebook IDs for future use. |

### Moonshot Vision

V2+: Side-by-side execution comparison (Feature 15). Inline SQL viewer via Notebook API (Feature 21). DAG definition diff (show what changed between runs). DAG node right-click → "Re-run from here" (partial execution).

