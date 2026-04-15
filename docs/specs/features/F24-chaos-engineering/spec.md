# F24: Chaos Engineering Panel — Master Spec

> **Status:** PREP PHASE
> **Owner:** Sana Reeves (Architecture) + Vex (Backend) + Pixel (Frontend)
> **CEO:** Hemant Gupta
> **Rule:** Smallest unit possible. No implementation until every prep item is DONE.

---

## 1. Why This Exists

FLT engineers currently have **no way to test failure scenarios** without:
- Waiting for a real production outage
- Manually breaking PPE resources (and praying they can fix them)
- Writing unit test mocks that don't reflect real behavior
- Asking another team to throttle their endpoint

EDOG Studio already has **11 interceptors running inside FLT's process**. They observe every token acquisition, every HTTP call, every file write, every Spark session, every feature flag evaluation. Today they're read-only — they feed the Runtime View tabs.

The Chaos Engineering Panel **upgrades these observers into actors**. Same interceptors, same positions in the pipeline — but now they can delay, modify, block, redirect, and forge traffic.

**The key insight:** We're not building an external proxy. We're **inside the process**. We have access to the DI container, the auth context, the execution state, and every byte flowing in and out. No other chaos tool in the world has this position.

---

## 2. What The User Sees

The Chaos Panel is a new view in EDOG Studio (5th sidebar item, or a sub-panel inside Runtime). It has 4 sub-views:

### 2.1 Rule Builder
The user creates "chaos rules" — each rule says: "When you see a request matching X, do Y to it."

Example rules a user would create:
- "Delay all OneLake writes by 3 seconds" — tests timeout handling
- "Return 429 for 30% of Spark calls" — tests retry logic under partial failure
- "Replace the MWC token audience from `onelake.dfs` to `api.fabric`" — tests auth validation
- "Drop every 5th request to the Orchestrator" — tests heartbeat resilience
- "Return a 200 with empty JSON body for table listing calls" — tests null handling

The rule builder has:
- **Predicate section:** match by URL pattern (regex/glob), HTTP method, header values, body content, named HttpClient, request direction (outbound/inbound), probability (0-100%)
- **Action section:** delay (ms), modify status code, modify headers, modify body (JSONPath), redirect URL, block (return error), forge response (full replacement)
- **Lifecycle section:** max firings (fire N times then auto-disable), duration (active for N minutes), schedule (enable at specific time)
- **Safety section:** kill switch (Ctrl+Shift+K disables ALL rules instantly), auto-disable if FLT process CPU >90%, undo last rule

### 2.2 Active Rules List
Shows all active rules with:
- Rule name + description
- Match count (how many times it's fired)
- Last fired timestamp
- Enable/disable toggle (instant, no restart)
- Visual indicator: green = active, amber = rate-limited, red = error, grey = paused

### 2.3 Traffic Monitor
A live stream of all HTTP traffic flowing through FLT, showing:
- Timestamp
- Method + URL (truncated, expandable)
- Status code (color-coded: 2xx green, 4xx amber, 5xx red)
- Duration (ms)
- Which rules matched this request (if any)
- Which interceptor processed it
- Click to expand: full headers, body preview, timing breakdown

This is Burp Suite's HTTP History tab — but running inside the service process.

### 2.4 Recording & Playback
- One-click "Start Recording" — captures all traffic to a HAR-like file
- Stop recording → browse the captured traffic
- Export as HAR 1.2 (importable in Chrome DevTools)
- Compare two recordings ("before my change" vs "after my change")
- Import a recording as a mock data source (response cache mode)

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    EDOG Studio (Browser)                  │
│                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │Rule      │ │Active    │ │Traffic   │ │Recording │   │
│  │Builder   │ │Rules     │ │Monitor   │ │Viewer    │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
│       └──────┬──────┴──────┬─────┴──────┬──────┘         │
│              │   SignalR   │            │                 │
│              │ /hub/playground          │                 │
└──────────────┼─────────────────────────┼─────────────────┘
               │                         │
┌──────────────┼─────────────────────────┼─────────────────┐
│              ▼     FLT Process         ▼                 │
│  ┌─────────────────────────────────────────────┐         │
│  │           ChaosRuleEngine                    │         │
│  │  ┌───────────────┐  ┌───────────────┐       │         │
│  │  │ RuleStore     │  │ RuleEvaluator │       │         │
│  │  │ (immutable    │  │ (lock-free    │       │         │
│  │  │  snapshots)   │  │  matching)    │       │         │
│  │  └───────┬───────┘  └───────┬───────┘       │         │
│  └──────────┼──────────────────┼───────────────┘         │
│             │                  │                          │
│  ┌──────────▼──────────────────▼───────────────┐         │
│  │      EdogHttpPipelineHandler.SendAsync()     │         │
│  │                                               │         │
│  │  1. Capture request metadata                  │         │
│  │  2. engine.EvaluateRequest(request)           │         │
│  │     → Match? Apply pre-actions               │         │
│  │       (delay, modify, block, redirect)       │         │
│  │  3. base.SendAsync(request)                  │         │
│  │     → Forward to real service (or not)       │         │
│  │  4. engine.EvaluateResponse(response)         │         │
│  │     → Match? Apply post-actions              │         │
│  │       (modify status, mutate body, delay)    │         │
│  │  5. Publish to SignalR (traffic event)        │         │
│  │  6. Return response to FLT                   │         │
│  └───────────────────────────────────────────────┘         │
│             │                                              │
│             ▼                                              │
│  ┌─────────────────┐  ┌──────────┐  ┌──────────────┐     │
│  │ OneLake DFS     │  │ Spark/GTS│  │ Fabric API   │     │
│  └─────────────────┘  └──────────┘  └──────────────┘     │
└────────────────────────────────────────────────────────────┘
```

### 3.1 Zero-Overhead Fast Path

When no chaos rules are active (99% of the time), the engine adds ZERO overhead:

```csharp
// In EdogHttpPipelineHandler.SendAsync():
if (!ChaosRuleEngine.HasActiveRules)  // volatile bool, branch-predicted true
{
    return await base.SendAsync(request, ct);  // fast path: no evaluation
}
```

### 3.2 Rule Evaluation (when rules ARE active)

Rules are stored in an **immutable snapshot** — the evaluator reads a snapshot reference (single volatile read, no lock) and iterates rules sequentially. For N rules:
- Best case: O(1) — first predicate fails fast (URL prefix check)
- Worst case: O(N) — all predicates evaluated
- Expected: N < 10 active rules, each with 1-2ms evaluation = ~10ms overhead max

### 3.3 Safety

- **Ctrl+Shift+K** — global kill switch, disables ALL rules, clears the snapshot, logged
- **Auto-disable** — if FLT process throws an unhandled exception while rules are active, ALL rules auto-disable
- **Max firings** — each rule has a configurable max (default: unlimited, but user can set 1, 10, 100)
- **Duration** — rules can have a TTL: "active for 5 minutes then auto-disable"
- **Audit log** — every rule creation, modification, activation, deactivation, and firing is logged with timestamp and user context

---

## 4. Folder Structure

```
F24-chaos-engineering/
├── spec.md                          ← YOU ARE HERE (master spec + product vision)
├── interceptor-audit.md             ← P0.1+P0.2: what we intercept + FLT traffic map
├── engine-design.md                 ← P0.3+P2: rule engine architecture
├── signalr-protocol.md              ← P2.5: frontend ↔ engine messages
├── categories/                      ← Deep spec per category
│   ├── C01-request-surgery.md       ← Modify outbound requests
│   ├── C02-response-forgery.md      ← Modify inbound responses
│   ├── C03-traffic-control.md       ← Delay, block, throttle, reorder
│   ├── C04-security-probing.md      ← Auth testing, scope mapping
│   ├── C05-observability.md         ← Recording, diffing, graphing
│   └── C06-advanced.md              ← DSL, replay, fuzzing
├── states/                          ← State matrices per UI component
│   ├── panel-shell.md               ← Panel open/close/resize
│   ├── rule-builder.md              ← Rule CRUD states (15-20 states)
│   ├── rule-list.md                 ← Active rules list states
│   ├── traffic-monitor.md           ← Live traffic view states
│   └── recording.md                 ← Recording lifecycle states
└── mocks/                           ← CEO-reviewable interactive HTML
    ├── chaos-panel-shell.html       ← Panel layout + nav
    ├── rule-builder.html            ← Rule creation form
    ├── traffic-monitor.html         ← Live traffic stream
    └── recording-viewer.html        ← HAR playback
```

---

## 5. Category Overview

Each category gets its own deep spec. Here's the summary — depth is in the category files.

### C01: Request Surgery (modify outbound requests)

**What:** Change what FLT sends to external services before it leaves the process.

**Why:** Test how external services handle unexpected inputs. Test FLT's error handling when services reject modified requests.

**Scenarios (preview):**
| ID | Name | One-liner |
|----|------|-----------|
| RS-01 | Latency Injection | Add N ms delay before forwarding any matching request |
| RS-02 | URL Path Rewrite | Change the OneLake path: `/lakehouseA/` → `/lakehouseB/` |
| RS-03 | Body Mutation | Modify JSON body fields via JSONPath before sending |
| RS-04 | Header Injection | Add/remove/modify HTTP headers |
| RS-05 | Auth Header Strip | Remove Authorization header entirely |
| RS-06 | Auth Token Swap | Replace Bearer with MWC or vice versa |
| RS-07 | Method Override | Change GET to POST, POST to PUT |
| RS-08 | Query Param Injection | Add `?timeout=1ms` or `?maxResults=1` |
| RS-09 | Content-Type Swap | Change application/json to text/plain |
| RS-10 | Request Cloning | Forward to real service AND a shadow endpoint |

### C02: Response Forgery (modify inbound responses)

**What:** Change what FLT receives from external services before FLT's code processes it.

**Why:** Test FLT's deserialization, null handling, error handling, and recovery logic.

**Scenarios (preview):**
| ID | Name | One-liner |
|----|------|-----------|
| RF-01 | Status Code Flip | Return 200→500, 500→200, 200→429 |
| RF-02 | Body Field Mutation | Change `"rowCount": 1000` → `"rowCount": 0` via JSONPath |
| RF-03 | Full Response Forge | Return a completely fabricated response |
| RF-04 | Schema Surprise | Add unexpected fields, remove expected fields, change types |
| RF-05 | Pagination Loop | Modify nextLink to loop back to page 1 |
| RF-06 | Empty Body | Return 200 with empty body or `null` |
| RF-07 | Truncated Response | Return first N bytes then close connection |
| RF-08 | Encoding Mangling | Return UTF-16 body with UTF-8 Content-Type |
| RF-09 | Stale Response | Return a cached response from a previous call |
| RF-10 | Slow Drip | Trickle response body at 1KB/sec |

### C03: Traffic Control (delay, block, throttle)

**What:** Control the flow of traffic without modifying content.

**Why:** Test timeout handling, retry logic, circuit breakers, and degraded-mode behavior.

**Scenarios (preview):**
| ID | Name | One-liner |
|----|------|-----------|
| TC-01 | Blackhole | Drop matching requests entirely (no response) |
| TC-02 | Selective Blackhole | Drop requests matching URL pattern, pass everything else |
| TC-03 | Bandwidth Throttle | Limit response throughput to N KB/sec |
| TC-04 | Connection Reset | Return TCP RST after N bytes |
| TC-05 | 429 Storm | Return 429 with configurable Retry-After |
| TC-06 | 503 Outage | Return 503 for all calls to a specific service |
| TC-07 | Intermittent Failure | Fail N% of requests randomly |
| TC-08 | Request Queue | Hold requests for N seconds then release all at once |
| TC-09 | Reverse Priority | Slow down fast requests, speed up slow ones |
| TC-10 | Connection Pool Drain | Hold connections open without releasing |

### C04: Security Probing (auth & access testing)

**What:** Test authentication and authorization boundaries.

**Why:** Find security gaps, validate token handling, map the access surface.

**Scenarios (preview):**
| ID | Name | One-liner |
|----|------|-----------|
| SP-01 | Token Downgrade | Replace strong token (MWC) with weaker (Bearer) |
| SP-02 | Token Expiry | Force-set token expiry to NOW |
| SP-03 | Cross-Tenant Token | Inject token with different tenant ID |
| SP-04 | Scope Reduction | Remove scopes from token claims |
| SP-05 | Access Matrix Builder | Auto-probe every endpoint with every token type, build matrix |
| SP-06 | Auth Header Fuzzing | Send malformed Authorization headers |
| SP-07 | Certificate Validation | Test TLS cert rejection behavior |
| SP-08 | CORS Probing | Inject permissive CORS headers in responses |

### C05: Observability (recording & analysis)

**What:** Capture, record, compare, and visualize HTTP traffic.

**Why:** Debug issues, detect regressions, understand dependencies.

**Scenarios (preview):**
| ID | Name | One-liner |
|----|------|-----------|
| OB-01 | HAR Recording | Record all traffic, export as HAR 1.2 |
| OB-02 | Traffic Diff | Compare traffic before/after a code change |
| OB-03 | Dependency Graph | Auto-build visual map of all external services |
| OB-04 | Regression Detection | Alert when traffic patterns deviate from baseline |
| OB-05 | Latency Heatmap | Visual heatmap of response times per endpoint |
| OB-06 | Error Rate Dashboard | Real-time error rate per service/endpoint |
| OB-07 | Payload Size Tracker | Monitor request/response sizes over time |
| OB-08 | Request Correlation | Link requests to the FLT code path that made them |

### C06: Advanced (DSL, replay, fuzzing)

**What:** Power-user features for deep testing.

**Why:** Enable sophisticated chaos scenarios that combine multiple capabilities.

**Scenarios (preview):**
| ID | Name | One-liner |
|----|------|-----------|
| AD-01 | Chaos DSL | Write rules as code: `WHEN url ~ /spark/ AND method == POST THEN delay 5s FOR 30%` |
| AD-02 | Response Cache Mode | Serve recorded responses, making FLT work "offline" |
| AD-03 | Cascading Failure Sim | Define failure chains: "if OneLake fails → token refresh → Spark timeout" |
| AD-04 | Bit-Flip Fuzzer | Randomly flip bits in response bodies |
| AD-05 | Preset Scenarios | One-click: "Simulate OneLake outage", "Simulate Spark shortage" |
| AD-06 | Rule Composition | Combine rules: "delay 2s AND inject 429 AND corrupt body" |
| AD-07 | Scheduled Chaos | "At 2:30 PM, enable rule X for 5 minutes" |
| AD-08 | Waterfall Timeline | Chrome DevTools-style waterfall for all requests in a DAG execution |

---

## 6. Prep Checklist

### Phase 0: Foundation Research

| # | Task | Owner | Output | Depends On | Status |
|---|------|-------|--------|-----------|--------|
| P0.1 | Interceptor Audit — what we intercept, what we can modify | Vex | `interceptor-audit.md` § 1 | — | 🔄 IN PROGRESS |
| P0.2 | FLT HTTP Traffic Map — every outbound call from CLEAN source | Vex | `interceptor-audit.md` § 2 | — | 🔄 IN PROGRESS |
| P0.3 | Rule Engine Study — Burp/mitmproxy/Charles/Gremlin patterns | Sana | `engine-design.md` § 1 | — | 🔄 IN PROGRESS |

### Phase 1: Category Deep Specs

Each spec must contain per scenario:
- Name + one-liner + detailed description
- **ChaosRule JSON** — exact rule the user creates
- **C# mechanism** — how the DelegatingHandler implements it
- **FLT code path** — file:line from CLEAN source that's affected
- **Edge cases** — what can go wrong with this rule
- **Interactions** — conflicts with other rules
- **Revert** — how to undo
- **Priority** — P0/P1/P2

| # | Category | Output | Scenarios | Depends On | Status |
|---|----------|--------|-----------|-----------|--------|
| P1.1 | Request Surgery | `categories/C01-request-surgery.md` | 10 | P0.1, P0.2 | ✅ DONE |
| P1.2 | Response Forgery | `categories/C02-response-forgery.md` | 10 | P0.1, P0.2 | ⬜ |
| P1.3 | Traffic Control | `categories/C03-traffic-control.md` | 10 | P0.1, P0.2 | ✅ DONE |
| P1.4 | Security Probing | `categories/C04-security-probing.md` | 8 | P0.1, P0.2 | ⬜ |
| P1.5 | Observability | `categories/C05-observability.md` | 8 | P0.1, P0.2 | ⬜ |
| P1.6 | Advanced | `categories/C06-advanced.md` | 8 | P0.1-P1.5 | ✅ DONE |

### Phase 2: Engine Architecture

| # | Task | Owner | Output | Depends On | Status |
|---|------|-------|--------|-----------|--------|
| P2.1 | ChaosRule JSON Schema | Sana | `engine-design.md` § 2 | P0.3, P1.1-P1.6 | ⬜ |
| P2.2 | Rule Evaluation Engine | Sana | `engine-design.md` § 3 | P2.1 | ⬜ |
| P2.3 | Rule Store (CRUD, persistence, hot-reload) | Vex | `engine-design.md` § 4 | P2.1 | ⬜ |
| P2.4 | Safety Mechanisms | Sana | `engine-design.md` § 5 | P2.2 | ⬜ |
| P2.5 | SignalR Protocol (messages, topics, events) | Vex | `signalr-protocol.md` | P2.1 | ✅ DONE |

### Phase 3: State Matrices

Each matrix lists: every state, every transition, every trigger, every visual, every error.

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P3.1 | Panel Shell | `states/panel-shell.md` | 15 | P2.5 | ✅ DONE |
| P3.2 | Rule Builder | `states/rule-builder.md` | 15-20 | P2.1 | ⬜ |
| P3.3 | Rule List | `states/rule-list.md` | 10-12 | P2.1 | ⬜ |
| P3.4 | Traffic Monitor | `states/traffic-monitor.md` | 10-12 | P2.5 | ⬜ |
| P3.5 | Recording | `states/recording.md` | 8-10 | P2.5 | ✅ |

### Phase 4: Interactive Mocks

CEO reviews and approves before ANY implementation begins.

| # | Mock | Output | Depends On | Status |
|---|------|--------|-----------|--------|
| P4.1 | Panel Shell | `mocks/chaos-panel-shell.html` | P3.1 | ⬜ |
| P4.2 | Rule Builder | `mocks/rule-builder.html` | P3.2 | ⬜ |
| P4.3 | Traffic Monitor | `mocks/traffic-monitor.html` | P3.4 | ⬜ |
| P4.4 | Recording Viewer | `mocks/recording-viewer.html` | P3.5 | ⬜ |

---

## 7. Implementation Order (AFTER all prep is done)

```
Layer 0: ChaosRuleEngine C# class (rule model + store + evaluator)
Layer 1: Upgrade EdogHttpPipelineHandler (integrate engine into SendAsync)
Layer 2: SignalR messages (rule CRUD + traffic events)
Layer 3: Frontend panel shell + rule list
Layer 4: Rule builder UI
Layer 5: Traffic monitor UI  
Layer 6: Category-specific actions (one PR per category)
Layer 7: Recording + HAR export
Layer 8: Advanced features (DSL, presets, scheduled chaos)
```

Each layer is independently testable. Each layer is one commit.

---

## 8. Success Criteria

An FLT engineer opens the Chaos Panel and within 30 seconds:
1. Creates a rule: "Delay OneLake writes by 3 seconds"
2. Runs a DAG
3. Sees the delay reflected in the traffic monitor
4. Sees the DAG take longer
5. Disables the rule
6. Runs the DAG again — back to normal

That's the MVP. Everything else builds on top.

---

*"The observer becomes the actor."*
