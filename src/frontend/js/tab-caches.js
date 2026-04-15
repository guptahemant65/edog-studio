/**
 * CachesTab — Internals: Caches sub-view.
 *
 * Displays cache manager sidebar with hit-rate arc gauges,
 * a filterable event stream, and a resizable detail panel.
 *
 * Architecture:
 *   constructor(containerEl, signalr) → activate() / deactivate()
 *   Topic: 'cache'  via SignalR SubscribeToTopic streaming.
 *
 * Event schema (from EdogCacheInterceptor):
 *   { cacheName, operation, key, hitOrMiss, valueSizeBytes,
 *     ttlSeconds, durationMs, evictionReason, timestamp, sequenceId }
 */
class CachesTab {
  constructor(containerEl, signalr) {
    /** @type {HTMLElement} */
    this._container = containerEl;
    /** @type {SignalRManager} */
    this._signalr = signalr;

    // Data
    this._allEvents = [];
    this._filteredEvents = [];
    this._managers = new Map();        // cacheName → stats object
    this._selectedManager = null;      // null = show all
    this._selectedEvent = null;
    this._focusIdx = -1;
    this._opFilter = 'all';
    this._searchQuery = '';

    // Detail panel
    this._detailOpen = false;
    this._detailHeight = 260;

    // Export dropdown
    this._exportOpen = false;

    // DOM refs (set in _buildDOM)
    this._els = {};

    // Resize state
    this._resizing = false;
    this._resizeStartY = 0;
    this._resizeStartH = 0;

    // Active state
    this._active = false;

    // Event handler reference for SignalR
    this._onCacheEvent = (event) => this._handleEvent(event);

    // Build UI
    this._buildDOM();
    this._bindEvents();
  }

  // ── Lifecycle ──

  activate() {
    this._active = true;
    if (this._signalr) {
      this._signalr.on('cache', this._onCacheEvent);
      this._signalr.subscribeTopic('cache');
    }
    document.addEventListener('keydown', this._keyHandler);
    document.addEventListener('click', this._onDocClick);
    this._filterAndRender();
  }

  deactivate() {
    this._active = false;
    document.removeEventListener('keydown', this._keyHandler);
    document.removeEventListener('click', this._onDocClick);
    if (this._signalr) {
      this._signalr.off('cache', this._onCacheEvent);
      this._signalr.unsubscribeTopic('cache');
    }
  }

  // ── DOM Construction ──

  _buildDOM() {
    const el = this._container;
    el.innerHTML = '';

    const root = this._ce('div', 'caches-tab');

    // Sidebar
    const sidebar = this._ce('div', 'cache-sidebar');
    const sHeader = this._ce('div', 'cache-sidebar-header');
    sHeader.textContent = 'Cache Managers ';
    const mgrCount = this._ce('span', 'cache-mgr-count');
    mgrCount.textContent = '(0)';
    sHeader.appendChild(mgrCount);
    sidebar.appendChild(sHeader);

    const sList = this._ce('div', 'cache-sidebar-list');
    sidebar.appendChild(sList);

    const sStats = this._ce('div', 'cache-sidebar-stats');
    sStats.innerHTML = `
      <div class="cache-sidebar-stats-title">Summary</div>
      <div class="cache-stat-row"><span>Total events</span><span class="cache-stat-val" data-ref="statTotal">0</span></div>
      <div class="cache-stat-row"><span>Hit rate</span><span class="cache-stat-val green" data-ref="statHitRate">\u2014</span></div>
      <div class="cache-stat-row"><span>Evictions</span><span class="cache-stat-val amber" data-ref="statEvictions">0</span></div>
    `;
    sidebar.appendChild(sStats);
    root.appendChild(sidebar);

    // Main area
    const main = this._ce('div', 'cache-main');

    // Toolbar
    const toolbar = this._ce('div', 'cache-toolbar');
    toolbar.innerHTML = `
      <div class="cache-search-box">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>
        <input type="text" placeholder="Filter by key... (Ctrl+F)" data-ref="searchInput">
        <span class="cache-search-count" data-ref="searchCount" style="display:none"></span>
        <button class="cache-search-clear" data-ref="searchClear" style="display:none" title="Clear">\u2715</button>
      </div>
      <div class="cache-toolbar-sep"></div>
      <div class="cache-op-pills" data-ref="opPills">
        <button class="cache-op-pill active" data-op="all">All <span class="cache-pill-count" data-ref="countAll">0</span></button>
        <button class="cache-op-pill" data-op="GET">Get <span class="cache-pill-count" data-ref="countGet">0</span></button>
        <button class="cache-op-pill" data-op="SET">Set <span class="cache-pill-count" data-ref="countSet">0</span></button>
        <button class="cache-op-pill" data-op="EVICT">Evict <span class="cache-pill-count" data-ref="countEvict">0</span></button>
      </div>
      <div class="cache-toolbar-sep"></div>
      <div class="cache-export-wrap" data-ref="exportWrap">
        <button class="cache-export-btn" data-ref="exportBtn">Export <span class="cache-export-chevron">\u25BE</span></button>
        <div class="cache-export-dropdown" data-ref="exportDropdown">
          <button class="cache-export-dd-item" data-format="csv">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 1h7l3 3v11H3z"/><path d="M10 1v3h3"/></svg>
            Export CSV
          </button>
          <button class="cache-export-dd-item" data-format="json">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 3c-2 0-2 1-2 2v2c0 1-1 1-1 1s1 0 1 1v2c0 1 0 2 2 2"/><path d="M11 3c2 0 2 1 2 2v2c0 1 1 1 1 1s-1 0-1 1v2c0 1 0 2-2 2"/></svg>
            Export JSON
          </button>
        </div>
      </div>
    `;
    main.appendChild(toolbar);

    // Column header
    const colHeader = this._ce('div', 'cache-col-header');
    colHeader.innerHTML = '<div>Op</div><div>Key</div><div>Result</div><div>Iteration</div><div style="text-align:right">Time</div>';
    main.appendChild(colHeader);

    // Event scroll
    const eventScroll = this._ce('div', 'cache-event-scroll');
    eventScroll.setAttribute('tabindex', '0');

    // Empty state
    const emptyState = this._ce('div', 'cache-empty-state');
    emptyState.innerHTML = `
      <div class="cache-empty-icon">
        <div class="cache-orbit"><div class="cache-orbit-dot"></div></div>
        <div class="cache-orbit"><div class="cache-orbit-dot"></div></div>
        <div class="cache-orbit"><div class="cache-orbit-dot"></div></div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9"/>
          <path d="M3 12a9 9 0 0 0 9 9"/>
          <path d="M12 3a9 9 0 0 1 0 18"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </div>
      <div class="cache-empty-title">No cache activity captured</div>
      <div class="cache-empty-hint">Trigger an operation in FLT to see cache reads, writes, and evictions stream here in real-time</div>
    `;
    eventScroll.appendChild(emptyState);
    main.appendChild(eventScroll);

    // Detail resize bar
    const detailResize = this._ce('div', 'cache-detail-resize');
    main.appendChild(detailResize);

    // Detail panel
    const detailPanel = this._ce('div', 'cache-detail-panel closed');
    detailPanel.style.height = this._detailHeight + 'px';
    detailPanel.innerHTML = `
      <div class="cache-detail-header">
        <span class="cache-detail-op" data-ref="detailOp"></span>
        <span class="cache-detail-key" data-ref="detailKey"></span>
        <div class="cache-detail-actions">
          <button data-ref="detailCopy" title="Copy to clipboard">\u2398</button>
          <button data-ref="detailClose" title="Close (Esc)">\u2715</button>
        </div>
      </div>
      <div class="cache-detail-body" data-ref="detailBody"></div>
    `;
    main.appendChild(detailPanel);

    // Footer
    const footer = this._ce('div', 'cache-footer');
    footer.innerHTML = `
      <div class="cache-footer-left">
        <span><kbd>\u2191</kbd><kbd>\u2193</kbd> Navigate</span>
        <div class="cache-footer-sep"></div>
        <span><kbd>Enter</kbd> Details</span>
        <div class="cache-footer-sep"></div>
        <span><kbd>Tab</kbd> Switch Manager</span>
        <div class="cache-footer-sep"></div>
        <span><kbd>Esc</kbd> Close</span>
        <div class="cache-footer-sep"></div>
        <span><kbd>Ctrl</kbd>+<kbd>F</kbd> Search</span>
      </div>
      <div class="cache-footer-right">
        <span data-ref="footerCount">0 events</span>
      </div>
    `;
    main.appendChild(footer);

    root.appendChild(main);
    el.appendChild(root);

    // Resolve data-ref elements
    this._els = {
      sidebar: sidebar,
      sidebarList: sList,
      mgrCount: mgrCount,
      eventScroll: eventScroll,
      emptyState: emptyState,
      detailPanel: detailPanel,
      detailResize: detailResize,
      exportWrap: null,
      exportBtn: null,
      exportDropdown: null,
    };

    // Resolve all data-ref nodes
    root.querySelectorAll('[data-ref]').forEach(n => {
      this._els[n.dataset.ref] = n;
    });

    // Also grab sidebar stat refs
    sStats.querySelectorAll('[data-ref]').forEach(n => {
      this._els[n.dataset.ref] = n;
    });
  }

  // ── Event Binding ──

  _bindEvents() {
    const els = this._els;

    // Sidebar clicks
    els.sidebarList.addEventListener('click', (e) => {
      const item = e.target.closest('.cache-sidebar-item');
      if (!item) return;
      const mgr = item.dataset.mgr;
      this._selectedManager = this._selectedManager === mgr ? null : mgr;
      this._filterAndRender();
      this._renderSidebar();
    });

    // Op pills
    if (els.opPills) {
      els.opPills.addEventListener('click', (e) => {
        const pill = e.target.closest('.cache-op-pill');
        if (!pill) return;
        this._opFilter = pill.dataset.op;
        els.opPills.querySelectorAll('.cache-op-pill').forEach(p =>
          p.classList.toggle('active', p === pill)
        );
        this._filterAndRender();
      });
    }

    // Search
    if (els.searchInput) {
      els.searchInput.addEventListener('input', () => {
        this._searchQuery = els.searchInput.value.trim().toLowerCase();
        if (els.searchClear) {
          els.searchClear.style.display = this._searchQuery ? '' : 'none';
        }
        this._filterAndRender();
      });
    }

    if (els.searchClear) {
      els.searchClear.addEventListener('click', () => {
        els.searchInput.value = '';
        this._searchQuery = '';
        els.searchClear.style.display = 'none';
        if (els.searchCount) els.searchCount.style.display = 'none';
        this._filterAndRender();
      });
    }

    // Export dropdown
    if (els.exportBtn) {
      els.exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._exportOpen = !this._exportOpen;
        els.exportBtn.classList.toggle('open', this._exportOpen);
        if (els.exportDropdown) {
          els.exportDropdown.classList.toggle('open', this._exportOpen);
        }
      });
    }

    if (els.exportDropdown) {
      els.exportDropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.cache-export-dd-item');
        if (!item) return;
        this._exportOpen = false;
        if (els.exportBtn) els.exportBtn.classList.remove('open');
        els.exportDropdown.classList.remove('open');
        this._exportData(item.dataset.format);
      });
    }

    // Close export on outside click — registered in activate(), removed in deactivate()
    this._onDocClick = (e) => {
      if (!this._active) return;
      if (els.exportWrap && !els.exportWrap.contains(e.target) && this._exportOpen) {
        this._exportOpen = false;
        if (els.exportBtn) els.exportBtn.classList.remove('open');
        if (els.exportDropdown) els.exportDropdown.classList.remove('open');
      }
    };

    // Event row click
    els.eventScroll.addEventListener('click', (e) => {
      const row = e.target.closest('.cache-event-row');
      if (!row) return;
      const idx = parseInt(row.dataset.idx, 10);
      this._selectEvent(idx);
    });

    // Detail close
    if (els.detailClose) {
      els.detailClose.addEventListener('click', () => this._closeDetail());
    }

    // Detail copy
    if (els.detailCopy) {
      els.detailCopy.addEventListener('click', () => {
        if (this._selectedEvent) {
          navigator.clipboard.writeText(
            JSON.stringify(this._selectedEvent, null, 2)
          ).catch(() => {});
        }
      });
    }

    // Detail panel resize
    els.detailResize.addEventListener('mousedown', (e) => {
      this._resizing = true;
      this._resizeStartY = e.clientY;
      this._resizeStartH = this._detailHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._resizing) return;
      this._detailHeight = Math.max(120,
        Math.min(500, this._resizeStartH - (e.clientY - this._resizeStartY))
      );
      els.detailPanel.style.height = this._detailHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (this._resizing) {
        this._resizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });

    // Keyboard navigation — registered in activate(), removed in deactivate()
    this._keyHandler = (e) => { if (!this._active) return; this._onKeyDown(e); };
  }

  // ── Keyboard ──

  _onKeyDown(e) {
    if (!this._active) return;

    // Don't intercept if a different input outside our tab is focused
    const inOurSearch = els => e.target === els.searchInput;

    if (e.key === 'Escape') {
      if (this._detailOpen) {
        this._closeDetail();
        e.preventDefault();
      }
      return;
    }

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        e.target !== this._els.searchInput) {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const max = this._filteredEvents.length - 1;
      if (max < 0) return;
      this._focusIdx = Math.max(0, Math.min(max, this._focusIdx + dir));
      this._highlightFocused();
    }

    if (e.key === 'Enter' && this._focusIdx >= 0 &&
        e.target !== this._els.searchInput) {
      this._selectEvent(this._focusIdx);
    }

    if ((e.key === '[' || e.key === ']') && !e.ctrlKey && !e.altKey &&
        e.target !== this._els.searchInput) {
      e.preventDefault();
      this._cycleSidebarManager(e.key === '[' ? -1 : 1);
    }

    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      if (this._els.searchInput) this._els.searchInput.focus();
    }
  }

  // ── SignalR Event Handler ──

  _handleEvent(event) {
    if (!event) return;

    // Normalize incoming event into our internal shape
    const normalized = this._normalizeEvent(event);
    this._allEvents.push(normalized);

    // Cap buffer at 2000 events (ring buffer behaviour)
    if (this._allEvents.length > 2000) {
      this._allEvents.shift();
    }

    // Update manager stats
    this._updateManagerStats(normalized.cacheName);

    // Re-render if active
    if (this._active) {
      this._filterAndRender();
    }
  }

  /**
   * Normalize a raw SignalR event into our internal format.
   * Handles both the SignalR topic event shape and any mock data shape.
   */
  _normalizeEvent(raw) {
    const data = raw.data || raw;
    return {
      id: data.sequenceId || this._allEvents.length,
      cacheName: data.cacheName || 'Unknown',
      op: (data.operation || 'GET').toUpperCase(),
      key: data.key || '',
      result: this._computeResult(data),
      valuePreview: data.valuePreview || null,
      fullValue: data.fullValue || null,
      size: data.valueSizeBytes ? this._formatBytes(data.valueSizeBytes) : null,
      ttl: data.ttlSeconds ? this._formatTTL(data.ttlSeconds) : null,
      duration: data.durationMs != null ? data.durationMs.toFixed(2) + 'ms' : null,
      iteration: data.iteration || '',
      timestamp: data.timestamp || this._nowTimestamp(),
      reason: data.evictionReason || null,
      source: data.source || null,
    };
  }

  _computeResult(data) {
    const op = (data.operation || '').toUpperCase();
    if (op === 'GET') {
      return (data.hitOrMiss || '').toUpperCase() === 'HIT' ? 'HIT' : 'MISS';
    }
    if (op === 'SET') {
      return data.ttlSeconds ? 'TTL ' + this._formatTTL(data.ttlSeconds) : 'SET';
    }
    if (op === 'EVICT') {
      return data.evictionReason || 'EVICT';
    }
    return '';
  }

  _formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  _formatTTL(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    return Math.round(seconds / 3600) + 'h';
  }

  _nowTimestamp() {
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const pad3 = (n) => String(n).padStart(3, '0');
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' +
           pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds());
  }

  // ── Manager Stats ──

  _updateManagerStats(cacheName) {
    if (!this._managers.has(cacheName)) {
      this._managers.set(cacheName, {
        id: cacheName,
        name: cacheName,
        count: 0,
        hits: 0,
        misses: 0,
        evictions: 0,
        hitRate: 0,
      });
    }
    const stats = this._managers.get(cacheName);
    const events = this._allEvents.filter(e => e.cacheName === cacheName);
    stats.count = events.length;
    stats.hits = events.filter(e => e.result === 'HIT').length;
    stats.misses = events.filter(e => e.result === 'MISS').length;
    stats.evictions = events.filter(e => e.op === 'EVICT').length;
    const gets = events.filter(e => e.op === 'GET').length;
    stats.hitRate = gets > 0 ? stats.hits / gets : (stats.evictions > 0 ? 0 : 1);
  }

  _recomputeAllManagerStats() {
    this._managers.clear();
    const seen = new Set();
    for (const ev of this._allEvents) {
      seen.add(ev.cacheName);
    }
    for (const name of seen) {
      this._updateManagerStats(name);
    }
  }

  // ── Filtering + Rendering ──

  _filterAndRender() {
    let events = [...this._allEvents];
    const els = this._els;

    // Filter by selected manager
    if (this._selectedManager) {
      events = events.filter(e => e.cacheName === this._selectedManager);
    }

    // Filter by operation
    if (this._opFilter !== 'all') {
      events = events.filter(e => e.op === this._opFilter);
    }

    // Filter by search query
    if (this._searchQuery) {
      events = events.filter(e => e.key.toLowerCase().includes(this._searchQuery));
      if (els.searchCount) {
        els.searchCount.textContent = events.length + ' match' + (events.length !== 1 ? 'es' : '');
        els.searchCount.style.display = '';
      }
    } else if (els.searchCount) {
      els.searchCount.style.display = 'none';
    }

    this._filteredEvents = events;
    this._focusIdx = -1;
    this._renderEvents();
    this._renderSidebar();
    this._updateCounts();
  }

  _updateCounts() {
    const src = this._selectedManager
      ? this._allEvents.filter(e => e.cacheName === this._selectedManager)
      : this._allEvents;

    const gets = src.filter(e => e.op === 'GET').length;
    const sets = src.filter(e => e.op === 'SET').length;
    const evicts = src.filter(e => e.op === 'EVICT').length;
    const els = this._els;

    if (els.countAll) els.countAll.textContent = src.length;
    if (els.countGet) els.countGet.textContent = gets;
    if (els.countSet) els.countSet.textContent = sets;
    if (els.countEvict) els.countEvict.textContent = evicts;
    if (els.footerCount) {
      els.footerCount.textContent = this._filteredEvents.length +
        ' event' + (this._filteredEvents.length !== 1 ? 's' : '');
    }
  }

  // ── Sidebar Rendering ──

  _renderSidebar() {
    const els = this._els;
    const managers = [...this._managers.values()]
      .sort((a, b) => b.count - a.count);

    els.mgrCount.textContent = '(' + managers.length + ')';

    if (managers.length === 0) {
      els.sidebarList.innerHTML = '';
      if (els.statTotal) els.statTotal.textContent = '0';
      if (els.statHitRate) els.statHitRate.textContent = '\u2014';
      if (els.statEvictions) els.statEvictions.textContent = '0';
      return;
    }

    // Build sidebar items
    const frag = document.createDocumentFragment();
    for (const m of managers) {
      const item = this._ce('div',
        'cache-sidebar-item' + (this._selectedManager === m.id ? ' selected' : '')
      );
      item.dataset.mgr = m.id;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected',
        this._selectedManager === m.id ? 'true' : 'false'
      );

      item.innerHTML =
        this._buildGaugeSVG(m.hitRate) +
        '<div class="cache-sidebar-item-info">' +
          '<div class="cache-sidebar-item-name">' + this._esc(m.name) + '</div>' +
          '<div class="cache-sidebar-item-sub">' +
            '<span class="sub-hit">' + m.hits + 'h</span>' +
            '<span class="sub-miss">' + m.misses + 'm</span>' +
            '<span class="sub-evict">' + m.evictions + 'e</span>' +
          '</div>' +
        '</div>' +
        '<span class="cache-event-count">' + m.count + '</span>';

      frag.appendChild(item);
    }

    els.sidebarList.innerHTML = '';
    els.sidebarList.appendChild(frag);

    // Summary stats
    const totalEvents = this._allEvents.length;
    const totalGets = this._allEvents.filter(e => e.op === 'GET').length;
    const totalHits = this._allEvents.filter(e => e.result === 'HIT').length;
    const totalEvictions = this._allEvents.filter(e => e.op === 'EVICT').length;
    const hitRate = totalGets > 0 ? Math.round((totalHits / totalGets) * 100) : 0;

    if (els.statTotal) els.statTotal.textContent = totalEvents;
    if (els.statHitRate) {
      els.statHitRate.textContent = totalGets > 0 ? hitRate + '%' : '\u2014';
      els.statHitRate.className = 'cache-stat-val ' +
        (hitRate > 70 ? 'green' : hitRate >= 40 ? 'amber' : 'red');
    }
    if (els.statEvictions) els.statEvictions.textContent = totalEvictions;
  }

  // ── Event Stream Rendering ──

  _renderEvents() {
    const els = this._els;
    const isEmpty = this._filteredEvents.length === 0;
    els.emptyState.classList.toggle('hidden', !isEmpty);

    // Clear old rows
    const oldRows = els.eventScroll.querySelectorAll('.cache-event-row');
    for (let i = oldRows.length - 1; i >= 0; i--) {
      oldRows[i].remove();
    }

    if (isEmpty) return;

    const frag = document.createDocumentFragment();

    for (let i = 0; i < this._filteredEvents.length; i++) {
      const ev = this._filteredEvents[i];
      const row = this._ce('div',
        'cache-event-row cache-row-enter' +
        (this._selectedEvent && this._selectedEvent.id === ev.id ? ' selected' : '')
      );
      row.dataset.idx = i;
      row.dataset.id = ev.id;
      row.setAttribute('role', 'row');

      const opClass = ev.op === 'GET' ? 'op-get' : ev.op === 'SET' ? 'op-set' : 'op-evict';
      const keyDisplay = this._searchQuery
        ? this._highlightMatch(ev.key)
        : this._esc(ev.key);

      // Build meta parts
      let metaHtml = '';
      if (ev.valuePreview) {
        metaHtml += '<span class="cache-ev-preview">' + this._esc(ev.valuePreview) + '</span>';
      } else if (ev.op === 'GET' && ev.result === 'MISS') {
        metaHtml += '<span class="cache-ev-preview" style="font-style:italic;opacity:.6">No cached value</span>';
      }
      if (ev.duration) {
        metaHtml += '<span class="cache-ev-duration">' + this._esc(ev.duration) + '</span>';
      }
      if (ev.size) {
        metaHtml += '<span class="cache-ev-size">' + this._esc(ev.size) + '</span>';
      }
      if (ev.reason) {
        metaHtml += '<span class="cache-ev-reason">\u26A0 ' + this._esc(ev.reason) + '</span>';
      }

      row.innerHTML =
        '<div><span class="cache-op-badge ' + opClass + '">' + ev.op + '</span></div>' +
        '<div class="cache-ev-key">' + keyDisplay + '</div>' +
        '<div>' + this._buildResultBadge(ev) + '</div>' +
        '<div class="cache-ev-iter">' + this._esc(ev.iteration) + '</div>' +
        '<div class="cache-ev-time">' + this._esc(ev.timestamp) + '</div>' +
        '<div class="cache-ev-meta">' + metaHtml + '</div>';

      frag.appendChild(row);
    }

    els.eventScroll.appendChild(frag);
  }

  _buildResultBadge(ev) {
    if (ev.op === 'GET') {
      if (ev.result === 'HIT') {
        return '<span class="cache-result-badge hit">\u2713 HIT</span>';
      }
      return '<span class="cache-result-badge miss">\u2715 MISS</span>';
    }
    if (ev.op === 'SET') {
      const label = ev.ttl ? 'TTL ' + ev.ttl : 'SET';
      return '<span class="cache-result-badge ttl">' + this._esc(label) + '</span>';
    }
    if (ev.op === 'EVICT') {
      const label = ev.result || 'EVICT';
      return '<span class="cache-result-badge expired">' + this._esc(label) + '</span>';
    }
    return '';
  }

  _highlightMatch(key) {
    const idx = key.toLowerCase().indexOf(this._searchQuery);
    if (idx === -1) return this._esc(key);
    const before = key.slice(0, idx);
    const match = key.slice(idx, idx + this._searchQuery.length);
    const after = key.slice(idx + this._searchQuery.length);
    return this._esc(before) + '<mark>' + this._esc(match) + '</mark>' + this._esc(after);
  }

  // ── Focused Row ──

  _highlightFocused() {
    const rows = this._els.eventScroll.querySelectorAll('.cache-event-row');
    rows.forEach((row, i) => {
      row.classList.toggle('selected', i === this._focusIdx);
    });
    const focused = this._els.eventScroll.querySelector('.cache-event-row.selected');
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  }

  // ── Event Selection / Detail ──

  _selectEvent(idx) {
    if (idx < 0 || idx >= this._filteredEvents.length) return;
    this._focusIdx = idx;
    this._selectedEvent = this._filteredEvents[idx];
    this._highlightFocused();
    this._openDetail(this._selectedEvent);
  }

  _openDetail(ev) {
    this._detailOpen = true;
    const els = this._els;
    els.detailPanel.classList.remove('closed');
    els.detailPanel.style.height = this._detailHeight + 'px';

    // Header
    const opColor = ev.op === 'GET'
      ? 'var(--status-succeeded)'
      : ev.op === 'SET'
        ? 'var(--level-message)'
        : 'var(--status-failed)';
    if (els.detailOp) {
      els.detailOp.style.color = opColor;
      els.detailOp.textContent = ev.op;
    }
    if (els.detailKey) {
      els.detailKey.textContent = ev.key;
    }

    // Body
    let body = '';

    // Meta grid
    const metaItems = [
      { label: 'Operation', value: ev.op },
      { label: 'Manager', value: ev.cacheName },
    ];
    if (ev.result) metaItems.push({ label: 'Result', value: ev.result });
    if (ev.ttl) metaItems.push({ label: 'TTL', value: ev.ttl });
    if (ev.size) metaItems.push({ label: 'Size', value: ev.size });
    if (ev.duration) metaItems.push({ label: 'Latency', value: ev.duration });
    if (ev.iteration) metaItems.push({ label: 'Iteration', value: ev.iteration });
    metaItems.push({ label: 'Timestamp', value: ev.timestamp });
    if (ev.reason) metaItems.push({ label: 'Reason', value: ev.reason });

    body += '<div class="cache-detail-meta-grid">';
    for (const m of metaItems) {
      body += '<div class="cache-detail-meta-item">' +
        '<span class="cache-detail-meta-label">' + m.label + '</span>' +
        '<span class="cache-detail-meta-value">' + this._esc(m.value) + '</span>' +
        '</div>';
    }
    body += '</div>';

    // Full value (JSON highlighted)
    if (ev.fullValue) {
      body += '<div><div class="cache-detail-section-title">Value</div>';
      body += '<div class="cache-detail-json">' + this._highlightJSON(ev.fullValue) + '</div></div>';
    } else if (ev.valuePreview) {
      body += '<div><div class="cache-detail-section-title">Preview</div>';
      body += '<div class="cache-detail-json">' + this._esc(ev.valuePreview) + '</div></div>';
    }

    // Source
    if (ev.source) {
      body += '<div><div class="cache-detail-section-title">Source</div>' +
        '<span class="cache-detail-source">' + this._esc(ev.source) + '</span></div>';
    }

    if (els.detailBody) els.detailBody.innerHTML = body;
  }

  _closeDetail() {
    this._detailOpen = false;
    this._selectedEvent = null;
    this._els.detailPanel.classList.add('closed');
    this._els.eventScroll.querySelectorAll('.cache-event-row.selected')
      .forEach(r => r.classList.remove('selected'));
  }

  // ── Sidebar Navigation ──

  _cycleSidebarManager(dir) {
    const ids = [null, ...([...this._managers.values()].map(m => m.id))];
    let idx = ids.indexOf(this._selectedManager);
    idx = (idx + dir + ids.length) % ids.length;
    this._selectedManager = ids[idx];
    this._filterAndRender();
  }

  // ── Export ──

  _exportData(format) {
    const data = this._filteredEvents;
    let content, mime, ext;

    if (format === 'json') {
      content = JSON.stringify(data, null, 2);
      mime = 'application/json';
      ext = 'json';
    } else {
      // CSV
      const headers = ['id', 'cacheName', 'op', 'key', 'result', 'size', 'ttl', 'duration', 'iteration', 'timestamp', 'reason'];
      const rows = data.map(ev =>
        headers.map(h => '"' + String(ev[h] || '').replace(/"/g, '""') + '"').join(',')
      );
      content = headers.join(',') + '\n' + rows.join('\n');
      mime = 'text/csv';
      ext = 'csv';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edog-caches-export.' + ext;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── SVG Gauge ──

  _buildGaugeSVG(hitRate, size) {
    size = size || 32;
    const r = 13;
    const circ = 2 * Math.PI * r;
    const arc = circ * 0.75; // 270 degrees
    const offset = (1 - hitRate) * arc;
    const color = hitRate > 0.70
      ? 'var(--status-succeeded)'
      : hitRate >= 0.40
        ? 'var(--level-warning)'
        : 'var(--status-failed)';
    const pct = Math.round(hitRate * 100);

    return '<svg class="cache-gauge" width="' + size + '" height="' + size + '" viewBox="0 0 32 32">' +
      '<circle cx="16" cy="16" r="' + r + '" fill="none" stroke="var(--surface-3)" stroke-width="3"' +
      ' stroke-dasharray="' + arc.toFixed(2) + '" stroke-dashoffset="0"' +
      ' transform="rotate(-135 16 16)" stroke-linecap="round"/>' +
      '<circle cx="16" cy="16" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="3"' +
      ' stroke-dasharray="' + arc.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"' +
      ' transform="rotate(-135 16 16)" stroke-linecap="round"/>' +
      '<text x="16" y="17.5" text-anchor="middle" font-size="8" font-weight="700"' +
      ' font-family="var(--font-mono)" fill="var(--text)">' + pct + '%</text>' +
      '</svg>';
  }

  // ── JSON Highlighter ──

  _highlightJSON(obj, indent) {
    indent = indent || 0;
    if (obj === null) return '<span class="json-null">null</span>';
    if (typeof obj === 'boolean') return '<span class="json-bool">' + obj + '</span>';
    if (typeof obj === 'number') return '<span class="json-number">' + obj + '</span>';
    if (typeof obj === 'string') return '<span class="json-string">"' + this._esc(obj) + '"</span>';

    const pad = '  '.repeat(indent);
    const padInner = '  '.repeat(indent + 1);

    if (Array.isArray(obj)) {
      if (obj.length === 0) return '<span class="json-brace">[]</span>';
      const items = obj.map(v => padInner + this._highlightJSON(v, indent + 1));
      return '<span class="json-brace">[</span>\n' + items.join(',\n') + '\n' + pad + '<span class="json-brace">]</span>';
    }

    const keys = Object.keys(obj);
    if (keys.length === 0) return '<span class="json-brace">{}</span>';
    const entries = keys.map(k =>
      padInner + '<span class="json-key">"' + this._esc(k) + '"</span>: ' + this._highlightJSON(obj[k], indent + 1)
    );
    return '<span class="json-brace">{</span>\n' + entries.join(',\n') + '\n' + pad + '<span class="json-brace">}</span>';
  }

  // ── Helpers ──

  _ce(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
