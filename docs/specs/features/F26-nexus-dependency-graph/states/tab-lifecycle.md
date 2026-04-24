# Nexus Tab Lifecycle — State Matrix

> **Component:** `NexusTab` (tab-nexus.js)
> **Owner:** Pixel (Frontend Engineer)
> **Total states:** 17
> **Companion:** `components/C06-tab-nexus.md` (rendering spec), `signalr-protocol.md` (data contract)
> **Status:** SPEC COMPLETE

---

## Table of Contents

1. [Registration Lifecycle](#1-registration-lifecycle) (2 states)
2. [Activation Pipeline](#2-activation-pipeline) (3 states)
3. [Data Bootstrap](#3-data-bootstrap) (2 states)
4. [Streaming Lifecycle](#4-streaming-lifecycle) (4 states)
5. [Connection Recovery](#5-connection-recovery) (3 states)
6. [Deactivation & Teardown](#6-deactivation--teardown) (3 states)
7. [State Transition Diagram](#7-state-transition-diagram)
8. [Full Event Matrix](#8-full-event-matrix)
9. [Degradation Cascade](#9-degradation-cascade)

---

## Legend

Each state entry follows this structure:

| Field | Description |
|-------|-------------|
| **ID** | Unique state identifier (dot-separated hierarchy) |
| **Entry conditions** | What triggers entry into this state |
| **Exit conditions** | What triggers exit from this state |
| **Visual** | What the user sees in the tab and tab header |
| **Keyboard** | Active keyboard shortcuts in this state |
| **Data requirements** | What data must be present / absent for this state |
| **Transitions** | Where this state can go next, with event triggers |
| **Error recovery** | How the state handles and recovers from failures |

---

## 1. Registration Lifecycle

These states track the tab module from import to registration with `RuntimeView`. A tab lives in exactly one of these two states before it is ever activated.

---

### State: `tab.unregistered`

The NexusTab class has not yet been constructed or registered with RuntimeView. This is the initial state at page load before `main.js` bootstrap completes.

| Field | Value |
|-------|-------|
| **ID** | `tab.unregistered` |
| **Entry conditions** | (1) Page load begins. (2) `main.js` script executing but `NexusTab` constructor has not been called yet. |
| **Exit conditions** | `main.js` calls `new NexusTab(containerEl, signalr)` followed by `runtimeView.registerTab('nexus', nexusTab)` — transitions to `tab.registered-inactive`. |
| **Visual** | Nexus tab header is present in the HTML (static markup in `index.html`). Tab header text reads "Nexus". No badge, no activity indicator. Tab content area is empty (no DOM children in `#rt-tab-nexus`). If user clicks the tab header before registration completes, `RuntimeView.switchTab('nexus')` is a no-op because no module is registered — the tab content area stays empty. |
| **Keyboard** | `Alt+N` (or whichever slot Nexus occupies in the tab bar) — no-op, module not registered. All other keys — no Nexus handlers are bound. |
| **Data requirements** | None. `containerEl` must exist in the DOM (`#rt-tab-nexus` in `index.html`). `signalr` instance may or may not be constructed yet. |
| **Transitions** | `tab.registered-inactive` — on `registerTab('nexus', nexusTab)` call from `main.js` bootstrap. |
| **Error recovery** | If `NexusTab` constructor throws (e.g., `containerEl` missing): catch in `main.js`, log `console.error('[nexus] construction failed', err)`, skip `registerTab`. Tab header remains clickable but inert. No retry — requires page reload. If `signalr` is `null` at construct time: constructor proceeds normally (all SignalR calls are guarded with `if (this._signalr)`). |

---

### State: `tab.registered-inactive`

The NexusTab instance exists, DOM is built, but the tab is not active (user is viewing a different tab). No subscriptions, no listeners, no rendering.

| Field | Value |
|-------|-------|
| **ID** | `tab.registered-inactive` |
| **Entry conditions** | (1) `registerTab('nexus', nexusTab)` completes successfully in `main.js`. (2) Tab was previously active and `deactivate()` completed — returns here from `tab.deactivating`. |
| **Exit conditions** | `RuntimeView.switchTab('nexus')` calls `nexusTab.activate()` — transitions to `tab.activating`. Or `destroy()` called — transitions to `tab.destroyed`. |
| **Visual** | Tab header: "Nexus" label, `--text-muted` color, no underline indicator, no badge. Tab content area: DOM is fully built (canvas, toolbar, empty/loading/error overlays, detail panel, toast container) but hidden via parent container `display: none` (RuntimeView hides inactive tab panels). No canvas rendering. No animation frames scheduled. |
| **Keyboard** | `Alt+N` — triggers `switchTab('nexus')` via RuntimeView's global keyboard handler (`runtime-view.js:116`), transitions to `tab.activating`. No Nexus-specific keyboard handlers are bound. |
| **Data requirements** | `this._active === false`. `this._snapshot` may be `null` (first visit) or may contain stale data from a prior activation session. `this._nodes` and `this._edges` may contain stale state. No SignalR subscriptions active. No global event listeners bound. |
| **Transitions** | `tab.activating` — on `activate()` call. · `tab.inactive-with-badge` — if SignalR status listener fires an alert while inactive (badge appears on tab header). · `tab.destroyed` — on `destroy()` call (page teardown). |
| **Error recovery** | No active operations to fail. If stale `_snapshot` data is corrupted from a prior session: irrelevant — it will be overwritten on next activation. |

---

## 2. Activation Pipeline

These states represent the sequence from `activate()` call to the tab being fully interactive with data flowing.

---

### State: `tab.activating`

The `activate()` method has been called. The tab is setting up subscriptions, binding event listeners, and sizing the canvas. This is a transient state — typically <50ms unless SignalR is disconnected.

| Field | Value |
|-------|-------|
| **ID** | `tab.activating` |
| **Entry conditions** | `RuntimeView.switchTab('nexus')` calls `nexusTab.activate()`. Previous tab's `deactivate()` has already completed (RuntimeView serializes deactivate → activate). |
| **Exit conditions** | Activation sequence completes. Next state depends on conditions: (1) If `this._snapshot` contains valid data from a prior session → `tab.streaming` (skip bootstrap, render immediately). (2) If `this._snapshot` is null and SignalR is connected → `tab.awaiting-first-snapshot`. (3) If SignalR is disconnected → `tab.disconnected`. |
| **Visual** | Tab header: "Nexus" label gains `active` class — text becomes `--text`, sliding underline indicator moves to the Nexus tab position. Tab content area: becomes visible (`display: block`). Canvas is resized to fill available space (`_resizeCanvas()`). If prior snapshot data exists, graph renders immediately during this state. If no data, one of the overlay states (loading/empty/error) is shown via `_updateOverlayState()`. |
| **Keyboard** | Keyboard handlers are bound during this state: `document.addEventListener('keydown', this._onKeyDown)`. Handlers become active immediately. `Escape` — no-op (nothing to close). `Tab` — no-op (no nodes to cycle). |
| **Data requirements** | `this._signalr` — may be `null` (disconnected phase). `this._active` — set to `true` at entry. `this._snapshot` — may be `null` or may contain stale data from prior activation. |
| **Transitions** | `tab.awaiting-first-snapshot` — SignalR connected, subscription initiated, no prior snapshot. · `tab.streaming` — prior snapshot exists and SignalR connected, subscription initiated, rendering resumes with stale data pending fresh snapshot. · `tab.disconnected` — `signalr` is `null` or `signalr.status !== 'connected'`. |
| **Error recovery** | If `signalr.on()` throws: catch silently, log `console.error('[nexus] subscription failed', err)`. Tab enters `tab.disconnected` and shows error overlay. If `_resizeCanvas()` finds zero-dimension container: set `_layoutDirty = true`, defer layout to first snapshot arrival when container may have been reflowed. If `subscribeTopic('nexus')` fails (SignalR not connected): no error — `subscribeTopic` guards against disconnected state internally (`signalr-manager.js:188`). |

---

### State: `tab.awaiting-first-snapshot`

Subscribed to the `nexus` topic but no snapshot has been received yet. Waiting for the first `TopicEvent` from the Phase 1 ring buffer replay or Phase 2 live stream.

| Field | Value |
|-------|-------|
| **ID** | `tab.awaiting-first-snapshot` |
| **Entry conditions** | `activate()` completed, `signalr.subscribeTopic('nexus')` called, `this._snapshot === null` (no prior data). |
| **Exit conditions** | (1) First snapshot `TopicEvent` with `data.type === 'snapshot'` and non-empty `data.nodes` received → `tab.streaming`. (2) First snapshot received but `data.nodes` is empty or contains only `flt-local` → remains in this state (empty topology). (3) SignalR disconnects → `tab.disconnected`. (4) User switches away → `tab.deactivating`. |
| **Visual** | Tab header: active (underline, bright text). Tab content: loading overlay visible. Text: "Waiting for Nexus data..." in `--text-muted` with subtle opacity pulse animation (0.4–0.8 opacity, 2s cycle). Graph icon above text (same SVG as empty state but smaller, 32×32px). Canvas hidden. Toolbar visible but non-interactive (internals toggle disabled). Detail panel closed. |
| **Keyboard** | `Escape` — no-op. `Tab` — no-op. `I` — internals toggle disabled. All navigation keys are no-ops. |
| **Data requirements** | `this._active === true`. `this._snapshot === null`. SignalR connected and `nexus` topic stream active in `signalr._activeStreams`. |
| **Transitions** | `tab.streaming` — first non-empty snapshot received via `_onSnapshot()`. · `tab.disconnected` — SignalR `onreconnecting` fires or connection drops. · `tab.deactivating` — user switches to another tab. |
| **Error recovery** | **Timeout safeguard:** If no snapshot arrives within 10 seconds, update loading text to "Nexus data may be unavailable. FLT must be running and making outbound calls." No automatic retry — the SignalR stream remains open and will deliver data when available. **Malformed first event:** If `_onSnapshot()` receives data with missing `nodes` field, log warning, skip, and remain in this state waiting for a valid snapshot. **REST bootstrap fallback:** If `main.js` already fetched `GET /api/nexus` during page load and cached a valid snapshot, `activate()` can hydrate `this._snapshot` from the cache, skipping this state entirely (→ `tab.streaming`). |

---

### State: `tab.loading-bootstrap`

Optional state entered when the tab uses the REST `GET /api/nexus` endpoint for cold-start bootstrap before the SignalR stream delivers Phase 1 data. This provides immediate rendering during the SignalR connection gap.

| Field | Value |
|-------|-------|
| **ID** | `tab.loading-bootstrap` |
| **Entry conditions** | `activate()` called, `this._snapshot === null`, and `main.js` initiates `fetch('/api/nexus')` as part of the bootstrap sequence. This state is entered only on first-ever activation when no cached data exists. |
| **Exit conditions** | (1) REST call succeeds with non-empty array → hydrate `_snapshot` from response, transition to `tab.streaming`. (2) REST call succeeds with empty array `[]` → transition to `tab.awaiting-first-snapshot`. (3) REST call fails (404, 500, network error) → transition to `tab.bootstrap-failed`. (4) SignalR Phase 1 snapshot arrives before REST completes → discard REST, transition to `tab.streaming` (SignalR is authoritative per protocol spec §3.4). |
| **Visual** | Tab header: active. Tab content: loading overlay with text "Loading Nexus..." in `--text-muted`. No spinner (consistent with S03 spec — push semantics). Subtle opacity pulse on the text. Canvas hidden. |
| **Keyboard** | `Escape` — no-op (cannot cancel bootstrap). All navigation keys — no-ops. |
| **Data requirements** | `this._active === true`. `this._snapshot === null`. Network connectivity to `localhost:5555`. |
| **Transitions** | `tab.streaming` — REST or SignalR delivers valid snapshot. · `tab.awaiting-first-snapshot` — REST returns empty `[]`. · `tab.bootstrap-failed` — REST call fails. · `tab.deactivating` — user switches tab during load. |
| **Error recovery** | **REST 404 (topic not registered):** Treat as "topic not yet available". Fall back to SignalR-only delivery — transition to `tab.awaiting-first-snapshot`. Log: `console.warn('[nexus] REST bootstrap: nexus topic not registered, falling back to SignalR')`. **REST 500:** Transition to `tab.bootstrap-failed`. **Network error (fetch throws):** Same as 500 — transition to `tab.bootstrap-failed`. **Race condition (SignalR wins):** If `_onSnapshot` fires while fetch is still in flight, the SignalR data takes priority. Set `this._bootstrapAborted = true` so the fetch `.then()` handler skips hydration if it arrives late. |

---

## 3. Data Bootstrap

---

### State: `tab.bootstrap-failed`

The REST `GET /api/nexus` call failed. The tab falls back to waiting for SignalR stream data.

| Field | Value |
|-------|-------|
| **ID** | `tab.bootstrap-failed` |
| **Entry conditions** | `GET /api/nexus` returned HTTP 500, threw a network error, or returned malformed JSON. |
| **Exit conditions** | (1) SignalR delivers a valid snapshot → `tab.streaming`. (2) Retry timer fires (5s) and REST retry succeeds → `tab.streaming`. (3) Max retries (2) exhausted → `tab.awaiting-first-snapshot` (pure SignalR fallback). (4) SignalR disconnects → `tab.disconnected`. (5) User switches tab → `tab.deactivating`. |
| **Visual** | Tab header: active. Tab content: loading overlay with modified text. First failure: "Nexus bootstrap failed, retrying..." in `--text-muted`. After max retries: "Waiting for live Nexus data..." (same as `tab.awaiting-first-snapshot`). No error-state red — this is a graceful fallback, not a fatal error. The SignalR stream is the primary data source; REST is a convenience optimization. |
| **Keyboard** | Same as `tab.awaiting-first-snapshot` — all navigation keys are no-ops. |
| **Data requirements** | `this._active === true`. `this._snapshot === null`. `this._bootstrapRetries` counter tracks retry count (max 2). |
| **Transitions** | `tab.streaming` — retry succeeds or SignalR delivers snapshot. · `tab.awaiting-first-snapshot` — max retries exhausted, pure SignalR fallback. · `tab.disconnected` — SignalR drops during retry window. · `tab.deactivating` — user switches away. |
| **Error recovery** | **Retry logic:** Schedule `setTimeout` at 5s intervals, max 2 retries. Each retry re-issues `fetch('/api/nexus')`. On success, hydrate `_snapshot` and transition to `tab.streaming`. On final failure, give up REST and rely entirely on SignalR stream. Clear retry timer on `deactivate()` to prevent orphaned timers. **Aborted fetch on deactivate:** If user switches away during retry window, `deactivate()` calls `this._bootstrapAbortController.abort()` and clears the retry timer. |

---

### State: `tab.streaming`

The primary operating state. Snapshots are arriving at ~1 Hz from the SignalR `nexus` topic stream. The graph is rendered and interactive. This is where the user spends most of their time.

| Field | Value |
|-------|-------|
| **ID** | `tab.streaming` |
| **Entry conditions** | (1) `_onSnapshot()` receives a valid snapshot with non-empty `nodes` (first snapshot after activation). (2) Reconnect completes and new Phase 1 snapshot delivered. (3) Tab re-activated with valid stale `_snapshot` and SignalR connected. |
| **Exit conditions** | (1) No snapshot for >3 seconds → `tab.stale`. (2) SignalR fires `onreconnecting` → `tab.disconnected`. (3) Performance budget exceeded → `tab.streaming-degraded`. (4) Unrecoverable render error → `tab.error-fatal`. (5) User switches tab → `tab.deactivating`. |
| **Visual** | Tab header: active, bright text, underline indicator. No badge. Tab content: full interactive graph. Canvas visible. Toolbar active (internals toggle, reset layout button). Empty/loading/error overlays hidden. Graph renders all nodes and edges per C06-S04 through C06-S08 specs. Detail panel available on node/edge click. Toast container active for alert display. Staleness indicator hidden. Connection status bar shows "Connected" green dot. |
| **Keyboard** | Full keyboard support (C06-S16): `Tab` / `Shift+Tab` — cycle through nodes. `Enter` — open detail panel for selected node. `Escape` — close detail panel; if closed, deselect node. `I` — toggle internals. `R` — reset layout (recompute from seed). `F` — fit graph to canvas (reserved P2). |
| **Data requirements** | `this._active === true`. `this._snapshot` is a valid `NexusSnapshot` object. `this._nodes.size >= 2` (at least `flt-local` + one dependency). `this._edges.length >= 1`. SignalR `nexus` stream active in `_activeStreams`. Staleness timer (`setInterval` at 1s) running. |
| **Transitions** | `tab.stale` — staleness timer detects `Date.now() - snapshot.generatedAt > 3000ms`. · `tab.streaming-degraded` — render frame time exceeds 8ms for 5 consecutive frames. · `tab.disconnected` — SignalR `onreconnecting` or `onclose` fires. · `tab.error-fatal` — `_onSnapshot` catches an unrecoverable error (e.g., canvas context lost). · `tab.deactivating` — user switches tab. |
| **Error recovery** | **Malformed snapshot:** `_onSnapshot()` wraps all processing in `try/catch`. If a snapshot is malformed (missing `nodes`, invalid `edges`), log warning, skip the update, retain previous valid snapshot and continue rendering. No state transition. **Sequence gap:** Track `_lastSequenceId`. If gap detected, log `console.warn('[nexus] sequence gap')`. No corrective action — next full-state snapshot fills the gap. **Alert storm (>10 alerts/snapshot):** Cap toast display at 3 visible toasts. Excess alerts are processed for health data but not displayed. **Canvas context lost:** Extremely rare. If `ctx` becomes null, attempt `canvas.getContext('2d')` re-acquisition. If that fails, transition to `tab.error-fatal`. |

---

## 4. Streaming Lifecycle

---

### State: `tab.streaming-degraded`

Performance budget is exceeded. The tab reduces rendering fidelity to maintain responsiveness.

| Field | Value |
|-------|-------|
| **ID** | `tab.streaming-degraded` |
| **Entry conditions** | Render frame time (`performance.now()` delta across `_renderGraph()`) exceeds 8ms for 5 consecutive frames while in `tab.streaming`. |
| **Exit conditions** | (1) Render frame time drops below 4ms for 10 consecutive frames → `tab.streaming` (restored). (2) Degradation insufficient, frames still >12ms → further reduce (stay in this state, escalate). (3) SignalR disconnects → `tab.disconnected`. (4) User switches tab → `tab.deactivating`. |
| **Visual** | Tab header: active, no visual change from `tab.streaming` (degradation is transparent). Tab content: graph renders with reduced fidelity. **Degradation tiers** (applied incrementally): **Tier 1 — Reduce cosmetics:** Disable edge pulse animations (static opacity). Disable arrowheads. Reduce label rendering frequency (every 2nd frame). **Tier 2 — Reduce geometry:** Collapse low-volume nodes into "Other" group earlier (threshold lowered from `_MAX_NODES` to `_MAX_NODES / 2`). Hide zero-throughput edges. **Tier 3 — Minimal rendering:** Disable edge bezier curves (straight lines). Disable hover hit-testing. Render at 30fps (skip every other RAF). A small indicator appears in the toolbar: "Reduced rendering" in `--text-muted`, `--text-xs`. |
| **Keyboard** | Same as `tab.streaming`. In Tier 3, hover-based interactions are disabled but keyboard navigation remains fully functional. |
| **Data requirements** | Same as `tab.streaming`. Additionally: `this._degradationTier` (1, 2, or 3). `this._frameTimeHistory` — rolling window of last 10 frame times for threshold evaluation. |
| **Transitions** | `tab.streaming` — performance restored (frame times consistently below 4ms). · `tab.disconnected` — SignalR drops. · `tab.deactivating` — user switches tab. · `tab.error-fatal` — canvas context lost or persistent OOM. |
| **Error recovery** | **Tier escalation:** If current tier is insufficient (frames still >12ms for 5 frames after applying current tier), escalate to next tier. Max tier is 3. **Tier de-escalation:** When frame times drop below 4ms for 10 consecutive frames, step down one tier. Recovery is gradual (3→2→1→streaming). **Memory pressure:** If `this._nodes.size > 100` (pathological data), force Tier 3 and collapse aggressively. Log warning. |

---

### State: `tab.stale`

No new snapshot has arrived for more than 3 seconds (3x the 1 Hz heartbeat cadence). The graph displays a staleness indicator but retains the last known state.

| Field | Value |
|-------|-------|
| **ID** | `tab.stale` |
| **Entry conditions** | Staleness timer (`setInterval` at 1s) detects `Date.now() - Date.parse(this._snapshot.generatedAt) > 3000`. Tab was in `tab.streaming` or `tab.streaming-degraded`. |
| **Exit conditions** | (1) New valid snapshot arrives → `tab.streaming`. (2) Staleness persists >15s and SignalR still connected → remain here (aggregator may be paused/restarting). (3) SignalR disconnects → `tab.disconnected`. (4) User switches tab → `tab.deactivating`. |
| **Visual** | Tab header: active. A subtle amber dot appears next to "Nexus" label (same 6px dot pattern as `rt-conn-dot`). Tab content: graph is still rendered with last known data. An overlay indicator appears at the top-center of the canvas area: semi-transparent banner with text "Data may be stale" in `--status-cancelled` (amber), `--text-xs`. The indicator does not obscure graph interaction. Edge pulse animations pause (frozen at current opacity — no visual energy for stale data). Toolbar remains active. If staleness exceeds 15 seconds, the banner text changes to "No updates for Ns" where N is the staleness duration, updated every second. |
| **Keyboard** | Full keyboard support — same as `tab.streaming`. Graph remains navigable and interactive with stale data. |
| **Data requirements** | `this._active === true`. `this._snapshot` contains the last valid snapshot (not cleared). `this._lastSnapshotTime` tracks the `generatedAt` of the most recent snapshot. Staleness timer still running. |
| **Transitions** | `tab.streaming` — new snapshot arrives (staleness timer resets). · `tab.disconnected` — SignalR drops. · `tab.deactivating` — user switches tab. |
| **Error recovery** | **False positive (clock skew):** If `Date.parse(snapshot.generatedAt)` is in the future relative to `Date.now()`, clamp to current time. This prevents negative staleness values from timezone/NTP issues. **Aggregator restart:** Backend aggregator restart causes a brief snapshot gap. The staleness indicator provides the user feedback that data is not flowing. Once the aggregator restarts and publishes, the first Phase 1 snapshot restores the graph. **No automatic refresh/reconnect:** Staleness does not trigger reconnection. If SignalR is connected and no data arrives, the issue is backend-side (aggregator paused, FLT idle, or aggregator crashed). The user can check the connection status bar for transport health. |

---

### State: `tab.inactive-with-badge`

Tab has been deactivated (user is on another tab), but a significant event occurred that warrants the user's attention — a new anomaly alert was received, or a dependency went critical.

| Field | Value |
|-------|-------|
| **ID** | `tab.inactive-with-badge` |
| **Entry conditions** | Tab is in `tab.registered-inactive` and the SignalR status listener (registered during a prior activation) detects a critical-severity alert on the `nexus` topic. **Note:** In V1, the badge mechanism uses a global listener registered in `main.js` that monitors `nexus` topic events even when the tab is inactive. This is a lightweight "peek" subscription — it does not process full snapshots, only checks for `data.type === 'alert'` with `severity === 'critical'`. |
| **Exit conditions** | (1) User switches to Nexus tab → `tab.activating` (badge clears). (2) Badge auto-expires after 60 seconds with no new critical alerts → `tab.registered-inactive`. (3) Page destroyed → `tab.destroyed`. |
| **Visual** | Tab header: "Nexus" label in `--text-muted`, no underline (inactive). A small red notification dot (6px circle, `--status-failed` color) appears to the upper-right of the "Nexus" text. The dot uses a brief scale-in animation (0→1 over 200ms, `ease-out`). The dot pulses gently (opacity 0.7–1.0, 3s cycle) to draw attention without distraction. No badge count — just the presence/absence of the dot. |
| **Keyboard** | `Alt+N` — triggers `switchTab('nexus')`, clears badge, transitions to `tab.activating`. No Nexus-specific handlers active. |
| **Data requirements** | `this._active === false`. `this._hasBadge === true`. Badge state is managed by `main.js` global listener, not by `NexusTab` itself. The global listener calls a method like `nexusTab.setBadge(true)` which sets the CSS class on the tab header element. |
| **Transitions** | `tab.activating` — user clicks or keyboard-switches to Nexus tab. Badge cleared on activate. · `tab.registered-inactive` — badge expires (60s timeout). · `tab.destroyed` — page teardown. |
| **Error recovery** | **Badge stuck:** If the badge-clearing mechanism fails (e.g., `activate()` throws before clearing), the badge persists. Next successful `activate()` always clears. Worst case: visual-only — a stale badge causes no functional harm. **Listener leak:** The global listener in `main.js` must be properly scoped. If NexusTab is destroyed, the global listener must also be removed to prevent processing events for a destroyed tab. |

---

## 5. Connection Recovery

---

### State: `tab.disconnected`

SignalR connection is lost while the Nexus tab is active. The graph retains the last known state but is visually marked as disconnected.

| Field | Value |
|-------|-------|
| **ID** | `tab.disconnected` |
| **Entry conditions** | (1) SignalR fires `onreconnecting()` or `onclose()` while tab is active in `tab.streaming`, `tab.stale`, or `tab.awaiting-first-snapshot`. (2) Tab activated when `signalr.status === 'disconnected'` or `signalr` is `null` (Disconnected Phase). |
| **Exit conditions** | (1) SignalR fires `onreconnected()` → `tab.reconnecting`. (2) SignalR connection permanently closed and auto-reconnect exhausted → `tab.error-fatal`. (3) User switches tab → `tab.deactivating`. |
| **Visual** | Tab header: active, underline visible. Tab content: if graph was previously rendered (`_snapshot` exists), the graph remains visible but desaturated (canvas gets a `filter: saturate(0.3)` CSS class overlay, or drawn with reduced alpha). A centered overlay banner appears: "Connection lost" in `--status-failed`, larger text (`--text-md`, 600 weight). Below: "Reconnecting..." in `--text-muted` with an animated ellipsis (period count cycles 1→2→3→1 every 500ms). The connection status bar in the RuntimeView shell also shows "Reconnecting..." with amber dot. Edge pulse animations stopped. Detail panel remains open but marked "(stale)" in the header. Toolbar visible but internals toggle is non-interactive. |
| **Keyboard** | `Escape` — close detail panel. `Tab` / `Shift+Tab` — still cycle nodes (stale data is navigable). `Enter` — open detail panel (stale metrics). Deep-link buttons disabled (navigating to another tab that also has no data is not useful). |
| **Data requirements** | `this._active === true`. `this._snapshot` may contain last valid data (render it desaturated) or may be `null` (show full error overlay). SignalR `nexus` stream is torn down (removed from `_activeStreams` by `signalr-manager.js:203`). Staleness timer paused (staleness is implied by disconnection). |
| **Transitions** | `tab.reconnecting` — SignalR `onreconnected()` fires. · `tab.error-fatal` — SignalR auto-reconnect exhausted (after 6 attempts per schedule `[0, 1000, 2000, 5000, 10000, 30000]ms`). · `tab.deactivating` — user switches tab. |
| **Error recovery** | **Reconnection is handled by SignalR:** `signalr-manager.js` auto-reconnect schedule handles reconnection attempts. NexusTab does not implement its own reconnection logic — it reacts to SignalR status callbacks. **Manual reconnect:** User can trigger a full reconnect via `signalr.connect()` from the connection status bar or by refreshing the page. **Data preservation:** Last valid snapshot is preserved for visual continuity. No data is cleared during disconnection. |

---

### State: `tab.reconnecting`

SignalR has re-established the connection. The tab is re-subscribing to the `nexus` topic and awaiting the Phase 1 snapshot replay.

| Field | Value |
|-------|-------|
| **ID** | `tab.reconnecting` |
| **Entry conditions** | SignalR fires `onreconnected()` callback. `_resubscribeAll()` in `signalr-manager.js:147-158` triggers automatic re-subscription of all active topic streams, including `nexus` (if the tab was active when disconnection occurred). |
| **Exit conditions** | (1) First snapshot from Phase 1 replay arrives → `tab.reconnected`. (2) Re-subscription fails (stream error) → `tab.disconnected` (retry via SignalR auto-reconnect). (3) User switches tab → `tab.deactivating`. |
| **Visual** | Tab header: active. Tab content: previous graph still visible (no longer desaturated — optimistic rendering). Overlay banner updates to: "Reconnected — syncing..." in `--status-succeeded` (green), `--text-sm`. Banner auto-dismisses when first snapshot arrives. Connection status bar shows "Connected" green dot. Edge pulse animations remain paused until first fresh snapshot. |
| **Keyboard** | Same as `tab.disconnected`. Graph is navigable but data is stale until first fresh snapshot arrives. |
| **Data requirements** | `this._active === true`. SignalR connected. `nexus` topic re-subscribed (new stream in `_activeStreams`). `this._snapshot` contains stale data from before disconnection. `this._awaitingReconnectSnapshot === true` (flag to identify the first post-reconnect snapshot). |
| **Transitions** | `tab.reconnected` — first snapshot from Phase 1 replay received by `_onSnapshot()`. · `tab.disconnected` — stream error, or SignalR drops again. · `tab.deactivating` — user switches tab. |
| **Error recovery** | **Stream error on re-subscribe:** If `subscribeTopic('nexus')` throws or the stream errors (`signalr-manager.js:201-204`), the stream is removed from `_activeStreams`. Tab falls back to `tab.disconnected`. Next `onreconnected` will retry. **Duplicate subscription guard:** `subscribeTopic` checks `_activeStreams.has(topic)` before subscribing (`signalr-manager.js:187`). The `_resubscribeAll` flow clears `_activeStreams` first (`line 155`), so double-subscribe is impossible. |

---

### State: `tab.reconnected`

Just received the first snapshot after reconnection. This is a brief transition state (single frame) where the graph state is fully replaced with fresh data.

| Field | Value |
|-------|-------|
| **ID** | `tab.reconnected` |
| **Entry conditions** | First `_onSnapshot()` call after reconnection processes successfully. `this._awaitingReconnectSnapshot === true` and snapshot is valid. |
| **Exit conditions** | Immediate transition to `tab.streaming` after snapshot processing completes. This state exists conceptually for a single tick — it represents the moment of state replacement. |
| **Visual** | The "Reconnected — syncing..." banner fades out (opacity 1→0 over 300ms, then `display: none`). Graph is fully re-rendered with fresh snapshot data (full-state replacement per protocol §1.3). Any nodes that disappeared during the gap are removed. Any new nodes that appeared are added. Layout recomputes if node topology changed. Staleness timer resets. Edge pulse animations resume (if non-healthy edges exist). Canvas desaturation filter removed. |
| **Keyboard** | Full keyboard support restored — same as `tab.streaming`. |
| **Data requirements** | `this._active === true`. `this._snapshot` replaced with fresh snapshot. `this._awaitingReconnectSnapshot` set to `false`. Staleness timer restarted with fresh `generatedAt` timestamp. |
| **Transitions** | `tab.streaming` — immediate (same tick). |
| **Error recovery** | **Malformed reconnect snapshot:** If the first post-reconnect snapshot is malformed, log warning, skip it, remain in `tab.reconnecting` and wait for the next valid snapshot (Phase 1 delivers multiple events from the ring buffer). **Node topology change during gap:** Full-state replacement semantics handle this cleanly. Layout recomputes automatically when `_layoutDirty` is set by the node diff logic in `_onSnapshot()`. |

---

## 6. Deactivation & Teardown

---

### State: `tab.deactivating`

The `deactivate()` method has been called. The tab is tearing down subscriptions, removing event listeners, and stopping timers. Transient state — typically <10ms.

| Field | Value |
|-------|-------|
| **ID** | `tab.deactivating` |
| **Entry conditions** | `RuntimeView.switchTab(otherTab)` calls `nexusTab.deactivate()`. Can be entered from any active state: `tab.activating`, `tab.awaiting-first-snapshot`, `tab.loading-bootstrap`, `tab.bootstrap-failed`, `tab.streaming`, `tab.streaming-degraded`, `tab.stale`, `tab.disconnected`, `tab.reconnecting`, `tab.reconnected`. |
| **Exit conditions** | `deactivate()` completes → `tab.registered-inactive` (or `tab.inactive-with-badge` if badge condition met). |
| **Visual** | Tab header: "Nexus" label loses `active` class — text returns to `--text-muted`, underline slides to new active tab. Tab content area: hidden by RuntimeView (`display: none`). Any open detail panel is left in its current state (not force-closed — preserved for re-activation). Active toasts are removed from DOM (not preserved). Banner overlays (stale, disconnected, syncing) are removed. |
| **Keyboard** | All Nexus keyboard handlers removed: `document.removeEventListener('keydown', this._onKeyDown)`, `window.removeEventListener('resize', this._onResize)`. |
| **Data requirements** | `this._active` set to `false`. All the following are torn down: (1) `signalr.off('nexus', this._onSnapshot)` — remove snapshot listener. (2) `signalr.unsubscribeTopic('nexus')` — dispose the stream. (3) `clearInterval(this._stalenessTimer)` — stop staleness polling. (4) `clearTimeout(this._bootstrapRetryTimer)` — stop any pending REST retry. (5) `this._bootstrapAbortController?.abort()` — cancel in-flight REST fetch. (6) Cancel any pending RAF via `this._renderPending = false`. (7) Remove `document.keydown` and `window.resize` listeners. **Not cleared:** `this._snapshot`, `this._nodes`, `this._edges` — preserved for re-activation continuity. `this._selectedNode`, `this._selectedEdge` — preserved. |
| **Transitions** | `tab.registered-inactive` — standard deactivation. · `tab.inactive-with-badge` — if global listener detects pending critical alert. |
| **Error recovery** | **Listener leak prevention:** All listeners use bound references stored during construction (`this._onKeyDown`, `this._onResize`, `this._onSnapshot`). `removeEventListener` with the exact same reference guarantees removal. **Double deactivate guard:** If `this._active` is already `false`, `deactivate()` returns immediately (no-op). **Stream dispose error:** `signalr.unsubscribeTopic()` wraps `stream.dispose()` in try/catch (`signalr-manager.js:217-219`). Errors are swallowed. |

---

### State: `tab.error-fatal`

An unrecoverable error has occurred. The tab cannot render or receive data. Requires manual intervention (page reload).

| Field | Value |
|-------|-------|
| **ID** | `tab.error-fatal` |
| **Entry conditions** | (1) Canvas `2d` context lost and re-acquisition failed. (2) `_onSnapshot()` throws a persistent error on 5 consecutive snapshots (snapshot processing loop is broken). (3) SignalR auto-reconnect exhausted (all 6 retry attempts failed, `onclose()` fires). (4) `NexusTab` internal state corrupted (e.g., `_nodes` or `_edges` throw on iteration — prototype poisoning, structural corruption). |
| **Exit conditions** | (1) User reloads the page → full re-initialization. (2) User clicks "Retry" button in error overlay → attempts re-initialization (`_resetState()` + `activate()`). (3) User switches tab → `tab.deactivating` (error state is preserved — re-entering the tab shows the error again unless condition cleared). |
| **Visual** | Tab header: active, underline visible. Tab content: full-screen error overlay. Canvas hidden. Error overlay contains: red-tinted border at top (4px, `--status-failed`). Error icon: `!` in a circle (SVG, `--status-failed`, 48×48px). Title: "Nexus encountered an error" in `--text`, `--text-lg`, 600 weight. Description: contextual error message in `--text-muted`, `--text-sm` (e.g., "Canvas rendering context was lost" or "SignalR connection could not be re-established"). Two action buttons: "Retry" (primary ghost button) and "Reload Page" (secondary ghost button). Below buttons: "If this persists, check the browser console for details." in `--text-muted`, `--text-xs`. |
| **Keyboard** | `Tab` — cycles focus between "Retry" and "Reload Page" buttons. `Enter` — activates focused button. `Escape` — no-op (error must be explicitly dismissed). |
| **Data requirements** | `this._active === true`. `this._errorInfo` object: `{ type: string, message: string, timestamp: number, recoverable: boolean }`. `this._snapshot` may contain last valid data (preserved but not rendered). Error overlay DOM is built lazily on first error. |
| **Transitions** | `tab.activating` — user clicks "Retry" (calls `_resetState()` then `activate()`). · `tab.deactivating` — user switches to another tab. · `tab.destroyed` — page unload. · Page reload — full re-initialization. |
| **Error recovery** | **Retry mechanism:** "Retry" button calls `_resetState()` which: (1) clears `_errorInfo`, (2) resets `_snapshot` to `null`, (3) clears `_nodes` and `_edges`, (4) attempts canvas context re-acquisition, (5) calls `activate()`. If `activate()` succeeds, tab enters `tab.activating` normally. If `activate()` throws again, re-enters `tab.error-fatal` with updated error info. **Retry cooldown:** "Retry" button has a 3-second cooldown after each attempt (disabled state with countdown text "Retry (3s)"). Prevents rapid retry loops. **Telemetry:** Error details are logged to `console.error('[nexus] fatal error', this._errorInfo)`. No remote telemetry in V1. |

---

### State: `tab.destroyed`

The `destroy()` method has been called. All resources are released. The NexusTab instance is no longer usable. This state is terminal — no transitions out.

| Field | Value |
|-------|-------|
| **ID** | `tab.destroyed` |
| **Entry conditions** | `destroy()` called by `main.js` during page unload or hot-module replacement. Can be entered from any state. |
| **Exit conditions** | None. Terminal state. |
| **Visual** | No visual. Page is unloading or DOM is being torn down. |
| **Keyboard** | None. All listeners removed. |
| **Data requirements** | All internal state is cleared: `this._snapshot = null`. `this._nodes.clear()`. `this._edges = []`. `this._ctx = null`. `this._canvas = null`. `this._els = {}`. All timers cleared. All event listeners removed. `this._signalr` reference nulled. Container element's children may be cleared (`this._container.innerHTML = ''`). The global badge listener in `main.js` must also be removed. |
| **Transitions** | None. Terminal. Instance should be eligible for garbage collection. |
| **Error recovery** | **Error during destroy:** `destroy()` wraps all cleanup in individual try/catch blocks. Each cleanup step is independent — failure in one does not prevent others. Errors are logged but not propagated. **Double destroy guard:** If `this._destroyed === true`, return immediately. Set flag at entry. **Orphaned timers:** All timer IDs are tracked in `this._timers[]`. `destroy()` iterates and clears all. |

---

## 7. State Transition Diagram

```
                                    Page Load
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ tab.unregistered  │
                              └────────┬─────────┘
                                       │ registerTab()
                                       ▼
                         ┌───────────────────────────┐
                    ┌────│  tab.registered-inactive   │◄─────────────────┐
                    │    └────────────┬───────────────┘                  │
                    │                 │ activate()                       │
                    │                 ▼                                  │
                    │    ┌───────────────────────────┐                  │
                    │    │     tab.activating         │                  │
                    │    └──┬───────────┬──────────┬──┘                  │
                    │       │           │          │                     │
                    │       │ has data  │ no data  │ no signalr          │
                    │       │           │          │                     │
                    │       │           ▼          ▼                     │
                    │       │  ┌────────────┐  ┌──────────────┐         │
                    │       │  │  loading-  │  │              │         │
                    │       │  │  bootstrap │  │ disconnected │◄──┐     │
                    │       │  └──┬────┬───┘  │              │   │     │
                    │       │     │    │       └──────┬───────┘   │     │
                    │       │     │    │fail          │reconnected│     │
                    │       │     │    ▼              ▼           │     │
                    │       │     │ ┌──────────┐ ┌──────────────┐│     │
                    │       │     │ │bootstrap-│ │ reconnecting ││     │
                    │       │     │ │ failed   │ │              ││     │
                    │       │     │ └────┬─────┘ └──────┬───────┘│     │
                    │       │     │      │              │        │     │
                    │       │     │      │fallback      │1st snap│     │
                    │       │     │      ▼              ▼        │     │
                    │       │     │ ┌──────────────┐ ┌─────────┐│     │
                    │       │     │ │  awaiting-   │ │reconnect││     │
                    │       │     │ │first-snapshot│ │  -ed     ││     │
                    │       │     │ └──────┬───────┘ └────┬────┘│     │
                    │       │     │        │              │      │     │
                    │       │     │  1st   │         immediate   │     │
                    │       │     │snapshot │              │      │     │
                    │       ▼     ▼        ▼              ▼      │     │
                    │    ┌─────────────────────────────────────┐  │     │
                    │    │          tab.streaming              │──┘     │
                    │    │  (primary operating state)          │        │
                    │    └──┬──────────────┬──────────────┬────┘        │
                    │       │              │              │             │
                    │       │ >3s stale    │ perf issue   │ fatal       │
                    │       ▼              ▼              ▼             │
                    │  ┌──────────┐ ┌───────────────┐ ┌────────────┐   │
                    │  │tab.stale │ │  streaming-   │ │error-fatal │   │
                    │  │          │ │  degraded     │ │            │   │
                    │  └─────┬────┘ └───────┬───────┘ └──────┬─────┘   │
                    │        │              │                 │retry    │
                    │        │ new snap     │ perf restored   │         │
                    │        └──────┬───────┘                 │         │
                    │               ▼                         │         │
                    │          tab.streaming ◄────────────────┘         │
                    │                                                   │
                    │       deactivate() from ANY active state          │
                    │               │                                   │
                    │               ▼                                   │
                    │    ┌───────────────────────┐                      │
                    │    │   tab.deactivating     │─────────────────────┘
                    │    └───────────────────────┘
                    │
                    │    destroy() from ANY state
                    │               │
                    │               ▼
                    │    ┌───────────────────────┐
                    └───►│    tab.destroyed       │  (terminal)
                         └───────────────────────┘
```

---

## 8. Full Event Matrix

Every state x event combination. Cells show the target state or action.

| Current State ↓  Event → | `activate()` | `deactivate()` | `destroy()` | snapshot received | alert received | SignalR disconnected | SignalR reconnected | staleness timeout | perf threshold | REST success | REST fail | retry click | user tab switch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **tab.unregistered** | N/A (not registered) | N/A | `destroyed` | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| **tab.registered-inactive** | → `activating` | no-op | `destroyed` | no-op | badge → `inactive-with-badge` | no-op | no-op | N/A | N/A | N/A | N/A | N/A | no-op |
| **tab.inactive-with-badge** | → `activating` (clear badge) | no-op | `destroyed` | no-op | refresh badge timer | no-op | no-op | N/A | N/A | N/A | N/A | N/A | no-op |
| **tab.activating** | no-op (guard) | → `deactivating` | `destroyed` | → `streaming` | queue | → `disconnected` | no-op | N/A | N/A | → `streaming` | → `bootstrap-failed` | N/A | → `deactivating` |
| **tab.loading-bootstrap** | no-op | → `deactivating` | `destroyed` | → `streaming` (abort REST) | queue | → `disconnected` | no-op | N/A | N/A | → `streaming` | → `bootstrap-failed` | N/A | → `deactivating` |
| **tab.bootstrap-failed** | no-op | → `deactivating` | `destroyed` | → `streaming` | queue | → `disconnected` | no-op | N/A | N/A | → `streaming` | retry or → `awaiting-first-snapshot` | N/A | → `deactivating` |
| **tab.awaiting-first-snapshot** | no-op | → `deactivating` | `destroyed` | → `streaming` | show toast | → `disconnected` | no-op | update loading text | N/A | N/A | N/A | N/A | → `deactivating` |
| **tab.streaming** | no-op | → `deactivating` | `destroyed` | update graph (stay) | process + toast | → `disconnected` | no-op | → `stale` | → `streaming-degraded` | N/A | N/A | N/A | → `deactivating` |
| **tab.streaming-degraded** | no-op | → `deactivating` | `destroyed` | update graph (stay or → `streaming` if perf restored) | process + toast | → `disconnected` | no-op | → `stale` | escalate tier | N/A | N/A | N/A | → `deactivating` |
| **tab.stale** | no-op | → `deactivating` | `destroyed` | → `streaming` | process + toast | → `disconnected` | no-op | update banner text | N/A | N/A | N/A | N/A | → `deactivating` |
| **tab.disconnected** | no-op | → `deactivating` | `destroyed` | N/A (no stream) | N/A | no-op (already) | → `reconnecting` | N/A | N/A | N/A | N/A | N/A | → `deactivating` |
| **tab.reconnecting** | no-op | → `deactivating` | `destroyed` | → `reconnected` | queue | → `disconnected` | no-op | N/A | N/A | N/A | N/A | N/A | → `deactivating` |
| **tab.reconnected** | no-op | → `deactivating` | `destroyed` | update graph (→ `streaming`) | process | → `disconnected` | no-op | reset timer | N/A | N/A | N/A | N/A | → `deactivating` |
| **tab.error-fatal** | no-op | → `deactivating` | `destroyed` | no-op (not subscribed) | no-op | no-op | no-op | N/A | N/A | N/A | N/A | → `activating` | → `deactivating` |
| **tab.deactivating** | no-op (guard) | no-op (guard) | `destroyed` | dropped (unsubscribed) | dropped | no-op | no-op | N/A | N/A | aborted | aborted | N/A | N/A |
| **tab.destroyed** | no-op | no-op | no-op | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

---

## 9. Degradation Cascade

The Nexus tab implements a four-level graceful degradation cascade. Each level preserves the maximum functionality possible at that level of service.

```
Level 0: NORMAL
  │  Full graph rendering, 60fps, pulse animations,
  │  hover tooltips, full keyboard nav, live data
  │
  │  Trigger: frame time > 8ms for 5 consecutive frames
  ▼
Level 1: REDUCED COSMETICS (tab.streaming-degraded, Tier 1)
  │  Static edges (no pulse), no arrowheads,
  │  labels every 2nd frame. Still interactive.
  │
  │  Trigger: frame time > 12ms for 5 frames after Tier 1 applied
  ▼
Level 2: REDUCED GEOMETRY (tab.streaming-degraded, Tier 2)
  │  Aggressive node collapse (MAX_NODES/2),
  │  zero-throughput edges hidden. Keyboard nav intact.
  │
  │  Trigger: frame time > 12ms for 5 frames after Tier 2 applied
  ▼
Level 3: MINIMAL (tab.streaming-degraded, Tier 3)
  │  Straight-line edges, no hover hit-testing,
  │  30fps cap. Keyboard nav only interaction.
  │
  │  Trigger: canvas context lost or persistent OOM
  ▼
Level 4: DISABLED (tab.error-fatal)
     Error overlay. No rendering. Manual retry only.
```

**Recovery direction:** Each level can de-escalate to the previous level when performance metrics improve. De-escalation requires 10 consecutive frames below 4ms at the current tier. Recovery path: `Level 3 → 2 → 1 → 0`.

---

## Appendix A: Timer & Listener Inventory

All timers and listeners that must be managed across state transitions.

| Resource | Created in | Cleared in | Type |
|----------|-----------|------------|------|
| `this._stalenessTimer` | `activate()` | `deactivate()` | `setInterval(1000)` |
| `this._bootstrapRetryTimer` | `tab.bootstrap-failed` | `deactivate()`, max retries, or success | `setTimeout(5000)` |
| `this._bootstrapAbortController` | `tab.loading-bootstrap` | `deactivate()` or fetch completes | `AbortController` |
| `document keydown` (this._onKeyDown) | `activate()` | `deactivate()` | `EventListener` |
| `window resize` (this._onResize) | `activate()` | `deactivate()` | `EventListener` |
| `signalr.on('nexus', this._onSnapshot)` | `activate()` | `deactivate()` | SignalR listener |
| `signalr.subscribeTopic('nexus')` stream | `activate()` | `deactivate()` via `unsubscribeTopic` | SignalR stream |
| RAF via `_scheduleRender()` | any render trigger | `_active = false` guard in RAF callback | `requestAnimationFrame` |
| Badge expiry timer | `main.js` global listener | badge cleared on activate or 60s timeout | `setTimeout(60000)` |
| Alert dedup timers | `_processAlerts()` | 10s self-clearing `setTimeout` | `setTimeout(10000)` |
| Toast auto-dismiss timers | `_showToast()` | 8s self-clearing `setTimeout`, or `deactivate()` removes DOM | `setTimeout(8000)` |

## Appendix B: State Guards

Critical guards that prevent illegal state transitions.

| Guard | Implementation | Prevents |
|-------|---------------|----------|
| Double activate | `if (this._active) return;` at top of `activate()` | Double SignalR subscription, duplicate listeners |
| Double deactivate | `if (!this._active) return;` at top of `deactivate()` | Removing listeners that were never added |
| Double destroy | `if (this._destroyed) return;` at top of `destroy()` | Double cleanup, null reference errors |
| Snapshot while inactive | `if (!this._active) return;` in `_onSnapshot()` | Processing data after deactivate (race condition) |
| Render while inactive | `if (this._active)` guard inside RAF callback | Wasted frame rendering for hidden tab |
| Bootstrap abort on SignalR win | `if (this._bootstrapAborted) return;` in fetch `.then()` | Overwriting fresh SignalR data with stale REST data |
