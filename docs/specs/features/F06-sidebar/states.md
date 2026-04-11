# F06 Sidebar Navigation — Complete UX State Matrix

> **Feature:** F06 Sidebar Navigation
> **Status:** Not Started
> **Owner:** Zara (JS) + Mika (CSS) + Kael (UX)
> **Last Updated:** 2026-04-11
> **States Documented:** 96

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by category. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates F06-COL-003").

**Naming convention:**
- `COL-*` — Collapsed sidebar states
- `EXP-*` — Expanded sidebar states
- `SW-*` — View switching states
- `PH-*` — Phase transition states
- `BADGE-*` — Notification badge states
- `KB-*` — Keyboard & accessibility states
- `RESP-*` — Responsive layout states
- `EDGE-*` — Edge case states

---

## 1. COLLAPSED STATE (Default, 52px)

### 1.1 Baseline Rendering

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| COL-001 | Initial render (Phase 1) | Page load, no service connected | 52px sidebar, 6 icon buttons vertically stacked (36×36 hit area each). Icons 1, 5, 6 at full opacity. Icons 2, 3, 4 at 30% opacity. Active indicator: 3px solid `var(--accent)` left border on icon 1 (Workspace Explorer). Background: `var(--surface-1)`. Bottom: phase badge "P1" in grey pill. Right edge: 1px `var(--border)` separator | COL-010, EXP-001 |
| COL-002 | Initial render (Phase 2) | Page load, service already connected | Same layout but all 6 icons at 100% opacity. Phase badge "P2" in accent-colored pill. Active view restored from localStorage (or Workspace Explorer if none saved) | COL-010, EXP-001 |
| COL-003 | Icon order | Always | Top to bottom: ① Grid (Workspace Explorer) → ② List (Logs) → ③ Diamond (DAG Studio) → ④ Bolt (Spark Inspector) → ⑤ Terminal (API Playground) → ⑥ Sliders (Environment). 8px gap between icons. 12px top/bottom padding | — |
| COL-004 | Active icon appearance | View is selected | Icon background: `var(--accent-dim)`. Left edge: 3px solid `var(--accent)` bar spanning full icon height. Icon color: `var(--accent)`. All other icons: `var(--text-2)` color, transparent background | SW-* |
| COL-005 | Disabled icon appearance | Phase 1, icons 2/3/4 | Opacity: 0.3. Cursor: `default` (not pointer, not not-allowed). No click handler attached. `aria-disabled="true"`. No hover background change | COL-007 |
| COL-006 | Token status dot | Always | Bottom of sidebar below phase badge: 8px circle. Green: token valid >10min. Amber: 5–10min. Red: <5min. Grey: no token. Matches top bar token health indicator | — |

### 1.2 Hover Interactions (Collapsed)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| COL-010 | Hover enabled icon | Mouse enters enabled icon hit area | Background: `var(--surface-2)`. Transition: 100ms ease. After 400ms dwell → tooltip appears to right of icon (see COL-012). Cursor: pointer | COL-011, COL-012, SW-001 |
| COL-011 | Hover exit enabled icon | Mouse leaves icon hit area | Background reverts to transparent (100ms). Tooltip dismissed immediately if shown | COL-001 or COL-002 |
| COL-012 | Tooltip on enabled icon | 400ms hover dwell on enabled icon | Tooltip right of sidebar: label text + shortcut badge. E.g., "Workspace Explorer · 1" or "Logs · 2". Background: `var(--surface-3)`. Arrow pointing left. 12px font, `var(--text-1)`. Fade-in 100ms | COL-011 |
| COL-013 | Hover disabled icon | Mouse enters disabled icon (Phase 1, icons 2/3/4) | No background change (stays transparent). Cursor stays `default`. After 400ms → disabled tooltip (COL-014) | COL-014, COL-015 |
| COL-014 | Tooltip on disabled icon | 400ms hover dwell on disabled icon | Tooltip: "Deploy to enable" with small lock icon (🔒 as SVG). Muted text color `var(--text-3)`. Same position as COL-012 but slightly dimmer background | COL-015 |
| COL-015 | Hover exit disabled icon | Mouse leaves disabled icon | Tooltip dismissed. No other visual change | COL-001 |
| COL-016 | Hover phase badge | Mouse enters "P1" or "P2" badge | Tooltip: "Phase 1 · Disconnected" or "Phase 2 · Connected to {lakehouseName}". 300ms delay before tooltip | COL-001 |

### 1.3 Active Indicator Details

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| COL-020 | Active bar position | View switch | 3px accent bar slides from previous icon position to new icon position. CSS `transform: translateY()` with 200ms `ease-out`. Bar height matches icon height (36px) | — |
| COL-021 | Active bar on load | Page load with saved view | Bar renders at correct position immediately (no animation on initial load) | — |
| COL-022 | Active bar fallback | Saved view is disabled (Phase 2 → Phase 1 regression) | Bar snaps to icon 1 (Workspace Explorer) with no animation. localStorage updated | SW-010 |

---

## 2. EXPANDED STATE (Hover, 200px)

### 2.1 Expand / Collapse Mechanics

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXP-001 | Sidebar expanding | Mouse enters sidebar region (52px strip) | Sidebar width animates 52px → 200px over 200ms, `ease-out`. Content area shrinks accordingly (flex layout). Right border stays | EXP-002 |
| EXP-002 | Sidebar fully expanded | Expansion complete | Each icon row now shows: icon (left) + label text (center) + shortcut badge (right). Labels fade in with 150ms delay after expansion starts, `opacity 0→1` + `translateX(-8px → 0)` staggered 30ms per item. Shortcut badges: small pill showing "1"–"6" in `var(--text-3)` | EXP-010, EXP-003 |
| EXP-003 | Sidebar collapsing | Mouse leaves sidebar region entirely | 200ms delay before collapse starts (prevents jitter on edge movement). Then width 200px → 52px over 200ms, `ease-in`. Labels fade out immediately (no stagger on collapse). Shortcut badges disappear | COL-001 or COL-002 |
| EXP-004 | Expand interrupted | Mouse leaves during expansion animation | Animation reverses smoothly from current width. No snap. CSS `transition` handles interpolation naturally | COL-001 |
| EXP-005 | Collapse interrupted | Mouse re-enters during collapse animation | Animation reverses, expanding again from current width | EXP-002 |

### 2.2 Expanded Content

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXP-010 | Enabled item (expanded) | Sidebar is expanded | Row: `[icon]  Label Text              [N]`. Full opacity. Hover → `var(--surface-2)` background on entire row. Cursor: pointer | SW-001 |
| EXP-011 | Disabled item (expanded) | Sidebar expanded, Phase 1 | Row: `[icon]  Label Text     [🔒]`. 30% opacity on entire row. Shortcut badge replaced with lock icon. No hover effect. Cursor: default | — |
| EXP-012 | Active item (expanded) | Currently selected view | Row: accent background `var(--accent-dim)` + left 3px bar. Label in `var(--accent)` color. Shortcut badge uses accent background | — |
| EXP-013 | Phase badge expanded | Sidebar expanded | Badge expands from "P1" → "Phase 1 · Disconnected" or "P2" → "Phase 2 · Connected". Text fades in with same timing as labels. Green dot next to "Connected" text when Phase 2 | — |
| EXP-014 | Section divider | Sidebar expanded, future grouping | Thin 1px `var(--border)` horizontal line between groups if views are grouped (e.g., Browse group vs. DevTools group). Currently no grouping — reserved for V2 | — |

### 2.3 Expanded Hover Interactions

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXP-020 | Hover enabled row (expanded) | Mouse enters expanded enabled row | Full row highlight: `var(--surface-2)` background. No tooltip needed (label is visible). 100ms transition | SW-001 |
| EXP-021 | Hover disabled row (expanded) | Mouse enters expanded disabled row | No background change. Subtle tooltip appears below row: "Deploy to a lakehouse to enable". No cursor change | — |
| EXP-022 | Hover exit row (expanded) | Mouse leaves any row | Background reverts. 100ms transition | EXP-002 |

---

## 3. VIEW SWITCHING

### 3.1 Click-Based Switching

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SW-001 | Click enabled icon (collapsed) | Click on enabled icon in collapsed sidebar | Active indicator slides to clicked icon (200ms). Previous view container fades out (`opacity 1→0`, 100ms). New view container fades in (`opacity 0→1`, 100ms, 100ms delay). Total perceived switch: ~200ms crossfade. View content starts loading if not cached | COL-004, SW-020 |
| SW-002 | Click enabled row (expanded) | Click on enabled row in expanded sidebar | Same crossfade as SW-001. Sidebar stays expanded (mouse is still over it). Active row styling updates immediately | EXP-012, SW-020 |
| SW-003 | Click disabled icon (collapsed) | Click on disabled icon in Phase 1 | Nothing happens. No error. No toast. No visual feedback. Event swallowed. `pointer-events: none` blocks click entirely | COL-005 |
| SW-004 | Click disabled row (expanded) | Click on disabled row in expanded sidebar | Nothing happens. Same as SW-003 | EXP-011 |
| SW-005 | Click already-active icon | Click on the icon that is already active | No-op. No animation replays. No content reload. Idempotent | COL-004 |

### 3.2 View Content Lifecycle

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SW-010 | View first load | View switched to for the first time in session | View container inserted into DOM (if lazy). Loading state shown (view-specific shimmer). Data fetch begins | SW-011, SW-012 |
| SW-011 | View cached switch | View switched to, was previously loaded | Instant display from cached DOM. No shimmer. Data may refresh in background (stale-while-revalidate pattern) | — |
| SW-012 | View switch during load | User switches away before previous view finishes loading | Previous view's pending API calls cancelled (AbortController). New view load starts. No stale data leak | SW-010 |

### 3.3 State Persistence

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SW-020 | Save active view | Any successful view switch | `localStorage.setItem('edog-active-view', viewId)`. Written after view transition completes | — |
| SW-021 | Restore saved view | Page load | Read `localStorage.getItem('edog-active-view')`. If valid and enabled → switch to that view. If invalid → Workspace Explorer. No animation on restore (instant) | COL-004 |
| SW-022 | Saved view now disabled | Page load in Phase 1, saved view was "logs" (Phase 2 only) | Ignore saved value. Default to Workspace Explorer. Update localStorage to "workspace-explorer". Console warn: `Saved view "${id}" not available in current phase, falling back to workspace-explorer` | COL-001 |
| SW-023 | No saved view | First launch, localStorage empty | Default to Workspace Explorer. Save to localStorage | COL-001 |
| SW-024 | Corrupted saved view | localStorage contains invalid viewId | Treat as SW-023. Log warning to console | COL-001 |

---

## 4. PHASE TRANSITIONS

### 4.1 Phase 1 → Phase 2 (Deploy Succeeds)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| PH-001 | Deploy success signal | StateManager emits `phase:connected` | Sidebar receives phase change event. Begins enable cascade | PH-002 |
| PH-002 | Icons enabling (cascade) | Phase change to connected | Icons 2, 3, 4 enable in sequence with 200ms stagger: Icon 2 (Logs) at 0ms, Icon 3 (DAG) at 200ms, Icon 4 (Spark) at 400ms. Each: opacity 0.3 → 1.0 with spring easing (`cubic-bezier(0.34, 1.56, 0.64, 1)`). Click handlers attached. `aria-disabled` removed | PH-003 |
| PH-003 | Phase badge transition (1→2) | During enable cascade | Badge text: "P1" → "P2". Background: `var(--text-3)` grey → `var(--accent)`. Text color stays white. Crossfade 200ms. If expanded: "Phase 1 · Disconnected" → "Phase 2 · Connected" with green dot appearing | COL-002 |
| PH-004 | Token dot updates | Phase 2 reached, MWC token acquired | Token dot changes from grey (no MWC) to green (MWC valid). 200ms color transition | COL-006 |
| PH-005 | Enable complete | All 3 icons enabled | Cascade animation ends. All icons interactive. Keyboard shortcuts 2, 3, 4 now functional. No toast (deploy flow already shows success toast) | COL-002 |

### 4.2 Phase 2 → Phase 1 (Undeploy / Service Crash)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| PH-010 | Service disconnect signal | StateManager emits `phase:disconnected` | Sidebar receives phase change event. Begins disable sequence | PH-011 |
| PH-011 | Icons disabling (reverse cascade) | Phase change to disconnected | Icons 4, 3, 2 disable in reverse sequence with 150ms stagger: Icon 4 (Spark) at 0ms, Icon 3 (DAG) at 150ms, Icon 2 (Logs) at 300ms. Each: opacity 1.0 → 0.3 with ease-out. Click handlers removed. `aria-disabled="true"` set | PH-012 |
| PH-012 | Phase badge transition (2→1) | During disable cascade | Badge: "P2" → "P1". Accent → grey. If expanded: "Phase 2 · Connected" → "Phase 1 · Disconnected". Green dot disappears | PH-013 |
| PH-013 | Disable complete (user on Phase 1 view) | User was on Workspace Explorer, API Playground, or Environment | No view switch needed. Disabled icons now at 30% opacity. Shortcuts 2, 3, 4 disabled | COL-001 |
| PH-014 | Disable complete (user on Phase 2 view) | User was on Logs, DAG Studio, or Spark Inspector when disconnect happens | Auto-switch to Workspace Explorer (SW-001 animation). Active bar moves to icon 1. Previous Phase-2 view content is cleared from cache. localStorage updated to "workspace-explorer" | SW-001, COL-001 |
| PH-015 | Rapid phase toggle | Deploy succeeds then immediately crashes (within <1s) | If enable cascade is still animating when disable signal arrives: interrupt cascade, immediately snap all Phase-2 icons to disabled (30% opacity, no animation). Prevent visual glitch | COL-001 |

### 4.3 Deploying Intermediate State

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| PH-020 | Deploy in progress | StateManager emits `phase:deploying` | Phase badge: "P1" → spinner + "..." (small 12px spinner in badge area). Disabled icons remain disabled (no change yet). Badge tooltip: "Deploying to {lakehouseName}..." | PH-001 or PH-021 |
| PH-021 | Deploy failed | Deploy flow fails, phase stays disconnected | Spinner in badge stops. Badge reverts to "P1" grey. No icon changes (already disabled). No sidebar-specific error (deploy flow handles error display) | COL-001 |

---

## 5. NOTIFICATION BADGES

### 5.1 Badge Appearance

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| BADGE-001 | Error badge on Logs icon | WebSocket receives log entry with `level: "error"` while Logs view is not active | Red dot (8px circle, `oklch(0.63 0.26 25)`) appears top-right of Logs icon. Scale-in animation: `scale(0) → scale(1.2) → scale(1)` over 300ms with spring easing. Dot pulses once on appear | BADGE-010 |
| BADGE-002 | Running badge on DAG icon | DAG execution starts (WebSocket event) while DAG Studio is not active | Amber dot (8px, `oklch(0.80 0.15 85)`) appears top-right of DAG icon. Same scale-in as BADGE-001 | BADGE-011 |
| BADGE-003 | Changed badge on Environment icon | Feature flag override applied or flag values changed while Environment view is not active | Blue dot (8px, `oklch(0.65 0.15 250)`) appears top-right of Environment icon. Same scale-in | BADGE-012 |
| BADGE-004 | Badge on disabled icon | Error occurs while icon is disabled (Phase 1) | Badge still appears (visible at 30% parent opacity means badge itself is dimmed). Badge will be fully visible when icon enables. Stores badge state for when phase changes | PH-002 |
| BADGE-005 | Multiple badges | Errors in logs + DAG running + flags changed simultaneously | Each icon shows its own badge independently. No combined indicator. Max 3 badges visible at once | — |

### 5.2 Badge Dismissal

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| BADGE-010 | Logs badge dismissed | User switches to Logs view | Red dot fades out: `opacity 1→0` over 150ms, then removed from DOM. Error count in logs view resets "unread" counter | COL-004 |
| BADGE-011 | DAG badge dismissed | User switches to DAG Studio view | Amber dot fades out same as BADGE-010. DAG view shows current execution state | COL-004 |
| BADGE-012 | Environment badge dismissed | User switches to Environment view | Blue dot fades out same as BADGE-010. Changed flags highlighted in Environment view | COL-004 |
| BADGE-013 | Badge auto-dismiss (DAG) | DAG execution completes while DAG view is not active | Amber dot changes to green dot briefly (300ms) then fades out. Indicates "completed without needing attention" | COL-002 |
| BADGE-014 | Badge persists across expand/collapse | Sidebar expands or collapses while badge is showing | Badge stays in same relative position (top-right of icon). No re-animation on expand/collapse | — |

### 5.3 Badge in Expanded State

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| BADGE-020 | Badge with label visible | Sidebar expanded, badge present | Badge dot moves to right side of label row (after shortcut badge). Additionally: label text appends context. E.g., "Logs · 2" becomes "Logs · 2  ● 3 errors". Context text in badge color | — |
| BADGE-021 | Badge count overflow | >99 errors in logs | Badge text: "99+" in expanded view. Dot size unchanged in collapsed view | — |

---

## 6. KEYBOARD & ACCESSIBILITY

### 6.1 Number Key Shortcuts

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| KB-001 | Shortcut to enabled view | Press "1", "5", or "6" (no modifier, no input focused) | Instant view switch. Same behavior as SW-001 but without hover/click visual. Active bar animates to target icon | SW-001 |
| KB-002 | Shortcut to disabled view | Press "2", "3", or "4" in Phase 1 | No view switch. Target icon does a subtle horizontal shake animation: `translateX(0 → -3px → 3px → -2px → 2px → 0)` over 300ms. Shake uses `ease-out`. Tooltip flashes briefly (1s): "Deploy to enable" | COL-005 |
| KB-003 | Shortcut while input focused | Press "2" while typing in a text input or textarea | Shortcut suppressed. Character "2" types into input as normal. Sidebar does not react. Check: `document.activeElement.tagName` is not `INPUT`, `TEXTAREA`, or `[contenteditable]` | — |
| KB-004 | Shortcut to already-active view | Press "1" when Workspace Explorer is already active | No-op. No animation. No content reload | — |
| KB-005 | Shortcut during view transition | Press "3" while crossfade from SW-001 is still animating | Queue or replace: cancel current transition, start new one to view 3 (if enabled). No double-animation | SW-001 |

### 6.2 Tab / Arrow Navigation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| KB-010 | Tab into sidebar | Tab from content area or top bar reaches sidebar | First enabled icon receives focus. Focus ring: 2px solid `var(--accent)` with 2px offset, rounded to match icon radius. `outline-offset: 2px` | KB-011 |
| KB-011 | Arrow down in sidebar | Arrow Down while sidebar icon focused | Focus moves to next icon (skipping disabled icons). Wraps from last to first. Focus ring moves | KB-012, KB-013 |
| KB-012 | Arrow up in sidebar | Arrow Up while sidebar icon focused | Focus moves to previous icon (skipping disabled icons). Wraps from first to last | KB-011 |
| KB-013 | Enter on focused icon | Enter or Space while enabled icon focused | Activates that view (same as SW-001). Focus remains on the icon (does not move to content) | SW-001 |
| KB-014 | Enter on disabled icon | Enter or Space while disabled icon is somehow focused (shouldn't happen if skip logic works) | Nothing. Disabled icons are skipped in tab order via `tabindex="-1"` | — |
| KB-015 | Escape from sidebar | Escape while any sidebar icon focused | Focus moves to main content area (first focusable element in active view). Sidebar loses focus ring | — |
| KB-016 | Tab past sidebar | Tab on last enabled icon | Focus exits sidebar, moves to content area. Standard tab flow | — |

### 6.3 Screen Reader Announcements

| ID | State | Trigger | What User Sees (Hears) | Next States |
|----|-------|---------|------------------------|-------------|
| KB-020 | Sidebar landmark | Screen reader enters sidebar | `<nav aria-label="View navigation">`. Announced: "View navigation, navigation landmark" | KB-021 |
| KB-021 | Enabled icon announced | Focus reaches enabled icon | "Workspace Explorer, button, 1 of 6" or "API Playground, button, 5 of 6". Active icon additionally: "current" (`aria-current="true"`) | — |
| KB-022 | Disabled icon announced | Screen reader encounters disabled icon (if in reading mode) | "Logs, button, disabled. Deploy to a lakehouse to enable." `aria-disabled="true"` + `aria-description="Deploy to a lakehouse to enable this view"` | — |
| KB-023 | View switch announced | View switches via click or keyboard | Live region announces: "Switched to {viewName} view". `aria-live="polite"` region in sidebar updates | — |
| KB-024 | Phase change announced | Phase 1 → Phase 2 or reverse | Live region: "Phase 2: Connected. Logs, DAG Studio, and Spark Inspector are now available." or "Phase 1: Disconnected. Logs, DAG Studio, and Spark Inspector are disabled." | — |
| KB-025 | Badge announced | Notification badge appears | Live region: "3 new errors in Logs" or "DAG execution started" or "Feature flags changed". Polite priority (no interrupt) | — |

---

## 7. RESPONSIVE LAYOUT

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RESP-001 | Wide viewport (≥1200px) | Window width ≥1200px | Standard 52px sidebar, left-positioned. Full content area. Expand-on-hover enabled | COL-001 |
| RESP-002 | Medium viewport (1000–1199px) | Window width 1000–1199px | Sidebar remains 52px but expand-on-hover disabled (tooltip-only mode). Content area has reduced width but still usable | COL-001 (no expand) |
| RESP-003 | Narrow viewport (<1000px) | Window width <1000px | Sidebar collapses to 0px. Hamburger icon (☰) appears in top-left of top bar. Content area uses full width | RESP-004 |
| RESP-004 | Hamburger menu open | Click hamburger icon when viewport <1000px | Overlay panel slides in from left (200ms, `ease-out`). Shows all 6 views as full rows (icon + label + shortcut). Same enabled/disabled styling. Semi-transparent backdrop behind. Click backdrop or Escape to close | RESP-005 |
| RESP-005 | Hamburger menu close | Click backdrop, select a view, or press Escape | Panel slides out (150ms). Backdrop fades. If view was selected, content updates | RESP-003 |
| RESP-006 | Resize across breakpoint | Window resized from >1000px to <1000px while sidebar visible | Sidebar smoothly collapses. Hamburger appears. No content disruption. Active view preserved | RESP-003 |
| RESP-007 | Resize back across breakpoint | Window resized from <1000px to >1000px | Hamburger disappears. Sidebar re-appears at 52px. If hamburger menu was open, it closes. Active view unchanged | RESP-001 |

---

## 8. EDGE CASES

### 8.1 Hover Timing & Debounce

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-001 | Rapid hover in/out | Mouse crosses sidebar edge multiple times in <200ms | Expand/collapse debounced. Sidebar does not start expanding until mouse has been inside for 100ms continuously. Collapse delayed 200ms after mouse exits. Prevents jitter | COL-001 |
| EDGE-002 | Click then mouse leaves | User hovers (sidebar expands), clicks an item, then moves mouse away | Sidebar stays expanded for 300ms after click (allows visual confirmation of selection), then begins 200ms collapse. Total 500ms before fully collapsed | COL-001 |
| EDGE-003 | Hover while transitioning | Mouse enters sidebar during collapse animation | Collapse reverses immediately. Expand resumes from current interpolated width. No visual snap | EXP-002 |

### 8.2 View Persistence Conflicts

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-010 | localStorage blocked | Browser blocks localStorage (private mode, quota exceeded) | Graceful fallback: default to Workspace Explorer every load. Console warn once. No error UI | COL-001 |
| EDGE-011 | Two tabs, different views | User has EDOG open in two tabs, selects different views | Each tab maintains independent active view. localStorage uses last-write-wins. Refresh either tab → picks up last written value. No cross-tab sync | SW-021 |
| EDGE-012 | Phase mismatch across tabs | Tab 1 in Phase 2, Tab 2 still Phase 1, both share localStorage | Each tab's sidebar reflects its own phase state (received via its own WebSocket). localStorage "active-view" may reference a Phase-2 view that Tab 2 can't show → Tab 2 falls back to Workspace Explorer (SW-022) | SW-022 |

### 8.3 Keyboard Edge Cases

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-020 | All Phase 2 shortcuts pressed | User presses "2", "3", "4" rapidly in Phase 1 | Each press triggers icon shake on respective icon (KB-002). Shakes can overlap — each icon shakes independently. Tooltip shows on last-pressed icon only (previous tooltip dismissed) | COL-001 |
| EDGE-021 | Modifier + number key | Ctrl+1, Alt+2, etc. | Sidebar does NOT handle modified shortcuts. Browser default behavior preserved (Ctrl+1 = switch to first browser tab). Only bare number keys trigger view switch | — |
| EDGE-022 | Numpad numbers | Numpad 1–6 pressed | Treated same as main keyboard 1–6. Both `event.key === "1"` and numpad produce same result | KB-001 or KB-002 |
| EDGE-023 | Command palette open | Press "2" while Ctrl+K command palette is open | Shortcut suppressed. Command palette has focus, sidebar does not react. Same guard as KB-003 (focus check) | — |

### 8.4 Animation & Performance

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-030 | Reduced motion preference | `prefers-reduced-motion: reduce` set in OS | All sidebar animations disabled: expand/collapse is instant, icon enable/disable cascade is instant (no stagger), badge appears without scale animation. Functional behavior unchanged | — |
| EDGE-031 | GPU-accelerated properties | Any sidebar animation | Only `transform` and `opacity` animated (GPU-composited). No `width` animation on sidebar — use `transform: translateX()` or `clip-path` to simulate expand. No layout thrashing | — |
| EDGE-032 | >6 views (future-proofing) | New view added beyond original 6 | Sidebar scrolls if items exceed viewport height: `overflow-y: auto` with thin custom scrollbar (`4px`, `var(--surface-3)`). Scroll position resets on page load. Keyboard navigation wraps correctly through all items | — |

### 8.5 Initialization Race Conditions

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-040 | Sidebar loads before phase known | Page loads, StateManager hasn't determined phase yet | All Phase-2-only icons start disabled (conservative default). Once phase is determined (usually <500ms), enable cascade plays if Phase 2, otherwise no change | PH-002 or COL-001 |
| EDGE-041 | Sidebar loads before config API | `/api/flt/config` hasn't responded yet | Sidebar renders immediately with Phase 1 defaults. Phase badge shows spinner until config resolves. No blocking of sidebar interaction for Phase 1 views | PH-020 |
| EDGE-042 | Multiple rapid phase events | StateManager emits `connected` then `disconnected` within 100ms | Debounce phase transitions: only act on phase after 200ms of stable state. If phase flips during debounce window, use the final value. Prevents half-enabled visual states | PH-015 |

---

## State Count Summary

| Category | Count |
|----------|-------|
| Collapsed State (COL-*) | 16 |
| Expanded State (EXP-*) | 14 |
| View Switching (SW-*) | 12 |
| Phase Transitions (PH-*) | 12 |
| Notification Badges (BADGE-*) | 12 |
| Keyboard & Accessibility (KB-*) | 12 |
| Responsive Layout (RESP-*) | 7 |
| Edge Cases (EDGE-*) | 11 |
| **Total** | **96** |

---

## CSS Custom Properties Referenced

```css
--accent          /* Primary accent color, OKLCH */
--accent-dim      /* Accent at ~10% opacity for backgrounds */
--surface-1       /* Sidebar background */
--surface-2       /* Hover background */
--surface-3       /* Tooltip background, scrollbar */
--border          /* Separator lines */
--text-1          /* Primary text */
--text-2          /* Secondary text (inactive icons) */
--text-3          /* Tertiary text (shortcut badges, phase badge) */
--radius-md       /* Border radius for icons */
```

## DOM Structure Reference

```html
<nav id="sidebar" class="sidebar" aria-label="View navigation" data-phase="disconnected">
  <div class="sidebar-icons">
    <button class="sidebar-icon active" data-view="workspace-explorer" data-shortcut="1" aria-current="true">
      <svg><!-- grid icon --></svg>
      <span class="sidebar-label">Workspace Explorer</span>
      <span class="sidebar-shortcut">1</span>
    </button>
    <button class="sidebar-icon" data-view="logs" data-shortcut="2" data-phase-required="connected" aria-disabled="true" tabindex="-1">
      <svg><!-- list icon --></svg>
      <span class="sidebar-label">Logs</span>
      <span class="sidebar-shortcut">2</span>
      <span class="sidebar-badge" hidden></span>
    </button>
    <!-- ... icons 3-6 ... -->
  </div>
  <div class="sidebar-phase-badge" aria-live="polite">P1</div>
  <div class="sidebar-token-dot" aria-label="Token status: valid"></div>
</nav>
```
