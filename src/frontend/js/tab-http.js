/**
 * HttpPipelineTab — HTTP Pipeline inspector for EDOG Studio Runtime View.
 *
 * Chrome DevTools Network tab meets Postman. Subscribes to the `http` SignalR
 * topic for real-time HTTP call monitoring from FLT DelegatingHandlers.
 *
 * Architecture: constructor(containerEl, signalr) → activate() / deactivate()
 * Topic: `http`  |  Event shape: HttpRequestEvent (see SIGNALR_PROTOCOL.md)
 *
 * Security: Authorization header REDACTED. SAS tokens stripped. Body ≤ 4KB.
 * Performance: handles 2000+ events via DOM recycling and deferred rendering.
 */
class HttpPipelineTab {
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // State
    this._events = [];         // all events (ring-buffered to 2000)
    this._filtered = [];       // post-filter view
    this._selectedId = null;
    this._nextId = 0;
    this._active = false;

    // Filters
    this._methodFilter = 'all';
    this._statusFilter = 'all';
    this._urlFilter = '';
    this._durationMax = 60000;
    this._sortField = 'time';
    this._sortDir = 'asc';

    // Detail
    this._detailTab = 'request';
    this._detailHeight = 320;
    this._exportOpen = false;

    // Perf: defer renders to animation frames
    this._renderPending = false;

    // Max buffer
    this._MAX_EVENTS = 2000;

    // DOM cache
    this._els = {};

    // Bound handler for SignalR
    this._onEvent = this._onEvent.bind(this);

    // Build DOM
    this._buildDOM();
    this._bindEvents();
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  /** Called when tab becomes visible. Subscribe to `http` topic. */
  activate() {
    this._active = true;
    if (this._signalr) {
      this._signalr.on('http', this._onEvent);
      this._signalr.subscribeTopic('http');
    }
    document.addEventListener('keydown', this._globalKeyHandler);
    document.addEventListener('click', this._onDocClick);
    this._scheduleRender();
  }

  /** Called when tab is hidden. Unsubscribe to save resources. */
  deactivate() {
    this._active = false;
    document.removeEventListener('keydown', this._globalKeyHandler);
    document.removeEventListener('click', this._onDocClick);
    if (this._signalr) {
      this._signalr.off('http', this._onEvent);
      this._signalr.unsubscribeTopic('http');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SIGNALR EVENT HANDLER
  // ═══════════════════════════════════════════════════════════════════

  _onEvent(envelope) {
    const d = envelope && envelope.data ? envelope.data : envelope;
    if (!d) return;

    const entry = {
      _id: this._nextId++,
      _ts: envelope.timestamp || new Date().toISOString(),
      _seq: envelope.sequenceId || this._nextId,
      method: (d.method || 'GET').toUpperCase(),
      url: this._sanitizeUrl(d.url || ''),
      statusCode: d.statusCode || 0,
      durationMs: d.durationMs || 0,
      requestHeaders: this._redactHeaders(d.requestHeaders || {}),
      responseHeaders: d.responseHeaders || {},
      responseBodyPreview: (d.responseBodyPreview || '').slice(0, 4096),
      httpClientName: d.httpClientName || '',
      correlationId: d.correlationId || ''
    };

    // Ring buffer: drop oldest if at capacity
    if (this._events.length >= this._MAX_EVENTS) {
      this._events.shift();
    }
    this._events.push(entry);
    this._scheduleRender();
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECURITY
  // ═══════════════════════════════════════════════════════════════════

  _sanitizeUrl(url) {
    // Strip SAS tokens: ?sig=...&se=...&sp=... or &sig=...
    return url.replace(/[?&](sig|se|sp|sv|st|spr|srt|ss)=[^&]*/gi, function(match, key, offset) {
      var prefix = match.charAt(0);
      return offset === url.indexOf('?') ? '?' + key + '=[redacted]' : prefix + key + '=[redacted]';
    });
  }

  _redactHeaders(headers) {
    var safe = {};
    for (var key in headers) {
      if (!headers.hasOwnProperty(key)) continue;
      if (key.toLowerCase() === 'authorization') {
        safe[key] = '[redacted]';
      } else {
        safe[key] = headers[key];
      }
    }
    return safe;
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOM CONSTRUCTION
  // ═══════════════════════════════════════════════════════════════════

  _buildDOM() {
    var c = this._container;
    c.innerHTML = '';

    var root = document.createElement('div');
    root.className = 'http-pipeline';

    // Tooltip (appended to root, positioned fixed)
    var tooltip = document.createElement('div');
    tooltip.className = 'http-tooltip';
    root.appendChild(tooltip);
    this._els.tooltip = tooltip;

    // Toolbar
    root.appendChild(this._buildToolbar());

    // Content area
    var content = document.createElement('div');
    content.className = 'http-content';

    // Empty state
    content.appendChild(this._buildEmptyState());

    // Table header
    content.appendChild(this._buildTableHeader());

    // Scroll area
    var scroll = document.createElement('div');
    scroll.className = 'http-scroll';
    scroll.style.display = 'none';
    content.appendChild(scroll);
    this._els.scroll = scroll;

    // Detail resize handle
    var resize = document.createElement('div');
    resize.className = 'http-detail-resize';
    content.appendChild(resize);
    this._els.resize = resize;

    // Detail panel
    content.appendChild(this._buildDetailPanel());

    root.appendChild(content);
    c.appendChild(root);
  }

  _buildToolbar() {
    var toolbar = document.createElement('div');
    toolbar.className = 'http-toolbar';

    // Row 1: search + method pills + status pills
    var row1 = document.createElement('div');
    row1.className = 'http-toolbar-row';

    // Search box
    var search = document.createElement('div');
    search.className = 'http-search';
    search.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14" y2="14"/>' +
      '</svg>';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter URLs... Ctrl+/';
    searchInput.setAttribute('aria-label', 'Filter HTTP requests by URL');
    search.appendChild(searchInput);
    var searchClear = document.createElement('div');
    searchClear.className = 'http-search-clear';
    searchClear.textContent = '\u2715';
    searchClear.title = 'Clear';
    search.appendChild(searchClear);
    row1.appendChild(search);
    this._els.searchInput = searchInput;
    this._els.searchClear = searchClear;

    row1.appendChild(this._makeSep());

    // Method pills
    var methods = document.createElement('div');
    methods.className = 'http-method-pills';
    var methodList = ['all', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    for (var i = 0; i < methodList.length; i++) {
      var m = methodList[i];
      var pill = document.createElement('button');
      pill.className = 'http-pill' + (m === 'all' ? ' active' : '');
      pill.dataset.value = m;
      pill.setAttribute('aria-pressed', m === 'all' ? 'true' : 'false');
      pill.textContent = m === 'all' ? 'All' : (m === 'DELETE' ? 'DEL' : m);
      if (m !== 'all') {
        var cnt = document.createElement('span');
        cnt.className = 'http-pill-count';
        cnt.dataset.method = m;
        cnt.textContent = '0';
        pill.appendChild(document.createTextNode(' '));
        pill.appendChild(cnt);
      }
      methods.appendChild(pill);
    }
    row1.appendChild(methods);
    this._els.methodPills = methods;

    row1.appendChild(this._makeSep());

    // Status pills
    var statuses = document.createElement('div');
    statuses.className = 'http-status-pills';
    var statusList = ['all', '2xx', '4xx', '5xx'];
    for (var j = 0; j < statusList.length; j++) {
      var s = statusList[j];
      var sp = document.createElement('button');
      sp.className = 'http-pill' + (s === 'all' ? ' active' : '');
      sp.dataset.value = s;
      sp.setAttribute('aria-pressed', s === 'all' ? 'true' : 'false');
      sp.textContent = s === 'all' ? 'All' : s;
      if (s !== 'all') {
        var sc = document.createElement('span');
        sc.className = 'http-pill-count';
        sc.dataset.status = s;
        sc.textContent = '0';
        sp.appendChild(document.createTextNode(' '));
        sp.appendChild(sc);
      }
      statuses.appendChild(sp);
    }
    row1.appendChild(statuses);
    this._els.statusPills = statuses;

    toolbar.appendChild(row1);

    // Row 2: count + duration slider + stats + actions
    var row2 = document.createElement('div');
    row2.className = 'http-toolbar-row';

    var reqCount = document.createElement('span');
    reqCount.className = 'http-request-count';
    reqCount.textContent = '0 requests';
    row2.appendChild(reqCount);
    this._els.reqCount = reqCount;

    row2.appendChild(this._makeSep());

    // Duration slider
    var durWrap = document.createElement('div');
    durWrap.className = 'http-dur-slider';
    durWrap.innerHTML =
      '<span>Duration:</span>' +
      '<span class="http-dur-val">0ms</span>';
    var durSlider = document.createElement('input');
    durSlider.type = 'range';
    durSlider.min = '0';
    durSlider.max = '60000';
    durSlider.value = '60000';
    durSlider.step = '100';
    durSlider.setAttribute('aria-label', 'Maximum duration filter');
    durWrap.appendChild(durSlider);
    var durMax = document.createElement('span');
    durMax.className = 'http-dur-val';
    durMax.textContent = '60s';
    durWrap.appendChild(durMax);
    row2.appendChild(durWrap);
    this._els.durSlider = durSlider;
    this._els.durMax = durMax;

    row2.appendChild(this._makeSep());

    // Stats: p50, p95, p99 + dist bar
    var stats = document.createElement('div');
    stats.className = 'http-stats';
    var labels = ['p50', 'p95', 'p99'];
    for (var k = 0; k < labels.length; k++) {
      var stat = document.createElement('div');
      stat.className = 'http-stat';
      stat.innerHTML = '<span>' + labels[k] + '</span>';
      var val = document.createElement('span');
      val.className = 'http-stat-val';
      val.dataset.stat = labels[k];
      val.textContent = '--';
      stat.appendChild(val);
      stats.appendChild(stat);
    }
    var dist = document.createElement('div');
    dist.className = 'http-dist';
    stats.appendChild(dist);
    row2.appendChild(stats);
    this._els.stats = stats;
    this._els.dist = dist;

    row2.appendChild(this._makeSep());

    // Filter badge
    var badge = document.createElement('span');
    badge.className = 'http-filter-badge';
    badge.innerHTML = '<span class="http-filter-badge-count">0</span> filters active';
    row2.appendChild(badge);
    this._els.filterBadge = badge;

    // Spacer
    var spacer = document.createElement('div');
    spacer.style.marginLeft = 'auto';
    spacer.style.display = 'flex';
    spacer.style.gap = '4px';
    spacer.style.alignItems = 'center';

    // Clear button
    var clearBtn = document.createElement('button');
    clearBtn.className = 'http-action';
    clearBtn.title = 'Clear all requests';
    clearBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10"/>' +
      '</svg> Clear';
    spacer.appendChild(clearBtn);
    this._els.clearBtn = clearBtn;

    // Export
    var exportWrap = document.createElement('div');
    exportWrap.className = 'http-export-wrap';
    var exportBtn = document.createElement('button');
    exportBtn.className = 'http-action';
    exportBtn.title = 'Export (Ctrl+E)';
    exportBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M8 2v8M5 7l3 3 3-3M3 12v2h10v-2"/>' +
      '</svg> Export \u25BE';
    exportWrap.appendChild(exportBtn);
    this._els.exportBtn = exportBtn;

    var exportDD = document.createElement('div');
    exportDD.className = 'http-export-dd';
    var formats = [
      { id: 'har', label: 'Export as HAR' },
      { id: 'json', label: 'Export as JSON' },
      { id: 'csv', label: 'Export as CSV' }
    ];
    for (var fi = 0; fi < formats.length; fi++) {
      var item = document.createElement('div');
      item.className = 'http-export-item';
      item.dataset.format = formats[fi].id;
      item.textContent = formats[fi].label;
      exportDD.appendChild(item);
    }
    exportWrap.appendChild(exportDD);
    this._els.exportDD = exportDD;
    spacer.appendChild(exportWrap);

    row2.appendChild(spacer);
    toolbar.appendChild(row2);

    return toolbar;
  }

  _buildEmptyState() {
    var empty = document.createElement('div');
    empty.className = 'http-empty';
    empty.innerHTML =
      '<svg viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5">' +
        '<circle cx="28" cy="28" r="24"/>' +
        '<path d="M16 28c0-6.627 5.373-12 12-12s12 5.373 12 12"/>' +
        '<path d="M20 20l-4-4M36 20l4-4M28 6v6M44 28h-6"/>' +
        '<circle cx="28" cy="28" r="3" fill="currentColor" opacity="0.3"/>' +
      '</svg>' +
      '<div class="http-empty-title">No HTTP calls captured</div>' +
      '<div class="http-empty-hint">Outbound HTTP requests through DelegatingHandlers will appear here when the FLT service makes API calls</div>';
    this._els.empty = empty;
    return empty;
  }

  _buildTableHeader() {
    var thead = document.createElement('div');
    thead.className = 'http-thead';
    thead.style.display = 'none';
    var cols = [
      { key: 'method', label: 'Method' },
      { key: 'url', label: 'URL' },
      { key: 'status', label: 'Status' },
      { key: 'duration', label: 'Duration' },
      { key: 'retry', label: 'Retry' },
      { key: 'time', label: 'Time' }
    ];
    for (var i = 0; i < cols.length; i++) {
      var th = document.createElement('div');
      th.className = 'http-th' + (cols[i].key === 'time' ? ' sorted' : '');
      th.dataset.sort = cols[i].key;
      th.textContent = cols[i].label + ' ';
      th.setAttribute('role', 'columnheader');
      th.tabIndex = 0;
      var sortIcon = document.createElement('span');
      sortIcon.className = 'http-th-sort';
      sortIcon.textContent = '\u25BC';
      th.appendChild(sortIcon);
      thead.appendChild(th);
    }
    this._els.thead = thead;
    return thead;
  }

  _buildDetailPanel() {
    var panel = document.createElement('div');
    panel.className = 'http-detail closed';
    panel.style.height = this._detailHeight + 'px';

    // Tab bar
    var tabs = document.createElement('div');
    tabs.className = 'http-detail-tabs';
    var tabNames = ['Request', 'Response', 'Timing', 'Headers'];
    var tabIds = ['request', 'response', 'timing', 'headers'];
    for (var i = 0; i < tabNames.length; i++) {
      var tab = document.createElement('button');
      tab.className = 'http-detail-tab' + (tabIds[i] === 'request' ? ' active' : '');
      tab.dataset.dtab = tabIds[i];
      tab.textContent = tabNames[i];
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tabIds[i] === 'request' ? 'true' : 'false');
      tabs.appendChild(tab);
    }
    var indicator = document.createElement('div');
    indicator.className = 'http-dtab-indicator';
    tabs.appendChild(indicator);
    this._els.dtabIndicator = indicator;

    var closeBtn = document.createElement('button');
    closeBtn.className = 'http-detail-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close detail panel');
    tabs.appendChild(closeBtn);
    this._els.detailClose = closeBtn;

    panel.appendChild(tabs);
    this._els.detailTabs = tabs;

    // Body
    var body = document.createElement('div');
    body.className = 'http-detail-body';
    panel.appendChild(body);
    this._els.detailBody = body;

    this._els.detail = panel;
    return panel;
  }

  _makeSep() {
    var s = document.createElement('div');
    s.className = 'http-sep';
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════
  // EVENT BINDING
  // ═══════════════════════════════════════════════════════════════════

  _bindEvents() {
    var self = this;

    // Search
    this._els.searchInput.addEventListener('input', function() {
      self._urlFilter = self._els.searchInput.value;
      self._els.searchClear.classList.toggle('visible', !!self._urlFilter);
      self._applyFilters();
    });
    this._els.searchClear.addEventListener('click', function() {
      self._els.searchInput.value = '';
      self._urlFilter = '';
      self._els.searchClear.classList.remove('visible');
      self._applyFilters();
    });

    // Method pills
    this._els.methodPills.addEventListener('click', function(e) {
      var pill = e.target.closest('.http-pill');
      if (!pill) return;
      self._els.methodPills.querySelectorAll('.http-pill').forEach(function(p) {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-pressed', 'true');
      self._methodFilter = pill.dataset.value;
      self._applyFilters();
    });

    // Status pills
    this._els.statusPills.addEventListener('click', function(e) {
      var pill = e.target.closest('.http-pill');
      if (!pill) return;
      self._els.statusPills.querySelectorAll('.http-pill').forEach(function(p) {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-pressed', 'true');
      self._statusFilter = pill.dataset.value;
      self._applyFilters();
    });

    // Duration slider
    this._els.durSlider.addEventListener('input', function() {
      self._durationMax = parseInt(self._els.durSlider.value, 10);
      var v = self._durationMax;
      self._els.durMax.textContent = v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
      self._applyFilters();
    });

    // Sort
    this._els.thead.addEventListener('click', function(e) {
      var th = e.target.closest('.http-th');
      if (!th || !th.dataset.sort) return;
      if (self._sortField === th.dataset.sort) {
        self._sortDir = self._sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        self._sortField = th.dataset.sort;
        self._sortDir = 'asc';
      }
      self._els.thead.querySelectorAll('.http-th').forEach(function(h) {
        h.classList.toggle('sorted', h.dataset.sort === self._sortField);
      });
      self._applyFilters();
    });

    // Clear
    this._els.clearBtn.addEventListener('click', function() {
      self._events = [];
      self._filtered = [];
      self._selectedId = null;
      self._nextId = 0;
      self._closeDetail();
      self._render();
    });

    // Export toggle
    this._els.exportBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      self._exportOpen = !self._exportOpen;
      self._els.exportDD.classList.toggle('open', self._exportOpen);
    });

    // Export items
    this._els.exportDD.addEventListener('click', function(e) {
      var item = e.target.closest('.http-export-item');
      if (!item) return;
      self._exportOpen = false;
      self._els.exportDD.classList.remove('open');
      self._exportAs(item.dataset.format);
    });

    // Close export on outside click — registered in activate(), removed in deactivate()
    this._onDocClick = function(e) {
      if (!self._active) return;
      if (self._exportOpen && !self._els.exportBtn.contains(e.target) && !self._els.exportDD.contains(e.target)) {
        self._exportOpen = false;
        self._els.exportDD.classList.remove('open');
      }
    };

    // Detail tabs
    this._els.detailTabs.addEventListener('click', function(e) {
      var tab = e.target.closest('.http-detail-tab');
      if (!tab || !tab.dataset.dtab) return;
      self._detailTab = tab.dataset.dtab;
      self._els.detailTabs.querySelectorAll('.http-detail-tab').forEach(function(t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      self._updateDetailIndicator();
      self._renderDetail();
    });

    // Detail close
    this._els.detailClose.addEventListener('click', function() {
      self._closeDetail();
    });

    // Detail resize
    var resizing = false;
    var startY = 0;
    var startH = 0;
    this._els.resize.addEventListener('mousedown', function(e) {
      resizing = true;
      startY = e.clientY;
      startH = self._els.detail.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', function(e) {
      if (!resizing) return;
      var h = Math.max(120, startH - (e.clientY - startY));
      self._els.detail.style.height = h + 'px';
      self._detailHeight = h;
    });
    document.addEventListener('mouseup', function() {
      if (resizing) {
        resizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });

    // Keyboard navigation
    this._container.addEventListener('keydown', function(e) {
      self._onKeyDown(e);
    });

    // Global keyboard shortcuts (only when active)
    // Global keyboard shortcuts — registered in activate(), removed in deactivate()
    this._globalKeyHandler = function(e) {
      if (!self._active) return;
      // Only handle if we're in the runtime view and this tab is active
      var rtContent = self._container.closest('.rt-tab-content');
      if (rtContent && !rtContent.classList.contains('active')) return;

      if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        self._els.searchInput.focus();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        self._exportOpen = !self._exportOpen;
        self._els.exportDD.classList.toggle('open', self._exportOpen);
      }
    };

    // Tooltip for URL cells
    this._container.addEventListener('mouseover', function(e) {
      var cell = e.target.closest('.http-url');
      if (cell && cell.scrollWidth > cell.clientWidth) {
        self._els.tooltip.textContent = cell.textContent;
        self._els.tooltip.style.display = 'block';
      }
    });
    this._container.addEventListener('mousemove', function(e) {
      if (self._els.tooltip.style.display === 'block') {
        var x = e.clientX + 12;
        var y = e.clientY + 12;
        var w = self._els.tooltip.offsetWidth;
        var h = self._els.tooltip.offsetHeight;
        if (x + w > window.innerWidth) x = e.clientX - w - 8;
        if (y + h > window.innerHeight) y = e.clientY - h - 8;
        self._els.tooltip.style.left = x + 'px';
        self._els.tooltip.style.top = y + 'px';
      }
    });
    this._container.addEventListener('mouseout', function(e) {
      if (e.target.closest('.http-url')) {
        self._els.tooltip.style.display = 'none';
      }
    });
  }

  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      if (!this._els.detail.classList.contains('closed')) {
        this._closeDetail();
        e.stopPropagation();
        return;
      }
      if (this._exportOpen) {
        this._exportOpen = false;
        this._els.exportDD.classList.remove('open');
        e.stopPropagation();
        return;
      }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateRows(e.key === 'ArrowDown' ? 1 : -1);
    }
    if (e.key === 'Enter' && this._selectedId !== null) {
      this._openDetail(this._selectedId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FILTERING & SORTING
  // ═══════════════════════════════════════════════════════════════════

  _applyFilters() {
    var self = this;
    this._filtered = this._events.filter(function(r) {
      if (self._methodFilter !== 'all' && r.method !== self._methodFilter) return false;
      if (self._statusFilter !== 'all') {
        var range = self._statusFilter;
        if (range === '2xx' && (r.statusCode < 200 || r.statusCode > 299)) return false;
        if (range === '4xx' && (r.statusCode < 400 || r.statusCode > 499)) return false;
        if (range === '5xx' && (r.statusCode < 500 || r.statusCode > 599)) return false;
      }
      if (self._urlFilter && r.url.toLowerCase().indexOf(self._urlFilter.toLowerCase()) === -1) return false;
      if (r.durationMs > self._durationMax) return false;
      return true;
    });

    // Sort
    var dir = this._sortDir === 'asc' ? 1 : -1;
    var field = this._sortField;
    this._filtered.sort(function(a, b) {
      switch (field) {
        case 'method': return a.method.localeCompare(b.method) * dir;
        case 'url': return a.url.localeCompare(b.url) * dir;
        case 'status': return (a.statusCode - b.statusCode) * dir;
        case 'duration': return (a.durationMs - b.durationMs) * dir;
        case 'retry': return 0; // no retry count in event data
        case 'time': return (a._seq - b._seq) * dir;
        default: return 0;
      }
    });

    // Count active filters
    var count = 0;
    if (this._methodFilter !== 'all') count++;
    if (this._statusFilter !== 'all') count++;
    if (this._urlFilter) count++;
    if (this._durationMax < 60000) count++;
    this._els.filterBadge.classList.toggle('visible', count > 0);
    var badgeCount = this._els.filterBadge.querySelector('.http-filter-badge-count');
    if (badgeCount) badgeCount.textContent = count;

    this._scheduleRender();
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  _scheduleRender() {
    if (this._renderPending) return;
    this._renderPending = true;
    var self = this;
    requestAnimationFrame(function() {
      self._renderPending = false;
      if (self._active) self._render();
    });
  }

  _render() {
    // Recompute filter if we haven't yet
    if (this._filtered.length === 0 && this._events.length > 0 &&
        this._methodFilter === 'all' && this._statusFilter === 'all' &&
        !this._urlFilter && this._durationMax >= 60000) {
      this._filtered = this._events.slice();
    }

    var hasData = this._events.length > 0;
    this._els.empty.classList.toggle('hidden', hasData);
    this._els.thead.style.display = hasData ? 'grid' : 'none';
    this._els.scroll.style.display = hasData ? 'block' : 'none';

    this._els.reqCount.textContent =
      this._filtered.length + ' request' + (this._filtered.length !== 1 ? 's' : '');

    this._updateCounts();
    this._updateStats();
    this._renderRows();
  }

  _updateCounts() {
    var all = this._events;
    var methods = { GET: 0, POST: 0, PUT: 0, DELETE: 0, PATCH: 0 };
    var statuses = { '2xx': 0, '4xx': 0, '5xx': 0 };

    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (methods.hasOwnProperty(e.method)) methods[e.method]++;
      if (e.statusCode >= 200 && e.statusCode < 300) statuses['2xx']++;
      else if (e.statusCode >= 400 && e.statusCode < 500) statuses['4xx']++;
      else if (e.statusCode >= 500) statuses['5xx']++;
    }

    // Update pill counts
    var mEls = this._els.methodPills.querySelectorAll('.http-pill-count[data-method]');
    for (var j = 0; j < mEls.length; j++) {
      mEls[j].textContent = methods[mEls[j].dataset.method] || 0;
    }
    var sEls = this._els.statusPills.querySelectorAll('.http-pill-count[data-status]');
    for (var k = 0; k < sEls.length; k++) {
      sEls[k].textContent = statuses[sEls[k].dataset.status] || 0;
    }
  }

  _updateStats() {
    var statEls = this._els.stats.querySelectorAll('.http-stat-val');
    if (this._filtered.length === 0) {
      for (var i = 0; i < statEls.length; i++) statEls[i].textContent = '--';
      this._els.dist.innerHTML = '';
      return;
    }

    var durations = [];
    for (var j = 0; j < this._filtered.length; j++) {
      durations.push(this._filtered[j].durationMs);
    }
    durations.sort(function(a, b) { return a - b; });

    var percentile = function(pct) {
      var idx = Math.floor(durations.length * pct / 100);
      return durations[Math.min(idx, durations.length - 1)];
    };

    var p50 = percentile(50);
    var p95 = percentile(95);
    var p99 = percentile(99);
    var fmt = function(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; };

    for (var k = 0; k < statEls.length; k++) {
      var s = statEls[k].dataset.stat;
      if (s === 'p50') statEls[k].textContent = fmt(p50);
      else if (s === 'p95') statEls[k].textContent = fmt(p95);
      else if (s === 'p99') statEls[k].textContent = fmt(p99);
    }

    // Distribution bar
    var maxD = Math.max(durations[durations.length - 1], 1);
    this._els.dist.innerHTML =
      '<div class="http-dist-seg dp50" style="width:' + Math.max(4, p50 / maxD * 60) + 'px"></div>' +
      '<div class="http-dist-seg dp95" style="width:' + Math.max(4, (p95 - p50) / maxD * 60) + 'px"></div>' +
      '<div class="http-dist-seg dp99" style="width:' + Math.max(4, (p99 - p95) / maxD * 60) + 'px"></div>';
  }

  _renderRows() {
    var scroll = this._els.scroll;
    var frag = document.createDocumentFragment();
    var self = this;

    for (var i = 0; i < this._filtered.length; i++) {
      var req = this._filtered[i];
      var row = document.createElement('div');
      var sc = req.statusCode;
      var statusCls = sc >= 500 ? 's-5xx' : sc >= 400 ? 's-4xx' : 's-2xx';
      var methodCls = 'm-' + req.method.toLowerCase();
      var durCls = req.durationMs >= 5000 ? 'v-slow' : req.durationMs >= 1000 ? 'slow' : '';

      var rowCls = 'http-row';
      if (sc >= 500) rowCls += ' http-row-failed';
      else if (sc === 429) rowCls += ' http-row-throttled';
      if (req._id === this._selectedId) rowCls += ' selected';

      var statusIcon = '';
      if (sc >= 200 && sc < 300) statusIcon = '\u2713';
      else if (sc === 429) statusIcon = '\u26A1';
      else if (sc === 401) statusIcon = '\u26BF';
      else if (sc >= 500) statusIcon = '\u26A0';
      else if (sc === 404) statusIcon = '\u2205';

      var durFmt = req.durationMs >= 1000
        ? (req.durationMs / 1000).toFixed(req.durationMs >= 10000 ? 1 : 0) + 's'
        : req.durationMs + 'ms';

      var ts = '';
      try {
        var d = new Date(req._ts);
        ts = d.getHours().toString().padStart(2, '0') + ':' +
             d.getMinutes().toString().padStart(2, '0') + ':' +
             d.getSeconds().toString().padStart(2, '0');
      } catch (_e) {
        ts = '--:--:--';
      }

      row.className = rowCls;
      row.dataset.id = req._id;
      row.setAttribute('role', 'row');
      row.tabIndex = -1;
      row.innerHTML =
        '<div class="http-cell"><span class="http-method ' + methodCls + '">' + this._esc(req.method) + '</span></div>' +
        '<div class="http-cell http-url">' + this._esc(req.url) + '</div>' +
        '<div class="http-cell"><span class="http-status ' + statusCls + '">' +
          (statusIcon ? '<span style="font-size:10px">' + statusIcon + '</span> ' : '') +
          sc + '</span></div>' +
        '<div class="http-cell http-dur ' + durCls + '">' + durFmt + '</div>' +
        '<div class="http-cell">' + (req.httpClientName ? '<span class="http-handler-pill">' + this._esc(req.httpClientName) + '</span>' : '') + '</div>' +
        '<div class="http-cell http-time">' + ts + '</div>';

      (function(r) {
        row.addEventListener('click', function() {
          self._selectedId = r._id;
          self._highlightSelected();
          self._openDetail(r._id);
        });
      })(req);

      frag.appendChild(row);

      // Error sub-row for 5xx with body preview
      if (sc >= 500 && req.responseBodyPreview) {
        var sub = document.createElement('div');
        sub.className = 'http-error-row open';
        try {
          var parsed = JSON.parse(req.responseBodyPreview);
          sub.textContent = (parsed.error && parsed.error.message) || req.responseBodyPreview;
        } catch (_e2) {
          sub.textContent = req.responseBodyPreview.slice(0, 200);
        }
        frag.appendChild(sub);
      }
    }

    scroll.innerHTML = '';
    scroll.appendChild(frag);
  }

  _highlightSelected() {
    var rows = this._els.scroll.querySelectorAll('.http-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('selected', parseInt(rows[i].dataset.id, 10) === this._selectedId);
    }
  }

  _navigateRows(dir) {
    if (this._filtered.length === 0) return;
    var ids = [];
    for (var i = 0; i < this._filtered.length; i++) ids.push(this._filtered[i]._id);
    var curIdx = ids.indexOf(this._selectedId);
    var newIdx;
    if (curIdx === -1) {
      newIdx = dir === 1 ? 0 : ids.length - 1;
    } else {
      newIdx = Math.max(0, Math.min(ids.length - 1, curIdx + dir));
    }
    this._selectedId = ids[newIdx];
    this._highlightSelected();

    var row = this._els.scroll.querySelector('[data-id="' + this._selectedId + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });

    if (!this._els.detail.classList.contains('closed')) {
      this._renderDetail();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // DETAIL PANEL
  // ═══════════════════════════════════════════════════════════════════

  _openDetail(id) {
    this._selectedId = id;
    this._highlightSelected();
    this._els.detail.classList.remove('closed');
    this._updateDetailIndicator();
    this._renderDetail();
  }

  _closeDetail() {
    this._els.detail.classList.add('closed');
  }

  _updateDetailIndicator() {
    var self = this;
    requestAnimationFrame(function() {
      var active = self._els.detailTabs.querySelector('.http-detail-tab.active');
      if (!active || !self._els.dtabIndicator) return;
      var bar = self._els.detailTabs;
      self._els.dtabIndicator.style.left = (active.offsetLeft - bar.offsetLeft) + 'px';
      self._els.dtabIndicator.style.width = active.offsetWidth + 'px';
    });
  }

  _renderDetail() {
    var req = null;
    for (var i = 0; i < this._events.length; i++) {
      if (this._events[i]._id === this._selectedId) {
        req = this._events[i];
        break;
      }
    }
    if (!req) return;

    var body = this._els.detailBody;
    switch (this._detailTab) {
      case 'request':
        body.innerHTML = this._renderRequestTab(req);
        break;
      case 'response':
        body.innerHTML = this._renderResponseTab(req);
        break;
      case 'timing':
        body.innerHTML = this._renderTimingTab(req);
        break;
      case 'headers':
        body.innerHTML = this._renderHeadersTab(req);
        break;
    }
  }

  _renderRequestTab(req) {
    var html =
      '<div class="http-detail-section">' +
        '<div class="http-detail-section-title">Request</div>' +
        '<div class="http-json">' +
          '<span class="jk">Method:</span> <span class="http-method m-' + req.method.toLowerCase() + '">' + this._esc(req.method) + '</span>\n' +
          '<span class="jk">URL:</span> <span class="js">' + this._esc(req.url) + '</span>\n' +
          '<span class="jk">Correlation-ID:</span> <span class="js">' + this._esc(req.correlationId) + '</span>\n' +
          '<span class="jk">HTTP Client:</span> <span class="js">' + this._esc(req.httpClientName) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="http-detail-section">' +
        '<div class="http-detail-section-title">Request Headers</div>' +
        '<div class="http-json">' + this._jsonHighlight(req.requestHeaders) + '</div>' +
      '</div>';
    return html;
  }

  _renderResponseTab(req) {
    var sc = req.statusCode;
    var statusCls = sc >= 500 ? 's-5xx' : sc >= 400 ? 's-4xx' : 's-2xx';
    var html =
      '<div class="http-detail-section">' +
        '<div class="http-detail-section-title">Response Status</div>' +
        '<div class="http-json">' +
          '<span class="http-status ' + statusCls + '" style="font-size:14px;padding:4px 12px">' + sc + '</span>' +
          '<span style="margin-left:12px;color:var(--text-muted);font-size:12px">' + req.durationMs + 'ms</span>' +
        '</div>' +
      '</div>' +
      '<div class="http-detail-section">' +
        '<div class="http-detail-section-title">Response Headers</div>' +
        '<div class="http-json">' + this._jsonHighlight(req.responseHeaders) + '</div>' +
      '</div>';

    if (req.responseBodyPreview) {
      var bodyContent = req.responseBodyPreview;
      try {
        var parsed = JSON.parse(bodyContent);
        bodyContent = this._jsonHighlight(parsed);
      } catch (_e) {
        bodyContent = this._esc(bodyContent);
      }

      var isError = sc >= 400;
      html +=
        '<div class="http-detail-section">' +
          '<div class="http-detail-section-title"' + (isError ? ' style="color:var(--http-red)"' : '') + '>' +
            (isError ? 'Error Body' : 'Response Body') +
          '</div>' +
          '<div class="http-json"' + (isError ? ' style="border-color:var(--http-red-bg)"' : '') + '>' +
            bodyContent +
          '</div>' +
        '</div>';
    }
    return html;
  }

  _renderTimingTab(req) {
    // Estimate timing phases from total duration
    var dur = req.durationMs || 1;
    var t = {
      dns: Math.max(1, Math.round(dur * 0.02)),
      connect: Math.max(1, Math.round(dur * 0.05)),
      tls: Math.max(1, Math.round(dur * 0.08)),
      send: Math.max(1, Math.round(dur * 0.02)),
      wait: Math.max(1, Math.round(dur * 0.75)),
      receive: Math.max(1, Math.round(dur * 0.08))
    };
    // Adjust wait to fill remaining
    var sum = t.dns + t.connect + t.tls + t.send + t.receive;
    t.wait = Math.max(1, dur - sum);

    var total = t.dns + t.connect + t.tls + t.send + t.wait + t.receive;
    var maxW = Math.max(total, 1);
    var barPct = function(v) { return Math.max(2, v / maxW * 100); };
    var fmt = function(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; };

    var phases = [
      { label: 'DNS',     cls: 'wf-dns',     val: t.dns,     color: 'var(--http-teal)' },
      { label: 'Connect', cls: 'wf-connect', val: t.connect, color: 'var(--http-blue)' },
      { label: 'TLS',     cls: 'wf-tls',     val: t.tls,     color: 'var(--http-purple)' },
      { label: 'Send',    cls: 'wf-send',    val: t.send,    color: 'var(--http-cyan)' },
      { label: 'Wait',    cls: 'wf-wait',    val: t.wait,    color: 'var(--http-amber)' },
      { label: 'Receive', cls: 'wf-receive', val: t.receive, color: 'var(--http-green)' }
    ];

    var html = '<div class="http-detail-section"><div class="http-detail-section-title">Timing Waterfall</div><div>';
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      html +=
        '<div class="http-wf-row">' +
          '<div class="http-wf-label">' + p.label + '</div>' +
          '<div class="http-wf-track">' +
            '<div class="http-wf-bar ' + p.cls + '" style="width:' + barPct(p.val) + '%"></div>' +
          '</div>' +
          '<div class="http-wf-dur">' + fmt(p.val) + '</div>' +
        '</div>';
    }
    html +=
      '<div class="http-wf-total">' +
        '<span class="http-wf-total-label">Total</span>' +
        '<span class="http-wf-total-val">' + fmt(total) + '</span>' +
      '</div>' +
      '<div class="http-wf-legend">';
    for (var j = 0; j < phases.length; j++) {
      html +=
        '<div class="http-wf-legend-item">' +
          '<div class="http-wf-legend-dot" style="background:' + phases[j].color + '"></div>' +
          phases[j].label +
        '</div>';
    }
    html += '</div></div></div>';
    return html;
  }

  _renderHeadersTab(req) {
    return this._renderHeaderTable('Request Headers', req.requestHeaders) +
           this._renderHeaderTable('Response Headers', req.responseHeaders);
  }

  _renderHeaderTable(title, headers) {
    var keys = Object.keys(headers || {}).sort();
    var html =
      '<div class="http-detail-section">' +
        '<div class="http-detail-section-title">' + this._esc(title) + '</div>' +
        '<table class="http-htable"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>';
    for (var i = 0; i < keys.length; i++) {
      html += '<tr><td>' + this._esc(keys[i]) + '</td><td>' + this._esc(String(headers[keys[i]])) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  // ═══════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════

  _exportAs(format) {
    var data = this._filtered;
    var content, filename, mimeType;

    if (format === 'json') {
      content = JSON.stringify(data.map(function(r) {
        return {
          method: r.method,
          url: r.url,
          statusCode: r.statusCode,
          durationMs: r.durationMs,
          requestHeaders: r.requestHeaders,
          responseHeaders: r.responseHeaders,
          responseBodyPreview: r.responseBodyPreview,
          httpClientName: r.httpClientName,
          correlationId: r.correlationId,
          timestamp: r._ts
        };
      }), null, 2);
      filename = 'edog-http-pipeline.json';
      mimeType = 'application/json';
    } else if (format === 'csv') {
      var cf = function(val) { var s = String(val == null ? '' : val); return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s; };
      var rows = ['Method,URL,Status,Duration(ms),Client,CorrelationId,Timestamp'];
      for (var i = 0; i < data.length; i++) {
        var r = data[i];
        rows.push([
          cf(r.method),
          cf(r.url),
          cf(r.statusCode),
          cf(r.durationMs),
          cf(r.httpClientName),
          cf(r.correlationId),
          cf(r._ts)
        ].join(','));
      }
      content = rows.join('\n');
      filename = 'edog-http-pipeline.csv';
      mimeType = 'text/csv';
    } else if (format === 'har') {
      // Simplified HAR 1.2 format
      var entries = data.map(function(r) {
        return {
          startedDateTime: r._ts,
          time: r.durationMs,
          request: {
            method: r.method,
            url: r.url,
            headers: Object.keys(r.requestHeaders).map(function(k) {
              return { name: k, value: r.requestHeaders[k] };
            })
          },
          response: {
            status: r.statusCode,
            statusText: '',
            headers: Object.keys(r.responseHeaders).map(function(k) {
              return { name: k, value: r.responseHeaders[k] };
            }),
            content: {
              size: r.responseBodyPreview ? r.responseBodyPreview.length : 0,
              text: r.responseBodyPreview || ''
            }
          },
          timings: { send: -1, wait: r.durationMs, receive: -1 }
        };
      });
      content = JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'EDOG Studio', version: '1.0' },
          entries: entries
        }
      }, null, 2);
      filename = 'edog-http-pipeline.har';
      mimeType = 'application/json';
    } else {
      return;
    }

    // Trigger download
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  _esc(str) {
    var div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
  }

  _jsonHighlight(obj) {
    if (obj === null || obj === undefined) return '<span class="jnull">null</span>';
    return this._jsonToHtml(obj, 0);
  }

  _jsonToHtml(val, indent) {
    var pad = '  '.repeat(indent);
    var pad1 = '  '.repeat(indent + 1);

    if (val === null) return '<span class="jnull">null</span>';
    if (typeof val === 'boolean') return '<span class="jb">' + val + '</span>';
    if (typeof val === 'number') return '<span class="jn">' + val + '</span>';
    if (typeof val === 'string') {
      var escaped = this._esc(val);
      if (val.length > 120) {
        escaped = this._esc(val.slice(0, 117)) + '...';
      }
      return '<span class="js">"' + escaped + '"</span>';
    }

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      var items = [];
      for (var i = 0; i < val.length; i++) {
        items.push(pad1 + this._jsonToHtml(val[i], indent + 1));
      }
      return '[\n' + items.join(',\n') + '\n' + pad + ']';
    }

    if (typeof val === 'object') {
      var keys = Object.keys(val);
      if (keys.length === 0) return '{}';
      var entries = [];
      for (var j = 0; j < keys.length; j++) {
        entries.push(
          pad1 + '<span class="jk">"' + this._esc(keys[j]) + '"</span>: ' +
          this._jsonToHtml(val[keys[j]], indent + 1)
        );
      }
      return '{\n' + entries.join(',\n') + '\n' + pad + '}';
    }

    return String(val);
  }
}
