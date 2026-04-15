/**
 * Sidebar — Concept A: The Linear Dock.
 *
 * 52px icon rail that expands to 224px on hover.
 * Spring-physics timing, runtime sub-tabs, token health ring,
 * phase indicator, keyboard shortcuts.
 *
 * Public API (backward-compatible with main.js):
 *   constructor()
 *   init()
 *   switchView(viewId)        — 'workspace' | 'runtime' | 'api' | 'environment'
 *   setPhase(phase)           — 'disconnected' | 'connected'
 *   getActiveView()           — returns current viewId
 *   onViewChange              — callback: (viewId) => void
 *
 * New methods:
 *   setActiveSubTab(tabId)    — sync sidebar sub-tab highlight
 *   setTokenHealth(status, timeLabel) — update token ring
 */
class Sidebar {
  constructor() {
    this._el = null;
    this._navItems = [];
    this._activeView = 'workspace';
    this._activeSubTab = 'logs';
    this._phase = 'disconnected';
    this._internalsOpen = false;
    this._expandTimeout = null;
    this._collapseTimeout = null;
    this._tokenObserver = null;

    /* DOM references — populated in init() */
    this._runtimeNav = null;
    this._runtimeBadge = null;
    this._runtimeSubitems = null;
    this._internalsGroup = null;
    this._internalsChevron = null;
    this._phaseDot = null;
    this._phaseLabel = null;
    this._tokenRingFg = null;
    this._tokenTimeEl = null;

    /** @type {((viewId: string) => void)|null} */
    this.onViewChange = null;
  }

  init() {
    this._el = document.getElementById('sidebar');
    if (!this._el) return;

    this._navItems = Array.from(this._el.querySelectorAll('.nav-item[data-view]'));
    this._runtimeNav = document.getElementById('runtime-nav');
    this._runtimeBadge = document.getElementById('runtime-badge');
    this._runtimeSubitems = document.getElementById('runtime-subitems');
    this._internalsGroup = document.getElementById('internals-group');
    this._internalsChevron = document.getElementById('internals-chevron');
    this._phaseDot = document.getElementById('sidebar-phase-dot');
    this._phaseLabel = document.getElementById('sidebar-phase-label');
    this._tokenRingFg = document.getElementById('sidebar-token-ring-fg');
    this._tokenTimeEl = document.getElementById('sidebar-token-time');

    this._bindHover();
    this._bindNavClicks();
    this._bindSubTabClicks();
    this._bindInternalsToggle();
    this._bindKeyboard();
    this._observeLegacyTokenDot();

    /* Restore saved view (if still valid) */
    const saved = localStorage.getItem('edog-active-view');
    if (saved && this._getNavItem(saved) && !this._getNavItem(saved).classList.contains('disabled')) {
      this.switchView(saved);
    }
  }

  /* ── Public API ── */

  switchView(viewId) {
    if (viewId === this._activeView) return;
    const item = this._getNavItem(viewId);
    if (!item || item.classList.contains('disabled')) return;

    this._navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('view-' + viewId);
    if (panel) panel.classList.add('active');

    this._activeView = viewId;
    localStorage.setItem('edog-active-view', viewId);

    /* Show/hide runtime subitems */
    this._updateSubitemsVisibility();

    if (this.onViewChange) this.onViewChange(viewId);
  }

  setPhase(phase) {
    this._phase = phase;
    const connectedItems = [];

    this._navItems.forEach(item => {
      const itemPhase = item.dataset.phase;
      if (itemPhase === 'connected') {
        connectedItems.push(item);
        if (phase === 'disconnected') {
          item.classList.add('disabled');
        }
      } else {
        item.classList.remove('disabled');
      }
    });

    if (phase === 'connected') {
      /* Cascade-enable connected items with stagger */
      connectedItems.forEach((item, i) => {
        setTimeout(() => {
          item.classList.remove('disabled');
          item.classList.add('cascade-in');
          setTimeout(() => item.classList.remove('cascade-in'), 400);
        }, i * 150);
      });
    }

    /* Update badge */
    if (this._runtimeBadge) {
      this._runtimeBadge.className = phase === 'connected'
        ? 'nav-badge connected'
        : 'nav-badge disconnected';
    }

    /* Update phase dot + label */
    if (this._phaseDot) {
      this._phaseDot.className = phase === 'connected'
        ? 'phase-dot connected'
        : 'phase-dot disconnected';
    }
    if (this._phaseLabel) {
      this._phaseLabel.textContent = phase === 'connected'
        ? 'Connected'
        : 'Browsing';
    }

    /* Show/hide subitems */
    this._updateSubitemsVisibility();

    /* Collapse internals on disconnect */
    if (phase === 'disconnected') {
      this._internalsOpen = false;
      if (this._internalsGroup) this._internalsGroup.classList.remove('open');
      if (this._internalsChevron) this._internalsChevron.classList.remove('open');
    }

    /* If active view is now disabled, fall back to workspace */
    const activeItem = this._getNavItem(this._activeView);
    if (activeItem && activeItem.classList.contains('disabled')) {
      this.switchView('workspace');
    }
  }

  getActiveView() {
    return this._activeView;
  }

  /** Sync sidebar sub-tab highlight (called by main.js or RuntimeView). */
  setActiveSubTab(tabId) {
    if (!tabId) return;
    this._activeSubTab = tabId;
    this._highlightSubTab(tabId);
  }

  /** Update token health ring display. */
  setTokenHealth(status, timeLabel) {
    const circumference = 53.4;
    if (this._tokenRingFg) {
      this._tokenRingFg.className.baseVal = 'ring-fg ' + (status || '');
      const offsets = { healthy: 0.25, warning: 0.75, expired: 1, none: 1 };
      const offset = circumference * (offsets[status] ?? 1);
      this._tokenRingFg.setAttribute('stroke-dashoffset', String(offset));
    }
    if (this._tokenTimeEl) {
      this._tokenTimeEl.className = 'token-time ' + (status || '');
      this._tokenTimeEl.textContent = timeLabel || '';
    }
  }

  /* ── Hover expand/collapse ── */

  _bindHover() {
    this._el.addEventListener('mouseenter', () => {
      clearTimeout(this._collapseTimeout);
      this._expandTimeout = setTimeout(() => {
        this._el.classList.add('expanded');
      }, 80);
    });

    this._el.addEventListener('mouseleave', () => {
      clearTimeout(this._expandTimeout);
      this._collapseTimeout = setTimeout(() => {
        this._el.classList.remove('expanded');
      }, 220);
    });
  }

  /* ── Nav item clicks ── */

  _bindNavClicks() {
    this._navItems.forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('disabled')) return;
        this.switchView(item.dataset.view);
      });
      /* Keyboard activation for a11y */
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!item.classList.contains('disabled')) {
            this.switchView(item.dataset.view);
          }
        }
      });
    });
  }

  /* ── Runtime sub-tab clicks ── */

  _bindSubTabClicks() {
    const subItems = this._el.querySelectorAll('.sub-item[data-subtab]');
    subItems.forEach(item => {
      item.addEventListener('click', () => {
        const tabId = item.dataset.subtab;
        this._switchSubTab(tabId);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._switchSubTab(item.dataset.subtab);
        }
      });
    });
  }

  _switchSubTab(tabId) {
    this._activeSubTab = tabId;
    this._highlightSubTab(tabId);

    /* If not on runtime view, switch to it first */
    if (this._activeView !== 'runtime') {
      this.switchView('runtime');
    }

    /* Tell RuntimeView to switch its tab content */
    const rv = window.edogApp && window.edogApp.runtimeView;
    if (rv && typeof rv.switchTab === 'function') {
      rv.switchTab(tabId);
    }
  }

  _highlightSubTab(tabId) {
    if (!this._el) return;
    this._el.querySelectorAll('.sub-item[data-subtab]').forEach(item => {
      item.classList.toggle('active', item.dataset.subtab === tabId);
    });
  }

  /* ── Internals toggle ── */

  _bindInternalsToggle() {
    const toggle = document.getElementById('internals-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      this._internalsOpen = !this._internalsOpen;
      if (this._internalsGroup) {
        this._internalsGroup.classList.toggle('open', this._internalsOpen);
      }
      if (this._internalsChevron) {
        this._internalsChevron.classList.toggle('open', this._internalsOpen);
      }
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle.click();
      }
    });
  }

  /* ── Keyboard shortcuts ── */

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.ctrlKey || e.metaKey) return;

    const views = ['workspace', 'runtime', 'api', 'environment'];
    const primarySubTabs = ['logs', 'telemetry', 'sysfiles', 'spark'];

    /* Alt+1-4: runtime primary sub-tabs */
    if (e.altKey && this._phase === 'connected' && this._activeView === 'runtime') {
      const num = parseInt(e.key);
      if (num >= 1 && num <= 4) {
        e.preventDefault();
        this._switchSubTab(primarySubTabs[num - 1]);
        return;
      }
    }

    /* 1-4: view switching (no modifiers) */
    if (!e.altKey) {
      const num = parseInt(e.key);
      if (num >= 1 && num <= 4) {
        e.preventDefault();
        this.switchView(views[num - 1]);
      }
    }
  }

  /* ── Helpers ── */

  _getNavItem(viewId) {
    return this._navItems.find(n => n.dataset.view === viewId) || null;
  }

  _updateSubitemsVisibility() {
    if (!this._runtimeSubitems) return;
    const show = this._activeView === 'runtime' && this._phase === 'connected';
    this._runtimeSubitems.classList.toggle('visible', show);
  }

  /**
   * Watch the legacy sidebar-token-dot element for class changes
   * and mirror the state to the new token ring.
   * This keeps compatibility with topbar.js which updates the legacy dot.
   */
  _observeLegacyTokenDot() {
    const legacyDot = document.getElementById('sidebar-token-dot');
    if (!legacyDot) return;

    const syncFromDot = () => {
      const classes = legacyDot.className;
      if (classes.includes('green')) {
        this.setTokenHealth('healthy', this._tokenTimeEl?.textContent || '');
      } else if (classes.includes('amber')) {
        this.setTokenHealth('warning', this._tokenTimeEl?.textContent || '');
      } else if (classes.includes('red')) {
        this.setTokenHealth('expired', this._tokenTimeEl?.textContent || '');
      }
    };

    this._tokenObserver = new MutationObserver(syncFromDot);
    this._tokenObserver.observe(legacyDot, { attributes: true, attributeFilter: ['class'] });
  }
}
