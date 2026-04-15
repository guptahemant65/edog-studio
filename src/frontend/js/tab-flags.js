/**
 * FeatureFlagsTab — Real-time feature flag evaluation stream.
 *
 * Topic: "flag"
 * Event data: { flagName, tenantId, capacityId, workspaceId, result, durationMs }
 *
 * Features:
 *   - Evaluation stream table with virtual scrolling awareness
 *   - Flip detection (true->false / false->true) with animated badges
 *   - Summary view with per-flag stats, true/false percentage bars
 *   - Detail panel with context parameters and duration
 *   - Search with autocomplete, result/changed filter pills
 *   - Export (JSON, CSV, clipboard)
 *   - Keyboard navigation (arrows, Enter, Esc, Ctrl+E, Ctrl+/)
 *
 * Reference: f04-mock-09-feature-flags.html
 */

class FeatureFlagsTab {

  /** @param {HTMLElement} containerEl  @param {SignalRManager} signalr */
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // Data stores
    this._evals = [];             // all evaluations (chronological)
    this._filtered = [];          // after search + filter
    this._lastResult = {};        // flagName → last result (for flip detection)
    this._maxEvents = 1000;       // cap for memory

    // UI state
    this._selectedId = null;
    this._focusedIdx = -1;
    this._activeFilter = 'all';   // all | true | false | changed
    this._searchQuery = '';
    this._summaryMode = false;
    this._detailOpen = false;
    this._nextId = 0;
    this._acFocusIdx = -1;
    this._isActive = false;

    // Bound handler for SignalR events
    this._onEvent = this._onEvent.bind(this);

    // Build DOM
    this._build();
    this._bindEvents();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /** Called by RuntimeView when tab becomes active. */
  activate() {
    this._isActive = true;
    if (this._signalr) {
      this._signalr.on('flag', this._onEvent);
      this._signalr.subscribeTopic('flag');
    }
    document.addEventListener('keydown', this._onKeyDown);
  }

  /** Called by RuntimeView when tab becomes inactive. */
  deactivate() {
    this._isActive = false;
    document.removeEventListener('keydown', this._onKeyDown);
    if (this._signalr) {
      this._signalr.off('flag', this._onEvent);
      this._signalr.unsubscribeTopic('flag');
    }
  }

  // ── SignalR event handler ───────────────────────────────────

  /** Receives a TopicEvent envelope: { sequenceId, timestamp, topic, data } */
  _onEvent(envelope) {
    const d = envelope && envelope.data ? envelope.data : envelope;
    if (!d || !d.flagName) return;

    const ev = {
      id: this._nextId++,
      flagName: d.flagName,
      tenantId: d.tenantId || '',
      capacityId: d.capacityId || '',
      workspaceId: d.workspaceId || '',
      result: !!d.result,
      durationMs: typeof d.durationMs === 'number' ? d.durationMs : 0,
      timestamp: this._fmtTime(envelope.timestamp ? new Date(envelope.timestamp) : new Date()),
      changed: false,
      prevResult: null,
    };

    // Flip detection
    if (ev.flagName in this._lastResult && this._lastResult[ev.flagName] !== ev.result) {
      ev.changed = true;
      ev.prevResult = this._lastResult[ev.flagName];
    }
    this._lastResult[ev.flagName] = ev.result;

    // Enforce cap
    this._evals.push(ev);
    if (this._evals.length > this._maxEvents) {
      const evicted = this._evals.splice(0, this._evals.length - this._maxEvents);
      // Clean _lastResult for flags no longer present in _evals
      for (const old of evicted) {
        if (!this._evals.some(e => e.flagName === old.flagName)) {
          delete this._lastResult[old.flagName];
        }
      }
    }

    // Update UI
    if (this._summaryMode) {
      this._renderSummary();
    } else {
      this._applyFilters();
      // Animate new row
      requestAnimationFrame(() => {
        const row = this._scrollEl.querySelector('[data-eid="' + ev.id + '"]');
        if (row) {
          row.classList.add('new');
          if (ev.changed) row.classList.add('flash');
          this._scrollEl.scrollTop = this._scrollEl.scrollHeight;
        }
      });
    }
  }

  // ── DOM construction ────────────────────────────────────────

  _build() {
    const c = this._container;
    c.innerHTML = '';

    // Toolbar
    const toolbar = this._el('div', 'flags-toolbar');
    const tRow = this._el('div', 'flags-toolbar-row');

    // Search box
    const searchWrap = this._el('div', 'flags-search');
    searchWrap.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>';
    this._searchInput = this._el('input');
    this._searchInput.type = 'text';
    this._searchInput.placeholder = 'Search flags...';
    this._searchInput.setAttribute('autocomplete', 'off');
    searchWrap.appendChild(this._searchInput);
    this._searchClear = this._el('div', 'flags-search-clear');
    this._searchClear.textContent = '\u2715';
    this._searchClear.style.display = 'none';
    searchWrap.appendChild(this._searchClear);
    this._autocomplete = this._el('div', 'flags-autocomplete');
    searchWrap.appendChild(this._autocomplete);
    tRow.appendChild(searchWrap);

    tRow.appendChild(this._el('div', 'flags-sep'));

    // Filter pills
    const pills = this._el('div', 'flags-pills');
    this._pillEls = {};
    const pillDefs = [
      { key: 'all', label: 'All', cls: '' },
      { key: 'true', label: 'True', cls: 'flags-pill-true' },
      { key: 'false', label: 'False', cls: 'flags-pill-false' },
      { key: 'changed', label: 'Changed', cls: 'flags-pill-changed' },
    ];
    pillDefs.forEach(def => {
      const pill = this._el('button', 'flags-pill' + (def.cls ? ' ' + def.cls : ''));
      if (def.key === 'all') pill.classList.add('active');
      pill.dataset.filter = def.key;
      const countSpan = this._el('span', 'flags-pill-count');
      countSpan.textContent = '0';
      pill.textContent = def.label + ' ';
      pill.appendChild(countSpan);
      this._pillEls[def.key] = { el: pill, count: countSpan };
      pills.appendChild(pill);
    });
    tRow.appendChild(pills);

    tRow.appendChild(this._el('div', 'flags-sep'));

    // Summary toggle
    this._summaryBtn = this._el('button', 'flags-action');
    this._summaryBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="3" rx="1"/><rect x="2" y="7" width="12" height="3" rx="1"/><rect x="2" y="12" width="8" height="3" rx="1"/></svg> Summary';
    tRow.appendChild(this._summaryBtn);

    tRow.appendChild(this._el('div', 'flags-sep'));

    // Stat badge
    this._statBadge = this._el('span', 'flags-stat');
    this._statBadge.textContent = '0 evals across 0 flags';
    tRow.appendChild(this._statBadge);

    // Export
    const exportWrap = this._el('div', 'flags-export-wrap');
    this._exportBtn = this._el('button', 'flags-export-btn');
    this._exportBtn.innerHTML = 'Export <span class="flags-export-chevron">\u25BE</span>';
    exportWrap.appendChild(this._exportBtn);
    this._exportDd = this._el('div', 'flags-export-dd');
    ['JSON', 'CSV', 'Clipboard'].forEach(fmt => {
      const item = this._el('div', 'flags-export-item');
      item.textContent = fmt === 'Clipboard' ? 'Copy to Clipboard' : 'Export as ' + fmt;
      item.dataset.format = fmt.toLowerCase();
      this._exportDd.appendChild(item);
    });
    exportWrap.appendChild(this._exportDd);
    tRow.appendChild(exportWrap);

    toolbar.appendChild(tRow);
    c.appendChild(toolbar);

    // Content area
    const content = this._el('div', 'flags-content');

    // Stream wrapper
    this._streamWrap = this._el('div', 'flags-stream');

    // Empty state
    this._emptyEl = this._el('div', 'flags-empty');
    this._emptyEl.innerHTML =
      '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">' +
        '<rect x="8" y="6" width="32" height="36" rx="4"/>' +
        '<path d="M16 16h16M16 22h10M16 28h14"/>' +
        '<circle cx="34" cy="34" r="8" fill="none" stroke-width="2"/>' +
        '<path d="M30 34h8M34 30v8" stroke-width="2"/>' +
      '</svg>' +
      '<div class="flags-empty-title">No feature flag evaluations captured</div>' +
      '<div class="flags-empty-hint">FeatureFlighter.IsEnabled() calls will appear here in real-time. Trigger an operation in FLT to see evaluations.</div>';
    this._streamWrap.appendChild(this._emptyEl);

    // Table header
    this._theadEl = this._el('div', 'flags-thead');
    this._theadEl.style.display = 'none';
    ['Flag Name', 'Tenant', 'Capacity', 'Workspace', 'Result', 'Time'].forEach(h => {
      const th = this._el('div', 'flags-th');
      th.textContent = h;
      this._theadEl.appendChild(th);
    });
    this._streamWrap.appendChild(this._theadEl);

    // Scroll area
    this._scrollEl = this._el('div', 'flags-scroll');
    this._scrollEl.setAttribute('tabindex', '0');
    this._streamWrap.appendChild(this._scrollEl);

    content.appendChild(this._streamWrap);

    // Summary view
    this._summaryView = this._el('div', 'flags-summary');
    const sumHead = this._el('div', 'flags-summary-thead');
    ['Flag Name', 'Evals', 'True %', 'False %', 'Changed', 'Last'].forEach(h => {
      const th = this._el('div', 'flags-th');
      th.textContent = h;
      sumHead.appendChild(th);
    });
    this._summaryView.appendChild(sumHead);
    this._summaryBody = this._el('div');
    this._summaryView.appendChild(this._summaryBody);
    content.appendChild(this._summaryView);

    // Detail resize handle
    this._detailResize = this._el('div', 'flags-detail-resize');
    content.appendChild(this._detailResize);

    // Detail panel
    this._detailEl = this._el('div', 'flags-detail closed');
    this._detailEl.style.height = '200px';

    const dHead = this._el('div', 'flags-detail-header');
    this._detailName = this._el('span', 'flags-detail-name');
    this._detailBadge = this._el('span');
    const dActions = this._el('div', 'flags-detail-actions');
    this._detailCopyBtn = this._el('button');
    this._detailCopyBtn.textContent = '\u2398';
    this._detailCopyBtn.title = 'Copy (Ctrl+C)';
    this._detailCloseBtn = this._el('button');
    this._detailCloseBtn.textContent = '\u2715';
    this._detailCloseBtn.title = 'Close (Esc)';
    dActions.appendChild(this._detailCopyBtn);
    dActions.appendChild(this._detailCloseBtn);
    dHead.appendChild(this._detailName);
    dHead.appendChild(this._detailBadge);
    dHead.appendChild(dActions);
    this._detailEl.appendChild(dHead);

    this._detailBody = this._el('div', 'flags-detail-body');
    this._detailEl.appendChild(this._detailBody);
    content.appendChild(this._detailEl);

    c.appendChild(content);
  }

  // ── Event binding ───────────────────────────────────────────

  _bindEvents() {
    // Filter pills
    Object.keys(this._pillEls).forEach(key => {
      this._pillEls[key].el.addEventListener('click', () => {
        Object.values(this._pillEls).forEach(p => p.el.classList.remove('active'));
        this._pillEls[key].el.classList.add('active');
        this._activeFilter = key;
        this._applyFilters();
      });
    });

    // Search input
    let debounce;
    this._searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this._onSearch(), 120);
      this._showAutocomplete();
    });
    this._searchInput.addEventListener('focus', () => this._showAutocomplete());
    this._searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this._clearSearch(); this._searchInput.blur(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._navAutocomplete(e.key === 'ArrowDown' ? 1 : -1);
      }
      if (e.key === 'Enter') this._selectAcItem();
    });
    this._searchClear.addEventListener('click', () => this._clearSearch());

    // Close autocomplete on outside click
    this._container.addEventListener('click', (e) => {
      if (!e.target.closest('.flags-search')) this._autocomplete.classList.remove('open');
    });

    // Summary toggle
    this._summaryBtn.addEventListener('click', () => this._toggleSummary());

    // Export button
    this._exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._exportBtn.classList.toggle('open');
      this._exportDd.classList.toggle('open');
    });
    this._exportDd.addEventListener('click', (e) => {
      const item = e.target.closest('.flags-export-item');
      if (item) {
        this._export(item.dataset.format);
        this._exportBtn.classList.remove('open');
        this._exportDd.classList.remove('open');
      }
    });
    this._container.addEventListener('click', (e) => {
      if (!e.target.closest('.flags-export-wrap')) {
        this._exportBtn.classList.remove('open');
        this._exportDd.classList.remove('open');
      }
    });

    // Row clicks
    this._scrollEl.addEventListener('click', (e) => {
      const row = e.target.closest('.flags-row');
      if (!row) return;
      this._selectEval(parseInt(row.dataset.eid, 10));
    });

    // Detail panel
    this._detailCloseBtn.addEventListener('click', () => this._closeDetail());
    this._detailCopyBtn.addEventListener('click', () => this._copySelected());
    this._initDetailResize();

    // Keyboard
    // Keyboard — registered in activate(), removed in deactivate()
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  // ── Search & Autocomplete ──────────────────────────────────

  _onSearch() {
    this._searchQuery = this._searchInput.value.trim();
    this._searchClear.style.display = this._searchQuery ? '' : 'none';
    this._applyFilters();
    this._showAutocomplete();
  }

  _clearSearch() {
    this._searchInput.value = '';
    this._searchQuery = '';
    this._searchClear.style.display = 'none';
    this._autocomplete.classList.remove('open');
    this._applyFilters();
  }

  _showAutocomplete() {
    const q = this._searchInput.value.trim().toLowerCase();
    if (!q) { this._autocomplete.classList.remove('open'); return; }

    const seen = [...new Set(this._evals.map(e => e.flagName))];
    const matches = seen.filter(f => f.toLowerCase().includes(q));
    if (matches.length === 0) { this._autocomplete.classList.remove('open'); return; }

    this._autocomplete.innerHTML = '';
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    matches.forEach(f => {
      const item = this._el('div', 'flags-ac-item');
      item.innerHTML = f.replace(re, '<mark>$1</mark>');
      item.dataset.flag = f;
      item.addEventListener('click', () => {
        this._searchInput.value = f;
        this._searchQuery = f;
        this._searchClear.style.display = '';
        this._autocomplete.classList.remove('open');
        this._applyFilters();
      });
      this._autocomplete.appendChild(item);
    });
    this._autocomplete.classList.add('open');
    this._acFocusIdx = -1;
  }

  _navAutocomplete(dir) {
    const items = this._autocomplete.querySelectorAll('.flags-ac-item');
    if (!items.length) return;
    items.forEach(i => i.classList.remove('focused'));
    this._acFocusIdx = (this._acFocusIdx + dir + items.length) % items.length;
    items[this._acFocusIdx].classList.add('focused');
  }

  _selectAcItem() {
    const focused = this._autocomplete.querySelector('.flags-ac-item.focused');
    if (focused) focused.click();
    else { this._autocomplete.classList.remove('open'); this._onSearch(); }
  }

  // ── Filtering ──────────────────────────────────────────────

  _applyFilters() {
    let list = this._evals.slice();

    if (this._activeFilter === 'true') list = list.filter(e => e.result === true);
    else if (this._activeFilter === 'false') list = list.filter(e => e.result === false);
    else if (this._activeFilter === 'changed') list = list.filter(e => e.changed);

    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      list = list.filter(e => e.flagName.toLowerCase().includes(q));
    }

    this._filtered = list;
    this._render();
    this._updateCounts();
  }

  _updateCounts() {
    const all = this._evals;
    const trueCount = all.filter(e => e.result === true).length;
    const falseCount = all.filter(e => e.result === false).length;
    const changedCount = all.filter(e => e.changed).length;
    const uniqueFlags = new Set(all.map(e => e.flagName)).size;

    this._pillEls['all'].count.textContent = all.length;
    this._pillEls['true'].count.textContent = trueCount;
    this._pillEls['false'].count.textContent = falseCount;
    this._pillEls['changed'].count.textContent = changedCount;
    this._statBadge.textContent = all.length + ' evals across ' + uniqueFlags + ' flags';
  }

  // ── Render stream ──────────────────────────────────────────

  _render() {
    const scroll = this._scrollEl;
    const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 20;

    if (this._evals.length === 0) {
      this._emptyEl.classList.remove('hidden');
      this._theadEl.style.display = 'none';
      scroll.innerHTML = '';
      return;
    }

    this._emptyEl.classList.add('hidden');
    this._theadEl.style.display = '';

    if (this._filtered.length === 0 && this._evals.length > 0) {
      scroll.innerHTML = '<div class="flags-no-match">No evaluations match current filters</div>';
      return;
    }

    scroll.innerHTML = '';

    this._filtered.forEach(ev => {
      const row = this._el('div', 'flags-row');
      row.dataset.eid = ev.id;
      if (ev.id === this._selectedId) row.classList.add('selected');
      if (ev.changed) row.classList.add('changed');

      const resultCls = ev.result ? 'flags-result-true' : 'flags-result-false';
      const resultSym = ev.result ? '\u2713' : '\u2715';
      const resultTxt = ev.result ? 'true' : 'false';

      const changeBadge = ev.changed
        ? '<span class="flags-change-badge">\u26A1 CHANGED</span>'
        : '';

      let changeRow = '';
      if (ev.changed) {
        const prev = ev.prevResult ? 'true' : 'false';
        const cur = ev.result ? 'true' : 'false';
        const curColor = ev.result ? 'var(--status-succeeded)' : 'var(--status-failed)';
        changeRow = '<div class="flags-change-detail">' +
          '<span class="flags-change-prev">' + prev + '</span> ' +
          '<span class="flags-change-arrow">\u2192</span> ' +
          '<span style="font-weight:600;color:' + curColor + '">' + cur + '</span>' +
          '</div>';
      }

      const tenant = this._truncate(ev.tenantId, 12);
      const capacity = this._truncate(ev.capacityId, 12);
      const workspace = this._truncate(ev.workspaceId, 14);

      row.innerHTML =
        '<div class="flags-cell flags-cell-name">' + this._highlightSearch(ev.flagName) + changeBadge + '</div>' +
        '<div class="flags-cell flags-cell-ctx" title="' + this._escHtml(ev.tenantId) + '">' + this._escHtml(tenant) + '</div>' +
        '<div class="flags-cell flags-cell-ctx" title="' + this._escHtml(ev.capacityId) + '">' + this._escHtml(capacity) + '</div>' +
        '<div class="flags-cell flags-cell-ctx" title="' + this._escHtml(ev.workspaceId) + '">' + this._escHtml(workspace) + '</div>' +
        '<div class="flags-cell"><span class="flags-result ' + resultCls + '">' + resultSym + ' ' + resultTxt + '</span></div>' +
        '<div class="flags-cell flags-cell-time">' + ev.timestamp + '</div>' +
        changeRow;

      scroll.appendChild(row);
    });

    if (atBottom) {
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
  }

  _highlightSearch(text) {
    const safe = this._escHtml(text);
    if (!this._searchQuery) return safe;
    const q = this._searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escaped = q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return safe.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark>$1</mark>');
  }

  // ── Summary view ───────────────────────────────────────────

  _toggleSummary() {
    this._summaryMode = !this._summaryMode;
    if (this._summaryMode) {
      this._summaryView.classList.add('active');
      this._streamWrap.style.display = 'none';
      this._summaryBtn.classList.add('active');
      this._renderSummary();
    } else {
      this._summaryView.classList.remove('active');
      this._streamWrap.style.display = '';
      this._summaryBtn.classList.remove('active');
      this._applyFilters();
    }
  }

  _renderSummary() {
    const body = this._summaryBody;
    body.innerHTML = '';

    const map = {};
    this._evals.forEach(ev => {
      if (!map[ev.flagName]) {
        map[ev.flagName] = {
          name: ev.flagName, evals: 0,
          trueCount: 0, falseCount: 0,
          changed: false, lastTime: '',
          history: [],
        };
      }
      const f = map[ev.flagName];
      f.evals++;
      if (ev.result) f.trueCount++; else f.falseCount++;
      if (ev.changed) f.changed = true;
      f.lastTime = ev.timestamp;
      f.history.push({ result: ev.result, durationMs: ev.durationMs || 0 });
    });

    const flags = Object.values(map).sort((a, b) => b.evals - a.evals);

    flags.forEach(f => {
      const truePct = Math.round(f.trueCount / f.evals * 100);
      const falsePct = 100 - truePct;

      const row = this._el('div', 'flags-summary-row');
      row.dataset.flagName = f.name;

      // Build sparkline from last 20 evaluations
      const recent = f.history.slice(-20);
      let sparkHtml = '<div class="flags-sparkline">';
      recent.forEach(r => {
        const h = Math.max(4, Math.min(16, Math.round((r.durationMs || 0) * 10)));
        const cls = r.result ? 'flags-spark-bar-true' : 'flags-spark-bar-false';
        sparkHtml += '<div class="flags-spark-bar ' + cls + '" style="height:' + h + 'px"></div>';
      });
      sparkHtml += '</div>';

      row.innerHTML =
        '<div class="flags-cell flags-summary-name">' + this._escHtml(f.name) + '</div>' +
        '<div class="flags-cell flags-summary-count">' + f.evals + '</div>' +
        '<div class="flags-cell">' +
          '<div class="flags-pct-bar"><div class="flags-pct-true" style="width:' + truePct + '%"></div><div class="flags-pct-false" style="width:' + falsePct + '%"></div></div>' +
          '<div class="flags-pct-label">' + truePct + '% true</div>' +
        '</div>' +
        '<div class="flags-cell">' +
          '<div class="flags-pct-bar"><div class="flags-pct-false" style="width:' + falsePct + '%"></div><div class="flags-pct-true" style="width:' + truePct + '%"></div></div>' +
          '<div class="flags-pct-label">' + falsePct + '% false</div>' +
        '</div>' +
        '<div class="flags-cell"><span class="flags-summary-changed ' + (f.changed ? 'yes' : 'no') + '">' + (f.changed ? 'Yes' : 'No') + '</span></div>' +
        '<div class="flags-cell flags-summary-time">' + f.lastTime + '</div>';

      // Click → filter to that flag in stream view
      row.addEventListener('click', () => {
        this._summaryMode = false;
        this._summaryView.classList.remove('active');
        this._streamWrap.style.display = '';
        this._summaryBtn.classList.remove('active');
        this._searchInput.value = f.name;
        this._searchQuery = f.name;
        this._searchClear.style.display = '';
        this._applyFilters();
      });

      body.appendChild(row);
    });
  }

  // ── Detail panel ───────────────────────────────────────────

  _selectEval(id) {
    this._selectedId = id;
    this._scrollEl.querySelectorAll('.flags-row').forEach(r => {
      r.classList.toggle('selected', parseInt(r.dataset.eid, 10) === id);
    });
    const ev = this._evals.find(e => e.id === id);
    if (ev) this._openDetail(ev);
  }

  _openDetail(ev) {
    this._detailOpen = true;
    this._detailEl.classList.remove('closed');
    this._detailName.textContent = ev.flagName;

    const rc = ev.result ? 'flags-result-true' : 'flags-result-false';
    const rs = ev.result ? '\u2713 true' : '\u2715 false';
    this._detailBadge.innerHTML = '<span class="flags-result ' + rc + '">' + rs + '</span>';

    // Build detail content
    let html = '';

    // Context parameters card
    html += '<div class="flags-dcard"><div class="flags-dcard-title">Context Parameters</div><div class="flags-dcard-body">' +
      '<div class="flags-kv"><span class="flags-kv-key">tenantId</span><span class="flags-kv-val">' + this._escHtml(ev.tenantId) + '</span></div>' +
      '<div class="flags-kv"><span class="flags-kv-key">capacityId</span><span class="flags-kv-val">' + this._escHtml(ev.capacityId) + '</span></div>' +
      '<div class="flags-kv"><span class="flags-kv-key">workspaceId</span><span class="flags-kv-val">' + this._escHtml(ev.workspaceId) + '</span></div>' +
      '</div></div>';

    // Duration card
    const durCls = ev.durationMs < 0.5 ? 'flags-duration-fast' : 'flags-duration-slow';
    html += '<div class="flags-dcard" style="max-width:160px"><div class="flags-dcard-title">Duration</div>' +
      '<div class="flags-dcard-body"><span class="flags-duration-value ' + durCls + '">' + ev.durationMs + 'ms</span></div></div>';

    // Change detected card
    if (ev.changed) {
      const prev = ev.prevResult ? 'true' : 'false';
      const cur = ev.result ? 'true' : 'false';
      const curColor = ev.result ? 'var(--status-succeeded)' : 'var(--status-failed)';
      html += '<div class="flags-dcard" style="max-width:200px"><div class="flags-dcard-title">Change Detected</div>' +
        '<div class="flags-dcard-body">' +
          '<span class="flags-change-card-prev">' + prev + '</span> ' +
          '<span class="flags-change-card-arrow">\u2192</span> ' +
          '<span style="font-weight:600;color:' + curColor + '">' + cur + '</span>' +
        '</div></div>';
    }

    // Flag history card (last 10 evaluations of this flag)
    const flagHistory = this._evals.filter(e => e.flagName === ev.flagName).slice(-10);
    if (flagHistory.length > 1) {
      let histHtml = '<div class="flags-dcard"><div class="flags-dcard-title">Recent History (' + flagHistory.length + ')</div><div class="flags-dcard-body">';
      flagHistory.forEach(h => {
        const symb = h.result ? '\u2713' : '\u2715';
        const color = h.result ? 'var(--status-succeeded)' : 'var(--status-failed)';
        const chg = h.changed ? ' <span style="color:var(--level-warning);font-weight:600">\u26A1</span>' : '';
        histHtml += '<div style="display:flex;gap:8px;padding:1px 0"><span style="color:var(--text-muted)">' + h.timestamp + '</span><span style="color:' + color + ';font-weight:600">' + symb + ' ' + (h.result ? 'true' : 'false') + '</span>' + chg + '</div>';
      });
      histHtml += '</div></div>';
      html += histHtml;
    }

    this._detailBody.innerHTML = html;
  }

  _closeDetail() {
    this._detailOpen = false;
    this._selectedId = null;
    this._detailEl.classList.add('closed');
    this._scrollEl.querySelectorAll('.flags-row.selected').forEach(r => r.classList.remove('selected'));
  }

  _copySelected() {
    const ev = this._evals.find(e => e.id === this._selectedId);
    if (!ev) return;
    const text = JSON.stringify({
      flagName: ev.flagName,
      tenantId: ev.tenantId,
      capacityId: ev.capacityId,
      workspaceId: ev.workspaceId,
      result: ev.result,
      durationMs: ev.durationMs,
      timestamp: ev.timestamp,
      changed: ev.changed,
    }, null, 2);
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  }

  _initDetailResize() {
    let startY, startH;
    const onMove = (e) => {
      const delta = startY - e.clientY;
      this._detailEl.style.height = Math.max(100, Math.min(500, startH + delta)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    this._detailResize.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startH = this._detailEl.offsetHeight;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Keyboard ───────────────────────────────────────────────

  _onKeyDown(e) {
    // Only handle when our container is visible
    if (!this._container.offsetParent) return;

    // Ctrl+E → Export
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      this._exportBtn.classList.toggle('open');
      this._exportDd.classList.toggle('open');
      return;
    }

    // Ctrl+/ or Ctrl+K → focus search
    if (e.ctrlKey && (e.key === '/' || e.key === 'k')) {
      e.preventDefault();
      this._searchInput.focus();
      return;
    }

    // Esc
    if (e.key === 'Escape') {
      if (this._detailOpen) { this._closeDetail(); return; }
      if (this._searchQuery) { this._clearSearch(); return; }
    }

    // Arrow navigation in stream view
    if (!this._summaryMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (document.activeElement === this._searchInput) return;
      e.preventDefault();
      const list = this._filtered;
      if (list.length === 0) return;
      if (e.key === 'ArrowDown') this._focusedIdx = Math.min(this._focusedIdx + 1, list.length - 1);
      else this._focusedIdx = Math.max(this._focusedIdx - 1, 0);
      this._selectEval(list[this._focusedIdx].id);
      const rows = this._scrollEl.querySelectorAll('.flags-row');
      if (rows[this._focusedIdx]) rows[this._focusedIdx].scrollIntoView({ block: 'nearest' });
    }

    // Enter → open detail for selected
    if (e.key === 'Enter' && this._selectedId !== null && !this._summaryMode) {
      const ev = this._evals.find(e2 => e2.id === this._selectedId);
      if (ev) this._openDetail(ev);
    }
  }

  // ── Export ─────────────────────────────────────────────────

  _export(format) {
    const data = this._filtered;
    if (format === 'json') {
      const json = JSON.stringify(data.map(e => ({
        flagName: e.flagName, tenantId: e.tenantId, capacityId: e.capacityId,
        workspaceId: e.workspaceId, result: e.result, durationMs: e.durationMs,
        timestamp: e.timestamp, changed: e.changed,
      })), null, 2);
      this._download('flag-evals.json', json, 'application/json');
    } else if (format === 'csv') {
      const cf = (val) => { const s = String(val == null ? '' : val); return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s; };
      let csv = 'FlagName,TenantId,CapacityId,WorkspaceId,Result,Timestamp,DurationMs,Changed\n';
      data.forEach(e => {
        csv += [cf(e.flagName), cf(e.tenantId), cf(e.capacityId), cf(e.workspaceId),
               cf(e.result), cf(e.timestamp), cf(e.durationMs), cf(e.changed)].join(',') + '\n';
      });
      this._download('flag-evals.csv', csv, 'text/csv');
    } else if (format === 'clipboard') {
      const text = data.map(e =>
        e.timestamp + ' ' + e.flagName + ' = ' + e.result + (e.changed ? ' (CHANGED)' : '')
      ).join('\n');
      navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
    }
  }

  _download(name, content, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Helpers ────────────────────────────────────────────────

  _el(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  _escHtml(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  _truncate(s, max) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max) + '\u2026' : s;
  }

  _fmtTime(d) {
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }
}
