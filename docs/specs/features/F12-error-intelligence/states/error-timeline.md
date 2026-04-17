# Error Timeline — State Matrix

> **Feature:** F12 Error Intelligence — Section C06
> **Component:** `ErrorTimeline` class (`error-timeline.js`)
> **Owner:** Pixel (Frontend) · Reviewed by Sana (Architecture)
> **Status:** SPEC PHASE
> **Companion:** `components/C06-error-timeline.md` (deep component spec)
> **States:** 18

---

## 1. State Diagram

```
                                    ┌───────────┐
                                    │  hidden   │◄───── panel collapsed / width < 200px
                                    └─────┬─────┘
                                          │ panel expanded + width ≥ 200px
                                          ▼
                                    ┌───────────┐
                              ┌─────│  visible  │─────┐
                              │     └─────┬─────┘     │
                              │           │            │
                              ▼           ▼            ▼
                        ┌─────────┐ ┌──────────┐ ┌──────────┐
                        │  empty  │ │ loading  │ │  error   │
                        └────┬────┘ └────┬─────┘ └────┬─────┘
                             │           │ data ok     │ retry
                             │ first log │             │ ──► loading
                             │ arrives   ▼             │ dismiss
                             │     ┌──────────────┐    │ ──► empty
                             └────►│   live.*     │    │
                                   │ (streaming)  │◄───┘ reconnect + data
                                   └──────┬───────┘
                                          │ stream paused
                                          ▼
                                   ┌──────────────┐
                                   │  paused.*    │
                                   │ (frozen view)│
                                   └──────────────┘

  Interaction overlays (combine with any live.* or paused.* base state):
  ──────────────────────────────────────────────────────────────────────
  hovering         — tooltip visible on bar
  filtered         — time-range filter active (bar selected)
  filtered.hovering — both active simultaneously

  Cross-cutting states (can interrupt any state):
  ────────────────────────────────────────────────
  disconnected     — FLT WebSocket lost
  resizing         — container width changing
```

---

## 2. State Definitions

### S01: `timeline.hidden`

The timeline panel is collapsed or the container is too narrow to render.

| Field | Value |
|-------|-------|
| **State name** | `timeline.hidden` |
| **Entry conditions** | Panel collapsed by user toggle, or `ResizeObserver` detects container width < 200px, or parent tab not visible |
| **Exit conditions** | User expands panel AND container width ≥ 200px |
| **Visual description** | Container has `display: none`. No DOM children visible. No space consumed in layout. The toggle button (if present in toolbar) shows a collapsed indicator. |
| **Keyboard shortcuts** | None — element is not focusable when hidden |
| **Data requirements** | None — no rendering occurs. `updateIncremental()` still processes incoming data into buckets in memory so the chart is ready when shown. |
| **Transitions** | `timeline.hidden` → `timeline.visible.empty` : user expands panel, no data in buckets |
|  | `timeline.hidden` → `timeline.visible.live.idle` : user expands panel, bucket data exists, stream is LIVE |
|  | `timeline.hidden` → `timeline.visible.paused.idle` : user expands panel, bucket data exists, stream is PAUSED |
| **Error recovery** | No errors possible — component is inert. If `updateIncremental()` throws during background bucketing, errors are caught silently; data will rebuild on next `show()`. |

---

### S02: `timeline.visible.empty`

The timeline is visible but contains no log data.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.empty` |
| **Entry conditions** | Panel visible AND (`logBuffer.count === 0` OR all buckets have `total === 0`) |
| **Exit conditions** | First log entry arrives with a valid timestamp, causing at least one bucket to have `total > 0` |
| **Visual description** | 48px-tall strip with `--surface-2` background and bottom border. `.etl-bars` grid is hidden (`display: none`). `.etl-empty` div visible, centered vertically: "Timeline will appear as logs arrive" in `--text-muted`, `--text-sm`, `--font-body`. No bars, no tooltip, no axis. |
| **Keyboard shortcuts** | `Tab` skips over the element (nothing interactive). |
| **Data requirements** | `state.logBuffer.count` must be readable. `this.buckets` array exists but is empty or all-zero. |
| **Transitions** | `timeline.visible.empty` → `timeline.visible.live.idle` : first valid log arrives via `updateIncremental()`, stream is LIVE |
|  | `timeline.visible.empty` → `timeline.visible.paused.idle` : first valid log arrives, stream is PAUSED |
|  | `timeline.visible.empty` → `timeline.hidden` : user collapses panel or width < 200px |
|  | `timeline.visible.empty` → `timeline.disconnected` : WebSocket connection lost |
| **Error recovery** | If `_rebuildBuckets()` fails on first data (e.g., corrupt timestamp), catch error, remain in empty state, log warning to console. The empty-state message continues to display. |

---

### S03: `timeline.visible.loading`

Initial data load is in progress (cold start with existing buffer data).

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.loading` |
| **Entry conditions** | `mount()` called while `logBuffer.count > 0` — a full `_rebuildBuckets()` over existing data is required before first render |
| **Exit conditions** | `_rebuildBuckets()` completes and `_renderBars()` finishes |
| **Visual description** | Brief transitional state (< 16ms for 50K entries). Container is visible at 48px height. Bars grid is present but columns not yet populated — user may see a single-frame flash of empty grid before bars appear. For buffers > 10K entries, a subtle shimmer placeholder is acceptable but not required given the < 16ms budget. |
| **Keyboard shortcuts** | None — state is transient, no interaction possible during the < 16ms window |
| **Data requirements** | Full `state.logBuffer` ring buffer contents. Each entry must have a `.timestamp` field (ISO 8601). Pre-cached `entry._tsMs` preferred for performance. |
| **Transitions** | `timeline.visible.loading` → `timeline.visible.live.idle` : rebuild completes, `state.streamMode === 'LIVE'` |
|  | `timeline.visible.loading` → `timeline.visible.paused.idle` : rebuild completes, `state.streamMode === 'PAUSED'` |
|  | `timeline.visible.loading` → `timeline.visible.empty` : rebuild completes but all buckets are zero (all timestamps invalid) |
|  | `timeline.visible.loading` → `timeline.error.rebuild` : `_rebuildBuckets()` throws an exception |
| **Error recovery** | If `_rebuildBuckets()` throws (OOM on 50K entries, corrupt buffer): catch error, transition to `timeline.error.rebuild`, display error card with "Timeline unavailable" message and Retry button. On retry, attempt `_rebuildBuckets()` again. |

---

### S04: `timeline.visible.live.idle`

Chart is rendered and the stream is LIVE. No user interaction in progress. New bars appear as logs arrive.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.live.idle` |
| **Entry conditions** | Buckets populated AND `state.streamMode === 'LIVE'` AND no hover/selection active |
| **Exit conditions** | User hovers a bar, clicks a bar, stream pauses, disconnect, or panel hides |
| **Visual description** | Full 48px bar chart. 30–60 bar columns in CSS grid, each a stacked flex-column-reverse of segments: error (top, `--level-error`), warning (middle, `--level-warning`), info (bottom, `--level-message` at 40% opacity). Bar heights proportional to bucket totals relative to global max. Empty buckets hidden via `visibility: hidden`. 1px gap between columns. No tooltip visible. No selection highlight. Bars update in real-time as `updateIncremental()` fires per SignalR batch. |
| **Keyboard shortcuts** | None specific to idle state. `Tab` can reach the timeline container if given `tabindex="0"`. |
| **Data requirements** | `this.buckets[]` — 30–60 `TimelineBucket` objects with `error`, `warning`, `message`, `verbose`, `total` counts plus `startMs`/`endMs` time range. `state.streamMode` to detect LIVE vs PAUSED. |
| **Transitions** | `timeline.visible.live.idle` → `timeline.visible.live.hovering` : mouse enters an `.etl-col` element |
|  | `timeline.visible.live.idle` → `timeline.visible.filtered` : user clicks an `.etl-col` with `total > 0` |
|  | `timeline.visible.live.idle` → `timeline.visible.paused.idle` : `state.streamMode` changes to `'PAUSED'` |
|  | `timeline.visible.live.idle` → `timeline.hidden` : panel collapsed or width < 200px |
|  | `timeline.visible.live.idle` → `timeline.disconnected` : WebSocket lost |
|  | `timeline.visible.live.idle` → `timeline.visible.empty` : ring buffer wraps and all entries evicted (count drops to 0) |
|  | `timeline.visible.live.idle` → `timeline.error.update` : `updateIncremental()` throws |
| **Error recovery** | If `updateIncremental()` throws on a batch: catch error, skip the batch, log warning. Chart remains at last good state. If 3 consecutive failures, transition to `timeline.error.update` with retry option. On retry, `_rebuildBuckets()` from buffer. |

---

### S05: `timeline.visible.live.hovering`

User is hovering over a bar column while the stream is live. Tooltip is visible.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.live.hovering` |
| **Entry conditions** | Mouse enters an `.etl-col` element (via `mousemove` delegation on `.etl-bars`) while in `live.idle` state |
| **Exit conditions** | Mouse leaves all `.etl-col` elements, user clicks a bar (transitions to filtered), or stream pauses |
| **Visual description** | Hovered bar column has `opacity: 0.8` (CSS `:hover`). Tooltip visible above the chart at `top: -28px`, horizontally centered on the hovered column. Tooltip shows: time range in `HH:MM:SS – HH:MM:SS` format, bullet separator, severity breakdown (e.g., "3 errors, 12 warnings, 45 info"). Background: `--surface-3`, mono font `--text-xs`, rounded corners `--radius-sm`, shadow `--shadow-sm`. Tooltip has `pointer-events: none` and `aria-hidden="true"`. Live updates continue — if the hovered bucket's count changes, tooltip text updates immediately. |
| **Keyboard shortcuts** | `Escape` hides the tooltip (returns to `live.idle`). No keyboard-triggered hover. |
| **Data requirements** | `this.buckets[idx]` for the hovered column — needs `startMs`, `endMs`, `error`, `warning`, `message` counts. Column index derived from `col.dataset.index`. |
| **Transitions** | `timeline.visible.live.hovering` → `timeline.visible.live.idle` : mouse leaves `.etl-col` area |
|  | `timeline.visible.live.hovering` → `timeline.visible.filtered` : user clicks the hovered bar (or any bar) |
|  | `timeline.visible.live.hovering` → `timeline.visible.paused.hovering` : `state.streamMode` changes to `'PAUSED'` |
|  | `timeline.visible.live.hovering` → `timeline.hidden` : panel collapsed |
|  | `timeline.visible.live.hovering` → `timeline.disconnected` : WebSocket lost |
| **Error recovery** | If tooltip positioning fails (e.g., `getBoundingClientRect()` returns 0): hide tooltip, remain in hovering state visually (bar opacity still 0.8), log warning. Next mouse move re-attempts positioning. |

---

### S06: `timeline.visible.paused.idle`

Chart is rendered, stream is PAUSED. Bars still update (timeline reflects activity even while log list is frozen).

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.paused.idle` |
| **Entry conditions** | `state.streamMode === 'PAUSED'` AND buckets populated AND no hover/selection active |
| **Exit conditions** | Stream resumes to LIVE, user hovers/clicks a bar, disconnect, or panel hides |
| **Visual description** | Identical to `live.idle` visually — same bar chart rendering. Key difference: the log list below is frozen, but the timeline continues updating via `updateIncremental()`. New bars grow on the right edge as logs arrive. A subtle visual cue distinguishes paused state: the stream controller's PAUSED badge (rendered by C05 in the toolbar, not by this component) indicates the overall stream state. The timeline itself has no special paused indicator — it always shows ground truth. |
| **Keyboard shortcuts** | `Space` resumes stream (handled by stream controller, not timeline). `End` resumes stream. |
| **Data requirements** | Same as `live.idle`. `state.streamMode` read to detect PAUSED. `updateIncremental()` still called on every batch regardless of stream state. |
| **Transitions** | `timeline.visible.paused.idle` → `timeline.visible.live.idle` : `state.streamMode` changes to `'LIVE'` (user resumes) |
|  | `timeline.visible.paused.idle` → `timeline.visible.paused.hovering` : mouse enters an `.etl-col` |
|  | `timeline.visible.paused.idle` → `timeline.visible.filtered` : user clicks a bar |
|  | `timeline.visible.paused.idle` → `timeline.hidden` : panel collapsed or width < 200px |
|  | `timeline.visible.paused.idle` → `timeline.disconnected` : WebSocket lost |
| **Error recovery** | Same as `live.idle` — catch `updateIncremental()` failures, skip batch, log warning. |

---

### S07: `timeline.visible.paused.hovering`

User hovers a bar while the stream is PAUSED. Tooltip visible.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.paused.hovering` |
| **Entry conditions** | Mouse enters `.etl-col` while in `paused.idle` state |
| **Exit conditions** | Mouse leaves bar area, click, stream resumes, disconnect |
| **Visual description** | Same as `live.hovering` — hovered bar at 0.8 opacity, tooltip above chart with time range and severity counts. Tooltip content is stable (bucket counts still update from `updateIncremental()` but only the hovered bucket refreshes tooltip text). |
| **Keyboard shortcuts** | `Escape` hides tooltip. `Space` resumes stream (stream controller handles). |
| **Data requirements** | Same as `live.hovering`. |
| **Transitions** | `timeline.visible.paused.hovering` → `timeline.visible.paused.idle` : mouse leaves `.etl-col` |
|  | `timeline.visible.paused.hovering` → `timeline.visible.filtered` : user clicks a bar |
|  | `timeline.visible.paused.hovering` → `timeline.visible.live.hovering` : stream resumes to LIVE |
|  | `timeline.visible.paused.hovering` → `timeline.disconnected` : WebSocket lost |
| **Error recovery** | Same as `live.hovering`. |

---

### S08: `timeline.visible.filtered`

User has clicked a bar, applying a time-range filter. The selected bar is highlighted, others dimmed.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.filtered` |
| **Entry conditions** | User clicks an `.etl-col` with `bucket.total > 0`. `_onClick()` sets `this._selectedIndex`, writes `state.timelineFilter = { startMs, endMs }`, and calls `_onFilterChange()`. |
| **Exit conditions** | User clicks the same bar again (toggle off), double-clicks anywhere, clicks "Clear all filters" in toolbar, or a full data rebuild resets selection |
| **Visual description** | Selected bar has a 2px `--accent` outline with `outline-offset: -1px` and 2px border-radius. All other bars dimmed to `opacity: 0.3` via `.etl-dimmed` class. The log list below filters to only show entries within the selected bucket's `[startMs, endMs)` time window. Tooltip can still show on hover (overlay). Live updates continue — new bars appear but dimmed unless they are the selected bucket. If the selected bucket receives new entries, its height updates and the log list re-filters. |
| **Keyboard shortcuts** | `Escape` clears the selection (calls `_clearSelection()`). `Enter` on focused bar triggers click (same toggle behavior). |
| **Data requirements** | `this._selectedIndex` — index of the selected bucket. `state.timelineFilter` — `{ startMs: number, endMs: number }` written to shared state. `renderer.passesFilter()` must check `state.timelineFilter` to filter log rows. |
| **Transitions** | `timeline.visible.filtered` → `timeline.visible.live.idle` : click same bar (toggle), double-click, Escape, or "Clear all filters" — all call `_clearSelection()` |
|  | `timeline.visible.filtered` → `timeline.visible.filtered` (new index) : click a different bar — deselects old, selects new |
|  | `timeline.visible.filtered` → `timeline.visible.filtered.hovering` : mouse hovers a bar while filter active |
|  | `timeline.visible.filtered` → `timeline.hidden` : panel collapsed |
|  | `timeline.visible.filtered` → `timeline.disconnected` : WebSocket lost (filter state preserved in memory) |
| **Error recovery** | If `_onFilterChange()` fails (renderer crash): catch error, call `_clearSelection()` to revert filter, log error. User sees unfiltered log list restored. If `state.timelineFilter` write fails: same recovery — clear and log. |

---

### S09: `timeline.visible.filtered.hovering`

Tooltip showing while a time-range filter is active.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.filtered.hovering` |
| **Entry conditions** | Mouse enters an `.etl-col` while in `filtered` state |
| **Exit conditions** | Mouse leaves bar area, click changes selection, filter cleared |
| **Visual description** | Combines filter styling with hover tooltip. The selected bar keeps its `--accent` outline. The hovered bar (if different from selected) shows at 0.8 opacity instead of 0.3 dimmed — providing a "preview" effect. Tooltip appears above the hovered bar with that bucket's counts, regardless of whether it is the selected bar or a dimmed one. |
| **Keyboard shortcuts** | `Escape` clears selection (returns to `live.idle` or `paused.idle`). |
| **Data requirements** | Same as `filtered` + `hovering` combined. Both `_selectedIndex` and the hovered column index. |
| **Transitions** | `timeline.visible.filtered.hovering` → `timeline.visible.filtered` : mouse leaves bar area |
|  | `timeline.visible.filtered.hovering` → `timeline.visible.filtered` (new index) : click on a different bar |
|  | `timeline.visible.filtered.hovering` → `timeline.visible.live.idle` : filter cleared while hovering |
| **Error recovery** | Same as `live.hovering`. |

---

### S10: `timeline.disconnected`

FLT WebSocket connection is lost. Timeline freezes at last known state.

| Field | Value |
|-------|-------|
| **State name** | `timeline.disconnected` |
| **Entry conditions** | WebSocket `onclose`/`onerror` fires while timeline is in any visible state. Detected via `state.connected === false` or a connection-lost event. |
| **Exit conditions** | WebSocket reconnects and first batch of data arrives |
| **Visual description** | Chart bars remain visible at their last rendered state (frozen). A semi-transparent overlay or muted treatment indicates staleness — bars dim to `opacity: 0.5` globally. No tooltip on hover (tooltip shows "Disconnected" if user hovers). No click-to-filter (clicks are no-ops). The disconnected state banner is shown by the main app shell, not by the timeline component. |
| **Keyboard shortcuts** | None — all interactions disabled during disconnect. |
| **Data requirements** | Last known `this.buckets[]` array retained in memory. No new data arrives. `state.timelineFilter` preserved if it was set before disconnect. |
| **Transitions** | `timeline.disconnected` → `timeline.visible.loading` : WebSocket reconnects and new data arrives — triggers full `_rebuildBuckets()` since buffer may have been cleared/reset |
|  | `timeline.disconnected` → `timeline.visible.live.idle` : reconnect + buffer intact, incremental update resumes |
|  | `timeline.disconnected` → `timeline.visible.empty` : reconnect but buffer was cleared during disconnect |
|  | `timeline.disconnected` → `timeline.hidden` : user collapses panel while disconnected |
| **Error recovery** | No errors to handle — component is passively frozen. If reconnection triggers a `_rebuildBuckets()` that fails, transition to `timeline.error.rebuild`. |

---

### S11: `timeline.error.rebuild`

A full bucket rebuild failed (OOM, corrupt buffer, unexpected exception).

| Field | Value |
|-------|-------|
| **State name** | `timeline.error.rebuild` |
| **Entry conditions** | `_rebuildBuckets()` throws an uncaught exception during `mount()`, `rebuild()`, or reconnection |
| **Exit conditions** | User clicks Retry, or new data arrives and triggers a successful `updateIncremental()` |
| **Visual description** | 48px strip with error styling. Background: subtle red tint `oklch(0.18 0.04 25 / 0.2)`. Centered message: "Timeline unavailable" in `--text-muted`. Small "[Retry]" link in `--accent` color, keyboard-focusable. No bars visible. |
| **Keyboard shortcuts** | `Enter` on focused Retry link triggers rebuild attempt. `Tab` reaches the Retry link. |
| **Data requirements** | The error object/message is logged to console for debugging. No bucket data is available in this state. `state.logBuffer` must still be accessible for retry. |
| **Transitions** | `timeline.error.rebuild` → `timeline.visible.loading` : Retry clicked — re-attempts `_rebuildBuckets()` |
|  | `timeline.error.rebuild` → `timeline.visible.live.idle` : retry succeeds and stream is LIVE |
|  | `timeline.error.rebuild` → `timeline.visible.empty` : retry succeeds but buffer is empty |
|  | `timeline.error.rebuild` → `timeline.error.rebuild` : retry fails again (increment retry counter, cap at 3 then disable Retry link with "Try refreshing the page") |
|  | `timeline.error.rebuild` → `timeline.hidden` : user collapses panel |
| **Error recovery** | Retry has exponential backoff: 1st retry immediate, 2nd after 2s, 3rd after 5s. After 3 failures, Retry link disabled. Message changes to "Timeline unavailable — try refreshing the page". |

---

### S12: `timeline.error.update`

Incremental update has failed repeatedly (3 consecutive batches).

| Field | Value |
|-------|-------|
| **State name** | `timeline.error.update` |
| **Entry conditions** | `updateIncremental()` throws on 3 consecutive batches (tracked via `this._consecutiveFailures` counter) |
| **Exit conditions** | Successful `_rebuildBuckets()` via retry, or component destroy |
| **Visual description** | Bars remain at last good state (not cleared). A small warning indicator appears — a 2px amber (`--level-warning`) top border on the timeline container, signaling stale data. Tooltip still works for existing bars. Clicks still work for existing bars. A "Refresh timeline" link appears in the top-right corner of the container. |
| **Keyboard shortcuts** | `Tab` reaches "Refresh timeline" link. `Enter` triggers rebuild. |
| **Data requirements** | Last good `this.buckets[]` retained. Consecutive failure counter `this._consecutiveFailures >= 3`. |
| **Transitions** | `timeline.error.update` → `timeline.visible.live.idle` : "Refresh timeline" clicked → `_rebuildBuckets()` succeeds |
|  | `timeline.error.update` → `timeline.error.rebuild` : refresh attempt also fails |
|  | `timeline.error.update` → `timeline.disconnected` : WebSocket lost |
| **Error recovery** | On "Refresh timeline" click: reset `_consecutiveFailures = 0`, call `_rebuildBuckets()`. If that succeeds, remove warning indicator and resume `updateIncremental()`. If it fails, escalate to `timeline.error.rebuild`. |

---

### S13: `timeline.resizing`

Container width is changing (browser resize, panel drag, inspector toggle).

| Field | Value |
|-------|-------|
| **State name** | `timeline.resizing` |
| **Entry conditions** | `ResizeObserver` callback fires with a new `contentRect.width` that differs from the last recorded width |
| **Exit conditions** | `ResizeObserver` callback completes and no further resize events within 150ms |
| **Visual description** | Transient state — CSS grid `1fr` columns auto-adapt to new width immediately (no JS intervention needed for column sizing). If width crosses the 200px threshold downward, component transitions to `hidden`. If crossing upward, transitions to appropriate visible state. During active drag-resize, bars may appear slightly compressed/expanded frame-by-frame, which is acceptable. No tooltip is shown during active resize (hidden if visible). |
| **Keyboard shortcuts** | None — resize is a pointer/layout event. |
| **Data requirements** | `ResizeObserver` entry's `contentRect.width`. Previous width stored as `this._lastWidth`. Bucket count may optionally be recalculated if width-based bucket count is enabled: `idealBuckets = Math.min(60, Math.max(30, Math.floor(width / 4)))`. |
| **Transitions** | `timeline.resizing` → previous visible state : resize settles, width ≥ 200px |
|  | `timeline.resizing` → `timeline.hidden` : width drops below 200px |
|  | `timeline.resizing` → appropriate visible state : width increases from < 200px to ≥ 200px (restore from hidden) |
| **Error recovery** | If `ResizeObserver` throws: disconnect observer, log warning. Chart remains at last rendered size. Tooltip positioning may be stale — recalculate on next hover. |

---

### S14: `timeline.visible.live.updating`

A batch of new log entries is being processed into buckets. Transient sub-state of `live.idle`.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.live.updating` |
| **Entry conditions** | `updateIncremental(newEntries)` called with a non-empty array while stream is LIVE |
| **Exit conditions** | `updateIncremental()` completes (returns) — typically < 1ms |
| **Visual description** | No visible change during the sub-millisecond processing window. User cannot perceive this state. After completion, affected bar columns update their segment heights via `_renderBars()`. If a time-range extension triggers `_rebuildBuckets()`, all bars re-render. New bars may appear on the right edge (new bucket columns added to the grid). Oldest bars may scroll off the left if the bucket count is capped. |
| **Keyboard shortcuts** | None — transient, sub-frame duration. |
| **Data requirements** | `newEntries[]` — array of `LogEntry` objects with `.timestamp` and `.level`. Each entry needs `entry._tsMs` (cached timestamp in ms). `this.bucketDuration`, `this.timeOrigin`, `this.bucketCount` for index calculation. |
| **Transitions** | `timeline.visible.live.updating` → `timeline.visible.live.idle` : batch processed, no time-range extension |
|  | `timeline.visible.live.updating` → `timeline.visible.live.idle` : batch processed, time-range extended, full rebuild succeeded |
|  | `timeline.visible.live.updating` → `timeline.error.update` : processing throws (3rd consecutive failure) |
| **Error recovery** | Per-entry errors (invalid timestamp, `NaN`): skip entry with `if (isNaN(ts)) continue`. Per-batch errors: catch, increment `_consecutiveFailures`, skip batch. Chart shows last good state. |

---

### S15: `timeline.visible.live.rebucketing`

Time range has extended beyond current bucket boundaries, triggering a full rebuild.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.live.rebucketing` |
| **Entry conditions** | `updateIncremental()` detects `ts >= this.buckets[last].endMs` — new log's timestamp exceeds the last bucket's end time. Also triggered by periodic full rebuild (every ~100 batches) to correct for ring buffer eviction drift. |
| **Exit conditions** | `_rebuildBuckets()` completes and `_renderBars()` re-renders all columns |
| **Visual description** | Transient state (< 16ms for 50K entries). All bar columns may shift positions as bucket boundaries recalculate. Heights update to reflect the new global max. The grid column count may change (within [30, 60] range). If a selection was active (`_selectedIndex !== -1`), the selection is cleared because bucket indices have changed — `state.timelineFilter` is set to `null` and `_onFilterChange()` fires. |
| **Keyboard shortcuts** | None — transient. |
| **Data requirements** | Full `state.logBuffer` ring buffer. All entries' `_tsMs` values. |
| **Transitions** | `timeline.visible.live.rebucketing` → `timeline.visible.live.idle` : rebuild succeeds, no selection was active |
|  | `timeline.visible.live.rebucketing` → `timeline.visible.live.idle` : rebuild succeeds, selection was cleared |
|  | `timeline.visible.live.rebucketing` → `timeline.error.rebuild` : `_rebuildBuckets()` throws |
| **Error recovery** | If rebuild fails: retain last good bucket data, transition to `timeline.error.rebuild`. If selection was cleared during a failed rebuild, the filter is already reset — log list returns to unfiltered view. |

---

### S16: `timeline.visible.single-bar`

Edge case: all log entries have identical (or near-identical) timestamps.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.single-bar` |
| **Entry conditions** | `_rebuildBuckets()` completes and only bucket 0 has `total > 0` (all others zero). Happens when time span < 1s (clamped to 1000ms floor). |
| **Exit conditions** | New log arrives with a timestamp that creates spread across buckets (time span grows) |
| **Visual description** | Single visible bar at the left edge of the chart (bucket 0), rendered at 100% height (it is the global max). All other 29–59 bars hidden via `.etl-empty-bar` (`visibility: hidden`). The single bar is still clickable and hoverable. Tooltip shows the narrow time range (e.g., "14:30:05 – 14:30:06 · 42 errors, 3 warnings"). This is a degenerate but valid rendering — no special UI treatment needed. |
| **Keyboard shortcuts** | Same as `live.idle`. |
| **Data requirements** | Same as `live.idle`. The key invariant: `this.bucketDuration` is very small (≈ 33ms for 30 buckets over 1s span). |
| **Transitions** | `timeline.visible.single-bar` → `timeline.visible.live.rebucketing` : new log with different timestamp triggers time-range extension |
|  | `timeline.visible.single-bar` → `timeline.visible.filtered` : user clicks the single bar |
|  | `timeline.visible.single-bar` → `timeline.visible.live.hovering` : user hovers the single bar |
| **Error recovery** | No special error handling — this is a visual edge case, not an error condition. |

---

### S17: `timeline.visible.high-volume`

Thousands of errors concentrated in a few buckets, creating extreme skew.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.high-volume` |
| **Entry conditions** | After `_renderBars()`, the max bucket count is > 100x the median non-zero bucket count (extreme skew detected) |
| **Exit conditions** | Data distribution normalizes (new logs spread counts more evenly), or a full rebuild recalculates boundaries |
| **Visual description** | Linear scaling causes low-count bars to be nearly invisible (< 1px height). Two mitigations (MVP uses linear only, V2 may add log scale): 1) Bar minimum height: CSS `min-height: 2px` on `.etl-seg` ensures any non-zero bucket is visible as at least a 2px sliver. 2) Optional: `Math.log1p` normalization behind a flag. Currently, the visual is acceptable — the skewed bars clearly communicate "this time period had the burst." Tooltip on tiny bars still works (the column is full-height, only segments are tiny). |
| **Keyboard shortcuts** | Same as `live.idle`. |
| **Data requirements** | Same as `live.idle`. Skew detection: `maxCount / medianNonZeroCount > 100`. |
| **Transitions** | Same as the base `live.idle` or `paused.idle` state — this is a visual variant, not a separate interaction state. All `live.*` and `paused.*` transitions apply. |
| **Error recovery** | No errors — purely a rendering concern. If `Math.log1p` normalization is enabled and produces `NaN` (impossible for valid counts), fall back to linear scaling. |

---

### S18: `timeline.visible.stale`

Bucket data is known to be out-of-sync with the ring buffer due to eviction drift.

| Field | Value |
|-------|-------|
| **State name** | `timeline.visible.stale` |
| **Entry conditions** | `state.logBuffer.oldestSeq` has advanced significantly (> 10% of buffer capacity) since last `_rebuildBuckets()`, meaning oldest buckets contain counts for evicted entries. Detected via periodic check every ~100 batches. |
| **Exit conditions** | Full `_rebuildBuckets()` runs and restores ground truth |
| **Visual description** | No visual change — staleness is invisible to the user. The leftmost bucket counts may be slightly inflated (they include evicted entries' contributions). This is acceptable for a frequency overview chart. A periodic full rebuild (every ~100 batches, or when eviction drift exceeds 10%) corrects the data. No warning shown to the user — the chart is "good enough" and self-correcting. |
| **Keyboard shortcuts** | Same as parent state. |
| **Data requirements** | `state.logBuffer.oldestSeq` compared to `this._lastRebuildOldestSeq`. Drift threshold: `Math.abs(currentOldestSeq - lastOldestSeq) > bufferCapacity * 0.1`. |
| **Transitions** | `timeline.visible.stale` → parent visible state : periodic `_rebuildBuckets()` completes, data is fresh |
|  | `timeline.visible.stale` → `timeline.error.rebuild` : periodic rebuild fails |
| **Error recovery** | Staleness is self-correcting. If the periodic rebuild keeps failing, the chart continues with stale data indefinitely — this is better than showing an error for a minor accuracy issue. |

---

## 3. Transition Summary Table

| # | From | Trigger | To |
|---|------|---------|-----|
| T01 | `hidden` | panel expanded, no data | `visible.empty` |
| T02 | `hidden` | panel expanded, data exists, LIVE | `visible.live.idle` |
| T03 | `hidden` | panel expanded, data exists, PAUSED | `visible.paused.idle` |
| T04 | `visible.empty` | first valid log arrives, LIVE | `visible.live.idle` |
| T05 | `visible.empty` | first valid log arrives, PAUSED | `visible.paused.idle` |
| T06 | `visible.empty` | WebSocket lost | `disconnected` |
| T07 | `visible.loading` | rebuild complete, LIVE | `visible.live.idle` |
| T08 | `visible.loading` | rebuild complete, PAUSED | `visible.paused.idle` |
| T09 | `visible.loading` | rebuild fails | `error.rebuild` |
| T10 | `visible.live.idle` | mouse enters `.etl-col` | `visible.live.hovering` |
| T11 | `visible.live.idle` | click bar (total > 0) | `visible.filtered` |
| T12 | `visible.live.idle` | `streamMode → PAUSED` | `visible.paused.idle` |
| T13 | `visible.live.idle` | panel collapsed / width < 200px | `hidden` |
| T14 | `visible.live.idle` | WebSocket lost | `disconnected` |
| T15 | `visible.live.idle` | buffer evicts all entries | `visible.empty` |
| T16 | `visible.live.idle` | `updateIncremental()` fails 3x | `error.update` |
| T17 | `visible.live.hovering` | mouse leaves `.etl-col` | `visible.live.idle` |
| T18 | `visible.live.hovering` | click bar | `visible.filtered` |
| T19 | `visible.live.hovering` | `streamMode → PAUSED` | `visible.paused.hovering` |
| T20 | `visible.live.hovering` | WebSocket lost | `disconnected` |
| T21 | `visible.paused.idle` | `streamMode → LIVE` | `visible.live.idle` |
| T22 | `visible.paused.idle` | mouse enters `.etl-col` | `visible.paused.hovering` |
| T23 | `visible.paused.idle` | click bar | `visible.filtered` |
| T24 | `visible.paused.idle` | WebSocket lost | `disconnected` |
| T25 | `visible.paused.hovering` | mouse leaves `.etl-col` | `visible.paused.idle` |
| T26 | `visible.paused.hovering` | click bar | `visible.filtered` |
| T27 | `visible.paused.hovering` | `streamMode → LIVE` | `visible.live.hovering` |
| T28 | `visible.filtered` | click same bar / double-click / Escape | `visible.live.idle` or `visible.paused.idle` |
| T29 | `visible.filtered` | click different bar | `visible.filtered` (new index) |
| T30 | `visible.filtered` | mouse enters `.etl-col` | `visible.filtered.hovering` |
| T31 | `visible.filtered` | "Clear all filters" toolbar button | `visible.live.idle` or `visible.paused.idle` |
| T32 | `visible.filtered` | WebSocket lost | `disconnected` |
| T33 | `visible.filtered.hovering` | mouse leaves `.etl-col` | `visible.filtered` |
| T34 | `visible.filtered.hovering` | click different bar | `visible.filtered` (new index) |
| T35 | `visible.filtered.hovering` | filter cleared | `visible.live.idle` |
| T36 | `disconnected` | WebSocket reconnects, buffer intact | `visible.live.idle` |
| T37 | `disconnected` | WebSocket reconnects, buffer reset | `visible.loading` |
| T38 | `disconnected` | WebSocket reconnects, buffer empty | `visible.empty` |
| T39 | `disconnected` | panel collapsed | `hidden` |
| T40 | `error.rebuild` | Retry clicked, succeeds | `visible.live.idle` |
| T41 | `error.rebuild` | Retry clicked, fails again | `error.rebuild` (retry counter++) |
| T42 | `error.update` | "Refresh timeline" clicked, succeeds | `visible.live.idle` |
| T43 | `error.update` | refresh fails | `error.rebuild` |
| T44 | `visible.live.updating` | batch processed OK | `visible.live.idle` |
| T45 | `visible.live.updating` | time-range extended | `visible.live.rebucketing` |
| T46 | `visible.live.rebucketing` | rebuild succeeds | `visible.live.idle` |
| T47 | `visible.live.rebucketing` | rebuild fails | `error.rebuild` |
| T48 | `visible.stale` | periodic rebuild succeeds | parent visible state |
| T49 | any visible state | panel collapsed / width < 200px | `hidden` |
| T50 | any visible state | WebSocket lost | `disconnected` |

---

## 4. Cross-Cutting Concerns

### 4.1 Theme Change

**Trigger:** User toggles light/dark theme via `[data-theme]` attribute on `:root`.

**Impact:** None on state machine. All bar colors use CSS custom properties (`--level-error`, `--level-warning`, `--level-message`), tooltip uses `--surface-3`, `--text`, `--font-mono`. Theme switch auto-propagates through CSS — no JS intervention, no re-render, no state transition. Bar segment colors update instantly.

### 4.2 Panel Resize

**Trigger:** `ResizeObserver` fires on the `.error-timeline` container.

**Impact:** CSS grid `1fr` columns auto-adapt. If width crosses 200px threshold, transitions to/from `hidden`. The `resizing` state (S13) handles this. No bucket recalculation needed — bar widths are purely CSS. Tooltip position recalculates on next hover (using fresh `getBoundingClientRect()`).

### 4.3 Disconnected State

**Trigger:** WebSocket `onclose` / `onerror` event.

**Impact:** All interactive states interrupted. Chart freezes at last rendered data. On reconnect, behavior depends on buffer state: full rebuild if buffer was reset, incremental resume if buffer is intact. `state.timelineFilter` is preserved across disconnect/reconnect.

### 4.4 Tab Visibility

**Trigger:** User switches browser tabs or minimizes window.

**Impact:** `updateIncremental()` continues to process batches in memory (data stays current). No DOM rendering occurs while hidden (browser optimizes this). On tab return, the chart is already up-to-date — no catch-up needed.

### 4.5 Print Media

**Impact:** `@media print { .error-timeline { display: none; } }` — the timeline is decorative/interactive and not useful in print output. Hidden unconditionally.

### 4.6 Touch Devices

**Impact:** Hover states (`live.hovering`, `paused.hovering`, `filtered.hovering`) use `touchstart` as entry trigger and `touchend` as exit trigger. No long-press behavior. Click-to-filter works identically via `tap`. Double-tap clears selection.

### 4.7 Accessibility

**Impact:** Container has `role="img"` and `aria-label="Error frequency timeline"`. Tooltip has `aria-hidden="true"` (decorative). Individual bar columns are not individually focusable in MVP — the timeline is a visual overview, not a primary navigation element. Screen reader users rely on the log list and error clustering for equivalent information.

### 4.8 Reduced Motion (`prefers-reduced-motion: reduce`)

When the user has enabled reduced motion at the OS level:

- **Bar height transitions:** The CSS `transition: height 200ms ease` on `.etl-seg` segments is disabled — heights update instantly. `transition-duration: 0s` via media query.
- **Tooltip opacity transition:** Tooltip appears/disappears instantly — no fade. `transition-duration: 0s`.
- **Selection outline:** The `--accent` outline on a selected bar applies instantly — this is not motion, so it remains unchanged.
- **Dimming on filter (`.etl-dimmed` opacity: 0.3):** The opacity change on non-selected bars applies instantly — `transition-duration: 0s`.
- **Hover bar opacity (0.8):** Still applies — simple property change, acceptable under reduced motion guidelines.
- **Rebucketing full re-render:** No animation to disable — `_renderBars()` is a synchronous DOM update.

**Implementation:**
```css
@media (prefers-reduced-motion: reduce) {
  .etl-seg,
  .etl-tooltip,
  .etl-col { transition-duration: 0s !important; }
}
```

**No state machine impact** — all states and transitions remain identical. Only CSS transition durations change.

---

## 5. State Instance Variables

Summary of instance variables that track state:

| Variable | Type | Purpose |
|----------|------|---------|
| `this.buckets` | `TimelineBucket[]` | Current bucket data (30–60 entries) |
| `this.bucketCount` | `number` | Number of active buckets |
| `this.bucketDuration` | `number` | Milliseconds per bucket |
| `this.timeOrigin` | `number` | Earliest timestamp (Unix ms) |
| `this._selectedIndex` | `number` | Selected bar index (-1 = none) |
| `this._lastWidth` | `number` | Last observed container width (px) |
| `this._consecutiveFailures` | `number` | Consecutive `updateIncremental()` failures |
| `this._lastRebuildOldestSeq` | `number` | `logBuffer.oldestSeq` at last full rebuild |
| `this._batchesSinceRebuild` | `number` | Counter for periodic rebuild trigger |
| `state.timelineFilter` | `{ startMs, endMs } \| null` | Shared state: active time filter |
| `state.streamMode` | `'LIVE' \| 'PAUSED'` | Stream state (read-only for timeline) |
