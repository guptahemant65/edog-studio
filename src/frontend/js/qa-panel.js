/**
 * QA Testing Panel — Stage-based workflow orchestrator.
 *
 * Manages 5-stage pipeline: PR Input -> Analysis -> Curation -> Execution -> Results.
 * Connected-mode only. Subscribes to 'qa' SignalR topic for server events.
 *
 * Public API:
 *   constructor(ws)       — takes SignalRManager instance
 *   init()                — one-time DOM setup, event binding
 *   activate()            — called when view becomes visible
 *   deactivate()          — called when view is hidden
 *   setPhase(phase)       — 'disconnected' | 'connected'
 *   destroy()             — cleanup all listeners
 */
class QaPanel {
  constructor(ws) {
    this._ws = ws;
    this._phase = 'disconnected';
    this._activeStage = 'input';
    this._isActive = false;
    this._correlationId = null;
    this._analysisId = null;
    this._runId = null;

    // Sub-module references (set after init via register*())
    this._input = null;
    this._analysis = null;
    this._curation = null;
    this._execution = null;
    this._results = null;
    this._editor = null;

    // DOM references (cached in init())
    this._panel = null;
    this._stageBar = null;
    this._stageItems = null;
    this._stages = null;
    this._phaseOverlay = null;
    this._killSwitch = null;
    this._killBtn = null;
    this._editorOverlay = null;

    // Bound handlers for cleanup
    this._keyHandler = (e) => this._handleKeyDown(e);
    this._qaEventHandler = (event) => this._handleQaEvent(event);
  }

  // ── One-time Setup ──

  init() {
    this._panel = document.getElementById('qaPanel');
    this._stageBar = document.getElementById('qaStageBar');
    this._stageItems = this._stageBar
      ? Array.from(this._stageBar.querySelectorAll('.qa-stage-item'))
      : [];
    this._stages = {
      input: document.getElementById('qaStageInput'),
      analysis: document.getElementById('qaStageAnalysis'),
      curation: document.getElementById('qaStageCuration'),
      execution: document.getElementById('qaStageExecution'),
      results: document.getElementById('qaStageResults')
    };
    this._phaseOverlay = document.getElementById('qaPhase1Overlay');
    this._killSwitch = document.getElementById('qaKillSwitch');
    this._killBtn = document.getElementById('qaKillBtn');
    this._editorOverlay = document.getElementById('qaEditorOverlay');

    // Stage bar: click completed stages to navigate back
    if (this._stageBar) {
      this._stageBar.addEventListener('click', (e) => {
        const item = e.target.closest('.qa-stage-item');
        if (item && item.classList.contains('completed')) {
          this._navigateToStage(item.dataset.stage);
        }
      });
    }

    // Kill switch
    if (this._killBtn) {
      this._killBtn.addEventListener('click', () => this._handleKillSwitch());
    }

    // Subscribe to QA server events via topic bus
    this._ws.on('qa', this._qaEventHandler);

    // Restore crash-recovery state
    this._restoreState();

    // Apply phase gate
    this._updatePhaseGate();

    // Initialize sub-modules
    new QaInput(this).init();
    new QaAnalysis(this).init();
    new QaCuration(this).init();
    new QaExecution(this).init();
    new QaResults(this).init();
    new QaEditor(this).init();
  }

  // ── Lifecycle ──

  activate() {
    this._isActive = true;
    document.addEventListener('keydown', this._keyHandler);
    this._ws.subscribeTopic('qa');
    this._updatePhaseGate();
  }

  deactivate() {
    this._isActive = false;
    document.removeEventListener('keydown', this._keyHandler);
    this._ws.unsubscribeTopic('qa');
  }

  setPhase(phase) {
    this._phase = phase;
    this._updatePhaseGate();
  }

  destroy() {
    document.removeEventListener('keydown', this._keyHandler);
    this._ws.off('qa', this._qaEventHandler);
    this._ws.unsubscribeTopic('qa');
  }

  // ── Stage Navigation ──

  _navigateToStage(stage) {
    const stageOrder = ['input', 'analysis', 'curation', 'execution', 'results'];
    const targetIdx = stageOrder.indexOf(stage);
    const currentIdx = stageOrder.indexOf(this._activeStage);
    if (targetIdx < 0 || targetIdx === currentIdx) return;

    // Can only go back to completed stages, not forward
    if (targetIdx > currentIdx) return;

    // Confirm if navigating back from a running execution (data loss)
    if (this._activeStage === 'execution' && this._isRunning()) {
      this._confirmBack(stage);
      return;
    }

    this._setStage(stage);
  }

  _setStage(stage) {
    this._activeStage = stage;

    const stageOrder = ['input', 'analysis', 'curation', 'execution', 'results'];
    const activeIdx = stageOrder.indexOf(stage);

    // Update stage bar indicators
    this._stageItems.forEach((item, i) => {
      item.classList.remove('active', 'completed', 'disabled');
      if (i < activeIdx) {
        item.classList.add('completed');
        item.style.cursor = 'pointer';
      } else if (i === activeIdx) {
        item.classList.add('active');
        item.style.cursor = 'default';
      } else {
        item.classList.add('disabled');
        item.style.cursor = 'default';
      }
    });

    // Show only the active stage container
    const stageKeys = Object.keys(this._stages);
    for (let i = 0; i < stageKeys.length; i++) {
      const el = this._stages[stageKeys[i]];
      if (el) {
        if (stageKeys[i] === stage) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    }

    // Kill switch visible only during execution
    if (this._killSwitch) {
      this._killSwitch.style.display = (stage === 'execution') ? '' : 'none';
    }

    this._saveState();
  }

  // ── Correlation ID ──

  _newCorrelationId() {
    this._correlationId = 'corr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return this._correlationId;
  }

  // ── Phase Gate ──

  _updatePhaseGate() {
    if (!this._phaseOverlay) return;
    const stagesEl = document.getElementById('qaStages');

    if (this._phase !== 'connected') {
      this._phaseOverlay.style.display = '';
      if (stagesEl) stagesEl.style.display = 'none';
      if (this._stageBar) this._stageBar.style.pointerEvents = 'none';
    } else {
      this._phaseOverlay.style.display = 'none';
      if (stagesEl) stagesEl.style.display = '';
      if (this._stageBar) this._stageBar.style.pointerEvents = '';
    }
  }

  // ── Kill Switch ──

  _handleKillSwitch() {
    if (!this._runId || !this._isRunning()) return;

    const corrId = this._newCorrelationId();
    this._ws.connection.invoke('QaCancelRun', corrId, this._runId).then((result) => {
      if (result && result.success) {
        if (window.edogToast) window.edogToast('Run cancelled', 'warning');
      }
    }).catch((err) => {
      console.error('[QA] Kill failed:', err);
      if (window.edogToast) window.edogToast('Failed to cancel run', 'error');
    });
  }

  _isRunning() {
    return this._execution && this._execution._isRunning;
  }

  // ── Confirm Back Dialog ──

  _confirmBack(targetStage) {
    if (confirm('Going back will cancel the current execution. Continue?')) {
      this._handleKillSwitch();
      this._setStage(targetStage);
    }
  }

  // ── Server Event Router ──

  _handleQaEvent(event) {
    if (!event || !event.data) return;
    const d = event.data;
    const type = d.eventType || d.EventType;

    // Ignore stale events from a different correlation/run
    const evtCorr = d.correlationId || d.CorrelationId;
    if (evtCorr && this._correlationId && evtCorr !== this._correlationId) return;

    switch (type) {
      // Analysis events -> qa-analysis.js
      case 'QaAnalysisProgress':
        if (this._analysis) this._analysis.onProgress(d);
        break;
      case 'QaAnalysisWarning':
        if (this._analysis) this._analysis.onWarning(d);
        break;
      case 'QaAnalysisCancelled':
        if (this._analysis) this._analysis.onCancelled(d);
        break;
      case 'QaScenarioGenerated':
        if (this._analysis) this._analysis.onScenarioGenerated(d);
        break;
      case 'QaLintFindings':
        if (this._analysis) this._analysis.onLintFindings(d);
        break;

      // Execution events -> qa-execution.js
      case 'QaRunStarted':
        if (this._execution) this._execution.onRunStarted(d);
        break;
      case 'QaScenarioStarted':
        if (this._execution) this._execution.onScenarioStarted(d);
        break;
      case 'QaScenarioPhaseChanged':
        if (this._execution) this._execution.onPhaseChanged(d);
        break;
      case 'QaExpectationMatched':
        if (this._execution) this._execution.onExpectationMatched(d);
        break;
      case 'QaScenarioCompleted':
        if (this._execution) this._execution.onScenarioCompleted(d);
        break;
      case 'QaRunCompleted':
        if (this._execution) this._execution.onRunCompleted(d);
        this._setStage('results');
        if (this._results) this._results.loadRun(d.runId || this._runId);
        break;

      // Error events
      case 'QaError':
        this._handleError(d);
        break;
    }
  }

  // ── Error Handling ──

  _handleError(data) {
    const msg = (data && data.message) || 'Unknown QA error';
    const code = (data && (data.errorCode || data.ErrorCode)) || '';
    console.error('[QA] Server error:', code, msg);

    // F27 P4 — analysis-phase errors (LLM transport, parse, or empty
    // scenario set) are routed to the analysis component's inline panel
    // so the failure is persistent, actionable, and tied to the failed
    // phase tracker — instead of a fire-and-forget toast.
    const isAnalysisError =
      code === 'NO_SCENARIOS_GENERATED' ||
      (typeof code === 'string' && code.indexOf('LLM_PROVIDER_') === 0);

    if (isAnalysisError && this._analysis && typeof this._analysis.onAnalysisPhaseError === 'function') {
      this._analysis.onAnalysisPhaseError(data);
      this._setStage('analysis');
      return;
    }

    if (window.edogToast) window.edogToast(msg, 'error');
  }

  // ── Keyboard Shortcuts ──

  _handleKeyDown(e) {
    if (!this._isActive) return;

    // Escape closes editor overlay if open
    if (e.key === 'Escape' && this._editorOverlay && this._editorOverlay.classList.contains('open')) {
      if (this._editor) this._editor.close();
      e.preventDefault();
    }
  }

  // ── State Persistence (localStorage) ──

  _saveState() {
    try {
      const state = {
        activeStage: this._activeStage,
        analysisId: this._analysisId,
        runId: this._runId,
        timestamp: Date.now()
      };
      localStorage.setItem('edog-qa-panel-state', JSON.stringify(state));
    } catch { /* quota exceeded */ }
  }

  _restoreState() {
    try {
      const raw = localStorage.getItem('edog-qa-panel-state');
      if (!raw) return;

      const state = JSON.parse(raw);

      // Discard state older than 1 hour
      if (Date.now() - state.timestamp > 3600000) {
        localStorage.removeItem('edog-qa-panel-state');
        return;
      }

      if (state.analysisId) this._analysisId = state.analysisId;
      if (state.runId) this._runId = state.runId;
      if (state.activeStage) this._setStage(state.activeStage);
    } catch { /* corrupt state */ }
  }

  // ── Sub-Module Registration ──

  registerInput(mod) { this._input = mod; }
  registerAnalysis(mod) { this._analysis = mod; }
  registerCuration(mod) { this._curation = mod; }
  registerExecution(mod) { this._execution = mod; }
  registerResults(mod) { this._results = mod; }
  registerEditor(mod) { this._editor = mod; }

  // ── Public API for Sub-Modules ──

  /** Navigate to a stage (used by sub-modules to advance the pipeline). */
  goToStage(stage) { this._setStage(stage); }

  /** Get current correlation ID or create a new one. */
  getCorrelationId() { return this._correlationId || this._newCorrelationId(); }

  /** Set/get the analysis ID (set by qa-input.js after starting analysis). */
  setAnalysisId(id) { this._analysisId = id; this._saveState(); }
  getAnalysisId() { return this._analysisId; }

  /** Set/get the run ID (set by qa-curation.js after submitting scenarios). */
  setRunId(id) { this._runId = id; this._saveState(); }
  getRunId() { return this._runId; }

  // F27 P6 — qa-input.js captures the PR URL when the user kicks off an
  // analysis; the results stage reads it back when "Post to PR" fires so
  // the dev-server can route the comment to the right repo + PR id. We
  // intentionally keep this client-side because the hub's QaRunResult
  // doesn't persist PrUrl on the analysis path today.
  setPrUrl(url) { this._prUrl = url || null; }
  getPrUrl() { return this._prUrl || null; }

  /** Get the SignalR connection for hub invocations. */
  getConnection() { return this._ws.connection; }

  /** Open the scenario editor overlay. */
  openEditor(scenario) {
    if (this._editor) this._editor.open(scenario);
  }

  /** Close the scenario editor overlay. */
  closeEditor() {
    if (this._editor) this._editor.close();
  }
}
