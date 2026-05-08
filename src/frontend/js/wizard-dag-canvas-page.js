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

    // Root container
    this._rootEl = document.createElement('div');
    this._rootEl.className = 'iw-page iw-dag-page';

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
    this._rootEl.appendChild(this._canvasContainer);
    this._rootEl.appendChild(this._codeContainer);

    // Shared utilities
    this._undoManager = new UndoRedoManager({ eventBus: this._eventBus });
    this._codeGen = new CodeGenerationEngine();

    // Sub-components
    this._canvas = new DagCanvas({
      containerEl: this._canvasContainer,
      eventBus: this._eventBus,
      undoManager: this._undoManager,
      schemas: this._schemas
    });

    this._palette = new NodePalette({
      containerEl: this._paletteContainer,
      eventBus: this._eventBus,
      canvas: this._canvas,
      undoManager: this._undoManager,
      schemas: this._schemas
    });

    this._codePanel = new CodePreviewPanel({
      containerEl: this._codeContainer,
      eventBus: this._eventBus,
      codeGen: this._codeGen
    });

    this._presets = new DagPresets({
      containerEl: this._canvasContainer,
      dagCanvas: this._canvas,
      eventBus: this._eventBus,
      schemas: this._schemas
    });

    this._nodePopover = new NodePopover({
      containerEl: this._canvasContainer,
      canvas: this._canvas,
      eventBus: this._eventBus,
      schemas: this._schemas
    });

    // Wire state-change notifications back to the wizard
    this._unsubs = [];
    this._unsubs.push(
      this._eventBus.on(IW_EVENTS.STATE_CHANGED, function() {
        self._onStateChange();
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

    // Restore canvas state when re-entering or loading a template
    if (state.nodes && state.nodes.length > 0) {
      this._canvas.loadState(state);
    }

    this._palette.updateNodeCount(this._canvas.getNodeCount());

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
    var errors = [];
    var nodeCount = this._canvas.getNodeCount();

    if (nodeCount === 0) {
      errors.push('Add at least one node to the DAG before proceeding.');
    }

    if (nodeCount > 100) {
      errors.push('Maximum 100 nodes allowed. Please remove ' + (nodeCount - 100) + ' nodes.');
    }

    // Detect orphan MLV nodes (MLV with no incoming connections)
    var nodes = this._canvas.getNodes();
    var connections = this._canvas.getConnections();
    var targetIds = {};
    var i;
    for (i = 0; i < connections.length; i++) {
      targetIds[connections[i].targetNodeId] = true;
    }
    var warnings = [];
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if ((n.type === 'sql-mlv' || n.type === 'pyspark-mlv') && !targetIds[n.id]) {
        warnings.push('MLV node "' + n.name + '" has no source connections.');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings
    };
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

    // Unsubscribe from events
    var i;
    for (i = 0; i < this._unsubs.length; i++) {
      this._unsubs[i]();
    }
    this._unsubs = [];

    // Destroy sub-components in reverse creation order
    if (this._nodePopover) {
      this._nodePopover.destroy();
      this._nodePopover = null;
    }
    if (this._presets) {
      this._presets.destroy();
      this._presets = null;
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
