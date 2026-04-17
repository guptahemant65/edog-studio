# Stream Controller — P3 State Matrix

> **Component:** C05 Log Stream Controller
> **Feature:** F12 Error Intelligence
> **Phase:** P3
> **Owner:** Pixel
> **Status:** SPEC
> **Inputs:** C05 deep spec, architecture.md §4, p0-foundation.md §1.1

---

## Overview

The Stream Controller manages log viewport behavior through two primary modes — **LIVE** (auto-scrolling, real-time rendering) and **PAUSED** (frozen viewport, silent buffering) — plus **DISCONNECTED** and **RESUMING** transient states. This matrix defines every visual state, entry/exit condition, transition, keyboard shortcut, data contract, and error recovery path.

---

## State Machine Diagram

```
                                    ┌─────────────────────────────┐
                                    │     stream.disconnected     │
                                    │  (no SignalR, no data flow) │
                                    └──────────┬──────────────────┘
                                               │ SignalR connects
                                               ▼
                              ┌──────────────────────────────────────┐
                              │          stream.reconnecting         │
                              │  (handshake in progress, UI locked)  │
                              └──────────┬───────────────────────────┘
                                         │ connection established
                                         ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                          stream.live.*                                  │
  │  ┌─────────┐     logs arrive     ┌───────────┐    burst (>50/s)        │
  │  │  .idle   │ ──────────────────► │ .receiving │ ───────────► .burst    │
  │  └─────────┘                     └───────────┘    <20/s ◄────┘         │
  │       │  filter applied                │  filter applied                │
  │       ▼                                ▼                               │
  │  .filtered                        .filtered                            │
  └────────────────────────────┬───────────────────────────────────────────┘
                               │
                               │  scroll-up / Space / mouseenter
                               ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                         stream.paused.*                                 │
  │                                                                         │
  │  ┌────────────────┐   ┌────────────────┐   ┌────────────────────┐      │
  │  │ .scroll.*      │   │ .hover.*       │   │ .manual.*          │      │
  │  │  .buffering    │   │  .buffering    │   │  .buffering        │      │
  │  │  .buffer-warn  │   │  .filtered     │   │  .buffer-warn      │      │
  │  │  .buffer-full  │   └────────────────┘   │  .buffer-full      │      │
  │  │  .filtered     │                        │  .filtered          │      │
  │  └────────────────┘                        └────────────────────┘      │
  │                                                                         │
  │  ┌──────────────────────────────────┐                                   │
  │  │ .combined.scroll-hover           │ (multiple pause reasons active)   │
  │  │ .combined.manual-hover           │                                   │
  │  └──────────────────────────────────┘                                   │
  └────────────────────────────┬───────────────────────────────────────────┘
                               │
                               │  badge click / End / Ctrl+↓ / Space / FAB / mouseleave(hover-only)
                               ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                       stream.resuming.*                                 │
  │                                                                         │
  │  ┌──────────────┐    scroll complete    ┌──────────────┐               │
  │  │ .scroll-snap  │ ──────────────────► │ .buffer-flush │ ──► LIVE      │
  │  └──────────────┘                      └──────────────┘               │
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## Pause Reason Priority Rules

Pause reasons have a strict priority order. Higher-priority reasons **upgrade** lower ones but never downgrade.

| Priority | Reason | Sticky? | mouseleave resumes? |
|----------|--------|---------|---------------------|
| 1 (highest) | `manual` | Yes | No |
| 2 | `scroll` | Yes | No |
| 3 (lowest) | `hover` | No | Yes (only if sole reason) |

**Upgrade rules:**
- `hover` → `scroll`: User scrolls up while hover-paused. Reason upgrades to `scroll`. mouseleave no longer resumes.
- `hover` → `manual`: User presses Space while hover-paused. Reason upgrades to `manual`. mouseleave no longer resumes.
- `scroll` → `manual`: User presses Space while scroll-paused. This is a toggle — it **resumes** to LIVE (not an upgrade).
- Any reason → user clicks badge / End / Ctrl+↓ / FAB: Always resumes to LIVE regardless of reason.

---

## States

### stream.disconnected.idle

**Entry conditions:**
- Application initializes before FLT SignalR connection is established
- SignalR connection drops (onStatusChange fires `'disconnected'`)
- FLT process crashes (`state.phase === 'crashed'`)

**Exit conditions:**
- SignalR begins reconnection attempt → `stream.reconnecting`
- User triggers manual connect (deploy/resume) → `stream.reconnecting`

**Visual description:**
- Stream badge: `● OFFLINE` with `color: var(--text-muted)` (gray), no pulse animation
- Badge dot: gray (#888), static
- No buffered count displayed
- Log viewport frozen at last-received content (or empty if first launch)
- Scroll FAB hidden
- Toolbar connection indicator shows `● Disconnected`

**Keyboard shortcuts:**
- None specific to this state (global shortcuts like Ctrl+Shift+D for deploy still active)

**Data requirements:**
- `state.streamMode = 'PAUSED'` (implicitly — no data flow)
- `state.bufferedCount = 0` (nothing to buffer)
- `state.pauseReason = null`
- SignalR `ws.status === 'disconnected'`
- Ring buffer and filter index retain last-known data (not cleared)

**Transitions:**
- → `stream.reconnecting` : SignalR `onStatusChange('reconnecting')` fires
- → `stream.reconnecting` : User deploys or resumes FLT process
- Self-loop: Multiple disconnect events while already disconnected (idempotent)

**Error recovery:**
- Display stale data from ring buffer — never clear viewport on disconnect
- Show "Connection lost — waiting for FLT" status message in toolbar
- If disconnect persists >30s, no automatic retry (user must trigger deploy)

---

### stream.disconnected.stale

**Entry conditions:**
- Was previously connected and receiving logs, then disconnected
- Ring buffer contains data from before disconnect

**Exit conditions:**
- SignalR reconnects → `stream.reconnecting`

**Visual description:**
- Same as `stream.disconnected.idle` but log viewport shows stale data
- Faded overlay or reduced opacity (0.7) on log rows to signal staleness
- Badge: `● OFFLINE · stale` in muted color
- Last-received timestamp visible in toolbar status

**Keyboard shortcuts:**
- Scroll navigation (↑/↓/PgUp/PgDn) still works — user can browse stale logs

**Data requirements:**
- Ring buffer retains data; filter index intact
- `state.streamMode = 'PAUSED'`
- No WebSocket subscriptions active

**Transitions:**
- → `stream.reconnecting` : Connection attempt initiated
- → `stream.disconnected.idle` : User clears log buffer manually

**Error recovery:**
- Preserve all ring buffer data; never evict on disconnect
- If user applies filter while disconnected, filter index updates against stale data (correct behavior)

---

### stream.reconnecting

**Entry conditions:**
- SignalR `onStatusChange('reconnecting')` fires after a disconnect
- User triggers deploy/connect action while in `stream.disconnected.*`
- Automatic reconnection attempt by SignalR client

**Exit conditions:**
- Connection succeeds → `stream.live.idle`
- Connection fails after timeout → `stream.disconnected.idle`

**Visual description:**
- Stream badge: `● RECONNECTING` with amber color, dot has a slow spin animation (CSS `@keyframes spin`)
- Toolbar connection indicator: `● Reconnecting`
- Log viewport unchanged (shows stale data or empty)
- No new logs rendered

**Keyboard shortcuts:**
- None — keyboard resume shortcuts are no-ops during reconnection

**Data requirements:**
- `state.streamMode = 'PAUSED'` (no data flow yet)
- SignalR `ws.status === 'reconnecting'`
- Pending connection timeout timer active

**Transitions:**
- → `stream.live.idle` : `onStatusChange('connected')` fires, data flow begins
- → `stream.disconnected.idle` : Reconnection fails, timeout exceeded
- Self-loop: Multiple reconnection status events (idempotent)

**Error recovery:**
- If reconnection fails, revert to `stream.disconnected.idle`
- Show brief toast: "Reconnection failed — click Deploy to retry"
- Do not auto-retry indefinitely — defer to SignalR client's built-in retry policy (3 attempts with exponential backoff)

---

### stream.live.idle

**Entry conditions:**
- Initial connection established and no logs received yet
- All buffered logs flushed after resume, no new logs arriving
- Log rate drops to 0 entries/second for >2 seconds

**Exit conditions:**
- First log entry arrives → `stream.live.receiving`
- User scrolls up → `stream.paused.scroll.buffering`
- User presses Space → `stream.paused.manual.buffering`
- Mouse enters log viewport (hover-freeze enabled) → `stream.paused.hover.buffering`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `● LIVE` with green pulsing dot (`@keyframes stream-pulse`, 2s ease-in-out)
- `.stream-label`: "LIVE", `color: var(--stream-live)` (#18a058 light / #36d475 dark)
- `.stream-count`: hidden
- Viewport pinned to bottom (auto-scroll active)
- Scroll FAB hidden
- `cursor: default` on badge

**Keyboard shortcuts:**
- `Space` (when detail panel closed, not in input): → `stream.paused.manual.buffering`
- `End`: No-op (already at bottom)
- `Ctrl+↓` / `Cmd+↓`: No-op (already LIVE)

**Data requirements:**
- `state.streamMode = 'LIVE'`
- `state.bufferedCount = 0`
- `state.pauseReason = null`
- `state.autoScroll = true` (via backward-compat getter)
- SignalR subscription active
- `flush()` renders DOM on each throttled cycle (100ms)

**Transitions:**
- → `stream.live.receiving` : `addLog()` called with new entry
- → `stream.paused.scroll.buffering` : `_onScroll()` detects >68px from bottom
- → `stream.paused.manual.buffering` : Space key fires `togglePause()`
- → `stream.paused.hover.buffering` : `mouseenter` on `scrollContainer` (if `hoverFreezeEnabled`)
- → `stream.disconnected.stale` : `onStatusChange('disconnected')`
- → `stream.live.filtered` : User applies any filter

**Error recovery:**
- If `flush()` throws during render, catch error, log to console, continue — do not break auto-scroll
- If `scrollToBottom()` fails (container null), silently skip — container may be unmounted during tab switch

---

### stream.live.receiving

**Entry conditions:**
- Log entry arrives via `addLog()` while in any `stream.live.*` state
- Log rate is >0 but ≤50 entries/second

**Exit conditions:**
- Log rate exceeds 50 entries/second sustained for 1 second → `stream.live.burst`
- No logs for >2 seconds → `stream.live.idle`
- Any pause trigger → corresponding `stream.paused.*` state
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `● LIVE` with green pulsing dot (identical to idle visually)
- Viewport auto-scrolls to newest entry on each render cycle
- New rows appear at bottom, virtual scroll recycles top rows
- Stats counters (total logs, errors, warnings) update in real-time

**Keyboard shortcuts:**
- `Space`: → `stream.paused.manual.buffering`
- `End`: No-op
- `Ctrl+↓` / `Cmd+↓`: No-op

**Data requirements:**
- `state.streamMode = 'LIVE'`
- `state.bufferedCount = 0`
- `state.newLogsSinceRender` increments per `addLog()`, resets on `flush()`
- Ring buffer receives entries; filter index updates incrementally
- `flush()` calls `_renderVirtualScroll()` → `_populateRow()` for visible rows

**Transitions:**
- → `stream.live.burst` : >50 entries/second sustained
- → `stream.live.idle` : 0 entries for >2s
- → `stream.live.filtered` : Filter applied
- → `stream.paused.scroll.buffering` : Scroll up >68px
- → `stream.paused.manual.buffering` : Space key
- → `stream.paused.hover.buffering` : mouseenter (if hover-freeze on)
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- If `_populateRow()` throws for a single row, skip that row, log warning, continue rendering remaining rows
- Ring buffer is append-only; individual row render failure does not corrupt data

---

### stream.live.burst

**Entry conditions:**
- Log ingestion rate exceeds 50 entries/second for a sustained 1-second window
- Typically during DAG execution phases or error cascades

**Exit conditions:**
- Rate drops below 20 entries/second for 2 seconds → `stream.live.receiving`
- Any pause trigger → corresponding `stream.paused.*` state
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `● LIVE` (same as receiving — no visual distinction for burst)
- Auto-scroll still active; viewport pinned to bottom
- Render throttle (`renderThrottleMs = 100ms`) absorbs burst — DOM updates at 10fps max regardless of ingestion rate
- Stats counters may lag slightly during burst (acceptable — they update on flush)

**Keyboard shortcuts:**
- Same as `stream.live.receiving`

**Data requirements:**
- Same as `stream.live.receiving`
- Ring buffer may wrap during sustained burst (oldest entries evicted)
- Filter index rebuild deferred until next non-burst flush cycle
- `state.newLogsSinceRender` may accumulate large values between flushes

**Transitions:**
- → `stream.live.receiving` : Rate drops below 20/s for 2s (hysteresis prevents flapping)
- → `stream.live.idle` : Rate drops to 0
- → `stream.paused.scroll.buffering` : Scroll up during burst
- → `stream.paused.manual.buffering` : Space key during burst
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- If ring buffer wraps, old entries lost — expected behavior, not an error
- If flush takes >100ms during burst (layout thrash), skip one frame — `renderScheduled` flag prevents double-render
- Monitor `performance.now()` in flush; if >16ms, reduce OVERSCAN temporarily

---

### stream.live.filtered

**Entry conditions:**
- User applies any filter (level, text search, component, RAID, correlation, time range, endpoint) while in any `stream.live.*` state

**Exit conditions:**
- User clears all filters → returns to previous `stream.live.*` sub-state
- Any pause trigger → `stream.paused.*.filtered`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `● LIVE` (unchanged — filter state shown separately in filter toolbar)
- Filter toolbar shows active filter chips/badges
- Viewport shows only filtered rows, auto-scrolled to latest matching entry
- `updateSearchCount()` displays "showing N of M" in status bar
- Virtual scroll renders only entries in `filterIndex`

**Keyboard shortcuts:**
- `Space`: → `stream.paused.manual.filtered`
- `Escape`: Clears current search text (existing behavior)
- `Ctrl+F` / `Cmd+F`: Focus search input (existing)

**Data requirements:**
- `state.streamMode = 'LIVE'`
- `state.filterIndex` contains subset of ring buffer matching active filters
- `passesFilter(entry)` evaluated for each entry
- New entries arriving are checked against filter on `filterIndex.updateIncremental()`
- Matching entries auto-scroll into view; non-matching entries are silently added to ring buffer only

**Transitions:**
- → `stream.live.idle` / `.receiving` / `.burst` : All filters cleared
- → `stream.paused.scroll.filtered` : Scroll up while filtered
- → `stream.paused.manual.filtered` : Space key while filtered
- → `stream.paused.hover.filtered` : mouseenter while filtered (hover-freeze on)
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- If filter regex is invalid (text search), catch error in `passesFilter()`, treat as non-match, show "invalid regex" indicator
- Empty filter index (no matches): viewport empty, badge still shows `● LIVE`, status shows "0 of N"

---

### stream.paused.scroll.buffering

**Entry conditions:**
- User scrolls up while in any `stream.live.*` state
- `_onScroll()` detects `scrollTop + clientHeight < scrollHeight - 68px` (2-row threshold)
- `Date.now() > _scrollPinUntil` (not within 80ms of programmatic scroll)

**Exit conditions:**
- User clicks stream badge → `stream.resuming.scroll-snap`
- User presses End key → `stream.resuming.scroll-snap`
- User presses Ctrl+↓ / Cmd+↓ → `stream.resuming.scroll-snap`
- User presses Space → `stream.resuming.scroll-snap`
- User clicks scroll FAB → `stream.resuming.scroll-snap`
- User manually scrolls back to bottom (within 68px) → `stream.live.receiving`
- Buffer count exceeds warning threshold → `stream.paused.scroll.buffer-warn`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `⏸ PAUSED · N new` with amber color, static dot (no pulse)
- `.stream-dot`: `background: var(--stream-paused)` (#e5940c light / #f5a623 dark)
- `.stream-label`: "PAUSED", `color: var(--stream-paused)`
- `.stream-count`: visible, shows ` · N new` with `font-variant-numeric: tabular-nums`
- `cursor: pointer` on badge (clicking resumes)
- `title="Click to resume (End)"`
- Scroll FAB visible (existing `#resume-scroll-btn`)
- Viewport frozen — user can scroll freely through historical logs
- Stats and filter index still update in background (flush paused path)

**Keyboard shortcuts:**
- `End`: Resume → `stream.resuming.scroll-snap`
- `Ctrl+↓` / `Cmd+↓`: Resume → `stream.resuming.scroll-snap`
- `Space` (detail panel closed): Resume → `stream.resuming.scroll-snap`
- `↑` / `↓` / `PgUp` / `PgDn`: Scroll through paused viewport (existing behavior)

**Data requirements:**
- `state.streamMode = 'PAUSED'`
- `state.pauseReason = 'scroll'`
- `state.bufferedCount` increments on each `addLog()` call
- `state.hoverFreezeEnabled` — irrelevant (already paused)
- `flush()` runs but short-circuits before `_renderVirtualScroll()`:
  - Updates `filterIndex.updateIncremental()` if `newLogsSinceRender > 0`
  - Calls `updateStats()` and `_updateStreamBadge()`
- Ring buffer continues receiving entries

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger (badge click, End, Ctrl+↓, Space, FAB)
- → `stream.live.receiving` : User scrolls back to bottom naturally (within 68px threshold)
- → `stream.paused.scroll.buffer-warn` : `bufferedCount > 5000`
- → `stream.paused.scroll.filtered` : User applies filter while paused
- → `stream.paused.combined.scroll-hover` : mouseenter while scroll-paused (hover-freeze on)
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- `bufferedCount` is a plain JS number — safe to Number.MAX_SAFE_INTEGER (~9×10¹⁵)
- Ring buffer wrap during pause: old entries evicted but `bufferedCount` remains accurate (counts arrivals, not retained)
- `_updateStreamBadge()` failure: catch and log — counter display stale but state machine unaffected

---

### stream.paused.scroll.buffer-warn

**Entry conditions:**
- `bufferedCount` exceeds 5,000 while in `stream.paused.scroll.buffering`
- Indicates long pause during active log ingestion

**Exit conditions:**
- Any resume trigger → `stream.resuming.scroll-snap`
- `bufferedCount > 8000` → `stream.paused.scroll.buffer-full`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `⏸ PAUSED · 5,238 new` — same as buffering but count displayed in warning color
- `.stream-count` gets additional class `.count-warning` with slightly bolder styling
- Optional subtle amber background pulse on the badge to draw attention
- Tooltip: "Many logs buffered — consider resuming"
- All other visuals same as `.scroll.buffering`

**Keyboard shortcuts:**
- Same as `stream.paused.scroll.buffering`

**Data requirements:**
- Same as `.scroll.buffering`
- Warning threshold: `bufferedCount > 5000` (ring buffer is 10K, so 50% capacity)

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- → `stream.paused.scroll.buffer-full` : `bufferedCount > 8000`
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- Warning is purely visual — no state machine error possible
- If `_updateStreamBadge()` fails to add warning class, degrade to normal count display

---

### stream.paused.scroll.buffer-full

**Entry conditions:**
- `bufferedCount` exceeds 8,000 while in `stream.paused.scroll.buffer-warn`
- Ring buffer nearing full wrap (10K capacity)

**Exit conditions:**
- Any resume trigger → `stream.resuming.scroll-snap`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `⏸ PAUSED · 8,412 new` — count in red/error color
- `.stream-count` class `.count-critical`
- Badge background shifts to `rgba(220, 38, 38, 0.08)` (error tint)
- Tooltip: "Buffer near capacity — oldest logs being dropped. Resume to catch up."
- Ring buffer is actively wrapping — old entries being evicted

**Keyboard shortcuts:**
- Same as `stream.paused.scroll.buffering`

**Data requirements:**
- Same as `.scroll.buffering`
- Ring buffer wrapping: `logBuffer.push()` evicts oldest on overflow
- `bufferedCount` still counts total arrivals, not retained count
- On resume, viewport shows whatever ring buffer still holds (newest entries)

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- → `stream.disconnected.stale` : Connection lost
- Count continues to grow even past 10K — ring buffer wraps but `bufferedCount` is unbounded

**Error recovery:**
- Data loss is expected (ring buffer is a circular buffer by design)
- `bufferedCount` reflects total arrivals since pause, not available entries
- On resume, `filterIndex` rebuilds from current ring buffer contents — may have fewer entries than `bufferedCount` suggested

---

### stream.paused.scroll.filtered

**Entry conditions:**
- User applies a filter while in any `stream.paused.scroll.*` state, OR
- User scrolls up while in `stream.live.filtered`

**Exit conditions:**
- Any resume trigger → `stream.resuming.scroll-snap`
- User clears all filters → `stream.paused.scroll.buffering`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `⏸ PAUSED · N new` — count reflects **total** buffered (not filtered count)
- Filter toolbar shows active filter chips
- Viewport shows filtered view of historical logs (user can scroll through filtered results)
- Status bar: "showing N of M (paused)"

**Keyboard shortcuts:**
- Same as `stream.paused.scroll.buffering`
- `Escape`: Clear search text filter

**Data requirements:**
- `state.streamMode = 'PAUSED'`
- `state.pauseReason = 'scroll'`
- `state.bufferedCount` tracks ALL arriving logs (unfiltered)
- `filterIndex` updates incrementally during pause (entries checked against filter)
- Viewport renders from `filterIndex` (filtered subset)

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- → `stream.paused.scroll.buffering` : All filters cleared
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- Filter change during pause: `filterIndex.rebuild()` runs, `flush()` short-circuits DOM — filter index accurate, viewport stale until manual scroll triggers re-render
- Invalid filter regex: Caught in `passesFilter()`, treated as no match

---

### stream.paused.hover.buffering

**Entry conditions:**
- Mouse enters `scrollContainer` while in any `stream.live.*` state
- `state.hoverFreezeEnabled === true`
- `state.streamMode === 'LIVE'` at time of mouseenter

**Exit conditions:**
- Mouse leaves `scrollContainer` → `stream.live.receiving` (auto-resume)
- User scrolls up → reason **upgrades** to `scroll`: `stream.paused.scroll.buffering`
- User presses Space → reason **upgrades** to `manual`: `stream.paused.manual.buffering`
- User clicks badge / End / Ctrl+↓ / FAB → `stream.resuming.scroll-snap`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `⏸ PAUSED · N new` (identical to scroll-pause visually)
- Badge may optionally show hover icon or "hover" label for clarity (defer to design bible)
- Viewport frozen at current position — user can read logs without them jumping
- Scroll FAB visible

**Keyboard shortcuts:**
- `Space`: Upgrades to `stream.paused.manual.buffering` (does NOT resume)
- `End`: Resume → `stream.resuming.scroll-snap`
- `Ctrl+↓` / `Cmd+↓`: Resume → `stream.resuming.scroll-snap`

**Data requirements:**
- `state.streamMode = 'PAUSED'`
- `state.pauseReason = 'hover'`
- `state.bufferedCount` incrementing
- `_onHoverLeave` checks `pauseReason === 'hover'` before resuming

**Transitions:**
- → `stream.live.receiving` : `mouseleave` on `scrollContainer` (ONLY if `pauseReason` still `'hover'`)
- → `stream.paused.scroll.buffering` : User scrolls up — reason upgrades (`hover` → `scroll`)
- → `stream.paused.manual.buffering` : Space key — reason upgrades (`hover` → `manual`)
- → `stream.resuming.scroll-snap` : Badge click, End, Ctrl+↓, FAB
- → `stream.paused.combined.scroll-hover` : User scrolls up while hover-paused (alternative model — see combined states)
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- `mouseleave` never fires (e.g., browser loses focus): User can press End or click badge to resume manually
- `mouseenter` fires on child elements: Non-issue — `mouseenter` does not bubble from children (unlike `mouseover`)
- Rapid enter/leave: Each pair is atomic — no debounce needed

---

### stream.paused.hover.filtered

**Entry conditions:**
- User hovers into log area while in `stream.live.filtered`
- `hoverFreezeEnabled === true`

**Exit conditions:**
- `mouseleave` → `stream.live.filtered`
- Scroll up → `stream.paused.scroll.filtered`
- Space → `stream.paused.manual.filtered`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Same as `stream.paused.hover.buffering` plus active filter chips
- Status: "showing N of M (paused)"

**Keyboard shortcuts:**
- Same as `stream.paused.hover.buffering`

**Data requirements:**
- Same as `stream.paused.hover.buffering` plus active filter state
- Filter index updates continue during pause

**Transitions:**
- → `stream.live.filtered` : `mouseleave` (if `pauseReason` still `'hover'`)
- → `stream.paused.scroll.filtered` : Scroll up
- → `stream.paused.manual.filtered` : Space key
- → `stream.resuming.scroll-snap` : Badge / End / Ctrl+↓ / FAB

**Error recovery:**
- Same as `stream.paused.hover.buffering`

---

### stream.paused.manual.buffering

**Entry conditions:**
- User presses Space while in any `stream.live.*` state (and detail panel is closed, focus not in input)
- User presses Space while in `stream.paused.hover.buffering` (upgrade from hover)

**Exit conditions:**
- User presses Space again → `stream.resuming.scroll-snap` (toggle)
- Badge click / End / Ctrl+↓ / FAB → `stream.resuming.scroll-snap`
- `bufferedCount > 5000` → `stream.paused.manual.buffer-warn`
- Connection drops → `stream.disconnected.stale`

**Visual description:**
- Stream badge: `⏸ PAUSED · N new` (identical to scroll-pause visually)
- Scroll FAB visible
- User can scroll freely through logs
- `cursor: pointer` on badge

**Keyboard shortcuts:**
- `Space`: Resume → `stream.resuming.scroll-snap` (toggle behavior)
- `End`: Resume → `stream.resuming.scroll-snap`
- `Ctrl+↓` / `Cmd+↓`: Resume → `stream.resuming.scroll-snap`

**Data requirements:**
- `state.streamMode = 'PAUSED'`
- `state.pauseReason = 'manual'`
- `state.bufferedCount` incrementing
- `mouseleave` will NOT resume (pauseReason !== 'hover')

**Transitions:**
- → `stream.resuming.scroll-snap` : Space (toggle), badge click, End, Ctrl+↓, FAB
- → `stream.paused.manual.buffer-warn` : `bufferedCount > 5000`
- → `stream.paused.manual.filtered` : Filter applied
- → `stream.disconnected.stale` : Connection lost

**Error recovery:**
- Same as `stream.paused.scroll.buffering` — no unique error modes

---

### stream.paused.manual.buffer-warn

**Entry conditions:**
- `bufferedCount > 5000` while in `stream.paused.manual.buffering`

**Exit conditions:**
- Any resume trigger → `stream.resuming.scroll-snap`
- `bufferedCount > 8000` → `stream.paused.manual.buffer-full`

**Visual description:**
- Same as `stream.paused.scroll.buffer-warn` — warning styling on count

**Keyboard shortcuts:**
- Same as `stream.paused.manual.buffering`

**Data requirements:**
- Same as `stream.paused.manual.buffering`

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- → `stream.paused.manual.buffer-full` : `bufferedCount > 8000`

**Error recovery:**
- Same as `stream.paused.scroll.buffer-warn`

---

### stream.paused.manual.buffer-full

**Entry conditions:**
- `bufferedCount > 8000` while in `stream.paused.manual.buffer-warn`

**Exit conditions:**
- Any resume trigger → `stream.resuming.scroll-snap`

**Visual description:**
- Same as `stream.paused.scroll.buffer-full` — critical styling on count, ring buffer wrapping

**Keyboard shortcuts:**
- Same as `stream.paused.manual.buffering`

**Data requirements:**
- Same as `stream.paused.manual.buffering`, ring buffer wrapping

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger

**Error recovery:**
- Same as `stream.paused.scroll.buffer-full`

---

### stream.paused.manual.filtered

**Entry conditions:**
- Filter applied while in any `stream.paused.manual.*` state, OR
- Space key pressed while in `stream.live.filtered`

**Exit conditions:**
- Any resume trigger → `stream.resuming.scroll-snap`
- All filters cleared → `stream.paused.manual.buffering`

**Visual description:**
- Same as `stream.paused.scroll.filtered` but `pauseReason = 'manual'`

**Keyboard shortcuts:**
- Same as `stream.paused.manual.buffering` plus `Escape` to clear search

**Data requirements:**
- Same as `stream.paused.scroll.filtered` with `pauseReason = 'manual'`

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- → `stream.paused.manual.buffering` : All filters cleared

**Error recovery:**
- Same as `stream.paused.scroll.filtered`

---

### stream.paused.combined.scroll-hover

**Entry conditions:**
- User scrolls up while in `stream.paused.hover.buffering`, OR
- Mouse enters `scrollContainer` while in `stream.paused.scroll.buffering` (if tracking multiple reasons)

**Implementation note:** In the C05 spec, combined pause states are modeled via **pause reason upgrade** rather than a separate combined state. When hover-paused and user scrolls up, `pauseReason` upgrades from `'hover'` to `'scroll'` — effectively transitioning to `stream.paused.scroll.buffering`. This section documents the conceptual combined state for completeness.

**Exit conditions:**
- Effective `pauseReason` is `'scroll'` (highest priority among active reasons)
- `mouseleave` does NOT resume (reason upgraded past hover)
- Standard resume triggers (badge, End, Ctrl+↓, Space, FAB) → `stream.resuming.scroll-snap`

**Visual description:**
- Identical to `stream.paused.scroll.buffering` (scroll is higher priority, dominates visuals)

**Keyboard shortcuts:**
- Same as `stream.paused.scroll.buffering`

**Data requirements:**
- `state.pauseReason = 'scroll'` (upgraded from `'hover'`)
- `_onHoverLeave` checks `pauseReason !== 'hover'` → no-op

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- `mouseleave` → no-op (reason is `'scroll'`, not `'hover'`)

**Error recovery:**
- Upgrade logic in `_onScroll`: if already PAUSED with `pauseReason === 'hover'`, set `pauseReason = 'scroll'`
- No rollback — upgrades are one-way within a pause session

---

### stream.paused.combined.manual-hover

**Entry conditions:**
- User presses Space while in `stream.paused.hover.buffering`

**Implementation note:** Like scroll-hover, this is modeled as a reason upgrade. Space during hover-pause upgrades `pauseReason` from `'hover'` to `'manual'`.

**Exit conditions:**
- Standard resume triggers → `stream.resuming.scroll-snap`
- `mouseleave` does NOT resume

**Visual description:**
- Identical to `stream.paused.manual.buffering`

**Keyboard shortcuts:**
- `Space`: Resume (toggle) → `stream.resuming.scroll-snap`
- `End` / `Ctrl+↓`: Resume → `stream.resuming.scroll-snap`

**Data requirements:**
- `state.pauseReason = 'manual'` (upgraded from `'hover'`)

**Transitions:**
- → `stream.resuming.scroll-snap` : Any resume trigger
- `mouseleave` → no-op

**Error recovery:**
- Same upgrade logic as `stream.paused.combined.scroll-hover`

---

### stream.resuming.scroll-snap

**Entry conditions:**
- Any resume trigger fires while in any `stream.paused.*` state:
  - Badge click, End key, Ctrl+↓ / Cmd+↓, Space toggle, scroll FAB click
- `_transitionToLive()` called

**Exit conditions:**
- Scroll animation completes → `stream.resuming.buffer-flush`
- (In practice, this is near-instant — `scrollTop` assignment is synchronous)

**Visual description:**
- Stream badge transitions to `● LIVE` (green dot, no count)
- Badge animation: `transition: background-color 0.2s ease, color 0.2s ease`
- Viewport snaps to bottom via `scrollToBottom()` — sets `scrollTop = totalHeight`
- `_scrollPinUntil = Date.now() + 80` — suppresses false pause detection from the programmatic scroll
- Scroll FAB hidden (`hideResumeButton()`)

**Keyboard shortcuts:**
- None — transient state, user input buffered until LIVE stabilizes

**Data requirements:**
- `state.streamMode = 'LIVE'`
- `state.pauseReason = null`
- `state.bufferedCount = 0` (reset)
- `state.autoScroll = true` (via getter)
- `flush()` called immediately — re-enables DOM rendering
- `scrollToBottom()` called after flush

**Transitions:**
- → `stream.resuming.buffer-flush` : `scrollTop` assignment complete (synchronous)
- → `stream.live.receiving` : buffer flush complete, new data rendering
- → `stream.disconnected.stale` : Connection lost during resume (unlikely but possible)

**Error recovery:**
- If `scrollToBottom()` fails (container null during tab switch), set state to LIVE anyway — next flush cycle will handle rendering
- `_scrollPinUntil` prevents immediate re-pause from the scroll event triggered by `scrollTop` assignment
- If `flush()` throws, catch, log, retry on next `scheduleRender` cycle

---

### stream.resuming.buffer-flush

**Entry conditions:**
- Scroll snap complete, viewport at bottom
- `flush()` re-renders the viewport with current ring buffer contents

**Exit conditions:**
- Render complete → `stream.live.receiving` (if logs arriving) or `stream.live.idle` (if quiet)

**Visual description:**
- Viewport populated with latest entries from ring buffer
- Virtual scroll renders visible rows via `_renderVirtualScroll()`
- Any entries that were in the ring buffer during pause are now visible (subject to ring buffer capacity)
- Filter index already up-to-date (maintained during pause)

**Keyboard shortcuts:**
- None — transient state

**Data requirements:**
- Full render cycle: `filterIndex` already current, `_renderVirtualScroll()` populates visible rows
- Rows rendered with current highlight state (search hits, error codes)
- Stats updated

**Transitions:**
- → `stream.live.receiving` : Logs still arriving from SignalR
- → `stream.live.idle` : No log activity
- → `stream.live.filtered` : Filter was active during pause and remains active

**Error recovery:**
- Render failure on individual rows: skip, log, continue
- If ring buffer wrapped during pause, fewer entries than expected — viewport shows what's available

---

## Buffer Management Rules

| Rule | Value | Rationale |
|------|-------|-----------|
| Ring buffer capacity | 10,000 entries | Balance between memory and history depth |
| `bufferedCount` semantics | Total arrivals since pause, not retained count | Accurate even during ring buffer wrap |
| `bufferedCount` reset | Set to 0 on every PAUSED → LIVE transition | Fresh count per pause session |
| Buffer warn threshold | 5,000 | 50% of ring buffer capacity |
| Buffer full threshold | 8,000 | 80% of ring buffer capacity, active wrapping |
| Counter update cadence | Every `renderThrottleMs` (100ms) via `_updateStreamBadge()` in flush | Smooth visual updates without waste |
| Counter format | `toLocaleString()` for thousands separators + `tabular-nums` | Prevents layout shift on digit changes |
| Counter overflow | Plain JS number — safe to ~9×10¹⁵ | Effectively unlimited |

---

## Cross-Cutting Concerns

### Theme Change

- CSS variables (`--stream-live`, `--stream-paused`) auto-update on `[data-theme]` attribute change
- No JavaScript handling needed — badge colors transition automatically
- Dark theme values: `--stream-live: #36d475`, `--stream-paused: #f5a623`
- Light theme values: `--stream-live: #18a058`, `--stream-paused: #e5940c`
- Transition during any state is seamless — no state machine impact

### Tab Switching

- Stream controller is only relevant on the Logs tab
- Switching to Runtime View / DAG / SSR tabs does NOT pause the stream — `addLog()` continues, ring buffer fills, filter index updates
- Switching back to Logs tab: if LIVE, viewport re-renders at bottom; if PAUSED (e.g., user scrolled up before switching), paused state preserved
- `scrollContainer` may be `display: none` while on another tab — `scrollToBottom()` no-ops gracefully (container height is 0)
- `_onScroll` does not fire on hidden containers — no false pause triggers

### Reduced Motion (`prefers-reduced-motion: reduce`)

- `stream-pulse` animation disabled — dot rendered at static `opacity: 0.7`
- `badge-count-in` slide animation disabled — count appears instantly
- Badge color transitions (`0.2s ease`) remain — they are not motion, just color change
- No state machine impact — purely CSS

### Screen Reader / Accessibility

- `#stream-badge` has `role="status"` + `aria-live="polite"`
- Mode changes announced: "LIVE" or "PAUSED, 238 new"
- Rate limited to 100ms (flush cadence) — not excessively chatty
- All resume actions keyboard-accessible: Space, End, Ctrl+↓
- Color is never the sole indicator — text labels "LIVE" / "PAUSED" always present

### Window Resize / DevTools Open

- Container resize may briefly make `isAtBottom` false during LIVE
- Acceptable: user can resume with one keypress or click
- Virtual scroll re-calculates visible range on next flush — self-healing
- No explicit resize handler needed for stream state

### Detail Panel Open

- Space key is suppressed when detail panel is visible (`!this.detail.isVisible` guard)
- End key resume still works (no guard needed — End doesn't conflict with detail panel)
- Ctrl+↓ resume still works
- Opening detail panel does NOT pause the stream
- Closing detail panel does NOT resume the stream

---

## Transition Summary Table

| # | From | Trigger | To | Side Effects |
|---|------|---------|----|-------------|
| T01 | `live.idle` | First log arrives | `live.receiving` | — |
| T02 | `live.receiving` | Rate >50/s sustained 1s | `live.burst` | — |
| T03 | `live.burst` | Rate <20/s for 2s | `live.receiving` | — |
| T04 | `live.receiving` | 0 logs for >2s | `live.idle` | — |
| T05 | `live.*` | Filter applied | `live.filtered` | `filterIndex.rebuild()` |
| T06 | `live.filtered` | All filters cleared | `live.*` (previous sub-state) | `filterIndex.rebuild()` |
| T07 | `live.*` | Scroll up >68px | `paused.scroll.buffering` | `_transitionToPaused('scroll')`, show FAB |
| T08 | `live.*` | Space key | `paused.manual.buffering` | `_transitionToPaused('manual')`, show FAB |
| T09 | `live.*` | mouseenter (hover on) | `paused.hover.buffering` | `_transitionToPaused('hover')`, show FAB |
| T10 | `paused.hover.*` | mouseleave | `live.*` | `_transitionToLive()`, hide FAB |
| T11 | `paused.hover.*` | Scroll up | `paused.scroll.*` | `pauseReason` upgrade `'hover'` → `'scroll'` |
| T12 | `paused.hover.*` | Space key | `paused.manual.*` | `pauseReason` upgrade `'hover'` → `'manual'` |
| T13 | `paused.scroll.*` | Badge click | `resuming.scroll-snap` | `_transitionToLive()` |
| T14 | `paused.scroll.*` | End key | `resuming.scroll-snap` | `_transitionToLive()` |
| T15 | `paused.scroll.*` | Ctrl+↓ / Cmd+↓ | `resuming.scroll-snap` | `_transitionToLive()` |
| T16 | `paused.scroll.*` | Space key | `resuming.scroll-snap` | `_transitionToLive()` (toggle) |
| T17 | `paused.scroll.*` | FAB click | `resuming.scroll-snap` | `_transitionToLive()` |
| T18 | `paused.scroll.*` | Scroll to bottom naturally | `live.receiving` | `_transitionToLive()` via bottom detection |
| T19 | `paused.manual.*` | Space key | `resuming.scroll-snap` | `_transitionToLive()` (toggle) |
| T20 | `paused.manual.*` | Badge / End / Ctrl+↓ / FAB | `resuming.scroll-snap` | `_transitionToLive()` |
| T21 | `paused.*.buffering` | `bufferedCount > 5000` | `paused.*.buffer-warn` | Warning styling on badge |
| T22 | `paused.*.buffer-warn` | `bufferedCount > 8000` | `paused.*.buffer-full` | Critical styling, tooltip |
| T23 | `paused.*` | Filter applied | `paused.*.filtered` | `filterIndex.rebuild()` |
| T24 | `paused.*.filtered` | All filters cleared | `paused.*.buffering` | `filterIndex.rebuild()` |
| T25 | `resuming.scroll-snap` | scrollTop set | `resuming.buffer-flush` | `flush()` renders viewport |
| T26 | `resuming.buffer-flush` | Render complete | `live.receiving` / `live.idle` | Viewport at bottom |
| T27 | `live.*` / `paused.*` | Connection lost | `disconnected.stale` | Badge → OFFLINE, data preserved |
| T28 | `disconnected.*` | Reconnect initiated | `reconnecting` | Badge → RECONNECTING |
| T29 | `reconnecting` | Connection success | `live.idle` | Badge → LIVE, data flow resumes |
| T30 | `reconnecting` | Connection failure | `disconnected.idle` | Error toast |
| T31 | `live.*` / `paused.*` | Theme change | Same state | CSS variables auto-update |
| T32 | `live.*` / `paused.*` | Tab switch away | Same state | Rendering paused (container hidden) |
| T33 | Any | Tab switch back to Logs | Same state | Rendering resumes if LIVE |

---

*State matrix authored by Pixel. Sentinel approval required before implementation.*
