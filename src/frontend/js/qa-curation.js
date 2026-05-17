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
    this._lintFindings = [];    // F27 item 5 — deterministic linter findings
    this._lintByScenario = new Map(); // scenarioId -> array of findings
    this._batchFindings = [];   // findings without a scenarioId (coverage gaps)
  }

  init() {
    this._container = document.getElementById('qaCurationContainer');
    this._panel.registerCuration(this);
  }

  /**
   * Load scenarios from analysis stage.
   *
   * @param {Array} scenarios — full scenario objects from QaScenarioGenerated.
   * @param {string} analysisId — correlation between analysis and curation.
   * @param {Array} [lintFindings] — F27 item 5 deterministic findings, optional.
   *   Each entry: { code, severity, message, scenarioId, invariantId }.
   *   Findings without a scenarioId are treated as batch-level (coverage gaps).
   */
  loadScenarios(scenarios, analysisId, lintFindings) {
    this._scenarios = scenarios.slice();
    this._analysisId = analysisId;
    this._approved = new Set(this._scenarios.map(function (s) { return s.id; }));

    // Index findings for O(1) lookup during card render.
    this._lintFindings = Array.isArray(lintFindings) ? lintFindings.slice() : [];
    this._lintByScenario = new Map();
    this._batchFindings = [];
    for (var i = 0; i < this._lintFindings.length; i++) {
      var f = this._lintFindings[i];
      if (!f) continue;
      if (f.scenarioId) {
        if (!this._lintByScenario.has(f.scenarioId)) {
          this._lintByScenario.set(f.scenarioId, []);
        }
        this._lintByScenario.get(f.scenarioId).push(f);
      } else {
        this._batchFindings.push(f);
      }
    }
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

    // Batch-level lint findings (coverage gaps, truth-table cells) appear
    // above the scenario list as a collapsible panel.
    if (this._batchFindings && this._batchFindings.length > 0) {
      this._container.appendChild(this._renderBatchFindings());
    }

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

    // F27 P0: placeholder badge for stub/synthetic scenarios.
    // The C# side tags these via metadata.generatedBy === 'stub_llm' (when the
    // StubLlmProvider runs) or 'synthetic' (when the hub's synthetic fallback
    // kicks in because the real pipeline returned nothing). Users must never
    // treat these as real AI output.
    var generatedBy = scn.metadata && scn.metadata.generatedBy;
    if (generatedBy === 'stub_llm' || generatedBy === 'synthetic') {
      var phBadge = document.createElement('span');
      phBadge.className = 'qa-placeholder-badge';
      phBadge.textContent = 'PLACEHOLDER';
      phBadge.title = generatedBy === 'stub_llm'
        ? 'Generated by the stub LLM provider — not real AI output. Configure Azure OpenAI to get real scenarios.'
        : 'Hand-coded fallback scenario — the real analyzer produced no scenarios for this PR.';
      metaEl.appendChild(phBadge);
    }

    if (scn.stimulus && scn.stimulus.type) {
      var stimEl = document.createElement('span');
      stimEl.className = 'qa-stimulus-badge';
      stimEl.textContent = scn.stimulus.type.replace(/_/g, ' ');
      metaEl.appendChild(stimEl);
    }

    // F27 item 3: technique pill (BoundaryTriplet, Counterfactual, ...).
    // Falls back gracefully for older synthetic scenarios that don't set it.
    var technique = scn.technique || scn.Technique;
    if (technique && technique !== 'NotSpecified') {
      var techEl = document.createElement('span');
      techEl.className = 'qa-technique-badge qa-tech-' + technique.toLowerCase();
      techEl.textContent = this._humanizeTechnique(technique);
      techEl.title = 'Test technique applied to this scenario';
      metaEl.appendChild(techEl);
    }

    var expCount = document.createElement('span');
    expCount.className = 'qa-exp-count';
    var n = scn.expectations ? scn.expectations.length : 0;
    expCount.textContent = n + ' expectation' + (n !== 1 ? 's' : '');
    metaEl.appendChild(expCount);

    // F27 item 5: lint summary pill (Error / Warning counts) per card.
    var perScn = this._lintByScenario.get(scn.id);
    if (perScn && perScn.length > 0) {
      var errCount = 0, warnCount = 0;
      for (var li = 0; li < perScn.length; li++) {
        var sev = (perScn[li].severity || '').toLowerCase();
        if (sev === 'error') errCount++;
        else if (sev === 'warning') warnCount++;
      }
      if (errCount + warnCount > 0) {
        var lintBadge = document.createElement('span');
        lintBadge.className = 'qa-lint-badge ' + (errCount > 0 ? 'qa-lint-error' : 'qa-lint-warn');
        lintBadge.textContent = '\u2696 ' + (errCount > 0 ? (errCount + ' error') : '') +
                                (errCount > 0 && warnCount > 0 ? ', ' : '') +
                                (warnCount > 0 ? (warnCount + ' warn') : '');
        lintBadge.title = 'Lint findings on this scenario — see details below.';
        metaEl.appendChild(lintBadge);
      }
    }

    body.appendChild(metaEl);

    if (scn.description) {
      var descEl = document.createElement('div');
      descEl.className = 'qa-curation-desc';
      descEl.textContent = scn.description;
      body.appendChild(descEl);
    }

    // F27 item 6: grounding evidence expandable. Hidden by default; click
    // chevron to reveal the file:line ranges and rationales the LLM cited.
    var grounding = scn.groundingEvidence || scn.GroundingEvidence;
    if (Array.isArray(grounding) && grounding.length > 0) {
      body.appendChild(this._renderGrounding(grounding));
    }

    // F27 item 5: per-scenario lint findings list.
    if (perScn && perScn.length > 0) {
      body.appendChild(this._renderScenarioFindings(perScn));
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
        window.edogToast('Submission error: ' + (err.message || err), 'error');
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

  // ── F27 helpers ──

  /** Convert PascalCase technique to a human-readable label. */
  _humanizeTechnique(t) {
    if (!t) return '';
    return t.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /**
   * Render the grounding-evidence expander: chevron + list of file:line + reason.
   * Each evidence item is read-only; clicking the chevron toggles the body.
   */
  _renderGrounding(grounding) {
    var wrap = document.createElement('div');
    wrap.className = 'qa-grounding';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'qa-grounding-toggle';
    toggle.textContent = '\u25B8 Grounding (' + grounding.length + ')';
    toggle.setAttribute('aria-expanded', 'false');

    var body = document.createElement('div');
    body.className = 'qa-grounding-body';
    body.style.display = 'none';

    for (var i = 0; i < grounding.length; i++) {
      var ev = grounding[i];
      if (!ev) continue;
      var row = document.createElement('div');
      row.className = 'qa-grounding-row';

      var loc = document.createElement('code');
      loc.className = 'qa-grounding-loc';
      var locText = (ev.file || ev.File || '(unknown)');
      var start = ev.startLine || ev.StartLine;
      var end = ev.endLine || ev.EndLine;
      if (start) locText += ':' + start + (end && end !== start ? '-' + end : '');
      loc.textContent = locText;
      row.appendChild(loc);

      var reason = document.createElement('span');
      reason.className = 'qa-grounding-reason';
      reason.textContent = ev.reason || ev.Reason || '';
      row.appendChild(reason);

      var invId = ev.invariantId || ev.InvariantId;
      if (invId) {
        var inv = document.createElement('span');
        inv.className = 'qa-grounding-inv';
        inv.textContent = invId;
        inv.title = 'Linked invariant';
        row.appendChild(inv);
      }

      body.appendChild(row);
    }

    toggle.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      toggle.textContent = (open ? '\u25B8' : '\u25BE') + ' Grounding (' + grounding.length + ')';
    });

    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  /** Render the per-scenario lint findings as a stacked list of severity rows. */
  _renderScenarioFindings(findings) {
    var wrap = document.createElement('div');
    wrap.className = 'qa-lint-findings';

    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      if (!f) continue;
      var row = document.createElement('div');
      var sev = (f.severity || 'info').toLowerCase();
      row.className = 'qa-lint-row qa-lint-' + sev;

      var code = document.createElement('code');
      code.className = 'qa-lint-code';
      code.textContent = f.code || 'LNT???';
      row.appendChild(code);

      var msg = document.createElement('span');
      msg.className = 'qa-lint-msg';
      msg.textContent = f.message || '';
      row.appendChild(msg);

      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Render the batch-level lint findings panel (coverage gaps, etc.). */
  _renderBatchFindings() {
    var panel = document.createElement('div');
    panel.className = 'qa-lint-batch';

    var header = document.createElement('div');
    header.className = 'qa-lint-batch-header';
    var errCount = 0, warnCount = 0;
    for (var i = 0; i < this._batchFindings.length; i++) {
      var sev = (this._batchFindings[i].severity || '').toLowerCase();
      if (sev === 'error') errCount++;
      else if (sev === 'warning') warnCount++;
    }
    header.textContent = '\u2696 Batch lint findings — ' + errCount + ' error, ' + warnCount + ' warning';
    panel.appendChild(header);

    var list = document.createElement('div');
    list.className = 'qa-lint-batch-list';
    for (var j = 0; j < this._batchFindings.length; j++) {
      var f = this._batchFindings[j];
      if (!f) continue;
      var row = document.createElement('div');
      var sv = (f.severity || 'info').toLowerCase();
      row.className = 'qa-lint-row qa-lint-' + sv;

      var code = document.createElement('code');
      code.className = 'qa-lint-code';
      code.textContent = f.code || 'LNT???';
      row.appendChild(code);

      var msg = document.createElement('span');
      msg.className = 'qa-lint-msg';
      msg.textContent = f.message || '';
      row.appendChild(msg);

      if (f.invariantId) {
        var inv = document.createElement('span');
        inv.className = 'qa-lint-inv';
        inv.textContent = f.invariantId;
        row.appendChild(inv);
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
  }
}
