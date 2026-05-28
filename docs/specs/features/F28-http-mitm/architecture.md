# F28 — HTTP MITM · P2 Architecture

> **Author:** Sana (architecture)
> **Phase:** P2 (architecture)
> **Status:** authoritative for implementation
> **Scope:** simplified per CEO trim — intercept + edit + forward/block/forge + "Send to API Playground". Nothing else.

---

## 0. Scope Reaffirmation (read this first)

F28 ships **two** capabilities. Anything outside this list is explicitly out-of-scope and the components below are designed to *not need it*:

1. **MITM.** A request flowing through `EdogHttpPipelineHandler` can be paused, the user can inspect/edit method-URL-headers-body, and resume with `forward | modify | block | forge`. Right-click context menu, intercept toggle.
2. **Send to API Playground.** Any captured row → opens the existing API Playground tab pre-filled with that request.

Explicitly **dropped** from the P1 component specs (C01–C04):

| Dropped | Why |
|---|---|
| Causal replay, time-travel forgery | Out of CEO scope |
| Stateful breakpoints, scenario-recorder | Out of CEO scope |
| `Probability`, `MaxFirings`, `ExpiresAt` rule lifecycle | YAGNI for the two-feature surface |
| `MitmUpdateRule` RPC | Replace via Delete + Create; one fewer method to test |
| `MitmRevealSecret` RPC + reveal-auth wire path | High security cost, low value; redaction is unconditional |
| `mitm.ruleMatched` non-breakpoint firing event | We only fire breakpoint rules in v1 |
| Response body modify, response status/header modify | Pre-request forge already covers the use case |
| Per-rule action zoo (10 sub-actions) | Collapsed to 5 actions: `breakpoint`, `block`, `forge`, `modify` (request only), `passthrough` |

What survives from the P1 specs: the FrozenDictionary store pattern, the coordinator/TCS pause-resume model, owner-scoped purge, timeout safety, the kill switch, the `mitm` topic, the additive `data.mitm` block on `http` topic events.

Both pre-request and post-response suspension survive — the user explicitly asked for both. Post-response uses the **same** code path; the difference is which phase the rule applies to and what the snapshot contains.

---

## §1. Data Model

All shapes are wire-stable. Field naming on the wire is `camelCase` (default SignalR JSON serializer). C# sketches use PascalCase per `## C#` style guide.

### 1.1 `MitmRule` — the rule shape

The single source of truth for what to intercept. Stored in `MitmRuleStore`, exchanged over `MitmCreateRule` / `MitmListRules` / topic events.

**JSON wire shape**

```json
{
  "id": "rule-01HF8M7G3X...",
  "name": "Pause OneLake list calls",
  "ownerConnectionId": "Aq8w7Lb1...",
  "enabled": true,
  "priority": 100,

  "match": {
    "urlPattern": { "kind": "substring", "value": "/Tables" },
    "methods":    ["GET", "POST"],
    "httpClientName": null,
    "phase": "request"
  },

  "action": {
    "type": "breakpoint",
    "config": {
      "timeoutMs": 30000
    }
  },

  "createdAtUtc": "2026-08-12T17:42:11.123Z",
  "fireCount": 0
}
```

**Field reference**

| Field | Type | Notes |
|---|---|---|
| `id` | string, `rule-` + ULID | Server-assigned when client omits. Stable across the connection. |
| `name` | string, ≤80 chars | UI label only. |
| `ownerConnectionId` | string | SignalR `Context.ConnectionId`. Auto-purged on disconnect. Set server-side; clients never send this. |
| `enabled` | bool | User-toggleable. Disabled rules are skipped by the matcher but kept in the store. |
| `priority` | int, default 100 | Lower fires first. Tie-breaker is `createdAtUtc` (older wins). |
| `match.urlPattern.kind` | `substring \| regex \| exact` | `substring` = case-insensitive `IndexOf ≥ 0` (matches existing `EdogHttpFaultStore` behaviour). `regex` is compiled at insert time. |
| `match.urlPattern.value` | string | Compiled exactly once at insert; reader hot path never compiles. |
| `match.methods` | string[] \| empty | Empty = any. Uppercased on insert. |
| `match.httpClientName` | string \| null | Matches `EdogHttpPipelineHandler._httpClientName`. Null = any. |
| `match.phase` | `request \| response` | A rule fires at exactly one suspension point. |
| `action.type` | `breakpoint \| block \| forge \| modify \| passthrough` | See 1.5. |
| `action.config` | object, action-specific | See 1.5. |
| `createdAtUtc` | ISO-8601 | Server-stamped. |
| `fireCount` | long | Server-mutated counter. Read-only on the wire. |

**C# sketch** (`src/backend/DevMode/MitmRule.cs`)

```csharp
internal sealed class MitmRule
{
    public string Id { get; init; }
    public string Name { get; init; }
    public string OwnerConnectionId { get; init; }
    public bool   Enabled { get; init; }
    public int    Priority { get; init; }
    public MitmMatch  Match  { get; init; }
    public MitmAction Action { get; init; }
    public DateTimeOffset CreatedAtUtc { get; init; }
}

internal sealed class MitmMatch
{
    public MitmUrlPattern UrlPattern { get; init; }
    public string[]       Methods    { get; init; }   // upper-case; empty = any
    public string         HttpClientName { get; init; }
    public MitmPhase      Phase { get; init; }        // Request | Response
}

internal sealed class MitmUrlPattern
{
    public MitmUrlMatchKind Kind { get; init; }
    public string Value { get; init; }
    public Regex  Compiled { get; init; }             // populated at insert time when Kind == Regex
}

internal enum MitmUrlMatchKind { Substring, Regex, Exact }
internal enum MitmPhase { Request, Response }

internal abstract class MitmAction
{
    public MitmActionType Type { get; init; }
}
internal sealed class MitmBreakpointAction : MitmAction
{
    public int TimeoutMs { get; init; } = 30_000;     // clamped 1000..60_000
}
internal sealed class MitmBlockAction : MitmAction
{
    public int StatusCode { get; init; } = 503;       // clamped 100..599
    public string Body { get; init; }
    public Dictionary<string,string> Headers { get; init; }
}
internal sealed class MitmForgeAction : MitmAction
{
    public int StatusCode { get; init; } = 200;
    public string Body { get; init; }
    public Dictionary<string,string> Headers { get; init; }
    public string ReasonPhrase { get; init; }
}
internal sealed class MitmModifyAction : MitmAction
{
    public string ReplacementUrl { get; init; }       // null = unchanged
    public Dictionary<string,string> SetHeaders { get; init; }
    public string[] RemoveHeaders { get; init; }
    public string ReplacementBody { get; init; }      // null = unchanged
}
internal sealed class MitmPassthroughAction : MitmAction { } // matches but does nothing — used to silence broader rules

internal enum MitmActionType { Breakpoint, Block, Forge, Modify, Passthrough }

// Runtime mutable counter (sibling, not part of immutable MitmRule):
internal sealed class MitmRuleRuntime
{
    public long FireCount;                            // Interlocked.Increment
    public DateTimeOffset? LastFiredAtUtc;            // best-effort
}
```

**Implementation rules**

- `MitmRule` is an immutable snapshot. Mutating fields (`FireCount`) live on the sibling `MitmRuleRuntime`. Store entries are `(MitmRule, MitmRuleRuntime)` tuples.
- `MitmUrlPattern.Compiled` is populated **exactly once** in `MitmRuleStore.AddOrReplace`. The reader hot path never calls `new Regex(...)`.
- Equality is `Id`-based; same `Id` on insert ⇒ last-writer-wins.

### 1.2 `MitmInterceptSnapshot` — what the frontend receives on pause

Published as the payload of the `mitm.breakpointHit` topic event. Built by `MitmCoordinator` immediately before parking the handler thread.

```json
{
  "interceptId": "int-01HF8M7G3X...",
  "ruleId": "rule-01HF8...",
  "ruleName": "Pause OneLake list calls",
  "phase": "request",
  "ownerConnectionId": "Aq8w7Lb1...",
  "createdAtUtc": "2026-08-12T17:42:11.123Z",
  "deadlineUtc":  "2026-08-12T17:42:41.123Z",
  "timeoutMs": 30000,

  "request": {
    "method": "GET",
    "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?sig=[redacted]",
    "headers": { "Authorization": "[redacted]", "User-Agent": "FabricLiveTable/1.0" },
    "body": null,
    "bodyBytes": 0,
    "bodyTruncated": false,
    "httpClientName": "OneLakeRestClient",
    "correlationId": "abc-123"
  },

  "response": null
}
```

For `phase: "response"` the same envelope additionally carries a non-null `response`:

```json
"response": {
  "statusCode": 200,
  "headers": { "Content-Type": "application/json" },
  "body": "{ \"value\": [...] }",
  "bodyBytes": 842,
  "bodyTruncated": false,
  "durationMs": 142.37
}
```

**C# sketch** (`src/backend/DevMode/MitmInterceptSnapshot.cs`)

```csharp
internal sealed class MitmInterceptSnapshot
{
    public string InterceptId { get; init; }
    public string RuleId { get; init; }
    public string RuleName { get; init; }
    public MitmPhase Phase { get; init; }
    public string OwnerConnectionId { get; init; }
    public DateTimeOffset CreatedAtUtc { get; init; }
    public DateTimeOffset DeadlineUtc { get; init; }
    public int TimeoutMs { get; init; }

    public MitmRequestSnapshot Request { get; init; }
    public MitmResponseSnapshot Response { get; init; }   // null on phase == Request
}

internal sealed class MitmRequestSnapshot
{
    public string Method { get; init; }
    public string Url { get; init; }                       // SAS-token redacted
    public Dictionary<string,string> Headers { get; init; }// Authorization redacted
    public string Body { get; init; }                      // null when binary/oversized
    public long   BodyBytes { get; init; }
    public bool   BodyTruncated { get; init; }
    public string HttpClientName { get; init; }
    public string CorrelationId { get; init; }
}

internal sealed class MitmResponseSnapshot
{
    public int StatusCode { get; init; }
    public Dictionary<string,string> Headers { get; init; }
    public string Body { get; init; }
    public long   BodyBytes { get; init; }
    public bool   BodyTruncated { get; init; }
    public double DurationMs { get; init; }
}
```

**Capture rules**

- `Url` is redacted by `EdogHttpPipelineHandler.RedactUrl` (line 253) — reused as-is.
- `Headers["Authorization"]` is unconditionally `"[redacted]"`. There is **no** opt-in reveal in v1.
- `Body` follows the existing pipeline rules: 4 KB preview for non-modify paths, full body up to 10 MB when `phase == Request` and the snapshot is destined for a `modify`-capable editor. The coordinator passes a flag to `MitmRequestSnapshot.CaptureAsync(req, fullBody: true)`.
- `BodyTruncated == true` ⇒ frontend disables the body editor and shows a hint "Body > 10 MB — cannot modify; use Forward or Forge".

### 1.3 `MitmDecision` — the frontend → backend resume payload

Sent via `MitmResumeBreakpoint(decision)`. Drives the suspension exit branch.

```json
{
  "interceptId": "int-01HF8M7G3X...",
  "verdict": "modify",
  "modifications": {
    "method": "POST",
    "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?$top=10",
    "setHeaders": { "X-Custom": "edited" },
    "removeHeaders": ["x-ms-version"],
    "body": "{\"edited\":true}"
  },
  "forge": null,
  "block": null,
  "noteForAudit": "Reduced page size for repro."
}
```

**Verdict-specific shape (exactly one block populated)**

| `verdict` | Required block | Coordinator branch |
|---|---|---|
| `"forward"` | none | fall through to `base.SendAsync(request)` unchanged |
| `"modify"` | `modifications` | mutate `HttpRequestMessage` then `base.SendAsync` (request phase) **or** mutate the `HttpResponseMessage` content (response phase) |
| `"block"`  | `block`  | synthesize a response (request phase only); reject on response phase |
| `"forge"`  | `forge`  | synthesize a response — semantically identical to `block`, kept distinct so `mitm.breakpointResumed` can label the audit event differently |

**C# sketch** (`src/backend/DevMode/MitmDecision.cs`)

```csharp
internal sealed class MitmDecision
{
    public string Verdict { get; init; }              // forward | modify | block | forge
    public MitmModifications Modifications { get; init; }
    public MitmForgePayload  Forge { get; init; }
    public MitmForgePayload  Block { get; init; }     // same shape as Forge
    public string NoteForAudit { get; init; }
    public string SubmittedByConnectionId { get; init; }

    internal static MitmDecision ForwardUnchanged(string reason)
        => new() { Verdict = "forward", NoteForAudit = $"auto:{reason}" };
}

internal sealed class MitmModifications
{
    public string Method { get; init; }               // null = unchanged
    public string Url { get; init; }                  // null = unchanged
    public Dictionary<string,string> SetHeaders { get; init; }
    public string[] RemoveHeaders { get; init; }
    public string Body { get; init; }                 // null = unchanged
}
```

### 1.4 `MitmForgePayload` — the forged response shape

Used by `verdict: "block"` and `verdict: "forge"`, and as `MitmBlockAction` / `MitmForgeAction` config when the rule's action is non-interactive.

```json
{
  "statusCode": 503,
  "reasonPhrase": "Service Unavailable",
  "headers": { "Content-Type": "application/json", "Retry-After": "5" },
  "body": "{\"error\":\"injected\"}"
}
```

**Materialisation** (identical to `EdogHttpPipelineHandler.SynthesizeErrorResponse` at line 160; F28 generalises it):

```csharp
internal sealed class MitmForgePayload
{
    public int StatusCode { get; init; }              // 100..599 — validated server-side
    public string ReasonPhrase { get; init; }
    public Dictionary<string,string> Headers { get; init; }
    public string Body { get; init; }

    internal HttpResponseMessage Materialize(HttpRequestMessage req)
    {
        var msg = new HttpResponseMessage((HttpStatusCode)StatusCode)
        {
            RequestMessage = req,
            ReasonPhrase = ReasonPhrase ?? $"MITM forged {StatusCode}",
            Content = new StringContent(Body ?? string.Empty),
        };
        if (Headers != null)
        {
            foreach (var (k, v) in Headers)
            {
                // Try response headers first, then content headers (matches HttpClient semantics).
                if (!msg.Headers.TryAddWithoutValidation(k, v))
                    msg.Content.Headers.TryAddWithoutValidation(k, v);
            }
        }
        return msg;
    }
}
```

### 1.5 `PlaygroundTransfer` — the "Send to Playground" envelope

Click any captured HTTP row → "Send to API Playground" in the context menu → the row is converted into a `PlaygroundTransfer`, the API Playground tab is activated, and `RequestBuilder.setRequest()` is called.

```json
{
  "source": "http-tab",
  "sourceRowId": 8472,
  "interceptId": null,
  "method": "GET",
  "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables",
  "headers": [
    { "name": "Content-Type", "value": "application/json" }
  ],
  "body": null,
  "tokenType": "fabric"
}
```

**Field reference**

| Field | Type | Notes |
|---|---|---|
| `source` | `"http-tab"` \| `"mitm-paused"` | `mitm-paused` is reserved for opening Playground from a live breakpoint snapshot. |
| `sourceRowId` | int \| null | The original `_id` of the row in `tab-http.js` ring buffer. Used for the toast "Sent row #8472 to Playground". |
| `interceptId` | string \| null | Set when source is a live paused intercept (so Playground can show "captured at breakpoint" badge). |
| `method`, `url`, `headers`, `body` | — | The format `RequestBuilder.setRequest()` already accepts (`api-playground.js:1036`). `headers` is `[{name, value}]`, not a map. |
| `tokenType` | string \| null | Honours Playground's existing pinned-token-type field (`api-playground.js:1042`). |

**Frontend-only by default.** The transfer is built client-side from the row data already streamed via the `http` topic; no SignalR round-trip needed unless the row's body was truncated (>4 KB preview). When the body is truncated, the client invokes `MitmSendToPlayground(rowId)` which returns the un-truncated body (server reads from its in-memory `http` topic buffer) and an audit envelope.

**C# sketch** — only relevant when the server-side fetch path is used:

```csharp
internal sealed class MitmPlaygroundTransferResult
{
    public bool Success { get; init; }
    public string Message { get; init; }
    public PlaygroundTransferPayload Payload { get; init; }
}

internal sealed class PlaygroundTransferPayload
{
    public string Source { get; init; }
    public long? SourceRowId { get; init; }
    public string InterceptId { get; init; }
    public string Method { get; init; }
    public string Url { get; init; }
    public List<KeyValuePair<string,string>> Headers { get; init; }
    public string Body { get; init; }                   // un-truncated, ≤10 MB
    public string TokenType { get; init; }
}
```

---

## §2. Core Engine — `MitmCoordinator`

Single static singleton (matches the existing DevMode pattern — `EdogHttpFaultStore`, `EdogTopicRouter`). New file: `src/backend/DevMode/MitmCoordinator.cs`.

### 2.1 Public surface

```csharp
internal static class MitmCoordinator
{
    // Hot-path predicates — called from EdogHttpPipelineHandler.SendAsync.
    public static bool ShouldPauseRequest(HttpRequestMessage req, string httpClientName,
                                          out MitmRule matchedRule);
    public static bool ShouldPauseResponse(HttpResponseMessage rsp, MitmRule requestPhaseMatch,
                                            HttpRequestMessage req, string httpClientName,
                                            out MitmRule matchedRule);

    // Suspension — returns the user's decision; awaited by the handler.
    public static Task<MitmDecision> AwaitDecisionAsync(string interceptId,
                                                        MitmInterceptSnapshot snap,
                                                        MitmRule matchedRule,
                                                        CancellationToken handlerCt);

    // Resume API — called from EdogPlaygroundHub.MitmResumeBreakpoint.
    public static MitmResumeResult SubmitDecision(string interceptId, MitmDecision decision,
                                                   string callerConnectionId);

    // Owner cleanup + kill switch.
    public static int CancelOwner(string connectionId, string reason);
    public static int ClearAllPending(string reason);

    // Toggle (global pass-through switch).
    public static bool InterceptionEnabled { get; }
    public static void SetInterceptionEnabled(bool enabled, string callerConnectionId);

    // Capabilities — single source of truth for the UI gate.
    public static MitmCapabilityReport GetCapabilities(string connectionId);

    // Diagnostics.
    public static IReadOnlyList<MitmPendingIntercept> ListPending();
    public static long Revision { get; }
}
```

### 2.2 Private state

```csharp
private static readonly ConcurrentDictionary<string, PendingIntercept> _pending = new();
private static readonly ConcurrentDictionary<string, HashSet<string>>  _byOwner = new(); // connId → interceptIds
private static long _revision;
private static volatile bool _interceptionEnabled = true;

private const int DefaultTimeoutMs = 30_000;
private const int MaxConcurrentBreakpoints = 64;       // §6 cap

private sealed class PendingIntercept
{
    public string InterceptId;
    public TaskCompletionSource<MitmDecision> Tcs;
    public CancellationTokenSource TimeoutCts;
    public CancellationTokenRegistration LinkedReg;
    public string OwnerConnectionId;
    public MitmPhase Phase;
    public MitmRule MatchedRule;
    public DateTimeOffset CreatedAtUtc;
}
```

### 2.3 `ShouldPauseRequest` — pseudocode

```
ShouldPauseRequest(req, httpClientName, out rule):
  if not _interceptionEnabled:        return false  // fast pass-through
  if MitmRuleStore.Count == 0:         return false  // fast pass-through (§3)
  if _pending.Count >= MaxConcurrent:   return false  // capacity guard
  ctx = MitmMatchContext.From(req, httpClientName, phase=Request)
  if not MitmRuleStore.TryMatch(ctx, Phase.Request, out match): return false
  if match.Action.Type != Breakpoint:
    // Non-breakpoint actions fire inline in the handler — see §2.7.
    // We still return false here so the handler knows there's no suspension.
    rule = match
    return false
  rule = match
  return true
```

Performance: the only allocation on the no-match path is the `ctx` struct (stack). On match it's a single `MitmRule` ref copy.

### 2.4 `ShouldPauseResponse` — pseudocode

```
ShouldPauseResponse(rsp, requestPhaseMatch, req, httpClientName, out rule):
  if not _interceptionEnabled:        return false
  if MitmRuleStore.Count == 0:         return false
  if _pending.Count >= MaxConcurrent:   return false
  ctx = MitmMatchContext.From(req, httpClientName, phase=Response, rsp)
  if not MitmRuleStore.TryMatch(ctx, Phase.Response, out match): return false
  if match.Action.Type != Breakpoint:   rule = match; return false
  rule = match
  return true
```

Note that response-phase **non-breakpoint** rules are disallowed in the simplified scope — we do not modify responses other than via forge. `MitmRuleStore.AddOrReplace` rejects `(Phase=Response, Action != Breakpoint)` at insert time.

### 2.5 `AwaitDecisionAsync` — pseudocode

```
AwaitDecisionAsync(interceptId, snap, matchedRule, handlerCt):
  timeoutMs = matchedRule.Action.TimeoutMs   // already clamped at insert
  tcs       = new TCS<MitmDecision>(RunContinuationsAsynchronously)
  timeoutCts = new CancellationTokenSource(timeoutMs)
  linkedCts  = CTS.CreateLinked(handlerCt, timeoutCts.Token)

  reg = linkedCts.Token.Register(() => {
    reason = timeoutCts.IsCancellationRequested ? "timeout" : "cancelled"
    decision = MitmDecision.ForwardUnchanged(reason)
    if (TryResolve(interceptId, decision)) {
      EdogTopicRouter.Publish("mitm", { type: $"breakpoint{Capitalize(reason)}Out", interceptId, ... })
    }
  })

  pending = new PendingIntercept { ...all fields... }
  if not _pending.TryAdd(interceptId, pending):
    throw InvalidOperation("ULID collision — impossible")

  _byOwner.AddOrUpdate(snap.OwnerConnectionId,
                       _ => new HashSet { interceptId },
                       (_, set) => { lock(set) set.Add(interceptId); set })

  EdogTopicRouter.Publish("mitm", {
    type: "breakpointHit",
    interceptId, ruleId, ruleName, phase, ownerConnectionId,
    timeoutMs, deadlineUtc, request, response  // from snap
  })

  return tcs.Task   // handler thread parks here
```

**Why `TaskCreationOptions.RunContinuationsAsynchronously`:** prevents the resume call from inlining the handler continuation on the hub thread, which would block other SignalR work.

### 2.6 `SubmitDecision` — pseudocode

```
SubmitDecision(interceptId, decision, callerConnectionId):
  if not _pending.TryGetValue(interceptId, out p):
    return MitmResumeResult.NotFound

  if p.OwnerConnectionId != callerConnectionId:
    return MitmResumeResult.NotOwned   // prevents two UIs racing on the same intercept

  // Validate decision shape vs verdict
  switch decision.Verdict:
    case "forward":  // no body required
    case "modify":   if p.Phase == Response and decision.Modifications.Body != null:
                      return MitmResumeResult.Invalid("response modify body not supported in v1")
                     if decision.Modifications == null:
                      return MitmResumeResult.Invalid("modifications required")
                     if Encoding.UTF8.GetByteCount(decision.Modifications.Body ?? "") > 10_485_760:
                      return MitmResumeResult.Invalid("body > 10MB")
    case "block":    if p.Phase == Response: return MitmResumeResult.Invalid("use modify on response phase")
                     if decision.Block == null: return MitmResumeResult.Invalid("block payload required")
    case "forge":    if p.Phase == Response: return MitmResumeResult.Invalid("use modify on response phase")
                     if decision.Forge == null: return MitmResumeResult.Invalid("forge payload required")
    default:         return MitmResumeResult.Invalid("unknown verdict")

  decision.SubmittedByConnectionId = callerConnectionId
  if TryResolve(interceptId, decision):
    Interlocked.Increment(ref MitmRuleStore.GetRuntime(p.MatchedRule.Id).FireCount)
    EdogTopicRouter.Publish("mitm", {
      type: "breakpointResumed",
      interceptId, verdict: decision.Verdict, durationMsPaused, appliedBy: "user"
    })
    return MitmResumeResult.Ok
  return MitmResumeResult.AlreadyResolved


TryResolve(interceptId, decision):
  if _pending.TryRemove(interceptId, out p):
    p.LinkedReg.Dispose()
    p.TimeoutCts.Dispose()
    _byOwner[p.OwnerConnectionId]?.Remove(interceptId)
    return p.Tcs.TrySetResult(decision)
  return false
```

### 2.7 `CancelOwner` — pseudocode

```
CancelOwner(connectionId, reason):
  if not _byOwner.TryRemove(connectionId, out set): return 0
  count = 0
  lock(set):
    for each interceptId in set:
      if _pending.TryGetValue(interceptId, out p):
        decision = (reason == "kill-switch")
                   ? MitmDecision { Verdict = "block", Block = ForgePayload.SwitchKilled }
                   : MitmDecision.ForwardUnchanged(reason)
        if TryResolve(interceptId, decision):
          count++
          EdogTopicRouter.Publish("mitm", { type: "breakpointCancelled", interceptId, reason })
  return count
```

Also called by `MitmClearAll` (passing all known owner connection IDs).

### 2.8 Integration with `EdogHttpPipelineHandler.SendAsync`

Insertion point: **between line 84 (chaos fault lookup) and line 106 (`Stopwatch.Start`)** for the request-phase, and **between line 137 and line 139** (after `responseHeaders` capture, before `PublishHttpEvent`) for the response-phase.

```csharp
// === REQUEST PHASE — between L84 and L106 ===
MitmRule mitmRule = null;
string interceptId = null;
MitmInterceptSnapshot reqSnap = null;
MitmDecision reqDecision = null;
HttpResponseMessage forgedAtRequest = null;
var mitmAction = "passthrough";

if (chaosFault == null && MitmCoordinator.ShouldPauseRequest(request, _httpClientName, out mitmRule))
{
    interceptId = MitmIds.NewInterceptId();
    reqSnap = await MitmRequestSnapshot.CaptureAsync(
        request, fullBody: true, interceptId, mitmRule, MitmPhase.Request).ConfigureAwait(false);
    reqDecision = await MitmCoordinator.AwaitDecisionAsync(
        interceptId, reqSnap, mitmRule, cancellationToken).ConfigureAwait(false);

    switch (reqDecision.Verdict)
    {
        case "forward":  mitmAction = "passthrough-tagged"; break;
        case "modify":   ApplyRequestModifications(request, reqDecision.Modifications);
                          mitmAction = "modified"; break;
        case "block":    forgedAtRequest = reqDecision.Block.Materialize(request);
                          mitmAction = "blocked"; break;
        case "forge":    forgedAtRequest = reqDecision.Forge.Materialize(request);
                          mitmAction = "forged"; break;
    }
}
// Also handle non-breakpoint request-phase rules (block/forge/modify inline — no UI pause)
else if (mitmRule != null)   // ShouldPauseRequest returned false but matched a non-breakpoint rule
{
    forgedAtRequest = ApplyNonBreakpointAction(request, mitmRule, out mitmAction);
}

// === BASE CALL (or short-circuit) ===
sw = Stopwatch.StartNew();
HttpResponseMessage response;
if (forgedAtRequest != null)         response = forgedAtRequest;
else if (chaosFault != null && ...)   /* existing chaos branches */
else                                  response = await base.SendAsync(request, cancellationToken);
sw.Stop();

// === RESPONSE PHASE — between L137 and L139 (after CaptureBodyPreview) ===
if (MitmCoordinator.ShouldPauseResponse(response, mitmRule, request, _httpClientName, out var rspRule))
{
    var rspInterceptId = MitmIds.NewInterceptId();
    var rspSnap = await MitmResponseSnapshot.CaptureAsync(
        request, response, sw.Elapsed.TotalMilliseconds,
        fullBody: true, rspInterceptId, rspRule).ConfigureAwait(false);
    var rspDecision = await MitmCoordinator.AwaitDecisionAsync(
        rspInterceptId, rspSnap, rspRule, cancellationToken).ConfigureAwait(false);

    if (rspDecision.Verdict == "modify")
    {
        ApplyResponseModifications(response, rspDecision.Modifications);
        mitmAction = "response-modified";
    }
    // "forward" is the only other accepted verdict on response phase.
}

// === PUBLISH (enhanced with data.mitm block — see §5) ===
PublishHttpEvent(..., mitmAction, mitmRule, interceptId, reqDecision, ...);
```

`ApplyRequestModifications` simply walks the `MitmModifications` struct and mutates the live `HttpRequestMessage` (`Method`, `RequestUri`, `Headers.TryAddWithoutValidation`, `Content = new StringContent(body)`).

### 2.9 Two suspension points — invariants

| Invariant | Mechanism |
|---|---|
| A request can be paused **at most twice** (once at request, once at response) | Per-phase guard: at most one `MitmRule` per phase fires for any request. |
| Pre-request `block`/`forge` skips response-phase entirely | `forgedAtRequest != null` ⇒ we never enter `ShouldPauseResponse`. |
| The handler thread is the **only** thread that observes the parked-then-resumed transition | TCS contract: only one continuation; `RunContinuationsAsynchronously` queues to threadpool. |
| Suspension is **always finite** | Every `AwaitDecisionAsync` registers `timeoutCts` ≤ 60 s (clamped — see §4); no path can leak a TCS. |

### 2.10 Timeout safety

Default `TimeoutMs = 30_000`. Per-rule override allowed in `[1_000, 60_000]`. On expiry the handler resumes with `MitmDecision.ForwardUnchanged("timeout")` and `mitm.breakpointTimedOut` is published.

A unit-testable invariant: `_pending.Count` always returns to zero within `MaxTimeoutMs + 1_000` of the last `AwaitDecisionAsync` call, regardless of frontend behaviour.

---

## §3. Rule Store — `MitmRuleStore`

New file: `src/backend/DevMode/MitmRuleStore.cs`. Pattern mirrors `EdogHttpFaultStore` line-for-line. Two `FrozenDictionary` snapshots, atomic replace, lock-free reads, write-locked merges.

### 3.1 State

```csharp
internal static class MitmRuleStore
{
    private static volatile FrozenDictionary<string /*ownerConnectionId*/, RuleEntry[]> _byOwner
        = FrozenDictionary<string, RuleEntry[]>.Empty;

    private static volatile RuleEntry[] _orderedFlat = Array.Empty<RuleEntry>();

    private static readonly object _writeLock = new();
    private static long _revision;

    public static long Revision => Interlocked.Read(ref _revision);
    public static int  Count    => _orderedFlat.Length;

    internal sealed class RuleEntry
    {
        public MitmRule Rule;            // immutable snapshot
        public MitmRuleRuntime Runtime;  // mutable counters
    }
}
```

### 3.2 Writes

```csharp
public static MitmValidationResult AddOrReplace(MitmRule rule);   // validates + compiles regex
public static bool                  Remove(string ruleId);
public static bool                  SetEnabled(string ruleId, bool enabled);
public static int                   PurgeByOwner(string connectionId);   // disconnect cleanup
public static void                  ClearAll();                          // kill switch
internal static MitmRuleRuntime     GetRuntime(string ruleId);           // used by Coordinator.SubmitDecision
internal static void                ResetForTesting();
```

All writes go through `_writeLock` and end with `CommitSnapshot(next)`. Identical to `EdogHttpFaultStore.CommitSnapshot` at line 252.

```csharp
private static void CommitSnapshot(Dictionary<string, RuleEntry[]> next)
{
    var frozen = next.Count == 0
        ? FrozenDictionary<string, RuleEntry[]>.Empty
        : next.ToFrozenDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

    var flat = next.Count == 0
        ? Array.Empty<RuleEntry>()
        : next.Values.SelectMany(arr => arr)
                     .OrderBy(e => e.Rule.Priority)
                     .ThenBy(e => e.Rule.CreatedAtUtc)
                     .ToArray();

    Volatile.Write(ref _byOwner, frozen);
    Volatile.Write(ref _orderedFlat, flat);
    Interlocked.Increment(ref _revision);
}
```

**Why two snapshots:** `_orderedFlat` is what the request hot path scans; pre-sorted at write time. `_byOwner` powers O(1) owner-scoped purge on disconnect. Same trade-off `EdogHttpFaultStore` makes with `_byScenario` + `_flatRules`.

### 3.3 Reads — `TryMatch`

```csharp
public static bool TryMatch(in MitmMatchContext ctx, MitmPhase phase, out MitmRule match)
{
    match = null;
    var snapshot = _orderedFlat;          // lock-free read
    if (snapshot.Length == 0) return false;  // fast path — zero overhead

    for (int i = 0; i < snapshot.Length; i++)
    {
        var e = snapshot[i];
        var r = e.Rule;
        if (!r.Enabled) continue;
        if (r.Match.Phase != phase) continue;
        if (!UrlMatches(r.Match.UrlPattern, ctx.Url)) continue;
        if (r.Match.Methods.Length > 0 && Array.IndexOf(r.Match.Methods, ctx.Method) < 0) continue;
        if (!string.IsNullOrEmpty(r.Match.HttpClientName) &&
            !string.Equals(r.Match.HttpClientName, ctx.HttpClientName, StringComparison.OrdinalIgnoreCase))
            continue;

        match = r;
        return true;                        // first-match-wins, by Priority asc, then CreatedAt asc
    }
    return false;
}

private static bool UrlMatches(MitmUrlPattern p, string url) => p.Kind switch
{
    MitmUrlMatchKind.Substring => url.IndexOf(p.Value, StringComparison.OrdinalIgnoreCase) >= 0,
    MitmUrlMatchKind.Exact     => string.Equals(url, p.Value, StringComparison.OrdinalIgnoreCase),
    MitmUrlMatchKind.Regex     => p.Compiled.IsMatch(url),
    _ => false,
};
```

### 3.4 Fast-path guarantee

`Count == 0 ⇒ TryMatch returns false in one volatile read + one length check + one branch`. The pipeline handler short-circuits before constructing `MitmMatchContext` (`if (MitmRuleStore.Count == 0) return false;` in `ShouldPauseRequest`). On a production build where MITM is never used, `_orderedFlat` is `Array.Empty<RuleEntry>()` — exactly the same shape as `EdogHttpFaultStore._flatRules`.

### 3.5 Owner-scoped purge

Called from `EdogPlaygroundHub.OnDisconnectedAsync`:

```csharp
public static int PurgeByOwner(string connectionId)
{
    if (string.IsNullOrEmpty(connectionId)) return 0;
    lock (_writeLock)
    {
        if (!_byOwner.ContainsKey(connectionId)) return 0;

        var purgedCount = _byOwner[connectionId].Length;
        var next = new Dictionary<string, RuleEntry[]>(_byOwner.Count - 1, StringComparer.Ordinal);
        foreach (var kv in _byOwner)
            if (kv.Key != connectionId) next[kv.Key] = kv.Value;

        CommitSnapshot(next);
        return purgedCount;
    }
}
```

---

## §4. Safety Mechanisms

The pipeline handler is on the **hot path of every HTTP call FLT makes**. F28's safety stance: *prefer to forward the original request* over any other failure mode. The host process must never crash because of MITM, and no decision-loop can stall a request indefinitely.

### 4.1 Breakpoint timeout

- Per-intercept `CancellationTokenSource(timeoutMs)` armed at suspension. On expiry, the coordinator resolves the TCS with `MitmDecision.ForwardUnchanged("timeout")` and the request proceeds.
- `timeoutMs` is clamped server-side to `[1_000, 60_000]` at `MitmRuleStore.AddOrReplace`. Out-of-range values are silently coerced.
- Default `30_000`. Matches Burp Suite's default, matches mitmproxy.

### 4.2 Disconnect cleanup

`EdogPlaygroundHub.OnDisconnectedAsync` orchestrates a two-step purge:

```csharp
public override async Task OnDisconnectedAsync(Exception ex)
{
    var connectionId = Context.ConnectionId;
    MitmCoordinator.CancelOwner(connectionId, reason: "disconnect");
    MitmRuleStore.PurgeByOwner(connectionId);
    await base.OnDisconnectedAsync(ex);
}
```

Step 1 unblocks every paused request created by this connection (resolves TCS with `forward`). Step 2 removes the rules they created.

### 4.3 Kill switch (`Ctrl+Shift+K`)

Client-side shortcut → `MitmClearAll()` → server:

```csharp
public Task<MitmOperationResult> MitmClearAll()
{
    // 1) Resume every paused intercept with "block" (kill-switch semantics — don't forward dangerous traffic
    //    that was paused mid-modification).
    var resumedCount = MitmCoordinator.ClearAllPending(reason: "kill-switch");

    // 2) Wipe every rule.
    MitmRuleStore.ClearAll();

    // 3) Broadcast — every client must mirror the wipe (per F24/ChaosKillSwitch pattern).
    EdogTopicRouter.Publish("mitm", new {
        type = "cleared",
        resumedCount,
        byConnectionId = Context.ConnectionId,
    });

    return Task.FromResult(MitmOperationResult.Ok($"Cleared {resumedCount} paused + all rules"));
}
```

**Kill-switch decision policy:** Pending intercepts are resolved with `verdict: "block"`, not `forward`. Rationale: when the user smashes the kill switch, they may have been mid-edit on a destructive request (`DELETE /Tables/Critical`). Blocking is the safer "panic" default. (`CancelOwner` uses `forward`; `ClearAllPending` uses `block`.)

### 4.4 Body size limits

| Path | Limit | Behaviour above limit |
|---|---|---|
| Snapshot for inspection (4 KB preview) | 4 KB | Body field truncated, `bodyTruncated: true` |
| Snapshot delivered to modify-capable editor | 10 MB | Body field `null`, `bodyTruncated: true`; UI disables body editor |
| `MitmModifications.Body` (resume payload) | 10 MB | `SubmitDecision` rejects with `MitmResumeResult.Invalid("body > 10MB")`; intercept stays paused until timeout or another decision |
| `MitmForgePayload.Body` / `MitmBlockAction.Body` (rule create) | 1 MB | `MitmRuleStore.AddOrReplace` rejects with validation error (forge payloads live in rules — keep them small) |

The 4 KB / 10 MB constants are pulled directly from `EdogHttpPipelineHandler` lines 27–28 — no new constants.

### 4.5 Authorization header redaction policy

Unconditional. Every snapshot, every event, every published payload, every audit trail: `Authorization` is `"[redacted]"`. There is no opt-in reveal in v1 (`EDOG_MITM_REVEAL_AUTH` is **not** implemented).

The redaction lives in `MitmRequestSnapshot.CaptureAsync` — it reuses `EdogHttpPipelineHandler.RedactRequestHeaders` (line 270). When the user resumes with `modify` and *omits* an `Authorization` mutation, the handler reads the original (un-redacted) value from the live `HttpRequestMessage` and forwards it unchanged. When the user explicitly sets `Authorization` in `MitmModifications.SetHeaders`, the new value wins.

SAS tokens in URLs are redacted identically — reuses `RedactUrl` (line 253).

### 4.6 Never crash the host

Every `MitmCoordinator` and `MitmRuleStore` public method is wrapped at its outermost frame in `try { ... } catch (Exception ex) { Debug.WriteLine(...); return safe-default; }`. Pattern mirrors `EdogTopicRouter.Publish` (line 76). Specifically:

- `ShouldPauseRequest` / `ShouldPauseResponse` on exception → return `false`. Request proceeds untouched.
- `AwaitDecisionAsync` on exception during snapshot capture → return `MitmDecision.ForwardUnchanged("snap-error")`. Request proceeds untouched.
- `SubmitDecision` on exception during validation → return `MitmResumeResult.Invalid(ex.Message)`. The parked request times out and proceeds.
- `MitmRuleStore.AddOrReplace` on regex compile failure → return `MitmValidationResult.Invalid("regex compile failed")`. No rule enters the store.

The contract from `EdogTopicRouter` — "interceptor failures never propagate to FLT" — applies verbatim to F28.

---

## §5. SignalR Protocol

### 5.1 RPC catalog (Client → Server)

All methods are on `EdogPlaygroundHub`. All return a `MitmOperationResult` envelope unless noted.

| # | Method | Parameter | Returns |
|---|---|---|---|
| 1 | `MitmGetCapabilities` | — | `MitmCapabilityReport` |
| 2 | `MitmCreateRule` | `rule: MitmRuleInput` | `MitmRuleResult { success, message, ruleId, rule }` |
| 3 | `MitmDeleteRule` | `ruleId: string` | `MitmOperationResult` |
| 4 | `MitmListRules` | — | `MitmRuleListResult { revision, rules }` |
| 5 | `MitmResumeBreakpoint` | `decision: MitmDecision` | `MitmOperationResult` |
| 6 | `MitmReplayRequest` | `req: MitmReplayInput` | `MitmReplayResult` |
| 7 | `MitmClearAll` | — | `MitmOperationResult` |
| 8 | `MitmToggleInterception` | `enabled: bool` | `MitmOperationResult` |
| 9 | `MitmSendToPlayground` | `req: MitmPlaygroundTransferInput` | `MitmPlaygroundTransferResult` |

#### `MitmGetCapabilities` — returns

```json
{
  "enabled": true,
  "sessionId": "mitm-7f3a2c1d",
  "reason": null,
  "supportedActions": ["breakpoint", "block", "forge", "modify", "passthrough"],
  "supportedPhases": ["request", "response"],
  "supportedUrlMatchers": ["substring", "regex", "exact"],
  "limits": {
    "maxRulesPerConnection": 50,
    "maxRulesGlobal": 500,
    "maxConcurrentBreakpoints": 64,
    "maxBodyEditorBytes": 10485760,
    "maxRuleBodyBytes": 1048576,
    "breakpointTimeoutMsDefault": 30000,
    "breakpointTimeoutMsMax": 60000
  },
  "interceptionEnabled": true,
  "serverVersion": "f28-v1"
}
```

`enabled` is `false` when `EDOG_MITM_INTERACTIVE != "1"` or build-time `HttpChaosPipelineWired == false`. When `false`, **all** other `Mitm*` methods return `{ success:false, message:"MITM disabled" }`. The UI gates the entire MITM surface on `enabled`.

#### `MitmCreateRule` — input

```json
{
  "id": "rule-blk-onelake",
  "name": "Block OneLake writes",
  "enabled": true,
  "priority": 100,
  "match": {
    "urlPattern": { "kind": "substring", "value": "/Tables" },
    "methods": ["POST", "PUT", "DELETE"],
    "httpClientName": null,
    "phase": "request"
  },
  "action": {
    "type": "block",
    "config": { "statusCode": 503, "body": "{\"error\":\"injected\"}" }
  }
}
```

**Error codes:**

| Code | When |
|---|---|
| `RULE_VALIDATION_FAILED` | shape errors, missing required fields, body too large, regex compile failure |
| `RULE_ID_CONFLICT` | (informational — `AddOrReplace` overwrites by design; surfaced as warning in `message`) |
| `RULE_LIMIT_REACHED` | per-connection cap (`maxRulesPerConnection`) or global cap (`maxRulesGlobal`) |
| `MITM_DISABLED` | capability flag is false |
| `INVALID_RESPONSE_RULE` | `phase: "response" && action.type != "breakpoint"` |

`ownerConnectionId` is **set server-side** from `Context.ConnectionId` — clients never send it; if present, it is ignored.

#### `MitmDeleteRule` — input/return

```json
{ "ruleId": "rule-blk-onelake" }
```
Returns `{ success: true, message: "Deleted" }` on hit, `{ success: true, message: "Not found" }` on miss (idempotent).

#### `MitmListRules` — return

```json
{
  "success": true,
  "revision": 42,
  "rules": [ /* MitmRule[] */ ]
}
```

#### `MitmResumeBreakpoint` — input

See §1.3. Error codes:

| Code | When |
|---|---|
| `INTERCEPT_NOT_FOUND` | already resumed, timed out, or never existed |
| `INTERCEPT_NOT_OWNED` | resume invoked from a different connection than the one that received the breakpoint |
| `RESUME_VALIDATION_FAILED` | missing required block for verdict, body > 10 MB, response-phase + block/forge, unknown verdict |
| `MITM_DISABLED` | capability flag is false |

#### `MitmReplayRequest` — input/return

```json
{
  "method": "GET",
  "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables",
  "headers": { "Content-Type": "application/json" },
  "body": null,
  "httpClientName": "OneLakeRestClient"
}
```

Replays a captured request **through the live `EdogHttpPipelineHandler` chain** (so MITM rules apply, chaos rules apply, the call shows up in the `http` topic). Returns:

```json
{
  "success": true,
  "replayId": "rpl-01HF8M...",
  "statusCode": 200,
  "durationMs": 142.37,
  "responseBodyPreview": "{...}"
}
```

Bound to `maxBodyEditorBytes` for request body. `httpClientName` selects the right named client from the DI container; defaults to a generic `HttpClient` if unknown.

#### `MitmClearAll` — kill switch

Resumes all pending intercepts with `block`, wipes the rule store, broadcasts `mitm.cleared`. Always returns success.

#### `MitmToggleInterception` — global pass-through

`enabled: false` ⇒ `MitmCoordinator._interceptionEnabled = false`. `ShouldPauseRequest`/`ShouldPauseResponse` short-circuit to `false` regardless of rule store contents. Useful for "MITM is annoying me, mute everything for a minute". Existing rules survive.

#### `MitmSendToPlayground` — input/return

```json
// Input
{
  "sourceRowId": 8472,
  "interceptId": null
}
```

The server looks up the row in the in-memory `http` topic buffer by `sourceRowId` (matching `sequenceId`). Returns the un-truncated body if available (the buffer keeps up to 10 MB per row when the pipeline configured `MaxBufferableBytes`). Frontend can also bypass this RPC entirely and build the transfer from the row it already has — only call this when the row's `responseBodyPreview` was truncated.

```json
// Return
{
  "success": true,
  "payload": {
    "source": "http-tab",
    "sourceRowId": 8472,
    "interceptId": null,
    "method": "GET",
    "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables",
    "headers": [{ "name": "Content-Type", "value": "application/json" }],
    "body": "{\"value\":[...]}",
    "tokenType": "fabric"
  }
}
```

Side effect: publishes `mitm.sentToPlayground` topic event (audit trail). Error codes: `ROW_NOT_FOUND`, `MITM_DISABLED` (only when capabilities is gating; for now we allow Send to Playground even when MITM is disabled — it's just a request copy).

### 5.2 Topic `mitm` — event catalog

Registered via `EdogTopicRouter.RegisterTopic("mitm", 1000)` (added at line 34 of `EdogTopicRouter.cs`). Buffer size matches `http` topic. Frontend subscribes via `stream("SubscribeToTopic", "mitm")` (same pattern as the existing `http` subscription at `tab-http.js:56`).

| # | `data.type` | Payload (key fields) | When |
|---|---|---|---|
| E1 | `capabilityChanged` | `enabled, reason, sessionId` | Env var flip — rare; emitted once on connect when state diverges |
| E2 | `interceptionToggled` | `enabled, byConnectionId` | After `MitmToggleInterception` succeeds |
| E3 | `ruleCreated` | `revision, rule` | After `MitmCreateRule` succeeds |
| E4 | `ruleDeleted` | `revision, ruleId, reason` (`reason ∈ {"user","disconnect","clearAll"}`) | After `MitmDeleteRule` or `PurgeByOwner` or `ClearAll` |
| E5 | `breakpointHit` | full `MitmInterceptSnapshot` | Coordinator parks a request |
| E6 | `breakpointResumed` | `interceptId, verdict, appliedBy, durationMsPaused, modificationsSummary?` | Coordinator resolves with a user decision |
| E7 | `breakpointTimedOut` | `interceptId, ruleId, timeoutMs` | Timeout fired before any decision |
| E8 | `cleared` | `resumedCount, byConnectionId` | Kill switch |
| E9 | `sentToPlayground` | `sourceRowId, byConnectionId` | Audit (`MitmSendToPlayground` succeeded) |

**Wire envelope** (matches every other topic — see `TopicEvent.cs:17`):

```json
{
  "sequenceId": 88421,
  "timestamp":  "2026-08-12T17:42:11.123Z",
  "topic":      "mitm",
  "data":       { "type": "breakpointHit", ... }
}
```

### 5.3 Enhanced `http` topic event — `data.mitm` block

Additive — pre-F28 consumers see no change. The block is omitted entirely when no MITM rule fired (mirrors the `data.chaos` pattern at `EdogHttpPipelineHandler.cs:216–223`).

```json
{
  "topic": "http",
  "data": {
    "method": "GET", "url": "...", "statusCode": 200, "durationMs": 142.37,
    "requestHeaders": {...}, "responseHeaders": {...},
    "responseBodyPreview": "...", "requestBodyPreview": "...",
    "requestSizeBytes": 0, "responseSizeBytes": 842,
    "httpClientName": "OneLakeRestClient", "correlationId": "abc-123",

    "mitm": {
      "ruleId":      "pause-onelake-list",
      "ruleName":    "Pause OneLake List",
      "interceptId": "int-01HF8...",
      "action":      "modified",
      "phase":       "request",
      "verdict":     "modify",
      "durationMsPaused": 4123,
      "modifiedFields":  ["body", "headers.X-Custom"]
    }
  }
}
```

`mitm.action` values: `"passthrough-tagged"` (matched but `forward`), `"modified"`, `"blocked"`, `"forged"`, `"response-modified"`, `"timed-out"`, `"cancelled"`.

`data.chaos` and `data.mitm` can co-exist (chaos applied first, MITM second — chaos can't pause, so the order is well-defined).

### 5.4 Errors — common envelope

All RPCs returning `MitmOperationResult` use:

```json
{ "success": false, "code": "RESUME_VALIDATION_FAILED", "message": "body > 10MB" }
```

`code` is a stable enum-like string; UIs may branch on it. `message` is human-readable and may change.

---

## §6. Performance Targets

| Metric | Target | Rationale / Verification |
|---|---|---|
| Rule evaluation (no rules) | **0 allocations, < 5 ns** per request | `if (_orderedFlat.Length == 0) return false;` — single volatile read + length check. Matches `EdogHttpFaultStore` empty-store cost. |
| Rule evaluation (1–20 rules, no match) | **< 50 μs** | Linear scan, no regex compilation, frozen array, no boxing. Benchmark target. |
| Rule evaluation (1 match found) | **< 100 μs** | Includes context build + single `IndexOf` (substring) or `Regex.IsMatch` against pre-compiled regex. |
| Topic event publish (`mitm.breakpointHit`) | **< 100 μs** | `EdogTopicRouter.Publish` writes to a `Channel<T>` (`TopicBuffer.Write`); no allocations beyond the event envelope. |
| Coordinator suspension memory cost | **~ 4 KB** per paused request | TCS + CTS + linked CTS + snapshot reference; snapshot bodies (up to 10 MB) are counted separately and freed on resume. |
| Max concurrent paused requests | **64** | Hard cap; new matches above the cap auto-pass-through with `mitm.breakpointCancelled` (`reason: "capacity"`). Prevents runaway memory + matches `maxConcurrentBreakpoints` in capabilities. |
| MITM off (`InterceptionEnabled = false`) | **identical to baseline** | Single volatile read before the rule store check; no other observable cost. |
| Disconnect cleanup | **< 5 ms** for 50 rules + 16 pending | Single write lock + dictionary rebuild + 16 TCS completions. |
| Hub RPC `MitmListRules` (50 rules) | **< 5 ms** | Pure projection over `_orderedFlat`; JSON serialisation dominates. |

**Benchmark harness:** Add to `tests/backend/MitmRuleStore.Benchmarks.cs` (BenchmarkDotNet). Track regressions in CI gate.

---

## §7. File Touch List

### 7.1 New files

| File | Purpose | Approx LoC |
|---|---|---|
| `src/backend/DevMode/MitmCoordinator.cs` | C01 — TCS-based suspend/resume coordinator (§2) | ~400 |
| `src/backend/DevMode/MitmRuleStore.cs` | C02 — FrozenDictionary rule store (§3) | ~350 |
| `src/backend/DevMode/MitmRule.cs` | `MitmRule`, `MitmMatch`, `MitmUrlPattern`, action hierarchy (§1.1) | ~200 |
| `src/backend/DevMode/MitmDecision.cs` | `MitmDecision`, `MitmModifications`, `MitmForgePayload`, `MitmResumeResult` (§1.3–1.4) | ~120 |
| `src/backend/DevMode/MitmInterceptSnapshot.cs` | `MitmInterceptSnapshot`, `MitmRequestSnapshot`, `MitmResponseSnapshot`, capture helpers (§1.2) | ~250 |
| `src/backend/DevMode/MitmCapabilityReport.cs` | `MitmCapabilityReport`, `MitmOperationResult`, `MitmRuleListResult`, `MitmReplayResult`, `MitmPlaygroundTransferResult` | ~150 |
| `src/backend/DevMode/MitmIds.cs` | `NewInterceptId()`, `NewRuleId()`, `NewReplayId()` (ULID generation) | ~50 |
| `src/backend/DevMode/MitmIntegration.cs` | `ApplyRequestModifications`, `ApplyResponseModifications`, `ApplyNonBreakpointAction` — extracted helpers used by the pipeline handler | ~180 |
| `src/frontend/js/http-row-menu.js` | Right-click context menu (C04 §3.1) | ~250 |
| `src/frontend/js/mitm-client.js` | RPC wrappers, capability cache, breakpoint event subscription, decision builder | ~300 |
| `src/frontend/js/mitm-intercept-panel.js` | Detail-tab panel for paused intercepts (inspect/edit/resume UI) | ~400 |
| `src/frontend/css/tab-http-mitm.css` | New styles for context menu, row badges, intercept panel, intercept toggle | ~200 |
| `tests/backend/MitmCoordinatorTests.cs` | xUnit — suspend/resume, timeout, disconnect, kill switch, capacity | ~400 |
| `tests/backend/MitmRuleStoreTests.cs` | xUnit — CRUD, owner purge, regex compile, first-match-wins, concurrency | ~350 |
| `tests/backend/MitmRuleStore.Benchmarks.cs` | BenchmarkDotNet — perf targets in §6 | ~80 |

### 7.2 Modified files (with line-level anchors)

| File | Change | Anchor |
|---|---|---|
| `src/backend/DevMode/EdogHttpPipelineHandler.cs` | Insert request-phase MITM check between chaos lookup (L84) and `Stopwatch.Start` (L106). See §2.8. | L84 → L106 |
| `src/backend/DevMode/EdogHttpPipelineHandler.cs` | Insert response-phase MITM check between body-preview capture (L137) and `PublishHttpEvent` (L139). | L137 → L139 |
| `src/backend/DevMode/EdogHttpPipelineHandler.cs` | Extend `PublishHttpEvent` signature with `(string mitmAction, MitmRule mitmRule, string interceptId, MitmDecision decision)`; add `mitm` block in both anonymous-object branches (L202–L242) mirroring the existing `chaos` block. | L183–L248 |
| `src/backend/DevMode/EdogTopicRouter.cs` | Add `RegisterTopic("mitm", 1000)` line in `Initialize()`. | L34 (insert) |
| `src/backend/DevMode/EdogPlaygroundHub.cs` | Add 9 new hub methods (`MitmGetCapabilities`, `MitmCreateRule`, `MitmDeleteRule`, `MitmListRules`, `MitmResumeBreakpoint`, `MitmReplayRequest`, `MitmClearAll`, `MitmToggleInterception`, `MitmSendToPlayground`) following the existing `Qa*` method style. | After existing `Qa*` block, ~L1106 |
| `src/backend/DevMode/EdogPlaygroundHub.cs` | Override `OnDisconnectedAsync` (or extend if already overridden) to call `MitmCoordinator.CancelOwner` + `MitmRuleStore.PurgeByOwner`. | Near existing `OnConnectedAsync` at L406 |
| `src/backend/DevMode/EdogDevModeRegistrar.cs` | If MITM has any DI registration needs, add late-DI hook (per ADR-005). Most state is static. | Existing registrar — additive |
| `src/frontend/js/tab-http.js` | Subscribe to `mitm` topic in constructor alongside the existing `http` subscription at L56–L59. | L56 |
| `src/frontend/js/tab-http.js` | Bind `contextmenu` on `.http-row` in `_bindEvents()` → `_openRowMenu()` delegating to `http-row-menu.js`. | L499 |
| `src/frontend/js/tab-http.js` | Add intercept toggle pill + status badge to the toolbar; per-row state badge in `_renderRow`. Add "Send to API Playground" item to the row menu spec. | Toolbar around L499; row render around L907 |
| `src/frontend/js/tab-http.js` | Add Intercept detail tab — visible only when row has `interceptId`. Delegates to `mitm-intercept-panel.js`. | Detail render around L614 |
| `src/frontend/js/api-playground.js` | Expose `window.edogPlayground.openWith(payload)` that switches to the Playground tab and calls `requestBuilder.setRequest(payload)`. `setRequest` already exists at L1036. | L1036 (no change there) + add new `openWith` helper near class export |
| `src/frontend/js/signalr-manager.js` | No code change required — `connection.invoke('Mitm*', …)` is supported by the existing direct-invoke pattern. | — |
| `src/frontend/css/tab-http.css` | Imports / appends new MITM styles from `tab-http-mitm.css` (or build script picks both up). | End of file |
| `scripts/build-html.py` | Add `mitm-client.js`, `http-row-menu.js`, `mitm-intercept-panel.js` to the JS source list in dependency order: before `tab-http.js`, after `signalr-manager.js`. Add `tab-http-mitm.css` to the CSS list. | JS_SOURCES / CSS_SOURCES lists |

### 7.3 Files explicitly **not** touched

- `src/backend/DevMode/EdogHttpFaultStore.cs` — F27 P5 chaos store stays as-is. F28 lives alongside it.
- `src/backend/DevMode/EdogQa*.cs` — QA testing unrelated.
- `src/frontend/js/api-client.js` — no new endpoints needed.
- `src/frontend/js/api-playground.js` `RequestBuilder` internals (L442–L1267) — only the new `openWith` wrapper is added; the refactor-to-`RequestEditor` from C04 §6 is deferred to a future polish pass.

---

## §8. Acceptance Gates (informational — Sentinel will own the test plan)

This architecture is "done" when:

1. **Engine.** `MitmCoordinator` + `MitmRuleStore` compile, all public APIs match §2.1 / §3.2, and `MitmRuleStoreTests` + `MitmCoordinatorTests` are green.
2. **Hot path.** `EdogHttpPipelineHandler.SendAsync` with zero MITM rules shows zero perf regression in the existing http-pipeline benchmark.
3. **Wire.** `MitmGetCapabilities` returns the §5.1 shape; `MitmListRules` round-trips a `MitmRule` losslessly.
4. **End-to-end pause/resume.** A `breakpoint` rule pauses a real FLT HTTP call, `mitm.breakpointHit` reaches the frontend, `MitmResumeBreakpoint(forward)` resumes; the request completes and the `http` topic event contains the `data.mitm` block.
5. **Safety.** Kill switch wipes everything and broadcasts `mitm.cleared`. Disconnect with a paused intercept forwards the original request within 50 ms.
6. **Send to Playground.** Right-clicking any captured row → "Send to API Playground" → Playground tab activates → method/URL/headers/body are pre-populated; clicking Send works.

Anything beyond this list is out of P2 scope.
