/**
 * ReviewSummaryPage — Review & Confirm page (Page 4 / index 3) for the wizard.
 *
 * Two-column layout: left = text summary + validation + confirmation,
 * right = mini-DAG SVG visualization.
 * Implements page lifecycle protocol for InfraWizardDialog.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* global WizardEventBus, IW_EVENTS */

class ReviewSummaryPage {
  constructor(options) {
    var self = this;
    this._eventBus = options.eventBus;
    this._onNavigateToPage = options.onNavigateToPage || function() {};
    this._onConfirm = options.onConfirm || function() {};
    this._destroyed = false;
    this._state = null;
    this._validationResult = null;

    this._rootEl = document.createElement('div');
    // NOTE: Do NOT stamp `iw-page` here. The wizard already wraps this in a
    // `.iw-page` container (`#iw-page-3`). Adding `iw-page` to this nested
    // root inherits `opacity:0; position:absolute; pointer-events:none` from
    // the base `.iw-page` rule and never receives `.active`, leaving the
    // review page invisible. Same trap as DagCanvasPage (see wizard-dag-canvas-page.js:26).
    this._rootEl.className = 'iw-review-page';

    this._leftCol = document.createElement('div');
    this._leftCol.className = 'iw-review-left';

    this._rightCol = document.createElement('div');
    this._rightCol.className = 'iw-review-right';

    this._rootEl.appendChild(this._leftCol);
    this._rootEl.appendChild(this._rightCol);
  }

  // ── Page lifecycle ──────────────────────────────────────────────

  activate(state) {
    if (this._destroyed) return;
    this._state = state;
    this._validationResult = this._runValidation(state);
    this._renderLeft(state);
    this._renderRight(state);
  }

  deactivate() {
    // Persist DOM for fast re-entry; no teardown needed
  }

  validate() {
    this._validationResult = this._runValidation(this._state);
    return this._validationResult;
  }

  collectState(state) {
    // No-op — review page is read-only
  }

  getElement() {
    return this._rootEl;
  }

  destroy() {
    this._destroyed = true;
    this._state = null;
    this._validationResult = null;
    this._leftCol.innerHTML = '';
    this._rightCol.innerHTML = '';
    if (this._rootEl.parentNode) {
      this._rootEl.parentNode.removeChild(this._rootEl);
    }
  }

  // ── Cross-step validation ──────────────────────────────────────

  _runValidation(state) {
    var errors = [];
    var warnings = [];

    if (!state) {
      errors.push('No wizard state available.');
      return { valid: false, errors: errors, warnings: warnings };
    }

    if (!state.workspaceName) {
      errors.push('Workspace name is required.');
    }

    if (!state.capacityId) {
      errors.push('No capacity selected. Go back to Setup page.');
    }

    if (!state.nodes || state.nodes.length === 0) {
      errors.push('No nodes in DAG. Go back to Build page and add at least one node.');
    }

    // Schemas referenced in nodes must be enabled
    if (state.nodes && state.schemas) {
      var enabledSchemas = {};
      var key;
      for (key in state.schemas) {
        if (state.schemas[key]) enabledSchemas[key] = true;
      }
      for (var i = 0; i < state.nodes.length; i++) {
        var nodeSchema = state.nodes[i].schema;
        if (nodeSchema && !enabledSchemas[nodeSchema]) {
          errors.push('Node "' + state.nodes[i].name + '" uses schema "' + nodeSchema + '" which is not enabled.');
        }
      }
    }

    if (state.nodes && state.nodes.length > 50) {
      warnings.push('High node count (' + state.nodes.length + '). Execution may take longer.');
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
        warnings.push(orphanCount + ' node(s) have no connections.');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings
    };
  }

  // ── Left column rendering ──────────────────────────────────────

  _renderLeft(state) {
    var html = '';

    // Section 1: Infrastructure
    html += '<div class="iw-review-section">';
    html += '<div class="iw-review-section-header">';
    html += '<span class="iw-review-section-title">Infrastructure</span>';
    html += '<button class="iw-review-edit-link" data-page="0">Edit</button>';
    html += '</div>';
    html += this._renderRow('Workspace', state.workspaceName || '\u2014');
    html += this._renderRow('Capacity', (state.capacityDisplayName || '\u2014') + (state.capacitySku ? ' (' + state.capacitySku + ')' : ''));
    html += this._renderRow('Region', state.capacityRegion || '\u2014');
    html += this._renderRow('Lakehouse', state.lakehouseName || '\u2014');
    html += this._renderRow('Notebook', state.notebookName || '\u2014');
    html += '</div>';

    // Section 2: Configuration
    html += '<div class="iw-review-section">';
    html += '<div class="iw-review-section-header">';
    html += '<span class="iw-review-section-title">Configuration</span>';
    html += '<button class="iw-review-edit-link" data-page="1">Edit</button>';
    html += '</div>';
    html += this._renderRow('Theme', state.theme || '\u2014');
    var schemaChips = '';
    if (state.schemas) {
      var sKey;
      for (sKey in state.schemas) {
        if (state.schemas[sKey]) {
          schemaChips += '<span class="iw-review-chip">' + sKey + '</span>';
        }
      }
    }
    html += this._renderRow('Schemas', schemaChips || '\u2014');
    html += '</div>';

    // Section 3: DAG Topology
    var nodeCount = (state.nodes && state.nodes.length) || 0;
    var connCount = (state.connections && state.connections.length) || 0;
    html += '<div class="iw-review-section">';
    html += '<div class="iw-review-section-header">';
    html += '<span class="iw-review-section-title">DAG Topology</span>';
    html += '<button class="iw-review-edit-link" data-page="2">Edit</button>';
    html += '</div>';
    html += this._renderRow('Nodes', String(nodeCount));
    html += this._renderRow('Connections', String(connCount));
    if (state.nodes && state.nodes.length > 0) {
      var typeCounts = {};
      for (var i = 0; i < state.nodes.length; i++) {
        var t = state.nodes[i].type || 'unknown';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
      var breakdown = '';
      var typeKey;
      for (typeKey in typeCounts) {
        breakdown += '<span class="iw-review-chip">' + typeKey + ' (' + typeCounts[typeKey] + ')</span>';
      }
      html += this._renderRow('Types', breakdown);
    }
    html += '</div>';

    // Section 4: Validation results
    html += '<div class="iw-review-validation">';
    if (this._validationResult.errors.length > 0) {
      for (var e = 0; e < this._validationResult.errors.length; e++) {
        html += '<div class="iw-review-error">\u2716 ' + this._validationResult.errors[e] + '</div>';
      }
    }
    if (this._validationResult.warnings.length > 0) {
      for (var w = 0; w < this._validationResult.warnings.length; w++) {
        html += '<div class="iw-review-warning">\u26A0 ' + this._validationResult.warnings[w] + '</div>';
      }
    }
    if (this._validationResult.errors.length === 0 && this._validationResult.warnings.length === 0) {
      html += '<div class="iw-review-success">\u25CF All checks passed</div>';
    }
    html += '</div>';

    // Section 5: Resource summary
    html += '<div class="iw-review-resource-summary">';
    html += '<div class="iw-review-section-title">What will be created</div>';
    html += '<div class="iw-review-resource-item">1 Workspace: ' + (state.workspaceName || '') + '</div>';
    var tableCount = 0;
    var mlvCount = 0;
    if (state.nodes) {
      for (var r = 0; r < state.nodes.length; r++) {
        if (state.nodes[r].type === 'sql-table') tableCount++;
        else mlvCount++;
      }
    }
    html += '<div class="iw-review-resource-item">1 Lakehouse with ' + tableCount + ' table(s)</div>';
    html += '<div class="iw-review-resource-item">' + mlvCount + ' MLV definition(s)</div>';
    html += '<div class="iw-review-resource-item">1 Notebook with generated code</div>';
    html += '</div>';

    this._leftCol.innerHTML = html;

    // Bind edit links
    var self = this;
    var editLinks = this._leftCol.querySelectorAll('.iw-review-edit-link');
    for (var el = 0; el < editLinks.length; el++) {
      editLinks[el].addEventListener('click', function(evt) {
        var pageIndex = parseInt(evt.target.getAttribute('data-page'), 10);
        self._onNavigateToPage(pageIndex);
      });
    }
  }

  // ── Right column rendering ─────────────────────────────────────

  _renderRight(state) {
    this._renderMiniDag(state);
  }

  _renderMiniDag(state) {
    if (!state.nodes || state.nodes.length === 0) {
      this._rightCol.innerHTML = '<div class="iw-review-empty-dag">' +
        '<span class="iw-review-empty-icon">\u25C7</span>' +
        '<span class="iw-review-empty-text">No nodes defined</span>' +
        '</div>';
      return;
    }

    var nodes = state.nodes;
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
    var vbWidth = (maxX - minX) + padding * 2;
    var vbHeight = (maxY - minY) + padding * 2;

    var svg = '<svg class="iw-review-mini-dag" viewBox="0 0 ' +
      vbWidth + ' ' + vbHeight +
      '" preserveAspectRatio="xMidYMid meet">';

    // Connections (rendered behind nodes)
    var connections = state.connections || [];
    for (var c = 0; c < connections.length; c++) {
      var conn = connections[c];
      var sourceNode = null;
      var targetNode = null;
      for (var s = 0; s < nodes.length; s++) {
        if (nodes[s].id === conn.sourceNodeId) sourceNode = nodes[s];
        if (nodes[s].id === conn.targetNodeId) targetNode = nodes[s];
      }
      if (sourceNode && targetNode) {
        var sx = (sourceNode.x - minX + padding) + (sourceNode.width || 180) / 2;
        var sy = (sourceNode.y - minY + padding) + (sourceNode.height || 72);
        var tx = (targetNode.x - minX + padding) + (targetNode.width || 180) / 2;
        var ty = (targetNode.y - minY + padding);
        var midY = (sy + ty) / 2;
        svg += '<path class="iw-review-mini-edge" d="M ' + sx + ' ' + sy +
          ' C ' + sx + ' ' + midY + ', ' + tx + ' ' + midY + ', ' + tx + ' ' + ty + '" />';
      }
    }

    // Nodes
    var schemaColors = {
      dbo: '#6d5cff',
      bronze: '#cd7f32',
      silver: '#8e95a5',
      gold: '#daa520'
    };
    for (var j = 0; j < nodes.length; j++) {
      var nd = nodes[j];
      var nx = nd.x - minX + padding;
      var ny = nd.y - minY + padding;
      var ndw = nd.width || 180;
      var ndh = nd.height || 72;
      var color = schemaColors[nd.schema] || '#6d5cff';
      var label = nd.name.length > 10 ? nd.name.substring(0, 10) + '\u2026' : nd.name;

      svg += '<g class="iw-review-mini-node">';
      svg += '<rect x="' + nx + '" y="' + ny + '" width="' + ndw + '" height="' + ndh + '" rx="6" class="iw-review-mini-node-bg" />';
      svg += '<rect x="' + nx + '" y="' + ny + '" width="4" height="' + ndh + '" rx="2" fill="' + color + '" />';
      svg += '<text x="' + (nx + 14) + '" y="' + (ny + ndh / 2 + 4) + '" class="iw-review-mini-node-label">' + label + '</text>';
      svg += '</g>';
    }

    svg += '</svg>';
    this._rightCol.innerHTML = '<div class="iw-review-dag-title">DAG Topology</div>' + svg;
  }

  // ── Helpers ────────────────────────────────────────────────────

  _renderRow(label, value) {
    return '<div class="iw-review-row">' +
      '<span class="iw-review-row-label">' + label + '</span>' +
      '<span class="iw-review-row-value">' + value + '</span>' +
      '</div>';
  }
}

window.ReviewSummaryPage = ReviewSummaryPage;
