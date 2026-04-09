# EDOG DevMode v2 — Complete Design Specification

## Document Purpose
This is the authoritative feature specification for EDOG DevMode v2, compiled from product discussions on April 8, 2026. Every decision has been confirmed by the product owner. This document is intended to be handed to a UI/UX designer and engineering team for implementation.

---

## 1. Vision Overview

### What EDOG Is
EDOG DevMode is a **localhost developer cockpit** (web UI at `http://localhost:5555`) for FabricLiveTable (FLT) — Microsoft's materialized lake view service. It's used by senior C# backend engineers 8+ hours/day while developing FLT locally.

### Core Identity
**DevTools + Developer Workspace, with light monitoring.**
- Primary: Show what the service is doing (logs, telemetry, execution state) + let devs take action (run DAGs, browse data, test APIs, manage environments)
- Secondary: Monitoring (token health, lock state, error patterns) — persistent but not dominant

### Two-Phase Lifecycle

EDOG operates in two distinct modes:

**Phase 1: Disconnected (Browse & Explore)**
- User launches EDOG → authenticates via cert-based Playwright browser login → gets AAD/Entra bearer token
- Bearer token used for Fabric public APIs (`api.fabric.microsoft.com/v1/*`)
- Can browse tenants, workspaces, lakehouses, tables
- Can rename/create/delete workspaces and lakehouses
- Can manage feature flags (rollout visibility + create PRs), check capacity info
- Can use API Playground with bearer token
- **No MWC token needed. No FLT service running.**
- **Token serving**: Bearer token cached by edog.py, served to browser via `/api/flt/config` (existing endpoint, extended to include bearer token + phase indicator)

**Phase 2: Connected (Full DevTools)**
- User selects a lakehouse and clicks "Deploy to this Lakehouse"
- EDOG: updates edog-config.json (workspace_id, artifact_id, capacity_id) → uses SAME bearer token to call `fetch_mwc_token()` for that workspace/artifact → patches FLT code with MWC token → builds → launches service
- UI transitions: logs start streaming, DAG controls light up, Spark inspector captures traffic, API playground switches to MWC token for FLT-specific endpoints
- **Both tokens available**: Bearer for Fabric APIs, MWC for FLT service APIs
- **Full cockpit is live.**

**Phase Transition UI:**
- When deploying: inline progress bar in Workspace Explorer center panel showing each step (1/5 Fetching MWC token... 2/5 Patching code... 3/5 Building... 4/5 Launching service... 5/5 Waiting for service ready)
- Sidebar tabs 2-4 (Logs, DAG, Spark) transition from disabled empty-state to active
- Top bar: service status changes gray→amber→green, token countdown appears

### Default View on Launch
**Workspace Explorer** — "Here's your environment, pick a lakehouse, then work."

---

## 2. Always-Visible Top Bar (32px)

Persistent across all views. Shows critical status at a glance.

| Position | Element | Detail |
|----------|---------|--------|
| Left | EDOG wordmark | "EDOG" in brand font, 600 weight |
| Left | Service status | Dot indicator (green=Running, gray=Stopped, amber=Building) + uptime timer |
| Center | (breathing room) | Empty — not every pixel needs content |
| Right | Token health | Expiry countdown. Green >10min, amber 5-10min, red <5min. Click → Token Inspector drawer |
| Right | Git branch | Branch name + uncommitted file count badge |
| Right | Patch status | "6 patches" pill when EDOG patches are applied |
| Right | Restart button | Ghost button. Stops service → rebuilds → relaunches |

### File Change Detection (Hot Reload Prompt)
When EDOG detects C# file changes in the FLT repo (beyond EDOG's own patches and beyond the files that were present when the current session started), it shows a notification bar below the top bar:

> "Files changed: GTSBasedSparkClient.cs, WorkloadApp.cs — [Re-deploy] [Dismiss]"

Clicking **Re-deploy**: stops service → rebuilds → relaunches (same as restart, but triggered by file watch).

**Feasibility: ✅ Confirmed.** Can use Python `watchdog` library to monitor FLT repo files. Compare against known EDOG patch files to filter. Signal to UI via a new REST endpoint or WebSocket message.

---

## 3. Sidebar Navigation (48px, icon-only)

6 views, accessible via sidebar icons or keyboard shortcuts (1-6).

| # | Key | Icon | View | Available in Phase |
|---|-----|------|------|--------------------|
| 1 | 1 | Grid | Workspace Explorer | Both (disconnected + connected) |
| 2 | 2 | List | Logs | Connected only |
| 3 | 3 | Circuit/Diamond | DAG Studio | Connected only |
| 4 | 4 | Bolt | Spark Inspector | Connected only |
| 5 | 5 | Terminal | API Playground | Both (uses bearer token when disconnected, MWC when connected) |
| 6 | 6 | Sliders | Environment | Both |

Active indicator: accent-colored left border on active icon.
Bottom of sidebar: small dot showing token status color.

When disconnected, tabs 2-4 show a "Connect to a Lakehouse to enable this view" empty state with a link to Workspace Explorer.

---

## 4. View 1: Workspace Explorer ⭐ (Default View)

### Layout: Three-panel (master-detail-inspector)

---

### Left Panel (260px): Object Tree

**Hierarchy:**
```
▾ FabricFMLV08PPE (tenant)                    ← tenant level
  ▾ EDOG-Dev-Workspace                        ← workspace
    ● TestLakehouse-01                        ← lakehouse (highlighted, deployable)
    ● TestLakehouse-02                        ← lakehouse
    ○ AnalysisNotebook                        ← notebook (dimmed, non-FLT)
    ○ DataPipeline-Refresh                    ← pipeline (dimmed)
  ▸ EDOG-Staging-Workspace
  ▸ Team-SharedWorkspace
```

**Design rules:**
- 28px row height, compact
- Arrow toggles: ▸ (collapsed) / ▾ (expanded) in tertiary text color
- **Lakehouses highlighted** — slightly brighter text, small colored dot (green) to distinguish from other items
- Other artifact types (Notebooks, Pipelines, Warehouses, KQL DBs, Reports, etc.) shown but **dimmed/secondary**
- Non-lakehouse items: clicking opens in Fabric portal in new tab
- Selected item: subtle background highlight + accent left border

**Right-click context menu on any item:**
- Rename
- Delete (with confirmation)
- Open in Fabric (new tab)
- Copy ID
- Copy Name
- (For lakehouses): Deploy to this Lakehouse

**Bottom of tree:**
- "+ New Workspace" text link
- "Favorites" section showing bookmarked/named environments

**Tenant switching:**
- Small tenant selector at the very top of the tree
- Default: EDOG PPE tenant
- Can add other tenants if needed (re-authenticates)

**Feasibility: ✅ Confirmed.**
- `GET api.fabric.microsoft.com/v1/workspaces` → list workspaces (AAD token, `Workspace.Read.All`)
- `GET api.fabric.microsoft.com/v1/workspaces/{id}/items` → list all items in workspace
- `GET api.fabric.microsoft.com/v1/workspaces/{id}/lakehouses` → list lakehouses specifically
- All require AAD/Entra bearer token (same cert-based auth EDOG already does)

---

### Center Panel (flex): Content View

**When a workspace is selected:**
- Header: Workspace name, ID (click to copy), capacity badge (SKU + region), member count
- Section: Items list — all artifacts in workspace as a table
  - Columns: Name, Type (icon + label), Status, Last Modified
  - Lakehouses sorted to top, highlighted
- Workspace-level actions: Rename, Delete, Assign Capacity, Open in Fabric

**When a lakehouse is selected:**
- Header: Lakehouse name (editable on double-click), ID (click to copy), capacity badge, last modified
- **"Deploy to this Lakehouse" button** — primary action, accent colored. Only shown for lakehouses.
  - On click: confirms → updates edog-config → fetches MWC token → patches → builds → launches
  - Shows progress inline (Step 1/5: Fetching token... Step 2/5: Patching code... etc.)
- Section: **TABLES**
  - Table with columns: Name, Type (Delta/Parquet), Format, Location
  - Click row → populates right inspector panel
  - Hover reveals action dots (⋯) → Open in Fabric, Copy Name
- Section: **MLV DEFINITIONS** (if available via API)
  - Name, Refresh Mode, Status, Last Run

**When a non-lakehouse item is selected:**
- Show item metadata (name, type, ID, description, last modified)
- "Open in Fabric" as primary action (opens in new browser tab)
- Show whatever metadata the Fabric API returns for that item type

**Feasibility: ✅ Confirmed.**
- `GET /v1/workspaces/{id}/lakehouses/{id}/tables` → list tables (name, type, format, location)
- `PATCH /v1/workspaces/{id}/lakehouses/{id}` → rename lakehouse
- `DELETE /v1/workspaces/{id}/lakehouses/{id}` → delete lakehouse
- `POST /v1/workspaces/{id}/lakehouses` → create lakehouse
- `POST /v1/workspaces` → create workspace
- `PATCH /v1/workspaces/{id}` → rename workspace, update description
- MLV definitions: Shown in **connected mode only** via `getLatestDag` response — DAG nodes represent MLVs. In disconnected mode, MLV section shows "Deploy to view MLV definitions" placeholder.

---

### Right Panel (300px): Inspector

**When a table is selected (Phase 1 — disconnected):**
- Section: TABLE INFO — Name, Type, Format, Location as key-value pairs

**When a table is selected (Phase 2 — connected, future):**
- Section: SCHEMA — column list (name, type, nullable) in compact rows
- Section: PREVIEW — first 5 data rows in a mini-grid
- Section: STATS — Row Count, File Count, Total Size, Partitions
- Note: Schema/preview/stats require SQL endpoint or Delta metadata access — **Phase 2 feature**.

**When a workspace is selected:**
- Capacity info: SKU, Region, CU usage (if available from capacity API), throttling state
- Member list (if available)
- Item counts by type

**Feasibility notes:**
- Basic table metadata: ✅ Available from `List Tables` API
- Schema, row counts, data preview: ⚠️ Requires SQL endpoint connection or Delta metadata reading. **Phase 2.**
- Capacity info: ⚠️ Need to verify `GET /v1/capacities/{id}` API availability. Likely requires admin scope.

---

### Bottom Strip: New Test Environment Wizard

Collapsed state: "Create test environment →" as a text link at the bottom of the explorer.

Expanded state: Inline horizontal stepper (NOT a modal). Steps:

1. **Create Workspace** — Name input field
2. **Assign Capacity** — Dropdown of available capacities (fetched from API). Option to see capacity details (SKU, region, current usage). Option to request a new capacity (if API available).
3. **Create Lakehouse** — Name input (auto-suggested based on workspace name)
4. **Create Notebook + Write MLV SQL** — Code editor with MLV SQL template. User writes CREATE MATERIALIZED VIEW statements.
5. **Run Notebook** — Executes the notebook to create MLV definitions
6. **Verify** — Calls GetLatestDAG to confirm DAG was created correctly. Shows node count and structure.

Each step shows: status (pending/active/completed/failed), result summary when completed.

**Feasibility: ⚠️ Partially confirmed.**
- Create workspace: ✅ `POST /v1/workspaces`
- Assign capacity: ⚠️ `POST /v1/workspaces/{id}/assignToCapacity` — need to verify scope requirements
- Create lakehouse: ✅ `POST /v1/workspaces/{id}/lakehouses`
- Create notebook: ⚠️ Need to verify notebook creation API. Fabric has `POST /v1/workspaces/{id}/notebooks`
- Write to notebook: ⚠️ Need to verify notebook content update API
- Run notebook: ⚠️ Need to verify notebook execution API. May need to use Fabric Job Scheduler
- GetLatestDAG: ✅ Available via FLT service API (requires MWC token, so only after deploying)
- **Recommendation**: Research all APIs before implementing. Some steps may need workarounds (e.g., use Spark session via REST instead of notebook creation).

---

### Favorites / Named Environments

Persist across sessions (saved to edog-config.json or separate file).

```json
{
  "favorites": [
    { "name": "My Dev Lakehouse", "workspaceId": "...", "artifactId": "...", "capacityId": "...", "tenantId": "..." },
    { "name": "Team Staging", "workspaceId": "...", "artifactId": "...", "capacityId": "..." }
  ]
}
```

- Show as a "Favorites" section at the top of the tree (or as a separate dropdown in the top bar)
- "Save as Favorite" in right-click context menu on lakehouses
- One-click deploy from favorites

---

## 5. View 2: Logs (Enhanced)

**Available: Connected mode only.**

### Current functionality (keep everything):
- Real-time WebSocket streaming (150ms batches, 10K ring buffer)
- Virtual scroll for performance
- Level filters (Verbose/Message/Warning/Error)
- Component filter (auto-populated from stream)
- Text search (Ctrl+K or inline)
- Time range filters (All, 1m, 5m, 15m, 1h)
- RAID/IterationId filter with dropdown
- Preset filters (All, FLT, DAG, Spark)
- Export to JSON
- Pause/Resume stream
- Jump to next error

### New: Breakpoint Logs
- UI: A "Breakpoints" bar below the toolbar showing active breakpoints as small pills
- Each breakpoint: regex pattern + assigned highlight color
- "+" button to add new breakpoint (opens inline input: regex field + color picker)
- When a log entry matches a breakpoint regex → the entire row gets a colored left highlight strip (e.g., amber glow)
- **No auto-pause** — just visual highlighting
- Breakpoints persist for the session (not across restarts)

### New: Log Bookmarks
- Each log row has a small star icon in a gutter column (left side)
- Click star → entry is "pinned" (star fills)
- Pinned entries appear in a **Bookmarks drawer** that slides from the right (280px)
- Drawer shows: timestamp + level + truncated message for each pinned entry
- Click an entry in the drawer → scrolls to it in the main log view
- "Export Bookmarks" button → generates a self-contained HTML file or JSON with all pinned entries
- Bookmarks survive log clearing but not session restart

### New: Error Clustering
- When multiple logs have similar error messages (same pattern after stripping GUIDs, timestamps, numbers), group them:
  - "NullReferenceException in SparkClient ×7" — expandable to show all 7 entries
  - Show first and last occurrence timestamps
- Clustering runs client-side using simple template normalization (strip hex strings, GUIDs, numbers → hash remaining text)
- Display as collapsible groups above the individual entries, or as a summary panel

**Feasibility: ✅ All client-side JS. No backend changes needed for breakpoints and bookmarks. Error clustering is a client-side heuristic.**

---

## 6. View 3: DAG Studio

**Available: Connected mode only.**

### Top Half: Interactive DAG Graph

- Render the DAG from `getLatestDag` API response as an SVG graph
- **Nodes**: Rectangular boxes with:
  - Name (e.g., "RefreshSource", "TransformSales")
  - Type badge (SQL / PySpark)
  - Status-colored border (gray=pending, blue=running, green=completed, red=failed, dim=skipped)
- **Edges**: Lines showing dependency direction (parent → child)
- **During execution**: Running nodes have animated/pulsing border
- **Click a node** → detail panel shows:
  - Node SQL/PySpark code (if available)
  - Execution metrics (start time, duration, status, error code)
  - Filtered log entries for that node's time window
  - Retry count and retry details
- Zoom/pan controls + fit-to-screen button

### Bottom Half: Execution Controls + Timeline

**Controls:**
- "Run DAG" button (primary action, accent colored) — generates UUID, POSTs to `/liveTableSchedule/runDAG/{iterationId}`
- "Cancel DAG" button (ghost/destructive) — POSTs to `/liveTableSchedule/cancelDAG/{iterationId}`
- "Refresh DAG" button (ghost) — re-fetches DAG definition

**Gantt Chart:**
- Horizontal bars on a time axis showing per-node execution
- Each bar colored by status
- Shows parallelism visually (concurrent nodes stacked)

**History Table:**
- Last 10 executions: IterationId, Status, Duration, Node counts (total/completed/failed), Start time
- Click a row → loads that execution's data into the graph
- **"Compare" button** between two runs → shows side-by-side diff:
  - Which nodes changed status (was green, now red)
  - Timing differences (node X: 2s → 45s)
  - New errors

**Feasibility: ✅ Mostly confirmed.**
- DAG definition: `GET /liveTable/getLatestDag?showExtendedLineage=true` → nodes, edges, types, dependencies
- Run/Cancel: Existing endpoints already used by Command Center
- Execution state: Auto-detected from telemetry stream (ActivityName === 'RunDAG' + IterationId)
- Per-node metrics: Available from execution detection (node status, timing, error codes)
- Node SQL code: ❌ NOT in DAG response — `codeReference` only has notebook IDs + cell indices, not the actual code. Requires separate Notebook API call (Phase 2).
- SVG graph rendering: Client-side JS. Could use a simple layout algorithm (topological sort + level assignment) or a library like dagre-d3 (but single-file constraint means inline or custom).

---

## 7. View 4: Spark Inspector

**Available: Connected mode only.**

### Two-Panel Layout

**Left Panel: Request List**
- Each Spark HTTP call shown as a row:
  - Method badge: small colored pill (PUT=amber, GET=green, DELETE=red)
  - Endpoint path (truncated)
  - Status code pill (200=green, 429=amber, 500=red)
  - Duration
  - Retry count (if >0, show as "×3" badge)
- Sorted by timestamp, newest first
- Filter by: status (2xx/4xx/5xx), method, endpoint

**Right Panel: Request Detail (tabbed)**
- **Request tab**: Headers, SQL/PySpark code (syntax highlighted), session properties, lakehouse context
- **Response tab**: Status code, response headers, response body (JSON collapsible), error details (if any — errorCode, message, errorSource, errorStage, stackTrace from TransformErrorDetails)
- **Timing tab**: Waterfall visualization (Submit → Poll status → Complete), total duration, retry delays
- **Retry Chain** (if retries occurred): Visual timeline of all attempts with delay durations between them, reason for each retry (429 throttle, 430 capacity, 5xx server error)

**Feasibility: ✅ Now confirmed** (via research — see Appendix A).
- **Approach**: Subclass `GTSBasedSparkClient`, override `protected virtual SendHttpRequestAsync()` to capture request/response.
- Create `EdogTracingSparkClientFactory : ISparkClientFactory` wrapping the original factory.
- DI swap: `WireUp.RegisterSingletonType<ISparkClientFactory, EdogTracingSparkClientFactory>()` replaces original.
- New WebSocket message type: `{ type: 'spark_request', data: {...} }`
- New REST endpoint: `GET /api/spark-requests` for filtered history

---

## 8. View 5: API Playground

**Available: Both phases** (uses bearer token when disconnected, MWC token when connected).

### Layout: Split Pane (top/bottom)

**Top: Request Builder**
- Method selector: dropdown (GET/POST/PUT/PATCH/DELETE)
- URL field: with template variable auto-fill. Variables like `{workspaceId}`, `{artifactId}`, `{capacityId}` auto-populated from current config
- Pre-configured endpoint dropdown: quick-pick common endpoints
  - Fabric APIs: List Workspaces, List Lakehouses, List Tables, Get Lakehouse, Create Workspace, etc.
  - FLT APIs: GetLatestDag, RunDAG, CancelDAG, GetDAGExecStatus, GetDAGExecMetrics, etc.
  - Maintenance: ForceUnlockDAGExecution, ListOrphanedIndexFolders, etc.
- Headers editor: Key-value pairs. Authorization header pre-filled with current token.
- Body editor: JSON input area (for POST/PUT/PATCH)
- "Send" button (primary action)
- "Copy as cURL" button (ghost)

**Bottom: Response Viewer**
- Status badge (200 OK / 404 Not Found / etc.) with color
- Timing (e.g., "342ms")
- Response headers (collapsible)
- Response body: JSON with syntax coloring, collapsible nodes
- Raw text toggle

**Right Sidebar: History + Saved**
- **History**: Last 20 requests with method, URL, status, timestamp
  - Click to replay (re-populates request builder)
  - "Save" button on each history entry
- **Saved Requests**: Named requests categorized by type
  - Pre-populated with common FLT API calls
  - User can save custom requests
- **Batch Runner**: Queue multiple requests to run in sequence
  - Add from history or saved
  - Run all → shows results per request
  - Useful for: "Run DAG with dataset A, wait, check status, run with dataset B"

**Feasibility: ✅ Confirmed.**
- All HTTP calls made from browser using `fetch()` with provided token
- Template variables from edog-config.json (already served by `/api/flt/config`)
- cURL generation is simple string formatting
- History stored in browser localStorage
- Batch runner is sequential fetch with delay

---

## 9. View 6: Environment

**Available: Both phases** (some features require connected mode).

### Section: Feature Flags (Major Feature)

The FeatureManagement repo (`FeatureManagement/Features/Configuration/Features/`) contains 28 FLT-specific flags as JSON files. Each flag has: Id, Description, and per-environment rollout state (onebox, test/EDOG, daily, cst, dxt, msit, prod, sovereign clouds). Flags are resolved by `FeatureFlighter.IsEnabled()` using `FlightInput` (tenantId, capacityId, workspaceId) and conditions like `Enabled: true`, `Requires` (filter-based: MemberOf pivot, AtLeastVersion, Percentage), `Targets` (OR groups).

**Three capabilities:**

#### 9a. Rollout Visibility (Disconnected + Connected)
- Parse all 28 FLT flag JSON files from the local FeatureManagement repo clone
- Display as a table:
  - Columns: Flag Name, Description, and one column per ring: onebox | test | daily | cst | dxt | msit | prod | mc | gcc
  - Each cell shows: ✓ (Enabled=true), ✕ (empty/Enabled=false), ◐ (conditional — Requires/Targets)
  - Hover on ◐ → tooltip showing the condition (e.g., "Requires: WorkspaceObjectId in [guid1, guid2]")
- Click a flag row → expands to show full JSON definition
- Search/filter by name
- Group by rollout state: "Fully rolled out", "Partially rolled out", "Not enabled anywhere"

**Feasibility: ✅ Confirmed.**
- Parse JSON files directly from local `FeatureManagement` repo clone (path auto-detected or configured)
- Flag names cross-referenced with `FeatureNames.cs` in FLT repo for descriptions
- All client-side or Python-side parsing — no APIs needed

#### 9b. Local Override (Connected mode)
- Override column in the table with toggle switch per flag
- When toggled: sets a local override that EDOG injects via a custom `IFeatureFlighter` decorator
- Decorator wraps the real FeatureFlighter: checks override map first, delegates to real implementation if no override
- Override map served via a new EDOG config endpoint (`/api/edog/feature-overrides`)
- "Reset All Overrides" button
- Visual indicator showing which flags are overridden vs. natural state
- Overrides persist for the current session

**Feasibility: ✅ Now confirmed** (via research — see Appendix D).
- `IFeatureFlighter` has single method: `bool IsEnabled(string featureName, Guid? tenantId, Guid? capacityId, Guid? workspaceId)`
- **Timing caveat**: Cannot register at line 108 (IWorkloadContext not yet available). Must register in `RunAsync()` callback (~line 196).
- Pattern: `EdogFeatureFlighterWrapper : IFeatureFlighter` — decorator wrapping `new FeatureFlighter(workloadContext)` + reads `edog-feature-overrides.json` for local overrides.
- Same assembly (`Microsoft.LiveTable.Service`) — no cross-assembly issues.

#### 9c. Flag Management — Create PRs (Disconnected)
- "Edit Rollout" button on each flag → opens an inline editor showing the flag's JSON with per-environment toggle controls
- User can enable/disable the flag for specific environments (onebox, test, daily, dxt, msit, prod, etc.)
- For conditional enablement: UI provides template for `Requires` with pivot selector (WorkspaceObjectId, TenantObjectId, ClusterName, RolloutName, RegionName) and values input
- "Create PR" button → EDOG:
  1. Creates a branch in the local FeatureManagement repo (`feature/{flagName}-{env}-{action}`)
  2. Updates the JSON file (using same logic as FeatureTool.ps1)
  3. Commits with standard message: "Enable/Disable {FlagName} in {env}"
  4. Pushes branch
  5. Creates PR in ADO (FeatureManagement repo)
- "New Flag" button → wizard:
  1. Enter flag name (must start with "FLT")
  2. Enter description
  3. Select initial environments to enable
  4. Creates the JSON file, adds constant to FeatureNames.cs, creates PR

**Feasibility: ✅ Confirmed** (via research — see Appendix E).
- JSON file editing: ✅ (same as FeatureTool.ps1 — read, modify, write)
- FeatureTool.ps1 already exists for enable/disable/create operations
- Git operations: ✅ (branch, commit, push — edog.py already does git operations)
- PR creation: ✅ ADO REST API: `POST /_apis/git/repositories/{repo}/pullrequests` (or `az repos pr create` CLI)
- FeatureNames.cs update: ✅ Regex-based insertion (append new `public const string` before closing brace of class)

#### Available Flags (28 FLT flags discovered):

| Flag | Description | test (EDOG) |
|------|-------------|-------------|
| FLTDagExecutionHandlerV2 | V2 DAG execution orchestration | ✓ Enabled |
| FLTParallelNodeLimit10 | Set ParallelNodeLimit to 10 | (empty) |
| FLTParallelNodeLimit15 | Set ParallelNodeLimit to 15 | (empty) |
| FLTParallelNodeLimit20 | Set ParallelNodeLimit to 20 | (empty) |
| FLTArtifactBasedThrottling | Artifact-based throttling | ✓ Enabled |
| FLTUserBasedThrottling | User-based throttling | (empty) |
| FLTIRDeletesDisabled | Disable IR deletes | ✓ Enabled |
| FLTDqMetricsBatchWrite | Batch write for DQ metrics | Conditional (WorkspaceObjectId) |
| FLTDqMetricsWriteDisabled | Disable DQ metrics writes | (empty) |
| FLTDqMetricsSetTableLogRetentionDays | Delta log retention for DQ tables | (empty) |
| FLTInsightsMetrics | Insights metrics collection | (empty) |
| FLTUseOneLakeRegionalEndpoint | OneLake regional endpoint | (empty) |
| FLTUseLakeHouseMetastoreClientV2 | V2 metastore client | (empty) |
| FLTResilientCatalogListing | Resilient catalog with shortcut skip | (empty) |
| FLTListPathOptimization | Delta list-path optimization | (empty) |
| FLTEnableOneLakeS2STokenForPLS | S2S token for Private Link | (empty) |
| FLTLimitConcurrentOneLakeCatalogCalls | Throttle catalog calls | (empty) |
| FLTDagSettings | DagSettings API | (empty) |
| FLTMLVWarnings | RefreshPolicy/CDF warnings | (empty) |
| FLTRefreshPolicy | RefreshPolicy in getDAGExecMetrics | (empty) |
| FLTEnableRefreshTriggers | Event-based refresh triggers | (empty) |
| FLTListDagAPIPagination | Cursor-based pagination | (empty) |
| FLTTokenManagerSkipClearOnDagCompletion | Kill-switch for token cleanup | (empty) |
| FLTEnableMaxParallelMLVsSettings | Max parallel MLVs setting | (empty) |
| FLTPublicApiSupport | Public API support | (empty) |
| FLTPublicApiSupportOptOut | Public API opt-out | (empty) |
| FLTMlvExecutionDefinitionsPublicApiSupport | MLV Execution Def API | (empty) |
| FLTSkipShortcutExecution | Skip shortcut execution | (empty) |
| FLTCapacityThrottlingAsUserError | Report capacity throttling as user error | (empty) |
| FLTSystemSpacePersistence | System space persistence | (empty) |
| FLTUnresolvedEntitySupport | Unresolved entity support | (empty) |

#### Environments (rings) in deployment order:
`onebox` → `test` (EDOG/INT3) → `daily` → `cst` → `dxt` → `msit` → `prod` (canary1 → canary2 → ROW) → `mc` (day1 → day2 → day3) → `gcc` → `gcchigh` → `dod` → `usnat` → `ussec` → `bleu`

### Section: Lock Monitor

- Show current DAG execution lock state
- Display: Locked/Unlocked, holder info (if available), lock age timer
- "Force Unlock" button with confirmation dialog
- History of recent lock/unlock events (from telemetry stream)
- **Auto-detect stuck locks**: If a lock age exceeds 5 minutes AND no active execution, show a toast notification on the Logs view: "Lock stuck — [Unlock] [Dismiss]"

**Feasibility: ✅ Confirmed.**
- `GET /liveTableMaintenance/getLockedDAGExecutionIteration` → check lock state
- `POST /liveTableMaintenance/forceUnlockDAGExecution` → force unlock
- Both are FLT maintenance controller endpoints, accessible with MWC token (connected mode only)
- In disconnected mode: show "Connect to check lock status"

### Section: Orphaned Resources

- List orphaned OneLake folders from failed runs
- Each entry: folder path, size, age
- "Clean All" button with size savings estimate
- Individual delete buttons per entry

**Feasibility: ✅ Confirmed.**
- `GET /liveTableMaintenance/listOrphanedIndexFolders` → list orphaned
- `POST /liveTableMaintenance/deleteOrphanedIndexFolders` → cleanup
- Connected mode only.

---

## 10. Command Palette (Ctrl+K)

Floating overlay, centered, ~520px wide. Keyboard-navigable.

- Input field at top with search icon
- Results grouped by category:
  - **Workspaces**: matching workspace names → click to navigate
  - **Lakehouses**: matching lakehouse names → click to navigate
  - **Tables**: matching table names → click to navigate
  - **Commands**: Run DAG, Cancel DAG, Restart Service, Force Unlock, Refresh DAG, etc.
  - **Feature Flags**: matching flag names → click to navigate to Environment
  - **Logs** (connected mode): search log messages → click to jump to entry
- Arrow key navigation, Enter to select
- Escape to close
- Fuzzy matching on input

**Feasibility: ✅ Client-side JS. Data from in-memory state (workspace tree, logs, commands list).**

---

## 11. Token Inspector (Right Drawer)

Slides in from the right edge when token countdown is clicked. 320px wide. NOT a modal.

- **JWT Display**: Token split into 3 sections (header, payload, signature) with distinct visual treatment
- **Claims Table**: Key-value pairs from payload — sub, aud, iss, exp, iat, roles, scopes, name, etc.
- **Expiry**: Progress bar showing time remaining. Colors: green → amber → red as expiry approaches.
- **Scope List**: What APIs this token can access (parsed from `scp` or `roles` claim). Displayed as small pills.
- **Actions**:
  - "Refresh Token" — force immediate token refresh (calls `fetch_token_with_retry` in edog.py)
  - "Copy Token" — copies raw token string to clipboard
- When token expires during a session: drawer auto-opens with warning state

**Feasibility: ✅ Confirmed.**
- JWT decoding is client-side (base64 decode header + payload, no verification needed)
- Token already served by `/api/flt/config`
- Force refresh: via IPC channel (see Appendix C) — browser → POST `/api/command/refresh-token` → edog.py picks up command → runs `fetch_token_with_retry()` → updates cache → EdogApiProxy serves new token on next request
- Show BOTH tokens in inspector when connected: Bearer (for Fabric APIs) + MWC (for FLT service)

---

## 12. Error Code Decoder

When a known FLT error code (e.g., `MLV_SPARK_SESSION_ACQUISITION_FAILED`) appears in logs or telemetry:

- **Inline tooltip** on hover: shows human-readable message from ErrorRegistry
- **Detail**: User vs System error classification, suggested fix
- **Source**: `ErrorRegistry.cs` in FLT repo — contains all error codes with message templates
- Can be extracted at build time (parse the C# file, generate a JSON lookup table)

**Feasibility: ✅ Confirmed.** ErrorRegistry.cs is static. Can parse at build time into a JSON lookup. Client-side matching against log messages.

---

## 13. File Change Detection + Re-deploy Prompt

- Python `watchdog` monitors FLT repo `Service/` directory for `.cs`, `.json`, `.csproj` file changes
- Excludes: EDOG DevMode patch files, build output directories
- Compares against the file state at session start (initial patch + build)
- When new changes detected: sends WebSocket message to UI
- UI shows notification bar: "Files changed: [list] — [Re-deploy] [Dismiss]"
- "Re-deploy": stops service → rebuilds → relaunches
- Throttle: don't fire for every save — debounce 2 seconds

**Feasibility: ✅ Confirmed.** Python `watchdog` library. Signal via new WebSocket message type from edog.py to browser (needs a lightweight communication channel — could add a second WebSocket from edog.py or use a shared file/named pipe).

---

## 14. Service Restart from UI (Nice-to-Have)

Top bar "Restart" button. Same as re-deploy but without file change trigger.

**Feasibility: ✅ Now confirmed** (via research — see Appendix C).
- EdogLogServer runs inside the FLT process being restarted — cannot relay restart commands.
- **Solution**: edog.py runs a lightweight HTTP control server on port 5556 (Python `http.server`, ~30 lines).
- Browser → POST to EdogLogServer `/api/command/restart` → writes `.edog-command/restart.json` → edog.py polls `.edog-command/` every 2-5s → kills service → rebuilds → relaunches.
- Same channel used for: force token refresh, file change notifications, feature flag override updates.

---

## 15. Session History / Timeline (Nice-to-Have)

Persistent log of EDOG actions this session:
- "Deployed to TestLakehouse-01 at 2:14pm"
- "Ran DAG (failed at node 3) at 2:16pm"
- "Re-deployed at 2:20pm"
- "Ran DAG (passed) at 2:22pm"
- "Switched to TestLakehouse-02 at 3:00pm"

Like git reflog but for EDOG actions. Useful for retracing steps.

**Feasibility: ✅ Client-side.** Store events in localStorage with timestamps. Display as a timeline in a collapsible bottom panel or in a dedicated drawer.

---

## 16. Capacity Health Indicator (Nice-to-Have)

Before deploying, show if the target capacity is throttled.

- Check capacity metrics API for CU usage, throttling state
- Show: "Capacity healthy" (green) or "Capacity throttled — expect slow DAG runs" (amber)
- Display CU usage percentage if available

**Feasibility: ⚠️ Need to verify.**
- `GET api.fabric.microsoft.com/v1/capacities/{id}` — exists but may require admin scope
- Throttling state may only be observable from telemetry (429/430 responses) after connecting
- **Research needed**: What capacity APIs are available with user-level (non-admin) tokens?

---

## 17. Quick Environment Clone (Nice-to-Have)

"Clone this lakehouse setup to a new workspace" — one action that:
1. Creates a new workspace
2. Assigns same capacity
3. Creates lakehouse with same name pattern
4. Copies MLV definitions (notebooks) to new workspace

**Feasibility: ⚠️ Partially confirmed.**
- Create workspace + lakehouse: ✅
- Copy notebooks: ⚠️ Need to verify notebook copy/clone API
- Copy MLV definitions: ⚠️ These are created via notebooks — may need to re-run the notebook in the new workspace
- **Research needed**: Fabric notebook copy API, or alternative approach.

---

## 18. DAG Definition Viewer (Nice-to-Have)

View the MLV SQL definitions that make up each DAG node, right in the UI.

- When a DAG node is clicked in DAG Studio, show the SQL/PySpark code that defines that materialized view
- Syntax highlighted, read-only

**Feasibility: ✅ Now confirmed** (via research — see Appendix B).
- `codeReference` contains `notebookWorkspaceID`, `notebookID`, `codeIndexArray` (cell indices), `eTag` — NOT the actual SQL code.
- To show SQL: need Notebook content API (`GET /v1/workspaces/{id}/notebooks/{id}/content`) → extract cells at `codeIndexArray` indices. Phase 2 feature.
- For SQL-type nodes (kind="sql"): the SQL is defined inline in the catalog, NOT in a notebook. Would need to query the catalog or SQL endpoint to retrieve it.

---

## Feature Phasing

### MVP (ship first — enables the core new workflow)
1. Workspace Explorer — tree, content, basic inspector (table list only)
2. Deploy to Lakehouse flow (config update → token → patch → build → launch)
3. Favorites / named environments
4. Runtime View — the core debugging cockpit with 4 top-level tabs + Internals dropdown:
   - **[Logs]** — real-time log stream with breakpoints, bookmarks, error clustering, filters
   - **[Telemetry]** — SSR telemetry events, activity tracking
   - **[System Files]** — runtime view of all FLT file operations on OneLake: DagExecutionMetrics (dag.json, node metrics, index files), lock files with age/holder, dagsettings.json, environment.json, MLV execution definitions. Audited: when created, what written, which iterationId. Via IFileSystem decorator → WebSocket.
   - **[Spark Sessions]** — notebook session lifecycle: creation, MLV command→cell mapping, session reuse, disposal, timeout tracking. Via NotebookExecutionContext interception.
   - **[Internals ▾]** dropdown with sub-views:
     - **Tokens** — ALL tokens: Bearer (AAD), MWC (per ws/lh/cap, multiple), S2S, OBO. Full JWT decode, TTL countdown, usage stream (which API used which token), history timeline.
     - **Caches** — all 10 FLT cache managers: TokenManager, DagExecutionStore, RateLimiterCache, DQ ReportState, ExecutionContext, NotebookContext, SkippedShortcuts, Cancellation registry, ReliableOps, SparkTokens. Full content, when written, which iterationId, TTL, eviction events.
     - **HTTP Pipeline** — every outbound HTTP call through the 4 DelegatingHandlers: URL, method, status, duration, retry count, correlation IDs, which handlers fired. Covers OneLake, Spark, PBI, Fabric API calls.
     - **Retries & Throttling** — every retry attempt, capacity admission window delays (20s/40s/60s/90s), 429/430 responses, jitter applied, throttle decisions from HierarchicalThrottlingService, rate limiter state per artifact/user/capacity.
     - **Feature Flag Evals** — real-time stream of FeatureFlighter.IsEnabled() calls: flagName, tenantId, capacityId, workspaceId, result (true/false). Answer "was FLTDagExecutionHandlerV2 enabled for MY workspace?"
     - **DI Registry** — full DI container state from WorkloadApp.cs: 25+ registrations, singleton vs transient, which EDOG interceptors are active, what got replaced.
     - **Perf Markers** — MonitoredCodeMarkers duration metrics: PingApi, GetDag, RunDAG, each operation timed. Built-in performance profiling stream.
5. Top bar with token health, service status, git info
6. Sidebar navigation with phase-aware enabling/disabling
7. Command Palette (Ctrl+K)

### V1.1 (next — completes the cockpit)
10. DAG Studio (graph + Gantt + controls + history)
11. API Playground
12. Environment panel (feature flags + lock monitor + orphaned resources)
13. Error Code Decoder
14. File change detection + re-deploy prompt

### V2 (future — advanced features)
14. Spark Inspector (requires new C# interceptor)
15. Execution comparison/diff
16. New Test Environment wizard
17. Service restart from UI
18. Session history/timeline
19. Capacity health indicator
20. Quick environment clone
21. DAG definition viewer
22. Table schema + preview + stats (via SQL endpoint)
23. CRUD operations on all Fabric items

### V3 (innovation — unlocked by API discoveries, April 9 2026)
24. Capacity Command Center — real-time dashboard with utilization gauges, throttling alerts, rejection risk, assigned workspaces, admin list. One API call returns everything. (`/capacities/listandgethealthbyrollouts`)
25. Capacity Provisioner — create/delete test capacities from EDOG. SKU selector (19 tiers, F2-F8192), region picker, name input. Full lifecycle: create → use → destroy. (`POST /capacities/new`, `DELETE /capacities/{id}`)
26. One-Click MLV Test Pipeline — automated: create workspace → create lakehouse → create notebook with MLV SQL → run notebook → verify tables → deploy FLT → run DAG → verify execution. Every step has a tested API.
27. Notebook Cell Runner — view notebook cells inline (SQL syntax highlighted), edit, run, see results. Without opening Fabric portal. (`getDefinition` → edit → `updateDefinition` → `jobs/instances` → `previewAsync`)
28. Workload Configuration Viewer — 64 workload configs per capacity. See enabled/disabled workloads, memory/CPU limits, timeout settings. Debug "why is my DAG slow?" (`/v1.0/myorg/capacities/{id}/Workloads`)
29. Scheduled Job Manager — view/create/enable/disable MLV scheduled jobs. Cron expressions, time windows, recurrence. (`GET/POST/PUT /metadata/artifacts/{id}/scheduledJobs`)
30. Capacity Cost Estimator — using SKU catalog (19 tiers with vCores/memory) + live utilization + historical execution metrics, estimate DAG cost on different SKUs. Projected duration and CU consumption.
31. Feature Flag Flight Simulator — toggle flags → run DAG → compare timing with baseline. A/B testing for feature flags with real execution data. (`local override` → `runDAG` → `getDAGExecMetrics` → diff)
32. Intelligent Alerting — combine signals: capacity throttle approaching + DAG running + node 3x slow → proactive alert "DAG likely to fail." Multi-dimensional early warning. (`capacity health` + `DAGExecMetrics` + historical baseline)
33. Token Injection Debugger — capture every MWC token usage in FLT: which API, which audience, TTL at call time, success/fail. Detect "wrong token scope" instantly. (`MWC gen` + HTTP interception + token decode)
34. API Response Validator — record "golden" API responses (schema, field presence). On subsequent calls, auto-validate: "Table details missing partitionColumns field that was present yesterday." Regression detector for API contracts.
35. Feature Flag Impact Simulator — parse `IsEnabled()` calls in FLT code + cross-reference with DAG → "Enabling BatchMerge activates batch path in DagExecutor.cs, affects nodes 3, 7, 12." Static analysis + runtime correlation.
36. Chaos Engineering Panel — inject failures from EDOG: force-expire tokens, simulate capacity throttling, kill Spark sessions, lock DAG. Test resilience without real failures. Each action has a "revert" button.
37. Test Data Generator — use table schemas from `getTableDetails` + Copilot AI (gpt-5) to auto-generate semantically meaningful test data → write to OneLake. "Generate 10K rows for SalesRaw."
38. Table Lineage Graph — notebook SQL + DAG topology + table schemas → full visual lineage: source tables → transformations → materialized views. Click any node to see SQL code. (`getDefinition` + `getLatestDag` + `getTableDetails`)
39. Spatial Memory Layout — workspaces as a mind-map canvas instead of flat tree. Frequently used items closer to center (weighted by `/metadata/recent`). Build spatial memory — "the table with the issue is in the top-right cluster."
40. Automated Regression Suite — define test cases: "Run DAG, expect tables >0 rows, node X < 5s." Run on schedule. Report pass/fail. CI for your lakehouse. (`RunNotebook` + `runDAG` + `previewAsync` + `getDAGExecMetrics`)
41. Streaming Log Heatmap — minimap alongside log viewer (like VS Code scrollbar). Color-coded by level. Red clusters = error bursts. Click anywhere to jump. Scan 100K logs in 1 second. DAG execution boundary markers.
42. DAG Node Status Glyphs — SVG glyph system: spinning ring (executing), checkmark (success), X (failed), pause (locked), clock (scheduled). OKLCH colors. Micro-animations: success pulse, failure shake.
43. Feature Flag Ring Visualization — 28 flags as concentric rings (onebox innermost → prod outermost). Filled ring = enabled. Single glance shows rollout state of everything. Color intensity maps to confidence.
44. Capacity Health Thermometer — persistent 24px topbar widget. Cool blue (healthy) → warm amber (stressed) → hot red (throttling). Hover for utilization sparkline. Click to expand full capacity dashboard.
45. Keyboard-First Interaction Design — full keyboard map for every feature. Every action reachable without mouse. Tab order for every panel. Shortcut cheatsheet overlay (Ctrl+/). Context-aware shortcuts per view. Must match VS Code muscle memory.
46. Startup Config Validator — before anything renders: check edog-config.json (exists? valid? required fields?), bearer token (cached? expired?), FLT repo path (valid? patched?). Fail fast with actionable messages + fix buttons. Never show cryptic errors 30 seconds in.
47. Multi-Monitor & Resizable Panels — usable at 1200px minimum (not just 1440px). All panel widths resizable via drag + persist across sessions. Pop-out panels to separate windows (DAG graph on monitor 2). Responsive layout with sensible breakpoints.
48. Universal Data Export — right-click any table → export CSV. Any JSON response → copy formatted. DAG metrics → Excel-friendly. Log entries → filtered JSON. "Can you send me the DAG output?" = one click. Copy-as-cURL for any API call.
49. System Files Explorer — runtime view of all FLT internal file operations on OneLake. Browse DagExecutionMetrics (dag.json, node metrics, index files), lock files with age, dagsettings.json, MLV execution definitions, sys_* metrics tables. Audited with timestamps: when created, what was written, by whom. Served via C# interceptor → WebSocket (same pattern as log capture). Connected mode only.

---

## Technical Architecture Summary

### What exists today:
- `EdogLogServer.cs` — Kestrel server, WebSocket, REST APIs, ring buffers
- `EdogApiProxy.cs` — serves config + MWC token
- `EdogLogInterceptor.cs` — captures Tracer logs
- `EdogTelemetryInterceptor.cs` — captures telemetry events
- `edog.py` — Python CLI: auth, patching, service launch, monitoring

### What needs to be built:

| Component | For Feature | Effort |
|-----------|-------------|--------|
| Fabric API client in browser JS | Workspace Explorer | Medium |
| Favorites persistence (JSON file) | Named environments | Small |
| Breakpoint matching in renderer | Log breakpoints | Small |
| Bookmark state + export | Log bookmarks | Small |
| Error clustering heuristic | Error clustering | Medium |
| SVG DAG graph renderer | DAG Studio | Large |
| Gantt chart renderer | DAG Studio | Medium |
| Spark DelegatingHandler | Spark Inspector | Medium |
| New WebSocket message types | Multiple features | Small |
| Feature flight wrapper (IFeatureFlighter decorator) | Feature flags | Medium |
| File watcher (Python watchdog) | Re-deploy prompt | Medium |
| IPC channel (edog.py ↔ EdogLogServer) | Restart, force refresh | Medium |
| Error code JSON lookup | Error decoder | Small |
| Command palette UI | Navigation | Medium |

---

## Appendix: Feasibility Research Results (April 8, 2026)

All ⚠️ gaps from the spec above have been investigated by analyzing the actual FLT codebase and Fabric API documentation. Results:

### A. Spark Inspector — ✅ FEASIBLE (Subclass Pattern)

**Finding:** `GTSBasedSparkClient.SendHttpRequestAsync()` is `protected virtual` (line 327). We don't need to touch the platform's HttpClient creation.

**Implementation:**
1. Create `EdogTracingSparkClient : GTSBasedSparkClient` in `DevMode/`
2. Override `SendHttpRequestAsync()` to capture request/response and forward to `EdogLogServer.AddSparkRequest()`
3. Create `EdogTracingSparkClientFactory : ISparkClientFactory` that wraps original factory
4. DI: Replace `WireUp.RegisterSingletonType<ISparkClientFactory, GTSBasedSparkClientFactory>()` with EDOG version (same pattern as telemetry interceptor)

**Data captured per request:** Method, URL, headers, body (SQL/PySpark code), response status, response body, duration, retry info (from MonitoredScope). All forwarded via new WebSocket message type: `{ type: 'spark_request', data: {...} }`

---

### B. DAG Studio Graph Data — ✅ FEASIBLE (Rich Data Available)

**Finding:** `getLatestDag` returns comprehensive node + edge data.

**Node fields available:** `nodeId`, `name`, `kind` (sql/pyspark), `parents[]`, `children[]`, `executable`, `isFaulted`, `errorMessage`, `fltErrorCode`, `tableType`, `isShortcut`, `abfsPath`, `format`, `lastRefreshTime`, `warnings[]`, `codeReference` (notebook IDs for PySpark nodes), `externalWorkspaceId/Name` (cross-lakehouse)

**Edge fields:** `edgeId`, `from` (parent nodeId), `to` (child nodeId)

**Code availability:** `codeReference` contains notebook ID + cell indices, NOT the actual SQL. To show SQL code, we'd need a separate Notebook API call — marking this as Phase 2.

**Graph rendering:** Use nodes[] + edges[] to build an adjacency list. Topological sort for layout (DAG has no cycles). Simple SVG renderer with force-directed or layered layout.

---

### C. IPC Architecture — ✅ FEASIBLE (Hybrid HTTP + File)

**Current state:** EdogLogServer has NO POST endpoints (read-only). edog.py has NO listener.

**Recommended architecture:**
```
Browser → POST /api/command/* → EdogLogServer → writes .edog-command/{cmd}.json
edog.py polls .edog-command/ every 2-5 seconds → executes command
edog.py → writes result to .edog-command/{cmd}-result.json
EdogLogServer reads result → returns to browser
```

Alternative (cleaner): edog.py runs a second lightweight HTTP server on port 5556 for direct control commands. EdogLogServer proxies POST requests to it.

**Commands needed:**
- `restart` — kill service, rebuild, relaunch
- `refresh-token` — immediate token refresh
- `set-feature-overrides` — write override map for FeatureFlighter wrapper
- `file-change-notify` — edog.py's file watcher notifies browser via new WebSocket message

---

### D. Feature Flag Override — ✅ FEASIBLE (Late DI Registration)

**Finding:** Cannot use the simple `RegisterInstance` pattern at line 108 because `IWorkloadContext` isn't available yet. Must inject LATER.

**Implementation:**
1. Create `EdogFeatureFlighterWrapper : IFeatureFlighter` in `DevMode/`
2. Remove/skip original registration at line 108
3. Register wrapper in `RunAsync()` callback (~line 196) where `workloadContext` exists:
   ```csharp
   WireUp.RegisterInstance<IFeatureFlighter>(
       new EdogFeatureFlighterWrapper(
           new FeatureFlighter(workloadContext),
           WireUp.Resolve<EdogLogServer>()));
   ```
4. Wrapper reads overrides from `edog-feature-overrides.json` (file-based, no HTTP needed at startup)
5. EdogLogServer exposes `POST /api/feature-overrides` to update the file at runtime
6. Wrapper logs all `IsEnabled()` calls via EdogLogServer → visible in UI as "Feature '{name}' resolved to {value} (override: yes/no)"

**Assembly:** `IFeatureFlighter` is in the same assembly (`Microsoft.LiveTable.Service`) — no cross-assembly issues.

---

### E. Fabric APIs — Status Matrix

| API | Endpoint | Status | Notes |
|-----|----------|--------|-------|
| List workspaces | `GET /v1/workspaces` | ✅ Confirmed | Scope: `Workspace.Read.All` |
| Create workspace | `POST /v1/workspaces` | ✅ Confirmed | Scope: `Workspace.ReadWrite.All` |
| Rename workspace | `PATCH /v1/workspaces/{id}` | ✅ Confirmed | |
| Delete workspace | `DELETE /v1/workspaces/{id}` | ✅ Confirmed | |
| List items | `GET /v1/workspaces/{id}/items` | ✅ Confirmed | Returns all types |
| List lakehouses | `GET /v1/workspaces/{id}/lakehouses` | ✅ Confirmed | |
| Create lakehouse | `POST /v1/workspaces/{id}/lakehouses` | ✅ Confirmed | |
| Rename lakehouse | `PATCH /v1/workspaces/{id}/lakehouses/{id}` | ✅ Confirmed | |
| Delete lakehouse | `DELETE /v1/workspaces/{id}/lakehouses/{id}` | ✅ Confirmed | |
| List tables | `GET /v1/workspaces/{id}/lakehouses/{id}/tables` | ✅ Confirmed | name, type, format, location |
| Assign capacity | `POST /v1/workspaces/{id}/assignToCapacity` | ⚠️ Runtime verify | Endpoint exists, scope TBD |
| List capacities | `GET /v1/capacities` | ⚠️ Runtime verify | May need admin scope |
| Create notebook | `POST /v1/workspaces/{id}/notebooks` | ⚠️ Runtime verify | Endpoint documented |
| Write notebook content | `PATCH /v1/workspaces/{id}/notebooks/{id}` | ⚠️ Runtime verify | |
| Run notebook | Job Scheduler API | ⚠️ Runtime verify | May use `/v1/workspaces/{id}/items/{id}/jobs` |
| ADO PR creation | `POST dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests` | ✅ Confirmed | Or `az repos pr create` CLI |

**Remaining ⚠️ items require runtime testing with the actual EDOG cert-based token to confirm scope access. All endpoints are documented in Fabric REST API docs.**

---

### F. New C# Files Needed

| File | Purpose | Pattern Reference |
|------|---------|-------------------|
| `DevMode/EdogFeatureFlighterWrapper.cs` | Wrap IFeatureFlighter with override + logging | `EdogTelemetryInterceptor.cs` |
| `DevMode/EdogTracingSparkClient.cs` | Subclass GTSBasedSparkClient, capture HTTP | `HttpClientTracingHandler.cs` (TestCommon) |
| `DevMode/EdogTracingSparkClientFactory.cs` | Factory wrapper for tracing client | `GTSBasedSparkClientFactory` |

All follow the same pattern: decorator wrapping the real implementation, forwarding captured data to EdogLogServer.

---

*Research conducted: April 8, 2026*
*Sources: FLT codebase (workload-fabriclivetable), FeatureManagement repo, Fabric REST API docs, FabricSparkCST repo*
