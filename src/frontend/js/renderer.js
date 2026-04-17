/**
 * EDOG Real-Time Log Viewer - DOM Renderer
 * V2: Virtual scroll, DOM recycling pool, event delegation
 * F12: Highlight engine — controlled innerHTML for search + error code decoration
 */

// ===== ROW POOL =====

class RowPool {
  constructor(poolSize) {
    this.pool = [];
    this.poolSize = poolSize;

    for (let i = 0; i < poolSize; i++) {
      this.pool.push(this._createRowTemplate());
    }
  }

  _createRowTemplate() {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.style.position = 'absolute';
    row.style.left = '0';
    row.style.right = '0';
    row.style.height = '34px';
    row.style.boxSizing = 'border-box';
    row.style.willChange = 'transform';

    const time = document.createElement('span');
    time.className = 'log-time';

    const level = document.createElement('span');
    level.className = 'level-badge';

    const component = document.createElement('span');
    component.className = 'log-component';

    const message = document.createElement('span');
    message.className = 'log-message';

    row.appendChild(time);
    row.appendChild(level);
    row.appendChild(component);
    row.appendChild(message);

    row._time = time;
    row._level = level;
    row._component = component;
    row._message = message;
    row._seq = -1;
    row._inUse = false;

    return row;
  }

  acquire() {
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i]._inUse) {
        this.pool[i]._inUse = true;
        return this.pool[i];
      }
    }
    const row = this._createRowTemplate();
    row._inUse = true;
    this.pool.push(row);
    return row;
  }

  release(row) {
    row._inUse = false;
    row._seq = -1;
    if (row.parentNode) {
      row.parentNode.removeChild(row);
    }
  }

  releaseAll() {
    for (let i = 0; i < this.pool.length; i++) {
      this.pool[i]._inUse = false;
      this.pool[i]._seq = -1;
      if (this.pool[i].parentNode) {
        this.pool[i].parentNode.removeChild(this.pool[i]);
      }
    }
  }
}

// ===== HIGHLIGHT ENGINE (F12 — Error Intelligence) =====
// Module-level pure functions for the 6-step innerHTML escaping pipeline.
// SECURITY INVARIANT: All user-controlled text is HTML-escaped BEFORE any
// highlight tag insertion. Tags contain only hardcoded class names and
// regex-validated data-code values. The order is NEVER reversed.

/**
 * Build a mapping from raw text character positions to escaped HTML positions.
 * Required because HTML escaping changes string length (e.g. '<' → '&lt;' is 1→4).
 *
 * @param {string} rawText — the unescaped message string
 * @returns {number[]} map where map[rawIdx] = escapedIdx, length = rawText.length + 1
 */
function buildOffsetMap(rawText) {
  const map = new Array(rawText.length + 1);
  let escapedIdx = 0;
  for (let i = 0; i < rawText.length; i++) {
    map[i] = escapedIdx;
    const ch = rawText.charCodeAt(i);
    if (ch === 38) escapedIdx += 5;       // & → &amp;
    else if (ch === 60) escapedIdx += 4;  // < → &lt;
    else if (ch === 62) escapedIdx += 4;  // > → &gt;
    else if (ch === 34) escapedIdx += 6;  // " → &quot;
    else if (ch === 39) escapedIdx += 5;  // ' → &#39;
    else escapedIdx += 1;
  }
  map[rawText.length] = escapedIdx;
  return map;
}

/**
 * Build the opening HTML tag for a highlight range.
 * Only produces tags from the allowed whitelist (§14):
 *   <mark class="search-hit">
 *   <span class="error-code-known" data-code="...">
 *   <span class="error-code-unknown" data-code="...">
 *
 * @param {Object} highlight — a HighlightRange object
 * @returns {string} opening tag string
 */
function buildOpenTag(highlight) {
  if (highlight.className === 'search-hit') {
    if (highlight.current) {
      return '<mark class="log-search-match log-search-current">';
    }
    return '<mark class="log-search-match">';
  }
  // Error code span — data.code is regex-verified [A-Z0-9_]+ by ErrorDecoder
  let tag = '<span class="log-error-code log-error-code--' +
    (highlight.className === 'error-code-known' ? 'known' : 'unknown') + '"';
  if (highlight.data && highlight.data.code) {
    tag += ' data-code="' + highlight.data.code + '"';
  }
  tag += '>';
  return tag;
}

/**
 * Resolve overlapping highlights by priority. Higher-priority ranges claim
 * their positions first; lower-priority ranges are clipped or discarded.
 *
 * @param {Array} highlights — unsorted, potentially overlapping HighlightRange[]
 * @returns {Array} sorted, non-overlapping HighlightRange[]
 */
function resolveOverlaps(highlights) {
  if (highlights.length <= 1) return highlights;

  const PRIORITY = { 'error-code-known': 0, 'error-code-unknown': 1, 'search-hit': 2 };
  highlights.sort((a, b) => {
    const pd = (PRIORITY[a.className] || 0) - (PRIORITY[b.className] || 0);
    return pd !== 0 ? pd : a.start - b.start;
  });

  const occupied = [];
  const result = [];

  for (const h of highlights) {
    let s = h.start;
    let e = h.end;

    for (let j = 0; j < occupied.length; j++) {
      const os = occupied[j][0];
      const oe = occupied[j][1];
      if (s < oe && e > os) {
        if (s >= os && e <= oe) { s = e; break; }
        if (s < os && e > os) { e = os; }
        if (s < oe && e > oe) { s = oe; }
      }
    }

    if (s < e) {
      result.push({ start: s, end: e, className: h.className, data: h.data, current: h.current });
      occupied.push([s, e]);
    }
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}

/**
 * Find all case-insensitive occurrences of a search term in raw text.
 *
 * @param {string} rawText — the unescaped message string
 * @param {string} searchTerm — the user's search text (literal, not regex)
 * @param {number} [currentMatchIdx] — index of the "current" match to navigate to
 * @returns {Array} HighlightRange[] with className 'search-hit'
 */
function computeSearchHighlights(rawText, searchTerm, currentMatchIdx) {
  if (!searchTerm || !rawText) return [];
  const ranges = [];
  const textLower = rawText.toLowerCase();
  const termLower = searchTerm.toLowerCase();
  const termLen = termLower.length;
  let pos = 0;
  let matchCount = 0;
  while (pos <= textLower.length - termLen) {
    const idx = textLower.indexOf(termLower, pos);
    if (idx === -1) break;
    const range = { start: idx, end: idx + termLen, className: 'search-hit' };
    if (currentMatchIdx !== undefined && matchCount === currentMatchIdx) {
      range.current = true;
    }
    ranges.push(range);
    pos = idx + termLen;
    matchCount++;
  }
  return ranges;
}

/**
 * Convert raw log text + highlight ranges into safe innerHTML.
 *
 * SECURITY INVARIANT: rawText is HTML-escaped FIRST (Step 2). Only hardcoded
 * <mark> and <span> tags are inserted (Step 4). User content NEVER bypasses escaping.
 *
 * @param {string} rawText — the truncated, unescaped message string
 * @param {Array} highlights — sorted, overlap-resolved HighlightRange[]
 * @param {Renderer} renderer — Renderer instance (for escapeHtml access)
 * @returns {string} safe HTML string ready for innerHTML assignment
 */
function applyHighlights(rawText, highlights, renderer) {
  // Step 2: Escape ALL text first (security gate)
  const escaped = renderer.escapeHtml(rawText);

  if (!highlights || highlights.length === 0) return escaped;

  // Step 4a: Build raw→escaped offset map
  const offsetMap = buildOffsetMap(rawText);

  // Step 4b: Insert tags at mapped positions (right-to-left preserves earlier positions)
  let html = escaped;
  for (let i = highlights.length - 1; i >= 0; i--) {
    const h = highlights[i];
    const eStart = offsetMap[h.start];
    const eEnd = offsetMap[h.end];
    const openTag = buildOpenTag(h);
    const closeTag = (h.className === 'search-hit') ? '</mark>' : '</span>';
    html = html.substring(0, eStart) + openTag + html.substring(eStart, eEnd) + closeTag + html.substring(eEnd);
  }

  return html;
}

// ===== VIRTUAL SCROLL RENDERER =====

class Renderer {
  constructor(state) {
    this.state = state;
    this.ROW_HEIGHT = 34;
    this.OVERSCAN = 8;
    this.MAX_VISIBLE = 80;
    this.rowPool = new RowPool(this.MAX_VISIBLE);
    this.renderScheduled = false;
    this.renderThrottleMs = 100;
    this.lastRenderTime = 0;
    this.pendingTimer = null;
    // Auto-scroll: suppress user-scroll-detection briefly after programmatic scrollTop changes
    this._scrollPinUntil = 0;

    // F12 Highlight Engine state
    this._highlightVersion = 0;
    this._searchTerm = '';
    this._currentSearchMatchIdx = -1;
    this._errorDecoder = null;

    // Virtual scroll state
    this.scrollContainer = null;
    this.sentinel = null;
    this.visibleStart = 0;
    this.visibleEnd = 0;
    this.renderedRows = new Map();
    this.containerReady = false;

    this._levelLetters = { verbose: 'V', message: 'I', warning: 'W', error: 'E' };

    // Component category classifier — matches CSS data-category selectors
    this._categoryRules = [
      [/^LiveTableController|^LiveTablePublicController|^LiveTable-ArtifactHandler|^LTWorkload/i, 'controller'],
      [/^DagExecution|^DagCancellation|^DagHook|^NodeExecution|^LiveTableSchedulerRun|^LiveTableMaintanance|^LiveTableRefreshTriggers|^Multischedule/i, 'dag'],
      [/^OneLake|^LiveTable-OL-|^Workload\.LiveTable\.OneLake/i, 'onelake'],
      [/^DqMetrics|^Insights|^GetDataQuality|^sys_/i, 'dq'],
      [/^Retry|^StandardRetry|^ErrorMessage|^Cancellation$/i, 'retry'],
    ];
  }

  // ===== INITIALIZATION =====

  initVirtualScroll() {
    this.scrollContainer = document.getElementById('logs-container');
    if (!this.scrollContainer) return;

    this.scrollContainer.style.contain = 'strict';
    this.scrollContainer.style.position = 'relative';

    this.sentinel = document.createElement('div');
    this.sentinel.id = 'vscroll-sentinel';
    this.sentinel.style.position = 'absolute';
    this.sentinel.style.top = '0';
    this.sentinel.style.left = '0';
    this.sentinel.style.width = '1px';
    this.sentinel.style.height = '0px';
    this.sentinel.style.visibility = 'hidden';
    this.sentinel.style.pointerEvents = 'none';
    this.scrollContainer.appendChild(this.sentinel);

    // Event delegation: single click handler for entire container
    this.scrollContainer.addEventListener('click', this._onContainerClick);

    // Scroll handler drives virtual scroll
    this.scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });

    // F12: Hover-freeze listeners (configurable via state.hoverFreezeEnabled)
    this.scrollContainer.addEventListener('mouseenter', this._onHoverEnter);
    this.scrollContainer.addEventListener('mouseleave', this._onHoverLeave);

    this.containerReady = true;
  }

  // ===== EVENT DELEGATION =====

  _onContainerClick = (e) => {
    let target = e.target;
    let row = null;
    while (target && target !== this.scrollContainer) {
      if (target.classList && target.classList.contains('log-row') && target._seq !== undefined) {
        row = target;
        break;
      }
      target = target.parentNode;
    }
    if (!row) return;

    const entry = this.state.logBuffer.getBySeq(row._seq);
    if (!entry) return;

    // Error code click → dispatch custom event for popover (F12 Highlight Engine)
    if (e.target.classList.contains('log-error-code--known') ||
        e.target.classList.contains('log-error-code--unknown')) {
      e.stopPropagation();
      const code = e.target.dataset.code;
      if (code) {
        const detail = { code, element: e.target };
        this.scrollContainer.dispatchEvent(
          new CustomEvent('error-code-click', { detail, bubbles: true })
        );
      }
      return;
    }

    // Component pill click → exclude
    if (e.target.classList.contains('log-component')) {
      e.stopPropagation();
      if (window.edogViewer && window.edogViewer.filter) {
        window.edogViewer.filter.excludeComponent(entry.component || 'Unknown');
      }
      return;
    }

    // Row click → detail panel
    if (window.edogViewer && window.edogViewer.detail) {
      window.edogViewer.detail.show(entry, 'log');
    }
  }

  _onScroll = () => {
    // Detect user scrolling away from bottom while LIVE
    if (this.state.streamMode === 'LIVE' && Date.now() > this._scrollPinUntil) {
      const c = this.scrollContainer;
      const isAtBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - this.ROW_HEIGHT * 2;
      if (!isAtBottom) {
        this._transitionToPaused('scroll');
      }
    }
    // When LIVE, suppress manual-scroll renders (prevent feedback loop)
    if (this.state.streamMode === 'LIVE') return;
    // PAUSED: user is scrolling manually — render the viewport
    if (!this.renderScheduled) {
      this.renderScheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  // ===== F12 STREAM CONTROLLER =====

  _transitionToPaused = (reason) => {
    if (this.state.streamMode === 'PAUSED') {
      // Upgrade pause reason if new reason is higher priority
      if (reason === 'scroll' && this.state.pauseReason === 'hover') {
        this.state.pauseReason = 'scroll';
      }
      return;
    }
    this.state.streamMode = 'PAUSED';
    this.state.pauseReason = reason;
    this.state.bufferedCount = 0;
    this._updateStreamBadge();
    if (window.edogViewer) window.edogViewer.showResumeButton();
  }

  _transitionToLive = () => {
    if (this.state.streamMode === 'LIVE') return;
    this.state.streamMode = 'LIVE';
    this.state.pauseReason = null;
    this.state.bufferedCount = 0;
    this._updateStreamBadge();
    if (window.edogViewer) window.edogViewer.hideResumeButton();
    this._scrollPinUntil = Date.now() + 80;
    this.flush();
    this.scrollToBottom();
  }

  _updateStreamBadge = () => {
    const badge = document.getElementById('stream-badge');
    if (!badge) return;
    const isLive = this.state.streamMode === 'LIVE';
    badge.dataset.mode = isLive ? 'live' : 'paused';
    const label = badge.querySelector('.stream-label');
    if (label) label.textContent = isLive ? 'LIVE' : 'PAUSED';
    const countEl = badge.querySelector('.stream-count');
    if (countEl) {
      if (isLive) {
        countEl.hidden = true;
      } else {
        countEl.hidden = false;
        countEl.textContent = ' \u00B7 ' + this.state.bufferedCount.toLocaleString() + ' new';
      }
    }
    badge.title = isLive ? 'Auto-scrolling to latest' : 'Click to resume (End)';
  }

  _onHoverEnter = () => {
    if (!this.state.hoverFreezeEnabled) return;
    if (this.state.streamMode !== 'LIVE') return;
    this._transitionToPaused('hover');
  }

  _onHoverLeave = () => {
    if (!this.state.hoverFreezeEnabled) return;
    if (this.state.pauseReason !== 'hover') return;
    this._transitionToLive();
  }

  // ===== SCHEDULE / FLUSH =====

  scheduleRender = () => {
    if (this.renderScheduled) return;
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;
    if (elapsed >= this.renderThrottleMs) {
      this.renderScheduled = true;
      requestAnimationFrame(() => this.flush());
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.renderScheduled = true;
        requestAnimationFrame(() => this.flush());
      }, this.renderThrottleMs - elapsed);
    }
  }

  flush = () => {
    this.lastRenderTime = Date.now();

    // When paused, still update filter index and stats but skip DOM rendering
    if (this.state.streamMode === 'PAUSED') {
      if (this.state.newLogsSinceRender > 0) {
        this.state.filterIndex.updateIncremental(
          this.state.logBuffer,
          (entry) => this.passesFilter(entry)
        );
        this.state.newLogsSinceRender = 0;
      }
      this.updateStats();
      this._updateStreamBadge();
      this.renderScheduled = false;
      return;
    }

    if (!this.containerReady) {
      this.initVirtualScroll();
    }

    // Incremental filter index update (only new logs)
    if (this.state.newLogsSinceRender > 0) {
      this.state.filterIndex.updateIncremental(
        this.state.logBuffer,
        (entry) => this.passesFilter(entry)
      );
      this.state.newLogsSinceRender = 0;
    }

    this._renderVirtualScroll();

    // Telemetry (low volume, keep simple)
    if (this.state.pendingTelemetry.length > 0) {
      this.renderPendingTelemetry();
      this.state.pendingTelemetry = [];
    }

    this.updateStats();
    this.renderScheduled = false;
  }

  // ===== VIRTUAL SCROLL CORE =====

  _renderVirtualScroll = () => {
    if (!this.scrollContainer || !this.sentinel) return;

    const totalFiltered = this.state.filterIndex.length;
    const totalHeight = totalFiltered * this.ROW_HEIGHT;

    this.sentinel.style.height = totalHeight + 'px';

    // Hide/show empty state
    const emptyState = document.getElementById('empty-state');
    if (emptyState) {
      emptyState.style.display = totalFiltered === 0 ? '' : 'none';
    }

    if (totalFiltered === 0) {
      this.rowPool.releaseAll();
      this.renderedRows.clear();
      this.updateLogsStatus();
      return;
    }

    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;

    let startIdx = Math.floor(scrollTop / this.ROW_HEIGHT) - this.OVERSCAN;
    let endIdx = Math.ceil((scrollTop + viewportHeight) / this.ROW_HEIGHT) + this.OVERSCAN;
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(totalFiltered, endIdx);

    // Auto-scroll: pin to bottom only when scrollTop actually needs to move
    if (this.state.autoScroll) {
      const newScrollTop = Math.max(0, totalHeight - viewportHeight);
      endIdx = totalFiltered;
      startIdx = Math.max(0, endIdx - Math.ceil(viewportHeight / this.ROW_HEIGHT) - this.OVERSCAN);
      if (Math.abs(this.scrollContainer.scrollTop - newScrollTop) > 1) {
        this._scrollPinUntil = Date.now() + 80;
        this.scrollContainer.scrollTop = newScrollTop;
      }
    }

    // Determine which filtered indices need to be on screen
    const neededSet = new Set();
    for (let i = startIdx; i < endIdx; i++) {
      neededSet.add(i);
    }

    // Release rows no longer in viewport
    for (const [filtIdx, row] of this.renderedRows) {
      if (!neededSet.has(filtIdx)) {
        this.rowPool.release(row);
        this.renderedRows.delete(filtIdx);
      }
    }

    // Add/update visible rows
    const fragment = document.createDocumentFragment();
    let addedToFragment = false;

    for (let i = startIdx; i < endIdx; i++) {
      const seq = this.state.filterIndex.seqAt(i);
      if (seq === undefined) continue;

      let row = this.renderedRows.get(i);
      if (row && row._seq === seq && row._highlightVersion === this._highlightVersion) {
        row.style.transform = 'translateY(' + (i * this.ROW_HEIGHT) + 'px)';
        continue;
      }

      if (!row) {
        row = this.rowPool.acquire();
        this.renderedRows.set(i, row);
      }

      const entry = this.state.logBuffer.getBySeq(seq);
      if (!entry) {
        if (row) { this.rowPool.release(row); this.renderedRows.delete(i); }
        continue;
      }

      this._populateRow(row, entry, seq, i);
      row.style.transform = 'translateY(' + (i * this.ROW_HEIGHT) + 'px)';

      if (!row.parentNode) {
        fragment.appendChild(row);
        addedToFragment = true;
      }
    }

    if (addedToFragment) {
      this.scrollContainer.appendChild(fragment);
    }

    this.visibleStart = startIdx;
    this.visibleEnd = endIdx;

    this.updateLogsStatus();
  }

  // ===== COMPONENT CATEGORY =====

  _getComponentCategory(component) {
    for (const [regex, category] of this._categoryRules) {
      if (regex.test(component)) return category;
    }
    return 'default';
  }

  // ===== ROW POPULATION (F12: textContent fast path + innerHTML highlight path) =====

  _populateRow(row, entry, seq, filteredIdx) {
    row._seq = seq;

    const level = entry.level || 'Message';
    const levelLower = level.toLowerCase();

    // Time
    row._time.textContent = this._formatTimeFast(entry.timestamp);

    // Level badge
    row._level.textContent = this._levelLetters[levelLower] || 'I';
    row._level.className = 'level-badge ' + levelLower;

    // Component
    const component = entry.component || 'Unknown';
    row._component.textContent = component;
    row._component.title = 'Click to exclude this component';
    row._component.dataset.category = this._getComponentCategory(component);

    // Message — highlight pipeline (F12 Error Intelligence)
    // 6-step pipeline: raw text → HTML-escape → compute highlights → offset map → insert tags → innerHTML
    const msg = entry.message || '';
    const truncated = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
    const highlights = this._computeHighlights(truncated, entry);

    if (highlights.length === 0) {
      // FAST PATH: no highlights active → stay with safe textContent (zero overhead)
      row._message.textContent = truncated;
    } else {
      // HIGHLIGHT PATH: use innerHTML with strict escaping pipeline
      row._message.innerHTML = applyHighlights(truncated, highlights, this);
    }
    row._highlightVersion = this._highlightVersion;

    // Error/warning row styling
    if (levelLower === 'error') {
      row.classList.add('error-row');
      row.classList.remove('warning-row');
    } else if (levelLower === 'warning') {
      row.classList.add('warning-row');
      row.classList.remove('error-row');
    } else {
      row.classList.remove('error-row');
      row.classList.remove('warning-row');
    }

    // Class-based striping (replaces :nth-child CSS)
    if (filteredIdx & 1) {
      row.classList.add('stripe');
    } else {
      row.classList.remove('stripe');
    }

    row.dataset.rootActivityId = entry.rootActivityId || '';
  }

  // ===== HIGHLIGHT ENGINE — Instance Methods (F12) =====

  /**
   * Collect highlights from all sources and produce the final resolved array.
   * Called from _populateRow for each visible row.
   *
   * @param {string} rawText — truncated, unescaped message
   * @param {Object} entry — the log entry object
   * @returns {Array} sorted, non-overlapping HighlightRange[]
   */
  _computeHighlights(rawText, entry) {
    if (!rawText) return [];

    // Fast-path bail: no search active AND no error decoder → skip entirely
    if (!this._searchTerm && !this._errorDecoder) return [];

    const highlights = [];

    // Source 1: Error codes (priority 1–2)
    if (this._errorDecoder) {
      const errorMatches = this._errorDecoder.matchErrorCodes(rawText);
      for (let i = 0; i < errorMatches.length; i++) {
        const m = errorMatches[i];
        highlights.push({
          start: m.start,
          end: m.end,
          className: m.known ? 'error-code-known' : 'error-code-unknown',
          data: { code: m.code }
        });
      }
    }

    // Source 2: Search matches (priority 3)
    if (this._searchTerm) {
      const searchRanges = computeSearchHighlights(rawText, this._searchTerm);
      highlights.push(...searchRanges);
    }

    if (highlights.length === 0) return highlights;

    // Resolve overlaps (error codes win over search)
    return resolveOverlaps(highlights);
  }

  /**
   * Set the search term for highlight rendering. Invalidates all visible row caches.
   *
   * @param {string} term — the search text (empty string to clear)
   */
  setSearchTerm(term) {
    const newTerm = (term || '').trim();
    if (newTerm === this._searchTerm) return;
    this._searchTerm = newTerm;
    this._currentSearchMatchIdx = -1;
    this._highlightVersion++;
  }

  /**
   * Set the ErrorDecoder instance used for error code detection.
   *
   * @param {ErrorDecoder} decoder — the ErrorDecoder instance
   */
  setErrorDecoder(decoder) {
    this._errorDecoder = decoder || null;
    this._highlightVersion++;
  }

  /**
   * Get the count of search matches across all currently filtered log entries.
   *
   * @returns {number} total search match count in the filtered view
   */
  getSearchMatchCount() {
    if (!this._searchTerm) return 0;
    const termLower = this._searchTerm.toLowerCase();
    const termLen = termLower.length;
    let total = 0;
    const filterIndex = this.state.filterIndex;
    for (let i = 0; i < filterIndex.length; i++) {
      const seq = filterIndex.seqAt(i);
      const entry = this.state.logBuffer.getBySeq(seq);
      if (!entry) continue;
      const msg = (entry.message || '').toLowerCase();
      let pos = 0;
      while (pos <= msg.length - termLen) {
        const idx = msg.indexOf(termLower, pos);
        if (idx === -1) break;
        total++;
        pos = idx + termLen;
      }
    }
    return total;
  }

  // Fast time formatting (avoids toLocaleTimeString overhead)
  _formatTimeFast(isoString) {
    if (!isoString) return '00:00:00.000';
    const tIdx = isoString.indexOf('T');
    if (tIdx === -1) return '00:00:00.000';
    const timeStr = isoString.substring(tIdx + 1);
    const dotIdx = timeStr.indexOf('.');
    if (dotIdx >= 8) {
      const hms = timeStr.substring(0, 8);
      let ms = timeStr.substring(dotIdx + 1).match(/^\d{1,3}/)?.[0] || '0';
      while (ms.length < 3) ms += '0';
      return hms + '.' + ms;
    }
    try {
      const d = new Date(isoString);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return h + ':' + m + ':' + s + '.' + ms;
    } catch (e) {
      return '00:00:00.000';
    }
  }

  // ===== TELEMETRY (low volume, keep simple) =====

  renderPendingTelemetry = () => {
    const container = document.getElementById('telemetry-container');
    if (!container) return;

    this.state.pendingTelemetry.forEach(event => {
      const card = this.createTelemetryCard(event);
      container.insertBefore(card, container.firstChild);
      requestAnimationFrame(() => card.classList.add('fade-in-complete'));
    });

    while (container.children.length > 100) {
      container.removeChild(container.lastChild);
    }
  }

  createTelemetryCard = (event) => {
    const card = document.createElement('div');
    card.className = 'telemetry-card fade-in ' + (event.activityStatus || 'unknown').toLowerCase();

    const status = event.activityStatus || 'Unknown';
    const icon = this.getStatusIcon(status);
    const duration = this.formatDuration(event.durationMs);
    const time = this.formatTime(event.timestamp);
    const resultCode = event.resultCode || 'OK';
    const correlationId = event.correlationId || '';

    let resultHtml = '';
    if (resultCode !== 'OK' && resultCode) {
      resultHtml = '<div class="telem-result">' + this.escapeHtml(resultCode) + '</div>';
    }

    let correlationHtml = '';
    if (correlationId) {
      const shortCorr = correlationId.substring(0, 8);
      correlationHtml = '<div class="telem-correlation" data-correlation="' + this.escapeHtml(correlationId) + '" title="Filter by ' + this.escapeHtml(correlationId) + '">' + this.escapeHtml(shortCorr) + '</div>';
    }

    let attributesHtml = '';
    if (event.attributes) {
      const attrs = [];
      if (event.attributes.WorkspaceId) attrs.push('<span class="attr-pill">WS: ' + this.escapeHtml(event.attributes.WorkspaceId.substring(0, 6)) + '</span>');
      if (event.attributes.ArtifactId) attrs.push('<span class="attr-pill">Art: ' + this.escapeHtml(event.attributes.ArtifactId.substring(0, 6)) + '</span>');
      if (event.attributes.IterationId) attrs.push('<span class="attr-pill">Iter: ' + this.escapeHtml(event.attributes.IterationId.substring(0, 6)) + '</span>');
      if (attrs.length > 0) {
        attributesHtml = '<div class="telem-attrs">' + attrs.join('') + '</div>';
      }
    }

    card.innerHTML =
      '<div class="telem-header">' +
        '<span class="telem-activity">' + this.escapeHtml(event.activityName || 'Unknown') + '</span>' +
        '<span class="status-badge ' + status.toLowerCase() + '">' + icon + ' ' + status + '</span>' +
      '</div>' +
      '<div class="telem-meta">' +
        '<span class="telem-duration">' + duration + '</span>' +
        '<span class="telem-time">' + time + '</span>' +
      '</div>' +
      resultHtml +
      correlationHtml +
      attributesHtml;

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('telem-correlation')) {
        e.stopPropagation();
        const corrId = e.target.dataset.correlation;
        if (corrId && window.edogViewer && window.edogViewer.filter) {
          window.edogViewer.filter.setCorrelationFilter(corrId);
        }
        return;
      }
      if (window.edogViewer && window.edogViewer.detail) {
        window.edogViewer.detail.show(event, 'telemetry');
      }
    });

    return card;
  }

  // ===== FILTER (all existing logic preserved) =====

  passesFilter = (entry) => {
    const component = entry.component || 'Unknown';

    // Level filter — but allow Verbose from FLT-relevant components
    const level = entry.level || 'Message';
    if (!this.state.activeLevels.has(level)) {
      // If Verbose is off but preset is FLT, still show Verbose from included components
      if (level !== 'Verbose' || this.state.activePreset !== 'flt') return false;
      if (this.state.excludedComponents.has(component)) return false;
      const fltPreset = FilterManager.COMPONENT_PRESETS.flt;
      if (fltPreset.include && !fltPreset.include.some(p => p.test(component))) return false;
      // Falls through — this is a Verbose log from an FLT-relevant component
    }

    // Correlation filter
    if (this.state.correlationFilter && entry.rootActivityId !== this.state.correlationFilter) {
      return false;
    }

    // Component filter — check explicit exclusions AND active preset patterns
    if (this.state.excludedComponents.has(component)) return false;

    const preset = FilterManager.COMPONENT_PRESETS[this.state.activePreset];
    if (preset) {
      if (preset.exclude && preset.exclude.some(p => p.test(component))) return false;
      if (preset.include && !preset.include.some(p => p.test(component))) return false;
    }

    // Time range filter
    if (this.state.timeRangeSeconds > 0) {
      const cutoff = new Date(Date.now() - this.state.timeRangeSeconds * 1000);
      const logTime = new Date(entry.timestamp);
      if (logTime < cutoff) return false;
    }

    // Endpoint filter (W0.2)
    if (this.state.endpointFilter) {
      const comp = entry.component || '';
      const match = comp.match(/-([A-Za-z]+)$/);
      const endpoint = match ? match[1] : '';
      if (endpoint.toLowerCase() !== this.state.endpointFilter.toLowerCase()) return false;
    }

    // Component filter
    if (this.state.componentFilter) {
      const comp = entry.component || '';
      const base = comp.replace(/-[A-Za-z]+$/, '');
      if (base.toLowerCase() !== this.state.componentFilter.toLowerCase()) return false;
    }

    // RAID / IterationId filter (W0.3)
    if (this.state.raidFilter) {
      const raidLower = this.state.raidFilter.toLowerCase();
      const iterationId = (entry.iterationId || '').toLowerCase();
      const message = (entry.message || '').toLowerCase();
      const rootId = (entry.rootActivityId || '').toLowerCase();
      if (!iterationId.includes(raidLower) && !message.includes(raidLower) && !rootId.includes(raidLower)) {
        return false;
      }
    }

    // Text search
    if (this.state.searchText) {
      const searchLower = this.state.searchText.toLowerCase();
      const msg = (entry.message || '').toLowerCase();
      const comp2 = (entry.component || '').toLowerCase();
      const raid = (entry.rootActivityId || '').toLowerCase();
      if (!msg.includes(searchLower) && !comp2.includes(searchLower) && !raid.includes(searchLower)) {
        const custom = entry.customData ? JSON.stringify(entry.customData).toLowerCase() : '';
        if (!custom.includes(searchLower)) return false;
      }
    }

    return true;
  }

  // ===== FULL RERENDER (on filter change) =====

  rerenderAllLogs = () => {
    this.state.filterIndex.rebuild(
      this.state.logBuffer,
      (entry) => this.passesFilter(entry)
    );

    this.rowPool.releaseAll();
    this.renderedRows.clear();

    if (this.containerReady) {
      this._renderVirtualScroll();
    }

    this.updateSearchCount();
    this.updateLogsStatus();

    if (this.state.autoScroll && this.scrollContainer) {
      const totalHeight = this.state.filterIndex.length * this.ROW_HEIGHT;
      this._scrollPinUntil = Date.now() + 80;
      this.scrollContainer.scrollTop = totalHeight;
    }
  }

  // ===== UTILITY =====

  formatDuration = (ms) => {
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return minutes + 'm ' + seconds + 's';
  }

  formatTime = (isoString) => {
    return this._formatTimeFast(isoString);
  }

  getStatusIcon = (status) => {
    const mapping = { succeeded: '\u2713', failed: '\u2717', cancelled: '\u25CC', pending: '\u22EF' };
    return mapping[(status || '').toLowerCase()] || '?';
  }

  // String-based escapeHtml (no DOM allocation) — 5 entities including ' for F12
  escapeHtml = (text) => {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  updateLogsStatus = () => {
    const visibleCountEl = document.getElementById('visible-count');
    const totalCountEl = document.getElementById('total-count');
    if (visibleCountEl) visibleCountEl.textContent = this.state.filterIndex.length;
    if (totalCountEl) totalCountEl.textContent = this.state.logBuffer.count;
  }

  updateSearchCount = () => {
    const countEl = document.getElementById('search-count');
    if (countEl) {
      if (this.state.searchText || this.state.correlationFilter || this.state.raidFilter) {
        countEl.textContent = this.state.filterIndex.length.toLocaleString() + ' matches';
        countEl.style.display = 'block';
      } else {
        countEl.style.display = 'none';
      }
    }
  }

  updateStats = () => {
    const logEl = document.getElementById('stat-logs');
    const ssrEl = document.getElementById('stat-ssr');
    const errEl = document.getElementById('stat-errors');
    if (logEl) logEl.textContent = (this.state.stats.totalLogs || 0).toLocaleString();
    if (ssrEl) ssrEl.textContent = (this.state.stats.totalEvents || 0).toLocaleString();
    if (errEl) errEl.textContent = (this.state.stats.error || 0).toLocaleString();
  }

  isScrolledToBottom = (container) => {
    if (!container) container = this.scrollContainer;
    if (!container) return true;
    return container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
  }

  scrollToBottom = (container) => {
    if (!container) container = this.scrollContainer;
    if (!container) return;
    const totalHeight = this.state.filterIndex.length * this.ROW_HEIGHT;
    this._scrollPinUntil = Date.now() + 80;
    container.scrollTop = totalHeight;
  }

  // Telemetry filter (unchanged)
  passesTelemetryFilter = (event) => {
    if (this.state.endpointFilter) {
      const name = event.activityName || '';
      if (!name.toLowerCase().includes(this.state.endpointFilter.toLowerCase())) return false;
    }
    if (this.state.raidFilter) {
      const raidLower = this.state.raidFilter.toLowerCase();
      const iterationId = ((event.attributes && event.attributes.IterationId) || '').toLowerCase();
      const corrId = (event.correlationId || '').toLowerCase();
      if (!iterationId.includes(raidLower) && !corrId.includes(raidLower)) return false;
    }
    return true;
  }

  rerenderTelemetry = () => {
    const container = document.getElementById('telemetry-container');
    if (!container) return;
    container.innerHTML = '';
    this.state.pendingTelemetry = [];
    const telemetryArr = [];
    this.state.telemetry.forEach(e => telemetryArr.push(e));
    const filtered = telemetryArr.filter(e => this.passesTelemetryFilter(e));
    const toRender = filtered.slice(-100).reverse();
    toRender.forEach(event => {
      const card = this.createTelemetryCard(event);
      card.classList.add('fade-in-complete');
      container.appendChild(card);
    });
  }
}
