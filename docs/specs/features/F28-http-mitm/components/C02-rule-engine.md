# F28 / C02 — Rule Engine

> **Component:** C02 Rule Engine
> **Feature:** F28 HTTP MITM
> **Author:** Sana (Architecture)
> **Status:** P1 — Component Deep Spec
> **Depends on:** `research/p0-foundation.md`
> **Sibling components:** C01 Interception Point (hooks into `EdogHttpPipelineHandler.SendAsync`), C03 MitmCoordinator (breakpoint suspension), C04 Hub RPC surface
> **Scope:** Rule data model, store, matching/precedence, lifecycle counters, and the boundary with F24's future panel.

---

## 0. TL;DR

The Rule Engine owns four things:

1. **`MitmRule`** — the immutable predicate/action/lifecycle record. A strict subset of F24's `ChaosRule` shape so a single store satisfies both features.
2. **`MitmRuleStore`** — a process-wide, lock-free-read store modelled exactly on `EdogHttpFaultStore` (FrozenDictionary snapshot + `Volatile.Write` + write lock + monotonic revision). Owner-tagged for purge.
3. **Matching** — ordered evaluation against a single immutable snapshot per `SendAsync` call. First-match-wins inside an owner tier; tiers are evaluated in fixed precedence. Compiled regex cached on the rule.
4. **Lifecycle** — `Enabled`, `MaxFirings`, `ExpiresAt` (TTL), `FireCount` (atomic increment), `Probability`, with auto-disable on exhaustion and a revision bump on every state change so the frontend can reconcile.

C02 does **not** own the interception point (that is C01) and does **not** own breakpoint suspension (that is C03). It exposes a single hot-path entrypoint `TryMatch(HttpRequestSnapshot ctx, MitmPhase phase, out MitmMatch match)` that C01 calls twice per request (request phase + response phase) and a small set of write APIs for C04 to call from hub RPCs.

---

## 1. MitmRule — Class Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│ MitmRule                                              (immutable; init-only) │
├───────────────────────────────────────────────────────────────────────┤
│ // ── identity ─────────────────────────────────────────────────────  │
│ string             Id              // "rule-abc" (caller- or GUID-supplied) │
│ string             Name            // human label for UI                   │
│ string             Category        // "request-surgery" | "response-forgery" | ... │
│ int                Priority        // lower = earlier; default 100           │
│                                                                       │
│ // ── ownership (drives purge + precedence) ──────────────────────── │
│ MitmOwnerType      OwnerType       // InteractiveBreakpoint | MitmSession | ChaosPanel | QaScenario │
│ string             OwnerId         // ConnectionId | sessionGuid | scenarioId │
│ string             CreatedByConnId // SignalR ConnectionId at creation (auditing) │
│                                                                       │
│ // ── matching (predicates; ALL must be true to fire) ─────────────  │
│ MitmUrlMatcher     Url             // { kind: regex|substring|exact, pattern, _compiled: Regex } │
│ MitmMethodSet      Methods         // frozen set; empty = any         │
│ string?            HttpClientName  // null/empty = any                │
│ MitmHeaderMatcher[]Headers         // each: { name, op, value, _compiled? } │
│ MitmBodyMatcher?   Body            // { kind: regex|jsonpath|substring, pattern, _compiled? } │
│ int                ResponseStatus  // 0 = any; only used for response-phase rules │
│ MitmPhase          PhaseMask       // Request | Response | Both      │
│                                                                       │
│ // ── lifecycle ────────────────────────────────────────────────────  │
│ bool               Enabled         // user-toggleable; auto-flipped false on exhaustion │
│ double             Probability     // 0.0–1.0; default 1.0           │
│ int                MaxFirings      // 0 = unlimited                  │
│ DateTimeOffset?    ExpiresAt       // null = no TTL                  │
│ DateTimeOffset     CreatedAt                                          │
│                                                                       │
│ // ── action (exactly one) ─────────────────────────────────────────  │
│ MitmActionType     Action          // see §3 enum                    │
│ MitmActionConfig   ActionConfig    // typed action payload (sealed sub-classes) │
│                                                                       │
│ // ── runtime mutable counters (atomic; not part of equality) ─────  │
│ long               FireCount       // Interlocked.Increment           │
│ DateTimeOffset?    LastFiredAt     // best-effort, not strictly monotonic │
└───────────────────────────────────────────────────────────────────────┘
                                  │
              owns 0..N           │           owns 1
           ┌──────────────────────┴────────────────────────┐
           ▼                                               ▼
┌─────────────────────────┐                  ┌──────────────────────────────┐
│ MitmHeaderMatcher       │                  │ MitmActionConfig (abstract)  │
│ • Name (case-insens.)   │                  │ ├── BlockConfig              │
│ • Op (Equals|Contains|  │                  │ ├── ForgeConfig              │
│   StartsWith|Regex|     │                  │ ├── ModifyRequestHeadersCfg  │
│   Present|Absent)       │                  │ ├── ModifyRequestBodyCfg     │
│ • Value                 │                  │ ├── ModifyRequestUrlCfg      │
│ • _compiled: Regex?     │                  │ ├── ModifyResponseStatusCfg  │
└─────────────────────────┘                  │ ├── ModifyResponseHeadersCfg │
                                             │ ├── ModifyResponseBodyCfg    │
                                             │ ├── DelayConfig              │
                                             │ └── BreakpointPauseConfig    │
                                             └──────────────────────────────┘
```

Implementation rules:

- The public surface is `init` properties (C# 9). Mutating counters (`FireCount`, `LastFiredAt`, `Enabled`) live on a sibling `MitmRuleRuntime` object so the public `MitmRule` instance remains an **immutable snapshot record** safe for the lock-free reader. Store entries are `(MitmRule rule, MitmRuleRuntime runtime)` tuples.
- `_compiled` regex fields are populated **exactly once at store-insert time**. The reader hot path never compiles.
- Equality is `Id`-based; the store treats two rules with the same `Id` as the same rule (last-writer-wins on `AddOrReplace`).
- The shape is a strict **subset** of F24's `ChaosRule` (§5). F28 ignores fields it does not yet support — they are reserved on the wire so F24 can populate them later without a wire break.

---

## 2. JSON Wire Shape

The hub RPC surface (`MitmCreateRule`, `MitmListRules`, etc. — owned by C04) uses this exact shape. It is also what the `mitm` topic emits in the `rule.created` / `rule.updated` / `rule.fired` envelopes.

```json
{
  "id": "rule-7f3a",
  "name": "Block OneLake writes",
  "category": "traffic-control",
  "priority": 100,

  "ownerType": "mitm-session",
  "ownerId": "conn-9b2e",

  "match": {
    "url":       { "kind": "regex",  "pattern": "/Tables/.*$" },
    "methods":   ["POST", "PUT", "DELETE"],
    "httpClientName": "OneLakeRestClient",
    "headers": [
      { "name": "x-ms-version", "op": "equals", "value": "2023-08-03" },
      { "name": "Authorization", "op": "present" }
    ],
    "body":      { "kind": "jsonpath", "pattern": "$.changes[?(@.op=='delete')]" },
    "responseStatus": 0,
    "phase":     "request"
  },

  "lifecycle": {
    "enabled": true,
    "probability": 1.0,
    "maxFirings": 5,
    "expiresAt": "2026-08-12T18:42:11Z"
  },

  "action": {
    "type": "block",
    "config": { "statusCode": 503, "body": "{\"error\":\"injected\"}" }
  },

  "runtime": {
    "createdAt": "2026-08-12T17:42:11Z",
    "fireCount": 2,
    "lastFiredAt": "2026-08-12T17:45:03Z"
  }
}
```

Notes:

- `runtime` is **read-only** server-emitted state. Clients must not echo it back on update; the store ignores it.
- `ownerType` is one of `interactive-breakpoint | mitm-session | chaos-panel | qa-scenario`. F28 P1 only emits `interactive-breakpoint` and `mitm-session`; the other two are reserved for F24 and F27 P5 respectively (§5).
- Unknown `action.type` values are rejected at create time (§S01). New actions added in future versions appear here.

---

## 3. Action Types

```csharp
public enum MitmActionType
{
    // ── REQUEST PHASE (short-circuit or rewrite before base.SendAsync) ──
    Block,                  // synthesize a canned response, skip base call
    Forge,                  // synthesize full response (status + headers + body), skip base call
    ModifyRequestHeaders,   // add/remove/replace request headers, then forward
    ModifyRequestBody,      // rewrite request body (regex replace / json patch), then forward
    ModifyRequestUrl,       // rewrite request URI (host, path, query), then forward
    Delay,                  // await Task.Delay before forwarding
    BreakpointPause,        // hand control to MitmCoordinator (C03); resume sends Forward/Drop/Modify

    // ── RESPONSE PHASE (after base.SendAsync returns) ──
    ModifyResponseStatus,   // change status + reason phrase
    ModifyResponseHeaders,  // add/remove/replace response headers
    ModifyResponseBody,     // rewrite response body
    // (Delay can also apply post-response by setting PhaseMask=Response; reuses DelayConfig)
}
```

Each action has a sealed config class. Schemas:

| Action | Config fields | Notes |
|---|---|---|
| `Block` | `int statusCode (100-599, def 500)`, `string? body`, `Dictionary<string,string>? headers` | Same shape as F27 P5 `http_error`. |
| `Forge` | `int statusCode`, `string? body`, `Dictionary<string,string>? headers`, `string? reasonPhrase` | Full fabrication. Identical to `Block` semantically — kept distinct so the UI/event log can label them differently. |
| `ModifyRequestHeaders` | `HeaderOp[] ops` where `HeaderOp = { name, op (set|remove|append), value? }` | `set` overwrites; `append` adds duplicate header. |
| `ModifyRequestBody` | `MitmBodyEdit edit` = `{ kind: replace|regex|jsonpatch, pattern?, replacement?, document? }` | `replace` swaps full body; `regex` does `Regex.Replace`; `jsonpatch` applies RFC 6902. |
| `ModifyRequestUrl` | `string? scheme, host, path, query`, `Dictionary<string,string>? queryAdds`, `string[]? queryRemoves` | Null fields preserve the original part. |
| `ModifyResponseStatus` | `int statusCode`, `string? reasonPhrase` | |
| `ModifyResponseHeaders` | `HeaderOp[] ops` | Same shape as request variant. |
| `ModifyResponseBody` | `MitmBodyEdit edit` | Same shape as request variant. |
| `Delay` | `int delayMs (0–600_000)`, `MitmPhase phase (Request|Response)` | Bounds match F27 P5's `latencyMs`. |
| `BreakpointPause` | `MitmPhase phase`, `int timeoutMs (def 30_000)`, `bool revealAuth (def false)` | Delegates to C03. Timeout enforced (R1 in P0). |

---

## 4. MitmRuleStore — Design

Exact mirror of `EdogHttpFaultStore` (`src/backend/DevMode/EdogHttpFaultStore.cs:82-266`) widened for owner-keyed lookup.

```csharp
internal static class MitmRuleStore
{
    // Two parallel snapshots — same pattern as EdogHttpFaultStore.
    // _byOwner powers owner-scoped purge in O(1).
    // _orderedFlat is the hot-path scan: pre-sorted by (OwnerTierRank, Priority, CreatedAt).
    private static volatile FrozenDictionary<OwnerKey, RuleEntry[]> _byOwner
        = FrozenDictionary<OwnerKey, RuleEntry[]>.Empty;
    private static volatile RuleEntry[] _orderedFlat = Array.Empty<RuleEntry>();

    private static readonly object _writeLock = new();
    private static long _revision; // monotonic; Interlocked.Increment

    public static long Revision => Interlocked.Read(ref _revision);
    public static int ActiveRuleCount => _orderedFlat.Length;

    // Writes (C04 calls these from hub RPCs)
    public static MitmValidationResult AddOrReplace(MitmRule rule);   // S01
    public static bool                  Remove(string ruleId);         // returns false if not found
    public static bool                  SetEnabled(string ruleId, bool enabled);
    public static int                   PurgeByOwner(OwnerKey owner);  // S04
    public static int                   PurgeExpired(DateTimeOffset now);
    public static void                  ClearAll();                    // kill switch

    // Reads (C01 calls these from the hot path)
    public static bool TryMatch(in MitmMatchContext ctx, MitmPhase phase, out MitmMatch match);  // S02
    public static IReadOnlyList<MitmRule> ListByOwner(OwnerKey owner);
    public static IReadOnlyList<MitmRule> ListAll();

    // Test hook (mirrors EdogHttpFaultStore.ResetForTesting)
    internal static void ResetForTesting();
}

internal readonly record struct OwnerKey(MitmOwnerType Type, string Id);

internal sealed class RuleEntry
{
    public MitmRule Rule;                 // immutable
    public MitmRuleRuntime Runtime;       // mutable counters
    public int OwnerTierRank;             // cached: 0=breakpoint, 1=qa-scenario, 2=mitm-session, 3=chaos-panel
}
```

### 4.1 Snapshot commit (mirrors `EdogHttpFaultStore.CommitSnapshot` at line 252)

```csharp
private static void CommitSnapshot(Dictionary<OwnerKey, RuleEntry[]> next)
{
    var frozen = next.Count == 0
        ? FrozenDictionary<OwnerKey, RuleEntry[]>.Empty
        : next.ToFrozenDictionary(kv => kv.Key, kv => kv.Value);

    var flat = next.Count == 0
        ? Array.Empty<RuleEntry>()
        : next.Values
              .SelectMany(arr => arr)
              .OrderBy(e => e.OwnerTierRank)
              .ThenBy(e => e.Rule.Priority)
              .ThenBy(e => e.Rule.CreatedAt)
              .ToArray();

    Volatile.Write(ref _byOwner, frozen);
    Volatile.Write(ref _orderedFlat, flat);
    Interlocked.Increment(ref _revision);
}
```

### 4.2 Why two snapshots (vs. one)

The `_orderedFlat` array is what the request hot path scans (`SendAsync` is called millions of times in a busy session). Sorting once at write time is far cheaper than sorting per request. The `_byOwner` map is only touched on purge/list and on rule create (to merge into the owner's existing list). Same trade-off `EdogHttpFaultStore` already makes with `_byScenario` + `_flatRules`.

### 4.3 Revision counter

Bumped exactly once per successful write (AddOrReplace, Remove, SetEnabled, PurgeByOwner, PurgeExpired, ClearAll). The frontend uses it to short-circuit list-refresh after reconnect: if the revision matches its cached value, no diff is needed. Also published in every `mitm` topic envelope.

### 4.4 Frontend reconciliation contract

`MitmListRules` returns `{ revision, rules: MitmRule[] }`. The frontend caches `revision`. The `mitm` topic includes `revision` in every event. If the frontend sees a revision skip > 1, it calls `MitmListRules` to re-sync (handles bursty writes during a paused JS task).

---

## 5. Relationship to F24 (and F27 P5)

| Concern | F28 today (this spec) | F24 future | F27 P5 today |
|---|---|---|---|
| Rule shape | `MitmRule` (this doc) | `ChaosRule` — superset; adds 30+ action types, `MaxRatePerSecond`, more matchers | `HttpFaultEntry` — narrow legacy (3 fault types, substring URL) |
| Store | `MitmRuleStore` (this doc) | Same store, possibly renamed `ChaosRuleStore` — wire-compatible | `EdogHttpFaultStore` (kept in place) |
| Owner tags | `interactive-breakpoint`, `mitm-session` | adds `chaos-panel` | adds `qa-scenario` (already lives in `EdogHttpFaultStore._byScenario`) |
| Wire format | `MitmRule` JSON above | Same JSON; populates more fields | Different (legacy `ChaosRuleSpec`) |

**Hard requirements for forward-compat:**

1. `MitmRule.Action` is an open `enum` and `ActionConfig` is polymorphic. Unknown enum values from a future F24 client are **rejected at the hub validator**, not at the store, so adding `ThrottleBandwidth` etc. later is a hub-level change only.
2. `MitmRule.OwnerType` includes `ChaosPanel` and `QaScenario` from day one; F28 just doesn't emit them.
3. The store APIs (`AddOrReplace`, `Remove`, …) are **owner-agnostic**. F24's panel wires a different hub method that calls the same store with `OwnerType.ChaosPanel`.
4. F27 P5's `EdogHttpFaultStore` stays. C01 (interception point) consults **both** stores during the F28-only milestone, with `MitmRuleStore` taking precedence inside the `qa-scenario` tier so an interactive breakpoint can still override a scenario fault. F24 will deprecate `EdogHttpFaultStore` and migrate scenario faults onto `MitmRuleStore` with `OwnerType=QaScenario`.

**What F28 is NOT building:** rate-per-second token bucket, schema-evolution fuzzer, shadow traffic clone, bandwidth throttle, recording sub-store. All deferred to F24. The rule shape carries the *predicate* part of these already, but the *action* enum stops short.

---

## 6. Scenarios

Every scenario lists: **Description · Mechanism (C# sketch) · Source path (file:line) · Edge cases · Interactions · Revert · Priority**.

### S01 — Rule Creation: validate, compile, store · **P0**

**Description.** A hub RPC (`MitmCreateRule` in C04) delivers a `MitmRuleInput` DTO. The Rule Engine validates fields, compiles regex matchers once, and commits a new snapshot. On success, the new revision is returned and a `rule.created` event is published on the `mitm` topic.

**Mechanism.**

```csharp
public static MitmValidationResult AddOrReplace(MitmRule rule)
{
    // 1. Validate shape (synchronous; no IO).
    var err = MitmRuleValidator.Validate(rule);
    if (err != null) return MitmValidationResult.Fail(err);

    // 2. Compile regexes ONCE — never compile in the hot path.
    var compiled = MitmRuleCompiler.Compile(rule);
    if (compiled.Error != null) return MitmValidationResult.Fail(compiled.Error);

    var entry = new RuleEntry
    {
        Rule = compiled.Rule,
        Runtime = new MitmRuleRuntime { Enabled = rule.Enabled },
        OwnerTierRank = TierRankOf(rule.OwnerType),
    };

    lock (_writeLock)
    {
        var key = new OwnerKey(rule.OwnerType, rule.OwnerId);
        var next = CloneSnapshot(_byOwner);

        if (next.TryGetValue(key, out var existing))
        {
            // last-writer-wins by Id
            var merged = existing.Where(e => e.Rule.Id != rule.Id).Append(entry).ToArray();
            next[key] = merged;
        }
        else next[key] = new[] { entry };

        CommitSnapshot(next);
    }
    return MitmValidationResult.Ok(_revision);
}
```

**Source path.** New file `src/backend/DevMode/MitmRuleStore.cs` (sibling of `EdogHttpFaultStore.cs`). Validator: `src/backend/DevMode/MitmRuleValidator.cs`. Compiler: `src/backend/DevMode/MitmRuleCompiler.cs`.

**Validation rules (parse-then-bound, copying the pattern at `EdogHttpFaultStore.cs:217-238`):**

| Field | Rule | Failure code |
|---|---|---|
| `Id` | non-empty, ≤128 chars, `[a-zA-Z0-9-_]` | `INVALID_ID` |
| `OwnerId` | non-empty | `INVALID_OWNER` |
| `Url.pattern` | non-empty if `kind=regex`/`substring`; valid `Regex` if `kind=regex` | `INVALID_URL_PATTERN` |
| `Methods` | each in {GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS,TRACE} | `INVALID_METHOD` |
| `Probability` | 0.0 ≤ x ≤ 1.0 | `INVALID_PROBABILITY` |
| `MaxFirings` | ≥ 0 | `INVALID_MAX_FIRINGS` |
| `ExpiresAt` | null or > `DateTimeOffset.UtcNow` | `INVALID_TTL` |
| `Priority` | 0 ≤ x ≤ 10_000 | `INVALID_PRIORITY` |
| `Action` | known enum member | `UNKNOWN_ACTION` |
| `ActionConfig` | matches action's sealed config class | `INVALID_ACTION_CONFIG` |
| `Body.pattern` | valid Regex or JsonPath compileable | `INVALID_BODY_PATTERN` |

**Edge cases.**

- **Same `Id`, different owner:** rejected. Ids are globally unique to keep the wire simple and to make `Remove(id)` unambiguous.
- **Regex `(.*).*+` catastrophic backtracking:** validator wraps compile in a `Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, MatchTimeout: 50ms)`. The 50ms `MatchTimeout` is part of the rule itself, not a one-off, so the hot path inherits it.
- **`OwnerType=InteractiveBreakpoint` with `MaxFirings != 1`:** rejected. Interactive breakpoints are one-shot by definition.
- **Empty `Methods` array:** treated as "any method" (matches F24 ChaosRule semantics where `MethodFilter="*"`).
- **Duplicate header matchers on same name:** allowed (AND semantics — e.g., must contain "foo" AND not start with "bar").

**Interactions.** C04 hub RPC calls this. On success, C04 publishes a `rule.created` event to the `mitm` topic (registered in `EdogTopicRouter.Initialize` — see C04 spec). C03 MitmCoordinator does **not** see this event directly; it is consulted only when a `BreakpointPause` rule actually matches at runtime (S10).

**Revert / undo.** `Remove(id)` reverses. There is no soft-delete; rules are removed by Id and the snapshot is rebuilt. Frontend can re-create by re-submitting the same `MitmRuleInput`.

---

### S02 — Rule Matching: ordered evaluation on each request · **P0**

**Description.** On every `EdogHttpPipelineHandler.SendAsync` call, C01 invokes `MitmRuleStore.TryMatch` twice: once with `phase=Request` (before `base.SendAsync`) and once with `phase=Response` (after). Each call returns at most one match — the **first** rule whose predicate passes, scanning `_orderedFlat` in tier-then-priority order.

**Mechanism.**

```csharp
public static bool TryMatch(in MitmMatchContext ctx, MitmPhase phase, out MitmMatch match)
{
    match = default;
    var rules = _orderedFlat;          // lock-free snapshot read
    if (rules.Length == 0) return false;  // fast path — see S13

    var now = DateTimeOffset.UtcNow;
    foreach (var entry in rules)
    {
        var rule = entry.Rule;
        if (!entry.Runtime.Enabled) continue;
        if ((rule.PhaseMask & phase) == 0) continue;
        if (rule.ExpiresAt is { } exp && exp <= now) continue;     // lazy TTL — see S03
        if (rule.MaxFirings > 0 &&
            Interlocked.Read(ref entry.Runtime.FireCount) >= rule.MaxFirings) continue;

        if (!UrlMatches(rule.Url, ctx.Url)) continue;          // cheapest check first
        if (rule.Methods.Count > 0 && !rule.Methods.Contains(ctx.Method)) continue;
        if (rule.HttpClientName is { Length: > 0 } &&
            !rule.HttpClientName.Equals(ctx.HttpClientName, StringComparison.Ordinal)) continue;
        if (rule.Headers.Length > 0 && !HeadersMatch(rule.Headers, ctx.Headers)) continue;
        if (rule.Body is not null && !BodyMatches(rule.Body, ctx.BodyPreview)) continue;
        if (phase == MitmPhase.Response && rule.ResponseStatus != 0 &&
            rule.ResponseStatus != ctx.ResponseStatus) continue;

        if (rule.Probability < 1.0 && _rng.NextDouble() >= rule.Probability) continue;

        // Fire. Atomic increment so concurrent SendAsync don't double-fire past MaxFirings.
        var newCount = Interlocked.Increment(ref entry.Runtime.FireCount);
        if (rule.MaxFirings > 0 && newCount > rule.MaxFirings)
        {
            Interlocked.Decrement(ref entry.Runtime.FireCount);
            continue;
        }
        entry.Runtime.LastFiredAt = now;

        if (rule.MaxFirings > 0 && newCount == rule.MaxFirings)
            AutoDisable(rule.Id);                            // S03

        match = new MitmMatch(rule, entry.Runtime, newCount);
        return true;
    }
    return false;
}
```

**Source path.** `src/backend/DevMode/MitmRuleStore.cs` (new). Hot path called from `src/backend/DevMode/EdogHttpPipelineHandler.cs:46` `SendAsync`, replacing the current `EdogHttpFaultStore.TryMatchFault(...)` site at `EdogHttpPipelineHandler.cs:83`.

**Edge cases.**

- **Predicate order is fixed cheapest-to-priciest** (URL → method → client name → headers → body → status). Body match is the most expensive (regex/jsonpath over up to 10MB — see S12) so it runs last.
- **`Random`:** a single `ThreadLocal<Random>` to avoid contention; reseeded per thread. Probability check happens **after** all predicate checks, so a 50% rule that doesn't match the URL never increments a counter.
- **First-match-wins** is intentional. Multiple rules wanting to compose (e.g., "add header X" + "delay 200ms") must currently be combined into one rule, or chained via priority — the *higher-priority* one fires and the *lower-priority* one is shadowed for that request. F24 spec §3.2 allows multi-match; F28 P1 explicitly does not. Tracked in §7 future-work.
- **Response-phase rule won't match unmatched-phase context:** `PhaseMask` is bitwise. A `Both` rule fires once per phase if both phases match (counter increments twice).

**Interactions.**

- C01 calls this and dispatches on `match.Rule.Action`. The match struct contains the `MitmRule` reference, the runtime entry (for the coordinator to attach decisions to), and the `newCount` for event tagging.
- C03 is involved only when `match.Rule.Action == BreakpointPause` (S10).
- Telemetry: C01 attaches the match to the published `http` topic event under the `mitm { ruleId, action, phase, fireCount }` block (mirroring the existing `chaos` block at `EdogHttpPipelineHandler.cs:200-223`).

**Revert.** N/A — matching is a read.

---

### S03 — Lifecycle: MaxFirings, TTL, auto-disable · **P0**

**Description.** Rules carry counters that auto-retire them. The store eagerly skips exhausted/expired rules during match (lazy enforcement) and the active enforcement runs from two paths: (a) the matching path flips `Enabled=false` the moment `FireCount` reaches `MaxFirings`; (b) a low-cost timer (or per-write opportunistic sweep) purges expired rules so they don't accumulate.

**Mechanism.**

```csharp
private static void AutoDisable(string ruleId)
{
    // Cheap path: mutate runtime counter without rebuilding the snapshot.
    // The snapshot is rebuilt only when the rule is removed by the user.
    // Other threads see the new Enabled=false via volatile field on MitmRuleRuntime.
    var entry = FindEntry(ruleId);                      // O(N) scan of _orderedFlat
    if (entry != null) Volatile.Write(ref entry.Runtime.Enabled, false);

    PublishRuleLifecycleEvent(ruleId, "auto-disabled");  // via C04 → mitm topic
    Interlocked.Increment(ref _revision);
}

// Called periodically (every 5s) by a single background timer registered in MitmEngineHost.
public static int PurgeExpired(DateTimeOffset now)
{
    lock (_writeLock)
    {
        var next = CloneSnapshot(_byOwner);
        var removed = 0;
        foreach (var (key, arr) in next.ToList())
        {
            var kept = arr.Where(e => e.Rule.ExpiresAt is null || e.Rule.ExpiresAt > now).ToArray();
            removed += arr.Length - kept.Length;
            if (kept.Length == 0) next.Remove(key);
            else if (kept.Length != arr.Length) next[key] = kept;
        }
        if (removed > 0) CommitSnapshot(next);
        return removed;
    }
}
```

**Source path.** `MitmRuleStore.cs` (this component). Background timer wiring: `src/backend/DevMode/MitmEngineHost.cs` (C04 owns lifecycle of the host; the timer registration is shared).

**Edge cases.**

- **`MaxFirings == 0`:** unlimited, never auto-disables.
- **`ExpiresAt` in the past at create time:** rejected by validator (S01).
- **TTL expires while a request is mid-flight:** the mid-flight request continues with its original snapshot; the next `SendAsync` reads a new snapshot.
- **Re-enable after auto-disable:** allowed via `SetEnabled(id, true)`, but `FireCount` is NOT reset. A rule with `MaxFirings=5` that fired 5 times will auto-disable again on the next call. The user must `Remove`+`AddOrReplace` to reset counters.
- **Atomicity of "fire == disable":** `Interlocked.Increment` followed by an unsynchronised `Volatile.Write` is a benign race: at most one extra fire can slip through under high contention before disable propagates. That is acceptable for a chaos tool. The hard cap is enforced by the decrement-and-skip path in S02.

**Interactions.** Lifecycle events (`auto-disabled`, `expired`, `manual-enabled`) flow to C04, which publishes to the `mitm` topic. The frontend's Active Rules list updates reactively.

**Revert.** `SetEnabled(id, true)` re-enables; `Remove(id)` deletes outright.

---

### S04 — Owner-scoped purge (disconnect cleanup) · **P0**

**Description.** When a SignalR connection drops (`EdogPlaygroundHub.OnDisconnectedAsync`), every rule owned by that connection's MITM session must be purged. Same primitive serves manual "clear session" actions.

**Mechanism.**

```csharp
public static int PurgeByOwner(OwnerKey owner)
{
    lock (_writeLock)
    {
        if (!_byOwner.TryGetValue(owner, out var arr)) return 0;
        var next = CloneSnapshot(_byOwner);
        next.Remove(owner);
        CommitSnapshot(next);
        return arr.Length;
    }
}
```

**Source path.** `MitmRuleStore.cs`. Caller wiring: extend `src/backend/DevMode/EdogPlaygroundHub.cs` `OnDisconnectedAsync` (currently around `EdogPlaygroundHub.cs:406-410` for connected) to call `MitmRuleStore.PurgeByOwner(new OwnerKey(MitmOwnerType.MitmSession, Context.ConnectionId))` and to also call C03 to cancel any in-flight breakpoints owned by the same connection.

**Edge cases.**

- **Reconnect:** SignalR auto-reconnect generates a NEW `ConnectionId`. Rules from the previous connection stay purged — the frontend (per signalr-manager.js reconnected hook) re-pushes its local rule cache, generating new server-side rules. This is intentional: the contract is "rules live as long as the connection".
- **Purge during match scan:** the in-flight scan reads the old `_orderedFlat`. The next `SendAsync` reads the purged snapshot. No torn reads.
- **`InteractiveBreakpoint` rules:** also auto-purged because they share the owner connection's `OwnerId`. The matching breakpoint in C03 is cancelled separately.
- **Cross-owner purge:** N/A — owner is the key. Use `ClearAll()` for everything.

**Interactions.** C03 must be called *first* to release any pending breakpoint awaiters with `Drop` semantics (so the held request proceeds), then the store is purged. Order matters — purging the store first would leave the coordinator holding a `MitmMatch` reference whose `Rule.Enabled` flips to false but whose runtime entry is gone.

**Revert.** N/A — purge is destructive by design. Frontend can recreate by replaying its local cache.

---

### S05 — Block action · **P0**

**Description.** Matching rule with `Action=Block`: synthesize a canned `HttpResponseMessage` with the configured status/body/headers; **skip** `base.SendAsync`; publish event with `mitm.action="block"` and `synthesized=true`.

**Mechanism.** C01 dispatch (in `EdogHttpPipelineHandler.SendAsync`):

```csharp
if (match.Rule.Action == MitmActionType.Block)
{
    var cfg = (BlockConfig)match.Rule.ActionConfig;
    var resp = new HttpResponseMessage((HttpStatusCode)cfg.StatusCode)
    {
        RequestMessage = request,
        ReasonPhrase = $"MITM block (rule {match.Rule.Id})",
        Content = cfg.Body is null ? new StringContent("") : new StringContent(cfg.Body),
    };
    ApplyHeaders(resp, cfg.Headers);
    PublishMitmEvent(match, phase: "request", synthesized: true);
    return resp;
}
```

**Source path.** Dispatch lives in `src/backend/DevMode/EdogHttpPipelineHandler.cs:46` `SendAsync` (replaces the current `if (chaosFault != null …)` chain at lines 89-128). The synthesis helper extends `SynthesizeErrorResponse` at `EdogHttpPipelineHandler.cs:160-173`.

**Edge cases.** Identical to F27 P5's `http_error`. Status outside 100-599 → validator rejects at S01. Headers conflicting with `Content-Type` set by `StringContent` → request-supplied wins (`resp.Content.Headers.Remove("Content-Type")` first).

**Interactions.** C01 dispatches. Event published via C04's `mitm` topic + the existing `http` topic with a `mitm` block (mirrors `chaos` block at `EdogHttpPipelineHandler.cs:200-223`).

**Revert.** N/A per-request. Disable rule → next call goes through `base.SendAsync`.

---

### S06 — Forge action: full response fabrication · **P0**

**Description.** Same plumbing as Block but distinct semantics: forging is the "I want a *specific* response, not a *failure* response" intent. Enables seeding 200 OK responses with synthetic payloads for assertion testing.

**Mechanism.** Identical to S05 but with `ForgeConfig` (which adds `reasonPhrase`). Single helper:

```csharp
private static HttpResponseMessage Synthesize(
    HttpRequestMessage req, int status, string body,
    Dictionary<string,string> headers, string reasonPhrase)
{
    var resp = new HttpResponseMessage((HttpStatusCode)status)
    {
        RequestMessage = req,
        ReasonPhrase = reasonPhrase ?? $"MITM forge",
        Content = new StringContent(body ?? ""),
    };
    ApplyHeaders(resp, headers);
    return resp;
}
```

**Source path.** Shares helper with S05 in `EdogHttpPipelineHandler.cs`.

**Edge cases.**

- **Default `Content-Type`:** `StringContent` sets `text/plain; charset=utf-8`. Most forge bodies are JSON — frontend MUST set `Content-Type: application/json` in headers explicitly. Validator does not auto-detect (out of scope for P1).
- **Empty body:** allowed; `Content-Length: 0`.
- **`reasonPhrase` containing CRLF:** rejected by validator (response-splitting safety).

**Interactions.** Same as S05. The `mitm.action` event field is `"forge"` not `"block"` so the UI can distinguish the two in the row badge and traffic log.

**Revert.** N/A per-request.

---

### S07 — Modify request (headers / body / URL) · **P0**

**Description.** Three sub-actions sharing one dispatch branch: rewrite the outgoing `HttpRequestMessage` in place (or replace its `Content`) before `base.SendAsync`. The downstream consumer (FLT's real code path) sees the modified request.

**Mechanism.**

```csharp
case MitmActionType.ModifyRequestHeaders:
    ApplyHeaderOps(request.Headers, request.Content?.Headers,
                   ((ModifyRequestHeadersConfig)match.Rule.ActionConfig).Ops);
    break;

case MitmActionType.ModifyRequestUrl:
    request.RequestUri = RewriteUri(request.RequestUri,
                                    (ModifyRequestUrlConfig)match.Rule.ActionConfig);
    break;

case MitmActionType.ModifyRequestBody:
    var cfg = (ModifyRequestBodyConfig)match.Rule.ActionConfig;
    var newBody = await EditBodyAsync(request.Content, cfg.Edit, ct);   // full-buffer, see S12
    var oldHeaders = request.Content?.Headers.ToDictionary(h => h.Key, h => h.Value);
    request.Content = new StringContent(newBody);
    if (oldHeaders != null) foreach (var (k, v) in oldHeaders)
        if (!k.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
            request.Content.Headers.TryAddWithoutValidation(k, v);
    break;
```

**Source path.** `EdogHttpPipelineHandler.cs:46` `SendAsync`, in the request-phase dispatch. Helpers: `ApplyHeaderOps`, `RewriteUri`, `EditBodyAsync` — all new private methods in the same file (or extracted into `EdogHttpPipelineMitmExecutor.cs` if it grows past ~150 LOC).

**Edge cases.**

- **`HttpRequestMessage` mutability:** request headers are mutable but content is not (`HttpContent` is one-shot). Body modify must build a fresh `HttpContent` and copy headers.
- **`Content-Length` header:** must NOT be copied verbatim — `StringContent` recalculates it.
- **`Authorization` modify:** must respect the redaction policy from C01. Frontend can request the unredacted real value only if `revealAuth=true` was set on the rule (and feature gate allows it). Validator otherwise refuses a `set Authorization` op (R2 in P0).
- **`ModifyRequestUrl` host change:** if the new host is different from the original, the DelegatingHandler's outer `HttpClient` may have host-based DI assumptions. P1 allows host changes; runtime errors surface as the upstream throwing — published as `mitm.error`.
- **Combined modify:** multiple modify-request rules don't compose (first-match-wins, S02). Frontend can author a single rule with multiple ops.

**Interactions.** Modify happens before `base.SendAsync`; the published `http` event reflects the **modified** request in its snapshot. The `mitm` event additionally lists the modifications (`{ target, op, summary }` array — see wire shape in P0 §2.1) so the user sees both versions in the UI.

**Revert.** The modify is per-call. Disabling the rule reverts behaviour on the next call.

---

### S08 — Modify response (status / headers / body) · **P0**

**Description.** Response-phase analogue of S07. The match runs **after** `base.SendAsync` returns. The response is mutated (status, headers) or its `Content` replaced (body) before returning to the FLT consumer.

**Mechanism.**

```csharp
// After base.SendAsync, with response in hand:
if (MitmRuleStore.TryMatch(ctx, MitmPhase.Response, out var rMatch))
{
    switch (rMatch.Rule.Action)
    {
        case MitmActionType.ModifyResponseStatus:
            var sc = (ModifyResponseStatusConfig)rMatch.Rule.ActionConfig;
            response.StatusCode = (HttpStatusCode)sc.StatusCode;
            if (sc.ReasonPhrase != null) response.ReasonPhrase = sc.ReasonPhrase;
            break;

        case MitmActionType.ModifyResponseHeaders:
            ApplyHeaderOps(response.Headers, response.Content?.Headers,
                           ((ModifyResponseHeadersConfig)rMatch.Rule.ActionConfig).Ops);
            break;

        case MitmActionType.ModifyResponseBody:
            var bcfg = (ModifyResponseBodyConfig)rMatch.Rule.ActionConfig;
            await response.Content.LoadIntoBufferAsync();             // reuse the trick at L371
            var newBody = await EditBodyAsync(response.Content, bcfg.Edit, ct);
            var headers = response.Content.Headers.ToList();
            response.Content = new StringContent(newBody);
            foreach (var h in headers)
                if (!h.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                    response.Content.Headers.TryAddWithoutValidation(h.Key, h.Value);
            break;
    }
    PublishMitmEvent(rMatch, phase: "response", synthesized: false);
}
```

**Source path.** Inserted at `EdogHttpPipelineHandler.cs` immediately after the existing `base.SendAsync` call at `EdogHttpPipelineHandler.cs:127` and before the telemetry block at `:131`. The body-buffer trick at `CaptureBodyPreview` (`L356-392`) is reused.

**Edge cases.**

- **Response already disposed:** can't happen here — we hold the only reference.
- **Stream not re-readable after edit:** `LoadIntoBufferAsync` makes it seekable; we replace `Content` outright, so the downstream consumer reads the new body once.
- **Status code transitions:** changing 200→500 leaves the response body untouched unless `ModifyResponseBody` also fires. First-match-wins means at most one of the three response actions fires per request — frontend authors a combined "ModifyResponseBody" rule if they want both, with the body containing the desired error shape.
- **Binary content (`Content-Type: application/octet-stream`):** body edit is rejected at the matcher level (body matcher only runs on text content per `CaptureBodyPreview.IsTextContent` at `EdogHttpPipelineHandler.cs:397`). If the user really wants to forge binary, they must use Forge (S06) which constructs the whole response from scratch.

**Interactions.** Telemetry. The published `http` event reflects the *modified* response (status, headers, body preview), with the `mitm` block listing the original values in `modifications[].from` so the UI can diff.

**Revert.** Per-call.

---

### S09 — Delay action · **P0**

**Description.** Inject `await Task.Delay(N)` either before forwarding (request phase) or before returning to FLT (response phase). Reuses F27 P5's pattern.

**Mechanism.**

```csharp
case MitmActionType.Delay:
    var dcfg = (DelayConfig)match.Rule.ActionConfig;
    if (dcfg.DelayMs > 0)
        await Task.Delay(dcfg.DelayMs, ct).ConfigureAwait(false);
    PublishMitmEvent(match, phase: dcfg.Phase, synthesized: false);
    break;  // then continue with base.SendAsync (or response return) as normal
```

**Source path.** Same dispatch site in `EdogHttpPipelineHandler.cs:46` `SendAsync`. Mirrors the existing `latency` branch at `EdogHttpPipelineHandler.cs:116-123`.

**Edge cases.**

- **Bounds:** validator rejects `DelayMs < 0` or `> 600_000` (10 min cap, same as F27 P5 at `EdogHttpFaultStore.cs:230-232`).
- **Cancellation:** the request's `CancellationToken` propagates. If the caller cancels mid-delay, `OperationCanceledException` surfaces to FLT exactly as a normal cancellation. A `mitm.action="delay-cancelled"` event is published.
- **Compounding with other actions:** first-match-wins, so a single rule can either delay OR modify, not both. Frontend authors them as separate rules at different priorities if needed — but only the first will fire (P1 limitation).
- **Response-phase delay** still publishes the underlying `http` event with the actual duration (delay is part of the measured `durationMs`).

**Interactions.** Straightforward. No coordinator involvement.

**Revert.** Per-call.

---

### S10 — BreakpointPause action: delegate to MitmCoordinator · **P0**

**Description.** A rule with `Action=BreakpointPause` halts the in-flight request and hands control to C03 (`MitmCoordinator`) which awaits a frontend decision (`Forward` / `Drop` / `Modify`). The Rule Engine's job is just to identify the match and dispatch; the actual suspension lives in C03.

**Mechanism.**

```csharp
case MitmActionType.BreakpointPause:
    var bcfg = (BreakpointPauseConfig)match.Rule.ActionConfig;
    var decision = await MitmCoordinator.AwaitDecisionAsync(
        new BreakpointSnapshot(match, request, response: null),
        timeoutMs: bcfg.TimeoutMs,
        ct: ct);
    switch (decision.Kind)
    {
        case BreakpointDecisionKind.Forward:
            // apply optional edits then fall through to base.SendAsync
            ApplyEdits(request, decision.Edits);
            break;
        case BreakpointDecisionKind.Drop:
            return Synthesize(request, decision.DropStatus ?? 499,
                              decision.DropBody, decision.DropHeaders, "MITM drop");
        case BreakpointDecisionKind.Modify:
            ApplyEdits(request, decision.Edits);
            break;
        case BreakpointDecisionKind.TimedOut:
            PublishMitmEvent(match, phase: "request", synthesized: false,
                             extra: new { timedOut = true });
            break;  // proceed untouched
    }
    break;
```

**Source path.** Dispatch in `EdogHttpPipelineHandler.cs:46`. Coordinator in new file `src/backend/DevMode/MitmCoordinator.cs` (owned by C03 spec).

**Edge cases.**

- **Timeout (R1 in P0):** `BreakpointPauseConfig.TimeoutMs` (default 30_000) — if no decision arrives, the request proceeds untouched and a `mitm.timedOut` event publishes. Non-negotiable safety net.
- **Connection drops during pause (R6 in P0):** C03 cancels all pending awaiters owned by the disconnecting connection BEFORE S04 purges rules.
- **Rule auto-disables after firing:** `MaxFirings=1` is enforced by validator (S01), so a breakpoint rule fires exactly once. The atomic-increment safety in S02 prevents two concurrent matches.
- **Response-phase breakpoint:** rule `PhaseMask=Response` is allowed; C03 receives the snapshot with the real response in hand and may edit it before delivery.

**Interactions.** C03 owns the suspension; this component just hands off the match. The `mitm` topic publishes `breakpoint.pending` (when paused), `breakpoint.resumed` (when decision arrives), `breakpoint.timedOut` (on timeout) — all owned by C04/C03 wiring, not this component.

**Revert.** The rule auto-disables on fire. Frontend can re-arm by creating a new rule.

---

### S11 — Rule precedence ordering · **P0**

**Description.** When multiple stores (F28 `MitmRuleStore` + F27 P5 `EdogHttpFaultStore`) are both active, and within `MitmRuleStore` when rules from different owner types coexist, the engine evaluates in a deterministic precedence:

```
Tier 0: Interactive Breakpoints (MitmOwnerType.InteractiveBreakpoint)
Tier 1: QA Scenario Faults     (MitmOwnerType.QaScenario OR EdogHttpFaultStore)
Tier 2: MITM Session Rules     (MitmOwnerType.MitmSession)
Tier 3: Chaos Panel Rules      (MitmOwnerType.ChaosPanel)  ← F24 future
```

**Rationale.** A human at the keyboard interacting with a request is the most-specific intent; QA scenarios are intentional automated injections that should beat a long-lived session rule; chaos-panel rules are background-noise simulations and lose to everything else.

**Mechanism.** Precedence is encoded into `_orderedFlat` at snapshot-commit time:

```csharp
internal static int TierRankOf(MitmOwnerType t) => t switch
{
    MitmOwnerType.InteractiveBreakpoint => 0,
    MitmOwnerType.QaScenario            => 1,
    MitmOwnerType.MitmSession           => 2,
    MitmOwnerType.ChaosPanel            => 3,
    _                                   => int.MaxValue,
};

// In CommitSnapshot:
//   .OrderBy(e => e.OwnerTierRank).ThenBy(e => e.Rule.Priority).ThenBy(e => e.Rule.CreatedAt)
```

So when `TryMatch` walks `_orderedFlat`, the first hit is automatically the highest-precedence rule.

**Cross-store precedence with `EdogHttpFaultStore` (F27 P5):** C01 calls `MitmRuleStore.TryMatch` FIRST. Only if it returns false does C01 fall back to `EdogHttpFaultStore.TryMatchFault`. F28 thus *automatically* wins over F27 P5 when both have a match — which is correct because Tier 0/1/2 all need to beat the legacy store. The legacy store is effectively Tier 1.5 (between QA Scenario via new store and MITM Session). That's an acceptable wrinkle for the migration window. F24 cleans this up by migrating P5 onto `MitmRuleStore`.

**Source path.** `MitmRuleStore.CommitSnapshot` (this file). C01 fallback call sequence in `EdogHttpPipelineHandler.cs:46` `SendAsync`.

**Edge cases.**

- **Same tier, same priority, same `CreatedAt` timestamp (sub-millisecond collisions):** order falls through to insertion order of the `next` dictionary. Deterministic enough for testing; not ABI-stable for users — document that priority should be set if order matters.
- **Tier inversion attempted via `Priority`:** a `MitmSession` rule with `Priority=0` still loses to an `InteractiveBreakpoint` with `Priority=10000`. Tier dominates priority by design.
- **Disabled rule in higher tier:** doesn't intercept; the matcher continues into lower tiers as normal.

**Interactions.** C01 needs to know about the cross-store fallback. C04 documents the tier rank in `MitmGetCapabilities()` so the UI can render order correctly in an Active Rules list.

**Revert.** N/A — ordering is structural.

---

### S12 — Body buffering policy: 4KB preview vs full body for modify · **P0**

**Description.** The current pipeline (`EdogHttpPipelineHandler.cs:27-28`) caps body capture at 4KB preview and 10MB bufferable max. This is right for observation but wrong for modify — a modify action needs the *full* body, then to replace it. The Rule Engine declares which path each action requires, and C01 implements two code paths.

**Mechanism.**

```csharp
internal static bool RequiresFullBodyBuffer(MitmActionType action) => action switch
{
    MitmActionType.ModifyRequestBody  => true,
    MitmActionType.ModifyResponseBody => true,
    _                                 => false,
};

// In EdogHttpPipelineHandler.SendAsync:
var match = TryMatch(...);
if (match.Found && MitmRuleStore.RequiresFullBodyBuffer(match.Rule.Action))
{
    // Buffer the FULL body (up to 10MB cap)
    var fullBody = await ReadFullBodyAsync(request.Content, MaxBufferableBytes, ct);
    if (fullBody == null)
    {
        // > 10MB → rule cannot apply. Publish error event, proceed as if no match.
        PublishMitmEvent(match, "request", synthesized: false,
                         extra: new { error = "body-too-large", limitBytes = MaxBufferableBytes });
        // fall through to base.SendAsync untouched
    }
    else
    {
        // apply edit to fullBody, swap into request.Content
    }
}
else
{
    // existing 4KB preview path — unchanged
}
```

**Source path.** Helper `RequiresFullBodyBuffer` in `MitmRuleStore.cs`. Body buffering helper `ReadFullBodyAsync` in `EdogHttpPipelineHandler.cs` (extends the existing `CaptureBodyPreview` at `L356-392`, swapping the 4KB cap for `MaxBufferableBytes=10_485_760` at `L28`).

**Edge cases.**

- **Body match predicate vs. full-body buffer:** body MATCHING (S02) currently runs against the 4KB preview. A modify rule whose body matcher matches only past byte 4097 will not fire. Document this; treat as P1 limitation. Workaround: match on URL/headers only when body modifying.
- **Streaming content (chunked transfer):** `LoadIntoBufferAsync` materialises the full stream into memory. For >10MB we already skip (`L363-364`). New behaviour: skip and publish `body-too-large` error rather than silently truncating.
- **Binary content:** body modify is rejected pre-match (only text types per `IsTextContent` at `L397`). For binary modify, the rule will not match — same logic as today.
- **Auth/cookie headers preserved:** the new `StringContent` rebuild copies all original headers except `Content-Length` (S07/S08).

**Interactions.** C01 owns the two-path implementation. C02 just provides the policy bit (`RequiresFullBodyBuffer`).

**Revert.** N/A — buffering is per-call.

---

### S13 — Fast-path: zero rules → no overhead · **P0**

**Description.** When no rules are active, the request must take **zero** measurable overhead beyond the pre-existing F27 P5 + telemetry cost. This is the same guarantee F24 spec §3.1 makes and `EdogHttpFaultStore.TryMatchFault` already implements (`EdogHttpFaultStore.cs:181`).

**Mechanism.**

```csharp
public static bool TryMatch(in MitmMatchContext ctx, MitmPhase phase, out MitmMatch match)
{
    match = default;
    var rules = _orderedFlat;            // single volatile read, no lock
    if (rules.Length == 0) return false; // hot exit — no further work
    // ... real scan ...
}
```

And on the C01 side:

```csharp
// Single combined fast-path: both stores empty → unchanged baseline
if (MitmRuleStore.ActiveRuleCount == 0 && EdogHttpFaultStore.ActiveRuleCount == 0)
{
    // existing F27 P5 baseline path: no chaos lookup, straight to base.SendAsync
}
```

**Source path.** `MitmRuleStore.TryMatch` (this file). C01 fast-path guard added at top of `EdogHttpPipelineHandler.SendAsync` (`EdogHttpPipelineHandler.cs:46`).

**Edge cases.**

- **Cost in steady state:** two reference-typed field reads (`_orderedFlat`, `_flatRules`) and two `.Length == 0` checks. Sub-nanosecond. Verified by Sentinel benchmark gate at P3.
- **Volatile semantics:** `volatile` on `_orderedFlat` ensures readers see the latest snapshot after a writer's `CommitSnapshot`. No torn references on x86-64 (8-byte aligned ref writes are atomic).
- **Rule added between two requests:** the first request after the write sees the new snapshot due to `Volatile.Write` ↔ `Volatile.Read` happens-before edge.

**Interactions.** None — purely a perf invariant.

**Revert.** N/A.

---

### S14 — Concurrent rule evaluation: thread safety · **P0**

**Description.** `SendAsync` is called on arbitrary thread-pool threads, potentially thousands per second. Rule evaluation must be lock-free on the read side and produce correct counters under contention.

**Mechanism (composition of established primitives):**

| Concern | Mechanism |
|---|---|
| Reading the rule list | `volatile RuleEntry[] _orderedFlat` — single ref read, no lock |
| Reading individual rule fields | `MitmRule` is an immutable record — field reads are safe |
| Reading runtime state (`Enabled`, `FireCount`) | `Volatile.Read` on `Enabled`; `Interlocked.Read` on `FireCount` |
| Incrementing fire counter | `Interlocked.Increment(ref entry.Runtime.FireCount)` |
| Enforcing `MaxFirings` hard cap | Increment, compare against cap, `Interlocked.Decrement`-and-skip if over (S02 sketch) |
| Auto-disable propagation | `Volatile.Write(ref entry.Runtime.Enabled, false)` — readers see within next L1 cycle |
| Snapshot replacement | `Volatile.Write(ref _orderedFlat, newArray)` inside `_writeLock` |
| Multi-step writes (purge, add) | All under `lock(_writeLock)` — only one writer at a time |
| Revision counter | `Interlocked.Increment(ref _revision)` |
| Probability RNG | `[ThreadLocal] static Random _rng` — no shared state |

**Source path.** `MitmRuleStore.cs` (this file). Test coverage:

- New test file `src/backend/DevMode.Tests/MitmRuleStoreConcurrencyTests.cs`.
- Required tests (Sentinel gate):
  1. 1000 threads each calling `TryMatch` × 10_000: no exceptions, counter equals sum of fires.
  2. Writer thread doing `AddOrReplace`/`Remove` at 100/s while readers fire at 100k/s: no torn snapshots, no double-fire past `MaxFirings`.
  3. `MaxFirings=N` under contention: total fires ≤ N + ε where ε is the brief window before auto-disable propagates; ε must be ≤ thread count (documented bound).
  4. `PurgeByOwner` during active matching: in-flight matches complete with pre-purge rules; subsequent calls see purged state.

**Edge cases.**

- **Word-tearing on `FireCount`:** 64-bit field read on 32-bit platforms is not atomic; we always use `Interlocked.Read` / `Interlocked.Increment`. The DevMode build targets net8.0 (64-bit), but we don't rely on platform width.
- **`MitmRuleRuntime.Enabled` is a `bool` (1 byte):** `Volatile.Write`/`Volatile.Read` give us the memory-barrier semantics we need; the field write itself is atomic on all supported platforms.
- **ABA on snapshot replacement:** not possible — we always create a new array; we never mutate an existing one.
- **Reader sees a `RuleEntry` whose `Runtime` has been swapped:** can't happen because `Runtime` is set once at construction and never replaced; counters mutate via `Interlocked`.

**Interactions.** Sentinel owns the concurrency test gate. Vex implements the store. No external locks held during user-supplied regex execution (`Regex.MatchTimeout=50ms` ensures even a misbehaving pattern doesn't hold up the hot path indefinitely).

**Revert.** N/A — concurrency invariants are baseline correctness.

---

## 7. Open Questions for P2

Tracked here to keep them out of P1 scope but explicit:

1. **Multi-match composition.** F24 spec implies multiple rules can compose on one request. F28 P1 hard-stops at first-match. Decide in P2 whether to add an `AllowChain=true` per-rule flag, or a `compose: ["request-mod", "delay"]` rule list per request.
2. **Body-match past 4KB.** Lift to full-buffer when body matcher is present? Per-rule opt-in via `MatchFullBody=true`?
3. **Persistent rules across reconnect.** Today: purge on disconnect. Should `MitmOwnerType.MitmSession` rules persist N minutes by `OwnerId=user@machine` rather than `ConnectionId`?
4. **Reset counters on `SetEnabled(true)`.** Currently no; argued for clarity, against for "I just want to pause briefly".
5. **Per-tier kill switch.** `Ctrl+Shift+K` clears all; should there be `Ctrl+Shift+B` for just breakpoints?

---

## 8. File Surface Summary

New files this component introduces:

| Path | Purpose |
|---|---|
| `src/backend/DevMode/MitmRuleStore.cs` | The store + matcher (this spec) |
| `src/backend/DevMode/MitmRule.cs` | The rule record + nested matcher records + enums |
| `src/backend/DevMode/MitmActionConfigs.cs` | Sealed action config classes (BlockConfig, ForgeConfig, …) |
| `src/backend/DevMode/MitmRuleValidator.cs` | S01 validation, with error codes |
| `src/backend/DevMode/MitmRuleCompiler.cs` | Regex compile-once, jsonpath parse-once |
| `src/backend/DevMode.Tests/MitmRuleStoreTests.cs` | Unit tests for CRUD + lifecycle |
| `src/backend/DevMode.Tests/MitmRuleStoreConcurrencyTests.cs` | S14 thread-safety tests |
| `src/backend/DevMode.Tests/MitmRuleMatcherTests.cs` | Predicate matrix |

Files this component **modifies** (work owned by C01, listed for traceability):

| Path | Change |
|---|---|
| `src/backend/DevMode/EdogHttpPipelineHandler.cs` | Replace single-store match at L83 with two-store dispatch (S11); add request/response phase dispatch (S05-S10); add full-body buffering branch (S12); add fast-path guard (S13). |
| `src/backend/DevMode/EdogTopicRouter.cs` | Register `mitm` topic at `L34` (owned by C04). |

Files this component **explicitly does not touch**: `EdogHttpFaultStore.cs` stays intact through F28; F24 migrates it later.
