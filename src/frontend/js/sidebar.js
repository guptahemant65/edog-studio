/**
 * Sidebar — 48px icon-only navigation with phase-aware view switching.
 */
class Sidebar {
  constructor() {
    this._el = document.getElementById('sidebar');
    this._icons = [];
    this._activeView = 'workspace';
    this._phase = 'disconnected';
    this.onViewChange = null;
  }

  init() {
    if (!this._el) return;
    this._icons = Array.from(this._el.querySelectorAll('.sidebar-icon'));

    this._icons.forEach(icon => {
      icon.addEventListener('click', () => {
        const view = icon.dataset.view;
        if (icon.classList.contains('disabled')) return;
        this.switchView(view);
      });
    });

    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    const saved = localStorage.getItem('edog-active-view');
    if (saved && this._getIcon(saved) && !this._getIcon(saved).classList.contains('disabled')) {
      this.switchView(saved);
    }
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
