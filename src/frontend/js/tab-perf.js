/**
 * PerfMarkersTab — Internals sub-view for MonitoredCodeMarkers duration metrics.
 *
 * Topic: perf
 * Pattern: constructor(containerEl, signalr), activate(), deactivate(), _onEvent, _render
 *
 * Features:
 *   - Streaming perf marker table with logarithmic duration bars
 *   - Sparkline trend per operation (last 8 occurrences)
 *   - Anomaly detection: flash when an operation takes >3x its p95
 *   - Collapsible summary panel with p50/p95/p99 stats
 *   - Detail panel with history chart
 *   - Filter by text + duration range
 *   - Export JSON/CSV
 *   - Keyboard: Arrow Up/Down, Enter, Escape
 *   - Handles 5000 events with virtual-ish rendering (capped DOM rows)
 */
class PerfMarkersTab {

  /** @param {HTMLElement} containerEl  The .rt-tab-content element for this tab */
  /** @param {SignalRManager} signalr   The shared SignalR connection manager */
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // Data store
    this._markers = [];          // All markers, newest first
    this._filtered = [];         // After text + duration filter
    this._opStats = new Map();   // opName -> { durations[], p95, avg }
    this._selectedId = null;
    this._nextId = 0;

    // UI state
    this._summaryOpen = false;
    this._filterText = '';
    this._durFilter = 'all';     // 'all' | 'fast' | 'medium' | 'slow'
    this._sortCol = 'ts';
    this._sortAsc = false;
    this._exportOpen = false;
    this._detailHeight = 260;
    this._active = false;

    // Render cap for DOM perf — show max 500 rows in table
    this._MAX_VISIBLE_ROWS = 500;

    // Anomaly threshold: > 3x the rolling p95
    this._ANOMALY_MULTIPLIER = 3;

    // Build DOM once
    this._buildDOM();
    this._bindEvents();

    // Bound handler for SignalR
    this._onEvent = this._onEvent.bind(this);
  }

  // ═══════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  /** Called when the tab becomes visible. Subscribe to perf topic. */
  activate() {
    this._active = true;
    this._signalr.on('perf', this._onEvent);
    this._signalr.subscribeTopic('perf');
    this._render();
  }

  /** Called when the tab is hidden. Unsubscribe to save resources. */
  deactivate() {
    this._active = false;
    this._signalr.off('perf', this._onEvent);
    this._signalr.unsubscribeTopic('perf');
  }

  // ═══════════════════════════════════════════════════════════════════
  // SIGNALR EVENT HANDLER
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Handle a single perf event from the stream.
   * Event shape: { operationName, durationMs, result, dimensions: { namespace, operationType }, correlationId }
   */
  _onEvent(event) {
    if (!event) return;

    const opName = event.operationName || event.operation || 'Unknown';
    const durMs = typeof event.durationMs === 'number' ? event.durationMs : 0;
    const ts = event.timestamp ? new Date(event.timestamp) : new Date();
    const corrId = event.correlationId || '';
    const ns = (event.dimensions && event.dimensions.namespace) || '';
    const opType = (event.dimensions && event.dimensions.operationType) || '';
    const result = event.result || '';
    const iterationId = event.iterationId || '';

    // Update rolling stats for this operation
    if (!this._opStats.has(opName)) {
      this._opStats.set(opName, { durations: [], p95: 0, avg: 0 });
    }
    const stats = this._opStats.get(opName);
    stats.durations.push(durMs);
    // Keep last 200 for percentile calculations
    if (stats.durations.length > 200) stats.durations.shift();
    const sorted = [...stats.durations].sort((a, b) => a - b);
    stats.avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    stats.p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];

    // Anomaly detection
    const threshold = stats.p95 * this._ANOMALY_MULTIPLIER;
    const isAnomaly = stats.durations.length >= 3 && durMs > threshold;
    const anomalyMultiplier = isAnomaly ? Math.round(durMs / stats.avg) : null;

    const marker = {
      id: this._nextId++,
      operation: opName,
      durationMs: durMs,
      timestamp: ts,
      startTime: new Date(ts.getTime() - durMs),
      endTime: ts,
      correlationId: corrId,
      namespace: ns,
      operationType: opType,
      result: result,
      iterationId: iterationId,
      isAnomaly: isAnomaly,
      anomalyMultiplier: anomalyMultiplier,
      avgDuration: Math.round(stats.avg),
      _new: true
    };

    // Enforce 5000 cap
    this._markers.unshift(marker);
    if (this._markers.length > 5000) {
      this._markers.length = 5000;
    }

    this._applyFilters();

    // Anomaly flash
    if (isAnomaly && this._active) {
      this._flashAnomaly(marker);
    }

    // Clear _new flag after animation window
    setTimeout(() => { marker._new = false; }, 300);
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOM CONSTRUCTION
  // ═══════════════════════════════════════════════════════════════════

  _buildDOM() {
    const c = this._container;
    c.innerHTML = '';
    c.style.display = 'flex';
    c.style.flexDirection = 'column';
    c.style.overflow = 'hidden';

    // Toolbar
    const toolbar = this._el('div', 'perf-toolbar');
    const row = this._el('div', 'perf-toolbar-row');
    toolbar.appendChild(row);

    // Search
    const search = this._el('div', 'perf-search');
    search.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">'
      + '<circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>';
    this._searchInput = this._el('input');
    this._searchInput.type = 'text';
    this._searchInput.placeholder = 'Filter operations...';
    this._searchInput.setAttribute('aria-label', 'Filter operations');
    search.appendChild(this._searchInput);
    row.appendChild(search);

    // Duration pills
    const pills = this._el('div', 'perf-dur-pills');
    pills.setAttribute('role', 'radiogroup');
    pills.setAttribute('aria-label', 'Duration filter');
    ['all', 'fast', 'medium', 'slow'].forEach(d => {
      const pill = this._el('button', 'perf-dur-pill');
      pill.setAttribute('role', 'radio');
      pill.dataset.dur = d;
      pill.textContent = d === 'all' ? 'All' : d === 'fast' ? '<100ms' : d === 'medium' ? '100\u2013500ms' : '>500ms';
      if (d === 'all') pill.classList.add('active');
      pills.appendChild(pill);
    });
    this._pillsEl = pills;
    row.appendChild(pills);

    row.appendChild(this._el('div', 'perf-sep'));

    // Summary toggle
    const summaryBtn = this._el('button', 'perf-action');
    summaryBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">'
      + '<rect x="1" y="1" width="14" height="14" rx="2"/>'
      + '<line x1="4" y1="5" x2="12" y2="5"/><line x1="4" y1="8" x2="12" y2="8"/>'
      + '<line x1="4" y1="11" x2="9" y2="11"/></svg> Summary';
    summaryBtn.title = 'Toggle summary';
    this._summaryBtn = summaryBtn;
    row.appendChild(summaryBtn);

    row.appendChild(this._el('div', 'perf-sep'));

    // Marker count badge
    this._countBadge = this._el('span', 'perf-badge perf-badge-neutral');
    this._countBadge.textContent = '0 markers';
    row.appendChild(this._countBadge);

    // Anomaly count badge
    this._anomalyBadge = this._el('span', 'perf-badge perf-badge-warn');
    this._anomalyBadge.style.display = 'none';
    this._anomalyBadge.textContent = '0 anomalies';
    row.appendChild(this._anomalyBadge);

    row.appendChild(this._el('div', 'perf-sep'));

    // Export dropdown
    const exportWrap = this._el('div', 'perf-export-wrap');
    const exportBtn = this._el('button', 'perf-export-btn');
    exportBtn.innerHTML = 'Export <span class="perf-chevron">\u25BE</span>';
    this._exportBtn = exportBtn;
    const exportDrop = this._el('div', 'perf-export-dropdown');
    const jsonItem = this._el('button', 'perf-export-item');
    jsonItem.textContent = 'Export as JSON';
    jsonItem.dataset.format = 'json';
    const csvItem = this._el('button', 'perf-export-item');
    csvItem.textContent = 'Export as CSV';
    csvItem.dataset.format = 'csv';
    exportDrop.appendChild(jsonItem);
    exportDrop.appendChild(csvItem);
    this._exportDrop = exportDrop;
    exportWrap.appendChild(exportBtn);
    exportWrap.appendChild(exportDrop);
    row.appendChild(exportWrap);

    c.appendChild(toolbar);

    // Summary panel
    const summary = this._el('div', 'perf-summary');
    const sumHeader = this._el('div', 'perf-summary-header');
    sumHeader.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">'
      + '<rect x="1" y="1" width="14" height="14" rx="2"/><line x1="4" y1="5" x2="12" y2="5"/>'
      + '<line x1="4" y1="8" x2="12" y2="8"/><line x1="4" y1="11" x2="9" y2="11"/></svg>'
      + ' Performance Summary \u2014 Aggregated Statistics';
    const sumClose = this._el('button', 'perf-summary-close');
    sumClose.textContent = '\u2715';
    sumClose.title = 'Close summary';
    sumClose.setAttribute('aria-label', 'Close summary');
    this._summaryCloseBtn = sumClose;
    sumHeader.appendChild(sumClose);
    summary.appendChild(sumHeader);
    const sumTable = this._el('table', 'perf-summary-table');
    const sumThead = this._el('thead');
    sumThead.innerHTML = '<tr><th>Operation</th><th>Count</th><th>Min</th><th>Avg</th><th>Max</th><th>P50</th><th>P95</th><th>P99</th></tr>';
    sumTable.appendChild(sumThead);
    this._summaryBody = this._el('tbody');
    sumTable.appendChild(this._summaryBody);
    summary.appendChild(sumTable);
    this._summaryEl = summary;
    c.appendChild(summary);

    // Content area
    const content = this._el('div', 'perf-content');

    // Empty state
    const empty = this._el('div', 'perf-empty');
    empty.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">'
      + '<circle cx="24" cy="24" r="20"/><path d="M24 14v10l7 7"/></svg>'
      + '<div class="perf-empty-title">No performance markers captured</div>'
      + '<div class="perf-empty-hint">MonitoredCodeMarkers duration metrics will stream here as operations execute. Trigger an operation in FLT to begin.</div>';
    this._emptyEl = empty;
    content.appendChild(empty);

    // Table
    const tableWrap = this._el('div', 'perf-table-wrap');
    tableWrap.style.display = 'none';
    const table = this._el('table', 'perf-table');
    const thead = this._el('thead');
    thead.innerHTML = '<tr>'
      + '<th data-col="status" style="width:28px">\u00A0</th>'
      + '<th data-col="op">Operation <span class="perf-sort-arrow">\u25B2</span></th>'
      + '<th data-col="dur">Duration <span class="perf-sort-arrow">\u25BC</span></th>'
      + '<th data-col="bar" style="width:130px">Bar</th>'
      + '<th data-col="trend" style="width:90px">Trend</th>'
      + '<th data-col="iter">Iteration</th>'
      + '<th data-col="ts" class="sorted">Timestamp <span class="perf-sort-arrow">\u25B2</span></th>'
      + '</tr>';
    table.appendChild(thead);
    this._tableBody = this._el('tbody');
    table.appendChild(this._tableBody);
    tableWrap.appendChild(table);
    this._tableWrap = tableWrap;
    this._tableHead = thead;
    content.appendChild(tableWrap);

    // Detail resize handle
    const resize = this._el('div', 'perf-detail-resize');
    this._resizeHandle = resize;
    content.appendChild(resize);

    // Detail panel
    const detail = this._el('div', 'perf-detail closed');
    detail.style.height = this._detailHeight + 'px';
    const dHeader = this._el('div', 'perf-detail-header');
    this._detailOp = this._el('span', 'perf-detail-op');
    this._detailDur = this._el('span', 'perf-detail-dur');
    this._detailAnomalyLabel = this._el('span', 'perf-detail-anomaly-label');
    this._detailAnomalyLabel.style.display = 'none';
    dHeader.appendChild(this._detailOp);
    dHeader.appendChild(this._detailDur);
    dHeader.appendChild(this._detailAnomalyLabel);
    const dActions = this._el('div', 'perf-detail-actions');
    const copyBtn = this._el('button');
    copyBtn.textContent = '\u2398';
    copyBtn.title = 'Copy JSON';
    copyBtn.setAttribute('aria-label', 'Copy marker JSON');
    this._detailCopyBtn = copyBtn;
    const closeBtn = this._el('button');
    closeBtn.textContent = '\u2715';
    closeBtn.title = 'Close detail';
    closeBtn.setAttribute('aria-label', 'Close detail panel');
    this._detailCloseBtn = closeBtn;
    dActions.appendChild(copyBtn);
    dActions.appendChild(closeBtn);
    dHeader.appendChild(dActions);
    detail.appendChild(dHeader);
    this._detailBody = this._el('div', 'perf-detail-body');
    detail.appendChild(this._detailBody);
    this._detailEl = detail;
    content.appendChild(detail);

    c.appendChild(content);
  }

  // ═══════════════════════════════════════════════════════════════════
  // EVENT BINDING
  // ═══════════════════════════════════════════════════════════════════

  _bindEvents() {
    // Filter input
    this._searchInput.addEventListener('input', () => {
      this._filterText = this._searchInput.value.trim().toLowerCase();
      this._applyFilters();
    });

    // Duration pills
    this._pillsEl.addEventListener('click', (e) => {
      const pill = e.target.closest('.perf-dur-pill');
      if (!pill) return;
      this._pillsEl.querySelectorAll('.perf-dur-pill').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-checked', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-checked', 'true');
      this._durFilter = pill.dataset.dur;
      this._applyFilters();
    });

    // Summary toggle
    this._summaryBtn.addEventListener('click', () => this._toggleSummary());
    this._summaryCloseBtn.addEventListener('click', () => this._toggleSummary());

    // Summary row click -> filter
    this._summaryBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr || !tr.dataset.op) return;
      this._searchInput.value = tr.dataset.op;
      this._filterText = tr.dataset.op.toLowerCase();
      this._applyFilters();
    });

    // Export dropdown
    this._exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._exportOpen = !this._exportOpen;
      this._exportBtn.classList.toggle('open', this._exportOpen);
      this._exportDrop.classList.toggle('open', this._exportOpen);
    });
    this._exportDrop.addEventListener('click', (e) => {
      const item = e.target.closest('.perf-export-item');
      if (!item) return;
      e.stopPropagation();
      this._exportData(item.dataset.format);
      this._closeExportDropdown();
    });

    // Close export on outside click (delegated on container)
    this._container.addEventListener('click', (e) => {
      if (this._exportOpen && !e.target.closest('.perf-export-wrap')) {
        this._closeExportDropdown();
      }
    });

    // Table header click for sorting
    this._tableHead.addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (!th || !th.dataset.col) return;
      const col = th.dataset.col;
      if (col === 'bar' || col === 'trend' || col === 'status') return;
      if (this._sortCol === col) {
        this._sortAsc = !this._sortAsc;
      } else {
        this._sortCol = col;
        this._sortAsc = col === 'op'; // default: asc for op, desc for others
      }
      this._updateSortIndicators();
      this._applyFilters();
    });

    // Table row click
    this._tableBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr || tr.dataset.id === undefined) return;
      const id = parseInt(tr.dataset.id, 10);
      if (isNaN(id)) return;
      this._selectedId = id;
      this._highlightSelected();
      this._openDetail(id);
    });

    // Detail close + copy
    this._detailCloseBtn.addEventListener('click', () => this._closeDetail());
    this._detailCopyBtn.addEventListener('click', () => {
      if (this._selectedId === null) return;
      const m = this._markers.find(x => x.id === this._selectedId);
      if (!m) return;
      const obj = {
        operation: m.operation, durationMs: m.durationMs,
        timestamp: m.timestamp.toISOString(), iterationId: m.iterationId,
        correlationId: m.correlationId, namespace: m.namespace,
        operationType: m.operationType, result: m.result,
        isAnomaly: m.isAnomaly, anomalyMultiplier: m.anomalyMultiplier
      };
      navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).catch(() => {});
    });

    // Detail resize
    let resizing = false;
    let startY = 0;
    let startH = 0;
    this._resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true;
      startY = e.clientY;
      startH = this._detailEl.offsetHeight;
      document.body.style.userSelect = 'none';
    });
    const onMouseMove = (e) => {
      if (!resizing) return;
      const h = Math.max(120, startH - (e.clientY - startY));
      this._detailEl.style.height = h + 'px';
      this._detailHeight = h;
    };
    const onMouseUp = () => {
      if (resizing) {
        resizing = false;
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Keyboard
    this._container.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  // ═══════════════════════════════════════════════════════════════════
  // KEYBOARD
  // ═══════════════════════════════════════════════════════════════════

  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!this._active) return;

    if (e.key === 'Escape') {
      this._closeDetail();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateRows(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && this._selectedId !== null) {
      e.preventDefault();
      this._openDetail(this._selectedId);
      return;
    }
  }

  _navigateRows(dir) {
    const ids = this._filtered.map(m => m.id);
    if (!ids.length) return;
    const curIdx = ids.indexOf(this._selectedId);
    let next;
    if (curIdx === -1) {
      next = 0;
    } else {
      next = Math.max(0, Math.min(ids.length - 1, curIdx + dir));
    }
    this._selectedId = ids[next];
    this._highlightSelected();
    const tr = this._tableBody.querySelector('[data-id="' + this._selectedId + '"]');
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  // ═══════════════════════════════════════════════════════════════════
  // FILTER + SORT
  // ═══════════════════════════════════════════════════════════════════

  _applyFilters() {
    let f = this._markers;

    // Text filter
    if (this._filterText) {
      const q = this._filterText;
      f = f.filter(m => m.operation.toLowerCase().includes(q)
        || m.namespace.toLowerCase().includes(q)
        || m.operationType.toLowerCase().includes(q)
        || m.correlationId.toLowerCase().includes(q));
    }

    // Duration bucket
    if (this._durFilter === 'fast') f = f.filter(m => m.durationMs < 100);
    else if (this._durFilter === 'medium') f = f.filter(m => m.durationMs >= 100 && m.durationMs <= 500);
    else if (this._durFilter === 'slow') f = f.filter(m => m.durationMs > 500);

    // Sort
    const col = this._sortCol;
    const asc = this._sortAsc;
    f = [...f].sort((a, b) => {
      let va, vb;
      if (col === 'op')  { va = a.operation; vb = b.operation; }
      else if (col === 'dur') { va = a.durationMs; vb = b.durationMs; }
      else if (col === 'iter') { va = a.iterationId; vb = b.iterationId; }
      else { va = a.timestamp.getTime(); vb = b.timestamp.getTime(); }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });

    this._filtered = f;
    this._render();
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  _render() {
    this._renderTable();
    this._updateBadges();
    if (this._summaryOpen) this._renderSummary();

    // Empty vs content
    if (this._markers.length === 0) {
      this._emptyEl.classList.remove('hidden');
      this._tableWrap.style.display = 'none';
    } else {
      this._emptyEl.classList.add('hidden');
      this._tableWrap.style.display = '';
    }
  }

  _renderTable() {
    const rows = this._filtered;
    const maxDur = Math.max(1, ...rows.slice(0, this._MAX_VISIBLE_ROWS).map(m => m.durationMs));
    const visible = rows.slice(0, this._MAX_VISIBLE_ROWS);

    // Build HTML in one pass
    const parts = [];
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      const dc = this._durClass(m.durationMs);
      // Logarithmic bar: log(1 + dur) / log(1 + maxDur) gives better distribution
      const barPct = Math.max(2, (Math.log1p(m.durationMs) / Math.log1p(maxDur)) * 100);
      const sparkline = this._renderSparkline(m.operation, m.durationMs);
      const anomalyBadge = m.isAnomaly
        ? '<span class="perf-anomaly-badge">\u26A0 ' + m.anomalyMultiplier + '\u00D7</span>'
        : '';
      const sel = m.id === this._selectedId ? ' perf-selected' : '';
      const anom = m.isAnomaly ? ' perf-anomaly' : '';
      const newCls = m._new ? ' perf-row-new' : '';

      parts.push(
        '<tr data-id="', m.id, '" class="', anom, sel, newCls,
        '" tabindex="-1"><td>', anomalyBadge,
        '</td><td><span class="perf-op-name">', this._esc(m.operation),
        '</span></td><td><div class="perf-dur-cell"><span class="perf-dur-value perf-dur-', dc, '">',
        this._fmtDur(m.durationMs),
        '</span></div></td><td><div class="perf-dur-bar-wrap"><div class="perf-dur-bar ', dc,
        '" style="width:', barPct, '%"></div></div></td><td class="perf-sparkline-cell">',
        sparkline, '</td><td class="perf-iter-cell">', this._esc(m.iterationId),
        '</td><td class="perf-ts-cell">', this._fmtTime(m.timestamp), '</td></tr>'
      );
    }

    this._tableBody.innerHTML = parts.join('');
  }

  _updateBadges() {
    const total = this._markers.length;
    const anomalies = this._markers.filter(m => m.isAnomaly).length;
    this._countBadge.textContent = total + ' marker' + (total !== 1 ? 's' : '');
    if (anomalies > 0) {
      this._anomalyBadge.style.display = '';
      this._anomalyBadge.textContent = anomalies + ' anomal' + (anomalies !== 1 ? 'ies' : 'y');
    } else {
      this._anomalyBadge.style.display = 'none';
    }
  }

  _highlightSelected() {
    const rows = this._tableBody.querySelectorAll('tr');
    for (let i = 0; i < rows.length; i++) {
      const id = parseInt(rows[i].dataset.id, 10);
      rows[i].classList.toggle('perf-selected', id === this._selectedId);
    }
  }

  _updateSortIndicators() {
    const ths = this._tableHead.querySelectorAll('th');
    for (let i = 0; i < ths.length; i++) {
      ths[i].classList.remove('sorted');
      const arrow = ths[i].querySelector('.perf-sort-arrow');
      if (arrow) arrow.textContent = '\u25B2';
    }
    const active = this._tableHead.querySelector('th[data-col="' + this._sortCol + '"]');
    if (active) {
      active.classList.add('sorted');
      const arrow = active.querySelector('.perf-sort-arrow');
      if (arrow) arrow.textContent = this._sortAsc ? '\u25B2' : '\u25BC';
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SPARKLINE (SVG, last 8 bars)
  // ═══════════════════════════════════════════════════════════════════

  _renderSparkline(opName, currentDur) {
    const W = 80;
    const H = 20;
    const history = this._getOpHistory(opName, 8);
    if (history.length < 2) return '<svg width="' + W + '" height="' + H + '"></svg>';

    const max = Math.max(1, ...history);
    const gap = 1;
    const barW = Math.max(2, (W - (history.length - 1) * gap) / history.length);
    const parts = ['<svg width="', W, '" height="', H, '" viewBox="0 0 ', W, ' ', H, '">'];

    for (let i = 0; i < history.length; i++) {
      const val = history[i];
      const barH = Math.max(2, (val / max) * (H - 2));
      const x = i * (barW + gap);
      const y = H - barH;
      const isCurrent = i === history.length - 1;
      let fill;
      if (isCurrent && val === currentDur) {
        fill = this._durClass(val) === 'slow' ? 'var(--status-failed)' : 'var(--accent)';
      } else {
        fill = 'var(--text-muted)';
      }
      const opacity = isCurrent ? '1' : '0.45';
      parts.push('<rect x="', x, '" y="', y, '" width="', barW, '" height="', barH,
        '" rx="1" fill="', fill, '" opacity="', opacity, '"/>');
    }

    parts.push('</svg>');
    return parts.join('');
  }

  _getOpHistory(opName, maxItems) {
    const items = [];
    // Walk newest-first markers, collect matching, reverse for chronological order
    for (let i = 0; i < this._markers.length && items.length < maxItems; i++) {
      if (this._markers[i].operation === opName) {
        items.push(this._markers[i].durationMs);
      }
    }
    items.reverse();
    return items;
  }

  // ═══════════════════════════════════════════════════════════════════
  // DETAIL PANEL
  // ═══════════════════════════════════════════════════════════════════

  _openDetail(id) {
    const m = this._markers.find(x => x.id === id);
    if (!m) return;

    this._detailOp.textContent = m.operation;
    this._detailDur.textContent = this._fmtDurPrecise(m.durationMs);
    const dc = this._durClass(m.durationMs);
    this._detailDur.style.color = dc === 'fast'
      ? 'var(--status-succeeded)' : dc === 'medium'
      ? 'var(--level-warning)' : 'var(--status-failed)';

    if (m.isAnomaly) {
      this._detailAnomalyLabel.style.display = '';
      this._detailAnomalyLabel.textContent = 'ANOMALY: ' + m.anomalyMultiplier + '\u00D7 average';
    } else {
      this._detailAnomalyLabel.style.display = 'none';
    }

    const history = this._getOpHistory(m.operation, 20);
    const occurrences = this._markers.filter(x => x.operation === m.operation).length;
    const historyChart = this._renderDetailChart(history, m.durationMs);

    const html = '<div class="perf-detail-card">'
      + '<div class="perf-detail-card-label">Start Time</div>'
      + '<div class="perf-detail-card-value">' + this._fmtTimePrecise(m.startTime) + '</div></div>'
      + '<div class="perf-detail-card">'
      + '<div class="perf-detail-card-label">End Time</div>'
      + '<div class="perf-detail-card-value">' + this._fmtTimePrecise(m.endTime) + '</div></div>'
      + '<div class="perf-detail-card">'
      + '<div class="perf-detail-card-label">Duration</div>'
      + '<div class="perf-detail-card-value" style="color:var(--' + (dc === 'fast' ? 'status-succeeded' : dc === 'medium' ? 'level-warning' : 'status-failed') + ')">' + this._fmtDurPrecise(m.durationMs) + '</div></div>'
      + '<div class="perf-detail-card">'
      + '<div class="perf-detail-card-label">Iteration</div>'
      + '<div class="perf-detail-card-value">' + this._esc(m.iterationId || '\u2014') + '</div></div>'
      + '<div class="perf-detail-card">'
      + '<div class="perf-detail-card-label">Avg Duration</div>'
      + '<div class="perf-detail-card-value">' + this._fmtDur(m.avgDuration) + '</div></div>'
      + '<div class="perf-detail-card">'
      + '<div class="perf-detail-card-label">Occurrences</div>'
      + '<div class="perf-detail-card-value">' + occurrences + '</div></div>'
      + (m.correlationId ? '<div class="perf-detail-card">'
        + '<div class="perf-detail-card-label">Correlation ID</div>'
        + '<div class="perf-detail-card-value" style="font-size:11px;word-break:break-all">' + this._esc(m.correlationId) + '</div></div>' : '')
      + (m.namespace ? '<div class="perf-detail-card">'
        + '<div class="perf-detail-card-label">Namespace</div>'
        + '<div class="perf-detail-card-value">' + this._esc(m.namespace) + '</div></div>' : '')
      + '<div class="perf-detail-history">'
      + '<div class="perf-detail-card-label">History (last ' + history.length + ' durations)</div>'
      + '<div class="perf-detail-chart">' + historyChart + '</div>'
      + '<div class="perf-detail-chart-label">' + history.map(v => this._fmtDur(v)).join('  ') + '</div></div>'
      + '<div class="perf-json-card">'
      + '<span class="perf-json-key">"operation"</span>: <span class="perf-json-string">"' + this._esc(m.operation) + '"</span>,\n'
      + '<span class="perf-json-key">"durationMs"</span>: <span class="perf-json-number">' + m.durationMs + '</span>,\n'
      + '<span class="perf-json-key">"iterationId"</span>: <span class="perf-json-string">"' + this._esc(m.iterationId) + '"</span>,\n'
      + '<span class="perf-json-key">"isAnomaly"</span>: <span class="perf-json-bool">' + m.isAnomaly + '</span>,\n'
      + '<span class="perf-json-key">"timestamp"</span>: <span class="perf-json-string">"' + m.timestamp.toISOString() + '"</span>'
      + (m.isAnomaly ? ',\n<span class="perf-json-key">"anomalyMultiplier"</span>: <span class="perf-json-number">' + m.anomalyMultiplier + '</span>,\n'
        + '<span class="perf-json-key">"avgDuration"</span>: <span class="perf-json-number">' + m.avgDuration + '</span>' : '')
      + '</div>';

    this._detailBody.innerHTML = html;
    this._detailEl.classList.remove('closed');
    this._detailEl.style.height = this._detailHeight + 'px';
  }

  _renderDetailChart(history, currentDur) {
    if (history.length < 2) return '<svg width="100%" height="60"></svg>';

    const w = 500;
    const h = 60;
    const max = Math.max(1, ...history);
    const gap = 3;
    const barW = Math.max(6, (w - (history.length - 1) * gap) / history.length);
    const parts = ['<svg width="100%" height="', h, '" viewBox="0 0 ', w, ' ', h, '" preserveAspectRatio="none">'];

    // Polyline connecting dots
    const points = [];
    for (let i = 0; i < history.length; i++) {
      const x = i * (barW + gap) + barW / 2;
      const y = h - 4 - (history[i] / max) * (h - 12);
      points.push(x + ',' + y);
    }
    parts.push('<polyline points="', points.join(' '),
      '" fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.3"/>');

    // Dots + labels
    for (let i = 0; i < history.length; i++) {
      const val = history[i];
      const x = i * (barW + gap) + barW / 2;
      const y = h - 4 - (val / max) * (h - 12);
      const isCurrent = i === history.length - 1;
      let fill = 'var(--text-muted)';
      let r = 3;
      if (isCurrent) {
        fill = this._durClass(val) === 'slow' ? 'var(--status-failed)' : 'var(--accent)';
        r = 5;
      }
      parts.push('<circle cx="', x, '" cy="', y, '" r="', r, '" fill="', fill, '"/>');
      parts.push('<text x="', x, '" y="', Math.max(10, y - 8),
        '" text-anchor="middle" font-size="9" font-family="var(--font-mono)" fill="var(--text-dim)">',
        this._fmtDur(val), '</text>');
    }

    // Current marker label
    const lastX = (history.length - 1) * (barW + gap) + barW / 2;
    parts.push('<text x="', lastX, '" y="', h,
      '" text-anchor="middle" font-size="8" fill="var(--accent)">\u2190 this</text>');

    parts.push('</svg>');
    return parts.join('');
  }

  _closeDetail() {
    this._detailEl.classList.add('closed');
    this._selectedId = null;
    this._highlightSelected();
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════

  _toggleSummary() {
    this._summaryOpen = !this._summaryOpen;
    this._summaryEl.classList.toggle('open', this._summaryOpen);
    this._summaryBtn.classList.toggle('active', this._summaryOpen);
    if (this._summaryOpen) this._renderSummary();
  }

  _renderSummary() {
    const ops = {};
    for (let i = 0; i < this._markers.length; i++) {
      const m = this._markers[i];
      if (!ops[m.operation]) ops[m.operation] = [];
      ops[m.operation].push(m.durationMs);
    }

    const stats = Object.entries(ops).map(([op, durations]) => {
      durations.sort((a, b) => a - b);
      const c = durations.length;
      return {
        op: op,
        count: c,
        min: durations[0],
        avg: Math.round(durations.reduce((a, b) => a + b, 0) / c),
        max: durations[c - 1],
        p50: durations[Math.floor(c * 0.5)],
        p95: durations[Math.floor(c * 0.95)] || durations[c - 1],
        p99: durations[Math.floor(c * 0.99)] || durations[c - 1]
      };
    });

    stats.sort((a, b) => b.avg - a.avg);
    const maxAvg = Math.max(1, ...stats.map(s => s.avg));

    const parts = [];
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      const barPct = (s.avg / maxAvg) * 100;
      parts.push(
        '<tr data-op="', this._esc(s.op), '">',
        '<td style="font-family:var(--font-mono);font-weight:500">', this._esc(s.op), '</td>',
        '<td>', s.count, '</td>',
        '<td class="', this._durClass(s.min) === 'fast' ? 'perf-stat-green' : '', '">', this._fmtDur(s.min), '</td>',
        '<td class="perf-stat-cell" style="position:relative">',
        '<div class="perf-stat-bg" style="background:var(--accent);width:', barPct, '%"></div>',
        '<span style="position:relative">', this._fmtDur(s.avg), '</span></td>',
        '<td class="', this._durClass(s.max) === 'slow' ? 'perf-stat-red' : this._durClass(s.max) === 'medium' ? 'perf-stat-amber' : '', '">',
        this._fmtDur(s.max), '</td>',
        '<td>', this._fmtDur(s.p50), '</td>',
        '<td class="', this._durClass(s.p95) === 'slow' ? 'perf-stat-red' : this._durClass(s.p95) === 'medium' ? 'perf-stat-amber' : '', '">',
        this._fmtDur(s.p95), '</td>',
        '<td class="', this._durClass(s.p99) === 'slow' ? 'perf-stat-red' : this._durClass(s.p99) === 'medium' ? 'perf-stat-amber' : '', '">',
        this._fmtDur(s.p99), '</td>',
        '</tr>'
      );
    }

    this._summaryBody.innerHTML = parts.join('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // ANOMALY FLASH
  // ═══════════════════════════════════════════════════════════════════

  _flashAnomaly(marker) {
    // Pulse the anomaly badge
    this._anomalyBadge.classList.add('perf-badge-pulse');
    setTimeout(() => this._anomalyBadge.classList.remove('perf-badge-pulse'), 600);

    // Flash the row
    requestAnimationFrame(() => {
      const row = this._tableBody.querySelector('[data-id="' + marker.id + '"]');
      if (row) {
        row.classList.add('perf-anomaly-flash');
        setTimeout(() => row.classList.remove('perf-anomaly-flash'), 600);
        row.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════

  _exportData(format) {
    if (format === 'json') {
      const data = {
        exportedAt: new Date().toISOString(),
        markerCount: this._markers.length,
        anomalyCount: this._markers.filter(m => m.isAnomaly).length,
        summary: this._buildSummaryData(),
        markers: this._markers.map(m => ({
          operation: m.operation, durationMs: m.durationMs,
          timestamp: m.timestamp.toISOString(), iterationId: m.iterationId,
          correlationId: m.correlationId, isAnomaly: m.isAnomaly,
          anomalyMultiplier: m.anomalyMultiplier
        }))
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      this._download(blob, 'perf-markers.json');
    } else if (format === 'csv') {
      const cf = (val) => { const s = String(val == null ? '' : val); return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s; };
      let csv = 'Operation,Duration (ms),Timestamp,Iteration,CorrelationId,Is Anomaly,Multiplier\n';
      for (let i = 0; i < this._markers.length; i++) {
        const m = this._markers[i];
        csv += [cf(m.operation), cf(m.durationMs), cf(m.timestamp.toISOString()), cf(m.iterationId),
          cf(m.correlationId), cf(m.isAnomaly), cf(m.anomalyMultiplier || '')].join(',') + '\n';
      }
      csv += '\nSummary\nOperation,Count,Min,Avg,Max,P50,P95,P99\n';
      const summary = this._buildSummaryData();
      for (let i = 0; i < summary.length; i++) {
        const s = summary[i];
        csv += [cf(s.op), cf(s.count), cf(s.min), cf(s.avg), cf(s.max),
          cf(s.p50), cf(s.p95), cf(s.p99)].join(',') + '\n';
      }
      const blob = new Blob([csv], { type: 'text/csv' });
      this._download(blob, 'perf-markers.csv');
    }
  }

  _buildSummaryData() {
    const ops = {};
    for (let i = 0; i < this._markers.length; i++) {
      const m = this._markers[i];
      if (!ops[m.operation]) ops[m.operation] = [];
      ops[m.operation].push(m.durationMs);
    }
    return Object.entries(ops).map(([op, durations]) => {
      durations.sort((a, b) => a - b);
      const c = durations.length;
      return {
        op: op, count: c,
        min: durations[0],
        avg: Math.round(durations.reduce((a, b) => a + b, 0) / c),
        max: durations[c - 1],
        p50: durations[Math.floor(c * 0.5)],
        p95: durations[Math.floor(c * 0.95)] || durations[c - 1],
        p99: durations[Math.floor(c * 0.99)] || durations[c - 1]
      };
    });
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  _closeExportDropdown() {
    this._exportOpen = false;
    this._exportBtn.classList.remove('open');
    this._exportDrop.classList.remove('open');
  }

  // ═══════════════════════════════════════════════════════════════════
  // FORMATTING UTILITIES
  // ═══════════════════════════════════════════════════════════════════

  _fmtDur(ms) {
    if (ms < 1) return ms.toFixed(1) + 'ms';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return m + 'm ' + s + 's';
  }

  _fmtDurPrecise(ms) {
    if (ms < 1) return (ms * 1000).toFixed(0) + '\u00B5s';
    if (ms < 1000) return ms.toFixed(1) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(3) + 's';
    const m = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(1);
    return m + 'm ' + s + 's';
  }

  _durClass(ms) {
    if (ms < 100) return 'fast';
    if (ms <= 500) return 'medium';
    return 'slow';
  }

  _fmtTime(d) {
    return String(d.getHours()).padStart(2, '0') + ':'
      + String(d.getMinutes()).padStart(2, '0') + ':'
      + String(d.getSeconds()).padStart(2, '0');
  }

  _fmtTimePrecise(d) {
    return String(d.getHours()).padStart(2, '0') + ':'
      + String(d.getMinutes()).padStart(2, '0') + ':'
      + String(d.getSeconds()).padStart(2, '0') + '.'
      + String(d.getMilliseconds()).padStart(3, '0');
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOM HELPERS
  // ═══════════════════════════════════════════════════════════════════

  _el(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  _esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}
