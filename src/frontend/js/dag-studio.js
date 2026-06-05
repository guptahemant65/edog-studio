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
    // Telemetry topic streams {sequenceId, timestamp, topic, data} — unwrap
    var t = event.data || event;
    if (!t || !t.activityName) {
      console.log('[ESM-DIAG] Telemetry skipped — no activityName:', t);
      return;
    }
    // Check iterationId from multiple sources (FLT may use attributes or correlationId)
    var evtIterId = t.iterationId || (t.attributes && (t.attributes.iterationId || t.attributes.IterationId)) || null;
    if (evtIterId && evtIterId !== this._activeIterationId) {
      console.log('[ESM-DIAG] Telemetry skipped — iteration mismatch:', evtIterId, 'vs', this._activeIterationId);
      return;
    }
    console.log('[ESM-DIAG] Processing telemetry:', t.activityName, t.activityStatus, 'attrs:', JSON.stringify(t.attributes || {}).substring(0, 200));
    // Execution-level telemetry (RunDAG / RunDag — case-insensitive)
    if (t.activityName.toLowerCase() === 'rundag') {
      this._processExecutionTelemetry(t);
      return;
    }
    // Node-level telemetry
    var ts = this._toMs(event.timestamp || t.timestamp);
    var nodeId = this._resolveNodeId(t);
    console.log('[ESM-DIAG] Resolved nodeId:', nodeId, 'for activity:', t.activityName);
    if (nodeId) this._processNodeTelemetry(nodeId, t, ts);
  }

  /** Normalize timestamp to epoch ms. */
  _toMs(ts) {
    if (!ts) return Date.now();
    if (typeof ts === 'number') return ts;
    var parsed = new Date(ts).getTime();
    return isNaN(parsed) ? Date.now() : parsed;
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
          startedAt: this._toMs(ns.timestamp) || current.startedAt,
          endedAt: this._isTerminal(newStatus) ? (this._toMs(ns.timestamp) || Date.now()) : null,
          errorCode: ns.errorCode || null,
          source: 'autodetector',
        });
      }
    }
  }

  /** Load historical execution metrics (for viewing past runs). */
  loadHistorical(metrics) {
    this._nodeStates.clear();
    if (!metrics) return;

    var rawNodes = metrics.nodeExecutionMetrices || metrics.nodeExecutionMetrics || [];
    var entries = Array.isArray(rawNodes) ? rawNodes : Object.entries(rawNodes || {});
    for (var i = 0; i < entries.length; i++) {
      var nm = Array.isArray(rawNodes) ? entries[i] : entries[i][1];
      var fallbackName = Array.isArray(rawNodes) ? '' : entries[i][0];
      var nodeName = nm.nodeName || fallbackName || '';
      var nodeId = nm.nodeId || this._nodeNameIndex.get(nodeName.toLowerCase());
      if (!nodeId) continue;
      this._nodeStates.set(nodeId, {
        status: this._mapNodeStatus(nm.nodeExecutionStatus || nm.status),
        startedAt: nm.startedAt ? new Date(nm.startedAt).getTime() : (nm.startTime ? new Date(nm.startTime).getTime() : null),
        endedAt: nm.endedAt ? new Date(nm.endedAt).getTime() : (nm.endTime ? new Date(nm.endTime).getTime() : null),
        errorCode: nm.errorCode || nm.errorMessage || null,
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
    var dagMetrics = metrics.dagExecutionMetrics || {};
    this._startedAt = dagMetrics.startedAt ? new Date(dagMetrics.startedAt).getTime() : (metrics.startTime ? new Date(metrics.startTime).getTime() : null);
    this._endedAt = dagMetrics.endedAt ? new Date(dagMetrics.endedAt).getTime() : (metrics.endTime ? new Date(metrics.endTime).getTime() : null);
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
    var attrs = telemetry.attributes || {};
    // Priority 1: explicit node ID attribute
    var directId = attrs.nodeId || attrs.NodeId;
    if (directId && this._dagNodes.has(directId)) return directId;
    // Priority 2: explicit name attributes (camelCase + PascalCase)
    var attrName = attrs.nodeName || attrs.NodeName || attrs.mlvName || attrs.MlvName || attrs.MLVName;
    if (attrName) {
      var id = this._nodeNameIndex.get(attrName.toLowerCase());
      if (id) return id;
    }
    // Priority 3: substring match in activityName
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
    var attrs = t.attributes || {};
    var errorCode = t.errorCode || attrs.errorCode || attrs.ErrorCode || null;
    // Infer startedAt from duration if this is a terminal event and we have no prior start
    var inferredStart = current.startedAt;
    if (!inferredStart && t.durationMs) {
      inferredStart = (timestamp || Date.now()) - t.durationMs;
    } else if (!inferredStart) {
      inferredStart = timestamp || Date.now();
    }
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
        startedAt: inferredStart,
        endedAt: timestamp || Date.now(),
        errorCode: null,
        source: 'telemetry',
      };
    } else if (activityStatus === 'failed' || activityStatus === 'faulted') {
      newState = {
        status: 'failed',
        startedAt: inferredStart,
        endedAt: timestamp || Date.now(),
        errorCode: errorCode,
        source: 'telemetry',
      };
    } else if (activityStatus === 'cancelled' || activityStatus === 'canceled') {
      newState = {
        status: 'cancelled',
        startedAt: inferredStart,
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
      // Race guard: a synthetic NodeExecution Failed from EdogErrorSimEngine
      // (pre-GTS fault injection) can arrive BEFORE RunDAG Started on a
      // single-node DAG, driving _executionStatus to 'failed' via
      // _checkCompletion(). Ignore a late RunDAG Started in that case so the
      // failed state isn't silently regressed back to 'running'.
      if (this._isTerminal(this._executionStatus)) return;
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
      // FLT may emit terminal-only events (e.g., Succeeded without prior Started)
      pending: ['running', 'completed', 'failed', 'cancelled', 'skipped'],
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
    this._errorSim = new ErrorSimulator();
    this._renderer = null;
    this._gantt = null;
    this._dag = null;
    this._active = false;
    this._activationId = 0;
    this._pendingCompletionRefresh = false;
    this._lockCheckInterval = null;
    this._elapsedInterval = null;
    this._execPollInterval = null;
    this._lastLockState = false;
    this._codeCache = new Map();
    this._workspaceId = null;
    var self = this;
    this._dagRetried = false;

    // DOM refs
    this._runBtn = document.getElementById('dagRunBtn');
    this._cancelBtn = document.getElementById('dagCancelBtn');
    this._refreshBtn = document.getElementById('dagRefreshBtn');
    this._unlockBtn = document.getElementById('dagUnlockBtn');
    this._statusDot = document.getElementById('dagStatusDot');
    this._statusText = document.getElementById('dagStatusText');
    this._statusTimer = document.getElementById('dagStatusTimer');
    this._graphPanel = document.getElementById('dagGraphPanel');
    this._historyContainer = document.getElementById('dagHistoryContainer');
    this._nodeDetail = document.getElementById('dagNodeDetail');
    this._detailSection = document.getElementById('dagDetailSection');
    this._ganttContainer = document.getElementById('dagGanttContainer');
    this._ganttCount = document.getElementById('dagGanttCount');
    this._lockIndicator = null; // Removed — lock state now part of toolbar matrix
    this._execModeBtn = document.getElementById('dagExecModeBtn');
    this._execModeDropdown = document.getElementById('dagExecModeDropdown');
    this._sumTotal = document.getElementById('dagSumTotal');
    this._sumOk = document.getElementById('dagSumOk');
    this._sumFail = document.getElementById('dagSumFail');
    this._sumRun = document.getElementById('dagSumRun');
    this._sumDur = document.getElementById('dagSumDur');

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

    // History refresh button
    var histRefresh = document.getElementById('dagHistoryRefresh');
    if (histRefresh) {
      histRefresh.addEventListener('click', function() { self._loadHistory(); });
    }

    // Exec mode dropdown
    if (this._execModeBtn && this._execModeDropdown) {
      this._execModeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        self._execModeDropdown.classList.toggle('open');
      });
      var modeOptions = this._execModeDropdown.querySelectorAll('.exec-mode-option');
      for (var i = 0; i < modeOptions.length; i++) {
        modeOptions[i].addEventListener('click', function() {
          var opts = self._execModeDropdown.querySelectorAll('.exec-mode-option');
          for (var j = 0; j < opts.length; j++) {
            opts[j].classList.remove('active');
            opts[j].querySelector('.check').textContent = '';
          }
          this.classList.add('active');
          this.querySelector('.check').textContent = '\u2713';
          var label = document.getElementById('dagExecModeLabel');
          if (label) label.textContent = this.textContent.trim().replace('\u2713', '').trim();
          self._execModeDropdown.classList.remove('open');
        });
      }
      document.addEventListener('click', function() {
        self._execModeDropdown.classList.remove('open');
      });
    }
  }

  async activate() {
    if (this._active) return;
    this._active = true;
    var activationId = ++this._activationId;
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
    this._renderer.onNodeContextMenu = function(nodeId, x, y) {
      var node = self._findNodeById(nodeId);
      if (!node) return;
      // If the right-clicked node is part of a multi-selection (size > 1),
      // open the picker targeting the entire selection. Otherwise single.
      var selected = (typeof self._renderer.getSelectedNodeIds === 'function')
        ? self._renderer.getSelectedNodeIds() : [];
      var multi = selected.length > 1 && selected.indexOf(nodeId) !== -1;
      if (multi) {
        var targets = [];
        for (var i = 0; i < selected.length; i++) {
          var n = self._findNodeById(selected[i]);
          if (!n) continue;
          targets.push({
            id: selected[i],
            name: n.name || n.nodeId || n.id || selected[i],
            kind: (n.kind || n.type || 'unknown').toString().toLowerCase()
          });
        }
        self._errorSim.showPickerForSelection(targets);
      } else {
        var name = node.name || node.nodeId || node.id || nodeId;
        var kind = (node.kind || node.type || 'unknown');
        self._errorSim.showPicker(nodeId, name, kind, x, y);
      }
    };
    // Live picker target updates: shift/ctrl-click on canvas while picker is
    // open should re-target without forcing a close/reopen.
    this._renderer.onSelectionChanged = function(nodeIds) {
      if (self._errorSim && typeof self._errorSim.updateSelectionFromCanvas === 'function') {
        self._errorSim.updateSelectionFromCanvas(nodeIds);
      }
    };
    // Init error simulator now that SignalR + renderer are wired
    this._errorSim.init(self._signalR, self);
    // Re-paint badges after a layout/render cycle (DOM nodes may have just been created)
    setTimeout(function() { self._errorSim._refreshNodeBadges(); }, 50);
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
    // Ensure SignalR subscriptions (idempotent — no-op if already active)
    this._signalR.on('telemetry', this._onTelemetryEvent);
    this._signalR.subscribeTopic('telemetry');
    this._signalR.on('log', this._onLogEntry);
    this._signalR.subscribeTopic('log');
    // Keyboard shortcuts
    document.addEventListener('keydown', this._onKeyDown);
    // Snapshot execution state before async work
    var hasExecState = !!this._esm.activeIterationId && this._esm.status !== 'idle';
    requestAnimationFrame(async function() {
      if (!self._active || activationId !== self._activationId) return;
      await self._loadDag();
      if (!self._active || activationId !== self._activationId) return;
      if (hasExecState) {
        self._restoreExecutionState();
      } else {
        await self._loadHistory();
      }
      if (!self._active || activationId !== self._activationId) return;
      self._startLockCheck();
    });
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    // Keep SignalR subscriptions + listeners alive — they self-guard
    // via _esm.activeIterationId check and the _active guard in callbacks.
    // Never call unsubscribeTopic (it kills shared topic streams used by
    // main.js too). ESM continues tracking active executions while the
    // user is on another tab.
    // Pause rendering
    if (this._renderer) this._renderer.pauseRendering();
    // Remove keyboard listener
    document.removeEventListener('keydown', this._onKeyDown);
    // Stop intervals
    this._stopLockCheck();
    this._stopElapsedTimer();
    this._stopExecPoller();
  }

  async _loadDag() {
    try {
      this._renderLoading();
      // Refresh config so MWC token and fabricBaseUrl are current
      await this._api.fetchConfig();
      var dag = await this._api.getLatestDag();
      if (!dag && !this._dagRetried) {
        this._dagRetried = true;
        await new Promise(function(resolve) { setTimeout(resolve, 300); });
        dag = await this._api.getLatestDag();
      }
      if (!dag) {
        this._renderEmpty('No DAG found. Ensure FLT is configured.');
        return;
      }

      var rawNodes = Array.isArray(dag.nodes) ? dag.nodes : [];
      var nodes = rawNodes.map(function(n) {
        var node = Object.assign({}, n);
        node.id = n.nodeId || n.id;
        node.nodeId = n.nodeId || n.id;
        // Ensure name is always populated — FLT source tables may have empty name
        node.name = n.name || n.mlvName || n.tableName || n.nodeId || n.id;
        return node;
      }).filter(function(n) {
        return !!n.id;
      });

      var edges = [];
      if (Array.isArray(dag.edges) && dag.edges.length > 0) {
        edges = dag.edges.map(function(e) {
          return {
            from: e.from || e.source || e.parentNodeId || e.parent || e.src,
            to: e.to || e.target || e.childNodeId || e.child || e.dst,
          };
        }).filter(function(e) {
          return !!(e.from && e.to);
        });
      } else {
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          var children = Array.isArray(node.children) ? node.children : [];
          for (var j = 0; j < children.length; j++) {
            edges.push({ from: node.id, to: children[j] });
          }
        }
      }

      if (nodes.length === 0) {
        this._renderEmpty('No DAG found. Ensure FLT is configured.');
        return;
      }

      this._dagRetried = false;
      this._dag = Object.assign({}, dag, { nodes: nodes, edges: edges });
      this._esm.setDag(this._dag);
      var layoutResult = this._layout.layout(nodes, edges);
      this._renderer.setData(layoutResult.nodes, layoutResult.edges);
      this._renderer.fitToScreen();
      // Remove loading overlay and restore canvas (hidden by _renderLoading)
      var loadingEl = this._graphPanel ? this._graphPanel.querySelector('.dag-loading') : null;
      if (loadingEl) loadingEl.remove();
      var canvas = this._graphPanel ? this._graphPanel.querySelector('canvas') : null;
      if (canvas) canvas.style.opacity = '1';
      var minimap = this._graphPanel ? this._graphPanel.querySelector('.dag-minimap') : null;
      if (minimap) minimap.style.opacity = '1';
      var executableCount = nodes.filter(function(n) { return n.executable !== false; }).length;
      if (this._ganttCount) this._ganttCount.textContent = String(executableCount);
      var currentStatus = this._esm.activeIterationId ? this._esm.status : 'idle';
      this._renderControls(currentStatus);
      this._renderStatus(currentStatus);
      this._updateSummary();
    } catch (err) {
      console.error('[DagStudio] Failed to load DAG:', err);
      this._renderEmpty('Failed to load DAG: ' + (err.message || err));
    }
  }

  async _runDag() {
    try {
      this._runBtn.disabled = true;

      // Check for stuck lock first
      try {
        var locked = await this._api.getLockedExecution();
        if (locked) {
          // API returns { LockedIterationIds: ["guid", ...] } or a string or array
          var lockedId = null;
          if (locked.LockedIterationIds && locked.LockedIterationIds.length > 0) {
            lockedId = locked.LockedIterationIds[0];
          } else if (locked.lockedIterationIds && locked.lockedIterationIds.length > 0) {
            lockedId = locked.lockedIterationIds[0];
          } else if (typeof locked === 'string') {
            lockedId = locked;
          } else if (Array.isArray(locked) && locked.length > 0) {
            lockedId = locked[0];
          } else if (locked.iterationId) {
            lockedId = locked.iterationId;
          }
          if (lockedId) {
            var shouldUnlock = confirm('DAG is locked by iteration ' + String(lockedId) + '\n\nForce unlock and run?');
            if (!shouldUnlock) {
              this._runBtn.disabled = false;
              return;
            }
            await this._api.forceUnlockDag(lockedId);
            this._lastLockState = false;
            if (typeof edogToast === 'function') edogToast('DAG unlocked', 'info');
          }
        }
      } catch (lockErr) {
        // Lock check failed (401, etc.) — proceed anyway, runDag will fail if truly locked
      }

      var iterationId = crypto.randomUUID();
      // Start tracking BEFORE API call so early telemetry/log events aren't dropped
      this._esm.startTracking(iterationId);
      // Bootstrap the SmartContextBar immediately so the user sees feedback
      // the instant they click Run, regardless of whether SignalR delivers
      // logs/telemetry. The poll fallback keeps it updated.
      if (this._autoDetector) {
        this._autoDetector.ensureExecution(iterationId);
        var execBoot = this._autoDetector.detectedExecutions.get(iterationId);
        if (execBoot) {
          execBoot.status = 'Running';
          execBoot.startTime = Date.now();
          execBoot.nodeCount = this._esm.nodeStates.size;
          this._autoDetector.activeExecutionId = iterationId;
          if (this._autoDetector.onExecutionDetected) {
            this._autoDetector.onExecutionDetected(execBoot, iterationId);
          }
        }
      }
      if (this._gantt && this._dag && this._dag.nodes) {
        var executableNodes = this._dag.nodes.filter(function(n) { return n.executable !== false; });
        this._gantt.renderExecution(executableNodes, Date.now());
      }
      this._renderControls('running');
      this._renderStatus('running');
      this._startElapsedTimer();
      var result = await this._api.runDag(iterationId);
      if (result === null) {
        // API returned null (no MWC token) — roll back
        this._esm.reset();
        this._runBtn.disabled = false;
        this._stopElapsedTimer();
        this._renderControls('idle');
        this._renderStatus('error', 'Run failed: not connected');
        return;
      }
      if (typeof edogToast === 'function') edogToast('DAG execution started', 'info');
      // Start polling execution metrics as a fallback for real-time updates
      this._startExecPoller();
    } catch (err) {
      console.error('[DagStudio] Failed to run DAG:', err);
      this._esm.reset();
      this._runBtn.disabled = false;
      this._stopElapsedTimer();
      this._renderControls('idle');
      this._renderStatus('error', 'Run failed: ' + (err.message || err));
    }
  }

  async _cancelDag() {
    var iterationId = this._esm.activeIterationId;
    if (!iterationId) return;
    if (!confirm('Cancel the running DAG execution?')) return;
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
    this._dagRetried = false;
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
      // Parse locked iteration ID from response
      var lockedId = null;
      if (locked.LockedIterationIds && locked.LockedIterationIds.length > 0) {
        lockedId = locked.LockedIterationIds[0];
      } else if (locked.lockedIterationIds && locked.lockedIterationIds.length > 0) {
        lockedId = locked.lockedIterationIds[0];
      } else if (typeof locked === 'string') {
        lockedId = locked;
      } else if (Array.isArray(locked) && locked.length > 0) {
        lockedId = locked[0];
      } else if (locked.iterationId) {
        lockedId = locked.iterationId;
      }
      if (!lockedId) {
        this._unlockBtn.style.display = 'none';
        return;
      }
      await this._api.forceUnlockDag(lockedId);
      this._lastLockState = false;
      this._renderToolbarState('idle', { locked: false, message: 'DAG unlocked' });
      if (typeof edogToast === 'function') edogToast('DAG unlocked successfully', 'success');
    } catch (err) {
      console.error('[DagStudio] Failed to unlock DAG:', err);
      if (typeof edogToast === 'function') edogToast('Failed to unlock DAG', 'error');
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
      this._updateSummary();
      if (this._statusTimer) this._statusTimer.style.display = 'none';
    } catch (err) {
      console.error('[DagStudio] Failed to load execution:', err);
    }
  }

  /** Restore execution visuals from ESM state after tab switch. */
  async _restoreExecutionState() {
    var status = this._esm.status;
    var isRunning = status === 'running';
    var isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    // Re-apply node states to renderer and gantt
    if (this._gantt && this._dag && this._dag.nodes) {
      var executableNodes = this._dag.nodes.filter(function(n) { return n.executable !== false; });
      this._gantt.renderExecution(executableNodes, this._esm.startedAt || Date.now());
    }
    for (var entry of this._esm.nodeStates) {
      if (this._renderer) this._renderer.updateNodeState(entry[0], entry[1].status);
      if (this._gantt) this._gantt.updateBar(entry[0], entry[1]);
    }
    this._renderControls(status);
    this._renderStatus(status);
    this._updateSummary();
    if (isRunning) {
      this._startElapsedTimer();
      this._startExecPoller();
      this._pollExecStatus();
    } else if (isTerminal || this._pendingCompletionRefresh) {
      this._pendingCompletionRefresh = false;
      if (this._statusTimer) this._statusTimer.style.display = 'none';
      await this._loadHistory();
      this._checkLockState();
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
      var hasLock = !!(locked && ((locked.LockedIterationIds && locked.LockedIterationIds.length > 0) || (locked.lockedIterationIds && locked.lockedIterationIds.length > 0)));
      this._lastLockState = hasLock;
      // Re-render toolbar with current lock state
      this._renderToolbarState(this._esm.status, { locked: hasLock });
    } catch (err) {
      // Silently ignore lock check failures
    }
  }

  _startElapsedTimer() {
    this._stopElapsedTimer();
    var startedAt = this._esm.startedAt || Date.now();
    var self = this;
    if (this._statusTimer) this._statusTimer.style.display = 'inline';
    this._elapsedInterval = setInterval(function() {
      var elapsed = Date.now() - startedAt;
      var totalSecs = Math.floor(elapsed / 1000);
      var m = Math.floor(totalSecs / 60);
      var s = totalSecs % 60;
      var timeStr = m + ':' + (s < 10 ? '0' : '') + s;
      if (self._statusTimer) self._statusTimer.textContent = timeStr;
      self._statusText.textContent = 'Running';
    }, 100);
  }

  _stopElapsedTimer() {
    if (this._elapsedInterval) {
      clearInterval(this._elapsedInterval);
      this._elapsedInterval = null;
    }
  }

  /** Poll execution metrics every 5s during active run — guarantees UI updates even if SignalR is silent. */
  _startExecPoller() {
    this._stopExecPoller();
    var self = this;
    this._execPollInterval = setInterval(function() {
      if (!self._esm.activeIterationId || self._esm.status !== 'running') {
        self._stopExecPoller();
        return;
      }
      self._pollExecStatus();
    }, 5000);
  }

  _stopExecPoller() {
    if (this._execPollInterval) {
      clearInterval(this._execPollInterval);
      this._execPollInterval = null;
    }
  }

  /** Lightweight status-only poll during running state. Uses getDagExecStatus
   *  (single field response) instead of getDagExecMetrics (full node data).
   *  When terminal status detected, stops poller and triggers one final
   *  _pollExecMetrics call for the full node metrics. */
  async _pollExecStatus() {
    var iterationId = this._esm.activeIterationId;
    if (!iterationId) return;
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    try {
      var statusData = await this._api.getDagExecStatus(iterationId);
      if (!statusData) return;
      var status = (statusData.status || statusData.dagExecutionStatus || '').toLowerCase();
      if (status === 'completed' || status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        this._esm._executionStatus = status === 'succeeded' ? 'completed' : status;
        this._esm._endedAt = Date.now();
        this._stopExecPoller();
        // Now fetch full metrics once
        this._pollInFlight = false;
        await this._pollExecMetrics();
        return;
      }
      // Still running — update summary
      this._updateSummary();
    } catch (err) {
      console.log('[DAG-DIAG] Status poll failed:', err.message);
    } finally {
      this._pollInFlight = false;
    }
  }

  async _pollExecMetrics() {
    var iterationId = this._esm.activeIterationId;
    if (!iterationId) return;
    // Guard against stacking polls when FLT is slow/unresponsive
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    try {
      var metrics = await this._api.getDagExecMetrics(iterationId);
      if (!metrics) return;

      // Accept both spellings the FLT controller may emit.
      var raw = metrics.nodeExecutionMetrices || metrics.nodeExecutionMetrics || {};
      var entries = Array.isArray(raw) ? raw : Object.entries(raw);
      for (var i = 0; i < entries.length; i++) {
        var nid, nm;
        if (Array.isArray(raw)) {
          nm = entries[i];
          nid = nm.nodeId || this._esm._nodeNameIndex.get((nm.nodeName || nm.mlvName || '').toLowerCase());
        } else {
          nid = entries[i][0];
          nm = entries[i][1];
          if (nm && !nm.nodeId && this._esm._nodeNameIndex.has(nid.toLowerCase())) {
            nid = this._esm._nodeNameIndex.get(nid.toLowerCase());
          }
        }
        if (!nid || !nm) continue;
        var current = this._esm.nodeStates.get(nid);
        var newStatus = this._esm._mapNodeStatus(nm.status || nm.nodeExecutionStatus);
        if (current && current.status !== newStatus) {
          var startMs = nm.startedAt ? new Date(nm.startedAt).getTime() : (nm.startTime ? new Date(nm.startTime).getTime() : current.startedAt);
          var endMs = nm.endedAt ? new Date(nm.endedAt).getTime() : (nm.endTime ? new Date(nm.endTime).getTime() : null);
          this._esm._nodeStates.set(nid, {
            status: newStatus,
            startedAt: startMs,
            endedAt: endMs,
            errorCode: nm.errorCode || null,
            source: 'poll',
          });
          if (this._esm.onNodeStateChanged) this._esm.onNodeStateChanged(nid, this._esm._nodeStates.get(nid));
        }
      }

      // Always refresh overall execution status — even when nodes haven't
      // populated yet (FLT may report `notStarted` for several seconds after
      // RunDAG returns 202). The summary/strip must still update.
      var dagMetrics = metrics.dagExecutionMetrics || {};
      var overallStatus = (dagMetrics.status || '').toLowerCase();
      if (overallStatus === 'completed' || overallStatus === 'succeeded' || overallStatus === 'failed' || overallStatus === 'cancelled') {
        this._esm._executionStatus = overallStatus === 'succeeded' ? 'completed' : overallStatus;
        this._esm._endedAt = dagMetrics.endedAt ? new Date(dagMetrics.endedAt).getTime() : Date.now();
        this._stopExecPoller();
        // FLT populates nodeExecutionMetrices AFTER the execution fully
        // completes.  The poller often catches the terminal status before
        // per-node data is written.  Wait 2 s then do ONE final fetch so
        // the Gantt chart, bottom-bar, and strip all show correct numbers.
        var self = this;
        var finalIterationId = iterationId;
        var statusBeforeFinal = this._esm._executionStatus;
        setTimeout(async function() {
          try {
            var finalMetrics = await self._api.getDagExecMetrics(finalIterationId);
            if (finalMetrics) {
              var finalRaw = finalMetrics.nodeExecutionMetrices || finalMetrics.nodeExecutionMetrics || {};
              var finalEntries = Array.isArray(finalRaw) ? finalRaw : Object.entries(finalRaw);
              var anyNodeChanged = false;
              for (var j = 0; j < finalEntries.length; j++) {
                var fnid, fnm;
                if (Array.isArray(finalRaw)) {
                  fnm = finalEntries[j];
                  fnid = fnm.nodeId || self._esm._nodeNameIndex.get((fnm.nodeName || fnm.mlvName || '').toLowerCase());
                } else {
                  fnid = finalEntries[j][0];
                  fnm = finalEntries[j][1];
                  if (fnm && !fnm.nodeId && self._esm._nodeNameIndex.has(fnid.toLowerCase())) {
                    fnid = self._esm._nodeNameIndex.get(fnid.toLowerCase());
                  }
                }
                if (!fnid || !fnm) continue;
                var newStatus = self._esm._mapNodeStatus(fnm.status || fnm.nodeExecutionStatus);
                var existing = self._esm._nodeStates.get(fnid);
                // Only emit if node state actually changed from what we already have
                if (existing && existing.status === newStatus && existing.source === 'final-poll') continue;
                var startMs = fnm.startedAt ? new Date(fnm.startedAt).getTime() : (fnm.startTime ? new Date(fnm.startTime).getTime() : null);
                var endMs = fnm.endedAt ? new Date(fnm.endedAt).getTime() : (fnm.endTime ? new Date(fnm.endTime).getTime() : null);
                self._esm._nodeStates.set(fnid, {
                  status: newStatus,
                  startedAt: startMs,
                  endedAt: endMs,
                  errorCode: fnm.errorCode || null,
                  source: 'final-poll',
                });
                anyNodeChanged = true;
                if (self._esm.onNodeStateChanged) self._esm.onNodeStateChanged(fnid, self._esm._nodeStates.get(fnid));
              }
              self._pushPollToAutoDetector(finalIterationId, dagMetrics, finalEntries, Array.isArray(finalRaw));
            }
          } catch (e) {
            console.log('[DAG-DIAG] Final poll failed:', e.message);
          }
          self._updateSummary();
          // Only fire execution state changed if status actually changed during final poll
          if (self._esm._executionStatus !== statusBeforeFinal) {
            if (self._esm.onExecutionStateChanged) self._esm.onExecutionStateChanged(self._esm._executionStatus);
          }
          if (self._esm.onExecutionComplete) self._esm.onExecutionComplete(finalIterationId, self._esm._executionStatus);
        }, 2000);
      } else {
        // notStarted / running / queued — keep polling, keep UI alive.
        this._updateSummary();
        this._pushPollToAutoDetector(iterationId, dagMetrics, entries, Array.isArray(raw));
      }
    } catch (err) {
      // Poll failed — silently retry next interval
      console.log('[DAG-DIAG] Poll failed:', err.message);
    } finally {
      this._pollInFlight = false;
    }
  }

  /**
   * Feed poll results into the AutoDetector so the SmartContextBar appears
   * even when SignalR log/telemetry events are silent (e.g. very early in a
   * 202-accepted execution, or if the stream subscription isn't live yet).
   */
  _pushPollToAutoDetector(iterationId, dagMetrics, entries, isArray) {
    if (!this._autoDetector) return;
    this._autoDetector.ensureExecution(iterationId);
    var exec = this._autoDetector.detectedExecutions.get(iterationId);
    if (!exec) return;
    // Map FLT status to AutoDetector vocabulary.
    var status = (dagMetrics.status || '').toLowerCase();
    if (status === 'notstarted' || status === 'queued') {
      exec.status = 'Running';
    } else if (status === 'running' || status === 'inprogress') {
      exec.status = 'Running';
    } else if (status === 'succeeded' || status === 'completed') {
      exec.status = 'Completed';
    } else if (status === 'failed') {
      exec.status = 'Failed';
    } else if (status === 'cancelled') {
      exec.status = 'Cancelled';
    } else if (!exec.status || exec.status === 'Unknown') {
      exec.status = 'Running';
    }
    if (!exec.startTime) {
      exec.startTime = dagMetrics.startedAt || this._esm.startedAt || Date.now();
    }
    // Recount nodes from the polled snapshot.
    var done = 0, failed = 0;
    if (entries && entries.length) {
      for (var i = 0; i < entries.length; i++) {
        var nm = isArray ? entries[i] : entries[i][1];
        var s = ((nm && (nm.status || nm.nodeExecutionStatus)) || '').toLowerCase();
        if (s === 'succeeded' || s === 'completed') done++;
        else if (s === 'failed') failed++;
      }
      exec.completedNodes = done;
      exec.failedNodes = failed;
      if (!exec.nodeCount) exec.nodeCount = entries.length;
    } else if (!exec.nodeCount && this._esm.nodeStates.size) {
      exec.nodeCount = this._esm.nodeStates.size;
    }
    // First detection — fire onExecutionDetected so SmartContextBar reveals
    // itself; subsequent ticks fire onExecutionUpdated.
    if (this._autoDetector.activeExecutionId !== iterationId) {
      this._autoDetector.activeExecutionId = iterationId;
      if (this._autoDetector.onExecutionDetected) {
        this._autoDetector.onExecutionDetected(exec, iterationId);
      }
    } else if (this._autoDetector.onExecutionUpdated) {
      this._autoDetector.onExecutionUpdated(exec, iterationId);
    }
  }

  // --- Event handlers ---

  _onTelemetryEvent(event) {
    if (!this._esm.activeIterationId) return;
    console.log('[DAG-DIAG] Telemetry event:', event && event.data ? event.data.activityName : 'no-data', event);
    this._esm.processTelemetry(event);
  }

  _onLogEntry(entry) {
    if (!this._esm.activeIterationId) return;
    // Log topic streams {sequenceId, timestamp, topic, data} — unwrap to get the actual log entry
    var log = entry && entry.data ? entry.data : entry;
    var msg = log.message || '';
    // Only log DAG-relevant messages to avoid flooding
    if (msg.includes('DAG') || msg.includes('Executing') || msg.includes('Executed') || msg.includes('node') || msg.includes('faulted')) {
      console.log('[DAG-DIAG] Log entry:', msg.substring(0, 120), 'iterationId:', log.iterationId);
    }
    this._autoDetector.processLog(log);
    var exec = this._autoDetector.detectedExecutions.get(this._esm.activeIterationId);
    if (exec) {
      console.log('[DAG-DIAG] AutoDetector match for', this._esm.activeIterationId, 'status:', exec.status, 'nodes:', exec.nodes ? exec.nodes.size : 0);
      this._esm.processAutoDetectorUpdate(exec);
    }
  }

  _onNodeSelected(nodeId) {
    this._renderNodeDetail(nodeId);
    if (this._renderer) this._renderer.highlightNode(nodeId);
    if (this._gantt) this._gantt.highlightNode(nodeId);
  }

  _onExecutionStateChanged(status) {
    console.log('[DAG-DIAG] Execution state changed:', status);
    if (!this._active) return;
    this._renderControls(status);
    this._renderStatus(status);
    this._updateSummary();
    if (status !== 'running') {
      this._stopElapsedTimer();
      if (this._statusTimer) this._statusTimer.style.display = 'none';
    }
  }

  _onNodeStateChanged(nodeId, state) {
    console.log('[DAG-DIAG] Node state changed:', nodeId.substring(0, 8), state.status, state.source);
    if (!this._active) return;
    if (this._renderer) this._renderer.updateNodeState(nodeId, state.status);
    if (this._gantt) this._gantt.updateBar(nodeId, state);
    this._updateSummary();
  }

  _onExecutionComplete(iterationId, finalStatus) {
    this._stopElapsedTimer();
    this._stopExecPoller();
    if (!this._active) {
      this._pendingCompletionRefresh = true;
      return;
    }
    if (this._statusTimer) this._statusTimer.style.display = 'none';
    this._renderControls(finalStatus);
    this._renderStatus(finalStatus);
    this._updateSummary();
    this._loadHistory();
    // Refresh lock state — execution complete means lock should be released
    this._checkLockState();
    if (typeof edogToast === 'function') {
      if (finalStatus === 'completed') {
        edogToast('DAG completed successfully', 'success');
      } else if (finalStatus === 'failed') {
        edogToast('DAG execution failed', 'error');
      } else if (finalStatus === 'cancelled') {
        edogToast('DAG execution cancelled', 'info');
      }
    }
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
      if (this._detailSection) this._detailSection.style.display = 'none';
      if (this._renderer) this._renderer.clearHighlight();
      if (this._gantt) this._gantt.unhoverNode();
      if (this._execModeDropdown) this._execModeDropdown.classList.remove('open');
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

  /**
   * Full toolbar state matrix.
   * Controls: Run/Cancel visibility, Refresh disabled, Unlock visibility.
   * Info bar: iteration ID, RAID.
   * Status: dot color + text + timer.
   */
  _renderToolbarState(status, opts) {
    opts = opts || {};
    var isLocked = opts.locked || false;
    var isIdle = status === 'idle' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped';
    var isRunning = status === 'running' || status === 'cancelling';

    // --- Buttons ---
    this._runBtn.style.display = isIdle && !isLocked ? '' : 'none';
    this._runBtn.disabled = false;
    this._runBtn.innerHTML = (status === 'failed') ? '&#9654; Re-run DAG' : '&#9654; Run DAG';
    this._cancelBtn.style.display = (status === 'running') ? '' : 'none';
    this._cancelBtn.disabled = false;
    this._refreshBtn.disabled = isRunning;
    // Unlock: show only when locked
    this._unlockBtn.style.display = isLocked ? '' : 'none';

    // --- Status dot + text ---
    var dot = this._statusDot;
    dot.style.animation = 'none';
    if (status === 'running') {
      dot.style.background = 'var(--accent)';
      dot.style.animation = 'dagDotPulse 1.5s ease-in-out infinite';
      this._statusText.textContent = opts.message || 'Running';
    } else if (status === 'completed') {
      dot.style.background = 'var(--status-succeeded)';
      this._statusText.textContent = opts.message || 'Completed';
    } else if (status === 'failed') {
      dot.style.background = 'var(--status-failed)';
      this._statusText.textContent = opts.message || 'Failed';
    } else if (status === 'cancelled') {
      dot.style.background = 'var(--status-cancelled)';
      this._statusText.textContent = opts.message || 'Cancelled';
    } else if (status === 'cancelling') {
      dot.style.background = 'var(--status-cancelled)';
      dot.style.animation = 'dagDotPulse 1.5s ease-in-out infinite';
      this._statusText.textContent = 'Cancelling...';
    } else if (status === 'skipped') {
      dot.style.background = 'var(--status-pending)';
      this._statusText.textContent = opts.message || 'Skipped (lock conflict)';
    } else if (isLocked) {
      dot.style.background = 'var(--status-cancelled)';
      this._statusText.textContent = 'Locked';
    } else if (status === 'error') {
      dot.style.background = 'var(--status-failed)';
      this._statusText.textContent = opts.message || 'Error';
    } else {
      dot.style.background = 'var(--status-pending)';
      this._statusText.textContent = opts.message || 'Idle';
    }

    // --- Info bar: iteration ID + RAID ---
    var infoEl = document.getElementById('dagToolbarInfo');
    if (infoEl) {
      var iterId = this._esm.activeIterationId;
      if (iterId && (isRunning || status === 'completed' || status === 'failed' || status === 'cancelled')) {
        var html = '<span class="dag-info-label">iter</span><span class="dag-info-val" title="Click to copy" data-copy="' + this._escapeHtml(iterId) + '">' + this._escapeHtml(iterId) + '</span>';
        // RAID from autodetector
        var exec = this._autoDetector.detectedExecutions.get(iterId);
        if (exec && exec.raids && exec.raids.size > 0) {
          var raid = exec.raids.values().next().value;
          html += '<span class="dag-info-sep"></span><span class="dag-info-label">RAID</span><span class="dag-info-val" title="Click to copy" data-copy="' + this._escapeHtml(raid) + '">' + this._escapeHtml(raid) + '</span>';
        }
        infoEl.innerHTML = html;
        infoEl.style.display = 'flex';
        // Bind copy-on-click
        var vals = infoEl.querySelectorAll('.dag-info-val');
        for (var i = 0; i < vals.length; i++) {
          vals[i].addEventListener('click', function() {
            var text = this.getAttribute('data-copy');
            if (text && navigator.clipboard) {
              navigator.clipboard.writeText(text);
              if (typeof edogToast === 'function') edogToast('Copied to clipboard', 'info');
            }
          });
        }
      } else {
        infoEl.style.display = 'none';
        infoEl.innerHTML = '';
      }
    }
  }

  // Backward-compat wrappers — all callers use these
  _renderControls(status) {
    this._renderToolbarState(status, { locked: this._lastLockState });
  }

  _renderStatus(status, message) {
    this._renderToolbarState(status, { message: message, locked: this._lastLockState });
  }

  _renderLoading() {
    // Place loading overlay in the graph panel (not nodes layer) so it stays
    // centered regardless of camera transforms.
    var existing = this._graphPanel ? this._graphPanel.querySelector('.dag-loading') : null;
    if (existing) existing.remove();
    var nodesLayer = this._graphPanel ? this._graphPanel.querySelector('#dagNodesLayer') : null;
    if (nodesLayer) nodesLayer.innerHTML = '';
    if (this._graphPanel) {
      var loading = document.createElement('div');
      loading.className = 'dag-loading';
      loading.innerHTML =
        '<div class="dag-loading-spinner"></div>' +
        '<div class="dag-loading-text">Loading DAG</div>' +
        '<div class="dag-loading-sub">Fetching graph structure...</div>';
      this._graphPanel.appendChild(loading);
    }
    // Hide the canvas during loading — prevents stale edges from rendering
    // while the "Loading DAG" overlay is visible. Restored by _loadDag after setData.
    var canvas = this._graphPanel ? this._graphPanel.querySelector('canvas') : null;
    if (canvas) canvas.style.opacity = '0';
    var minimap = this._graphPanel ? this._graphPanel.querySelector('.dag-minimap') : null;
    if (minimap) minimap.style.opacity = '0';
  }

  _renderEmpty(message) {
    var nodesLayer = this._graphPanel ? this._graphPanel.querySelector('#dagNodesLayer') : null;
    if (nodesLayer) {
      nodesLayer.innerHTML = '<div class="dag-empty-hint">' + message + '</div>';
    }
  }

  _renderHistory(iterations) {
    if (!iterations || iterations.length === 0) {
      this._historyContainer.innerHTML = '<div class="dag-empty-hint">No execution history</div>';
      return;
    }
    var html = '<table class="dag-history-table">';
    html += '<thead><tr><th>Run</th><th>Status</th><th>Duration</th><th>Time</th></tr></thead><tbody>';
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      var id = it.iterationId || it;
      var shortId = id;
      var status = (it.status || '\u2014').toString();
      var statusClass = status.toLowerCase();
      var startedAt = it.startedAt || it.startTime;
      var endedAt = it.endedAt || it.endTime;
      var duration = '\u2014';
      if (startedAt && endedAt) {
        duration = ((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000).toFixed(1) + 's';
      }
      var time = startedAt ? new Date(startedAt).toLocaleString() : '\u2014';
      html += '<tr class="dag-history-row" data-iteration="' + id + '">';
      html += '<td title="' + id + '">' + shortId + '</td>';
      html += '<td><span class="status-pill ' + statusClass + '">' + status + '</span></td>';
      html += '<td>' + duration + '</td>';
      html += '<td>' + time + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
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

  /** Find a DAG node by ID (returns the node object or null). */
  _findNodeById(nodeId) {
    if (!this._dag || !this._dag.nodes) return null;
    for (var i = 0; i < this._dag.nodes.length; i++) {
      var candidate = this._dag.nodes[i];
      if ((candidate.nodeId || candidate.id) === nodeId) return candidate;
    }
    return null;
  }

  _renderNodeDetail(nodeId) {
    if (!nodeId || !this._dag) {
      if (this._detailSection) this._detailSection.style.display = 'none';
      return;
    }
    var node = this._findNodeById(nodeId);
    if (!node) {
      if (this._detailSection) this._detailSection.style.display = 'none';
      return;
    }
    var state = this._esm.nodeStates.get(nodeId);
    var statusText = state ? state.status : 'pending';
    var kindText = node.kind || node.type || 'unknown';
    var kindClass = kindText.toLowerCase();
    var displayName = node.name || node.nodeId || node.id || nodeId;
    var html = '<div class="detail-header">';
    html += '<span class="node-name">' + this._escapeHtml(displayName) + '</span>';
    html += '<span class="kind-badge ' + kindClass + '">' + this._escapeHtml(kindText) + '</span>';
    html += '<button class="dag-detail-close" id="dagDetailClose" title="Close">&#10005;</button>';
    html += '</div>';
    html += '<dl class="detail-grid">';
    html += '<dt>Status</dt><dd><span class="status-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + this._statusColor(statusText) + ';vertical-align:middle"></span>' + this._escapeHtml(statusText) + '</dd>';
    html += '<dt>Type</dt><dd>' + this._escapeHtml(kindText) + '</dd>';
    html += '<dt>Node ID</dt><dd title="' + this._escapeHtml(nodeId) + '">' + this._escapeHtml(nodeId) + '</dd>';
    if (state && state.startedAt) {
      html += '<dt>Started</dt><dd>' + new Date(state.startedAt).toLocaleString() + '</dd>';
    }
    if (state && state.endedAt) {
      html += '<dt>Ended</dt><dd>' + new Date(state.endedAt).toLocaleString() + '</dd>';
      html += '<dt>Duration</dt><dd>' + ((state.endedAt - state.startedAt) / 1000).toFixed(1) + 's</dd>';
    }
    if (state && state.errorCode) {
      html += '<dt>Error</dt><dd class="error-text">' + this._escapeHtml(state.errorCode) + '</dd>';
    }
    // Active error injections (F-ESIM)
    if (this._errorSim && this._errorSim.hasInjection(nodeId)) {
      var injRules = this._errorSim.rulesForNode(nodeId);
      var injHtml = '';
      for (var ri = 0; ri < injRules.length; ri++) {
        var ir = injRules[ri];
        injHtml += '<div class="dag-injection-chip" title="' + this._escapeHtml(ir.description || '') + '">' +
          '<span class="dag-injection-bolt">\u26A1</span>' +
          '<span class="dag-injection-code">' + this._escapeHtml(ir.errorCode) + '</span>' +
          '<span class="dag-injection-phase">' + this._escapeHtml(ir.phase || '') + '</span>' +
          '</div>';
      }
      html += '<dt>Injection</dt><dd>' + injHtml + '</dd>';
    }
    html += '</dl>';
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
    this._nodeDetail.innerHTML = html;
    if (this._detailSection) this._detailSection.style.display = '';
    // Close button
    var closeBtn = document.getElementById('dagDetailClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        if (self._detailSection) self._detailSection.style.display = 'none';
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
      if ((this._dag.nodes[i].nodeId || this._dag.nodes[i].id) === nodeId) {
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

  _statusColor(status) {
    if (status === 'completed') return 'var(--status-succeeded)';
    if (status === 'failed') return 'var(--status-failed)';
    if (status === 'running') return 'var(--accent)';
    if (status === 'cancelled' || status === 'cancelling') return 'var(--status-cancelled)';
    return 'var(--status-pending)';
  }

  _updateSummary() {
    var total = this._esm.nodeStates.size;
    var ok = 0;
    var fail = 0;
    var run = 0;
    for (var entry of this._esm.nodeStates) {
      var state = entry[1];
      if (state.status === 'completed') ok += 1;
      if (state.status === 'failed') fail += 1;
      if (state.status === 'running') run += 1;
    }
    if (this._sumTotal) this._sumTotal.textContent = String(total);
    if (this._sumOk) this._sumOk.textContent = String(ok);
    if (this._sumFail) this._sumFail.textContent = String(fail);
    if (this._sumRun) this._sumRun.textContent = String(run);
    if (this._ganttCount) this._ganttCount.textContent = total ? String(total) : '';

    var durationText = '--';
    if (this._esm.startedAt && this._esm.endedAt) {
      durationText = ((this._esm.endedAt - this._esm.startedAt) / 1000).toFixed(1) + 's';
    } else if (this._esm.status === 'running' && this._esm.startedAt) {
      durationText = ((Date.now() - this._esm.startedAt) / 1000).toFixed(1) + 's';
    }
    if (this._sumDur) this._sumDur.textContent = durationText;
  }

  /** Escape HTML entities for safe insertion. */
  _escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }
}
