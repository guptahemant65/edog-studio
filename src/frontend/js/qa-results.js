/**
 * QA Results Stage — Run results display with summary and detail cards.
 *
 * Owns qaResultsContainer. Loads run results from QaGetRunDetail.
 * Shows overall summary, per-scenario verdicts, expectation outcomes.
 */
class QaResults {
  constructor(panel) {
    this._panel = panel;
    this._container = null;
    this._runResult = null;
    this._history = [];
  }

  init() {
    this._container = document.getElementById('qaResultsContainer');
    this._panel.registerResults(this);
  }

  /** Load results for a specific run */
  loadRun(runId) {
    if (!runId || !this._container) return;

    this._container.innerHTML = '';
    this._showLoading();

    var conn = this._panel.getConnection();
    if (!conn) {
      this._showError('Not connected');
      return;
    }

    var corrId = this._panel.getCorrelationId();
    conn.invoke('QaGetRunDetail', corrId, runId).then(result => {
      this._runResult = result;
      this._render();
    }).catch(err => {
      this._showError('Failed to load results: ' + (err.message || err));
    });
  }

  _showLoading() {
    if (!this._container) return;
    var el = document.createElement('div');
    el.className = 'qa-empty-state';
    el.textContent = 'Loading results\u2026';
    this._container.appendChild(el);
  }

  _showError(msg) {
    if (!this._container) return;
    this._container.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'qa-empty-state';
    el.textContent = msg;
    this._container.appendChild(el);
  }

  _render() {
    if (!this._container || !this._runResult) return;
    this._container.innerHTML = '';

    var run = this._runResult;

    // ── Summary Card ──
    var summary = document.createElement('div');
    summary.className = 'qa-results-summary';

    var overallEl = document.createElement('div');
    overallEl.className = 'qa-results-overall ' + (run.overallPass ? 'passed' : 'failed');
    overallEl.textContent = run.overallPass ? 'ALL PASSED' : 'FAILURES DETECTED';
    summary.appendChild(overallEl);

    // Verdict counts
    var countsEl = document.createElement('div');
    countsEl.className = 'qa-results-counts';
    var s = run.summary || {};
    var countItems = [
      { label: 'Passed', value: s.passed || 0, cls: 'passed' },
      { label: 'Failed', value: s.failed || 0, cls: 'failed' },
      { label: 'Timeout', value: s.timedOut || 0, cls: 'timeout' },
      { label: 'Skipped', value: s.skipped || 0, cls: 'skipped' }
    ];
    for (var i = 0; i < countItems.length; i++) {
      var ci = countItems[i];
      var countEl = document.createElement('div');
      countEl.className = 'qa-results-count ' + ci.cls;
      var numEl = document.createElement('span');
      numEl.className = 'qa-results-count-num';
      numEl.textContent = ci.value;
      var lblEl = document.createElement('span');
      lblEl.className = 'qa-results-count-label';
      lblEl.textContent = ci.label;
      countEl.appendChild(numEl);
      countEl.appendChild(lblEl);
      countsEl.appendChild(countEl);
    }
    summary.appendChild(countsEl);

    // Duration
    if (run.totalDurationMs) {
      var durEl = document.createElement('div');
      durEl.className = 'qa-results-duration';
      durEl.textContent = 'Duration: ' + (run.totalDurationMs / 1000).toFixed(1) + 's';
      summary.appendChild(durEl);
    }

    this._container.appendChild(summary);

    // ── Scenario Detail Cards ──
    var scenarios = run.scenarios || run.scenarioResults || [];
    if (scenarios.length) {
      var listHeader = document.createElement('h4');
      listHeader.className = 'qa-results-list-header';
      listHeader.textContent = 'Scenario Results (' + scenarios.length + ')';
      this._container.appendChild(listHeader);

      var list = document.createElement('div');
      list.className = 'qa-results-list';

      for (var j = 0; j < scenarios.length; j++) {
        list.appendChild(this._createResultCard(scenarios[j], j));
      }
      this._container.appendChild(list);
    }

    // ── Actions ──
    var actions = document.createElement('div');
    actions.className = 'qa-results-actions';

    var rerunBtn = document.createElement('button');
    rerunBtn.className = 'qa-btn';
    rerunBtn.textContent = '\u21BB Re-run';
    rerunBtn.addEventListener('click', () => {
      this._panel.goToStage('curation');
    });
    actions.appendChild(rerunBtn);

    var newPrBtn = document.createElement('button');
    newPrBtn.className = 'qa-btn primary';
    newPrBtn.textContent = 'New PR \u25B8';
    newPrBtn.addEventListener('click', () => {
      if (this._panel._input) this._panel._input.reset();
      this._panel.goToStage('input');
    });
    actions.appendChild(newPrBtn);

    this._container.appendChild(actions);
  }

  _createResultCard(scn, index) {
    var card = document.createElement('div');
    card.className = 'qa-card qa-result-card';
    card.tabIndex = 0;

    // ── Header row ──
    var header = document.createElement('div');
    header.className = 'qa-result-header';

    var numEl = document.createElement('span');
    numEl.className = 'qa-result-num';
    numEl.textContent = (index + 1) + '.';
    header.appendChild(numEl);

    var titleEl = document.createElement('span');
    titleEl.className = 'qa-result-title';
    titleEl.textContent = scn.title || scn.scenarioId || 'Scenario';
    header.appendChild(titleEl);

    var verdict = scn.verdict || scn.overallVerdict || 'unknown';
    var verdictEl = document.createElement('span');
    verdictEl.className = 'qa-verdict ' + verdict.toLowerCase();
    verdictEl.textContent = verdict.toUpperCase();
    header.appendChild(verdictEl);

    card.appendChild(header);

    // ── Expandable detail ──
    var detail = document.createElement('div');
    detail.className = 'qa-result-detail';
    detail.style.display = 'none';

    // Category + timing
    var metaEl = document.createElement('div');
    metaEl.className = 'qa-result-meta';
    if (scn.category) {
      var catBadge = document.createElement('span');
      catBadge.className = 'qa-category-badge qa-cat-' + scn.category.replace(/_/g, '-');
      catBadge.textContent = scn.category.replace(/_/g, ' ');
      metaEl.appendChild(catBadge);
    }
    if (scn.durationMs != null) {
      var timingEl = document.createElement('span');
      timingEl.className = 'qa-result-timing';
      timingEl.textContent = (scn.durationMs / 1000).toFixed(2) + 's';
      metaEl.appendChild(timingEl);
    }
    detail.appendChild(metaEl);

    // Expectations
    var expectations = scn.expectations || scn.expectationResults || [];
    if (expectations.length) {
      var expList = document.createElement('div');
      expList.className = 'qa-result-expectations';
      for (var k = 0; k < expectations.length; k++) {
        var exp = expectations[k];
        var expRow = document.createElement('div');
        expRow.className = 'qa-result-exp ' + (exp.status || 'unknown');

        var expIcon = document.createElement('span');
        expIcon.className = 'qa-result-exp-icon';
        if (exp.status === 'passed') expIcon.textContent = '\u25CF';
        else if (exp.status === 'failed') expIcon.textContent = '\u2715';
        else if (exp.status === 'timeout') expIcon.textContent = '\u25D4';
        else expIcon.textContent = '\u25CB';

        var expDesc = document.createElement('span');
        expDesc.className = 'qa-result-exp-desc';
        expDesc.textContent = exp.description || exp.id || exp.expectationId || '';

        expRow.appendChild(expIcon);
        expRow.appendChild(expDesc);
        expList.appendChild(expRow);
      }
      detail.appendChild(expList);
    }

    // Failure message
    if (scn.failureMessage) {
      var failEl = document.createElement('div');
      failEl.className = 'qa-result-failure';
      failEl.textContent = scn.failureMessage;
      detail.appendChild(failEl);
    }

    card.appendChild(detail);

    // ── Toggle expand ──
    header.addEventListener('click', function() {
      var isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : '';
      card.classList.toggle('expanded', !isOpen);
    });
    header.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    });

    return card;
  }

  /** Load run history */
  loadHistory() {
    var conn = this._panel.getConnection();
    if (!conn) return;
    var corrId = this._panel.getCorrelationId();
    conn.invoke('QaGetRunHistory', {
      correlationId: corrId,
      prId: null,
      limit: 20,
      offset: 0
    }).then(results => {
      this._history = results || [];
    }).catch(function() { /* ignore */ });
  }

  reset() {
    this._runResult = null;
    if (this._container) this._container.innerHTML = '';
  }
}
