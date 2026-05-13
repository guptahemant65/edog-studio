# Node Detail Panel — Component Spec

> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Owner:** Pixel (Frontend)
> **Reviewer:** Sentinel
> **Depends On:** `spec.md` § 2.5, F08 research docs (Node.cs, NodeExecutionMetrics)
> **State Matrix:** `../states/node-detail.md`

---

## 1. Purpose

When an engineer clicks a node in the DAG graph, the Node Detail Panel answers every question about that node in one place: what it is, how it ran, why it failed, and where to go next. No context switch, no terminal grepping. The engineer's eyes stay on the DAG; the detail slides in alongside it.

Design lineage: VS Code's Peek Definition (contextual overlay, not full navigation), Chrome DevTools Elements sidebar (tabbed sections, computed values), Datadog trace detail (timing, metadata, errors, linked spans).

---

## 2. Layout

### 2.1 Panel Placement

**Right-side slide-in panel** within the DAG Studio view. NOT a modal, NOT a bottom panel.

```
+--------------------------------------------------------------+
|  DAG Studio Toolbar (execution controls)                      |
+----------------------------------------------+---------------+
|                                              |               |
|                                              | Node Detail   |
|          DAG Graph (Canvas)                  | Panel         |
|                                              | (right        |
|                                              |  slide-in)    |
|                                              | 340px default |
+----------------------------------------------+               |
|  Bottom Panel (Gantt / History / Compare)     |               |
|  (tabbed, collapsible)                        |               |
+----------------------------------------------+---------------+
```

**Why right, not bottom:**
- Bottom space is occupied by Gantt/History tabs — stacking would compress both to unusable heights.
- Right panel preserves the graph's vertical real estate (node relationships flow LTR, so horizontal compression is less damaging).
- Matches VS Code's outline/peek pattern that FLT engineers use daily.

### 2.2 Dimensions

| Property | Value | Notes |
|----------|-------|-------|
| Default width | 340px | Enough for metadata table without horizontal scroll |
| Minimum width | 280px | Below this, labels truncate unreadably |
| Maximum width | 50% of DAG Studio container | Prevents graph from becoming unusable |
| Height | 100% of DAG Studio vertical area | Spans toolbar bottom to view bottom |
| Resize handle | Left edge, 4px drag zone | `cursor: col-resize` on hover |

### 2.3 Slide-in Animation

| Property | Value |
|----------|-------|
| Duration | 160ms |
| Easing | `cubic-bezier(0.4, 0, 0.2, 1)` (Design Bible standard) |
| Direction | Right edge inward (translateX: 100% -> 0) |
| Graph resize | Graph canvas shrinks to accommodate (no overlay) |

---

## 3. DOM Structure

```html
<aside class="node-detail-panel" id="nodeDetailPanel"
  role="complementary" aria-label="Node details"
  aria-hidden="true"> <!-- true when closed -->

  <!-- Header -->
  <header class="ndp-header">
    <div class="ndp-node-name">dbo.fact_sales</div>
    <div class="ndp-node-badges">
      <span class="ndp-badge ndp-badge--type">SQL</span>
      <span class="ndp-badge ndp-badge--status">Completed</span>
    </div>
    <button class="ndp-close" aria-label="Close detail panel">✕</button>
  </header>

  <!-- Tab bar -->
  <nav class="ndp-tabs" role="tablist">
    <button role="tab" aria-selected="true">Overview</button>
    <button role="tab">Metrics</button>
    <button role="tab">Logs</button>
    <button role="tab">Code</button>
    <button role="tab">Deps</button>
  </nav>

  <!-- Tab content -->
  <div class="ndp-content" role="tabpanel">
    <!-- Content rendered by active tab -->
  </div>
</aside>
```

---

## 4. Data Contract

### 4.1 Node Identity (from Node.cs)

| Field | Display |
|-------|---------|
| `Name` | Panel header title (e.g., "dbo.fact_sales") |
| `Kind` | Type badge: "SQL" or "PY" |
| `TableType` | Determines executability indicator |
| `NodeId` | Internal key, not displayed to user |
| `RefreshPolicy` | "Full Refresh" or "Incremental Refresh" label |
| `Executable` | If false, execution actions are disabled |
| `IsFaulted` | If true, shows error banner in Overview tab |
| `FLTErrorCode` | Error code shown when faulted |

### 4.2 Location Fields (from Node.cs)

| Field | Display |
|-------|---------|
| `ExternalWorkspaceName` | "Workspace: {name}" (shown if external) |
| `ExternalLakehouseName` | "Lakehouse: {name}" (shown if external) |
| `AbfsPath` | OneLake path, copyable |
| `IsShortcut` | "Shortcut" badge if true |

### 4.3 Execution Metrics (from NodeExecutionMetrics)

| Field | Display |
|-------|---------|
| `Status` | Status badge with color |
| `StartedAt` / `EndedAt` | Duration: "1m 23s", Start/End timestamps |
| `AddedRowsCount` | "Rows Added: 12,345" (-1 shows "N/A") |
| `DroppedRowsCount` | "Rows Dropped: 23" (DQ violations) |
| `TotalRowsProcessed` | "Total Processed: 12,368" |
| `TotalViolations` | "DQ Violations: 23" |
| `ErrorCode` / `ErrorMessage` | Error section (red banner) |
| `NodeErrorDetails` | Expandable error details |
| `SessionId` | Spark session link (copyable GUID) |
| `ReplId` | REPL session link (copyable GUID) |
| `RefreshPolicy` | "Full Refresh" or "Incremental Refresh" |
| `DqCheckResults` | DQ check table (rule name, pass/fail, violation count) |
| `Warnings` | Warning list (amber indicators) |
| `DetailsPageLink` | "View in Fabric" external link |

### 4.4 Code References (from Node.cs)

| Field | Display |
|-------|---------|
| `CodeReference` | Link to PySpark notebook (for pyspark nodes) |
| `DqCodeReference` | Link to DQ notebook |

---

## 5. Tab Sections

### 5.1 Overview Tab (default)

The first thing the engineer sees. Answers: "What is this node and what's its current state?"

| Section | Content |
|---------|---------|
| **Identity** | Name, Kind badge, TableType, RefreshPolicy |
| **Status** | Current execution status with colored indicator |
| **Timing** | Duration, start time, end time (if executed) |
| **Location** | Workspace, Lakehouse, AbfsPath (if external: workspace + lakehouse names) |
| **Error** | Error banner if `IsFaulted` or `Status === Failed` — shows ErrorCode + ErrorMessage |
| **Actions** | "Run This Node" button (disabled if not executable), "View in Fabric" link |

**Error banner styling:**
- Background: `rgba(229,69,59,0.08)` (failed tint)
- Left border: 3px `var(--status-failed)`
- Text: `var(--color-text)` for message, `var(--status-failed)` for error code
- Expandable "Show Details" for `NodeErrorDetails`

### 5.2 Metrics Tab

Detailed execution metrics. Answers: "How much data was processed and what were the quality results?"

| Section | Content |
|---------|---------|
| **Row Counts** | AddedRowsCount, DroppedRowsCount, TotalRowsProcessed (formatted with commas) |
| **Duration** | Start -> End timeline visual |
| **DQ Results** | Table: Rule Name, Status (pass/fail icon), Violations count |
| **Warnings** | List of warning strings with amber `●` prefix |
| **Sessions** | SessionId (copyable), ReplId (copyable) — both are persisted GUIDs |

Values of -1 display as "N/A" in `var(--color-text-tertiary)`.

### 5.3 Logs Tab

Error logs and execution output. Content depends on execution state:
- **Not yet executed:** "No execution data" message
- **Running:** "Execution in progress..." with subtle pulse
- **Completed/Failed:** Error messages, warnings, details page link

### 5.4 Code Tab

Links to associated notebooks:
- **PySpark nodes:** Link to `CodeReference` notebook
- **SQL nodes:** "SQL nodes do not have notebook references" info message
- **DQ notebook:** Link to `DqCodeReference` if available
- **Unavailable:** "Code reference not available" if `CodeReference` is null

### 5.5 Deps Tab (Dependencies)

Shows the node's position in the dependency graph:

| Section | Content |
|---------|---------|
| **Parents (upstream)** | List of parent node names with status indicators, clickable to select |
| **Children (downstream)** | List of child node names with status indicators, clickable to select |
| **Depth** | Layer position in Sugiyama layout |

Each dependency entry is clickable — clicking navigates to that node (selects it in graph, updates detail panel).

---

## 6. Visual Encoding

### 6.1 Panel Chrome

| Element | Token |
|---------|-------|
| Background | `var(--color-bg)` |
| Border (left edge) | `var(--color-border)` |
| Header background | `var(--color-bg-secondary)` |
| Tab bar background | `var(--color-bg)` |
| Active tab indicator | 2px bottom border `var(--accent)` |
| Inactive tab text | `var(--color-text-secondary)` |
| Active tab text | `var(--color-text)` |
| Close button | `var(--color-text-tertiary)`, hover: `var(--color-text)` |

### 6.2 Status Badges

| Status | Badge bg | Badge text | Symbol |
|--------|----------|------------|--------|
| None | `var(--color-bg-tertiary)` | `var(--color-text-tertiary)` | ● |
| Running | `var(--accent-dim)` | `var(--accent)` | ● (pulsing) |
| Completed | `rgba(24,160,88,0.1)` | `var(--status-succeeded)` | ● |
| Failed | `rgba(229,69,59,0.1)` | `var(--status-failed)` | ● |
| Cancelled | `rgba(229,148,12,0.1)` | `var(--status-cancelled)` | ● |
| Skipped | `var(--color-bg-tertiary)` | `var(--status-pending)` | ● |

### 6.3 Typography

| Element | Font | Size | Color |
|---------|------|------|-------|
| Node name (header) | system-ui, semibold | 14px | `var(--color-text)` |
| Section headers | system-ui, medium | 12px | `var(--color-text)` |
| Field labels | system-ui, regular | 11px | `var(--color-text-secondary)` |
| Field values | system-ui, regular | 11px | `var(--color-text)` |
| Error text | monospace | 11px | `var(--color-text)` |
| Muted values | system-ui, regular | 11px | `var(--color-text-tertiary)` |

---

## 7. Interaction Model

| Action | Behavior |
|--------|----------|
| Click node in graph | Open panel (or switch to clicked node if already open) |
| Click `✕` button | Close panel with slide-out animation |
| `Escape` key | Close panel |
| Click tab | Switch to tab content |
| `1-5` number keys | Switch tabs (when panel is focused) |
| Click dependency in Deps tab | Select that node in graph, update panel |
| Click "Run This Node" | Trigger single-node execution (SelectedOnly mode) |
| Click "View in Fabric" | Open `DetailsPageLink` in new browser tab |
| Click SessionId/ReplId | Copy GUID to clipboard |
| Drag left resize handle | Resize panel width (clamped to min/max) |
| Click "Show Details" (error) | Expand `NodeErrorDetails` section |
| Click AbfsPath | Copy to clipboard |

---

## 8. Real-Time Updates (SignalR)

When the detail panel is open and execution is running:

| Event | Panel Response |
|-------|----------------|
| `NodeStarted` (this node) | Status badge -> Running (pulse), timing section shows "In progress..." |
| `NodeCompleted` (this node) | Status -> Completed, duration calculated, row counts populated |
| `NodeFailed` (this node) | Status -> Failed, error banner appears with ErrorCode + ErrorMessage |
| `NodeStarted` (other node) | Deps tab updates dependency status indicators |
| `DagTerminal` | All metrics finalized, DQ results populated if available |

Updates are applied immediately — no manual refresh needed. The panel does NOT close during execution.

---

## 9. Error States

| Error Condition | Display |
|-----------------|---------|
| Node is faulted (`IsFaulted=true`) | Red error banner in Overview: "Node faulted: {FLTErrorCode}" |
| Execution failed (`Status=Failed`) | Red error banner: "{ErrorCode}: {ErrorMessage}", expandable details |
| Metrics unavailable (`AddedRowsCount=-1`) | Show "N/A" in `var(--color-text-tertiary)` |
| Code reference null | Code tab: "Code reference not available" info message |
| External node selected | "Run This Node" disabled, tooltip: "External nodes cannot be executed" |
| Non-executable node selected | "Run This Node" disabled, tooltip: "Only materialized lake views can be executed" |
| Shortcut node selected | "Run This Node" disabled, tooltip: "Shortcut tables cannot be executed" |
| WebSocket disconnect | Banner: "Live updates paused — reconnecting..." |

---

## 10. Accessibility

### 10.1 ARIA Structure

- Panel: `role="complementary"`, `aria-label="Node details"`
- Tab bar: `role="tablist"` with `role="tab"` buttons
- Tab panels: `role="tabpanel"`, `aria-labelledby` matching tab button
- Close button: `aria-label="Close detail panel"`
- `aria-hidden="true"` when panel is closed

### 10.2 Focus Management

| Event | Focus Target |
|-------|-------------|
| Panel opens | First tab button receives focus |
| Tab switch | Tab panel content receives focus |
| Panel closes | Previously focused node in graph receives focus |
| `Escape` pressed | Return focus to graph canvas |

### 10.3 Keyboard

| Key | Action |
|-----|--------|
| `Escape` | Close panel |
| `Tab` / `Shift+Tab` | Navigate within panel content |
| `Arrow Left` / `Arrow Right` | Move between tabs |
| `1` – `5` | Jump to specific tab |

### 10.4 Screen Reader

- Node name announced on panel open: "{Name}, {Kind}, {Status}"
- Status changes announced via `aria-live="polite"` region
- Error banners use `role="alert"`

---

## 11. Performance

| Metric | Target |
|--------|--------|
| Panel open (slide-in) | < 160ms animation |
| Tab switch | < 50ms content render |
| SignalR update | < 16ms DOM update |
| Memory per panel instance | < 1MB |

The panel is a single instance — switching nodes replaces content, doesn't create a new panel. DOM is reused across node selections.

---

## 12. API Dependencies

| Endpoint / Channel | Purpose |
|--------------------|---------|
| Node data from canvas (in-memory) | Node identity, type, location fields |
| `GET /api/dag/{dagId}/metrics` | Full metrics for selected node |
| SignalR `"dag"` topic | Real-time status + metric updates |
| `POST /api/dag/{dagId}/execute` | "Run This Node" action (SelectedOnly mode) |
| `CodeReference` / `DqCodeReference` URLs | External links to notebooks |
| `DetailsPageLink` | External link to Fabric details page |
