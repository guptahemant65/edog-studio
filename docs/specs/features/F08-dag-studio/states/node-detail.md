# Node Detail Panel — State Matrix

> **Status:** DRAFT
> **Owner:** Pixel (Frontend)
> **Reviewer:** Sentinel
> **Component Spec:** `../components/node-detail.md`
> **Total States:** 19

---

## State Diagram

```
                          ┌───────────┐
                          │  closed   │◄──── Escape / click empty / close button
                          └─────┬─────┘
                                │ click node (graph or Gantt)
                                ▼
                          ┌───────────┐
                          │  opening  │ (160ms slide-in animation)
                          └─────┬─────┘
                                │ transitionend
                     ┌──────────┼──────────────────────────────────┐
                     ▼          ▼          ▼          ▼            ▼
              ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
              │  open.   ││  open.   ││  open.   ││  open.   ││  open.   │
              │ overview ││ metrics  ││  logs    ││  code    ││  deps    │
              └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘
                     │          │          │          │            │
                     │          │          │          │            │
                     ▼          ▼          ▼          ▼            ▼
              ┌──────────┐                     ┌──────────┐┌──────────┐
              │  open.   │                     │  open.   ││  open.   │
              │ history  │                     │  code.   ││  logs.   │
              └──────────┘                     │unavailable││ loading │
                                               └──────────┘└─────┬───┘
                                                                  │
                                                           ┌──────┴──────┐
                                                           ▼             ▼
                                                    ┌──────────┐ ┌──────────┐
                                                    │  open.   │ │  open.   │
                                                    │  logs.   │ │  logs.   │
                                                    │ populated│ │  empty   │
                                                    └──────────┘ └──────────┘

Cross-cutting states (can combine with any open.* state):
  ┌───────────────┐  ┌─────────────────┐  ┌────────────────┐
  │  open.error   │  │  node.changed   │  │   resizing     │
  └───────────────┘  └─────────────────┘  └────────────────┘

  ┌───────────────┐  ┌─────────────────┐
  │ disconnected  │  │  open.pinned    │
  └───────────────┘  └─────────────────┘
```

---

## State Definitions

### S01: `closed`

| Property | Value |
|----------|-------|
| **Description** | Panel is not visible. No node selected (or node deselected). |
| **Entry triggers** | Initial state; `Escape` key; click empty canvas space; close button (✕); programmatic `panel.hide()` |
| **Visual** | Panel has `display: none` or `translateX(100%)` with `visibility: hidden` (after close animation completes). Graph occupies full width. |
| **DOM** | Panel container exists in DOM but hidden. Content cleared to free memory. |
| **Focus** | Returns to the graph canvas or the previously focused element. |
| **Transitions** | → `opening` (on node click) |

---

### S02: `opening`

| Property | Value |
|----------|-------|
| **Description** | Panel is animating into view (slide from right). |
| **Entry triggers** | Node selected via click in graph or Gantt; keyboard `Enter` on highlighted node. |
| **Duration** | 160ms. `cubic-bezier(0.4, 0, 0.2, 1)`. |
| **Visual** | Panel slides from `translateX(100%)` → `translateX(0)`. Graph canvas width shrinks simultaneously. |
| **During animation** | Panel is `visibility: visible`, `pointer-events: none` (prevent interaction during slide). Header content renders immediately; tab content renders on completion. |
| **Graph** | Canvas width = `container.width - panelWidth`. Canvas re-renders at new width on `transitionend`. |
| **Transitions** | → `open.overview` (default tab after animation completes); → `open.{lastActiveTab}` (if panel was previously open and re-opened for same node). |
| **Edge case** | If user clicks a different node during animation: queue the node change, complete animation, then apply `node.changed` transition. |

---

### S03: `open.overview`

| Property | Value |
|----------|-------|
| **Description** | Panel open, Overview tab active. Shows node identity + execution summary + validation state. |
| **Entry triggers** | Default after `opening`; tab click/keyboard to "Overview"; fallback when current tab becomes unavailable after `node.changed`. |
| **Visual** | Overview tab underlined in tab bar. Content scrollable. Sections: Identity, Execution Summary (if loaded), Cross-Lakehouse (if external), Validation Errors (if faulted), Warnings (if present). |
| **Data** | `node` (always available), `nodeExecMetrics` (nullable — only when execution loaded). |
| **Empty sections** | Sections with no data are hidden entirely (not shown with "N/A"). |
| **Transitions** | → `open.metrics` / `open.logs` / `open.code` / `open.deps` / `open.history` (tab switch); → `node.changed` (different node selected); → `resizing` (drag resize handle); → `closing` → `closed` (Escape/close); → `disconnected` (WebSocket lost). |

---

### S04: `open.metrics`

| Property | Value |
|----------|-------|
| **Description** | Panel open, Metrics tab active. Deep execution numbers. |
| **Entry triggers** | Tab click/keyboard to "Metrics". |
| **Guard** | `nodeExecMetrics` must exist. If tab is clicked but no metrics: redirect to `open.overview` and show toast "No execution data for this node." |
| **Visual** | Metrics tab underlined. Sections: Row Counts, DQ Violation Breakdown (collapsed by default), Spark IDs, Timing Breakdown, MLV Identity. |
| **Special values** | `-1` values from API render as "N/A" in muted text. `0` renders normally. |
| **DQ section** | Collapsed if `totalViolations === 0`. Expandable accordion if > 0. |
| **Spark links** | Session ID is a clickable link. If Spark Inspector view is unavailable, link is `aria-disabled` with tooltip. |
| **Transitions** | → any other `open.*` tab; → `node.changed`; → `resizing`; → `closed`. |

---

### S05: `open.logs`

| Property | Value |
|----------|-------|
| **Description** | Panel open, Logs tab active. Umbrella state — immediately transitions to a sub-state. |
| **Entry triggers** | Tab click/keyboard to "Logs". |
| **Transitions** | → `open.logs.loading` (always — filtering is async even if fast). |

---

### S06: `open.logs.loading`

| Property | Value |
|----------|-------|
| **Description** | Logs tab is active; filtering the log stream for matching entries. |
| **Entry triggers** | Entering `open.logs`; re-filter after search text change; re-filter after level filter change. |
| **Visual** | 3 skeleton placeholder rows (animated shimmer). Level filter and search box are interactive (user can type while loading). |
| **Duration** | Target: < 100ms. If log stream is large (10,000+ entries), may take up to 200ms. |
| **Transitions** | → `open.logs.populated` (matches found); → `open.logs.empty` (no matches). |

---

### S07: `open.logs.populated`

| Property | Value |
|----------|-------|
| **Description** | Logs tab showing filtered entries. |
| **Entry triggers** | Filter completed with results. |
| **Visual** | List of log entries. Count label: "Showing N of M entries." Level filter and search active. "Open in Logs View →" button at bottom. |
| **Live updates** | If execution is running: new matching entries append. If user is scrolled to bottom: auto-scroll. If scrolled up: show "N new entries ▾" badge at bottom; click → scroll to bottom. |
| **Virtual scroll** | If > 100 filtered entries: virtualize the list (render only visible rows + 10-row buffer). |
| **Expand** | Click entry → inline expand showing full log message, metadata, source. Click again → collapse. |
| **Transitions** | → `open.logs.loading` (filter change); → `open.logs.empty` (filter narrowed to zero results); → `node.changed`; → `closed`. |

---

### S08: `open.logs.empty`

| Property | Value |
|----------|-------|
| **Description** | Logs tab active but no entries match the filter. |
| **Entry triggers** | Filter completed with zero results. |
| **Visual** | Centered message. Two variants: |
| | **Has execution data:** "No log entries match this node's execution window." |
| | **No execution data:** "No matching log entries. Run the DAG or select a historical execution." |
| | **Disconnected:** "Connect to FLT service to see logs." |
| **Filter controls** | Still interactive. User can broaden filter. |
| **Transitions** | → `open.logs.loading` (filter change); → `open.logs.populated` (live entry arrives matching filter); → `node.changed`; → `closed`. |

---

### S09: `open.code`

| Property | Value |
|----------|-------|
| **Description** | Panel open, Code tab active. Shows code reference (V1) or rendered code (V2). |
| **Entry triggers** | Tab click/keyboard to "Code". |
| **Guard** | Check `node.codeReference`. |
| **Visual (V1)** | If `codeReference` exists: show notebook ID, cell indices, "Open Notebook in Fabric Portal →" link. Plus placeholder: "Code preview available in a future release." |
| **Transitions** | → `open.code.unavailable` (if `codeReference` is null/undefined); → any other `open.*` tab; → `node.changed`; → `closed`. |

---

### S10: `open.code.unavailable`

| Property | Value |
|----------|-------|
| **Description** | Code tab active, but no code reference exists for this node. |
| **Entry triggers** | `open.code` guard fails (`node.codeReference` is null). |
| **Visual** | Centered message: "No code reference available for this node. This node may be a source table or shortcut without associated code." |
| **No actions** | No buttons, no links. |
| **Transitions** | → `open.code` (after `node.changed` to a node with `codeReference`); → any other `open.*` tab; → `closed`. |

---

### S11: `open.deps`

| Property | Value |
|----------|-------|
| **Description** | Panel open, Dependencies tab active. Parent and child node lists. |
| **Entry triggers** | Tab click/keyboard to "Deps". |
| **Visual** | Two sections: "Parents (N)" and "Children (N)". Each row: status dot, name, type badge, execution indicator. |
| **Interaction** | Click row → fires `node.changed` transition to that node. `Enter` on focused row → same. Arrow keys move focus between rows. |
| **Empty** | If no parents: "No parents — this is a source node." If no children: "No children — this is a terminal node." |
| **Execution indicators** | Uses the same execution data from `nodeExecMetrices` for each parent/child. If no execution loaded: show `—` (dash) for all. |
| **Transitions** | → `node.changed` (click a dependency row); → any other `open.*` tab; → `resizing`; → `closed`. |

---

### S12: `open.history`

| Property | Value |
|----------|-------|
| **Description** | Panel open, History tab active. Per-node performance across executions. |
| **Entry triggers** | Tab click/keyboard to "History". |
| **Guard** | At least 1 historical execution with metrics for this node must be cached. If not: show empty state. |
| **Visual** | Sparkline (Canvas 2D, 100×40px) at top. Stats row (avg, min, max, p95). History table below. |
| **Sparkline** | Line chart of duration values. Current execution highlighted with solid marker. Average as dashed horizontal line. |
| **Anomaly badge** | If current duration > 3× average: amber badge "N× slower than average." If > 10×: red badge. If < 0.3× average: green badge "N× faster than average." |
| **Table** | Rows: iteration (truncated ID + relative time), status pill, duration, rows processed, delta from average. |
| **Click row** | Loads that execution into graph + Gantt (delegates to DagStudio). |
| **Empty state** | "Run the DAG at least twice to see performance trends." |
| **Transitions** | → any other `open.*` tab; → `node.changed`; → `closed`. |

---

### S13: `open.error`

| Property | Value |
|----------|-------|
| **Description** | Cross-cutting state. Error banner is visible in the header area. Combines with any active tab state. |
| **Entry triggers** | Node has `nodeExecMetrics.status === 'failed'`; or `node.isFaulted === true` with error info. |
| **Visual** | Red error banner below header status line. Always visible regardless of active tab. Contains: error code (bold, monospace), error message, failure type badge (`UserError` amber / `SystemError` red). |
| **Actions** | "Copy Error" button → copies formatted error block. "Jump to Logs →" → switches to `open.logs` and auto-scrolls to first ERROR-level entry. |
| **Banner sizing** | Max 3 lines of error message visible. "Show more" toggle if message is longer. |
| **Stacking** | If BOTH `node.isFaulted` (validation error) AND `nodeExecMetrics` has error (runtime error): show both banners stacked. Validation error (amber) above runtime error (red). |
| **Transitions** | Clears when `node.changed` to a non-error node. Persists across tab switches. |

---

### S14: `node.changed`

| Property | Value |
|----------|-------|
| **Description** | Transient state. User selected a different node while panel is open. Content transitions to new node. |
| **Entry triggers** | Click different node in graph; click different Gantt bar; click dependency row in Deps tab; keyboard arrow nav to adjacent node. |
| **Duration** | 160ms total (80ms fade-out + 80ms fade-in). |
| **Sequence** | 1. Header updates immediately (name, type, status — no fade). 2. Error banner updates immediately (add/remove). 3. Tab content crossfades: current → opacity 0 (80ms) → new content → opacity 1 (80ms). 4. Scroll positions reset to top for all tabs. |
| **Tab preservation** | Stay on current tab if available for new node. If current tab is `open.metrics` but new node has no execution data → fall back to `open.overview`. If current tab is `open.code` and new node has no `codeReference` → stay on code tab (shows `open.code.unavailable`). |
| **Rapid changes** | If user clicks nodes faster than 160ms: cancel pending fade, immediately show latest node. Debounce to 80ms minimum. |
| **Data** | Clear previous node's derived data (filtered logs, history stats). Recompute from caches. |
| **Transitions** | → `open.{activeTab}` (transition complete). |

---

### S15: `resizing`

| Property | Value |
|----------|-------|
| **Description** | User is dragging the resize handle to change panel width. |
| **Entry triggers** | `mousedown` on left-edge resize handle (4px hit zone). |
| **Visual** | Resize handle highlighted (accent color line). Cursor: `col-resize` on entire viewport (via document-level cursor override). |
| **Behavior** | Panel width updates in real-time following cursor X position. Graph canvas width = `containerWidth - panelWidth`. |
| **Constraints** | Min: 280px. Max: 50% of container. Values outside range: clamp, don't snap. |
| **Graph** | Canvas must re-render during resize. Throttle to `requestAnimationFrame` (one render per frame max). |
| **Persistence** | Store final width in `localStorage` key `edog-node-detail-width`. Restore on next panel open. |
| **Transitions** | → `open.{activeTab}` (on `mouseup`). |
| **Keyboard** | If resize handle is focused: `Left`/`Right` arrow keys resize by 20px increments. |

---

### S16: `closing`

| Property | Value |
|----------|-------|
| **Description** | Panel is animating out of view. |
| **Entry triggers** | `Escape` key; close button (✕); click empty canvas; programmatic `panel.hide()`. If pinned (`open.pinned`): only close button and Escape trigger closing, not empty canvas click. |
| **Duration** | 160ms. Reverse of opening: `translateX(0)` → `translateX(100%)`. |
| **Visual** | Panel slides right and fades. Graph canvas width expands simultaneously. |
| **During animation** | `pointer-events: none` on panel. |
| **Graph** | Re-renders at full width on `transitionend`. |
| **Transitions** | → `closed` (animation complete). |

---

### S17: `disconnected`

| Property | Value |
|----------|-------|
| **Description** | Cross-cutting state. WebSocket connection to FLT service is lost. |
| **Entry triggers** | WebSocket `close` event; FLT service stops; network interruption. |
| **Visual** | Muted overlay bar at bottom of panel: "⚠ Disconnected — live data unavailable." Static data (node metadata, cached metrics) remains visible. |
| **Affected tabs** | **Logs:** Shows "Connect to FLT service to see logs" if no cached entries. Live updates stop. **Metrics:** Cached data still visible, but marked as "Last updated: {timestamp}." **History:** Cached data visible. No new executions can be loaded. |
| **Unaffected** | Overview (static node data), Code (reference data), Dependencies (static DAG structure). |
| **Recovery** | On WebSocket reconnect: remove overlay, resume live log updates, refresh execution data. |
| **Transitions** | → any `open.*` state (on reconnect). |

---

### S18: `open.pinned`

| Property | Value |
|----------|-------|
| **Description** | Cross-cutting modifier. Panel stays open when user clicks empty canvas space. |
| **Entry triggers** | User clicks pin icon in panel header. |
| **Visual** | Pin icon filled/highlighted. Panel border-top gets subtle accent indicator. |
| **Behavior** | Clicking empty canvas deselects the node in the graph but does NOT close the panel. Panel retains last node's data. Only close button (✕) and Escape close the panel. |
| **Toggle** | Click pin again → unpin. Panel reverts to default behavior (closes on empty-click). |
| **Transitions** | Clears on close. Does not persist across view switches. |

---

### S19: `open.logs.live`

| Property | Value |
|----------|-------|
| **Description** | Logs tab is populated and receiving live updates (execution currently running for this node). |
| **Entry triggers** | `open.logs.populated` + `nodeExecMetrics.status === 'running'`. |
| **Visual** | Pulsing blue dot next to "Logs" tab label. Live indicator in tab content: "● Live" badge. New entries animate in from bottom (fade-in 80ms). |
| **Auto-scroll** | If scroll position is at bottom (within 50px): auto-scroll on new entry. If user scrolled up: show floating badge "N new entries ▾" at bottom; click scrolls to bottom. |
| **Transition to static** | When `nodeExecMetrics.status` changes from `running` to `completed`/`failed`/`cancelled`: remove pulsing indicator, remove "Live" badge, stop auto-scroll. |
| **Transitions** | → `open.logs.populated` (execution completes); → `open.logs.loading` (filter change); → `node.changed`; → `closed`. |

---

## Transition Matrix

All valid state transitions. Read as: Row state → Column state.

| From ↓ / To → | closed | opening | open.overview | open.metrics | open.logs | open.logs.loading | open.logs.populated | open.logs.empty | open.logs.live | open.code | open.code.unavail | open.deps | open.history | open.error | node.changed | resizing | closing | disconnected | open.pinned |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **closed** | — | ✓ click node | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| **opening** | — | — | ✓ anim done | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| **open.overview** | — | — | — | ✓ tab | ✓ tab | — | — | — | — | ✓ tab | — | ✓ tab | ✓ tab | ✓ error | ✓ new node | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **open.metrics** | — | — | ✓ tab | — | ✓ tab | — | — | — | — | ✓ tab | — | ✓ tab | ✓ tab | ✓ error | ✓ new node | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **open.logs.loading** | — | — | ✓ tab | ✓ tab | — | — | ✓ found | ✓ empty | — | ✓ tab | — | ✓ tab | ✓ tab | — | ✓ new node | — | ✓ close | ✓ ws lost | — |
| **open.logs.populated** | — | — | ✓ tab | ✓ tab | — | ✓ refilter | — | ✓ narrowed | ✓ live | ✓ tab | — | ✓ tab | ✓ tab | — | ✓ new node | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **open.logs.empty** | — | — | ✓ tab | ✓ tab | — | ✓ refilter | ✓ live in | — | — | ✓ tab | — | ✓ tab | ✓ tab | — | ✓ new node | — | ✓ close | ✓ ws lost | — |
| **open.logs.live** | — | — | ✓ tab | ✓ tab | — | ✓ refilter | ✓ exec done | — | — | ✓ tab | — | ✓ tab | ✓ tab | — | ✓ new node | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **open.code** | — | — | ✓ tab | ✓ tab | ✓ tab | — | — | — | — | — | — | ✓ tab | ✓ tab | — | ✓ new node | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **open.code.unavail** | — | — | ✓ tab | ✓ tab | ✓ tab | — | — | — | — | ✓ node.changed | — | ✓ tab | ✓ tab | — | ✓ new node | — | ✓ close | ✓ ws lost | — |
| **open.deps** | — | — | ✓ tab | ✓ tab | ✓ tab | — | — | — | — | ✓ tab | — | — | ✓ tab | — | ✓ click dep | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **open.history** | — | — | ✓ tab | ✓ tab | ✓ tab | — | — | — | — | ✓ tab | — | ✓ tab | — | — | ✓ new node | ✓ drag | ✓ close | ✓ ws lost | ✓ pin |
| **node.changed** | — | — | ✓ done | ✓ done | ✓ done | — | — | — | — | ✓ done | ✓ done | ✓ done | ✓ done | ✓ error | — | — | — | — | — |
| **resizing** | — | — | ✓ mouseup | ✓ mouseup | — | — | ✓ mouseup | — | ✓ mouseup | ✓ mouseup | — | ✓ mouseup | ✓ mouseup | — | — | — | — | — | — |
| **closing** | ✓ anim done | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| **disconnected** | — | — | ✓ reconnect | ✓ reconnect | — | — | ✓ reconnect | — | — | ✓ reconnect | ✓ reconnect | ✓ reconnect | ✓ reconnect | — | — | — | ✓ close | — | — |

---

## State Invariants

Rules that must hold true regardless of current state:

| # | Invariant | Enforcement |
|---|-----------|-------------|
| I1 | Only ONE tab is active at a time. | Tab switch sets `aria-selected=true` on new tab, `false` on all others. |
| I2 | Error banner visibility is determined solely by node data, independent of active tab. | Banner render logic runs on every `node.changed` and initial `show()`. |
| I3 | Panel width is always within `[280px, 50% container]`. | Clamp on every resize frame + on window resize. |
| I4 | Graph canvas width = `container width - panel width` when panel is open. | Enforced on open, resize, and window resize events. |
| I5 | Focus never leaves the panel while it's open (tab trap) until Escape. | `focusTrap` utility scopes Tab key to panel descendants. |
| I6 | `node.changed` never fires when panel is in `closed` or `closing` state. | Guard check in `_onNodeSelected`: `if (this._state === 'closed') → opening; else → node.changed`. |
| I7 | Cached execution data is never mutated by the panel. | Panel reads from caches via reference; all derived data (filtered logs, stats) is local. |
| I8 | Skeleton loading states never last longer than 500ms. | Timeout: if filtering exceeds 500ms, render partial results with "Loading more..." indicator. |
| I9 | Every interactive element has a visible focus indicator. | CSS `:focus-visible` rule applied globally. Checked per state in testing. |
| I10 | `disconnected` state is additive — it does not override the current tab state. | Implemented as a flag (`this._disconnected`), not a state replacement. Overlay renders independently. |

---

## Focus Management Per State

| State | Focus Target | Screen Reader Announcement |
|-------|-------------|----------------------------|
| `closed` | Previously focused graph element | "Node detail panel closed" |
| `opening` | Panel container (on animation end) | "Node detail: {nodeName}, {status}" |
| `open.overview` | First interactive element in Overview | — |
| `open.metrics` | First metric value | — |
| `open.logs.loading` | Search input (ready for typing) | "Loading log entries" |
| `open.logs.populated` | First log entry | "{N} log entries found" |
| `open.logs.empty` | Search input | "No matching log entries" |
| `open.logs.live` | Last log entry (auto-scrolled) | "Live log stream active" |
| `open.code` | "Open Notebook" link | — |
| `open.code.unavailable` | Tab content region | "No code reference available" |
| `open.deps` | First dependency row | "{N} parents, {M} children" |
| `open.history` | Sparkline region | "Duration trend: average {X}s" |
| `open.error` | Error banner "Copy Error" button | "Error: {errorCode}" (assertive) |
| `node.changed` | Same element type in new content | "Node changed to {newNodeName}, {status}" |
| `resizing` | Resize handle | "Panel width: {width}px" |
| `closing` | Graph canvas (on animation end) | — |
| `disconnected` | No change | "Warning: disconnected from FLT service" |
| `open.pinned` | No change | "Panel pinned" |

---

## Error Recovery Matrix

What happens when things go wrong in each state:

| Error Condition | Current State | Recovery |
|----------------|---------------|----------|
| Selected node not found in DAG cache | Any `open.*` | Close panel with toast: "Node no longer exists in DAG." |
| `nodeExecMetrics` is null for current execution | `open.metrics` | Redirect to `open.overview`, toast: "No execution data for this node." |
| Log stream unavailable (WebSocket error) | `open.logs.*` | Show empty state: "Log stream unavailable." Retry on reconnect. |
| `codeReference.notebookId` fails validation | `open.code` | Show `open.code.unavailable` with message: "Invalid code reference." |
| History data empty (no cached executions) | `open.history` | Show empty state: "Run the DAG at least twice to see performance trends." |
| Resize handle drag outside viewport | `resizing` | Clamp to min/max. Release on `mouseleave` document edge. |
| Panel open + view switch away from DAG Studio | Any `open.*` | Close panel (no animation). Re-open on view switch back if node still selected. |
| Rapid node clicks (< 80ms apart) | `node.changed` | Debounce: only process the latest click. Cancel pending fade transitions. |
| `transitionend` never fires (CSS bug) | `opening` / `closing` | 300ms safety timeout: force-complete the state transition. |
| Window resize makes panel > 50% | `resizing` or any `open.*` | Clamp width. If window becomes too narrow (< 600px): auto-close panel. |

---

## Performance Budget Per State

| State | Operation | Budget | Measurement |
|-------|-----------|--------|-------------|
| `opening` | Slide animation + first content render | < 200ms | `performance.mark('panel-open-start')` → `performance.mark('panel-open-end')` |
| `open.logs.loading` | Filter log stream | < 100ms | `performance.mark('log-filter-start')` → `performance.mark('log-filter-end')` |
| `open.history` | Sparkline Canvas render | < 16ms | Must complete within single rAF frame |
| `node.changed` | Crossfade + data swap | < 160ms | Animation budget. Data swap must complete in < 50ms before fade-in starts. |
| `resizing` | Per-frame graph re-render | < 16ms | 60fps during drag. Throttle to rAF. |
| Tab switch (any) | Content swap | < 50ms | DOM update + scroll reset |
| `closing` | Slide-out + graph expand | < 200ms | Animation budget |
| Copy to clipboard | JSON serialization | < 10ms | For nodes with full metrics data |

---

## Testing Checklist (Sentinel)

| # | Test | States Covered | Pass Criteria |
|---|------|---------------|---------------|
| T01 | Click node → panel opens with correct name/status | `closed` → `opening` → `open.overview` | Name matches, status color correct, animation smooth |
| T02 | Press Escape → panel closes | Any `open.*` → `closing` → `closed` | Animation runs, focus returns to graph |
| T03 | Click different node → content swaps | `open.overview` → `node.changed` → `open.overview` | Header updates instantly, content crossfades, tab preserved |
| T04 | Rapid node clicks (< 80ms) → no jank | `node.changed` rapid | Only last node displayed, no visual glitches |
| T05 | Drag resize → width updates | Any `open.*` → `resizing` → `open.*` | Width clamps, graph re-renders, stored in localStorage |
| T06 | Metrics tab with `-1` values | `open.metrics` | Displays "N/A" not "-1" |
| T07 | Logs tab with running node → live updates | `open.logs.live` | New entries appear, auto-scroll works |
| T08 | Logs tab scroll up → "N new" badge | `open.logs.live` | Badge appears, click scrolls to bottom |
| T09 | Code tab with no codeReference | `open.code.unavailable` | Shows unavailable message, no errors |
| T10 | Dependencies tab → click parent | `open.deps` → `node.changed` | Panel updates to parent node |
| T11 | History sparkline with anomaly | `open.history` | Amber badge shown for 3× slower |
| T12 | Error banner + tab switch | `open.error` + any tab | Banner persists across tab switches |
| T13 | Disconnect during logs view | `open.logs.populated` → `disconnected` | Overlay shown, cached data preserved |
| T14 | Reconnect after disconnect | `disconnected` → `open.*` | Overlay removed, live updates resume |
| T15 | Pin panel → click empty canvas | `open.pinned` | Panel stays open, node deselected in graph |
| T16 | Keyboard: Ctrl+[ / Ctrl+] cycles tabs | Any `open.*` | Tabs cycle correctly, wrap around |
| T17 | Screen reader: panel open announcement | `opening` | Announces "Node detail: {name}, {status}" |
| T18 | Width < 1200px → overlay mode | Any `open.*` | Panel overlays graph, scrim visible |
| T19 | Panel open + switch away from DAG Studio | Any `open.*` | Panel closes cleanly, no orphaned state |
