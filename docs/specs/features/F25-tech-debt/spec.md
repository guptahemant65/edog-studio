# F25 — Tech Debt & UI Polish

> **Status:** Open — ongoing backlog
> **Priority:** P2 (address during implementation sprints, not standalone)
> **Owner:** Pixel (frontend), Vex (backend)
> **Source:** Phantom design review (2026-04-16), ongoing discoveries

---

## Overview

A living backlog of technical debt, UI polish gaps, and quality improvements discovered during feature development. Items are prioritized by impact and grouped by domain.

**Philosophy:** Tech debt is addressed surgically during feature sprints — not as a standalone cleanup project. When touching a file for a feature, fix the debt in that file too.

---

## TD-01 — Logs View (Source: Phantom Review)

Current score: **7.5/10** — functionally deep, minor polish gaps.

### Tier 1 — Fix Real Problems

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-01.1 | **Row height discrepancy** — CSS says 32px, JS RowPool says 34px. Virtual scroll accuracy depends on exact match. Pick 34px, apply everywhere. | 🔴 Bug | `logs.css`, `renderer.js` |
| TD-01.2 | **Timestamp opacity ambiguous** — 0.7 reads as "broken" not "intentionally dim". Change to 0.55 (clearly secondary) or 0.85 (clearly readable). | 🟠 Readability | `logs.css` |
| TD-01.3 | **No active filter indicator** — When 3+ filters combine, users lose track of what's hiding rows. Add "3 filters active ✕" badge near search bar. | 🟠 UX | `filters.js`, toolbar CSS |
| TD-01.4 | **Missing `prefers-reduced-motion`** — Wrap all keyframes in media query. Accessibility requirement. | 🟠 A11y | All logs CSS |
| TD-01.5 | **Error alert has no entrance animation** — Low-frequency (2-3× per session), high-importance. Add 150ms slideDown ease-out. | 🟡 Polish | `error-intel.js`, alert CSS |

### Tier 2 — Improve Scannability

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-01.6 | **Toolbar overloaded** — 18 controls, no hierarchy. Group into 3 tiers: Primary (search + levels), Secondary (time + presets), Tertiary ("More Filters" toggle). | 🟠 UX | `index.html`, toolbar CSS |
| TD-01.7 | **Level badges too small** — 10px text in pill. Increase to 12px, bolder weight, 20×20 pill for vertical scan-ability. | 🟡 Scan | `logs.css` |
| TD-01.8 | **Error count badge needs flash** — `stat-errors` counter should get brief background transition when count increments. Not animation — CSS transition. | 🟡 Polish | `renderer.js`, stats CSS |
| TD-01.9 | **Export has no feedback** — User clicks Export, silence. Add toast: "Exported 1,247 entries as JSON". | 🟡 UX | `main.js`, logs CSS |
| TD-01.10 | **Detail panel needs entrance** — Slide in from right, 150ms ease-out translateX. Not spring — clean fast reveal. | 🟡 Polish | `detail-panel.js`, detail CSS |

### Tier 3 — Cleanup

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-01.11 | **Legacy `telemetry.css` dead selectors** — Audit and remove or migrate to `tl-*` namespace. | 🟢 Maint | `telemetry.css` |
| TD-01.12 | **Hardcoded font sizes** — Replace raw px values with token references where design system has matching stops. | 🟢 Consistency | All CSS |
| TD-01.13 | **Logs empty state generic** — 3-dot pulse is basic. Better-crafted static illustration with subtle icon pulse (NOT orbital animation — this is a log viewer). | 🟢 Polish | `logs.css`, `index.html` |
| TD-01.14 | **Breakpoints bar timing** — `200ms ease-out` → `150ms ease-out`. Faster = better for toolbars. | 🟢 Polish | `logs-enhancements.css` |

---

## TD-02 — Telemetry Tab (Source: Phantom Review)

Current score: **7.8/10** — best in codebase, minor gaps.

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-02.1 | **No card status transition animation** — Running→succeeded should animate: badge checkPop (120ms), duration bar spring-snap. Low-frequency, appropriate. | 🟡 Polish | `tab-telemetry.js/css` |
| TD-02.2 | **Three-speed motion discipline** — Everything is 160ms. Should be 80ms (hover), 150ms (card entrance), 360ms (detail panel). | 🟡 Consistency | `tab-telemetry.css` |
| TD-02.3 | **No reverse cross-link** — Log → telemetry correlation exists. Telemetry → specific log entries does not. | 🟢 UX | Multiple modules |

---

## TD-03 — Error Intelligence & Anomaly (Source: Phantom Review)

Current score: **6.7/10** — detection excellent (9/10), surfacing weak (4/10).

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-03.1 | **Error alert uses raw innerHTML** — No animation, no shadows, no visual weight for a high-importance event. Add slideDown + compound shadow on the alert card. | 🟠 UX | `error-intel.js`, alert CSS |
| TD-03.2 | **Anomaly warnings have no visual weight** — Retry storms, slow nodes detected but surfaced flatly. Add entrance animation (150ms) + left border accent. | 🟡 Polish | `anomaly.js`, CSS |
| TD-03.3 | **No "show all related logs" from alert** — Error alert shows codes and nodes but no one-click to filter logs to just those entries. | 🟡 UX | `error-intel.js`, `filters.js` |

---

## TD-04 — Cross-System (Source: Phantom Review)

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-04.1 | **Keyboard shortcut discoverability** — `?` key should open overlay showing all shortcuts across all views. | 🟢 UX | New module |
| TD-04.2 | **Unified detail panel language** — Log detail panel and telemetry detail panel should share visual language: compound elevation, resize handle, section titles, JSON tree, copy actions. | 🟢 Consistency | `detail-panel.js`, `tab-telemetry.js` |

---

## Design Rules for Log Viewers (Reference)

Captured from Phantom's corrected assessment — apply whenever touching logs/telemetry UI:

**DO:**
- Token system, typography, color-coding — fully applies
- Animate chrome (panels, alerts, toolbars) — low-frequency, user-triggered
- Flat background-only hover on data rows — no transforms, no shadows
- Instant filter swaps — no crossfade, no transition on data changes
- Density and readability over visual flair

**DON'T:**
- Animate data rows (50+ rows/sec = GPU death)
- Hover lift on data rows (scanning = 50 rows under cursor per second)
- Compound shadows on data rows (1000+ elements = wasted GPU)
- Crossfade on filter changes (double DOM nodes during transition)
- Spring physics on anything that appears more than 5× per minute

> *"The data is the performance; the UI stays dark so you can see the show."* — Phantom

---

## TD-05 — Workspace Explorer (Source: Phantom Review)

Current score: **7.2/10** — solid functional foundation, critical accessibility gaps.

### Tier 1 — Fix Real Problems (bugs, broken UX)

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-05.1 | **No ARIA tree semantics** — Container missing `role="tree"`, nodes missing `role="treeitem"`, no `aria-expanded`, `aria-selected`, `aria-level`. Screen readers can't navigate the tree at all. | 🔴 A11y | `workspace-explorer.js` |
| TD-05.2 | **No keyboard navigation** — Only Escape and Ctrl+F bound. Arrow keys, Enter/Space, Home/End, F2, Delete all missing. Keyboard-only users are locked out. | 🔴 A11y | `workspace-explorer.js` |
| TD-05.3 | **No `focus-visible` styles** — No visual indicator of which element has focus for keyboard users. Missing entirely from CSS. | 🔴 A11y | `workspace.css` |
| TD-05.4 | **Context menu missing ARIA roles** — No `role="menu"` / `role="menuitem"`, no keyboard trap (ArrowUp/Down, Escape, Enter). | 🟠 A11y | `workspace-explorer.js`, `workspace.css` |
| TD-05.5 | **Toast lacks `aria-live`** — Screen readers don't announce toast notifications. | 🟠 A11y | `workspace-explorer.js` |
| TD-05.6 | **Event listener leak on re-render** — Per-node click handlers create closures over stale workspace objects. Should use event delegation on `_treeEl`. | 🟠 Bug | `workspace-explorer.js` |

### Tier 2 — Improve Core Experience

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-05.7 | **Loading state doesn't match spec** — States.md specifies shimmer skeletons; actual shows plain "Loading..." text. | 🟠 UX | `workspace-explorer.js` |
| TD-05.8 | **No collapse animation** — Children animate in with stagger but vanish instantly on collapse. Jarring asymmetry. | 🟡 Polish | `workspace-explorer.js`, `workspace.css` |
| TD-05.9 | **No filter debouncing** — Table filter runs full DOM sweep on every keystroke. 9 sweeps for "warehouse". | 🟡 Perf | `workspace-explorer.js` |
| TD-05.10 | **Triple click handler overlap** — Workspace row has 3 overlapping handlers (name, toggle, row) with fragile `stopPropagation`. Use event delegation. | 🟡 Maint | `workspace-explorer.js` |
| TD-05.11 | **No tree search** — States.md specifies search for 50+ items. Only table content has filter, tree does not. | 🟡 UX | `workspace-explorer.js` |
| TD-05.12 | **40+ hard-coded rgba colors** — `rgba(109,92,255,...)` bypasses token system. Will break on theme/accent changes. | 🟡 Theme | `workspace.css` |
| TD-05.13 | **Tree item height mismatch** — CSS sets 30px, `variables.css` has `--row-height: 28px`. 2px inconsistency. | 🟡 Consistency | `workspace.css` |

### Tier 3 — Polish & Cleanup

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-05.14 | **14 hard-coded font sizes** — `13px`, `14px`, `12px` etc. bypass typography scale. | 🟢 Consistency | `workspace.css` |
| TD-05.15 | **12 hard-coded spacings** — `48px`, `24px`, `16px` etc. bypass spacing scale. | 🟢 Consistency | `workspace.css` |
| TD-05.16 | **`oklch()` color in error state** — Not in token system, inconsistent with rgba pattern elsewhere. | 🟢 Consistency | `workspace.css` |
| TD-05.17 | **Duplicate `.ws-content-meta` selector** — Two definitions create confusion about precedence. | 🟢 Maint | `workspace.css` |
| TD-05.18 | **Dead code** — `_getHealthStatus()` defined but never called, `health` var assigned but unused. | 🟢 Maint | `workspace-explorer.js` |
| TD-05.19 | **`z-index: 9998` on burst particles** — Bypasses z-index scale. Should use token. | 🟢 Maint | `workspace.css` |
| TD-05.20 | **No custom scrollbar styling** — Browser-default scrollbar is visually heavy on Windows. | 🟢 Polish | `workspace.css` |
| TD-05.21 | **SVG icon color hard-coded in CSS data URL** — Won't respond to theme changes. | 🟢 Theme | `workspace.css` |
| TD-05.22 | **Table row animation too slow** — 400ms with cubic-bezier bounce. Design bible says max 150ms for data views. | 🟢 Polish | `workspace.css` |
| TD-05.23 | **`en-IN` number format** — Hard-coded Indian locale may confuse non-Indian users. Should detect locale. | 🟢 i18n | `workspace-explorer.js` |

### Tier 4 — Nice to Have

| ID | Issue | Impact | Files |
|----|-------|--------|-------|
| TD-05.24 | **No virtual scrolling** — 1000+ workspaces = 1000+ DOM nodes. Performance will degrade at scale. | 🟢 Perf | `workspace-explorer.js` |
| TD-05.25 | **No expand/collapse state persistence** — Page refresh loses all tree expansion. Persist to `localStorage`. | 🟢 UX | `workspace-explorer.js` |
| TD-05.26 | **Race condition on rapid create** — Multiple clicks submit duplicate API calls. No button disable during fetch. | 🟢 Bug | `workspace-explorer.js` |

---

## How to Use This Backlog

1. **During feature sprints:** When touching a file listed here, fix the debt in that file
2. **Priority order:** 🔴 Bug → 🟠 UX/A11y → 🟡 Polish → 🟢 Maintenance
3. **Mark as done:** Update this file with ✅ and commit reference when fixed
4. **Add new items:** Append to the relevant section with next available ID
