# F29 Capacity X-Ray — P0 Foundation Research

> **Agent:** Sana (architecture) — backend data inventory.
> **Scope:** Ground every claim about *what data we can see* for the tenant-level Capacity X-Ray page. UI design is out of scope; this gates whether the feature is buildable.
> **Conclusion (TL;DR):** The Disconnected (tenant-wide) half of F29 is unblocked — `/capacities/listandgethealthbyrollouts` + `/capacities/{id}/workspaces` + `/capacities/{id}/metrics` cover health, throttle %, SKU, and workspace assignment. The Connected (per-DAG CU attribution) half requires one new interceptor — **`EdogConsumptionInterceptor`** wrapping `IWorkloadResourceMetricsReporter` — because FLT's own code never calls `ReportConsumptionAsync` directly; the platform pipeline does it via the `MonitoredCodeMarkers` + capacity-context plumbing already documented below. Per-operation CU-seconds at workspace/DAG/node granularity are **not present in any current EDOG topic**.

---

## §1 — External API Data Inventory

All paths below were probed in the **PPE / FabricFMLV08PPE** tenant on 2026-04-09. Host is `https://biazure-int-edog-redirect.analysis-df.windows.net` unless noted. Auth is **PBI Bearer + admin headers** (`x-powerbi-user-admin: true`, `x-powerbi-hostenv: Power BI Web App`) per `docs/fabric-api-reference.md:598-606`.

### §1.1 Tested capacity endpoints

| # | Endpoint | Method | Auth | Status | Response shape | Tenant-page use | Refresh strategy |
|---|----------|--------|------|--------|---------------|-----------------|------------------|
| 1 | `/capacities/listandgethealthbyrollouts` | GET | PBI + admin hdrs | ✅ 200 (`capacity-mgmt-api-results.json:3-7`) | `{ capacitiesMetadata[], rolloutErrors[], capacitiesHealth[] }` — 46 entries in PPE (10 real + 36 SKU templates). See `capacity-health-response.json:1051-1110` for live `capacitiesHealth` payload and `:2-39` for `capacitiesMetadata`. | **Master roll-up.** Powers the capacity list, SKU column, region column, throttle % bars, `*Risk` flags. | Poll every 60 s (Fabric portal cadence). 1 call covers all capacities; do not call per-id. |
| 2 | `/capacities/{capId}` | GET | PBI + admin hdrs | ✅ 200 (`capacity-mgmt-api-results.json:33-37`) | `{ metadata, access, copilotAccess, isCopilotAllowed }` | Capacity detail drawer — admins list (with UPNs), copilot eligibility. | On row-expand only. Static; refresh on view. |
| 3 | `/capacities/{capId}/workspaces` | GET | PBI + admin hdrs | ✅ 200 (`capacity-mgmt-api-results.json:51-55`) | `[{ workspaceObjectId, workspaceDisplayName, workspaceType }]` | Per-capacity workspace list. Join key into `/v1.0/myorg/groups` and FLT topic events. | Cache 5 min; refresh on row-expand. |
| 4 | `/capacities/{capId}/metrics` | GET | PBI + admin hdrs | ✅ 200 (`capacity-mgmt-api-results.json:93-96`) | `{ metrics, data }` — shape TBD (need full payload capture). | Historical utilization sparkline (last N hours). | Poll on row-expand; 5 min cache. |
| 5 | `/capacities/new` | POST | PBI + admin hdrs | ✅ (curl-tested) | Returns created capacity | **Not on tenant page (admin action — out of scope for F29).** | n/a |
| 6 | `/capacities/{capId}` | DELETE | PBI + admin hdrs | ✅ 204 | empty | **Not on tenant page.** | n/a |
| 7 | `/metadata/trialcapacities` | GET | PBI | ✅ 200 (`capacity-mgmt-api-results.json:9-13`) | `[{ capacityId, capacityObjectId, trialExpirationDateTime, provisionState, sku }]` | Trial-expiration warning banner. | Same as #1. |
| 8 | `/v1.0/myorg/capacities` | GET | PBI | ✅ 200 (`fabric-api-reference.md:703`) | `{ value: [{ id, displayName, admins, sku, state, region, users }] }` | Cross-check for `users` array (per-capacity contributors). | Same as #1. |
| 9 | `/v1.0/myorg/admin/capacities` | GET | PBI | ✅ 200 (`capacity-mgmt-api-results.json:128-132`) | Admin view of all capacities. | Fallback if non-admin tokens are ever used. | Same as #1. |
| 10 | `/v1.0/myorg/capacities/{id}/Workloads` | GET | PBI | ✅ 200 (`fabric-api-reference.md:704`) | **64 workload configurations per capacity** | Per-workload enable/disable + memory caps → enables a "workload mix" panel. | Cache 15 min. |
| 11 | `/v1.0/myorg/capacities/{id}/Refreshables` | GET | PBI | ✅ 200 (`fabric-api-reference.md:705`) | Refreshable items + throttle data | Refresh-throttle hot list. | 5 min. |
| 12 | `/v1.0/myorg/groups` | GET | PBI | ✅ 200 (`fabric-api-reference.md:42`) | `{ value: [{ id, name, type, capacityId, isOnDedicatedCapacity }] }` | Authoritative workspace → capacity map. **Primary join key** for connecting tenant view to FLT events. | 5 min. |

### §1.2 Confirmed-failing endpoints (do NOT call from F29)

From `capacity-mgmt-api-results.json:38-181` — every probe that returned 404/405/401:

`/capacities/{id}/settings` 404, `/capacities/{id}/workloads` 404, `/capacities/{id}/delegates` 404, `/capacities/{id}/users` 404, `/capacities/{id}/state` 404, `/capacities/{id}/notifications` 404, `/capacities/{id}/refresh` 404, `/capacities/{id}/health` 404 (only via #1), `/capacities/{id}/admins` 405, rename via `PATCH /capacities/{id}` 404, resize/suspend/resume 404, `/v1.0/myorg/capacities/{id}` 404, license-eligibility 401, modern-commerce-admin 401.

→ All capacity mutations except `POST /capacities/new` and `DELETE /capacities/{capId}` are unreachable via this gateway. Resize / suspend / settings are **not available** for F29.

### §1.3 Untested but documented (NEED probe before relying)

| Endpoint | Source | Risk |
|----------|--------|------|
| `/v1/admin/capacities/{capId}/refreshables/top` | Power BI Admin REST docs | Likely Fabric-audience-only. Probe first. |
| `Microsoft.Fabric.CapacityMetrics` semantic model `executeQueries` DAX endpoint | `capacity-research.md:120+` | **Officially unsupported** by Microsoft (`capacity-research.md:10-13`). Do not depend on it for the tenant-level overview; document it only as an optional "deep history" drill-down behind a feature flag. |

### §1.4 Health payload — the gold field set

From `capacity-health-response.json:1052-1066` (one real capacity, real numbers):

```json
{
  "timestamp": "2026-04-09T11:21:48.6404689Z",
  "capacityObjectId": "75CF4409-0CD0-4885-A014-092F45430194",
  "backgroundUtilization": 0.163472222222222,
  "interactiveUtilization": 0.0,
  "previewInteractiveUtilization": 0.0,
  "previewBackgroundUtilization": 0.0,
  "cumulativeCarryForward": 0.0,
  "interactiveDelayThrottlingPercentage": 0.0,
  "interactiveRejectionThrottlingPercentage": 0.0,
  "backgroundRejectionThrottlingPercentage": 0.0,
  "interactiveDelayRisk": false,
  "interactiveRejectionRisk": false,
  "backgroundRejectionRisk": false
}
```

Live PPE values include real throttle activity (`capacity-health-response.json:1070-1080`): `backgroundUtilization: 24850.14` and 1.29% `interactiveDelayThrottlingPercentage` — so the API really does surface throttle pressure for active capacities.

**Semantic mapping to `capacity-research.md:667-672`:**
- `interactiveDelayThrottlingPercentage` ↔ `interactiveDelayThresholdPercentage` (10-min window).
- `interactiveRejectionThrottlingPercentage` ↔ `interactiveRejectionThresholdPercentage` (60-min window).
- `backgroundRejectionThrottlingPercentage` ↔ `backgroundRejectionThresholdPercentage` (24-hr window).
- `cumulativeCarryForward` ↔ `overageTotalCapacityUnitMs` (current carryforward balance).

These four fields are everything F29 needs for the per-capacity throttle bars and state badges.

### §1.5 Metadata payload — SKU + admins

From `capacity-health-response.json:2-39`:
- `state` enum (1 = Active, 3 = something inactive — `capacity-research.md` System Events §1.2 names them Active/Overloaded/Suspended/Deleted).
- `license.{capacityPlan, capacityNumberOfVCores, capacityMemoryInGB, region}` — SKU profile.
- `configuration.{displayName, sku, skuScale, mode, region}`.
- `admins[]` — UPN + objectId.
- `creationDate`, `cesClusterUrl`, `resourceGroup`, `subscriptionId`.

The 19-SKU catalog (P1–P5, F2–F8192, FTL64) is enumerated in `fabric-api-reference.md:677-697`.

---

## §2 — Internal Interceptor Data Inventory (what's already inside the FLT process)

The topic registry is `EdogTopicRouter.Initialize()` at `src\backend\DevMode\EdogTopicRouter.cs:26-45`. Below is every topic whose payload carries a field that is needed for capacity attribution.

| Topic | Producer | Event shape (exact fields) | Capacity relevance | Join keys |
|-------|----------|----------------------------|--------------------|-----------|
| `capacity` (cap 500) | **NONE WIRED** — registered placeholder (`EdogTopicRouter.cs:39`). | n/a | This is the target topic for the new `EdogConsumptionInterceptor` proposed in §4. | n/a |
| `dag` (cap 500) | `EdogDagExecutionInterceptor.cs:92-107` (DagTerminal); `:166-204` (NodeStarted/NodeCompleted/NodeFailed) | DagTerminal: `{ event, dagId, iterationId, status, totalNodes, completedNodes, failedNodes, skippedNodes, parallelLimit, durationMs, errorCode, errorMessage, errorSource }`. Node events: `{ event, nodeId, dagId, iterationId, durationMs?, errorType?, errorMessage? }`. | Wall-clock and node-count baseline. Required to compute "CU per DAG run" and per-node attribution once §4 lands. | `iterationId` (Guid), `dagId` (string). |
| `perf` (cap 5000) | `EdogPerfMarkerCallback.cs:59-67` | `{ operationName, durationMs, reliabilityMetric, result, dimensions{}, correlationId }`. `dimensions` is the full `IOrderedDictionary` from `MonitoredScope` — includes `TenantObjectId`, `CapacityObjectId`, `UserId`, `OperationType`, `IterationId` (see `LiveTableServiceMonitoringCallback.cs:38-49` for the exact keys the platform writes). | **Already carries `CapacityObjectId` and `TenantObjectId` on every code-marker completion.** Every `RunDAG`, `MVRefresh`, controller API call (see §3.1) ends up here. Closest analogue to per-operation CU we have today — but it carries `durationMs`, not CU-seconds. | `correlationId`; `dimensions.IterationId`; `dimensions.CapacityObjectId`. |
| `spark` (cap 2000) | `EdogSparkSessionInterceptor.cs:88-102` (Created/Error); `EdogSparkClientWrapper.cs` (SessionPropertiesSet, transform submit, poll, terminal, cancel, dispose) | Created: `{ sessionTrackingId, event, tenantId, workspaceId, artifactId, iterationId, workspaceName, artifactName, durationMs, error }` | Spark sessions are the dominant CU consumer for FLT. Pairing a `Created`+terminal pair with the §4 ConsumptionEvent tells us CU-per-Spark-session. | `iterationId` (string GUID), `sessionTrackingId` (`edog-spark-N`). |
| `http` (cap 2000) | `EdogHttpPipelineHandler.cs:46-153` | `{ method, url, statusCode, durationMs, requestHeaders, responseHeaders, requestBodyPreview, responseBodyPreview, requestSizeBytes, responseSizeBytes, httpClientName, correlationId, chaos? }` | Throttle responses are visible here (HTTP 429/430 on GTS or maintenance calls). Used by Nexus to count `ThrottleCount` (`EdogNexusAggregator.cs:54`). Bytes transferred ≈ rough OneLake CU proxy. | `correlationId` (`x-ms-correlation-id`/`x-ms-request-id`/Request-Id — `EdogHttpPipelineHandler.cs:332-348`). |
| `retry` (cap 500) | `EdogRetryInterceptor.cs` — log-parses Polly retries | `{ attempt, total?, delaySeconds, artifactId, iterationId, nodeName, ... }` | Throttle-induced retries are an early throttle signal even before `*Risk` flips. | `iterationId`, node name. |
| `nexus` (cap 100) | `EdogNexusAggregator.cs` | Per-edge rolling stats: `TotalRequests, ErrorCount, RetryCount, ThrottleCount, P50/P95 latency, BaselineErrorRate, recent correlationIds` | Already aggregates per-dependency throttle counts. Reuse for the "throttle hot dependencies" sub-panel. | dependency ID. |
| `flt-ops` (cap 300) | refresh triggers, MLV defs, maintenance | refresh requests, schedule changes | Maps refresh events → DAG iterations (`refreshId → iterationId`). | `iterationId`. |
| `catalog` (cap 200) | catalog discovery start/complete/fail | n/a for CU attribution directly | Low priority for F29. | — |
| `telemetry` (cap 5000) | `EdogTelemetryInterceptor.cs:52-130` | `TelemetryEvent { operationStartTime, activityName, activityStatus, durationMs, resultCode, correlationId, attributes{CustomerTenantId, CustomerCapacityObjectId, ClusterName, ...}, executingUserObjectId, IterationId }` | **`CustomerCapacityObjectId` is pulled from `ExecutionContext` and stamped onto every SSR event** (`EdogTelemetryInterceptor.cs:80-81`). This is our primary "what tenant / what capacity is this FLT instance serving" signal in Connected mode. | `IterationId`, `correlationId`, `CustomerCapacityObjectId`. |
| `di` (cap 100) | `EdogDiRegistryCapture.cs:43-100` | `{ serviceType, implementation, lifestyle, registrationPhase, isEdogIntercepted }` | Confirms `ICustomLiveTableTelemetryReporter` is intercepted (`:97`) and `IWorkloadResourceMetricsReporter` is *listed* as intercepted (`:157`) but **no wrapper class is mapped** at `:165-175` — i.e. the flag is aspirational. §4 fills this gap. | — |
| `log` (cap 10000) | log interceptor | log entries with `rootActivityId` mapped → `iterationId` | Fallback for parsing throttle/Capacity errors that don't surface elsewhere. | `rootActivityId`. |
| `token` (cap 1000) | token wrapper | token issuance/cache | MWC token target capacity is captured here (the `CapacityObjectId` claim). | — |
| `cache` (cap 2000) | cache interceptors | hit/miss for SqlEndpointMetadataCache, SparkClientFactory | Spark session reuse rate → indirect CU savings indicator. | — |
| `flag` (cap 1000) | feature flighter wrapper | flag evaluations | Used to filter "what's enabled for this capacity". | — |
| `qa` (cap 2000) | QA scenarios | n/a | Out of scope. | — |
| `fileop` (cap 2000) | file ops | OneLake R/W bytes | Approximate OneLake-CU proxy. | — |

### §2.1 What is *guaranteed* available today (Connected mode)

For every DAG run we can reconstruct, with zero new interceptors:

- **Identity:** `tenantId`, `capacityObjectId`, `workspaceId`, `artifactId (lakehouseId)`, `iterationId` — from `spark.Created` + `telemetry.attributes` + `perf.dimensions`.
- **Lifecycle timestamps + durations:** `dag.DagTerminal`, `dag.NodeStarted/Completed/Failed`, `perf` for every controller and code marker, `spark` for every transform.
- **Throttle indicators:** `http` (429/430), `retry`, `nexus.ThrottleCount`.

What we **cannot** compute today: **CU-seconds**. FLT's own code never produces a number in CU units; that conversion happens in the platform layer (`IWorkloadResourceMetricsReporter` consumer). Hence §4.

---

## §3 — FLT Capacity SDK Inventory

### §3.1 `IWorkloadResourceMetricsReporter` — the billing interface

Source of ground truth: `WorkloadResourceMetricsReporterStub.cs:20-126`. All types live in `Trident.SharedContracts.{Capacity.Consumption, DataModel.Consumption, External.Consumption}` (`:11-13`) and `Microsoft.MWC.Workload.Client.Library.Utils`.

| # | Method (signature simplified) | Params | Where called in FLT | Notes |
|---|-------------------------------|--------|--------------------|-------|
| 1 | `Task ReportConsumptionAsync(ConsumptionEvent ev, CancellationToken)` | `ConsumptionEvent` (capacity-id + workspace + artifact + operation + CU-seconds — opaque struct) | **NOT called from FLT source** (`grep ReportConsumptionAsync` across `Service/`: zero hits other than the stub). Called by the MWC platform pipeline that wraps controllers decorated with `[InitializeCapacityContext]` (`InitializeCapacityContextAttribute.cs:18-27`) and `[ServiceOperationsMonitoring]` code markers (`MonitoredCodeMarkers.cs` — `ReportConsumptionApi` at `:146/157`, `ReportStaticStorageConsumptionApi` at `:164/174`, plus every API marker). The stub comment at `:42, :48, :54, :60, :66, :72, :78` ("Only expect to use the ConsumptionEvent overload") confirms `ReportConsumptionAsync` is the canonical entry point. | **Primary intercept target.** |
| 2 | `Task ReportResourceMetricPerArtifactAsync(string capacityId, string tenantId, string workspaceId, ArtifactKind, string artifactId, string artifactName, MetricName, long value, MetricUnit, CT)` | scalar metric (e.g., row count, file size) per artifact | Not used by FLT (stub throws `NotImplementedException`). | Skip. |
| 3..6 | `void/Task ReportResourceMetrics(...)` overloads with `(tenantId, status, workspaceId, ArtifactKind, artifactId, artifactName, identity, operationName, UtilizationType, operationStartTimeUtc, cpuTimeMs, durationMs[, throttlingDelayMs][, IReadOnlyCollection<WorkloadOperationMetric>])` | Per-operation utilization metrics — `cpuTimeMs`, `durationMs`, optional `throttlingDelayMs` | Not used by FLT (stub throws). | Skip. |
| 7,8 | `Task ReportResourceMetricsAsync(string capacityId, string tenantId, status, workspaceId, ArtifactKind, artifactId, artifactName, identity, operationName, UtilizationType, operationStartTimeUtc, cpuTimeMs, durationMs[, throttlingDelayMs], CT, metrics?)` | Same as 3–6 with explicit capacityId | Not used by FLT (stub throws). | Skip. |
| 9 | `Task ReportStorageConsumptionAsync(WorkspaceConsumptionEvent ev, CT)` | Workspace-grain storage CU | Likely called by storage code paths — grep returns 0 in FLT source, but the stub stores them in `StaticStorageConsumptionEvents` (`:30, :87-92`) → at least one platform pipeline invokes it. | Secondary intercept target (low priority for F29 v1). |
| 10 | `Task ReportExternalConsumptionAsync(ExternalConsumptionEvent ev, CT)` | External compute CU | Not used by FLT (stub throws). | Skip. |
| 11 | `Task ReportExternalStorageConsumptionAsync(ExternalConsumptionEvent ev, CT)` | External storage CU | Not used by FLT (stub throws). | Skip. |
| 12 | `bool IsConsumptionOperationRegistered(ConsumptionOperationType, string operationName)` | Validates op-type/name pair against platform registry | Not used directly | Skip. |

**Net:** Only methods #1 (`ReportConsumptionAsync`) and possibly #9 (`ReportStorageConsumptionAsync`) carry useful signal for F29. Everything else is dead code in FLT's path.

### §3.2 Capacity-context plumbing (how FLT knows *which* capacity it is serving)

- **`CustomerCapacityAsyncLocalContext`** — set per-request by `InitializeCapacityContextAttribute.OnActionExecutionAsync` (`InitializeCapacityContextAttribute.cs:22-26`) and also explicitly by `LiveTableHttpRequestInfoProvider.GetRejectedRequestDetailsAsync` at `LiveTableHttpRequestInfoProvider.cs:44-70`.
- Read inside DAG execution at:
  - `DagExecutionHandlerV2.cs:790` — `CustomerCapacityAsyncLocalContext.Value?.CustomerCapacityObjectId`.
  - `DagExecutionHandlerV2.cs:1274` — `var capacityContext = CustomerCapacityAsyncLocalContext.Value;` (gates feature flighter check).
  - `DagExecutionHandlerV2.cs:1351` — pulls `TenantId` for file-sourced node execution.
- Also stamped onto every SSR telemetry event via `ExecutionContext.GetProperty("CustomerCapacityObjectId")` (`CustomLiveTableTelemetryReporter.cs:63` and mirrored in `EdogTelemetryInterceptor.cs:80-81`).

### §3.3 Throttling / utilization classification

- `LiveTableHttpRequestInfoProvider.GetRequestDetailsAsync` returns `UtilizationType.Background` for **every** FLT request (`LiveTableHttpRequestInfoProvider.cs:32-33`). This means *all* FLT consumption is classified as **Background** (24-hr smoothing window, per `capacity-research.md:559`). The X-Ray page should label all FLT-attributed CU as background — this is structurally true, not a per-DAG choice.
- Rejected-request details (when capacity is throttling) populate `WorkloadRejectedRequestDetails` (`:39-70`) — includes `OperationName = "LiveTable Usage API"`, `ArtifactKind`, `ArtifactId`, `WorkspaceId`, and `Identity` (UPN). A 429/430 with this payload tells us *exactly* which artifact got rejected — visible today on the `http` topic.

### §3.4 Code markers (operation taxonomy)

Top-level markers that produce `perf` events with `OperationName`:
- `LiveTableSchedulerRunController.RunDAG` — `CodeMarkers.cs:96-97`, name = `"LiveTableSchedulerRunController-RunDAG"` (`CodeMarkers.cs:89`).
- `LiveTableSchedulerRunController.MVRefresh` — `CodeMarkers.cs:101-102`. Wraps each node execution (`NodeExecutor.cs:93`).
- `LiveTableSchedulerRunController.CancelDAG` — `CodeMarkers.cs:91`.
- `LiveTableSchedulerRunController.GetDAGExecStatus` — `:106`.
- Controllers: `RetrieveDataApi`, `ReportConsumptionApi`, `EvictMonikerApi`, `EmitAuditEventApi`, `TIPSAcquireApi`/`Delete`/`GetResourceDetails`/`GetResourcebyResourceID`/`UpdateResourceMetadatabyUID`, `PublicAadProtectedGenerateMwcTokenApi`, `ExportArtifactToXlsxAPI`, `PublicApiCreateFloor`/`GetFloors`/`GetFloor`, plus all Ping APIs — `MonitoredCodeMarkers.cs:21-345`.
- `OperationType` enum (`OperationType.cs:10-47`): Lakehouse=0, SparkJobDefinition=1, Partner=2, Platform=3, Admin=4, DataArtifact=5, LivyProxy=6. FLT requests will mostly be `Platform` or `DataArtifact`.

---

## §4 — The Missing Interceptor: `EdogConsumptionInterceptor`

### §4.1 Why it must exist

Per §3.1, FLT itself never calls `ReportConsumptionAsync` — the MWC platform middleware does, *after* the controller action finishes, using the `ConsumptionEvent` constructed from the capacity context + code marker dimensions. **The reporter instance is registered in DI** (the stub class implements `Microsoft.MWC.Workload.Client.Library.IWorkloadResourceMetricsReporter`, `WorkloadResourceMetricsReporterStub.cs:14, 20`). `EdogDiRegistryCapture.cs:157` already lists it as intercepted, but `GetEdogWrapperName` at `:165-175` has no mapping — i.e. **the slot is reserved, the wrapper is not yet written**. This is interceptor #12.

### §4.2 What it wraps

```
ISparkClientFactory             → EdogSparkSessionInterceptor             (ADR-005 late DI)
ICustomLiveTableTelemetryReporter → EdogTelemetryInterceptor              (ADR-005 late DI)
IFeatureFlighter                → EdogFeatureFlighterWrapper              (ADR-005 late DI)
ISqlEndpointMetadataCache       → EdogCacheInterceptor                    (ADR-005 late DI)
IWorkloadResourceMetricsReporter → EdogConsumptionInterceptor  ← NEW      (ADR-005 late DI)
```

Same DI re-registration pattern (`RunAsync` phase override) used by `EdogTelemetryInterceptor` (`EdogDiRegistryCapture.cs:97`).

### §4.3 What it captures

Wrap **method #1** (`ReportConsumptionAsync`) and **method #9** (`ReportStorageConsumptionAsync`). Forward to inner first (preserve billing), then publish to `capacity` topic. Never throw — same swallow-and-log pattern as every other interceptor (`EdogPerfMarkerCallback.cs:45-48, 71-75`).

The opaque `ConsumptionEvent` and `WorkspaceConsumptionEvent` types from `Trident.SharedContracts` are not visible to us at compile time outside the workload assembly, but we can either (a) take a `dynamic` or (b) reference the contracts assembly already pulled in by FLT. Reflect all public-readable properties; serialize via `System.Text.Json` with a property-name whitelist (avoid `ToString()` since the platform types may contain claim/PII data).

### §4.4 Event shape on `capacity` topic

```jsonc
// event = "ConsumptionReported"
{
  "event": "ConsumptionReported",
  "capacityObjectId": "75CF4409-...",       // from ev.CapacityObjectId
  "tenantId": "...",                         // ev.TenantId
  "workspaceId": "...",                      // ev.WorkspaceId
  "artifactKind": "Lakehouse",              // ev.ArtifactKind
  "artifactId": "...",                       // ev.ArtifactId
  "artifactName": "...",
  "operationType": "Background",            // UtilizationType — always Background for FLT (§3.3)
  "operationName": "LiveTableSchedulerRunController-RunDAG",  // matches perf.operationName
  "operationStartTimeUtc": "2026-...",
  "cpuTimeMs": 12345,                       // raw CPU time
  "durationMs": 67890,                      // wall clock
  "consumedCapacityUnitMs": 9876.5,         // ← the gold metric (CU-ms; ÷1000 for CU-seconds)
  "throttlingDelayMs": 0,
  "identityUpn": "user@tenant",             // ev.Identity.Claims.Upn — may be null for system flows
  "correlationId": "...",                    // ev.CorrelationId or RootActivityId
  "iterationId": "..."                       // parsed from operationMetrics or correlationId (same logic as EdogTelemetryInterceptor.cs:106-120)
}
```

Field names that are not present on the contract get omitted rather than null-valued, matching the convention in `EdogHttpPipelineHandler.cs:200-241`.

A second event variant for storage:

```jsonc
// event = "StorageConsumptionReported"
{
  "event": "StorageConsumptionReported",
  "capacityObjectId": "...",
  "tenantId": "...",
  "workspaceId": "...",
  "storageType": "OneLake",
  "billableStorageBytes": 12345678,
  "currentStorageBytes": 12345678,
  "deletionStatus": "Active",
  "timestampUtc": "..."
}
```

### §4.5 Topic sizing

Current `capacity` cap is **500** (`EdogTopicRouter.cs:39`). A busy capacity emits 1 ConsumptionEvent per controller action ≈ tens per second under load. Raise to **2000** to give the studio ~5–10 minutes of headroom before the ring overwrites — matching `spark` (`:31`). Single-line edit; safe.

### §4.6 Correlation strategy

Identical to `EdogTelemetryInterceptor.cs:106-120`:
1. If the `ConsumptionEvent` carries an `IterationId` (or an `OperationMetrics` dimension named `IterationId`), use it.
2. Else if `CorrelationId` ends in a GUID, scrape the trailing GUID — same `GuidSuffixRegex` already used.
3. Else fall back to `correlationId` only.

This guarantees every `ConsumptionReported` event can join to **`dag.DagTerminal`** and **`spark.Created`** by `iterationId`.

### §4.7 Registration

Mirror the late-DI pattern from edog.py used for `ICustomLiveTableTelemetryReporter`:

```csharp
// In WorkloadApp.RunAsync after platform init (the spot patched by edog.py):
var innerConsumption = WireUp.Resolve<IWorkloadResourceMetricsReporter>();
WireUp.RegisterInstance<IWorkloadResourceMetricsReporter>(
    new EdogConsumptionInterceptor(innerConsumption));
EdogDiRegistryCapture: add "EdogConsumptionInterceptor" mapping in GetEdogWrapperName at line ~172.
```

### §4.8 Safety properties

- Non-throwing: try/catch around publish (every other interceptor).
- Pass-through: forward to inner first, capture timing with a `Stopwatch`, then publish — same shape as `EdogSparkSessionInterceptor.cs:53-114`.
- Zero allocations on the hot path beyond the anonymous event object.
- PII handling: `Identity.Claims.Upn` is captured because Admins already see UPNs in the capacity admin list (§1.5); but redact `Claims.ApplicationId` if it ever appears — match the `[redacted]` convention from `EdogHttpPipelineHandler.cs:280-282`.

---

## §5 — Correlation Map

Every join key needed to wire the F29 page end-to-end. **All keys are GUIDs unless noted.**

| Data point | Source | Join key(s) | Joins with |
|------------|--------|-------------|------------|
| Capacity row (health + SKU) | `/capacities/listandgethealthbyrollouts` | `capacityObjectId` | (a) `/v1.0/myorg/groups[].capacityId` for workspaces; (b) FLT events via `CustomerCapacityObjectId` from `EdogTelemetryInterceptor`; (c) F29 `capacity.ConsumptionReported.capacityObjectId`. |
| Workspaces in capacity | `/capacities/{capId}/workspaces` | `workspaceObjectId` | `/v1.0/myorg/groups[].id`; `spark.Created.workspaceId`; `dag` events via lakehouse → workspace lookup; `capacity.ConsumptionReported.workspaceId`. |
| Artifact (lakehouse) → workspace | `spark.Created` payload (`EdogSparkSessionInterceptor.cs:88-101`) | `(workspaceId, artifactId)` | `dag.DagTerminal.iterationId`; `/v1/workspaces/{wsId}/lakehouses`. |
| DAG run | `dag.DagTerminal` (`EdogDagExecutionInterceptor.cs:92-107`) | `iterationId` | `spark.Created.iterationId`; `perf.dimensions.IterationId`; `telemetry.IterationId`; `capacity.ConsumptionReported.iterationId`. |
| Node | `dag.NodeStarted/Completed/Failed` (`:166-204`) | `(iterationId, nodeId)` | `perf` events with matching `MVRefresh` code marker + `IterationId` dim. |
| Spark session | `spark.Created` | `sessionTrackingId` (`edog-spark-N`) + `iterationId` | All `spark.*` events for the session; cache events from `EdogSparkSessionInterceptor.cs:106-111`. |
| HTTP call | `http` topic | `correlationId` (`x-ms-correlation-id`, etc. — `EdogHttpPipelineHandler.cs:334-339`) | `perf.correlationId`; `retry`-event correlation; throttle 429/430 attribution. |
| Throttle event | `http.statusCode in {429,430}` + `nexus.ThrottleCount` | `correlationId` → `iterationId` (via perf/telemetry) | `/capacities/{capId}/health.*ThrottlingPercentage` (tenant level); `capacity.ConsumptionReported.throttlingDelayMs` (operation level). |
| CU consumption | **`capacity.ConsumptionReported`** (new §4) | `iterationId`, `correlationId`, `workspaceId`, `artifactId`, `capacityObjectId` | Closes the loop: tenant-level throttle % ↔ workspace ↔ DAG ↔ node ↔ Spark session ↔ HTTP call. |
| Per-tenant filter | `EdogTelemetryInterceptor.attributes.CustomerTenantId` | `tenantId` | Every event the FLT process emits is for *one* tenant; useful for sanity check that we never join to a different tenant's capacity row. |

### §5.1 The full chain (Connected mode)

```
/capacities/listandgethealthbyrollouts              capacityObjectId, throttle %, SKU
        │
        │  (capacityObjectId)
        ▼
/capacities/{capId}/workspaces                      workspaceObjectId list
        │
        │  (workspaceId)
        ▼
EdogConsumptionInterceptor → capacity.ConsumptionReported  (workspaceId, artifactId, iterationId, CU-ms, durationMs)
        │
        │  (iterationId)
        ▼
dag.DagTerminal + dag.NodeStarted/Completed         dagId, node counts, durations
        │
        │  (iterationId)
        ▼
spark.Created + spark.Transform* events             sessionTrackingId, workspace, artifact
        │
        │  (correlationId)
        ▼
http events                                          per-call latency, 429/430 throttle hits
        │
        │  (correlationId)
        ▼
perf events                                          code marker durations, full dimensions
        │
        │  (correlationId / nodeId)
        ▼
retry + nexus aggregates                             throttle/retry hot spots
```

Every arrow has a verified join key from a real file:line reference above.

### §5.2 The full chain (Disconnected mode)

```
/v1.0/myorg/groups              ws → capacityId map
/capacities/listandgethealthbyrollouts  capacities with health + SKU + admins
/v1.0/myorg/capacities/{id}/Workloads   workload-mix
/capacities/{capId}/workspaces  workspaces per cap
/capacities/{capId}/metrics     historical utilization
/metadata/trialcapacities       trial-expiration warnings
```

Disconnected mode delivers the tenant-wide page **without any FLT process running** — important because F29 must work in pre-Connected (Disconnected) phase per ADR-001.

---

## §6 — Gaps & Risks

### §6.1 Hard gaps (must be resolved before P1 design)

1. **No CU data in any topic today.** `capacity` topic is registered but has zero producers (`EdogTopicRouter.cs:39` comment: *"Reserved for future capacity-tracking feature (no producer wired yet)"*). §4 is the entire mitigation.
2. **`/capacities/{capId}/metrics` payload shape is unknown.** Tested as 200 OK with keys `metrics`, `data` (`capacity-mgmt-api-results.json:93-96`), but we have no captured body. Need to probe with one capacity and persist the full payload before designing the historical-sparkline panel.
3. **`ConsumptionEvent` property surface is opaque.** `Trident.SharedContracts.Capacity.Consumption.ConsumptionEvent` is not in our source tree. We must (a) reference the assembly from `Microsoft.MWC.Workload.Client.Library` *or* (b) reflect at runtime. Spike required before §4 implementation.
4. **`IWorkloadResourceMetricsReporter` may be resolved through an interface chain the late-DI pattern doesn't cover.** `EdogDiRegistryCapture.cs:157` lists it as "intercepted" but no wrapper class exists. Need to confirm the registration site in `WorkloadApp.cs` (or the platform Library) and whether `WireUp.RegisterInstance` after `RunAsync` actually replaces the live instance — Spike. Risk: if FLT resolves it before our patch runs, we get the unwrapped reporter and never see CU.

### §6.2 Soft gaps (probe before promising the UI)

5. **Admin permission requirement.** All §1.1 capacity endpoints need `x-powerbi-user-admin: true` (`fabric-api-reference.md:603`). EDOG's PBI bearer must be acquired by an account with capacity-admin (Admin1CBA in PPE). If a developer runs EDOG with a non-admin token, the entire Disconnected tenant page will 401. Mitigation: detect admin scope at startup; show a graceful "non-admin: limited data" mode.
6. **Smoothing means timestamps lie.** Per `capacity-research.md:912`, background CU appears in timepoints up to **24 hours after** the operation ran. Our `Smoothing start` / `Smoothing end` fields are not present in `/capacities/listandgethealthbyrollouts`. We need them from the Capacity Metrics App semantic model (officially unsupported) or from `ConsumptionEvent.OperationStartTime` directly. Decision needed: do we display "instantaneous utilization" (#1 health endpoint) only, or also "smoothed history" (semantic model)?
7. **Capacity Metrics semantic model is unsupported.** `capacity-research.md:10-13` — Microsoft explicitly says don't depend on it. If we use `executeQueries` against it, the feature is one schema change away from breaking. Recommendation: don't use it for v1; revisit only if the `/metrics` endpoint (#4) proves insufficient.
8. **Trial-capacity expiration banner risk.** `/metadata/trialcapacities` returns `trialExpirationDateTime` — if the trial is expired, the entire FLT process may be unavailable. F29 should surface this before users wonder why nothing works.
9. **Mode field semantics unconfirmed.** `configuration.mode = 1` (`capacity-health-response.json:18`) — meaning is undocumented in our notes. Likely 1 = Premium-Per-Capacity, 0 = Trial; need to verify against a Trial cap in PPE.

### §6.3 Test requirements (P0 exit criteria)

- [ ] Probe `/capacities/{capId}/metrics` and persist the full JSON in `docs/capacity-metrics-response.json`.
- [ ] Reflect `ConsumptionEvent` properties in a one-off test harness (load `Trident.SharedContracts` from the workload's bin output, list public properties via `Type.GetProperties()`, persist the schema).
- [ ] Confirm late-DI swap of `IWorkloadResourceMetricsReporter` actually takes effect (set a breakpoint after `RunAsync` and check `WireUp.Resolve<IWorkloadResourceMetricsReporter>()` returns our wrapper).
- [ ] Run one DAG end-to-end and confirm `capacity.ConsumptionReported` fires with non-zero `consumedCapacityUnitMs`.
- [ ] Verify `iterationId` correlation across `dag` ↔ `capacity` ↔ `spark` ↔ `perf` for the same run.

### §6.4 Out of scope for F29 (do not promise these in v1)

- Capacity resize / pause / resume (404 in §1.2).
- Per-user CU attribution beyond what `Identity.Claims.Upn` already gives us.
- Cross-tenant rollups (we are a single-tenant tool by design).
- 30-day historical CU (would require Metrics App semantic model — see §6.2 #7).
- Storage-CU at table grain (only workspace-grain is surfaced by `ReportStorageConsumptionAsync`).

---

## Sign-off

- Disconnected half: **ready to build** on §1 endpoints (already tested).
- Connected half: **gated on §4 spike + §6.1 gaps 3 and 4**. Once `EdogConsumptionInterceptor` is proven to fire and the `ConsumptionEvent` schema is reflected, every claim above is mechanically wireable.
- Recommended next phase: **P1 = spike `EdogConsumptionInterceptor` and persist `/capacities/{capId}/metrics` payload** before any UI work begins.

— Sana
