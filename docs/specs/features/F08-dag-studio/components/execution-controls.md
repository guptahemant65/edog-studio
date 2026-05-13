# Execution Controls — Component Spec

> **Feature:** F08 DAG Studio — Section 2.2 Execution Controls
> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Date:** 2025-07-18
> **Depends On:** `p0-foundation.md` (APIs 4–9, 15), `auto-detect.js`, `api-client.js`
> **State Matrix:** `states/execution-controls.md` (68 states, all transitions)

---

## 1. Overview

### Problem

DAG execution in FabricLiveTable requires coordinating five distinct operations — run, cancel, refresh, force-unlock, and settings — across a lifecycle with eight possible states. Without a unified toolbar, users lose track of what they can do at any moment, double-fire runs, or miss that a stale lock is blocking execution.

### Design Principle

**One toolbar, zero ambiguity.** Every button is either enabled with a clear action or hidden entirely. No disabled-but-visible buttons that taunt the user. State transitions are optimistic where safe (run) and confirmation-gated where destructive (cancel, force-unlock). The status indicator is the single source of truth for "what is happening right now."

### Scope

This spec covers the 44px execution toolbar rendered above the DAG canvas. It does NOT cover:
- The graph canvas itself (`components/graph-canvas.md`)
- Node detail panel (`components/node-detail.md`)
- Execution history list (`components/execution-history.md`)
- Gantt chart (`components/gantt-chart.md`)

---

## 2. Layout

### Toolbar Dimensions

```
Height:     44px (fixed)
Padding:    0 16px
Background: var(--color-bg-secondary)    /* #f5f5f7 */
Border:     1px solid var(--color-border) /* #e0e0e2 */  (bottom only)
Z-index:    10 (above canvas, below modals)
```

### Toolbar Anatomy

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  [▸ Run DAG ▾]   [✕ Cancel]   [↻ Refresh]   [⚿ Force Unlock]        ● Status │
│  ◀─ left group ─────────────────────────────▶           ◀─ right group ──────▶ │
│                                                                    [⚙ Settings]│
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Spacing Tokens

| Gap | Value | Between |
|-----|-------|---------|
| Button gap (left group) | `8px` | Between Run, Cancel, Refresh, Force Unlock |
| Group separator | `flex-grow: 1` | Between left group and right group |
| Status-to-Settings gap | `12px` | Between status indicator and settings gear |
| Button internal padding | `8px 14px` | Icon + label inside each button |
| Dropdown caret padding | `0 6px` | Caret separator within Run DAG split button |

### CSS Structure

```css
.dag-toolbar {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 16px;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  gap: 8px;
}

.dag-toolbar__left  { display: flex; align-items: center; gap: 8px; }
.dag-toolbar__right { display: flex; align-items: center; gap: 12px; margin-left: auto; }
```

---

## 3. MLV Execution Definitions Dropdown

The Run DAG button is a **split button**: clicking the main area triggers the default action; clicking the caret (▾) opens a dropdown to select an execution definition.

### Dropdown Items

| # | Label | Source | Behavior |
|---|-------|--------|----------|
| 1 | **Full DAG** | Hardcoded | Default. `ExecutionMode.CurrentLakehouse`. No body payload — all MLVs in current lakehouse execute. |
| 2 | *{Named Definition}* | `GET /liveTable/mlvExecutionDefinitions` | One entry per saved definition. `ExecutionMode.SelectedOnly` with `mlvExecutionDefinitionId` query param. Label = `definition.displayName`. |
| 3 | **Run Selected Node** | Contextual | Visible only when a node is selected in the graph canvas. `ExecutionMode.SelectedOnly` with `selectedMLVs: [selectedNode.nodeId]`. Label includes node name: "Run Selected: {nodeName}". |
| 4 | ── separator ── | — | Visual divider. |
| 5 | **Create New Definition...** | Action | Opens a modal to create a new `MLVExecutionDefinition` via `POST /liveTable/mlvExecutionDefinitions`. |

### Dropdown Behavior

- **Max height:** `320px` with overflow scroll for long definition lists.
- **Width:** `min(280px, toolbar-width - 32px)`.
- **Selected item:** Checkmark (✓) prefix on the currently active definition.
- **Keyboard:** Arrow keys navigate, Enter selects, Escape closes.
- **Empty state:** If `listMlvDefinitions()` returns empty, only "Full DAG" and "Create New Definition..." appear.
- **Loading state:** Spinner replaces definition list while `listMlvDefinitions()` is in flight. Definitions are fetched once on DAG Studio activation and cached until view deactivation.

### Run Button Label Updates

When a definition is selected, the Run button label changes:

| Selection | Button Label |
|-----------|-------------|
| Full DAG | `▸ Run DAG` |
| Named definition | `▸ Run: {defName}` |
| Run Selected Node | `▸ Run: {nodeName}` |

Label is truncated with ellipsis at `180px` max-width.

### API: List Definitions

```
GET /liveTable/mlvExecutionDefinitions
→ 200: List<MLVExecDefResponse>

Response shape:
{
  id: Guid,
  displayName: string,
  selectedMLVs: Guid[],
  executionMode: "SelectedOnly",
  createdAt: ISO8601,
  modifiedAt: ISO8601
}
```

### API: Create Definition

```
POST /liveTable/mlvExecutionDefinitions
Body: { displayName: string, selectedMLVs: Guid[] }
→ 201: MLVExecDefResponse
```

---

## 4. Run DAG Flow

### Preconditions

All must be true before the Run button is enabled:

| # | Condition | How Checked |
|---|-----------|-------------|
| 1 | DAG loaded successfully | `_dagLoaded === true` |
| 2 | Not currently executing | `_executionState` ∉ `{running, cancelling}` |
| 3 | No in-flight run request | `_runInFlight === false` |
| 4 | No active lock detected | `_lockDetected === false` |

### Sequence

```
User clicks [▸ Run DAG]  (or Ctrl+Enter)
  │
  ├─ 1. Guard: check preconditions → abort if any fail
  ├─ 2. Generate iterationId = crypto.randomUUID()
  ├─ 3. Set _runInFlight = true
  ├─ 4. OPTIMISTIC UI (immediate, before API responds):
  │     ├─ Run button: disabled, label → "Running...", opacity 40%
  │     ├─ Cancel button: slides in (160ms ease-out), enabled
  │     ├─ Dropdown caret: disabled
  │     ├─ Status indicator: pulsing accent dot + "Running" + timer starts
  │     └─ Timer: starts at 0:00, increments every 1s via setInterval
  │
  ├─ 5. Build request body (depends on selected definition):
  │     ├─ Full DAG: no query param, no body
  │     ├─ Named def: ?mlvExecutionDefinitionId={defId}
  │     └─ Selected node: body = { executionMode: "SelectedOnly", selectedMLVs: [nodeId] }
  │
  ├─ 6. POST /liveTableSchedule/runDAG/{iterationId}
  │     ├─ 202 Accepted → store iterationId, keep optimistic state
  │     └─ Error → REVERT optimistic UI:
  │           ├─ Run button: re-enabled, label restored
  │           ├─ Cancel button: slides out
  │           ├─ Status: previous state restored
  │           ├─ Timer: cleared
  │           └─ Toast: "Run failed: {error.message}"
  │
  └─ 7. Set _runInFlight = false
```

### Timer Display

- Format: `M:SS` for < 60 minutes, `H:MM:SS` for ≥ 60 minutes.
- Font: `var(--font-mono)`, `font-size: 12px`, `color: var(--color-text-secondary)`.
- Positioned inline after the status text: `● Running  1:23`.
- Timer is driven by `setInterval(1000)`. Reference time is `performance.now()` at run start to avoid drift.
- Timer freezes on terminal state (completed/failed/cancelled) showing final duration from `DagTerminal.durationMs`.

### Double-Click Prevention

The `_runInFlight` flag is set synchronously before the API call and cleared in the `finally` block. The Run button checks this flag in its click handler and returns early if set.

---

## 5. Cancel DAG Flow

### Confirmation Popover

Cancellation is destructive — it cannot be undone. A confirmation popover appears anchored below the Cancel button.

```
┌──────────────────────────────────────┐
│  Cancel running execution?           │
│                                      │
│  This will cancel all nodes that     │
│  haven't completed yet. Completed    │
│  nodes are not rolled back.          │
│                                      │
│  Iteration: {iterationId (short)}    │
│                                      │
│         [No, keep running]  [Cancel] │
└──────────────────────────────────────┘
```

- **Popover width:** `320px`.
- **Iteration ID display:** First 8 chars of UUID, monospaced, `color: var(--color-text-tertiary)`.
- **"Cancel" button:** `background: var(--status-failed)` (red), white text.
- **"No, keep running":** Ghost button, `color: var(--color-text-secondary)`.
- **Dismiss:** Clicking outside closes popover without action. Escape key closes.
- **Keyboard:** Tab cycles between buttons. Enter activates focused button.

### Sequence

```
User clicks [✕ Cancel]
  │
  ├─ 1. Show confirmation popover
  │
  ├─ 2. User confirms → popover closes
  │     ├─ Cancel button: disabled, label → "Cancelling..."
  │     ├─ Run button: remains disabled
  │     ├─ Status: amber dot + "Cancelling..." (pulsing)
  │     └─ Timer: continues running (cancel takes time)
  │
  ├─ 3. DELETE /liveTableSchedule/cancelDAG/{iterationId}
  │     ├─ 200 → wait for DagTerminal SignalR event with status=cancelled
  │     │        Timeout: 30 seconds. If no DagTerminal received:
  │     │        └─ Toast: "Cancel confirmed but status unknown. Refreshing..."
  │     │           → auto-trigger refresh
  │     └─ Error → Toast: "Cancel failed: {error.message}"
  │                Cancel button: re-enabled
  │                Status: remains "Running" (cancel failed, execution continues)
  │
  └─ 4. On DagTerminal(status=cancelled):
        ├─ Cancel button: slides out (160ms)
        ├─ Run button: re-enabled
        ├─ Status: solid amber dot + "Cancelled"
        ├─ Timer: freezes at final duration from DagTerminal.durationMs
        └─ _executionState = 'cancelled'
```

### Hard Constraint

There is **no single-node cancel**. The `cancelDAG` endpoint cancels the entire DAG execution. Nodes that have already completed retain their results. Nodes in `running` state transition to `cancelled`. Nodes in `none` (not yet started) transition to `skipped`.

---

## 6. Refresh DAG Flow

### Triggers

| Trigger | Source |
|---------|--------|
| Click [↻ Refresh] button | User action |
| Press `F5` | Keyboard shortcut |
| Auto-refresh after cancel timeout | System (see §5) |
| Post-run if topology changed | Auto-detector signal |

### Sequence

```
Refresh triggered
  │
  ├─ 1. Refresh button: spinner icon replaces ↻, disabled
  │
  ├─ 2. GET /liveTable/getLatestDag?showExtendedLineage=true
  │     ├─ 200 → compare node count + edge count with current DAG
  │     │   ├─ No change: silent success, restore button
  │     │   └─ Topology changed:
  │     │       ├─ Graph canvas: re-layout with new topology
  │     │       ├─ Toast: "DAG updated: {added} nodes added, {removed} removed"
  │     │       └─ If execution is active: node states preserved for existing nodeIds,
  │     │          new nodes show as "none" (grey dot)
  │     └─ Error → Toast: "Refresh failed: {error.message}"
  │              Restore button to enabled state
  │
  └─ 3. Refresh button: ↻ icon restored, enabled
```

### F5 Conflict Prevention

The `F5` shortcut is intercepted via `keydown` listener with `e.preventDefault()` to prevent browser page reload. This listener is **only active when DAG Studio view is visible**. When another view is active, `F5` behaves as normal browser refresh.

---

## 7. Force Unlock Flow

### Lock Detection

A background poller runs while DAG Studio is active:

```
Interval: 30 seconds
API:      GET /liveTableMaintanance/getLockedDAGExecutionIteration
          (note: "Maintanance" typo is the real FLT route)

Response:
  - null / empty → no lock, hide Force Unlock button
  - Guid         → lock detected, show Force Unlock button
  - List<Guid>   → multiple locks (rare), use first entry
```

The poller starts on DAG Studio activation and stops on deactivation. It does NOT run during active execution (redundant — we already know the lock state).

### Lock Age Calculation

Lock age is derived from the locked iteration's `startedAt` timestamp (from `getDagExecMetrics` if available) compared to `Date.now()`. Displayed as:
- `< 1h` → "Locked for {M} minutes"
- `≥ 1h` → "Locked for {H}h {M}m"
- Unknown age → "Locked (age unknown)"

### Confirmation Dialog

Force unlock is dangerous — it can corrupt a legitimately running execution. A modal dialog (not popover) is used:

```
┌──────────────────────────────────────────────┐
│  ◆ Force Unlock DAG Execution                │
│                                              │
│  A lock is preventing new executions.        │
│  This may indicate a stuck or orphaned run.  │
│                                              │
│  Locked iteration: {iterationId (short)}     │
│  Lock age: {formatted duration}              │
│                                              │
│  ⚠ If an execution is genuinely running,     │
│  force-unlocking may leave it in an          │
│  inconsistent state.                         │
│                                              │
│       [Cancel]            [Force Unlock]     │
└──────────────────────────────────────────────┘
```

- **Dialog width:** `420px`, centered.
- **Backdrop:** `rgba(0, 0, 0, 0.3)`.
- **"Force Unlock" button:** `background: var(--status-cancelled)` (amber), dark text.
- **"Cancel" button:** Ghost style.
- **Warning icon (⚠):** `color: var(--status-cancelled)`.

### Sequence

```
User clicks [⚿ Force Unlock]
  │
  ├─ 1. Show confirmation dialog
  │
  ├─ 2. User confirms
  │     ├─ Dialog closes
  │     ├─ Force Unlock button: disabled, label → "Unlocking..."
  │     └─ Toast: "Unlocking execution..."
  │
  ├─ 3. POST /liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}
  │     (note: "Maintanance" typo is the real FLT route)
  │     ├─ 200 → "Force unlocked Dag"
  │     │   ├─ Force Unlock button: slides out (160ms)
  │     │   ├─ Toast: "Execution unlocked successfully"
  │     │   ├─ _lockDetected = false
  │     │   └─ Auto-refresh DAG (trigger §6 flow)
  │     └─ Error → Toast: "Unlock failed: {error.message}"
  │              Force Unlock button: re-enabled
  │
  └─ 4. Resume lock detection polling
```

---

## 8. Settings Panel

### Trigger

Click the [⚙] gear icon in the toolbar right group, or press `Ctrl+,`.

### Layout

A slide-out panel from the right edge, overlaying the graph canvas:

```
Width:      360px
Animation:  slide from right, 200ms ease-out
Background: var(--color-bg)
Border:     1px solid var(--color-border) (left edge)
Shadow:     -4px 0 12px rgba(0,0,0,0.06)
Z-index:    20 (above toolbar)
```

### Settings Fields

| Field | Control | Range | Default | API Field |
|-------|---------|-------|---------|-----------|
| Parallel Node Limit | Numeric stepper | 2–25 | Server value | `parallelNodeLimit` |
| Refresh Mode | Radio group | Optimal · Full | Server value | `refreshMode` |

### Parallel Node Limit

- **Stepper UI:** `[−]  {value}  [+]` with direct text input.
- **Validation:** Integer, min 2, max 25. Values outside range snap to nearest bound on blur.
- **Display:** Current value in monospaced font, centered between buttons.

### Refresh Mode

- **Optimal:** Refreshes only nodes whose dependencies have changed. Default for most scenarios.
- **Full:** Refreshes all nodes regardless of dependency state. Use for debugging or after schema changes.

### Auto-Save Behavior

Settings are persisted automatically with debounce:

```
User changes a value
  │
  ├─ 1. Update local state immediately (optimistic)
  ├─ 2. Start 800ms debounce timer
  │     (subsequent changes reset the timer)
  ├─ 3. After 800ms of no changes:
  │     PATCH /liveTable/settings
  │     Body: { parallelNodeLimit: N, refreshMode: "Optimal"|"Full" }
  │     ├─ 200 → subtle "Saved" indicator (check mark, fades after 2s)
  │     └─ Error → revert to server value, toast: "Settings save failed"
  └─ 4. No explicit Save button
```

### Loading State

On panel open, current settings are fetched:

```
GET /liveTable/settings
→ 200: { parallelNodeLimit: number, refreshMode: string, ... }
```

Skeleton placeholders (two grey bars) shown during fetch. Fields are non-interactive until loaded.

### Close Behavior

- Click the ✕ button in panel header.
- Press `Escape`.
- Click outside the panel (on the canvas area).
- No unsaved-changes warning — auto-save handles persistence.

---

## 9. Status Indicator

### Anatomy

```
[●] {Status Text}  {Duration}
```

- **Dot:** 8px circle, `border-radius: 50%`.
- **Status text:** `font-size: 13px`, `font-weight: 500`, `color: var(--color-text)`.
- **Duration:** `font-size: 12px`, `font-family: var(--font-mono)`, `color: var(--color-text-secondary)`.
- **Gap:** 6px between dot and text, 8px between text and duration.

### State Map

| Execution State | Dot Color | Dot Animation | Status Text | Duration | Tooltip |
|-----------------|-----------|---------------|-------------|----------|---------|
| `idle` | `var(--status-pending)` | none | "Idle" | — | "No execution in progress" |
| `running` | `var(--accent)` | pulse (opacity 0.4→1, 1.5s ease-in-out infinite) | "Running" | Live timer `M:SS` | "Execution in progress since {startTime}" |
| `completed` | `var(--status-succeeded)` | none | "Completed" | Frozen `M:SS` | "Completed in {durationMs}ms — {completedNodes}/{totalNodes} nodes" |
| `failed` | `var(--status-failed)` | none | "Failed" | Frozen `M:SS` | "{errorCode}: {errorMessage}" |
| `cancelled` | `var(--status-cancelled)` | none | "Cancelled" | Frozen `M:SS` | "Cancelled — {completedNodes} completed, {skippedNodes} skipped" |
| `cancelling` | `var(--status-cancelled)` | pulse | "Cancelling..." | Live timer | "Cancel request sent, waiting for nodes to stop" |
| `loading` | `var(--status-pending)` | pulse | "Loading DAG..." | — | "Fetching DAG topology" |
| `error` | `var(--status-failed)` | none | "DAG load failed" | — | "{error.message}" |

### Pulse Animation

```css
@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

.dag-status__dot--pulsing {
  animation: status-pulse 1.5s ease-in-out infinite;
}
```

---

## 10. Keyboard Shortcuts

### Shortcut Table

| Key | Action | Guard | Conflict Prevention |
|-----|--------|-------|---------------------|
| `Ctrl+Enter` | Run DAG (default definition) | Same as Run button preconditions (§4) | None — not a browser default |
| `Escape` | Close settings panel / dismiss popover / deselect node | Priority: popover → settings → selection | Standard dismiss key |
| `F5` | Refresh DAG | DAG Studio view must be active | `e.preventDefault()` blocks browser refresh |
| `Ctrl+,` | Toggle settings panel | Always available | Mirrors VS Code convention |
| `Ctrl+Shift+C` | Cancel DAG (opens confirmation) | Execution must be running | Avoids `Ctrl+C` (copy) collision |

### Implementation

```javascript
_onKeyDown(e) {
  if (!this._isActive) return; // DAG Studio not visible

  if (e.key === 'F5') {
    e.preventDefault();
    this._refreshDag();
  }
  if (e.ctrlKey && e.key === 'Enter') {
    this._runDag();
  }
  if (e.ctrlKey && e.key === ',') {
    e.preventDefault();
    this._toggleSettings();
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    this._showCancelConfirmation();
  }
  if (e.key === 'Escape') {
    if (this._popoverOpen) this._dismissPopover();
    else if (this._settingsOpen) this._closeSettings();
    else this._deselectNode();
  }
}
```

The listener is added on `activate()` and removed on `deactivate()` to prevent shortcut leakage to other views.

---

## 11. Button State Matrix

Complete grid showing every button's state for each execution phase.

### Legend

| Symbol | Meaning |
|--------|---------|
| ✓ | Visible and enabled |
| ✗ | Hidden (not rendered) |
| ○ | Visible but disabled (greyed, `opacity: 0.4`, no pointer events) |
| ◆ | Visible with modified appearance (label/style change) |

### Matrix

| Execution State | ▸ Run DAG | ▾ Caret | ✕ Cancel | ↻ Refresh | ⚿ Force Unlock | ⚙ Settings |
|-----------------|-----------|---------|----------|-----------|-----------------|------------|
| `idle` | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ |
| `idle` + lock detected | ○ | ○ | ✗ | ✓ | ✓ | ✓ |
| `loading` (DAG fetch) | ○ | ○ | ✗ | ◆ spinner | ✗ | ✓ |
| `running` | ○ "Running..." | ○ | ✓ | ○ | ✗ | ✓ |
| `cancelling` | ○ | ○ | ◆ "Cancelling..." ○ | ○ | ✗ | ✓ |
| `completed` | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ |
| `failed` | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ |
| `cancelled` | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ |
| `error` (DAG load fail) | ○ | ○ | ✗ | ✓ | ✗ | ✓ |

### Transition Animations

| Transition | Animation |
|------------|-----------|
| Cancel button appears | `slide-in-left 160ms ease-out` |
| Cancel button disappears | `slide-out-left 160ms ease-in` |
| Force Unlock appears | `fade-in 200ms ease-out` |
| Force Unlock disappears | `fade-out 160ms ease-in` |
| Status dot color change | `background-color 300ms ease` |
| Run button label change | Instant (no animation on text) |

---

## 12. Error Handling Summary

| Error Scenario | Source | User Impact | Recovery |
|----------------|--------|-------------|----------|
| Run DAG — 409 Conflict | `POST runDAG` | Execution already in progress | Toast: "An execution is already running." Revert optimistic UI. Auto-refresh status. |
| Run DAG — 423 Locked | `POST runDAG` | DAG locked by another execution | Toast: "DAG is locked. Use Force Unlock if the lock is stale." Show Force Unlock button. |
| Run DAG — 500 Server Error | `POST runDAG` | Unknown server failure | Toast: "Run failed: {message}". Revert optimistic UI. Log error to console. |
| Run DAG — Network Error | `POST runDAG` | Connectivity issue | Toast: "Network error. Check connection and retry." Revert optimistic UI. |
| Cancel DAG — 404 Not Found | `DELETE cancelDAG` | Iteration already terminated | Toast: "Execution already finished." Auto-refresh to get final state. |
| Cancel DAG — 500 | `DELETE cancelDAG` | Cancel failed | Toast: "Cancel failed: {message}". Cancel button re-enabled. Execution continues. |
| Refresh — 500 | `GET getLatestDag` | Cannot fetch topology | Toast: "Refresh failed: {message}". Refresh button re-enabled. Stale DAG remains visible. |
| Force Unlock — 404 | `POST forceUnlockDAG` | No lock to unlock | Toast: "No active lock found." Hide Force Unlock button. |
| Force Unlock — 500 | `POST forceUnlockDAG` | Unlock failed | Toast: "Unlock failed: {message}". Force Unlock button re-enabled. |
| Settings — PATCH 400 | `PATCH settings` | Invalid value rejected | Revert field to server value. Toast: "Invalid setting: {message}". |
| Settings — PATCH 500 | `PATCH settings` | Save failed | Revert field to server value. Toast: "Settings save failed". |
| Lock poll — any error | `GET getLockedIteration` | Non-critical | Silent failure. Log to console. Retry on next poll interval. |
| Definitions — 500 | `GET mlvExecutionDefinitions` | Cannot load definitions | Dropdown shows only "Full DAG". Toast: "Could not load definitions." |
| SignalR disconnect | Connection lost | No real-time updates | Status indicator shows ◆ warning icon. Fallback to 5s polling via `getDagExecMetrics`. Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s). |

---

## 13. Real-time Updates — SignalR Events

All four SignalR events flow through the `DagStudio` orchestrator, which updates the toolbar and graph canvas in a single render pass.

### NodeStarted

```
Event:   NodeStarted
Payload: { nodeId: Guid, dagId: Guid, iterationId: Guid, timestamp: ISO8601 }

Toolbar effect:
  - No toolbar change (status already "Running")
  - Pass to graph canvas: node dot → pulsing accent
```

### NodeCompleted

```
Event:   NodeCompleted
Payload: { nodeId: Guid, dagId: Guid, iterationId: Guid, durationMs: number }

Toolbar effect:
  - No toolbar change
  - Pass to graph canvas: node dot → solid green (--status-succeeded)
  - Pass to gantt chart: bar extends to completion
```

### NodeFailed

```
Event:   NodeFailed
Payload: { nodeId: Guid, dagId: Guid, iterationId: Guid,
           durationMs: number, errorType: string, errorMessage: string }

Toolbar effect:
  - No toolbar change (DAG still running — other nodes may continue)
  - Pass to graph canvas: node dot → solid red (--status-failed)
  - If node detail panel is open for this node: show error inline
```

### DagTerminal

```
Event:   DagTerminal
Payload: { dagId: Guid, iterationId: Guid, status: DagExecutionStatus,
           totalNodes: number, completedNodes: number,
           failedNodes: number, skippedNodes: number,
           parallelLimit: number, durationMs: number,
           errorCode: string?, errorMessage: string? }

Toolbar effect (depends on status field):

  status = "completed":
    - _executionState = 'completed'
    - Status dot: solid green (--status-succeeded)
    - Status text: "Completed"
    - Timer: freeze at durationMs (formatted)
    - Cancel button: slide out
    - Run button: re-enabled

  status = "failed":
    - _executionState = 'failed'
    - Status dot: solid red (--status-failed)
    - Status text: "Failed"
    - Timer: freeze at durationMs
    - Tooltip: "{errorCode}: {errorMessage}"
    - Cancel button: slide out
    - Run button: re-enabled

  status = "cancelled":
    - _executionState = 'cancelled'
    - Status dot: solid amber (--status-cancelled)
    - Status text: "Cancelled"
    - Timer: freeze at durationMs
    - Cancel button: slide out
    - Run button: re-enabled
```

### Iteration ID Matching

Events are matched by `iterationId`. If an event arrives for an iteration ID that doesn't match the current `_activeIterationId`, it is **silently discarded**. This prevents stale events from a previous run from corrupting the current UI state.

---

## 14. API Reference Summary

| Method | Verb | Endpoint | Response | Notes |
|--------|------|----------|----------|-------|
| `runDag` | `POST` | `/liveTableSchedule/runDAG/{iterationId}` | `202 Accepted` | Optional query: `?mlvExecutionDefinitionId={id}`. Optional body for `SelectedOnly` mode. |
| `cancelDag` | `DELETE` | `/liveTableSchedule/cancelDAG/{iterationId}` | `200: DagExecutionStatus` | **DELETE not GET.** Previous documentation was incorrect. |
| `getLatestDag` | `GET` | `/liveTable/getLatestDag?showExtendedLineage=true` | `Dag` | Returns full topology with nodes, edges, warnings. |
| `getDagExecMetrics` | `GET` | `/liveTableSchedule/getDagExecMetrics/{iterationId}` | `DagExecutionInstance` | Polling fallback when SignalR is disconnected. |
| `getLockedExecution` | `GET` | `/liveTableMaintanance/getLockedDAGExecutionIteration` | `string\|List<Guid>` | Typo in URL ("Maintanance") is the real FLT route. |
| `forceUnlockDag` | `POST` | `/liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}` | `string` | Returns "Force unlocked Dag". Typo in URL is real. |
| `getSettings` | `GET` | `/liveTable/settings` | `Settings` | `{ parallelNodeLimit, refreshMode, ... }` |
| `updateSettings` | `PATCH` | `/liveTable/settings` | `Settings` | Partial update — send only changed fields. |
| `listMlvDefinitions` | `GET` | `/liveTable/mlvExecutionDefinitions` | `List<MLVExecDefResponse>` | Named execution subsets. |
| `createMlvDefinition` | `POST` | `/liveTable/mlvExecutionDefinitions` | `MLVExecDefResponse` | Body: `{ displayName, selectedMLVs }`. |

---

## 15. Accessibility

### ARIA Attributes

| Element | Role | ARIA | Notes |
|---------|------|------|-------|
| Toolbar container | `role="toolbar"` | `aria-label="DAG execution controls"` | Arrow keys navigate between buttons per WAI-ARIA toolbar pattern |
| Run DAG button | `role="button"` | `aria-haspopup="menu"` on caret | Split button pattern: main action + menu trigger |
| Dropdown menu | `role="menu"` | `aria-labelledby="{runButtonId}"` | Items have `role="menuitemradio"` with `aria-checked` |
| Cancel button | `role="button"` | `aria-describedby="{confirmPopoverId}"` when popover open | Described-by links to confirmation content |
| Status indicator | `role="status"` | `aria-live="polite"`, `aria-atomic="true"` | Screen readers announce state changes without interrupting |
| Settings panel | `role="dialog"` | `aria-label="DAG execution settings"`, `aria-modal="true"` | Focus trapped while open |
| Force Unlock dialog | `role="alertdialog"` | `aria-describedby="{warningTextId}"` | `alertdialog` for destructive confirmation |

### Focus Management

- **Settings open:** Focus moves to first interactive element (Parallel Node Limit stepper). On close, focus returns to ⚙ button.
- **Popover open:** Focus moves to "No, keep running" button (safe default). On close, focus returns to Cancel button.
- **Dialog open:** Focus moves to "Cancel" button (safe default). On close, focus returns to Force Unlock button.
- **Dropdown open:** Focus moves to currently selected item. Arrow keys navigate. On close, focus returns to caret.

### Keyboard Navigation

- **Tab order within toolbar:** Run → Caret → Cancel → Refresh → Force Unlock → Status (informational, skipped) → Settings.
- **Arrow keys within toolbar:** Left/Right move between visible buttons (per `role="toolbar"` pattern).
- **Hidden buttons are removed from tab order** (`tabindex="-1"` or not rendered).

### Screen Reader Announcements

| Event | Announcement (via `aria-live` region) |
|-------|--------------------------------------|
| Run started | "DAG execution started" |
| Run failed to start | "DAG execution failed to start: {reason}" |
| Execution completed | "DAG execution completed in {duration}" |
| Execution failed | "DAG execution failed: {errorCode}" |
| Execution cancelled | "DAG execution cancelled" |
| Lock detected | "DAG execution locked. Force unlock available." |
| Settings saved | "Settings saved" |

---

## 16. Performance Budgets

| Metric | Budget | How Enforced |
|--------|--------|--------------|
| Toolbar initial render | < 16ms | Single DOM pass. No layout thrashing. Buttons are plain `<button>` elements, no framework overhead. |
| Optimistic state transition | < 8ms | Synchronous class toggles. No forced reflow between read/write. |
| Status update from SignalR | < 4ms | Direct property mutation on status element. No re-render of entire toolbar. |
| Settings panel open animation | 200ms | CSS `transform: translateX()` — compositor-only, no main-thread paint. |
| Cancel button slide-in | 160ms | CSS `transform: translateX()` — compositor-only. |
| Timer update (1s interval) | < 1ms | Single `textContent` write to timer element. |
| Dropdown render (20 definitions) | < 8ms | Static list, no virtualization needed at this scale. |
| Lock poll (30s interval) | < 2ms overhead | Non-blocking `fetch`. Response parsed, boolean flag set. |
| Memory: toolbar DOM nodes | < 40 nodes | Flat structure. No nested component trees. |

---

## 17. Open Questions

None. All execution control behaviors are fully specified by the FLT source code, the state matrix (68 states), and this component spec. If implementation reveals edge cases not covered here, file them against the state matrix document.

---

> *"The toolbar is the cockpit. Every switch, every light, every gauge — the pilot must know what it does without reading a manual. If they have to think, we failed."*
> — Sana Reeves, Architecture Review, 2025-07-18