/**
 * SystemFilesTab — File operation monitor for FLT OneLake I/O.
 *
 * Subscribes to SignalR topic 'fileop'. Displays file read/write/delete
 * operations with JSON/hex content preview, timeline visualisation,
 * directory & type filtering, path search, and CSV/JSON export.
 *
 * Reference: f04-mock-03-system-files.html (mock), SIGNALR_PROTOCOL.md
 */

// ===== SVG ICONS =====

const _SF_ICONS = {
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" style="width:10px;height:10px"><path d="M7 10l5 5 5-5z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
  fileAlt: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 9h-2V7h2v4zm0 4h-2v-2h2v2z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>',
  detach: '<svg viewBox="0 0 24 24"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z"/></svg>',
  wrap: '<svg viewBox="0 0 24 24"><path d="M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25c1.1 0 2 .9 2 2s-.9 2-2 2H15v-2l-3 3 3 3v-2h2c2.21 0 4-1.79 4-4s-1.79-4-4-4z"/></svg>'
};

// ===== SYSTEM FILES TAB =====

class SystemFilesTab {
  /**
   * @param {HTMLElement} containerEl  #rt-tab-sysfiles content div
   * @param {SignalRManager} signalr   shared SignalR manager instance
   */
  constructor(containerEl, signalr) {
    this._el = containerEl;
    this._signalr = signalr;
    this._active = false;

    // Data
    this._events = [];
    this._filtered = [];
    this._maxEvents = 2000;

    // UI state
    this._selectedIdx = -1;
    this._kbIdx = -1;
    this._searchQuery = '';
    this._activeDirs = new Set(['All']);
    this._activeOps = new Set(['All']);
    this._sortCol = 'time';
    this._sortDir = 'desc';
    this._detailOpen = false;
    this._detailHeight = 280;
    this._wordWrap = false;
    this._modalEl = null;
    this._modalBackdrop = null;
    this._modalAnchors = null;
    this._currentOp = null;

    // Dropdown state
    this._dirDropdownOpen = false;
    this._exportDropdownOpen = false;

    // Render batching
    this._renderQueued = false;

    // Known FLT directories — seeded; Bug 9 fix: real list is the union
    // of these and `_discoveredDirs` which auto-grows from observed paths.
    this._knownDirs = ['DagExecutionMetrics', 'Locks', 'Settings', 'MLVDefinitions', 'OneLake'];
    this._discoveredDirs = new Set(this._knownDirs);

    // Lock first-seen map for age calculation
    this._lockFirstSeen = new Map();

    // Collapsed JSON groups
    this._collapsedGroups = new Set();

    // DOM cache
    this._dom = {};
    this._bodyEls = [];

    // External click handler (stored for cleanup)
    this._onDocClick = (e) => this._handleDocClick(e);
    this._onDocKeyDown = (e) => this._handleKeyDown(e);

    this._buildDOM();

    // Subscribe to fileop topic immediately so events accumulate
    // even before the tab is first activated.
    if (this._signalr) {
      this._signalr.on('fileop', this._onEvent);
      this._signalr.subscribeTopic('fileop');
    }
  }

  // ── Lifecycle ──

  activate() {
    if (this._active) return;
    this._active = true;
    // SignalR subscription is done in constructor — no need to re-subscribe here
    document.addEventListener('click', this._onDocClick);
    document.addEventListener('keydown', this._onDocKeyDown);
    this._createBodyEls();
    this._applyFilters();
  }

  deactivate() {
    this._active = false;
    // Don't unsubscribe from SignalR — events should accumulate while tab is hidden
    document.removeEventListener('click', this._onDocClick);
    document.removeEventListener('keydown', this._onDocKeyDown);
    clearTimeout(this._toastTimer);
    if (this._modalEl) this._closeModal();
    this._removeBodyEls();
  }

  // ── SignalR event handler (arrow fn preserves this) ──

  _onEvent = (event) => {
    const d = event.data;
    if (!d || !d.path) return;

    // Map granular operation types to display categories
    const rawOp = d.operation || 'Read';
    const opCategory = this._opCategory(rawOp);

    // Bug 6+7 fix: prefer real lastModified from the per-file metadata
    // array when this event came from ListFilesWithMetadata (interceptor
    // now publishes the (Path, LastModified, Size) triples as `files`).
    // For a lock-path op, find the matching file in the metadata and
    // use its real OneLake LastModified — so locks that pre-existed
    // Studio's attach show their REAL age, not Studio's first-observed.
    let lockLastModified = null;
    if (Array.isArray(d.files) && (d.path || '').toLowerCase().includes('lock')) {
      for (let i = 0; i < d.files.length; i++) {
        const f = d.files[i];
        if (f && f.path && (f.path || '').toLowerCase().includes('lock')) {
          lockLastModified = f.lastModified || null;
          if (lockLastModified) {
            const t = new Date(lockLastModified).getTime();
            if (!Number.isNaN(t)) this._lockFirstSeen.set(f.path, t);
          }
        }
      }
    }

    const op = {
      seq: event.sequenceId || this._events.length,
      path: d.path,
      operation: rawOp,
      opCategory: opCategory,
      sizeBytes: d.contentSizeBytes || 0,
      // Bug 5 fix: itemCount surfaces "how many items came back" for
      // list/metadata ops without abusing sizeBytes
      itemCount: typeof d.itemCount === 'number' ? d.itemCount : 0,
      durationMs: d.durationMs || 0,
      timestamp: new Date(event.timestamp || Date.now()),
      // Bug 1+2 fix: iterationId is best-effort (may be null), rootActivityId
      // is always present, artifactId is the wks-lh tag
      iterationId: d.iterationId || null,
      rootActivityId: d.rootActivityId || null,
      artifactId: d.artifactId || null,
      hasContent: !!d.hasContent,
      contentPreview: d.contentPreview || null,
      previewTruncated: !!d.previewTruncated,
      ttlSeconds: d.ttlSeconds || null,
      operationResult: d.operationResult,
      metadata: d.metadata || null,
      // Bug 8 fix: pagination state surfaces on the row
      hasMoreContinuation: d.hasMoreContinuation === true,
      // Bug 6 fix: per-file metadata array (when present)
      files: Array.isArray(d.files) ? d.files : null,
      // Bug 3 fix: failed file ops are first-class — interceptor publishes
      // success=false + errorMessage + errorType on the catch path
      success: d.success !== false,
      errorMessage: d.errorMessage || null,
      errorType: d.errorType || null,
      isLock: (d.path || '').toLowerCase().includes('.lock') ||
              (d.path || '').toLowerCase().includes('/locks/'),
    };

    // Lock first-seen tracking — only as fallback when real LastModified
    // isn't available. Real metadata always wins (handled above).
    if (op.isLock && lockLastModified == null && !this._lockFirstSeen.has(op.path)) {
      this._lockFirstSeen.set(op.path, op.timestamp.getTime());
    }

    // Delete removes lock tracking
    if (opCategory === 'Delete' && op.isLock) {
      this._lockFirstSeen.delete(op.path);
    }

    // Bug 9 fix: auto-discover top-level directories from observed paths
    // (alongside the seed _knownDirs). Anything observed gets remembered
    // so the dir-filter dropdown stays accurate even for new dirs.
    if (this._discoveredDirs) {
      const m = (op.path || '').match(/^\/?([^\/]+)\//);
      if (m && m[1]) this._discoveredDirs.add(m[1]);
    }

    this._events.push(op);
    if (this._events.length > this._maxEvents) {
      const evicted = this._events.shift();
      if (evicted.isLock && this._lockFirstSeen.has(evicted.path)) {
        const stillExists = this._events.some(e => e.path === evicted.path);
        if (!stillExists) this._lockFirstSeen.delete(evicted.path);
      }
    }

    if (this._active) this._queueRender();
  }

  /**
   * Map granular backend operation types to display categories.
   * Bug 4 fix: ListFilesWithMetadata + GetDirMetadata + GetFileMetadata
   * are explicit cases (previously they silently fell through to the
   * 'Read' default, losing the metadata-vs-content distinction).
   */
  _opCategory(op) {
    switch (op) {
      case 'CreateDir':
      case 'CreateFile':
      case 'WriteFile':
      case 'Rename':
      case 'Write':
        return 'Write';
      case 'DeleteFile':
      case 'DeleteDir':
      case 'Delete':
        return 'Delete';
      case 'Read':
        return 'Read';
      case 'List':
      case 'ListFilesWithMetadata':
        return 'List';
      case 'Exists':
        return 'Exists';
      case 'GetDirMetadata':
      case 'GetFileMetadata':
        return 'Metadata';
      default:
        return 'Read';
    }
  }

  // ── Render batching ──

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._applyFilters();
    });
  }

  // ── DOM construction ──

  _buildDOM() {
    const root = document.createElement('div');
    root.className = 'sf-root';

    root.innerHTML = this._toolbarHTML() +
      this._timelineHTML() +
      '<div class="sf-content">' +
        this._emptyStateHTML() +
        '<div class="sf-main sf--hidden">' +
          this._tableHTML() +
          this._detailHTML() +
        '</div>' +
      '</div>';

    this._el.appendChild(root);
    this._dom.root = root;

    // Cache DOM references
    this._dom.toolbar = root.querySelector('.sf-toolbar');
    this._dom.searchInput = root.querySelector('.sf-search input');
    this._dom.searchClear = root.querySelector('.sf-search-clear');
    this._dom.dirBtn = root.querySelector('.sf-dir-btn');
    this._dom.dirLabel = root.querySelector('.sf-dir-label-text');
    this._dom.dirDropdown = root.querySelector('.sf-dir-dropdown');
    this._dom.opPills = root.querySelector('.sf-op-pills');
    this._dom.opsCount = root.querySelector('.sf-ops-count');
    this._dom.exportBtn = root.querySelector('.sf-export-btn');
    this._dom.exportDropdown = root.querySelector('.sf-export-dropdown');
    this._dom.timelineTrack = root.querySelector('.sf-timeline-track');
    this._dom.timelineLabel = root.querySelector('.sf-timeline-label');
    this._dom.emptyState = root.querySelector('.sf-empty');
    this._dom.mainSplit = root.querySelector('.sf-main');
    this._dom.tableWrap = root.querySelector('.sf-table-wrap');
    this._dom.thead = root.querySelector('.sf-table thead');
    this._dom.tbody = root.querySelector('.sf-table tbody');
    this._dom.detail = root.querySelector('.sf-detail');
    this._dom.detailResize = root.querySelector('.sf-detail-resize');
    this._dom.detailBreadcrumb = root.querySelector('.sf-breadcrumb');
    this._dom.detailMeta = root.querySelector('.sf-detail-meta');
    this._dom.detailClose = root.querySelector('.sf-detail-close');
    this._dom.detailDetach = root.querySelector('.sf-detail-detach');
    this._dom.detailHeader = root.querySelector('.sf-detail-header');
    this._dom.contentToolbar = root.querySelector('.sf-content-toolbar');
    this._dom.contentType = root.querySelector('.sf-content-type');
    this._dom.contentSearchInput = root.querySelector('.sf-content-search input');
    this._dom.copyBtn = root.querySelector('.sf-copy-btn');
    this._dom.copyRawBtn = root.querySelector('.sf-copy-raw-btn');
    this._dom.wrapBtn = root.querySelector('.sf-wrap-btn');
    this._dom.detailBody = root.querySelector('.sf-detail-body');

    this._bindToolbar();
    this._bindTable();
    this._bindDetail();
  }

  _toolbarHTML() {
    return `<div class="sf-toolbar">
      <div class="sf-search">
        ${_SF_ICONS.search}
        <input type="text" placeholder="Search paths..." spellcheck="false">
        <button class="sf-search-clear">${_SF_ICONS.close}</button>
      </div>
      <div class="sf-dir-filter">
        <button class="sf-dir-btn">
          ${_SF_ICONS.folder}
          <span class="sf-dir-label-text">All Dirs</span>
          ${_SF_ICONS.chevron}
        </button>
        <div class="sf-dir-dropdown"></div>
      </div>
      <div class="sf-op-pills"></div>
      <div class="sf-toolbar-right">
        <span class="sf-ops-count">0 operations</span>
        <div class="sf-export">
          <button class="sf-export-btn">
            ${_SF_ICONS.download}
            Export
            ${_SF_ICONS.chevron}
          </button>
          <div class="sf-export-dropdown">
            <button data-format="json">Export as JSON</button>
            <button data-format="csv">Export as CSV</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  _timelineHTML() {
    return `<div class="sf-timeline">
      <div class="sf-timeline-track"></div>
      <span class="sf-timeline-label"></span>
    </div>`;
  }

  _emptyStateHTML() {
    return `<div class="sf-empty">
      <div class="sf-empty-icon">
        <div class="sf-orbit"></div>
        <div class="sf-orbit sf-orbit--inner"></div>
        <div class="sf-orbit-core">${_SF_ICONS.file}</div>
        <div class="sf-orbit-dot"></div>
        <div class="sf-orbit-dot sf-orbit-dot--2"></div>
      </div>
      <div class="sf-empty-title">No file operations captured yet</div>
      <div class="sf-empty-hint">File read/write/delete operations on OneLake will appear here when FLT accesses DagExecutionMetrics, locks, or settings</div>
    </div>`;
  }

  _tableHTML() {
    return `<div class="sf-table-wrap">
      <table class="sf-table">
        <thead>
          <tr>
            <th class="sf-col-path sf--sortable" data-sort="path">Path <span class="sf-sort-icon">\u25B2</span></th>
            <th class="sf-col-op sf--sortable" data-sort="op">Op <span class="sf-sort-icon">\u25B2</span></th>
            <th class="sf-col-size sf--sortable" data-sort="size">Size <span class="sf-sort-icon">\u25B2</span></th>
            <th class="sf-col-time sf--sortable sf--sorted" data-sort="time">Time <span class="sf-sort-icon">\u25BC</span></th>
            <th class="sf-col-iter">Iteration ID</th>
            <th class="sf-col-actions"></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>`;
  }

  _detailHTML() {
    return `<div class="sf-detail">
      <div class="sf-detail-resize"></div>
      <div class="sf-detail-header">
        <div class="sf-breadcrumb"></div>
        <div class="sf-detail-header-actions">
          <button class="sf-detail-detach" title="Pop out to modal">${_SF_ICONS.detach}</button>
          <button class="sf-detail-close" title="Close (Esc)">${_SF_ICONS.close}</button>
        </div>
      </div>
      <div class="sf-detail-meta"></div>
      <div class="sf-content-toolbar">
        <span class="sf-content-type">JSON</span>
        <div class="sf-content-search">
          ${_SF_ICONS.search}
          <input type="text" placeholder="Search content..." spellcheck="false">
        </div>
        <button class="sf-wrap-btn" title="Toggle word wrap">
          ${_SF_ICONS.wrap}
          <span>Wrap</span>
        </button>
        <button class="sf-copy-btn sf-copy-btn--primary" title="Copy (pretty-printed if JSON)">
          ${_SF_ICONS.copy}
          <span>Copy</span>
        </button>
        <button class="sf-copy-raw-btn sf--hidden" title="Copy raw (unformatted)">Raw</button>
      </div>
      <div class="sf-detail-body"></div>
    </div>`;
  }

  // ── Toolbar bindings ──

  _bindToolbar() {
    const d = this._dom;

    // Search
    d.searchInput.addEventListener('input', () => {
      this._searchQuery = d.searchInput.value.trim();
      d.searchClear.classList.toggle('sf--visible', this._searchQuery.length > 0);
      this._applyFilters();
    });

    d.searchClear.addEventListener('click', (e) => {
      e.stopPropagation();
      d.searchInput.value = '';
      this._searchQuery = '';
      d.searchClear.classList.remove('sf--visible');
      this._applyFilters();
    });

    // Directory filter
    d.dirBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._dirDropdownOpen = !this._dirDropdownOpen;
      d.dirDropdown.classList.toggle('sf--open', this._dirDropdownOpen);
      if (this._dirDropdownOpen) this._renderDirDropdown();
    });

    // Export
    d.exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._exportDropdownOpen = !this._exportDropdownOpen;
      d.exportDropdown.classList.toggle('sf--open', this._exportDropdownOpen);
    });

    d.exportDropdown.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        this._exportData(btn.dataset.format);
        this._exportDropdownOpen = false;
        d.exportDropdown.classList.remove('sf--open');
      });
    });
  }

  // ── Table bindings ──

  _bindTable() {
    // Sort header clicks
    this._dom.thead.querySelectorAll('.sf--sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (this._sortCol === col) {
          this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this._sortCol = col;
          this._sortDir = col === 'time' ? 'desc' : 'asc';
        }
        this._updateSortIndicators();
        this._applyFilters();
      });
    });

    // Row click delegation
    this._dom.tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const idx = parseInt(tr.dataset.idx, 10);

      // Row action buttons
      const actionBtn = e.target.closest('.sf-row-action-btn');
      if (actionBtn) {
        e.stopPropagation();
        const op = this._filtered[idx];
        if (!op) return;
        if (actionBtn.dataset.action === 'copy') {
          this._copyText(op.path);
        } else if (actionBtn.dataset.action === 'filter') {
          const dir = this._getDir(op.path);
          this._activeDirs = new Set([dir]);
          this._renderDirDropdown();
          this._updateDirLabel();
          this._applyFilters();
          this._toast('Filtered to ' + dir);
        }
        return;
      }

      this._selectRow(idx);
    });

    // Hover for tooltip/sparkline
    this._dom.tbody.addEventListener('mouseenter', (e) => {
      const tr = e.target.closest('tr');
      if (tr) this._showTooltip(e, this._filtered[parseInt(tr.dataset.idx, 10)]);
    }, true);

    this._dom.tbody.addEventListener('mousemove', (e) => {
      this._moveTooltip(e);
      this._moveSparkline(e);
    });

    this._dom.tbody.addEventListener('mouseleave', () => {
      this._hideTooltip();
      this._hideSparkline();
    }, true);

    // Per-row mouseenter for sparkline (uses delegation)
    this._dom.tbody.addEventListener('mouseover', (e) => {
      const tr = e.target.closest('tr');
      if (!tr || tr === this._lastHoverRow) return;
      this._lastHoverRow = tr;
      const op = this._filtered[parseInt(tr.dataset.idx, 10)];
      if (op) {
        this._showTooltip(e, op);
        this._showSparkline(e, op);
      }
    });

    this._dom.tbody.addEventListener('mouseout', (e) => {
      const tr = e.target.closest('tr');
      const related = e.relatedTarget && e.relatedTarget.closest('tr');
      if (tr && tr !== related) {
        this._lastHoverRow = null;
        this._hideTooltip();
        this._hideSparkline();
      }
    });
  }

  // ── Detail bindings ──

  _bindDetail() {
    const d = this._dom;

    d.detailClose.addEventListener('click', () => {
      if (this._modalEl) { this._closeModal(); return; }
      this._deselectRow();
    });

    // Resize handle
    d.detailResize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this._detailHeight;
      const onMove = (ev) => {
        this._detailHeight = Math.max(150, Math.min(window.innerHeight * 0.85, startH + (startY - ev.clientY)));
        d.detail.style.height = this._detailHeight + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Content search
    d.contentSearchInput.addEventListener('input', () => {
      const q = d.contentSearchInput.value.trim().toLowerCase();
      const lines = d.detailBody.querySelectorAll('.sf-json-line');
      lines.forEach(line => {
        line.classList.toggle('sf--search-hit', q.length > 0 && line.textContent.toLowerCase().includes(q));
      });
    });

    // Copy (smart — pretty-print JSON by default)
    d.copyBtn.addEventListener('click', () => {
      const op = this._currentOp;
      if (!op || !op.contentPreview) return;
      if (this._isJsonContent(op)) {
        try {
          const pretty = JSON.stringify(JSON.parse(op.contentPreview), null, 2);
          this._copyText(pretty, 'Copied formatted JSON');
          return;
        } catch (_e) { /* fall through to raw */ }
      }
      this._copyText(op.contentPreview, 'Copied');
    });

    // Copy raw (unformatted)
    d.copyRawBtn.addEventListener('click', () => {
      const op = this._currentOp;
      if (op && op.contentPreview) this._copyText(op.contentPreview, 'Copied raw');
    });

    // Word wrap toggle
    d.wrapBtn.addEventListener('click', () => {
      this._wordWrap = !this._wordWrap;
      d.wrapBtn.classList.toggle('sf--active', this._wordWrap);
      d.detailBody.classList.toggle('sf--wrap', this._wordWrap);
    });

    // Detach to modal
    d.detailDetach.addEventListener('click', () => this._detachToModal());
  }

  // ── Body-level elements (tooltip, sparkline) ──

  _createBodyEls() {
    if (this._bodyEls.length > 0) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'sf-tooltip';
    tooltip.innerHTML = '<div class="sf-tooltip-label"></div><div class="sf-tooltip-path"></div>';
    document.body.appendChild(tooltip);
    this._dom.tooltip = tooltip;
    this._bodyEls.push(tooltip);

    const sparkline = document.createElement('div');
    sparkline.className = 'sf-sparkline';
    sparkline.innerHTML = '<div class="sf-sparkline-title"></div><div class="sf-sparkline-bar"><div class="sf-sparkline-fill"></div></div><div class="sf-sparkline-labels"><span class="sf-sparkline-size"></span><span class="sf-sparkline-avg"></span></div>';
    document.body.appendChild(sparkline);
    this._dom.sparkline = sparkline;
    this._bodyEls.push(sparkline);
  }

  _removeBodyEls() {
    this._bodyEls.forEach(el => el.remove());
    this._bodyEls = [];
    this._dom.tooltip = null;
    this._dom.sparkline = null;
  }

  // ── Filtering & sorting ──

  _applyFilters() {
    let ops = [...this._events];

    // Directory filter
    if (!this._activeDirs.has('All')) {
      ops = ops.filter(op => this._activeDirs.has(this._getDir(op.path)));
    }

    // Operation type filter
    if (!this._activeOps.has('All')) {
      ops = ops.filter(op => this._activeOps.has(op.opCategory) || this._activeOps.has(op.operation));
    }

    // Search filter
    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      ops = ops.filter(op => op.path.toLowerCase().includes(q));
    }

    // Sort
    ops.sort((a, b) => {
      let va, vb;
      switch (this._sortCol) {
        case 'path': va = a.path; vb = b.path; break;
        case 'op': va = a.operation; vb = b.operation; break;
        case 'size': va = a.sizeBytes; vb = b.sizeBytes; break;
        case 'time': default: va = a.timestamp.getTime(); vb = b.timestamp.getTime(); break;
      }
      if (typeof va === 'string') return this._sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return this._sortDir === 'asc' ? va - vb : vb - va;
    });

    this._filtered = ops;
    this._renderAll();
  }

  // ── Render pipeline ──

  _renderAll() {
    const hasOps = this._events.length > 0;

    // Toggle empty state vs main content
    if (hasOps) {
      this._dom.emptyState.classList.add('sf--hidden');
      this._dom.mainSplit.classList.remove('sf--hidden');
    } else {
      this._dom.emptyState.classList.remove('sf--hidden');
      this._dom.mainSplit.classList.add('sf--hidden');
    }

    this._renderOpPills();
    this._updateDirLabel();
    this._updateOpsCount();
    this._renderTable();
    this._renderTimeline();
  }

  // ── Op pills ──

  _renderOpPills() {
    const counts = { All: this._events.length, Read: 0, Write: 0, Delete: 0 };
    this._events.forEach(op => { if (counts[op.opCategory] !== undefined) counts[op.opCategory]++; });

    const types = ['All', 'Read', 'Write', 'Delete'];
    this._dom.opPills.innerHTML = types.map(t => {
      const active = this._activeOps.has(t);
      const cls = active ? 'sf--active-' + t.toLowerCase() : '';
      return '<button class="sf-pill ' + cls + '" data-optype="' + t + '">' +
        t + '<span class="sf-pill-count">' + counts[t] + '</span></button>';
    }).join('');

    this._dom.opPills.querySelectorAll('.sf-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.optype;
        if (t === 'All') {
          this._activeOps = new Set(['All']);
        } else {
          this._activeOps.delete('All');
          if (this._activeOps.has(t)) this._activeOps.delete(t);
          else this._activeOps.add(t);
          if (this._activeOps.size === 0) this._activeOps = new Set(['All']);
        }
        this._applyFilters();
      });
    });
  }

  // ── Directory dropdown ──

  _renderDirDropdown() {
    const counts = {};
    this._knownDirs.forEach(d => { counts[d] = 0; });
    counts['Other'] = 0;
    this._events.forEach(op => {
      const d = this._getDir(op.path);
      if (counts[d] !== undefined) counts[d]++;
      else counts['Other']++;
    });
    counts['All'] = this._events.length;

    const dirs = ['All', ...this._knownDirs, 'Other'];
    this._dom.dirDropdown.innerHTML = dirs.map(d => {
      const checked = this._activeDirs.has('All') || this._activeDirs.has(d) ? 'checked' : '';
      const label = d === 'All' ? 'All Directories' : d;
      return '<label class="sf-dir-item"><input type="checkbox" data-dir="' + d + '" ' + checked + '>' +
        '<span class="sf-dir-label">' + label + '</span>' +
        '<span class="sf-dir-count">' + (counts[d] || 0) + '</span></label>';
    }).join('');

    this._dom.dirDropdown.querySelectorAll('input').forEach(cb => {
      cb.addEventListener('change', () => {
        const dir = cb.dataset.dir;
        if (dir === 'All') {
          this._activeDirs = new Set(['All']);
        } else {
          this._activeDirs.delete('All');
          if (cb.checked) this._activeDirs.add(dir);
          else this._activeDirs.delete(dir);
          if (this._activeDirs.size === 0) this._activeDirs = new Set(['All']);
        }
        this._renderDirDropdown();
        this._updateDirLabel();
        this._applyFilters();
      });
    });
  }

  _updateDirLabel() {
    if (!this._dom.dirLabel) return;
    if (this._activeDirs.has('All')) {
      this._dom.dirLabel.textContent = 'All Dirs';
    } else {
      const text = [...this._activeDirs].join(', ');
      this._dom.dirLabel.textContent = text.length > 18 ? text.substring(0, 16) + '\u2026' : text;
    }
  }

  _updateOpsCount() {
    const total = this._events.length;
    const filtered = this._filtered.length;
    this._dom.opsCount.textContent = filtered === total
      ? total + ' operations'
      : filtered + ' of ' + total + ' operations';
  }

  _updateSortIndicators() {
    this._dom.thead.querySelectorAll('th').forEach(th => {
      th.classList.remove('sf--sorted');
      const icon = th.querySelector('.sf-sort-icon');
      if (icon) icon.innerHTML = '\u25B2';
    });
    const active = this._dom.thead.querySelector('th[data-sort="' + this._sortCol + '"]');
    if (active) {
      active.classList.add('sf--sorted');
      const icon = active.querySelector('.sf-sort-icon');
      if (icon) icon.innerHTML = this._sortDir === 'asc' ? '\u25B2' : '\u25BC';
    }
  }

  // ── Table rendering ──

  _renderTable() {
    const ops = this._filtered;
    const parts = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const isSelected = this._selectedIdx === i;
      const isKbFocus = this._kbIdx === i;
      const lockAge = this._getLockAge(op);
      const isStale = op.isLock && lockAge !== null && lockAge > 60;

      let cls = '';
      if (isSelected) cls += ' sf--selected';
      if (isKbFocus) cls += ' sf--kb-focus';
      if (op.isLock) cls += ' sf--lock-row';
      if (isStale) cls += ' sf--stale';

      const marker = isSelected ? '<div class="sf-selected-marker"></div>' : '';
      const staleIcon = isStale ? '<span class="sf-stale-icon" title="Stale lock: ' + lockAge + 's">\u26A0</span> ' : '';
      const lockIcon = op.isLock ? ' <span class="sf-lock-icon" style="fill:var(--sf-op-write)">' + _SF_ICONS.lock + '</span>' : '';

      const opLc = op.operation.toLowerCase();
      const sizeStr = op.sizeBytes ? this._formatSize(op.sizeBytes) : '\u2014';
      const timeStr = this._formatTime(op.timestamp);
      const iterStr = op.iterationId ? this._esc(op.iterationId.substring(0, 12)) + '\u2026' : '\u2014';

      parts.push(
        '<tr class="' + cls + '" data-idx="' + i + '">' +
        '<td class="sf-path-cell">' + marker + staleIcon + '<span class="sf-path-text">' + this._highlightPath(op.path) + '</span>' + lockIcon + '</td>' +
        '<td><span class="sf-op-badge sf--' + opLc + '">' + op.operation + '</span></td>' +
        '<td class="sf-size-cell">' + sizeStr + '</td>' +
        '<td class="sf-time-cell">' + timeStr + '</td>' +
        '<td class="sf-iter-cell">' + iterStr + '</td>' +
        '<td><div class="sf-row-actions">' +
          '<button class="sf-row-action-btn" data-action="copy" title="Copy path">' + _SF_ICONS.copy + '</button>' +
          '<button class="sf-row-action-btn" data-action="filter" title="Filter directory">' + _SF_ICONS.filter + '</button>' +
        '</div></td>' +
        '</tr>'
      );
    }

    this._dom.tbody.innerHTML = parts.join('');
  }

  _highlightPath(path) {
    if (!this._searchQuery) return this._esc(path);
    const q = this._searchQuery.toLowerCase();
    const idx = path.toLowerCase().indexOf(q);
    if (idx === -1) return this._esc(path);
    return this._esc(path.substring(0, idx)) +
      '<mark>' + this._esc(path.substring(idx, idx + q.length)) + '</mark>' +
      this._esc(path.substring(idx + q.length));
  }

  // ── Timeline ──

  _renderTimeline() {
    const ops = this._filtered;
    if (ops.length === 0) {
      this._dom.timelineTrack.innerHTML = '';
      this._dom.timelineLabel.textContent = '';
      return;
    }

    const times = ops.map(op => op.timestamp.getTime());
    const minT = Math.min.apply(null, times);
    const maxT = Math.max.apply(null, times);
    const range = maxT - minT || 1;

    const dots = [];
    for (let i = 0; i < ops.length; i++) {
      const pct = ((ops[i].timestamp.getTime() - minT) / range) * 100;
      const cls = ops[i].opCategory === 'Read' ? 'sf--read' :
                  ops[i].opCategory === 'Write' ? 'sf--write' : 'sf--delete';
      dots.push('<div class="sf-timeline-dot ' + cls + '" style="left:' + pct + '%"></div>');
    }
    this._dom.timelineTrack.innerHTML = dots.join('');

    const spanSec = ((maxT - minT) / 1000).toFixed(1);
    this._dom.timelineLabel.textContent = parseFloat(spanSec) > 0 ? spanSec + 's span' : '';
  }

  // ── Row selection & detail ──

  _selectRow(idx) {
    if (idx < 0 || idx >= this._filtered.length) return;
    this._selectedIdx = idx;
    this._kbIdx = idx;
    this._detailOpen = true;
    this._collapsedGroups.clear();
    this._renderTable();
    this._openDetail(this._filtered[idx]);
    this._scrollToRow(idx);
  }

  _deselectRow() {
    if (this._modalEl) this._closeModal();
    this._selectedIdx = -1;
    this._detailOpen = false;
    this._currentOp = null;
    this._dom.detail.classList.remove('sf--open');
    this._renderTable();
  }

  _scrollToRow(idx) {
    const row = this._dom.tbody.querySelector('tr[data-idx="' + idx + '"]');
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  _openDetail(op) {
    const d = this._dom;
    this._currentOp = op;
    d.detail.classList.add('sf--open');
    d.detail.style.height = this._detailHeight + 'px';

    // Breadcrumb
    const segs = op.path.split('/');
    d.detailBreadcrumb.innerHTML = segs.map((s, i) => {
      const sep = i < segs.length - 1 ? '<span class="sf-crumb-sep">\u25B8</span>' : '';
      return '<span class="sf-crumb-seg" data-dir="' + this._esc(segs.slice(0, i + 1).join('/')) + '">' + this._esc(s) + '</span>' + sep;
    }).join('');

    // Breadcrumb segment clicks filter by directory
    d.detailBreadcrumb.querySelectorAll('.sf-crumb-seg').forEach(seg => {
      seg.addEventListener('click', () => {
        const dir = this._getDir(op.path);
        this._activeDirs = new Set([dir]);
        this._renderDirDropdown();
        this._updateDirLabel();
        this._applyFilters();
        this._toast('Filtered to ' + dir);
      });
    });

    // Meta
    const opColor = op.opCategory === 'Read' ? 'var(--sf-op-read)' :
                    op.opCategory === 'Write' ? 'var(--sf-op-write)' : 'var(--sf-op-delete)';
    const lockAge = this._getLockAge(op);
    let metaHtml =
      '<div class="sf-meta-item"><span class="sf-meta-label">Operation:</span><span class="sf-meta-value" style="color:' + opColor + '">' + op.operation + '</span></div>' +
      '<div class="sf-meta-item"><span class="sf-meta-label">Size:</span><span class="sf-meta-value">' + (op.sizeBytes ? this._formatSize(op.sizeBytes) : '\u2014') + '</span></div>' +
      '<div class="sf-meta-item"><span class="sf-meta-label">Duration:</span><span class="sf-meta-value" style="font-family:var(--font-mono)">' + op.durationMs.toFixed(1) + 'ms</span></div>' +
      '<div class="sf-meta-item"><span class="sf-meta-label">Time:</span><span class="sf-meta-value" style="font-family:var(--font-mono)">' + this._formatTime(op.timestamp) + '</span></div>';
    if (op.iterationId) {
      metaHtml += '<div class="sf-meta-item"><span class="sf-meta-label">Iteration:</span><span class="sf-meta-value" style="font-family:var(--font-mono);font-size:11px">' + this._esc(op.iterationId) + '</span></div>';
    }
    if (op.isLock && lockAge !== null) {
      const staleColor = lockAge > 60 ? 'var(--sf-op-delete)' : 'var(--sf-op-write)';
      metaHtml += '<div class="sf-meta-item"><span class="sf-meta-label">Lock Age:</span><span class="sf-meta-value" style="color:' + staleColor + '">' + lockAge + 's' + (lockAge > 60 ? ' (STALE)' : '') + '</span></div>';
    }
    if (op.ttlSeconds) {
      metaHtml += '<div class="sf-meta-item"><span class="sf-meta-label">TTL:</span><span class="sf-meta-value">' + op.ttlSeconds + 's</span></div>';
    }
    d.detailMeta.innerHTML = metaHtml;

    // Content
    d.contentSearchInput.value = '';
    const showRaw = !!(op.hasContent && op.contentPreview && this._isJsonContent(op));
    d.copyRawBtn.classList.toggle('sf--hidden', !showRaw);
    if (op.hasContent && op.contentPreview) {
      if (this._isJsonContent(op)) {
        d.contentType.textContent = 'JSON';
        d.contentToolbar.classList.remove('sf--hidden');
        this._renderJsonViewer(op.contentPreview);
      } else if (this._isBinaryContent(op)) {
        d.contentType.textContent = 'BINARY';
        d.contentToolbar.classList.remove('sf--hidden');
        this._renderHexViewer(op.contentPreview, op.sizeBytes);
      } else {
        d.contentType.textContent = 'TEXT';
        d.contentToolbar.classList.remove('sf--hidden');
        this._renderTextViewer(op.contentPreview);
      }
    } else {
      d.contentToolbar.classList.add('sf--hidden');
      this._renderUnavailable(op);
    }
  }

  _isJsonContent(op) {
    if (op.path.endsWith('.json')) return true;
    if (op.contentPreview) {
      const trimmed = op.contentPreview.trim();
      return trimmed.startsWith('{') || trimmed.startsWith('[');
    }
    return false;
  }

  _isBinaryContent(op) {
    const binExts = ['.parquet', '.delta', '.avro', '.orc', '.snappy'];
    return binExts.some(ext => op.path.endsWith(ext));
  }

  // ── JSON Viewer ──

  _renderJsonViewer(jsonStr) {
    let obj;
    try {
      obj = JSON.parse(jsonStr);
    } catch (_e) {
      this._renderTextViewer(jsonStr);
      return;
    }

    const lines = [];
    let lineNum = 0;

    const indent = (depth) => '  '.repeat(depth);

    const process = (value, depth, key, isLast) => {
      lineNum++;
      const ln = lineNum;
      const prefix = key !== undefined ? '<span class="sf-jk">"' + this._esc(String(key)) + '"</span>: ' : '';
      const comma = isLast ? '' : ',';

      if (value === null) {
        lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jnull">null</span>' + comma });
      } else if (typeof value === 'boolean') {
        lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jb">' + value + '</span>' + comma });
      } else if (typeof value === 'number') {
        lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jn">' + value + '</span>' + comma });
      } else if (typeof value === 'string') {
        lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-js">"' + this._esc(value) + '"</span>' + comma });
      } else if (Array.isArray(value)) {
        const gid = 'g' + ln;
        if (value.length === 0) {
          lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jbracket">[]</span>' + comma });
        } else {
          lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jtoggle" data-group="' + gid + '">\u25BE</span><span class="sf-jbracket" data-group="' + gid + '">[</span><span class="sf-jcollapsed sf--hidden" data-group="' + gid + '"> [' + value.length + ' items]</span>', groupId: gid, groupType: 'open' });
          value.forEach((item, i) => process(item, depth + 1, undefined, i === value.length - 1));
          lineNum++;
          lines.push({ num: lineNum, html: indent(depth) + '<span class="sf-jbracket">]</span>' + comma, groupId: gid, groupType: 'close' });
        }
      } else if (typeof value === 'object') {
        const keys = Object.keys(value);
        const gid = 'g' + ln;
        if (keys.length === 0) {
          lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jbracket">{}</span>' + comma });
        } else {
          lines.push({ num: ln, html: indent(depth) + prefix + '<span class="sf-jtoggle" data-group="' + gid + '">\u25BE</span><span class="sf-jbracket" data-group="' + gid + '">{</span><span class="sf-jcollapsed sf--hidden" data-group="' + gid + '"> {' + keys.length + ' keys}</span>', groupId: gid, groupType: 'open' });
          keys.forEach((k, i) => process(value[k], depth + 1, k, i === keys.length - 1));
          lineNum++;
          lines.push({ num: lineNum, html: indent(depth) + '<span class="sf-jbracket">}</span>' + comma, groupId: gid, groupType: 'close' });
        }
      }
    };

    process(obj, 0, undefined, true);

    const html = '<div class="sf-json-viewer">' + lines.map(l =>
      '<div class="sf-json-line" data-gid="' + (l.groupId || '') + '" data-gt="' + (l.groupType || '') + '">' +
      '<span class="sf-json-gutter">' + l.num + '</span>' +
      '<span class="sf-json-content">' + l.html + '</span></div>'
    ).join('') + '</div>';

    this._dom.detailBody.innerHTML = html;

    // Toggle collapse/expand
    this._dom.detailBody.querySelectorAll('.sf-jtoggle').forEach(toggle => {
      toggle.addEventListener('click', () => this._toggleJsonGroup(toggle.dataset.group));
    });
    this._dom.detailBody.querySelectorAll('.sf-jbracket[data-group]').forEach(br => {
      br.addEventListener('click', () => this._toggleJsonGroup(br.dataset.group));
    });
    this._dom.detailBody.querySelectorAll('.sf-jcollapsed').forEach(el => {
      el.addEventListener('click', () => this._toggleJsonGroup(el.dataset.group));
    });
  }

  _toggleJsonGroup(groupId) {
    const toggle = this._dom.detailBody.querySelector('.sf-jtoggle[data-group="' + groupId + '"]');
    if (!toggle) return;

    const isCollapsed = toggle.classList.contains('sf--collapsed');
    const collapsed = this._dom.detailBody.querySelector('.sf-jcollapsed[data-group="' + groupId + '"]');

    if (isCollapsed) {
      toggle.classList.remove('sf--collapsed');
      toggle.innerHTML = '\u25BE';
      if (collapsed) collapsed.classList.add('sf--hidden');
      this._expandJsonGroup(groupId);
    } else {
      toggle.classList.add('sf--collapsed');
      toggle.innerHTML = '\u25B8';
      if (collapsed) collapsed.classList.remove('sf--hidden');
      this._collapseJsonGroup(groupId);
    }
  }

  _collapseJsonGroup(groupId) {
    const lines = this._dom.detailBody.querySelectorAll('.sf-json-line');
    let inside = false;
    lines.forEach(line => {
      if (line.querySelector('.sf-jtoggle[data-group="' + groupId + '"]')) {
        inside = true;
        return;
      }
      if (inside) {
        if (line.dataset.gid === groupId && line.dataset.gt === 'close') {
          line.style.display = 'none';
          inside = false;
          return;
        }
        line.style.display = 'none';
      }
    });
  }

  _expandJsonGroup(groupId) {
    const lines = this._dom.detailBody.querySelectorAll('.sf-json-line');
    let inside = false;
    const nestedCollapsed = new Set();

    lines.forEach(line => {
      if (line.querySelector('.sf-jtoggle[data-group="' + groupId + '"]')) {
        inside = true;
        return;
      }
      if (!inside) return;

      if (line.dataset.gid === groupId && line.dataset.gt === 'close') {
        line.style.display = '';
        inside = false;
        return;
      }

      // Check for nested collapsed groups
      const nestedToggle = line.querySelector('.sf-jtoggle.sf--collapsed');
      if (nestedToggle) {
        nestedCollapsed.add(nestedToggle.dataset.group);
        line.style.display = '';
        return;
      }

      // Inside a nested collapsed group? Keep hidden.
      let inNested = false;
      for (const nid of nestedCollapsed) {
        if (line.dataset.gid === nid) { inNested = true; break; }
      }

      if (line.dataset.gt === 'close') {
        for (const nid of nestedCollapsed) {
          if (line.dataset.gid === nid) {
            nestedCollapsed.delete(nid);
            inNested = true;
            break;
          }
        }
      }

      line.style.display = inNested ? 'none' : '';
    });
  }

  // ── Hex Viewer ──

  _renderHexViewer(content, totalSize) {
    // Attempt to interpret content as raw bytes or show placeholder
    let bytes = [];
    if (typeof content === 'string') {
      // Attempt base64 decode, fall back to charCode
      try {
        const decoded = atob(content);
        for (let i = 0; i < decoded.length; i++) bytes.push(decoded.charCodeAt(i));
      } catch (_e) {
        for (let i = 0; i < Math.min(content.length, 256); i++) bytes.push(content.charCodeAt(i));
      }
    } else if (Array.isArray(content)) {
      bytes = content;
    }

    const previewLen = Math.min(bytes.length, 256);
    let html = '<div class="sf-hex-viewer"><div class="sf-hex-header">' +
      '<span>Binary file (' + this._formatSize(totalSize) + ')</span>' +
      '<span style="color:var(--text-muted)">Showing first ' + previewLen + ' of ' + this._formatSize(totalSize) + '</span></div>';

    for (let offset = 0; offset < previewLen; offset += 16) {
      const addr = offset.toString(16).padStart(8, '0').toUpperCase();
      let hexPart = '';
      let asciiPart = '';
      for (let j = 0; j < 16; j++) {
        if (offset + j < previewLen) {
          const b = bytes[offset + j];
          const hex = b.toString(16).padStart(2, '0').toUpperCase();
          const cls = b === 0 ? ' class="sf--null-byte"' : '';
          hexPart += '<span' + cls + '>' + hex + '</span> ';
          asciiPart += (b >= 32 && b < 127) ? String.fromCharCode(b) : '<span class="sf--non-print">.</span>';
        } else {
          hexPart += '   ';
          asciiPart += ' ';
        }
        if (j === 7) hexPart += ' ';
      }
      html += '<div class="sf-hex-line"><span class="sf-hex-addr">' + addr + '</span><span class="sf-hex-bytes">' + hexPart + '</span><span class="sf-hex-ascii">' + asciiPart + '</span></div>';
    }

    html += '</div>';
    this._dom.detailBody.innerHTML = html;
  }

  // ── Unavailable content ──

  _renderUnavailable(op) {
    const reason = op.opCategory === 'Delete' ? 'File was deleted \u2014 content not captured' :
      op.isLock ? 'Lock file \u2014 binary content not captured' :
      'Content was not captured for this operation';
    this._dom.detailBody.innerHTML =
      '<div class="sf-unavailable">' +
        '<div class="sf-unavailable-icon">' + _SF_ICONS.fileAlt + '</div>' +
        '<div class="sf-unavailable-title">Content not available</div>' +
        '<div class="sf-unavailable-reason">' + reason + '</div>' +
      '</div>';
  }

  // ── Text Viewer (line-numbered) ──

  _renderTextViewer(text) {
    const lines = String(text == null ? '' : text).split('\n');
    const parts = ['<div class="sf-text-viewer">'];
    for (let i = 0; i < lines.length; i++) {
      parts.push(
        '<div class="sf-json-line sf-text-line">' +
        '<span class="sf-json-gutter">' + (i + 1) + '</span>' +
        '<span class="sf-json-content sf-text-content">' + this._esc(lines[i] || ' ') + '</span>' +
        '</div>'
      );
    }
    parts.push('</div>');
    this._dom.detailBody.innerHTML = parts.join('');
  }

  // ── Detach to modal ──

  _detachToModal() {
    if (this._modalEl || !this._currentOp) return;
    const d = this._dom;

    const backdrop = document.createElement('div');
    backdrop.className = 'sf-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'sf-modal';
    modal.innerHTML =
      '<div class="sf-modal-drag" title="Drag to move"></div>' +
      '<div class="sf-modal-header">' +
        '<div class="sf-modal-breadcrumb-slot"></div>' +
        '<button class="sf-modal-close" title="Re-dock to drawer (Esc)">' + _SF_ICONS.close + '</button>' +
      '</div>' +
      '<div class="sf-modal-meta-slot"></div>' +
      '<div class="sf-modal-toolbar-slot"></div>' +
      '<div class="sf-modal-body"></div>';

    // Re-parent the live elements; remember origin for restoration.
    const moves = [
      { node: d.detailBreadcrumb, slot: '.sf-modal-breadcrumb-slot' },
      { node: d.detailMeta,       slot: '.sf-modal-meta-slot' },
      { node: d.contentToolbar,   slot: '.sf-modal-toolbar-slot' },
      { node: d.detailBody,       slot: '.sf-modal-body' }
    ];
    this._modalAnchors = moves.map(m => ({
      node: m.node,
      parent: m.node.parentNode,
      next: m.node.nextSibling
    }));
    moves.forEach(m => modal.querySelector(m.slot).appendChild(m.node));

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
    this._modalBackdrop = backdrop;
    this._modalEl = modal;

    // Drawer collapses while modal is shown.
    d.detail.classList.remove('sf--open');

    modal.querySelector('.sf-modal-close').addEventListener('click', () => this._closeModal());
    backdrop.addEventListener('click', () => this._closeModal());

    this._makeModalDraggable(modal);
  }

  _closeModal() {
    if (!this._modalEl) return;
    const d = this._dom;

    // Restore moved nodes to their original positions.
    if (this._modalAnchors) {
      this._modalAnchors.forEach(a => {
        if (a.next && a.next.parentNode === a.parent) {
          a.parent.insertBefore(a.node, a.next);
        } else {
          a.parent.appendChild(a.node);
        }
      });
    }
    this._modalAnchors = null;

    const modal = this._modalEl;
    const backdrop = this._modalBackdrop;
    modal.classList.add('sf--closing');
    if (backdrop) backdrop.classList.add('sf--closing');
    setTimeout(() => {
      modal.remove();
      if (backdrop) backdrop.remove();
    }, 160);
    this._modalEl = null;
    this._modalBackdrop = null;

    // Re-open drawer if a row is still selected.
    if (this._detailOpen && this._selectedIdx >= 0) {
      d.detail.classList.add('sf--open');
      d.detail.style.height = this._detailHeight + 'px';
    }
  }

  _makeModalDraggable(modal) {
    const handle = modal.querySelector('.sf-modal-drag');
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = modal.getBoundingClientRect();
      modal.style.left = rect.left + 'px';
      modal.style.top = rect.top + 'px';
      modal.style.transform = 'none';
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      const onMove = (ev) => {
        const nx = Math.max(8, Math.min(window.innerWidth - rect.width - 8, startLeft + (ev.clientX - startX)));
        const ny = Math.max(8, Math.min(window.innerHeight - rect.height - 8, startTop + (ev.clientY - startY)));
        modal.style.left = nx + 'px';
        modal.style.top = ny + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Tooltip ──

  _showTooltip(e, op) {
    if (!this._dom.tooltip || !op) return;
    const tt = this._dom.tooltip;
    const lockAge = this._getLockAge(op);
    const labelText = op.isLock && lockAge && lockAge > 60 ? '\u26A0 Stale lock \u2014 ' + lockAge + 's' : 'Full path';
    tt.querySelector('.sf-tooltip-label').textContent = labelText;
    tt.querySelector('.sf-tooltip-path').textContent = op.path;
    tt.classList.add('sf--visible');
    this._moveTooltip(e);
  }

  _moveTooltip(e) {
    if (!this._dom.tooltip) return;
    const tt = this._dom.tooltip;
    tt.style.left = (e.clientX + 12) + 'px';
    tt.style.top = (e.clientY - 36) + 'px';
    const rect = tt.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) tt.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.top < 4) tt.style.top = '4px';
  }

  _hideTooltip() {
    if (this._dom.tooltip) this._dom.tooltip.classList.remove('sf--visible');
  }

  // ── Sparkline ──

  _showSparkline(e, op) {
    if (!this._dom.sparkline || !op || !op.sizeBytes) return;
    const sp = this._dom.sparkline;
    const dir = this._getDir(op.path);
    const dirOps = this._events.filter(o => this._getDir(o.path) === dir && o.sizeBytes > 0);
    const avg = dirOps.reduce((s, o) => s + o.sizeBytes, 0) / (dirOps.length || 1);
    const max = Math.max.apply(null, dirOps.map(o => o.sizeBytes).concat([1]));
    const pct = Math.min((op.sizeBytes / max) * 100, 100);

    sp.querySelector('.sf-sparkline-title').textContent = dir;
    sp.querySelector('.sf-sparkline-fill').style.width = pct + '%';
    sp.querySelector('.sf-sparkline-size').textContent = this._formatSize(op.sizeBytes);
    sp.querySelector('.sf-sparkline-avg').textContent = 'avg: ' + this._formatSize(Math.round(avg));
    sp.classList.add('sf--visible');
    this._moveSparkline(e);
  }

  _moveSparkline(e) {
    if (!this._dom.sparkline) return;
    const sp = this._dom.sparkline;
    sp.style.left = (e.clientX + 12) + 'px';
    sp.style.top = (e.clientY + 16) + 'px';
    const rect = sp.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) sp.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight - 40) sp.style.top = (e.clientY - rect.height - 8) + 'px';
  }

  _hideSparkline() {
    if (this._dom.sparkline) this._dom.sparkline.classList.remove('sf--visible');
  }

  // ── Keyboard ──

  _handleKeyDown(e) {
    // Skip if not active or typing in unrelated input
    if (!this._active) return;
    const rtPanel = document.getElementById('view-runtime');
    if (!rtPanel || !rtPanel.classList.contains('active')) return;

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') { e.target.blur(); return; }
      if (e.ctrlKey && e.key === 'f' && this._detailOpen) {
        e.preventDefault();
        this._dom.contentSearchInput.focus();
      }
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      if (this._filtered.length === 0) return;
      this._kbIdx = Math.min(this._kbIdx + 1, this._filtered.length - 1);
      this._renderTable();
      this._scrollToRow(this._kbIdx);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      if (this._filtered.length === 0) return;
      this._kbIdx = Math.max(this._kbIdx - 1, 0);
      this._renderTable();
      this._scrollToRow(this._kbIdx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this._kbIdx >= 0) this._selectRow(this._kbIdx);
    } else if (e.key === 'Escape') {
      if (this._modalEl) { this._closeModal(); return; }
      if (this._detailOpen) this._deselectRow();
    } else if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      this._exportDropdownOpen = !this._exportDropdownOpen;
      this._dom.exportDropdown.classList.toggle('sf--open', this._exportDropdownOpen);
    } else if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      if (this._detailOpen) this._dom.contentSearchInput.focus();
      else this._dom.searchInput.focus();
    } else if (e.key === '/') {
      e.preventDefault();
      this._dom.searchInput.focus();
    }
  }

  // ── Document click handler ──

  _handleDocClick(e) {
    // Close dir dropdown on outside click
    if (this._dirDropdownOpen && !e.target.closest('.sf-dir-filter')) {
      this._dirDropdownOpen = false;
      this._dom.dirDropdown.classList.remove('sf--open');
    }
    // Close export dropdown on outside click
    if (this._exportDropdownOpen && !e.target.closest('.sf-export')) {
      this._exportDropdownOpen = false;
      this._dom.exportDropdown.classList.remove('sf--open');
    }
  }

  // ── Export ──

  _exportData(format) {
    const data = this._filtered.map(op => ({
      path: op.path,
      operation: op.operation,
      size: op.sizeBytes,
      sizeFormatted: this._formatSize(op.sizeBytes),
      timestamp: op.timestamp.toLocaleString(),
      iterationId: op.iterationId || null,
      durationMs: op.durationMs,
      isLock: op.isLock,
      content: op.hasContent ? op.contentPreview : null
    }));

    let blob, filename;
    if (format === 'json') {
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      filename = 'edog-system-files.json';
    } else {
      const cf = (val) => { const s = String(val == null ? '' : val); return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const header = 'path,operation,size,timestamp,iterationId,durationMs,isLock\n';
      const rows = data.map(d =>
        [cf(d.path), cf(d.operation), cf(d.size), cf(d.timestamp), cf(d.iterationId || ''), cf(d.durationMs), cf(d.isLock)].join(',')
      ).join('\n');
      blob = new Blob([header + rows], { type: 'text/csv' });
      filename = 'edog-system-files.csv';
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    this._toast('Exported ' + this._filtered.length + ' operations as ' + format.toUpperCase());
  }

  // ── Utility methods ──

  _getDir(path) {
    const first = (path || '').split('/')[0];
    return this._knownDirs.includes(first) ? first : 'Other';
  }

  _getLockAge(op) {
    if (!op.isLock) return null;
    const firstSeen = this._lockFirstSeen.get(op.path);
    if (!firstSeen) return null;
    return Math.round((Date.now() - firstSeen) / 1000);
  }

  _formatSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  _formatTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '\u2014';
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  _esc(str) {
    if (!str) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, c => map[c]);
  }

  _copyText(text, msg) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => this._toast(msg || 'Copied'));
    }
  }

  _toast(msg) {
    // Use existing toast system if available, otherwise create transient one
    const existing = document.getElementById('toast');
    if (existing) {
      existing.textContent = msg;
      existing.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => existing.classList.remove('show'), 2000);
      return;
    }
    // Fallback: temporary toast
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--surface);padding:8px 18px;border-radius:6px;font-size:12px;font-weight:500;z-index:1000;opacity:0;transition:opacity 250ms ease;pointer-events:none;white-space:nowrap';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 2000);
  }
}
