# C05 — Log Stream Controller

> **Feature:** F12 Error Intelligence
> **Phase:** P2
> **Owner:** Pixel
> **Status:** SPEC
> **Modifies:** `src/frontend/js/renderer.js`, `src/frontend/js/main.js`, `src/frontend/js/state.js`, `src/frontend/css/logs.css`, `src/frontend/css/variables.css`

---

## 1. Purpose

Replace the current disconnected `autoScroll` / `paused` booleans with a unified stream state machine (`LIVE` / `PAUSED`) that gives the user clear visual feedback, a buffered-count badge, multiple pause/resume triggers (scroll-up, manual, hover-freeze, keyboard), and guarantees zero data loss during pause.

---

## 2. State Machine

### 2.1 States

| State | Description | Visual | autoScroll | DOM rendering |
|-------|-------------|--------|------------|---------------|
| **LIVE** | Viewport follows newest log entry | Pulsing green `● LIVE` | `true` | Active |
| **PAUSED** | Viewport frozen; new logs buffer silently | Amber `⏸ PAUSED · N new` | `false` | Suspended (filter index still updates) |

### 2.2 Transitions

```
                          ┌──────────────────────────────────────────────────────┐
                          │                                                      │
                          ▼                                                      │
                       ┌──────┐   scroll-up (reason='scroll')                    │
              ┌────────│ LIVE │───────────────────────────────┐                  │
              │        └──────┘   Space key (reason='manual')  │                  │
              │           │       hover-enter (reason='hover') │                  │
              │           │                                    ▼                  │
              │           │                              ┌──────────┐             │
              │           │                              │  PAUSED  │─────────────┘
              │           │                              └──────────┘
              │           │                                    │
              │           └────────────────────────────────────┘
              │             Resume triggers:
              │               • End key
              │               • Ctrl+↓
              │               • Badge click / "Resume" link
              │               • Space key (toggle)
              │               • Scroll FAB click
              │               • hover-leave (ONLY if pauseReason == 'hover')
```

### 2.3 Pause Reason Semantics

| `pauseReason` | Triggered by | hover-leave resumes? | Rationale |
|----------------|-------------|----------------------|-----------|
| `'scroll'` | User scrolled up from bottom | NO | User is inspecting old logs |
| `'manual'` | Space key toggle | NO | Explicit user intent |
| `'hover'` | Mouse entered log scroll area | YES | Temporary convenience freeze |

**Critical rule:** If `pauseReason` is `'scroll'` or `'manual'`, hover-leave MUST NOT auto-resume. The hover-freeze is a *lower-priority* pause; it yields to any explicit pause.

---

## 3. Scenarios

### 3.1 — State Properties (SC-01)

**ID:** SC-01
**Name:** Stream state initialization
**Priority:** P0 (blocks all others)

**Description:** Add unified stream state properties to `LogViewerState`, replacing the current separate `autoScroll` + `paused` booleans with a coherent state group.

**Source:** `src/frontend/js/state.js` lines 135–136

**Current code:**
```javascript
this.autoScroll = true;   // line 135
this.paused = false;      // line 136
```

**New state shape:**
```javascript
// Stream control (replaces autoScroll + paused)
this.streamMode = 'LIVE';      // 'LIVE' | 'PAUSED'
this.bufferedCount = 0;        // logs received while PAUSED
this.pauseReason = null;       // 'scroll' | 'manual' | 'hover' | null
this.hoverFreezeEnabled = true; // user-configurable toggle

// Backward-compat shims (read-only, keep existing code working)
Object.defineProperty(this, 'autoScroll', {
  get: () => this.streamMode === 'LIVE',
  set: (v) => {
    if (v) this.streamMode = 'LIVE';
    // false set handled by transition methods
  }
});
Object.defineProperty(this, 'paused', {
  get: () => this.streamMode === 'PAUSED',
  set: (v) => {
    if (v && this.streamMode === 'LIVE') this.streamMode = 'PAUSED';
    if (!v && this.streamMode === 'PAUSED') this.streamMode = 'LIVE';
  }
});
```

**Edge cases:**
- Old code that reads `state.autoScroll` or `state.paused` must continue to work via shims
- `bufferedCount` must only increment in `addLog()` when `streamMode === 'PAUSED'`
- `bufferedCount` resets to 0 on any PAUSED → LIVE transition

**Revert:** Remove new properties, restore original booleans.

---

### 3.2 — Buffered Count Tracking (SC-02)

**ID:** SC-02
**Name:** Increment buffered count on each new log while PAUSED
**Priority:** P0 (blocks badge display)

**Description:** Every log entry received while `streamMode === 'PAUSED'` increments `bufferedCount`. On resume, counter resets. This counter drives the `N new` badge text.

**Source:** `src/frontend/js/state.js` lines 203–212 (`addLog`)

**Mechanism:**
```javascript
addLog = (entry) => {
  this.logBuffer.push(entry);
  this.newLogsSinceRender++;

  // F12: track logs arriving while paused
  if (this.streamMode === 'PAUSED') {
    this.bufferedCount++;
  }

  this.stats.totalLogs++;
  const level = entry.level?.toLowerCase();
  if (level && this.stats[level] !== undefined) {
    this.stats[level]++;
  }
}
```

**Why `addLog` and not `flush`:** `addLog` is called once per log entry (or per item in `pushBatch`). `flush` resets `newLogsSinceRender` to 0 even while paused (state.js line 233), so it cannot serve as a reliable counter. `bufferedCount` is independent of the render cycle.

**Edge cases:**
- **Very long pause (100K+ buffered):** `bufferedCount` is a plain JS number; safe to ~9×10¹⁵. The *ring buffer* wraps at 10K entries so old data is lost, but `bufferedCount` still reflects total arrivals. Badge shows true count; resume scrolls to whatever the ring buffer still holds.
- **Ring buffer wrap during pause:** Oldest entries evicted. `bufferedCount` still accurate (it counts *arrivals*, not *retained*). On resume, FilterIndex rebuilds from ring buffer contents — some old entries may be gone. This is expected behavior; the ring buffer is the source of truth.
- **Batch ingestion:** `handleWebSocketBatch` calls `addLog` per item in a loop — each increments `bufferedCount` individually. No special batch handling needed.

**Revert:** Remove the `if (this.streamMode === 'PAUSED')` block from `addLog`.

---

### 3.3 — Scroll-Up Detection (LIVE → PAUSED) (SC-03)

**ID:** SC-03
**Name:** Detect user scroll-up to auto-pause
**Priority:** P0 (core UX)

**Description:** When the user scrolls away from the bottom while in LIVE mode, transition to PAUSED with `pauseReason = 'scroll'` and show the toolbar badge.

**Source:** `src/frontend/js/renderer.js` lines 184–203 (`_onScroll`)

**Current code:**
```javascript
_onScroll = () => {
  if (this.state.autoScroll && Date.now() > this._scrollPinUntil) {
    const c = this.scrollContainer;
    const isAtBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - this.ROW_HEIGHT * 2;
    if (!isAtBottom) {
      this.state.autoScroll = false;                            // line 190
      if (window.edogViewer) window.edogViewer.showResumeButton(); // line 191
    }
  }
  if (this.state.autoScroll) return;
  if (!this.renderScheduled) {
    this.renderScheduled = true;
    requestAnimationFrame(() => this.flush());
  }
}
```

**New code:**
```javascript
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
```

**Bottom-detection threshold:** `this.ROW_HEIGHT * 2` = 68px. This allows a ~2-row tolerance so tiny scroll jitter doesn't trigger a pause. This value is inherited from the current implementation and is proven stable.

**`_scrollPinUntil` guard:** After a programmatic `scrollTop` change (auto-scroll snap), the renderer sets `_scrollPinUntil = Date.now() + 80`. This 80ms debounce window prevents the programmatic scroll from triggering `_onScroll` → false pause detection.

**Edge cases:**
- **Rapid scroll up/down (jitter):** The 80ms `_scrollPinUntil` + 2-row threshold handles this. A user rapidly scrolling down and back up within 80ms of a programmatic scroll won't trigger pause.
- **Touchpad inertial scroll:** Passive scroll listener (`{ passive: true }`, line 147) means no jank. Inertial scroll that crosses the bottom threshold restores LIVE naturally via the isAtBottom check on subsequent events.
- **Container resize (dev tools open/close):** May briefly make `isAtBottom` false. Acceptable — user can resume with one click or keypress.

**Revert:** Restore original `_onScroll` body.

---

### 3.4 — Transition Functions (SC-04)

**ID:** SC-04
**Name:** Centralized LIVE/PAUSED transition methods
**Priority:** P0 (all triggers call these)

**Description:** Two transition functions on `Renderer` (or on a `StreamController` mixin) that encapsulate all side effects of state changes.

**Source:** `src/frontend/js/renderer.js` (new methods)

**Mechanism:**
```javascript
_transitionToPaused = (reason) => {
  if (this.state.streamMode === 'PAUSED') return; // idempotent
  this.state.streamMode = 'PAUSED';
  this.state.pauseReason = reason;
  this.state.bufferedCount = 0; // start fresh count from this moment
  this._updateStreamBadge();
  if (window.edogViewer) window.edogViewer.showResumeButton();
}

_transitionToLive = () => {
  if (this.state.streamMode === 'LIVE') return; // idempotent
  this.state.streamMode = 'LIVE';
  this.state.pauseReason = null;
  this.state.bufferedCount = 0;
  this._updateStreamBadge();
  if (window.edogViewer) window.edogViewer.hideResumeButton();
  // Scroll to bottom + rerender
  this._scrollPinUntil = Date.now() + 80;
  this.flush();
  this.scrollToBottom();
}
```

**`_transitionToPaused` resets `bufferedCount` to 0** because we want to count logs *since this pause*, not since some prior pause.

**`_transitionToLive` calls `flush()` then `scrollToBottom()`:** The flush re-enables DOM rendering (the guard in `flush` at line 227 will no longer early-return). `scrollToBottom` then snaps the viewport.

**Interactions:**
- `_transitionToLive` is called by: resume button, badge click, End key, Ctrl+↓, Space toggle, hover-leave (conditional), scroll FAB
- `_transitionToPaused` is called by: `_onScroll` (scroll-up), Space toggle, hover-enter (conditional)

**Revert:** Remove both methods; restore inline state mutations.

---

### 3.5 — Toolbar Stream Badge (SC-05)

**ID:** SC-05
**Name:** LIVE / PAUSED indicator in toolbar
**Priority:** P0 (primary visual feedback)

**Description:** Replace the current plain "Pause" button with a stream mode badge that shows the current state and acts as a clickable resume trigger when paused.

**Source:** `src/frontend/js/main.js` line 415 (`pauseBtn` listener), line 683 (`togglePause`), `src/frontend/css/logs.css` (new styles)

**HTML structure:**
```html
<!-- Replaces the existing #pause-btn -->
<span id="stream-badge" class="stream-badge" data-mode="live" role="status" aria-live="polite">
  <span class="stream-dot"></span>
  <span class="stream-label">LIVE</span>
  <span class="stream-count" hidden></span>
</span>
```

**LIVE state rendering:**
```
● LIVE
```
- `.stream-dot`: 8×8px circle, `background: var(--stream-live)` (#18a058), CSS animation `pulse` (opacity 1→0.4→1, 2s ease-in-out infinite)
- `.stream-label`: "LIVE", `color: var(--stream-live)`, `font-weight: 600`, `font-size: 11px`, `text-transform: uppercase`, `letter-spacing: 0.5px`
- `.stream-count`: `hidden`
- `cursor: default` (no click action in LIVE mode)

**PAUSED state rendering:**
```
⏸ PAUSED · 238 new
```
- `.stream-dot`: 8×8px circle, `background: var(--stream-paused)` (#e5940c), no animation (static)
- `.stream-label`: "PAUSED", `color: var(--stream-paused)`
- `.stream-count`: `" · N new"`, visible, `color: var(--stream-paused)`, `font-variant-numeric: tabular-nums` (prevents layout shift as count changes)
- `cursor: pointer` (clicking resumes)
- Entire badge gets `title="Click to resume (End)"` for discoverability

**`_updateStreamBadge` method:**
```javascript
_updateStreamBadge = () => {
  const badge = document.getElementById('stream-badge');
  if (!badge) return;
  const isLive = this.state.streamMode === 'LIVE';
  badge.dataset.mode = isLive ? 'live' : 'paused';
  badge.querySelector('.stream-label').textContent = isLive ? 'LIVE' : 'PAUSED';
  const countEl = badge.querySelector('.stream-count');
  if (isLive) {
    countEl.hidden = true;
  } else {
    countEl.hidden = false;
    countEl.textContent = ' \u00B7 ' + this.state.bufferedCount.toLocaleString() + ' new';
  }
  badge.title = isLive ? 'Auto-scrolling to latest' : 'Click to resume (End)';
}
```

**Badge counter live update:** During PAUSED, the counter in the badge must tick up as new logs arrive. This is done by calling `_updateStreamBadge()` from the flush path when paused:
```javascript
// In renderer.flush(), inside the paused early-return block:
if (this.state.streamMode === 'PAUSED') {
  // ... existing filter index + stats updates ...
  this._updateStreamBadge(); // update the "N new" counter
  this.renderScheduled = false;
  return;
}
```

**Badge click handler:**
```javascript
// In main.js setupEventListeners:
const streamBadge = document.getElementById('stream-badge');
if (streamBadge) {
  streamBadge.addEventListener('click', () => {
    if (this.state.streamMode === 'PAUSED') {
      this.renderer._transitionToLive();
    }
  });
}
```

**Edge cases:**
- **Counter overflow display:** `toLocaleString()` handles thousands separators. At 100K+ the badge reads `"PAUSED · 100,000 new"`. The badge has `white-space: nowrap` and `overflow: hidden; text-overflow: ellipsis` as a safety net but should never clip in practice.
- **Counter update frequency:** `flush` runs at most every `renderThrottleMs` (100ms). Badge updates at that cadence — smooth enough for visual counting, not wasteful.
- **Theme switch while paused:** CSS variables (`--stream-live`, `--stream-paused`) auto-update. No JS needed.

**Revert:** Remove `#stream-badge` element, restore `#pause-btn` button and `togglePause` text-swap logic.

---

### 3.6 — Badge Animation (SC-06)

**ID:** SC-06
**Name:** Visual transitions between LIVE and PAUSED
**Priority:** P1 (polish)

**Description:** Animate the badge state changes so the user notices the transition.

**Source:** `src/frontend/css/logs.css` (new rules)

**CSS:**
```css
/* Design tokens */
:root {
  --stream-live: #18a058;
  --stream-paused: #e5940c;
}
[data-theme="dark"] {
  --stream-live: #36d475;
  --stream-paused: #f5a623;
}

/* Badge base */
.stream-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  user-select: none;
  transition: background-color 0.2s ease, color 0.2s ease;
  white-space: nowrap;
}

/* LIVE state */
.stream-badge[data-mode="live"] {
  background: rgba(24, 160, 88, 0.08);
  color: var(--stream-live);
  cursor: default;
}

/* PAUSED state */
.stream-badge[data-mode="paused"] {
  background: rgba(229, 148, 12, 0.10);
  color: var(--stream-paused);
  cursor: pointer;
}
.stream-badge[data-mode="paused"]:hover {
  background: rgba(229, 148, 12, 0.18);
}

/* Dot */
.stream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.stream-badge[data-mode="live"] .stream-dot {
  background: var(--stream-live);
  animation: stream-pulse 2s ease-in-out infinite;
}
.stream-badge[data-mode="paused"] .stream-dot {
  background: var(--stream-paused);
  animation: none;
}

/* Counter */
.stream-count {
  font-variant-numeric: tabular-nums;
}

/* Pulse animation */
@keyframes stream-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* LIVE→PAUSED entrance: counter slides in */
.stream-count:not([hidden]) {
  animation: badge-count-in 0.2s ease-out;
}
@keyframes badge-count-in {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
```

**Counter increment animation:** Each time the count text changes, we do NOT re-trigger the entrance animation. Only the initial appearance animates. Subsequent count increments are instant text updates — animating every tick would be distracting and expensive.

**Reduced motion:** Add `@media (prefers-reduced-motion: reduce)` to disable the pulse:
```css
@media (prefers-reduced-motion: reduce) {
  .stream-badge[data-mode="live"] .stream-dot {
    animation: none;
    opacity: 0.7;
  }
  .stream-count:not([hidden]) {
    animation: none;
  }
}
```

**Revert:** Remove all `.stream-badge` / `.stream-dot` / `.stream-count` CSS rules.

---

### 3.7 — Manual Pause Toggle (SC-07)

**ID:** SC-07
**Name:** Space key toggles LIVE / PAUSED
**Priority:** P0 (existing behavior, enhanced)

**Description:** Replace `togglePause()` in `main.js` with a stream-state-aware version.

**Source:** `src/frontend/js/main.js` lines 681–694 (`togglePause`), line 486 (Space key handler)

**New `togglePause`:**
```javascript
togglePause = () => {
  if (this.state.streamMode === 'LIVE') {
    this.renderer._transitionToPaused('manual');
  } else {
    this.renderer._transitionToLive();
  }
}
```

**Keyboard handler (existing):**
```javascript
case 'Space':
  if (!this.detail.isVisible) {
    e.preventDefault();
    this.togglePause();
  }
  break;
```
No change needed to the Space handler — it already calls `togglePause`.

**Edge cases:**
- **Space while detail panel is open:** Already guarded (`!this.detail.isVisible`). No change.
- **Space in input field:** Already guarded (line 458 early return). No change.

**Revert:** Restore original `togglePause` body.

---

### 3.8 — Keyboard Resume Shortcuts (SC-08)

**ID:** SC-08
**Name:** End key and Ctrl+Down Arrow resume LIVE mode
**Priority:** P0 (accessibility + power user)

**Description:** Add two new keyboard shortcuts that resume live mode. `End` is the natural "go to end" key; `Ctrl+↓` mirrors terminal conventions.

**Source:** `src/frontend/js/main.js` lines 456–490 (`handleKeydown`)

**New cases in `handleKeydown`:**
```javascript
case 'End':
  if (this.state.streamMode === 'PAUSED') {
    e.preventDefault();
    this.renderer._transitionToLive();
  }
  break;

case 'ArrowDown':
  if (e.ctrlKey && this.state.streamMode === 'PAUSED') {
    e.preventDefault();
    this.renderer._transitionToLive();
  }
  break;
```

**Placement:** After the existing `Space` case, before the closing `}` of the switch.

**Edge cases:**
- **End key when already LIVE:** No-op (guard in `_transitionToLive`).
- **ArrowDown without Ctrl:** Must NOT trigger resume — only `Ctrl+ArrowDown`. The `e.ctrlKey` check handles this.
- **End key in input field:** Already guarded by line 458 early return for INPUT/SELECT/TEXTAREA.
- **macOS Cmd+↓:** Use `e.ctrlKey || e.metaKey` for cross-platform parity.

**Revert:** Remove the two new `case` blocks.

---

### 3.9 — Hover-Freeze (SC-09)

**ID:** SC-09
**Name:** Mouse hover over log area temporarily pauses stream
**Priority:** P1 (configurable, off by default for V1)

**Description:** When enabled, entering the mouse into the log scroll container pauses the stream so the user can read without logs jumping. Leaving the container auto-resumes — but only if the pause was caused by hover, not by scroll-up or manual pause.

**Source:** `src/frontend/js/renderer.js` (`initVirtualScroll` — add event listeners)

**Mechanism:**
```javascript
// In initVirtualScroll(), after scroll listener:
this.scrollContainer.addEventListener('mouseenter', this._onHoverEnter);
this.scrollContainer.addEventListener('mouseleave', this._onHoverLeave);

_onHoverEnter = () => {
  if (!this.state.hoverFreezeEnabled) return;
  if (this.state.streamMode !== 'LIVE') return; // already paused, don't override
  this._transitionToPaused('hover');
}

_onHoverLeave = () => {
  if (!this.state.hoverFreezeEnabled) return;
  if (this.state.pauseReason !== 'hover') return; // don't resume manual/scroll pause
  this._transitionToLive();
}
```

**Configurable toggle:** `state.hoverFreezeEnabled` defaults to `true`. A toggle in the logs toolbar or settings panel controls it. Stored in `localStorage('edog-hover-freeze')`.

```javascript
// In toolbar setup:
const hoverToggle = document.getElementById('hover-freeze-toggle');
if (hoverToggle) {
  hoverToggle.checked = this.state.hoverFreezeEnabled;
  hoverToggle.addEventListener('change', (e) => {
    this.state.hoverFreezeEnabled = e.target.checked;
    localStorage.setItem('edog-hover-freeze', e.target.checked);
  });
}
```

**Hover-freeze vs manual pause interaction (CRITICAL):**

| Current state | Event | Result |
|---------------|-------|--------|
| LIVE | mouseenter | → PAUSED (reason=hover) |
| PAUSED (hover) | mouseleave | → LIVE |
| PAUSED (hover) | Space key | pauseReason upgrades to 'manual'; mouseleave will NOT resume |
| PAUSED (scroll) | mouseenter | No change (already paused) |
| PAUSED (scroll) | mouseleave | No change (pauseReason != 'hover') |
| PAUSED (manual) | mouseenter | No change (already paused) |
| PAUSED (manual) | mouseleave | No change (pauseReason != 'hover') |
| LIVE (hover disabled) | mouseenter | No change |

**Pause reason upgrade:** If the user presses Space while in hover-pause, the `togglePause` sees `streamMode === 'PAUSED'` and would normally call `_transitionToLive`. But we want Space during hover-pause to "promote" to manual pause instead. Updated toggle:

```javascript
togglePause = () => {
  if (this.state.streamMode === 'LIVE') {
    this.renderer._transitionToPaused('manual');
  } else if (this.state.pauseReason === 'hover') {
    // Promote hover-pause to manual-pause (don't resume)
    this.state.pauseReason = 'manual';
  } else {
    this.renderer._transitionToLive();
  }
}
```

**Edge cases:**
- **Mouse enters, scrolls up, then leaves:** On scroll-up, `_onScroll` tries to pause but `streamMode` is already `PAUSED`. The `_transitionToPaused` is idempotent and returns early. But the `pauseReason` should be upgraded from `'hover'` to `'scroll'` so mouseleave won't resume. Updated `_onScroll`:
  ```javascript
  if (!isAtBottom) {
    if (this.state.streamMode === 'PAUSED' && this.state.pauseReason === 'hover') {
      this.state.pauseReason = 'scroll'; // upgrade
    } else {
      this._transitionToPaused('scroll');
    }
  }
  ```
- **Mouse rapidly enters/leaves:** `mouseenter`/`mouseleave` fire once each (they don't bubble from children). No debounce needed.
- **Mouse leaves via keyboard focus change:** `mouseleave` won't fire. Acceptable — the user is using keyboard now and can press End to resume.

**Revert:** Remove `mouseenter`/`mouseleave` listeners and `_onHoverEnter`/`_onHoverLeave` methods.

---

### 3.10 — Scroll FAB Integration (SC-10)

**ID:** SC-10
**Name:** Existing scroll FAB restores LIVE mode
**Priority:** P0 (existing feature, enhanced)

**Description:** The existing "scroll to bottom" floating action button (`#resume-scroll-btn`) currently only sets `autoScroll = true`. It must now also transition to LIVE mode.

**Source:** `src/frontend/js/main.js` lines 708–717 (`resumeAutoScroll`), lines 719–727 (`showResumeButton`/`hideResumeButton`)

**Current code:**
```javascript
resumeAutoScroll = () => {
  this.state.autoScroll = true;
  this.hideResumeButton();
  const container = document.getElementById('logs-container');
  if (container) {
    this.renderer.scrollToBottom(container);
  }
}
```

**New code:**
```javascript
resumeAutoScroll = () => {
  this.renderer._transitionToLive();
  // _transitionToLive handles: streamMode=LIVE, badge update, hide resume btn, scroll to bottom
}
```

The `showResumeButton` and `hideResumeButton` methods remain unchanged — they are still called from `_transitionToPaused` and `_transitionToLive` respectively.

**Edge cases:**
- **FAB visible but user is hover-paused:** Clicking FAB should resume. `_transitionToLive` clears pauseReason regardless. Correct.
- **FAB click rapid double-click:** `_transitionToLive` is idempotent. Safe.

**Revert:** Restore original `resumeAutoScroll` body.

---

### 3.11 — Flush Guard Enhancement (SC-11)

**ID:** SC-11
**Name:** Enhanced flush() PAUSED path with badge counter update
**Priority:** P0 (counter display depends on this)

**Description:** The existing `flush()` already short-circuits DOM rendering when paused. Enhance it to update the stream badge counter.

**Source:** `src/frontend/js/renderer.js` lines 223–238 (`flush`)

**Current paused path:**
```javascript
if (this.state.paused) {
  if (this.state.newLogsSinceRender > 0) {
    this.state.filterIndex.updateIncremental(
      this.state.logBuffer,
      (entry) => this.passesFilter(entry)
    );
    this.state.newLogsSinceRender = 0;
  }
  this.updateStats();
  this.renderScheduled = false;
  return;
}
```

**New paused path:**
```javascript
if (this.state.streamMode === 'PAUSED') {
  if (this.state.newLogsSinceRender > 0) {
    this.state.filterIndex.updateIncremental(
      this.state.logBuffer,
      (entry) => this.passesFilter(entry)
    );
    this.state.newLogsSinceRender = 0;
  }
  this.updateStats();
  this._updateStreamBadge(); // live counter update
  this.renderScheduled = false;
  return;
}
```

**Performance:** `_updateStreamBadge` touches 3 DOM elements (badge, label, count). Two `.textContent` sets + one `.hidden` toggle. Cost: <0.01ms. Called at most once per `renderThrottleMs` (100ms). Negligible.

**Revert:** Remove `_updateStreamBadge()` call; restore `this.state.paused` check.

---

### 3.12 — Scroll Event Performance (SC-12)

**ID:** SC-12
**Name:** Scroll event handler must not jank at 60fps
**Priority:** P0 (non-functional, critical)

**Description:** The scroll event handler fires on every scroll frame. It must execute in <1ms.

**Source:** `src/frontend/js/renderer.js` line 147 (`{ passive: true }`)

**Current guarantees (preserved):**
1. `{ passive: true }` on the scroll listener — browser can composite without waiting for JS
2. No DOM reads that trigger layout (only `scrollTop`, `clientHeight`, `scrollHeight` — all cached by the browser for passive listeners)
3. `Date.now()` comparison is O(1)
4. `_scrollPinUntil` avoids false-positive pause detection after programmatic scrollTop

**F12 additions and their cost:**
| Operation | Cost |
|-----------|------|
| `this.state.streamMode === 'LIVE'` | Property read, ~0 |
| `Date.now() > this._scrollPinUntil` | Already present |
| `isAtBottom` calculation | Already present |
| `_transitionToPaused('scroll')` | 5 property sets + 2 DOM `.textContent` + 1 DOM `.hidden` toggle = <0.1ms |

**Total worst-case time added:** <0.1ms on transition (once per pause event, not per scroll frame). Steady-state (already LIVE or already PAUSED) adds only one property read.

**Debounce consideration:** No debounce needed. `_onScroll` is naturally debounced by:
1. `_scrollPinUntil` 80ms guard after programmatic scroll
2. `_transitionToPaused` idempotent guard (no-op if already PAUSED)
3. `requestAnimationFrame` for render scheduling (existing)

If future profiling shows scroll handler is hot, we can add a `performance.mark()` gate but this is unlikely given the current O(1) operations.

**Revert:** N/A (performance is a property, not a revertible change).

---

### 3.13 — Resume-to-Live Scroll Behavior (SC-13)

**ID:** SC-13
**Name:** Snap to bottom on resume with scroll pin
**Priority:** P0 (functional correctness)

**Description:** On PAUSED → LIVE transition, the viewport must snap to the absolute bottom, and the scroll pin must prevent the snap from re-triggering `_onScroll` → immediate re-pause.

**Source:** `src/frontend/js/renderer.js` (`_transitionToLive`, `scrollToBottom`)

**Mechanism (already in `_transitionToLive`):**
```javascript
_transitionToLive = () => {
  // ... state changes ...
  this._scrollPinUntil = Date.now() + 80; // suppress _onScroll for 80ms
  this.flush();         // re-enable DOM rendering, rebuild viewport
  this.scrollToBottom(); // snap scrollTop to bottom
}
```

**`scrollToBottom` (existing, line 688):**
```javascript
scrollToBottom = (container) => {
  if (!container) container = this.scrollContainer;
  if (!container) return;
  const totalHeight = this.state.filterIndex.length * this.ROW_HEIGHT;
  this._scrollPinUntil = Date.now() + 80;
  container.scrollTop = totalHeight;
}
```

This already sets `_scrollPinUntil`. The double-set in `_transitionToLive` → `scrollToBottom` is harmless (both set to `now + 80`).

**Edge cases:**
- **Resume with empty filter index:** `scrollToBottom` sets `scrollTop = 0`. Fine — no rows to show.
- **Resume after ring buffer wrapped:** FilterIndex may have fewer entries than `bufferedCount` suggested. The user sees whatever the ring buffer retained. `scrollToBottom` scrolls to the latest available entry.
- **Resume during ongoing batch ingestion:** `flush()` updates filter index, then `scrollToBottom` snaps to current end. Next `scheduleRender` tick will auto-scroll to new entries normally.

**Revert:** N/A (uses existing `scrollToBottom`).

---

## 4. Interaction Map

### 4.1 Component interactions

| Component | How C05 interacts |
|-----------|-------------------|
| **C03 (Highlight Engine)** | Highlighting applies during `_populateRow`. When PAUSED, `_populateRow` is not called (flush short-circuits). On resume, the visible rows are re-rendered with highlights. No conflict. |
| **C04 (Export Manager)** | Export reads from `filterIndex` which is always up-to-date (even during pause). Export while paused exports the current filter state — correct behavior. |
| **C06 (Error Timeline)** | Timeline receives data from the same `addLog` path. It should update even during pause (errors still arrive). Timeline chart does its own lightweight rendering independent of virtual scroll. |
| **C07 (Enhanced Clustering)** | Clustering reads from ring buffer. During pause, ring buffer is updated. Clustering can update its data structures without DOM rendering. |
| **Existing: Scroll FAB** | FAB now triggers `_transitionToLive` (SC-10). FAB visibility is controlled by `showResumeButton`/`hideResumeButton` called from transition functions. |
| **Existing: Filter changes** | `filter.applyFilters()` calls `filterIndex.rebuild()` then `renderer.flush()`. During PAUSED, flush short-circuits. This means filter changes while paused update the index but don't re-render. On resume, the next flush renders the filtered view. Correct. |
| **Existing: Log level toggle** | Same as filter changes — index rebuilds, flush short-circuits. Correct. |

### 4.2 Data flow

```
WebSocket message
  → state.addLog(entry)
      → logBuffer.push()
      → if PAUSED: bufferedCount++
  → renderer.scheduleRender()
      → renderer.flush()
          → if PAUSED: updateFilterIndex, updateStats, updateStreamBadge, RETURN
          → if LIVE:   updateFilterIndex, renderVirtualScroll, autoScroll
```

---

## 5. CSS Token Additions

**Source:** `src/frontend/css/variables.css`

```css
/* Stream state tokens */
--stream-live: #18a058;
--stream-paused: #e5940c;

/* Dark theme overrides */
[data-theme="dark"] {
  --stream-live: #36d475;
  --stream-paused: #f5a623;
}
```

These tokens are referenced in SC-06 CSS rules. They must be added alongside the existing `--level-*` and `--accent` tokens in `variables.css`.

---

## 6. Accessibility

| Requirement | Implementation |
|-------------|----------------|
| Screen reader announces mode changes | `role="status"` + `aria-live="polite"` on `#stream-badge` |
| Keyboard operability | End, Ctrl+↓, Space all work without mouse |
| Focus visible on badge | Standard `:focus-visible` outline when badge is keyboard-focused |
| Reduced motion | Pulse animation disabled via `prefers-reduced-motion: reduce` |
| Color not sole indicator | "LIVE" / "PAUSED" text label accompanies the colored dot |

---

## 7. Test Strategy

| Test | Type | What |
|------|------|------|
| State init defaults | Unit | `streamMode === 'LIVE'`, `bufferedCount === 0`, `pauseReason === null` |
| Backward compat shims | Unit | `state.autoScroll` getter returns `true` when LIVE, `false` when PAUSED |
| `addLog` increments `bufferedCount` when PAUSED | Unit | Push 5 logs while PAUSED → `bufferedCount === 5` |
| `addLog` does NOT increment when LIVE | Unit | Push 5 logs while LIVE → `bufferedCount === 0` |
| `_transitionToPaused` sets state correctly | Unit | After call: `streamMode === 'PAUSED'`, `pauseReason` matches arg |
| `_transitionToLive` resets state | Unit | After call: `streamMode === 'LIVE'`, `bufferedCount === 0`, `pauseReason === null` |
| Transition idempotency | Unit | Calling `_transitionToPaused` twice doesn't double-set or throw |
| Scroll-up triggers pause | Integration | Simulate scroll event with scrollTop < threshold → verify PAUSED |
| End key resumes | Integration | Set PAUSED, simulate End keydown → verify LIVE |
| Ctrl+↓ resumes | Integration | Set PAUSED, simulate Ctrl+ArrowDown keydown → verify LIVE |
| Hover-freeze basic | Integration | Enable hover, mouseenter → PAUSED, mouseleave → LIVE |
| Hover-freeze does not override manual | Integration | Manual pause, mouseenter (no change), mouseleave (still PAUSED) |
| Pause reason upgrade (hover→scroll) | Integration | Hover-pause, scroll up → pauseReason becomes 'scroll', mouseleave → still PAUSED |
| Badge DOM updates | Integration | Transition to PAUSED → badge shows "PAUSED", count element visible |
| Badge counter ticks | Integration | PAUSED, addLog ×10, flush → badge text includes "10 new" |
| Ring buffer wrap while paused | Integration | Fill 10K buffer, pause, push 5K more → bufferedCount=5K, resume shows latest data |
| Performance: scroll handler <1ms | Perf | `performance.now()` around `_onScroll`, 1000 calls, p99 < 1ms |

---

## 8. Implementation Notes

### File change summary

| File | Changes |
|------|---------|
| `state.js` | Add `streamMode`, `bufferedCount`, `pauseReason`, `hoverFreezeEnabled`. Add backward-compat property shims. Modify `addLog` for `bufferedCount`. |
| `renderer.js` | Add `_transitionToPaused`, `_transitionToLive`, `_updateStreamBadge`, `_onHoverEnter`, `_onHoverLeave`. Modify `_onScroll`, `flush`. Add mouseenter/mouseleave listeners in `initVirtualScroll`. |
| `main.js` | Replace `togglePause` body. Add `End` and `ArrowDown` cases to `handleKeydown`. Replace `resumeAutoScroll` body. Replace `#pause-btn` event setup with `#stream-badge`. |
| `logs.css` | Add `.stream-badge`, `.stream-dot`, `.stream-count` styles. Add `@keyframes stream-pulse`, `badge-count-in`. Add `prefers-reduced-motion` overrides. |
| `variables.css` | Add `--stream-live`, `--stream-paused` tokens (both light and dark). |

### Migration from old pause button

The existing HTML has `<button id="pause-btn">Pause</button>`. This is replaced with the `<span id="stream-badge">` element. The `resumeAutoScroll` listener on `#resume-scroll-btn` (the FAB) is updated to call `_transitionToLive`. No other HTML changes needed.

### Implementation order within C05

1. SC-01 (state properties) — foundation
2. SC-02 (buffered count in addLog) — needs SC-01
3. SC-04 (transition functions) — needs SC-01
4. SC-11 (flush guard) — needs SC-04
5. SC-03 (scroll-up detection) — needs SC-04
6. SC-05 (toolbar badge) — needs SC-04
7. SC-06 (badge CSS) — needs SC-05
8. SC-07 (manual toggle) — needs SC-04
9. SC-08 (keyboard shortcuts) — needs SC-04
10. SC-10 (scroll FAB) — needs SC-04
11. SC-09 (hover-freeze) — needs SC-04, can be last
12. SC-12, SC-13 (performance, scroll behavior) — validation, not code

---

## 9. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Backward-compat shims break existing code that assigns `state.autoScroll = false` | Medium | Shim setter handles `false` by checking current streamMode. Test all callers. |
| Hover-freeze causes unexpected pauses for users who rest mouse on logs | Low | Default to enabled but provide visible toggle. Clear tooltip explains behavior. |
| `_scrollPinUntil` 80ms window too short on slow machines | Low | 80ms is 5 frames at 60fps — generous. Can increase to 150ms if needed. |
| Badge ARIA live region too chatty (screen reader reads every counter update) | Low | Use `aria-live="polite"` not `"assertive"`. Only label + count change, not the full badge. Rate limited to 100ms. |

---

*Spec authored by Pixel. Sentinel approval required before implementation.*
