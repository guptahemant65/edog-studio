# C05 — Nexus SignalR Integration

> **Feature:** F26 Nexus Dependency Graph
> **Phase:** P1
> **Owner:** Sana (architecture) / Vex (backend) / Pixel (frontend)
> **Status:** SPEC
> **Modifies:** `src/backend/DevMode/EdogTopicRouter.cs`, `src/backend/DevMode/EdogPlaygroundHub.cs`, `src/backend/DevMode/EdogLogServer.cs`, `src/backend/DevMode/EdogDevModeRegistrar.cs`, `src/frontend/js/signalr-manager.js`

---

## 1. Purpose

Wire the `nexus` topic end-to-end through the existing EDOG transport layer so that `EdogNexusAggregator` (C01) can publish snapshot and alert payloads, and `tab-nexus.js` (C03) can consume them via the same snapshot-then-live streaming contract every other topic uses. This component does **not** create new files — it adds the `nexus` topic to the five existing files that form the producer-to-consumer pipeline.

### 1.1 Data flow (existing pattern, new topic)

```
EdogNexusAggregator.PublishSnapshot()
  → EdogTopicRouter.Publish("nexus", payload)
    → TopicBuffer ring (size 500)
      → EdogPlaygroundHub.SubscribeToTopic("nexus")
        → BoundedChannel<TopicEvent>(1000, DropOldest)
          → SignalR ChannelReader stream
            → signalr-manager.js subscribeTopic("nexus")
              → tab-nexus.js listener callback
```

### 1.2 Scope boundary

| In scope | Out of scope |
|----------|-------------|
| Topic registration in `EdogTopicRouter` | Aggregator logic (C01) |
| Channel configuration in `EdogPlaygroundHub` | Classifier logic (C02) |
| REST bootstrap endpoint `/api/nexus` in `EdogLogServer` | Rendering/graph layout (C03) |
| Aggregator startup call in `EdogDevModeRegistrar` | Session store persistence (C04) |
| Frontend subscription plumbing in `signalr-manager.js` | Anomaly detection algorithms |

---

## 2. Message Envelope Format

All messages published to the `nexus` topic are wrapped in the standard `TopicEvent` envelope by `EdogTopicRouter.Publish()` (see `EdogTopicRouter.cs:75-81`). The `Data` field carries one of two payload types distinguished by the `type` discriminator.

### 2.1 Snapshot payload (`type: "snapshot"`)

Published by the aggregator on a 1 Hz heartbeat. Contains the full graph state for the current rolling window.

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
        "from": "flt-local",
        "to": "spark-gts",
        "volume": 186,
        "throughputPerMin": 37.2,
        "p50Ms": 180,
        "p95Ms": 690,
        "p99Ms": 1240,
        "errorRate": 0.07,
        "retryRate": 0.11,
        "health": "degraded",
        "baselineDelta": 3.0
      }
    ],
    "alerts": []
  }
}
```

### 2.2 Alert payload (`type: "alert"`)

Published out-of-band when the anomaly detector fires. Separate from the 1 Hz snapshot cadence to ensure low-latency alert delivery.

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

### 2.3 Serialization

JSON via `System.Text.Json` with `JsonNamingPolicy.CamelCase` — matches the existing `JsonSerializerOptions` in `EdogLogServer.cs:37`. No MessagePack; SignalR is wired with the JSON protocol per `signalr-manager.js:63-64`.

---

## 3. Scenarios

### SC-01 — Topic Registration

**ID:** SC-01
**Name:** Register `nexus` topic buffer in EdogTopicRouter
**Priority:** P0 (blocks all downstream scenarios)

#### Trigger
`EdogTopicRouter.Initialize()` is called during server startup (`EdogLogServer.cs:101`) and during registrar boot (`EdogDevModeRegistrar.cs:33`).

#### Expected behavior
A `nexus` ring buffer with capacity 500 is created and available for `Publish()` / `GetBuffer()` calls.

#### Technical mechanism

**File:** `src/backend/DevMode/EdogTopicRouter.cs`
**Location:** `Initialize()` method, after line 39 (`RegisterTopic("capacity", 500);`)

**Change:** Add one line:

```csharp
RegisterTopic("nexus", 500);
```

**Ring buffer size rationale:** At 1 Hz snapshot cadence + ~10 alerts/min worst case, 500 entries covers ~8 minutes of history. This matches the `capacity` topic (also 500) which has a similar aggregated-summary profile. Raw high-volume topics (`http`, `cache`) use 2000; `nexus` is pre-aggregated and needs less.

#### Edge cases
- **Idempotent:** `RegisterTopic` uses `TryAdd` (`EdogTopicRouter.cs:49`) — safe if `Initialize()` is called multiple times.
- **Order-independent:** no topic depends on another topic's existence.
- **Unknown topic guard:** `EdogPlaygroundHub.SubscribeToTopic` throws `ArgumentException` for unknown topics (`EdogPlaygroundHub.cs:67-68`). Topic must be registered before any frontend subscription attempt.

#### Interactions
- SC-02 (snapshot publishing) depends on this buffer existing.
- SC-04 (frontend subscription) calls `GetBuffer("nexus")` through the hub.

#### Revert mechanism
Remove the `RegisterTopic("nexus", 500);` line. Buffer is never created; any `Publish("nexus", ...)` call silently no-ops (`EdogTopicRouter.cs:73` — `TryGetValue` returns false, publish skips).

---

### SC-02 — Snapshot Publishing

**ID:** SC-02
**Name:** Aggregator publishes snapshot to nexus topic
**Priority:** P0 (blocks frontend data delivery)

#### Trigger
`EdogNexusAggregator` (C01, new file) calls `EdogTopicRouter.Publish("nexus", snapshotPayload)` on its 1 Hz timer tick.

#### Expected behavior
1. `TopicRouter.Publish` wraps the snapshot in a `TopicEvent` with auto-incremented `sequenceId` and UTC timestamp.
2. The event is written to the `nexus` ring buffer.
3. Any active `SubscribeToTopic("nexus")` channel receives the event via `buffer.ReadLiveAsync()`.

#### Technical mechanism

**No changes to `EdogTopicRouter.cs` or `EdogPlaygroundHub.cs`** — the existing `Publish()` and `SubscribeToTopic()` methods are generic and work for any registered topic. The aggregator simply calls:

```csharp
EdogTopicRouter.Publish("nexus", new
{
    type = "snapshot",
    generatedAt = DateTimeOffset.UtcNow,
    windowSec = 300,
    nodes = nodeArray,
    edges = edgeArray,
    alerts = alertArray
});
```

**Source code path:** Publish path at `EdogTopicRouter.cs:69-90`. Buffer write at `TopicBuffer.Write()`. Live delivery at `EdogPlaygroundHub.cs:89`.

#### Edge cases
- **Buffer full:** Ring buffer drops oldest entry (FIFO eviction). At 500 capacity and 1 Hz, ~8 min retained. Under burst conditions (aggregator publishes catch-up snapshots), oldest snapshots evict first — acceptable because frontend only needs the latest.
- **No subscribers:** Events accumulate in ring buffer silently. No error, no backpressure on publisher.
- **Publish during shutdown:** `Publish()` catches all exceptions (`EdogTopicRouter.cs:85-89`). Silent no-op.
- **Anonymous type serialization:** `System.Text.Json` serializes anonymous types into camelCase JSON via the configured `JsonSerializerOptions`. The existing `TopicEvent.Data` field is `object` — no type constraint.

#### Interactions
- Depends on SC-01 (topic must be registered).
- Consumed by SC-04 (frontend subscription) and SC-05 (snapshot + live).

#### Revert mechanism
Remove the `Publish("nexus", ...)` call from the aggregator. Topic buffer remains registered but receives no events.

---

### SC-03 — Alert Publishing

**ID:** SC-03
**Name:** Aggregator publishes anomaly alerts to nexus topic
**Priority:** P1 (triage value, but graph works without alerts)

#### Trigger
`EdogNexusAggregator` anomaly detector identifies a dependency metric exceeding its baseline threshold (e.g., p95 latency 3x above rolling average).

#### Expected behavior
1. Alert payload with `type: "alert"` is published to the `nexus` topic immediately (not batched with the 1 Hz snapshot).
2. Alert arrives at the frontend between snapshots, enabling sub-second anomaly notification.

#### Technical mechanism

Same `EdogTopicRouter.Publish("nexus", ...)` call with a different payload shape:

```csharp
EdogTopicRouter.Publish("nexus", new
{
    type = "alert",
    severity = "warning",         // "info" | "warning" | "critical"
    dependencyId = "spark-gts",
    metric = "p95Ms",
    currentValue = 690.0,
    baselineValue = 230.0,
    delta = 3.0,
    message = "Latency 3.0x above baseline",
    timestamp = DateTimeOffset.UtcNow
});
```

**No file changes required** in transport layer. The `nexus` topic is type-agnostic — `TopicEvent.Data` is `object`.

#### Edge cases
- **Alert storm:** Under cascading failures, multiple dependencies may alert simultaneously. The 500-entry ring buffer and 1000-entry BoundedChannel absorb bursts. Frontend must throttle toast rendering (not this component's responsibility — handled by tab-nexus.js).
- **Duplicate alerts:** Aggregator is responsible for deduplication/cooldown. Transport layer delivers all published events faithfully.
- **Ordering:** Alerts interleave with snapshots in sequence order. Frontend discriminates by `data.type` field.

#### Interactions
- Depends on SC-01 (topic registration).
- Frontend (tab-nexus.js) distinguishes `type: "alert"` from `type: "snapshot"` to trigger toast/pulse.

#### Revert mechanism
Remove alert publish calls from aggregator. Snapshots still flow; graph renders without anomaly overlays.

---

### SC-04 — Frontend Subscription

**ID:** SC-04
**Name:** tab-nexus.js subscribes to nexus topic via SignalR manager
**Priority:** P0 (blocks all frontend rendering)

#### Trigger
User activates the Nexus tab in Runtime View (or Nexus mounts from sidebar navigation). The tab module calls:

```javascript
window.signalR.subscribeTopic('nexus');
```

#### Expected behavior
1. `signalr-manager.js` calls `connection.stream('SubscribeToTopic', 'nexus')` on the hub.
2. Hub creates a `BoundedChannel<TopicEvent>(1000, DropOldest)` and starts the snapshot-then-live pump.
3. Stream subscriber dispatches each `TopicEvent` to registered listeners via the topic event bus.
4. tab-nexus.js receives events and routes by `event.data.type`.

#### Technical mechanism

**File:** `src/frontend/js/signalr-manager.js`
**No code changes required in signalr-manager.js** — the existing `subscribeTopic(topic)` method (line 186) is fully generic. It:
1. Checks `_activeStreams` for existing subscription (line 187).
2. Calls `connection.stream('SubscribeToTopic', topic)` (line 191).
3. Dispatches events to `_listeners` map (lines 193-199).
4. Handles error/complete lifecycle (lines 201-208).

**Consumer pattern in tab-nexus.js** (informational — actual implementation in C03):

```javascript
// In tab-nexus.js activate():
window.signalR.on('nexus', (event) => {
  const payload = event.data;
  if (payload.type === 'snapshot') this._handleSnapshot(payload);
  else if (payload.type === 'alert') this._handleAlert(payload);
});
window.signalR.subscribeTopic('nexus');

// In tab-nexus.js deactivate():
window.signalR.off('nexus', this._handler);
window.signalR.unsubscribeTopic('nexus');
```

**Hub-side path:** `EdogPlaygroundHub.SubscribeToTopic("nexus")` at line 62. `GetBuffer("nexus")` returns the 500-entry ring buffer (SC-01). Channel created at lines 70-76. Snapshot phase at lines 83-86. Live phase at lines 89-91.

#### Edge cases
- **Topic not registered:** `GetBuffer` returns null → hub throws `ArgumentException("Unknown topic: nexus")` → stream `error` callback fires in signalr-manager.js (line 201). Tab should show a connection error state.
- **Double subscription:** `subscribeTopic` checks `_activeStreams.has(topic)` (line 187) and returns early. Safe.
- **Tab switch rapid-fire:** `unsubscribeTopic` calls `stream.dispose()` (line 218) which fires `OperationCanceledException` in the hub pump (line 94), completing the channel cleanly.

#### Interactions
- Depends on SC-01 (topic registration) and hub being connected.
- Provides data to tab-nexus.js (C03).
- SC-05 (snapshot + live) describes the two-phase delivery this subscription receives.

#### Revert mechanism
Remove `subscribeTopic('nexus')` / `on('nexus', ...)` calls from tab-nexus.js. SignalR manager and hub unchanged.

---

### SC-05 — Snapshot + Live Stream Delivery

**ID:** SC-05
**Name:** Buffered history then live stream for nexus topic
**Priority:** P0 (core streaming contract)

#### Trigger
`SubscribeToTopic("nexus")` is invoked (SC-04). The hub pump begins the two-phase delivery.

#### Expected behavior

**Phase 1 — Snapshot (history):**
1. `buffer.GetSnapshot()` returns all events currently in the 500-entry ring buffer, ordered by `sequenceId`.
2. Each `TopicEvent` is written to the `BoundedChannel` and streamed to the client.
3. Frontend receives a burst of historical snapshots + alerts, allowing cold-start hydration.

**Phase 2 — Live:**
1. `buffer.ReadLiveAsync(cancellationToken)` yields new events as the aggregator publishes them.
2. Events arrive at ~1 Hz (snapshots) plus out-of-band alerts.
3. Stream continues until the client disposes the subscription or disconnects.

#### Technical mechanism

**File:** `src/backend/DevMode/EdogPlaygroundHub.cs`
**No code changes required** — the existing `SubscribeToTopic` method (lines 62-106) implements this two-phase contract generically for all topics. The `nexus` topic benefits from it identically to `http`, `spark`, etc.

**BoundedChannel configuration** (lines 70-76):
```csharp
Channel.CreateBounded<TopicEvent>(new BoundedChannelOptions(1000)
{
    FullMode = BoundedChannelFullMode.DropOldest,
    SingleReader = true,
    SingleWriter = false
});
```

- **Capacity 1000:** Per-client channel buffer. At 1 Hz snapshots, this holds ~16 min of events if the client stalls. Adequate headroom.
- **DropOldest:** If client can't keep up, oldest events evict. Frontend tolerates this because each snapshot contains full graph state (not deltas).
- **SingleReader:** One consumer (the SignalR stream to this specific client).
- **SingleWriter:** False — the background pump is the only writer, but `false` is the safe default used across all topics.

#### Edge cases
- **Empty buffer on first connect:** If Nexus tab is opened before aggregator has published any snapshots, Phase 1 yields zero events. Phase 2 blocks on `ReadLiveAsync` until the first snapshot arrives. Frontend should show an empty/loading state.
- **Large snapshot burst:** If the ring buffer is full (500 entries), Phase 1 streams all 500 into the channel. The channel (capacity 1000) absorbs this without dropping. Client receives them in sequence order.
- **Client slow consumer:** Channel drops oldest events. Since snapshots are full state (not incremental), dropping old snapshots is safe — the latest snapshot is always sufficient for rendering.
- **Cancellation during Phase 1:** `OperationCanceledException` caught at line 94, channel completes cleanly.

#### Interactions
- Depends on SC-01 (topic buffer), SC-02/SC-03 (publishers populating the buffer).
- Consumed by SC-04 (frontend subscription callback).
- SC-07 (reconnect) re-enters this flow on reconnection.

#### Revert mechanism
N/A — no changes to hub code. Removing topic registration (SC-01 revert) prevents `GetBuffer` from returning a buffer, which throws `ArgumentException` before channel creation.

---

### SC-06 — Bootstrap REST Endpoint

**ID:** SC-06
**Name:** Optional `/api/nexus` REST endpoint for cold-start bootstrap
**Priority:** P2 (nice-to-have; streaming snapshot covers most cases)

#### Trigger
Frontend calls `GET /api/nexus` during initial page load, before the SignalR connection is established. Matches the pattern used by `/api/logs`, `/api/telemetry`, `/api/stats`, and `/api/executions` (see `EdogLogServer.cs:253-388`).

#### Expected behavior
1. Returns the latest snapshot from the `nexus` ring buffer as JSON.
2. Enables the frontend to render a graph frame immediately, before the SignalR stream connects and Phase 1 snapshot replay occurs.
3. Query parameters: `?limit=N` (default 1 — return only the most recent snapshot).

#### Technical mechanism

**File:** `src/backend/DevMode/EdogLogServer.cs`
**Location:** `ConfigureRoutes()` method, after the `/api/executions` block (after line 388), before the FLT API proxy routes (line 391).

**Change:** Add a new route handler:

```csharp
// Nexus API endpoint — latest graph snapshot for cold-start bootstrap
app.MapGet("/api/nexus", async context =>
{
    try
    {
        var limit = ParseInt(context.Request.Query["limit"], 1);
        var buffer = EdogTopicRouter.GetBuffer("nexus");
        if (buffer == null)
        {
            context.Response.StatusCode = 404;
            await context.Response.WriteAsync("{\"error\":\"nexus topic not registered\"}");
            return;
        }

        var snapshot = buffer.GetSnapshot()
            .Where(e => e.Data is not null)
            .OrderByDescending(e => e.SequenceId)
            .Take(limit)
            .Reverse()
            .ToArray();

        var json = JsonSerializer.Serialize(snapshot, JsonOptions);
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(json);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[EDOG] Error serving nexus API: {ex.Message}");
        context.Response.StatusCode = 500;
    }
});
```

**Requires:** `using System.Linq;` (already imported at `EdogLogServer.cs:14`).

#### Edge cases
- **No snapshots yet:** Returns empty array `[]`. Frontend shows loading/empty state.
- **Topic not registered:** Returns 404 with descriptive error JSON. Frontend falls back to waiting for SignalR stream.
- **Large limit:** `GetSnapshot()` returns at most `ringBufferSize` (500) entries. `Take(limit)` bounds further.
- **Concurrent access:** `TopicBuffer.GetSnapshot()` returns a point-in-time copy (ring buffers are designed for concurrent read/write). Safe without locking.

#### Interactions
- Depends on SC-01 (topic registration).
- Consumed by `main.js` bootstrap sequence (informational — actual wiring in C03).
- Complements SC-05 (streaming); provides immediate data while SignalR connects.

#### Revert mechanism
Remove the `app.MapGet("/api/nexus", ...)` block. Frontend falls back to SignalR-only delivery (SC-05 Phase 1 snapshot replay covers the same data, just slightly later).

---

### SC-07 — Reconnect Behavior

**ID:** SC-07
**Name:** Re-subscribe to nexus topic after SignalR reconnect
**Priority:** P0 (reliability)

#### Trigger
SignalR connection drops and auto-reconnects (network blip, server restart). The `onreconnected` handler fires in `signalr-manager.js` (line 87).

#### Expected behavior
1. `_resubscribeAll()` is called (line 89).
2. All active topic streams (including `nexus`) are torn down and re-established.
3. New `SubscribeToTopic("nexus")` call delivers Phase 1 snapshot (full ring buffer), then resumes live stream.
4. Frontend receives a full graph state on reconnect — no incremental delta needed.

#### Technical mechanism

**File:** `src/frontend/js/signalr-manager.js`
**No code changes required** — the existing `_resubscribeAll()` method (lines 147-158) handles this generically:

```javascript
_resubscribeAll = () => {
    // ...
    // Re-stream active topic streams (Phase 3 event bus)
    const activeTopics = [...this._activeStreams.keys()];
    this._activeStreams.clear();
    for (const topic of activeTopics) {
        this.subscribeTopic(topic);   // re-creates stream
    }
}
```

This clears the `_activeStreams` map and re-calls `subscribeTopic` for each topic that was previously streaming. The `nexus` topic, if active, is automatically re-subscribed.

#### Edge cases
- **Rapid reconnect cycling:** Each reconnect tears down old streams (via `_activeStreams.clear()`) before creating new ones. No resource leak.
- **Reconnect during Phase 1 replay:** Old stream's `complete` callback fires (line 205). New stream starts fresh with full snapshot. No duplicate delivery concern at the application level — snapshots are idempotent full-state replacements.
- **Server restart:** Ring buffer is empty after restart (in-memory only, pre-persistence). Phase 1 yields zero events. Frontend shows empty graph until aggregator publishes the first snapshot. (Persistence is addressed by C04 SessionStore.)
- **Reconnect with tab-nexus inactive:** If the user navigated away from Nexus tab, `unsubscribeTopic` was called, removing it from `_activeStreams`. `_resubscribeAll` correctly does not re-subscribe inactive topics.

#### Interactions
- Depends on SC-01 (topic registration on server side) and SC-04 (original subscription).
- SC-05 Phase 1 provides the rehydration mechanism.
- C04 (SessionStore) will later ensure the ring buffer survives server restarts.

#### Revert mechanism
N/A — no changes to signalr-manager.js. Reconnect behavior is inherent to the existing infrastructure.

---

### SC-08 — Channel Configuration Validation

**ID:** SC-08
**Name:** Validate BoundedChannel parameters for nexus topic throughput
**Priority:** P1 (performance correctness)

#### Trigger
`SubscribeToTopic("nexus")` creates a `BoundedChannel<TopicEvent>` per connected client (SC-05).

#### Expected behavior
The existing channel configuration in `EdogPlaygroundHub.cs:70-76` is adequate for the `nexus` topic's throughput profile:

| Parameter | Value | Rationale for nexus |
|-----------|-------|---------------------|
| Capacity | 1000 | 1 Hz snapshots + ~10 alerts/min = ~70 events/min. 1000 = ~14 min buffer. Adequate. |
| FullMode | DropOldest | Snapshots are full-state; dropping oldest is safe (latest snapshot suffices). |
| SingleReader | true | One SignalR stream consumer per channel. Correct. |
| SingleWriter | false | Background pump is sole writer. `false` is safe default. |

#### Technical mechanism

**File:** `src/backend/DevMode/EdogPlaygroundHub.cs`
**No code changes required.** The existing configuration applies uniformly to all topics. No per-topic channel tuning is needed because:

1. The `nexus` topic is low-frequency (1 Hz) compared to `http` (potentially hundreds/sec).
2. Full-state snapshots tolerate `DropOldest` gracefully — unlike incremental-delta protocols where dropping events causes state corruption.
3. The 1000-entry channel absorbs the Phase 1 snapshot burst (up to 500 ring buffer entries) plus live events without backpressure.

#### Edge cases
- **Multiple concurrent clients:** Each `SubscribeToTopic` call creates an independent channel. 10 concurrent browser tabs = 10 channels, each with 1000 capacity. Memory: ~10 * 1000 * ~2KB per event = ~20MB. Acceptable for DevMode.
- **Client never reads:** Channel fills, oldest events drop. No upstream backpressure on the ring buffer or publisher. Publish path remains non-blocking.

#### Interactions
- SC-05 (streaming delivery) relies on these channel semantics.
- Future optimization: if nexus snapshots grow large (many edges), consider reducing channel capacity or adding per-topic overrides. Not needed for V1.

#### Revert mechanism
N/A — no changes to existing code.

---

### SC-09 — Aggregator Startup Registration

**ID:** SC-09
**Name:** Start EdogNexusAggregator from DevMode registrar
**Priority:** P0 (blocks aggregator from running)

#### Trigger
`EdogDevModeRegistrar.RegisterAll()` is called during FLT startup (`EdogDevModeRegistrar.cs:25`).

#### Expected behavior
1. The Nexus aggregator is instantiated and started after all interceptors are registered (so it can subscribe to their topics).
2. Registration follows the existing idempotent, non-fatal pattern.
3. Failure to start the aggregator does not block FLT service startup.

#### Technical mechanism

**File:** `src/backend/DevMode/EdogDevModeRegistrar.cs`
**Location:** Inside `RegisterAll()`, after `RegisterDiRegistryCapture()` call (after line 192), before the success log (line 46).

**Change:** Add aggregator startup:

```csharp
RegisterNexusAggregator();
```

And add the private method (matching the existing pattern from `RegisterRetryInterceptor` etc.):

```csharp
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

**Convention match:** Follows the exact try/catch/log pattern used by `RegisterRetryInterceptor()` (lines 150-159), `RegisterCacheInterceptor()` (lines 163-168), and `RegisterDiRegistryCapture()` (lines 188-198). Static `Start()` method convention matches `EdogRetryInterceptor.Start()` (line 154).

#### Edge cases
- **Aggregator Start() throws:** Caught by try/catch. Log message emitted. All other interceptors already registered. FLT continues normally without Nexus.
- **Called before topic registration:** `RegisterAll()` calls `EdogTopicRouter.Initialize()` at line 33 — before any interceptor registration. All topics (including `nexus` from SC-01) are registered before the aggregator starts. Safe.
- **Idempotent:** `RegisterAll()` is guarded by `_registered` flag (line 27). Aggregator's `Start()` should also be idempotent (aggregator responsibility, not transport layer).

#### Interactions
- Depends on SC-01 (topic registration, which happens at line 33 of `RegisterAll()`).
- Aggregator (C01) publishes to topic (SC-02, SC-03).
- All interceptors are registered before aggregator starts, ensuring source topics are populated.

#### Revert mechanism
Remove the `RegisterNexusAggregator()` call and method. No aggregator starts; `nexus` topic remains registered but empty.

---

### SC-10 — Hub Topic Comment Update

**ID:** SC-10
**Name:** Update EdogPlaygroundHub XML doc to include nexus topic
**Priority:** P2 (documentation hygiene)

#### Trigger
N/A — documentation-only change, applied when SC-01 lands.

#### Expected behavior
The hub class summary lists all available topics, including `nexus`.

#### Technical mechanism

**File:** `src/backend/DevMode/EdogPlaygroundHub.cs`
**Location:** Class-level XML doc comment, line 21.

**Current:**
```csharp
/// Topics: log, telemetry, fileop, spark, token, cache, http, retry, flag, di, perf.
```

**New:**
```csharp
/// Topics: log, telemetry, fileop, spark, token, cache, http, retry, flag, di, perf, nexus.
```

#### Edge cases
None — documentation-only change.

#### Interactions
None.

#### Revert mechanism
Remove `, nexus` from the comment.

---

## 4. File Change Summary

| File | Change type | Scenarios | Lines affected |
|------|-------------|-----------|----------------|
| `src/backend/DevMode/EdogTopicRouter.cs` | Add 1 line | SC-01 | After line 39 |
| `src/backend/DevMode/EdogPlaygroundHub.cs` | Update comment | SC-10 | Line 21 |
| `src/backend/DevMode/EdogLogServer.cs` | Add REST endpoint | SC-06 | After line 388 (ConfigureRoutes) |
| `src/backend/DevMode/EdogDevModeRegistrar.cs` | Add method + call | SC-09 | After line 192 + new private method |
| `src/frontend/js/signalr-manager.js` | No changes | SC-04, SC-07 | N/A (existing generic code) |

**Key insight:** 6 of 10 scenarios require **zero code changes** to transport files. The existing generic topic architecture (`TopicRouter` + `PlaygroundHub` + `SignalRManager`) handles the `nexus` topic without modification once it's registered. This validates the original topic bus design (ADR-006).

---

## 5. Dependency Graph

```
SC-01 (topic registration)
  ├─→ SC-02 (snapshot publish)
  ├─→ SC-03 (alert publish)
  ├─→ SC-04 (frontend subscription) ──→ SC-05 (snapshot + live)
  ├─→ SC-06 (REST bootstrap)
  ├─→ SC-08 (channel validation)
  └─→ SC-09 (aggregator startup)
                                         SC-07 (reconnect) ←── SC-04 + SC-05
                                         SC-10 (doc update) ←── SC-01
```

All scenarios depend on SC-01. SC-05 and SC-07 are emergent behaviors of the existing infrastructure; no new code needed.

---

## 6. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Ring buffer too small (500) for snapshot history | Low | 500 at 1 Hz = ~8 min. If insufficient, increase to 1000 in one-line change. |
| Alert storm fills ring buffer displacing snapshots | Medium | Aggregator should implement cooldown (C01 responsibility). Transport delivers faithfully. |
| REST endpoint returns stale snapshot | Low | Frontend also gets fresh data via SignalR stream. REST is a cold-start optimization, not source of truth. |
| JSON serialization overhead for large snapshots | Low | Pre-aggregated data; 10-20 nodes and edges serializes in <1ms. Not on hot path. |
| Concurrent `Publish` from snapshot timer + alert detector | None | `TopicBuffer.Write()` is thread-safe. `ConcurrentDictionary` lookup is lock-free. |

---

## 7. Testing Checklist

| Test | Type | Validates |
|------|------|-----------|
| `GetBuffer("nexus")` returns non-null after `Initialize()` | Unit | SC-01 |
| `Publish("nexus", payload)` writes to buffer | Unit | SC-02 |
| `SubscribeToTopic("nexus")` returns ChannelReader | Integration | SC-04, SC-05 |
| Phase 1 snapshot contains ring buffer contents in order | Integration | SC-05 |
| Phase 2 live events arrive after snapshot replay | Integration | SC-05 |
| `GET /api/nexus` returns latest snapshot as JSON | Integration | SC-06 |
| `GET /api/nexus?limit=5` returns bounded results | Integration | SC-06 |
| `GET /api/nexus` returns 404 if topic unregistered | Integration | SC-06 |
| Reconnect re-subscribes to nexus stream | E2E | SC-07 |
| Aggregator starts after topic registration in `RegisterAll` | Integration | SC-09 |
