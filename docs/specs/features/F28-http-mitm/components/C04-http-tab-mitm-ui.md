# C04 — HTTP Tab MITM UI

> **Feature:** F28 HTTP MITM
> **Component:** C04 — HTTP Tab MITM UI (frontend)
> **Author:** Pixel (Frontend specialist)
> **Status:** P1 — Component Deep Spec
> **Phase gate:** Depends on C01 (Coordinator) + C03 (SignalR Protocol). Blocks no other components.
> **Surface:** `src/frontend/js/tab-http.js` (extended in place), `src/frontend/css/tab-http.css` (extended in place), plus one new module `src/frontend/js/request-editor.js`.
> **Single-HTML constraint (ADR-003):** all new modules picked up by `scripts/build-html.py`.

---

## 0. Scope and stance

This component is the **only user-visible surface** for F28 v1. Everything the user does to drive MITM (toggle intercept, watch breakpoints, decide block/forge/modify, replay) happens inside the existing Runtime → HTTP tab — no new panel, no new route, no new tab strip at the top level. F24's dedicated Chaos panel comes later; F28 piggy-backs on the network inspector users already trust.

**Three layers, in order of permanence on the page:**

1. **Toolbar layer** — `Intercept` toggle pill (passive observation ↔ active MITM mode) and a `Rules: N · Paused: M` status badge. Persistent across selections.
2. **Table layer** — row-level badges (`PAUSED`, `MODIFIED`, `BLOCKED`, `FORGED`, `DELAYED`, `REPLAYED`) plus a right-click context menu. Per-row, ephemeral.
3. **Detail panel layer** — two new detail tabs (`Intercept`, `Replay`) appended to the existing Request / Response / Timing / Headers strip. Per-selection.

Plus three global affordances:

4. **Keyboard shortcuts** — `b`, `r`, `f`, `Ctrl+Shift+K`, `Escape`.
5. **Status bar integration** — `MITM: N rules, M paused` + kill-switch chip in the Runtime View status bar.
6. **Embedded `RequestEditor` component** — extracted from `api-playground.js` `RequestBuilder`, shared by the Intercept and Replay tabs.

**Design discipline** (F16 philosophy, enforced by the design bible):

- Tokens only — no hex literals. Use `--accent`, `--accent-glow`, `--http-amber`, `--http-red`, `--http-blue`, `--http-purple`, `--http-teal`, `--http-cyan`, `--shadow-sm/md/lg/glow`, `--radius-md/full`, `--space-1..6`, `--transition-fast/normal`.
- No emoji. Use Unicode glyphs (`⏸ ✎ ✕ ◆ ⏱ ↻ ▶ ⏵ ⊘ ▾`) or inline SVG.
- Physics-based motion — easing `cubic-bezier(0.2, 0.8, 0.2, 1)` for entrances; `cubic-bezier(0.4, 0, 0.2, 1)` for state shifts; never linear.
- Accent restraint — `--accent` (`#6d5cff` purple) is reserved for the active MITM-mode indicator. Per-row state badges use the HTTP semantic palette already in use (`--http-amber` etc.) so they don't fight the existing status colors.
- Compound elevation — context menus = `--shadow-md`; the breakpoint hero card inside the Intercept tab = `--shadow-lg`.

**Capability gating.** Everything in C04 is wrapped in `if (this._caps && this._caps.mitm.enabled)`. The capabilities envelope arrives via `MitmGetCapabilities` (C03) at tab construction. When disabled, the toolbar shows a dim "MITM unavailable" pill instead of the toggle; right-click menu omits MITM items; detail tabs are not appended.

---

## 1. Toolbar — Intercept Toggle + Status Badge

### 1.1 — Intercept Toggle Pill `[P0]`

**Name + ID:** `S1.1 — Intercept toggle pill` · `.http-pill.http-intercept-toggle`
**One-liner:** A toolbar pill that arms/disarms the MITM pipeline; ON state has an accent pulse so users can never forget they're live.

**Detailed description.** The toggle is the single switch that flips the HTTP tab from passive Chrome-DevTools-style observation into Burp-style "every matching request pauses for me" mode. Off state is a quiet ghost pill matching the surrounding toolbar pills. On state lights up with `--accent` fill, a `--accent-glow` halo, and a slow 2.4s breath pulse to enforce the testing-tool stance from R1 (you can't forget you have it on). Clicking it calls `MitmSetIntercept(enabled)` on the hub; the visual flips optimistically on click and rolls back on RPC failure. The toggle does not by itself create breakpoint rules — it gates whether existing breakpoint rules are honored. With zero rules + toggle ON, traffic flows untouched; the user must add at least one rule (right-click or Intercept tab) to actually pause anything. The pill's accessible name is "Intercept" with `aria-pressed` reflecting state.

**Visual description.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [🔍 Filter URLs…]  │ All GET POST PUT DEL PATCH │ All 2xx 4xx 5xx │   …   │
├─────────────────────────────────────────────────────────────────────────────┤
│  142 requests │ Duration: ▬▬▬●─── 60s │ p50 28ms p95 410ms p99 1.2s │ ▮▮▮▯ │
│                                                                              │
│           …existing row-2 controls…           ┌──────────────────┐  [Clear] │
│                                               │ ● Intercept: ON  │ [Export▾]│
│                                               └──────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
                                                  ^ pulses 2.4s ease-in-out
                                                  accent fill, glow halo
```

OFF state: ghost pill, `border-bright`, `text-dim`, label `○ Intercept: OFF`.
ON state: filled `--accent`, white text, `box-shadow: var(--shadow-glow)`, animated `pulse-intercept` keyframes.

**CSS approach.**

```css
.http-intercept-toggle {
  font-weight: 600;
  letter-spacing: 0.2px;
  padding: 3px 12px;
  transition:
    background var(--transition-normal),
    border-color var(--transition-normal),
    box-shadow var(--transition-normal),
    color var(--transition-normal);
}
.http-intercept-toggle .http-intercept-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-muted);
  transition: background var(--transition-normal);
}
.http-intercept-toggle.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-glow);
  animation: pulse-intercept 2400ms cubic-bezier(.4,0,.6,1) infinite;
}
.http-intercept-toggle.active .http-intercept-dot {
  background: #fff;
  box-shadow: 0 0 6px rgba(255,255,255,0.8);
}
@keyframes pulse-intercept {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
  50%      { box-shadow: 0 0 0 6px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .http-intercept-toggle.active { animation: none; }
}
```

Position: row-1 of `.http-toolbar`, placed **after** the status-pills `_makeSep`, **before** the right-side spacer that holds Clear/Export. The toggle pushes Clear/Export rightward; on narrow viewports the toolbar already wraps (`flex-wrap: wrap`) and the toggle wraps with them.

**JS mechanism.** New methods on `HttpPipelineTab`:

- `_buildInterceptToggle()` — returns the `<button>` element. Appended in `_buildToolbar` between the existing status-pills separator and the action-spacer (`tab-http.js:272–273`, i.e. immediately after `toolbar.appendChild(row1)` for row1 ordering, OR inserted before line 275 in the existing `row1` chain).
- `_onInterceptToggle()` — click handler. Reads `this._interceptOn`, flips it, updates DOM optimistically, invokes:
  ```js
  this._signalr.connection.invoke('MitmSetIntercept', this._interceptOn)
    .catch(err => { this._interceptOn = !this._interceptOn; this._updateInterceptUi(); this._toast('error', err.message); });
  ```
- `_updateInterceptUi()` — toggles `.active` class, updates label, updates `aria-pressed`.
- New state field in constructor: `this._interceptOn = false;`.
- C03 subscription: when the `mitm` topic delivers `{ type: "intercept-state", enabled }`, call `_updateInterceptUi()` so multi-tab sessions stay in sync.

**Source code path.** `src/frontend/js/tab-http.js` — extend `_buildToolbar()` around `tab-http.js:272–275` (after status-pills append, before row1 close). State init at constructor (`tab-http.js:18–46`). Handler wiring in `_bindEvents` (`tab-http.js:499+`). CSS additions at end of `src/frontend/css/tab-http.css`.

**Edge cases.**
- **SignalR disconnected** → toggle goes disabled (`opacity: 0.4`, cursor `not-allowed`), label changes to `Intercept: OFFLINE`, click is a no-op. Re-enables on `reconnected`.
- **`MitmGetCapabilities.enabled === false`** → toggle is **not rendered**; in its place show a quiet "MITM not enabled" pill with a tooltip explaining the env-var gate (R from §4.1 of P0).
- **Reconnect with rules persisted** → after `signalr-manager.js:79` reconnected, call `MitmListRules()`; if rules > 0, restore ON state with a flash-then-pulse animation to signal recovery. If server-side rules were purged (R10), surface a toast "MITM rules cleared on reconnect — re-arm?" with a one-click re-push.
- **Rapid clicks** → debounce 200ms; ignore clicks while RPC in flight (`this._interceptPending = true`).

**Interactions with C01 / C03.**
- C03 RPC: `MitmSetIntercept(enabled: bool) → MitmResult`.
- C03 topic event: `mitm` topic `{ type: "intercept-state", enabled, sessionId }` broadcast on every change so all subscribers reconcile.
- C01 coordinator owns whether breakpoints actually pause requests; the toggle is purely the master gate it consults.

**Keyboard / a11y.**
- `aria-pressed`, `aria-label="Toggle HTTP intercept"`.
- Tab-stop: yes (`<button>`).
- Reduced motion: pulse animation disabled (see CSS).
- High contrast: keep border on `.active` so it survives forced-colors mode.

**Priority:** `P0` — the core entry point.

---

### 1.2 — Rules / Paused Status Badge `[P0]`

**Name + ID:** `S1.2 — Status badge` · `.http-mitm-status`
**One-liner:** Companion badge next to the toggle showing `Rules: N · Paused: M`, with a click-target that opens a filter view.

**Detailed description.** Sitting immediately right of the intercept pill, this is a compact informational pill — like the `.http-filter-badge` already in row 2 — that reflects two numbers maintained from the `mitm` topic stream: total active rules in this session, and count of currently-paused requests waiting on a decision. Tapping the badge filters the table to show only intercepted/modified/forged/blocked rows (acts like a saved filter). When paused > 0 the badge gains an amber border and a subtle 1.6s amber pulse to draw the eye, because "you have something waiting on you" is the single most important UI signal in active MITM mode.

**Visual description.**

```
…[ ● Intercept: ON ] [ Rules: 3 · Paused: 1 ] [Clear] [Export ▾]…
                       ▲                ▲
                       │                └─ this segment gets amber pulse + bold
                       └─ rules count, neutral
```

**CSS approach.**

```css
.http-mitm-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: var(--text-sm);
  color: var(--text-dim);
  background: var(--surface-2);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all var(--transition-normal);
}
.http-mitm-status:hover { background: var(--accent-hover); color: var(--text); }
.http-mitm-status[data-paused="0"] .http-mitm-paused { opacity: 0.5; }
.http-mitm-status[data-paused]:not([data-paused="0"]) {
  border-color: var(--http-amber);
  color: var(--text);
  animation: pulse-paused 1600ms cubic-bezier(.4,0,.6,1) infinite;
}
.http-mitm-sep { color: var(--text-muted); }
@keyframes pulse-paused {
  0%, 100% { box-shadow: 0 0 0 0 var(--http-amber-bg); }
  50%      { box-shadow: 0 0 0 4px transparent; }
}
```

**JS mechanism.**
- `this._mitmStats = { rules: 0, paused: 0 };` in constructor.
- `_renderMitmStatus()` updates DOM `data-paused` attr + text content.
- Subscribe in `_onMitmEvent(evt)` (new handler) to `mitm` topic. Each event of type `rule-added` / `rule-removed` / `breakpoint-hit` / `breakpoint-resolved` adjusts counters.
- Click handler sets `this._statusFilter = 'mitm'` (new virtual filter) and re-applies; toggles back on second click.

**Source code path.** `tab-http.js` — append immediately after the intercept pill in `_buildToolbar` (after `1.1` block).

**Edge cases.**
- Rules = 0, paused = 0 → badge still visible but dim (`opacity: 0.6`) so users know MITM is wired but inactive.
- Paused > 9 → render as `Paused: 9+` to keep pill width stable.
- Rules > 99 → render `Rules: 99+`.

**Interactions with C01 / C03.** Counts are derived purely from `mitm` topic events — frontend never authoritatively tracks rules independently. On reconnect, after `_resubscribeAll`, frontend invokes `MitmListRules()` and `MitmListPaused()` to reconcile.

**Keyboard / a11y.** `role="button"`, `aria-label="3 MITM rules, 1 paused. Click to filter."` updated reactively.

**Priority:** `P0`.

---

## 2. Row Badges and State Indicators

### 2.1 — Per-row state badge `[P0]`

**Name + ID:** `S2.1 — Row state badge` · `.http-mitm-badge`
**One-liner:** A small badge rendered inside the existing Status cell that surfaces the MITM disposition of a row at a glance.

**Detailed description.** Rather than adding a 7th column (which would force the existing table grid to reflow — risky given the column-width math in `tab-http.css`), the MITM state is folded **into the Status cell** as a second pill rendered next to the HTTP status code. This keeps the column count at six, preserves the existing visual rhythm, and lets the row stay scannable. Six states map to six badges with distinct color tokens. Only one badge can be active per row at a time (latest wins). Paused rows additionally get a row-level row tint (`.http-row-paused`) so they stand out in the list view, the same way 5xx rows get `--http-row-failed`. Badge entrance uses a 200ms scale-in (`scale(0.85) → 1`) tied to the row appearing; subsequent state changes (paused→modified→sent) crossfade.

**State table:**

| State    | Glyph | Token              | Use when                                           |
|----------|-------|--------------------|-----------------------------------------------------|
| PAUSED   | `⏸`   | `--http-amber`     | Breakpoint hit, awaiting decision (animated pulse) |
| MODIFIED | `✎`   | `--http-blue`      | Forwarded after user edits                          |
| BLOCKED  | `✕`   | `--http-red`       | Short-circuited, request never sent                 |
| FORGED   | `◆`   | `--http-purple`    | Response synthesized without calling base service   |
| DELAYED  | `⏱`   | `--http-amber`     | `Task.Delay` injected before forward                |
| REPLAYED | `↻`   | `--http-teal`      | Result of a user-driven replay (not original call)  |

**Visual description.**

```
Method   URL                                       Status                Duration  Retry   Time
─────────────────────────────────────────────────────────────────────────────────────────────────
GET      /Tables?... [redacted]                    200  [ ✎ MODIFIED ]   142ms     —       17:42:11
POST     /Tables                                   ⏸    [ ⏸ PAUSED ]    —          —      17:42:14   ← amber tint row
GET      /Telemetry                                503  [ ◆ FORGED ]    1ms       —       17:42:18
DELETE   /Drop                                     —    [ ✕ BLOCKED ]   0ms       —       17:42:21   ← red tint row
GET      /Replayed                                 200  [ ↻ REPLAYED ]  98ms      —       17:42:30
```

**CSS approach.**

```css
.http-mitm-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 1px 8px;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  border-radius: var(--radius-full);
  border: 1px solid currentColor;
  background: transparent;
  animation: badge-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.http-mitm-badge[data-state="paused"]   { color: var(--http-amber);  background: var(--http-amber-bg);  animation: badge-enter 200ms cubic-bezier(0.2,0.8,0.2,1), pulse-paused 1600ms cubic-bezier(.4,0,.6,1) infinite 200ms; }
.http-mitm-badge[data-state="modified"] { color: var(--http-blue);   background: var(--http-blue-bg); }
.http-mitm-badge[data-state="blocked"]  { color: var(--http-red);    background: var(--http-red-bg); }
.http-mitm-badge[data-state="forged"]   { color: var(--http-purple); background: var(--http-purple-bg); }
.http-mitm-badge[data-state="delayed"]  { color: var(--http-amber);  background: var(--http-amber-bg); }
.http-mitm-badge[data-state="replayed"] { color: var(--http-teal);   background: rgba(13,148,136,0.10); }

.http-row-paused  { background: var(--http-amber-bg) !important; }
.http-row-blocked { background: var(--http-red-bg) !important; }
.http-row-forged  { box-shadow: inset 2px 0 0 var(--http-purple); }
.http-row-modified{ box-shadow: inset 2px 0 0 var(--http-blue); }
.http-row-replayed{ box-shadow: inset 2px 0 0 var(--http-teal); }

@keyframes badge-enter {
  from { opacity: 0; transform: scale(0.85); }
  to   { opacity: 1; transform: scale(1); }
}
```

The inset 2px stripe on the left of modified/forged/replayed rows is the same affordance the design bible uses for "this row has metadata you care about" — it adds scannability without changing row height.

**JS mechanism.**
- Extend the row entry shape in `_onEvent` (`tab-http.js:92–108`): add `mitmTag` (string, one of the six states or null), `mitmInterceptId` (for paused rows, the coordinator's intercept id), `mitmModifications` (array of summaries, optional). All read from `envelope.data.mitm` per the C03 wire shape (P0 §2.1, lines 253–267).
- Extend row rendering (`tab-http.js:907–916`): inside the status cell template, after the status `<span>`, append `req.mitmTag ? this._renderMitmBadge(req) : ''`.
- New helper `_renderMitmBadge(req)` returns the badge HTML keyed by `req.mitmTag`.
- Extend row class string at `tab-http.js:903`: `rowCls += req.mitmTag ? ' http-row-' + req.mitmTag : '';`
- For the **paused** state (no real response yet) override the status cell content: render `⏸` glyph in place of the missing status code, and render `—` for duration. The status code is still 0 in this case.

**Source code path.** `src/frontend/js/tab-http.js` — `_onEvent` (`tab-http.js:88–117`) to extract the `mitm` block; `_render` row builder (`tab-http.js:907–916`) to inject the badge; new helper near `_jsonHighlight` (around `tab-http.js:1289`).

**Edge cases.**
- **Multi-step lifecycle** (paused → user modifies → forward → server responds). The same row's `mitmTag` transitions `paused → modified` and the badge crossfades. Tracked by `interceptId` so the row identity is stable. Implementation: when a `breakpoint-resolved` event arrives, look up the existing row by `_interceptIdIndex` map and mutate in place.
- **100+ paused requests.** Status badge in toolbar shows `Paused: 99+`; row tints are cheap (CSS class). The detail panel only renders the selected one. Safe.
- **Row drops out of ring buffer** (oldest of 2000 events) while still paused. Defensive: when `breakpoint-hit` arrives, **bump** the row's ring eviction so paused entries are never dropped while paused (special-case in `_onEvent`'s shift logic).

**Interactions with C01 / C03.**
- C03: every `mitm` topic envelope carries `interceptId` + `state`. C01 emits state transitions; C04 mirrors them.
- C01: badge state IS the coordinator state, projected. C04 must never invent transitions client-side; always wait for the topic.

**Keyboard / a11y.**
- Each badge has `aria-label` matching its state ("Paused, awaiting decision", "Forged response", …).
- Row remains keyboard-navigable (arrow keys via `_navigateRows`, `tab-http.js:952`).
- `role="status"` on the badge so screen readers announce changes.

**Priority:** `P0`.

---

## 3. Right-Click Context Menu

### 3.1 — Row context menu `[P0]`

**Name + ID:** `S3.1 — Row context menu` · `.http-row-menu`
**One-liner:** Chrome-DevTools-style right-click menu on any HTTP row, exposing every MITM action plus copy/export utilities.

**Detailed description.** The current tab has no context menu. F28 introduces one — `contextmenu` event on `.http-row`, with `preventDefault` so the browser's native menu is suppressed. The menu is a single floating popover anchored to the click point, with sectioned items (MITM rules · Replay · Copy · Export). Items are ordered by frequency-of-use, not alphabetically, following Chrome's pattern (Block, Forge, Modify at top; Export as HAR last). The menu auto-closes on outside click, Escape, scroll, blur, or selecting an item. Submenus (Copy as cURL / fetch / PowerShell) open on hover with a 150ms intent delay to avoid accidental triggers — same pattern as `_exportOpen` dropdown already in the toolbar.

**Menu sections and items:**

```
┌──────────────────────────────────────────┐
│ Rules                                    │
│   ▸ Block URL                       b    │
│   ▸ Block Domain                         │
│   ▸ Forge Response…                 f    │
│   ▸ Modify & Forward…                    │
│   ▸ Set Breakpoint on URL…               │
│ ──────────────────────────────────────── │
│ Replay                                   │
│   ▸ Replay Request                  r    │
│   ▸ Replay with Edits…                   │
│ ──────────────────────────────────────── │
│ Copy                                     │
│   ▸ Copy URL                             │
│   ▸ Copy as cURL                         │
│   ▸ Copy as fetch                        │
│   ▸ Copy as PowerShell                   │
│ ──────────────────────────────────────── │
│ Export                                   │
│   ▸ Export as HAR entry                  │
└──────────────────────────────────────────┘
   shadow-md, radius-md, 220px wide
```

Items that need disambiguation (e.g. `Block URL` vs `Block Domain`) show a secondary line in `--text-muted`:

```
Block URL              ⌘
   https://onelake.dfs.fabric…/Tables
Block Domain
   onelake.dfs.fabric.microsoft.com
```

**CSS approach.**

```css
.http-row-menu {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 220px;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: 4px 0;
  font-size: var(--text-sm);
  opacity: 0;
  transform: translateY(-2px) scale(0.98);
  transform-origin: top left;
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.http-row-menu.open { opacity: 1; transform: translateY(0) scale(1); }
.http-row-menu-section-label {
  padding: 6px 12px 2px;
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.http-row-menu-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--text);
}
.http-row-menu-item:hover { background: var(--accent-hover); }
.http-row-menu-item .kbd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.http-row-menu-item .sub {
  display: block;
  font-size: var(--text-xs);
  color: var(--text-muted);
  max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.http-row-menu-sep {
  height: 1px; background: var(--border); margin: 4px 0;
}
.http-row-menu-item.danger { color: var(--http-red); }
.http-row-menu-item.danger:hover { background: var(--http-red-bg); }
```

**JS mechanism.** New module embedded in `tab-http.js` (kept local to avoid an extra build step; if it grows past ~250 LoC extract to `src/frontend/js/http-row-menu.js`).

- Listener: `this._els.scroll.addEventListener('contextmenu', this._onRowContext)` in `_bindEvents` (`tab-http.js:499+`).
- `_onRowContext(e)`:
  ```js
  const row = e.target.closest('.http-row'); if (!row) return;
  e.preventDefault();
  const id = parseInt(row.dataset.id, 10);
  const req = this._findById(id);
  this._openRowMenu(e.clientX, e.clientY, req);
  ```
- `_openRowMenu(x, y, req)` builds DOM via a declarative menu spec:
  ```js
  const spec = [
    { section: 'Rules' },
    { id: 'block-url',     label: 'Block URL',         sub: req.url,                 kbd: 'b', dangerous: true },
    { id: 'block-domain',  label: 'Block Domain',      sub: this._domainOf(req.url), dangerous: true },
    { id: 'forge',         label: 'Forge Response…',                                kbd: 'f' },
    { id: 'modify',        label: 'Modify & Forward…' },
    { id: 'bp',            label: 'Set Breakpoint on URL…' },
    { sep: true },
    { section: 'Replay' },
    { id: 'replay',        label: 'Replay Request',                                kbd: 'r', confirmIfNotSafe: true },
    { id: 'replay-edit',   label: 'Replay with Edits…' },
    { sep: true },
    { section: 'Copy' },
    { id: 'copy-url',      label: 'Copy URL' },
    { id: 'copy-curl',     label: 'Copy as cURL' },
    { id: 'copy-fetch',    label: 'Copy as fetch' },
    { id: 'copy-ps',       label: 'Copy as PowerShell' },
    { sep: true },
    { section: 'Export' },
    { id: 'export-har',    label: 'Export as HAR entry' }
  ];
  ```
- Positioning: `el.style.left = Math.min(x, innerWidth - 240) + 'px'`. Repeat for y (flip to anchor bottom-right if near edge).
- Action dispatch: `_dispatchMenuAction(id, req)` switch statement. Block/Forge/Modify open the appropriate modal or detail tab; Copy calls `navigator.clipboard.writeText(this._formatAs(req, format))`; Export HAR delegates to existing `_exportAs('har', [req])` (extend the existing exporter to accept a single-row array).
- `_closeRowMenu()` on outside click, Escape, scroll, blur. Reuse the pattern from `_onDocClick` already in the file for the export dropdown.

**Source code path.**
- Event binding: `tab-http.js:499+` (`_bindEvents`).
- Menu impl: new block of methods after `_navigateRows` (around `tab-http.js:973`).
- Copy formatters: new `_formatAsCurl(req)`, `_formatAsFetch(req)`, `_formatAsPowerShell(req)` near `_exportAs` (`tab-http.js:1174`).

**Edge cases.**
- **Right-click on empty area** (no row) → menu does not open. Native browser menu suppressed only when over a row.
- **Replay of non-idempotent method** (POST/PUT/DELETE) → shows a confirm toast first (R9): "Replay POST /Tables? This may have side effects." with Confirm / Cancel. Implemented via `confirmIfNotSafe` flag.
- **Disconnected** → menu still opens but rule-creating items are disabled with a tooltip "MITM disabled — reconnect to use"; Copy/Export items remain enabled (they're client-only).
- **Authorization redacted** → Copy as cURL warns at the top: "Authorization header is redacted in this copy." (We never leak the real auth from the row, which only ever held redacted data per `_redactHeaders` `tab-http.js:131`.)
- **Menu near viewport edge** → auto-flip per `_positionMenu` logic above.

**Interactions with C01 / C03.**
- `Block URL` / `Block Domain` → `MitmCreateRule({ kind: 'block', predicate: { urlExact: req.url } })` (or `urlDomain`) → C01 stores rule → topic emits `rule-added`.
- `Forge Response…` → opens the Intercept detail tab in "forge composer" mode (see §4.2).
- `Modify & Forward…` → only meaningful for paused rows. If row is not paused, this item creates a one-shot breakpoint rule for that URL and surfaces a toast "Next call to this URL will pause for edits".
- `Set Breakpoint on URL…` → opens a small modal to choose request/response phase + scope (exact URL / domain / regex) → `MitmCreateRule({ kind: 'breakpoint', … })`.
- `Replay Request` → `MitmReplayRequest({ method, url, headers, body })`.
- `Export as HAR` → entirely client-side, reuses `_exportAs`.

**Keyboard / a11y.**
- `role="menu"` on container, `role="menuitem"` on each item.
- Open with `Shift+F10` on focused row (keyboard equivalent of right-click). Browser already maps this on Windows.
- Arrow keys navigate items, Enter activates, Escape closes.
- First item auto-focused on open.

**Priority:** `P0`.

---

## 4. Detail Panel — New "Intercept" Tab

### 4.1 — Intercept tab visibility `[P0]`

**Name + ID:** `S4.1 — Intercept tab` · `.http-detail-tab[data-dtab="intercept"]`
**One-liner:** A new detail tab appended after Headers, visible only when the selected row has an active MITM lifecycle.

**Detailed description.** The detail panel currently exposes four tabs (Request / Response / Timing / Headers, `tab-http.js:452–453`). F28 inserts the Intercept tab as the **fifth**, conditionally rendered: it appears when the selected row is paused at a breakpoint OR has a completed MITM lifecycle (forged/modified/blocked). When the tab becomes available it slides in from the right with a 180ms transform; the existing tab-strip `_dtabIndicator` (the underline that follows the active tab, `tab-http.js:990–999`) animates to it on focus. On rows without MITM lifecycle the tab is **hidden entirely** (not just disabled) so the tab strip stays uncluttered for the 99% of rows that are pure observation.

**Visual description.**

```
┌───────────────────────────────────────────────────────────────────────┐
│ Request │ Response │ Timing │ Headers │ Intercept                  ✕ │
│         │          │        │         │ ▔▔▔▔▔▔▔▔▔                    │  ← indicator
├───────────────────────────────────────────────────────────────────────┤
│  …Intercept tab content (§4.2)…                                       │
└───────────────────────────────────────────────────────────────────────┘
```

When the row is in PAUSED state, the Intercept tab is **auto-selected** on row click (overriding the default `request` tab), because the user almost certainly clicked it to deal with the pause.

**CSS approach.** New tab inherits `.http-detail-tab` styling. Auto-selection animation uses a temporary `.attention-pulse` class:

```css
.http-detail-tab[data-dtab="intercept"]:not(.visible) { display: none; }
.http-detail-tab.attention-pulse {
  animation: attention 800ms cubic-bezier(0.2,0.8,0.2,1) 1;
}
@keyframes attention {
  0%   { background: transparent; }
  30%  { background: var(--http-amber-bg); }
  100% { background: transparent; }
}
```

**JS mechanism.**
- Modify `_buildDetailPanel` (`tab-http.js:444–487`) to append two new tabs in the loop: `tabNames = ['Request','Response','Timing','Headers','Intercept','Replay']`, `tabIds = ['request','response','timing','headers','intercept','replay']`.
- Both new tabs get `style.display = 'none'` by default; class `http-detail-tab` plus dataset.
- New `_updateDetailTabVisibility(req)` called from `_openDetail`: toggles `.visible` on the Intercept/Replay tabs based on `req.mitmTag` and presence of `req.requestBodyPreview` / `req.responseBodyPreview` (Replay is available for any completed request).
- New renderer dispatch case in `_renderDetail` (`tab-http.js:1011–1025`): `case 'intercept': body.innerHTML = this._renderInterceptTab(req); break;`.
- When `_openDetail` is called for a paused row, set `this._detailTab = 'intercept'` before calling `_renderDetail`. Add `.attention-pulse` class for 800ms to draw the eye.

**Source code path.** `tab-http.js:444–487` (detail panel build), `tab-http.js:978–984` (`_openDetail`), `tab-http.js:1011–1025` (`_renderDetail` switch).

**Edge cases.**
- Row state transitions paused→modified while user is on the Intercept tab → tab stays selected, content re-renders to "Resolved" view (see §4.4).
- Row falls out of ring buffer while selected → tab becomes empty/error state with "Request no longer in buffer".

**Interactions with C01/C03.** Visibility derived purely from row `mitmTag` (which is itself derived from the `mitm` topic). No direct RPC.

**Keyboard / a11y.** Tab strip already supports keyboard via existing implementation (left/right arrows on focused tab). Append the new tabs and they inherit it.

**Priority:** `P0`.

---

### 4.2 — Intercept tab content (paused state) `[P0]`

**Name + ID:** `S4.2 — Intercept paused composer` · `.http-intercept-panel`
**One-liner:** When a request is paused at a breakpoint, this view shows the snapshot, decision buttons, timeout countdown, and an editable RequestEditor.

**Detailed description.** This is the most consequential UI surface in F28. Conceptually it is Burp's Intercept tab condensed into the detail panel: a **hero card** at the top showing the breakpoint metadata (URL, method, intercept ID, countdown timer) and **four decision buttons** prominently placed for quick keyboard-driven workflows. Below the hero is the embedded `RequestEditor` (§6) pre-populated with the paused request's snapshot — method, URL, headers, body all editable. Below the editor is a collapsed "Forge Response" composer (status code, headers, body) that expands when the user chooses the Forge action. The countdown timer ticks down in real time from the breakpoint's `timeoutMs` (default 30s per R1); on hitting zero the request is auto-forwarded and the tab transitions to "timed out" state. Decision buttons send `MitmResume` (C03) with the selected action and any modifications.

**Visual description.**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⏸  PAUSED                                          Auto-forward in 24s ⏱│
│ ─────────────────────────────────────────────────────────────────────── │
│  POST  /api/v1/onelake/Tables                          Rule: bp-7f3a    │
│  Intercept ID: ic-9281            Phase: request                         │
│                                                                          │
│  ┌──────────────┐ ┌──────────────────────┐ ┌───────────┐ ┌────────────┐ │
│  │   ▶ Forward  │ │ ✎ Modify & Forward   │ │ ✕ Block   │ │ ◆ Forge…  │ │
│  └──────────────┘ └──────────────────────┘ └───────────┘ └────────────┘ │
│       (Enter / Esc)         (Ctrl+Enter)        (Del)         (f)        │
├──────────────────────────────────────────────────────────────────────────┤
│ Snapshot (editable)                                                      │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ [POST▾] /api/v1/onelake/Tables                                       │ │  ← RequestEditor (§6)
│ │ ┌── Headers · Body · Query ──────────────────────────────────────┐  │ │
│ │ │ content-type:  application/json                                  │  │ │
│ │ │ authorization: [redacted]                       [👁 Reveal]      │  │ │
│ │ │ x-correlation: abc-123                                            │  │ │
│ │ └────────────────────────────────────────────────────────────────┘  │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│ ▾ Forge Response  (opens panel when Forge button or "f" pressed)        │
└──────────────────────────────────────────────────────────────────────────┘
```

**CSS approach.**

```css
.http-intercept-hero {
  padding: var(--space-4);
  background: linear-gradient(180deg, var(--http-amber-bg), transparent);
  border-bottom: 1px solid var(--border);
  display: grid;
  gap: var(--space-3);
}
.http-intercept-hero-title {
  display: flex; align-items: center; gap: var(--space-2);
  font-size: var(--text-lg); font-weight: 600;
  color: var(--http-amber);
}
.http-intercept-countdown {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-dim);
  display: inline-flex; align-items: center; gap: 4px;
}
.http-intercept-countdown.urgent { color: var(--http-red); font-weight: 700; }
.http-intercept-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0,1fr));
  gap: var(--space-2);
}
.http-intercept-btn {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-bright);
  background: var(--surface);
  cursor: pointer;
  transition: all var(--transition-normal);
}
.http-intercept-btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.http-intercept-btn .kbd { font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px; }
.http-intercept-btn.primary  { background: var(--accent); color: var(--text-on-accent); border-color: var(--accent); }
.http-intercept-btn.warn     { color: var(--http-amber); border-color: var(--http-amber); }
.http-intercept-btn.danger   { color: var(--http-red);   border-color: var(--http-red); }
.http-intercept-btn.forge    { color: var(--http-purple); border-color: var(--http-purple); }
.http-intercept-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

.http-reveal-auth {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: 8px;
  font-size: var(--text-xs);
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline dotted;
}
```

**JS mechanism.**

- New module `_renderInterceptTab(req)` returns full HTML for the panel.
- For paused state, payload comes from a per-intercept snapshot delivered via the `mitm` topic (C03) — fuller than the redacted `http`-topic version. Frontend caches paused snapshots in `this._pausedSnapshots = new Map()` keyed by `interceptId`.
- Embed `RequestEditor` (§6) by instantiating it into a div within the tab body:
  ```js
  this._interceptEditor = new RequestEditor(editorEl, { mode: 'paused', snapshot });
  ```
- Countdown timer: `setInterval` 250ms tick updates `.http-intercept-countdown` content. At T-5s, add `.urgent` class. Cleared on tab close, row change, or decision.
- Decision handlers:
  ```js
  _interceptDecision(action) {
    const mods = this._interceptEditor.getModifications();
    this._signalr.connection.invoke('MitmResume', this._pausedInterceptId, action, mods)
      .then(() => this._toast('ok', `Forwarded as ${action}`))
      .catch(err => this._toast('error', err.message));
  }
  ```
  - Forward → action=`"forward"`, mods=`null`.
  - Modify & Forward → action=`"modify"`, mods=editor diff.
  - Block → action=`"block"`, sets status 0.
  - Forge → opens the Forge composer inline; submit calls `MitmResume(id, "forge", { status, headers, body })`.
- **Reveal Auth toggle** — clicking `Reveal` opens a confirmation modal "Show real Authorization header? This will leave the FLT process via SignalR (R2)." On confirm, invokes `MitmGetUnredactedHeader(interceptId, 'Authorization')` (separate RPC, audit-logged server-side per R2). Reveal is a one-shot per intercept; the value is shown inline and never persisted in browser storage.

**Source code path.**
- `tab-http.js` — new `_renderInterceptTab`, `_interceptDecision`, `_startCountdown`, `_stopCountdown` after the existing detail renderers (`tab-http.js:1152+`).
- `request-editor.js` — new file (see §6).

**Edge cases.**
- **Timeout fires** while user is mid-edit → request auto-forwarded; UI transitions to "timed out" state showing what would have been applied as a discarded draft, with a "Replay with these edits" CTA (which fires §5 replay).
- **Connection drops mid-pause** → server-side, C01 cancels the breakpoint per R6 → topic emits `breakpoint-cancelled` → row transitions out of paused; UI shows banner "Connection lost; request forwarded untouched".
- **Body > 4KB on captured snapshot** → backend re-buffers up to 10MB per R3 when a paused snapshot is requested. Editor shows "Body truncated at 10MB" warning if hit.
- **User selects a different row while paused** → countdown stays running in the background; clicking back restores the editor state from `_pausedSnapshots` map.
- **No more recent snapshot** (intercept resolved between snapshot fetch and render) → show "Already resolved" state with link to the row.
- **Reveal Auth declined** → editor shows masked field as `••••••••••` and modifying it sends a `[keep-redacted]` sentinel that the backend interprets as "don't change the real value" (so users can edit other headers without forfeiting auth privacy).

**Interactions with C01/C03.**
- C03 topic event `breakpoint-hit` delivers the snapshot → C04 caches.
- C03 RPC `MitmResume(interceptId, action, modifications)` resolves the breakpoint.
- C03 RPC `MitmGetUnredactedHeader(interceptId, headerName)` gates the Reveal.
- C03 RPC `MitmDrop(interceptId)` for "kill this one intercept" — bound to a smaller `✕` icon in the hero (less prominent than the four big buttons).
- C01 coordinator authoritative on timeout; UI countdown is purely visual and may drift up to 250ms.

**Keyboard / a11y.**
- `Enter` = Forward, `Ctrl+Enter` = Modify & Forward, `Delete` = Block, `f` = Forge, `Escape` = Forward and close detail panel.
- All decision buttons are real `<button>` elements with `aria-label` and `aria-keyshortcuts`.
- Countdown timer announced via `aria-live="polite"` at 30s/15s/5s thresholds (not every tick — that would be obnoxious).
- Reveal Auth modal: focus-trapped, `aria-modal="true"`.

**Priority:** `P0`.

---

### 4.3 — Intercept tab content (resolved state) `[P1]`

**Name + ID:** `S4.3 — Intercept resolved view` · `.http-intercept-panel.resolved`
**One-liner:** Once a paused request has been resolved (forwarded/blocked/forged), the Intercept tab transitions to a read-only audit view.

**Detailed description.** After `MitmResume` succeeds, the tab swaps content to a compact summary: which action was chosen, who/what triggered the rule (rule id), what modifications were applied (diff format), and a "Re-arm" button that creates a new breakpoint rule with the same predicate so the next matching request also pauses. This makes the iteration loop tight — pause, fix, resume, re-arm to retest.

**Visual description.**

```
┌──────────────────────────────────────────────────────────────┐
│ ✎  MODIFIED — Forwarded                                       │
│ ────────────────────────────────────────────────────────────  │
│  POST  /api/v1/onelake/Tables                                 │
│  Rule: bp-7f3a       Decided 4.2s after pause                 │
│                                                                │
│  Modifications applied:                                       │
│    • headers["x-test-flag"] = "true"  (added)                 │
│    • body $.tableName: "old" → "new" (replaced)                │
│                                                                │
│  [↻ Re-arm same rule]    [↻ Replay with these edits]          │
└──────────────────────────────────────────────────────────────┘
```

**CSS approach.** Reuses `.http-detail-section` from the existing detail panel. Diff lines use `.http-diff-added` (green ▲) and `.http-diff-removed` (red ▼) tokens (`--http-green` / `--http-red`).

**JS mechanism.** Renderer is the same `_renderInterceptTab(req)` switching on `req.mitmTag !== 'paused'`. Re-arm button calls `MitmCreateRule({ kind: 'breakpoint', predicate: { urlExact: req.url, method: req.method } })`. Replay button invokes §5.

**Source code path.** Inside the same `_renderInterceptTab` block.

**Edge cases.** If `req.mitmModifications` is empty (just forwarded untouched), section is omitted. Diff rendering caps at 20 lines with a "show all" expander.

**Interactions with C01/C03.** Re-arm → `MitmCreateRule`. Replay → `MitmReplayRequest`.

**Keyboard / a11y.** Re-arm bound to `Shift+R`. Diff lines `role="listitem"`.

**Priority:** `P1`.

---

### 4.4 — Reveal Auth confirmation `[P0]`

**Name + ID:** `S4.4 — Reveal auth modal` · `.http-reveal-modal`
**One-liner:** A modal that requires explicit confirmation before unmasking the Authorization header in the editor.

**Detailed description.** Per risk R2, we never default to showing the real Authorization header. When the user clicks `[👁 Reveal]` next to the redacted field, a small modal appears explaining the trade-off (the value leaves the FLT process via SignalR), with a single-checkbox audit acknowledgement and a "Reveal Once" button. The reveal is per-intercept and never cached across reloads or to localStorage.

**Visual description.**

```
                       ┌────────────────────────────────────┐
                       │  ⚠ Reveal Authorization Header     │
                       │  ───────────────────────────────── │
                       │  The real value will be sent to    │
                       │  your browser via SignalR for      │
                       │  this paused intercept only.       │
                       │                                    │
                       │  [ ] I understand this is for      │
                       │      testing and will be audit-    │
                       │      logged.                       │
                       │                                    │
                       │     [Cancel]    [Reveal Once]      │
                       └────────────────────────────────────┘
```

**CSS approach.** Uses existing modal pattern (overlay + centered card with `--shadow-lg`); if no shared modal helper exists in `tab-http.css`, add one scoped to `.http-reveal-modal`.

**JS mechanism.** `_openRevealModal(interceptId, headerName) → Promise<string | null>`. Resolves to header value on confirm, null on cancel.

**Source code path.** Helper at end of `tab-http.js` after detail renderers.

**Edge cases.** If the backend rejects (capability disabled at request time), the modal closes with a toast "Reveal denied — capability disabled".

**Interactions.** C03 RPC `MitmGetUnredactedHeader(interceptId, headerName)`. Server-side audit logging is C01's job; frontend just calls.

**Keyboard / a11y.** Focus-trap, `aria-modal`, Escape cancels.

**Priority:** `P0`.

---

## 5. Detail Panel — New "Replay" Tab

### 5.1 — Replay tab `[P0]`

**Name + ID:** `S5.1 — Replay tab` · `.http-detail-tab[data-dtab="replay"]`
**One-liner:** For any completed request, a tab that hosts a `RequestEditor` pre-populated with the captured request, with a Send button that fires through the MITM-aware pipeline.

**Detailed description.** Replay is the testing-tool counterpart to "Resend" in Chrome DevTools, but routed through the FLT `HttpClient` pipeline so retries, auth, and headers behave like the real call — and so the replay shows up as a new row in the table (tagged `↻ REPLAYED`). The tab embeds the `RequestEditor` component (§6) in its full Send-button form. Headers default to the captured request's (with Authorization redacted unless the user reveals it). Body is editable raw text with JSON syntax highlighting. The Send button calls `MitmReplayRequest(snapshot)` (C03). Response renders **in-place** in a result area below the editor, with status code, latency, and body — exactly the same renderer the existing Response detail tab uses (`_renderResponseTab`, `tab-http.js:1054–1092`), so users get visual continuity.

**Visual description.**

```
┌──────────────────────────────────────────────────────────────────┐
│ [POST▾] /api/v1/onelake/Tables                       [Send] [×] │
│ ───────────────────────────────────────────────────────────────  │
│  Headers · Body · Query Params                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ content-type: application/json                              │  │
│  │ authorization: [redacted]                  [👁 Reveal]      │  │
│  │ + add header                                                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│ ─── Response ─────────────────────────────────────────────────── │
│  200 OK · 142ms · 8.2 KB                                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ {                                                            │  │
│  │   "value": [ … ]                                             │  │
│  │ }                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**CSS approach.** Reuses `.http-detail-section`, `.http-json`, the new `.req-editor-*` styles from §6.

**JS mechanism.**
- `_renderReplayTab(req)` → mounts a fresh `RequestEditor` instance and a response container.
- Editor seeded by `editor.setSnapshot({ method: req.method, url: req.url, headers: req.requestHeaders, body: req.requestBodyPreview })`.
- On Send: `editor.onSend = (snap) => this._doReplay(snap)`.
- `_doReplay(snap)`:
  ```js
  // For non-idempotent methods, confirm (R9):
  if (['POST','PUT','PATCH','DELETE'].includes(snap.method.toUpperCase())) {
    if (!await this._confirm(`Replay ${snap.method} ${snap.url}? This may have side effects.`)) return;
  }
  const result = await this._signalr.connection.invoke('MitmReplayRequest', snap);
  this._renderReplayResult(result);
  ```
- `_renderReplayResult(r)` populates the response container using `_renderResponseTab`-style HTML.
- The actual HTTP traffic generated by the replay flows back through the regular `http` topic with `mitm.action = "replay"` set, so a new row appears in the table with the `↻ REPLAYED` badge — closing the loop visually.

**Source code path.** `tab-http.js` — `_renderReplayTab` after `_renderInterceptTab`.

**Edge cases.**
- **Replay of a paused row** → not allowed (you can't replay a request that hasn't completed). Tab shows "Wait for resolution to replay" state.
- **Replay of a forged row** → allowed. The original captured request (pre-forge) is what gets replayed, NOT the forged response. Make this explicit in the UI: small "Original request (before forge)" subhead.
- **Server-side replay endpoint not implemented** (capability flag off) → Send button disabled, tooltip explains.
- **Large body** (>10MB) → Send blocked with error.

**Interactions.** C03 RPC `MitmReplayRequest(snapshot) → ReplayResult { statusCode, headers, body, durationMs }`. New row in `http` topic.

**Keyboard / a11y.** `Ctrl+Enter` sends; Escape closes detail. Send button is the default for the editor form (Enter inside URL input).

**Priority:** `P0`.

---

## 6. Embedded `RequestEditor` Component

### 6.1 — `RequestEditor` extraction `[P0]`

**Name + ID:** `S6.1 — RequestEditor` · `class RequestEditor` in `src/frontend/js/request-editor.js`
**One-liner:** A compact Send-button-less subset of `api-playground.js`'s `RequestBuilder`, sized to live inside the HTTP detail panel.

**Detailed description.** `RequestBuilder` in `api-playground.js:442–555` is the production-quality composer the Playground tab uses. F28 needs ~80% of it: method dropdown, URL field, Headers / Body / Query tabs, JSON editor. We do **not** want a full fork — we want a refactor that ships `RequestEditor` as a reusable class that both `RequestBuilder` (Playground) and the F28 detail panel embed. `RequestEditor` accepts a `mode` option (`'paused'` = no Send button, modifications tracked as a diff against the seed snapshot; `'replay'` = full editor with Send; `'compose'` = Playground's full feature set). API:

```js
const ed = new RequestEditor(containerEl, {
  mode: 'paused' | 'replay' | 'compose',
  snapshot: { method, url, headers, body, queryParams },
  redactedHeaders: ['authorization'],  // shown masked until revealed
  onSend: snap => { … },               // only for replay/compose
  onChange: snap => { … },             // fires on every keystroke
  onRevealRequest: headerName => Promise<string>  // C04 wires to MitmGetUnredactedHeader
});

ed.setSnapshot({...});        // reset
ed.getSnapshot();             // current full snapshot
ed.getModifications();        // diff vs seed for 'paused' mode
ed.dispose();                 // clean up listeners
```

**Visual description.** Identical to `RequestBuilder`'s url-bar + req-tabs + req-content shape (`api-playground.js:463–555`), minus the Send/Cancel/cURL/Save buttons in `paused` mode. In `replay` mode keeps Send + Cancel only. Adds a "Reveal" affordance on redacted header rows.

**CSS approach.** New file or section `src/frontend/css/request-editor.css` with `.req-editor-*` classes. Inherits design tokens; no duplication of `--http-*` colors (those are HTTP-tab-specific). Reuses the dot-color method pattern from `api-playground.js:483–484`.

**JS mechanism.**

- New file: `src/frontend/js/request-editor.js` exporting `class RequestEditor`.
- Internally a smaller `RequestBuilder` modeled on the existing one but:
  - no catalog dropdown,
  - no Auth tab (auth handled by Reveal flow at the Headers tab),
  - method/URL/Headers/Body/Query parsing identical,
  - emits `onChange` events (used by `_renderInterceptTab` to enable/disable the "Modify & Forward" button when the editor is dirty),
  - `getModifications()` produces a JSON-Patch-style array suitable for shipping to `MitmResume(interceptId, "modify", modifications)`.
- `RequestBuilder` in `api-playground.js` is then refactored to **wrap** `RequestEditor` with mode `'compose'` — keeping its public API identical so Playground doesn't regress.

**Source code path.**
- New: `src/frontend/js/request-editor.js`.
- New CSS section in `tab-http.css` (or new `request-editor.css` if the build picks both up).
- Refactor: `api-playground.js:442–555` to delegate to `RequestEditor`.

**Edge cases.**
- **Snapshot has duplicate headers** → preserved as separate rows; `getSnapshot()` returns the array form so we don't silently merge.
- **Body is non-text** → editor shows "Binary body (N bytes) — not editable" with a "Replace with text" CTA that swaps to an empty textarea.
- **JSON syntax error while editing** → small red glyph in the gutter, but never blocks Send (the user might intentionally want malformed JSON for testing).
- **Method change to GET while body has content** → warning toast "GET requests shouldn't have a body — keep anyway?" (testing-tool stance: warn, don't block).

**Interactions with C01/C03.** Editor is pure UI; it doesn't talk to backend. C04 mediates: `onSend` / `onChange` → C04 → C03 RPCs.

**Keyboard / a11y.**
- Tab order: method → URL → tab strip → tab content.
- Ctrl+Enter inside the URL or body field triggers `onSend` (when defined).
- Headers tab uses real `<table>` with row/col semantics.

**Priority:** `P0`.

---

## 7. Keyboard Shortcuts

### 7.1 — Global MITM shortcuts `[P0]`

**Name + ID:** `S7.1 — Keyboard shortcuts` · global key handler in `HttpPipelineTab`
**One-liner:** Five shortcuts (`b`, `r`, `f`, `Ctrl+Shift+K`, `Escape`) that drive MITM without ever touching the mouse.

**Bindings:**

| Keys             | Scope                                         | Action |
|------------------|-----------------------------------------------|--------|
| `b`              | Row selected, MITM enabled, not in text input | Toggle "Block URL" rule on the selected row's URL. Visual: row badge crossfades to `BLOCKED` if matched; toast "Blocking POST /Tables". Second press removes the rule. |
| `r`              | Row selected, completed request               | Replay the selected request through `MitmReplayRequest`. For non-idempotent methods, shows confirm. Replay result appears as a new row + the Replay detail tab auto-opens. |
| `f`              | Row selected, MITM enabled                    | Open the Forge composer for that URL. If not paused, creates a one-shot forge rule that fires on next match. |
| `Ctrl+Shift+K`   | Global, any state                             | **Kill switch.** Calls `MitmKillSwitch()` (C03) which clears ALL rules + resumes all paused intercepts untouched. Confirm toast: "Killed 5 rules, resumed 2 paused". |
| `Escape`         | Intercept tab active and row is paused        | Forward the paused request untouched (same as the `▶ Forward` button). |

All shortcuts are no-ops when focus is in a text input/textarea/contenteditable (use `e.target.closest('input,textarea,[contenteditable="true"]')` guard). Shortcuts respect `MitmGetCapabilities.enabled`.

**JS mechanism.** Extend the existing `_globalKeyHandler` referenced in `tab-http.js:71` (the activation hook). The handler today (search elsewhere in the file) handles `Ctrl+/` for search focus and `j/k` for row nav. F28 appends:

```js
_globalKeyHandler(e) {
  // existing handlers …
  if (e.target.closest('input,textarea,[contenteditable="true"]')) return;
  const isMac = navigator.platform.indexOf('Mac') > -1;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.shiftKey && e.key === 'K') { e.preventDefault(); this._killSwitch(); return; }
  if (!this._interceptOn && !this._mitmStats.rules) return;  // shortcuts inert if MITM off
  switch (e.key) {
    case 'b': if (this._selectedId != null) this._toggleBlockOnSelected(); break;
    case 'r': if (this._selectedId != null) this._replaySelected(); break;
    case 'f': if (this._selectedId != null) this._openForgeForSelected(); break;
    case 'Escape':
      if (this._detailTab === 'intercept' && this._isSelectedPaused()) {
        this._interceptDecision('forward');
      } else {
        this._closeDetail();
      }
      break;
  }
}
```

**Source code path.** Extend `_globalKeyHandler` (find via `tab-http.js` grep; bound in `activate()` `tab-http.js:71`). Helper methods (`_killSwitch`, `_toggleBlockOnSelected`, `_replaySelected`, `_openForgeForSelected`, `_isSelectedPaused`) added near the keyboard nav helpers.

**Edge cases.**
- **`Escape` collision** — existing `_closeDetail` already binds Escape. New behavior: if Intercept tab is active and row is paused, Escape → Forward. Otherwise → close detail. Documented in the inline help tooltip.
- **`b` collision with row-nav `j/k`** — none, `b` is new.
- **Kill switch confirmation** — single keypress immediately fires (no confirm modal) because the testing-tool stance values speed over guardrails, but always followed by a 5-second undo toast: "Killed 5 rules. [Undo]" — `Undo` re-pushes the cleared rules from the cached state.

**Interactions with C01/C03.**
- `Ctrl+Shift+K` → `MitmKillSwitch()` on hub → C01 clears all rules tagged with this session's connection ID + cancels all pending breakpoints.
- `b` → `MitmCreateRule({ kind: 'block', predicate: { urlExact } })` / `MitmDeleteRule(ruleId)`.
- `r` → `MitmReplayRequest`.
- `f` → see §3 forge flow.

**Keyboard / a11y.**
- Shortcuts documented in a discoverable cheat sheet: extend the existing help affordance (if any) with a `Shift+?` modal listing all shortcuts.
- `aria-keyshortcuts` attribute set on the relevant buttons in the Intercept hero and context menu so screen readers announce them.

**Priority:** `P0`.

---

## 8. Status Bar Integration

### 8.1 — Runtime View status bar pill `[P1]`

**Name + ID:** `S8.1 — Status bar MITM pill` · `.runtime-statusbar .mitm-status`
**One-liner:** A status-bar chip that shows MITM activity from any tab within Runtime View, plus a kill-switch shortcut.

**Detailed description.** Runtime View has a status bar at the bottom (or top, per the design bible) showing connection state, sequence counters, etc. When MITM is active on the HTTP tab, the status bar surfaces a compact chip `MITM: 3 rules, 1 paused` so users on the DAG / Errors / Logs tab don't miss that a breakpoint is waiting. Clicking the chip switches to the HTTP tab and auto-focuses the paused row (if any). Adjacent to it, a small red `⊘` kill-switch icon button fires the same action as `Ctrl+Shift+K`. When MITM is off and zero rules exist, the chip is **not rendered** (no visual debt).

**Visual description.**

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ● Connected · seq 14821          MITM: 3 rules, 1 paused  [⊘]         │
└──────────────────────────────────────────────────────────────────────────┘
                                    ▲ clickable: jump to HTTP tab + row
                                                                   ▲ kill switch
```

**CSS approach.** Same token vocabulary as §1.2 (the toolbar badge); paused state pulses amber. Kill-switch icon button colored `--http-red` with `:hover` background `--http-red-bg`.

**JS mechanism.** This lives **outside** `tab-http.js` (in the Runtime View shell). C04's responsibility is to **emit** the data via a small event:

```js
// HttpPipelineTab broadcasts every change via DOM CustomEvent on document
_emitMitmStats() {
  document.dispatchEvent(new CustomEvent('edog:mitm-stats', {
    detail: { rules: this._mitmStats.rules, paused: this._mitmStats.paused, enabled: this._interceptOn }
  }));
}
```

The Runtime View shell listens once on `document.addEventListener('edog:mitm-stats', …)` and renders/updates its chip. Click handler navigates to the HTTP tab + selects the oldest paused row.

**Source code path.**
- Emitter: `tab-http.js` — call `_emitMitmStats()` after each `_renderMitmStatus()`.
- Listener: Runtime View shell (likely `src/frontend/js/runtime-view.js` or similar) — actual wiring is owned by a sibling component spec (out of scope for C04, but the contract is defined here).

**Edge cases.**
- **Status bar absent** on small viewports → emitter still fires; nothing breaks.
- **Multiple HTTP tabs** (won't happen in current architecture, single tab instance) — but defensive: last emit wins.

**Interactions.** Pure DOM event bus; no C01/C03 traffic from this surface.

**Keyboard / a11y.** Chip is a `<button>` with `aria-label="MITM: 3 rules, 1 paused. Click to view."`. Kill-switch button has `aria-label="MITM kill switch"`.

**Priority:** `P1` (status bar shell may not exist yet; gracefully degrades if absent).

---

## 9. Cross-cutting concerns

### 9.1 — Loading and empty states
- **Capabilities pending** (first 100ms of tab life) → intercept toggle shows skeleton shimmer using existing `--skel-*` tokens.
- **No rows yet + MITM ON** → existing empty state (`tab-http.js:399–413`) gains a second-line hint "Intercept armed — first matching request will pause."

### 9.2 — Toast system
F28 needs short-lived toasts ("Forwarded", "Rule added", "Connection lost"). If a global toast helper exists, reuse it. Otherwise: define a minimal `_toast(level, msg)` on `HttpPipelineTab` using `--shadow-md` and the `--z-toast: 400` token. Levels: `'ok' | 'warn' | 'error'`.

### 9.3 — Persistence
**Nothing is persisted.** Per ADR + testing-tool stance + R6 + R10, MITM rules live entirely in the SignalR-connected session. On reload, all rules are gone. The Replay tab does not save its draft. This is intentional — keeps the tool safe and snapshot-free.

### 9.4 — Build (ADR-003)
- New file `src/frontend/js/request-editor.js` must be added to `scripts/build-html.py`'s JS source list **and** must appear in dependency order **before** `api-playground.js` and `tab-http.js`.
- New CSS (if a separate file) goes into the CSS list similarly. Recommended: append to `tab-http.css` instead to avoid an extra entry.

### 9.5 — Theming
All new styles use design tokens. Dark theme is automatic via the existing `[data-theme="dark"]` overrides — no per-component dark CSS needed if tokens are used correctly.

### 9.6 — Reduced motion
Every keyframe animation defined in this spec has a `@media (prefers-reduced-motion: reduce)` opt-out that disables the animation but preserves the end-state styling.

### 9.7 — Performance budget
- Row badge addition: O(1) per row, no extra reflow.
- Context menu: lazily built on first right-click.
- Countdown timer: one `setInterval` at 250ms while a paused row's Intercept tab is visible; cleared otherwise.
- `mitm` topic event throughput: bounded by C03 to <100 events/sec; same handler shape as `_onEvent`, no concern at this scale.

---

## 10. Implementation checklist (for the eventual coder spoke)

In rough order:

1. Add new state fields to `HttpPipelineTab` constructor (`tab-http.js:18+`): `_interceptOn`, `_mitmStats`, `_pausedSnapshots`, `_interceptIdIndex`.
2. Extend `_onEvent` to read the `mitm` block and populate `mitmTag` / `mitmInterceptId` / `mitmModifications`.
3. Add `_onMitmEvent` subscribed to `mitm` topic via `signalr.on('mitm', …)` + `signalr.subscribeTopic('mitm')`.
4. Build the intercept toggle (§1.1) and status badge (§1.2) into `_buildToolbar`.
5. Inject MITM badge into the status cell (§2.1) and row classes.
6. Implement the right-click menu (§3) and the copy formatters (cURL / fetch / PowerShell).
7. Extract `RequestEditor` (§6) into `src/frontend/js/request-editor.js`; refactor `RequestBuilder` to wrap it.
8. Add Intercept and Replay detail tabs (§4, §5) and their renderers.
9. Implement the Reveal-Auth modal (§4.4).
10. Extend `_globalKeyHandler` with `b`/`r`/`f`/`Ctrl+Shift+K`/`Escape` (§7).
11. Emit `edog:mitm-stats` CustomEvent (§8) for the status bar.
12. Pass capability gating into every new affordance.
13. Add CSS for everything to `src/frontend/css/tab-http.css` using only design tokens.
14. Update `scripts/build-html.py` source list if a new file was added.
15. Manual test against C01/C03 in dev; Sentinel-mandated unit tests for the row-state state machine and the `getModifications()` diff.

---

## 11. Open questions for P1 design sync

1. **Reveal Auth — should the modal show a per-key-prefix grant** (e.g. "reveal for all intercepts of this URL") or strictly one-shot? Current spec: strictly one-shot per intercept. Confirm.
2. **Status-bar location** — owned by which existing component? Confirm with Sana before implementation.
3. **`RequestBuilder` refactor risk** — does Playground have tests covering the affected surface? If not, gate via a feature flag `EDOG_USE_REQUEST_EDITOR=1` until parity is proven.
4. **HAR per-row export** — current `_exportAs('har')` exports all rows; need to confirm whether the single-row variant should produce a single-entry HAR file or copy as JSON to clipboard. Spec assumes single-entry HAR file.
5. **Forge composer reuse with Mock Server (F-future)** — should the Forge composer be its own component for reuse? Defer; in v1 keep it inline in the Intercept tab.

---

*End of C04 spec. Total surface: ~7 new sub-components, ~12 new keyboard interactions, 1 new module (`RequestEditor`), 1 new topic subscription (`mitm`), and ~9 new RPCs consumed (defined by C03). No new third-party deps. No persistence. Single-HTML build clean.*
