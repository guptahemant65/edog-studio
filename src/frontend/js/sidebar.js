/**
 * Sidebar — 52px icon-only navigation with hover-expand, phase-aware
 * view switching, animated active bar, and tooltip system.
 */
class Sidebar {
  constructor() {
    this._el = document.getElementById('sidebar');
    this._icons = [];
    this._activeView = 'workspace';
    this._phase = 'disconnected';
    this._tooltip = null;
    this._tooltipTimer = null;
    this._phaseEl = null;
    this.onViewChange = null;
  }

  init() {
    if (!this._el) return;
    this._icons = Array.from(this._el.querySelectorAll('.sidebar-icon'));
    this._phaseEl = document.getElementById('sidebar-phase');

    this._injectLabels();
    this._createTooltip();
    this._bindTooltips();

    this._icons.forEach(icon => {
      icon.removeAttribute('title');
      icon.addEventListener('click', () => {
        if (icon.classList.contains('disabled')) return;
        this.switchView(icon.dataset.view);
      });
    });

    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    const saved = localStorage.getItem('edog-active-view');
    if (saved && this._getIcon(saved) && !this._getIcon(saved).classList.contains('disabled')) {
      this.switchView(saved);
    }

    this._updateActiveBar();
  }

  /** Inject label + shortcut spans into each icon button */
  _injectLabels() {
    this._icons.forEach(icon => {
      const label = icon.dataset.label;
      const shortcut = icon.dataset.shortcut;
      if (label) {
        const span = document.createElement('span');
        span.className = 'sidebar-label';
        span.textContent = label;
        icon.appendChild(span);
      }
      if (shortcut) {
        const badge = document.createElement('span');
        badge.className = 'sidebar-shortcut';
        badge.textContent = shortcut;
        icon.appendChild(badge);
      }
    });
  }

  /** Create the shared tooltip element */
  _createTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'sidebar-tooltip';
    document.body.appendChild(this._tooltip);
  }

  /** Bind hover events for tooltip on each icon (only when sidebar collapsed) */
  _bindTooltips() {
    this._icons.forEach(icon => {
      icon.addEventListener('mouseenter', () => {
        if (this._el.matches(':hover') && this._el.offsetWidth > 100) return;
        this._tooltipTimer = setTimeout(() => this._showTooltip(icon), 400);
      });
      icon.addEventListener('mouseleave', () => this._hideTooltip());
    });

    this._el.addEventListener('mouseenter', () => this._hideTooltip());
  }

  _showTooltip(icon) {
    const rect = icon.getBoundingClientRect();
    const label = icon.dataset.label || '';
    const shortcut = icon.dataset.shortcut || '';
    const disabled = icon.classList.contains('disabled');

    this._tooltip.textContent = disabled
      ? 'Deploy to enable'
      : label + (shortcut ? ' \u00B7 ' + shortcut : '');

    this._tooltip.style.left = (rect.right + 8) + 'px';
    this._tooltip.style.top = (rect.top + rect.height / 2 - 12) + 'px';
    this._tooltip.classList.add('visible');
  }

  _hideTooltip() {
    clearTimeout(this._tooltipTimer);
    if (this._tooltip) this._tooltip.classList.remove('visible');
  }

  /** Move the active bar (::after on sidebar) to the active icon position */
  _updateActiveBar() {
    const icon = this._getIcon(this._activeView);
    if (!icon || !this._el) return;
    const sidebarRect = this._el.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const y = iconRect.top - sidebarRect.top + (iconRect.height - 20) / 2;
    this._el.style.setProperty('--active-bar-y', y + 'px');
  }

  switchView(viewId) {
    if (viewId === this._activeView) return;
    const icon = this._getIcon(viewId);
    if (!icon || icon.classList.contains('disabled')) return;

    this._icons.forEach(i => i.classList.remove('active'));
    icon.classList.add('active');

    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('view-' + viewId);
    if (panel) panel.classList.add('active');

    this._activeView = viewId;
    localStorage.setItem('edog-active-view', viewId);
    this._updateActiveBar();

    if (this.onViewChange) this.onViewChange(viewId);
  }

  setPhase(phase) {
    this._phase = phase;
    this._icons.forEach(icon => {
      const iconPhase = icon.dataset.phase;
      if (iconPhase === 'connected' && phase === 'disconnected') {
        icon.classList.add('disabled');
      } else {
        icon.classList.remove('disabled');
      }
    });

    if (this._phaseEl) {
      if (phase === 'connected') {
        this._phaseEl.textContent = 'P2';
        this._phaseEl.title = 'Phase 2 \u00B7 Connected';
        this._phaseEl.classList.add('connected');
      } else {
        this._phaseEl.textContent = 'P1';
        this._phaseEl.title = 'Phase 1 \u00B7 Disconnected';
        this._phaseEl.classList.remove('connected');
      }
    }

    if (this._getIcon(this._activeView)?.classList.contains('disabled')) {
      this.switchView('workspace');
    }
  }

  getActiveView() { return this._activeView; }

  _getIcon(viewId) {
    return this._icons.find(i => i.dataset.view === viewId) || null;
  }

  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const views = ['workspace', 'logs', 'dag', 'spark', 'api', 'environment'];
    const num = parseInt(e.key);
    if (num >= 1 && num <= 6) {
      e.preventDefault();
      this.switchView(views[num - 1]);
    }
  }
}
