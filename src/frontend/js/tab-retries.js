/**
 * RetriesTab — Retry & Throttling Monitor
 *
 * Visualizes retry chains, throttle countdowns, and capacity admission waits
 * streamed from the EdogRetryInterceptor via SignalR topic 'retry'.
 *
 * Architecture:
 *   constructor(containerEl, signalr) → activate() / deactivate()
 *   Events grouped into chains by iterationId, rendered as timeline cards.
 *
 * Event shape (from SIGNALR_PROTOCOL.md):
 *   { endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs,
 *     strategyName, reason, isThrottle, retryAfterMs, iterationId }
 *
 * Reference: f04-mock-08-retries.html
 */

class RetriesTab {

  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // ── State ──
    this._events = [];
    this._chains = new Map();
    this._maxEvents = 500;
    this._filter = 'all';
    this._searchText = '';
    this._selectedChainId = null;
    this._isActive = false;
    this._renderPending = false;
    this._countdowns = new Map();
    this._countdownIntervals = [];
    this._detailHeight = 280;

    // Stats tracking
    this._stats = { retries: 0, throttled: 0, capwaits: 0 };
    this._prevStats = { retries: 0, throttled: 0, capwaits: 0 };
    this._statsWindow = 5 * 60 * 1000;

    // ── DOM refs ──
    this._els = {};

    // ── Bound handlers ──
    this._onEvent = this._onEvent.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    this._buildDOM();
    this._bindEvents();
  }

  // ═══════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════

  activate() {
    this._isActive = true;
    if (this._signalr) {
      this._signalr.on('retry', this._onEvent);
      this._signalr.subscribeTopic('retry');
    }
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('click', this._onDocClick);
    this._render();
  }

  deactivate() {
    this._isActive = false;
    if (this._signalr) {
      this._signalr.off('retry', this._onEvent);
      this._signalr.unsubscribeTopic('retry');
    }
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('click', this._onDocClick);
    this._clearAllCountdowns();
  }

  // ═══════════════════════════════════════════
  //  DOM CONSTRUCTION
  // ═══════════════════════════════════════════

  _buildDOM() {
    const root = document.createElement('div');
    root.className = 'retries-root';

    // ── Summary bar ──
    root.appendChild(this._buildSummaryBar());

    // ── Toolbar ──
    root.appendChild(this._buildToolbar());

    // ── Content area ──
    const content = document.createElement('div');
    content.className = 'retries-content';

    // Empty state
    content.appendChild(this._buildEmptyState());

    // Scroll area
    const scroll = document.createElement('div');
    scroll.className = 'retries-scroll';
    scroll.setAttribute('role', 'list');
    scroll.setAttribute('aria-label', 'Retry events');
    this._els.scroll = scroll;
    content.appendChild(scroll);

    // Detail resize handle
    const resize = document.createElement('div');
    resize.className = 'retries-detail-resize';
    this._els.resize = resize;
    content.appendChild(resize);

    // Detail panel
    content.appendChild(this._buildDetailPanel());

    root.appendChild(content);

    // ── Footer ──
    root.appendChild(this._buildFooter());

    this._container.appendChild(root);
  }

  _buildSummaryBar() {
    const bar = document.createElement('div');
    bar.className = 'retries-summary';

    const statDefs = [
      { key: 'retries', cls: 'amber', label: 'retries', trend: 'trendRetries' },
      { key: 'throttled', cls: 'red', label: 'throttled', trend: 'trendThrottled' },
      { key: 'capwaits', cls: 'blue', label: 'capacity waits', trend: 'trendCapwaits' },
      { key: 'window', cls: 'muted', label: '', trend: null }
    ];

    statDefs.forEach(def => {
      const stat = document.createElement('div');
      stat.className = 'retries-stat ' + def.cls;

      const val = document.createElement('span');
      val.className = 'retries-stat-value';
      val.textContent = def.key === 'window' ? 'last 5 min' : '0';
      this._els['sum-' + def.key] = val;
      stat.appendChild(val);

      if (def.label) {
        const lbl = document.createElement('span');
        lbl.className = 'retries-stat-label';
        lbl.textContent = def.label;
        stat.appendChild(lbl);
      }

      if (def.trend) {
        const trend = document.createElement('span');
        trend.className = 'retries-stat-trend stable';
        trend.textContent = '\u2014';
        this._els[def.trend] = trend;
        stat.appendChild(trend);
      }

      bar.appendChild(stat);
    });

    this._els.summaryBar = bar;
    return bar;
  }

  _buildToolbar() {
    const tb = document.createElement('div');
    tb.className = 'retries-toolbar';

    // Search box
    const search = document.createElement('div');
    search.className = 'retries-search';
    search.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Filter events...';
    input.setAttribute('aria-label', 'Filter retry events');
    this._els.searchInput = input;
    search.appendChild(input);
    const clear = document.createElement('div');
    clear.className = 'retries-search-clear';
    clear.textContent = '\u2715';
    clear.title = 'Clear';
    this._els.searchClear = clear;
    search.appendChild(clear);
    tb.appendChild(search);

    // Separator
    tb.appendChild(this._sep());

    // Filter pills
    const pills = document.createElement('div');
    pills.className = 'retries-pills';
    const pillDefs = [
      { filter: 'all', label: 'All', cls: '', countKey: 'countAll' },
      { filter: 'retry', label: 'Retry', cls: 'fp-retry', countKey: 'countRetry' },
      { filter: 'throttle', label: 'Throttle', cls: 'fp-throttle', countKey: 'countThrottle' },
      { filter: 'capwait', label: 'Capacity Wait', cls: 'fp-capwait', countKey: 'countCapwait' }
    ];
    pillDefs.forEach((def, i) => {
      const pill = document.createElement('button');
      pill.className = 'retries-pill ' + def.cls + (i === 0 ? ' active' : '');
      pill.dataset.filter = def.filter;
      pill.setAttribute('role', 'radio');
      pill.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
      pill.textContent = def.label + ' ';
      const count = document.createElement('span');
      count.className = 'retries-pill-count';
      count.textContent = '0';
      this._els[def.countKey] = count;
      pill.appendChild(count);
      pills.appendChild(pill);
    });
    this._els.pills = pills;
    tb.appendChild(pills);

    // Separator
    tb.appendChild(this._sep());

    // Export dropdown
    const exportBtn = document.createElement('div');
    exportBtn.className = 'retries-export';
    exportBtn.setAttribute('role', 'button');
    exportBtn.setAttribute('aria-haspopup', 'true');
    exportBtn.innerHTML =
      '<span>Export</span><span class="retries-export-chevron">\u25BE</span>';
    const dd = document.createElement('div');
    dd.className = 'retries-export-dropdown';
    ['JSON', 'CSV', 'Clipboard'].forEach(fmt => {
      const item = document.createElement('div');
      item.className = 'retries-export-dd-item';
      item.dataset.format = fmt.toLowerCase();
      item.textContent = 'Export as ' + fmt;
      dd.appendChild(item);
    });
    this._els.exportDropdown = dd;
    exportBtn.appendChild(dd);
    this._els.exportBtn = exportBtn;
    tb.appendChild(exportBtn);

    // Spacer
    const spacer = document.createElement('div');
    spacer.className = 'retries-toolbar-spacer';
    tb.appendChild(spacer);

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'retries-toolbar-action';
    clearBtn.textContent = '\u2715 Clear';
    clearBtn.title = 'Clear all events';
    this._els.clearBtn = clearBtn;
    tb.appendChild(clearBtn);

    return tb;
  }

  _buildEmptyState() {
    const empty = document.createElement('div');
    empty.className = 'retries-empty';
    empty.innerHTML =
      '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">' +
      '<circle cx="24" cy="24" r="20"/>' +
      '<path d="M24 14v10l7 7"/>' +
      '<path d="M32 16l-3 3M16 32l3-3" stroke-dasharray="2 2"/></svg>' +
      '<div class="retries-empty-title">No retries or throttling events</div>' +
      '<div class="retries-empty-hint">Retry attempts, 429/430 responses, and capacity admission delays will appear here as the FLT service runs</div>';
    this._els.empty = empty;
    return empty;
  }

  _buildDetailPanel() {
    const panel = document.createElement('div');
    panel.className = 'retries-detail closed';
    panel.style.height = this._detailHeight + 'px';

    const header = document.createElement('div');
    header.className = 'retries-detail-header';

    const title = document.createElement('span');
    title.className = 'retries-detail-title';
    title.textContent = 'Event Detail';
    this._els.detailTitle = title;
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'retries-detail-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'retries-detail-btn';
    copyBtn.title = 'Copy JSON';
    copyBtn.textContent = '\u2398';
    this._els.detailCopy = copyBtn;
    actions.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'retries-detail-btn';
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '\u2715';
    this._els.detailClose = closeBtn;
    actions.appendChild(closeBtn);

    header.appendChild(actions);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'retries-detail-body';
    this._els.detailBody = body;
    panel.appendChild(body);

    this._els.detailPanel = panel;
    return panel;
  }

  _buildFooter() {
    const footer = document.createElement('div');
    footer.className = 'retries-footer';

    const left = [
      { keys: ['\u2191', '\u2193'], label: 'Navigate' },
      { keys: ['Enter'], label: 'Details' },
      { keys: ['Esc'], label: 'Close' }
    ];

    left.forEach((item, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'retries-footer-sep';
        footer.appendChild(sep);
      }
      const span = document.createElement('span');
      let html = '';
      item.keys.forEach(k => { html += '<kbd>' + k + '</kbd>'; });
      html += ' ' + item.label;
      span.innerHTML = html;
      footer.appendChild(span);
    });

    const right = document.createElement('span');
    right.className = 'retries-footer-right';
    right.textContent = '0 events';
    this._els.footerCount = right;
    footer.appendChild(right);

    return footer;
  }

  _sep() {
    const sep = document.createElement('div');
    sep.className = 'retries-toolbar-sep';
    return sep;
  }

  // ═══════════════════════════════════════════
  //  EVENT BINDING
  // ═══════════════════════════════════════════

  _bindEvents() {
    // Search
    this._els.searchInput.addEventListener('input', () => {
      this._searchText = this._els.searchInput.value.toLowerCase();
      this._els.searchClear.classList.toggle('visible', this._searchText.length > 0);
      this._scheduleRender();
    });

    this._els.searchClear.addEventListener('click', () => {
      this._els.searchInput.value = '';
      this._searchText = '';
      this._els.searchClear.classList.remove('visible');
      this._scheduleRender();
    });

    // Filter pills (event delegation)
    this._els.pills.addEventListener('click', (e) => {
      const pill = e.target.closest('.retries-pill');
      if (!pill) return;
      this._els.pills.querySelectorAll('.retries-pill').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-checked', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-checked', 'true');
      this._filter = pill.dataset.filter;
      this._scheduleRender();
    });

    // Export dropdown
    this._els.exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = this._els.exportDropdown;
      const isOpen = dd.classList.contains('open');
      dd.classList.toggle('open', !isOpen);
      this._els.exportBtn.classList.toggle('open', !isOpen);
    });

    this._els.exportDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.retries-export-dd-item');
      if (!item) return;
      e.stopPropagation();
      this._els.exportDropdown.classList.remove('open');
      this._els.exportBtn.classList.remove('open');
      this._handleExport(item.dataset.format);
    });

    // Close dropdown on outside click — registered in activate(), removed in deactivate()
    this._onDocClick = () => {
      if (!this._isActive) return;
      this._els.exportDropdown.classList.remove('open');
      this._els.exportBtn.classList.remove('open');
    };

    // Detail panel close
    this._els.detailClose.addEventListener('click', () => this._closeDetail());

    // Detail copy
    this._els.detailCopy.addEventListener('click', () => {
      if (!this._selectedChainId) return;
      const chain = this._chains.get(this._selectedChainId);
      if (chain) {
        const json = JSON.stringify(chain, null, 2);
        navigator.clipboard.writeText(json).catch(() => {});
      }
    });

    // Detail panel resize
    this._bindDetailResize();

    // Scroll area click delegation
    this._els.scroll.addEventListener('click', (e) => {
      const card = e.target.closest('.retries-card');
      if (!card) return;
      const chainId = card.dataset.chain;
      if (!chainId) return;

      this._els.scroll.querySelectorAll('.retries-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      this._selectedChainId = chainId;
      this._openDetail(chainId);
    });

    // Clear button
    this._els.clearBtn.addEventListener('click', () => {
      this._events = [];
      this._chains.clear();
      this._clearAllCountdowns();
      this._selectedChainId = null;
      this._closeDetail();
      this._render();
    });
  }

  _bindDetailResize() {
    const resize = this._els.resize;
    let resizing = false;
    let startY = 0;
    let startH = 0;

    resize.addEventListener('mousedown', (e) => {
      resizing = true;
      startY = e.clientY;
      startH = this._els.detailPanel.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const newH = Math.max(120, Math.min(500, startH - (e.clientY - startY)));
      this._els.detailPanel.style.height = newH + 'px';
      this._detailHeight = newH;
    });

    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // ═══════════════════════════════════════════
  //  SIGNALR EVENT HANDLER
  // ═══════════════════════════════════════════

  _onEvent(envelope) {
    const data = envelope.data || envelope;
    const event = {
      endpoint: data.endpoint || '',
      statusCode: data.statusCode || 0,
      retryAttempt: data.retryAttempt || 1,
      totalAttempts: data.totalAttempts || 1,
      waitDurationMs: data.waitDurationMs || 0,
      strategyName: data.strategyName || '',
      reason: data.reason || '',
      isThrottle: !!data.isThrottle,
      retryAfterMs: data.retryAfterMs || 0,
      iterationId: data.iterationId || '',
      _ts: envelope.timestamp || new Date().toISOString(),
      _seq: envelope.sequenceId || this._events.length
    };

    // Ring buffer
    this._events.push(event);
    while (this._events.length > this._maxEvents) {
      const removed = this._events.shift();
      this._removeFromChainIfOrphaned(removed);
    }

    // Group into chain
    this._addToChain(event);

    this._scheduleRender();
  }

  // ═══════════════════════════════════════════
  //  CHAIN MANAGEMENT
  // ═══════════════════════════════════════════

  _chainKey(event) {
    if (event.iterationId) return event.iterationId;
    // Fallback: endpoint + timestamp bucket (events within 120s)
    const ts = new Date(event._ts).getTime();
    const bucket = Math.floor(ts / 120000);
    return event.endpoint + ':' + bucket;
  }

  _classifyType(event) {
    if (event.statusCode === 430) return 'capwait';
    if (event.isThrottle) return 'throttle';
    return 'retry';
  }

  _addToChain(event) {
    const key = this._chainKey(event);
    let chain = this._chains.get(key);

    if (!chain) {
      chain = {
        id: key,
        type: this._classifyType(event),
        endpoint: event.endpoint,
        strategyName: event.strategyName,
        reason: event.reason,
        totalAttempts: event.totalAttempts,
        attempts: [],
        outcome: 'pending',
        startTime: event._ts,
        lastTime: event._ts,
        iterationId: event.iterationId
      };
      this._chains.set(key, chain);
    }

    // Avoid duplicates (same retryAttempt)
    const exists = chain.attempts.find(a => a.retryAttempt === event.retryAttempt);
    if (!exists) {
      chain.attempts.push({
        retryAttempt: event.retryAttempt,
        statusCode: event.statusCode,
        waitDurationMs: event.waitDurationMs,
        retryAfterMs: event.retryAfterMs,
        isThrottle: event.isThrottle,
        reason: event.reason,
        timestamp: event._ts
      });
      chain.attempts.sort((a, b) => a.retryAttempt - b.retryAttempt);
    }

    chain.lastTime = event._ts;
    chain.totalAttempts = Math.max(chain.totalAttempts, event.totalAttempts);

    // Determine outcome
    const lastAttempt = chain.attempts[chain.attempts.length - 1];
    if (lastAttempt.statusCode >= 200 && lastAttempt.statusCode < 300) {
      chain.outcome = 'success';
      this._clearCountdown(key);
    } else if (chain.attempts.length >= chain.totalAttempts && chain.totalAttempts > 0) {
      chain.outcome = 'failed';
      this._clearCountdown(key);
    } else {
      chain.outcome = 'pending';
    }

    // Start countdown if there's a wait
    if (chain.outcome === 'pending' && event.waitDurationMs > 0) {
      this._startCountdown(key, event.waitDurationMs, event.retryAfterMs, event.endpoint);
    }
  }

  _removeFromChainIfOrphaned(event) {
    const key = this._chainKey(event);
    const chain = this._chains.get(key);
    if (!chain) return;
    // Only remove chain if no events reference it anymore
    const hasEvents = this._events.some(e => this._chainKey(e) === key);
    if (!hasEvents) {
      this._chains.delete(key);
      this._clearCountdown(key);
    }
  }

  // ═══════════════════════════════════════════
  //  COUNTDOWN MANAGEMENT
  // ═══════════════════════════════════════════

  _startCountdown(chainId, waitMs, retryAfterMs, endpoint) {
    this._clearCountdown(chainId);

    const total = (retryAfterMs > 0 ? retryAfterMs : waitMs) / 1000;
    const cd = {
      chainId: chainId,
      total: total,
      remaining: total,
      endpoint: endpoint,
      startTime: Date.now()
    };
    this._countdowns.set(chainId, cd);

    const intervalId = setInterval(() => {
      const elapsed = (Date.now() - cd.startTime) / 1000;
      cd.remaining = Math.max(0, total - elapsed);

      // Update DOM elements directly for perf (no full re-render)
      const label = document.getElementById('retries-cd-time-' + this._safeDomId(chainId));
      const bar = document.getElementById('retries-cd-bar-' + this._safeDomId(chainId));
      if (label) label.textContent = cd.remaining.toFixed(1) + 's remaining';
      if (bar) bar.style.width = ((cd.remaining / total) * 100).toFixed(1) + '%';

      if (cd.remaining <= 0) {
        clearInterval(intervalId);
        this._countdowns.delete(chainId);
        this._scheduleRender();
      }
    }, 100);

    // Store intervalId in countdown entry so _clearCountdown can clear it
    cd.intervalId = intervalId;
  }

  _clearCountdown(chainId) {
    const cd = this._countdowns.get(chainId);
    if (cd && cd.intervalId) clearInterval(cd.intervalId);
    this._countdowns.delete(chainId);
  }

  _clearAllCountdowns() {
    for (const cd of this._countdowns.values()) {
      if (cd.intervalId) clearInterval(cd.intervalId);
    }
    this._countdownIntervals.forEach(id => clearInterval(id));
    this._countdownIntervals = [];
    this._countdowns.clear();
  }

  _safeDomId(str) {
    return String(str).replace(/[^a-zA-Z0-9-_]/g, '_');
  }

  // ═══════════════════════════════════════════
  //  RENDERING
  // ═══════════════════════════════════════════

  _scheduleRender() {
    if (this._renderPending) return;
    this._renderPending = true;
    requestAnimationFrame(() => {
      this._renderPending = false;
      if (this._isActive) this._render();
    });
  }

  _render() {
    this._updateStats();
    this._renderSummary();

    const chains = this._getFilteredChains();
    this._renderCards(chains);
    this._renderFooter(chains);

    // Empty state
    this._els.empty.classList.toggle('hidden', chains.length > 0);
  }

  _getFilteredChains() {
    let chains = Array.from(this._chains.values());

    // Type filter
    if (this._filter !== 'all') {
      chains = chains.filter(c => c.type === this._filter);
    }

    // Text search
    if (this._searchText) {
      const q = this._searchText;
      chains = chains.filter(c =>
        c.endpoint.toLowerCase().includes(q) ||
        c.reason.toLowerCase().includes(q) ||
        c.strategyName.toLowerCase().includes(q) ||
        c.iterationId.toLowerCase().includes(q)
      );
    }

    // Sort by last event time, newest first
    chains.sort((a, b) => {
      const tA = new Date(b.lastTime).getTime();
      const tB = new Date(a.lastTime).getTime();
      return tA - tB;
    });

    return chains;
  }

  _updateStats() {
    this._prevStats = { ...this._stats };
    const now = Date.now();
    const windowStart = now - this._statsWindow;

    let retries = 0;
    let throttled = 0;
    let capwaits = 0;

    for (const chain of this._chains.values()) {
      const ts = new Date(chain.lastTime).getTime();
      if (ts < windowStart) continue;
      if (chain.type === 'retry') retries++;
      else if (chain.type === 'throttle') throttled++;
      else if (chain.type === 'capwait') capwaits++;
    }

    this._stats = { retries, throttled, capwaits };
  }

  _renderSummary() {
    this._els['sum-retries'].textContent = String(this._stats.retries);
    this._els['sum-throttled'].textContent = String(this._stats.throttled);
    this._els['sum-capwaits'].textContent = String(this._stats.capwaits);

    this._renderTrend('trendRetries', this._stats.retries, this._prevStats.retries);
    this._renderTrend('trendThrottled', this._stats.throttled, this._prevStats.throttled);
    this._renderTrend('trendCapwaits', this._stats.capwaits, this._prevStats.capwaits);

    // Pill counts
    const all = this._chains.size;
    const retries = Array.from(this._chains.values()).filter(c => c.type === 'retry').length;
    const throttles = Array.from(this._chains.values()).filter(c => c.type === 'throttle').length;
    const capwaits = Array.from(this._chains.values()).filter(c => c.type === 'capwait').length;

    this._els.countAll.textContent = String(all);
    this._els.countRetry.textContent = String(retries);
    this._els.countThrottle.textContent = String(throttles);
    this._els.countCapwait.textContent = String(capwaits);
  }

  _renderTrend(elKey, current, prev) {
    const el = this._els[elKey];
    if (!el) return;
    if (current > prev) {
      el.className = 'retries-stat-trend up';
      el.textContent = '\u25B2';
    } else if (current < prev) {
      el.className = 'retries-stat-trend down';
      el.textContent = '\u25BC';
    } else {
      el.className = 'retries-stat-trend stable';
      el.textContent = '\u2014';
    }
  }

  _renderCards(chains) {
    const scroll = this._els.scroll;
    const frag = document.createDocumentFragment();

    chains.forEach((chain, idx) => {
      const card = this._buildCard(chain, idx);
      frag.appendChild(card);
    });

    scroll.innerHTML = '';
    scroll.appendChild(frag);

    // Re-select
    if (this._selectedChainId) {
      const sel = scroll.querySelector('[data-chain="' + this._selectedChainId + '"]');
      if (sel) sel.classList.add('selected');
    }
  }

  _buildCard(chain, index) {
    const card = document.createElement('div');
    card.className = 'retries-card';
    card.dataset.chain = chain.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.style.animationDelay = Math.min(index * 30, 300) + 'ms';

    // Outcome class
    if (chain.outcome === 'success') card.classList.add('outcome-success');
    else if (chain.outcome === 'failed') card.classList.add('outcome-failed');

    // Active throttle
    const cd = this._countdowns.get(chain.id);
    if (cd && cd.remaining > 0) card.classList.add('active-throttle');

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'retries-card-header';

    // Type badge
    header.appendChild(this._badge(chain.type));

    // Outcome badge
    if (chain.outcome === 'success') {
      header.appendChild(this._makeBadge('\u2713 Success', 'success'));
    } else if (chain.outcome === 'failed') {
      header.appendChild(this._makeBadge('\u2717 Failed', 'failed'));
    } else if (cd && cd.remaining > 0) {
      header.appendChild(this._makeBadge('Waiting...', 'pending'));
    }

    // Title
    const title = document.createElement('span');
    title.className = 'retries-card-title';
    title.textContent = this._chainTitle(chain);
    header.appendChild(title);

    // Time
    const time = document.createElement('span');
    time.className = 'retries-card-time';
    time.textContent = this._formatTimestamp(chain.startTime);
    header.appendChild(time);

    card.appendChild(header);

    // ── Meta ──
    const meta = document.createElement('div');
    meta.className = 'retries-card-meta';
    const metaParts = [
      this._shortEndpoint(chain.endpoint),
      chain.reason,
      chain.attempts.length + ' attempt' + (chain.attempts.length !== 1 ? 's' : ''),
      this._chainDuration(chain)
    ];
    if (chain.strategyName) metaParts.push(chain.strategyName);

    metaParts.forEach((text, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'retries-meta-sep';
        sep.textContent = '\u2502';
        meta.appendChild(sep);
      }
      const span = document.createElement('span');
      span.textContent = text;
      if (i === metaParts.length - 1 && chain.strategyName) {
        span.className = 'retries-strategy-tag';
      }
      meta.appendChild(span);
    });
    card.appendChild(meta);

    // ── Chain Timeline ──
    if (chain.attempts.length > 0) {
      card.appendChild(this._buildChainTimeline(chain));
    }

    // ── Active Countdown ──
    if (cd && cd.remaining > 0) {
      card.appendChild(this._buildCountdown(cd));
    }

    return card;
  }

  _badge(type) {
    const icons = { retry: '\u21BB', throttle: '\u26A1', capwait: '\u23F3' };
    const labels = { retry: 'Retry', throttle: 'Throttled', capwait: 'Capacity Wait' };
    return this._makeBadge((icons[type] || '') + ' ' + (labels[type] || type), type);
  }

  _makeBadge(text, cls) {
    const badge = document.createElement('span');
    badge.className = 'retries-badge ' + cls;
    badge.textContent = text;
    return badge;
  }

  _buildChainTimeline(chain) {
    const wrap = document.createElement('div');
    wrap.className = 'retries-chain';
    const track = document.createElement('div');
    track.className = 'retries-chain-track';

    chain.attempts.forEach((attempt, i) => {
      // Node
      const node = document.createElement('div');
      node.className = 'retries-chain-node';

      const dot = document.createElement('div');
      const dotCls = this._dotClass(attempt.statusCode, i === chain.attempts.length - 1 && chain.outcome !== 'pending');
      dot.className = 'retries-chain-dot ' + dotCls;
      if (attempt.statusCode >= 200 && attempt.statusCode < 300) {
        dot.textContent = '\u2713';
      } else if (attempt.statusCode >= 500) {
        dot.textContent = '!';
      }
      node.appendChild(dot);

      const status = document.createElement('div');
      const sClass = (attempt.statusCode >= 200 && attempt.statusCode < 300) ? 's-success'
        : (i === chain.attempts.length - 1 && chain.outcome === 'failed') ? 's-fail'
        : 's-pending';
      status.className = 'retries-chain-status ' + sClass;
      status.textContent = String(attempt.statusCode);
      node.appendChild(status);

      const label = document.createElement('div');
      label.className = 'retries-chain-label';
      label.textContent = '#' + attempt.retryAttempt;
      node.appendChild(label);

      track.appendChild(node);

      // Connecting bar (except after last node)
      if (i < chain.attempts.length - 1) {
        const bar = document.createElement('div');
        bar.className = 'retries-chain-bar';
        const inner = document.createElement('div');
        inner.className = 'retries-chain-bar-inner';
        inner.style.width = '100%';
        bar.appendChild(inner);

        if (attempt.waitDurationMs > 0) {
          const wait = document.createElement('div');
          wait.className = 'retries-chain-wait';
          wait.textContent = (attempt.waitDurationMs / 1000).toFixed(0) + 's';
          bar.appendChild(wait);
        }
        track.appendChild(bar);
      }
    });

    // Pending node if chain not complete
    if (chain.outcome === 'pending' && chain.attempts.length < chain.totalAttempts) {
      const bar = document.createElement('div');
      bar.className = 'retries-chain-bar';
      const inner = document.createElement('div');
      inner.className = 'retries-chain-bar-inner';
      inner.style.width = '100%';
      bar.appendChild(inner);
      track.appendChild(bar);

      const node = document.createElement('div');
      node.className = 'retries-chain-node';
      const dot = document.createElement('div');
      dot.className = 'retries-chain-dot c-pending';
      dot.textContent = '\u22EF';
      node.appendChild(dot);
      const status = document.createElement('div');
      status.className = 'retries-chain-status s-pending';
      status.textContent = '?';
      node.appendChild(status);
      const label = document.createElement('div');
      label.className = 'retries-chain-label';
      label.textContent = '#' + (chain.attempts.length + 1);
      node.appendChild(label);
      track.appendChild(node);
    }

    wrap.appendChild(track);

    // Outcome label
    const outcome = document.createElement('div');
    if (chain.outcome === 'success') {
      outcome.className = 'retries-chain-outcome success';
      outcome.textContent = '\u2713 Succeeded after ' + chain.attempts.length + ' attempt' + (chain.attempts.length !== 1 ? 's' : '');
    } else if (chain.outcome === 'failed') {
      outcome.className = 'retries-chain-outcome failed';
      const last = chain.attempts[chain.attempts.length - 1];
      outcome.textContent = '\u2717 Failed \u2014 retries exhausted (final: ' + (last ? last.statusCode : '?') + ')';
    } else {
      outcome.className = 'retries-chain-outcome pending';
      outcome.textContent = '\u22EF In progress \u2014 ' + chain.attempts.length + '/' + chain.totalAttempts + ' attempts';
    }
    wrap.appendChild(outcome);

    return wrap;
  }

  _dotClass(statusCode, isFinal) {
    if (statusCode >= 200 && statusCode < 300) return 'c-2xx';
    if (isFinal) return 'c-fail';
    if (statusCode === 429) return 'c-429';
    if (statusCode === 430) return 'c-430';
    if (statusCode === 401) return 'c-401';
    if (statusCode >= 500) return 'c-500';
    return 'c-500';
  }

  _buildCountdown(cd) {
    const wrap = document.createElement('div');
    wrap.className = 'retries-countdown';

    const header = document.createElement('div');
    header.className = 'retries-countdown-header';

    const label = document.createElement('span');
    label.className = 'retries-countdown-label';
    label.textContent = '\u26A1 Waiting for retry window';
    header.appendChild(label);

    const remaining = document.createElement('span');
    remaining.className = 'retries-countdown-remaining';
    remaining.id = 'retries-cd-time-' + this._safeDomId(cd.chainId);
    remaining.textContent = cd.remaining.toFixed(1) + 's remaining';
    header.appendChild(remaining);

    wrap.appendChild(header);

    const track = document.createElement('div');
    track.className = 'retries-countdown-track';
    const fill = document.createElement('div');
    fill.className = 'retries-countdown-fill';
    fill.id = 'retries-cd-bar-' + this._safeDomId(cd.chainId);
    fill.style.width = ((cd.remaining / cd.total) * 100).toFixed(1) + '%';
    track.appendChild(fill);
    wrap.appendChild(track);

    return wrap;
  }

  _renderFooter(chains) {
    this._els.footerCount.textContent = chains.length + ' event' + (chains.length !== 1 ? 's' : '');
  }

  // ═══════════════════════════════════════════
  //  DETAIL PANEL
  // ═══════════════════════════════════════════

  _openDetail(chainId) {
    const chain = this._chains.get(chainId);
    if (!chain) return;

    this._selectedChainId = chainId;
    this._els.detailPanel.classList.remove('closed');
    this._els.detailTitle.textContent = this._chainTitle(chain);

    const body = this._els.detailBody;
    body.innerHTML = '';

    // Request context
    body.appendChild(this._detailSection('Request Context', this._renderJson({
      endpoint: chain.endpoint,
      type: chain.type,
      strategy: chain.strategyName,
      iterationId: chain.iterationId,
      reason: chain.reason,
      outcome: chain.outcome,
      totalDuration: this._chainDuration(chain)
    })));

    // Retry chain timeline table
    if (chain.attempts.length > 0) {
      body.appendChild(this._detailSection('Retry Chain Timeline', this._buildDetailTimeline(chain)));
    }

    // Outcome
    const outcomeEl = document.createElement('div');
    outcomeEl.className = 'retries-detail-card';
    if (chain.outcome === 'success') {
      outcomeEl.innerHTML = '<span style="color:var(--status-succeeded);font-weight:600">' +
        '\u2713 Succeeded after ' + chain.attempts.length + ' attempts in ' +
        this._chainDuration(chain) + '</span>';
    } else if (chain.outcome === 'failed') {
      const last = chain.attempts[chain.attempts.length - 1];
      outcomeEl.innerHTML = '<span style="color:var(--level-error);font-weight:600">' +
        '\u2717 Failed \u2014 retries exhausted (final: ' + (last ? last.statusCode : '?') + ')</span>';
    } else {
      outcomeEl.innerHTML = '<span style="color:var(--comp-retry);font-weight:600">' +
        '\u22EF In progress \u2014 waiting for next attempt</span>';
    }
    body.appendChild(this._detailSection('Outcome', outcomeEl));

    // Throttle pressure estimate
    body.appendChild(this._detailSection('Throttle Pressure', this._buildRateGrid(chain)));

    // Focus close button for accessibility
    this._els.detailClose.focus();
  }

  _closeDetail() {
    this._els.detailPanel.classList.add('closed');
    this._selectedChainId = null;
    this._els.scroll.querySelectorAll('.retries-card').forEach(c => c.classList.remove('selected'));
  }

  _detailSection(title, contentEl) {
    const section = document.createElement('div');
    section.className = 'retries-detail-section';
    const heading = document.createElement('div');
    heading.className = 'retries-detail-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    if (typeof contentEl === 'string') {
      const card = document.createElement('div');
      card.className = 'retries-detail-card';
      card.innerHTML = contentEl;
      section.appendChild(card);
    } else {
      section.appendChild(contentEl);
    }
    return section;
  }

  _buildDetailTimeline(chain) {
    const table = document.createElement('div');
    table.className = 'retries-detail-timeline';

    // Header
    const headerRow = document.createElement('div');
    headerRow.className = 'retries-dt-row retries-dt-header';
    ['Attempt', '', 'Endpoint', 'Status', 'Wait'].forEach(txt => {
      const cell = document.createElement('span');
      cell.textContent = txt;
      headerRow.appendChild(cell);
    });
    table.appendChild(headerRow);

    chain.attempts.forEach((attempt, i) => {
      const row = document.createElement('div');
      row.className = 'retries-dt-row';

      const attemptCell = document.createElement('span');
      attemptCell.className = 'retries-dt-attempt';
      attemptCell.textContent = '#' + attempt.retryAttempt + ' \u2014 ' + attempt.statusCode;
      row.appendChild(attemptCell);

      const dotCell = document.createElement('span');
      dotCell.className = 'retries-dt-dot';
      dotCell.style.background = this._statusColor(attempt.statusCode);
      row.appendChild(dotCell);

      const epCell = document.createElement('span');
      epCell.className = 'retries-dt-endpoint';
      epCell.textContent = this._shortEndpoint(chain.endpoint);
      epCell.title = chain.endpoint;
      row.appendChild(epCell);

      const statusCell = document.createElement('span');
      statusCell.className = 'retries-dt-latency';
      statusCell.textContent = attempt.statusCode >= 200 && attempt.statusCode < 300
        ? 'OK' : attempt.reason || String(attempt.statusCode);
      row.appendChild(statusCell);

      const waitCell = document.createElement('span');
      waitCell.className = 'retries-dt-wait';
      waitCell.textContent = attempt.waitDurationMs > 0
        ? (attempt.waitDurationMs / 1000).toFixed(1) + 's'
        : '\u2014';
      row.appendChild(waitCell);

      table.appendChild(row);

      // Wait row between attempts
      if (i < chain.attempts.length - 1 && attempt.waitDurationMs > 0) {
        const waitRow = document.createElement('div');
        waitRow.className = 'retries-dt-row';
        waitRow.style.opacity = '0.6';
        const wLabel = document.createElement('span');
        wLabel.style.color = 'var(--text-muted)';
        wLabel.style.fontSize = '11px';
        wLabel.textContent = 'Wait';
        waitRow.appendChild(wLabel);
        waitRow.appendChild(document.createElement('span'));
        const wDesc = document.createElement('span');
        wDesc.style.fontSize = '11px';
        wDesc.style.color = 'var(--text-muted)';
        wDesc.textContent = 'Backoff: ' + (attempt.waitDurationMs / 1000).toFixed(0) + 's' +
          (attempt.retryAfterMs > 0 ? ' (Retry-After: ' + (attempt.retryAfterMs / 1000).toFixed(0) + 's)' : '');
        waitRow.appendChild(wDesc);
        waitRow.appendChild(document.createElement('span'));
        waitRow.appendChild(document.createElement('span'));
        table.appendChild(waitRow);
      }
    });

    return table;
  }

  _buildRateGrid(chain) {
    const grid = document.createElement('div');
    grid.className = 'retries-rate-grid';

    // Compute pressure from chain data
    const throttleCount = chain.attempts.filter(a => a.isThrottle).length;
    const totalWaitMs = chain.attempts.reduce((s, a) => s + (a.waitDurationMs || 0), 0);
    const maxWaitMs = Math.max(...chain.attempts.map(a => a.waitDurationMs || 0), 1);

    const cells = [
      {
        label: 'Throttle Rate',
        value: chain.attempts.length > 0
          ? Math.round((throttleCount / chain.attempts.length) * 100) + '%'
          : '0%',
        pct: chain.attempts.length > 0 ? (throttleCount / chain.attempts.length) * 100 : 0,
        sub: throttleCount + ' / ' + chain.attempts.length + ' attempts',
        color: throttleCount > 0 ? 'var(--level-error)' : 'var(--status-succeeded)'
      },
      {
        label: 'Total Wait',
        value: this._formatMs(totalWaitMs),
        pct: Math.min(100, (totalWaitMs / 60000) * 100),
        sub: 'across ' + chain.attempts.length + ' attempts',
        color: totalWaitMs > 30000 ? 'var(--level-error)' : totalWaitMs > 10000 ? 'var(--comp-retry)' : 'var(--status-succeeded)'
      },
      {
        label: 'Max Backoff',
        value: this._formatMs(maxWaitMs),
        pct: Math.min(100, (maxWaitMs / 30000) * 100),
        sub: 'longest single wait',
        color: maxWaitMs > 20000 ? 'var(--level-error)' : maxWaitMs > 5000 ? 'var(--comp-retry)' : 'var(--status-succeeded)'
      }
    ];

    cells.forEach(def => {
      const cell = document.createElement('div');
      cell.className = 'retries-rate-cell';

      const label = document.createElement('div');
      label.className = 'retries-rate-label';
      label.textContent = def.label;
      cell.appendChild(label);

      const value = document.createElement('div');
      value.className = 'retries-rate-value';
      value.style.color = def.color;
      value.textContent = def.value;
      cell.appendChild(value);

      const sub = document.createElement('div');
      sub.className = 'retries-rate-sub';
      sub.textContent = def.sub;
      cell.appendChild(sub);

      const track = document.createElement('div');
      track.className = 'retries-rate-track';
      const fill = document.createElement('div');
      fill.className = 'retries-rate-fill';
      fill.style.width = def.pct.toFixed(0) + '%';
      fill.style.background = def.color;
      track.appendChild(fill);
      cell.appendChild(track);

      grid.appendChild(cell);
    });

    return grid;
  }

  // ═══════════════════════════════════════════
  //  KEYBOARD NAVIGATION
  // ═══════════════════════════════════════════

  _onKeyDown(e) {
    if (!this._isActive) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      this._closeDetail();
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateCards(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.key === 'Enter' && this._selectedChainId) {
      this._openDetail(this._selectedChainId);
      return;
    }
  }

  _navigateCards(dir) {
    const cards = Array.from(this._els.scroll.querySelectorAll('.retries-card'));
    if (!cards.length) return;
    const ids = cards.map(c => c.dataset.chain);
    const curIdx = this._selectedChainId ? ids.indexOf(this._selectedChainId) : -1;
    let newIdx = curIdx + dir;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= ids.length) newIdx = ids.length - 1;

    cards.forEach(c => c.classList.remove('selected'));
    cards[newIdx].classList.add('selected');
    cards[newIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this._selectedChainId = ids[newIdx];
  }

  // ═══════════════════════════════════════════
  //  EXPORT
  // ═══════════════════════════════════════════

  _handleExport(format) {
    const chains = this._getFilteredChains();
    if (format === 'json') {
      const json = JSON.stringify(chains, null, 2);
      this._downloadBlob(json, 'retries-export.json', 'application/json');
    } else if (format === 'csv') {
      const csv = this._chainsToCSV(chains);
      this._downloadBlob(csv, 'retries-export.csv', 'text/csv');
    } else if (format === 'clipboard') {
      const json = JSON.stringify(chains, null, 2);
      navigator.clipboard.writeText(json).catch(() => {});
    }
  }

  _chainsToCSV(chains) {
    const cf = (val) => { const s = String(val == null ? '' : val); return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const headers = ['id', 'type', 'endpoint', 'strategy', 'attempts', 'outcome', 'reason', 'startTime'];
    const rows = chains.map(c => [
      cf(c.id),
      cf(c.type),
      cf(c.endpoint),
      cf(c.strategyName),
      cf(c.attempts.length),
      cf(c.outcome),
      cf(c.reason),
      cf(c.startTime)
    ]);
    return headers.join(',') + '\n' + rows.map(r => r.join(',')).join('\n');
  }

  _downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════

  _chainTitle(chain) {
    const parts = chain.endpoint.split('/');
    const last = parts[parts.length - 1] || parts[parts.length - 2] || chain.endpoint;
    const typeLabels = { retry: 'retry chain', throttle: 'throttled', capwait: 'capacity wait' };
    return last + ' ' + (typeLabels[chain.type] || 'retry');
  }

  _shortEndpoint(ep) {
    if (!ep) return '';
    // Strip protocol and host, keep path
    try {
      const url = new URL(ep);
      return url.pathname;
    } catch (_) {
      return ep.length > 60 ? ep.substring(0, 60) + '\u2026' : ep;
    }
  }

  _chainDuration(chain) {
    if (chain.attempts.length < 2) return '\u2014';
    const first = new Date(chain.attempts[0].timestamp || chain.startTime).getTime();
    const last = new Date(chain.attempts[chain.attempts.length - 1].timestamp || chain.lastTime).getTime();
    const totalWait = chain.attempts.reduce((s, a) => s + (a.waitDurationMs || 0), 0);
    const dur = Math.max(last - first, totalWait);
    return this._formatMs(dur);
  }

  _formatMs(ms) {
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const min = Math.floor(ms / 60000);
    const sec = Math.round((ms % 60000) / 1000);
    return min + 'm ' + sec + 's';
  }

  _formatTimestamp(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return h + ':' + m + ':' + s + '.' + ms;
    } catch (_) {
      return String(ts);
    }
  }

  _statusColor(code) {
    if (code >= 200 && code < 300) return 'var(--status-succeeded)';
    if (code === 429) return 'var(--comp-retry)';
    if (code === 430) return 'var(--comp-controller)';
    if (code === 401) return 'var(--accent)';
    if (code >= 500) return 'var(--level-error)';
    return 'var(--text-muted)';
  }

  _renderJson(obj) {
    const entries = Object.entries(obj);
    let html = '{\n';
    entries.forEach(([k, v], i) => {
      let val;
      if (v === null || v === undefined) val = '<span class="retries-json-null">null</span>';
      else if (typeof v === 'boolean') val = '<span class="retries-json-bool">' + v + '</span>';
      else if (typeof v === 'number') val = '<span class="retries-json-number">' + v + '</span>';
      else val = '<span class="retries-json-string">"' + this._escapeHtml(String(v)) + '"</span>';
      html += '  <span class="retries-json-key">"' + this._escapeHtml(k) + '"</span>: ' + val;
      if (i < entries.length - 1) html += ',';
      html += '\n';
    });
    html += '}';
    return html;
  }

  _escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return text.replace(/[&<>"']/g, c => map[c]);
  }
}
