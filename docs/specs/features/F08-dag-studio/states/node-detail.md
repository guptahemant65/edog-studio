# Node Detail Panel — State Matrix

> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Component Spec:** `../components/node-detail.md`
> **Total States:** 16

---

## 1. State Diagram

```
                       +----------+
                       |  closed  |<---- Escape / click empty / close button
                       +----+-----+
                            | click node (graph or Gantt)
                            v
                       +----------+
                       | opening  | (160ms slide-in animation)
                       +----+-----+
                            | transitionend
                +-----------+-----------+
                v           v           v
          +----------+ +----------+ +----------+
          |  open.   | |  open.   | |  open.   |   ... (5 tabs)
          | overview | | metrics  | |  logs    |
          +----------+ +----------+ +----------+
                |           |           |
                +-----------+-----------+
                            |
                            v
                       +----------+
                       | closing  | (160ms slide-out)
                       +----+-----+
                            |
                            v
                       +----------+
                       |  closed  |
                       +----------+

Cross-cutting states (combine with any open.* state):
  +----------------+  +----------------+  +---------------+
  | node.switching |  |   resizing     |  |  open.error   |
  +----------------+  +----------------+  +---------------+
```

---

## 2. Component States

### 2.1 Lifecycle States (mutually exclusive)

| State | Description |
|-------|-------------|
| `closed` | Panel not visible, `aria-hidden="true"` |
| `opening` | Slide-in animation in progress (160ms) |
| `open` | Panel visible and interactive |
| `closing` | Slide-out animation in progress (160ms) |

### 2.2 Tab States (mutually exclusive, active only when `open`)

| State | Description |
|-------|-------------|
| `open.overview` | Overview tab active (default on open) |
| `open.metrics` | Metrics tab active |
| `open.logs` | Logs tab active |
| `open.code` | Code tab active |
| `open.deps` | Dependencies tab active |

### 2.3 Content Sub-States

| State | Parent | Description |
|-------|--------|-------------|
| `open.logs.empty` | `open.logs` | No execution data yet |
| `open.logs.loading` | `open.logs` | Fetching log data |
| `open.logs.populated` | `open.logs` | Log data displayed |
| `open.code.unavailable` | `open.code` | Code reference is null |

### 2.4 Cross-Cutting States (can combine with any `open.*`)

| State | Description |
|-------|-------------|
| `node.switching` | Panel content transitioning to a different node (brief flash, ~50ms) |
| `resizing` | User dragging the resize handle |
| `open.error` | Error loading node data |

---

## 3. State x Action Matrix

### 3.1 Lifecycle Transitions

| Current | Click Node | Click Close | Escape | Click Empty Canvas | Animation End |
|---------|-----------|-------------|--------|-------------------|---------------|
| `closed` | `opening` | — | — | — | — |
| `opening` | Queue node switch | — | `closing` | `closing` | `open.overview` |
| `open.*` | `node.switching` (then same tab) | `closing` | `closing` | `closing` | — |
| `closing` | `opening` (re-open) | — | — | — | `closed` |

### 3.2 Tab Transitions (when `open`)

| Current Tab | Click Overview | Click Metrics | Click Logs | Click Code | Click Deps | Key 1 | Key 2 | Key 3 | Key 4 | Key 5 |
|-------------|---------------|---------------|------------|------------|------------|-------|-------|-------|-------|-------|
| `open.overview` | — | `open.metrics` | `open.logs` | `open.code` | `open.deps` | — | `open.metrics` | `open.logs` | `open.code` | `open.deps` |
| `open.metrics` | `open.overview` | — | `open.logs` | `open.code` | `open.deps` | `open.overview` | — | `open.logs` | `open.code` | `open.deps` |
| `open.logs` | `open.overview` | `open.metrics` | — | `open.code` | `open.deps` | `open.overview` | `open.metrics` | — | `open.code` | `open.deps` |
| `open.code` | `open.overview` | `open.metrics` | `open.logs` | — | `open.deps` | `open.overview` | `open.metrics` | `open.logs` | — | `open.deps` |
| `open.deps` | `open.overview` | `open.metrics` | `open.logs` | `open.code` | — | `open.overview` | `open.metrics` | `open.logs` | `open.code` | — |

---

## 4. FLT <-> UI State Mapping

### 4.1 Node Execution Status -> Panel Display

| FLT NodeExecutionStatus | Status Badge | Overview Content | Actions |
|------------------------|--------------|------------------|---------|
| `None` | ● Grey (`var(--status-pending)`) | "Not yet executed" | "Run This Node" enabled (if executable) |
| `Running` | ● Purple pulse (`var(--accent)`) | "Execution in progress...", live duration counter | "Run This Node" disabled |
| `Completed` | ● Green (`var(--status-succeeded)`) | Duration, row counts, DQ results | "Run This Node" enabled |
| `Failed` | ● Red (`var(--status-failed)`) | Error banner with ErrorCode + ErrorMessage | "Run This Node" enabled (retry) |
| `Cancelled` | ● Amber (`var(--status-cancelled)`) | "Execution was cancelled" | "Run This Node" enabled |
| `Skipped` | ● Grey (`var(--status-pending)`) | "Skipped (upstream dependency failed/cancelled)" | "Run This Node" enabled |
| `Cancelling` | ● Amber pulse (`var(--status-cancelled)`) | "Cancellation in progress..." | "Run This Node" disabled |

### 4.2 Node Properties -> Action Availability

| Condition | "Run This Node" | Reason |
|-----------|-----------------|--------|
| `Executable = true` | Enabled | MLV, local, not shortcut |
| `Executable = false` | Disabled | Not a materialized lake view |
| `ExternalWorkspaceId != null` | Disabled | External nodes cannot be executed |
| `IsShortcut = true` | Disabled | Shortcut tables are read-only |
| `TableType = MANAGED` | Disabled | Source tables are not executable |
| Execution currently Running | Disabled | Cannot start while in progress |

### 4.3 IsFaulted -> Error Display

| `IsFaulted` | `FLTErrorCode` | Display |
|-------------|----------------|---------|
| `false` | null | No error |
| `true` | non-null | Red banner: "Pre-execution error: {FLTErrorCode}" |
| `true` | null | Red banner: "Node is in faulted state" |

---

## 5. Transition Rules

### 5.1 Panel Open

1. User clicks node in graph canvas or Gantt chart
2. If panel is `closed`: transition to `opening`, start 160ms slide-in
3. If panel is already `open` with different node: transition to `node.switching`
4. If panel is already `open` with same node: no-op
5. On `transitionend`: set state to `open.overview`, populate data, set focus

### 5.2 Node Switching

When panel is open and user clicks a different node:

1. Current tab is preserved (if user was on Metrics tab, stay on Metrics)
2. Brief opacity flash (100ms fade to 0.6, then back to 1.0) to indicate content change
3. Content replaced with new node data
4. If current tab has no content for new node (e.g., Code tab for SQL node): show appropriate empty state
5. Panel does NOT close and reopen — content swaps in place

### 5.3 Panel Close

1. Trigger: `Escape`, close button click, or click on empty canvas
2. Start 160ms slide-out animation
3. On `transitionend`: set `aria-hidden="true"`, return focus to graph canvas
4. Canvas resizes to fill recovered space

### 5.4 Real-Time Updates While Open

When SignalR events arrive for the currently displayed node:
1. Status badge updates immediately (color + text)
2. Timing section updates (running duration counter if `Running`)
3. Metrics populate on `NodeCompleted` (row counts, DQ results)
4. Error banner appears on `NodeFailed`
5. Tab content refreshes WITHOUT tab switch — user stays on current tab

---

## 6. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Click node during slide-in animation | Queue the node switch, apply after `transitionend` |
| Click close during slide-in | Reverse animation direction to slide-out |
| DAG reloads while panel is open | If node still exists: refresh data. If node removed: close panel. |
| Multiple rapid node clicks | Debounce 50ms — only last click processed |
| Resize below minimum width (280px) | Clamp to 280px, stop drag |
| Resize above maximum (50% container) | Clamp to 50%, stop drag |
| External node selected | Panel opens normally but "Run This Node" disabled with tooltip |
| Tab content loading fails | Show "Failed to load" in tab content area with retry link |
| Panel open + browser resize | Panel width maintained (or clamped if exceeds 50% of new container size) |

---

## 7. Visual State Summary

### 7.1 Panel Lifecycle Visual

| State | Panel Position | Opacity | Shadow | ARIA |
|-------|---------------|---------|--------|------|
| `closed` | Off-screen right (translateX: 100%) | 0 | None | `aria-hidden="true"` |
| `opening` | Animating (100% -> 0) | 0 -> 1 | Fade in | `aria-hidden="false"` (set at start) |
| `open` | In position (translateX: 0) | 1 | `var(--color-border)` left border | `aria-hidden="false"` |
| `closing` | Animating (0 -> 100%) | 1 -> 0 | Fade out | `aria-hidden="true"` (set at end) |

### 7.2 Tab Visual States

| State | Tab Button | Tab Content |
|-------|-----------|-------------|
| Inactive tab | `var(--color-text-secondary)`, no border | Hidden (`display: none`) |
| Active tab | `var(--color-text)`, 2px bottom border `var(--accent)` | Visible |
| Hovered tab | `var(--color-text)`, `var(--color-bg-tertiary)` background | — |
| Focused tab | `var(--color-text)`, focus ring `var(--accent-glow)` | — |

### 7.3 Content States per Tab

| Tab | Loading | Empty | Populated | Error |
|-----|---------|-------|-----------|-------|
| Overview | Skeleton lines | "Not yet executed" | Full identity + status | Error banner |
| Metrics | Skeleton lines | "No metrics available" | Row counts + DQ table | "Failed to load metrics" |
| Logs | Spinner | "No execution data" | Log entries | "Failed to load logs" |
| Code | — | "Code reference not available" | Notebook links | "Failed to load code reference" |
| Deps | Skeleton lines | "No dependencies" | Parent/child lists | "Failed to load dependencies" |

### 7.4 Status-Dependent Styling

| NodeExecutionStatus | Header accent | Status badge | Error section |
|--------------------|---------------|--------------|---------------|
| None | `var(--color-border)` | Grey | Hidden |
| Running | `var(--accent)` | Purple pulse | Hidden |
| Completed | `var(--status-succeeded)` | Green | Hidden |
| Failed | `var(--status-failed)` | Red | Visible (red banner) |
| Cancelled | `var(--status-cancelled)` | Amber | Hidden |
| Skipped | `var(--status-pending)` | Grey | May show "Upstream failed" note |
