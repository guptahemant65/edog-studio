/**
 * Sidebar — 52px icon rail with seamless expanding pill labels.
 *
 * Architecture:
 *   .sidebar-slot  — flex child for vertical positioning + active indicator
 *   .sidebar-icon  — absolute button inside slot, expands on hover/focus
 *                    Contains SVG + name + key as one surface (no seam)
 *
 * JS responsibilities:
 *   1. Inject label spans into each button
 *   2. Measure content width → set --expanded-w per button
 *   3. Manage active/disabled state on the SLOT, not the button
 *   4. Keyboard shortcuts 1-6
 */
class Sidebar {
  constructor() {
    this._el = document.getElementById('sidebar');
    this._slots = [];
    this._activeView = 'workspace';
    this._phase = 'disconnected';
    this._phaseEl = null;
    this.onViewChange = null;
  }

  init() {
    if (!this._el) return;
    this._slots = Array.from(this._el.querySelectorAll('.sidebar-slot'));
    this._phaseEl = document.getElementById('sidebar-phase');

    this._injectLabels();
    this._measureWidths();

    this._slots.forEach(slot => {
      const btn = slot.querySelector('.sidebar-icon');
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (slot.classList.contains('disabled')) return;
        this.switchView(btn.dataset.view);
      });
    });

    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    const saved = localStorage.getItem('edog-active-view');
    if (saved && this._getSlot(saved) && !this._getSlot(saved).classList.contains('disabled')) {
      this.switchView(saved);
    }
  }

  /** Inject label + shortcut spans into each icon button. */
  _injectLabels() {
    this._slots.forEach(slot => {
      const btn = slot.querySelector('.sidebar-icon');
      if (!btn) return;

      const name = document.createElement('span');
      name.className = 'sidebar-slide-name';
      name.textContent = btn.dataset.label || '';
      btn.appendChild(name);

      if (btn.dataset.shortcut) {
        const key = document.createElement('kbd');
        key.className = 'sidebar-slide-key';
        key.textContent = btn.dataset.shortcut;
        btn.appendChild(key);
      }
    });
  }

  /** Measure each button's natural expanded width and set --expanded-w. */
  _measureWidths() {
    this._slots.forEach(slot => {
      const btn = slot.querySelector('.sidebar-icon');
      if (!btn) return;
      // Temporarily expand to measure
      btn.style.maxWidth = 'none';
      btn.style.position = 'static';
      btn.style.visibility = 'hidden';
      const w = btn.scrollWidth + 14; // padding buffer
      btn.style.maxWidth = '';
      btn.style.position = '';
      btn.style.visibility = '';
      btn.style.setProperty('--expanded-w', w + 'px');
    });
  }

  switchView(viewId) {
    if (viewId === this._activeView) return;
    const slot = this._getSlot(viewId);
    if (!slot || slot.classList.contains('disabled')) return;

    this._slots.forEach(s => s.classList.remove('active'));
    slot.classList.add('active');

    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('view-' + viewId);
    if (panel) panel.classList.add('active');

    this._activeView = viewId;
    localStorage.setItem('edog-active-view', viewId);

    if (this.onViewChange) this.onViewChange(viewId);
  }

  setPhase(phase) {
    this._phase = phase;
    const connectedSlots = [];

    this._slots.forEach(slot => {
      const btn = slot.querySelector('.sidebar-icon');
      if (!btn) return;
      const iconPhase = btn.dataset.phase;
      if (iconPhase === 'connected') {
        connectedSlots.push(slot);
        if (phase === 'disconnected') {
          slot.classList.add('disabled');
        }
      } else {
        slot.classList.remove('disabled');
      }
    });

    // Cascade-enable connected views with staggered animation
    if (phase === 'connected') {
      connectedSlots.forEach((slot, i) => {
        setTimeout(() => {
          slot.classList.remove('disabled');
          slot.classList.add('cascade-in');
          setTimeout(() => slot.classList.remove('cascade-in'), 400);
        }, i * 150);
      });
    }

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

    if (this._getSlot(this._activeView)?.classList.contains('disabled')) {
      this.switchView('workspace');
    }
  }

  getActiveView() { return this._activeView; }

  _getSlot(viewId) {
    return this._slots.find(s => s.dataset.view === viewId) || null;
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
