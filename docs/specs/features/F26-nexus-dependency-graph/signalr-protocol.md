# F26 Nexus — P2 SignalR Protocol / API Specification

> **Feature:** F26 — Nexus Real-Time Cross-Workload Dependency Graph
> **Priority:** P2
> **Author:** Vex (backend agent)
> **Status:** SPEC
> **Audience:** Any engineer implementing backend publisher or frontend consumer for the `nexus` topic

---

## §0 Transport Foundation

Before defining Nexus-specific messages, this section establishes the transport primitives that Nexus inherits from the existing EDOG infrastructure. **Every pattern described here is verified against source.**

### 0.1 SignalR Configuration

| Property | Value | Evidence |
|----------|-------|----------|
| Hub endpoint | `/hub/playground` | `EdogLogServer.cs:229` — `app.MapHub<EdogPlaygroundHub>("/hub/playground")` |
| Protocol | JSON (System.Text.Json) | `EdogLogServer.cs:78` — `AddSignalR()` with no `.AddMessagePackProtocol()` |
| JSON naming | camelCase | `EdogLogServer.cs:37` — `JsonNamingPolicy.CamelCase` |
| Auto-reconnect schedule | `[0, 1000, 2000, 5000, 10000, 30000]` ms | `signalr-manager.js:60` |
| Hub class | `EdogPlaygroundHub` | `EdogPlaygroundHub.cs:22` |

### 0.2 TopicEvent Envelope

All messages on all topics — including `nexus` — are wrapped in the `TopicEvent` envelope by `EdogTopicRouter.Publish()` (`EdogTopicRouter.cs:75-81`). This is not a Nexus design decision; it is inherited infrastructure.

**C# type** (`TopicEvent.cs:17-30`):
```csharp
public sealed class TopicEvent
{
    public long SequenceId { get; set; }        // monotonic per topic
    public DateTimeOffset Timestamp { get; set; } // UTC publish time
    public string Topic { get; set; }           // "nexus"
    public object Data { get; set; }            // NexusSnapshot or alert object
}
```

**Wire format** (JSON, camelCase):
```json
{
  "sequenceId": «long»,
  "timestamp": "«ISO 8601 UTC»",
  "topic": "nexus",
  "data": { /* payload — see §1 */ }
}
```

**Key properties:**
- `sequenceId` is monotonic **per topic** — gaps indicate dropped events (`TopicBuffer.cs:41`)
- `timestamp` is when `EdogTopicRouter.Publish()` was called, **not** when the aggregator computed the snapshot
- `data` carries the topic-specific payload — the frontend discriminates payload type via `data.type`

### 0.3 TopicBuffer Ring

The `nexus` topic is backed by a `TopicBuffer` with ring size **500** (`EdogTopicRouter.cs` — new registration). At 1 Hz snapshot cadence + occasional alerts, this provides ~8 minutes of history for snapshot hydration on subscribe/reconnect.

| Parameter | Value | Source |
|-----------|-------|--------|
| Ring size | 500 | Matches `capacity` topic (`EdogTopicRouter.cs:39`) |
| Eviction | FIFO (oldest dequeued) | `TopicBuffer.cs:52` |
| Live channel | Unbounded, non-blocking | `TopicBuffer.cs:34-35` |
| Sequence counter | Atomic `Interlocked.Increment` | `TopicBuffer.cs:41` |

---

## §1 SignalR Topic Stream

### 1.1 Topic Name

```
nexus
```

Registered in `EdogTopicRouter.Initialize()` alongside the existing 12 topics:

```csharp
RegisterTopic("nexus", 500);   // after RegisterTopic("capacity", 500)
```

### 1.2 Message Types

The `nexus` topic carries two message types, distinguished by the `type` discriminator field within `data`:

| Type | Direction | Frequency | Purpose |
|------|-----------|-----------|---------|
| `snapshot` | Backend → Frontend | 1 Hz (heartbeat) | Complete graph state replacement |
| `alert` | Backend → Frontend | On-anomaly (0–10/min typical) | Out-of-band anomaly notification |

Both are published via the same `EdogTopicRouter.Publish("nexus", payload)` call. The `TopicEvent` envelope is identical; only the `data` shape differs.

### 1.3 Snapshot Message (`type: "snapshot"`)

Published by `EdogNexusAggregator` on a 1 Hz timer. Contains the **complete** graph state for the current rolling window. The frontend performs a full state replacement on each snapshot — **not** incremental deltas.

#### JSON Schema

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
      {
        "id": "flt-local",
        "kind": "core",
        "volume": 0
      },
      {
        "id": "spark-gts",
        "kind": "dependency",
        "volume": 186
      }
    ],
    "edges": [
      {
        "from": "flt-local",
        "to": "spark-gts",
        "volume": 186,
        "throughputPerMin": 37.2,
        "p50Ms": 180.0,
        "p95Ms": 690.0,
        "p99Ms": 1240.0,
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

#### Field Reference — `data` (snapshot)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"snapshot"`. Discriminator for payload routing. |
| `generatedAt` | `string` (ISO 8601 UTC) | Yes | When the aggregator computed this snapshot. May differ slightly from envelope `timestamp`. |
| `windowSec` | `int` | Yes | Rolling window size in seconds (default: `300`). All edge stats cover this window. |
| `nodes` | `NexusNodeInfo[]` | Yes | All active graph nodes. Always includes `flt-local`. |
| `edges` | `NexusEdgeStats[]` | Yes | All active dependency edges. Empty array if no traffic observed. |
| `alerts` | `NexusAlert[]` | Yes | Active anomaly alerts. Empty array if all dependencies healthy. Max 10 per snapshot. |

#### Field Reference — `nodes[]` (NexusNodeInfo)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Node identifier. `"flt-local"` for core node, or a `NexusDependencyId` value (e.g., `"spark-gts"`, `"auth"`, `"unknown"`). |
| `kind` | `string` | Yes | `"core"` for FLT local, `"dependency"` for all others. |
| `volume` | `int` | Yes | Total event count in the current window. Drives node size in rendering. |

**V1 canonical node IDs:**

| ID | Description |
|----|-------------|
| `flt-local` | FLT core node (always present, hub of the graph) |
| `spark-gts` | Spark / GTS Livy sessions |
| `fabric-api` | Fabric workspace and lakehouse APIs |
| `platform-api` | Power BI dedicated / Power BI dataflow APIs |
| `auth` | AAD / MWC token acquisition |
| `capacity` | Capacity management APIs |
| `cache` | Cache interceptor operations |
| `retry-system` | Retry interceptor events |
| `filesystem` | File system operations (hidden by default behind Internals toggle) |
| `unknown` | Unclassified HTTP traffic |

#### Field Reference — `edges[]` (NexusEdgeStats)

| Field | Type | Required | Unit | Description |
|-------|------|----------|------|-------------|
| `from` | `string` | Yes | — | Source node. Always `"flt-local"` in V1 (hub-spoke topology). |
| `to` | `string` | Yes | — | Target dependency ID (one of the canonical IDs above). |
| `volume` | `int` | Yes | count | Total events in current window for this edge. |
| `throughputPerMin` | `double` | Yes | events/min | Request rate computed over the window. |
| `p50Ms` | `double` | Yes | milliseconds | Median latency. Excludes zero-latency enrichment events. |
| `p95Ms` | `double` | Yes | milliseconds | 95th percentile latency. |
| `p99Ms` | `double` | Yes | milliseconds | 99th percentile latency. |
| `errorRate` | `double` | Yes | ratio [0.0, 1.0] | Fraction of events with `statusCode >= 400` or error signal. |
| `retryRate` | `double` | Yes | ratio [0.0, 1.0] | Fraction of events with `retryCount > 0`. |
| `baselineDelta` | `double` | Yes | multiplier | Current p95 / baseline p95. `1.0` = at baseline, `3.0` = 3x above. |
| `health` | `string` | Yes | — | `"healthy"`, `"degraded"`, or `"critical"`. |

#### Field Reference — `alerts[]` (NexusAlert)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `severity` | `string` | Yes | `"warning"` or `"critical"`. No `"info"` level. |
| `dependencyId` | `string` | Yes | Affected dependency ID. |
| `message` | `string` | Yes | Human-readable English string for toast/UI display. |
| `timestamp` | `string` (ISO 8601 UTC) | Yes | When the alert was generated. |

### 1.4 Alert Message (`type: "alert"`)

Published **out-of-band** by the aggregator when the anomaly detector fires between snapshot heartbeats. Enables sub-second alert delivery without waiting for the next 1 Hz snapshot.

#### JSON Schema

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
    "currentValue": 690.0,
    "baselineValue": 230.0,
    "delta": 3.0,
    "message": "Latency 3.0x above baseline",
    "timestamp": "2026-04-24T04:10:12.500Z"
  }
}
```

#### Field Reference — `data` (alert)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Always `"alert"`. Discriminator for payload routing. |
| `severity` | `string` | Yes | `"warning"` or `"critical"`. |
| `dependencyId` | `string` | Yes | Which dependency triggered the anomaly. |
| `metric` | `string` | Yes | Which metric triggered: `"p95Ms"`, `"errorRate"`, `"retryRate"`. |
| `currentValue` | `double` | Yes | Current metric value at trigger time. |
| `baselineValue` | `double` | Yes | Baseline value for comparison. |
| `delta` | `double` | Yes | `currentValue / baselineValue` ratio (same as `baselineDelta` for latency). |
| `message` | `string` | Yes | Human-readable alert text for toast rendering. |
| `timestamp` | `string` (ISO 8601 UTC) | Yes | When the alert was generated. |

---

## §2 SignalR Subscription Lifecycle

### 2.1 Subscribe Flow

The `nexus` topic uses the same two-phase streaming contract as every other EDOG topic (`EdogPlaygroundHub.cs:62-106`). No custom subscription logic is required.

```
Frontend                            Hub                              TopicBuffer
   │                                 │                                   │
   │ subscribeTopic('nexus')         │                                   │
   │ ─────────────────────────────►  │                                   │
   │  connection.stream(             │                                   │
   │    'SubscribeToTopic','nexus')  │                                   │
   │                                 │ GetBuffer("nexus")                │
   │                                 │ ──────────────────────────────►   │
   │                                 │ ◄── TopicBuffer(500)              │
   │                                 │                                   │
   │                                 │ ═══ Phase 1: Snapshot ═══        │
   │                                 │ GetSnapshot()                     │
   │                                 │ ──────────────────────────────►   │
   │                                 │ ◄── TopicEvent[0..N]              │
   │ ◄── TopicEvent (history #1)     │                                   │
   │ ◄── TopicEvent (history #2)     │                                   │
   │ ◄── ...                         │                                   │
   │ ◄── TopicEvent (history #N)     │                                   │
   │                                 │                                   │
   │                                 │ ═══ Phase 2: Live ═══            │
   │                                 │ ReadLiveAsync(ct)                 │
   │                                 │ ──────────────────────────────►   │
   │                                 │  (awaits live events)             │
   │                                 │                                   │
   │           ... time passes ...   │                                   │
   │                                 │ ◄── new TopicEvent                │
   │ ◄── TopicEvent (live)           │                                   │
   │                                 │ ◄── new TopicEvent                │
   │ ◄── TopicEvent (live)           │                                   │
   │                                 │                                   │
```

**Phase 1 — Snapshot (buffered history):**
1. `buffer.GetSnapshot()` returns a point-in-time copy of all events in the 500-entry ring buffer, ordered by `sequenceId` (`TopicBuffer.cs:62-64`).
2. Each `TopicEvent` is written to a per-client `BoundedChannel<TopicEvent>(1000, DropOldest)` (`EdogPlaygroundHub.cs:70-76`).
3. Frontend receives a burst of historical snapshots + alerts, enabling cold-start hydration.
4. At 1 Hz, a full ring buffer (500 entries) represents ~8 minutes of snapshot history.

**Phase 2 — Live:**
1. `buffer.ReadLiveAsync(cancellationToken)` yields new events as the aggregator publishes them (`TopicBuffer.cs:70-73`).
2. Events arrive at ~1 Hz (snapshots) plus out-of-band alerts.
3. Stream continues until the client disposes the subscription or disconnects.

### 2.2 Unsubscribe Flow

```javascript
// In tab-nexus.js deactivate():
this._signalr.off('nexus', this._onSnapshot);
this._signalr.unsubscribeTopic('nexus');
```

`unsubscribeTopic()` calls `stream.dispose()` (`signalr-manager.js:218`), which fires `OperationCanceledException` in the hub pump (`EdogPlaygroundHub.cs:94`), completing the `BoundedChannel` cleanly (`EdogPlaygroundHub.cs:101`).

### 2.3 Reconnect Flow

On SignalR disconnect/reconnect, the existing `_resubscribeAll()` handler (`signalr-manager.js:147-158`) automatically re-subscribes all active topics:

```
Connection drops
  → onreconnecting() fires (line 81)
  → onreconnected() fires (line 86)
    → _resubscribeAll() (line 89)
      → _activeStreams.clear() (line 155)
      → subscribeTopic('nexus') re-called (line 157)
        → new SubscribeToTopic("nexus") → Phase 1 + Phase 2
```

**Key properties:**
- Old stream is torn down before new stream starts — no duplicate delivery
- New Phase 1 delivers full ring buffer contents — no gap in graph state
- Snapshots are full-state replacements — reconnect is inherently idempotent
- If tab-nexus was deactivated (user navigated away), `nexus` is not in `_activeStreams` and is correctly **not** re-subscribed

### 2.4 BoundedChannel Configuration

Per-client channel created by `SubscribeToTopic()` (`EdogPlaygroundHub.cs:70-76`):

| Parameter | Value | Rationale for nexus |
|-----------|-------|---------------------|
| Capacity | 1000 | 1 Hz snapshots + ~10 alerts/min = ~70 events/min. 1000 = ~14 min buffer. |
| FullMode | `DropOldest` | Snapshots are full-state; dropping oldest is safe. |
| SingleReader | `true` | One SignalR stream consumer per channel. |
| SingleWriter | `false` | Safe default (background pump is sole writer). |

No per-topic channel tuning is needed. The existing configuration applies uniformly to all topics.

---

## §3 REST Bootstrap Endpoint

### 3.1 Endpoint

```
GET /api/nexus
```

Returns the latest aggregator snapshot from the `nexus` ring buffer for cold-start bootstrap. Follows the pattern established by `/api/logs`, `/api/telemetry`, `/api/stats`, and `/api/executions` (`EdogLogServer.cs:253-388`).

### 3.2 Request

| Parameter | Location | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `limit` | Query string | `int` | `1` | Number of recent snapshots to return (most recent first, then reversed to chronological order). |

```
GET /api/nexus
GET /api/nexus?limit=5
```

### 3.3 Response

#### 200 OK — Data available

```json
[
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
        { "id": "spark-gts", "kind": "dependency", "volume": 186 },
        { "id": "auth", "kind": "dependency", "volume": 45 },
        { "id": "fabric-api", "kind": "dependency", "volume": 312 },
        { "id": "capacity", "kind": "dependency", "volume": 8 }
      ],
      "edges": [
        {
          "from": "flt-local",
          "to": "spark-gts",
          "volume": 186,
          "throughputPerMin": 37.2,
          "p50Ms": 180.0,
          "p95Ms": 690.0,
          "p99Ms": 1240.0,
          "errorRate": 0.07,
          "retryRate": 0.11,
          "baselineDelta": 3.0,
          "health": "degraded"
        },
        {
          "from": "flt-local",
          "to": "auth",
          "volume": 45,
          "throughputPerMin": 9.0,
          "p50Ms": 12.0,
          "p95Ms": 35.0,
          "p99Ms": 48.0,
          "errorRate": 0.0,
          "retryRate": 0.0,
          "baselineDelta": 1.1,
          "health": "healthy"
        },
        {
          "from": "flt-local",
          "to": "fabric-api",
          "volume": 312,
          "throughputPerMin": 62.4,
          "p50Ms": 45.0,
          "p95Ms": 120.0,
          "p99Ms": 210.0,
          "errorRate": 0.02,
          "retryRate": 0.03,
          "baselineDelta": 1.0,
          "health": "healthy"
        },
        {
          "from": "flt-local",
          "to": "capacity",
          "volume": 8,
          "throughputPerMin": 1.6,
          "p50Ms": 8.0,
          "p95Ms": 15.0,
          "p99Ms": 22.0,
          "errorRate": 0.0,
          "retryRate": 0.0,
          "baselineDelta": 1.0,
          "health": "healthy"
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
]
```

**Content-Type:** `application/json`

The response is an **array of `TopicEvent`** objects (same wire format as SignalR stream events). This allows the frontend to feed REST bootstrap data through the same `_onSnapshot()` handler used for SignalR events.

#### 200 OK — No data yet (empty array)

```json
[]
```

Returned when the aggregator has not yet published any snapshots (e.g., FLT just started, no outbound calls yet). Frontend should display the empty state.

#### 404 Not Found — Topic not registered

```json
{"error": "nexus topic not registered"}
```

Returned if `EdogTopicRouter.GetBuffer("nexus")` returns null. Indicates `nexus` topic was not registered in `Initialize()`. Frontend falls back to SignalR-only delivery.

#### 500 Internal Server Error

Returned on unexpected exceptions. No body guaranteed. Frontend should retry or fall back to SignalR stream.

### 3.4 Priority vs SignalR Bootstrap

| Mechanism | When used | Data freshness |
|-----------|-----------|----------------|
| `GET /api/nexus` | During initial page load, **before** SignalR connects | Point-in-time snapshot of ring buffer |
| `SubscribeToTopic("nexus")` Phase 1 | When tab activates and SignalR stream starts | Full ring buffer replay (potentially fresher) |

**Priority rule:** The SignalR stream Phase 1 snapshot is authoritative. If both REST and SignalR deliver data, the frontend should:

1. Use REST data for immediate rendering during the connection gap
2. Replace with SignalR Phase 1 data once the stream connects (full-state replacement semantics make this safe)

In practice, tab-nexus.js calls `subscribeTopic('nexus')` on `activate()`. The Phase 1 snapshot replay overwrites any REST-bootstrapped state. No deduplication logic is needed.

### 3.5 When Called

Called by `main.js` during `loadInitialData()` (`main.js:620+`), following the pattern:

```javascript
const nexusResponse = await fetch('/api/nexus');
if (nexusResponse.ok) {
  const snapshots = await nexusResponse.json();
  // Feed to NexusTab for initial render if available
}
```

---

## §4 Frontend → Backend Commands

### 4.1 V1: Nexus is Read-Only

In V1, the Nexus channel is **strictly unidirectional**: backend pushes, frontend receives. The frontend does **not** send any commands to the backend for Nexus.

| Direction | Message types |
|-----------|---------------|
| Backend → Frontend | `snapshot` (1 Hz), `alert` (on-anomaly) |
| Frontend → Backend | *None* |

The only frontend-to-backend interactions are the standard transport-level calls:
- `SubscribeToTopic("nexus")` — start streaming (generic hub method)
- Stream disposal — stop streaming (generic SignalR lifecycle)

### 4.2 Future Commands (V2+)

The following commands may be added in future versions. They are documented here for forward planning but are **not** part of V1.

| Command | Direction | Purpose |
|---------|-----------|---------|
| `ResetBaseline` | Frontend → Backend | Reset the rolling baseline for all or one dependency. Useful when a deployment permanently changes latency characteristics. |
| `ForceSnapshot` | Frontend → Backend | Request an immediate snapshot outside the 1 Hz cadence. For debugging. |
| `ToggleDependency` | Frontend → Backend | Enable/disable data collection for a specific dependency. |

If implemented, these would be new hub methods on `EdogPlaygroundHub` (e.g., `NexusResetBaseline(string dependencyId)`), **not** messages on the `nexus` topic stream.

---

## §5 Error Handling Protocol

### 5.1 Malformed Snapshot from Backend

**Scenario:** Backend publishes a snapshot with invalid/missing fields.

**Frontend behavior:**
1. The `_onSnapshot(event)` handler wraps processing in a `try/catch` (matching existing pattern in `signalr-manager.js:198`).
2. If `event.data.type` is `"snapshot"` but required fields are missing (e.g., `nodes` is null), skip the update and log to console: `console.error('[nexus] malformed snapshot, skipping', event)`.
3. Retain the previous valid snapshot for rendering — do not clear the graph.
4. Continue processing the next event normally.

**Backend prevention:** The aggregator validates snapshot integrity before `Publish()`. If validation fails, the aggregator logs internally and skips the publish cycle.

### 5.2 Unknown Message Type

**Scenario:** Frontend receives a `TopicEvent` on the `nexus` topic with `data.type` set to an unrecognized value (e.g., a future `"delta"` type added in V2).

**Frontend behavior:**
1. Log: `console.warn('[nexus] unknown message type:', event.data.type)`.
2. Ignore the message — do not process, do not crash.
3. Continue listening for the next event.

This is the standard forward-compatibility contract: consumers must tolerate unknown `type` values.

### 5.3 SignalR Disconnect/Reconnect Gap

**Scenario:** SignalR connection drops. Events published during the gap are lost from the client perspective.

**Detection:**
- `signalr-manager.js` fires `onStatusChange('reconnecting')` → tab-nexus.js can show a staleness indicator
- `signalr-manager.js` fires `onStatusChange('connected')` → tab-nexus.js clears the indicator

**Recovery:**
1. `_resubscribeAll()` re-calls `subscribeTopic('nexus')` (§2.3).
2. New Phase 1 delivers full ring buffer — complete graph state is restored.
3. Because snapshots are full-state replacements (not deltas), no gap reconciliation is needed.

**Data loss window:** Events published after the last client-received event and before the ring buffer snapshot are potentially lost. At 1 Hz snapshots, the maximum gap is 1 second of snapshot data. The ring buffer retains ~8 minutes, so reconnects within ~8 minutes recover all prior snapshots.

### 5.4 Staleness Detection

The frontend can detect stale data using two signals:

| Signal | How to detect | Action |
|--------|---------------|--------|
| **Connection-level** | `signalR.status !== 'connected'` | Show "Disconnected" badge overlay on graph |
| **Data-level** | `Date.now() - Date.parse(snapshot.generatedAt) > 3000` | Show "Stale" indicator (data older than 3s) |

**Staleness threshold:** 3 seconds (3x the 1 Hz heartbeat). If no snapshot arrives within 3 seconds, the data is considered stale. This accounts for normal jitter without false alarms.

**Implementation:**
```javascript
_checkStaleness() {
  if (!this._snapshot) return;
  const ageMs = Date.now() - new Date(this._snapshot.generatedAt).getTime();
  const isStale = ageMs > 3000;
  this._els.staleIndicator.classList.toggle('visible', isStale);
}
```

Run on a 1-second `setInterval` during `activate()`, cleared on `deactivate()`.

### 5.5 SequenceId Gap Detection

The `sequenceId` field on `TopicEvent` is monotonic per topic. If the frontend observes a gap (e.g., receives `sequenceId` 45 after 42), it knows events were dropped.

**Frontend behavior:**
1. Track `_lastSequenceId` per topic.
2. On gap: log `console.warn('[nexus] sequence gap: expected ${expected}, got ${actual}')`.
3. No corrective action required — the next full-state snapshot replaces all state anyway.

This is primarily a diagnostic signal, not an error requiring recovery.

---

## §6 Message Catalog

### 6.1 Complete Message Inventory

| # | Message | Direction | `data.type` | Frequency | Trigger |
|---|---------|-----------|-------------|-----------|---------|
| M1 | Graph Snapshot | Backend → Frontend | `snapshot` | 1 Hz (periodic) | Aggregator timer tick |
| M2 | Anomaly Alert | Backend → Frontend | `alert` | On-anomaly (0–10/min) | Dependency metric crosses threshold |

No frontend-to-backend messages exist in V1 (§4.1).

### 6.2 Payload Size Estimates

#### M1: Snapshot

| Component | Typical size | Calculation |
|-----------|-------------|-------------|
| Envelope overhead | ~100 bytes | `sequenceId`, `timestamp`, `topic` |
| `type` + `generatedAt` + `windowSec` | ~80 bytes | Fixed metadata |
| `nodes[]` (5 active deps + flt-local) | ~300 bytes | ~50 bytes/node × 6 nodes |
| `edges[]` (5 active deps) | ~750 bytes | ~150 bytes/edge × 5 edges |
| `alerts[]` (0–2 typical) | ~200 bytes | ~100 bytes/alert × 2 alerts |
| **Typical total** | **~1.4 KB** | |
| Maximum (9 deps + 10 alerts) | ~3.5 KB | 10 nodes + 9 edges + 10 alerts |

#### M2: Alert

| Component | Typical size |
|-----------|-------------|
| Full alert message | ~350 bytes |

### 6.3 Bandwidth Estimates

| Scenario | Snapshots/sec | Alerts/sec | Bytes/sec | KB/min |
|----------|---------------|------------|-----------|--------|
| **Idle** (no traffic) | 1 | 0 | ~200 B/s | ~12 KB/min |
| **Normal** (3–5 active deps) | 1 | ~0.03 | ~1.4 KB/s | ~84 KB/min |
| **Heavy** (9 deps, 5 alerts/min) | 1 | ~0.08 | ~3.5 KB/s | ~210 KB/min |
| **Alert storm** (10 alerts/min) | 1 | ~0.17 | ~3.6 KB/s | ~216 KB/min |

**Comparison:** The `http` topic in high-traffic scenarios can generate 50–100 KB/s. Nexus is 1–2 orders of magnitude lower because it publishes pre-aggregated summaries, not raw per-request events.

### 6.4 Realistic Example: Healthy FLT Session

5 minutes into an active FLT session with moderate Spark activity and normal API traffic.

```json
{
  "sequenceId": 301,
  "timestamp": "2026-04-24T04:15:01.003Z",
  "topic": "nexus",
  "data": {
    "type": "snapshot",
    "generatedAt": "2026-04-24T04:15:01.000Z",
    "windowSec": 300,
    "nodes": [
      { "id": "flt-local", "kind": "core", "volume": 0 },
      { "id": "spark-gts", "kind": "dependency", "volume": 186 },
      { "id": "fabric-api", "kind": "dependency", "volume": 312 },
      { "id": "auth", "kind": "dependency", "volume": 45 },
      { "id": "platform-api", "kind": "dependency", "volume": 28 },
      { "id": "capacity", "kind": "dependency", "volume": 8 }
    ],
    "edges": [
      {
        "from": "flt-local", "to": "spark-gts",
        "volume": 186, "throughputPerMin": 37.2,
        "p50Ms": 180.0, "p95Ms": 420.0, "p99Ms": 680.0,
        "errorRate": 0.01, "retryRate": 0.02,
        "baselineDelta": 1.0, "health": "healthy"
      },
      {
        "from": "flt-local", "to": "fabric-api",
        "volume": 312, "throughputPerMin": 62.4,
        "p50Ms": 45.0, "p95Ms": 120.0, "p99Ms": 210.0,
        "errorRate": 0.02, "retryRate": 0.03,
        "baselineDelta": 1.0, "health": "healthy"
      },
      {
        "from": "flt-local", "to": "auth",
        "volume": 45, "throughputPerMin": 9.0,
        "p50Ms": 12.0, "p95Ms": 35.0, "p99Ms": 48.0,
        "errorRate": 0.0, "retryRate": 0.0,
        "baselineDelta": 1.1, "health": "healthy"
      },
      {
        "from": "flt-local", "to": "platform-api",
        "volume": 28, "throughputPerMin": 5.6,
        "p50Ms": 95.0, "p95Ms": 240.0, "p99Ms": 390.0,
        "errorRate": 0.0, "retryRate": 0.0,
        "baselineDelta": 1.2, "health": "healthy"
      },
      {
        "from": "flt-local", "to": "capacity",
        "volume": 8, "throughputPerMin": 1.6,
        "p50Ms": 8.0, "p95Ms": 15.0, "p99Ms": 22.0,
        "errorRate": 0.0, "retryRate": 0.0,
        "baselineDelta": 1.0, "health": "healthy"
      }
    ],
    "alerts": []
  }
}
```

### 6.5 Realistic Example: Incident — GTS Degraded + Auth Critical

Spark/GTS is experiencing latency regression and auth tokens are failing at 40% rate.

```json
{
  "sequenceId": 580,
  "timestamp": "2026-04-24T04:19:40.005Z",
  "topic": "nexus",
  "data": {
    "type": "snapshot",
    "generatedAt": "2026-04-24T04:19:40.000Z",
    "windowSec": 300,
    "nodes": [
      { "id": "flt-local", "kind": "core", "volume": 0 },
      { "id": "spark-gts", "kind": "dependency", "volume": 142 },
      { "id": "auth", "kind": "dependency", "volume": 63 },
      { "id": "fabric-api", "kind": "dependency", "volume": 290 },
      { "id": "retry-system", "kind": "dependency", "volume": 38 }
    ],
    "edges": [
      {
        "from": "flt-local", "to": "spark-gts",
        "volume": 142, "throughputPerMin": 28.4,
        "p50Ms": 450.0, "p95Ms": 1380.0, "p99Ms": 2100.0,
        "errorRate": 0.12, "retryRate": 0.25,
        "baselineDelta": 3.3, "health": "degraded"
      },
      {
        "from": "flt-local", "to": "auth",
        "volume": 63, "throughputPerMin": 12.6,
        "p50Ms": 85.0, "p95Ms": 2400.0, "p99Ms": 5000.0,
        "errorRate": 0.40, "retryRate": 0.35,
        "baselineDelta": 68.6, "health": "critical"
      },
      {
        "from": "flt-local", "to": "fabric-api",
        "volume": 290, "throughputPerMin": 58.0,
        "p50Ms": 48.0, "p95Ms": 130.0, "p99Ms": 220.0,
        "errorRate": 0.02, "retryRate": 0.03,
        "baselineDelta": 1.1, "health": "healthy"
      },
      {
        "from": "flt-local", "to": "retry-system",
        "volume": 38, "throughputPerMin": 7.6,
        "p50Ms": 0.0, "p95Ms": 0.0, "p99Ms": 0.0,
        "errorRate": 0.0, "retryRate": 1.0,
        "baselineDelta": 1.0, "health": "healthy"
      }
    ],
    "alerts": [
      {
        "severity": "warning",
        "dependencyId": "spark-gts",
        "message": "Latency 3.3x above baseline (p95: 1380ms vs 420ms)",
        "timestamp": "2026-04-24T04:19:40.000Z"
      },
      {
        "severity": "critical",
        "dependencyId": "auth",
        "message": "Error rate 40% — token acquisition failures",
        "timestamp": "2026-04-24T04:19:40.000Z"
      }
    ]
  }
}
```

### 6.6 Realistic Example: Out-of-Band Alert

Published between snapshots when the anomaly detector fires.

```json
{
  "sequenceId": 581,
  "timestamp": "2026-04-24T04:19:40.450Z",
  "topic": "nexus",
  "data": {
    "type": "alert",
    "severity": "critical",
    "dependencyId": "auth",
    "metric": "errorRate",
    "currentValue": 0.40,
    "baselineValue": 0.02,
    "delta": 20.0,
    "message": "Error rate 40% — token acquisition failures",
    "timestamp": "2026-04-24T04:19:40.450Z"
  }
}
```

### 6.7 Realistic Example: Empty Graph (Cold Start)

First snapshot after FLT starts, before any outbound calls.

```json
{
  "sequenceId": 1,
  "timestamp": "2026-04-24T04:10:01.000Z",
  "topic": "nexus",
  "data": {
    "type": "snapshot",
    "generatedAt": "2026-04-24T04:10:01.000Z",
    "windowSec": 300,
    "nodes": [
      { "id": "flt-local", "kind": "core", "volume": 0 }
    ],
    "edges": [],
    "alerts": []
  }
}
```

---

## §7 Compatibility and Evolution

### 7.1 Schema Evolution Strategy

**Additive-only changes are the default contract.** There is no explicit version field in the message envelope or payload. Instead:

| Change type | Backward compatible? | Action required |
|-------------|---------------------|-----------------|
| Add new field to snapshot/alert | Yes | Frontend ignores unknown fields (JSON default). No change needed. |
| Add new `NexusDependencyId` value | Yes | Frontend treats unknown IDs as a generic node. Already tolerant by design (C01 §1.5). |
| Add new `data.type` value | Yes | Frontend logs warning and ignores (§5.2). |
| Add new `health` value | Yes | Frontend falls back to default styling for unknown health values. |
| Remove a field | **No** | Requires coordinated backend+frontend deploy. Flag as breaking change. |
| Rename a field | **No** | Requires coordinated backend+frontend deploy. Flag as breaking change. |
| Change field type | **No** | Requires coordinated backend+frontend deploy. Flag as breaking change. |

### 7.2 Frontend Unknown-Field Handling

The frontend must follow these rules:

1. **JSON parsing:** Use standard `JSON.parse()` — unknown fields are preserved in the parsed object but ignored by rendering code.
2. **Field access:** Access known fields by name. Never iterate over all fields assuming a fixed set.
3. **Unknown dependency IDs:** Render as a generic dependency node with `id` as label. Do not crash or hide.
4. **Unknown health values:** Apply neutral/default styling (e.g., gray edge). Do not crash.
5. **Unknown alert severity:** Display with default styling. Do not suppress.

### 7.3 Backend Guarantees

1. **Field presence:** All fields listed in §1.3 are always present in published messages. No optional fields in V1 — every field is written with a value (empty arrays for `nodes`/`edges`/`alerts` when no data).
2. **Type stability:** Field types do not change between releases. `volume` is always `int`, `p50Ms` is always `double`, etc.
3. **Ordering:** `nodes` and `edges` arrays have no guaranteed order. Frontend must not rely on array index for identity — use `id`/`from`+`to` as keys.
4. **Idempotent snapshots:** Two consecutive identical snapshots are valid (no-change tick). Frontend should handle gracefully (skip re-render if data is unchanged via reference or shallow comparison).

### 7.4 Version Negotiation (Future)

If a breaking change is ever required, the protocol will evolve as follows:

1. Backend adds a `"version": 2` field to the `data` payload.
2. Backend publishes both V1 and V2 format snapshots during a transition period (or V2 only if coordinated deploy).
3. Frontend checks for `data.version` — if present and > 1, applies V2 parsing logic. If absent, assumes V1.

This mechanism is **not implemented in V1**. It is documented to establish the upgrade path.

---

## Appendix A — Backend Publisher Reference

### A.1 Snapshot Publishing Pattern

The aggregator publishes snapshots using anonymous objects matching the wire format:

```csharp
EdogTopicRouter.Publish("nexus", new
{
    type = "snapshot",
    generatedAt = DateTimeOffset.UtcNow,
    windowSec = _windowSec,
    nodes = nodeArray,    // NexusNodeInfo[] or anonymous equivalent
    edges = edgeArray,    // NexusEdgeStats[] or anonymous equivalent
    alerts = alertArray   // NexusAlert[] or anonymous equivalent
});
```

This follows the existing interceptor pattern where anonymous objects are published via `EdogTopicRouter.Publish()` (`EdogHttpPipelineHandler.cs:67-78`, `EdogTokenInterceptor.cs:63-72`).

### A.2 Alert Publishing Pattern

```csharp
EdogTopicRouter.Publish("nexus", new
{
    type = "alert",
    severity = "warning",
    dependencyId = "spark-gts",
    metric = "p95Ms",
    currentValue = 690.0,
    baselineValue = 230.0,
    delta = 3.0,
    message = $"Latency {delta:F1}x above baseline",
    timestamp = DateTimeOffset.UtcNow
});
```

### A.3 REST Endpoint Pattern

```csharp
app.MapGet("/api/nexus", async context =>
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
});
```

---

## Appendix B — Frontend Consumer Reference

### B.1 Subscription Lifecycle

```javascript
// tab-nexus.js

activate() {
  this._active = true;
  this._resizeCanvas();
  if (this._signalr) {
    this._signalr.on('nexus', this._onNexusEvent);
    this._signalr.subscribeTopic('nexus');
  }
  this._stalenessTimer = setInterval(() => this._checkStaleness(), 1000);
}

deactivate() {
  this._active = false;
  if (this._stalenessTimer) clearInterval(this._stalenessTimer);
  if (this._signalr) {
    this._signalr.off('nexus', this._onNexusEvent);
    this._signalr.unsubscribeTopic('nexus');
  }
}
```

### B.2 Message Routing

```javascript
_onNexusEvent(event) {
  try {
    const payload = event.data;
    if (!payload || !payload.type) return;

    // Track sequence gaps
    if (this._lastSeqId !== null && event.sequenceId > this._lastSeqId + 1) {
      console.warn('[nexus] sequence gap:', this._lastSeqId, '->', event.sequenceId);
    }
    this._lastSeqId = event.sequenceId;

    switch (payload.type) {
      case 'snapshot':
        this._handleSnapshot(payload);
        break;
      case 'alert':
        this._handleAlert(payload);
        break;
      default:
        console.warn('[nexus] unknown message type:', payload.type);
    }
  } catch (err) {
    console.error('[nexus] error processing event:', err);
  }
}
```

### B.3 REST Bootstrap

```javascript
// main.js loadInitialData()

const nexusResponse = await fetch('/api/nexus');
if (nexusResponse.ok) {
  const events = await nexusResponse.json();
  if (events.length > 0 && this.nexusTab) {
    // Feed the most recent snapshot to the tab for initial render
    const latest = events[events.length - 1];
    this.nexusTab._onNexusEvent(latest);
  }
}
```

---

## Appendix C — Source Code Cross-Reference

Every protocol decision in this document traces to an existing source file:

| Decision | Source file | Line(s) |
|----------|------------|---------|
| TopicEvent envelope shape | `TopicEvent.cs` | 17-30 |
| Envelope wrapping in Publish() | `EdogTopicRouter.cs` | 75-81 |
| Ring buffer + live channel | `TopicBuffer.cs` | 20-73 |
| Topic registration pattern | `EdogTopicRouter.cs` | 26-40 |
| SubscribeToTopic streaming | `EdogPlaygroundHub.cs` | 62-106 |
| BoundedChannel config | `EdogPlaygroundHub.cs` | 70-76 |
| Frontend subscribeTopic() | `signalr-manager.js` | 186-211 |
| Frontend on/off listeners | `signalr-manager.js` | 170-183 |
| Reconnect resubscribe | `signalr-manager.js` | 147-158 |
| REST endpoint pattern | `EdogLogServer.cs` | 253-327 |
| JSON serializer config | `EdogLogServer.cs` | 37 |
| SignalR hub registration | `EdogLogServer.cs` | 229 |
| Main.js bootstrap pattern | `main.js` | 620-670 |
| Tab activate/deactivate pattern | `tab-nexus.js` (C06 spec) | S02 |
| NexusSnapshot data contract | `EdogNexusModels.cs` (C01 spec) | §7 |
| NexusDependencyId values | `EdogNexusModels.cs` (C01 spec) | §1 |
| NexusHealthStatus values | `EdogNexusModels.cs` (C01 spec) | §3 |
| NexusAlert contract | `EdogNexusModels.cs` (C01 spec) | §6 |
