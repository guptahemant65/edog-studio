# History & Saved Requests — State Matrix

> **Feature:** F09 API Playground — Section P1.4 History & Saved Requests
> **Component:** History & Saved Requests Sidebar
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend Engineer) + Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `components/history-saved.md`, `spec.md` §3 (Layout), `p0-foundation.md` §1.1 (CSS audit)
> **States Documented:** 9

---

## 1. State Inventory

| # | State ID | Description |
|---|----------|-------------|
| 1 | `expanded` | Sidebar visible at 280px width. Both History and Saved sections rendered. Default state on load. |
| 2 | `collapsed` | Sidebar hidden (36px collapsed strip). Content not visible. Toggle button centered in strip. |
| 3 | `empty-history` | History section has zero entries. Placeholder message shown. |
| 4 | `empty-saved` | Saved section has no user-created requests. Only built-in entries visible. Hint shown. |
| 5 | `history-full` | Circular buffer at 50-entry capacity. Next request auto-evicts oldest. Badge shows (50/50). |
| 6 | `saving-from-history` | Inline naming input visible after "Save as..." action on a history entry. |
| 7 | `context-menu-open` | Right-click context menu visible on a history or saved entry. |
| 8 | `filter-active` | Method filter dropdown and/or search text applied to history list. Active indicator shown. |
| 9 | `storage-warning` | localStorage approaching 5MB limit (4MB threshold). Amber warning banner at top of sidebar. |

---

## 2. State Transition Diagram

```
                          ┌─────────────────────────────────────────────────────────────────┐
                          │                         SIDEBAR                                  │
                          │                                                                  │
  ┌────────────┐  toggle  │  ┌─────────────────────────────────────────────────────────┐     │
  │            │◀─────────┤  │                    expanded (280px)                      │     │
  │ collapsed  │──────────▸  │                                                         │     │
  │  (36px)    │  toggle  │  │  ┌───────────────────────────────────────────────────┐  │     │
  │            │          │  │  │              HISTORY SECTION                       │  │     │
  │  Visible:  │          │  │  │                                                   │  │     │
  │  ▶ toggle  │          │  │  │  ┌─────────────┐    first      ┌──────────────┐  │  │     │
  │  only      │          │  │  │  │empty-history │──request────▸ │ has entries  │  │  │     │
  │            │          │  │  │  │  (0 entries) │              │  (1–49)      │  │  │     │
  └────────────┘          │  │  │  └─────────────┘   ◀──clear──  │              │  │  │     │
                          │  │  │                        │        └──────┬───────┘  │  │     │
                          │  │  │                        │               │ 50th     │  │     │
                          │  │  │                        │               │ entry    │  │     │
                          │  │  │                        │               ▼          │  │     │
                          │  │  │                        │        ┌──────────────┐  │  │     │
                          │  │  │                        │        │ history-full │  │  │     │
                          │  │  │                        ◀──clear─│  (50/50)     │  │  │     │
                          │  │  │                                 └──────────────┘  │  │     │
                          │  │  │                                                   │  │     │
                          │  │  │  Right-click entry ──▸ ┌────────────────────┐     │  │     │
                          │  │  │                        │ context-menu-open  │     │  │     │
                          │  │  │  ◀── click outside ─── │  Replay            │     │  │     │
                          │  │  │                        │  Save as...        │     │  │     │
                          │  │  │                        │  Copy as cURL      │     │  │     │
                          │  │  │                        └────────┬───────────┘     │  │     │
                          │  │  │                                 │ "Save as..."   │  │     │
                          │  │  │                                 ▼                │  │     │
                          │  │  │                        ┌────────────────────┐     │  │     │
                          │  │  │                        │saving-from-history │     │  │     │
                          │  │  │                        │  [name input____]  │     │  │     │
                          │  │  │  ◀── Enter / Escape ── │  Enter=save        │     │  │     │
                          │  │  │                        │  Escape=cancel     │     │  │     │
                          │  │  │                        └────────────────────┘     │  │     │
                          │  │  │                                                   │  │     │
                          │  │  │  Filter click ──▸ ┌─────────────────┐            │  │     │
                          │  │  │                   │  filter-active   │            │  │     │
                          │  │  │  ◀── clear ────── │  "12 of 50"     │            │  │     │
                          │  │  │                   └─────────────────┘            │  │     │
                          │  │  └───────────────────────────────────────────────────┘  │     │
                          │  │                                                         │     │
                          │  │  ┌───────────────────────────────────────────────────┐  │     │
                          │  │  │              SAVED SECTION                         │  │     │
                          │  │  │                                                   │  │     │
                          │  │  │  ┌─────────────┐    user saves    ┌───────────┐  │  │     │
                          │  │  │  │ empty-saved  │───a request───▸ │ has custom │  │  │     │
                          │  │  │  │ (built-in    │                 │ entries   │  │  │     │
                          │  │  │  │  only)       │ ◀──delete all── │           │  │  │     │
                          │  │  │  └─────────────┘                 └───────────┘  │  │     │
                          │  │  │                                                   │  │     │
                          │  │  │  Right-click saved ──▸ context-menu-open          │  │     │
                          │  │  │   (Replay, Rename, Delete, Copy as cURL)          │  │     │
                          │  │  └───────────────────────────────────────────────────┘  │     │
                          │  │                                                         │     │
                          │  └─────────────────────────────────────────────────────────┘     │
                          │                                                                  │
                          │  ┌─────────────────────────────────────────────────────────┐     │
                          │  │              storage-warning (overlay)                    │     │
                          │  │  Appears when localStorage usage ≥ 4MB                   │     │
                          │  │  Amber banner at top of sidebar content                  │     │
                          │  │  Can coexist with ANY expanded content state              │     │
                          │  └─────────────────────────────────────────────────────────┘     │
                          └─────────────────────────────────────────────────────────────────┘
```

---

## 3. State Matrix Table

| State | Trigger (enter) | Visual Changes | Actions Available | Trigger (exit) | Notes |
|-------|-----------------|----------------|-------------------|----------------|-------|
| **expanded** | (a) Initial page load (default). (b) User clicks collapsed toggle (▶). (c) User presses `Ctrl+H` while collapsed. | Sidebar width transitions from 36px → 280px (`transition: width var(--transition-normal)`). `.api-sidebar[data-collapsed="false"]`. Content wrapper `.api-sidebar-content` opacity transitions 0 → 1, `pointer-events: auto`. Both History and Saved sections rendered. Toggle icon shows ◀. Border-left: `1px solid var(--border)`. | Toggle collapse (◀ button / `Ctrl+H`). Scroll history list. Scroll saved list. Click history entry (replay). Click saved entry (replay). Right-click entry (context menu). Filter history. Clear history. Section collapse/expand (▾ chevrons). + Save button. | User clicks ◀ toggle or presses `Ctrl+H` → `collapsed`. | Parent state for all content states. Sidebar always participates in grid layout — collapsed or expanded. `data-collapsed` attribute on `.api-sidebar` drives CSS. |
| **collapsed** | (a) User clicks ◀ toggle button. (b) User presses `Ctrl+H` while expanded. (c) `edog-api-sidebar-state.collapsed === true` on load. | Sidebar width transitions 280px → 36px. `.api-sidebar[data-collapsed="true"]`. Content wrapper opacity → 0, `pointer-events: none`, `overflow: hidden`. Only the ▶ toggle button visible, centered vertically (`left: 50%; top: 50%; transform: translateX(-50%)`). Tooltip on hover: "Show History & Saved (Ctrl+H)". Toggle icon `.toggle-icon` gets `transform: rotate(180deg)` (◀ becomes ▶). | Click ▶ toggle to expand. Press `Ctrl+H` to expand. | User clicks ▶ toggle or presses `Ctrl+H` → `expanded`. | Content states are not visible but their data persists in memory. History continues to record requests while collapsed. Collapsed state saved to `edog-api-sidebar-state.collapsed` in localStorage. |
| **empty-history** | (a) First load — no entries in `edog-api-history` localStorage key. (b) User clicks "Clear" button and confirms. (c) User clears history while `filter-active` (filter also clears). | History list `.api-history-list` contains single centered placeholder: "No requests yet. Send a request to start building history." Text styled: `color: var(--text-muted); font-size: var(--text-xs); text-align: center; padding: var(--space-6) var(--space-3)`. Filter bar visible but controls dimmed (`opacity: 0.4; pointer-events: none`). "Clear" button hidden. History count badge shows "0". | Section collapse/expand. Interact with Saved section. Toggle sidebar. | First API request completes → `request-completed` event from ApiPlayground parent → entry added → list renders → exits `empty-history`. | Filter bar is deliberately shown (provides layout stability). Count badge reads "0" — gives user expectation of where count will appear. |
| **empty-saved** | (a) User has no custom saved requests (all user-created entries deleted). (b) Fresh install — only built-in catalog entries present. | Built-in groups (Fabric, FLT, Maintenance) rendered normally with ◆ indicators. Custom group shows: "(empty — save a request)". Hint text below Custom group: "Right-click a history entry to save it." styled `color: var(--text-muted); font-size: 9px; font-style: italic; padding: var(--space-2) var(--space-3)`. | Click built-in entries to replay. Right-click built-in entries (Replay, Copy as cURL only — no Rename/Delete). Section collapse/expand. Toggle sidebar. + Save button (saves current Request Builder state). | User saves a request (from history "Save as..." or + Save button) → custom entry created → exits `empty-saved`. | Built-in entries (`isBuiltIn: true`) are always present — they come from the endpoint catalog. Users cannot delete built-in entries. `empty-saved` means zero `isBuiltIn: false` entries. |
| **history-full** | 50th entry added to history (circular buffer reaches capacity). | Count badge updates to show "(50/50)" with monospace font. Badge background changes to `var(--surface-3)` with subtle emphasis. No blocking UI — eviction is automatic and silent. When 51st request completes: oldest entry removed from bottom of list (fade-out, 100ms), new entry inserted at top (slide-in, 150ms). Animations prevent jarring visual jump. | All standard history actions (replay, right-click, filter, clear). No special actions needed — auto-eviction is transparent. | "Clear" button clicked → empties to `empty-history`. Manual deletion of entries → drops below 50 → exits `history-full`. | Auto-eviction: when a new entry arrives and buffer is full, `array.pop()` removes oldest, `array.unshift()` inserts newest. This happens before DOM update so the user sees a smooth transition. No confirmation needed for eviction. |
| **saving-from-history** | (a) User right-clicks history entry → context menu → "Save as..." (b) User clicks ★ (save star) on hover of history entry. | Context menu dismisses (if open). Inline text input appears directly below the history entry that triggered it. Input pre-populated with URL path segment (e.g., "List Workspaces" derived from URL, or fallback to `METHOD /path`). Input element: `<input type="text" class="save-name-input">` — full width of sidebar minus padding, border: `1px solid var(--accent)`, background: `var(--surface)`, font: `var(--font-body)`, size: `var(--text-xs)`. Focus is set automatically on the input (`input.focus(); input.select()`). Below input: small label "Group: Custom" in `var(--text-muted)`. | Type name. Press `Enter` → save request to Custom group, input removes, saved entry appears in Saved section. Press `Escape` → cancel, input removes. Click outside input → cancel. | `Enter` key → save + exit. `Escape` key → cancel + exit. Click outside → cancel + exit. Blur event on input (after 150ms debounce to allow button clicks) → cancel + exit. | Saved request inherits: method, URL, headers, body from the history entry. Response data is NOT saved (only request shape). Name must be 1–80 chars and unique within the Custom group. Duplicate name → inline error below input: "A request with this name already exists." Input border turns `var(--level-error)`. |
| **context-menu-open** | (a) User right-clicks a history entry. (b) User right-clicks a saved entry. (c) User clicks ⋯ (more button) on hover. | Context menu rendered as `<div class="api-context-menu" role="menu">` positioned absolutely near the click point. Menu has `background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-md); padding: var(--space-1) 0; min-width: 160px; z-index: 100`. Menu items are `<button role="menuitem">` with hover: `background: var(--accent-dim)`. **History entry menu:** Replay, Save as..., Copy as cURL. **Saved entry menu (custom):** Replay, Rename, Delete, Copy as cURL. **Saved entry menu (built-in):** Replay, Copy as cURL. Focused entry has subtle highlight: `background: var(--surface-3)`. | Click "Replay" → populate Request Builder with entry data, dismiss menu. Click "Save as..." → dismiss menu, enter `saving-from-history`. Click "Copy as cURL" → copy formatted cURL command to clipboard, show toast "Copied to clipboard", dismiss menu. Click "Rename" → inline rename input on saved entry, dismiss menu. Click "Delete" → confirm dialog ("Delete 'Name'?"), dismiss menu on confirm. Arrow keys navigate menu items. `Escape` dismisses. | Click any menu item → action + dismiss. Click outside menu → dismiss. Press `Escape` → dismiss. Scroll event on parent → dismiss. | Menu positioning uses edge detection: if menu would overflow viewport bottom, render above the click point. If overflow right, shift left. Menu is a singleton — opening a new context menu auto-closes any existing one. `contextmenu` event is prevented (`e.preventDefault()`) on history/saved items. Menu traps focus — `Tab` cycles within menu items. |
| **filter-active** | (a) User selects a method from filter dropdown (e.g., "GET" instead of "All Methods"). (b) User types in search input (if search is implemented in filter bar). | Filter dropdown `.api-history-filter-select` shows selected method (non-"ALL" value). Active indicator: dropdown border changes to `var(--accent)`, background gets subtle accent tint. Count label updates to show filtered result: "Showing 12 of 50" displayed below filter bar in `color: var(--text-muted); font-size: 9px; font-family: var(--font-mono)`. History list filters in-place — non-matching entries get `display: none` (instant, no animation). If filter yields zero results: centered message "No GET requests in history." | Change filter method. Clear filter (select "All Methods"). Interact with filtered entries (replay, right-click, etc.). All standard history actions on visible entries. | User selects "All Methods" → filter clears → exit `filter-active`. User clears history → filter also clears → exit to `empty-history`. | Filter state saved to `edog-api-sidebar-state.historyFilter` in localStorage. Filter persists across page reloads. Filter applies to visible list only — underlying `edog-api-history` array is never mutated by filter. Filter does NOT affect the Saved section. |
| **storage-warning** | localStorage usage reaches 4MB threshold. Calculated on `request-completed` event by checking `navigator.storage.estimate()` or summing key sizes. | Amber warning banner appears at the very top of `.api-sidebar-content` (before History section). Banner: `background: var(--row-warning-tint); border-bottom: 1px solid var(--level-warning); padding: var(--space-2) var(--space-3); font-size: var(--text-xs); color: var(--level-warning)`. Text: "Storage nearly full. Consider clearing old history." Dismiss button (✕) at right of banner. Banner does not scroll — fixed at top with `position: sticky; top: 0; z-index: 2`. | Dismiss banner (✕ button) — banner hidden for session, reappears on next page load if still over threshold. Click "Clear" on history to free space. Delete saved requests. | Storage drops below 4MB (after clearing history or deleting saved entries) → banner auto-removes. User dismisses banner (hides for current session only). | Threshold: 4MB of 5MB localStorage quota. Calculation: `JSON.stringify(localStorage).length` as rough estimate (checks all edog-prefixed keys). Warning is non-blocking — all sidebar functionality remains available. If localStorage reaches 5MB: history recording stops silently, error toast shown once: "Storage full — history recording paused. Clear old entries to resume." Saved requests remain functional (reads succeed, new saves may fail with toast). |

---

## 4. Compound States

Many states can coexist simultaneously. The following compatibility matrix defines which combinations are valid.

### 4.1 Compatibility Matrix

| | expanded | collapsed | empty-history | empty-saved | history-full | saving-from-history | context-menu-open | filter-active | storage-warning |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **expanded** | — | ✕ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **collapsed** | ✕ | — | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| **empty-history** | ✓ | ✕ | — | ✓ | ✕ | ✕ | ✕ | ✕ | ✓ |
| **empty-saved** | ✓ | ✕ | ✓ | — | ✓ | ✕ | ✓ | ✓ | ✓ |
| **history-full** | ✓ | ✕ | ✕ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| **saving-from-history** | ✓ | ✕ | ✕ | ✕ | ✓ | — | ✕ | ✓ | ✓ |
| **context-menu-open** | ✓ | ✕ | ✕ | ✓ | ✓ | ✕ | — | ✓ | ✓ |
| **filter-active** | ✓ | ✕ | ✕ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| **storage-warning** | ✓ | ✕ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |

**Legend:** ✓ = can coexist, ✕ = mutually exclusive, — = self

### 4.2 Key Compound State Scenarios

#### Fresh Install

```
expanded + empty-history + empty-saved
```

First launch. Sidebar is open. History section shows "No requests yet" placeholder. Saved section shows only built-in entries with "Right-click a history entry to save it." hint. No filter active, no storage concern.

#### Filtering a Full History

```
expanded + history-full + filter-active
```

User has 50 history entries and applies a method filter (e.g., "GET"). Count label shows "Showing 12 of 50". Badge still shows "(50/50)" on the History section header (total count, unfiltered). Filter only hides DOM elements — buffer is still full. New requests still trigger auto-eviction even while filter is active.

#### Right-Click During Storage Warning

```
expanded + context-menu-open + storage-warning
```

Amber warning banner is sticky at top of sidebar. User right-clicks a history entry below the banner. Context menu opens normally. Banner remains visible. If user clicks "Save as..." from the context menu while the storage warning is active, the save may fail if localStorage is completely full (5MB) — in that case, inline error: "Storage full. Clear history first." The warning banner is not dismissed by the context menu interaction.

#### Saving from a Full History

```
expanded + history-full + saving-from-history
```

Buffer is at 50/50. User right-clicks a history entry and selects "Save as...". Inline naming input appears. While the user is typing a name, new requests can still arrive and trigger auto-eviction of the oldest entry. If the entry being saved is the oldest entry and it gets evicted during naming, the save operation should still succeed — the request data was captured when the naming dialog opened.

#### Full History with Filter and Storage Warning

```
expanded + history-full + filter-active + storage-warning
```

Maximum compound state for the History section. Amber banner at top. Filter showing "Showing 8 of 50". Badge at "(50/50)". All three overlay/modifier states active simultaneously. The sidebar remains fully functional — filter, context menu, replay all work.

#### Context Menu on Saved Entry (Empty History)

```
expanded + empty-history + empty-saved + context-menu-open
```

Not possible. `empty-history` means no history entries to right-click. `empty-saved` means no custom entries. Built-in entries CAN show a context menu, so the valid compound state is:

```
expanded + empty-history + context-menu-open  (on a built-in saved entry)
```

This IS valid because built-in entries are always present.

### 4.3 Why `collapsed` Cannot Coexist

When the sidebar is `collapsed`, the content wrapper has `opacity: 0; pointer-events: none`. No content states are visible or interactive. However, underlying data states persist silently:

- History continues recording (events fire, `edog-api-history` localStorage updates)
- Auto-eviction continues if buffer is full
- Storage usage continues accumulating
- Filter selection persists in memory

When the user re-expands, the sidebar renders with the current data state — possibly entering `history-full`, `storage-warning`, or other content states immediately.

### 4.4 Why `saving-from-history` and `context-menu-open` Cannot Coexist

`saving-from-history` is entered FROM `context-menu-open` via the "Save as..." action. The context menu dismisses before the naming input appears. They are sequential, not simultaneous. If the user right-clicks while the naming input is open, the naming input is cancelled (blur event fires) before the new context menu opens.

---

## 5. Edge Cases

### 5.1 localStorage Full (5MB Limit)

**Scenario:** `localStorage` has reached its 5MB quota. `setItem()` calls throw `QuotaExceededError`.

**Behavior:**
1. History recording stops — new `request-completed` events are silently dropped (no history entry created).
2. Error toast shown once per session: "Storage full — history recording paused. Clear old entries to resume."
3. Existing history entries remain readable and replayable.
4. Saved requests remain functional for reads. New save attempts show inline error: "Storage full. Clear history to free space."
5. `edog-api-sidebar-state` writes wrapped in try/catch — collapse state may not persist if quota exceeded.
6. The `storage-warning` banner remains visible (it was shown at 4MB).

**Recovery:** User clicks "Clear" on history or deletes saved requests. After clearing, a `setItem` test is performed. If it succeeds, history recording resumes automatically. Toast: "Storage freed — history recording resumed."

### 5.2 User Deletes All Saved Requests

**Scenario:** User deletes every custom saved request via context menu → Delete.

**Behavior:**
1. Each delete triggers a confirmation: "Delete '{name}'?"
2. After last custom entry deleted, Custom group shows "(empty — save a request)".
3. Sidebar enters `empty-saved` state.
4. Built-in entries (Fabric, FLT, Maintenance groups) are unaffected — they cannot be deleted.
5. `edog-api-saved` localStorage key is updated to contain only `isBuiltIn: true` entries.

### 5.3 Clear History While Filter is Active

**Scenario:** User has `filter-active` (e.g., showing only GET requests) and clicks "Clear".

**Behavior:**
1. Confirmation dialog: "Clear all history? This removes all 50 entries, not just the 12 currently shown."
2. On confirm: ALL history entries are removed (not just filtered ones).
3. Filter resets to "All Methods" — `filter-active` exits.
4. Sidebar enters `empty-history`.
5. Filter bar controls dim (`opacity: 0.4; pointer-events: none`).
6. Count labels reset.

**Rationale:** Clearing only filtered entries would be confusing. "Clear" means clear everything. The confirmation message explicitly mentions the total count to prevent surprises.

### 5.4 Replay While Another Request is In-Flight

**Scenario:** User clicks a history entry to replay while the Request Builder already has a pending request.

**Behavior:**
1. The replay populates the Request Builder form (method, URL, headers, body) immediately — this is a form-fill operation, not a send.
2. The in-flight request is NOT cancelled. It continues to completion.
3. The user must explicitly click "Send" in the Request Builder to fire the replayed request.
4. If the user clicks "Send" while the previous request is still in-flight, the previous `fetch()` is aborted via `AbortController.abort()`, and the new request replaces it.
5. Visual feedback in Request Builder: if a request is in-flight, the "Send" button shows a spinner and reads "Cancel" — clicking it aborts the current request before the replay can be sent.

**Rationale:** Replay = populate form. Send = explicit action. This prevents accidental request storms from rapid replay clicks.

### 5.5 Context Menu Positioning Near Screen Edges

**Scenario:** User right-clicks a history entry near the bottom or right edge of the viewport.

**Behavior:**
1. Menu dimensions are measured after render (before making visible): `menu.getBoundingClientRect()`.
2. **Bottom overflow:** If `clickY + menuHeight > viewportHeight`, menu renders above the click point: `top = clickY - menuHeight`.
3. **Right overflow:** If `clickX + menuWidth > viewportWidth`, menu shifts left: `left = clickX - menuWidth`.
4. **Corner overflow:** Both adjustments apply simultaneously.
5. **Top overflow (rare):** If menu would overflow top of viewport, clamp to `top: 4px`.
6. Menu always renders within the viewport — never clipped or hidden behind edges.

**Implementation:** Position calculation runs in `requestAnimationFrame` after the menu is added to the DOM with `visibility: hidden`, measured, then repositioned and shown with `visibility: visible`.

### 5.6 Keyboard Navigation Through History/Saved Lists

**Scenario:** User navigates the sidebar without a mouse.

**Behavior:**

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Sidebar focused | Cycles through: toggle button → History section toggle → filter dropdown → Clear button → history list → Saved section toggle → + Save button → saved groups. |
| `↑` / `↓` | History list focused (`role="listbox"`) | Moves `aria-selected` and focus between history entries. Scrolls into view if needed. |
| `↑` / `↓` | Saved group focused (`role="listbox"`) | Moves focus between saved entries within the group. |
| `Enter` | History entry focused | Replay: populate Request Builder with entry data. |
| `Enter` | Saved entry focused | Replay: populate Request Builder with entry data. |
| `Shift+F10` | Entry focused | Open context menu (equivalent to right-click). |
| `Delete` | History entry focused | Remove entry from history (with confirmation). |
| `Delete` | Custom saved entry focused | Delete entry (with confirmation). |
| `Escape` | Context menu open | Dismiss context menu, return focus to entry. |
| `Escape` | Naming input open | Cancel save, remove input, return focus to entry. |
| `Home` | List focused | Jump to first entry. |
| `End` | List focused | Jump to last entry. |
| `Ctrl+H` | Anywhere in API Playground | Toggle sidebar collapsed/expanded. |

Focus management: When the sidebar expands, focus moves to the last-focused element within the sidebar (or the History section header if no prior focus). When the sidebar collapses, focus moves to the toggle button.

### 5.7 localStorage Unavailable (Private Browsing)

**Scenario:** `localStorage` is unavailable (Safari private browsing, or storage disabled by policy).

**Behavior:**
1. On sidebar initialization, test localStorage with a probe write: `localStorage.setItem('edog-probe', '1'); localStorage.removeItem('edog-probe');`.
2. If the probe throws, set `_storageAvailable = false`.
3. One-time notice banner at top of sidebar: "Private browsing detected — history will not persist across sessions." Banner style: `background: var(--surface-3); color: var(--text-muted); font-size: 9px; padding: var(--space-2) var(--space-3)`. Dismissible (✕ button).
4. History works in memory only — `_historyEntries[]` array, max 50 entries, same circular buffer logic. All UI interactions work identically. History is lost on page refresh.
5. Saved requests: built-in entries are hardcoded and always available. User-created saves work in memory only — lost on refresh. Save dialog shows additional note: "This request will not persist (private browsing)."
6. Sidebar state (collapse, section toggles, filter) works in memory — not persisted.

**Rationale:** Graceful degradation. The sidebar is fully functional within the session. The user is informed once and can choose to continue or switch to a non-private window.

### 5.8 Rapid Save: Duplicate Name Prevention

**Scenario:** User saves the same request twice in quick succession, or saves two different requests with the same name.

**Behavior:**
1. When the user presses `Enter` in the naming input, the save handler:
   - Trims whitespace from the name.
   - Checks for existing entry with same name (case-insensitive) in the Custom group.
   - If duplicate found: inline error below input: "A request with this name already exists." Input border turns `var(--level-error)`. Input retains focus. User can edit the name.
2. The save button / Enter key is debounced (200ms) to prevent double-submit from rapid key presses.
3. If the user somehow bypasses the debounce (e.g., by clicking ★ on the same entry rapidly), the second save is silently deduplicated — the existing entry is updated (overwrite) rather than creating a duplicate.
4. After a successful save, the ★ button on the originating history entry changes to a filled star (★ → ★ with `color: var(--accent)`) indicating "already saved". Clicking the filled star again shows a toast: "Already saved as '{name}'." — no duplicate creation.

**Deduplication key:** `name.toLowerCase().trim()` within the Custom group. Built-in entries are in separate groups and cannot conflict with custom names.
