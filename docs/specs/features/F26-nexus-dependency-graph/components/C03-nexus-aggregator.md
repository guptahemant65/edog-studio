# C03 — Nexus Aggregator (Core Engine)

> **Component ID:** C03
> **Feature:** F26 — Nexus: Real-Time Cross-Workload Dependency Graph
> **Phase:** P1 (Core)
> **Owner:** Vex (backend), Sana (architecture)
> **Priority:** P0 — all downstream Nexus components depend on aggregator output
> **New file:** `src/backend/DevMode/EdogNexusAggregator.cs`
> **Spec ref:** `docs/specs/features/F26-nexus-dependency-graph/spec.md` §3
> **Design ref:** `docs/superpowers/specs/2026-04-24-nexus-design.md` §4
> **Research ref:** `docs/specs/features/F26-nexus-dependency-graph/research/p0-foundation.md` §1, §5

---

## 1. Overview

The Nexus Aggregator is a long-lived background service that fuses six independent
topic streams (`http`, `spark`, `token`, `retry`, `cache`, `fileop`) into a unified
dependency-health model. It is the single producer of the `nexus` topic — all
downstream consumers (frontend `tab-nexus.js`, deep-link actions, anomaly toasts)
receive pre-aggregated snapshots rather than raw events.

**Core responsibilities:**

1. Subscribe to source topics via `TopicBuffer.ReadLiveAsync()`.
2. Normalize each raw event through `EdogNexusClassifier` into `NexusNormalizedEvent`.
3. Accumulate per-edge statistics in rolling time windows (5-minute default).
4. Compute latency percentiles (p50/p95/p99), error rates, retry rates, throughput.
5. Derive per-edge health status (`healthy` / `degraded` / `critical`).
6. Detect anomalies against rolling baselines (latency spike, error-rate deviation).
7. Publish `NexusSnapshot` to the `nexus` topic at ~1 Hz cadence.
8. Publish out-of-band `NexusAlert` events immediately on anomaly detection.
9. Coordinate with `EdogNexusSessionStore` for periodic persistence and startup restore.

**Threading model:** Multiple interceptor threads publish to source topic buffers
concurrently. The aggregator runs a single consumer loop per source topic, draining
into a shared `ConcurrentDictionary<string, EdgeAccumulator>`. A dedicated timer
thread computes snapshots. No lock contention on the hot path — all shared state
uses lock-free concurrent collections or `Interlocked` operations.

**Lifecycle:** Registered in `EdogDevModeRegistrar.RegisterAll()`, started after
`EdogTopicRouter.Initialize()`. Stopped via `CancellationToken` on server shutdown.
Graceful stop flushes final snapshot and persists state via `SessionStore`.

---

## 2. Data Structures

### 2.1 NexusNormalizedEvent (input to reducer)

```csharp
// Produced by EdogNexusClassifier from any source topic event.
// Uniform shape regardless of origin topic.
internal struct NexusNormalizedEvent
{
    public string DependencyId;     // e.g. "spark-gts", "auth", "fabric-api"
    public string SourceTopic;      // "http", "spark", "token", "retry", "cache", "fileop"
    public DateTimeOffset Timestamp;
    public string Method;           // HTTP method or operation name; null if N/A
    public int StatusCode;          // HTTP status or 0 for non-HTTP events
    public double LatencyMs;        // Measured duration; 0 if enrichment-only (retry/cache)
    public bool IsError;            // 4xx/5xx or exception
    public int RetryCount;          // From retry enrichment; 0 default
    public string CorrelationId;    // For cross-event join; null if absent
    public string EndpointHint;     // Redacted URL path or operation name
    public string IterationId;      // FLT iteration context; null if absent
    public bool IsEnrichmentOnly;   // true for retry/cache events that augment existing edges
}
```

### 2.2 EdgeAccumulator (per-edge rolling state)

```csharp
// One instance per dependency edge (keyed by dependencyId).
// All mutations via Interlocked or append-only ConcurrentQueue.
internal sealed class EdgeAccumulator
{
    public string DependencyId;

    // Rolling window latency samples (bounded circular buffer)
    private readonly double[] _latencySamples;  // pre-allocated, size = MaxSamplesPerWindow
    private int _sampleHead;                     // Interlocked.Increment write cursor
    private int _sampleCount;                    // Interlocked.Increment count

    // Counters (Interlocked)
    private long _totalRequests;
    private long _errorCount;
    private long _retryCount;
    private long _throttleCount;

    // Timestamp bounds
    public DateTimeOffset WindowStart;
    public DateTimeOffset LastEventTime;

    // Baseline (updated at window rotation)
    public double BaselineP50Ms;
    public double BaselineErrorRate;
}
```

### 2.3 NexusSnapshot (output to `nexus` topic)

```csharp
// Published ~1 Hz. Contract matches design spec §5.3.
internal sealed class NexusSnapshot
{
    public DateTimeOffset GeneratedAt;
    public int WindowSec;                    // 300 (5 minutes)
    public List<NexusNode> Nodes;
    public List<NexusEdge> Edges;
    public List<NexusAlert> Alerts;          // Only populated when anomalies detected
}

internal sealed class NexusNode
{
    public string Id;       // "flt-local" or dependency ID
    public string Kind;     // "core" or "dependency"
    public long Volume;     // Total events in window
}

internal sealed class NexusEdge
{
    public string From;             // Always "flt-local" in V1
    public string To;               // Dependency ID
    public long Volume;
    public double ThroughputPerMin;
    public double P50Ms;
    public double P95Ms;
    public double P99Ms;
    public double ErrorRate;        // 0.0–1.0
    public double RetryRate;        // 0.0–1.0
    public string Health;           // "healthy", "degraded", "critical"
    public double BaselineDelta;    // Ratio: currentP50 / baselineP50; 1.0 = normal
}

internal sealed class NexusAlert
{
    public string Severity;         // "warning" or "critical"
    public string DependencyId;
    public string Message;
    public DateTimeOffset DetectedAt;
}
```

---

## 3. Scenarios

### S01 — Multi-Topic Subscription Startup

**ID:** `C03-S01`
**One-liner:** Aggregator subscribes to all six source topics on startup and begins draining events.

**Trigger:** `EdogDevModeRegistrar.RegisterAll()` calls `EdogNexusAggregator.Start()` after `EdogTopicRouter.Initialize()` completes.

**Expected behavior:**
1. Aggregator registers the `nexus` topic on `EdogTopicRouter` (buffer size 200 — snapshots are small, high-frequency).
2. For each source topic (`http`, `spark`, `token`, `retry`, `cache`, `fileop`), spawns a dedicated consumer `Task` that calls `TopicBuffer.ReadLiveAsync()`.
3. Each consumer task classifies incoming events via `EdogNexusClassifier.Classify()` and feeds `NexusNormalizedEvent` into the shared `EdgeAccumulator` map.
4. Startup completes without blocking the FLT service thread.

**Technical mechanism:**
```csharp
public static class EdogNexusAggregator
{
    private static readonly string[] SourceTopics =
        { "http", "spark", "token", "retry", "cache", "fileop" };

    private static readonly ConcurrentDictionary<string, EdgeAccumulator> _edges = new();
    private static CancellationTokenSource _cts;
    private static Timer _snapshotTimer;
    private static bool _started;

    public static void Start()
    {
        if (_started) return;
        _started = true;

        // Register nexus output topic
        EdogTopicRouter.RegisterTopic("nexus", 200);

        _cts = new CancellationTokenSource();
        var ct = _cts.Token;

        // Restore persisted state (non-blocking)
        EdogNexusSessionStore.TryRestore(_edges);

        // Spawn one consumer task per source topic
        foreach (var topic in SourceTopics)
        {
            _ = Task.Run(() => ConsumeTopicAsync(topic, ct), ct);
        }

        // Start snapshot timer (~1 Hz)
        _snapshotTimer = new Timer(
            _ => PublishSnapshot(),
            state: null,
            dueTime: TimeSpan.FromSeconds(1),
            period: TimeSpan.FromSeconds(1));

        Console.WriteLine("[EDOG] Nexus aggregator started");
    }
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — new file (this component)
- `src/backend/DevMode/EdogTopicRouter.cs:47-50` — `RegisterTopic()` pattern
- `src/backend/DevMode/EdogDevModeRegistrar.cs:33` — `EdogTopicRouter.Initialize()` call site

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| Source topic not yet registered | `GetBuffer()` returns null; consumer task logs warning and retries after 1s delay (topic may register later). |
| `Start()` called twice | Idempotent — `_started` flag prevents double-subscription. |
| Persisted state corrupt | `TryRestore` returns false, aggregator starts clean (see S10). |
| FLT crashes before `Start()` | No effect — aggregator never runs. Topic buffers continue to accept events silently. |

**Interactions:**
- **EdogTopicRouter** — registers `nexus` topic, reads from 6 source topic buffers
- **EdogDevModeRegistrar** — lifecycle owner; calls `Start()` / `Stop()`
- **EdogNexusSessionStore** — restores persisted edge state on startup
- **EdogNexusClassifier** — classifies raw events (called from consumer tasks)

**Revert mechanism:** Remove `EdogNexusAggregator.Start()` call from `EdogDevModeRegistrar`. Source topics continue publishing unchanged — zero impact on existing tabs.

**Priority:** P0 — all other scenarios depend on topic subscription being active.

---

### S02 — Event Normalization (Classifier Pipeline)

**ID:** `C03-S02`
**One-liner:** Each raw topic event is classified into a `NexusNormalizedEvent` with a canonical dependency ID.

**Trigger:** Consumer task receives a `TopicEvent` from any source topic's live stream.

**Expected behavior:**
1. Classifier inspects `TopicEvent.Data` properties based on `TopicEvent.Topic`.
2. For `http` events: extract URL, classify via URL-pattern matching into dependency ID (`spark-gts`, `fabric-api`, `platform-api`, `auth`, `capacity`, `unknown`). Extract `method`, `statusCode`, `durationMs`, `correlationId`.
3. For `spark` events: always map to `spark-gts`. Extract `durationMs`, `event` (Created/Error), `sessionTrackingId`.
4. For `token` events: always map to `auth`. Extract `scheme`, `audience`, `endpoint`.
5. For `retry` events: classify by `endpoint` URL pattern. Mark `IsEnrichmentOnly = true`. Extract `retryAttempt`, `waitDurationMs`, `isThrottle`.
6. For `cache` events: map to `cache`. Mark `IsEnrichmentOnly = true`. Extract `operation`, `durationMs`.
7. For `fileop` events: map to `filesystem`. Extract `operation`, `durationMs`, `contentSizeBytes`.
8. Unknown URLs map to `unknown` — never silently dropped.

**Technical mechanism:**
```csharp
private static async Task ConsumeTopicAsync(string topic, CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        var buffer = EdogTopicRouter.GetBuffer(topic);
        if (buffer == null)
        {
            await Task.Delay(1000, ct);
            continue;
        }

        try
        {
            await foreach (var topicEvent in buffer.ReadLiveAsync(ct))
            {
                var normalized = EdogNexusClassifier.Classify(topic, topicEvent);
                if (normalized.HasValue)
                {
                    IngestNormalizedEvent(normalized.Value);
                }
            }
        }
        catch (OperationCanceledException) { break; }
        catch (Exception ex)
        {
            Debug.WriteLine($"[EDOG] Nexus consumer '{topic}' error: {ex.Message}");
            await Task.Delay(500, ct); // backoff before retry
        }
    }
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `ConsumeTopicAsync()`
- `src/backend/DevMode/EdogNexusClassifier.cs` — `Classify()` (sibling component C02)
- `src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78` — HTTP event shape
- `src/backend/DevMode/EdogSparkSessionInterceptor.cs:86-98` — Spark event shape
- `src/backend/DevMode/EdogTokenInterceptor.cs:63-72` — Token event shape
- `src/backend/DevMode/EdogRetryInterceptor.cs:186-200` — Retry event shape

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| `TopicEvent.Data` is null | Classifier returns `null`; consumer skips. |
| URL matches no known pattern | Maps to `unknown`. `EndpointHint` preserves redacted URL for later classifier rule updates. |
| Retry event has no `endpoint` field | Falls back to `unknown` dependency. `IsEnrichmentOnly` still true. |
| Spark `Error` event | `IsError = true`, `LatencyMs` from `durationMs` field. |
| Dynamic property access fails | Classifier catches per-field exceptions; partial normalization preferred over full drop. |

**Interactions:**
- **EdogNexusClassifier** (C02) — stateless classifier; Aggregator is the sole caller
- **TopicBuffer** — provides `ReadLiveAsync()` `IAsyncEnumerable<TopicEvent>` stream

**Revert mechanism:** Classifier is a pure function with no side effects. Replacing it with a passthrough that maps everything to `unknown` degrades classification but preserves pipeline integrity.

**Priority:** P0 — normalization is the input gate for all downstream aggregation.

---

### S03 — Rolling Window Statistics Accumulation

**ID:** `C03-S03`
**One-liner:** Normalized events are accumulated into per-edge rolling windows for latency, error, and throughput stats.

**Trigger:** `IngestNormalizedEvent()` called from any consumer task after successful classification.

**Expected behavior:**
1. Look up or create `EdgeAccumulator` in `_edges` dictionary (keyed by `dependencyId`).
2. Record latency sample into circular buffer (if `!IsEnrichmentOnly` and `LatencyMs > 0`).
3. Increment `_totalRequests` counter (if `!IsEnrichmentOnly`).
4. Increment `_errorCount` if `IsError`.
5. Increment `_retryCount` if `RetryCount > 0` or event is from `retry` topic.
6. Increment `_throttleCount` if retry event has `isThrottle = true`.
7. Update `LastEventTime`.
8. For enrichment-only events (retry/cache): increment enrichment counters without adding to latency samples or total requests.

**Technical mechanism:**
```csharp
private const int MaxSamplesPerWindow = 2000;

private static void IngestNormalizedEvent(NexusNormalizedEvent evt)
{
    var acc = _edges.GetOrAdd(evt.DependencyId, id => new EdgeAccumulator(id, MaxSamplesPerWindow));

    if (!evt.IsEnrichmentOnly)
    {
        // Record latency sample (lock-free circular buffer)
        if (evt.LatencyMs > 0)
        {
            int slot = Interlocked.Increment(ref acc._sampleHead) % MaxSamplesPerWindow;
            acc._latencySamples[slot] = evt.LatencyMs;
            InterlockedMax(ref acc._sampleCount, acc._sampleHead);
        }

        Interlocked.Increment(ref acc._totalRequests);

        if (evt.IsError)
            Interlocked.Increment(ref acc._errorCount);
    }

    if (evt.RetryCount > 0 || evt.SourceTopic == "retry")
        Interlocked.Increment(ref acc._retryCount);

    acc.LastEventTime = DateTimeOffset.UtcNow; // volatile write acceptable
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `IngestNormalizedEvent()`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| First event for a new dependency | `GetOrAdd` creates fresh `EdgeAccumulator`. Pre-allocated sample buffer avoids GC pressure. |
| Circular buffer wraps around | Oldest samples are overwritten. This is by design — rolling window only needs recent data. |
| `LatencyMs == 0` (e.g., token event with no timing) | Sample not recorded. Counter still incremented for volume tracking. |
| Enrichment-only retry event for unknown dependency | Creates accumulator but only increments retry counter. Latency/volume remain 0 until a primary event arrives. |
| Extremely high event rate (>10K/sec) | `Interlocked` operations are contention-free under moderate load. Under extreme load, `ConcurrentDictionary.GetOrAdd` may briefly allocate redundant accumulators (acceptable — last-wins semantics). |
| Two consumer tasks write to same edge concurrently | Safe — all mutations are `Interlocked` or `volatile`. No locks. |

**Interactions:**
- **EdgeAccumulator** — per-edge state container; pre-allocated on first event
- **NexusNormalizedEvent** — input from S02

**Revert mechanism:** Clear `_edges` dictionary. Next snapshot will be empty. Frontend shows "No dependencies detected."

**Priority:** P0 — the statistical foundation for all downstream computations.

---

### S04 — Percentile Computation (p50/p95/p99)

**ID:** `C03-S04`
**One-liner:** Snapshot timer computes latency percentiles from each edge's rolling sample buffer.

**Trigger:** `_snapshotTimer` fires (~1 Hz).

**Expected behavior:**
1. For each `EdgeAccumulator`, copy the valid portion of `_latencySamples` into a local array.
2. Sort the local copy (O(n log n) where n <= `MaxSamplesPerWindow`).
3. Compute p50, p95, p99 using nearest-rank method.
4. Package results into `NexusEdge` object.

**Technical mechanism:**
```csharp
private static (double p50, double p95, double p99) ComputePercentiles(EdgeAccumulator acc)
{
    int count = Math.Min(acc._sampleCount, MaxSamplesPerWindow);
    if (count == 0)
        return (0, 0, 0);

    // Snapshot the circular buffer into a local array
    var samples = new double[count];
    int head = acc._sampleHead;
    for (int i = 0; i < count; i++)
    {
        int idx = (head - count + 1 + i + MaxSamplesPerWindow) % MaxSamplesPerWindow;
        samples[i] = acc._latencySamples[idx];
    }

    Array.Sort(samples);

    return (
        samples[NearestRank(count, 0.50)],
        samples[NearestRank(count, 0.95)],
        samples[NearestRank(count, 0.99)]
    );
}

private static int NearestRank(int count, double percentile)
{
    int rank = (int)Math.Ceiling(percentile * count) - 1;
    return Math.Clamp(rank, 0, count - 1);
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `ComputePercentiles()`, `NearestRank()`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| Zero samples in window | Returns (0, 0, 0). Edge still appears in snapshot with volume/error data but no latency. |
| Exactly 1 sample | p50 = p95 = p99 = that single value. |
| Samples being written concurrently during snapshot | Snapshot reads a potentially stale subset. Acceptable — we tolerate ±1 sample lag at 1 Hz frequency. |
| All samples identical (e.g., 200ms) | All percentiles equal. No division-by-zero risk. |
| Outlier >60s (hung request) | Included in sort. p99 will reflect it. Anomaly detector (S06) flags the spike. |

**Interactions:**
- **EdgeAccumulator** — source of raw latency samples
- **NexusSnapshot** — destination for computed percentiles

**Revert mechanism:** Replace with stub returning (0, 0, 0). Snapshot still published but without latency data.

**Priority:** P0 — percentiles are the primary signal for triage UX (edge color, detail panel).

---

### S05 — Health Derivation

**ID:** `C03-S05`
**One-liner:** Each edge is assigned a health status based on error rate and latency deviation from baseline.

**Trigger:** `PublishSnapshot()` computes health per edge after percentile computation.

**Expected behavior:**
1. Compute `errorRate = errorCount / totalRequests` (0 if no requests).
2. Compute `baselineDelta = currentP50 / baselineP50` (1.0 if no baseline yet).
3. Derive health:
   - `critical`: errorRate >= 0.25 OR baselineDelta >= 5.0
   - `degraded`: errorRate >= 0.05 OR baselineDelta >= 2.0
   - `healthy`: everything else

**Technical mechanism:**
```csharp
private static string DeriveHealth(double errorRate, double baselineDelta)
{
    if (errorRate >= 0.25 || baselineDelta >= 5.0)
        return "critical";
    if (errorRate >= 0.05 || baselineDelta >= 2.0)
        return "degraded";
    return "healthy";
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `DeriveHealth()`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| Zero requests (new edge) | `errorRate = 0`, `baselineDelta = 1.0` → `healthy`. |
| Baseline not yet established | `baselineP50 = 0` → `baselineDelta` forced to `1.0` (neutral). |
| 100% error rate | `critical`. This is correct — zero successful requests means full outage. |
| Latency spike but zero errors | `baselineDelta >= 5.0` alone triggers `critical`. Correct for slow dependencies. |
| Transient single-error blip | If 1 error in 100 requests = 1% < 5% threshold → stays `healthy`. This dampens noise. |

**Interactions:**
- **S04** — provides percentiles for baseline delta calculation
- **S06** — anomaly detection uses same thresholds for alert generation
- **NexusEdge** — `Health` field populated by this derivation

**Revert mechanism:** Hardcode all edges to `"healthy"`. Frontend renders green topology.

**Priority:** P1 — health is the visual encoding driver for triage UX.

---

### S06 — Anomaly Detection

**ID:** `C03-S06`
**One-liner:** Detects latency spikes and error-rate deviations against rolling baselines and emits `NexusAlert`.

**Trigger:** `PublishSnapshot()` evaluates each edge's current state against its baseline.

**Expected behavior:**
1. After each window rotation (every 5 minutes), update baseline: `baselineP50 = exponential moving average of historical p50 values`.
2. On each 1 Hz snapshot tick, compare current p50 to baseline:
   - If `currentP50 / baselineP50 >= 3.0` → emit `warning` alert.
   - If `currentP50 / baselineP50 >= 5.0` → emit `critical` alert.
3. Compare current error rate to baseline error rate:
   - If `currentErrorRate - baselineErrorRate >= 0.10` → emit `warning` alert.
   - If `currentErrorRate >= 0.50` → emit `critical` alert.
4. Alerts include debounce: same dependency + same severity → suppress for 30 seconds.
5. Alert published to `nexus` topic as out-of-band event AND included in next snapshot's `alerts` array.

**Technical mechanism:**
```csharp
private const double LatencyWarningMultiplier = 3.0;
private const double LatencyCriticalMultiplier = 5.0;
private const double ErrorRateWarningDelta = 0.10;
private const double ErrorRateCriticalAbsolute = 0.50;
private static readonly TimeSpan AlertDebounceInterval = TimeSpan.FromSeconds(30);

// Per-edge last alert time to implement debounce
private static readonly ConcurrentDictionary<string, DateTimeOffset> _lastAlertTime = new();

private static List<NexusAlert> DetectAnomalies(
    string dependencyId, double currentP50, double baselineP50,
    double currentErrorRate, double baselineErrorRate)
{
    var alerts = new List<NexusAlert>();
    var now = DateTimeOffset.UtcNow;

    // Debounce check
    string debounceKey = dependencyId;
    if (_lastAlertTime.TryGetValue(debounceKey, out var lastTime)
        && now - lastTime < AlertDebounceInterval)
        return alerts;

    // Latency spike detection
    if (baselineP50 > 0)
    {
        double ratio = currentP50 / baselineP50;
        if (ratio >= LatencyCriticalMultiplier)
        {
            alerts.Add(new NexusAlert
            {
                Severity = "critical",
                DependencyId = dependencyId,
                Message = $"Latency {ratio:F1}x above baseline ({currentP50:F0}ms vs {baselineP50:F0}ms avg)",
                DetectedAt = now
            });
        }
        else if (ratio >= LatencyWarningMultiplier)
        {
            alerts.Add(new NexusAlert
            {
                Severity = "warning",
                DependencyId = dependencyId,
                Message = $"Latency {ratio:F1}x above baseline ({currentP50:F0}ms vs {baselineP50:F0}ms avg)",
                DetectedAt = now
            });
        }
    }

    // Error rate deviation
    if (currentErrorRate >= ErrorRateCriticalAbsolute)
    {
        alerts.Add(new NexusAlert
        {
            Severity = "critical",
            DependencyId = dependencyId,
            Message = $"Error rate {currentErrorRate:P0} — majority of requests failing",
            DetectedAt = now
        });
    }
    else if (currentErrorRate - baselineErrorRate >= ErrorRateWarningDelta)
    {
        alerts.Add(new NexusAlert
        {
            Severity = "warning",
            DependencyId = dependencyId,
            Message = $"Error rate increased to {currentErrorRate:P0} (baseline {baselineErrorRate:P0})",
            DetectedAt = now
        });
    }

    if (alerts.Count > 0)
        _lastAlertTime[debounceKey] = now;

    return alerts;
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `DetectAnomalies()`, `_lastAlertTime`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| No baseline yet (first 5-minute window) | `baselineP50 = 0` → skip latency spike check. Error rate absolute threshold still applies. |
| Steady slow dependency (always 500ms) | Baseline converges to 500ms. No spike detected (ratio ≈ 1.0). Correct — baseline-relative. |
| Latency drops (improvement) | Ratio < 1.0 → no alert. Not anomalous. |
| Alert debounce fires | Same dependency suppressed for 30s. Prevents alert flood during sustained degradation. |
| Multiple anomaly types on same edge | Both latency and error-rate alerts can fire simultaneously. Frontend deduplicates by severity. |
| Edge goes idle (no events for >5 min) | Counters freeze at last values. Next window rotation zeros the accumulators. |

**Interactions:**
- **S04** — percentiles feed anomaly thresholds
- **S05** — health derivation uses overlapping thresholds (aligned by design)
- **NexusSnapshot.Alerts** — alerts embedded in snapshot payload
- **`nexus` topic** — out-of-band alert published immediately for fast frontend reaction
- **Frontend anomaly.js** — consumes alerts for toast notifications

**Revert mechanism:** Return empty alert list. Frontend never shows anomaly toasts. Health derivation (S05) still functions independently.

**Priority:** P1 — anomaly detection is the incident-triage differentiator.

---

### S07 — Snapshot Emission (~1 Hz)

**ID:** `C03-S07`
**One-liner:** Timer callback assembles and publishes a complete `NexusSnapshot` to the `nexus` topic every ~1 second.

**Trigger:** `System.Threading.Timer` fires at 1-second intervals.

**Expected behavior:**
1. Iterate all `EdgeAccumulator` entries in `_edges`.
2. For each edge: compute percentiles (S04), derive health (S05), detect anomalies (S06).
3. Build `NexusNode` list (always includes `flt-local` as core node plus one node per active dependency).
4. Build `NexusEdge` list with all computed stats.
5. Collect all alerts from anomaly detection.
6. Wrap in `NexusSnapshot` envelope with `generatedAt` and `windowSec`.
7. Publish to `nexus` topic via `EdogTopicRouter.Publish("nexus", snapshot)`.
8. If alerts were generated, also publish each as individual out-of-band event.

**Technical mechanism:**
```csharp
private static void PublishSnapshot()
{
    try
    {
        var now = DateTimeOffset.UtcNow;
        var nodes = new List<NexusNode> { new() { Id = "flt-local", Kind = "core", Volume = 0 } };
        var edges = new List<NexusEdge>();
        var allAlerts = new List<NexusAlert>();

        foreach (var kvp in _edges)
        {
            var acc = kvp.Value;
            var (p50, p95, p99) = ComputePercentiles(acc);
            long total = Interlocked.Read(ref acc._totalRequests);
            long errors = Interlocked.Read(ref acc._errorCount);
            long retries = Interlocked.Read(ref acc._retryCount);

            double errorRate = total > 0 ? (double)errors / total : 0;
            double retryRate = total > 0 ? (double)retries / total : 0;
            double baselineDelta = acc.BaselineP50Ms > 0 ? p50 / acc.BaselineP50Ms : 1.0;
            string health = DeriveHealth(errorRate, baselineDelta);

            double windowMinutes = (now - acc.WindowStart).TotalMinutes;
            double throughput = windowMinutes > 0 ? total / windowMinutes : 0;

            nodes.Add(new NexusNode { Id = acc.DependencyId, Kind = "dependency", Volume = total });
            edges.Add(new NexusEdge
            {
                From = "flt-local",
                To = acc.DependencyId,
                Volume = total,
                ThroughputPerMin = Math.Round(throughput, 1),
                P50Ms = Math.Round(p50, 1),
                P95Ms = Math.Round(p95, 1),
                P99Ms = Math.Round(p99, 1),
                ErrorRate = Math.Round(errorRate, 4),
                RetryRate = Math.Round(retryRate, 4),
                Health = health,
                BaselineDelta = Math.Round(baselineDelta, 2)
            });

            // Anomaly detection
            var alerts = DetectAnomalies(
                acc.DependencyId, p50, acc.BaselineP50Ms, errorRate, acc.BaselineErrorRate);
            allAlerts.AddRange(alerts);
        }

        // Update flt-local volume (sum of all edges)
        nodes[0].Volume = edges.Sum(e => e.Volume);

        var snapshot = new NexusSnapshot
        {
            GeneratedAt = now,
            WindowSec = 300,
            Nodes = nodes,
            Edges = edges,
            Alerts = allAlerts
        };

        EdogTopicRouter.Publish("nexus", snapshot);

        // Out-of-band alerts for fast frontend reaction
        foreach (var alert in allAlerts)
        {
            EdogTopicRouter.Publish("nexus", new { type = "alert", data = alert });
        }
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"[EDOG] Nexus snapshot error: {ex.Message}");
    }
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `PublishSnapshot()`
- `src/backend/DevMode/EdogTopicRouter.cs:69-90` — `Publish()` pattern

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| No edges exist yet (no events received) | Snapshot contains only `flt-local` node with `volume=0`. Empty edges/alerts. Valid minimal state for frontend. |
| Timer callback takes >1s (heavy edge count) | Next tick fires after current completes. Timer is non-reentrant by design (single-thread timer). |
| Exception during one edge's computation | Caught per-edge. Other edges still computed. Partial snapshot preferred over no snapshot. |
| >50 edges (unlikely but possible) | All edges included. Frontend rendering caps handled by frontend (C05). |
| `EdogTopicRouter.Publish` fails silently | `TopicRouter.Publish` catches exceptions internally (`EdogTopicRouter.cs:85-89`). Snapshot lost but next tick retries. |

**Interactions:**
- **EdogTopicRouter** — `Publish("nexus", snapshot)` writes to nexus ring buffer
- **EdogPlaygroundHub** — clients subscribed to `nexus` topic receive snapshots via `SubscribeToTopic()`
- **EdogNexusSessionStore** — persistence hooks into snapshot cycle (see S10)
- **S04, S05, S06** — all called within snapshot assembly

**Revert mechanism:** Dispose `_snapshotTimer`. No snapshots published. Frontend receives no updates.

**Priority:** P0 — snapshot emission is the primary output of the entire aggregator.

---

### S08 — Alert Emission (Out-of-Band)

**ID:** `C03-S08`
**One-liner:** Anomaly alerts are published immediately as separate events on the `nexus` topic, in addition to being embedded in the next snapshot.

**Trigger:** `DetectAnomalies()` returns non-empty alert list during snapshot computation.

**Expected behavior:**
1. Each alert is published as `{ type: "alert", data: NexusAlert }` to the `nexus` topic immediately.
2. The same alerts are also included in the `NexusSnapshot.Alerts` array for clients that consume snapshots.
3. Frontend toast system listens for `type == "alert"` events and renders immediately, not waiting for next snapshot.

**Technical mechanism:**
```csharp
// Inside PublishSnapshot(), after snapshot is published:
foreach (var alert in allAlerts)
{
    EdogTopicRouter.Publish("nexus", new
    {
        type = "alert",
        data = new
        {
            alert.Severity,
            alert.DependencyId,
            alert.Message,
            detectedAt = alert.DetectedAt.ToString("o")
        }
    });
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — tail of `PublishSnapshot()`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| Debounced alert | Not published. See S06 debounce logic. |
| Frontend not subscribed to `nexus` | Events written to ring buffer; read when client subscribes (snapshot-first-then-live pattern). |
| Multiple alerts on same tick | Each published independently. Frontend handles per-dependency dedup if needed. |

**Interactions:**
- **EdogTopicRouter** — alert events flow through same `nexus` ring buffer
- **Frontend `tab-nexus.js`** — filters `type == "alert"` for toast display
- **Frontend `anomaly.js`** — potential integration for cross-feature anomaly correlation

**Revert mechanism:** Remove the alert-publishing loop. Alerts still appear in snapshot's `Alerts` array (slightly delayed by up to 1s).

**Priority:** P1 — out-of-band alerts provide <1s latency for critical triage signals.

---

### S09 — Lifecycle Management (Start/Stop/Restart)

**ID:** `C03-S09`
**One-liner:** Aggregator lifecycle is managed by `EdogDevModeRegistrar` and coordinates graceful shutdown with persistence flush.

**Trigger:** `Start()` on registration, `Stop()` on server shutdown, `Restart()` on reconnect/reset.

**Expected behavior:**
1. **Start:** Register topics, restore state, spawn consumers, start timer (see S01).
2. **Stop:** Cancel all consumer tasks via `CancellationTokenSource`, dispose timer, publish final snapshot, flush state to `SessionStore`.
3. **Restart:** `Stop()` then `Start()` — clean re-initialization from persisted state.

**Technical mechanism:**
```csharp
public static void Stop()
{
    if (!_started) return;

    try
    {
        // Signal all consumers to stop
        _cts?.Cancel();

        // Dispose snapshot timer
        _snapshotTimer?.Dispose();
        _snapshotTimer = null;

        // Publish final snapshot before shutdown
        PublishSnapshot();

        // Persist state for next startup
        EdogNexusSessionStore.Persist(_edges);

        Console.WriteLine("[EDOG] Nexus aggregator stopped (state persisted)");
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"[EDOG] Nexus aggregator stop error: {ex.Message}");
    }
    finally
    {
        _cts?.Dispose();
        _cts = null;
        _started = false;
    }
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `Start()`, `Stop()`
- `src/backend/DevMode/EdogDevModeRegistrar.cs:25-53` — registration call site
- `src/backend/DevMode/EdogLogServer.cs:32-58` — server lifecycle pattern

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| `Stop()` called before `Start()` | No-op (checked by `_started` flag). |
| Consumer task hangs on `ReadLiveAsync` | `CancellationToken` fires `OperationCanceledException` — task exits gracefully. |
| `PublishSnapshot()` throws during stop | Caught — persistence still attempted. |
| Persistence fails during stop | Error logged. State lost — aggregator starts clean next time. |
| Process killed (ungraceful) | No final flush. `SessionStore` has last periodic flush (max 5s stale). |
| `Stop()` called twice | Idempotent — second call is no-op after `_started = false`. |

**Interactions:**
- **EdogDevModeRegistrar** — owns lifecycle calls
- **EdogNexusSessionStore** — persistence target on stop
- **EdogLogServer** — server shutdown triggers `Stop()` via disposal chain

**Revert mechanism:** Remove lifecycle calls from `Registrar`. Aggregator never starts.

**Priority:** P0 — clean shutdown is required for persistence correctness.

---

### S10 — Session Persistence Coordination

**ID:** `C03-S10`
**One-liner:** Aggregator coordinates with `EdogNexusSessionStore` for periodic state flush and startup restore.

**Trigger:** Periodic (every 5 seconds during normal operation), on graceful stop, and on startup.

**Expected behavior:**
1. **Periodic flush:** Every 5 seconds, snapshot the `_edges` dictionary and pass to `EdogNexusSessionStore.Persist()`.
2. **Startup restore:** On `Start()`, call `EdogNexusSessionStore.TryRestore()` to hydrate `_edges` from persisted state before consumers begin.
3. **Graceful stop flush:** `Stop()` calls `Persist()` one final time (see S09).
4. Aggregator does NOT own persistence format or file I/O — that is `SessionStore`'s responsibility (separate component C04).

**Technical mechanism:**
```csharp
private static Timer _persistTimer;

// In Start():
_persistTimer = new Timer(
    _ => EdogNexusSessionStore.Persist(_edges),
    state: null,
    dueTime: TimeSpan.FromSeconds(5),
    period: TimeSpan.FromSeconds(5));

// In Stop():
_persistTimer?.Dispose();
EdogNexusSessionStore.Persist(_edges); // final flush
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `_persistTimer` setup
- `src/backend/DevMode/EdogNexusSessionStore.cs` — `Persist()`, `TryRestore()` (sibling component C04)

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| `TryRestore()` fails (corrupt file) | Returns false. Aggregator starts clean. `SessionStore` quarantines bad file. |
| `Persist()` fails (disk full, permission) | Error logged. Next tick retries. Data not lost from memory until process exits. |
| No persisted state on first-ever startup | `TryRestore()` returns false. Normal — aggregator starts with empty `_edges`. |
| Persist called concurrently with snapshot | `ConcurrentDictionary` snapshot is consistent — `foreach` yields a point-in-time view. Individual `EdgeAccumulator` fields may be mid-update but are eventually consistent. |

**Interactions:**
- **EdogNexusSessionStore** (C04) — sole persistence interface
- **EdgeAccumulator** — serialized/deserialized by SessionStore

**Revert mechanism:** Remove `_persistTimer` and all `SessionStore` calls. Aggregator becomes stateless across restarts. Functional but loses history.

**Priority:** P1 — persistence is required for cross-restart triage continuity.

---

### S11 — Backpressure Handling

**ID:** `C03-S11`
**One-liner:** Under sustained high event rates, the aggregator degrades gracefully without blocking source interceptors or crashing.

**Trigger:** Source topic produces events faster than consumer can process, or `nexus` ring buffer fills.

**Expected behavior:**
1. **Source topic backpressure:** `TopicBuffer` uses `DropOldest` semantics (established pattern). If consumer falls behind, oldest events are dropped. Aggregator processes whatever it receives — stats are approximate under overload.
2. **Nexus output backpressure:** `nexus` topic buffer (size 200) uses same `DropOldest`. If frontend can't keep up, oldest snapshots are dropped. Most recent snapshot always available.
3. **CPU backpressure:** If `PublishSnapshot()` takes longer than 1s (pathological edge count), the non-reentrant timer simply delays the next tick. No snapshot overlap.
4. **Memory backpressure:** `MaxSamplesPerWindow` (2000) caps per-edge memory. `_edges` dictionary is bounded by the number of distinct dependencies (practically <20 in FLT).

**Technical mechanism:**
```csharp
// No explicit backpressure code needed — architectural choices provide it:
// 1. TopicBuffer ring buffers: bounded + DropOldest (EdogTopicRouter.cs:28-40)
// 2. BoundedChannelOptions(1000) { FullMode = DropOldest } (EdogPlaygroundHub.cs:70-76)
// 3. Fixed-size circular sample buffers in EdgeAccumulator
// 4. ConcurrentDictionary keys bounded by dependency cardinality (~10-20)
// 5. Timer is non-reentrant (System.Threading.Timer executes on ThreadPool, non-overlapping)

// Warning event when consumer detects gaps:
private static void CheckForDroppedEvents(TopicBuffer buffer, long lastSeqId, long currentSeqId)
{
    long gap = currentSeqId - lastSeqId;
    if (gap > 1)
    {
        Debug.WriteLine($"[EDOG] Nexus: {gap - 1} events dropped (backpressure) on topic");
    }
}
```

**Source code path:**
- `src/backend/DevMode/EdogTopicRouter.cs:28-40` — ring buffer sizes
- `src/backend/DevMode/EdogPlaygroundHub.cs:70-76` — `BoundedChannelOptions` / `DropOldest`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| 10K events/sec burst on `http` topic | Ring buffer (size 2000) drops oldest. Consumer processes ~2000 most recent. Stats are approximate but usable. |
| All 6 consumers fall behind simultaneously | Each drops independently. No cascading failure. Aggregate accuracy degrades proportionally. |
| `nexus` buffer fills (200 snapshots queued) | Oldest snapshots dropped. Frontend always gets most recent on subscribe. |
| Timer callback throws | Caught by `PublishSnapshot()` outer try-catch. Timer continues on next tick. |

**Interactions:**
- **EdogTopicRouter / TopicBuffer** — provides bounded ring buffers and `DropOldest` semantics
- **EdogPlaygroundHub** — downstream consumer uses same backpressure model

**Revert mechanism:** N/A — backpressure is an architectural property, not a toggleable feature.

**Priority:** P0 — backpressure correctness prevents cascading failures under load.

---

### S12 — Correlation ID Tracking

**ID:** `C03-S12`
**One-liner:** Aggregator preserves correlation IDs from source events to enable drill-through from graph edges to raw request evidence.

**Trigger:** `NexusNormalizedEvent` carries a non-null `CorrelationId` extracted from source event.

**Expected behavior:**
1. `EdogNexusClassifier` extracts `correlationId` from HTTP events (from `x-ms-correlation-id` / `x-ms-request-id` headers) and `sessionTrackingId` from Spark events.
2. Aggregator stores most recent N correlation IDs per edge in a bounded FIFO.
3. Snapshot does NOT include raw correlation IDs (payload size concern).
4. Frontend requests drill-through via edge click → backend returns recent correlation IDs for that dependency → frontend navigates to HTTP/Spark tab with pre-filter.

**Technical mechanism:**
```csharp
// In EdgeAccumulator:
private readonly ConcurrentQueue<string> _recentCorrelationIds = new();
private const int MaxCorrelationIds = 50;

public void RecordCorrelationId(string correlationId)
{
    if (string.IsNullOrEmpty(correlationId)) return;

    _recentCorrelationIds.Enqueue(correlationId);

    // Prune to bounded size
    while (_recentCorrelationIds.Count > MaxCorrelationIds)
        _recentCorrelationIds.TryDequeue(out _);
}

// In IngestNormalizedEvent():
if (!string.IsNullOrEmpty(evt.CorrelationId))
    acc.RecordCorrelationId(evt.CorrelationId);
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `EdgeAccumulator.RecordCorrelationId()`
- `src/backend/DevMode/EdogHttpPipelineHandler.cs:53` — `correlationId` extraction
- `src/backend/DevMode/EdogHttpPipelineHandler.cs:171-188` — `ExtractCorrelationId()` helper
- `src/backend/DevMode/EdogSparkSessionInterceptor.cs:52` — `sessionTrackingId` generation

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| No correlation ID on event | `RecordCorrelationId` no-op. |
| >50 correlation IDs | FIFO prune keeps most recent 50. Oldest evicted. |
| Same correlation ID appears on multiple edges | Stored on each edge independently. Expected for cross-dependency request chains. |
| Spark tracking IDs (`edog-spark-N`) | Stored as correlation IDs. Frontend can use these to navigate to Spark Inspector filtered view. |
| Concurrent enqueue/dequeue | `ConcurrentQueue` is thread-safe. Prune loop may briefly exceed bound by 1-2 entries (acceptable). |

**Interactions:**
- **EdogHttpPipelineHandler** — source of HTTP correlation IDs
- **EdogSparkSessionInterceptor** — source of Spark tracking IDs
- **Frontend deep-link system** — consumes correlation IDs for cross-tab navigation
- **EdogNexusSessionStore** — correlation IDs are NOT persisted (ephemeral by design)

**Revert mechanism:** Remove `RecordCorrelationId` calls. Drill-through still works but without pre-filters.

**Priority:** P1 — correlation tracking enables the "one click to evidence" triage flow.

---

### S13 — Window Rotation

**ID:** `C03-S13`
**One-liner:** Every 5 minutes, the aggregator rotates rolling windows — updating baselines and resetting counters for the new window.

**Trigger:** `PublishSnapshot()` detects that `>= 5 minutes` have elapsed since `WindowStart` on any `EdgeAccumulator`.

**Expected behavior:**
1. Check `(now - acc.WindowStart) >= WindowDuration` (5 minutes).
2. If rotation is due:
   a. Compute current window's p50 and error rate.
   b. Update baseline using exponential moving average: `baselineP50 = alpha * currentP50 + (1 - alpha) * baselineP50` where `alpha = 0.3`.
   c. Reset counters: `_totalRequests = 0`, `_errorCount = 0`, `_retryCount = 0`, `_throttleCount = 0`, `_sampleCount = 0`, `_sampleHead = 0`.
   d. Set `WindowStart = now`.
3. Baseline update happens before counter reset (order matters).

**Technical mechanism:**
```csharp
private const int WindowDurationSec = 300; // 5 minutes
private const double BaselineAlpha = 0.3;

private static void MaybeRotateWindow(EdgeAccumulator acc, DateTimeOffset now)
{
    if ((now - acc.WindowStart).TotalSeconds < WindowDurationSec)
        return;

    // Capture current window stats before reset
    var (currentP50, _, _) = ComputePercentiles(acc);
    long total = Interlocked.Read(ref acc._totalRequests);
    long errors = Interlocked.Read(ref acc._errorCount);
    double currentErrorRate = total > 0 ? (double)errors / total : 0;

    // Update baselines (EMA)
    if (acc.BaselineP50Ms == 0)
        acc.BaselineP50Ms = currentP50; // first window: bootstrap
    else
        acc.BaselineP50Ms = BaselineAlpha * currentP50 + (1 - BaselineAlpha) * acc.BaselineP50Ms;

    if (acc.BaselineErrorRate == 0 && currentErrorRate > 0)
        acc.BaselineErrorRate = currentErrorRate;
    else
        acc.BaselineErrorRate = BaselineAlpha * currentErrorRate + (1 - BaselineAlpha) * acc.BaselineErrorRate;

    // Reset counters for new window
    Interlocked.Exchange(ref acc._totalRequests, 0);
    Interlocked.Exchange(ref acc._errorCount, 0);
    Interlocked.Exchange(ref acc._retryCount, 0);
    Interlocked.Exchange(ref acc._throttleCount, 0);
    Interlocked.Exchange(ref acc._sampleCount, 0);
    Interlocked.Exchange(ref acc._sampleHead, 0);

    acc.WindowStart = now;
}
```

**Source code path:**
- `src/backend/DevMode/EdogNexusAggregator.cs` — `MaybeRotateWindow()`

**Edge cases:**

| Condition | Behavior |
|-----------|----------|
| Window rotation during concurrent ingestion | Counter reset via `Interlocked.Exchange` is atomic. In-flight events may land in old or new window — tolerable (±1 event). |
| First window (no baseline) | Baseline bootstrapped from first window's p50. |
| Zero-traffic window (edge went idle) | `currentP50 = 0`, `currentErrorRate = 0`. EMA pulls baseline toward zero over successive idle windows. |
| Clock skew (system time jumps) | `WindowStart` is `DateTimeOffset.UtcNow` — monotonic on all supported platforms. Jump forward triggers immediate rotation; jump backward causes late rotation. Both are safe. |
| Multiple rotations missed (process paused >10 min) | Single rotation fires. Baseline update uses whatever stats accumulated. No multi-rotation catch-up needed. |

**Interactions:**
- **S04** — `ComputePercentiles()` called to capture outgoing window's stats
- **S06** — updated baselines feed next cycle's anomaly detection

**Revert mechanism:** Skip rotation. Counters grow unboundedly within a session. Percentiles remain valid but reflect full session, not rolling window.

**Priority:** P0 — window rotation is what makes the health signal meaningful (recent vs. historical).

---

## 4. Registration Integration

### 4.1 EdogDevModeRegistrar Changes

Add Nexus aggregator start/stop to the existing registration sequence:

```csharp
// In RegisterAll(), after RegisterSparkSessionInterceptor():
RegisterNexusAggregator();

// New method:
private static void RegisterNexusAggregator()
{
    try
    {
        EdogNexusAggregator.Start();
        Console.WriteLine("[EDOG] ✓ Nexus aggregator started");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[EDOG] ✗ Nexus aggregator failed: {ex.Message}");
    }
}
```

**Source code path:**
- `src/backend/DevMode/EdogDevModeRegistrar.cs:43` — after `RegisterSparkSessionInterceptor()`
- `src/backend/DevMode/EdogDevModeRegistrar.cs:170-186` — pattern for new registration methods

### 4.2 EdogTopicRouter Changes

The `nexus` topic is registered by the aggregator itself (not in `Initialize()`), because the aggregator owns the topic lifecycle. However, if pre-registration is preferred for consistency:

```csharp
// In Initialize():
RegisterTopic("nexus", 200);
```

**Source code path:**
- `src/backend/DevMode/EdogTopicRouter.cs:26-40` — `Initialize()` topic list

---

## 5. Thread Safety Analysis

| Shared State | Access Pattern | Safety Mechanism |
|---|---|---|
| `_edges` (`ConcurrentDictionary`) | 6 consumer tasks write, 1 timer reads | `ConcurrentDictionary` is lock-free for reads; `GetOrAdd` may create redundant instances under race (benign). |
| `EdgeAccumulator._latencySamples` | Consumer writes (circular), timer reads (snapshot copy) | Write: `Interlocked.Increment` on head index. Read: copies array segment. Stale read ≤1 sample acceptable. |
| `EdgeAccumulator._totalRequests` etc. | Consumer increments, timer reads | `Interlocked.Increment` / `Interlocked.Read` — lock-free. |
| `EdgeAccumulator.BaselineP50Ms` etc. | Timer writes (rotation), timer reads (snapshot) | Single-writer (timer thread). No contention. |
| `_lastAlertTime` (`ConcurrentDictionary`) | Timer writes, timer reads | Single-writer (timer thread). `ConcurrentDictionary` for future extensibility. |
| `_started` flag | `Start()`/`Stop()` | `volatile` not needed — single-threaded registration. Race between `Start`/`Stop` prevented by sequential Registrar flow. |

**No locks used anywhere.** All hot-path concurrency is via `Interlocked` operations and concurrent collections. Deadlock risk: zero.

---

## 6. Performance Budget

| Operation | Frequency | Cost | Budget |
|---|---|---|---|
| Event ingestion (per consumer) | 10–1000/sec per topic | `Interlocked.Increment` + array write | <1μs per event |
| Percentile computation (per edge) | 1 Hz × ~10 edges | Sort 2000 doubles + rank lookup | ~200μs per edge |
| Snapshot assembly | 1 Hz | Iterate edges, serialize | <5ms total |
| Snapshot publish | 1 Hz | `TopicRouter.Publish` | <100μs |
| Persistence flush | 0.2 Hz | JSON serialize `_edges` | <50ms |

**Total aggregator CPU budget: <10ms per second** — well within the background service envelope.

---

## 7. Dependencies

| Dependency | Type | Status |
|---|---|---|
| `EdogTopicRouter` | Existing | ✓ No changes needed (topic subscription API sufficient) |
| `EdogPlaygroundHub` | Existing | ✓ `SubscribeToTopic("nexus")` works with existing streaming |
| `EdogNexusClassifier` (C02) | New | Required — classification logic |
| `EdogNexusSessionStore` (C04) | New | Required — persistence |
| `EdogNexusModels` (C01) | New | Required — shared DTOs |
| `EdogDevModeRegistrar` | Existing | Minor change — add `Start()`/`Stop()` call |
| `EdogTopicRouter.Initialize()` | Existing | Minor change — optionally pre-register `nexus` topic |

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Test | Validates |
|---|---|
| `ComputePercentiles_EmptySamples_ReturnsZeros` | S04 zero-sample edge case |
| `ComputePercentiles_SingleSample_ReturnsIdentical` | S04 single-sample edge case |
| `ComputePercentiles_KnownDistribution_CorrectRank` | S04 accuracy (pre-sorted known values) |
| `DeriveHealth_ErrorRateThresholds` | S05 boundary testing |
| `DeriveHealth_BaselineDeltaThresholds` | S05 boundary testing |
| `DetectAnomalies_LatencySpike_EmitsWarning` | S06 latency anomaly |
| `DetectAnomalies_ErrorRateDeviation_EmitsCritical` | S06 error rate anomaly |
| `DetectAnomalies_Debounce_SuppressesDuplicate` | S06 debounce |
| `MaybeRotateWindow_BeforeDuration_NoOp` | S13 early rotation check |
| `MaybeRotateWindow_AfterDuration_ResetsCounters` | S13 rotation correctness |
| `MaybeRotateWindow_BaselineEMA_Converges` | S13 EMA calculation |
| `IngestNormalizedEvent_NewDependency_CreatesAccumulator` | S03 first-event path |
| `IngestNormalizedEvent_EnrichmentOnly_NoLatencySample` | S03 retry/cache enrichment |

### 8.2 Integration Tests

| Test | Validates |
|---|---|
| `SyntheticReplay_HttpEvents_ProducesCorrectSnapshot` | End-to-end: publish HTTP events → verify snapshot shape and stats |
| `SyntheticReplay_MultiTopic_CorrelatesEdges` | Cross-topic: HTTP + retry + token events on same dependency |
| `StartStop_PersistsAndRestores` | S09/S10: stop → restart → verify baseline continuity |
| `HighVolumeReplay_NoDeadlock` | S11: 10K events/sec burst → verify no thread starvation |

---

## 9. Open Design Questions (Deferred to Implementation)

1. **Timer implementation:** `System.Threading.Timer` vs `PeriodicTimer` (.NET 6+). Prefer `Timer` for compatibility with existing codebase patterns.
2. **Snapshot serialization format:** Anonymous objects (current pattern) vs typed DTOs. Recommend typed DTOs for `SessionStore` serialization correctness.
3. **Edge pruning for inactive dependencies:** Should edges with zero traffic for >15 minutes be removed from snapshot? Recommend: keep in snapshot with `volume=0` for topology stability; prune only on window rotation.
4. **REST bootstrap endpoint:** Should `/api/nexus/snapshot` serve the latest snapshot for cold-start hydration? Recommend: yes, mirrors existing `/api/stats` pattern.
