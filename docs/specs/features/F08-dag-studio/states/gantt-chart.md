# Gantt Chart — State Matrix

> **Feature:** F08 DAG Studio — Section 2.3
> **Component:** `DagGantt` class (`dag-gantt.js`)
> **Owner:** Pixel (Frontend) · Reviewed by Sana (Architecture)
> **Status:** DRAFT
> **Companion:** `components/gantt-chart.md` (deep component spec)
> **States:** 19

---

## 1. Legend

Every state definition in this document uses the following fields:

| Field | Meaning |
|-------|---------|
| **ID** | Stable identifier (`S01`–`S19`). Referenced in transition tables and implementation. |
| **Name** | Dot-delimited machine name, e.g. `loaded.executing.paused`. |
| **Entry conditions** | What must be true for this state to become active. |
| **Exit conditions** | What causes a transition away from this state. |
| **Visual description** | Pixel-level rendering details. All colours reference design tokens — never raw hex. |
| **Canvas commands** | Canvas 2D API calls executed on entry/frame (where applicable). |
| **Keyboard** | Which keyboard shortcuts are active and what they do. |
| **Data requirements** | Properties that must be non-null / valid for the state to function. |
| **Transitions out** | Table of `Trigger → Target → Action` triples. |

Token reference (light theme):

| Token | Value | Purpose |
|-------|-------|---------|
| `--color-bg` | `#ffffff` | Primary background |
| `--color-bg-secondary` | `#f5f5f7` | Panel / sidebar background |
| `--color-bg-tertiary` | `#ebebed` | Hover row tint |
| `--color-text` | `#2c2c2c` | Primary text |
| `--color-text-secondary` | `#666666` | Secondary / label text |
| `--color-text-tertiary` | `#999999` | Muted / placeholder text |
| `--color-border` | `#e0e0e2` | Borders, gridlines, separators |
| `--accent` | `#6d5cff` | Primary actions, selection rings |
| `--accent-dim` | `rgba(109,92,255,0.07)` | Tinted selection background |
| `--accent-glow` | `rgba(109,92,255,0.15)` | Focus ring glow |
| `--status-succeeded` | `#18a058` | Succeeded / green status |
| `--status-failed` | `#e5453b` | Failed / red status |
| `--status-cancelled` | `#e5940c` | Cancelled / amber status |
| `--status-pending` | `#8e95a5` | Pending / grey status |

Unicode symbols only — no emoji: `●` (status), `▸` (expand), `◆` (diamond), `✕` (close), `⋯` (overflow).

---

## 2. State Diagram

```
                                       ┌───────────┐
                                       │   empty   │◄────────────────────────────────────────┐
                                       │   (S01)   │                                         │
                                       └─────┬─────┘                                         │
                                             │ renderExecution()                              │
                                             │ loadExecution()                                │
                                             ▼                                                │
                                       ┌───────────┐                                         │
                                       │  loading  │─── fetch fails ───►┌─────────┐          │
                                       │   (S02)   │                    │  error  │          │
                                       └─────┬─────┘                    │  (S13)  │          │
                                             │ data received            └────┬────┘          │
                                             ▼                               │ retry → S02   │
                            ┌─────────────────────────────────┐              │ dismiss → S01 │
                            │           loaded                │              │               │
                            │                                 │         ┌────┴───────┐       │
                            │  ┌────────────────────────┐     │         │disconnected│       │
                            │  │     idle (S03)         │     │         │   (S14)    │       │
                            │  │  (static historical)   │     │         └────┬───────┘       │
                            │  └──────────┬─────────────┘     │              │ reconnect     │
                            │             │ live exec starts   │              │ ──► S02       │
                            │             ▼                    │              │ 60s ──► S13   │
                            │  ┌────────────────────────┐     │                              │
                            │  │   executing (S04)      │     │                              │
                            │  │  (bars growing, 60fps) │     │                              │
                            │  └──────────┬─────────────┘     │                              │
                            │             │ tab hidden         │                              │
                            │             ▼                    │                              │
                            │  ┌────────────────────────┐     │                              │
                            │  │ executing.paused (S05) │     │                              │
                            │  │  (anim paused, data ✓) │     │                              │
                            │  └────────────────────────┘     │                              │
                            │                                 │                              │
                            │  ┌────────────────────────┐     │                              │
                            │  │ empty_execution (S15)  │     │                              │
                            │  │  (0 nodes executed)    │     │                              │
                            │  └────────────────────────┘     │                              │
                            └─────────────────────────────────┘                              │
                                          ▲    │                                             │
                                          │    │                                             │
            Overlay states (combine        │    │  Transient states:                         │
            with any loaded.* base):       │    │  S16 loaded.node_appearing (150ms)         │
            ──────────────────────         │    │  S17 time.fit_animating    (200ms)         │
            S06 node.hovered               │    │  S18 time.auto_extending  (200ms)         │
            S07 node.selected              │    │                                            │
            S08 time.zooming               │    │                                            │
            S09 time.panning               │    │                                            │
            S10 comparison.selecting       │    │                                            │
            S11 comparison.active          │    │                                            │
            S12 resize.dragging            │    │                                            │
            S19 comparison.hover_diff      │    │                                            │
```

---

## 3. State Definitions

### S01: `empty`

The Gantt panel is visible but contains no execution data.

| Property | Value |
|----------|-------|
| **Entry** | DAG Studio activated with no execution loaded, or Gantt tab selected before any execution is clicked, or `renderExecution(null)` called |
| **Visual** | White canvas (`--color-bg`). Centered text: "Select an execution from History to view timeline" in `--color-text-secondary` at 13px. Dashed border rectangle: 1px dashed `--color-border`, 8px corner radius. |
| **Node labels** | Hidden |
| **Time axis** | Hidden |
| **Summary footer** | Hidden |
| **Canvas** | Blank — no gridlines, no bars. Single `clearRect` on the full canvas, then centered text drawn via `fillText`. |
| **Keyboard** | `Tab` moves focus to History tab. No arrow key navigation. No zoom/pan. |
| **Data** | `_executionData === null`, `_sortedNodes.length === 0` |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| `renderExecution(data)` called with valid non-null data | `S02 loading` | Show skeleton UI, begin data parse |
| `renderExecution(data)` called with null or empty data | `S01 empty` (no-op) | Flash "Empty execution" variant text for 2s, then revert |
| DAG Studio deactivated | — (component paused) | Stop any pending operations, preserve state for resume |

---

### S02: `loading`

Execution data is being fetched or parsed. Skeleton UI provides visual continuity.

| Property | Value |
|----------|-------|
| **Entry** | `DagStudio._loadExecution(iterationId)` initiated, or retry from `S13` |
| **Visual** | Skeleton UI on `--color-bg`. 8 shimmer rows: pulsing bars at random widths (30–70% of row width). Shimmer animation: `@keyframes gantt-shimmer` — 1.5s ease-in-out infinite, cycling `--color-bg-secondary` → `--color-bg-tertiary` → `--color-bg-secondary`. |
| **Node labels** | 8 placeholder bars: 60–120px width, 12px height, same shimmer gradient. Rounded corners (4px). |
| **Time axis** | Placeholder ticks: 5 evenly spaced vertical lines in `--color-border` at 0.4 opacity. No labels. |
| **Summary footer** | "Loading execution..." in `--color-text-tertiary` with rotating `◠` spinner (CSS `animation: spin 1s linear infinite`). |
| **Duration** | Typically 200–800ms (API fetch + parse). Timeout at 10s. |
| **Canvas** | Not active — skeleton is DOM-based overlay on top of canvas element. |
| **Keyboard** | Disabled — no navigation during load. `Escape` does nothing. |
| **Data** | Fetch in progress. `_executionData` still holds previous (if any). |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Data received, execution status = `running` | `S04 loaded.executing` | Parse nodes, calculate time scale, start `requestAnimationFrame` loop |
| Data received, execution status = terminal (`completed`/`failed`/`cancelled`) | `S03 loaded.idle` | Parse nodes, calculate time scale, render all bars at final width |
| Data received, execution has 0 nodes | `S15 loaded.idle.empty_execution` | Show "Empty execution — no nodes were executed" |
| API error (network / 4xx / 5xx) | `S13 error` | Show error card with retry button |
| WebSocket disconnect during fetch | `S14 disconnected` | Show disconnected banner |
| 10s timeout | `S13 error` | Show "Load timed out — the execution may be very large" + [Retry] |

---

### S03: `loaded.idle`

A historical (terminal) execution is rendered statically. All bars are at final width with status colours.

| Property | Value |
|----------|-------|
| **Entry** | Execution data loaded with terminal status, or execution completes in `S04`, or comparison exited |
| **Visual** | Full Gantt chart on `--color-bg`. All bars rendered at final width. Bar colours: `--status-succeeded` (green), `--status-failed` (red), `--status-cancelled` (amber), `--status-pending` (grey). Gridlines: 1px `--color-border` at 0.3 opacity. Row height: 28px. Row alternation: odd rows `--color-bg`, even rows `--color-bg-secondary`. |
| **Node labels** | All node names in `--color-text-secondary` at 12px. Left-aligned in label column (140px wide). |
| **Time axis** | Auto-scaled ticks in `--color-text-tertiary` at 11px. Major ticks: 1px `--color-border`. Total duration label at right end in `--color-text-secondary`. |
| **Summary footer** | `Σ {duration} │ {completed}/{total} nodes │ max ∥ {parallel} │ ● {status}` in `--color-text-secondary`. Status dot coloured by execution outcome. |
| **Canvas** | Static — no `requestAnimationFrame` loop. Rendered once on entry, re-rendered only on resize/zoom/pan. |
| **Keyboard** | `↑`/`↓`: move focus between rows. `←`/`→`: pan time axis 10% per press. `Enter`: select focused row. `Escape`: deselect. `+`/`-`: zoom. `0`: fit-all. `Home`/`End`: snap to start/end. `Tab`: move focus to next panel. |
| **Data** | `_executionData` populated. `_sortedNodes.length > 0`. `_pxPerSec > 0`. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| AutoDetector detects new live execution for same DAG | `S04 loaded.executing` | Overlay live data, start animation loop |
| User clicks different execution in History | `S02 loading` | Clear current bars, fetch new execution |
| User selects two executions → Compare | `S10 comparison.selecting` | Begin comparison data fetch |
| User hovers a bar | `S06 node.hovered` (overlay) | Show row highlight + start tooltip timer |
| User clicks a bar | `S07 node.selected` (overlay) | Show selection, fire `onNodeSelected` |
| User Ctrl+scrolls / presses +/- | `S08 time.zooming` (overlay) | Begin zoom interaction |
| User Shift+scrolls / drags empty area | `S09 time.panning` (overlay) | Begin pan interaction |
| Drag handle mousedown | `S12 resize.dragging` (overlay) | Begin panel resize |
| `0` key pressed | `S17 time.fit_animating` (transient) | Animate to fit-all zoom |
| Component receives `renderExecution(null)` | `S01 empty` | Clear all bars, labels, footer |

---

### S04: `loaded.executing`

A live execution is in progress. Running bars grow in real-time. Now marker tracks elapsed time.

| Property | Value |
|----------|-------|
| **Entry** | Live execution detected via AutoDetector, or loaded execution has status `running` |
| **Visual** | Bars for running nodes grow rightward. Running bar fill: `--accent` at 0.8 opacity with pulse (0.6 → 1.0 → 0.6, 2s ease-in-out). Completed bars: `--status-succeeded`. Failed bars: `--status-failed` with 2px `--status-failed` left accent. Pending bars: `--status-pending` at 0.3 opacity, dashed outline. All on `--color-bg`. |
| **Animation loop** | Active: `requestAnimationFrame` at 60fps. Dirty-rect repaint only for changed bars. |
| **Now marker** | Visible: 1.5px vertical line in `--accent` with "Now" badge (8px pill, `--accent` bg, `--color-bg` text, 10px font). Marker advances each frame. |
| **Time axis** | Auto-extends when Now marker reaches 85% of canvas width (triggers `S18`). Labels in `--color-text-tertiary`. |
| **Summary footer** | `Σ {elapsed} │ {completed}/{started}/{total} │ max ∥ {concurrent} │ ● Running` in `--color-text-secondary`. "Running" status dot pulses `--accent`. Updates every second. |
| **Canvas** | `requestAnimationFrame` loop running. Each frame: clear dirty rects, redraw changed bars, advance Now marker position. |
| **Keyboard** | Full navigation. `End` key scrolls to Now marker. `Space` does nothing (no pause). |
| **Data** | `_executionData.status === 'running'`. `_isAnimating === true`. `_nowMarkerTime` updated per frame. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| All nodes reach terminal status | `S03 loaded.idle` | Stop animation loop. Hide Now marker. Render final bars. Show total duration. |
| AutoDetector receives execution-completed event | `S03 loaded.idle` | Same as above |
| WebSocket disconnects | `S14 disconnected` | Freeze bars at current width. Show amber banner. |
| User clicks different execution in History | `S02 loading` | Stop animation. Clear canvas. Fetch new. |
| User hovers a bar | `S06 node.hovered` (overlay) | Hover highlight — animation continues uninterrupted |
| User clicks a bar | `S07 node.selected` (overlay) | Selection highlight — animation continues |
| Component receives `renderExecution(null)` | `S01 empty` | Stop animation. `cancelAnimationFrame`. Clear canvas. |
| Gantt tab hidden (user switches tab) | `S05 loaded.executing.paused` | Pause animation loop. Continue receiving data in memory. |
| New node appears | `S16 loaded.node_appearing` (transient) | Insert new row with 150ms slide animation |
| Now marker reaches 85% viewport | `S18 time.auto_extending` (transient) | Compress scale with 200ms transition |

---

### S05: `loaded.executing.paused`

Live execution continues server-side, but the Gantt tab is hidden. Data accumulates in memory without rendering.

| Property | Value |
|----------|-------|
| **Entry** | User switches away from Gantt tab while `S04` is active (tab hidden event) |
| **Visual** | Not visible — tab is hidden. No rendering cost. |
| **Animation loop** | Paused — no `requestAnimationFrame` calls. `_isAnimating` remains `true` but `_isVisible === false`. |
| **Data updates** | Still received via `updateBar()`. Node data updated in `_sortedNodes` in memory. `_nowMarkerTime` not advanced (will catch up on resume). |
| **Canvas** | No draw calls. Canvas element hidden via CSS. |
| **Keyboard** | Not applicable — panel not focusable while hidden. |
| **Data** | `_isVisible === false`. `_isAnimating === true`. Buffered updates in `_pendingUpdates` array. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| User switches back to Gantt tab | `S04 loaded.executing` | Resume animation. Flush all pending updates. Recalculate Now marker. Full canvas redraw. |
| Execution completes while tab hidden | `S03 loaded.idle` | Set `_isAnimating = false`. On next tab switch: render final static bars. |
| WebSocket disconnects while paused | `S14 disconnected` | Queued — shown when user returns to Gantt tab. |

---

### S06: `node.hovered`

**Overlay state** — combines with any `loaded.*` base state (S03, S04, S05 ignored, S15).

A single node bar is being hovered. Cross-highlights the corresponding graph node.

| Property | Value |
|----------|-------|
| **Entry** | Mouse enters a bar's hit-test area (`_hitTest(mouseX, mouseY)` returns a `nodeId`). Immediate — no debounce on the highlight itself. |
| **Hovered row** | Row background changes to `--color-bg-tertiary`. Smooth 80ms transition. |
| **Hovered label** | Text colour changes from `--color-text-secondary` to `--color-text` (darker). |
| **Hovered bar** | No visual change to the bar itself — row tint provides sufficient affordance. |
| **Tooltip** | Appears after 300ms hover dwell. Tooltip card: `--color-bg` background, 1px `--color-border` border, 4px radius, `box-shadow: 0 2px 8px rgba(0,0,0,0.08)`. Content: node name (bold, `--color-text`), type (mono, `--color-text-secondary`), status dot (coloured), start/end/duration values, row counts. If bottleneck: warning line in `--status-cancelled`. |
| **Graph cross-highlight** | `onNodeHovered(nodeId)` fires → graph canvas draws hover ring on corresponding node |
| **Canvas** | Row background repainted. If in `S04`, animation loop handles it in next frame. If in `S03`, explicit repaint of affected row. |
| **Keyboard** | Not applicable — hover is pointer-only. Keyboard focus uses `S07` selection. |
| **Data** | `_hoveredNodeId` set to current node ID. Only one hover at a time. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse leaves bar area | Previous base state | Remove row tint, hide tooltip, fire `onNodeUnhovered()` |
| Mouse moves to different bar | `S06 node.hovered` (new nodeId) | Switch row highlight, reset 300ms tooltip timer |
| Click on hovered bar | `S07 node.selected` | Promote hover to selection. Tooltip dismissed. |
| Scroll/zoom/pan starts | Previous base state | Cancel hover — tooltip would be mispositioned. Clear `_hoveredNodeId`. |

---

### S07: `node.selected`

**Overlay state** — combines with any `loaded.*` base state. Only one node can be selected at a time.

| Property | Value |
|----------|-------|
| **Entry** | Click on a bar, `Enter` on keyboard-focused row, or `highlightNode(id)` called programmatically from graph |
| **Selected bar** | 2px outline in `--accent`. Row background: `--accent-dim`. |
| **Selected label** | Text colour: `--accent`. Font weight: 600 (semibold). |
| **Graph cross-highlight** | `onNodeSelected(nodeId)` fires → graph pans to node + applies `--accent` selection glow |
| **Detail panel** | `DagStudio._onNodeSelected(nodeId)` opens Node Detail panel with metrics for selected node |
| **Exclusivity** | Selecting a new node deselects the previous one. `_selectedNodeId` is a scalar, not a set. |
| **Scroll-into-view** | If selected bar is not visible: smooth-scroll 200ms ease-out to centre the row vertically and bar horizontally |
| **Canvas** | Selected row repainted with `--accent-dim` fill. Outline drawn around bar with 2px `--accent` stroke. |
| **Keyboard** | `↑`/`↓`: move selection to adjacent row (wraps at boundaries). `Escape`: deselect. `←`/`→`: pan time. `Enter`: no-op (already selected). |
| **Data** | `_selectedNodeId` set. Previous selection cleared. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Click on different bar | `S07 node.selected` (new nodeId) | Deselect old row, select new row, fire `onNodeSelected(newId)` |
| Click on empty canvas area | Previous base state | Remove all selection styling, fire `onNodeSelected(null)`, close detail panel |
| `Escape` key | Previous base state | Same as clicking empty area |
| `↑`/`↓` key | `S07 node.selected` (adjacent nodeId) | Move selection to adjacent row with scroll-into-view |
| Different execution loaded | `S02 loading` | Selection cleared implicitly as canvas is wiped |
| Comparison mode entered | `S10 comparison.selecting` | Selection cleared |

---

### S08: `time.zooming`

**Overlay state** — user is actively zooming the time axis. Combines with any `loaded.*` base state.

| Property | Value |
|----------|-------|
| **Entry** | `Ctrl+mousewheel` event, pinch gesture (touch), or `+`/`-` key press |
| **Visual** | Time axis labels update smoothly. Bars resize horizontally around anchor point. Gridlines reflow. All on `--color-bg`. Tick labels in `--color-text-tertiary` recalculated at new scale — snap to nice intervals (1s, 5s, 10s, 30s, 1m, 5m, etc.). |
| **Anchor** | Wheel/pinch: zoom centred on cursor X position. Keyboard: zoom centred on viewport centre. |
| **Performance** | Must complete within 16ms per zoom step (one frame budget). Dirty-rect repaint only. |
| **Limits** | Min zoom: entire execution fits viewport width (`pxPerSec = canvasWidth / totalDuration`). Max zoom: 1 second fills viewport width. Clamped by `Math.clamp(_pxPerSec, minPx, maxPx)`. |
| **Canvas** | Full horizontal repaint on each zoom step — bars, gridlines, axis labels, selection/hover. |
| **Keyboard** | `+`/`=`: zoom in 20%. `-`/`_`: zoom out 20%. `0`: fit-all (transitions to `S17`). |
| **Data** | `_pxPerSec` updated per step. `_scrollX` adjusted to maintain anchor point. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| No scroll/key input for 150ms | Previous base state | Commit final zoom level to `_pxPerSec` |
| `0` key | `S17 time.fit_animating` | Animate to fit-all zoom (200ms ease-out) |
| Mouse button released (if pinch) | Previous base state | Commit zoom |

---

### S09: `time.panning`

**Overlay state** — user is panning the time axis horizontally. Combines with any `loaded.*` base state.

| Property | Value |
|----------|-------|
| **Entry** | `Shift+mousewheel`, click-drag on empty canvas area, or `←`/`→` arrow keys |
| **Visual** | Bars and gridlines shift horizontally. Time axis labels slide. All rendering on `--color-bg`. |
| **Cursor** | `grabbing` during mouse drag. Default cursor during keyboard pan. |
| **Bounds** | Cannot pan before `t = 0` or after execution end + 10% padding. Clamped by `Math.clamp(_scrollX, 0, maxScroll)`. |
| **Momentum** | Mouse drag: on release, velocity-based coast with friction factor 0.95 per frame, max 200ms deceleration. Keyboard: instant 10% viewport shift per key press, no momentum. |
| **Canvas** | Horizontal translate of all elements per frame during momentum. Full repaint when momentum stops. |
| **Keyboard** | `←`: pan left 10%. `→`: pan right 10%. `Home`: snap to `t = 0`. `End`: snap to execution end (or Now marker if live). |
| **Data** | `_scrollX` updated per frame. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse released + momentum decays to zero | Previous base state | Commit final `_scrollX` position |
| `Shift+mousewheel` stops for 150ms | Previous base state | Commit position |
| `Home` key | Previous base state | Snap `_scrollX` to 0 |
| `End` key | Previous base state | Snap `_scrollX` to execution end (or Now marker position) |

---

### S10: `comparison.selecting`

Intermediate state: comparison data is being fetched. The current Gantt is faded to indicate pending overlay.

| Property | Value |
|----------|-------|
| **Entry** | "Compare" button clicked in History table with exactly two rows selected |
| **Visual** | Current Gantt fades to 50% opacity (`filter: opacity(0.5)`). Loading spinner centred: rotating `◠` in `--accent`. Text below spinner: "Loading comparison..." in `--color-text-secondary`. All on `--color-bg`. |
| **Data fetch** | If one execution is already loaded, only fetch the second. Both `getDagExecMetrics()` calls fire in parallel via `Promise.all`. |
| **Canvas** | Existing bars remain visible at 50% opacity. Spinner is a DOM overlay, not canvas-drawn. |
| **Keyboard** | `Escape` cancels comparison and restores single-run view. No other shortcuts active. |
| **Data** | `_comparisonData` partially populated. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Both datasets loaded successfully | `S11 comparison.active` | Parse both, calculate unified time scale, render dual-bar view |
| One or both fetches fail | `S13 error` | Show error card with retry |
| User presses `Escape` | Previous `loaded.*` state | Abort fetch. Restore full opacity. Clear `_comparisonData`. |

---

### S11: `comparison.active`

Two executions are overlaid in comparison mode. Each node row shows two bars with timing diff badges.

| Property | Value |
|----------|-------|
| **Entry** | Both comparison datasets successfully loaded and parsed |
| **Row height** | 48px (doubled from 28px): Bar A rendered in top half, Bar B in bottom half, 4px gap between. |
| **Bar A (older)** | Solid fill at 0.5 opacity. Status colour per execution state. `A` badge: 10px mono text in `--color-text-tertiary` left of label. |
| **Bar B (newer)** | Striped fill (diagonal 45° pattern, 4px stripe) at 0.7 opacity. `B` badge: 10px mono text in `--color-text-secondary` left of label. |
| **Timing badges** | Improvement (B faster by >10%): green pill `▾ −{diff}` in `--status-succeeded`. Regression (B slower by >10%): red pill `▴ +{diff}` in `--status-failed`. Within 10%: no badge. |
| **Missing nodes** | Single bar with `(only in A)` or `(only in B)` suffix on label in `--color-text-tertiary`. Muted 0.3 opacity. |
| **Status changes** | Label column shows `A:● → B:●` transition pill. Dots coloured by respective status token. |
| **Summary footer** | `Run A: {dur} ● {status} │ Run B: {dur} ● {status} │ Δ {diff} ({pct}%) │ {n} regressions │ {m} new failures` |
| **Time axis** | Scaled to the longer of the two runs. Labels in `--color-text-tertiary`. |
| **Node sort** | By Run B layer index, then start time. Nodes only in Run A appended at bottom with `--color-text-tertiary` labels. |
| **Canvas** | Static render (no animation). Double row height requires vertical scroll recalculation. |
| **Keyboard** | `↑`/`↓`: navigate rows. `Escape` or `Q`: exit comparison. `Enter`: select row for detail. Zoom/pan active. |
| **Data** | `_isComparing === true`. `_comparisonData` populated with `[RunA, RunB]`. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| "Exit Compare" button clicked | `S03 loaded.idle` (with Run B data) | Animate row height 48→28px (200ms ease-out). Remove A bars. Set `_isComparing = false`. |
| `Escape` key | `S03 loaded.idle` (with Run B data) | Same as above |
| Click a comparison bar | `S07 node.selected` (overlay) | Select node. Detail panel shows the clicked run's data. |
| Different execution loaded from History | `S02 loading` | Exit comparison. `_isComparing = false`. Load new single execution. |
| Hover a comparison row | `S06 node.hovered` (overlay) | Highlight both A and B bars. If >10% diff: transition to `S19`. |

---

### S12: `resize.dragging`

**Overlay state** — user is dragging the split handle between DAG graph (top) and Gantt panel (bottom).

| Property | Value |
|----------|-------|
| **Entry** | Mousedown on the drag handle (8px horizontal bar between graph and Gantt). Handle border: 1px `--color-border`. |
| **Active handle** | Handle background changes to `--accent` at 0.3 opacity. Cursor: `row-resize` on the handle and entire viewport during drag. |
| **Visual** | Graph panel and Gantt panel resize in real-time following mouse Y position. Gantt canvas resizes on each frame. Bar positions recalculated. Time axis reflows. |
| **Constraints** | Min top panel height: 120px. Min bottom panel height: 80px. Mouse position clamped to these limits. |
| **Performance** | Canvas resize is expensive — throttle repaint to every 2nd frame (30fps effective) during drag. Full quality repaint on release. |
| **Canvas** | `canvas.width` / `canvas.height` updated per throttled frame. Bars and labels redrawn at new dimensions. |
| **Keyboard** | `Escape` cancels drag and reverts to pre-drag ratio. No other keys active during drag. |
| **Data** | `_splitRatio` updated per frame (0.0 = all bottom, 1.0 = all top). |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse released | Previous base state | Commit `_splitRatio`. Persist to `localStorage('edog.dagStudio.splitRatio')`. Handle returns to `--color-border`. Final canvas resize at full quality. |
| `Escape` during drag | Previous base state | Revert to pre-drag `_splitRatio`. Cancel. Handle returns to `--color-border`. |

---

### S13: `error`

An error occurred loading or rendering execution data. Error card is shown with actionable message and retry.

| Property | Value |
|----------|-------|
| **Entry** | API fetch failure, parse error, canvas context loss, timeout |
| **Visual** | Error card centred in Gantt area on `--color-bg`. Card: `--color-bg` background with light red tint (`rgba(229,69,59,0.04)`), 1px solid `--status-failed` border at 0.3 opacity, 8px radius, `box-shadow: 0 2px 12px rgba(0,0,0,0.06)`. |
| **Icon** | `✕` in a 32px circle: circle border `--status-failed` at 0.4 opacity, `✕` glyph in `--status-failed`, 16px. |
| **Message** | Title: error heading in `--color-text` at 14px semibold. Body: description in `--color-text-secondary` at 13px. See table below. |
| **Retry button** | Ghost button: 1px `--accent` border, `--accent` text, `--color-bg` background. Hover: `--accent-dim` background. 32px height, 12px padding. Keyboard-focusable with `--accent-glow` focus ring. |
| **Canvas** | Blank (cleared) or frozen at last good state depending on error type. Error card is DOM overlay. |
| **Keyboard** | `Enter` or `Space` on focused retry button triggers retry. `Escape` dismisses to `S01`. `Tab` cycles between retry and dismiss. |
| **Data** | Error object stored: `{ code: string, message: string, retryable: boolean }`. |

**Error messages by type:**

| Error Code | Title | Body |
|------------|-------|------|
| `NETWORK` | "Could not load execution data" | "Check your network connection and try again." + [Retry] |
| `HTTP_404` | "Execution not found" | "It may have been garbage collected or the ID is invalid." |
| `HTTP_401` | "Session expired" | "Re-authenticate to continue." (no retry — redirect to login) |
| `HTTP_403` | "Access denied" | "You do not have permission to view this execution." |
| `HTTP_429` | "Rate limited" | "Retrying in {n}s..." (auto-retry countdown, no manual retry) |
| `HTTP_5XX` | "FLT service error" | Error details from response body + [Retry] |
| `PARSE` | "Invalid execution data" | "The server returned data in an unexpected format." + [Retry] |
| `CANVAS` | "Gantt chart unavailable" | "Your browser does not support Canvas rendering." (no retry) |
| `TIMEOUT` | "Load timed out" | "The execution may be very large. Try again or select a smaller execution." + [Retry] |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Retry button clicked | `S02 loading` | Re-fetch execution data |
| HTTP 429 auto-retry timer expires | `S02 loading` | Automatic re-fetch |
| User clicks different execution in History | `S02 loading` | Dismiss error card, load new execution |
| Dismiss button / `Escape` | `S01 empty` | Clear error, return to empty state |
| Component destroyed | — | Clean up timers, abort pending fetch |

---

### S14: `disconnected`

WebSocket connection lost during a live execution. Bars freeze. Reconnection is attempted automatically.

| Property | Value |
|----------|-------|
| **Entry** | Global WebSocket `onclose` / `onerror` detected while in `S04 loaded.executing` or `S05 loaded.executing.paused` |
| **Visual** | Bars frozen at last known width. Amber banner at top of Gantt panel: `--color-bg` background with light amber tint (`rgba(229,148,12,0.06)`), 1px solid `--status-cancelled` border at 0.4 opacity. Banner text: "Connection lost — execution data may be stale. Reconnecting..." in `--color-text`. Pulsing `◠` indicator in `--status-cancelled`. |
| **Now marker** | Frozen at last known position. No longer advances. |
| **Animation** | Stopped — `cancelAnimationFrame`. No bar growth. |
| **Data** | Last known state preserved in `_sortedNodes`. No new updates arriving. `_disconnectedAt` timestamp saved for timeout tracking. |
| **Canvas** | Static. Bars rendered at frozen widths. Banner is DOM overlay above canvas. |
| **Keyboard** | Navigation active on frozen bars. `R` key: manual reconnect attempt. `Escape`: dismiss banner (accept stale data). |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| WebSocket reconnects | `S02 loading` | Re-fetch current execution to reconcile state. Dismiss banner. |
| User clicks different execution in History | `S02 loading` | Dismiss banner. Load new execution. |
| User dismisses banner (`Escape` or dismiss `✕`) | `S03 loaded.idle` | Freeze bars as-is. User accepts stale data. Banner hidden. |
| 60s timeout without reconnect | `S13 error` | Show "Connection lost. [Retry] to reconnect." error card. |

---

### S15: `loaded.idle.empty_execution`

Special sub-state of `loaded.idle`: execution loaded successfully but contained zero nodes.

| Property | Value |
|----------|-------|
| **Entry** | Execution data loaded, `nodeExecutionMetrices` is an empty map / zero-length array |
| **Visual** | Gantt area on `--color-bg`. Centred message: "Empty execution — no nodes were executed" in `--color-text-secondary` at 13px. Dashed border rectangle: 1px dashed `--color-border`, 8px radius. Same layout as `S01` but with execution-specific message. |
| **Summary footer** | `Σ {duration} │ 0/0 nodes │ ● {status}` in `--color-text-tertiary`. Status dot coloured by execution outcome. |
| **Time axis** | Visible: 0s to execution duration (if available). Ticks in `--color-text-tertiary`. No bars to render. |
| **Canvas** | Cleared. Centred text drawn via `fillText`. No gridlines. |
| **Keyboard** | `Tab`: move focus to History tab. No row navigation (no rows). Zoom/pan disabled (no content). |
| **Data** | `_executionData` populated. `_sortedNodes.length === 0`. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| User clicks different execution in History | `S02 loading` | Load new execution |
| AutoDetector detects live execution for same DAG | `S04 loaded.executing` | Transition to live mode, start animation |

---

### S16: `loaded.node_appearing`

**Transient state** (150ms) — a new node bar is inserting during live execution. Provides visual continuity.

| Property | Value |
|----------|-------|
| **Entry** | `updateBar(nodeId, metrics)` called for a `nodeId` not yet in `_sortedNodes` |
| **Duration** | 150ms total transition time |
| **Visual** | New row slides into correct sort position from zero height to 28px. Existing rows below shift down via `transform: translateY()` with 150ms ease timing. New bar fades from opacity 0 → 1 over the first 100ms. Bar initially rendered at current elapsed width. Row background: `--color-bg` (odd) or `--color-bg-secondary` (even). |
| **Auto-scroll** | If new row is below the visible viewport: do NOT auto-scroll (avoids jank during rapid node starts). **Exception:** if new node has `status === 'failed'`, auto-scroll to the failed row to draw attention. |
| **Canvas** | Incremental repaint: only the new row and rows below it are repainted during transition. Rows above are untouched. |
| **Keyboard** | No change — current keyboard focus is preserved. If a row was selected, selection index may shift. |
| **Data** | `_sortedNodes` updated immediately. Visual position catches up over 150ms. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| 150ms animation completes | `S04 loaded.executing` | Row fully integrated. Bar enters normal animation loop. |

---

### S17: `time.fit_animating`

**Transient state** (200ms) — time axis is animating to fit-all zoom level. Smooth zoom-out to show entire execution.

| Property | Value |
|----------|-------|
| **Entry** | `0` key pressed, `setTimeZoom('fit')` called, or double-click on time axis |
| **Duration** | 200ms ease-out (`cubic-bezier(0, 0, 0.2, 1)`) |
| **Visual** | `_pxPerSec` smoothly interpolates from current value to fit-all value. Bars resize fluidly each frame. Tick marks recalculate and transition. `_scrollX` animates to 0. All rendering on `--color-bg`. Labels in `--color-text-tertiary`. |
| **Canvas** | Full repaint each frame during animation (16ms budget per frame × ~12 frames). |
| **Keyboard** | Zoom/pan input during animation cancels it and transitions to the interrupting state. |
| **Data** | `_pxPerSec` interpolated. `_scrollX` interpolated to 0. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Animation completes (200ms) | Previous base state | Commit final `_pxPerSec` and `_scrollX = 0` |
| User interrupts with Ctrl+wheel / +/- | `S08 time.zooming` | Cancel animation. Apply zoom from interrupt point. |
| User interrupts with Shift+wheel / drag | `S09 time.panning` | Cancel animation. Apply pan from interrupt point. |

---

### S18: `time.auto_extending`

**Transient state** (200ms) — time axis automatically extends during live execution to keep the Now marker visible.

| Property | Value |
|----------|-------|
| **Entry** | Now marker reaches 85% of canvas width (`_nowMarkerX / canvasWidth > 0.85`) during `S04` |
| **Duration** | 200ms ease transition (`cubic-bezier(0.4, 0, 0.2, 1)`) |
| **Visual** | Time scale compresses smoothly: `_pxPerSec` reduces to provide 30% headroom beyond current Now position. All bars shrink horizontally in sync. New gridlines and tick labels appear at the right edge. Rendering on `--color-bg`. |
| **Canvas** | Full horizontal repaint each frame. Now marker continues advancing during transition. |
| **Keyboard** | No change — navigation remains active. |
| **Data** | `_pxPerSec` interpolated to new value. `_scrollX` adjusted to keep visible content stable. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Scale transition completes (200ms) | `S04 loaded.executing` | Continue animation loop at new `_pxPerSec` |
| Execution completes during transition | `S03 loaded.idle` | Complete transition, then stop animation. Show final state. |

---

### S19: `comparison.hover_diff`

**Overlay state** within `S11 comparison.active` — user hovers a node row that has >10% timing difference between runs.

| Property | Value |
|----------|-------|
| **Entry** | Mouse hovers a row in `S11 comparison.active` where `abs(durationB - durationA) / durationA > 0.10` |
| **Visual** | Both A and B bars highlighted with `--color-bg-tertiary` row background. Timing diff badge enlarged from 10px to 12px and emboldened. Tooltip shows detailed comparison. |
| **Tooltip** | Card in `--color-bg`, 1px `--color-border`, 4px radius. Content: "Run A: {durA} ({statusA}) → Run B: {durB} ({statusB})". Delta line: "{diff}s ({pct}%) {faster/slower}" coloured `--status-succeeded` (faster) or `--status-failed` (slower). If ratio > 2×: shows "N× slower/faster" instead. |
| **Graph** | `onNodeHovered(nodeId)` fires — graph canvas highlights the corresponding node |
| **Canvas** | Row background repainted. Badge redrawn at enlarged size. Tooltip is DOM overlay. |
| **Keyboard** | Not applicable — pointer-only interaction. |
| **Data** | `_hoveredNodeId` set. Diff calculation: `(durationB - durationA) / durationA * 100`. |

**Transitions out:**

| Trigger | Target | Action |
|---------|--------|--------|
| Mouse leaves row | `S11 comparison.active` | Remove row highlight, hide tooltip, fire `onNodeUnhovered()` |
| Mouse moves to different row | `S19 comparison.hover_diff` (new row) or `S06 node.hovered` (if <10% diff) | Switch highlight, recalculate diff |
| Click on row | `S07 node.selected` (within comparison context) | Select node for detail view of clicked run |

---

## 4. State × Action Matrix

How each user action is handled depending on the current base state. Overlay states are additive.

| Action | `S01 empty` | `S02 loading` | `S03 loaded.idle` | `S04 loaded.executing` | `S13 error` | `S14 disconnected` | `S15 empty_exec` |
|--------|-------------|---------------|--------------------|-----------------------|-------------|--------------------|--------------------|
| **Hover bar** | — | — | → `S06` overlay | → `S06` overlay | — | → `S06` overlay (frozen bars) | — |
| **Click bar** | — | — | → `S07` overlay | → `S07` overlay | — | → `S07` overlay | — |
| **Click empty** | — | — | Deselect → base | Deselect → base | — | Deselect → base | — |
| **Ctrl+wheel** | — | — | → `S08` overlay | → `S08` overlay | — | → `S08` overlay | — |
| **+/- keys** | — | — | → `S08` overlay | → `S08` overlay | — | → `S08` overlay | — |
| **Shift+wheel** | — | — | → `S09` overlay | → `S09` overlay | — | → `S09` overlay | — |
| **←/→ keys** | — | — | → `S09` overlay | → `S09` overlay | — | → `S09` overlay | — |
| **↑/↓ keys** | Tab to History | — | Move row focus | Move row focus | — | Move row focus | — |
| **0 key** | — | — | → `S17` transient | → `S17` transient | — | → `S17` transient | — |
| **Home** | — | — | Pan to t=0 | Pan to t=0 | — | Pan to t=0 | — |
| **End** | — | — | Pan to end | Pan to Now marker | — | Pan to frozen Now | — |
| **Enter** | — | — | Select focused row | Select focused row | Retry (if btn focused) | Select focused row | — |
| **Escape** | — | — | Deselect / exit compare | Deselect | Dismiss → `S01` | Dismiss banner → `S03` | — |
| **Tab** | Focus History | — | Focus next panel | Focus next panel | Cycle buttons | Focus next panel | Focus History |
| **Load execution** | → `S02` | — (ignored) | → `S02` | → `S02` | → `S02` | → `S02` | → `S02` |
| **Compare** | — | — | → `S10` | — | — | — | — |
| **Drag handle** | → `S12` | — | → `S12` overlay | → `S12` overlay | — | → `S12` overlay | → `S12` |
| **Retry click** | — | — | — | — | → `S02` | — | — |
| **R key** | — | — | — | — | — | Manual reconnect | — |
| **renderExec(null)** | No-op | — | → `S01` | → `S01` | → `S01` | → `S01` | → `S01` |

---

## 5. Compound State Rules

Overlay and transient states layer on top of lifecycle base states. These rules govern combinations.

| Rule | Description |
|------|-------------|
| **R1** | Exactly one lifecycle base state is active at all times: `S01`, `S02`, `S03`, `S04`, `S05`, `S13`, `S14`, or `S15`. |
| **R2** | Overlay states (`S06`–`S12`, `S19`) are only valid when the base state is `S03`, `S04`, or `S14`. Never on `S01`, `S02`, `S13`, `S15`. |
| **R3** | `S06 node.hovered` and `S07 node.selected` can coexist — hovering a different row while one is selected is allowed. |
| **R4** | `S06 node.hovered` and `S08 time.zooming` cannot coexist — zoom cancels hover (tooltip would be mispositioned). |
| **R5** | `S06 node.hovered` and `S09 time.panning` cannot coexist — pan cancels hover. |
| **R6** | `S07 node.selected` persists through `S08 time.zooming` and `S09 time.panning` — selection is not affected by zoom/pan. |
| **R7** | `S11 comparison.active` and `S07 node.selected` can coexist — clicking a bar in comparison mode selects it. |
| **R8** | `S11 comparison.active` and `S04 loaded.executing` cannot coexist — comparison is static-only. |
| **R9** | `S12 resize.dragging` suppresses all other overlays during drag — hover, selection, zoom, pan are ignored while dragging. |
| **R10** | Transient states (`S16`, `S17`, `S18`) auto-resolve after their animation duration. They cannot be "stuck". |
| **R11** | `S16 loaded.node_appearing` only occurs during `S04 loaded.executing`. |
| **R12** | `S18 time.auto_extending` only occurs during `S04 loaded.executing`. |
| **R13** | `S19 comparison.hover_diff` only occurs during `S11 comparison.active`. |
| **R14** | `S05 loaded.executing.paused` is invisible — no overlays apply. On resume, queued overlays are discarded. |

---

## 6. Transition Matrix

Complete mapping of every state-to-state transition, including guards and side effects.

| From | To | Trigger | Guard | Side Effect |
|------|----|---------|-------|-------------|
| `S01` | `S02` | `renderExecution()` | Data is non-null | Show skeleton UI, initiate fetch |
| `S02` | `S03` | Data received | Status is terminal | Parse nodes, calculate time scale, render static bars |
| `S02` | `S04` | Data received | Status is `running` | Parse nodes, start `requestAnimationFrame` loop |
| `S02` | `S15` | Data received | Node map is empty | Show empty execution message |
| `S02` | `S13` | Fetch failed | — | Show error card with message from table |
| `S02` | `S14` | WebSocket drops | Was in connected mode | Show amber disconnect banner |
| `S03` | `S02` | New execution selected | — | Clear canvas, fetch new |
| `S03` | `S04` | AutoDetector fires | Same DAG, live execution | Start animation loop |
| `S03` | `S10` | Compare triggered | Two executions in History | Fetch second dataset |
| `S03` | `S01` | `renderExecution(null)` | — | Clear all content |
| `S04` | `S03` | Execution completes | All nodes terminal | Stop animation, hide Now marker |
| `S04` | `S14` | WebSocket drops | — | Freeze bars, show banner |
| `S04` | `S02` | New execution selected | — | Stop animation, clear, fetch |
| `S04` | `S05` | Gantt tab hidden | Tab switch event | Pause `requestAnimationFrame` |
| `S04` | `S01` | `renderExecution(null)` | — | Stop animation, clear canvas |
| `S05` | `S04` | Gantt tab shown | — | Resume animation, flush pending |
| `S05` | `S03` | Execution completes while paused | — | Render static on next tab show |
| `S05` | `S14` | WebSocket drops while paused | — | Queued for tab show |
| `S10` | `S11` | Both datasets loaded | — | Render dual-bar view |
| `S10` | `S13` | Fetch fails | — | Show error card |
| `S10` | Previous `loaded.*` | `Escape` | — | Abort fetch, restore single view |
| `S11` | `S03` | Exit Compare / `Escape` | — | Animate rows 48→28px, remove A bars |
| `S11` | `S02` | New execution from History | — | Exit compare, load new |
| `S13` | `S02` | Retry clicked | — | Re-fetch execution |
| `S13` | `S02` | 429 timer expires | — | Auto re-fetch |
| `S13` | `S02` | Different execution selected | — | Dismiss error, fetch new |
| `S13` | `S01` | Dismiss / `Escape` | — | Clear error state |
| `S14` | `S02` | WebSocket reconnects | — | Re-fetch to reconcile |
| `S14` | `S03` | User dismisses banner | — | Accept stale data |
| `S14` | `S13` | 60s timeout | — | Escalate to error |
| `S14` | `S02` | Different execution selected | — | Dismiss banner, fetch new |
| `S15` | `S02` | Different execution selected | — | Load new execution |
| `S15` | `S04` | AutoDetector fires live execution | Same DAG | Start animation loop |
| Any `loaded.*` | `S06` (overlay) | Mouse enters bar | `_hitTest` succeeds | Highlight row, start tooltip timer |
| `S06` | Base state | Mouse leaves bar | — | Remove highlight, hide tooltip |
| Any `loaded.*` | `S07` (overlay) | Click bar / `Enter` | — | Highlight bar, fire `onNodeSelected` |
| `S07` | Base state | Click empty / `Escape` | — | Clear selection, fire `onNodeSelected(null)` |
| Any `loaded.*` | `S08` (overlay) | Ctrl+wheel / +/− | — | Adjust `_pxPerSec` |
| `S08` | Base state | 150ms idle | — | Commit zoom |
| Any `loaded.*` | `S09` (overlay) | Shift+wheel / drag / ←/→ | — | Adjust `_scrollX` |
| `S09` | Base state | Release / idle | — | Commit scroll position |
| Any `loaded.*` | `S12` (overlay) | Mousedown on handle | — | Begin resize interaction |
| `S12` | Base state | Mouseup | — | Persist `_splitRatio` to localStorage |
| `S12` | Base state | `Escape` | — | Revert to pre-drag ratio |
| `S04` | `S16` (transient) | New node bar created | Node not in `_sortedNodes` | Insert row with 150ms slide |
| `S16` | `S04` | 150ms done | — | Row integrated into loop |
| Any `loaded.*` | `S17` (transient) | `0` key / `setTimeZoom('fit')` | — | Animate to fit-all |
| `S17` | Base state | 200ms done | — | Commit zoom level |
| `S04` | `S18` (transient) | Now marker at 85% width | — | Compress scale with headroom |
| `S18` | `S04` | 200ms done | — | Continue at new scale |
| `S11` | `S19` (overlay) | Hover row with >10% diff | In comparison mode | Show diff tooltip |
| `S19` | `S11` | Mouse leaves row | — | Remove highlight |

---

## 7. State Invariants

Rules that must hold true regardless of current state. Violations are bugs.

| # | Invariant | Enforcement |
|---|-----------|-------------|
| 1 | Only one node can be selected at a time | `_selectedNodeId` is a scalar value, not a Set |
| 2 | Only one node can be hovered at a time | `_hoveredNodeId` replaces on change, never appends |
| 3 | Animation loop runs only in `S04` (not `S05 paused`) | Guard: `_isAnimating && _isVisible` checked every `requestAnimationFrame` callback |
| 4 | Canvas is never drawn to when component is not visible | `_isVisible` flag checked before any render / `fillRect` / `strokeRect` call |
| 5 | Time scale `_pxPerSec` is always > 0 | `Math.max(MIN_PX_PER_SEC, value)` in all zoom calculations |
| 6 | Comparison mode requires exactly 2 runs | `renderComparison()` throws if argument count ≠ 2 |
| 7 | Bars never render with negative width | `Math.max(MIN_BAR_WIDTH, calculated)` before every `fillRect` |
| 8 | Tooltip never outlives its hover | Tooltip hidden on: mouseout, scroll, zoom, pan, tab switch, destroy |
| 9 | `destroy()` always cancels animation frame | `cancelAnimationFrame(this._rafId)` called in `destroy()` |
| 10 | Overlay states never change the base state | `_overlayFlags` object is independent of `_baseState` string |
| 11 | Transient states auto-resolve within their duration | `setTimeout` / `requestAnimationFrame` callback guarantees exit |
| 12 | `_scrollX` is never negative | `Math.max(0, value)` on every assignment |

---

## 8. State → CSS Class Mapping

DOM classes applied to the Gantt container element (`div.dag-gantt`) for styling hooks.

| State | CSS Class(es) | Purpose |
|-------|---------------|---------|
| `S01 empty` | `.dag-gantt--empty` | Centres placeholder message, hides canvas |
| `S02 loading` | `.dag-gantt--loading` | Shows shimmer skeleton overlay |
| `S03 loaded.idle` | `.dag-gantt--loaded` | Standard layout, canvas visible |
| `S04 loaded.executing` | `.dag-gantt--loaded .dag-gantt--executing` | Enables Now marker, pulse animations |
| `S05 loaded.executing.paused` | `.dag-gantt--loaded .dag-gantt--executing .dag-gantt--paused` | `animation-play-state: paused` on CSS animations |
| `S11 comparison.active` | `.dag-gantt--loaded .dag-gantt--comparing` | Doubles row height, shows A/B badge containers |
| `S13 error` | `.dag-gantt--error` | Shows error card overlay, hides canvas |
| `S14 disconnected` | `.dag-gantt--loaded .dag-gantt--disconnected` | Shows amber banner at top |
| `S15 empty_execution` | `.dag-gantt--loaded .dag-gantt--empty-exec` | Centres "no nodes" message over blank canvas |
| `S12 resize.dragging` | `.dag-gantt--resizing` (on parent `.dag-studio`) | Disables pointer-events on canvas, shows `row-resize` cursor globally |

---

## 9. State → `DagGantt` Properties

Internal state properties maintained by the `DagGantt` class instance.

| Property | Type | Default | Updated By |
|----------|------|---------|------------|
| `_baseState` | `string` | `'empty'` | State transition logic (all `S01`–`S15` transitions) |
| `_executionData` | `DagExecutionInstance?` | `null` | `renderExecution()` |
| `_comparisonData` | `[DagExecutionInstance, DagExecutionInstance]?` | `null` | `renderComparison()` |
| `_sortedNodes` | `Array<{id, name, layer, metrics}>` | `[]` | `_sortNodes()` after data load |
| `_selectedNodeId` | `string?` | `null` | Click / keyboard / `highlightNode()` |
| `_hoveredNodeId` | `string?` | `null` | `mousemove` → `_hitTest()` |
| `_pxPerSec` | `number` | `0` | `_calculateTimeScale()` / zoom input |
| `_scrollX` | `number` | `0` | Pan / zoom offset |
| `_scrollY` | `number` | `0` | Vertical scroll (synced with label column) |
| `_isAnimating` | `boolean` | `false` | `S04` entry sets `true`, `S03`/`S01` entry sets `false` |
| `_isVisible` | `boolean` | `true` | Tab visibility change events |
| `_isComparing` | `boolean` | `false` | `S11` entry sets `true`, exit sets `false` |
| `_rafId` | `number?` | `null` | `requestAnimationFrame` return value |
| `_splitRatio` | `number` | `0.6` | Drag handle / `localStorage` |
| `_canvasCtx` | `CanvasRenderingContext2D?` | `null` | Constructor |
| `_hatchPattern` | `CanvasPattern?` | `null` | `_createPatternCanvases()` |
| `_stripePattern` | `CanvasPattern?` | `null` | `_createPatternCanvases()` |
| `_tooltipTimer` | `number?` | `null` | 300ms hover debounce timer |
| `_execStartTime` | `number` | `0` | From execution metrics on data load |
| `_nowMarkerTime` | `number` | `0` | Updated each animation frame in `S04` |
| `_pendingUpdates` | `Array<BarUpdate>` | `[]` | `updateBar()` calls during `S05` (paused) |
| `_disconnectedAt` | `number?` | `null` | WebSocket disconnect timestamp for 60s timeout |
| `_overlayFlags` | `{hovered, selected, zooming, panning, resizing, comparing}` | All `false` | Overlay state enter/exit |
