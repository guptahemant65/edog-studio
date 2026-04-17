# C06 — Error Timeline Chart

> **Component:** `src/frontend/js/error-timeline.js` (new)
> **Phase:** P3 — Error Analytics
> **Owner:** Pixel
> **Priority:** P3-MVP
> **Dependencies:** C05 (Log Stream Controller), `state.js` RingBuffer, `renderer.js` passesFilter
> **Design tokens:** `variables.css` `--level-error`, `--level-warning`, `--level-message`, `--level-verbose`

---

## 1. Overview

Mini-chart rendered above the log list showing error/warning frequency over time. Horizontal bar chart, 40–60 px tall, full container width. Time-bucketed bars are stacked by severity and support click-to-filter and hover tooltips. Pure CSS + JS — no charting library.

---

## 2. Scenarios

### S01 — Chart Layout & Container

**ID:** `C06-S01`
**Description:** The timeline chart occupies a fixed-height strip above the `#logs-container` element. It must sit between the toolbar and the virtual-scroll log list.
**Priority:** P3-MVP

**Technical mechanism:**

```
Container DOM:
  <div id="error-timeline" class="error-timeline" role="img" aria-label="Error frequency timeline">
    <div class="etl-bars"></div>               ← CSS-grid of bar columns
    <div class="etl-empty">Timeline will appear as logs arrive</div>
    <div class="etl-tooltip" aria-hidden="true"></div>
  </div>

CSS:
  .error-timeline {
    position: relative;
    height: 48px;                              /* 40-60px range; 48 chosen for 4px grid */
    width: 100%;
    padding: 0 var(--space-2);
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
```

**Source path:** `src/frontend/js/error-timeline.js` (class `ErrorTimeline`, `mount()`)
**Edge cases:**
- Container width < 200 px: collapse to hidden (`display: none`), avoid micro-bars.
- Container width 0 (tab not visible): skip rendering entirely; render on tab show.
**Interactions:** Inserted into DOM by `EdogLogViewer.init()` in `main.js`, above `#logs-container`.
**Revert:** Remove `#error-timeline` DOM node; no other components depend on it for rendering.

---

### S02 — Time Bucketing Algorithm

**ID:** `C06-S02`
**Description:** Divide the session time span (oldest log → newest log) into N equal-duration buckets (30 ≤ N ≤ 60). Each log entry is assigned to exactly one bucket based on its ISO timestamp.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
// Called on full rebuild (filter change, first load)
_rebuildBuckets() {
  const rb = this.state.logBuffer;
  if (rb.count === 0) { this.buckets = []; return; }

  // 1. Determine time range
  const oldest = rb.getBySeq(rb.oldestSeq);
  const newest = rb.getBySeq(rb.newestSeq);
  const t0 = new Date(oldest.timestamp).getTime();
  const t1 = new Date(newest.timestamp).getTime();
  const span = Math.max(t1 - t0, 1000);       // floor 1 s to avoid div/0

  // 2. Determine bucket count (1 bucket per ~1-2s for short sessions,
  //    capped at 60 for long sessions, floored at 30 for readability)
  const rawCount = Math.round(span / 1000);    // ~1 bucket per second
  this.bucketCount = Math.min(60, Math.max(30, rawCount));
  this.bucketDuration = span / this.bucketCount;
  this.timeOrigin = t0;

  // 3. Allocate buckets
  this.buckets = Array.from({ length: this.bucketCount }, (_, i) => ({
    startMs: t0 + i * this.bucketDuration,
    endMs:   t0 + (i + 1) * this.bucketDuration,
    error: 0, warning: 0, message: 0, verbose: 0, total: 0,
  }));

  // 4. Iterate ring buffer ONCE (O(N) where N ≤ 50K)
  rb.forEach((entry) => {
    const ts = new Date(entry.timestamp).getTime();
    const idx = Math.min(
      Math.floor((ts - t0) / this.bucketDuration),
      this.bucketCount - 1
    );
    const b = this.buckets[idx];
    const level = (entry.level || 'message').toLowerCase();
    if (b[level] !== undefined) b[level]++;
    b.total++;
  });
}

// Fast bucket index for a single entry (used by incremental update)
_bucketIndexFor(timestampMs) {
  if (!this.bucketCount) return -1;
  return Math.min(
    Math.floor((timestampMs - this.timeOrigin) / this.bucketDuration),
    this.bucketCount - 1
  );
}
```

**Source path:** `src/frontend/js/error-timeline.js:_rebuildBuckets()`
**Edge cases:**
- All logs have identical timestamp: `span` clamps to 1000 ms; all entries fall in bucket 0.
- Timestamps arrive out-of-order (SignalR batch): the `forEach` still assigns correctly since bucketing is positional by time, not insertion order.
- Ring buffer wraps (eviction): after a `_rebuildBuckets`, evicted entries are gone. Bucket counts reflect only live buffer contents.
- `entry.timestamp` is `null` or unparseable: `new Date(null).getTime()` returns 0 — skip entry (`if (isNaN(ts)) return`).
**Interactions:** Reads `state.logBuffer` (RingBuffer) directly. Does NOT use `filterIndex` — timeline shows ALL logs regardless of active filters, giving the user an unfiltered "ground truth" overview.
**Revert:** Buckets are in-memory arrays. Set `this.buckets = []` + clear DOM.

---

### S03 — Bar Rendering (Stacked)

**ID:** `C06-S03`
**Description:** Each bucket renders as a vertical bar column. Bars are stacked by severity: error (top), warning (middle), info/message (bottom). Height proportional to count in bucket relative to the global max-bucket count.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
_renderBars() {
  const container = this._barsEl;
  const maxCount = Math.max(1, ...this.buckets.map(b => b.total));

  // Reuse or create bar columns
  while (container.children.length > this.buckets.length) {
    container.removeChild(container.lastChild);
  }
  while (container.children.length < this.buckets.length) {
    container.appendChild(this._createBarColumn());
  }

  for (let i = 0; i < this.buckets.length; i++) {
    const b = this.buckets[i];
    const col = container.children[i];
    const pct = (b.total / maxCount) * 100;

    // Each column is a flex-column of stacked segments
    // Segment heights as % of column height:
    const errPct = b.total ? (b.error / b.total) * pct : 0;
    const warnPct = b.total ? (b.warning / b.total) * pct : 0;
    const msgPct = pct - errPct - warnPct;

    col._errSeg.style.height  = errPct + '%';
    col._warnSeg.style.height = warnPct + '%';
    col._msgSeg.style.height  = msgPct + '%';
    col.dataset.index = i;
    col.classList.toggle('etl-empty-bar', b.total === 0);
  }
}

_createBarColumn() {
  const col = document.createElement('div');
  col.className = 'etl-col';

  const err  = document.createElement('div');
  err.className = 'etl-seg etl-seg-error';

  const warn = document.createElement('div');
  warn.className = 'etl-seg etl-seg-warning';

  const msg  = document.createElement('div');
  msg.className = 'etl-seg etl-seg-message';

  col.appendChild(err);
  col.appendChild(warn);
  col.appendChild(msg);

  col._errSeg  = err;
  col._warnSeg = warn;
  col._msgSeg  = msg;
  return col;
}
```

**CSS:**

```css
.etl-col {
  display: flex;
  flex-direction: column-reverse;      /* bottom-up stacking */
  align-items: stretch;
  min-width: 0;
  cursor: pointer;
  border-radius: 1px 1px 0 0;
  transition: opacity var(--transition-fast);
}
.etl-col:hover { opacity: 0.8; }
.etl-seg { min-height: 0; }
.etl-seg-error   { background: var(--level-error); }
.etl-seg-warning { background: var(--level-warning); }
.etl-seg-message { background: var(--level-message); opacity: 0.4; }
.etl-empty-bar   { visibility: hidden; }
```

**Source path:** `src/frontend/js/error-timeline.js:_renderBars()`
**Edge cases:**
- All buckets empty: all bars hidden, empty-state message shown (S10).
- Single bucket has count = 1, rest 0: bar renders at 100% height for that bucket — still legible as a single-pixel-ish bar given the 48 px container.
- Very high skew (one bucket has 10K, others have 2): apply optional `Math.log1p` normalization behind a flag if linear scaling makes small buckets invisible. Default: linear.
**Interactions:** CSS variables from `variables.css` provide severity colors. Light/dark theme switch auto-propagates via CSS custom properties.
**Revert:** Remove child elements from `.etl-bars`; reset `container.innerHTML = ''`.

---

### S04 — Color Coding

**ID:** `C06-S04`
**Description:** Bars use the existing level color tokens to maintain visual consistency with log row tinting and level badges throughout the app.
**Priority:** P3-MVP

**Technical mechanism:**

```
Mapping:
  error   → var(--level-error)    Light: #e5453b  Dark: #ff6b6b
  warning → var(--level-warning)  Light: #e5940c  Dark: #f0b429
  message → var(--level-message)  Light: #2d7ff9  Dark: #5b9bff  (at 40% opacity)
  verbose → not shown in bars (negligible signal; visual noise)

Applied via CSS classes on .etl-seg elements (see S03 CSS).
Theme switch: colors update automatically because they reference CSS custom properties.
```

**Source path:** `src/frontend/css/logs.css` (new `.etl-*` rules), `src/frontend/css/variables.css` (existing tokens)
**Edge cases:**
- Verbose logs: excluded from bar rendering to reduce noise. Verbose contributes to `b.total` for height calculation but does not get a visible segment.
- Color-blind accessibility: error (red) and message (blue) are distinguishable for protanopia/deuteranopia. Warning (amber) is distinct from both. Stacking order (error always top) provides positional cue.
**Interactions:** Inherits theme via `[data-theme="dark"]` selector on `:root`.
**Revert:** N/A — purely CSS.

---

### S05 — Click-to-Filter

**ID:** `C06-S05`
**Description:** Clicking a bar sets a time-range filter on the log list, restricting it to entries within that bucket's time window.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
// Event delegation on .etl-bars container
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

  // Set time-range filter on state
  // Store absolute ms range (not timeRangeSeconds which is relative-to-now)
  this.state.timelineFilter = {
    startMs: bucket.startMs,
    endMs:   bucket.endMs,
  };

  // Trigger filter rebuild in renderer
  this._onFilterChange();

  // Visual feedback
  this._updateSelectionHighlight();
};

// Integration point: renderer.passesFilter must check state.timelineFilter
// Add to passesFilter (after existing time-range check, line ~561):
//   if (this.state.timelineFilter) {
//     const ts = new Date(entry.timestamp).getTime();
//     if (ts < this.state.timelineFilter.startMs ||
//         ts >= this.state.timelineFilter.endMs) return false;
//   }
```

**Source path:** `src/frontend/js/error-timeline.js:_onClick()`, `src/frontend/js/renderer.js:passesFilter()` (line ~561)
**Edge cases:**
- Click on empty bar (total === 0): no-op (guard above).
- Click same bar twice: toggles filter off (deselect).
- Multiple rapid clicks: each click is synchronous state mutation; no debounce needed.
- Timeline filter + existing time-range filter: timeline filter takes precedence (it is more specific). The existing `timeRangeSeconds` filter (relative cutoff) remains active as an independent constraint.
**Interactions:**
- `renderer.rerenderAllLogs()` rebuilds filterIndex.
- Stream controller (C05): if in PAUSED mode, the click still updates the filter — but viewport won't jump. On RESUME the filter remains active.
- Enhanced Clustering (C07): clusters recalculated on filter change — now scoped to the selected time window.
**Revert:** `_clearSelection()` sets `state.timelineFilter = null`, calls `_onFilterChange()`, removes highlight CSS.

---

### S06 — Hover Tooltip

**ID:** `C06-S06`
**Description:** Hovering over a bar shows a lightweight tooltip with the bucket's time range and severity counts.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
_onMouseMove = (e) => {
  const col = e.target.closest('.etl-col');
  if (!col) { this._hideTooltip(); return; }

  const idx = parseInt(col.dataset.index, 10);
  const bucket = this.buckets[idx];
  if (!bucket) { this._hideTooltip(); return; }

  // Format time range
  const fmt = (ms) => {
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  };

  // Build tooltip text — no innerHTML; textContent only
  const parts = [];
  if (bucket.error)   parts.push(bucket.error + ' error' + (bucket.error > 1 ? 's' : ''));
  if (bucket.warning)  parts.push(bucket.warning + ' warning' + (bucket.warning > 1 ? 's' : ''));
  if (bucket.message)  parts.push(bucket.message + ' info');

  this._tooltipEl.textContent =
    fmt(bucket.startMs) + ' \u2013 ' + fmt(bucket.endMs) +
    ' \u00B7 ' + (parts.length ? parts.join(', ') : 'no entries');

  // Position: horizontally centered on column, above chart
  const colRect = col.getBoundingClientRect();
  const chartRect = this._el.getBoundingClientRect();
  this._tooltipEl.style.left = (colRect.left - chartRect.left + colRect.width / 2) + 'px';
  this._tooltipEl.style.display = 'block';
};

_hideTooltip() {
  this._tooltipEl.style.display = 'none';
}
```

**CSS:**

```css
.etl-tooltip {
  position: absolute;
  top: -28px;
  transform: translateX(-50%);
  background: var(--surface-3);
  color: var(--text);
  font: var(--text-xs) / 1.2 var(--font-mono);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--shadow-sm);
  z-index: var(--z-dropdown);
  display: none;
}
```

**Source path:** `src/frontend/js/error-timeline.js:_onMouseMove()`, `_hideTooltip()`
**Edge cases:**
- Tooltip goes off-screen left/right: clamp `left` to `[0, chartWidth - tooltipWidth]`.
- Rapid mouse movement across bars: no debounce needed — updating textContent and `style.left` is sub-millisecond.
- Touch devices: tooltip shows on `touchstart`, hides on `touchend`. No hover state.
**Interactions:** Uses same `--surface-3`, `--text`, `--font-mono` tokens as other tooltips in the app.
**Revert:** Set `display: none` on tooltip element.

---

### S07 — Active Filter Indicator

**ID:** `C06-S07`
**Description:** When a time-range filter is active (via timeline click), the selected bar is visually highlighted; unselected bars are dimmed.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
_updateSelectionHighlight() {
  const cols = this._barsEl.children;
  for (let i = 0; i < cols.length; i++) {
    cols[i].classList.toggle('etl-selected', i === this._selectedIndex);
    cols[i].classList.toggle('etl-dimmed', this._selectedIndex !== -1 && i !== this._selectedIndex);
  }
}
```

**CSS:**

```css
.etl-col.etl-selected {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
  border-radius: 2px;
}
.etl-col.etl-dimmed {
  opacity: 0.3;
}
```

**Source path:** `src/frontend/js/error-timeline.js:_updateSelectionHighlight()`
**Edge cases:**
- External filter clear (e.g., user clicks "Clear all filters" button): must call `errorTimeline.clearSelection()` to sync visual state.
- Multiple selected bars (V2, drag-select): out of scope for MVP. Single-bar selection only.
**Interactions:** The accent color (`--accent`) matches the app's primary action color, creating consistency with other selected/active states.
**Revert:** Remove `etl-selected` and `etl-dimmed` classes from all columns.

---

### S08 — Reset (Clear Time Filter)

**ID:** `C06-S08`
**Description:** Double-click on the timeline, or a "Clear" button, removes the time filter and restores the full log view.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
_onDblClick = (e) => {
  this._clearSelection();
};

_clearSelection() {
  this._selectedIndex = -1;
  this.state.timelineFilter = null;
  this._onFilterChange();
  this._updateSelectionHighlight();  // removes all selected/dimmed classes
}

// Also callable externally:
// ErrorTimeline.prototype.clearSelection = function() { this._clearSelection(); }
// Wired to "Clear filters" button in toolbar via main.js
```

**Source path:** `src/frontend/js/error-timeline.js:_clearSelection()`, `_onDblClick()`
**Edge cases:**
- Double-click on empty area (no bar): still clears — safe no-op if already cleared.
- Double-click when no filter active: no-op (guard: `if (this._selectedIndex === -1) return`).
**Interactions:** The toolbar "Clear" button in `main.js` should call `this.errorTimeline.clearSelection()` alongside existing filter resets.
**Revert:** Self-reverting — it IS the revert mechanism for S05.

---

### S09 — Incremental Update

**ID:** `C06-S09`
**Description:** As new logs arrive via SignalR, update the affected bucket(s) without re-iterating the entire buffer or re-rendering all bars.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
// Called from renderer.flush() or handleWebSocketBatch()
// after new logs are pushed to logBuffer
updateIncremental(newEntries) {
  if (!this.buckets.length) {
    // First data — do full build
    this._rebuildBuckets();
    this._renderBars();
    return;
  }

  let needsRebuild = false;

  for (const entry of newEntries) {
    const ts = new Date(entry.timestamp).getTime();
    if (isNaN(ts)) continue;

    // Check if new entry extends the time range beyond current buckets
    if (ts >= this.buckets[this.buckets.length - 1].endMs) {
      needsRebuild = true;
      break;
    }

    const idx = this._bucketIndexFor(ts);
    if (idx < 0 || idx >= this.buckets.length) { needsRebuild = true; break; }

    const b = this.buckets[idx];
    const level = (entry.level || 'message').toLowerCase();
    if (b[level] !== undefined) b[level]++;
    b.total++;
  }

  if (needsRebuild) {
    this._rebuildBuckets();
  }

  // Re-render only if bars exist
  // Optimization: only update changed columns
  this._renderBars();
}
```

**Optimization: partial render path**

```javascript
// If only the last 1-2 buckets changed (common case — new logs arrive at tail):
// Track _dirtyBucketStart. If it equals bucketCount-1, update only that column.
// For MVP, full _renderBars() is acceptable:
//   60 columns × 3 style writes = 180 DOM writes ≈ 0.1ms.
```

**Source path:** `src/frontend/js/error-timeline.js:updateIncremental()`
**Edge cases:**
- Time range extension: when a new log's timestamp exceeds the last bucket's `endMs`, a full rebuild is needed to recalculate bucket boundaries. This is O(N) but infrequent — only happens when session duration grows.
- Ring buffer eviction: if oldest entries are evicted, bucket counts for the earliest buckets become stale. Mitigation: periodic full rebuild every ~100 new batches, or when `logBuffer.oldestSeq` has advanced significantly.
- Burst of 1000+ entries in one batch: single `updateIncremental` call with array — loop is O(K) where K = batch size. No DOM work until the loop completes.
**Interactions:**
- Stream controller (C05): when PAUSED, `updateIncremental` still runs — the timeline visually reflects activity even while the log list viewport is frozen. This is specified behavior from the master spec.
- `state.logBuffer.push()` / `pushBatch()` in `state.addLog()` happens before timeline update.
**Revert:** Call `_rebuildBuckets()` to restore ground truth from ring buffer.

---

### S10 — Empty State

**ID:** `C06-S10`
**Description:** When no logs have been received, show a placeholder message instead of empty bars.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
_updateEmptyState() {
  const isEmpty = !this.buckets.length || this.buckets.every(b => b.total === 0);
  this._emptyEl.style.display = isEmpty ? 'flex' : 'none';
  this._barsEl.style.display  = isEmpty ? 'none' : 'grid';
}
```

**CSS:**

```css
.etl-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font: var(--text-sm) / 1 var(--font-body);
  user-select: none;
}
```

**Content:** `"Timeline will appear as logs arrive"` (plain text, no emoji per project rules).
**Source path:** `src/frontend/js/error-timeline.js:_updateEmptyState()`
**Edge cases:**
- Logs arrive then all get evicted (buffer wraps with nothing new): shows empty state again.
- Reconnection after disconnect: empty state shows until first batch arrives.
**Interactions:** None — purely visual.
**Revert:** N/A.

---

### S11 — Responsive Resize

**ID:** `C06-S11`
**Description:** The chart adapts to container width changes. Bar columns are CSS-grid `1fr` units, so they auto-size. A `ResizeObserver` triggers re-evaluation when the container width changes significantly.
**Priority:** P3-MVP

**Technical mechanism:**

```javascript
// In mount():
this._resizeObserver = new ResizeObserver((entries) => {
  const width = entries[0].contentRect.width;

  // Collapse if too narrow
  if (width < 200) {
    this._el.style.display = 'none';
    return;
  }
  this._el.style.display = '';

  // No bar re-render needed — CSS grid 1fr handles column sizing.
  // But if bucket count should change based on width (optional):
  // const idealBuckets = Math.min(60, Math.max(30, Math.floor(width / 4)));
  // if (idealBuckets !== this.bucketCount) { this._rebuildBuckets(); this._renderBars(); }
});
this._resizeObserver.observe(this._el);

// In destroy():
this._resizeObserver.disconnect();
```

**Source path:** `src/frontend/js/error-timeline.js:mount()`, `destroy()`
**Edge cases:**
- Inspector panel open/close changes container width: ResizeObserver fires, grid auto-adjusts.
- Window resize to very small width (< 200 px): chart collapses completely.
- Print media: chart is purely decorative for print; hide via `@media print { .error-timeline { display: none; } }`.
**Interactions:** Depends on layout from `main.js` (flex container). The `#error-timeline` is a flex item with `flex-shrink: 0`.
**Revert:** `this._resizeObserver.disconnect()`.

---

### S12 — Performance Budget

**ID:** `C06-S12`
**Description:** Full aggregation over 50K ring buffer entries must complete in <16 ms (one animation frame). Incremental updates must be <1 ms per batch.
**Priority:** P3-MVP

**Technical mechanism:**

```
Performance model:
  Full rebuild (_rebuildBuckets):
    50,000 entries × (1 Date parse + 1 division + 1 array access) ≈ 50K iterations
    Benchmark target: <10ms on mid-range laptop (2020 i5)
    Optimization: cache parsed timestamp on log entry at push time

  Incremental update:
    Typical batch: 10-100 entries × same per-entry cost ≈ <0.1ms

  Bar rendering (_renderBars):
    60 bars × (3 style.height writes + 2 classList toggles) ≈ 0.1ms

  Total per-frame budget: <1ms for incremental path (well within 16ms frame)

Pre-computation optimization:
  On log arrival in state.addLog(), compute and cache:
    entry._tsMs = new Date(entry.timestamp).getTime();
  Then _rebuildBuckets and _bucketIndexFor use entry._tsMs directly,
  avoiding repeated Date parsing. This is the single biggest perf win.
```

**Benchmark pseudocode:**

```javascript
// Add to test suite:
const t0 = performance.now();
timeline._rebuildBuckets();  // with 50K entries in buffer
const elapsed = performance.now() - t0;
assert(elapsed < 16, `Full rebuild took ${elapsed}ms, budget is 16ms`);
```

**Source path:** `src/frontend/js/error-timeline.js` (all methods)
**Edge cases:**
- Degenerate case: 50K entries all in one bucket (identical timestamp). Loop still O(N) but the single bucket renders as one tall bar. No performance issue.
- Cold start with 10K entries from mock data: full rebuild is ~3ms. Acceptable.
**Interactions:** The `_tsMs` cache must be set in `state.addLog()` or `handleWebSocketBatch()` — this is a small change to `state.js` (`entry._tsMs = new Date(entry.timestamp).getTime()` inside `addLog()`).
**Revert:** Remove `_tsMs` property caching.

---

### S13 — Stream Controller Integration

**ID:** `C06-S13`
**Description:** The timeline updates even when the log stream is PAUSED (C05). The user can see bursts of activity in the timeline while the log list viewport is frozen.
**Priority:** P3-MVP

**Technical mechanism:**

```
Integration flow:

  handleWebSocketBatch(logs, telemetry) {
    // 1. Push to ring buffer (always, regardless of stream state)
    state.logBuffer.pushBatch(logs);

    // 2. Update timeline (always, regardless of stream state)
    this.errorTimeline.updateIncremental(logs);

    // 3. Update filter index + render log list (only if LIVE)
    if (state.streamMode === 'LIVE') {
      renderer.flush();
    } else {
      state.bufferedCount += logs.length;
      // Update PAUSED badge count
    }
  }

Timeline.updateIncremental() is called on EVERY batch,
not gated by stream state. This is the "activity while paused" feature.
```

**Source path:** `src/frontend/js/main.js:handleWebSocketBatch()` (modified), `src/frontend/js/error-timeline.js:updateIncremental()`
**Edge cases:**
- Long pause (10+ minutes): timeline may need multiple rebuilds as time range expands. Each rebuild is <16ms.
- Resume after pause: timeline already up-to-date (no catch-up needed). Log list catches up via `renderer.flush()`.
**Interactions:** Depends on C05 (stream controller) for `state.streamMode`. Timeline itself has no awareness of pause state — it simply processes whatever entries it receives.
**Revert:** Remove `errorTimeline.updateIncremental()` call from batch handler.

---

### S14 — DOM Structure Decision: CSS-Grid Divs vs Canvas

**ID:** `C06-S14`
**Description:** Architecture decision on rendering approach. Analysis of tradeoffs between div-based bars and `<canvas>`.
**Priority:** P3-MVP (design decision, not a runtime scenario)

**Analysis:**

| Factor | CSS-Grid Divs | Canvas |
|--------|---------------|--------|
| **Click handling** | Native event delegation on `.etl-col` — trivial | Must implement hit-testing (`getImageData` or manual rect math) |
| **Hover/tooltip** | CSS `:hover` + event delegation — trivial | Must track mouse position, calculate which bar, manually position tooltip |
| **Theming** | CSS custom properties auto-propagate | Must read computed styles, redraw on theme change |
| **Accessibility** | Native DOM elements, can add `role`, `aria-label` | Single `<canvas>` element, must add off-screen accessible alternative |
| **Performance (60 bars)** | 60 divs × 3 segments = 180 elements. Style recalc: negligible. | Single draw call, ~0.1ms. Faster for 1000+ elements. |
| **Animation** | CSS transitions on height — free | Must implement requestAnimationFrame loop |
| **Code complexity** | ~80 lines | ~200 lines |
| **HiDPI** | Automatic (CSS pixels) | Must handle `devicePixelRatio` scaling |

**Decision:** CSS-Grid Divs.

**Rationale:** For 30–60 bars, DOM overhead is negligible (<0.5ms render). The benefits of native event handling, CSS theming, accessibility, and code simplicity far outweigh the marginal performance advantage of Canvas. Canvas only wins at 500+ elements, which this component will never reach. This aligns with ADR-002 (vanilla JS) and ADR-003 (single HTML file) — keeping complexity minimal.

**Canvas escape hatch:** If a future V2 adds per-second resolution (3600+ bars for 1-hour sessions), switch to Canvas with an adapter implementing the same public API (`updateIncremental`, `clearSelection`, `mount`, `destroy`).

---

## 3. Public API

```javascript
class ErrorTimeline {
  constructor(state, options = {}) {}

  // Lifecycle
  mount(parentEl)          // Insert DOM, attach events, start ResizeObserver
  destroy()                // Remove DOM, detach events, disconnect observer

  // Data
  updateIncremental(newEntries)   // Process new log batch (called per SignalR batch)
  rebuild()                       // Full rebuild from ring buffer (called on filter reset)

  // Filter
  clearSelection()                // Remove time-range filter + visual highlight

  // State
  get selectedBucket()            // Returns { startMs, endMs } or null
  get bucketCount()               // Current number of buckets
}
```

---

## 4. CSS Class Inventory

| Class | Element | Purpose |
|-------|---------|---------|
| `.error-timeline` | Container div | Root element, 48px tall, border-bottom |
| `.etl-bars` | Grid container | Holds bar columns |
| `.etl-col` | Bar column | Single bucket, flex-column-reverse |
| `.etl-col.etl-selected` | Selected bar | Accent outline |
| `.etl-col.etl-dimmed` | Non-selected bar | Reduced opacity |
| `.etl-col.etl-empty-bar` | Empty bar | Hidden |
| `.etl-seg` | Bar segment | Generic segment base |
| `.etl-seg-error` | Error segment | `--level-error` background |
| `.etl-seg-warning` | Warning segment | `--level-warning` background |
| `.etl-seg-message` | Info segment | `--level-message` at 40% opacity |
| `.etl-empty` | Empty state | Centered muted text |
| `.etl-tooltip` | Hover tooltip | Absolute-positioned, mono font |

---

## 5. State Additions

```javascript
// Added to LogViewerState (state.js):
this.timelineFilter = null;  // { startMs: number, endMs: number } | null
```

This is the ONLY state addition. The bucket data lives on the `ErrorTimeline` instance, not in global state, because it is derived data (computable from the ring buffer at any time).

---

## 6. Integration Points

| Touchpoint | File | Change | Risk |
|------------|------|--------|------|
| Timeline DOM insertion | `main.js` `init()` | Insert `#error-timeline` before `#logs-container` | LOW |
| Timeline instantiation | `main.js` `constructor()` | `this.errorTimeline = new ErrorTimeline(this.state, { onFilterChange: () => this.renderer.rerenderAllLogs() })` | LOW |
| Batch handler | `main.js` `handleWebSocketBatch()` | Add `this.errorTimeline.updateIncremental(logs)` | LOW |
| Filter integration | `renderer.js` `passesFilter()` | Add `state.timelineFilter` check (4 lines) | LOW |
| Filter clear | `main.js` `clearAllFilters()` | Add `this.errorTimeline.clearSelection()` | LOW |
| Build pipeline | `build-html.py` | Add `js/error-timeline.js` to `JS_MODULES` after `error-decoder.js` | LOW |
| CSS | `logs.css` | Add `.etl-*` rules (~50 lines) | LOW |

---

## 7. Test Scenarios

| Test ID | Scenario | Assertion |
|---------|----------|-----------|
| T01 | Push 100 logs → timeline renders 30-60 bars | `bucketCount >= 30 && bucketCount <= 60` |
| T02 | Push 50K logs → `_rebuildBuckets()` completes in <16ms | `performance.now() delta < 16` |
| T03 | Click bar at index 15 → `state.timelineFilter` matches bucket 15's time range | `state.timelineFilter.startMs === buckets[15].startMs` |
| T04 | Double-click → `state.timelineFilter === null` | Filter cleared |
| T05 | Push 10 new logs incrementally → only affected bucket(s) change | Previous bucket counts unchanged |
| T06 | All logs same timestamp → single visible bar, no crash | `buckets[0].total === N` |
| T07 | Empty buffer → empty state message visible | `.etl-empty` has `display: flex` |
| T08 | Resize container < 200px → chart hidden | `.error-timeline` has `display: none` |
| T09 | Theme toggle dark → bar colors match dark tokens | Computed `background-color` of `.etl-seg-error` matches `--level-error` |
| T10 | Stream PAUSED + new logs arrive → timeline updates | New bucket counts increment |
| T11 | Null timestamp entries → skipped without error | No `NaN` in bucket counts |
| T12 | Click bar → log list filters to time window → click same bar → filter clears | Toggle behavior |

---

## 8. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Full rebuild on time range extension could stutter with 50K entries | Low | Pre-cached `_tsMs` on entries reduces rebuild to <10ms. Infrequent trigger. |
| Ring buffer eviction makes old bucket counts stale | Low | Periodic full rebuild (every ~100 batches). Acceptable staleness for a frequency overview. |
| Tooltip positioning off-screen | Low | Clamp to container bounds in `_onMouseMove`. |
| `state.timelineFilter` conflicts with `state.timeRangeSeconds` | Low | Both are independent filter criteria in `passesFilter()`. They compose via AND logic — narrower result, which is correct. |
| Theme switch doesn't propagate to existing bar segments | None | CSS custom properties auto-propagate; no JS intervention needed. |

---

## 9. Non-Goals (V2+)

- Drag-select multiple bars for a time range
- Zoom in/out on timeline (sub-second resolution)
- Per-error-code filtering from timeline (click → show only `MLV_*` errors in that window)
- Sparkline mode (inline in error code pills)
- Canvas rendering for high-resolution timelines (3600+ bars)
- Logarithmic scale toggle
- Export timeline as image