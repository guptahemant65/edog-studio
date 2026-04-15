# Gantt Chart — State Matrix

> **Feature:** F08 DAG Studio — Section 2.3
> **Component:** `DagGantt` class (`dag-gantt.js`)
> **Owner:** Pixel (Frontend) · Reviewed by Sana (Architecture)
> **Status:** SPEC PHASE
> **Companion:** `components/gantt-chart.md` (deep component spec)
> **States:** 19

---

## 1. State Diagram

```
                                    ┌──────────┐
                                    │  empty   │◄─────────────────────────────────────────┐
                                    └────┬─────┘                                          │
                                         │ loadExecution() or                              │
                                         │ renderExecution()                               │
                                         ▼                                                 │
                                    ┌──────────┐                                          │
                                    │ loading  │──── fetch fails ────►┌───────┐           │
                                    └────┬─────┘                      │ error │           │
                                         │ data received              └───┬───┘           │
                                         ▼                                │ retry ──► loading
                          ┌──────────────────────────────┐                │ dismiss ──► empty
                          │         loaded               │                │
                          │  ┌───────────────────────┐   │           ┌────┴──────┐
                          │  │       idle             │   │           │disconnected│
                          │  │  (static historical)   │   │           └────┬──────┘
                          │  └────────┬──────────────┘   │                │ reconnect
                          │           │ live exec starts  │                │ ──► loading
                          │           ▼                   │
                          │  ┌───────────────────────┐   │
                          │  │     executing          │   │
                          │  │  (bars growing,        │   │
                          │  │   60fps animation)     │   │
                          │  └────────┬──────────────┘   │
                          │           │ exec completes    │
                          │           ▼                   │
                          │  ┌───────────────────────┐   │
                          │  │    completed           │   │
                          │  │  (static, final bars)  │   │
                          │  └───────────────────────┘   │
                          └──────────────────────────────┘
                                    ▲    │
          Interaction sub-states    │    │ (can overlay on any loaded.* state)
          ─────────────────────     │    │
          node.hovered              │    │
          node.selected             │    │
          time.zooming              │    │
          time.panning              │    │
          comparison.selecting      │    │
          comparison.active         │    │
          resize.dragging           │    │
```

---

## 2. State Definitions

### S01: `empty`

The Gantt panel is visible but contains no execution data.

| Property | Value |
|----------|-------|
| **Trigger** | DAG Studio activated with no execution loaded, or Gantt tab selected before any execution is clicked |
| **Visual** | Empty canvas area. Centered text: "Select an execution from History to view timeline" in `--color-text-secondary`, 13px. Dashed border rectangle (`--color-border`, 1px dashed, 8px corner radius). |
| **Node labels** | Hidden |
| **Time axis** | Hidden |
| **Summary footer** | Hidden |
| **Canvas** | Blank — no gridlines, no bars |
| **Keyboard** | `Tab` moves focus to History tab. No arrow key navigation. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| `renderExecution(data)` called with valid data | `loading` | Show skeleton, begin render |
| `renderExecution(data)` called with null/empty data | `empty` (no-op) | Show "Empty execution" message variant |
| DAG Studio deactivated | — (component paused) | Stop any pending operations |

---

### S02: `loading`

Execution data is being fetched or parsed.

| Property | Value |
|----------|-------|
| **Trigger** | `DagStudio._loadExecution(iterationId)` initiated |
| **Visual** | Skeleton UI: 8 shimmer rows (grey pulsing bars at random widths 30–70%), faded time axis with placeholder ticks. Shimmer animation: `@keyframes gantt-shimmer` (1.5s, `oklch(0.22 0 0)` → `oklch(0.28 0 0)` → `oklch(0.22 0 0)`). |
| **Node labels** | 8 placeholder bars (60–120px width, 12px height, shimmer) |
| **Time axis** | Placeholder ticks (5 evenly spaced, no labels) |
| **Summary footer** | "Loading execution…" with spinner (Unicode `◠` rotating via CSS) |
| **Duration** | Typically 200–800ms (API fetch + parse) |
| **Keyboard** | Disabled — no navigation during load |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Data received, execution status = `running` | `loaded.executing` | Parse nodes, calculate time scale, start animation loop |
| Data received, execution status = terminal (`completed`/`failed`/`cancelled`) | `loaded.idle` | Parse nodes, calculate time scale, render static bars |
| Data received, execution has 0 nodes | `empty` | Show "Empty execution — no nodes ran" |
| API error (network/4xx/5xx) | `error` | Show error message with retry |
| WebSocket disconnect during fetch | `disconnected` | Show disconnected state |
| Timeout (10s) | `error` | Show "Load timed out — the execution may be very large" |

---

### S03: `loaded.idle`

A historical (terminal) execution is rendered statically.

| Property | Value |
|----------|-------|
| **Trigger** | Execution data loaded with terminal status |
| **Visual** | Full Gantt: all bars rendered at final width/color. Gridlines visible. No animation. |
| **Node labels** | All node names in `--color-text-secondary` |
| **Time axis** | Auto-scaled ticks with labels. Total duration label at right end. |
| **Summary footer** | `Σ {duration} │ {completed}/{total} nodes │ max ∥ {parallel} │ ● {status}` |
| **Canvas** | Static — no `requestAnimationFrame` loop |
| **Keyboard** | Full navigation enabled (↑/↓/←/→/Enter/Escape) |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| AutoDetector detects new live execution for same DAG | `loaded.executing` | Overlay live data, start animation loop |
| User clicks different execution in History | `loading` | Clear current, fetch new |
| User selects two executions → Compare | `comparison.selecting` | Begin comparison flow |
| User hovers a bar | `node.hovered` (overlay) | Show hover highlight + tooltip |
| User clicks a bar | `node.selected` (overlay) | Show selection highlight, fire `onNodeSelected` |
| User Ctrl+scrolls | `time.zooming` (overlay) | Begin zoom interaction |
| User drags empty area | `time.panning` (overlay) | Begin pan interaction |
| Drag handle moved | `resize.dragging` (overlay) | Resize panel |
| Component receives `renderExecution(null)` | `empty` | Clear all content |

---

### S04: `loaded.executing`

A live execution is in progress. Bars grow in real-time.

| Property | Value |
|----------|-------|
| **Trigger** | Live execution detected via AutoDetector, or execution loaded with status `running` |
| **Visual** | Bars for running nodes animate (grow rightward, pulse opacity). Completed bars static. Now marker animates rightward. |
| **Animation loop** | Active: `requestAnimationFrame` at 60fps. Dirty-rect repaint. |
| **Now marker** | Visible: 1.5px `--color-accent` vertical line with "Now" badge |
| **Time axis** | Auto-extends when Now marker reaches 85% of canvas width |
| **Summary footer** | `Σ {elapsed} │ {completed}/{started}/{total} │ max ∥ {concurrent} │ ● Running` — updates every second |
| **Keyboard** | Full navigation enabled. `End` key scrolls to Now marker. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| All nodes reach terminal status (`completed`/`failed`/`cancelled`/`skipped`) | `loaded.idle` | Stop animation loop. Hide Now marker. Show final duration. |
| AutoDetector receives execution completed/failed event | `loaded.idle` | Same as above |
| WebSocket disconnects | `disconnected` | Freeze bars at current width. Show disconnect banner. |
| User clicks different execution in History | `loading` | Stop animation. Clear. Fetch new. |
| User hovers a bar | `node.hovered` (overlay) | Hover highlight (animation continues) |
| User clicks a bar | `node.selected` (overlay) | Selection highlight (animation continues) |
| Component receives `renderExecution(null)` | `empty` | Stop animation. Clear all. |
| Gantt tab hidden (user switches to History/Detail tab) | `loaded.executing.paused` | Pause animation loop. Track elapsed. |

---

### S05: `loaded.executing.paused`

Live execution continues but the Gantt tab is not visible (user is on History or Detail tab).

| Property | Value |
|----------|-------|
| **Trigger** | User switches away from Gantt tab while execution is running |
| **Visual** | Not visible (tab hidden) |
| **Animation loop** | Paused — no `requestAnimationFrame` calls |
| **Data updates** | Still received via `updateBar()` — node data is updated in memory but not rendered |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| User switches back to Gantt tab | `loaded.executing` | Resume animation. Render all pending updates. Catch up Now marker. |
| Execution completes while tab hidden | `loaded.idle` | On next tab switch, render final static state |
| WebSocket disconnects | `disconnected` | Will be shown when user returns to Gantt tab |

---

### S06: `node.hovered`

Overlay state: a node bar is being hovered. Combines with any `loaded.*` base state.

| Property | Value |
|----------|-------|
| **Trigger** | Mouse enters a bar's hit-test area (Canvas `mousemove` → `_hitTest()` returns nodeId) |
| **Hovered bar** | Row background: `oklch(0.22 0 0 / 0.5)`. No change to bar itself. |
| **Hovered label** | Text color changes from `--color-text-secondary` to `--color-text-primary` |
| **Tooltip** | Appears after 300ms hover dwell: node name, type, status, start/end/duration, row counts, bottleneck warning (see component spec § 12) |
| **Graph cross-highlight** | `onNodeHovered(nodeId)` fires → graph shows hover ring on corresponding node |
| **Debounce** | Tooltip has 300ms delay. Hover highlight is immediate. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse leaves bar area | Previous base state | Remove row highlight, hide tooltip, fire `onNodeUnhovered()` |
| Mouse moves to different bar | `node.hovered` (new nodeId) | Switch highlight to new row, reset tooltip timer |
| Click on hovered bar | `node.selected` | Promote hover to selection |
| Scroll/zoom starts | Previous base state | Cancel hover (tooltip would be mispositioned) |

---

### S07: `node.selected`

Overlay state: a node is selected (clicked). Combines with any `loaded.*` base state.

| Property | Value |
|----------|-------|
| **Trigger** | Click on a bar, or `Enter` key on keyboard-focused row, or `highlightNode(id)` called from graph |
| **Selected bar** | 2px outline: `--color-accent`. Row background: `oklch(0.22 0.03 250 / 0.3)`. |
| **Selected label** | Text color: `--color-accent`. Font weight: bold. |
| **Graph cross-highlight** | `onNodeSelected(nodeId)` fires → graph pans to node + applies selection glow |
| **Detail panel** | `DagStudio._onNodeSelected(nodeId)` opens the Node Detail panel |
| **Only one node** | Selecting a new node deselects the previous one |
| **Scroll-into-view** | If bar not visible: smooth-scroll (200ms ease-out) to center the row vertically and show the bar horizontally |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Click on different bar | `node.selected` (new nodeId) | Deselect old, select new |
| Click on empty canvas area | Previous base state | Remove all selection styling, fire `onNodeSelected(null)` |
| `Escape` key | Previous base state | Same as clicking empty area |
| `↑`/`↓` key | `node.selected` (adjacent nodeId) | Move selection to adjacent row |
| Different execution loaded | `loading` | Selection cleared implicitly |
| Comparison mode entered | `comparison.active` | Selection cleared |

---

### S08: `time.zooming`

Overlay state: user is actively zooming the time axis.

| Property | Value |
|----------|-------|
| **Trigger** | `Ctrl+mousewheel`, pinch gesture, or `+`/`-` key press |
| **Visual** | Time axis labels update smoothly. Bars resize horizontally. Zoom is centered on cursor position (wheel) or viewport center (keyboard). |
| **Tick marks** | Re-calculated at new scale — snap to nice intervals |
| **Performance** | Must complete within 16ms per zoom step (1 frame) |
| **Limits** | Min: entire execution fills viewport. Max: 1 second fills viewport. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| No scroll input for 150ms | Previous base state | Commit final zoom level |
| `0` key | Previous base state | Animate to fit-all zoom (200ms ease) |
| Mouse button released (if dragging zoom) | Previous base state | Commit zoom |

---

### S09: `time.panning`

Overlay state: user is panning the time axis horizontally.

| Property | Value |
|----------|-------|
| **Trigger** | `Shift+mousewheel`, or click-drag on empty canvas area, or `←`/`→` keys |
| **Visual** | Bars and gridlines shift horizontally. Time axis labels update. |
| **Cursor** | `grabbing` during drag. Default otherwise. |
| **Bounds** | Cannot pan before t=0 or after execution end + 10% padding |
| **Momentum** | After mouse release: velocity-based coast with friction (200ms deceleration). Keyboard: instant 10% shift per press, no momentum. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse released + momentum decays to 0 | Previous base state | Final scroll position committed |
| `Shift+mousewheel` stops for 150ms | Previous base state | Commit position |
| `Home` key | Previous base state | Snap to t=0 |
| `End` key | Previous base state | Snap to execution end (or Now marker) |

---

### S10: `comparison.selecting`

Intermediate state: user has selected two executions in History and clicked Compare, but comparison data is loading.

| Property | Value |
|----------|-------|
| **Trigger** | "Compare" button clicked in History table with two rows selected |
| **Visual** | Current Gantt fades to 50% opacity. Loading spinner in center. Text: "Loading comparison…" |
| **Data fetch** | If one execution is already loaded, only fetch the second. Both `getDagExecMetrics()` calls in parallel. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Both datasets loaded successfully | `comparison.active` | Render dual-bar comparison view |
| One or both fetches fail | `error` | Show error with retry |
| User cancels (Escape) | Previous `loaded.*` state | Abort fetch. Restore single-run view. |

---

### S11: `comparison.active`

Two executions are overlaid in comparison mode.

| Property | Value |
|----------|-------|
| **Trigger** | Both comparison datasets successfully loaded and parsed |
| **Row height** | 48px (doubled): bar A on top, bar B below, 4px gap |
| **Bar A (older)** | Solid fill, 0.5 opacity. `A` badge on label. |
| **Bar B (newer)** | Striped fill, 0.7 opacity. `B` badge on label. |
| **Timing badges** | Green `▾ −{diff}` for improvements (>10%). Red `▴ +{diff}` for regressions (>10%). |
| **Missing nodes** | Single bar with `(only in A)` or `(only in B)` label, muted opacity |
| **Status changes** | Label column shows `A:● → B:●` pill |
| **Summary footer** | `Run A: {dur} ● {status} │ Run B: {dur} ● {status} │ Δ {diff} ({pct}%) │ {n} regressions │ {m} new failures` |
| **Time axis** | Scaled to the longer of the two runs |
| **Node sort** | By Run B layer/start time. Nodes only in Run A appended at bottom. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| "Exit Compare" button clicked | `loaded.idle` (with Run B data) | Animate row height 48→28px (200ms). Remove A bars. |
| `Escape` key | `loaded.idle` (with Run B data) | Same as above |
| Click a comparison bar | `node.selected` (overlay) | Select node. Show detail for the clicked run's data. |
| Different execution loaded from History | `loading` | Exit comparison. Load new single execution. |
| Hover a comparison row | `node.hovered` (overlay) | Highlight both A and B bars in that row |

---

### S12: `resize.dragging`

Overlay state: user is dragging the split handle between DAG graph and bottom panel.

| Property | Value |
|----------|-------|
| **Trigger** | Mousedown on the drag handle (8px bar between graph and Gantt panel) |
| **Visual** | Handle turns `--color-accent`. Cursor: `row-resize`. Graph and Gantt resize in real-time following mouse Y. |
| **Canvas** | Gantt canvas resizes on each frame. Bar positions recalculated. Time axis reflows. |
| **Constraints** | Min top: 120px. Min bottom: 80px. |
| **Performance** | Canvas resize is expensive — throttle to every 2nd frame (30fps) during drag |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse released | Previous base state | Commit split ratio. Persist to `localStorage` (`edog.dagStudio.splitRatio`). Handle returns to `--color-border`. Final canvas resize at full quality. |
| `Escape` during drag | Previous base state | Revert to pre-drag split ratio. Cancel operation. |

---

### S13: `error`

An error occurred loading or rendering execution data.

| Property | Value |
|----------|-------|
| **Trigger** | API fetch failure, parse error, canvas error, timeout |
| **Visual** | Error card centered in Gantt area: red-tinted background `oklch(0.18 0.04 25 / 0.3)`, 1px border `oklch(0.40 0.15 25)`. Icon: `✕` in circle. |
| **Message** | Specific, actionable text (see component spec § 15). Example: "Could not load execution data — network error. [Retry]" |
| **Retry button** | Ghost button, `--color-accent`. Keyboard-focusable. |
| **Canvas** | Blank or frozen at last good state (depending on error type) |

**Error messages by type:**

| Error Code | Message |
|------------|---------|
| Network error | "Could not load execution data" + [Retry] |
| HTTP 404 | "Execution not found — it may have been garbage collected" |
| HTTP 401/403 | "Session expired — re-authenticate" |
| HTTP 429 | "Rate limited — retrying in {n}s…" (auto-retry with countdown) |
| HTTP 5xx | "FLT service error" + error details + [Retry] |
| Parse error | "Invalid execution data received" + [Retry] |
| Canvas error | "Gantt chart unavailable — Canvas not supported" |
| Timeout | "Load timed out — the execution may be very large" + [Retry] |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Retry button clicked | `loading` | Re-fetch execution data |
| 429 auto-retry timer expires | `loading` | Automatic re-fetch |
| User clicks different execution in History | `loading` | Dismiss error, load new |
| Dismiss button / `Escape` | `empty` | Return to empty state |
| Component destroyed | — | Clean up |

---

### S14: `disconnected`

WebSocket connection lost during live execution.

| Property | Value |
|----------|-------|
| **Trigger** | Global WebSocket disconnect detected while in `loaded.executing` |
| **Visual** | Bars frozen at last known width. Amber banner at top of Gantt: "Connection lost — execution data may be stale. Reconnecting…" with pulsing `◠` indicator. Now marker frozen. |
| **Animation** | Stopped — no bar growth, no Now marker movement |
| **Data** | Last known state preserved. No updates. |
| **Banner style** | Background: `oklch(0.22 0.08 85 / 0.4)`. Border: 1px `oklch(0.60 0.15 85)`. Text: `--color-text-primary`. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| WebSocket reconnects | `loading` | Re-fetch current execution metrics to reconcile state. Then transition to appropriate `loaded.*` state. |
| User clicks different execution | `loading` | Dismiss disconnect banner. Load new execution. |
| Dismiss banner | `loaded.idle` | Freeze bars as-is. User accepts stale data. |
| 60s timeout without reconnect | `error` | Show "Connection lost. [Retry] to reconnect." |

---

### S15: `loaded.idle.empty_execution`

Special case: execution loaded successfully but contained zero nodes.

| Property | Value |
|----------|-------|
| **Trigger** | Execution data loaded, `nodeExecutionMetrices` is empty map |
| **Visual** | Empty Gantt with message: "Empty execution — no nodes were executed" in `--color-text-secondary`. Dashed border. |
| **Summary footer** | `Σ {duration} │ 0/0 nodes │ ● {status}` |
| **Time axis** | Visible but with no meaningful ticks (0s to execution duration, if available) |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| User clicks different execution | `loading` | Load new execution |
| AutoDetector detects live execution | `loaded.executing` | Transition to live mode |

---

### S16: `loaded.node_appearing`

Transient state: a new node bar is being inserted during live execution.

| Property | Value |
|----------|-------|
| **Trigger** | `updateBar()` called for a nodeId not yet in the rendered list |
| **Duration** | 150ms transition |
| **Visual** | New row slides in at correct sort position. Existing rows below shift down (CSS `transform: translateY`, 150ms ease). New bar fades from 0→1 opacity over 100ms. |
| **Auto-scroll** | If new row is below viewport: do NOT auto-scroll (avoid jank). Exception: if new node has `status === 'failed'`, auto-scroll to it. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Animation completes (150ms) | `loaded.executing` | Row fully visible. Bar in animation loop. |

---

### S17: `time.fit_animating`

Transient state: time axis is animating to fit-all zoom level.

| Property | Value |
|----------|-------|
| **Trigger** | `0` key pressed, or `setTimeZoom('fit')` called |
| **Duration** | 200ms ease-out |
| **Visual** | Time scale smoothly animates from current `pxPerSec` to fit-all `pxPerSec`. Bars resize fluidly. Tick marks transition. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Animation completes | Previous base state | Commit new zoom level |
| User interrupts with zoom/pan input | `time.zooming` or `time.panning` | Cancel animation, respond to new input |

---

### S18: `time.auto_extending`

Transient state: time axis is automatically extending during live execution.

| Property | Value |
|----------|-------|
| **Trigger** | Now marker reaches 85% of canvas width |
| **Duration** | 200ms ease transition |
| **Visual** | Time scale compresses smoothly to add 30% headroom. All bars shrink horizontally. New tick marks appear at right edge. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Scale transition completes | `loaded.executing` | Continue animation loop at new scale |
| Execution completes during transition | `loaded.idle` | Complete transition, then stop animation |

---

### S19: `comparison.hover_diff`

Overlay state within comparison mode: user hovers a node row that has timing differences.

| Property | Value |
|----------|-------|
| **Trigger** | Mouse hovers a row in `comparison.active` state where run A and run B have > 10% timing difference |
| **Visual** | Both A and B bars highlighted. Timing diff badge enlarged. Tooltip shows detailed comparison: "Run A: 2.1s (completed) → Run B: 45.2s (failed) — 21× slower" |
| **Graph** | `onNodeHovered(nodeId)` fires — graph highlights the node |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse leaves row | `comparison.active` | Remove highlight, hide tooltip |
| Mouse moves to different row | `comparison.hover_diff` (new row) | Switch highlight |
| Click | `node.selected` (within comparison) | Select for detail view |

---

## 3. Transition Matrix

Complete mapping of every state-to-state transition.

| From | To | Trigger | Guard | Side Effect |
|------|----|---------|-------|-------------|
| `empty` | `loading` | `renderExecution()` called | Data is non-null | Show skeleton UI |
| `loading` | `loaded.idle` | Data received | Execution status is terminal | Parse, render static bars |
| `loading` | `loaded.executing` | Data received | Execution status is `running` | Parse, render bars, start animation loop |
| `loading` | `loaded.idle.empty_execution` | Data received | Node map is empty | Show empty execution message |
| `loading` | `error` | Fetch failed | — | Show error card with retry |
| `loading` | `disconnected` | WebSocket drops during fetch | Was in connected mode | Show disconnect banner |
| `loaded.idle` | `loading` | New execution selected | — | Clear current, fetch new |
| `loaded.idle` | `loaded.executing` | AutoDetector fires live execution | Same DAG | Start animation loop |
| `loaded.idle` | `comparison.selecting` | Compare triggered | Two executions selected | Fetch second dataset |
| `loaded.idle` | `empty` | `renderExecution(null)` | — | Clear all |
| `loaded.executing` | `loaded.idle` | Execution completes | All nodes terminal | Stop animation. Show final. |
| `loaded.executing` | `disconnected` | WebSocket drops | — | Freeze bars. Show banner. |
| `loaded.executing` | `loading` | New execution selected | — | Stop animation. Clear. Fetch. |
| `loaded.executing` | `loaded.executing.paused` | Gantt tab hidden | Tab switch | Pause animation |
| `loaded.executing` | `empty` | `renderExecution(null)` | — | Stop animation. Clear. |
| `loaded.executing.paused` | `loaded.executing` | Gantt tab shown | — | Resume animation. Catch up. |
| `loaded.executing.paused` | `loaded.idle` | Execution completes while paused | — | Will render static on tab show |
| `comparison.selecting` | `comparison.active` | Both datasets loaded | — | Render dual-bar view |
| `comparison.selecting` | `error` | Fetch fails | — | Show error |
| `comparison.selecting` | Previous `loaded.*` | User presses Escape | — | Abort. Restore single view. |
| `comparison.active` | `loaded.idle` | "Exit Compare" or Escape | — | Animate rows 48→28px |
| `comparison.active` | `loading` | New execution from History | — | Exit compare. Load new. |
| `error` | `loading` | Retry clicked | — | Re-fetch |
| `error` | `empty` | Dismiss | — | Clear error |
| `error` | `loading` | Different execution selected | — | Dismiss error. Fetch new. |
| `disconnected` | `loading` | WebSocket reconnects | — | Re-fetch to reconcile |
| `disconnected` | `loaded.idle` | User dismisses banner | — | Accept stale data |
| `disconnected` | `error` | 60s timeout | — | Escalate to error |
| Any `loaded.*` | `node.hovered` (overlay) | Mouse enters bar | Hit-test succeeds | Highlight row, start tooltip timer |
| `node.hovered` | Base state | Mouse leaves bar | — | Remove highlight, hide tooltip |
| Any `loaded.*` | `node.selected` (overlay) | Click bar / Enter key | — | Highlight bar, fire `onNodeSelected` |
| `node.selected` | Base state | Click empty / Escape | — | Clear selection |
| Any `loaded.*` | `time.zooming` (overlay) | Ctrl+wheel / +/− keys | — | Adjust `pxPerSec` |
| `time.zooming` | Base state | 150ms idle | — | Commit zoom |
| Any `loaded.*` | `time.panning` (overlay) | Shift+wheel / drag / ←/→ | — | Adjust scroll offset |
| `time.panning` | Base state | Release / idle | — | Commit position |
| Any `loaded.*` | `resize.dragging` (overlay) | Mousedown on drag handle | — | Begin resize |
| `resize.dragging` | Base state | Mouseup | — | Persist ratio |
| `resize.dragging` | Base state | Escape | — | Revert ratio |
| `loaded.executing` | `loaded.node_appearing` (transient) | New node bar created | Node not in list | Insert row with animation |
| `loaded.node_appearing` | `loaded.executing` | 150ms animation done | — | Row integrated |
| Any `loaded.*` | `time.fit_animating` (transient) | `0` key / `setTimeZoom('fit')` | — | Animate to fit-all |
| `time.fit_animating` | Base state | 200ms done | — | Commit zoom |
| `loaded.executing` | `time.auto_extending` (transient) | Now marker at 85% | — | Compress scale |
| `time.auto_extending` | `loaded.executing` | 200ms done | — | Continue at new scale |

---

## 4. State Invariants

Rules that must hold true regardless of current state.

| # | Invariant | Enforcement |
|---|-----------|-------------|
| 1 | Only one node can be selected at a time | `_selectedNodeId` is a single value, not a set |
| 2 | Only one node can be hovered at a time | `_hoveredNodeId` replaces, not appends |
| 3 | Animation loop runs only in `loaded.executing` (not paused) | `_animating` flag checked on every `requestAnimationFrame` callback |
| 4 | Canvas is never drawn to when component is not visible | `_isVisible` flag checked before any render call |
| 5 | Time scale `pxPerSec` is always > 0 | `clamp()` in all zoom calculations |
| 6 | Comparison mode requires exactly 2 runs | `renderComparison()` rejects if not exactly 2 arguments |
| 7 | Bars never render with negative width | `Math.max(MIN_BAR_WIDTH, calculated)` before every `fillRect` |
| 8 | Tooltip never outlives its hover | Tooltip hidden on mouseout, scroll, zoom, tab switch, destroy |
| 9 | `destroy()` always cancels animation frame | `cancelAnimationFrame(this._rafId)` in destroy |
| 10 | Overlay states (hover/select/zoom/pan/resize) never change base state | Overlay flags are independent of `_baseState` |

---

## 5. State → CSS Class Mapping

DOM classes applied to the Gantt container element (`div.dag-gantt`).

| State | CSS Class(es) | Purpose |
|-------|---------------|---------|
| `empty` | `.dag-gantt--empty` | Centers placeholder message |
| `loading` | `.dag-gantt--loading` | Shows shimmer skeleton |
| `loaded.idle` | `.dag-gantt--loaded` | Standard layout |
| `loaded.executing` | `.dag-gantt--loaded .dag-gantt--executing` | Enables Now marker + pulse animations |
| `loaded.executing.paused` | `.dag-gantt--loaded .dag-gantt--executing .dag-gantt--paused` | Pauses CSS animations via `animation-play-state: paused` |
| `comparison.active` | `.dag-gantt--loaded .dag-gantt--comparing` | Doubles row height, shows A/B badges |
| `error` | `.dag-gantt--error` | Shows error card layout |
| `disconnected` | `.dag-gantt--loaded .dag-gantt--disconnected` | Shows amber disconnect banner |
| `resize.dragging` | `.dag-gantt--resizing` (on parent container) | Disables pointer events on canvas during resize |

---

## 6. State → `DagGantt` Properties

Internal state properties maintained by the `DagGantt` class.

| Property | Type | Default | Updated By |
|----------|------|---------|------------|
| `_baseState` | `string` | `'empty'` | State transition logic |
| `_executionData` | `DagExecutionInstance?` | `null` | `renderExecution()` |
| `_comparisonData` | `[DagExecutionInstance, DagExecutionInstance]?` | `null` | `renderComparison()` |
| `_sortedNodes` | `Array<{id, name, layer, metrics}>` | `[]` | `_sortNodes()` |
| `_selectedNodeId` | `string?` | `null` | Click / keyboard / `highlightNode()` |
| `_hoveredNodeId` | `string?` | `null` | Mousemove hit-test |
| `_pxPerSec` | `number` | `0` | `_calculateTimeScale()` / zoom |
| `_scrollX` | `number` | `0` | Pan / zoom |
| `_scrollY` | `number` | `0` | Vertical scroll sync |
| `_isAnimating` | `boolean` | `false` | Animation loop start/stop |
| `_rafId` | `number?` | `null` | `requestAnimationFrame` return value |
| `_isVisible` | `boolean` | `true` | Tab visibility |
| `_isComparing` | `boolean` | `false` | Comparison mode toggle |
| `_splitRatio` | `number` | `0.6` | Drag handle / localStorage |
| `_canvasCtx` | `CanvasRenderingContext2D?` | `null` | Constructor |
| `_hatchPattern` | `CanvasPattern?` | `null` | `_createPatternCanvases()` |
| `_stripePattern` | `CanvasPattern?` | `null` | `_createPatternCanvases()` |
| `_tooltipTimer` | `number?` | `null` | Hover debounce (300ms) |
| `_execStartTime` | `number` | `0` | From execution metrics |
| `_nowMarkerTime` | `number` | `0` | Updated each animation frame |
