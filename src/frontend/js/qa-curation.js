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
    this._edited = new Set();   // set of scenario IDs the curator opened + saved
    this._totalGenerated = 0;   // snapshot of analyzer output, before deletions
    this._analysisId = null;
    this._lintFindings = [];    // F27 item 5 — deterministic linter findings
    this._lintByScenario = new Map(); // scenarioId -> array of findings
    this._batchFindings = [];   // findings without a scenarioId (coverage gaps)
    this._testingGuidance = null; // F27 P11 — aggregated testingGuidance block from architect events
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
  loadScenarios(scenarios, analysisId, lintFindings, testingGuidance) {
    this._scenarios = scenarios.slice();
    this._analysisId = analysisId;
    this._approved = new Set(this._scenarios.map(function (s) { return s.id; }));
    this._edited = new Set();
    this._totalGenerated = this._scenarios.length;

    // F27 P11: testingGuidance is optional — Architect may have emitted it
    // pre-projection. Each entry contains the 6 structured sections
    // (codePaths, featureFlagMatrix, stimuliRequired, observableSignals,
    // errorModesToTest, externalDependencyFailures) plus diagnosticNotes.
    this._testingGuidance = testingGuidance || null;

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

    // ── P10: Three-column workbench shell ──
    this._workbench = document.createElement('div');
    this._workbench.className = 'qa-workbench-three-col';
    this._workbench.style.display = 'none';

    // Left column: scenario list with search, badges, quarantine chip
    this._leftCol = document.createElement('div');
    this._leftCol.className = 'qa-workbench-left';
    this._leftCol.innerHTML = '<div class="qa-workbench-search">'
      + '<input type="text" class="qa-workbench-search-input" placeholder="Filter scenarios...">'
      + '</div><div class="qa-workbench-scenario-list"></div>';

    // Middle column: slot picker, kind selector, typed parameter forms
    this._middleCol = document.createElement('div');
    this._middleCol.className = 'qa-workbench-middle';
    this._middleCol.innerHTML = '<div class="qa-workbench-slot-picker"></div>'
      + '<div class="qa-workbench-kind-selector"></div>'
      + '<div class="qa-workbench-params"></div>';

    // Right column: matcher composer, assertion selector, issues strip, last-run strip
    this._rightCol = document.createElement('div');
    this._rightCol.className = 'qa-workbench-right';
    this._rightCol.innerHTML = '<div class="qa-workbench-matcher-composer"></div>'
      + '<div class="qa-workbench-assertion-selector"></div>'
      + '<div class="qa-workbench-issues-strip"></div>'
      + '<div class="qa-workbench-last-run-strip"></div>';

    this._workbench.appendChild(this._leftCol);
    this._workbench.appendChild(this._middleCol);
    this._workbench.appendChild(this._rightCol);
    this._container.appendChild(this._workbench);

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

    // F27 P11: testing guidance panel — collapsible, shows the Architect's
    // six structured projections + diagnosticNotes. Rendered above batch
    // findings so curators see "what we asked the model to think about"
    // before "what the linter flagged".
    if (this._testingGuidance) {
      this._container.appendChild(this._renderTestingGuidance(this._testingGuidance));
    }

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

    // F27 P11: addressesCodePathIds / addressesErrorModeIds chip strip.
    // Surfaces the Architect's coverage projection on each card so curators
    // can see "this scenario exists to address cp-1, em-2". Hidden when
    // empty — older scenarios from pre-P11 plans simply omit the strip.
    var codePathIds = scn.addressesCodePathIds || scn.AddressesCodePathIds;
    var errorModeIds = scn.addressesErrorModeIds || scn.AddressesErrorModeIds;
    if ((Array.isArray(codePathIds) && codePathIds.length > 0)
        || (Array.isArray(errorModeIds) && errorModeIds.length > 0)) {
      var coverageStrip = document.createElement('div');
      coverageStrip.className = 'qa-curation-coverage-strip';
      if (Array.isArray(codePathIds)) {
        for (var ci = 0; ci < codePathIds.length; ci++) {
          var cpChip = document.createElement('span');
          cpChip.className = 'qa-coverage-chip qa-coverage-codepath';
          cpChip.textContent = codePathIds[ci];
          cpChip.title = 'Addresses code path ' + codePathIds[ci];
          coverageStrip.appendChild(cpChip);
        }
      }
      if (Array.isArray(errorModeIds)) {
        for (var ei = 0; ei < errorModeIds.length; ei++) {
          var emChip = document.createElement('span');
          emChip.className = 'qa-coverage-chip qa-coverage-errormode';
          emChip.textContent = errorModeIds[ei];
          emChip.title = 'Addresses error mode ' + errorModeIds[ei];
          coverageStrip.appendChild(emChip);
        }
      }
      body.appendChild(coverageStrip);
    }

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

    // P10 / P2-2: read-only typed matchers section. The Editor workbench
    // owns full editing; here we just surface what the LLM produced so the
    // user can decide approve/exclude without round-tripping through it.
    var matchers = scn.matchers || scn.Matchers;
    if (Array.isArray(matchers) && matchers.length > 0) {
      body.appendChild(this._renderTypedMatchers(matchers));
    }

    // P10 / P2-2: catalogHashes provenance — show snapshotId so the user
    // can correlate the scenario with the active catalog. Hashes are
    // intentionally elided to keep the card scannable.
    var catalogHashes = scn.catalogHashes || scn.CatalogHashes;
    var snapshotId = catalogHashes && (catalogHashes.catalogSnapshotId || catalogHashes.CatalogSnapshotId);
    if (snapshotId) {
      body.appendChild(this._renderCatalogProvenance(snapshotId, catalogHashes));
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
    var editedIds = [];
    this._edited.forEach(function (id) { editedIds.push(id); });
    var submission = {
      correlationId: corrId,
      analysisId: this._analysisId,
      scenarios: approved,
      editedScenarioIds: editedIds,
      totalGenerated: this._totalGenerated || this._scenarios.length
    };

    console.log('[QA-DIAG] Submitting', approved.length, 'scenarios, payload ~' +
      Math.round(JSON.stringify(submission).length / 1024) + 'KB');

    conn.invoke('QaSubmitCuratedScenarios', submission).then(function (result) {
      console.log('[QA-DIAG] Submit result:', result);
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
      if (result && result.validationErrors) {
        console.error('[QA-DIAG] Validation errors:', result.validationErrors);
        result.validationErrors.forEach(function (e) {
          console.error('[QA-DIAG]   ' + (e.scenarioId || '?') + '.' + (e.field || '?') + ': ' + (e.message || ''));
        });
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
      console.error('[QA-DIAG] *** Submit FAILED:', err, err.stack || '');
      console.log('[QA-DIAG] Submission payload size:', JSON.stringify(submission).length, 'bytes, scenarios:', approved.length);
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
        if (updated && updated.id) {
          this._edited.add(updated.id);
        }
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

  /**
   * P10 / P2-2: render typed matchers (read-only) for a scenario card. Each
   * row shows topicField, assertion, and a compact value summary so the
   * curator can sanity-check the LLM output before approving.
   */
  _renderTypedMatchers(matchers) {
    var wrap = document.createElement('div');
    wrap.className = 'qa-matchers';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'qa-matchers-toggle';
    toggle.textContent = '\u25B8 Matchers (' + matchers.length + ')';
    toggle.setAttribute('aria-expanded', 'false');

    var body = document.createElement('div');
    body.className = 'qa-matchers-body';
    body.style.display = 'none';

    for (var i = 0; i < matchers.length; i++) {
      var m = matchers[i];
      if (!m) continue;
      var row = document.createElement('div');
      row.className = 'qa-matcher-row';

      var field = document.createElement('code');
      field.className = 'qa-matcher-field';
      field.textContent = m.topicField || m.TopicField || '(no topic)';
      row.appendChild(field);

      var assertion = document.createElement('span');
      assertion.className = 'qa-matcher-assertion';
      var assertionText = m.assertion || m.Assertion || '';
      assertion.textContent = typeof assertionText === 'string'
        ? assertionText.toLowerCase()
        : String(assertionText);
      row.appendChild(assertion);

      var valueEl = document.createElement('span');
      valueEl.className = 'qa-matcher-value';
      valueEl.textContent = this._summarizeMatcherValue(m.value || m.Value);
      row.appendChild(valueEl);

      body.appendChild(row);
    }

    toggle.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      toggle.textContent = (open ? '\u25B8' : '\u25BE') + ' Matchers (' + matchers.length + ')';
    });

    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  /** Compact, read-only summary of a typed matcher value payload. */
  _summarizeMatcherValue(value) {
    if (value == null) return '(no value)';
    var type = value.type || value.Type;
    if (value.value !== undefined && value.value !== null) {
      return (type ? type + ': ' : '') + String(value.value);
    }
    if (value.Value !== undefined && value.Value !== null) {
      return (type ? type + ': ' : '') + String(value.Value);
    }
    var min = value.min != null ? value.min : value.Min;
    var max = value.max != null ? value.max : value.Max;
    if (min != null || max != null) {
      return '[' + (min != null ? min : '\u2212\u221E') + ', ' + (max != null ? max : '+\u221E') + ']';
    }
    var values = value.values || value.Values;
    if (Array.isArray(values)) {
      return '[' + values.map(function (v) { return String(v); }).join(', ') + ']';
    }
    return type || '(opaque)';
  }

  /** P10 / P2-2: catalogHashes provenance pill (snapshotId only). */
  _renderCatalogProvenance(snapshotId, hashes) {
    var wrap = document.createElement('div');
    wrap.className = 'qa-catalog-provenance';

    var pill = document.createElement('span');
    pill.className = 'qa-catalog-pill';
    var idStr = String(snapshotId || '');
    var shortId = idStr.length > 12 ? idStr.slice(0, 12) : idStr;
    pill.textContent = '\u25C6 ' + shortId;
    var topicHashes = hashes && (hashes.matcherTopicHashes || hashes.MatcherTopicHashes);
    var topicCount = topicHashes ? Object.keys(topicHashes).length : 0;
    pill.title = 'CatalogSnapshotId: ' + idStr + ' — grounded against ' + topicCount + ' topic hash(es).';
    wrap.appendChild(pill);

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

  // F27 P11: testing guidance panel — six structured sections + diagnosticNotes.
  // The shape is identical to TestingGuidance in EdogQaLlmClient.cs.
  _renderTestingGuidance(guidance) {
    var panel = document.createElement('div');
    panel.className = 'qa-testing-guidance';

    var header = document.createElement('div');
    header.className = 'qa-testing-guidance-header';
    var sectionCount = 0;
    var fieldKeys = ['codePaths', 'featureFlagMatrix', 'stimuliRequired',
      'observableSignals', 'errorModesToTest', 'externalDependencyFailures'];
    for (var k = 0; k < fieldKeys.length; k++) {
      var arr = guidance[fieldKeys[k]];
      if (Array.isArray(arr) && arr.length > 0) sectionCount++;
    }
    header.textContent = '\u25C6 Testing guidance \u2014 ' + sectionCount + ' section'
      + (sectionCount !== 1 ? 's' : '') + ' from the Architect';
    panel.appendChild(header);

    var body = document.createElement('div');
    body.className = 'qa-testing-guidance-body';

    if (Array.isArray(guidance.codePaths) && guidance.codePaths.length > 0) {
      body.appendChild(this._renderGuidanceList('Code paths', guidance.codePaths, function (item) {
        return (item.id || '') + ' [' + (item.changeKind || '') + '] '
          + (item.description || '');
      }));
    }
    if (Array.isArray(guidance.featureFlagMatrix) && guidance.featureFlagMatrix.length > 0) {
      body.appendChild(this._renderGuidanceList('Feature flag matrix', guidance.featureFlagMatrix, function (item) {
        var pairs = '';
        if (Array.isArray(item.flags)) {
          for (var fi = 0; fi < item.flags.length; fi++) {
            if (fi > 0) pairs += ', ';
            pairs += (item.flags[fi].name || '') + '=' + (item.flags[fi].value || '');
          }
        }
        var mustCover = item.mustCover ? ' \u2713 must-cover' : '';
        return (item.id || '') + ' {' + pairs + '}' + mustCover + ' \u2014 ' + (item.rationale || '');
      }));
    }
    if (Array.isArray(guidance.stimuliRequired) && guidance.stimuliRequired.length > 0) {
      body.appendChild(this._renderGuidanceList('Stimuli required', guidance.stimuliRequired, function (item) {
        return (item.id || '') + ' [' + (item.kind || '') + '] ' + (item.description || '');
      }));
    }
    if (Array.isArray(guidance.observableSignals) && guidance.observableSignals.length > 0) {
      body.appendChild(this._renderGuidanceList('Observable signals', guidance.observableSignals, function (item) {
        return (item.id || '') + ' [' + (item.kind || '') + '@' + (item.source || '') + '] '
          + (item.description || '');
      }));
    }
    if (Array.isArray(guidance.errorModesToTest) && guidance.errorModesToTest.length > 0) {
      body.appendChild(this._renderGuidanceList('Error modes to test', guidance.errorModesToTest, function (item) {
        return (item.id || '') + ' \u2014 ' + (item.description || '')
          + ' (trigger: ' + (item.trigger || '?') + ', expected: ' + (item.expectedHandling || '?') + ')';
      }));
    }
    if (Array.isArray(guidance.externalDependencyFailures) && guidance.externalDependencyFailures.length > 0) {
      body.appendChild(this._renderGuidanceList('External dependency failures', guidance.externalDependencyFailures, function (item) {
        return (item.id || '') + ' [' + (item.dependency || '') + '] '
          + (item.failureMode || '') + ' \u2192 ' + (item.expectedSystemResponse || '');
      }));
    }

    var notes = guidance.diagnosticNotes;
    if (notes && typeof notes === 'string' && notes.trim().length > 0) {
      var notesSection = document.createElement('div');
      notesSection.className = 'qa-testing-guidance-section';
      var notesTitle = document.createElement('div');
      notesTitle.className = 'qa-testing-guidance-section-title';
      notesTitle.textContent = 'Diagnostic notes';
      notesSection.appendChild(notesTitle);
      var notesEl = document.createElement('div');
      notesEl.className = 'qa-testing-guidance-notes';
      notesEl.textContent = notes;
      notesSection.appendChild(notesEl);
      body.appendChild(notesSection);
    }

    panel.appendChild(body);
    return panel;
  }

  _renderGuidanceList(title, items, formatter) {
    var section = document.createElement('div');
    section.className = 'qa-testing-guidance-section';

    var titleEl = document.createElement('div');
    titleEl.className = 'qa-testing-guidance-section-title';
    titleEl.textContent = title + ' (' + items.length + ')';
    section.appendChild(titleEl);

    var list = document.createElement('ul');
    list.className = 'qa-testing-guidance-list';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      var li = document.createElement('li');
      li.textContent = formatter(item);
      list.appendChild(li);
    }
    section.appendChild(list);
    return section;
  }

  // ── P10: Three-column workbench ─────────────────────────────────

  /**
   * Activate the three-column workbench view. Hides the legacy list
   * and shows the structured slot/matcher editing surface.
   *
   * @param {Object} catalog — CatalogSnapshot from the backend
   */
  activateWorkbench(catalog) {
    if (!this._workbench) return;
    this._workbench.style.display = 'grid';
    this._populateLeftColumn(this._scenarios);
    if (catalog) {
      this._populateSlotPicker(catalog.slots || []);
      this._populateKindSelector(catalog.slots || []);
    }
  }

  _populateLeftColumn(scenarios) {
    var list = this._leftCol && this._leftCol.querySelector('.qa-workbench-scenario-list');
    if (!list) return;
    list.innerHTML = '';
    for (var i = 0; i < scenarios.length; i++) {
      var s = scenarios[i];
      var item = document.createElement('div');
      item.className = 'qa-workbench-scenario-item';
      item.dataset.scenarioId = s.id;

      var badge = document.createElement('span');
      badge.className = 'qa-workbench-badge qa-workbench-badge--' + (s.category || 'unknown').toLowerCase();
      badge.textContent = s.category || 'N/A';
      item.appendChild(badge);

      // Quarantine chip for pre-contract scenarios
      if (!s.matchers || s.matchers.length === 0) {
        var chip = document.createElement('span');
        chip.className = 'qa-workbench-quarantine-chip';
        chip.textContent = 'PRE-CONTRACT';
        item.appendChild(chip);
      }

      var title = document.createElement('span');
      title.className = 'qa-workbench-scenario-title';
      title.textContent = s.title || s.id;
      item.appendChild(title);

      list.appendChild(item);
    }
  }

  _populateSlotPicker(slots) {
    var picker = this._middleCol && this._middleCol.querySelector('.qa-workbench-slot-picker');
    if (!picker) return;
    picker.innerHTML = '<label>Stimulus Slot</label>';
    var select = document.createElement('select');
    select.className = 'qa-workbench-slot-select';
    for (var i = 0; i < slots.length; i++) {
      var opt = document.createElement('option');
      opt.value = slots[i].slotId || '';
      opt.textContent = (slots[i].slotId || '') + ' (' + (slots[i].kind || '') + ')';
      select.appendChild(opt);
    }
    picker.appendChild(select);
  }

  _populateKindSelector(slots) {
    var selector = this._middleCol && this._middleCol.querySelector('.qa-workbench-kind-selector');
    if (!selector) return;
    var kinds = {};
    for (var i = 0; i < slots.length; i++) {
      kinds[slots[i].kind || 'Unknown'] = true;
    }
    selector.innerHTML = '<label>Stimulus Kind</label>';
    var kindList = Object.keys(kinds);
    for (var i = 0; i < kindList.length; i++) {
      var btn = document.createElement('button');
      btn.className = 'qa-workbench-kind-btn';
      btn.textContent = kindList[i];
      selector.appendChild(btn);
    }
  }

  /**
   * Render typed parameter form for the selected slot.
   *
   * @param {Object} slot — QaContractSlot with parameters
   */
  renderTypedParams(slot) {
    var params = this._middleCol && this._middleCol.querySelector('.qa-workbench-params');
    if (!params || !slot) return;
    params.innerHTML = '<label>Parameters</label>';
    var paramKeys = Object.keys(slot.parameters || {});
    for (var i = 0; i < paramKeys.length; i++) {
      var p = slot.parameters[paramKeys[i]];
      var row = document.createElement('div');
      row.className = 'qa-workbench-param-row';

      var lbl = document.createElement('label');
      lbl.textContent = (p.name || paramKeys[i]) + (p.required ? ' *' : '');
      row.appendChild(lbl);

      var input = document.createElement('input');
      input.type = p.type === 'integer' || p.type === 'number' ? 'number' : 'text';
      input.className = 'qa-workbench-param-input';
      input.placeholder = p.description || '';
      row.appendChild(input);

      params.appendChild(row);
    }
  }

  /**
   * Build the matcher composer with assertion selector and typed value inputs.
   *
   * @param {Array} matchers — existing matchers for the selected scenario
   */
  renderMatcherComposer(matchers) {
    var composer = this._rightCol && this._rightCol.querySelector('.qa-workbench-matcher-composer');
    if (!composer) return;
    composer.innerHTML = '<label>Matchers</label>';

    var assertions = ['equals', 'notEquals', 'exists', 'inRange', 'containsAll', 'oneOf', 'length'];

    var items = matchers || [];
    for (var i = 0; i < items.length; i++) {
      var m = items[i];
      var row = document.createElement('div');
      row.className = 'qa-workbench-matcher-row';

      // Topic field input
      var field = document.createElement('input');
      field.className = 'qa-workbench-matcher-field';
      field.value = m.topicField || '';
      field.placeholder = 'topic.field';
      row.appendChild(field);

      // Assertion selector
      var sel = document.createElement('select');
      sel.className = 'qa-workbench-assertion-select';
      for (var j = 0; j < assertions.length; j++) {
        var opt = document.createElement('option');
        opt.value = assertions[j];
        opt.textContent = assertions[j];
        if (assertions[j].toLowerCase() === (m.assertion || '').toLowerCase()) {
          opt.selected = true;
        }
        sel.appendChild(opt);
      }
      row.appendChild(sel);

      // Typed value input (varies by assertion type)
      var valInput = this._createValueInput(m);
      row.appendChild(valInput);

      composer.appendChild(row);
    }

    // Add button
    var addBtn = document.createElement('button');
    addBtn.className = 'qa-workbench-add-matcher-btn';
    addBtn.textContent = '+ Add Matcher';
    composer.appendChild(addBtn);
  }

  _createValueInput(matcher) {
    var wrap = document.createElement('div');
    wrap.className = 'qa-workbench-value-input';

    var assertion = (matcher.assertion || '').toLowerCase();
    if (assertion === 'inrange') {
      // Range: min/max inputs
      var min = document.createElement('input');
      min.type = 'number';
      min.placeholder = 'min';
      min.className = 'qa-workbench-range-min';
      wrap.appendChild(min);
      var max = document.createElement('input');
      max.type = 'number';
      max.placeholder = 'max';
      max.className = 'qa-workbench-range-max';
      wrap.appendChild(max);
    } else if (assertion === 'containsall' || assertion === 'oneof') {
      // Array: comma-separated input
      var arr = document.createElement('input');
      arr.type = 'text';
      arr.placeholder = 'value1, value2, ...';
      arr.className = 'qa-workbench-array-input';
      wrap.appendChild(arr);
    } else if (assertion === 'exists') {
      // Boolean: checkbox
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      chk.className = 'qa-workbench-exists-input';
      wrap.appendChild(chk);
    } else if (assertion === 'length') {
      // Length: min/max inputs
      var minLen = document.createElement('input');
      minLen.type = 'number';
      minLen.placeholder = 'min length';
      minLen.className = 'qa-workbench-length-min';
      wrap.appendChild(minLen);
      var maxLen = document.createElement('input');
      maxLen.type = 'number';
      maxLen.placeholder = 'max length';
      maxLen.className = 'qa-workbench-length-max';
      wrap.appendChild(maxLen);
    } else {
      // Scalar: single text input (equals, notEquals)
      var scalar = document.createElement('input');
      scalar.type = 'text';
      scalar.placeholder = 'expected value';
      scalar.className = 'qa-workbench-scalar-input';
      if (matcher.value && matcher.value.value != null) {
        scalar.value = String(matcher.value.value);
      }
      wrap.appendChild(scalar);
    }

    return wrap;
  }

  /**
   * Render the issues strip for the selected scenario.
   *
   * @param {Array} issues — validation/lint issues
   */
  renderIssuesStrip(issues) {
    var strip = this._rightCol && this._rightCol.querySelector('.qa-workbench-issues-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (!issues || issues.length === 0) return;
    var label = document.createElement('label');
    label.textContent = 'Issues (' + issues.length + ')';
    strip.appendChild(label);
    for (var i = 0; i < issues.length; i++) {
      var row = document.createElement('div');
      row.className = 'qa-workbench-issue-row';
      row.textContent = (issues[i].code || '') + ': ' + (issues[i].message || '');
      strip.appendChild(row);
    }
  }

  /**
   * Render the last-run result strip for the selected scenario.
   *
   * @param {Object} lastRun — last execution result
   */
  renderLastRunStrip(lastRun) {
    var strip = this._rightCol && this._rightCol.querySelector('.qa-workbench-last-run-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (!lastRun) return;
    var label = document.createElement('div');
    label.className = 'qa-workbench-last-run-label';
    label.textContent = 'Last Run: ' + (lastRun.verdict || 'N/A');
    strip.appendChild(label);
  }
}
