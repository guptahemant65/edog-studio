/**
 * QA Curation Stage — Review, edit, approve/exclude AI-generated scenarios.
 *
 * Owns the qaCurationContainer DOM. Receives scenarios from QaAnalysis via
 * loadScenarios(). Submits curated set via QaSubmitCuratedScenarios SignalR call.
 */
class QaCuration {
  constructor(panel) {
    this._panel = panel;
    this._container = null;
    this._listEl = null;
    this._submitBtn = null;
    this._scenarios = [];       // full scenario objects
    this._approved = new Set(); // set of approved scenario IDs
    this._analysisId = null;
  }

  init() {
    this._container = document.getElementById('qaCurationContainer');
    this._panel.registerCuration(this);
  }

  /** Load scenarios from analysis stage. */
  loadScenarios(scenarios, analysisId) {
    this._scenarios = scenarios.slice();
    this._analysisId = analysisId;
    this._approved = new Set(this._scenarios.map(function (s) { return s.id; }));
    this._render();
  }

  // ── Render ──

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';

    // Header with stats
    var header = document.createElement('div');
    header.className = 'qa-curation-header';

    var title = document.createElement('h3');
    title.textContent = 'Review Scenarios';
    header.appendChild(title);

    var stats = document.createElement('div');
    stats.className = 'qa-curation-stats';
    stats.id = 'qaCurationStats';
    this._updateStats(stats);
    header.appendChild(stats);
    this._container.appendChild(header);

    // Bulk actions
    var bulkBar = document.createElement('div');
    bulkBar.className = 'qa-curation-bulk';

    var self = this;

    var selectAll = document.createElement('button');
    selectAll.className = 'qa-btn';
    selectAll.textContent = 'Select All';
    selectAll.addEventListener('click', function () {
      self._approved = new Set(self._scenarios.map(function (s) { return s.id; }));
      self._renderList();
      self._updateStats();
    });
    bulkBar.appendChild(selectAll);

    var deselectAll = document.createElement('button');
    deselectAll.className = 'qa-btn';
    deselectAll.textContent = 'Deselect All';
    deselectAll.addEventListener('click', function () {
      self._approved.clear();
      self._renderList();
      self._updateStats();
    });
    bulkBar.appendChild(deselectAll);

    this._container.appendChild(bulkBar);

    // Scenario list
    this._listEl = document.createElement('div');
    this._listEl.className = 'qa-curation-list';
    this._container.appendChild(this._listEl);
    this._renderList();

    // Footer with navigation + submit
    var footer = document.createElement('div');
    footer.className = 'qa-curation-footer';

    var backBtn = document.createElement('button');
    backBtn.className = 'qa-btn';
    backBtn.textContent = '\u25C2 Back';
    backBtn.addEventListener('click', function () { self._panel.goToStage('analysis'); });
    footer.appendChild(backBtn);

    this._submitBtn = document.createElement('button');
    this._submitBtn.className = 'qa-btn primary';
    this._submitBtn.textContent = 'Run Approved (' + this._approved.size + ') \u25B8';
    this._submitBtn.addEventListener('click', function () { self._submit(); });
    footer.appendChild(this._submitBtn);

    this._container.appendChild(footer);
  }

  _renderList() {
    if (!this._listEl) return;
    this._listEl.innerHTML = '';

    // Sort by priority (lower number = higher priority)
    var sorted = this._scenarios.slice().sort(function (a, b) {
      return (a.priority || 99) - (b.priority || 99);
    });

    for (var i = 0; i < sorted.length; i++) {
      this._listEl.appendChild(this._createScenarioCard(sorted[i]));
    }
  }

  _createScenarioCard(scn) {
    var self = this;
    var isApproved = this._approved.has(scn.id);

    var card = document.createElement('div');
    card.className = 'qa-card qa-curation-card';
    if (!isApproved) card.classList.add('excluded');
    card.dataset.scenarioId = scn.id;

    // Checkbox toggle
    var checkbox = document.createElement('div');
    checkbox.className = 'qa-curation-check';
    checkbox.tabIndex = 0;
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('aria-checked', isApproved ? 'true' : 'false');
    checkbox.textContent = isApproved ? '\u2611' : '\u2610';
    checkbox.addEventListener('click', function () { self._toggleScenario(scn.id); });
    checkbox.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        self._toggleScenario(scn.id);
      }
    });
    card.appendChild(checkbox);

    // Body
    var body = document.createElement('div');
    body.className = 'qa-curation-body';

    var titleRow = document.createElement('div');
    titleRow.className = 'qa-curation-title-row';

    var titleEl = document.createElement('div');
    titleEl.className = 'qa-curation-title';
    titleEl.textContent = scn.title;
    titleRow.appendChild(titleEl);

    var prioEl = document.createElement('span');
    prioEl.className = 'qa-priority-badge';
    prioEl.textContent = 'P' + (scn.priority || '?');
    titleRow.appendChild(prioEl);

    body.appendChild(titleRow);

    // Category + stimulus metadata
    var metaEl = document.createElement('div');
    metaEl.className = 'qa-curation-meta';

    var catBadge = document.createElement('span');
    var catKey = (scn.category || 'unknown').replace(/_/g, '-');
    catBadge.className = 'qa-category-badge qa-cat-' + catKey;
    catBadge.textContent = (scn.category || 'unknown').replace(/_/g, ' ');
    metaEl.appendChild(catBadge);

    if (scn.stimulus && scn.stimulus.type) {
      var stimEl = document.createElement('span');
      stimEl.className = 'qa-stimulus-badge';
      stimEl.textContent = scn.stimulus.type.replace(/_/g, ' ');
      metaEl.appendChild(stimEl);
    }

    var expCount = document.createElement('span');
    expCount.className = 'qa-exp-count';
    var n = scn.expectations ? scn.expectations.length : 0;
    expCount.textContent = n + ' expectation' + (n !== 1 ? 's' : '');
    metaEl.appendChild(expCount);

    body.appendChild(metaEl);

    if (scn.description) {
      var descEl = document.createElement('div');
      descEl.className = 'qa-curation-desc';
      descEl.textContent = scn.description;
      body.appendChild(descEl);
    }

    card.appendChild(body);

    // Actions
    var actions = document.createElement('div');
    actions.className = 'qa-curation-actions';

    var editBtn = document.createElement('button');
    editBtn.className = 'qa-btn qa-btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self._panel.openEditor(scn);
    });
    actions.appendChild(editBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'qa-btn qa-btn-sm qa-btn-danger';
    deleteBtn.textContent = '\u2715';
    deleteBtn.title = 'Remove scenario';
    deleteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self._deleteScenario(scn.id);
    });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    return card;
  }

  // ── Toggle / Delete ──

  _toggleScenario(id) {
    if (this._approved.has(id)) {
      this._approved.delete(id);
    } else {
      this._approved.add(id);
    }
    this._renderList();
    this._updateStats();
  }

  _deleteScenario(id) {
    this._scenarios = this._scenarios.filter(function (s) { return s.id !== id; });
    this._approved.delete(id);
    this._renderList();
    this._updateStats();
  }

  _updateStats(el) {
    var statsEl = el || document.getElementById('qaCurationStats');
    if (!statsEl) return;
    statsEl.textContent = this._approved.size + ' of ' + this._scenarios.length + ' approved';
    if (this._submitBtn) {
      this._submitBtn.textContent = 'Run Approved (' + this._approved.size + ') \u25B8';
      this._submitBtn.disabled = this._approved.size === 0;
    }
  }

  // ── Submit ──

  _submit() {
    var self = this;
    var approved = this._scenarios.filter(function (s) { return self._approved.has(s.id); });
    if (!approved.length) return;

    var conn = this._panel.getConnection();
    if (!conn) return;

    this._submitBtn.disabled = true;
    this._submitBtn.textContent = 'Submitting\u2026';

    var corrId = this._panel.getCorrelationId();
    var submission = {
      correlationId: corrId,
      analysisId: this._analysisId,
      scenarios: approved
    };

    conn.invoke('QaSubmitCuratedScenarios', submission).then(function (result) {
      if (result && result.success) {
        self._panel.setRunId(result.runId);
        var runRequest = {
          correlationId: self._panel.getCorrelationId(),
          runId: result.runId,
          scenarioIds: null,
          options: {
            stopOnFirstFailure: false,
            interScenarioDelayMs: 500,
            globalTimeoutMs: 1800000
          }
        };
        return conn.invoke('QaStartRun', runRequest);
      }
      throw new Error((result && result.message) || 'Submission failed');
    }).then(function (runResult) {
      if (runResult && runResult.success) {
        if (self._panel._execution) {
          self._panel._execution.startTracking(approved);
        }
        self._panel.goToStage('execution');
        return;
      }
      throw new Error((runResult && runResult.message) || 'Run start failed');
    }).catch(function (err) {
      self._submitBtn.disabled = false;
      self._submitBtn.textContent = 'Run Approved (' + self._approved.size + ') \u25B8';
      if (window.edogToast) {
        window.edogToast.show('Submission error: ' + (err.message || err), 'error');
      }
    });
  }

  /** Update a scenario after editing in the overlay. */
  updateScenario(updated) {
    for (var i = 0; i < this._scenarios.length; i++) {
      if (this._scenarios[i].id === updated.id) {
        this._scenarios[i] = updated;
        break;
      }
    }
    this._renderList();
  }
}
