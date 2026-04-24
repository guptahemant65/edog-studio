/**
 * ExecutionStateManager — Single source of truth for DAG execution state.
 *
 * Merges SignalR telemetry (primary, ~50ms) and AutoDetector log parsing
 * (backup, ~200ms) with deduplication and enforced state transitions.
 *
 * State machine: pending -> running -> completed|failed|cancelled|skipped
 * Special: pending -> skipped (dependency failed), running -> cancelling -> cancelled
 */
class ExecutionStateManager {
  constructor() {
    this._activeIterationId = null;
    this._executionStatus = 'idle'; // idle | running | completed | failed | cancelled
    this._nodeStates = new Map();   // nodeId -> {status, startedAt, endedAt, errorCode, source}
    this._dagNodes = new Map();     // nodeId -> node definition
    this._nodeNameIndex = new Map(); // lowercase(name) -> nodeId
    this._startedAt = null;
    this._endedAt = null;

    // Callbacks
    this.onNodeStateChanged = null;      // (nodeId, state) => void
    this.onExecutionStateChanged = null;  // (status) => void
    this.onExecutionComplete = null;      // (iterationId, finalStatus) => void
  }

  // ── Getters ──

  get status() { return this._executionStatus; }
  get activeIterationId() { return this._activeIterationId; }
  get nodeStates() { return this._nodeStates; }
  get startedAt() { return this._startedAt; }
  get endedAt() { return this._endedAt; }

  // ── Public API ──

  /** Load DAG definition for name->ID resolution. Call before startTracking(). */
  setDag(dag) {
    this._dagNodes.clear();
    this._nodeNameIndex.clear();
    if (!dag || !dag.nodes) return;
    for (var i = 0; i < dag.nodes.length; i++) {
      var node = dag.nodes[i];
      this._dagNodes.set(node.nodeId, node);
      if (node.name) {
        this._nodeNameIndex.set(node.name.toLowerCase(), node.nodeId);
      }
    }
  }

  /** Begin tracking a new execution. Initializes all executable nodes to 'pending'. */
  startTracking(iterationId) {
    this._activeIterationId = iterationId;
    this._executionStatus = 'running';
    this._startedAt = Date.now();
    this._endedAt = null;
    this._nodeStates.clear();
    for (var entry of this._dagNodes) {
      var nodeId = entry[0];
      var node = entry[1];
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
    var t = event.data;
    if (!t || !t.activityName) return;
    // Ignore stale events from different iteration
    if (t.iterationId && t.iterationId !== this._activeIterationId) return;
    // Execution-level telemetry (RunDAG)
    if (t.activityName === 'RunDAG') {
      this._processExecutionTelemetry(t);
      return;
    }
    // Node-level telemetry
    var nodeId = this._resolveNodeId(t);
    if (nodeId) this._processNodeTelemetry(nodeId, t, event.timestamp);
  }

  /** Process AutoDetector update (backup channel). Telemetry wins on conflict. */
  processAutoDetectorUpdate(exec) {
    // Execution-level status
    if (exec.status && this._executionStatus === 'running') {
      var mapped = this._mapAutoDetectorStatus(exec.status);
      if (this._isTerminal(mapped)) {
        this._executionStatus = mapped;
        this._endedAt = Date.now();
        this._emitExecutionState();
      }
    }
    // Node-level updates
    if (!exec.nodes) return;
    var entries = exec.nodes instanceof Map ? exec.nodes : Object.entries(exec.nodes || {});
    for (var entry of entries) {
      var name = Array.isArray(entry) ? entry[0] : entry[0];
      var ns = Array.isArray(entry) ? entry[1] : entry[1];
      var nodeId = this._nodeNameIndex.get(name.toLowerCase());
      if (!nodeId) continue;
      var current = this._nodeStates.get(nodeId);
      // Skip if telemetry already set terminal state (telemetry wins)
      if (!current || (current.source === 'telemetry' && this._isTerminal(current.status))) continue;
      var newStatus = this._mapNodeStatus(ns.status);
      if (newStatus !== current.status) {
        this._updateNodeState(nodeId, {
          status: newStatus,
          startedAt: ns.timestamp || current.startedAt,
          endedAt: this._isTerminal(newStatus) ? (ns.timestamp || Date.now()) : null,
          errorCode: ns.errorCode || null,
          source: 'autodetector',
        });
      }
    }
  }

  /** Load historical execution metrics (for viewing past runs). */
  loadHistorical(metrics) {
    this._nodeStates.clear();
    if (!metrics || !metrics.nodeExecutionMetrices) return;
    var nodes = metrics.nodeExecutionMetrices;
    for (var i = 0; i < nodes.length; i++) {
      var nm = nodes[i];
      var nodeId = nm.nodeId || this._nodeNameIndex.get((nm.nodeName || '').toLowerCase());
      if (!nodeId) continue;
      this._nodeStates.set(nodeId, {
        status: this._mapNodeStatus(nm.nodeExecutionStatus),
        startedAt: nm.startTime ? new Date(nm.startTime).getTime() : null,
        endedAt: nm.endTime ? new Date(nm.endTime).getTime() : null,
        errorCode: nm.errorCode || null,
        source: 'historical',
      });
    }
    // Determine overall execution status from nodes
    var anyFailed = false, anyCancelled = false, anyRunning = false;
    for (var entry of this._nodeStates) {
      var state = entry[1];
      if (state.status === 'failed') anyFailed = true;
      if (state.status === 'cancelled') anyCancelled = true;
      if (state.status === 'running') anyRunning = true;
    }
    if (anyRunning) {
      this._executionStatus = 'running';
    } else if (anyFailed) {
      this._executionStatus = 'failed';
    } else if (anyCancelled) {
      this._executionStatus = 'cancelled';
    } else {
      this._executionStatus = 'completed';
    }
    this._startedAt = metrics.startTime ? new Date(metrics.startTime).getTime() : null;
    this._endedAt = metrics.endTime ? new Date(metrics.endTime).getTime() : null;
  }

  /** Reset to idle. */
  reset() {
    this._activeIterationId = null;
    this._executionStatus = 'idle';
    this._nodeStates.clear();
    this._startedAt = null;
    this._endedAt = null;
  }

  // ── Private: telemetry processing ──

  /** Resolve telemetry activityName to nodeId. */
  _resolveNodeId(telemetry) {
    // Priority 1: explicit attributes
    var attrName = null;
    if (telemetry.attributes) {
      attrName = telemetry.attributes.nodeName || telemetry.attributes.mlvName;
    }
    if (attrName) {
      var id = this._nodeNameIndex.get(attrName.toLowerCase());
      if (id) return id;
    }
    // Priority 2: substring match in activityName
    var activity = telemetry.activityName.toLowerCase();
    for (var entry of this._nodeNameIndex) {
      var name = entry[0];
      var nodeId = entry[1];
      if (activity.includes(name)) return nodeId;
    }
    return null;
  }

  /** Process node-level telemetry (Started, Succeeded, Failed). */
  _processNodeTelemetry(nodeId, t, timestamp) {
    var current = this._nodeStates.get(nodeId);
    if (!current) return;
    var activityStatus = (t.activityStatus || '').toLowerCase();
    var newState = null;
    if (activityStatus === 'started' || activityStatus === 'inprogress') {
      newState = {
        status: 'running',
        startedAt: timestamp || Date.now(),
        endedAt: null,
        errorCode: null,
        source: 'telemetry',
      };
    } else if (activityStatus === 'succeeded' || activityStatus === 'completed') {
      newState = {
        status: 'completed',
        startedAt: current.startedAt,
        endedAt: timestamp || Date.now(),
        errorCode: null,
        source: 'telemetry',
      };
    } else if (activityStatus === 'failed' || activityStatus === 'faulted') {
      newState = {
        status: 'failed',
        startedAt: current.startedAt,
        endedAt: timestamp || Date.now(),
        errorCode: t.errorCode || (t.attributes && t.attributes.errorCode) || null,
        source: 'telemetry',
      };
    } else if (activityStatus === 'cancelled' || activityStatus === 'canceled') {
      newState = {
        status: 'cancelled',
        startedAt: current.startedAt,
        endedAt: timestamp || Date.now(),
        errorCode: null,
        source: 'telemetry',
      };
    } else if (activityStatus === 'skipped') {
      newState = {
        status: 'skipped',
        startedAt: null,
        endedAt: null,
        errorCode: null,
        source: 'telemetry',
      };
    }
    if (newState) this._updateNodeState(nodeId, newState);
  }

  /** Process execution-level telemetry (RunDAG Started/Succeeded/Failed). */
  _processExecutionTelemetry(t) {
    var activityStatus = (t.activityStatus || '').toLowerCase();
    if (activityStatus === 'started' || activityStatus === 'inprogress') {
      if (this._executionStatus !== 'running') {
        this._executionStatus = 'running';
        this._startedAt = Date.now();
        this._emitExecutionState();
      }
    } else if (activityStatus === 'succeeded' || activityStatus === 'completed') {
      this._executionStatus = 'completed';
      this._endedAt = Date.now();
      this._emitExecutionState();
      if (this.onExecutionComplete) this.onExecutionComplete(this._activeIterationId, 'completed');
    } else if (activityStatus === 'failed' || activityStatus === 'faulted') {
      this._executionStatus = 'failed';
      this._endedAt = Date.now();
      this._emitExecutionState();
      if (this.onExecutionComplete) this.onExecutionComplete(this._activeIterationId, 'failed');
    } else if (activityStatus === 'cancelled' || activityStatus === 'canceled') {
      this._executionStatus = 'cancelled';
      this._endedAt = Date.now();
      this._emitExecutionState();
      if (this.onExecutionComplete) this.onExecutionComplete(this._activeIterationId, 'cancelled');
    }
  }

  // ── Private: state management ──

  /** Enforce valid state transitions. Invalid ones are logged and ignored. */
  _updateNodeState(nodeId, state) {
    var current = this._nodeStates.get(nodeId);
    if (!current) return;
    var validTransitions = {
      pending: ['running', 'skipped'],
      running: ['completed', 'failed', 'cancelled', 'cancelling'],
      cancelling: ['cancelled'],
    };
    var allowed = validTransitions[current.status];
    if (!allowed || allowed.indexOf(state.status) === -1) {
      if (current.status !== state.status) {
        console.warn('[ESM] Invalid transition: ' + current.status + ' -> ' + state.status + ' for ' + nodeId);
      }
      return;
    }
    this._nodeStates.set(nodeId, state);
    if (this.onNodeStateChanged) this.onNodeStateChanged(nodeId, state);
    this._checkCompletion();
  }

  /** Check if all nodes reached terminal state. */
  _checkCompletion() {
    var allTerminal = true, anyFailed = false, anyCancelled = false;
    for (var entry of this._nodeStates) {
      var state = entry[1];
      if (!this._isTerminal(state.status)) { allTerminal = false; break; }
      if (state.status === 'failed') anyFailed = true;
      if (state.status === 'cancelled') anyCancelled = true;
    }
    if (allTerminal && this._executionStatus === 'running') {
      this._executionStatus = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';
      this._endedAt = Date.now();
      this._emitExecutionState();
      if (this.onExecutionComplete) this.onExecutionComplete(this._activeIterationId, this._executionStatus);
    }
  }

  _isTerminal(s) {
    return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'skipped';
  }

  _emitExecutionState() {
    if (this.onExecutionStateChanged) this.onExecutionStateChanged(this._executionStatus);
  }

  // ── Private: status mapping ──

  /** Map AutoDetector status strings to our internal states. */
  _mapAutoDetectorStatus(s) {
    if (!s) return 'pending';
    var lower = s.toLowerCase();
    if (lower === 'succeeded' || lower === 'completed') return 'completed';
    if (lower === 'failed' || lower === 'faulted') return 'failed';
    if (lower === 'cancelled' || lower === 'canceled') return 'cancelled';
    if (lower === 'running' || lower === 'inprogress' || lower === 'started') return 'running';
    return 'pending';
  }

  /** Map FLT NodeExecutionStatus to our internal states. */
  _mapNodeStatus(s) {
    if (!s) return 'pending';
    var lower = s.toLowerCase();
    if (lower === 'succeeded' || lower === 'completed') return 'completed';
    if (lower === 'failed' || lower === 'faulted' || lower === 'error') return 'failed';
    if (lower === 'cancelled' || lower === 'canceled') return 'cancelled';
    if (lower === 'skipped' || lower === 'notstarted_faulted') return 'skipped';
    if (lower === 'running' || lower === 'inprogress' || lower === 'started' || lower === 'executing') return 'running';
    if (lower === 'cancelling') return 'cancelling';
    return 'pending';
  }
}
