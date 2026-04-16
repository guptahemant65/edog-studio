# Phantom — Workspace Explorer Design Review

## Executive Summary

**Overall Score: 7.2 / 10**

The Workspace Explorer is a solid, functional three-panel browser with good visual design DNA — proper token usage in layout, well-crafted hover/selected states, and a thoughtful context menu. The CSS architecture is ~80% tokenized with correct BEM-adjacent naming. Strengths: the tree item hover-action pattern (rename/delete/⋯ fading in, badge fading out) is elegant, the expand animation with staggered children is smooth, and the lakehouse/non-lakehouse visual distinction is immediately readable. Weaknesses cluster in three areas: (1) accessibility is nearly absent — no `role="tree"`, no `aria-expanded`, no keyboard navigation, no focus-visible states; (2) performance will degrade at scale — full tree re-render on every toggle, no virtual scrolling, no filter debouncing; (3) 40+ hard-coded values in CSS bypass the token system, and several rgba colors will break on theme switching. The bones are excellent; the gaps are fixable.

---

## Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| Visual Hierarchy | 8/10 | Tree depth clearly readable via 20px indent steps, dimming + green dot for LH distinction, selected state is crisp. Slight deduction: no tree connector lines and count badge disappears on hover. |
| Component Placement | 8/10 | Three-panel layout is standard and correct. Header with title + refresh + add is exactly where expected. Favorites at tree bottom is logical. Context menu positions within viewport bounds. Filter above table container is correct. |
| CSS Quality | 6.5/10 | ~80% tokenized but 40+ hard-coded values remain (font sizes, spacings, rgba colors). Duplicate `.ws-content-meta` selector. Hard-coded `z-index: 9998`. `oklch()` color in error state bypasses token system. No scrollbar styling. |
| Interaction Design | 7.5/10 | Click, right-click, rename (F2), delete with toast confirmation, expand/collapse — all present and correct. Missing: arrow-key tree nav, multi-select, drag-drop, undo. Row click has triple-handler overlap (toggle + name + wsEl). |
| Information Density | 8/10 | Good balance for a dev tool. 30px row height is tight without being cramped. 1px gap between items is correct. Count badges and type badges provide scannable metadata. Table filter with "N of M" count is useful. |
| Empty States | 7/10 | All key states covered (no workspaces, loading, error with retry, no tables, inspector placeholder). But: loading state is plain text "Loading..." — should use shimmer skeletons as specified in states.md (TREE-001). Error state icon uses hard-coded `oklch()`. |
| Responsiveness | 5/10 | Zero media queries. Panel widths are CSS variables (good) but no resize handles. Tree item height hard-coded at 30px. Table container max-height hard-coded at 400px. Text truncation exists but no panel collapse behavior at narrow widths. |
| Accessibility | 2.5/10 | Critical gap. No `role="tree"` / `role="treeitem"`. No `aria-expanded`. No `aria-selected`. No keyboard navigation. No `tabindex` on tree items. No `focus-visible` styles. No `aria-live` on toast. Context menu lacks `role="menu"`. Color dots have no accessible labels. |
| Animation/Motion | 7.5/10 | Expand/collapse chevron rotation (150ms ease-out) is smooth. Staggered child-in animation is tasteful. Toast fades are correct. Particle burst on deploy completion is fun but `z-index: 9998` is concerning. Missing: collapse animation (items just vanish). Table row entrance is 400ms with cubic-bezier — too slow for a dev tool data view. |
| Design System Consistency | 7/10 | Section headers match the bible pattern exactly (10px, 700wt, uppercase, 0.08em). Accent system is correctly applied. Transition tokens used. But: tree item font-size is `13px` literal instead of `var(--text-md)`. Empty state uses `14px`/`12px` literals. Inspector grid uses `70px` fixed column. Multiple `rgba(109,92,255,...)` hard-codes instead of accent tokens. |

---

## What's Working (keep these)

### 1. Tree Item Hover-Action Swap Pattern
`workspace.css:155-169`, `workspace-explorer.js:973-1005`

When hovering a tree row, the count/type badge fades out (`opacity: 0`) and the action buttons fade in (`opacity: 0→1, 150ms`). This is *the* correct pattern for info-dense tree rows — metadata visible at rest, actions revealed on intent. The 2px gap between action buttons is tight and correct.

### 2. Selected State Treatment
`workspace.css:73-78`

Accent-dim background + 3px left accent border + accent text color + font-weight 600 on the name. This is a textbook selection pattern — visible without being loud, distinct from hover, survives even on small panels. The `border-radius: 0 var(--radius-sm) var(--radius-sm) 0` on the right side (left is the accent bar) is a nice touch.

### 3. Non-Lakehouse Dimming
`workspace.css:79-80`, `workspace-explorer.js:870`

Lakehouses are primary content; non-lakehouse items are dimmed to 60% opacity with a restore to 85% on hover. This is correct hierarchy — the data users care about (LH) stands out, everything else is scannable but not visually competitive.

### 4. Context Menu Architecture
`workspace-explorer.js:174-243`, `workspace.css:674-691`

Three distinct menus based on node type (workspace/lakehouse/other). Deploy is the first lakehouse item with accent styling. Danger items are red. Separators group related actions. Viewport boundary clamping prevents offscreen rendering. The CSS uses proper tokens for shadow, border-radius, background.

### 5. Staggered Expand Animation
`workspace.css:197-210`

Children enter with `translateY(-4px) → 0, opacity 0 → 1` at 150ms with 50ms stagger delays. This is exactly the right weight — visible but not blocking. Maximum total delay is 150ms (6th child), so the full expand feels complete in ~300ms.

### 6. Section Header Pattern
`workspace.css:26-31`

Matches the design bible section header spec exactly: `--text-xs` (10px), weight 700, `--text-muted`, uppercase, `letter-spacing: 0.08em`. This is replicated consistently for WORKSPACES, FAVORITES, and inspector section labels.

### 7. Error State Differentiation
`workspace-explorer.js:1401-1436`

Error messages are contextual — 502 gets "Capacity host unavailable", 401/403 gets "Authentication error", others get generic. Each includes a retry button. This is correct for a dev tool where error specificity aids debugging.

### 8. Toast Confirmation Pattern
`workspace-explorer.js:96-141`

Delete actions show a confirm/cancel toast with auto-timeout. Uses Promise-based API (`_toastConfirm()` returns `Promise<boolean>`). Force-reflows transition for immediate re-trigger. Clean pattern.

---

## Surgical Fixes

### Tier 1 — Fix Real Problems (bugs, broken UX)

#### P1-01: No ARIA Tree Semantics
**Impact:** Screen reader users cannot navigate or understand the tree structure at all.
**Files:** `workspace-explorer.js:777-912`, `workspace-explorer.js:920-1008`

The tree container (`#ws-tree-content`) has no `role="tree"`. Individual tree nodes have no `role="treeitem"`. No `aria-expanded`, `aria-selected`, `aria-level`, or `aria-setsize/aria-posinset`. 

**Fix:** In `_renderTree()` (line 777), add `this._treeEl.setAttribute('role', 'tree')`. In `_buildTreeNode()` (line 920), add to every node:
```javascript
el.setAttribute('role', 'treeitem');
el.setAttribute('aria-level', String(opts.depth + 1));
el.setAttribute('aria-selected', String(!!opts.selected));
if (opts.isWorkspace) el.setAttribute('aria-expanded', String(!!opts.expanded));
```

#### P1-02: No Keyboard Navigation in Tree
**Impact:** Keyboard-only users cannot navigate the tree at all. Only Escape and Ctrl+F are bound.
**Files:** `workspace-explorer.js:649-662`

**Fix:** Add keyboard handler on `_treeEl`:
- `ArrowDown` / `ArrowUp`: Move focus between visible tree items
- `ArrowRight`: Expand collapsed node, or move to first child
- `ArrowLeft`: Collapse expanded node, or move to parent
- `Enter` / `Space`: Select focused item
- `Home` / `End`: Jump to first/last visible item
- `F2`: Start rename on focused item
- `Delete`: Trigger delete on focused item

Requires adding `tabindex="0"` to each `.ws-tree-item` and tracking a `_focusedIndex`.

#### P1-03: No `focus-visible` Styles
**Impact:** Keyboard users have no visual indicator of which element has focus.
**Files:** `workspace.css` (missing entirely)

**Fix:** Add to `workspace.css`:
```css
.ws-tree-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--surface-2);
}
.ws-tree-action-btn:focus-visible,
.ws-tree-refresh:focus-visible,
.ws-ctx-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
```

#### P1-04: Context Menu Missing ARIA Roles
**Impact:** Context menu is invisible to assistive technology.
**Files:** `workspace-explorer.js:147-243`, `workspace.css:674-691`

**Fix:** In `_createContextMenu()`: add `el.setAttribute('role', 'menu')`. In `_showContextMenu()` (line 218): add `el.setAttribute('role', 'menuitem')` and `el.setAttribute('tabindex', '-1')` to each item. Add keyboard trap: ArrowUp/Down moves focus, Escape closes, Enter activates.

#### P1-05: Toast Lacks `aria-live`
**Impact:** Screen readers don't announce toast notifications.
**Files:** `workspace-explorer.js:66-73`

**Fix:** In `_createToast()` (line 70): add `el.setAttribute('role', 'status')` and `el.setAttribute('aria-live', 'polite')`.

#### P1-06: Event Listener Leak on Tree Re-render
**Impact:** Each `_renderTree()` call appends new listeners to freshly created elements — but the `document.addEventListener('click', ...)` in `_createContextMenu()` (line 156) and `_bindGlobalKeys()` (line 650) are called once on init with no cleanup. The real leak risk is that `_renderTree()` rebuilds from scratch but the *parent* row click handler (line 821) creates closures over `ws` objects — if `_renderTree()` is called repeatedly (e.g., rapid expand/collapse), old closures referencing stale workspace objects stay in memory until GC.
**Files:** `workspace-explorer.js:777-912`

**Fix:** Use event delegation on `_treeEl` instead of per-node listeners. Attach one click/contextmenu handler to `_treeEl` and use `e.target.closest('.ws-tree-item')` with `dataset` attributes to identify the target.

---

### Tier 2 — Improve Core Experience

#### P2-01: Loading State Doesn't Match Spec
**Impact:** States.md (TREE-001) specifies "8 shimmer skeleton rows (circle + 2 lines each)". Actual implementation shows plain text "Loading..." in a dimmed div.
**Files:** `workspace-explorer.js:730`, states.md line TREE-001

**Fix:** Replace line 730's innerHTML with shimmer skeleton markup:
```javascript
this._treeEl.innerHTML = Array.from({ length: 8 }, () =>
  '<div class="ws-tree-item skel-wrap"><span class="skel-circle"></span><span class="skel-line" style="width:60%"></span><span class="skel-line" style="width:30%"></span></div>'
).join('');
```

#### P2-02: No Collapse Animation (Asymmetric UX)
**Impact:** Children animate in with staggered slide-up, but on collapse they vanish instantly (DOM removed). This creates a jarring asymmetry.
**Files:** `workspace-explorer.js:1014-1046`, `workspace.css:197-210`

**Fix:** Before removing children, add a `ws-tree-child-out` class with reverse animation (`opacity 1→0, translateY(0→-4px), 100ms`), then remove after animation completes. Use `animationend` event or a 100ms `setTimeout`.

#### P2-03: No Filter Debouncing
**Impact:** Table filter runs on every keystroke — full DOM sweep each time. Typing "warehouse" = 9 sweeps.
**Files:** `workspace-explorer.js:714`

**Fix:** Add debounce:
```javascript
let debounceTimer;
input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, 150);
});
```

#### P2-04: Triple Click Handler Overlap on Workspace Row
**Impact:** Clicking a workspace name fires: (1) nameEl click handler (line 811), (2) wsEl click handler (line 821), and (3) potentially toggleEl click handler (line 805). The `e.stopPropagation()` on nameEl and toggleEl prevents bubbling to wsEl, but this triple-binding is fragile and error-prone.
**Files:** `workspace-explorer.js:801-826`

**Fix:** Use single event delegation on the row element. Check `e.target.closest('.ws-tree-toggle')` to distinguish toggle clicks from selection clicks.

#### P2-05: No Tree Search
**Impact:** States.md (TREE-007) specifies a search input at top of tree for 50+ items. Currently, only table content has a filter.
**Files:** `workspace-explorer.js:668-722` (table filter exists), no tree search equivalent

**Fix:** Add a search input below `.ws-tree-header` that filters visible tree items by name. Use the same pattern as `_insertTableFilter()` but applied to `.ws-tree-item` elements.

#### P2-06: Hard-coded rgba Colors Break Theming
**Impact:** 20+ instances of `rgba(109,92,255,...)` hard-code the accent color. If accent changes (e.g., brand customization or light/dark swap), these won't update.
**Files:** `workspace.css:552, 557, 710, 711, 1167, 1201, 1289, 1308, 1439, 1444-1449, 1467, 1476`

**Fix:** Create semantic tokens:
```css
:root {
  --accent-tint-3: rgba(109,92,255,0.03);
  --accent-tint-6: rgba(109,92,255,0.06);
  --accent-tint-15: rgba(109,92,255,0.15);
  --success-tint-4: rgba(24,160,88,0.04);
  --success-tint-8: rgba(24,160,88,0.08);
  --error-tint-8: rgba(229,69,59,0.08);
  --error-tint-20: rgba(229,69,59,0.20);
  --warning-tint-4: rgba(229,148,12,0.04);
}
```
Then replace all hard-coded rgba references.

#### P2-07: Tree Item Height Mismatch with Design System
**Impact:** `workspace.css:60` sets tree item height to `30px`. `variables.css` defines `--row-height: 28px`. States.md doesn't specify a value. The 2px discrepancy is inconsistent.
**Files:** `workspace.css:60`, `variables.css`

**Fix:** Either use `var(--row-height)` or create `--tree-row-height: 30px` as an explicit override with a comment explaining the deviation (30px gives better click targets for the action buttons).

---

### Tier 3 — Polish & Cleanup

#### P3-01: Hard-coded Font Sizes (14 instances)
**Impact:** Bypasses typography scale; makes global font size changes impossible.
**Files:** `workspace.css:39, 63, 141, 184, 356, 362, 398, 403, 446, 490, 494, 671, 1260, 1395`

**Fix map:**
| Line | Current | Replace with |
|------|---------|-------------|
| 39 | `14px` | `var(--text-sm)` (12px, closer to icon size) or keep if intentional |
| 63 | `13px` | `var(--text-md)` |
| 141 | `9px` | — (too small for any token; add `--text-2xs: 9px` or keep as badge exception) |
| 356 | `14px` | `var(--text-sm)` |
| 362, 403, 490 | `12px` | `var(--text-sm)` |
| 398, 494 | `11px` | `var(--text-xs)` (close enough at 10px) or add `--text-11px` |

#### P3-02: Hard-coded Spacing (12 instances)
**Impact:** Bypasses spacing scale.
**Files:** `workspace.css:83-85, 157, 343, 347, 353, 359, 376, 389, 401, 481, 507, 1155`

**Fix:** Replace `48px` → `var(--space-12)`, `24px` → `var(--space-6)`, `16px` → `var(--space-4)`, `12px` → `var(--space-3)`, `4px` → `var(--space-1)`, `2px` → keep (sub-grid). Tree depth indentation (83-85) can use `calc(var(--space-3) + var(--depth-indent, 0px) * 20px)` or keep explicit for clarity.

#### P3-03: `oklch()` Color in Error State
**Impact:** `workspace.css:383` uses `oklch(0.65 0.2 25 / 0.08)` — a modern color function not in the token system. Browser support is good but inconsistent with the rest of the CSS which uses rgb/rgba.
**Files:** `workspace.css:383`

**Fix:** Replace with `var(--error-tint-8)` or `rgba(229, 69, 59, 0.08)` to match the pattern used elsewhere.

#### P3-04: Duplicate `.ws-content-meta` Selector
**Impact:** Two definitions at different locations create confusion about which takes precedence.
**Files:** `workspace.css:248, workspace.css:432` (approximate — CSS agent reported duplicate)

**Fix:** Consolidate into a single rule block. If they define different properties for different contexts, use a modifier class.

#### P3-05: Dead Code in JS
**Impact:** Maintenance burden.
**Files:** `workspace-explorer.js:2618-2623` (`_getHealthStatus()` — defined, never called), `workspace-explorer.js:2207` (`health` variable assigned but unused)

**Fix:** Remove both.

#### P3-06: Hard-coded `z-index: 9998` on Burst Particles
**Impact:** Bypasses z-index scale system.
**Files:** `workspace.css:1526`

**Fix:** Replace with `var(--z-toast)` (400) or create `--z-overlay-max` token. Particles are ephemeral (1.5s) so they don't need 9998.

#### P3-07: No Custom Scrollbar Styling
**Impact:** Tree panel scroll uses browser-default scrollbar which is visually heavy on some OS/browsers, especially Windows.
**Files:** `workspace.css` (missing)

**Fix:** Add thin scrollbar styling:
```css
.ws-tree-content::-webkit-scrollbar { width: 6px; }
.ws-tree-content::-webkit-scrollbar-track { background: transparent; }
.ws-tree-content::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.ws-tree-content::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
.ws-tree-content { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
```
Apply same to `.ws-content-panel` and `.ws-inspector-panel`.

#### P3-08: SVG Icon Color Hard-coded in CSS Data URL
**Impact:** `workspace.css:719` embeds an SVG with `stroke='%238e95a5'` — a hard-coded color that won't respond to theme changes.
**Files:** `workspace.css:719-721` (tenant selector dropdown arrow)

**Fix:** Move dropdown arrow to JS-injected SVG using `currentColor`, or accept this as a cosmetic limitation of CSS background-image SVGs.

#### P3-09: Table Row Entrance Animation Too Slow
**Impact:** `workspace.css:1377-1380` — `ws-row-enter` animation is `0.4s` with cubic-bezier. For a dev tool table with potentially 100+ rows, this creates visible delay. Design bible says max 150ms for data views.
**Files:** `workspace.css:1377-1380`

**Fix:** Reduce to `150ms ease-out`. Remove the cubic-bezier bounce — data tables shouldn't bounce.

#### P3-10: `en-IN` Number Format
**Impact:** `workspace-explorer.js:39` — `Intl.NumberFormat('en-IN')` formats numbers with Indian grouping (1,00,000 instead of 100,000). Unless the target audience is exclusively India-based, this may confuse users.
**Files:** `workspace-explorer.js:39`

**Fix:** Use `'en-US'` or detect user locale: `new Intl.NumberFormat()` (default to browser locale).

---

### Tier 4 — Nice to Have

#### P4-01: No Virtual Scrolling for Large Trees
**Impact:** Rendering 1000+ workspaces creates 1000+ DOM nodes. Performance will degrade.
**Files:** `workspace-explorer.js:785-912`

**Fix:** Implement virtual scrolling or pagination for `>50` workspaces (as states.md TREE-007 specifies).

#### P4-02: No Expand/Collapse State Persistence
**Impact:** Page refresh loses all tree expansion state.
**Files:** `workspace-explorer.js:20` (`_expanded` is in-memory `Set`)

**Fix:** Persist to `localStorage` alongside favorites: `edog-expanded-workspaces`.

#### P4-03: No Multi-Select
**Impact:** Can't bulk-delete or bulk-rename items.

#### P4-04: No Drag-Drop Reordering
**Impact:** Can't reorder favorites or move items between workspaces.

#### P4-05: Race Condition on Rapid Create
**Impact:** Multiple rapid clicks on "Create Workspace/Lakehouse" can submit duplicate API calls — no button disable during fetch.
**Files:** `workspace-explorer.js:496-512`

**Fix:** Set `button.disabled = true` before `await`, restore in `finally`.

#### P4-06: No Cancel for In-Flight Requests
**Impact:** Navigating away while workspace children are loading can result in stale data rendering.

**Fix:** Use `AbortController` for fetch calls in `_loadChildren()`.

---

## Design Rules for Tree/Explorer Components

### DO

- **DO** use 20px indent increment per depth level — consistent with design bible and readable at 3+ depths
- **DO** dim non-primary items (0.6 opacity) and restore on hover (0.85) — hierarchy through brightness
- **DO** use the hover-swap pattern: hide metadata badges, reveal action buttons — information density without clutter
- **DO** show staggered entry animations on expand (50ms delay, 150ms duration) — perception of progressive loading
- **DO** use `border-left: 3px solid var(--accent)` for selected state — scannable from any scroll position
- **DO** use design system transition tokens (`--transition-fast` for hovers, `--transition-normal` for structural changes)
- **DO** provide shimmer skeletons for loading states — never bare "Loading..." text in a production UI
- **DO** differentiate error messages by HTTP status — dev tool users need specificity
- **DO** use event delegation on the tree container — avoids listener leaks on re-render
- **DO** persist user state (favorites, expansion) across sessions via `localStorage`

### DON'T

- **DON'T** animate individual tree items on scroll or filter — at 1000 items, 1000 animations = frame drop
- **DON'T** use bounce/spring easing on data-dense views — keep `ease-out` only, ≤150ms
- **DON'T** hard-code rgba values — always create a token, even for one-off tints
- **DON'T** re-render the entire tree on single-node state changes — use targeted DOM updates or event delegation
- **DON'T** bind event listeners inside render loops — use delegation or clean up before re-render
- **DON'T** use `oklch()` or other non-standard color functions when the rest of the system uses `rgba()` + CSS variables
- **DON'T** skip ARIA roles on interactive tree structures — `role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected` are non-negotiable
- **DON'T** use `z-index > 1000` without a design system token — creates stacking context chaos
- **DON'T** set animation durations >150ms on data views — the F16 Standard (design bible) applies to chrome, not content
- **DON'T** use locale-specific number formatting (`en-IN`) unless the user's locale is detected

---

*Review by Phantom — performed against workspace-explorer.js (2679 lines), workspace.css (1540 lines), F01 spec, states.md, DESIGN_SYSTEM.md, variables.css, sidebar.css, and design bible references.*
