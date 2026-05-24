/**
 * QA Execution Stage — Real-time scenario execution display.
 *
 * Owns qaExecutionContainer. Renders scenarios as a vertical list with
 * expandable detail for the active scenario. Phase progress, expectation
 * matches, and verdicts update in real-time via SignalR events.
 */
class QaExecution {
  constructor(panel) {
    this._panel = panel;
    this._container = null;
    this._scenarios = [];       // scenario definitions
    this._scenarioEls = {};     // id -> DOM element
    this._activeScenarioId = null;
    this._isRunning = false;    // used by QaPanel for kill switch
    this._runStartedAt = null;
    this._timerInterval = null;
    this._headerEl = null;
  }

  init() {
    this._container = document.getElementById('qaExecutionContainer');
    this._panel.registerExecution(this);
  }

  /** Called by QaCuration when submitting scenarios */
  startTracking(scenarios) {
    this._scenarios = scenarios.slice();
    this._isRunning = true;
    this._activeScenarioId = null;
    this._runStartedAt = Date.now();
    this._render();
    this._startTimer();
  }

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';
    this._scenarioEls = {};

    // ── Header with progress ──
    this._headerEl = document.createElement('div');
    this._headerEl.className = 'qa-exec-header';

    var titleEl = document.createElement('h3');
    titleEl.textContent = 'Executing ' + this._scenarios.length + ' scenarios';
    this._headerEl.appendChild(titleEl);

    var progressEl = document.createElement('div');
    progressEl.className = 'qa-exec-progress';

    var barOuter = document.createElement('div');
    barOuter.className = 'qa-progress-bar';
    var barInner = document.createElement('div');
    barInner.className = 'qa-progress-bar-fill';
    barInner.id = 'qaExecProgressFill';
    barInner.style.width = '0%';
    barOuter.appendChild(barInner);
    progressEl.appendChild(barOuter);

    var statsEl = document.createElement('span');
    statsEl.className = 'qa-exec-stats';
    statsEl.id = 'qaExecStats';
    statsEl.textContent = '0 / ' + this._scenarios.length;
    progressEl.appendChild(statsEl);

    var timerEl = document.createElement('span');
    timerEl.className = 'qa-exec-timer';
    timerEl.id = 'qaExecTimer';
    timerEl.textContent = '0:00';
    progressEl.appendChild(timerEl);

    this._headerEl.appendChild(progressEl);
    this._container.appendChild(this._headerEl);

    // ── Scenario list ──
    var list = document.createElement('div');
    list.className = 'qa-exec-list';
    list.id = 'qaExecList';

    for (var i = 0; i < this._scenarios.length; i++) {
      var scn = this._scenarios[i];
      var row = this._createScenarioRow(scn, i);
      list.appendChild(row);
      this._scenarioEls[scn.id] = row;
    }

    this._container.appendChild(list);
  }

  _createScenarioRow(scn, index) {
    var row = document.createElement('div');
    row.className = 'qa-exec-row pending';
    row.dataset.scenarioId = scn.id;

    // ── Index + Status icon ──
    var statusEl = document.createElement('span');
    statusEl.className = 'qa-exec-status';
    statusEl.textContent = (index + 1) + '.';
    row.appendChild(statusEl);

    // ── Title ──
    var titleEl = document.createElement('span');
    titleEl.className = 'qa-exec-title';
    titleEl.textContent = scn.title;
    row.appendChild(titleEl);

    // ── Phase indicator ──
    var phaseEl = document.createElement('span');
    phaseEl.className = 'qa-exec-phase';
    phaseEl.dataset.field = 'phase';
    row.appendChild(phaseEl);

    // ── Verdict badge ──
    var verdictEl = document.createElement('span');
    verdictEl.className = 'qa-verdict';
    verdictEl.dataset.field = 'verdict';
    row.appendChild(verdictEl);

    // ── Expandable detail (expectations) ──
    var detail = document.createElement('div');
    detail.className = 'qa-exec-detail';
    detail.dataset.field = 'detail';
    detail.style.display = 'none';

    // Pre-render expectation rows
    if (scn.expectations) {
      for (var j = 0; j < scn.expectations.length; j++) {
        var exp = scn.expectations[j];
        var expRow = document.createElement('div');
        expRow.className = 'qa-exec-exp pending';
        expRow.dataset.expId = exp.id;

        var expIcon = document.createElement('span');
        expIcon.className = 'qa-exec-exp-icon';
        expIcon.textContent = '\u25CB'; // ○

        var expDesc = document.createElement('span');
        expDesc.className = 'qa-exec-exp-desc';
        expDesc.textContent = exp.description || exp.id;

        expRow.appendChild(expIcon);
        expRow.appendChild(expDesc);
        detail.appendChild(expRow);
      }
    }

    row.appendChild(detail);
    return row;
  }

  // ── Event Handlers ──

  onRunStarted(data) {
    console.log('[QA-DIAG] Execution.onRunStarted:', data);
    this._isRunning = true;
    this._runStartedAt = Date.now();
  }

  onScenarioStarted(data) {
    console.log('[QA-DIAG] Execution.onScenarioStarted:', data.scenarioId, data.title);
    this._activeScenarioId = data.scenarioId;
    var row = this._scenarioEls[data.scenarioId];
    if (!row) return;

    row.classList.remove('pending');
    row.classList.add('running');

    // Show detail
    var detail = row.querySelector('[data-field="detail"]');
    if (detail) detail.style.display = '';

    // Set phase
    var phaseEl = row.querySelector('[data-field="phase"]');
    if (phaseEl) phaseEl.textContent = data.phase || 'isolate';

    // Scroll into view
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  onPhaseChanged(data) {
    console.log('[QA-DIAG] Execution.onPhaseChanged:', data.scenarioId, data.phase);
    var row = this._scenarioEls[data.scenarioId];
    if (!row) return;
    var phaseEl = row.querySelector('[data-field="phase"]');
    if (phaseEl) phaseEl.textContent = data.phase || '';
  }

  onExpectationMatched(data) {
    console.log('[QA-DIAG] Execution.onExpectationMatched:', data.scenarioId, data.expectationId, 'status=' + data.status);
    var row = this._scenarioEls[data.scenarioId];
    if (!row) return;
    var expRow = row.querySelector('[data-exp-id="' + data.expectationId + '"]');
    if (!expRow) return;

    var icon = expRow.querySelector('.qa-exec-exp-icon');
    expRow.classList.remove('pending');

    if (data.status === 'passed') {
      expRow.classList.add('passed');
      if (icon) icon.textContent = '\u25CF'; // ●
    } else if (data.status === 'failed') {
      expRow.classList.add('failed');
      if (icon) icon.textContent = '\u2715'; // ✕
    } else if (data.status === 'timeout') {
      expRow.classList.add('timeout');
      if (icon) icon.textContent = '\u25D4'; // ◔
    }
  }

  onScenarioCompleted(data) {
    console.log('[QA-DIAG] Execution.onScenarioCompleted:', data.scenarioId,
      'verdict=' + (data.result && data.result.verdict),
      'error=' + (data.result && data.result.errorMessage),
      'failedAtPhase=' + (data.result && data.result.failedAtPhase));
    var row = this._scenarioEls[data.scenarioId];
    if (!row) return;

    row.classList.remove('running');
    row.classList.add('completed');

    // Collapse detail
    var detail = row.querySelector('[data-field="detail"]');
    if (detail) detail.style.display = 'none';

    // Set verdict
    var verdictEl = row.querySelector('[data-field="verdict"]');
    if (verdictEl) {
      var verdict = data.verdict || data.overallVerdict || 'unknown';
      verdictEl.textContent = verdict;
      verdictEl.className = 'qa-verdict ' + verdict.toLowerCase();
    }

    // Clear phase
    var phaseEl = row.querySelector('[data-field="phase"]');
    if (phaseEl) phaseEl.textContent = '';

    // Update progress
    this._updateProgress();
  }

  onRunCompleted(data) {
    console.log('[QA-DIAG] Execution.onRunCompleted:', data.runId,
      'passed=' + data.passedCount, 'failed=' + data.failedCount,
      'cancelled=' + data.cancelledByUser);
    this._isRunning = false;
    this._stopTimer();

    // Update header
    if (this._headerEl) {
      var title = this._headerEl.querySelector('h3');
      if (title) title.textContent = 'Execution Complete';
    }

    // Show "View Results" button
    if (this._container) {
      var self = this;
      var footer = document.createElement('div');
      footer.className = 'qa-exec-footer';
      var btn = document.createElement('button');
      btn.className = 'qa-btn primary';
      btn.textContent = 'View Results \u25B8';
      btn.addEventListener('click', function () {
        self._panel.goToStage('results');
        if (self._panel._results) {
          self._panel._results.loadRun(self._panel.getRunId());
        }
      });
      footer.appendChild(btn);
      this._container.appendChild(footer);
    }
  }

  // ── Progress ──

  _updateProgress() {
    var completed = 0;
    var els = this._container ? this._container.querySelectorAll('.qa-exec-row.completed') : [];
    completed = els.length;

    var fill = document.getElementById('qaExecProgressFill');
    if (fill) fill.style.width = Math.round((completed / this._scenarios.length) * 100) + '%';

    var stats = document.getElementById('qaExecStats');
    if (stats) stats.textContent = completed + ' / ' + this._scenarios.length;
  }

  // ── Timer ──

  _startTimer() {
    this._stopTimer();
    var self = this;
    this._timerInterval = setInterval(function () {
      var elapsed = Date.now() - self._runStartedAt;
      var secs = Math.floor(elapsed / 1000);
      var mins = Math.floor(secs / 60);
      secs = secs % 60;
      var el = document.getElementById('qaExecTimer');
      if (el) el.textContent = mins + ':' + (secs < 10 ? '0' : '') + secs;
    }, 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  /** Reset for a new run */
  reset() {
    this._isRunning = false;
    this._stopTimer();
    this._scenarios = [];
    this._scenarioEls = {};
    this._activeScenarioId = null;
    if (this._container) this._container.innerHTML = '';
  }
}
