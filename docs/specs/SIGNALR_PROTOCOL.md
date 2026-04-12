# EDOG Playground — SignalR Real-Time Protocol Specification

> **Status:** ACTIVE — v2 (Streaming Architecture)
> **Authority:** ADR-006 (SignalR, CEO decision 2026-04-09)
> **Last Updated:** 2026-04-12
> **Applies To:** EdogLogServer.cs, EdogPlaygroundHub.cs, SignalRManager.js, all interceptors
> **Protocol:** JSON over SignalR with `ChannelReader<T>` streaming + snapshot hydration

---

## Overview

All real-time data in EDOG Playground flows through a single SignalR hub at `/hub/playground` on the FLT process (port 5557). The architecture uses **SignalR server-to-client streaming** (`ChannelReader<T>`) — the modern 2025 pattern that unifies snapshot hydration and live event streaming into a single atomic stream per topic. No REST fallback needed. No gap between history and live. Built-in backpressure.

**Protocol:** JSON (SignalR default). MessagePack upgrade deferred (FLT NuGet version conflict — see ADR-006 addendum).

---

## Architecture: Streaming with Snapshot Hydration

### The Pattern

When a client activates a tab (e.g., Tokens), it calls a **streaming hub method** that returns a `ChannelReader<T>`. The server:

1. **Yields the snapshot first** — all buffered events from the ring buffer (history)
2. **Then yields live events** — as interceptors produce them in real-time
3. **Backpressure is automatic** — bounded channel drops oldest if consumer can't keep up
4. **Cancellation is native** — client disconnects cleanly cancel the stream via CancellationToken

```
Client subscribes          Server responds
───────────────           ──────────────────
stream("SubscribeTo-      ┌─ Snapshot (buffered) ─┐
  Topic", "token")  ───►  │ event 1 (historical)   │
                          │ event 2 (historical)   │
                          │ event N (historical)   │
                          ├─ Live (real-time) ─────┤
                          │ event N+1 (new)        │
                          │ event N+2 (new)        │
                          │ ...continues forever   │
                          └────────────────────────┘
```

### Why This Is Better Than REST + Groups

| Aspect | Old (REST + Group Broadcast) | New (ChannelReader Stream) |
|--------|------------------------------|---------------------------|
| Connections | 2 (HTTP fetch + SignalR group) | 1 (SignalR stream) |
| Gap between snapshot and live | Events during fetch are lost | Zero gap — atomic handoff |
| Backpressure | None (fire-and-forget broadcast) | Built-in (bounded channel, drop-oldest) |
| Ordering | REST unordered, stream unordered | Single stream, always ordered |
| Cancellation | Manual cleanup | Native CancellationToken |
| Code complexity | Fetch + merge + deduplicate | One `stream()` call |
| Sequence tracking | None | Monotonic `sequenceId` per event |

---

## Connection Lifecycle

```
Browser (JS)                              FLT Process (C#)
─────────────                              ─────────────────
SignalRManager.connect()
  │
  ├──► POST /hub/playground/negotiate ──► EdogPlaygroundHub
  │    (CORS: Origin 127.0.0.1:5555)      (Kestrel on :5557)
  │
  ├──► WS /hub/playground?id=xxx ──────► OnConnectedAsync()
  │
  │    User clicks Tokens tab:
  ├──► stream("SubscribeToTopic",  ────► SubscribeToTopic("token", ct)
  │          "token")                      │
  │                                        ├─► yield snapshot[0..N]
  │◄─── event, event, event... ◄───────── ├─► yield live events
  │                                        │   (from topic Channel<T>)
  │    User switches to Logs tab:          │
  ├──► cancel stream (dispose) ──────────► CancellationToken fires
  │                                        └─► stream ends cleanly
  │
  ├──► stream("SubscribeToTopic",  ────► SubscribeToTopic("log", ct)
  │          "log")                        └─► same pattern
  │
  │    Reconnect (auto):
  ├──► .withAutomaticReconnect() ──────► OnConnectedAsync()
  │                                        (client re-streams active topic)
```

---

## Topics and Events

### 11 Topics

| Topic | SignalR Stream Method | C# Interceptor | Buffer Size | Tab |
|-------|----------------------|----------------|-------------|-----|
| `log` | `SubscribeToTopic("log")` | EdogLogInterceptor (existing) | 10,000 | Logs |
| `telemetry` | `SubscribeToTopic("telemetry")` | EdogTelemetryInterceptor (existing) | 5,000 | Telemetry |
| `fileop` | `SubscribeToTopic("fileop")` | EdogFileSystemInterceptor | 2,000 | System Files |
| `spark` | `SubscribeToTopic("spark")` | EdogSparkSessionInterceptor | 200 | Spark Sessions |
| `token` | `SubscribeToTopic("token")` | EdogTokenInterceptor | 500 | Tokens |
| `cache` | `SubscribeToTopic("cache")` | EdogCacheInterceptor | 2,000 | Caches |
| `http` | `SubscribeToTopic("http")` | EdogHttpPipelineHandler | 2,000 | HTTP Pipeline |
| `retry` | `SubscribeToTopic("retry")` | EdogRetryInterceptor | 500 | Retries |
| `flag` | `SubscribeToTopic("flag")` | EdogFeatureFlighterWrapper | 1,000 | Feature Flags |
| `di` | `SubscribeToTopic("di")` | EdogDiRegistryCapture | 100 | DI Registry |
| `perf` | `SubscribeToTopic("perf")` | EdogPerfMarkerCallback | 5,000 | Perf Markers |

**Total server memory budget:** ~50MB max across all buffers (average event ~1KB × 28,300 events)

---

## C# Hub Implementation

### EdogPlaygroundHub.cs

```csharp
public sealed class EdogPlaygroundHub : Hub
{
    /// <summary>
    /// Client streams a topic: receives snapshot (history) then live events.
    /// Called when user activates a tab. Cancelled when user leaves tab.
    /// </summary>
    public ChannelReader<TopicEvent> SubscribeToTopic(
        string topic,
        CancellationToken cancellationToken)
    {
        var buffer = EdogTopicRouter.GetBuffer(topic);
        if (buffer == null)
            throw new ArgumentException($"Unknown topic: {topic}");

        var channel = Channel.CreateBounded<TopicEvent>(
            new BoundedChannelOptions(1000)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });

        _ = Task.Run(async () =>
        {
            try
            {
                // Phase 1: Yield snapshot (buffered history)
                foreach (var item in buffer.GetSnapshot())
                {
                    await channel.Writer.WriteAsync(item, cancellationToken);
                }

                // Phase 2: Yield live events as they arrive
                await foreach (var item in buffer.ReadLiveAsync(cancellationToken))
                {
                    await channel.Writer.WriteAsync(item, cancellationToken);
                }
            }
            catch (OperationCanceledException) { /* Client disconnected — clean */ }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"EDOG stream error: {ex.Message}");
            }
            finally
            {
                channel.Writer.Complete();
            }
        }, cancellationToken);

        return channel.Reader;
    }
}
```

### EdogTopicRouter.cs (New)

Central registry of all topic buffers. Interceptors write here. Hub reads from here.

```csharp
public static class EdogTopicRouter
{
    private static readonly ConcurrentDictionary<string, TopicBuffer> _buffers = new();

    public static void RegisterTopic(string topic, int maxSize)
    {
        _buffers.TryAdd(topic.ToLowerInvariant(),
            new TopicBuffer(maxSize));
    }

    public static TopicBuffer GetBuffer(string topic)
    {
        _buffers.TryGetValue(topic.ToLowerInvariant(), out var buffer);
        return buffer;
    }

    /// <summary>
    /// Called by interceptors to publish an event. Thread-safe.
    /// </summary>
    public static void Publish(string topic, object eventData)
    {
        if (_buffers.TryGetValue(topic.ToLowerInvariant(), out var buffer))
        {
            buffer.Write(new TopicEvent
            {
                SequenceId = buffer.NextSequenceId(),
                Timestamp = DateTime.UtcNow,
                Topic = topic,
                Data = eventData
            });
        }
    }
}
```

### TopicBuffer.cs (New)

Ring buffer per topic with snapshot + live stream support.

```csharp
public sealed class TopicBuffer
{
    private readonly int _maxSize;
    private readonly ConcurrentQueue<TopicEvent> _ring = new();
    private readonly Channel<TopicEvent> _liveChannel;
    private long _sequenceCounter;

    public TopicBuffer(int maxSize)
    {
        _maxSize = maxSize;
        _liveChannel = Channel.CreateUnbounded<TopicEvent>(
            new UnboundedChannelOptions { SingleWriter = false });
    }

    public long NextSequenceId() => Interlocked.Increment(ref _sequenceCounter);

    /// <summary>
    /// Called by interceptors. Thread-safe. Writes to both ring buffer and live channel.
    /// </summary>
    public void Write(TopicEvent evt)
    {
        // Ring buffer for snapshot
        _ring.Enqueue(evt);
        while (_ring.Count > _maxSize) _ring.TryDequeue(out _);

        // Live channel for active streams (non-blocking)
        _liveChannel.Writer.TryWrite(evt);
    }

    /// <summary>
    /// Returns current ring buffer contents (for snapshot hydration).
    /// </summary>
    public IReadOnlyList<TopicEvent> GetSnapshot()
    {
        return _ring.ToArray();
    }

    /// <summary>
    /// Async enumerable of live events (for streaming after snapshot).
    /// </summary>
    public IAsyncEnumerable<TopicEvent> ReadLiveAsync(CancellationToken ct)
    {
        return _liveChannel.Reader.ReadAllAsync(ct);
    }
}
```

---

## Event Envelope

Every event across all topics uses the same envelope:

```json
{
  "sequenceId": 4215,
  "timestamp": "2026-04-12T10:42:31.847Z",
  "topic": "token",
  "data": {
    // topic-specific payload (see Event Data Shapes below)
  }
}
```

**`sequenceId`** — monotonic per topic. Client can detect gaps (missed events from drop-oldest).

---

## Event Data Shapes (per topic)

### `log` — LogEntry

```json
{
  "level": "Warning",
  "message": "Retry attempt 2/3 for OneLake write",
  "component": "RetryPolicyProvider",
  "rootActivityId": "abc-def-123",
  "eventId": "evt-456",
  "iterationId": "iter-789",
  "codeMarkerName": "OneLakeWrite",
  "customData": { "key": "value" }
}
```

### `telemetry` — TelemetryEvent

```json
{
  "activityName": "RunDAG",
  "activityStatus": "Succeeded",
  "durationMs": 12400,
  "resultCode": "200",
  "correlationId": "corr-abc",
  "iterationId": "iter-789",
  "attributes": { "nodeCount": "7" },
  "userId": "hemant@microsoft.com"
}
```

### `flag` — FlagEvalEvent

```json
{
  "flagName": "FLTDagExecutionHandlerV2",
  "tenantId": "72f988bf-...",
  "capacityId": "19524206-...",
  "workspaceId": "1b20c810-...",
  "result": true,
  "durationMs": 0.3
}
```

### `perf` — PerfMarkerEvent

```json
{
  "operationName": "Workload.LiveTable.Controllers.PublicUnprotected.PingApi",
  "durationMs": 8.2,
  "result": "Success",
  "dimensions": { "namespace": "LiveTableServiceMonitoring", "operationType": "PublicApi" },
  "correlationId": "abc-def-123"
}
```

### `token` — TokenEvent

```json
{
  "tokenType": "Bearer",
  "scheme": "Bearer",
  "audience": "api.fabric.microsoft.com",
  "expiryUtc": "2026-04-12T11:42:31Z",
  "issuedUtc": "2026-04-12T10:42:31Z",
  "httpClientName": "FabricApiClient",
  "endpoint": "/v1/workspaces"
}
```

**Security:** Raw token values are NEVER sent. Only metadata (type, audience, expiry). JWT claims (oid, tid, roles) are sent but NOT the signature or raw token string.

### `fileop` — FileOpEvent

```json
{
  "operation": "Write",
  "path": "DagExecutionMetrics/iteration-abc123/status.json",
  "contentSizeBytes": 4200,
  "durationMs": 45.2,
  "hasContent": true,
  "contentPreview": "{\"status\":\"Running\",...}",
  "ttlSeconds": 300,
  "iterationId": "iter-789"
}
```

**Size limit:** `contentPreview` truncated to first 4KB. Full content available via on-demand hub method `GetFileContent(sequenceId)`.

### `http` — HttpRequestEvent

```json
{
  "method": "POST",
  "url": "https://gts-endpoint/sessions/execute",
  "statusCode": 429,
  "durationMs": 20,
  "requestHeaders": { "Content-Type": "application/json", "x-ms-correlation-id": "abc" },
  "responseHeaders": { "Retry-After": "12" },
  "responseBodyPreview": "{\"error\":\"TooManyRequests\"}",
  "httpClientName": "OneLakeRestClient",
  "correlationId": "abc-def-123"
}
```

**Security:** `Authorization` header value is REDACTED (replaced with `[redacted]`). SAS tokens in URLs are stripped. Response body truncated to 4KB.

### `retry` — RetryEvent

```json
{
  "endpoint": "https://onelake/dag.json",
  "statusCode": 429,
  "retryAttempt": 2,
  "totalAttempts": 3,
  "waitDurationMs": 20000,
  "strategyName": "StandardRetryStrategy",
  "reason": "HTTP 429 Too Many Requests",
  "isThrottle": true,
  "retryAfterMs": 12000,
  "iterationId": "iter-789"
}
```

### `cache` — CacheEvent

```json
{
  "cacheName": "SqlEndpointMetadataCache",
  "operation": "GetOrResolve",
  "key": "1b20c810:artifact-456",
  "hitOrMiss": "Hit",
  "valueSizeBytes": 1240,
  "ttlSeconds": 300,
  "durationMs": 0.1,
  "evictionReason": null
}
```

### `spark` — SparkSessionEvent

```json
{
  "sessionTrackingId": "edog-spark-001",
  "event": "Created",
  "tenantId": "72f988bf-...",
  "workspaceId": "1b20c810-...",
  "artifactId": "artifact-456",
  "iterationId": "iter-789",
  "workspaceName": "EDOG-Dev-Workspace",
  "artifactName": "TestLH-01",
  "tokenType": "MwcV1"
}
```

### `di` — DiRegistrationEvent

```json
{
  "serviceType": "IFeatureFlighter",
  "implementationType": "EdogFeatureFlighterWrapper",
  "lifetime": "Singleton",
  "isEdogIntercepted": true,
  "originalImplementation": "FeatureFlighter",
  "registrationPhase": "RunAsync"
}
```

---

## C# Interceptor Pattern

Every interceptor follows this exact pattern:

```csharp
public TResult InterceptedMethod(TArgs args)
{
    var stopwatch = Stopwatch.StartNew();

    // 1. ALWAYS call the original first — interceptor is transparent
    var result = _inner.OriginalMethod(args);

    stopwatch.Stop();

    // 2. Snapshot immutable payload SYNCHRONOUSLY (before args get disposed)
    var eventData = new { /* copy all needed fields NOW */ };

    // 3. Publish to topic buffer (non-blocking, thread-safe)
    EdogTopicRouter.Publish("topicname", eventData);

    // 4. Return original result UNMODIFIED
    return result;
}
```

Key rules:
1. **Always call original first** — interceptor is transparent
2. **Snapshot data synchronously** — HTTP streams, tokens may be disposed later
3. **Publish via EdogTopicRouter** — non-blocking `TryWrite` to channel, never awaits
4. **Return original unmodified** — we observe, never mutate
5. **No try/catch needed around Publish** — TopicRouter handles errors internally

---

## JS Client Pattern

### SignalRManager.js

```javascript
class SignalRManager {
    constructor() {
        this._listeners = new Map();  // topic → Set<callback>
        this._activeStreams = new Map(); // topic → IStreamResult
    }

    // Topic event bus — multiple listeners per topic
    on(topic, callback) {
        if (!this._listeners.has(topic)) this._listeners.set(topic, new Set());
        this._listeners.get(topic).add(callback);
    }

    off(topic, callback) {
        const set = this._listeners.get(topic);
        if (set) set.delete(callback);
    }

    // Start streaming a topic (snapshot + live)
    subscribeTopic(topic) {
        if (this._activeStreams.has(topic)) return; // already streaming

        const stream = this.connection.stream("SubscribeToTopic", topic);
        this._activeStreams.set(topic, stream);

        stream.subscribe({
            next: (event) => {
                const listeners = this._listeners.get(topic);
                if (listeners) listeners.forEach(cb => cb(event));
            },
            error: (err) => console.error(`Stream error [${topic}]:`, err),
            complete: () => this._activeStreams.delete(topic)
        });
    }

    // Stop streaming a topic
    unsubscribeTopic(topic) {
        const stream = this._activeStreams.get(topic);
        if (stream) {
            stream.dispose();  // cancels the CancellationToken on server
            this._activeStreams.delete(topic);
        }
    }
}
```

### Per-Tab Module Pattern

```javascript
class TokensTab {
    constructor(signalr) {
        this._signalr = signalr;
        this._events = [];
    }

    activate() {
        this._signalr.on('token', this._onEvent);
        this._signalr.subscribeTopic('token');
        // Snapshot + live events arrive through same _onEvent callback
    }

    deactivate() {
        this._signalr.unsubscribeTopic('token');
        this._signalr.off('token', this._onEvent);
    }

    _onEvent = (event) => {
        this._events.push(event.data);
        this._render();
    }
}
```

---

## Security & Redaction

| Field | Rule |
|-------|------|
| **Authorization header** | ALWAYS redacted: `"Authorization": "[redacted]"` |
| **Raw JWT token string** | NEVER sent. Only metadata (type, audience, expiry, selected claims) |
| **JWT claims** | Sent: oid, tid, aud, iss, exp, iat, roles, scp. NOT sent: raw signature |
| **SAS tokens in URLs** | Stripped: `?sig=xxx&se=xxx` removed from URL strings |
| **File content** | Truncated to 4KB preview. Full content via on-demand hub method |
| **HTTP response body** | Truncated to 4KB preview |
| **Cache values** | Truncated to 4KB preview. Size in bytes always included |
| **Passwords/secrets** | Any field matching `password|secret|key|connectionstring` pattern → redacted |

---

## Backpressure & Ordering

### Server Side

Each `TopicBuffer` has:
- **Ring buffer** (bounded, topic-specific size) — stores snapshot history
- **Live channel** (unbounded writer, bounded reader in hub stream) — for real-time

The `ChannelReader` in `SubscribeToTopic` uses `BoundedChannelOptions(1000)` with `DropOldest`. If the browser can't keep up:
- Oldest events are dropped from the channel
- A `sequenceId` gap tells the client events were missed

### Client Side

Client detects gaps via `sequenceId`:
```javascript
if (event.sequenceId > this._lastSequenceId + 1) {
    const dropped = event.sequenceId - this._lastSequenceId - 1;
    this._showDroppedBanner(`${dropped} events dropped — high volume`);
}
this._lastSequenceId = event.sequenceId;
```

### Ordering Guarantee

Events within a single topic stream are **strictly ordered** (single ChannelWriter per topic, single ChannelReader per client stream). Cross-topic ordering is NOT guaranteed (each topic is independent).

---

## Reconnection Behavior

1. SignalR auto-reconnects: `[0, 1000, 2000, 5000, 10000, 30000]` ms backoff
2. On reconnect, `SignalRManager` re-streams the active topic(s)
3. Re-stream includes a fresh snapshot — no events are missed
4. `sequenceId` resets are detected by the client (new stream = new sequence space)

---

## Performance Budget

| Metric | Target |
|--------|--------|
| Interceptor overhead per call (sync path) | < 1ms |
| TopicRouter.Publish (enqueue to channel) | < 0.01ms (TryWrite) |
| Server memory (all buffers) | < 50MB |
| SignalR stream latency (server → browser) | < 50ms |
| JS event handler per message | < 2ms |
| Max events/sec sustained (across all topics) | 2,000 |
| Max active streams per client | 2 (current tab + background log) |

---

## Audit Findings Incorporated

These findings from the rubber-duck audit are addressed in this spec:

| Finding | Status |
|---------|--------|
| No history/snapshot model | ✅ Solved: ChannelReader stream yields snapshot first |
| No batching/backpressure | ✅ Solved: bounded channel + DropOldest + sequenceId gaps |
| Task.Run per event breaks ordering | ✅ Solved: synchronous Publish to TopicRouter, single channel per stream |
| No ordering guarantees | ✅ Solved: monotonic sequenceId, single-writer per topic |
| Large payload handling undefined | ✅ Solved: 4KB truncation + on-demand full content |
| Security/redaction missing | ✅ Solved: redaction rules per field type |
| Frontend only supports 2 events | ⚠️ Phase 3: topic event bus + 9 new handlers |
| ADR-006 says MessagePack | ⚠️ ADR needs addendum (JSON for now) |
| Event shapes are examples not contracts | ✅ Solved: defined per topic with required fields |
| Protocol versioning missing | ⚠️ Deferred to V2 (single-process localhost, no version drift risk) |

---

*"One stream per topic. Snapshot first, then live. Bounded, ordered, backpressured. The plumbing matches the faucets."*
