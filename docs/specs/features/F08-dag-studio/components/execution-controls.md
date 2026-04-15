# Execution Controls — Component Spec

> **Feature:** F08 DAG Studio — Section 2.2 Execution Controls
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend) + Vex (Backend) + Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `spec.md` §2.2, `p0-foundation.md` (API endpoints 4–15), `auto-detect.js` (real-time state)
> **Feeds Into:** `states/execution-controls.md`, `dag-studio.js`

---

## 0. Overview

The Execution Controls toolbar is the command strip above the DAG canvas. It governs the full execution lifecycle: trigger, monitor, cancel, retry, force-unlock, configure. Every button state is deterministic — derived from a single `executionState` enum plus auxiliary signals (lock detection, API in-flight flags).

**Design principle:** An FLT engineer glances at the toolbar and knows *exactly* what they can do right now. No guessing, no disabled buttons without explanation, no silent failures.

---

## 1. Layout

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ [▸ Run DAG ▾] [⊘ Cancel] [↻ Refresh] [🔓 Force Unlock]  [⚙ Settings]  │ ● Status │
│  └─ dropdown                                                            │  + timer │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **Height:** 44px (11 × `--space-1`)
- **Background:** `var(--color-bg-secondary)` with 1px bottom border `var(--color-border)`
- **Padding:** `var(--space-2)` horizontal, centered vertically
- **Left group:** Action buttons, gap `var(--space-2)`
- **Right group:** Status indicator, pushed right with `margin-left: auto`
- **Keyboard focus:** Tab order matches visual order left-to-right

---

## 2. MLV Execution Definitions Dropdown

The Run button is a **split button**: primary click = run with current selection, caret click = open dropdown.

### 2.1 Dropdown Content

| Row | Content | Action |
|-----|---------|--------|
| ● Full DAG | Default. "Run all executable nodes" | Select → close dropdown |
| Named definitions | From `GET .../liveTable/mlvExecutionDefinitions` | Select → close dropdown |
| ─── divider | | |
| + Create new... | Opens definition creator dialog | Opens modal |

### 2.2 Data Source

```
GET /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/mlvExecutionDefinitions
→ List<MLVExecutionDefinitionResponse>
```

- **Cached:** Fetched once on DAG Studio activate, re-fetched on Refresh DAG
- **Display:** `definition.name` — truncated to 28 chars in dropdown
- **Selection persists:** Last-used definition stored in `localStorage` key `edog.dagStudio.lastDefinition`
- **No definitions:** Dropdown shows only "Full DAG" + "Create new..."

### 2.3 Selection Effect

| Selection | Run Button Label | POST Body |
|-----------|-----------------|-----------|
| Full DAG | "Run DAG" | Empty body (default full run) |
| Named definition | "Run: {name}" (truncated 18ch) | `ArtifactJobRequest` with `mlvExecutionDefinitionId` |

### 2.4 Create New Definition Dialog

**Trigger:** Click "Create new..." in dropdown

| Field | Type | Validation |
|-------|------|------------|
| Name | Text input | Required, 1–64 chars, unique |
| Description | Text area | Optional, 0–256 chars |
| Selected MLVs | Checkbox list of all nodes where `executable: true` | At least 1 selected |
| Execution Mode | Radio: Current Lakehouse / Selected Only / Full Lineage | Default: CurrentLakehouse |

**Submit:** `POST .../liveTable/mlvExecutionDefinitions` → on success, refresh dropdown, auto-select new definition.

---

## 3. Run DAG Flow

### 3.1 Preconditions

Run is enabled when `executionState` ∈ `{idle, completed, failed, cancelled}`.

### 3.2 Sequence

```
User clicks [▸ Run DAG]
  │
  ├─ 1. Generate UUID v4 (crypto.randomUUID())
  ├─ 2. Optimistic UI: set executionState → "running"
  │     • Run button: disabled, text → "Running..."
  │     • Cancel button: enabled
  │     • Status indicator: pulsing blue dot + "Running" + timer starts
  │     • Store iterationId in this._currentIterationId
  │
  ├─ 3. POST /liveTableSchedule/runDAG/{iterationId}
  │     Headers: { Authorization: Bearer {mwcToken}, Content-Type: application/json }
  │     Body: {} (Full DAG) or { mlvExecutionDefinitionId: "..." } (named definition)
  │
  ├─ 4a. 202 Accepted → Execution started
  │      • Log to console: "DAG execution started: {iterationId}"
  │      • AutoDetector will pick up status updates from log stream
  │      • History list: new row appears at top (status: Running)
  │
  └─ 4b. Error → Revert optimistic UI
         • 401/403: executionState → previous. Toast: "Authentication failed — token may be expired"
         • 404: executionState → previous. Toast: "DAG not found — refresh the DAG definition"
         • 409: executionState → previous. Toast: "Another execution is already running"
         • 429: executionState → previous. Toast: "Rate limited — wait {retryAfter}s"
         • 500: executionState → previous. Toast: "Server error — check FLT service logs"
         • Network error: executionState → previous. Toast: "Cannot reach FLT service"
```

### 3.3 Optimistic UI Details

The UI shows "Running" immediately on click — before the API responds. This eliminates the 200-800ms perceived latency of waiting for 202 Accepted.

**Revert on error:** If the POST fails, the UI snaps back to the previous state. The revert uses a saved `_previousState` captured before the optimistic transition. The timer resets to 0.

**Race condition:** If the user rapidly clicks Run, the UUID changes each time, but only the last POST proceeds (debounce via `_runInFlight` flag).

### 3.4 Timer

- **Format:** `0:00` → `0:01` → ... → `1:23` → ... → `12:07`
- **Source:** `Date.now() - runStartTime`, updated every 1000ms via `setInterval`
- **Precision:** Seconds (no milliseconds — execution durations are minutes-scale)
- **Stops:** When `executionState` transitions out of `running` / `cancelling`

---

## 4. Cancel DAG Flow

### 4.1 Preconditions

Cancel is enabled when `executionState` ∈ `{running, notStarted}`.

### 4.2 Confirmation Popover

**No accidental cancels.** Clicking Cancel shows a confirmation popover anchored below the button:

```
┌──────────────────────────────────┐
│  Cancel this DAG execution?      │
│                                  │
│  Iteration: a1b2c3d4...         │
│  Running for: 2m 14s            │
│  Nodes completed: 12/30         │
│                                  │
│  [Cancel Execution]  [Keep Running]│
└──────────────────────────────────┘
```

- **Width:** 280px
- **Background:** `var(--color-bg-elevated)` with `var(--shadow-lg)`
- **"Cancel Execution" button:** Destructive style — red background
- **"Keep Running" button:** Ghost style — default
- **Auto-dismiss:** Clicking outside or pressing Escape closes without action
- **Keyboard:** `Enter` confirms cancel (focus is on "Cancel Execution"), `Escape` dismisses

### 4.3 Sequence

```
User confirms cancel
  │
  ├─ 1. Set executionState → "cancelling"
  │     • Cancel button: disabled, text → "Cancelling..."
  │     • Status indicator: pulsing amber dot + "Cancelling..."
  │     • Run button: remains disabled
  │
  ├─ 2. GET /liveTableSchedule/cancelDAG/{iterationId}
  │     ⚠ Note: GET not POST — FLT convention
  │
  ├─ 3a. 200 OK → DagExecutionStatus returned
  │      • If "cancelled" → executionState → "cancelled"
  │      • If "cancelling" → remain in cancelling, AutoDetector will report final status
  │
  ├─ 3b. Error → Remain in cancelling state
  │      • Toast: "Cancel request failed — execution may still be running"
  │      • Do NOT revert to "running" — the cancel may have reached the server
  │      • Allow retry: re-enable Cancel button after 5s timeout
  │
  └─ 4. Cancel timeout (60s)
         • If still in "cancelling" after 60s with no status update:
         • Toast: "Cancel taking longer than expected — execution may be stuck"
         • Show "Force Unlock" option
```

### 4.4 Cancelling State Behavior

The "Cancelling" state is special — it's not idle and not running. The DAG engine needs time to gracefully stop running nodes.

- **Nodes in progress:** Continue until their current operation completes, then stop
- **Graph visual:** Running nodes transition to pulsing amber (cancelling)
- **Gantt visual:** Running bars stop growing, get amber overlay
- **Duration timer:** Continues counting (shows total wall time including cancel wait)

---

## 5. Refresh DAG Flow

### 5.1 Purpose

Re-fetch the DAG definition from the server and re-layout the graph. Used when:
- The user changed notebook code (new/removed MLVs)
- The user suspects the displayed DAG is stale
- After deploying new code to the lakehouse

### 5.2 Preconditions

Always enabled. Can be triggered during execution (non-destructive read-only operation).

### 5.3 Sequence

```
User clicks [↻ Refresh] or presses F5
  │
  ├─ 1. Button shows spinner (replace ↻ icon with 12px rotating spinner)
  │     • Button text: "Refreshing..."
  │     • Button remains clickable but debounced (no double-fetch)
  │
  ├─ 2. GET /liveTable/getLatestDag?showExtendedLineage=true
  │
  ├─ 3a. 200 OK → New DAG data received
  │      │
  │      ├─ 3a.i. Compare with current DAG
  │      │    • New nodes: highlighted briefly (green pulse, 2s)
  │      │    • Removed nodes: removed from canvas (if no execution overlay)
  │      │    • Changed edges: re-routed
  │      │    • Unchanged: preserved in place
  │      │
  │      ├─ 3a.ii. Re-layout (Sugiyama) if topology changed
  │      │    • Preserve current zoom level and pan offset
  │      │    • Animate node positions to new locations (300ms ease-out)
  │      │    • If topology unchanged (same nodes/edges): skip layout, just update data
  │      │
  │      ├─ 3a.iii. Re-fetch MLV execution definitions (cache refresh)
  │      │
  │      └─ 3a.iv. Toast: "DAG refreshed" (auto-dismiss 2s)
  │               or "DAG refreshed — 3 new nodes, 1 removed" if topology changed
  │
  └─ 3b. Error
         • 401/403: Toast: "Authentication failed"
         • 404: Toast: "DAG not found — no MLVs defined in this lakehouse?"
         • 500: Toast: "Failed to refresh DAG — FLT service error"
         • Network: Toast: "Cannot reach FLT service"
         • In all error cases: existing graph remains visible (do not clear)
```

### 5.4 Refresh During Execution

When refreshing while a DAG is running:
- The new DAG *definition* loads, but the *execution overlay* (node statuses, timing) is preserved
- If the new definition has a node not in the current execution → show as "Pending" (grey)
- If the current execution has a node not in the new definition → keep it visible with a "removed" badge (dashed border) until execution completes

---

## 6. Force Unlock Flow

### 6.1 Lock Detection

**Polling:** Every 30 seconds while DAG Studio is the active view:

```
GET /liveTableMaintanance/getLockedDAGExecutionIteration
  ⚠ URL typo is intentional — matches FLT route
```

| Response | Action |
|----------|--------|
| Empty/null | No lock. Hide Force Unlock button. |
| `List<Guid>` with entries | Lock detected. Calculate lock age from last known execution start time. |

**Lock age threshold:** Show Force Unlock button only when lock age > 5 minutes. Younger locks may be legitimate in-progress executions.

### 6.2 Force Unlock Button Visibility

- **Hidden by default** — only appears when lock detected with age > 5 min
- **Position:** Between Refresh and Settings buttons (inserted dynamically)
- **Style:** Ghost button with warning color (`var(--color-warning)`)
- **Icon:** Lock icon (🔓) — differentiates from other actions

### 6.3 Confirmation Dialog

Force Unlock is destructive. It requires a modal confirmation dialog (not just a popover):

```
┌─────────────────────────────────────────────┐
│  ⚠ Force Unlock DAG Execution               │
│                                              │
│  A DAG execution lock is preventing new runs.│
│                                              │
│  Locked Iteration: a1b2c3d4-5678-...        │
│  Lock Age: 47 minutes                       │
│                                              │
│  Force unlocking will:                       │
│  • Clear the execution lock                  │
│  • Allow new DAG runs to start               │
│  • NOT cancel any running Spark jobs         │
│                                              │
│  This is safe if the execution is stuck.     │
│  If the execution is still running, unlocking│
│  may cause concurrent execution conflicts.   │
│                                              │
│  [Force Unlock]  [Cancel]                    │
└─────────────────────────────────────────────┘
```

- **Width:** 420px
- **Modal overlay:** Semi-transparent background, click-outside does NOT dismiss (intentional — prevent accidental closure)
- **"Force Unlock" button:** Warning style (amber background)
- **Keyboard:** `Enter` confirms, `Escape` cancels

### 6.4 Sequence

```
User confirms Force Unlock
  │
  ├─ 1. Button: disabled, text → "Unlocking..."
  │
  ├─ 2. POST /liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}
  │
  ├─ 3a. 200 OK → "Force unlocked Dag"
  │      • executionState → "idle"
  │      • Hide Force Unlock button
  │      • Toast: "DAG execution lock cleared"
  │      • Re-enable Run button
  │
  └─ 3b. Error
         • 400: Toast: "No lock to clear — may have already been unlocked"
         • 401: Toast: "Insufficient permissions to force unlock"
         • 500: Toast: "Force unlock failed — try again or restart FLT service"
```

---

## 7. Settings Panel

### 7.1 Trigger

Click [⚙ Settings] button. Always enabled.

### 7.2 Panel Type

**Slide-out panel** from the right side of the toolbar area, 360px wide. Overlays the DAG graph (does not push it). Close with ✕ button or Escape.

### 7.3 Data Source

```
Load:  GET  /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/settings
Save:  PATCH /v1/workspaces/{wId}/lakehouses/{aId}/liveTable/settings
```

### 7.4 Form Fields

| Field | Type | Current Value Source | Validation | API Field |
|-------|------|---------------------|------------|-----------|
| Parallel Node Limit | Number input + slider | `settings.parallelNodeLimit` | 2–25, integer | `parallelNodeLimit` |
| Refresh Mode | Radio group | `settings.refreshMode` | "Optimal" or "Full" | `refreshMode` |
| Environment | Dropdown | `settings.environment` | List of available environments (separate API) | `environment: { environmentId, workspaceId }` |

### 7.5 Inline Editing

- **No separate edit mode.** Fields are always editable.
- **Auto-save:** Changes PATCH immediately on blur or Enter (debounced 500ms).
- **Optimistic update:** Field shows new value immediately. Revert on error.
- **Save indicator:** Small "Saved ✓" text next to changed field (fades after 2s).
- **Error indicator:** Field border turns red, "Failed to save — retry" link below.

### 7.6 Parallel Node Limit Visualization

The slider for parallel node limit (2–25) has tick marks at common values (2, 5, 10, 15, 25). The current value is reflected in the Gantt chart's parallel limit marker line.

---

## 8. Status Indicator

### 8.1 Position

Right-aligned in the toolbar. Fixed width area (~200px) to prevent layout shift.

### 8.2 States

| executionState | Dot Color | Dot Animation | Label | Suffix |
|----------------|-----------|---------------|-------|--------|
| `idle` | Grey | None | "Idle" | — |
| `notStarted` | Grey | None | "Not Started" | — |
| `running` | Blue (`var(--color-accent)`) | Pulsing (1.5s opacity cycle) | "Running" | Elapsed timer `0:00` |
| `completed` | Green (`var(--status-succeeded)`) | None | "Completed" | Duration `1m 23s` |
| `failed` | Red (`var(--status-failed)`) | None | "Failed" | Error code summary |
| `cancelled` | Amber (`var(--status-cancelled)`) | None | "Cancelled" | — |
| `cancelling` | Amber | Pulsing (1.5s) | "Cancelling..." | Elapsed timer |
| `locked` | Red | None | "Locked" | Lock age `47m ago` |

### 8.3 Dot Rendering

- **Size:** 8px circle
- **Pulse animation:** `@keyframes status-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }` at 1.5s
- **Spacing:** `var(--space-2)` between dot and label

---

## 9. Keyboard Shortcuts

| Shortcut | Action | Precondition |
|----------|--------|--------------|
| `Ctrl+Enter` | Run DAG | Run button enabled |
| `Ctrl+.` | Cancel DAG | Cancel button enabled. Opens confirmation popover, auto-focused on confirm. |
| `F5` | Refresh DAG | Always (prevents browser refresh inside DAG Studio view) |
| `Ctrl+Shift+U` | Force Unlock | Force Unlock button visible |
| `Ctrl+,` | Open/Close Settings | Always |

### 9.1 Shortcut Conflict Prevention

- `F5` is intercepted via `event.preventDefault()` only when DAG Studio is the active view. In other views, F5 behaves normally (browser refresh).
- `Ctrl+Enter` does not conflict with any browser default.
- `Ctrl+.` is not a standard browser shortcut. In VS Code it's "Quick Fix" but DAG Studio runs in the browser, not VS Code.

### 9.2 Shortcut Hints

Button tooltips include the shortcut:
- "Run DAG (Ctrl+Enter)"
- "Cancel (Ctrl+.)"
- "Refresh DAG (F5)"
- "Force Unlock (Ctrl+Shift+U)"
- "Settings (Ctrl+,)"

---

## 10. Button State Matrix

### 10.1 Complete Matrix

Every cell = button state for that (button × executionState) combination.

| Button | idle | notStarted | running | completed | failed | cancelled | cancelling | locked |
|--------|------|------------|---------|-----------|--------|-----------|------------|--------|
| **Run DAG** | ✅ Enabled (primary) | ⛔ Disabled | ⛔ Disabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ⛔ Disabled | ⛔ Disabled |
| **Cancel** | ⛔ Hidden | ✅ Enabled | ✅ Enabled | ⛔ Hidden | ⛔ Hidden | ⛔ Hidden | ⛔ Disabled (text: "Cancelling...") | ⛔ Hidden |
| **Refresh** | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled |
| **Force Unlock** | ⛔ Hidden | ⛔ Hidden | ⛔ Hidden | ⛔ Hidden | ⛔ Hidden | ⛔ Hidden | ⛔ Hidden | ✅ Visible + Enabled |
| **Settings** | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ✅ Enabled |
| **Definition ▾** | ✅ Enabled | ⛔ Disabled | ⛔ Disabled | ✅ Enabled | ✅ Enabled | ✅ Enabled | ⛔ Disabled | ⛔ Disabled |

### 10.2 Disabled Button Behavior

- **Disabled buttons** have 40% opacity, `cursor: not-allowed`, `pointer-events: none`
- **Hidden buttons** are `display: none` — do not take up space
- **Cancel visibility:** Shown only during `notStarted`, `running`, `cancelling`. Hidden otherwise.
- **Force Unlock visibility:** Shown only when lock detected with age > 5 min.

### 10.3 Button Transitions (Animated)

| Transition | Animation |
|------------|-----------|
| Run → Disabled | Fade to 40% opacity (160ms `var(--ease-standard)`) |
| Cancel appears | Slide in from left (160ms), fade in |
| Cancel disappears | Fade out (160ms), slide out |
| Force Unlock appears | Fade in with amber pulse (300ms) — draws attention |
| Force Unlock disappears | Fade out (160ms) |

---

## 11. Error Handling Summary

| Error | Source | User Impact | Recovery |
|-------|--------|-------------|----------|
| Run API 401/403 | Expired/invalid token | Toast + revert optimistic UI | Refresh token (auto or manual) |
| Run API 409 | Concurrent execution | Toast + revert | Wait for current run to finish |
| Run API 429 | Rate limiting | Toast with retry-after | Auto-retry after delay |
| Run API 500 | FLT server error | Toast + revert | Check FLT logs |
| Run network error | FLT service down | Toast + revert | Verify FLT is running |
| Cancel API error | Various | Toast, stay in cancelling | Retry after 5s or Force Unlock |
| Cancel timeout | 60s no response | Toast + suggest Force Unlock | Force Unlock button shown |
| Refresh API error | Various | Toast, keep existing graph | Retry manually |
| Force Unlock error | Various | Toast | Retry or restart FLT |
| Settings PATCH error | Various | Revert field, show error | Retry on blur |
| Lock detection error | Network/auth | Silent — do not spam toasts | Next poll in 30s |
| Definition fetch error | Various | Dropdown shows only "Full DAG" | Retry on next Refresh |

---

## 12. API Reference Summary

| Action | Method | Endpoint | Auth |
|--------|--------|----------|------|
| Run DAG | POST | `.../liveTableSchedule/runDAG/{iterationId}` | ReadAll + Execute |
| Cancel DAG | GET ⚠ | `.../liveTableSchedule/cancelDAG/{iterationId}` | Appropriate perms |
| Refresh DAG | GET | `.../liveTable/getLatestDag?showExtendedLineage=true` | ReadAll |
| Force Unlock | POST | `.../liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}` ⚠ typo | ReadAll + Execute |
| Check Lock | GET | `.../liveTableMaintanance/getLockedDAGExecutionIteration` ⚠ typo | ReadAll + Execute |
| Get Settings | GET | `.../liveTable/settings` | ReadAll |
| Update Settings | PATCH | `.../liveTable/settings` | ReadAll + Execute |
| List Definitions | GET | `.../liveTable/mlvExecutionDefinitions` | ReadAll |
| Create Definition | POST | `.../liveTable/mlvExecutionDefinitions` | ReadAll + Execute |

All endpoints share the base path: `/v1/workspaces/{workspaceId}/lakehouses/{artifactId}`

---

## 13. Accessibility

- **All buttons:** `role="button"`, `aria-label` with action + current state
- **Disabled buttons:** `aria-disabled="true"`, not `disabled` attribute (allows tooltip on hover)
- **Status indicator:** `role="status"`, `aria-live="polite"` for screen reader announcements
- **Confirmation popover:** `role="alertdialog"`, focus trapped inside, `aria-describedby` points to explanation text
- **Force Unlock modal:** `role="dialog"`, `aria-modal="true"`, focus trapped
- **Timer:** `aria-label="Elapsed time: {formatted}"`, updates every 10s for screen readers (not every 1s — too noisy)
- **Dropdown:** `role="listbox"` with `aria-activedescendant`, arrow key navigation

---

*"The toolbar is the cockpit instrument panel. Every light, every gauge, every switch must be immediately legible at a glance."*
