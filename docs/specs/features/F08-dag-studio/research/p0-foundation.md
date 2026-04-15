# F08 DAG Studio — P0 Foundation Research

> **Author:** Sana Reeves (Architect & FLT Domain Expert)
> **Date:** 2026-04-14
> **Status:** COMPLETE
> **Scope:** FLT DAG API deep dive · Existing EDOG UI audit · Graph rendering reference analysis

---

## Table of Contents

1. [P0.1: FLT DAG API Deep Dive](#p01-flt-dag-api-deep-dive)
   - [API Endpoints](#api-endpoints)
   - [Data Model Classes](#data-model-classes)
   - [Enums & Constants](#enums--constants)
   - [Service Interfaces](#service-interfaces)
2. [P0.2: Existing EDOG DAG UI Audit](#p02-existing-edog-dag-ui-audit)
   - [File-by-File Audit](#file-by-file-audit)
   - [Reusability Matrix](#reusability-matrix)
   - [Frontend Architecture](#frontend-architecture)
3. [P0.3: Graph Rendering Reference Analysis](#p03-graph-rendering-reference-analysis)
   - [Rendering Technology](#rendering-technology)
   - [Layout Algorithm](#layout-algorithm)
   - [Interaction Model](#interaction-model)
   - [Visual Style](#visual-style)
   - [Performance Techniques](#performance-techniques)
   - [SVG vs Canvas Tradeoff](#svg-vs-canvas-tradeoff)
   - [Sugiyama Layout for Vanilla JS](#sugiyama-layout-for-vanilla-js)
4. [Architecture Recommendations](#architecture-recommendations)

---

## P0.1: FLT DAG API Deep Dive

**Source:** `workload-fabriclivetable/Service/Microsoft.LiveTable.Service/`

### API Endpoints

All endpoints share the base path:
```
/v1/workspaces/{workspaceId}/lakehouses/{artifactId}
```

#### 1. GET `.../liveTable/getLatestDag`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableController` |
| **Method** | `GetLatestDagAsync` |
| **Source** | `Controllers/LiveTableController.cs:100-361` |
| **Auth** | `Permissions.ReadAll` |
| **Query Params** | `showExtendedLineage` (bool, default=false) — includes cross-workspace/cross-lakehouse deps |
| **Response** | `Dag` (200 OK) |
| **Error Codes** | 400, 401, 403, 404, 422, 429, 500 |

**EDOG Usage:** Primary endpoint for loading DAG structure. Call with `showExtendedLineage=true` to get cross-lakehouse nodes.

---

#### 2. GET `.../liveTable/listDAGExecutionIterationIds`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableController` |
| **Method** | `ListDAGExecutionIterationIdsAsync` |
| **Source** | `Controllers/LiveTableController.cs:379-519` |
| **Auth** | `Permissions.ReadAll` |
| **Query Params** | `historyCount` (int?, default=500, max=500), `mlvExecutionDefinitionIds` (List\<Guid\>), `statuses` (List\<DagExecutionStatus\>), `startTime` (DateTime?), `endTime` (DateTime?), `continuationToken` (string) |
| **Response** | `List<DagExecutionIteration>` (200 OK) |
| **Response Headers** | `x-ms-continuation-token` (pagination) |
| **Error Codes** | 400, 401, 404, 429, 500 |

**EDOG Usage:** History table — fetch last N executions with status filtering. Supports pagination for large histories.

---

#### 3. GET `.../liveTable/getDAGExecMetrics/{iterationId}`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableController` |
| **Method** | `GetDAGExecMetricsAsync` |
| **Source** | `Controllers/LiveTableController.cs:529-645` |
| **Auth** | `Permissions.ReadAll` |
| **Route Params** | `iterationId` (Guid) |
| **Response** | `DagExecutionInstance` (200 OK) |
| **Error Codes** | 400, 401, 404, 429, 500 |

**EDOG Usage:** Load full execution detail for a specific run — includes per-node metrics, timing, errors. Primary data source for Gantt chart and node detail panel.

---

#### 4. POST `.../liveTableSchedule/runDAG/{iterationId}`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableSchedulerRunController` |
| **Method** | `RunDagAsync` |
| **Source** | `Controllers/LiveTableSchedulerRunController.cs:95-113+` |
| **Auth** | `Permissions.ReadAll | Permissions.Execute` |
| **Route Params** | `iterationId` (Guid) — client-generated UUID |
| **Request Body** | `ArtifactJobRequest` (optional, nullable — can be empty for ad-hoc runs) |
| **Response** | 202 Accepted |
| **Error Codes** | 400, 401, 404, 500 |

**EDOG Usage:** "Run DAG" button. Client generates a UUID for iterationId, POSTs to trigger execution. Body can be empty for simple ad-hoc runs.

---

#### 5. GET `.../liveTableSchedule/cancelDAG/{iterationId}`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableSchedulerRunController` |
| **Method** | `CancelRunDagAsync` |
| **Source** | `Controllers/LiveTableSchedulerRunController.cs` |
| **Auth** | Appropriate permissions required |
| **Route Params** | `iterationId` (Guid) |
| **Response** | `DagExecutionStatus` (200 OK) |
| **Error Codes** | 400, 401, 404, 500 |

**⚠ Note:** Cancel uses GET, not POST. This is the existing FLT convention.

**EDOG Usage:** "Cancel DAG" button during active execution.

---

#### 6. POST `.../liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableMaintenanceController` |
| **Method** | `ForceUnlockDAGExecutionAsync` |
| **Source** | `Controllers/LiveTableMaintenanceController.cs:70-113` |
| **Auth** | `Permissions.ReadAll | Permissions.Execute` |
| **Route Params** | `lockedIterationId` (Guid) |
| **Response** | `string` (200 OK) — `"Force unlocked Dag"` |
| **Error Codes** | 400, 401, 500 |

**⚠ Note:** URL has typo `liveTableMaintanance` (missing 'e') — this is the actual FLT route.

**EDOG Usage:** Emergency unlock for stuck executions. Should require confirmation dialog.

---

#### 7. GET `.../liveTableMaintanance/getLockedDAGExecutionIteration`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableMaintenanceController` |
| **Method** | `GetLockedDAGExecutionIterationAsync` |
| **Source** | `Controllers/LiveTableMaintenanceController.cs:122-150+` |
| **Auth** | `Permissions.ReadAll | Permissions.Execute` |
| **Response** | `string` or `List<Guid>` (200 OK) — locked iteration IDs |
| **Error Codes** | 400, 401, 500 |

**EDOG Usage:** Check for stuck executions, show lock indicator in DAG Studio toolbar.

---

#### 8. PATCH `.../liveTable/settings`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableController` |
| **Method** | `UpdateDAGSettingsAsync` |
| **Source** | `Controllers/LiveTableController.cs:997-1134` |
| **Auth** | `Permissions.ReadAll | Permissions.Execute` |
| **Request Body** | `DagSettingsRequestBody` |
| **Response** | `DagSettingsResponseBody` (200 OK) |
| **Error Codes** | 400, 401, 404, 429, 500 |

---

#### 9. GET `.../liveTable/settings`

| Field | Value |
|-------|-------|
| **Controller** | `LiveTableController` |
| **Method** | `GetDAGSettingsAsync` |
| **Source** | `Controllers/LiveTableController.cs:1143-1255` |
| **Auth** | `Permissions.ReadAll` |
| **Response** | `DagSettingsResponseBody` (200 OK) |
| **Error Codes** | 400, 401, 404, 429, 500 |

**EDOG Usage:** Endpoints 8+9 manage parallel node limit, refresh mode, environment attachment. DAG Studio settings panel.

---

#### 10–15. MLV Execution Definition CRUD

| # | Method | Route Suffix | Body/Response |
|---|--------|-------------|---------------|
| 10 | POST | `.../liveTable/mlvExecutionDefinitions` | `MLVExecutionDefinitionRequest` → `MLVExecutionDefinitionResponse` (201) |
| 11 | GET | `.../liveTable/mlvExecutionDefinitions/{mlvDefinitionId}` | → `MLVExecutionDefinitionResponse` (200) |
| 12 | PUT | `.../liveTable/mlvExecutionDefinitions/{mlvDefinitionId}` | `MLVExecutionDefinitionRequest` → `MLVExecutionDefinitionResponse` (200) |
| 13 | DELETE | `.../liveTable/mlvExecutionDefinitions/{mlvDefinitionId}` | → 204 No Content |
| 14 | POST | `.../liveTable/mlvExecutionDefinitions/find` | `MLVExecutionDefinitionRequest` (filter) → `MLVExecutionDefinitionResponse` (200) |
| 15 | GET | `.../liveTable/mlvExecutionDefinitions` | → `List<MLVExecutionDefinitionResponse>` (200) |

**EDOG Usage:** MLV Execution Definitions allow named subsets of the DAG (e.g., "Refresh only sales tables"). DAG Studio should support selecting/creating these for targeted runs.

---

### Data Model Classes

#### Dag

**Source:** `DataModel/Dag/Dag.cs`
**Namespace:** `Microsoft.LiveTable.Service.DataModel.Dag`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `Name` | `string` | `"name"` | DAG name |
| `WorkspaceId` | `Guid` | `"workspaceId"` | |
| `LakehouseId` | `Guid` | `"lakehouseId"` | |
| `WorkspaceName` | `string` | `"workspaceName"` | |
| `LakehouseName` | `string` | `"lakehouseName"` | |
| `Nodes` | `List<Node>` | `"nodes"` | All nodes in the DAG |
| `Edges` | `List<Edge>` | `"edges"` | All edges connecting nodes |
| `NotebookExecutionContexts` | `ConcurrentDictionary<Guid, NotebookExecutionContext>` | — | Notebook contexts (internal) |

---

#### Node

**Source:** `DataModel/Dag/Node.cs`
**Namespace:** `Microsoft.LiveTable.Service.DataModel.Dag`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `NodeId` | `Guid` | `"nodeId"` | Unique identifier |
| `Name` | `string` | `"name"` | MLV name (e.g., "RefreshSalesData") |
| `Kind` | `string` | `"kind"` | `"sql"` or `"pyspark"` |
| `CodeReference` | `NotebookBasedCodeReference?` | `"codeReference"` | Notebook ID + cell indices (NOT actual code) |
| `TableType` | `TableType` | `"tableType"` | Enum: table type classification |
| `IsShortcut` | `bool?` | `"isShortcut"` | Null when feature disabled |
| `Children` | `List<Guid>` | `"children"` | Child node IDs (downstream) |
| `Parents` | `List<Guid>` | `"parents"` | Parent node IDs (upstream) |
| `ExternalWorkspaceId` | `Guid?` | `"externalWorkspaceId"` | Cross-lakehouse: source workspace |
| `ExternalLakehouseId` | `Guid?` | `"externalLakehouseId"` | Cross-lakehouse: source lakehouse |
| `ExternalWorkspaceName` | `string` | `"externalWorkspaceName"` | Cross-lakehouse: workspace name |
| `ExternalLakehouseName` | `string` | `"externalLakehouseName"` | Cross-lakehouse: lakehouse name |
| `Executable` | `bool?` | `"executable"` | True if MLV or Materialized Lake View |
| `AbfsPath` | `string` | `"abfsPath"` | ABFS storage path |
| `Format` | `string` | `"format"` | Table format/provider |
| `LastRefreshTime` | `DateTime?` | `"lastRefreshTime"` | Last successful refresh timestamp |
| `ErrorMessage` | `string` | `"errorMessage"` | Validation error (missing table, access denied) |
| `IsFaulted` | `bool` | `"isFaulted"` | True when node is unavailable/inaccessible |
| `FLTErrorCode` | `ErrorCode?` | `"fltErrorCode"` | e.g., `MLV_STALE_METADATA`, `MLV_ACCESS_DENIED` |
| `Warnings` | `List<NodeWarning>` | `"warnings"` | CDF disabled, delete without hints, etc. |
| `HasCustomCode` | `bool` | — | `[JsonIgnore]` — internal only |

---

#### Edge

**Source:** `DataModel/Dag/Edge.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `EdgeId` | `Guid` | `"edgeId"` | Unique identifier |
| `From` | `Guid` | `"from"` | Source node ID (parent) |
| `To` | `Guid` | `"to"` | Target node ID (child) |

---

#### DagExecutionInstance

**Source:** `DataModel/Dag/DagExecutionInstance.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `IterationId` | `Guid` | `"iterationId"` | Execution ID |
| `Dag` | `Dag` | `"dag"` | Full DAG snapshot at execution time |
| `DagExecutionMetrics` | `DagExecutionMetrics` | `"dagExecutionMetrics"` | Overall execution metrics |
| `NodeExecutionMetrices` | `ConcurrentDict<Guid, NodeExecutionMetrics>` | `"nodeExecutionMetrices"` | Per-node metrics (keyed by NodeId) |
| `DagCancellationTokenSource` | `CancellationTokenSource` | — | Internal cancellation handle |

**⚠ Note:** `NodeExecutionMetrices` has a typo (should be "Metrics") — this is the actual field name in the FLT codebase.

---

#### DagExecutionMetrics

**Source:** `DataModel/Dag/DagExecutionMetrics.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `JobId` | `Guid` | `"jobId"` | Execution job ID |
| `Status` | `DagExecutionStatus` | `"status"` | Overall execution status |
| `StartedAt` | `DateTime?` | `"startedAt"` | Execution start time |
| `EndedAt` | `DateTime?` | `"endedAt"` | Execution end time |
| `CancellationRequestedAt` | `DateTime?` | `"cancellationRequestedAt"` | When cancel was requested |
| `ErrorCode` | `string` | `"errorCode"` | Overall error code |
| `ErrorMessage` | `string` | `"errorMessage"` | Overall error message |
| `AttachedEnvironmentId` | `Guid` | `"attachedEnvironmentId"` | Environment used |
| `RefreshMode` | `RefreshMode` | `"refreshMode"` | Optimal or Full |
| `ParallelNodeLimit` | `int` | `"parallelNodeLimit"` | Max concurrent nodes |
| `DisplayName` | `string?` | `"displayName"` | Execution display name |
| `MLVExecutionDefinitionId` | `Guid?` | `"mlvExecutionDefinitionId"` | If run from named definition |
| `JobInvokeType` | `string?` | `"jobInvokeType"` | How invoked (Manual, Scheduled, etc.) |
| `SubmitUser` | `string?` | `"submitUser"` | User who submitted |
| `SubmitUserObjectId` | `Guid` | `"submitUserObjectId"` | AAD object ID of submitter |

---

#### NodeExecutionMetrics

**Source:** `DataModel/Dag/NodeExecutionMetrics.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `Status` | `NodeExecutionStatus` | `"status"` | Node execution status |
| `StartedAt` | `DateTime?` | `"startedAt"` | Node start time |
| `EndedAt` | `DateTime?` | `"endedAt"` | Node end time |
| `CancellationRequestedAt` | `DateTime?` | `"cancellationRequestedAt"` | Cancel request time |
| `DetailsPageLink` | `string` | `"detailsPageLink"` | Link to execution details |
| `ErrorCode` | `string` | `"errorCode"` | Error code if failed |
| `ErrorMessage` | `string` | `"errorMessage"` | Error message if failed |
| `NodeErrorDetails` | `NodeErrorDetails?` | `"nodeErrorDetails"` | Parsed error details |
| `RequestId` | `Guid?` | `"requestId"` | Spark request ID |
| `SessionId` | `Guid?` | `"sessionId"` | Spark session ID |
| `ReplId` | `Guid?` | `"replId"` | HC session REPL ID |
| `AddedRowsCount` | `long` | `"addedRowsCount"` | Rows added (-1 if N/A) |
| `DroppedRowsCount` | `long` | `"droppedRowsCount"` | Rows dropped (-1 if N/A) |
| `Warnings` | `List<NodeWarning>` | `"warnings"` | CDF warnings |
| `RefreshPolicy` | `string` | `"refreshPolicy"` | "FullRefresh" / "IncrementalRefresh" |
| `MlvNamespace` | `string` | `"mlvNamespace"` | e.g., "LakehouseName.SchemaName" |
| `MlvName` | `string` | `"mlvName"` | MLV name |
| `MlvId` | `string` | `"mlvId"` | MLV ID |
| `RefreshDate` | `DateOnly?` | `"refreshDate"` | Refresh date |
| `RefreshTimestamp` | `DateTime?` | `"refreshTimestamp"` | Refresh timestamp |
| `Message` | `string` | `"message"` | Execution message |
| `TotalRowsProcessed` | `long` | `"totalRowsProcessed"` | Total rows processed |
| `TotalViolations` | `long` | `"totalViolations"` | DQ violations count |
| `ViolationsPerConstraint` | `string` | `"violationsPerConstraint"` | JSON string of violations |

---

#### DagExecutionIteration

**Source:** `DataModel/Dag/DagExecutionIteration.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `IterationId` | `Guid` | `"iterationId"` | Unique iteration ID |
| `StartedAt` | `DateTime?` | `"startedAt"` | Start time |
| `EndedAt` | `DateTime?` | `"endedAt"` | End time |
| `Status` | `DagExecutionStatus` | `"status"` | Execution status |
| `DisplayName` | `string?` | `"displayName"` | Display name |
| `MlvCount` | `int` | `"mlvCount"` | Number of MLVs in execution |
| `SubmitUser` | `string?` | `"submitUser"` | Submitter |
| `SubmitUserObjectId` | `Guid` | `"submitUserObjectId"` | Submitter object ID |
| `JobInvokeType` | `string?` | `"jobInvokeType"` | Invocation type |
| `ErrorCode` | `string?` | `"errorCode"` | Error code if failed |

---

#### NodeErrorDetails

**Source:** `DataModel/Dag/NodeErrorDetails.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `ErrorCode` | `string` | `"errorCode"` | e.g., `MLV_RUNTIME_ERROR` |
| `ErrorMessage` | `string` | `"errorMessage"` | Parsed error message |
| `FailureType` | `string` | `"failureType"` | `"UserError"` or `"SystemError"` |
| `ErrorSource` | `ErrorSource` | — | `[JsonIgnore]` computed from FailureType |

**Parsing format:** `[ERROR_CODE] message failureType: Type errorDetails: Details`

---

#### NodeWarning

**Source:** `DataModel/Dag/NodeWarning.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `WarningType` | `WarningType` | `"warningType"` | `CDFDisabled` or `DeleteWithoutHints` |
| `RelatedSourceEntities` | `List<string>` | `"relatedSourceEntities"` | Format: `"workspace.lakehouse.schema.table"` |

---

#### DagSettings / DagSettingsRequestBody / DagSettingsResponseBody

**Source:** `DataModel/DagSettings.cs`, `Contracts/Api/DagSettings*.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `Environment` | `Environment?` | `"environment"` | `{ EnvironmentId, WorkspaceId }` |
| `RefreshMode` | `RefreshMode?` | `"refreshMode"` | `Optimal` or `Full` |
| `ParallelNodeLimit` | `int?` | `"parallelNodeLimit"` | Range: 2–25, default: 5 |

**Constants:** `DefaultParallelNodeLimit = 5`, `MinParallelNodeLimit = 2`, `MaxParallelNodeLimit = 25`

---

#### MLVExecutionDefinitionRequest / Response

**Source:** `Contracts/Api/MLVExecutionDefinition*.cs`

| Property | Type | JSON Key | Notes |
|----------|------|----------|-------|
| `Id` | `Guid` | `"id"` | Response only — system-generated |
| `Name` | `string` | `"name"` | Required |
| `Description` | `string?` | `"description"` | Optional |
| `SelectedMLVs` | `List<string>?` | `"selectedMLVs"` | MLV names to include |
| `ExecutionMode` | `ExecutionMode` | `"executionMode"` | Default: `CurrentLakehouse` |
| `IncludedLakehouses` | `List<Guid>?` | `"includedLakehouses"` | Cross-lakehouse IDs |
| `DagSettings` | `DagSettings(Request/Response)Body?` | `"dagSettings"` | Override settings |
| `CreatedAt` | `DateTime` | `"createdAt"` | Response only |
| `UpdatedAt` | `DateTime?` | `"updatedAt"` | Response only |

---

### Enums & Constants

#### DagExecutionStatus

**Source:** `DataModel/Dag/DagExecutionStatus.cs`

| Value | JSON String | Description |
|-------|-------------|-------------|
| `NotStarted` | `"notStarted"` | Queued for execution |
| `Running` | `"running"` | Currently running |
| `Completed` | `"completed"` | Successfully completed |
| `Failed` | `"failed"` | Execution failed |
| `Cancelled` | `"cancelled"` | Execution cancelled |
| `Cancelling` | `"cancelling"` | Cancellation in progress |
| `Skipped` | `"skipped"` | Execution skipped |
| `NotFound` | `"notFound"` | Status not specified |

#### NodeExecutionStatus

**Source:** `DataModel/Dag/NodeExecutionStatus.cs`

| Value | JSON String | Description |
|-------|-------------|-------------|
| `None` | `"none"` | Not started / pending |
| `Running` | `"running"` | Currently executing |
| `Completed` | `"completed"` | Successfully completed |
| `Failed` | `"failed"` | Execution failed |
| `Cancelled` | `"cancelled"` | Execution cancelled |
| `Skipped` | `"skipped"` | Execution skipped |
| `Cancelling` | `"cancelling"` | Cancellation in progress |

#### ExecutionMode

| Value | JSON String | Description |
|-------|-------------|-------------|
| `CurrentLakehouse` | `"CurrentLakehouse"` | Default — current lakehouse only |
| `SelectedOnly` | `"SelectedOnly"` | Only selected MLVs, no dependencies |
| `FullLineage` | `"FullLineage"` | Cross-lakehouse within workspace |

#### RefreshMode

| Value | JSON String |
|-------|-------------|
| `Optimal` | `"Optimal"` |
| `Full` | `"Full"` |

#### WarningType

| Value | Description |
|-------|-------------|
| `CDFDisabled` | CDF disabled on source entities |
| `DeleteWithoutHints` | Delete operations without proper hints |

---

### Service Interfaces

#### IDagExecutionStore

**Source:** `Store/IDagExecutionStore.cs`

Key methods:
- `OnDagExecutionRequestAsync()` — Create base directory for iteration
- `SaveDagForExecutionAsync()` — Persist DAG to OneLake
- `TryLockDagTypeForExecutionAsync()` — Acquire execution lock
- `GetDagExecutionInstanceAsync()` — Get execution instance (cache → OneLake fallback)
- `FinishDagExecutionInstanceAsync()` — Cleanup post-execution
- `ForceUnlockDAGExecutionAsync()` — Force unlock stuck execution

---

## P0.2: Existing EDOG DAG UI Audit

### File-by-File Audit

#### 1. control-panel.js (617 lines)

**Class:** `ControlPanel`
**Purpose:** Command center for DAG orchestration (Run/Cancel) with execution tracking.
**Status:** Fully functional but NOT wired into the UI — no DOM container exists in `index.html`.

**Constructor:** `ControlPanel(containerEl, { autoDetector, stateManager })`

**API methods already implemented:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `_fetchConfig()` | `GET /api/flt/config` | Get Workspace/Lakehouse IDs, MWC token |
| `_fetchLatestDag()` | `GET /liveTable/getLatestDag?showExtendedLineage=true` | Fetch DAG structure |
| `_runDag()` | `POST /liveTableSchedule/runDAG/{iterationId}` | Start execution |
| `_cancelDag()` | `POST /liveTableSchedule/cancelDAG/{iterationId}` | Cancel execution |
| `_fetchHistory()` | `GET /api/executions` | Fetch execution history |

**Rendering methods:**
- `_renderConnectionBar()` — Token expiry, config IDs
- `_renderDagOverview()` — Node table (name, type, dependencies) — TEXT ONLY
- `_renderExecutionIdle()` / `_renderExecutionActive()` — Run/Cancel buttons, progress bar
- `_renderHistory()` — Execution history table
- `_renderDagError()` — Error handling (401/403/404/502)

**Data normalization:**
- `_extractNodes(dagData)` — Handles multiple DAG JSON formats (array or object keys)
- `_extractDagName()` — Case-insensitive name extraction
- `_extractRefreshMode()` — Extracts refresh policy

**Reusable:** ✅ API calling, token management, DAG data normalization, execution state machine (idle→running→completed/failed/cancelled), AutoDetector integration.

**Not reusable:** ❌ All rendering (text tables only, no graph/canvas/SVG), no Gantt chart, no node detail panel, no execution comparison.

---

#### 2. dag.css (134 lines)

**Status:** Complete CSS for the DAG Studio visual framework — ready for implementation.

**Key CSS classes:**

| Class | Purpose |
|-------|---------|
| `.dag-studio` | Main container (flex column, 100% height) |
| `.dag-toolbar` | Top toolbar with buttons and status |
| `.dag-body` | Split layout: graph-panel \| side-panel |
| `.dag-graph-panel` | SVG/Canvas rendering area |
| `.dag-side-panel` | 340px right panel |
| `.dag-node` | Clickable node with hover effect |
| `.dag-node.completed` | Green stroke (`--status-succeeded`) |
| `.dag-node.failed` | Red stroke (`--status-failed`) |
| `.dag-node.running` | Pulsing animation (`@keyframes dag-pulse`) |
| `.dag-node.skipped` | Muted dotted stroke |
| `.dag-node.pending` | Border-only style |
| `.dag-edge` | Arrow lines between nodes |
| `.gantt-chart` / `.gantt-row` / `.gantt-bar` | Full Gantt chart layout |
| `.dag-history-table` / `.status-pill` | History table with status badges |
| `.dag-zoom-controls` | Floating zoom buttons (top-right) |
| `.dag-node-detail` | Slide-up detail panel |

**Animations defined:**
- `@keyframes dag-pulse` — Stroke opacity pulse for running nodes (1.5s)
- `@keyframes gantt-shimmer` — Opacity shimmer for Gantt bars (1.5s)

**Reusable:** ✅ All of it — layout structure, status colors, animations, Gantt bars, history table, zoom controls.

---

#### 3. auto-detect.js (286 lines)

**Class:** `AutoDetector`
**Purpose:** Automatically detect DAG executions and API calls from the log stream in real-time.
**Status:** Fully functional, used by ControlPanel.

**Execution tracking object** (keyed by IterationId):
```
{
  dagName, status, startTime, endTime,
  nodeCount, completedNodes, failedNodes, skippedNodes,
  parallelLimit, refreshMode, duration,
  errors: [{code, message, timestamp, node}],
  raids: Set<string>,
  endpoint, nodes: Map<name, {status, duration, errorCode, timestamp}>
}
```

**Detection patterns:**
- `[DAG STATUS]` / `[DAG_STATUS]` — Status transitions
- `Creating Dag from Catalog` — DAG name extraction
- `DagNodesCount` / `nodeCount` — Node count
- `ParallelNodeLimit` — Parallelism limit
- `RefreshMode` — Refresh policy
- `Executed node` / `Executing node` — Per-node status with timing
- `[DAG_FAULTED_NODES]` — Skipped/faulted nodes
- Error codes: `MLV_*`, `FLT_*`, `SPARK_*` — Error classification

**Callback hooks:**
- `onExecutionDetected(id, execution)` — New execution started
- `onExecutionUpdated(id, execution)` — Execution state changed
- `onErrorDetected(error)` — Error encountered
- `onApiCallDetected(raid, call)` / `onApiCallUpdated(raid, call)` — API tracking

**Reusable:** ✅ All pattern matching, error classification, execution state tracking, callback system. Direct integration point for DAG Studio real-time updates.

---

#### 4. mock-data.js (250+ lines)

**DAG mock data available:**
- 8-node DAG with varied statuses (completed, failed, running, skipped)
- Node kinds: sql, pyspark
- Dependency graph with fan-in/fan-out patterns
- 5 execution history records with realistic durations
- DAG-specific log message templates (20+ patterns)
- 16 feature flags (DAG-related: `FLTDagExecutionHandlerV2`, `FLTParallelNodeLimit10/15`)

**Reusable:** ✅ Mock data structures for development. Needs expansion to 50+ nodes for performance testing.

---

#### 5. index.html (321 lines)

**DAG-related findings:**
- No `#control-panel` container exists (ControlPanel has no DOM target)
- No DAG Studio view in sidebar navigation
- DAG preset filter button exists in logs view: `<button data-preset="dag">DAG</button>`
- View switching pattern: `.view-panel` with `data-view` attribute
- Sidebar sub-items registered under "Runtime" group

**Not reusable:** ❌ No DAG Studio view container. Must be added.

---

#### 6. Build order (build-html.py)

CSS: `dag.css` loads at position 7/13+
JS: `auto-detect.js` at position 5, `control-panel.js` at position 7, both before `main.js`

New `dag-graph.js` and `dag-gantt.js` modules should load after `control-panel.js` but before `main.js`.

---

### Reusability Matrix

| Component | Status | Reusable | Action |
|-----------|--------|----------|--------|
| `ControlPanel` API methods | Working | ✅ Extract | Move to `api-client.js` or reuse in new DagStudio class |
| `ControlPanel` rendering | Working | ❌ Replace | Text tables → SVG graph + Canvas/SVG Gantt |
| `ControlPanel` state machine | Working | ✅ Reuse | idle → running → completed/failed/cancelled |
| `AutoDetector` patterns | Working | ✅ Reuse | Direct integration for real-time updates |
| `dag.css` | Complete | ✅ Reuse | All styles ready, may need minor additions |
| `mock-data.js` DAG data | Working | ✅ Extend | Add 50+ node DAGs for performance testing |
| `index.html` DAG view | Missing | ❌ Create | Add `#view-dag` container + sidebar nav item |
| Graph layout algorithm | Missing | ❌ Create | New `dag-graph.js` with Sugiyama layout |
| Gantt chart renderer | Missing | ❌ Create | New `dag-gantt.js` with time-axis bars |
| Node detail panel | Missing | ❌ Create | Slide-up panel with metrics, errors, logs |
| Execution comparison | Missing | ❌ Create | Side-by-side diff view (F15) |

---

### Frontend Architecture

**Pattern:** Class-based modules, no frameworks, event callbacks.

**Data flow:**
```
Backend → SignalR → SignalRManager → logs array
                                    ↓
                              AutoDetector (pattern matching)
                                    ↓
                        onExecutionDetected/Updated callbacks
                                    ↓
                    ControlPanel / SmartContextBar / ErrorIntel
                                    ↓
                              DOM rendering
```

**View switching:**
```javascript
sidebar.switchView('dag');  // Shows #view-dag, hides others
// Module activation:
if (viewId === 'dag') dagStudio.activate();
```

---

## P0.3: Graph Rendering Reference Analysis

**Source:** `flt-debugger/mockups/operator_console_v2_webGL.html` (178KB, ~5100 lines)

### Rendering Technology

**Primary: Canvas 2D** (despite the filename suggesting WebGL).
- Uses `HTMLCanvasElement` with `getContext('2d')`
- Renders at 60 FPS via `requestAnimationFrame()`
- Architecture is "WebGL-ready" with separation of concerns

**Node rendering (3 LOD levels):**

| LOD Level | Size | Renders | When |
|-----------|------|---------|------|
| **Detail** | 140×52px | Full card: name, meta, status badge, shadow | Close zoom or <100 nodes |
| **Mini** | 60×24px | Condensed box: truncated name | Mid zoom, 100–300 nodes |
| **Dot** | 4–6px circle | Colored dot, glow on failure | Far zoom or >300 nodes |

**Edge rendering:** Bezier curves via `ctx.bezierCurveTo()` with midpoint control points:
```javascript
midX = (from.x + to.x) / 2;
ctx.bezierCurveTo(midX, from.y, midX, to.y, to.x, to.y);
```

---

### Layout Algorithm

**Type:** Sugiyama-inspired with depth-based placement.

**5 configurable layout shapes:**

| Shape | Description | Use Case |
|-------|-------------|----------|
| `BALANCED` | `sqrt(nodes * 2.5)` cols × auto rows | General purpose |
| `WIDE` | 5 cols × many rows | Many nodes per depth |
| `DEEP` | 3 rows × many cols | Few nodes per depth |
| `SKEWED` | 70% bottleneck at depth 2 | Heavy transforms |
| `FUNNEL` | 35% sources → 8% final | ETL patterns |

**Spacing:** `spacingX = 180px`, `spacingY = 80px`

**Layer assignment by depth ratio:**
- `< 0.33` → Bronze (source tables)
- `0.33–0.66` → Silver (intermediate transforms)
- `> 0.66` → Gold (final outputs)

**Edge direction:** Strictly left-to-right (no reverse edges). This matches FLT DAG semantics where parents flow to children.

---

### Interaction Model

| Interaction | Implementation | Notes |
|-------------|---------------|-------|
| **Pan** | Mouse drag: `mousedown` → delta tracking → `mouseup` | Grab cursor during drag |
| **Zoom** | Scroll wheel: `0.9×` / `1.1×` per tick | Zoom toward cursor position |
| **Zoom bounds** | `0.15 ≤ scale ≤ 3.0` | Prevents extreme zoom |
| **Zoom buttons** | +25%, −20%, fit-to-screen | Accessible alternatives |
| **Node select** | Click hit-test: `Math.abs(dx) < NODE_WIDTH/2` | Rectangular AABB collision |
| **Node hover** | Continuous on `mousemove` | `cursor: pointer` feedback |
| **Keyboard F** | Jump to first failed node | Direct error navigation |
| **Keyboard T** | Toggle timeline view | Gantt/timeline switch |
| **Cmd+K** | Command palette | Already in EDOG |
| **Cmd+B** | Toggle sidebar | Already in EDOG |
| **Cmd+D** | Toggle detail panel | Node detail |

**Camera:** Single transform object `{x, y, scale}` applied via `ctx.translate()` + `ctx.scale()`.

**Fit-to-screen:** Calculate bounds of all nodes → center → compute scale to fit viewport with padding.

---

### Visual Style

**Color palette (dark theme, Palantir-inspired):**

| Token | Value | EDOG Equivalent |
|-------|-------|-----------------|
| Background | `#0D0D0D` | `--color-bg-base` |
| Card | `#1A1A1A` | `--color-bg-surface` |
| Border | `#2A2A2A` | `--color-border` |
| Text | `#E5E5E5` | `--color-text-primary` |
| Text secondary | `#808080` | `--color-text-secondary` |
| Success | `#32D74B` | `--status-succeeded` |
| Failed | `#FF453A` | `--status-failed` |
| Running | `#FF9F0A` | `--color-accent` |
| Selected | `#0A84FF` | `--color-accent` |
| Bronze layer | `#CD7F32` | New — source tables |
| Silver layer | `#A8A9AD` | New — intermediate |
| Gold layer | `#C9A227` | New — final outputs |

**Node shapes:** Rounded rectangles (8px radius), 4px left status bar.

**Edge styles:**
- Normal: `#3A3A3A`, 0.4 opacity
- Selected: `#0A84FF`, 0.8 opacity, 2.5px width
- Error path: `#FF453A`, 0.5 opacity, dashed `[6, 4]`

**Animations:**
- Node entry: `translateY(+16px)` over 0.4s ease
- Edge draw: dash animation over 0.6s with 0.4s delay
- Hover: `translateY(-2px)` lift
- Selected: box-shadow glow pulse

**Background:** Radial gradient dot grid, 24px spacing.

---

### Performance Techniques

| Technique | Implementation | Impact |
|-----------|---------------|--------|
| **LOD culling** | 3 levels: detail/mini/dot based on zoom + distance | Reduces draw calls 10×+ |
| **3-pass render** | Dots → Mini → Detail (cheapest first) | Correct z-ordering without sort |
| **Minimap sampling** | `sampleRate = max(1, floor(nodes/100))` | Only render every Nth node |
| **Single transform** | One `ctx.save()/restore()` per frame | No per-node matrix recalculation |
| **Edge optimization** | Dash only on failed paths | Avoid expensive `setLineDash` |
| **Frame counting** | `requestAnimationFrame()` at 60 FPS cap | Smooth, non-blocking |

**NOT implemented:** Spatial indexing (O(N) hit test), instanced rendering, Web Workers, virtual scrolling. Adequate for 300 nodes; for 1000+ would need improvements.

---

### SVG vs Canvas Tradeoff

| Aspect | Canvas 2D | SVG | Winner for EDOG |
|--------|-----------|-----|-----------------|
| 50 nodes performance | ✅ 60 FPS | ✅ 60 FPS | Tie |
| DOM interactivity | ❌ Manual hit-test | ✅ Built-in events | SVG |
| CSS styling | ❌ Programmatic only | ✅ CSS + attributes | SVG |
| Pan/zoom | ✅ Transform matrix | ✅ `viewBox` transform | Tie |
| Animation | 🟡 `requestAnimationFrame` | ✅ CSS transitions | SVG |
| Single-file constraint | ✅ Inline `<script>` | ✅ Inline `<svg>` | Tie |
| Text rendering | 🟡 Canvas text | ✅ SVG `<text>` (crisp) | SVG |
| LOD system | ✅ Easy to implement | 🟡 Requires DOM manipulation | Canvas |
| Edge bezier curves | ✅ `bezierCurveTo()` | ✅ `<path d="C...">` | Tie |
| Accessibility | ❌ No DOM tree | ✅ ARIA attributes on elements | SVG |
| 500+ nodes | ✅ Better scaling | ❌ DOM thrashing | Canvas |

**Recommendation: SVG for DAG Studio.**

Rationale:
1. DAG Studio targets 50–100 nodes, well within SVG's sweet spot
2. SVG nodes are DOM elements → native click/hover/keyboard events (no hit-test math)
3. CSS transitions for status changes (color shifts, pulse animations) — already defined in `dag.css`
4. `dag.css` already targets SVG elements (`.dag-node rect`, `.dag-edge`)
5. Accessibility: nodes can have `role`, `aria-label`, `tabindex` for keyboard navigation
6. The design spec explicitly says "SVG-based DAG graph"
7. If we later need 500+ nodes, we can add Canvas-based minimap alongside SVG graph

**Canvas reserved for:** Minimap viewport indicator, Gantt chart timeline (continuous horizontal rendering), performance-critical overlays.

---

### Sugiyama Layout for Vanilla JS

The Sugiyama (layered) layout algorithm is the standard for DAG visualization. Here's how to implement it in vanilla JS for EDOG's constraints:

#### Algorithm Steps

```
1. LAYER ASSIGNMENT — Assign each node to a layer (depth)
   - Topological sort the DAG
   - Layer[node] = max(Layer[parent] + 1) for all parents
   - Source nodes (no parents) → Layer 0

2. NODE ORDERING — Minimize edge crossings within layers
   - Barycenter heuristic: position = average(parent positions)
   - Iterate top-down then bottom-up (2–4 passes)
   - Each pass reorders nodes within their layer

3. COORDINATE ASSIGNMENT — Calculate X/Y positions
   - X = layer * spacingX (horizontal layers, left-to-right)
   - Y = position_in_layer * spacingY (vertical within layer)
   - Center each layer vertically

4. EDGE ROUTING — Draw edges between positioned nodes
   - Bezier curves with horizontal midpoint control points
   - For long edges spanning multiple layers: add virtual nodes
```

#### Implementation Notes for EDOG

```javascript
class DagLayout {
  // Step 1: Topological sort + layer assignment
  _assignLayers(nodes, edges) {
    // Kahn's algorithm: queue nodes with no incoming edges
    // Layer = longest path from any source
    // O(V + E) time complexity
  }

  // Step 2: Crossing minimization
  _minimizeCrossings(layers) {
    // Barycenter method: 2-4 passes
    // For 50 nodes this runs in <1ms
  }

  // Step 3: Position calculation
  _assignPositions(layers) {
    // spacingX = 200px (between layers)
    // spacingY = 80px (between nodes in same layer)
    // Center layers vertically in viewport
  }

  // Returns: Map<nodeId, {x, y, layer}>
  layout(nodes, edges) { ... }
}
```

**Performance for 50+ nodes:**
- Layer assignment: O(V + E) — instant for 50 nodes
- Crossing minimization: O(L × N² × P) where L=layers, N=max nodes/layer, P=passes — <5ms for 50 nodes
- Coordinate assignment: O(V) — instant
- Total layout time: <10ms for 100 nodes, <50ms for 500 nodes

**Edge routing with Bezier curves:**
```javascript
// Horizontal flow: control points at horizontal midpoint
const midX = (fromNode.x + toNode.x) / 2;
const d = `M ${fromNode.x} ${fromNode.y}
           C ${midX} ${fromNode.y},
             ${midX} ${toNode.y},
             ${toNode.x} ${toNode.y}`;
// SVG: <path d="${d}" class="dag-edge" />
```

For edges spanning 2+ layers, add intermediate waypoints to avoid crossing other nodes.

---

## Architecture Recommendations

### Component Structure

```
dag-graph.js (NEW)
├── class DagLayout       — Sugiyama layout algorithm
├── class DagGraph        — SVG graph renderer
│   ├── loadDag()         — Fetch + layout + render
│   ├── renderGraph()     — SVG node/edge creation
│   ├── updateNodeState() — Status change during execution
│   ├── selectNode()      — Highlight + detail panel
│   ├── fitToScreen()     — Viewport fit
│   └── zoomIn/Out/Reset()
│
dag-gantt.js (NEW)
├── class DagGantt        — Canvas/SVG Gantt renderer
│   ├── renderGantt()     — Horizontal bars on time axis
│   ├── highlightNode()   — Cross-highlight with graph
│   └── renderComparison()— Side-by-side diff (F15)
│
control-panel.js (REFACTOR)
├── class DagStudio       — Orchestrator (replaces ControlPanel)
│   ├── activate/deactivate()
│   ├── _initGraph()      — Wire up DagGraph
│   ├── _initGantt()      — Wire up DagGantt
│   ├── _runDag()         — Execution control
│   ├── _cancelDag()      — Cancel control
│   └── _loadHistory()    — History panel
```

### Data Flow for DAG Studio

```
1. LOAD (on view activation):
   GET /liveTable/getLatestDag?showExtendedLineage=true
     → DagLayout.layout(nodes, edges)
     → DagGraph.renderGraph(positioned_nodes, edges)

2. RUN (user clicks "Run DAG"):
   Generate UUID → POST /liveTableSchedule/runDAG/{uuid}
     → Subscribe to AutoDetector callbacks
     → Update node states in real-time via DagGraph.updateNodeState()
     → Update Gantt bars in real-time

3. HISTORY (load past execution):
   GET /liveTable/listDAGExecutionIterationIds
     → User clicks row → GET /liveTable/getDAGExecMetrics/{iterationId}
     → Overlay execution metrics onto DAG graph
     → Render Gantt chart from node timing data

4. REAL-TIME (during active execution):
   AutoDetector.onExecutionUpdated → DagGraph.updateNodeState()
   AutoDetector.onExecutionUpdated → DagGantt.updateBar()
```

### Key Design Decisions for CEO Review

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| **Rendering** | SVG for graph, Canvas for Gantt minimap | SVG native events, CSS animations, accessibility; Canvas for high-performance timeline |
| **Layout** | Sugiyama (layered) | Standard for DAGs, no cycles, left-to-right flow matches FLT data direction |
| **LOD** | Not needed at MVP | 50-node target; add LOD if we hit 200+ nodes |
| **Interaction** | Pan (drag), Zoom (scroll), Select (click), Keyboard (arrows) | Match reference implementation |
| **Node detail** | Slide-up panel (reuse detail panel pattern) | Consistent with existing logs detail panel UX |
| **Execution comparison** | Defer to F15 | Separate feature, builds on DAG Studio foundation |
| **MLV Execution Definitions** | Show in settings/toolbar | Allow selecting named subsets before running |
| **Force Unlock** | Button in toolbar, requires confirmation | Emergency action for stuck executions |
| **Lock indicator** | Status badge in toolbar | Poll `getLockedDAGExecutionIteration` periodically |

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| SVG performance >100 nodes | Medium | LOD: collapse distant nodes to dots; virtual DOM for off-screen |
| Edge crossing in dense DAGs | Low | Sugiyama barycenter handles this; add manual override |
| Long edges spanning many layers | Medium | Virtual nodes (dummy nodes per layer for edge routing) |
| Stale execution data | Low | Auto-refresh on view activation + manual refresh button |
| Race condition: run + cancel | Medium | Disable Run during active execution; debounce Cancel |
| `cancelDAG` is GET not POST | Low | Wrap in confirmation; document the FLT quirk |
| `liveTableMaintanance` typo in URL | Low | Use the actual URL including typo; comment explaining it |
| `NodeExecutionMetrices` field typo | Low | Map to correct property name in JS; comment the FLT typo |

---

*"The whole board is visible now. The DAG API is rich — 16 endpoints, 17 model classes, every field documented. The existing ControlPanel gives us API integration and state management for free. The reference implementation proves Canvas 2D works at 300 nodes. But for EDOG's 50-node target with our CSS-first, accessible, keyboard-navigable requirements — SVG is the right call. Build the Sugiyama layout engine first, everything else follows from positioned nodes."*

— Sana Reeves, Architect
