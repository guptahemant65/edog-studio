/**
 * WorkspaceExplorer — Three-panel workspace browser with context menu,
 * rename/delete, deploy flow, favorites, toast notifications, and mock mode.
 *
 * Panels: Tree (left) · Content (center) · Inspector (right)
 *
 * @author Zara Okonkwo — EDOG Studio hivemind
 */
class WorkspaceExplorer {
  constructor(apiClient) {
    this._api = apiClient;
    this._treeEl = document.getElementById('ws-tree-content');
    this._contentEl = document.getElementById('ws-content-body');
    this._inspectorEl = document.getElementById('ws-inspector-content');
    this._favoritesEl = document.getElementById('ws-favorites-list');

    this._selectedItem = null;
    this._selectedWorkspace = null;
    this._workspaces = [];
    this._expanded = new Set();
    this._children = {};
    this._favorites = [];
    this._toastEl = null;
    this._toastTimer = null;
    this._ctxMenu = null;
    this._ctxTarget = null;

    this._isMock = new URLSearchParams(window.location.search).has('mock');
  }

  async init() {
    this._createToast();
    this._createContextMenu();
    this._loadFavorites();
    this._renderFavorites();
    this._bindRefresh();
    this._bindGlobalKeys();
    await this.loadWorkspaces();
  }

  // ────────────────────────────────────────────
  // Toast
  // ────────────────────────────────────────────

  _createToast() {
    let el = document.querySelector('.edog-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'edog-toast';
      document.body.appendChild(el);
    }
    this._toastEl = el;
  }

  /** @param {string} msg  @param {'success'|'error'|'info'} type */
  _toast(msg, type = 'info') {
    if (!this._toastEl) return;
    this._toastEl.textContent = msg;
    this._toastEl.classList.remove('visible', 'error', 'success');
    if (type === 'error') this._toastEl.classList.add('error');
    else if (type === 'success') this._toastEl.classList.add('success');
    // Force reflow so transition plays even if already visible
    void this._toastEl.offsetWidth;
    this._toastEl.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastEl.classList.remove('visible');
    }, 2500);
  }

  // ────────────────────────────────────────────
  // Context Menu
  // ────────────────────────────────────────────

  _createContextMenu() {
    let el = document.querySelector('.ws-ctx-menu');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ws-ctx-menu';
      document.body.appendChild(el);
    }
    this._ctxMenu = el;

    document.addEventListener('click', () => this._hideContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // If the right-click is outside the tree, hide the menu
      if (!this._treeEl || !this._treeEl.contains(e.target)) {
        this._hideContextMenu();
      }
    });
  }

  _hideContextMenu() {
    if (this._ctxMenu) this._ctxMenu.classList.remove('visible');
    this._ctxTarget = null;
  }

  /**
   * @param {MouseEvent} e
   * @param {object} nodeData  { item, workspace, isWorkspace, isLakehouse }
   */
  _showContextMenu(e, nodeData) {
    e.preventDefault();
    e.stopPropagation();
    if (!this._ctxMenu) return;

    this._ctxTarget = nodeData;
    const items = [];

    if (nodeData.isLakehouse) {
      items.push({ label: 'Deploy to this Lakehouse', cls: 'accent', action: () => this._ctxDeploy() });
      items.push({ sep: true });
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
      items.push({ sep: true });
      items.push({ label: 'Save as Favorite', action: () => this._ctxSaveFavorite() });
    } else if (nodeData.isWorkspace) {
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
    } else {
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
    }

    this._ctxMenu.innerHTML = '';
    for (const it of items) {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'ws-ctx-sep';
        this._ctxMenu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.className = 'ws-ctx-item' + (it.cls ? ` ${it.cls}` : '');
        el.textContent = it.label;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._hideContextMenu();
          it.action();
        });
        this._ctxMenu.appendChild(el);
      }
    }

    // Position within viewport
    const menuW = 220;
    const menuH = this._ctxMenu.children.length * 32;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;

    this._ctxMenu.style.left = `${x}px`;
    this._ctxMenu.style.top = `${y}px`;
    this._ctxMenu.classList.add('visible');
  }

  // Context menu actions

  _ctxDeploy() {
    const t = this._ctxTarget;
    if (!t || !t.isLakehouse) return;
    this._selectItem(t.item, t.workspace);
  }

  async _ctxRename() {
    const t = this._ctxTarget;
    if (!t) return;

    const oldName = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const newName = prompt(`Rename "${oldName}" to:`, oldName);
    if (!newName || newName === oldName) return;

    try {
      if (t.isWorkspace) {
        await this._api.renameWorkspace(t.workspace.id, newName);
        t.workspace.displayName = newName;
        this._toast(`Renamed workspace to "${newName}"`, 'success');
      } else {
        const isLH = this._isLakehouse(t.item);
        if (isLH) {
          await this._api.renameLakehouse(t.workspace.id, t.item.id, newName);
        } else {
          // Non-lakehouse items — Fabric API doesn't expose rename for all types.
          // Attempt workspace-item rename via same lakehouse endpoint pattern;
          // if not available the API will throw and we show the error.
          await this._api.renameLakehouse(t.workspace.id, t.item.id, newName);
        }
        t.item.displayName = newName;
        this._toast(`Renamed to "${newName}"`, 'success');
      }
      this._renderTree();
      // Re-select if the renamed item was selected
      if (this._selectedItem && this._selectedItem.id === (t.item?.id || t.workspace?.id)) {
        if (t.isWorkspace) {
          this._selectWorkspace(t.workspace);
        } else {
          this._selectItem(t.item, t.workspace);
        }
      }
    } catch (err) {
      this._toast(`Rename failed: ${err.message}`, 'error');
    }
  }

  async _ctxDelete() {
    const t = this._ctxTarget;
    if (!t) return;

    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const kind = t.isWorkspace ? 'workspace' : (this._isLakehouse(t.item) ? 'lakehouse' : 'item');
    const ok = confirm(`Delete ${kind} "${name}"?\n\nThis action cannot be undone.`);
    if (!ok) return;

    try {
      if (t.isWorkspace) {
        await this._api.deleteWorkspace(t.workspace.id);
        this._workspaces = this._workspaces.filter(w => w.id !== t.workspace.id);
        delete this._children[t.workspace.id];
        this._expanded.delete(t.workspace.id);
        this._toast(`Deleted workspace "${name}"`, 'success');
      } else {
        if (this._isLakehouse(t.item)) {
          await this._api.deleteLakehouse(t.workspace.id, t.item.id);
        } else {
          await this._api.deleteLakehouse(t.workspace.id, t.item.id);
        }
        const children = this._children[t.workspace.id];
        if (children) {
          this._children[t.workspace.id] = children.filter(c => c.id !== t.item.id);
        }
        this._toast(`Deleted "${name}"`, 'success');
      }
      this._renderTree();
      this._showEmptyContent();
      this._clearInspector();
      this._selectedItem = null;
      this._selectedWorkspace = null;
    } catch (err) {
      this._toast(`Delete failed: ${err.message}`, 'error');
    }
  }

  _ctxOpenInFabric() {
    const t = this._ctxTarget;
    if (!t) return;
    const wsId = t.isWorkspace ? t.workspace.id : t.workspace.id;
    const url = `https://app.fabric.microsoft.com/groups/${wsId}`;
    window.open(url, '_blank');
  }

  _ctxCopyId() {
    const t = this._ctxTarget;
    if (!t) return;
    const id = t.isWorkspace ? t.workspace.id : t.item.id;
    this._copyToClipboard(id, 'ID copied');
  }

  _ctxCopyName() {
    const t = this._ctxTarget;
    if (!t) return;
    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    this._copyToClipboard(name, 'Name copied');
  }

  _ctxSaveFavorite() {
    const t = this._ctxTarget;
    if (!t || !t.item) return;
    this._saveFavorite({
      displayName: t.item.displayName,
      id: t.item.id,
      workspaceId: t.workspace.id,
      workspaceName: t.workspace.displayName,
    });
    this._toast(`"${t.item.displayName}" saved to favorites`, 'success');
  }

  // ────────────────────────────────────────────
  // Clipboard
  // ────────────────────────────────────────────

  _copyToClipboard(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this._toast(successMsg || 'Copied', 'success'),
        () => this._toast('Copy failed', 'error')
      );
    } else {
      this._toast('Clipboard not available', 'error');
    }
  }

  // ────────────────────────────────────────────
  // Global bindings
  // ────────────────────────────────────────────

  _bindRefresh() {
    const btn = document.querySelector('.ws-tree-refresh');
    if (btn) btn.addEventListener('click', () => this.loadWorkspaces());
  }

  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideContextMenu();
    });
  }

  // ────────────────────────────────────────────
  // Data loading (API + mock)
  // ────────────────────────────────────────────

  async loadWorkspaces() {
    if (!this._treeEl) return;
    this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Loading...</div>';
    try {
      if (this._isMock && typeof MockData !== 'undefined') {
        this._workspaces = MockData.workspaces || [];
      } else {
        const data = await this._api.listWorkspaces();
        this._workspaces = (data && data.value) || [];
      }
      this._renderTree();
    } catch (err) {
      this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Could not load workspaces</div>';
      this._toast(`Failed to load workspaces: ${err.message}`, 'error');
    }
  }

  async _loadChildren(ws) {
    if (this._isMock && typeof MockData !== 'undefined') {
      const wsIdx = this._workspaces.indexOf(ws);
      const items = MockData.getItemsForWorkspace(wsIdx >= 0 ? wsIdx : 0);
      return items || [];
    }
    const data = await this._api.listWorkspaceItems(ws.id);
    return (data && data.value) || [];
  }

  async _loadTables(wsId, lhId) {
    if (this._isMock && typeof MockData !== 'undefined') {
      return MockData.tablesForLakehouse || [];
    }
    const data = await this._api.listTables(wsId, lhId);
    return (data && data.value) || [];
  }

  // ────────────────────────────────────────────
  // Tree rendering
  // ────────────────────────────────────────────

  _renderTree() {
    if (!this._treeEl) return;
    this._treeEl.innerHTML = '';
    if (this._workspaces.length === 0) {
      this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">No workspaces found</div>';
      return;
    }

    for (const ws of this._workspaces) {
      const isExpanded = this._expanded.has(ws.id);
      const isSelected = this._selectedWorkspace && this._selectedWorkspace.id === ws.id && !this._selectedItem;
      const wsEl = this._buildTreeNode({
        name: ws.displayName,
        depth: 0,
        toggle: isExpanded ? '\u25BE' : '\u25B8',
        selected: isSelected,
      });

      // Click toggle arrow → expand/collapse; click name → select workspace
      const toggleEl = wsEl.querySelector('.ws-tree-toggle');
      const nameEl = wsEl.querySelector('.ws-tree-name');
      if (toggleEl) {
        toggleEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleWorkspace(ws);
        });
      }
      if (nameEl) {
        nameEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this._selectWorkspace(ws);
        });
      }
      // Fallback: clicking the row toggles
      wsEl.addEventListener('click', () => this._toggleWorkspace(ws));

      // Context menu
      wsEl.addEventListener('contextmenu', (e) => {
        this._showContextMenu(e, { workspace: ws, item: null, isWorkspace: true, isLakehouse: false });
      });

      this._treeEl.appendChild(wsEl);

      if (isExpanded && this._children[ws.id]) {
        for (const item of this._children[ws.id]) {
          const isLH = this._isLakehouse(item);
          const isItemSelected = this._selectedItem && this._selectedItem.id === item.id;
          const itemEl = this._buildTreeNode({
            name: item.displayName,
            depth: 1,
            dot: isLH ? 'lakehouse' : 'other',
            dimmed: !isLH,
            selected: isItemSelected,
          });

          itemEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this._selectItem(item, ws);
          });
          itemEl.addEventListener('contextmenu', (e) => {
            this._showContextMenu(e, { workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
          });

          this._treeEl.appendChild(itemEl);
        }
      }
    }
  }

  /**
   * Build a single tree-node DOM element.
   * @param {object} opts
   */
  _buildTreeNode(opts) {
    const el = document.createElement('div');
    let cls = 'ws-tree-item';
    if (opts.dimmed) cls += ' dimmed';
    if (opts.selected) cls += ' selected';
    el.className = cls;
    el.style.paddingLeft = (12 + (opts.depth || 0) * 16) + 'px';

    if (opts.toggle) {
      const toggle = document.createElement('span');
      toggle.className = 'ws-tree-toggle';
      toggle.textContent = opts.toggle;
      el.appendChild(toggle);
    }

    if (opts.dot) {
      const dot = document.createElement('span');
      dot.className = `ws-tree-dot ${opts.dot}`;
      el.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'ws-tree-name';
    nameEl.textContent = opts.name;
    el.appendChild(nameEl);

    return el;
  }

  // ────────────────────────────────────────────
  // Tree interactions
  // ────────────────────────────────────────────

  async _toggleWorkspace(ws) {
    if (this._expanded.has(ws.id)) {
      this._expanded.delete(ws.id);
    } else {
      this._expanded.add(ws.id);
      if (!this._children[ws.id]) {
        try {
          const items = await this._loadChildren(ws);
          items.sort((a, b) => {
            const aLH = this._isLakehouse(a) ? 0 : 1;
            const bLH = this._isLakehouse(b) ? 0 : 1;
            return aLH - bLH || (a.displayName || '').localeCompare(b.displayName || '');
          });
          this._children[ws.id] = items;
        } catch (err) {
          this._toast(`Failed to load items: ${err.message}`, 'error');
          this._expanded.delete(ws.id);
        }
      }
    }
    this._renderTree();
  }

  _selectWorkspace(ws) {
    this._selectedWorkspace = ws;
    this._selectedItem = null;
    this._showWorkspaceContent(ws);
    this._showWorkspaceInspector(ws);
    this._renderTree();
  }

  _selectItem(item, workspace) {
    this._selectedItem = { ...item, workspaceId: workspace.id, workspaceName: workspace.displayName };
    this._selectedWorkspace = workspace;

    const isLH = this._isLakehouse(item);
    if (isLH) {
      this._showLakehouseContent(item, workspace);
      this._clearInspector();
    } else {
      this._showItemContent(item, workspace);
      this._clearInspector();
    }
    this._renderTree();
  }

  // ────────────────────────────────────────────
  // Content panel: Workspace
  // ────────────────────────────────────────────

  _showWorkspaceContent(ws) {
    if (!this._contentEl) return;
    const capacityId = ws.capacityId || 'N/A';

    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(ws.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-meta-id" data-copy-id="${this._esc(ws.id)}" title="Click to copy ID">${this._esc(ws.id.substring(0, 12))}...</span>`;
    html += `<span class="ws-meta-badge">${this._esc(capacityId)}</span>`;
    html += '</div></div>';

    // Action buttons
    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="rename-ws">Rename</button>';
    html += `<button class="ws-action-btn" data-action="open-fabric-ws">Open in Fabric</button>`;
    html += '<button class="ws-action-btn" data-action="delete-ws" style="color:var(--level-error)">Delete</button>';
    html += '</div>';

    // Items table
    const children = this._children[ws.id] || [];
    if (children.length > 0) {
      html += `<div class="ws-section"><div class="ws-section-title">Items<span class="ws-section-count">(${children.length})</span></div>`;
      html += '<table class="ws-table"><thead><tr>';
      html += '<th>Name</th><th>Type</th><th>Status</th><th>Last Modified</th>';
      html += '</tr></thead><tbody>';
      for (const item of children) {
        const isLH = this._isLakehouse(item);
        const rowCls = isLH ? 'ws-table-row' : 'ws-table-row dimmed';
        const modified = item.lastModified ? this._formatDate(item.lastModified) : '\u2014';
        html += `<tr class="${rowCls}" data-item-id="${this._esc(item.id)}">`;
        html += `<td class="ws-table-name">${this._esc(item.displayName)}</td>`;
        html += `<td><span class="ws-type-badge">${this._esc(item.type || 'Item')}</span></td>`;
        html += `<td>${this._esc(item.status || 'Active')}</td>`;
        html += `<td class="ws-meta-modified">${modified}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    } else {
      // If expanded but no children loaded yet, or genuinely empty
      if (this._expanded.has(ws.id)) {
        html += '<div class="ws-section"><div class="ws-section-title">Items</div>';
        html += '<div class="ws-tree-item dimmed" style="justify-content:center">No items</div></div>';
      }
    }

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
  }

  _bindContentActions(ws) {
    if (!this._contentEl) return;

    // Click-to-copy on ID
    const idEl = this._contentEl.querySelector('.ws-meta-id');
    if (idEl) {
      idEl.addEventListener('click', () => {
        this._copyToClipboard(idEl.dataset.copyId || ws.id, 'ID copied');
      });
    }

    // Action buttons
    this._contentEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'rename-ws') {
          this._ctxTarget = { workspace: ws, item: null, isWorkspace: true, isLakehouse: false };
          this._ctxRename();
        } else if (action === 'delete-ws') {
          this._ctxTarget = { workspace: ws, item: null, isWorkspace: true, isLakehouse: false };
          this._ctxDelete();
        } else if (action === 'open-fabric-ws') {
          window.open(`https://app.fabric.microsoft.com/groups/${ws.id}`, '_blank');
        } else if (action === 'rename-lh') {
          const lh = this._selectedItem;
          if (lh) {
            this._ctxTarget = { workspace: ws, item: lh, isWorkspace: false, isLakehouse: true };
            this._ctxRename();
          }
        } else if (action === 'open-fabric-lh') {
          window.open(`https://app.fabric.microsoft.com/groups/${ws.id}`, '_blank');
        }
      });
    });

    // Table row clicks → select that item
    this._contentEl.querySelectorAll('.ws-table-row[data-item-id]').forEach(row => {
      row.addEventListener('click', () => {
        const itemId = row.dataset.itemId;
        const children = this._children[ws.id] || [];
        const item = children.find(c => c.id === itemId);
        if (item) this._selectItem(item, ws);
      });
    });
  }

  // ────────────────────────────────────────────
  // Content panel: Lakehouse
  // ────────────────────────────────────────────

  async _showLakehouseContent(lh, ws) {
    if (!this._contentEl) return;

    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(lh.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-meta-id" data-copy-id="${this._esc(lh.id)}" title="Click to copy ID">${this._esc(lh.id.substring(0, 12))}...</span>`;
    html += '<span class="ws-meta-badge">Lakehouse</span>';
    html += '</div></div>';

    html += '<div class="ws-content-actions">';
    html += '<button class="ws-deploy-btn" id="ws-deploy-btn">Deploy to this Lakehouse</button>';
    html += '<button class="ws-action-btn" data-action="rename-lh">Rename</button>';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>';
    html += '</div>';

    html += '<div id="ws-deploy-progress" class="ws-deploy-progress" style="display:none"></div>';
    html += '<div class="ws-section"><div class="ws-section-title">Tables</div>';
    html += '<div id="ws-tables-list">Loading tables...</div></div>';

    this._contentEl.innerHTML = html;

    // Bind actions
    const deployBtn = document.getElementById('ws-deploy-btn');
    if (deployBtn) {
      deployBtn.addEventListener('click', () => this._deployToLakehouse(lh, ws));
    }
    this._bindContentActions(ws);

    // Load tables
    try {
      const tables = await this._loadTables(ws.id, lh.id);
      const tablesEl = document.getElementById('ws-tables-list');
      if (!tablesEl) return;
      if (tables.length === 0) {
        tablesEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">No tables found</div>';
        return;
      }
      let tableHtml = '<table class="ws-table"><thead><tr>';
      tableHtml += '<th>Name</th><th>Type</th><th>Format</th>';
      tableHtml += '</tr></thead><tbody>';
      for (const t of tables) {
        tableHtml += `<tr class="ws-table-row" data-table-name="${this._esc(t.name)}">`;
        tableHtml += `<td class="ws-table-name">${this._esc(t.name)}</td>`;
        tableHtml += `<td><span class="ws-type-badge">${this._esc(t.type || 'Delta')}</span></td>`;
        tableHtml += `<td>${this._esc(t.format || 'delta')}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table>';
      tablesEl.innerHTML = tableHtml;

      // Bind table row clicks → inspector
      tablesEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
        row.addEventListener('click', () => {
          // Deselect other rows
          tablesEl.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          const tbl = tables.find(x => x.name === row.dataset.tableName);
          if (tbl) this._showTableInspector(tbl);
        });
      });
    } catch (err) {
      const tablesEl = document.getElementById('ws-tables-list');
      if (tablesEl) tablesEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Could not load tables</div>';
      this._toast(`Failed to load tables: ${err.message}`, 'error');
    }
  }

  // ────────────────────────────────────────────
  // Content panel: Non-lakehouse item
  // ────────────────────────────────────────────

  _showItemContent(item, ws) {
    if (!this._contentEl) return;
    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(item.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-type-badge">${this._esc(item.type || 'Item')}</span>`;
    html += ` <span class="ws-meta-id" data-copy-id="${this._esc(item.id)}" title="Click to copy ID">${this._esc(item.id.substring(0, 12))}...</span>`;
    html += '</div></div>';

    html += '<div class="ws-content-actions">';
    html += `<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>`;
    html += '</div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._clearInspector();
  }

  // ────────────────────────────────────────────
  // Content panel: Empty state
  // ────────────────────────────────────────────

  _showEmptyContent() {
    if (!this._contentEl) return;
    this._contentEl.innerHTML =
      '<div class="ws-empty-state">' +
      '<div class="ws-empty-icon">\u25A6</div>' +
      '<div class="ws-empty-text">Select a workspace or lakehouse</div>' +
      '</div>';
  }

  // ────────────────────────────────────────────
  // Inspector panel
  // ────────────────────────────────────────────

  _showTableInspector(table) {
    if (!this._inspectorEl) return;
    let html = '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Table Info</div>';
    html += '<dl class="ws-insp-kv">';
    const fields = [
      ['Name', table.name],
      ['Type', table.type || 'Table'],
      ['Format', table.format || 'Delta'],
      ['Location', table.location || 'N/A'],
    ];
    for (const [label, val] of fields) {
      html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
    }
    html += '</dl></div>';
    this._inspectorEl.innerHTML = html;
  }

  _showWorkspaceInspector(ws) {
    if (!this._inspectorEl) return;

    let html = '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Workspace Info</div>';
    html += '<dl class="ws-insp-kv">';
    const fields = [
      ['Name', ws.displayName],
      ['ID', ws.id],
      ['Capacity', ws.capacityId || 'N/A'],
      ['State', ws.state || 'Active'],
    ];
    for (const [label, val] of fields) {
      html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
    }
    html += '</dl></div>';

    // Item counts by type
    const children = this._children[ws.id] || [];
    if (children.length > 0) {
      const counts = {};
      for (const item of children) {
        const type = item.type || 'Unknown';
        counts[type] = (counts[type] || 0) + 1;
      }
      html += '<div class="ws-insp-section">';
      html += '<div class="ws-insp-title">Item Counts</div>';
      html += '<dl class="ws-insp-kv">';
      for (const [type, count] of Object.entries(counts)) {
        html += `<dt>${this._esc(type)}</dt><dd>${count}</dd>`;
      }
      html += '</dl></div>';
    }

    this._inspectorEl.innerHTML = html;
  }

  _clearInspector() {
    if (this._inspectorEl) this._inspectorEl.innerHTML = '';
  }

  // ────────────────────────────────────────────
  // Deploy flow (simulated)
  // ────────────────────────────────────────────

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
      for (let idx = 0; idx < steps.length; idx++) {
        let cls = 'ws-deploy-step';
        let icon = '\u25CB'; // ○ pending
        if (idx < i) { cls += ' done'; icon = '\u2713'; } // ✓ done
        else if (idx === i) { cls += ' active'; icon = '\u25CF'; } // ● active
        html += `<div class="${cls}"><span>${icon}</span> ${idx + 1}/${steps.length} ${this._esc(steps[idx])}</div>`;
      }
      progressEl.innerHTML = html;
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
    }

    // All done
    let finalHtml = '';
    for (let idx = 0; idx < steps.length; idx++) {
      finalHtml += `<div class="ws-deploy-step done"><span>\u2713</span> ${idx + 1}/${steps.length} ${this._esc(steps[idx])}</div>`;
    }
    progressEl.innerHTML = finalHtml;
    this._toast('Deploy complete', 'success');
  }

  // ────────────────────────────────────────────
  // Favorites
  // ────────────────────────────────────────────

  _loadFavorites() {
    try {
      this._favorites = JSON.parse(localStorage.getItem('edog-favorites') || '[]');
    } catch {
      this._favorites = [];
    }
  }

  _saveFavorites() {
    localStorage.setItem('edog-favorites', JSON.stringify(this._favorites));
  }

  _saveFavorite(item) {
    if (this._favorites.find(f => f.id === item.id)) return;
    this._favorites.push({
      name: item.displayName,
      id: item.id,
      workspaceId: item.workspaceId,
      workspaceName: item.workspaceName || '',
    });
    this._saveFavorites();
    this._renderFavorites();
  }

  _renderFavorites() {
    if (!this._favoritesEl) return;
    this._favoritesEl.innerHTML = '';
    if (this._favorites.length === 0) {
      this._favoritesEl.innerHTML = '<div class="ws-tree-item dimmed" style="font-size:var(--text-xs)">No favorites yet</div>';
      return;
    }
    for (const fav of this._favorites) {
      const el = document.createElement('div');
      el.className = 'ws-fav-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ws-fav-name';
      nameSpan.textContent = fav.name;
      el.appendChild(nameSpan);

      if (fav.workspaceName) {
        const detail = document.createElement('span');
        detail.className = 'ws-fav-detail';
        detail.textContent = fav.workspaceName;
        el.appendChild(detail);
      }

      this._favoritesEl.appendChild(el);
    }
  }

  // ────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────

  _isLakehouse(item) {
    return (item.type || '').toLowerCase().includes('lakehouse');
  }

  _formatDate(isoStr) {
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '\u2014';
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return '\u2014';
    }
  }

  _esc(text) {
    const d = document.createElement('div');
    d.textContent = text || '';
    return d.innerHTML;
  }
}
