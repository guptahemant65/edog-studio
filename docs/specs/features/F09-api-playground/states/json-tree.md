# JSON Tree Renderer — State Matrix

> **Feature:** F09 — API Playground
> **Component:** `JsonTreeRenderer`
> **Source:** `src/frontend/js/json-tree.js`
> **CSS:** `src/frontend/css/json-tree.css`
> **Parent:** Response Viewer ("Pretty" mode tab)
> **Owner:** Pixel (Frontend Engineer)
> **Total states:** 11
> **Companion:** `components/json-tree.md` (deep component spec)
> **Status:** SPEC COMPLETE

---

## Table of Contents

1. [State Inventory](#1-state-inventory)
2. [State Transition Diagram](#2-state-transition-diagram)
3. [State Matrix Table](#3-state-matrix-table)
4. [Compound States](#4-compound-states)
5. [Edge Cases](#5-edge-cases)

---

## 1. State Inventory

| # | State ID | Description |
|---|----------|-------------|
| S01 | `tree.empty` | Component mounted, no JSON data provided. Blank or minimal placeholder shown. |
| S02 | `tree.rendering` | Initial render in progress for large payloads (>1000 nodes). Progress indicator visible, UI not interactive. |
| S03 | `tree.rendered` | Tree fully visible and interactive. All features active. Default expand depth: level 2. |
| S04 | `tree.collapsed-all` | All nodes collapsed. Only root `{` or `[` visible with item count badge. |
| S05 | `tree.expanded-all` | All nodes expanded to maximum depth. Performance warning possible for deep trees. |
| S06 | `tree.expanded-to-level` | Nodes expanded to a specific depth (1, 2, or 3). Deeper nodes collapsed. |
| S07 | `tree.searching` | Search active. Matches highlighted with `<mark>`, non-matching branches dimmed. |
| S08 | `tree.no-search-results` | Search query yielded zero matches. All nodes dimmed, inline "no matches" message shown. |
| S09 | `tree.copy-flash` | Transient state (200ms). Value copied — green flash animation and toast notification. |
| S10 | `tree.large-warning` | Data exceeds 500 KB. Warning banner visible. Truncation may be active. |
| S11 | `tree.virtualized` | Data has >5000 visible nodes. Virtual scroll active — only viewport nodes in DOM. |

---

## 2. State Transition Diagram

```
                         data received
                        (small payload)
                    ┌─────────────────────────┐
                    │                         │
                    │                         ▼
              ┌───────────┐            ┌─────────────┐
              │           │  data recv │             │
    ──init──▸ │   empty   │──(large)──▸│  rendering  │
              │   (S01)   │            │    (S02)    │
              └───────────┘            └──────┬──────┘
                    ▲                         │ render
                    │ new data                │ complete
                    │ (reset)                 ▼
              ┌─────┴───────────────────────────────────────────────────┐
              │                                                         │
              │                     ┌─────────────┐                     │
              │        ┌───────────▸│  rendered    │◂───────────┐       │
              │        │            │    (S03)     │            │       │
              │        │            └──┬──┬──┬──┬──┘            │       │
              │        │               │  │  │  │               │       │
              │        │  Collapse All │  │  │  │ Expand All    │       │
              │        │               ▼  │  │  ▼               │       │
              │        │  ┌──────────────┐│  │┌──────────────┐  │       │
              │        │  │ collapsed-all││  ││ expanded-all │  │       │
              │        ├──│    (S04)     ││  ││    (S05)     │──┤       │
              │        │  └──────────────┘│  │└──────────────┘  │       │
              │        │        ▲         │  │        ▲         │       │
              │        │        │         │  │        │         │       │
              │        │        └─────────┼──┼────────┘         │       │
              │        │     Collapse All │  │ Expand All       │       │
              │        │                  │  │                  │       │
              │        │    depth select  │  │                  │       │
              │        │                  ▼  │                  │       │
              │        │      ┌────────────────────┐            │       │
              │        ├──────│ expanded-to-level   │────────────┤       │
              │        │      │       (S06)         │            │       │
              │        │      └────────────────────┘            │       │
              │        │                                        │       │
              │   search cleared                    search cleared      │
              │        │                                        │       │
              │        │      ┌─────────────┐                   │       │
              │        └──────│  searching  │◂──────────────────┘       │
              │               │    (S07)    │     search input          │
              │               └──────┬──────┘     + typing             │
              │                      │                                  │
              │               no matches                                │
              │                      ▼                                  │
              │          ┌──────────────────────┐                       │
              │          │  no-search-results   │                       │
              │          │       (S08)          │                       │
              │          └──────────────────────┘                       │
              │                                                         │
              └─────────────────────────────────────────────────────────┘

  ╔═══════════════════════════════════════════════════════════════════════╗
  ║  OVERLAY / CONCURRENT STATES (can activate from any rendered state)  ║
  ╠═══════════════════════════════════════════════════════════════════════╣
  ║                                                                     ║
  ║  ┌──────────────┐   value clicked     (transient, 200ms)            ║
  ║  │  copy-flash  │◂── from any ──▸ returns to previous state         ║
  ║  │    (S09)     │    rendered state                                  ║
  ║  └──────────────┘                                                   ║
  ║                                                                     ║
  ║  ┌──────────────┐   data > 500 KB     (persistent overlay)          ║
  ║  │ large-warning│◂── activates ──▸ remains until new data           ║
  ║  │    (S10)     │    alongside S03–S08                               ║
  ║  └──────────────┘                                                   ║
  ║                                                                     ║
  ║  ┌──────────────┐   nodes > 5000      (persistent overlay)          ║
  ║  │ virtualized  │◂── activates ──▸ remains until new data           ║
  ║  │    (S11)     │    alongside S03–S08                               ║
  ║  └──────────────┘                                                   ║
  ╚═══════════════════════════════════════════════════════════════════════╝
```

### Key Transition Rules

- `empty` is the initial and reset state — any new data transitions out of it.
- `rendering` is entered only for payloads with >1000 nodes; small payloads skip directly to `rendered`.
- `collapsed-all`, `expanded-all`, and `expanded-to-level` are mutually exclusive sub-states of the interactive tree. They all derive from `rendered`.
- `searching` can be entered from any interactive state (`rendered`, `collapsed-all`, `expanded-all`, `expanded-to-level`).
- `copy-flash` is always transient (200ms auto-return) and overlays any active state.
- `large-warning` and `virtualized` are persistent overlays that remain until data changes.
- Receiving new data from **any** state resets to `empty` then immediately transitions to `rendering` or `rendered`.

---

## 3. State Matrix Table

### S01: `tree.empty`

No data to render. Component mounted, awaiting JSON.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | (1) Component constructed, no `render()` called. (2) `render()` called with `null`/`undefined`. (3) `destroy()` called. |
| **Visual** | Empty container with no visible content. Container element has `data-state="empty"` attribute. If parent Response Viewer provides a placeholder, that is shown instead (e.g., "Send a request to see the response"). Tree toolbar (Collapse All, Expand All, depth selector, search) hidden or disabled. Breadcrumb bar hidden. |
| **Actions available** | None — no tree to interact with. Parent can call `render(json)` to transition out. |
| **Trigger (exit)** | `render(json)` called with valid JSON. If parsed node count > 1000 → `tree.rendering`. If ≤ 1000 → `tree.rendered`. |
| **Notes** | Memory is minimal in this state — no DOM nodes, no parsed data structures. Container should have `min-height: 200px` to prevent layout shift when data arrives. |

---

### S02: `tree.rendering`

Large payload being rendered progressively via `requestAnimationFrame` batching.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | `render(json)` called with data that produces >1000 nodes after parsing. Rendering scheduled via `requestAnimationFrame` batches. |
| **Visual** | Container shows a thin indeterminate progress bar (2px height, `--color-accent` blue, sliding gradient animation) at the top of the tree area. Below the bar: "Rendering N nodes..." text in `--color-text-secondary` (12px). Partial tree may be visible below as batches complete — nodes appear in chunks of 200. Tree toolbar disabled (greyed out). Breadcrumb bar hidden. |
| **Actions available** | None — UI is not interactive during render. Scroll is disabled. Click events ignored. `Escape` cancels render and shows whatever has been built so far (transition to `rendered` with partial data). |
| **Trigger (exit)** | All batches complete → `tree.rendered`. User presses `Escape` → `tree.rendered` (partial). New `render()` call → restart (re-enter `tree.rendering` with new data). |
| **Notes** | Batch size is 200 nodes per `requestAnimationFrame`. For a 3000-node payload, expect ~15 frames (~250ms at 60fps). Progress text updates with each batch: "Rendering 600 of 3000 nodes...". |

---

### S03: `tree.rendered`

Tree fully visible and interactive. Default state after successful render.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | (1) Render complete (from `tree.rendering`). (2) Small payload rendered synchronously (from `tree.empty`). (3) Search cleared (from `tree.searching`). (4) Intermediate expand/collapse state returns here as base. |
| **Visual** | Full tree visible with default expand depth of level 2. Root node expanded, its direct children expanded, deeper nodes collapsed with `▸` toggle and item count badge (e.g., `▸ {...} 5 keys`, `▸ [...] 12 items`). Syntax coloring active: strings `oklch(0.72 0.17 145)` green, numbers `oklch(0.72 0.15 250)` blue, booleans `oklch(0.72 0.15 310)` purple, `null` `oklch(0.55 0 0)` grey, keys in `--color-text-primary`. Line numbers visible (if enabled). Toolbar active: `[Collapse All]` `[Expand All]` `[Depth: 2 ▾]` `[⌕ Search]`. Breadcrumb bar visible, empty until hover/focus. Container `data-state="rendered"`. |
| **Actions available** | Click `▸`/`▾` toggle to expand/collapse individual nodes. Click any value to copy (→ `copy-flash`). Hover/focus a node to see JSONPath in breadcrumb. `[Collapse All]` → `tree.collapsed-all`. `[Expand All]` → `tree.expanded-all`. `[Depth: N ▾]` selector → `tree.expanded-to-level`. Click search icon or `Ctrl+F` → `tree.searching`. Scroll freely. Keyboard navigation: `↑`/`↓` to move focus between visible nodes, `←`/`→` to collapse/expand focused node, `Enter` to copy focused value. |
| **Trigger (exit)** | Collapse All clicked → `tree.collapsed-all`. Expand All clicked → `tree.expanded-all`. Depth selector used → `tree.expanded-to-level`. Search input focused → `tree.searching`. Value clicked → `tree.copy-flash` (transient). New `render()` → reset to `tree.empty`. Data > 500 KB → `tree.large-warning` (concurrent). Nodes > 5000 → `tree.virtualized` (concurrent). |
| **Notes** | This is the primary interactive state. Expand depth 2 means: root object/array expanded, its children expanded, grandchildren collapsed. Performance target: <16ms per frame for scroll/expand operations on datasets up to 5000 nodes. |

---

### S04: `tree.collapsed-all`

All nodes collapsed. Minimal view showing only the root.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | User clicks `[Collapse All]` toolbar button. Keyboard shortcut: `Ctrl+Shift+C`. |
| **Visual** | Only root-level line visible: `▸ { } 15 keys` or `▸ [ ] 42 items`. All nested nodes hidden via `display: none` on child containers. Collapse animation: all open nodes slide closed simultaneously (150ms ease-out). `[Collapse All]` button visually pressed/active. `[Expand All]` button enabled. Depth selector resets to show "—". Breadcrumb shows `$` (root). |
| **Actions available** | Click `▸` on root to expand one level. `[Expand All]` → `tree.expanded-all`. `[Depth: N ▾]` → `tree.expanded-to-level`. Search icon / `Ctrl+F` → `tree.searching` (search will auto-expand matching branches). Click root value to copy entire JSON (→ `copy-flash`). Keyboard: `→` on focused root expands one level, `Enter` copies root. |
| **Trigger (exit)** | Root `▸` clicked → `tree.rendered` (root expanded one level). `[Expand All]` → `tree.expanded-all`. `[Depth: N]` selected → `tree.expanded-to-level`. Search initiated → `tree.searching`. New `render()` → reset. |
| **Notes** | Collapsing all is always fast regardless of data size — it only hides DOM, does not remove it. Scroll position resets to top on collapse-all. |

---

### S05: `tree.expanded-all`

All nodes expanded to maximum depth.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | User clicks `[Expand All]` toolbar button. Keyboard shortcut: `Ctrl+Shift+E`. If tree depth > 20 levels, a confirmation dialog appears first: "This tree has N levels. Expanding all may be slow. Continue?" |
| **Visual** | Every node at every depth visible. All toggle icons show `▾`. Deep nesting visible with progressive indentation (16px per level, capped at 320px / 20 levels — deeper levels share the 320px indent). `[Expand All]` button visually pressed/active. `[Collapse All]` button enabled. Depth selector shows "All". If tree is very deep (>20), a subtle yellow warning badge appears on the toolbar: "⚠ Deep tree". Scroll position preserved if previously scrolled. |
| **Actions available** | Click `▾` on any node to collapse it individually. `[Collapse All]` → `tree.collapsed-all`. `[Depth: N ▾]` → `tree.expanded-to-level`. Search icon / `Ctrl+F` → `tree.searching`. Click any value to copy (→ `copy-flash`). Hover/focus any node for breadcrumb path. Full keyboard navigation across all visible nodes. |
| **Trigger (exit)** | `[Collapse All]` → `tree.collapsed-all`. `[Depth: N]` selected → `tree.expanded-to-level`. Any `▾` clicked → `tree.rendered` (mixed expand state). Search initiated → `tree.searching`. New `render()` → reset. |
| **Notes** | For datasets with >5000 nodes, `[Expand All]` is disabled when `tree.virtualized` is active — expanding all would create too many DOM nodes. If data has >20 levels of nesting, show the confirmation dialog before expanding. Expanding all on a 10000-node tree without virtualization could freeze the UI for several seconds. |

---

### S06: `tree.expanded-to-level`

Tree expanded to a user-selected depth (1, 2, or 3).

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | User selects depth from the `[Depth: N ▾]` dropdown. Options: `1` (root children only), `2` (default), `3` (three levels deep). Keyboard: `1`, `2`, `3` keys when toolbar is focused. |
| **Visual** | Nodes at depth ≤ N expanded (`▾`), nodes at depth > N collapsed (`▸` with item count badge). Transition: nodes above N slide open, nodes below N slide closed (150ms ease-out, staggered 20ms per level). Depth selector shows the active level number highlighted in `--color-accent`. Breadcrumb updates on hover/focus. |
| **Actions available** | Click `▸`/`▾` on any individual node to override depth for that subtree. `[Collapse All]` → `tree.collapsed-all`. `[Expand All]` → `tree.expanded-all`. Change depth selector → re-enter `tree.expanded-to-level` with new N. Search icon / `Ctrl+F` → `tree.searching`. Click any value to copy. Full keyboard navigation on visible nodes. |
| **Trigger (exit)** | `[Collapse All]` → `tree.collapsed-all`. `[Expand All]` → `tree.expanded-all`. Depth changed → re-enter self with new level. Manual node toggle → `tree.rendered` (mixed state). Search initiated → `tree.searching`. New `render()` → reset. |
| **Notes** | Depth counting starts at 0 (root). Level 1 = root expanded, children visible but collapsed. Level 2 = root and children expanded, grandchildren collapsed. Level 3 = three levels deep. Selecting the same level as current is a no-op. |

---

### S07: `tree.searching`

Search active with query text and highlighted matches.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | User clicks search icon in toolbar or presses `Ctrl+F`. Search input appears and receives focus. Searching begins after ≥1 character typed (debounced 200ms). |
| **Visual** | Search input bar slides in below toolbar (height 36px, `--color-surface-secondary` background). Input field with placeholder "Search keys and values...". As user types, matching text in keys and values wrapped in `<mark>` elements with `oklch(0.85 0.2 85)` yellow background. Non-matching branches dimmed to `opacity: 0.4`. Match counter to the right of input: "3 of 12 matches" in `--color-text-secondary`. `[▲]` `[▼]` navigation buttons to jump between matches. Current match has a stronger highlight: `oklch(0.75 0.25 85)` with 2px outline. Branches containing matches auto-expand regardless of current collapse state. Breadcrumb shows JSONPath of current match. `[✕]` button in search bar to clear. |
| **Actions available** | Type to refine search query. `Enter` or `[▼]` → next match (cycles). `Shift+Enter` or `[▲]` → previous match. `Escape` → clear search, return to previous expand state. `[✕]` → clear search. Click any value to copy (→ `copy-flash`, flash visible even on dimmed nodes). Scroll to navigate. Keyboard `↑`/`↓` navigates matches (not all nodes). |
| **Trigger (exit)** | `Escape` pressed → return to previous state (`tree.rendered`, `tree.collapsed-all`, `tree.expanded-all`, or `tree.expanded-to-level`). `[✕]` clicked → same. All search text deleted → `tree.rendered`. Search query produces 0 matches → `tree.no-search-results`. New `render()` → reset (search cleared, new data rendered). |
| **Notes** | Search is case-insensitive by default. Search text is treated as literal string — regex special characters are escaped. Search examines both keys and values. Match count includes all matches across the entire tree. When `tree.virtualized` is active concurrently, search only covers visible (in-viewport) nodes and shows notice: "Searching visible nodes only". Restoring previous expand state on search-clear uses a snapshot taken when search was initiated. |

---

### S08: `tree.no-search-results`

Search query matches nothing.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | Search query has ≥1 character but matches zero keys or values in the tree. |
| **Visual** | Search input bar remains visible with the query text. Match counter reads "0 matches". Below the search bar, centered in the tree area: "No matches for '{query}'" in `--color-text-secondary` (14px, italic). All tree nodes dimmed to `opacity: 0.3`. `[▲]` `[▼]` navigation buttons disabled (greyed out). No `<mark>` elements in the tree. Breadcrumb shows `$` (root). |
| **Actions available** | Edit search query (may find matches → `tree.searching`). `Escape` → clear search, return to previous state. `[✕]` → clear search. Delete all search text → `tree.rendered`. Click values still works for copy (→ `copy-flash`), though nodes are dimmed. |
| **Trigger (exit)** | Query modified to produce ≥1 match → `tree.searching`. Search cleared (`Escape`, `[✕]`, or empty input) → previous state. New `render()` → reset. |
| **Notes** | The "no matches" message updates live as the user types. If the user backspaces to a query that has matches, immediately transition to `tree.searching`. The dimming is more aggressive than `tree.searching` (0.3 vs 0.4) to emphasize the empty result. |

---

### S09: `tree.copy-flash`

Transient state — value copied to clipboard with visual feedback.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | User clicks any value (string, number, boolean, null) in the tree. Or user clicks a key to copy the key name. Or user presses `Enter` on a focused node. Or user presses `Ctrl+C` with a node focused. Clipboard write via `navigator.clipboard.writeText()`. |
| **Visual** | Clicked/focused element receives a brief flash animation: background transitions from transparent to `oklch(0.72 0.17 145 / 0.3)` (green tint) and back over 200ms (100ms in, 100ms out). Element border briefly flashes `oklch(0.72 0.17 145)` green. Concurrently, a toast notification appears at bottom-center: "Copied to clipboard" with a `✓` checkmark icon, `--color-surface-tertiary` background, auto-dismisses after 2000ms. If the node is dimmed (during search), flash opacity is boosted to remain visible: the flash uses `opacity: 1` on the element temporarily. For objects/arrays at root or collapsed level, the entire JSON subtree is copied as formatted string. |
| **Actions available** | None — this is a 200ms transient state. All previous-state actions resume immediately after the flash completes. |
| **Trigger (exit)** | Automatic after 200ms → returns to whatever state was active before (e.g., `tree.rendered`, `tree.searching`, etc.). |
| **Notes** | If clipboard API fails (e.g., permissions denied), show error toast: "Copy failed — clipboard not available" in `oklch(0.65 0.25 25)` red. The flash CSS class (`jt-copy-flash`) is added then removed via `setTimeout`. Multiple rapid clicks queue flashes — each value gets its own 200ms flash, but only one toast is shown (debounced). Copy content: primitives copy their value as string; objects/arrays copy `JSON.stringify(value, null, 2)`. Keys copy the key name only. |

---

### S10: `tree.large-warning`

Persistent overlay for payloads exceeding 500 KB.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | `render(json)` called with data whose serialized size (via `JSON.stringify`) exceeds 512000 bytes (500 KB). Detected during parse phase before DOM rendering begins. |
| **Visual** | Warning banner at top of tree container (below toolbar, above tree content): `oklch(0.92 0.08 85)` yellow-tinted background, 1px `oklch(0.75 0.12 85)` border. Icon: `⚠` triangle. Text: "Large response (X KB). Some features may be slower." where X is the payload size rounded to nearest KB. If payload > 1 MB, additional text: "Showing first 500 KB. [Download full response]" with a link/button to save the full payload as a `.json` file. Banner has `[✕]` dismiss button (dismissal is session-only, banner returns for next large response). Banner height: 36px, does not push tree content — it overlays with slight top padding on tree. |
| **Actions available** | `[✕]` dismiss warning banner. `[Download full response]` → browser save dialog for the full JSON file. All other tree interactions remain available (this is an overlay state). If truncation is active, a "Load more" button appears at the truncation point in the tree. |
| **Trigger (exit)** | New `render()` called with data ≤ 500 KB → warning removed. New `render()` with another large payload → warning resets with new size. Component destroyed → removed. Dismiss button only hides the banner for the current response. |
| **Notes** | The 500 KB threshold is for display warning only. Actual truncation (rendering only partial data) kicks in at 1 MB to prevent browser tab crashes. The warning is purely informational for 500 KB–1 MB payloads. Performance features like search and Expand All may be noticeably slower on large payloads. |

---

### S11: `tree.virtualized`

Virtual scroll active for very large node counts.

| Aspect | Detail |
|--------|--------|
| **Trigger (enter)** | After render, visible (expanded) node count exceeds 5000. Virtualization engine activates: only nodes within the viewport ± 500px overscan buffer are present in the DOM. |
| **Visual** | Tree appears normal to the user — scrolling is smooth. Scrollbar reflects total virtual height (calculated as `totalNodes × rowHeight`). A subtle indicator appears in the toolbar: "⚡ Virtual scroll" badge in `--color-text-tertiary` (10px) to signal that virtualization is active. `[Expand All]` button disabled with tooltip: "Disabled for large trees (>5000 nodes)". Scroll position maintained during expand/collapse of individual nodes — viewport anchored to the first visible node. |
| **Actions available** | Scroll to navigate (smooth scroll, 60fps target). Click `▸`/`▾` to expand/collapse individual nodes (may change virtual node count). `[Collapse All]` remains available. `[Depth: N ▾]` remains available. Search (→ `tree.searching`) searches only nodes currently in viewport + buffer, with notice text. Click values to copy (→ `copy-flash`). Keyboard `↑`/`↓` navigation works within visible nodes. Breadcrumb shows JSONPath on hover/focus. `[Expand All]` disabled. |
| **Trigger (exit)** | `[Collapse All]` reduces visible node count below 5000 → virtualization deactivates. Depth selector reduces visible nodes below 5000 → deactivates. New `render()` with < 5000 nodes → not virtualized. Component destroyed. |
| **Notes** | Row height is fixed at 24px for virtualization calculations. Nodes of varying content height are not supported in virtualized mode — long values are truncated to single-line with "..." and click-to-expand. The overscan buffer (500px above/below viewport) ensures smooth scrolling without visible blank areas. When collapsing a large subtree, the virtual scroll recalculates total height and adjusts scrollbar immediately. |

---

## 4. Compound States

Many states coexist because the tree has independent orthogonal dimensions: expand state, search state, data size overlays, and transient copy feedback.

### Compatibility Matrix

States are classified as:
- **Primary** (mutually exclusive): `empty`, `rendering`, `rendered`, `collapsed-all`, `expanded-all`, `expanded-to-level`
- **Search layer**: `searching`, `no-search-results` (mutually exclusive with each other, overlay on primary)
- **Data overlays**: `large-warning`, `virtualized` (independent, can coexist with each other and with primary/search)
- **Transient**: `copy-flash` (overlays everything, auto-clears)

```
                    ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
                    │ S01 │ S02 │ S03 │ S04 │ S05 │ S06 │ S07 │ S08 │ S09 │ S10 │ S11 │
                    │empty│rndng│rndr │c-all│e-all│e-lvl│srch │no-sr│flash│lg-wn│virt │
  ┌─────────────────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤
  │ S01 empty       │  ―  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
  │ S02 rendering   │  ✕  │  ―  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✓  │  ✕  │
  │ S03 rendered     │  ✕  │  ✕  │  ―  │  ✕  │  ✕  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
  │ S04 collapsed-all│  ✕  │  ✕  │  ✕  │  ―  │  ✕  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✕  │
  │ S05 expanded-all │  ✕  │  ✕  │  ✕  │  ✕  │  ―  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✕  │
  │ S06 exp-to-level │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ―  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
  │ S07 searching    │  ✕  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ―  │  ✕  │  ✓  │  ✓  │  ✓  │
  │ S08 no-search-res│  ✕  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✕  │  ―  │  ✓  │  ✓  │  ✓  │
  │ S09 copy-flash   │  ✕  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ―  │  ✓  │  ✓  │
  │ S10 large-warning│  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ―  │  ✓  │
  │ S11 virtualized  │  ✕  │  ✕  │  ✓  │  ✕  │  ✕  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ―  │
  └─────────────────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘

  ✓ = can coexist    ✕ = mutually exclusive    ― = self
```

### Notable Compound State Combinations

**1. `rendered` + `expanded-to-level` + `searching`**
User is at depth 2 and has typed a search query. Branches containing matches auto-expand beyond depth 2 to reveal the match. Non-matching branches remain at depth 2 but dimmed. Clearing search restores the depth-2 view.

**2. `rendered` + `large-warning` + `virtualized`**
Huge payload (>500 KB and >5000 nodes). Both overlays active: warning banner at top, virtual scroll badge in toolbar. `[Expand All]` disabled. Search limited to visible nodes. `[Download full response]` available.

**3. `searching` + `copy-flash`**
User copies a highlighted match. The green flash animation plays on top of the yellow `<mark>` highlight. Flash uses higher z-index to remain visible. Toast appears normally.

**4. `virtualized` + `searching`**
Search within a virtualized tree. Only visible nodes (viewport ± buffer) are searched. Match counter shows "3 matches (visible nodes only)" with an info icon. `[▲]` `[▼]` navigation cycles through found matches but may not find all matches in the full dataset. User can scroll to reveal more nodes, which are then included in the search.

**5. `expanded-to-level` + `large-warning`**
Large data rendered at a specific depth. Warning banner visible. Expanding to a deeper level may increase node count past 5000, activating `tree.virtualized` concurrently.

**6. `collapsed-all` + `searching`**
Search from collapsed state. Matching branches auto-expand to reveal the match context (the matched node plus its ancestors). Non-matching branches remain collapsed and dimmed. Clearing search re-collapses everything.

**7. `copy-flash` overlaying any state**
`copy-flash` is always compatible. It adds a 200ms CSS class and fires a toast. The underlying state is unaffected. Multiple rapid copies debounce the toast but each flash plays independently.

---

## 5. Edge Cases

### EC-01: Empty JSON — `{}` or `[]`

**State:** `tree.rendered`
**Behavior:** Tree renders a single line: `{ }` (0 keys) or `[ ]` (0 items). No expand/collapse toggles — there is nothing to expand. `[Collapse All]` and `[Expand All]` buttons disabled (greyed out, no-op on click). Depth selector disabled. Search can be initiated but will always produce `tree.no-search-results` (nothing to match). Copy on root copies `{}` or `[]`. Breadcrumb shows `$`.

### EC-02: Single Primitive Value — `42`, `"hello"`, `true`, `null`

**State:** `tree.rendered`
**Behavior:** Tree renders a single node with the value, syntax-colored appropriately. No tree structure — no indentation, no toggles, no nesting. `[Collapse All]`, `[Expand All]`, depth selector all disabled. Search matches against the single value. Copy copies the primitive value as string. Breadcrumb shows `$`. Line number "1" shown if line numbers enabled.

### EC-03: Deeply Nested JSON (>20 Levels)

**State:** `tree.expanded-all` blocked by confirmation
**Behavior:** When user clicks `[Expand All]` and tree depth exceeds 20 levels, a confirmation dialog appears: "This tree has N levels of nesting. Expanding all may cause performance issues. Continue?" with `[Cancel]` and `[Expand anyway]` buttons. `[Cancel]` returns to previous state. `[Expand anyway]` proceeds to `tree.expanded-all` with a performance note in the toolbar. Indentation caps at 320px (20 × 16px) — levels beyond 20 share the same indent. The depth selector only offers 1, 2, 3 — not arbitrary deep levels.

### EC-04: Circular Reference

**Behavior:** Not applicable. JSON.parse cannot produce circular references. If the caller passes a pre-parsed object with circular references to `render()`, `JSON.stringify()` will throw during size calculation. The component catches this and renders an error: "Cannot render: data contains circular references" in `--color-error`. State remains `tree.empty`.

### EC-05: Very Long String Values (>500 Characters)

**State:** Any rendered state
**Behavior:** String values longer than 500 characters are truncated in the tree display: first 500 characters shown followed by `…` (ellipsis) and a `[show more]` link. Clicking `[show more]` expands the value inline to full length (no character limit). The expanded value wraps with `word-break: break-all`. Clicking `[show less]` re-truncates. Copy always copies the full value regardless of truncation state. In virtualized mode, long expanded values may cause row height misalignment — expanding a value forces the row to variable height and recalculates virtual positions.

### EC-06: Very Long Arrays (>1000 Items)

**State:** `tree.rendered` or `tree.virtualized`
**Behavior:** Arrays with >1000 items show the first 100 items, then a "... and 900 more items" divider, then the last 10 items. Clicking the divider loads the next batch of 100 items (lazy pagination within the array). The item count badge on the collapsed array shows the true count: `▸ [...] 1042 items`. If the array is within a virtualized tree, all items are available via scroll — virtualization handles the DOM efficiency. Search still covers all items (not just the visible 100). Expand All expands all array items (may trigger virtualization).

### EC-07: Search with Regex Characters

**State:** `tree.searching`
**Behavior:** User input in the search field is treated as a literal string, not a regex. Characters like `.`, `*`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `^`, `$`, `|`, `\` are escaped before matching. The search function uses `String.prototype.includes()` (case-insensitive via `.toLowerCase()`) rather than `RegExp`. This prevents regex injection and user confusion. If a future version adds regex search, it should be an explicit toggle (e.g., `[.*]` button) — not the default.

### EC-08: Copy Flash During Search

**State:** `tree.searching` + `tree.copy-flash`
**Behavior:** When a user clicks a value during active search, the copy flash must be visible even on dimmed nodes (`opacity: 0.4`). The flash temporarily sets `opacity: 1` on the target element for the 200ms duration, then restores the search-dimmed opacity. On `<mark>`-highlighted matches, the flash plays on top of the yellow highlight — the green flash blends over yellow briefly, then returns to yellow. Toast appears normally regardless of search state.

### EC-09: Mode Switching (Pretty → Raw → Pretty)

**State:** Persisted across mode switches
**Behavior:** When the user switches from "Pretty" tab to "Raw" tab in the Response Viewer, the `JsonTreeRenderer` is hidden (`display: none`) but not destroyed. Internal state (expand/collapse state, scroll position, active search query) is preserved in memory. Switching back to "Pretty" restores the tree exactly as it was. If a new response arrives while on "Raw" tab, the tree is flagged dirty — switching back to "Pretty" triggers a re-render with the new data (state resets to `tree.empty` → `tree.rendered`). The tree is destroyed (`destroy()`) only when the Response Viewer component itself is unmounted.

### EC-10: New Response While Searching

**State:** `tree.searching` → reset
**Behavior:** If a new API response arrives while search is active, the search is cleared (search input emptied, highlights removed, dimming removed) and the new data is rendered from scratch. The search bar remains visible but empty — the user can re-initiate search on the new data. Rationale: the old search query is unlikely to be relevant to new data. The previous search text is stored in the search input's `data-last-query` attribute so the user can press `↑` to recall it.

### EC-11: Virtualized Tree with Search

**State:** `tree.virtualized` + `tree.searching`
**Behavior:** Search in virtualized mode only examines nodes currently in the DOM (viewport ± 500px overscan). The match counter displays: "N matches (visible nodes only)" with an `ⓘ` info icon. Hovering the info icon shows tooltip: "Scroll to search more of the tree. Not all nodes are loaded." As the user scrolls, newly materialized nodes are searched and matches are added to the count incrementally. `[▲]` `[▼]` navigation only jumps to known matches — it does not trigger scroll-based discovery. This is a known limitation documented in the `tree.virtualized` state notes.

---

*End of state matrix.*
