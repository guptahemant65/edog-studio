# C11 — FloatingBadge

> **Component**: FloatingBadge
> **Feature**: F16 — New Infrastructure Wizard
> **Phase**: P1 (Component Deep Spec)
> **Complexity**: LOW (4 states, no child components)
> **Owner**: Pixel (JS/CSS)
> **Depends On**: C10-ExecutionPipeline (receives execution state), C1-InfraWizardDialog (minimize/restore coordination)
> **Design Ref**: Design Bible 4b, CEO-approved mock (Page 5 floating badge preview), p0-wizard-research.md §6
> **Last Updated**: 2025-07-15

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Specification](#6-visual-specification)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 What It Is

FloatingBadge is a fixed-position pill element anchored to the bottom-right corner of the viewport. It appears when the user minimizes the wizard dialog during execution (Page 5) and serves as a persistent, non-intrusive progress indicator that the user can click to restore the full wizard dialog.

It is the **minimized representation** of the entire InfraWizardDialog while execution is in progress, and the **completion/failure notification** after execution finishes.

### 1.2 What It Owns

- Fixed-position pill at `bottom: 24px; right: 24px` of the viewport
- Progress text in the format `"Step N/M — Action Description"`
- Animated status dot (8px circle) with pulsing animation matching execution state
- Inline micro-progress bar (32px wide) showing fractional step completion
- Click-to-restore interaction: clicking the badge restores the full wizard dialog
- Entrance animation (`badgeSlide`: `translateY(20px) scale(0.9)` → `translateY(0) scale(1)`)
- Exit animation (reverse of entrance: `translateY(0) scale(1)` → `translateY(20px) scale(0.9)`)
- Four distinct visual states: running, completing, success, failure
- Hover elevation effect (shadow-lg → shadow-xl, translateY(-2px))
- Text content transitions as execution progresses through steps

### 1.3 What It Does NOT Own

- Execution logic or API orchestration (owned by C10-ExecutionPipeline)
- Dialog lifecycle management (owned by C1-InfraWizardDialog)
- Overlay/backdrop management (owned by C1-InfraWizardDialog)
- Step details, logs, or expandable sections (owned by C10-ExecutionPipeline)
- Rollback logic on failure (owned by C10-ExecutionPipeline)
- Template save/load (owned by C12-TemplateManager)
- Navigation blocking or singleton enforcement (owned by C1-InfraWizardDialog)

### 1.4 Design Philosophy

The FloatingBadge follows the **Google Drive upload progress** pattern (per p0-wizard-research.md §6): a bottom-right docked pill that shows meaningful progress, persists across navigation, and expands to full UI on click. The key design principles:

1. **Meaningful progress over spinner**: Always show step counter ("Step 3/6") and current action name, never just a spinner
2. **Non-intrusive persistence**: Badge stays visible while the user interacts with other parts of EDOG Studio, but does not block or obstruct any functionality
3. **Single-click restoration**: One click restores the full wizard dialog at the current execution state — no multi-step re-opening
4. **Status at a glance**: Color, animation, and text immediately communicate whether execution is running, completing, succeeded, or failed
5. **Graceful choreography**: Entrance/exit transitions are smooth (500ms spring easing), not jarring

### 1.5 Singleton Constraint

**Only one FloatingBadge may exist at any time.** This is enforced at the application level:

- The InfraWizardDialog prevents opening a new wizard while a badge (i.e., a running/minimized execution) exists
- If a badge exists and the user tries to open a new wizard (via workspace explorer), the existing badge pulses briefly (attention animation) and a toast appears: "An environment is being created. Click the badge to view progress."
- The badge is destroyed only when: (a) the user clicks it to restore the dialog AND then closes/completes the dialog, or (b) the user explicitly dismisses a completed/failed badge

---

## 2. Data Model

### 2.1 FloatingBadgeState

The badge receives its state from the parent InfraWizardDialog/ExecutionPipeline. It does not manage execution state internally — it is a **pure view** over execution progress.

```javascript
/**
 * @typedef {Object} FloatingBadgeConfig
 *
 * @property {string} environmentName
 *   The workspace/environment name being created.
 *   Example: "brave_turing_42"
 *   Used for aria-label and potential tooltip.
 *   Max length: 50 characters (truncated with ellipsis in UI).
 *
 * @property {number} currentStep
 *   1-based index of the currently executing step.
 *   Range: 1–6 (matching the 6 pipeline steps).
 *
 * @property {number} totalSteps
 *   Total number of pipeline steps.
 *   Always 6 for V1 (Create Workspace, Assign Capacity,
 *   Create Lakehouse, Create Notebook, Write Cells, Run Notebook).
 *
 * @property {string} currentStepLabel
 *   Human-readable label for the current step.
 *   One of: "Creating Workspace", "Assigning Capacity",
 *   "Creating Lakehouse", "Creating Notebook",
 *   "Writing Cells", "Running Notebook"
 *
 * @property {'running'|'completing'|'success'|'failure'} status
 *   Current execution status.
 *   - running: A step is actively executing
 *   - completing: Final step is finishing up (brief transition)
 *   - success: All steps completed successfully
 *   - failure: A step has failed
 *
 * @property {string|null} errorMessage
 *   Short error description when status === 'failure'.
 *   Example: "Lakehouse creation failed — 409 Conflict"
 *   Null when not in failure state.
 *
 * @property {string|null} failedStepLabel
 *   Label of the step that failed, when status === 'failure'.
 *   Example: "Creating Lakehouse"
 *   Null when not in failure state.
 *
 * @property {number|null} failedStepIndex
 *   1-based index of the failed step, when status === 'failure'.
 *   Null when not in failure state.
 *
 * @property {number} elapsedMs
 *   Total elapsed time since execution started, in milliseconds.
 *   Updated every ~100ms by the ExecutionPipeline.
 *   Used for the optional elapsed time display on success.
 */
```

### 2.2 Step Label Map

The badge displays step-specific text. These labels are defined in the ExecutionPipeline and passed through to the badge:

| Step Index | Pipeline Step | Badge Label (`currentStepLabel`) |
|:----------:|---------------|----------------------------------|
| 1 | Create Workspace | `"Creating Workspace"` |
| 2 | Assign Capacity | `"Assigning Capacity"` |
| 3 | Create Lakehouse | `"Creating Lakehouse"` |
| 4 | Create Notebook | `"Creating Notebook"` |
| 5 | Write Cells | `"Writing Cells"` |
| 6 | Run Notebook | `"Running Notebook"` |

### 2.3 Badge Text Content by State

The badge renders different text content depending on its state:

| State | Badge Text | Status Dot Color | Dot Animation | Progress Bar |
|-------|-----------|-----------------|---------------|--------------|
| **running** | `"Step {N}/{M} — {currentStepLabel}"` | `--accent` (`#6d5cff`) | `dotPulse` (1.5s loop) | Visible, fill = `N/M` |
| **completing** | `"Step {M}/{M} — Finishing up..."` | `--status-ok` (`#18a058`) | `dotPulse` (1.5s loop) | Visible, fill = 100% |
| **success** | `"Done! Click to open workspace"` | `--status-ok` (`#18a058`) | None (static) | Hidden |
| **failure** | `"Failed — Click to retry"` | `--status-fail` (`#e5453b`) | None (static) | Hidden |

#### Text Content Examples (All 6 Running States)

```
Step 1/6 — Creating Workspace    ●
Step 2/6 — Assigning Capacity    ●
Step 3/6 — Creating Lakehouse    ●
Step 4/6 — Creating Notebook     ●
Step 5/6 — Writing Cells         ●
Step 6/6 — Running Notebook      ●
Step 6/6 — Finishing up...       ●
Done! Click to open workspace    ●
Failed — Click to retry          ●
```

### 2.4 Internal Component State

The badge tracks minimal internal state for animation choreography:

```javascript
/**
 * @typedef {Object} FloatingBadgeInternalState
 *
 * @property {'hidden'|'entering'|'visible'|'exiting'} visibility
 *   Animation lifecycle state. See State Machine (§4).
 *
 * @property {boolean} isHovered
 *   Whether the user's pointer is over the badge.
 *   Drives elevation and cursor changes.
 *
 * @property {boolean} isFocused
 *   Whether the badge has keyboard focus.
 *   Drives focus ring rendering.
 *
 * @property {number|null} attentionTimeoutId
 *   setTimeout ID for the attention pulse animation
 *   triggered when user tries to open a new wizard.
 *   Cleared on badge destruction.
 *
 * @property {number|null} autoDismissTimeoutId
 *   setTimeout ID for auto-dismiss on success state.
 *   30 seconds after entering success state, badge
 *   auto-dismisses (slides out). Cleared if user
 *   interacts before timeout.
 */
```

---

## 3. API Surface

### 3.1 Class Definition

```javascript
class FloatingBadge {
  // ─── Lifecycle ───────────────────────────────────────────
  constructor(containerEl)
  show(config)            // Trigger entrance animation with initial config
  hide()                  // Trigger exit animation and cleanup
  destroy()               // Immediate removal (no animation), cleanup timers

  // ─── State Updates ───────────────────────────────────────
  update(config)          // Update badge content (step, label, status)
  setStatus(status)       // Shorthand: change status only

  // ─── Interactions ────────────────────────────────────────
  onClick(callback)       // Register click handler (restore dialog)
  pulseAttention()        // Trigger attention animation (new wizard blocked)

  // ─── Queries ─────────────────────────────────────────────
  get isVisible()         // True if visibility is 'entering' or 'visible'
  get currentConfig()     // Return current FloatingBadgeConfig snapshot
  get element()           // Return the root DOM element (or null if hidden)
}
```

### 3.2 Constructor

```javascript
/**
 * @param {HTMLElement} containerEl
 *   The DOM element to append the badge to.
 *   MUST be document.body or a full-viewport container.
 *   The badge uses position: fixed, so the container only
 *   affects DOM ownership, not positioning.
 */
constructor(containerEl)
```

**Behavior:**
- Stores reference to `containerEl`
- Does NOT create the badge DOM element yet (lazy creation on `show()`)
- Does NOT add any elements to the DOM
- Initializes internal state to `{ visibility: 'hidden', isHovered: false, isFocused: false }`
- Validates `containerEl` is a valid HTMLElement (throws `TypeError` if not)

### 3.3 show(config)

```javascript
/**
 * Show the floating badge with entrance animation.
 *
 * @param {FloatingBadgeConfig} config
 *   Initial configuration for the badge.
 *
 * @throws {Error} If badge is already visible (singleton enforcement).
 *   Message: "FloatingBadge is already visible. Call hide() first."
 *
 * @returns {void}
 *
 * Behavior:
 * 1. If visibility !== 'hidden', throw Error
 * 2. Create badge DOM element (see §6 for structure)
 * 3. Append to containerEl
 * 4. Set visibility = 'entering'
 * 5. Trigger badgeSlide animation (500ms, spring easing)
 * 6. On animation end → set visibility = 'visible'
 * 7. If config.status === 'success', start auto-dismiss timer (30s)
 * 8. Register event listeners (click, mouseenter, mouseleave, keydown)
 * 9. Announce to screen readers via aria-live region
 */
show(config)
```

### 3.4 hide()

```javascript
/**
 * Hide the floating badge with exit animation.
 *
 * @returns {Promise<void>}
 *   Resolves when exit animation completes and DOM is cleaned up.
 *
 * Behavior:
 * 1. If visibility === 'hidden' or 'exiting', return immediately (no-op)
 * 2. Set visibility = 'exiting'
 * 3. Clear auto-dismiss timer if active
 * 4. Clear attention timeout if active
 * 5. Trigger reverse badgeSlide animation (300ms, ease-out)
 * 6. On animation end:
 *    a. Remove badge element from DOM
 *    b. Set visibility = 'hidden'
 *    c. Dereference DOM element
 *    d. Resolve promise
 */
hide()
```

### 3.5 destroy()

```javascript
/**
 * Immediately remove the badge without animation.
 * Used for cleanup on page unload or error recovery.
 *
 * @returns {void}
 *
 * Behavior:
 * 1. Clear all timers (auto-dismiss, attention)
 * 2. Remove all event listeners
 * 3. Remove badge element from DOM (if exists)
 * 4. Set visibility = 'hidden'
 * 5. Dereference all DOM elements
 */
destroy()
```

### 3.6 update(config)

```javascript
/**
 * Update badge content with new execution state.
 * Called by ExecutionPipeline on each step transition.
 *
 * @param {Partial<FloatingBadgeConfig>} config
 *   Partial config — only provided fields are updated.
 *   Common patterns:
 *   - Step advance: { currentStep: 4, currentStepLabel: "Creating Notebook" }
 *   - Status change: { status: 'success' }
 *   - Failure: { status: 'failure', errorMessage: "...", failedStepLabel: "...", failedStepIndex: 3 }
 *
 * @returns {void}
 *
 * Behavior:
 * 1. Merge config into current config (Object.assign)
 * 2. Update text content DOM nodes (no full re-render)
 * 3. Update status dot color and animation class
 * 4. Update progress bar fill width
 * 5. If status changed to 'success':
 *    a. Replace text with "Done! Click to open workspace"
 *    b. Change dot color to --status-ok
 *    c. Remove dot pulse animation
 *    d. Hide progress bar
 *    e. Add subtle success glow to badge border
 *    f. Start 30s auto-dismiss timer
 *    g. Announce "Environment created successfully" to screen reader
 * 6. If status changed to 'failure':
 *    a. Replace text with "Failed — Click to retry"
 *    b. Change dot color to --status-fail
 *    c. Remove dot pulse animation
 *    d. Hide progress bar
 *    e. Add error styling (red-tinted border)
 *    f. Announce "Environment creation failed" to screen reader
 * 7. If status changed to 'completing':
 *    a. Replace text with "Step {M}/{M} — Finishing up..."
 *    b. Change dot color to --status-ok
 *    c. Keep dot pulse animation
 *    d. Set progress bar fill to 100%
 */
update(config)
```

### 3.7 setStatus(status)

```javascript
/**
 * Shorthand for update({ status }).
 *
 * @param {'running'|'completing'|'success'|'failure'} status
 * @returns {void}
 */
setStatus(status)
```

### 3.8 onClick(callback)

```javascript
/**
 * Register a callback for badge click events.
 * The InfraWizardDialog uses this to restore the full dialog.
 *
 * @param {function(FloatingBadgeConfig): void} callback
 *   Called with the current badge config when clicked.
 *   The dialog uses this to determine what state to restore to.
 *
 * @returns {function(): void}
 *   Unsubscribe function. Call to remove the listener.
 *
 * Usage:
 *   const unsub = badge.onClick((config) => {
 *     if (config.status === 'success') {
 *       this.openWorkspace(config.environmentName);
 *     } else if (config.status === 'failure') {
 *       this.restoreDialogAtFailedStep(config);
 *     } else {
 *       this.restoreDialog();
 *     }
 *   });
 */
onClick(callback)
```

### 3.9 pulseAttention()

```javascript
/**
 * Trigger an attention-seeking animation on the badge.
 * Called when the user tries to open a new wizard while
 * a badge already exists.
 *
 * @returns {void}
 *
 * Behavior:
 * 1. Add CSS class 'badge-attention' to root element
 * 2. This triggers a brief scale bounce animation:
 *    scale(1) → scale(1.08) → scale(0.96) → scale(1)
 *    Duration: 400ms, spring easing
 * 3. After 400ms, remove 'badge-attention' class
 * 4. Debounced: if called again within 400ms, ignore
 */
pulseAttention()
```

### 3.10 Property Getters

```javascript
/** @returns {boolean} True if badge is in 'entering' or 'visible' state */
get isVisible()

/** @returns {FloatingBadgeConfig|null} Current config snapshot, or null if hidden */
get currentConfig()

/** @returns {HTMLElement|null} The root .floating-badge element, or null if hidden */
get element()
```

### 3.11 Events Emitted

The FloatingBadge emits custom events on its root element for optional external listeners:

| Event Name | Detail Payload | When |
|-----------|---------------|------|
| `badge:shown` | `{ config: FloatingBadgeConfig }` | After entrance animation completes |
| `badge:hidden` | `{ config: FloatingBadgeConfig, reason: 'click'|'auto-dismiss'|'programmatic' }` | After exit animation completes |
| `badge:clicked` | `{ config: FloatingBadgeConfig }` | When user clicks the badge |
| `badge:status-changed` | `{ previousStatus: string, newStatus: string, config: FloatingBadgeConfig }` | When status field changes |
| `badge:auto-dismiss-warning` | `{ secondsRemaining: 5 }` | 5 seconds before auto-dismiss |

### 3.12 Integration with InfraWizardDialog

The badge is created and managed by the InfraWizardDialog. The integration contract:

```javascript
// Inside InfraWizardDialog class:

/** Called when user clicks Minimize or Close(X) during execution */
_minimizeToFloatingBadge() {
  // 1. Start dialog exit animation (shrink toward bottom-right)
  // 2. Remove overlay/backdrop
  // 3. Create FloatingBadge if not exists
  // 4. Call badge.show(this._buildBadgeConfig())
  // 5. Register badge.onClick(this._restoreFromBadge.bind(this))
  // 6. Subscribe to execution progress updates → badge.update()
}

/** Called when user clicks the floating badge */
_restoreFromBadge(config) {
  // 1. Call badge.hide() → await animation
  // 2. Show overlay/backdrop
  // 3. Restore dialog at Page 5 (execution pipeline)
  // 4. Dialog entrance animation
}

/** Called by ExecutionPipeline on each step change */
_onStepProgress(stepData) {
  // If badge is visible, forward to badge:
  if (this._badge && this._badge.isVisible) {
    this._badge.update({
      currentStep: stepData.index,
      currentStepLabel: stepData.label,
      status: stepData.status,
      // ... etc
    });
  }
}
```

---

## 4. State Machine

### 4.1 Visibility States

The badge has a 4-state visibility lifecycle that governs its DOM presence and animation phase:

```
                   show(config)
    ┌─────────┐ ─────────────→ ┌──────────┐
    │  HIDDEN │                │ ENTERING │
    │         │ ←───────────── │          │
    └─────────┘  destroy()     └──────────┘
        ↑                           │
        │                           │ animationend
        │                           ↓
    ┌─────────┐                ┌──────────┐
    │ EXITING │ ←───────────── │ VISIBLE  │
    │         │   hide() or    │          │
    └─────────┘   auto-dismiss └──────────┘
        │                           ↑
        │ animationend              │
        └───────────────────────────┘
               (returns to HIDDEN)
```

### 4.2 State Definitions

| State | DOM Present? | Pointer Events? | Animations | Transitions Available |
|-------|:------------:|:---------------:|-----------|----------------------|
| **HIDDEN** | No | No | None | → ENTERING (via `show()`) |
| **ENTERING** | Yes | No (disabled during animation) | `badgeSlide` entrance (500ms) | → VISIBLE (on animationend), → HIDDEN (via `destroy()`) |
| **VISIBLE** | Yes | Yes | Status dot pulse (if running), hover effects | → EXITING (via `hide()`, click, or auto-dismiss) |
| **EXITING** | Yes | No (disabled during animation) | Reverse `badgeSlide` exit (300ms) | → HIDDEN (on animationend) |

### 4.3 Full State Transition Table

| Current State | Event/Trigger | Next State | Side Effects |
|--------------|--------------|------------|-------------|
| HIDDEN | `show(config)` called | ENTERING | Create DOM, append to container, start entrance animation, register listeners |
| HIDDEN | `hide()` called | HIDDEN | No-op (already hidden) |
| HIDDEN | `update(config)` called | HIDDEN | Ignored (no badge to update) |
| HIDDEN | `destroy()` called | HIDDEN | No-op (already hidden) |
| ENTERING | Entrance animation ends | VISIBLE | Enable pointer events, emit `badge:shown` event |
| ENTERING | `destroy()` called | HIDDEN | Cancel animation, remove DOM immediately, cleanup |
| ENTERING | `hide()` called | HIDDEN | Cancel animation, remove DOM immediately, cleanup |
| ENTERING | `update(config)` called | ENTERING | Buffer the update, apply after entering VISIBLE |
| VISIBLE | `hide()` called | EXITING | Disable pointer events, start exit animation, clear timers |
| VISIBLE | Badge clicked (running/completing) | EXITING | Emit `badge:clicked`, call onClick callback, start exit animation |
| VISIBLE | Badge clicked (success) | EXITING | Emit `badge:clicked`, call onClick callback with 'navigate' intent |
| VISIBLE | Badge clicked (failure) | EXITING | Emit `badge:clicked`, call onClick callback with 'retry' intent |
| VISIBLE | Auto-dismiss timer fires (success only) | EXITING | Start exit animation, emit `badge:hidden` with reason 'auto-dismiss' |
| VISIBLE | `pulseAttention()` called | VISIBLE | Play attention animation (400ms), stay visible |
| VISIBLE | `update(config)` called | VISIBLE | Update text, dot, progress bar in-place |
| VISIBLE | `update({ status: 'success' })` called | VISIBLE | Change to success visual, start 30s auto-dismiss timer |
| VISIBLE | `update({ status: 'failure' })` called | VISIBLE | Change to failure visual, no auto-dismiss |
| VISIBLE | `destroy()` called | HIDDEN | Remove DOM immediately, cleanup, no animation |
| EXITING | Exit animation ends | HIDDEN | Remove DOM, dereference, emit `badge:hidden` |
| EXITING | `destroy()` called | HIDDEN | Cancel animation, remove DOM immediately |
| EXITING | `show(config)` called | EXITING | Throw Error (must wait for exit to complete) |

### 4.4 Status Sub-States (Within VISIBLE)

While the badge is in the VISIBLE state, its visual presentation is driven by the `status` field of the config:

```
                    ┌─────────────────────────┐
                    │       VISIBLE           │
                    │                         │
                    │  ┌───────┐  update()   │
                    │  │RUNNING├──────────→──┐│
                    │  └───┬───┘            ││
                    │      │                ││
                    │      │ update()       ││
                    │      ↓                ↓│
                    │  ┌──────────┐  ┌───────┐│
                    │  │COMPLETING│  │FAILURE││
                    │  └────┬─────┘  └───────┘│
                    │       │                 │
                    │       │ update()        │
                    │       ↓                 │
                    │  ┌───────┐              │
                    │  │SUCCESS│              │
                    │  └───────┘              │
                    │                         │
                    └─────────────────────────┘
```

| Status Sub-State | Visual Treatment | Dot | Progress Bar | Auto-Dismiss |
|-----------------|-----------------|-----|-------------|:------------:|
| `running` | Default accent styling | Accent, pulsing | Visible, animating | No |
| `completing` | Green-tinted styling | Green, pulsing | Visible, 100% | No |
| `success` | Green border glow | Green, static | Hidden | Yes (30s) |
| `failure` | Red border accent | Red, static | Hidden | No |

### 4.5 Minimize/Restore Choreography

The badge participates in a coordinated animation sequence with the InfraWizardDialog:

#### Minimize Sequence (Dialog → Badge)

```
Time 0ms:     User clicks Minimize button or Close(X) during execution
Time 0ms:     Dialog begins shrink animation toward bottom-right corner
Time 0ms:     Overlay begins fade-out
Time 150ms:   Overlay fully transparent, removed from DOM
Time 200ms:   Dialog fully shrunk, removed from DOM
Time 250ms:   Badge DOM created, entrance animation begins (badgeSlide)
Time 750ms:   Badge entrance animation completes, pointer events enabled
              Total choreography: ~750ms
```

#### Restore Sequence (Badge → Dialog)

```
Time 0ms:     User clicks the floating badge
Time 0ms:     Badge begins exit animation (reverse badgeSlide)
Time 300ms:   Badge fully hidden, removed from DOM
Time 300ms:   Overlay created, begins fade-in
Time 300ms:   Dialog created at Page 5, begins entrance animation (dialogIn)
Time 700ms:   Overlay and dialog fully visible
              Total choreography: ~700ms
```

**Critical timing constraint**: The badge exit and dialog entrance are SEQUENTIAL, not overlapping. The dialog must not appear until the badge is fully hidden. This prevents visual confusion and z-index conflicts.

---

## 5. Scenarios

### 5.1 Happy Path — Full Execution While Minimized

**Preconditions**: User is on Page 5, execution is at Step 2/6, user clicks "Minimize" button.

| # | Action | Badge State | Badge Text | Dot |
|---|--------|-------------|-----------|-----|
| 1 | User clicks Minimize | ENTERING | `"Step 2/6 — Assigning Capacity"` | Accent, pulsing |
| 2 | Entrance animation completes | VISIBLE | (same) | (same) |
| 3 | Step 2 completes, step 3 starts | VISIBLE | `"Step 3/6 — Creating Lakehouse"` | Accent, pulsing |
| 4 | Step 3 completes, step 4 starts | VISIBLE | `"Step 4/6 — Creating Notebook"` | Accent, pulsing |
| 5 | Step 4 completes, step 5 starts | VISIBLE | `"Step 5/6 — Writing Cells"` | Accent, pulsing |
| 6 | Step 5 completes, step 6 starts | VISIBLE | `"Step 6/6 — Running Notebook"` | Accent, pulsing |
| 7 | Step 6 nearly done | VISIBLE | `"Step 6/6 — Finishing up..."` | Green, pulsing |
| 8 | Execution completes | VISIBLE | `"Done! Click to open workspace"` | Green, static |
| 9 | User clicks badge | EXITING | (fading out) | — |
| 10 | Badge hidden, dialog restored | HIDDEN | — | — |

### 5.2 Minimize and Immediately Restore

**Preconditions**: Execution is running. User minimizes, then immediately clicks the badge.

| # | Action | Badge State | Result |
|---|--------|-------------|--------|
| 1 | User clicks Minimize | ENTERING | Badge slide-in animation starts |
| 2 | Entrance completes (500ms) | VISIBLE | Badge clickable |
| 3 | User clicks badge | EXITING | Badge exit starts, dialog will restore |
| 4 | Exit completes (300ms) | HIDDEN | Dialog restored at current step |

**Edge case**: If user clicks during ENTERING state, the click is **ignored** (pointer events disabled). The user must wait for the entrance animation to complete.

### 5.3 Execution Fails While Minimized

**Preconditions**: Badge is visible, execution is at Step 3/6.

| # | Action | Badge State | Badge Text | Dot |
|---|--------|-------------|-----------|-----|
| 1 | Badge showing step 3 | VISIBLE | `"Step 3/6 — Creating Lakehouse"` | Accent, pulsing |
| 2 | Step 3 fails (API error) | VISIBLE | `"Failed — Click to retry"` | Red, static |
| 3 | Badge border turns red-tinted | VISIBLE | (same) | (same) |
| 4 | User clicks badge | EXITING | Badge exits | — |
| 5 | Dialog restores at failed step | HIDDEN | Dialog shows Page 5 with retry option | — |

### 5.4 Close (X) During Execution = Minimize

**Preconditions**: User is on Page 5, execution is running. User clicks the Close (X) button.

| # | Action | Result |
|---|--------|--------|
| 1 | User clicks ✕ in dialog title bar | Dialog treats this as minimize, NOT close |
| 2 | Dialog minimizes to badge | Badge appears with current execution state |
| 3 | Execution continues in background | Badge text updates as steps progress |

**Note**: The ✕ button during execution is functionally identical to the Minimize button. The spec (§8 Edge Cases) states: "Close (X) during execution = minimize (keeps running)."

### 5.5 User Navigates While Badge Visible

**Preconditions**: Badge is visible (execution running or completed).

| # | Action | Result |
|---|--------|--------|
| 1 | User clicks a different tab in EDOG Studio | Badge stays fixed at bottom-right |
| 2 | User opens workspace explorer | Badge remains visible above explorer panel |
| 3 | User opens API playground | Badge remains visible |
| 4 | User opens settings | Badge remains visible |
| 5 | User scrolls any panel | Badge stays fixed (position: fixed) |

**The badge persists across all app navigation.** It is attached to `document.body` (or the app root) and uses `position: fixed`, so it is unaffected by any panel/view changes.

### 5.6 Auto-Dismiss on Success

**Preconditions**: Badge is in success state.

| # | Time | Action | Result |
|---|------|--------|--------|
| 1 | T+0s | Badge enters success state | `"Done! Click to open workspace"`, auto-dismiss timer starts |
| 2 | T+25s | Timer at 25s | `badge:auto-dismiss-warning` event emitted (5s remaining) |
| 3 | T+30s | Timer fires | Badge begins exit animation (auto-dismiss) |
| 4 | T+30.3s | Exit completes | Badge removed, `badge:hidden` emitted with reason `'auto-dismiss'` |

**Cancel auto-dismiss**: If the user hovers over or clicks the badge before the 30s timer fires, the auto-dismiss timer is canceled. The badge stays visible until explicitly clicked or programmatically hidden.

### 5.7 New Wizard Blocked While Badge Exists

**Preconditions**: Badge is visible (any status).

| # | Action | Result |
|---|--------|--------|
| 1 | User clicks "New Infrastructure" in workspace explorer | Badge `pulseAttention()` called |
| 2 | Badge briefly bounces (400ms) | Draws user's eye to the existing badge |
| 3 | Toast notification appears | `"An environment is being created. Click the badge to view progress."` |
| 4 | New wizard is NOT opened | Singleton constraint enforced |

### 5.8 Badge During Window Resize

**Preconditions**: Badge is visible.

| # | Action | Result |
|---|--------|--------|
| 1 | User resizes browser window | Badge stays at `bottom: 24px; right: 24px` (fixed position) |
| 2 | Window becomes very narrow (<400px) | Badge pill truncates text with ellipsis via `max-width` |
| 3 | Window returns to normal width | Badge text restores to full content |

### 5.9 Rapid Step Transitions

**Preconditions**: Badge is visible, steps complete very quickly (e.g., <200ms per step).

| # | Action | Result |
|---|--------|--------|
| 1 | Step 1 completes, step 2 starts (50ms) | Badge text updates to step 2 |
| 2 | Step 2 completes, step 3 starts (50ms) | Badge text updates to step 3 |
| 3 | Updates are immediate (no debounce) | Text swaps are instant — no animation on text change |
| 4 | Progress bar width animates smoothly | Bar fill transitions via CSS `transition: width 300ms ease` |

**Rationale**: Text changes are instant to always show the latest state. Only the progress bar animates, since its width transitions smoothly via CSS.

### 5.10 Badge Content Truncation

**Preconditions**: Very long environment name or step label.

| # | Input | Rendered Text | Truncation |
|---|-------|-------------|:----------:|
| 1 | Name: `"brave_turing_42"`, Step: `"Creating Lakehouse"` | `"Step 3/6 — Creating Lakehouse"` | No |
| 2 | Name: `"my_very_long_test_environment_name_that_exceeds_width"`, Step: `"Creating Lakehouse"` | N/A (name not in running text) | N/A |
| 3 | Success text | `"Done! Click to open workspace"` | No (always fits in 300px) |
| 4 | Failure text | `"Failed — Click to retry"` | No (always fits in 300px) |

**Note**: The environment name is NOT displayed in the badge text during running state (per the CEO-approved mock which shows `"Step 3/6 — Creating Lakehouse"`, not the environment name). The environment name is used only for the `aria-label` and potential tooltip on hover.

---

## 6. Visual Specification

### 6.1 DOM Structure

```html
<!-- Root: position: fixed, bottom-right of viewport -->
<div class="floating-badge"
     role="status"
     aria-live="polite"
     aria-label="Environment creation: Step 3 of 6, Creating Lakehouse"
     tabindex="0">

  <!-- Status dot: 8px circle, color varies by state -->
  <span class="floating-badge__dot floating-badge__dot--running"
        aria-hidden="true"></span>

  <!-- Text content: step counter + current action -->
  <span class="floating-badge__text">
    Step 3/6 — Creating Lakehouse
  </span>

  <!-- Micro progress bar: 32px inline bar -->
  <span class="floating-badge__progress" aria-hidden="true">
    <span class="floating-badge__progress-fill"
          style="width: 50%"></span>
  </span>
</div>
```

### 6.2 CSS Token Map

Every visual property maps to an EDOG Studio design system token:

| Property | Token / Value | Notes |
|----------|-------------|-------|
| **Position** | `position: fixed` | Viewport-relative |
| **Bottom** | `24px` (`var(--sp-6)`) | 4px grid: 6 × 4px = 24px |
| **Right** | `24px` (`var(--sp-6)`) | 4px grid |
| **Background** | `var(--surface)` (`#ffffff`) | White surface |
| **Border** | `1px solid var(--border-bright)` (`rgba(0,0,0,0.12)`) | Slightly stronger than default |
| **Border Radius** | `var(--r-full)` (`100px`) | Pill shape |
| **Padding** | `8px 16px` (`var(--sp-2) var(--sp-4)`) | 4px grid |
| **Box Shadow** | `var(--shadow-lg)` | `0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)` |
| **Font Family** | `var(--font)` | Inter, system fallbacks |
| **Font Size** | `var(--text-sm)` (`12px`) | Small but readable |
| **Font Weight** | `600` | Semi-bold for emphasis |
| **Color** | `var(--text)` (`#1a1d23`) | Primary text color |
| **Max Width** | `300px` | Prevents badge from growing too wide |
| **Z-Index** | `500` (`var(--z-floating-badge)`) | Above toasts (400), below nothing in current scale |
| **Cursor** | `pointer` | Indicates clickable |
| **User Select** | `none` | Prevent text selection on click |
| **Gap** | `var(--sp-2)` (`8px`) | Between dot, text, and progress bar |
| **Display** | `inline-flex` | Horizontal layout |
| **Align Items** | `center` | Vertical centering |
| **White Space** | `nowrap` | Prevent text wrapping |
| **Text Overflow** | `ellipsis` | Truncate if badge exceeds max-width |
| **Overflow** | `hidden` | Required for text-overflow to work |

### 6.3 Status Dot Specification

| Property | Value |
|----------|-------|
| **Width** | `8px` |
| **Height** | `8px` |
| **Border Radius** | `50%` (circle) |
| **Flex Shrink** | `0` (never shrinks) |

**Dot colors by state:**

| State | Background Color | Animation |
|-------|-----------------|-----------|
| `running` | `var(--accent)` (`#6d5cff`) | `dotPulse 1.5s ease-in-out infinite` |
| `completing` | `var(--status-ok)` (`#18a058`) | `dotPulse 1.5s ease-in-out infinite` |
| `success` | `var(--status-ok)` (`#18a058`) | None (static) |
| `failure` | `var(--status-fail)` (`#e5453b`) | None (static) |

**dotPulse keyframes** (from CEO-approved mock):

```css
@keyframes dotPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.8); }
}
```

### 6.4 Micro Progress Bar Specification

The inline progress bar is a 32px-wide micro indicator showing fractional step completion.

| Property | Value |
|----------|-------|
| **Container Width** | `32px` |
| **Container Height** | `4px` |
| **Container Border Radius** | `2px` |
| **Container Background** | `var(--surface-3)` (`#ebedf0`) |
| **Overflow** | `hidden` |

**Fill element:**

| Property | Value |
|----------|-------|
| **Height** | `100%` (`4px`) |
| **Border Radius** | `2px` |
| **Background** | `var(--accent)` (running) or `var(--status-ok)` (completing) |
| **Width** | Calculated: `(currentStep / totalSteps) * 100%` |
| **Transition** | `width 300ms var(--ease)` (smooth fill on step advance) |

**Visibility by state:**

| State | Progress Bar Visible? |
|-------|:--------------------:|
| `running` | Yes |
| `completing` | Yes (100% filled) |
| `success` | No (hidden) |
| `failure` | No (hidden) |

When hidden, the progress bar element is set to `display: none` (not `opacity: 0`) to reclaim horizontal space in the pill.

### 6.5 Complete CSS

```css
/* ═══════════════════════════════════════════════════════════════
   C11 — FloatingBadge
   Position: fixed bottom-right of viewport
   Z-index: 500 (above toasts, above all app content)
   ═══════════════════════════════════════════════════════════════ */

.floating-badge {
  position: fixed;
  bottom: var(--sp-6);             /* 24px */
  right: var(--sp-6);              /* 24px */
  z-index: 500;                    /* var(--z-floating-badge) — new token */

  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);                /* 8px */

  padding: var(--sp-2) var(--sp-4); /* 8px 16px */
  max-width: 300px;

  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--r-full);    /* pill shape */
  box-shadow: var(--shadow-lg);

  font-family: var(--font);
  font-size: var(--text-sm);       /* 12px */
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  cursor: pointer;

  /* Entrance animation */
  animation: badgeSlide 500ms var(--spring) both;

  /* Hover transition */
  transition: box-shadow var(--t-fast) var(--ease),
              transform var(--t-fast) var(--ease),
              border-color var(--t-fast) var(--ease);
}

/* ─── Hover state ─── */
.floating-badge:hover {
  box-shadow: var(--shadow-xl);
  transform: translateY(-2px);
}

/* ─── Focus state (keyboard navigation) ─── */
.floating-badge:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow), var(--shadow-lg);
  border-color: var(--accent);
}

/* ─── Active (pressed) state ─── */
.floating-badge:active {
  transform: translateY(0);
  box-shadow: var(--shadow-md);
}

/* ─── Exit animation class ─── */
.floating-badge--exiting {
  animation: badgeSlideOut 300ms var(--ease-out) forwards;
}

/* ─── Success state ─── */
.floating-badge--success {
  border-color: rgba(24, 160, 88, 0.3);
  box-shadow: var(--shadow-lg), 0 0 0 1px rgba(24, 160, 88, 0.1);
}

.floating-badge--success:hover {
  box-shadow: var(--shadow-xl), 0 0 0 2px rgba(24, 160, 88, 0.15);
}

/* ─── Failure state ─── */
.floating-badge--failure {
  border-color: rgba(229, 69, 59, 0.3);
  box-shadow: var(--shadow-lg), 0 0 0 1px rgba(229, 69, 59, 0.1);
}

.floating-badge--failure:hover {
  box-shadow: var(--shadow-xl), 0 0 0 2px rgba(229, 69, 59, 0.15);
}

/* ─── Attention pulse (new wizard blocked) ─── */
.floating-badge--attention {
  animation: badgeAttention 400ms var(--spring);
}

/* ═══════ Status Dot ═══════ */
.floating-badge__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.floating-badge__dot--running {
  background: var(--accent);
  animation: dotPulse 1.5s ease-in-out infinite;
}

.floating-badge__dot--completing {
  background: var(--status-ok);
  animation: dotPulse 1.5s ease-in-out infinite;
}

.floating-badge__dot--success {
  background: var(--status-ok);
}

.floating-badge__dot--failure {
  background: var(--status-fail);
}

/* ═══════ Text ═══════ */
.floating-badge__text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1;
}

/* ═══════ Micro Progress Bar ═══════ */
.floating-badge__progress {
  width: 32px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
  flex-shrink: 0;
}

.floating-badge__progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 300ms var(--ease);
}

.floating-badge--completing .floating-badge__progress-fill {
  background: var(--status-ok);
}

.floating-badge__progress--hidden {
  display: none;
}

/* ═══════ Keyframe Animations ═══════ */

/* Entrance: slide up from below + scale in */
@keyframes badgeSlide {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Exit: slide down + scale out */
@keyframes badgeSlideOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(20px) scale(0.9);
  }
}

/* Status dot pulse */
@keyframes dotPulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.8);
  }
}

/* Attention bounce (singleton enforcement) */
@keyframes badgeAttention {
  0%   { transform: scale(1); }
  25%  { transform: scale(1.08); }
  50%  { transform: scale(0.96); }
  75%  { transform: scale(1.03); }
  100% { transform: scale(1); }
}
```

### 6.6 Z-Index Strategy

The FloatingBadge introduces a new z-index layer to the EDOG Studio design system:

| Token | Value | Layer | Relationship to Badge |
|-------|:-----:|-------|----------------------|
| `--z-sidebar` | 50 | Sidebar navigation | Below badge |
| `--z-toolbar` | 90 | Log toolbar, filter bars | Below badge |
| `--z-topbar` | 100 | Top status bar | Below badge |
| `--z-dropdown` | 200 | Dropdowns, context menus | Below badge |
| `--z-detail` | 200 | Detail panel, drawers | Below badge |
| `--z-command-palette` | 300 | Command palette overlay | Below badge |
| `--z-toast` | 400 | Toast notifications | Below badge |
| **`--z-floating-badge`** | **500** | **Floating badge (NEW)** | **This component** |
| `--z-overlay` | 1000 | Modal overlay (wizard dialog) | Above badge |

**Rationale for z-index 500:**

- The badge MUST appear above toasts (400) because it is a persistent, interactive element — a toast appearing on top of the badge would prevent clicks
- The badge MUST appear below the overlay (1000) so that when the dialog is restored, the overlay covers the badge during the transition
- No existing EDOG Studio layer occupies the 400–1000 range, so 500 is safe
- The wizard dialog overlay uses z-index 1000 (as set in the mock CSS `.overlay { z-index: 1000 }`)

**When badge and dialog coexist**: During the minimize/restore choreography, there is a brief moment (~50ms gap) where both could theoretically be in the DOM. The z-index ordering ensures the overlay (1000) is always above the badge (500), preventing visual glitches.

### 6.7 Position Conflict Avoidance

The badge is positioned at `bottom: 24px; right: 24px`. This must not overlap with existing EDOG Studio UI elements:

| UI Element | Position | Conflict Risk | Resolution |
|-----------|----------|:-------------:|-----------|
| **Status bar** | Top of viewport | None | No overlap (badge is at bottom) |
| **Sidebar** | Left side of viewport | None | No overlap (badge is at right) |
| **Log viewer toolbar** | Bottom of log panel | Low | Toolbar is inside a panel, not fixed to viewport; badge floats above |
| **Detail panel** | Right side, within main content area | Low | Detail panel uses `position: absolute` within its container; badge uses `position: fixed` and floats above |
| **Toasts** | Bottom-right (if using default position) | **Medium** | Badge z-index (500) > toast z-index (400); toasts should offset upward by badge height (~40px) when badge is visible |
| **Command palette** | Center of viewport | None | No positional overlap |
| **Scrollbars** | Right edge of scrollable areas | None | Badge is `fixed`, not `absolute`; scrollbars are within their containers |

**Toast collision handling**: When the FloatingBadge is visible, the toast notification system should shift its origin point up by `48px` (badge height 32px + spacing 16px) to avoid overlap. This is communicated via a CSS custom property on `document.body`:

```css
/* Applied to body when badge is visible */
body.has-floating-badge {
  --toast-bottom-offset: 72px; /* 24px badge margin + 32px badge height + 16px gap */
}
```

### 6.8 Dimension Reference

```
┌──────────────────────────────────────────────┐
│ ●  Step 3/6 — Creating Lakehouse   ████░░░░ │
└──────────────────────────────────────────────┘
 ↑  ↑                                 ↑
 │  │                                 └─ Progress bar: 32×4px
 │  └─ Text: 12px Inter, weight 600
 └─ Dot: 8×8px circle

Total height: ~32px (8px padding top + ~16px content + 8px padding bottom)
Max width: 300px
Pill radius: 100px (fully rounded ends)
Position: fixed, 24px from bottom-right corner

                                      ┌─── viewport ───┐
                                      │                 │
                                      │                 │
                                      │                 │
                                      │                 │
                                      │         [badge] │ ← 24px from right
                                      │                 │
                                      └─── 24px from ───┘
                                           bottom
```

### 6.9 Color Palette Summary

All colors reference existing design system tokens:

| Element | Running | Completing | Success | Failure |
|---------|---------|------------|---------|---------|
| **Dot** | `--accent` | `--status-ok` | `--status-ok` | `--status-fail` |
| **Text** | `--text` | `--text` | `--text` | `--text` |
| **Background** | `--surface` | `--surface` | `--surface` | `--surface` |
| **Border** | `--border-bright` | `--border-bright` | `rgba(24,160,88,0.3)` | `rgba(229,69,59,0.3)` |
| **Shadow** | `--shadow-lg` | `--shadow-lg` | `--shadow-lg` + green glow | `--shadow-lg` + red glow |
| **Progress fill** | `--accent` | `--status-ok` | (hidden) | (hidden) |
| **Progress track** | `--surface-3` | `--surface-3` | (hidden) | (hidden) |

---

## 7. Keyboard & Accessibility

### 7.1 ARIA Roles and Properties

```html
<div class="floating-badge"
     role="status"
     aria-live="polite"
     aria-label="Environment creation: Step 3 of 6, Creating Lakehouse"
     aria-roledescription="progress indicator"
     tabindex="0">
```

| Attribute | Value | Purpose |
|-----------|-------|---------|
| `role` | `"status"` | Marks the badge as a live status region |
| `aria-live` | `"polite"` | Screen readers announce changes without interrupting current speech |
| `aria-label` | Dynamic (see below) | Full description of badge state |
| `aria-roledescription` | `"progress indicator"` | Clarifies the role for assistive tech |
| `tabindex` | `"0"` | Makes badge focusable via Tab key |

### 7.2 Dynamic aria-label Values

The `aria-label` is updated on every `update()` call to reflect the current state:

| Status | aria-label |
|--------|-----------|
| `running` | `"Environment creation: Step {N} of {M}, {currentStepLabel}. Click to view details."` |
| `completing` | `"Environment creation: Finishing up. Click to view details."` |
| `success` | `"Environment created successfully. Click to open workspace."` |
| `failure` | `"Environment creation failed at {failedStepLabel}. Click to retry."` |

**Examples:**

```
"Environment creation: Step 1 of 6, Creating Workspace. Click to view details."
"Environment creation: Step 3 of 6, Creating Lakehouse. Click to view details."
"Environment creation: Finishing up. Click to view details."
"Environment created successfully. Click to open workspace."
"Environment creation failed at Creating Lakehouse. Click to retry."
```

### 7.3 Keyboard Interactions

| Key | State | Action |
|-----|-------|--------|
| `Tab` | Any | Badge receives focus (part of normal tab order) |
| `Enter` | Focused, VISIBLE | Same as click — triggers onClick callback, restores dialog |
| `Space` | Focused, VISIBLE | Same as Enter |
| `Escape` | Focused, success/failure | Dismiss badge (same as auto-dismiss) |
| `Escape` | Focused, running | No effect (cannot dismiss while running) |

### 7.4 Focus Management

**On show():**
- Badge does NOT steal focus from the current element
- Badge is added to the end of the tab order (natural DOM position in body)
- Screen reader announces the badge content via `aria-live="polite"`

**On click/Enter/Space (restore dialog):**
- Focus moves to the dialog when it opens
- Specifically, focus moves to the active element on Page 5 (the execution pipeline)

**On auto-dismiss:**
- Focus returns to the previously focused element (if still in DOM)
- If the previously focused element is gone, focus moves to `document.body`

### 7.5 Screen Reader Announcements

| Event | Announcement (via aria-live) |
|-------|------------------------------|
| Badge appears | `"Environment creation in progress: Step {N} of {M}, {stepLabel}"` |
| Step advances | `"Step {N} of {M}, {stepLabel}"` |
| Execution completes | `"Environment created successfully. Click to open workspace."` |
| Execution fails | `"Environment creation failed. Click to retry."` |
| Auto-dismiss warning | `"Progress indicator will close in 5 seconds"` |
| Badge dismissed | (no announcement — element removed) |

### 7.6 Reduced Motion

When `prefers-reduced-motion: reduce` is active:

```css
@media (prefers-reduced-motion: reduce) {
  .floating-badge {
    animation: none !important;
    transition: none !important;
  }

  .floating-badge__dot--running,
  .floating-badge__dot--completing {
    animation: none !important;
    /* Static dot, no pulse */
  }

  .floating-badge--exiting {
    animation: none !important;
    /* Instant removal, no slide */
  }

  .floating-badge--attention {
    animation: none !important;
    /* Brief opacity flash instead of bounce */
    opacity: 0.5;
    transition: opacity 100ms;
  }
}
```

**With reduced motion:**
- Badge appears/disappears instantly (no slide animation)
- Status dot is static (no pulse)
- Hover effects still apply (color changes are not motion)
- Progress bar fill still transitions (width change at 300ms is a simple transition, not animation)

### 7.7 High Contrast Mode

```css
@media (forced-colors: active) {
  .floating-badge {
    border: 2px solid ButtonText;
    background: Canvas;
    color: ButtonText;
    forced-color-adjust: none;
  }

  .floating-badge__dot {
    background: Highlight;
  }

  .floating-badge--failure .floating-badge__dot {
    background: Mark;
  }

  .floating-badge__progress {
    background: GrayText;
  }

  .floating-badge__progress-fill {
    background: Highlight;
  }
}
```

### 7.8 Minimum Touch Target

The badge's visual size (approximately 200–300px × 32px) exceeds the WCAG 2.2 minimum touch target of 44 × 44 CSS pixels in width. However, the height of 32px is below 44px. To meet the requirement:

```css
.floating-badge {
  /* Visual padding is 8px 16px, but we add an invisible
     touch target extension via ::before pseudo-element */
  position: relative;
}

.floating-badge::before {
  content: '';
  position: absolute;
  inset: -6px -4px;  /* Extends touch area to ~44px height */
  border-radius: inherit;
}
```

This creates a minimum touch target of `~308px × 44px`, exceeding WCAG requirements on both axes.

---

## 8. Error Handling

### 8.1 Badge-Level Errors

The FloatingBadge is a pure view component — it does not make API calls or manage execution. Its error surface is narrow:

| Error Scenario | Detection | Recovery |
|---------------|-----------|---------|
| **show() called when already visible** | Check `visibility !== 'hidden'` | Throw `Error("FloatingBadge is already visible. Call hide() first.")` |
| **update() called when hidden** | Check `visibility === 'hidden'` | Silently ignore (no-op) — log warning to console |
| **containerEl is null/invalid** | Type check in constructor | Throw `TypeError("containerEl must be a valid HTMLElement")` |
| **Config has invalid step index** | Check `currentStep` range | Clamp to `[1, totalSteps]`, log warning |
| **Config has invalid status** | Check against valid values | Default to `'running'`, log warning |
| **DOM element unexpectedly removed** | Check in `update()`, `hide()` | Set visibility to 'hidden', cleanup timers, log error |
| **Animation doesn't fire animationend** | Safety timeout (1000ms) | Force state transition after timeout |

### 8.2 Execution Failure Display

When the ExecutionPipeline reports a failure, the badge transitions to the failure state:

```javascript
// Called by ExecutionPipeline:
badge.update({
  status: 'failure',
  errorMessage: 'Lakehouse creation failed — 409 Conflict',
  failedStepLabel: 'Creating Lakehouse',
  failedStepIndex: 3
});
```

**Badge behavior on failure:**

1. Text changes to `"Failed — Click to retry"` (short, actionable)
2. Dot changes to red, stops pulsing
3. Border gets red tint
4. Progress bar hides
5. Click behavior changes: clicking opens dialog at the failed step with the retry option visible
6. No auto-dismiss timer (failure persists until user acts)

**The badge does NOT display the error message** (`errorMessage`). The error message is too long for the pill format. The full error is available when the user clicks the badge and the dialog restores to the failure state on Page 5.

### 8.3 Stale Badge Recovery

If the execution process crashes or the page state is lost (e.g., hot module reload during development), the badge could become orphaned (visible but not receiving updates):

**Detection**: The badge receives updates via `update()`. If no update arrives for 60 seconds while in `running` state, the badge enters a stale recovery state:

```javascript
// Inside FloatingBadge:
_startStaleDetection() {
  this._staleTimerId = setInterval(() => {
    if (this._config.status === 'running') {
      const now = Date.now();
      if (now - this._lastUpdateTimestamp > 60000) {
        this._handleStale();
      }
    }
  }, 10000); // Check every 10s
}

_handleStale() {
  // Update text to indicate potential issue
  this.update({
    status: 'failure',
    errorMessage: 'Lost connection to execution pipeline',
    failedStepLabel: this._config.currentStepLabel,
    failedStepIndex: this._config.currentStep
  });
}
```

### 8.4 Graceful Degradation

If CSS animations are not supported (very old browsers), the badge still functions:

- Appears immediately (no entrance animation)
- Dot is static (no pulse)
- Click-to-restore works normally
- Text updates work normally
- Only the polish is lost, not the functionality

---

## 9. Performance

### 9.1 Performance Budget

| Metric | Budget | Notes |
|--------|--------|-------|
| **DOM nodes** | ≤ 5 | Root + dot + text + progress container + progress fill |
| **CSS rules** | ≤ 30 | Component-scoped, no global pollution |
| **JS class size** | ≤ 200 lines | Pure view, minimal logic |
| **Memory** | ≤ 2 KB | No caching, no complex state |
| **Event listeners** | ≤ 6 | click, mouseenter, mouseleave, keydown, focusin, focusout |
| **Timers** | ≤ 3 | Auto-dismiss (setTimeout), attention debounce (setTimeout), stale detection (setInterval) |
| **Layout thrash** | 0 | No reads-after-writes; all updates are write-only |
| **Repaints per step** | 1 | Single text node update + progress bar width |

### 9.2 Animation Performance

All animations are GPU-composited:

| Animation | Properties Animated | GPU-Composited? |
|-----------|-------------------|:---------------:|
| `badgeSlide` (entrance) | `opacity`, `transform` | Yes |
| `badgeSlideOut` (exit) | `opacity`, `transform` | Yes |
| `dotPulse` | `opacity`, `transform` | Yes |
| `badgeAttention` | `transform` | Yes |
| Hover elevation | `transform`, `box-shadow` | `transform`: yes, `box-shadow`: no (but runs at 60fps due to simplicity) |
| Progress bar fill | `width` | No (layout), but only 32px wide — negligible |

**No `will-change`** is needed. The badge is a single small element, and modern browsers optimize `transform` and `opacity` animations automatically. Adding `will-change` would create an unnecessary compositor layer.

### 9.3 Update Batching

When multiple step transitions happen rapidly (e.g., steps 1–3 complete within 200ms), the badge receives multiple `update()` calls in quick succession. There is **no debouncing** on text updates — each update is applied immediately. This is intentional:

- The text node swap is a single DOM write (~0.01ms)
- The progress bar width transition is CSS-driven (no JS reflow)
- Debouncing would cause the badge to show stale step information

### 9.4 Lifecycle Cleanup

On `hide()` and `destroy()`:

1. All `setTimeout` and `setInterval` timers are cleared
2. All event listeners are removed (using stored references)
3. The DOM element is removed from the parent
4. All internal references are set to `null`
5. The `body.has-floating-badge` class is removed

This ensures zero memory leaks when the badge is shown/hidden repeatedly.

### 9.5 No Polling

The badge does NOT poll for execution status. It receives updates via explicit `update()` calls from the ExecutionPipeline. This is a push-based model:

```
ExecutionPipeline
  ↓ (calls badge.update() on step change)
FloatingBadge
  ↓ (updates DOM)
Browser renders
```

No `setInterval` for status checking. The only timer is the optional 30-second auto-dismiss on success.

---

## 10. Implementation Notes

### 10.1 File Location

```
src/
  features/
    infra-wizard/
      floating-badge.js       ← FloatingBadge class
      floating-badge.css      ← Component styles (inlined at build time)
```

Both files are inlined into the single HTML output by `python scripts/build-html.py` (per ADR-003).

### 10.2 Class Skeleton

```javascript
/**
 * C11 — FloatingBadge
 *
 * Fixed-position pill indicator for minimized wizard execution.
 * Shows step progress, status, and provides click-to-restore.
 *
 * @fires badge:shown
 * @fires badge:hidden
 * @fires badge:clicked
 * @fires badge:status-changed
 * @fires badge:auto-dismiss-warning
 */
class FloatingBadge {
  /** @type {HTMLElement} */
  #containerEl;

  /** @type {HTMLElement|null} */
  #el = null;

  /** @type {HTMLElement|null} */
  #dotEl = null;

  /** @type {HTMLElement|null} */
  #textEl = null;

  /** @type {HTMLElement|null} */
  #progressEl = null;

  /** @type {HTMLElement|null} */
  #progressFillEl = null;

  /** @type {'hidden'|'entering'|'visible'|'exiting'} */
  #visibility = 'hidden';

  /** @type {FloatingBadgeConfig|null} */
  #config = null;

  /** @type {Set<function>} */
  #clickCallbacks = new Set();

  /** @type {number|null} */
  #autoDismissTimerId = null;

  /** @type {number|null} */
  #attentionTimerId = null;

  /** @type {number|null} */
  #staleDetectionTimerId = null;

  /** @type {number} */
  #lastUpdateTimestamp = 0;

  /** @type {AbortController|null} */
  #abortController = null;

  constructor(containerEl) { /* ... */ }

  show(config)        { /* ... */ }
  hide()              { /* ... return Promise */ }
  destroy()           { /* ... */ }
  update(config)      { /* ... */ }
  setStatus(status)   { /* ... */ }
  onClick(callback)   { /* ... return unsubscribe */ }
  pulseAttention()    { /* ... */ }

  get isVisible()     { /* ... */ }
  get currentConfig() { /* ... */ }
  get element()       { /* ... */ }

  // ─── Private methods ─────────────────────────
  #createDOM()        { /* Build badge element tree */ }
  #removeDOM()        { /* Remove and dereference */ }
  #updateDot()        { /* Change dot class/color */ }
  #updateText()       { /* Change text content */ }
  #updateProgress()   { /* Change progress bar width */ }
  #updateAriaLabel()  { /* Recompute aria-label */ }
  #applyStatusClass() { /* Add/remove status modifier classes */ }
  #startAutoDismiss() { /* Start 30s timer */ }
  #clearAutoDismiss() { /* Clear timer */ }
  #handleClick()      { /* Dispatch to callbacks */ }
  #emitEvent(name, detail) { /* CustomEvent dispatch */ }
}
```

### 10.3 Integration Points

| Integration | Direction | Mechanism |
|------------|-----------|-----------|
| **InfraWizardDialog → FloatingBadge** | Dialog calls `badge.show()`, `badge.hide()` | Direct method calls |
| **ExecutionPipeline → FloatingBadge** | Pipeline calls `badge.update()` on step progress | Direct method calls (via dialog forwarding) |
| **FloatingBadge → InfraWizardDialog** | Badge notifies dialog of click via `onClick()` callback | Callback pattern |
| **FloatingBadge → Toast System** | Badge adds `body.has-floating-badge` CSS class | CSS custom property |
| **FloatingBadge → Screen Readers** | Badge updates `aria-label` and `aria-live` region | ARIA attributes |
| **Workspace Explorer → FloatingBadge** | Explorer checks `badge.isVisible` before opening wizard | Direct property read |

### 10.4 Testing Strategy

| Test Category | Test Count | Approach |
|:---:|:---:|---------|
| **Unit** | 18 | Class methods, state transitions, config validation |
| **DOM** | 8 | Element creation, text content, CSS classes, ARIA attributes |
| **Animation** | 4 | Entrance/exit timing, animation class application |
| **Integration** | 6 | Dialog minimize/restore coordination, step progress forwarding |
| **A11y** | 5 | Screen reader announcements, keyboard nav, focus management |

**Key test cases:**

```
Unit Tests:
  ✓ constructor throws TypeError for invalid containerEl
  ✓ show() creates DOM and sets visibility to 'entering'
  ✓ show() throws Error if already visible
  ✓ hide() transitions to 'exiting' state
  ✓ hide() is no-op when already hidden
  ✓ destroy() immediately removes DOM without animation
  ✓ update() changes text content for each step label
  ✓ update() changes dot class for each status
  ✓ update() hides progress bar on success/failure
  ✓ update() is no-op when badge is hidden
  ✓ setStatus('success') starts auto-dismiss timer
  ✓ setStatus('failure') does NOT start auto-dismiss timer
  ✓ onClick() returns unsubscribe function
  ✓ pulseAttention() adds and removes attention class
  ✓ pulseAttention() is debounced (ignore rapid calls)
  ✓ isVisible returns true only in 'entering' or 'visible' state
  ✓ currentConfig returns null when hidden
  ✓ step index is clamped to valid range

DOM Tests:
  ✓ Badge element has correct CSS classes
  ✓ Badge element has role="status"
  ✓ Badge element has aria-live="polite"
  ✓ Badge element has tabindex="0"
  ✓ Dot element has correct color class for each status
  ✓ Text element contains correct step text
  ✓ Progress bar width matches currentStep/totalSteps ratio
  ✓ body gets 'has-floating-badge' class when badge is visible

Animation Tests:
  ✓ Entrance animation class is applied on show()
  ✓ Exit animation class is applied on hide()
  ✓ Animation cleanup timeout fires if animationend doesn't
  ✓ Pointer events disabled during entering/exiting states

Integration Tests:
  ✓ Dialog minimize triggers badge.show()
  ✓ Badge click triggers dialog restore
  ✓ Step progress from pipeline updates badge text
  ✓ Success state on pipeline updates badge to success
  ✓ Failure state on pipeline updates badge to failure
  ✓ New wizard attempt triggers badge.pulseAttention()

A11y Tests:
  ✓ aria-label updates on every status change
  ✓ Enter/Space keys trigger click handler
  ✓ Escape key dismisses badge in success/failure state
  ✓ Tab key reaches badge in normal tab order
  ✓ Screen reader announcements fire on state changes
```

### 10.5 Dependencies

| Dependency | Type | Why |
|-----------|------|-----|
| Design system tokens | CSS | Colors, spacing, shadows, radius, fonts |
| `@keyframes badgeSlide` | CSS | Entrance animation (already in mock) |
| `@keyframes dotPulse` | CSS | Status dot pulse (already in mock) |
| C10-ExecutionPipeline | Runtime | Provides step progress data |
| C1-InfraWizardDialog | Runtime | Coordinates minimize/restore lifecycle |

### 10.6 Implementation Order

The FloatingBadge sits at **Layer 14** in the F16 implementation order (per spec §13):

```
Layer 13: ExecutionPipeline — API orchestration, progress UI, rollback
Layer 14: FloatingBadge — minimized state          ← THIS COMPONENT
Layer 15: Integration — wire into workspace-explorer.js, error recovery, polish
```

**Pre-requisites before implementation:**
1. C1-InfraWizardDialog must have working minimize/restore lifecycle
2. C10-ExecutionPipeline must emit step progress events
3. Design system must include the new `--z-floating-badge: 500` token

### 10.7 Design System Token Addition

This component requires one new token in the EDOG Studio design system (`docs/DESIGN_SYSTEM.md` §8):

```markdown
| `--z-floating-badge` | `500` | Floating badge (minimized wizard) |
```

This token should be added between `--z-toast` (400) and the overlay z-index (1000) used by modal dialogs.

### 10.8 Open Questions

| # | Question | Impact | Proposed Resolution |
|---|----------|--------|-------------------|
| 1 | Should the badge show elapsed time in running state? | Low | No — the mock doesn't show elapsed time in the badge, and it adds visual noise. Elapsed time is visible when the dialog is restored. |
| 2 | Should auto-dismiss show an "undo" toast? | Low | Yes — after auto-dismiss, show a toast: "Environment ready. [Open Workspace]" as a fallback action point. |
| 3 | Should the badge animate text changes? | Low | No — instant text swaps are clearer. Animating text (fade/slide) would be distracting at 12px font size. |
| 4 | Should the badge support dark theme? | Medium | Yes, automatically. All colors reference design system tokens which will have dark-theme overrides when dark mode is implemented (F-TBD). No badge-specific dark theme work needed. |
| 5 | What happens if the browser tab is backgrounded during execution? | Medium | The ExecutionPipeline handles polling; the badge simply renders whatever state it receives. No badge-specific handling needed. `requestAnimationFrame` is paused in background tabs, but CSS animations continue. |

### 10.9 Checklist Before Implementation

- [ ] C10-ExecutionPipeline spec complete with step progress event API
- [ ] C1-InfraWizardDialog spec complete with minimize/restore lifecycle
- [ ] Design system updated with `--z-floating-badge: 500` token
- [ ] Toast system updated to respect `--toast-bottom-offset` when badge is visible
- [ ] CEO approval of final badge text format (step counter style confirmed)

---

*End of C11-FloatingBadge Component Deep Spec*
