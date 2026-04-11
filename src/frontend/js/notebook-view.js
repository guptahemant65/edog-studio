/**
 * NotebookView — Embedded notebook IDE for the workspace explorer.
 *
 * Renders notebook cells with editing, save, run-all, and per-cell execution.
 * Replaces the content+inspector panels when a notebook is opened.
 *
 * Dependencies:
 *   - NotebookParser  (notebook-parser.js) — parse / serialize notebook-content.sql
 *   - FabricApiClient  (api-client.js) — Fabric REST + notebook endpoints
 *
 * @author Zara Okonkwo — EDOG Studio hivemind
 */
class NotebookView {
  /**
   * @param {HTMLElement} containerEl — DOM element to render into.
   * @param {FabricApiClient} apiClient — Initialized API client instance.
   * @param {string} workspaceId — Current workspace GUID.
   * @param {{ id: string, displayName: string, type: string, properties?: object }} notebook
   * @param {{ capacityId?: string }} [options] — Extra context from workspace.
   */
  constructor(containerEl, apiClient, workspaceId, notebook, options = {}) {
    this._container = containerEl;
    this._api = apiClient;
    this._wsId = workspaceId;
    this._notebook = notebook;
    this._wsCapacityId = options.capacityId || null;
    this._cells = [];
    this._notebookMeta = {};
    this._platform = '';
    this._isDirty = false;
    this._isRunning = false;
    this._runLocation = null;
    this._runPollTimer = null;
    this._jupyterSession = null;
    this._selectedCellIndex = -1;
    this._editingCellIndex = -1;
    this._destroyed = false;

    // Snapshot for dirty comparison
    this._originalCellsJSON = '';

    // Bound handler refs for cleanup
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onContainerClick = this._handleContainerClick.bind(this);
    this._onDocClick = this._handleDocumentClick.bind(this);
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Load notebook content from the API and render the IDE.
   * @returns {Promise<void>}
   */
  async load() {
    this._container.innerHTML = this._shimmerHTML();
    try {
      const response = await this._api.getNotebookContent(this._wsId, this._notebook.id);
      if (this._destroyed) return;

      const parsed = NotebookParser.parse(response.content);
      this._cells = parsed.cells;
      this._notebookMeta = parsed.notebookMeta;
      this._platform = response.platform || '';
      this._originalCellsJSON = JSON.stringify(this._cells);

      this._render();
      this._bindEvents();
    } catch (err) {
      if (this._destroyed) return;
      this._container.innerHTML = this._errorHTML(err.message || 'Failed to load notebook');
    }
  }

  /** Tear down the view: timers, sessions, listeners. */
  destroy() {
    this._destroyed = true;
    if (this._runPollTimer) {
      clearInterval(this._runPollTimer);
      this._runPollTimer = null;
    }
    if (this._jupyterSession) {
      const s = this._jupyterSession;
      this._api.closeJupyterSession(this._wsId, this._notebook.id, s.capacityId, s.sessionId)
        .catch(() => { /* best-effort cleanup */ });
      this._jupyterSession = null;
    }
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('click', this._onDocClick);
    this._container.innerHTML = '';
  }

  // ── Render ────────────────────────────────────────────────────

  _render() {
    const name = this._esc(this._notebook.displayName);
    const contextChips = this._buildContextChips();

    this._container.innerHTML = `
      <div class="nb-ide">
        <div class="nb-toolbar">
          <div class="nb-toolbar-top">
            <span class="nb-title">${name}</span>
            <span class="nb-dirty-dot hidden"></span>
            <span class="nb-type-badge">NB</span>
            <div class="nb-actions">
              <button class="nb-action-btn primary" data-action="run-all">
                <span class="btn-icon">▶</span> Run All
              </button>
              <button class="nb-action-btn" data-action="save">Save</button>
              <button class="nb-action-btn" data-action="add-cell">+ Cell</button>
              <button class="nb-action-btn" data-action="refresh">⟲</button>
              <button class="nb-action-btn" data-action="close">✕ Close</button>
            </div>
          </div>
          <div class="nb-context">${contextChips}</div>
        </div>
        <div class="nb-content">
          <div class="nb-cells">${this._renderAllCells()}</div>
        </div>
        <div class="nb-status-bar not-started">
          <span class="nb-status-icon"></span>
          <span class="nb-status-msg">Ready</span>
          <span class="nb-status-time"></span>
        </div>
      </div>`;
  }

  _buildContextChips() {
    const chips = [];
    const props = this._notebook.properties || {};
    const meta = this._notebookMeta || {};
    const deps = meta.dependencies || {};

    // Default lakehouse
    const lh = deps.lakehouse;
    if (lh && lh.default_lakehouse_name) {
      chips.push(`<span class="nb-context-chip" data-type="lakehouse">
        <span class="chip-label">LH:</span> ${this._esc(lh.default_lakehouse_name)}
      </span>`);
    }

    // Environment
    const env = deps.environment;
    if (env && env.environmentId) {
      const envName = env.workspaceId ? 'Attached Env' : env.environmentId.slice(0, 8);
      chips.push(`<span class="nb-context-chip" data-type="environment">
        <span class="chip-label">Env:</span> ${this._esc(envName)}
      </span>`);
    }

    // Kernel
    const kernel = meta.kernel_spec || {};
    if (kernel.name) {
      chips.push(`<span class="nb-context-chip" data-type="kernel">
        <span class="chip-label">Kernel:</span> ${this._esc(kernel.name)}
      </span>`);
    }

    return chips.join('<span class="nb-context-sep">·</span>');
  }

  _renderAllCells() {
    if (this._cells.length === 0) {
      return `<div class="nb-between-cell" data-index="0">
        <button class="nb-add-cell-btn">+ Add Cell</button>
        <div class="nb-add-dropdown" data-index="0">
          ${this._addCellOptions()}
        </div>
      </div>`;
    }

    const parts = [];
    // Top between-cell
    parts.push(this._betweenCellHTML(0));
    for (let i = 0; i < this._cells.length; i++) {
      parts.push(this._renderCell(i));
      parts.push(this._betweenCellHTML(i + 1));
    }
    return parts.join('');
  }

  _betweenCellHTML(index) {
    return `<div class="nb-between-cell" data-index="${index}">
      <button class="nb-add-cell-btn">+</button>
      <div class="nb-add-dropdown" data-index="${index}">
        ${this._addCellOptions()}
      </div>
    </div>`;
  }

  _addCellOptions() {
    return `<button class="nb-add-dropdown-option" data-cell-type="sparksql">SQL Cell</button>
      <button class="nb-add-dropdown-option" data-cell-type="pyspark">Python Cell</button>
      <button class="nb-add-dropdown-option" data-cell-type="markdown">Markdown Cell</button>`;
  }

  _renderCell(index) {
    const cell = this._cells[index];
    const selected = index === this._selectedCellIndex ? ' selected' : '';

    if (cell.type === 'markdown') {
      return this._renderMarkdownCell(index, cell, selected);
    }
    return this._renderCodeCell(index, cell, selected);
  }

  _renderCodeCell(index, cell, selectedClass) {
    const langClass = this._langBadgeClass(cell.language);
    const langLabel = this._langLabel(cell.language);
    const lines = (cell.content || '').split('\n');
    const lineNums = lines.map((_, i) => i + 1).join('\n');
    const codeContent = this._esc(cell.content || '');
    const executionNum = cell.meta && cell.meta.nteract && cell.meta.nteract.transient
      ? cell.meta.nteract.transient.deleting : null;
    const cellNum = `In [${index + 1}]:`;

    return `<div class="nb-cell${selectedClass}" data-index="${index}" data-type="code">
      <div class="nb-cell-header">
        <span class="nb-cell-num">${cellNum}</span>
        <span class="${langClass}">${langLabel}</span>
        <div class="nb-cell-status"></div>
        <button class="nb-run-btn" title="Run cell" data-index="${index}">▶</button>
        <div class="nb-dropdown-wrap">
          <button class="nb-cell-menu-btn" data-index="${index}">⋯</button>
          <div class="nb-cell-menu" data-index="${index}">
            <button class="nb-cell-menu-item" data-action="copy" data-index="${index}">Copy</button>
            <button class="nb-cell-menu-item" data-action="move-up" data-index="${index}">Move Up</button>
            <button class="nb-cell-menu-item" data-action="move-down" data-index="${index}">Move Down</button>
            <div class="nb-cell-menu-sep"></div>
            <button class="nb-cell-menu-item" data-action="lang-sparksql" data-index="${index}">Change to SQL</button>
            <button class="nb-cell-menu-item" data-action="lang-pyspark" data-index="${index}">Change to Python</button>
            <div class="nb-cell-menu-sep"></div>
            <button class="nb-cell-menu-item danger" data-action="delete" data-index="${index}">Delete</button>
          </div>
        </div>
      </div>
      <div class="nb-code" data-index="${index}">
        <div class="nb-code-area">
          <div class="nb-line-numbers">${lineNums}</div>
          <pre class="nb-code-readonly">${codeContent}</pre>
        </div>
      </div>
      <div class="nb-output nb-output-empty">Click ▶ Run to execute</div>
    </div>`;
  }

  _renderMarkdownCell(index, cell, selectedClass) {
    const rendered = this._renderMarkdown(cell.content || '');

    return `<div class="nb-cell${selectedClass}" data-index="${index}" data-type="markdown">
      <div class="nb-cell-header">
        <span class="nb-cell-num">Md</span>
        <span class="nb-lang-markdown">Markdown</span>
        <div class="nb-cell-status"></div>
        <div class="nb-md-toggle">
          <button class="active" data-action="md-preview" data-index="${index}">Preview</button>
          <button data-action="md-edit" data-index="${index}">Edit</button>
        </div>
        <div class="nb-dropdown-wrap" style="margin-left:auto">
          <button class="nb-cell-menu-btn" data-index="${index}">⋯</button>
          <div class="nb-cell-menu" data-index="${index}">
            <button class="nb-cell-menu-item" data-action="copy" data-index="${index}">Copy</button>
            <button class="nb-cell-menu-item" data-action="move-up" data-index="${index}">Move Up</button>
            <button class="nb-cell-menu-item" data-action="move-down" data-index="${index}">Move Down</button>
            <div class="nb-cell-menu-sep"></div>
            <button class="nb-cell-menu-item danger" data-action="delete" data-index="${index}">Delete</button>
          </div>
        </div>
      </div>
      <div class="nb-md-rendered" data-index="${index}">${rendered}</div>
    </div>`;
  }

  // ── Event Binding ─────────────────────────────────────────────

  _bindEvents() {
    this._container.addEventListener('click', this._onContainerClick);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('click', this._onDocClick);
  }

  /** Close any open dropdowns when clicking outside */
  _handleDocumentClick(e) {
    if (this._destroyed) return;
    // Close cell menus
    const openMenus = this._container.querySelectorAll('.nb-cell-menu.open');
    for (const menu of openMenus) {
      if (!menu.contains(e.target) && !e.target.classList.contains('nb-cell-menu-btn')) {
        menu.classList.remove('open');
      }
    }
    // Close add-cell dropdowns
    const openDropdowns = this._container.querySelectorAll('.nb-add-dropdown.open');
    for (const dd of openDropdowns) {
      if (!dd.contains(e.target) && !e.target.classList.contains('nb-add-cell-btn')) {
        dd.classList.remove('open');
      }
    }
  }

  _handleContainerClick(e) {
    if (this._destroyed) return;
    const target = e.target;

    // Toolbar actions
    const actionBtn = target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      const index = actionBtn.dataset.index !== undefined ? parseInt(actionBtn.dataset.index, 10) : -1;
      this._handleAction(action, index, e);
      return;
    }

    // Run button
    if (target.closest('.nb-run-btn')) {
      const idx = parseInt(target.closest('.nb-run-btn').dataset.index, 10);
      this._runCell(idx);
      return;
    }

    // Cell menu toggle
    if (target.closest('.nb-cell-menu-btn')) {
      const btn = target.closest('.nb-cell-menu-btn');
      const menu = btn.parentElement.querySelector('.nb-cell-menu');
      if (menu) {
        this._closeAllMenus();
        menu.classList.toggle('open');
        e.stopPropagation();
      }
      return;
    }

    // Add-cell button
    if (target.closest('.nb-add-cell-btn')) {
      const btn = target.closest('.nb-add-cell-btn');
      const dropdown = btn.parentElement.querySelector('.nb-add-dropdown');
      if (dropdown) {
        this._closeAllMenus();
        dropdown.classList.toggle('open');
        e.stopPropagation();
      }
      return;
    }

    // Add-cell dropdown option
    if (target.closest('.nb-add-dropdown-option')) {
      this._handleAddCellOptionClick(target.closest('.nb-add-dropdown-option'));
      return;
    }

    // Click on code area to edit
    const codeEl = target.closest('.nb-code[data-index]');
    if (codeEl) {
      const idx = parseInt(codeEl.dataset.index, 10);
      this._enterEditMode(idx);
      return;
    }

    // Environment chip click
    const envChip = target.closest('.nb-context-chip[data-type="environment"]');
    if (envChip) {
      this._showEnvironmentPicker({ target: envChip });
      return;
    }

    // Click on markdown rendered to select
    const mdEl = target.closest('.nb-md-rendered[data-index]');
    if (mdEl) {
      const idx = parseInt(mdEl.dataset.index, 10);
      this._selectCell(idx);
      return;
    }

    // Click on a cell to select it
    const cellEl = target.closest('.nb-cell[data-index]');
    if (cellEl) {
      const idx = parseInt(cellEl.dataset.index, 10);
      this._selectCell(idx);
    }

    // Retry button
    if (target.closest('[data-action="retry"]')) {
      this.load();
    }
  }

  _handleAction(action, index, e) {
    switch (action) {
      case 'run-all': this._runAll(); break;
      case 'save': this._save(); break;
      case 'add-cell': this._showToolbarAddCell(e); break;
      case 'refresh': this._refresh(); break;
      case 'close': this._close(); break;
      case 'cancel-run': this._cancelRun(); break;

      // Cell menu actions
      case 'copy': this._copyCell(index); break;
      case 'delete': this._deleteCell(index); break;
      case 'move-up': this._moveCell(index, -1); break;
      case 'move-down': this._moveCell(index, 1); break;
      case 'lang-sparksql': this._changeCellLanguage(index, 'sparksql'); break;
      case 'lang-pyspark': this._changeCellLanguage(index, 'pyspark'); break;

      // Markdown toggle
      case 'md-preview': this._setMarkdownMode(index, 'preview'); break;
      case 'md-edit': this._setMarkdownMode(index, 'edit'); break;

      // Add cell from dropdown
      case 'add-sparksql':
      case 'add-pyspark':
      case 'add-markdown':
        // Handled in _handleAddCellOption
        break;

      // Environment chip
      case 'env-select': this._showEnvironmentPicker(e); break;

      default: break;
    }
    this._closeAllMenus();
  }

  _handleKeyDown(e) {
    if (this._destroyed) return;
    // Ctrl+S — Save
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      this._save();
      return;
    }
    // Ctrl+Enter — Run All or run selected cell
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (this._jupyterSession && this._selectedCellIndex >= 0) {
        this._runCell(this._selectedCellIndex);
      } else {
        this._runAll();
      }
      return;
    }
    // Escape — Exit editing
    if (e.key === 'Escape') {
      if (this._editingCellIndex >= 0) {
        this._exitEditMode();
      }
      return;
    }
    // Ctrl+Shift+Delete — Delete selected cell
    if (e.ctrlKey && e.shiftKey && e.key === 'Delete') {
      e.preventDefault();
      if (this._selectedCellIndex >= 0) {
        this._deleteCell(this._selectedCellIndex);
      }
    }
  }

  // ── Cell Editing ──────────────────────────────────────────────

  _enterEditMode(index) {
    if (this._editingCellIndex === index) return;
    if (this._editingCellIndex >= 0) {
      this._exitEditMode();
    }

    const cell = this._cells[index];
    if (!cell || cell.type !== 'code') return;

    this._editingCellIndex = index;
    this._selectCell(index);

    const cellEl = this._container.querySelector(`.nb-cell[data-index="${index}"]`);
    if (!cellEl) return;
    cellEl.classList.add('editing');

    const codeEl = cellEl.querySelector('.nb-code');
    if (!codeEl) return;

    const lines = (cell.content || '').split('\n');
    const lineNums = lines.map((_, i) => i + 1).join('\n');
    const rows = Math.max(lines.length, 3);

    codeEl.innerHTML = `<div class="nb-code-area">
      <div class="nb-line-numbers">${lineNums}</div>
      <textarea class="nb-code-textarea" rows="${rows}" spellcheck="false"
        data-index="${index}">${this._esc(cell.content || '')}</textarea>
    </div>`;

    const textarea = codeEl.querySelector('textarea');
    if (textarea) {
      textarea.focus();
      textarea.addEventListener('keydown', this._handleTextareaKey.bind(this));
      textarea.addEventListener('input', () => this._onTextareaInput(textarea, index));
      textarea.addEventListener('blur', () => {
        // Short delay so click events on buttons fire before blur handling
        setTimeout(() => this._exitEditMode(), 150);
      });
    }
  }

  _handleTextareaKey(e) {
    // Tab inserts 2 spaces
    if (e.key === 'Tab' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      const idx = parseInt(ta.dataset.index, 10);
      this._onTextareaInput(ta, idx);
    }
  }

  _onTextareaInput(textarea, index) {
    // Update line numbers
    const lineNumEl = textarea.parentElement.querySelector('.nb-line-numbers');
    if (lineNumEl) {
      const lines = textarea.value.split('\n');
      lineNumEl.textContent = lines.map((_, i) => i + 1).join('\n');
    }
    // Update cell content
    this._cells[index].content = textarea.value;
    this._checkDirty();
  }

  _exitEditMode() {
    if (this._editingCellIndex < 0) return;
    const index = this._editingCellIndex;
    this._editingCellIndex = -1;

    const cellEl = this._container.querySelector(`.nb-cell[data-index="${index}"]`);
    if (!cellEl) return;
    cellEl.classList.remove('editing');

    const cell = this._cells[index];
    if (!cell || cell.type !== 'code') return;

    // Re-render code display
    const codeEl = cellEl.querySelector('.nb-code');
    if (!codeEl) return;

    const lines = (cell.content || '').split('\n');
    const lineNums = lines.map((_, i) => i + 1).join('\n');
    codeEl.innerHTML = `<div class="nb-code-area">
      <div class="nb-line-numbers">${lineNums}</div>
      <pre class="nb-code-readonly">${this._esc(cell.content || '')}</pre>
    </div>`;
  }

  _selectCell(index) {
    // Remove previous selection
    const prev = this._container.querySelector('.nb-cell.selected');
    if (prev) prev.classList.remove('selected');

    this._selectedCellIndex = index;
    const cellEl = this._container.querySelector(`.nb-cell[data-index="${index}"]`);
    if (cellEl) cellEl.classList.add('selected');
  }

  // ── Markdown Editing ──────────────────────────────────────────

  _setMarkdownMode(index, mode) {
    const cell = this._cells[index];
    if (!cell || cell.type !== 'markdown') return;

    const cellEl = this._container.querySelector(`.nb-cell[data-index="${index}"]`);
    if (!cellEl) return;

    // Update toggle buttons
    const toggleBtns = cellEl.querySelectorAll('.nb-md-toggle button');
    for (const btn of toggleBtns) {
      btn.classList.toggle('active', btn.dataset.action === `md-${mode}`);
    }

    if (mode === 'edit') {
      const rendered = cellEl.querySelector('.nb-md-rendered');
      if (rendered) {
        const rows = Math.max((cell.content || '').split('\n').length, 4);
        rendered.outerHTML = `<textarea class="nb-md-edit" rows="${rows}"
          data-index="${index}" spellcheck="false">${this._esc(cell.content || '')}</textarea>`;
        const ta = cellEl.querySelector('.nb-md-edit');
        if (ta) {
          ta.focus();
          ta.addEventListener('input', () => {
            this._cells[index].content = ta.value;
            this._checkDirty();
          });
          ta.addEventListener('blur', () => {
            // Delay to allow button clicks
            setTimeout(() => this._setMarkdownMode(index, 'preview'), 150);
          });
        }
      }
    } else {
      const editArea = cellEl.querySelector('.nb-md-edit');
      if (editArea) {
        editArea.outerHTML = `<div class="nb-md-rendered" data-index="${index}">
          ${this._renderMarkdown(cell.content || '')}
        </div>`;
      }
    }
  }

  // ── Dirty Tracking ────────────────────────────────────────────

  _checkDirty() {
    const current = JSON.stringify(this._cells);
    const dirty = current !== this._originalCellsJSON;
    if (dirty !== this._isDirty) {
      this._isDirty = dirty;
      const dot = this._container.querySelector('.nb-dirty-dot');
      if (dot) dot.classList.toggle('hidden', !dirty);
    }
  }

  _markClean() {
    this._originalCellsJSON = JSON.stringify(this._cells);
    this._isDirty = false;
    const dot = this._container.querySelector('.nb-dirty-dot');
    if (dot) dot.classList.add('hidden');
  }

  // ── Run All ───────────────────────────────────────────────────

  async _runAll() {
    if (this._isRunning) return;

    // Prompt to save if dirty
    if (this._isDirty) {
      const ok = confirm('Save changes before running?');
      if (!ok) return;
      await this._save();
    }

    try {
      this._isRunning = true;
      this._setStatusBar('running', 'Running...', '');
      this._setRunAllButton(true);

      const result = await this._api.runNotebook(this._wsId, this._notebook.id);
      if (this._destroyed) return;

      this._runLocation = result.location || result.url || null;
      if (!this._runLocation) {
        this._setStatusBar('failed', 'No run location returned', '');
        this._isRunning = false;
        this._setRunAllButton(false);
        return;
      }

      this._startRunPolling();
    } catch (err) {
      if (this._destroyed) return;
      this._setStatusBar('failed', `Run failed: ${err.message}`, '');
      this._isRunning = false;
      this._setRunAllButton(false);
    }
  }

  _startRunPolling() {
    const startTime = Date.now();
    this._runPollTimer = setInterval(async () => {
      if (this._destroyed || !this._runLocation) {
        this._stopRunPolling();
        return;
      }
      try {
        const status = await this._api.getNotebookRunStatus(this._runLocation);
        const st = (status.status || '').toLowerCase();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const timeStr = `${elapsed}s`;

        if (st === 'completed' || st === 'succeeded') {
          this._setStatusBar('success', 'Completed', timeStr);
          this._stopRunPolling();
        } else if (st === 'failed') {
          const reason = status.failureReason || status.error || 'Unknown error';
          this._setStatusBar('failed', `Failed: ${reason}`, timeStr);
          this._stopRunPolling();
        } else if (st === 'cancelled' || st === 'canceled') {
          this._setStatusBar('cancelled', 'Cancelled', timeStr);
          this._stopRunPolling();
        } else {
          // Still running — update elapsed time
          this._setStatusBar('running', 'Running...', timeStr);
        }
      } catch {
        // Poll error — keep trying
      }
    }, 5000);
  }

  _stopRunPolling() {
    if (this._runPollTimer) {
      clearInterval(this._runPollTimer);
      this._runPollTimer = null;
    }
    this._isRunning = false;
    this._runLocation = null;
    this._setRunAllButton(false);
  }

  async _cancelRun() {
    if (!this._runLocation) return;
    try {
      await this._api.cancelNotebookRun(this._runLocation);
      this._setStatusBar('cancelled', 'Cancelling...', '');
    } catch (err) {
      this._setStatusBar('failed', `Cancel failed: ${err.message}`, '');
    }
  }

  _setRunAllButton(running) {
    const actionsEl = this._container.querySelector('.nb-actions');
    if (!actionsEl) return;

    const runBtn = actionsEl.querySelector('[data-action="run-all"]');
    if (running) {
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
      }
      // Add cancel button if not present
      if (!actionsEl.querySelector('[data-action="cancel-run"]')) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-action-btn';
        cancelBtn.dataset.action = 'cancel-run';
        cancelBtn.innerHTML = '<span class="btn-icon">■</span> Cancel';
        actionsEl.insertBefore(cancelBtn, actionsEl.firstChild.nextSibling);
      }
    } else {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.style.opacity = '';
      }
      const cancelBtn = actionsEl.querySelector('[data-action="cancel-run"]');
      if (cancelBtn) cancelBtn.remove();
    }
  }

  _setStatusBar(state, msg, time) {
    const bar = this._container.querySelector('.nb-status-bar');
    if (!bar) return;
    bar.className = `nb-status-bar ${state}`;
    const msgEl = bar.querySelector('.nb-status-msg');
    const timeEl = bar.querySelector('.nb-status-time');
    if (msgEl) msgEl.textContent = msg;
    if (timeEl) timeEl.textContent = time;
  }

  // ── Per-Cell Execution ────────────────────────────────────────

  async _runCell(index) {
    const cell = this._cells[index];
    if (!cell || cell.type !== 'code') return;

    const cellEl = this._container.querySelector(`.nb-cell[data-index="${index}"]`);
    if (!cellEl) return;

    // Check for capacity ID
    const capId = this._getCapacityId();
    if (!capId) {
      this._setCellOutput(cellEl, 'empty',
        'Deploy to a lakehouse to enable per-cell execution. Use "Run All" instead.');
      return;
    }

    // Create Jupyter session if needed
    if (!this._jupyterSession) {
      this._setCellStatus(cellEl, 'spinner');
      try {
        const lhId = this._getDefaultLakehouseId();
        const session = await this._api.createJupyterSession(
          this._wsId, this._notebook.id, capId, lhId
        );
        this._jupyterSession = {
          sessionId: session.sessionId || session.id,
          kernelId: session.kernelId,
          capacityId: capId,
        };
      } catch (err) {
        this._setCellStatus(cellEl, 'error');
        this._setCellOutput(cellEl, 'error', `Session creation failed: ${err.message}`);
        return;
      }
    }

    // Execute cell
    cellEl.classList.add('running');
    cellEl.classList.remove('success', 'error');
    this._setCellStatus(cellEl, 'spinner');

    try {
      const result = await this._api.executeCell(
        this._wsId, this._notebook.id, capId,
        cell.content, cell.language
      );

      if (this._destroyed) return;
      cellEl.classList.remove('running');

      if (result.status === 'websocket_required') {
        cellEl.classList.add('error');
        this._setCellStatus(cellEl, 'error');
        this._setCellOutput(cellEl, 'empty',
          'WebSocket connection required. Per-cell execution unavailable \u2014 use "Run All" instead.');
        return;
      }

      if (result.status === 'error') {
        cellEl.classList.add('error');
        this._setCellStatus(cellEl, 'error');
        const errMsg = result.error_value
          ? `${result.error_name}: ${result.error_value}`
          : (result.error || 'Execution failed');
        const tbText = (result.traceback || []).join('\n');
        this._setCellOutput(cellEl, 'error', tbText || errMsg);
        return;
      }

      // Success — render outputs
      cellEl.classList.add('success');
      this._setCellStatus(cellEl, 'success');
      const outputs = result.outputs || [];
      if (outputs.length === 0) {
        this._setCellOutput(cellEl, 'empty', 'Execution completed (no output)');
      } else {
        // Combine all output text
        const parts = outputs.map(o => {
          if (o.html) return o.html;
          if (o.text) return this._esc(o.text);
          if (o.type === 'error') return `${o.ename}: ${o.evalue}`;
          return '';
        }).filter(Boolean);
        const outputEl = cellEl.querySelector('.nb-output');
        if (outputEl) {
          outputEl.className = 'nb-output';
          outputEl.innerHTML = `<pre class="nb-output-pre">${parts.join('\n')}</pre>`;
        }
      }
    } catch (err) {
      if (this._destroyed) return;
      cellEl.classList.remove('running');
      cellEl.classList.add('error');
      this._setCellStatus(cellEl, 'error');
      this._setCellOutput(cellEl, 'error', err.message);
    }
  }

  _setCellStatus(cellEl, type) {
    const statusEl = cellEl.querySelector('.nb-cell-status');
    if (!statusEl) return;

    if (type === 'spinner') {
      statusEl.innerHTML = '<div class="nb-spinner"></div>';
    } else if (type === 'success') {
      statusEl.innerHTML = '';
    } else if (type === 'error') {
      statusEl.innerHTML = '';
    } else {
      statusEl.innerHTML = '';
    }
  }

  _setCellOutput(cellEl, type, data) {
    const outputEl = cellEl.querySelector('.nb-output');
    if (!outputEl) return;

    outputEl.className = 'nb-output';

    if (type === 'empty') {
      outputEl.className = 'nb-output nb-output-empty';
      outputEl.textContent = typeof data === 'string' ? data : 'Click ▶ Run to execute';
      return;
    }

    if (type === 'error') {
      outputEl.className = 'nb-output nb-output-error';
      outputEl.innerHTML = `<span class="error-type">Error</span>
        <span class="error-msg">${this._esc(String(data))}</span>`;
      return;
    }

    if (type === 'result' && data) {
      // Render output based on shape
      if (data.data && Array.isArray(data.data)) {
        outputEl.innerHTML = this._renderTableOutput(data.data);
      } else if (data.output || data.text) {
        outputEl.innerHTML = `<pre class="nb-output-pre">${this._esc(data.output || data.text || JSON.stringify(data))}</pre>`;
      } else {
        outputEl.innerHTML = `<pre class="nb-output-pre">${this._esc(JSON.stringify(data, null, 2))}</pre>`;
      }
      return;
    }

    outputEl.className = 'nb-output nb-output-empty';
    outputEl.textContent = 'No output';
  }

  _renderTableOutput(rows) {
    if (!rows.length) return '<div class="nb-output-empty">Empty result set</div>';
    const cols = Object.keys(rows[0]);
    const maxRows = 50;
    const truncated = rows.length > maxRows;
    const display = truncated ? rows.slice(0, maxRows) : rows;

    let html = '<table class="nb-output-table"><thead><tr>';
    for (const col of cols) {
      html += `<th>${this._esc(col)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const row of display) {
      html += '<tr>';
      for (const col of cols) {
        html += `<td>${this._esc(String(row[col] ?? ''))}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    if (truncated) {
      html += `<div class="nb-output-truncated">
        <button class="nb-show-more">Showing ${maxRows} of ${rows.length} rows</button>
      </div>`;
    }
    return html;
  }

  _getCapacityId() {
    // Priority: workspace capacity > notebook metadata > notebook properties > config
    if (this._wsCapacityId) return this._wsCapacityId;
    const meta = this._notebookMeta || {};
    if (meta.trident && meta.trident.capacityId) return meta.trident.capacityId;
    const props = this._notebook.properties || {};
    if (props.capacityId) return props.capacityId;
    const config = this._api.getConfig && this._api.getConfig();
    if (config && config.capacityId) return config.capacityId;
    return null;
  }

  _getDefaultLakehouseId() {
    const props = this._notebook.properties || {};
    if (props.defaultLakehouse && props.defaultLakehouse.itemId) {
      return props.defaultLakehouse.itemId;
    }
    const meta = this._notebookMeta || {};
    const deps = meta.dependencies || {};
    if (deps.lakehouse && deps.lakehouse.default_lakehouse) {
      return deps.lakehouse.default_lakehouse;
    }
    const config = this._api.getConfig && this._api.getConfig();
    if (config && config.lakehouseId) return config.lakehouseId;
    return '';
  }

  // ── Save ──────────────────────────────────────────────────────

  async _save() {
    const saveBtn = this._container.querySelector('[data-action="save"]');
    if (saveBtn) {
      saveBtn.classList.add('saving');
      saveBtn.textContent = 'Saving...';
    }

    try {
      if (this._editingCellIndex >= 0) {
        this._exitEditMode();
      }

      const serialized = NotebookParser.serialize({
        notebookMeta: this._notebookMeta,
        cells: this._cells,
      });

      await this._api.saveNotebookContent(
        this._wsId, this._notebook.id, serialized, this._platform
      );

      if (this._destroyed) return;
      this._markClean();

      if (saveBtn) {
        saveBtn.classList.remove('saving');
        saveBtn.classList.add('saved');
        saveBtn.textContent = 'Saved';
        setTimeout(() => {
          if (!this._destroyed && saveBtn) {
            saveBtn.classList.remove('saved');
            saveBtn.textContent = 'Save';
          }
        }, 2000);
      }
    } catch (err) {
      if (this._destroyed) return;
      if (saveBtn) {
        saveBtn.classList.remove('saving');
        saveBtn.textContent = 'Save';
      }
      this._showToast(`Save failed: ${err.message}`, 'error');
    }
  }

  // ── Refresh ───────────────────────────────────────────────────

  async _refresh() {
    if (this._isDirty) {
      const ok = confirm('Discard unsaved changes and refresh?');
      if (!ok) return;
    }
    this._editingCellIndex = -1;
    this._selectedCellIndex = -1;
    await this.load();
  }

  // ── Close ─────────────────────────────────────────────────────

  _close() {
    if (this._isDirty) {
      const ok = confirm('Discard unsaved changes?');
      if (!ok) return;
    }
    this.destroy();
    // Dispatch a custom event so the workspace explorer can restore its panels
    this._container.dispatchEvent(new CustomEvent('notebook-close', { bubbles: true }));
  }

  // ── Cell Operations ───────────────────────────────────────────

  _addCell(index, type) {
    const langMap = { sparksql: 'sparksql', pyspark: 'pyspark', markdown: 'markdown' };
    const language = langMap[type] || 'sparksql';
    const cellType = type === 'markdown' ? 'markdown' : 'code';

    const newCell = { type: cellType, language, content: '', meta: {} };
    this._cells.splice(index, 0, newCell);
    this._checkDirty();
    this._rerenderCells();
    this._selectCell(index);
  }

  _deleteCell(index) {
    if (index < 0 || index >= this._cells.length) return;
    if (this._cells.length <= 1) {
      this._showToast('Cannot delete the last cell', 'warning');
      return;
    }

    this._cells.splice(index, 1);
    if (this._selectedCellIndex >= this._cells.length) {
      this._selectedCellIndex = this._cells.length - 1;
    }
    if (this._editingCellIndex === index) {
      this._editingCellIndex = -1;
    }
    this._checkDirty();
    this._rerenderCells();
  }

  _moveCell(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= this._cells.length) return;

    const temp = this._cells[index];
    this._cells[index] = this._cells[newIndex];
    this._cells[newIndex] = temp;

    this._selectedCellIndex = newIndex;
    this._checkDirty();
    this._rerenderCells();
  }

  _copyCell(index) {
    const cell = this._cells[index];
    if (!cell) return;
    const text = cell.content || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this._showToast('Copied to clipboard', 'success');
      }).catch(() => {
        this._showToast('Copy failed', 'error');
      });
    } else {
      this._showToast('Clipboard not available', 'warning');
    }
  }

  _changeCellLanguage(index, language) {
    const cell = this._cells[index];
    if (!cell || cell.type !== 'code') return;
    cell.language = language;
    this._checkDirty();
    this._rerenderCells();
  }

  _rerenderCells() {
    const cellsContainer = this._container.querySelector('.nb-cells');
    if (cellsContainer) {
      cellsContainer.innerHTML = this._renderAllCells();
    }
  }

  // ── Toolbar "Add Cell" ────────────────────────────────────────

  _showToolbarAddCell(e) {
    // Insert at end
    const index = this._cells.length;
    this._addCell(index, 'sparksql');
  }

  // ── Environment Picker ────────────────────────────────────────

  async _showEnvironmentPicker(e) {
    const chip = e.target.closest('.nb-context-chip[data-type="environment"]');
    if (!chip) return;

    // Already showing picker
    if (chip.querySelector('.nb-add-dropdown.open')) return;

    let envs = [];
    try {
      const resp = await this._api.listEnvironments(this._wsId);
      envs = resp.value || resp || [];
    } catch {
      this._showToast('Failed to load environments', 'error');
      return;
    }

    if (!envs.length) {
      this._showToast('No environments found in this workspace', 'warning');
      return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'nb-add-dropdown open';
    dropdown.style.cssText = 'position:absolute;top:100%;left:0;z-index:var(--z-dropdown)';

    for (const env of envs) {
      const btn = document.createElement('button');
      btn.className = 'nb-add-dropdown-option';
      btn.textContent = env.displayName || env.name || env.id;
      btn.addEventListener('click', () => {
        if (!this._notebookMeta.dependencies) this._notebookMeta.dependencies = {};
        if (!this._notebookMeta.dependencies.environment) this._notebookMeta.dependencies.environment = {};
        this._notebookMeta.dependencies.environment.environmentId = env.id;
        this._notebookMeta.dependencies.environment.workspaceId = this._wsId;
        this._checkDirty();
        dropdown.remove();
        this._showToast(`Environment changed to ${env.displayName || env.id}. Save to apply.`, 'info');
        // Update chip label
        chip.innerHTML = `<span class="chip-label">Env:</span> ${this._esc(env.displayName || env.id)}`;
      });
      dropdown.appendChild(btn);
    }

    chip.style.position = 'relative';
    chip.appendChild(dropdown);
  }

  // ── Toast ─────────────────────────────────────────────────────

  _showToast(message, type = 'info') {
    // Reuse existing toast or create one
    let toast = this._container.querySelector('.nb-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'nb-toast';
      toast.style.cssText = `
        position:fixed;bottom:var(--space-8);right:var(--space-8);
        padding:var(--space-3) var(--space-4);border-radius:var(--radius-md);
        font-size:var(--text-sm);font-family:var(--font-body);
        box-shadow:var(--shadow-md);z-index:9999;
        transition:opacity var(--transition-normal);
        max-width:400px;
      `;
      document.body.appendChild(toast);
    }

    const colors = {
      success: 'background:var(--comp-dag-bg);color:var(--status-succeeded);border:1px solid var(--status-succeeded)',
      error: 'background:var(--row-error-tint);color:var(--status-failed);border:1px solid var(--status-failed)',
      warning: 'background:var(--level-warning-tint);color:var(--level-warning);border:1px solid var(--level-warning)',
      info: 'background:var(--surface);color:var(--text-dim);border:1px solid var(--border-bright)',
    };

    toast.style.cssText += colors[type] || colors.info;
    toast.textContent = message;
    toast.style.opacity = '1';

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ── Helpers ───────────────────────────────────────────────────

  _closeAllMenus() {
    const menus = this._container.querySelectorAll('.nb-cell-menu.open, .nb-add-dropdown.open');
    for (const m of menus) m.classList.remove('open');
  }

  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _langBadgeClass(language) {
    const lang = (language || '').toLowerCase();
    if (lang === 'sparksql' || lang === 'sql') return 'nb-lang-sql';
    if (lang === 'python' || lang === 'pyspark') return 'nb-lang-python';
    if (lang === 'markdown') return 'nb-lang-markdown';
    return 'nb-lang-sql';
  }

  _langLabel(language) {
    const lang = (language || '').toLowerCase();
    if (lang === 'sparksql' || lang === 'sql') return 'SparkSQL';
    if (lang === 'python' || lang === 'pyspark') return 'PySpark';
    if (lang === 'markdown') return 'Markdown';
    return language || 'SQL';
  }

  /**
   * Render basic markdown to HTML.
   * Supports headings, bold, italic, inline code, code blocks, lists,
   * blockquotes, and paragraphs.
   * @param {string} text — Raw markdown text.
   * @returns {string} HTML string.
   */
  _renderMarkdown(text) {
    if (!text) return '<p class="nb-md-empty">Empty markdown cell</p>';

    const lines = text.split('\n');
    const out = [];
    let inList = false;
    let inCodeBlock = false;
    let codeLines = [];

    for (const line of lines) {
      // Fenced code blocks
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          out.push(`<pre><code>${this._esc(codeLines.join('\n'))}</code></pre>`);
          codeLines = [];
          inCodeBlock = false;
        } else {
          if (inList) { out.push('</ul>'); inList = false; }
          inCodeBlock = true;
        }
        continue;
      }
      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // Headings
      if (line.startsWith('### ')) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h3>${this._inlineMarkdown(line.slice(4))}</h3>`);
        continue;
      }
      if (line.startsWith('## ')) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h2>${this._inlineMarkdown(line.slice(3))}</h2>`);
        continue;
      }
      if (line.startsWith('# ')) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h1>${this._inlineMarkdown(line.slice(2))}</h1>`);
        continue;
      }

      // Blockquotes
      if (line.startsWith('> ')) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<blockquote>${this._inlineMarkdown(line.slice(2))}</blockquote>`);
        continue;
      }

      // Unordered list items
      if (/^[-*] /.test(line.trim())) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${this._inlineMarkdown(line.trim().slice(2))}</li>`);
        continue;
      }

      // Ordered list items
      if (/^\d+\.\s/.test(line.trim())) {
        if (!inList) { out.push('<ol>'); inList = true; }
        const content = line.trim().replace(/^\d+\.\s/, '');
        out.push(`<li>${this._inlineMarkdown(content)}</li>`);
        continue;
      }

      // Close list if not a list item
      if (inList) { out.push('</ul>'); inList = false; }

      // Blank lines
      if (line.trim() === '') continue;

      // Paragraphs
      out.push(`<p>${this._inlineMarkdown(line)}</p>`);
    }

    if (inList) out.push('</ul>');
    if (inCodeBlock) {
      out.push(`<pre><code>${this._esc(codeLines.join('\n'))}</code></pre>`);
    }

    return out.join('');
  }

  /** Inline markdown: bold, italic, code, links */
  _inlineMarkdown(text) {
    let s = this._esc(text);
    // Code spans (must be first to prevent inner replacements)
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return s;
  }

  _shimmerHTML() {
    return `<div class="nb-ide">
      <div class="nb-toolbar">
        <div class="nb-shimmer-bar" style="height:20px;width:200px"></div>
      </div>
      <div class="nb-shimmer-cells">
        <div class="nb-shimmer-cell" style="height:120px"></div>
        <div class="nb-shimmer-cell" style="height:80px"></div>
        <div class="nb-shimmer-cell" style="height:100px"></div>
      </div>
    </div>`;
  }

  _errorHTML(message) {
    return `<div class="nb-ide nb-error-state">
      <div class="nb-error-title">Failed to load notebook</div>
      <div class="nb-error-message">${this._esc(message)}</div>
      <button class="nb-action-btn" data-action="retry">Retry</button>
    </div>`;
  }

  // ── Add-cell dropdown handler ─────────────────────────────────

  /**
   * Handles clicks on nb-add-dropdown-option buttons via delegation.
   * Called from the container click handler.
   */
  _handleAddCellOptionClick(target) {
    const cellType = target.dataset.cellType;
    if (!cellType) return;

    const dropdown = target.closest('.nb-add-dropdown');
    const insertIndex = dropdown ? parseInt(dropdown.dataset.index, 10) : this._cells.length;

    this._addCell(insertIndex, cellType);
    this._closeAllMenus();
  }
}
