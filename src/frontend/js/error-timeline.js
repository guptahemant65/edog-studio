/**
 * ErrorTimeline — CSS-grid bar chart showing error frequency over time.
 *
 * Renders a 48px-tall strip of stacked severity bars above the log list.
 * Supports click-to-filter, hover tooltips, incremental updates, and
 * live/paused stream modes. Pure CSS + JS — no charting library.
 *
 * @see docs/specs/features/F12-error-intelligence/components/C06-error-timeline.md
 */
class ErrorTimeline {

  // ── Constants ──

  static BUCKET_MIN = 30;
  static BUCKET_MAX = 60;
  static MIN_SPAN_MS = 1000;
  static MIN_CONTAINER_WIDTH = 200;
  static REBUILD_BATCH_INTERVAL = 100;

  // ── CSS (injected once per page) ──

  static _styleInjected = false;
  static _CSS = `
.error-timeline {
  position: relative;
  height: 48px;
  width: 100%;
  padding: 0 var(--space-2, 8px);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  overflow: hidden;
  flex-shrink: 0;
}
.etl-bars {
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  height: 100%;
  align-items: flex-end;
  gap: 1px;
}
.etl-col {
  display: flex;
  flex-direction: column-reverse;
  align-items: stretch;
  min-width: 0;
  cursor: pointer;
  border-radius: 1px 1px 0 0;
  transition: opacity var(--transition-fast, 80ms ease-out);
}
.etl-col:hover { opacity: 0.8; }
.etl-seg { min-height: 0; transition: height var(--transition-fast, 80ms ease-out); }
.etl-seg-error   { background: var(--level-error); }
.etl-seg-warning { background: var(--level-warning); }
.etl-seg-message { background: var(--level-message); opacity: 0.4; }
.etl-empty-bar   { visibility: hidden; }
.etl-col.etl-selected {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
  border-radius: 2px;
}
.etl-col.etl-dimmed { opacity: 0.3; }
.etl-col.etl-dimmed:hover { opacity: 0.5; }
.etl-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font: var(--text-sm, 12px) / 1 var(--font-body, sans-serif);
  user-select: none;
}
.etl-tooltip {
  position: absolute;
  top: -28px;
  transform: translateX(-50%);
  background: var(--surface-3);
  color: var(--text);
  font: var(--text-xs, 10px) / 1.2 var(--font-mono, monospace);
  padding: 2px 6px;
  border-radius: var(--radius-sm, 4px);
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--shadow-sm);
  z-index: var(--z-dropdown, 200);
  display: none;
}
@media print { .error-timeline { display: none; } }
`;

  // ── Constructor ──

  /**
   * @param {LogViewerState} state — shared state object (logBuffer, timelineFilter, etc.)
   * @param {Object} options
   * @param {Function} [options.onFilterChange] — callback when timeline filter changes
   */
  constructor(state, options = {}) {
    this.state = state;
    this._onFilterChange = options.onFilterChange || (() => {});

    // Bucket data
    this.buckets = [];
    this._bucketCount = 0;
    this._bucketDuration = 0;
    this._timeOrigin = 0;

    // Selection state
    this._selectedIndex = -1;

    // Error tracking
    this._consecutiveFailures = 0;

    // Staleness tracking
    this._lastRebuildOldestSeq = -1;
    this._batchesSinceRebuild = 0;

    // Visibility
    this._visible = true;
    this._mounted = false;

    // DOM references (set in mount)
    this._el = null;
    this._barsEl = null;
    this._emptyEl = null;
    this._tooltipEl = null;
    this._resizeObserver = null;
    this._styleEl = null;
  }

  // ── Lifecycle ──

  /**
   * Insert DOM into parent, attach events, start ResizeObserver.
   * @param {HTMLElement} parentEl
   */
  mount(parentEl) {
    if (this._mounted) return;

    this._injectStyles();
    this._createDOM();
    parentEl.appendChild(this._el);
    this._bindEvents();
    this._startResizeObserver();
    this._mounted = true;

    // If buffer already has data, do initial build
    if (this.state.logBuffer && this.state.logBuffer.count > 0) {
      try {
        this._rebuildBuckets();
        this._renderBars();
        this._updateEmptyState();
      } catch (err) {
        console.warn('[ErrorTimeline] Initial rebuild failed:', err);
      }
    } else {
      this._updateEmptyState();
    }
  }

  /**
   * Remove DOM, detach events, disconnect observer.
   */
  destroy() {
    if (!this._mounted) return;

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this._unbindEvents();

    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }

    this._el = null;
    this._barsEl = null;
    this._emptyEl = null;
    this._tooltipEl = null;
    this._mounted = false;
    this.buckets = [];
    this._selectedIndex = -1;

    if (this.state) {
      this.state.timelineFilter = null;
    }
  }

  // ── Public API: Data ──

  /**
   * Process a single new log entry (convenience wrapper).
   * @param {Object} entry — log entry with .timestamp and .level
   */
  addEntry(entry) {
    this.updateIncremental([entry]);
  }

  /**
   * Batch add entries (convenience wrapper).
   * @param {Object[]} entries
   */
  addEntries(entries) {
    if (entries && entries.length) {
      this.updateIncremental(entries);
    }
  }

  /**
   * Process new log batch — incremental update.
   * Called per SignalR batch, regardless of stream state.
   * @param {Object[]} newEntries
   */
  updateIncremental(newEntries) {
    if (!newEntries || !newEntries.length) return;

    try {
      if (!this.buckets.length) {
        this._rebuildBuckets();
        this._renderBars();
        this._updateEmptyState();
        this._consecutiveFailures = 0;
        return;
      }

      let needsRebuild = false;

      for (const entry of newEntries) {
        const ts = this._parseTs(entry);
        if (isNaN(ts)) continue;

        // Check if new entry extends time range beyond current buckets
        if (ts >= this.buckets[this.buckets.length - 1].endMs) {
          needsRebuild = true;
          break;
        }

        const idx = this._bucketIndexFor(ts);
        if (idx < 0 || idx >= this.buckets.length) {
          needsRebuild = true;
          break;
        }

        const b = this.buckets[idx];
        const level = (entry.level || 'message').toLowerCase();
        if (b[level] !== undefined) b[level]++;
        b.total++;
      }

      this._batchesSinceRebuild++;

      // Periodic full rebuild to correct for ring buffer eviction drift
      if (!needsRebuild && this._batchesSinceRebuild >= ErrorTimeline.REBUILD_BATCH_INTERVAL) {
        const currentOldestSeq = this.state.logBuffer.oldestSeq;
        const drift = Math.abs(currentOldestSeq - this._lastRebuildOldestSeq);
        if (drift > this.state.logBuffer.capacity * 0.1) {
          needsRebuild = true;
        }
      }

      if (needsRebuild) {
        // Clear selection — bucket indices will change
        if (this._selectedIndex !== -1) {
          this._clearSelection();
        }
        this._rebuildBuckets();
      }

      this._renderBars();
      this._updateEmptyState();
      this._consecutiveFailures = 0;
    } catch (err) {
      this._consecutiveFailures++;
      console.warn('[ErrorTimeline] updateIncremental failed:', err);
      if (this._consecutiveFailures >= 3) {
        console.error('[ErrorTimeline] 3 consecutive failures — timeline may be stale');
      }
    }
  }

  /**
   * Full rebuild from ring buffer (called on filter reset, reconnection, etc.)
   */
  rebuild() {
    try {
      this._rebuildBuckets();
      this._renderBars();
      this._updateEmptyState();
      this._consecutiveFailures = 0;
    } catch (err) {
      console.warn('[ErrorTimeline] rebuild failed:', err);
    }
  }

  // ── Public API: Filter ──

  /**
   * Set a time-range filter to a specific window.
   * @param {number} startMs
   * @param {number} endMs
   */
  setTimeRange(startMs, endMs) {
    // Find the bucket index that best matches
    const idx = this._bucketIndexFor(startMs);
    if (idx >= 0 && idx < this.buckets.length) {
      this._selectedIndex = idx;
      this.state.timelineFilter = { startMs, endMs };
      this._onFilterChange();
      this._updateSelectionHighlight();
    }
  }

  /**
   * Remove time-range filter (alias for clearSelection).
   */
  clearFilter() {
    this._clearSelection();
  }

  /**
   * Remove time-range filter + visual highlight.
   */
  clearSelection() {
    this._clearSelection();
  }

  // ── Public API: Visibility ──

  /** Show the timeline panel. */
  show() {
    this._visible = true;
    if (this._el) {
      this._el.style.display = '';
      // Refresh bars if data changed while hidden
      if (this.state.logBuffer && this.state.logBuffer.count > 0 && !this.buckets.length) {
        this.rebuild();
      }
    }
  }

  /** Hide the timeline panel. */
  hide() {
    this._visible = false;
    if (this._el) {
      this._el.style.display = 'none';
    }
  }

  /** Toggle timeline panel visibility. */
  toggle() {
    if (this._visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  // ── Public getters ──

  /** @returns {{ startMs: number, endMs: number } | null} */
  get selectedBucket() {
    if (this._selectedIndex === -1 || !this.buckets[this._selectedIndex]) return null;
    const b = this.buckets[this._selectedIndex];
    return { startMs: b.startMs, endMs: b.endMs };
  }

  /** @returns {number} */
  get bucketCount() {
    return this._bucketCount;
  }

  // ── Private: DOM Creation ──

  _injectStyles() {
    if (ErrorTimeline._styleInjected) return;
    const style = document.createElement('style');
    style.textContent = ErrorTimeline._CSS;
    document.head.appendChild(style);
    this._styleEl = style;
    ErrorTimeline._styleInjected = true;
  }

  _createDOM() {
    const el = document.createElement('div');
    el.id = 'error-timeline';
    el.className = 'error-timeline';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Error frequency timeline');

    const bars = document.createElement('div');
    bars.className = 'etl-bars';

    const empty = document.createElement('div');
    empty.className = 'etl-empty';
    empty.textContent = 'Timeline will appear as logs arrive';

    const tooltip = document.createElement('div');
    tooltip.className = 'etl-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');

    el.appendChild(bars);
    el.appendChild(empty);
    el.appendChild(tooltip);

    this._el = el;
    this._barsEl = bars;
    this._emptyEl = empty;
    this._tooltipEl = tooltip;
  }

  // ── Private: Events ──

  _bindEvents() {
    this._barsEl.addEventListener('click', this._onClick);
    this._barsEl.addEventListener('dblclick', this._onDblClick);
    this._barsEl.addEventListener('mousemove', this._onMouseMove);
    this._barsEl.addEventListener('mouseleave', this._onMouseLeave);
    this._el.addEventListener('keydown', this._onKeyDown);
  }

  _unbindEvents() {
    if (this._barsEl) {
      this._barsEl.removeEventListener('click', this._onClick);
      this._barsEl.removeEventListener('dblclick', this._onDblClick);
      this._barsEl.removeEventListener('mousemove', this._onMouseMove);
      this._barsEl.removeEventListener('mouseleave', this._onMouseLeave);
    }
    if (this._el) {
      this._el.removeEventListener('keydown', this._onKeyDown);
    }
  }

  _onClick = (e) => {
    const col = e.target.closest('.etl-col');
    if (!col) return;

    const idx = parseInt(col.dataset.index, 10);
    const bucket = this.buckets[idx];
    if (!bucket || bucket.total === 0) return;

    // Toggle: if already selected, deselect
    if (this._selectedIndex === idx) {
      this._clearSelection();
      return;
    }

    this._selectedIndex = idx;

    this.state.timelineFilter = {
      startMs: bucket.startMs,
      endMs: bucket.endMs,
    };

    this._onFilterChange();
    this._updateSelectionHighlight();
  };

  _onDblClick = () => {
    if (this._selectedIndex === -1) return;
    this._clearSelection();
  };

  _onMouseMove = (e) => {
    const col = e.target.closest('.etl-col');
    if (!col) {
      this._hideTooltip();
      return;
    }

    const idx = parseInt(col.dataset.index, 10);
    const bucket = this.buckets[idx];
    if (!bucket) {
      this._hideTooltip();
      return;
    }

    // Format time range
    const fmt = (ms) => {
      const d = new Date(ms);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      return `${h}:${m}:${s}`;
    };

    // Build tooltip text — textContent only, no innerHTML
    const parts = [];
    if (bucket.error) parts.push(`${bucket.error} error${bucket.error > 1 ? 's' : ''}`);
    if (bucket.warning) parts.push(`${bucket.warning} warning${bucket.warning > 1 ? 's' : ''}`);
    if (bucket.message) parts.push(`${bucket.message} info`);

    this._tooltipEl.textContent =
      `${fmt(bucket.startMs)} \u2013 ${fmt(bucket.endMs)} \u00B7 ${parts.length ? parts.join(', ') : 'no entries'}`;

    // Position: horizontally centered on column, above chart
    const colRect = col.getBoundingClientRect();
    const chartRect = this._el.getBoundingClientRect();
    let left = colRect.left - chartRect.left + colRect.width / 2;

    // Clamp to container bounds
    this._tooltipEl.style.display = 'block';
    const tipWidth = this._tooltipEl.offsetWidth;
    const chartWidth = chartRect.width;
    left = Math.max(tipWidth / 2, Math.min(left, chartWidth - tipWidth / 2));

    this._tooltipEl.style.left = `${left}px`;
  };

  _onMouseLeave = () => {
    this._hideTooltip();
  };

  _onKeyDown = (e) => {
    if (e.key === 'Escape' && this._selectedIndex !== -1) {
      this._clearSelection();
      e.stopPropagation();
    }
  };

  _hideTooltip() {
    if (this._tooltipEl) {
      this._tooltipEl.style.display = 'none';
    }
  }

  // ── Private: Selection ──

  _clearSelection() {
    this._selectedIndex = -1;
    if (this.state) {
      this.state.timelineFilter = null;
    }
    this._onFilterChange();
    this._updateSelectionHighlight();
  }

  _updateSelectionHighlight() {
    if (!this._barsEl) return;
    const cols = this._barsEl.children;
    for (let i = 0; i < cols.length; i++) {
      cols[i].classList.toggle('etl-selected', i === this._selectedIndex);
      cols[i].classList.toggle('etl-dimmed', this._selectedIndex !== -1 && i !== this._selectedIndex);
    }
  }

  // ── Private: Bucketing ──

  /**
   * Parse timestamp from entry, using cached _tsMs when available.
   * @param {Object} entry
   * @returns {number} milliseconds since epoch, or NaN
   */
  _parseTs(entry) {
    if (typeof entry._tsMs === 'number') return entry._tsMs;
    const ts = new Date(entry.timestamp).getTime();
    entry._tsMs = ts; // cache for future use
    return ts;
  }

  /**
   * Fast bucket index for a single entry timestamp.
   * @param {number} timestampMs
   * @returns {number} bucket index, or -1 if no buckets
   */
  _bucketIndexFor(timestampMs) {
    if (!this._bucketCount) return -1;
    return Math.min(
      Math.floor((timestampMs - this._timeOrigin) / this._bucketDuration),
      this._bucketCount - 1
    );
  }

  /**
   * Full rebuild of all bucket data from ring buffer. O(N).
   */
  _rebuildBuckets() {
    const rb = this.state.logBuffer;
    if (!rb || rb.count === 0) {
      this.buckets = [];
      this._bucketCount = 0;
      return;
    }

    // Determine time range
    const oldest = rb.getBySeq(rb.oldestSeq);
    const newest = rb.getBySeq(rb.newestSeq);
    if (!oldest || !newest) {
      this.buckets = [];
      this._bucketCount = 0;
      return;
    }

    const t0 = this._parseTs(oldest);
    const t1 = this._parseTs(newest);
    if (isNaN(t0) || isNaN(t1)) {
      this.buckets = [];
      this._bucketCount = 0;
      return;
    }

    const span = Math.max(t1 - t0, ErrorTimeline.MIN_SPAN_MS);

    // Determine bucket count: ~1 bucket per second, clamped [30, 60]
    const rawCount = Math.round(span / 1000);
    this._bucketCount = Math.min(ErrorTimeline.BUCKET_MAX, Math.max(ErrorTimeline.BUCKET_MIN, rawCount));
    this._bucketDuration = span / this._bucketCount;
    this._timeOrigin = t0;

    // Allocate buckets
    this.buckets = Array.from({ length: this._bucketCount }, (_, i) => ({
      startMs: t0 + i * this._bucketDuration,
      endMs: t0 + (i + 1) * this._bucketDuration,
      error: 0,
      warning: 0,
      message: 0,
      verbose: 0,
      total: 0,
    }));

    // Iterate ring buffer once — O(N) where N <= buffer capacity
    rb.forEach((entry) => {
      const ts = this._parseTs(entry);
      if (isNaN(ts)) return;

      const idx = Math.min(
        Math.floor((ts - t0) / this._bucketDuration),
        this._bucketCount - 1
      );
      if (idx < 0) return;

      const b = this.buckets[idx];
      const level = (entry.level || 'message').toLowerCase();
      if (b[level] !== undefined) b[level]++;
      b.total++;
    });

    // Track for staleness detection
    this._lastRebuildOldestSeq = rb.oldestSeq;
    this._batchesSinceRebuild = 0;
  }

  // ── Private: Rendering ──

  /**
   * Render or update all bar columns in the CSS grid.
   * Reuses existing DOM elements where possible.
   */
  _renderBars() {
    if (!this._barsEl) return;

    const maxCount = Math.max(1, ...this.buckets.map(b => b.total));

    // Reconcile DOM column count
    while (this._barsEl.children.length > this.buckets.length) {
      this._barsEl.removeChild(this._barsEl.lastChild);
    }
    while (this._barsEl.children.length < this.buckets.length) {
      this._barsEl.appendChild(this._createBarColumn());
    }

    for (let i = 0; i < this.buckets.length; i++) {
      const b = this.buckets[i];
      const col = this._barsEl.children[i];
      const pct = (b.total / maxCount) * 100;

      // Segment heights as % of column height (column-reverse stacks bottom-up)
      const errPct = b.total ? (b.error / b.total) * pct : 0;
      const warnPct = b.total ? (b.warning / b.total) * pct : 0;
      const msgPct = pct - errPct - warnPct;

      col._errSeg.style.height = `${errPct}%`;
      col._warnSeg.style.height = `${warnPct}%`;
      col._msgSeg.style.height = `${msgPct}%`;
      col.dataset.index = i;
      col.classList.toggle('etl-empty-bar', b.total === 0);
    }

    // Re-apply selection highlight after render
    this._updateSelectionHighlight();
  }

  /**
   * Create a single bar column element with stacked segments.
   * @returns {HTMLElement}
   */
  _createBarColumn() {
    const col = document.createElement('div');
    col.className = 'etl-col';

    const err = document.createElement('div');
    err.className = 'etl-seg etl-seg-error';

    const warn = document.createElement('div');
    warn.className = 'etl-seg etl-seg-warning';

    const msg = document.createElement('div');
    msg.className = 'etl-seg etl-seg-message';

    col.appendChild(err);
    col.appendChild(warn);
    col.appendChild(msg);

    // Direct references for fast style updates (no querySelector needed)
    col._errSeg = err;
    col._warnSeg = warn;
    col._msgSeg = msg;

    return col;
  }

  /**
   * Toggle empty state message vs bars grid.
   */
  _updateEmptyState() {
    if (!this._emptyEl || !this._barsEl) return;
    const isEmpty = !this.buckets.length || this.buckets.every(b => b.total === 0);
    this._emptyEl.style.display = isEmpty ? 'flex' : 'none';
    this._barsEl.style.display = isEmpty ? 'none' : 'grid';
  }

  // ── Private: ResizeObserver ──

  _startResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !this._el) return;

    this._resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width;

      if (width < ErrorTimeline.MIN_CONTAINER_WIDTH) {
        this._el.style.display = 'none';
        this._hideTooltip();
        return;
      }

      if (this._visible) {
        this._el.style.display = '';
      }
    });
    this._resizeObserver.observe(this._el);
  }
}
