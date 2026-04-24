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

/**
 * DagStudio — Orchestrator for DAG Studio view.
 *
 * Coordinates: FabricApiClient, SignalRManager, AutoDetector,
 * DagCanvasRenderer, DagLayout, ExecutionStateManager.
 * Toolbar: Run/Cancel/Refresh/ForceUnlock with state-driven visibility.
 * History panel: loads past 20 executions with click-to-view.
 * Lock detection: polls every 30s, shows Force Unlock when stuck.
 */
class DagStudio {
  constructor(apiClient, signalR, autoDetector) {
    this._api = apiClient;
    this._signalR = signalR;
    this._autoDetector = autoDetector;
    this._esm = new ExecutionStateManager();
    this._layout = new DagLayout();
    this._renderer = null;
    this._gantt = null;
    this._dag = null;
    this._active = false;
    this._lockCheckInterval = null;
    this._elapsedInterval = null;
    this._codeCache = new Map();
    this._workspaceId = null;

    // DOM refs
    this._runBtn = document.getElementById('dagRunBtn');
    this._cancelBtn = document.getElementById('dagCancelBtn');
    this._refreshBtn = document.getElementById('dagRefreshBtn');
    this._unlockBtn = document.getElementById('dagUnlockBtn');
    this._statusDot = document.getElementById('dagStatusDot');
    this._statusText = document.getElementById('dagStatusText');
    this._graphPanel = document.getElementById('dagGraphPanel');
    this._historyContainer = document.getElementById('dagHistoryContainer');
    this._nodeDetail = document.getElementById('dagNodeDetail');
    this._ganttContainer = document.getElementById('dagGanttContainer');

    // Bind event handlers
    this._onTelemetryEvent = this._onTelemetryEvent.bind(this);
    this._onLogEntry = this._onLogEntry.bind(this);
    this._onRunClick = this._onRunClick.bind(this);
    this._onCancelClick = this._onCancelClick.bind(this);
    this._onRefreshClick = this._onRefreshClick.bind(this);
    this._onUnlockClick = this._onUnlockClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    // ESM callbacks
    this._esm.onNodeStateChanged = this._onNodeStateChanged.bind(this);
    this._esm.onExecutionStateChanged = this._onExecutionStateChanged.bind(this);
    this._esm.onExecutionComplete = this._onExecutionComplete.bind(this);

    // Button listeners
    this._runBtn.addEventListener('click', this._onRunClick);
    this._cancelBtn.addEventListener('click', this._onCancelClick);
    this._refreshBtn.addEventListener('click', this._onRefreshClick);
    this._unlockBtn.addEventListener('click', this._onUnlockClick);
  }

  async activate() {
    if (this._active) return;
    this._active = true;
    // Lazy init renderer
    if (!this._renderer) {
      this._renderer = new DagCanvasRenderer(this._graphPanel);
    } else {
      this._renderer.resumeRendering();
    }
    // Lazy init gantt
    if (!this._gantt) {
      this._gantt = new DagGantt(this._ganttContainer);
    }
    // Cross-highlighting: renderer → gantt
    var self = this;
    this._renderer.onNodeSelected = function(nodeId) {
      self._onNodeSelected(nodeId);
    };
    this._renderer.onNodeHovered = function(nodeId) {
      if (self._gantt) self._gantt.highlightNode(nodeId);
    };
    this._renderer.onNodeUnhovered = function() {
      if (self._gantt) self._gantt.unhoverNode();
    };
    // Cross-highlighting: gantt → renderer
    this._gantt.onNodeSelected = function(nodeId) {
      if (self._renderer) self._renderer.highlightNode(nodeId);
      self._renderNodeDetail(nodeId);
    };
    this._gantt.onNodeHovered = function(nodeId) {
      if (self._renderer) self._renderer.highlightNode(nodeId);
    };
    this._gantt.onNodeUnhovered = function() {
      if (self._renderer) self._renderer.clearHighlight();
    };
    // Subscribe to SignalR telemetry topic
    this._signalR.on('telemetry', this._onTelemetryEvent);
    this._signalR.subscribeTopic('telemetry');
    // Keyboard shortcuts
    document.addEventListener('keydown', this._onKeyDown);
    // Load DAG
    await this._loadDag();
    // Load history
    await this._loadHistory();
    // Start lock check polling
    this._startLockCheck();
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    // Unsubscribe telemetry
    this._signalR.off('telemetry', this._onTelemetryEvent);
    this._signalR.unsubscribeTopic('telemetry');
    // Pause rendering
    if (this._renderer) this._renderer.pauseRendering();
    // Remove keyboard listener
    document.removeEventListener('keydown', this._onKeyDown);
    // Stop intervals
    this._stopLockCheck();
    this._stopElapsedTimer();
  }

  async _loadDag() {
    try {
      var dag = await this._api.getLatestDag();
      if (!dag || !dag.nodes) {
        this._renderEmpty('No DAG found. Ensure FLT is configured.');
        return;
      }
      this._dag = dag;
      this._esm.setDag(dag);
      // Layout
      var layoutResult = this._layout.layout(dag.nodes, dag.edges || []);
      this._renderer.setData(layoutResult.nodes, layoutResult.edges);
      this._renderer.fitToScreen();
      this._renderControls('idle');
      this._renderStatus('idle');
    } catch (err) {
      console.error('[DagStudio] Failed to load DAG:', err);
      this._renderEmpty('Failed to load DAG: ' + (err.message || err));
    }
  }

  async _runDag() {
    try {
      var iterationId = crypto.randomUUID();
      this._runBtn.disabled = true;
      var result = await this._api.runDag(iterationId);
      if (result === null) {
        this._runBtn.disabled = false;
        return;
      }
      this._esm.startTracking(iterationId);
      // Initialize gantt with current DAG nodes
      if (this._gantt && this._dag && this._dag.nodes) {
        this._gantt.renderExecution(this._dag.nodes, Date.now());
      }
      this._renderControls('running');
      this._renderStatus('running');
      this._startElapsedTimer();
    } catch (err) {
      console.error('[DagStudio] Failed to run DAG:', err);
      this._runBtn.disabled = false;
      this._renderStatus('error', 'Run failed: ' + (err.message || err));
    }
  }

  async _cancelDag() {
    var iterationId = this._esm.activeIterationId;
    if (!iterationId) return;
    try {
      this._cancelBtn.disabled = true;
      await this._api.cancelDag(iterationId);
      this._renderStatus('cancelling');
    } catch (err) {
      console.error('[DagStudio] Failed to cancel DAG:', err);
      this._cancelBtn.disabled = false;
    }
  }

  async _refreshDag() {
    this._esm.reset();
    this._renderControls('idle');
    this._renderStatus('idle');
    this._stopElapsedTimer();
    await this._loadDag();
    await this._loadHistory();
  }

  async _forceUnlock() {
    try {
      var locked = await this._api.getLockedExecution();
      if (!locked) {
        this._unlockBtn.style.display = 'none';
        return;
      }
      var lockedId = locked.iterationId || locked;
      await this._api.forceUnlockDag(lockedId);
      this._unlockBtn.style.display = 'none';
      this._renderStatus('idle', 'DAG unlocked');
    } catch (err) {
      console.error('[DagStudio] Failed to unlock DAG:', err);
    }
  }

  async _loadHistory() {
    try {
      var result = await this._api.listDagExecutions({ historyCount: 20 });
      var iterations = result.iterations || [];
      this._renderHistory(iterations);
    } catch (err) {
      console.error('[DagStudio] Failed to load history:', err);
      this._historyContainer.innerHTML = '<div class="dag-empty-hint">Failed to load history</div>';
    }
  }

  async _loadHistoricalExecution(iterationId) {
    try {
      var metrics = await this._api.getDagExecMetrics(iterationId);
      this._esm.loadHistorical(metrics);
      // Initialize gantt for historical view
      if (this._gantt && this._dag && this._dag.nodes) {
        this._gantt.renderExecution(this._dag.nodes, this._esm.startedAt || Date.now());
      }
      // Update renderer and gantt with node states
      for (var entry of this._esm.nodeStates) {
        this._renderer.updateNodeState(entry[0], entry[1].status);
        if (this._gantt) this._gantt.updateBar(entry[0], entry[1]);
      }
      this._renderControls(this._esm.status);
      this._renderStatus(this._esm.status);
    } catch (err) {
      console.error('[DagStudio] Failed to load execution:', err);
    }
  }

  _startLockCheck() {
    this._stopLockCheck();
    this._checkLockState();
    this._lockCheckInterval = setInterval(this._checkLockState.bind(this), 30000);
  }

  _stopLockCheck() {
    if (this._lockCheckInterval) {
      clearInterval(this._lockCheckInterval);
      this._lockCheckInterval = null;
    }
  }

  async _checkLockState() {
    try {
      var locked = await this._api.getLockedExecution();
      this._unlockBtn.style.display = locked ? '' : 'none';
    } catch (err) {
      // Silently ignore lock check failures
    }
  }

  _startElapsedTimer() {
    this._stopElapsedTimer();
    var startedAt = this._esm.startedAt || Date.now();
    var self = this;
    this._elapsedInterval = setInterval(function() {
      var elapsed = Date.now() - startedAt;
      var secs = (elapsed / 1000).toFixed(1);
      self._statusText.textContent = 'Running ' + secs + 's';
    }, 100);
  }

  _stopElapsedTimer() {
    if (this._elapsedInterval) {
      clearInterval(this._elapsedInterval);
      this._elapsedInterval = null;
    }
  }

  // --- Event handlers ---

  _onTelemetryEvent(event) {
    if (!this._esm.activeIterationId) return;
    this._esm.processTelemetry(event);
  }

  _onLogEntry(entry) {
    if (!this._esm.activeIterationId) return;
    this._autoDetector.processLog(entry);
    // Check if autoDetector has an active execution matching ours
    var exec = this._autoDetector.detectedExecutions.get(this._esm.activeIterationId);
    if (exec) {
      this._esm.processAutoDetectorUpdate(exec);
    }
  }

  _onNodeSelected(nodeId) {
    this._renderNodeDetail(nodeId);
    if (this._renderer) this._renderer.highlightNode(nodeId);
    if (this._gantt) this._gantt.highlightNode(nodeId);
  }

  _onExecutionStateChanged(status) {
    this._renderControls(status);
    this._renderStatus(status);
    if (status !== 'running') {
      this._stopElapsedTimer();
    }
  }

  _onNodeStateChanged(nodeId, state) {
    if (this._renderer) this._renderer.updateNodeState(nodeId, state.status);
    if (this._gantt) this._gantt.updateBar(nodeId, state);
  }

  _onExecutionComplete(iterationId, finalStatus) {
    this._stopElapsedTimer();
    this._renderControls(finalStatus);
    this._renderStatus(finalStatus);
    this._loadHistory();
  }

  _onRunClick() { this._runDag(); }
  _onCancelClick() { this._cancelDag(); }
  _onRefreshClick() { this._refreshDag(); }
  _onUnlockClick() { this._forceUnlock(); }

  _onKeyDown(e) {
    if (!this._active) return;
    // Don't capture if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.key === 'Escape') {
      // Deselect node, close detail panel
      this._nodeDetail.classList.remove('open');
      if (this._renderer) this._renderer.clearHighlight();
      if (this._gantt) this._gantt.unhoverNode();
    } else if (e.key === '+' || e.key === '=') {
      // Zoom in — delegate to zoom button
      var zoomIn = document.getElementById('dagZoomIn');
      if (zoomIn) zoomIn.click();
    } else if (e.key === '-') {
      // Zoom out
      var zoomOut = document.getElementById('dagZoomOut');
      if (zoomOut) zoomOut.click();
    } else if (e.key === '0') {
      // Fit to screen
      if (this._renderer) this._renderer.fitToScreen();
    }
  }

  // --- UI rendering ---

  _renderControls(status) {
    var isIdle = status === 'idle' || status === 'completed' || status === 'failed' || status === 'cancelled';
    var isRunning = status === 'running';
    this._runBtn.style.display = isIdle ? '' : 'none';
    this._runBtn.disabled = false;
    this._cancelBtn.style.display = isRunning ? '' : 'none';
    this._cancelBtn.disabled = false;
    this._refreshBtn.disabled = isRunning;
  }

  _renderStatus(status, message) {
    var dot = this._statusDot;
    // Remove all state classes
    dot.className = 'dag-status-dot';
    if (status === 'running') {
      dot.classList.add('running');
      if (!message) this._statusText.textContent = 'Running';
    } else if (status === 'completed') {
      dot.classList.add('completed');
      this._statusText.textContent = message || 'Completed';
    } else if (status === 'failed') {
      dot.classList.add('failed');
      this._statusText.textContent = message || 'Failed';
    } else if (status === 'cancelled' || status === 'cancelling') {
      dot.classList.add('cancelled');
      this._statusText.textContent = message || (status === 'cancelling' ? 'Cancelling...' : 'Cancelled');
    } else if (status === 'error') {
      dot.classList.add('failed');
      this._statusText.textContent = message || 'Error';
    } else {
      this._statusText.textContent = message || 'Idle';
    }
  }

  _renderEmpty(message) {
    if (this._renderer && this._renderer._nodesLayer) {
      this._renderer._nodesLayer.innerHTML = '<div class="dag-empty-hint">' + message + '</div>';
    }
  }

  _renderHistory(iterations) {
    if (!iterations || iterations.length === 0) {
      this._historyContainer.innerHTML = '<div class="dag-empty-hint">No execution history</div>';
      return;
    }
    var html = '<table class="dag-history-table">';
    html += '<tr><th>Iteration</th><th>Status</th><th>Time</th></tr>';
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      var id = it.iterationId || it;
      var shortId = (typeof id === 'string' && id.length > 8) ? id.substring(0, 8) : id;
      var status = it.status || '\u2014';
      var time = it.startTime ? new Date(it.startTime).toLocaleString() : '\u2014';
      html += '<tr class="dag-history-row" data-iteration="' + id + '">';
      html += '<td title="' + id + '">' + shortId + '</td>';
      html += '<td>' + status + '</td>';
      html += '<td>' + time + '</td>';
      html += '</tr>';
    }
    html += '</table>';
    this._historyContainer.innerHTML = html;
    // Bind click handlers
    var self = this;
    var rows = this._historyContainer.querySelectorAll('.dag-history-row');
    for (var j = 0; j < rows.length; j++) {
      rows[j].addEventListener('click', function() {
        var iterationId = this.getAttribute('data-iteration');
        self._loadHistoricalExecution(iterationId);
      });
    }
  }

  _renderNodeDetail(nodeId) {
    if (!nodeId || !this._dag) {
      this._nodeDetail.classList.remove('open');
      return;
    }
    var node = null;
    for (var i = 0; i < this._dag.nodes.length; i++) {
      if (this._dag.nodes[i].nodeId === nodeId) {
        node = this._dag.nodes[i];
        break;
      }
    }
    if (!node) {
      this._nodeDetail.classList.remove('open');
      return;
    }
    var state = this._esm.nodeStates.get(nodeId);
    var statusText = state ? state.status : 'pending';
    var html = '<div class="dag-detail-header">';
    html += '<span class="dag-detail-title">' + (node.name || node.nodeId) + '</span>';
    html += '<button class="dag-detail-close" id="dagDetailClose">&#10005;</button>';
    html += '</div>';
    html += '<div class="dag-detail-body">';
    html += '<div class="dag-detail-row"><span class="dag-detail-label">Status</span><span class="dag-status-dot ' + statusText + '"></span> ' + statusText + '</div>';
    html += '<div class="dag-detail-row"><span class="dag-detail-label">Type</span>' + (node.kind || node.type || '\u2014') + '</div>';
    html += '<div class="dag-detail-row"><span class="dag-detail-label">Node ID</span><span title="' + nodeId + '">' + nodeId.substring(0, 12) + '...</span></div>';
    if (state && state.startedAt) {
      html += '<div class="dag-detail-row"><span class="dag-detail-label">Started</span>' + new Date(state.startedAt).toLocaleTimeString() + '</div>';
    }
    if (state && state.endedAt) {
      html += '<div class="dag-detail-row"><span class="dag-detail-label">Ended</span>' + new Date(state.endedAt).toLocaleTimeString() + '</div>';
      html += '<div class="dag-detail-row"><span class="dag-detail-label">Duration</span>' + ((state.endedAt - state.startedAt) / 1000).toFixed(1) + 's</div>';
    }
    if (state && state.errorCode) {
      html += '<div class="dag-detail-row"><span class="dag-detail-label">Error</span><span class="error-text">' + state.errorCode + '</span></div>';
    }
    // ── Definition section (F21) ──
    var self = this;
    if (node.codeReference) {
      html += '<div class="dag-detail-divider"></div>';
      html += '<div class="dag-detail-section-title">Definition</div>';
      var cacheKey = node.codeReference.notebookId + ':' + node.codeReference.cellIndex;
      var cached = self._codeCache.get(cacheKey);
      if (cached) {
        html += '<div class="dag-code-block">' + self._escapeHtml(cached) + '</div>';
        html += '<div class="dag-code-actions">';
        html += '<button class="dag-code-btn" id="dagCodeCopy" title="Copy to clipboard">Copy</button>';
        html += '</div>';
      } else {
        html += '<button class="dag-code-btn dag-code-load" id="dagCodeLoad" data-node="' + nodeId + '">Load Definition</button>';
      }
    } else {
      html += '<div class="dag-detail-divider"></div>';
      html += '<div class="dag-detail-section-title">Definition</div>';
      html += '<div class="dag-code-empty">No code reference available</div>';
    }
    html += '</div>';
    this._nodeDetail.innerHTML = html;
    this._nodeDetail.classList.add('open');
    // Close button
    var closeBtn = document.getElementById('dagDetailClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        self._nodeDetail.classList.remove('open');
        if (self._renderer) self._renderer.clearHighlight();
      });
    }
    // Load definition button
    var loadBtn = document.getElementById('dagCodeLoad');
    if (loadBtn) {
      loadBtn.addEventListener('click', function() {
        var nid = this.getAttribute('data-node');
        self._loadNodeDefinition(nid);
      });
    }
    // Copy button
    var copyBtn = document.getElementById('dagCodeCopy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var codeBlock = self._nodeDetail.querySelector('.dag-code-block');
        if (codeBlock && navigator.clipboard) {
          navigator.clipboard.writeText(codeBlock.textContent);
        }
      });
    }
  }

  /** Fetch and display code definition for a DAG node. */
  _loadNodeDefinition(nodeId) {
    var node = null;
    for (var i = 0; i < this._dag.nodes.length; i++) {
      if (this._dag.nodes[i].nodeId === nodeId) {
        node = this._dag.nodes[i];
        break;
      }
    }
    if (!node || !node.codeReference) return;

    var ref = node.codeReference;
    var cacheKey = ref.notebookId + ':' + ref.cellIndex;
    var self = this;

    // Show loading state
    var loadBtn = document.getElementById('dagCodeLoad');
    if (loadBtn) {
      loadBtn.textContent = 'Loading...';
      loadBtn.disabled = true;
    }

    var isMock = new URLSearchParams(window.location.search).has('mock');
    if (isMock) {
      var mockCode = (window.MockEdogData && window.MockEdogData.mockCodeDefinitions)
        ? window.MockEdogData.mockCodeDefinitions[cacheKey]
        : null;
      if (mockCode) {
        self._codeCache.set(cacheKey, mockCode);
      } else {
        self._codeCache.set(cacheKey, '-- No definition found for cell ' + ref.cellIndex);
      }
      self._renderNodeDetail(nodeId);
      return;
    }

    // Real mode: fetch notebook content
    var wsId = self._workspaceId;
    if (!wsId) {
      var app = window.edogApp;
      if (app && app._deployTarget) wsId = app._deployTarget.workspaceId;
    }
    if (!wsId || !self._api) {
      self._codeCache.set(cacheKey, '-- Cannot load: no workspace context');
      self._renderNodeDetail(nodeId);
      return;
    }

    self._api.getNotebookContent(wsId, ref.notebookId).then(function(resp) {
      var content = (resp && resp.content) ? resp.content : '';
      var cells = content.split(/\n--\s*CELL\s+SEPARATOR\s*\n|\n#{2,}\s/);
      var cellCode = (ref.cellIndex < cells.length) ? cells[ref.cellIndex].trim() : content.trim();
      self._codeCache.set(cacheKey, cellCode);
      self._renderNodeDetail(nodeId);
    }).catch(function(err) {
      self._codeCache.set(cacheKey, '-- Failed to load: ' + err.message);
      self._renderNodeDetail(nodeId);
    });
  }

  /** Escape HTML entities for safe insertion. */
  _escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }
}
