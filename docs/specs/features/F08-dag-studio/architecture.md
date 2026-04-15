# F08 DAG Studio — Architecture Spec

> **Author:** Vex (Senior Backend Engineer)
> **Reviewers:** Sana Reeves (Architecture), Pixel (Frontend)
> **Date:** 2026-04-15
> **Status:** DRAFT — Requires Sana sign-off
> **Prerequisite Reading:** `spec.md` §3, `research/p0-foundation.md`, `docs/specs/SIGNALR_PROTOCOL.md`

---

## 1. End-to-End Data Flow

```
                            ┌──────────────────────────────────────────────────┐
                            │               FLT Service Process               │
                            │  (Capacity Host, port varies per deployment)    │
                            │                                                  │
                            │  ┌─────────────────┐   ┌──────────────────────┐ │
                            │  │  FLT REST APIs   │   │  EdogPlaygroundHub   │ │
                            │  │  /liveTable/*     │   │  /hub/playground     │ │
                            │  │  /liveTableSched* │   │  (SignalR, :5557)    │ │
                            │  └────────┬─────────┘   └──────────┬───────────┘ │
                            └───────────┼─────────────────────────┼────────────┘
                                        │                         │
                       ┌────────────────┤                         │
                       │  MWC-authenticated                       │  WebSocket
                       │  (direct from browser)                   │  (direct from browser)
                       │                                          │
                       │  Some calls proxied                      │
                       │  through dev-server                      │
                       ▼                                          ▼
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│  dev-server.py (:5555)           │       │  SignalRManager                  │
│  /api/flt/config → config+tokens │       │  .subscribeTopic('telemetry')    │
│  /api/dag/*      → FLT proxy     │       │  .subscribeTopic('log')          │
│  /api/fabric/*   → Fabric proxy  │       │  .on('telemetry', cb)            │
└────────────┬─────────────────────┘       │  .on('log', cb)                  │
             │                              └──────────┬───────────────────────┘
             │  fetch('/api/dag/...')                   │  stream events
             │  or _fltFetch() direct                   │
             ▼                                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  FabricApiClient (api-client.js)                                            │
│  .getLatestDag()         — GET /liveTable/getLatestDag                      │
│  .getDagExecMetrics(id)  — GET /liveTable/getDAGExecMetrics/{id}            │
│  .runDag(id)             — POST /liveTableSchedule/runDAG/{id}              │
│  ... (11 DAG methods)                                                       │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │
                                  │  Data objects: Dag, DagExecutionInstance,
                                  │  DagExecutionIteration, DagSettings, etc.
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  DagStudio (dag-studio.js) — ORCHESTRATOR                                   │
│  Owns: view lifecycle, data coordination, user action dispatch              │
│  Receives: API responses + AutoDetector callbacks + SignalR telemetry        │
│                                                                              │
│  ._loadDag()             → DagLayout → DagCanvasRenderer.setData()          │
│  ._runDag()              → FabricApiClient.runDag() → subscribe updates     │
│  ._onTelemetryEvent(evt) → ExecutionStateManager.processTelemetry()         │
│  ._onLogEntry(entry)     → AutoDetector.processLog()                        │
│  ._onExecutionUpdated()  → DagCanvasRenderer + DagGantt + ControlsBar      │
└──────────────┬────────────────┬──────────────────┬───────────────────────────┘
               │                │                  │
               ▼                ▼                  ▼
┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐ ┌──────────────┐
│ DagCanvasRenderer│ │ DagGantt         │ │ ControlsBar    │ │ HistoryPanel │
│ (dag-graph.js)   │ │ (dag-gantt.js)   │ │ (dag-studio.js)│ │ (dag-studio) │
│ Canvas 2D + LOD  │ │ Canvas 2D bars   │ │ Run/Cancel/etc │ │ Past runs    │
│ updateNodeState()│ │ updateBar()      │ │ status display │ │ Comparison   │
└──────────────────┘ └──────────────────┘ └────────────────┘ └──────────────┘
```

### Data Flow Narratives

**Flow 1 — Initial Load (View Activation)**

```
1. User clicks DAG Studio sidebar icon (view=dag)
2. DagStudio.activate()
3.   → FabricApiClient.fetchConfig()         // refresh tokens
4.   → FabricApiClient.getLatestDag()         // GET via _fltFetch (direct to FLT)
5.   → DagLayout.layout(dag.nodes, dag.edges) // Sugiyama → positioned nodes
6.   → DagCanvasRenderer.setData(positioned)  // first render
7.   → DagCanvasRenderer.fitToScreen()        // auto-center
8.   → FabricApiClient.listDagExecutions({historyCount: 20})
9.   → HistoryPanel.render(iterations)
10.  → DagStudio._checkLockState()            // poll for stuck locks
11.  → SignalRManager.subscribeTopic('telemetry')  // start telemetry stream
12.  → SignalRManager.subscribeTopic('log')         // start log stream (for AutoDetector)
```

**Flow 2 — Run DAG (User-Triggered Execution)**

```
1. User clicks "Run DAG"
2. DagStudio._runDag()
3.   → iterationId = crypto.randomUUID()
4.   → FabricApiClient.runDag(iterationId)    // POST → 202 Accepted
5.   → ExecutionStateManager.startTracking(iterationId)
6.   → ControlsBar: disable Run, enable Cancel, show "Running" status
7.   → DagCanvasRenderer: all executable nodes → "pending" state
```

**Flow 3 — Real-Time Node Updates (During Execution)**

```
1. FLT emits telemetry event via EdogTelemetryInterceptor
2.   → EdogTopicRouter.Publish('telemetry', telemetryEvent)
3.   → EdogPlaygroundHub streams to client via ChannelReader
4.   → SignalRManager dispatches to listeners via .on('telemetry', cb)
5.   → DagStudio._onTelemetryEvent(event)
6.   → ExecutionStateManager.processTelemetry(event)
7.     if event.activityName contains node name:
8.       → map event to node → update node status + timing
9.       → emit 'nodeStateChanged' callback
10.  → DagCanvasRenderer.updateNodeState(nodeId, newStatus)  // recolor node
11. → DagGantt.updateBar(nodeId, {status, startedAt, endedAt})  // grow bar

Parallel path (log-based, backup detection):
1. FLT emits log entry via EdogLogInterceptor
2.   → SignalR 'log' topic → SignalRManager → DagStudio._onLogEntry(entry)
3.   → AutoDetector.processLog(entry)
4.     → pattern match: "Executing node X" / "Executed node X"
5.     → AutoDetector.onExecutionUpdated(id, exec)
6.   → ExecutionStateManager.processAutoDetectorUpdate(exec)
7.     → reconcile with telemetry-sourced state (telemetry wins on conflict)
```

**Flow 4 — Load Historical Execution**

```
1. User clicks a row in HistoryPanel
2. DagStudio._loadExecution(iterationId)
3.   → FabricApiClient.getDagExecMetrics(iterationId)
4.   → response: DagExecutionInstance with nodeExecutionMetrices map
5.   → For each node in dag:
6.       metrics = instance.nodeExecutionMetrices[node.nodeId]
7.       DagCanvasRenderer.updateNodeState(nodeId, metrics.status)
8.   → DagGantt.renderExecution(instance)
9.   → ControlsBar: show historical status (non-interactive)
```

---

## 2. API Client Extensions

### Existing Methods (Reuse As-Is)

| Method | HTTP Call | Notes |
|--------|----------|-------|
| `getLatestDag()` | `GET {fabricBaseUrl}/liveTable/getLatestDag?showExtendedLineage=true` | Already exists. Direct FLT call via `_fltFetch`. |
| `runDag(iterationId)` | `POST {fabricBaseUrl}/liveTableSchedule/runDAG/{iterationId}` | Already exists. Body is empty for ad-hoc runs. |
| `fetchConfig()` | `GET /api/flt/config` | Already exists. Returns tokens, workspace/lakehouse IDs. |

### Existing Method Requiring Fix

| Method | Current | Correct | Issue |
|--------|---------|---------|-------|
| `cancelDag(iterationId)` | `POST .../cancelDAG/{id}` | `GET .../cancelDAG/{id}` | FLT convention: cancel is GET, not POST. Current code sends POST — will 404 or 405 on real FLT. |

### New Methods to Add

All new methods use `_fltFetch()` (direct MWC-authenticated calls to FLT). Error handling is centralized in the `_fltFetchStrict()` wrapper described below.

#### 2.1 `getDagExecMetrics(iterationId)`

```javascript
/**
 * Fetch full execution metrics for a completed/running DAG iteration.
 * @param {string} iterationId - Execution iteration GUID.
 * @returns {Promise<DagExecutionInstance>} Per-node metrics, timing, errors.
 * @throws {ApiError} 404 if iteration not found, 401/403 if auth expired.
 */
async getDagExecMetrics(iterationId) {
  return this._fltFetchStrict(
    `/liveTable/getDAGExecMetrics/${iterationId}`
  );
}
```

- **HTTP:** `GET {fabricBaseUrl}/liveTable/getDAGExecMetrics/{iterationId}`
- **Auth:** MWC token via `Authorization: MwcToken {token}`
- **Returns:** `DagExecutionInstance` — contains `dagExecutionMetrics` (overall) + `nodeExecutionMetrices` (Map<Guid, NodeExecutionMetrics>)
- **Error:** 404 = iteration not found (show "Execution not found" toast), 401 = re-auth needed

#### 2.2 `listDagExecutions(opts)`

```javascript
/**
 * List DAG execution iterations with optional filtering and pagination.
 * @param {object} opts
 * @param {number} [opts.historyCount=20] - Max results (max 500).
 * @param {string[]} [opts.statuses] - Filter: 'completed','failed','cancelled','running'.
 * @param {string} [opts.continuationToken] - Pagination token from previous response.
 * @returns {Promise<{iterations: DagExecutionIteration[], continuationToken: string|null}>}
 */
async listDagExecutions(opts = {}) {
  const params = new URLSearchParams();
  params.set('historyCount', String(opts.historyCount || 20));
  if (opts.statuses) opts.statuses.forEach(s => params.append('statuses', s));
  if (opts.startTime) params.set('startTime', opts.startTime);
  if (opts.endTime) params.set('endTime', opts.endTime);

  const resp = await this._fltFetchRaw(
    `/liveTable/listDAGExecutionIterationIds?${params}`
  );
  const data = await resp.json();
  return {
    iterations: data,
    continuationToken: resp.headers.get('x-ms-continuation-token') || null,
  };
}
```

- **HTTP:** `GET {fabricBaseUrl}/liveTable/listDAGExecutionIterationIds?historyCount=20&statuses=...`
- **Returns:** `List<DagExecutionIteration>` + continuation token in response header
- **Pagination:** Client passes `continuationToken` from previous response as query param. FLT returns next page.
- **Error:** 404 = lakehouse not deployed, 429 = rate limited

#### 2.3 `getLockedExecution()`

```javascript
/**
 * Check for stuck/locked DAG execution.
 * @returns {Promise<string|string[]|null>} Locked iteration ID(s), or null if unlocked.
 */
async getLockedExecution() {
  // Note: URL has intentional typo "Maintanance" — matches FLT route
  return this._fltFetchStrict(
    '/liveTableMaintanance/getLockedDAGExecutionIteration'
  );
}
```

- **HTTP:** `GET {fabricBaseUrl}/liveTableMaintanance/getLockedDAGExecutionIteration`
- **⚠ Typo in URL is real** — `Maintanance` (missing 'e'). This is the actual FLT route.
- **Returns:** `string` or `List<Guid>` — locked iteration IDs. Empty/null means no lock.

#### 2.4 `forceUnlockDag(lockedIterationId)`

```javascript
/**
 * Force unlock a stuck DAG execution. Requires confirmation before calling.
 * @param {string} lockedIterationId - The locked iteration GUID.
 * @returns {Promise<string>} Confirmation message ("Force unlocked Dag").
 */
async forceUnlockDag(lockedIterationId) {
  return this._fltFetchStrict(
    `/liveTableMaintanance/forceUnlockDAGExecution/${lockedIterationId}`,
    { method: 'POST' }
  );
}
```

- **HTTP:** `POST {fabricBaseUrl}/liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}`
- **Returns:** `string` — `"Force unlocked Dag"`
- **⚠ Dangerous operation.** UI must show confirmation dialog with lock age and iteration ID before calling.

#### 2.5 `getDagSettings()`

```javascript
/**
 * Get current DAG settings (parallel limit, refresh mode, environment).
 * @returns {Promise<DagSettingsResponseBody>}
 */
async getDagSettings() {
  return this._fltFetchStrict('/liveTable/settings');
}
```

- **HTTP:** `GET {fabricBaseUrl}/liveTable/settings`
- **Returns:** `{ environment, refreshMode, parallelNodeLimit }`

#### 2.6 `updateDagSettings(body)`

```javascript
/**
 * Update DAG settings.
 * @param {object} body - Partial settings: { parallelNodeLimit?, refreshMode?, environment? }
 * @returns {Promise<DagSettingsResponseBody>} Updated settings.
 */
async updateDagSettings(body) {
  return this._fltFetchStrict('/liveTable/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
```

- **HTTP:** `PATCH {fabricBaseUrl}/liveTable/settings`
- **Body:** `{ parallelNodeLimit: 10, refreshMode: "Full" }` (partial update)
- **Validation:** `parallelNodeLimit` must be 2–25. Client should validate before sending.

#### 2.7 `listMlvDefinitions()`

```javascript
/**
 * List named MLV execution definitions (subsets for targeted runs).
 * @returns {Promise<MLVExecutionDefinitionResponse[]>}
 */
async listMlvDefinitions() {
  return this._fltFetchStrict('/liveTable/mlvExecutionDefinitions');
}
```

- **HTTP:** `GET {fabricBaseUrl}/liveTable/mlvExecutionDefinitions`
- **Returns:** Array of `{ id, name, description, selectedMLVs, executionMode, dagSettings }`

#### 2.8 `createMlvDefinition(body)`

```javascript
/**
 * Create a named MLV execution definition.
 * @param {object} body - { name, description?, selectedMLVs, executionMode?, dagSettings? }
 * @returns {Promise<MLVExecutionDefinitionResponse>}
 */
async createMlvDefinition(body) {
  return this._fltFetchStrict('/liveTable/mlvExecutionDefinitions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
```

- **HTTP:** `POST {fabricBaseUrl}/liveTable/mlvExecutionDefinitions`
- **Body:** `{ name: "Sales only", selectedMLVs: ["RefreshSales", "AggSales"] }`

### New Internal Wrapper: `_fltFetchStrict()`

The existing `_fltFetch()` silently swallows errors and returns `null`. DAG Studio needs structured error handling. New wrapper:

```javascript
/**
 * FLT API fetch with structured error handling (throws instead of returning null).
 * @param {string} path - API path appended to fabricBaseUrl.
 * @param {object} [options] - fetch options.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {FltApiError} With .status, .errorCode, .message, .path.
 */
async _fltFetchStrict(path, options = {}) {
  if (!this._fabricBaseUrl || !this._mwcToken) {
    const err = new Error('FLT service not connected — deploy to a lakehouse first');
    err.status = 0;
    err.path = path;
    throw err;
  }
  const url = this._fabricBaseUrl + path;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `MwcToken ${this._mwcToken}`,
    ...options.headers,
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`FLT API error: ${resp.status} ${path}`);
    err.status = resp.status;
    err.body = body;
    err.path = path;
    throw err;
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

/**
 * FLT API fetch returning raw Response (for reading headers like continuation tokens).
 */
async _fltFetchRaw(path, options = {}) {
  if (!this._fabricBaseUrl || !this._mwcToken) {
    throw new Error('FLT service not connected');
  }
  const url = this._fabricBaseUrl + path;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `MwcToken ${this._mwcToken}`,
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const err = new Error(`FLT API error: ${resp.status} ${path}`);
    err.status = resp.status;
    err.path = path;
    throw err;
  }
  return resp;
}
```

### Error Handling Strategy (All DAG API Methods)

| HTTP Status | User Message | Action |
|-------------|-------------|--------|
| 0 / Network | "Connection lost — check FLT service" | Show reconnect timer, auto-retry in 10s |
| 401 | "Authentication expired" | Trigger re-auth flow via `/api/edog/auth` |
| 403 | "Access denied — check workspace permissions" | Show error banner, no retry |
| 404 | "DAG not found — deploy a lakehouse first" | Show onboarding prompt |
| 429 | "Rate limited — retrying in {N}s" | Read `Retry-After` header, auto-retry |
| 500 | "FLT service error: {errorCode}" | Show error detail + manual retry button |

---

## 3. Execution State Manager

### Purpose

`ExecutionStateManager` is the single source of truth for the state of a DAG execution in progress. It merges two data sources:

1. **SignalR telemetry events** — structured, reliable, lower latency
2. **AutoDetector log parsing** — pattern-based, higher latency, but works without `EdogTelemetryInterceptor`

The manager reconciles both streams, deduplicates updates, and emits callbacks to the rendering layer.

### Class Design

```javascript
/**
 * ExecutionStateManager — Tracks per-node execution state during a DAG run.
 *
 * Two input channels:
 *   1. processTelemetry(event)       — SignalR telemetry events
 *   2. processAutoDetectorUpdate(exec) — AutoDetector log-parsed state
 *
 * Output callbacks:
 *   onNodeStateChanged(nodeId, {status, startedAt, endedAt, errorCode})
 *   onExecutionStateChanged(iterationId, {status, startedAt, endedAt})
 *   onExecutionComplete(iterationId, finalStatus)
 */
class ExecutionStateManager {
  constructor() {
    this._activeIterationId = null;
    this._executionStatus = 'idle';     // idle | running | completed | failed | cancelled
    this._nodeStates = new Map();       // nodeId → { status, startedAt, endedAt, errorCode, source }
    this._dagNodes = new Map();         // nodeId → Node (from DAG definition, for name→ID lookup)
    this._nodeNameIndex = new Map();    // lowercase(nodeName) → nodeId (for log-based matching)
    this._startedAt = null;
    this._endedAt = null;

    // Callbacks
    this.onNodeStateChanged = null;     // (nodeId, state) => void
    this.onExecutionStateChanged = null; // (iterationId, state) => void
    this.onExecutionComplete = null;     // (iterationId, finalStatus) => void
  }
```

### Initialization

```javascript
/**
 * Prepare the manager for a new execution. Must be called before
 * startTracking() — loads the DAG definition for name→ID resolution.
 * @param {Dag} dag - Current DAG definition with nodes[] and edges[].
 */
setDag(dag) {
  this._dagNodes.clear();
  this._nodeNameIndex.clear();
  for (const node of dag.nodes) {
    this._dagNodes.set(node.nodeId, node);
    this._nodeNameIndex.set(node.name.toLowerCase(), node.nodeId);
  }
}

/**
 * Begin tracking a new execution.
 * @param {string} iterationId - UUID of the execution.
 */
startTracking(iterationId) {
  this._activeIterationId = iterationId;
  this._executionStatus = 'running';
  this._startedAt = Date.now();
  this._endedAt = null;
  this._nodeStates.clear();

  // Initialize all executable nodes to 'pending'
  for (const [nodeId, node] of this._dagNodes) {
    if (node.executable !== false) {
      this._nodeStates.set(nodeId, {
        status: 'pending',
        startedAt: null,
        endedAt: null,
        errorCode: null,
        source: 'init',
      });
    }
  }

  this._emitExecutionState();
}
```

### Telemetry Event Processing

SignalR telemetry events from the `telemetry` topic arrive as `TelemetryEvent` envelopes:

```json
{
  "sequenceId": 4215,
  "timestamp": "2026-04-12T10:42:31.847Z",
  "topic": "telemetry",
  "data": {
    "activityName": "RunDAG",
    "activityStatus": "Succeeded",
    "durationMs": 12400,
    "iterationId": "abc-123",
    "attributes": { "nodeCount": "7", "nodeName": "RefreshSales" }
  }
}
```

#### Telemetry → Node Mapping Rules

| `activityName` Pattern | `activityStatus` | Maps To | Node Resolution |
|------------------------|-------------------|---------|-----------------|
| `RunDAG` | `Started` | Execution started | `iterationId` match |
| `RunDAG` | `Succeeded` | Execution completed | `iterationId` match |
| `RunDAG` | `Failed` | Execution failed | `iterationId` match |
| Contains node name (e.g., `RefreshSalesData`) | `Started` | Node running | `attributes.nodeName` or substring match in `activityName` |
| Contains node name | `Succeeded` | Node completed | Same |
| Contains node name | `Failed` | Node failed | Same + extract `errorCode` from attributes |
| `ExecuteNode` / `ExecuteMLV` | Any | Node state change | `attributes.nodeName` or `attributes.mlvName` |

```javascript
/**
 * Process a telemetry event from SignalR stream.
 * @param {TopicEvent} event - Envelope with .data containing TelemetryEvent.
 */
processTelemetry(event) {
  const t = event.data;
  if (!t || !t.activityName) return;

  // Filter to active iteration
  if (t.iterationId && t.iterationId !== this._activeIterationId) return;

  // Overall execution state
  if (t.activityName === 'RunDAG') {
    this._processExecutionTelemetry(t);
    return;
  }

  // Per-node state
  const nodeId = this._resolveNodeId(t);
  if (nodeId) {
    this._processNodeTelemetry(nodeId, t, event.timestamp);
  }
}

_resolveNodeId(telemetry) {
  // Priority 1: explicit nodeName in attributes
  const attrName = telemetry.attributes?.nodeName || telemetry.attributes?.mlvName;
  if (attrName) {
    const id = this._nodeNameIndex.get(attrName.toLowerCase());
    if (id) return id;
  }

  // Priority 2: activityName contains a known node name
  const activity = telemetry.activityName.toLowerCase();
  for (const [name, id] of this._nodeNameIndex) {
    if (activity.includes(name)) return id;
  }

  return null;
}
```

### AutoDetector Integration (Backup Channel)

The existing `AutoDetector` class already parses log entries for DAG execution patterns. Its `execution` object contains a `nodes` Map with per-node state:

```javascript
// AutoDetector execution object shape:
{
  dagName, status, startTime, endTime,
  nodeCount, completedNodes, failedNodes, skippedNodes,
  parallelLimit, refreshMode, duration,
  errors: [{code, message, timestamp, node}],
  nodes: Map<name, {status, duration, errorCode, timestamp}>
}
```

```javascript
/**
 * Process an AutoDetector execution update (log-based detection).
 * Only applies updates for fields not already set by telemetry
 * (telemetry wins on conflict because it is structured and lower latency).
 * @param {object} exec - AutoDetector execution object.
 */
processAutoDetectorUpdate(exec) {
  // Overall execution state: only update if telemetry hasn't set it
  if (exec.status && this._executionStatus === 'running') {
    const mapped = this._mapAutoDetectorStatus(exec.status);
    if (mapped === 'completed' || mapped === 'failed' || mapped === 'cancelled') {
      this._executionStatus = mapped;
      this._endedAt = Date.now();
      this._emitExecutionState();
      this._checkCompletion();
    }
  }

  // Per-node updates
  if (exec.nodes) {
    for (const [name, nodeState] of exec.nodes) {
      const nodeId = this._nodeNameIndex.get(name.toLowerCase());
      if (!nodeId) continue;

      const current = this._nodeStates.get(nodeId);
      if (!current) continue;

      // Only apply if telemetry hasn't already set a terminal state
      if (current.source === 'telemetry' && this._isTerminal(current.status)) continue;

      const newStatus = this._mapNodeStatus(nodeState.status);
      if (newStatus !== current.status) {
        this._updateNodeState(nodeId, {
          status: newStatus,
          startedAt: nodeState.timestamp || current.startedAt,
          endedAt: this._isTerminal(newStatus) ? (nodeState.timestamp || Date.now()) : null,
          errorCode: nodeState.errorCode || null,
          source: 'autodetector',
        });
      }
    }
  }
}
```

### Node State Transitions

```
                        ┌─────────┐
                        │ pending │  (initial — all executable nodes)
                        └────┬────┘
                             │  "Executing node X" / telemetry Started
                             ▼
                        ┌─────────┐
            ┌───────────│ running │───────────┐
            │           └────┬────┘           │
            │                │                │
            │   "Executed    │  Error or      │  "Cancelled" /
            │   node X" +    │  "Failed"      │  telemetry Cancelled
            │   success      │                │
            ▼                ▼                ▼
      ┌───────────┐   ┌──────────┐   ┌────────────┐
      │ completed │   │  failed  │   │ cancelled  │
      └───────────┘   └──────────┘   └────────────┘

Special transitions:
  pending → skipped     (dependency failed → DAG_FAULTED_NODES)
  running → cancelling  (cancel requested, awaiting confirmation)
  cancelling → cancelled
```

Valid state transitions (enforced — invalid transitions are logged and ignored):

| From | To | Trigger |
|------|----|---------|
| `pending` | `running` | Node execution started |
| `pending` | `skipped` | Dependency failed (DAG_FAULTED_NODES) |
| `running` | `completed` | Node succeeded |
| `running` | `failed` | Node errored |
| `running` | `cancelled` | Execution cancelled |
| `running` | `cancelling` | Cancel requested |
| `cancelling` | `cancelled` | Cancel confirmed |

### Execution Completion Detection

The manager detects execution completion when **all executable nodes are in a terminal state** (`completed`, `failed`, `cancelled`, `skipped`):

```javascript
_checkCompletion() {
  let allTerminal = true;
  let anyFailed = false;
  let anyCancelled = false;

  for (const [nodeId, state] of this._nodeStates) {
    if (!this._isTerminal(state.status)) {
      allTerminal = false;
      break;
    }
    if (state.status === 'failed') anyFailed = true;
    if (state.status === 'cancelled') anyCancelled = true;
  }

  if (allTerminal && this._executionStatus === 'running') {
    this._executionStatus = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';
    this._endedAt = Date.now();
    this._emitExecutionState();
    if (this.onExecutionComplete) {
      this.onExecutionComplete(this._activeIterationId, this._executionStatus);
    }
  }
}

_isTerminal(status) {
  return status === 'completed' || status === 'failed'
      || status === 'cancelled' || status === 'skipped';
}
```

### Reconciliation Strategy (Dual-Source)

| Conflict | Resolution | Rationale |
|----------|-----------|-----------|
| Telemetry says `running`, AutoDetector says `completed` | Accept `completed` | AutoDetector parsed the "Executed node" log line before telemetry event arrived |
| Telemetry says `completed`, AutoDetector says `running` | Keep `completed` | Telemetry is authoritative for terminal states |
| Both report same transition | Deduplicate (ignore second) | `_updateNodeState` checks `current.status !== new.status` |
| Telemetry has no iterationId match | Ignore | Stale event from previous run |
| AutoDetector detects node not in DAG | Ignore | External node or name mismatch |

Rule: **The first source to report a terminal state wins.** Subsequent reports of the same terminal state are ignored.

---

## 4. Real-Time Updates

### SignalR Topics Required

| Topic | Purpose | Subscriber | Buffer Size |
|-------|---------|------------|-------------|
| `telemetry` | Structured execution events — `ActivityName`, `IterationId`, per-node status | `DagStudio._onTelemetryEvent()` | 5,000 events |
| `log` | Raw log entries — parsed by AutoDetector for DAG patterns | `DagStudio._onLogEntry()` → `AutoDetector.processLog()` | 10,000 entries |

**No new topics required.** DAG Studio consumes the existing `telemetry` and `log` topics. Both are already defined in `SIGNALR_PROTOCOL.md` and implemented in `EdogPlaygroundHub`.

### Subscription Lifecycle

```javascript
// DagStudio.activate() — called when user switches to DAG view
activate() {
  this._signalR.on('telemetry', this._onTelemetryEvent);
  this._signalR.on('log', this._onLogEntry);
  this._signalR.subscribeTopic('telemetry');
  // 'log' is auto-subscribed on connect, but ensure it's active
  this._signalR.subscribeTopic('log');
}

// DagStudio.deactivate() — called when user leaves DAG view
deactivate() {
  this._signalR.off('telemetry', this._onTelemetryEvent);
  this._signalR.off('log', this._onLogEntry);
  // Do NOT unsubscribe topics — other views (Logs, Telemetry) may need them
  this._canvasRenderer.pauseRendering();
}
```

### How the Graph Knows When a Node Starts/Finishes

**Primary path (telemetry topic):**

```
TelemetryEvent arrives → data.activityName checked
  → "RunDAG" + "Started"  → execution started
  → "RunDAG" + "Succeeded" → execution completed
  → activityName contains node name → resolve nodeId via _nodeNameIndex
    → activityStatus "Started" → node is running
    → activityStatus "Succeeded" → node completed
    → activityStatus "Failed" → node failed
```

**Backup path (log topic → AutoDetector):**

```
LogEntry arrives → AutoDetector.processLog(entry)
  → entry.message matches "[DAG STATUS] Running" → execution started
  → entry.message matches "Executing node RefreshSales" → node running
  → entry.message matches "Executed node RefreshSales. Status: Completed" → node completed
  → entry.message matches "[DAG_FAULTED_NODES]" → parse faulted nodes → mark skipped
```

### Latency Budget

| Segment | Target | Measured Basis |
|---------|--------|----------------|
| FLT emits → EdogTopicRouter.Publish() | < 1ms | In-process, synchronous snapshot |
| TopicBuffer → ChannelReader → SignalR wire | < 50ms | JSON over WebSocket, localhost |
| SignalR client → SignalRManager dispatch | < 5ms | JS event loop, single `forEach` |
| ExecutionStateManager processing | < 2ms | Map lookup + state comparison |
| DagCanvasRenderer.updateNodeState() | < 5ms | Change fill color, mark dirty |
| Next requestAnimationFrame render | < 16ms | 60fps = 16.67ms per frame |
| **Total: event emission → pixel on screen** | **< 80ms** | Well under 500ms target |

The 500ms latency target from the spec has ~420ms of margin. Even with network jitter on non-localhost deployments, this budget is safe.

### Reconnection Handling

```
SignalR disconnects
  → SignalRManager.onreconnecting() fires
  → DagStudio: show "Reconnecting..." status in toolbar
  → DagCanvasRenderer: freeze animation (keep last known state)

SignalR reconnects
  → SignalRManager.onreconnected() fires
  → SignalRManager._resubscribeAll() re-streams topics
  → Telemetry snapshot hydrates missed events (ChannelReader pattern)
  → ExecutionStateManager replays snapshot events
  → If execution was in progress:
      → Poll getDagExecMetrics(activeIterationId) once to sync state
      → Reconcile API response with stream state
```

**Gap risk:** The `ChannelReader` snapshot+stream pattern (per `SIGNALR_PROTOCOL.md`) means the client receives **all buffered events** then **live events** with zero gap. However, if the telemetry buffer (5,000 events) overflowed during disconnect, events may be lost. Mitigation: after reconnect, poll `getDagExecMetrics()` once to get authoritative state.

---

## 5. Proxy Layer

### Routing Architecture

DAG Studio uses **two authentication paths**, each with different routing:

```
Browser (localhost:5555)
│
├── Fabric Public APIs (bearer token)
│   └── fetch('/api/fabric/workspaces/...')
│       → dev-server.py :5555 proxy
│       → api.fabric.microsoft.com
│       → Used by: WorkspaceExplorer (Phase 1)
│       → NOT used by DAG Studio
│
├── FLT Service APIs (MWC token)
│   └── fetch('{fabricBaseUrl}/liveTable/...')
│       → DIRECT to FLT capacity host (CORS allowed)
│       → MWC token in Authorization header
│       → Used by: ALL DAG Studio API calls
│
├── DAG Proxy Routes (NEW — MWC token, server-side)
│   └── fetch('/api/dag/...')
│       → dev-server.py :5555 proxy
│       → FLT capacity host with server-side MWC token
│       → Used by: calls needing server-side token refresh
│
└── SignalR (WebSocket)
    └── ws://localhost:5557/hub/playground
        → DIRECT to EdogPlaygroundHub in FLT process
        → No proxy needed (same machine, no CORS)
```

### Which Calls Go Where

| Call | Route | Reason |
|------|-------|--------|
| `getLatestDag()` | Direct to FLT (`_fltFetch`) | MWC token already in browser |
| `getDagExecMetrics(id)` | Direct to FLT (`_fltFetchStrict`) | Same |
| `listDagExecutions(opts)` | Direct to FLT (`_fltFetchRaw`) | Need response headers for pagination |
| `runDag(id)` | Direct to FLT (`_fltFetchStrict`) | Same |
| `cancelDag(id)` | Direct to FLT (`_fltFetchStrict`) | Same |
| `getLockedExecution()` | Direct to FLT (`_fltFetchStrict`) | Same |
| `forceUnlockDag(id)` | Direct to FLT (`_fltFetchStrict`) | Same |
| `getDagSettings()` | Direct to FLT (`_fltFetchStrict`) | Same |
| `updateDagSettings(body)` | Direct to FLT (`_fltFetchStrict`) | Same |
| `listMlvDefinitions()` | Direct to FLT (`_fltFetchStrict`) | Same |
| `createMlvDefinition(body)` | Direct to FLT (`_fltFetchStrict`) | Same |
| SignalR telemetry stream | Direct WebSocket to :5557 | Already established |
| SignalR log stream | Direct WebSocket to :5557 | Already established |

### New Proxy Routes in dev-server.py

**Required: One new route group for DAG API fallback.**

When the MWC token expires mid-session, the browser's direct FLT calls will 401. Rather than interrupt the user, `dev-server.py` can proxy DAG calls using a server-side refreshed token:

```python
# In EdogDevHandler.do_GET():
elif self.path.startswith("/api/dag/"):
    self._proxy_dag_to_flt("GET")

# In EdogDevHandler.do_POST():
elif self.path.startswith("/api/dag/"):
    self._proxy_dag_to_flt("POST")

# In EdogDevHandler.do_PATCH():
elif self.path.startswith("/api/dag/"):
    self._proxy_dag_to_flt("PATCH")
```

```python
def _proxy_dag_to_flt(self, method: str) -> None:
    """Proxy /api/dag/* requests to FLT service with server-side MWC token.

    Route mapping:
      /api/dag/latest       → GET  .../liveTable/getLatestDag?showExtendedLineage=true
      /api/dag/exec/{id}    → GET  .../liveTable/getDAGExecMetrics/{id}
      /api/dag/history      → GET  .../liveTable/listDAGExecutionIterationIds?...
      /api/dag/run/{id}     → POST .../liveTableSchedule/runDAG/{id}
      /api/dag/cancel/{id}  → GET  .../liveTableSchedule/cancelDAG/{id}
      /api/dag/lock          → GET  .../liveTableMaintanance/getLockedDAGExecutionIteration
      /api/dag/unlock/{id}  → POST .../liveTableMaintanance/forceUnlockDAGExecution/{id}
      /api/dag/settings     → GET/PATCH .../liveTable/settings
      /api/dag/definitions  → GET/POST .../liveTable/mlvExecutionDefinitions
    """
    # Strip /api/dag prefix → map to FLT path
    # Attach MWC token from server-side config
    # Forward request, return response
```

**Risk assessment:** This proxy is a **fallback** path. Primary path is direct browser→FLT. The proxy exists for:
1. Token refresh without user interruption
2. Future CORS restrictions if FLT moves to a different host
3. Request logging/debugging (all proxied calls visible in dev-server logs)

**Implementation priority:** LOW — direct FLT calls work today. Add proxy when token refresh UX is built.

---

## 6. File Map

### New Files

| File | Class | Purpose | Dependencies | Est. Lines |
|------|-------|---------|-------------|------------|
| `src/frontend/js/dag-graph.js` | `DagCanvasRenderer`, `DagLayout` | Canvas 2D graph with 3-level LOD, Sugiyama layout, pan/zoom/select, minimap | None (standalone rendering) | ~800 |
| `src/frontend/js/dag-gantt.js` | `DagGantt` | Canvas 2D Gantt timeline with horizontal bars, time axis, cross-highlighting | None (standalone rendering) | ~400 |
| `src/frontend/js/dag-studio.js` | `DagStudio`, `ExecutionStateManager` | Orchestrator: view lifecycle, API calls, state management, wiring renderers | `api-client.js`, `signalr-manager.js`, `auto-detect.js`, `dag-graph.js`, `dag-gantt.js` | ~700 |
| `src/frontend/css/dag-graph.css` | — | Canvas container, zoom controls, minimap overlay, node detail panel styles | `variables.css`, `dag.css` | ~120 |

### Modified Files

| File | Changes | Risk |
|------|---------|------|
| `src/frontend/js/api-client.js` | Add 8 new DAG methods + `_fltFetchStrict()` + `_fltFetchRaw()` + fix `cancelDag` GET/POST bug | **Medium** — new methods are additive, but `_fltFetchStrict` is a new pattern. Existing `_fltFetch` callers unaffected. |
| `src/frontend/js/control-panel.js` | Deprecate in favor of `dag-studio.js`. Keep for backward compat but mark methods as legacy. | **Low** — no current UI references `ControlPanel` (no DOM container in `index.html`). |
| `src/frontend/index.html` | Add `#view-dag` container with canvas element, toolbar, bottom panel structure. Add sidebar nav item for DAG Studio. | **Medium** — structural change to HTML template. Must coordinate with Pixel. |
| `src/frontend/css/dag.css` | Minor additions for Canvas-specific styles (existing file covers DOM/SVG patterns, needs Canvas container rules). | **Low** — additive only. |
| `scripts/build-html.py` | Add `dag-graph.js`, `dag-gantt.js`, `dag-studio.js` to JS concatenation order. Add `dag-graph.css` to CSS order. | **Medium** — wrong order breaks the build. `dag-graph.js` and `dag-gantt.js` must load before `dag-studio.js`, which must load before `main.js`. |
| `scripts/dev-server.py` | Add `/api/dag/*` proxy routes (future, low priority). | **Low** — additive, behind new URL prefix. |

### Build Order (JS Concatenation)

Current order (relevant section):

```
... auto-detect.js → control-panel.js → ... → main.js
```

New order:

```
... auto-detect.js → control-panel.js → dag-graph.js → dag-gantt.js → dag-studio.js → ... → main.js
```

Rationale:
- `dag-graph.js` and `dag-gantt.js` are standalone renderers with no dependencies on other EDOG modules
- `dag-studio.js` depends on `DagCanvasRenderer`, `DagGantt`, `AutoDetector`, and `FabricApiClient` — must load after all of them
- `main.js` instantiates `DagStudio` — must load last

### Build Order (CSS Concatenation)

```
... dag.css → dag-graph.css → ...
```

`dag-graph.css` extends `dag.css` with Canvas-specific rules. Must load after `dag.css` and `variables.css`.

---

## 7. Open Questions for Sana

1. **SignalR telemetry event shape for per-node tracking:** The `telemetry` topic envelope is defined in `SIGNALR_PROTOCOL.md`, but the exact `activityName` patterns for per-node execution events need confirmation from FLT source code. Are `ExecuteNode` / `ExecuteMLV` the actual activity names, or do we only get `RunDAG` at the execution level?

2. **`cancelDag` HTTP method:** Current `api-client.js` sends POST, but spec says FLT expects GET. Which is correct for the current FLT build? Both paths should be tested.

3. **Token expiry during long DAG runs:** A DAG run can take 10+ minutes. MWC tokens may expire mid-execution. The monitoring (telemetry/log streams) works via SignalR (no token needed after connect), but API calls like `getDagExecMetrics` will fail. Should we implement server-side token refresh now, or add the `/api/dag/*` proxy as a follow-up?

4. **`NodeExecutionMetrices` field name typo:** FLT uses `nodeExecutionMetrices` (missing an 't'). Should we normalize this in `_fltFetchStrict` or handle it in `DagStudio`?

---

*"The data flows through three channels: REST for structure, SignalR for real-time, AutoDetector for resilience. Each can fail independently. The architecture survives any single channel going down — that's not paranoia, that's engineering."*

— Vex, Backend Engineer
