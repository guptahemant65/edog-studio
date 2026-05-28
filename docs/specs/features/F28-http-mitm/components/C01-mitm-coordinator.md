# F28 · C01 — MitmCoordinator

> **Component spec — P1 Deep**
> Owner: **Sana** (architecture)
> Feature: F28 HTTP MITM
> Status: Draft for P1 review
> Grounded against: `docs/specs/features/F28-http-mitm/research/p0-foundation.md` (P0 foundation)
> Source-of-truth files cited: `EdogHttpPipelineHandler.cs`, `EdogHttpFaultStore.cs`, `EdogPlaygroundHub.cs`, `EdogQaCapabilityRegistry.cs`, `EdogTopicRouter.cs`, `TopicBuffer.cs`

---

## 0. TL;DR

`MitmCoordinator` is the **keystone backend service** for F28. It owns the lifecycle of an in-flight HTTP request while it is suspended at an interactive breakpoint, marshals frontend decisions back to the suspended request's thread, enforces safety nets (timeout, disconnect cancellation, kill switch), and defines the precedence between interactive MITM rules, scenario chaos rules (F27 P5), and persistent session rules (future F24 panel).

**One-paragraph behavioural summary.** When `EdogHttpPipelineHandler.SendAsync` enters the pipeline, it asks the coordinator "is there a breakpoint armed for this request?" (cheap, lock-free read). If yes, the handler thread `await`s `_coordinator.AwaitDecisionAsync(interceptId, snapshot, ct)`, which parks the thread on a `TaskCompletionSource`. The coordinator publishes a `mitm.paused` event on the `mitm` topic. The frontend sees the paused intercept, the user picks Forward / Modify / Block / Forge, and the frontend invokes `MitmResume(interceptId, decision)` on the hub. The hub forwards the decision to `_coordinator.SubmitDecisionAsync(...)`, which completes the `TaskCompletionSource`. The handler thread unparks with the `MitmDecision` and executes the chosen branch (call base, call base with mutated request, return synthesized response, throw `OperationCanceledException`). Every breakpoint has a default 30-second timeout; the coordinator is therefore a **deterministic, bounded-latency mediator**, not an open-ended debugger.

**Why this component is the keystone.** All other F28 components — C02 Rule Engine, C03 SignalR Protocol, C04 HTTP-tab UI, C05 Request Editor — are stateless or store-only. The coordinator is the only component that holds *thread state across an async suspension*. Get it wrong and EDOG Studio holds threads forever, leaks `TaskCompletionSource`s, or worse: silently lets paused requests escape into production-like services with no record.

---

## 1. Responsibilities

| # | Responsibility | Why it lives here (not elsewhere) |
|---|---|---|
| R1 | Park a request thread on a per-intercept `TaskCompletionSource<MitmDecision>` until the frontend submits a decision. | Only place in the stack where the in-flight request thread can be referenced. Cannot live in the store (no thread context) or the hub (no handler access). |
| R2 | Publish `mitm.paused` / `mitm.resumed` / `mitm.timedOut` / `mitm.cancelled` events on the new `mitm` topic. | Coordinator owns the lifecycle, so it owns the lifecycle events. Single source of truth for breakpoint state. |
| R3 | Enforce the **30-second default timeout** (configurable, always finite). Auto-resolve as Forward with no modifications when it fires. | Single timer per intercept. Putting it in the handler would scatter timeout logic; putting it in the frontend would be advisory only. |
| R4 | Cancel all pending intercepts owned by a SignalR `ConnectionId` when `OnDisconnectedAsync` fires. Each cancellation auto-resolves as Forward. | Coordinator is the only component that knows the `(interceptId → ownerConnectionId)` mapping. |
| R5 | Define and apply **precedence ordering** when more than one source could mutate a request: `interactive breakpoint > scenario chaos rule (F27 P5) > session rule`. | Single decision point keeps the handler's match table small and auditable. |
| R6 | Report capabilities via `MitmCoordinator.GetCapabilities()` → consumed by `MitmGetCapabilities` hub method. Gated by **env var `EDOG_MITM_INTERACTIVE=1`** and **build constant `MitmInteractivePipelineWired`**. | Matches the established `EdogQaCapabilityRegistry` pattern (see `EdogQaCapabilityRegistry.cs:135–142`). |
| R7 | Provide the **kill switch** primitive: `ClearAllPendingAndPurgeOwners(reason)` invoked by Ctrl+Shift+K via `MitmClearAll()` hub method. | Coordinator owns thread state; only it can fail-safe-release every parked TCS without orphans. |
| R8 | Be **thread-safe and lock-free on the hot path**. `ShouldPauseAsync(request)` must do at most one `Volatile.Read` and one dictionary lookup when no breakpoints are armed (zero allocations on the fast path). | Matches the F27 P5 perf contract documented in `EdogHttpFaultStore.cs:79–88`. |

**Out of scope for C01** (handled by sibling components):

- Rule storage, predicates, action lifecycle counters → **C02 MitmRuleStore / MitmRule**.
- Hub RPC wire shape, validation, error envelopes → **C03 SignalR Protocol**.
- HTTP-tab UI, row badges, Intercept toggle, kill-switch keybind → **C04 HTTP-tab UI**.
- Request/response body editing UI → **C05 Request Editor**.
- Replay-fired requests → **C06 Replay Service** (uses coordinator only as a bypass marker).

---

## 2. Public API — Class Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            MitmCoordinator                                   │
│                   (DevMode singleton — internal static)                      │
├──────────────────────────────────────────────────────────────────────────────┤
│ — Hot-path predicate (called from EdogHttpPipelineHandler.SendAsync) —       │
│   bool ShouldPauseRequest(HttpRequestMessage req, out RequestBreakpoint bp)  │
│   bool ShouldPauseResponse(HttpResponseMessage rsp, RequestBreakpoint bp,    │
│                            out ResponseBreakpoint rbp)                       │
│                                                                              │
│ — Suspension (returns the user's decision; awaited by the handler) —         │
│   Task<MitmDecision> AwaitRequestDecisionAsync(                              │
│       string interceptId, RequestSnapshot snap,                              │
│       RequestBreakpoint bp, CancellationToken ct);                           │
│   Task<MitmDecision> AwaitResponseDecisionAsync(                             │
│       string interceptId, ResponseSnapshot snap,                             │
│       ResponseBreakpoint bp, CancellationToken ct);                          │
│                                                                              │
│ — Resume API (called from EdogPlaygroundHub.MitmResume) —                    │
│   ResumeResult SubmitDecision(string interceptId, MitmDecision decision,    │
│                               string callerConnectionId);                    │
│                                                                              │
│ — Owner / kill-switch / capability —                                         │
│   void CancelOwner(string connectionId, string reason);                      │
│   int  ClearAllPending(string reason);                                       │
│   MitmCapabilityReport GetCapabilities();                                    │
│                                                                              │
│ — Inspection (read-only, diagnostic) —                                       │
│   IReadOnlyList<PendingInterceptInfo> ListPending();                         │
│   long Revision { get; }                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ — Private state —                                                            │
│   ConcurrentDictionary<string /*interceptId*/, PendingIntercept> _pending;   │
│   ConcurrentDictionary<string /*connectionId*/, HashSet<string>> _byOwner;   │
│   long _revision;                                                            │
│   readonly TimeSpan _defaultTimeout = TimeSpan.FromSeconds(30);              │
│   readonly bool _enabled; // env-var + build constant                        │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│ PendingIntercept (private)       │    │ MitmDecision (DTO, serialized)   │
├──────────────────────────────────┤    ├──────────────────────────────────┤
│ string InterceptId               │    │ enum Kind {                      │
│ TaskCompletionSource<MitmDecision│    │   Forward, Modify, Block, Forge  │
│   > Tcs                          │    │ }                                │
│ CancellationTokenRegistration    │    │ string ReasonTag                 │
│   CtRegistration                 │    │ RequestModifications? ReqMods    │
│ CancellationTokenSource          │    │ ResponseModifications? RspMods   │
│   TimeoutCts                     │    │ ForgedResponse? Forged           │
│ string OwnerConnectionId         │    │ string SubmittedBy /*cnxId*/     │
│ DateTimeOffset CreatedAtUtc      │    └──────────────────────────────────┘
│ Phase Phase {Request|Response}   │
│ RequestBreakpoint Bp             │
└──────────────────────────────────┘

   EdogHttpPipelineHandler ── ShouldPause? ──► MitmCoordinator
   (handler thread)         ── AwaitDecisionAsync ─► [parks on TCS]
                                                       │
   EdogPlaygroundHub.MitmResume ── SubmitDecision ─────┘
                                                       │
                                                       ▼
   (handler thread unparks with MitmDecision, executes branch)

   On disconnect:   Hub.OnDisconnectedAsync ──► CancelOwner(connectionId)
   On Ctrl+Shift+K: Hub.MitmClearAll        ──► ClearAllPending("kill-switch")
```

**Topic events emitted by the coordinator** (published via `EdogTopicRouter.Publish("mitm", …)` — see `EdogTopicRouter.cs:74–95` for the pattern, identical to F27 P5's `chaos` block in `EdogHttpPipelineHandler.cs:200–223`):

| Event name | When | Payload (key fields) |
|---|---|---|
| `mitm.paused` | A request/response enters a breakpoint and the handler parks. | `interceptId, phase, ruleId, ownerConnectionId, snapshot, deadlineUtc` |
| `mitm.resumed` | `SubmitDecision` completes the TCS with a frontend-supplied decision. | `interceptId, decision.Kind, durationMs, submittedBy` |
| `mitm.timedOut` | Default-timeout fires before any decision. Resolves as Forward (R1 in P0 §4.4). | `interceptId, phase, timeoutMs` |
| `mitm.cancelled` | Owner disconnected, kill switch, or explicit `MitmDrop`. Resolves as Forward unless the cancel reason is `kill-switch` (then Block — see S12). | `interceptId, reason` |

---

## 3. Scenarios (S01–S12)

### S01 — Request breakpoint (pre-request pause) **[P0]**

**One-liner.** Before `base.SendAsync`, the handler asks the coordinator whether a breakpoint matches; if yes, parks the thread until a frontend decision arrives.

**Detailed description.** This is the canonical interactive MITM entry point. The pipeline handler calls `ShouldPauseRequest(req, out bp)` immediately after building the redacted request snapshot (right where F27 P5's chaos lookup happens today). If the coordinator returns true, the handler builds a `RequestSnapshot` (method, URL, headers, body buffered up to 10 MB — see R3 in P0 §4.4) and `await`s `AwaitRequestDecisionAsync`. The coordinator allocates an `interceptId` (ULID, sortable), registers a `PendingIntercept`, starts a 30-s timeout timer, publishes `mitm.paused`, and returns the TCS task. When the decision arrives, the handler runs the corresponding branch.

**Technical mechanism.**

```csharp
// Inside EdogHttpPipelineHandler.SendAsync, between L84 (chaos lookup) and L106 (sw.Start).

if (MitmCoordinator.Instance.ShouldPauseRequest(request, out var bp))
{
    var snap = await RequestSnapshot.CaptureAsync(request, redact: bp.RevealAuthorization == false)
                                    .ConfigureAwait(false);
    var interceptId = MitmIds.NewInterceptId();
    var decision = await MitmCoordinator.Instance
                        .AwaitRequestDecisionAsync(interceptId, snap, bp, cancellationToken)
                        .ConfigureAwait(false);

    switch (decision.Kind)
    {
        case MitmDecisionKind.Forward:
            break;                                          // fall through to base.SendAsync
        case MitmDecisionKind.Modify:
            ApplyRequestModifications(request, decision.ReqMods);
            break;
        case MitmDecisionKind.Block:
            PublishMitmHttpEvent(snap, decision, blocked: true);
            throw new HttpRequestException(
                $"[MITM] Request blocked by interactive breakpoint {bp.RuleId}.");
        case MitmDecisionKind.Forge:
            var forged = decision.Forged.Materialize(request);
            PublishMitmHttpEvent(snap, decision, synthesized: true);
            return forged;
    }
}
```

Inside the coordinator:

```csharp
public Task<MitmDecision> AwaitRequestDecisionAsync(
    string interceptId, RequestSnapshot snap, RequestBreakpoint bp, CancellationToken ct)
{
    var tcs = new TaskCompletionSource<MitmDecision>(TaskCreationOptions.RunContinuationsAsynchronously);
    var timeoutCts = new CancellationTokenSource(bp.TimeoutMs > 0 ? bp.TimeoutMs : 30_000);
    var linked    = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

    var reg = linked.Token.Register(() =>
    {
        // Distinguish timeout vs. external cancellation by inspecting timeoutCts.IsCancellationRequested
        var reason = timeoutCts.IsCancellationRequested ? "timeout" : "cancelled";
        TryResolve(interceptId, MitmDecision.ForwardUnchanged(reason), publishEventName: $"mitm.{reason}Out");
    });

    var pending = new PendingIntercept(interceptId, tcs, reg, timeoutCts,
                                       bp.OwnerConnectionId, Phase.Request, bp);
    if (!_pending.TryAdd(interceptId, pending))
        throw new InvalidOperationException("Duplicate interceptId — ULID collision impossible.");

    _byOwner.AddOrUpdate(bp.OwnerConnectionId,
        _ => new HashSet<string> { interceptId },
        (_, set) => { lock (set) { set.Add(interceptId); } return set; });

    EdogTopicRouter.Publish("mitm", new {
        kind = "mitm.paused", interceptId, phase = "request",
        ruleId = bp.RuleId, ownerConnectionId = bp.OwnerConnectionId,
        deadlineUtc = DateTimeOffset.UtcNow.AddMilliseconds(bp.TimeoutMs),
        snapshot = snap.ToWire()
    });

    return tcs.Task;
}
```

**Source code paths.**

- `src/backend/DevMode/EdogHttpPipelineHandler.cs:46–128` — current `SendAsync` body; the breakpoint check inserts between L84 and L106.
- `src/backend/DevMode/MitmCoordinator.cs` *(new)* — entire file.
- `src/backend/DevMode/EdogTopicRouter.cs:34` — `mitm` topic registration (new `RegisterTopic("mitm", 1000)` line).

**Edge cases.**

- **Snapshot capture failure** (request body unreadable, e.g. multipart stream). The coordinator must still pause but the snapshot delivers `body = null, bodyError = "stream not seekable"`; the UI shows headers-only editor. The handler MUST NOT throw mid-capture — wrap in try/catch and fall through with a degraded snapshot.
- **Request body > 10 MB.** Snapshot returns `bodyTruncated = true, bodyBytes = null`. Modify decisions that include body are rejected by `SubmitDecision` with `RESUME_REJECTED_BODY_TOO_LARGE` (the original request resumes as Forward).
- **Authorization redaction conflict (R2 in P0 §4.4).** Snapshot honours `bp.RevealAuthorization` flag (default false). When false, the snapshot delivered over the wire has `headers.Authorization = "[redacted]"` — *but the original `request` object retains the real header*, so a Forward decision still works. When true, the real value travels over SignalR.
- **Cancellation token already cancelled at entry** (caller pre-cancelled). `AwaitRequestDecisionAsync` short-circuits to `Forward(reason: "pre-cancelled")` and emits `mitm.cancelled`. Never blocks an already-cancelled call.

**Interactions with other components.**

- **C02 Rule Engine** provides `bp` via `MitmRuleStore.TryMatchBreakpoint(request, out RequestBreakpoint)`. The coordinator NEVER inspects rule predicates — it consumes the matched breakpoint object only.
- **C03 SignalR Protocol** transports the `mitm.paused` payload and receives `MitmResume`.
- **C04 HTTP-tab UI** renders the paused row with the ⏸ badge (see `tab-http.js:907–943` row-rendering pattern in P0 §1.6).
- **C05 Request Editor** is opened in the Intercept detail tab using the snapshot.

**Revert / undo.** A paused intercept can be released two ways: (a) `MitmResume` with explicit decision (normal), (b) `MitmDrop(interceptId)` which is equivalent to `SubmitDecision(Forward, "user-drop")`. There is no "undo" *after* the request has resumed — the request is in flight. The audit trail (`mitm.resumed` event) is the only record.

**Priority.** **P0** — required for v1.

---

### S02 — Response breakpoint (post-response pause) **[P0]**

**One-liner.** After `base.SendAsync` returns, the handler optionally pauses again to let the user inspect/modify the response before it reaches the caller.

**Detailed description.** Symmetric to S01 but on the return path. The pipeline handler, having received an `HttpResponseMessage` from `base.SendAsync`, asks `ShouldPauseResponse(rsp, bp, out rbp)`. If true, it captures the full response body (subject to 10 MB cap), publishes `mitm.paused` with `phase = "response"`, and parks on a new TCS. Decisions: Forward (return original), Modify (mutate status/headers/body), Forge (replace with a fresh response). Block is *not* a meaningful response-phase action — the caller has already seen the request go out — so the decision validator rejects Block at this phase with `RESUME_REJECTED_INVALID_PHASE_ACTION`.

**Technical mechanism.**

```csharp
// In EdogHttpPipelineHandler.SendAsync, just after L128 (response = await base.SendAsync(...))

if (bp != null && bp.PauseOnResponse &&
    MitmCoordinator.Instance.ShouldPauseResponse(response, bp, out var rbp))
{
    var rsnap = await ResponseSnapshot.CaptureAsync(response).ConfigureAwait(false);
    var interceptId = MitmIds.NewInterceptId();
    var decision = await MitmCoordinator.Instance
                        .AwaitResponseDecisionAsync(interceptId, rsnap, rbp, cancellationToken)
                        .ConfigureAwait(false);

    switch (decision.Kind)
    {
        case MitmDecisionKind.Forward:                       break;
        case MitmDecisionKind.Modify: response = ApplyResponseModifications(response, decision.RspMods); break;
        case MitmDecisionKind.Forge:  response = decision.Forged.Materialize(request);                    break;
        // Block is rejected at submit-time.
    }
}
```

**Source code paths.**

- `src/backend/DevMode/EdogHttpPipelineHandler.cs:128` — insertion point (after the existing `base.SendAsync` call).
- `src/backend/DevMode/MitmCoordinator.cs` — `AwaitResponseDecisionAsync` mirrors `AwaitRequestDecisionAsync`.

**Edge cases.**

- **Streaming/chunked responses.** `LoadIntoBufferAsync` (already used at `EdogHttpPipelineHandler.cs:371`) materialises the stream; ensure the modified-response branch builds a fresh `HttpResponseMessage` with `ByteArrayContent` so the downstream consumer's stream-read still works.
- **Response > 10 MB.** Snapshot truncates, Modify-with-body rejected at submit, Forge always allowed (Forge supplies its own body).
- **Status code change to a redirect family (3xx).** No special handling — the request is already returning to the caller; redirect-following is the caller's HttpClient's job.
- **A pre-request breakpoint resolved as Forge.** Forge returns a synthesized response immediately; we never reach the response breakpoint check. This is correct — Forge means "the request never went out", so there's no real response to inspect.

**Interactions.** Same as S01. Coordinator distinguishes phases via `PendingIntercept.Phase`; events carry `phase: "response"`.

**Revert / undo.** Identical to S01.

**Priority.** **P0**.

---

### S03 — Forward decision (resume original) **[P0]**

**One-liner.** User clicks "Forward"; the coordinator unparks the handler with `MitmDecisionKind.Forward` and the original request proceeds untouched.

**Detailed description.** The simplest and most common decision. The frontend sends `MitmResume(interceptId, { kind: "forward" })`; the hub validates and calls `_coordinator.SubmitDecision(...)`. The coordinator looks up the `PendingIntercept`, validates the caller's `connectionId` matches the owner (or is in a whitelist for cross-tab debugging — default: must match), disposes the timeout/registration, completes the TCS with `MitmDecision.ForwardUnchanged("user")`, removes the pending entry, and publishes `mitm.resumed`. The handler thread wakes; the `switch` falls through; `base.SendAsync` runs.

**Technical mechanism.**

```csharp
public ResumeResult SubmitDecision(string interceptId, MitmDecision decision, string callerConnectionId)
{
    if (!_pending.TryGetValue(interceptId, out var p))
        return ResumeResult.NotFound;

    if (!string.Equals(p.OwnerConnectionId, callerConnectionId, StringComparison.Ordinal))
        return ResumeResult.NotOwner;     // surfaced to UI as "Another tab owns this intercept"

    var validation = MitmDecisionValidator.Validate(decision, p.Phase, p.Bp);
    if (!validation.Ok) return ResumeResult.Invalid(validation.Code);

    if (!_pending.TryRemove(interceptId, out _)) return ResumeResult.NotFound; // raced
    RemoveFromOwnerIndex(p.OwnerConnectionId, interceptId);
    p.CtRegistration.Dispose();
    p.TimeoutCts.Dispose();

    var ok = p.Tcs.TrySetResult(decision);
    Interlocked.Increment(ref _revision);

    EdogTopicRouter.Publish("mitm", new {
        kind = "mitm.resumed", interceptId,
        decision = decision.Kind.ToString().ToLowerInvariant(),
        durationMs = (DateTimeOffset.UtcNow - p.CreatedAtUtc).TotalMilliseconds,
        submittedBy = callerConnectionId
    });

    return ok ? ResumeResult.Ok : ResumeResult.AlreadyResolved;
}
```

**Source code paths.**

- `src/backend/DevMode/MitmCoordinator.cs` — `SubmitDecision`.
- `src/backend/DevMode/EdogPlaygroundHub.cs` — new region `Mitm*` RPC methods (insert after the `Qa*` region that ends near `EdogPlaygroundHub.cs:1070`).

**Edge cases.**

- **Already resolved** (timeout fired one millisecond earlier). `TrySetResult` returns false; hub returns `ResumeResult.AlreadyResolved` → UI shows "Intercept already resolved (timeout/disconnect)".
- **Wrong owner.** Returns `ResumeResult.NotOwner` — protects against a second SignalR connection accidentally resuming someone else's breakpoint.
- **Unknown interceptId.** `ResumeResult.NotFound`. The hub maps to RPC error `MITM_INTERCEPT_NOT_FOUND`.

**Interactions.** C03 carries the RPC. C04 closes the Intercept detail tab on `mitm.resumed`. C02 is untouched (no rule mutation).

**Revert / undo.** None — the request is in flight by the time the user could undo. The `mitm.resumed` audit event is the trail.

**Priority.** **P0**.

---

### S04 — Modify-and-forward decision **[P0]**

**One-liner.** User edits headers/body/URL/method (request phase) or status/headers/body (response phase) and resumes; the handler mutates the live object and proceeds.

**Detailed description.** The decision payload carries a `RequestModifications` (or `ResponseModifications`) object: `Method?, Url?, HeadersSet[], HeadersRemove[], BodyBytes?, BodyContentType?` for requests; `StatusCode?, ReasonPhrase?, HeadersSet[], HeadersRemove[], BodyBytes?, BodyContentType?` for responses. The handler applies these in-place on the `HttpRequestMessage`/`HttpResponseMessage`. **Critical**: a fresh `ByteArrayContent`/`StringContent` replaces `request.Content` when the body changes — never mutate the existing `HttpContent`, because its stream may have been partially read by the redaction/preview path (R4 in P0 §4.4). The same applies on the response side.

**Technical mechanism.**

```csharp
// Pseudo — full impl is in EdogHttpPipelineHandler private helpers.
private static void ApplyRequestModifications(HttpRequestMessage req, RequestModifications mods)
{
    if (mods.Method != null)         req.Method = new HttpMethod(mods.Method);
    if (mods.Url != null)            req.RequestUri = new Uri(mods.Url);

    foreach (var h in mods.HeadersRemove ?? Array.Empty<string>())
    {
        req.Headers.Remove(h);
        req.Content?.Headers.Remove(h);
    }
    foreach (var kv in mods.HeadersSet ?? Array.Empty<HeaderSet>())
    {
        // Try request headers first, fall back to content headers (Content-Type, etc.)
        if (!req.Headers.TryAddWithoutValidation(kv.Name, kv.Value))
            req.Content?.Headers.TryAddWithoutValidation(kv.Name, kv.Value);
    }

    if (mods.BodyBytes != null)
    {
        var fresh = new ByteArrayContent(mods.BodyBytes);
        // Preserve existing content headers, then overlay any new content-type
        if (req.Content != null)
            foreach (var ch in req.Content.Headers) fresh.Headers.TryAddWithoutValidation(ch.Key, ch.Value);
        if (!string.IsNullOrEmpty(mods.BodyContentType))
        {
            fresh.Headers.ContentType = MediaTypeHeaderValue.Parse(mods.BodyContentType);
        }
        req.Content = fresh;
    }
}
```

The coordinator itself does NOT apply modifications — it only transports the `MitmDecision`. The handler is the single place that mutates the live HTTP objects. This keeps the coordinator pure (no HTTP knowledge beyond the snapshot).

**Validator at submit-time** (in `MitmDecisionValidator`, called from `SubmitDecision`):

- `Phase == Request`: reject `mods.StatusCode` (would be a phase mismatch).
- `Phase == Response`: reject `mods.Method`, `mods.Url`.
- `BodyBytes.Length > 10 MB` → reject with `RESUME_REJECTED_BODY_TOO_LARGE`.
- Header name not RFC-7230-compliant → reject with `RESUME_REJECTED_INVALID_HEADER`.

**Source code paths.**

- `src/backend/DevMode/EdogHttpPipelineHandler.cs` — new private `ApplyRequestModifications` / `ApplyResponseModifications`.
- `src/backend/DevMode/MitmCoordinator.cs` — validator hosted here so it can be unit-tested without the handler.

**Edge cases.**

- **Header `Host` mutation.** Cannot be set via `Headers.TryAddWithoutValidation` if it conflicts with `RequestUri`. Validator rejects `Host` modifications unless `Url` is also being changed.
- **Content-Length mismatch.** Always remove `Content-Length` before setting a new body; `HttpClient` recomputes from `ByteArrayContent.Headers.ContentLength`.
- **Body change on a GET.** Allowed by HTTP spec but unusual. Surface a UI warning, but accept.
- **Modifying a server-set response header that HttpClient parses specially** (e.g. `Set-Cookie`). Use `response.Headers.TryAddWithoutValidation` after `Remove` to avoid the typed-header coercion path that can reject values.

**Interactions.** C05 Request Editor produces the `RequestModifications` payload. C03 transports it.

**Revert / undo.** None after resume. The pre-modification snapshot remains in the `mitm.paused` event; an "Undo" affordance in the UI is really "look at the old payload" — the request itself cannot be retracted.

**Priority.** **P0**.

---

### S05 — Block decision **[P0]**

**One-liner.** User clicks "Block"; the handler throws an `HttpRequestException` so the caller sees a failure as if the network had refused the request.

**Detailed description.** Block is only valid at the request phase (S01). The decision carries an optional `BlockReason` string (default `"Blocked by EDOG MITM breakpoint"`). The handler throws `HttpRequestException(blockReason)`, mirroring how a TCP RST would surface to caller code. Crucially, we still publish an `http` topic event with `statusCode = 0` and `mitm.action = "block"` so the row remains visible in the HTTP tab (otherwise the user wouldn't see the request they just blocked). This pattern is already established by the F27 P5 timeout path (`EdogHttpPipelineHandler.cs:88–103`).

**Technical mechanism.** Already shown in S01's `switch`. Plus the publish:

```csharp
PublishHttpEvent(method, url, statusCode: 0, durationMs: 0,
                 requestHeaders, responseHeaders: null,
                 responseBodyPreview: null, correlationId,
                 requestBodyPreview, requestSizeBytes, responseSizeBytes: 0,
                 chaosFault: null, synthesized: false,
                 mitm: new { action = "block", interceptId, ruleId = bp.RuleId });
throw new HttpRequestException($"[MITM] {decision.BlockReason ?? "Request blocked"}.");
```

Note the `PublishHttpEvent` signature gains an optional `mitm` annotation parameter — same pattern as the existing `chaos` block (`EdogHttpPipelineHandler.cs:200–223`).

**Source code paths.**

- `src/backend/DevMode/EdogHttpPipelineHandler.cs:183–248` — extend `PublishHttpEvent` to accept `mitm` annotation (mirror the existing `chaosFault` parameter).

**Edge cases.**

- **Caller has retry policy.** Throwing `HttpRequestException` will trigger Polly/built-in retry. This is desirable behaviour for chaos testing (we want to see retry storms) and undesirable for "I really want to kill this request once". Out of scope for the coordinator — caller-side retry is the caller's contract.
- **Block at response phase.** Validator rejects with `RESUME_REJECTED_INVALID_PHASE_ACTION` (S02 description).

**Interactions.** C04 row badge shows ⊘. The HTTP topic event drives the existing row-render path (`tab-http.js:907–943`).

**Revert / undo.** None. To "un-block" means re-issuing the request via Replay (S in future C06).

**Priority.** **P0**.

---

### S06 — Forge response decision **[P0]**

**One-liner.** User clicks "Forge"; the handler returns a fabricated `HttpResponseMessage` to the caller without ever calling `base.SendAsync` (request phase) or replacing the real response (response phase).

**Detailed description.** Forge is the most powerful MITM action — full freedom over status, headers, and body. The decision carries a `ForgedResponse { StatusCode, ReasonPhrase, Headers[], BodyBytes, BodyContentType }`. The handler builds an `HttpResponseMessage`, attaches `RequestMessage = request` for traceability, and returns it. The existing `SynthesizeErrorResponse` (`EdogHttpPipelineHandler.cs:160–173`) is the template — extended to honour arbitrary headers and content types. At the response phase, Forge replaces the original `response` object identically (the real response is discarded; we still need to dispose it to release the underlying socket).

**Technical mechanism.**

```csharp
internal static HttpResponseMessage Materialize(this ForgedResponse f, HttpRequestMessage req)
{
    var rsp = new HttpResponseMessage((HttpStatusCode)(f.StatusCode is >= 100 and <= 599 ? f.StatusCode : 200))
    {
        RequestMessage = req,
        ReasonPhrase   = f.ReasonPhrase ?? "EDOG MITM Forge",
        Content        = new ByteArrayContent(f.BodyBytes ?? Array.Empty<byte>())
    };
    foreach (var h in f.Headers ?? Array.Empty<HeaderSet>())
    {
        if (!rsp.Headers.TryAddWithoutValidation(h.Name, h.Value))
            rsp.Content.Headers.TryAddWithoutValidation(h.Name, h.Value);
    }
    if (!string.IsNullOrEmpty(f.BodyContentType))
        rsp.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(f.BodyContentType);
    return rsp;
}

// Response-phase Forge: dispose the real response before returning the forged one.
case MitmDecisionKind.Forge:
    response.Dispose();
    response = decision.Forged.Materialize(request);
    break;
```

**Source code paths.**

- `src/backend/DevMode/EdogHttpPipelineHandler.cs:160–173` — generalise `SynthesizeErrorResponse` into `ForgedResponse.Materialize` (extension method).

**Edge cases.**

- **Body > 10 MB.** Rejected at submit. Forge with a 10 MB body is allowed; >10 MB is not.
- **`Content-Length` header in `Headers[]`.** Drop and let `ByteArrayContent` compute. Validator emits a `RESUME_HEADER_AUTO_COMPUTED` warning, not a reject.
- **Disposing the original response leaks if interleaved with body capture.** We must call `response.Dispose()` AFTER any pending `LoadIntoBufferAsync` from the snapshot has completed. The coordinator guarantees this by capturing the snapshot synchronously before publishing `mitm.paused`.
- **Forge at request phase mid-base-handler.** N/A — request-phase Forge never calls `base.SendAsync`, so there's no inner handler resource to leak.

**Interactions.** C04 row badge shows ◆. C05 Request Editor exposes a "Forge" tab with a response composer.

**Revert / undo.** None.

**Priority.** **P0**.

---

### S07 — Breakpoint timeout (30 s default) **[P0]**

**One-liner.** No decision arrives within the configured timeout; the coordinator auto-resolves as Forward and publishes `mitm.timedOut`. **This is the single most important guard rail keeping F28 a testing tool, not a debugger.**

**Detailed description.** Every `PendingIntercept` is born with a `CancellationTokenSource(timeoutMs)` (default 30 000 ms; configurable per rule via `bp.TimeoutMs`; hard upper bound of 5 minutes enforced by validator). When the CTS fires, the linked `Register` callback runs, calling `TryResolve(interceptId, MitmDecision.ForwardUnchanged("timeout"), publishEventName: "mitm.timedOut")`. The handler unparks with a Forward decision and the request proceeds untouched — *exactly as if no breakpoint had ever fired*. The HTTP event published downstream carries `mitm.action = "timed-out"` so the row shows the timeout badge.

**Technical mechanism.** Implementation shown in S01 (`AwaitRequestDecisionAsync`). The shared helper:

```csharp
private void TryResolve(string interceptId, MitmDecision decision, string publishEventName)
{
    if (!_pending.TryRemove(interceptId, out var p)) return;
    RemoveFromOwnerIndex(p.OwnerConnectionId, interceptId);
    p.CtRegistration.Dispose();
    p.TimeoutCts.Dispose();
    p.Tcs.TrySetResult(decision);
    Interlocked.Increment(ref _revision);
    EdogTopicRouter.Publish("mitm", new {
        kind = publishEventName, interceptId, phase = p.Phase.ToString().ToLowerInvariant(),
        timeoutMs = p.Bp.TimeoutMs, ownerConnectionId = p.OwnerConnectionId
    });
}
```

**Source code paths.**

- `src/backend/DevMode/MitmCoordinator.cs` — `TryResolve`, called from CTS callback.

**Edge cases.**

- **Decision and timeout race.** Both call `_pending.TryRemove`; the loser is a no-op. The TCS is completed exactly once (`TrySetResult` returns false on the loser). The race is correct by construction.
- **System clock skew / suspended laptop.** `CancellationTokenSource(timeSpan)` uses `Environment.TickCount` based scheduling and survives sleep adequately for our purposes. We do not attempt wall-clock validation.
- **Caller cancellation token fires before timeout.** The linked CTS combines both; first wins. Reason becomes `"cancelled"`, event becomes `mitm.cancelled`.
- **Hub disconnects exactly when timeout fires.** Both paths invoke `TryResolve`; one succeeds, the other is a no-op.

**Interactions.** C04 listens for `mitm.timedOut` and shows a toast: *"Intercept timed out — request forwarded as-is."*

**Revert / undo.** None — by design. Timeout is a safety net, not an action.

**Priority.** **P0 — non-negotiable.** Documented as R1 in P0 §4.4.

---

### S08 — Disconnect cleanup **[P0]**

**One-liner.** When a SignalR `ConnectionId` disconnects, every pending intercept owned by it is cancelled (resolves as Forward) and every session-scoped rule it created is purged.

**Detailed description.** `EdogPlaygroundHub.OnDisconnectedAsync` (override) calls `MitmCoordinator.Instance.CancelOwner(Context.ConnectionId, "disconnect")`. The coordinator looks up `_byOwner[connectionId]`, iterates each pending interceptId, and calls `TryResolve(..., ForwardUnchanged("disconnect"), "mitm.cancelled")`. It then notifies **C02 MitmRuleStore** via `MitmRuleStore.RemoveRulesByOwner(connectionId)` to purge any session-scoped rules. The two purges are sequenced — interceptions first (release threads), rules second (so the released threads see no rules and just call base).

**Technical mechanism.**

```csharp
// EdogPlaygroundHub.cs — new override.
public override async Task OnDisconnectedAsync(Exception exception)
{
    MitmCoordinator.Instance.CancelOwner(Context.ConnectionId, "disconnect");
    MitmRuleStore.RemoveRulesByOwner(Context.ConnectionId);
    await base.OnDisconnectedAsync(exception);
}

// MitmCoordinator.cs
public void CancelOwner(string connectionId, string reason)
{
    if (!_byOwner.TryRemove(connectionId, out var set)) return;
    string[] ids;
    lock (set) { ids = set.ToArray(); }
    foreach (var id in ids)
    {
        TryResolve(id, MitmDecision.ForwardUnchanged(reason),
                   publishEventName: "mitm.cancelled");
    }
}
```

**Source code paths.**

- `src/backend/DevMode/EdogPlaygroundHub.cs:406–410` — existing `OnConnectedAsync` is the precedent; add a new override below it.
- `src/backend/DevMode/MitmCoordinator.cs` — `CancelOwner`.

**Edge cases.**

- **Reconnect before disconnect cleanup completes.** SignalR's `OnDisconnectedAsync` is called for the *old* `ConnectionId`. The new connection has a new `ConnectionId`; no overlap. The frontend MUST re-call `MitmListRules()` on reconnect (R10 in P0 §4.4) — coordinator does not migrate state.
- **`RemoveRulesByOwner` runs while another thread is matching rules.** The store is lock-free immutable-snapshot (same pattern as `EdogHttpFaultStore.cs:82–88`); in-flight matches see the old snapshot, which is correct (rule lifetime is "until purge commits").
- **OwnerType = "scenario" rule.** NOT owned by a connection — only `OwnerType = "mitm-session"` rules are purged. C02's `RemoveRulesByOwner` filters by both connection id AND owner type.

**Interactions.** C02 owns rule purge. C03 emits a final `mitm.ownerCleared` event for observability.

**Revert / undo.** None — disconnect is terminal.

**Priority.** **P0**. Closes R6 in P0 §4.4.

---

### S09 — Concurrent breakpoints **[P0]**

**One-liner.** Multiple in-flight requests can be paused simultaneously, each with its own TCS, and the user can resolve them in any order.

**Detailed description.** `_pending` is a `ConcurrentDictionary<string, PendingIntercept>`. Each `Await*Async` call allocates an independent TCS — there is no shared state between intercepts. Resolutions are independent: `SubmitDecision(idA, ...)` does not touch `idB`. The frontend renders all paused intercepts (the HTTP tab already buffers up to 2000 rows; intercepts appear inline with a ⏸ badge). Order of resolution is purely user-driven. **No back-pressure** beyond a soft cap of `MaxConcurrentIntercepts = 64` per process (enforced at `Await*Async` entry — overflow auto-resolves as Forward with reason `"capacity"` and publishes `mitm.skipped`). The cap exists to prevent runaway scenarios (e.g., user arms a breakpoint on `*` and walks away).

**Technical mechanism.**

```csharp
if (_pending.Count >= MaxConcurrentIntercepts)
{
    EdogTopicRouter.Publish("mitm", new { kind = "mitm.skipped", reason = "capacity",
                                          armedRuleId = bp.RuleId });
    return Task.FromResult(MitmDecision.ForwardUnchanged("capacity"));
}
```

**Source code paths.**

- `src/backend/DevMode/MitmCoordinator.cs` — guard at the top of `Await*Async`.

**Edge cases.**

- **Two intercepts share the same rule.** Rule lifecycle counters (handled in C02) are decremented under a per-rule lock; the coordinator does not touch them.
- **64-cap reached during a stress test.** Soft cap; the publish event is the diagnostic. Users can raise via env var `EDOG_MITM_MAX_INTERCEPTS`.
- **Thread-pool starvation.** Each suspended request consumes one thread (the handler thread). Default ASP.NET thread pool is generous; the cap of 64 keeps this bounded. Document in operations runbook.

**Interactions.** C04 renders a "N paused" badge on the HTTP tab toolbar.

**Revert / undo.** Any single pending intercept can be resolved with `MitmDrop(interceptId)`. To clear all: kill switch (S12).

**Priority.** **P0**.

---

### S10 — Capability gating **[P0]**

**One-liner.** F28 MITM interactive mode is OFF by default; enabled only when BOTH the build constant `MitmInteractivePipelineWired = true` AND the env var `EDOG_MITM_INTERACTIVE=1` are set. `MitmGetCapabilities()` reports the gate state.

**Detailed description.** Mirrors `EdogQaCapabilityRegistry` (`EdogQaCapabilityRegistry.cs:60–143`). The build constant is a code-level wire gate — it flips on once C01+C02+C03 have all shipped, preventing partial-build runtime surprises. The env var is the operator-facing opt-in. When either is false, `ShouldPauseRequest`/`ShouldPauseResponse` short-circuit to `false` with zero allocation, `Await*Async` is never called, and `MitmGetCapabilities()` returns `{ Enabled: false, Reason: "..." }`. Capability state is captured at process start (env var read once, cached) so there is no hot-path env-var lookup.

**Technical mechanism.**

```csharp
internal static class MitmCoordinator
{
    private const bool MitmInteractivePipelineWired = false; // flip true on C03 ship.
    internal const string EnvVarInteractive = "EDOG_MITM_INTERACTIVE";

    private static readonly bool _enabled = ResolveEnabledOnce();
    private static bool ResolveEnabledOnce()
    {
        if (!MitmInteractivePipelineWired) return false;
        try
        {
            var v = Environment.GetEnvironmentVariable(EnvVarInteractive);
            return string.Equals(v, "1", StringComparison.Ordinal)
                || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    public bool ShouldPauseRequest(HttpRequestMessage req, out RequestBreakpoint bp)
    {
        bp = null;
        if (!_enabled) return false;                        // ← fast path
        return MitmRuleStore.TryMatchBreakpoint(req, out bp);
    }

    public MitmCapabilityReport GetCapabilities() => new()
    {
        Enabled              = _enabled,
        PipelineWired        = MitmInteractivePipelineWired,
        EnvVarSet            = Environment.GetEnvironmentVariable(EnvVarInteractive) is "1" or "true",
        SupportedActions     = _enabled ? new[] { "forward", "modify", "block", "forge" } : Array.Empty<string>(),
        DefaultTimeoutMs     = 30_000,
        MaxConcurrentIntercepts = MaxConcurrentIntercepts,
        Reason               = _enabled
            ? "OK"
            : !MitmInteractivePipelineWired
                ? "MITM pipeline is not wired in this build."
                : $"Disabled. Set {EnvVarInteractive}=1 to enable."
    };
}
```

**Source code paths.**

- `src/backend/DevMode/MitmCoordinator.cs` — gate logic.
- `src/backend/DevMode/EdogPlaygroundHub.cs` — new `Task<MitmCapabilityReport> MitmGetCapabilities()` hub method, alongside `QaGetCapabilities` (`EdogPlaygroundHub.cs:1055`).
- `src/backend/DevMode/EdogQaCapabilityRegistry.cs` — *optional* surface `IsMitmInteractiveSupported` to keep one capability source.

**Edge cases.**

- **Env var changed mid-process.** Ignored — read once. Restart required to flip. This is consistent with `EdogQaCapabilityRegistry.IsHttpChaosBackendEnabled` semantics (cache is "caller's responsibility" per `EdogQaCapabilityRegistry.cs:178–180`, but here we choose process-lifetime cache for hot-path safety).
- **Hub method called when disabled.** Returns the disabled report; UI hides the Intercept toggle and shows a tooltip with the reason.
- **A rule somehow exists in the store while `_enabled = false`.** Defence-in-depth: `ShouldPauseRequest` short-circuits before touching the store. C02 store should refuse `AddRule` when capability is off, but C01 does not depend on that.

**Interactions.** C03 exposes the RPC; C04 reads the report at startup and renders the Intercept toggle accordingly.

**Revert / undo.** Set `EDOG_MITM_INTERACTIVE=0` (or unset) and restart FLT.

**Priority.** **P0**.

---

### S11 — Rule precedence (interactive > scenario > session) **[P0]**

**One-liner.** When multiple rule sources could affect the same request, the coordinator and handler enforce a single deterministic evaluation order.

**Detailed description.** A request entering `SendAsync` could match (a) an interactive breakpoint rule (`OwnerType = "mitm-session"`, `IsBreakpoint = true`), (b) an F27 P5 scenario chaos rule (`OwnerType = "scenario"`), or (c) a future F24 session rule (`OwnerType = "chaos-panel"`, non-breakpoint mutation). The handler asks each source in order; **the first match wins and short-circuits**. R8 in P0 §4.4 mandates this.

**Order:**

1. **Interactive breakpoint** (`MitmRuleStore.TryMatchBreakpoint`) — only matches rules with `IsBreakpoint = true`. Wins because the user explicitly armed it.
2. **Scenario chaos fault** (`EdogHttpFaultStore.TryMatchFault`, existing F27 P5) — wins next because a running scenario is a structured test.
3. **Session non-breakpoint rule** (`MitmRuleStore.TryMatchAutoApply`) — auto-apply rules without pause (Modify/Forge/Block as set-and-forget). Lowest precedence so a casually-armed session rule cannot override an in-progress scenario.

**Technical mechanism.**

```csharp
// EdogHttpPipelineHandler.SendAsync — replaces the F27 P5 single-source chaos lookup at L80–84.

RequestBreakpoint bp = null;
HttpFaultEntry    chaosFault = null;
AutoApplyRule     autoRule = null;

if (MitmCoordinator.Instance.ShouldPauseRequest(request, out bp))
{
    // (S01 path)
}
else if (request.RequestUri != null
         && EdogHttpFaultStore.TryMatchFault(request.RequestUri.AbsoluteUri, out chaosFault))
{
    // existing F27 P5 path (unchanged)
}
else if (MitmRuleStore.TryMatchAutoApply(request, out autoRule))
{
    // C02 auto-apply path (Modify/Forge/Block without pause)
}
```

The coordinator does not own the F27 P5 fault store lookup — the handler does. But the coordinator publishes a `mitm.precedence` diagnostic event when it detects that an interactive breakpoint preempted a scenario fault (rare, useful for QA debugging):

```csharp
if (bp != null && chaosFault != null /* would have also matched */)
    EdogTopicRouter.Publish("mitm", new {
        kind = "mitm.precedence",
        interactiveRuleId = bp.RuleId,
        suppressedScenarioId = chaosFault.ScenarioId
    });
```

**Source code paths.**

- `src/backend/DevMode/EdogHttpPipelineHandler.cs:80–84` — replace the single chaos lookup with the layered match.
- `src/backend/DevMode/MitmCoordinator.cs` — precedence diagnostic emit.

**Edge cases.**

- **A scenario and a session rule match the same URL with different actions.** The handler's layered check short-circuits at the first match; no merge semantics. Document loudly so users don't expect "combine block + delay".
- **Interactive breakpoint AND scenario fault both want to act.** Interactive wins; scenario is silently skipped for this request. This may cause a scenario assertion to fail; that's the testing-tool contract — interactive override is opt-in by the user and they should know.
- **Auto-apply rule precedence conflict with another auto-apply rule.** C02's store guarantees deterministic match order (first-wins by `CreatedAtUtc`). Out of scope for the coordinator.

**Interactions.** C02 provides `TryMatchBreakpoint` and `TryMatchAutoApply`. F27 P5's `EdogHttpFaultStore` is unchanged.

**Revert / undo.** Remove the interactive rule (via `MitmDeleteRule`) to let the scenario fault win on the next request.

**Priority.** **P0**.

---

### S12 — Kill switch (Ctrl+Shift+K) **[P0]**

**One-liner.** A single keystroke cancels every pending intercept and purges every session-scoped MITM rule, process-wide.

**Detailed description.** Mirrors F24's kill switch (`docs/specs/features/F24-chaos-engineering/spec.md:143`). The frontend captures `Ctrl+Shift+K` globally (regardless of focus) and invokes `MitmClearAll()`. The hub calls `MitmCoordinator.Instance.ClearAllPending("kill-switch")` followed by `MitmRuleStore.RemoveAllSessionRules()`. **Decision:** unlike disconnect-cancel (which resolves as Forward), kill-switch resolves as **Forward** as well — the user wants the system to recover, and forwarding paused requests is the path of least surprise. (Blocking would leave the caller's retry logic to deal with phantom failures; we explicitly choose not to.)

**Technical mechanism.**

```csharp
public int ClearAllPending(string reason)
{
    var ids = _pending.Keys.ToArray();
    foreach (var id in ids)
    {
        TryResolve(id, MitmDecision.ForwardUnchanged(reason),
                   publishEventName: "mitm.cancelled");
    }
    EdogTopicRouter.Publish("mitm", new {
        kind = "mitm.killSwitch",
        clearedCount = ids.Length,
        reason
    });
    return ids.Length;
}

// EdogPlaygroundHub.cs — new RPC.
public Task<MitmKillSwitchResult> MitmClearAll()
{
    var pending = MitmCoordinator.Instance.ClearAllPending("kill-switch");
    var rules   = MitmRuleStore.RemoveAllSessionRules();
    return Task.FromResult(new MitmKillSwitchResult
    {
        InterceptsReleased = pending,
        RulesPurged        = rules,
        AtUtc              = DateTimeOffset.UtcNow
    });
}
```

**Source code paths.**

- `src/backend/DevMode/MitmCoordinator.cs` — `ClearAllPending`.
- `src/backend/DevMode/EdogPlaygroundHub.cs` — `MitmClearAll` RPC.
- `src/frontend/js/tab-http.js` (C04) — global keybind.

**Edge cases.**

- **Kill switch fired with no pending intercepts.** No-op for pending; rules may still be purged. `clearedCount = 0` and the event is still published (audit trail for ops).
- **Kill switch fires while a `MitmResume` is in-flight.** Both call `_pending.TryRemove`; loser is a no-op. Single TCS completion guaranteed.
- **Scenario chaos rules.** NOT purged by the MITM kill switch — they belong to F27 P5. A separate global kill switch (or scenario cancellation) handles those. Document this distinction in the UI tooltip.
- **Operator wants a "hard block" kill switch variant.** Add `MitmClearAll(MitmKillMode mode)` later; default is `Forward`. Out of scope for v1.

**Interactions.** C04 owns the keybind. C03 carries the RPC. C02 purges rules.

**Revert / undo.** None — kill switch is terminal. Users re-arm rules manually after.

**Priority.** **P0**.

---

## 4. Cross-cutting concerns

### 4.1 Concurrency model

- `_pending`: `ConcurrentDictionary<string, PendingIntercept>` — lock-free add/remove, atomic `TryRemove` is the canonical race-resolution primitive.
- `_byOwner`: `ConcurrentDictionary<string, HashSet<string>>` — the inner `HashSet` is mutated under a per-set `lock(set)`. Acceptable: per-connection contention is bounded by user activity.
- `_revision`: `long` updated via `Interlocked.Increment`.
- TCS uses `TaskCreationOptions.RunContinuationsAsynchronously` — prevents the resuming thread (hub RPC thread) from accidentally running the entire post-suspension handler continuation inline.

### 4.2 Memory & lifetime

- Each `PendingIntercept` retains the request snapshot **only** for the duration of the suspension; on resolve it is released for GC. Snapshots are byte-budgeted (≤10 MB body) so the worst case at the 64-intercept cap is ~640 MB — bounded.
- No `IDisposable` on `MitmCoordinator` itself; it is a process-singleton.
- `CancellationTokenSource`s are disposed in `TryResolve`; never leaked on the happy or unhappy path.

### 4.3 Observability

Every state transition emits a `mitm` topic event. Topic registered at process start with a 1000-event ring (consistent with the `http` topic's 2000-event ring; MITM control-plane is lower volume). The event schema is owned by C03; the coordinator only consumes `EdogTopicRouter.Publish("mitm", anonObj)`.

### 4.4 Failure semantics

| Failure | Coordinator behaviour |
|---|---|
| `Await*Async` throws before TCS created | Propagates to handler; handler treats as Forward (defensive: never block real traffic on coordinator bug). |
| TCS already completed when `SubmitDecision` arrives | `ResumeResult.AlreadyResolved` returned to hub; logged. |
| Topic publish throws | Caught and swallowed (consistent with `EdogHttpPipelineHandler.cs:244–247`). Never let observability break the pipeline. |
| `MitmRuleStore` throws during match | Catch in `ShouldPauseRequest`, log, return false (Forward). The pipeline is never broken by a store bug. |

### 4.5 Test surface

- Unit-testable in isolation: feed `MitmCoordinator` synthetic requests via a test harness that mocks the rule store; assert TCS completion, event emission, timeout firing.
- Mirror `EdogHttpFaultStore.ResetForTesting` (`EdogHttpFaultStore.cs:199–205`) with `MitmCoordinator.ResetForTesting()` that clears `_pending`/`_byOwner` and resets `_revision`. Internal, not on the SignalR surface.
- Sentinel quality gates demand: timeout test, concurrent-intercept test, disconnect-cancel test, kill-switch test, owner-validation test, double-resolve race test.

---

## 5. File touch list

**New files** (created by C01):

- `src/backend/DevMode/MitmCoordinator.cs` — the class.
- `src/backend/DevMode/MitmIds.cs` — ULID/correlation id helper (≤30 LOC).
- `src/backend/DevMode/MitmDecision.cs` + `MitmDecisionValidator.cs` — DTOs and validator.
- `src/backend/DevMode/RequestSnapshot.cs` + `ResponseSnapshot.cs` — buffered captures.

**Edited files**:

- `src/backend/DevMode/EdogHttpPipelineHandler.cs:46–153` — insert breakpoint hooks at request phase (between L84 and L106) and response phase (after L128); extend `PublishHttpEvent` (L183) with a `mitm` annotation parameter; add private apply-modifications helpers.
- `src/backend/DevMode/EdogPlaygroundHub.cs:1070` (after `QaCompareRuns`) — add `MitmGetCapabilities`, `MitmResume`, `MitmDrop`, `MitmClearAll` RPC methods + `OnDisconnectedAsync` override near L410.
- `src/backend/DevMode/EdogTopicRouter.cs:34` — `RegisterTopic("mitm", 1000)`.
- `src/backend/DevMode/EdogQaCapabilityRegistry.cs` — *optional* `IsMitmInteractiveSupported` getter, for single-source capability reporting.

---

## 6. Open questions for P1 review

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should the default-timeout Forward emit a synthetic 504 to the caller instead of forwarding silently? | **No** — silent forward keeps F28 a testing tool. Emitting 504 would surprise callers that armed the breakpoint without expecting failure. The event is the audit trail. |
| Q2 | Owner identity — `Context.ConnectionId` (per-tab) vs. a session cookie (per-user across tabs)? | **ConnectionId**. Per-tab isolation matches the "open multiple Runtime Views" workflow and disconnect-cancel becomes trivial. |
| Q3 | Should `MitmDrop` exist as a separate RPC, or just be `MitmResume(forward, reason: "drop")`? | **Separate RPC.** Different UI affordance (Drop = explicit "I changed my mind"), different audit reason. Implementation is two lines either way. |
| Q4 | Should the coordinator emit `mitm.precedence` for *every* preempted source, or only when a scenario fault is suppressed? | **Only when a structured test source is suppressed** (scenario). Suppressing another session-rule auto-apply is too noisy. |
| Q5 | `MaxConcurrentIntercepts = 64` — too high? too low? | Survey users in P2 dogfood. 64 is the F24 spec's default. |

---

## 7. Acceptance — when is C01 "done"?

- [ ] `MitmCoordinator.cs` implements every public method in §2.
- [ ] `EdogHttpPipelineHandler.SendAsync` calls `ShouldPauseRequest` and `ShouldPauseResponse`; both Forward and Modify branches preserve existing F27 P5 behaviour when no MITM rules are armed (regression-test against `chaos` events).
- [ ] `OnDisconnectedAsync` override is in place and cancels all owner intercepts in <100 ms for 64 concurrent intercepts.
- [ ] Timeout test: arm a breakpoint, wait 30 s, observe Forward + `mitm.timedOut`.
- [ ] Kill-switch test: arm 10 intercepts, fire `MitmClearAll`, observe 10× `mitm.cancelled` + zero leaked TCS (verified via `_pending.Count == 0` and `_byOwner.Count == 0`).
- [ ] Capability disabled by default: fresh process with no env var → `MitmGetCapabilities().Enabled == false` and `ShouldPauseRequest` returns false in zero allocations (BenchmarkDotNet pass).
- [ ] Sentinel-approved unit suite green; existing F27 P5 chaos integration tests still green.

---

*End of C01. Next deep specs: C02 MitmRule + MitmRuleStore (storage + matching), C03 SignalR Protocol (wire shape, validation, error envelopes), C04 HTTP-tab UI extensions, C05 Request Editor extraction, C06 Replay Service.*
