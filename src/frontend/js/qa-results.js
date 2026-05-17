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
    // F27 P7 — run comparison state.
    this._compareBaseRunId = null;
    this._compareData = null;
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

    // Reset comparison state on every fresh load — the diff is only
    // meaningful against the run currently being viewed.
    this._compareBaseRunId = null;
    this._compareData = null;

    var corrId = this._panel.getCorrelationId();
    conn.invoke('QaGetRunDetail', corrId, runId).then(result => {
      this._runResult = result;
      this._render();
      // Fire-and-forget — populates the compare-against dropdown once
      // history arrives. Re-renders to wire up the dropdown in place.
      this.loadHistory();
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

    // ── F27 P7: Compare toolbar + warnings + removed-from-target ghost rows ──
    this._renderCompareToolbar();
    this._renderCompareWarnings();
    this._renderRemovedScenarios();

    // Build a diff lookup so each scenario card can self-badge.
    var diffLookup = this._buildDiffLookup();

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
        list.appendChild(this._createResultCard(scenarios[j], j, diffLookup));
      }
      this._container.appendChild(list);
    }

    // ── Actions ──
    var actions = document.createElement('div');
    actions.className = 'qa-results-actions';

    // F27 P6 — Markdown export + Post-to-PR
    var copyBtn = document.createElement('button');
    copyBtn.className = 'qa-btn';
    copyBtn.textContent = 'Copy as Markdown';
    copyBtn.addEventListener('click', () => this._copyAsMarkdown(copyBtn));
    actions.appendChild(copyBtn);

    var postBtn = document.createElement('button');
    postBtn.className = 'qa-btn';
    postBtn.textContent = 'Post to PR';
    var prUrl = (this._panel && typeof this._panel.getPrUrl === 'function') ? this._panel.getPrUrl() : null;
    if (!prUrl) {
      postBtn.disabled = true;
      postBtn.title = 'No PR URL captured for this run';
    }
    postBtn.addEventListener('click', () => this._postToPr(postBtn));
    actions.appendChild(postBtn);

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

  // ── F27 P6: Markdown export + Post-to-PR ──────────────────────────────

  /** Build an ADO-compatible markdown comment from the current run. */
  _buildPrMarkdown() {
    var run = this._runResult;
    if (!run) return '';
    var s = run.summary || {};
    var passed = s.passed || 0;
    var failed = s.failed || 0;
    var timedOut = s.timedOut || 0;
    var skipped = s.skipped || 0;
    var total = s.total || (passed + failed + timedOut + skipped);
    var verdict = run.overallPass ? '\u2705 All scenarios passed' : '\u274C Failures detected';

    var lines = [];
    lines.push('## EDOG QA Testing \u2014 ' + verdict);
    if (run.prTitle) lines.push('**PR:** ' + run.prTitle);
    lines.push('');
    lines.push('| Verdict | Count |');
    lines.push('| --- | ---: |');
    lines.push('| Passed  | ' + passed + ' |');
    lines.push('| Failed  | ' + failed + ' |');
    lines.push('| Timeout | ' + timedOut + ' |');
    lines.push('| Skipped | ' + skipped + ' |');
    lines.push('| **Total** | **' + total + '** |');
    if (run.totalDurationMs != null) {
      lines.push('');
      lines.push('**Duration:** ' + (run.totalDurationMs / 1000).toFixed(1) + 's');
    }

    var scenarios = run.scenarios || run.scenarioResults || [];
    var failures = scenarios.filter(function (s) {
      var v = (s.verdict || s.overallVerdict || '').toLowerCase();
      return v === 'failed' || v === 'timeout' || v === 'timed_out';
    });
    if (failures.length) {
      lines.push('');
      lines.push('### Failed scenarios');
      for (var i = 0; i < failures.length; i++) {
        var f = failures[i];
        var title = f.title || f.scenarioId || 'Scenario';
        var v = (f.verdict || f.overallVerdict || 'failed').toUpperCase();
        lines.push('');
        lines.push('<details><summary><strong>' + v + '</strong> \u2014 ' + this._mdEscape(title) + '</summary>');
        lines.push('');
        if (f.failureMessage) {
          lines.push('```');
          lines.push(String(f.failureMessage));
          lines.push('```');
        }
        var exps = f.expectations || f.expectationResults || [];
        for (var k = 0; k < exps.length; k++) {
          var e = exps[k];
          var st = e.status || 'unknown';
          var icon = st === 'passed' ? '\u2705' : (st === 'failed' ? '\u274C' : (st === 'timeout' ? '\u23F1\uFE0F' : '\u26AA'));
          lines.push('- ' + icon + ' ' + this._mdEscape(e.description || e.id || e.expectationId || ''));
        }
        lines.push('');
        lines.push('</details>');
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('_Generated by EDOG Studio QA Testing \u2014 run `' + (run.runId || '?') + '`_');
    return lines.join('\n');
  }

  _mdEscape(s) {
    return String(s).replace(/[<>]/g, function (c) { return c === '<' ? '&lt;' : '&gt;'; });
  }

  async _copyAsMarkdown(btn) {
    var md = this._buildPrMarkdown();
    if (!md) return;
    var originalText = btn.textContent;
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
      } else {
        var ta = document.createElement('textarea');
        ta.value = md;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      btn.textContent = 'Copied';
      if (window.edogToast) window.edogToast.show('Comment markdown copied to clipboard', 'success');
    } catch (e) {
      btn.textContent = 'Copy failed';
      if (window.edogToast) window.edogToast.show('Copy failed: ' + (e.message || e), 'error');
    } finally {
      setTimeout(function () { btn.textContent = originalText; }, 1800);
    }
  }

  async _postToPr(btn) {
    var prUrl = (this._panel && typeof this._panel.getPrUrl === 'function') ? this._panel.getPrUrl() : null;
    if (!prUrl) {
      if (window.edogToast) window.edogToast.show('No PR URL captured for this run', 'error');
      return;
    }
    var markdown = this._buildPrMarkdown();
    if (!markdown) {
      if (window.edogToast) window.edogToast.show('Nothing to post', 'error');
      return;
    }

    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Posting\u2026';
    try {
      var resp = await fetch('/api/ado-proxy/pr-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prUrl: prUrl, markdown: markdown })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        var msg = (data && data.message) || ('ADO returned ' + resp.status);
        if (window.edogToast) window.edogToast.show('Post to PR failed: ' + msg, 'error');
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
      btn.textContent = 'Posted \u2713';
      if (window.edogToast) {
        window.edogToast.show('QA results posted to PR #' + (data.prId || '?'), 'success');
      }
      // Leave the button disabled to communicate idempotency for this run.
    } catch (e) {
      if (window.edogToast) window.edogToast.show('Post to PR failed: ' + (e.message || e), 'error');
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  _createResultCard(scn, index, diffLookup) {
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

    // F27 P7: comparison badge (NEW or → PASS/→ FAIL).
    if (diffLookup) {
      var badge = this._diffBadgeForScenario(scn, diffLookup);
      if (badge) header.appendChild(badge);
    }

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

  /** Load run history for the current PR (or unscoped if none). */
  loadHistory() {
    var conn = this._panel.getConnection();
    if (!conn) return;
    var corrId = this._panel.getCorrelationId();
    // F27 P7: support unscoped (prId=0) runs — null only when truly missing.
    var prId = (this._runResult && this._runResult.prId != null) ? this._runResult.prId : null;
    conn.invoke('QaGetRunHistory', {
      correlationId: corrId,
      prId: prId,
      limit: 20,
      offset: 0
    }).then(results => {
      this._history = results || [];
      // Re-render so the compare dropdown picks up the new options.
      // We re-render the entire results view because the toolbar is
      // structurally tied to summary + scenario list ordering.
      if (this._runResult) this._render();
    }).catch(function() { /* ignore */ });
  }

  reset() {
    this._runResult = null;
    this._history = [];
    this._compareBaseRunId = null;
    this._compareData = null;
    if (this._container) this._container.innerHTML = '';
  }

  // ── F27 P7: Run comparison UI ────────────────────────────────────────

  /** Render the "Compare against" dropdown above the scenario list. */
  _renderCompareToolbar() {
    if (!this._runResult || !this._container) return;
    var history = this._history || [];
    // Exclude the run currently being viewed — comparing a run to
    // itself has no diff value.
    var currentId = this._runResult.runId;
    var candidates = history.filter(function (h) { return h && h.runId && h.runId !== currentId; });
    if (!candidates.length) return;

    var toolbar = document.createElement('div');
    toolbar.className = 'qa-compare-toolbar';

    var label = document.createElement('label');
    label.className = 'qa-compare-label';
    label.textContent = 'Compare against:';
    label.setAttribute('for', 'qa-compare-select');
    toolbar.appendChild(label);

    var select = document.createElement('select');
    select.id = 'qa-compare-select';
    select.className = 'qa-compare-select';

    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    select.appendChild(noneOpt);

    for (var i = 0; i < candidates.length; i++) {
      var h = candidates[i];
      var opt = document.createElement('option');
      opt.value = h.runId;
      var when = h.startedAt ? new Date(h.startedAt).toLocaleString() : h.runId;
      var verdict = h.overallPass === true ? 'pass' : (h.overallPass === false ? 'fail' : '?');
      opt.textContent = when + '  \u2014  ' + verdict + '  \u2014  ' + h.runId.substring(0, 8);
      if (h.runId === this._compareBaseRunId) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      var v = select.value || null;
      this._compareBaseRunId = v;
      if (!v) {
        this._compareData = null;
        this._render();
      } else {
        this._fetchComparison(v);
      }
    });
    toolbar.appendChild(select);

    if (this._compareBaseRunId) {
      var clearBtn = document.createElement('button');
      clearBtn.className = 'qa-btn qa-compare-clear';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        this._compareBaseRunId = null;
        this._compareData = null;
        this._render();
      });
      toolbar.appendChild(clearBtn);
    }

    this._container.appendChild(toolbar);
  }

  /** Invoke QaCompareRuns and re-render with the diff overlaid. */
  _fetchComparison(baseRunId) {
    var conn = this._panel.getConnection();
    if (!conn || !this._runResult) return;
    var targetRunId = this._runResult.runId;
    conn.invoke('QaCompareRuns', {
      baseRunId: baseRunId,
      targetRunId: targetRunId
    }).then(result => {
      // Stale-result guard: if the user cleared or switched base while
      // the request was in flight, drop this response on the floor.
      if (this._compareBaseRunId !== baseRunId) return;
      if (!this._runResult || this._runResult.runId !== targetRunId) return;
      this._compareData = result || null;
      if (result && result.success === false && result.error) {
        if (window.edogToast) window.edogToast.show('Compare failed: ' + result.error, 'error');
      }
      this._render();
    }).catch(err => {
      if (this._compareBaseRunId !== baseRunId) return;
      this._compareData = null;
      if (window.edogToast) window.edogToast.show('Compare failed: ' + (err.message || err), 'error');
      this._render();
    });
  }

  /** Yellow banner above the scenario list when comparison emits warnings. */
  _renderCompareWarnings() {
    var c = this._compareData;
    if (!c || !c.warnings || !c.warnings.length) return;
    var banner = document.createElement('div');
    banner.className = 'qa-warning qa-compare-warnings';
    var title = document.createElement('strong');
    title.textContent = 'Degraded comparison';
    banner.appendChild(title);
    var list = document.createElement('ul');
    list.className = 'qa-compare-warnings-list';
    for (var i = 0; i < c.warnings.length; i++) {
      var li = document.createElement('li');
      li.textContent = String(c.warnings[i]);
      list.appendChild(li);
    }
    banner.appendChild(list);
    this._container.appendChild(banner);
  }

  /** Ghost rows for scenarios present in base but missing from target. */
  _renderRemovedScenarios() {
    var c = this._compareData;
    if (!c || !c.removedFromTarget || !c.removedFromTarget.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'qa-compare-removed';
    var header = document.createElement('h4');
    header.className = 'qa-results-list-header';
    header.textContent = 'Removed since base (' + c.removedFromTarget.length + ')';
    wrap.appendChild(header);
    for (var i = 0; i < c.removedFromTarget.length; i++) {
      var s = c.removedFromTarget[i];
      var row = document.createElement('div');
      row.className = 'qa-card qa-result-card qa-removed';
      var hdr = document.createElement('div');
      hdr.className = 'qa-result-header';
      var titleEl = document.createElement('span');
      titleEl.className = 'qa-result-title';
      titleEl.textContent = s.title || s.scenarioId || 'Scenario';
      hdr.appendChild(titleEl);
      var badge = document.createElement('span');
      badge.className = 'qa-compare-badge qa-compare-gone';
      badge.textContent = 'GONE';
      hdr.appendChild(badge);
      row.appendChild(hdr);
      wrap.appendChild(row);
    }
    this._container.appendChild(wrap);
  }

  /** Build {keyOfScenario → diff entry} for fast per-card badge lookup. */
  _buildDiffLookup() {
    var c = this._compareData;
    if (!c || c.success === false) return null;
    var lookup = { added: {}, flips: {} };
    var added = c.addedInTarget || [];
    for (var i = 0; i < added.length; i++) {
      var k = this._scenarioKey(added[i]);
      if (k) lookup.added[k] = true;
    }
    var flips = c.statusFlips || [];
    for (var j = 0; j < flips.length; j++) {
      var f = flips[j];
      var fk = this._scenarioKey(f);
      if (fk) lookup.flips[fk] = f;
    }
    return lookup;
  }

  /** Match key — hash if present, scenarioId otherwise. Mirrors the C# matcher. */
  _scenarioKey(s) {
    if (!s) return null;
    if (s.scenarioHash) return 'h:' + s.scenarioHash;
    var id = s.scenarioId || s.id;
    return id ? 'i:' + id : null;
  }

  _diffBadgeForScenario(scn, lookup) {
    if (!lookup) return null;
    var key = this._scenarioKey(scn);
    if (!key) return null;
    var badge;
    if (lookup.added[key]) {
      badge = document.createElement('span');
      badge.className = 'qa-compare-badge qa-compare-new';
      badge.textContent = 'NEW';
      return badge;
    }
    var flip = lookup.flips[key];
    if (flip) {
      badge = document.createElement('span');
      var base = (flip.baseStatus || '').toLowerCase();
      var target = (flip.targetStatus || '').toLowerCase();
      // Arrow direction: base → target. Color by target outcome.
      var cls = 'qa-compare-flip';
      if (target === 'passed') cls += ' qa-compare-flip-pass';
      else if (target === 'failed' || target === 'timeout' || target === 'timed_out') cls += ' qa-compare-flip-fail';
      badge.className = 'qa-compare-badge ' + cls;
      badge.textContent = (base ? base.toUpperCase() : '?') + ' \u2192 ' + (target ? target.toUpperCase() : '?');
      badge.title = 'Status changed since base run';
      return badge;
    }
    return null;
  }
}
