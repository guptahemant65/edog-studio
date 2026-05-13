# F08 DAG Studio — Architecture Spec

> **Author:** Sana Reeves (Architecture Lead)
> **Reviewers:** Vex (Backend), Pixel (Frontend), Sentinel (QA)
> **Date:** 2026-04-17
> **Status:** DRAFT
> **Prerequisite Reading:** `spec.md` §3, `research/p0-foundation.md`, `docs/specs/SIGNALR_PROTOCOL.md`
> **Design System:** Light theme tokens — reference by name, never raw hex.

---

## 1. End-to-End Data Flow

```
                            ┌──────────────────────────────────────────────────┐
                            │               FLT Service Process               │
                            │  ┌─────────────────┐   ┌──────────────────────┐ │
                            │  │  FLT REST APIs   │   │  EdogPlaygroundHub   │ │
                            │  │  /liveTable/*     │   │  /hub/playground     │ │
                            │  │  /liveTableSched* │   │  (SignalR, :5557)    │ │
                            │  └────────┬─────────┘   └──────────┬───────────┘ │
                            └───────────┼─────────────────────────┼────────────┘
                                        │                         │
                       ┌────────────────┤                         │
                       │  MWC-authenticated                       │  WebSocket
                       │  (direct from browser)                   │  (direct)
                       ▼                                          ▼
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│  dev-server.py (:5555)           │       │  SignalRManager                  │
│  /api/flt/config → config+tokens │       │  .subscribeTopic('telemetry')    │
│  /api/dag/*      → FLT proxy     │       │  .subscribeTopic('log')          │
└────────────┬─────────────────────┘       └──────────┬───────────────────────┘
             │                                        │
             ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  FabricApiClient (api-client.js) — 13 DAG methods                           │
│  .getLatestDag()  .getDagExecMetrics(id)  .getDagExecStatus(id)             │
│  .runDag(id)  .cancelDag(id)  .listDagExecutions(opts)                      │
│  .getLockedExecution()  .forceUnlockDag(id)  .getDagSettings()              │
│  .updateDagSettings(body)  .listMlvDefinitions()  .createMlvDefinition(body)│
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  DagStudio (dag-studio.js) — ORCHESTRATOR                                    │
│  ._loadDag()             → DagLayout → DagCanvasRenderer.setData()          │
│  ._runDag()              → FabricApiClient.runDag() → subscribe updates     │
│  ._onTelemetryEvent(evt) → ExecutionStateManager.processTelemetry()         │
│  ._onLogEntry(entry)     → AutoDetector.processLog()                        │
│  ._onExecutionUpdated()  → DagCanvasRenderer + DagGantt + ControlsBar      │
└──────────────┬────────────────┬──────────────────┬──────────────────────────┘
               ▼                ▼                  ▼
┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐ ┌──────────────┐
│ DagCanvasRenderer│ │ DagGantt         │ │ ControlsBar    │ │ HistoryPanel │
│ (dag-graph.js)   │ │ (dag-gantt.js)   │ │ (dag-studio.js)│ │ (dag-studio) │
│ Canvas 2D + LOD  │ │ Canvas 2D bars   │ │ Run/Cancel/etc │ │ Past runs    │
└──────────────────┘ └──────────────────┘ └────────────────┘ └──────────────┘
```

### Data Flow Narratives

**Flow 1 — Initial Load**

```
1. User clicks DAG Studio → DagStudio.activate()
2. → fetchConfig()                               // refresh MWC tokens
3. → getLatestDag()                               // GET direct to FLT
4. → DagLayout.layout(dag.nodes, dag.edges)       // Sugiyama → positions
5. → DagCanvasRenderer.setData(positioned)        // first render
6. → DagCanvasRenderer.fitToScreen()              // auto-center, 40px padding
7. → listDagExecutions({historyCount: 20})        // populate history
8. → HistoryPanel.render(iterations)
9. → _checkLockState()                            // detect stuck locks
10. → subscribeTopic('telemetry') + ('log')       // start real-time streams
```

**Flow 2 — Run DAG**

```
1. User clicks "Run DAG"
2. → iterationId = crypto.randomUUID()
3. → runDag(iterationId)                          // POST → 202 Accepted
4. → ExecutionStateManager.startTracking(iterationId)
5. → ControlsBar: disable Run, enable Cancel, show "Running"
6. → All executable nodes → pending (--status-pending)
```

**Flow 3 — Real-Time Node Updates**

```
Primary (telemetry — structured, ~50ms latency):
  FLT emits → EdogTopicRouter → EdogPlaygroundHub → SignalR →
  DagStudio._onTelemetryEvent → ExecutionStateManager.processTelemetry →
  DagCanvasRenderer.updateNodeState + DagGantt.updateBar

Backup (log — pattern-based, ~200ms latency):
  FLT emits log → SignalR 'log' → DagStudio._onLogEntry →
  AutoDetector.processLog → onExecutionUpdated →
  ExecutionStateManager.processAutoDetectorUpdate →
  reconcile with telemetry (telemetry wins on conflict)
```

**Flow 4 — Load Historical Execution**

```
1. User clicks HistoryPanel row
2. → getDagExecMetrics(iterationId)
3. → For each node: updateNodeState(nodeId, metrics.status)
4. → DagGantt.renderExecution(instance)
5. → ControlsBar: show historical status (non-interactive)
```

---

## 2. API Client Extensions

### Existing Methods (Reuse As-Is)

| Method | HTTP | Notes |
|--------|------|-------|
| `getLatestDag()` | `GET .../liveTable/getLatestDag?showExtendedLineage=true` | Direct `_fltFetch` |
| `runDag(iterationId)` | `POST .../liveTableSchedule/runDAG/{id}` | Empty body for ad-hoc |
| `fetchConfig()` | `GET /api/flt/config` | Proxied, returns tokens |
| `cancelDag(iterationId)` | `GET .../liveTableSchedule/cancelDAG/{id}` | Cancel is GET, not POST — FLT convention |

### New Methods

#### 2.1 getDagExecMetrics(iterationId)

```javascript
/**
 * Fetch full execution metrics for a completed/running DAG iteration.
 * @param {string} iterationId - Execution iteration GUID.
 * @returns {Promise<DagExecutionInstance>} Per-node metrics, timing, errors.
 * @throws {FltApiError} 404 if not found, 401/403 if auth expired.
 */
async getDagExecMetrics(iterationId) {
  return this._fltFetchStrict(`/liveTable/getDAGExecMetrics/${iterationId}`);
}
```

**HTTP:** `GET {fabricBaseUrl}/liveTable/getDAGExecMetrics/{iterationId}`
**Returns:** `{ dagExecutionMetrics, nodeExecutionMetrices: Map<Guid, NodeMetrics> }`

#### 2.2 listDagExecutions(opts)

```javascript
/**
 * List execution iterations with filtering and pagination.
 * @param {object} opts - { historyCount?, statuses?, startTime?, endTime?, continuationToken? }
 * @returns {Promise<{iterations: DagExecutionIteration[], continuationToken: string|null}>}
 */
async listDagExecutions(opts = {}) {
  const params = new URLSearchParams();
  params.set('historyCount', String(opts.historyCount || 20));
  if (opts.statuses) opts.statuses.forEach(s => params.append('statuses', s));
  if (opts.continuationToken) params.set('continuationToken', opts.continuationToken);
  const resp = await this._fltFetchRaw(`/liveTable/listDAGExecutionIterationIds?${params}`);
  const data = await resp.json();
  return { iterations: data, continuationToken: resp.headers.get('x-ms-continuation-token') || null };
}
```

**HTTP:** `GET .../liveTable/listDAGExecutionIterationIds?historyCount=20&statuses=...`

#### 2.3 getLockedExecution()

```javascript
/**
 * Check for stuck/locked DAG execution.
 * @returns {Promise<string|string[]|null>} Locked iteration ID(s), or null.
 */
async getLockedExecution() {
  // URL typo "Maintanance" is intentional — matches real FLT route
  return this._fltFetchStrict('/liveTableMaintanance/getLockedDAGExecutionIteration');
}
```

#### 2.4 forceUnlockDag(lockedIterationId)

```javascript
/**
 * Force unlock a stuck DAG execution. UI must gate behind confirmation dialog.
 * @param {string} lockedIterationId - Locked iteration GUID.
 * @returns {Promise<string>} "Force unlocked Dag"
 */
async forceUnlockDag(lockedIterationId) {
  return this._fltFetchStrict(
    `/liveTableMaintanance/forceUnlockDAGExecution/${lockedIterationId}`,
    { method: 'POST' }
  );
}
```

#### 2.5 getDagSettings() / 2.6 updateDagSettings(body)

```javascript
/** @returns {Promise<{environment, refreshMode, parallelNodeLimit}>} */
async getDagSettings() {
  return this._fltFetchStrict('/liveTable/settings');
}

/**
 * Partial update. parallelNodeLimit must be 2-25 (validate client-side).
 * @param {object} body - { parallelNodeLimit?, refreshMode?, environment? }
 */
async updateDagSettings(body) {
  return this._fltFetchStrict('/liveTable/settings', {
    method: 'PATCH', body: JSON.stringify(body),
  });
}
```

#### 2.7 listMlvDefinitions() / 2.8 createMlvDefinition(body)

```javascript
/** @returns {Promise<MLVExecutionDefinitionResponse[]>} */
async listMlvDefinitions() {
  return this._fltFetchStrict('/liveTable/mlvExecutionDefinitions');
}

/** @param {object} body - { name, description?, selectedMLVs, executionMode?, dagSettings? } */
async createMlvDefinition(body) {
  return this._fltFetchStrict('/liveTable/mlvExecutionDefinitions', {
    method: 'POST', body: JSON.stringify(body),
  });
}
```

#### 2.9 getDagExecStatus(iterationId)

```javascript
/**
 * Lightweight status poll — cheaper than getDagExecMetrics.
 * Used during reconnection to sync state without full metrics.
 * @param {string} iterationId
 * @returns {Promise<{status, startTime, endTime}>}
 */
async getDagExecStatus(iterationId) {
  return this._fltFetchStrict(`/liveTableSchedule/getDAGExecStatus/${iterationId}`);
}
```

### Internal Wrappers

```javascript
/**
 * FLT fetch with structured errors (throws FltApiError, never returns null).
 * @param {string} path - Appended to fabricBaseUrl.
 * @param {object} [options] - fetch options.
 * @returns {Promise<object>} Parsed JSON.
 * @throws {FltApiError} With .status, .body, .path.
 */
async _fltFetchStrict(path, options = {}) {
  if (!this._fabricBaseUrl || !this._mwcToken) {
    const err = new Error('FLT service not connected');
    err.status = 0; err.path = path; throw err;
  }
  const resp = await fetch(this._fabricBaseUrl + path, {
    ...options,
    headers: { 'Content-Type': 'application/json',
      'Authorization': `MwcToken ${this._mwcToken}`, ...options.headers },
  });
  if (!resp.ok) {
    const err = new Error(`FLT API error: ${resp.status} ${path}`);
    err.status = resp.status; err.body = await resp.text().catch(() => '');
    err.path = path; throw err;
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

/**
 * FLT fetch returning raw Response (for reading headers like continuation tokens).
 */
async _fltFetchRaw(path, options = {}) {
  if (!this._fabricBaseUrl || !this._mwcToken) throw new Error('FLT not connected');
  const resp = await fetch(this._fabricBaseUrl + path, {
    ...options, headers: { 'Content-Type': 'application/json',
      'Authorization': `MwcToken ${this._mwcToken}` },
  });
  if (!resp.ok) {
    const err = new Error(`FLT API error: ${resp.status} ${path}`);
    err.status = resp.status; err.path = path; throw err;
  }
  return resp;
}
```

### Error Handling Table

| HTTP Status | User Message | Action |
|-------------|-------------|--------|
| 0 / Network | "Connection lost — check FLT service" | Auto-retry, exponential backoff (1s → 30s max) |
| 401 | "Authentication expired" | Trigger re-auth via `/api/edog/auth` |
| 403 | "Access denied — check permissions" | Error banner (`--status-failed`), no retry |
| 404 | "DAG not found — deploy a lakehouse" | Onboarding prompt (`--accent` CTA) |
| 429 | "Rate limited — retrying in {N}s" | Read `Retry-After`, auto-retry |
| 500 | "FLT error: {errorCode}" | Error detail + manual retry button |

---

## 3. Execution State Manager

### Purpose

Single source of truth for DAG execution state. Merges two data sources — SignalR telemetry (primary, ~50ms latency) and AutoDetector log parsing (backup, ~200ms) — with deduplication and enforced state transitions.

### Class Design

```javascript
/**
 * ExecutionStateManager — Tracks per-node state during a DAG run.
 *
 * Input:  processTelemetry(event), processAutoDetectorUpdate(exec)
 * Output: onNodeStateChanged, onExecutionStateChanged, onExecutionComplete
 */
class ExecutionStateManager {
  constructor() {
    this._activeIterationId = null;
    this._executionStatus = 'idle';  // idle | running | completed | failed | cancelled
    this._nodeStates = new Map();    // nodeId → { status, startedAt, endedAt, errorCode, source }
    this._dagNodes = new Map();      // nodeId → DagNode (definition)
    this._nodeNameIndex = new Map(); // lowercase(name) → nodeId
    this._startedAt = null;
    this._endedAt = null;

    this.onNodeStateChanged = null;      // (nodeId, state) => void
    this.onExecutionStateChanged = null;  // (iterationId, state) => void
    this.onExecutionComplete = null;      // (iterationId, finalStatus) => void
  }

  /** Load DAG definition for name→ID resolution. Call before startTracking(). */
  setDag(dag) {
    this._dagNodes.clear();
    this._nodeNameIndex.clear();
    for (const node of dag.nodes) {
      this._dagNodes.set(node.nodeId, node);
      this._nodeNameIndex.set(node.name.toLowerCase(), node.nodeId);
    }
  }

  /** Begin tracking. Initializes all executable nodes to 'pending'. */
  startTracking(iterationId) {
    this._activeIterationId = iterationId;
    this._executionStatus = 'running';
    this._startedAt = Date.now();
    this._endedAt = null;
    this._nodeStates.clear();
    for (const [nodeId, node] of this._dagNodes) {
      if (node.executable !== false) {
        this._nodeStates.set(nodeId, {
          status: 'pending', startedAt: null, endedAt: null,
          errorCode: null, source: 'init',
        });
      }
    }
    this._emitExecutionState();
  }

  /** Process SignalR telemetry event (primary channel). */
  processTelemetry(event) {
    const t = event.data;
    if (!t || !t.activityName) return;
    if (t.iterationId && t.iterationId !== this._activeIterationId) return;
    if (t.activityName === 'RunDAG') { this._processExecutionTelemetry(t); return; }
    const nodeId = this._resolveNodeId(t);
    if (nodeId) this._processNodeTelemetry(nodeId, t, event.timestamp);
  }

  /** Process AutoDetector update (backup). Telemetry wins on conflict. */
  processAutoDetectorUpdate(exec) {
    if (exec.status && this._executionStatus === 'running') {
      const mapped = this._mapAutoDetectorStatus(exec.status);
      if (this._isTerminal(mapped)) {
        this._executionStatus = mapped;
        this._endedAt = Date.now();
        this._emitExecutionState();
      }
    }
    if (!exec.nodes) return;
    for (const [name, ns] of exec.nodes) {
      const nodeId = this._nodeNameIndex.get(name.toLowerCase());
      if (!nodeId) continue;
      const current = this._nodeStates.get(nodeId);
      if (!current || (current.source === 'telemetry' && this._isTerminal(current.status))) continue;
      const newStatus = this._mapNodeStatus(ns.status);
      if (newStatus !== current.status) {
        this._updateNodeState(nodeId, {
          status: newStatus,
          startedAt: ns.timestamp || current.startedAt,
          endedAt: this._isTerminal(newStatus) ? (ns.timestamp || Date.now()) : null,
          errorCode: ns.errorCode || null, source: 'autodetector',
        });
      }
    }
  }

  /** Reset to idle. Called on view deactivation or after completion acknowledgment. */
  reset() {
    this._activeIterationId = null;
    this._executionStatus = 'idle';
    this._nodeStates.clear();
    this._startedAt = null;
    this._endedAt = null;
  }

  // ── Private ──

  /** Resolve telemetry to nodeId. Priority: attributes.nodeName → substring match. */
  _resolveNodeId(telemetry) {
    const attrName = telemetry.attributes?.nodeName || telemetry.attributes?.mlvName;
    if (attrName) {
      const id = this._nodeNameIndex.get(attrName.toLowerCase());
      if (id) return id;
    }
    const activity = telemetry.activityName.toLowerCase();
    for (const [name, id] of this._nodeNameIndex) {
      if (activity.includes(name)) return id;
    }
    return null;
  }

  /** All terminal → execution complete. */
  _checkCompletion() {
    let allTerminal = true, anyFailed = false, anyCancelled = false;
    for (const [, state] of this._nodeStates) {
      if (!this._isTerminal(state.status)) { allTerminal = false; break; }
      if (state.status === 'failed') anyFailed = true;
      if (state.status === 'cancelled') anyCancelled = true;
    }
    if (allTerminal && this._executionStatus === 'running') {
      this._executionStatus = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';
      this._endedAt = Date.now();
      this._emitExecutionState();
      this.onExecutionComplete?.(this._activeIterationId, this._executionStatus);
    }
  }

  _isTerminal(s) {
    return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'skipped';
  }

  /** Enforce valid transitions. Invalid ones are logged and ignored. */
  _updateNodeState(nodeId, state) {
    const current = this._nodeStates.get(nodeId);
    if (!current) return;
    const valid = {
      pending: ['running', 'skipped'], running: ['completed', 'failed', 'cancelled', 'cancelling'],
      cancelling: ['cancelled'],
    };
    if (!valid[current.status]?.includes(state.status)) {
      console.warn(`[ESM] Invalid: ${current.status} → ${state.status} for ${nodeId}`);
      return;
    }
    this._nodeStates.set(nodeId, state);
    this.onNodeStateChanged?.(nodeId, state);
    this._checkCompletion();
  }
}
```

### Node State Transitions

```
                        ┌─────────┐
                        │ pending │  (initial — all executable nodes)
                        └────┬────┘
                             │  telemetry Started / "Executing node X"
                             ▼
                        ┌─────────┐
            ┌───────────│ running │───────────┐
            │           └────┬────┘           │
            ▼                ▼                ▼
      ┌───────────┐   ┌──────────┐   ┌────────────┐
      │ completed │   │  failed  │   │ cancelled  │
      └───────────┘   └──────────┘   └────────────┘

  Special: pending → skipped (dependency failed, DAG_FAULTED_NODES)
           running → cancelling → cancelled
```

### Valid Transitions (enforced — invalid logged and ignored)

| From | To | Trigger |
|------|----|---------|
| `pending` | `running` | Node execution started |
| `pending` | `skipped` | Dependency failed (DAG_FAULTED_NODES) |
| `running` | `completed` | Node succeeded |
| `running` | `failed` | Node errored |
| `running` | `cancelled` | Execution cancelled |
| `running` | `cancelling` | Cancel requested |
| `cancelling` | `cancelled` | Cancel confirmed |

### Telemetry → Node Mapping

| `activityName` | `activityStatus` | Maps To | Resolution |
|----------------|-------------------|---------|------------|
| `RunDAG` | `Started` | Execution started | `iterationId` match |
| `RunDAG` | `Succeeded`/`Failed` | Execution ended | `iterationId` match |
| Contains node name | `Started` | Node running | `attributes.nodeName` or substring |
| Contains node name | `Succeeded` | Node completed | Same |
| Contains node name | `Failed` | Node failed | Same + `errorCode` |
| `ExecuteNode`/`ExecuteMLV` | Any | Node change | `attributes.nodeName`/`mlvName` |

### Reconciliation Strategy

| Conflict | Resolution | Rationale |
|----------|-----------|-----------|
| Telemetry `running`, AutoDetector `completed` | Accept `completed` | Log parsed before telemetry arrived |
| Telemetry `completed`, AutoDetector `running` | Keep `completed` | Telemetry authoritative for terminal states |
| Both report same transition | Deduplicate | `_updateNodeState` checks current !== new |
| Telemetry has wrong iterationId | Ignore | Stale event from previous run |
| AutoDetector node not in DAG | Ignore | External node or name mismatch |

**Rule:** First source to report a terminal state wins.

---

## 4. Real-Time Updates

### SignalR Topics

| Topic | Purpose | Buffer |
|-------|---------|--------|
| `telemetry` | Structured execution events | 5,000 |
| `log` | Raw log entries → AutoDetector | 10,000 |

No new topics. Existing `telemetry` and `log` from `SIGNALR_PROTOCOL.md`.

### Subscription Lifecycle

```javascript
activate() {
  this._signalR.on('telemetry', this._onTelemetryEvent);
  this._signalR.on('log', this._onLogEntry);
  this._signalR.subscribeTopic('telemetry');
  this._signalR.subscribeTopic('log');
}

deactivate() {
  this._signalR.off('telemetry', this._onTelemetryEvent);
  this._signalR.off('log', this._onLogEntry);
  // Do NOT unsubscribe — other views may need the topics
  this._canvasRenderer.pauseRendering();
}
```

### Latency Budget

| Segment | Target |
|---------|--------|
| FLT → EdogTopicRouter.Publish() | < 1ms |
| TopicBuffer → SignalR wire | < 50ms |
| SignalR client → dispatch | < 5ms |
| ExecutionStateManager processing | < 2ms |
| DagCanvasRenderer.updateNodeState() | < 5ms |
| Next requestAnimationFrame | < 16ms |
| **Total: emit → pixel** | **< 80ms** (420ms margin under 500ms spec) |

### Reconnection Handling

```
Disconnect → show "Reconnecting..." (--status-cancelled amber) → freeze render
Reconnect  → resubscribe all topics → ChannelReader snapshot hydrates missed events
           → if execution in progress: poll getDagExecStatus() to sync
           → reconcile API response with stream state → resume live render
```

Buffer overflow risk: if telemetry buffer (5,000) overflowed during disconnect, events are lost. Mitigation: poll `getDagExecMetrics()` once after reconnect.

---

## 5. Module Structure

### dag-graph.js (~800 lines)

**Classes:** `DagCanvasRenderer`, `DagLayout`

Canvas 2D rendering with 3-level LOD:
- **LOD 0** (zoom < 0.3): Dots — solid circles with status color
- **LOD 1** (zoom 0.3–0.7): Compact rectangles with name + status indicator
- **LOD 2** (zoom > 0.7): Full detail — name, type badge, status, duration, error code

**Public API:** `setData(nodes, edges)`, `fitToScreen()`, `updateNodeState(nodeId, status)`, `setCamera(x, y, zoom)`, `hitTest(screenX, screenY)`, `highlightNode(nodeId)`, `clearHighlight()`, `pauseRendering()`, `resumeRendering()`, `destroy()`

**Callbacks:** `onNodeSelected(nodeId)`, `onNodeHovered(nodeId)`, `onNodeUnhovered()`, `onViewportChanged({x, y, zoom})`

### dag-gantt.js (~400 lines)

**Class:** `DagGantt`

Canvas 2D horizontal bars + DOM overlay for labels. Timeline with per-node bars, time axis, cross-highlighting.

**Public API:** `renderExecution(instance)`, `updateBar(nodeId, {status, startedAt, endedAt})`, `highlightNode(nodeId)`, `hoverNode(nodeId, x, y)`, `unhoverNode()`, `renderComparison(base, compare)`, `exitComparison()`, `setTimeZoom(level)`, `resize()`, `destroy()`

**Callbacks:** `onNodeSelected(nodeId)`, `onNodeHovered(nodeId)`, `onNodeUnhovered()`

### dag-studio.js (~600 lines)

**Classes:** `DagStudio` (orchestrator), `ExecutionStateManager` (inline)

Responsibilities:
- View lifecycle (activate/deactivate)
- Data coordination (API → state → renderers)
- Cross-highlighting between graph ↔ gantt
- Execution mode selection, comparison flow
- Contains ControlsBar logic + HistoryPanel logic

```javascript
// Cross-highlighting wiring
this._canvasRenderer.onNodeHovered = (nodeId) => this._gantt.highlightNode(nodeId);
this._gantt.onNodeHovered = (nodeId) => this._canvasRenderer.highlightNode(nodeId);

// State → all renderers
this._esm.onNodeStateChanged = (nodeId, state) => {
  this._canvasRenderer.updateNodeState(nodeId, state.status);
  this._gantt.updateBar(nodeId, state);
};
```

---

## 6. Layout Engine (Sugiyama Algorithm)

Five-step layered layout, the standard for DAG visualization:

### Step 1 — Layer Assignment

Kahn's topological sort. Nodes with no incoming edges → layer 0. Each subsequent layer holds nodes whose dependencies are all in earlier layers. **O(V + E).**

### Step 2 — Dummy Node Insertion

Edges spanning > 1 layer get dummy nodes at intermediate layers. Dummies are invisible but participate in crossing minimization. Rendered as edge waypoints with rounded corners. **O(E).**

### Step 3 — Crossing Minimization

Barycenter heuristic, 2-pass (top-down then bottom-up). For each node, compute average position of neighbors in adjacent layer, sort by barycenter. Heuristic — not optimal, but good for typical FLT DAGs. **O(V²) per pass.**

### Step 4 — Coordinate Assignment

```
LAYER_SPACING = 200px    NODE_SPACING = 80px
NODE_WIDTH    = 160px    NODE_HEIGHT  = 56px

For each layer L, position p:
  x = L * LAYER_SPACING
  y = p * NODE_SPACING - (layerSize * NODE_SPACING / 2)
```

Simple centering. Brandes-Kopf alignment deferred to P1. **O(V).**

### Step 5 — Edge Routing

Adjacent layers: bezier with 40px control point offset. Through dummy nodes: orthogonal path with 8px corner radius.

### Complexity Summary

| Step | Complexity |
|------|-----------|
| Layer assignment | O(V + E) |
| Dummy insertion | O(E) |
| Crossing minimization | O(V²) |
| Coordinate assignment | O(V) |
| Edge routing | O(E) |
| **Total** | **O(V² + E)** — < 50ms for 300 nodes |

---

## 7. Performance Budget

| Metric | Target |
|--------|--------|
| DAG load + layout (50 nodes) | < 100ms |
| DAG load + layout (300 nodes) | < 500ms |
| Live frame time | < 16ms (60fps) |
| Event → pixel latency | < 80ms |
| Hit-test | < 1ms |
| Memory (50 nodes) | < 5MB |
| Memory (300 nodes) | < 15MB |
| Gantt render (50 nodes) | < 50ms |
| History panel load (20 items) | < 30ms |

Canvas 2D over WebGL for simplicity and Chromium compatibility. WebGL deferred to P2 if 300+ node performance is insufficient.

---

## 8. Error Handling

### Network Retry

Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max). Jitter ±500ms. No retry on 401/403.

```javascript
async _retryWithBackoff(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (err) {
      if (err.status === 401 || err.status === 403) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 30000) + (Math.random() * 1000 - 500);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Stale Data

Sequence-based gap detection from TopicBuffer. If `sequenceId` gap detected: continue processing (events are idempotent), then poll `getDagExecStatus()` after 5s without missing events arriving.

### Lock Conflicts

`_checkLockState()` → locked → disable Run, show "Force Unlock" (behind confirmation dialog showing lock age + iteration ID).

### Auth Expiry

SignalR: unaffected after connect. API calls: 401 → re-auth via `/api/edog/auth` → retry. Failure → "Session expired" banner.

---

## 9. Integration Points

| Module | Integration | Changes Required |
|--------|------------|-----------------|
| **auto-detect.js** | Subscribe to `onExecutionUpdated` for backup detection | None — existing callback |
| **state-manager.js** | View activation/deactivation routing | Add `case 'dag'` in view router |
| **api-client.js** | 9 new methods + `_fltFetchStrict` + `_fltFetchRaw` | Additive — existing callers unaffected |
| **signalr-manager.js** | `.on()` / `.subscribeTopic()` | None — existing API |
| **log-viewer.js** | Shared `log` topic stream, separate handlers | None — no data duplication |

---

## 10. Three Execution Modes

| Mode | API Parameter | Behavior |
|------|---------------|----------|
| CurrentLakehouse (default) | `refreshMode: "CurrentLakehouse"` | All MLVs in current lakehouse |
| SelectedOnly | `refreshMode: "SelectedOnly"` + `selectedMLVs: [...]` | Only listed MLVs execute |
| FullLineage | `refreshMode: "Full"` | Cross-lakehouse within workspace |

### Mode Selection UI

Segmented control in ControlsBar (styled with `--color-border` dividers, `--accent-dim` active background):

```
┌─────────────────────┬──────────────┬───────────────┐
│ ● Current Lakehouse │  Selected    │  Full Lineage │
└─────────────────────┴──────────────┴───────────────┘
```

"Selected" mode → node picker overlay. Checked nodes get `--accent-dim` background in graph.

---

## 11. Lock Mechanism

FLT uses OneLake lock files to prevent concurrent DAG executions.

### Lock Semantics

| Property | Behavior |
|----------|----------|
| **Acquisition** | Single attempt, no retry. Failure → Skipped. |
| **Reentrant** | Same iteration can re-acquire its own lock. |
| **TTL** | Configurable timeout (default 60 min). |
| **Force unlock** | `forceUnlockDag()` API — requires confirmation dialog. |
| **Per-schedule** | Each MLVExecutionDefinition gets own lock → concurrent possible. |

### Lock File

```json
{ "LockedIterationId": "<guid>", "LockedAt": "2026-04-17T10:30:00Z" }
```

Location: `{Lakehouse}/LiveTableSystem/.lock`

### Force Unlock Flow

1. Lock detected → show indicator, disable "Run DAG"
2. User clicks "Force Unlock" → confirmation dialog (lock age, iteration ID, warning)
3. Confirm → `forceUnlockDag(lockedIterationId)` → refresh state → re-enable "Run DAG"

---

## 12. Execution History Persistence

### OneLake Structure

```
{Lakehouse}/LiveTableSystem/DagExecutionMetrics/{iterationId}/
  ├── dag.json                     // DAG definition snapshot
  ├── dag_metrics.json             // Overall execution metrics
  └── node_{nodeId}_metrics.json   // Per-node metrics (one per node)
```

**Max 500 records** per lakehouse. Older records pruned FIFO by FLT.

### Insights Delta Tables (Post-Execution Only)

| Table | Contents | Written |
|-------|----------|---------|
| `sys_run_metrics` | One row per execution | After completion |
| `sys_node_metrics` | One row per node per execution | After completion |
| `sys_error_metrics` | One row per error | After completion |

**Critical:** These tables are **post-execution**, NOT real-time. DAG Studio must use telemetry stream + `getDagExecMetrics()` for live status — never Delta Tables.

---

## 13. Open Questions / Risks

### Open Questions

1. **Telemetry activity names for per-node tracking.** Are `ExecuteNode` / `ExecuteMLV` the actual `activityName` values, or do we only get `RunDAG` at execution level? Determines `_resolveNodeId` accuracy.

2. **Token expiry during long runs.** DAG runs take 10+ minutes. SignalR is unaffected, but API calls 401. Implement server-side refresh now or defer proxy to P1?

3. **`nodeExecutionMetrices` typo.** FLT returns this misspelled field. Handle as-is (do not transform API contracts) or normalize in `_fltFetchStrict`?

4. **Parallel limit effect timing.** When user changes `parallelNodeLimit` via Settings, does it take effect on next run or require DAG restart?

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Telemetry buffer overflow on long runs | Low | Medium | Poll `getDagExecMetrics()` on reconnect |
| Node name collision in `_resolveNodeId` | Low | Medium | `attributes.nodeName` (Priority 1) before substring |
| Canvas perf with 300+ nodes | Medium | High | 3-level LOD; defer WebGL to P2 |
| Lock file corruption on crash | Low | High | Force unlock API + TTL expiry |
| MWC token expiry mid-run | High | Medium | SignalR unaffected; re-auth retry in `_fltFetchStrict` |
| FLT API breaking changes | Low | High | Pin API version; response shape validation |

---

*"Three channels, two renderers, one source of truth. The architecture assumes failure and recovers from it. Every data path has a backup. Every state transition is validated. That is the difference between a prototype and production."*

— Sana Reeves, Architecture Lead