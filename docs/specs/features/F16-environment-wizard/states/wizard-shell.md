# P3 State Matrices — Wizard Shell

> **Components:** C01-InfraWizardDialog, C11-FloatingBadge
> **Feature:** F16 — New Infrastructure Wizard
> **Phase:** P3 (State Matrices)
> **Owner:** Pixel (JS/CSS) + Sana (state design)
> **Spec Refs:** `C01-infra-wizard-dialog.md`, `C11-floating-badge.md`, `architecture-frontend.md`
> **Last Updated:** 2025-07-15

---

## Table of Contents

1. [C01-InfraWizardDialog States](#c01---infrawizarddialog-states)
2. [C11-FloatingBadge States](#c11---floatingbadge-states)
3. [Cross-Cutting Concerns](#cross-cutting-concerns)
4. [Composite Transition Map](#composite-transition-map)

---

# C01 — InfraWizardDialog States

## State D01: `dialog.closed`

**State ID:** `dialog.closed`

**Entry conditions:**
- Application start (default state — no wizard has been opened).
- Exit animation completes after user confirms discard or closes a completed wizard.
- Rollback completes after execution failure and user chose to close.
- `destroy()` called for emergency cleanup.

**Exit conditions:**
- `open()` called by WorkspaceExplorer context menu, empty-state CTA, or command palette → **D02 `dialog.initializing`**.

**Visual description:**
No wizard DOM exists anywhere in the document. The application viewport is fully interactive with no overlay, no backdrop blur, no dialog container. The `<body>` has no `.has-wizard-overlay` class. All keyboard shortcuts for the main application are active.

**Active DOM elements:**
- Visible: Main application UI (workspace explorer, log viewer, status bar).
- Hidden: Entire wizard DOM tree (not in DOM — not `display:none`, literally absent).
- Disabled: None.

**Keyboard shortcuts:**
- All main application shortcuts active.
- Wizard-specific shortcuts (`Escape`, `Ctrl+Enter`, `Alt+Arrow`) are NOT bound.

**Data requirements:**
- None. `InfraWizardDialog._activeInstance === null`.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `open()` | `_activeInstance === null && apiClient.hasBearerToken()` | D02 | Create DOM, register singleton |
| `open()` | `_activeInstance !== null` | D01 (self) | Flash existing wizard/badge, show toast |
| `open()` | `!apiClient.hasBearerToken()` | D01 (self) | Toast: "Authentication required" |

**Error recovery:**
- If DOM fragments from a previous crash exist, `open()` calls `destroy()` on the orphan first.

**Animation:**
- None (no DOM to animate).

---

## State D02: `dialog.initializing`

**State ID:** `dialog.initializing`

**Entry conditions:**
- `open()` called from `dialog.closed` with valid guards.

**Exit conditions:**
- Entrance animation completes (~450ms) → **D03 `dialog.page0.active`**.
- `destroy()` called during animation → **D01 `dialog.closed`**.

**Visual description:**
The `.iw-overlay` fades in with `backdrop-filter: blur(0 → 8px)` and `background: rgba(0,0,0, 0 → 0.18)` over 400ms. The `.iw-dialog` enters from `scale(0.94) translateY(16px) opacity(0)` to `scale(1) translateY(0) opacity(1)` over 450ms with spring easing (`var(--spring)`). The stepper shows all 5 circles in pending state (muted). Page 0 markup is in the DOM but not yet activated. Footer shows "Next →" button disabled until activation.

**Active DOM elements:**
- Visible: `.iw-overlay` (animating), `.iw-dialog` (animating), `.iw-header`, `.iw-stepper`, `.iw-page-container` with `.iw-page#iw-page-0.active`.
- Hidden: Pages 1–4 (in DOM, no `.active` class), `.iw-confirm-overlay`.
- Disabled: ALL interactive elements — buttons, inputs, stepper circles. `pointer-events: none` on `.iw-dialog` during animation.

**Keyboard shortcuts:**
- None active. Focus trap not yet established. Keyboard events ignored.

**Data requirements:**
- `WizardState` created with defaults (or from `options.initialState` if template).
- Session geometry loaded from `sessionStorage` or `DEFAULT_GEOMETRY` applied.
- Page component instances constructed (`InfraSetupPage`, `ThemeSchemaPage`, etc.) but not activated.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Entrance animation ends (450ms timeout) | Always | D03 | `activatePage(0)`, setup focus trap, bind shortcuts |
| `destroy()` | Always | D01 | Remove DOM, release singleton |

**Error recovery:**
- If animation doesn't fire `animationend`, a 1000ms safety timeout forces transition to D03.

**Animation:**
- **Entry:** Overlay: `iw-overlayIn` 400ms `var(--ease)`. Dialog: `iw-dialogIn` 450ms `var(--spring)`.
- **Exit:** None from this state (only via `destroy()` — immediate removal, no animation).

---

## State D03: `dialog.page0.active`

**State ID:** `dialog.page0.active`

**Entry conditions:**
- Entrance animation completes from D02.
- User navigates back from Page 1 (D04 → D03 via back-click).
- User clicks completed step circle 0 from any later page.

**Exit conditions:**
- "Next →" clicked and Page 0 validates → **D04 `dialog.page1.active`**.
- Close (X) clicked or Escape pressed, `dirty === false` → **D01 `dialog.closed`**.
- Close (X) clicked or Escape pressed, `dirty === true` → **D13 `dialog.closing.confirm`**.

**Visual description:**
The `.iw-dialog` is fully visible at 920x680 (or session-remembered size). The title bar reads "New Infrastructure" with the layers icon in `var(--accent)`. The stepper shows circle 1 highlighted (`--accent` background, white number), circles 2–5 in `--surface-3` (muted). No connector fills are active. The page container shows the InfraSetupPage (C02) with workspace name input, capacity dropdown, lakehouse name, and notebook name fields. The footer shows only "Next →" (`btn-primary`), no Back button.

**Active DOM elements:**
- Visible: `.iw-overlay`, `.iw-dialog`, `.iw-header`, `.iw-stepper` (circle 0 active), `.iw-page#iw-page-0.active`, `.iw-footer` (Next only).
- Hidden: Pages 1–4, `.iw-confirm-overlay`, Back button.
- Disabled: Stepper circles 1–4 (not yet completed, not clickable).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | `_handleClose()` |
| `Tab` / `Shift+Tab` | Focus trap cycles within dialog |
| `Ctrl+Enter` | Trigger Next click |
| `Alt+→` | Trigger Next click |

**Data requirements:**
- `InfraSetupPage.activate(state)` called — fetches capacity list via `GET /v1.0/myorg/capacities`.
- Workspace name populated (random Docker-style placeholder or from template).
- Capacity dropdown loading or populated.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Next click / `Ctrl+Enter` / `Alt+→` | `pages[0].validate() === null` | D04 | `collectState`, `slideTransition(0, 1, 'forward')` |
| Next click | `pages[0].validate() !== null` | D03 (self) | Show validation error, shake Next button (400ms) |
| Close / Escape | `dirty === false` | D01 | Play exit animation, remove DOM |
| Close / Escape | `dirty === true` | D13 | Show close confirmation |
| Title bar drag start | Always | D03 (self, dragging) | Begin drag sequence |
| Edge/corner pointer down | Always | D03 (self, resizing) | Begin resize sequence |
| Title bar double-click | Always | D03 (self) | Re-center dialog (300ms ease) |

**Error recovery:**
- If capacity fetch fails, Page 0 shows inline error in dropdown with "Retry" link. Validation blocks Next until a capacity is selected.

**Animation:**
- **Entry from D02:** Immediate (no page-specific animation; dialog entrance already played).
- **Entry from D04 (back):** Page slides in from left, `translateX(-60px → 0)` over `--t-page` (360ms).
- **Exit to D04 (next):** Page slides out left, `translateX(0 → -60px) opacity(1 → 0)` over 360ms.

---

## State D04: `dialog.page1.active`

**State ID:** `dialog.page1.active`

**Entry conditions:**
- Page 0 validates and user clicks Next → forward slide transition.
- User navigates back from Page 2 (D05 → D04).
- User clicks completed step circle 1 from Page 2 or 3.

**Exit conditions:**
- "Next →" clicked and Page 1 validates → **D05 `dialog.page2.active`**.
- "← Back" clicked → **D03 `dialog.page0.active`**.
- Close / Escape with dirty check → **D13** or **D01**.

**Visual description:**
The stepper shows circles 0 and 1 highlighted — circle 0 has a checkmark (`iw-step-check` visible, `iw-step-num` hidden), circle 1 is active (`--accent` bg). Connector 0→1 fill is at 100% (`scaleX(1)` with `--accent`). The ThemeSchemaPage (C03) occupies the page container showing the 6 theme cards in a 3x2 grid and the schema toggle section below. Footer: "← Back" + "Next →".

**Active DOM elements:**
- Visible: `.iw-overlay`, `.iw-dialog`, stepper (circle 0 checkmarked, circle 1 active, connector 0→1 filled), `.iw-page#iw-page-1.active`, `.iw-footer` (Back + Next).
- Hidden: Pages 0, 2–4.
- Disabled: Stepper circles 2–4. Circle 0 is clickable (completed).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | `_handleClose()` |
| `Tab` / `Shift+Tab` | Focus trap |
| `Ctrl+Enter` | Trigger Next |
| `Alt+←` | Trigger Back |
| `Alt+→` | Trigger Next |

**Data requirements:**
- Theme selection state from `state.theme` (null or selected `ThemeId`).
- Schema toggles from `state.schemas` (`dbo: true` always, bronze/silver/gold booleans).

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Next click | `pages[1].validate() === null` (theme selected) | D05 | `collectState`, slide forward |
| Next click | validation fails (no theme selected) | D04 (self) | Error: "Please select a data theme" |
| Back click / `Alt+←` | Always | D03 | `collectState`, slide backward |
| Step circle 0 click | Always | D03 | `collectState`, slide backward |
| Close / Escape | dirty check | D13 or D01 | Close flow |

**Error recovery:**
- No async operations on this page. Pure local state. No error scenarios beyond validation.

**Animation:**
- **Entry from D03:** Slide in from right `translateX(60px → 0)`, 360ms. Connector 0→1 fill animates `scaleX(0 → 1)` over 400ms with `var(--ease)`.
- **Entry from D05 (back):** Slide in from left.
- **Exit forward:** Slide out left.
- **Exit backward:** Slide out right.

---

## State D05: `dialog.page2.active`

**State ID:** `dialog.page2.active`

**Entry conditions:**
- Page 1 validates and user clicks Next.
- User navigates back from Page 3 (D06 → D05).
- User clicks completed step circle 2 from Page 3.

**Exit conditions:**
- "Next →" clicked and Page 2 validates (at least 1 node on canvas) → **D06 `dialog.page3.active`**.
- "← Back" clicked → **D04 `dialog.page1.active`**.
- Close / Escape → close flow.

**Visual description:**
The stepper shows circles 0–1 checkmarked, circle 2 active, connectors 0→1 and 1→2 filled. The DagCanvasPage hosts the full DAG builder: a white canvas with zoom/pan, the node palette sidebar (3 draggable node types), any placed nodes (`.dag-node` elements), SVG connections between them, and the code preview panel (right side or bottom, initially expanded). The footer shows "← Back" + "Next →". This is the most complex visual state — the canvas supports scroll-zoom, drag-pan, node selection, connection drawing, and undo/redo.

**Active DOM elements:**
- Visible: Dialog chrome, stepper (0–1 checked, 2 active), DagCanvas (C04) with NodePalette (C05), any DagNode instances (C06), connection SVG paths (C07), CodePreviewPanel (C08), footer (Back + Next).
- Hidden: Pages 0, 1, 3, 4. Code preview panel may be collapsed (user toggle).
- Disabled: Stepper circles 3–4. Circles 0–1 clickable.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | `_handleClose()` (dialog-level, NOT canvas deselect — canvas handles its own Escape) |
| `Tab` / `Shift+Tab` | Focus trap |
| `Ctrl+Enter` | Trigger Next |
| `Alt+←` / `Alt+→` | Back / Next |
| `Ctrl+Z` | Undo (delegated to C14 UndoRedoManager) |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Delete` / `Backspace` | Delete selected node(s) |
| `Ctrl+A` | Select all nodes |

**Data requirements:**
- `state.nodes[]` and `state.connections[]` (DAG topology).
- Schema options derived from `state.schemas` (for node schema dropdown).
- Theme-based sample table suggestions.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Next click | `nodes.length >= 1` | D06 | `collectState`, slide forward, connector 2→3 fill |
| Next click | `nodes.length === 0` | D05 (self) | Error: "Add at least one node to the canvas" |
| Back click | Always | D04 | `collectState`, slide backward |
| Step circle 0/1 click | Completed | D03 or D04 | Slide backward |
| Close / Escape | dirty check | D13 or D01 | Close flow |

**Error recovery:**
- Canvas rendering errors: catch in `DagCanvas.render()`, show toast "Canvas error — try refreshing", canvas falls back to list view.
- Node limit exceeded (>100): prevent drop, toast "Maximum 100 nodes reached".

**Animation:**
- **Entry from D04:** Slide in from right, 360ms. Canvas performs initial auto-layout if nodes exist from template.
- **Exit forward:** Slide out left.
- **Exit backward:** Slide out right.

---

## State D06: `dialog.page3.active`

**State ID:** `dialog.page3.active`

**Entry conditions:**
- Page 2 validates and user clicks Next.
- User navigates back from Page 4 via step circle click (only if execution NOT started).

**Exit conditions:**
- "Lock In & Create ▶" clicked and all-page validation passes → **D07 `dialog.page4.executing`**.
- "← Back" clicked → **D05 `dialog.page2.active`**.
- Close / Escape → close flow.
- "Save as Template" clicked → stays at D06 (modal inline for template name).

**Visual description:**
The stepper shows circles 0–2 checkmarked, circle 3 active (`--accent`), connectors 0→1→2→3 filled. The ReviewSummary (C09) shows a full read-only summary: workspace name, capacity assignment, lakehouse, notebook, selected theme badge, enabled schemas list, a read-only mini-DAG visualization, node counts by type ("3 SQL tables, 5 SQL MLVs, 2 PySpark MLVs"), and confirmation text. The footer shows "← Back" + "Lock In & Create ▶" (`btn-create` — accent background, bolder styling).

**Active DOM elements:**
- Visible: Dialog chrome, stepper (0–2 checked, 3 active), ReviewSummary (C09) with mini-DAG and stats, footer (Back + "Lock In & Create ▶"), "Save as Template" link.
- Hidden: Pages 0–2, Page 4.
- Disabled: Stepper circle 4. Circles 0–2 clickable.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | `_handleClose()` |
| `Tab` / `Shift+Tab` | Focus trap |
| `Ctrl+Enter` | Trigger "Lock In & Create" |
| `Alt+←` | Back |

**Data requirements:**
- Full `WizardState` snapshot (read-only derivation for display).
- All pages' `validate()` re-run as final sweep before execution.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| "Lock In & Create" click / `Ctrl+Enter` | All 4 pages validate | D07 | Freeze stepper, slide to page 4, init execution |
| "Lock In & Create" click | Any page fails validation | Failing page (D03–D05) | Toast + jump back to failing page |
| Back click / `Alt+←` | Always | D05 | Slide backward |
| Step circle 0/1/2 click | Completed | Target page | Slide backward |
| Close / Escape | dirty check | D13 or D01 | Close flow |

**Error recovery:**
- If final validation sweep catches an inconsistency (e.g., capacity deleted between page 0 and now), jump back to the relevant page with error highlighted.

**Animation:**
- **Entry from D05:** Slide in from right, 360ms.
- **Exit to D07:** Slide out left. "Lock In & Create" button shows a brief pulse glow before slide.
- **Exit backward:** Slide out right.

---

## State D07: `dialog.page4.executing`

**State ID:** `dialog.page4.executing`

**Entry conditions:**
- "Lock In & Create" passed all validation, execution initialized.
- Retry click from D10 (`dialog.page4.error`) — re-enters running state.
- Restore from badge (D12 → D07) while execution is still running.

**Exit conditions:**
- All 6 steps complete → **D09 `dialog.page4.completed`**.
- A step fails → **D10 `dialog.page4.error`**.
- User clicks Close (X) or Minimize → **D08 `dialog.minimized`**.
- User presses Escape → **D08 `dialog.minimized`**.

**Visual description:**
The stepper shows circles 0–3 checkmarked, circle 4 active. All connectors filled. The ExecutionPipeline (C10) occupies the page with a GitHub Actions-style step list: each step shows its label, status icon (⏳ Pending / ● Running / ✓ Done), elapsed timer, and expandable detail section. The currently running step has an accent-colored pulsing dot and an active timer counting up. The footer is hidden (`display: none`). No Back button. The close (X) button in the title bar functions as "Minimize" — its tooltip reads "Minimize to badge".

**Active DOM elements:**
- Visible: Dialog chrome, stepper (0–3 checked, 4 active), ExecutionPipeline (C10) with all 6 step rows, running step highlighted, close/minimize button.
- Hidden: Footer bar, Pages 0–3.
- Disabled: All stepper circles (non-clickable during execution), Back button (hidden).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Minimize to badge (NOT close) |
| `Tab` / `Shift+Tab` | Focus trap within execution view |

**Data requirements:**
- `state.execution` object with `status: 'running'`, `currentStepIndex`, `steps[]` array.
- Active API calls being made by ExecutionPipeline (C10).
- `createdResources[]` tracking what's been provisioned (for rollback).
- Elapsed timer updating every 100ms per running step.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| All steps complete | `steps.every(s => s.status === 'done')` | D09 | Show completion UI, fire `onComplete` |
| Step fails | `steps[i].status === 'failed'` | D10 | Show error UI, fire `onError` |
| Close (X) click | `execution.status === 'running'` | D08 | Minimize sequence |
| Escape | `execution.status === 'running'` | D08 | Minimize sequence |
| Minimize button click | `execution.status === 'running'` | D08 | Minimize sequence |

**Error recovery:**
- Network timeout on any step: retry the HTTP call 1x automatically (built into ExecutionPipeline). If second attempt fails, transition to D10.
- Browser tab hidden during execution: execution continues (no visibility-dependent logic).

**Animation:**
- **Entry from D06:** Slide in from right. First step transitions from ⏳ to ● with accent dot pulse.
- **Entry from D08 (restore):** Dialog entrance `iw-dialogIn` 450ms spring.
- **Entry from D10 (retry):** No slide — inline state change, failed step resets to ● Running.
- **Exit to D08:** Dialog shrinks `scale(0.8) translateY(40px) opacity(0)` over 300ms.

---

## State D08: `dialog.minimized`

**State ID:** `dialog.minimized`

**Entry conditions:**
- User clicks Close (X), Minimize, or Escape during execution (D07).
- Close (X) during error state (D10) if user doesn't want to interact.

**Exit conditions:**
- User clicks the FloatingBadge (C11) → **D07** (if still running), **D09** (if completed while minimized), or **D10** (if failed while minimized).
- Execution completes while minimized → stays at D08 but badge updates to success.
- Execution fails while minimized → stays at D08 but badge updates to failure.

**Visual description:**
The dialog DOM is in the document but `.iw-overlay` has `display: none`. No backdrop blur, no visible dialog. The main application is fully interactive. A FloatingBadge (C11) appears at `bottom: 24px; right: 24px` showing execution progress. The `<body>` has class `has-floating-badge`. Toast bottom offset adjusted to 72px.

**Active DOM elements:**
- Visible: Main application UI, FloatingBadge (`position: fixed`).
- Hidden: `.iw-overlay` (`display: none`), `.iw-dialog` (hidden within overlay).
- Disabled: All dialog interactions (overlay not visible).

**Keyboard shortcuts:**
- Dialog shortcuts unbound. Main application shortcuts restored.
- Badge is in tab order: `Tab` can focus badge, `Enter`/`Space` on badge triggers restore.

**Data requirements:**
- Execution continues in memory via `ExecutionPipeline` (C10) — no DOM dependency.
- Badge receives progress updates via `badge.update()` on each step transition.
- `_preMinimizeGeometry` saved for restore.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Badge click / `Enter` on focused badge | `execution.status === 'running'` | D07 | Destroy badge, restore dialog |
| Badge click | `execution.status === 'completed'` | D09 | Destroy badge, restore to completion |
| Badge click | `execution.status === 'failed'` | D10 | Destroy badge, restore to error |
| Execution completes (background) | Always | D08 (self) | `badge.update({ status: 'success' })` |
| Execution fails (background) | Always | D08 (self) | `badge.update({ status: 'failure' })` |

**Error recovery:**
- If badge DOM is removed externally (dev tools, HMR), execution still runs. On next `_onStepProgress`, detect missing badge and recreate it.
- If execution crashes while minimized, badge enters stale state after 60s (see badge state B07).

**Animation:**
- **Entry:** Dialog shrink: `scale(0.8) translateY(40px) opacity(0)` 300ms → overlay fade → badge entrance (see B02).
- **Exit:** Badge exit (300ms) → overlay fade in → dialog entrance `scale(0.94) translateY(16px)` → `scale(1)` 450ms spring.

---

## State D09: `dialog.page4.completed`

**State ID:** `dialog.page4.completed`

**Entry conditions:**
- All 6 execution steps complete successfully while dialog is visible (from D07).
- User clicks badge to restore after execution completed while minimized (from D08).

**Exit conditions:**
- Close (X) clicked → **D01 `dialog.closed`** (clean exit, no confirmation needed).
- "Open Workspace" CTA clicked → **D01 `dialog.closed`** + navigate to workspace.
- Escape pressed → **D01 `dialog.closed`**.

**Visual description:**
The ExecutionPipeline shows all 6 steps with green checkmarks (✓). Total elapsed time displayed. A success banner appears at the top of the page with "Environment Created Successfully" and a confetti-free celebration (subtle green glow). The "Open Workspace" CTA button is prominent. The stepper shows all 5 circles checkmarked with all connectors filled in `var(--status-ok)`. The close (X) button's tooltip reverts to "Close". No footer.

**Active DOM elements:**
- Visible: Dialog chrome, stepper (all checked, green), ExecutionPipeline (all ✓), success banner, "Open Workspace" CTA, close button.
- Hidden: Footer, Pages 0–3.
- Disabled: All stepper circles (no navigation back after execution).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Close dialog |
| `Enter` | Activate "Open Workspace" CTA (if focused) |
| `Tab` / `Shift+Tab` | Cycle: close button → "Open Workspace" CTA → step details |

**Data requirements:**
- `state.execution.status === 'completed'`.
- `state.execution.completedAt` timestamp.
- Created resource IDs for the onComplete callback.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Close (X) / Escape | Always | D01 | Exit animation, remove DOM, release singleton, fire `onClose` |
| "Open Workspace" click | Always | D01 | Exit animation, remove DOM, fire `onComplete` with workspace data |

**Error recovery:**
- None — this is a terminal success state. No async operations.

**Animation:**
- **Entry from D07:** Inline — steps animate final checkmark, success banner fades in (300ms).
- **Entry from D08 (restore):** Dialog entrance animation + inline success state.
- **Exit:** `iw-dialogOut` (reverse of entrance) 350ms, overlay fades out 300ms.

---

## State D10: `dialog.page4.error`

**State ID:** `dialog.page4.error`

**Entry conditions:**
- An execution step fails (from D07).
- User clicks badge to restore after execution failed while minimized (from D08).

**Exit conditions:**
- "Retry" clicked → **D07 `dialog.page4.executing`** (re-run from failed step).
- Close (X) clicked → **D13 `dialog.closing.confirm`** (with rollback option).
- Escape pressed → **D13** (same as close).
- Minimize clicked → **D08 `dialog.minimized`**.

**Visual description:**
The ExecutionPipeline shows completed steps with green checkmarks, the failed step with a red ✕ icon and expanded error details (HTTP status, error message, response body in a monospace block). Steps after the failure show ⏳ (never attempted). A "Retry" button appears on the failed step row (`btn-primary`). The stepper circle 4 shows a red outline. An error banner summarizes: "Step 3 failed: Lakehouse creation — 409 Conflict".

**Active DOM elements:**
- Visible: Dialog chrome, stepper, ExecutionPipeline with error expanded, Retry button, error banner, close button, minimize button.
- Hidden: Footer, Pages 0–3.
- Disabled: Stepper circles (no navigation during error state).

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Trigger close flow (→ D13 with rollback option) |
| `Tab` / `Shift+Tab` | Cycle: Retry button → close → minimize → error details |
| `Enter` | Activate focused button (Retry or Close) |

**Data requirements:**
- `state.execution.status === 'failed'`.
- `state.execution.error` object with `stepId`, `message`, `httpStatus`, `responseBody`, `canRetry`.
- `state.execution.createdResources[]` for rollback enumeration.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Retry click | `error.canRetry === true` | D07 | Reset failed step to pending, re-run from that step |
| Close (X) / Escape | Always | D13 | Show rollback confirmation |
| Minimize click | Always | D08 | Minimize to badge in failure state |

**Error recovery:**
- If retry fails again, returns to D10 with updated error details.
- If error data is missing/corrupted, show generic "Execution failed — please close and try again".

**Animation:**
- **Entry from D07:** Failed step icon animates from ● to ✕ with a brief red flash (200ms). Error detail section slides down (250ms ease).
- **Exit to D07 (retry):** ✕ icon fades to ● (running), error section slides up.
- **Exit to D08:** Standard minimize animation.

---

## State D11: `dialog.page4.rollingback`

**State ID:** `dialog.page4.rollingback`

**Entry conditions:**
- User confirms close-with-rollback from D13 (while in error state).

**Exit conditions:**
- Rollback completes → **D01 `dialog.closed`**.
- Rollback fails → **D10 `dialog.page4.error`** (with rollback error details).

**Visual description:**
The ExecutionPipeline now shows a rollback section below the failed step. Each created resource is listed with a rollback status: ⏳ Pending → ● Deleting → ✓ Deleted. A progress message reads "Rolling back — Deleting workspace..." with an active timer. ALL dialog interaction is disabled except the visual progress. The close (X) button is disabled with tooltip "Rollback in progress — please wait".

**Active DOM elements:**
- Visible: Dialog chrome (dimmed interaction), ExecutionPipeline with rollback progress.
- Hidden: Footer, Pages 0–3.
- Disabled: Close button, stepper circles, all interactive elements.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Ignored (shows toast: "Rollback in progress — please wait") |
| `Tab` / `Shift+Tab` | Focus trap still active but nothing actionable |

**Data requirements:**
- `state.execution.status === 'rolling-back'`.
- `state.execution.createdResources[]` — iterated in reverse order for deletion.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| All resources deleted | Always | D01 | Exit animation, remove DOM, release singleton |
| Rollback step fails | Always | D10 | Show rollback error, offer manual cleanup instructions |

**Error recovery:**
- If a rollback deletion fails (e.g., workspace delete returns 500), show the specific resource that couldn't be deleted and provide the resource ID for manual cleanup.

**Animation:**
- **Entry from D13:** Confirmation card fades out, rollback section slides in (300ms).
- **Exit to D01:** Standard dialog exit animation.

---

## State D12: `dialog.page.transitioning`

**State ID:** `dialog.page.transitioning`

**Entry conditions:**
- Any forward or backward page navigation triggers a slide transition.

**Exit conditions:**
- Transition animation completes (360ms, `--t-page`) → destination page state (D03–D07).

**Visual description:**
Two pages are simultaneously visible during the 360ms transition. The leaving page animates `translateX(0) → translateX(∓60px)` with `opacity(1 → 0)`. The entering page animates `translateX(±60px) → translateX(0)` with `opacity(0 → 1)`. The direction depends on forward (slide left) vs backward (slide right). The stepper connector fill animates `scaleX(0 → 1)` (forward) or `scaleX(1 → 0)` (backward) simultaneously. The `_transitioning` lock flag is `true`.

**Active DOM elements:**
- Visible: Both leaving and entering pages (overlapping during transition), dialog chrome.
- Hidden: All other pages.
- Disabled: ALL interactive elements. `_transitioning = true` blocks button clicks, stepper clicks, keyboard shortcuts.

**Keyboard shortcuts:**
- ALL wizard-specific shortcuts ignored (transition lock).

**Data requirements:**
- Leaving page's state collected before transition starts.
- Entering page's `activate()` deferred until transition completes.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| 360ms timeout fires | Always | Target page state (D03–D07) | Activate entering page, clear transition styles, `_transitioning = false` |

**Error recovery:**
- If `requestAnimationFrame` is delayed (tab hidden), the 360ms timeout still fires, ensuring transition completes. Styles are force-cleared.

**Animation:**
- Forward: leaving slides left (`translateX(-60px)`), entering slides in from right (`translateX(60px) → 0`).
- Backward: leaving slides right (`translateX(60px)`), entering slides in from left (`translateX(-60px) → 0`).
- Duration: 360ms. Easing: `var(--ease)`.

---

## State D13: `dialog.closing.confirm`

**State ID:** `dialog.closing.confirm`

**Entry conditions:**
- Close (X) or Escape pressed while `state.dirty === true` on pages 0–3.
- Close (X) or Escape pressed while in error state (D10) — shows rollback option.

**Exit conditions:**
- "Discard & Close" confirmed → **D01 `dialog.closed`** (from pages 0–3) or **D11 `dialog.page4.rollingback`** (from error state).
- "Cancel" clicked → return to **previous state** (D03–D06 or D10).

**Visual description:**
An `.iw-confirm-overlay` appears inside the dialog (NOT a separate modal — inline overlay). The `.iw-confirm-card` centers within the dialog with title "Discard wizard?" (from setup pages) or "Close and rollback?" (from error state), a message explaining consequences, and two buttons: "Cancel" (ghost) and "Discard & Close" (red primary, `background: var(--status-fail)`). The rest of the dialog content is dimmed behind the confirmation overlay. The backdrop within the dialog uses `rgba(0,0,0,0.08)`.

**Active DOM elements:**
- Visible: `.iw-confirm-overlay` with `.iw-confirm-card`, dialog chrome (dimmed behind).
- Hidden: None (confirm overlay is on top).
- Disabled: ALL elements behind the confirm overlay.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Escape` | Trigger "Cancel" (dismiss confirmation, return to previous state) |
| `Enter` | Activate focused button |
| `Tab` / `Shift+Tab` | Cycle between Cancel and Discard buttons only |

**Data requirements:**
- `_previousState` stored when entering D13 for return navigation.
- If from error state: `state.execution.createdResources[]` to show what will be rolled back.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| "Cancel" click / Escape | Always | Previous state | Remove confirm overlay |
| "Discard & Close" click | From pages 0–3 | D01 | Exit animation, remove DOM, release singleton |
| "Close & Rollback" click | From error state | D11 | Remove confirm overlay, start rollback |

**Error recovery:**
- None — pure UI state. No async operations.

**Animation:**
- **Entry:** Confirm overlay fades in (200ms ease), card scales from `scale(0.96)` to `scale(1)` (250ms spring).
- **Exit (cancel):** Overlay fades out (150ms), card scales to `scale(0.96)` (150ms).
- **Exit (confirm):** Card pulses briefly then dialog plays full exit animation.

---

## State D14: `dialog.dragging`

**State ID:** `dialog.dragging`

**Entry conditions:**
- `pointerdown` on `.iw-header` (title bar) excluding close button and step circles.

**Exit conditions:**
- `pointerup` anywhere → return to **current page state** (D03–D07).

**Visual description:**
The dialog follows the pointer position in real-time. The title bar cursor changes to `grabbing`. The dialog has no transition on `left`/`top` (instant tracking). The dialog is constrained so at least `DRAG_MARGIN` (48px) of the header remains visible at each viewport edge. `geometry.centered` is set to `false`. The overlay remains but does not intercept pointer events during drag (events pass through to the dialog).

**Active DOM elements:**
- Same as the current page state, but with `cursor: grabbing` on `.iw-dialog`.

**Keyboard shortcuts:**
- `Escape` during drag: cancel drag, return dialog to pre-drag position.
- All other shortcuts suppressed during active drag.

**Data requirements:**
- `_dragStartX`, `_dragStartY` offsets from initial `pointerdown`.
- `_geometry.x`, `_geometry.y` updated every `pointermove` frame.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `pointerup` | Always | Previous page state | Remove move/up listeners, save geometry to `sessionStorage` |
| Escape during drag | Always | Previous page state | Reset to pre-drag position |

**Error recovery:**
- If `pointerup` is never received (pointer capture lost), a 5s safety timeout releases the drag state.

**Animation:**
- No animation during drag (direct DOM manipulation for 60fps).
- On Escape (cancel): `300ms var(--ease)` transition back to pre-drag position.

---

## State D15: `dialog.resizing`

**State ID:** `dialog.resizing`

**Entry conditions:**
- `pointerdown` on any of the 8 resize handles (n/s/e/w/ne/nw/se/sw).

**Exit conditions:**
- `pointerup` anywhere → return to **current page state**.

**Visual description:**
The dialog resizes in real-time following the pointer. The cursor changes to the directional resize cursor (`n-resize`, `ew-resize`, `nwse-resize`, etc.) on both the handle and the entire document (prevents cursor flicker). Size is clamped: min 640x480, max 90vw x 88vh. The page content reflows to fit the new size. `geometry.centered` set to `false`.

**Active DOM elements:**
- Same as current page state with active resize cursor.

**Keyboard shortcuts:**
- Escape: cancel resize, return to pre-resize dimensions.
- All other shortcuts suppressed.

**Data requirements:**
- `_resizeDir`, `_resizeStartX`, `_resizeStartY`, `_resizeStartGeo`.
- `_geometry.width`, `_geometry.height` (and possibly `x`, `y` for n/w/nw/ne/sw resizing) updated every `pointermove`.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `pointerup` | Always | Previous page state | Remove listeners, save geometry to sessionStorage |
| Escape | Always | Previous page state | Revert to pre-resize dimensions (300ms ease) |

**Error recovery:**
- Same safety timeout as dragging (5s).
- If min/max constraints conflict (tiny viewport), clamp to minimum and toast "Dialog at minimum size".

**Animation:**
- No animation during resize (direct manipulation).
- On Escape cancel: `300ms var(--ease)` transition back to pre-resize size.

---

## State D16: `dialog.singleton.blocked`

**State ID:** `dialog.singleton.blocked`

**Entry conditions:**
- `open()` called while `_activeInstance !== null`.

**Exit conditions:**
- Immediate return to caller (no persistent state change). This is a transient micro-state.

**Visual description:**
If the existing wizard is **open**: The `.iw-dialog` gets class `.iw-attention` for 600ms — a brief scale bounce (`scale(1) → scale(1.02) → scale(0.99) → scale(1)`) drawing the user's eye. A toast appears: "A wizard is already running — one at a time".

If the existing wizard is **minimized**: The FloatingBadge calls `pulseAttention()` — scale bounce 400ms. A toast appears: "An environment is being created. Click the badge to view progress."

**Active DOM elements:**
- Whatever the existing wizard state shows (dialog or badge), plus a transient toast.

**Keyboard shortcuts:**
- Not applicable (transient state, returns immediately).

**Data requirements:**
- `InfraWizardDialog._activeInstance` reference.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| (immediate) | Always | Caller's context (no state change) | Attention animation + toast |

**Error recovery:**
- None.

**Animation:**
- Dialog attention: `iw-attention` class, 600ms scale bounce.
- Badge attention: `badgeAttention` keyframes, 400ms spring.

---

## State D17: `dialog.validation.failed`

**State ID:** `dialog.validation.failed`

**Entry conditions:**
- User clicks "Next →" or "Lock In & Create" and the current page's `validate()` returns a non-null error string.

**Exit conditions:**
- Automatic return to current page state after shake animation (600ms).
- User corrects the invalid field → exits naturally when they retry Next.

**Visual description:**
The "Next →" button receives the `.iw-shake` CSS class — a horizontal shake animation (`translateX(0 → -4px → 4px → -4px → 0)` over 400ms). The button is temporarily disabled. A toast appears with the validation error message (e.g., "Please select a capacity"). The page component highlights the invalid field with a red border via `highlightError()`. After 600ms, the shake class is removed and the button re-enables.

**Active DOM elements:**
- Same as current page state, with Next button shaking and invalid field highlighted.

**Keyboard shortcuts:**
- Same as current page state (shortcuts work, but Next will re-validate).

**Data requirements:**
- Validation error string from `pages[N].validate()`.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| 600ms timeout | Always | Current page state (D03–D06) | Remove shake class, re-enable button |

**Error recovery:**
- Not applicable — this IS the error recovery feedback.

**Animation:**
- Next button: `.iw-shake` keyframes, 400ms.
- Invalid field: red border pulse (200ms), controlled by page component.

---

## State D18: `dialog.page0.loading`

**State ID:** `dialog.page0.loading`

**Entry conditions:**
- Page 0 activates and the capacity dropdown begins async fetch (`GET /v1.0/myorg/capacities`).

**Exit conditions:**
- Capacity list loads successfully → **D03 `dialog.page0.active`** (dropdown populated).
- Capacity fetch fails → **D03 (self)** with inline error state in dropdown.

**Visual description:**
The dialog and Page 0 are visible. The workspace name, lakehouse name, and notebook name inputs are interactive. The capacity dropdown shows a loading skeleton: a shimmer animation inside the dropdown trigger area, with placeholder text "Loading capacities...". The "Next →" button is disabled (capacity is required for validation). All other page interactions work normally.

**Active DOM elements:**
- Visible: Everything in D03, but capacity dropdown shows shimmer loader.
- Disabled: "Next →" button (validation will fail without capacity).

**Keyboard shortcuts:**
- Same as D03.

**Data requirements:**
- Active `fetch()` call to capacity API.
- Abort controller stored for cleanup if page is deactivated.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Fetch resolves (200) | Has capacities | D03 | Populate dropdown, enable Next |
| Fetch resolves (200) | Empty list | D03 | Show "No capacities available" with help link |
| Fetch rejects | Always | D03 | Show inline error with "Retry" link in dropdown |

**Error recovery:**
- Inline retry in the dropdown — user clicks "Retry" to re-fetch.
- If auth expired (401), show "Re-authenticate" action.

**Animation:**
- Shimmer animation on dropdown: `linear-gradient` sweep, continuous until loaded.
- On load complete: shimmer fades out (200ms), options fade in (200ms).

---

## State D19: `dialog.page4.executing.minimized.completed`

**State ID:** `dialog.page4.executing.minimized.completed`

**Entry conditions:**
- Execution completes all 6 steps while dialog is minimized (D08 while execution runs in background).

**Exit conditions:**
- User clicks badge → **D09 `dialog.page4.completed`**.
- Badge auto-dismisses after 30s → **D01 `dialog.closed`** (fire `onComplete` silently).

**Visual description:**
Same as D08 but the FloatingBadge shows success state: green dot (static), text "Done! Click to open workspace", no progress bar, green-tinted border glow. The main application is fully interactive. The 30s auto-dismiss timer is running.

**Active DOM elements:**
- Visible: Main app + FloatingBadge in success state.
- Hidden: Dialog.

**Keyboard shortcuts:**
- Badge focusable via Tab; Enter/Space restores dialog.
- Escape on focused badge dismisses it.

**Data requirements:**
- `state.execution.status === 'completed'`.
- Auto-dismiss timer ID stored.
- `onComplete` callback ready to fire.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Badge click / Enter | Always | D09 | Destroy badge, restore dialog to completed state |
| Auto-dismiss (30s) | No user interaction | D01 | Badge exit animation, fire `onComplete`, cleanup |
| Hover on badge | Always | D19 (self) | Cancel auto-dismiss timer |

**Error recovery:**
- If auto-dismiss fires but `onComplete` throws, log error and still clean up DOM.

**Animation:**
- Badge success state: green border glow (subtle box-shadow transition, 300ms).
- Auto-dismiss exit: `badgeSlideOut` 300ms ease-out.

---

## State D20: `dialog.page4.executing.minimized.failed`

**State ID:** `dialog.page4.executing.minimized.failed`

**Entry conditions:**
- An execution step fails while dialog is minimized.

**Exit conditions:**
- User clicks badge → **D10 `dialog.page4.error`**.

**Visual description:**
Same as D08 but the FloatingBadge shows failure state: red dot (static), text "Failed — Click to retry", no progress bar, red-tinted border. No auto-dismiss. Badge persists until user acts.

**Active DOM elements:**
- Visible: Main app + FloatingBadge in failure state.
- Hidden: Dialog.

**Keyboard shortcuts:**
- Badge focusable; Enter/Space restores to error state.

**Data requirements:**
- `state.execution.status === 'failed'`.
- `state.execution.error` with failure details.
- `state.execution.createdResources[]` for potential rollback.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Badge click / Enter | Always | D10 | Destroy badge, restore dialog to error state with retry visible |

**Error recovery:**
- Badge never auto-dismisses in failure state — requires user action.

**Animation:**
- Badge failure state: red border appears via `border-color` transition (200ms).
- On restore: badge exit (300ms) → dialog entrance (450ms) with error already expanded.

---

# C11 — FloatingBadge States

## State B01: `badge.hidden`

**State ID:** `badge.hidden`

**Entry conditions:**
- Initial state (badge constructed but not shown).
- Exit animation completes from B05 (`badge.exiting`).
- `destroy()` called from any state.

**Exit conditions:**
- `show(config)` called → **B02 `badge.entering`**.

**Visual description:**
No badge DOM element exists in the document. The viewport has no floating pill element. The `<body>` does NOT have class `has-floating-badge`. Toast notifications use their default bottom offset.

**Active DOM elements:**
- Visible: None related to badge.
- Hidden: Badge element not in DOM (null reference).
- Disabled: None.

**Keyboard shortcuts:**
- None related to badge (badge is not in tab order).

**Data requirements:**
- `visibility: 'hidden'` in internal state.
- `_config: null`.
- All timer IDs cleared (auto-dismiss, stale detection, attention).

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `show(config)` | `visibility === 'hidden'` | B02 | Create DOM, append to container, start entrance animation |
| `hide()` | Already hidden | B01 (self) | No-op |
| `update(config)` | Hidden | B01 (self) | Silently ignored, console warning |
| `destroy()` | Already hidden | B01 (self) | No-op |

**Error recovery:**
- None — this is the clean/safe state.

**Animation:**
- None.

---

## State B02: `badge.entering`

**State ID:** `badge.entering`

**Entry conditions:**
- `show(config)` called from B01 with valid `FloatingBadgeConfig`.

**Exit conditions:**
- Entrance animation completes (`animationend` event, ~500ms) → **B03 `badge.visible.running`** (or appropriate visible sub-state based on `config.status`).
- `destroy()` called during entrance → **B01 `badge.hidden`**.
- `hide()` called during entrance → **B01 `badge.hidden`**.

**Visual description:**
The badge DOM element is in the document at `bottom: 24px; right: 24px`. It is animating from `translateY(20px) scale(0.9) opacity(0)` to `translateY(0) scale(1) opacity(1)` over 500ms with spring easing (`var(--spring)`). The badge pill is partially visible and growing into position. The status dot, text, and progress bar are rendered but pointer events are disabled (`pointer-events: none` during animation). The `<body>` gains `has-floating-badge` class.

**Active DOM elements:**
- Visible: `.floating-badge` (animating), `.floating-badge__dot`, `.floating-badge__text`, `.floating-badge__progress`.
- Hidden: None (all badge sub-elements render immediately).
- Disabled: Pointer events disabled on the badge during animation.

**Keyboard shortcuts:**
- Badge is NOT in tab order during entrance (or effectively unreachable since pointer events are off).

**Data requirements:**
- `FloatingBadgeConfig` stored as `_config`.
- `visibility: 'entering'` in internal state.
- Buffered updates queued if `update()` called during entrance.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `animationend` event | Always | B03–B06 (based on `_config.status`) | Enable pointer events, emit `badge:shown`, register listeners |
| `destroy()` | Always | B01 | Cancel animation, remove DOM, cleanup |
| `hide()` | Always | B01 | Cancel animation, remove DOM, cleanup |
| `update(config)` | Always | B02 (self) | Buffer update, apply after entering visible state |
| 1000ms safety timeout | `animationend` not received | B03–B06 | Force transition (browser animation bug recovery) |

**Error recovery:**
- 1000ms safety timeout ensures badge never gets stuck in entering state.
- If DOM element removed externally during animation, detect on `animationend` and transition to B01.

**Animation:**
- `badgeSlide` keyframes: `translateY(20px) scale(0.9) opacity(0)` → `translateY(0) scale(1) opacity(1)`, 500ms, `var(--spring)`.
- Reduced motion: animation skipped, badge appears instantly.

---

## State B03: `badge.visible.running`

**State ID:** `badge.visible.running`

**Entry conditions:**
- Entrance animation completes with `config.status === 'running'`.
- `update({ status: 'running' })` received while in another visible sub-state (unlikely but possible on retry).

**Exit conditions:**
- `update({ status: 'completing' })` → **B04 `badge.visible.completing`**.
- `update({ status: 'failure' })` → **B06 `badge.visible.failed`**.
- Badge clicked → **B09 `badge.exiting`**.
- `hide()` called → **B09 `badge.exiting`**.
- `destroy()` called → **B01 `badge.hidden`**.

**Visual description:**
A pill-shaped badge at bottom-right of the viewport. The status dot is `var(--accent)` (#6d5cff) with the `dotPulse` animation (1.5s ease-in-out infinite — scale 1→0.8→1, opacity 1→0.4→1). The text reads `"Step {N}/{M} — {currentStepLabel}"` (e.g., "Step 3/6 — Creating Lakehouse") in 12px Inter, weight 600. The micro progress bar (32x4px) shows fill at `(currentStep/totalSteps) * 100%` with `var(--accent)` background. Border is `var(--border-bright)`, shadow is `var(--shadow-lg)`. Cursor: `pointer`.

**Active DOM elements:**
- Visible: `.floating-badge`, `.floating-badge__dot.floating-badge__dot--running`, `.floating-badge__text`, `.floating-badge__progress` with fill.
- Hidden: None.
- Disabled: None — fully interactive.

**Keyboard shortcuts:**
| Key | State | Action |
|-----|-------|--------|
| `Tab` | Any | Badge receives focus in normal tab order |
| `Enter` | Badge focused | Same as click — restore dialog |
| `Space` | Badge focused | Same as click |
| `Escape` | Badge focused | No effect (cannot dismiss while running) |

**Data requirements:**
- `_config` with `currentStep`, `totalSteps`, `currentStepLabel`, `status: 'running'`.
- Stale detection timer running (checks every 10s if no update received for 60s).
- `_lastUpdateTimestamp` tracked for stale detection.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `update({ currentStep: N+1, ... })` | Always | B03 (self) | Update text, advance progress bar fill |
| `update({ status: 'completing' })` | Always | B04 | Change dot to green, text to "Finishing up..." |
| `update({ status: 'success' })` | Always | B05 | Change to success visuals, start 30s timer |
| `update({ status: 'failure' })` | Always | B06 | Change to failure visuals |
| Click / Enter / Space | Always | B09 | Start exit animation, fire `badge:clicked` |
| `hide()` | Always | B09 | Start exit animation |
| `destroy()` | Always | B01 | Immediate removal |
| `pulseAttention()` | Already visible | B03 (self) | Play attention bounce (400ms) |
| Stale (60s no update) | `status === 'running'` | B07 | Show stale indicator |
| Hover enter | Always | B03 (self) | `shadow-lg → shadow-xl`, `translateY(-2px)` |
| Hover leave | Always | B03 (self) | Revert shadow and transform |

**Error recovery:**
- Stale detection: if no `update()` for 60s, transitions to B07 (stale recovery).
- DOM unexpectedly removed: detect on next `update()`, transition to B01.

**Animation:**
- Status dot: `dotPulse` 1.5s infinite.
- Progress bar fill: `width` transition 300ms `var(--ease)` on step advance.
- Hover: `box-shadow` and `transform` transition `var(--t-fast)` (80ms) `var(--ease)`.
- Active (pressed): `translateY(0)`, `shadow-md`.

---

## State B04: `badge.visible.completing`

**State ID:** `badge.visible.completing`

**Entry conditions:**
- `update({ status: 'completing' })` from ExecutionPipeline when final step is finishing.

**Exit conditions:**
- `update({ status: 'success' })` → **B05 `badge.visible.success`**.
- `update({ status: 'failure' })` → **B06 `badge.visible.failed`**.
- Badge clicked → **B09 `badge.exiting`**.
- `hide()` / `destroy()`.

**Visual description:**
Same pill layout, but: the status dot is now `var(--status-ok)` (#18a058) green with `dotPulse` animation still active (1.5s loop). The text reads `"Step {M}/{M} — Finishing up..."` (e.g., "Step 6/6 — Finishing up..."). The progress bar fill is at 100% with `var(--status-ok)` background. Border and shadow remain default. This is a brief transitional state (typically <2s).

**Active DOM elements:**
- Visible: `.floating-badge`, `.floating-badge__dot.floating-badge__dot--completing`, `.floating-badge__text`, `.floating-badge__progress` at 100% fill.
- All interactive.

**Keyboard shortcuts:**
Same as B03.

**Data requirements:**
- `_config.status === 'completing'`.
- `_config.currentStep === _config.totalSteps`.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `update({ status: 'success' })` | Always | B05 | Change text, hide progress, green glow, start auto-dismiss |
| `update({ status: 'failure' })` | Always | B06 | Change to failure visuals |
| Click / Enter / Space | Always | B09 | Exit, restore dialog |
| `hide()` | Always | B09 | Exit animation |
| `destroy()` | Always | B01 | Immediate removal |

**Error recovery:**
- If stuck in completing for >10s (unexpected), fall back to running text with a warning log.

**Animation:**
- Dot: `dotPulse` continues (green, 1.5s infinite).
- Progress fill: smooth transition to 100% (300ms ease, may already be near 100%).
- Fill color transitions from `--accent` to `--status-ok` (200ms).

---

## State B05: `badge.visible.success`

**State ID:** `badge.visible.success`

**Entry conditions:**
- `update({ status: 'success' })` — all execution steps completed.

**Exit conditions:**
- Badge clicked → **B09 `badge.exiting`** (with 'navigate' intent).
- Auto-dismiss timer fires (30s) → **B09 `badge.exiting`**.
- `hide()` called → **B09 `badge.exiting`**.
- `destroy()` called → **B01 `badge.hidden`**.
- Escape pressed while badge focused → **B09 `badge.exiting`**.

**Visual description:**
The status dot is `var(--status-ok)` (#18a058) green, **static** (no pulse animation). The text reads `"Done! Click to open workspace"`. The progress bar is hidden (`display: none`). The border has a green tint: `rgba(24, 160, 88, 0.3)`. The box-shadow gains a subtle green glow: `var(--shadow-lg), 0 0 0 1px rgba(24, 160, 88, 0.1)`. The badge class is `.floating-badge--success`. Cursor remains `pointer`.

**Active DOM elements:**
- Visible: `.floating-badge.floating-badge--success`, dot (static green), text.
- Hidden: `.floating-badge__progress` (`display: none`).
- All interactive.

**Keyboard shortcuts:**
| Key | State | Action |
|-----|-------|--------|
| `Tab` | Any | Badge receives focus |
| `Enter` / `Space` | Badge focused | Click → restore dialog at completion page |
| `Escape` | Badge focused | Dismiss badge (same as auto-dismiss) |

**Data requirements:**
- `_config.status === 'success'`.
- `autoDismissTimeoutId` — 30s timer started on entry.
- `badge:auto-dismiss-warning` event scheduled at T+25s (5s before dismiss).
- Screen reader announcement: "Environment created successfully. Click to open workspace."

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Click / Enter / Space | Always | B09 | Exit, fire onClick with 'navigate' intent |
| Auto-dismiss (30s) | No hover/focus | B09 | Exit animation, emit `badge:hidden` reason: 'auto-dismiss' |
| Hover enter | Always | B05 (self) | Cancel auto-dismiss timer, elevate shadow |
| Hover leave | Was hovered | B05 (self) | Do NOT restart auto-dismiss (cancelled permanently by interaction) |
| Escape (focused) | Always | B09 | Dismiss badge |
| `hide()` | Always | B09 | Exit animation |
| `destroy()` | Always | B01 | Immediate removal |

**Error recovery:**
- If auto-dismiss fires but onClick callback throws, still clean up badge DOM.

**Animation:**
- Dot: static (no animation).
- Green glow: `border-color` and `box-shadow` transition (300ms ease) on entry.
- Hover: shadow-lg → shadow-xl + green accent ring grows.
- Auto-dismiss: same as `badgeSlideOut` (300ms ease-out).

---

## State B06: `badge.visible.failed`

**State ID:** `badge.visible.failed`

**Entry conditions:**
- `update({ status: 'failure' })` — an execution step failed.

**Exit conditions:**
- Badge clicked → **B09 `badge.exiting`** (with 'retry' intent).
- `hide()` called → **B09 `badge.exiting`**.
- `destroy()` called → **B01 `badge.hidden`**.

**Visual description:**
The status dot is `var(--status-fail)` (#e5453b) red, **static** (no pulse). The text reads `"Failed — Click to retry"`. The progress bar is hidden (`display: none`). The border has a red tint: `rgba(229, 69, 59, 0.3)`. The box-shadow gains a subtle red accent: `var(--shadow-lg), 0 0 0 1px rgba(229, 69, 59, 0.1)`. The badge class is `.floating-badge--failure`. Cursor: `pointer`. **No auto-dismiss timer** — badge persists until user acts.

**Active DOM elements:**
- Visible: `.floating-badge.floating-badge--failure`, dot (static red), text.
- Hidden: Progress bar.
- All interactive.

**Keyboard shortcuts:**
| Key | State | Action |
|-----|-------|--------|
| `Tab` | Any | Badge receives focus |
| `Enter` / `Space` | Badge focused | Click → restore dialog at error state |
| `Escape` | Badge focused | No effect (cannot dismiss failure — must click to acknowledge) |

**Data requirements:**
- `_config.status === 'failure'`.
- `_config.errorMessage`, `_config.failedStepLabel`, `_config.failedStepIndex` stored for onClick callback.
- Screen reader announcement: "Environment creation failed. Click to retry."

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Click / Enter / Space | Always | B09 | Exit, fire onClick with 'retry' intent and failure config |
| `hide()` | Always | B09 | Exit animation |
| `destroy()` | Always | B01 | Immediate removal |
| `pulseAttention()` | Already visible | B06 (self) | Attention bounce 400ms |
| Hover enter | Always | B06 (self) | Elevate shadow + red accent ring grows |
| Hover leave | Always | B06 (self) | Revert shadow |

**Error recovery:**
- Escape does NOT dismiss the failure badge — this is intentional. The user must acknowledge the failure by clicking.
- Badge stays indefinitely in failure state. Stale detection is paused.

**Animation:**
- Dot: static (no animation).
- Red border: `border-color` transition 200ms on entry.
- Red shadow glow: `box-shadow` transition 300ms on entry.
- Hover: shadow-xl + expanded red ring.

---

## State B07: `badge.visible.stale`

**State ID:** `badge.visible.stale`

**Entry conditions:**
- Stale detection timer fires: badge is in `running` state but no `update()` received for 60 seconds.

**Exit conditions:**
- `update(config)` received (execution resumes) → **B03 `badge.visible.running`**.
- Badge clicked → **B09 `badge.exiting`** (restore dialog to investigate).
- `destroy()` called → **B01**.

**Visual description:**
The badge text changes to `"Running — No recent update"` with a yellow-tinted status dot (using `var(--status-warn)` or fallback amber). The progress bar freezes at its last position. The dot pulse animation switches to a slower cycle (3s instead of 1.5s) to indicate uncertainty. Border remains default. A tooltip on hover explains: "Execution may be stalled. Click to check status."

**Active DOM elements:**
- Visible: Badge with stale-specific text and amber dot.
- Hidden: None.
- All interactive.

**Keyboard shortcuts:**
Same as B03.

**Data requirements:**
- `_lastUpdateTimestamp` older than 60s.
- Previous `_config` preserved for recovery if updates resume.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `update(config)` | Any valid update | B03 | Restore running visuals, reset stale timer |
| Click / Enter / Space | Always | B09 | Exit, restore dialog for investigation |
| `destroy()` | Always | B01 | Immediate removal |

**Error recovery:**
- This IS the error recovery state for stalled execution.
- If no update received for 5 minutes, badge text changes to "May have stalled — Click to check".

**Animation:**
- Dot: slower pulse (3s infinite) in amber.
- Text change: instant (no transition).

---

## State B08: `badge.visible.attention`

**State ID:** `badge.visible.attention`

**Entry conditions:**
- `pulseAttention()` called on the badge from any visible sub-state (B03–B06).

**Exit conditions:**
- Attention animation completes (400ms) → return to **previous visible sub-state**.

**Visual description:**
The badge briefly bounces: `scale(1) → scale(1.08) → scale(0.96) → scale(1.03) → scale(1)` over 400ms with spring easing. The `.floating-badge--attention` class is applied. All other visual properties remain from the previous sub-state (text, dot color, progress bar). This is a transient overlay animation — the underlying state does not change.

**Active DOM elements:**
- Same as previous visible sub-state + `.floating-badge--attention` class.

**Keyboard shortcuts:**
- Same as previous state (attention doesn't block interaction).

**Data requirements:**
- Previous sub-state preserved.
- `_attentionTimeoutId` for debounce.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| 400ms timeout | Always | Previous visible sub-state (B03–B06) | Remove `.floating-badge--attention` class |
| `pulseAttention()` again within 400ms | Already animating | B08 (self) | Debounced — ignored |

**Error recovery:**
- None — purely cosmetic transient state.

**Animation:**
- `badgeAttention` keyframes: `scale(1) → 1.08 → 0.96 → 1.03 → 1`, 400ms spring.
- Reduced motion: `opacity: 0.5 → 1` flash instead of scale bounce (100ms).

---

## State B09: `badge.exiting`

**State ID:** `badge.exiting`

**Entry conditions:**
- Badge clicked from any visible state (B03–B06).
- `hide()` called programmatically.
- Auto-dismiss fires (from B05 success state).
- Escape pressed while badge focused in success state.

**Exit conditions:**
- Exit animation completes (300ms) → **B01 `badge.hidden`**.
- `destroy()` called during exit → **B01 `badge.hidden`** (immediate).

**Visual description:**
The badge animates from `translateY(0) scale(1) opacity(1)` to `translateY(20px) scale(0.9) opacity(0)` over 300ms with `var(--ease-out)`. The `.floating-badge--exiting` class is applied. Pointer events are disabled during the animation. The badge slides down and fades out toward the bottom-right corner.

**Active DOM elements:**
- Visible: `.floating-badge.floating-badge--exiting` (animating out).
- Disabled: Pointer events off.

**Keyboard shortcuts:**
- None (pointer events disabled, not focusable).

**Data requirements:**
- `visibility: 'exiting'`.
- `_config` preserved for the `badge:hidden` event payload.
- Exit reason tracked: `'click'`, `'auto-dismiss'`, or `'programmatic'`.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `animationend` / 300ms timeout | Always | B01 | Remove DOM, set `visibility: 'hidden'`, emit `badge:hidden`, remove `has-floating-badge` from body |
| `destroy()` | Always | B01 | Cancel animation, immediate removal |
| `show(config)` | During exit | Error thrown | "Must wait for exit to complete" |

**Error recovery:**
- 500ms safety timeout if `animationend` doesn't fire (ensures DOM cleanup).

**Animation:**
- `badgeSlideOut` keyframes: `translateY(0) scale(1) opacity(1)` → `translateY(20px) scale(0.9) opacity(0)`, 300ms, `var(--ease-out)`.
- Reduced motion: instant removal, no animation.

---

## State B10: `badge.visible.hover`

**State ID:** `badge.visible.hover`

**Entry conditions:**
- Pointer enters the badge element from any visible sub-state (B03–B06).

**Exit conditions:**
- Pointer leaves the badge element → return to **previous visible sub-state** (without hover elevation).
- Click → **B09 `badge.exiting`**.

**Visual description:**
The badge elevates: `box-shadow` transitions from `var(--shadow-lg)` to `var(--shadow-xl)`. The badge moves up 2px via `transform: translateY(-2px)`. If in success state, the green glow ring expands from 1px to 2px. If in failure state, the red glow ring expands similarly. Cursor remains `pointer`. Internal `isHovered = true`.

**Active DOM elements:**
- Same as underlying visible sub-state + hover elevation styling.

**Keyboard shortcuts:**
- Same as underlying state.

**Data requirements:**
- `isHovered: true` in internal state.
- If in success state (B05): hover cancels the auto-dismiss timer permanently.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| Pointer leave | Always | Previous sub-state (B03–B06) | `isHovered = false`, revert shadow/transform |
| Click | Always | B09 | Start exit |

**Error recovery:**
- None — CSS-driven state.

**Animation:**
- `box-shadow`: `var(--t-fast)` (80ms) `var(--ease)`.
- `transform: translateY(-2px)`: `var(--t-fast)` (80ms) `var(--ease)`.
- Active (pressed): `translateY(0)`, `shadow-md` (depressed feel).

---

## State B11: `badge.visible.focused`

**State ID:** `badge.visible.focused`

**Entry conditions:**
- Badge receives keyboard focus via Tab key.

**Exit conditions:**
- Badge loses focus (blur) → return to **previous visible sub-state**.
- Enter/Space pressed → **B09 `badge.exiting`**.
- Escape pressed (success state only) → **B09 `badge.exiting`**.

**Visual description:**
The badge gains a focus ring: `box-shadow: var(--shadow-glow), var(--shadow-lg)` and `border-color: var(--accent)`. The `:focus-visible` pseudo-class applies. Outline is `none` (replaced by the glow ring). Internal `isFocused = true`.

**Active DOM elements:**
- Same as underlying visible sub-state + focus ring.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `Enter` | Same as click |
| `Space` | Same as click |
| `Escape` | Dismiss (success/failure only, not running) |
| `Tab` | Move focus to next element |
| `Shift+Tab` | Move focus to previous element |

**Data requirements:**
- `isFocused: true`.

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| `blur` event | Always | Previous sub-state | `isFocused = false`, remove focus ring |
| Enter / Space | Always | B09 | Same as click |
| Escape | `status === 'success'` or `status === 'failure'` | B09 | Dismiss |
| Escape | `status === 'running'` | B11 (self) | No-op |

**Error recovery:**
- None.

**Animation:**
- Focus ring: instant (no transition, per design system convention for focus indicators).

---

## State B12: `badge.visible.running.step-advance`

**State ID:** `badge.visible.running.step-advance`

**Entry conditions:**
- `update()` called with a new `currentStep` value while in B03 (running).

**Exit conditions:**
- Immediate (synchronous update) → back to **B03 `badge.visible.running`**.

**Visual description:**
The text content swaps instantly to the new step label (no animation on text — per spec, text changes are instant to always show latest state). The progress bar fill width transitions smoothly from `(oldStep/total)*100%` to `(newStep/total)*100%` over 300ms via CSS `transition: width 300ms var(--ease)`. The `aria-label` is updated with the new step information. Screen reader announces: `"Step {N} of {M}, {stepLabel}"`.

**Active DOM elements:**
- Same as B03, with updated text and animating progress bar.

**Keyboard shortcuts:**
- Same as B03.

**Data requirements:**
- New `currentStep` and `currentStepLabel` from `update()`.
- `_lastUpdateTimestamp` refreshed (resets stale detection).

**Transitions:**
| Trigger | Guard | Destination | Action |
|---------|-------|-------------|--------|
| (synchronous) | Always | B03 | Text updated, progress bar animating, aria-label updated |

**Error recovery:**
- If `currentStep > totalSteps`, clamp to `totalSteps` and log warning.
- If `currentStep < 1`, clamp to `1` and log warning.

**Animation:**
- Text: instant swap (no transition).
- Progress bar fill: `width 300ms var(--ease)`.
- aria-label: instant update.

---

# Cross-Cutting Concerns

## CC-01: Theme Change (Light ↔ Dark)

**Affected states:** All visible states for both components.

**Behavior:**
- All color values use CSS custom properties (`var(--surface)`, `var(--text)`, `var(--accent)`, etc.).
- When the theme toggle fires, the `:root` variables update and all dialog/badge colors transition via CSS `transition: background-color 200ms, color 200ms, border-color 200ms`.
- No JavaScript state change required — pure CSS cascade.
- The dialog's backdrop `rgba(0,0,0,0.18)` and blur `8px` remain constant across themes.
- Status colors (`--status-ok`, `--status-fail`, `--accent`) may shift slightly per theme but maintain sufficient contrast.
- The badge's fixed-position box shadow adjusts automatically.

**No state transitions triggered by theme change.**

## CC-02: Window Resize

**Affected states:** All dialog visible states (D03–D15), all badge visible states (B03–B11).

**Dialog behavior:**
- `window.resize` handler clamps dialog size to max 90vw x 88vh.
- If dialog was centered (`geometry.centered === true`), it re-centers.
- If dialog was positioned manually, it clamps to keep at least 48px of header visible.
- During dragging (D14) or resizing (D15), window resize is a no-op.
- If viewport drops below 640px width: dialog clamps to minimum width, toast "Minimum viewport width required".

**Badge behavior:**
- Badge uses `position: fixed` with `bottom: 24px; right: 24px` — unaffected by scroll or resize.
- At very narrow viewports (<400px), badge text truncates with `text-overflow: ellipsis` via `max-width: 300px`.
- Badge height never changes. Progress bar may compress if container somehow constrains (shouldn't happen with `position: fixed`).

**No state transitions triggered by window resize** (handled within current state).

## CC-03: Focus Trap (Dialog)

**Affected states:** D03–D13 (all dialog visible states except minimized).

**Behavior:**
- `Tab` cycles through focusable elements within `.iw-dialog` only.
- `Shift+Tab` cycles backward.
- Focus order: Close button → Stepper circles (completed only) → Page content inputs → Footer buttons.
- Focus trap is set up on dialog entrance animation completion and released on minimize/close.
- During transitions (D12), focus trap remains active but all elements are disabled.
- During confirmation (D13), focus is scoped to the confirmation card only.

**Focus trap is disabled in D08 (minimized)** — main application gets focus back.

## CC-04: Escape Key Behavior Matrix

| State | Escape Behavior |
|-------|----------------|
| D03 (`page0.active`, clean) | Close dialog immediately |
| D03 (`page0.active`, dirty) | Show close confirmation (D13) |
| D04 (`page1.active`, dirty) | Show close confirmation |
| D05 (`page2.active`, dirty) | Show close confirmation |
| D06 (`page3.active`, dirty) | Show close confirmation |
| D07 (`page4.executing`) | Minimize to badge (D08) |
| D08 (`minimized`) | N/A (dialog not visible, Escape goes to app) |
| D09 (`completed`) | Close dialog |
| D10 (`error`) | Show close/rollback confirmation (D13) |
| D11 (`rollingback`) | Ignored, toast "Rollback in progress" |
| D12 (`transitioning`) | Ignored (transition lock) |
| D13 (`closing.confirm`) | Cancel confirmation, return to previous state |
| D14 (`dragging`) | Cancel drag, return to pre-drag position |
| D15 (`resizing`) | Cancel resize, return to pre-resize dimensions |
| B03–B04 (`badge running/completing`) | No effect on badge |
| B05 (`badge success`, focused) | Dismiss badge |
| B06 (`badge failed`, focused) | No effect (must click to acknowledge) |

## CC-05: Reduced Motion (`prefers-reduced-motion: reduce`)

**Dialog:**
- Entrance/exit animations: instant (no `iw-dialogIn`/`iw-dialogOut`).
- Page slide transitions: instant swap (no 360ms slide).
- Stepper connector fill: instant (no `scaleX` transition).
- Confirmation card: instant show/hide.
- Drag and resize: still real-time (position tracking, not animation).
- Shake on validation failure: replaced with brief opacity flash.

**Badge:**
- `badgeSlide`/`badgeSlideOut`: instant show/hide.
- `dotPulse`: static dot (no pulse animation).
- `badgeAttention`: opacity flash (100ms) instead of scale bounce.
- Hover elevation: still transitions (simple property change, not animation).
- Progress bar fill: still transitions `width` (300ms — simple transition, acceptable).

---

# Composite Transition Map

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                    DIALOG STATE MACHINE                             │
 │                                                                     │
 │  D01 ──open()──→ D02 ──anim──→ D03 ──next──→ D04 ──next──→ D05   │
 │  closed         init           pg0           pg1           pg2     │
 │    ↑                            ↑  ←──back──  ↑  ←──back──  ↑     │
 │    │                            │              │              │     │
 │    │                            │              │         next │     │
 │    │                            │              │              ↓     │
 │    │                            │  ←──back───────────────── D06    │
 │    │                            │                           pg3     │
 │    │                            │                            │     │
 │    │                            │                      LockIn│     │
 │    │                            │                            ↓     │
 │    │                            │                           D07    │
 │    │                            │                        executing  │
 │    │                            │                        ╱   │   ╲  │
 │    │                            │                       ╱    │    ╲ │
 │    │                            │                     D08   D09  D10│
 │    │                            │                     min   done  err│
 │    │                            │                      │     │    │ │
 │    │                            │                restore│     │ retry│
 │    │                            │                      ↓     │    ↓ │
 │    │                            │                     D07    │   D07│
 │    │                            │                            │     │
 │    │←──────────close──────────────────────────────────close───┘     │
 │    │                            │                                   │
 │    │←─confirm─── D13 ←──close(dirty)── D03–D06                    │
 │    │             ↑                                                  │
 │    │             └──close──── D10 ──rollback──→ D11 ──done──→ D01  │
 │                                                                     │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────┐
 │                    BADGE STATE MACHINE                              │
 │                                                                     │
 │  B01 ──show()──→ B02 ──anim──→ B03 ──update──→ B04 ──update──→ B05│
 │  hidden         enter          running         completing    success│
 │    ↑                            │                              │   │
 │    │                            │──update──→ B06               │   │
 │    │                            │            failed             │   │
 │    │                            │              │               │   │
 │    │                            │──stale──→ B07               │   │
 │    │                            │            stale             │   │
 │    │                            │              │               │   │
 │    │                            ←──update──────┘               │   │
 │    │                                                            │   │
 │    │       B09 ←──click──── B03/B04/B05/B06                   │   │
 │    │       exit                                                │   │
 │    │        │                                                  │   │
 │    │←─anim──┘              B09 ←──auto-dismiss─────────────────┘   │
 │    │                        │                                       │
 │    │←───────────────anim────┘                                       │
 │                                                                     │
 │    Transient overlays: B08 (attention), B10 (hover), B11 (focus),  │
 │                        B12 (step-advance)                           │
 │    — These are sub-state overlays that return to their parent.      │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────┐
 │              DIALOG ↔ BADGE CHOREOGRAPHY                           │
 │                                                                     │
 │  D07 (executing) ──minimize──→ D08 + B01→B02→B03                   │
 │  │                                                                  │
 │  │  Time 0ms:    Dialog shrink anim starts                         │
 │  │  Time 150ms:  Overlay faded out                                 │
 │  │  Time 200ms:  Dialog hidden                                     │
 │  │  Time 250ms:  Badge DOM created, entrance starts                │
 │  │  Time 750ms:  Badge visible, interactive                        │
 │  │                                                                  │
 │  B03/05/06 ──click──→ B09 → B01 + D08→D07/D09/D10                 │
 │  │                                                                  │
 │  │  Time 0ms:    Badge exit anim starts                            │
 │  │  Time 300ms:  Badge hidden                                      │
 │  │  Time 300ms:  Overlay + dialog entrance starts                  │
 │  │  Time 700ms:  Dialog fully visible                              │
 │                                                                     │
 │  INVARIANT: Badge and dialog are NEVER simultaneously interactive. │
 │  Sequential choreography — no z-index conflict window.              │
 └─────────────────────────────────────────────────────────────────────┘
```

---

> **Total states defined:** 20 dialog + 12 badge = 32 states
> **Cross-cutting concerns:** 5 (theme, resize, focus trap, escape matrix, reduced motion)
> **All transitions include:** trigger, guard, destination, action, animation
