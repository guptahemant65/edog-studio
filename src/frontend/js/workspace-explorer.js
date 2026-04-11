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
  }

  async init() {
    this._createToast();
    this._createContextMenu();
    this._loadFavorites();
    this._renderFavorites();
    this._bindRefresh();
    this._bindTreeHeaderAdd();
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

      if (isExpanded) {
        if (!this._children[ws.id]) {
          // Loading indicator while children are being fetched
          const loadEl = document.createElement('div');
          loadEl.className = 'ws-tree-item dimmed';
          loadEl.style.paddingLeft = 'calc(var(--space-3) + 16px)';
          loadEl.textContent = 'Loading...';
          this._treeEl.appendChild(loadEl);
        } else {
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
    html += '<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>';
    html += '<button class="ws-action-btn" data-action="rename-lh">Rename</button>';
    html += '<button class="ws-action-btn" data-action="clone-env">Clone Environment</button>';
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
          '<div class="skel-wrap">' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--md"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--md"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--lg"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '</div>';
      }
      const tables = await this._loadTables(ws.id, lh.id, ws.capacityId);
      tablesEl = document.getElementById('ws-tables-list');
      if (!tablesEl) return;

      // Update section title with count
      const titleEl = tablesEl.closest('.ws-section')?.querySelector('.ws-section-title');
      if (titleEl) titleEl.innerHTML = `Tables <span class="ws-section-count">${tables.length}</span>`;

      if (tables.length === 0) {
        tablesEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">No tables found</div>';
        return;
      }

      // Reset sort state
      this._tableSort = { col: 'name', dir: 'asc' };
      this._tableSortOriginalRows = null;

      let tableHtml = '<div class="ws-table-container"><table class="ws-table"><thead><tr>';
      tableHtml += '<th class="sortable sorted" data-col="name">Name <span class="sort-icon">\u25B2</span></th>';
      tableHtml += '<th class="sortable" data-col="type">Type <span class="sort-icon">\u25B2\u25BC</span></th>';
      tableHtml += '<th class="sortable" data-col="format">Format <span class="sort-icon">\u25B2\u25BC</span></th>';
      tableHtml += '</tr></thead><tbody>';
      for (const t of tables) {
        tableHtml += `<tr class="ws-table-row" data-table-name="${this._esc(t.name)}">`;
        tableHtml += `<td class="ws-table-name">${this._esc(t.name)}</td>`;
        tableHtml += `<td><span class="ws-type-badge">${this._esc(t.type || 'Delta')}</span></td>`;
        tableHtml += `<td>${this._esc(t.format || 'delta')}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table></div>';
      tablesEl.innerHTML = tableHtml;

      // Bind sort handlers on column headers
      tablesEl.querySelectorAll('.ws-table th.sortable').forEach(th => {
        th.addEventListener('click', () => this._sortTable(th.dataset.col, tablesEl));
      });

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
      const errEl = document.getElementById('ws-tables-list');
      if (errEl) errEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Could not load tables</div>';
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
    const colIndex = { name: 0, type: 1, format: 2 }[column] ?? 0;

    if (!nextDir) {
      // Restore original order
      for (const row of this._tableSortOriginalRows) tbody.appendChild(row);
    } else {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const mult = nextDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const aText = (a.children[colIndex]?.textContent || '').toLowerCase();
        const bText = (b.children[colIndex]?.textContent || '').toLowerCase();
        return aText < bText ? -1 * mult : aText > bText ? 1 * mult : 0;
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

    // Show columns if available from batchGetTableDetails
    if (table.schema && table.schema.length > 0) {
      html += '<div class="ws-insp-section">';
      html += `<div class="ws-insp-title">Columns <span class="ws-insp-count">${table.schema.length}</span></div>`;
      html += '<table class="ws-insp-cols"><thead><tr><th>Name</th><th>Type</th><th>Null</th></tr></thead><tbody>';
      for (const col of table.schema) {
        html += '<tr>';
        html += `<td class="ws-col-name">${this._esc(col.name)}</td>`;
        html += `<td class="ws-col-type">${this._esc(col.type)}</td>`;
        html += `<td>${col.nullable ? '\u2713' : ''}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    } else if (this._selectedWorkspace && this._selectedWorkspace.capacityId) {
      // Offer to fetch details
      html += '<div class="ws-insp-section">';
      html += '<button class="ws-action-btn ws-fetch-details-btn">Load column details</button>';
      html += '</div>';
    }

    this._inspectorEl.innerHTML = html;

    // Bind "Load column details" button
    const detailBtn = this._inspectorEl.querySelector('.ws-fetch-details-btn');
    if (detailBtn) {
      detailBtn.addEventListener('click', async () => {
        detailBtn.textContent = 'Loading...';
        detailBtn.disabled = true;
        try {
          const ws = this._selectedWorkspace;
          const lh = this._selectedItem;
          const result = await this._api.getTableDetails(ws.id, lh.id, ws.capacityId, [table.name]);
          const details = result && result.value ? result.value.find(v => v.tableName === table.name) : null;
          if (details && details.result) {
            const enriched = { ...table, ...details.result, schemaName: details.schemaName };
            this._showTableInspector(enriched);
          } else {
            this._toast('No details returned', 'error');
          }
        } catch (err) {
          this._toast(`Details failed: ${err.message}`, 'error');
          detailBtn.textContent = 'Retry';
          detailBtn.disabled = false;
        }
      });
    }
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
    return cap ? cap.substring(0, 8) : 'Unknown';
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
