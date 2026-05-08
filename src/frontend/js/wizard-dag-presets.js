/**
 * DagPresets — Empty-canvas overlay showing preset DAG topologies.
 *
 * Displays a centered card grid when the DAG canvas has 0 nodes.
 * User clicks a preset to auto-populate nodes + connections, or
 * clicks "Start from scratch" to dismiss without adding anything.
 *
 * CEO-approved decision D6: "Show preset cards on empty canvas,
 * but user may skip them."
 *
 * CSS prefix: .iw-dag-presets-*
 * @author Pixel — EDOG Studio hivemind
 */

/* global DagCanvas, WizardEventBus, IW_EVENTS */

var DAG_PRESETS_DATA = [
  {
    id: 'simple-chain',
    title: 'Simple Chain',
    subtitle: 'Hello World of DAGs.',
    nodeCount: 2,
    badge: 'Beginner',
    build: function(canvas, schemas) {
      var s = _dagPresetsPickSchema(schemas, 'source');
      var t = _dagPresetsPickSchema(schemas, 'target');
      var n1 = canvas.addNode('sql-table', null, { name: s.prefix + 'orders', schema: s.schema });
      var n2 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'orders_view', schema: t.schema });
      canvas.addConnection(n1.id, n2.id);
    },
    // SVG path data for mini topology preview
    svg: function() {
      return '<circle cx="30" cy="30" r="8" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="90" cy="30" r="8" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<line x1="38" y1="30" x2="82" y2="30" class="iw-dag-presets-line"/>';
    }
  },
  {
    id: 'fan-out',
    title: 'Fan-Out',
    subtitle: 'One source, many views.',
    nodeCount: 4,
    badge: 'Beginner',
    build: function(canvas, schemas) {
      var s = _dagPresetsPickSchema(schemas, 'source');
      var t = _dagPresetsPickSchema(schemas, 'target');
      var n1 = canvas.addNode('sql-table', null, { name: s.prefix + 'customers', schema: s.schema });
      var n2 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'customers_active', schema: t.schema });
      var n3 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'customers_churned', schema: t.schema });
      var n4 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'customers_summary', schema: t.schema });
      canvas.addConnection(n1.id, n2.id);
      canvas.addConnection(n1.id, n3.id);
      canvas.addConnection(n1.id, n4.id);
    },
    svg: function() {
      return '<circle cx="20" cy="30" r="7" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="90" cy="12" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="90" cy="30" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="90" cy="48" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<line x1="27" y1="28" x2="84" y2="12" class="iw-dag-presets-line"/>'
        + '<line x1="27" y1="30" x2="84" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="27" y1="32" x2="84" y2="48" class="iw-dag-presets-line"/>';
    }
  },
  {
    id: 'diamond',
    title: 'Diamond',
    subtitle: 'Converging pipeline.',
    nodeCount: 5,
    badge: 'Intermediate',
    build: function(canvas, schemas) {
      var s = _dagPresetsPickSchema(schemas, 'source');
      var t = _dagPresetsPickSchema(schemas, 'target');
      var n1 = canvas.addNode('sql-table', null, { name: s.prefix + 'sales', schema: s.schema });
      var n2 = canvas.addNode('sql-table', null, { name: s.prefix + 'inventory', schema: s.schema });
      var n3 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'sales_clean', schema: t.schema });
      var n4 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'inventory_clean', schema: t.schema });
      var n5 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'merged_report', schema: t.schema });
      canvas.addConnection(n1.id, n3.id);
      canvas.addConnection(n2.id, n4.id);
      canvas.addConnection(n3.id, n5.id);
      canvas.addConnection(n4.id, n5.id);
      canvas.addConnection(n1.id, n4.id);
      canvas.addConnection(n2.id, n3.id);
    },
    svg: function() {
      return '<circle cx="15" cy="16" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="15" cy="44" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="55" cy="16" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="55" cy="44" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="100" cy="30" r="7" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<line x1="21" y1="16" x2="49" y2="16" class="iw-dag-presets-line"/>'
        + '<line x1="21" y1="44" x2="49" y2="44" class="iw-dag-presets-line"/>'
        + '<line x1="61" y1="18" x2="93" y2="28" class="iw-dag-presets-line"/>'
        + '<line x1="61" y1="42" x2="93" y2="32" class="iw-dag-presets-line"/>'
        + '<line x1="21" y1="20" x2="49" y2="40" class="iw-dag-presets-line iw-dag-presets-line--cross"/>'
        + '<line x1="21" y1="40" x2="49" y2="20" class="iw-dag-presets-line iw-dag-presets-line--cross"/>';
    }
  },
  {
    id: 'medallion',
    title: 'Medallion Pipeline',
    subtitle: 'Bronze \u2192 Silver \u2192 Gold.',
    nodeCount: 7,
    badge: 'Intermediate',
    build: function(canvas, schemas) {
      var hasMedallion = schemas.bronze || schemas.silver || schemas.gold;
      var bSchema = hasMedallion ? 'bronze' : 'dbo';
      var sSchema = hasMedallion ? 'silver' : 'dbo';
      var gSchema = hasMedallion ? 'gold' : 'dbo';
      var bPre = hasMedallion ? 'brz_' : '';
      var sPre = hasMedallion ? 'slv_' : '';
      var gPre = hasMedallion ? 'gld_' : '';

      var b1 = canvas.addNode('sql-table', null, { name: bPre + 'raw_orders', schema: bSchema });
      var b2 = canvas.addNode('sql-table', null, { name: bPre + 'raw_customers', schema: bSchema });
      var b3 = canvas.addNode('sql-table', null, { name: bPre + 'raw_products', schema: bSchema });
      var s1 = canvas.addNode('sql-mlv', null, { name: sPre + 'orders_clean', schema: sSchema });
      var s2 = canvas.addNode('sql-mlv', null, { name: sPre + 'customers_clean', schema: sSchema });
      var s3 = canvas.addNode('sql-mlv', null, { name: sPre + 'products_clean', schema: sSchema });
      var g1 = canvas.addNode('pyspark-mlv', null, { name: gPre + 'analytics_gold', schema: gSchema });

      canvas.addConnection(b1.id, s1.id);
      canvas.addConnection(b2.id, s2.id);
      canvas.addConnection(b3.id, s3.id);
      canvas.addConnection(s1.id, g1.id);
      canvas.addConnection(s2.id, g1.id);
      canvas.addConnection(s3.id, g1.id);
    },
    svg: function() {
      return '<circle cx="10" cy="10" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="10" cy="30" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="10" cy="50" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="55" cy="10" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="55" cy="30" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="55" cy="50" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="105" cy="30" r="7" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<line x1="15" y1="10" x2="50" y2="10" class="iw-dag-presets-line"/>'
        + '<line x1="15" y1="30" x2="50" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="15" y1="50" x2="50" y2="50" class="iw-dag-presets-line"/>'
        + '<line x1="60" y1="12" x2="98" y2="27" class="iw-dag-presets-line"/>'
        + '<line x1="60" y1="30" x2="98" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="60" y1="48" x2="98" y2="33" class="iw-dag-presets-line"/>';
    }
  },
  {
    id: 'full-pipeline',
    title: 'Full Pipeline',
    subtitle: 'Production-grade topology.',
    nodeCount: 8,
    badge: 'Advanced',
    build: function(canvas, schemas) {
      var s = _dagPresetsPickSchema(schemas, 'source');
      var t = _dagPresetsPickSchema(schemas, 'target');

      var t1 = canvas.addNode('sql-table', null, { name: s.prefix + 'events', schema: s.schema });
      var t2 = canvas.addNode('sql-table', null, { name: s.prefix + 'users', schema: s.schema });
      var t3 = canvas.addNode('sql-table', null, { name: s.prefix + 'products', schema: s.schema });
      var m1 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'events_enriched', schema: t.schema });
      var m2 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'user_profiles', schema: t.schema });
      var m3 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'product_catalog', schema: t.schema });
      var p1 = canvas.addNode('pyspark-mlv', null, { name: t.prefix + 'recommendations', schema: t.schema });
      var p2 = canvas.addNode('pyspark-mlv', null, { name: t.prefix + 'anomaly_detect', schema: t.schema });

      canvas.addConnection(t1.id, m1.id);
      canvas.addConnection(t2.id, m2.id);
      canvas.addConnection(t3.id, m3.id);
      canvas.addConnection(m1.id, p1.id);
      canvas.addConnection(m2.id, p1.id);
      canvas.addConnection(m3.id, p1.id);
      canvas.addConnection(m1.id, p2.id);
      canvas.addConnection(m2.id, p2.id);
    },
    svg: function() {
      return '<circle cx="8" cy="10" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="8" cy="30" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="8" cy="50" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="45" cy="10" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="45" cy="30" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="45" cy="50" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="95" cy="18" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<circle cx="95" cy="42" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<line x1="13" y1="10" x2="40" y2="10" class="iw-dag-presets-line"/>'
        + '<line x1="13" y1="30" x2="40" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="13" y1="50" x2="40" y2="50" class="iw-dag-presets-line"/>'
        + '<line x1="50" y1="12" x2="89" y2="17" class="iw-dag-presets-line"/>'
        + '<line x1="50" y1="30" x2="89" y2="19" class="iw-dag-presets-line"/>'
        + '<line x1="50" y1="48" x2="89" y2="20" class="iw-dag-presets-line"/>'
        + '<line x1="50" y1="12" x2="89" y2="40" class="iw-dag-presets-line iw-dag-presets-line--cross"/>'
        + '<line x1="50" y1="30" x2="89" y2="42" class="iw-dag-presets-line iw-dag-presets-line--cross"/>';
    }
  }
];

// ── Schema helper ──────────────────────────────────────────────────

function _dagPresetsPickSchema(schemas, role) {
  if (role === 'source') {
    if (schemas.bronze) return { schema: 'bronze', prefix: 'brz_' };
    return { schema: 'dbo', prefix: '' };
  }
  // target
  if (schemas.silver) return { schema: 'silver', prefix: 'slv_' };
  if (schemas.gold) return { schema: 'gold', prefix: 'gld_' };
  return { schema: 'dbo', prefix: '' };
}

// ═══════════════════════════════════════════════════════════════════
//  DagPresets CLASS
// ═══════════════════════════════════════════════════════════════════

class DagPresets {

  /**
   * @param {object} options
   * @param {HTMLElement} options.containerEl — the DAG canvas container element
   * @param {DagCanvas} options.dagCanvas — DagCanvas instance
   * @param {WizardEventBus} options.eventBus — event bus
   * @param {object} options.schemas — enabled schemas from wizard state
   */
  constructor(options) {
    var self = this;
    this._containerEl = options.containerEl;
    this._canvas = options.dagCanvas;
    this._eventBus = options.eventBus;
    this._schemas = options.schemas || { dbo: true, bronze: false, silver: false, gold: false };
    this._dismissed = false;
    this._destroyed = false;
    this._overlayEl = null;
    this._unsubs = [];

    this._render();
    this._updateVisibility();

    // Listen for node add/remove to show/hide
    this._unsubs.push(
      this._eventBus.on(IW_EVENTS.NODE_ADDED, function() {
        self._updateVisibility();
      })
    );
    this._unsubs.push(
      this._eventBus.on(IW_EVENTS.NODE_REMOVED, function() {
        self._dismissed = false;
        self._updateVisibility();
      })
    );
  }

  // ── Public ──────────────────────────────────────────────────────

  updateSchemas(schemas) {
    this._schemas = schemas || this._schemas;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._releaseFocusTrap();
    var i;
    for (i = 0; i < this._unsubs.length; i++) {
      this._unsubs[i]();
    }
    this._unsubs = [];
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
    }
    this._overlayEl = null;
    this._containerEl = null;
    this._canvas = null;
    this._eventBus = null;
  }

  // ── Private: Render ─────────────────────────────────────────────

  _render() {
    var self = this;
    var overlay = document.createElement('div');
    overlay.className = 'iw-dag-presets-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    var inner = document.createElement('div');
    inner.className = 'iw-dag-presets-inner';

    // Header
    var header = document.createElement('div');
    header.className = 'iw-dag-presets-header';
    var headingId = 'iw-presets-heading-' + Date.now();
    header.innerHTML = '<span class="iw-dag-presets-heading" id="' + headingId + '">Start with a Preset</span>'
      + '<span class="iw-dag-presets-subheading">Pick a topology to auto-populate your canvas, or start from scratch.</span>';
    overlay.setAttribute('aria-labelledby', headingId);
    inner.appendChild(header);

    // Card grid
    var grid = document.createElement('div');
    grid.className = 'iw-dag-presets-grid';

    var i;
    for (i = 0; i < DAG_PRESETS_DATA.length; i++) {
      var card = this._buildCard(DAG_PRESETS_DATA[i], i);
      grid.appendChild(card);
    }
    inner.appendChild(grid);

    // "Start from scratch" link
    var scratch = document.createElement('button');
    scratch.className = 'iw-dag-presets-scratch';
    scratch.type = 'button';
    scratch.textContent = 'Start from scratch';
    scratch.addEventListener('click', function(e) {
      e.stopPropagation();
      self._dismiss();
    });
    inner.appendChild(scratch);

    overlay.appendChild(inner);
    this._overlayEl = overlay;
    this._containerEl.appendChild(overlay);
  }

  _buildCard(preset, index) {
    var self = this;
    var card = document.createElement('button');
    card.className = 'iw-dag-presets-card';
    card.type = 'button';
    card.style.animationDelay = (index * 60) + 'ms';

    // Mini SVG preview
    var svgWrap = document.createElement('div');
    svgWrap.className = 'iw-dag-presets-svg-wrap';
    svgWrap.innerHTML = '<svg viewBox="0 0 120 60" class="iw-dag-presets-svg">'
      + preset.svg() + '</svg>';
    card.appendChild(svgWrap);

    // Text content
    var body = document.createElement('div');
    body.className = 'iw-dag-presets-card-body';

    var title = document.createElement('div');
    title.className = 'iw-dag-presets-card-title';
    title.textContent = preset.title;
    body.appendChild(title);

    var subtitle = document.createElement('div');
    subtitle.className = 'iw-dag-presets-card-subtitle';
    subtitle.textContent = preset.subtitle;
    body.appendChild(subtitle);

    // Stats line
    var stats = document.createElement('div');
    stats.className = 'iw-dag-presets-card-stats';
    stats.innerHTML = '<span class="iw-dag-presets-stat">' + preset.nodeCount + ' nodes</span>'
      + '<span class="iw-dag-presets-badge iw-dag-presets-badge--' + preset.badge.toLowerCase() + '">'
      + preset.badge + '</span>';
    body.appendChild(stats);

    card.appendChild(body);

    card.addEventListener('click', function(e) {
      e.stopPropagation();
      self._applyPreset(preset);
    });

    return card;
  }

  // ── Private: Logic ──────────────────────────────────────────────

  _applyPreset(preset) {
    if (!this._canvas) return;
    var canvas = this._canvas;
    var schemas = this._schemas;
    if (typeof canvas.batchOperation === 'function') {
      canvas.batchOperation(function() {
        preset.build(canvas, schemas);
      });
    } else {
      preset.build(canvas, schemas);
    }
    canvas.autoLayout();
    this._dismissed = true;
    this._updateVisibility();
  }

  _dismiss() {
    this._dismissed = true;
    this._updateVisibility();
  }

  _updateVisibility() {
    if (this._destroyed || !this._overlayEl) return;
    var nodeCount = this._canvas ? this._canvas.getNodeCount() : 0;
    var shouldShow = nodeCount === 0 && !this._dismissed;
    if (shouldShow) {
      this._overlayEl.classList.remove('iw-dag-presets-overlay--exiting');
      this._overlayEl.classList.add('iw-dag-presets-overlay--visible');
      this._trapFocus();
    } else {
      // Animate out if currently visible
      if (this._overlayEl.classList.contains('iw-dag-presets-overlay--visible')) {
        var overlay = this._overlayEl;
        overlay.classList.add('iw-dag-presets-overlay--exiting');
        setTimeout(function() {
          overlay.classList.remove('iw-dag-presets-overlay--visible');
          overlay.classList.remove('iw-dag-presets-overlay--exiting');
        }, 200);
      } else {
        this._overlayEl.classList.remove('iw-dag-presets-overlay--visible');
      }
      this._releaseFocusTrap();
    }
  }

  /** Trap focus inside the presets overlay */
  _trapFocus() {
    var self = this;
    this._releaseFocusTrap();
    var container = this._overlayEl;
    this._focusTrapHandler = function(e) {
      if (e.key !== 'Tab') return;
      var focusable = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { last.focus(); e.preventDefault(); }
      } else {
        if (document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    container.addEventListener('keydown', this._focusTrapHandler);
    // Focus first interactive element
    var firstBtn = container.querySelector('button');
    if (firstBtn) firstBtn.focus();
  }

  /** Release focus trap */
  _releaseFocusTrap() {
    if (this._focusTrapHandler && this._overlayEl) {
      this._overlayEl.removeEventListener('keydown', this._focusTrapHandler);
    }
    this._focusTrapHandler = null;
  }
}

window.DagPresets = DagPresets;
