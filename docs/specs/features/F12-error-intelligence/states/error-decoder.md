# Error Decoder Popover — State Matrix

> **Feature:** F12 — Error Intelligence & Log Experience
> **Component:** `ErrorDecoder` (popover card lifecycle)
> **Source:** `src/frontend/js/error-decoder.js` (new)
> **CSS:** `src/frontend/css/logs.css` (error-card classes)
> **Parent:** Renderer (event delegation on `.log-scroll` container)
> **Owner:** Pixel (Frontend Engineer)
> **Total states:** 22
> **Companion:** `components/C02-error-decoder.md` (deep component spec)
> **Status:** SPEC COMPLETE

---

## Table of Contents

1. [State Inventory](#1-state-inventory)
2. [State Transition Diagram](#2-state-transition-diagram)
3. [State Matrix Table](#3-state-matrix-table)
4. [Compound States](#4-compound-states)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Transition Summary Table](#6-transition-summary-table)

---

## 1. State Inventory

| # | State ID | Description |
|---|----------|-------------|
| S01 | `decoder.idle` | No error code hovered or selected. Popover closed. Default resting state. |
| S02 | `decoder.disabled` | Error decoder not initialized (DB missing or constructor failed). All interactions no-op. |
| S03 | `decoder.disconnected` | FLT not connected. Error codes may still decorate from cached DB, but live data unavailable. |
| S04 | `decoder.hover.detecting` | Mouse entered a decorated error code span. 300ms debounce timer running. |
| S05 | `decoder.hover.cancelled` | Mouse left the span before 300ms elapsed. Timer cleared, return to idle. |
| S06 | `decoder.popover.positioning` | Debounce elapsed. Calculating card position against viewport and scroll container bounds. |
| S07 | `decoder.popover.opening` | Card DOM created, positioned, opacity animating in (100ms fade). |
| S08 | `decoder.popover.open.known` | Popover fully visible for a known error code. Full card: title, description, severity badge, suggested fix, occurrence count, node list, action buttons. |
| S09 | `decoder.popover.open.unknown` | Popover fully visible for a pattern-matched unknown error code. Reduced card: code, "not in registry" message, occurrence count, Filter + Copy actions only. |
| S10 | `decoder.popover.open.degraded` | Popover visible but error-codes DB was not loaded. Shows code string and "No error database loaded" message. |
| S11 | `decoder.popover.hovering-card` | Mouse moved from the anchor span onto the card itself. Grace period cancelled. Card stays open. |
| S12 | `decoder.popover.grace-period` | Mouse left both anchor span and card. 150ms grace timer running before dismiss. |
| S13 | `decoder.popover.pinned` | User clicked the error code span. Card is locked open. Requires explicit dismiss. |
| S14 | `decoder.popover.pinned.focused` | Pinned card has focus. Focus trap active. Tab cycles through action buttons and close button. |
| S15 | `decoder.popover.action.filter` | User clicked "Filter to all [CODE]". Search input being set. Card about to dismiss. |
| S16 | `decoder.popover.action.copy` | User clicked "Copy error details". Clipboard write in progress. Card about to dismiss. |
| S17 | `decoder.popover.action.detail` | User clicked "View in detail panel". Detail panel opening for most recent occurrence. Card about to dismiss. |
| S18 | `decoder.popover.closing` | Card dismiss animation in progress (100ms fade-out). |
| S19 | `decoder.keyboard.scanning` | User pressed Ctrl+E. Next error code in viewport is focused/highlighted. |
| S20 | `decoder.keyboard.navigating` | User pressing Ctrl+E repeatedly to cycle through error codes in visible rows. |
| S21 | `decoder.scroll.dismissing` | User scrolled while hover-mode card was open. Card dismissed immediately. |
| S22 | `decoder.scroll.repositioning` | User scrolled while pinned card is open. Anchor validity check + reposition in progress. |

---

## 2. State Transition Diagram

```
                              ┌──────────────┐
                              │   disabled   │  DB missing / init failed
                              │    (S02)     │  (terminal until reload)
                              └──────────────┘

                              ┌──────────────┐
                              │ disconnected │  FLT not connected
                              │    (S03)     │  (overlay on any state)
                              └──────────────┘

                              ┌──────────────┐
               ┌──────────────│     idle     │◂─────────────────────────────┐
               │              │    (S01)     │◂──────────┐                  │
               │              └───┬──────┬───┘           │                  │
               │                  │      │               │                  │
               │    mouseenter    │      │  Ctrl+E       │                  │
               │    on code span  │      │               │                  │
               │                  ▼      ▼               │                  │
               │     ┌────────────────┐  ┌────────────────────┐             │
               │     │ hover.detecting│  │keyboard.scanning   │             │
               │     │     (S04)      │  │      (S19)         │             │
               │     └───┬────────┬───┘  └────────┬───────────┘             │
               │         │        │               │                         │
               │  mouseleave     300ms            │ Ctrl+E again            │
               │  (< 300ms)      elapsed          ▼                         │
               │         │        │      ┌────────────────────┐             │
               │         ▼        │      │keyboard.navigating │             │
               │ ┌──────────────┐ │      │      (S20)         │───Escape───▸│
               │ │hover.cancelled│ │      └─────────┬──────────┘             │
               │ │    (S05)     │─┘               │                         │
               │ └──────┬───────┘                 │ Enter on code           │
               │        │                         │                         │
               │        │ (immediate)             ▼                         │
               │        └────────▸ idle     ┌──────────────┐                │
               │                            │popover.pinned│                │
               │                            │    (S13)     │                │
               ▼                            └──────────────┘                │
       ┌────────────────┐                          ▲                        │
       │   popover.     │                          │                        │
       │  positioning   │                    click on span                  │
       │     (S06)      │                          │                        │
       └───────┬────────┘               ┌──────────┴───┐                    │
               │                        │              │                    │
               │ position               │              │                    │
               │ calculated             │              │                    │
               ▼                        │              │                    │
       ┌────────────────┐               │              │                    │
       │   popover.     │               │              │                    │
       │   opening      │               │              │                    │
       │     (S07)      │               │              │                    │
       └───────┬────────┘               │              │                    │
               │                        │              │                    │
               │ animation              │              │                    │
               │ complete               │              │                    │
               ▼                        │              │                    │
       ┌─────────────────────────────────┴──────┐      │                    │
       │           POPOVER OPEN                 │      │                    │
       │  ┌────────────┬─────────┬───────────┐  │      │                    │
       │  │ open.known │open.    │open.      │  │      │                    │
       │  │   (S08)    │unknown  │degraded   │  │      │                    │
       │  │            │ (S09)   │  (S10)    │  │      │                    │
       │  └────────────┴─────────┴───────────┘  │      │                    │
       └──────┬──────────────┬──────────────────┘      │                    │
              │              │                          │                    │
              │         click on span                   │                    │
              │         (while hover open)──────────────┘                    │
              │                                                             │
              │   mouseleave                                                │
              │   from span                                                 │
              ▼                                                             │
       ┌────────────────┐     mouseenter card    ┌─────────────────┐        │
       │  grace-period  │───────────────────────▸│  hovering-card  │        │
       │     (S12)      │                        │     (S11)       │        │
       └───────┬────────┘                        └────────┬────────┘        │
               │                                          │                 │
               │ 150ms elapsed                  mouseleave card             │
               │ (no re-enter)                            │                 │
               │                                          ▼                 │
               │                                   ┌──────────────┐         │
               │                                   │ grace-period │         │
               │                                   │    (S12)     │         │
               │                                   └──────┬───────┘         │
               │                                          │                 │
               ▼                                          ▼                 │
       ┌────────────────┐                          ┌──────────────┐         │
       │   popover.     │                          │   popover.   │         │
       │   closing      │◂─ Escape ───────────────│   closing    │         │
       │     (S18)      │◂─ click outside ────────│    (S18)     │         │
       └───────┬────────┘◂─ action executed ──────└──────────────┘         │
               │                                                            │
               │ animation complete (100ms)                                 │
               └────────────────────────────────────────────────────────────┘

  ╔═══════════════════════════════════════════════════════════════════════════╗
  ║  SCROLL INTERACTIONS (overlay on open/pinned states)                     ║
  ╠═══════════════════════════════════════════════════════════════════════════╣
  ║                                                                         ║
  ║  scroll + hover-mode card open:                                         ║
  ║    ┌────────────────────┐                                               ║
  ║    │ scroll.dismissing  │ → immediate dismiss → closing (S18) → idle    ║
  ║    │       (S21)        │                                               ║
  ║    └────────────────────┘                                               ║
  ║                                                                         ║
  ║  scroll + pinned card open:                                             ║
  ║    ┌──────────────────────┐                                             ║
  ║    │ scroll.repositioning │ → check anchor.isConnected                  ║
  ║    │       (S22)          │   → yes: reposition card                    ║
  ║    └──────────────────────┘   → no:  dismiss → closing (S18) → idle    ║
  ║                                                                         ║
  ╚═══════════════════════════════════════════════════════════════════════════╝

  ╔═══════════════════════════════════════════════════════════════════════════╗
  ║  ACTION STATES (transient, from pinned or hover-open)                   ║
  ╠═══════════════════════════════════════════════════════════════════════════╣
  ║                                                                         ║
  ║  ┌──────────────────┐  sets search input, dispatches input event        ║
  ║  │  action.filter   │──▸ closing (S18) → idle                          ║
  ║  │     (S15)        │                                                   ║
  ║  └──────────────────┘                                                   ║
  ║                                                                         ║
  ║  ┌──────────────────┐  clipboard.writeText (async) or textarea fallback ║
  ║  │  action.copy     │──▸ closing (S18) → idle                          ║
  ║  │     (S16)        │                                                   ║
  ║  └──────────────────┘                                                   ║
  ║                                                                         ║
  ║  ┌──────────────────┐  finds most recent entry, opens detail panel      ║
  ║  │  action.detail   │──▸ closing (S18) → idle                          ║
  ║  │     (S17)        │                                                   ║
  ║  └──────────────────┘                                                   ║
  ╚═══════════════════════════════════════════════════════════════════════════╝
```

### Key Transition Rules

- `decoder.idle` is the default resting state — no popover visible, no timers active.
- `decoder.disabled` is terminal until page reload — entered when `ErrorDecoder` constructor fails or `window.ERROR_CODES_DB` is critically malformed.
- `decoder.disconnected` is an overlay on any state — the popover still functions with cached data but live occurrence data may be stale.
- Only one popover card exists at any time. Opening a new card always closes the previous one via `decoder.popover.closing` first.
- Hover-mode cards (entered via `hover.detecting`) are ephemeral — dismissed by mouseleave, scroll, or Escape.
- Pinned cards (entered via click or keyboard Enter) require explicit dismiss.
- Action states (S15–S17) are transient — they execute the action then immediately transition through `closing` to `idle`.
- Scroll behavior differs: hover cards are dismissed immediately (S21), pinned cards are repositioned if anchor is still connected (S22) or dismissed if recycled.

---

## 3. State Matrix Table

### S01: `decoder.idle`

No error code interaction. Popover card is not visible. Default resting state.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) Page load after `ErrorDecoder` construction completes successfully. (2) Card dismiss animation completes (from `decoder.popover.closing`). (3) Hover cancelled before debounce (from `decoder.hover.cancelled`). (4) Keyboard navigation ended via Escape (from `decoder.keyboard.navigating`). |
| **Exit conditions** | (1) Mouse enters a `.error-code-known` or `.error-code-unknown` span → `decoder.hover.detecting`. (2) User clicks an error code span → `decoder.popover.positioning` (skip debounce, go direct to pinned flow). (3) User presses Ctrl+E → `decoder.keyboard.scanning`. |
| **Visual description** | No popover card in DOM. Decorated error codes visible in log rows: known codes have solid `var(--accent)` underline with `cursor: pointer`; unknown codes have dashed `var(--level-error)` underline with `cursor: help`. No focus indicators on error code spans. `_activeCard = null`, `_activeCode = null`, `_pinned = false`. |
| **Keyboard shortcuts** | `Ctrl+E` — begin keyboard scanning for error codes. No other decoder-specific shortcuts active. |
| **Data requirements** | `ErrorDecoder` instance initialized. `_db` loaded (may be empty for degraded mode). `_occurrences` Map maintained by log ingestion hook. `_matchCache` available for decoration. |
| **Transitions** | `→ decoder.hover.detecting` (mouseenter on code span). `→ decoder.popover.positioning` (click on code span). `→ decoder.keyboard.scanning` (Ctrl+E). `→ decoder.disabled` (if destroy() called). |
| **Error recovery** | No error possible in idle state. If `ErrorDecoder` instance becomes corrupted, `destroy()` + re-construct. |

---

### S02: `decoder.disabled`

ErrorDecoder failed to initialize. All interactions are no-ops.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) `ErrorDecoder` constructor threw an error (e.g., `renderer.escapeHtml` not available). (2) `destroy()` was called explicitly. (3) Critical runtime error during any state — global error handler transitions here. |
| **Exit conditions** | None during current page session. Requires page reload to re-initialize. |
| **Visual description** | Error code spans in log rows are **not** decorated — no underline, no `data-code` attribute. Raw error code text appears as plain monospace text indistinguishable from surrounding message. No popover card in DOM. No event delegation listeners registered. Console contains `console.error('ErrorDecoder: initialization failed — ...')`. |
| **Keyboard shortcuts** | None. Ctrl+E has no effect. |
| **Data requirements** | None — all data structures are null/undefined. `_db = null`, `_codeSet = null`, `_occurrences = null`. |
| **Transitions** | None (terminal state). Page reload → `decoder.idle` (if init succeeds) or `decoder.disabled` (if init fails again). |
| **Error recovery** | Log the initialization error to console with full stack trace. Do not throw — degrade gracefully. Other F12 features (C03 highlight engine, C05 stream controller) continue functioning without ErrorDecoder. |

---

### S03: `decoder.disconnected`

FLT (Fabric Live Table) is not connected. ErrorDecoder operates with cached/stale data.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) SignalR connection drops. (2) Page loaded in disconnected mode (no active FLT session). (3) Connection timeout after 30 seconds of no heartbeat. |
| **Exit conditions** | (1) SignalR reconnects successfully → return to previous state. (2) Page navigates away. |
| **Visual description** | Overlay state — coexists with any primary state (idle, hover, open, pinned). Error code decoration still functions using the embedded `window.ERROR_CODES_DB` (static data from build). Occurrence counts are frozen at last known values. If a popover card is open, a small `(offline)` badge appears in `var(--text-dim)` italic next to the occurrence count. New log entries are not arriving, so no new occurrences are tracked. The global disconnected banner (from main.js) is visible; ErrorDecoder does not add its own disconnected indicator. |
| **Keyboard shortcuts** | All shortcuts remain functional — Ctrl+E, Escape, Tab within pinned card. |
| **Data requirements** | `_db` from `window.ERROR_CODES_DB` remains valid (embedded at build time). `_occurrences` frozen — no new `recordOccurrence()` calls because no new logs arrive. `_matchCache` remains valid — stale but correct for existing rows. |
| **Transitions** | `→ (previous state)` when connection restores. All normal transitions remain available (hover, click, dismiss). `→ decoder.disabled` only if ErrorDecoder itself errors during disconnected operation. |
| **Error recovery** | If reconnection triggers a full log buffer refresh, call `invalidateCache()` and rebuild occurrence counts from the new buffer contents. If partial reconnect, resume occurrence tracking from the reconnection point. |

---

### S04: `decoder.hover.detecting`

Mouse entered a decorated error code span. Debounce timer is running.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | `mouseenter` event fires on a `<span>` with class `error-code-known` or `error-code-unknown` and a valid `data-code` attribute. A pinned card is NOT currently open (`this._pinned === false`). |
| **Exit conditions** | (1) 300ms debounce timer fires → `decoder.popover.positioning`. (2) Mouse leaves the span before 300ms → `decoder.hover.cancelled`. (3) User clicks the span during debounce → `decoder.popover.positioning` (immediate, bypass debounce, set pinned=true). |
| **Visual description** | The hovered code span receives `:hover` styles — known codes get `background: var(--accent-dim)` highlight. Unknown codes remain visually unchanged (dashed underline, no hover background). No popover card yet. The cursor is `pointer` (known) or `help` (unknown). `_hoverTimer` is a valid timeout ID. The span element reference is held for positioning. |
| **Keyboard shortcuts** | None during hover detection. If user presses Ctrl+E during hover, it triggers keyboard scanning — the hover timer is cleared and transition goes to `decoder.keyboard.scanning`. |
| **Data requirements** | `spanEl` reference to the hovered element. `spanEl.dataset.code` must be a valid code string. `_hoverDelay = 300` (configurable). `_hoverTimer` set via `setTimeout`. |
| **Transitions** | `→ decoder.popover.positioning` (300ms timer fires). `→ decoder.hover.cancelled` (mouseleave before 300ms). `→ decoder.popover.positioning` (click, with pinned=true). `→ decoder.keyboard.scanning` (Ctrl+E pressed). |
| **Error recovery** | If `spanEl` becomes disconnected from DOM during the 300ms wait (virtual scroll recycled the row), the timer callback checks `spanEl.isConnected` and aborts → `decoder.idle`. Timer is always cleared in `dismissCard()` as a safety net. |

---

### S05: `decoder.hover.cancelled`

Mouse left the error code span before the 300ms debounce elapsed.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | `mouseleave` event fires on the code span while `_hoverTimer` is still pending (< 300ms since mouseenter). |
| **Exit conditions** | Immediate — this is a transient state. Transitions to `decoder.idle` synchronously after clearing the timer. |
| **Visual description** | No visual change from idle. The `:hover` style on the span is removed by the browser. No popover card. `_hoverTimer` is cleared via `clearTimeout()`. |
| **Keyboard shortcuts** | None (transient). |
| **Data requirements** | `_hoverTimer` must be a valid timeout ID to clear. After clearing, set `_hoverTimer = null`. |
| **Transitions** | `→ decoder.idle` (immediate). |
| **Error recovery** | If `clearTimeout` is called with a null/undefined ID, it no-ops safely. No error possible. |

---

### S06: `decoder.popover.positioning`

Debounce elapsed (or click occurred). Calculating optimal card position.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) 300ms hover debounce timer fires and `spanEl.isConnected === true`. (2) User clicks a code span directly (bypass debounce). In both cases, any existing card is dismissed first via `dismissCard()`. |
| **Exit conditions** | Position calculation completes (synchronous, <1ms) → `decoder.popover.opening`. |
| **Visual description** | No visible change yet — this state is synchronous and sub-millisecond. Internally: `_positionCard()` reads `anchorRect = anchor.getBoundingClientRect()` and `containerRect = container.getBoundingClientRect()`. Computes vertical placement (prefer below; fallback above if `spaceBelow < cardHeight + 8`). Computes horizontal placement (align left with anchor, clamp to `containerWidth - 360 - 8`). Sets `position: absolute`, `top`, `left` on the card element. Adds `error-card--below` or `error-card--above` class for directional styling. For viewports < 480px, card switches to `width: calc(100% - 16px)` centered. For viewports 480–768px, card width is 300px. |
| **Keyboard shortcuts** | None (transient sub-millisecond state). |
| **Data requirements** | `anchorEl` — the span element that triggered the popover. `scrollContainer` — the `.log-scroll` element from `renderer.scrollContainer`. `containerRect` bounds for clamping. Viewport width for responsive breakpoint check. |
| **Transitions** | `→ decoder.popover.opening` (position calculated, card DOM created and appended). |
| **Error recovery** | If `anchorEl.getBoundingClientRect()` throws (element detached), catch and abort → `decoder.idle`. If `scrollContainer` is null (DOM corruption), log warning and abort → `decoder.idle`. |

---

### S07: `decoder.popover.opening`

Card DOM created and appended. Fade-in animation running.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Card element created via `document.createElement('div')`, class `error-card` applied, innerHTML set via `_buildCardHTML()`, positioned via `_positionCard()`, appended to `scrollContainer`. |
| **Exit conditions** | 100ms opacity transition completes → `decoder.popover.open.known`, `decoder.popover.open.unknown`, or `decoder.popover.open.degraded` (depending on code classification). |
| **Visual description** | Card element is in the DOM at its computed position. `opacity: 0` transitioning to `opacity: 1` over 100ms with `ease-out`. Card has `role="dialog"`, `aria-label="Error details: [CODE]"`, `tabindex="-1"`. Content is fully rendered inside the card but may not be readable during the fade. The directional class (`error-card--below` or `error-card--above`) is set. Card has `z-index: 100`. Box shadow: `0 4px 24px rgba(0,0,0,0.12)`. Border: `1px solid var(--border)`. Border radius: `var(--radius-lg)`. |
| **Keyboard shortcuts** | Escape → cancel opening, immediate dismiss → `decoder.idle`. |
| **Data requirements** | `code` string from `spanEl.dataset.code`. `info = getErrorInfo(code)` — full ErrorInfo for known codes, partial for unknown, null for no-match. `count = getOccurrenceCount(code)`. `pinned` boolean from trigger type (hover=false, click=true). |
| **Transitions** | `→ decoder.popover.open.known` (animation complete, `info.isKnown === true`). `→ decoder.popover.open.unknown` (animation complete, `info.isKnown === false`). `→ decoder.popover.open.degraded` (animation complete, `_db` is empty). `→ decoder.idle` (Escape pressed during animation). |
| **Error recovery** | If `_buildCardHTML()` throws (unexpected data shape), catch error, log to console, and fall back to a minimal card showing just the code string and "Error loading details" message. Card still opens — never silently fail on a user-triggered action. |

---

### S08: `decoder.popover.open.known`

Popover fully visible for a known error code (exists in `_codeSet`).

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Opening animation completes. `getErrorInfo(code)` returned an object with `isKnown === true`. |
| **Exit conditions** | (1) Mouseleave from both span and card (hover mode) → `decoder.popover.grace-period`. (2) Click on span (hover mode) → `decoder.popover.pinned`. (3) Escape key → `decoder.popover.closing`. (4) Click outside card (pinned mode) → `decoder.popover.closing`. (5) Action button clicked → `decoder.popover.action.*`. (6) Close button (✕) clicked → `decoder.popover.closing`. (7) Scroll (hover mode) → `decoder.scroll.dismissing`. (8) Scroll (pinned mode) → `decoder.scroll.repositioning`. (9) New hover/click on different code → `decoder.popover.closing` then re-open for new code. |
| **Visual description** | Full card visible at 360px width (300px on tablets, full-width on mobile). **Header:** error code in `var(--font-mono)` `var(--text-xs)` `font-weight: 600` `color: var(--level-error)`, category badge (`◆ USER ERROR` in `var(--level-warning-tint)` background or `◆ SYSTEM ERROR` in `var(--level-error-tint)` background), close button (✕) at top-right. **Body:** title in `var(--text-md)` `font-weight: 600`, description in `var(--text-muted)` with `line-height: 1.5`, suggested fix in `var(--accent-dim)` background box, occurrence count in `var(--font-mono)` ("N occurrences in buffer"), retryable badge if applicable (`Retryable` in green), node list ("Occurred in: node1, node2"), runbook link if present ("View runbook →"). **Footer:** three action buttons — "Filter to all [CODE]", "Copy error details", "View in detail panel" — styled as `1px solid var(--border)` bordered buttons with hover state `background: var(--surface-2)`. Body scrolls if content exceeds `max-height: 240px`. |
| **Keyboard shortcuts** | `Escape` — dismiss card. `Tab` / `Shift+Tab` — cycle through action buttons (only when pinned/focused). `Enter` on focused button — execute action. |
| **Data requirements** | `info: ErrorInfo` with all fields populated: `code`, `title`, `description`, `category`, `severity`, `suggestedFix`, `retryable`, `runbookUrl`, `relatedCodes`, `isKnown`. `count: number` from `getOccurrenceCount()`. `occData.nodes: Set<string>` for node list. `_pinned: boolean` tracking open mode. `_activeCard: HTMLElement` reference. `_activeCode: string`. |
| **Transitions** | `→ decoder.popover.grace-period` (mouseleave, hover mode). `→ decoder.popover.pinned` (click on same code span). `→ decoder.popover.closing` (Escape, click outside, close button, new code interaction). `→ decoder.popover.action.filter` (Filter button). `→ decoder.popover.action.copy` (Copy button). `→ decoder.popover.action.detail` (Detail button). `→ decoder.scroll.dismissing` (scroll, hover mode). `→ decoder.scroll.repositioning` (scroll, pinned mode). |
| **Error recovery** | If `info` fields are unexpectedly null/undefined (malformed DB entry), substitute safe defaults: title → `code` string, description → "No description available", suggestedFix → "No fix suggestion available". Never show `undefined` in the card. |

---

### S09: `decoder.popover.open.unknown`

Popover for a pattern-matched code not in the error-codes database.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Opening animation completes. `getErrorInfo(code)` returned an object with `isKnown === false` (code matched regex but not in `_codeSet`). |
| **Exit conditions** | Same as S08 — all dismiss triggers apply identically. |
| **Visual description** | Reduced card layout. **Header:** error code in monospace with close button. No category badge. **Body:** italic message "Pattern-matched error code not found in the error registry." in `var(--text-dim)`. Occurrence count ("N occurrences in buffer") in monospace. No title, no description, no suggested fix, no node list, no runbook link. **Footer:** two action buttons only — "Filter to all [CODE]" and "Copy error details". No "View in detail panel" button (reduced utility for unknown codes). Card width same as known variant. |
| **Keyboard shortcuts** | Same as S08. |
| **Data requirements** | `code: string`. `count: number` from occurrence tracking. `info` is null or has `isKnown === false`. Only 2 action buttons rendered. |
| **Transitions** | Same transition set as S08. |
| **Error recovery** | No DB data to be malformed — the reduced card is self-contained. If `code` string itself is somehow empty, show "Unknown error code" as placeholder. |

---

### S10: `decoder.popover.open.degraded`

Popover visible but error-codes DB was not loaded. Minimal information available.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Opening animation completes. `_db` is empty (`Object.keys(this._db).length === 0`) — `window.ERROR_CODES_DB` was undefined, null, or empty at init time. |
| **Exit conditions** | Same dismiss triggers as S08/S09. |
| **Visual description** | Minimal card. **Header:** error code string in monospace, close button. **Body:** message "No error database loaded. Error code details are unavailable." in `var(--text-dim)`. Occurrence count still shown (tracking works without DB). **Footer:** "Filter to all [CODE]" and "Copy error details" buttons only. A subtle info line at the bottom: "Rebuild with error-codes.json to enable full details" in `var(--text-xs)` `var(--text-dim)`. |
| **Keyboard shortcuts** | Same as S08. |
| **Data requirements** | `code: string`. `count: number`. `_db = {}` (empty). |
| **Transitions** | Same as S08/S09. |
| **Error recovery** | This state IS the error recovery for missing DB. No further degradation possible short of `decoder.disabled`. |

---

### S11: `decoder.popover.hovering-card`

Mouse moved from the anchor span onto the popover card itself.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | `mouseenter` event fires on the `.error-card` element while a hover-mode (unpinned) card is open. Any active grace-period timer (S12) is cancelled. |
| **Exit conditions** | (1) `mouseleave` fires on the card → `decoder.popover.grace-period`. (2) User clicks inside the card on an action button → `decoder.popover.action.*`. (3) User clicks the close button → `decoder.popover.closing`. (4) Escape → `decoder.popover.closing`. |
| **Visual description** | Identical to S08/S09/S10 — the card is fully visible and interactive. Mouse cursor is over the card body. The user can read content, scroll within the card body (if overflow), and interact with buttons. No visual difference from the parent open state. |
| **Keyboard shortcuts** | `Escape` — dismiss. Other keyboard shortcuts not typically applicable (user is using mouse). |
| **Data requirements** | `_activeCard` reference. Grace period timer ID to clear on entry. |
| **Transitions** | `→ decoder.popover.grace-period` (mouseleave from card). `→ decoder.popover.action.*` (action button click). `→ decoder.popover.closing` (close button or Escape). |
| **Error recovery** | If `mouseenter` fires but `_activeCard` is null (race condition), ignore the event. |

---

### S12: `decoder.popover.grace-period`

Mouse left both the anchor span and the card. 150ms timer before dismiss.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | `mouseleave` fires on the card element (from S11) or `mouseleave` fires on the anchor span (from S08/S09/S10), and the card is in hover mode (`_pinned === false`). |
| **Exit conditions** | (1) 150ms timer fires without re-entry → `decoder.popover.closing`. (2) Mouse re-enters the card → `decoder.popover.hovering-card` (timer cancelled). (3) Mouse re-enters the anchor span → cancel timer, stay in open state. (4) Escape → `decoder.popover.closing` (timer cancelled). |
| **Visual description** | Card remains fully visible during the 150ms grace period. No visual indicator of the pending dismiss — the grace period is invisible to the user. This prevents flicker when the mouse briefly crosses the gap between the anchor span and the card. |
| **Keyboard shortcuts** | `Escape` — immediate dismiss (cancel grace timer). |
| **Data requirements** | Grace period timer ID (separate from `_hoverTimer`). The 150ms delay is hard-coded — not configurable. |
| **Transitions** | `→ decoder.popover.closing` (150ms elapsed). `→ decoder.popover.hovering-card` (mouseenter on card). `→ decoder.popover.open.*` (mouseenter on anchor span). `→ decoder.popover.closing` (Escape). |
| **Error recovery** | Timer is always cleared on any state exit via `dismissCard()`. Double-clear is safe (`clearTimeout` with invalid ID is a no-op). |

---

### S13: `decoder.popover.pinned`

User clicked the error code span. Card is locked open until explicit dismiss.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) User clicks a `.error-code-known` or `.error-code-unknown` span. (2) User clicks on the anchor span while a hover-mode card is already showing the same code (upgrade from hover to pinned). (3) Keyboard: user presses Enter on a focused error code during keyboard navigation (S20). |
| **Exit conditions** | (1) Escape key → `decoder.popover.closing`. (2) Click outside the card (anywhere in document) → `decoder.popover.closing`. (3) Close button (✕) clicked → `decoder.popover.closing`. (4) Action button clicked → `decoder.popover.action.*`. (5) Click on a different error code span → close current, open new card (transition through `closing` to new `positioning`). (6) Scroll causes anchor to be recycled → `decoder.scroll.repositioning` → possible dismiss. |
| **Visual description** | Card appears identical to hover-mode open states (S08/S09/S10) but with two behavioral differences: (1) `_pinned = true` — mouseleave does NOT trigger grace period or dismiss. (2) Focus moves to the card element (`card.focus()` via `requestAnimationFrame`). The card has `outline: none` (focus visible via card border, not browser default). `_previousFocus` saves `document.activeElement` before focus moves, for restoration on dismiss. |
| **Keyboard shortcuts** | `Escape` — dismiss card, restore focus to `_previousFocus`. `Tab` — cycle forward through focusable elements within card (close button, action buttons, runbook link). `Shift+Tab` — cycle backward. Focus is trapped within the card — Tab from last element wraps to first, Shift+Tab from first wraps to last. `Enter` on focused button — execute action. |
| **Data requirements** | `_pinned = true`. `_previousFocus` stores the element that had focus before the card opened. `_activeCard`, `_activeCode` set. All card content data same as S08/S09/S10. |
| **Transitions** | `→ decoder.popover.closing` (Escape, click outside, close button, different code click). `→ decoder.popover.action.*` (action button click). `→ decoder.popover.pinned.focused` (Tab key moves focus within card). `→ decoder.scroll.repositioning` (scroll event on container). |
| **Error recovery** | If `_previousFocus` was recycled by virtual scroll, `isConnected` check fails and focus falls to `document.body` on dismiss. If click-outside handler fires during card internal click (race), `_activeCard.contains(e.target)` check prevents erroneous dismiss. |

---

### S14: `decoder.popover.pinned.focused`

Pinned card has focus. User is navigating within the card via keyboard.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | User presses Tab while the pinned card has focus. Focus moves to the first focusable element (close button or first action button). |
| **Exit conditions** | (1) Escape → `decoder.popover.closing`. (2) Enter on an action button → `decoder.popover.action.*`. (3) Click outside → `decoder.popover.closing`. (4) Mouse interaction takes over → `decoder.popover.pinned` (focus state ends but card stays pinned). |
| **Visual description** | The currently focused button within the card shows `outline: 2px solid var(--accent)` with `outline-offset: 1px` (from `.error-card-action:focus-visible`). Focus moves between: close button (✕), "Filter to all [CODE]", "Copy error details", "View in detail panel" (if present), and runbook link (if present). Focus order follows DOM order (top-to-bottom, left-to-right). |
| **Keyboard shortcuts** | `Tab` — next focusable element. `Shift+Tab` — previous. `Enter` — activate focused button. `Escape` — dismiss card. `Space` — activate focused button (standard button behavior). |
| **Data requirements** | `_activeCard` reference for `querySelectorAll('button, a[href], [tabindex]')` to enumerate focusable elements. Focus trap logic needs first and last element references. |
| **Transitions** | `→ decoder.popover.action.*` (Enter/Space on action button). `→ decoder.popover.closing` (Escape, click outside). `→ decoder.popover.pinned` (mouse click inside card but not on button). |
| **Error recovery** | If card has zero focusable elements (malformed HTML), Tab is a no-op. Focus trap wraps safely because `first` and `last` would be undefined — the `if` guards in `_onCardKeydown` prevent errors. |

---

### S15: `decoder.popover.action.filter`

User clicked "Filter to all [CODE]". Search is being set.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Click on action button with `data-action="filter"`. `_filterToCode(code)` is called. |
| **Exit conditions** | Filter applied → `decoder.popover.closing` → `decoder.idle`. |
| **Visual description** | Transient state (<1ms). The search input (`#search-input`) value is set to the error code string. An `input` event is dispatched on the search input (bubbles), which triggers `FilterManager.setSearch()` → filter index rebuild → re-render showing only log entries containing this code. The card dismisses immediately after setting the filter. The user sees the log view update with filtered results. |
| **Keyboard shortcuts** | None (transient). |
| **Data requirements** | `code` from `btn.dataset.code`. DOM access to `#search-input` element. |
| **Transitions** | `→ decoder.popover.closing` (immediate after filter set). |
| **Error recovery** | If `#search-input` is not found in DOM, no-op — log warning to console. Card still dismisses. Filter does not apply but no error thrown. |

---

### S16: `decoder.popover.action.copy`

User clicked "Copy error details". Clipboard write in progress.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Click on action button with `data-action="copy"`. `_copyErrorDetails(code)` is called. |
| **Exit conditions** | Clipboard write completes (success or failure) → `decoder.popover.closing` → `decoder.idle`. |
| **Visual description** | Transient state. `navigator.clipboard.writeText()` is called with a formatted plain-text block: `Error Code: [CODE]\nTitle: [title]\nDescription: [desc]\nClassification: [category]\nSuggested Fix: [fix]\nOccurrences: [count]`. Lines with empty values are omitted. Card dismisses after the async clipboard operation resolves. No visual feedback on the card during copy (too fast to see). |
| **Keyboard shortcuts** | None (transient). |
| **Data requirements** | `code` string. `info: ErrorInfo` for full details. `count: number`. |
| **Transitions** | `→ decoder.popover.closing` (after clipboard write resolves). |
| **Error recovery** | If `navigator.clipboard.writeText()` rejects (non-HTTPS, permission denied), fall back to textarea-based `document.execCommand('copy')`. If both fail, silently degrade — no error shown to user. A future enhancement may show a toast "Copy failed". Card still dismisses regardless of copy outcome. |

---

### S17: `decoder.popover.action.detail`

User clicked "View in detail panel". Detail panel opening.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Click on action button with `data-action="detail"`. `_openInDetailPanel(code)` is called. |
| **Exit conditions** | Detail panel opened (or no-op if entry not found) → `decoder.popover.closing` → `decoder.idle`. |
| **Visual description** | Transient state. The most recent log entry containing this code is located via `_occurrences.get(code).lastSeq` (fast path) or linear buffer scan (slow fallback). `window.edogViewer.showLogDetail(entry)` opens the detail panel. The detail panel slides in from the right with the full log entry, where error codes are also decorated via `decorateMessage()`. Card dismisses after detail panel opens. |
| **Keyboard shortcuts** | None (transient). |
| **Data requirements** | `code` string. `_occurrences.get(code).lastSeq` for fast lookup. `state.logBuffer.getBySeq(seq)` to retrieve the entry. `window.edogViewer.showLogDetail` function reference. |
| **Transitions** | `→ decoder.popover.closing` (after detail panel opens or no-op). |
| **Error recovery** | If `_occurrences.get(code)` is undefined (code has 0 occurrences — edge case), log warning. If `getBySeq()` returns null (entry evicted from ring buffer since card opened), show nothing — entry is gone. If `window.edogViewer` is undefined (not yet initialized), no-op. Card still dismisses in all cases. |

---

### S18: `decoder.popover.closing`

Card dismiss animation in progress.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | Any dismiss trigger: Escape, click outside, close button, action completion, scroll dismiss, mouseleave grace period expiry, new code interaction replacing current card. |
| **Exit conditions** | 100ms fade-out animation completes → `decoder.idle`. |
| **Visual description** | Card `opacity` transitions from `1` to `0` over 100ms with `ease-in`. After animation completes, the card DOM element is removed from the scroll container via `this._activeCard.remove()`. All internal state is reset: `_activeCard = null`, `_activeCode = null`, `_pinned = false`. If the card was pinned, focus is restored to `_previousFocus` (if `isConnected`), otherwise to `document.body`. The `_hoverTimer` is cleared as a safety measure. Card-level event listeners (`click`, `keydown`) are removed before DOM removal. |
| **Keyboard shortcuts** | None — card is fading out. Additional Escape presses are ignored (card is already closing). |
| **Data requirements** | `_activeCard` reference for animation and removal. `_previousFocus` for focus restoration (pinned mode only). |
| **Transitions** | `→ decoder.idle` (animation complete, DOM removed). |
| **Error recovery** | If the card element was already removed from DOM (parent container cleared, e.g., during full re-render), `_activeCard.remove()` is a no-op on a detached node. Check `_activeCard.isConnected` before animating — if already detached, skip animation and go directly to idle. |

---

### S19: `decoder.keyboard.scanning`

User pressed Ctrl+E. First error code in viewport is being located.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | User presses `Ctrl+E` while no popover is open (from `decoder.idle`). |
| **Exit conditions** | (1) Error code found in visible rows → `decoder.keyboard.navigating` (focus moves to the code span). (2) No error codes in visible rows → `decoder.idle` (no-op, optionally show brief toast "No error codes in view"). |
| **Visual description** | Transient scanning state (<1ms). The visible rows in the virtual scroll viewport are inspected for `.error-code-known` or `.error-code-unknown` spans. The first such span (topmost visible row, leftmost in message) receives a visual focus ring: `outline: 2px solid var(--accent)`, `outline-offset: 2px`, `border-radius: 2px`. The span also gets `tabindex="0"` temporarily to receive programmatic focus via `span.focus()`. |
| **Keyboard shortcuts** | `Ctrl+E` triggers this state. No other shortcuts during the scan (sub-millisecond). |
| **Data requirements** | Access to `renderer.scrollContainer` to find visible rows. Query selector `'.error-code-known, .error-code-unknown'` on each visible row's `._message` element. |
| **Transitions** | `→ decoder.keyboard.navigating` (code found and focused). `→ decoder.idle` (no codes found). |
| **Error recovery** | If no visible rows exist (empty log buffer), return to idle silently. If querySelector finds no spans, return to idle. |

---

### S20: `decoder.keyboard.navigating`

User is cycling through error codes via repeated Ctrl+E presses.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | First error code located and focused (from S19). User can now press Ctrl+E to advance to the next code. |
| **Exit conditions** | (1) `Escape` → remove focus ring, return to `decoder.idle`. (2) `Enter` on focused code → `decoder.popover.positioning` (open pinned card for this code). (3) No more codes in viewport (wrap to first) → cycle continues. (4) User clicks anywhere → `decoder.idle`. (5) Scroll moves focused code out of viewport → `decoder.idle`. |
| **Visual description** | One error code span in the viewport has a visible focus ring (`outline: 2px solid var(--accent)`, `outline-offset: 2px`). Each Ctrl+E press advances the focus ring to the next error code span in DOM order (top-to-bottom, left-to-right within each row). When reaching the last code in the viewport, Ctrl+E wraps to the first. The previously focused span has its temporary `tabindex` removed and focus ring cleared. |
| **Keyboard shortcuts** | `Ctrl+E` — advance to next error code. `Enter` — open pinned popover for focused code. `Escape` — exit navigation mode. `Tab` — exits keyboard navigation (browser default Tab behavior takes over), → `decoder.idle`. |
| **Data requirements** | List of all `.error-code-known` and `.error-code-unknown` spans in visible rows, maintained as an ordered array. Current index pointer into this array. When Ctrl+E is pressed, increment index (modulo array length). |
| **Transitions** | `→ decoder.idle` (Escape, click, scroll, Tab). `→ decoder.popover.positioning` (Enter — opens pinned card). |
| **Error recovery** | If the focused span is recycled by virtual scroll during navigation (row scrolled out of view), detect via `span.isConnected === false` and reset to idle. If the code span list changes (new render cycle), rebuild the list on next Ctrl+E press. |

---

### S21: `decoder.scroll.dismissing`

User scrolled while a hover-mode (unpinned) card was open.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | `scroll` event fires on `.log-scroll` container while `_activeCard !== null` and `_pinned === false`. |
| **Exit conditions** | Immediate transition to `decoder.popover.closing`. |
| **Visual description** | No visible intermediate state — scroll dismiss is instant. The card begins its 100ms fade-out animation (S18). The user sees the log rows scroll while the card simultaneously fades away. No debounce on scroll-dismiss for hover cards — the first scroll event triggers dismissal. |
| **Keyboard shortcuts** | None (transient). |
| **Data requirements** | `_activeCard` reference. `_pinned === false` check. |
| **Transitions** | `→ decoder.popover.closing` (immediate). |
| **Error recovery** | If `_activeCard` was already nulled by a concurrent dismiss (race between scroll and mouseleave), the scroll handler checks `!this._activeCard` and returns early. |

---

### S22: `decoder.scroll.repositioning`

User scrolled while a pinned card is open. Checking anchor validity.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | `scroll` event fires on `.log-scroll` container while `_activeCard !== null` and `_pinned === true`. |
| **Exit conditions** | (1) Anchor span is still connected → reposition card, return to `decoder.popover.pinned`. (2) Anchor span is disconnected (recycled by virtual scroll) → `decoder.popover.closing`. |
| **Visual description** | If the anchor is still in the DOM, `_positionCard()` is called again with the current anchor and container rects. The card smoothly repositions (CSS transition on `top`/`left` not applied — immediate reposition to avoid lag during scroll). If the anchor has been recycled, the card dismisses. During high-velocity scroll, this check fires on every scroll event — debounce is NOT applied because instant repositioning prevents the card from visually detaching from its anchor. |
| **Keyboard shortcuts** | None during repositioning (sub-millisecond check). |
| **Data requirements** | Reference to original anchor span element. `anchorEl.isConnected` check. `_positionCard()` for reposition. |
| **Transitions** | `→ decoder.popover.pinned` (anchor valid, card repositioned). `→ decoder.popover.closing` (anchor recycled). |
| **Error recovery** | If `_positionCard()` throws during reposition (e.g., container bounds changed dramatically due to layout shift), catch and dismiss the card → `decoder.popover.closing`. A dismissed card is always recoverable by clicking the code again. |

---

## 4. Compound States

States are classified into layers that can coexist:

- **Primary lifecycle** (mutually exclusive): `idle`, `disabled`, `hover.detecting`, `hover.cancelled`, `popover.positioning`, `popover.opening`, `popover.open.*`, `popover.hovering-card`, `popover.grace-period`, `popover.pinned`, `popover.pinned.focused`, `popover.closing`
- **Action layer** (transient, mutually exclusive): `action.filter`, `action.copy`, `action.detail`
- **Scroll layer** (transient, mutually exclusive): `scroll.dismissing`, `scroll.repositioning`
- **Keyboard layer**: `keyboard.scanning`, `keyboard.navigating` (mutually exclusive with popover states)
- **Connection overlay**: `disconnected` (coexists with any primary state)

### Compatibility Matrix

| Overlay | Can coexist with |
|---------|-----------------|
| `disconnected` (S03) | All primary states. Occurrence data frozen but card still functions. |
| `action.*` (S15-S17) | Only with `popover.open.*` or `popover.pinned` — actions trigger from open card, immediately transition to closing. |
| `scroll.*` (S21-S22) | Only with `popover.open.*` (S21 — hover dismiss) or `popover.pinned` (S22 — reposition). |

### Impossible Combinations

| State A | State B | Why |
|---------|---------|-----|
| `popover.open.*` | `keyboard.navigating` | Keyboard navigation exits when a popover opens (Enter triggers pinned open). |
| `hover.detecting` | `popover.pinned` | Hover detection is suppressed when a pinned card is open (`if (this._pinned) return`). |
| `popover.open.known` | `popover.open.unknown` | Only one card exists. Card type is determined at opening time. |
| `action.filter` | `action.copy` | Actions are mutually exclusive — each dismisses the card. |
| `disabled` | (any other) | Disabled is terminal — no transitions out. |

---

## 5. Cross-Cutting Concerns

### 5.1 Theme Change

When the user toggles between light and dark themes (via `variables.css` CSS custom property updates):

- **No state transition occurs.** The popover card uses CSS custom properties (`var(--surface)`, `var(--border)`, `var(--text)`, etc.) throughout — theme changes apply instantly via CSS variable inheritance.
- Card background, text colors, badge colors, button styles all update automatically.
- No JavaScript intervention needed. No card re-render.
- Error code span decoration (underline colors, hover backgrounds) also updates via CSS variables.

### 5.2 Virtual Scroll Row Recycling

The `RowPool` recycles DOM elements as the user scrolls. This affects the decoder in several ways:

- **Anchor invalidation:** A popover card's anchor span may be removed from the DOM when its parent row is recycled. All states that reference the anchor element check `anchorEl.isConnected` before using it.
- **Code span list staleness:** The `decoder.keyboard.navigating` state maintains a list of code spans. This list becomes stale after any scroll or re-render. The list is rebuilt on the next Ctrl+E press.
- **Hover detection on recycled rows:** When a row is recycled, `mouseleave` fires automatically (element removed from DOM), which properly triggers `decoder.hover.cancelled` or `decoder.popover.grace-period`.

### 5.3 Window Resize

- **Hover-mode card:** Dismissed immediately on `resize` event (same behavior as scroll).
- **Pinned card:** Repositioned via `_positionCard()` on `resize` event. If the new viewport is too narrow, card switches to responsive layout (full-width on <480px, 300px on <768px).
- **No state transition** for resize — it is handled within the current state's event listeners.

### 5.4 Container Resize (Sidebar Toggle)

When the sidebar or detail panel opens/closes, the `.log-scroll` container width changes:

- Handled identically to window resize — pinned cards are repositioned, hover cards are dismissed.
- A `ResizeObserver` on the scroll container is more reliable than `window.resize` for this case.

### 5.5 Multiple Error Codes in Same Log Row

A single log message may contain multiple error codes (e.g., `"MLV_FOO retry caused FLT_BAR"`):

- Each code gets its own `<span>` with its own `data-code` attribute.
- Hovering over one code opens its popover. Moving to a different code in the same row dismisses the first and starts a new 300ms debounce for the second.
- Clicking one code pins its card. Clicking a different code in the same row closes the first and opens the second.
- Keyboard navigation (Ctrl+E) visits each code span independently, left-to-right.

### 5.6 Rapid Hover Across Multiple Codes

When the user quickly moves the mouse across several code spans:

- Each `mouseenter` clears the previous `_hoverTimer` and starts a new 300ms timer.
- Only the code the mouse rests on for 300ms triggers a popover.
- If the mouse moves fast enough, no popover is ever shown — the user must pause on a code.
- This prevents popover flicker during fast scrolling or mouse sweeps.

### 5.7 Stream Mode Transitions (LIVE/PAUSED)

- **LIVE mode:** New log rows are being appended rapidly. The virtual scroll is auto-scrolling. Hover detection still works, but opening a popover while logs are streaming may result in the anchor row scrolling away quickly. The grace period / scroll dismiss handles this gracefully.
- **PAUSED mode:** No new rows appended. Stable scroll position. Popover cards are stable and don't need repositioning.
- **LIVE → PAUSED transition:** If a popover is open, it remains open. The card is not affected by stream mode changes.
- **PAUSED → LIVE transition:** If a pinned card is open, new rows pushing content may cause the anchor to scroll. The `scroll.repositioning` state handles this.

### 5.8 Reduced Motion (`prefers-reduced-motion: reduce`)

When the user has enabled reduced motion at the OS level:

- **Card open animation (S07):** The 100ms `opacity` fade-in is skipped — card appears instantly at `opacity: 1`. The `transition-duration` is set to `0s` via the reduced-motion media query.
- **Card close animation (S18):** The 100ms `opacity` fade-out is skipped — card is removed from DOM immediately. `dismissCard()` bypasses the `transitionend` wait and calls `_activeCard.remove()` synchronously.
- **Hover background on code spans (S04):** The `:hover` background change (`var(--accent-dim)`) still applies — it is a simple color change, not motion.
- **Focus ring on keyboard navigation (S19–S20):** Focus outline applies instantly — no animation to disable.
- **Attention/pulse animations:** None in ErrorDecoder — no impact.

**Implementation:** A single CSS rule covers all cases:
```css
@media (prefers-reduced-motion: reduce) {
  .error-card { transition-duration: 0s !important; }
}
```
The `dismissCard()` method checks `window.matchMedia('(prefers-reduced-motion: reduce)').matches` to skip the `transitionend` wait path.

**No state machine impact** — states S07 and S18 still exist, their durations just become 0ms.

### 5.9 Touch Devices

On touch devices (tablets, phones), there is no `mouseenter` event, so the hover-based popover flow (S04 → S06 → S07 → S08/S09/S10) is unreachable.

- **Primary interaction:** Tap on an error code span triggers the **click** flow → `decoder.popover.positioning` with `pinned = true`. On touch, every popover is a pinned popover.
- **Hover detection states (S04, S05, S11, S12) are unreachable** on pure touch devices. This is correct — they serve no purpose without a hovering pointer.
- **Grace period (S12) is irrelevant** — touch events don't have the "mouse crossing a gap" problem.
- **Keyboard navigation (S19, S20)** works on tablets with external keyboards. Ctrl+E scanning is functional.
- **Dismiss:** Tap outside the card dismisses it (same as click-outside on desktop). There is no close button size concern — the ✕ button meets the 44×44px minimum touch target (via padding, not icon size).
- **Scroll dismiss:** Scroll on touch dismisses hover-mode cards (S21). Since all touch cards are pinned, S22 (`scroll.repositioning`) applies — the card repositions or dismisses if the anchor is recycled.
- **Action buttons:** Touch targets in the card footer meet the 44px minimum height requirement via `padding: 10px 12px` on each button row.
- **No long-press behavior** — tap is the only interaction model.

**No state machine changes needed** — the existing states handle touch correctly because touch taps map to click events, which enter the pinned flow directly.

---

## 6. Transition Summary Table

| # | From | Trigger | To | Notes |
|---|------|---------|-----|-------|
| T01 | `idle` | mouseenter on code span | `hover.detecting` | Only if `_pinned === false` |
| T02 | `idle` | click on code span | `popover.positioning` | Sets `pinned = true` |
| T03 | `idle` | Ctrl+E | `keyboard.scanning` | Searches visible rows |
| T04 | `hover.detecting` | 300ms elapsed | `popover.positioning` | `spanEl.isConnected` verified |
| T05 | `hover.detecting` | mouseleave (< 300ms) | `hover.cancelled` | Timer cleared |
| T06 | `hover.detecting` | click on span | `popover.positioning` | Bypass debounce, `pinned = true` |
| T07 | `hover.cancelled` | (immediate) | `idle` | Synchronous reset |
| T08 | `popover.positioning` | position computed | `popover.opening` | Card DOM created, appended |
| T09 | `popover.opening` | 100ms fade-in complete | `popover.open.known` | `info.isKnown === true` |
| T10 | `popover.opening` | 100ms fade-in complete | `popover.open.unknown` | `info.isKnown === false` |
| T11 | `popover.opening` | 100ms fade-in complete | `popover.open.degraded` | `_db` is empty |
| T12 | `popover.opening` | Escape | `idle` | Cancel opening |
| T13 | `popover.open.*` | mouseleave (hover mode) | `popover.grace-period` | 150ms grace timer starts |
| T14 | `popover.open.*` | click on same code span | `popover.pinned` | Upgrade hover → pinned |
| T15 | `popover.open.*` | Escape | `popover.closing` | Dismiss |
| T16 | `popover.open.*` | scroll (hover mode) | `scroll.dismissing` | Immediate dismiss |
| T17 | `popover.open.*` | action button click | `popover.action.*` | Execute + dismiss |
| T18 | `popover.open.*` | close button (✕) | `popover.closing` | Dismiss |
| T19 | `popover.hovering-card` | mouseleave from card | `popover.grace-period` | 150ms grace timer |
| T20 | `popover.hovering-card` | Escape | `popover.closing` | Dismiss |
| T21 | `popover.grace-period` | 150ms elapsed | `popover.closing` | No re-entry occurred |
| T22 | `popover.grace-period` | mouseenter on card | `popover.hovering-card` | Timer cancelled |
| T23 | `popover.grace-period` | mouseenter on anchor | `popover.open.*` | Timer cancelled |
| T24 | `popover.grace-period` | Escape | `popover.closing` | Timer cancelled + dismiss |
| T25 | `popover.pinned` | Escape | `popover.closing` | Focus restored to `_previousFocus` |
| T26 | `popover.pinned` | click outside | `popover.closing` | Not inside card, not on code span |
| T27 | `popover.pinned` | close button (✕) | `popover.closing` | Dismiss |
| T28 | `popover.pinned` | action button click | `popover.action.*` | Execute + dismiss |
| T29 | `popover.pinned` | click different code span | `popover.closing` | Then re-open for new code |
| T30 | `popover.pinned` | scroll | `scroll.repositioning` | Check anchor validity |
| T31 | `popover.pinned` | Tab | `popover.pinned.focused` | Focus trap activated |
| T32 | `popover.pinned.focused` | Enter/Space on button | `popover.action.*` | Execute action |
| T33 | `popover.pinned.focused` | Escape | `popover.closing` | Dismiss + restore focus |
| T34 | `popover.action.*` | action completes | `popover.closing` | Card fading out |
| T35 | `popover.closing` | 100ms fade-out complete | `idle` | DOM removed, state reset |
| T36 | `keyboard.scanning` | code found | `keyboard.navigating` | Focus ring on first code |
| T37 | `keyboard.scanning` | no codes found | `idle` | No-op |
| T38 | `keyboard.navigating` | Ctrl+E | `keyboard.navigating` | Advance to next code (self-loop) |
| T39 | `keyboard.navigating` | Enter | `popover.positioning` | Open pinned card for focused code |
| T40 | `keyboard.navigating` | Escape | `idle` | Remove focus ring |
| T41 | `scroll.dismissing` | (immediate) | `popover.closing` | Hover card dismissed on scroll |
| T42 | `scroll.repositioning` | anchor connected | `popover.pinned` | Card repositioned |
| T43 | `scroll.repositioning` | anchor disconnected | `popover.closing` | Anchor recycled, dismiss |
| T44 | `disconnected` | connection restores | (previous state) | Resume normal operation |
| T45 | (any state) | destroy() | `disabled` | Terminal cleanup |
