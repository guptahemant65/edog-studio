/**
 * ErrorSimulator — Error Code Simulator frontend (F-ESIM).
 *
 * Owns the entire error-injection UX inside DAG Studio:
 *   • Side-panel picker (slides in from right, canvas stays interactive)
 *   • Multi-node bulk inject (shift/ctrl-click in renderer → picker targets N nodes)
 *   • Fuzzy + synonym search across the error catalog
 *   • Active rules panel (rendered below the DAG graph)
 *   • Node badges (⚡ glyph, count-stacked, source-tinted, pulse on add)
 *   • Blast-radius drawer (slides in from the right post-execution)
 *
 * Hub contract (server methods on EdogPlaygroundHub):
 *   ErrorSimGetCatalog()                                → JSON ErrorCodeEntry[]
 *   ErrorSimGetActiveRules()                            → JSON ErrorSimRule[]
 *   ErrorSimAddRule(nodeId, nodeName, nodeKind, code)   → JSON ErrorSimRule
 *   ErrorSimRemoveRule(ruleId)                          → JSON {removed}
 *   ErrorSimClearAll()                                  → JSON {cleared}
 *   ErrorSimGetBlastRadius(ruleId)                      → JSON {...}
 */

// Search synonyms: when a query starts with / equals these keys, we OR-expand
// to the listed terms so semantic search finds the right codes even when the
// user types intent instead of a specific token.
var ESIM_SYNONYMS = {
  auth:        ['auth', 'access', 'permission', 'denied', 'forbidden'],
  access:      ['auth', 'access', 'permission'],
  throttle:    ['throttle', 'capacity', 'quota', 'too_many', 'rate'],
  capacity:    ['capacity', 'throttle', 'quota', 'sku'],
  quota:       ['quota', 'throttle', 'capacity'],
  schema:      ['schema', 'mismatch', 'column'],
  connect:     ['session', 'submission', 'connection', 'network'],
  connection:  ['session', 'submission', 'connection'],
  session:     ['session', 'spark'],
  network:     ['network', 'connection', 'submission'],
  timeout:     ['timeout', 'time', 'slow', 'expire'],
  slow:        ['timeout', 'slow', 'time'],
  dep:         ['dependency', 'circular', 'lineage', 'dag'],
  depend:      ['dependency', 'circular', 'lineage', 'dag'],
  notfound:    ['not_found', 'missing', 'artifact'],
  missing:     ['not_found', 'missing', 'artifact'],
  retry:       ['retry', 'transient', 'submission'],
  ingest:      ['ingest', 'path', 'file', 'auth'],
  spark:       ['spark', 'session', 'job', 'pyspark'],
  pyspark:     ['pyspark', 'spark', 'notebook'],
};

class ErrorSimulator {
  constructor() {
    this._catalog = null;
    this._catalogByCode = new Map();
    this._activeRules = new Map();  // ruleId -> rule
    this._nodeIndex = new Map();    // nodeId -> [rule, ...]
    this._signalR = null;
    this._dagStudio = null;
    this._loadPromise = null;

    // DOM refs (lazily created)
    this._pickerEl = null;
    this._rulesPanelEl = null;
    this._drawerEl = null;

    // Picker state — now always an array of {id, name, kind}
    this._pickerTargets = [];
    this._pickerSelectedCode = null;
    this._pickerFilter = '';
    this._searchDebounce = 0;

    // localStorage-backed recents (last 8 codes injected)
    this._recents = this._loadRecents();

    // Bind handlers
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /* ───────────────────────── Public API ───────────────────────── */

  /**
   * Wire up the simulator. Called by DagStudio after SignalR is ready.
   * Idempotent — safe to call on every activate().
   */
  init(signalR, dagStudio) {
    if (this._signalR && this._signalR === signalR && this._dagStudio) return;
    this._signalR = signalR;
    this._dagStudio = dagStudio;
    this._loadCatalog().catch(function(err) {
      console.warn('[ErrorSim] catalog load failed:', err);
    });
    this._refreshActiveRules().catch(function() {});
    this._ensureRulesPanel();
  }

  /**
   * Single-node picker entry (back-compat shortcut for the right-click flow).
   * x/y are accepted but ignored — the picker is now a fixed side-panel.
   */
  showPicker(nodeId, nodeName, nodeKind, /* x */ _x, /* y */ _y) {
    this.showPickerForSelection([{
      id: nodeId,
      name: nodeName || nodeId,
      kind: (nodeKind || 'unknown').toLowerCase()
    }]);
  }

  /**
   * Multi-node picker entry. Pass an array of {id, name, kind}.
   * Header summarizes the targets; commit fires one rule per node.
   */
  showPickerForSelection(targets) {
    if (!targets || !targets.length) return;
    var self = this;
    this._pickerTargets = targets.map(function(t) {
      return { id: t.id, name: t.name || t.id, kind: (t.kind || 'unknown').toLowerCase() };
    });
    this._pickerSelectedCode = null;
    this._pickerFilter = '';
    this._loadCatalog().then(function() {
      self._renderPicker();
    }).catch(function(err) {
      console.error('[ErrorSim] cannot open picker — catalog unavailable:', err);
      if (window.toast) window.toast('Error simulator catalog unavailable', 'error');
    });
  }

  /**
   * Live update: if the picker is open and the user changes their canvas
   * selection (shift-click etc), reflect the new targets without reopening.
   */
  updateSelectionFromCanvas(nodeIds) {
    if (!this._pickerEl) return;
    if (!nodeIds || !nodeIds.length) return;
    var targets = [];
    for (var i = 0; i < nodeIds.length; i++) {
      var meta = this._lookupNodeMeta(nodeIds[i]);
      if (meta) targets.push(meta);
    }
    if (!targets.length) return;
    this._pickerTargets = targets;
    this._renderPickerHeader();
    // Re-rank entries — node-kind filter may have shifted
    this._renderEntries();
  }

  /** Returns the inline ⚡-stack HTML if the node has any injection (else ''). */
  getNodeBadge(nodeId) {
    if (!this.hasInjection(nodeId)) return '';
    var rules = this._nodeIndex.get(nodeId) || [];
    return this._buildBadgeHtml(rules);
  }

  hasInjection(nodeId) {
    var rules = this._nodeIndex.get(nodeId);
    return !!(rules && rules.length);
  }

  rulesForNode(nodeId) {
    return (this._nodeIndex.get(nodeId) || []).slice();
  }

  /** Slide in the blast-radius drawer for a given rule. */
  async showBlastRadius(ruleId) {
    if (!this._signalR || !this._signalR.connection) return;
    try {
      var json = await this._signalR.connection.invoke('ErrorSimGetBlastRadius', ruleId);
      var data = typeof json === 'string' ? JSON.parse(json) : json;
      if (data && data.error) {
        console.warn('[ErrorSim] blast radius error:', data.error);
        return;
      }
      this._renderBlastRadius(data);
    } catch (err) {
      console.error('[ErrorSim] blast radius failed:', err);
    }
  }

  /* ───────────────────────── Catalog & rules I/O ───────────────────────── */

  async _loadCatalog() {
    if (this._catalog) return this._catalog;

    if (typeof ERROR_SIM_CATALOG !== 'undefined' && Array.isArray(ERROR_SIM_CATALOG) && ERROR_SIM_CATALOG.length > 0) {
      this._catalog = ERROR_SIM_CATALOG;
      this._catalogByCode.clear();
      for (var i = 0; i < this._catalog.length; i++) {
        this._catalogByCode.set(this._catalog[i].code, this._catalog[i]);
      }
      return this._catalog;
    }

    if (!this._signalR || !this._signalR.connection) {
      throw new Error('No catalog available — ERROR_SIM_CATALOG not loaded and SignalR not connected');
    }
    if (this._loadPromise) return this._loadPromise;
    var self = this;
    this._loadPromise = (async function() {
      var json = await self._signalR.connection.invoke('ErrorSimGetCatalog');
      var entries = typeof json === 'string' ? JSON.parse(json) : json;
      self._catalog = Array.isArray(entries) ? entries : [];
      self._catalogByCode.clear();
      for (var i = 0; i < self._catalog.length; i++) {
        self._catalogByCode.set(self._catalog[i].code, self._catalog[i]);
      }
      return self._catalog;
    })();
    try {
      return await this._loadPromise;
    } finally {
      this._loadPromise = null;
    }
  }

  async _refreshActiveRules() {
    if (!this._signalR || !this._signalR.connection) return;
    try {
      var json = await this._signalR.connection.invoke('ErrorSimGetActiveRules');
      var rules = typeof json === 'string' ? JSON.parse(json) : json;
      this._activeRules.clear();
      this._nodeIndex.clear();
      if (Array.isArray(rules)) {
        for (var i = 0; i < rules.length; i++) this._indexRule(rules[i]);
      }
      this._renderActiveRulesPanel();
      this._refreshNodeBadges();
    } catch (err) {
      // Silent — server may not have hub methods registered yet
    }
  }

  async _addRule(nodeId, nodeName, nodeKind, errorCode, opts) {
    if (!this._signalR || !this._signalR.connection) return null;
    opts = opts || {};
    try {
      var json = await this._signalR.connection.invoke(
        'ErrorSimAddRule', nodeId, nodeName, nodeKind, errorCode);
      var rule = typeof json === 'string' ? JSON.parse(json) : json;
      if (!rule || rule.error) {
        var msg = rule && rule.error ? rule.error.message : 'Unknown error';
        if (!opts.silent && window.toast) window.toast('Inject failed: ' + msg, 'error');
        return null;
      }
      this._indexRule(rule);
      this._renderActiveRulesPanel();
      if (!opts.skipBadgeRefresh) this._refreshNodeBadges({ pulseFor: nodeId });
      if (!opts.silent && window.toast) {
        window.toast('Injected ' + errorCode + ' on ' + (nodeName || nodeId), 'success');
      }
      return rule;
    } catch (err) {
      console.error('[ErrorSim] add rule failed:', err);
      if (!opts.silent && window.toast) window.toast('Inject failed: ' + (err && err.message || err), 'error');
      return null;
    }
  }

  async _addRulesBulk(targets, errorCode) {
    if (!targets || !targets.length) return;
    var results = await Promise.all(targets.map((t) =>
      this._addRule(t.id, t.name, t.kind, errorCode, { silent: true, skipBadgeRefresh: true })
    ));
    var ok = 0, fail = 0;
    var pulseIds = new Set();
    for (var i = 0; i < results.length; i++) {
      if (results[i]) { ok++; pulseIds.add(targets[i].id); }
      else fail++;
    }
    this._refreshNodeBadges({ pulseFor: pulseIds });
    if (window.toast) {
      if (fail === 0) {
        window.toast('Injected ' + errorCode + ' on ' + ok + ' node' + (ok === 1 ? '' : 's'), 'success');
      } else if (ok === 0) {
        window.toast('All ' + fail + ' injections failed', 'error');
      } else {
        window.toast('Injected on ' + ok + ' nodes (' + fail + ' failed)', 'warning');
      }
    }
  }

  async _removeRule(ruleId) {
    if (!this._signalR || !this._signalR.connection) return;
    try {
      await this._signalR.connection.invoke('ErrorSimRemoveRule', ruleId);
      this._unindexRule(ruleId);
      this._renderActiveRulesPanel();
      this._refreshNodeBadges();
    } catch (err) {
      console.error('[ErrorSim] remove failed:', err);
    }
  }

  async _clearAll() {
    if (!this._signalR || !this._signalR.connection) return;
    try {
      await this._signalR.connection.invoke('ErrorSimClearAll');
      this._activeRules.clear();
      this._nodeIndex.clear();
      this._renderActiveRulesPanel();
      this._refreshNodeBadges();
    } catch (err) {
      console.error('[ErrorSim] clearAll failed:', err);
    }
  }

  _indexRule(rule) {
    if (!rule || !rule.ruleId) return;
    this._activeRules.set(rule.ruleId, rule);
    var list = this._nodeIndex.get(rule.nodeId);
    if (!list) { list = []; this._nodeIndex.set(rule.nodeId, list); }
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].ruleId === rule.ruleId) { list[i] = rule; return; }
    }
    list.push(rule);
  }

  _unindexRule(ruleId) {
    var rule = this._activeRules.get(ruleId);
    if (!rule) return;
    this._activeRules.delete(ruleId);
    var list = this._nodeIndex.get(rule.nodeId);
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i].ruleId === ruleId) { list.splice(i, 1); break; }
    }
    if (list.length === 0) this._nodeIndex.delete(rule.nodeId);
  }

  /* ───────────────────────── Picker (side panel) ───────────────────────── */

  _renderPicker() {
    this._teardownPicker();
    var self = this;

    var panel = document.createElement('div');
    panel.className = 'esim-picker-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Simulate error on node');
    this._pickerEl = panel;

    panel.innerHTML =
      '<div class="esim-picker-header" id="esimPickerHeader"></div>' +
      '<div class="esim-search-wrap">' +
        '<span class="esim-search-icon" aria-hidden="true">' +
          '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">' +
            '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>' +
          '</svg>' +
        '</span>' +
        '<input type="text" class="esim-search" id="esimSearch" ' +
          'placeholder="Fuzzy search — try \u201cauth\u201d, \u201cthrottle\u201d, \u201cschema\u201d\u2026" autocomplete="off" spellcheck="false">' +
        '<kbd class="esim-search-kbd" aria-hidden="true">Esc</kbd>' +
      '</div>' +
      '<div class="esim-entries-wrap" id="esimCategories"></div>' +
      '<div class="esim-picker-footer">' +
        '<div class="esim-selected-hint" id="esimSelectedHint">Select an error code to simulate</div>' +
        '<div class="esim-footer-actions">' +
          '<button class="esim-btn esim-btn-ghost" id="esimCancelBtn">Cancel</button>' +
          '<button class="esim-btn esim-btn-primary" id="esimSimulateBtn" disabled>' +
            '<span id="esimSimulateLabel">Simulate</span> <span class="esim-bolt">\u26A1</span>' +
          '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(panel);
    // Force reflow so the slide-in transition fires
    void panel.offsetWidth;
    panel.classList.add('open');

    this._renderPickerHeader();

    var search = document.getElementById('esimSearch');
    search.addEventListener('input', function() {
      window.clearTimeout(self._searchDebounce);
      self._searchDebounce = window.setTimeout(function() {
        self._pickerFilter = search.value.trim().toLowerCase();
        self._renderEntries();
      }, 120);
    });

    document.addEventListener('keydown', this._onKeyDown);
    document.getElementById('esimCancelBtn').addEventListener('click', function() { self._teardownPicker(); });
    document.getElementById('esimSimulateBtn').addEventListener('click', function() { self._commitSelection(); });

    this._renderEntries();
    setTimeout(function() { search.focus(); }, 30);
  }

  /** Render just the header chips (called on selection updates without re-rendering the body). */
  _renderPickerHeader() {
    var header = document.getElementById('esimPickerHeader');
    if (!header) return;
    var targets = this._pickerTargets;
    var n = targets.length;
    var titleHtml;
    if (n === 1) {
      titleHtml =
        '<div class="esim-picker-title">Simulate Error on ' +
          '<span class="esim-node-ref">' + this._escape(targets[0].name) + '</span>' +
        '</div>';
    } else {
      var chips = '';
      var visible = Math.min(n, 3);
      for (var i = 0; i < visible; i++) {
        chips += '<span class="esim-node-ref">' + this._escape(targets[i].name) + '</span>';
      }
      if (n > visible) chips += '<span class="esim-node-ref esim-node-ref-more">+' + (n - visible) + '</span>';
      titleHtml =
        '<div class="esim-picker-title">' +
          '<span class="esim-multi-count">' + n + '</span> nodes selected' +
        '</div>' +
        '<div class="esim-target-chips">' + chips + '</div>';
    }
    header.innerHTML =
      '<div class="esim-picker-title-wrap">' + titleHtml + '</div>' +
      '<button class="esim-close-btn" id="esimCloseBtn" title="Close" aria-label="Close">\u2715</button>';
    var closeBtn = document.getElementById('esimCloseBtn');
    var self = this;
    if (closeBtn) closeBtn.addEventListener('click', function() { self._teardownPicker(); });
    // Update simulate-button label
    var label = document.getElementById('esimSimulateLabel');
    if (label) label.textContent = n > 1 ? ('Simulate on ' + n) : 'Simulate';
  }

  _teardownPicker() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this._pickerEl && this._pickerEl.parentNode) {
      this._pickerEl.parentNode.removeChild(this._pickerEl);
    }
    this._pickerEl = null;
    this._pickerSelectedCode = null;
    this._pickerTargets = [];
  }

  _onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._teardownPicker();
    } else if (e.key === 'Enter') {
      if (this._pickerSelectedCode) {
        e.preventDefault();
        this._commitSelection();
      }
    }
  }

  /* ───────────────────────── Fuzzy search ───────────────────────── */

  /**
   * Score how well `query` matches `text`. Higher = better. 0 = no match.
   * Bonuses: prefix start, word-boundary hit, consecutive char run.
   */
  _fuzzyScore(query, text) {
    if (!query) return 1;
    text = String(text || '').toLowerCase();
    query = String(query).toLowerCase();
    var qi = 0, ti = 0, score = 0, consecutive = 0, prevWasBoundary = true;
    while (qi < query.length && ti < text.length) {
      var qc = query[qi];
      var tc = text[ti];
      if (qc === tc) {
        var bonus = 1;
        if (consecutive > 0) bonus += consecutive * 2;
        if (prevWasBoundary) bonus += 3;
        if (ti === 0) bonus += 5;
        score += bonus;
        qi++;
        consecutive++;
      } else {
        consecutive = 0;
        score -= 0.4;
      }
      prevWasBoundary = !/[a-z0-9]/.test(tc);
      ti++;
    }
    return qi === query.length ? Math.max(score, 0.1) : 0;
  }

  /** Best fuzzy score across the haystack tokens (code, description, phase, category). */
  _bestScore(query, entry) {
    var haystacks = [
      entry.code || '',
      (entry.code || '').replace(/^MLV_/, ''),
      entry.description || '',
      entry.phase || '',
      entry.category || ''
    ];
    var best = 0;
    for (var i = 0; i < haystacks.length; i++) {
      var s = this._fuzzyScore(query, haystacks[i]);
      if (s > best) best = s;
    }
    return best;
  }

  /** Expand a query through ESIM_SYNONYMS if the user typed an intent word. */
  _expandQuery(query) {
    if (!query) return [''];
    var alts = [query];
    var key = query.toLowerCase();
    // Look for synonym keys that the query starts with (so "throt" still hits "throttle")
    Object.keys(ESIM_SYNONYMS).forEach(function(k) {
      if (key.indexOf(k) === 0 || k.indexOf(key) === 0) {
        var terms = ESIM_SYNONYMS[k];
        for (var i = 0; i < terms.length; i++) {
          if (alts.indexOf(terms[i]) === -1) alts.push(terms[i]);
        }
      }
    });
    return alts;
  }

  /* ───────────────────────── Categorize + render ───────────────────────── */

  _categorize() {
    var groups = [
      { id: 'throttling', label: 'Throttling & Capacity',  cats: ['throttling'] },
      { id: 'auth',       label: 'Auth & Access',          cats: ['auth'] },
      { id: 'execution',  label: 'Execution',              cats: ['execution'] },
      { id: 'resource',   label: 'Resource / Not Found',   cats: ['resource'] },
      { id: 'validation', label: 'Validation & Schema',    cats: ['validation', 'schema'] },
      { id: 'constraint', label: 'Constraint & DQ',        cats: ['constraint', 'dq'] },
      { id: 'dag',        label: 'DAG Construction',       cats: ['dag'] },
      { id: 'concurrency',label: 'Concurrency',            cats: ['concurrency'] },
      { id: 'ingest',     label: 'Ingest',                 cats: ['ingest'] },
      { id: 'pyspark',    label: 'PySpark',                cats: ['pyspark'] },
      { id: 'system',     label: 'System',                 cats: ['system'] },
    ];
    var byId = {};
    for (var i = 0; i < groups.length; i++) {
      byId[groups[i].id] = { meta: groups[i], entries: [] };
      for (var j = 0; j < groups[i].cats.length; j++) byId[groups[i].cats[j]] = byId[groups[i].id];
    }
    // node-kind filter: when multi-targeting, an entry must be compatible with at least one selected kind
    var allowedKinds = this._allowedNodeKindsForTargets();
    var seen = {};
    for (var k = 0; k < (this._catalog || []).length; k++) {
      var e = this._catalog[k];
      if (!e || !e.code) continue;
      if (allowedKinds && e.nodeKinds && e.nodeKinds.length) {
        var ok = false;
        for (var m = 0; m < e.nodeKinds.length; m++) {
          var nk = (e.nodeKinds[m] || '').toLowerCase();
          if (allowedKinds.has(nk)) { ok = true; break; }
        }
        if (!ok) continue;
      }
      var bucket = byId[(e.category || '').toLowerCase()];
      if (!bucket) {
        if (!byId.__other) {
          var other = { meta: { id: '__other', label: 'Other' }, entries: [] };
          byId.__other = other;
          groups.push(other.meta);
        }
        bucket = byId.__other;
      }
      if (!seen[e.code]) { bucket.entries.push(e); seen[e.code] = true; }
    }
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var b = byId[groups[g].id];
      if (!b || !b.entries.length) continue;
      b.entries.sort(function(a, c) { return (a.code || '').localeCompare(c.code || ''); });
      out.push(b);
    }
    return out;
  }

  /** When picker has multiple targets, allowed kinds = union of each target's kind. 'unknown' = no filter. */
  _allowedNodeKindsForTargets() {
    var targets = this._pickerTargets;
    if (!targets || !targets.length) return null;
    var anyUnknown = false;
    var set = new Set();
    for (var i = 0; i < targets.length; i++) {
      var k = (targets[i].kind || 'unknown').toLowerCase();
      if (k === 'unknown') { anyUnknown = true; break; }
      set.add(k);
    }
    return anyUnknown ? null : set;
  }

  /** Flat ranked list for fuzzy search mode. */
  _rankedEntries(query) {
    var allowedKinds = this._allowedNodeKindsForTargets();
    var alts = this._expandQuery(query);
    var rows = [];
    var seen = {};
    var catalog = this._catalog || [];
    for (var i = 0; i < catalog.length; i++) {
      var e = catalog[i];
      if (!e || !e.code || seen[e.code]) continue;
      if (allowedKinds && e.nodeKinds && e.nodeKinds.length) {
        var ok = false;
        for (var m = 0; m < e.nodeKinds.length; m++) {
          if (allowedKinds.has((e.nodeKinds[m] || '').toLowerCase())) { ok = true; break; }
        }
        if (!ok) continue;
      }
      var best = 0;
      for (var a = 0; a < alts.length; a++) {
        var s = this._bestScore(alts[a], e);
        if (s > best) best = s;
      }
      if (best > 0) { rows.push({ entry: e, score: best }); seen[e.code] = true; }
    }
    rows.sort(function(x, y) { return y.score - x.score; });
    return rows.slice(0, 40).map(function(r) { return r.entry; });
  }

  _renderEntries() {
    var container = document.getElementById('esimCategories');
    if (!container) return;
    var html = '';

    // Recents strip — only shown when not searching
    if (!this._pickerFilter && this._recents.length) {
      var recentEntries = this._recents
        .map((c) => this._catalogByCode.get(c))
        .filter(function(e) { return !!e; });
      if (recentEntries.length) {
        html += '<div class="esim-recents-strip" aria-label="Recently used">' +
          '<div class="esim-recents-label">RECENT</div>' +
          '<div class="esim-recents-row">';
        for (var ri = 0; ri < recentEntries.length; ri++) {
          var re = recentEntries[ri];
          html += '<button class="esim-recent-chip" data-code="' + this._escape(re.code) + '" title="' +
            this._escape(re.description || '') + '">' +
            this._escape(re.code) + '</button>';
        }
        html += '</div></div>';
      }
    }

    if (this._pickerFilter) {
      // Fuzzy mode — flat ranked list
      var ranked = this._rankedEntries(this._pickerFilter);
      if (ranked.length === 0) {
        html += '<div class="esim-empty">No matches for \u201c' + this._escape(this._pickerFilter) + '\u201d</div>';
      } else {
        html += '<div class="esim-ranked-header">' +
          '<span class="esim-ranked-label">BEST MATCHES</span>' +
          '<span class="esim-ranked-count">' + ranked.length + '</span>' +
        '</div>';
        html += '<div class="esim-entries">';
        for (var r = 0; r < ranked.length; r++) html += this._renderEntry(ranked[r]);
        html += '</div>';
      }
    } else {
      // Browse mode — categorized accordions
      var groups = this._categorize();
      if (groups.length === 0) {
        html += '<div class="esim-empty">No error codes for these node kinds.</div>';
      } else {
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          var open = i === 0 ? ' open' : '';
          html += '<details class="esim-category"' + open + ' data-group="' + this._escape(g.meta.id) + '">' +
            '<summary class="esim-category-summary">' +
              '<span class="esim-cat-chevron" aria-hidden="true">\u25B8</span>' +
              '<span class="esim-cat-label">' + this._escape(g.meta.label) + '</span>' +
              '<span class="esim-cat-count">' + g.entries.length + '</span>' +
            '</summary>' +
            '<div class="esim-entries">';
          for (var j = 0; j < g.entries.length; j++) {
            html += this._renderEntry(g.entries[j]);
          }
          html += '</div></details>';
        }
      }
    }
    container.innerHTML = html;

    var self = this;
    var entries = container.querySelectorAll('.esim-entry');
    for (var k = 0; k < entries.length; k++) {
      entries[k].addEventListener('click', (function(el) {
        return function() { self._selectEntry(el.getAttribute('data-code')); };
      })(entries[k]));
      entries[k].addEventListener('dblclick', function() {
        if (self._pickerSelectedCode) self._commitSelection();
      });
    }
    var chips = container.querySelectorAll('.esim-recent-chip');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', (function(chip) {
        return function() { self._selectEntry(chip.getAttribute('data-code')); };
      })(chips[c]));
    }
  }

  _renderEntry(e) {
    var severity = (e.errorSource || '').toLowerCase() === 'system' ? 'system' : 'user';
    var sevClass = severity === 'system' ? 'esim-severity-system' : 'esim-severity-user';
    var isStarred = this._recents.indexOf(e.code) !== -1 ? ' esim-entry-recent' : '';
    return '<div class="esim-entry' + isStarred + '" data-code="' + this._escape(e.code) + '" tabindex="0">' +
      '<span class="esim-dot ' + sevClass + '" aria-hidden="true">\u25CF</span>' +
      '<div class="esim-entry-text">' +
        '<div class="esim-entry-code">' + this._escape(e.code) + '</div>' +
        '<div class="esim-entry-desc">' + this._escape(e.description || '') + '</div>' +
      '</div>' +
      '<span class="esim-phase-badge">' + this._escape(e.phase || '') + '</span>' +
    '</div>';
  }

  _selectEntry(code) {
    if (!this._pickerEl) return;
    this._pickerSelectedCode = code;
    var entries = this._pickerEl.querySelectorAll('.esim-entry');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].getAttribute('data-code') === code) entries[i].classList.add('selected');
      else entries[i].classList.remove('selected');
    }
    var btn = document.getElementById('esimSimulateBtn');
    if (btn) btn.disabled = false;
    var hint = document.getElementById('esimSelectedHint');
    if (hint) {
      var entry = this._catalogByCode.get(code);
      hint.innerHTML = '<span class="esim-mono">' + this._escape(code) + '</span>' +
        (entry && entry.description ? ' <span class="esim-hint-desc">— ' + this._escape(entry.description) + '</span>' : '');
    }
  }

  _commitSelection() {
    if (!this._pickerSelectedCode) return;
    var targets = this._pickerTargets.slice();
    var code = this._pickerSelectedCode;
    this._pushRecent(code);
    this._teardownPicker();
    if (targets.length <= 1) {
      var t = targets[0];
      if (t) this._addRule(t.id, t.name, t.kind, code);
    } else {
      this._addRulesBulk(targets, code);
    }
  }

  /* ───────────────────────── Recents (localStorage) ───────────────────────── */

  _loadRecents() {
    try {
      var raw = window.localStorage && window.localStorage.getItem('esim.recents');
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, 8) : [];
    } catch (e) { return []; }
  }

  _pushRecent(code) {
    if (!code) return;
    var existing = this._recents.indexOf(code);
    if (existing !== -1) this._recents.splice(existing, 1);
    this._recents.unshift(code);
    if (this._recents.length > 8) this._recents.length = 8;
    try {
      window.localStorage && window.localStorage.setItem('esim.recents', JSON.stringify(this._recents));
    } catch (e) { /* private mode etc — ignore */ }
  }

  /* ───────────────────────── Active rules panel ───────────────────────── */

  _ensureRulesPanel() {
    if (this._rulesPanelEl && document.body.contains(this._rulesPanelEl)) return;
    var graphPanel = document.getElementById('dagGraphPanel');
    if (!graphPanel || !graphPanel.parentNode) return;
    var panel = document.getElementById('esimRulesPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'esimRulesPanel';
      panel.className = 'esim-rules-panel';
      panel.style.display = 'none';
      graphPanel.parentNode.insertBefore(panel, graphPanel.nextSibling);
    }
    this._rulesPanelEl = panel;
    this._renderActiveRulesPanel();
  }

  _renderActiveRulesPanel() {
    this._ensureRulesPanel();
    var panel = this._rulesPanelEl;
    if (!panel) return;
    var rules = Array.from(this._activeRules.values());
    if (rules.length === 0) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }
    panel.style.display = '';
    rules.sort(function(a, b) {
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    var html =
      '<div class="esim-rules-header">' +
        '<button class="esim-rules-toggle" id="esimRulesToggle" aria-expanded="true" title="Collapse">' +
          '<span class="esim-rules-chevron">\u25BE</span>' +
          '<span class="esim-rules-bolt">\u26A1</span>' +
          '<span class="esim-rules-title">Active Error Injections</span>' +
          '<span class="esim-rules-count">' + rules.length + '</span>' +
        '</button>' +
        '<div class="esim-rules-actions">' +
          '<button class="esim-btn esim-btn-ghost" id="esimClearAllBtn">Clear All</button>' +
          '<button class="esim-btn esim-btn-primary" id="esimRunFaultsBtn">' +
            'Run DAG with Faults <span class="esim-run-chevron">\u25B8</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="esim-rules-body" id="esimRulesBody">' +
        '<table class="esim-rules-table">' +
          '<thead><tr>' +
            '<th>Node</th><th>Error Code</th><th>Phase</th><th>Severity</th><th aria-label="Remove"></th>' +
          '</tr></thead><tbody>';
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var sev = (r.errorSource || '').toLowerCase() === 'system' ? 'system' : 'user';
      var sevLabel = sev === 'system' ? 'System' : 'User';
      var sevClass = sev === 'system' ? 'esim-severity-system' : 'esim-severity-user';
      html +=
        '<tr data-rule="' + this._escape(r.ruleId) + '">' +
          '<td class="esim-cell-node">' + this._escape(r.nodeName || r.nodeId) + '</td>' +
          '<td class="esim-cell-code">' + this._escape(r.errorCode) + '</td>' +
          '<td><span class="esim-phase-badge">' + this._escape(r.phase || '') + '</span></td>' +
          '<td><span class="esim-dot ' + sevClass + '" aria-hidden="true">\u25CF</span> ' + sevLabel + '</td>' +
          '<td class="esim-cell-actions">' +
            '<button class="esim-row-btn" data-action="remove" data-rule="' + this._escape(r.ruleId) +
              '" title="Remove rule" aria-label="Remove rule">\u2715</button>' +
          '</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';
    panel.innerHTML = html;

    var self = this;
    var toggle = document.getElementById('esimRulesToggle');
    var body = document.getElementById('esimRulesBody');
    if (toggle && body) {
      toggle.addEventListener('click', function() {
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        toggle.querySelector('.esim-rules-chevron').textContent = open ? '\u25B8' : '\u25BE';
      });
    }
    var clearBtn = document.getElementById('esimClearAllBtn');
    if (clearBtn) clearBtn.addEventListener('click', function() { self._clearAll(); });
    var runBtn = document.getElementById('esimRunFaultsBtn');
    if (runBtn) {
      runBtn.addEventListener('click', function() {
        if (self._dagStudio && typeof self._dagStudio._runDag === 'function') {
          self._dagStudio._runDag();
        }
      });
    }
    var removeBtns = panel.querySelectorAll('button[data-action="remove"]');
    for (var k = 0; k < removeBtns.length; k++) {
      removeBtns[k].addEventListener('click', (function(btn) {
        return function(e) {
          e.stopPropagation();
          self._removeRule(btn.getAttribute('data-rule'));
        };
      })(removeBtns[k]));
    }
  }

  /* ───────────────────────── Node badge rendering (richer) ───────────────────────── */

  /** Build the badge HTML string for the given rule list. Pure — no DOM. */
  _buildBadgeHtml(rules) {
    if (!rules || !rules.length) return '';
    // Source tint: System dominates User
    var anySystem = false;
    var codes = [];
    for (var i = 0; i < rules.length; i++) {
      if ((rules[i].errorSource || '').toLowerCase() === 'system') anySystem = true;
      codes.push(rules[i].errorCode);
    }
    var tintClass = anySystem ? ' esim-badge-system' : ' esim-badge-user';
    var n = rules.length;
    var visible = Math.min(n, 3);
    var bolts = '';
    for (var b = 0; b < visible; b++) bolts += '<span class="esim-bolt-glyph">\u26A1</span>';
    var more = n > visible ? '<span class="esim-badge-more">+' + (n - visible) + '</span>' : '';
    var title = (n === 1 ? codes[0] + ' will be injected'
                          : n + ' injections: ' + codes.join(', '));
    return '<span class="esim-node-badge esim-badge-stack' + tintClass +
      '" title="' + this._escape(title) + '" data-count="' + n + '">' +
      bolts + more + '</span>';
  }

  /**
   * Re-paint badges on every DAG node. Pass {pulseFor: nodeId} to add a one-shot
   * pulse animation on the badge of a node that just received a new rule.
   */
  _refreshNodeBadges(opts) {
    opts = opts || {};
    // Normalize pulseFor into a Set for uniform membership tests.
    var pulseSet = null;
    if (opts.pulseFor) {
      if (opts.pulseFor instanceof Set) pulseSet = opts.pulseFor;
      else if (Array.isArray(opts.pulseFor)) pulseSet = new Set(opts.pulseFor);
      else pulseSet = new Set([opts.pulseFor]);
    }
    var layer = document.getElementById('dagNodesLayer');
    if (!layer) return;
    var nodes = layer.querySelectorAll('.dag-node');
    for (var i = 0; i < nodes.length; i++) {
      var nodeEl = nodes[i];
      var id = nodeEl.dataset.id;
      var header = nodeEl.querySelector('.dag-node-header');
      if (!header) continue;
      var existing = header.querySelector('.esim-node-badge');
      if (existing) existing.parentNode.removeChild(existing);
      if (!this.hasInjection(id)) continue;
      var rules = this._nodeIndex.get(id) || [];
      var nameEl = header.querySelector('.dag-node-name');
      var holder = document.createElement('span');
      holder.innerHTML = this._buildBadgeHtml(rules);
      var badge = holder.firstChild;
      if (!badge) continue;
      if (pulseSet && pulseSet.has(id)) {
        badge.classList.add('esim-badge-pulse');
        (function(b) {
          setTimeout(function() { b.classList.remove('esim-badge-pulse'); }, 1300);
        })(badge);
      }
      if (nameEl && nameEl.nextSibling) {
        header.insertBefore(badge, nameEl.nextSibling);
      } else {
        header.appendChild(badge);
      }
    }
  }

  /** Look up a node's display name + kind via the host DagStudio's model. */
  _lookupNodeMeta(nodeId) {
    if (!this._dagStudio) return null;
    if (typeof this._dagStudio._findNodeById === 'function') {
      var n = this._dagStudio._findNodeById(nodeId);
      if (!n) return null;
      return {
        id: nodeId,
        name: n.name || n.nodeId || n.id || nodeId,
        kind: (n.kind || n.type || 'unknown').toString().toLowerCase()
      };
    }
    return { id: nodeId, name: nodeId, kind: 'unknown' };
  }

  /* ───────────────────────── Blast-radius drawer ───────────────────────── */

  _renderBlastRadius(data) {
    if (!data) return;
    this._teardownDrawer();
    var drawer = document.createElement('aside');
    drawer.className = 'esim-blast-drawer';
    drawer.setAttribute('role', 'complementary');
    drawer.setAttribute('aria-label', 'Blast radius');

    var sevClass = (data.errorSource || '').toLowerCase() === 'system'
      ? 'esim-severity-system' : 'esim-severity-user';

    drawer.innerHTML =
      '<div class="esim-drawer-header">' +
        '<div class="esim-drawer-title">' +
          '<span class="esim-bolt">\u26A1</span> Blast Radius' +
        '</div>' +
        '<button class="esim-close-btn" id="esimDrawerClose" title="Close" aria-label="Close">\u2715</button>' +
      '</div>' +
      '<div class="esim-drawer-body">' +
        '<section class="esim-drawer-section">' +
          '<div class="esim-drawer-section-title">Injection Summary</div>' +
          '<dl class="esim-detail-grid">' +
            '<dt>Node</dt><dd>' + this._escape(data.nodeName || data.nodeId || '') + '</dd>' +
            '<dt>Error Code</dt><dd class="esim-mono">' + this._escape(data.errorCode || '') + '</dd>' +
            '<dt>Description</dt><dd>' + this._escape(data.description || '') + '</dd>' +
          '</dl>' +
        '</section>' +
        '<section class="esim-drawer-section">' +
          '<div class="esim-drawer-section-title">Injection Channel</div>' +
          '<dl class="esim-detail-grid">' +
            '<dt>Channel</dt><dd>' + this._escape(String(data.channel || '')) +
              ' \u2014 ' + this._escape(data.channelName || '') + '</dd>' +
          '</dl>' +
        '</section>' +
        '<section class="esim-drawer-section">' +
          '<div class="esim-drawer-section-title">FLT Code Path</div>' +
          '<div class="esim-code-path">' + this._escape(data.fltCodePath || 'n/a') + '</div>' +
        '</section>' +
        '<section class="esim-drawer-section">' +
          '<div class="esim-drawer-section-title">Error Source</div>' +
          '<div><span class="esim-dot ' + sevClass + '" aria-hidden="true">\u25CF</span> ' +
            this._escape(data.errorSource || 'Unknown') + '</div>' +
        '</section>' +
        '<section class="esim-drawer-section">' +
          '<div class="esim-drawer-section-title">Phase</div>' +
          '<div><span class="esim-phase-badge">' + this._escape(data.phase || '') + '</span></div>' +
        '</section>' +
      '</div>';

    document.body.appendChild(drawer);
    this._drawerEl = drawer;
    void drawer.offsetWidth;
    drawer.classList.add('open');

    var self = this;
    document.getElementById('esimDrawerClose').addEventListener('click', function() { self._teardownDrawer(); });
  }

  _teardownDrawer() {
    if (this._drawerEl && this._drawerEl.parentNode) {
      this._drawerEl.parentNode.removeChild(this._drawerEl);
    }
    this._drawerEl = null;
  }

  /* ───────────────────────── Helpers ───────────────────────── */

  _escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}
