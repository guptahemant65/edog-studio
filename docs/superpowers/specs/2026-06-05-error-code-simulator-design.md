# Error Code Simulator — Design Spec

> **Status:** APPROVED
> **Date:** 2026-06-05
> **Owner:** Sana (Architecture) + Vex (Backend) + Pixel (Frontend)
> **CEO:** Hemant Gupta
> **Scope:** MVP — Error code injection integrated into DAG Studio
> **Depends On:** F24 (Chaos Engineering), F08 (DAG Studio), existing `EdogHttpFaultStore` + `EdogHttpPipelineHandler`

---

## 1. Problem Statement

FLT engineers need to test how DAG execution handles specific error codes (auth failures, capacity throttling, Spark session timeouts, schema mismatches) without waiting for real failures or manually breaking PPE resources. EDOG Studio already sits inside FLT's HTTP pipeline and can forge responses — this feature surfaces that capability as a first-class, user-friendly Error Code Simulator integrated into DAG Studio.

---

## 2. Core Concept

**"Right-click a node → pick an error code → run the DAG → see exactly what happens."**

The simulator maps FLT error codes (what the engineer thinks in) to HTTP response patterns (what causes the error in reality). When the DAG executes, EDOG's pipeline handler injects the mapped HTTP response at the right moment. FLT's real error handling, retry logic, and propagation run untouched — the engineer observes authentic behavior.

---

## 3. Architecture

### 3.1 Three Layers

```
┌─────────────────────────────────────────────────────────┐
│                    EDOG Studio (Browser)                  │
│                                                           │
│  ┌──────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │ Error    │ │ Active       │ │ Blast Radius      │    │
│  │ Picker   │ │ Injections   │ │ Panel             │    │
│  └────┬─────┘ └──────┬───────┘ └────────┬──────────┘    │
│       └───────┬───────┴─────────┬────────┘               │
│               │    SignalR      │                         │
│               │ /hub/playground │                         │
└───────────────┼─────────────────┼────────────────────────┘
                │                 │
┌───────────────┼─────────────────┼────────────────────────┐
│               ▼    FLT Process  ▼                        │
│  ┌──────────────────────────────────────────────┐        │
│  │        Error Injection Engine                 │        │
│  │  ┌──────────────┐  ┌─────────────────────┐  │        │
│  │  │ ErrorCodeMap  │  │ NodeScopeActivator  │  │        │
│  │  │ (code→HTTP)   │  │ (fires per-node)    │  │        │
│  │  └──────┬───────┘  └──────────┬──────────┘  │        │
│  └─────────┼─────────────────────┼──────────────┘        │
│            │                     │                        │
│  ┌─────────▼─────────────────────▼──────────────┐        │
│  │    EdogHttpPipelineHandler.SendAsync()         │        │
│  │    (existing — already does fault injection)   │        │
│  └────────────────────────────────────────────────┘        │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Error Code → HTTP Response Mapping

A static table embedded in the C# backend. ~50 entries mapping deduplicated FLT error codes to the HTTP response that triggers them. Format:

```csharp
new ErrorCodeMapping {
    Code = "MLV_TOO_MANY_REQUESTS",
    Category = "throttling",
    Phase = "POST_GTS",
    Severity = "transient",
    Description = "Request rate limit exceeded",
    UserMessage = "You've reached the request limit. Please try again later.",
    HttpStatus = 429,
    TargetPattern = "/Workloads/com.microsoft.lakehouse/TIPS/",  // GTS endpoint
    ResponseBody = @"{""code"":""TooManyRequests"",""message"":""Rate limit exceeded""}",
    FltCodePath = "GTSBasedSparkClient.cs:486 → MLV_TOO_MANY_REQUESTS",
    RetryBehavior = "Transient — exponential backoff configured"
}
```

### 3.3 Node-Scoped Activation

FLT parallelizes node execution. Scoping must be precise.

**Reality check: `EdogNodeExecutorWrapper` exists but is NOT wired up.**
FLT creates `new NodeExecutor(...)` directly (`DagExecutionHandlerV2.cs:1013`), not through DI. The wrapper at `EdogDagExecutionInterceptor.cs:140` is dead code (`EdogDevModeRegistrar.cs:73` acknowledges this as "Gap 2"). **We must create a new patch to wire it up.**

**For Channels 1+2 (GTS calls during node execution): Two options**

**Option A (requires new patch):** Patch `DagExecutionHandlerV2.cs:1013` to wrap `NodeExecutor` with `EdogNodeExecutorWrapper`, which sets `AsyncLocal<EdogNodeExecutionContext>`. All HTTP calls during that node's `ExecuteNodeAsync` inherit the context.

**Option B (works today):** `EdogSparkClientWrapper` already receives the `Node` parameter in both `SendTransformRequestAsync(transformationId, node, ...)` and `GetTransformStatusAsync(transformationId, node, ...)`. Set the AsyncLocal there instead:

```csharp
// In EdogSparkClientWrapper.SendTransformRequestAsync:
EdogNodeExecutionContext.Current = new EdogNodeExecutionContext {
    NodeId = node.NodeId.ToString(), NodeName = node.Name
};
var result = await _inner.SendTransformRequestAsync(...);
// Note: context stays set through the poll loop too
```

Option B is simpler — no new patch needed, SparkClient wrapper is already wired via DI. But it only covers GTS calls, not other HTTP calls during node execution (OneLake, catalog).

**Recommended: Option A** — patch NodeExecutor wrapping. Gives us full coverage of all HTTP calls per-node. The patch follows the exact same pattern as the existing `EdogDagExecutionHook` patch.

**For Channel 3 (pre-GTS catalog errors): Node State Injection**

Pre-GTS catalog resolution happens in `CatalogHandler.GetConnectedCatalogObjectsAsync` during `CreateAndSaveDagForExecutionAsync` (step 4 in the lifecycle). This is a sequential loop over source entities — NOT inside `ExecuteNodeAsync`. The loop variable `currentEntity` identifies which MLV is being resolved.

HTTP-level injection won't work here for per-node targeting because:
- Multiple MLVs can source from tables in the SAME lakehouse
- The lakehouse resolution call is cached per lakehouse (`lakeHouseMetastoreClientMap`)
- Table-level `GetTableAsync` differentiates, but uses a metastore client (may not be HTTP)

**Solution:** After `CreateAndSaveDagForExecutionAsync` returns and before the faulted-node check at `DagExecutionHandlerV2:338`, use reflection to set the target node's state:
```csharp
node.IsFaulted = true;
node.FLTErrorCode = ErrorCode.MLV_SOURCE_ENTITY_NOT_FOUND;
node.ErrorMessage = "Source entity not found (simulated)";
```
FLT's own `DagExecutionHandlerV2:338` then detects the faulted node and throws `MLV_DAG_HAS_FAULTED_NODES` — exact real behavior.

**Hook point:** New patch in `DagExecutionHandlerV2.cs` between line 218 (DAG saved) and line 338 (faulted check). Or use `EdogDagExecutionHook` if it fires before the faulted check.

### 3.4 Four Injection Channels

Every FLT error code is injected through one of four channels, chosen to match the **real code path**:

**Channel 1: GTS Status Response Forge (HTTP 200 + error JSON body)**
For errors that naturally occur during node execution (Spark returns the error).
Forge: `{"state":"Failed","errorDetails":{"errorCode":"MLV_xxx","message":"...","errorSource":"User|System"}}`
Scoped via AsyncLocal — precise per-node even with parallel execution.
**Covers: ~52 NODE_EXECUTION + INGEST + PySpark codes**

**Channel 2: GTS Submit HTTP Forge**
For errors from the Spark job submission HTTP response itself.
Forge HTTP status codes (429/430/500/400) on the GTS submit endpoint.
Scoped via AsyncLocal.
**Covers: 6 GTS_SUBMIT codes** (TOO_MANY_REQUESTS, CAPACITY_THROTTLING, SESSION_ACQUISITION_*)

**Channel 3: Node State Injection (pre-GTS errors)**
For errors that occur during catalog resolution / DAG construction — BEFORE Spark is involved. These errors cause the node to be marked as faulted and **never submitted to GTS**.

FLT's `Node` model has `IsFaulted`, `FLTErrorCode`, `ErrorMessage` (internal setters). During catalog resolution, `CatalogHandler` sets these when a source entity is missing/inaccessible. Then `DagExecutionHandlerV2:338` detects faulted nodes and throws `MLV_DAG_HAS_FAULTED_NODES`.

Injection: After DAG construction but before the faulted-node check, use reflection to set the target node's `IsFaulted = true`, `FLTErrorCode = ErrorCode.MLV_xxx`, `ErrorMessage = "..."`. FLT's own execution handler then reacts exactly as it would to a real catalog failure.

This is precise per-node: Node A (targeting `bronze.orders`) gets faulted, Node B (targeting `bronze.customers` in the same lakehouse) proceeds normally.

Hook point: `EdogDagExecutionHook` or a new thin interceptor between DAG build and the `sortedNodes.Where(n => n.IsFaulted)` check at `DagExecutionHandlerV2:338`.

**Covers: ~21 CATALOG_RESOLVE + DAG_CONSTRUCTION codes** (ACCESS_DENIED, SOURCE_ENTITY_NOT_FOUND, LAKEHOUSE_SOURCE_NOT_FOUND, CIRCULAR_DEPENDENCY, etc.)

**Channel 4: Exception Injection (transport-level)**
For timeout/connection errors that manifest as .NET exceptions rather than HTTP responses.
Throw `TaskCanceledException` or `HttpRequestException` from the pipeline handler.
Scoped via AsyncLocal.
**Covers: 2 codes** (SPARK_SESSION_ACQUISITION_TIMEOUT, INGEST_CONNECTION_TIMEOUT)

### 3.5 Coverage Summary

| Channel | Phase | Codes | Mechanism | Scoping |
|---------|-------|-------|-----------|---------|
| 1: GTS Status Forge | NODE_EXECUTION, INGEST, PySpark | ~52 | HTTP 200 + error JSON body | AsyncLocal |
| 2: GTS Submit Forge | GTS_SUBMIT | 6 | HTTP status code (429/430/500) | AsyncLocal |
| 3: Node State Injection | CATALOG_RESOLVE, DAG_CONSTRUCTION | ~21 | Set `node.IsFaulted` + error code | Per-node (direct) |
| 4: Exception Injection | GTS_SUBMIT, INGEST | 2 | Throw TaskCanceledException | AsyncLocal |

**Total: ~81 unique error codes across 115 enum members (after dedup of FMLV_/FLT_ prefixes). 100% coverage. Every code injected through its REAL code path.**

FLT retries transient errors (429, 430, 500) with exponential backoff. If a rule fires once and the retry succeeds, the user never sees the failure.

**MVP default: fail ALL attempts for the target node.** The rule stays active until the node reaches a terminal state (Completed/Failed/Cancelled). This guarantees the user sees the error. Future iteration can add "fail N of M attempts" for partial-failure testing.

### 3.6 Fault Rule Runtime State

`EdogHttpFaultStore` uses `FrozenDictionary` for lock-free reads. Mutable firing state (enabled/disabled, fire count) is stored separately:

```csharp
// Immutable rule definition (in FrozenDictionary)
internal sealed class HttpFaultEntry { ... } // unchanged

// Mutable runtime state (separate ConcurrentDictionary)
internal sealed class FaultRuleState {
    public volatile bool Enabled;
    public int FireCount; // Interlocked.Increment
}
static ConcurrentDictionary<string, FaultRuleState> _ruleStates = new();
```

Matching: check immutable rule for URL/node match, then atomically check `_ruleStates[ruleId].Enabled` before firing.

### 3.4 Blast Radius Computation

After execution, the engine builds a blast radius report by correlating:
- The injected fault event (from `EdogHttpPipelineHandler`)
- The node state change events (from `EdogDagExecutionInterceptor`)
- Downstream node impacts (from DAG topology)
- Error propagation path (from error code mapping metadata)

---

## 4. Error Code Catalog

### 4.1 Categories

| Category | Phase | Count | Examples |
|----------|-------|-------|----------|
| Execution | POST_GTS | 6 | SPARK_SESSION_ACQUISITION_FAILED, TRANSFORM_EXECUTION_NOT_FOUND |
| Throttling & Capacity | POST_GTS | 3 | TOO_MANY_REQUESTS, SPARK_JOB_CAPACITY_THROTTLING |
| Auth & Access | PRE_GTS | 4 | ACCESS_DENIED, UNAUTHORIZED_ACCESS, ENVIRONMENT_ACCESS_DENIED |
| Resource / Not Found | PRE_GTS | 8 | MV_NOT_FOUND, ARTIFACT_NOT_FOUND, LAKEHOUSE_SOURCE_NOT_FOUND |
| Validation & Schema | PRE_GTS | 10 | INVALID_FORMAT, SCHEMA_MISMATCH, CONSTRAINT_VIOLATION |
| DAG Construction | PRE_GTS | 5 | CIRCULAR_DEPENDENCY, LINEAGE_CREATION_FAILURE |
| Write & Concurrency | POST_GTS | 4 | CONCURRENT_REFRESH, REFRESH_CONFLICT, RESOURCE_LOCKED |
| Ingest | POST_GTS | 10 | INGEST_PATH_NOT_FOUND, INGEST_SCHEMA_DRIFT_REJECTED |
| System | POST_GTS | 4 | SYSTEM_ERROR, INTERNAL_SERVER_ERROR, UNCLASSIFIED_SYSTEM_ERROR |

### 4.2 Prefix Normalization

FLT uses three prefixes for the same error: `FMLV_`, `MLV_`, `FLT_`. The catalog normalizes to `MLV_` (the canonical form) and matches all three prefixes internally.

### 4.2.1 Node-Kind Filtering

The error picker only shows codes valid for the selected node's kind (`node.Kind` — `"sql"`, `"pyspark"`, or `"ingest"`):

| Code Group | sql | pyspark | ingest |
|------------|-----|---------|--------|
| GTS submit (TOO_MANY_REQUESTS, etc.) | Yes | Yes | Yes |
| General execution (SYSTEM_ERROR, UNKNOWN_ERROR, etc.) | Yes | Yes | Yes |
| Catalog/auth (ACCESS_DENIED, ARTIFACT_NOT_FOUND, etc.) | Yes | Yes | Yes |
| Constraint/DQ (CONSTRAINT_VIOLATION, DQ_CHECK_FAILED, etc.) | Yes | Yes | — |
| Schema/drift (SCHEMA_MISMATCH, TABLE_PROPERTIES_MISMATCH, etc.) | Yes | Yes | — |
| Write/concurrency (CONCURRENT_REFRESH, WRITE_FAILED, etc.) | Yes | Yes | Yes |
| PySpark-specific (PYSPARK_*, INVALID_SYNTAX_PYSPARK, etc.) | — | Yes | — |
| SQL-specific (NOT_A_SQL_MLV) | Yes | — | — |
| Ingest-specific (INGEST_*) | — | — | Yes |
| DAG construction (CIRCULAR_DEPENDENCY, LINEAGE_*, etc.) | DAG-level | DAG-level | DAG-level |

Codes tagged `DAG-level` apply to the whole DAG, not individual nodes — these are shown when the user targets the DAG itself rather than a specific node.

### 4.3 Full Error Code Phase Classification

**CATALOG_RESOLVE (15 codes) — Channel 3: Catalog/API HTTP Forge**

| Error Code | HTTP | Target Endpoint |
|------------|------|-----------------|
| MLV_ACCESS_DENIED | 403 | Fabric Catalog API |
| MLV_UNAUTHORIZED_ACCESS | 401 | Fabric Catalog API |
| MLV_ENVIRONMENT_ACCESS_DENIED | 403 | Environment API |
| MLV_CATALOG_ACCESS_DENIED | 403 | OneLake Catalog |
| MLV_CATALOG_AUTHENTICATION_FAILED | 401 | OneLake Catalog |
| MLV_ARTIFACT_NOT_FOUND | 404 | Fabric Catalog API |
| MLV_LAKEHOUSE_SOURCE_NOT_FOUND | 404 | Artifact Metadata API |
| MLV_NOTEBOOK_SOURCE_NOT_FOUND | 404 | Notebook API |
| MLV_SOURCE_ENTITY_NOT_FOUND | 404 | Catalog entity resolve |
| MLV_SELECTED_NOT_FOUND | 422 | Catalog MLV selection |
| MLV_ENTITY_NOT_FOUND | 404 | Catalog entity lookup |
| MLV_DATA_CORRUPTED | 500 | Catalog data read |
| MLV_CROSS_WORKSPACE_NOT_SUPPORTED | 422 | Cross-workspace resolve |
| MLV_ARTIFACT_REFERENCE_UNAVAILABLE | 404 | Artifact reference lookup |
| MLV_STALE_METADATA | 409 | Catalog metadata |

**DAG_CONSTRUCTION (8 codes) — Channel 3: Catalog/API HTTP Forge**

| Error Code | HTTP | Target Endpoint |
|------------|------|-----------------|
| MLV_CIRCULAR_DEPENDENCY | 422 | DAG lineage build (notebook API) |
| MLV_LINEAGE_CREATION_FAILURE | 500 | Lineage creation endpoint |
| MLV_LINEAGE_CREATION_NOTEBOOK_EXCEPTION | 500 | Notebook API |
| MLV_LINEAGE_NOT_FOUND | 404 | OneLake lineage path |
| MLV_INVALID_FORMAT | 422 | Node validation (catalog) |
| MLV_MAGIC_COMMAND_NOT_SUPPORTED | 422 | Notebook parse |
| MLV_MULTIPLE_DEFINITION_CONFLICT_SINGLE_CELL | 422 | Notebook parse |
| MLV_NB_ETAG_CHANGED | 409 | Notebook API (ETag) |

**PRE_EXECUTION_VALIDATION (10 codes) — Channel 3 + Channel 1**

| Error Code | Channel | HTTP | Notes |
|------------|---------|------|-------|
| MLV_SETTINGS_FORMAT_ERROR | 3 | 422 | Settings API |
| MLV_SETTINGS_RETRIEVAL_ERROR | 3 | 500 | Settings API |
| MLV_DAG_HAS_FAULTED_NODES | 1 | 200+error | Prior execution left faulted nodes |
| MLV_FABRIC_RUNTIME_VERSION_INCOMPATIBLE | 3 | 422 | Runtime check |
| MLV_NOT_SUPPORTED | 3 | 422 | Feature gate |
| MLV_OPERATION_NOT_SUPPORTED | 3 | 422 | Operation gate |
| MLV_NOTEBOOK_CONTEXT_REQUIRED | 3 | 422 | Notebook context check |
| MLV_SOURCE_ENTRY_FUNCTION_REFERENCE_NOT_FOUND | 3 | 404 | Notebook ref |
| MLV_CONSTRAINT_UDF_NOT_SUPPORTED | 1 | 200+error | Constraint validation |
| MLV_INVALID | 3 | 422 | Validation fallback |

**GTS_SUBMIT (6 codes) — Channel 2: GTS Submit HTTP Forge**

| Error Code | HTTP | Notes |
|------------|------|-------|
| MLV_TOO_MANY_REQUESTS | 429 | Rate limiting |
| MLV_SPARK_JOB_CAPACITY_THROTTLING | 430 | Capacity throttling |
| MLV_SPARK_SESSION_ACQUISITION_FAILED | 500 | Session creation failure |
| MLV_SPARK_SESSION_REQUEST_SUBMISSION_FAILED | 400 | Submit rejected |
| MLV_SPARK_SESSION_ACQUISITION_TIMEOUT | timeout | TaskCanceledException |
| MLV_KNOWN_USER_ERROR | 400+body | User error passthrough |

**NODE_EXECUTION (30+ codes) — Channel 1: GTS Status Response Forge (HTTP 200 + error body)**

| Error Code | ErrorSource | Category |
|------------|-------------|----------|
| MLV_CONCURRENT_REFRESH | User | write conflict |
| MLV_REFRESH_WRITE_FAILED | System | write failure |
| MLV_REFRESH_CONFLICT | User | concurrency |
| MLV_REFRESH_SOURCE_ENTITIES_UNDEFINED | User | config |
| MLV_REFRESH_SOURCE_ENTITIES_CORRUPTED | System | data corruption |
| MLV_REFRESH_DEFAULT_DB_UNDEFINED | User | config |
| MLV_REFRESH_VIEW_TEXT_NOT_FOUND | System | definition |
| MLV_SOURCE_ENTITIES_MISSING | User | missing data |
| MLV_SOURCE_DB_MISSING | User | missing data |
| MLV_MV_NOT_FOUND | User | not found |
| MLV_NOT_FOUND | User | not found |
| MLV_QUERY_NOT_FOUND | System | definition |
| MLV_SCHEMA_NOT_FOUND | System | schema |
| MLV_SOURCE_ENTITY_CORRUPTED | System | data corruption |
| MLV_INVALID_OBJECT_TYPE | System | type mismatch |
| MLV_NOT_A_TABLE | User | type mismatch |
| MLV_CONSTRAINT_VIOLATION | User | DQ |
| MLV_CONSTRAINT_NON_BOOLEAN | User | DQ |
| MLV_CONSTRAINT_NOT_BOOLEAN | User | DQ |
| MLV_CONSTRAINT_NON_DETERMINISTIC | User | DQ |
| MLV_CONSTRAINT_SCHEMA_VIOLATION | User | DQ |
| MLV_CONSTRAINT_MISMATCH | User | DQ |
| MLV_SCHEMA_MISMATCH | System | schema drift |
| MLV_SOURCE_ENTITY_MISMATCH | System | source drift |
| MLV_TABLE_PROPERTIES_MISMATCH | System | properties drift |
| MLV_PARTITION_MISMATCH | System | partition drift |
| MLV_CATALOG_WRITE_FAILED | System | persistence |
| MLV_COLUMN_DQ_CHECK_FAILED | User | DQ |
| MLV_UNCLASSIFIED_SYSTEM_ERROR | System | fallback |
| MLV_UNKNOWN_ERROR | System | fallback |
| MLV_ERROR_CODE_NOT_FOUND | System | fallback |
| MLV_RUNTIME_ERROR | System | execution |
| MLV_SYSTEM_ERROR | System | system |
| MLV_INTERNAL_SERVER_ERROR | System | system |
| MLV_ALREADY_EXISTS | User | conflict |
| MLV_SAVEASTABLE_NOT_ALLOWED | User | constraint |

**POST_EXECUTION (6 codes) — Channel 1 + Channel 3**

| Error Code | Channel | Notes |
|------------|---------|-------|
| MLV_TERMINAL_STATE | 3 | Cancel on already-terminal |
| MLV_REFRESH_PENDING | 3 | Cancel before execution start |
| MLV_OPERATION_INPROGRESS | 3 | Duplicate iteration |
| MLV_RESOURCE_LOCKED | 3 | Lock contention |
| MLV_EXEC_DEFN_NOT_FOUND | 3 | Execution definition 404 |
| MLV_EXEC_DEFN_EXISTS | 3 | Execution definition 409 |

**INGEST (12 codes) — Channel 1: GTS Status Response Forge**

| Error Code | ErrorSource | Category |
|------------|-------------|----------|
| MLV_INGEST_PATH_NOT_FOUND | User | source path |
| MLV_INGEST_UNABLE_TO_INFER_SCHEMA | User | schema |
| MLV_INGEST_SCHEMA_DRIFT_REJECTED | User | schema drift |
| MLV_INGEST_INCOMPATIBLE_TYPE | User | type mismatch |
| MLV_INGEST_CORRUPT_RECORDS | User | data quality |
| MLV_INGEST_DELTA_WRITE_FAILED | System | write failure |
| MLV_INGEST_AUTH_FAILURE | User | auth |
| MLV_INGEST_CONNECTION_TIMEOUT | System | network |
| MLV_INGEST_INTERNAL_ERROR | System | internal |
| MLV_INGEST_UNSUPPORTED_FORMAT | User | format |
| MLV_INGEST_MISSING_REQUIRED_OPTION | User | config |
| MLV_INGEST_EXTERNAL_MODIFICATION | System | drift |

**PySpark-Specific (10 codes) — Channel 1: GTS Status Response Forge**

| Error Code | ErrorSource | Category |
|------------|-------------|----------|
| MLV_PYSPARK_REFRESH_SOURCE_ENTITIES_MISMATCH | User | source drift |
| MLV_PYSPARK_REFRESH_SCHEMA_MISMATCH | User | schema drift |
| MLV_PYSPARK_REFRESH_DQ_MISMATCH | User | DQ |
| MLV_PYSPARK_CREATION_NOT_FROM_NOTEBOOK | User | context |
| MLV_NOT_A_PYSPARK_MLV | User | type |
| MLV_NOT_A_SQL_MLV | User | type |
| MLV_PYSPARK_MISSING_SOURCE_ENTRY_FUNCTION | System | config |
| MLV_PYSPARK_MISSING_SOURCE_NOTEBOOK_ID | System | config |
| MLV_PYSPARK_MISSING_SOURCE_WORKSPACE_ID | System | config |
| MLV_CONSTRAINT_MISMATCH_PYSPARK | User | DQ |
| MLV_SCHEMA_MISMATCH_PYSPARK | User | schema |
| MLV_SOURCE_ENTITY_MISMATCH_PYSPARK | User | source drift |

**Misc (2 codes)**

| Error Code | Channel | Notes |
|------------|---------|-------|
| MLV_CANCEL_TIMEOUT | 1 | Cancellation timeout |
| DAG_EXECUTION_SKIPPED | 1 | Iteration already in progress |

**TOTAL: ~97 error codes, ALL injectable via HTTP forging.**

---

## 5. UI Design

### 5.1 Design Principles

Aligned with the EDOG Studio design bible:
- **Purple accent** (`--accent: #6d5cff`) for primary actions
- **Status colors**: `--status-failed` (#e5453b) for error states
- **Calm density** — information-rich without clutter
- **No emoji** — Unicode symbols only (⚡ for injection, ● for severity)
- **`--text-sm` (12px)** for error code entries, `--text-base` (13px) for descriptions
- **`--radius-md` (6px)** for cards, `--radius-full` (100px) for severity badges
- **Transitions**: `--transition-normal` (150ms ease-out) for panel animations

### 5.2 Node Context Menu

New entry in the existing DAG node context menu:

```
⚡ Simulate Error...          (new, below existing items)
```

- Icon: inline SVG lightning bolt in `--status-failed` color
- Separator line above this item to visually group it
- Disabled state: when DAG is currently executing

### 5.3 Error Code Picker (Modal)

Modal overlay, 520px wide, max-height 600px:

**Header**: "Simulate Error on `{nodeName}`" in `--text-lg` (15px), bold
**Search**: Full-width input with magnifying glass icon, filters by code name + description
**Category groups**: Collapsible `<details>` elements, first relevant category expanded by default
**Error entries**: Cards within each category group:
  - Left: `●` severity dot (user=amber, system=red, transient=blue)
  - Code name in `font-family: var(--font-mono)`, `--text-sm`
  - Description in `--text-muted`, `--text-xs`
  - Right: phase badge ("PRE_GTS" / "POST_GTS") in muted pill
  - Hover: `--accent-hover` background
  - Selected: `--accent-dim` background, `--accent` left border

**Footer**: Cancel (ghost button) + "Simulate ⚡" (primary button, `--accent` bg)

### 5.4 Active Injections Panel

Collapsible section below the DAG graph in DAG Studio:

- **Header**: "Active Error Injections" + count badge + collapse toggle
- **Table**: Node | Error Code | Severity | [Remove] button
- **Footer**: "Clear All" (ghost) + "Run DAG with Faults ▸" (primary)
- The existing "Run Refresh" button in the control panel also works — active injections fire during any DAG execution
- **Empty state**: "No error injections configured. Right-click a node to add one."
- Section hidden entirely when empty (no visual noise)

### 5.5 DAG Node Badges

When a node has an active injection:
- Small ⚡ badge in `--status-failed` color, positioned top-right of node rectangle
- Subtle pulse animation (CSS `@keyframes pulse-badge`) — attention-grabbing but not annoying
- Tooltip on hover: "MLV_TOO_MANY_REQUESTS will be injected"

### 5.6 Blast Radius Panel (Post-Execution Drawer)

Slide-in drawer from the right, 440px wide:

**Sections:**
1. **Injection Summary** — which error, which node, timestamp
2. **Injection Point** — HTTP method + URL + status code injected
3. **FLT Code Path** — the exact code path that handled this error (static metadata from mapping table)
4. **Retry Behavior** — configured retries, actual attempts, backoff strategy
5. **Downstream Impact** — list of downstream nodes affected (SKIPPED, with dependency chain)
6. **User-Facing Message** — what the Fabric Portal would show to the end user

Each section uses `<dl>` key-value layout with `--text-sm` labels and `--text-base` values.

---

## 6. SignalR Protocol

### 6.1 New Hub Methods

Added to `EdogPlaygroundHub`:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `ErrorSimAddRule` | Client → Server | Add an error injection rule for a node |
| `ErrorSimRemoveRule` | Client → Server | Remove a specific rule |
| `ErrorSimClearAll` | Client → Server | Remove all injection rules |
| `ErrorSimGetCatalog` | Client → Server | Fetch the full error code catalog |
| `ErrorSimGetActiveRules` | Client → Server | Get current active injection rules |

### 6.2 New Push Events

Published to the `chaos` topic:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `errorSim.ruleAdded` | Server → Client | Confirms rule was added |
| `errorSim.ruleFired` | Server → Client | An injection rule fired during execution |
| `errorSim.blastRadius` | Server → Client | Post-execution blast radius report |
| `errorSim.ruleExpired` | Server → Client | Rule auto-disabled after maxFirings |

---

## 7. Backend Components

### 7.1 New Files

| File | Purpose |
|------|---------|
| `EdogErrorCodeCatalog.cs` | Static error code registry — all 115 enum members with phase, channel, errorSource, description, injection recipe |
| `EdogErrorSimEngine.cs` | Injection orchestrator — manages rule lifecycle, coordinates Channels 1-4, blast radius computation |
| `EdogNodeExecutionContext.cs` | AsyncLocal context set during node execution — carries nodeId/nodeName for HTTP fault scoping |

### 7.2 New Patches (edog.py)

| Patch | Target | Purpose |
|-------|--------|---------|
| `patch_node_executor_wrapper` | `DagExecutionHandlerV2.cs:1013` | Wrap `new NodeExecutor(...)` with `EdogNodeExecutorWrapper` to enable AsyncLocal per-node context |
| `patch_error_sim_hook` | `DagExecutionHandlerV2.cs:~220` | After DAG saved, call `EdogErrorSimEngine.ApplyPreGtsFaults(dag)` to set `node.IsFaulted` for Channel 3. Must fire before faulted-node check at line 338 |

### 7.3 Modified Files

| File | Change |
|------|--------|
| `EdogHttpFaultStore.cs` | Add `NodeId` field to `HttpFaultEntry`; add `ConcurrentDictionary<string, FaultRuleState>` for mutable state; enhance `TryMatchFault` to check AsyncLocal node context |
| `EdogHttpPipelineHandler.cs` | Read `EdogNodeExecutionContext.Current` during fault matching; pass nodeId to `TryMatchFault` |
| `EdogDagExecutionInterceptor.cs` | Wire up `EdogNodeExecutorWrapper` — add AsyncLocal set/clear in `ExecuteNodeAsync` |
| `EdogPlaygroundHub.cs` | Add `ErrorSim*` hub methods |
| `edog.py` | Add two new patches + revert functions |

### 7.3 Frontend Files

| File | Purpose |
|------|---------|
| `js/error-sim.js` | Error simulator module — picker, rules panel, blast radius drawer |
| `css/error-sim.css` | All error simulator styles |
| `js/dag-studio.js` | Modified — add context menu entry, node badges, rules panel integration |

---

## 8. Testing Strategy

| Test | Type | Asserts |
|------|------|---------|
| Error code catalog completeness | Python structural | Every `ErrorCode` enum member has a catalog entry |
| HTTP mapping accuracy | Python unit | Each mapping produces the correct HTTP status + body pattern |
| Fault store maxFirings | C# harness | Rule fires exactly N times then auto-disables |
| Node-scoped activation | C# harness | Rule only fires during target node's execution window |
| Blast radius computation | Python unit | Downstream impact correctly computed from DAG topology |
| Frontend picker render | Build test | All categories render, search filters work |
| End-to-end injection | Integration | Configure injection → run DAG → verify node fails with correct error code |

---

## 9. Success Criteria

An FLT engineer opens DAG Studio and within **30 seconds**:
1. Right-clicks a node → "Simulate Error"
2. Picks `MLV_TOO_MANY_REQUESTS` from the categorized list
3. Clicks "Run DAG with Faults"
4. Sees the node fail with the 429 error
5. Opens the blast radius panel → sees the full error propagation chain
6. Removes the injection → reruns → back to normal

---

## 10. What's NOT in MVP

- Chaos DSL / scripting
- Recording & playback
- Pre-built scenario recipes (OneLake outage, etc.) — future iteration
- Response body mutation (JSONPath editing)
- Probability-based injection (fire 30% of the time)
- Duration-based rules (active for 5 minutes)
- Multiple errors on the same node simultaneously
- Partial-failure testing ("fail N of M attempts") — MVP fails all attempts
- Waterfall timeline visualization of injected requests
