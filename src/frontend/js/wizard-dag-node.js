/**
 * DagNode — HTML div-based node component for the DAG canvas.
 *
 * Renders as <div class="iw-nd"> with absolute positioning inside .iw-dag-world.
 * 3 node types: sql-table, sql-mlv, pyspark-mlv with distinct icons/badges.
 * Supports drag, select, type/schema change, delete.
 *
 * Previously SVG <g> + <foreignObject>; rewritten to plain HTML divs to fix
 * foreignObject rendering quirks and match the dag-canvas mock.
 *
 * CSS prefix: .iw-nd / .iw-pt
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   NODE TYPE REGISTRY
   ═══════════════════════════════════════════════════════════════════ */

var DAG_NODE_TYPES = {
  'sql-table':   { icon: '\u25C7', badge: 'TBL', iconCls: 't', badgeCls: 't' },
  'sql-mlv':     { icon: '\u25C6', badge: 'MLV', iconCls: 'm', badgeCls: 'm' },
  'pyspark-mlv': { icon: '\u25C7', badge: 'PY',  iconCls: 'p', badgeCls: 'p' }
};

/* ═══════════════════════════════════════════════════════════════════
   DAG NODE
   ═══════════════════════════════════════════════════════════════════ */

class DagNode {

  /**
   * @param {object} options
   * @param {object} options.data        — DagNodeData object
   * @param {HTMLElement} options.parentGroup — parent .iw-dag-world to append to
   *                                            (kept as `parentGroup` for API compatibility)
   * @param {object} options.eventBus    — WizardEventBus instance
   * @param {object} [options.schemas]   — enabled schemas {dbo: true, ...}
   * @param {Function} [options.onSelect]         — node clicked
   * @param {Function} [options.onDelete]         — delete requested (unused; popover owns delete)
   * @param {Function} [options.onDragStart]      — drag begins
   * @param {Function} [options.onDragMove]       — drag moves
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
    this._visible = true;

    /* ─── Callbacks ─── */
    this._onSelect = options.onSelect || null;
    this._onDelete = options.onDelete || null;
    this._onDragStart = options.onDragStart || null;
    this._onDragMove = options.onDragMove || null;
    this._onDragEnd = options.onDragEnd || null;
    this._onPortMouseDown = options.onPortMouseDown || null;
    this._onPortMouseEnter = options.onPortMouseEnter || null;

    /* ─── Build HTML structure ─── */
    this._buildElement();
    this._attachListeners();

    /* ─── Append to parent ─── */
    if (options.parentGroup) {
      options.parentGroup.appendChild(this._groupEl);
    }

    /* ─── Enter animation ─── */
    this._groupEl.classList.add('iw-node--entering');
    var enterEl = this._groupEl;
    setTimeout(function() {
      if (enterEl) enterEl.classList.remove('iw-node--entering');
    }, 250);

    /* ─── Bound handlers (stored for cleanup) ─── */
    this._boundDragMove = function(e) { self._handleDragMove(e); };
    this._boundDragEnd = function(e) { self._handleDragEnd(e); };
  }

  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════ */

  /** @returns {HTMLDivElement} The root node element */
  getElement() {
    return this._groupEl;
  }

  /** @returns {HTMLDivElement} The root node element (alias for animation helpers) */
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

  /** Update node position (canvas/world space px) */
  setPosition(x, y) {
    this._data.x = x;
    this._data.y = y;
    if (this._groupEl) {
      this._groupEl.style.left = x + 'px';
      this._groupEl.style.top = y + 'px';
    }
  }

  /**
   * Show or hide this node for viewport culling.
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
    if (!this._groupEl) return;
    if (this._selected) {
      this._groupEl.classList.add('iw-nd-selected');
      this._groupEl.setAttribute('aria-pressed', 'true');
    } else {
      this._groupEl.classList.remove('iw-nd-selected');
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
    if (this._groupEl) {
      this._groupEl.setAttribute('data-type', type);
    }
    if (this._iconEl) {
      this._iconEl.textContent = info.icon;
      this._iconEl.className = 'iw-nd-ico ' + info.iconCls;
    }
    if (this._badgeEl) {
      this._badgeEl.textContent = info.badge;
      this._badgeEl.className = 'iw-nd-badge ' + info.badgeCls;
    }
    this._updateAriaLabel();
  }

  /** Change node schema */
  setSchema(schema) {
    this._data.schema = schema;
    if (this._groupEl) {
      this._groupEl.setAttribute('data-schema', schema);
    }
    if (this._schemaEl) {
      this._schemaEl.textContent = schema;
      this._schemaEl.setAttribute('data-s', schema);
    }
    this._updateAriaLabel();
  }

  /** Update node with new data (name, type, schema) */
  update(data) {
    if (data.name !== undefined) this.setName(data.name);
    if (data.type !== undefined) this.setType(data.type);
    if (data.schema !== undefined) this.setSchema(data.schema);
  }

  /** Get input port center position in canvas/world space */
  getInputPortPosition() {
    return {
      x: this._data.x + this._data.width / 2,
      y: this._data.y
    };
  }

  /** Get output port center position in canvas/world space */
  getOutputPortPosition() {
    return {
      x: this._data.x + this._data.width / 2,
      y: this._data.y + this._data.height
    };
  }

  /** Show/hide connection ports */
  showPorts(visible) {
    if (!this._groupEl) return;
    if (visible) {
      this._groupEl.classList.add('iw-nd-show-ports');
    } else {
      this._groupEl.classList.remove('iw-nd-show-ports');
    }
  }

  /** Destroy — animate out, remove DOM, clean up listeners */
  destroy() {
    document.removeEventListener('mousemove', this._boundDragMove);
    document.removeEventListener('mouseup', this._boundDragEnd);

    var el = this._groupEl;
    if (el) {
      el.classList.add('iw-node--exiting');
      setTimeout(function() {
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }, 180);
    }

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
    this._barEl = null;
    this._portIn = null;
    this._portOut = null;
    this._boundDragMove = null;
    this._boundDragEnd = null;
    this._dragState = null;
  }

  /* ═══════════════════════════════════════════════════════════════
     BUILD HELPERS (private)
     ═══════════════════════════════════════════════════════════════ */

  _updateAriaLabel() {
    if (!this._groupEl || !this._data) return;
    var typeLabel = this._data.type.replace(/-/g, ' ');
    this._groupEl.setAttribute('aria-label',
      typeLabel + ': ' + this._data.name + ' \u2014 ' + this._data.schema + ' schema');
  }

  _buildElement() {
    var d = this._data;
    var typeInfo = DAG_NODE_TYPES[d.type] || DAG_NODE_TYPES['sql-table'];

    /* Root */
    var root = document.createElement('div');
    root.className = 'iw-nd';
    root.setAttribute('data-node-id', d.id);
    root.setAttribute('data-schema', d.schema);
    root.setAttribute('data-type', d.type);
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    root.style.left = d.x + 'px';
    root.style.top = d.y + 'px';
    root.style.width = d.width + 'px';
    root.style.height = d.height + 'px';
    this._groupEl = root;
    this._updateAriaLabel();

    /* Schema color bar */
    var bar = document.createElement('div');
    bar.className = 'iw-nd-bar';
    this._barEl = bar;
    root.appendChild(bar);

    /* Body */
    var body = document.createElement('div');
    body.className = 'iw-nd-body';

    /* Header: icon + name */
    var hdr = document.createElement('div');
    hdr.className = 'iw-nd-hdr';

    var icon = document.createElement('span');
    icon.className = 'iw-nd-ico ' + typeInfo.iconCls;
    icon.textContent = typeInfo.icon;
    this._iconEl = icon;

    var name = document.createElement('span');
    name.className = 'iw-nd-name';
    name.setAttribute('title', d.name);
    name.textContent = d.name;
    this._nameEl = name;

    hdr.appendChild(icon);
    hdr.appendChild(name);

    /* Meta: type badge + schema */
    var meta = document.createElement('div');
    meta.className = 'iw-nd-meta';

    var badge = document.createElement('span');
    badge.className = 'iw-nd-badge ' + typeInfo.badgeCls;
    badge.textContent = typeInfo.badge;
    this._badgeEl = badge;

    var schemaEl = document.createElement('span');
    schemaEl.className = 'iw-nd-schema';
    schemaEl.setAttribute('data-s', d.schema);
    schemaEl.textContent = d.schema;
    this._schemaEl = schemaEl;

    meta.appendChild(badge);
    meta.appendChild(schemaEl);

    body.appendChild(hdr);
    body.appendChild(meta);
    root.appendChild(body);

    /* Ports */
    var portIn = document.createElement('div');
    portIn.className = 'iw-nd-port iw-pt-in';
    portIn.setAttribute('data-port', 'in');
    this._portIn = portIn;
    root.appendChild(portIn);

    var portOut = document.createElement('div');
    portOut.className = 'iw-nd-port iw-pt-out';
    portOut.setAttribute('data-port', 'out');
    this._portOut = portOut;
    root.appendChild(portOut);
  }

  /* ═══════════════════════════════════════════════════════════════
     EVENT LISTENERS (private)
     ═══════════════════════════════════════════════════════════════ */

  _attachListeners() {
    var self = this;
    var root = this._groupEl;

    /* Click → select (suppress if click was a port) */
    root.addEventListener('click', function(e) {
      if (e.target === self._portIn || e.target === self._portOut) return;
      if (self._onSelect) {
        self._onSelect(self, e);
      }
    });

    /* Keyboard: Enter/Space → select */
    root.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (self._onSelect) {
          self._onSelect(self, e);
        }
      }
    });

    /* Drag start on body */
    root.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      if (e.target === self._portIn || e.target === self._portOut) return;

      e.preventDefault();
      e.stopPropagation();

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

    /* Port mousedown → start connection */
    this._portIn.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      e.preventDefault();
      if (self._onPortMouseDown) {
        var pos = self.getInputPortPosition();
        self._onPortMouseDown({ nodeId: self._data.id, x: pos.x, y: pos.y });
      }
    });

    this._portOut.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      e.preventDefault();
      if (self._onPortMouseDown) {
        var pos = self.getOutputPortPosition();
        self._onPortMouseDown({ nodeId: self._data.id, x: pos.x, y: pos.y });
      }
    });

    /* Port hover → connection snap */
    this._portIn.addEventListener('mouseenter', function(e) {
      if (self._onPortMouseEnter) {
        var pos = self.getInputPortPosition();
        self._onPortMouseEnter({ nodeId: self._data.id, side: 'in', x: pos.x, y: pos.y }, e);
      }
    });

    this._portOut.addEventListener('mouseenter', function(e) {
      if (self._onPortMouseEnter) {
        var pos = self.getOutputPortPosition();
        self._onPortMouseEnter({ nodeId: self._data.id, side: 'out', x: pos.x, y: pos.y }, e);
      }
    });

    /* Hover → show ports (CSS handles the visibility) */
    root.addEventListener('mouseenter', function() {
      self.showPorts(true);
    });
    root.addEventListener('mouseleave', function() {
      if (!self._selected) {
        self.showPorts(false);
      }
    });
  }

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
