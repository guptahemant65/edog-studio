/**
 * Sidebar — 52px icon-only navigation with per-icon slide-out labels,
 * phase-aware view switching, and animated active bar.
 */
class Sidebar {
  constructor() {
    this._el = document.getElementById('sidebar');
    this._icons = [];
    this._activeView = 'workspace';
    this._phase = 'disconnected';
    this._phaseEl = null;
    this.onViewChange = null;
  }

  init() {
    if (!this._el) return;
    this._icons = Array.from(this._el.querySelectorAll('.sidebar-icon'));
    this._phaseEl = document.getElementById('sidebar-phase');

    this._injectLabels();

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
  }

  /** Inject an inline label into each icon — revealed by CSS on hover. */
  _injectLabels() {
    this._icons.forEach(icon => {
      const pill = document.createElement('span');
      pill.className = 'sidebar-slide-label';

      const name = document.createElement('span');
      name.className = 'sidebar-slide-name';
      name.textContent = icon.dataset.label || '';
      pill.appendChild(name);

      if (icon.dataset.shortcut) {
        const key = document.createElement('kbd');
        key.className = 'sidebar-slide-key';
        key.textContent = icon.dataset.shortcut;
        pill.appendChild(key);
      }

      icon.appendChild(pill);
    });
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
        this._phaseEl.textContent = '\u25C9';
        this._phaseEl.title = 'Connected \u00B7 FLT service running';
        this._phaseEl.classList.add('connected');
      } else {
        this._phaseEl.textContent = '\u25CB';
        this._phaseEl.title = 'Browsing \u00B7 No service connected';
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
