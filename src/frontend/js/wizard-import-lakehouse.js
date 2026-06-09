/**
 * ImportLakehouseDialog — F16 "Import from Lakehouse" preset.
 *
 * 3-step inline dialog rendered inside the DAG canvas container, replacing
 * the preset overlay:
 *   Step 1 — workspace + lakehouse picker
 *   Step 2 — cherry-pick table checklist (grouped by schema)
 *   Step 3 — executes the import inline (no separate UI)
 *
 * Primary data path: on-demand MWC token → getLatestDag → full DAG with
 * nodes, types, and dependency arrays. Fallback: listTables /
 * listTablesViaCapacity + per-MLV getTableMetadata.sourceEntities.
 *
 * All node and connection creation runs inside a single
 * canvas.batchOperation() so the entire import is one undo step.
 *
 * CSS prefix: .iw-import-*
 * @author Pixel — EDOG Studio hivemind
 */

/* global DagCanvas, WizardEventBus, IW_EVENTS */

var IMPORT_LH_MAX_NODES = 100;
var IMPORT_LH_DISPLAY_CAP = 200;
var IMPORT_LH_METADATA_CONCURRENCY = 5;

function _ilEsc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _ilMapNodeType(node) {
  // FLT getLatestDag emits `tableType` ("materialized_lake_view" | "managed")
  // to separate MLVs from source tables, and `kind` ("sql" | "pyspark") to
  // pick the language. Older/alternate shapes used a single `type`-style
  // string, so fall back to that for forward/backward compatibility.
  node = node || {};
  var tableType = String(node.tableType || node.TableType || '').toLowerCase();
  var kind = String(node.kind || node.Kind || '').toLowerCase();
  var legacy = String(node.type || node.Type || node.nodeType || node.NodeType || '').toLowerCase();

  var isMlv = tableType.indexOf('materialized') !== -1
    || tableType.indexOf('mlv') !== -1
    || legacy.indexOf('materialized') !== -1
    || legacy.indexOf('mlv') !== -1
    || legacy.indexOf('view') !== -1;
  if (!isMlv) return 'sql-table';

  var isPySpark = kind.indexOf('pyspark') !== -1
    || kind.indexOf('python') !== -1
    || legacy.indexOf('pyspark') !== -1;
  return isPySpark ? 'pyspark-mlv' : 'sql-mlv';
}

function _ilCleanTableName(raw) {
  var name = String(raw || '').trim();
  // Strip surrounding [brackets]
  if (name.length >= 2 && name.charAt(0) === '[' && name.charAt(name.length - 1) === ']') {
    name = name.substring(1, name.length - 1);
  }
  return name;
}

function _ilSplitSchemaQualified(raw) {
  // Returns {schema, name} — parses "schema.table" or bare "table".
  var clean = _ilCleanTableName(raw);
  var dot = clean.indexOf('.');
  if (dot > 0 && dot < clean.length - 1) {
    return { schema: clean.substring(0, dot), name: clean.substring(dot + 1) };
  }
  return { schema: null, name: clean };
}

function _ilSchemaLevel(schema) {
  var s = (schema || '').toLowerCase();
  if (s === 'gold') return 3;
  if (s === 'silver') return 2;
  if (s === 'bronze') return 1;
  return 0;
}

class ImportLakehouseDialog {
  /**
   * @param {object} options
   * @param {HTMLElement} options.containerEl  - DAG canvas container (overlay parent)
   * @param {FabricApiClient} options.apiClient
   * @param {DagCanvas} options.canvas
   * @param {WizardEventBus} options.eventBus
   * @param {object} options.schemas           - { dbo, bronze, silver, gold }
   * @param {Function} [options.onComplete]    - called with { nodeCount, connCount } on success
   * @param {Function} [options.onCancel]      - called on dismiss without import
   * @param {Function} [options.onMedallionUpgrade] - called(level) when imported schemas require a higher level
   */
  constructor(options) {
    var opts = options || {};
    this._containerEl = opts.containerEl;
    this._api = opts.apiClient;
    this._canvas = opts.canvas;
    this._eventBus = opts.eventBus;
    this._schemas = opts.schemas || { dbo: true, bronze: false, silver: false, gold: false };
    this._onComplete = opts.onComplete || function() {};
    this._onCancel = opts.onCancel || function() {};
    this._onMedallionUpgrade = opts.onMedallionUpgrade || function() {};

    this._destroyed = false;
    this._step = 1;
    this._busy = false;

    // State across steps
    this._workspaces = null;
    this._workspaceById = {};
    this._lakehouses = null;
    this._selectedWsId = null;
    this._selectedLhId = null;
    this._selectedCapId = null;
    this._tableItems = [];          // [{ name, schema, type, dependencies?, _checked }]
    this._dagPayload = null;        // raw getLatestDag response (when primary path succeeds)
    this._dagSource = null;         // 'dag' | 'tables'
    this._searchFilter = '';

    this._overlayEl = null;
    this._bodyEl = null;

    this._render();
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  show() {
    if (!this._overlayEl) return;
    this._overlayEl.classList.add('iw-import-overlay--visible');
    var firstFocus = this._overlayEl.querySelector('select, button');
    if (firstFocus) firstFocus.focus();
  }

  hide() {
    if (!this._overlayEl) return;
    this._overlayEl.classList.remove('iw-import-overlay--visible');
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
    }
    this._overlayEl = null;
    this._bodyEl = null;
    this._containerEl = null;
    this._canvas = null;
    this._api = null;
  }

  // ── Render shell ───────────────────────────────────────────────

  _render() {
    var self = this;
    var overlay = document.createElement('div');
    overlay.className = 'iw-import-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Import from Lakehouse');

    var panel = document.createElement('div');
    panel.className = 'iw-import-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'iw-import-header';
    header.innerHTML =
      '<span class="iw-import-title">Import from Lakehouse</span>'
      + '<button type="button" class="iw-import-close" aria-label="Close">\u2715</button>';
    header.querySelector('.iw-import-close').addEventListener('click', function() {
      self._cancel();
    });
    panel.appendChild(header);

    // Body (re-rendered per step)
    var body = document.createElement('div');
    body.className = 'iw-import-body';
    panel.appendChild(body);
    this._bodyEl = body;

    overlay.appendChild(panel);
    this._overlayEl = overlay;
    this._containerEl.appendChild(overlay);

    this._renderStep1();
  }

  _cancel() {
    if (this._busy) return;
    this.hide();
    this._onCancel();
  }

  // ── Step 1: Workspace + Lakehouse picker ───────────────────────

  _renderStep1() {
    var self = this;
    this._step = 1;
    var body = this._bodyEl;
    body.innerHTML = '';

    var intro = document.createElement('div');
    intro.className = 'iw-import-intro';
    intro.textContent = 'Pick a workspace and lakehouse. We will read its tables and (when available) its DAG to replicate the topology here.';
    body.appendChild(intro);

    var form = document.createElement('div');
    form.className = 'iw-import-form';

    // Workspace row
    var wsRow = document.createElement('div');
    wsRow.className = 'iw-import-row';
    wsRow.innerHTML =
      '<label class="iw-import-label" for="iw-import-ws">Workspace</label>'
      + '<select class="iw-import-select" id="iw-import-ws" disabled>'
      + '<option>Loading workspaces\u2026</option></select>';
    form.appendChild(wsRow);

    // Lakehouse row
    var lhRow = document.createElement('div');
    lhRow.className = 'iw-import-row';
    lhRow.innerHTML =
      '<label class="iw-import-label" for="iw-import-lh">Lakehouse</label>'
      + '<select class="iw-import-select" id="iw-import-lh" disabled>'
      + '<option>Select a workspace first</option></select>';
    form.appendChild(lhRow);

    body.appendChild(form);

    // Footer with Next button
    var footer = document.createElement('div');
    footer.className = 'iw-import-footer';
    footer.innerHTML =
      '<div class="iw-import-status" id="iw-import-status"></div>'
      + '<div class="iw-import-actions">'
      + '<button type="button" class="iw-import-btn iw-import-btn--ghost" id="iw-import-cancel">Cancel</button>'
      + '<button type="button" class="iw-import-btn iw-import-btn--primary" id="iw-import-next" disabled>Next \u2192</button>'
      + '</div>';
    body.appendChild(footer);

    var wsSel = body.querySelector('#iw-import-ws');
    var lhSel = body.querySelector('#iw-import-lh');
    var nextBtn = body.querySelector('#iw-import-next');
    var cancelBtn = body.querySelector('#iw-import-cancel');

    cancelBtn.addEventListener('click', function() { self._cancel(); });

    wsSel.addEventListener('change', function() {
      self._selectedWsId = wsSel.value || null;
      var ws = self._workspaceById[self._selectedWsId];
      self._selectedCapId = (ws && ws.capacityId) || null;
      self._selectedLhId = null;
      nextBtn.disabled = true;
      if (self._selectedWsId) {
        self._loadLakehouses(self._selectedWsId);
      }
    });

    lhSel.addEventListener('change', function() {
      self._selectedLhId = lhSel.value || null;
      nextBtn.disabled = !(self._selectedWsId && self._selectedLhId);
    });

    nextBtn.addEventListener('click', function() {
      if (self._selectedWsId && self._selectedLhId) {
        self._renderStep2();
      }
    });

    // Restore prior selection if user came back from step 2
    this._loadWorkspaces();
  }

  _loadWorkspaces() {
    var self = this;
    var wsSel = this._bodyEl.querySelector('#iw-import-ws');
    if (!wsSel) return;

    // Cache across calls within session
    if (this._workspaces) {
      this._populateWorkspaces(this._workspaces);
      return;
    }

    if (!this._api || typeof this._api.listWorkspaces !== 'function') {
      wsSel.innerHTML = '<option>API unavailable</option>';
      return;
    }

    this._api.listWorkspaces().then(function(resp) {
      if (self._destroyed) return;
      var list = (resp && (resp.value || resp.data || resp)) || [];
      if (!Array.isArray(list)) list = [];
      self._workspaces = list;
      self._workspaceById = {};
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id) self._workspaceById[list[i].id] = list[i];
      }
      self._populateWorkspaces(list);
    }).catch(function() {
      if (self._destroyed) return;
      wsSel.innerHTML = '<option>Failed to load workspaces</option>';
    });
  }

  _populateWorkspaces(list) {
    var wsSel = this._bodyEl.querySelector('#iw-import-ws');
    if (!wsSel) return;
    wsSel.disabled = false;
    var html = '<option value="">Select workspace\u2026</option>';
    // Sort by display name for stable UX
    var sorted = list.slice().sort(function(a, b) {
      var an = (a.displayName || a.name || '').toLowerCase();
      var bn = (b.displayName || b.name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    for (var i = 0; i < sorted.length; i++) {
      var ws = sorted[i];
      if (!ws || !ws.id) continue;
      html += '<option value="' + _ilEsc(ws.id) + '">'
        + _ilEsc(ws.displayName || ws.name || ws.id) + '</option>';
    }
    wsSel.innerHTML = html;

    if (this._selectedWsId && this._workspaceById[this._selectedWsId]) {
      wsSel.value = this._selectedWsId;
      this._loadLakehouses(this._selectedWsId);
    }
  }

  _loadLakehouses(workspaceId) {
    var self = this;
    var lhSel = this._bodyEl.querySelector('#iw-import-lh');
    if (!lhSel) return;
    lhSel.disabled = true;
    lhSel.innerHTML = '<option>Loading lakehouses\u2026</option>';

    if (!this._api || typeof this._api.listLakehouses !== 'function') {
      lhSel.innerHTML = '<option>API unavailable</option>';
      return;
    }

    this._api.listLakehouses(workspaceId).then(function(resp) {
      if (self._destroyed) return;
      var list = (resp && (resp.value || resp.data || resp)) || [];
      if (!Array.isArray(list)) list = [];
      self._lakehouses = list;
      lhSel.disabled = false;
      var html;
      if (list.length === 0) {
        html = '<option value="">No lakehouses found</option>';
      } else {
        html = '<option value="">Select lakehouse\u2026</option>';
        for (var i = 0; i < list.length; i++) {
          var lh = list[i];
          if (!lh || !lh.id) continue;
          html += '<option value="' + _ilEsc(lh.id) + '">'
            + _ilEsc(lh.displayName || lh.name || lh.id) + '</option>';
        }
      }
      lhSel.innerHTML = html;
      if (self._selectedLhId) {
        lhSel.value = self._selectedLhId;
        var nextBtn = self._bodyEl.querySelector('#iw-import-next');
        if (nextBtn) nextBtn.disabled = !self._selectedLhId;
      }
    }).catch(function() {
      if (self._destroyed) return;
      lhSel.innerHTML = '<option>Failed to load lakehouses</option>';
    });
  }

  // ── Step 2: Table checklist ────────────────────────────────────

  _renderStep2() {
    var self = this;
    this._step = 2;
    var body = this._bodyEl;
    body.innerHTML = '';

    var topBar = document.createElement('div');
    topBar.className = 'iw-import-topbar';
    topBar.innerHTML =
      '<button type="button" class="iw-import-back" id="iw-import-back">\u2190 Back</button>'
      + '<div class="iw-import-source" id="iw-import-source"></div>';
    topBar.querySelector('#iw-import-back').addEventListener('click', function() {
      if (self._busy) return;
      self._renderStep1();
    });
    body.appendChild(topBar);

    var status = document.createElement('div');
    status.className = 'iw-import-loading';
    status.innerHTML = '<span class="iw-import-spinner"></span> Loading tables\u2026';
    body.appendChild(status);

    this._loadDag(this._selectedWsId, this._selectedLhId, this._selectedCapId);
  }

  _loadDag(wsId, lhId, capId) {
    var self = this;

    var fallback = function(reason) {
      if (reason && window.edogToast) {
        window.edogToast(reason, 'info');
      }
      self._loadTablesFallback(wsId, lhId, capId);
    };

    if (!capId || !this._api || typeof this._api.getLatestDagForLakehouse !== 'function') {
      fallback(null);
      return;
    }

    this._api.getLatestDagForLakehouse(wsId, lhId, capId).then(function(dag) {
      if (self._destroyed) return;
      if (!dag) {
        fallback(null);
        return;
      }
      // Flexible parsing — matches control-panel.js conventions.
      var nodes = dag.nodes || dag.nodeDefinitions || dag.dagNodes || dag.Nodes || [];
      if (!Array.isArray(nodes) || nodes.length === 0) {
        fallback('No DAG found \u2014 importing from table catalog');
        return;
      }
      self._dagPayload = dag;
      self._dagSource = 'dag';
      self._tableItems = self._buildItemsFromDag(nodes);
      self._renderChecklist();
    }).catch(function() {
      if (self._destroyed) return;
      fallback('DAG fetch failed \u2014 importing from table catalog');
    });
  }

  _buildItemsFromDag(nodes) {
    var items = [];
    // FLT encodes the topology by node *id*: each node lists upstream `parents`
    // (and downstream `children`) as nodeIds, mirrored in the top-level `edges`
    // array. The downstream connection wiring matches by name, so resolve each
    // parent nodeId back to its node name up front.
    var idToName = {};
    for (var p = 0; p < nodes.length; p++) {
      var pn = nodes[p] || {};
      var pid = pn.nodeId || pn.nodeID || pn.id || pn.Id;
      var pname = pn.name || pn.Name || pn.nodeName || '';
      if (pid) idToName[pid] = pname;
    }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] || {};
      var rawName = n.name || n.Name || n.nodeName || '';
      var parsed = _ilSplitSchemaQualified(rawName);
      var schema = (n.schema || n.Schema || n.schemaName || parsed.schema || 'dbo');
      // Upstream deps: real contract is `parents` (nodeIds). Resolve to names;
      // fall back to legacy name-bearing fields for other DAG shapes.
      var deps = [];
      var parents = n.parents || n.Parents || [];
      if (Array.isArray(parents) && parents.length) {
        for (var pp = 0; pp < parents.length; pp++) {
          var depName = idToName[parents[pp]];
          if (depName) deps.push(depName);
        }
      } else {
        var legacy = n.dependencies || n.Dependencies || n.inputNodes || n.InputNodes || [];
        if (Array.isArray(legacy)) deps = legacy;
      }
      items.push({
        name: parsed.name,
        schema: String(schema).toLowerCase(),
        type: _ilMapNodeType(n),
        dependencies: deps,
        _checked: true
      });
    }
    return items;
  }

  _loadTablesFallback(wsId, lhId, capId) {
    var self = this;
    this._dagSource = 'tables';
    this._dagPayload = null;

    var onTables = function(tables) {
      if (self._destroyed) return;
      if (!tables || tables.length === 0) {
        self._renderEmpty('This lakehouse has no tables.');
        return;
      }
      self._tableItems = tables;
      self._renderChecklist();
    };

    var listViaCap = capId && this._api && typeof this._api.listTablesViaCapacity === 'function';
    var fetchPromise = listViaCap
      ? this._api.listTablesViaCapacity(wsId, lhId, capId).catch(function() {
          return self._api.listTables(wsId, lhId);
        })
      : this._api.listTables(wsId, lhId);

    fetchPromise.then(function(resp) {
      if (self._destroyed) return;
      var list = (resp && (resp.data || resp.value || resp.tables || resp)) || [];
      if (!Array.isArray(list)) list = [];
      var items = [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i] || {};
        var rawName = t.name || t.Name || '';
        var parsed = _ilSplitSchemaQualified(rawName);
        var schema = String(t.schemaName || t.schema || parsed.schema || 'dbo').toLowerCase();
        // Tables endpoint cannot reliably distinguish MLVs without metadata —
        // start everything as sql-table; the MLV upgrade happens during
        // import when we fetch per-table metadata.
        var hint = (t.type || t.tableType || '').toLowerCase();
        var inferredType = (hint.indexOf('view') !== -1 || hint.indexOf('mlv') !== -1)
          ? 'sql-mlv' : 'sql-table';
        items.push({
          name: parsed.name,
          schema: schema,
          type: inferredType,
          dependencies: [],
          _checked: true
        });
      }
      onTables(items);
    }).catch(function() {
      if (self._destroyed) return;
      self._renderEmpty('Failed to load tables for this lakehouse.');
    });
  }

  _renderEmpty(msg) {
    var body = this._bodyEl;
    var loading = body.querySelector('.iw-import-loading');
    if (loading) loading.remove();
    var empty = document.createElement('div');
    empty.className = 'iw-import-empty';
    empty.textContent = msg;
    body.appendChild(empty);

    var footer = document.createElement('div');
    footer.className = 'iw-import-footer';
    footer.innerHTML =
      '<div class="iw-import-status"></div>'
      + '<div class="iw-import-actions">'
      + '<button type="button" class="iw-import-btn iw-import-btn--ghost" id="iw-import-cancel">Close</button>'
      + '</div>';
    body.appendChild(footer);
    var self = this;
    footer.querySelector('#iw-import-cancel').addEventListener('click', function() {
      self._cancel();
    });
  }

  _renderChecklist() {
    var self = this;
    var body = this._bodyEl;

    // Remove loading indicator if present
    var loading = body.querySelector('.iw-import-loading');
    if (loading) loading.remove();

    // Source badge
    var sourceEl = body.querySelector('#iw-import-source');
    if (sourceEl) {
      sourceEl.textContent = this._dagSource === 'dag'
        ? 'Source: DAG (' + this._tableItems.length + ' nodes)'
        : 'Source: Catalog (' + this._tableItems.length + ' tables)';
    }

    // Existing names on canvas (for duplicate detection)
    var existing = {};
    if (this._canvas && typeof this._canvas.getNodes === 'function') {
      var nodes = this._canvas.getNodes();
      for (var i = 0; i < nodes.length; i++) {
        existing[(nodes[i].name || '').toLowerCase()] = true;
      }
    }
    var currentCount = (this._canvas && typeof this._canvas.getNodeCount === 'function')
      ? this._canvas.getNodeCount() : 0;
    var remaining = IMPORT_LH_MAX_NODES - currentCount;

    // Toolbar: search + select-all + capacity hint
    var toolbar = document.createElement('div');
    toolbar.className = 'iw-import-toolbar';
    toolbar.innerHTML =
      '<label class="iw-import-selectall">'
      + '<input type="checkbox" id="iw-import-selectall"> Select All'
      + '</label>'
      + '<input type="search" class="iw-import-search" id="iw-import-search"'
      + ' placeholder="Filter tables\u2026" aria-label="Filter tables">'
      + '<div class="iw-import-capacity">'
      + (remaining > 0 ? remaining + ' slot' + (remaining === 1 ? '' : 's') + ' free'
                       : 'Canvas full')
      + '</div>';
    body.appendChild(toolbar);

    // List
    var listEl = document.createElement('div');
    listEl.className = 'iw-import-list';
    body.appendChild(listEl);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'iw-import-footer';
    footer.innerHTML =
      '<div class="iw-import-status" id="iw-import-status"></div>'
      + '<div class="iw-import-actions">'
      + '<button type="button" class="iw-import-btn iw-import-btn--ghost" id="iw-import-cancel">Cancel</button>'
      + '<button type="button" class="iw-import-btn iw-import-btn--primary" id="iw-import-run" disabled>Import 0 selected</button>'
      + '</div>';
    body.appendChild(footer);

    var rerender = function() { self._renderList(listEl, existing, remaining); };

    body.querySelector('#iw-import-search').addEventListener('input', function(e) {
      self._searchFilter = (e.target.value || '').toLowerCase();
      rerender();
    });
    body.querySelector('#iw-import-selectall').addEventListener('change', function(e) {
      var checked = !!e.target.checked;
      // Apply only to currently visible (filtered) items, and respect capacity.
      var filtered = self._filteredItems();
      var slotsLeft = remaining;
      for (var i = 0; i < self._tableItems.length; i++) self._tableItems[i]._checked = false;
      if (checked) {
        for (var j = 0; j < filtered.length && slotsLeft > 0; j++) {
          if (existing[filtered[j].name.toLowerCase()]) continue;
          filtered[j]._checked = true;
          slotsLeft--;
        }
      }
      rerender();
    });
    body.querySelector('#iw-import-cancel').addEventListener('click', function() {
      self._cancel();
    });
    body.querySelector('#iw-import-run').addEventListener('click', function() {
      self._executeImport();
    });

    rerender();
  }

  _filteredItems() {
    if (!this._searchFilter) return this._tableItems;
    var f = this._searchFilter;
    var out = [];
    for (var i = 0; i < this._tableItems.length; i++) {
      var it = this._tableItems[i];
      var hay = (it.schema + '.' + it.name).toLowerCase();
      if (hay.indexOf(f) !== -1) out.push(it);
    }
    return out;
  }

  _renderList(listEl, existing, remaining) {
    var self = this;
    var items = this._filteredItems();
    var total = this._tableItems.length;

    // Cap the displayed rows for very large lakehouses
    var displayItems = items;
    var truncated = false;
    if (items.length > IMPORT_LH_DISPLAY_CAP) {
      displayItems = items.slice(0, IMPORT_LH_DISPLAY_CAP);
      truncated = true;
    }

    // Group by schema
    var groups = {};
    var order = [];
    for (var i = 0; i < displayItems.length; i++) {
      var sc = displayItems[i].schema || 'dbo';
      if (!groups[sc]) { groups[sc] = []; order.push(sc); }
      groups[sc].push(displayItems[i]);
    }
    order.sort(function(a, b) {
      var la = _ilSchemaLevel(a), lb = _ilSchemaLevel(b);
      if (la !== lb) return la - lb;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    var html = '';
    if (truncated) {
      html += '<div class="iw-import-trunc">Showing ' + IMPORT_LH_DISPLAY_CAP
        + ' of ' + items.length + ' \u2014 use search to narrow.</div>';
    }
    if (order.length === 0) {
      html += '<div class="iw-import-empty">No tables match your filter.</div>';
    }

    for (var gi = 0; gi < order.length; gi++) {
      var schema = order[gi];
      var rows = groups[schema];
      html += '<div class="iw-import-group">';
      html += '<div class="iw-import-group-head">Schema: ' + _ilEsc(schema)
        + ' <span class="iw-import-group-count">(' + rows.length + ')</span></div>';
      for (var ri = 0; ri < rows.length; ri++) {
        var it = rows[ri];
        var dup = !!existing[it.name.toLowerCase()];
        var disabled = dup;
        var symbol = it.type === 'sql-table' ? '\u25C7' : '\u25C6'; // ◇ table, ◆ view
        var typeLabel = it.type === 'sql-table' ? 'table'
          : (it.type === 'pyspark-mlv' ? 'pyspark-mlv' : 'sql-mlv');
        var idx = self._tableItems.indexOf(it);
        html += '<label class="iw-import-row-item' + (disabled ? ' iw-import-row-item--dup' : '') + '">';
        html += '<input type="checkbox" data-idx="' + idx + '"'
          + (it._checked && !dup ? ' checked' : '')
          + (disabled ? ' disabled' : '') + '>';
        html += '<span class="iw-import-sym">' + symbol + '</span>';
        html += '<span class="iw-import-name">' + _ilEsc(it.name) + '</span>';
        html += '<span class="iw-import-type">' + typeLabel
          + (dup ? ' \u2014 already on canvas' : '') + '</span>';
        html += '</label>';
      }
      html += '</div>';
    }
    listEl.innerHTML = html;

    // Wire checkbox handlers
    var checks = listEl.querySelectorAll('input[type="checkbox"][data-idx]');
    for (var ci = 0; ci < checks.length; ci++) {
      checks[ci].addEventListener('change', function(e) {
        var idx = parseInt(e.target.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        var item = self._tableItems[idx];
        if (!item) return;

        if (e.target.checked) {
          // Capacity guard: count currently-checked importable items
          var selected = self._countSelectedImportable(existing);
          if (selected >= remaining) {
            e.target.checked = false;
            if (window.edogToast) {
              window.edogToast('Canvas has only ' + remaining + ' slot'
                + (remaining === 1 ? '' : 's') + ' free', 'warning');
            }
            return;
          }
        }
        item._checked = e.target.checked;
        self._updateRunButton(existing, remaining);
      });
    }

    this._updateRunButton(existing, remaining);
  }

  _countSelectedImportable(existing) {
    var n = 0;
    for (var i = 0; i < this._tableItems.length; i++) {
      var it = this._tableItems[i];
      if (it._checked && !existing[it.name.toLowerCase()]) n++;
    }
    return n;
  }

  _updateRunButton(existing, remaining) {
    var btn = this._bodyEl.querySelector('#iw-import-run');
    if (!btn) return;
    var n = this._countSelectedImportable(existing);
    btn.disabled = (n === 0 || remaining <= 0);
    btn.textContent = 'Import ' + n + ' selected';

    var status = this._bodyEl.querySelector('#iw-import-status');
    if (status && remaining <= 0) {
      status.textContent = 'Canvas at capacity (' + IMPORT_LH_MAX_NODES + ' nodes).';
    } else if (status) {
      status.textContent = '';
    }
  }

  // ── Import execution ───────────────────────────────────────────

  _executeImport() {
    var self = this;
    if (this._busy) return;
    this._busy = true;

    var runBtn = this._bodyEl.querySelector('#iw-import-run');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = 'Importing\u2026';
    }

    // Build the list of items to import (skip duplicates).
    var existing = {};
    var existingByName = {};
    if (this._canvas && typeof this._canvas.getNodes === 'function') {
      var existingNodes = this._canvas.getNodes();
      for (var i = 0; i < existingNodes.length; i++) {
        var key = (existingNodes[i].name || '').toLowerCase();
        existing[key] = true;
        existingByName[key] = existingNodes[i].id;
      }
    }

    var selected = [];
    var dupCount = 0;
    for (var k = 0; k < this._tableItems.length; k++) {
      var it = this._tableItems[k];
      if (!it._checked) continue;
      var nameKey = it.name.toLowerCase();
      if (existing[nameKey]) { dupCount++; continue; }
      selected.push(it);
    }

    // Capacity clamp
    var currentCount = (this._canvas && typeof this._canvas.getNodeCount === 'function')
      ? this._canvas.getNodeCount() : 0;
    var remaining = IMPORT_LH_MAX_NODES - currentCount;
    var skippedForCap = 0;
    if (selected.length > remaining) {
      skippedForCap = selected.length - remaining;
      selected = selected.slice(0, remaining);
    }

    if (selected.length === 0) {
      if (window.edogToast) window.edogToast('Nothing new to import', 'info');
      this._busy = false;
      this._finishDialog({ nodeCount: 0, connCount: 0 });
      return;
    }

    // Auto-upgrade medallion level if imports require it.
    var maxLevel = 0;
    for (var s = 0; s < selected.length; s++) {
      var lvl = _ilSchemaLevel(selected[s].schema);
      if (lvl > maxLevel) maxLevel = lvl;
    }
    var currentLevel = (this._schemas.gold ? 3 : this._schemas.silver ? 2
      : this._schemas.bronze ? 1 : 0);
    if (maxLevel > currentLevel) {
      try { this._onMedallionUpgrade(maxLevel); } catch (e) { /* noop */ }
      // Reflect locally for this import
      this._schemas = { dbo: true, bronze: maxLevel >= 1, silver: maxLevel >= 2, gold: maxLevel >= 3 };
      if (this._canvas && this._canvas._schemas) this._canvas._schemas = this._schemas;
      if (window.edogToast && maxLevel >= 1) {
        var lvlName = maxLevel === 3 ? 'gold' : maxLevel === 2 ? 'silver' : 'bronze';
        window.edogToast('Medallion level raised to include ' + lvlName, 'info');
      }
    }

    var doImport = function() {
      var connCount = self._createNodesAndConnections(selected, existingByName);
      var nodeCount = selected.length;

      var parts = ['Imported ' + nodeCount + ' table' + (nodeCount === 1 ? '' : 's')];
      if (connCount > 0) parts.push('with ' + connCount + ' connection' + (connCount === 1 ? '' : 's'));
      if (dupCount > 0) parts.push('skipped ' + dupCount + ' duplicate' + (dupCount === 1 ? '' : 's'));
      if (skippedForCap > 0) parts.push('skipped ' + skippedForCap + ' over capacity');
      if (window.edogToast) window.edogToast(parts.join(', '), 'success');

      self._busy = false;
      self._finishDialog({ nodeCount: nodeCount, connCount: connCount });
    };

    // For the fallback path, enrich MLV connections via per-table metadata
    // (best-effort, bounded concurrency). Then run the import.
    if (this._dagSource === 'tables') {
      this._enrichDependenciesFromMetadata(selected).then(doImport).catch(doImport);
    } else {
      doImport();
    }
  }

  _enrichDependenciesFromMetadata(selected) {
    var self = this;
    var api = this._api;
    if (!api || typeof api.getTableMetadata !== 'function') return Promise.resolve();

    var queue = [];
    for (var i = 0; i < selected.length; i++) {
      // Only fetch for items that might be MLVs (cheap) — but we don't know
      // for certain in the fallback path. Probe everything; metadata returns
      // null for plain tables which is fine.
      queue.push(selected[i]);
    }

    var index = 0;
    var workers = [];
    var wsId = this._selectedWsId;
    var lhId = this._selectedLhId;

    var pump = function() {
      if (index >= queue.length) return Promise.resolve();
      var item = queue[index++];
      return api.getTableMetadata(wsId, lhId, item.schema, item.name)
        .then(function(md) {
          if (self._destroyed) return;
          if (!md) return;
          var src = md.sourceEntities || md.SourceEntities || [];
          if (src && src.length) {
            // Upgrade type to MLV
            var isPySpark = !!(md.language && String(md.language).toLowerCase().indexOf('pyspark') !== -1);
            item.type = isPySpark ? 'pyspark-mlv' : 'sql-mlv';
            item.dependencies = src;
          }
        })
        .catch(function() { /* swallow per-table errors */ })
        .then(pump);
    };

    for (var w = 0; w < IMPORT_LH_METADATA_CONCURRENCY; w++) {
      workers.push(pump());
    }
    return Promise.all(workers);
  }

  /**
   * Create nodes + connections inside a single batchOperation.
   * @returns {number} number of connections created.
   */
  _createNodesAndConnections(selected, existingByName) {
    var self = this;
    var canvas = this._canvas;
    if (!canvas || typeof canvas.batchOperation !== 'function') return 0;

    var nameToId = {};
    // Pre-seed with existing canvas nodes — so a dependency pointing at
    // an already-placed node will still wire up.
    for (var ek in existingByName) {
      if (Object.prototype.hasOwnProperty.call(existingByName, ek)) {
        nameToId[ek] = existingByName[ek];
      }
    }

    var connCount = 0;

    canvas.batchOperation(function() {
      // Pass 1 — create all nodes
      for (var i = 0; i < selected.length; i++) {
        var it = selected[i];
        var created = canvas.addNode(it.type, null, {
          name: it.name,
          schema: it.schema || 'dbo'
        });
        if (created && created.id) {
          nameToId[it.name.toLowerCase()] = created.id;
        }
      }
      // Pass 2 — wire connections from each item's dependencies array.
      for (var j = 0; j < selected.length; j++) {
        var item = selected[j];
        var tgtId = nameToId[item.name.toLowerCase()];
        if (!tgtId) continue;
        var deps = item.dependencies || [];
        for (var k = 0; k < deps.length; k++) {
          var dep = deps[k];
          var depRaw = typeof dep === 'string'
            ? dep
            : (dep && (dep.name || dep.Name || dep.tableName || ''));
          if (!depRaw) continue;
          var depParsed = _ilSplitSchemaQualified(depRaw);
          // Try both schema-prefixed and bare forms
          var keys = [depParsed.name.toLowerCase()];
          if (depParsed.schema) {
            keys.unshift((depParsed.schema + '.' + depParsed.name).toLowerCase());
          }
          var srcId = null;
          for (var kk = 0; kk < keys.length; kk++) {
            if (nameToId[keys[kk]]) { srcId = nameToId[keys[kk]]; break; }
          }
          if (srcId && srcId !== tgtId) {
            var added = canvas.addConnection(srcId, tgtId);
            if (added) connCount++;
          }
        }
      }
    });

    if (typeof canvas.autoLayout === 'function') {
      canvas.autoLayout();
    }
    return connCount;
  }

  _finishDialog(result) {
    this.hide();
    try { this._onComplete(result); } catch (e) { /* noop */ }
  }
}

window.ImportLakehouseDialog = ImportLakehouseDialog;
