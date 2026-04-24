# F26 Nexus - Real-Time Cross-Workload Dependency Graph (Design Spec)

> **Date:** 2026-04-24  
> **Feature:** F26 - Nexus  
> **Status:** Approved design (ready for planning)  
> **Requested mode:** End-to-end in this cycle (SOP + plan + implementation after design approval)  
> **Primary objective:** Fast incident triage  
> **Context:** EDOG Studio Runtime View, SignalR topic architecture, existing DevMode interceptors

---

## 1. Problem Framing

### 1.1 What problem we are actually solving

When a run fails, engineers need one answer quickly: **which dependency is currently unhealthy and causing blast radius**. Today, this signal is fragmented across Logs, Spark, HTTP Pipeline, Retries, and Telemetry tabs. The core problem is not "show a graph"; it is **reduce triage time from multi-tab correlation to one glance plus one click-through**.

### 1.2 Why this matters now

The backend already publishes rich topic data (`http`, `spark`, `token`, `retry`, `cache`, `fileop`) through `EdogTopicRouter` and `EdogPlaygroundHub`. We are leaving incident intelligence on the floor by not fusing these streams into a dependency-health model.

---

## 2. Why the Obvious Answer Fails

### 2.1 Obvious answer
"Render a graph in frontend by listening to existing topics and drawing nodes/edges."

### 2.2 Why that fails in this system

1. **Inconsistent semantics across topics:** each topic has its own payload shape and granularity; frontend-only fusion duplicates backend logic and drifts quickly.
2. **High UI compute cost:** per-event graph recompute in browser conflicts with the 60fps requirement, especially under traffic bursts.
3. **Weak persistence story:** cross-restart session history is awkward and brittle if state only lives in tab memory.
4. **Poor operability:** no central kill switch or reducer-level backpressure controls if all intelligence is client-side.

Conclusion: we need a backend aggregator that emits a normalized Nexus stream.

---

## 3. Final Design Decision

### 3.1 Chosen approach
**Approach B - Backend Nexus Aggregator** (selected).

### 3.2 Rejected alternatives

1. **Approach A - Frontend-only synthesis:** fast prototype, but fails persistence/consistency/perf constraints.
2. **Approach C - Event-sourced analytics store:** strongest analytics depth, but over-scoped for V1 and increases delivery and operational risk.

---

## 4. Architecture

## 4.1 High-level flow

`http/spark/token/retry/cache/fileop topics`  
-> `EdogNexusAggregator` (normalize + classify + reduce + anomaly)  
-> `nexus` topic snapshots/events  
-> `SignalRManager.subscribeTopic('nexus')`  
-> `tab-nexus.js` render + deep-link actions

### 4.2 Backend components (new)

1. **`EdogNexusModels.cs`**
   - DTOs for normalized events, edge stats, snapshots, alerts.
2. **`EdogNexusClassifier.cs`**
   - URL/topic mapping into canonical dependency IDs.
3. **`EdogNexusAggregator.cs`**
   - Multi-topic consumer, reducer, anomaly detector, snapshot publisher.
4. **`EdogNexusSessionStore.cs`**
   - Bounded rolling persistence, startup restore, periodic flush.

### 4.3 Backend touch points (existing files)

1. `EdogTopicRouter.Initialize()` -> register `nexus` topic buffer.
2. `EdogDevModeRegistrar.RegisterAll()` -> start/stop Nexus aggregator service.

### 4.4 Frontend components

1. **New:** `src/frontend/js/tab-nexus.js`
2. **New:** `src/frontend/css/tab-nexus.css`
3. **Modify:** `src/frontend/index.html` (Nexus runtime content + nav entry)
4. **Modify:** `src/frontend/js/runtime-view.js` (tab registration / key routing)
5. **Modify:** `src/frontend/js/main.js` (instantiate/register Nexus tab module)
6. **Optional:** `src/frontend/js/sidebar.js` (sub-item sync for Nexus)

---

## 5. Data Contracts

### 5.1 Canonical dependency IDs (V1)

- `spark-gts`
- `fabric-api`
- `platform-api`
- `auth`
- `capacity`
- `cache`
- `retry-system`
- `filesystem` (hidden by default behind Internals toggle)
- `unknown`

### 5.2 Normalized event (internal reducer input)

```json
{
  "dependencyId": "spark-gts",
  "sourceTopic": "http",
  "timestamp": "2026-04-24T04:10:11.123Z",
  "method": "POST",
  "statusCode": 200,
  "latencyMs": 234.2,
  "isError": false,
  "retryCount": 0,
  "correlationId": "abc-123",
  "endpointHint": "/livysessions/123/statements",
  "iterationId": "..."
}
```

### 5.3 Snapshot payload (published to `nexus`)

```json
{
  "topic": "nexus",
  "type": "snapshot",
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
        "p50Ms": 180,
        "p95Ms": 690,
        "errorRate": 0.07,
        "retryRate": 0.11,
        "health": "degraded",
        "baselineDelta": 3.0
      }
    ],
    "alerts": [
      {
        "severity": "warning",
        "dependencyId": "spark-gts",
        "message": "Latency 3.0x above baseline"
      }
    ]
  }
}
```

---

## 6. UX and Interaction Design

### 6.1 Graph layout
**Hybrid layout** (approved):

1. Fixed service rings for stable muscle memory in triage.
2. Local force adjustment inside each ring to reduce overlap.
3. Deterministic seed to avoid graph "jumping" between renders.

### 6.2 Visual encoding

1. **Node size:** request volume
2. **Edge thickness:** throughput
3. **Edge color:** health (`healthy`, `degraded`, `critical`)
4. **Pulse animation:** active anomaly

### 6.3 Triage-first interactions

1. Click edge/node -> open detail panel (p50/p95/p99, error codes, retries, recent events)
2. Deep links:
   - Spark edge -> Spark tab filtered context
   - HTTP-heavy edge -> HTTP tab with prefilled filter
   - Retry-heavy edge -> Retries tab scoped by endpoint/iteration
3. File-system dependencies remain hidden until Internals toggle is enabled.

---

## 7. Persistence and Retention

### 7.1 Requirement
Session history must survive service restart.

### 7.2 V1 strategy

1. Rolling persistence file managed by `EdogNexusSessionStore`.
2. Periodic flush cadence (e.g., every 5 seconds) plus flush on graceful stop.
3. Bounded retention by age + count to prevent unbounded growth.
4. Startup restore hydrates state before live stream resumes.

### 7.3 Corruption handling

1. If load fails: quarantine invalid file and start clean.
2. Emit one warning event for operator visibility.
3. Do not block service startup.

---

## 8. Performance and Scalability

### 8.1 Performance target
**60fps under normal load, graceful degradation under heavy load**.

### 8.2 Budget strategy

1. Backend does aggregation; frontend renders snapshots (not raw event flood).
2. Snapshot heartbeat (e.g., 1 Hz) and alert events out-of-band.
3. Render caps:
   - max visible edges
   - adaptive collapse into `other` group for long tails
4. Avoid full layout recomputation on each update; incremental update path.

---

## 9. Failure Modes and Tradeoffs

| Risk | Mitigation | Tradeoff |
|---|---|---|
| Unknown endpoint patterns | Route to `unknown`, track top signatures | Some events less actionable until classifier update |
| Topic burst/backpressure | Bounded buffers + drop-oldest + warning event | May lose oldest detail under sustained overload |
| Persistence file growth | Retention caps by age/count | Deep historical forensics remains out of V1 scope |
| Graph clutter | Adaptive collapse + internals toggle | Some detail hidden unless expanded |
| Stream disconnect | Rehydrate from persisted state, then resume live | Brief stale window after reconnect |

---

## 10. Security and Privacy

1. Reuse existing redaction guarantees from source topics:
   - auth headers redacted
   - SAS tokens stripped
   - body previews bounded and sanitized
2. Nexus does not store raw secrets, only derived metrics and safe metadata.
3. Local persistence remains devmode-local and bounded.

---

## 11. Testing Strategy

### 11.1 Backend tests

1. Classifier mapping tests (known routes, edge routes, unknown fallback)
2. Reducer correctness (rates, percentiles, baseline deltas)
3. Session store load/save + corruption recovery
4. Snapshot envelope contract tests

### 11.2 Frontend tests

1. Rendering state tests (empty, healthy, degraded, critical, collapsed)
2. Interaction tests (node selection, internals toggle, deep links)
3. Keyboard/accessibility checks for Nexus tab controls

### 11.3 Integration tests

1. Synthetic replay across source topics -> deterministic Nexus snapshots
2. Reconnect and restore flow
3. Heavy-load simulation for graceful degradation behavior

---

## 12. Acceptance Criteria (V1)

1. Nexus appears as Runtime tab and receives data from a dedicated `nexus` topic.
2. Dependency health view supports triage at a glance (volume, latency, error/retry).
3. Deep links to Spark/HTTP/Retries tabs work with relevant pre-filters.
4. File-system dependencies are hidden by default and shown via Internals toggle.
5. Session history restores after restart.
6. 60fps normal-load behavior is maintained; heavy-load degradation is controlled.
7. Unknown dependencies are visible and trackable (never silently dropped).

---

## 13. Scope Boundaries

### In scope (V1)

1. Live + persisted session dependency topology
2. Triage-first health visualization
3. Reducer-based anomalies and dependency alerts
4. Existing tab deep links

### Out of scope (V1)

1. Full long-horizon analytics warehouse
2. Multi-service distributed tracing beyond currently available devmode topics
3. Policy engine for automated dependency remediation

---

## 14. Implementation Readiness

Design is approved and internally consistent with:

1. Existing runtime module lifecycle (`activate/deactivate`)
2. Existing SignalR topic streaming model (`SubscribeToTopic`)
3. Existing backend topic router and interceptor architecture
4. Declared product priorities and constraints gathered during brainstorming

Next step: detailed implementation plan via `writing-plans`.
