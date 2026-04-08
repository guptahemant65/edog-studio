/**
 * WorkspaceExplorer — Three-panel workspace browser with deploy flow.
 */
class WorkspaceExplorer {
  constructor(apiClient) {
    this._api = apiClient;
    this._treeEl = document.getElementById('ws-tree-content');
    this._contentEl = document.getElementById('ws-content-body');
    this._inspectorEl = document.getElementById('ws-inspector-content');
    this._favoritesEl = document.getElementById('ws-favorites-list');
    this._selectedItem = null;
    this._workspaces = [];
    this._expanded = new Set();
    this._children = {};
    this._favorites = [];
  }

  async init() {
    this._loadFavorites();
    this._renderFavorites();
    this._bindRefresh();
    await this.loadWorkspaces();
  }

  _bindRefresh() {
    const btn = document.querySelector('.ws-tree-refresh');
    if (btn) btn.addEventListener('click', () => this.loadWorkspaces());
  }

  async loadWorkspaces() {
    if (!this._treeEl) return;
    this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Loading...</div>';
    try {
      const data = await this._api.listWorkspaces();
      this._workspaces = (data && data.value) || [];
      this._renderTree();
    } catch (e) {
      this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Could not load workspaces</div>';
    }
  }

  _renderTree() {
    if (!this._treeEl) return;
    this._treeEl.innerHTML = '';
    if (this._workspaces.length === 0) {
      this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">No workspaces found</div>';
      return;
    }
    this._workspaces.forEach(ws => {
      const isExpanded = this._expanded.has(ws.id);
      const wsEl = this._createTreeItem(ws.displayName, 0, '&#9654;', null, () => this._toggleWorkspace(ws));
      if (isExpanded) wsEl.querySelector('.ws-tree-toggle').innerHTML = '&#9660;';
      this._treeEl.appendChild(wsEl);

      if (isExpanded && this._children[ws.id]) {
        this._children[ws.id].forEach(item => {
          const isLakehouse = (item.type || '').toLowerCase().includes('lakehouse');
          const dotClass = isLakehouse ? 'lakehouse' : 'other';
          const cls = isLakehouse ? '' : 'dimmed';
          const itemEl = this._createTreeItem(
            item.displayName, 1,
            null,
            dotClass,
            () => this._selectItem(item, ws),
            cls
          );
          this._treeEl.appendChild(itemEl);
        });
      }
    });
  }

  _createTreeItem(name, depth, toggleSymbol, dotClass, onClick, extraClass) {
    const el = document.createElement('div');
    el.className = 'ws-tree-item' + (extraClass ? ' ' + extraClass : '');
    el.style.paddingLeft = (12 + depth * 16) + 'px';

    if (toggleSymbol) {
      const toggle = document.createElement('span');
      toggle.className = 'ws-tree-toggle';
      toggle.innerHTML = toggleSymbol;
      el.appendChild(toggle);
    }

    if (dotClass) {
      const dot = document.createElement('span');
      dot.className = 'ws-tree-dot ' + dotClass;
      el.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'ws-tree-name';
    nameEl.textContent = name;
    el.appendChild(nameEl);

    el.addEventListener('click', onClick);
    return el;
  }

  async _toggleWorkspace(ws) {
    if (this._expanded.has(ws.id)) {
      this._expanded.delete(ws.id);
    } else {
      this._expanded.add(ws.id);
      if (!this._children[ws.id]) {
        const data = await this._api.listWorkspaceItems(ws.id);
        const items = (data && data.value) || [];
        items.sort((a, b) => {
          const aLH = (a.type || '').toLowerCase().includes('lakehouse') ? 0 : 1;
          const bLH = (b.type || '').toLowerCase().includes('lakehouse') ? 0 : 1;
          return aLH - bLH || (a.displayName || '').localeCompare(b.displayName || '');
        });
        this._children[ws.id] = items;
      }
    }
    this._renderTree();
  }

  _selectItem(item, workspace) {
    this._selectedItem = { ...item, workspaceId: workspace.id, workspaceName: workspace.displayName };

    document.querySelectorAll('.ws-tree-item').forEach(el => el.classList.remove('selected'));
    event.currentTarget?.classList.add('selected');

    const isLakehouse = (item.type || '').toLowerCase().includes('lakehouse');
    if (isLakehouse) {
      this._showLakehouseContent(item, workspace);
    } else {
      this._showItemContent(item, workspace);
    }
  }

  async _showLakehouseContent(lh, ws) {
    if (!this._contentEl) return;
    const config = this._api.getConfig();
    const capacityId = config?.capacityId || 'unknown';

    let html = '<div class="ws-content-header">';
    html += '<div class="ws-content-title">' + this._esc(lh.displayName) + '</div>';
    html += '<div class="ws-content-meta">' + (lh.id || '').substring(0, 12) + '... &middot; ' + this._esc(capacityId.substring(0, 8)) + '</div>';
    html += '</div>';
    html += '<button class="ws-deploy-btn" id="ws-deploy-btn">Deploy to this Lakehouse</button>';

    html += '<div id="ws-deploy-progress" class="ws-deploy-progress" style="display:none"></div>';

    html += '<div class="ws-section-title">Tables</div>';
    html += '<div id="ws-tables-list">Loading tables...</div>';

    this._contentEl.innerHTML = html;

    const deployBtn = document.getElementById('ws-deploy-btn');
    if (deployBtn) {
      deployBtn.addEventListener('click', () => this._deployToLakehouse(lh, ws));
    }

    try {
      const data = await this._api.listTables(ws.id, lh.id);
      const tables = (data && data.value) || [];
      const tablesEl = document.getElementById('ws-tables-list');
      if (!tablesEl) return;
      if (tables.length === 0) {
        tablesEl.innerHTML = '<div class="ws-tree-item dimmed">No tables found</div>';
        return;
      }
      tablesEl.innerHTML = '';
      tables.forEach(t => {
        const row = document.createElement('div');
        row.className = 'ws-table-row';
        row.innerHTML = '<span class="ws-table-name">' + this._esc(t.name) + '</span><span class="ws-table-type">' + this._esc(t.type || t.format || 'Delta') + '</span>';
        row.addEventListener('click', () => this._showTableInspector(t));
        tablesEl.appendChild(row);
      });
    } catch {
      const tablesEl = document.getElementById('ws-tables-list');
      if (tablesEl) tablesEl.innerHTML = '<div class="ws-tree-item dimmed">Could not load tables</div>';
    }
  }

  _showItemContent(item, ws) {
    if (!this._contentEl) return;
    let html = '<div class="ws-content-header">';
    html += '<div class="ws-content-title">' + this._esc(item.displayName) + '</div>';
    html += '<div class="ws-content-meta">' + this._esc(item.type || 'Item') + ' &middot; ' + (item.id || '').substring(0, 12) + '...</div>';
    html += '</div>';
    html += '<a href="https://app.fabric.microsoft.com/" target="_blank" class="ws-deploy-btn" style="text-decoration:none;display:inline-block">Open in Fabric</a>';
    this._contentEl.innerHTML = html;
    this._clearInspector();
  }

  _showTableInspector(table) {
    if (!this._inspectorEl) return;
    let html = '';
    const fields = [
      ['Name', table.name],
      ['Type', table.type || 'Table'],
      ['Format', table.format || 'Delta'],
      ['Location', table.location || 'N/A'],
    ];
    fields.forEach(([label, val]) => {
      html += '<div class="ws-inspector-field"><div class="ws-inspector-label">' + label + '</div><div class="ws-inspector-value">' + this._esc(val || '') + '</div></div>';
    });
    this._inspectorEl.innerHTML = html;
  }

  _clearInspector() {
    if (this._inspectorEl) this._inspectorEl.innerHTML = '';
  }

  async _deployToLakehouse(lh, ws) {
    const progressEl = document.getElementById('ws-deploy-progress');
    const btnEl = document.getElementById('ws-deploy-btn');
    if (!progressEl) return;
    if (btnEl) btnEl.style.display = 'none';
    progressEl.style.display = 'block';

    const steps = [
      'Fetching MWC token...',
      'Updating config...',
      'Patching code...',
      'Building service...',
      'Launching service...',
    ];

    for (let i = 0; i < steps.length; i++) {
      let html = '';
      steps.forEach((s, idx) => {
        let cls = 'ws-deploy-step';
        let icon = '&#9675;';
        if (idx < i) { cls += ' done'; icon = '&#10003;'; }
        else if (idx === i) { cls += ' active'; icon = '&#9679;'; }
        html += '<div class="' + cls + '"><span>' + icon + '</span> ' + (idx + 1) + '/' + steps.length + ' ' + s + '</div>';
      });
      progressEl.innerHTML = html;
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
    }

    let html = '';
    steps.forEach((s, idx) => {
      html += '<div class="ws-deploy-step done"><span>&#10003;</span> ' + (idx + 1) + '/' + steps.length + ' ' + s + '</div>';
    });
    progressEl.innerHTML = html;
  }

  // --- Favorites ---

  _loadFavorites() {
    try {
      this._favorites = JSON.parse(localStorage.getItem('edog-favorites') || '[]');
    } catch { this._favorites = []; }
  }

  _saveFavorite(item) {
    if (this._favorites.find(f => f.id === item.id)) return;
    this._favorites.push({
      name: item.displayName,
      id: item.id,
      workspaceId: item.workspaceId,
    });
    localStorage.setItem('edog-favorites', JSON.stringify(this._favorites));
    this._renderFavorites();
  }

  _renderFavorites() {
    if (!this._favoritesEl) return;
    this._favoritesEl.innerHTML = '';
    if (this._favorites.length === 0) {
      this._favoritesEl.innerHTML = '<div class="ws-tree-item dimmed" style="font-size:var(--text-xs)">No favorites yet</div>';
      return;
    }
    this._favorites.forEach(fav => {
      const el = document.createElement('div');
      el.className = 'ws-tree-item';
      el.style.fontSize = 'var(--text-xs)';
      el.textContent = fav.name;
      this._favoritesEl.appendChild(el);
    });
  }

  _esc(text) {
    const d = document.createElement('div');
    d.textContent = text || '';
    return d.innerHTML;
  }
}
