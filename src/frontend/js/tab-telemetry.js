/**
 * TelemetryTab — Real-time SSR telemetry activity monitor.
 *
 * Pixel — EDOG Studio Frontend Engineer
 *
 * Displays incoming TelemetryEvent data as activity cards grouped by status
 * (Active / Completed). Supports text search, status pill filtering, duration
 * range slider, detail panel with JSON tree, sparkline tooltips, keyboard
 * navigation, and JSON/CSV export.
 *
 * Lifecycle:
 *   RuntimeView calls activate() / deactivate() on tab switch.
 *   SignalR topic "telemetry" streams TelemetryEvent envelopes.
 *
 * Event envelope:
 *   { sequenceId, timestamp, topic: "telemetry", data: TelemetryEvent }
 *
 * TelemetryEvent shape:
 *   { activityName, activityStatus, durationMs, resultCode,
 *     correlationId, iterationId, attributes, userId }
 */
'use strict';

class TelemetryTab {

  /* ── Constants ── */

  static LONG_THRESHOLD_SEC = 30;
  static MAX_SLIDER_SEC     = 120;
  static TICK_MS            = 100;
  static DEBOUNCE_MS        = 180;
  static MAX_SPARKLINE      = 8;
  static RENDER_LIMIT       = 500;

  constructor(containerEl, signalr) {
    this._el       = containerEl;
    this._signalr  = signalr;
    this._events   = [];
    this._active   = false;
    this._maxEvents = 5000;

    /* View state */
    this._selectedId   = null;
    this._kbIndex      = -1;
    this._filterText   = '';
    this._statusFilter = 'all';
    this._durMin       = 0;
    this._durMax       = TelemetryTab.MAX_SLIDER_SEC;
    this._detailOpen   = false;
    this._exportOpen   = false;

    /* Internal tracking */
    this._correlationMap = new Map();
    this._sparklines     = new Map();
    this._tickInterval   = null;
    this._debounceTimer  = null;
    this._renderRAF      = null;
    this._tooltipTarget  = null;

    /* DOM cache — populated by _buildDOM */
    this._dom = {};

    this._buildDOM();
    this._bindEvents();
  }

  /* ═══════════════════════════════════════════════════════════════
     LIFECYCLE
     ═══════════════════════════════════════════════════════════════ */

  activate() {
    this._active = true;
    if (this._signalr) {
      this._signalr.on('telemetry', this._onEvent);
      this._signalr.subscribeTopic('telemetry');
    }
    document.addEventListener('keydown', this._boundKeyDown);
    document.addEventListener('click', this._boundDocClick);
    this._startTicking();
    this._render();
  }

  deactivate() {
    this._active = false;
    document.removeEventListener('keydown', this._boundKeyDown);
    document.removeEventListener('click', this._boundDocClick);
    if (this._signalr) {
      this._signalr.unsubscribeTopic('telemetry');
      this._signalr.off('telemetry', this._onEvent);
    }
    this._stopTicking();
    this._hideTooltip();

    // Cancel pending render frame and debounce timer
    cancelAnimationFrame(this._renderRAF);
    this._renderRAF = null;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;

    // Reset UI state
    if (this._detailOpen) this._closeDetail();
    this._exportOpen = false;
    if (this._dom.exportDD) this._dom.exportDD.classList.remove('tl-export-dd--open');
    this._kbIndex = -1;
  }

  /* ═══════════════════════════════════════════════════════════════
     SIGNALR HANDLER
     ═══════════════════════════════════════════════════════════════ */

  _onEvent = (envelope) => {
    const data  = envelope.data || envelope;
    const seqId = envelope.sequenceId;
    const ts    = envelope.timestamp;

    const activity = this._mapEvent(data, seqId, ts);

    // Check if this updates an existing running activity via correlationId
    if (activity.correlationId && activity.status !== 'running') {
      const existingIdx = this._correlationMap.get(activity.correlationId);
      if (existingIdx !== undefined && existingIdx < this._events.length) {
        const existing = this._events[existingIdx];
        if (existing.status === 'running') {
          existing.status       = activity.status;
          existing.durationMs   = activity.durationMs;
          existing.durationSec  = activity.durationSec;
          existing.resultCode   = activity.resultCode;
          existing.error        = activity.error;
          existing.isLongRunning = activity.isLongRunning;
          Object.assign(existing.attributes, activity.attributes);
          this._trackSparkline(existing);
          if (this._active) this._scheduleRender();
          return;
        }
      }
    }

    // New activity
    const idx = this._events.length;
    this._events.push(activity);

    if (activity.correlationId) {
      this._correlationMap.set(activity.correlationId, idx);
    }

    // Evict oldest events when over cap
    while (this._events.length > this._maxEvents) {
      const evicted = this._events.shift();
      // Clean correlationMap for evicted event
      if (evicted.correlationId) {
        const mapped = this._correlationMap.get(evicted.correlationId);
        if (mapped !== undefined && mapped <= 0) {
          this._correlationMap.delete(evicted.correlationId);
        }
      }
      // Decrement all correlationMap indices by 1
      for (const [k, v] of this._correlationMap) {
        this._correlationMap.set(k, v - 1);
      }
      // Clean sparklines for activity names no longer in events
      if (evicted.name) {
        const stillExists = this._events.some(e => e.name === evicted.name);
        if (!stillExists) this._sparklines.delete(evicted.name);
      }
    }

    if (activity.status !== 'running') {
      this._trackSparkline(activity);
    }

    if (this._active) this._scheduleRender();
  };

  /** Public — add an event externally (for testing without SignalR). */
  addEvent(data) {
    this._onEvent({ data: data, sequenceId: this._events.length, timestamp: new Date().toISOString() });
  }

  /* ═══════════════════════════════════════════════════════════════
     DATA MAPPING
     ═══════════════════════════════════════════════════════════════ */

  _mapEvent(data, seqId, timestamp) {
    const rawStatus = (data.activityStatus || '').toLowerCase();
    const status =
      rawStatus === 'succeeded'  ? 'succeeded' :
      rawStatus === 'failed'     ? 'failed' :
      rawStatus === 'running' || rawStatus === 'inprogress' ? 'running' :
      rawStatus === 'cancelled'  ? 'failed' :
      rawStatus || 'succeeded';

    const durationMs  = data.durationMs || 0;
    const durationSec = durationMs / 1000;

    let error = null;
    if (status === 'failed') {
      error = data.resultCode
        ? 'Failed with result code ' + data.resultCode
        : 'Operation failed';
    }

    return {
      id:            'tel-' + (seqId != null ? seqId : this._events.length),
      seqId:         seqId,
      name:          data.activityName || 'Unknown Activity',
      status:        status,
      durationMs:    durationMs,
      durationSec:   durationSec,
      resultCode:    data.resultCode || '',
      correlationId: data.correlationId || '',
      iterationId:   data.iterationId || '',
      attributes:    data.attributes || {},
      userId:        data.userId || '',
      timestamp:     timestamp || new Date().toISOString(),
      isLongRunning: durationSec > TelemetryTab.LONG_THRESHOLD_SEC,
      startTime:     status === 'running' ? Date.now() : (Date.now() - durationMs),
      error:         error
    };
  }

  _trackSparkline(activity) {
    if (activity.durationSec <= 0) return;
    const key = activity.name;
    if (!this._sparklines.has(key)) this._sparklines.set(key, []);
    const arr = this._sparklines.get(key);
    arr.push(activity.durationSec);
    if (arr.length > TelemetryTab.MAX_SPARKLINE) arr.shift();
  }

  /* ═══════════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════════ */

  _fmtDur(sec) {
    if (sec < 0.001) return '0ms';
    if (sec < 0.1)   return (sec * 1000).toFixed(0) + 'ms';
    if (sec < 10)    return sec.toFixed(2) + 's';
    if (sec < 100)   return sec.toFixed(1) + 's';
    if (sec < 3600)  return Math.round(sec) + 's';
    return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's';
  }

  _fmtTime(isoStr) {
    try {
      const d = new Date(isoStr);
      return d.toTimeString().split(' ')[0] + '.' +
             String(d.getMilliseconds()).padStart(3, '0');
    } catch (_) { return isoStr || '\u2013'; }
  }

  _clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  _ce(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  _highlightText(text, query) {
    if (!query) return this._esc(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return this._esc(text);
    return this._esc(text.slice(0, idx)) +
      '<mark>' + this._esc(text.slice(idx, idx + query.length)) + '</mark>' +
      this._esc(text.slice(idx + query.length));
  }

  /* ═══════════════════════════════════════════════════════════════
     FILTERING
     ═══════════════════════════════════════════════════════════════ */

  _getVisible() {
    const ft   = this._filterText.toLowerCase();
    const sf   = this._statusFilter;
    const dMin = this._durMin;
    const dMax = this._durMax;

    const result = [];
    for (let i = this._events.length - 1; i >= 0; i--) {
      const a = this._events[i];
      if (sf !== 'all' && a.status !== sf) continue;
      if (ft && !a.name.toLowerCase().includes(ft)) continue;
      const dur = a.status === 'running'
        ? (Date.now() - a.startTime) / 1000
        : a.durationSec;
      if (dur < dMin || dur > dMax) continue;
      result.push(a);
      if (result.length >= TelemetryTab.RENDER_LIMIT) break;
    }
    return result;
  }

  /* ═══════════════════════════════════════════════════════════════
     DOM BUILDING
     ═══════════════════════════════════════════════════════════════ */

  _buildDOM() {
    const el = this._el;
    el.innerHTML = '';
    el.classList.add('tl-root');

    /* ── TOOLBAR ── */
    const toolbar = this._ce('div', 'tl-toolbar');

    // Search
    const search = this._ce('div', 'tl-search');
    search.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14">' +
      '<path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5' +
      ' 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49' +
      ' 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
    const input = this._ce('input', '');
    input.type = 'text';
    input.placeholder = 'Filter activities\u2026';
    input.autocomplete = 'off';
    input.spellcheck = false;
    search.appendChild(input);
    toolbar.appendChild(search);
    this._dom.searchInput = input;

    // Filter count
    const filterCount = this._ce('span', 'tl-filter-count');
    toolbar.appendChild(filterCount);
    this._dom.filterCount = filterCount;

    // Status pills
    const pills = this._ce('div', 'tl-pills');
    const pillDefs = [
      { status: 'all',       label: 'All' },
      { status: 'running',   label: 'Running' },
      { status: 'succeeded', label: 'Succeeded' },
      { status: 'failed',    label: 'Failed' }
    ];
    pillDefs.forEach(p => {
      const btn = this._ce('button', 'tl-pill');
      if (p.status === 'all') btn.classList.add('tl-pill--all');
      btn.dataset.status = p.status;
      btn.innerHTML = p.label + '<span class="tl-pill-count"></span>';
      pills.appendChild(btn);
    });
    toolbar.appendChild(pills);
    this._dom.pills = pills;

    // Duration slider
    const sliderWrap  = this._ce('div', 'tl-slider-wrap');
    const sliderLabel = this._ce('span', 'tl-slider-label');
    sliderLabel.textContent = '0s \u2013 ' + TelemetryTab.MAX_SLIDER_SEC + 's';
    const slider = this._ce('div', 'tl-slider');
    slider.innerHTML =
      '<div class="tl-slider-track"></div>' +
      '<div class="tl-slider-fill"></div>' +
      '<div class="tl-slider-thumb" data-which="min"></div>' +
      '<div class="tl-slider-thumb" data-which="max"></div>';
    sliderWrap.appendChild(sliderLabel);
    sliderWrap.appendChild(slider);
    toolbar.appendChild(sliderWrap);
    this._dom.sliderLabel = sliderLabel;
    this._dom.slider      = slider;

    // Export
    const exportWrap = this._ce('div', 'tl-export-wrap');
    const exportBtn  = this._ce('button', 'tl-export-btn');
    exportBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14">' +
      '<path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>' +
      '</svg> Export';
    const exportDD = this._ce('div', 'tl-export-dd');
    exportDD.innerHTML =
      '<button data-format="json">Export as JSON</button>' +
      '<button data-format="csv">Export as CSV</button>';
    exportWrap.appendChild(exportBtn);
    exportWrap.appendChild(exportDD);
    toolbar.appendChild(exportWrap);
    this._dom.exportBtn = exportBtn;
    this._dom.exportDD  = exportDD;

    el.appendChild(toolbar);
    this._dom.toolbar = toolbar;

    /* ── CONTENT AREA ── */
    const content = this._ce('div', 'tl-content');

    // Cards container (scrollable)
    const cards = this._ce('div', 'tl-cards');
    content.appendChild(cards);
    this._dom.cards = cards;

    // Empty state
    const empty = this._ce('div', 'tl-empty');
    empty.innerHTML =
      '<div class="tl-empty-icon">' +
        '<div class="tl-orbit"></div>' +
        '<div class="tl-orbit tl-orbit--inner"></div>' +
        '<div class="tl-orbit-core">' +
          '<svg viewBox="0 0 24 24" width="20" height="20">' +
          '<path fill="currentColor" opacity="0.7" d="M16 6l2.29 2.29-4.88' +
          ' 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>' +
        '</div>' +
        '<div class="tl-orbit-dot"></div>' +
        '<div class="tl-orbit-dot tl-orbit-dot--2"></div>' +
      '</div>' +
      '<div class="tl-empty-title">Waiting for telemetry events\u2026</div>' +
      '<div class="tl-empty-hint">SSR telemetry events will appear as operations execute.<br>' +
      'Activities, durations, and correlations stream in real-time.</div>';
    cards.appendChild(empty);
    this._dom.empty = empty;

    // Detail panel
    const detail = this._ce('div', 'tl-detail');
    detail.innerHTML =
      '<div class="tl-detail-resize"></div>' +
      '<div class="tl-detail-header">' +
        '<span class="tl-detail-title">\u2013</span>' +
        '<span class="tl-detail-status"></span>' +
        '<div class="tl-detail-actions">' +
          '<button class="tl-detail-logs">View in Logs</button>' +
          '<button class="tl-detail-copy">Copy data</button>' +
        '</div>' +
        '<button class="tl-detail-close">' +
          '<svg viewBox="0 0 24 24" width="14" height="14">' +
          '<path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5' +
          ' 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      '<div class="tl-detail-body"></div>';
    content.appendChild(detail);
    this._dom.detail = detail;

    el.appendChild(content);
    this._dom.content = content;

    // Tooltip (fixed positioning escapes overflow)
    const tooltip = this._ce('div', 'tl-tooltip');
    el.appendChild(tooltip);
    this._dom.tooltip = tooltip;

    // Toast container
    const toastC = this._ce('div', 'tl-toast-container');
    content.appendChild(toastC);
    this._dom.toasts = toastC;
  }

  /* ═══════════════════════════════════════════════════════════════
     EVENT BINDING
     ═══════════════════════════════════════════════════════════════ */

  _bindEvents() {
    // Search
    this._dom.searchInput.addEventListener('input', (e) => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._filterText = e.target.value.trim();
        this._render();
      }, TelemetryTab.DEBOUNCE_MS);
    });

    // Status pills
    this._dom.pills.addEventListener('click', (e) => {
      const pill = e.target.closest('.tl-pill');
      if (!pill) return;
      this._statusFilter = pill.dataset.status;
      this._updatePillStates();
      this._render();
    });

    // Duration slider
    this._initSlider();

    // Export
    this._dom.exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleExport();
    });
    this._dom.exportDD.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      this._doExport(btn.dataset.format);
    });

    // Card clicks
    this._dom.cards.addEventListener('click', (e) => {
      const card = e.target.closest('.tl-card');
      if (!card) return;
      this._selectCard(card.dataset.id);
    });

    // Card hover (tooltip)
    this._dom.cards.addEventListener('mousemove', (e) => this._onCardHover(e));
    this._dom.cards.addEventListener('mouseleave', () => this._hideTooltip());
    this._dom.cards.addEventListener('scroll', () => this._hideTooltip(), { passive: true });

    // Detail panel
    this._dom.detail.querySelector('.tl-detail-close').addEventListener('click', () => this._closeDetail());
    this._dom.detail.querySelector('.tl-detail-logs').addEventListener('click', () => this._viewInLogs());
    this._dom.detail.querySelector('.tl-detail-copy').addEventListener('click', () => this._copyData());
    this._initDetailResize();

    // Keyboard — bound ref stored; registered in activate(), removed in deactivate()
    this._boundKeyDown = (e) => { if (!this._active) return; this._onKeyDown(e); };

    // Close export on outside click — registered in activate(), removed in deactivate()
    this._boundDocClick = (e) => {
      if (!this._active) return;
      if (this._exportOpen && !e.target.closest('.tl-export-wrap')) {
        this._dom.exportDD.classList.remove('tl-export-dd--open');
        this._exportOpen = false;
      }
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDERING
     ═══════════════════════════════════════════════════════════════ */

  _scheduleRender() {
    if (this._renderRAF) return;
    this._renderRAF = requestAnimationFrame(() => {
      this._renderRAF = null;
      this._render();
    });
  }

  _render() {
    const visible = this._getVisible();
    this._updateCounts(visible);

    const container = this._dom.cards;
    const empty     = this._dom.empty;

    // Empty state
    if (visible.length === 0 && this._events.length === 0) {
      empty.classList.remove('tl-empty--hidden');
      return;
    }
    empty.classList.add('tl-empty--hidden');

    // Build cards HTML
    const running   = [];
    const completed = [];
    for (const a of visible) {
      if (a.status === 'running') running.push(a);
      else completed.push(a);
    }

    let html = '';

    if (running.length > 0) {
      html += '<div class="tl-section-header">' +
        '<span class="tl-section-dot tl-section-dot--active"></span> Active ' +
        '<span class="tl-section-count">(' + running.length + ')</span></div>';
      for (const a of running) html += this._buildCardHTML(a);
    }

    if (completed.length > 0) {
      html += '<div class="tl-section-header">' +
        '<span class="tl-section-dot tl-section-dot--completed"></span> Completed ' +
        '<span class="tl-section-count">(' + completed.length + ')</span></div>';
      for (const a of completed) html += this._buildCardHTML(a);
    }

    if (visible.length === 0 && this._events.length > 0) {
      html = '<div class="tl-no-results">No activities match current filters</div>';
    }

    // Preserve empty element, replace everything else
    const frag = document.createRange().createContextualFragment(html);
    // Remove all children except empty state and detail panel
    const toRemove = [];
    for (const child of container.children) {
      if (child !== empty) toRemove.push(child);
    }
    for (const child of toRemove) child.remove();

    container.insertBefore(frag, empty);
  }

  _buildCardHTML(a) {
    const isRunning = a.status === 'running';
    const isFailed  = a.status === 'failed';
    const isLong    = a.isLongRunning || a.durationSec > TelemetryTab.LONG_THRESHOLD_SEC;

    // Status badge
    let badgeHTML = '';
    if (isRunning) {
      badgeHTML = '<span class="tl-badge tl-badge--running">' +
        '<span class="tl-badge-dot"></span> Running</span>';
    } else if (isFailed) {
      badgeHTML = '<span class="tl-badge tl-badge--failed">\u2717 Failed</span>';
    } else if (isLong) {
      badgeHTML = '<span class="tl-badge tl-badge--long">\u26A0 Succeeded</span>';
    } else {
      badgeHTML = '<span class="tl-badge tl-badge--succeeded">\u2713 Succeeded</span>';
    }

    // Duration
    const elapsed = isRunning ? (Date.now() - a.startTime) / 1000 : a.durationSec;
    const durText = this._fmtDur(elapsed);
    const durClass = isRunning ? ' tl-card-dur--counting' :
                     (isLong ? ' tl-card-dur--long-pulse' : '');

    // Duration bar
    const sparkAvg = this._getSparklineAvg(a.name);
    const estimated = sparkAvg > 0 ? sparkAvg * 1.5 : 30;
    const pct = Math.min(100, (elapsed / Math.max(estimated, 0.01)) * 100);
    let fillClass = 'tl-dur-bar-fill tl-dur-bar-fill--running';
    if (!isRunning && !isFailed) fillClass = isLong
      ? 'tl-dur-bar-fill tl-dur-bar-fill--long'
      : 'tl-dur-bar-fill tl-dur-bar-fill--succeeded';
    else if (isFailed) fillClass = 'tl-dur-bar-fill tl-dur-bar-fill--failed';

    // Meta tags
    let metaHTML = '';
    if (a.iterationId)   metaHTML += '<span class="tl-meta-tag">iter: ' + this._esc(a.iterationId) + '</span>';
    if (a.correlationId) metaHTML += '<span class="tl-meta-tag">corr: ' + this._esc(a.correlationId) + '</span>';
    if (a.resultCode)    metaHTML += '<span class="tl-meta-tag">' + this._esc(a.resultCode) + '</span>';
    if (a.userId)        metaHTML += '<span class="tl-meta-tag">' + this._esc(a.userId) + '</span>';
    const attrs = a.attributes;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (metaHTML.length > 600) break; // prevent overflow
        metaHTML += '<span class="tl-meta-tag">' + this._esc(k) + ': ' + this._esc(String(v)) + '</span>';
      }
    }

    // Error
    let errorHTML = '';
    if (a.error) {
      const shortErr = a.error.length > 90 ? a.error.slice(0, 90) + '\u2026' : a.error;
      errorHTML = '<div class="tl-card-error">' + this._esc(shortErr) + '</div>';
    }

    // Card class
    const cardClass = [
      'tl-card',
      isRunning ? 'tl-card--running' : '',
      !isRunning && !isFailed && !isLong ? 'tl-card--succeeded' : '',
      isFailed ? 'tl-card--failed' : '',
      isLong && !isRunning ? 'tl-card--long' : '',
      a.id === this._selectedId ? 'tl-card--selected' : ''
    ].filter(Boolean).join(' ');

    return '<div class="' + cardClass + '" data-id="' + a.id + '" tabindex="0">' +
      '<div class="tl-card-row1">' +
        '<div class="tl-card-name">' + this._highlightText(a.name, this._filterText) + '</div>' +
        badgeHTML +
        '<div class="tl-card-dur' + durClass + '" data-dur-id="' + a.id + '">' + durText + '</div>' +
      '</div>' +
      '<div class="tl-dur-bar"><div class="' + fillClass + '" style="width:' + Math.min(pct, 100) + '%" data-bar-id="' + a.id + '"></div></div>' +
      '<div class="tl-card-row2">' + metaHTML + '</div>' +
      errorHTML +
    '</div>';
  }

  _esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _getSparklineAvg(name) {
    const arr = this._sparklines.get(name);
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /* ── Counts ── */

  _updateCounts(visible) {
    const total    = this._events.length;
    const visCount = visible.length;
    let runCount = 0, sucCount = 0, failCount = 0;
    for (let i = 0; i < total; i++) {
      const s = this._events[i].status;
      if (s === 'running') runCount++;
      else if (s === 'succeeded') sucCount++;
      else if (s === 'failed') failCount++;
    }

    this._dom.filterCount.textContent =
      visCount < total
        ? 'Showing ' + visCount + ' of ' + total + ' activities'
        : total + ' activities';

    const pillEls = this._dom.pills.querySelectorAll('.tl-pill-count');
    if (pillEls[0]) pillEls[0].textContent = ' ' + total;
    if (pillEls[1]) pillEls[1].textContent = ' ' + runCount;
    if (pillEls[2]) pillEls[2].textContent = ' ' + sucCount;
    if (pillEls[3]) pillEls[3].textContent = ' ' + failCount;
  }

  /* ── Pill states ── */

  _updatePillStates() {
    const sf = this._statusFilter;
    this._dom.pills.querySelectorAll('.tl-pill').forEach(p => {
      p.classList.remove('tl-pill--all', 'tl-pill--running', 'tl-pill--succeeded', 'tl-pill--failed');
      if (p.dataset.status === sf) {
        p.classList.add('tl-pill--' + sf);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     CARD INTERACTION
     ═══════════════════════════════════════════════════════════════ */

  _selectCard(id) {
    this._selectedId = id;

    // Update visual selection
    this._dom.cards.querySelectorAll('.tl-card').forEach(c => {
      c.classList.toggle('tl-card--selected', c.dataset.id === id);
    });

    // Update keyboard index
    const cardEls = Array.from(this._dom.cards.querySelectorAll('.tl-card'));
    this._kbIndex = cardEls.findIndex(c => c.dataset.id === id);

    // Open detail
    const activity = this._events.find(a => a.id === id);
    if (activity) this._openDetail(activity);
  }

  /* ═══════════════════════════════════════════════════════════════
     DETAIL PANEL
     ═══════════════════════════════════════════════════════════════ */

  _openDetail(a) {
    const detail = this._dom.detail;
    const body   = detail.querySelector('.tl-detail-body');
    const isRunning = a.status === 'running';
    const isFailed  = a.status === 'failed';
    const isLong    = a.isLongRunning || a.durationSec > TelemetryTab.LONG_THRESHOLD_SEC;

    // Title
    detail.querySelector('.tl-detail-title').textContent = a.name;

    // Status
    const statusEl = detail.querySelector('.tl-detail-status');
    let statusColor = 'var(--status-succeeded)';
    let statusText  = 'Succeeded';
    if (isRunning) { statusColor = 'var(--accent)'; statusText = 'Running'; }
    else if (isFailed) { statusColor = 'var(--status-failed)'; statusText = 'Failed'; }
    else if (isLong) { statusColor = 'var(--level-warning)'; statusText = 'Succeeded (long-running)'; }
    statusEl.style.color = statusColor;
    statusEl.textContent = statusText;

    // Build body
    const elapsed = isRunning ? (Date.now() - a.startTime) / 1000 : a.durationSec;
    let html = '';

    // Meta grid
    html += '<div class="tl-detail-meta">';
    html += this._metaItem('Status', statusText, statusColor);
    html += this._metaItem('Timestamp', this._fmtTime(a.timestamp));
    html += this._metaItem('Duration', this._fmtDur(elapsed));
    if (a.resultCode) html += this._metaItem('Result Code', a.resultCode);
    if (a.correlationId) html += this._metaItem('Correlation ID', a.correlationId);
    if (a.iterationId) html += this._metaItem('Iteration ID', a.iterationId);
    if (a.userId) html += this._metaItem('User', a.userId);
    html += '</div>';

    // Attributes JSON
    const attrKeys = Object.keys(a.attributes);
    if (attrKeys.length > 0) {
      html += '<div class="tl-detail-section-title">Attributes</div>';
      html += '<pre class="tl-json-tree">' + this._renderJSON(a.attributes) + '</pre>';
    }

    // Error
    if (a.error) {
      html += '<div class="tl-detail-section-title">Error</div>';
      html += '<div class="tl-detail-error">' + this._esc(a.error) + '</div>';
    }

    // Sparkline history
    const spark = this._sparklines.get(a.name);
    if (spark && spark.length > 1) {
      html += '<div class="tl-detail-section-title">Duration History (' + a.name + ')</div>';
      html += this._renderDetailSparkline(spark);
    }

    body.innerHTML = html;

    detail.classList.add('tl-detail--open');
    this._detailOpen = true;
  }

  _metaItem(label, value, color) {
    const style = color ? ' style="color:' + color + '"' : '';
    return '<div class="tl-detail-meta-item">' +
      '<div class="tl-detail-meta-label">' + label + '</div>' +
      '<div class="tl-detail-meta-value"' + style + '>' + this._esc(String(value)) + '</div>' +
    '</div>';
  }

  _renderJSON(obj, indent) {
    indent = indent || 0;
    const pad      = '  '.repeat(indent);
    const padInner = '  '.repeat(indent + 1);
    const isArr    = Array.isArray(obj);
    const entries  = isArr ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
    const open     = isArr ? '[' : '{';
    const close    = isArr ? ']' : '}';
    if (entries.length === 0) return '<span class="tl-json-brace">' + open + close + '</span>';

    let html = '<span class="tl-json-brace">' + open + '</span>\n';
    entries.forEach(([k, v], i) => {
      const comma = i < entries.length - 1 ? ',' : '';
      let valHTML;
      if (typeof v === 'string')       valHTML = '<span class="tl-json-string">"' + this._esc(v) + '"</span>';
      else if (typeof v === 'number')  valHTML = '<span class="tl-json-number">' + v + '</span>';
      else if (typeof v === 'boolean') valHTML = '<span class="tl-json-bool">' + v + '</span>';
      else if (v === null || v === undefined) valHTML = '<span class="tl-json-null">null</span>';
      else if (typeof v === 'object')  valHTML = this._renderJSON(v, indent + 1);
      else valHTML = this._esc(String(v));
      if (isArr) {
        html += padInner + valHTML + comma + '\n';
      } else {
        html += padInner + '<span class="tl-json-key">"' + this._esc(k) + '"</span>: ' + valHTML + comma + '\n';
      }
    });
    html += pad + '<span class="tl-json-brace">' + close + '</span>';
    return html;
  }

  _renderDetailSparkline(data) {
    const max = Math.max(...data);
    const barH = 32;
    let html = '<div style="display:flex;align-items:flex-end;gap:3px;height:' + barH + 'px;margin-top:8px">';
    data.forEach((v, i) => {
      const h = Math.max(3, (v / max) * barH);
      const isLast = i === data.length - 1;
      const bg = isLast ? 'var(--accent)' : 'var(--accent-dim)';
      html += '<div style="width:12px;height:' + h + 'px;border-radius:2px 2px 0 0;background:' + bg + '" title="' + this._fmtDur(v) + '"></div>';
    });
    html += '</div>';
    return html;
  }

  _closeDetail() {
    this._dom.detail.classList.remove('tl-detail--open');
    this._detailOpen = false;
    this._selectedId = null;
    this._dom.cards.querySelectorAll('.tl-card').forEach(c =>
      c.classList.remove('tl-card--selected'));
  }

  _viewInLogs() {
    const a = this._events.find(x => x.id === this._selectedId);
    const filterId = a && a.iterationId ? a.iterationId : (a ? a.correlationId : '');
    this._showToast('Switch to Logs tab filtered by: ' + (filterId || 'N/A'), '\u2192');
  }

  _copyData() {
    const a = this._events.find(x => x.id === this._selectedId);
    if (!a) return;
    const obj = {
      name: a.name, status: a.status, durationMs: a.durationMs,
      resultCode: a.resultCode, correlationId: a.correlationId,
      iterationId: a.iterationId, attributes: a.attributes,
      userId: a.userId, error: a.error
    };
    const text = JSON.stringify(obj, null, 2);
    navigator.clipboard.writeText(text)
      .then(() => this._showToast('Activity data copied to clipboard'))
      .catch(() => this._showToast('Copy failed \u2014 check permissions'));
  }

  _initDetailResize() {
    const handle = this._dom.detail.querySelector('.tl-detail-resize');
    const panel  = this._dom.detail;
    let startY, startH;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = panel.offsetHeight;
      const onMove = (ev) => {
        const diff = startY - ev.clientY;
        panel.style.height = Math.max(120, startH + diff) + 'px';
        panel.style.maxHeight = '80%';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     DURATION SLIDER
     ═══════════════════════════════════════════════════════════════ */

  _initSlider() {
    const slider = this._dom.slider;
    const fill   = slider.querySelector('.tl-slider-fill');
    const thumbs = slider.querySelectorAll('.tl-slider-thumb');
    const label  = this._dom.sliderLabel;
    const MAX    = TelemetryTab.MAX_SLIDER_SEC;
    let dragging = null;

    const update = () => {
      const w    = slider.offsetWidth;
      const pMin = (this._durMin / MAX) * w;
      const pMax = (this._durMax / MAX) * w;
      thumbs[0].style.left = pMin + 'px';
      thumbs[1].style.left = pMax + 'px';
      fill.style.left  = pMin + 'px';
      fill.style.width  = (pMax - pMin) + 'px';
      label.textContent = Math.round(this._durMin) + 's \u2013 ' + Math.round(this._durMax) + 's';
    };

    const onMove = (e) => {
      if (!dragging) return;
      const rect = slider.getBoundingClientRect();
      const x    = (e.clientX || (e.touches && e.touches[0].clientX) || 0) - rect.left;
      const val  = this._clamp((x / rect.width) * MAX, 0, MAX);
      if (dragging === 'min') this._durMin = Math.min(val, this._durMax - 1);
      else                    this._durMax = Math.max(val, this._durMin + 1);
      update();
      this._scheduleRender();
    };

    const onUp = () => {
      dragging = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    thumbs.forEach(t => {
      t.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = t.dataset.which;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    requestAnimationFrame(update);
  }

  /* ═══════════════════════════════════════════════════════════════
     EXPORT
     ═══════════════════════════════════════════════════════════════ */

  _toggleExport() {
    this._exportOpen = !this._exportOpen;
    this._dom.exportDD.classList.toggle('tl-export-dd--open', this._exportOpen);
  }

  _doExport(format) {
    const visible = this._getVisible();
    const count   = visible.length;

    if (format === 'json') {
      const payload = visible.map(a => ({
        name: a.name, status: a.status, durationMs: a.durationMs,
        resultCode: a.resultCode, correlationId: a.correlationId,
        iterationId: a.iterationId, attributes: a.attributes,
        userId: a.userId, error: a.error
      }));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      this._downloadBlob(blob, 'telemetry-export.json');
    } else {
      let csv = 'Name,Status,Duration(ms),ResultCode,CorrelationId,IterationId,Error\n';
      visible.forEach(a => {
        csv += '"' + (a.name || '').replace(/"/g, '""') + '",' +
               '"' + a.status + '",' +
               a.durationMs + ',' +
               '"' + (a.resultCode || '') + '",' +
               '"' + (a.correlationId || '') + '",' +
               '"' + (a.iterationId || '') + '",' +
               '"' + (a.error || '').replace(/"/g, '""') + '"\n';
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      this._downloadBlob(blob, 'telemetry-export.csv');
    }

    this._showToast('Exported ' + count + ' activities as ' + format.toUpperCase());
    this._dom.exportDD.classList.remove('tl-export-dd--open');
    this._exportOpen = false;
  }

  _downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  /* ═══════════════════════════════════════════════════════════════
     HOVER TOOLTIP
     ═══════════════════════════════════════════════════════════════ */

  _onCardHover(e) {
    const card = e.target.closest('.tl-card');
    if (!card) { this._hideTooltip(); return; }

    const id = card.dataset.id;
    if (id === this._tooltipTarget) return; // already showing

    const a = this._events.find(x => x.id === id);
    if (!a || a.status === 'running') { this._hideTooltip(); return; }

    this._tooltipTarget = id;
    const tip  = this._dom.tooltip;
    let rows = '<div class="tl-tooltip-row"><span>Duration</span><span>' + this._fmtDur(a.durationSec) + '</span></div>';
    rows += '<div class="tl-tooltip-row"><span>Status</span><span>' + a.status + '</span></div>';
    if (a.resultCode) rows += '<div class="tl-tooltip-row"><span>Code</span><span>' + this._esc(a.resultCode) + '</span></div>';
    if (a.userId) rows += '<div class="tl-tooltip-row"><span>User</span><span>' + this._esc(a.userId) + '</span></div>';

    // Sparkline
    const spark = this._sparklines.get(a.name);
    if (spark && spark.length > 1) {
      const maxSp = Math.max(...spark);
      const bars  = spark.map((v, i) => {
        const h   = Math.max(3, (v / maxSp) * 20);
        const cls = i === spark.length - 1 ? 'tl-spark-bar tl-spark-bar--highlight' : 'tl-spark-bar';
        return '<div class="' + cls + '" style="height:' + h + 'px"></div>';
      }).join('');
      rows += '<div class="tl-tooltip-sparkline-wrap">' +
        '<div class="tl-tooltip-spark-label">Recent durations</div>' +
        '<div class="tl-sparkline">' + bars + '</div></div>';
    }

    tip.innerHTML = rows;
    tip.classList.add('tl-tooltip--visible');

    // Position
    const rect = card.getBoundingClientRect();
    tip.style.left = (rect.right + 12) + 'px';
    tip.style.top  = (rect.top + rect.height / 2) + 'px';
    tip.style.transform = 'translateY(-50%)';

    // Flip if off-screen
    requestAnimationFrame(() => {
      const tipW = tip.offsetWidth || 200;
      if (rect.right + 12 + tipW > window.innerWidth - 8) {
        tip.style.left = (rect.left - tipW - 12) + 'px';
      }
    });
  }

  _hideTooltip() {
    if (!this._tooltipTarget) return;
    this._tooltipTarget = null;
    this._dom.tooltip.classList.remove('tl-tooltip--visible');
  }

  /* ═══════════════════════════════════════════════════════════════
     LIVE DURATION TICKING
     ═══════════════════════════════════════════════════════════════ */

  _startTicking() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => {
      const now = Date.now();
      let anyRunning = false;

      for (const a of this._events) {
        if (a.status !== 'running') continue;
        anyRunning = true;
        const elapsed = (now - a.startTime) / 1000;
        const wasLong = a.isLongRunning;
        a.isLongRunning = elapsed > TelemetryTab.LONG_THRESHOLD_SEC;

        // Update duration text in DOM
        const durEl = this._dom.cards.querySelector('[data-dur-id="' + a.id + '"]');
        if (durEl) {
          durEl.textContent = this._fmtDur(elapsed);
          if (a.isLongRunning && !wasLong) durEl.classList.add('tl-card-dur--long-pulse');
        }

        // Update bar width
        const barEl = this._dom.cards.querySelector('[data-bar-id="' + a.id + '"]');
        if (barEl) {
          const sparkAvg  = this._getSparklineAvg(a.name);
          const estimated = sparkAvg > 0 ? sparkAvg * 1.5 : 30;
          const pct = Math.min(100, (elapsed / Math.max(estimated, 0.01)) * 100);
          barEl.style.width = pct + '%';

          // Switch to amber if long-running
          if (a.isLongRunning && !wasLong) {
            barEl.classList.remove('tl-dur-bar-fill--running');
            barEl.classList.add('tl-dur-bar-fill--long');
            const card = barEl.closest('.tl-card');
            if (card) {
              card.classList.remove('tl-card--running');
              card.classList.add('tl-card--long');
            }
          }
        }
      }

      if (!anyRunning) this._stopTicking();
    }, TelemetryTab.TICK_MS);
  }

  _stopTicking() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     KEYBOARD NAVIGATION
     ═══════════════════════════════════════════════════════════════ */

  _onKeyDown(e) {
    // Only handle when this tab is active
    if (!this._active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const cards = Array.from(this._dom.cards.querySelectorAll('.tl-card'));
    if (!cards.length && e.key !== 'Escape') return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        this._kbIndex = Math.min(this._kbIndex + 1, cards.length - 1);
        cards.forEach(c => c.classList.remove('tl-card--kb-focus'));
        if (cards[this._kbIndex]) {
          cards[this._kbIndex].classList.add('tl-card--kb-focus');
          cards[this._kbIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        this._kbIndex = Math.max(this._kbIndex - 1, 0);
        cards.forEach(c => c.classList.remove('tl-card--kb-focus'));
        if (cards[this._kbIndex]) {
          cards[this._kbIndex].classList.add('tl-card--kb-focus');
          cards[this._kbIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        break;
      }
      case 'Enter': {
        if (this._kbIndex >= 0 && this._kbIndex < cards.length) {
          e.preventDefault();
          this._selectCard(cards[this._kbIndex].dataset.id);
        }
        break;
      }
      case 'Escape': {
        if (this._detailOpen) {
          e.preventDefault();
          this._closeDetail();
        }
        break;
      }
    }

    // Ctrl+E for export
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      this._toggleExport();
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     TOAST NOTIFICATIONS
     ═══════════════════════════════════════════════════════════════ */

  _showToast(msg, icon) {
    icon = icon || '\u2713';
    const container = this._dom.toasts;
    const el = this._ce('div', 'tl-toast');
    el.innerHTML = '<span class="tl-toast-icon">' + icon + '</span> ' + this._esc(msg);
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('tl-toast--leaving');
      setTimeout(() => el.remove(), 200);
    }, 2500);
  }
}
