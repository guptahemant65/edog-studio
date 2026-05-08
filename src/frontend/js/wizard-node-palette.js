/**
 * NodePalette (C05) — Left sidebar drag source panel for the DAG canvas.
 *
 * Renders three draggable node types (SQL Table, SQL MLV, PySpark MLV),
 * undo/redo buttons, auto-arrange, and a live node counter (N / 100).
 * Supports both click-to-add and drag-to-position workflows.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* global DagCanvas, WizardEventBus, UndoRedoManager, IW_EVENTS */

var NODE_PALETTE_MAX_NODES = 100;

var NODE_PALETTE_TYPES = [
  { type: 'sql-table',    icon: '◇', iconClass: 'iw-type-table',   name: 'SQL Table',    sub: 'Source data table' },
  { type: 'sql-mlv',      icon: '◆', iconClass: 'iw-type-mlv',     name: 'SQL MLV',      sub: 'SQL materialized view' },
  { type: 'pyspark-mlv',  icon: '◆', iconClass: 'iw-type-pyspark', name: 'PySpark MLV',  sub: 'PySpark materialized view' }
];

var NODE_PALETTE_SVG_AUTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<rect x="3" y="3" width="7" height="7"/>'
  + '<rect x="14" y="3" width="7" height="7"/>'
  + '<rect x="14" y="14" width="7" height="7"/>'
  + '<rect x="3" y="14" width="7" height="7"/>'
  + '</svg>';

var NODE_PALETTE_SVG_UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<polyline points="1 4 1 10 7 10"/>'
  + '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'
  + '</svg>';

var NODE_PALETTE_SVG_REDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:scaleX(-1)">'
  + '<polyline points="1 4 1 10 7 10"/>'
  + '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'
  + '</svg>';


class NodePalette {

  /**
   * @param {object} options
   * @param {HTMLElement}       options.containerEl  — element to render into
   * @param {WizardEventBus}    options.eventBus     — shared event bus
   * @param {DagCanvas}         options.canvas       — canvas instance
   * @param {UndoRedoManager}   options.undoManager  — undo/redo manager
   * @param {object}            [options.schemas]    — schema map from WizardState
   */
  constructor(options) {
    var opts = options || {};
    this._containerEl = opts.containerEl;
    this._eventBus = opts.eventBus;
    this._canvas = opts.canvas;
    this._undoManager = opts.undoManager;
    this._schemas = opts.schemas || {};
    this._disabled = false;

    // DOM references
    this._rootEl = null;
    this._countEl = null;
    this._undoBtn = null;
    this._redoBtn = null;
    this._paletteItems = [];
    this._ghostEl = null;

    // Drag state
    this._dragType = null;
    this._dragActive = false;

    // Bound handlers (for removal)
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);

    // EventBus unsubscribe functions
    this._unsubs = [];

    this._render();
    this._bindEvents();
  }

  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Update the node counter display.
   * @param {number} count
   */
  updateNodeCount(count) {
    if (this._countEl) {
      this._countEl.textContent = count + ' / ' + NODE_PALETTE_MAX_NODES;
    }
    if (count >= NODE_PALETTE_MAX_NODES) {
      this.setDisabled(true);
    } else if (this._disabled) {
      this.setDisabled(false);
    }
  }

  /**
   * Enable or disable the palette (gray out at 100 nodes).
   * @param {boolean} disabled
   */
  setDisabled(disabled) {
    this._disabled = !!disabled;
    for (var i = 0; i < this._paletteItems.length; i++) {
      if (this._disabled) {
        this._paletteItems[i].classList.add('disabled');
      } else {
        this._paletteItems[i].classList.remove('disabled');
      }
    }
  }

  /**
   * Return the root DOM element.
   * @returns {HTMLElement}
   */
  getElement() {
    return this._rootEl;
  }

  /**
   * Tear down: remove listeners, DOM, references.
   */
  destroy() {
    // Remove document-level drag listeners
    document.removeEventListener('mousemove', this._boundMouseMove);
    document.removeEventListener('mouseup', this._boundMouseUp);

    // Unsubscribe from eventBus
    for (var i = 0; i < this._unsubs.length; i++) {
      if (typeof this._unsubs[i] === 'function') {
        this._unsubs[i]();
      }
    }
    this._unsubs = [];

    // Remove ghost if present
    this._removeGhost();

    // Remove root from DOM
    if (this._rootEl && this._rootEl.parentNode) {
      this._rootEl.parentNode.removeChild(this._rootEl);
    }

    // Null references
    this._rootEl = null;
    this._countEl = null;
    this._undoBtn = null;
    this._redoBtn = null;
    this._paletteItems = [];
    this._containerEl = null;
    this._eventBus = null;
    this._canvas = null;
    this._undoManager = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Render
     ═══════════════════════════════════════════════════════════════ */

  _render() {
    var self = this;
    var root = document.createElement('div');
    root.className = 'iw-palette';

    // Header
    var header = document.createElement('div');
    header.className = 'iw-palette-header';

    var title = document.createElement('span');
    title.textContent = 'ADD NODES';
    header.appendChild(title);

    var count = document.createElement('span');
    count.className = 'iw-palette-count';
    count.textContent = '0 / ' + NODE_PALETTE_MAX_NODES;
    header.appendChild(count);
    this._countEl = count;

    root.appendChild(header);

    // Palette items
    for (var i = 0; i < NODE_PALETTE_TYPES.length; i++) {
      var def = NODE_PALETTE_TYPES[i];
      var item = self._createPaletteItem(def);
      root.appendChild(item);
      self._paletteItems.push(item);
    }

    // Separator
    var sep = document.createElement('div');
    sep.className = 'iw-palette-sep';
    root.appendChild(sep);

    // Actions
    var actions = document.createElement('div');
    actions.className = 'iw-palette-actions';

    var autoBtn = document.createElement('button');
    autoBtn.className = 'iw-palette-btn';
    autoBtn.id = 'autoArrangeBtn';
    autoBtn.innerHTML = NODE_PALETTE_SVG_AUTO + ' Auto Arrange';
    autoBtn.addEventListener('click', function() {
      if (self._canvas) {
        self._canvas.autoLayout();
      }
    });
    actions.appendChild(autoBtn);

    var btnRow = document.createElement('div');
    btnRow.className = 'iw-palette-btn-row';

    var undoBtn = document.createElement('button');
    undoBtn.className = 'iw-palette-btn';
    undoBtn.id = 'undoBtn';
    undoBtn.disabled = true;
    undoBtn.innerHTML = NODE_PALETTE_SVG_UNDO + ' Undo';
    undoBtn.addEventListener('click', function() {
      if (self._undoManager) {
        self._undoManager.undo();
      }
    });
    btnRow.appendChild(undoBtn);
    this._undoBtn = undoBtn;

    var redoBtn = document.createElement('button');
    redoBtn.className = 'iw-palette-btn';
    redoBtn.id = 'redoBtn';
    redoBtn.disabled = true;
    redoBtn.innerHTML = NODE_PALETTE_SVG_REDO + ' Redo';
    redoBtn.addEventListener('click', function() {
      if (self._undoManager) {
        self._undoManager.redo();
      }
    });
    btnRow.appendChild(redoBtn);
    this._redoBtn = redoBtn;

    actions.appendChild(btnRow);
    root.appendChild(actions);

    this._rootEl = root;

    if (this._containerEl) {
      this._containerEl.appendChild(root);
    }
  }

  /**
   * Build a single draggable palette item element.
   * @param {object} def  — entry from NODE_PALETTE_TYPES
   * @returns {HTMLElement}
   */
  _createPaletteItem(def) {
    var self = this;

    var item = document.createElement('div');
    item.className = 'iw-palette-item';
    item.setAttribute('data-type', def.type);

    var icon = document.createElement('div');
    icon.className = 'iw-palette-item-icon ' + def.iconClass;
    icon.textContent = def.icon;
    item.appendChild(icon);

    var info = document.createElement('div');
    info.className = 'iw-palette-item-info';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'iw-palette-item-name';
    nameSpan.textContent = def.name;
    info.appendChild(nameSpan);

    var subSpan = document.createElement('span');
    subSpan.className = 'iw-palette-item-sub';
    subSpan.textContent = def.sub;
    info.appendChild(subSpan);

    item.appendChild(info);

    // Mousedown starts potential drag
    item.addEventListener('mousedown', function(e) {
      if (self._disabled) return;
      e.preventDefault();
      self._dragType = def.type;
      self._dragStartX = e.clientX;
      self._dragStartY = e.clientY;
      self._dragActive = false;
      self._dragName = def.name;
    });

    // Click fallback (fires when no drag occurred)
    item.addEventListener('click', function() {
      if (self._disabled) return;
      if (self._dragActive) return;
      if (self._canvas) {
        self._canvas.addNode(def.type);
      }
    });

    return item;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Events
     ═══════════════════════════════════════════════════════════════ */

  _bindEvents() {
    var self = this;

    // Document-level drag listeners
    document.addEventListener('mousemove', this._boundMouseMove);
    document.addEventListener('mouseup', this._boundMouseUp);

    // EventBus subscriptions
    if (this._eventBus) {
      this._unsubs.push(
        this._eventBus.on(IW_EVENTS.NODE_ADDED, function() { self._refreshCount(); })
      );
      this._unsubs.push(
        this._eventBus.on(IW_EVENTS.NODE_REMOVED, function() { self._refreshCount(); })
      );
      this._unsubs.push(
        this._eventBus.on(IW_EVENTS.STATE_CHANGED, function() { self._refreshUndoRedoState(); })
      );
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Drag-to-add
     ═══════════════════════════════════════════════════════════════ */

  _onMouseMove(e) {
    if (!this._dragType) return;

    // Start drag after a small threshold (3px) to distinguish from click
    if (!this._dragActive) {
      var dx = e.clientX - this._dragStartX;
      var dy = e.clientY - this._dragStartY;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      this._dragActive = true;
      this._createGhost(this._dragName);
    }

    // Move ghost to cursor
    if (this._ghostEl) {
      this._ghostEl.style.left = e.clientX + 'px';
      this._ghostEl.style.top = e.clientY + 'px';
    }
  }

  _onMouseUp(e) {
    if (!this._dragType) return;

    var type = this._dragType;
    var wasDragging = this._dragActive;

    // Reset drag state
    this._dragType = null;
    this._dragActive = false;
    this._dragName = null;

    if (!wasDragging) return;

    this._removeGhost();

    if (this._disabled || !this._canvas) return;

    // Check if dropped onto the canvas SVG
    var svgEl = this._canvas.getElement();
    if (!svgEl) return;

    var rect = svgEl.getBoundingClientRect();
    var inCanvas = (
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom
    );

    if (inCanvas) {
      // Convert screen coords to canvas coords
      var relX = e.clientX - rect.left;
      var relY = e.clientY - rect.top;
      var vp = this._canvas.getViewport();
      var canvasX = (relX - vp.panX) / vp.zoom;
      var canvasY = (relY - vp.panY) / vp.zoom;
      this._canvas.addNode(type, { x: canvasX, y: canvasY });
    }
    // Drop outside canvas: silently cancel
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Ghost element
     ═══════════════════════════════════════════════════════════════ */

  _createGhost(label) {
    var ghost = document.createElement('div');
    ghost.className = 'iw-palette-ghost';
    ghost.textContent = label;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '5000';
    ghost.style.opacity = '0.85';
    document.body.appendChild(ghost);
    this._ghostEl = ghost;
  }

  _removeGhost() {
    if (this._ghostEl && this._ghostEl.parentNode) {
      this._ghostEl.parentNode.removeChild(this._ghostEl);
    }
    this._ghostEl = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — State refresh
     ═══════════════════════════════════════════════════════════════ */

  _refreshCount() {
    if (!this._canvas) return;
    var count = this._canvas.getNodeCount();
    this.updateNodeCount(count);
  }

  _refreshUndoRedoState() {
    if (!this._undoManager) return;
    this._undoBtn.disabled = !this._undoManager.canUndo();
    this._redoBtn.disabled = !this._undoManager.canRedo();
  }
}

window.NodePalette = NodePalette;
