# F28 — Traffic List State Matrix

> **Component:** Traffic List Panel (left side of the HTTP MITM tab)
> **Feature:** F28 HTTP MITM (simplified scope: MITM + Send to Playground)
> **Author:** Pixel
> **Phase:** P3 — State Matrices
> **Surface:** `src/frontend/js/tab-http.js` extensions, `src/frontend/css/tab-http.css` extensions
> **Sources:** C04 §1–§3, P0 §1.6 / §2.1, mock `http-mitm.html` (footer + ctxMenu + REQUESTS array)

---

## 0. Scope

The Traffic List is the left-hand pane that owns:

- The **toolbar** strip (intercept toggle, status badge, filter bar, method/status pills, clear/export).
- The **table viewport** with rows for every captured HTTP request.
- The **right-click context-menu trigger** (the menu itself has its own state matrix in `context-menu.md`).
- Per-row state badges (PAUSED / MODIFIED / BLOCKED / FORGED / DELAYED / REPLAYED) and the keyboard navigation that operates on them.

It does **not** own the detail panel (see `detail-panel.md`) or the context menu's internal states (see `context-menu.md`). It DOES own the gestures that *open* both (row click, right-click).

State IDs use dotted hierarchy: `list.<area>.<state>` — toolbar states are `list.toolbar.*`, table states are `list.table.*`, intercept-toggle states are `list.intercept.*`, filter-bar states are `list.filter.*`, selection states are `list.select.*`. Together they form an orthogonal product machine (a row can be selected AND hovered AND right-clicked while the toolbar toggle is ON and the filter is active).

---

## 1. State Map (orthogonal regions)

```
┌─ list.intercept ──────────────────────────────────────────────────────┐
│   off  →  armed  →  active.paused-pending  →  off (kill switch)       │
│                  ↘  active.idle                                        │
└────────────────────────────────────────────────────────────────────────┘
┌─ list.filter ─────────────────────────────────────────────────────────┐
│   empty  →  active  →  no-results  →  empty (clear)                   │
└────────────────────────────────────────────────────────────────────────┘
┌─ list.table ──────────────────────────────────────────────────────────┐
│   idle  →  streaming  →  filtered  →  empty-after-filter              │
│        ↘  disconnected  ↗                                              │
└────────────────────────────────────────────────────────────────────────┘
┌─ list.select ─────────────────────────────────────────────────────────┐
│   none  →  row-hovered  →  row-selected  →  multi-select               │
│                        ↘  row-context-menu                             │
│                        ↘  row-paused (lifecycle state, not gesture)    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Intercept-Toggle States (`list.intercept.*`)

### 2.1 `list.intercept.off`

- **Entry conditions:** Default at tab construction; capabilities pending or `MitmGetCapabilities.enabled=true` but user has never toggled; explicit toggle-off click; kill-switch (`Ctrl+Shift+K`) just fired.
- **Exit conditions:** User clicks toggle and RPC `MitmSetIntercept(true)` succeeds; `mitm` topic broadcasts `{type:"intercept-state", enabled:true}` from another tab.
- **Visual:**
  ```
  [ ○ Intercept: OFF ]   ghost pill · border-bright · text-dim · no glow
  ```
  Companion status badge `Rules: 0 · Paused: 0` shown at 60% opacity.
- **Keyboard shortcuts:** None active for intercept-mode (b/r/f are inert per C04 §7.1 guard `if (!this._interceptOn && !this._mitmStats.rules) return`). `Ctrl+Shift+K` still works (clears nothing but is a safe no-op).
- **Data requirements:** `http` topic subscription active (passive capture continues). `mitm` topic subscription active but no inbound events expected.
- **Transitions:**
  - `click toggle` → `list.intercept.armed` (optimistic flip; rolls back on RPC error).
  - `MitmGetCapabilities.enabled === false` → `list.intercept.unavailable`.
  - `signalr disconnect` → `list.intercept.offline`.
- **Error recovery:** RPC failure flips back to `off` with toast `"Failed to enable intercept: {err}"`. No state corruption — `this._interceptOn` mirrors authoritative server state via `_updateInterceptUi()`.

### 2.2 `list.intercept.armed`

- **Entry conditions:** Successful `MitmSetIntercept(true)` RPC; OR reconnect-reconciliation observed rules > 0 server-side.
- **Exit conditions:** Click toggle → off; kill switch; capabilities revoked.
- **Visual:**
  ```
  [ ● Intercept: ON ]   accent fill · accent-glow halo · 2.4s breath pulse
  ```
  Status badge transitions from dim → full opacity. If `_mitmStats.rules === 0`, empty-state hint appears in table footer: *"Intercept armed — first matching request will pause."*
- **Keyboard shortcuts:** `b` toggle-block-on-selected, `r` replay-selected, `f` forge-on-selected, `Ctrl+Shift+K` kill switch.
- **Data requirements:** Both `http` and `mitm` topic subscriptions live; frontend listens for `breakpoint-hit` events.
- **Transitions:**
  - `mitm` event `breakpoint-hit` arrives → `list.intercept.active.paused-pending` (paused count ≥ 1).
  - `mitm` event `rule-added` → stays in `armed`; status badge increments.
  - Click toggle → optimistic flip to `off`.
  - `signalr disconnect` → `list.intercept.offline` (toggle locked, label `Intercept: OFFLINE`).
- **Error recovery:** If pulse animation throws (browser quirk), CSS `@media (prefers-reduced-motion)` fallback kicks in — visual reduces to static accent fill, behavior unchanged.

### 2.3 `list.intercept.active.idle`

- **Entry conditions:** `armed` + `_mitmStats.rules >= 1` + `_mitmStats.paused === 0`.
- **Exit conditions:** Paused count goes ≥ 1; rules count drops to 0; toggle off.
- **Visual:** Same as armed but status badge shows `Rules: N · Paused: 0` (paused span at 50% opacity, no amber pulse).
- **Keyboard shortcuts:** Full intercept-mode set (`b`/`r`/`f`/`Ctrl+Shift+K`).
- **Data requirements:** Both topics. UI awaits `breakpoint-hit`.
- **Transitions:**
  - `breakpoint-hit` → `list.intercept.active.paused-pending`.
  - Last `rule-removed` → `armed` (no-rules variant).
- **Error recovery:** None — terminal observation state.

### 2.4 `list.intercept.active.paused-pending`

- **Entry conditions:** `mitm` topic `breakpoint-hit` event with new `interceptId`; `_mitmStats.paused++`.
- **Exit conditions:** `breakpoint-resolved` for that ID (paused decremented); `MitmKillSwitch()` invoked.
- **Visual:**
  ```
  [ ● Intercept: ON ]  [ Rules: 3 · Paused: 1 ]
                                  ▲ amber border · 1.6s pulse
  ```
  Newly paused row tinted amber in the table (`http-row-paused`). If table is auto-scroll-locked-to-tail and paused row was newly appended, scroll-to-paused is suppressed (don't scroll users away from a row they're inspecting).
- **Keyboard shortcuts:** Same as armed. Additionally: if the paused row is the selected row, `Enter` forwards (delegated to detail panel handler).
- **Data requirements:** Both topics. `_pausedSnapshots` Map populated by full snapshot delivered in `breakpoint-hit` payload.
- **Transitions:**
  - `breakpoint-resolved` for last paused intercept + paused goes 0 → `list.intercept.active.idle`.
  - Toggle off → `list.intercept.off` (but C01 server-side cancels pending breakpoints; UI shows toast "Intercept off — 1 paused request resumed untouched").
  - `Ctrl+Shift+K` → `list.intercept.off` + toast `"Killed N rules, resumed M paused."`.
- **Error recovery:** If `breakpoint-resolved` arrives for an unknown `interceptId`, log warning, decrement defensively (clamped at 0), no UI break. If `_pausedSnapshots` exceeds 50 entries (defensive cap), evict oldest with a toast `"50 paused requests — auto-forwarding oldest."` and invoke `MitmResume(oldestId, "forward")`.

### 2.5 `list.intercept.offline`

- **Entry conditions:** `signalr-manager` emits disconnect; `_interceptOn` snapshotted before disconnect.
- **Exit conditions:** SignalR `reconnected` event fires AND `MitmListRules()` reconciliation completes.
- **Visual:**
  ```
  [ ⊗ Intercept: OFFLINE ]   opacity 0.4 · cursor not-allowed
  ```
  Status badge greyed; row badges already on rows persist but new events do not arrive. Top-of-table banner: *"Disconnected — captured requests preserved, intercept paused."*
- **Keyboard shortcuts:** All intercept shortcuts no-op (click handlers early-return on disconnected).
- **Data requirements:** No live subscriptions. Ring buffer (2000 rows) retained client-side per C04 §9.3.
- **Transitions:**
  - `reconnected` → re-invoke `MitmListRules()` + `MitmListPaused()`. If rules count > 0 → `armed` (with flash-then-pulse `attention-pulse` animation per C04 §1.1 reconnect). Else → `off`.
  - User closes tab while offline → no exit; state discarded.
- **Error recovery:** If reconnect succeeds but `MitmListRules` fails, surface toast `"Reconnected; failed to reconcile rules — toggling Intercept will reset."` and remain in `offline` style until the user explicitly toggles.

### 2.6 `list.intercept.unavailable`

- **Entry conditions:** `MitmGetCapabilities()` returns `enabled:false` (env var `EDOG_MITM_INTERACTIVE` unset).
- **Exit conditions:** Tab destruction (re-eval requires page reload).
- **Visual:** Toggle replaced by a dim non-interactive pill `[ MITM not enabled ]` with tooltip *"Set EDOG_MITM_INTERACTIVE=1 to enable."*
- **Keyboard shortcuts:** All MITM shortcuts inert. `Ctrl+/`, `j/k`, `Esc` still work for base HTTP tab navigation.
- **Data requirements:** `http` topic only. `mitm` topic subscription not opened (C04 §0 gating).
- **Transitions:** None within the session.
- **Error recovery:** None applicable — this is a terminal gating state.

---

## 3. Filter-Bar States (`list.filter.*`)

### 3.1 `list.filter.empty`

- **Entry conditions:** Tab construction; user clears filter pills or search input; click `[Clear]`.
- **Exit conditions:** Search input receives ≥1 char; method/status pill toggled non-default; duration slider moved off 60s default; click status badge to apply MITM virtual filter.
- **Visual:**
  ```
  [🔍 Filter URLs…]  │ All GET POST PUT DEL PATCH │ All 2xx 4xx 5xx │ …
   placeholder dim                  ▲ "All" highlighted by default
  ```
  Filter badge hidden (`display:none`).
- **Keyboard shortcuts:** `Ctrl+/` focuses search input (existing behavior, preserved).
- **Data requirements:** None beyond table subscription.
- **Transitions:** → `list.filter.active` on first filter mutation.
- **Error recovery:** N/A.

### 3.2 `list.filter.active`

- **Entry conditions:** Any filter predicate diverges from default (search non-empty, method pill set, status pill set, duration slider moved, status badge filter active).
- **Exit conditions:** All filters reset to defaults; click `[Clear]`.
- **Visual:**
  - Active pills highlighted with `--accent-hover` background.
  - Filter badge appears: `[ 3 filters ✕ ]` next to row count, click-to-clear.
  - Row count updates to `142 / 1847 requests` (visible / total).
- **Keyboard shortcuts:** `Esc` while search input focused → clears search only (not all filters).
- **Data requirements:** Filtering is client-side over the in-memory ring buffer.
- **Transitions:**
  - All predicates revert → `list.filter.empty`.
  - Filtered result set === 0 → `list.filter.no-results`.
- **Error recovery:** Filter parser errors (invalid regex if added later) are caught; pill stays active but the offending predicate is bypassed with a small inline `!` warning glyph.

### 3.3 `list.filter.no-results`

- **Entry conditions:** `list.filter.active` and `_filteredRows.length === 0`.
- **Exit conditions:** New event arrives and matches; user loosens filter.
- **Visual:**
  ```
  ┌────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │                    No requests match current filters            │
  │                                                                 │
  │       [ Clear filters ]   [ Show filter syntax help ]           │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ```
  Same surface as the existing empty state but with `mode="filtered"` data attribute for CSS variation.
- **Keyboard shortcuts:** `Esc` clears all filters.
- **Data requirements:** Same as filter.active.
- **Transitions:** → `list.filter.active` when a matching event streams in OR filter loosened.
- **Error recovery:** N/A.

---

## 4. Table-Viewport States (`list.table.*`)

### 4.1 `list.table.idle`

- **Entry conditions:** Tab activated, zero rows in ring buffer (fresh session, no traffic yet).
- **Exit conditions:** First event arrives on `http` topic.
- **Visual:**
  ```
  ┌────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │              ●  Waiting for HTTP traffic…                       │
  │                                                                 │
  │              FLT is not making any HTTP calls yet.              │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ```
  If `list.intercept.armed`, append hint: *"Intercept armed — first matching request will pause."*
- **Keyboard shortcuts:** None row-scoped (no rows). Toolbar shortcuts still active.
- **Data requirements:** `http` topic subscription open, awaiting events.
- **Transitions:** → `list.table.streaming` on first event.
- **Error recovery:** If subscription stream errors, surface a reconnect banner; state stays `idle` until events flow.

### 4.2 `list.table.streaming`

- **Entry conditions:** ≥1 row in buffer, tab visible, no active filter, scroll position at tail (auto-follow on).
- **Exit conditions:** User scrolls away from tail (auto-follow off → `streaming-paused`); filter applied → `filtered`; clear pressed → `idle`.
- **Visual:** Table rows append at the bottom with a 120ms `row-enter` slide-in (`translateY(4px) → 0`, fade 0→1). Header sticky. Row count increments live. Latest p50/p95/p99 stats animate.
- **Keyboard shortcuts:** `j/k` or `↑/↓` to navigate rows (existing behavior); `End` jumps to tail; `Home` jumps to head (auto-follow off).
- **Data requirements:** `http` topic live; `mitm` topic live if `list.intercept` is on.
- **Transitions:**
  - Filter applied → `list.table.filtered`.
  - Buffer reaches cap (2000) → oldest row removed silently (FIFO).
  - Paused row added → row gets `http-row-paused` class but state machine stays in `streaming`.
- **Error recovery:** If row render throws (corrupt envelope), defensive `try/catch` in `_render` emits a single-row error placeholder `[ ! malformed event seq=N ]` and continues.

### 4.3 `list.table.streaming-paused` (scroll-paused, NOT MITM-paused)

- **Entry conditions:** User scrolls up; auto-follow disables.
- **Exit conditions:** User scrolls back to within 8px of tail (auto-follow re-enables); click `[Resume]` banner; press `End`.
- **Visual:** Floating banner at the bottom of the table viewport:
  ```
  ┌─────────────────────────────────────────────┐
  │  ⏵ 12 new requests · Resume auto-scroll     │
  └─────────────────────────────────────────────┘
  ```
- **Keyboard shortcuts:** `End` jumps to tail and resumes. `Esc` is reserved for detail panel; does not affect scroll state.
- **Data requirements:** Same as streaming.
- **Transitions:** → `streaming` on resume; → `filtered` if filter changes; rows continue to accrete in DOM offscreen.
- **Error recovery:** If new-row counter exceeds 9999, badge clamps to `9999+` to avoid layout reflow.

### 4.4 `list.table.filtered`

- **Entry conditions:** `list.filter.active`; ≥1 row matches.
- **Exit conditions:** Filter cleared → `streaming`; matches drop to 0 → handled by `list.filter.no-results`; tab cleared → `idle`.
- **Visual:** Only matching rows visible; non-matching rows skipped in render. Row count `142 / 1847`. Distribution bar reflects filtered set.
- **Keyboard shortcuts:** `j/k`/`↑/↓` navigate filtered set only.
- **Data requirements:** Same as streaming.
- **Transitions:** New event arrives that matches → row inserted in place; doesn't match → row not rendered (still in ring buffer for future filter changes).
- **Error recovery:** N/A.

### 4.5 `list.table.disconnected`

- **Entry conditions:** SignalR disconnect.
- **Exit conditions:** Reconnect.
- **Visual:** Top-of-viewport banner `⊗ Disconnected — historical rows preserved · attempting reconnect…` with a small spinner. Existing rows remain interactive (right-click, click, detail panel) but new rows do not arrive.
- **Keyboard shortcuts:** Row nav still works on cached rows. Replay/block shortcuts no-op with toast `"Disconnected — try again after reconnect"`.
- **Data requirements:** No live subscription. Ring buffer retained per `signalr-manager.js` reconnect contract.
- **Transitions:** Reconnect → re-subscribe to `http` + `mitm` topics; replay snapshot phase delivers any events the server buffered; if dedup logic detects already-rendered events (by `sequenceId`), skip → `streaming`.
- **Error recovery:** If reconnect schedule exhausts (`[0,1k,2k,5k,10k,30k]` per `signalr-manager.js:53`), banner upgrades to `⊗ Disconnected — manual reload required` with a `[Reload]` button.

### 4.6 `list.table.cleared`

- **Entry conditions:** User clicks `[Clear]` button (confirms via existing modal flow).
- **Exit conditions:** First post-clear event arrives.
- **Visual:** Identical to `idle` but ring buffer is empty by user action, not by freshness. Subtle toast `"Cleared 1847 requests"` with `[Undo]` for 5s (undo restores from a one-snapshot stash).
- **Keyboard shortcuts:** N/A row-scoped.
- **Data requirements:** Subscriptions remain active.
- **Transitions:** → `streaming` on first event; `[Undo]` → `streaming` with restored buffer.
- **Error recovery:** N/A.

---

## 5. Selection States (`list.select.*`)

These compose with table states — selection can exist regardless of filter/streaming substate.

### 5.1 `list.select.none`

- **Entry conditions:** Initial; user clicks empty area; `Esc` (when detail not open).
- **Exit conditions:** Row hover → `row-hovered`; row click → `row-selected`; right-click → `row-context-menu`.
- **Visual:** No row highlighted; detail panel closed (its own state).
- **Keyboard shortcuts:** `j/k`/`↑↓` selects first row → `row-selected`.
- **Data requirements:** N/A.
- **Transitions:** Any pointer/keyboard activation → into a row state.
- **Error recovery:** N/A.

### 5.2 `list.select.row-hovered`

- **Entry conditions:** Mouse enters a `.http-row`.
- **Exit conditions:** Mouse leaves; click (→ `row-selected`); right-click (→ `row-context-menu`).
- **Visual:** Row gets `background: var(--accent-hover)`; `row-actions` micro-toolbar fades in at right (per mock `.row-actions` class):
  ```
  GET    /Tables/dim_customer        200    87ms    —    13:44:51   [ ⋯ ▾ ]
                                                                      ▲ appears
  ```
- **Keyboard shortcuts:** N/A (mouse-driven).
- **Data requirements:** N/A.
- **Transitions:** Mouseleave → `row-hovered` exits; click → `row-selected`; right-click → `row-context-menu`.
- **Error recovery:** N/A.

### 5.3 `list.select.row-selected`

- **Entry conditions:** Click on a row; arrow-key navigation; programmatic select (e.g., status-bar pill click jumps to oldest paused row).
- **Exit conditions:** Click another row; click empty area; `Esc` (if detail closes too); navigate away with arrows.
- **Visual:** Selected row gets `background: var(--accent-bg)` + `border-left: 2px solid var(--accent)`. Detail panel opens (see `detail-panel.md` for its lifecycle). If row is paused, the detail panel auto-selects the editing tab (per detail-panel matrix).
- **Keyboard shortcuts:** `j/k`/`↑↓` move selection; `Enter` opens detail panel (already open in current architecture, so re-focus content); `b`/`r`/`f` operate on selected row when intercept enabled; `Shift+F10` opens context menu at row coordinates.
- **Data requirements:** Detail panel may subscribe to `_pausedSnapshots` map if row is paused.
- **Transitions:**
  - Arrow keys move to adjacent row → still `row-selected` with new `_selectedId`.
  - Right-click → `row-context-menu` (selection preserved underneath).
  - Shift+click another row → `multi-select`.
  - Row becomes `paused` via `breakpoint-hit` (selected row matches) → `row-paused` overlay state.
- **Error recovery:** If selected row drops out of ring buffer (rare — would need 2000 newer events while still selected), selection collapses to `none` and detail panel closes with toast `"Selected request expired from buffer."`.

### 5.4 `list.select.row-paused`

- **Entry conditions:** Selected row's `mitmTag === 'paused'` (either selected-then-paused or paused-then-selected).
- **Exit conditions:** `breakpoint-resolved` arrives for this row's `interceptId`; user resolves via detail panel (Forward/Drop/Forge/Modify); user navigates to a different row.
- **Visual:**
  - Row tinted amber (`http-row-paused`) with `⏸ PAUSED` badge in status cell.
  - Pulsing 1.6s amber ring on row background.
  - Detail panel locks to the Intercept tab (auto-selected per detail-panel matrix §3).
  - Status badge in toolbar pulses amber (`Paused: 1`).
- **Keyboard shortcuts:** `Enter` (forward), `D` (drop), `P` (Send to Playground), `Esc` (forward + close detail per mock footer).
- **Data requirements:** Full snapshot from `_pausedSnapshots` Map keyed by `interceptId`. Includes unredacted body if backend re-buffered to 10MB cap.
- **Transitions:**
  - Decision applied → `breakpoint-resolved` → row badge crossfades to MODIFIED / BLOCKED / FORGED. Selection state → `row-selected` with new `mitmTag`.
  - Timeout fires server-side → row auto-forwards; UI transitions same as above with toast `"Pause timed out — forwarded untouched."`.
  - User navigates away → selection moves; row stays paused (toolbar badge still amber); selection state goes to `row-selected` for new row.
- **Error recovery:** If `MitmResume` RPC fails, button reverts to enabled with toast `"Decision failed: {err} — retry"`. Snapshot retained until server confirms resolution.

### 5.5 `list.select.row-context-menu`

- **Entry conditions:** Right-click on a row; `Shift+F10` on a row with keyboard focus.
- **Exit conditions:** Menu closes (see `context-menu.md` for its own lifecycle); selection state retained.
- **Visual:** Underlying row gets a faint `--accent-hover` tint to signal "this row is targeted". Context menu floats above (rendered by context-menu component).
- **Keyboard shortcuts:** Delegated to the context menu's own keyboard handler (Esc closes, arrow keys navigate items).
- **Data requirements:** Snapshot of the row passed by value into the menu's action dispatch (the menu doesn't subscribe).
- **Transitions:**
  - Menu item activated → menu closes; if action opens Playground (`P` / "Send to Playground"), focus shifts away. Selection remains on the row unless action explicitly clears it.
  - `Esc` or outside-click → menu closes → returns to `row-selected` or `row-hovered`.
- **Error recovery:** If menu fails to render (DOM error), Esc dismisses; no orphan tint left on row (cleanup in `_closeRowMenu`).

### 5.6 `list.select.multi-select`

- **Entry conditions:** `Shift+click` extends selection from `_selectedId` to clicked row; `Ctrl/Cmd+click` toggles individual rows into a selection set.
- **Exit conditions:** Click without modifier → collapses to single `row-selected`; `Esc` clears multi-selection to `none`.
- **Visual:** All selected rows tinted with `--accent-bg`; first-clicked row keeps the 2px accent border. Footer toolbar gains a contextual strip: `[ 5 selected ] [Export selected as HAR] [Copy all as cURL] [Clear selection]`.
- **Keyboard shortcuts:** `Esc` clears multi-selection. `Ctrl+A` selects all visible (post-filter) rows. Bulk MITM actions (`b` to block all) prompt: `"Block 5 URLs? [Confirm]"`. Replay (`r`) is disabled in multi-select (potential side-effect storm).
- **Data requirements:** Selection set held in `_selectedIds = Set<int>`.
- **Transitions:**
  - Single click any row → `row-selected` (one row).
  - Bulk action completed → selection retained; toast `"5 URLs blocked"`.
- **Error recovery:** If bulk action partially fails (3 of 5 rules created), toast `"3/5 rules added; 2 failed — retry?"` with a button that re-attempts only the failures.

---

## 6. Cross-cutting Concerns

### 6.1 Disconnected
Captured rows remain interactive (click, right-click, copy). Any action that requires a hub RPC (block, replay, send to playground requires the playground panel which is local) shows a toast `"Disconnected — try again after reconnect"`. Intercept toggle locked to `offline` style. See `list.intercept.offline` and `list.table.disconnected` for state-level detail.

### 6.2 Kill switch (`Ctrl+Shift+K`)
Fires from any state. Effects:
- Invokes `MitmKillSwitch()` on the hub.
- Optimistically: `_interceptOn = false`, `_mitmStats = {rules:0, paused:0}`, all `http-row-paused` classes removed from rows.
- Toast `"Killed N rules · resumed M paused requests"` with `[Undo]` (5s) restoring rules from `_lastClearedRulesSnapshot`.
- No confirm modal — speed prioritized over guardrails (C04 §7.1 R-decision).

### 6.3 Theme change
All states use design tokens (`--accent`, `--http-amber`, `--surface`, `--text-dim`, etc.). Theme switch via `[data-theme="dark"]` flip swaps tokens — no per-state CSS overrides required. Row state badges, pulse animations, and selection tints all adapt automatically. Verified via `tab-http.css` token consumption.

### 6.4 Panel resize
The traffic list panel is left side of the split view. Its width is managed by an external resize handle (detail panel owns the handle per `detail-panel.md` §6). On resize:
- Column widths in the table re-compute via CSS `grid-template-columns` (existing behavior in tab-http).
- Filter bar uses `flex-wrap: wrap`; pills wrap to new lines on narrow widths.
- At <420px the toolbar collapses to a "more" overflow menu (defensive — current breakpoint behavior, not new).

### 6.5 Modal close (Playground / detail-detached)
When the user dispatches "Send to Playground" from a row (either via right-click menu, `P` shortcut, or detail-panel button), focus shifts to the Playground tab. The traffic list state machine is unaffected; the row remains selected. When the user returns to the HTTP tab, `row-selected` is preserved (verified by re-render hitting the cached `_selectedId`).

### 6.6 Tab visibility
The HTTP tab subscribes to `http` and `mitm` topics at construction (`tab-http.js:56–59`), not at activate. While the tab is hidden:
- Events continue to populate the ring buffer.
- Paused intercepts continue to accumulate; on tab re-activation, the toolbar status badge already reflects current state.
- Row badges are pre-rendered; no replay/animation backlog needed.
- A Runtime View status-bar pill (C04 §8) surfaces paused count globally so users on other tabs are alerted.

### 6.7 Memory
Ring buffer capped at 2000 rows per `tab-http.js:42`. Paused rows are **exempt from eviction** (defensive logic in `_onEvent`'s shift step per C04 §2.1 edge case). `_pausedSnapshots` Map is capped at 50 (per §2.4 above).

---

## 7. State Transition Table (consolidated)

| From | Trigger | To | Notes |
|------|---------|----|-------|
| `intercept.off` | Click toggle, RPC OK | `intercept.armed` | Optimistic flip, 200ms debounce |
| `intercept.armed` | `mitm` event `breakpoint-hit` | `intercept.active.paused-pending` | Snapshot cached |
| `intercept.armed` | Disconnect | `intercept.offline` | Toggle locked, badge dim |
| `intercept.active.paused-pending` | Last `breakpoint-resolved` | `intercept.active.idle` | Paused decrements to 0 |
| `intercept.active.*` | `Ctrl+Shift+K` | `intercept.off` | All rules cleared server-side |
| `intercept.offline` | Reconnect + reconcile | `intercept.armed` / `intercept.off` | Depends on server rule count |
| `filter.empty` | Any predicate mutation | `filter.active` | Filter badge appears |
| `filter.active` | Match count → 0 | `filter.no-results` | Empty state placeholder |
| `filter.no-results` | New matching event or filter loosen | `filter.active` | Auto-recover |
| `filter.active` | All predicates reset | `filter.empty` | Badge hides |
| `table.idle` | First `http` event | `table.streaming` | Row enter animation |
| `table.streaming` | User scrolls up | `table.streaming-paused` | Floating resume banner |
| `table.streaming-paused` | Scroll to tail | `table.streaming` | Auto-follow re-enables |
| `table.streaming` | Filter applied | `table.filtered` | Same data, different render |
| `table.streaming` | `[Clear]` | `table.cleared` → `idle` | Undo for 5s |
| `table.*` | Disconnect | `table.disconnected` | Rows preserved |
| `select.none` | Row click | `select.row-selected` | Detail panel opens |
| `select.row-hovered` | Mouseleave | `select.none` | — |
| `select.row-selected` | Right-click | `select.row-context-menu` | Menu component owns next states |
| `select.row-selected` | `breakpoint-hit` matches | `select.row-paused` | Detail panel auto-selects Intercept tab |
| `select.row-paused` | Decision applied | `select.row-selected` | Badge crossfade |
| `select.row-selected` | Shift+click another | `select.multi-select` | Bulk strip appears |
| `select.multi-select` | `Esc` | `select.none` | Clears all |

---

## 8. State Inventory

1. `list.intercept.off`
2. `list.intercept.armed`
3. `list.intercept.active.idle`
4. `list.intercept.active.paused-pending`
5. `list.intercept.offline`
6. `list.intercept.unavailable`
7. `list.filter.empty`
8. `list.filter.active`
9. `list.filter.no-results`
10. `list.table.idle`
11. `list.table.streaming`
12. `list.table.streaming-paused`
13. `list.table.filtered`
14. `list.table.disconnected`
15. `list.table.cleared`
16. `list.select.none`
17. `list.select.row-hovered`
18. `list.select.row-selected`
19. `list.select.row-paused`
20. `list.select.row-context-menu`
21. `list.select.multi-select`

**Total: 21 states.** All have entry/exit conditions, visuals, keyboard, data requirements, transitions, and error recovery defined above.

---

*End of traffic-list state matrix.*
