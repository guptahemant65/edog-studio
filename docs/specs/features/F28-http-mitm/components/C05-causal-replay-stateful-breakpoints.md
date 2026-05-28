# F28 · C05 — Causal Replay & Stateful Breakpoints

> **Author:** Sana (architecture)
> **Status:** P1 component deep spec — draft 1
> **Parent feature:** [F28 HTTP MITM](../spec.md) · [P0 research](../research/p0-foundation.md) §6.1, §6.2
> **Sibling components:** C01 Coordinator · C02 Rule Store · C03 Detail Tab UI · C04 Replay Composer
> **Implements:** Tier-1 "wow" features — Causal Replay (§6.1) and Stateful Breakpoint Conditions (§6.2)

---

## 0. TL;DR

C05 is the two-headed differentiator of F28. Both heads share one substrate — a per-request **CausalContext** built from cross-topic correlation — and split into two consumption surfaces:

| Head | Surface | Purpose |
|---|---|---|
| **A — Causal Replay** | HTTP detail panel, new "Causal Chain" sub-tab | Show the user *why* this request happened (DAG node, retry, flag, token, dependency) and let them mutate one variable and replay. |
| **B — Stateful Breakpoints** | Intercept tab rule editor + global toolbar | Author breakpoint conditions that reference FLT internal state (`state.retryCount > 2`, `state.flag('X') == true`, ...). Evaluated inside `MitmCoordinator` on every match candidate. |

**The shared substrate** is `CausalContextResolver` (server-side) — a service that, given an HTTP `correlationId` + `httpClientName` + `iterationId` + timestamp, joins across the `dag`, `retry`, `token`, `flag`, and `nexus` topic ring buffers and returns a `CausalContext` snapshot. Head A renders the snapshot. Head B exposes its accessors to a DSL evaluator.

**Why not just one head?** They share ~70% of the backend (the join engine, the AsyncLocal context propagation, the wire model) but diverge entirely on the frontend (visualization vs. expression authoring) and on the dispatch path (one-shot replay vs. per-request gate). Splitting them keeps the spec navigable; merging them in code is the engineering goal.

**Critical reality check** the P0 doc glosses over: **not every upstream topic carries `correlationId`.**

| Topic | Has `correlationId`? | Available join keys |
|---|---|---|
| `http` | ✅ (extracted from `x-ms-correlation-id` / `x-ms-request-id` / `x-ms-client-request-id` / `Request-Id` — `EdogHttpPipelineHandler.cs:332–349`) | + `httpClientName`, request URL, request timestamp |
| `retry` | ❌ | `iterationId`, `endpoint` (substring), `strategyName` — `EdogRetryInterceptor.cs:192–204` |
| `dag` | ❌ | `iterationId`, `nodeId`, `dagId` — `EdogDagExecutionInterceptor.cs:167–204` |
| `token` | ❌ | `httpClientName`, `endpoint` (path-and-query) — `EdogTokenInterceptor.cs:65–75` |
| `flag` | ❌ | flag name only; **no scoping at all** — `EdogFeatureFlighterWrapper.cs:88–103` |
| `nexus` | n/a (classifier, not a topic in the traditional sense) | URL → `DependencyId` via regex — `EdogNexusClassifier.cs:93–101, 140` |

So the join is **not** a SQL `JOIN ON correlationId`. It is a hybrid: deterministic where keys overlap, **temporal-window proximity match** where they do not, and **stack-walk / AsyncLocal capture** where neither works. S01 is honest about which is which and the UI labels the confidence of each row (`derived` / `correlated` / `temporal-match`).

---

## 1. Scope, Non-Goals, Open Questions

### In scope

- Build a `CausalContext` for any HTTP event the user clicks (Head A) or for any in-flight intercepted request (Head B).
- Render Head A as a vertical timeline in the HTTP detail panel.
- Allow per-variable mutation (toggle flag, force-expire token, change retry count) and dispatch a one-shot replay through the same handler chain.
- Author breakpoint conditions in a small DSL with ~8 state accessors.
- Evaluate conditions at MitmCoordinator decision-time with a per-request budget of **< 1ms**.

### Non-goals

- **NOT** a full SQL-like query language. Conditions are accessor → operator → literal triples joined by `&&` / `||` / `!`. No subqueries, no group-by.
- **NOT** retroactive replay against a captured response body. Replay always goes through the real `HttpClient` (modulo MITM rules). For "use the captured response" use C04 Time-Travel Forgery (§6.4).
- **NOT** mutation of remote state. Flag mutation flips the in-process `EdogFeatureOverrideStore`; we never touch the upstream flag service.
- **NOT** capture of FLT state outside the topic ring buffers. If the topic doesn't have it, the accessor returns `null`.

### Open questions (carried into P2 design)

| Q | Resolution path |
|---|---|
| Should `state.flag(name)` evaluate the **flighter live** (calling `IFeatureFlighter.IsEnabled` reflectively) or read the last published value from the `flag` topic? Live is correct; topic-read is fast. | Default: topic-read for the breakpoint hot path (cached on `CausalContext` build, no extra call per condition eval). Provide `state.flagLive(name)` as opt-in for accuracy. |
| When two `dag.NodeStarted` events bracket an HTTP call (parallel DAG nodes — `parallelLimit` in `EdogDagExecutionInterceptor.cs:102`), which node "caused" it? | Pick the most recent `NodeStarted` on the same `iterationId` whose `NodeCompleted` has not yet been published. Surface ambiguity as a multi-node array `state.dagNodeNames` when count > 1. |
| Should replay-with-mutations also patch the *response*, or only the request and ambient state? | v1: request + ambient (flag/token/retry-count). Response patching is C04's territory. |
| Authorization header reveal — does the causal chain render the real token? | No. The chain shows `token.tokenType` + `audience` + redacted `exp/iat`. Token *value* is never exposed by C05; if the user wants to edit Authorization they go through C03's "Reveal" affordance. |

---

## 2. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                          MITM REQUEST PATH                              │
│                                                                          │
│  HttpPipelineHandler.SendAsync                                          │
│       │                                                                  │
│       ├─► CausalContextResolver.Build(req)   ◄── reads dag/retry/      │
│       │       │                                  token/flag/nexus       │
│       │       ▼                                  buffers + AsyncLocal   │
│       │   CausalContext { dag, retry, token, flag, nexus, http }       │
│       │       │                                                         │
│       │       ▼                                                         │
│       ├─► MitmCoordinator.AwaitDecision(req, ctx)                      │
│       │       │                                                         │
│       │       ├─► foreach rule in store:                               │
│       │       │     match urlPattern? → ConditionEvaluator.Eval(       │
│       │       │       rule.condition,   ◄── HEAD B (Stateful BP)       │
│       │       │       ctx) == true?                                    │
│       │       │     → suspend & notify UI                              │
│       │       │                                                         │
│       │       └─► (no match) → base.SendAsync                          │
│       │                                                                 │
│       └─► publish "http" event { ..., causal: ctx.ToWireSummary() }    │
│                                                                          │
│  ┌─── on user click in HTTP tab ────────────────────────────────────┐   │
│  │  RPC: MitmGetCausalChain(eventSequenceId)                        │   │
│  │       ▼                                                            │   │
│  │  CausalChainBuilder.Build(eventSequenceId)                       │   │
│  │       ▼ (rebuild richer chain from current ring snapshots)        │   │
│  │  CausalChainPayload  ────► UI: CausalChainTimeline (HEAD A)      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── on user click "Replay with mutations" ───────────────────────┐    │
│  │  RPC: MitmReplayWithMutations(eventSequenceId, MutationSet)     │    │
│  │       ▼                                                           │    │
│  │  MutationApplier:                                                 │    │
│  │    flag mutation  → EdogFeatureOverrideStore.Set(name, value)    │    │
│  │    token mutation → AsyncLocal<TokenOverride> .Value = ...        │    │
│  │    retry mutation → ignored (informational only)                  │    │
│  │       ▼                                                           │    │
│  │  Re-dispatch request through EdogHttpClientFactoryWrapper        │    │
│  │       ▼                                                           │    │
│  │  publish "http" event with mitm.action = "replay-causal"         │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Files this component touches

| Path | Disposition | Lines (target) |
|---|---|---|
| `src/backend/DevMode/MitmCoordinator.cs` | EXTEND (created in C01) — wire `CausalContext` into decision call | +60 |
| `src/backend/DevMode/CausalContextResolver.cs` | NEW — build CausalContext at request entry | ~280 |
| `src/backend/DevMode/CausalChainBuilder.cs` | NEW — richer post-hoc chain rebuild for UI | ~220 |
| `src/backend/DevMode/MitmConditionEvaluator.cs` | NEW — parser + evaluator + state accessors | ~360 |
| `src/backend/DevMode/MitmCausalAsyncLocal.cs` | NEW — AsyncLocal carriers for DAG/retry context capture | ~80 |
| `src/backend/DevMode/EdogDagExecutionInterceptor.cs` | EXTEND — push to AsyncLocal on NodeStarted/Completed | +30 |
| `src/backend/DevMode/EdogPlaygroundHub.cs` | EXTEND — add `MitmGetCausalChain`, `MitmReplayWithMutations` RPCs | +90 |
| `src/backend/DevMode/EdogHttpPipelineHandler.cs` | EXTEND — call resolver, attach `causal` wire block | +25 |
| `src/frontend/js/causal-chain-timeline.js` | NEW — Head A timeline renderer + mutation controls | ~520 |
| `src/frontend/js/mitm-condition-builder.js` | NEW — Head B expression authoring UI + DSL helper | ~480 |
| `src/frontend/js/tab-http.js` | EXTEND — register "Causal Chain" detail tab, wire RPCs | +60 |
| `src/frontend/css/tab-http.css` | EXTEND — timeline + condition-builder styles | +180 |

### 2.2 The CausalContext wire model

The single canonical shape consumed by both heads, produced server-side, kept stable as a public-ish contract:

```csharp
public sealed class CausalContext
{
    public long HttpSequenceId { get; init; }           // matches TopicEvent.SequenceId
    public string CorrelationId { get; init; }
    public string HttpClientName { get; init; }
    public DateTimeOffset RequestTimestamp { get; init; }

    public DagContext Dag { get; init; }                // null if no DAG active
    public RetryContext Retry { get; init; }            // null if not a retry
    public TokenContext Token { get; init; }
    public FlagContext Flag { get; init; }              // snapshot of relevant flags
    public NexusContext Nexus { get; init; }            // never null — classifier always runs

    public IReadOnlyList<CausalLink> Links { get; init; }  // ordered timeline rows
}

public sealed class CausalLink
{
    public string Source { get; init; }      // "dag" | "retry" | "token" | "flag" | "nexus"
    public string Confidence { get; init; }  // "derived" | "correlated" | "temporal" | "stack"
    public string Summary { get; init; }     // human one-liner
    public IReadOnlyDictionary<string, object> Detail { get; init; }
    public DateTimeOffset? Timestamp { get; init; }
}
```

`CausalLink.Confidence` is the single most important UI affordance: a `temporal` match (two events 47ms apart on different topics) is not the same as a `correlated` match (shared `iterationId`) and the user *must* see which is which.

---

## 3. Head A — Causal Replay: Scenarios

### S01 — Causal chain reconstruction (multi-key + temporal join)

**One-liner.** Given an HTTP event, walk the `dag`, `retry`, `token`, `flag`, and `nexus` ring buffers and assemble an ordered, confidence-tagged `CausalContext`.

**Detailed description.** When the user clicks a row in the HTTP tab and switches to the "Causal Chain" detail tab, the frontend invokes `MitmGetCausalChain(sequenceId)`. The server retrieves the original HTTP `TopicEvent` from the `http` ring buffer (`TopicBuffer.GetSnapshot`, the buffer holds 2000 events — `EdogTopicRouter.cs:34`), then runs five resolvers in parallel, each producing zero or more `CausalLink`s. The links are sorted by timestamp ascending, deduped, and returned.

The five resolvers and their join strategies:

| Resolver | Primary key | Fallback | Confidence label |
|---|---|---|---|
| `ResolveDag` | `iterationId` (carried via `MitmCausalAsyncLocal.CurrentIterationId` — set by the DAG interceptor on `NodeStarted`, cleared on `NodeCompleted`) | none — null if AsyncLocal not set at request entry | `correlated` when AsyncLocal hit, `temporal` if we fall back to scanning `dag` topic for the latest `NodeStarted` within ±500ms with no `NodeCompleted` |
| `ResolveRetry` | `iterationId` + endpoint substring match against request URL | last 2s window on `retry` topic intersecting `httpClientName` | `correlated` for both keys, `temporal` for endpoint-only-by-window |
| `ResolveToken` | `httpClientName` + `endpoint` (path-and-query of request) | most recent `token` event within ±1s on same `httpClientName` | `derived` when extracted live from `request.Headers.Authorization` at handler time (preferred — bypasses topic lookup); `correlated` from token topic |
| `ResolveFlag` | flag-name only, no scoping in topic data | snapshot the last published value for every flag mentioned in the active rule set + any flag referenced by an active scenario | always `temporal` — flags are unscoped in `EdogFeatureFlighterWrapper.cs:88–103` |
| `ResolveNexus` | URL deterministic via `EdogNexusClassifier.Classify("http", httpEvent)` (`EdogNexusClassifier.cs:140–156`) | n/a | always `derived` |

**Live (intercept-time) vs. post-hoc (UI-time) builds.** Two callers, one resolver class:

1. **Live build** (`CausalContextResolver.Build(HttpRequestMessage req, string correlationId)`) runs inside `EdogHttpPipelineHandler.SendAsync` *before* `MitmCoordinator.AwaitDecisionAsync`. Performance budget: **< 250µs**. Only consults AsyncLocal carriers + last-flag-value cache + token-from-Authorization. Skips topic-buffer scans.
2. **Post-hoc build** (`CausalChainBuilder.Build(long sequenceId)`) runs from the hub RPC. Allowed to scan the ring buffers; targets **< 30ms** for the 99th percentile (2000-element scans bounded by topic).

**Technical mechanism.**

```csharp
// src/backend/DevMode/CausalContextResolver.cs (NEW)
internal static class CausalContextResolver
{
    public static CausalContext BuildLive(
        HttpRequestMessage request, string correlationId, string httpClientName)
    {
        var ts = DateTimeOffset.UtcNow;
        var url = request.RequestUri?.AbsoluteUri ?? string.Empty;

        var dag = MitmCausalAsyncLocal.CurrentDagSnapshot();   // AsyncLocal — O(1)
        var retry = MitmCausalAsyncLocal.CurrentRetrySnapshot();
        var token = ResolveTokenFromAuthorization(request);     // direct header parse — O(1)
        var flag = FlagSnapshotCache.Get();                     // last-published cache — O(1)
        var nexus = NexusFromClassify(url, httpClientName);     // regex — O(rules)

        return new CausalContext
        {
            CorrelationId = correlationId,
            HttpClientName = httpClientName,
            RequestTimestamp = ts,
            Dag = dag,
            Retry = retry,
            Token = token,
            Flag = flag,
            Nexus = nexus,
            Links = null,   // links materialised on demand for the wire summary; not needed by evaluator
        };
    }
}

// src/backend/DevMode/CausalChainBuilder.cs (NEW)
internal static class CausalChainBuilder
{
    public static CausalChainPayload Build(long httpSequenceId)
    {
        var httpEvt = TopicBufferLookup.Find("http", httpSequenceId);
        if (httpEvt == null) return CausalChainPayload.NotFound;

        var http = TopicPayloadAdapter.AsHttp(httpEvt);
        var ctx = new CausalContextBuilder(http);

        // Each resolver pushes 0..N CausalLinks
        DagResolver.Resolve(ctx);
        RetryResolver.Resolve(ctx);
        TokenResolver.Resolve(ctx);
        FlagResolver.Resolve(ctx);
        NexusResolver.Resolve(ctx);

        return ctx.Build();
    }
}
```

**Source code paths.**
- New: `src/backend/DevMode/CausalContextResolver.cs` (live, fast path)
- New: `src/backend/DevMode/CausalChainBuilder.cs` (post-hoc, richer)
- Read: `src/backend/DevMode/EdogTopicRouter.cs:74–95` for buffer access pattern
- Read: `src/backend/DevMode/EdogNexusClassifier.cs:140–156` for `ClassifyHttp` reuse

**Edge cases.**
- HTTP event evicted from ring buffer between user click and RPC arrival (>2000 events later). → return `CausalChainPayload.Evicted` with an informational link `"http event no longer in retention window"`.
- AsyncLocal not propagated (HTTP call originated outside DAG executor — e.g., token refresh on app startup). → `Dag = null`; UI omits the row rather than rendering "unknown".
- Multiple `NodeStarted` events on the same `iterationId` not yet closed (parallel DAG nodes — `parallelLimit > 1`). → `Dag.AmbiguousNodes` is set; UI renders a stacked card "one of: Bronze_Sales, Bronze_Orders".
- Token interceptor publishes *after* `base.SendAsync` returns (it runs as a transparent decorator wrapping the call — `EdogTokenInterceptor.cs:42–84`), so during live build the topic does **not** yet have the token event. The live path therefore parses Authorization directly from the request and never depends on the topic for live decisions.
- Same request retried 5 times → 5 separate HTTP events, each with their own causal chain. The chain is per-attempt, not per-logical-call.

**Interactions.**
- C01 MitmCoordinator calls `BuildLive` once per request before condition evaluation. The same `CausalContext` instance is reused across all rule evaluations for that request (immutability is a hard requirement — see S12).
- C03 detail panel calls `MitmGetCausalChain` on tab activation (lazy — not on row click).
- C04 Replay Composer can pre-fill its form from a `CausalChainPayload.HttpSnapshot` via "Replay from here" in the timeline.
- F24 chaos panel can render the same payload if it adds a "Causal context" sub-view later. No duplication.

**Revert/undo.** Read-only operation. Nothing to undo.

**Priority.** **P0** — the entire Head A surface depends on this. Without S01 the timeline has nothing to render.

---

### S02 — Causal chain rendering (vertical timeline UI)

**One-liner.** Render the `CausalChainPayload` as a vertical timeline immediately to the right of the request/response panes, with one row per `CausalLink`, ordered earliest-first.

**Detailed description.** The HTTP detail panel (`tab-http.js:444–487` `_buildDetailPanel`) gets a new tab: **Causal Chain**. The tab strip already animates via `_dtabIndicator`; adding a tab reuses that machinery. The Causal Chain tab body is a single full-height scroll container with the timeline.

Each timeline row has:
- **Vertical rail** with a colored node (color tokens follow `tab-http.css`: `--http-amber` for retry, `--http-blue` for DAG, `--http-violet` (new) for flag, `--http-green` for token, `--http-grey` for nexus). Unicode glyph in node center: ▸ DAG / ⟲ retry / ◆ token / ⚑ flag / ⊕ nexus.
- **Timestamp** in ms-relative-to-request (`-1240ms`, `-12ms`, `+0ms request fires`).
- **Summary** line (e.g. "DAG node `Bronze_Sales` (iteration 4271, started 1.24s ago)").
- **Confidence pill**: `correlated` (solid), `temporal` (outlined), `derived` (subtle), `stack` (dashed). Tooltip explains.
- **Detail disclosure** ▾ that expands to a key/value grid (`Detail` dict from `CausalLink`).
- **Mutation affordance** on the right edge: a `◌ Mutate` button (only on rows where mutation is supported — see S03 matrix). Clicking it opens an inline mutation control.

The terminal row is always the HTTP request itself, rendered with the row's status icon and a "Replay with mutations →" button (disabled until at least one mutation is staged).

**Technical mechanism (frontend sketch).**

```javascript
// src/frontend/js/causal-chain-timeline.js (NEW)
class CausalChainTimeline {
  constructor(host, signalr) {
    this._host = host;             // detail-tab container element
    this._signalr = signalr;
    this._payload = null;
    this._mutations = new Map();   // linkId → MutationSpec
  }

  async loadFor(sequenceId) {
    this._host.classList.add('causal-loading');
    try {
      const payload = await this._signalr.connection.invoke('MitmGetCausalChain', sequenceId);
      this._payload = payload;
      this._render();
    } catch (err) {
      this._renderError(err);
    } finally {
      this._host.classList.remove('causal-loading');
    }
  }

  _render() {
    const links = this._payload.links || [];
    const rows = links.map((l, i) => this._row(l, i)).join('');
    this._host.innerHTML = `
      <div class="causal-timeline">
        <div class="causal-rail"></div>
        ${rows}
        ${this._terminalRow()}
        <div class="causal-actions">
          <button class="causal-replay-btn" ${this._mutations.size === 0 ? 'disabled' : ''}>
            Replay with mutations →
          </button>
        </div>
      </div>`;
    this._wireEvents();
  }

  _row(link, i) {
    const glyph = { dag: '▸', retry: '⟲', token: '◆', flag: '⚑', nexus: '⊕' }[link.source] || '·';
    return `
      <div class="causal-row" data-link-idx="${i}" data-source="${link.source}">
        <div class="causal-node causal-node-${link.source}">${glyph}</div>
        <div class="causal-ts">${this._relTime(link.timestamp)}</div>
        <div class="causal-body">
          <div class="causal-summary">${this._escape(link.summary)}</div>
          <div class="causal-confidence causal-confidence-${link.confidence}">${link.confidence}</div>
          <button class="causal-disclose" aria-expanded="false">▾</button>
          <div class="causal-detail" hidden>${this._renderDetail(link.detail)}</div>
        </div>
        ${this._mutationButton(link, i)}
      </div>`;
  }
}
```

**Source code paths.**
- New: `src/frontend/js/causal-chain-timeline.js`
- Extend: `src/frontend/js/tab-http.js` — register new detail tab in `_buildDetailPanel` (current line 444)
- Extend: `src/frontend/css/tab-http.css` — add `.causal-*` selectors mirroring existing `.http-*` token usage

**Edge cases.**
- Empty payload (HTTP event evicted) → render placeholder card: "Causal context no longer available — event evicted after 2000 newer events. Configure `EDOG_HTTP_RETENTION` to retain more."
- Single-link payload (just nexus, no DAG/retry/token/flag) → still render — useful for "this OneLake call happened outside any DAG context".
- Very long token-claim detail → collapse to first 200 chars with "show all"; never auto-expand multi-KB JSON.
- Authorization redaction: `token.detail` MUST NOT include the raw bearer parameter. C05 server-side strips this before emitting.

**Interactions.**
- C03 owns the detail panel tab strip. C05 contributes one tab spec object and is responsible for the body. No coupling beyond the tab registration API.
- C04 Replay Composer: a row's `Detail` ➜ "Open in Composer" button hands control to C04. C05 emits a custom DOM event `causal:open-in-composer` with `{ sequenceId, mutations }`.
- Topic streaming: timeline is fetched on demand, NOT a live stream. If the user wants live updates they re-click the tab. (Avoids the complexity of "retro-actively a new retry happened — patch the existing timeline".)

**Revert/undo.** N/A — read-only view. Mutations staged in the UI are scratch state; clearing the timeline (close tab, click another row) drops staged mutations with a "discard?" confirm if any exist.

**Priority.** **P0** — the visual punch of Head A.

---

### S03 — Variable mutation (toggle flag, force-expire token, change retry count)

**One-liner.** Each row in the timeline exposes a per-source mutation control; staged mutations are previewed in a "staged" badge and applied at replay time.

**Detailed description.** Mutation is the second half of "show me, then let me change it". The mutation matrix:

| Source | Mutation | UI control | Backend effect at replay |
|---|---|---|---|
| `dag` | (none) | — | DAG context is observational — we don't fake a different node executing |
| `retry` | Override `retryCount` for the replay | numeric input | injected as request header `x-edog-mitm-retry-count` consumed by `MitmCausalAsyncLocal` priming; pure informational unless used by a stateful breakpoint |
| `token` | Force-expire / swap audience | toggle "Treat as expired" + (optional) audience override | sets `MitmCausalAsyncLocal.TokenOverride { ForcedExpired = true, AudienceOverride = "..." }`; the live resolver returns this on subsequent build inside the same async flow |
| `flag` | Toggle the flag on/off for one replay | tri-state pill `On / Off / Unset` | `EdogFeatureOverrideStore.Set(flagName, value, ttl: TimeSpan.FromSeconds(30))`; auto-cleared via TTL |
| `nexus` | (none) | — | Classification is deterministic from URL; no mutation |

**Where mutations live before "Replay" is clicked.** Strictly client-side, in `CausalChainTimeline._mutations: Map<int, MutationSpec>`. No server round-trip until replay. The badge "3 staged mutations" is shown in the timeline header.

**Technical mechanism (frontend mutation control sketch).**

```javascript
// causal-chain-timeline.js — mutation control inline
_renderMutationControl(link, idx) {
  const m = this._mutations.get(idx);
  switch (link.source) {
    case 'flag':
      return `
        <div class="causal-mut causal-mut-flag" data-link-idx="${idx}">
          <span class="causal-mut-label">${this._escape(link.detail.flagName)}:</span>
          <button data-val="true"  class="${m?.value === true  ? 'active' : ''}">On</button>
          <button data-val="false" class="${m?.value === false ? 'active' : ''}">Off</button>
          <button data-val="unset" class="${m == null ? 'active' : ''}">Unset</button>
        </div>`;
    case 'token':
      return `
        <div class="causal-mut causal-mut-token" data-link-idx="${idx}">
          <label><input type="checkbox" data-mut="forceExpired" ${m?.forceExpired ? 'checked' : ''}/> Treat as expired</label>
          <label>Audience: <input type="text" data-mut="audience" placeholder="${link.detail.audience}" value="${m?.audience ?? ''}"/></label>
        </div>`;
    case 'retry':
      return `
        <div class="causal-mut causal-mut-retry" data-link-idx="${idx}">
          <label>Retry count: <input type="number" min="0" max="20" value="${m?.retryCount ?? link.detail.retryAttempt}"/></label>
        </div>`;
    default:
      return '';
  }
}
```

**Technical mechanism (backend mutation primitives — used by S04 dispatch).**

```csharp
// src/backend/DevMode/MitmCausalAsyncLocal.cs (NEW)
internal static class MitmCausalAsyncLocal
{
    private static readonly AsyncLocal<TokenOverride> _token = new();
    private static readonly AsyncLocal<int?> _retryCountOverride = new();
    private static readonly AsyncLocal<DagSnapshot> _dag = new();
    private static readonly AsyncLocal<RetrySnapshot> _retry = new();

    public static IDisposable ApplyForReplay(MutationSet muts)
    {
        var token = _token.Value;
        var retry = _retryCountOverride.Value;
        if (muts.Token != null) _token.Value = muts.Token;
        if (muts.RetryCount.HasValue) _retryCountOverride.Value = muts.RetryCount;
        return new Restore(() => { _token.Value = token; _retryCountOverride.Value = retry; });
    }

    public static TokenSnapshot CurrentTokenSnapshot()
    {
        // Read order: live override > Authorization-derived > topic-derived (older)
        var ovr = _token.Value;
        if (ovr != null) return ovr.ToSnapshot();
        return TokenSnapshotFromAuthorizationAccessor.Capture();
    }
    // ...
}

// Flag mutation goes through the existing store
EdogFeatureOverrideStore.Set(name, value, ttl: TimeSpan.FromSeconds(30));
```

**Source code paths.**
- New: `src/backend/DevMode/MitmCausalAsyncLocal.cs`
- Reuse: `EdogFeatureOverrideStore` — its existing TTL semantics give us auto-clear for free (referenced by `EdogFeatureFlighterWrapper.cs:59` `TryGet`)
- Extend: `src/frontend/js/causal-chain-timeline.js` (controls + staging map)

**Edge cases.**
- User stages a token-forceExpired mutation but the request endpoint is one where `EdogTokenInterceptor` never fires (no Authorization header) — at replay time the override has no effect; surface a warning toast "Token override staged but request had no Authorization header".
- User stages mutations on multiple rows of the same source (somehow two `flag` rows). UI rule: at most one staged mutation per `(source, key)` tuple. Selecting a new value for the same flag replaces the previous staging.
- TTL clamp: max staged TTL is 60s; if the user never replays the flag override expires and the staging UI greys out with "expired".
- Hostile values: audience override > 2KB rejected; retry-count not in [0, 20] rejected.

**Interactions.**
- C04 Replay Composer: when the user clicks "Replay with mutations" the staged `MutationSet` is passed to C04's dispatch helper if available, otherwise C05's own `MitmReplayWithMutations` is called (see S04). They are the same underlying RPC; C04 just adds composer-level overrides on top.
- F24 chaos panel: a long-lived flag override created by F24 takes precedence over a 30s staged override from C05 only if F24's TTL is longer. Tie-break: most-recently-set wins (default store semantics).

**Revert/undo.** Staged mutations are discardable until replay. Post-replay, flag override naturally expires via TTL; force-expire-token and retry-count-override are scoped to the single replay request only (no persistence).

**Priority.** **P0** — without S03 the timeline is a museum, not a tool.

---

### S04 — Replay-with-mutations (stimulus dispatch with overrides)

**One-liner.** Take the original captured request + a `MutationSet` → re-dispatch through the same handler chain with overrides applied → publish a new `http` event tagged `mitm.action = "replay-causal"` that the user can click on to see its own causal chain.

**Detailed description.** This is the orchestration scenario. The frontend sends `MitmReplayWithMutations(sequenceId, mutationSet)`. The hub:

1. Resolves the original captured request from the `http` ring buffer.
2. Reconstructs an `HttpRequestMessage` from `method`, `url`, `requestHeaders`, `requestBodyPreview` (with the body-buffer caveat — preview is ≤4KB; if the user wants full-fidelity replay of >4KB bodies they go through C04 which keeps a separate full-buffer copy at capture time).
3. Applies mutations:
   - Flag mutations → write to `EdogFeatureOverrideStore` with a 30s TTL.
   - Token / retry mutations → push to `MitmCausalAsyncLocal` and dispose at end of dispatch.
4. Obtains an `HttpClient` for the original `httpClientName` via `EdogHttpClientFactoryWrapper` (so the handler chain is identical — `EdogTokenInterceptor` → `EdogHttpPipelineHandler`).
5. Sends. The handler chain naturally publishes the new HTTP event with a new sequenceId. C05 layer adds the `mitm` annotation describing what was overridden (matches §2.1 of P0 — "`mitm` block analogous to `chaos`").
6. Returns `{ NewSequenceId, Success, ErrorMessage }`.

The handler chain's existing rule matching still runs against the replayed request. If a MITM rule matches and would normally pause, **for replay-causal requests the pause is bypassed** and the rule's non-breakpoint action (if any) still applies. Rationale: the user explicitly initiated this replay; pausing inside a replay would be confusing.

**Technical mechanism (backend sketch).**

```csharp
// EdogPlaygroundHub.cs (EXTEND)
public async Task<MitmReplayResult> MitmReplayWithMutations(
    long originalSequenceId, MitmMutationSetInput mutationsInput)
{
    if (!MitmCapability.IsEnabled())
        return MitmReplayResult.Disabled();

    var origEvt = TopicBufferLookup.Find("http", originalSequenceId);
    if (origEvt == null) return MitmReplayResult.NotFound();
    var snapshot = TopicPayloadAdapter.AsHttp(origEvt);

    var muts = MutationSet.FromInput(mutationsInput);
    var flagDisposables = new List<IDisposable>();
    foreach (var (name, value) in muts.Flags ?? Enumerable.Empty<(string, bool)>())
        flagDisposables.Add(EdogFeatureOverrideStore.SetScoped(name, value, TimeSpan.FromSeconds(30)));

    using var _asyncLocal = MitmCausalAsyncLocal.ApplyForReplay(muts);
    using var _replayMarker = MitmReplayMarker.Begin(snapshot.CorrelationId);

    try
    {
        var req = HttpRequestRehydrator.Rehydrate(snapshot);
        var client = _httpClientFactory.CreateClient(snapshot.HttpClientName);
        using var resp = await client.SendAsync(req, Context.ConnectionAborted);
        // The handler publishes the event itself; we just return success
        return MitmReplayResult.Ok(MitmReplayMarker.LastSequenceId);
    }
    catch (Exception ex)
    {
        return MitmReplayResult.Error(ex.Message);
    }
    finally
    {
        foreach (var d in flagDisposables) d.Dispose();
    }
}
```

```csharp
// EdogHttpPipelineHandler.cs (EXTEND, near line 130)
// In the publish branch, after capturing chaosFault context:
var mitmAnnotation = MitmReplayMarker.IsActive(out var causalRef)
    ? new { action = "replay-causal", causalOf = causalRef, modifications = MitmReplayMarker.Summarize() }
    : null;
PublishHttpEvent(..., mitm: mitmAnnotation);   // new optional parameter
```

**Source code paths.**
- Extend: `src/backend/DevMode/EdogPlaygroundHub.cs` (new RPC `MitmReplayWithMutations`)
- Extend: `src/backend/DevMode/EdogHttpPipelineHandler.cs` near publish call (`EdogHttpPipelineHandler.cs:139–144`) to attach the `mitm` block
- New: `src/backend/DevMode/MitmReplayMarker.cs` — AsyncLocal marker + last-sequenceId capture
- New: `src/backend/DevMode/HttpRequestRehydrator.cs` — small reconstruction helper
- Reuse: `EdogHttpClientFactoryWrapper` for client creation (same factory FLT uses, so all handlers fire)

**Edge cases.**
- Original request was POST/PUT/DELETE with side effects. Default behaviour: confirmation dialog client-side with the request method + URL ("This replay may have side effects. Confirm?"). Configurable per user via `localStorage` opt-out.
- Original body > 4KB (truncated in preview). Replay is rejected with `MitmReplayResult.BodyTruncated` → frontend shows "Original body was truncated to 4KB at capture; cannot guarantee fidelity. Use Replay Composer (C04) to edit and send." Power-users can opt in via "Replay anyway with truncated body".
- Authorization header in the captured snapshot is `[redacted]` (`EdogHttpPipelineHandler.cs:280–283`). The replay reconstructs the request *without* an Authorization header; the token interceptor (or whatever Authorization injection FLT does) is responsible for adding one. If FLT doesn't inject one, replay will likely 401 — surface as a warning, not an error.
- Replay during an active F27 QA scenario: the scenario's chaos rules still apply to replayed traffic. This is *correct* — the user wanted to see what happens, including under chaos.
- Coordinator decision pause: replay-causal bypasses pauses (above), but the chaos-fault store path (F27 P5) is NOT bypassed — `EdogHttpPipelineHandler.cs:80–103` runs normally.
- Connection aborts mid-replay: `Context.ConnectionAborted` cancels; flag overrides still tear down via the `using` blocks.

**Interactions.**
- **C04 Replay Composer** is the larger replay UI; C05's replay-with-mutations is the "one-click from causal chain" path. Both call the same RPC pattern; C04 may extend with additional request edits (body, headers, query). The MutationSet is a strict subset of C04's edit-set.
- **C02 Rule Store**: replayed requests still match rules. The `mitm.action = "replay-causal"` tag on the event lets rules optionally exclude themselves (`condition: !state.isReplay`).
- **C03 Detail panel**: the new event appears in the table and (if filtered to) can be inspected immediately. A small visual link from the original row to the replayed row ("replay of #1234") would be ideal — defer to C03's row rendering work.

**Revert/undo.** A replay creates side effects (a real HTTP call). Undo is not possible. The product-level mitigation is the confirmation prompt for non-idempotent methods and the prominent `replay-causal` tag in the table so the user can see what they did.

**Priority.** **P0** — closes the loop. Without S04 the timeline is read-only.

---

## 4. Head B — Stateful Breakpoints: Scenarios

### S05 — State accessor: `state.retryCount`

**One-liner.** Expose the in-flight retry attempt number to the condition DSL via `state.retryCount`.

**Detailed description.** At MitmCoordinator decision-time, `state.retryCount` returns the current retry attempt for this logical call: 0 on first try, 1 on first retry, 2 on second retry, ...

**Source of truth.** Polly retries are surfaced by `EdogRetryInterceptor` via log parsing (`EdogRetryInterceptor.cs:135–138` — `retryAttempt`, `totalAttempts`). The retry topic event lags slightly (log scrape, not instrumentation). For the breakpoint hot path we need the value **at the time the request is about to fire**, not after the fact. Strategy:

1. Add an `AsyncLocal<int>` `MitmCausalAsyncLocal.CurrentRetryAttempt` incremented by an `EdogPollyContextInterceptor` (NEW, small — registered as a `DelegatingHandler` upstream of `EdogHttpPipelineHandler` in `EdogHttpClientFactoryWrapper`).
2. The interceptor reads Polly's `Context.OperationKey` / `Context.GetRetryCount()` (Polly v8 surfaces this on the context) and assigns the AsyncLocal value before calling `base.SendAsync`.
3. If Polly is not in the chain for a given client, the AsyncLocal value is 0 and `state.retryCount` returns 0. The condition evaluator does not distinguish "no retries" from "no Polly".

**Technical mechanism.**

```csharp
// MitmConditionEvaluator.cs (NEW) — accessor registry
private static readonly IReadOnlyDictionary<string, IStateAccessor> _accessors =
    new Dictionary<string, IStateAccessor>(StringComparer.OrdinalIgnoreCase)
    {
        ["retryCount"] = StateAccessor.Number(ctx => ctx.Retry?.AttemptNumber ?? 0),
        ["totalRetries"] = StateAccessor.Number(ctx => ctx.Retry?.TotalAttempts ?? 0),
        // ...
    };
```

```csharp
// MitmCausalAsyncLocal.cs — retry capture
internal static int CurrentRetryAttempt => _retryAttempt.Value;
internal static IDisposable BeginRetryAttempt(int attempt)
{
    var prev = _retryAttempt.Value;
    _retryAttempt.Value = attempt;
    return new Restore(() => _retryAttempt.Value = prev);
}
```

**Source code paths.**
- New: `src/backend/DevMode/MitmConditionEvaluator.cs` (accessor registry)
- New: `src/backend/DevMode/MitmCausalAsyncLocal.cs` (`CurrentRetryAttempt`)
- New: `src/backend/DevMode/EdogPollyContextInterceptor.cs` (small DelegatingHandler that primes the AsyncLocal)
- Read: `src/backend/DevMode/EdogRetryInterceptor.cs:135–204` for event shape reference

**Edge cases.**
- Polly Context not present (handler chain doesn't include Polly). → returns 0. The user can still match on `state.retryCount == 0` if they want.
- Custom retry policy that doesn't increment the standard Polly retry count (e.g. notebook content retry — `EdogRetryInterceptor.cs:209–244`). → falls back to scanning the `retry` topic for the most recent event matching `httpClientName` + endpoint within the last 5s; result is exposed as `state.retryCountTopic` (separate accessor) with `confidence: temporal`.
- Two concurrent retry sequences in different async contexts on the same `HttpClient`. → AsyncLocal isolates correctly. No cross-contamination.

**Interactions.** This is a leaf accessor — depends on AsyncLocal carrier, no other components.

**Revert/undo.** N/A — read-only accessor.

**Priority.** **P0** — the highest-value stateful predicate; the headline §6.2 example uses it.

---

### S06 — State accessor: `state.tokenExpiresIn`

**One-liner.** Expose seconds-until-expiry of the request's bearer token via `state.tokenExpiresIn` (a `TimeSpan` value comparable in seconds: `state.tokenExpiresIn < 30s`).

**Detailed description.** The DSL admits a "duration literal" syntax: `30s`, `5m`, `1h`. The evaluator coerces the right-hand side. The accessor returns a `double` representing seconds; comparisons against duration literals work transparently.

**Source of truth.** `EdogTokenInterceptor.DecodeJwtMetadata` (`EdogTokenInterceptor.cs:100–155`) already extracts `exp` from JWT payload. We need that value **at request-entry time**, not after `base.SendAsync` (the existing interceptor runs *after*). Strategy: in the live `CausalContextResolver` we parse `request.Headers.Authorization` directly (same JWT-decode routine factored out) and cache `expiryUtc`. Cost: ~10µs for the base64url decode + JSON parse for typical 1KB JWT payloads.

**Technical mechanism.**

```csharp
// MitmConditionEvaluator.cs
["tokenExpiresIn"] = StateAccessor.Number(ctx =>
{
    if (ctx.Token?.ExpiryUtc == null) return double.PositiveInfinity;
    return (ctx.Token.ExpiryUtc.Value - DateTimeOffset.UtcNow).TotalSeconds;
}),
["tokenAudience"] = StateAccessor.String(ctx => ctx.Token?.Audience),
["tokenType"] = StateAccessor.String(ctx => ctx.Token?.TokenType),
```

```csharp
// CausalContextResolver.cs — token parse fast path
private static TokenContext ResolveTokenFromAuthorization(HttpRequestMessage req)
{
    var auth = req.Headers.Authorization;
    if (auth == null || !"Bearer".Equals(auth.Scheme, StringComparison.OrdinalIgnoreCase))
        return null;
    JwtFastDecode.Decode(auth.Parameter, out var aud, out var expiryUtc, out var iat);
    return new TokenContext
    {
        TokenType = "bearer-jwt",
        Audience = aud,
        ExpiryUtc = expiryUtc,
        IssuedUtc = iat,
        Source = "derived-from-authorization",
    };
}
```

**Source code paths.**
- Extract: factor JWT-decode helper from `EdogTokenInterceptor.cs:100–155` into a static `JwtFastDecode` class to share with the resolver
- New: `src/backend/DevMode/CausalContextResolver.cs` (token branch)
- Read: `src/backend/DevMode/EdogTokenInterceptor.cs:140–155` for exp/aud extraction logic

**Edge cases.**
- No Authorization header → `tokenExpiresIn` returns `+∞` (`double.PositiveInfinity`). `< 30s` is false. `== null` works via a sibling accessor `state.hasToken`.
- Non-Bearer scheme (e.g., `SharedKey`) → returns `+∞`. Use `state.tokenType` to discriminate.
- Malformed JWT → JwtFastDecode swallows and returns null. Same behaviour as no-token.
- Clock skew → we use local UTC; FLT typically runs on AAD-issued tokens with ±5min skew tolerance. Tolerance is at flag-author level: "use `< 60s` not `< 5s` to avoid skew-induced flap".

**Interactions.** Pairs with S07 (`state.flag`) for the canonical "break when token is about to expire AND we're using v2 catalog" example.

**Revert/undo.** N/A.

**Priority.** **P0** — token bugs are the #1 use case per the P0 §6.7 narrative.

---

### S07 — State accessor: `state.flag(name)`

**One-liner.** Look up the current value of a feature flag from within a breakpoint condition: `state.flag('EnableV2Catalog') == true`.

**Detailed description.** Two modes:

- `state.flag(name)` — **cached**: reads the last published value from a small `FlagSnapshotCache` populated by an observer on the `flag` topic. O(1). Default.
- `state.flagLive(name)` — **live**: calls `IFeatureFlighter.IsEnabled` (or via `EdogFeatureOverrideStore.TryGet` first). Accurate but cost ~ flighter implementation cost. Opt-in.

The cache is updated by a `TopicBuffer.AddObserver` callback registered at coordinator startup. The cache is process-global, not per-request — flag values are not per-request scoped (they are tenant/capacity/workspace scoped, but those scopes change rarely within a single FLT iteration so caching the last value is acceptable for breakpoint matching).

**Technical mechanism.**

```csharp
// MitmConditionEvaluator.cs
["flag"] = StateAccessor.Function((ctx, args) =>
{
    if (args.Length != 1 || args[0] is not string name)
        throw new ConditionEvalException("state.flag(name) requires one string argument");
    return FlagSnapshotCache.TryGet(name, out var v) ? v : (object)null;
}),
["flagLive"] = StateAccessor.Function((ctx, args) =>
{
    var name = (string)args[0];
    if (EdogFeatureOverrideStore.TryGet(name, out var overridden)) return overridden;
    return ctx.FlighterRef?.IsEnabled(name, null, null, null) ?? false;
}),
```

```csharp
// FlagSnapshotCache.cs (NEW)
internal static class FlagSnapshotCache
{
    private static readonly ConcurrentDictionary<string, bool> _cache = new(StringComparer.Ordinal);

    public static void EnsureSubscribed()
    {
        var buf = EdogTopicRouter.GetBuffer("flag");
        buf?.AddObserver(evt =>
        {
            // flag event shape: { flagName, ..., result }
            // small reflection-free cast via dynamic — happens out of hot path
            if (evt.Data is { } data) TryMerge(data);
        });
    }
    public static bool TryGet(string name, out bool value) => _cache.TryGetValue(name, out value);
}
```

**Source code paths.**
- New: `src/backend/DevMode/FlagSnapshotCache.cs`
- Reuse: `EdogFeatureOverrideStore` for live path (`EdogFeatureFlighterWrapper.cs:59` shows the access pattern)
- Hook subscribe call from `MitmCoordinator` startup

**Edge cases.**
- Flag never evaluated → not in cache → returns `null`. Condition `state.flag('Foo') == true` is false (null != true). Author can use `state.flag('Foo') ?? false` (null-coalescing — see S10 DSL).
- Flag dedup window (`EdogFeatureFlighterWrapper.cs:80–81`, 2s) means a flag whose value flipped won't immediately update the cache. The cache may be up to 2s stale. Documented; `state.flagLive` is the escape hatch.
- Override store can have a value not yet reflected in the cache (override set programmatically without going through `IsEnabled`). For correctness, the cache lookup should be: override first, then cached. Accessor wraps both.

**Interactions.** Symmetric with S03's flag mutation: the same `EdogFeatureOverrideStore` is read by `flagLive` and written by mutation. A breakpoint that mutates a flag at firing time can then re-evaluate against the new value on the next request.

**Revert/undo.** N/A — read-only accessor.

**Priority.** **P0** — feature-flag bugs are the #2 use case after token bugs.

---

### S08 — State accessor: `state.dagNodeName`

**One-liner.** Expose the current DAG node name to the DSL: `state.dagNodeName matches 'Bronze_.*'`.

**Detailed description.** Returns the node name from the most recent `NodeStarted` event on the current `iterationId` that has not yet been closed by `NodeCompleted` / `NodeFailed`. Drawn from `MitmCausalAsyncLocal.CurrentDagSnapshot()` populated by extending `EdogNodeExecutorWrapper.ExecuteNodeAsync` (`EdogDagExecutionInterceptor.cs:165–209`).

**Source of truth modification.** Today `EdogNodeExecutorWrapper` publishes a topic event but doesn't set ambient state. We extend `ExecuteNodeAsync` to push to AsyncLocal *around* the inner call. This is the cleanest place — it owns the wrapping `async` frame, so any HTTP call inside the node naturally sees the value via async-context propagation.

```csharp
// EdogDagExecutionInterceptor.cs (EXTEND at L165 ExecuteNodeAsync)
public async Task ExecuteNodeAsync(CancellationToken ct)
{
    PublishEvent(new { @event = "NodeStarted", nodeId = _nodeId, dagId = _dagId, iterationId = _iterationId.ToString(), timestamp = DateTime.UtcNow.ToString("o") });

    using var _dagFrame = MitmCausalAsyncLocal.BeginDagNode(_nodeId, _dagId, _iterationId);   // NEW

    var sw = Stopwatch.StartNew();
    try { await _inner.ExecuteNodeAsync(ct).ConfigureAwait(false); /* ... */ }
    // ...
}
```

**Accessor.**

```csharp
["dagNodeName"] = StateAccessor.String(ctx => ctx.Dag?.NodeId),
["dagId"]       = StateAccessor.String(ctx => ctx.Dag?.DagId),
["iterationId"] = StateAccessor.String(ctx => ctx.Dag?.IterationId),
```

**Source code paths.**
- Extend: `src/backend/DevMode/EdogDagExecutionInterceptor.cs:165` (wrap with `using var _dagFrame = MitmCausalAsyncLocal.BeginDagNode(...)`)
- New: `MitmCausalAsyncLocal.BeginDagNode`
- DSL `matches` operator implemented in S10

**Edge cases.**
- HTTP call outside any DAG node (cold path, e.g., startup token acquisition) → `state.dagNodeName == null`. Conditions referencing it short-circuit safely.
- Nested node execution (one node spawning child work) — AsyncLocal stack semantics handle this via the `using` restoration.
- Parallel DAG nodes on the same iteration — each node's async context is independent; an HTTP call from inside node A sees `A`, not `B`. Correct.

**Interactions.** Pairs with retry counters: "break on `Bronze_*` only when retry > 2".

**Revert/undo.** N/A — read-only accessor.

**Priority.** **P0** — DAG-node scoping is a top use case.

---

### S09 — State accessor: `state.nexusDependency`

**One-liner.** Classify the request to a Nexus dependency ID and expose it: `state.nexusDependency == 'onelake'`.

**Detailed description.** Wraps `EdogNexusClassifier.ClassifyHttp(...)` (`EdogNexusClassifier.cs:235`). Returns the `DependencyId` string ("auth", "spark-gts", "platform-api", "capacity", "fabric-api", "onelake", "unknown" — full list in `NexusDependencyId` constants).

**Technical mechanism.**

```csharp
["nexusDependency"] = StateAccessor.String(ctx => ctx.Nexus?.DependencyId),
["nexusEndpointHint"] = StateAccessor.String(ctx => ctx.Nexus?.EndpointHint),
["nexusIsInternal"] = StateAccessor.Boolean(ctx => ctx.Nexus?.IsInternal ?? false),
["nexusIsThrottled"] = StateAccessor.Boolean(ctx => ctx.Nexus?.IsThrottled ?? false),
```

`CausalContextResolver.BuildLive` calls `EdogNexusClassifier.ClassifyHttp` with a small shim payload built from the live request (URL + method + status placeholder). Classification cost dominated by ~6 regex evaluations against `UrlRules` (`EdogNexusClassifier.cs:93–101`); the regexes are `RegexOptions.Compiled`. Measured cost in P2 prototype: ~5µs.

**Source code paths.**
- Reuse: `src/backend/DevMode/EdogNexusClassifier.cs:140` `Classify(topic, eventData)` — call with `"http"` and an anonymous-object shim
- New: shim builder in `CausalContextResolver`

**Edge cases.**
- Unmatched URL → returns `"unknown"`. Comparisons against `"onelake"` etc. correctly produce false. No null risk.
- Multiple matches (regex order matters per `EdogNexusClassifier.cs:60`) — first-match-wins is preserved; same behaviour the rest of EDOG sees.

**Interactions.** Composes naturally with URL pattern matching in the rule's outer predicate — but `state.nexusDependency` is more durable than URL regex because URLs change as Fabric rolls out new endpoints.

**Revert/undo.** N/A.

**Priority.** **P1** — high-value but secondary to retry/flag/token.

---

### S10 — Condition expression parser & evaluator

**One-liner.** Parse a string condition into an AST once at rule-create time, evaluate it against a `CausalContext` in < 100µs per call.

**Detailed description.** The DSL is intentionally small. Grammar (EBNF-style):

```
Expr     ::= OrExpr
OrExpr   ::= AndExpr ( '||' AndExpr )*
AndExpr  ::= NotExpr ( '&&' NotExpr )*
NotExpr  ::= '!' NotExpr | Cmp
Cmp      ::= Term ( ( '==' | '!=' | '<' | '<=' | '>' | '>=' | 'matches' | 'in' ) Term )?
Term     ::= Coalesce
Coalesce ::= Primary ( '??' Primary )?
Primary  ::= Literal | Accessor | '(' Expr ')'
Accessor ::= 'state' '.' Identifier ( '(' ArgList? ')' )?
Literal  ::= StringLit | NumberLit | DurationLit | BoolLit | NullLit
DurationLit ::= NumberLit ( 's' | 'ms' | 'm' | 'h' )
```

**Operators.** Standard. `matches` is regex match (RHS string compiled once). `in` is membership against a string-array literal `['a','b']`. `??` is null-coalesce.

**Type model.** Three runtime kinds: `Bool`, `Number` (double), `String` (or null). Comparisons across types: numbers coerce to numbers; strings to strings; `null` compares equal only to `null`. Implicit coercion is *not* allowed — `"3" == 3` is false. This is deliberately strict to avoid the JavaScript-style surprise.

**Compilation.** A condition is compiled once at `MitmCreateRule` time (or whenever the rule's `condition` field is set). Compiled output is a small AST of immutable record types. Stored on the `MitmRule` instance alongside the source string. At eval-time, the evaluator walks the AST against the `CausalContext`. No allocation in the steady-state hot path (the AST node objects are pre-allocated; argument arrays for `state.flag(...)` are stack-allocated `Span<object>`).

**Errors.** Parse errors at create-time surface as `MitmRuleValidationError`s with a column position. Eval-time errors (e.g., regex throw — but `matches` uses `Regex.Match` which returns no-match instead of throwing for compiled patterns) wrap as `condition-eval-failed` and the rule is treated as **non-matching** (fail-safe: don't pause if the condition can't decide).

**Technical mechanism.**

```csharp
// MitmConditionEvaluator.cs (NEW)
public sealed class CompiledCondition
{
    public string Source { get; }
    private readonly AstNode _root;
    private CompiledCondition(string src, AstNode root) { Source = src; _root = root; }

    public static CompiledCondition Compile(string source)
    {
        if (string.IsNullOrWhiteSpace(source)) return AlwaysTrue;
        var tokens = ConditionLexer.Tokenize(source);
        var ast = ConditionParser.Parse(tokens);
        ConditionTypeChecker.Check(ast);   // pre-flight type validation
        return new CompiledCondition(source, ast);
    }

    public bool Evaluate(CausalContext ctx)
    {
        try
        {
            var v = _root.Eval(ctx);
            return v is bool b && b;
        }
        catch (ConditionEvalException) { return false; }   // fail-safe
    }

    public static readonly CompiledCondition AlwaysTrue =
        new CompiledCondition("(empty)", new BoolLiteral(true));
}
```

```csharp
// Example AST node
internal sealed record CmpNode(AstNode Left, CmpOp Op, AstNode Right) : AstNode
{
    public override object Eval(CausalContext c)
    {
        var l = Left.Eval(c); var r = Right.Eval(c);
        return Op switch
        {
            CmpOp.Eq => StrictEquals(l, r),
            CmpOp.Lt => Compare(l, r) < 0,
            CmpOp.Matches => l is string ls && r is Regex rr && rr.IsMatch(ls),
            // ...
        };
    }
}
```

**Source code paths.**
- New: `src/backend/DevMode/MitmConditionEvaluator.cs` (lexer, parser, AST, evaluator — all in one file, ~360 lines)
- Type registry: the same file holds the accessor table (S05–S09)

**Edge cases.**
- Empty / null condition → `CompiledCondition.AlwaysTrue` — rule matches whenever URL/method match.
- Recursive accessor (none defined) → not possible; accessors are flat.
- Right-hand string for `matches` not a valid regex → parse-time error.
- Numeric overflow → all numbers are `double`, so practically no overflow; NaN comparisons are always false.
- DOS via regex backtracking on user-authored `matches` pattern → compile with `RegexOptions.Compiled | RegexOptions.CultureInvariant` and a `MatchTimeout` of 50ms; on timeout treat as non-match.

**Interactions.** Called from C01 MitmCoordinator per request per matching rule.

**Revert/undo.** Per-rule condition update via `MitmUpdateRule` recompiles. Failed compile keeps the previous condition in place and returns a validation error.

**Priority.** **P0** — Head B's engine.

---

### S11 — Stateful breakpoint creation UI

**One-liner.** A small expression-builder pane in the Intercept detail tab (C03) that helps the user compose conditions without typing the DSL by hand, while still letting power-users edit raw.

**Detailed description.** Two-mode editor:

- **Guided mode** (default): three dropdowns: `state.<accessor>` × operator × value. Operators auto-filter by accessor type (numeric accessors show `< <= > >=`, strings show `== != matches in`). The "value" widget specialises (number input for numeric, datalist of known flag names for `flag(...)` argument, regex-validating input for `matches`, etc.). A `+ AND` / `+ OR` button extends with another row, building parenthesised groups visually.
- **Expression mode**: a textarea with syntax highlight (inline tokens — accessors in violet, operators in grey, literals in green) and a live validation badge ("✓ parses, evaluates against last 10 requests = 3 would have matched"). Switching modes either round-trips losslessly (if the guided composition is representable) or warns and switches one-way.

A **live preview** chip shows: "Of the last 100 HTTP requests in this tab, **3** would have matched". Evaluated client-side by re-running the compiled condition against the cached `causal` blocks on the HTTP rows. This gives the user immediate feedback that their condition isn't trivially zero-matching or universally matching.

**Technical mechanism (frontend sketch).**

```javascript
// src/frontend/js/mitm-condition-builder.js (NEW)
class MitmConditionBuilder {
  constructor(host, accessors) {
    this._host = host;
    this._accessors = accessors;   // delivered by MitmGetCapabilities()
    this._mode = 'guided';
    this._rows = [{ accessor: null, op: null, value: null, joiner: null }];
  }
  toSource() {
    if (this._mode === 'expression') return this._rawText;
    return this._rows
      .map((r, i) => `${i > 0 ? r.joiner : ''} ${this._rowToSource(r)}`)
      .join(' ').trim();
  }
  async validate() {
    const src = this.toSource();
    return await this._signalr.connection.invoke('MitmValidateCondition', src);
  }
  livePreviewMatch(rows /* last N http rows with .causal */) {
    const compiled = compileClient(this.toSource());
    return rows.filter(r => compiled.evaluate(r.causal)).length;
  }
}
```

A small client-side mirror of the compiled-condition evaluator powers the live preview; it MUST be kept in lockstep with the backend evaluator for the same DSL — the canonical contract is documented in this spec and exercised by a shared test corpus (`tests/condition-corpus.json`) consumed by both Sentinel C# tests and frontend tests.

**Source code paths.**
- New: `src/frontend/js/mitm-condition-builder.js`
- New: `src/frontend/js/mitm-condition-client-eval.js` — client-side mirror of the evaluator (parse + eval); ~250 lines
- Extend: `src/frontend/js/tab-http.js` Intercept detail tab to host the builder
- Extend: `src/frontend/css/tab-http.css` — `.mitm-cond-row`, `.mitm-cond-op`, `.mitm-cond-preview`

**Edge cases.**
- Server validation rejects condition → builder highlights the failing token using the column position from the error.
- Accessor list returned by `MitmGetCapabilities()` doesn't include `nexusDependency` (capability disabled). → builder hides the accessor from the dropdown.
- Power user types `state.flag('X) ==true)` (mismatched parens). → live validation surfaces the error inline; create button disabled.
- Live preview gives 0 matches — surface as a subtle warning, not an error: "This condition wouldn't have matched any of the last 100 requests. Did you mean ...?".

**Interactions.**
- C03 owns the Intercept detail tab layout; C05 contributes the condition-builder block within it (clear separation: C03 = container, C05 = the condition widget).
- C02 Rule Store: the source string is what's persisted on the rule; the compiled AST is server-side only and never crosses the wire.

**Revert/undo.** Standard textarea undo/redo for expression mode; row delete (✕) for guided mode. Saving with a broken condition is blocked.

**Priority.** **P0** — without S11, Head B is engineer-only and the spec promise of "click to compose" fails.

---

### S12 — Performance: condition eval must be < 1ms per request

**One-liner.** Total budget for "should this rule pause this request?" — including `CausalContext` build and N condition evaluations — is **< 1ms at p99 per request, < 250µs at p50**.

**Detailed description.** This is a hard requirement. FLT issues ~50–200 outbound HTTP calls per DAG iteration; with K rules registered, total per-iteration overhead is bounded by `requests × (CausalContextBuildLive + K × ConditionEval)`. For typical K = 5 rules and 200 requests, total budget is `200 × (250µs + 5 × 50µs) ≈ 100ms` per iteration. That is acceptable; anything 10x worse is not.

**Where the time goes (target breakdown, live path).**

| Step | Target p50 | Target p99 | Notes |
|---|---|---|---|
| `CausalContextResolver.BuildLive` (AsyncLocal reads, JWT fast-decode, nexus regex, flag cache) | 80µs | 250µs | JWT decode dominates if Authorization present |
| `ConditionEvaluator.Evaluate` per rule | 5µs | 50µs | Walked AST, no allocs, primitive ops |
| `RuleStore.Match` (URL+method predicate before condition) | 5µs | 30µs | FrozenDictionary + substring/regex |
| **Total for K=5 rules** | **110µs** | **530µs** | Within budget |

**Strategies to hit the budget.**

1. **Short-circuit on empty rule store.** If `_flatRules.Length == 0`, return without building `CausalContext`. Same pattern as `EdogHttpFaultStore.cs:174–194`.
2. **Lazy CausalContext build.** Build only if at least one rule's predicate matches the URL+method. Add a `MitmRule.RequiresCausalContext` precomputed bool (true iff condition references any `state.*` accessor) to skip the build when no condition uses it.
3. **No reflection.** Accessor table is `Dictionary<string, Func<CausalContext, object>>`; no `dynamic`, no `Activator.CreateInstance`.
4. **Compiled regex.** Patterns from `matches` operator and `nexus` classifier compiled once.
5. **Stack-allocated arg arrays** for `state.flag('X')`-style calls via `Span<object>` parameter passing.
6. **Single immutable CausalContext per request.** Computed once, passed to N evaluations. Never rebuilt mid-request.
7. **No locks on the hot path.** AsyncLocal reads are lock-free; flag cache is `ConcurrentDictionary` lock-free read.
8. **Eviction-safe.** No allocation per eval beyond what the AST needs (zero for primitive comparisons; one boxed bool/double/string only when an accessor returns one).

**Measurement.** A benchmark project (`tests/perf/CausalEvalBench.cs` — BenchmarkDotNet) is part of Sentinel's gate set. Build fails if p99 > 1ms on the standard 200-request synthetic trace.

**Technical mechanism.**

```csharp
// MitmCoordinator (C01 — illustrative wiring)
public Task<MitmDecision> EvaluateAsync(HttpRequestMessage req, ...)
{
    var rules = _ruleStore.SnapshotFlat();
    if (rules.Length == 0) return DecisionPassthrough;

    // First pass: cheap URL/method predicates only
    var urlMethodMatches = new List<MitmRule>(2);
    for (int i = 0; i < rules.Length; i++)
        if (rules[i].MatchesUrlMethod(req)) urlMethodMatches.Add(rules[i]);
    if (urlMethodMatches.Count == 0) return DecisionPassthrough;

    var needsCausal = urlMethodMatches.Exists(r => r.Condition.RequiresState);
    var ctx = needsCausal ? CausalContextResolver.BuildLive(req, corrId, clientName) : null;

    foreach (var rule in urlMethodMatches)
        if (rule.Condition.Evaluate(ctx)) return await SuspendForUiAsync(rule, ctx);

    return DecisionPassthrough;
}
```

**Source code paths.**
- New: `tests/perf/CausalEvalBench.cs` (BenchmarkDotNet)
- New: `src/backend/DevMode/MitmConditionEvaluator.cs` — performance-sensitive code paths annotated with `// HOT PATH` comments
- All evaluator allocations audited against `BenchmarkDotNet`'s `MemoryDiagnoser`

**Edge cases.**
- Pathological condition with 100 ORs → still bounded; walk depth O(condition size), not O(request count). Validator rejects conditions with > 32 sub-expressions.
- A user-supplied regex with catastrophic backtracking → 50ms `MatchTimeout` caps the worst case; on timeout the condition returns false (fail-safe, see S10).
- High K (many rules) → rule store ordering and short-circuit minimize impact. If K > 50 the UI surfaces a warning ("Many active rules — consider consolidating"). Hard cap of 200 rules per session enforced by `MitmCreateRule`.

**Interactions.** This scenario is the *contract* every other scenario in this component honors. S01's `BuildLive` budget is set here; S10's evaluator design is shaped by it.

**Revert/undo.** N/A — performance requirement, not a feature.

**Priority.** **P0** — non-negotiable. The whole F28 value proposition collapses if intercepting adds visible latency to FLT.

---

## 5. Wire Protocol Additions

### 5.1 New hub RPCs

| RPC | Args | Returns | Notes |
|---|---|---|---|
| `MitmGetCausalChain(long sequenceId)` | sequenceId of an `http` event | `CausalChainPayload { sequenceId, links[], httpSnapshot, status }` | Status: `ok` / `evicted` / `not-found`. |
| `MitmReplayWithMutations(long sequenceId, MitmMutationSetInput muts)` | original event + mutations | `MitmReplayResult { newSequenceId, success, errorMessage }` | New event published normally on the `http` topic. |
| `MitmValidateCondition(string source)` | DSL source string | `MitmConditionValidation { ok, errorColumn, errorMessage, requiresState }` | Used by S11 live validator. |
| `MitmGetCapabilities()` *(extend C01's existing capability RPC)* | — | adds `supportedStateAccessors: string[]`, `causalReplayEnabled: bool` | UI gating. |

### 5.2 Extended `http` topic event

Added optional `causal` block alongside the existing `chaos` and the new `mitm` blocks (from §2.1 of P0):

```json
"causal": {
  "summaryVersion": 1,
  "dag": { "nodeId": "Bronze_Sales", "dagId": "...", "iterationId": "..." } /* or null */,
  "retry": { "attemptNumber": 2, "totalAttempts": 5, "strategyName": "OneLakeRetry" } /* or null */,
  "token": { "tokenType": "bearer-jwt", "audience": "https://onelake.dfs.fabric.microsoft.com", "expiryUtc": "2026-08-12T18:42:11Z" } /* or null */,
  "flags": { "EnableV2Catalog": true, "UseSparkV3": false } /* sparse — only flags referenced by active rules + key product flags */,
  "nexus": { "dependencyId": "onelake", "endpointHint": "Tables", "isInternal": false }
}
```

Wire-shape policy: **always include `causal` block** when MITM is enabled; **never include** when disabled. Consumer code paths in `tab-http.js` treat absence as "no causal data".

### 5.3 `mitm` topic events (control plane) — additions from C05

| `event` | Payload | Emitted when |
|---|---|---|
| `causalReplay.started` | `{ originalSequenceId, mutations: [...] }` | At the top of `MitmReplayWithMutations` |
| `causalReplay.completed` | `{ originalSequenceId, newSequenceId, durationMs }` | After dispatch returns |
| `causalReplay.failed` | `{ originalSequenceId, error }` | On exception |
| `condition.validated` | `{ source, ok, requiresState }` | On every `MitmValidateCondition` call (helpful for audit) |

---

## 6. Test Plan (Sentinel must approve before merge)

| Gate | Test class | What it covers |
|---|---|---|
| Unit | `CausalContextResolverTests` | All 5 resolvers; null inputs; AsyncLocal propagation; JWT malformed |
| Unit | `MitmConditionEvaluatorTests` | DSL grammar coverage, all operators, all 8+ accessors, fail-safe on eval error |
| Unit | `MitmConditionParserTests` | Lexer + parser; column-accurate errors |
| Unit | `FlagSnapshotCacheTests` | Subscribe, update, override interaction |
| Integration | `MitmCausalChainBuilderTests` | End-to-end: publish synthetic dag/retry/token/flag events, then HTTP, then `Build()` returns expected links with correct confidence labels |
| Integration | `MitmReplayWithMutationsTests` | Flag mutation applied during replay observable via `IsEnabled`; token override observable in second causal chain |
| Perf | `CausalEvalBench` (BenchmarkDotNet) | p99 < 1ms total; p50 < 250µs; zero alloc steady-state |
| Frontend | `causal-chain-timeline.test.js` | Rendering with empty / single-link / many-link payloads; mutation staging; replay enable/disable |
| Frontend | `mitm-condition-builder.test.js` | Guided ↔ expression round-trip; client-side eval matches backend on shared corpus `tests/condition-corpus.json` |

**Critical Sentinel rules from `hivemind/QUALITY_BAR.md`**:
- Gate 1 (build): all new files compile under `#nullable disable` + `#pragma warning disable` per DevMode convention
- Gate 3 (perf): `CausalEvalBench` is a blocking gate; regressions > 20% fail the build
- Gate 5 (security): no test may log a real bearer token; all JWT fixtures use synthetic tokens with `aud: "test"` and short-lived `exp`

---

## 7. Risks specific to C05

| # | Risk | Mitigation |
|---|---|---|
| C05-R1 | **AsyncLocal not propagating** through some FLT async path (custom `SynchronizationContext`, `Task.Run` without `ConfigureAwait`). | DAG/retry context capture is best-effort; if AsyncLocal is null we fall back to topic-temporal join with `confidence: temporal`. Logged for telemetry. |
| C05-R2 | **JWT fast-decode in the hot path** for every HTTP request adds latency. | Cache the decoded result on the `HttpRequestMessage.Properties` bag keyed by Authorization-hash; reuse across rule evaluations within the same request. |
| C05-R3 | **Client/server DSL drift** — frontend evaluator diverges from backend over time. | Shared test corpus `tests/condition-corpus.json` exercised by both. Frontend implementation reviewed against backend AST in code review. |
| C05-R4 | **Flag mutation TTL conflicts** with F24 long-lived flag overrides. | Most-recently-set wins; document precedence in `EdogFeatureOverrideStore` XML doc; surface conflicting overrides in F24 panel. |
| C05-R5 | **Replay loops** — user replays a request that itself triggers more requests that hit the same breakpoint. | Replay-causal events bypass breakpoint pauses (S04 final paragraph). Combined with the 30s confirmation toast for non-idempotent methods, this caps the blast radius. |
| C05-R6 | **Authorization leakage via timeline detail.** | `TokenContext.Detail` strips the raw bearer parameter at construction time; unit test enforces no Authorization value appears in serialised CausalChainPayload JSON. |
| C05-R7 | **Memory growth from causal-chain payloads** retained in the frontend cache. | Frontend caches the last 50 chains only; rest are re-fetched on demand. |

---

## 8. Open Threads to P2

1. **State accessor for `httpClientName`-resolved DI service name** — currently we expose `httpClientName` (string tag) but not the DI registration ("which `IFabricCatalogService` impl resolved"). Tier-2 §6.10 deferred; flagged here for P2.
2. **`state.lastResponseStatus(seconds)`** — "in the last 30s, was there a 5xx on the same endpoint?". Requires a small per-endpoint sliding-window summary table. Could be P2 if Tier-1 ships clean.
3. **Causal chain export to ADO bug** — "copy as Markdown table" for filing. Small UX win, P2 task.
4. **Condition snippets / saved-condition library** — "favorite this condition for reuse". P2.

---

## 9. Definition of Done

C05 is done when:

- All 12 scenarios above are implemented per their `Technical mechanism` sections.
- All tests in §6 pass; `CausalEvalBench` reports p99 < 1ms.
- A user can: (1) click an HTTP row, (2) see a causal chain with at least one DAG, retry, token, flag, and nexus link on a representative FLT iteration, (3) stage a flag-off mutation, (4) click Replay, (5) see a new row appear marked `replay-causal`, (6) inspect the new row's causal chain and confirm `flag.EnableV2Catalog == false` in the second chain.
- A user can: (1) open Intercept tab on any row, (2) compose `state.retryCount > 2 && state.flag('EnableV2Catalog') == true` in the guided builder, (3) see the live-preview match count, (4) save the rule, (5) observe FLT pausing exactly on requests matching the condition, (6) resume.
- `make lint && make test && make build` green; Sentinel approval recorded in the commit trailer.

— *Sana*
