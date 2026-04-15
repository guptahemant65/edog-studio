# Gantt Chart — Component Deep Spec

> **Feature:** F08 DAG Studio — Section 2.3
> **Owner:** Pixel (Frontend) · Reviewed by Sana (Architecture)
> **Status:** SPEC PHASE
> **Prerequisite:** `research/p0-foundation.md` (NodeExecutionMetrics model)
> **Rendering Decision:** Canvas 2D for bar grid + DOM overlay for axis labels/tooltips — settled.

---

## 1. Purpose

The Gantt chart is the timing panel beneath the DAG graph canvas. It answers the question every FLT engineer asks during and after a DAG run: **"Which nodes ran when, for how long, and what ran in parallel?"**

It shows per-node execution as horizontal bars on a shared time axis. During live execution, bars grow in real-time. During historical review, the full timeline renders instantly. In comparison mode, two runs overlay so regressions jump off the screen.

---

## 2. Layout Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ DAG Graph Canvas (top 60%)                                          │
├═══════════════════ drag handle (8px, cursor: row-resize) ═══════════┤
│ Tab Bar: [Gantt] [History] [Detail]                                 │
│┌────────────┬───────────────────────────────────────────────────────┐│
││ Node Labels │ Canvas: Bar Grid + Time Axis                        ││
││ (fixed 160px)│                                                     ││
││             │  ┌──────────┐                                       ││
││ SourceA     │  │██████████│                                       ││
││ SourceB     │  │████████████████│                                  ││
││ Transform1  │       │██████████████│                               ││
││ Transform2  │       │████████│                                     ││
││ MergeStep   │                  │███████████████████│               ││
││ FinalView   │                                     │██████│        ││
││             │  ──┼────┼────┼────┼────┼────┼────┼── ▼ Now          ││
││             │  0s   5s  10s  15s  20s  25s  30s  35s              ││
│└────────────┴───────────────────────────────────────────────────────┘│
│  Σ 35.2s │ 6/8 nodes │ max ∥ 3 │ ● Running                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Structural Regions

| Region | Implementation | Size | Scroll |
|--------|---------------|------|--------|
| **Node label column** | DOM `<div>` list | Fixed 160px width | Vertical — synced with bar grid |
| **Bar grid** | Canvas 2D `<canvas>` | Fills remaining width | Vertical + horizontal (time axis) |
| **Time axis** | DOM overlay positioned over canvas top | Fixed 24px height | Horizontal — synced with bar grid |
| **Summary footer** | DOM `<div>` | Fixed 28px height | None |
| **Drag handle** | DOM `<div>` between graph and panel | 8px height | None |

### 2.2 Dimensions (4px Grid)

| Element | Value | Notes |
|---------|-------|-------|
| Row height | 28px | 4px padding top + 20px bar + 4px padding bottom |
| Bar height | 20px | Within row |
| Bar corner radius | 4px | Consistent with card styling |
| Label column width | 160px | Truncated with `…` if name exceeds |
| Time axis height | 24px | Tick labels in `--color-text-secondary` |
| Footer height | 28px | Summary stats |
| Minimum bar width | 3px | Below this: render as a 3px sliver, full info in tooltip |
| Layer gap | 4px | Hairline between layer groups |

---

## 3. Time Axis

### 3.1 Auto-Scaling Algorithm

The time axis scales automatically based on execution duration to avoid illegible tick bunching or wasteful whitespace.

```
function calculateTimeScale(startTime, endTime, canvasWidth) {
    const totalMs = endTime - startTime
    const totalSec = totalMs / 1000

    // Choose unit
    if (totalSec < 120)       unit = 'seconds'
    else if (totalSec < 7200) unit = 'minutes'
    else                      unit = 'hours'

    // Choose tick interval: target 8–15 ticks visible
    const targetTicks = 12
    const rawInterval = totalSec / targetTicks
    const niceIntervals = {
        seconds: [1, 2, 5, 10, 15, 30],
        minutes: [60, 120, 300, 600, 900, 1800],
        hours:   [3600, 7200, 14400]
    }
    // Snap to nearest nice interval
    tickInterval = snapToNearest(rawInterval, niceIntervals[unit])

    // Pixels per second
    pxPerSec = canvasWidth / totalSec

    return { unit, tickInterval, pxPerSec, totalSec }
}
```

### 3.2 Tick Rendering

| Duration Range | Unit | Tick Examples | Label Format |
|----------------|------|---------------|--------------|
| < 2 min | Seconds | 0s, 5s, 10s, 15s … | `{n}s` |
| 2 min – 2 hr | Minutes | 0:00, 0:30, 1:00, 1:30 … | `{m}:{ss}` |
| > 2 hr | Hours | 0:00, 1:00, 2:00 … | `{h}:{mm}` |

**Tick rendering details:**

- Major ticks: full-height hairline (`--color-border`, 1px, 0.3 opacity) — at every labelled interval
- Minor ticks: half-height hairline (0.15 opacity) — subdivisions between major ticks
- Labels: 11px `--font-mono`, `--color-text-secondary`, centered below tick
- Zero label: "0s" at the left edge, anchored

### 3.3 "Now" Marker (Live Execution)

During active execution, a vertical marker shows current wall-clock time:

| Property | Value |
|----------|-------|
| Line | 1.5px solid `--color-accent` (OKLCH blue), full grid height |
| Label | "Now" badge: 11px, `--color-accent` background, white text, pinned to time axis row |
| Animation | `requestAnimationFrame` — moves rightward at real-time pace (1px per pxPerSec) |
| Beyond viewport | Marker clamps to right edge with a `▸` arrow indicator and elapsed time label |

### 3.4 Total Duration Label

- Positioned at the right end of the time axis
- Format: `Σ {duration}` (e.g., `Σ 1m 23s`)
- During live execution: updates every frame
- Color: `--color-text-primary`

---

## 4. Node Bars

### 4.1 Sort Order

Nodes are sorted top-to-bottom by:

1. **Layer** (from Sugiyama layout) — source layer first, then each subsequent layer
2. **Start time within layer** — earlier-started nodes first
3. **Alphabetical** as tiebreaker within same layer + start time

Layer grouping makes parallelism visually obvious: nodes in the same layer that started near-simultaneously appear as stacked bars at the same horizontal position.

### 4.2 Visual Encoding

| Status | Fill | Pattern | Opacity | Border | Animation |
|--------|------|---------|---------|--------|-----------|
| **Completed** | `oklch(0.70 0.18 145)` — green | Solid | 0.85 | None | None |
| **Running** | `oklch(0.65 0.18 250)` — blue | Solid | 0.90 | None | Pulse: opacity oscillates 0.7–1.0 over 1.5s. Bar width grows rightward. |
| **Failed** | `oklch(0.60 0.22 25)` — red | Diagonal hatch (45°, 3px spacing) | 0.85 | None | None |
| **Cancelled** | `oklch(0.72 0.15 85)` — amber | Vertical stripe (4px spacing) | 0.75 | None | None |
| **Cancelling** | `oklch(0.72 0.15 85)` — amber | Vertical stripe | 0.75 | 1px dashed `--color-border` | Pulse: slow opacity oscillation |
| **Skipped** | `oklch(0.45 0.00 0)` — grey | Solid | 0.40 | 1px dotted `--color-border` | None |
| **Pending** | None (empty row) | — | — | 1px dashed `--color-border` at row midline | None |
| **None** | None (empty row) | — | — | Grey dashed midline | None |

### 4.3 Bar Content (Adaptive)

Content inside a bar adapts based on available pixel width:

| Bar Width | Content Rendered |
|-----------|-----------------|
| ≥ 120px | Node name (truncated) + duration (e.g., `SourceA  2.3s`) |
| 60–119px | Duration only (e.g., `2.3s`) |
| 20–59px | Duration abbreviated (e.g., `2s`) |
| 3–19px | Nothing inside — tooltip only |
| < 3px | 3px minimum-width sliver — tooltip only |

**Text rendering on canvas:**
- Font: 11px `--font-mono`
- Color: white (`oklch(1.00 0 0)`) with 1px shadow for contrast on colored bars
- Alignment: left-padded 6px from bar left edge, vertically centered
- Overflow: clip at bar right edge minus 4px

### 4.4 Bar Positioning

```
barX      = (node.startedAt - execution.startedAt) * pxPerSec
barWidth  = node.duration * pxPerSec  // or (now - node.startedAt) if running
barY      = rowIndex * ROW_HEIGHT + ROW_PADDING_TOP
barHeight = BAR_HEIGHT  // 20px
```

For running nodes: `barWidth` recalculates every animation frame to produce the growth effect.

---

## 5. Parallelism Visualization

### 5.1 Layer Grouping

Nodes from the same DAG layer that overlap in time are stacked vertically, visually demonstrating concurrent execution:

```
Layer 1: ├──SourceA──────┤├──SourceB─────────┤├──SourceC────┤
Layer 2:                  ├──Transform1────────┤
                          ├──Transform2──────┤
Layer 3:                                       ├──Merge──────────────┤
```

A thin horizontal separator (1px, `--color-border`, 0.2 opacity) appears between layer groups.

### 5.2 Parallel Limit Line

- Horizontal marker at `parallelNodeLimit` rows from top (if count of concurrent nodes at any point equals the limit)
- Rendered as a dashed line (`--color-accent`, 0.4 opacity, `[4, 4]` dash pattern)
- Label: `∥ limit: {N}` at the right end, 10px `--font-mono`, `--color-text-secondary`
- Only shown when at least one time slice hits the parallel limit

### 5.3 Bottleneck Highlighting

A node is flagged as a bottleneck when:
- It is the **only running node** for > 20% of the total execution duration
- All other nodes in subsequent layers are blocked waiting for it

Visual treatment:
- 2px left border in `oklch(0.70 0.20 30)` (warm orange)
- Row background: subtle warm tint `oklch(0.20 0.02 30 / 0.15)`
- Tooltip appends: `⚠ Bottleneck — blocked pipeline for {duration}`

---

## 6. Synchronization with DAG Graph

### 6.1 Two-Way Binding Contract

The Gantt chart and DAG graph canvas share a `selectedNodeId` via the `DagStudio` orchestrator. Neither component directly references the other — they communicate through callbacks.

| Source Action | Gantt Behavior | Graph Behavior |
|---------------|----------------|----------------|
| Click Gantt bar | Set `selectedNodeId` → fire `onNodeSelected(id)` | Graph receives callback → pan to node, apply selection highlight |
| Click graph node | — | Set `selectedNodeId` → fire `onNodeSelected(id)` |
| Gantt receives `onNodeSelected(id)` | Highlight bar (2px outline `--color-accent`), scroll row into view | — |
| Graph receives `onNodeSelected(id)` | — | Pan viewport to node, apply selection glow |
| Hover Gantt bar | Emit `onNodeHovered(id)` | Graph highlights node with hover ring |
| Hover graph node | Gantt highlights row with background tint | — |
| Clear selection (click empty area) | Remove bar highlight | Remove node highlight |

### 6.2 Cross-Highlight Visuals

| State | Gantt Bar Treatment | Label Treatment |
|-------|--------------------|-----------------| 
| Hovered (from either source) | Row background: `oklch(0.22 0 0 / 0.5)` | Label text: `--color-text-primary` (from secondary) |
| Selected (from either source) | 2px outline: `--color-accent`, row background: `oklch(0.22 0.03 250 / 0.3)` | Label text: `--color-accent`, bold weight |
| Neither | No row highlight | Label text: `--color-text-secondary` |

### 6.3 Scroll-Into-View

When a node is selected from the graph and its Gantt bar is not visible:
1. Smooth-scroll the bar grid vertically to center the target row
2. If the bar's time range is outside the horizontal viewport, smooth-scroll horizontally to show the bar with 20% padding on each side
3. Animation: 200ms ease-out scroll

---

## 7. Live Execution

### 7.1 Real-Time Bar Growth

During active DAG execution (`DagExecutionStatus === 'running'`):

1. **Animation loop**: `requestAnimationFrame` at 60fps redraw
2. For each node with `status === 'running'`:
   - `barWidth = (Date.now() - node.startedAt) * pxPerSec`
   - Repaint only the dirty region (bar's previous rect + new extent)
3. **Now marker** advances with wall-clock time
4. **Time axis** extends if execution exceeds initial viewport:
   - When Now marker reaches 85% of canvas width, the time scale compresses smoothly (200ms transition) to add 30% headroom

### 7.2 Node Lifecycle Events

Events arrive via `AutoDetector.onExecutionUpdated()`:

| Event | Gantt Action |
|-------|-------------|
| `Executing node {name}` | Create new bar at current time position. Status = running. Begin growth animation. |
| `Executed node {name}` (success) | Freeze bar width at final duration. Set status = completed. Apply green fill. |
| `Executed node {name}` (failed) | Freeze bar width. Set status = failed. Apply red hatched fill. |
| Node skipped | Render empty row with skipped styling. No bar, grey dashed midline. |
| Node cancelled | Freeze bar at current width. Set status = cancelled. Apply amber striped fill. |
| Execution completed | Stop animation loop. Render total duration. Hide Now marker. |

### 7.3 New Node Appearance

When a new node starts executing:
1. Insert row at correct sort position (by layer, then start time)
2. Slide existing rows down with 150ms ease transition (CSS `transform: translateY`)
3. New bar fades in from 0 → 1 opacity over 100ms
4. If the new row is below the visible scroll area, do **not** auto-scroll (avoid jank during busy execution). Exception: if the node is failed, auto-scroll to it.

### 7.4 Idle vs Active Rendering

| State | Render Strategy |
|-------|----------------|
| No execution loaded | Static — render once. No animation loop. |
| Historical execution viewed | Static — render once. No animation loop. |
| Live execution in progress | 60fps `requestAnimationFrame` loop. Dirty-rect repainting. |
| Live execution, Gantt tab not visible | Pause animation loop. Resume on tab switch. Track elapsed time to catch up. |

---

## 8. Comparison Mode

### 8.1 Trigger

Activated from the Execution History table: user selects two rows → clicks "Compare" → Gantt enters comparison mode.

### 8.2 Visual Design

Two runs overlaid on the same time axis, aligned to execution start (t=0):

| Run | Bar Style | Label |
|-----|-----------|-------|
| **Run A** (older) | Solid fill at 0.5 opacity | `A` badge on label |
| **Run B** (newer) | Striped pattern overlay at 0.7 opacity | `B` badge on label |

Each node gets two bars stacked vertically within its row:
- Row height doubles to 48px (4px padding + 20px bar A + 4px gap + 20px bar B + 0px)
- Bar A on top, Bar B below
- Bars use their status color but with the solid/striped differentiation

### 8.3 Timing Difference Indicators

| Condition | Visual |
|-----------|--------|
| Run B faster (> 10% improvement) | Green `▾ −{diff}` badge at bar end |
| Run B slower (> 10% regression) | Red `▴ +{diff}` badge at bar end |
| Similar (within 10%) | No badge |
| Node missing in one run | Single bar with `(only in A)` or `(only in B)` label, muted opacity |
| Status changed | Status pill showing `A:● → B:●` transition in label column |

### 8.4 Comparison Summary Footer

Replaces the standard footer with comparison stats:

```
Run A: 45.2s ● Completed │ Run B: 1m 12s ● Failed │ Δ +26.8s (+59%) │ 3 regressions │ 1 new failure
```

### 8.5 Exit Comparison

- Click "Exit Compare" button in summary footer → return to single-run view
- Pressing `Escape` also exits comparison mode
- Row heights animate back to 28px over 200ms

---

## 9. Rendering Strategy

### 9.1 Canvas 2D vs HTML/CSS Analysis

| Factor | HTML/CSS (`<div>` bars) | Canvas 2D | Decision |
|--------|------------------------|-----------|----------|
| 50 nodes | ✅ Trivial — 50 divs, CSS transitions | ✅ Easy | Tie |
| 300 nodes | 🟡 300 divs with scroll — DOM overhead, reflow during animation | ✅ Single draw call, dirty-rect repaint | Canvas |
| Real-time growth | 🟡 CSS `width` transition per bar = N reflows/frame | ✅ Redraw dirty rect only | Canvas |
| Text in bars | ✅ Native DOM text | 🟡 `ctx.fillText` — no subpixel hinting | HTML better |
| Tooltips | ✅ Native CSS `:hover` + tooltip div | 🟡 Manual hit-test + positioned overlay | HTML better |
| Time axis labels | ✅ Positioned divs | 🟡 Canvas text less crisp | HTML better |
| Horizontal scroll/zoom | 🟡 `overflow-x: auto` + JS zoom logic | ✅ Transform matrix, efficient | Canvas |
| Comparison mode (2× bars) | 🟡 600 divs, more reflow | ✅ Same canvas, double the bars | Canvas |
| Accessibility | ✅ ARIA roles on divs | ❌ Opaque canvas | HTML better |

**Decision: Hybrid approach (matches spec Section 2.3)**

- **Canvas 2D** for the bar grid: all colored bars, hatching patterns, gridlines, bottleneck highlights. Gives us dirty-rect repaint for live execution and scales to 300 nodes.
- **DOM overlay** for: time axis labels, node name labels (left column), tooltips, comparison badges, summary footer. Gives us crisp text, native events, accessibility.

### 9.2 Canvas Rendering Pipeline

Each frame (during live execution) or on demand (static):

```
1. Clear dirty region (or full canvas on resize/zoom)
2. Draw gridlines
   - Major ticks: full-height vertical lines
   - Minor ticks: half-height vertical lines
   - Layer separators: horizontal hairlines
3. Draw bars (bottom to top for correct z-order)
   For each node in sorted order:
     - Calculate barX, barWidth, barY from time scale
     - ctx.fillStyle = statusColor
     - ctx.fillRect(barX, barY, barWidth, BAR_HEIGHT)
     - If failed: overlay hatch pattern (pre-rendered to offscreen canvas)
     - If cancelled: overlay stripe pattern
     - If running: apply pulsing opacity (sinusoidal, 1.5s period)
     - If width >= 60px: ctx.fillText(label) inside bar
4. Draw Now marker (if live)
   - Vertical line at currentTime position
5. Draw selection highlight
   - 2px stroke rect around selected bar
6. Draw bottleneck indicators
   - Left border + row tint for flagged nodes
7. Draw parallel limit line (if applicable)
```

### 9.3 Offscreen Pattern Canvases

Hatch and stripe patterns are pre-rendered to small offscreen canvases once, then used as `ctx.createPattern()` fills:

| Pattern | Canvas Size | Drawing |
|---------|------------|---------|
| Failed hatch | 8×8px | Two 1px diagonal lines at 45° in semi-transparent white |
| Cancelled stripe | 8×8px | Two 2px vertical lines in semi-transparent white |

### 9.4 Hit Testing

Since bars are on Canvas, mouse events require manual hit-testing:

```
function hitTest(mouseX, mouseY) {
    // mouseX/Y already adjusted for scroll offset
    const rowIndex = Math.floor(mouseY / ROW_HEIGHT)
    if (rowIndex < 0 || rowIndex >= nodes.length) return null

    const node = sortedNodes[rowIndex]
    const barX = (node.startedAt - execStart) * pxPerSec
    const barW = node.duration * pxPerSec

    if (mouseX >= barX && mouseX <= barX + barW) {
        return node.id
    }
    return null  // clicked empty space in the row
}
```

Complexity: O(1) — direct row index calculation, no spatial indexing needed.

---

## 10. Scroll and Zoom

### 10.1 Vertical Scroll

- Standard scrollbar on the label column and bar grid, synchronized
- Implementation: single scroll container wrapping both label column and canvas, OR synced `scrollTop` via JS event listener (label column is DOM, grid is canvas — sync required)
- Scroll approach: label column `overflow-y: auto` is the scroll leader. On scroll event, update canvas render offset.

### 10.2 Horizontal Zoom (Time Axis)

| Input | Action |
|-------|--------|
| `Ctrl+Scroll` (mousewheel) | Zoom time axis in/out, centered on cursor position |
| Pinch gesture | Same as above (touch devices) |
| `+` / `-` keys (when Gantt focused) | Zoom in/out by 20% step, centered on viewport center |
| `0` key | Reset zoom to fit entire execution in viewport |
| Click-drag on time axis | Pan horizontally |

**Zoom limits:**
- Minimum: entire execution fits in viewport (1:1 with auto-scale)
- Maximum: 1 second fills the viewport width (maximum detail)

**Zoom implementation:**
```
function zoom(delta, centerX) {
    const oldPxPerSec = this._pxPerSec
    const newPxPerSec = clamp(
        oldPxPerSec * (1 + delta * 0.1),
        this._minPxPerSec,   // entire execution fits
        this._maxPxPerSec    // 1s = canvas width
    )

    // Adjust scroll offset to keep centerX stable
    const timeAtCenter = this._scrollX / oldPxPerSec + centerX / oldPxPerSec
    this._scrollX = timeAtCenter * newPxPerSec - centerX

    this._pxPerSec = newPxPerSec
    this._renderTimeAxis()
    this._renderBars()
}
```

### 10.3 Horizontal Pan

- `Shift+Scroll` (mousewheel): pan left/right
- Click-drag on empty canvas area: pan
- Scrollbar: standard horizontal scrollbar below the canvas

### 10.4 Zoom Synchronization

The Gantt time axis is **independent** of the DAG graph zoom. The graph shows spatial layout; the Gantt shows temporal layout. They don't share a zoom level. However, they share `selectedNodeId` for cross-highlighting (Section 6).

---

## 11. Resize (Drag Handle)

### 11.1 Drag Behavior

The drag handle between the graph (top) and the tabbed panel (bottom) allows resizing:

| Property | Value |
|----------|-------|
| Handle height | 8px |
| Cursor | `row-resize` |
| Visual | 2px horizontal line centered, `--color-border`. On hover: `--color-text-secondary`. On drag: `--color-accent`. |
| Min top panel | 120px (enough for a minimal graph view) |
| Min bottom panel | 80px (enough for 2 rows + summary) |
| Default ratio | 60% top / 40% bottom |

### 11.2 Drag Implementation

```
handle.onmousedown → start drag
  document.onmousemove → calculate new ratio, apply to flex-basis
  document.onmouseup → end drag, persist ratio
```

### 11.3 Persistence

- Ratio persisted to `localStorage` key `edog.dagStudio.splitRatio`
- Restored on next DAG Studio activation
- Default: `0.6` (60% graph, 40% bottom panel)

### 11.4 Responsive Behavior

| Container Height | Behavior |
|-----------------|----------|
| ≥ 600px | Normal split with persisted ratio |
| 400–599px | Force 50/50 split, ignore persisted ratio |
| < 400px | Stack vertically: graph collapses to 120px, Gantt takes remaining space |

---

## 12. Tooltip

### 12.1 Trigger

- Hover over a Gantt bar for 300ms (debounced)
- Tooltip follows cursor horizontally, anchored 8px above the bar
- Disappears on mouseout or bar change

### 12.2 Content

```
┌─────────────────────────────┐
│ RefreshSalesData         SQL│
│ ● Completed                 │
│ ─────────────────────────── │
│ Start:    14:23:05.123      │
│ End:      14:23:07.456      │
│ Duration: 2.33s             │
│ Rows:     +1,234 / −0       │
│ ─────────────────────────── │
│ ⚠ Bottleneck — 8.2s blocked │  ← only if bottleneck
└─────────────────────────────┘
```

### 12.3 Tooltip Positioning

- Preferred: above the bar, centered on cursor X
- Flip below if insufficient space above
- Clamp to viewport edges with 8px margin
- Implementation: DOM `<div>` absolutely positioned over the canvas. Hidden by default, shown on hit-test match.

---

## 13. Keyboard Interactions

| Key | Context | Action |
|-----|---------|--------|
| `↑` / `↓` | Gantt focused | Move selection to previous/next node row |
| `←` / `→` | Gantt focused | Pan time axis left/right by 10% of viewport |
| `Enter` | Node row focused | Select node → fires `onNodeSelected`, opens detail panel |
| `Escape` | Any | Clear selection. Exit comparison mode if active. |
| `+` / `=` | Gantt focused | Zoom in time axis 20% |
| `-` | Gantt focused | Zoom out time axis 20% |
| `0` | Gantt focused | Fit entire execution in viewport |
| `Home` | Gantt focused | Scroll to t=0 (execution start) |
| `End` | Gantt focused | Scroll to execution end (or Now marker if live) |
| `Tab` | Gantt focused | Move focus to next interactive region (label column → bar grid → controls) |

Focus indicator: 2px outline `--color-accent` on the focused row (matches selection outline but dashed).

---

## 14. Performance Budget

| Metric | Target | Measurement |
|--------|--------|-------------|
| Initial render (50 nodes) | < 16ms (1 frame) | `performance.mark` around `renderExecution()` |
| Initial render (300 nodes) | < 50ms (3 frames) | Same |
| Live frame time (50 nodes running) | < 8ms per frame (120fps headroom) | `requestAnimationFrame` delta |
| Live frame time (300 nodes, 20 running) | < 16ms per frame (60fps) | Same |
| Hit-test latency | < 1ms | O(1) row lookup |
| Zoom response | < 16ms | Time scale recalculation + redraw |
| Memory (50 nodes) | < 2MB | Canvas buffer + node data |
| Memory (300 nodes) | < 8MB | Same |

### 14.1 Optimization Techniques

| Technique | Application |
|-----------|-------------|
| **Dirty-rect repaint** | Only redraw bars that changed (running bars + newly completed) |
| **Offscreen pattern caching** | Hatch/stripe patterns rendered once to offscreen canvas |
| **Row virtualization** | Only render rows visible in the scroll viewport + 2-row buffer |
| **Frame skipping** | If `requestAnimationFrame` callback takes > 16ms, skip next frame |
| **Time axis caching** | Time axis redraws only on zoom/pan, not every bar frame |
| **Batch DOM updates** | Label column updates batched in single `requestAnimationFrame` |

---

## 15. Error Handling

| Error | User Sees | Recovery |
|-------|-----------|----------|
| Execution metrics fetch fails (network) | "Could not load execution data" with retry button | Retry button calls `getDagExecMetrics()` again |
| Execution metrics fetch fails (404) | "Execution not found — it may have been garbage collected" | Disable Gantt, show empty state |
| Execution metrics fetch fails (401) | "Session expired — re-authenticate" | Redirect to auth flow |
| Canvas context creation fails | "Gantt chart unavailable — Canvas not supported" | Fallback to text summary of node timings |
| No nodes in execution | "Empty execution — no nodes ran" | Show empty state with dashed border |
| Corrupted timing data (start > end) | Render bar as 3px sliver + tooltip "Invalid timing data" | Log warning to console |
| WebSocket disconnect during live | Gantt freezes. "Connection lost" banner (from global handler). | On reconnect: fetch latest metrics, reconcile bar states |
| Comparison with incompatible DAGs | "DAG structure changed between runs — {N} nodes differ" banner at top of comparison | Still render comparison, mark mismatched nodes |

---

## 16. DagGantt Class API

```
class DagGantt {
    constructor(containerEl)
    // containerEl: the parent div for the Gantt panel

    // === Public API ===

    renderExecution(executionInstance)
    // Render a complete execution from DagExecutionInstance data.
    // Clears previous content. Builds sorted node list, calculates time scale.

    updateBar(nodeId, { status, startedAt, endedAt })
    // Real-time update for a single node during live execution.
    // If node not yet rendered, creates it. If already rendered, updates in place.

    highlightNode(nodeId)
    // Cross-highlight: outline the bar, scroll into view.
    // Called by DagStudio when graph node is selected.

    hoverNode(nodeId)
    // Cross-hover: apply hover background to row.
    // Called by DagStudio when graph node is hovered.

    clearHighlight()
    // Remove selection + hover highlights.

    renderComparison(runA, runB)
    // Enter comparison mode: two DagExecutionInstances overlaid.
    // Row height doubles. Bars get solid/striped differentiation.

    exitComparison()
    // Return to single-run view. Animate row height back to 28px.

    setTimeZoom(level)
    // Programmatic zoom. level: 'fit' | number (pxPerSec).

    resize()
    // Called when container size changes (drag handle, window resize).
    // Recalculates canvas dimensions and re-renders.

    destroy()
    // Tear down: cancel animation frame, remove event listeners,
    // remove DOM elements, release canvas context.

    // === Callbacks (set by DagStudio orchestrator) ===

    onNodeSelected    = null  // (nodeId) => void
    onNodeHovered     = null  // (nodeId) => void
    onNodeUnhovered   = null  // () => void

    // === Private ===

    _calculateTimeScale(startTime, endTime)
    _renderBars()
    _renderTimeAxis()
    _renderGridlines()
    _renderNowMarker()
    _renderBottlenecks()
    _renderParallelLimitLine()
    _hitTest(mouseX, mouseY)
    _startAnimationLoop()
    _stopAnimationLoop()
    _handleMouseMove(e)
    _handleMouseClick(e)
    _handleWheel(e)
    _handleKeyDown(e)
    _sortNodes(nodes, dagLayout)
    _createPatternCanvases()
}
```

---

## 17. Data Flow

```
DagExecutionInstance (from API or AutoDetector)
  │
  ▼
DagStudio._loadExecution(iterationId)
  │
  ├─▶ DagCanvasRenderer.overlayMetrics(nodeMetrics)
  │     └── Updates node colors/badges on graph
  │
  └─▶ DagGantt.renderExecution(executionInstance)
        ├── Extract nodeExecutionMetrices map
        ├── Sort by layer + startTime
        ├── Calculate time scale
        ├── Render canvas bars + DOM labels
        └── If status === 'running': start animation loop

AutoDetector.onExecutionUpdated(id, exec)
  │
  ▼
DagStudio._onExecutionUpdated(id, exec)
  │
  ├─▶ DagCanvasRenderer.updateNodeState(nodeId, status)
  └─▶ DagGantt.updateBar(nodeId, { status, startedAt, endedAt })
        ├── If new node: insert row, create bar
        ├── If running: update barWidth (animation loop handles growth)
        └── If terminal: freeze bar, apply final status color
```

---

## 18. Accessibility

| Requirement | Implementation |
|-------------|----------------|
| Screen reader: node list | Hidden `<ul>` with `role="list"` mirroring visible rows. Each `<li>` contains node name, status, duration. |
| Keyboard navigation | Full keyboard support (Section 13). Focus ring on active row. |
| Color-blind safety | Status uses color + pattern (hatch/stripe/solid/dotted). Never color alone. |
| Reduced motion | Respect `prefers-reduced-motion`: disable pulse animations, bar growth is instant (jump to final width on each update). |
| Zoom | Time axis zoom respects browser zoom. Canvas DPI-aware (`devicePixelRatio`). |
| High contrast | Status patterns remain visible. Bar outlines increase to 2px in high-contrast mode. |

---

## 19. Open Questions

| # | Question | Impact | Proposed Resolution |
|---|----------|--------|---------------------|
| 1 | Should the Gantt time axis sync with a shared "playback" scrubber for replaying executions? | Nice-to-have — not MVP | Defer to post-MVP. Note in spec. |
| 2 | Should we support exporting the Gantt as an image (PNG/SVG) for pasting into incident reports? | Medium — engineers share DAG timelines in Teams | Canvas `toDataURL()` makes this trivial. Add to V2 scope. |
| 3 | Should comparison mode support > 2 runs? | Low — 2-run diff covers 95% of use cases | No. Keep it at exactly 2. |
