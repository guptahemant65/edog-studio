/**
 * DagNode — SVG node component for the DAG canvas.
 *
 * Renders as SVG <g> with <foreignObject> for rich HTML node body.
 * 3 node types: sql-table, sql-mlv, pyspark-mlv with distinct icons/badges.
 * Supports drag, select, rename, type/schema change, delete.
 *
 * CSS prefix: .iw-
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   NODE TYPE REGISTRY
   ═══════════════════════════════════════════════════════════════════ */

var DAG_NODE_TYPES = {
  'sql-table':   { icon: '\u25C6', badge: 'TBL', badgeClass: 'iw-badge-table' },
  'sql-mlv':     { icon: '\u25B8', badge: 'MLV', badgeClass: 'iw-badge-mlv' },
  'pyspark-mlv': { icon: '\u25CF', badge: 'PY',  badgeClass: 'iw-badge-pyspark' }
};

var DAG_NODE_SVG_NS = 'http://www.w3.org/2000/svg';
var DAG_NODE_XHTML_NS = 'http://www.w3.org/1999/xhtml';

/* ═══════════════════════════════════════════════════════════════════
   DAG NODE
   ═══════════════════════════════════════════════════════════════════ */

class DagNode {

  /**
   * @param {object} options
   * @param {object} options.data        — DagNodeData object
   * @param {SVGGElement} options.parentGroup — parent SVG <g> to append to
   * @param {object} options.eventBus    — WizardEventBus instance
   * @param {object} [options.schemas]   — enabled schemas {dbo: true, ...}
   * @param {Function} [options.onSelect]         — node clicked
   * @param {Function} [options.onDelete]         — delete button clicked
   * @param {Function} [options.onDragStart]      — drag begins
   * @param {Function} [options.onDragMove]       — drag moves {clientX, clientY, startX, startY}
   * @param {Function} [options.onDragEnd]        — drag ends
   * @param {Function} [options.onPortMouseDown]  — port mousedown (connection start)
   * @param {Function} [options.onPortMouseEnter] — port mouseenter (connection snap)
   */
  constructor(options) {
    var self = this;

    /* ─── Store references ─── */
    this._data = options.data;
    this._eventBus = options.eventBus || null;
    this._schemas = options.schemas || {};
    this._selected = false;
    this._dragState = null;

    /* ─── Callbacks ─── */
    this._onSelect = options.onSelect || null;
    this._onDelete = options.onDelete || null;
    this._onDragStart = options.onDragStart || null;
    this._onDragMove = options.onDragMove || null;
    this._onDragEnd = options.onDragEnd || null;
    this._onPortMouseDown = options.onPortMouseDown || null;
    this._onPortMouseEnter = options.onPortMouseEnter || null;

    /* ─── Build SVG structure ─── */
    this._groupEl = document.createElementNS(DAG_NODE_SVG_NS, 'g');
    this._groupEl.setAttribute('class', 'iw-dag-node');
    this._groupEl.setAttribute('data-node-id', this._data.id);
    this._groupEl.setAttribute(
      'transform',
      'translate(' + this._data.x + ', ' + this._data.y + ')'
    );
    this._groupEl.setAttribute('role', 'button');
    this._groupEl.setAttribute('tabindex', '0');
    this._updateAriaLabel();

    this._buildOutline();
    this._buildForeignObject();
    this._buildPorts();
    this._attachListeners();

    /* ─── Append to parent ─── */
    if (options.parentGroup) {
      options.parentGroup.appendChild(this._groupEl);
    }

    /* ─── Enter animation ─── */
    this._groupEl.classList.add('iw-node--entering');
    var enterGroup = this._groupEl;
    setTimeout(function() {
      if (enterGroup) enterGroup.classList.remove('iw-node--entering');
    }, 250);

    /* ─── Bound handlers (stored for cleanup) ─── */
    this._boundDragMove = function(e) { self._handleDragMove(e); };
    this._boundDragEnd = function(e) { self._handleDragEnd(e); };
  }

  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════ */

  /** @returns {SVGGElement} The root <g> element */
  getElement() {
    return this._groupEl;
  }

  /** @returns {SVGGElement|null} The root <g> element (alias for animation) */
  getGroupEl() {
    return this._groupEl;
  }

  /** @returns {object} Current DagNodeData snapshot */
  getData() {
    return {
      id: this._data.id,
      name: this._data.name,
      type: this._data.type,
      schema: this._data.schema,
      x: this._data.x,
      y: this._data.y,
      width: this._data.width,
      height: this._data.height,
      sequenceNumber: this._data.sequenceNumber,
      createdAt: this._data.createdAt
    };
  }

  /** Update node position (for drag/layout) */
  setPosition(x, y) {
    this._data.x = x;
    this._data.y = y;
    this._groupEl.setAttribute('transform', 'translate(' + x + ', ' + y + ')');
  }

  /**
   * Show or hide this node for viewport culling.
   * Hidden nodes have display:none on their group element.
   * @param {boolean} visible
   */
  setVisible(visible) {
    if (this._visible === visible) return;
    this._visible = visible;
    if (this._groupEl) {
      this._groupEl.style.display = visible ? '' : 'none';
    }
  }

  /** @returns {boolean} */
  isVisible() {
    return this._visible !== false;
  }

  /** Select/deselect this node visually */
  setSelected(selected) {
    this._selected = !!selected;
    if (this._selected) {
      this._groupEl.classList.add('iw-dag-node-selected');
      this._groupEl.setAttribute('aria-pressed', 'true');
    } else {
      this._groupEl.classList.remove('iw-dag-node-selected');
      this._groupEl.setAttribute('aria-pressed', 'false');
    }
  }

  /** @returns {boolean} */
  isSelected() {
    return this._selected;
  }

  /** Update the node name */
  setName(name) {
    this._data.name = name;
    if (this._nameEl) {
      this._nameEl.textContent = name;
      this._nameEl.setAttribute('title', name);
    }
    this._updateAriaLabel();
  }

  /** Change node type (sql-table, sql-mlv, pyspark-mlv) */
  setType(type) {
    var info = DAG_NODE_TYPES[type];
    if (!info) return;

    this._data.type = type;

    if (this._iconEl) {
      this._iconEl.textContent = info.icon;
    }
    if (this._badgeEl) {
      this._badgeEl.textContent = info.badge;
      // Remove all badge classes, then add the correct one
      this._badgeEl.className = 'iw-dag-node-badge ' + info.badgeClass;
    }
    this._updateAriaLabel();
  }

  /** Change node schema */
  setSchema(schema) {
    this._data.schema = schema;
    if (this._schemaEl) {
      this._schemaEl.textContent = schema;
    }
    this._updateAriaLabel();
  }

  /** Update node with new data (name, type, schema) */
  update(data) {
    if (data.name !== undefined) this.setName(data.name);
    if (data.type !== undefined) this.setType(data.type);
    if (data.schema !== undefined) this.setSchema(data.schema);
  }

  /** Get input port center position in canvas space */
  getInputPortPosition() {
    return {
      x: this._data.x + this._data.width / 2,
      y: this._data.y
    };
  }

  /** Get output port center position in canvas space */
  getOutputPortPosition() {
    return {
      x: this._data.x + this._data.width / 2,
      y: this._data.y + this._data.height
    };
  }

  /** Show/hide connection ports */
  showPorts(visible) {
    if (visible) {
      this._groupEl.classList.add('iw-dag-node-ports-visible');
    } else {
      this._groupEl.classList.remove('iw-dag-node-ports-visible');
    }
  }

  /** Destroy — animate out then remove SVG element, clean up listeners */
  destroy() {
    var self = this;

    // Remove drag listeners from document if active
    document.removeEventListener('mousemove', this._boundDragMove);
    document.removeEventListener('mouseup', this._boundDragEnd);

    var group = this._groupEl;
    if (group) {
      group.classList.add('iw-node--exiting');
      setTimeout(function() {
        if (group && group.parentNode) {
          group.parentNode.removeChild(group);
        }
      }, 180);
    }

    // Null out references (allow GC; DOM removal is deferred)
    this._groupEl = null;
    this._data = null;
    this._eventBus = null;
    this._onSelect = null;
    this._onDelete = null;
    this._onDragStart = null;
    this._onDragMove = null;
    this._onDragEnd = null;
    this._onPortMouseDown = null;
    this._onPortMouseEnter = null;
    this._nameEl = null;
    this._iconEl = null;
    this._badgeEl = null;
    this._schemaEl = null;
    this._seqEl = null;
    this._outlineEl = null;
    this._portIn = null;
    this._portOut = null;
    this._boundDragMove = null;
    this._boundDragEnd = null;
    this._dragState = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     BUILD HELPERS (private)
     ═══════════════════════════════════════════════════════════════ */

  /** Update ARIA label from current data */
  _updateAriaLabel() {
    if (!this._groupEl || !this._data) return;
    var typeLabel = this._data.type.replace(/-/g, ' ');
    this._groupEl.setAttribute('aria-label',
      typeLabel + ': ' + this._data.name + ' \u2014 ' + this._data.schema + ' schema');
  }

  /** Build the selection/hover outline rect */
  _buildOutline() {
    var rect = document.createElementNS(DAG_NODE_SVG_NS, 'rect');
    rect.setAttribute('class', 'iw-dag-node-outline');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', String(this._data.width));
    rect.setAttribute('height', String(this._data.height));
    rect.setAttribute('rx', '6');
    rect.setAttribute('ry', '6');
    this._outlineEl = rect;
    this._groupEl.appendChild(rect);
  }

  /** Build the foreignObject with rich HTML node body */
  _buildForeignObject() {
    var typeInfo = DAG_NODE_TYPES[this._data.type] || DAG_NODE_TYPES['sql-table'];
    var w = this._data.width;
    var h = this._data.height;

    var fo = document.createElementNS(DAG_NODE_SVG_NS, 'foreignObject');
    fo.setAttribute('x', '0');
    fo.setAttribute('y', '0');
    fo.setAttribute('width', String(w));
    fo.setAttribute('height', String(h));

    /* ─── XHTML body ─── */
    var body = document.createElementNS(DAG_NODE_XHTML_NS, 'div');
    body.setAttribute('class', 'iw-dag-node-body');

    /* Header row: icon | badge | name | delete */
    var header = document.createElementNS(DAG_NODE_XHTML_NS, 'div');
    header.setAttribute('class', 'iw-dag-node-header');

    var icon = document.createElementNS(DAG_NODE_XHTML_NS, 'span');
    icon.setAttribute('class', 'iw-dag-node-icon');
    icon.textContent = typeInfo.icon;
    this._iconEl = icon;

    var badge = document.createElementNS(DAG_NODE_XHTML_NS, 'span');
    badge.setAttribute('class', 'iw-dag-node-badge ' + typeInfo.badgeClass);
    badge.textContent = typeInfo.badge;
    this._badgeEl = badge;

    var name = document.createElementNS(DAG_NODE_XHTML_NS, 'span');
    name.setAttribute('class', 'iw-dag-node-name');
    name.setAttribute('title', this._data.name);
    name.textContent = this._data.name;
    this._nameEl = name;

    var del = document.createElementNS(DAG_NODE_XHTML_NS, 'button');
    del.setAttribute('class', 'iw-dag-node-delete');
    del.setAttribute('title', 'Remove node');
    del.textContent = '\u2715';
    this._deleteEl = del;

    header.appendChild(icon);
    header.appendChild(badge);
    header.appendChild(name);
    header.appendChild(del);

    /* Meta row: schema | sequence */
    var meta = document.createElementNS(DAG_NODE_XHTML_NS, 'div');
    meta.setAttribute('class', 'iw-dag-node-meta');

    var schema = document.createElementNS(DAG_NODE_XHTML_NS, 'span');
    schema.setAttribute('class', 'iw-dag-node-schema');
    schema.textContent = this._data.schema;
    this._schemaEl = schema;

    var seq = document.createElementNS(DAG_NODE_XHTML_NS, 'span');
    seq.setAttribute('class', 'iw-dag-node-seq');
    seq.textContent = '#' + this._data.sequenceNumber;
    this._seqEl = seq;

    meta.appendChild(schema);
    meta.appendChild(seq);

    body.appendChild(header);
    body.appendChild(meta);
    fo.appendChild(body);
    this._groupEl.appendChild(fo);
  }

  /** Build input and output connection ports */
  _buildPorts() {
    var cx = this._data.width / 2;
    var portR = 6;

    /* Input port — top center */
    var portIn = document.createElementNS(DAG_NODE_SVG_NS, 'circle');
    portIn.setAttribute('class', 'iw-dag-port iw-dag-port-in');
    portIn.setAttribute('cx', String(cx));
    portIn.setAttribute('cy', '0');
    portIn.setAttribute('r', String(portR));
    this._portIn = portIn;
    this._groupEl.appendChild(portIn);

    /* Output port — bottom center */
    var portOut = document.createElementNS(DAG_NODE_SVG_NS, 'circle');
    portOut.setAttribute('class', 'iw-dag-port iw-dag-port-out');
    portOut.setAttribute('cx', String(cx));
    portOut.setAttribute('cy', String(this._data.height));
    portOut.setAttribute('r', String(portR));
    this._portOut = portOut;
    this._groupEl.appendChild(portOut);
  }

  /* ═══════════════════════════════════════════════════════════════
     EVENT LISTENERS (private)
     ═══════════════════════════════════════════════════════════════ */

  _attachListeners() {
    var self = this;

    /* ─── Node click → select ─── */
    this._groupEl.addEventListener('click', function(e) {
      // Ignore clicks on delete button or ports
      if (e.target === self._deleteEl) return;
      if (e.target === self._portIn || e.target === self._portOut) return;
      if (self._onSelect) {
        self._onSelect(self, e);
      }
    });

    /* ─── Keyboard: Enter/Space → select ─── */
    this._groupEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (self._onSelect) {
          self._onSelect(self, e);
        }
      }
    });

    /* ─── Delete button ─── */
    this._deleteEl.addEventListener('click', function(e) {
      e.stopPropagation();
      if (self._onDelete) {
        self._onDelete(self, e);
      }
    });

    /* ─── Drag start on header ─── */
    this._groupEl.addEventListener('mousedown', function(e) {
      // Only left button
      if (e.button !== 0) return;
      // Ignore if clicking ports or delete
      if (e.target === self._deleteEl) return;
      if (e.target === self._portIn || e.target === self._portOut) return;

      e.preventDefault();

      self._dragState = {
        startX: e.clientX,
        startY: e.clientY,
        startNodeX: self._data.x,
        startNodeY: self._data.y
      };

      document.addEventListener('mousemove', self._boundDragMove);
      document.addEventListener('mouseup', self._boundDragEnd);

      if (self._onDragStart) {
        self._onDragStart(self, e);
      }
    });

    /* ─── Port mousedown → start connection ─── */
    this._portIn.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      if (self._onPortMouseDown) {
        self._onPortMouseDown(self, 'in', e);
      }
    });

    this._portOut.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      if (self._onPortMouseDown) {
        self._onPortMouseDown(self, 'out', e);
      }
    });

    /* ─── Port hover → connection snap ─── */
    this._portIn.addEventListener('mouseenter', function(e) {
      if (self._onPortMouseEnter) {
        self._onPortMouseEnter(self, 'in', e);
      }
    });

    this._portOut.addEventListener('mouseenter', function(e) {
      if (self._onPortMouseEnter) {
        self._onPortMouseEnter(self, 'out', e);
      }
    });

    /* ─── Hover → show ports ─── */
    this._groupEl.addEventListener('mouseenter', function() {
      self.showPorts(true);
    });

    this._groupEl.addEventListener('mouseleave', function() {
      // Keep ports visible if node is selected
      if (!self._selected) {
        self.showPorts(false);
      }
    });
  }

  /* ─── Drag move (document-level) ─── */
  _handleDragMove(e) {
    if (!this._dragState) return;
    if (this._onDragMove) {
      this._onDragMove(this, {
        clientX: e.clientX,
        clientY: e.clientY,
        startX: this._dragState.startX,
        startY: this._dragState.startY,
        startNodeX: this._dragState.startNodeX,
        startNodeY: this._dragState.startNodeY
      });
    }
  }

  /* ─── Drag end (document-level) ─── */
  _handleDragEnd(e) {
    document.removeEventListener('mousemove', this._boundDragMove);
    document.removeEventListener('mouseup', this._boundDragEnd);

    if (this._onDragEnd) {
      this._onDragEnd(this, e);
    }
    this._dragState = null;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════ */
window.DagNode = DagNode;
