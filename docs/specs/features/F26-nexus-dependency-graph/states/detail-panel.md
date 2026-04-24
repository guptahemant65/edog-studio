# F26 Nexus — P3 State Matrix: Detail Panel

> **Feature:** F26 — Nexus: Real-Time Cross-Workload Dependency Graph
> **Component:** Detail Panel (slide-out inspector)
> **Phase:** P3 — State Matrix
> **Author:** Pixel (frontend agent)
> **Status:** SPEC
> **Date:** 2025-07-25
> **Prerequisites:** P1 Component Spec (C06-S09, C06-S10, C06-S16), P2 Architecture, P2 SignalR Protocol
> **Source truth:** `C06-tab-nexus.md` S09 (detail panel), S10 (deep links), S12 (snapshot updates), S15 (collapse/Other), S16 (keyboard), S17 (error states)

---

## Table of Contents

1. [State Inventory](#1-state-inventory)
2. [State Definitions](#2-state-definitions)
3. [Transition Table](#3-transition-table)
4. [State Diagram](#4-state-diagram)
5. [Event Inventory](#5-event-inventory)
6. [Full State x Event Matrix](#6-full-state-x-event-matrix)
7. [Error Recovery Matrix](#7-error-recovery-matrix)

---

## 1. State Inventory

| # | State ID | Summary |
|---|----------|---------|
| 1 | `panel.closed` | No panel visible; canvas has full width |
| 2 | `panel.opening` | CSS slide-in transition running (150ms) |
| 3 | `panel.node-view` | Showing dependency node metrics + deep links |
| 4 | `panel.node-view.flt-center` | FLT center node selected — aggregate outbound view |
| 5 | `panel.node-view.collapsed-group` | "Other (N)" aggregate node selected — list of collapsed deps |
| 6 | `panel.edge-view` | Showing edge-specific metrics (source -> target) |
| 7 | `panel.node-view.live-updating` | Panel content refreshing from incoming 1 Hz snapshot |
| 8 | `panel.node-view.stale` | No snapshot received for > 3 s; stale badge shown |
| 9 | `panel.closing` | CSS slide-out transition running (150ms) |
| 10 | `panel.deep-link-navigating` | User clicked a deep link; tab switch in progress |
| 11 | `panel.node-disappeared` | Selected node was removed from latest snapshot |
| 12 | `panel.edge-disappeared` | Selected edge was removed from latest snapshot |
| 13 | `panel.error` | Panel content failed to render (data parse error, DOM exception) |
| 14 | `panel.switching-target` | Transition from one node/edge selection to another without closing |
| 15 | `panel.keyboard-focus` | Panel DOM has keyboard focus (deep-link buttons are tabbable) |

**Total: 15 states**

---

## 2. State Definitions

### 2.1 `panel.closed`

**Entry conditions:**
- Initial state on tab activation (no selection).
- User presses Escape when panel is open.
- User clicks canvas background (no node/edge hit).
- User clicks the `\u2715` close button.
- `panel.closing` animation completes (`transitionend` fires).
- Selected node/edge removed from snapshot AND auto-close completes.
- Deep-link navigation closes the panel before switching tabs.
- Tab deactivation (`NexusTab.deactivate()` resets panel).

**Exit conditions:**
- User clicks a node on the canvas.
- User clicks an edge on the canvas.
- User presses Enter with a keyboard-selected node.

**Visual description:**
- Panel element has `class="nexus-detail closed"` with `transform: translateX(100%)` and `pointer-events: none`.
- Canvas occupies full container width.
- No selection ring on any node (unless keyboard navigation keeps `_selectedNode` set — ring shows but panel is closed).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle keyboard selection through graph nodes |
| `Enter` | Open detail panel for keyboard-selected node → `panel.opening` |
| `Escape` | Deselect current node (if any) |

**Data requirements:**
- No panel-specific subscriptions. The `nexus` topic subscription is managed by the parent `NexusTab` regardless of panel state.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `node.click(depId)` | `panel.opening` (→ `panel.node-view`) |
| `node.click('flt-local')` | `panel.opening` (→ `panel.node-view.flt-center`) |
| `node.click('_other')` | `panel.opening` (→ `panel.node-view.collapsed-group`) |
| `edge.click(edgeIdx)` | `panel.opening` (→ `panel.edge-view`) |
| `keyboard.enter` | `panel.opening` (→ resolved node type) |
| `tab.deactivate` | Remain `panel.closed` (no-op) |

**Error recovery:**
- N/A — no active rendering in this state.

---

### 2.2 `panel.opening`

**Entry conditions:**
- Any click or Enter on a node/edge when panel is currently closed.
- Switching from one target to another triggers `panel.switching-target` instead — this state is only for cold open.

**Exit conditions:**
- CSS `transitionend` event on `transform` property fires → advance to content state.
- If transition duration is 0 (reduced-motion), advance immediately.

**Visual description:**
- Panel `classList.remove('closed')` triggers CSS transition: `transform: translateX(100%)` → `translateX(0)` over 150ms ease.
- Panel header shows the target name (dependency display name or "FLT" or "Other (N)").
- Panel body is empty or shows a brief shimmer placeholder until content renders.
- Selected node/edge gets accent ring on canvas.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Cancel open → `panel.closing` |

**Data requirements:**
- None beyond existing `nexus` topic. Content populates from `this._snapshot` (already in memory).

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `transitionend` (dep node) | `panel.node-view` |
| `transitionend` (flt-local) | `panel.node-view.flt-center` |
| `transitionend` (_other) | `panel.node-view.collapsed-group` |
| `transitionend` (edge) | `panel.edge-view` |
| `keyboard.escape` | `panel.closing` |
| `tab.deactivate` | `panel.closed` (instant, skip animation) |

**Error recovery:**
- If `transitionend` does not fire within 300ms (guard timer), force-advance to content state. Prevents stuck-open empty panel.

---

### 2.3 `panel.node-view`

**Entry conditions:**
- `panel.opening` completes for a standard dependency node (not `flt-local`, not `_other`).
- `panel.switching-target` completes for a standard dependency node.
- `panel.node-view.live-updating` finishes content refresh (returns here).
- `panel.node-view.stale` receives a fresh snapshot (clears stale, returns here).

**Exit conditions:**
- User clicks `\u2715` close button or presses Escape → `panel.closing`.
- User clicks canvas background → `panel.closing`.
- User clicks a different node/edge → `panel.switching-target`.
- User clicks a deep-link button → `panel.deep-link-navigating`.
- Snapshot arrives with updated data for this node → `panel.node-view.live-updating`.
- No snapshot for > 3s → `panel.node-view.stale`.
- Node removed from snapshot → `panel.node-disappeared`.
- Tab deactivated → `panel.closed` (instant).
- Render failure → `panel.error`.

**Visual description:**
- 320px panel pinned to the right edge of the Nexus container, overlaying the canvas.
- **Header:** Dependency display name (e.g., "Spark (GTS)"), `\u2715` close button.
- **Body — metrics table:**

| Label | Value |
|-------|-------|
| Health | `<badge class="h-{health}">` healthy / degraded / critical |
| p50 | `180ms` (formatted: ms < 1000, else seconds) |
| p95 | `690ms` |
| p99 | `720ms` |
| Error rate | `7.0%` |
| Retry rate | `11.0%` |
| Throughput | `37.2/min` |
| Baseline | `3.0x above baseline` (only if `baselineDelta > 1.0`, styled `--status-cancelled`) |

- **Footer — deep-link buttons** (ghost button style, stacked vertically):
  - "View in HTTP Pipeline `\u25B8`" — always visible.
  - "View in Spark Sessions `\u25B8`" — only for `spark-gts`.
  - "View in Retries `\u25B8`" — only when `retryRate > 0`.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close panel → `panel.closing` |
| `Tab` | Cycle focus through deep-link buttons inside panel |
| `Shift+Tab` | Reverse focus cycle |
| `Enter` | Activate focused deep-link button → `panel.deep-link-navigating` |

**Data requirements:**
- Reads from `this._snapshot` in memory (no additional subscription).
- Edge data for the selected node: `this._edges.find(e => e.toId === nodeId)`.
- If no edge exists for this node (newly appeared, no traffic), display "No traffic observed" placeholder.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `close.click` / `escape` / `canvas.click.background` | `panel.closing` |
| `node.click(otherId)` / `edge.click(idx)` | `panel.switching-target` |
| `deeplink.click(tabId)` | `panel.deep-link-navigating` |
| `snapshot.received` (node still exists) | `panel.node-view.live-updating` |
| `snapshot.timeout` (> 3s) | `panel.node-view.stale` |
| `snapshot.received` (node removed) | `panel.node-disappeared` |
| `render.error` | `panel.error` |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- If `_edges.find()` returns `null` for the selected node, show "No traffic observed" message instead of empty metrics. Do not transition to error.

---

### 2.4 `panel.node-view.flt-center`

**Entry conditions:**
- User clicks or keyboard-selects the FLT center node (`flt-local`).

**Exit conditions:**
- Same as `panel.node-view` (close, switch, deactivate, disappear, stale, error).

**Visual description:**
- **Header:** "FLT (local)" — distinctive title.
- **Body — aggregate outbound health:**

| Label | Value |
|-------|-------|
| Outbound deps | `N active` (count of dependency nodes) |
| Worst health | `<badge>` showing the worst health among all edges |
| Total volume | Sum of all edge volumes |
| Total throughput | Sum of all `throughputPerMin` values |
| Active alerts | Count of active alerts, or "None" |

- Below the aggregate table: a **dependency summary list** — each dependency as a row with name, health badge, and p95 value. Sorted worst-health-first, then by p95 descending. Each row is clickable — clicking switches to that dependency's detail view.
- **Footer:** No deep-link buttons (FLT is not a single dependency to drill into). Instead, a note: "Click a dependency above to inspect."

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close panel |
| `Tab` / `Shift+Tab` | Cycle focus through dependency rows in the summary list |
| `Enter` | Select focused dependency → `panel.switching-target` → `panel.node-view` |

**Data requirements:**
- All edges from `this._edges` (iterate full array).
- All nodes from `this._nodes` for the dependency list.
- Alert count from `this._snapshot.alerts.length`.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `close` / `escape` / `background.click` | `panel.closing` |
| `depRow.click(depId)` | `panel.switching-target` → `panel.node-view` |
| `node.click(otherId)` / `edge.click(idx)` | `panel.switching-target` |
| `snapshot.received` | `panel.node-view.live-updating` (refreshes aggregate) |
| `snapshot.timeout` | `panel.node-view.stale` |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- If zero edges exist, show "No outbound traffic observed" with empty dependency list.

---

### 2.5 `panel.node-view.collapsed-group`

**Entry conditions:**
- User clicks or keyboard-selects the "Other (N)" aggregate node (`_other`).

**Exit conditions:**
- Same as `panel.node-view`.

**Visual description:**
- **Header:** "Other (N)" where N is `_collapsedCount`.
- **Body — scrollable collapsed dependency list:**
  - Each collapsed dependency as a compact row: name, health badge, p95 value, volume.
  - Sorted worst-health-first, then by volume descending.
  - Each row is clickable (no-op in V1 — collapsed deps are not individually selectable on graph, but the click is reserved for V2 expand-in-place).
- **Aggregate metrics** at the top:

| Label | Value |
|-------|-------|
| Health | Worst health among collapsed members |
| Total volume | Sum of collapsed volumes |
| Dependencies | Comma-separated list of collapsed dep names |

- **Footer:** No deep-link buttons.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close panel |
| `Tab` / `Shift+Tab` | Cycle focus through collapsed dependency rows |

**Data requirements:**
- `_other` node's `_collapsedIds` array.
- Full edge data for each collapsed dependency from `this._edges`.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `close` / `escape` / `background.click` | `panel.closing` |
| `node.click(otherId)` / `edge.click(idx)` | `panel.switching-target` |
| `snapshot.received` | `panel.node-view.live-updating` (refreshes list) |
| `snapshot.timeout` | `panel.node-view.stale` |
| `snapshot.received` (collapsed set changes) | Re-render list in-place |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- If `_collapsedIds` is empty (race condition — collapse threshold no longer exceeded), auto-close panel → `panel.closing`.

---

### 2.6 `panel.edge-view`

**Entry conditions:**
- User clicks an edge on the canvas (hit-tested within 8px of bezier path).

**Exit conditions:**
- Same as `panel.node-view`.

**Visual description:**
- **Header:** "flt-local `\u2192` {dependency display name}" (e.g., "FLT `\u2192` Spark (GTS)").
- **Body — per-edge metrics table** (identical fields to node view but scoped to this specific edge):

| Label | Value |
|-------|-------|
| Health | `<badge>` |
| Volume | Event count in window |
| p50 | Latency value |
| p95 | Latency value |
| p99 | Latency value |
| Error rate | Percentage |
| Retry rate | Percentage |
| Throughput | events/min |
| Baseline delta | `Nx above baseline` (if > 1.0) |

- **Footer — deep-link buttons:** Same logic as node view, keyed on the edge's `toId`.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close panel |
| `Tab` / `Shift+Tab` | Cycle deep-link buttons |
| `Enter` | Activate focused deep-link |

**Data requirements:**
- Single edge from `this._edges` at `_selectedEdge` index.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `close` / `escape` / `background.click` | `panel.closing` |
| `node.click(id)` / `edge.click(otherIdx)` | `panel.switching-target` |
| `deeplink.click(tabId)` | `panel.deep-link-navigating` |
| `snapshot.received` (edge still exists) | `panel.node-view.live-updating` |
| `snapshot.timeout` | `panel.node-view.stale` |
| `snapshot.received` (edge removed) | `panel.edge-disappeared` |
| `render.error` | `panel.error` |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- Edge index out of bounds after snapshot update: close panel → `panel.closing`.

---

### 2.7 `panel.node-view.live-updating`

**Entry conditions:**
- A new `nexus` snapshot arrives via SignalR while the panel is open in any content state (`panel.node-view`, `panel.node-view.flt-center`, `panel.node-view.collapsed-group`, `panel.edge-view`).
- This is a transient micro-state — the panel content is refreshed and the state returns to the originating content state within the same synchronous execution frame.

**Exit conditions:**
- Content refresh completes → return to originating content state.
- Selected node/edge no longer in snapshot → `panel.node-disappeared` / `panel.edge-disappeared`.

**Visual description:**
- No visible change from the user's perspective. Metrics table values update in-place (DOM innerHTML replacement). No flash or loading indicator — the 1 Hz refresh rate is smooth enough for static content replacement.
- If a metric value changed, the new value renders immediately. No animation on value change (matching existing `tab-http.js` pattern for request detail updates).

**Keyboard shortcuts:**
- Same as the originating content state. Refresh does not steal focus.

**Data requirements:**
- Fresh snapshot from `this._snapshot` (just updated by `_onSnapshot()`).
- Re-lookup the selected node/edge in the new snapshot data.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| Refresh complete, node exists | Return to originating content state |
| Refresh complete, node gone | `panel.node-disappeared` |
| Refresh complete, edge gone | `panel.edge-disappeared` |
| `render.error` during refresh | `panel.error` |

**Error recovery:**
- If `_refreshDetailContent()` throws, catch the exception, log a warning, and transition to `panel.error`. Do not leave stale content displayed with a silently broken refresh loop.

---

### 2.8 `panel.node-view.stale`

**Entry conditions:**
- No `nexus` snapshot received for > 3 seconds while panel is open in a content state.
- Detected by a `setInterval(3000)` watchdog started when the panel opens, cleared on close.

**Exit conditions:**
- A fresh snapshot arrives → clear stale badge, return to originating content state.
- User closes the panel → `panel.closing`.
- SignalR disconnects → `panel.error` (with connection-lost messaging).

**Visual description:**
- A stale indicator appears at the top of the panel body: a horizontal bar with `--status-cancelled` (amber) background, text "Data may be stale — no update for {N}s", monospace font.
- All existing metric values remain displayed but are visually dimmed (table `opacity: 0.6`).
- The stale timer text updates every second: "3s", "4s", "5s"... until a fresh snapshot arrives or the panel closes.

**Keyboard shortcuts:**
- Same as originating content state. Stale state does not block interaction.

**Data requirements:**
- Stale watchdog interval timer (`_staleTimer`).
- Last snapshot timestamp (`this._snapshot.generatedAt` or `_lastSnapshotTime`).

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `snapshot.received` | Return to originating content state (clear stale badge) |
| `close` / `escape` | `panel.closing` |
| `signalr.disconnected` | `panel.error` |
| `node.click(otherId)` | `panel.switching-target` |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- If the stale duration exceeds 30 seconds, escalate: change the bar color to `--status-failed` (red) and text to "Connection may be lost — no update for {N}s". This provides early visual triage before the SignalR reconnect machinery kicks in.

---

### 2.9 `panel.closing`

**Entry conditions:**
- User presses Escape while panel is open.
- User clicks `\u2715` close button.
- User clicks canvas background.
- Auto-close from `panel.node-disappeared` / `panel.edge-disappeared` after the grace message.
- Deep-link navigation closes the panel.

**Exit conditions:**
- CSS `transitionend` event on `transform` fires → `panel.closed`.
- Guard timer (300ms) forces close if `transitionend` doesn't fire.

**Visual description:**
- Panel slides out to the right: `transform: translateX(0)` → `translateX(100%)` over 150ms ease.
- `pointer-events: none` set immediately to prevent interaction during animation.
- Selection ring removed from canvas node/edge.
- `_selectedNode` / `_selectedEdge` cleared.

**Keyboard shortcuts:**
- All keyboard input ignored during closing animation.

**Data requirements:**
- None. Stale watchdog timer is cleared.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `transitionend` / guard timeout | `panel.closed` |
| `node.click(id)` (during animation) | Queue; after `panel.closed`, immediately enter `panel.opening` |
| `tab.deactivate` | `panel.closed` (instant, skip animation) |

**Error recovery:**
- Guard timer (300ms) ensures panel never gets stuck in closing state. If `transitionend` is swallowed (element removed, display:none race), the guard forces state to `panel.closed`.

---

### 2.10 `panel.deep-link-navigating`

**Entry conditions:**
- User clicks "View in HTTP Pipeline `\u25B8`", "View in Spark Sessions `\u25B8`", or "View in Retries `\u25B8`" deep-link button in the panel footer.
- User presses Enter on a focused deep-link button.

**Exit conditions:**
- Tab switch completes → `panel.closed` (the Nexus tab deactivates, which closes the panel).

**Visual description:**
- Clicked button gets a brief press state (standard `:active` CSS).
- Panel begins closing (slide-out animation starts).
- The `RuntimeView.switchTab(targetTab)` call fires immediately, which triggers `NexusTab.deactivate()`.
- From the user's perspective: the panel slides out and the target tab appears simultaneously.

**Keyboard shortcuts:**
- None — this is a transient state lasting < 200ms.

**Data requirements:**
- The deep-link button's `data-action` attribute determines the target tab: `'http'`, `'spark'`, or `'retries'`.
- Optional: a filter hint stored on `window.edogApp` for the target tab to pick up (e.g., URL pattern filter for HTTP tab).

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `switchTab` completes | `panel.closed` (via `tab.deactivate`) |
| `switchTab` fails (target tab not registered) | `panel.closing` (fall back to closing panel only, log warning) |

**Error recovery:**
- If `window.edogApp` or `runtimeView` is unavailable, log a warning and close the panel without navigating. The user sees the panel close but no tab switch.
- If the target tab is not registered, `RuntimeView.switchTab()` is a no-op per `runtime-view.js:130-170`. Panel still closes, and a warning is logged.

---

### 2.11 `panel.node-disappeared`

**Entry conditions:**
- A new snapshot arrives and the currently selected node is not present in `snapshot.nodes[]`.
- This can happen when a dependency stops receiving traffic and falls out of the aggregator's rolling window, or when an "Other" collapse boundary shifts.

**Exit conditions:**
- Auto-close after 2-second grace period → `panel.closing`.
- User clicks `\u2715` or presses Escape before the timer → `panel.closing`.
- User clicks a different node → `panel.switching-target`.

**Visual description:**
- Panel body content is replaced with a disappearance notice:
  - Icon: `\u25C6` (diamond) in `--text-muted`.
  - Title: "{Dependency name} is no longer active".
  - Subtitle: "This dependency has not been observed in the current window."
- Existing metrics are hidden. The notice occupies the full panel body.
- A subtle progress bar at the top of the notice fills over 2 seconds (CSS animation), then the panel auto-closes.
- Deep-link buttons are removed (no target to drill into).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close immediately (skip grace period) |

**Data requirements:**
- Last known display name of the disappeared node (cached from previous render).
- A `setTimeout(2000)` for auto-close.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| Grace timer (2s) | `panel.closing` |
| `escape` / `close.click` | `panel.closing` |
| `node.click(otherId)` | `panel.switching-target` |
| `snapshot.received` (node reappears) | `panel.node-view` (cancel grace timer, re-render) |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- If the node reappears in the very next snapshot (within the 2s grace), cancel the close timer and restore the panel with fresh data. This handles momentary data gaps.

---

### 2.12 `panel.edge-disappeared`

**Entry conditions:**
- A new snapshot arrives and the currently selected edge is not present in `snapshot.edges[]`.
- Semantically identical to `panel.node-disappeared` but for edge selection.

**Exit conditions:**
- Same as `panel.node-disappeared`.

**Visual description:**
- Same layout as `panel.node-disappeared` but with edge-specific messaging:
  - Title: "FLT `\u2192` {Dependency name} — no longer active".
  - Subtitle: "This traffic path has not been observed in the current window."
- Same 2-second grace period with progress bar.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close immediately |

**Data requirements:**
- Cached edge `from`/`to` display names.
- `setTimeout(2000)` for auto-close.

**Transitions:**
- Identical to `panel.node-disappeared`.

**Error recovery:**
- Same as `panel.node-disappeared`. Edge reappearance cancels close and re-renders.

---

### 2.13 `panel.error`

**Entry conditions:**
- `_openNodeDetail()` or `_refreshDetailContent()` throws an uncaught exception.
- SignalR disconnects while panel is open (connection lost).
- Snapshot data is malformed and cannot be parsed for the selected node.

**Exit conditions:**
- User clicks `\u2715` or presses Escape → `panel.closing`.
- SignalR reconnects and a fresh snapshot arrives → return to originating content state.
- User clicks a different node → `panel.switching-target`.

**Visual description:**
- Panel body replaced with error content:
  - Icon: `\u26A0` in `--status-failed`.
  - Title (render error): "Failed to display details".
  - Title (connection lost): "Connection lost".
  - Subtitle (render error): "An error occurred rendering panel content."
  - Subtitle (connection lost): "Reconnecting..." with the standard `rt-conn-dot` pulse indicator.
- Close button remains functional.
- Deep-link buttons hidden.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close panel |

**Data requirements:**
- Error type discriminator: `'render'` or `'connection'`.
- For connection errors, reads `this._signalr.status`.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `escape` / `close.click` | `panel.closing` |
| `signalr.reconnected` + `snapshot.received` | Return to content state (if selected node still valid) |
| `signalr.reconnected` + node gone | `panel.node-disappeared` |
| `node.click(otherId)` | `panel.switching-target` |
| `tab.deactivate` | `panel.closed` |

**Error recovery:**
- Render errors are caught with `try/catch` around `_openNodeDetail()` / `_refreshDetailContent()`. The error state is always recoverable by closing and reopening.
- Connection errors self-recover via SignalR's auto-reconnect schedule (`[0, 1000, 2000, 5000, 10000, 30000]` ms). On reconnect, the `SubscribeToTopic` stream replays the snapshot buffer, which triggers `_onSnapshot()` and restores live data.

---

### 2.14 `panel.switching-target`

**Entry conditions:**
- Panel is open in any content state, and the user clicks a different node or edge.
- FLT center view: user clicks a dependency row in the summary list.

**Exit conditions:**
- Content swap completes → enter the appropriate content state for the new target.

**Visual description:**
- No close/reopen animation. Panel stays open in place.
- Panel header title updates to the new target's display name.
- Panel body content is replaced with the new target's metrics (instant DOM swap, no transition).
- Canvas selection ring moves to the new node/edge.
- If switching from node to edge or vice versa, the body layout may change (edge shows "from `\u2192` to" header format).

**Keyboard shortcuts:**
- Same as destination content state (inherited immediately).

**Data requirements:**
- New target's data from `this._snapshot`.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| Content rendered for dep node | `panel.node-view` |
| Content rendered for flt-local | `panel.node-view.flt-center` |
| Content rendered for _other | `panel.node-view.collapsed-group` |
| Content rendered for edge | `panel.edge-view` |
| `render.error` | `panel.error` |

**Error recovery:**
- If the new target's data is missing, fall back to `panel.error` rather than showing empty content.

---

### 2.15 `panel.keyboard-focus`

**Entry conditions:**
- Panel is open in a content state, and the user presses `Tab` to move focus into the panel's deep-link buttons or interactive elements.
- This is an orthogonal focus state that overlays any content state.

**Exit conditions:**
- `Escape` pressed → close panel (`panel.closing`), return focus to canvas.
- Focus leaves the panel (click on canvas, `Shift+Tab` past first element).
- Panel closes for any reason.

**Visual description:**
- Standard browser focus ring (`:focus-visible`) on the currently focused button.
- Deep-link buttons show focus outline using `outline: 2px solid var(--accent); outline-offset: 2px`.
- Close button is also focusable and shows the same focus ring.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Tab` | Move focus to next button |
| `Shift+Tab` | Move focus to previous button; if at first button, focus leaves panel |
| `Enter` / `Space` | Activate focused button |
| `Escape` | Close panel, return focus to canvas |

**Data requirements:**
- Standard DOM focus management. No additional data.

**Transitions:**
| Trigger | Target State |
|---------|-------------|
| `escape` | `panel.closing` |
| `enter` on deep-link | `panel.deep-link-navigating` |
| Focus leaves panel | Return to parent content state (focus ring removed) |

**Error recovery:**
- Focus trap is not enforced (panel is not a modal). If focus escapes, the panel remains open and functional.

---

## 3. Transition Table

Complete directed graph of all state transitions:

```
panel.closed
  ├─[node.click(dep)]──────────→ panel.opening
  ├─[node.click(flt-local)]────→ panel.opening
  ├─[node.click(_other)]───────→ panel.opening
  ├─[edge.click(idx)]──────────→ panel.opening
  └─[keyboard.enter]───────────→ panel.opening

panel.opening
  ├─[transitionend(dep)]───────→ panel.node-view
  ├─[transitionend(flt)]───────→ panel.node-view.flt-center
  ├─[transitionend(other)]─────→ panel.node-view.collapsed-group
  ├─[transitionend(edge)]──────→ panel.edge-view
  ├─[escape]───────────────────→ panel.closing
  ├─[tab.deactivate]───────────→ panel.closed
  └─[guard.timeout(300ms)]─────→ (content state, forced)

panel.node-view
  ├─[close/escape/bg.click]────→ panel.closing
  ├─[node.click/edge.click]────→ panel.switching-target
  ├─[deeplink.click]───────────→ panel.deep-link-navigating
  ├─[snapshot.received(ok)]────→ panel.node-view.live-updating
  ├─[snapshot.timeout(3s)]─────→ panel.node-view.stale
  ├─[snapshot.node-removed]────→ panel.node-disappeared
  ├─[render.error]─────────────→ panel.error
  ├─[tab.deactivate]───────────→ panel.closed
  └─[tab.focus-enter]──────────→ panel.keyboard-focus (overlay)

panel.node-view.flt-center
  ├─[close/escape/bg.click]────→ panel.closing
  ├─[depRow.click/node/edge]───→ panel.switching-target
  ├─[snapshot.received(ok)]────→ panel.node-view.live-updating
  ├─[snapshot.timeout(3s)]─────→ panel.node-view.stale
  ├─[render.error]─────────────→ panel.error
  └─[tab.deactivate]───────────→ panel.closed

panel.node-view.collapsed-group
  ├─[close/escape/bg.click]────→ panel.closing
  ├─[node.click/edge.click]────→ panel.switching-target
  ├─[snapshot.received(ok)]────→ panel.node-view.live-updating
  ├─[snapshot.timeout(3s)]─────→ panel.node-view.stale
  ├─[collapsed-set-empty]──────→ panel.closing
  ├─[render.error]─────────────→ panel.error
  └─[tab.deactivate]───────────→ panel.closed

panel.edge-view
  ├─[close/escape/bg.click]────→ panel.closing
  ├─[node.click/edge.click]────→ panel.switching-target
  ├─[deeplink.click]───────────→ panel.deep-link-navigating
  ├─[snapshot.received(ok)]────→ panel.node-view.live-updating
  ├─[snapshot.timeout(3s)]─────→ panel.node-view.stale
  ├─[snapshot.edge-removed]────→ panel.edge-disappeared
  ├─[render.error]─────────────→ panel.error
  └─[tab.deactivate]───────────→ panel.closed

panel.node-view.live-updating
  ├─[refresh.complete(ok)]─────→ (return to originating content state)
  ├─[refresh.node-gone]────────→ panel.node-disappeared
  ├─[refresh.edge-gone]────────→ panel.edge-disappeared
  └─[render.error]─────────────→ panel.error

panel.node-view.stale
  ├─[snapshot.received]────────→ (return to originating content state)
  ├─[close/escape]─────────────→ panel.closing
  ├─[signalr.disconnected]─────→ panel.error
  ├─[node.click/edge.click]────→ panel.switching-target
  └─[tab.deactivate]───────────→ panel.closed

panel.closing
  ├─[transitionend/guard]──────→ panel.closed
  ├─[node.click(queued)]───────→ panel.closed → panel.opening (chained)
  └─[tab.deactivate]───────────→ panel.closed (instant)

panel.deep-link-navigating
  ├─[switchTab.complete]───────→ panel.closed (via tab.deactivate)
  └─[switchTab.fail]───────────→ panel.closing

panel.node-disappeared
  ├─[grace.timeout(2s)]────────→ panel.closing
  ├─[escape/close.click]───────→ panel.closing
  ├─[node.click(otherId)]──────→ panel.switching-target
  ├─[snapshot.node-reappears]──→ panel.node-view
  └─[tab.deactivate]───────────→ panel.closed

panel.edge-disappeared
  ├─[grace.timeout(2s)]────────→ panel.closing
  ├─[escape/close.click]───────→ panel.closing
  ├─[node.click(otherId)]──────→ panel.switching-target
  ├─[snapshot.edge-reappears]──→ panel.edge-view
  └─[tab.deactivate]───────────→ panel.closed

panel.error
  ├─[escape/close.click]───────→ panel.closing
  ├─[signalr.reconnect+snap]───→ (content state, if node valid)
  ├─[node.click(otherId)]──────→ panel.switching-target
  └─[tab.deactivate]───────────→ panel.closed

panel.switching-target
  ├─[render.complete(dep)]─────→ panel.node-view
  ├─[render.complete(flt)]─────→ panel.node-view.flt-center
  ├─[render.complete(other)]───→ panel.node-view.collapsed-group
  ├─[render.complete(edge)]────→ panel.edge-view
  └─[render.error]─────────────→ panel.error

panel.keyboard-focus (overlay — active concurrently with content states)
  ├─[escape]───────────────────→ panel.closing
  ├─[enter on deeplink]────────→ panel.deep-link-navigating
  └─[focus.leave]──────────────→ (parent content state, overlay removed)
```

---

## 4. State Diagram

```
                          ┌────────────────────────────────────┐
                          │           panel.closed             │
                          └───┬──────┬──────┬──────┬───────────┘
                    node.click│edge  │flt   │_other│keyboard.enter
                              │.click│.click │.click│
                              ▼      ▼      ▼      ▼
                          ┌────────────────────────────────────┐
                          │          panel.opening             │
                          │     (150ms CSS transition)         │
                          └───┬──────┬──────┬──────┬───────────┘
                   transitionend per target type     escape│
                              │      │      │      │       │
              ┌───────────────┼──────┼──────┤      │       ▼
              ▼               ▼      ▼      ▼      │  panel.closing
    ┌─────────────┐  ┌────────────┐ ┌──────────┐ ┌─┴──────────┐
    │ node-view   │  │ flt-center │ │collapsed │ │ edge-view  │
    │ (dep)       │  │            │ │ -group   │ │            │
    └──┬──┬──┬──┬─┘  └──┬──┬──┬──┘ └──┬──┬──┬─┘ └──┬──┬──┬──┘
       │  │  │  │        │  │  │       │  │  │       │  │  │
       │  │  │  │  snapshot.received (1 Hz)  │       │  │  │
       │  │  │  ▼────────┼──┼──┼───────┼──┼──┼───────┼──┼──▼
       │  │  │  ┌────────┴──┴──┴───────┴──┴──┴───────┴──┴──┐
       │  │  │  │      panel.node-view.live-updating        │
       │  │  │  │  (transient: refresh content, return)     │
       │  │  │  └──┬───────────────┬────────────────────────┘
       │  │  │     │ok             │node/edge gone
       │  │  │     ▼               ▼
       │  │  │  (origin)   ┌──────────────────┐
       │  │  │             │ node-disappeared  │──2s──▶ panel.closing
       │  │  │             │ edge-disappeared  │
       │  │  │             └──────────────────┘
       │  │  │                     ▲ reappears → content state
       │  │  │
       │  │  │>3s no snapshot
       │  │  ▼
       │  │  ┌─────────────────┐
       │  │  │ node-view.stale │──snapshot──▶ (origin)
       │  │  └────────┬────────┘
       │  │           │disconnect
       │  │           ▼
       │  │  ┌─────────────────┐
       │  │  │  panel.error    │──reconnect──▶ (content state)
       │  │  └────────┬────────┘
       │  │           │escape/close
       │  │           ▼
       │  │      panel.closing ──transitionend──▶ panel.closed
       │  │
       │  │deeplink.click
       │  ▼
       │  ┌──────────────────────┐
       │  │ deep-link-navigating │──switchTab──▶ panel.closed
       │  └──────────────────────┘
       │
       │node.click(other) / edge.click(other)
       ▼
    ┌─────────────────────┐
    │ switching-target    │──render──▶ (content state)
    │ (no animation)      │
    └─────────────────────┘
```

---

## 5. Event Inventory

All events that the detail panel must handle:

| # | Event ID | Source | Description |
|---|----------|--------|-------------|
| E1 | `node.click(depId)` | Canvas hit-test | User clicks a standard dependency node |
| E2 | `node.click('flt-local')` | Canvas hit-test | User clicks the FLT center node |
| E3 | `node.click('_other')` | Canvas hit-test | User clicks the collapsed "Other" aggregate node |
| E4 | `edge.click(edgeIdx)` | Canvas hit-test | User clicks an edge (within 8px hit zone) |
| E5 | `canvas.click.background` | Canvas hit-test (miss) | User clicks empty canvas area |
| E6 | `close.click` | DOM event | User clicks the `\u2715` close button |
| E7 | `keyboard.escape` | `keydown` | User presses Escape |
| E8 | `keyboard.enter` | `keydown` | User presses Enter (with a keyboard-selected node) |
| E9 | `keyboard.tab` | `keydown` | User presses Tab (cycle nodes or panel buttons) |
| E10 | `deeplink.click(tabId)` | DOM event delegation | User clicks a deep-link button |
| E11 | `snapshot.received` | `_onSnapshot()` | New nexus snapshot from SignalR (node/edge present) |
| E12 | `snapshot.node-removed` | `_onSnapshot()` diff | Selected node missing from new snapshot |
| E13 | `snapshot.edge-removed` | `_onSnapshot()` diff | Selected edge missing from new snapshot |
| E14 | `snapshot.node-reappears` | `_onSnapshot()` diff | Disappeared node found again in snapshot |
| E15 | `snapshot.edge-reappears` | `_onSnapshot()` diff | Disappeared edge found again in snapshot |
| E16 | `snapshot.timeout` | Stale watchdog timer | > 3s since last snapshot |
| E17 | `signalr.disconnected` | `signalr-manager.js` | SignalR connection lost |
| E18 | `signalr.reconnected` | `signalr-manager.js` | SignalR connection restored |
| E19 | `transitionend` | CSS transition | Panel slide animation completed |
| E20 | `tab.deactivate` | `NexusTab.deactivate()` | Nexus tab switched away / destroyed |
| E21 | `render.error` | try/catch in render methods | DOM render or data parse failure |
| E22 | `depRow.click(depId)` | DOM event (FLT center view) | User clicks a dependency row in FLT summary list |
| E23 | `guard.timeout` | setTimeout(300ms) | Transition guard timer fires |
| E24 | `grace.timeout` | setTimeout(2000ms) | Disappearance grace period expires |

---

## 6. Full State x Event Matrix

Every cell defines what happens when event E occurs in state S. `\u2014` means the event is impossible or irrelevant in that state.

| State \ Event | E1 node.click(dep) | E2 node.click(flt) | E3 node.click(other) | E4 edge.click | E5 bg.click | E6 close.click | E7 escape |
|---------------|-------|-------|-------|-------|-------|-------|-------|
| **closed** | → opening | → opening | → opening | → opening | — | — | Deselect node |
| **opening** | Queue | Queue | Queue | Queue | — | — | → closing |
| **node-view** | → switching | → switching | → switching | → switching | → closing | → closing | → closing |
| **flt-center** | → switching | — (already flt) | → switching | → switching | → closing | → closing | → closing |
| **collapsed** | → switching | → switching | — (already other) | → switching | → closing | → closing | → closing |
| **edge-view** | → switching | → switching | → switching | → switching (if diff) | → closing | → closing | → closing |
| **live-updating** | Defer until refresh done | Defer | Defer | Defer | Defer | Defer | Defer |
| **stale** | → switching | → switching | → switching | → switching | → closing | → closing | → closing |
| **closing** | Queue for after closed | Queue | Queue | Queue | — | — | — |
| **deep-link-nav** | — (transient) | — | — | — | — | — | — |
| **node-disappeared** | → switching | → switching | → switching | → switching | → closing | → closing | → closing |
| **edge-disappeared** | → switching | → switching | → switching | → switching | → closing | → closing | → closing |
| **error** | → switching | → switching | → switching | → switching | → closing | → closing | → closing |
| **switching** | Queue | Queue | Queue | Queue | — | — | → closing |
| **keyboard-focus** | → switching | → switching | → switching | → switching | → closing | → closing | → closing |

| State \ Event | E8 enter | E9 tab | E10 deeplink | E11 snap.ok | E12 snap.node-rm | E13 snap.edge-rm | E16 snap.timeout |
|---------------|-------|-------|-------|-------|-------|-------|-------|
| **closed** | → opening (if node selected) | Cycle nodes | — | — | — | — | — |
| **opening** | — | — | — | Update pending data | — | — | — |
| **node-view** | — | Focus panel buttons | → deep-link-nav | → live-updating | → node-disappeared | — | → stale |
| **flt-center** | — | Focus dep rows | — | → live-updating | — | — | → stale |
| **collapsed** | — | Focus dep rows | — | → live-updating | — | — | → stale |
| **edge-view** | — | Focus panel buttons | → deep-link-nav | → live-updating | — | → edge-disappeared | → stale |
| **live-updating** | — | — | — | Coalesce (skip) | → node-disappeared | → edge-disappeared | — |
| **stale** | — | Focus panel buttons | → deep-link-nav | → clear stale, content | — | — | Update stale counter |
| **closing** | — | — | — | — | — | — | — |
| **deep-link-nav** | — | — | — | — | — | — | — |
| **node-disappeared** | — | — | — | E14 check reappear | — | — | — |
| **edge-disappeared** | — | — | — | E15 check reappear | — | — | — |
| **error** | — | — | — | → content (if reconnect) | — | — | — |
| **switching** | — | — | — | Queue | — | — | — |
| **keyboard-focus** | Activate focused btn | Next button | → deep-link-nav | (parent handles) | (parent handles) | (parent handles) | (parent handles) |

| State \ Event | E17 signalr.disconn | E18 signalr.reconn | E19 transitionend | E20 tab.deactivate | E21 render.error | E22 depRow.click | E23/E24 guard/grace |
|---------------|-------|-------|-------|-------|-------|-------|-------|
| **closed** | — | — | — | — (no-op) | — | — | — |
| **opening** | — | — | → content state | → closed (instant) | → error | — | E23: force → content |
| **node-view** | → error | — | — | → closed | → error | — | — |
| **flt-center** | → error | — | — | → closed | → error | → switching | — |
| **collapsed** | → error | — | — | → closed | → error | — | — |
| **edge-view** | → error | — | — | → closed | → error | — | — |
| **live-updating** | → error | — | — | → closed | → error | — | — |
| **stale** | → error | — | — | → closed | — | — | — |
| **closing** | — | — | → closed | → closed (instant) | — | — | E23: force → closed |
| **deep-link-nav** | → closing | — | — | → closed | — | — | — |
| **node-disappeared** | → error | — | — | → closed | — | — | E24: → closing |
| **edge-disappeared** | → error | — | — | → closed | — | — | E24: → closing |
| **error** | — (already error) | Check snap → content | — | → closed | — | — | — |
| **switching** | → error | — | — | → closed | → error | — | — |
| **keyboard-focus** | (parent: → error) | — | — | → closed | — | — | — |

---

## 7. Error Recovery Matrix

| Error Condition | Affected States | Recovery Strategy | User-Visible Effect |
|----------------|----------------|-------------------|---------------------|
| **DOM render exception** | Any content state, `switching-target` | `try/catch` around `_openNodeDetail()` / `_refreshDetailContent()`. Transition to `panel.error`. | Error notice in panel body. Close button works. |
| **Missing edge data** | `node-view`, `edge-view` | If `this._edges.find()` returns null, show "No traffic observed" placeholder. Do NOT transition to error. | Graceful degradation — panel open, placeholder text. |
| **Malformed snapshot** | `live-updating` | If `data.nodes` is missing/malformed, skip the refresh. Log warning. Do not update panel content. | Previous metric values persist. No visible disruption. |
| **SignalR disconnect** | All open states | Transition to `panel.error` with "Connection lost" messaging. Auto-recover when reconnect fires and a fresh snapshot arrives. | Amber/red notice. Auto-recovers. |
| **SignalR reconnect burst** | `error`, `stale` | `_onSnapshot()` is idempotent. Multiple rapid snapshots coalesce via RAF. First valid snapshot clears the error/stale state. | Smooth recovery, no flicker. |
| **CSS transition not firing** | `opening`, `closing` | Guard timer (300ms) forces state advancement. Panel never gets stuck. | Imperceptible — guard fires only if CSS is broken. |
| **Node reappears during grace** | `node-disappeared` | Cancel `setTimeout(2000)`, re-render panel with fresh data. | Panel "recovers" — disappearance notice replaced with metrics. |
| **Stale > 30s** | `stale` | Escalate badge from amber to red. Text changes to "Connection may be lost". | More urgent visual, hints at deeper issue. |
| **Deep-link target tab missing** | `deep-link-navigating` | `RuntimeView.switchTab()` is no-op for missing tabs. Panel closes, warning logged. | Panel closes, no tab switch. User stays on Nexus. |
| **Double activate()** | All states | `this._active` flag guards against double subscription. Second activate is no-op. | None. |
| **Collapsed set empties** | `collapsed-group` | If `_collapsedIds` becomes empty mid-view (threshold shift), auto-close panel. | Panel closes. User can click a new node. |
| **Keyboard focus + panel close** | `keyboard-focus` | Focus returns to canvas element. Panel DOM hidden via `pointer-events: none`. | Clean focus restoration. |

---

## Appendix A: Implementation Mapping

| State | Primary Method(s) in `tab-nexus.js` |
|-------|-------------------------------------|
| `panel.closed` | `_closeDetail()` final state |
| `panel.opening` | `_openNodeDetail()` / `_openEdgeDetail()` — `classList.remove('closed')` |
| `panel.node-view` | `_openNodeDetail(depId)` → `_renderMetricsTable()` + `_renderDeepLinks()` |
| `panel.node-view.flt-center` | `_openNodeDetail('flt-local')` → `_renderFltCenterView()` |
| `panel.node-view.collapsed-group` | `_openNodeDetail('_other')` → `_renderCollapsedList()` |
| `panel.edge-view` | `_openEdgeDetail(edgeIdx)` → `_renderMetricsTable()` + `_renderDeepLinks()` |
| `panel.node-view.live-updating` | `_refreshDetailContent()` called from `_onSnapshot()` |
| `panel.node-view.stale` | `_onStaleCheck()` via `setInterval(3000)` |
| `panel.closing` | `_closeDetail()` — `classList.add('closed')` |
| `panel.deep-link-navigating` | `_onDeepLinkClick()` → `_closeDetail()` + `runtimeView.switchTab()` |
| `panel.node-disappeared` | `_onSnapshot()` diff detects removal → `_showDisappearanceNotice()` |
| `panel.edge-disappeared` | `_onSnapshot()` diff detects removal → `_showDisappearanceNotice()` |
| `panel.error` | `_showPanelError(type)` |
| `panel.switching-target` | `_openNodeDetail(newId)` / `_openEdgeDetail(newIdx)` while panel already open |
| `panel.keyboard-focus` | Standard DOM focus management — no custom method needed |

## Appendix B: CSS Classes by State

| State | `nexus-detail` class list |
|-------|---------------------------|
| `panel.closed` | `nexus-detail closed` |
| `panel.opening` | `nexus-detail` (closed removed, transition runs) |
| `panel.node-view` | `nexus-detail` |
| `panel.node-view.stale` | `nexus-detail stale` |
| `panel.closing` | `nexus-detail closed` (added, transition runs) |
| `panel.error` | `nexus-detail error` |
| `panel.node-disappeared` | `nexus-detail disappeared` |

## Appendix C: Timer Inventory

| Timer | Duration | Purpose | Start | Clear |
|-------|----------|---------|-------|-------|
| Stale watchdog | 3000ms (interval) | Detect snapshot gap | Panel opens | Panel closes, snapshot received |
| Grace close | 2000ms (timeout) | Auto-close after node/edge disappearance | `_showDisappearanceNotice()` | Escape, node reappears, manual close |
| Transition guard | 300ms (timeout) | Prevent stuck transitions | `classList.remove/add('closed')` | `transitionend` fires |
| Stale escalation | 30000ms (from first stale) | Upgrade stale badge to red | First stale detection | Snapshot received, panel closes |
