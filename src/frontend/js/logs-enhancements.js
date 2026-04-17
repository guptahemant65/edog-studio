/**
 * EDOG Studio — Logs Enhancements
 * Breakpoints, bookmarks, error clustering, and marker-wise filtering.
 * Enhancement layer — does NOT modify renderer.js, filters.js, or logs.css.
 *
 * @requires renderer.js (Renderer class with virtual scroll)
 * @requires filters.js  (FilterManager)
 */

/* global Renderer, FilterManager */

// ===== LOGS ENHANCEMENTS =====

class LogsEnhancements {

  /** @type {string[]} Available breakpoint colors */
  static BP_COLORS = ['#e5940c', '#06b6d4', '#ec4899', '#84cc16', '#fb7185'];

  /** Minimum consecutive errors to form a cluster */
  static CLUSTER_THRESHOLD = 3;

  /** Max bookmarks to persist */
  static MAX_BOOKMARKS = 200;

  /**
   * @param {object} options
   * @param {HTMLElement} options.logsContainer  — #logs-container
   * @param {HTMLElement} options.breakpointsBar — #breakpoints-bar
   * @param {HTMLElement} options.bookmarksDrawer — #bookmarks-drawer
   * @param {object}      options.state          — shared viewer state
   * @param {object}      options.renderer       — Renderer instance
   */
  constructor(options) {
    this._logsContainer = options.logsContainer;
    this._breakpointsBar = options.breakpointsBar;
    this._bookmarksDrawer = options.bookmarksDrawer;
    this._state = options.state;
    this._renderer = options.renderer;

    /** @type {Map<string, BreakpointEntry>} */
    this._breakpoints = new Map();
    this._bpIdCounter = 0;
    this._bpColor = LogsEnhancements.BP_COLORS[0];
    this._bpInputVisible = false;

    /** @type {Map<number, BookmarkEntry>} seq -> bookmark */
    this._bookmarks = new Map();

    /** @type {ErrorCluster[]} */
    this._errorClusters = [];

    /** @type {string[]} active marker breakpoint ids for filtering */
    this._activeMarkers = [];
    this._markerFilterOpen = false;

    /** @type {ClusterEngine|null} — set via setClusterEngine() */
    this._clusterEngine = null;

    this._ready = false;
  }

  // ───────────────────────────────────────────────────────────────
  //  INIT
  // ───────────────────────────────────────────────────────────────

  init() {
    if (this._ready) return;
    this._ready = true;

    this._buildBreakpointsBarDOM();
    this._buildBookmarksDrawerDOM();
    this._buildMarkerFilterDOM();
    this._buildClusterSummaryDOM();
    this._bindKeyboard();
    this._injectGutterColumn();
  }

  // ───────────────────────────────────────────────────────────────
  //  BREAKPOINTS
  // ───────────────────────────────────────────────────────────────

  /**
   * Add a named breakpoint.
   * @param {string} name   — display label / regex pattern text
   * @param {number} logIndex — seq number of the matching log entry (first match)
   * @param {object} [opts]
   * @param {string} [opts.color]
   * @param {RegExp} [opts.regex]
   * @returns {string} breakpoint id
   */
  addBreakpoint(name, logIndex, opts = {}) {
    const id = 'bp-' + (++this._bpIdCounter);
    const color = opts.color || this._bpColor;
    let regex = opts.regex || null;

    if (!regex) {
      try { regex = new RegExp(name, 'i'); }
      catch (_) { regex = null; }
    }

    const bp = { id, name, logIndex, color, regex, enabled: true, matchCount: 0 };

    // Count matches
    if (regex && this._state && this._state.logBuffer) {
      const buf = this._state.logBuffer;
      for (let i = 0; i < buf.count; i++) {
        const entry = buf.getByIndex(i);
        if (entry && regex.test(entry.message || '')) bp.matchCount++;
      }
    }

    this._breakpoints.set(id, bp);
    this._renderBreakpointPills();
    this._updateMarkerFilter();
    this._openBreakpointsBar();
    return id;
  }

  /**
   * Remove a breakpoint by id.
   * @param {string} id
   */
  removeBreakpoint(id) {
    const pill = this._breakpointsBar.querySelector(`[data-bp-id="${id}"]`);
    if (pill) {
      pill.classList.add('le-bp-removing');
      setTimeout(() => {
        this._breakpoints.delete(id);
        this._activeMarkers = this._activeMarkers.filter(m => m !== id);
        this._renderBreakpointPills();
        this._updateMarkerFilter();
        if (this._breakpoints.size === 0) this._closeBreakpointsBar();
      }, 150);
    } else {
      this._breakpoints.delete(id);
      this._activeMarkers = this._activeMarkers.filter(m => m !== id);
      this._renderBreakpointPills();
      this._updateMarkerFilter();
      if (this._breakpoints.size === 0) this._closeBreakpointsBar();
    }
  }

  /**
   * Jump the log scroll to the breakpoint's first matched position.
   * @param {string} id
   */
  jumpToBreakpoint(id) {
    const bp = this._breakpoints.get(id);
    if (!bp || !bp.regex) return;

    const buf = this._state.logBuffer;
    if (!buf) return;

    for (let i = 0; i < buf.count; i++) {
      const entry = buf.getByIndex(i);
      if (entry && bp.regex.test(entry.message || '')) {
        this._scrollToSeq(entry.seq);
        this._flashRow(entry.seq, bp.color);
        break;
      }
    }
  }

  /**
   * Toggle breakpoint enabled state.
   * @param {string} id
   */
  toggleBreakpointEnabled(id) {
    const bp = this._breakpoints.get(id);
    if (!bp) return;
    bp.enabled = !bp.enabled;
    this._renderBreakpointPills();
    this._updateMarkerFilter();
  }

  // ───────────────────────────────────────────────────────────────
  //  BOOKMARKS
  // ───────────────────────────────────────────────────────────────

  /**
   * Toggle bookmark on a log entry.
   * @param {object} logEntry — log entry object
   * @returns {boolean} whether the entry is now bookmarked
   */
  toggleBookmark(logEntry) {
    if (!logEntry || logEntry.seq === undefined) return false;

    if (this._bookmarks.has(logEntry.seq)) {
      this._bookmarks.delete(logEntry.seq);
      this._updateBookmarkGutter(logEntry.seq, false);
      this._renderBookmarksDrawer();
      this._updateBookmarkBadge();
      return false;
    }

    if (this._bookmarks.size >= LogsEnhancements.MAX_BOOKMARKS) {
      // Evict oldest
      const oldest = this._bookmarks.keys().next().value;
      this._bookmarks.delete(oldest);
      this._updateBookmarkGutter(oldest, false);
    }

    this._bookmarks.set(logEntry.seq, {
      seq: logEntry.seq,
      timestamp: logEntry.timestamp,
      level: logEntry.level || 'Message',
      component: logEntry.component || 'Unknown',
      message: logEntry.message || '',
      addedAt: Date.now()
    });

    this._updateBookmarkGutter(logEntry.seq, true);
    this._renderBookmarksDrawer();
    this._updateBookmarkBadge();
    return true;
  }

  /**
   * @returns {object[]} all bookmarks sorted by timestamp
   */
  getBookmarks() {
    return [...this._bookmarks.values()].sort((a, b) => {
      return (a.timestamp || '').localeCompare(b.timestamp || '');
    });
  }

  /**
   * Check if a seq is bookmarked.
   * @param {number} seq
   * @returns {boolean}
   */
  isBookmarked(seq) {
    return this._bookmarks.has(seq);
  }

  /**
   * Remove all bookmarks.
   */
  clearAllBookmarks() {
    const seqs = [...this._bookmarks.keys()];
    this._bookmarks.clear();
    seqs.forEach(seq => this._updateBookmarkGutter(seq, false));
    this._renderBookmarksDrawer();
    this._updateBookmarkBadge();
  }

  // ───────────────────────────────────────────────────────────────
  //  ERROR CLUSTERING
  // ───────────────────────────────────────────────────────────────

  /**
   * Detect error clusters from a list of entries.
   * Delegates to ClusterEngine for global signature-based clustering
   * when available; falls back to legacy consecutive-only grouping.
   * @param {object[]} entries — array of log entry objects
   * @returns {object[]}
   */
  detectClusters(entries) {
    // Delegate to ClusterEngine for global grouping
    if (this._clusterEngine) {
      this._clusterEngine.rebuildFromBuffer(this._state.logBuffer);
      this._errorClusters = this._clusterEngine.getSortedClusters();
    } else {
      this._errorClusters = this._detectClustersLegacy(entries);
    }
    this._renderClusterSummary();
    return this._errorClusters;
  }

  /**
   * Legacy consecutive-only clustering (preserved as fallback).
   * @param {object[]} entries
   * @returns {object[]}
   */
  _detectClustersLegacy(entries) {
    const clusters = [];
    if (!entries || entries.length === 0) return clusters;

    let current = null;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isError = (entry.level || '').toLowerCase() === 'error';

      if (isError) {
        const sig = this._errorSignature(entry);
        if (current && current.signature === sig) {
          current.entries.push(entry);
          current.lastTimestamp = entry.timestamp;
        } else {
          if (current && current.entries.length >= LogsEnhancements.CLUSTER_THRESHOLD) {
            clusters.push(current);
          }
          current = {
            id: 'cluster-' + i,
            signature: sig,
            label: this._clusterLabel(entry),
            entries: [entry],
            firstTimestamp: entry.timestamp,
            lastTimestamp: entry.timestamp,
            expanded: false
          };
        }
      } else {
        if (current && current.entries.length >= LogsEnhancements.CLUSTER_THRESHOLD) {
          clusters.push(current);
        }
        current = null;
      }
    }

    if (current && current.entries.length >= LogsEnhancements.CLUSTER_THRESHOLD) {
      clusters.push(current);
    }

    return clusters;
  }

  /**
   * Toggle expand/collapse of a cluster.
   * @param {string} clusterKey — cluster id (legacy) or signature (global)
   */
  toggleCluster(clusterKey) {
    const cluster = this._errorClusters.find(
      c => c.id === clusterKey || c.signature === clusterKey
    );
    if (!cluster) return;
    cluster.expanded = !cluster.expanded;
    this._renderClusterSummary();
  }

  /**
   * Get current clusters.
   * @returns {ErrorCluster[]}
   */
  getClusters() {
    return this._errorClusters;
  }

  // ───────────────────────────────────────────────────────────────
  //  MARKER-WISE FILTERING
  // ───────────────────────────────────────────────────────────────

  /**
   * Set marker filter — show only logs matching selected breakpoint patterns.
   * @param {string[]} bpIds — array of breakpoint ids; empty = show all
   */
  setMarkerFilter(bpIds) {
    this._activeMarkers = bpIds || [];
    this._updateMarkerFilter();
  }

  /**
   * Test if a log entry passes the marker filter.
   * If no marker filter is active, all entries pass.
   * @param {object} entry
   * @returns {boolean}
   */
  passesMarkerFilter(entry) {
    if (this._activeMarkers.length === 0) return true;

    const msg = entry.message || '';
    for (const bpId of this._activeMarkers) {
      const bp = this._breakpoints.get(bpId);
      if (bp && bp.enabled && bp.regex && bp.regex.test(msg)) return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────
  //  EXPORT
  // ───────────────────────────────────────────────────────────────

  /**
   * Export bookmarks as JSON string.
   * @returns {string}
   */
  exportBookmarksJSON() {
    const bookmarks = this.getBookmarks().map(bm => ({
      timestamp: bm.timestamp,
      level: bm.level,
      component: bm.component,
      message: bm.message
    }));
    return JSON.stringify(bookmarks, null, 2);
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — DOM BUILDERS
  // ───────────────────────────────────────────────────────────────

  _buildBreakpointsBarDOM() {
    if (!this._breakpointsBar) return;

    this._breakpointsBar.innerHTML = '';
    this._breakpointsBar.classList.add('le-breakpoints-bar');

    // Pills container
    const pills = document.createElement('div');
    pills.className = 'le-bp-pills';
    pills.id = 'le-bp-pills';
    this._breakpointsBar.appendChild(pills);

    // Input row (hidden initially)
    const inputRow = document.createElement('div');
    inputRow.className = 'le-bp-input-row';
    inputRow.id = 'le-bp-input-row';
    inputRow.style.display = 'none';

    const input = document.createElement('input');
    input.className = 'le-bp-input';
    input.id = 'le-bp-input';
    input.type = 'text';
    input.placeholder = 'Enter regex pattern...';
    input.autocomplete = 'off';

    const colors = document.createElement('div');
    colors.className = 'le-bp-colors';
    LogsEnhancements.BP_COLORS.forEach((c, i) => {
      const pick = document.createElement('div');
      pick.className = 'le-bp-color-pick' + (i === 0 ? ' selected' : '');
      pick.dataset.color = c;
      pick.style.background = c;
      pick.title = c;
      pick.addEventListener('click', () => {
        colors.querySelectorAll('.le-bp-color-pick').forEach(p => p.classList.remove('selected'));
        pick.classList.add('selected');
        this._bpColor = c;
      });
      colors.appendChild(pick);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'le-bp-add-btn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', () => this._handleAddBreakpoint());

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'le-bp-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this._hideBreakpointInput());

    const errorMsg = document.createElement('span');
    errorMsg.className = 'le-bp-error-msg';
    errorMsg.id = 'le-bp-error';

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handleAddBreakpoint();
      if (e.key === 'Escape') this._hideBreakpointInput();
    });

    inputRow.appendChild(input);
    inputRow.appendChild(colors);
    inputRow.appendChild(addBtn);
    inputRow.appendChild(cancelBtn);
    inputRow.appendChild(errorMsg);
    this._breakpointsBar.appendChild(inputRow);
  }

  _buildBookmarksDrawerDOM() {
    if (!this._bookmarksDrawer) return;

    const list = this._bookmarksDrawer.querySelector('#bm-list');
    if (list) {
      list.innerHTML = '';
      list.classList.add('le-bm-list');
    }

    // Bind existing close button
    const closeBtn = this._bookmarksDrawer.querySelector('.bm-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this._bookmarksDrawer.classList.remove('open');
      });
    }
  }

  _buildMarkerFilterDOM() {
    if (!this._breakpointsBar) return;

    // Create marker filter bar below breakpoints bar
    let markerBar = document.getElementById('le-marker-filter');
    if (!markerBar) {
      markerBar = document.createElement('div');
      markerBar.id = 'le-marker-filter';
      markerBar.className = 'le-marker-filter';
      this._breakpointsBar.parentNode.insertBefore(markerBar, this._breakpointsBar.nextSibling);
    }
  }

  _buildClusterSummaryDOM() {
    if (!this._logsContainer) return;

    let summary = document.getElementById('le-cluster-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.id = 'le-cluster-summary';
      summary.className = 'le-cluster-summary';
      summary.style.display = 'none';
      this._logsContainer.parentNode.insertBefore(summary, this._logsContainer);
    }
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — GUTTER INJECTION
  // ───────────────────────────────────────────────────────────────

  /**
   * Patch the renderer's _populateRow to inject a bookmark star gutter.
   * Non-destructive — wraps the existing method.
   */
  _injectGutterColumn() {
    if (!this._renderer) return;

    const origPopulate = this._renderer._populateRow.bind(this._renderer);
    const self = this;

    this._renderer._populateRow = function(row, entry, seq, filteredIdx) {
      origPopulate(row, entry, seq, filteredIdx);

      // Inject gutter if not present
      if (!row._leGutter) {
        const gutter = document.createElement('span');
        gutter.className = 'le-gutter';
        const star = document.createElement('span');
        star.className = 'le-star';
        star.textContent = '\u2606'; // empty star
        star.title = 'Bookmark (Ctrl+B)';
        gutter.appendChild(star);
        row.insertBefore(gutter, row.firstChild);
        row._leGutter = gutter;
        row._leStar = star;

        star.addEventListener('click', (e) => {
          e.stopPropagation();
          const currentEntry = self._state.logBuffer.getBySeq(row._seq);
          if (currentEntry) self.toggleBookmark(currentEntry);
        });
      }

      // Update star state
      const isBookmarked = self._bookmarks.has(seq);
      row._leStar.textContent = isBookmarked ? '\u2605' : '\u2606';
      row._leStar.classList.toggle('le-star-filled', isBookmarked);
      row.classList.toggle('le-bookmarked', isBookmarked);

      // Breakpoint line marker
      if (!row._leBpMarker) {
        const marker = document.createElement('span');
        marker.className = 'le-bp-marker';
        marker.style.display = 'none';
        row.appendChild(marker);
        row._leBpMarker = marker;
      }

      // Check if entry matches any breakpoint
      const msg = entry.message || '';
      let matchedBp = null;
      for (const bp of self._breakpoints.values()) {
        if (bp.enabled && bp.regex && bp.regex.test(msg)) {
          matchedBp = bp;
          break;
        }
      }

      if (matchedBp) {
        row._leBpMarker.style.display = '';
        row._leBpMarker.style.setProperty('--bp-color', matchedBp.color);
        row.classList.add('le-bp-hit');
      } else {
        row._leBpMarker.style.display = 'none';
        row.classList.remove('le-bp-hit');
      }
    };
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — BREAKPOINT RENDERING
  // ───────────────────────────────────────────────────────────────

  _renderBreakpointPills() {
    const container = document.getElementById('le-bp-pills');
    if (!container) return;
    container.innerHTML = '';

    for (const bp of this._breakpoints.values()) {
      const pill = document.createElement('div');
      pill.className = 'le-bp-pill' + (bp.enabled ? '' : ' disabled');
      pill.dataset.bpId = bp.id;

      const dot = document.createElement('span');
      dot.className = 'le-bp-dot';
      dot.style.background = bp.color;

      const label = document.createElement('span');
      label.className = 'le-bp-label';
      label.textContent = bp.name;

      const count = document.createElement('span');
      count.className = 'le-bp-count';
      count.textContent = bp.matchCount > 0 ? bp.matchCount.toString() : '';

      const remove = document.createElement('span');
      remove.className = 'le-bp-remove';
      remove.textContent = '\u2715';
      remove.title = 'Remove breakpoint';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeBreakpoint(bp.id);
      });

      pill.appendChild(dot);
      pill.appendChild(label);
      if (bp.matchCount > 0) pill.appendChild(count);
      pill.appendChild(remove);

      pill.addEventListener('click', () => this.jumpToBreakpoint(bp.id));
      pill.addEventListener('dblclick', () => this.toggleBreakpointEnabled(bp.id));

      container.appendChild(pill);
    }
  }

  _openBreakpointsBar() {
    if (this._breakpointsBar) {
      this._breakpointsBar.classList.add('le-open');
    }
  }

  _closeBreakpointsBar() {
    if (this._breakpointsBar && this._breakpoints.size === 0) {
      this._breakpointsBar.classList.remove('le-open');
    }
  }

  _showBreakpointInput() {
    const row = document.getElementById('le-bp-input-row');
    if (!row) return;
    row.style.display = '';
    this._openBreakpointsBar();
    this._bpInputVisible = true;
    const input = document.getElementById('le-bp-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    const errEl = document.getElementById('le-bp-error');
    if (errEl) errEl.textContent = '';
  }

  _hideBreakpointInput() {
    const row = document.getElementById('le-bp-input-row');
    if (row) row.style.display = 'none';
    this._bpInputVisible = false;
    if (this._breakpoints.size === 0) this._closeBreakpointsBar();
  }

  _handleAddBreakpoint() {
    const input = document.getElementById('le-bp-input');
    const errEl = document.getElementById('le-bp-error');
    if (!input) return;

    const pattern = input.value.trim();
    if (!pattern) {
      if (errEl) errEl.textContent = 'Pattern required';
      input.classList.add('le-bp-input-error');
      return;
    }

    let regex;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (e) {
      if (errEl) errEl.textContent = 'Invalid regex: ' + e.message;
      input.classList.add('le-bp-input-error');
      return;
    }

    input.classList.remove('le-bp-input-error');
    this.addBreakpoint(pattern, -1, { color: this._bpColor, regex });
    this._hideBreakpointInput();
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — BOOKMARKS RENDERING
  // ───────────────────────────────────────────────────────────────

  _renderBookmarksDrawer() {
    const list = this._bookmarksDrawer
      ? this._bookmarksDrawer.querySelector('#bm-list')
      : null;
    if (!list) return;

    list.innerHTML = '';
    const bookmarks = this.getBookmarks();

    if (bookmarks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'le-bm-empty';
      empty.innerHTML =
        '<span class="le-bm-empty-icon">\u2606</span>' +
        '<span>No bookmarks yet</span>' +
        '<span class="le-bm-empty-hint">Click the \u2606 icon on any log entry</span>';
      list.appendChild(empty);
      return;
    }

    bookmarks.forEach(bm => {
      const item = document.createElement('div');
      item.className = 'le-bm-entry';

      const meta = document.createElement('div');
      meta.className = 'le-bm-entry-meta';

      const time = document.createElement('span');
      time.className = 'le-bm-time';
      time.textContent = this._formatTimeShort(bm.timestamp);

      const level = document.createElement('span');
      level.className = 'le-bm-level le-bm-level-' + bm.level.toLowerCase();
      level.textContent = bm.level;

      const remove = document.createElement('span');
      remove.className = 'le-bm-remove';
      remove.textContent = '\u2715';
      remove.title = 'Remove bookmark';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this._bookmarks.delete(bm.seq);
        this._updateBookmarkGutter(bm.seq, false);
        this._renderBookmarksDrawer();
        this._updateBookmarkBadge();
      });

      meta.appendChild(time);
      meta.appendChild(level);
      meta.appendChild(remove);

      const msg = document.createElement('div');
      msg.className = 'le-bm-entry-msg';
      msg.textContent = bm.message.length > 200
        ? bm.message.substring(0, 200) + '\u2026'
        : bm.message;

      item.appendChild(meta);
      item.appendChild(msg);

      item.addEventListener('click', () => {
        this._scrollToSeq(bm.seq);
        this._flashRow(bm.seq, '#f5a623');
      });

      list.appendChild(item);
    });
  }

  _updateBookmarkGutter(seq, isBookmarked) {
    // Find rendered row by seq and update gutter in the virtual scroll
    if (!this._renderer || !this._renderer.renderedRows) return;

    for (const [, row] of this._renderer.renderedRows) {
      if (row._seq === seq && row._leStar) {
        row._leStar.textContent = isBookmarked ? '\u2605' : '\u2606';
        row._leStar.classList.toggle('le-star-filled', isBookmarked);
        row.classList.toggle('le-bookmarked', isBookmarked);
      }
    }
  }

  _updateBookmarkBadge() {
    // Update the header badge in the existing bookmarks drawer
    const header = this._bookmarksDrawer
      ? this._bookmarksDrawer.querySelector('.bm-title')
      : null;
    if (header) {
      const count = this._bookmarks.size;
      header.textContent = '\u2733 Bookmarks' + (count > 0 ? ' (' + count + ')' : '');
    }
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — CLUSTER RENDERING
  // ───────────────────────────────────────────────────────────────

  _renderClusterSummary() {
    const summary = document.getElementById('le-cluster-summary');
    if (!summary) return;

    const clusters = this._clusterEngine
      ? this._clusterEngine.getSortedClusters()
      : this._errorClusters;

    if (clusters.length === 0) {
      summary.style.display = 'none';
      return;
    }

    summary.style.display = '';
    summary.textContent = '';

    // Header
    const header = document.createElement('div');
    header.className = 'le-cluster-header';
    header.textContent = clusters.length + ' error pattern'
      + (clusters.length > 1 ? 's' : '') + ' detected';
    summary.appendChild(header);

    // Show max 10 clusters, with overflow indicator
    const displayLimit = 10;
    const displayClusters = clusters.slice(0, displayLimit);

    displayClusters.forEach(cluster => {
      const row = document.createElement('div');
      row.className = 'le-cluster-row' + (cluster.expanded ? ' expanded' : '');

      // Count badge
      const count = document.createElement('span');
      count.className = 'le-cluster-count';
      count.textContent = cluster.count + '\u00d7';

      // Error code / label (safe text)
      const label = document.createElement('span');
      label.className = 'le-cluster-text';
      const labelStr = cluster.code || cluster.label || cluster.signature || '';
      label.textContent = labelStr.length > 40
        ? labelStr.substring(0, 40) + '\u2026'
        : labelStr;
      label.title = cluster.label || cluster.signature || '';

      // Trend badge
      const trend = this._createTrendBadge(cluster);

      // Time range
      const time = document.createElement('span');
      time.className = 'le-cluster-time';
      time.textContent = this._formatTimeShort(cluster.firstSeen)
        + ' \u2013 ' + this._formatTimeShort(cluster.lastSeen);

      // Node pills
      const nodesContainer = document.createElement('span');
      nodesContainer.className = 'le-cluster-nodes';
      const nodeSet = cluster.nodes instanceof Set ? cluster.nodes : new Set();
      if (nodeSet.size > 0) {
        for (const nodeName of nodeSet) {
          const nodePill = document.createElement('span');
          nodePill.className = 'le-cluster-node-pill';
          const truncated = nodeName.length > 30
            ? nodeName.substring(0, 27) + '\u2026'
            : nodeName;
          nodePill.textContent = truncated;
          nodePill.title = 'Error occurred in node: ' + nodeName;

          nodePill.addEventListener('click', (e) => {
            e.stopPropagation();
            this._navigateToDAGNode(nodeName);
          });

          nodesContainer.appendChild(nodePill);
        }
      } else {
        const dash = document.createElement('span');
        dash.className = 'le-cluster-no-nodes';
        dash.textContent = '\u2014';
        nodesContainer.appendChild(dash);
      }

      // Skipped nodes indicator
      if (cluster.skippedNodes && cluster.skippedNodes.length > 0) {
        const skip = document.createElement('span');
        skip.className = 'le-cluster-skipped';
        skip.textContent = 'Skipped: ' + cluster.skippedNodes.join(', ');
        skip.title = 'Downstream nodes skipped due to this error';
        nodesContainer.appendChild(skip);
      }

      // Expand chevron
      const chevron = document.createElement('span');
      chevron.className = 'le-cluster-chevron' + (cluster.expanded ? ' expanded' : '');
      chevron.textContent = '\u25B8';

      // Assemble row
      row.appendChild(count);
      row.appendChild(label);
      row.appendChild(trend);
      row.appendChild(time);
      row.appendChild(nodesContainer);
      row.appendChild(chevron);

      // Click handler: expand/collapse + jump to first entry
      row.addEventListener('click', () => {
        cluster.expanded = !cluster.expanded;
        this._renderClusterSummary();
        if (cluster.expanded && cluster.entries[0]) {
          const seq = cluster.entries[0].seq;
          if (seq !== undefined) this._scrollToSeq(seq);
        }
      });

      summary.appendChild(row);

      // Expanded: show matching entries
      if (cluster.expanded) {
        const entryList = document.createElement('div');
        entryList.className = 'le-cluster-entries';

        const displayCount = Math.min(cluster.entries.length, 50);
        for (let i = 0; i < displayCount; i++) {
          const e = cluster.entries[i];
          const entryRow = document.createElement('div');
          entryRow.className = 'le-cluster-entry-row';
          entryRow.textContent = this._formatTimeShort(e.timestamp)
            + ' ' + (e.message || '').substring(0, 120);
          entryRow.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (e.seq !== undefined) this._scrollToSeq(e.seq);
          });
          entryList.appendChild(entryRow);
        }

        if (cluster.entries.length > 50) {
          const more = document.createElement('div');
          more.className = 'le-cluster-more';
          more.textContent = '+ ' + (cluster.entries.length - 50) + ' more entries';
          entryList.appendChild(more);
        }

        summary.appendChild(entryList);
      }
    });

    // Overflow indicator for >10 clusters
    if (clusters.length > displayLimit) {
      const overflow = document.createElement('div');
      overflow.className = 'le-cluster-overflow';
      overflow.textContent = '+ ' + (clusters.length - displayLimit) + ' more patterns';
      summary.appendChild(overflow);
    }
  }

  /**
   * Create a trend badge element for a cluster.
   * @param {object} cluster
   * @returns {HTMLElement}
   */
  _createTrendBadge(cluster) {
    const badge = document.createElement('span');
    badge.className = 'le-cluster-trend';
    const arrow = cluster.trend || '\u2192';
    badge.textContent = arrow;

    if (arrow === '\u2191') {
      badge.classList.add('le-trend-rising');
      badge.title = 'Increasing \u2014 error rate rising >20% vs previous 60s';
    } else if (arrow === '\u2193') {
      badge.classList.add('le-trend-falling');
      badge.title = 'Decreasing \u2014 error rate falling >20% vs previous 60s';
    } else {
      badge.classList.add('le-trend-stable');
      badge.title = 'Stable \u2014 error rate within \u00b120% vs previous 60s';
    }

    return badge;
  }

  /**
   * Navigate to a DAG node by switching to the DAG tab and dispatching
   * a custom event. No-op if DAG tab is not available.
   * @param {string} nodeName
   */
  _navigateToDAGNode(nodeName) {
    const dagTab = document.querySelector('[data-tab="dag"]');
    if (!dagTab) return;

    dagTab.click();

    window.dispatchEvent(new CustomEvent('edog:navigate-to-node', {
      detail: { nodeName }
    }));
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — MARKER FILTER RENDERING
  // ───────────────────────────────────────────────────────────────

  _updateMarkerFilter() {
    const bar = document.getElementById('le-marker-filter');
    if (!bar) return;

    if (this._breakpoints.size === 0) {
      bar.classList.remove('le-open');
      bar.innerHTML = '';
      return;
    }

    bar.classList.add('le-open');
    bar.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'le-marker-label';
    label.textContent = 'SHOW:';
    bar.appendChild(label);

    // "All" pill
    const allPill = document.createElement('span');
    allPill.className = 'le-marker-pill' + (this._activeMarkers.length === 0 ? ' active' : '');
    allPill.textContent = 'All';
    allPill.addEventListener('click', () => {
      this._activeMarkers = [];
      this._updateMarkerFilter();
    });
    bar.appendChild(allPill);

    // Breakpoint marker pills
    for (const bp of this._breakpoints.values()) {
      if (!bp.enabled) continue;

      const pill = document.createElement('span');
      pill.className = 'le-marker-pill'
        + (this._activeMarkers.includes(bp.id) ? ' active' : '');

      const dot = document.createElement('span');
      dot.className = 'le-marker-dot';
      dot.style.background = bp.color;

      const pillLabel = document.createElement('span');
      pillLabel.textContent = bp.name;

      if (bp.matchCount > 0) {
        const cnt = document.createElement('span');
        cnt.className = 'le-marker-count';
        cnt.textContent = bp.matchCount.toString();
        pill.appendChild(dot);
        pill.appendChild(pillLabel);
        pill.appendChild(cnt);
      } else {
        pill.appendChild(dot);
        pill.appendChild(pillLabel);
      }

      pill.addEventListener('click', () => {
        const idx = this._activeMarkers.indexOf(bp.id);
        if (idx >= 0) {
          this._activeMarkers.splice(idx, 1);
        } else {
          this._activeMarkers.push(bp.id);
        }
        this._updateMarkerFilter();
      });

      bar.appendChild(pill);
    }
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — KEYBOARD
  // ───────────────────────────────────────────────────────────────

  _bindKeyboard() {
    this._onDocKeyDown = (e) => {
      // Only handle when the logs tab container is visible
      if (!this._logsContainer || !this._logsContainer.offsetParent) return;

      // Ctrl+B — toggle bookmark on selected/focused row
      if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
        // Don't intercept if user is typing in an input
        if (this._isInputFocused()) return;
        e.preventDefault();
        this._bookmarkFocusedRow();
        return;
      }

      // Ctrl+Shift+B — open breakpoint input
      if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        if (this._isInputFocused()) return;
        e.preventDefault();
        if (this._bpInputVisible) {
          this._hideBreakpointInput();
        } else {
          this._showBreakpointInput();
        }
        return;
      }
    };
    document.addEventListener('keydown', this._onDocKeyDown);
  }

  _isInputFocused() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select'
      || el.isContentEditable;
  }

  _bookmarkFocusedRow() {
    // Try to find the focused/selected row
    if (!this._renderer || !this._renderer.renderedRows) return;

    // Use the row with the detail panel open, or the last clicked row
    const detailPanel = document.getElementById('detail-panel');
    if (detailPanel && !detailPanel.classList.contains('hidden')
        && window.edogViewer && window.edogViewer._selectedEntry) {
      this.toggleBookmark(window.edogViewer._selectedEntry);
      return;
    }

    // Fallback: bookmark the row in the middle of the viewport
    if (!this._logsContainer) return;
    const scrollTop = this._logsContainer.scrollTop;
    const viewportMid = scrollTop + this._logsContainer.clientHeight / 2;
    const rowHeight = this._renderer.ROW_HEIGHT || 34;
    const midIdx = Math.floor(viewportMid / rowHeight);

    if (this._state && this._state.filterIndex) {
      const seq = this._state.filterIndex.seqAt(midIdx);
      if (seq !== undefined) {
        const entry = this._state.logBuffer.getBySeq(seq);
        if (entry) this.toggleBookmark(entry);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — SCROLL & FLASH
  // ───────────────────────────────────────────────────────────────

  _scrollToSeq(seq) {
    if (!this._renderer || !this._state || !this._state.filterIndex) return;

    const idx = this._state.filterIndex.indexOfSeq(seq);
    if (idx < 0) return;

    const rowHeight = this._renderer.ROW_HEIGHT || 34;
    const targetScroll = idx * rowHeight - this._logsContainer.clientHeight / 2 + rowHeight / 2;

    if (this._state.autoScroll) {
      this._state.autoScroll = false;
    }

    this._logsContainer.scrollTop = Math.max(0, targetScroll);

    // Force rerender at new scroll position
    this._renderer.scheduleRender();
  }

  _flashRow(seq, color) {
    requestAnimationFrame(() => {
      if (!this._renderer || !this._renderer.renderedRows) return;

      for (const [, row] of this._renderer.renderedRows) {
        if (row._seq === seq) {
          row.style.setProperty('--le-flash-color', color || '#f5a623');
          row.classList.add('le-flash');
          setTimeout(() => row.classList.remove('le-flash'), 600);
          break;
        }
      }
    });
  }

  // ───────────────────────────────────────────────────────────────
  //  PRIVATE — UTILITIES
  // ───────────────────────────────────────────────────────────────

  _errorSignature(entry) {
    const msg = (entry.message || '').substring(0, 80);
    // Extract the exception type or first significant phrase
    const match = msg.match(/^(\w+Exception|\w+Error)/);
    return match ? match[1] : msg.replace(/[0-9a-f-]{8,}/gi, '***').substring(0, 60);
  }

  _clusterLabel(entry) {
    const msg = entry.message || '';
    const colonIdx = msg.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) return msg.substring(0, colonIdx);
    return msg.substring(0, 50);
  }

  _formatTimeShort(isoString) {
    if (!isoString) return '--:--:--';
    const tIdx = isoString.indexOf('T');
    if (tIdx >= 0) {
      const timePart = isoString.substring(tIdx + 1);
      const dotIdx = timePart.indexOf('.');
      if (dotIdx >= 8) return timePart.substring(0, dotIdx);
      return timePart.substring(0, 8);
    }
    // Fallback for HH:MM:SS.mmm format
    const dotIdx = isoString.indexOf('.');
    if (dotIdx >= 8) return isoString.substring(0, dotIdx);
    return isoString.substring(0, 8);
  }

  /**
   * Public trigger to show breakpoint input (for toolbar "+" link).
   */
  showBreakpointInput() {
    this._showBreakpointInput();
  }

  /**
   * Open/close the bookmarks drawer.
   */
  toggleBookmarksDrawer() {
    if (!this._bookmarksDrawer) return;
    const isOpen = this._bookmarksDrawer.classList.contains('open');
    if (isOpen) {
      this._bookmarksDrawer.classList.remove('open');
    } else {
      this._renderBookmarksDrawer();
      this._bookmarksDrawer.classList.add('open');
    }
  }

  /**
   * Re-detect clusters from the current log buffer.
   * Call after new logs arrive or filters change.
   */
  refreshClusters() {
    if (!this._state || !this._state.logBuffer) return;

    if (this._clusterEngine) {
      // Use ClusterEngine for global clustering
      this._clusterEngine.rebuildFromBuffer(this._state.logBuffer);
      this._errorClusters = this._clusterEngine.getSortedClusters();
      this._renderClusterSummary();
    } else {
      // Legacy fallback: scan all entries
      const entries = [];
      const buf = this._state.logBuffer;
      for (let i = 0; i < buf.count; i++) {
        const entry = buf.getByIndex(i);
        if (entry) entries.push(entry);
      }
      this.detectClusters(entries);
    }
  }

  /**
   * Attach a ClusterEngine instance (from ErrorIntelligence).
   * Once attached, detectClusters and refreshClusters delegate to it.
   * @param {ClusterEngine} engine
   */
  setClusterEngine(engine) {
    this._clusterEngine = engine || null;
  }
}
