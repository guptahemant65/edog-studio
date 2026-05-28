# F28 — Context Menu State Matrix

> **Component:** Row Context Menu (right-click popover on traffic list rows)
> **Feature:** F28 HTTP MITM (simplified scope: MITM + Send to API Playground)
> **Author:** Pixel
> **Phase:** P3 — State Matrices
> **Surface:** `src/frontend/js/tab-http.js` (new `_openRowMenu` / `_closeRowMenu` / `_dispatchMenuAction` helpers), `src/frontend/css/tab-http.css` (new `.http-row-menu.*` selectors)
> **Sources:** C04 §3, mock `http-mitm.html` lines 583–594 (ctxMenu DOM)

---

## 0. Scope

The Context Menu is the floating popover that opens on right-click of any `.http-row` in the traffic list. It owns:

- Its **lifecycle animation** (open / close).
- **Item hover and activation** state.
- **Keyboard navigation** inside the menu (arrow keys, Enter, Esc).
- **Dismiss handling** (outside click, scroll, blur, Esc, item click).
- **Glass-morphism rendering** (backdrop blur, layered shadow).
- **Submenu** affordance (Copy as → cURL / fetch / PowerShell).

Menu items per simplified scope (mock + C04 §3.1):

```
Send to Playground             P
─────────────────────────────
Copy URL
Copy as cURL          Ctrl+Shift+C
Copy as fetch         ▸ (submenu)
─────────────────────────────
Block this URL                 b
─────────────────────────────
Save as HAR
Delete                          (destructive)
```

State IDs: `menu.<state>` for lifecycle; `menu.item.<state>` for per-item; `menu.submenu.<state>` for nested.

---

## 1. State Map

```
┌─ menu (lifecycle) ────────────────────────────────────────────────────┐
│  closed → opening → open → closing → closed                            │
│                  ↘ aborted (re-right-click on another row)             │
└────────────────────────────────────────────────────────────────────────┘
┌─ menu.item (per item, only when open) ────────────────────────────────┐
│  idle → hovered → activated → dispatching → (menu closes)              │
│              ↘ disabled (state-dependent: e.g. Block when disconnected)│
└────────────────────────────────────────────────────────────────────────┘
┌─ menu.submenu (only for items with submenus) ─────────────────────────┐
│  collapsed → intent-delay → expanded → collapsed                       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Lifecycle States (`menu.*`)

### 2.1 `menu.closed`

- **Entry conditions:** Default at tab load; previous menu closed; tab destruction.
- **Exit conditions:** `contextmenu` event on a `.http-row`; `Shift+F10` while a row has keyboard focus.
- **Visual:** No DOM in document (menu container lazily created on first open per C04 §9.7 — performance budget). If retained DOM is used, `display: none`.
- **Keyboard:** N/A (no menu present).
- **Data requirements:** None.
- **Transitions:** Right-click / `Shift+F10` → `opening`.
- **Error recovery:** N/A.

### 2.2 `menu.opening`

- **Entry conditions:** `contextmenu` event fired, `preventDefault()` called, row resolved via `e.target.closest('.http-row')`. The menu's positioning is computed (anchored to click `clientX/clientY` with edge auto-flip per C04 §3.1).
- **Exit conditions:** 120ms entrance animation completes → `open`; another right-click during animation → `aborted`.
- **Visual:** Menu renders at computed position. Initial style:
  ```css
  opacity: 0;
  transform: translateY(-2px) scale(0.98);
  transform-origin: top left;
  ```
  Animates to:
  ```css
  opacity: 1;
  transform: translateY(0) scale(1);
  transition: opacity 120ms, transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
  ```
  Backdrop layer (`.http-row-menu-backdrop`) is **not** added — context menus close on outside-click via a one-shot document listener, not a backdrop element (keeps content clickable behind).

  Glass-morphism:
  ```css
  .http-row-menu {
    background: var(--surface);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    border: 1px solid var(--border-bright);
    box-shadow: var(--shadow-md);
    border-radius: var(--radius-md);
  }
  ```
  In dark theme, `--surface` swaps to `rgba(24,24,28,0.85)` so the backdrop blur is visible.
- **Keyboard:** Inert during animation; keystrokes buffered for `open` state.
- **Data requirements:** Row snapshot (`req`) passed to menu spec builder. No active subscriptions.
- **Transitions:** `transitionend` → `open`; another `contextmenu` event on a different row → `aborted` → reopen with new row.
- **Error recovery:** If `getBoundingClientRect()` returns NaN (browser quirk in detached frames), fallback position `top: 100px, left: 100px`.

### 2.3 `menu.open`

- **Entry conditions:** Opening animation completed.
- **Exit conditions:** Item activated; outside click; `Esc`; scroll on the table viewport; window blur; tab change.
- **Visual:** Menu fully rendered (per the diagram below); first item auto-focused with `--accent-hover` background and an `outline: 1px solid var(--accent)` ring for keyboard discoverability.

  ```
  ┌──────────────────────────────────────────┐
  │  ▸ Send to Playground               P    │  ← focused, --accent-hover
  │ ──────────────────────────────────────── │
  │    Copy URL                              │
  │    Copy as cURL              Ctrl+Shift+C│
  │    Copy as fetch                       ▸ │  ← submenu indicator
  │ ──────────────────────────────────────── │
  │    Block this URL                   b    │
  │ ──────────────────────────────────────── │
  │    Save as HAR                           │
  │    Delete                                │  ← destructive, --http-red on hover
  └──────────────────────────────────────────┘
     width 240px · shadow-md · radius-md
  ```

- **Keyboard:**
  - `↑/↓` move focus between items (skipping separators and disabled items).
  - `Home` / `End` jump to first / last item.
  - `Enter` or `Space` activates the focused item → `item.activated`.
  - `Esc` → `closing` (no action).
  - `Tab` → `closing` (matches Windows/Chrome native context menu semantics; focus returns to row).
  - Single-character shortcut keys (`P`, `b`) activate the corresponding item without requiring focus first.
  - `→` on a submenu item → expand submenu (`submenu.expanded`).
  - `←` collapses submenu when one is expanded.
- **Data requirements:** Row snapshot; capability gating evaluated once at open time (subsequent capability changes don't mutate an open menu — closing+reopening reflects new state).
- **Transitions:**
  - Item click → `item.activated`.
  - Hover over item with submenu (e.g., Copy as fetch ▸) → `submenu.intent-delay` (150ms).
  - Outside-click / Esc / scroll / blur / tab change → `closing`.
- **Error recovery:** If the row that opened the menu is evicted from the buffer mid-menu (rare), all row-scoped items (Send to Playground, Block, Save as HAR, Delete) disable themselves with tooltip `"Source row no longer available"`. Copy URL still works (URL was captured into the menu spec at open time).

### 2.4 `menu.closing`

- **Entry conditions:** Any dismiss vector (outside-click / Esc / item-activated-and-completed / scroll / blur / window resize).
- **Exit conditions:** 100ms close animation completes → `closed`.
- **Visual:** Reverse animation:
  ```css
  opacity: 1 → 0;
  transform: scale(1) → scale(0.98) translateY(-2px);
  transition: 100ms cubic-bezier(0.4, 0, 1, 1);
  ```
- **Keyboard:** Inert.
- **Data requirements:** None.
- **Transitions:** `transitionend` → `closed`. Focus returns to the originating row (`row.focus()`).
- **Error recovery:** If `transitionend` doesn't fire within 200ms (rare browser bug), forced cleanup timer removes the DOM.

### 2.5 `menu.aborted`

- **Entry conditions:** `contextmenu` event fired on another row OR another part of the document while in `opening` or `open`.
- **Exit conditions:** Immediately reroute → `closed` → `opening` (with the new row).
- **Visual:** First menu snaps to opacity 0 instantly (no close animation); new menu opens normally.
- **Keyboard:** N/A.
- **Data requirements:** N/A.
- **Transitions:** → next cycle.
- **Error recovery:** N/A.

---

## 3. Item Sub-states (`menu.item.*`)

### 3.1 `menu.item.idle`

- **Entry conditions:** Default for every item when the menu first opens, except the first item which goes directly to `hovered` (keyboard focus default).
- **Exit conditions:** Mouse enters → `hovered`; keyboard focus moves to it → `hovered`.
- **Visual:** Default text color (`--text`), no background.
- **Keyboard:** N/A (no focus).
- **Data requirements:** N/A.
- **Transitions:** Hover/focus → `hovered`.
- **Error recovery:** N/A.

### 3.2 `menu.item.hovered`

- **Entry conditions:** Mouseover OR keyboard focus.
- **Exit conditions:** Mouseout (to another item or off menu); focus moves to another item.
- **Visual:**
  ```css
  .http-row-menu-item:hover,
  .http-row-menu-item:focus-visible {
    background: var(--accent-hover);
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  ```
  Destructive item (`Delete`) uses `--http-red-bg` instead of `--accent-hover`:
  ```css
  .http-row-menu-item.danger:hover { background: var(--http-red-bg); color: var(--http-red); }
  ```
- **Keyboard:** `Enter` / `Space` → `activated`. Arrow keys → defocus and focus another item.
- **Data requirements:** N/A.
- **Transitions:**
  - Click / Enter → `activated`.
  - Hover off → `idle` (mouse) or `idle` (focus moves away).
  - Item has submenu (e.g., Copy as fetch ▸) AND hovered for ≥150ms → submenu component transitions to `expanded`.
- **Error recovery:** N/A.

### 3.3 `menu.item.activated`

- **Entry conditions:** Click on item; Enter/Space on focused item; single-char shortcut (P, b, etc.) while menu is open.
- **Exit conditions:** Action dispatch resolves → menu closes; for destructive items requiring confirmation, transitions into a confirm sub-state first.
- **Visual:** Item flashes briefly:
  ```css
  .http-row-menu-item.activated {
    background: var(--accent);
    color: var(--text-on-accent);
    animation: item-flash 150ms ease-out;
  }
  ```
- **Keyboard:** Inert during dispatch.
- **Data requirements:** Row snapshot (already captured in menu spec at open time).
- **Transitions:**
  - Synchronous actions (Copy URL, Copy as cURL, etc.) → `dispatching` for ≤16ms → menu `closing`.
  - Async actions (Block creates a rule via `MitmCreateRule`) → `dispatching` until RPC resolves.
  - Destructive action (`Delete`) → before activation completes, requires a confirmation toast: `"Delete this captured request? [Delete] [Cancel]"` with a 4s grace period. Confirm → `dispatching`; cancel → menu closes without action.
- **Error recovery:** RPC failure → menu closes (don't keep menu open on failure — confusing UX); toast `"Failed: {err}"`; for `Block`, no row-state change.

### 3.4 `menu.item.dispatching`

- **Entry conditions:** Async action confirmed.
- **Exit conditions:** RPC resolves OR client-side action completes.
- **Visual:** Item shows inline spinner replacing its trailing shortcut: `▸ Block this URL  ⟳`. Menu doesn't close during dispatch (so user sees progress) — typically only visible for ~100–300ms.
- **Keyboard:** Esc cancels (calls `AbortController.abort()` on the underlying invocation if supported by signalr-manager).
- **Data requirements:** RPC payload.
- **Transitions:** Success → menu `closing`, success toast (`"Rule added"`, `"Copied to clipboard"`, `"Loaded into Playground"`). Failure → menu `closing`, error toast.
- **Error recovery:** Timeout (≥3s) → menu closes anyway with toast `"Timed out; retry?"`.

### 3.5 `menu.item.disabled`

- **Entry conditions:** Capability or runtime state prevents the action. Examples:
  - `Block this URL` disabled when SignalR disconnected (RPC unavailable) OR `MitmGetCapabilities.enabled === false`.
  - `Send to Playground` disabled when row is paused AND modifications editor has unsaved invalid input (defensive — prevents loading malformed snapshot).
  - `Save as HAR` disabled when row is in `paused` state with no response yet.
  - `Copy as cURL` always enabled (client-only).
- **Exit conditions:** Menu reopens with capability satisfied.
- **Visual:**
  ```css
  .http-row-menu-item[aria-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }
  ```
  Tooltip on hover (rendered via `title` attr or floating tip) explains why: e.g., `"Disconnected — reconnect to use"`.
- **Keyboard:** Skipped by arrow-key navigation (`↑/↓` jumps over disabled items).
- **Data requirements:** Capability snapshot at menu-open time.
- **Transitions:** N/A within an open menu (capability changes don't refresh an open menu).
- **Error recovery:** N/A.

---

## 4. Submenu Sub-states (`menu.submenu.*`) — for Copy-as items

### 4.1 `menu.submenu.collapsed`

- **Entry conditions:** Default. Submenu item not hovered/focused.
- **Exit conditions:** Hover begins on a submenu-bearing item; keyboard focus moves to it with `→`.
- **Visual:** Parent item shows `▸` glyph as trailing indicator.
- **Keyboard:** N/A.
- **Data requirements:** N/A.
- **Transitions:** Hover/focus on parent → `intent-delay`.
- **Error recovery:** N/A.

### 4.2 `menu.submenu.intent-delay`

- **Entry conditions:** Hover starts on submenu parent item; OR keyboard focus enters parent.
- **Exit conditions:** 150ms intent timer elapses → `expanded`; hover leaves parent before timer → back to `collapsed` (timer cancelled).
- **Visual:** Parent item in hover state; submenu not yet rendered.
- **Keyboard:** `→` short-circuits the timer and immediately expands.
- **Data requirements:** N/A.
- **Transitions:**
  - Timer fires → `expanded`.
  - Hover off → `collapsed`.
- **Error recovery:** N/A.

### 4.3 `menu.submenu.expanded`

- **Entry conditions:** Intent-delay elapsed; or `→` keyboard.
- **Exit conditions:** Hover moves to a non-submenu sibling; `←` keyboard; parent menu closes.
- **Visual:** Submenu pane (`.http-row-submenu`) flies out from the parent's right edge:
  ```
  ┌──────────────────────────────┐
  │ Send to Playground       P   │
  │ Copy URL                     │   ┌──────────────────────┐
  │ Copy as cURL    Ctrl+Shift+C │   │ as cURL              │
  │ Copy as fetch              ▸ │ ◀─┤ as fetch             │
  │ Block this URL           b   │   │ as PowerShell        │
  │ …                            │   │ as Python requests   │
  └──────────────────────────────┘   └──────────────────────┘
                                       same glass styling
                                       shadow-md, radius-md
  ```
  Animation: 100ms slide from `translateX(-4px), opacity 0 → 0,1`.
- **Keyboard:**
  - `↑/↓` navigate submenu items.
  - `Enter` activates submenu item → parent dispatches → both close.
  - `←` or `Esc` collapses submenu (returns focus to parent item).
- **Data requirements:** Same snapshot as parent menu.
- **Transitions:**
  - Item activated → parent menu `closing`.
  - Hover to a non-submenu sibling of parent → submenu `collapsed`, parent menu remains open.
- **Error recovery:** If submenu's `getBoundingClientRect()` extends past viewport, auto-flip to open on the left of the parent.

---

## 5. Per-Action Effect Reference

| Item | Activated effect | Closes menu? | Dispatch RPC |
|------|------------------|--------------|--------------|
| `Send to Playground` | Captures snapshot (modified if editing). Dispatches `edog:open-playground` CustomEvent. Switches root tab to Playground. Toast `"Loaded into API Playground"`. | Yes | None (local) |
| `Copy URL` | `navigator.clipboard.writeText(req.url)`. Toast `"URL copied"`. | Yes | None |
| `Copy as cURL` | `navigator.clipboard.writeText(_formatAsCurl(req))`. Toast `"Copied as cURL"`. Authorization header replaced with `[redacted]` unless previously revealed. | Yes | None |
| `Copy as fetch` | Submenu: cURL/fetch/PowerShell/Python. Each formatter at `_formatAsXxx(req)`. | Yes | None |
| `Block this URL` | Capability check → `MitmCreateRule({kind:'block', predicate:{urlExact:req.url}})`. Toast `"Blocking POST {url}"`. Row state will transition via topic event. | Yes | `MitmCreateRule` |
| `Save as HAR` | Single-row HAR file download via existing `_exportAs('har', [req])`. | Yes | None |
| `Delete` | Confirm toast `"Delete this captured request? [Delete] [Cancel]"`. Confirm → removes from local ring buffer only (does NOT affect server-side). Toast `"Request removed from view"` with `[Undo]` (5s). | Yes (after confirm) | None |

Notes:
- **No "Forge / Modify / Set Breakpoint"** items in the simplified scope — those live entirely inside the detail panel's Intercept tab. (Mock confirms: only Block, Playground, Copy, HAR, Delete.)
- **Replay** is also removed from the menu in simplified scope — Playground handles re-issuance.

---

## 6. Keyboard Map (full)

| Keys (menu state) | Action |
|-------------------|--------|
| `↑` / `↓` | Move focus to previous/next item (skipping separators + disabled) |
| `Home` | Focus first item |
| `End` | Focus last item |
| `→` | Expand submenu when focused item has one |
| `←` | Collapse submenu (or close menu if no submenu) |
| `Enter` / `Space` | Activate focused item |
| `Esc` | Close menu, return focus to row |
| `Tab` / `Shift+Tab` | Close menu, return focus to row (no tabbing into menu items per platform convention) |
| `P` | Activate "Send to Playground" (shortcut) |
| `b` | Activate "Block this URL" (shortcut) |
| Letter key matching first letter of item | Cycle focus through items starting with that letter (first-letter nav, à la native menus) |
| `Shift+F10` (on row with focus) | Opens menu at row's anchor (centered horizontally on row, below) |

---

## 7. Dismiss Conditions (full)

The menu closes when any of the following occur:

1. **Outside click** — a click anywhere outside `.http-row-menu` (and outside any open submenu).
2. **Escape key** — `Esc` while menu is open.
3. **Scroll on the table viewport** — `wheel` or `scroll` event on `.http-scroll`; menu closes immediately (don't track anchor on scroll).
4. **Window blur** — user switches windows/apps.
5. **Visibility change** — `document.visibilitychange` to hidden.
6. **Window resize** — close to prevent stale positioning.
7. **Item activation** — after the action dispatches (sync or async).
8. **Another right-click** — anywhere on the document: closes current, opens new (`aborted` path).
9. **Tab switch** — user navigates to a different EDOG tab (HTTP → DAG, etc.).
10. **SignalR disconnect** that disables all rule-creating items would still keep the menu open (informational), but the items individually become disabled.

All listeners are attached on `menu.opening` and removed on `menu.closing` (single-use semantic).

---

## 8. Glass-Morphism Rendering Requirements

Per design bible visual language:

```css
.http-row-menu,
.http-row-submenu {
  background-color: var(--surface);   /* light theme: rgba(255,255,255,0.78) */
                                       /* dark theme:  rgba(24,24,28,0.78)   */
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  border: 1px solid var(--border-bright);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.18),
    0 2px 6px rgba(0, 0, 0, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);  /* top edge highlight */
  border-radius: var(--radius-md);
}

@media (prefers-reduced-transparency: reduce) {
  .http-row-menu, .http-row-submenu {
    background-color: var(--surface-solid);   /* opaque fallback token */
    backdrop-filter: none;
  }
}

@supports not (backdrop-filter: blur(1px)) {
  .http-row-menu, .http-row-submenu {
    background-color: var(--surface-solid);
  }
}
```

Layered shadow gives a subtle floating sense without competing with the detail panel's heavier `--shadow-lg`. The inset highlight is the design bible's "lifted edge" pattern.

Performance: `backdrop-filter` is GPU-accelerated; menu is small (≤320×320px) so blur cost is negligible. Submenus inherit the same backdrop.

---

## 9. Cross-cutting Concerns

### 9.1 Disconnected
Menu still opens. RPC-dependent items (`Block this URL`) become `menu.item.disabled` with tooltip `"Disconnected — reconnect to use"`. Local items (Copy, Save as HAR, Delete, Send to Playground) remain enabled. Visual: dimmed items at `opacity: 0.4`.

### 9.2 Kill switch (`Ctrl+Shift+K`)
Menu closes immediately (covered by `Esc` / `visibility` listener). The kill switch toast surfaces normally.

### 9.3 Theme change
All colors are tokenized. Theme flip swaps `--surface`, `--border-bright`, `--accent`, `--http-red`, etc. — menu re-renders correctly on next open. An already-open menu mid-theme-change: backdrop and item colors update live via token inheritance (no JS re-render needed).

### 9.4 Panel resize
Menu position is anchored on `clientX/clientY` at right-click time. Panel resize during open closes the menu (per dismiss condition 6). On reopen, position is recomputed against the new layout.

### 9.5 Modal close
If the detail panel is in modal-floating shell, right-clicking a row in the traffic list still works (the modal is non-blocking). The context menu renders at the row's coordinates, not the modal's.

### 9.6 Multiple-rows-paused
Right-click works on any row, including paused ones. The "Block this URL" item is technically redundant for an already-paused row (the breakpoint already caught it) but still functional — it adds a persistent block rule that will fire on future calls. No special UI variation.

### 9.7 Accessibility
- `role="menu"` on the container.
- `role="menuitem"` (or `menuitemradio`/`menuitemcheckbox` if any toggle items added later) on each item.
- `aria-haspopup="menu"` on items with submenus.
- `aria-expanded` on submenu parents.
- `aria-disabled="true"` on disabled items.
- Initial focus on first non-disabled item.
- Focus trap WITHIN the menu (Tab leaves, doesn't trap — matches native menu UX).
- Single keystroke shortcut (`P`, `b`) work even without focusing the item, per native context-menu accelerator convention.
- High-contrast mode: the `outline` on hover/focus survives `forced-colors`; backdrop-filter is dropped (per `prefers-reduced-transparency`).

### 9.8 Memory
Menu DOM is created on first open and either:
- (a) reused for subsequent opens (preferred — single DOM tree, `display:none` between opens), OR
- (b) destroyed and recreated each time (simpler but more GC churn).

Per C04 §9.7, the lazy-create-then-reuse pattern is the implementation choice. Listeners installed on the document live only while menu is open.

---

## 10. State Transition Table (consolidated)

| From | Trigger | To | Notes |
|------|---------|----|-------|
| `menu.closed` | Right-click on row | `menu.opening` | clientX/Y captured |
| `menu.closed` | `Shift+F10` on focused row | `menu.opening` | Anchor centered on row |
| `menu.opening` | `transitionend` | `menu.open` | First item focused |
| `menu.opening` | Right-click elsewhere | `menu.aborted` → `opening` | Snap to new position |
| `menu.open` | Item click / Enter | `item.activated` | — |
| `menu.open` | `Esc` / outside / scroll / blur | `menu.closing` | — |
| `menu.open` | Shortcut key (`P`,`b`) | `item.activated` | Skip focus step |
| `menu.open` | `→` on submenu item | `submenu.intent-delay` → `expanded` | 150ms (0 for keyboard) |
| `menu.closing` | `transitionend` | `menu.closed` | Focus returns to row |
| `item.idle` | Hover / focus | `item.hovered` | — |
| `item.hovered` | Activate | `item.activated` | — |
| `item.activated` | Sync action done | (menu `closing`) | Toast surfaces |
| `item.activated` | Async (`Block`) | `item.dispatching` | RPC in flight |
| `item.dispatching` | RPC resolved | (menu `closing`) | Toast surfaces |
| `item.activated` (destructive) | Confirm toast | `item.dispatching` or back | — |
| `submenu.collapsed` | Hover parent | `submenu.intent-delay` | 150ms |
| `submenu.intent-delay` | Timer elapses | `submenu.expanded` | — |
| `submenu.intent-delay` | Hover off | `submenu.collapsed` | Timer cancelled |
| `submenu.expanded` | Item activated | (parent menu `closing`) | — |
| `submenu.expanded` | `←` / Esc | `submenu.collapsed` | Focus returns to parent |

---

## 11. State Inventory

1. `menu.closed`
2. `menu.opening`
3. `menu.open`
4. `menu.closing`
5. `menu.aborted`
6. `menu.item.idle`
7. `menu.item.hovered`
8. `menu.item.activated`
9. `menu.item.dispatching`
10. `menu.item.disabled`
11. `menu.submenu.collapsed`
12. `menu.submenu.intent-delay`
13. `menu.submenu.expanded`
14. `menu.confirm.shown` (delete-confirmation toast lifecycle — see below)
15. `menu.confirm.confirming`
16. `menu.confirm.cancelled`

### 11.1 Confirm sub-states (Delete)

- **`menu.confirm.shown`** — destructive item activated; menu is in `closing` but a confirmation toast is pinned. Entry: Delete clicked. Exit: user clicks Delete/Cancel in toast OR 4s grace elapses → auto-cancel.
- **`menu.confirm.confirming`** — user clicked Delete in toast; row removed from ring buffer; undo timer 5s. Entry: confirm. Exit: undo clicked (row restored) OR 5s elapses (commit final).
- **`menu.confirm.cancelled`** — user clicked Cancel or grace elapsed. Entry: cancel. Exit: immediately resolves (no-op).

**Total: 16 states** across lifecycle, item, submenu, and confirm layers.

---

## 12. Performance & Implementation Notes

- Menu DOM: 1 root + ~8 items + ~4 separators + 1 submenu container = ~15 nodes. Trivial.
- Backdrop-filter cost: ~0.4ms per frame on modern GPUs at 320×320px. Imperceptible.
- Document listeners on open: `click` (capture phase, outside-click), `keydown` (Esc + navigation + shortcuts), `scroll` on `.http-scroll`, `resize` on window, `visibilitychange` on document. All removed on close.
- First-letter nav: implemented by maintaining `items.map(i => i.label[0].toLowerCase())` and cycling on each letter press within 800ms.
- 60fps animation budget: open/close are GPU-composited (`opacity` + `transform`), no layout/paint.
- Lazy create: menu container DOM constructed on first `_openRowMenu` call, retained for tab lifetime, mutated per-open (item labels reflect current row context).

---

*End of context-menu state matrix.*
