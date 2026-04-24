# C01: Nexus Data Contracts — `EdogNexusModels.cs`

> **Component:** C01 — Nexus Data Contracts
> **Feature:** F26 — Nexus Real-Time Cross-Workload Dependency Graph
> **Priority:** P1
> **File:** `src/backend/DevMode/EdogNexusModels.cs`
> **Author:** Sana (architecture agent)
> **Status:** SPEC

---

## 0. Preamble

This spec defines every data type that flows through the F26 Nexus pipeline — from normalized interceptor input to the snapshot envelope published on the `nexus` SignalR topic. Every type is grounded in the existing DevMode codebase conventions and verified against real source files.

### 0.1 Conventions (verified from source)

| Convention | Evidence |
|---|---|
| `#nullable disable` | Every DevMode `.cs` file (`EdogTopicRouter.cs:5`, `EdogHttpPipelineHandler.cs:5`, `TopicEvent.cs:5`) |
| `#pragma warning disable` | Same files — DevMode-only blanket suppression |
| Namespace `Microsoft.LiveTable.Service.DevMode` | All DevMode files (`EdogTopicRouter.cs:8`, `TopicEvent.cs:8`) |
| Serialization: **System.Text.Json** with `JsonNamingPolicy.CamelCase` | `EdogLogServer.cs:37` — `new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }` |
| SignalR protocol: **default JSON** (no MessagePack) | `EdogLogServer.cs:78` — `builder.Services.AddSignalR()` with no `.AddMessagePackProtocol()` |
| Event payloads: anonymous objects published via `EdogTopicRouter.Publish()` | `EdogHttpPipelineHandler.cs:67-78`, `EdogTokenInterceptor.cs:63-72`, `EdogCacheInterceptor.cs:46-56` |
| Typed models exist for complex types | `EdogLogModels.cs` — `LogEntry`, `TelemetryEvent` with public properties |
| `TopicEvent` envelope wraps all payloads | `TopicEvent.cs:17-30` — `{ SequenceId, Timestamp, Topic, Data }` |
| `TopicBuffer` ring buffer per topic | `TopicBuffer.cs:20` — bounded `ConcurrentQueue<TopicEvent>` + live `Channel<TopicEvent>` |

### 0.2 Why typed models (not anonymous objects)

Existing interceptors use anonymous objects because each interceptor is self-contained and its payload shape is implicitly defined at the single `Publish()` call site. Nexus is different:

1. **Multiple producers**: `EdogNexusClassifier` and `EdogNexusAggregator` both create `NexusNormalizedEvent` instances.
2. **Cross-component contracts**: the aggregator's output (`NexusSnapshot`) is consumed by the SignalR hub, session store, and frontend — schema drift is a triage killer.
3. **Persistence**: `EdogNexusSessionStore` must serialize/deserialize snapshots; anonymous objects don't round-trip through `System.Text.Json` reliably.

Therefore: **typed C# classes with public get/set properties**, matching the `LogEntry`/`TelemetryEvent` pattern in `EdogLogModels.cs`.

---

## 1. NexusDependencyId

### 1.1 Trigger
Created at classification time by `EdogNexusClassifier.Classify()` when an event from any source topic (`http`, `spark`, `token`, `retry`, `cache`, `fileop`) is mapped to a canonical dependency.

### 1.2 Expected behavior
A finite, closed set of string constants representing the 9 canonical dependency categories in V1. All unknown or unclassifiable traffic maps to `"unknown"`. This is **not** an enum — it is a static string-constant class to allow safe serialization and future extensibility without breaking wire format.

**Canonical IDs (V1):**

| ID | Source topic(s) | URL/signal pattern |
|---|---|---|
| `spark-gts` | `http`, `spark` | `*/spark/*`, `*/livysessions/*` (`spec.md:93-94`) |
| `fabric-api` | `http` | `*/workspaces/*`, `*/lakehouses/*` (`spec.md:98`) |
| `platform-api` | `http` | `*pbidedicated*`, `*powerbi-df*` (`spec.md:97`) |
| `auth` | `http`, `token` | `*/generatemwctoken`, `*/token` (`spec.md:96`) |
| `capacity` | `http` | `*/capacities/*` (`spec.md:95`) or HTTP 430 status code from any URL. **Note:** the `capacity:500` topic buffer in `EdogTopicRouter.cs:39` exists but nothing publishes to it in V1 — it is reserved for future use. V1 capacity signals come exclusively from HTTP 430 ("Spark Job Capacity Throttling") responses flowing through the `http` topic. |
| `cache` | `cache` | Cache interceptor events (`EdogCacheInterceptor.cs:46-56`) |
| `retry-system` | `retry` | Retry interceptor events (`EdogRetryInterceptor.cs:186-200`) |
| `filesystem` | `fileop` | File system interceptor events (`EdogFileSystemInterceptor.cs:252-262`) |
| `unknown` | `http` | Everything that doesn't match a known pattern |

### 1.3 Technical mechanism

```csharp
/// <summary>
/// Canonical dependency identifiers for the Nexus dependency graph (V1).
/// String constants — not an enum — for safe JSON serialization and forward extensibility.
/// </summary>
public static class NexusDependencyId
{
    public const string SparkGts     = "spark-gts";
    public const string FabricApi    = "fabric-api";
    public const string PlatformApi  = "platform-api";
    public const string Auth         = "auth";
    public const string Capacity     = "capacity";
    public const string Cache        = "cache";
    public const string RetrySystem  = "retry-system";
    public const string Filesystem   = "filesystem";
    public const string Unknown      = "unknown";

    /// <summary>All known IDs for validation and iteration.</summary>
    public static readonly string[] All = new[]
    {
        SparkGts, FabricApi, PlatformApi, Auth, Capacity,
        Cache, RetrySystem, Filesystem, Unknown,
    };
}
```

### 1.4 Source code path
- Classification patterns: `docs/specs/features/F26-nexus-dependency-graph/spec.md:93-100`
- Design-approved list: `docs/superpowers/specs/2026-04-24-nexus-design.md:92-101`
- HTTP URL source: `EdogHttpPipelineHandler.cs:51` (URL captured), `EdogHttpPipelineHandler.cs:67-78` (published)

### 1.5 Edge cases
- **Unknown accumulation**: if `unknown` grows disproportionately, the classifier needs tuning. Aggregator should track `unknown` volume separately for observability.
- **Overlapping patterns**: a URL may match multiple patterns (e.g., a spark URL with `/workspaces/` prefix). Classifier must use **first-match-wins** with most-specific patterns ordered first.
- **Future IDs**: new IDs (e.g., `notebook`) can be added without schema break — consumers must tolerate unknown strings gracefully.

### 1.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusClassifier.Classify()` | `EdogNexusAggregator` (via `NexusNormalizedEvent.DependencyId`) |
| — | `tab-nexus.js` (node rendering key) |
| — | `EdogNexusSessionStore` (serialization) |

### 1.7 Priority
**P0** — every other Nexus type depends on this. Must be implemented first.

---

## 2. NexusNormalizedEvent

### 2.1 Trigger
Created by `EdogNexusClassifier` when processing a raw `TopicEvent` from any source topic. One `TopicEvent` produces exactly one `NexusNormalizedEvent`. The classifier subscribes to the live channels of: `http`, `spark`, `token`, `retry`, `cache`, `fileop`.

### 2.2 Expected behavior
The unified internal type that the aggregator's reducer consumes. Normalizes the heterogeneous shapes from 6 different interceptors into one canonical form.

**Invariants:**
- `DependencyId` is always one of `NexusDependencyId.All` — never null, never empty.
- `Timestamp` is always UTC.
- `LatencyMs` is non-negative; 0.0 if not applicable (e.g., retry events that are enrichment-only).
- `IsError` is true when `StatusCode >= 400` or the source event reports an error.
- `SourceTopic` is the literal topic name from `TopicEvent.Topic` — enables provenance tracing.

### 2.3 Technical mechanism

```csharp
/// <summary>
/// Normalized event — internal reducer input for the Nexus aggregator.
/// One per source-topic event, classified and flattened into a canonical shape.
/// </summary>
public sealed class NexusNormalizedEvent
{
    /// <summary>Canonical dependency ID (from <see cref="NexusDependencyId"/>).</summary>
    public string DependencyId { get; set; }

    /// <summary>Originating topic name (http, spark, token, retry, cache, fileop).</summary>
    public string SourceTopic { get; set; }

    /// <summary>UTC timestamp of the original event.</summary>
    public DateTimeOffset Timestamp { get; set; }

    /// <summary>HTTP method (GET, POST, etc.) or null for non-HTTP events.</summary>
    public string Method { get; set; }

    /// <summary>HTTP status code, or 0 for non-HTTP events.</summary>
    public int StatusCode { get; set; }

    /// <summary>Latency in milliseconds. 0 if not applicable.</summary>
    public double LatencyMs { get; set; }

    /// <summary>True if the event represents an error condition.</summary>
    public bool IsError { get; set; }

    /// <summary>
    /// True if the event represents a throttling response (HTTP 429 or 430).
    /// Enables the aggregator to distinguish throttle storms from other errors.
    /// </summary>
    public bool IsThrottled { get; set; }

    /// <summary>
    /// Throttle classification: "capacity-430" for GTS capacity throttling (HTTP 430),
    /// "rate-limit-429" for standard rate limiting (HTTP 429), or null if not throttled.
    /// </summary>
    public string ThrottleType { get; set; }

    /// <summary>
    /// GTS operation phase for spark-gts events: "submit" (POST/PUT to /transforms/),
    /// "polling" (GET /transforms/{id}), "result-fetch" (GET /transforms/{id}/result),
    /// or null for non-GTS events. Enables the aggregator to track polling count per
    /// transform, average polling interval, and total polling duration.
    /// </summary>
    public string OperationPhase { get; set; }

    /// <summary>
    /// FLT error code extracted from HTTP response body (e.g., "SPARK_SESSION_ACQUISITION_FAILED",
    /// "MV_NOT_FOUND", "CONCURRENT_REFRESH"). Null if no error or error code not parseable.
    /// See <see cref="NexusErrorClassification"/> for the known error taxonomy.
    /// </summary>
    public string ErrorCode { get; set; }

    /// <summary>
    /// Severity classification of the error: "user" (no retry, user must fix),
    /// "system" (retry up to 3x, engineering attention), "transient" (exponential backoff,
    /// self-healing expected), or null if no error. Derived from ErrorCode via
    /// <see cref="NexusErrorClassification.Classify"/>.
    /// </summary>
    public string ErrorSeverity { get; set; }

    /// <summary>Retry attempt count from retry enrichment. 0 if no retry.</summary>
    public int RetryCount { get; set; }

    /// <summary>Correlation ID from HTTP headers, or null.</summary>
    public string CorrelationId { get; set; }

    /// <summary>Redacted URL path or operation descriptor for drill-through context.</summary>
    public string EndpointHint { get; set; }

    /// <summary>FLT iteration ID for DAG correlation, or null.</summary>
    public string IterationId { get; set; }
}
```

### 2.4 Source code path — field provenance

| Field | Source interceptor | Source field | File:Line |
|---|---|---|---|
| `DependencyId` | Classifier output | (computed) | — |
| `SourceTopic` | `TopicEvent.Topic` | `Topic` | `TopicEvent.cs:26` |
| `Timestamp` | `TopicEvent.Timestamp` | `Timestamp` | `TopicEvent.cs:22` |
| `Method` | HTTP interceptor | `method` | `EdogHttpPipelineHandler.cs:50,69` |
| `StatusCode` | HTTP interceptor | `statusCode` | `EdogHttpPipelineHandler.cs:63,71` |
| `LatencyMs` | HTTP interceptor | `durationMs` | `EdogHttpPipelineHandler.cs:72` |
| `IsError` | Derived | `statusCode >= 400` or spark `event == "Error"` | `EdogHttpPipelineHandler.cs:63`, `EdogSparkSessionInterceptor.cs:70` |
| `IsThrottled` | Derived | `statusCode == 429 \|\| statusCode == 430` | `EdogHttpPipelineHandler.cs:63,71` |
| `ThrottleType` | Derived | `statusCode == 430` → `"capacity-430"`, `statusCode == 429` → `"rate-limit-429"`, else `null` | `EdogHttpPipelineHandler.cs:63,71` |
| `OperationPhase` | Derived by classifier | POST/PUT to `/transforms/` → `"submit"`, GET `/transforms/{id}` → `"polling"`, GET `/transforms/{id}/result` → `"result-fetch"` | `EdogHttpPipelineHandler.cs:50,69` |
| `ErrorCode` | HTTP interceptor (body) | Extracted from `responseBodyPreview` via regex match for FLT error code prefixes | `EdogHttpPipelineHandler.cs:65,75` |
| `ErrorSeverity` | Derived | `NexusErrorClassification.Classify(errorCode)` | — (computed from `ErrorCode`) |
| `RetryCount` | Retry interceptor | `retryAttempt` | `EdogRetryInterceptor.cs:134,190` |
| `CorrelationId` | HTTP interceptor | `correlationId` | `EdogHttpPipelineHandler.cs:53,77` |
| `EndpointHint` | HTTP URL (redacted) or fileop path | `url` / `path` | `EdogHttpPipelineHandler.cs:51,70`, `EdogFileSystemInterceptor.cs:254` |
| `IterationId` | Spark/retry/fileop interceptors | `iterationId` | `EdogSparkSessionInterceptor.cs:74`, `EdogRetryInterceptor.cs:163,197`, `EdogFileSystemInterceptor.cs:261` |

### 2.5 Edge cases
- **Retry events without HTTP context**: retry events are parsed from logs (`EdogRetryInterceptor.cs:16-25`), not from HTTP responses. They carry `endpoint` (node descriptor) but not `url`. The classifier should set `DependencyId = NexusDependencyId.RetrySystem` and populate `EndpointHint` from the retry `endpoint` field.
- **Token events without latency**: `EdogTokenInterceptor` does not measure its own latency — it piggybacks on the HTTP call that carries the token. Set `LatencyMs = 0` for pure token events.
- **Spark error events**: `event == "Error"` has `durationMs` (time-to-failure) and `error` message. Set `IsError = true`, map `LatencyMs` from `durationMs`.
- **Cache events**: no HTTP method/status. Set `Method = null`, `StatusCode = 0`. Latency comes from `durationMs` (`EdogCacheInterceptor.cs:54`).
- **Null fields**: all string fields nullable. Consumers must tolerate `null` for `Method`, `CorrelationId`, `EndpointHint`, `IterationId`, `ThrottleType`, `OperationPhase`, `ErrorCode`, `ErrorSeverity`.
- **HTTP 430 capacity throttling**: when `StatusCode == 430`, the classifier reclassifies the event as `capacity` (regardless of URL match), sets `IsThrottled = true`, `ThrottleType = "capacity-430"`. The `capacity` topic buffer (`EdogTopicRouter.cs:39`) is empty in V1 — all capacity signals come from HTTP 430 responses.
- **HTTP 429 rate limiting**: when `StatusCode == 429`, `IsThrottled = true`, `ThrottleType = "rate-limit-429"`. The dependency ID is NOT overridden — the event retains whatever dependency the URL matched (rate limiting can happen on any dependency).
- **GTS polling phases**: for `spark-gts` events, `OperationPhase` distinguishes submit/polling/result-fetch. Enables the aggregator to track: polling count per transform, average polling interval, total polling duration. Non-GTS events have `OperationPhase = null`.
- **Error code extraction**: `ErrorCode` is best-effort — extracted from `responseBodyPreview` (`EdogHttpPipelineHandler.cs:75`) only when `StatusCode >= 400`. If the response body doesn't contain a recognizable FLT error code pattern (prefixes: `FLT_`, `FMLV_`, `MLV_`, or known bare codes like `MV_NOT_FOUND`), `ErrorCode = null`.
- **Error severity mapping**: `ErrorSeverity` is derived from `ErrorCode` via `NexusErrorClassification.Classify()`. Unknown error codes map to `null` severity (rely on HTTP status alone).

### 2.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusClassifier` (normalizes raw topic events) | `EdogNexusAggregator.Reduce()` |

**Not published to any topic** — this is an internal type. It flows in-process from classifier to aggregator only.

### 2.7 Priority
**P0** — the aggregator cannot function without a normalized input type.

---

## 3. NexusHealthStatus

### 3.1 Trigger
Computed by `EdogNexusAggregator` per edge during each reducer cycle, based on error rate, latency baseline delta, and retry rate thresholds.

### 3.2 Expected behavior
A three-value health classification. String constants for JSON-safe serialization.

| Value | Meaning | Visual encoding (design spec `§6.2`) |
|---|---|---|
| `healthy` | Within baseline tolerances | Green edge |
| `degraded` | Latency or error rate above warning threshold | Yellow edge + pulse |
| `critical` | Sustained errors, extreme latency, or throttle storm | Red edge + pulse |

### 3.3 Technical mechanism

```csharp
/// <summary>
/// Health status for a Nexus dependency edge.
/// String constants for JSON serialization stability.
/// </summary>
public static class NexusHealthStatus
{
    public const string Healthy  = "healthy";
    public const string Degraded = "degraded";
    public const string Critical = "critical";
}
```

### 3.4 Source code path
- Design-approved values: `docs/superpowers/specs/2026-04-24-nexus-design.md:144,173-175`
- Edge color encoding: `docs/superpowers/specs/2026-04-24-nexus-design.md:173`

### 3.5 Edge cases
- **No data yet**: before any events arrive for a dependency, the edge should not exist — not be `healthy`. The aggregator only creates edges on first observed event.
- **Recovery**: a dependency that transitions from `critical` → `healthy` should update on the next snapshot cycle. No hysteresis in V1 (keep simple; consider sticky thresholds in V2).
- **Unknown dependency health**: `unknown` dependency follows the same health rules — it is not exempt.

### 3.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusAggregator` (threshold evaluation) | `NexusEdgeStats.Health` field |
| — | `tab-nexus.js` (edge color rendering) |
| — | `NexusAlert` generation logic |

### 3.7 Priority
**P0** — required by `NexusEdgeStats` and `NexusSnapshot`.

---

## 3A. NexusErrorClassification

### 3A.1 Trigger
Referenced at classification time by `EdogNexusClassifier` when an HTTP event has `statusCode >= 400` and a recognizable FLT error code is extracted from the `responseBodyPreview` field.

### 3A.2 Expected behavior
A static utility class that maps FLT error code strings to severity classifications. FLT uses 25+ classified error codes with three prefixes (`FLT_`, `FMLV_`, `MLV_`) plus bare codes (e.g., `MV_NOT_FOUND`). Each error has a severity that determines retry behavior:

| Severity | Meaning | Retry behavior |
|---|---|---|
| `user` | Configuration error, permissions, missing artifacts — user must fix | No retry |
| `system` | Internal failure, data corruption — engineering attention needed | Retry up to 3x |
| `transient` | Temporary capacity/rate issue — self-healing expected | Exponential backoff |

**Known error codes (from FLT codebase research):**

| Error Code | Severity | Description |
|---|---|---|
| `MV_NOT_FOUND` | `user` | MLV doesn't exist |
| `SOURCE_ENTITIES_UNDEFINED` | `user` | Missing source definitions |
| `CONCURRENT_REFRESH` | `user` | Refresh already running |
| `ACCESS_DENIED` | `user` | Permissions issue |
| `SOURCE_ENTITIES_CORRUPTED` | `system` | Source data corruption |
| `SOURCE_ENTITIES_MISSING` | `system` | Can't find source entities |
| `SYSTEM_ERROR` | `system` | Internal failure |
| `MLV_RESULTCODE_NOT_FOUND` | `system` | Result extraction failed |
| `SPARK_SESSION_ACQUISITION_FAILED` | `transient` | GTS/TJS session issue |
| `TOO_MANY_REQUESTS` | `transient` | Rate limiting (HTTP 429) |
| `SPARK_JOB_CAPACITY_THROTTLING` | `transient` | Capacity throttling (HTTP 430) |

### 3A.3 Technical mechanism

```csharp
/// <summary>
/// Maps FLT error codes to severity classifications.
/// Used by EdogNexusClassifier to populate ErrorSeverity on NexusNormalizedEvent.
/// </summary>
public static class NexusErrorClassification
{
    // ── Severity constants ──
    public const string User      = "user";
    public const string System    = "system";
    public const string Transient = "transient";

    // ── Known error code → severity mappings ──
    private static readonly Dictionary<string, string> KnownErrors = new(StringComparer.OrdinalIgnoreCase)
    {
        // User errors — no retry, user must fix
        ["MV_NOT_FOUND"]               = User,
        ["SOURCE_ENTITIES_UNDEFINED"]   = User,
        ["CONCURRENT_REFRESH"]          = User,
        ["ACCESS_DENIED"]               = User,

        // System errors — retry up to 3x, engineering attention
        ["SOURCE_ENTITIES_CORRUPTED"]   = System,
        ["SOURCE_ENTITIES_MISSING"]     = System,
        ["SYSTEM_ERROR"]                = System,
        ["MLV_RESULTCODE_NOT_FOUND"]    = System,

        // Transient errors — exponential backoff, self-healing
        ["SPARK_SESSION_ACQUISITION_FAILED"] = Transient,
        ["TOO_MANY_REQUESTS"]                = Transient,
        ["SPARK_JOB_CAPACITY_THROTTLING"]    = Transient,
    };

    /// <summary>
    /// Regex to extract FLT error codes from response body previews.
    /// Matches prefixed codes (FLT_xxx, FMLV_xxx, MLV_xxx) and known bare codes.
    /// </summary>
    internal static readonly Regex ErrorCodePattern = new(
        @"\b((?:FLT|FMLV|MLV)_[A-Z_]+|MV_NOT_FOUND|SOURCE_ENTITIES_\w+|CONCURRENT_REFRESH|ACCESS_DENIED|SYSTEM_ERROR|SPARK_SESSION_ACQUISITION_FAILED|SPARK_JOB_CAPACITY_THROTTLING|TOO_MANY_REQUESTS|MLV_RESULTCODE_NOT_FOUND)\b",
        RegexOptions.Compiled);

    /// <summary>
    /// Returns the severity for a known error code, or null for unrecognized codes.
    /// </summary>
    public static string Classify(string errorCode)
    {
        if (string.IsNullOrEmpty(errorCode)) return null;
        return KnownErrors.TryGetValue(errorCode, out var severity) ? severity : null;
    }
}
```

### 3A.4 Source code path
- FLT error taxonomy: discovered via codebase research across FLT service layer error handling
- HTTP response body preview: `EdogHttpPipelineHandler.cs:65,75` (`responseBodyPreview` field, first 4KB of response body)
- Error code prefixes: `FLT_`, `FMLV_`, `MLV_` are the three namespaces used across the FLT error hierarchy

### 3A.5 Edge cases
- **Unrecognized error code**: `Classify()` returns `null` — the classifier falls back to HTTP status code alone for `IsError` determination.
- **Multiple error codes in body**: the regex extracts the **first** match. FLT responses typically have a single primary error code.
- **Body preview truncation**: `CaptureBodyPreview` captures first 4KB (`EdogHttpPipelineHandler.cs:195`). Error codes appear early in JSON error responses, so truncation rarely affects extraction.
- **Future error codes**: new codes with `FLT_`/`FMLV_`/`MLV_` prefixes are captured by the regex but return `null` severity until added to `KnownErrors`. This is safe — the classifier still sets `IsError = true` based on HTTP status.
- **Case insensitivity**: `KnownErrors` uses `StringComparer.OrdinalIgnoreCase` to handle potential casing variations in response bodies.

### 3A.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusClassifier` (calls `Classify()` during normalization) | `NexusNormalizedEvent.ErrorSeverity` field |
| — | `EdogNexusAggregator` (error severity distribution per edge) |
| — | `tab-nexus.js` (error detail drill-through rendering) |

### 3A.7 Priority
**P1** — enriches error diagnostics but not blocking for core graph rendering.

---

## 4. NexusEdgeStats

### 4.1 Trigger
Computed by `EdogNexusAggregator` during each reducer cycle (target: 1 Hz, per design spec `§8.2`). One `NexusEdgeStats` per active dependency edge per snapshot window.

### 4.2 Expected behavior
Rolling per-edge statistics for a configurable window (default: 300 seconds, per design spec `§5.3:129`). The aggregator maintains these in memory and publishes them as part of `NexusSnapshot.Edges`.

**Invariants:**
- `From` is always `"flt-local"` (the FLT core node). V1 is hub-spoke; no cross-dependency edges.
- `To` is a valid `NexusDependencyId`.
- All numeric fields are non-negative.
- `ErrorRate` and `RetryRate` are ratios in `[0.0, 1.0]`.
- `BaselineDelta` is a multiplier (1.0 = at baseline, 3.0 = 3x above).
- `Health` is one of `NexusHealthStatus.{Healthy,Degraded,Critical}`.

### 4.3 Technical mechanism

```csharp
/// <summary>
/// Per-edge rolling statistics for a dependency in the Nexus graph.
/// Published as part of <see cref="NexusSnapshot.Edges"/>.
/// </summary>
public sealed class NexusEdgeStats
{
    /// <summary>Source node ID. Always "flt-local" in V1 (hub-spoke topology).</summary>
    public string From { get; set; }

    /// <summary>Target dependency ID (from <see cref="NexusDependencyId"/>).</summary>
    public string To { get; set; }

    /// <summary>Total event count in the current window.</summary>
    public int Volume { get; set; }

    /// <summary>Events per minute in the current window.</summary>
    public double ThroughputPerMin { get; set; }

    /// <summary>Median latency in milliseconds.</summary>
    public double P50Ms { get; set; }

    /// <summary>95th percentile latency in milliseconds.</summary>
    public double P95Ms { get; set; }

    /// <summary>99th percentile latency in milliseconds.</summary>
    public double P99Ms { get; set; }

    /// <summary>Error rate as a ratio [0.0, 1.0].</summary>
    public double ErrorRate { get; set; }

    /// <summary>Retry rate as a ratio [0.0, 1.0] (events with RetryCount > 0 / total).</summary>
    public double RetryRate { get; set; }

    /// <summary>Current p95 / baseline p95 ratio. 1.0 = at baseline.</summary>
    public double BaselineDelta { get; set; }

    /// <summary>Computed health status for this edge.</summary>
    public string Health { get; set; }
}
```

### 4.4 Source code path
- Design-approved edge shape: `docs/superpowers/specs/2026-04-24-nexus-design.md:134-147`
- P0 research edge-centric contract: `p0-foundation.md:108-110`
- Existing latency precedent (HTTP tab already computes p50/p95/p99): `src/frontend/js/tab-http.js:721-761`

### 4.5 Edge cases
- **Single-event windows**: when only 1 event exists, `P50 == P95 == P99 == that event's latency`. `ErrorRate` is 0.0 or 1.0. This is correct — no special-casing needed.
- **Zero-latency events**: cache or retry-enrichment events have `LatencyMs == 0`. The aggregator should **exclude zero-latency events from percentile computation** but still count them in `Volume` and `ThroughputPerMin`.
- **Baseline bootstrapping**: on first window, `BaselineDelta` should be `1.0` (at baseline). The aggregator accumulates baseline from the first N windows before computing meaningful deltas.
- **Window boundary**: use sliding window (not tumbling) to avoid sawtooth patterns in the graph. Events older than `windowSec` are evicted.
- **Overflow**: `Volume` is `int` (max 2.1B). At 1000 events/sec over 300s = 300K — safely within range. No overflow concern for V1.

### 4.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusAggregator.Reduce()` | `NexusSnapshot.Edges` |
| — | `tab-nexus.js` (edge thickness = `ThroughputPerMin`, color = `Health`) |
| — | Deep-link filters (scoped by `To` dependency) |
| — | `NexusAlert` generation (anomaly thresholds applied to `BaselineDelta`, `ErrorRate`) |

### 4.7 Priority
**P0** — the core analytical output of the aggregator.

---

## 5. NexusNodeInfo

### 5.1 Trigger
Computed by `EdogNexusAggregator` per reducer cycle. One node per observed dependency plus the fixed `flt-local` core node.

### 5.2 Expected behavior
Lightweight metadata for graph node rendering. Node size is driven by `Volume`.

**Invariants:**
- `Id` is either `"flt-local"` or a valid `NexusDependencyId`.
- `Kind` is `"core"` for `flt-local`, `"dependency"` for all others.
- `Volume` is the total event count across the snapshot window (same window as edges).

### 5.3 Technical mechanism

```csharp
/// <summary>
/// Per-node metadata for the Nexus dependency graph.
/// Published as part of <see cref="NexusSnapshot.Nodes"/>.
/// </summary>
public sealed class NexusNodeInfo
{
    /// <summary>Node identifier ("flt-local" or a <see cref="NexusDependencyId"/> value).</summary>
    public string Id { get; set; }

    /// <summary>Node kind: "core" for FLT local, "dependency" for external services.</summary>
    public string Kind { get; set; }

    /// <summary>Total event volume in the current window (drives node size).</summary>
    public int Volume { get; set; }
}
```

### 5.4 Source code path
- Design-approved node shape: `docs/superpowers/specs/2026-04-24-nexus-design.md:131-132`
- Node size = volume: `docs/superpowers/specs/2026-04-24-nexus-design.md:172`

### 5.5 Edge cases
- **No traffic to a dependency**: the node should **not** appear in the snapshot. Nodes are present only when `Volume > 0` in the current window. This prevents stale "ghost" nodes.
- **`flt-local` always present**: the core node is always included in every snapshot (even if `Volume == 0`) — it is the graph center.
- **`filesystem` visibility**: the node is always included in the data contract. The **Internals toggle is a frontend concern** — the backend publishes all nodes and the frontend hides `filesystem` when Internals is off (`runtime-view.js:314-316`).

### 5.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusAggregator` | `NexusSnapshot.Nodes` |
| — | `tab-nexus.js` (node rendering, sizing, layout ring assignment) |

### 5.7 Priority
**P1** — simple derived type, but required for snapshot completeness.

---

## 6. NexusAlert

### 6.1 Trigger
Generated by `EdogNexusAggregator` when a dependency's edge statistics cross anomaly thresholds during a reducer cycle:
- `BaselineDelta > threshold` (e.g., latency 3x above baseline)
- `ErrorRate > threshold` (e.g., > 20% errors)
- Sustained throttle storm (`RetryRate > threshold` with `isThrottle` signals)

### 6.2 Expected behavior
A point-in-time anomaly notification. Alerts are **not deduplicated** — the aggregator may emit the same alert on consecutive cycles if the condition persists. Deduplication (e.g., "show once per anomaly episode") is a **frontend concern**.

**Invariants:**
- `Severity` is `"warning"` or `"critical"` — no `"info"` level alerts.
- `DependencyId` is a valid `NexusDependencyId`.
- `Message` is a human-readable English string for toast rendering.
- `Timestamp` is UTC — when the alert was generated.

### 6.3 Technical mechanism

```csharp
/// <summary>
/// Anomaly alert generated by the Nexus aggregator when a dependency's
/// metrics cross health thresholds.
/// </summary>
public sealed class NexusAlert
{
    /// <summary>Alert severity: "warning" or "critical".</summary>
    public string Severity { get; set; }

    /// <summary>Affected dependency ID.</summary>
    public string DependencyId { get; set; }

    /// <summary>Human-readable alert message for toast/UI display.</summary>
    public string Message { get; set; }

    /// <summary>UTC timestamp when the alert was generated.</summary>
    public DateTimeOffset Timestamp { get; set; }
}
```

### 6.4 Source code path
- Design-approved alert shape: `docs/superpowers/specs/2026-04-24-nexus-design.md:148-155`
- Anomaly engine integration: `docs/specs/features/F26-nexus-dependency-graph/spec.md:57-59`
- P0 research "hot edge first" pattern: `p0-foundation.md:67-69`

### 6.5 Edge cases
- **Alert storm under heavy load**: if multiple dependencies go critical simultaneously, the aggregator should cap alerts per snapshot (e.g., max 10) to avoid flooding the frontend channel.
- **Baseline not yet established**: no alerts should fire until the baseline has accumulated sufficient data (e.g., first 2 windows). `BaselineDelta == 1.0` during bootstrap means no anomaly.
- **Recovery alerts**: V1 does not emit "recovered" alerts. When a dependency returns to `healthy`, the alert simply stops appearing in subsequent snapshots. V2 may add recovery notifications.

### 6.6 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusAggregator` (anomaly detection) | `NexusSnapshot.Alerts` |
| — | `tab-nexus.js` (toast notifications, edge pulse animation) |
| — | Future: `anomaly.js` integration (F26 spec `§5:58`) |

### 6.7 Priority
**P1** — alerts are a core triage feature but depend on aggregator thresholds being tuned.

---

## 7. NexusSnapshot

### 7.1 Trigger
Published by `EdogNexusAggregator` to the `nexus` topic via `EdogTopicRouter.Publish("nexus", snapshot)` at the snapshot heartbeat cadence (target: 1 Hz, per design spec `§8.2`). Also published on-demand when the aggregator first starts (initial empty snapshot) and on graceful shutdown (final state snapshot for persistence).

### 7.2 Expected behavior
The **complete graph state** at a point in time — nodes, edges, alerts, metadata. This is what the frontend receives via `SignalRManager.subscribeTopic('nexus')` → `SubscribeToTopic("nexus")` (`EdogPlaygroundHub.cs:62-106`).

The `nexus` topic buffer must be registered in `EdogTopicRouter.Initialize()` alongside the existing 12 topics (`EdogTopicRouter.cs:27-39`).

**Invariants:**
- `GeneratedAt` is UTC — when this snapshot was computed.
- `WindowSec` matches the aggregator's configured rolling window (default: 300).
- `Nodes` always contains at least the `flt-local` core node.
- `Edges` may be empty (no traffic observed yet).
- `Alerts` may be empty (all healthy).
- The snapshot is a **complete replacement** — not a delta. The frontend replaces its entire graph state on each snapshot.

### 7.3 Technical mechanism

```csharp
/// <summary>
/// Complete Nexus graph snapshot published to the "nexus" topic.
/// Frontend replaces entire graph state on each received snapshot.
/// </summary>
public sealed class NexusSnapshot
{
    /// <summary>UTC timestamp when this snapshot was generated.</summary>
    public DateTimeOffset GeneratedAt { get; set; }

    /// <summary>Rolling window size in seconds (e.g., 300).</summary>
    public int WindowSec { get; set; }

    /// <summary>All active nodes in the dependency graph.</summary>
    public NexusNodeInfo[] Nodes { get; set; }

    /// <summary>All active edges with per-edge statistics.</summary>
    public NexusEdgeStats[] Edges { get; set; }

    /// <summary>Active anomaly alerts (may be empty).</summary>
    public NexusAlert[] Alerts { get; set; }
}
```

### 7.4 Wire format (as seen by frontend via SignalR)

The snapshot is wrapped in the standard `TopicEvent` envelope:

```json
{
  "sequenceId": 42,
  "timestamp": "2026-04-24T04:10:12.000Z",
  "topic": "nexus",
  "data": {
    "generatedAt": "2026-04-24T04:10:12.000Z",
    "windowSec": 300,
    "nodes": [
      { "id": "flt-local", "kind": "core", "volume": 0 },
      { "id": "spark-gts", "kind": "dependency", "volume": 186 }
    ],
    "edges": [
      {
        "from": "flt-local",
        "to": "spark-gts",
        "volume": 186,
        "throughputPerMin": 37.2,
        "p50Ms": 180.0,
        "p95Ms": 690.0,
        "p99Ms": 920.0,
        "errorRate": 0.07,
        "retryRate": 0.11,
        "baselineDelta": 3.0,
        "health": "degraded"
      }
    ],
    "alerts": [
      {
        "severity": "warning",
        "dependencyId": "spark-gts",
        "message": "Latency 3.0x above baseline",
        "timestamp": "2026-04-24T04:10:12.000Z"
      }
    ]
  }
}
```

Serialization is **System.Text.Json with camelCase** — the default SignalR JSON protocol (`EdogLogServer.cs:78` — `AddSignalR()` without MessagePack). Property names are automatically camelCased by the SignalR JSON hub protocol.

### 7.5 Source code path
- Design-approved snapshot shape: `docs/superpowers/specs/2026-04-24-nexus-design.md:121-157`
- Topic registration pattern: `EdogTopicRouter.cs:26-40` (add `RegisterTopic("nexus", 500)`)
- SignalR streaming pattern: `EdogPlaygroundHub.cs:62-106` (snapshot + live)
- Frontend subscription pattern: `src/frontend/js/signalr-manager.js:185-193`

### 7.6 Edge cases
- **Empty graph on startup**: first snapshot has `Nodes = [flt-local]`, `Edges = []`, `Alerts = []`. Frontend renders the center node with no connections.
- **Large snapshot size**: with 9 dependency IDs, the snapshot contains at most 10 nodes and 9 edges — comfortably small. Even with generous field counts, a snapshot is < 5KB JSON.
- **Topic buffer sizing**: recommended buffer size for `nexus`: **500** (at 1 Hz, that is ~8 minutes of history for snapshot hydration on reconnect). This matches the `retry`/`capacity` buffer sizes (`EdogTopicRouter.cs:35,39`).
- **Snapshot during aggregator shutdown**: the final snapshot should be persisted by `EdogNexusSessionStore` before the aggregator stops, enabling restart recovery.
- **Schema evolution**: new fields added to `NexusEdgeStats` or `NexusNodeInfo` will serialize as additional JSON properties. The frontend must tolerate unknown fields (standard JSON forward-compatibility). Removing fields requires a version bump.

### 7.7 Interactions
| Producer | Consumer |
|---|---|
| `EdogNexusAggregator` (1 Hz heartbeat) | `EdogTopicRouter` → `nexus` topic buffer |
| `nexus` topic buffer | `EdogPlaygroundHub.SubscribeToTopic("nexus")` → SignalR stream |
| — | `tab-nexus.js` (full graph replace on each snapshot) |
| — | `EdogNexusSessionStore` (periodic flush + shutdown persist) |

### 7.8 Priority
**P0** — the primary output contract of the entire Nexus pipeline.

---

## 8. Serialization Strategy

### 8.1 Wire protocol
**System.Text.Json** — the default SignalR JSON hub protocol.

**Evidence:**
- `EdogLogServer.cs:78`: `builder.Services.AddSignalR()` — no `.AddMessagePackProtocol()` call.
- `EdogLogServer.cs:37`: `JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }` used for REST endpoints.
- All existing interceptors publish anonymous objects that serialize naturally via `System.Text.Json`.

### 8.2 Naming convention
SignalR's default JSON protocol uses **camelCase** property names automatically. The C# model properties are PascalCase (standard C# convention); the wire format is camelCase.

### 8.3 Persistence serialization
`EdogNexusSessionStore` (C04) will serialize `NexusSnapshot` to disk using `System.Text.Json` with the same `JsonNamingPolicy.CamelCase` options used elsewhere in DevMode. This ensures:
- Human-readable persistence files for debugging.
- Consistent field naming between wire and disk formats.
- No additional serializer dependency.

### 8.4 Type registration
All types in `EdogNexusModels.cs` use public get/set properties (not constructor-based immutability like `LogEntry`). This is a deliberate choice:
- `System.Text.Json` default deserialization requires parameterless constructors or `[JsonConstructor]`.
- Mutable DTOs are simpler for the aggregator to build incrementally.
- Immutability is enforced by access patterns, not by the type system.

---

## 9. Complete File Template

```csharp
// <copyright file="EdogNexusModels.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Text.RegularExpressions;

    // ──────────────────────────────────────────────
    // NexusDependencyId — Canonical dependency identifiers
    // ──────────────────────────────────────────────

    public static class NexusDependencyId
    {
        public const string SparkGts    = "spark-gts";
        public const string FabricApi   = "fabric-api";
        public const string PlatformApi = "platform-api";
        public const string Auth        = "auth";
        public const string Capacity    = "capacity";
        public const string Cache       = "cache";
        public const string RetrySystem = "retry-system";
        public const string Filesystem  = "filesystem";
        public const string Unknown     = "unknown";

        public static readonly string[] All = new[]
        {
            SparkGts, FabricApi, PlatformApi, Auth, Capacity,
            Cache, RetrySystem, Filesystem, Unknown,
        };
    }

    // ──────────────────────────────────────────────
    // NexusHealthStatus — Edge health classification
    // ──────────────────────────────────────────────

    public static class NexusHealthStatus
    {
        public const string Healthy  = "healthy";
        public const string Degraded = "degraded";
        public const string Critical = "critical";
    }

    // ──────────────────────────────────────────────
    // NexusNormalizedEvent — Internal reducer input
    // ──────────────────────────────────────────────

    public sealed class NexusNormalizedEvent
    {
        public string DependencyId { get; set; }
        public string SourceTopic { get; set; }
        public DateTimeOffset Timestamp { get; set; }
        public string Method { get; set; }
        public int StatusCode { get; set; }
        public double LatencyMs { get; set; }
        public bool IsError { get; set; }
        public bool IsThrottled { get; set; }
        public string ThrottleType { get; set; }
        public string OperationPhase { get; set; }
        public string ErrorCode { get; set; }
        public string ErrorSeverity { get; set; }
        public int RetryCount { get; set; }
        public string CorrelationId { get; set; }
        public string EndpointHint { get; set; }
        public string IterationId { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusErrorClassification — FLT error code taxonomy
    // ──────────────────────────────────────────────

    public static class NexusErrorClassification
    {
        public const string User      = "user";
        public const string System    = "system";
        public const string Transient = "transient";

        private static readonly Dictionary<string, string> KnownErrors = new(StringComparer.OrdinalIgnoreCase)
        {
            ["MV_NOT_FOUND"]               = User,
            ["SOURCE_ENTITIES_UNDEFINED"]   = User,
            ["CONCURRENT_REFRESH"]          = User,
            ["ACCESS_DENIED"]               = User,
            ["SOURCE_ENTITIES_CORRUPTED"]   = System,
            ["SOURCE_ENTITIES_MISSING"]     = System,
            ["SYSTEM_ERROR"]                = System,
            ["MLV_RESULTCODE_NOT_FOUND"]    = System,
            ["SPARK_SESSION_ACQUISITION_FAILED"] = Transient,
            ["TOO_MANY_REQUESTS"]                = Transient,
            ["SPARK_JOB_CAPACITY_THROTTLING"]    = Transient,
        };

        internal static readonly Regex ErrorCodePattern = new(
            @"\b((?:FLT|FMLV|MLV)_[A-Z_]+|MV_NOT_FOUND|SOURCE_ENTITIES_\w+|CONCURRENT_REFRESH|ACCESS_DENIED|SYSTEM_ERROR|SPARK_SESSION_ACQUISITION_FAILED|SPARK_JOB_CAPACITY_THROTTLING|TOO_MANY_REQUESTS|MLV_RESULTCODE_NOT_FOUND)\b",
            RegexOptions.Compiled);

        public static string Classify(string errorCode)
        {
            if (string.IsNullOrEmpty(errorCode)) return null;
            return KnownErrors.TryGetValue(errorCode, out var severity) ? severity : null;
        }
    }

    // ──────────────────────────────────────────────
    // NexusEdgeStats — Per-edge rolling statistics
    // ──────────────────────────────────────────────

    public sealed class NexusEdgeStats
    {
        public string From { get; set; }
        public string To { get; set; }
        public int Volume { get; set; }
        public double ThroughputPerMin { get; set; }
        public double P50Ms { get; set; }
        public double P95Ms { get; set; }
        public double P99Ms { get; set; }
        public double ErrorRate { get; set; }
        public double RetryRate { get; set; }
        public double BaselineDelta { get; set; }
        public string Health { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusNodeInfo — Per-node metadata
    // ──────────────────────────────────────────────

    public sealed class NexusNodeInfo
    {
        public string Id { get; set; }
        public string Kind { get; set; }
        public int Volume { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusAlert — Anomaly alert
    // ──────────────────────────────────────────────

    public sealed class NexusAlert
    {
        public string Severity { get; set; }
        public string DependencyId { get; set; }
        public string Message { get; set; }
        public DateTimeOffset Timestamp { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusSnapshot — Full graph snapshot for nexus topic
    // ──────────────────────────────────────────────

    public sealed class NexusSnapshot
    {
        public DateTimeOffset GeneratedAt { get; set; }
        public int WindowSec { get; set; }
        public NexusNodeInfo[] Nodes { get; set; }
        public NexusEdgeStats[] Edges { get; set; }
        public NexusAlert[] Alerts { get; set; }
    }
}
```

---

## 10. Cross-Component Dependency Map

```
EdogNexusClassifier (C02)
  │ creates ──→ NexusNormalizedEvent
  │ uses    ──→ NexusDependencyId
  │ uses    ──→ NexusErrorClassification (error code → severity mapping)
  │
  ▼
EdogNexusAggregator (C03)
  │ consumes ──→ NexusNormalizedEvent
  │ produces ──→ NexusEdgeStats, NexusNodeInfo, NexusAlert
  │ produces ──→ NexusSnapshot (wraps all above)
  │ uses     ──→ NexusHealthStatus (threshold evaluation)
  │ publishes to ──→ EdogTopicRouter("nexus")
  │
  ▼
EdogNexusSessionStore (C04)
  │ serializes ──→ NexusSnapshot (System.Text.Json)
  │ deserializes ──→ NexusSnapshot (startup restore)
  │
  ▼
EdogPlaygroundHub (existing)
  │ streams ──→ TopicEvent { Data = NexusSnapshot }
  │
  ▼
tab-nexus.js (C05)
  │ consumes ──→ NexusSnapshot (JSON parsed)
  │ reads    ──→ NexusDependencyId, NexusHealthStatus values
```

---

## 11. Implementation Checklist

| # | Item | Priority | Depends on |
|---|---|---|---|
| 1 | `NexusDependencyId` static class | P0 | — |
| 2 | `NexusHealthStatus` static class | P0 | — |
| 3 | `NexusNormalizedEvent` class (incl. `IsThrottled`, `ThrottleType`, `OperationPhase`, `ErrorCode`, `ErrorSeverity`) | P0 | `NexusDependencyId` |
| 3A | `NexusErrorClassification` static class | P1 | — |
| 4 | `NexusEdgeStats` class | P0 | `NexusDependencyId`, `NexusHealthStatus` |
| 5 | `NexusNodeInfo` class | P1 | `NexusDependencyId` |
| 6 | `NexusAlert` class | P1 | `NexusDependencyId` |
| 7 | `NexusSnapshot` class | P0 | All above |
| 8 | Register `nexus` topic in `EdogTopicRouter.Initialize()` | P0 | — |

---

## 12. Open Decisions for C02/C03 Specs

These are **not** C01 decisions but are flagged here for downstream component specs:

1. **Percentile algorithm**: T-Digest vs sorted-array for p50/p95/p99 computation in the aggregator. C01 defines the output fields; C03 defines the algorithm.
2. **Anomaly thresholds**: exact values for `BaselineDelta` and `ErrorRate` that trigger `degraded` vs `critical`. C01 defines the health values; C03 defines the thresholds.
3. **Alert cap per snapshot**: suggested max 10 in §6.5; exact value is a C03 tuning decision.
4. **Baseline window**: how many reducer cycles before baseline is "established". C03 decision.
