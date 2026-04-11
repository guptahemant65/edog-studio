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

    /** @type {{ col: string|null, dir: 'asc'|'desc'|null }} */
    this._tableSort = { col: null, dir: null };
    /** @type {HTMLElement[]|null} original row order before sorting */
    this._tableSortOriginalRows = null;

    /** @type {object[]|null} Current table list for enrichment merging */
    this._currentTables = null;

    /** @type {Intl.NumberFormat} Shared formatter for row counts */
    this._numFmt = new Intl.NumberFormat('en-IN');

    /** @type {Object<string, object[]>} Notebook properties per workspace */
    this._notebookCache = {};
    /** @type {Object<string, object[]>} Environment properties per workspace */
    this._environmentCache = {};
    /** @type {NotebookView|null} Active notebook IDE instance */
    this._activeNotebookView = null;
  }

  async init() {
    this._createToast();
    this._createContextMenu();
    this._loadFavorites();
    this._renderFavorites();
    this._bindRefresh();
    this._bindTreeHeaderAdd();
    this._bindGlobalKeys();
    this._showEmptyContent();
    this._clearInspector();
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
    this._toastEl.classList.remove('visible', 'error', 'success', 'has-actions');
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

  /**
   * Show a toast with Confirm / Cancel buttons. Returns a Promise<boolean>.
   * Auto-cancels after timeoutMs (default 5000).
   */
  _toastConfirm(msg, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!this._toastEl) { resolve(false); return; }
      clearTimeout(this._toastTimer);
      this._toastEl.classList.remove('visible', 'error', 'success', 'has-actions');

      this._toastEl.innerHTML = '';
      const msgSpan = document.createElement('span');
      msgSpan.className = 'edog-toast-msg';
      msgSpan.textContent = msg;
      this._toastEl.appendChild(msgSpan);

      const actions = document.createElement('span');
      actions.className = 'edog-toast-actions';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'edog-toast-btn confirm';
      confirmBtn.textContent = 'Confirm';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'edog-toast-btn';
      cancelBtn.textContent = 'Cancel';

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      this._toastEl.appendChild(actions);

      this._toastEl.classList.add('has-actions');
      void this._toastEl.offsetWidth;
      this._toastEl.classList.add('visible');

      let settled = false;
      const dismiss = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(this._toastTimer);
        this._toastEl.classList.remove('visible');
        resolve(result);
      };

      confirmBtn.addEventListener('click', () => dismiss(true));
      cancelBtn.addEventListener('click', () => dismiss(false));

      this._toastTimer = setTimeout(() => dismiss(false), timeoutMs);
    });
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
      items.push({ label: 'Create Lakehouse', action: () => this._ctxCreateLakehouse() });
      items.push({ sep: true });
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
    } else {
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
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

    // Find the tree row for this item and start inline editing
    const treeRow = this._findTreeRow(t);
    if (!treeRow) {
      this._toast('Could not locate tree node', 'error');
      return;
    }

    treeRow.classList.add('editing');
    const input = document.createElement('input');
    input.className = 'ws-inline-rename';
    input.type = 'text';
    input.value = oldName;
    treeRow.appendChild(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      cleanup();
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
            await this._api.renameItem(t.workspace.id, t.item.id, newName);
          }
          t.item.displayName = newName;
          this._toast(`Renamed to "${newName}"`, 'success');
        }
        this._renderTree();
        if (this._selectedItem && this._selectedItem.id === (t.item?.id || t.workspace?.id)) {
          if (t.isWorkspace) {
            this._selectWorkspace(t.workspace);
          } else {
            this._selectItem(t.item, t.workspace);
          }
        }
      } catch (err) {
        this._toast(`Rename failed: ${err.message}`, 'error');
        this._renderTree();
      }
    };

    const cleanup = () => {
      treeRow.classList.remove('editing');
      if (input.parentNode) input.remove();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
    };

    let committed = false;
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        committed = true;
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        cleanup();
      }
    };
    const onBlur = () => {
      if (!committed) commit();
    };

    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  /**
   * Locate the tree row DOM element for a given context-menu target.
   * @param {object} t - Context target { workspace, item, isWorkspace }
   * @returns {HTMLElement|null}
   */
  _findTreeRow(t) {
    if (!this._treeEl) return null;
    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const nodes = this._treeEl.querySelectorAll('.ws-tree-item');
    for (const node of nodes) {
      const nameEl = node.querySelector('.ws-tree-name');
      if (nameEl && nameEl.textContent === name) return node;
    }
    return null;
  }

  async _ctxDelete() {
    const t = this._ctxTarget;
    if (!t) return;

    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const kind = t.isWorkspace ? 'workspace' : (this._isLakehouse(t.item) ? 'lakehouse' : 'item');
    const ok = await this._toastConfirm(`Delete ${kind} "${name}"?`);
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
          await this._api.deleteItem(t.workspace.id, t.item.id);
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

  /** Start inline rename from hover action button (wraps _ctxRename). */
  _startRename(target) {
    this._ctxTarget = target;
    this._ctxRename();
  }

  /** Trigger delete from hover action button (wraps _ctxDelete). */
  _handleDelete(target) {
    this._ctxTarget = target;
    this._ctxDelete();
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

  /** Bind the "+" button in the tree header to create a new workspace. */
  _bindTreeHeaderAdd() {
    const header = document.querySelector('.ws-tree-header');
    if (!header) return;
    // Only add once
    if (header.querySelector('.ws-tree-add')) return;
    const addBtn = document.createElement('button');
    addBtn.className = 'ws-tree-add';
    addBtn.textContent = '+';
    addBtn.title = 'Create workspace';
    addBtn.setAttribute('aria-label', 'Create workspace');
    addBtn.addEventListener('click', () => this._showCreateWorkspaceInput());
    header.appendChild(addBtn);
  }

  /** Show inline input at top of tree for creating a new workspace. */
  _showCreateWorkspaceInput() {
    if (!this._treeEl) return;
    // Avoid duplicates
    if (this._treeEl.querySelector('.ws-create-row')) return;

    const row = document.createElement('div');
    row.className = 'ws-create-row';
    row.style.paddingLeft = '12px';

    const input = document.createElement('input');
    input.className = 'ws-create-input';
    input.type = 'text';
    input.placeholder = 'New workspace name';
    input.setAttribute('aria-label', 'New workspace name');
    row.appendChild(input);

    this._treeEl.insertBefore(row, this._treeEl.firstChild);
    input.focus();

    let committed = false;
    const commit = async () => {
      const name = input.value.trim();
      cleanup();
      if (!name) return;
      try {
        const result = await this._api.createWorkspace(name);
        this._toast(`Created workspace "${name}"`, 'success');
        await this.loadWorkspaces();
        // Expand the new workspace
        if (result && result.id) {
          this._expanded.add(result.id);
          this._renderTree();
        }
      } catch (err) {
        this._toast(`Create failed: ${err.message}`, 'error');
      }
    };

    const cleanup = () => {
      if (row.parentNode) row.remove();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
    };

    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        committed = true;
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        cleanup();
      }
    };
    const onBlur = () => {
      if (!committed) {
        committed = true;
        commit();
      }
    };

    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  /** Context menu action: create lakehouse inside selected workspace. */
  async _ctxCreateLakehouse() {
    const t = this._ctxTarget;
    if (!t || !t.isWorkspace) return;

    // Expand workspace so children are visible
    if (!this._expanded.has(t.workspace.id)) {
      await this._toggleWorkspace(t.workspace);
    }

    if (!this._treeEl) return;
    // Find insertion point: after workspace's last child in tree
    const allRows = Array.from(this._treeEl.querySelectorAll('.ws-tree-item'));
    let insertAfter = null;
    let foundWs = false;
    for (const row of allRows) {
      const nameEl = row.querySelector('.ws-tree-name');
      if (nameEl && nameEl.textContent === t.workspace.displayName && !foundWs) {
        foundWs = true;
        insertAfter = row;
        continue;
      }
      // Subsequent child rows (depth 1) belong to this workspace
      if (foundWs) {
        const pl = parseInt(row.style.paddingLeft, 10) || 0;
        if (pl > 12) {
          insertAfter = row;
        } else {
          break;
        }
      }
    }

    // Avoid duplicates
    if (this._treeEl.querySelector('.ws-create-row')) return;

    const row = document.createElement('div');
    row.className = 'ws-create-row';
    row.style.paddingLeft = '28px';

    const dot = document.createElement('span');
    dot.className = 'ws-tree-dot lakehouse';
    row.appendChild(dot);

    const input = document.createElement('input');
    input.className = 'ws-create-input';
    input.type = 'text';
    input.placeholder = 'New lakehouse name';
    input.setAttribute('aria-label', 'New lakehouse name');
    row.appendChild(input);

    if (insertAfter && insertAfter.nextSibling) {
      this._treeEl.insertBefore(row, insertAfter.nextSibling);
    } else {
      this._treeEl.appendChild(row);
    }
    input.focus();

    let committed = false;
    const commit = async () => {
      const name = input.value.trim();
      cleanup();
      if (!name) return;
      try {
        await this._api.createLakehouse(t.workspace.id, name);
        this._toast(`Created lakehouse "${name}"`, 'success');
        // Refresh children
        delete this._children[t.workspace.id];
        this._expanded.add(t.workspace.id);
        await this._toggleWorkspace(t.workspace);
        // toggleWorkspace collapsed it since it was expanded — expand again
        if (!this._expanded.has(t.workspace.id)) {
          await this._toggleWorkspace(t.workspace);
        }
      } catch (err) {
        this._toast(`Create failed: ${err.message}`, 'error');
      }
    };

    const cleanup = () => {
      if (row.parentNode) row.remove();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
    };

    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        committed = true;
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        cleanup();
      }
    };
    const onBlur = () => {
      if (!committed) {
        committed = true;
        commit();
      }
    };

    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideContextMenu();
      // Ctrl+F inside content panel → focus table filter
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const filterInput = this._contentEl?.querySelector('.ws-filter-input');
        if (filterInput && this._contentEl.contains(document.activeElement)) {
          e.preventDefault();
          filterInput.focus();
          filterInput.select();
        }
      }
    });
  }

  /**
   * Insert a filter bar above the table container inside ws-tables-list.
   * @param {HTMLElement} tablesEl - the ws-tables-list element
   */
  _insertTableFilter(tablesEl) {
    const container = tablesEl.querySelector('.ws-table-container');
    if (!container) return;

    const filterDiv = document.createElement('div');
    filterDiv.className = 'ws-table-filter';
    filterDiv.innerHTML =
      '<svg class="ws-filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14.5" y2="14.5"/></svg>' +
      '<input class="ws-filter-input" placeholder="Filter tables..." />' +
      '<span class="ws-filter-count" style="display:none"></span>' +
      '<button class="ws-filter-clear" style="display:none">\u2715</button>';

    tablesEl.insertBefore(filterDiv, container);

    const input = filterDiv.querySelector('.ws-filter-input');
    const countEl = filterDiv.querySelector('.ws-filter-count');
    const clearBtn = filterDiv.querySelector('.ws-filter-clear');
    const rows = container.querySelectorAll('.ws-table-row[data-table-name]');
    const totalCount = rows.length;

    const applyFilter = () => {
      const query = input.value.toLowerCase();
      let visible = 0;
      rows.forEach(row => {
        const name = (row.dataset.tableName || '').toLowerCase();
        const match = !query || name.includes(query);
        row.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      if (query) {
        countEl.textContent = `${visible} of ${totalCount}`;
        countEl.style.display = '';
        clearBtn.style.display = '';
      } else {
        countEl.style.display = 'none';
        clearBtn.style.display = 'none';
      }
    };

    const clearFilter = () => {
      input.value = '';
      applyFilter();
      input.focus();
    };

    input.addEventListener('input', applyFilter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        clearFilter();
      }
    });
    clearBtn.addEventListener('click', clearFilter);
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

  async _loadTables(wsId, lhId, capId) {
    if (this._isMock && typeof MockData !== 'undefined') {
      return MockData.tablesForLakehouse || [];
    }
    // Try public API first (works for non-schema lakehouses)
    try {
      const data = await this._api.listTables(wsId, lhId);
      return (data && (data.value || data.data)) || [];
    } catch (e) {
      // 400 = schema-enabled lakehouse → fall back to capacity host
      if (e.status === 400 && capId) {
        const data = await this._api.listTablesViaCapacity(wsId, lhId, capId);
        return (data && (data.value || data.data)) || [];
      }
      throw e;
    }
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
      const children = this._children[ws.id];
      const childCount = children ? children.length : null;

      const wsEl = this._buildTreeNode({
        name: ws.displayName,
        depth: 0,
        isWorkspace: true,
        expanded: isExpanded,
        selected: isSelected,
        countBadge: childCount,
        actions: true,
      });

      // Click toggle arrow → expand/collapse; click name → select AND expand
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
          // Select workspace AND expand if not already expanded
          if (!this._expanded.has(ws.id)) {
            this._toggleWorkspace(ws);
          }
          this._selectWorkspace(ws);
        });
      }
      // Fallback: clicking the row toggles + selects
      wsEl.addEventListener('click', () => {
        if (!this._expanded.has(ws.id)) {
          this._toggleWorkspace(ws);
        }
        this._selectWorkspace(ws);
      });

      // Action button events
      if (wsEl._renameBtn) {
        wsEl._renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._startRename({ workspace: ws, isWorkspace: true });
        });
      }
      if (wsEl._deleteBtn) {
        wsEl._deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._handleDelete({ workspace: ws, isWorkspace: true });
        });
      }
      if (wsEl._moreBtn) {
        wsEl._moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showContextMenu(e, { workspace: ws, item: null, isWorkspace: true, isLakehouse: false });
        });
      }

      // Context menu
      wsEl.addEventListener('contextmenu', (e) => {
        this._showContextMenu(e, { workspace: ws, item: null, isWorkspace: true, isLakehouse: false });
      });

      this._treeEl.appendChild(wsEl);

      if (isExpanded) {
        if (!this._children[ws.id]) {
          // Loading indicator while children are being fetched
          const loadEl = document.createElement('div');
          loadEl.className = 'ws-tree-item dimmed';
          loadEl.setAttribute('data-depth', '1');
          loadEl.textContent = 'Loading\u2026';
          this._treeEl.appendChild(loadEl);
        } else {
          for (const item of this._children[ws.id]) {
          const isLH = this._isLakehouse(item);
          const isItemSelected = this._selectedItem && this._selectedItem.id === item.id;
          const itemEl = this._buildTreeNode({
            name: item.displayName,
            depth: 1,
            dotColor: this._getItemColor(item.type),
            typeBadge: this._getTypeAbbrev(item.type),
            dimmed: !isLH,
            selected: isItemSelected,
            childAnim: true,
            actions: true,
          });

          itemEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this._selectItem(item, ws);
          });

          // Action button events for child items
          if (itemEl._renameBtn) {
            itemEl._renameBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this._startRename({ workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
            });
          }
          if (itemEl._deleteBtn) {
            itemEl._deleteBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this._handleDelete({ workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
            });
          }
          if (itemEl._moreBtn) {
            itemEl._moreBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this._showContextMenu(e, { workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
            });
          }

          itemEl.addEventListener('contextmenu', (e) => {
            this._showContextMenu(e, { workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
          });

          this._treeEl.appendChild(itemEl);
          }
        }
      }
    }
  }

  /**
   * Build a single tree-node DOM element.
   * Supports: SVG chevron toggle, folder icon, color dot, type badge,
   * count badge, hover action buttons (rename/delete/more).
   * @param {object} opts
   */
  _buildTreeNode(opts) {
    const el = document.createElement('div');
    let cls = 'ws-tree-item';
    if (opts.dimmed) cls += ' dimmed';
    if (opts.selected) cls += ' selected';
    if (opts.childAnim) cls += ' ws-tree-child';
    el.className = cls;
    el.setAttribute('data-depth', String(opts.depth || 0));

    // SVG chevron toggle (workspaces only)
    if (opts.isWorkspace) {
      const toggle = document.createElement('span');
      toggle.className = 'ws-tree-toggle' + (opts.expanded ? ' expanded' : '');
      toggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      el.appendChild(toggle);

      // Folder icon
      const folder = document.createElement('span');
      folder.className = 'ws-tree-folder-icon';
      folder.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
      el.appendChild(folder);
    }

    // Color dot (child items)
    if (opts.dotColor) {
      const dot = document.createElement('span');
      dot.className = 'ws-tree-dot';
      dot.style.background = opts.dotColor;
      el.appendChild(dot);
    }

    // Name label
    const nameEl = document.createElement('span');
    nameEl.className = 'ws-tree-name';
    nameEl.textContent = opts.name;
    el.appendChild(nameEl);

    // Type badge for child items ("LH", "NB", etc.)
    if (opts.typeBadge) {
      const badge = document.createElement('span');
      badge.className = 'ws-tree-type-badge';
      badge.textContent = opts.typeBadge;
      el.appendChild(badge);
    }

    // Count badge for workspaces ("N items")
    if (opts.countBadge !== undefined && opts.countBadge !== null) {
      const count = document.createElement('span');
      count.className = 'ws-tree-count';
      count.textContent = opts.countBadge === 1 ? '1 item' : `${opts.countBadge} items`;
      el.appendChild(count);
    }

    // Hover action buttons: rename, delete, ⋯
    if (opts.actions) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'ws-tree-actions';

      // Rename
      const renBtn = document.createElement('button');
      renBtn.className = 'ws-tree-action-btn';
      renBtn.title = 'Rename';
      renBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
      actionsEl.appendChild(renBtn);

      // Delete
      const delBtn = document.createElement('button');
      delBtn.className = 'ws-tree-action-btn danger';
      delBtn.title = 'Delete';
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
      actionsEl.appendChild(delBtn);

      // More (⋯)
      const moreBtn = document.createElement('button');
      moreBtn.className = 'ws-tree-action-btn';
      moreBtn.title = 'More actions';
      moreBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
      actionsEl.appendChild(moreBtn);

      el.appendChild(actionsEl);

      // Store refs for event binding
      el._renameBtn = renBtn;
      el._deleteBtn = delBtn;
      el._moreBtn = moreBtn;
    }

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
        // Show loading state immediately
        this._renderTree();
        try {
          let items = await this._loadChildren(ws);
          // Filter out internal artifacts (SqlAnalyticsEndpoint, etc.)
          items = items.filter(i => {
            const t = (i.type || '').toLowerCase();
            return !t.includes('sqlanalyticsendpoint') && !t.includes('kqlquerysetoverride');
          });
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
    // Refresh content panel if this workspace is currently selected
    if (this._selectedWorkspace && this._selectedWorkspace.id === ws.id && !this._selectedItem) {
      this._showWorkspaceContent(ws);
    }
  }

  _selectWorkspace(ws) {
    this._selectedWorkspace = ws;
    this._selectedItem = null;
    this._showWorkspaceContent(ws);
    this._showWorkspaceInspector(ws);
    this._renderTree();
  }

  _selectItem(item, workspace) {
    // Clean up active notebook IDE if navigating away
    if (this._activeNotebookView) {
      this._activeNotebookView.destroy();
      this._activeNotebookView = null;
      const inspectorPanel = document.getElementById('ws-inspector-panel');
      if (inspectorPanel) inspectorPanel.style.display = '';
    }

    this._selectedItem = { ...item, workspaceId: workspace.id, workspaceName: workspace.displayName };
    this._selectedWorkspace = workspace;

    this._showItemContent(item, workspace);
    this._clearInspector();
    this._renderTree();
  }

  // ────────────────────────────────────────────
  // Content panel: Workspace
  // ────────────────────────────────────────────

  _showWorkspaceContent(ws) {
    if (!this._contentEl) return;
    const capacityId = ws.capacityId || '';
    const envLabel = this._getEnvironmentLabel(ws);

    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(ws.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-guid" title="Click to copy" data-copy-id="${this._esc(ws.id)}">${this._esc(ws.id)}</span>`;
    if (capacityId) {
      html += `<span class="ws-meta-badge ws-badge-env">${this._esc(envLabel)}</span>`;
    }
    html += '</div></div>';

    // Action buttons with icons
    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="rename-ws"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>Rename</button>';
    html += '<button class="ws-action-btn" data-action="open-fabric-ws"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open in Fabric</button>';
    html += '<button class="ws-action-btn danger" data-action="delete-ws"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>Delete</button>';
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

    // Click-to-copy on ID (supports both .ws-meta-id and .ws-guid)
    const idEl = this._contentEl.querySelector('.ws-meta-id') || this._contentEl.querySelector('.ws-guid');
    if (idEl) {
      idEl.addEventListener('click', () => {
        const copyId = idEl.dataset.copyId || ws.id;
        this._copyToClipboard(copyId, 'Copied!');
        idEl.classList.add('copied');
        const origText = idEl.textContent;
        idEl.textContent = 'Copied!';
        setTimeout(() => {
          idEl.classList.remove('copied');
          idEl.textContent = origText;
        }, 1200);
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
        } else if (action === 'clone-env') {
          this._toast('Clone Environment — coming soon');
        } else if (action === 'open-notebook-ide') {
          this._openNotebookIDE(this._selectedItem, this._selectedWorkspace);
        } else if (action === 'rename-item') {
          const itm = this._selectedItem;
          if (itm) {
            this._ctxTarget = { workspace: ws, item: itm, isWorkspace: false, isLakehouse: false };
            this._ctxRename();
          }
        } else if (action === 'delete-item') {
          const itm = this._selectedItem;
          if (itm) {
            this._ctxTarget = { workspace: ws, item: itm, isWorkspace: false, isLakehouse: false };
            this._ctxDelete();
          }
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

    const envLabel = this._getEnvironmentLabel(ws);
    const health = this._getHealthStatus(ws);
    const lastMod = lh.lastUpdatedDate ? this._formatDate(lh.lastUpdatedDate) : null;

    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(lh.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-guid" data-copy-id="${this._esc(lh.id)}" title="Click to copy full ID">${this._esc(lh.id)}</span>`;
    html += '</div>';
    html += '<div class="ws-header-badges">';
    html += `<span class="ws-badge ws-badge-env">${this._esc(envLabel)}</span>`;
    if (ws._region) {
      html += `<span class="ws-badge ws-badge-region">${this._esc(ws._region)}</span>`;
    }
    if (lastMod) {
      html += `<span class="ws-modified">Modified ${lastMod}</span>`;
    }
    html += `<span class="ws-badge ws-badge-health" style="color:${health.color}">● ${this._esc(health.status)}</span>`;
    html += '</div></div>';

    html += '<div class="ws-content-actions">';
    html += '<button class="ws-deploy-btn" id="ws-deploy-btn">\u25B6 Deploy to this Lakehouse</button>';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open in Fabric</button>';
    html += '<button class="ws-action-btn" data-action="rename-lh"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>Rename</button>';
    html += '<button class="ws-action-btn" data-action="clone-env"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Clone Environment</button>';
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

    // Load tables — show shimmer while fetching
    try {
      let tablesEl = document.getElementById('ws-tables-list');
      if (tablesEl) {
        tablesEl.innerHTML =
          '<div class="ws-table-container">' +
          '<div class="skel-wrap">' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--md"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--md"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--lg"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '</div></div>';
      }
      const tables = await this._loadTables(ws.id, lh.id, ws.capacityId);
      tablesEl = document.getElementById('ws-tables-list');
      if (!tablesEl) return;

      // Update section title with count
      const titleEl = tablesEl.closest('.ws-section')?.querySelector('.ws-section-title');
      if (titleEl) titleEl.innerHTML = `Tables <span class="ws-section-count">${tables.length}</span>`;

      if (tables.length === 0) {
        tablesEl.innerHTML =
          '<div class="ws-empty-state ws-empty-inline">' +
          '<div class="ws-empty-title">No tables</div>' +
          '<div class="ws-empty-desc">Tables appear after data is written to this lakehouse</div>' +
          '</div>';
        return;
      }

      // Reset sort state
      this._tableSort = { col: 'name', dir: 'asc' };
      this._tableSortOriginalRows = null;

      let tableHtml = '<div class="ws-table-container"><table class="ws-table"><thead><tr>';
      tableHtml += '<th class="sortable sorted" data-col="name">Name <span class="sort-icon">\u25B2</span></th>';
      tableHtml += '<th class="sortable" data-col="type">Type <span class="sort-icon">\u25B2\u25BC</span></th>';
      tableHtml += '<th class="sortable" data-col="format">Format <span class="sort-icon">\u25B2\u25BC</span></th>';
      tableHtml += '<th class="sortable num" data-col="rows">Rows <span class="sort-icon">\u25B2\u25BC</span></th>';
      tableHtml += '<th class="sortable num" data-col="size">Size <span class="sort-icon">\u25B2\u25BC</span></th>';
      tableHtml += '</tr></thead><tbody>';
      for (const t of tables) {
        const tType = t.tableType || t.type || '';
        const tFormat = t.tableFormat || t.format || 'delta';
        tableHtml += `<tr class="ws-table-row" data-table-name="${this._esc(t.name)}">`;
        tableHtml += `<td class="ws-table-name">${this._esc(t.name)}</td>`;
        tableHtml += `<td><span class="ws-type-badge">${this._esc(this._tableTypeBadge(tType))}</span></td>`;
        tableHtml += `<td>${this._esc(tFormat)}</td>`;
        tableHtml += '<td class="num">\u2014</td>';
        tableHtml += '<td class="num">\u2014</td>';
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table></div>';
      tablesEl.innerHTML = tableHtml;

      // Store tables for enrichment merging — normalize field names
      this._currentTables = tables.map(t => ({
        ...t,
        type: t.tableType || t.type || '',
        format: t.tableFormat || t.format || 'delta',
      }));

      // Insert table filter bar above the table container
      this._insertTableFilter(tablesEl);

      // Bind sort handlers on column headers
      tablesEl.querySelectorAll('.ws-table th.sortable').forEach(th => {
        th.addEventListener('click', () => this._sortTable(th.dataset.col, tablesEl));
      });

      // Bind table row clicks → inspector (use this._currentTables for enriched data)
      tablesEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
        row.addEventListener('click', () => {
          tablesEl.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          const src = this._currentTables || tables;
          const tbl = src.find(x => x.name === row.dataset.tableName);
          if (tbl) this._showTableInspector(tbl);
        });
      });

      // Auto-enrich: fetch detailed metadata (type, schema) in background
      if (ws.capacityId && tables.length > 0) {
        const tableNames = tables.map(t => t.name);
        this._api.getTableDetails(ws.id, lh.id, ws.capacityId, tableNames)
          .then(result => this._enrichTableRows(result))
          .catch(() => this._clearTableShimmer());

        // Fetch row count + size for each table via OneLake delta log
        for (const t of tables) {
          this._api.getTableStats(ws.id, lh.id, t.name)
            .then(stats => {
              if (!stats || stats.rowCount == null) return;
              // Update stored table
              const stored = (this._currentTables || []).find(x => x.name === t.name);
              if (stored) {
                stored.rowCount = stats.rowCount;
                stored.sizeInBytes = stats.sizeBytes;
              }
              // Update DOM
              const row = document.querySelector(`.ws-table-row[data-table-name="${CSS.escape(t.name)}"]`);
              if (row) {
                const rowsCell = row.children[3];
                const sizeCell = row.children[4];
                if (rowsCell) {
                  rowsCell.className = 'num';
                  rowsCell.textContent = stats.rowCount != null ? this._numFmt.format(stats.rowCount) : '\u2014';
                }
                if (sizeCell) {
                  sizeCell.className = 'num';
                  sizeCell.textContent = this._formatSize(stats.sizeBytes);
                }
              }
            })
            .catch(() => {}); // silently degrade
        }
      }
    } catch (err) {
      const errEl = document.getElementById('ws-tables-list');
      if (errEl) {
        let title = 'Could not load tables';
        let detail = err.message || 'Unknown error';
        let actionHtml = '';
        const lhRef = lh;
        const wsRef = ws;

        if (err.status === 502) {
          title = 'Capacity host unavailable (502)';
          detail = 'The capacity may be restarting.';
          actionHtml = '<button class="ws-action-btn ws-retry-btn">Retry</button>';
        } else if (err.status === 401 || err.status === 403 || (err.message && err.message.toLowerCase().includes('auth'))) {
          title = 'Authentication error';
          detail = 'Could not generate MWC token';
          actionHtml = '<button class="ws-action-btn ws-retry-btn">Re-authenticate</button>';
        } else {
          actionHtml = '<button class="ws-action-btn ws-retry-btn">Retry</button>';
        }

        errEl.innerHTML =
          '<div class="ws-error-state">' +
          '<div class="ws-error-icon">\u2715</div>' +
          '<div class="ws-error-title">' + this._esc(title) + '</div>' +
          '<div class="ws-error-detail">' + this._esc(detail) + '</div>' +
          actionHtml +
          '</div>';

        const retryBtn = errEl.querySelector('.ws-retry-btn');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => {
            this._showLakehouseContent(lhRef, wsRef);
          });
        }
      }
      this._toast(`Tables: ${err.message}`, 'error');
    }
  }

  // ────────────────────────────────────────────
  // Table sorting (DOM-only, no re-fetch)
  // ────────────────────────────────────────────

  /**
   * Cycle sort: asc → desc → neutral (original order).
   * @param {string} column - data-col value (name, type, format)
   * @param {HTMLElement} container - the ws-tables-list element
   */
  _sortTable(column, container) {
    const table = container.querySelector('.ws-table');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    // Capture original order on first sort interaction
    if (!this._tableSortOriginalRows) {
      this._tableSortOriginalRows = Array.from(tbody.querySelectorAll('tr'));
    }

    // Determine next direction
    let nextDir;
    if (this._tableSort.col === column) {
      if (this._tableSort.dir === 'asc') nextDir = 'desc';
      else if (this._tableSort.dir === 'desc') nextDir = null;
      else nextDir = 'asc';
    } else {
      nextDir = 'asc';
    }

    this._tableSort = { col: nextDir ? column : null, dir: nextDir };

    // Column index mapping
    const colIndex = { name: 0, type: 1, format: 2, rows: 3, size: 4 }[column] ?? 0;
    const isNumeric = column === 'rows' || column === 'size';

    if (!nextDir) {
      // Restore original order
      for (const row of this._tableSortOriginalRows) tbody.appendChild(row);
    } else {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const mult = nextDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const aText = (a.children[colIndex]?.textContent || '').trim();
        const bText = (b.children[colIndex]?.textContent || '').trim();
        if (isNumeric) {
          const aNum = parseFloat(aText.replace(/[^0-9.]/g, '')) || 0;
          const bNum = parseFloat(bText.replace(/[^0-9.]/g, '')) || 0;
          return (aNum - bNum) * mult;
        }
        const aLow = aText.toLowerCase();
        const bLow = bText.toLowerCase();
        return aLow < bLow ? -1 * mult : aLow > bLow ? 1 * mult : 0;
      });
      for (const row of rows) tbody.appendChild(row);
    }

    // Update header icons
    table.querySelectorAll('th.sortable').forEach(th => {
      const icon = th.querySelector('.sort-icon');
      if (!icon) return;
      if (th.dataset.col === this._tableSort.col) {
        th.classList.add('sorted');
        icon.textContent = this._tableSort.dir === 'asc' ? '\u25B2' : '\u25BC';
      } else {
        th.classList.remove('sorted');
        icon.textContent = '\u25B2\u25BC';
      }
    });
  }

  // ────────────────────────────────────────────
  // Table enrichment (auto-fetch rows/size/schema)
  // ────────────────────────────────────────────

  /**
   * Map a table type string to a short display badge label.
   * @param {string} type - e.g. "MATERIALIZED_LAKE_VIEW", "EXTERNAL", "MANAGED"
   * @returns {string} Short badge label
   */
  _tableTypeBadge(type) {
    const map = {
      'MATERIALIZED_LAKE_VIEW': 'MLV',
      'EXTERNAL': 'External',
      'MANAGED': 'Managed',
    };
    return map[type] || type || 'Table';
  }

  /**
   * Format byte counts to human-readable size strings.
   * @param {number} bytes
   * @returns {string} e.g. "156 MB", "1.2 GB"
   */
  _formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '\u2014';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
  }

  /**
   * Enrich rendered table rows with data from batchGetTableDetails response.
   * Updates shimmer cells with actual values and merges data onto stored tables.
   * @param {object} result - Response from getTableDetails API
   */
  _enrichTableRows(result) {
    // API response: { result: { value: [...] }, id, status }
    const items = result?.result?.value || result?.value || [];
    const detailMap = new Map();
    for (const item of items) {
      if (item.tableName) detailMap.set(item.tableName, item);
    }

    // Merge onto stored table objects for inspector use
    if (this._currentTables) {
      for (const tbl of this._currentTables) {
        const detail = detailMap.get(tbl.name);
        if (!detail) continue;
        if (detail.result) {
          tbl.location = detail.result.location || tbl.location;
          tbl.schema = detail.result.schema || tbl.schema;
          tbl._enrichedType = detail.result.type || null;
          if (detail.result.format) tbl.format = detail.result.format;
        }
        tbl.schemaName = detail.schemaName || tbl.schemaName;
        tbl.status = detail.status;
        tbl.rowCount = detail.result?.rowCount ?? null;
        tbl.sizeInBytes = detail.result?.sizeInBytes ?? null;
      }
    }

    // Update DOM cells
    const tablesEl = document.getElementById('ws-tables-list');
    if (!tablesEl) return;

    tablesEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
      const name = row.dataset.tableName;
      const detail = detailMap.get(name);

      // Rows cell (index 3)
      const rowsCell = row.children[3];
      // Size cell (index 4)
      const sizeCell = row.children[4];

      if (detail && detail.result) {
        // Update type badge if enriched type is available
        const typeBadge = row.children[1]?.querySelector('.ws-type-badge');
        if (typeBadge && detail.result.type) {
          typeBadge.textContent = this._tableTypeBadge(detail.result.type);
        }

        // Rows
        if (rowsCell) {
          const count = detail.result.rowCount;
          rowsCell.className = 'num';
          rowsCell.textContent = count != null ? this._numFmt.format(count) : '\u2014';
        }

        // Size
        if (sizeCell) {
          sizeCell.className = 'num';
          sizeCell.textContent = this._formatSize(detail.result.sizeInBytes);
        }
      } else {
        // No detail for this table — clear shimmer with dash
        if (rowsCell) { rowsCell.className = 'num'; rowsCell.textContent = '\u2014'; }
        if (sizeCell) { sizeCell.className = 'num'; sizeCell.textContent = '\u2014'; }
      }
    });

    // If inspector is showing a table that just got enriched, refresh it
    const inspNameEl = this._inspectorEl?.querySelector('.ws-insp-kv dd');
    if (inspNameEl && this._currentTables) {
      const inspName = inspNameEl.textContent;
      const enrichedTable = this._currentTables.find(t => t.name === inspName);
      if (enrichedTable && enrichedTable.schema && enrichedTable.schema.length > 0) {
        this._showTableInspector(enrichedTable);
      }
    }
  }

  /**
   * Remove shimmer from Rows/Size cells, replacing with dash placeholders.
   * Called when enrichment is skipped (no capacityId) or fails.
   */
  _clearTableShimmer() {
    const tablesEl = document.getElementById('ws-tables-list');
    if (!tablesEl) return;
    tablesEl.querySelectorAll('.skel-cell').forEach(cell => {
      cell.className = 'num';
      cell.textContent = '\u2014';
    });
  }

  // ────────────────────────────────────────────
  // Content panel: Type dispatcher
  // ────────────────────────────────────────────

  _showItemContent(item, ws) {
    if (!this._contentEl) return;
    const type = (item.type || '').toLowerCase();

    if (type === 'lakehouse') {
      this._showLakehouseContent(item, ws);
    } else if (type === 'notebook') {
      this._showNotebookContent(item, ws);
    } else if (type === 'environment') {
      this._showEnvironmentContent(item, ws);
    } else {
      this._showGenericItemContent(item, ws);
    }
  }

  // ──── Type-Specific Content Views ────

  async _showNotebookContent(item, ws) {
    // Fetch notebook properties (cached per workspace)
    if (!this._notebookCache[ws.id]) {
      try {
        const resp = await this._api.listNotebooks(ws.id);
        this._notebookCache[ws.id] = resp.value || [];
      } catch (e) {
        this._notebookCache[ws.id] = [];
      }
    }
    const nbData = this._notebookCache[ws.id].find(n => n.id === item.id);
    const props = nbData?.properties || {};
    const defaultLH = props.defaultLakehouse;
    const attachedEnv = props.attachedEnvironment;

    let html = this._buildRichHeader(item, ws);

    // Action bar
    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn accent" data-action="open-notebook-ide" title="Open notebook cell editor">&#9654; Open Notebook IDE</button>';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh" title="Open in Fabric portal">Open in Fabric</button>';
    html += `<button class="ws-action-btn" data-action="rename-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}" title="Rename notebook">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}" title="Delete notebook">Delete</button>`;
    html += '</div>';

    // Linked item cards
    if (defaultLH || attachedEnv) {
      html += '<div class="ws-linked-cards">';
      if (defaultLH) {
        const lhName = this._resolveItemName(ws.id, defaultLH.itemId) || defaultLH.itemId;
        html += this._buildLinkedCard(lhName, 'Default Lakehouse', 'LH', defaultLH.itemId, 'var(--status-succeeded)');
      }
      if (attachedEnv) {
        const envName = this._resolveItemName(ws.id, attachedEnv.itemId) || attachedEnv.itemId;
        html += this._buildLinkedCard(envName, 'Attached Environment', 'ENV', attachedEnv.itemId, 'var(--comp-onelake)');
      }
      html += '</div>';
    }

    // Notebook info card
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Notebook Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Default Lakehouse', defaultLH ? (this._resolveItemName(ws.id, defaultLH.itemId) || defaultLH.itemId) : '\u2014');
    html += this._infoRow('Attached Environment', attachedEnv ? (this._resolveItemName(ws.id, attachedEnv.itemId) || attachedEnv.itemId) : '\u2014');
    html += this._infoRow('Description', item.description || '\u2014');
    html += '</div></div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._bindLinkedCardClicks(ws);
    this._showItemInspector(item, ws, { defaultLH, attachedEnv });
  }

  async _showEnvironmentContent(item, ws) {
    if (!this._environmentCache[ws.id]) {
      try {
        const resp = await this._api.listEnvironments(ws.id);
        this._environmentCache[ws.id] = resp.value || [];
      } catch (e) {
        this._environmentCache[ws.id] = [];
      }
    }
    const envData = this._environmentCache[ws.id].find(e => e.id === item.id);
    const props = envData?.properties || {};
    const publish = props.publishDetails || {};
    const state = publish.state || 'Unknown';

    let html = this._buildRichHeader(item, ws);

    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>';
    html += `<button class="ws-action-btn" data-action="rename-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Delete</button>`;
    html += '</div>';

    // Publish status card
    const stateClass = state === 'Success' ? 'success' : state === 'Running' ? 'running' : state === 'Failed' ? 'failed' : '';
    html += '<div class="ws-env-publish"><div class="ws-env-publish-header">Publish Status</div><div class="ws-env-publish-body">';
    html += `<div class="ws-status-row"><span class="ws-status-dot ${stateClass}"></span><span class="ws-status-label">State</span><span class="ws-status-value">${this._esc(state)}</span></div>`;

    if (publish.targetVersion) {
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:var(--space-4)">Version</span><span class="ws-status-value mono">${this._esc(publish.targetVersion)}</span></div>`;
    }
    if (publish.startTime) {
      const start = new Date(publish.startTime);
      const end = publish.endTime ? new Date(publish.endTime) : null;
      const duration = end ? ((end - start) / 1000).toFixed(1) + 's' : 'In progress';
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:var(--space-4)">Published</span><span class="ws-status-value">${start.toLocaleString()}</span></div>`;
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:var(--space-4)">Duration</span><span class="ws-status-value">${this._esc(duration)}</span></div>`;
    }

    // Component breakdown
    const components = publish.componentPublishInfo || {};
    if (Object.keys(components).length > 0) {
      html += `<div style="margin-top:var(--space-3);font-size:var(--text-xs);font-weight:600;color:var(--text-muted)">Components</div>`;
      for (const [name, comp] of Object.entries(components)) {
        const cState = comp?.state || 'Unknown';
        const cClass = cState === 'Success' ? 'success' : cState === 'Running' ? 'running' : 'failed';
        const label = name === 'sparkLibraries' ? 'Spark Libraries' : name === 'sparkSettings' ? 'Spark Settings' : name;
        html += `<div class="ws-status-row"><span class="ws-status-dot ${cClass}"></span><span class="ws-status-label">${this._esc(label)}</span><span class="ws-status-value">${this._esc(cState)}</span></div>`;
      }
    }
    html += '</div></div>';

    // Environment info
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Environment Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Description', item.description || 'Environment');
    html += this._infoRow('Workspace', ws.name || ws.displayName || ws.id);
    html += '</div></div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._showItemInspector(item, ws, { publish });
  }

  _showGenericItemContent(item, ws) {
    let html = this._buildRichHeader(item, ws);

    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>';
    html += `<button class="ws-action-btn" data-action="rename-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Delete</button>`;
    html += '</div>';

    html += '<div class="ws-item-info"><div class="ws-item-info-header">Item Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Type', item.type || 'Unknown');
    html += this._infoRow('Description', item.description || '\u2014');
    html += this._infoRow('Workspace', ws.name || ws.displayName || ws.id);
    html += this._infoRow('ID', item.id);
    html += '</div></div>';

    html += '<a class="ws-fabric-link" href="#" data-action="open-fabric-lh">More details available in Fabric \u2197</a>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._showItemInspector(item, ws, {});
  }

  // ────────────────────────────────────────────
  // Content panel: Empty state
  // ────────────────────────────────────────────

  _showEmptyContent() {
    if (!this._contentEl) return;
    this._contentEl.innerHTML =
      '<div class="ws-empty-state">' +
      '<svg class="ws-empty-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<path d="M6 10a2 2 0 012-2h10l4 4h18a2 2 0 012 2v24a2 2 0 01-2 2H8a2 2 0 01-2-2V10z"/>' +
      '<path d="M6 18h36" stroke-dasharray="2 2" opacity="0.4"/>' +
      '</svg>' +
      '<div class="ws-empty-title">Select a workspace or lakehouse</div>' +
      '<div class="ws-empty-desc">Browse the tree on the left to explore your Fabric environment</div>' +
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
      ['Type', this._tableTypeBadge(table.tableType || table.type || table._enrichedType || '')],
      ['Format', table.tableFormat || table.format || 'delta'],
    ];
    if (table.location) {
      fields.push(['Location', table.location]);
    }
    if (table.schemaName) {
      fields.push(['Schema', table.schemaName]);
    }
    for (const [label, val] of fields) {
      html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
    }
    html += '</dl></div>';

    // Schema section — render immediately if available, otherwise show shimmer
    if (table.schema && table.schema.length > 0) {
      html += this._renderSchemaSection(table.schema);
    } else if (this._selectedWorkspace && this._selectedWorkspace.capacityId) {
      html += this._renderSchemaShimmer();
    }

    // Preview section — column headers from schema or placeholder
    html += this._renderPreviewSection(table);

    this._inspectorEl.innerHTML = html;

    this._bindPreviewActions(table);

    // Auto-load schema if not already enriched
    if (!(table.schema && table.schema.length > 0) &&
        this._selectedWorkspace && this._selectedWorkspace.capacityId) {
      this._autoLoadSchema(table);
    }
  }

  /** Render the schema columns section from an array of column descriptors. */
  _renderSchemaSection(schema) {
    let html = '<div class="ws-insp-section">';
    html += `<div class="ws-insp-title">Schema <span class="ws-insp-count">${schema.length} columns</span></div>`;
    html += '<table class="ws-insp-cols"><thead><tr><th>Column</th><th>Type</th><th>Null</th></tr></thead><tbody>';
    for (const col of schema) {
      html += '<tr>';
      html += `<td class="ws-col-name">${this._esc(col.name)}</td>`;
      html += `<td class="ws-col-type">${this._esc(col.type)}</td>`;
      html += `<td>${col.nullable ? '\u2713' : ''}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  /** Render shimmer skeleton placeholder for schema loading. */
  _renderSchemaShimmer() {
    let html = '<div class="ws-insp-section ws-insp-schema-loading">';
    html += '<div class="ws-insp-title">Schema</div>';
    html += '<div class="ws-insp-skel">';
    html += '<div class="skel-line skel-line--lg"></div>';
    html += '<div class="skel-line skel-line--md"></div>';
    html += '<div class="skel-line skel-line--sm"></div>';
    html += '</div></div>';
    return html;
  }

  /** Render inline error with retry for failed schema load. */
  _renderSchemaError(table) {
    let html = '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Schema</div>';
    html += '<div class="ws-error-inline">Could not load schema ';
    html += '<button class="ws-retry-link">Retry</button></div></div>';
    return html;
  }

  /** Render data preview section — shows column headers from schema or a placeholder. */
  _renderPreviewSection(table) {
    let html = '<div class="ws-insp-section ws-preview-section">';
    html += '<div class="ws-insp-title">Preview</div>';

    if (table.schema && table.schema.length > 0) {
      // Show column headers as an empty preview table
      const maxCols = 6;
      const cols = table.schema.slice(0, maxCols);
      const colCount = cols.length;
      html += '<table class="ws-preview-table"><thead><tr>';
      for (const col of cols) {
        html += `<th>${this._esc(col.name)}</th>`;
      }
      if (table.schema.length > maxCols) {
        html += `<th>\u22ef</th>`;
      }
      html += '</tr></thead><tbody>';
      html += `<tr><td colspan="${table.schema.length > maxCols ? colCount + 1 : colCount}" class="ws-preview-empty">`;
      html += 'Deploy to load preview data</td></tr>';
      html += '</tbody></table>';
      html += '<div class="ws-preview-note">';
      html += '<button class="ws-action-btn ws-preview-btn">Load Preview</button>';
      html += '</div>';
    } else {
      html += '<div class="ws-preview-placeholder">';
      html += '<div class="ws-empty-desc">Table preview requires a running FLT service</div>';
      html += '<button class="ws-action-btn ws-preview-btn">Load Preview</button>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  /** Bind click handler for the Load Preview button. */
  _bindPreviewActions(table) {
    if (!this._inspectorEl) return;
    const btn = this._inspectorEl.querySelector('.ws-preview-btn');
    if (!btn) return;
    btn.addEventListener('click', () => this._handlePreviewLoad(table));
  }

  /** Handle Load Preview click — show shimmer then phase-1 message. */
  _handlePreviewLoad(table) {
    if (!this._inspectorEl) return;
    const section = this._inspectorEl.querySelector('.ws-preview-section');
    if (!section) return;

    // Replace content with shimmer rows
    let shimmer = '<div class="ws-insp-title">Preview</div>';
    shimmer += '<div class="ws-insp-skel">';
    shimmer += '<div class="skel-line skel-line--lg"></div>';
    shimmer += '<div class="skel-line skel-line--md"></div>';
    shimmer += '<div class="skel-line skel-line--sm"></div>';
    shimmer += '</div>';
    section.innerHTML = shimmer;

    // After 2s, show phase-1 unavailable message
    setTimeout(() => {
      if (!this._inspectorEl) return;
      const s = this._inspectorEl.querySelector('.ws-preview-section');
      if (!s) return;
      let msg = '<div class="ws-insp-title">Preview</div>';
      msg += '<div class="ws-preview-placeholder">';
      msg += '<div class="ws-empty-desc">Preview not available \u2014 deploy to enable</div>';
      msg += '</div>';
      s.innerHTML = msg;
    }, 2000);
  }

  /** Auto-fetch schema for a single table and update the inspector in-place. */
  async _autoLoadSchema(table) {
    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;
    if (!ws || !lh) return;

    try {
      const result = await this._api.getTableDetails(ws.id, lh.id, ws.capacityId, [table.name]);
      // API response: { result: { value: [...] }, id, status }
      const allDetails = result?.result?.value || result?.value || [];
      const details = allDetails.find(v => v.tableName === table.name) || null;

      if (details && details.result) {
        // Merge enrichment onto the stored table object
        if (this._currentTables) {
          const stored = this._currentTables.find(t => t.name === table.name);
          if (stored) {
            stored.schema = details.result.schema || stored.schema;
            stored.location = details.result.location || stored.location;
            stored.schemaName = details.schemaName || stored.schemaName;
            if (details.result.format) stored.format = details.result.format;
            stored._enrichedType = details.result.type || null;
          }
        }

        const schema = details.result.schema;
        if (schema && schema.length > 0) {
          this._replaceSchemaShimmer(this._renderSchemaSection(schema));
          this._updatePreviewWithSchema(table);
          return;
        }
      }
      // No schema in response — remove shimmer, show nothing
      this._replaceSchemaShimmer('');
    } catch {
      this._replaceSchemaShimmerWithError(table);
    }
  }

  /** Replace the shimmer placeholder with rendered schema HTML. */
  _replaceSchemaShimmer(html) {
    if (!this._inspectorEl) return;
    const shimmer = this._inspectorEl.querySelector('.ws-insp-schema-loading');
    if (!shimmer) return;
    if (!html) { shimmer.remove(); return; }
    const frag = document.createRange().createContextualFragment(html);
    shimmer.replaceWith(frag);
  }

  /** Replace shimmer with error + retry button. */
  _replaceSchemaShimmerWithError(table) {
    if (!this._inspectorEl) return;
    const shimmer = this._inspectorEl.querySelector('.ws-insp-schema-loading');
    if (!shimmer) return;
    const errHtml = this._renderSchemaError(table);
    const frag = document.createRange().createContextualFragment(errHtml);
    const retryBtn = frag.querySelector('.ws-retry-link');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        // Replace error with shimmer and retry
        const parent = retryBtn.closest('.ws-insp-section');
        if (parent) {
          const shimmerFrag = document.createRange().createContextualFragment(this._renderSchemaShimmer());
          parent.replaceWith(shimmerFrag);
        }
        this._autoLoadSchema(table);
      });
    }
    shimmer.replaceWith(frag);
  }

  /** Update the preview section in-place once schema becomes available. */
  _updatePreviewWithSchema(table) {
    if (!this._inspectorEl) return;
    const section = this._inspectorEl.querySelector('.ws-preview-section');
    if (!section) return;
    const previewHtml = this._renderPreviewSection(table);
    const frag = document.createRange().createContextualFragment(previewHtml);
    const btn = frag.querySelector('.ws-preview-btn');
    if (btn) btn.addEventListener('click', () => this._handlePreviewLoad(table));
    section.replaceWith(frag);
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
      ['Description', ws.description || '\u2014'],
    ];
    for (const [label, val] of fields) {
      html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
    }
    html += '</dl></div>';

    // Item counts by type with lakehouse highlighting
    const children = this._children[ws.id] || [];
    if (children.length > 0) {
      const counts = {};
      let lhCount = 0;
      for (const item of children) {
        const type = item.type || 'Unknown';
        counts[type] = (counts[type] || 0) + 1;
        if (this._isLakehouse(item)) lhCount++;
      }
      html += '<div class="ws-insp-section">';
      html += '<div class="ws-insp-title">Item Counts</div>';
      html += '<dl class="ws-insp-kv">';
      if (lhCount > 0) {
        html += `<dt>Lakehouses</dt><dd style="color:var(--status-succeeded);font-weight:600">${lhCount}</dd>`;
      }
      for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        if (!type.toLowerCase().includes('lakehouse')) {
          html += `<dt>${this._esc(type)}</dt><dd>${count}</dd>`;
        }
      }
      html += `<dt style="font-weight:600;padding-top:var(--space-1)">Total</dt><dd style="font-weight:600;padding-top:var(--space-1)">${children.length}</dd>`;
      html += '</dl></div>';
    } else if (this._expanded.has(ws.id)) {
      html += '<div class="ws-insp-section">';
      html += '<div class="ws-insp-title">Items</div>';
      html += '<p style="font-size:var(--text-xs);color:var(--text-muted)">No items in this workspace</p>';
      html += '</div>';
    }

    this._inspectorEl.innerHTML = html;
  }

  _clearInspector() {
    if (!this._inspectorEl) return;
    this._inspectorEl.innerHTML =
      '<div class="ws-empty-state ws-empty-inline">' +
      '<div class="ws-empty-title">Inspector</div>' +
      '<div class="ws-empty-desc">Select an item to see details</div>' +
      '</div>';
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

  // ──── Type-Specific Content Helpers ────

  /** Build a rich content header with name, type badge, full GUID, and description. */
  _buildRichHeader(item, ws) {
    const color = this._getItemColor(item.type);
    const badge = this._getTypeAbbrev(item.type);
    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(item.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-type-badge" style="color:${color}">${badge}</span>`;
    html += ` <span class="ws-guid" title="Click to copy" data-copy-id="${this._esc(item.id)}">${this._esc(item.id)}</span>`;
    html += '</div>';
    if (item.description) {
      html += `<div style="font-size:var(--text-sm);color:var(--text-dim);margin-top:var(--space-1)">${this._esc(item.description)}</div>`;
    }
    html += '</div>';
    return html;
  }

  /** Build a clickable linked item card. */
  _buildLinkedCard(name, label, typeBadge, itemId, dotColor) {
    return `<div class="ws-linked-card" data-navigate-item="${this._esc(itemId)}">
      <div class="ws-linked-card-header">
        <span class="ws-linked-card-dot" style="background:${dotColor}"></span>
        <span class="ws-linked-card-name">${this._esc(name)}</span>
      </div>
      <div class="ws-linked-card-label">${this._esc(label)}</div>
      <div class="ws-linked-card-id">${this._esc(typeBadge)} \u00b7 ${this._esc(String(itemId).substring(0, 8))}\u2026</div>
    </div>`;
  }

  /** Build an info row for item info cards. */
  _infoRow(key, value) {
    return `<div class="ws-item-info-row"><span class="ws-item-info-key">${this._esc(key)}</span><span class="ws-item-info-val">${this._esc(String(value))}</span></div>`;
  }

  /** Resolve item name from workspace children cache. */
  _resolveItemName(wsId, itemId) {
    const children = this._children[wsId] || [];
    const found = children.find(c => c.id === itemId);
    return found ? found.displayName : null;
  }

  /** Bind click handlers for linked item cards — navigate to that item in the tree. */
  _bindLinkedCardClicks(ws) {
    if (!this._contentEl) return;
    this._contentEl.querySelectorAll('[data-navigate-item]').forEach(card => {
      card.addEventListener('click', () => {
        const targetId = card.dataset.navigateItem;
        const children = this._children[ws.id] || [];
        const target = children.find(c => c.id === targetId);
        if (target) {
          this._selectItem(target, ws);
          // Highlight in tree
          if (this._treeEl) {
            this._treeEl.querySelectorAll('.ws-tree-item.selected').forEach(el => el.classList.remove('selected'));
            const treeItem = this._treeEl.querySelector(`[data-item-id="${targetId}"]`);
            if (treeItem) {
              treeItem.classList.add('selected');
              treeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        }
      });
    });
  }

  /** Populate inspector panel for any item type. */
  _showItemInspector(item, ws, extra) {
    if (!this._inspectorEl) return;
    let html = '<div class="ws-insp-section"><div class="ws-insp-title">Item Info</div>';
    html += '<dl class="ws-insp-kv">';
    html += `<dt>Name</dt><dd>${this._esc(item.displayName)}</dd>`;
    html += `<dt>Type</dt><dd>${this._esc(item.type || 'Unknown')}</dd>`;
    html += `<dt>ID</dt><dd style="font-family:var(--font-mono);font-size:10px;word-break:break-all">${this._esc(item.id)}</dd>`;
    html += `<dt>Workspace</dt><dd>${this._esc(ws.name || ws.displayName || ws.id)}</dd>`;
    if (item.description) {
      html += `<dt>Description</dt><dd>${this._esc(item.description)}</dd>`;
    }
    if (extra.defaultLH) {
      const lhName = this._resolveItemName(ws.id, extra.defaultLH.itemId) || extra.defaultLH.itemId;
      html += `<dt>Default LH</dt><dd>${this._esc(lhName)}</dd>`;
    }
    if (extra.attachedEnv) {
      const envName = this._resolveItemName(ws.id, extra.attachedEnv.itemId) || extra.attachedEnv.itemId;
      html += `<dt>Environment</dt><dd>${this._esc(envName)}</dd>`;
    }
    if (extra.publish) {
      html += `<dt>Publish State</dt><dd>${this._esc(extra.publish.state || 'Unknown')}</dd>`;
    }
    html += '</dl></div>';
    this._inspectorEl.innerHTML = html;
  }

  /** Open the full notebook IDE, replacing content+inspector panels. */
  async _openNotebookIDE(item, ws) {
    if (!this._contentEl || !item) return;

    if (typeof NotebookView === 'undefined') {
      this._toast('Notebook IDE not yet available', 'info');
      return;
    }

    // Hide inspector panel to give notebook full width
    const inspectorPanel = document.getElementById('ws-inspector-panel');
    if (inspectorPanel) inspectorPanel.style.display = 'none';

    // Create and load notebook view
    this._activeNotebookView = new NotebookView(
      this._contentEl, this._api, ws.id, item, { capacityId: ws.capacityId }
    );
    await this._activeNotebookView.load();
  }

  // ────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────

  /** Map item type to a color for the tree dot indicator. */
  _getItemColor(type) {
    const colors = {
      'Lakehouse': 'var(--status-succeeded)',
      'Notebook': '#2d7ff9',
      'Pipeline': '#e5940c',
      'MLExperiment': '#a855f7',
      'Report': 'var(--text-muted)',
      'Environment': '#0d9488',
      'SemanticModel': '#6d5cff',
    };
    return colors[type] || 'var(--text-muted)';
  }

  /** Get short type abbreviation for tree type badge. */
  _getTypeAbbrev(type) {
    const abbrevs = {
      'Lakehouse': 'LH',
      'Notebook': 'NB',
      'Pipeline': 'PL',
      'MLExperiment': 'ML',
      'Report': 'RPT',
      'Environment': 'ENV',
      'SemanticModel': 'SM',
      'SQLEndpoint': 'SQL',
    };
    return abbrevs[type] || type?.substring(0, 3)?.toUpperCase() || '';
  }

  _isLakehouse(item) {
    return (item.type || '').toLowerCase().includes('lakehouse');
  }

  /**
   * Derive environment label from workspace/capacity context.
   * @param {object} ws - Workspace object with capacityId.
   * @returns {string} Environment label like "PPE", "Prod", or truncated ID.
   */
  _getEnvironmentLabel(ws) {
    const cap = ws.capacityId || '';
    if (cap.includes('ppe') || cap.includes('PPE')) return 'PPE';
    if (cap.includes('prod') || cap.includes('PROD')) return 'Prod';
    if (cap.includes('test') || cap.includes('TEST')) return 'Test';
    // Detect from API host configuration
    const host = this._api?._baseUrl || window.location.hostname || '';
    if (host.includes('-int-') || host.includes('ppe') || host.includes('windows-int')) return 'PPE';
    if (host.includes('fabric.microsoft.com')) return 'Prod';
    return cap ? 'PPE' : 'Unknown';
  }

  /**
   * Derive health status from workspace/capacity state.
   * @param {object} ws - Workspace object.
   * @returns {{status: string, color: string}} Health status.
   */
  _getHealthStatus(ws) {
    const state = (ws.state || 'Active').toLowerCase();
    if (state === 'active') return { status: 'Healthy', color: 'var(--status-succeeded)' };
    if (state === 'throttled') return { status: 'Throttled', color: 'var(--level-warning)' };
    return { status: 'Unknown', color: 'var(--text-muted)' };
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
