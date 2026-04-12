/**
 * CommandPalette — Ctrl+K fuzzy command search and execution.
 */
class CommandPalette {
  constructor(sidebar, workspaceExplorer) {
    this._el = document.getElementById('command-palette');
    this._inputEl = document.getElementById('cp-input');
    this._resultsEl = document.getElementById('cp-results');
    this._sidebar = sidebar;
    this._workspace = workspaceExplorer;
    this._visible = false;
    this._selectedIndex = -1;
    this._results = [];
  }

  init() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.toggle();
      }
      if (e.key === 'Escape' && this._visible) {
        e.preventDefault();
        this.hide();
      }
    });

    if (this._inputEl) {
      this._inputEl.addEventListener('input', () => this._onInput(this._inputEl.value));
      this._inputEl.addEventListener('keydown', (e) => this._onKeyDown(e));
    }

    const backdrop = this._el?.querySelector('.cp-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => this.hide());
  }

  toggle() { this._visible ? this.hide() : this.show(); }

  show() {
    if (!this._el) return;
    this._el.classList.remove('hidden');
    this._visible = true;
    this._selectedIndex = -1;
    if (this._inputEl) {
      this._inputEl.value = '';
      this._inputEl.focus();
    }
    this._onInput('');
  }

  hide() {
    if (!this._el) return;
    this._el.classList.add('hidden');
    this._visible = false;
  }

  _getCommands() {
    return [
      { group: 'Views', icon: '\u25A6', label: 'Workspace Explorer', shortcut: '1', action: () => this._sidebar.switchView('workspace') },
      { group: 'Views', icon: '\u26A1', label: 'Runtime', shortcut: '2', action: () => this._sidebar.switchView('runtime') },
      { group: 'Views', icon: '\u25B9', label: 'API Playground', shortcut: '3', action: () => this._sidebar.switchView('api') },
      { group: 'Views', icon: '\u2699', label: 'Environment', shortcut: '4', action: () => this._sidebar.switchView('environment') },
      { group: 'Actions', icon: '\u25B6', label: 'Run DAG', action: () => {} },
      { group: 'Actions', icon: '\u2718', label: 'Cancel DAG', action: () => {} },
      { group: 'Actions', icon: '\u21BB', label: 'Restart Service', action: () => {} },
      { group: 'Actions', icon: '\u2327', label: 'Clear Logs', action: () => { if (window.edogViewer) window.edogViewer.state.logBuffer.clear(); } },
    ];
  }

  _onInput(text) {
    const query = text.trim().toLowerCase();
    const commands = this._getCommands();

    if (!query) {
      this._results = commands;
    } else {
      this._results = commands.filter(c => this._fuzzyMatch(query, c.label.toLowerCase()));
    }

    this._selectedIndex = this._results.length > 0 ? 0 : -1;
    this._renderResults();
  }

  _fuzzyMatch(query, text) {
    let qi = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
      if (text[ti] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  _renderResults() {
    if (!this._resultsEl) return;
    if (this._results.length === 0) {
      this._resultsEl.innerHTML = '<div class="cp-empty">No results</div>';
      return;
    }

    let html = '';
    let lastGroup = '';
    this._results.forEach((r, i) => {
      if (r.group !== lastGroup) {
        html += '<div class="cp-group-label">' + r.group + '</div>';
        lastGroup = r.group;
      }
      const sel = i === this._selectedIndex ? ' selected' : '';
      html += '<div class="cp-item' + sel + '" data-index="' + i + '">';
      html += '<span class="cp-item-icon">' + (r.icon || '') + '</span>';
      html += '<span class="cp-item-label">' + r.label + '</span>';
      if (r.shortcut) html += '<span class="cp-item-shortcut">' + r.shortcut + '</span>';
      html += '</div>';
    });
    this._resultsEl.innerHTML = html;

    this._resultsEl.querySelectorAll('.cp-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        this._executeIndex(idx);
      });
    });
  }

  _onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._selectedIndex = Math.min(this._selectedIndex + 1, this._results.length - 1);
      this._renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
      this._renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this._executeIndex(this._selectedIndex);
    }
  }

  _executeIndex(index) {
    if (index < 0 || index >= this._results.length) return;
    const cmd = this._results[index];
    this.hide();
    if (cmd.action) cmd.action();
  }
}
