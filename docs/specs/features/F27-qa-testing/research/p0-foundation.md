# F27 QA Testing — P0 Foundation Research

> **Author:** Sana (Architecture & FLT Internals)
> **Date:** 2025-07-09
> **Status:** Complete
> **Purpose:** Foundation audit for all subsequent F27 design and implementation phases.

---

## Summary: What Exists vs What Needs Building

| Domain | Exists (Reusable) | Needs Building |
|--------|-------------------|----------------|
| **Event observation** | 16 topic interceptors capturing HTTP, tokens, flags, perf, Spark, logs, telemetry, retry, cache, fileops, catalog, DAG, FLT-ops, DI, capacity, nexus | Scenario-scoped event filtering; correlation ID injection per scenario run |
| **Event transport** | `TopicEvent` envelope with monotonic sequence + timestamp; `TopicBuffer` ring + live channel; `EdogTopicRouter` static registry | Scenario execution topic (`qa`); typed result payloads; assertion outcome events |
| **Event delivery** | SignalR `/hub/playground` with snapshot + live stream (F24 protocol) | QA-specific SignalR methods: `StartScenarioRun`, `ScenarioResult`, `ExpectationMatched` |
| **HTTP interception** | `EdogHttpPipelineHandler` captures method, URL, status, headers, body preview, timing, correlation | Request injection (stimulus delivery); response mocking for error-path scenarios |
| **Token lifecycle** | `EdogTokenInterceptor` + `EdogTokenLifecycleInterceptor` cover auth headers, OBO exchange, cache, refresh, eviction | Token-expiry simulation for auth-sensitive scenarios |
| **Feature flags** | `EdogFeatureFlighterWrapper` records flag name, result, timing, scoping IDs | Flag override injection for permutation testing |
| **File operations** | `EdogFileSystemInterceptor` wraps all IFileSystem methods with operation/path/size/duration/preview | File-content seeding for setup steps; assertion on write sequences |
| **DAG execution** | `EdogDagExecutionInterceptor` emits node start/complete/fail + terminal DAG summary | Scenario-driven DAG trigger stimulus; per-node expectation matching |
| **FLT operations** | `EdogFltOpsInterceptor` (912 lines) covers refresh triggers, MLV defs, report state, table maintenance | Typed event schema extraction; operation-level assertion matchers |
| **Retry logic** | `EdogRetryInterceptor` parses log stream for retry attempts, delays, throttling | Chaos-rule integration for fault injection → retry verification |
| **Log + telemetry** | `EdogLogInterceptor` + `EdogTelemetryInterceptor` + `EdogLogServer` + `EdogLogModels` | Log-based assertion matchers (pattern present/absent); telemetry timing assertions |
| **DI capture** | `EdogDiRegistryCapture` + `EdogDevModeRegistrar` provide full service wiring snapshot | Auto-discovery of which interceptors cover a PR's changed interfaces |
| **Frontend panels** | `main.js` (panel orchestration), `state.js` (ring buffers + filter indices), `renderer.js` (virtual scroll) | QA Testing panel: scenario list, execution progress, result cards, timeline view |
| **Code understanding** | `EdogDiRegistryCapture` provides runtime DI ground truth | Five-layer engine: code-review-graph (structural blast radius), Graphify (knowledge graph), OmniSharp/Roslyn (semantic call hierarchy + type resolution), GPT-5.4-pro (reasoning + scenario generation), Runtime DI (interface→impl validation). See `research/viability-analysis.md` for full architecture. |
| **Scenario model** | F27 spec defines JSON schema (§4) | Implementation: scenario executor, expectation matcher engine, result aggregator |
| **PR integration** | — | ADO API client for diff fetching; PR comment formatter; CI gate integration |

---

## §1: Existing Code Audit

### 1.1 Core Infrastructure

#### `src/backend/DevMode/EdogTopicRouter.cs` (97 lines)

Central static registry for all EDOG topic buffers. Interceptors publish here; `EdogPlaygroundHub` reads via `ChannelReader` streaming. Thread-safe — `Publish()` never throws.

**Key members:**
- `EdogTopicRouter` static class: `18-95`
- `_buffers: ConcurrentDictionary<string, TopicBuffer>`: `20`
- `Initialize()`: `26-44` — registers all 16 topics with buffer sizes
- `RegisterTopic(string topic, int maxSize)`: `51-54` — idempotent via `TryAdd`
- `Publish(string topic, object eventData)`: `73-94` — wraps data in `TopicEvent`, writes to buffer
- `GetBuffer(string topic)`: `60-65` — returns `TopicBuffer` or null

**Registered topics (from `Initialize()`):**

| Topic | Buffer Size | Interceptor Source |
|-------|------------|-------------------|
| `log` | 10,000 | `EdogLogServer.AddLog()` (`EdogLogServer.cs:184`) |
| `telemetry` | 5,000 | `EdogLogServer.AddTelemetry()` (`EdogLogServer.cs:212`) |
| `fileop` | 2,000 | `EdogFileSystemInterceptor.PublishEvent()` (`EdogFileSystemInterceptor.cs:264`) |
| `spark` | 200 | `EdogSparkSessionInterceptor.CreateSparkClientAsync()` (`EdogSparkSessionInterceptor.cs:67,100`) |
| `token` | 1,000 | `EdogTokenInterceptor.SendAsync()` (`EdogTokenInterceptor.cs:63`) + `EdogTokenLifecycleInterceptor.PublishEvent()` (`EdogTokenLifecycleInterceptor.cs:228`) |
| `cache` | 2,000 | `EdogCacheInterceptor.RecordCacheEvent()` (`EdogCacheInterceptor.cs:58`) |
| `http` | 2,000 | `EdogHttpPipelineHandler.SendAsync()` (`EdogHttpPipelineHandler.cs:67`) |
| `retry` | 500 | `EdogRetryInterceptor.ProcessLogEvent()` (`EdogRetryInterceptor.cs:200,237`) |
| `flag` | 1,000 | `EdogFeatureFlighterWrapper.IsEnabled()` (`EdogFeatureFlighterWrapper.cs:53`) |
| `di` | 100 | `EdogDiRegistryCapture.CaptureRegistrations()` (`EdogDiRegistryCapture.cs:126`) |
| `perf` | 5,000 | `EdogPerfMarkerCallback.CustomReportingAction()` (`EdogPerfMarkerCallback.cs:68`) |
| `capacity` | 500 | External (capacity sync) |
| `catalog` | 200 | `EdogCatalogInterceptor.PublishEvent()` (`EdogCatalogInterceptor.cs:150`) |
| `dag` | 500 | `EdogDagExecutionInterceptor` hook + wrapper (`EdogDagExecutionInterceptor.cs:125,231`) |
| `flt-ops` | 300 | `FltOpsEventHelper.PublishEvent()` (`EdogFltOpsInterceptor.cs:38`) |
| `nexus` | 100 | `EdogNexusAggregator` (`EdogNexusAggregator.cs:469,476`) |

**F27 reuse:** Core event bus for scenario execution traces. Topic partitioning maps directly to the `Expectation.topic` field in the F27 scenario schema. `Publish()` never-throw guarantee means interceptors won't break FLT during test runs.

**Gaps for F27:**
- No schema/versioning per topic — `Data` is untyped `object`
- No per-scenario correlation ID filtering — all events go to same buffer
- Publish silently drops events for unregistered topics
- No backpressure or persistence beyond ring buffer eviction

**What F27 needs to build:** A `qa` topic for scenario execution metadata; event filtering by scenario run ID; possibly a `TopicBuffer` snapshot-at-time-T capability for bounded assertion windows.

---

#### `src/backend/DevMode/TopicEvent.cs` (32 lines)

Universal event envelope for all EDOG streamed events. Every interceptor publishes through this.

**Key members:**
- `TopicEvent` sealed class: `17-30`
- `SequenceId: long` (monotonic per topic): `20`
- `Timestamp: DateTimeOffset` (UTC): `23`
- `Topic: string`: `26`
- `Data: object` (topic-specific payload): `29`

**F27 reuse:** Base envelope for scenario execution evidence. `SequenceId` enables gap detection (did we miss events during assertion window?). `Timestamp` enables time-window assertions.

**Gaps:** No correlation/workflow ID beyond topic + sequence. `Data` is untyped — assertion matchers must use reflection or dynamic access. No scenario-run-ID field.

---

#### `src/backend/DevMode/TopicBuffer.cs` (76 lines)

Per-topic ring buffer plus unbounded live channel. Supports snapshot hydration and live streaming via `System.Threading.Channels`.

**Key members:**
- `TopicBuffer` sealed class: `20-74`
- `_maxSize: int`, `_ring: ConcurrentQueue<TopicEvent>`, `_liveChannel: Channel<TopicEvent>`, `_sequenceCounter: long`: `22-25`
- Constructor `TopicBuffer(int maxSize)`: `31-36`
- `NextSequenceId(): long` (atomic via `Interlocked.Increment`): `41`
- `Write(TopicEvent evt)`: `48-56` — enqueue to ring + TryWrite to live channel
- `GetSnapshot(): TopicEvent[]`: `61-64`
- `ReadLiveAsync(CancellationToken ct): IAsyncEnumerable<TopicEvent>`: `70-73`

**F27 reuse:** Snapshot + live tail is ideal for scenario execution: snapshot provides recent history for context; live stream feeds the assertion matcher in real-time. Ring buffer holds evidence for failure analysis.

**Gaps:** No filtering by scenario ID, correlation, or time window. Unbounded live channel can grow without limit. Ring eviction under contention may drop events.

---

### 1.2 Interceptors — Observation Layer

#### `src/backend/DevMode/EdogHttpPipelineHandler.cs` (245 lines)

`DelegatingHandler` that records full HTTP request/response metadata, redacts secrets, truncates body previews, and publishes to `http` topic.

**Key members:**
- `EdogHttpPipelineHandler : DelegatingHandler`: `25-243`
- Constants: `MaxBodyPreviewBytes = 4096`, `MaxBufferableBytes = 65536`: `27-28`
- `SasTokenPattern: Regex`: `30-32`
- `SendAsync(HttpRequestMessage, CancellationToken)`: `46-87` — captures method, URL, headers, timing, status, body preview, correlation
- `RedactUrl(string url)`: `92-104` — strips SAS tokens
- `RedactRequestHeaders(HttpRequestHeaders)`: `109-137` — redacts Authorization
- `CaptureHeaders(...)`: `142-166`
- `ExtractCorrelationId(...)`: `171-188`
- `CaptureBodyPreview(HttpContent)`: `195-231` — text-only, 4KB cap

**Event payload** (published at `EdogHttpPipelineHandler.cs:67-78`):
```csharp
{
    method,           // string: "GET", "POST", etc.
    url,              // string: redacted URL
    statusCode,       // int: HTTP status code
    durationMs,       // double: round-trip time
    requestHeaders,   // Dictionary: redacted headers
    responseHeaders,  // Dictionary: response headers
    responseBodyPreview, // string: truncated body (4KB max)
    httpClientName,   // string: named HttpClient
    correlationId,    // string: extracted from headers
}
```

**F27 reuse:** Foundation for HTTP-based scenario assertions. Can validate outbound API calls match expectations (URL pattern, status code, timing). `correlationId` enables cross-topic tracing.

**Gaps:** Body preview is text-only, 4KB cap — large payloads invisible. No request body capture. No response body hashing. Read-only — cannot inject faults (need F24 chaos integration for that).

---

#### `src/backend/DevMode/EdogTokenInterceptor.cs` (235 lines)

Captures auth header metadata from HTTP requests without storing raw tokens. Also contains `EdogHttpClientFactoryWrapper` for injecting interceptors.

**Key members:**
- `EdogTokenInterceptor : DelegatingHandler`: `24-166`
- `SendAsync(...)`: `38-81` — extracts scheme, classifies token type, decodes JWT metadata
- `ClassifyTokenType(string scheme)`: `87-94` — Bearer, SharedKey, etc.
- `DecodeJwtMetadata(...)`: `100-144` — extracts `aud`, `exp`, `iat` without storing token
- `EdogHttpClientFactoryWrapper : IHttpClientFactory`: `175-234`
- `CreateClient(string name)`: `204-232` — wraps handler chain via reflection on `_handler`

**Event payload** (published at `EdogTokenInterceptor.cs:63-76`):
```csharp
{
    authScheme,       // string: "Bearer", "SharedKey"
    tokenType,        // string: classified type
    audience,         // string: from JWT `aud` claim
    expiresIn,        // TimeSpan: token TTL
    issuedAt,         // DateTimeOffset: from JWT `iat`
    httpClientName,   // string: named client
    url,              // string: request URL
}
```

**F27 reuse:** Validates auth lifecycle during scenario execution. `EdogHttpClientFactoryWrapper` ensures broad coverage — all named `HttpClient` instances get intercepted.

**Gaps:** JWT parsing only extracts 3 claims. Reflection on `HttpMessageInvoker._handler` is fragile. No support for non-header auth sources.

---

#### `src/backend/DevMode/EdogTokenLifecycleInterceptor.cs` (236 lines)

Wraps `ITokenManager` to track token acquisition, caching, refresh, eviction, and OBO exchange events.

**Key members:**
- `EdogTokenLifecycleInterceptor : ITokenManager`: `24-236`
- `GetOboTokenForTridentLakeAsync(...)`: `36-73` — OBO exchange events
- `GetTokenAsync(...)`: `76-120` — token acquisition with cache inference
- `CacheToken(...)`: `123-150` — cache put events
- `UpdateCachedToken(...)`: `153-182` — cache update events
- `DeleteCachedToken(...)`: `185-212` — cache eviction events
- `PublishEvent(object)`: `224-234` — publishes to `token` topic

**Event payload examples** (published at `EdogTokenLifecycleInterceptor.cs:44-52`):
```csharp
// OBO exchange
{ @event = "OboExchange", provider = "TokenManager", audience = "TridentLake",
  tenantId, durationMs, success }

// Token acquisition
{ @event = "TokenAcquired", provider = "TokenManager", resource, tenantId,
  durationMs, success, cacheInference }  // cacheInference: "CacheHit"/"CacheMiss" based on timing

// Cache operations
{ @event = "TokenCached"/"TokenUpdated"/"TokenEvicted", provider, resource,
  tenantId, expiresInMinutes/originalExpiresInMinutes/reason }
```

**F27 reuse:** Essential for token-sensitive scenarios (auth expiry, cache eviction, OBO flow).

**Gaps:** `cacheInference` is heuristic (duration threshold at `EdogTokenLifecycleInterceptor.cs:84-87`). Tokens never exposed by design — limits deep auth debugging.

---

#### `src/backend/DevMode/EdogFeatureFlighterWrapper.cs` (59 lines)

Wraps `IFeatureFlighter` and publishes flag evaluation results to `flag` topic.

**Key members:**
- `EdogFeatureFlighterWrapper : IFeatureFlighter`: `19-57`
- `IsEnabled(string, Guid?, Guid?, Guid?)`: `33-56`

**Event payload** (published at `EdogFeatureFlighterWrapper.cs:43-51`):
```csharp
{
    flagName,         // string: feature flag name
    tenantId,         // string: nullable
    capacityId,       // string: nullable
    workspaceId,      // string: nullable
    result,           // bool: enabled/disabled
    durationMs,       // double: evaluation time
}
```

**F27 reuse:** Scenario generation around feature-flag permutations. Can verify flag-dependent execution paths.

**Gaps:** Only records outcome, not decision rationale or flag rule. No batching/dedup of repeated calls. Read-only — flag override injection needs F24 chaos rule integration.

---

#### `src/backend/DevMode/EdogPerfMarkerCallback.cs` (103 lines)

Decorates `IServiceMonitoringCallback` to publish perf marker completion events to `perf` topic.

**Key members:**
- `EdogPerfMarkerCallback : IServiceMonitoringCallback`: `21-102`
- `CustomReportingAction(...)`: `35-75` — captures operation name, duration, result, dimensions
- `BuildDimensions(IOrderedDictionary)`: `81-101`

**Event payload** (published at `EdogPerfMarkerCallback.cs:59-66`):
```csharp
{
    operationName,    // string: perf marker name
    durationMs,       // double: metric value
    result,           // string: success/failure
    dimensions,       // Dictionary<string,string>: custom dimensions
    correlationId,    // string: from dimensions
}
```

**F27 reuse:** Performance regression scenarios. Can assert that operation durations stay within expected bounds.

**Gaps:** No start/end pairing — only completion events. Dimension extraction is generic, not strongly typed.

---

#### `src/backend/DevMode/EdogSparkSessionInterceptor.cs` (106 lines)

Wraps `ISparkClientFactory` to track Spark session creation lifecycle.

**Key members:**
- `EdogSparkSessionInterceptor : ISparkClientFactory`: `28-104`
- `_sessionCounter: int` (monotonic via `Interlocked.Increment`): `31`
- `CreateSparkClientAsync(...)`: `43-103` — publishes `Created` or `Error` events

**Event payload** (published at `EdogSparkSessionInterceptor.cs:86-98`):
```csharp
{
    sessionTrackingId, // string: "edog-spark-{N}"
    @event,            // string: "Created" or "Error"
    tenantId,          // Guid
    workspaceId,       // string
    artifactId,        // string
    iterationId,       // string
    workspaceName,     // string
    artifactName,      // string
    durationMs,        // double
    error,             // string: null on success
}
```

**F27 reuse:** Validates Spark-backed flow scenarios. Tracking ID anchors per-session correlation.

**Gaps:** Only covers session creation, not usage/lifecycle after creation. Tracking ID is local counter, not correlated to scenario run.

---

#### `src/backend/DevMode/EdogLogInterceptor.cs` (164 lines)

Implements `IStructuredTestLogger` to forward telemetry logs into `EdogLogServer` and emit colored console output.

**Key members:**
- `EdogLogInterceptor : IStructuredTestLogger`: `20-163`
- `IterationIdRegex`: `22-24`
- `TraceEvent(TestLogEvent)`: `41-87` — normalizes level, extracts iteration ID, forwards to log server
- `WriteColoredConsoleOutput(...)`: `92-117`
- `ExtractComponent(...)`: `137-162`

**F27 reuse:** Strong source for log-based assertions (pattern present/absent). Iteration ID parsing binds logs to execution runs.

**Gaps:** Publishes to `EdogLogServer`, not directly to `EdogTopicRouter` (server then publishes to `log` topic at `EdogLogServer.cs:184`). Console coloring is developer-facing only.

---

#### `src/backend/DevMode/EdogRetryInterceptor.cs` (276 lines)

Background log-stream consumer that parses retry-related log messages into structured `retry` events.

**Key members:**
- `EdogRetryInterceptor`: `30-275`
- Regex patterns: `RetryAttemptRegex`, `RetryDelayRegex`, `RetryAfterHintRegex`, `ThrottleStatusRegex`, `NodeInfoRegex`, `NotebookRetryRegex`: `39-62`
- `Start()`: `67-76` — starts background monitoring
- `MonitorLogStreamAsync(CancellationToken)`: `78-105` — subscribes to `log` topic live stream
- `ProcessLogEvent(TopicEvent)`: `107-201` — regex matching and event construction
- `PublishNotebookRetryEvent(Match, string, LogEntry)`: `203-238`

**Event payload** (published at `EdogRetryInterceptor.cs:186-200`):
```csharp
{
    endpoint,         // string: API endpoint
    statusCode,       // int: 429, 430, etc.
    retryAttempt,     // int: current attempt
    totalAttempts,    // int: max attempts
    waitDurationMs,   // double: delay between retries
    strategyName,     // string: "ExponentialBackoff", etc.
    reason,           // string: extracted failure reason
    isThrottle,       // bool: throttling detected
    retryAfterMs,     // double: server-suggested delay
    iterationId,      // string: FLT iteration correlation
}
```

**F27 reuse:** Critical for fault-injection → retry-verification scenarios. Pairs with F24 chaos rules for inject-fault-then-verify-retry testing.

**Gaps:** Heavily regex-dependent — brittle to log format changes. Requires `Start()` call. One-way parsing only; no causal linkage to original failing operation.

---

#### `src/backend/DevMode/EdogCacheInterceptor.cs` (91 lines)

Static helper for publishing cache events to `cache` topic.

**Key members:**
- `RecordCacheEvent(...)`: `36-59` — static method, 8 parameters
- `GetOrResolve<T>(...)`: `65-89` — timing wrapper (note: `wasMiss` logic at lines 73-86 has a bug — factory is never invoked)

**Event payload** (published at `EdogCacheInterceptor.cs:46-56`):
```csharp
{
    cacheName,        // string: "Unknown" if null
    operation,        // string: "Get", "Set", etc.
    key,              // string
    hitOrMiss,        // string: nullable
    valueSizeBytes,   // long: nullable
    ttlSeconds,       // int: nullable
    durationMs,       // double: rounded to 2dp
    evictionReason,   // string: nullable
}
```

**F27 reuse:** Cache hit/miss assertions. TTL validation for cache-sensitive scenarios.

**Gaps:** `GetOrResolve` has a correctness bug — `wasMiss` is never set properly. Not a DI wrapper — must be called explicitly by instrumented code.

---

#### `src/backend/DevMode/EdogFileSystemInterceptor.cs` (272 lines)

Wraps `IFileSystemFactory` and `IFileSystem` to intercept all file operations and publish to `fileop` topic.

**Key members:**
- `EdogFileSystemFactoryWrapper : IFileSystemFactory`: `25-50`
- `EdogFileSystemWrapper : IFileSystem`: `58-271`
  - Operations: `ExistsAsync` (76), `CreateDirIfNotExistsAsync` (87), `CreateOrUpdateFileAsync` (97), `ReadFileAsStringAsync` (111), `CreateEmptyFileIfNotExistsAsync` (125), `RenameFileAsync` (138), `DeleteFileIfExistsAsync` (148), `DeleteDirIfExistsAsync` (159), `ListAsync` (170), `ReadFileBytesAsync` (183), `ListWithContinuationAsync` (196), `GetDirMetadataAsync` (209), `GetFileMetadataAsync` (222)
- `TruncatePreview(...)`: `237-243`
- `PublishEvent(...)`: `248-270` — constructs event with operation, path, size, duration, preview, TTL

**Event payload** (published at `EdogFileSystemInterceptor.cs:252-262`):
```csharp
{
    operation,        // string: "Read", "Write", "Delete", "List", "Exists"
    path,             // string: file/directory path
    contentSizeBytes, // long: content size (or item count for List)
    durationMs,       // double: operation time
    hasContent,       // bool: whether content was present
    contentPreview,   // string: first N chars of text content
    ttlSeconds,       // long: TTL if applicable
    iterationId,      // string: FLT iteration correlation
}
```

**F27 reuse:** Assertions on filesystem side effects — write sequences, read patterns, delete verification. `iterationId` enables scenario correlation.

**Gaps:** `contentSizeBytes` for `List` operations reports item count, not size. No path normalization or sensitivity masking. Anonymous event schema.

---

#### `src/backend/DevMode/EdogTelemetryInterceptor.cs` (147 lines)

Wraps `ICustomLiveTableTelemetryReporter` to capture and forward telemetry events.

**Key members:**
- `EdogTelemetryInterceptor`: `20-147`
- `IterationIdRegex`: `22-24`
- `EmitStandardizedServerReporting(...)`: `51-122` — extracts activity name/status/duration, iteration ID from correlation
- `WriteColoredConsoleOutput(...)`: `130-145`

**F27 reuse:** Telemetry-based assertions (activity completed, duration within bounds, result code matching). Iteration ID extraction correlates with scenario runs.

**Gaps:** Iteration ID extraction is heuristic regex-based. Swallows forwarding failures silently.

---

#### `src/backend/DevMode/EdogCatalogInterceptor.cs` (158 lines)

Wraps `ICatalogHandler` to publish catalog discovery lifecycle events to `catalog` topic.

**Key members:**
- `EdogCatalogInterceptor : ICatalogHandler`: `25-158`
- `GetCatalogObjectsAsync(...)`: `39-141` — emits `CatalogDiscoveryStarted`, `CatalogDiscoveryCompleted`, `CatalogDiscoveryFailed`
- `PublishEvent(object)`: `146-156`

**Event payloads** (published at `EdogCatalogInterceptor.cs:52-60, 100-126, 128-140`):
```csharp
// Start
{ @event = "CatalogDiscoveryStarted", workspaceId, artifactId, artifactName,
  hasMLVFilter, extendedLineage }

// Complete
{ @event = "CatalogDiscoveryCompleted", workspaceId, artifactId, artifactName,
  durationMs, totalTables, materializedLakeViews, shortcuts, faulted, regular }

// Failed
{ @event = "CatalogDiscoveryFailed", workspaceId, artifactId, artifactName,
  durationMs, errorType, errorMessage }  // errorMessage truncated to 500 chars
```

**F27 reuse:** Validates metadata discovery scenarios — entity counts, failure handling, lineage.

**Gaps:** Entity classification uses heuristic methods (`IsFaulted`, `IsShortcut`, etc.). Error messages truncated to 500 chars.

---

#### `src/backend/DevMode/EdogDagExecutionInterceptor.cs` (239 lines)

Contains `EdogDagExecutionHook` (terminal DAG summary) and `EdogNodeExecutorWrapper` (per-node lifecycle).

**Key members:**
- `EdogDagExecutionHook`: `31-132`
  - Properties: `Name` (34), `GroupId` (37), `Phase` (40) — all return `"edog"`
  - `ExecuteAsync(...)`: `43-116` — emits `DagTerminal` event with node counts, status, error info
- `EdogNodeExecutorWrapper`: `140-239`
  - `ExecuteNodeAsync(...)`: `165-209` — emits `NodeStarted`, `NodeCompleted`, `NodeFailed`
  - `Truncate(string, int)`: `214-222`

**Event payloads** (published at `EdogDagExecutionInterceptor.cs:92-107, 167-176, 182-192, 195-207`):
```csharp
// Terminal DAG summary
{ @event = "DagTerminal", dagId, iterationId, status, totalNodes,
  completedNodes, failedNodes, skippedNodes, parallelLimit, durationMs,
  errorCode, errorMessage, errorSource }

// Node lifecycle
{ @event = "NodeStarted", dagId, nodeId, nodeName, nodeType, iterationId }
{ @event = "NodeCompleted", dagId, nodeId, nodeName, nodeType, iterationId,
  durationMs, status }
{ @event = "NodeFailed", dagId, nodeId, nodeName, nodeType, iterationId,
  durationMs, errorCode, errorMessage }
```

**F27 reuse:** Best match for end-to-end scenario execution tracing. DAG-triggered scenarios can assert per-node outcomes and terminal status.

**Gaps:** Source comments indicate wiring patches needed for runtime integration (`EdogDagExecutionInterceptor.cs:5-10`). Node wrapper requires DI creation patch.

---

#### `src/backend/DevMode/EdogFltOpsInterceptor.cs` (912 lines)

Largest interceptor file. Wraps FLT operational services: refresh triggers, MLV definition persistence, report state, table maintenance.

**Key classes:**
- `FltOpsEventHelper`: `32-45` — shared publish helper
- `EdogRefreshTriggersWrapper`: `55-168` — `CreateOrUpdate`, `List` for refresh triggers
- `EdogMLVDefinitionWrapper`: `178-644` — `Create`, `Get`, `Update`, `Delete`, `List`, `GetRecovery`, `ListRecoveryFileIds`, `DeleteRecovery`, `CreateMLVDefFileSystem` (9 operations)
- `EdogReportStateWrapper`: `654-842` — `InitializeState`, `UpdateState`, `TryGetState`, `Close`
- `EdogTableMaintenanceFactoryWrapper`: `852-911` — `CreateTableMaintenanceClient`

**Event payload pattern** (consistent across all operations, e.g., `EdogFltOpsInterceptor.cs:85-95`):
```csharp
{
    @event,           // string: "RefreshTriggerUpserted", "MLVDefinitionCreated", etc.
    operation,        // string: "RefreshTrigger", "MLVDefinition", etc.
    action,           // string: "CreateOrUpdate", "Get", "Delete", etc.
    workspaceId,      // string
    [lakehouseId|artifactId|definitionId], // string: context-dependent
    durationMs,       // long: elapsed milliseconds
    success,          // bool
    [errorType],      // string: on failure only
}
```

**F27 reuse:** Rich taxonomy of FLT operations for scenario generation. Each operation pair (success/failure) maps to a scenario category.

**Gaps:** No shared schema — every event is anonymous-object shaped. Very broad file — easy to miss coverage when interfaces change. No central contract validation.

---

### 1.3 Registration & Wiring

#### `src/backend/DevMode/EdogDevModeRegistrar.cs` (327 lines)

Central startup registrar for all DevMode interceptors.

**Key members:**
- `RegisterAll()`: `25-63` — orchestrates all interceptor registration + starts nexus
- Individual registrations: `RegisterFeatureFlighterWrapper` (65), `RegisterPerfMarkerCallback` (83), `RegisterTokenInterceptor` (99), `RegisterFileSystemInterceptor` (111), `RegisterHttpPipelineHandler` (129), `EnsureHttpClientFactoryWrapped` (146), `RegisterRetryInterceptor` (160), `RegisterCacheInterceptor` (172), `RegisterSparkSessionInterceptor` (180), `RegisterDiRegistryCapture` (198), `RegisterTokenLifecycleInterceptor` (210), `RegisterCatalogInterceptor` (228), `RegisterFltOpsInterceptors` (246), `StartNexusAggregator` (313)

**F27 reuse:** Central wiring point for F27 runtime activation. Could add `RegisterQaTestingEngine()` alongside existing interceptors.

**Gaps:** Registration is coarse-grained — no feature flags or partial enablement. `RegisterFltOpsInterceptors()` has early `return` statements that can stop later registrations (246-311).

---

#### `src/backend/DevMode/EdogDiRegistryCapture.cs` (178 lines)

Publishes a snapshot of DI registrations with EDOG-wrapped service detection.

**Key members:**
- `CaptureRegistrations()`: `33-107` — iterates DI container, publishes to `di` topic
- `IsEdogIntercepted(...)`: `149-160` — manual switch map for known wrappers
- `GetEdogWrapperName(...)`: `165-175` — maps implementation types to wrapper names

**F27 reuse:** Helps AI map PR diff to impacted backend components. "What services are intercepted?" informs scenario generation coverage analysis.

**Gaps:** Static hardcoded service list — can drift from reality. Detection is manual, not container introspection.

---

### 1.4 Log Infrastructure

#### `src/backend/DevMode/EdogLogModels.cs` (84 lines)

Data models for logs and telemetry.

**Key classes:**
- `LogEntry`: `16-46` — `Timestamp`, `Level`, `Message`, `Component`, `RootActivityId`, `EventId`, `CustomData`, `IterationId`, `CodeMarkerName`
- `TelemetryEvent`: `51-82` — `Timestamp`, `ActivityName`, `ActivityStatus`, `DurationMs`, `ResultCode`, `CorrelationId`, `Attributes`, `UserId`, `IterationId`

**F27 reuse:** Base schema for scenario execution logs. `IterationId` fields enable scenario-to-evidence correlation.

**Gaps:** No fields for scenario ID, assertion outcome, or test run context. Mutable `IterationId` setter with no validation.

---

#### `src/backend/DevMode/EdogLogServer.cs` (496 lines)

Embedded Kestrel + SignalR server on port 5555. Serves the EDOG Studio UI and provides REST APIs.

**Key members:**
- `Start()`: `63-133` — configures Kestrel, SignalR, CORS
- `AddLog(LogEntry)`: `174-196` — stores in buffer, publishes to `log` topic, broadcasts via SignalR
- `AddTelemetry(TelemetryEvent)`: `202-224` — stores, publishes to `telemetry`, broadcasts
- REST routes (`ConfigureRoutes()`: `226-396`):
  - `GET /` — serves HTML UI
  - `GET /api/logs` — filtered log query
  - `GET /api/telemetry` — filtered telemetry query
  - `GET /api/stats` — summary statistics
  - `GET /api/executions` — execution grouping by iteration ID

**F27 reuse:** `/api/executions` grouping pattern is a template for scenario run grouping. SignalR infrastructure is shared.

**Gaps:** In-memory only — no persistence beyond process lifetime. Execution status inference is simplistic (string matching for "Error"/"Failed"). HTML serving is basic.

---

### 1.5 Frontend Panel System

#### `src/frontend/js/main.js` (1364 lines)

Main app orchestrator for EDOG Studio UI.

**Key members:**
- `class EdogLogViewer`: `94+`
- `constructor()`: `95-171` — initializes state, renderer, binds events
- `init()`: `173-260` — async setup, SignalR connection, tab initialization
- `bindEventListeners()`: `325-493` — keyboard, filter, view switching
- `handleWebSocketMessage(msg)`: `552-572` — processes incoming SignalR messages
- `handleWebSocketBatch(batch)`: `575-603` — processes batched messages
- `switchTab(tabName)`: `780-792` — panel switching

**F27 reuse:** Tab/panel orchestration pattern is the template for QA Testing panel integration. SignalR message handling infrastructure is shared.

**Gaps:** No F27-specific panel or scenario pipeline. Heavy coupling to runtime tabs and log viewer.

---

#### `src/frontend/js/state.js` (257 lines)

Central state layer using ring buffers and precomputed filter indices.

**Key members:**
- `class RingBuffer`: `8-63` — fixed-size append-only buffer with `push`, `get`, `toArray`
- `class FilterIndex`: `67-121` — precomputed index for level/component/search filtering
- `class LogViewerState`: `125-257` — `logs`, `telemetry`, `stats`, `endpoints`, `components`, filters, stream mode

**F27 reuse:** Ring buffer pattern fits scenario/result state. Filter index pattern fits expectation filtering.

**Gaps:** Log-centric model — no test run/scenario/assertion structures. Compatibility shims (`filteredLogs`) are not typed APIs.

---

#### `src/frontend/js/renderer.js` (1078 lines)

Virtual-scroll DOM renderer for logs and telemetry.

**Key members:**
- `class RowPool`: `9-86` — DOM node pooling for virtual scroll
- `class Renderer`: `254+` — virtual scroll, highlight pipeline, telemetry cards
- `initVirtualScroll()`: `296-325`
- `flush()`: `469-510` — batch DOM update
- `_renderVirtualScroll()`: `514-610` — viewport-based rendering
- `createTelemetryCard()`: `815-876`
- `passesFilter()`: `880-954`

**F27 reuse:** Virtual scroll for streaming scenario results. Telemetry card pattern for scenario result cards.

**Gaps:** Optimized for logs/telemetry only. QA-specific visualizations (diff view, assertion match, timeline) need new render paths.

---

### 1.6 F24 Chaos Engineering Specs (Shared Infrastructure)

#### `docs/specs/features/F24-chaos-engineering/interceptor-audit.md` (446 lines)

Complete inventory of EDOG interceptors with chaos mutation capabilities.

**Key findings for F27:**
- Section 1 (`10-317`): All interceptors documented with read vs write capability
- Section 2 (`319-385`): HTTP traffic map showing what's observable and modifiable
- Section 3 (`389-441`): Coverage gaps — Spark/Notebook/Orchestrator/WCL SDK calls NOT intercepted
- Most interceptors are **read-only** — F27 can observe but not inject via these interceptors alone
- F24 chaos engine adds the **write** capability (fault injection, latency, response mutation)

**F27 implication:** Scenario execution requires F24 chaos engine for setup steps (fault injection, flag overrides) while interceptors provide the observation/assertion layer.

---

#### `docs/specs/features/F24-chaos-engineering/engine-design.md` (2948 lines)

Chaos rule engine architecture — industry study + synthesized design.

**Key patterns F27 should adopt:**
- **Predicate/action separation** — rules have conditions (when to fire) and effects (what to do)
- **Scoped targeting** — rules apply to specific services/endpoints/methods
- **Mandatory duration** — all rules have TTL (prevents dangling faults)
- **Auto-revert** — expired rules clean up automatically
- **Kill switch** — immediate disable of all active rules
- **Exportable JSON** — rule definitions are portable

**F27 adaptation:** Scenario `setup` steps use F24 chaos rules for injection; scenario `expectations` use interceptor events for assertion. The chaos engine provides stimulus control; interceptors provide observation.

---

#### `docs/specs/features/F24-chaos-engineering/signalr-protocol.md` (1777 lines)

SignalR contract for chaos panel over `/hub/playground` hub.

**Key patterns for F27:**
- Hub naming: shared `/hub/playground` (not a separate hub)
- Client→Server RPC: method naming convention `ChaosXxx` (F27 would use `QaXxx`)
- Server→Client events: streaming via `ChannelReader<TopicEvent>`
- Registration pattern: subscribe to specific topics by name
- Reconnection: automatic with snapshot hydration on reconnect

**F27 will need:**
- New RPC methods: `QaStartRun`, `QaAbortRun`, `QaGetResults`, `QaSubscribeEvents`
- New server→client events: `QaScenarioStarted`, `QaExpectationMatched`, `QaScenarioCompleted`, `QaRunCompleted`
- Integration with existing topic streaming (reuse, don't duplicate)

---

### 1.7 EDOG CLI

#### `src/backend/edog.py` (257 lines)

Python config/token/devmode helper.

**Key members:**
- `get_config_path()`: `104-106`
- `load_config()`: `109-118`
- `save_config()`: `121-134`
- `get_workload_dev_mode_path()`: `140-171`
- `read_workload_dev_mode_config()`: `174-194`
- `write_workload_dev_mode_config()`: `197-218`
- `check_capacity_sync()`: `221-241`
- `sync_capacity_from_workload()`: `244-257`

**F27 reuse:** Config discovery for scenario execution (where is the FLT build? dev-mode config?). CLI entry point for `edog qa run <PR-url>` command.

**Gaps:** This file is config-sync only. F27 needs a new CLI subcommand and orchestration logic (diff fetch, scenario generation, execution, result reporting).

---

### 1.8 F27 Existing Spec

#### `docs/specs/features/F27-qa-testing/spec.md` (1221 lines)

The existing monolithic spec defines the full F27 vision.

**Key sections audited (§1-§4):**
- §1 Product Vision (`11-35`): Problem statement, personas, success metrics
- §2 User Journey (`38-96`): 7-step flow from PR input to PR comment posting
- §3 Code Understanding Engine (`99-225`): Five-layer engine — code-review-graph + Graphify (structural), OmniSharp/Roslyn (semantic), GPT-5.4-pro (reasoning), Runtime DI (ground truth). Full analysis in `research/viability-analysis.md`
- §4 Scenario Model (`228-420`): Full JSON schema with `SetupStep`, `Stimulus`, `Expectation`, `Matcher` definitions

**Key design decisions from spec:**
- Scenarios have 5 categories: `happy_path`, `error_path`, `edge_case`, `regression`, `performance`
- Expectations reference interceptor topics directly (enum matches `EdogTopicRouter` topics)
- Setup steps integrate with F24 chaos rules (`chaos_rule`, `flag_override`, `state_seed`, `wait`)
- Stimulus types: `http_request`, `signalr_invoke`, `dag_trigger`, `file_event`, `timer_tick`
- Matchers support: `field_equals`, `field_contains`, `field_regex`, `field_gt/lt/gte/lte`, `nested`

---

## §2: Data Source Mapping

### 2.1 Interceptor Event Schema Registry

Every interceptor publishes anonymous objects to `EdogTopicRouter.Publish()`. Below is the complete schema for each topic, extracted from actual source code.

#### Topic: `http` (buffer: 2000)

**Source:** `EdogHttpPipelineHandler.cs:67-78`

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method (GET, POST, PUT, DELETE) |
| `url` | string | Redacted URL (SAS tokens stripped) |
| `statusCode` | int | HTTP response status code |
| `durationMs` | double | Round-trip latency (ms, 2dp) |
| `requestHeaders` | Dictionary | Redacted request headers |
| `responseHeaders` | Dictionary | Response headers |
| `responseBodyPreview` | string | Text body, max 4KB |
| `httpClientName` | string | Named HttpClient identifier |
| `correlationId` | string | From request/response headers |

**F27 assertions:** URL pattern matching, status code validation, timing bounds, header presence, body content matching.

---

#### Topic: `token` (buffer: 1000)

**Sources:** `EdogTokenInterceptor.cs:63-76` + `EdogTokenLifecycleInterceptor.cs:44-228`

**Sub-events (via `@event` field):**

| Event | Key Fields |
|-------|-----------|
| `OboExchange` | `provider`, `audience`, `tenantId`, `durationMs`, `success`, `errorType` |
| `TokenAcquired` | `provider`, `resource`, `tenantId`, `durationMs`, `success`, `cacheInference` |
| `TokenCached` | `provider`, `resource`, `tenantId`, `expiresInMinutes` |
| `TokenUpdated` | `provider`, `resource`, `tenantId`, `originalExpiresInMinutes`, `newExpiresInMinutes` |
| `TokenEvicted` | `provider`, `resource`, `tenantId`, `reason` |
| *(from TokenInterceptor)* | `authScheme`, `tokenType`, `audience`, `expiresIn`, `issuedAt`, `httpClientName`, `url` |

**F27 assertions:** Token acquisition success/failure, cache behavior, OBO exchange validation, expiry timing.

---

#### Topic: `flag` (buffer: 1000)

**Source:** `EdogFeatureFlighterWrapper.cs:43-51`

| Field | Type | Description |
|-------|------|-------------|
| `flagName` | string | Feature flag name |
| `tenantId` | string | Nullable |
| `capacityId` | string | Nullable |
| `workspaceId` | string | Nullable |
| `result` | bool | Flag evaluation result |
| `durationMs` | double | Evaluation time |

**F27 assertions:** Flag value validation, flag evaluation occurrence, scoping verification.

---

#### Topic: `perf` (buffer: 5000)

**Source:** `EdogPerfMarkerCallback.cs:59-66`

| Field | Type | Description |
|-------|------|-------------|
| `operationName` | string | Perf marker name |
| `durationMs` | double | Operation duration |
| `result` | string | Success/failure |
| `dimensions` | Dictionary | Custom dimensions |
| `correlationId` | string | From dimensions |

**F27 assertions:** Performance regression detection, operation timing bounds, completion verification.

---

#### Topic: `spark` (buffer: 200)

**Source:** `EdogSparkSessionInterceptor.cs:67-100`

| Field | Type | Description |
|-------|------|-------------|
| `sessionTrackingId` | string | `edog-spark-{N}` |
| `@event` | string | "Created" or "Error" |
| `tenantId` | Guid | Tenant ID |
| `workspaceId` | string | Workspace GUID |
| `artifactId` | string | Artifact GUID |
| `iterationId` | string | FLT iteration ID |
| `workspaceName` | string | Display name |
| `artifactName` | string | Display name |
| `durationMs` | double | Creation time |
| `error` | string | Null on success |

**F27 assertions:** Session creation success, timing bounds, error classification.

---

#### Topic: `retry` (buffer: 500)

**Source:** `EdogRetryInterceptor.cs:186-200, 223-235`

| Field | Type | Description |
|-------|------|-------------|
| `endpoint` | string | API endpoint or `Notebook:id/Workspace:id` |
| `statusCode` | int | HTTP status (429, 430, etc.) |
| `retryAttempt` | int | Current attempt number |
| `totalAttempts` | int | Maximum attempts |
| `waitDurationMs` | double | Delay between retries |
| `strategyName` | string | "ExponentialBackoff", "NotebookContentRetry", etc. |
| `reason` | string | Failure reason |
| `isThrottle` | bool | Throttling detected |
| `retryAfterMs` | double | Server-suggested delay |
| `iterationId` | string | FLT iteration correlation |

**F27 assertions:** Retry count validation, strategy verification, throttle handling, delay compliance.

---

#### Topic: `cache` (buffer: 2000)

**Source:** `EdogCacheInterceptor.cs:46-56`

| Field | Type | Description |
|-------|------|-------------|
| `cacheName` | string | Cache identifier |
| `operation` | string | "Get", "Set", etc. |
| `key` | string | Cache key |
| `hitOrMiss` | string | Nullable |
| `valueSizeBytes` | long | Nullable |
| `ttlSeconds` | int | Nullable |
| `durationMs` | double | Operation time |
| `evictionReason` | string | Nullable |

**F27 assertions:** Cache hit/miss validation, TTL verification, operation sequence.

---

#### Topic: `fileop` (buffer: 2000)

**Source:** `EdogFileSystemInterceptor.cs:252-262`

| Field | Type | Description |
|-------|------|-------------|
| `operation` | string | "Read", "Write", "Delete", "List", "Exists" |
| `path` | string | File/directory path |
| `contentSizeBytes` | long | Size (or item count for List) |
| `durationMs` | double | Operation time |
| `hasContent` | bool | Content present |
| `contentPreview` | string | First N chars of text |
| `ttlSeconds` | long | TTL if applicable |
| `iterationId` | string | FLT iteration correlation |

**F27 assertions:** File existence, write/delete verification, content matching, path pattern validation.

---

#### Topic: `catalog` (buffer: 200)

**Source:** `EdogCatalogInterceptor.cs:52-140`

| Sub-event | Key Fields |
|-----------|-----------|
| `CatalogDiscoveryStarted` | `workspaceId`, `artifactId`, `artifactName`, `hasMLVFilter`, `extendedLineage` |
| `CatalogDiscoveryCompleted` | `workspaceId`, `artifactId`, `durationMs`, `totalTables`, `materializedLakeViews`, `shortcuts`, `faulted`, `regular` |
| `CatalogDiscoveryFailed` | `workspaceId`, `artifactId`, `durationMs`, `errorType`, `errorMessage` (truncated 500 chars) |

**F27 assertions:** Discovery completion, entity count validation, error handling.

---

#### Topic: `dag` (buffer: 500)

**Source:** `EdogDagExecutionInterceptor.cs:92-107, 167-207`

| Sub-event | Key Fields |
|-----------|-----------|
| `DagTerminal` | `dagId`, `iterationId`, `status`, `totalNodes`, `completedNodes`, `failedNodes`, `skippedNodes`, `parallelLimit`, `durationMs`, `errorCode`, `errorMessage`, `errorSource` |
| `NodeStarted` | `dagId`, `nodeId`, `nodeName`, `nodeType`, `iterationId` |
| `NodeCompleted` | `dagId`, `nodeId`, `nodeName`, `nodeType`, `iterationId`, `durationMs`, `status` |
| `NodeFailed` | `dagId`, `nodeId`, `nodeName`, `nodeType`, `iterationId`, `durationMs`, `errorCode`, `errorMessage` |

**F27 assertions:** DAG completion status, per-node outcomes, node ordering, duration bounds, error classification.

---

#### Topic: `flt-ops` (buffer: 300)

**Source:** `EdogFltOpsInterceptor.cs:85-896`

**Common event structure:**

| Field | Type | Description |
|-------|------|-------------|
| `@event` | string | Operation result name (e.g., "RefreshTriggerUpserted") |
| `operation` | string | Operation category (e.g., "RefreshTrigger") |
| `action` | string | CRUD action (e.g., "CreateOrUpdate") |
| `workspaceId` | string | Workspace GUID |
| `durationMs` | long | Operation time |
| `success` | bool | Outcome |
| `errorType` | string | On failure only |

**Operations covered:** RefreshTrigger (Create/Update, List), MLVDefinition (Create, Get, Update, Delete, List, GetRecovery, ListRecoveryFileIds, DeleteRecovery, CreateFileSystem), ReportState (Initialize, Update, TryGet, Close), TableMaintenance (CreateClient)

**F27 assertions:** Operation success/failure, CRUD sequencing, duration bounds, error classification.

---

#### Topics: `log` (10000), `telemetry` (5000)

**Sources:** `EdogLogServer.cs:174-224`, `EdogLogModels.cs:16-82`

**`log` events use `LogEntry`:**
| Field | Type |
|-------|------|
| `Timestamp` | DateTime |
| `Level` | string |
| `Message` | string |
| `Component` | string |
| `RootActivityId` | string |
| `EventId` | string |
| `CustomData` | Dictionary |
| `IterationId` | string |
| `CodeMarkerName` | string |

**`telemetry` events use `TelemetryEvent`:**
| Field | Type |
|-------|------|
| `Timestamp` | DateTime |
| `ActivityName` | string |
| `ActivityStatus` | string |
| `DurationMs` | long |
| `ResultCode` | string |
| `CorrelationId` | string |
| `Attributes` | Dictionary |
| `UserId` | string |
| `IterationId` | string |

**F27 assertions:** Log pattern presence/absence, telemetry activity completion, error message matching, timing validation.

---

#### Topics: `di` (100), `capacity` (500), `nexus` (100)

- **`di`**: Published by `EdogDiRegistryCapture.cs:126` — static DI snapshot for component mapping
- **`capacity`**: Published externally — capacity sync events
- **`nexus`**: Published by `EdogNexusAggregator.cs:469,476` — aggregated system snapshots

These topics are informational/contextual — unlikely to be direct assertion targets but useful for scenario context enrichment.

---

### 2.2 SignalR Message Types (Reusable from F24)

Based on `docs/specs/features/F24-chaos-engineering/signalr-protocol.md`:

| Pattern | F24 Usage | F27 Adaptation |
|---------|-----------|----------------|
| Topic subscription | `SubscribeTopic(topic)` → `ChannelReader<TopicEvent>` stream | Reuse as-is for filtered scenario event observation |
| Snapshot hydration | `GetBuffer(topic).GetSnapshot()` on subscribe | Reuse for pre-stimulus baseline capture |
| RPC method naming | `ChaosCreateRule`, `ChaosDeleteRule`, etc. | `QaStartRun`, `QaAbortRun`, `QaGetResults` |
| Server→Client push | `ChaosRuleActivated`, `ChaosRuleFired` | `QaScenarioStarted`, `QaExpectationMatched`, `QaRunCompleted` |
| Hub sharing | All on `/hub/playground` | Add F27 methods to same hub |
| Reconnection | Auto-reconnect with snapshot rehydration | Reuse — scenario state must survive reconnect |

### 2.3 C# Models

**Existing models that F27 builds on:**

| Model | File | Role in F27 |
|-------|------|-------------|
| `TopicEvent` | `TopicEvent.cs:17-30` | Event envelope for all assertion matching |
| `TopicBuffer` | `TopicBuffer.cs:20-74` | Snapshot + live stream for scenario windows |
| `LogEntry` | `EdogLogModels.cs:16-46` | Log-based assertions |
| `TelemetryEvent` | `EdogLogModels.cs:51-82` | Telemetry assertions |

**Models F27 needs to create:**

| Model | Purpose |
|-------|---------|
| `QaScenario` | Typed C# representation of the JSON schema from spec §4 |
| `QaExpectation` | Individual assertion with matcher + result |
| `QaScenarioResult` | Execution outcome: pass/fail, matched expectations, evidence |
| `QaRunContext` | Run metadata: PR info, scenario set, execution state |
| `QaEventMatcher` | Field-level matching engine against `TopicEvent.Data` |

### 2.4 Frontend State Patterns

Based on `state.js` analysis:

| Pattern | Current Implementation | F27 Adaptation |
|---------|----------------------|----------------|
| Ring buffer | `RingBuffer` class (`state.js:8-63`) | Scenario result buffer (fixed-size, append-only) |
| Filter index | `FilterIndex` class (`state.js:67-121`) | Expectation status filter (pass/fail/pending) |
| Stream mode | `LogViewerState._paused` | Run mode (idle/running/reviewing) |
| Stats tracking | `LogViewerState.stats` | Run statistics (pass/fail/skip counts) |
| Tab switching | `main.js:switchTab()` (`main.js:780-792`) | QA Testing panel registration |
| SignalR handling | `main.js:handleWebSocketMessage()` (`main.js:552-572`) | QA event processing |

---

## §3: Industry Research

### 3.1 GitHub Actions + Test Frameworks (CI/CD PR Validation)

**Core pattern:** PR triggers workflow → build → test → report status check.

**How it works:**
- Workflow files define test matrix (unit, integration, E2E)
- Tests run in isolated containers with mocked dependencies
- Results posted as PR status checks (pass/fail with links)
- Code coverage gates enforce minimum thresholds
- SARIF reports surface static analysis findings inline

**What F27 can adapt:**
- **Status check pattern** — F27 results should appear as a PR status check, not just a comment
- **Matrix execution** — scenarios can run in parallel across category dimensions
- **Annotation pattern** — expectations map to specific code locations (like SARIF)

**What's different about F27:**
- F27 runs **inside the process**, not in a CI container — no environment setup needed
- F27 generates tests dynamically from the diff, not from a static test suite
- F27 observes internal behavior (interceptor events), not just external outputs
- Latency is seconds, not minutes — no container spin-up or artifact caching

---

### 3.2 Replay-Based Testing (Cypress, Playwright)

**Core pattern:** Record user interactions → replay with assertions → diff against baseline.

**How it works:**
- Test recorder captures DOM events, network requests, screenshots
- Replay engine re-executes the sequence and compares outcomes
- Time-travel debugging shows state at each step
- Network stubbing replaces real backends with recorded responses
- Visual regression compares screenshots pixel-by-pixel

**What F27 can adapt:**
- **Network recording/stubbing** — F27's HTTP interceptor already records; chaos engine can stub
- **Step-by-step execution** — scenarios execute sequentially with state between steps
- **Evidence capture** — every assertion should link to the raw event that matched/failed
- **Time-travel debugging** — topic buffer snapshots enable "what was the state at time T?"

**What's different about F27:**
- F27 tests server-side behavior, not browser DOM interactions
- Replay is not of user actions but of backend event sequences
- F27's "recording" is always on (interceptors), not opt-in
- Assertions are against structured events, not visual screenshots

---

### 3.3 Contract Testing (Pact)

**Core pattern:** Consumer defines expected API contract → provider verifies against it → mismatches break build.

**How it works:**
- Consumer writes "pact" — expected request/response pairs
- Provider runs verification: does actual implementation match contract?
- Contract broker stores and versions contracts
- Breaking changes detected before deployment
- Bi-directional: both sides contribute to the contract

**What F27 can adapt:**
- **Expectation-as-contract** — each scenario's expectations are a behavioral contract
- **Versioned contracts** — scenario sets evolve with the PR (regenerated per diff)
- **Bidirectional verification** — F27 validates both "did the right events fire?" and "did no wrong events fire?" (present + absent assertions)
- **Broker pattern** — scenario results stored and queryable across runs

**What's different about F27:**
- Contracts are generated per-PR, not maintained long-term
- F27 validates internal implementation behavior, not API surface
- Contracts include timing and ordering, not just request/response shape
- F27's "consumer" is the AI (scenario generator), not a downstream service

---

### 3.4 Mutation Testing (Stryker)

**Core pattern:** Introduce small code changes (mutations) → run tests → if tests still pass, test suite has a gap.

**How it works:**
- Mutator modifies code systematically (flip conditions, change operators, remove statements)
- Test suite runs against each mutant
- "Killed" mutants = tests caught the change; "survived" = test gap
- Mutation score = killed / total mutants
- Results highlight which code paths lack test coverage

**What F27 can adapt:**
- **Mutation-guided scenario quality** — after initial scenario execution, mutate the diff (simulate alternative changes) and re-run to test scenario sensitivity
- **Confidence scoring** — scenario confidence correlates with how many mutations it catches
- **Coverage gap detection** — scenarios that don't detect obvious mutations need improvement
- **Incremental approach** — start with the actual diff, then expand to mutations of the diff

**What's different about F27:**
- F27 tests a specific PR diff, not the entire codebase
- Mutations would be applied to the diff itself (meta-level), not random code
- F27's assertions are behavioral (event stream), not output-based
- Much faster feedback loop — interceptor-based observation is real-time

---

### 3.5 Runtime Validation (Chaos Engineering Tools — Gremlin, LitmusChaos)

**Core pattern:** Inject controlled failures into running system → observe behavior → verify resilience.

**How it works:**
- Fault injection: network partitions, latency spikes, CPU pressure, disk failures
- Steady-state hypothesis: define what "normal" looks like before injection
- Blast radius containment: scope faults to specific services/zones
- Automated rollback: stop experiment if health degrades below threshold
- Game days: scheduled chaos experiments with human oversight

**What F27 can adapt:**
- **Steady-state hypothesis** → F27 "happy path" scenario: this is what normal looks like
- **Fault injection** → F27 setup steps with F24 chaos rules: inject fault → verify resilience
- **Blast radius scoping** → F27 impact zones from Roslyn: scope scenarios to affected code paths
- **Auto-rollback** → F27 teardown steps: clean up injected faults after each scenario
- **Health checks** → F27 nexus topic: system health baseline before and after scenario execution

**What's different about F27:**
- F27 runs in development, not production — lower risk, different failure modes
- F27's chaos integration is code-level (interceptor wrapping), not infrastructure-level (network partitions)
- F27 validates code changes (PR), not system resilience (steady-state)
- F27 combines generation (AI creates tests) with execution (chaos runs them) — unique fusion

---

### Industry Research Summary: F27's Unique Position

| Dimension | Traditional Tools | F27's Approach |
|-----------|------------------|----------------|
| Test authoring | Manual or recorded | AI-generated from PR diff |
| Execution environment | CI container or browser | In-process (inside FLT) |
| Observation mechanism | Test assertions or DOM queries | Interceptor event streams |
| Injection mechanism | Mocks, stubs, network tools | F24 chaos rules + interceptor wiring |
| Feedback latency | Minutes (CI) or seconds (E2E) | Sub-second (in-process events) |
| Test lifecycle | Long-lived test suites | Ephemeral per-PR scenarios |
| Coverage model | Code coverage (lines/branches) | Behavioral coverage (event patterns) |

F27 combines the **generation intelligence** of AI, the **observation depth** of in-process interceptors, the **injection control** of chaos engineering, and the **contract precision** of Pact — in a feedback loop that runs in seconds, not minutes.

---

*End of P0 Foundation Research. This document serves as the authoritative reference for all subsequent F27 design and implementation phases.*
