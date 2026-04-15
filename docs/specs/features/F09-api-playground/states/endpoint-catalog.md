# Endpoint Catalog — State Matrix

> **Feature:** F09 API Playground
> **Component:** `EndpointCatalog` (searchable combobox dropdown)
> **States:** 7
> **Author:** Pixel (Frontend) + Sana Reeves (Architecture)
> **Companion:** `components/endpoint-catalog.md` (visual + data spec)
> **Status:** SPEC COMPLETE

---

## 1. State Inventory

| # | State ID              | Description                                                                        |
|---|-----------------------|------------------------------------------------------------------------------------|
| 1 | `closed`              | Dropdown collapsed to a compact trigger button; shows placeholder or last selection |
| 2 | `open`                | Dropdown panel visible with search field, all 10 groups, 37 endpoints               |
| 3 | `searching`           | User typing in search field; results filtered in real-time with match highlighting  |
| 4 | `no-results`          | Search query matches zero endpoints; empty-state message shown                      |
| 5 | `endpoint-hover`      | Mouse hovering over an endpoint item; details preview tooltip visible               |
| 6 | `endpoint-selected`   | User confirmed selection; Request Builder fields populated; dropdown closes          |
| 7 | `destructive-warning` | User chose a DELETE/Force endpoint; inline confirmation prompt displayed             |

---

## 2. State Transition Diagram

```
                         ┌─────────────────────────────────────────────────┐
                         │                  click / Ctrl+E                 │
                         ▼                                                 │
                  ┌─────────────┐                                          │
           ┌──── │   closed    │ ◀───────── auto-close after ─────────────┐│
           │     └─────────────┘            selection completes           ││
           │           ▲                                                  ││
           │           │ Escape / click outside                           ││
           │           │ (from any open sub-state)                        ││
           │     ┌─────────────┐                                          ││
           └───▸ │    open     │ ◀─── cancel ──── ┌─────────────────────┐ ││
                 └─────────────┘                  │ destructive-warning │ ││
                   │   │   │                      └─────────────────────┘ ││
                   │   │   │                         ▲           │        ││
                   │   │   │    Enter/click on        │       confirm     ││
                   │   │   │    dangerous endpoint    │           │        ││
                   │   │   └──────────────────────────┘           │        ││
                   │   │                                          ▼        ││
                   │   │  Enter/click               ┌─────────────────────┐││
                   │   │  on safe endpoint ────────▸│ endpoint-selected   │┘│
                   │   │                            └─────────────────────┘ │
                   │   │                                   ▲               │
                   │   │ mouse move                        │               │
                   │   │ over item     ┌────────────────┐  │ Enter/click   │
                   │   └──────────────▸│ endpoint-hover │──┘               │
                   │                   └────────────────┘                  │
                   │                      ▲                                │
                   │  typing              │ navigate to result             │
                   ▼                      │                                │
              ┌─────────────┐             │                                │
              │  searching  │─────────────┘                                │
              └─────────────┘                                              │
                   │   ▲                                                   │
                   │   │ typing resumes / clear search                     │
                   ▼   │                                                   │
              ┌─────────────┐                                              │
              │ no-results  │──────── Escape ──────────────────────────────┘
              └─────────────┘
```

**Transition summary (all valid edges):**

| From                    | To                      | Trigger                                       |
|-------------------------|-------------------------|-----------------------------------------------|
| `closed`                | `open`                  | Click trigger button, `Ctrl+E`, `Enter`/`Space` on focused trigger |
| `open`                  | `searching`             | Any printable character typed                  |
| `open`                  | `endpoint-hover`        | Mouse enters an endpoint row                   |
| `open`                  | `endpoint-selected`     | `Enter`/click on a safe endpoint (dangerLevel `safe` or `caution`) |
| `open`                  | `destructive-warning`   | `Enter`/click on a destructive endpoint (dangerLevel `destructive`) |
| `open`                  | `closed`                | `Escape`, click outside, `Tab` out             |
| `searching`             | `no-results`            | Filter returns zero matches                    |
| `searching`             | `endpoint-hover`        | Mouse enters a filtered result row             |
| `searching`             | `endpoint-selected`     | `Enter`/click on a safe filtered result        |
| `searching`             | `destructive-warning`   | `Enter`/click on a destructive filtered result |
| `searching`             | `open`                  | Search field cleared (Backspace to empty)       |
| `searching`             | `closed`                | `Escape`, click outside                        |
| `no-results`            | `searching`             | User modifies query (typing/backspace)         |
| `no-results`            | `open`                  | User clears search field entirely              |
| `no-results`            | `closed`                | `Escape`, click outside                        |
| `endpoint-hover`        | `open`                  | Mouse leaves endpoint row                      |
| `endpoint-hover`        | `endpoint-selected`     | Click or `Enter` on safe hovered endpoint      |
| `endpoint-hover`        | `destructive-warning`   | Click or `Enter` on destructive hovered endpoint |
| `endpoint-hover`        | `endpoint-hover`        | Mouse moves to a different endpoint row        |
| `endpoint-hover`        | `closed`                | `Escape`, click outside                        |
| `endpoint-selected`     | `closed`                | Automatic (dropdown closes after populating Request Builder) |
| `destructive-warning`   | `endpoint-selected`     | User clicks Confirm                            |
| `destructive-warning`   | `open`                  | User clicks Cancel                             |
| `destructive-warning`   | `closed`                | `Escape`, click outside (dismiss warning AND close) |

---

## 3. State Matrix Table

| State | Trigger (enter) | Visual Changes | Actions Available | Trigger (exit) | Notes |
|-------|-----------------|----------------|-------------------|----------------|-------|
| **`closed`** | Component mount; dropdown auto-close after selection; `Escape`/click outside from any open sub-state. | Compact trigger button (260×32px). No selection: label reads "▸ Select endpoint..." in `var(--text-muted)`. With selection: method pill (color-coded) + endpoint name displayed. Chevron `▾` right-aligned. Background `var(--surface-2)`, border `var(--border-bright)`, cursor `pointer`. | Click trigger → `open`. `Ctrl+E` → `open`. `Enter`/`Space` when trigger focused → `open`. | Click, `Ctrl+E`, `Enter`/`Space` → `open`. | Trigger button retains last selected endpoint display across open/close cycles. Focus ring shown when focused via keyboard (`2px solid var(--color-accent)`, 2px offset). |
| **`open`** | Click on trigger button; keyboard shortcut `Ctrl+E`; `Enter`/`Space` on focused trigger. | Dropdown panel appears (340px wide, max-height `min(480px, calc(100vh - 120px))`). Trigger button border changes to `var(--color-accent)`. Panel has `var(--surface)` background, `var(--shadow-lg)`, `var(--radius-md)` corners. Search input at top (auto-focused, placeholder "◇ Search endpoints..."). All 10 groups listed with headers (`var(--text-xs)` uppercase, `var(--text-muted)` color) and count badges. 37 endpoint rows: method pill (color-coded) + endpoint name. Destructive endpoints show red `◆` indicator. Vertical scrollbar if content overflows. Entry animation: scale(0.95)→scale(1) + opacity(0)→opacity(1) over 120ms ease-out. If a previous selection exists, that item has a subtle highlight (`var(--surface-2)` background). | Type → `searching`. Mouse over endpoint → `endpoint-hover`. Click/`Enter` safe endpoint → `endpoint-selected`. Click/`Enter` destructive endpoint → `destructive-warning`. Arrow keys navigate (focus ring on active item). `Escape` → `closed`. Click outside → `closed`. `Tab` → `closed`. Scroll via mouse wheel or trackpad. Click group header to collapse/expand group. | `Escape`, click outside, `Tab`, selection action, typing. | Arrow key navigation wraps: `↓` from last item returns to first; `↑` from first goes to last. `Home`/`End` jump to first/last endpoint. Focus follows arrow keys — scroll-into-view if item off-screen. Groups are collapsible via click on header; collapsed groups show `▸`, expanded show `▾`. |
| **`searching`** | Any printable character typed while `open` or `no-results`. | Search input shows typed query. Results list updates in real-time (no debounce — instant DOM filter). Matching substrings wrapped in `<mark>` with `var(--color-accent)` background and rounded corners. Groups with zero matching endpoints hidden entirely. Groups with partial matches show updated count badge (e.g., "DAG (3)" → "DAG (2)"). Footer bar appears: "{N} results" in `var(--text-muted)`. First matching endpoint receives automatic focus ring. | Continue typing to refine. `Backspace` to remove characters (empty → `open`). Arrow keys navigate filtered results. `Enter`/click safe result → `endpoint-selected`. `Enter`/click destructive result → `destructive-warning`. Mouse over result → `endpoint-hover`. `Escape` → `closed`. Click outside → `closed`. | Query → 0 matches: `no-results`. Clear field: `open`. Selection action. `Escape`/click outside. | Fuzzy search matches against: endpoint `name`, `url` path segments, and `group` label. Search is case-insensitive. `<mark>` highlight applies to each matching substring independently. ARIA live region (`aria-live="polite"`) announces result count changes for screen readers. |
| **`no-results`** | Search query produces zero endpoint matches. | Search input retains the query text. Endpoint list replaced by centered empty-state: "No endpoints found" in `var(--text-secondary)` (14px, weight 500). Below: "Try a different search term" in `var(--text-muted)` (12px, weight 400). Footer hidden (no count to show). Vertical space collapses to content height (~120px). | Continue typing / `Backspace` → `searching` (if matches resume). Clear field entirely → `open`. `Escape` → `closed`. Click outside → `closed`. | User modifies query, clears field, or dismisses. | If user pastes a new query that also has no results, state remains `no-results` with updated message. Empty-state text does NOT include the query string inline (privacy/cleanliness). |
| **`endpoint-hover`** | Mouse enters an endpoint row (in `open` or `searching` state). | Hovered row background transitions to `var(--surface-2)` (80ms ease). Cursor becomes `pointer`. Details tooltip appears after 300ms delay, anchored right of the dropdown panel (or left if insufficient viewport space). Tooltip shows: full URL with template variables highlighted, HTTP method badge (large, color-coded), endpoint description text, auth type pill ("Bearer" / "MWC" / "None"). Tooltip has `var(--surface)` background, `var(--shadow-md)`, `var(--radius-md)` corners, max-width 280px. Arrow indicator points to the hovered row. | Click → `endpoint-selected` (safe) or `destructive-warning` (destructive). `Enter` → same. Move mouse to different row → `endpoint-hover` (new row). Move mouse off row → `open`. `Escape` → `closed`. | Mouse leaves row, click, `Enter`, `Escape`, click outside. | Tooltip has 300ms entry delay to avoid flicker during fast mouse movement. Tooltip dismissed immediately on mouse leave (no exit delay). Keyboard arrow navigation also triggers hover-like details display (without tooltip — details shown in a dedicated panel region below the list instead). |
| **`endpoint-selected`** | `Enter`/click on safe endpoint (from `open`, `searching`, `endpoint-hover`); Confirm in `destructive-warning`. | Dropdown closes with exit animation: opacity(1)→opacity(0) over 80ms. Trigger button updates to show selected endpoint: method pill (color-coded per HTTP method) + endpoint name as label. Request Builder fields populated: Method dropdown set, URL input filled (template variables as `{placeholders}`), Authorization header added per endpoint `token` type, Body editor populated with `bodyTemplate` (or cleared for GET/DELETE). Brief flash highlight on trigger button (`var(--color-accent)` border pulse, 300ms) to confirm action. | None in this state — it is transient. Immediately transitions to `closed`. Request Builder becomes interactive for editing the populated fields. | Auto-close → `closed`. | Selection emits `catalog:select` custom event with full endpoint object. Request Builder receives event and calls `setRequest({ method, url, headers, body })`. If the endpoint has template variables (e.g., `{workspaceId}`), URL input shows them as editable placeholders with distinct styling. Focus moves to URL input after selection to encourage editing variables. |
| **`destructive-warning`** | `Enter`/click on a destructive endpoint (dangerLevel `destructive`). | Selected endpoint row expands to reveal inline warning panel. Warning panel: `var(--surface-danger)` background (red-tinted surface), 1px `var(--border-danger)` border. Icon: `◆` red diamond (12px) left-aligned. Text: "This endpoint performs a destructive operation. Continue?" in `var(--text-primary)` (12px). Two buttons right-aligned: "Cancel" (ghost style, `var(--text-muted)`) and "Confirm" (solid, `var(--danger)` red background, white text). Other endpoint rows remain visible but dimmed (opacity 0.5). Search input disabled while warning is active. | Click "Confirm" → `endpoint-selected`. Click "Cancel" → return to previous sub-state (`open` or `searching`). `Escape` → `closed` (dismiss warning AND close dropdown). Click outside → `closed`. `Enter` when "Confirm" focused → `endpoint-selected`. `Tab` cycles between Cancel and Confirm buttons. | Confirm, Cancel, `Escape`, click outside. | Warning applies to endpoints with `dangerLevel: "destructive"`: all DELETE methods plus "Force Unlock" endpoints. `dangerLevel: "caution"` endpoints (PATCH operations) do NOT trigger the warning — only a subtle caution icon. Keyboard focus traps within the warning panel (Cancel ↔ Confirm) until resolved. `Enter` defaults to Cancel (safe default) unless user explicitly tabs to Confirm. |

---

## 4. Compound States

Several states co-exist as sub-states of `open`. The following compatibility matrix defines which combinations are valid.

### 4.1 Compatibility Matrix

| Base State | `searching` | `no-results` | `endpoint-hover` | `destructive-warning` | Keyboard Nav Active |
|------------|:-----------:|:------------:|:-----------------:|:---------------------:|:-------------------:|
| `closed`   |      ✕      |      ✕       |        ✕          |          ✕            |         ✕           |
| `open`     |      ✓      |      ✕       |        ✓          |          ✓            |         ✓           |
| `searching`|      ─      |      ✓       |        ✓          |          ✓            |         ✓           |

**Legend:** ✓ = valid compound · ✕ = invalid / impossible · ─ = self (not applicable)

### 4.2 Compound State Details

#### `open` + `searching`

Search is a sub-state of open. The dropdown panel remains visible; only the content list changes. The search input captures all printable key events. Arrow key navigation operates on the filtered result set, not the full 37-endpoint list.

```
┌─────────────────────────────┐
│ open                        │
│  ┌───────────────────────┐  │
│  │ searching             │  │
│  │  ┌─────────────────┐  │  │
│  │  │ filtered list    │  │  │
│  │  │ with <mark> hits │  │  │
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

#### `searching` + `endpoint-hover`

User is searching AND hovering over a filtered result. The hover tooltip shows endpoint details for the filtered match. The search input retains focus for continued typing; hover is purely visual (mouse-driven). Keyboard arrow navigation and mouse hover can coexist — keyboard focus ring and mouse hover highlight may appear on different items simultaneously.

#### `open` + Keyboard Navigation Active

Arrow keys move a visible focus ring (`2px solid var(--color-accent)`, 2px offset) across endpoint rows. The focused item scrolls into view. `Enter` triggers selection on the focused item. Focus ring is distinct from mouse hover highlight (hover = background change, focus = outline ring). Both can be visible on the same or different items.

#### `searching` + `destructive-warning`

User searched for a term, found a destructive endpoint in filtered results, and selected it. The warning panel appears inline within the filtered list. The search input is disabled (no further typing until warning is resolved). The filtered result set remains visible behind the dimmed overlay.

### 4.3 Invalid Compound States

| Compound                              | Reason                                                    |
|---------------------------------------|-----------------------------------------------------------|
| `closed` + any sub-state              | Dropdown not visible; no sub-states possible              |
| `no-results` + `endpoint-hover`       | No endpoints rendered; nothing to hover                   |
| `no-results` + `destructive-warning`  | No endpoints rendered; nothing to select                  |
| `no-results` + keyboard nav           | No items to navigate                                      |
| `endpoint-selected` + any sub-state   | Selection is transient; dropdown closes immediately       |
| `destructive-warning` + `searching`   | Search input disabled while warning is active             |

---

## 5. Edge Cases

### 5.1 Search Field Cleared

**Scenario:** User types a query, sees filtered results, then deletes all characters via `Backspace` or `Ctrl+A` + `Delete`.

**Behavior:** State transitions from `searching` → `open`. Full 37-endpoint list restores. Group headers, counts, and scroll position reset to top. ARIA live region announces "37 endpoints" for screen readers.

### 5.2 Rapid Typing

**Scenario:** User types quickly (e.g., "get workspace" in under 200ms).

**Behavior:** No debounce. Every `input` event triggers an immediate DOM-based filter. Since filtering operates on a static in-memory array of 37 items and uses `textContent` matching + `style.display` toggling, performance is effectively instant (< 1ms per filter pass). No requestAnimationFrame batching needed.

### 5.3 Empty Catalog Data

**Scenario:** The endpoint catalog array contains zero entries.

**Behavior:** Impossible by design. The catalog is hardcoded with 37 endpoints defined in the component spec (`components/endpoint-catalog.md` §3.3). There is no dynamic loading, no API fetch, and no user-editable catalog. If a code error empties the array, the `open` state shows the empty-state message "No endpoints configured" — but this is a bug, not a user-facing scenario.

### 5.4 Template Variable Expansion Failure

**Scenario:** User selects an endpoint whose URL contains `{workspaceId}` but no workspace is configured.

**Behavior:** Not the Endpoint Catalog's concern. The catalog emits `catalog:select` with the raw endpoint definition. The Request Builder receives it and is responsible for rendering template variables as editable placeholders in the URL input. The no-config state belongs to Request Builder, not the catalog.

### 5.5 Click Outside During Destructive Warning

**Scenario:** `destructive-warning` is showing. User clicks outside the dropdown panel.

**Behavior:** Both the warning AND the dropdown are dismissed. State transitions directly from `destructive-warning` → `closed`. The destructive action is NOT executed (safe default). No selection is made. The trigger button retains its previous label (unchanged).

### 5.6 Escape During Destructive Warning

**Scenario:** User presses `Escape` while `destructive-warning` is visible.

**Behavior:** Same as click outside: warning dismissed, dropdown closed, no selection made. Single `Escape` press closes everything (no two-step dismiss).

### 5.7 Tab Key in Open State

**Scenario:** User presses `Tab` while the dropdown is open.

**Behavior:** Dropdown closes immediately (state → `closed`). Focus moves to the next focusable element in the toolbar (the URL input field). `Shift+Tab` closes and moves focus backward (to the element before the trigger button). The dropdown does NOT trap focus in normal `open`/`searching` states — only `destructive-warning` traps focus between Cancel and Confirm.

### 5.8 Re-opening After Selection

**Scenario:** User previously selected "Get Workspace". User opens the catalog again.

**Behavior:** The dropdown opens with the full endpoint list (not filtered). The previously selected endpoint "Get Workspace" has a persistent highlight: `var(--surface-2)` background + left accent border (`2px solid var(--color-accent)`). The dropdown scrolls to ensure the highlighted item is visible (centered vertically if possible). Keyboard focus starts on the highlighted item (not the first item).

### 5.9 Screen Reader / ARIA Compliance

**Roles and attributes:**

| Element              | ARIA                                                             |
|----------------------|------------------------------------------------------------------|
| Trigger button       | `role="combobox"`, `aria-expanded="true/false"`, `aria-haspopup="listbox"`, `aria-controls="endpoint-listbox"` |
| Search input         | `role="searchbox"`, `aria-label="Search endpoints"`, `aria-autocomplete="list"`, `aria-controls="endpoint-listbox"` |
| Dropdown panel       | `role="listbox"`, `id="endpoint-listbox"`, `aria-label="Endpoint catalog"` |
| Group header         | `role="group"`, `aria-label="{Group Name} — {count} endpoints"` |
| Endpoint row         | `role="option"`, `aria-selected="true/false"`, `id="endpoint-{id}"` |
| Active descendant    | `aria-activedescendant="endpoint-{id}"` on the combobox          |
| Result count         | `aria-live="polite"` region: "{N} endpoints match your search"  |
| Destructive warning  | `role="alertdialog"`, `aria-label="Destructive operation warning"`, `aria-describedby` pointing to warning text |

**Live region updates:**

- Opening: "Endpoint catalog open. 37 endpoints in 10 groups."
- Searching: "{N} endpoints match your search" (on every filter change).
- No results: "No endpoints match your search."
- Selection: "{Method} {Endpoint Name} selected. Request populated."
- Destructive warning: "Warning: destructive operation. Press Tab to choose Confirm or Cancel."

### 5.10 Method Pill Color Coding

Referenced across multiple states. Canonical color map:

| Method   | Pill Background        | Pill Text  |
|----------|------------------------|------------|
| `GET`    | `oklch(0.75 0.15 145)` | `#000`     |
| `POST`   | `oklch(0.70 0.15 250)` | `#fff`     |
| `PUT`    | `oklch(0.72 0.12 60)`  | `#000`     |
| `PATCH`  | `oklch(0.70 0.10 300)` | `#fff`     |
| `DELETE` | `oklch(0.65 0.20 25)`  | `#fff`     |

### 5.11 Destructive Endpoint Identification

Endpoints triggering `destructive-warning` (dangerLevel `destructive`):

| Group          | Endpoint           | Method   | Reason                          |
|----------------|--------------------|----------|---------------------------------|
| Workspace      | Delete Workspace   | `DELETE` | Permanently removes workspace   |
| Items          | Delete Item        | `DELETE` | Permanently removes item        |
| Lakehouse      | Delete Lakehouse   | `DELETE` | Permanently removes lakehouse   |
| Tables         | _(none)_           | —        | —                               |
| DAG            | _(none)_           | —        | —                               |
| Maintenance    | Force Unlock       | `POST`   | Overrides lock, may cause corruption |
| Maintenance    | Force Unlock DAG   | `POST`   | Overrides DAG lock              |
| Configuration  | _(none)_           | —        | —                               |
| Scheduling     | _(none)_           | —        | —                               |
| Health         | _(none)_           | —        | —                               |

---

## 6. State Lifecycle Summary

```
┌─────────┐                                ┌──────────────────────┐
│ closed  │─── click / Ctrl+E ───────────▸ │        open          │
│         │                                │                      │
│ trigger │◀── Escape / click outside ──── │  search input focused│
│ button  │◀── auto-close after select ─── │  37 endpoints listed │
│ visible │                                │  10 groups shown     │
└─────────┘                                └──────┬───┬───┬───────┘
                                                  │   │   │
                              ┌───────────────────┘   │   └──────────────────┐
                              ▼                       ▼                      ▼
                       ┌─────────────┐    ┌────────────────┐   ┌────────────────────┐
                       │  searching  │    │ endpoint-hover │   │ destructive-warning│
                       │             │    │                │   │                    │
                       │ <mark> hits │    │ tooltip w/     │   │ "Destructive op.   │
                       │ filtered    │    │ URL, method,   │   │  Continue?"        │
                       │ groups      │    │ description    │   │ [Cancel] [Confirm] │
                       └──────┬──────┘    └───────┬────────┘   └────┬──────┬────────┘
                              │                   │                 │      │
                              ▼                   │              cancel  confirm
                       ┌─────────────┐            │                 │      │
                       │ no-results  │            │                 │      ▼
                       │             │            │                 │  ┌──────────────────┐
                       │ "No         │            └─────────────────┼─▸│endpoint-selected │
                       │  endpoints  │                              │  │                  │
                       │  found"     │                              │  │ Request Builder  │
                       └─────────────┘                              │  │ populated        │
                                                                    │  └──────────────────┘
                                                                    │           │
                                                                    │      auto-close
                                                                    │           │
                                                                    └───────────┘
                                                                   (back to closed)
```

---

*End of state matrix — Endpoint Catalog.*
