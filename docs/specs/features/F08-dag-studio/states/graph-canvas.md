# Graph Canvas — State Matrix

> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Component Spec:** `../components/graph-canvas.md`
> **Total States:** 22

---

## 1. Component States

The graph canvas has four orthogonal state dimensions that combine independently:

| Dimension | States | Mutually Exclusive? |
|-----------|--------|---------------------|
| Lifecycle | `empty`, `loading`, `ready`, `error` | Yes |
| Camera | `idle`, `panning`, `zooming` | Yes |
| Node interaction | `none`, `hovered`, `selected`, `multi-selected`, `focused` | Partially (hovered can combine with selected) |
| Execution overlay | `idle`, `running`, `terminal` | Yes |

---

## 2. Lifecycle States

These are mutually exclusive — the graph is always in exactly one lifecycle state.

### State: `graph.empty`

| Field | Value |
|-------|-------|
| **Entry** | DAG Studio opens with no data, or data is cleared |
| **Visual** | Centered text "No DAG loaded" in `var(--color-text-secondary)` on `var(--color-bg)` |
| **Keyboard** | None active except global shortcuts |
| **Data** | `nodes.length === 0` |
| **Transitions** | `graph.loading` (DAG data fetch begins) |

### State: `graph.loading`

| Field | Value |
|-------|-------|
| **Entry** | DAG data fetch initiated (REST call to `/api/dag/{dagId}`) |
| **Visual** | Centered spinner (CSS animation on overlay div), text "Loading DAG..." in `var(--color-text-secondary)` |
| **Keyboard** | None active |
| **Data** | Fetch in progress |
| **Transitions** | `graph.ready` (data received + layout computed), `graph.error` (fetch failed) |

### State: `graph.ready`

| Field | Value |
|-------|-------|
| **Entry** | DAG data received and Sugiyama layout completed |
| **Visual** | Full graph rendered — nodes at LOD-appropriate detail, edges drawn, grid visible |
| **Keyboard** | All navigation shortcuts active (Tab, Arrow, Enter, Escape, +/-, 0, F) |
| **Data** | `nodes.length > 0`, layout positions computed |
| **Transitions** | `graph.empty` (data cleared), `graph.loading` (different DAG loaded), `graph.error` (canvas context lost) |

### State: `graph.error`

| Field | Value |
|-------|-------|
| **Entry** | Data fetch failed, layout failed, or canvas context lost |
| **Visual** | Centered message "Failed to load DAG" in `var(--status-failed)`, retry button with `var(--accent)` |
| **Keyboard** | `Enter` triggers retry |
| **Data** | Error object with code + message |
| **Transitions** | `graph.loading` (retry), `graph.empty` (dismiss) |

---

## 3. Camera States

Active only when lifecycle is `graph.ready`.

### State: `camera.idle`

| Field | Value |
|-------|-------|
| **Entry** | No active pan/zoom gesture |
| **Visual** | Normal rendering, cursor: `default` (over empty), `pointer` (over node) |
| **Transitions** | `camera.panning` (mousedown on empty), `camera.zooming` (wheel event) |

### State: `camera.panning`

| Field | Value |
|-------|-------|
| **Entry** | `mousedown` on empty canvas area |
| **Visual** | Cursor: `grabbing`, canvas translates with mouse movement |
| **Exit** | `mouseup` or `mouseleave` |
| **Transitions** | `camera.idle` (mouse released) |

### State: `camera.zooming`

| Field | Value |
|-------|-------|
| **Entry** | `wheel` event or `+`/`-` keypress |
| **Visual** | Canvas scales around anchor point (cursor for wheel, center for keyboard) |
| **Constraints** | Clamped to [0.1, 3.0] range |
| **Exit** | Zoom animation complete (keyboard) or wheel event ends |
| **Transitions** | `camera.idle` (animation complete) |

---

## 4. Node Interaction States

Multiple nodes can be in different states simultaneously.

### State: `node.default`

| Field | Value |
|-------|-------|
| **Visual** | Normal rendering per LOD level, colors from § 4.1 of component spec |
| **Transitions** | `node.hovered` (mouseover), `node.selected` (click), `node.focused` (Tab) |

### State: `node.hovered`

| Field | Value |
|-------|-------|
| **Entry** | Mouse enters node hit-test area |
| **Visual** | Border brightens, connected edges highlight to `var(--accent)`, cursor: `pointer` |
| **Exit** | Mouse leaves node area |
| **Transitions** | `node.default` (mouseleave), `node.selected` (click) |

### State: `node.selected`

| Field | Value |
|-------|-------|
| **Entry** | Click on node, or `Enter` on focused node |
| **Visual** | 2px `var(--accent)` border, `var(--accent-dim)` background tint, Node Detail Panel opens |
| **Exit** | Click empty canvas, `Escape`, or select different node |
| **Side effects** | Fires `node:select` event, opens Node Detail Panel |
| **Transitions** | `node.default` (deselect), `node.multi-selected` (Ctrl+Click another) |

### State: `node.multi-selected`

| Field | Value |
|-------|-------|
| **Entry** | `Ctrl+Click` on additional nodes while one is selected |
| **Visual** | Each selected node shows `var(--accent)` border + tint, detail panel shows count |
| **Exit** | Click empty canvas, `Escape` |
| **Transitions** | `node.selected` (click single without Ctrl), `node.default` (deselect all) |

### State: `node.focused`

| Field | Value |
|-------|-------|
| **Entry** | `Tab` / `Shift+Tab` keyboard navigation |
| **Visual** | 2px focus ring `var(--accent-glow)` around node, ARIA announcement of node name + status |
| **Exit** | `Tab` to next node, click, `Escape` |
| **Transitions** | `node.selected` (Enter), `node.focused` on next node (Tab) |

### State: `node.context-menu`

| Field | Value |
|-------|-------|
| **Entry** | Right-click on node |
| **Visual** | Context menu overlay with items: "Run This Node", "View Code", "Copy Name" |
| **Menu background** | `var(--color-bg)`, border `var(--color-border)`, shadow |
| **Exit** | Click outside menu, `Escape`, or menu item selected |
| **Transitions** | `node.selected` (menu item triggers action), `node.default` (dismiss) |

---

## 5. Execution Overlay States

These affect ALL nodes simultaneously and overlay on top of individual node states.

### State: `execution.idle`

| Field | Value |
|-------|-------|
| **Entry** | No DAG execution in progress |
| **Visual** | Nodes show colors from last execution (or idle if never executed) |
| **Transitions** | `execution.running` (execution started via toolbar or SignalR `NodeStarted`) |

### State: `execution.running`

| Field | Value |
|-------|-------|
| **Entry** | First `NodeStarted` SignalR event received |
| **Visual** | Running nodes pulse (`var(--accent)` status bar, 2s oscillation). Completed nodes show green. Failed show red. Pending nodes remain idle. |
| **Animation** | `requestAnimationFrame` loop active for pulse |
| **Constraints** | No single-node cancel — only DAG-level cancel via toolbar. No intra-node progress percentage. |
| **Transitions** | `execution.terminal` (`DagTerminal` received) |

### State: `execution.terminal`

| Field | Value |
|-------|-------|
| **Entry** | `DagTerminal` SignalR event received |
| **Visual** | All nodes in final state. No animations. Error cascade applied (parent Failed -> child Skipped, parent Cancelled -> child Cancelled). |
| **Animation** | `requestAnimationFrame` loop stopped |
| **Transitions** | `execution.idle` (reset), `execution.running` (new execution started) |

---

## 6. State x Action Matrix

Rows = current state, columns = user actions, cells = resulting state or action.

### Lifecycle x Actions

| Current State | Load DAG | Retry | Clear Data | Click Node |
|---------------|----------|-------|------------|------------|
| `graph.empty` | `graph.loading` | — | — | — |
| `graph.loading` | Queue | — | `graph.empty` | — |
| `graph.ready` | `graph.loading` | — | `graph.empty` | `node.selected` |
| `graph.error` | `graph.loading` | `graph.loading` | `graph.empty` | — |

### Node State x Actions

| Current State | Click | Ctrl+Click | Hover | Tab | Enter | Escape | Right-Click |
|---------------|-------|------------|-------|-----|-------|--------|-------------|
| `node.default` | `node.selected` | `node.multi-selected` | `node.hovered` | `node.focused` | — | — | `node.context-menu` |
| `node.hovered` | `node.selected` | `node.multi-selected` | — | `node.focused` | — | — | `node.context-menu` |
| `node.selected` | Different node: `node.selected` | `node.multi-selected` | `node.hovered` (other) | `node.focused` | — | `node.default` | `node.context-menu` |
| `node.focused` | `node.selected` | `node.multi-selected` | `node.hovered` | Next `node.focused` | `node.selected` | `node.default` | — |

---

## 7. FLT <-> UI State Mapping

### NodeExecutionStatus -> Visual State

| FLT Status (NodeExecutionMetrics) | UI Node Color | UI Animation | LOD 2 Text |
|----------------------------------|---------------|--------------|------------|
| `None` | `var(--color-bg)` / `var(--color-border)` | None | — |
| `Running` | `var(--accent-dim)` / `var(--accent)` | Pulse (2s cycle) | "Running..." |
| `Completed` | Success tint / `var(--status-succeeded)` | Flash (300ms) then static | Duration: "1m 23s" |
| `Failed` | Error tint / `var(--status-failed)` | Flash (300ms) then static | "Failed" |
| `Cancelled` | Warning tint / `var(--status-cancelled)` | None | "Cancelled" |
| `Skipped` | `var(--color-bg-secondary)` / `var(--status-pending)` | None | "Skipped" |
| `Cancelling` | Warning tint / `var(--status-cancelled)` | Pulse (slower, 3s) | "Cancelling..." |

### DagExecutionStatus -> Execution Overlay

| FLT Status (DagExecutionStatus) | UI Overlay State |
|---------------------------------|------------------|
| `NotStarted` | `execution.idle` |
| `Running` | `execution.running` |
| `Completed` | `execution.terminal` |
| `Failed` | `execution.terminal` |
| `Cancelled` | `execution.terminal` |
| `Skipped` | `execution.terminal` |
| `Cancelling` | `execution.running` (with cancel indicator in toolbar) |

---

## 8. Transition Rules

### 8.1 Error Cascade (from FLT state machine)

When a parent node fails, its children are automatically skipped by the FLT engine:
- Parent `Failed` -> All direct children become `Skipped`
- Parent `Cancelled` -> All direct children become `Cancelled`

The canvas applies these cascades when `DagTerminal` is received, NOT when individual `NodeFailed` arrives (to avoid partial cascade rendering).

### 8.2 Concurrent Event Handling

Multiple SignalR events can arrive in the same frame:
1. Events are queued in arrival order
2. All queued events are applied in a single `requestAnimationFrame` callback
3. Visual state is resolved from the LAST event for each node (latest wins)
4. Example: `NodeStarted` + `NodeCompleted` in same frame -> node renders as Completed

### 8.3 Selection During Execution

Selection state is independent of execution state. A Running node can be selected (to view its real-time metrics in the detail panel). The selection border and execution border coexist — selection border is outer (2px `var(--accent)`), status border is inner (1px status color).

---

## 9. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Select node then DAG reloads | Selection cleared, detail panel closed |
| Zoom below LOD threshold during selection | Selection persists but visual indicator adapts to new LOD (dot has accent color) |
| SignalR reconnect during execution | Re-fetch current metrics via REST, reconcile with last known state |
| Browser tab backgrounded | `requestAnimationFrame` pauses naturally, resumes when tab focused |
| 1000+ nodes at LOD 2 | Performance budget exceeded — automatically drop to LOD 1 for distant nodes |
| External node clicked | Detail panel opens in read-only mode, execution actions disabled |

---

## 10. Visual State Summary Table

| State | Background | Border | Text Color | Animation | Cursor |
|-------|-----------|--------|------------|-----------|--------|
| `graph.empty` | `var(--color-bg)` | — | `var(--color-text-secondary)` | None | `default` |
| `graph.loading` | `var(--color-bg)` | — | `var(--color-text-secondary)` | Spinner | `wait` |
| `graph.ready` | `var(--color-bg)` (grid dots) | — | — | None | `default` / `pointer` |
| `graph.error` | `var(--color-bg)` | — | `var(--status-failed)` | None | `default` |
| `node.default` | Status fill | Status border | `var(--color-text)` | None | `pointer` |
| `node.hovered` | Status fill | Brightened border | `var(--color-text)` | None | `pointer` |
| `node.selected` | `var(--accent-dim)` overlay | `var(--accent)` 2px | `var(--color-text)` | None | `pointer` |
| `node.focused` | Status fill | `var(--accent-glow)` 2px ring | `var(--color-text)` | None | — |
| `execution.running` (on node) | `var(--accent-dim)` | `var(--accent)` | `var(--color-text)` | Pulse 2s | — |
| `execution.terminal` Completed | Success tint | `var(--status-succeeded)` | `var(--color-text)` | Flash 300ms | — |
| `execution.terminal` Failed | Error tint | `var(--status-failed)` | `var(--color-text)` | Flash 300ms | — |
