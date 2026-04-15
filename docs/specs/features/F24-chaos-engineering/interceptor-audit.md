# Interceptor Audit — F24 Chaos Engineering Foundation

> **Author:** Vex (Backend Engineer)
> **Date:** 2025-07-21
> **Status:** COMPLETE — P0.1 + P0.2
> **Scope:** Every EDOG interceptor + every FLT outbound HTTP call

---

## Section 1: EDOG Interceptors

### 1.1 EdogHttpPipelineHandler

- **File:** `src/backend/DevMode/EdogHttpPipelineHandler.cs`
- **Class:** `EdogHttpPipelineHandler : DelegatingHandler`
- **Wraps:** Every `HttpClient` created via `IHttpClientFactory`. Injected as a DelegatingHandler in the pipeline chain.
- **Registered via:** `EdogHttpClientFactoryWrapper.CreateClient()` — inserted into every named HttpClient pipeline. Chain: `EdogTokenInterceptor → EdogHttpPipelineHandler → original handler pipeline`. The factory wrapper is registered by `EdogDevModeRegistrar.EnsureHttpClientFactoryWrapped()` which replaces `IHttpClientFactory` in WireUp DI.
- **Captures:**
  - `method` — HTTP method (GET, PUT, POST, DELETE)
  - `url` — Full URL with SAS tokens redacted (`sig=`, `se=`, `st=`, `sp=`, `spr=`, `sv=`, `sr=`, `sdd=` → `[redacted]`)
  - `statusCode` — HTTP response status code
  - `durationMs` — Round-trip latency via `Stopwatch`
  - `requestHeaders` — All request headers (Authorization → `[redacted]`)
  - `responseHeaders` — All response headers (no redaction)
  - `responseBodyPreview` — First 4KB of text response bodies (skips binary, skips >10MB)
  - `httpClientName` — Named HttpClient identifier (e.g., `"OneLakeRestClient"`, `"DatalakeDirectoryClient"`)
  - `correlationId` — From `x-ms-correlation-id`, `x-ms-request-id`, `x-ms-client-request-id`, or `Request-Id` headers
- **Can modify:** **READ-ONLY**. Returns `response` unmodified (`return response`). Cannot alter request or response.
- **Topic:** `"http"` (buffer size: 2000)
- **Limitations for chaos panel:**
  - Cannot inject faults (latency, errors, dropped connections) — response is returned as-is
  - Cannot modify request headers or body before sending
  - Cannot block or delay requests
  - Cannot inject custom response bodies or status codes
  - No request body capture (only response body preview)
  - Body preview limited to 4KB — large JSON payloads truncated
  - Binary responses (Parquet, protobuf) return `null` body preview
  - No retry count tracking — each attempt looks like a fresh request

### 1.2 EdogTokenInterceptor

- **File:** `src/backend/DevMode/EdogTokenInterceptor.cs`
- **Class:** `EdogTokenInterceptor : DelegatingHandler`
- **Wraps:** Every `HttpClient` created via `IHttpClientFactory`. Sits before `EdogHttpPipelineHandler` in the handler chain.
- **Registered via:** Same as `EdogHttpPipelineHandler` — both injected by `EdogHttpClientFactoryWrapper`. Chain: `EdogTokenInterceptor → EdogHttpPipelineHandler → original`.
- **Captures:**
  - `tokenType` — Classified from scheme: `"Bearer"`, `"MwcToken"`, `"S2S"`, or raw scheme
  - `scheme` — Authorization header scheme
  - `audience` — JWT `aud` claim (string or first array element)
  - `expiryUtc` — JWT `exp` claim as ISO 8601 UTC string
  - `issuedUtc` — JWT `iat` claim as ISO 8601 UTC string
  - `httpClientName` — Named HttpClient identifier
  - `endpoint` — `PathAndQuery` of the request URI
- **SECURITY:** Raw token values are NEVER captured. Only JWT metadata (aud, exp, iat).
- **Can modify:** **READ-ONLY**. Calls `base.SendAsync()` first, then extracts metadata. Returns response unmodified.
- **Topic:** `"token"` (buffer size: 500)
- **Limitations for chaos panel:**
  - Cannot inject expired tokens or wrong audiences
  - Cannot simulate auth failures (401/403)
  - Cannot strip or replace Authorization headers
  - Only captures Bearer JWT metadata — MWC V1 tokens aren't JWT-decodable
  - S2S tokens in custom headers (e.g., `X-S2S-Authorization`) not captured unless they're in the standard `Authorization` header

### 1.3 EdogHttpClientFactoryWrapper

- **File:** `src/backend/DevMode/EdogTokenInterceptor.cs` (lines 168–234)
- **Class:** `EdogHttpClientFactoryWrapper : IHttpClientFactory`
- **Wraps:** `IHttpClientFactory` (the standard .NET factory)
- **Registered via:** `EdogDevModeRegistrar.EnsureHttpClientFactoryWrapped()` — replaces `IHttpClientFactory` in WireUp DI via `RegisterInstance`. Idempotent (guarded by `_httpClientFactoryWrapped` flag).
- **What it does:** For every `CreateClient(name)` call, extracts the inner handler from the original `HttpClient` via reflection (`HttpMessageInvoker._handler` FieldInfo), then builds a new chain: `EdogTokenInterceptor → EdogHttpPipelineHandler → original handler`. Preserves `BaseAddress` and `Timeout`.
- **Can modify:** It **replaces** the handler chain but preserves all client configuration. Falls back to original unwrapped client on failure.
- **Topic:** N/A — this is plumbing, not an event publisher
- **Limitations for chaos panel:**
  - Uses reflection (`s_handlerField`) to extract inner handler — brittle if .NET runtime changes field name
  - Cannot intercept HttpClients created outside `IHttpClientFactory` (e.g., `new HttpClient()` directly)
  - Cannot intercept HttpClients created by WCL SDK (`Get1PWorkloadHttpClientAsync`) since those bypass `IHttpClientFactory`

### 1.4 EdogFeatureFlighterWrapper

- **File:** `src/backend/DevMode/EdogFeatureFlighterWrapper.cs`
- **Class:** `EdogFeatureFlighterWrapper : IFeatureFlighter`
- **Wraps:** `IFeatureFlighter` — the FLT feature flag evaluation interface
- **Registered via:** `EdogDevModeRegistrar.RegisterFeatureFlighterWrapper()` — resolves current `IFeatureFlighter`, wraps it, re-registers via `WireUp.RegisterInstance`. Idempotent (checks `inner is EdogFeatureFlighterWrapper`).
- **Captures:**
  - `flagName` — Feature flag name string
  - `tenantId` — Nullable Guid
  - `capacityId` — Nullable Guid
  - `workspaceId` — Nullable Guid
  - `result` — Boolean evaluation result (true/false)
  - `durationMs` — Evaluation latency via `Stopwatch`
- **Can modify:** **READ-ONLY today**. Delegates to `_inner.IsEnabled()` and reports the result. However, because it wraps the interface, it **could** override the return value — this is the ideal injection point for chaos flag overrides.
- **Topic:** `"flag"` (buffer size: 1000)
- **Limitations for chaos panel:**
  - Currently read-only — no override mechanism
  - Only intercepts `IsEnabled(string, Guid?, Guid?, Guid?)` — if FLT adds new overloads, they won't be intercepted
  - No batched/bulk flag query support
  - No persistence of overrides between restarts

### 1.5 EdogPerfMarkerCallback

- **File:** `src/backend/DevMode/EdogPerfMarkerCallback.cs`
- **Class:** `EdogPerfMarkerCallback : IServiceMonitoringCallback`
- **Wraps:** `IServiceMonitoringCallback` — the ServicePlatform perf marker completion callback
- **Registered via:** `EdogDevModeRegistrar.RegisterPerfMarkerCallback()` — resolves current `IServiceMonitoringCallback`, wraps, re-registers. Idempotent.
- **Captures:**
  - `operationName` — From `ServiceMetricDimensions.OpName` dimension
  - `durationMs` — `durationMetricValue` parameter (long)
  - `result` — From `ServiceMetricDimensions.OpOutcome` dimension
  - `correlationId` — From `ServiceMetricDimensions.CorrelationIdDimension`
  - `dimensions` — All key-value pairs from `customDimensions` IOrderedDictionary
- **Can modify:** **READ-ONLY**. Chains to `_inner.CustomReportingAction()` first, then publishes.
- **Topic:** `"perf"` (buffer size: 5000)
- **Limitations for chaos panel:**
  - Cannot inject artificial latency into operations
  - Cannot modify perf marker dimensions
  - Only captures `CustomReportingAction` — other `IServiceMonitoringCallback` methods (if any) not intercepted

### 1.6 EdogSparkSessionInterceptor

- **File:** `src/backend/DevMode/EdogSparkSessionInterceptor.cs`
- **Class:** `EdogSparkSessionInterceptor : ISparkClientFactory`
- **Wraps:** `ISparkClientFactory` — the factory that creates per-iteration Spark clients
- **Registered via:** `EdogDevModeRegistrar.RegisterSparkSessionInterceptor()` — resolves current `ISparkClientFactory`, wraps, re-registers. Idempotent.
- **Captures:**
  - `sessionTrackingId` — EDOG-generated monotonic ID (`edog-spark-{N}`) since FLT has no native Spark session ID
  - `event` — `"Created"` or `"Error"`
  - `tenantId` — String
  - `workspaceId` — Guid as string
  - `artifactId` — Guid as string
  - `iterationId` — Guid as string
  - `workspaceName` — String
  - `artifactName` — String
  - `durationMs` — Factory call latency via `Stopwatch`
  - `error` — Exception message (on error) or null
- **Can modify:** **READ-ONLY**. Delegates to `_inner.CreateSparkClientAsync()`. On error, publishes event then re-throws.
- **Topic:** `"spark"` (buffer size: 200)
- **Limitations for chaos panel:**
  - Cannot inject Spark session creation failures
  - Cannot modify the returned `ISparkClient` — no decoration of the client itself
  - Individual HTTP calls made by `GTSBasedSparkClient` go through `Get1PWorkloadHttpClientAsync` (WCL SDK), which **bypasses** `IHttpClientFactory` — NOT captured by EdogHttpPipelineHandler
  - No tracking of Spark job submission/status/cancel operations after session creation
  - Cannot simulate slow Spark session creation

### 1.7 EdogLogInterceptor

- **File:** `src/backend/DevMode/EdogLogInterceptor.cs`
- **Class:** `EdogLogInterceptor : IStructuredTestLogger` (internal sealed)
- **Wraps:** `IStructuredTestLogger` — the ServicePlatform telemetry test logger interface
- **Registered via:** Registered directly by EdogLogServer (not via DevModeRegistrar DI). Passed to the telemetry infrastructure.
- **Captures:**
  - `timestamp` — `DateTime.UtcNow`
  - `level` — Normalized: `"Informational"`/`"Info"` → `"Message"`, others pass through
  - `message` — Full log message string
  - `component` — Extracted from `[BracketedTag]` in message or `MonitoredScope.CurrentCodeMarkerName`
  - `rootActivityId` — From `MonitoredScope.RootActivityId`
  - `eventId` — TestLogEvent EventId
  - `customData` — Dictionary of all custom KVPs from `testLogEvent.CustomData`
  - `iterationId` — Regex-extracted GUID from `[IterationId ...]` patterns in message
  - `codeMarkerName` — From `MonitoredScope.CurrentCodeMarkerName`
- **Can modify:** **READ-ONLY**. Creates `LogEntry` and forwards to `EdogLogServer.AddLog()`.
- **Topic:** `"log"` (buffer size: 10000) — published by EdogLogServer, not directly by this interceptor
- **Limitations for chaos panel:**
  - Cannot inject fake log entries into the FLT telemetry pipeline
  - Cannot suppress or filter logs at the interceptor level
  - Console output is synchronous — could cause jank under extreme log volume

### 1.8 EdogTelemetryInterceptor

- **File:** `src/backend/DevMode/EdogTelemetryInterceptor.cs`
- **Class:** `EdogTelemetryInterceptor : ICustomLiveTableTelemetryReporter` (internal sealed)
- **Wraps:** `ICustomLiveTableTelemetryReporter` — the FLT SSR (Standardized Server Reporting) telemetry interface
- **Registered via:** Registered in `RunAsync` callback (see `EdogDiRegistryCapture` phase "RunAsync"). Wraps the inner reporter, re-registers.
- **Captures:**
  - `operationStartTime` — DateTime
  - `activityName` — String
  - `activityStatus` — String (e.g., "Succeeded", "Failed")
  - `durationMs` — Long
  - `resultCode` — String (nullable)
  - `correlationId` — String or fallback from `MonitoredScope.RootActivityId`
  - `attributes` — Dictionary from `activityAttributes`
  - `executingUserObjectId` — Guid as string (`userId`)
  - `iterationId` — Regex-extracted from correlationId
- **Can modify:** **READ-ONLY**. Publishes event, then delegates to `_inner.EmitStandardizedServerReporting()`.
- **Topic:** `"telemetry"` (buffer size: 5000) — published by EdogLogServer
- **Limitations for chaos panel:**
  - Cannot inject fake telemetry events
  - Cannot modify SSR data before it reaches the real telemetry pipeline
  - Cannot simulate telemetry pipeline failures

### 1.9 EdogRetryInterceptor

- **File:** `src/backend/DevMode/EdogRetryInterceptor.cs`
- **Class:** `EdogRetryInterceptor` (public static)
- **Wraps:** Nothing directly. **Log-stream parser** — subscribes to the `"log"` topic and pattern-matches retry-related messages.
- **Registered via:** `EdogDevModeRegistrar.RegisterRetryInterceptor()` → `EdogRetryInterceptor.Start()`. Starts a background task that reads live events from the `"log"` topic buffer.
- **Why log-parsing:** `RetryPolicyProviderV2` is a concrete class with non-virtual methods returning complex Polly generic types. Direct decoration is impractical.
- **Captures (from regex parsing):**
  - `endpoint` — Extracted from `[Artifact:..., Node:...]` patterns
  - `statusCode` — Detected from message (429, 430)
  - `retryAttempt` — Current attempt number
  - `totalAttempts` — Max attempts (if stated)
  - `waitDurationMs` — Retry delay from message
  - `strategyName` — Classified: `"SparkTransformSubmitRetry"`, `"NodeExecutionRetry"`, `"NodeCancellationRetry"`, `"CdfEnablementRetry"`, `"NotebookContentRetry"`, `"StandardRetry"`
  - `reason` — Extracted error text
  - `isThrottle` — Boolean (429/430/TooManyRequests/Retry-After)
  - `retryAfterMs` — Server-requested delay
  - `iterationId` — From LogEntry or regex-extracted from node details
- **Can modify:** **READ-ONLY**. Purely observational.
- **Topic:** `"retry"` (buffer size: 500)
- **Limitations for chaos panel:**
  - Cannot inject retries — only observes them
  - Cannot modify retry policies (backoff, max attempts)
  - Pattern matching is regex-based — new log formats may not match
  - Cannot force a specific retry count or delay
  - Cannot disable retries to test failure paths

### 1.10 EdogCacheInterceptor

- **File:** `src/backend/DevMode/EdogCacheInterceptor.cs`
- **Class:** `EdogCacheInterceptor` (public static)
- **Wraps:** Nothing via DI. **Static utility** — provides `RecordCacheEvent()` and `GetOrResolve<T>()` helpers.
- **Registered via:** `EdogDevModeRegistrar.RegisterCacheInterceptor()` — just prints a ready message. No DI wrapping.
- **Captures (when called):**
  - `cacheName` — e.g., "TokenManager", "CatalogCache"
  - `operation` — "Get", "Set", "Evict", "GetOrResolve"
  - `key` — Cache key string
  - `hitOrMiss` — "Hit", "Miss", or null
  - `valueSizeBytes` — Approximate size (nullable long)
  - `ttlSeconds` — TTL (nullable int)
  - `durationMs` — Operation latency
  - `evictionReason` — String (nullable)
- **Can modify:** N/A — it's a reporting utility, not a wrapper.
- **Topic:** `"cache"` (buffer size: 2000)
- **Limitations for chaos panel:**
  - **Not actually wired to any FLT cache** — requires manual call-site instrumentation
  - `GetOrResolve<T>` has a bug: `factoryCalled` is never set to `true` (dead code path)
  - Cannot inject cache misses or evictions
  - Cannot poison cache entries
  - No automatic discovery of FLT cache operations

### 1.11 EdogFileSystemInterceptor (Factory + Wrapper)

- **File:** `src/backend/DevMode/EdogFileSystemInterceptor.cs`
- **Classes:** `EdogFileSystemFactoryWrapper : IFileSystemFactory` + `EdogFileSystemWrapper : IFileSystem`
- **Wraps:** `IFileSystemFactory` → wraps each created `IFileSystem` with `EdogFileSystemWrapper`
- **Registered via:** `EdogDevModeRegistrar.RegisterFileSystemInterceptor()` — resolves `IFileSystemFactory`, wraps, re-registers. Each `CreateFileSystem()` call returns a wrapped `IFileSystem`.
- **Captures (per operation, all 13 IFileSystem methods):**
  - `operation` — "Exists", "Read", "Write", "Delete", "List"
  - `path` — OneLake path string
  - `contentSizeBytes` — Byte count of content (or item count for List)
  - `durationMs` — Operation latency via `Stopwatch`
  - `hasContent` — Boolean
  - `contentPreview` — First 4KB of string content (null for binary/non-read ops)
  - `ttlSeconds` — Time-to-expire if specified
  - `iterationId` — `"{workspaceId:N}-{lakehouseId:N}"` from factory parameters
- **Methods intercepted:** `ExistsAsync`, `CreateDirIfNotExistsAsync`, `CreateOrUpdateFileAsync`, `ReadFileAsStringAsync`, `CreateEmptyFileIfNotExistsAsync`, `RenameFileAsync`, `DeleteFileIfExistsAsync`, `DeleteDirIfExistsAsync`, `ListAsync`, `ReadFileBytesAsync`, `ListWithContinuationAsync`, `GetDirMetadataAsync`, `GetFileMetadataAsync`
- **Can modify:** **READ-ONLY**. All methods delegate to `_inner` then publish events.
- **Topic:** `"fileop"` (buffer size: 2000)
- **Limitations for chaos panel:**
  - Cannot inject file system errors (RequestFailedException, 404s)
  - Cannot simulate slow OneLake operations
  - Cannot corrupt file content
  - Cannot simulate disk-full or permission-denied scenarios
  - Binary reads (`ReadFileBytesAsync`) have no content preview

### 1.12 EdogDiRegistryCapture

- **File:** `src/backend/DevMode/EdogDiRegistryCapture.cs`
- **Class:** `EdogDiRegistryCapture` (public static)
- **Wraps:** Nothing. **Static snapshot** of all known DI registrations.
- **Registered via:** `EdogDevModeRegistrar.RegisterDiRegistryCapture()` → `CaptureRegistrations()`. Called once at startup.
- **Captures (per registration):**
  - `serviceType` — Interface name (e.g., "IFeatureFlighter")
  - `implementationType` — Current implementation (original or EDOG wrapper)
  - `lifetime` — "Singleton", "Instance"
  - `isEdogIntercepted` — Boolean
  - `originalImplementation` — Original FLT implementation name
  - `registrationPhase` — "Constructor" or "RunAsync"
- **Hardcoded registrations:** ~47 services from WorkloadApp.cs constructor + 3 RunAsync registrations
- **Can modify:** N/A — snapshot only.
- **Topic:** `"di"` (buffer size: 100)
- **Limitations for chaos panel:**
  - Static list — must be manually updated when FLT adds new DI registrations
  - `IsEdogIntercepted` only checks 4 services (IFeatureFlighter, ISqlEndpointMetadataCache, ISparkClientFactory, ICustomLiveTableTelemetryReporter) — misses IFileSystemFactory, IServiceMonitoringCallback, IHttpClientFactory
  - No runtime enumeration of WireUp container (proprietary, no API)

### 1.13 Supporting Infrastructure

#### EdogTopicRouter
- **File:** `EdogTopicRouter.cs` — Static registry of 11 topic buffers
- **Topics:** `log` (10K), `telemetry` (5K), `fileop` (2K), `spark` (200), `token` (500), `cache` (2K), `http` (2K), `retry` (500), `flag` (1K), `di` (100), `perf` (5K)
- **Thread-safe:** `ConcurrentDictionary`, `Publish()` never throws

#### TopicBuffer / TopicEvent
- **Files:** `TopicBuffer.cs`, `TopicEvent.cs`
- **Ring buffer** + `Channel<TopicEvent>` for live streaming
- **TopicEvent envelope:** `SequenceId` (monotonic), `Timestamp`, `Topic`, `Data`

#### EdogPlaygroundHub
- **File:** `EdogPlaygroundHub.cs` — SignalR hub
- **Methods:** `Subscribe(topic)`, `Unsubscribe(topic)`, `SubscribeToTopic(topic)` (ChannelReader streaming)
- **Auto-subscribes** to `"log"` group on connect

#### EdogLogServer
- **File:** `EdogLogServer.cs` — Kestrel HTTP + SignalR server (port 5555)
- **REST APIs:** `/api/logs`, `/api/telemetry`, `/api/stats`, `/api/executions`, `/api/flt/config`, `/api/edog/health`
- **SignalR:** `/hub/playground`

#### EdogApiProxy
- **File:** `EdogApiProxy.cs` — Config + token server for Command Center frontend
- **Not an interceptor** — serves edog-config.json, MWC token, bearer token, health/git info

#### EdogAuthDiagnostic
- **File:** `EdogAuthDiagnostic.cs` — JWT diagnostic utility
- **Not an interceptor** — one-time startup diagnostic, reads workload-dev-mode.json

---

## Section 2: FLT HTTP Traffic Map

### 2.1 Named HttpClients (HttpClientNames.cs)

| Name | Purpose | Registered By |
|------|---------|---------------|
| `UnauthenticatedWithGeneralRetries` | General unauthenticated HTTP | `HttpClientFactoryRegistry` |
| `UnauthenticatedWithGeneralRetriesBypassSsl` | Test-only, bypass SSL | `HttpClientFactoryRegistry` |
| `DatalakeDirectoryClient` | DataLake SDK transport (OneLake file ops + catalog) | `HttpClientFactoryRegistry` |
| `OneLakeRestClient` | OneLake REST API (shortcut listing) | `HttpClientFactoryRegistry` |
| `FabricApiClient` | Fabric public API calls | `HttpClientFactoryRegistry` |
| `PbiSharedApiClient` | PBI/Fabric shared API calls | `HttpClientFactoryRegistry` |

All named clients go through `IHttpClientFactory.CreateClient()` → **INTERCEPTED** by `EdogHttpClientFactoryWrapper`.

Common handler pipeline: `SyncToAsyncBridgeHandler → RootActivityIdCorrelationHandler → FabricAccessContextHandler → OneLakeRequestTracingHandler`.

### 2.2 OneLake Calls

| Source | Method | URL Pattern | Auth | Request Body | Response | Error Handling | Intercepted? |
|--------|--------|-------------|------|-------------|----------|----------------|--------------|
| `OneLakeRestClient:ListDirsAsync` | GET | `https://{onelake-endpoint}/{workspaceId}?directory={path}&recursive={bool}&resource=filesystem&getShortcutMetadata={bool}` | Bearer (user token) + S2S header (`X-S2S-Authorization`) | None | `PathList` JSON (array of `PathObject` with `IsDirectory`, `IsShortcut`, `Name`) | Retry via `OneLakeRetryPolicyProvider`, exception for 401/403/404/429/500/503/408 | **Yes** — `EdogHttpPipelineHandler` via `OneLakeRestClient` named client |
| `OnelakeBasedFileSystem:*` (13 methods) | Various (DataLake SDK) | `https://{onelake-endpoint}/{workspaceId}/{lakehouseId}/{basePath}/...` | TokenCredential (FMVTokenCredential) + S2S header | Varies per operation (file content, metadata) | Varies (file content, path lists, metadata dicts) | Polly retry with exponential backoff, `RequestFailedException` handling | **Yes** — `EdogHttpPipelineHandler` via `DatalakeDirectoryClient` named client + `EdogFileSystemInterceptor` (13 methods) |
| `LakeHouseMetastoreClientWithShortcutSupport:*` (catalog ops) | Various (DataLake SDK) | `https://{onelake-endpoint}/{workspaceId}/{lakehouseId}/...` | TokenCredential + S2S header | Varies | Catalog metadata, delta logs | Various exception handling | **Yes** — `EdogHttpPipelineHandler` via `DatalakeDirectoryClient` named client |

### 2.3 Spark/GTS Calls

| Source | Method | URL Pattern | Auth | Request Body | Response | Error Handling | Intercepted? |
|--------|--------|-------------|------|-------------|----------|----------------|--------------|
| `GTSBasedSparkClient:SendTransformRequestAsync` | PUT | `{gtsBaseAddress}/v1/workspaces/{workspaceId}/artifacts/{artifactId}/customTransformExecution/{transformationId}` | MWC V1 token header + S2S header | Spark job request JSON (SQL, parameters, session properties) | `TransformExecutionSubmitResponse` | HttpRequestException/TaskCanceledException → retriable; other exceptions → not retriable | **NOT INTERCEPTED** — HttpClient from `Get1PWorkloadHttpClientAsync` bypasses IHttpClientFactory |
| `GTSBasedSparkClient:GetTransformStatusAsync` | GET | Same URL pattern as above | MWC V1 token + S2S | None | `TransformExecutionResponse` (state, error details) | Catch-all → Unknown state | **NOT INTERCEPTED** — same reason |
| `GTSBasedSparkClient:CancelTransformAsync` | DELETE | Same URL pattern as above | MWC V1 token + S2S | None | Status code checked (200=Cancelled, 404=Already gone, 429/5xx=retry) | Per-status handling | **NOT INTERCEPTED** — same reason |
| `GTSBasedSparkClient:InitAsync` | N/A (client creation) | WCL SDK `Get1PWorkloadHttpClientAsync` | WCL SDK managed | N/A | HttpClient with BaseAddress | N/A | **NOT INTERCEPTED** — WCL SDK internal |

### 2.4 Fabric API Calls

| Source | Method | URL Pattern | Auth | Request Body | Response | Error Handling | Intercepted? |
|--------|--------|-------------|------|-------------|----------|----------------|--------------|
| `FabricApiClient:GetLakehouseDetailsAsync` | GET | `https://{fabric-host}/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}` | Bearer (AAD token) + S2S header | None | `LakehouseDetails` JSON | 401→UnauthorizedAccessException, 404→InvalidOperationException, 400/500→InvalidOperationException | **Yes** — `EdogHttpPipelineHandler` via `PbiSharedApiClient` named client |
| `FabricApiClient:GetWorkspaceNameAsync` | GET | `https://{fabric-host}/v1/workspaces/{workspaceId}` | Bearer + S2S | None | Workspace JSON (displayName) | EnsureSuccessStatusCode | **Yes** — via `PbiSharedApiClient` |
| `FabricApiClient:ExistsSemanticModelAsync` | GET | `https://{fabric-host}/v1/workspaces/{workspaceId}/semanticModels/{id}` | Bearer + S2S | None | 200 = exists, 404 = not exists | Status code check | **Yes** — via `PbiSharedApiClient` |
| `FabricApiClient:ExistsReportAsync` | GET | `https://{fabric-host}/v1/workspaces/{workspaceId}/reports/{id}` | Bearer + S2S | None | 200 = exists, 404 = not exists | Status code check | **Yes** — via `PbiSharedApiClient` |
| `FabricApiClient:CreateSemanticModelAsync` | POST | `https://{fabric-host}/v1/workspaces/{workspaceId}/semanticModels` | Bearer + S2S | JSON semantic model definition | 201=Created (id) or 202=Accepted (operationLocation) | EnsureSuccessStatusCode | **Yes** — via `PbiSharedApiClient` |
| `FabricApiClient:CreateReportAsync` | POST | `https://{fabric-host}/v1/workspaces/{workspaceId}/reports` | Bearer + S2S | JSON report definition | 201=Created or 202=Accepted | EnsureSuccessStatusCode | **Yes** — via `PbiSharedApiClient` |
| `FabricApiClient:HandleLongRunningOperationAsync` | GET (polling) | `{operationLocation}` and `{operationLocation}/result` | Bearer + S2S | None | Operation status JSON (Succeeded/Failed), then result | Polling with Retry-After, 502/503/429→retry, timeout→TimeoutException | **Yes** — via `PbiSharedApiClient` |
| `FabricApiClient:RunTableMaintenanceAsync` | POST | `https://{fabric-host}/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/jobs/instances?jobType=TableMaintenance` | Bearer + S2S | Table maintenance JSON (executionData) | 202=Accepted (Location header with jobInstanceId) | 401/404/400/429→specific exceptions | **Yes** — via `PbiSharedApiClient` |

### 2.5 Notebook API Calls

| Source | Method | URL Pattern | Auth | Request Body | Response | Error Handling | Intercepted? |
|--------|--------|-------------|------|-------------|----------|----------------|--------------|
| `NotebookApiClient:GetNotebookContentAsync` | GET | `{notebookBaseAddress}/api/workspaces/{workspaceId}/artifacts/{notebookId}/content` | MWC V1 token header + `PbiPreserveAuthorizationHeader` | None | Notebook content string + ETag | 412→ETag mismatch, 404→Notebook not found, 429/430/5xx→retriable | **NOT INTERCEPTED** — HttpClient from `Get1PWorkloadHttpClientAsync` bypasses IHttpClientFactory |
| `NotebookApiClient:InitAsync` | N/A (client creation) | WCL SDK `Get1PWorkloadHttpClientAsync` | WCL SDK managed | N/A | HttpClient with BaseAddress | N/A | **NOT INTERCEPTED** — WCL SDK internal |

### 2.6 Orchestrator / Communication Calls

| Source | Method | URL Pattern | Auth | Request Body | Response | Error Handling | Intercepted? |
|--------|--------|-------------|------|-------------|----------|----------------|--------------|
| `LiveTableCommunicationClient:SendRequestWith1PappTokenAsync` | GET | `{targetRequestUri}` (variable, capacity-scoped) | 1P app token via WCL SDK | None | `HttpResponseMessage` (passed back to caller) | Logs status code, returns raw response | **NOT INTERCEPTED** — HttpClient from `Get1PWorkloadHttpClientAsync` bypasses IHttpClientFactory |

### 2.7 Token Acquisition Calls

| Source | Method | URL Pattern | Auth | Request Body | Response | Error Handling | Intercepted? |
|--------|--------|-------------|------|-------------|----------|----------------|--------------|
| `PBIHttpClientFactory:CreateWithOriginalAadTokenAsync` | N/A (client factory) | N/A | Bearer (AAD) + S2S | N/A | Configured HttpClient for Fabric API calls | ArgumentException on null token | **Yes** — the created HttpClient uses `PbiSharedApiClient` named client via IHttpClientFactory |
| `GTSBasedSparkClient:GenerateMWCV1TokenForGTSWorkloadAsync` | N/A (token gen) | WCL SDK OBO token flow | WCL SDK managed | N/A | AADTokenInfo → MWC V1 Token | Token generation exceptions | **NOT INTERCEPTED** — WCL SDK internal |
| `S2STokenProvider:GetS2STokenForOneLakeAsync` | N/A (token gen) | Azure Identity / WCL SDK | WCL SDK managed | N/A | S2S token string | Various auth exceptions | **NOT INTERCEPTED** — WCL SDK internal |

---

## Section 3: Coverage Gaps

### 3.1 Critical Gaps — NOT INTERCEPTED

| # | FLT HTTP Call | Source Class | Target Service | Why Not Intercepted | Chaos Impact |
|---|--------------|-------------|----------------|---------------------|--------------|
| **GAP-1** | Spark job submit/status/cancel | `GTSBasedSparkClient` | GTS (Lakehouse Service) | HttpClient from `Get1PWorkloadHttpClientAsync()` bypasses `IHttpClientFactory` | **CRITICAL** — Cannot inject Spark failures, latency, 429s. This is the core execution path. |
| **GAP-2** | Notebook content fetch | `NotebookApiClient` | Notebook Service | HttpClient from `Get1PWorkloadHttpClientAsync()` bypasses `IHttpClientFactory` | **HIGH** — Cannot simulate notebook fetch failures, ETag conflicts, 429s |
| **GAP-3** | Orchestrator communication | `LiveTableCommunicationClient` | Fabric Orchestrator | HttpClient from `Get1PWorkloadHttpClientAsync()` bypasses `IHttpClientFactory` | **MEDIUM** — Cannot simulate orchestrator communication failures |
| **GAP-4** | Token acquisition (OBO, S2S, MWC V1) | Multiple (WCL SDK) | Azure AD / Fabric Identity | WCL SDK internal HTTP calls, no hook point | **MEDIUM** — Cannot simulate token expiry, auth failures, slow token acquisition |
| **GAP-5** | WCL SDK DevConnection auth | WCL SDK internals | Azure AD | Completely opaque to EDOG | **LOW** — Only affects startup, not runtime chaos |

### 3.2 Root Cause: WCL SDK `Get1PWorkloadHttpClientAsync`

**All gaps except GAP-5 share the same root cause:** The WCL (Workload Client Library) SDK creates `HttpClient` instances via `IWorkloadCommunicationProvider.Get1PWorkloadHttpClientAsync()`. This:
1. Does NOT use `IHttpClientFactory`
2. Creates its own handler pipeline internally
3. Has no extensibility point for injecting DelegatingHandlers

**Impact:** FLT's 3 most critical outbound call paths (Spark, Notebook, Orchestrator) are invisible to EDOG's HTTP interception layer.

### 3.3 Partial Coverage Issues

| Issue | Affected Interceptor | Detail |
|-------|---------------------|--------|
| Cache interceptor not wired | `EdogCacheInterceptor` | Static utility with no call sites in FLT. TokenManager, CatalogHandler, DagExecutionStore caches are not instrumented. |
| DI registry stale | `EdogDiRegistryCapture` | `IsEdogIntercepted()` only returns true for 4 services, but 6+ are actually intercepted (missing: IFileSystemFactory, IServiceMonitoringCallback, IHttpClientFactory) |
| Retry interceptor fragile | `EdogRetryInterceptor` | Regex-based log parsing — new retry log formats won't match. No structured retry event from Polly. |

### 3.4 Chaos Panel Requirements vs. Current Capabilities

| Chaos Capability | Current State | What's Needed |
|-----------------|---------------|---------------|
| **Inject HTTP errors** (500, 503, 429) | ❌ Not possible — interceptors are read-only | Modify `EdogHttpPipelineHandler.SendAsync()` to check a chaos config before calling `base.SendAsync()` |
| **Inject latency** | ❌ Not possible | Add `Task.Delay()` before `base.SendAsync()` in pipeline handler |
| **Inject Spark failures** | ❌ Not intercepted | Must subclass `GTSBasedSparkClient` and override `SendHttpRequestAsync()` (it's `protected virtual`) |
| **Override feature flags** | ❌ Read-only wrapper | Add override dict to `EdogFeatureFlighterWrapper.IsEnabled()` — check dict before calling `_inner` |
| **Inject file system errors** | ❌ Read-only wrapper | Add error injection to `EdogFileSystemWrapper` methods |
| **Inject token expiry** | ❌ Not possible | Would need to wrap `ITokenProvider` or intercept at `EdogTokenInterceptor` level |
| **Drop/delay SignalR messages** | ❌ Not possible | Would need middleware in `EdogPlaygroundHub` |
| **Inject retry storms** | ❌ Can only observe | Need to hook into Polly policies or inject at HTTP level |
| **Poison cache** | ❌ Cache interceptor not wired | Need to actually wrap cache implementations |

### 3.5 Priority Recommendations for Chaos Panel

1. **P0 — Spark interception:** Override `GTSBasedSparkClient.SendHttpRequestAsync()` (already `protected virtual`) in EDOG's patched subclass. This is the single highest-value chaos target.
2. **P0 — HTTP fault injection:** Convert `EdogHttpPipelineHandler` from read-only to configurable. Add a chaos config that can inject errors/latency per URL pattern.
3. **P1 — Feature flag overrides:** Add override dictionary to `EdogFeatureFlighterWrapper`. Trivial change, high value.
4. **P1 — File system fault injection:** Add error injection to `EdogFileSystemWrapper`. Already wraps all 13 methods.
5. **P2 — Notebook interception:** Same approach as Spark — need a hook point in `NotebookApiClient` or its HttpClient.
6. **P2 — Cache instrumentation:** Wire `EdogCacheInterceptor` to actual FLT cache operations.
7. **P3 — Token fault injection:** Complex — WCL SDK is opaque. May need ITokenProvider wrapper.

---

*"Every failure mode that isn't tested is a production incident waiting to happen."*

— Vex, EDOG Studio Backend
