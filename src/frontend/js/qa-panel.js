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
    this._llmPill = document.getElementById('qaLlmPill');
    this._llmPillLabel = document.getElementById('qaLlmPillLabel');

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

    // LLM readiness pill — click to refresh the capability state.
    // Useful when the probe was mid-flight at first connect.
    if (this._llmPill) {
      this._llmPill.addEventListener('click', () => this._loadCapabilities(true));
    }

    // Subscribe to QA server events via topic bus.
    //
    // The topic stream lifetime is INTENTIONALLY tied to init/destroy
    // and NOT to activate/deactivate. The server's `SubscribeToTopic`
    // (EdogPlaygroundHub.cs:410) yields the topic-buffer snapshot as
    // Phase 1 of every new subscription — so toggling subscribe on
    // each tab activate would replay every QaScenarioGenerated event
    // from the most-recent run, doubling (or more) the scenario list
    // each time the user switches tabs. The handler is cheap to leave
    // attached: it just routes events to sub-modules which already
    // ignore-or-accumulate based on their own state.
    this._ws.on('qa', this._qaEventHandler);
    this._ws.subscribeTopic('qa');

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
    // NOTE: do NOT re-subscribe the 'qa' topic here. Re-subscribing
    // would cause the server's `SubscribeToTopic` to replay the
    // entire qa ring buffer (2000 events) as its snapshot phase
    // before going live, which would duplicate every scenario card
    // on the curation page. The subscription is established once in
    // `init()` and torn down in `destroy()`.
    this._updatePhaseGate();
  }

  deactivate() {
    this._isActive = false;
    document.removeEventListener('keydown', this._keyHandler);
    // NOTE: do NOT unsubscribe the 'qa' topic here. See `activate()`.
  }

  setPhase(phase) {
    this._phase = phase;
    this._updatePhaseGate();
    if (phase === 'connected') {
      // Probe state may take a few seconds to settle on cold start.
      // Load once now, then poll-refresh after 3s if still 'unknown'.
      this._loadCapabilities(false);
    } else {
      this._renderLlmPill(null);
    }
  }

  // ── LLM V2 readiness pill ──
  //
  // QaGetCapabilities is wired in the hub (EdogPlaygroundHub.cs) and
  // returns the QaCapabilityReport that the registry builds from the
  // probe's last DualProbeResult. The pill is purely informational —
  // QA analysis runs regardless of state, but a green pill confirms
  // that scenarios will use the Architect + Editor pipeline rather
  // than the legacy single-prompt fallback.

  _loadCapabilities(isManualRefresh) {
    if (!this._llmPill || !this._ws || !this._ws.connection) return;
    const conn = this._ws.connection;
    if (!conn || conn.state !== 'Connected') {
      this._renderLlmPill(null);
      return;
    }
    if (isManualRefresh) {
      this._renderLlmPill({ state: 'refreshing' });
    }
    conn.invoke('QaGetCapabilities').then((report) => {
      console.log('[QA-DIAG] QaGetCapabilities result:', JSON.stringify(report));
      this._renderLlmPill(report);
      // If the probe was mid-flight, poll once more after 4s. The
      // dual probe normally takes < 2s on a healthy tenant.
      if (
        report &&
        !report.llmV2ProbedAt &&
        !this._llmPillRetryScheduled
      ) {
        this._llmPillRetryScheduled = true;
        setTimeout(() => {
          this._llmPillRetryScheduled = false;
          this._loadCapabilities(false);
        }, 4000);
      }
    }).catch((err) => {
      console.warn('[qa-panel] QaGetCapabilities failed:', err);
      this._renderLlmPill({ state: 'error', error: String(err && err.message || err) });
    });
  }

  _renderLlmPill(report) {
    if (!this._llmPill || !this._llmPillLabel) return;
    if (!report) {
      this._llmPill.style.display = 'none';
      return;
    }
    this._llmPill.style.display = '';
    this._llmPill.classList.remove(
      'qa-llm-pill-ready',
      'qa-llm-pill-legacy',
      'qa-llm-pill-error',
      'qa-llm-pill-unknown'
    );

    if (report.state === 'refreshing') {
      this._llmPill.classList.add('qa-llm-pill-unknown');
      this._llmPillLabel.textContent = 'LLM: refreshing…';
      this._llmPill.title = 'Refreshing capability probe…';
      return;
    }
    if (report.state === 'error') {
      this._llmPill.classList.add('qa-llm-pill-error');
      this._llmPillLabel.textContent = 'LLM: hub error';
      this._llmPill.title = report.error || 'Capability hub call failed.';
      return;
    }
    if (!report.llmV2ProbedAt) {
      this._llmPill.classList.add('qa-llm-pill-unknown');
      this._llmPillLabel.textContent = 'LLM: probing…';
      this._llmPill.title = report.llmV2Reason || 'Capability probe still in flight.';
      return;
    }
    if (report.llmV2Ready) {
      this._llmPill.classList.add('qa-llm-pill-ready');
      this._llmPillLabel.textContent = 'LLM V2: ready';
      this._llmPill.title = report.llmV2Reason || 'Architect + Editor probes passed.';
    } else {
      // Legacy-fallback path (Auto mode + probe failed) is the most
      // common case; show orange so users know they're on the
      // degraded pipeline.
      const mode = (report.llmV2RequestedMode || '').toLowerCase();
      const legacyPath = mode === 'auto' || mode === 'off' || mode === 'shadow';
      if (legacyPath) {
        this._llmPill.classList.add('qa-llm-pill-legacy');
        this._llmPillLabel.textContent = 'LLM: legacy fallback';
      } else {
        this._llmPill.classList.add('qa-llm-pill-error');
        this._llmPillLabel.textContent = 'LLM: not ready';
      }
      this._llmPill.title = report.llmV2Reason || 'V2 probe failed — see studio logs.';
    }
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
    console.log('[QA-DIAG] Stage transition:', this._activeStage, '→', stage);
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
    console.log('[QA-DIAG] ← event:', type, d);

    // Ignore stale events from a different correlation/run
    const evtCorr = d.correlationId || d.CorrelationId;
    if (evtCorr && this._correlationId && evtCorr !== this._correlationId) return;

    switch (type) {
      // Analysis events -> qa-analysis.js
      case 'QaAnalysisProgress':
        console.log('[QA-DIAG] Progress:', d.phase, d.phaseIndex + '/' + d.totalPhases, d.percentComplete + '%', d.detail || '');
        if (this._analysis) this._analysis.onProgress(d);
        break;
      case 'QaAnalysisWarning':
        console.log('[QA-DIAG] Warning:', d.warning, d.message);
        if (this._analysis) this._analysis.onWarning(d);
        break;
      case 'QaAnalysisCancelled':
        console.log('[QA-DIAG] Cancelled:', d.reason);
        if (this._analysis) this._analysis.onCancelled(d);
        break;
      case 'QaScenarioGenerated':
        console.log('[QA-DIAG] Scenario:', d.title || d.Title, 'type=' + (d.stimulusType || d.StimulusType));
        if (this._analysis) this._analysis.onScenarioGenerated(d);
        break;
      case 'QaLintFindings':
        console.log('[QA-DIAG] LintFindings:', (d.findings || d.Findings || []).length, 'findings');
        if (this._analysis) this._analysis.onLintFindings(d);
        break;

      // Execution events -> qa-execution.js
      case 'QaRunStarted':
        console.log('[QA-DIAG] RunStarted:', d.runId, 'scenarios=' + (d.totalScenarios || d.TotalScenarios));
        if (this._execution) this._execution.onRunStarted(d);
        break;
      case 'QaScenarioStarted':
        console.log('[QA-DIAG] ScenarioStarted:', d.scenarioId, d.title || d.Title);
        if (this._execution) this._execution.onScenarioStarted(d);
        break;
      case 'QaScenarioPhaseChanged':
        console.log('[QA-DIAG] PhaseChanged:', d.scenarioId, d.phase || d.Phase);
        if (this._execution) this._execution.onPhaseChanged(d);
        break;
      case 'QaExpectationMatched':
        console.log('[QA-DIAG] ExpectationMatched:', d.scenarioId, d.expectationIndex, 'passed=' + d.passed);
        if (this._execution) this._execution.onExpectationMatched(d);
        break;
      case 'QaScenarioCompleted':
        console.log('[QA-DIAG] ScenarioCompleted:', d.scenarioId, 'verdict=' + (d.verdict || d.Verdict));
        if (this._execution) this._execution.onScenarioCompleted(d);
        break;
      case 'QaRunCompleted':
        console.log('[QA-DIAG] *** RunCompleted:', d.runId, 'passed=' + d.passedCount, 'failed=' + d.failedCount);
        if (this._execution) this._execution.onRunCompleted(d);
        this._setStage('results');
        if (this._results) this._results.loadRun(d.runId || this._runId);
        break;

      // Error events
      case 'QaError':
        console.log('[QA-DIAG] ERROR:', d.errorCode || d.ErrorCode, d.message || d.Message);
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

  /**
   * Begin a fresh analysis: mint a new correlation ID, clear residual
   * analysisId/runId, and reset the analysis stage so its `_scenarios`
   * buffer + DOM scenario-list don't accumulate across runs in the same
   * session. Must be called by every caller that triggers a new
   * `QaStartCodeAnalysis` invocation (qa-input.js and the "New PR"
   * button in qa-results.js). Without this, a second analysis appends
   * its scenarios on top of the previous run's, causing the curation
   * stage to render every scenario twice (8 + 8 = 16).
   */
  startNewAnalysis() {
    this._newCorrelationId();
    this._analysisId = null;
    this._runId = null;
    if (this._analysis) this._analysis.reset();
    this._saveState();
    return this._correlationId;
  }

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
