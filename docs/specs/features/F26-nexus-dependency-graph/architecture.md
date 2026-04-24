# F26 Nexus — P2 Architecture Specification

> **Feature:** F26 — Nexus: Real-Time Cross-Workload Dependency Graph
> **Phase:** P2 — Architecture
> **Author:** Sana (architecture agent)
> **Status:** SPEC
> **Date:** 2025-07-25
> **Prerequisites:** P0 Foundation Research, P1 Component Specs (C01–C06), Approved Design Spec
> **Goal:** A senior engineer can implement from this spec without asking questions.

---

## Table of Contents

1. [Data Model](#1-data-model)
2. [Core Engine — Aggregator Algorithm](#2-core-engine--aggregator-algorithm)
3. [Core Engine — Classifier Algorithm](#3-core-engine--classifier-algorithm)
4. [Storage / Persistence](#4-storage--persistence)
5. [Safety Mechanisms](#5-safety-mechanisms)
6. [Cross-Component Integration Map](#6-cross-component-integration-map)

---

## §1 Data Model

### 1.1 Message Type Taxonomy

The Nexus pipeline processes four message types in sequence:

```
Raw TopicEvent (6 topics)
  → NexusNormalizedEvent (internal)
    → EdgeAccumulator (in-memory state)
      → NexusSnapshot (published to `nexus` topic)
        + NexusAlert (out-of-band, also in snapshot)
```

### 1.2 Source Topic Event Shapes (inputs — verified from source)

These are the existing anonymous-object payloads published by interceptors. The classifier must extract fields by name from `TopicEvent.Data` using reflection/duck-typing.

**`http` topic** (`EdogHttpPipelineHandler.cs:67-78`):
```json
{
  "method": "POST",
  "url": "https://host/livysessions/123/statements",
  "statusCode": 200,
  "durationMs": 234.20,
  "requestHeaders": { ... },
  "responseHeaders": { ... },
  "responseBodyPreview": "...",
  "httpClientName": "GtsClient",
  "correlationId": "abc-123-def"
}
```

**`token` topic** (`EdogTokenInterceptor.cs:63-72`):
```json
{
  "tokenType": "Bearer",
  "scheme": "Bearer",
  "audience": "https://analysis.windows.net/powerbi/api",
  "expiryUtc": "2026-04-24T05:10:00Z",
  "issuedUtc": "2026-04-24T04:10:00Z",
  "httpClientName": "GtsClient",
  "endpoint": "/oauth2/v2.0/token"
}
```

**`spark` topic** (`EdogSparkSessionInterceptor.cs:67-79, 86-98`):
```json
{
  "sessionTrackingId": "edog-spark-1",
  "event": "Created",
  "workspace": "ws-guid",
  "artifact": "artifact-guid",
  "iteration": "iter-guid",
  "durationMs": 1200,
  "error": null
}
```

**`retry` topic** (`EdogRetryInterceptor.cs:186-200`):
```json
{
  "endpoint": "Artifact:{guid}/Node:{name}",
  "retryAttempt": 2,
  "totalAttempts": 3,
  "waitDurationMs": 500,
  "isThrottle": false,
  "retryAfterMs": null,
  "iterationId": "iter-guid"
}
```

**`cache` topic** (`EdogCacheInterceptor.cs:46-56`):
```json
{
  "cacheName": "TokenCache",
  "operation": "Get",
  "key": "cache-key",
  "hitOrMiss": "Hit",
  "valueSizeBytes": 2048,
  "ttlSeconds": 3600,
  "durationMs": 0.5
}
```

**`fileop` topic** (`EdogFileSystemInterceptor.cs:252-262`):
```json
{
  "operation": "Write",
  "path": "/lakehouses/abc/Tables/t1/part-00.parquet",
  "contentSizeBytes": 1048576,
  "durationMs": 45.3,
  "contentPreview": "...",
  "iterationId": "iter-guid"
}
```

### 1.3 NexusDependencyId — Canonical Identifiers

**C# class** (`EdogNexusModels.cs`):

```csharp
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
```

**JS-side contract** (JSDoc in `tab-nexus.js`):

```javascript
/**
 * @typedef {'spark-gts'|'fabric-api'|'platform-api'|'auth'|'capacity'|
 *           'cache'|'retry-system'|'filesystem'|'unknown'} DependencyId
 */
const DEPENDENCY_IDS = Object.freeze([
  'spark-gts', 'fabric-api', 'platform-api', 'auth', 'capacity',
  'cache', 'retry-system', 'filesystem', 'unknown',
]);
```

### 1.4 NexusNormalizedEvent (internal — not published)

Produced by `EdogNexusClassifier.Classify()`, consumed by `EdogNexusAggregator.IngestNormalizedEvent()`.

```csharp
public sealed class NexusNormalizedEvent
{
    public string DependencyId { get; set; }       // One of NexusDependencyId.All
    public string SourceTopic { get; set; }        // "http", "spark", "token", "retry", "cache", "fileop"
    public DateTimeOffset Timestamp { get; set; }  // UTC
    public string Method { get; set; }             // HTTP method or null
    public int StatusCode { get; set; }            // HTTP status or 0
    public double LatencyMs { get; set; }          // >= 0; 0 if N/A
    public bool IsError { get; set; }              // statusCode >= 400 || spark Error event
    public int RetryCount { get; set; }            // 0 default
    public string CorrelationId { get; set; }      // nullable
    public string EndpointHint { get; set; }       // redacted URL path or operation
    public string IterationId { get; set; }        // nullable
    public bool IsEnrichmentOnly { get; set; }     // true for retry/cache (augment, don't count)
    public bool IsInternal { get; set; }           // true for filesystem
}
```

**Field-by-field mapping from source topics:**

| Field | `http` | `token` | `spark` | `retry` | `cache` | `fileop` |
|-------|--------|---------|---------|---------|---------|----------|
| DependencyId | URL-classified | `auth` | `spark-gts` | `retry-system` | `cache` | `filesystem` |
| SourceTopic | `"http"` | `"token"` | `"spark"` | `"retry"` | `"cache"` | `"fileop"` |
| Timestamp | `TopicEvent.Timestamp` | same | same | same | same | same |
| Method | `.method` | null | null | null | null | `.operation` |
| StatusCode | `.statusCode` | 0 | 0 (Error→500) | 0 | 0 | 0 |
| LatencyMs | `.durationMs` | 0 | `.durationMs` | 0 | `.durationMs` | `.durationMs` |
| IsError | `status >= 400` | false | `event=="Error"` | false | false | false |
| RetryCount | 0 | 0 | 0 | `.retryAttempt` | 0 | 0 |
| CorrelationId | `.correlationId` | null | `.sessionTrackingId` | null | null | null |
| EndpointHint | redacted URL path | `.endpoint` | `.sessionTrackingId` | `.endpoint` | `.cacheName` | `op:path` |
| IterationId | null | null | `.iteration` | `.iterationId` | null | `.iterationId` |
| IsEnrichmentOnly | false | false | false | true | true | false |
| IsInternal | false | false | false | false | false | true |

### 1.5 NexusHealthStatus

```csharp
public static class NexusHealthStatus
{
    public const string Healthy  = "healthy";
    public const string Degraded = "degraded";
    public const string Critical = "critical";
}
```

### 1.6 NexusEdgeStats (per-edge output)

```csharp
public sealed class NexusEdgeStats
{
    public string From { get; set; }            // Always "flt-local" in V1
    public string To { get; set; }              // NexusDependencyId
    public int Volume { get; set; }             // Events in window
    public double ThroughputPerMin { get; set; }
    public double P50Ms { get; set; }
    public double P95Ms { get; set; }
    public double P99Ms { get; set; }
    public double ErrorRate { get; set; }       // [0.0, 1.0]
    public double RetryRate { get; set; }       // [0.0, 1.0]
    public double BaselineDelta { get; set; }   // ratio: current / baseline; 1.0 = normal
    public string Health { get; set; }          // NexusHealthStatus constant
}
```

### 1.7 NexusNodeInfo

```csharp
public sealed class NexusNodeInfo
{
    public string Id { get; set; }              // "flt-local" or dependency ID
    public string Kind { get; set; }            // "core" or "dependency"
    public long Volume { get; set; }            // Total events in window
}
```

### 1.8 NexusAlert

```csharp
public sealed class NexusAlert
{
    public string Severity { get; set; }        // "warning" or "critical" — no "info"
    public string DependencyId { get; set; }
    public string Message { get; set; }         // Human-readable English
    public DateTimeOffset Timestamp { get; set; }
}
```

### 1.9 NexusSnapshot (published to `nexus` topic)

```csharp
public sealed class NexusSnapshot
{
    public DateTimeOffset GeneratedAt { get; set; }
    public int WindowSec { get; set; }          // 300 (5 min)
    public NexusNodeInfo[] Nodes { get; set; }
    public NexusEdgeStats[] Edges { get; set; }
    public NexusAlert[] Alerts { get; set; }
}
```

**Wire format** (via SignalR JSON protocol, `System.Text.Json` with `JsonNamingPolicy.CamelCase` per `EdogLogServer.cs:37`):

```json
{
  "sequenceId": 42,
  "timestamp": "2026-04-24T04:10:12.000Z",
  "topic": "nexus",
  "data": {
    "type": "snapshot",
    "generatedAt": "2026-04-24T04:10:12.000Z",
    "windowSec": 300,
    "nodes": [
      { "id": "flt-local", "kind": "core", "volume": 0 },
      { "id": "spark-gts", "kind": "dependency", "volume": 186 }
    ],
    "edges": [
      {
        "from": "flt-local", "to": "spark-gts",
        "volume": 186, "throughputPerMin": 37.2,
        "p50Ms": 180, "p95Ms": 690, "p99Ms": 920,
        "errorRate": 0.07, "retryRate": 0.11,
        "baselineDelta": 3.0, "health": "degraded"
      }
    ],
    "alerts": [
      {
        "severity": "warning", "dependencyId": "spark-gts",
        "message": "Latency 3.0x above baseline",
        "timestamp": "2026-04-24T04:10:12.000Z"
      }
    ]
  }
}
```

**Alert out-of-band wire format:**

```json
{
  "sequenceId": 43,
  "timestamp": "2026-04-24T04:10:12.500Z",
  "topic": "nexus",
  "data": {
    "type": "alert",
    "severity": "warning",
    "dependencyId": "spark-gts",
    "metric": "p95Ms",
    "currentValue": 690,
    "baselineValue": 230,
    "delta": 3.0,
    "message": "Latency 3.0x above baseline",
    "timestamp": "2026-04-24T04:10:12.500Z"
  }
}
```

### 1.10 JS-Side Type Contracts

```javascript
/**
 * @typedef {Object} NexusSnapshot
 * @property {string} generatedAt        - ISO 8601 UTC
 * @property {number} windowSec          - Rolling window size (300)
 * @property {NexusNode[]} nodes
 * @property {NexusEdge[]} edges
 * @property {NexusAlert[]} alerts
 */

/**
 * @typedef {Object} NexusNode
 * @property {DependencyId|'flt-local'} id
 * @property {'core'|'dependency'} kind
 * @property {number} volume
 */

/**
 * @typedef {Object} NexusEdge
 * @property {string} from               - Always "flt-local" in V1
 * @property {DependencyId} to
 * @property {number} volume
 * @property {number} throughputPerMin
 * @property {number} p50Ms
 * @property {number} p95Ms
 * @property {number} p99Ms
 * @property {number} errorRate          - [0.0, 1.0]
 * @property {number} retryRate          - [0.0, 1.0]
 * @property {number} baselineDelta      - ratio (1.0 = normal)
 * @property {'healthy'|'degraded'|'critical'} health
 */

/**
 * @typedef {Object} NexusAlert
 * @property {'warning'|'critical'} severity
 * @property {DependencyId} dependencyId
 * @property {string} message
 * @property {string} timestamp          - ISO 8601 UTC
 */
```

### 1.11 Schema Versioning Strategy

- Persistence envelope carries `schemaVersion: 1` (see §4).
- Wire format is **forward-compatible**: new fields are additive. Frontend `tab-nexus.js` must tolerate unknown JSON properties (standard `System.Text.Json` behavior).
- Removing fields or changing semantics requires a version bump. Unknown schema versions are quarantined on restore (§4.4).
- Wire schema is implicitly versioned by the `type` discriminator (`"snapshot"` / `"alert"`). New message types can be added without breaking existing consumers.

---

## §2 Core Engine — Aggregator Algorithm

### 2.1 Class: `EdogNexusAggregator`

**File:** `src/backend/DevMode/EdogNexusAggregator.cs` (new)
**Pattern:** Static class matching `EdogTopicRouter` and `EdogRetryInterceptor` conventions.
**Lifecycle:** `Start()` / `Stop()` called by `EdogDevModeRegistrar.RegisterAll()`.

### 2.2 EdgeAccumulator (per-edge in-memory state)

```csharp
internal sealed class EdgeAccumulator
{
    public string DependencyId;

    // --- Circular buffer for latency samples ---
    private readonly double[] _latencySamples;      // pre-allocated, size = MaxSamplesPerWindow (2000)
    private int _sampleHead;                         // Interlocked.Increment write cursor
    private int _sampleCount;                        // actual sample count (capped at buffer size)

    // --- Atomic counters ---
    private long _totalRequests;                     // Interlocked.Increment
    private long _errorCount;                        // Interlocked.Increment
    private long _retryCount;                        // Interlocked.Increment
    private long _throttleCount;                     // Interlocked.Increment

    // --- Window bounds ---
    public DateTimeOffset WindowStart;
    public DateTimeOffset LastEventTime;

    // --- Baseline (updated at window rotation) ---
    public double BaselineP50Ms;
    public double BaselineP95Ms;
    public double BaselineErrorRate;

    // --- Correlation tracking ---
    private readonly ConcurrentQueue<string> _recentCorrelationIds = new();
    private const int MaxCorrelationIds = 50;

    public EdgeAccumulator(string dependencyId, int maxSamples)
    {
        DependencyId = dependencyId;
        _latencySamples = new double[maxSamples];
        WindowStart = DateTimeOffset.UtcNow;
    }
}
```

**Bounds:**
- `_latencySamples`: exactly 2,000 doubles = 16 KB per edge
- `_recentCorrelationIds`: max 50 strings per edge
- Max edges: bounded by `NexusDependencyId.All.Length` = 9. Practical max ~20 with unknown variants.
- **Total memory per aggregator: ~9 edges x 16 KB = ~144 KB + counters + overhead < 1 MB**

### 2.3 Threading Model

```
┌─────────────────────────────────────────────────────────────────┐
│ FLT Process Threads (interceptors)                              │
│                                                                 │
│  HttpPipeline ──publish──→ TopicBuffer["http"]                  │
│  TokenInterceptor ──────→ TopicBuffer["token"]                  │
│  SparkInterceptor ──────→ TopicBuffer["spark"]                  │
│  RetryInterceptor ──────→ TopicBuffer["retry"]                  │
│  CacheInterceptor ──────→ TopicBuffer["cache"]                  │
│  FileSystemInterceptor ─→ TopicBuffer["fileop"]                 │
└─────────────────────────────────────────────────────────────────┘
                              │ (6 ring buffers, bounded, DropOldest)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Nexus Consumer Tasks (6 Task.Run, ThreadPool)                   │
│                                                                 │
│  ConsumeTopicAsync("http")   ─┐                                 │
│  ConsumeTopicAsync("token")  ─┤                                 │
│  ConsumeTopicAsync("spark")  ─┤─→ Classify() → IngestNormalized │
│  ConsumeTopicAsync("retry")  ─┤   (lock-free: Interlocked ops)  │
│  ConsumeTopicAsync("cache")  ─┤                                 │
│  ConsumeTopicAsync("fileop") ─┘                                 │
│                                                                 │
│  Shared: ConcurrentDictionary<string, EdgeAccumulator> _edges   │
└─────────────────────────────────────────────────────────────────┘
                              │ (Interlocked writes to EdgeAccumulator)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Snapshot Timer (System.Threading.Timer, 1 Hz, single callback)  │
│                                                                 │
│  PublishSnapshot():                                             │
│    1. MaybeRotateWindow() per edge                              │
│    2. ComputePercentiles() per edge                             │
│    3. DeriveHealth() per edge                                   │
│    4. DetectAnomalies() per edge                                │
│    5. Assemble NexusSnapshot                                    │
│    6. EdogTopicRouter.Publish("nexus", snapshot)                │
│    7. Publish out-of-band alerts                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Persistence Timer (System.Threading.Timer, 0.2 Hz)              │
│                                                                 │
│  EdogNexusSessionStore.FlushAsync():                            │
│    1. Snapshot delegate → deep copy of _edges state             │
│    2. ApplyRetention()                                          │
│    3. Serialize → temp file → atomic rename                     │
└─────────────────────────────────────────────────────────────────┘
```

**Synchronization points:**
- **Consumer → EdgeAccumulator**: `Interlocked.Increment` on counters. Circular buffer write via `Interlocked.Increment` on `_sampleHead` modulo buffer size. No locks.
- **Timer → EdgeAccumulator**: reads counters via `Interlocked.Read`. Copies latency samples into local array for sort. Stale-by-one-sample is acceptable at 1 Hz.
- **Timer → Timer**: `System.Threading.Timer` does not overlap callbacks on the same timer instance. Non-reentrant by design.
- **Persist timer → _edges**: `ConcurrentDictionary.foreach` yields point-in-time snapshot. Individual `EdgeAccumulator` fields may be mid-update (eventually consistent, acceptable for persistence).

**No locks used anywhere. Deadlock risk: zero.**

### 2.4 Public Methods — Pseudocode

#### `Start()`

```
FUNCTION Start():
    IF _started THEN RETURN                  // idempotent
    _started = true

    // Register output topic (500 buffer, matching capacity topic profile)
    EdogTopicRouter.RegisterTopic("nexus", 500)

    _cts = new CancellationTokenSource()

    // Restore persisted state (non-blocking, best-effort)
    restoredState = EdogNexusSessionStore.TryRestore()
    IF restoredState != null THEN
        HydrateFrom(restoredState)           // populate _edges from persisted data

    // Spawn 1 consumer task per source topic
    FOR topic IN ["http", "spark", "token", "retry", "cache", "fileop"]:
        Task.Run(() => ConsumeTopicAsync(topic, _cts.Token))

    // Start snapshot publisher (1 Hz)
    _snapshotTimer = new Timer(PublishSnapshot, dueTime=1s, period=1s)

    // Start persistence flusher (every 5s)
    _persistTimer = new Timer(PersistState, dueTime=5s, period=5s)

    Console.WriteLine("[EDOG] Nexus aggregator started")
```

#### `Stop()`

```
FUNCTION Stop():
    IF NOT _started THEN RETURN              // idempotent
    TRY:
        _cts.Cancel()                        // signal all consumers
        _snapshotTimer.Dispose()
        _persistTimer.Dispose()
        PublishSnapshot()                    // final snapshot
        EdogNexusSessionStore.Persist(_edges) // final flush
        Console.WriteLine("[EDOG] Nexus aggregator stopped")
    CATCH ex:
        Debug.WriteLine("[EDOG] Nexus stop error: " + ex.Message)
    FINALLY:
        _cts.Dispose()
        _started = false
```

#### `ConsumeTopicAsync(topic, ct)`

```
FUNCTION ConsumeTopicAsync(topic, ct):
    WHILE NOT ct.IsCancellationRequested:
        buffer = EdogTopicRouter.GetBuffer(topic)
        IF buffer == null THEN
            AWAIT Task.Delay(1000, ct)       // topic not yet registered; retry
            CONTINUE

        TRY:
            FOR EACH topicEvent IN buffer.ReadLiveAsync(ct):
                normalized = EdogNexusClassifier.Classify(topic, topicEvent.Data)
                IF normalized != null THEN
                    IngestNormalizedEvent(normalized)
        CATCH OperationCanceledException:
            BREAK                            // clean shutdown
        CATCH ex:
            Debug.WriteLine("[EDOG] Nexus consumer error: " + ex.Message)
            AWAIT Task.Delay(500, ct)        // backoff before retry
```

#### `IngestNormalizedEvent(evt)`

```
FUNCTION IngestNormalizedEvent(evt):
    acc = _edges.GetOrAdd(evt.DependencyId, id => new EdgeAccumulator(id, 2000))

    IF NOT evt.IsEnrichmentOnly THEN
        IF evt.LatencyMs > 0 THEN
            // Lock-free circular buffer write
            slot = Interlocked.Increment(ref acc._sampleHead) % MaxSamplesPerWindow
            acc._latencySamples[slot] = evt.LatencyMs
            InterlockedMax(ref acc._sampleCount, acc._sampleHead)

        Interlocked.Increment(ref acc._totalRequests)
        IF evt.IsError THEN
            Interlocked.Increment(ref acc._errorCount)

    IF evt.RetryCount > 0 OR evt.SourceTopic == "retry" THEN
        Interlocked.Increment(ref acc._retryCount)

    // Throttle tracking from retry enrichment events
    IF evt.SourceTopic == "retry" AND ExtractIsThrottle(evt) THEN
        Interlocked.Increment(ref acc._throttleCount)

    // Correlation ID tracking (bounded FIFO)
    IF evt.CorrelationId != null THEN
        acc.RecordCorrelationId(evt.CorrelationId)

    acc.LastEventTime = DateTimeOffset.UtcNow
```

#### `PublishSnapshot()` (1 Hz timer callback)

```
FUNCTION PublishSnapshot():
    TRY:
        now = DateTimeOffset.UtcNow
        nodes = [NexusNode("flt-local", "core", 0)]
        edges = []
        allAlerts = []
        totalCoreVolume = 0

        FOR EACH (depId, acc) IN _edges:
            // 1. Window rotation check
            MaybeRotateWindow(acc, now)

            // 2. Read counters (atomic)
            total = Interlocked.Read(ref acc._totalRequests)
            errors = Interlocked.Read(ref acc._errorCount)
            retries = Interlocked.Read(ref acc._retryCount)

            // 3. Compute latency percentiles
            (p50, p95, p99) = ComputePercentiles(acc)

            // 4. Derive rates
            windowElapsed = max((now - acc.WindowStart).TotalMinutes, 1/60)
            errorRate = total > 0 ? errors / total : 0
            retryRate = total > 0 ? retries / total : 0
            throughput = total / windowElapsed

            // 5. Compute baseline delta
            baselineDelta = acc.BaselineP50Ms > 0 ? p50 / acc.BaselineP50Ms : 1.0

            // 6. Derive health
            health = DeriveHealth(errorRate, baselineDelta)

            // 7. Detect anomalies
            alerts = DetectAnomalies(depId, p50, acc.BaselineP50Ms,
                                     errorRate, acc.BaselineErrorRate)
            allAlerts.AddRange(alerts)

            // 8. Build node + edge
            nodes.Add(NexusNode(depId, "dependency", total))
            edges.Add(NexusEdge(
                from="flt-local", to=depId, volume=total,
                throughputPerMin=throughput, p50Ms=p50, p95Ms=p95, p99Ms=p99,
                errorRate=errorRate, retryRate=retryRate,
                baselineDelta=baselineDelta, health=health))

            totalCoreVolume += total

        // Cap alerts per snapshot (prevent flood)
        IF allAlerts.Count > 10 THEN
            allAlerts = allAlerts.OrderByDescending(a => a.Severity).Take(10)

        nodes[0].Volume = totalCoreVolume

        snapshot = NexusSnapshot(now, 300, nodes, edges, allAlerts)
        EdogTopicRouter.Publish("nexus", new { type = "snapshot", ...snapshot })

        // Out-of-band alerts for sub-second frontend delivery
        FOR EACH alert IN allAlerts:
            EdogTopicRouter.Publish("nexus", new { type = "alert", data = alert })

    CATCH ex:
        Debug.WriteLine("[EDOG] Nexus snapshot error: " + ex.Message)
```

### 2.5 Rolling Window Implementation — Circular Buffer

**Approach:** Fixed-size pre-allocated `double[]` with modular write cursor.

```
Buffer: [  slot0  |  slot1  |  slot2  | ... | slot1999  ]
         ^write cursor wraps around via (Interlocked.Increment % 2000)
```

**Why not time-bucketed:** Time-bucketed windows require cleanup timers and boundary logic. A circular buffer with a 5-minute rotation check is simpler and matches the bounded-state philosophy (`tab-http.js:42` uses `_MAX_EVENTS=2000`; `tab-spark.js:32` uses `_maxSessions=200`).

**Write path (producer — any consumer thread):**
```
slot = Interlocked.Increment(ref _sampleHead) % MaxSamplesPerWindow
_latencySamples[slot] = latencyMs
InterlockedMax(ref _sampleCount, _sampleHead)
```

**Read path (timer thread — snapshot):**
```
count = min(_sampleCount, MaxSamplesPerWindow)
copy = new double[count]
FOR i IN 0..count-1:
    idx = (_sampleHead - count + 1 + i + MaxSamplesPerWindow) % MaxSamplesPerWindow
    copy[i] = _latencySamples[idx]
Array.Sort(copy)
```

**Bounds:** `MaxSamplesPerWindow = 2000`. At 100 events/sec this covers 20 seconds of samples within a 5-min window — statistically sufficient for p99 estimation.

### 2.6 Percentile Computation — Nearest-Rank Method

**Algorithm:** Sort + nearest-rank index lookup. Exact (not approximate).

```
FUNCTION ComputePercentiles(acc) -> (p50, p95, p99):
    count = min(acc._sampleCount, MaxSamplesPerWindow)
    IF count == 0 THEN RETURN (0, 0, 0)

    samples = CopyCircularBuffer(acc, count)
    Array.Sort(samples)

    p50 = samples[NearestRank(count, 0.50)]
    p95 = samples[NearestRank(count, 0.95)]
    p99 = samples[NearestRank(count, 0.99)]
    RETURN (p50, p95, p99)

FUNCTION NearestRank(count, percentile) -> int:
    rank = ceil(percentile * count) - 1
    RETURN clamp(rank, 0, count - 1)
```

**Why not t-digest or histogram:** With max 2,000 samples, `Array.Sort` costs ~20μs (in-place quicksort on doubles). This is well within the 200μs/edge budget (§2.10). T-digest adds complexity for no measurable gain at this scale.

**Edge cases:**
- 0 samples → (0, 0, 0). Edge appears with volume but no latency.
- 1 sample → p50 = p95 = p99 = that value.
- Concurrent write during read → stale by ±1 sample. Acceptable at 1 Hz.

### 2.7 Anomaly Detection — EMA Baseline + Threshold

**Baseline tracking:** Exponential Moving Average (EMA) updated at window rotation (every 5 min).

```
FUNCTION UpdateBaseline(acc, currentP50, currentErrorRate):
    alpha = 0.3       // weight toward recent window

    IF acc.BaselineP50Ms == 0 THEN
        acc.BaselineP50Ms = currentP50       // bootstrap from first window
    ELSE
        acc.BaselineP50Ms = alpha * currentP50 + (1 - alpha) * acc.BaselineP50Ms

    IF acc.BaselineErrorRate == 0 AND currentErrorRate > 0 THEN
        acc.BaselineErrorRate = currentErrorRate
    ELSE
        acc.BaselineErrorRate = alpha * currentErrorRate + (1 - alpha) * acc.BaselineErrorRate
```

**Anomaly thresholds:**

| Metric | Warning | Critical |
|--------|---------|----------|
| Latency (p50 / baselineP50) | >= 3.0x | >= 5.0x |
| Error rate delta (current - baseline) | >= 0.10 | — |
| Error rate absolute | — | >= 0.50 |

**Alert debounce:** Per-dependency, 30-second cooldown. Same (dependency, severity) suppressed.

```
FUNCTION DetectAnomalies(depId, currentP50, baselineP50, currentErr, baselineErr) -> List<Alert>:
    alerts = []
    now = DateTimeOffset.UtcNow

    // Debounce check
    IF _lastAlertTime[depId] exists AND (now - _lastAlertTime[depId]) < 30s THEN
        RETURN alerts

    // Latency spike
    IF baselineP50 > 0 THEN
        ratio = currentP50 / baselineP50
        IF ratio >= 5.0 THEN
            alerts.Add(Alert("critical", depId, "Latency {ratio}x above baseline"))
        ELSE IF ratio >= 3.0 THEN
            alerts.Add(Alert("warning", depId, "Latency {ratio}x above baseline"))

    // Error rate deviation
    IF currentErr >= 0.50 THEN
        alerts.Add(Alert("critical", depId, "Error rate {currentErr} — majority failing"))
    ELSE IF (currentErr - baselineErr) >= 0.10 THEN
        alerts.Add(Alert("warning", depId, "Error rate increased to {currentErr}"))

    IF alerts.Count > 0 THEN
        _lastAlertTime[depId] = now

    RETURN alerts
```

**State:**
- `_lastAlertTime`: `ConcurrentDictionary<string, DateTimeOffset>`, max 9 entries (one per dependency ID).
- Alerts are published both out-of-band and embedded in the next snapshot.

### 2.8 Health Derivation Rules

```
FUNCTION DeriveHealth(errorRate, baselineDelta) -> string:
    IF errorRate >= 0.25 OR baselineDelta >= 5.0 THEN RETURN "critical"
    IF errorRate >= 0.05 OR baselineDelta >= 2.0 THEN RETURN "degraded"
    RETURN "healthy"
```

**Exact thresholds:**

| Status | Error Rate | OR | Baseline Delta |
|--------|------------|-----|----------------|
| critical | >= 25% | OR | >= 5.0x |
| degraded | >= 5% | OR | >= 2.0x |
| healthy | < 5% | AND | < 2.0x |

**No hysteresis in V1.** Transitions happen immediately on next snapshot cycle. V2 may add sticky thresholds.

### 2.9 Window Rotation

```
FUNCTION MaybeRotateWindow(acc, now):
    IF (now - acc.WindowStart).TotalSeconds < 300 THEN RETURN

    // Capture outgoing window stats
    (currentP50, _, _) = ComputePercentiles(acc)
    total = Interlocked.Read(ref acc._totalRequests)
    errors = Interlocked.Read(ref acc._errorCount)
    currentErrorRate = total > 0 ? errors / total : 0

    // Update baselines (EMA)
    UpdateBaseline(acc, currentP50, currentErrorRate)

    // Reset counters for new window
    Interlocked.Exchange(ref acc._totalRequests, 0)
    Interlocked.Exchange(ref acc._errorCount, 0)
    Interlocked.Exchange(ref acc._retryCount, 0)
    Interlocked.Exchange(ref acc._throttleCount, 0)
    Interlocked.Exchange(ref acc._sampleCount, 0)
    Interlocked.Exchange(ref acc._sampleHead, 0)

    acc.WindowStart = now
```

**Window duration:** 300 seconds (5 minutes). Configurable via `EDOG_NEXUS_WINDOW_SEC` env var.

### 2.10 Performance Budget

| Operation | Frequency | Cost | Budget |
|-----------|-----------|------|--------|
| Event ingestion (per consumer) | 10–1,000/sec per topic | `Interlocked.Increment` + array write | <1 μs/event |
| Percentile computation (per edge) | 1 Hz × ~9 edges | Sort 2,000 doubles + rank lookup | ~200 μs/edge |
| Snapshot assembly | 1 Hz | Iterate 9 edges + serialize | <5 ms total |
| Snapshot publish | 1 Hz | `TopicRouter.Publish` | <100 μs |
| Anomaly detection (per edge) | 1 Hz × ~9 edges | 2 comparisons + debounce lookup | <1 μs/edge |
| Persistence flush | 0.2 Hz | JSON serialize _edges | <50 ms |

**Total aggregator CPU budget: <10 ms per second** — well within background service envelope.

---

## §3 Core Engine — Classifier Algorithm

### 3.1 Class: `EdogNexusClassifier`

**File:** `src/backend/DevMode/EdogNexusClassifier.cs` (new)
**Pattern:** `public static class` — pure, stateless function. Safe to call from any thread.
**Performance contract:** <50 μs per classification (6 compiled regex tests worst case).

### 3.2 Ordered Classification Rule Table

Rules are evaluated in order. **First match wins.**

| Priority | Pattern (compiled Regex) | Dependency ID | Source |
|----------|--------------------------|---------------|--------|
| 1 | `/(generatemwctoken\|oauth2/v2\.0/token\|token)(\?\|$\|/)` | `auth` | `spec.md:96`, `EdogTokenInterceptor.cs:63` |
| 2 | `/(livy\|livysessions\|spark\|sparkSessions)/` | `spark-gts` | `spec.md:93`, `filters.js:132` |
| 3 | `/(notebooks?\|jupyter)/` | `spark-gts` | `api-client.js:332`, same GTS backend |
| 4 | `(pbidedicated\|powerbi-df).*/(webapi\|liveTable\|liveTableSchedule)/` | `platform-api` | `EdogApiProxy.cs:92`, `api-client.js:402` |
| 5 | `/capacities/[0-9a-fA-F-]+/` | `capacity` | `spec.md:95` |
| 6 | `(api\.fabric\.microsoft\.com\|/api/fabric)/(v1/)?(workspaces\|lakehouses\|notebooks\|environments\|items)` | `fabric-api` | `api-client.js:80-92` |
| 7 | *(no match)* | `unknown` | fallback |

**Topic-based classification** (non-HTTP events — O(1) switch):

| Topic | Dependency ID | IsInternal |
|-------|---------------|------------|
| `token` | `auth` | false |
| `spark` | `spark-gts` | false |
| `cache` | `cache` | false |
| `retry` | `retry-system` | false |
| `fileop` | `filesystem` | **true** |

### 3.3 Priority Resolution Algorithm

```
FUNCTION Classify(topic, eventData) -> ClassificationResult:
    IF topic == "http" THEN
        url = ExtractField(eventData, "url") ?? ""
        endpointHint = ExtractPathOnly(url)

        FOR EACH (pattern, depId) IN UrlRules:       // ordered array, 6 entries
            IF pattern.IsMatch(url) THEN
                RETURN ClassificationResult(depId, endpointHint, isInternal=false)

        // No match — unknown with normalized signature
        RETURN ClassificationResult("unknown", ExtractUrlSignature(url), isInternal=false)

    // Non-HTTP: topic name IS the classification
    (depId, isInternal) = topic SWITCH:
        "token"  => ("auth",         false)
        "spark"  => ("spark-gts",    false)
        "cache"  => ("cache",        false)
        "retry"  => ("retry-system", false)
        "fileop" => ("filesystem",   true)
        _        => ("unknown",      false)

    endpointHint = ExtractTopicHint(topic, eventData)
    RETURN ClassificationResult(depId, endpointHint, isInternal)
```

### 3.4 Unknown Signature Normalization

Replaces GUIDs and numeric segments with placeholders to cluster similar unknown URLs.

```
FUNCTION ExtractUrlSignature(url) -> string:
    IF url is null or empty THEN RETURN "empty"

    pathOnly = StripQueryString(url)
    pathOnly = StripProtocolAndHost(pathOnly)
    pathOnly = GuidPattern.Replace(pathOnly, "{id}")      // 8-4-4-4-12 or 32-hex
    pathOnly = NumericSegment.Replace(pathOnly, "{n}")     // /\d{2,}/ segments
    IF len(pathOnly) > 256 THEN pathOnly = pathOnly[0..256]
    RETURN pathOnly
```

**Examples:**

| Input URL | Normalized Signature |
|-----------|---------------------|
| `https://unknown.com/v1/workloads/abc-def-123/status/456` | `/v1/workloads/{id}/status/{n}` |
| `https://something.windows.net/path/00000000-0000-0000-0000-000000000000/data` | `/path/{id}/data` |
| `http://localhost:5555/api/health` | `/api/health` |
| *(empty)* | `empty` |

### 3.5 Performance Benchmarks

| Scenario | Target | Mechanism |
|----------|--------|-----------|
| HTTP URL match (first rule hits) | <10 μs | Compiled regex, early exit |
| HTTP URL match (last rule) | <50 μs | 6 compiled regex tests |
| HTTP URL miss (unknown) | <60 μs | All 6 patterns + signature extraction |
| Topic-based (non-HTTP) | <1 μs | Switch expression, no regex |

**Zero allocations on fast path** — `ClassificationResult` is a `readonly struct` (stack-allocated).

---

## §4 Storage / Persistence

### 4.1 Persistence File Format

**File path:** `{data-dir}/nexus/nexus-session.json`

**Data directory resolution** (priority order):
1. `EDOG_DATA_DIR` env var → `{value}/nexus/`
2. Sibling to `edog-config.json` → `{configDir}/edog-data/nexus/`
3. Fallback → `{userHome}/.edog/data/nexus/`

**Schema:**

```json
{
  "schemaVersion": 1,
  "flushedAtUtc": "2026-04-24T04:15:00.000Z",
  "state": {
    "edges": [
      {
        "dependencyId": "spark-gts",
        "totalRequests": 1200,
        "totalErrors": 84,
        "totalRetries": 132,
        "p50Ms": 180.0,
        "p95Ms": 690.0,
        "p99Ms": 920.0,
        "errorRate": 0.07,
        "windowStart": "2026-04-24T04:10:00.000Z",
        "windowEnd": "2026-04-24T04:15:00.000Z"
      }
    ],
    "snapshots": [
      {
        "timestamp": "2026-04-24T04:15:00.000Z",
        "windowSec": 300,
        "nodes": [ ... ],
        "edges": [ ... ]
      }
    ],
    "baselines": {
      "spark-gts": {
        "dependencyId": "spark-gts",
        "baselineP50Ms": 190.5,
        "baselineP95Ms": 450.0,
        "baselineErrorRate": 0.03,
        "sampleCount": 12,
        "lastUpdatedUtc": "2026-04-24T04:10:00.000Z"
      }
    }
  }
}
```

**What is NOT persisted:**
- Raw topic events (unbounded; in ring buffers)
- Request/response bodies (privacy)
- Correlation IDs (ephemeral)
- Frontend rendering state (client-only)

**Serialization:** `System.Text.Json` with `JsonNamingPolicy.CamelCase` (`EdogLogServer.cs:37` pattern). No MessagePack.

### 4.2 Flush Algorithm (Atomic Temp-File Rename)

```
FUNCTION FlushAsync():
    IF _disposed THEN RETURN
    IF NOT Monitor.TryEnter(_flushLock) THEN RETURN    // skip if prior flush in-flight

    TRY:
        state = _snapshotProvider()                     // delegate from aggregator
        IF state == null THEN RETURN

        ApplyRetention(state)

        envelope = { schemaVersion=1, flushedAtUtc=now, state=state }
        tempPath = _filePath + ".tmp"

        AWAIT serialize envelope to tempPath (async FileStream, 4KB buffer)
        File.Move(tempPath, _filePath, overwrite=true)  // atomic on NTFS/ext4

    CATCH ex:
        Console.WriteLine("[EDOG] Nexus flush failed (non-fatal): " + ex.Message)
        // Existing file preserved — temp file is orphaned (cleaned at next restore)
    FINALLY:
        Monitor.Exit(_flushLock)
```

**Atomicity guarantee:** `File.Move` with `overwrite: true` is atomic on NTFS and most POSIX filesystems. If the process crashes mid-write, only the `.tmp` file is corrupted; the main file retains the previous valid state.

**Flush interval:** 5 seconds (configurable via `EDOG_NEXUS_FLUSH_INTERVAL_MS`, default `5000`).

### 4.3 Restore Algorithm

```
FUNCTION RestoreAsync() -> NexusPersistedState:
    // Clean up orphaned temp files from interrupted flushes
    IF File.Exists(_filePath + ".tmp") THEN
        TRY File.Delete(_filePath + ".tmp") CATCH { /* best effort */ }

    IF NOT File.Exists(_filePath) THEN RETURN null     // fresh install

    TRY:
        envelope = AWAIT JsonSerializer.DeserializeAsync<NexusStoreEnvelope>(file)

        IF envelope == null THEN
            QuarantineFile("null envelope")
            RETURN null

        IF envelope.SchemaVersion != 1 THEN
            QuarantineFile("schema v{N} != expected v1")
            RETURN null

        ApplyRetention(envelope.State)
        Console.WriteLine("[EDOG] Nexus session restored ({N} snapshots)")
        RETURN envelope.State

    CATCH JsonException ex:
        QuarantineFile("JSON parse error: " + ex.Message)
        RETURN null

    CATCH Exception ex:
        Console.WriteLine("[EDOG] Nexus restore failed: " + ex.Message)
        RETURN null
```

### 4.4 Retention Policy

**Constants:**
- `MaxSnapshots = 720` — ~1 hour at 5-second intervals
- `MaxAgeMinutes = 60` — discard anything older

```
FUNCTION ApplyRetention(state):
    cutoff = now - 60 minutes

    // Prune snapshots by age, then cap by count
    state.Snapshots.RemoveAll(s => s.Timestamp < cutoff)
    IF state.Snapshots.Count > 720 THEN
        state.Snapshots.RemoveRange(0, Count - 720)     // keep most recent

    // Prune edge stats by window age
    state.Edges.RemoveAll(e => e.WindowEnd < cutoff)

    // Prune orphaned baselines (dep no longer in any snapshot)
    activeDeps = state.Snapshots.SelectMany(s => s.Edges.Select(e => e.To)).ToHashSet()
    FOR EACH key IN state.Baselines.Keys WHERE key NOT IN activeDeps:
        state.Baselines.Remove(key)
```

### 4.5 Corruption Recovery

```
FUNCTION QuarantineFile(reason):
    TRY:
        File.Move(_filePath, _quarantinePath, overwrite=true)
        Console.WriteLine("[EDOG] Nexus session quarantined ({reason}). Starting clean.")
    CATCH ex:
        Console.WriteLine("[EDOG] Quarantine failed: " + ex.Message)
        TRY File.Delete(_filePath) CATCH { /* abandon */ }
```

- Quarantine path: `nexus-session.quarantined.json` (same directory).
- Only most recent quarantine file retained (overwritten).
- **Never blocks service startup. Never throws.**

### 4.6 Concurrent Access Pattern

| Writer | Reader | Mechanism |
|--------|--------|-----------|
| Flush timer | Aggregator hot path | `Func<NexusPersistedState>` snapshot delegate produces deep copy. `Monitor.TryEnter` ensures single flush in-flight. |
| Aggregator counters | Flush timer | `ConcurrentDictionary.foreach` yields consistent keys. Individual `EdgeAccumulator` fields read via `Interlocked.Read`. |
| Restore | No contention | Happens once at startup, before live consumers start. |

---

## §5 Safety Mechanisms

### 5.1 Kill Switch

**Disable Nexus entirely without code changes:**

```
EDOG_NEXUS_ENABLED=false
```

Checked in `EdogDevModeRegistrar.RegisterNexusAggregator()`:

```csharp
private static void RegisterNexusAggregator()
{
    var enabled = Environment.GetEnvironmentVariable("EDOG_NEXUS_ENABLED");
    if (string.Equals(enabled, "false", StringComparison.OrdinalIgnoreCase))
    {
        Console.WriteLine("[EDOG] Nexus aggregator disabled via EDOG_NEXUS_ENABLED=false");
        return;
    }
    // ... start aggregator
}
```

When disabled:
- `nexus` topic is still registered (no-op buffer).
- No consumer tasks, no timer, no persistence.
- Frontend `tab-nexus.js` shows empty state indefinitely.
- Zero CPU cost.

### 5.2 Memory Budget

| Data Structure | Bound | Size Estimate |
|----------------|-------|---------------|
| `_edges` (ConcurrentDictionary) | 9 canonical IDs + ~10 unknown variants = ~20 max | ~20 × EdgeAccumulator |
| `EdgeAccumulator._latencySamples` | 2,000 doubles per edge | 16 KB per edge |
| `EdgeAccumulator._recentCorrelationIds` | 50 strings per edge | ~5 KB per edge |
| `_lastAlertTime` | 1 entry per dependency ID (~20) | <1 KB |
| `nexus` topic ring buffer | 500 TopicEvents | ~2.5 MB (snapshots ~5 KB each) |
| Persistence file | MaxSnapshots=720, MaxAge=60min | <5 MB |
| **Total (all aggregator state)** | | **<4 MB** |

**Hard cap enforcement:** `EdgeAccumulator` constructor allocates fixed-size array. `ConcurrentQueue` prune loop in `RecordCorrelationId`. `ApplyRetention` on every flush cycle.

### 5.3 CPU Budget

**Target: <10 ms/sec aggregator overhead.**

| Operation | Frequency | Cost |
|-----------|-----------|------|
| 6 consumer tasks (classification + ingestion) | continuous | <1 μs/event × 1000/sec = <1 ms/sec |
| Snapshot assembly + percentiles | 1 Hz | <5 ms/tick |
| Anomaly detection | 1 Hz × 9 edges | <0.1 ms |
| Persistence flush | 0.2 Hz | <50 ms × 0.2 = <10 ms/sec |
| **Total** | | **<7 ms/sec nominal** |

### 5.4 Backpressure Cascade

Each layer has independent bounded backpressure. Overflow at any layer does NOT propagate upstream.

```
Layer 1: Source Topic Ring Buffers
  ├─ Bound: 200–10,000 per topic (EdogTopicRouter.cs:28-39)
  ├─ Overflow: DropOldest (FIFO eviction)
  └─ Impact: Consumer processes available events. Stats become approximate.

Layer 2: Nexus Consumer Tasks
  ├─ Bound: process at buffer drain rate
  ├─ Overflow: N/A (consumers never produce backpressure upstream)
  └─ Impact: If consumer stalls, source buffer fills and drops. Consumer retries on error.

Layer 3: EdgeAccumulator
  ├─ Bound: 2,000 samples, 50 correlation IDs per edge
  ├─ Overflow: Circular buffer overwrites oldest samples. FIFO prunes correlation IDs.
  └─ Impact: Percentiles reflect most recent samples only.

Layer 4: Nexus Topic Buffer
  ├─ Bound: 500 TopicEvents
  ├─ Overflow: DropOldest
  └─ Impact: Old snapshots evicted. Frontend always has latest snapshot.

Layer 5: SignalR BoundedChannel (per client)
  ├─ Bound: 1,000 per client (EdogPlaygroundHub.cs:70-76)
  ├─ Overflow: DropOldest
  └─ Impact: Slow clients miss old snapshots. Latest always delivered.

Layer 6: Frontend Rendering
  ├─ Bound: _MAX_VISIBLE_EDGES=50, _MAX_NODES=30 (C06-S01)
  ├─ Overflow: Low-volume edges collapsed into "other" group
  └─ Impact: Triage-critical edges always visible. Low-signal edges hidden.
```

**Key property:** No layer can block or crash its upstream producer. Every overflow is a silent, bounded degradation.

### 5.5 Error Isolation

**Nexus failure must never crash the host FLT process.**

| Failure Point | Isolation Mechanism | Evidence |
|---------------|---------------------|----------|
| `EdogNexusAggregator.Start()` throws | Caught in `RegisterNexusAggregator()` try/catch | Pattern: `EdogDevModeRegistrar.cs:30-52` |
| Consumer task exception | Per-consumer try/catch with 500ms backoff retry | `ConsumeTopicAsync()` outer catch |
| `PublishSnapshot()` exception | Outer try/catch in timer callback | `PublishSnapshot()` wrapping |
| `EdogTopicRouter.Publish()` exception | Router catches all exceptions internally | `EdogTopicRouter.cs:85-89` |
| Persistence flush fails | try/catch, log, skip. Main file preserved. | `FlushAsync()` catch block |
| Persistence restore fails | Quarantine + start clean. Never throws. | `RestoreAsync()` catch blocks |
| Classifier exception on malformed event | Return null, consumer skips event | `Classify()` null return |

### 5.6 Graceful Degradation Tiers

| Tier | Condition | Behavior |
|------|-----------|----------|
| **Normal** | <1,000 events/sec, <10 edges | Full fidelity: all percentiles, anomaly detection, 1 Hz snapshots, persistence |
| **Reduced** | 1,000–5,000 events/sec | Consumers may fall behind source buffers. Stats approximate (newest events only). Snapshots still 1 Hz. |
| **Minimal** | >5,000 events/sec or snapshot takes >1s | Timer delays next tick. Some snapshots skipped. Persistence continues at 5s cadence. Frontend shows stale data (up to 2s). |
| **Disabled** | `EDOG_NEXUS_ENABLED=false` or aggregator Start() fails | No Nexus processing. Zero overhead. Frontend shows empty state. All other DevMode tabs unaffected. |

---

## §6 Cross-Component Integration Map

### 6.1 Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ FLT Service Process                                                          │
│                                                                              │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │ EdogHttpPipeline │  │ EdogTokenInterc. │  │ EdogSparkSessionInterceptor │  │
│  │   Handler.cs     │  │   .cs            │  │   .cs                       │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────┬────────────────┘  │
│           │publish("http")      │publish("token")          │publish("spark")   │
│           ▼                     ▼                          ▼                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                    EdogTopicRouter (static)                              │  │
│  │  ┌──────┐ ┌────────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │  │
│  │  │ http │ │ token  │ │spark │ │retry │ │cache │ │fileop│ │nexus │    │  │
│  │  │ 2000 │ │  500   │ │ 200  │ │ 500  │ │ 2000 │ │ 2000 │ │ 500  │    │  │
│  │  └──┬───┘ └───┬────┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘    │  │
│  └─────┼─────────┼─────────┼────────┼────────┼────────┼────────┼────────┘  │
│        │         │         │        │        │        │        ▲            │
│        ▼         ▼         ▼        ▼        ▼        ▼        │            │
│  ┌─────────────────────────────────────────────────────┐       │            │
│  │            EdogNexusAggregator (static)              │       │            │
│  │                                                      │       │            │
│  │  6 Consumer Tasks → Classify → IngestNormalized      │       │            │
│  │            ↓                                         │       │            │
│  │  ConcurrentDictionary<string, EdgeAccumulator>       │       │            │
│  │            ↓                                         │       │            │
│  │  Timer(1Hz) → PublishSnapshot() ─────────────────────┼───────┘            │
│  │            ↓                                         │                    │
│  │  Timer(5s) → PersistState() ──→ SessionStore         │                    │
│  └──────────────────────────────────────────────────────┘                    │
│        │                                                                     │
│        ▼                                                                     │
│  ┌─────────────────────────┐    ┌──────────────────────────────────┐         │
│  │ EdogNexusSessionStore   │    │ EdogPlaygroundHub                │         │
│  │ nexus-session.json      │    │  SubscribeToTopic("nexus")       │         │
│  │ (atomic flush+restore)  │    │  → snapshot+live → BoundedChannel│         │
│  └─────────────────────────┘    └──────────────┬───────────────────┘         │
│                                                │ SignalR JSON stream          │
└────────────────────────────────────────────────┼─────────────────────────────┘
                                                 │
                                                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Browser (EDOG Studio, localhost:5555)                                       │
│                                                                            │
│  ┌───────────────────────┐                                                 │
│  │ signalr-manager.js    │                                                 │
│  │  subscribeTopic("nexus")                                                │
│  │  on("nexus", cb)      │                                                 │
│  └───────────┬───────────┘                                                 │
│              │ TopicEvent dispatch                                          │
│              ▼                                                             │
│  ┌───────────────────────┐    ┌──────────────────┐                         │
│  │ tab-nexus.js          │───→│ Detail Panel      │                         │
│  │  _onSnapshot()        │    │ p50/p95/p99       │                         │
│  │  _onAlert()           │    │ error codes       │                         │
│  │  Canvas 2D rendering  │    │ deep links:       │                         │
│  │  Hybrid ring layout   │    │  → tab-http.js    │                         │
│  └───────────────────────┘    │  → tab-spark.js   │                         │
│                               │  → retries tab    │                         │
│                               └──────────────────┘                         │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Startup Sequence

```
Step  Caller                          Action                                   Depends On
─────────────────────────────────────────────────────────────────────────────────────────
1.    EdogLogServer.Start()           Build WebApplication, add SignalR        nothing
2.    EdogDevModeRegistrar.RegisterAll()
      2a.  EdogTopicRouter.Initialize()   Register 12 topics (http, spark, ... capacity)   (1)
      2b.  Register interceptors          HttpPipeline, Token, Spark, Retry, Cache, FileOp  (2a)
      2c.  RegisterNexusAggregator()      Check EDOG_NEXUS_ENABLED env var                  (2a, 2b)
           2c.i   EdogTopicRouter.RegisterTopic("nexus", 500)                               (2a)
           2c.ii  EdogNexusSessionStore.RestoreAsync()    Load persisted state               (2c.i)
           2c.iii Spawn 6 consumer tasks                  Subscribe to source topics         (2c.ii)
           2c.iv  Start snapshot timer (1 Hz)             Begin publishing                   (2c.iii)
           2c.v   Start persistence timer (5s)            Begin flushing                     (2c.iv)
3.    EdogLogServer app.Run()         Kestrel starts serving HTTP + SignalR    (1, 2)
4.    Browser connects                signalr-manager.js connects to /hub/playground        (3)
5.    User activates Nexus tab        tab-nexus.js.activate()
      5a.  signalr.on('nexus', cb)
      5b.  signalr.subscribeTopic('nexus')  → SubscribeToTopic("nexus") on hub
      5c.  Phase 1: ring buffer snapshot delivered
      5d.  Phase 2: live events at ~1 Hz
```

### 6.3 Shutdown Sequence

```
Step  Caller                          Action                                   
──────────────────────────────────────────────────────────────────────────────
1.    EdogLogServer.Stop()            Dispose called on app host
2.    EdogNexusAggregator.Stop()
      2a.  _cts.Cancel()             Signal all 6 consumer tasks to exit
      2b.  _snapshotTimer.Dispose()  Stop 1 Hz publishing
      2c.  _persistTimer.Dispose()   Stop 5s flush
      2d.  PublishSnapshot()          Final snapshot (best-effort)
      2e.  SessionStore.Persist()    Final flush to disk (3s timeout)
3.    Consumer tasks exit             OperationCanceledException → clean break
4.    EdogNexusSessionStore.Dispose()
      4a.  _flushTimer.Dispose()
      4b.  Final FlushAsync() with 3s timeout
5.    SignalR hub disconnects          Client streams complete
6.    Browser detects disconnect       signalr-manager.js → "disconnected" status
```

### 6.4 Error Propagation Paths

```
Error Source                    → Propagation Path                → Recovery
────────────────────────────────────────────────────────────────────────────
Classifier exception            → ConsumeTopicAsync catch         → skip event, continue
Consumer ReadLiveAsync error    → ConsumeTopicAsync catch         → 500ms backoff, retry
Snapshot timer exception        → PublishSnapshot outer catch     → skip tick, retry next
TopicRouter.Publish exception   → TopicRouter internal catch      → silent drop (89)
SessionStore flush exception    → FlushAsync catch                → skip, retry next tick
SessionStore restore exception  → RestoreAsync catch              → quarantine, start clean
Hub SubscribeToTopic exception  → Hub Task catch                  → channel.Writer.Complete()
SignalR disconnect              → signalr-manager.js onclose      → auto-reconnect + resubscribe
Frontend render exception       → tab-nexus.js try/catch          → show error state, retry on next snapshot
```

### 6.5 Feature Flag / Config Surface

| Config | Type | Default | Effect |
|--------|------|---------|--------|
| `EDOG_NEXUS_ENABLED` | env var | `true` (absent = enabled) | Kill switch — disables entire Nexus pipeline |
| `EDOG_NEXUS_WINDOW_SEC` | env var | `300` | Rolling window duration for aggregator |
| `EDOG_NEXUS_FLUSH_INTERVAL_MS` | env var | `5000` | Persistence flush cadence |
| `EDOG_DATA_DIR` | env var | *(auto-detected)* | Override persistence directory |
| Internals toggle | frontend UI | off | Show/hide filesystem dependency node |

### 6.6 File Inventory

**New files:**

| File | Owner | Component |
|------|-------|-----------|
| `src/backend/DevMode/EdogNexusModels.cs` | Vex | C01 — Data contracts |
| `src/backend/DevMode/EdogNexusClassifier.cs` | Vex | C02 — Classifier |
| `src/backend/DevMode/EdogNexusAggregator.cs` | Vex | C03 — Aggregator engine |
| `src/backend/DevMode/EdogNexusSessionStore.cs` | Vex | C04 — Persistence |
| `src/frontend/js/tab-nexus.js` | Pixel | C06 — Frontend tab |
| `src/frontend/css/tab-nexus.css` | Pixel | C06 — Frontend styles |

**Modified files:**

| File | Change | Component |
|------|--------|-----------|
| `src/backend/DevMode/EdogTopicRouter.cs` | Add `RegisterTopic("nexus", 500)` in `Initialize()` | C05 |
| `src/backend/DevMode/EdogPlaygroundHub.cs` | Update XML doc comment to include `nexus` topic | C05 |
| `src/backend/DevMode/EdogLogServer.cs` | Add `/api/nexus` REST endpoint | C05 |
| `src/backend/DevMode/EdogDevModeRegistrar.cs` | Add `RegisterNexusAggregator()` call + method | C05 |
| `src/frontend/js/runtime-view.js` | Register `nexus` tab in tab lifecycle | C06 |
| `src/frontend/js/main.js` | Instantiate `NexusTab`, bootstrap registration | C06 |
| `src/frontend/index.html` | Add Nexus container div + nav entry | C06 |

### 6.7 Cross-Reference Matrix (P1 Scenarios → Architecture)

| P1 Scenario | Architecture Section |
|-------------|---------------------|
| C01 all types | §1 Data Model |
| C02-S01 HTTP URL classification | §3.2 Rule Table, §3.3 Priority Resolution |
| C02-S02 Topic-based classification | §3.2 Topic-based table |
| C02-S03 Unknown fallback | §3.4 Signature Normalization |
| C02-S04 Ambiguous URL resolution | §3.2 Priority order, §3.3 first-match-wins |
| C02-S06 Performance | §3.5 Benchmarks |
| C02-S07 Filesystem filtering | §3.2 `fileop → filesystem, isInternal=true` |
| C03-S01 Multi-topic subscription | §2.4 `Start()` pseudocode |
| C03-S02 Event normalization | §1.4 Field mapping table |
| C03-S03 Rolling window accumulation | §2.4 `IngestNormalizedEvent()`, §2.5 Circular Buffer |
| C03-S04 Percentile computation | §2.6 Nearest-Rank Method |
| C03-S05 Health derivation | §2.8 Exact thresholds |
| C03-S06 Anomaly detection | §2.7 EMA Baseline + Threshold |
| C03-S07 Snapshot emission | §2.4 `PublishSnapshot()` pseudocode |
| C03-S08 Alert emission | §2.4 out-of-band alert loop |
| C03-S09 Lifecycle management | §2.4 `Start()`/`Stop()`, §6.2/§6.3 sequences |
| C03-S10 Session persistence coordination | §4 full section |
| C03-S11 Backpressure handling | §5.4 Backpressure Cascade |
| C03-S12 Correlation ID tracking | §2.2 `_recentCorrelationIds`, §2.4 `IngestNormalizedEvent()` |
| C03-S13 Window rotation | §2.9 `MaybeRotateWindow()` pseudocode |
| C04 Periodic flush | §4.2 Flush Algorithm |
| C04 Graceful shutdown | §6.3 Shutdown Sequence |
| C04 Startup restore | §4.3 Restore Algorithm |
| C04 File format | §4.1 Persistence File Format |
| C04 Retention policy | §4.4 Retention Policy |
| C04 Corruption handling | §4.5 Corruption Recovery |
| C04 Concurrent access | §4.6 Concurrent Access Pattern |
| C05-SC01 Topic registration | §6.2 Step 2c.i |
| C05-SC02 Snapshot publishing | §2.4 `PublishSnapshot()` |
| C05-SC04 Frontend subscription | §6.2 Step 5, §1.9 Wire Format |
| C05-SC05 Snapshot + live delivery | §6.2 Steps 5c–5d |
| C05-SC06 Bootstrap REST endpoint | §6.6 Modified files (EdogLogServer.cs) |
| C05-SC07 Reconnect behavior | §6.4 SignalR disconnect row |
| C05-SC09 Aggregator startup | §6.2 Step 2c |
| C06-S01 Tab module structure | §1.10 JS-Side Type Contracts |
| C06-S02 Topic subscription lifecycle | §6.2 Step 5 |
| C06-S03 Empty state | §5.6 Disabled tier |
| C06-S04 Healthy topology rendering | §1.9 Snapshot wire format |

---

*End of P2 Architecture Specification.*
