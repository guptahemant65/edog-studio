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
  { type: 'sql-table',    icon: '◇', iconClass: 'iw-type-table',   name: 'SQL Table',    sub: 'Source data table',          basePattern: 'raw_{n}' },
  { type: 'sql-mlv',      icon: '◆', iconClass: 'iw-type-mlv',     name: 'SQL MLV',      sub: 'SQL materialized view',      basePattern: 'view_{n}' },
  { type: 'pyspark-mlv',  icon: '◆', iconClass: 'iw-type-pyspark', name: 'PySpark MLV',  sub: 'PySpark materialized view',  basePattern: 'transform_{n}' }
];

var NODE_PALETTE_BATCH_MAX = 20;

var NODE_PALETTE_SCHEMA_PREFIX = {
  'dbo':     '',
  'bronze':  'brz_',
  'silver':  'slv_',
  'gold':    'gld_'
};

var NODE_PALETTE_SCHEMA_LABEL = {
  'dbo':     'dbo',
  'bronze':  'Bronze',
  'silver':  'Silver',
  'gold':    'Gold'
};

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
    this._onBatchExpand = opts.onBatchExpand || null;

    // DOM references
    this._rootEl = null;
    this._countEl = null;
    this._undoBtn = null;
    this._redoBtn = null;
    this._paletteItems = [];
    this._batchForms = [];  // per-item batch form refs (see _createPaletteItem)
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
    this._refreshAllBatchForms();
  }

  /**
   * Update the enabled-schema map (called when wizard medallion level changes).
   * Re-filters all batch form schema dropdowns and re-derives default patterns.
   * @param {object} schemas — { dbo, bronze, silver, gold } booleans
   */
  updateSchemas(schemas) {
    this._schemas = schemas || {};
    for (var i = 0; i < this._batchForms.length; i++) {
      this._rebuildSchemaDropdown(this._batchForms[i]);
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
   * Build a single palette item: header row (icon + info + [+] add + [▾] expand)
   * plus a collapsible batch-configuration form below it.
   * @param {object} def  — entry from NODE_PALETTE_TYPES
   * @returns {HTMLElement}
   */
  _createPaletteItem(def) {
    var self = this;

    // Wrapper holds the header row + collapsible batch form
    var wrapper = document.createElement('div');
    wrapper.className = 'iw-palette-item-wrap';
    wrapper.setAttribute('data-type', def.type);

    // ── Header row (the original draggable item) ─────────────────
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

    // Expand/collapse toggle for batch form
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'iw-palette-batch-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Batch add ' + def.name);
    toggle.title = 'Batch add ' + def.name;
    toggle.textContent = '▾';
    item.appendChild(toggle);

    // Mousedown starts potential drag — IGNORE when target is the toggle,
    // otherwise expanding the form would initiate a drag.
    item.addEventListener('mousedown', function(e) {
      if (self._disabled) return;
      if (e.target === toggle || toggle.contains(e.target)) return;
      e.preventDefault();
      self._dragType = def.type;
      self._dragStartX = e.clientX;
      self._dragStartY = e.clientY;
      self._dragActive = false;
      self._dragName = def.name;
    });

    // Click fallback (single-add) — also ignore the toggle.
    item.addEventListener('click', function(e) {
      if (self._disabled) return;
      if (self._dragActive) return;
      if (e.target === toggle || toggle.contains(e.target)) return;
      if (self._canvas) {
        self._canvas.addNode(def.type);
      }
    });

    wrapper.appendChild(item);

    // ── Collapsible batch form ───────────────────────────────────
    var form = self._buildBatchForm(def);
    wrapper.appendChild(form.rootEl);

    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = wrapper.classList.contains('iw-palette-item-wrap--expanded');
      if (isOpen) {
        self._collapseForm(wrapper, toggle);
      } else {
        // Only one form open at a time
        self._collapseAllForms();
        self._expandForm(wrapper, toggle, form);
        // Dismiss preset overlay — user chose manual/batch over presets
        if (typeof self._onBatchExpand === 'function') {
          self._onBatchExpand();
        }
      }
    });

    // Keep refs to refresh later
    self._batchForms.push(form);

    return wrapper;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Batch form
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Build the batch-config form for a single palette item.
   * Returns a refs object: { rootEl, def, countEl, stepperDec, stepperInc,
   *   schemaSel, patternInput, addBtn, fullMsg, count, userEditedPattern }
   */
  _buildBatchForm(def) {
    var self = this;

    var rootEl = document.createElement('div');
    rootEl.className = 'iw-palette-batch-form';
    rootEl.setAttribute('aria-hidden', 'true');

    var inner = document.createElement('div');
    inner.className = 'iw-palette-batch-inner';
    rootEl.appendChild(inner);

    // "Canvas is full" message (hidden by default)
    var fullMsg = document.createElement('div');
    fullMsg.className = 'iw-palette-batch-full';
    fullMsg.textContent = 'Canvas is full';
    inner.appendChild(fullMsg);

    // ── Count row ─────────────────────────────────────────
    var countRow = document.createElement('div');
    countRow.className = 'iw-palette-batch-row';
    var countLbl = document.createElement('label');
    countLbl.className = 'iw-palette-batch-label';
    countLbl.textContent = 'Count';
    countRow.appendChild(countLbl);

    var stepper = document.createElement('div');
    stepper.className = 'iw-palette-batch-stepper';
    var dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'iw-palette-batch-step';
    dec.textContent = '−';
    dec.setAttribute('aria-label', 'Decrease count');
    var countEl = document.createElement('span');
    countEl.className = 'iw-palette-batch-count';
    countEl.textContent = '1';
    var inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'iw-palette-batch-step';
    inc.textContent = '+';
    inc.setAttribute('aria-label', 'Increase count');
    stepper.appendChild(dec);
    stepper.appendChild(countEl);
    stepper.appendChild(inc);
    countRow.appendChild(stepper);
    inner.appendChild(countRow);

    // ── Schema row ────────────────────────────────────────
    var schemaRow = document.createElement('div');
    schemaRow.className = 'iw-palette-batch-row';
    var schemaLbl = document.createElement('label');
    schemaLbl.className = 'iw-palette-batch-label';
    schemaLbl.textContent = 'Schema';
    schemaRow.appendChild(schemaLbl);
    var schemaSel = document.createElement('select');
    schemaSel.className = 'iw-palette-batch-select';
    schemaRow.appendChild(schemaSel);
    inner.appendChild(schemaRow);

    // ── Pattern row ───────────────────────────────────────
    var patternRow = document.createElement('div');
    patternRow.className = 'iw-palette-batch-row';
    var patternLbl = document.createElement('label');
    patternLbl.className = 'iw-palette-batch-label';
    patternLbl.textContent = 'Pattern';
    patternRow.appendChild(patternLbl);
    var patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'iw-palette-batch-input';
    patternInput.setAttribute('spellcheck', 'false');
    patternInput.setAttribute('autocomplete', 'off');
    patternRow.appendChild(patternInput);
    inner.appendChild(patternRow);

    // ── Action button ─────────────────────────────────────
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'iw-palette-batch-btn';
    addBtn.textContent = 'Add 1 node';
    inner.appendChild(addBtn);

    var refs = {
      rootEl: rootEl,
      def: def,
      countEl: countEl,
      stepperDec: dec,
      stepperInc: inc,
      schemaSel: schemaSel,
      patternInput: patternInput,
      addBtn: addBtn,
      fullMsg: fullMsg,
      count: 1,
      userEditedPattern: false
    };

    // ── Wire interactions ─────────────────────────────────
    dec.addEventListener('click', function(e) {
      e.stopPropagation();
      if (refs.count > 1) {
        refs.count--;
        self._refreshBatchForm(refs);
      }
    });
    inc.addEventListener('click', function(e) {
      e.stopPropagation();
      var max = self._getStepperMax();
      if (refs.count < max) {
        refs.count++;
        self._refreshBatchForm(refs);
      }
    });
    schemaSel.addEventListener('change', function() {
      if (!refs.userEditedPattern) {
        patternInput.value = self._defaultPatternFor(def, schemaSel.value);
      }
    });
    patternInput.addEventListener('input', function() {
      refs.userEditedPattern = true;
      self._refreshBatchForm(refs);
    });
    addBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var pat = (patternInput.value || '').trim();
      if (!pat) return;
      self._batchAdd(def.type, refs.count, schemaSel.value, pat);
      // Collapse this form after a successful add
      var wrapper = rootEl.parentNode;
      var toggle = wrapper ? wrapper.querySelector('.iw-palette-batch-toggle') : null;
      if (wrapper && toggle) self._collapseForm(wrapper, toggle);
    });

    // Initial population
    self._rebuildSchemaDropdown(refs);
    self._refreshBatchForm(refs);

    return refs;
  }

  /**
   * Populate the schema <select> with enabled medallion schemas.
   * Preserves selection when possible; falls back to first option.
   */
  _rebuildSchemaDropdown(refs) {
    var prev = refs.schemaSel.value;
    var opts = this._getAvailableSchemas();
    refs.schemaSel.innerHTML = '';
    var matched = false;
    for (var i = 0; i < opts.length; i++) {
      var o = document.createElement('option');
      o.value = opts[i].value;
      o.textContent = opts[i].label;
      refs.schemaSel.appendChild(o);
      if (opts[i].value === prev) matched = true;
    }
    refs.schemaSel.value = matched ? prev : (opts.length ? opts[0].value : 'dbo');
    if (!refs.userEditedPattern) {
      refs.patternInput.value = this._defaultPatternFor(refs.def, refs.schemaSel.value);
    }
  }

  /**
   * Return enabled-schema options for the schema dropdown.
   * @returns {Array<{value:string,label:string}>}
   */
  _getAvailableSchemas() {
    var result = [{ value: 'dbo', label: NODE_PALETTE_SCHEMA_LABEL.dbo }];
    if (this._schemas.bronze) result.push({ value: 'bronze', label: NODE_PALETTE_SCHEMA_LABEL.bronze });
    if (this._schemas.silver) result.push({ value: 'silver', label: NODE_PALETTE_SCHEMA_LABEL.silver });
    if (this._schemas.gold)   result.push({ value: 'gold',   label: NODE_PALETTE_SCHEMA_LABEL.gold });
    return result;
  }

  /**
   * Default naming pattern for (def, schema). E.g. (sql-table, bronze) → "brz_raw_{n}".
   */
  _defaultPatternFor(def, schema) {
    var prefix = NODE_PALETTE_SCHEMA_PREFIX[schema] || '';
    return prefix + def.basePattern;
  }

  /**
   * Current max value the count stepper may take.
   * = min(NODE_PALETTE_BATCH_MAX, remaining canvas capacity).
   */
  _getStepperMax() {
    var current = this._canvas ? this._canvas.getNodeCount() : 0;
    var remaining = Math.max(0, NODE_PALETTE_MAX_NODES - current);
    return Math.min(NODE_PALETTE_BATCH_MAX, remaining);
  }

  /**
   * Update button labels, stepper bounds, disabled state for one form.
   */
  _refreshBatchForm(refs) {
    var max = this._getStepperMax();
    var atCapacity = max === 0;

    // Clamp count
    if (refs.count > max) refs.count = Math.max(1, max);
    if (refs.count < 1) refs.count = 1;
    refs.countEl.textContent = String(refs.count);

    // Capacity-full state
    if (atCapacity) {
      refs.fullMsg.classList.add('is-visible');
      refs.stepperDec.disabled = true;
      refs.stepperInc.disabled = true;
      refs.schemaSel.disabled = true;
      refs.patternInput.disabled = true;
      refs.addBtn.disabled = true;
      refs.addBtn.textContent = 'Canvas full';
      return;
    }
    refs.fullMsg.classList.remove('is-visible');
    refs.schemaSel.disabled = false;
    refs.patternInput.disabled = false;
    refs.stepperDec.disabled = refs.count <= 1;
    refs.stepperInc.disabled = refs.count >= max;

    // Near-capacity hint: show remaining when <= 10 slots left
    var remaining = NODE_PALETTE_MAX_NODES - (this._canvas ? this._canvas.getNodeCount() : 0);
    var label = 'Add ' + refs.count + ' ' + (refs.count === 1 ? 'node' : 'nodes');
    if (remaining <= 10) {
      label += ' (' + remaining + ' left)';
    }

    // Pattern validation
    var patVal = (refs.patternInput.value || '').trim();
    refs.addBtn.disabled = patVal.length === 0;
    refs.addBtn.textContent = patVal.length === 0 ? 'Enter pattern' : label;
  }

  /**
   * Refresh all batch forms (called when canvas node count changes).
   */
  _refreshAllBatchForms() {
    for (var i = 0; i < this._batchForms.length; i++) {
      this._refreshBatchForm(this._batchForms[i]);
    }
  }

  _expandForm(wrapper, toggle, refs) {
    wrapper.classList.add('iw-palette-item-wrap--expanded');
    refs.rootEl.setAttribute('aria-hidden', 'false');
    toggle.textContent = '▴';
    toggle.setAttribute('aria-expanded', 'true');
    this._refreshBatchForm(refs);
  }

  _collapseForm(wrapper, toggle) {
    wrapper.classList.remove('iw-palette-item-wrap--expanded');
    var form = wrapper.querySelector('.iw-palette-batch-form');
    if (form) form.setAttribute('aria-hidden', 'true');
    toggle.textContent = '▾';
    toggle.setAttribute('aria-expanded', 'false');
  }

  _collapseAllForms() {
    if (!this._rootEl) return;
    var wraps = this._rootEl.querySelectorAll('.iw-palette-item-wrap--expanded');
    for (var i = 0; i < wraps.length; i++) {
      var t = wraps[i].querySelector('.iw-palette-batch-toggle');
      if (t) this._collapseForm(wraps[i], t);
    }
  }

  /**
   * Add `count` nodes of `type` with `schema`, using `pattern` (with optional
   * `{n}` placeholder) for naming. Existing names are skipped; sequence
   * numbers continue until `count` unique names are produced or a safety
   * cap is reached. All adds run inside a single batchOperation so undo/redo
   * collapses them to one step.
   *
   * @param {string} type    — 'sql-table' | 'sql-mlv' | 'pyspark-mlv'
   * @param {number} count   — already clamped to remaining capacity
   * @param {string} schema  — 'dbo' | 'bronze' | 'silver' | 'gold'
   * @param {string} pattern — e.g. 'brz_raw_{n}' or 'orders'
   */
  _batchAdd(type, count, schema, pattern) {
    if (!this._canvas) return;
    var self = this;

    var max = this._getStepperMax();
    var n = Math.min(count, max);
    if (n <= 0) return;

    var hasPlaceholder = pattern.indexOf('{n}') !== -1;
    var existingNames = {};
    var nodes = this._canvas.getNodes();
    for (var i = 0; i < nodes.length; i++) {
      existingNames[nodes[i].name] = true;
    }

    var addedCount = 0;
    this._canvas.batchOperation(function() {
      var added = 0;
      var seq = 1;
      var safety = 0;
      var SAFETY_CAP = 1000;  // hard stop in case every name in range is taken
      while (added < n && safety < SAFETY_CAP) {
        safety++;
        var name = hasPlaceholder
          ? pattern.replace(/\{n\}/g, String(seq))
          : pattern + '_' + seq;
        if (!existingNames[name]) {
          var created = self._canvas.addNode(type, null, { name: name, schema: schema });
          if (!created) break;  // canvas refused (limit hit mid-loop)
          existingNames[name] = true;
          added++;
        }
        seq++;
      }
      addedCount = added;

      // Auto-connect new nodes based on schema layer adjacency.
      // bronze→silver→gold: new nodes connect TO the next layer
      // and FROM the previous layer.
      if (added > 0) {
        var NEXT_SCHEMA = { bronze: 'silver', silver: 'gold' };
        var PREV_SCHEMA = { silver: 'bronze', gold: 'silver' };
        var TYPE_TARGETS = { 'sql-table': ['sql-mlv', 'pyspark-mlv'], 'sql-mlv': ['pyspark-mlv'] };
        var TYPE_SOURCES = { 'sql-mlv': ['sql-table'], 'pyspark-mlv': ['sql-table', 'sql-mlv'] };
        var allNodes = self._canvas.getNodes();
        var newNodeIds = [];
        for (var ni = allNodes.length - added; ni < allNodes.length; ni++) {
          if (allNodes[ni]) newNodeIds.push(allNodes[ni].id);
        }

        for (var ai = 0; ai < allNodes.length; ai++) {
          var existing = allNodes[ai];
          if (newNodeIds.indexOf(existing.id) !== -1) continue;

          for (var bi = 0; bi < newNodeIds.length; bi++) {
            var newId = newNodeIds[bi];
            var shouldConnect = false;

            if (schema !== 'dbo') {
              // Medallion mode: connect by schema adjacency
              if (existing.schema === NEXT_SCHEMA[schema]) {
                // New node → existing next-layer node
                self._canvas.addConnection(newId, existing.id);
              }
              if (existing.schema === PREV_SCHEMA[schema]) {
                // Existing prev-layer node → new node
                self._canvas.addConnection(existing.id, newId);
              }
            } else {
              // No medallion: connect by type adjacency
              var targets = TYPE_TARGETS[type];
              var sources = TYPE_SOURCES[type];
              if (targets && targets.indexOf(existing.type) !== -1) {
                self._canvas.addConnection(newId, existing.id);
              }
              if (sources && sources.indexOf(existing.type) !== -1) {
                self._canvas.addConnection(existing.id, newId);
              }
            }
          }
        }
      }
    });

    if (addedCount > 0) {
      this._canvas.autoLayout();
    }
    if (addedCount < n && window.edogToast) {
      if (addedCount === 0) {
        window.edogToast('No available names — all sequences in pattern are taken', 'error');
      } else {
        window.edogToast('Added ' + addedCount + ' of ' + n + ' nodes (limit reached)', 'warning');
      }
    }
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
