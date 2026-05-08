/**
 * NodePopover — Edit popover for DAG canvas nodes.
 *
 * Shows when a node is selected, positioned to the right (or left if near edge).
 * Allows inline editing of: name, type, schema. Plus delete action.
 *
 * CSS prefix: .iw-node-popover-*
 * @author Pixel — EDOG Studio hivemind
 */

/* global DagCanvas, IW_EVENTS */

class NodePopover {

  /**
   * @param {object} options
   * @param {HTMLElement} options.containerEl — parent element to attach popover to
   * @param {object} options.canvas — DagCanvas instance
   * @param {object} options.eventBus — WizardEventBus instance
   * @param {object} [options.schemas] — enabled schemas {dbo: true, ...}
   */
  constructor(options) {
    var self = this;
    this._containerEl = options.containerEl;
    this._canvas = options.canvas;
    this._eventBus = options.eventBus;
    this._schemas = options.schemas || { dbo: true, bronze: false, silver: false, gold: false };
    this._currentNodeId = null;
    this._destroyed = false;

    // Build DOM
    this._popoverEl = document.createElement('div');
    this._popoverEl.className = 'iw-node-popover';
    this._popoverEl.style.display = 'none';

    this._arrowEl = document.createElement('div');
    this._arrowEl.className = 'iw-node-popover-arrow';
    this._popoverEl.appendChild(this._arrowEl);

    this._contentEl = document.createElement('div');
    this._contentEl.className = 'iw-node-popover-content';
    this._popoverEl.appendChild(this._contentEl);

    this._buildFields();
    this._containerEl.appendChild(this._popoverEl);

    // Event subscriptions
    this._unsubs = [];
    this._unsubs.push(
      this._eventBus.on(IW_EVENTS.NODE_SELECTED, function(data) {
        self._show(data.nodeId);
      })
    );
    this._unsubs.push(
      this._eventBus.on(IW_EVENTS.SELECTION_CLEARED, function() {
        self._hide();
      })
    );

    // Dismiss on click outside
    this._boundOutsideClick = function(e) { self._onOutsideClick(e); };
    document.addEventListener('mousedown', this._boundOutsideClick);

    // Dismiss on Escape
    this._boundKeyDown = function(e) { self._onKeyDown(e); };
    document.addEventListener('keydown', this._boundKeyDown);
  }

  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════ */

  updateSchemas(schemas) {
    this._schemas = schemas;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    var i;
    for (i = 0; i < this._unsubs.length; i++) {
      this._unsubs[i]();
    }
    this._unsubs = [];

    document.removeEventListener('mousedown', this._boundOutsideClick);
    document.removeEventListener('keydown', this._boundKeyDown);

    if (this._popoverEl && this._popoverEl.parentNode) {
      this._popoverEl.parentNode.removeChild(this._popoverEl);
    }

    this._popoverEl = null;
    this._contentEl = null;
    this._arrowEl = null;
    this._containerEl = null;
    this._canvas = null;
    this._eventBus = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Build
     ═══════════════════════════════════════════════════════════════ */

  _buildFields() {
    var self = this;

    // Name field
    var nameRow = document.createElement('div');
    nameRow.className = 'iw-node-popover-row';
    var nameLabel = document.createElement('label');
    nameLabel.className = 'iw-node-popover-label';
    nameLabel.textContent = 'Name';
    this._nameInput = document.createElement('input');
    this._nameInput.type = 'text';
    this._nameInput.className = 'iw-node-popover-input';
    this._nameInput.addEventListener('blur', function() { self._commitName(); });
    this._nameInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        self._commitName();
        self._nameInput.blur();
      }
    });
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(this._nameInput);
    this._contentEl.appendChild(nameRow);

    // Type dropdown
    var typeRow = document.createElement('div');
    typeRow.className = 'iw-node-popover-row';
    var typeLabel = document.createElement('label');
    typeLabel.className = 'iw-node-popover-label';
    typeLabel.textContent = 'Type';
    this._typeSelect = document.createElement('select');
    this._typeSelect.className = 'iw-node-popover-select';
    var types = [
      { value: 'sql-table', label: 'SQL Table' },
      { value: 'sql-mlv', label: 'SQL MLV' },
      { value: 'pyspark-mlv', label: 'PySpark MLV' }
    ];
    var i;
    for (i = 0; i < types.length; i++) {
      var opt = document.createElement('option');
      opt.value = types[i].value;
      opt.textContent = types[i].label;
      this._typeSelect.appendChild(opt);
    }
    this._typeSelect.addEventListener('change', function() { self._commitType(); });
    typeRow.appendChild(typeLabel);
    typeRow.appendChild(this._typeSelect);
    this._contentEl.appendChild(typeRow);

    // Schema dropdown
    var schemaRow = document.createElement('div');
    schemaRow.className = 'iw-node-popover-row';
    var schemaLabel = document.createElement('label');
    schemaLabel.className = 'iw-node-popover-label';
    schemaLabel.textContent = 'Schema';
    this._schemaSelect = document.createElement('select');
    this._schemaSelect.className = 'iw-node-popover-select';
    this._schemaSelect.addEventListener('change', function() { self._commitSchema(); });
    schemaRow.appendChild(schemaLabel);
    schemaRow.appendChild(this._schemaSelect);
    this._contentEl.appendChild(schemaRow);

    // Divider
    var divider = document.createElement('div');
    divider.className = 'iw-node-popover-divider';
    this._contentEl.appendChild(divider);

    // Delete button
    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'iw-node-popover-delete';
    deleteBtn.textContent = 'Delete Node';
    deleteBtn.addEventListener('click', function() { self._commitDelete(); });
    this._contentEl.appendChild(deleteBtn);
  }

  _populateSchemaOptions() {
    // Clear existing
    while (this._schemaSelect.firstChild) {
      this._schemaSelect.removeChild(this._schemaSelect.firstChild);
    }

    // Always include dbo
    var opt = document.createElement('option');
    opt.value = 'dbo';
    opt.textContent = 'dbo';
    this._schemaSelect.appendChild(opt);

    var names = ['bronze', 'silver', 'gold'];
    var i;
    for (i = 0; i < names.length; i++) {
      if (this._schemas[names[i]]) {
        var o = document.createElement('option');
        o.value = names[i];
        o.textContent = names[i];
        this._schemaSelect.appendChild(o);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Show/Hide
     ═══════════════════════════════════════════════════════════════ */

  _show(nodeId) {
    if (this._destroyed) return;
    this._currentNodeId = nodeId;

    var nodeData = this._canvas.getNodeData(nodeId);
    if (!nodeData) {
      this._hide();
      return;
    }

    // Populate fields
    this._nameInput.value = nodeData.name;
    this._typeSelect.value = nodeData.type;
    this._populateSchemaOptions();
    this._schemaSelect.value = nodeData.schema;

    // Show and position
    this._popoverEl.style.display = '';
    this._position(nodeData);
  }

  _hide() {
    if (this._destroyed) return;
    this._popoverEl.style.display = 'none';
    this._currentNodeId = null;
  }

  _position(nodeData) {
    var viewport = this._canvas.getViewport();
    var containerRect = this._containerEl.getBoundingClientRect();

    // Node position in screen coords
    var nodeScreenX = nodeData.x * viewport.zoom + viewport.panX;
    var nodeScreenY = nodeData.y * viewport.zoom + viewport.panY;
    var nodeScreenW = nodeData.width * viewport.zoom;
    var nodeScreenH = nodeData.height * viewport.zoom;

    var popoverWidth = 220;
    var gap = 12;

    // Default: place to the right
    var left = nodeScreenX + nodeScreenW + gap;
    var top = nodeScreenY;
    var arrowSide = 'left';

    // If near right edge, place to the left
    if (left + popoverWidth > containerRect.width) {
      left = nodeScreenX - popoverWidth - gap;
      arrowSide = 'right';
    }

    // Clamp top
    if (top < 8) top = 8;
    if (top + 200 > containerRect.height) {
      top = containerRect.height - 208;
    }

    this._popoverEl.style.left = left + 'px';
    this._popoverEl.style.top = top + 'px';

    // Arrow direction
    this._arrowEl.className = 'iw-node-popover-arrow iw-node-popover-arrow--' + arrowSide;
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Commit changes
     ═══════════════════════════════════════════════════════════════ */

  _commitName() {
    if (!this._currentNodeId) return;
    var value = this._nameInput.value.trim();
    if (!value) return;
    this._canvas.updateNode(this._currentNodeId, { name: value });
    this._eventBus.emit(IW_EVENTS.NODE_RENAMED, { nodeId: this._currentNodeId, name: value });
  }

  _commitType() {
    if (!this._currentNodeId) return;
    var value = this._typeSelect.value;
    this._canvas.updateNode(this._currentNodeId, { type: value });
    this._eventBus.emit(IW_EVENTS.NODE_TYPE_CHANGED, { nodeId: this._currentNodeId, type: value });
  }

  _commitSchema() {
    if (!this._currentNodeId) return;
    var value = this._schemaSelect.value;
    this._canvas.updateNode(this._currentNodeId, { schema: value });
    this._eventBus.emit(IW_EVENTS.NODE_SCHEMA_CHANGED, { nodeId: this._currentNodeId, schema: value });
  }

  _commitDelete() {
    if (!this._currentNodeId) return;
    var nodeId = this._currentNodeId;
    this._hide();
    this._canvas.removeNode(nodeId);
  }

  /* ═══════════════════════════════════════════════════════════════
     PRIVATE — Dismiss handlers
     ═══════════════════════════════════════════════════════════════ */

  _onOutsideClick(e) {
    if (!this._currentNodeId) return;
    if (this._popoverEl.contains(e.target)) return;
    // Let canvas node clicks handle themselves via the event bus
  }

  _onKeyDown(e) {
    if (!this._currentNodeId) return;
    if (e.key === 'Escape') {
      this._hide();
      this._canvas.selectNode(null);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════ */
window.NodePopover = NodePopover;
