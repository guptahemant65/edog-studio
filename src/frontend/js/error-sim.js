/**
 * ErrorSimulator — Error Code Simulator frontend (F-ESIM).
 *
 * Owns the entire error-injection UX inside DAG Studio:
 *   • Picker modal (right-click a node → choose an error code)
 *   • Active rules panel (rendered below the DAG graph)
 *   • Node badges (⚡ glyph on nodes with injections)
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
class ErrorSimulator {
  constructor() {
    this._catalog = null;           // ErrorCodeEntry[] from hub
    this._catalogByCode = new Map();
    this._activeRules = new Map();  // ruleId -> rule
    this._nodeIndex = new Map();    // nodeId -> [rule, ...]
    this._signalR = null;
    this._dagStudio = null;
    this._loadPromise = null;

    // DOM refs (lazily created)
    this._overlayEl = null;
    this._pickerEl = null;
    this._rulesPanelEl = null;
    this._drawerEl = null;

    // Picker state
    this._pickerNodeId = null;
    this._pickerNodeName = null;
    this._pickerNodeKind = null;
    this._pickerSelectedCode = null;
    this._pickerFilter = '';
    this._searchDebounce = 0;

    // Bind handlers
    this._onDocClick = this._onDocClick.bind(this);
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
    // Lazy-load the catalog the first time we need it
    this._loadCatalog().catch(function(err) {
      console.warn('[ErrorSim] catalog load failed:', err);
    });
    // Refresh active rules in case server already has some
    this._refreshActiveRules().catch(function() {});
    this._ensureRulesPanel();
  }

  /**
   * Open the error-code picker positioned near the click.
   * @param {string} nodeId   FLT node id
   * @param {string} nodeName Display name (used in header + rule)
   * @param {string} nodeKind 'sql' | 'pyspark' | 'ingest' | 'unknown'
   * @param {number} x        clientX from contextmenu event
   * @param {number} y        clientY from contextmenu event
   */
  showPicker(nodeId, nodeName, nodeKind, x, y) {
    var self = this;
    this._pickerNodeId = nodeId;
    this._pickerNodeName = nodeName || nodeId;
    this._pickerNodeKind = (nodeKind || 'unknown').toLowerCase();
    this._pickerSelectedCode = null;
    this._pickerFilter = '';
    // Ensure catalog is loaded
    this._loadCatalog().then(function() {
      self._renderPicker(x, y);
    }).catch(function(err) {
      console.error('[ErrorSim] cannot open picker — catalog unavailable:', err);
      if (window.toast) window.toast('Error simulator catalog unavailable', 'error');
    });
  }

  /** Returns the inline ⚡ glyph HTML if the node has any injection (else ''). */
  getNodeBadge(nodeId) {
    if (!this.hasInjection(nodeId)) return '';
    var rules = this._nodeIndex.get(nodeId) || [];
    var codes = rules.map(function(r) { return r.errorCode; }).join(', ');
    return '<span class="esim-node-badge" title="' +
      this._escape(codes + ' will be injected') + '">\u26A1</span>';
  }

  /** True if any active rule targets the given node. */
  hasInjection(nodeId) {
    var rules = this._nodeIndex.get(nodeId);
    return !!(rules && rules.length);
  }

  /** Returns the array of active rules for a node (may be empty). */
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

    // Primary: use the static embedded catalog (works in any mode — no SignalR needed)
    if (typeof ERROR_SIM_CATALOG !== 'undefined' && Array.isArray(ERROR_SIM_CATALOG) && ERROR_SIM_CATALOG.length > 0) {
      this._catalog = ERROR_SIM_CATALOG;
      this._catalogByCode.clear();
      for (var i = 0; i < this._catalog.length; i++) {
        this._catalogByCode.set(this._catalog[i].code, this._catalog[i]);
      }
      return this._catalog;
    }

    // Fallback: load from SignalR (connected phase with deployed C# code)
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

  async _addRule(nodeId, nodeName, nodeKind, errorCode) {
    if (!this._signalR || !this._signalR.connection) return null;
    try {
      var json = await this._signalR.connection.invoke(
        'ErrorSimAddRule', nodeId, nodeName, nodeKind, errorCode);
      var rule = typeof json === 'string' ? JSON.parse(json) : json;
      if (!rule || rule.error) {
        var msg = rule && rule.error ? rule.error.message : 'Unknown error';
        if (window.toast) window.toast('Inject failed: ' + msg, 'error');
        return null;
      }
      this._indexRule(rule);
      this._renderActiveRulesPanel();
      this._refreshNodeBadges();
      if (window.toast) window.toast('Injected ' + errorCode + ' on ' + (nodeName || nodeId), 'success');
      return rule;
    } catch (err) {
      console.error('[ErrorSim] add rule failed:', err);
      if (window.toast) window.toast('Inject failed: ' + (err && err.message || err), 'error');
      return null;
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
    // Replace if same code already present
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

  /* ───────────────────────── Picker modal ───────────────────────── */

  _renderPicker(x, y) {
    this._teardownPicker();
    var self = this;
    var overlay = document.createElement('div');
    overlay.className = 'esim-overlay';
    overlay.addEventListener('mousedown', function(e) {
      if (e.target === overlay) self._teardownPicker();
    });
    this._overlayEl = overlay;

    var picker = document.createElement('div');
    picker.className = 'esim-picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Simulate error on node');
    this._pickerEl = picker;

    // Position near the click (clamped to viewport)
    var w = 520, h = Math.min(window.innerHeight * 0.7, 600);
    var px = Math.max(8, Math.min(window.innerWidth - w - 8, (x || 80) + 8));
    var py = Math.max(8, Math.min(window.innerHeight - h - 8, (y || 80) + 8));
    picker.style.left = px + 'px';
    picker.style.top = py + 'px';

    picker.innerHTML =
      '<div class="esim-picker-header">' +
        '<div class="esim-picker-title">Simulate Error on ' +
          '<span class="esim-node-ref">' + this._escape(this._pickerNodeName) + '</span>' +
        '</div>' +
        '<button class="esim-close-btn" id="esimCloseBtn" title="Close" aria-label="Close">\u2715</button>' +
      '</div>' +
      '<div class="esim-search-wrap">' +
        '<span class="esim-search-icon" aria-hidden="true">' +
          '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">' +
            '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>' +
          '</svg>' +
        '</span>' +
        '<input type="text" class="esim-search" id="esimSearch" ' +
          'placeholder="Search error codes, descriptions, phases\u2026" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="esim-categories" id="esimCategories"></div>' +
      '<div class="esim-picker-footer">' +
        '<div class="esim-selected-hint" id="esimSelectedHint">Select an error code to simulate</div>' +
        '<div class="esim-footer-actions">' +
          '<button class="esim-btn esim-btn-ghost" id="esimCancelBtn">Cancel</button>' +
          '<button class="esim-btn esim-btn-primary" id="esimSimulateBtn" disabled>' +
            'Simulate <span class="esim-bolt">\u26A1</span>' +
          '</button>' +
        '</div>' +
      '</div>';

    overlay.appendChild(picker);
    document.body.appendChild(overlay);

    // Wire events
    document.getElementById('esimCloseBtn').addEventListener('click', function() { self._teardownPicker(); });
    document.getElementById('esimCancelBtn').addEventListener('click', function() { self._teardownPicker(); });
    document.getElementById('esimSimulateBtn').addEventListener('click', function() { self._commitSelection(); });

    var search = document.getElementById('esimSearch');
    search.addEventListener('input', function() {
      window.clearTimeout(self._searchDebounce);
      self._searchDebounce = window.setTimeout(function() {
        self._pickerFilter = search.value.trim().toLowerCase();
        self._renderCategories();
      }, 200);
    });

    document.addEventListener('keydown', this._onKeyDown);

    this._renderCategories();
    setTimeout(function() { search.focus(); }, 30);
  }

  _teardownPicker() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
    }
    this._overlayEl = null;
    this._pickerEl = null;
    this._pickerSelectedCode = null;
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

  _onDocClick() { /* reserved */ }

  /** Group catalog entries into display categories (label + ordered codes). */
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
    var nodeKind = this._pickerNodeKind;
    var filter = this._pickerFilter;
    var seen = {};
    for (var k = 0; k < (this._catalog || []).length; k++) {
      var e = this._catalog[k];
      if (!e || !e.code) continue;
      // Filter by node kind (skip if catalog declares incompatible kinds)
      if (e.nodeKinds && e.nodeKinds.length && nodeKind && nodeKind !== 'unknown') {
        var ok = false;
        for (var m = 0; m < e.nodeKinds.length; m++) {
          if ((e.nodeKinds[m] || '').toLowerCase() === nodeKind) { ok = true; break; }
        }
        if (!ok) continue;
      }
      // Text filter
      if (filter) {
        var hay = (e.code + ' ' + (e.description || '') + ' ' + (e.phase || '')).toLowerCase();
        if (hay.indexOf(filter) === -1) continue;
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
    // Sort each bucket by code
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var b = byId[groups[g].id];
      if (!b || !b.entries.length) continue;
      b.entries.sort(function(a, c) { return (a.code || '').localeCompare(c.code || ''); });
      out.push(b);
    }
    return out;
  }

  _renderCategories() {
    var container = document.getElementById('esimCategories');
    if (!container) return;
    var groups = this._categorize();
    if (groups.length === 0) {
      container.innerHTML = '<div class="esim-empty">No matching error codes for this node kind.</div>';
      return;
    }
    var html = '';
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
    container.innerHTML = html;

    // Wire entry clicks
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
  }

  _renderEntry(e) {
    var severity = (e.errorSource || '').toLowerCase() === 'system' ? 'system' : 'user';
    var sevClass = severity === 'system' ? 'esim-severity-system' : 'esim-severity-user';
    return '<div class="esim-entry" data-code="' + this._escape(e.code) + '" tabindex="0">' +
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
    if (hint) hint.textContent = code;
  }

  _commitSelection() {
    if (!this._pickerSelectedCode) return;
    var nodeId = this._pickerNodeId;
    var nodeName = this._pickerNodeName;
    var nodeKind = this._pickerNodeKind;
    var code = this._pickerSelectedCode;
    this._teardownPicker();
    this._addRule(nodeId, nodeName, nodeKind, code);
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
      // Insert after the graph panel (before side panel) within .dag-body
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

  /** Re-paint the ⚡ badges on DAG nodes after rules change. */
  _refreshNodeBadges() {
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
      if (this.hasInjection(id)) {
        var nameEl = header.querySelector('.dag-node-name');
        var badge = document.createElement('span');
        badge.className = 'esim-node-badge';
        var rules = this._nodeIndex.get(id) || [];
        var codes = rules.map(function(r) { return r.errorCode; }).join(', ');
        badge.title = codes + ' will be injected';
        badge.textContent = '\u26A1';
        if (nameEl && nameEl.nextSibling) {
          header.insertBefore(badge, nameEl.nextSibling);
        } else {
          header.appendChild(badge);
        }
      }
    }
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
    // Force reflow so the slide-in transition fires
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
