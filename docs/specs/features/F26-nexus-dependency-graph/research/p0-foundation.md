# F26 Nexus — P0 Foundation Research

## §1 Existing Code Audit

### 1.1 Backend runtime event substrate (what exists)
- EDOG already has a shared topic bus with fixed ring buffers (including `http`, `spark`, `token`, `retry`, `cache`, `fileop`, `perf`, `capacity`), so Nexus can reuse existing transport rather than inventing one (`src/backend/DevMode/EdogTopicRouter.cs:26-40`).
- Streaming semantics are already snapshot + live via `SubscribeToTopic()` with bounded channel size 1000 and `DropOldest`, which is good for triage continuity but can drop data under pressure (`src/backend/DevMode/EdogPlaygroundHub.cs:62-76`, `src/backend/DevMode/EdogPlaygroundHub.cs:82-92`).
- DevMode bootstrap already initializes topic router and registers wrappers/interceptors in one place (`src/backend/DevMode/EdogDevModeRegistrar.cs:33-45`).

### 1.2 Existing dependency-relevant interceptors
- HTTP capture is the strongest current source: method, URL (with SAS redaction), status, duration, request/response headers, body preview, client name, correlation ID (`src/backend/DevMode/EdogHttpPipelineHandler.cs:49-78`, `src/backend/DevMode/EdogHttpPipelineHandler.cs:90-104`, `src/backend/DevMode/EdogHttpPipelineHandler.cs:191-225`).
- Token interceptor adds auth metadata (`scheme`, token type, `aud`, `exp`, `iat`) without leaking token values (`src/backend/DevMode/EdogTokenInterceptor.cs:44-73`, `src/backend/DevMode/EdogTokenInterceptor.cs:97-139`).
- Spark interceptor emits lifecycle events (`Created`/`Error`) keyed by generated tracking IDs (`edog-spark-N`) (`src/backend/DevMode/EdogSparkSessionInterceptor.cs:52-53`, `src/backend/DevMode/EdogSparkSessionInterceptor.cs:67-80`, `src/backend/DevMode/EdogSparkSessionInterceptor.cs:86-101`).
- Retry interceptor is log-derived (regex parsing of retry messages), not direct policy instrumentation (`src/backend/DevMode/EdogRetryInterceptor.cs:16-25`, `src/backend/DevMode/EdogRetryInterceptor.cs:121-132`, `src/backend/DevMode/EdogRetryInterceptor.cs:186-201`).
- Cache events are available via static helper calls, but coverage depends on call-site adoption (`src/backend/DevMode/EdogCacheInterceptor.cs:18-23`, `src/backend/DevMode/EdogCacheInterceptor.cs:36-59`).
- File system interceptor wraps `IFileSystem` operations and publishes `fileop` with operation/path/size/duration/content preview/iteration (`src/backend/DevMode/EdogFileSystemInterceptor.cs:20-24`, `src/backend/DevMode/EdogFileSystemInterceptor.cs:248-265`).

### 1.3 Server + frontend transport/UI baseline
- Log server is in-memory only (`ConcurrentQueue`), with REST bootstraps (`/api/logs`, `/api/telemetry`, `/api/stats`, `/api/executions`) plus SignalR hub endpoint (`/hub/playground`) (`src/backend/DevMode/EdogLogServer.cs:40-42`, `src/backend/DevMode/EdogLogServer.cs:226-331`).
- SignalR manager already supports topic event bus semantics (`on/off/subscribeTopic/unsubscribeTopic`) and reconnect resubscription (`src/frontend/js/signalr-manager.js:170-173`, `src/frontend/js/signalr-manager.js:185-193`, `src/frontend/js/signalr-manager.js:147-158`).
- Runtime shell already models “Internals” as a dropdown with tabs (`tokens`, `caches`, `http`, `retries`, `flags`, `di`, `perf`)—a direct fit for “filesystem hidden behind Internals by default” (`src/frontend/js/runtime-view.js:26-27`, `src/frontend/js/runtime-view.js:300-311`, `src/frontend/index.html:144-155`).
- `main.js` wires runtime tabs and loads bootstrapped history from REST before/alongside live stream (`src/frontend/js/main.js:205-215`, `src/frontend/js/main.js:620-663`).
- HTTP tab already has triage-grade interactions (filters, sort, p50/p95/p99, detail panel) and render throttling via `requestAnimationFrame` (`src/frontend/js/tab-http.js:721-761`, `src/frontend/js/tab-http.js:823-859`, `src/frontend/js/tab-http.js:768-776`).
- Spark tab already has timeline/swimlane, active/history grouping, and max-session pruning (`src/frontend/js/tab-spark.js:32`, `src/frontend/js/tab-spark.js:185-197`, `src/frontend/js/tab-spark.js:383-396`, `src/frontend/js/tab-spark.js:725-799`).

### 1.4 Direct gaps vs F26 intent
- No `nexus` topic exists today (router pre-registers fixed topics; `nexus` absent) (`src/backend/DevMode/EdogTopicRouter.cs:28-40`).
- No backend service classification/edge aggregation layer exists; current tabs consume raw per-topic events independently (`src/frontend/js/main.js:205-215`).
- Spark and retry enrichment are not yet joined with HTTP edges in a canonical dependency model (`src/backend/DevMode/EdogSparkSessionInterceptor.cs:86-101`, `src/backend/DevMode/EdogRetryInterceptor.cs:186-201`).

## §2 Data Source Mapping

### 2.1 Canonical source-to-graph mapping

| Source | Existing shape | Nexus use | Confidence |
|---|---|---|---|
| `http` topic | `method,url,statusCode,durationMs,requestHeaders,responseHeaders,responseBodyPreview,httpClientName,correlationId` (`src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78`) | Primary edge stream (service classification, latency/error/throughput) | High |
| `token` topic | `tokenType,scheme,audience,expiryUtc,issuedUtc,httpClientName,endpoint` (`src/backend/DevMode/EdogTokenInterceptor.cs:63-72`) | Auth dependency node + auth-edge annotation | High |
| `spark` topic | `sessionTrackingId,event,workspace/artifact/iteration,duration,error` (`src/backend/DevMode/EdogSparkSessionInterceptor.cs:67-79`, `src/backend/DevMode/EdogSparkSessionInterceptor.cs:86-98`) | Spark node health + causal context for incidents | Medium |
| `retry` topic | Parsed `retryAttempt,totalAttempts,waitDurationMs,isThrottle,retryAfterMs,iterationId` (`src/backend/DevMode/EdogRetryInterceptor.cs:186-198`) | Edge severity amplification + throttle diagnosis | Medium (parser-based) |
| `cache` topic | `cacheName,operation,key,hitOrMiss,valueSizeBytes,ttlSeconds,durationMs` (`src/backend/DevMode/EdogCacheInterceptor.cs:46-56`) | Perf analytics and cache efficacy overlays | Medium |
| `fileop` topic | `operation,path,contentSizeBytes,durationMs,iterationId,...` (`src/backend/DevMode/EdogFileSystemInterceptor.cs:252-262`) | Internal dependency lane (hidden by default behind Internals) | High |
| REST bootstraps | `/api/logs`, `/api/telemetry`, `/api/stats`, `/api/executions` (`src/backend/DevMode/EdogLogServer.cs:253-331`) | Cold-start backfill for triage history | High |

### 2.2 Current frontend consumption topology
- Runtime tabs are currently siloed modules (`telemetry`, `sysfiles`, `spark`, `tokens`, `caches`, `http`, `retries`, `flags`, `di`, `perf`) rather than a fused dependency model (`src/frontend/js/main.js:205-215`).
- SignalR streaming already supports per-topic stream lifecycles needed by an aggregator-fed Nexus tab (`src/frontend/js/signalr-manager.js:185-221`).

### 2.3 Spec alignment check
- F26 spec already identifies existing interceptors as source of truth and expects a new `nexus` topic (`docs/specs/features/F26-nexus-dependency-graph/spec.md:73-85`, `docs/specs/features/F26-nexus-dependency-graph/spec.md:102-121`).
- Open questions in spec (filesystem node, layout, historical scope, edge scale) are now partially constrained by product decisions provided in this request (`docs/specs/features/F26-nexus-dependency-graph/spec.md:151-157`).

## §3 Industry Research (adopt/reject patterns)

### 3.1 Service dependency maps

**Adopt: backend edge aggregation with rolling windows**
- Pattern: maintain per-edge rolling counters/latency quantiles in short windows (e.g., 1m/5m) to drive stable color/weight.
- Why for EDOG: raw `http` events are high-cardinality; frontend already does per-tab filtering/rendering but no cross-edge summary. Aggregating in backend avoids duplicating logic and supports triage-first ranking.
- Codebase fit: place in backend Nexus Aggregator and publish condensed graph state to a new topic, reusing existing SignalR stream path (`src/backend/DevMode/EdogPlaygroundHub.cs:62-92`).

**Reject: pure client-side graph derivation from raw events**
- Reason: current UI already has heavy per-tab rendering loops; adding cross-topic joins in browser would fight 60fps goals under load (`src/frontend/js/tab-http.js:867-940`, `src/frontend/js/tab-spark.js:361-377`).

### 3.2 Triage-focused observability

**Adopt: “hot edge first” incident mode**
- Pattern: rank dependencies by incident pressure score (error rate + p95 regression + retries/throttle).
- Why for EDOG: product priority #1 is incident triage; retry/throttle signals already exist and should weight graph attention (`src/backend/DevMode/EdogRetryInterceptor.cs:147-155`, `src/backend/DevMode/EdogRetryInterceptor.cs:186-198`).

**Adopt: drill-down from edge to raw evidence**
- Pattern: clicking graph edge should open filtered raw request/retry/session evidence.
- Why for EDOG: detailed inspectors already exist (HTTP/Spark tabs), so Nexus should orchestrate deep links instead of duplicating payload UIs (`src/frontend/js/tab-http.js:976-1024`, `src/frontend/js/tab-spark.js:803-840`).

### 3.3 Graph rendering performance

**Adopt: hybrid layout + bounded local simulation**
- Pattern: fixed semantic rings for major service classes, with constrained local force adjustment to reduce overlap.
- Why for EDOG: aligns with decided hybrid layout and preserves triage readability (less jitter than full force).

**Adopt: progressive degradation strategy**
- Pattern: top-K edge rendering, node clustering for low-signal edges, animation throttling when edge count spikes.
- Why for EDOG: current tabs already cap buffers/sessions (`_MAX_EVENTS=2000`, `_maxSessions=200`) showing codebase preference for bounded-state degradation (`src/frontend/js/tab-http.js:42`, `src/frontend/js/tab-spark.js:32`).

**Reject: unconstrained force-directed simulation for all nodes**
- Reason: expensive and visually unstable under high churn; conflicts with 60fps requirement and incident readability.

## §4 Performance & Risk Baseline

### 4.1 Baseline performance mechanisms already present
- Topic ring buffers with bounded sizes (`http` 2000, `perf` 5000, etc.) (`src/backend/DevMode/EdogTopicRouter.cs:28-40`).
- Stream channel backpressure behavior (`DropOldest`) in hub stream (`src/backend/DevMode/EdogPlaygroundHub.cs:70-76`).
- HTTP tab uses RAF-deferred rendering and bounded event array (2000) (`src/frontend/js/tab-http.js:42`, `src/frontend/js/tab-http.js:106-110`, `src/frontend/js/tab-http.js:768-776`).
- Spark tab bounds active history to 200 sessions and prunes disposed sessions (`src/frontend/js/tab-spark.js:32`, `src/frontend/js/tab-spark.js:185-197`).

### 4.2 High-impact risks for F26
1. **No restart persistence for runtime histories**: core server storage is in-memory queues only; restart loses context (`src/backend/DevMode/EdogLogServer.cs:40-42`).
2. **Event loss under pressure**: stream channels drop oldest events, which can hide early incident context (`src/backend/DevMode/EdogPlaygroundHub.cs:70-76`).
3. **Retry signal quality risk**: retry data comes from log regex parsing (fragile to message format drift) (`src/backend/DevMode/EdogRetryInterceptor.cs:39-62`, `src/backend/DevMode/EdogRetryInterceptor.cs:121-132`).
4. **Cross-topic correlation gap**: no canonical edge identity layer currently joins `http` + `retry` + `token` + `spark` by shared keys/correlation (`src/backend/DevMode/EdogHttpPipelineHandler.cs:53`, `src/backend/DevMode/EdogRetryInterceptor.cs:197`, `src/backend/DevMode/EdogSparkSessionInterceptor.cs:88-95`).
5. **Internals noise risk**: filesystem emits rich event volume/content previews; should remain hidden by default and opt-in (`src/backend/DevMode/EdogFileSystemInterceptor.cs:252-262`, `src/frontend/js/runtime-view.js:314-316`).

## §5 Implications for P1/P2 decisions

1. **Backend Nexus Aggregator is mandatory (not optional)**
   - Build a single backend aggregator that subscribes to existing topics and emits condensed `nexus` graph snapshots/deltas. This matches existing backend-centric event collection and avoids duplicating logic in each tab (`src/backend/DevMode/EdogDevModeRegistrar.cs:33-45`, `src/backend/DevMode/EdogPlaygroundHub.cs:62-92`).

2. **Graph contract should be edge-centric and triage-ranked**
   - Include per-edge throughput, p50/p95/p99, error rate, retry/throttle counters, and incident score.
   - Keep raw-request drill-through by retaining correlation IDs from HTTP source (`src/backend/DevMode/EdogHttpPipelineHandler.cs:53`, `src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78`).

3. **Persistence must be designed in P2, not deferred**
   - Product requires session history across restarts; current baseline does not persist runtime history (`src/backend/DevMode/EdogLogServer.cs:40-42`).
   - P2 should define persisted aggregator state (compact edge history + snapshots), reload behavior, and retention bounds.

4. **Internals toggle behavior should mirror existing runtime UX contract**
   - Filesystem dependencies should be collected but hidden behind Internals by default, consistent with current RuntimeView internals model (`src/frontend/js/runtime-view.js:26-27`, `src/frontend/js/runtime-view.js:314-316`, `src/frontend/index.html:144-155`).

5. **Performance plan must codify graceful degradation rules up front**
   - Reuse codebase’s bounded-state philosophy (buffer caps + prune + RAF scheduling) as explicit Nexus degradation policy (`src/frontend/js/tab-http.js:42`, `src/frontend/js/tab-http.js:768-776`, `src/frontend/js/tab-spark.js:32`, `src/frontend/js/tab-spark.js:185-197`).
   - For heavy load: clamp rendered edges, aggregate low-signal nodes into buckets, reduce animation frequency, and prioritize incident-critical edges first.
