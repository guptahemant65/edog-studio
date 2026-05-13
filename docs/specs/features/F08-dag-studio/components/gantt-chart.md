# Gantt Chart — Deep Component Spec

> **Feature:** F08 DAG Studio — Section 2.3
> **Component:** `DagGantt`
> **Source File:** `dag-gantt.js` (~400 lines)
> **Owner:** Pixel (Frontend) · Reviewed by Sana (Architecture)
> **Author:** Sana Reeves
> **Status:** DRAFT
> **Prerequisite:** `research/p0-foundation.md` (NodeExecutionMetrics model)
> **Rendering Decision:** Canvas 2D for bar grid + DOM overlay for axis labels/tooltips — settled (ADR-002).

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [Layout Architecture](#2-layout-architecture)
3. [Time Axis](#3-time-axis)
4. [Node Bars](#4-node-bars)
5. [Parallelism Visualization](#5-parallelism-visualization)
6. [Synchronization with DAG Graph](#6-synchronization-with-dag-graph)
7. [Live Execution](#7-live-execution)
8. [Comparison Mode](#8-comparison-mode)
9. [Rendering Strategy](#9-rendering-strategy)
10. [Scroll and Zoom](#10-scroll-and-zoom)
11. [Resize (Drag Handle)](#11-resize-drag-handle)
12. [Tooltip](#12-tooltip)
13. [Keyboard Interactions](#13-keyboard-interactions)
14. [Performance Budget](#14-performance-budget)
15. [Error Handling](#15-error-handling)
16. [DagGantt Class API](#16-daggantt-class-api)
17. [Data Flow](#17-data-flow)
18. [Accessibility](#18-accessibility)
19. [Open Questions](#19-open-questions)

---

## 1. Purpose

The Gantt chart is the timing panel beneath the DAG graph canvas. It answers the
question every FLT engineer asks during and after a DAG run:

> **"Which nodes ran when, for how long, and what ran in parallel?"**

It shows per-node execution as horizontal bars on a shared time axis. During live
execution, bars grow in real-time. During historical review, the full timeline
renders instantly. In comparison mode, two runs overlay so regressions jump off
the screen.

The component is implemented as a single vanilla JS class (`DagGantt`) that owns
a hybrid Canvas 2D + DOM overlay rendering surface. It communicates with the rest
of DAG Studio exclusively through callbacks — never by direct reference to the
graph canvas or history panel.

---

## 2. Layout Architecture

### 2.1 Structural Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  DAG Graph Canvas (top 60%)                                         │
├═══════════════════ drag handle (8px, cursor: row-resize) ═══════════┤
│  Tab Bar: [Gantt] [History] [Detail]                                │
│┌────────────┬───────────────────────────────────────────────────────┐│
││ Node Labels │  Time Axis (24px)                                   ││
││ (fixed 160px)│  0s   5s  10s  15s  20s  25s  30s  35s             ││
││             │  ┬────┬────┬────┬────┬────┬────┬────┬──             ││
││ SourceA     │  │██████████│                                       ││
││ SourceB     │  │████████████████│                                  ││
││ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ (layer sep)  ││
││ Transform1  │       │██████████████│                               ││
││ Transform2  │       │████████│                                     ││
││ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─              ││
││ MergeStep   │                  │███████████████████│               ││
││ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─              ││
││ FinalView   │                                     │██████│  ▼ Now ││
│└────────────┴───────────────────────────────────────────────────────┘│
│  Σ 35.2s │ 6/8 nodes │ max ∥ 3 │ ● Running                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Structural Regions

| Region | Implementation | Size | Scroll |
|--------|---------------|------|--------|
| **Node label column** | DOM `<div>` list | Fixed 160px width | Vertical — synced with bar grid |
| **Bar grid** | Canvas 2D `<canvas>` | Fills remaining width | Vertical + horizontal (time axis) |
| **Time axis** | DOM overlay above canvas | Fixed 24px height | Horizontal — synced with bar grid |
| **Summary footer** | DOM `<div>` | Fixed 28px height | None |
| **Drag handle** | DOM `<div>` between graph and panel | 8px height | None |

All DOM regions use `--color-bg` (`#ffffff`) as their background colour. The
label column uses `--color-bg-secondary` (`#f5f5f7`) to subtly differentiate it
from the canvas area.

### 2.3 Dimensions (4px Grid)

All measurements align to the 4px spatial grid (`--space-1` = 4px).

| Element | Value | Tokens / Notes |
|---------|-------|----------------|
| Row height | 28px | `--space-1` top + 20px bar + `--space-1` bottom |
| Bar height | 20px | 5 × `--space-1` |
| Bar corner radius | 4px | `--space-1`, consistent with card radius |
| Label column width | 160px | Truncated with `…` if name overflows |
| Time axis height | 24px | 6 × `--space-1` |
| Footer height | 28px | 7 × `--space-1` |
| Minimum bar width | 3px | Below this: render 3px sliver, full info in tooltip |
| Layer gap | 4px | 1px separator + 3px spacing |
| Comparison row height | 48px | 12 × `--space-1` — doubled for overlaid bars |

---

## 3. Time Axis

### 3.1 Auto-Scaling Algorithm

The time axis scales automatically based on total execution duration. The
algorithm targets 8–15 visible ticks to avoid illegible bunching or wasteful
whitespace.

```javascript
function calculateTimeScale(startTime, endTime, canvasWidth) {
    const totalMs = endTime - startTime
    const totalSec = totalMs / 1000

    // Choose display unit
    let unit
    if (totalSec < 120)       unit = 'seconds'
    else if (totalSec < 7200) unit = 'minutes'
    else                      unit = 'hours'

    // Target 12 ticks, snap to "nice" intervals
    const targetTicks = 12
    const rawInterval = totalSec / targetTicks
    const niceIntervals = {
        seconds: [1, 2, 5, 10, 15, 30],
        minutes: [60, 120, 300, 600, 900, 1800],
        hours:   [3600, 7200, 14400]
    }
    const tickInterval = snapToNearest(rawInterval, niceIntervals[unit])

    // Pixels per second
    const pxPerSec = canvasWidth / totalSec

    return { unit, tickInterval, pxPerSec, totalSec }
}

function snapToNearest(value, candidates) {
    let best = candidates[0]
    let bestDist = Math.abs(value - best)
    for (const c of candidates) {
        const dist = Math.abs(value - c)
        if (dist < bestDist) { best = c; bestDist = dist }
    }
    return best
}
```

### 3.2 Tick Rendering

| Duration Range | Unit | Tick Examples | Label Format |
|----------------|------|---------------|--------------|
| < 2 min | Seconds | 0s, 5s, 10s, 15s … | `{n}s` |
| 2 min – 2 hr | Minutes | 0:00, 0:30, 1:00 … | `{m}:{ss}` |
| > 2 hr | Hours | 0:00, 1:00, 2:00 … | `{h}:{mm}` |

**Tick visual details:**

- **Major ticks:** full-height vertical hairline — `--color-border` at 0.3 opacity, 1px
- **Minor ticks:** half-height vertical hairline — `--color-border` at 0.15 opacity, 1px
- **Tick labels:** 11px `--font-mono`, colour `--color-text-secondary`, centered below tick mark
- **Zero label:** `0s` anchored flush-left at the origin

### 3.3 "Now" Marker (Live Execution)

During active execution, a vertical marker tracks current wall-clock time:

| Property | Value |
|----------|-------|
| Line | 1.5px solid `--accent`, full grid height |
| Label | "Now" badge — 11px, `--accent` background, `--color-bg` text, pill shape, pinned to time axis |
| Animation | `requestAnimationFrame` — advances rightward at real-time pace |
| Beyond viewport | Marker clamps to right edge with `▸` arrow and elapsed time |

### 3.4 Total Duration Label

- Positioned at the right end of the time axis
- Format: `Σ {duration}` (e.g., `Σ 1m 23s`)
- During live execution: updates every frame
- Colour: `--color-text`

---

## 4. Node Bars

### 4.1 Sort Order

Nodes are sorted top-to-bottom by:

1. **Layer** (from Sugiyama layout) — source layer first, then each subsequent
2. **Start time within layer** — earlier-started nodes appear higher
3. **Alphabetical** tiebreaker when layer and start time match

Layer grouping makes parallelism visually obvious: nodes in the same layer that
started near-simultaneously appear as stacked bars at the same horizontal offset.

### 4.2 Visual Encoding

All colours reference design tokens. No raw hex or OKLCH values.

| Status | Fill Token | Pattern | Animation |
|--------|-----------|---------|-----------|
| **Completed** | `--status-succeeded` | Solid | None |
| **Running** | `--accent` | Solid | Pulse: opacity oscillates 0.7–1.0 over 1.5s. Bar grows rightward. |
| **Failed** | `--status-failed` | Diagonal hatch (45°, 3px spacing) | None |
| **Cancelled** | `--status-cancelled` | Vertical stripe (4px spacing) | None |
| **Cancelling** | `--status-cancelled` | Vertical stripe | Pulse: slow opacity oscillation (2s period) |
| **Skipped** | `--status-pending` | Solid, 0.40 opacity | None — 1px dotted `--color-border` outline |
| **Pending** | None (empty row) | — | 1px dashed `--color-border` at row midline |

**Sort-order pseudocode:**

```javascript
function sortNodes(nodes, dagLayout) {
    return nodes.slice().sort((a, b) => {
        const layerA = dagLayout.getLayer(a.id)
        const layerB = dagLayout.getLayer(b.id)
        if (layerA !== layerB) return layerA - layerB

        const startA = a.startedAt ?? Infinity
        const startB = b.startedAt ?? Infinity
        if (startA !== startB) return startA - startB

        return a.name.localeCompare(b.name)
    })
}
```

### 4.3 Bar Content (Adaptive)

Content inside a bar adapts based on available pixel width:

| Bar Width | Content Rendered |
|-----------|-----------------|
| >= 120px | Node name (truncated) + duration (e.g., `SourceA  2.3s`) |
| 60–119px | Duration only (e.g., `2.3s`) |
| 20–59px | Duration abbreviated (e.g., `2s`) |
| 3–19px | Nothing inside — tooltip only |
| < 3px | 3px minimum-width sliver — tooltip only |

**Text rendering on canvas:**

- **Font:** 11px `--font-mono`
- **Colour:** `--color-bg` (white text on coloured bars) with 1px `rgba(0,0,0,0.3)` shadow for contrast
- **Alignment:** left-padded 6px from bar left edge, vertically centered in bar
- **Overflow:** clip at bar right edge minus `--space-1`

### 4.4 Bar Positioning Formula

```javascript
// Constants
const ROW_HEIGHT    = 28   // px
const BAR_HEIGHT    = 20   // px
const ROW_PAD_TOP   = 4    // px — (ROW_HEIGHT - BAR_HEIGHT) / 2

// Per-bar calculation
barX      = (node.startedAt - execution.startedAt) * pxPerSec
barWidth  = node.duration * pxPerSec       // static
barWidth  = (Date.now() - node.startedAt) * pxPerSec  // running
barY      = rowIndex * ROW_HEIGHT + ROW_PAD_TOP
barHeight = BAR_HEIGHT
```

For running nodes, `barWidth` recalculates every animation frame to produce the
growth effect.

---

## 5. Parallelism Visualization

### 5.1 Layer Grouping

Nodes from the same DAG layer that overlap in time stack vertically, visually
demonstrating concurrent execution:

```
Layer 1: ├──SourceA──────┤├──SourceB─────────┤├──SourceC────┤
         ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ (separator)
Layer 2:                  ├──Transform1────────┤
                          ├──Transform2──────┤
         ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
Layer 3:                                       ├──Merge──────────────┤
```

A thin horizontal separator (1px, `--color-border` at 0.2 opacity) appears
between layer groups.

### 5.2 Parallel Limit Line

When at least one time slice reaches the `parallelNodeLimit`:

| Property | Value |
|----------|-------|
| Style | Dashed line — `--accent` at 0.4 opacity, `[4, 4]` dash pattern |
| Position | Horizontal, drawn at the Y offset of the `parallelNodeLimit`-th concurrent row |
| Label | `∥ limit: {N}` — 10px `--font-mono`, `--color-text-secondary`, right-aligned |
| Visibility | Only when at least one time slice equals the configured limit |

### 5.3 Bottleneck Highlighting

A node is flagged as a **bottleneck** when:

- It is the **only running node** for > 20% of total execution duration
- All subsequent-layer nodes are blocked waiting for it

**Visual treatment (light theme):**

| Element | Value |
|---------|-------|
| Left border | 2px solid `--status-cancelled` (amber — warmth indicates caution) |
| Row background | `--accent-dim` tinted toward amber (`rgba(229, 148, 12, 0.06)`) |
| Tooltip addendum | `◆ Bottleneck — blocked pipeline for {duration}` |

---

## 6. Synchronization with DAG Graph

### 6.1 Two-Way Binding Contract

The Gantt chart and DAG graph canvas share a `selectedNodeId` via the
`DagStudio` orchestrator. Neither component directly references the other —
communication flows exclusively through callbacks.

| Source Action | Gantt Behaviour | Graph Behaviour |
|---------------|----------------|----------------|
| Click Gantt bar | Set `selectedNodeId`, fire `onNodeSelected(id)` | Pan to node, apply selection glow |
| Click graph node | — | Set `selectedNodeId`, fire `onNodeSelected(id)` |
| Gantt receives `highlightNode(id)` | 2px outline `--accent`, scroll row into view | — |
| Graph receives selection | — | Pan viewport, apply selection glow |
| Hover Gantt bar | Emit `onNodeHovered(id)` | Graph highlights node with hover ring |
| Hover graph node | Gantt highlights row with `--color-bg-tertiary` | — |
| Click empty area | Clear bar highlight | Clear node highlight |

### 6.2 Cross-Highlight Visuals

| State | Gantt Bar Treatment | Label Treatment |
|-------|--------------------|-----------------| 
| **Hovered** (from either source) | Row background: `--color-bg-tertiary` | Label: `--color-text` (promoted from secondary) |
| **Selected** (from either source) | 2px outline: `--accent`, row background: `--accent-dim` | Label: `--accent`, `font-weight: 600` |
| **Neither** | No row highlight, `--color-bg` | Label: `--color-text-secondary` |

### 6.3 Scroll-Into-View

When a node is selected from the graph and its Gantt bar is not visible:

1. Smooth-scroll the bar grid vertically to center the target row
2. If the bar's time range is outside the horizontal viewport, smooth-scroll
   horizontally to show the bar with 20% padding on each side
3. Animation: 200ms `ease-out` scroll via `element.scrollTo({ behavior: 'smooth' })`

---

## 7. Live Execution

### 7.1 Real-Time Bar Growth

During active DAG execution (`DagExecutionStatus === 'running'`):

1. **Animation loop:** `requestAnimationFrame` drives 60fps redraw
2. For each node with `status === Running`:
   - `barWidth = (Date.now() - node.startedAt) * pxPerSec`
   - Repaint only the dirty region (bar's previous rect union new extent)
3. **Now marker** advances with wall-clock time
4. **Time axis auto-extend:** when the Now marker reaches 85% of canvas width,
   the time scale compresses smoothly (200ms transition) to add 30% headroom

### 7.2 Node Lifecycle Events

Events arrive via `AutoDetector.onExecutionUpdated()`:

| Event | Gantt Action |
|-------|-------------|
| `Executing node {name}` | Create bar at current time. Status = Running. Begin growth animation. |
| `Executed node {name}` (success) | Freeze bar width. Status = Completed. Fill with `--status-succeeded`. |
| `Executed node {name}` (failed) | Freeze bar width. Status = Failed. Apply `--status-failed` + hatch. |
| Node skipped | Render row with Skipped styling. Dashed midline, muted `--status-pending`. |
| Node cancelled | Freeze bar. Status = Cancelled. Apply `--status-cancelled` + stripe. |
| Execution completed | Stop animation loop. Final duration in footer. Hide Now marker. |

### 7.3 New Node Appearance

When a new node starts executing:

1. Insert row at correct sort position (by layer, then start time)
2. Slide existing rows down — 150ms `ease` transition via CSS `transform: translateY`
3. New bar fades in: 0 → 1 opacity over 100ms
4. Do **not** auto-scroll if the new row is off-screen (avoids jank during busy
   execution). **Exception:** if the new node is `Failed`, auto-scroll to it.

### 7.4 Idle vs Active Rendering

| State | Render Strategy |
|-------|----------------|
| No execution loaded | Static — render once. No animation loop. |
| Historical execution | Static — render once. No animation loop. |
| Live execution in progress | 60fps `requestAnimationFrame`. Dirty-rect repaint. |
| Live execution, Gantt tab hidden | Pause loop. Resume on tab switch. Track elapsed to catch up. |

---

## 8. Comparison Mode

### 8.1 Trigger

Activated from the Execution History table: user selects two rows, clicks
"Compare". Gantt enters comparison mode.

### 8.2 Visual Design

Two runs overlaid on the same time axis, aligned to execution start (t=0):

| Run | Bar Style | Label |
|-----|-----------|-------|
| **Run A** (older) | Solid fill at 0.5 opacity | `A` badge on label |
| **Run B** (newer) | Striped pattern at 0.7 opacity | `B` badge on label |

Each node gets two bars stacked vertically:

```
┌────────────────────────────────────────────────┐
│ 4px pad                                        │
│ ├───── Run A bar (solid, 0.5 opacity) ────┤    │  20px
│ 4px gap                                        │
│ ├───── Run B bar (striped, 0.7 opacity) ──────┤│  20px
│ 0px                                            │
└────────────────────────────────────────────────┘
              Total row: 48px
```

Row height doubles to 48px (4px + 20px + 4px + 20px). Bar A on top, Bar B
below. Both bars use their respective status colour but with solid vs striped
differentiation.

### 8.3 Timing Difference Indicators

| Condition | Visual |
|-----------|--------|
| Run B faster (> 10% improvement) | `--status-succeeded` badge: `▾ −{diff}` at bar end |
| Run B slower (> 10% regression) | `--status-failed` badge: `▴ +{diff}` at bar end |
| Within 10% | No badge |
| Node only in one run | Single bar with `(only in A)` or `(only in B)` label, 0.4 opacity |
| Status changed between runs | Status pill: `A:● → B:●` in label column |

### 8.4 Comparison Summary Footer

Replaces the standard footer:

```
Run A: 45.2s ● Completed │ Run B: 1m 12s ● Failed │ Δ +26.8s (+59%) │ 3 regressions │ 1 new failure
```

- Status dots use the corresponding `--status-*` token
- Delta positive (regression): `--status-failed` colour
- Delta negative (improvement): `--status-succeeded` colour

### 8.5 Exit Comparison

- "Exit Compare" button in summary footer → single-run view
- `Escape` key also exits comparison mode
- Row heights animate 48px → 28px over 200ms `ease-out`

---

## 9. Rendering Strategy

### 9.1 Canvas 2D vs DOM Analysis

| Factor | DOM (`<div>` bars) | Canvas 2D | Winner |
|--------|-------------------|-----------|--------|
| 50 nodes | Trivial — 50 divs | Easy | Tie |
| 300 nodes | 300 divs, reflow during animation | Single draw call, dirty-rect | Canvas |
| Real-time growth | CSS `width` = N reflows/frame | Redraw dirty rect only | Canvas |
| Text in bars | Native DOM text, crisp | `ctx.fillText` — adequate | DOM |
| Tooltips | Native CSS hover | Manual hit-test + overlay | DOM |
| Time axis labels | Positioned divs | Canvas text less crisp | DOM |
| Scroll/zoom | `overflow` + JS zoom | Transform matrix, efficient | Canvas |
| Comparison (2x bars) | 600 divs, reflow | Same canvas, double bars | Canvas |
| Accessibility | ARIA roles | Opaque canvas | DOM |

**Decision: Hybrid approach**

- **Canvas 2D** for the bar grid: bars, hatching, gridlines, bottleneck indicators,
  selection outlines. Dirty-rect repaint scales to 300 nodes.
- **DOM overlay** for: time axis labels, node name labels (left column), tooltips,
  comparison badges, summary footer. Crisp text, native events, accessible.

### 9.2 Canvas Rendering Pipeline

Each frame (live) or on demand (static). Seven ordered passes:

```
┌─────────────────────────────────────────────┐
│ Pass 1: Clear dirty region                  │
│         (full canvas on resize/zoom)        │
├─────────────────────────────────────────────┤
│ Pass 2: Draw gridlines                      │
│         Major ticks  → --color-border 0.3   │
│         Minor ticks  → --color-border 0.15  │
│         Layer seps   → --color-border 0.2   │
├─────────────────────────────────────────────┤
│ Pass 3: Draw bars (sorted order)            │
│         status colour → fill → pattern      │
│         → text (if width >= 60px)           │
├─────────────────────────────────────────────┤
│ Pass 4: Draw Now marker (if live)           │
│         1.5px --accent vertical line        │
├─────────────────────────────────────────────┤
│ Pass 5: Draw selection highlight            │
│         2px --accent stroke rect            │
├─────────────────────────────────────────────┤
│ Pass 6: Draw bottleneck indicators          │
│         Left border + row tint              │
├─────────────────────────────────────────────┤
│ Pass 7: Draw parallel limit line            │
│         Dashed --accent at 0.4 opacity      │
└─────────────────────────────────────────────┘
```

### 9.3 Offscreen Pattern Canvases

Hatch and stripe patterns are pre-rendered once to tiny offscreen canvases, then
reused via `ctx.createPattern()`:

| Pattern | Canvas | Drawing | Used For |
|---------|--------|---------|----------|
| Diagonal hatch | 8×8px | Two 1px lines at 45° in `rgba(255,255,255,0.35)` | Failed bars |
| Vertical stripe | 8×8px | Two 2px vertical lines in `rgba(255,255,255,0.30)` | Cancelled bars |
| Comparison stripe | 8×8px | Alternating 2px bars in `rgba(255,255,255,0.25)` | Run B bars |

```javascript
function createHatchPattern() {
    const c = document.createElement('canvas')
    c.width = 8; c.height = 8
    const ctx = c.getContext('2d')
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, 8); ctx.lineTo(8, 0)
    ctx.moveTo(-2, 2); ctx.lineTo(2, -2)
    ctx.moveTo(6, 10); ctx.lineTo(10, 6)
    ctx.stroke()
    return ctx.createPattern(c, 'repeat')
}
```

### 9.4 Hit Testing

Canvas bars require manual hit-testing on mouse events. The algorithm is O(1)
thanks to direct row-index calculation:

```javascript
function hitTest(mouseX, mouseY, scrollOffsetY) {
    const adjustedY = mouseY + scrollOffsetY
    const rowIndex = Math.floor(adjustedY / ROW_HEIGHT)
    if (rowIndex < 0 || rowIndex >= this._sortedNodes.length) return null

    const node = this._sortedNodes[rowIndex]
    if (!node.startedAt) return null  // pending node — no bar

    const barX = (node.startedAt - this._execStart) * this._pxPerSec
    const barW = (node.duration ?? (Date.now() - node.startedAt)) * this._pxPerSec
    const clampedW = Math.max(barW, 3)  // minimum bar width

    if (mouseX >= barX && mouseX <= barX + clampedW) {
        return node.id
    }
    return null
}
```

---

## 10. Scroll and Zoom

### 10.1 Vertical Scroll

- Label column and bar grid share a synchronised vertical scroll position
- Label column (`overflow-y: auto`) is the scroll leader
- On scroll event: update canvas render offset `_scrollY`, trigger repaint
- Scrollbar styled with `--color-border` track and `--color-text-tertiary` thumb

### 10.2 Horizontal Zoom (Time Axis)

| Input | Action |
|-------|--------|
| `Ctrl+Scroll` (mousewheel) | Zoom time axis in/out, centred on cursor X |
| Pinch gesture | Same (touch devices) |
| `+` / `-` keys (Gantt focused) | Zoom in/out by 20% step, centred on viewport centre |
| `0` key | Reset zoom to fit entire execution |
| Click-drag on time axis | Pan horizontally |

**Zoom limits:**

- **Minimum:** entire execution fits in viewport (auto-scale baseline)
- **Maximum:** 1 second fills the viewport width (maximum detail)

```javascript
function zoom(delta, centerX) {
    const oldPxPerSec = this._pxPerSec
    const newPxPerSec = clamp(
        oldPxPerSec * (1 + delta * 0.1),
        this._minPxPerSec,
        this._maxPxPerSec
    )

    // Keep the point under the cursor stable
    const timeAtCenter = (this._scrollX + centerX) / oldPxPerSec
    this._scrollX = timeAtCenter * newPxPerSec - centerX
    this._pxPerSec = newPxPerSec

    this._renderTimeAxis()
    this._renderBars()
}
```

### 10.3 Horizontal Pan

- `Shift+Scroll` (mousewheel): pan left/right
- Click-drag on empty canvas area: pan cursor `grab` → `grabbing`
- Standard horizontal scrollbar below the canvas

### 10.4 Zoom Independence

The Gantt time axis zoom is **independent** of the DAG graph zoom. The graph
shows spatial layout; the Gantt shows temporal layout. They share
`selectedNodeId` for cross-highlighting (Section 6) but never zoom state.

---

## 11. Resize (Drag Handle)

### 11.1 Drag Behaviour

The drag handle between the graph (top) and the tabbed panel (bottom):

| Property | Value |
|----------|-------|
| Handle height | 8px (`--space-2`) |
| Cursor | `row-resize` |
| Idle | 2px horizontal line centred, `--color-border` |
| Hover | Line colour promoted to `--color-text-tertiary` |
| Active drag | Line colour: `--accent` |
| Min top panel | 120px |
| Min bottom panel | 80px (2 rows + summary) |
| Default ratio | 60% top / 40% bottom |

### 11.2 Implementation

```javascript
handle.addEventListener('mousedown', (e) => {
    const startY = e.clientY
    const startRatio = this._splitRatio

    const onMove = (me) => {
        const dy = me.clientY - startY
        const containerH = this._container.offsetHeight
        const newRatio = clamp(
            startRatio + dy / containerH,
            120 / containerH,           // min top
            1 - 80 / containerH         // min bottom
        )
        this._applySplitRatio(newRatio)
    }
    const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        this._persistSplitRatio()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
})
```

### 11.3 Persistence

- Key: `localStorage` → `edog.dagStudio.splitRatio`
- Restored on next DAG Studio activation
- Default: `0.6` (60% graph, 40% bottom panel)

### 11.4 Responsive Behaviour

| Container Height | Behaviour |
|-----------------|-----------|
| >= 600px | Normal split with persisted ratio |
| 400–599px | Force 50/50 split, ignore persisted ratio |
| < 400px | Stack: graph collapses to 120px, Gantt fills remainder |

---

## 12. Tooltip

### 12.1 Trigger

- Hover over a Gantt bar for 300ms (debounced via `setTimeout`)
- Tooltip follows cursor X, anchored `--space-2` above the bar top edge
- Disappears immediately on `mouseout` or when cursor moves to a different bar

### 12.2 Content

```
┌─────────────────────────────────┐
│ RefreshSalesData             SQL│
│ ● Completed                     │
│ ──────────────────────────────  │
│ Start:    14:23:05.123          │
│ End:      14:23:07.456          │
│ Duration: 2.33s                 │
│ Rows:     +1,234 / −0           │
│ ──────────────────────────────  │
│ ◆ Bottleneck — 8.2s blocked    │  ← only if flagged
└─────────────────────────────────┘
```

**Styling:**

| Property | Value |
|----------|-------|
| Background | `--color-bg` |
| Border | 1px solid `--color-border` |
| Border radius | 6px |
| Box shadow | `0 2px 8px rgba(0,0,0,0.08)` |
| Text colour | `--color-text` (primary), `--color-text-secondary` (labels) |
| Status dot | Filled circle in corresponding `--status-*` token |
| Max width | 280px |
| Font | 12px system, `--font-mono` for timestamps and numbers |

### 12.3 Positioning

- Preferred: above the bar, centred on cursor X
- Flip below if insufficient space above (< tooltip height + `--space-2`)
- Clamp to viewport edges with `--space-2` margin
- DOM `<div>` absolutely positioned over the canvas, hidden by default

---

## 13. Keyboard Interactions

| Key | Context | Action |
|-----|---------|--------|
| `Up` / `Down` | Gantt focused | Move selection to previous/next node row |
| `Left` / `Right` | Gantt focused | Pan time axis left/right by 10% of viewport width |
| `Enter` | Row focused | Select node → fire `onNodeSelected`, open detail panel |
| `Escape` | Any | Clear selection. Exit comparison mode if active. |
| `+` / `=` | Gantt focused | Zoom in time axis by 20% |
| `-` | Gantt focused | Zoom out time axis by 20% |
| `0` | Gantt focused | Fit entire execution in viewport |
| `Home` | Gantt focused | Scroll to t=0 (execution start) |
| `End` | Gantt focused | Scroll to execution end (or Now marker if live) |
| `Tab` | Gantt focused | Cycle focus: label column → bar grid → footer controls |

**Focus indicator:** 2px dashed `--accent` outline on the focused row (dashed
distinguishes focus from the solid selection outline).

---

## 14. Performance Budget

### 14.1 Targets

| Metric | 50 Nodes | 300 Nodes | Measurement |
|--------|----------|-----------|-------------|
| Initial render | < 16ms (1 frame) | < 50ms (3 frames) | `performance.mark` around `renderExecution()` |
| Live frame time | < 8ms (120fps headroom) | < 16ms (60fps) | `requestAnimationFrame` delta |
| Hit-test latency | < 1ms | < 1ms | O(1) row lookup |
| Zoom response | < 16ms | < 16ms | Scale recalc + redraw |
| Memory | < 2MB | < 8MB | Canvas buffer + node data |

### 14.2 Optimization Techniques

| Technique | Application |
|-----------|-------------|
| **Dirty-rect repaint** | Only redraw bars that changed (running + newly completed) |
| **Offscreen pattern caching** | Hatch/stripe patterns rendered once to offscreen canvas |
| **Row virtualisation** | Only render rows visible in scroll viewport + 2-row buffer |
| **Frame skipping** | If rAF callback exceeds 16ms, skip next frame to avoid compounding |
| **Time axis caching** | Axis redraws only on zoom/pan, decoupled from bar frame loop |
| **Batch DOM updates** | Label column mutations batched in single `requestAnimationFrame` |

---

## 15. Error Handling

| Error | User Message | Recovery |
|-------|-------------|----------|
| Metrics fetch fails (network) | "Could not load execution data" + retry button | Retry calls `getDagExecMetrics()` |
| Metrics fetch 404 | "Execution not found — may have been garbage collected" | Disable Gantt, show empty state |
| Metrics fetch 401 | "Session expired — re-authenticate" | Redirect to auth flow |
| Canvas context fails | "Gantt chart unavailable — Canvas not supported" | Fallback to text summary of timings |
| Empty execution (0 nodes) | "Empty execution — no nodes ran" | Empty state with dashed `--color-border` border |
| Corrupted timing (start > end) | 3px sliver bar + tooltip "Invalid timing data" | Log warning to console |
| WebSocket disconnect (live) | Gantt freezes. "Connection lost" banner (global handler). | On reconnect: refetch metrics, reconcile bars |
| Incompatible DAGs (comparison) | "DAG structure changed — {N} nodes differ" banner | Still render, mark mismatched nodes |

All error messages use `--color-text` on `--color-bg`. Warning/error icons use
`--status-failed` for errors, `--status-cancelled` for warnings. No emoji —
use `◆` for info, `✕` for errors.

---

## 16. DagGantt Class API

### 16.1 Public Methods

```javascript
class DagGantt {
    /**
     * @param {HTMLElement} containerEl — parent div for the Gantt panel
     */
    constructor(containerEl)

    // ── Rendering ──────────────────────────────────────────────

    /**
     * Render a complete execution from DagExecutionInstance data.
     * Clears previous content. Builds sorted node list, calculates
     * time scale, renders canvas + DOM.
     * @param {DagExecutionInstance} executionInstance
     */
    renderExecution(executionInstance)

    /**
     * Real-time update for a single node during live execution.
     * Creates bar if node not yet rendered; updates in place otherwise.
     * @param {string} nodeId
     * @param {{ status: string, startedAt: number?, endedAt: number? }} update
     */
    updateBar(nodeId, { status, startedAt, endedAt })

    // ── Cross-highlighting ─────────────────────────────────────

    /**
     * Highlight a bar with selection outline, scroll into view.
     * Called by DagStudio when a graph node is selected.
     * @param {string} nodeId
     */
    highlightNode(nodeId)

    /**
     * Apply hover background to a row.
     * Called by DagStudio when a graph node is hovered.
     * @param {string} nodeId
     */
    hoverNode(nodeId)

    /**
     * Remove all selection and hover highlights.
     */
    clearHighlight()

    // ── Comparison ─────────────────────────────────────────────

    /**
     * Enter comparison mode: overlay two runs.
     * Doubles row height. Applies solid/striped differentiation.
     * @param {DagExecutionInstance} runA — older run
     * @param {DagExecutionInstance} runB — newer run
     */
    renderComparison(runA, runB)

    /**
     * Exit comparison mode. Animate row heights back to 28px.
     */
    exitComparison()

    // ── Zoom / Layout ──────────────────────────────────────────

    /**
     * Programmatic zoom control.
     * @param {'fit' | number} level — 'fit' or pxPerSec value
     */
    setTimeZoom(level)

    /**
     * Re-measure container and re-render. Called on drag-handle
     * resize and window resize events.
     */
    resize()

    // ── Lifecycle ──────────────────────────────────────────────

    /**
     * Tear down: cancel rAF, remove listeners, remove DOM, release ctx.
     */
    destroy()
}
```

### 16.2 Callbacks

Set by the `DagStudio` orchestrator after construction:

```javascript
gantt.onNodeSelected   = (nodeId) => { /* … */ }
gantt.onNodeHovered    = (nodeId) => { /* … */ }
gantt.onNodeUnhovered  = ()       => { /* … */ }
```

### 16.3 Private Methods

| Method | Responsibility |
|--------|---------------|
| `_calculateTimeScale(start, end)` | Returns `{ unit, tickInterval, pxPerSec, totalSec }` |
| `_renderBars()` | Full bar-grid canvas repaint (all 7 passes) |
| `_renderTimeAxis()` | DOM overlay — tick labels + total duration |
| `_renderGridlines()` | Canvas pass 2 — major/minor ticks, layer separators |
| `_renderNowMarker()` | Canvas pass 4 — live marker line |
| `_renderBottlenecks()` | Canvas pass 6 — left borders + row tint |
| `_renderParallelLimitLine()` | Canvas pass 7 — dashed limit line |
| `_hitTest(x, y)` | Returns `nodeId` or `null`. O(1). |
| `_startAnimationLoop()` | Begin `requestAnimationFrame` cycle |
| `_stopAnimationLoop()` | Cancel rAF, set `_animating = false` |
| `_handleMouseMove(e)` | Hover detection via hit-test, tooltip positioning |
| `_handleMouseClick(e)` | Selection via hit-test, fire `onNodeSelected` |
| `_handleWheel(e)` | Ctrl+wheel → zoom, Shift+wheel → pan |
| `_handleKeyDown(e)` | Keyboard interactions (Section 13) |
| `_sortNodes(nodes, layout)` | Layer → startTime → alpha sort |
| `_createPatternCanvases()` | Build hatch/stripe offscreen patterns |
| `_detectBottlenecks(nodes)` | Flag nodes running solo > 20% of total |
| `_formatDuration(ms)` | `2.33s`, `1m 23s`, `2h 05m` |
| `_applyDPR(canvas)` | Scale canvas for `devicePixelRatio` |

---

## 17. Data Flow

### 17.1 Initial Load (Historical or Live)

```
DagExecutionInstance (from API or AutoDetector)
  │
  ▼
DagStudio._loadExecution(iterationId)
  │
  ├──▶ DagCanvasRenderer.overlayMetrics(nodeMetrics)
  │      └── Updates node colours/badges on graph
  │
  └──▶ DagGantt.renderExecution(executionInstance)
         ├── Extract nodeExecutionMetrics map
         │     NodeExecutionMetrics {
         │       Status, StartedAt, EndedAt,
         │       SessionId, ReplId,
         │       AddedRowsCount, DroppedRowsCount,
         │       TotalRowsProcessed,
         │       ErrorCode, ErrorMessage, Warnings
         │     }
         ├── Sort by layer + startTime
         ├── Calculate time scale
         ├── Render canvas bars + DOM labels
         └── If status === Running → start animation loop
```

### 17.2 Live Updates

```
AutoDetector.onExecutionUpdated(id, exec)
  │
  ▼
DagStudio._onExecutionUpdated(id, exec)
  │
  ├──▶ DagCanvasRenderer.updateNodeState(nodeId, status)
  │
  └──▶ DagGantt.updateBar(nodeId, { status, startedAt, endedAt })
         ├── New node    → insert row, create bar
         ├── Running     → update barWidth (rAF loop handles growth)
         └── Terminal    → freeze bar, apply final status colour
```

### 17.3 Comparison Flow

```
ExecutionHistory.onCompareRequested(runIdA, runIdB)
  │
  ▼
DagStudio._loadComparison(runIdA, runIdB)
  │
  ├── Fetch both DagExecutionInstances
  │
  └──▶ DagGantt.renderComparison(instanceA, instanceB)
         ├── Merge node lists (union by nodeId)
         ├── Double row heights to 48px
         ├── Render paired bars (solid A / striped B)
         ├── Calculate timing deltas per node
         └── Render comparison summary footer
```

---

## 18. Accessibility

### 18.1 ARIA Roles

The canvas is opaque to assistive technology. A hidden DOM structure provides
equivalent information:

```html
<div role="region" aria-label="DAG execution timeline">
  <!-- Hidden screen-reader list, mirrors visible rows -->
  <ul role="list" class="sr-only" aria-live="polite">
    <li>SourceA, Completed, 2.3 seconds, 1234 rows added</li>
    <li>SourceB, Running, 5.1 seconds elapsed</li>
    <!-- … -->
  </ul>
  <!-- Visible canvas + DOM overlay -->
  <canvas aria-hidden="true"></canvas>
</div>
```

### 18.2 Keyboard Navigation

Full keyboard support documented in Section 13. Focus ring uses 2px dashed
`--accent` outline.

### 18.3 Colour-Blind Safety

Status is **never** encoded by colour alone. Every status has a distinct
pattern or shape:

| Status | Colour | Pattern | Shape/Treatment |
|--------|--------|---------|-----------------|
| Completed | `--status-succeeded` | Solid | Full bar |
| Failed | `--status-failed` | Diagonal hatch | Hatched bar |
| Cancelled | `--status-cancelled` | Vertical stripe | Striped bar |
| Skipped | `--status-pending` | Solid, low opacity | Dotted outline |
| Pending | — | — | Dashed midline |
| Running | `--accent` | Solid | Pulsing bar |

### 18.4 Reduced Motion

When `prefers-reduced-motion: reduce` is active:

- Pulse animations are disabled (steady opacity)
- Bar growth is instant (jump to current width each frame)
- Row insertion is instant (no slide transition)
- Scroll-into-view snaps instead of smooth-scrolling

### 18.5 Display Scaling

- Canvas is DPI-aware: dimensions multiplied by `devicePixelRatio`, CSS size
  set to logical pixels
- Browser zoom is respected — canvas re-renders on `resize` observer callback
- High contrast mode: bar outlines thicken to 2px, pattern contrast increased

---

## 19. Open Questions

| # | Question | Impact | Proposed Resolution |
|---|----------|--------|---------------------|
| 1 | Should the Gantt time axis sync with a shared "playback" scrubber for replaying executions? | Nice-to-have | Defer to post-MVP. |
| 2 | Should we support exporting the Gantt as PNG/SVG for incident reports? | Medium — engineers share timelines in Teams | Canvas `toDataURL()` is trivial. Add to V2 scope. |
| 3 | Should comparison mode support > 2 runs? | Low — 2-run diff covers 95% of cases | No. Keep at exactly 2. |
| 4 | Should the bottleneck threshold (20%) be configurable? | Low | Hardcode for MVP. Consider settings in V2. |
