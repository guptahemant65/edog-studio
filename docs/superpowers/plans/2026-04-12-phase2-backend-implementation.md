# Phase 2 Backend — Palantir-Grade Implementation Plan

> **Classification:** IMPLEMENTATION SPEC — every line is actionable
> **Owner:** Vex (Backend) + Sana (Architecture)
> **Depends on:** Phase 1 SignalR ✅ complete
> **Mandate:** Zero bugs. Zero hardcoding. Future-proof auto-detection.

---

## The Big Picture: How Data Flows

```
FLT SERVICE PROCESS (port 5557)
═══════════════════════════════════════════════════════════════════════

  ┌─ FLT Runtime Code ──────────────────────────────────────────────┐
  │                                                                  │
  │  IFeatureFlighter.IsEnabled("FLTDagV2", tenant, cap, ws)        │
  │       │                                                          │
  │       ▼                                                          │
  │  ┌─ EdogFeatureFlighterWrapper ──────────────────────────┐      │
  │  │  1. Call original: result = _inner.IsEnabled(...)     │      │
  │  │  2. Snapshot data synchronously:                      │      │
  │  │     eventData = { flagName, tenant, result, duration } │      │
  │  │  3. Publish: EdogTopicRouter.Publish("flag", data)    │      │
  │  │  4. Return original result unmodified                 │      │
  │  └───────────────────────────────┬───────────────────────┘      │
  │                                   │                              │
  │  (same pattern × 9 interceptors)  │                              │
  └───────────────────────────────────┼──────────────────────────────┘
                                      │
                                      ▼
  ┌─ EdogTopicRouter (static, thread-safe) ─────────────────────────┐
  │                                                                  │
  │  Publish("flag", eventData)                                      │
  │       │                                                          │
  │       ▼                                                          │
  │  TopicBuffer["flag"]                                             │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │  Ring Buffer (max 1000)     │  Live Channel (unbounded)  │   │
  │  │  [event1, event2, ... eventN] → Channel.Writer.TryWrite()│   │
  │  │  (snapshot for new clients) │  (real-time for streams)   │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                  │
  │  (11 buffers: log, telemetry, fileop, spark, token,              │
  │   cache, http, retry, flag, di, perf)                            │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
  ┌─ SignalR Hub: EdogPlaygroundHub ─────────────────────────────────┐
  │                                                                  │
  │  Client calls: connection.stream("SubscribeToTopic", "flag")    │
  │       │                                                          │
  │       ▼                                                          │
  │  SubscribeToTopic("flag", cancellationToken)                     │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │  Returns: ChannelReader<TopicEvent>                      │   │
  │  │                                                          │   │
  │  │  Phase 1: yield snapshot[0..N] from ring buffer          │   │
  │  │  Phase 2: yield live events from Channel.Reader          │   │
  │  │                                                          │   │
  │  │  Bounded output channel (1000, DropOldest)               │   │
  │  │  CancellationToken cancels when client disconnects       │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                  │
  │  Hub endpoint: /hub/playground (Kestrel, CORS: localhost only)   │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │
                                     │ SignalR WebSocket (JSON protocol)
                                     │ ws://localhost:5557/hub/playground
                                     │
═════════════════════════════════════╪═══════════════════════════════════

BROWSER (served from dev-server port 5555)                           
                                     │
                                     ▼
  ┌─ SignalRManager.js ──────────────────────────────────────────────┐
  │                                                                  │
  │  // User clicks Feature Flags tab                                │
  │  const stream = connection.stream("SubscribeToTopic", "flag");  │
  │  stream.subscribe({                                              │
  │    next: (event) => {                                            │
  │      // event.sequenceId = 42                                    │
  │      // event.timestamp = "2026-04-12T10:42:31Z"                 │
  │      // event.topic = "flag"                                     │
  │      // event.data = { flagName, result, ... }                   │
  │      listeners.get("flag").forEach(cb => cb(event));             │
  │    }                                                             │
  │  });                                                             │
  │                                                                  │
  │  // User leaves tab → stream.dispose() → server cancels          │
  └──────────────────────────────────────────────────────────────────┘
```

---

## What We're Building (Exact File List)

### New C# Files (all in `src/backend/DevMode/`)

| # | File | Purpose | Lines ~est |
|---|------|---------|-----------|
| 1 | `TopicEvent.cs` | Universal event envelope (sequenceId, timestamp, topic, data) | 20 |
| 2 | `TopicBuffer.cs` | Per-topic ring buffer + live Channel for streaming | 60 |
| 3 | `EdogTopicRouter.cs` | Static registry of all 11 topic buffers, Publish() method | 70 |
| 4 | `EdogDevModeRegistrar.cs` | Single entry point, registers all 9 interceptors | 80 |
| 5 | `EdogFeatureFlighterWrapper.cs` | Wraps `IFeatureFlighter.IsEnabled()` | 50 |
| 6 | `EdogPerfMarkerCallback.cs` | Replaces `IServiceMonitoringCallback` | 60 |
| 7 | `EdogTokenInterceptor.cs` | `DelegatingHandler` capturing auth headers on all HttpClients | 80 |
| 8 | `EdogFileSystemInterceptor.cs` | Wraps `IFileSystemFactory` → decorates all `IFileSystem` instances | 120 |
| 9 | `EdogHttpPipelineHandler.cs` | `DelegatingHandler` capturing request/response on all HttpClients | 100 |
| 10 | `EdogRetryInterceptor.cs` | Wraps `RetryPolicyProviderV2` | 80 |
| 11 | `EdogCacheInterceptor.cs` | Wraps `ISqlEndpointMetadataCache` | 70 |
| 12 | `EdogSparkSessionInterceptor.cs` | Wraps `ISparkClientFactory` | 80 |
| 13 | `EdogDiRegistryCapture.cs` | Enumerates WireUp registrations at startup | 60 |

### Modified Files

| File | What Changes |
|------|-------------|
| `EdogPlaygroundHub.cs` | Add `SubscribeToTopic()` ChannelReader streaming method |
| `EdogLogServer.cs` | Add `EdogTopicRouter.Initialize()` in Start(). Migrate AddLog/AddTelemetry to TopicRouter. Fix CORS to localhost-only. |
| `edog.py` | Add 13 new files to DEVMODE_FILES. Add `RegisterAll()` to WorkloadApp.cs patch. Update revert. |

---

## SignalR Is The Transport — Here's Exactly How

### Current State (Phase 1)

```
Interceptor → EdogLogServer.AddLog(entry)
                  → hubContext.Clients.Group("log").SendAsync("LogEntry", entry)
                      → JS connection.on("LogEntry", handler)

Problems:
- No history (miss events before subscription)
- No backpressure (fire-and-forget SendAsync)
- No ordering guarantee (Task.Run per event)
- Only works for 2 topics (log, telemetry)
```

### New State (Phase 2)

```
Interceptor → EdogTopicRouter.Publish("flag", data)
                  → TopicBuffer.Write(event)
                      → Ring buffer (history for snapshots)
                      → Channel.Writer.TryWrite(event) (live stream)

Client subscribes → Hub.SubscribeToTopic("flag")
                      → returns ChannelReader<TopicEvent>
                          → Phase 1: yield ring buffer snapshot
                          → Phase 2: yield from Channel.Reader (live)
                      → JS connection.stream("SubscribeToTopic", "flag")
                          → stream.subscribe({ next: handler })

Fixes:
✅ History: snapshot hydrated on subscribe (ring buffer contents)
✅ Backpressure: bounded ChannelReader (1000, DropOldest)
✅ Ordering: monotonic sequenceId per topic
✅ Works for all 11 topics
✅ Zero gap between snapshot and live (atomic handoff)
```

### The Key SignalR API Used

**Server (C#):** `ChannelReader<T>` — SignalR streaming method. Returns a channel the client reads from. Server pushes to channel writer. Client receives items as they're written. CancellationToken fires when client disconnects.

```csharp
// Hub method signature — SignalR recognizes ChannelReader<T> return type as streaming
public ChannelReader<TopicEvent> SubscribeToTopic(string topic, CancellationToken ct)
```

**Client (JS):** `connection.stream()` — creates a streaming subscription. Returns an `IStreamResult` with `subscribe()`.

```javascript
// JS client starts streaming — receives snapshot then live events
const stream = connection.stream("SubscribeToTopic", "flag");
stream.subscribe({ next: (event) => { /* handle */ }, complete: () => {}, error: () => {} });

// To stop streaming (user leaves tab):
stream.dispose();  // sends cancellation to server
```

**This is native SignalR streaming API** — not a custom protocol on top of SignalR. It's the same mechanism Azure DevOps and VS Live Share use.

---

## Execution Order (15 Tasks)

### Phase A: Core Infrastructure (Tasks 1-4, sequential)

These MUST be done first — everything else depends on them.

```
Task 1: TopicEvent.cs + TopicBuffer.cs + EdogTopicRouter.cs
         ↓
Task 2: Upgrade EdogPlaygroundHub → ChannelReader streaming
         ↓
Task 3: Migrate existing log+telemetry to TopicRouter
         ↓
Task 4: EdogDevModeRegistrar.cs (orchestrator with stub methods)
```

**After Task 3:** Verify via agent-browser that existing logs still stream. This is the regression gate. If logs break here, we fix before proceeding.

### Phase B: Interceptors (Tasks 5-13, parallel)

All independent. Each wraps one FLT interface. Can dispatch 9 Opus agents simultaneously.

```
Task 5:  EdogFeatureFlighterWrapper   (IFeatureFlighter)
Task 6:  EdogPerfMarkerCallback       (IServiceMonitoringCallback)
Task 7:  EdogTokenInterceptor         (DelegatingHandler)
Task 8:  EdogFileSystemInterceptor    (IFileSystemFactory)
Task 9:  EdogHttpPipelineHandler      (DelegatingHandler)
Task 10: EdogRetryInterceptor         (RetryPolicyProviderV2)
Task 11: EdogCacheInterceptor         (ISqlEndpointMetadataCache)
Task 12: EdogSparkSessionInterceptor  (ISparkClientFactory)
Task 13: EdogDiRegistryCapture        (WireUp enumeration)
```

### Phase C: Wiring + Verification (Tasks 14-15, sequential)

```
Task 14: edog.py patching
          - Add 13 files to DEVMODE_FILES
          - Add RegisterAll() to WorkloadApp.cs patch
          - Fix CORS to localhost-only
          - Update revert
         ↓
Task 15: Integration test
          - make build + make test
          - Deploy to FLT
          - agent-browser: verify all topics stream data
```

---

## Per-Interceptor Spec (Tasks 5-13)

### Every Interceptor Follows This Exact Pattern

```csharp
// STEP 1: Call original (interceptor is transparent)
var result = _inner.OriginalMethod(args);

// STEP 2: Snapshot data SYNCHRONOUSLY (objects may be disposed later)
var eventData = new {
    flagName = featureName,     // copy all needed fields NOW
    result = originalResult,     // not references — values
    durationMs = sw.Elapsed.TotalMilliseconds
};

// STEP 3: Publish to TopicRouter (non-blocking, thread-safe)
EdogTopicRouter.Publish("flag", eventData);

// STEP 4: Return original result UNMODIFIED
return result;
```

**Rules:**
- Original FIRST, broadcast SECOND — never change call order
- Snapshot SYNCHRONOUSLY — HTTP streams, tokens, file content may be disposed after return
- Publish is non-blocking — `Channel.Writer.TryWrite()` returns immediately
- No try/catch needed around Publish — TopicRouter handles errors internally
- Use `DateTimeOffset.UtcNow` (never `DateTime.Now`)
- Idempotency: `if (WireUp.Resolve<IFeatureFlighter>() is EdogFeatureFlighterWrapper) return;`

### Task 5: EdogFeatureFlighterWrapper

```
WRAPS:    IFeatureFlighter (single method: IsEnabled)
FLT FILE: FeatureFlightProvider/IFeatureFlighter.cs
DI LINE:  WorkloadApp.cs:110 — WireUp.RegisterSingletonType<IFeatureFlighter, FeatureFlighter>()
TOPIC:    "flag"
EVENT:    { flagName, tenantId, capacityId, workspaceId, result: bool, durationMs }
```

### Task 6: EdogPerfMarkerCallback

```
WRAPS:    IServiceMonitoringCallback (called by every CodeMarker scope completion)
FLT FILE: Monitoring/MonitoredCodeMarkerBase.cs → resolves IServiceMonitoringCallback
DI LINE:  WorkloadApp.cs:99 — WireUp.RegisterSingletonType<IServiceMonitoringCallback, LiveTableServiceMonitoringCallback>()
TOPIC:    "perf"
EVENT:    { operationName, durationMs, result, dimensions, correlationId }
PATTERN:  Replace callback, chain to original for telemetry continuity
```

### Task 7: EdogTokenInterceptor

```
WRAPS:    IHttpClientFactory (wraps the factory returned by HttpClientFactoryRegistry)
FLT FILE: HttpClients/HttpClientFactoryRegistry.cs
DI LINE:  WorkloadApp.cs:147 — WireUp.RegisterInstance(HttpClientFactoryRegistry.CreateHttpClientFactoryWithNamedClients())
TOPIC:    "token"
EVENT:    { tokenType, scheme, audience, expiryUtc, httpClientName, endpoint }
PATTERN:  Wrap IHttpClientFactory → all 6 named HttpClients auto-get our DelegatingHandler
SECURITY: NEVER send raw token string. Extract metadata from JWT header only. Redact Authorization header value.
AUTO-DETECT: New named HttpClients added to the factory are automatically intercepted.
```

### Task 8: EdogFileSystemInterceptor

```
WRAPS:    IFileSystemFactory (wraps factory → all IFileSystem instances get decorator)
FLT FILE: Persistence/Fs/IFileSystem.cs (13 async methods)
DI LINE:  WorkloadApp.cs:139 — WireUp.RegisterSingletonType<IFileSystemFactory, OnelakeFileSystemFactory>()
TOPIC:    "fileop"
EVENT:    { operation, path, contentSizeBytes, durationMs, hasContent, contentPreview (4KB max), ttlSeconds }
PATTERN:  Factory decorator — wrap every IFileSystem instance created through factory
AUTO-DETECT: New IFileSystem usage through factory is auto-captured.
```

### Task 9: EdogHttpPipelineHandler

```
WRAPS:    Same IHttpClientFactory as Task 7 (shared wrapper — adds second DelegatingHandler)
TOPIC:    "http"
EVENT:    { method, url, statusCode, durationMs, requestHeaders, responseHeaders, responseBodyPreview (4KB max), httpClientName, correlationId }
PATTERN:  DelegatingHandler.SendAsync() override — captures full request/response cycle
SECURITY: Redact Authorization header. Strip SAS tokens from URLs. Truncate bodies to 4KB.
NOTE:     Tasks 7 and 9 share the same IHttpClientFactory wrapper. Two handlers in the chain.
```

### Task 10: EdogRetryInterceptor

```
WRAPS:    RetryPolicyProviderV2 (creates RetryExecutor instances)
FLT FILE: RetryPolicy/V2/Framework/RetryExecutor.cs
DI LINE:  WorkloadApp.cs:134 — WireUp.RegisterSingletonType<RetryPolicyProviderV2>()
TOPIC:    "retry"
EVENT:    { endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs, strategyName, reason, isThrottle, retryAfterMs }
PATTERN:  Wrap provider → track all retry executor usage
AUTO-DETECT: New retry strategies registered through provider are auto-captured.
```

### Task 11: EdogCacheInterceptor

```
WRAPS:    ISqlEndpointMetadataCache (primary cache — GetOrResolveAsync + Evict)
FLT FILE: SqlEndpoint/SqlEndpointMetadataCache.cs
DI LINE:  WorkloadApp.cs:118 — WireUp.RegisterSingletonType<ISqlEndpointMetadataCache, SqlEndpointMetadataCache>()
TOPIC:    "cache"
EVENT:    { cacheName, operation (Get/Set/Evict), key, hitOrMiss, valueSizeBytes, ttlSeconds, durationMs }
NOTE:     FLT has 2 real caches (SqlEndpointMetadata + TokenBucketRateLimiter), not 10. Mock needs updating.
```

### Task 12: EdogSparkSessionInterceptor

```
WRAPS:    ISparkClientFactory (CreateSparkClientAsync)
FLT FILE: SparkHttp/ISparkClientFactory.cs + GTSBasedSparkClient.cs
DI LINE:  WorkloadApp.cs:126 — WireUp.RegisterSingletonType<ISparkClientFactory, GTSBasedSparkClientFactory>()
TOPIC:    "spark"
EVENT:    { sessionTrackingId (generated), event (Created/Active/Disposed/Error), tenantId, workspaceId, artifactId, iterationId, tokenType }
NOTE:     FLT has no Spark session ID — we generate our own tracking ID per factory call. No cell-level hooks — map DAG nodes to "cells" in frontend.
AUTO-DETECT: All Spark clients created through factory are auto-captured.
```

### Task 13: EdogDiRegistryCapture

```
WRAPS:    Nothing — reads WireUp registrations after all DI setup completes
FLT FILE: WorkloadApp.cs (30+ registrations in constructor + RunAsync)
TOPIC:    "di"
EVENT:    { serviceType, implementationType, lifetime, isEdogIntercepted, originalImplementation, registrationPhase }
PATTERN:  Called at end of RegisterAll() — enumerates known registrations from WorkloadApp.cs patterns. Also captures our own wrapper registrations.
NOTE:     WireUp is proprietary — no runtime enumeration API. We build the registry from our knowledge of what we wrapped + static knowledge of WorkloadApp patterns.
```

---

## edog.py Patching (Task 14)

### What Gets Patched in the FLT Repo

```
workload-fabriclivetable/
├── Service/Microsoft.LiveTable.Service/
│   ├── DevMode/                           ← 21 files copied here (8 existing + 13 new)
│   │   ├── EdogLogServer.cs               (existing, updated)
│   │   ├── EdogPlaygroundHub.cs           (existing, updated)
│   │   ├── EdogApiProxy.cs               (existing)
│   │   ├── EdogLogModels.cs              (existing)
│   │   ├── EdogLogInterceptor.cs         (existing)
│   │   ├── EdogTelemetryInterceptor.cs   (existing)
│   │   ├── TopicEvent.cs                  ← NEW
│   │   ├── TopicBuffer.cs                 ← NEW
│   │   ├── EdogTopicRouter.cs             ← NEW
│   │   ├── EdogDevModeRegistrar.cs        ← NEW
│   │   ├── EdogFeatureFlighterWrapper.cs  ← NEW
│   │   ├── EdogPerfMarkerCallback.cs      ← NEW
│   │   ├── EdogTokenInterceptor.cs        ← NEW
│   │   ├── EdogFileSystemInterceptor.cs   ← NEW
│   │   ├── EdogHttpPipelineHandler.cs     ← NEW
│   │   ├── EdogRetryInterceptor.cs        ← NEW
│   │   ├── EdogCacheInterceptor.cs        ← NEW
│   │   ├── EdogSparkSessionInterceptor.cs ← NEW
│   │   ├── EdogDiRegistryCapture.cs       ← NEW
│   │   ├── edog-logs.html                (existing)
│   │   └── .editorconfig                 (existing)
│   │
│   ├── WorkloadApp.cs                     ← PATCHED (add RegisterAll() call)
│   └── Microsoft.LiveTable.Service.csproj ← PATCHED (SignalR NuGet — already done)
│
├── Service/Microsoft.LiveTable.Service.EntryPoint/
│   └── Program.cs                         ← PATCHED (existing — EdogLogServer.Start())
```

### WorkloadApp.cs Patch — RegisterAll() Insertion

Current patch replaces telemetry reporter line. NEW: add RegisterAll() after it.

```python
# In edog.py apply_log_viewer_registration_workloadapp_cs():
replacement = (
    "// EDOG DevMode - Wrap telemetry reporter with web log viewer interceptor\n"
    "            WireUp.RegisterInstance<ICustomLiveTableTelemetryReporter>(\n"
    "                new Microsoft.LiveTable.Service.DevMode.EdogTelemetryInterceptor(\n"
    "                    new CustomLiveTableTelemetryReporter(),\n"
    "                    WireUp.Resolve<Microsoft.LiveTable.Service.DevMode.EdogLogServer>()));\n"
    "\n"
    "            // EDOG DevMode - Re-set Tracer test logger after platform init\n"
    "            Microsoft.ServicePlatform.Telemetry.Tracer.SetStructuredTestLogger(\n"
    "                new Microsoft.LiveTable.Service.DevMode.EdogLogInterceptor(\n"
    "                    WireUp.Resolve<Microsoft.LiveTable.Service.DevMode.EdogLogServer>()));\n"
    "\n"
    "            // EDOG DevMode - Register all runtime interceptors (Phase 2)\n"   # ← NEW
    "            Microsoft.LiveTable.Service.DevMode.EdogDevModeRegistrar.RegisterAll();\n"  # ← NEW
)
```

**Anchor:** This replaces the SAME line as before (`WireUp.RegisterSingletonType<ICustomLiveTableTelemetryReporter, ...>()`). We control the full replacement text. RegisterAll() goes at the end.

**Revert:** Remove the entire EDOG block including the RegisterAll() line. Restore original telemetry reporter line.

---

## Safety Rules (Non-Negotiable)

### 1. Interceptor Safety

```
RULE: Interceptor failures NEVER propagate to FLT.
HOW:  TopicRouter.Publish() wraps in try/catch internally.
      Interceptors call original FIRST, publish SECOND.
      If Publish fails, original result still returned.
```

### 2. Thread Safety

```
RULE: All interceptors must be safe for concurrent calls.
HOW:  TopicBuffer uses ConcurrentQueue + Channel (both thread-safe).
      TopicRouter.Publish() is stateless — just enqueue.
      Interceptors snapshot data synchronously — no shared mutable state.
      sequenceId uses Interlocked.Increment (atomic).
```

### 3. Memory Budget

```
RULE: Total buffer memory < 50MB.
HOW:  Per-topic sizes defined in EdogTopicRouter:
      log=10K, telemetry=5K, fileop=2K, spark=200, token=500,
      cache=2K, http=2K, retry=500, flag=1K, di=100, perf=5K
      Average event ~1KB → 28,300 events × 1KB ≈ 28MB typical.
      Large events (http bodies, file content) capped at 4KB preview.
```

### 4. Idempotency

```
RULE: RegisterAll() is safe to call multiple times (redeploy).
HOW:  Static bool _registered flag. Check before wrapping.
      Each interceptor checks: if (resolved is EdogWrapper) skip.
      Prevents Wrapper(Wrapper(Original)) stacking.
```

### 5. Security

```
RULE: Never send raw tokens, passwords, or full PII.
HOW:  Authorization header → "[redacted]"
      Raw JWT → never sent (only metadata: type, audience, expiry)
      SAS tokens in URLs → stripped
      File content → 4KB preview max
      HTTP bodies → 4KB preview max
      userId → truncated
```

### 6. DateTime

```
RULE: All timestamps use DateTimeOffset.UtcNow (never DateTime.Now).
WHY:  DateTime.Now serializes without timezone → JS parses as local time.
      DateTimeOffset always includes timezone → always correct.
```

### 7. CORS

```
RULE: Only accept origins from localhost / 127.0.0.1.
HOW:  Replace SetIsOriginAllowed(_ => true) with explicit check.
WHY:  Any website could read SignalR data (token claims, file contents)
      if CORS is wildcard. Localhost-only eliminates this.
```

---

## Verification Checklist (Task 15)

```
□ python scripts/build-html.py — HTML < 800KB
□ python -m pytest tests/ -v — all tests pass
□ edog --revert (clean FLT repo)
□ Deploy from browser (Workspace Explorer → Deploy to Lakehouse)
□ Build succeeds (all 21 DevMode files compile with FLT)
□ Service starts (port 5557)
□ agent-browser: open http://127.0.0.1:5555
□ agent-browser: press 2 (Runtime View)
□ agent-browser: Logs tab shows streaming entries (TopicRouter path)
□ agent-browser: check console — no JS errors
□ For each interceptor: verify data appears in FLT console output
  □ Feature flags: "[EDOG] flag: FLTDagV2 = true"
  □ Perf markers: "[EDOG] perf: PingApi 8ms"
  □ Token events: "[EDOG] token: Bearer api.fabric"
  □ File ops: "[EDOG] fileop: Write dag.json 4KB"
  □ HTTP requests: "[EDOG] http: POST /gts/sessions 200 1240ms"
  □ Retries: "[EDOG] retry: 429 attempt 2/3"
  □ Cache events: "[EDOG] cache: GetOrResolve HIT"
  □ Spark sessions: "[EDOG] spark: Created edog-spark-001"
  □ DI registry: "[EDOG] di: 30 registrations captured"
```

---

## Execution Strategy

```
PHASE A (sequential, ~30 min):
  Task 1  → Task 2 → Task 3 → Task 4
  Core infra → Hub upgrade → Migrate existing → Registrar

  ══ GATE: agent-browser verify logs still stream ══

PHASE B (parallel, ~20 min):
  Tasks 5-13 → 9 Opus agents, one per interceptor

  ══ GATE: all 13 new .cs files compile standalone ══

PHASE C (sequential, ~15 min):
  Task 14 → Task 15
  edog.py patching → Deploy + Integration test

  ══ GATE: full verification checklist ══

TOTAL: ~1 hour
```

---

*"Every byte has a path. Every event has a sequence. Every interceptor has a safety net. Every topic has a buffer. One hub. One stream. Zero bugs."*
