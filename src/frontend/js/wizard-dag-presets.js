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
    id: 'single-source-mlv',
    title: 'Single Source MLV',
    subtitle: 'One table, one view — quickest FLT setup.',
    nodeCount: 2,
    badge: 'Quick Start',
    build: function(canvas, schemas) {
      var s = _dagPresetsPickSchema(schemas, 'source');
      var t = _dagPresetsPickSchema(schemas, 'target');
      var n1 = canvas.addNode('sql-table', null, { name: s.prefix + 'raw_data', schema: s.schema });
      var n2 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'data_view', schema: t.schema });
      canvas.addConnection(n1.id, n2.id);
    },
    svg: function() {
      return '<circle cx="30" cy="30" r="8" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="90" cy="30" r="8" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<line x1="38" y1="30" x2="82" y2="30" class="iw-dag-presets-line"/>';
    }
  },
  {
    id: 'multi-fact',
    title: 'Multi-Fact Aggregation',
    subtitle: 'Multiple source tables feeding one aggregated view.',
    nodeCount: 4,
    badge: 'Common',
    build: function(canvas, schemas) {
      var s = _dagPresetsPickSchema(schemas, 'source');
      var t = _dagPresetsPickSchema(schemas, 'target');
      var n1 = canvas.addNode('sql-table', null, { name: s.prefix + 'orders', schema: s.schema });
      var n2 = canvas.addNode('sql-table', null, { name: s.prefix + 'customers', schema: s.schema });
      var n3 = canvas.addNode('sql-table', null, { name: s.prefix + 'products', schema: s.schema });
      var n4 = canvas.addNode('sql-mlv', null, { name: t.prefix + 'sales_report', schema: t.schema });
      canvas.addConnection(n1.id, n4.id);
      canvas.addConnection(n2.id, n4.id);
      canvas.addConnection(n3.id, n4.id);
    },
    svg: function() {
      return '<circle cx="20" cy="12" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="20" cy="30" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="20" cy="48" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="95" cy="30" r="8" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<line x1="26" y1="14" x2="87" y2="28" class="iw-dag-presets-line"/>'
        + '<line x1="26" y1="30" x2="87" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="26" y1="46" x2="87" y2="32" class="iw-dag-presets-line"/>';
    }
  },
  {
    id: 'medallion',
    title: 'Medallion (Bronze \u2192 Silver \u2192 Gold)',
    subtitle: 'Industry-standard lakehouse pattern with 3 layers.',
    nodeCount: 7,
    badge: 'Best Practice',
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
      var g1 = canvas.addNode('pyspark-mlv', null, { name: gPre + 'analytics_summary', schema: gSchema });

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
    id: 'incremental-refresh',
    title: 'Incremental Refresh Pipeline',
    subtitle: 'Source \u2192 staging \u2192 incremental MLV \u2192 serving.',
    nodeCount: 4,
    badge: 'Advanced',
    build: function(canvas, schemas) {
      var hasMedallion = schemas.bronze || schemas.silver || schemas.gold;
      var bSchema = hasMedallion ? 'bronze' : 'dbo';
      var sSchema = hasMedallion ? 'silver' : 'dbo';
      var gSchema = hasMedallion ? 'gold' : 'dbo';

      var n1 = canvas.addNode('sql-table', null, { name: 'raw_events', schema: bSchema });
      var n2 = canvas.addNode('sql-mlv', null, { name: 'events_deduped', schema: sSchema });
      var n3 = canvas.addNode('sql-mlv', null, { name: 'events_enriched', schema: sSchema });
      var n4 = canvas.addNode('pyspark-mlv', null, { name: 'events_serving', schema: gSchema });

      canvas.addConnection(n1.id, n2.id);
      canvas.addConnection(n2.id, n3.id);
      canvas.addConnection(n3.id, n4.id);
    },
    svg: function() {
      return '<circle cx="10" cy="30" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="40" cy="30" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="70" cy="30" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="105" cy="30" r="7" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<line x1="16" y1="30" x2="35" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="45" y1="30" x2="65" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="75" y1="30" x2="98" y2="30" class="iw-dag-presets-line"/>';
    }
  },
  {
    id: 'multi-domain',
    title: 'Multi-Domain Lakehouse',
    subtitle: 'Sales + Inventory + Finance domains merging into unified gold.',
    nodeCount: 9,
    badge: 'Production',
    build: function(canvas, schemas) {
      var hasMedallion = schemas.bronze || schemas.silver || schemas.gold;
      var bSchema = hasMedallion ? 'bronze' : 'dbo';
      var sSchema = hasMedallion ? 'silver' : 'dbo';
      var gSchema = hasMedallion ? 'gold' : 'dbo';

      var t1 = canvas.addNode('sql-table', null, { name: 'raw_sales', schema: bSchema });
      var t2 = canvas.addNode('sql-table', null, { name: 'raw_inventory', schema: bSchema });
      var t3 = canvas.addNode('sql-table', null, { name: 'raw_finance', schema: bSchema });
      var m1 = canvas.addNode('sql-mlv', null, { name: 'sales_clean', schema: sSchema });
      var m2 = canvas.addNode('sql-mlv', null, { name: 'inventory_clean', schema: sSchema });
      var m3 = canvas.addNode('sql-mlv', null, { name: 'finance_clean', schema: sSchema });
      var p1 = canvas.addNode('pyspark-mlv', null, { name: 'revenue_metrics', schema: gSchema });
      var p2 = canvas.addNode('pyspark-mlv', null, { name: 'supply_chain_kpi', schema: gSchema });
      var p3 = canvas.addNode('sql-mlv', null, { name: 'executive_dashboard', schema: gSchema });

      canvas.addConnection(t1.id, m1.id);
      canvas.addConnection(t2.id, m2.id);
      canvas.addConnection(t3.id, m3.id);
      canvas.addConnection(m1.id, p1.id);
      canvas.addConnection(m2.id, p2.id);
      canvas.addConnection(m3.id, p1.id);
      canvas.addConnection(m1.id, p2.id);
      canvas.addConnection(p1.id, p3.id);
      canvas.addConnection(p2.id, p3.id);
    },
    svg: function() {
      return '<circle cx="8" cy="10" r="4" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="8" cy="30" r="4" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="8" cy="50" r="4" class="iw-dag-presets-dot iw-dag-presets-dot--source"/>'
        + '<circle cx="40" cy="10" r="4" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="40" cy="30" r="4" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="40" cy="50" r="4" class="iw-dag-presets-dot iw-dag-presets-dot--target"/>'
        + '<circle cx="75" cy="15" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<circle cx="75" cy="45" r="5" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<circle cx="108" cy="30" r="6" class="iw-dag-presets-dot iw-dag-presets-dot--gold"/>'
        + '<line x1="12" y1="10" x2="36" y2="10" class="iw-dag-presets-line"/>'
        + '<line x1="12" y1="30" x2="36" y2="30" class="iw-dag-presets-line"/>'
        + '<line x1="12" y1="50" x2="36" y2="50" class="iw-dag-presets-line"/>'
        + '<line x1="44" y1="12" x2="70" y2="15" class="iw-dag-presets-line"/>'
        + '<line x1="44" y1="30" x2="70" y2="44" class="iw-dag-presets-line"/>'
        + '<line x1="44" y1="48" x2="70" y2="17" class="iw-dag-presets-line iw-dag-presets-line--cross"/>'
        + '<line x1="44" y1="12" x2="70" y2="43" class="iw-dag-presets-line iw-dag-presets-line--cross"/>'
        + '<line x1="80" y1="17" x2="102" y2="28" class="iw-dag-presets-line"/>'
        + '<line x1="80" y1="43" x2="102" y2="32" class="iw-dag-presets-line"/>';
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
    this._hideTimer = null;
    this._unsubs = [];

    this._render();
    // Do NOT call _updateVisibility() here — the page is still hidden
    // (opacity:0, translateX(60px)). Showing + trapping focus while
    // detached causes lifecycle issues. DagCanvasPage.activate() calls
    // refreshVisibility() once the page is actually visible.

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

  /**
   * Re-assert overlay visibility based on current canvas state.
   * Called from DagCanvasPage.activate() to guarantee the overlay shows
   * on first visit (and on re-entry when the canvas is empty) regardless
   * of construction-time state — the constructor runs while the page is
   * detached and hidden, so any class set then may not survive layout
   * changes that happen between construction and the page becoming visible.
   */
  refreshVisibility() {
    this._updateVisibility();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
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

    // Cancel any pending hide timeout — this is the root cause of the
    // "presets not visible" bug.  show→hide→show within 200ms left a
    // stale timeout that removed --visible AFTER the second show ran.
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }

    var nodeCount = this._canvas ? this._canvas.getNodeCount() : 0;
    var shouldShow = nodeCount === 0 && !this._dismissed;
    if (shouldShow) {
      this._overlayEl.classList.remove('iw-dag-presets-overlay--exiting');
      this._overlayEl.classList.add('iw-dag-presets-overlay--visible');
      // Defensive: guarantee the overlay paints above every late-added sibling
      if (this._overlayEl.parentNode &&
          this._overlayEl.parentNode.lastElementChild !== this._overlayEl) {
        this._overlayEl.parentNode.appendChild(this._overlayEl);
      }
      this._overlayEl.style.zIndex = '500';
      this._overlayEl.style.opacity = '1';
      this._overlayEl.style.pointerEvents = 'auto';
      this._trapFocus();
    } else {
      // Animate out if currently visible
      if (this._overlayEl.classList.contains('iw-dag-presets-overlay--visible')) {
        var overlay = this._overlayEl;
        var self = this;
        overlay.classList.add('iw-dag-presets-overlay--exiting');
        this._hideTimer = setTimeout(function() {
          self._hideTimer = null;
          overlay.classList.remove('iw-dag-presets-overlay--visible');
          overlay.classList.remove('iw-dag-presets-overlay--exiting');
          overlay.style.opacity = '';
          overlay.style.pointerEvents = '';
        }, 200);
      } else {
        this._overlayEl.classList.remove('iw-dag-presets-overlay--visible');
        this._overlayEl.style.opacity = '';
        this._overlayEl.style.pointerEvents = '';
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
