# F27 QA Testing — Viability Analysis

> Decision record from architecture viability discussion (2026-05-09).
> Covers: code understanding engine architecture, stimulus delivery problem, expectation generation gap.

---

## 1. Five-Layer Code Understanding Engine

The code understanding engine is the core intelligence behind F27. It answers two questions:
1. **What to trigger** (stimulus generation) — given a PR diff, which entry points exercise the changed code?
2. **What to expect** (expectation generation) — what should happen when that code runs correctly?

### Architecture

| Layer | Tool | Role | Speed | C# Semantic Depth |
|-------|------|------|-------|-------------------|
| L1 | **code-review-graph** (16K⭐) | Structural blast radius via recursive SQL CTE BFS | Instant (<1s) | Syntax only — no DI, no interfaces |
| L2 | **Graphify** (45K⭐) | Knowledge graph with NetworkX, community detection, field refs | Instant (<2s) | Syntax only — ambiguous cross-file resolution |
| L3 | **OmniSharp / Roslyn** | Semantic enrichment — call hierarchy, find implementations, type resolution | ~15-30s warm-up, then fast | Full semantic — DI, generics, interfaces, LINQ |
| L4 | **GPT-5.4-pro** | LLM reasoning over graph + semantic data | ~5-10s per query | Reads and understands C# idioms, infers intent |
| L5 | **Runtime DI Registry** (`EdogDiRegistryCapture.cs`) | Ground truth for interface→implementation mappings as actually registered | Connected phase only | Actual runtime registrations |

### Why Five Layers?

No single tool is sufficient:

- **L1+L2 alone:** Fast structural graph, but can't resolve `IRetryPolicy` → `ExponentialRetryPolicy`. Misses DI-injected call paths. ~70-80% accuracy on blast radius.
- **L3 alone (Roslyn):** Full semantic accuracy, but slow to initialize. Needs the .sln loaded. Overkill for simple direct-call graphs.
- **L4 alone (LLM):** Can reason about code, but hallucinates without grounded graph data. Needs structured input.
- **L5 alone (Runtime DI):** Only gives you registrations, not call paths or business logic.

**Together:** L1+L2 provide the structural skeleton fast. L3 fills in semantic edges (interface dispatch, generic resolution). L4 reasons about the combined data to generate test scenarios. L5 provides ground-truth validation for DI assumptions.

**Coverage estimate:** ~95%+ of meaningful code paths for typical PRs.

### Data Flow

```
PR Diff
  │
  ├─► L1: code-review-graph → structural blast radius (files, functions, edges)
  ├─► L2: Graphify → knowledge graph (communities, field references, inheritance)
  │         │
  │         ▼
  │   Merged Graph (structural)
  │         │
  │         ▼
  ├─► L3: OmniSharp → semantic enrichment (resolve interfaces, call hierarchy, type info)
  │         │
  │         ▼
  │   Enriched Graph (structural + semantic)
  │         │
  │         ▼
  ├─► L5: Runtime DI → validate/supplement interface→impl mappings
  │         │
  │         ▼
  │   Validated Graph (structural + semantic + runtime truth)
  │         │
  │         ▼
  └─► L4: GPT-5.4-pro → reason over validated graph
            │
            ├─► Stimulus suggestions (which entry points to trigger)
            └─► Expectation suggestions (what should happen)
```

### OmniSharp Integration Detail

OmniSharp is a Roslyn-based language server. EDOG already runs inside a .NET process (FLT), so the infrastructure is native.

**Launch:** Background process against the FLT `.sln` file.
**Protocol:** LSP (Language Server Protocol) over stdin/stdout.
**Key queries used:**
- `callHierarchy/incomingCalls` — who calls this method? (reverse call graph)
- `callHierarchy/outgoingCalls` — what does this method call?
- `textDocument/implementation` — which classes implement this interface?
- `textDocument/references` — who uses this symbol?
- `textDocument/definition` — resolve a symbol to its definition

**Warm-up:** ~15-30s to load and analyze a typical FLT solution. Runs once when Connected phase starts. After warm-up, individual queries are <500ms.

---

## 2. The Stimulus Delivery Problem

### What is a Stimulus?

A test has two parts: **do something** (stimulus) + **check what happened** (expectation).

- **Stimulus** = the action that makes code run. Without it, expectations sit idle with nothing to observe.
- **Expectation** = pattern-match against intercepted events to verify behavior.

### Stimulus Types (from spec §5.2)

| Type | Mechanism | When applicable |
|------|-----------|-----------------|
| `http_request` | EDOG sends HTTP to FLT's Kestrel endpoints | PR touches API/controller code |
| `signalr_invoke` | Invoke hub method on EdogPlaygroundHub | PR touches real-time features |
| `dag_trigger` | `POST /liveTableSchedule/runDAG/{id}` | PR touches DAG/scheduling code |
| `file_event` | Write file to watched OneLake path | PR touches file-triggered flows |
| `timer_tick` | Advance/wait for scheduled tick | PR touches timer-based code |
| `direct_invoke` | Resolve service from DI, call method directly | PR touches internal service (no HTTP entry point) |

### The Hard Question

**How does the system automatically determine which stimulus triggers the code path that a PR changed?**

This is a **reverse call-graph traversal problem:**

```
Changed code: RetryPolicy.cs → ExponentialRetryPolicy.Execute()
    ▲ called by
OneLakeWriter.WriteAsync()
    ▲ called by
DagExecutionEngine.ExecuteNode()
    ▲ called by
DagController.RunDAG()  ← THIS is the entry point
    ▲ triggered by
POST /liveTableSchedule/runDAG/{id}  ← THIS is the stimulus
```

**What makes it hard:**

1. **Interface indirection** — `RetryPolicy` is used via `IRetryPolicy`. Without Roslyn (L3), you can't trace through the interface to find callers.

2. **DI resolution** — `OneLakeWriter` gets `IRetryPolicy` injected. Without Runtime DI (L5), you don't know which implementation is wired.

3. **Conditional reachability** — Some code only runs under failure conditions (catch blocks, retry paths, circuit breaker trips). The LLM (L4) needs to reason: "this code is in a catch block for TimeoutException, so I need to inject a timeout to exercise it."

4. **Multiple entry points** — Changed code might be reachable from 5 different API endpoints. Which one is the best stimulus? LLM (L4) picks the most direct path.

### Solution: Reverse Call-Graph + LLM Reasoning

```
Step 1: L3 (Roslyn) — callHierarchy/incomingCalls from changed method
         → gives chain: RetryPolicy ← OneLakeWriter ← DagEngine ← DagController

Step 2: L5 (Runtime DI) — confirm IRetryPolicy is actually wired to ExponentialRetryPolicy
         → validates the chain is real, not just theoretically possible

Step 3: L4 (LLM) — analyze the chain:
         - Identify the top-level entry point (DagController.RunDAG)
         - Map it to a stimulus type (http_request: POST /runDAG/{id})
         - Detect if conditional reachability applies (catch block? → need chaos rule)
         - Generate the full stimulus specification with args
```

### Three Approaches to Stimulus Delivery

| Approach | How it works | Accuracy | User effort | Day-one? |
|----------|-------------|----------|-------------|----------|
| **User-triggered** | User manually clicks in FLT UI, EDOG observes | 100% (user knows what to do) | High — every run | Fallback |
| **AI-generated** | Engine traces reverse call graph, generates stimulus automatically | ~85-90% (may miss edge cases) | None after setup | Aspirational |
| **Hybrid** | AI suggests stimulus, user confirms/adjusts in curation UI | ~95% (AI + human review) | Low — review & approve | ✅ Day one |

**Decision: Hybrid approach for day one.**

The scenario curation UI (already mocked) shows AI-generated stimulus suggestions. User reviews, adjusts parameters if needed, confirms. Over time, as confidence grows, user can "auto-approve" known-good stimulus patterns.

---

## 3. The Expectation Generation Gap

### Structural Observation vs. Correctness Verification

Current interceptors capture **what happened** (events-in-flight):
- "SQL query fired with this text, returned 5 rows"
- "HTTP request sent to X, got 200 back"
- "Retry happened 3 times with exponential backoff"

But interceptors alone don't tell you **if it was correct**:
- "Were those the RIGHT 5 rows?"
- "Was the response body the correct shape?"
- "Should it have retried 3 times, or is 3 wrong?"

### What Defines "Correct"?

| Knowledge needed | Source |
|------------------|--------|
| Expected retry count | LLM reads `RetryPolicy` config → "maxRetries = 3" |
| Expected response shape | LLM reads controller return type → `ActionResult<DagStatus>` |
| Expected query behavior | LLM reads LINQ expression → "filters where TenantId = X" |
| Expected status after execution | LLM reads state machine → "node transitions to Completed" |
| Expected timing bounds | LLM reads timeout config → "must complete within 30s" |

**Key insight:** The same five-layer engine that generates stimuli also generates expectations. The LLM reads the code, understands what it SHOULD do, and formulates expectations that verify it.

### The Return Value Gap

Current interceptors capture:
- ✅ Method invocation (fact that it was called)
- ✅ Arguments passed in
- ✅ Duration
- ✅ Exception thrown (if any)
- ❌ **Return value** (what did it return?)

For full correctness verification, we need one extension to the interceptor infrastructure:

**Return Value Capture** — when intercepting a method, also capture what it returned.

```csharp
// Current interceptor captures:
public record InterceptorEvent {
    string Topic;
    string Method;
    object[] Arguments;
    TimeSpan Duration;
    Exception? Error;
}

// Extended with return value:
public record InterceptorEvent {
    string Topic;
    string Method;
    object[] Arguments;
    TimeSpan Duration;
    Exception? Error;
    object? ReturnValue;     // ← NEW: what did it return?
    Type? ReturnType;        // ← NEW: static return type
}
```

This is not a new interceptor — it's an extension of the existing infrastructure. The interception mechanism already wraps method calls; capturing the return value is a small addition.

### Expectation Categories (with return value capture)

| Category | What it checks | Example |
|----------|---------------|---------|
| **Structural** | Event fired | "SQL interceptor captured a query" |
| **Value** | Specific data in event | "Query text contains 'WHERE TenantId ='" |
| **Count** | Number of occurrences | "Retry topic has exactly 3 events" |
| **Sequence** | Order of events | "DI resolution before HTTP call before SQL query" |
| **Timing** | Duration bounds | "Total execution < 5000ms" |
| **Return** | Method returned expected value | "GetStatus() returned 'Completed'" |
| **Absence** | Something did NOT happen | "No error events in Exception topic" |
| **State** | Before/after comparison | "After execution, cached value updated" |

### How LLM Generates Expectations

```
Input to LLM:
- PR diff (what changed)
- Enriched call graph (what's connected)
- Method signatures + return types (from Roslyn)
- Config values (from code reading)

LLM reasons:
- "This method has return type bool — it should return true on success"
- "The retry config says maxRetries=3 — expect exactly 3 retry events on failure"
- "The controller returns ActionResult<DagStatus> — expect response body has status field"
- "This is a write operation — expect SQL INSERT event"

Output:
- List of typed expectations with expected values
```

---

## 4. Viability Verdict

### Solved Problems (High Confidence)

| Component | Why it works |
|-----------|-------------|
| Observation layer | ✅ Already built — 16 interceptors, TopicEvent, TopicBuffer, TopicRouter |
| Event transport | ✅ Already built — SignalR live streaming |
| Structural blast radius | ✅ code-review-graph + Graphify, instant |
| Semantic analysis | ✅ OmniSharp/Roslyn, full C# support |
| DI resolution | ✅ Runtime DI registry, ground truth |
| LLM reasoning | ✅ GPT-5.4-pro, proven on C# code |
| Assertion engine | ✅ Pattern matching on interceptor events, straightforward |
| Chaos integration | ✅ F24 already provides fault injection |

### Hard But Solvable (Medium Confidence)

| Component | Challenge | Mitigation |
|-----------|-----------|------------|
| Stimulus generation | Reverse call-graph + conditional reachability | Hybrid approach — AI suggests, user confirms |
| Expectation generation | Knowing "correct" values | LLM reads code + config, user validates |
| Return value capture | Extending interceptor infra | Small addition to existing mechanism |
| Multi-step scenarios | Ordering stimuli, waiting between | Sequential execution engine (spec §5.4) |

### Remaining Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| OmniSharp warm-up time (~15-30s) | UX delay on first use | Pre-warm on Connected phase start, cache results |
| LLM hallucination on expectations | False positives/negatives | User curation step, confidence scores |
| Large PRs (100+ files) | Graph explosion | Focus on high-impact nodes, community detection (Graphify) |
| Untestable code (no clear entry point) | Some code can't be stimulated | Flag as "manual verification required" |

### Final Assessment

**The feature is viable for day-one ship.** The five-layer engine provides sufficient intelligence for the hybrid (AI-suggests, user-confirms) approach. The interceptor infrastructure is already built. The hardest part (stimulus generation) is solved by Roslyn's call hierarchy + LLM reasoning + user curation as safety net.

**One new capability needed:** Return value capture in interceptors (small extension, not new infrastructure).

**Architecture principle:** Graph tools for speed, Roslyn for accuracy, LLM for reasoning, runtime for truth, user for validation. Each layer compensates for the others' weaknesses.
