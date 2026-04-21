# F26: Nexus — Real-Time Cross-Workload Dependency Graph

> **Status:** IDEA
> **Origin:** Brainstorm session in flt-edog-devmode (2026-04-21)
> **CEO:** Hemant Gupta

---

## 1. Why This Exists

FLT doesn't live in isolation. Every request that enters through the Azure Relay fan out into a web of outbound calls — Spark sessions via GTS, platform API calls back through the relay, capacity management checks, token acquisitions, file system operations, notebook execution triggers. Today, the Spark Inspector captures HTTP traffic for Spark/GTS calls specifically. But that's one slice of a much bigger picture.

When something goes wrong, engineers ask: "What did FLT call, when, and what came back?" They piece this together from logs, telemetry tabs, Spark inspector, and prayer. There's no unified view of FLT's dependency topology.

**Nexus maps every outbound call FLT makes into a live dependency graph** — classified by service, tracked by latency/error rate, rendered as an interactive topology. It answers: "What is my local FLT talking to right now, and which dependency is about to ruin my day?"

---

## 2. What The User Sees

A new view in EDOG Studio sidebar: **Nexus** (network/graph icon).

### 2.1 Topology Map (Primary View)

A live, interactive graph with FLT at the center. Each dependency is a node:

```
                    ┌─────────────┐
                    │  Capacity   │
                    │  Management │
                    └──────┬──────┘
                           │ 12ms avg
    ┌──────────┐    ┌──────┴──────┐    ┌──────────┐
    │  Spark   │────│     FLT     │────│ Platform │
    │  (GTS)   │    │  (local)    │    │   APIs   │
    └──────────┘    └──────┬──────┘    └──────────┘
      230ms avg            │ 8ms avg
                    ┌──────┴──────┐
                    │   Azure     │
                    │   Relay     │
                    └─────────────┘
```

- **Node size** = request volume (bigger = more calls)
- **Edge color** = health (green = healthy, yellow = slow, red = errors)
- **Edge thickness** = throughput
- **Click a node** = expand into detailed panel (latency histogram, error breakdown, recent calls)

### 2.2 Timeline Strip

Horizontal timeline at the bottom showing dependency health over time. Hover to see "at 2:34pm, GTS latency spiked to 1.2s." Correlates with DAG Studio's execution timeline.

### 2.3 Anomaly Alerts

When a dependency's latency or error rate deviates from its baseline:
- Edge turns red/yellow with a pulse animation
- Toast notification: "⚠️ GTS latency 3x above baseline (690ms vs 230ms avg)"
- Integrates with the existing anomaly.js engine

### 2.4 Dependency Detail Panel

Click any dependency node to see:
- Latency percentiles (p50, p95, p99)
- Error rate and error codes
- Recent request/response pairs (like Spark Inspector but for any dependency)
- Retry count (from EdogRetryInterceptor data)
- Call pattern (burst? steady? periodic?)

---

## 3. How It Works (Architecture)

### 3.1 Data Source: Existing Interceptors

The data is *already being captured* — it just needs classification and routing:

| Interceptor | What It Captures | Nexus Classification |
|-------------|-----------------|---------------------|
| `EdogHttpPipelineHandler` | All outbound HTTP | Primary source — classify by URL pattern |
| `EdogSparkSessionInterceptor` | Spark/GTS calls | → "Spark (GTS)" node |
| `EdogTokenInterceptor` | Token acquisitions | → "Auth (AAD)" node |
| `EdogRetryInterceptor` | Retry attempts | Enrichment — attach retry count to edges |
| `EdogCacheInterceptor` | Cache hits/misses | Enrichment — show cache effectiveness per dependency |
| `EdogFileSystemInterceptor` | File I/O | → "File System" node (optional) |

### 3.2 URL Classification

New module: `nexus-classifier.js` (frontend) or classification in Python backend.

```
URL Pattern                              → Dependency Node
─────────────────────────────────────────────────────────
*/spark/*,  */livysessions/*             → Spark (GTS)
*/capacities/*                           → Capacity Management
*/generatemwctoken, */token              → Auth (AAD/MWC)
*pbidedicated*, *powerbi-df*             → Platform APIs (via Relay)
*/workspaces/*, */lakehouses/*           → Fabric APIs
*/notebooks/*                            → Notebook Execution
Everything else                          → Unknown (flag for classification)
```

### 3.3 SignalR Topic

New topic on the existing SignalR hub: `nexus`

```json
{
  "topic": "nexus",
  "type": "dependency_call",
  "data": {
    "dependency": "spark-gts",
    "method": "POST",
    "url": "/livysessions/123/statements",
    "status": 200,
    "latency_ms": 234,
    "retries": 0,
    "timestamp": "2026-04-21T14:30:00Z",
    "correlation_id": "abc-123"
  }
}
```

### 3.4 Frontend Rendering

Use a lightweight graph library (d3-force or cytoscape.js) for the topology. Keep it consistent with the existing vanilla JS / class-based module pattern. No React, no framework — matches edog-studio conventions.

---

## 4. What Makes This Different

- **Not an external proxy** — data comes from interceptors *inside* the FLT process
- **Not just HTTP capture** — classifies, aggregates, tracks baselines, detects anomalies
- **Not a static diagram** — live topology that changes as your code makes different calls
- **Correlates with existing views** — click a Spark node → opens Spark Inspector filtered to that session. Click a DAG node's dependency → see which DAG step triggered it.

---

## 5. Integration Points

| Existing Feature | Integration |
|-----------------|-------------|
| Spark Inspector (F14) | Nexus "Spark" node deep-links to Spark Inspector |
| DAG Studio (F08) | DAG execution steps annotated with dependency calls |
| Error Intelligence (F12) | Dependency errors feed into error clustering |
| Anomaly Engine (anomaly.js) | Baseline tracking per dependency |
| Chaos Engineering (F24) | Chaos rules can target specific dependencies |
| Top Bar (F05) | Dependency health summary indicator |

---

## 6. Open Questions

- [ ] Should file system calls be a dependency node or noise?
- [ ] How to handle internal FLT-to-FLT calls (e.g., scheduler → controller)?
- [ ] Graph layout: force-directed or fixed positions?
- [ ] Should Nexus show historical data or live-only?
- [ ] Performance: how many concurrent edges before the graph becomes unreadable?

---

## 7. Priority

Medium — not blocking any existing feature, but becomes extremely valuable once Chaos Engineering (F24) is live (chaos rules targeting specific dependencies is powerful). Could also be an excellent onboarding tool ("here's everything FLT talks to").
