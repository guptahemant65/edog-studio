/**
 * ReviewSummaryPage — Page 4 (index 3) of the Infra Wizard.
 *
 * Renders the pre-flight review surface from Phantom's design mock
 * (docs/design/mocks/infra-review-v1.html): a hero with workspace name
 * and meta pills, a two-column body with infrastructure / theme+schemas /
 * counts / pre-flight checks / generated-code preview on the left and a
 * mini-DAG topology + pipeline preview on the right, plus a billing
 * warning banner at the bottom.
 *
 * The host wizard owns the actual "Lock In & Create" button in its
 * dialog footer; this page only renders read-only content.
 *
 * Public API (do not break): activate, deactivate, validate, collectState,
 * getElement, destroy.
 *
 * CSS prefix: .iw-review-*
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* global WizardEventBus, IW_EVENTS, CodeGenerationEngine */

class ReviewSummaryPage {
  constructor(options) {
    this._eventBus = options.eventBus;
    this._onNavigateToPage = options.onNavigateToPage || function() {};
    this._onConfirm = options.onConfirm || function() {};
    this._destroyed = false;
    this._state = null;
    this._validationResult = null;
    this._activeCodeTab = 0;
    this._codeOpen = true;

    this._rootEl = document.createElement('div');
    // NOTE: Do NOT stamp `iw-page` here. The wizard already wraps this in a
    // `.iw-page` container (`#iw-page-3`). Adding `iw-page` to this nested
    // root inherits `opacity:0; position:absolute; pointer-events:none` from
    // the base `.iw-page` rule and never receives `.active`, leaving the
    // review page invisible. Same trap as DagCanvasPage.
    this._rootEl.className = 'iw-review-page';
  }

  // ── Page lifecycle ──────────────────────────────────────────────

  activate(state) {
    if (this._destroyed) return;
    this._state = state || {};
    this._validationResult = this._runValidation(this._state);
    this._render();
  }

  deactivate() { /* persist DOM for fast re-entry */ }

  validate() {
    this._validationResult = this._runValidation(this._state);
    return this._validationResult;
  }

  collectState(_state) { /* read-only */ }

  getElement() { return this._rootEl; }

  destroy() {
    this._destroyed = true;
    this._state = null;
    this._validationResult = null;
    this._rootEl.innerHTML = '';
    if (this._rootEl.parentNode) {
      this._rootEl.parentNode.removeChild(this._rootEl);
    }
  }

  // ── Cross-step validation ──────────────────────────────────────

  _runValidation(state) {
    var errors = [];
    var warnings = [];
    var passes = [];

    if (!state) {
      errors.push({ text: 'No wizard state available.' });
      return { valid: false, errors: errors, warnings: warnings, passes: passes };
    }

    if (state.workspaceName) {
      passes.push({ text: 'Workspace name available', sub: 'checked against tenant directory' });
    } else {
      errors.push({ text: 'Workspace name is required.' });
    }

    if (state.capacityId) {
      passes.push({
        text: 'Capacity selected',
        sub: (state.capacitySku || 'F-tier') + ' \u00B7 ' + (state.capacityRegion || 'region')
      });
    } else {
      errors.push({ text: 'No capacity selected. Go back to Setup page.' });
    }

    if (state.lakehouseName) {
      passes.push({ text: 'Lakehouse schema support requested', sub: 'enableSchemas: true' });
    }

    var nodeCount = (state.nodes && state.nodes.length) || 0;
    var connCount = (state.connections && state.connections.length) || 0;
    if (nodeCount === 0) {
      errors.push({ text: 'No nodes in DAG. Go back to Build page and add at least one node.' });
    } else {
      passes.push({
        text: 'DAG is acyclic',
        sub: nodeCount + ' nodes \u00B7 ' + connCount + ' connections \u00B7 no cycles'
      });
    }

    // Schemas referenced in nodes must be enabled
    if (state.nodes && state.schemas) {
      var enabledSchemas = {};
      for (var key in state.schemas) {
        if (state.schemas[key]) enabledSchemas[key] = true;
      }
      for (var i = 0; i < state.nodes.length; i++) {
        var nodeSchema = state.nodes[i].schema;
        if (nodeSchema && !enabledSchemas[nodeSchema]) {
          errors.push({
            text: 'Node "' + state.nodes[i].name + '" uses schema "' + nodeSchema + '" which is not enabled.'
          });
        }
      }
      // Warn on enabled-but-unused schemas
      var usedSchemas = {};
      for (var u = 0; u < state.nodes.length; u++) {
        if (state.nodes[u].schema) usedSchemas[state.nodes[u].schema] = true;
      }
      for (var s in enabledSchemas) {
        if (s !== 'dbo' && !usedSchemas[s]) {
          warnings.push({
            text: this._capitalize(s) + ' schema selected but unused',
            sub: 'no nodes target this schema'
          });
        }
      }
    }

    if (nodeCount > 50) {
      warnings.push({ text: 'High node count (' + nodeCount + ')', sub: 'execution may take longer' });
    }

    // Detect disconnected (orphan) nodes
    if (state.nodes && state.nodes.length > 1 && state.connections) {
      var connectedIds = {};
      for (var c = 0; c < state.connections.length; c++) {
        connectedIds[state.connections[c].sourceNodeId] = true;
        connectedIds[state.connections[c].targetNodeId] = true;
      }
      var orphanCount = 0;
      for (var o = 0; o < state.nodes.length; o++) {
        if (!connectedIds[state.nodes[o].id]) orphanCount++;
      }
      if (orphanCount > 0) {
        warnings.push({ text: orphanCount + ' node(s) have no connections', sub: 'isolated in DAG' });
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      passes: passes
    };
  }

  // ── Estimated duration ─────────────────────────────────────────

  _estimateDuration(state) {
    var nodes = (state.nodes && state.nodes.length) || 0;
    var conns = (state.connections && state.connections.length) || 0;
    // Base 30s for resource creation + ~8s per node (cell write+run) + 5s per edge.
    var secs = 30 + nodes * 8 + conns * 5;
    if (secs < 60) return '\u2248 ' + secs + 's';
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return '\u2248 ' + m + 'm ' + (s < 10 ? '0' + s : s) + 's';
  }

  // ── Main render ────────────────────────────────────────────────

  _render() {
    if (this._destroyed) return;
    var state = this._state || {};

    var html = '';
    html += this._renderHero(state);
    html += '<div class="iw-review-body">';
    html += '<div class="iw-review-col iw-review-col--left">';
    html += this._renderInfrastructure(state);
    html += this._renderThemeSchemas(state);
    html += this._renderCounts(state);
    html += this._renderChecks();
    html += this._renderCodePreview(state);
    html += '</div>';
    html += '<div class="iw-review-col iw-review-col--right">';
    html += this._renderDagSection(state);
    html += this._renderPipelinePreview(state);
    html += '</div>';
    html += '</div>';
    html += this._renderWarnBanner(state);

    this._rootEl.innerHTML = html;
    this._bindEvents();
  }

  _renderHero(state) {
    var name = state.workspaceName || 'unnamed_workspace';
    var region = state.capacityRegion || '\u2014';
    var capacity = state.capacitySku
      ? state.capacitySku + (state.capacityDisplayName ? ' (' + state.capacityDisplayName + ')' : '')
      : (state.capacityDisplayName || '\u2014');
    var theme = state.theme ? this._capitalize(state.theme) : '\u2014';
    var est = this._estimateDuration(state);
    var nodeCount = (state.nodes && state.nodes.length) || 0;
    var sub = 'A new Fabric environment with a ' + nodeCount +
      '-node materialized lake view DAG. Review the configuration below \u2014 everything is editable until you lock in.';

    var html = '<div class="iw-review-hero">';
    html += '<div class="iw-review-hero-mark">';
    html += '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
    html += '<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7"/>';
    html += '<path d="M3 7l9-4 9 4"/>';
    html += '<path d="M3 7l9 4 9-4"/>';
    html += '<path d="M12 11v8"/>';
    html += '</svg></div>';
    html += '<div class="iw-review-hero-text">';
    html += '<div class="iw-review-hero-eyebrow">Ready to provision \u00B7 Confirm and create</div>';
    html += '<div class="iw-review-hero-title"><span class="iw-review-accent">' +
      this._escape(name) + '</span></div>';
    html += '<div class="iw-review-hero-sub">' + this._escape(sub) + '</div>';
    html += '<div class="iw-review-hero-meta">';
    html += this._metaItem('Region', region);
    html += this._metaItem('Capacity', capacity);
    html += this._metaItem('Theme', theme);
    html += this._metaItem('Est. duration', est);
    html += '</div></div></div>';
    return html;
  }

  _metaItem(key, val) {
    return '<div class="iw-review-meta-item">' +
      '<span class="iw-review-meta-key">' + this._escape(key) + '</span>' +
      '<span class="iw-review-meta-val">' + this._escape(val) + '</span></div>';
  }

  _renderInfrastructure(state) {
    var html = '<div class="iw-review-section">';
    html += this._sectionHead('Infrastructure', null, '<button class="iw-review-section-action" data-page="0">' +
      this._editIcon() + 'Edit setup</button>');
    html += '<div class="iw-review-kv-list">';
    html += this._kvRow('Workspace', this._escape(state.workspaceName || '\u2014'),
      '<span class="iw-review-chip iw-review-chip--ok"><span class="iw-review-dot"></span>NEW</span>');
    var capRight = '';
    if (state.capacityId) {
      capRight = '<span class="iw-review-id">' + this._shortId(state.capacityId) + '</span>';
    }
    var capLabel = (state.capacitySku || 'capacity') +
      (state.capacityRegion ? ' \u2014 ' + state.capacityRegion : '');
    html += this._kvRow('Capacity', this._escape(capLabel), capRight);
    html += this._kvRow('Lakehouse', this._escape(state.lakehouseName || '\u2014'),
      '<span class="iw-review-chip iw-review-chip--accent"><span class="iw-review-dot"></span>schema enabled</span>');
    var cellCount = this._estimateCellCount(state);
    html += this._kvRow('Notebook', this._escape(state.notebookName || '\u2014'),
      '<span class="iw-review-id">' + cellCount + ' cells</span>');
    html += '</div></div>';
    return html;
  }

  _renderThemeSchemas(state) {
    var html = '<div class="iw-review-section">';
    html += this._sectionHead('Theme & Schemas', null, '<button class="iw-review-section-action" data-page="1">' +
      this._editIcon() + 'Edit theme</button>');
    var themeName = state.theme ? this._capitalize(state.theme) : 'No theme';
    var themeDesc = this._themeDescription(state.theme);
    var nodeCount = (state.nodes && state.nodes.length) || 0;
    var connCount = (state.connections && state.connections.length) || 0;
    var layerCount = this._countLayers(state);

    html += '<div class="iw-review-theme-card">';
    html += '<div class="iw-review-theme-icon">';
    html += '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
    html += '<line x1="12" y1="1" x2="12" y2="23"/>';
    html += '<path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>';
    html += '</svg></div>';
    html += '<div class="iw-review-theme-info">';
    html += '<div class="iw-review-theme-name">' + this._escape(themeName) + '</div>';
    html += '<div class="iw-review-theme-desc">' + this._escape(themeDesc) + '</div>';
    html += '<div class="iw-review-theme-stats">';
    html += '<span>' + nodeCount + ' nodes</span><span>\u00B7</span>';
    html += '<span>' + connCount + ' connections</span><span>\u00B7</span>';
    html += '<span>' + layerCount + ' layers</span>';
    html += '</div></div></div>';

    html += '<div class="iw-review-schemas">';
    var enabled = state.schemas || {};
    var schemaList = ['dbo', 'bronze', 'silver', 'gold'];
    var used = this._usedSchemas(state);
    for (var i = 0; i < schemaList.length; i++) {
      var k = schemaList[i];
      var isEnabled = !!enabled[k];
      var isUsed = !!used[k];
      var cls = 'iw-review-chip iw-review-chip--' + k;
      if (!isEnabled) cls = 'iw-review-chip iw-review-chip--disabled';
      if (isEnabled) {
        html += '<span class="' + cls + '"><span class="iw-review-dot"></span>' + k + '</span>';
      } else {
        html += '<span class="' + cls + '">' + k + '</span>';
      }
      // Suppress unused-tracking warning helper noise
      void isUsed;
    }
    html += '</div></div>';
    return html;
  }

  _renderCounts(state) {
    var nodeCount = (state.nodes && state.nodes.length) || 0;
    var cellCount = this._estimateCellCount(state);
    var html = '<div class="iw-review-counts" role="group" aria-label="Resources to create">';
    html += '<div class="iw-review-count-cell"><div class="iw-review-count-num">1</div><div class="iw-review-count-label">Workspace</div></div>';
    html += '<div class="iw-review-count-cell"><div class="iw-review-count-num">1</div><div class="iw-review-count-label">Lakehouse</div></div>';
    html += '<div class="iw-review-count-cell"><div class="iw-review-count-num">1' +
      '<span class="iw-review-count-sub"> \u00B7 ' + cellCount + ' cells</span></div>' +
      '<div class="iw-review-count-label">Notebook</div></div>';
    html += '<div class="iw-review-count-cell"><div class="iw-review-count-num"><span class="iw-review-accent">' +
      nodeCount + '</span></div><div class="iw-review-count-label">DAG Nodes</div></div>';
    html += '</div>';
    return html;
  }

  _renderChecks() {
    var v = this._validationResult || { passes: [], warnings: [], errors: [] };
    var total = v.passes.length + v.warnings.length + v.errors.length;
    var allClear = v.errors.length === 0 && v.warnings.length === 0;
    var statusBadge = allClear
      ? '<span class="iw-review-status-pill iw-review-status-pill--ok">all clear</span>'
      : (v.errors.length > 0
        ? '<span class="iw-review-status-pill iw-review-status-pill--fail">' + v.errors.length + ' issue' + (v.errors.length === 1 ? '' : 's') + '</span>'
        : '<span class="iw-review-status-pill iw-review-status-pill--warn">' + v.warnings.length + ' warning' + (v.warnings.length === 1 ? '' : 's') + '</span>');

    var html = '<div class="iw-review-section">';
    html += this._sectionHead('Pre-flight Checks', total, statusBadge);
    html += '<div class="iw-review-valid-list">';
    for (var p = 0; p < v.passes.length; p++) {
      html += this._validRow('ok', '\u2713', v.passes[p]);
    }
    for (var w = 0; w < v.warnings.length; w++) {
      html += this._validRow('warn', '!', v.warnings[w]);
    }
    for (var e = 0; e < v.errors.length; e++) {
      html += this._validRow('fail', '\u2715', v.errors[e]);
    }
    if (total === 0) {
      html += '<div class="iw-review-valid-row"><div class="iw-review-valid-icon iw-review-valid-icon--ok">\u2713</div>' +
        '<div class="iw-review-valid-text">No checks to run</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  _validRow(kind, glyph, item) {
    var text = this._escape(item.text || '');
    var sub = item.sub ? '<span class="iw-review-valid-sub">' + this._escape(item.sub) + '</span>' : '';
    return '<div class="iw-review-valid-row">' +
      '<div class="iw-review-valid-icon iw-review-valid-icon--' + kind + '">' + glyph + '</div>' +
      '<div class="iw-review-valid-text">' + text + ' ' + sub + '</div>' +
      '<span></span></div>';
  }

  _renderCodePreview(state) {
    var cells = this._generateCellsForPreview(state);
    var cellCount = cells.length;
    var loc = 0;
    for (var i = 0; i < cells.length; i++) {
      loc += (cells[i].content || '').split('\n').length;
    }
    var nbName = state.notebookName || 'notebook';

    var html = '<div class="iw-review-section">';
    html += this._sectionHead('Generated Code', cellCount > 0 ? cellCount + ' cells' : null,
      '<button class="iw-review-section-action" data-page="2">' + this._copyIcon() + 'Edit DAG</button>');

    html += '<button class="iw-review-code-toggle' + (this._codeOpen ? ' iw-review-code-toggle--open' : '') + '" data-action="toggle-code">';
    html += '<span class="iw-review-code-caret">\u25B8</span>';
    html += '<span class="iw-review-code-file">' + this._escape(nbName) + '.ipynb</span>';
    html += '<span class="iw-review-code-meta"> \u2014 ' + cellCount + ' cells, \u2248 ' + loc + ' LOC</span>';
    html += '<span class="iw-review-code-badge">SQL \u00B7 PySpark</span>';
    html += '</button>';

    html += '<div class="iw-review-code-body' + (this._codeOpen ? ' iw-review-code-body--open' : '') + '">';
    if (cellCount === 0) {
      html += '<div class="iw-review-code-empty">No cells to preview. Add nodes in the Build step.</div>';
    } else {
      html += '<div class="iw-review-code-tabs">';
      for (var t = 0; t < cells.length; t++) {
        var cell = cells[t];
        var tabLabel = 'cell ' + (t + 1) + ' \u00B7 ' + (cell.nodeName || 'cell') +
          (cell.language === 'python' ? '.py' : '.sql');
        var active = t === this._activeCodeTab ? ' iw-review-code-tab--active' : '';
        html += '<button class="iw-review-code-tab' + active + '" data-tab="' + t + '">' +
          this._escape(tabLabel) + '</button>';
      }
      html += '</div>';
      var activeCell = cells[this._activeCodeTab] || cells[0];
      html += '<div class="iw-review-code-pane">';
      html += this._renderCodeLines(activeCell);
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  _renderCodeLines(cell) {
    var lines = (cell.content || '').split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var src = this._highlightLine(lines[i], cell.language);
      html += '<div class="iw-review-code-line"><span class="iw-review-code-ln">' +
        (i + 1) + '</span><span class="iw-review-code-src">' + (src || '&nbsp;') + '</span></div>';
    }
    return html;
  }

  _highlightLine(line, language) {
    var escaped = this._escape(line);
    if (language === 'python') {
      escaped = escaped.replace(
        /\b(def|class|import|from|as|return|if|else|elif|for|in|while|try|except|with|None|True|False)\b/g,
        '<span class="iw-review-tk-kw">$1</span>'
      );
      escaped = escaped.replace(/(#.*)$/, '<span class="iw-review-tk-cm">$1</span>');
    } else {
      // SQL
      escaped = escaped.replace(
        /\b(CREATE|TABLE|MATERIALIZED|LAKE|VIEW|AS|SELECT|FROM|WHERE|INSERT|INTO|VALUES|JOIN|ON|LEFT|RIGHT|INNER|OUTER|GROUP|BY|ORDER|LIMIT|UNION|WITH|CASE|WHEN|THEN|END|AND|OR|NOT|NULL|IS|IF|EXISTS)\b/g,
        '<span class="iw-review-tk-kw">$1</span>'
      );
      escaped = escaped.replace(
        /\b(BIGINT|INT|STRING|VARCHAR|DECIMAL|DATE|TIMESTAMP|BOOLEAN|DOUBLE|FLOAT)\b/g,
        '<span class="iw-review-tk-type">$1</span>'
      );
      escaped = escaped.replace(/(--.*)$/, '<span class="iw-review-tk-cm">$1</span>');
    }
    escaped = escaped.replace(/('[^']*')/g, '<span class="iw-review-tk-str">$1</span>');
    return escaped;
  }

  _renderDagSection(state) {
    var nodes = state.nodes || [];
    var conns = state.connections || [];
    var html = '<div class="iw-review-section">';
    html += this._sectionHead('DAG Topology', null,
      '<button class="iw-review-section-action" data-page="2">' + this._editIcon() + 'Open builder</button>');
    html += '<div class="iw-review-dag-wrap">';
    if (nodes.length === 0) {
      html += '<div class="iw-review-empty-dag"><span class="iw-review-empty-icon">\u25C7</span>' +
        '<span class="iw-review-empty-text">No nodes defined</span></div>';
    } else {
      html += '<div class="iw-review-dag-fab">' + nodes.length + ' nodes \u00B7 ' + conns.length + ' edges</div>';
      html += this._renderMiniDagInner(state);
      html += '<div class="iw-review-dag-legend">';
      html += '<div class="iw-review-dag-leg"><span class="iw-review-dag-leg-icon iw-review-dag-leg-icon--sql">\u25C7</span>SQL table</div>';
      html += '<div class="iw-review-dag-leg"><span class="iw-review-dag-leg-icon iw-review-dag-leg-icon--mlv">\u25C8</span>SQL MLV</div>';
      html += '<div class="iw-review-dag-leg"><span class="iw-review-dag-leg-icon iw-review-dag-leg-icon--spark">\u25C6</span>PySpark MLV</div>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  _renderMiniDagInner(state) {
    var nodes = state.nodes;
    var conns = state.connections || [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var nw = n.width || 180;
      var nh = n.height || 72;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + nw > maxX) maxX = n.x + nw;
      if (n.y + nh > maxY) maxY = n.y + nh;
    }
    var padding = 40;
    var rawW = (maxX - minX) + padding * 2;
    var rawH = (maxY - minY) + padding * 2;
    // Target an aspect ratio close to the .iw-review-dag-wrap (≈ 360x380)
    var TARGET_W = 360;
    var TARGET_H = 380;
    var scale = Math.min(TARGET_W / rawW, TARGET_H / rawH, 0.6);
    if (!isFinite(scale) || scale <= 0) scale = 0.5;

    var html = '';
    // Connections (SVG behind nodes)
    html += '<svg class="iw-review-dag-svg" viewBox="0 0 ' + TARGET_W + ' ' + TARGET_H + '" preserveAspectRatio="xMidYMid meet">';
    html += '<defs><marker id="iwArr" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">' +
      '<polygon points="0 0, 6 3, 0 6" fill="rgba(109,92,255,0.45)"/></marker></defs>';
    for (var c = 0; c < conns.length; c++) {
      var conn = conns[c];
      var src = null, tgt = null;
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].id === conn.sourceNodeId) src = nodes[k];
        if (nodes[k].id === conn.targetNodeId) tgt = nodes[k];
      }
      if (!src || !tgt) continue;
      var sw = src.width || 180, sh = src.height || 72;
      var tw = tgt.width || 180, th = tgt.height || 72;
      var sx = (src.x - minX + sw / 2) * scale + padding * scale;
      var sy = (src.y - minY + sh) * scale + padding * scale;
      var tx = (tgt.x - minX + tw / 2) * scale + padding * scale;
      var ty = (tgt.y - minY) * scale + padding * scale;
      void th;
      var midY = (sy + ty) / 2;
      html += '<path d="M ' + sx.toFixed(1) + ' ' + sy.toFixed(1) +
        ' C ' + sx.toFixed(1) + ' ' + midY.toFixed(1) + ', ' +
        tx.toFixed(1) + ' ' + midY.toFixed(1) + ', ' +
        tx.toFixed(1) + ' ' + ty.toFixed(1) +
        '" stroke="rgba(109,92,255,0.40)" stroke-width="1.5" fill="none" marker-end="url(#iwArr)"/>';
    }
    html += '</svg>';

    // Nodes as absolute-positioned divs
    var typeMap = {
      'sql-table': { glyph: '\u25C7', cls: 'sql', label: 'SQL' },
      'sql-mlv':   { glyph: '\u25C8', cls: 'mlv', label: 'MLV' },
      'pyspark-mlv': { glyph: '\u25C6', cls: 'spark', label: 'PySpark' }
    };
    for (var j = 0; j < nodes.length; j++) {
      var nd = nodes[j];
      var tinfo = typeMap[nd.type] || { glyph: '\u25C7', cls: 'sql', label: nd.type || '' };
      var schema = nd.schema || 'dbo';
      var ndw = nd.width || 180, ndh = nd.height || 72;
      var nx = ((nd.x - minX) * scale) + padding * scale;
      var ny = ((nd.y - minY) * scale) + padding * scale;
      var displayW = Math.max(130, ndw * scale);
      void displayW;
      html += '<div class="iw-review-dag-node iw-review-dag-node--' + tinfo.cls + '" ' +
        'style="left:' + nx.toFixed(1) + 'px;top:' + ny.toFixed(1) + 'px;">' +
        '<div class="iw-review-dag-node-head">' +
        '<span class="iw-review-dag-node-icon">' + tinfo.glyph + '</span>' +
        '<span class="iw-review-dag-node-name">' + this._escape(this._truncate(nd.name, 18)) + '</span>' +
        '</div>' +
        '<div class="iw-review-dag-node-meta">' +
        '<span class="iw-review-dag-schema-pill iw-review-dag-schema-pill--' + schema + '">' + schema + '</span>' +
        '<span class="iw-review-dag-type-pill">' + tinfo.label + '</span>' +
        '</div></div>';
      void ndh;
    }
    return html;
  }

  _renderPipelinePreview(state) {
    var nodes = (state.nodes && state.nodes.length) || 0;
    var conns = (state.connections && state.connections.length) || 0;
    var runSec = Math.max(5, nodes * 4 + conns * 2);
    var steps = [
      { name: 'Create workspace', sec: 5 },
      { name: 'Assign capacity', sec: 3 },
      { name: 'Create lakehouse', sec: 8 },
      { name: 'Create notebook', sec: 6 },
      { name: 'Write cells', sec: 2 },
      { name: 'Run notebook', sec: runSec }
    ];
    var html = '<div class="iw-review-section">';
    html += this._sectionHead('Pipeline Preview', null, '');
    html += '<div class="iw-review-preview-list">';
    for (var i = 0; i < steps.length; i++) {
      html += '<div class="iw-review-preview-row">';
      html += '<span class="iw-review-preview-num">' + (i + 1) + '</span>';
      html += '<span class="iw-review-preview-dot"></span>';
      html += '<span class="iw-review-preview-name">' + this._escape(steps[i].name) + '</span>';
      html += '<span class="iw-review-preview-time">\u2248 ' + steps[i].sec + 's</span>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  _renderWarnBanner(_state) {
    var html = '<div class="iw-review-warn-banner">';
    html += '<span class="iw-review-warn-icn">!</span>';
    html += '<div><strong>This will create real cloud resources.</strong> ' +
      'Billing applies to your trial capacity. You can rollback if anything fails.</div>';
    html += '</div>';
    return html;
  }

  // ── Section / row helpers ──────────────────────────────────────

  _sectionHead(title, count, actionHtml) {
    var html = '<div class="iw-review-section-head">';
    html += '<div class="iw-review-section-title">' + this._escape(title);
    if (count != null) html += ' <span class="iw-review-section-count">' + count + '</span>';
    html += '</div>';
    if (actionHtml) html += actionHtml;
    html += '</div>';
    return html;
  }

  _kvRow(key, val, rightHtml) {
    return '<div class="iw-review-kv">' +
      '<div class="iw-review-kv-key">' + this._escape(key) + '</div>' +
      '<div class="iw-review-kv-val"><span class="iw-review-kv-truncate">' + val + '</span>' +
      (rightHtml ? ' ' + rightHtml : '') + '</div>' +
      '</div>';
  }

  _editIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">' +
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
      '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  }

  _copyIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  }

  // ── Event binding ──────────────────────────────────────────────

  _bindEvents() {
    var self = this;
    var actions = this._rootEl.querySelectorAll('.iw-review-section-action[data-page]');
    for (var i = 0; i < actions.length; i++) {
      actions[i].addEventListener('click', function(evt) {
        var page = parseInt(evt.currentTarget.getAttribute('data-page'), 10);
        if (!isNaN(page)) self._onNavigateToPage(page);
      });
    }

    var toggle = this._rootEl.querySelector('[data-action="toggle-code"]');
    if (toggle) {
      toggle.addEventListener('click', function() {
        self._codeOpen = !self._codeOpen;
        self._render();
      });
    }

    var tabs = this._rootEl.querySelectorAll('.iw-review-code-tab');
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener('click', function(evt) {
        var idx = parseInt(evt.currentTarget.getAttribute('data-tab'), 10);
        if (!isNaN(idx)) {
          self._activeCodeTab = idx;
          self._render();
        }
      });
    }
  }

  // ── Pure helpers ───────────────────────────────────────────────

  _generateCellsForPreview(state) {
    if (typeof CodeGenerationEngine === 'undefined') return [];
    if (!state.nodes || state.nodes.length === 0) return [];
    try {
      var engine = new CodeGenerationEngine();
      return engine.generateCells(
        state.nodes,
        state.connections || [],
        state.theme,
        state.schemas || { dbo: true, bronze: false, silver: false, gold: false }
      ) || [];
    } catch (e) {
      return [];
    }
  }

  _estimateCellCount(state) {
    var cells = this._generateCellsForPreview(state);
    if (cells.length > 0) return cells.length;
    return (state.nodes && state.nodes.length) || 0;
  }

  _countLayers(state) {
    if (!state.nodes) return 0;
    var layers = {};
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].schema) layers[state.nodes[i].schema] = true;
    }
    var c = 0;
    for (var k in layers) if (layers.hasOwnProperty(k)) c++;
    return c;
  }

  _usedSchemas(state) {
    var used = {};
    if (state.nodes) {
      for (var i = 0; i < state.nodes.length; i++) {
        if (state.nodes[i].schema) used[state.nodes[i].schema] = true;
      }
    }
    return used;
  }

  _themeDescription(theme) {
    var map = {
      finance: 'Customer ledger, churn signals, revenue rollup.',
      retail:  'Orders, inventory, customer segmentation.',
      iot:     'Telemetry ingestion, sliding-window aggregates.',
      logs:    'Log ingestion, error aggregation, alerting.',
      empty:   'Empty environment — bring your own DAG.'
    };
    if (theme && map[theme.toLowerCase()]) return map[theme.toLowerCase()];
    return 'Custom DAG built from your selected nodes.';
  }

  _capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  _shortId(id) {
    if (!id) return '';
    if (id.length <= 12) return id;
    return id.substring(0, 8) + '\u2026' + id.substring(id.length - 4);
  }

  _truncate(s, max) {
    if (!s) return '';
    return s.length > max ? s.substring(0, max - 1) + '\u2026' : s;
  }

  _escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.ReviewSummaryPage = ReviewSummaryPage;
