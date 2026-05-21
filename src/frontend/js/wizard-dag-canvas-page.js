/**
 * DagCanvasPage — Composite page component for the DAG canvas (Page 3).
 *
 * Owns and orchestrates: NodePalette + DagCanvas + CodePreviewPanel + UndoRedoManager.
 * Implements the page lifecycle protocol expected by InfraWizardDialog.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* global DagCanvas, NodePalette, CodePreviewPanel, CodeGenerationEngine, WizardEventBus, UndoRedoManager, AutoLayoutEngine, DagPresets, NodePopover, IW_EVENTS */

class DagCanvasPage {
  constructor(options) {
    var self = this;
    this._eventBus = options.eventBus;
    this._schemas = options.schemas || { dbo: true, bronze: false, silver: false, gold: false };
    this._theme = options.theme || 'default';
    this._onStateChange = options.onStateChange || function() {};
    this._destroyed = false;
    this._firstActivateDone = false;

    // Root container
    this._rootEl = document.createElement('div');
    // NOTE: Do NOT use the `iw-page` class here. The outer page-2 wrapper
    // already has `.iw-page.active`, and `.iw-page` (without `.active`) sets
    // opacity:0, pointer-events:none, position:absolute, transform:translateX(60px).
    // Stamping `iw-page` on this nested root made the entire DAG page invisible
    // and shifted off-screen, even though the DOM was built correctly.
    this._rootEl.className = 'iw-dag-page';

    // Validation summary bar (top of the page; hidden until validation runs)
    this._validationBar = document.createElement('div');
    this._validationBar.className = 'iw-validation-bar iw-validation-bar--hidden';
    this._validationBar.setAttribute('role', 'status');
    this._validationBar.setAttribute('aria-live', 'polite');
    this._validationBar.style.display = 'none';

    // Sub-component containers
    this._paletteContainer = document.createElement('div');
    this._paletteContainer.className = 'iw-dag-palette-container';

    this._canvasContainer = document.createElement('div');
    this._canvasContainer.className = 'iw-dag-canvas';
    this._canvasContainer.style.flex = '1';
    this._canvasContainer.style.position = 'relative';
    this._canvasContainer.style.overflow = 'hidden';

    this._codeContainer = document.createElement('div');
    this._codeContainer.className = 'iw-dag-code-container';
    this._codeContainer.style.position = 'relative';

    this._rootEl.appendChild(this._paletteContainer);
    this._rootEl.appendChild(this._validationBar);
    this._rootEl.appendChild(this._canvasContainer);
    this._rootEl.appendChild(this._codeContainer);

    // Live region for screen reader announcements
    this._liveRegion = document.createElement('div');
    this._liveRegion.className = 'iw-sr-only';
    this._liveRegion.setAttribute('aria-live', 'polite');
    this._liveRegion.setAttribute('aria-atomic', 'true');
    this._rootEl.appendChild(this._liveRegion);

    // Shared utilities
    this._undoManager = new UndoRedoManager({ eventBus: this._eventBus });
    this._codeGen = new CodeGenerationEngine();

    // Sub-components
    this._canvas = new DagCanvas({
      containerEl: this._canvasContainer,
      eventBus: this._eventBus,
      undoManager: this._undoManager,
      schemas: this._schemas,
      liveRegion: this._liveRegion
    });

    this._palette = new NodePalette({
      containerEl: this._paletteContainer,
      eventBus: this._eventBus,
      canvas: this._canvas,
      undoManager: this._undoManager,
      schemas: this._schemas,
      onBatchExpand: function() {
        // User opted into manual batch mode — dismiss the preset overlay.
        if (self._presets && typeof self._presets._dismiss === 'function') {
          self._presets._dismiss();
        }
      }
    });

    this._codePanel = new CodePreviewPanel({
      containerEl: this._codeContainer,
      eventBus: this._eventBus,
      codeGen: this._codeGen
    });

    this._nodePopover = new NodePopover({
      containerEl: this._canvasContainer,
      canvas: this._canvas,
      eventBus: this._eventBus,
      schemas: this._schemas
    });

    // IMPORTANT: DagPresets MUST be constructed LAST so its overlay element
    // is the final child of .iw-dag-canvas. Sibling paint order (with equal
    // stacking context) follows DOM order — later siblings paint above. If
    // anything (NodePopover, toolbar, etc.) is appended after the overlay,
    // it will visually cover it even though the popover starts display:none.
    // Pairs with the defensive re-append in DagPresets._updateVisibility().
    this._presets = new DagPresets({
      containerEl: this._canvasContainer,
      dagCanvas: this._canvas,
      eventBus: this._eventBus,
      schemas: this._schemas
    });

    // Wire state-change notifications back to the wizard
    // Debounce code preview refresh (300ms after last topology change)
    this._debouncedCodeRefresh = null;
    this._debouncedValidate = null;
    if (typeof _dagDebounce === 'function') {
      this._debouncedCodeRefresh = _dagDebounce(function() {
        self._refreshCodePreview();
      }, 300);
      this._debouncedValidate = _dagDebounce(function() {
        self._runValidation();
      }, 500);
    }

    this._unsubs = [];
    this._unsubs.push(
      this._eventBus.on(IW_EVENTS.STATE_CHANGED, function() {
        self._onStateChange();
        if (self._debouncedCodeRefresh) {
          self._debouncedCodeRefresh();
        }
        if (self._debouncedValidate) {
          self._debouncedValidate();
        }
      })
    );
  }

  // ── Page Lifecycle (called by InfraWizardDialog) ──────────────

  activate(state) {
    if (this._destroyed) return;

    this._schemas = state.schemas || this._schemas;
    this._theme = state.theme || this._theme;

    // Keep presets schema-aware
    if (this._presets) {
      this._presets.updateSchemas(this._schemas);
    }

    // Keep palette batch-form schema dropdowns in sync with medallion level
    if (this._palette && typeof this._palette.updateSchemas === 'function') {
      this._palette.updateSchemas(this._schemas);
    }

    // Only restore canvas state on re-entry (when nodes already exist in state
    // from a previous visit). On first visit, state.nodes is [] and the preset
    // overlay should show — don't load empty state which would hide it.
    if (state.nodes && state.nodes.length > 0 && !this._firstActivateDone) {
      this._canvas.loadState(state);
    } else if (state.nodes && state.nodes.length > 0 && this._firstActivateDone) {
      // Re-entry: only reload if canvas is empty (user went back and forward)
      if (this._canvas.getNodeCount() === 0) {
        this._canvas.loadState(state);
      }
    }
    this._firstActivateDone = true;

    this._palette.updateNodeCount(this._canvas.getNodeCount());

    // Re-assert preset overlay visibility every time the page activates.
    // The overlay's `--visible` class is set during construction, but the
    // page is detached and hidden then — this guarantees the class is
    // present (or correctly absent) once the page is actually visible.
    if (this._presets) {
      this._presets.refreshVisibility();
    }

    // Auto-expand code panel and refresh preview when nodes exist
    if (this._canvas.getNodeCount() > 0) {
      this._codePanel.expand();
      this._refreshCodePreview();
    }
  }

  deactivate() {
    // Sub-components remain alive for fast re-entry.
    // State is collected via collectState() before navigation.
  }

  validate() {
    var result = this._runValidation();
    var messages = [];
    var i;
    for (i = 0; i < result.errors.length; i++) {
      messages.push(result.errors[i].message);
    }
    return {
      valid: result.valid,
      errors: messages,
      warnings: (function() {
        var w = [];
        for (var j = 0; j < result.warnings.length; j++) {
          w.push(result.warnings[j].message);
        }
        return w;
      })(),
      summary: result.summary,
      details: result
    };
  }

  /**
   * Cancel debounced timers (used in destroy/cleanup).
   */
  _runValidation() {
    var nodes = this._canvas ? this._canvas.getNodes() : [];
    var connections = this._canvas ? this._canvas.getConnections() : [];
    var nodeCount = nodes.length;
    var errors = [];
    var warnings = [];
    var i;

    // Build index helpers
    var outByNode = {};
    var inByNode = {};
    var nodeById = {};
    for (i = 0; i < nodes.length; i++) {
      nodeById[nodes[i].id] = nodes[i];
      outByNode[nodes[i].id] = 0;
      inByNode[nodes[i].id] = 0;
    }
    for (i = 0; i < connections.length; i++) {
      var c = connections[i];
      if (outByNode[c.sourceNodeId] !== undefined) outByNode[c.sourceNodeId]++;
      if (inByNode[c.targetNodeId] !== undefined) inByNode[c.targetNodeId]++;
    }

    // Rule: minimum node count (existing behavior)
    if (nodeCount === 0) {
      errors.push({ nodeId: null, message: 'Add at least one node to the DAG before proceeding.', severity: 'error' });
    }
    if (nodeCount > 100) {
      errors.push({ nodeId: null, message: 'Maximum 100 nodes allowed. Please remove ' + (nodeCount - 100) + ' nodes.', severity: 'error' });
    }

    // Rule 7: at least one MLV (something to materialize)
    var hasMlv = false;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].type === 'sql-mlv' || nodes[i].type === 'pyspark-mlv') {
        hasMlv = true;
        break;
      }
    }
    if (nodeCount > 0 && !hasMlv) {
      errors.push({ nodeId: null, message: 'No MLV nodes — add at least one Materialized Lake View to produce output.', severity: 'error' });
    }

    // Rule 3/4: name validation (duplicates + empty)
    var nameCounts = {};
    for (i = 0; i < nodes.length; i++) {
      var nm = (nodes[i].name || '').trim();
      if (nm === '') {
        errors.push({ nodeId: nodes[i].id, message: 'Node has an empty name.', severity: 'error' });
        continue;
      }
      var key = nm.toLowerCase();
      nameCounts[key] = (nameCounts[key] || 0) + 1;
    }
    var seenDup = {};
    for (i = 0; i < nodes.length; i++) {
      var nm2 = (nodes[i].name || '').trim();
      if (!nm2) continue;
      var k2 = nm2.toLowerCase();
      if (nameCounts[k2] > 1) {
        errors.push({ nodeId: nodes[i].id, message: 'Duplicate node name: "' + nm2 + '".', severity: 'error' });
        seenDup[k2] = true;
      }
    }

    // Rule 1 & 2: orphan source / orphan target
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var isMlv = (n.type === 'sql-mlv' || n.type === 'pyspark-mlv');
      var isSource = (n.type === 'sql-table');
      if (isMlv && inByNode[n.id] === 0) {
        errors.push({ nodeId: n.id, message: 'MLV "' + n.name + '" has no source connections.', severity: 'error' });
      }
      if (isSource && outByNode[n.id] === 0 && nodeCount > 1) {
        warnings.push({ nodeId: n.id, message: 'Source table "' + n.name + '" is not consumed by any MLV.', severity: 'warning' });
      }
    }

    // Rule 5: schema mismatch (higher tier feeding lower)
    var tier = { dbo: 0, bronze: 1, silver: 2, gold: 3 };
    for (i = 0; i < connections.length; i++) {
      var conn = connections[i];
      var src = nodeById[conn.sourceNodeId];
      var tgt = nodeById[conn.targetNodeId];
      if (!src || !tgt) continue;
      var sRank = tier[src.schema];
      var tRank = tier[tgt.schema];
      if (sRank !== undefined && tRank !== undefined && sRank > tRank && tRank > 0) {
        warnings.push({
          nodeId: tgt.id,
          message: 'Schema tier mismatch: ' + src.schema + ' "' + src.name + '" feeds ' + tgt.schema + ' "' + tgt.name + '".',
          severity: 'warning'
        });
      }
    }

    // Rule 6: disconnected subgraphs (undirected components)
    if (nodeCount > 1) {
      var adj = {};
      for (i = 0; i < nodes.length; i++) adj[nodes[i].id] = [];
      for (i = 0; i < connections.length; i++) {
        var co = connections[i];
        if (adj[co.sourceNodeId]) adj[co.sourceNodeId].push(co.targetNodeId);
        if (adj[co.targetNodeId]) adj[co.targetNodeId].push(co.sourceNodeId);
      }
      var visited = {};
      var components = [];
      for (i = 0; i < nodes.length; i++) {
        var startId = nodes[i].id;
        if (visited[startId]) continue;
        var comp = [];
        var stack = [startId];
        while (stack.length) {
          var cur = stack.pop();
          if (visited[cur]) continue;
          visited[cur] = true;
          comp.push(cur);
          var nbrs = adj[cur] || [];
          for (var j = 0; j < nbrs.length; j++) {
            if (!visited[nbrs[j]]) stack.push(nbrs[j]);
          }
        }
        components.push(comp);
      }
      if (components.length > 1) {
        // Largest component is "main"; everything else is disconnected.
        components.sort(function(a, b) { return b.length - a.length; });
        for (i = 1; i < components.length; i++) {
          var sub = components[i];
          for (var k = 0; k < sub.length; k++) {
            warnings.push({
              nodeId: sub[k],
              message: 'Node is in a subgraph disconnected from the main DAG.',
              severity: 'warning'
            });
          }
        }
      }
    }

    // Apply badges (only the highest severity per node wins)
    if (this._canvas && typeof this._canvas.clearAllValidation === 'function') {
      this._canvas.clearAllValidation();
      var perNode = {};
      var apply = function(item) {
        if (!item.nodeId) return;
        if (perNode[item.nodeId] === 'error') return;
        perNode[item.nodeId] = item.severity;
      };
      for (i = 0; i < errors.length; i++) apply(errors[i]);
      for (i = 0; i < warnings.length; i++) apply(warnings[i]);
      var ids = Object.keys(perNode);
      for (i = 0; i < ids.length; i++) {
        this._canvas.setNodeValidation(ids[i], perNode[ids[i]]);
      }
    }

    var summary;
    if (errors.length === 0 && warnings.length === 0) {
      summary = nodeCount === 0 ? '' : 'No issues';
    } else {
      var parts = [];
      if (errors.length) parts.push(errors.length + (errors.length === 1 ? ' error' : ' errors'));
      if (warnings.length) parts.push(warnings.length + (warnings.length === 1 ? ' warning' : ' warnings'));
      summary = parts.join(', ');
    }

    var result = {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      summary: summary
    };

    this._renderValidationBar(result, nodeCount);
    return result;
  }

  _renderValidationBar(result, nodeCount) {
    var bar = this._validationBar;
    if (!bar) return;
    var self = this;

    // Reset classes
    bar.className = 'iw-validation-bar';
    bar.innerHTML = '';

    if (nodeCount === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';

    var icon = document.createElement('span');
    icon.className = 'iw-validation-bar__icon';

    var label = document.createElement('span');
    label.className = 'iw-validation-bar__label';

    if (result.errors.length === 0 && result.warnings.length === 0) {
      bar.classList.add('iw-validation-bar--clean');
      icon.textContent = '\u2713';
      label.textContent = 'No issues';
      bar.appendChild(icon);
      bar.appendChild(label);
      return;
    }

    if (result.errors.length > 0) {
      bar.classList.add('iw-validation-bar--errors');
      icon.textContent = '\u25CF';
    } else {
      bar.classList.add('iw-validation-bar--warnings');
      icon.textContent = '\u25B2';
    }
    label.textContent = result.summary;
    bar.appendChild(icon);
    bar.appendChild(label);

    // Clickable item list (errors first)
    var list = document.createElement('span');
    list.className = 'iw-validation-bar__items';
    var items = result.errors.concat(result.warnings);
    var max = Math.min(items.length, 5);
    for (var i = 0; i < max; i++) {
      (function(item) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'iw-validation-bar__chip iw-validation-bar__chip--' + item.severity;
        chip.textContent = item.message;
        chip.title = item.message;
        chip.addEventListener('click', function() {
          if (item.nodeId && self._canvas && typeof self._canvas.focusNode === 'function') {
            self._canvas.focusNode(item.nodeId);
          } else if (item.nodeId && self._canvas && typeof self._canvas.selectNode === 'function') {
            self._canvas.selectNode(item.nodeId);
          }
        });
        list.appendChild(chip);
      })(items[i]);
    }
    if (items.length > max) {
      var more = document.createElement('span');
      more.className = 'iw-validation-bar__more';
      more.textContent = '+' + (items.length - max) + ' more';
      list.appendChild(more);
    }
    bar.appendChild(list);
  }

  collectState(state) {
    this._canvas.collectState(state);
  }

  getElement() {
    return this._rootEl;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // Cancel debounced timers
    if (this._debouncedCodeRefresh && this._debouncedCodeRefresh.cancel) {
      this._debouncedCodeRefresh.cancel();
    }
    if (this._debouncedValidate && this._debouncedValidate.cancel) {
      this._debouncedValidate.cancel();
    }

    // Unsubscribe from events
    var i;
    for (i = 0; i < this._unsubs.length; i++) {
      this._unsubs[i]();
    }
    this._unsubs = [];

    // Destroy sub-components in reverse creation order
    if (this._presets) {
      this._presets.destroy();
      this._presets = null;
    }
    if (this._nodePopover) {
      this._nodePopover.destroy();
      this._nodePopover = null;
    }
    if (this._codePanel) {
      this._codePanel.destroy();
      this._codePanel = null;
    }
    if (this._palette) {
      this._palette.destroy();
      this._palette = null;
    }
    if (this._canvas) {
      this._canvas.destroy();
      this._canvas = null;
    }
    if (this._undoManager) {
      this._undoManager.destroy();
      this._undoManager = null;
    }

    // Remove root from DOM
    if (this._rootEl && this._rootEl.parentNode) {
      this._rootEl.parentNode.removeChild(this._rootEl);
    }
    this._rootEl = null;
    this._paletteContainer = null;
    this._canvasContainer = null;
    this._codeContainer = null;
    this._validationBar = null;
    this._liveRegion = null;
    this._eventBus = null;
    this._codeGen = null;
  }

  // ── Public Accessors ──────────────────────────────────────────

  getCanvas() {
    return this._canvas;
  }

  getPalette() {
    return this._palette;
  }

  getCodePanel() {
    return this._codePanel;
  }

  // ── Private Helpers ───────────────────────────────────────────

  _refreshCodePreview() {
    if (!this._codePanel || !this._canvas) return;
    var nodes = this._canvas.getNodes();
    var connections = this._canvas.getConnections();
    this._codePanel.refresh(nodes, connections, this._theme, this._schemas);
  }
}

window.DagCanvasPage = DagCanvasPage;
