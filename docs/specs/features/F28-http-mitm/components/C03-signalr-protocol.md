# F28 HTTP MITM — C03: SignalR Protocol (P1 Component Deep Spec)

> **Author:** Sana (Architecture)
> **Status:** SPEC — READY FOR REVIEW
> **Date:** 2026-08
> **Depends on:** `research/p0-foundation.md` (research gate), ADR-006 (SignalR + JSON), `EdogPlaygroundHub.cs`, `EdogTopicRouter.cs`, `EdogHttpPipelineHandler.cs`
> **Sibling components:** C01 Coordinator, C02 Rule Engine, C04 UI
> **Applies to:** `src/backend/DevMode/EdogPlaygroundHub.cs`, `src/backend/DevMode/EdogTopicRouter.cs`, `src/backend/DevMode/Mitm/*` (new), `src/frontend/js/signalr-manager.js`, `src/frontend/js/tab-http.js`, `src/frontend/js/mitm-client.js` (new)

---

## 0. TL;DR

The F28 wire protocol is **one new hub method region** (`Mitm*` RPCs on `EdogPlaygroundHub`) plus **one new SignalR topic** (`mitm`) for control-plane events, layered on the existing `/hub/playground` connection. The `http` topic gains an optional `mitm` block in its event envelope — additive, fully backward-compatible with `tab-http.js:88–117`. No new transport, no new auth, no new connection.

Hub methods are RPC (request → response envelope). Control-plane events stream via the canonical `SubscribeToTopic("mitm")` `ChannelReader<TopicEvent>` pattern that `signalr-manager.js:194–224` already speaks. The interactive **breakpoint pause** semantic is delivered by a normal RPC (`MitmResumeBreakpoint`) — the C# pipeline handler holds the request open via a `TaskCompletionSource` owned by C01 (`MitmCoordinator`); the frontend learns about pauses via the `mitm` topic. No new SignalR primitive is required.

Naming: every method is prefixed `Mitm` to avoid collision with the `Qa*` and (future) `Chaos*` regions (`p0-foundation.md:309`). Every payload key is `camelCase` on the wire (matches existing hub serialization).

---

## 1. Message Catalog

### 1.1 Client → Server RPC (hub methods)

| # | Method | Parameters | Returns | Priority | Purpose |
|---|--------|------------|---------|----------|---------|
| 1 | `MitmGetCapabilities` | — | `MitmCapabilityReport` | **P0** | Discover whether MITM is enabled, supported actions, limits |
| 2 | `MitmCreateRule` | `rule: MitmRuleInput` | `MitmRuleResult` | **P0** | Create a rule (breakpoint / block / forge / modify / delay) |
| 3 | `MitmUpdateRule` | `rule: MitmRuleInput` | `MitmRuleResult` | **P0** | Update an existing rule (preserves fireCount, createdAt) |
| 4 | `MitmDeleteRule` | `ruleId: string` | `MitmOperationResult` | **P0** | Remove a rule. Idempotent. |
| 5 | `MitmListRules` | `filter?: MitmRuleFilter` | `MitmRule[]` | **P0** | Reconcile rules after reconnect; populate UI on cold open |
| 6 | `MitmGetRule` | `ruleId: string` | `MitmRule \| null` | P1 | Fetch a single rule (used by rule editor open) |
| 7 | `MitmResumeBreakpoint` | `decision: MitmBreakpointDecision` | `MitmOperationResult` | **P0** | Resume a paused intercept with forward/modify/block/forge |
| 8 | `MitmReplayRequest` | `request: MitmReplayInput` | `MitmReplayResult` | **P0** | Replay a captured request through the pipeline |
| 9 | `MitmClearAll` | — | `MitmOperationResult` | **P0** | Kill switch — delete all rules, resume all paused intercepts |
| 10 | `MitmToggleInterception` | `enabled: bool` | `MitmOperationResult` | **P0** | Global on/off (rules remain but engine becomes pass-through) |

### 1.2 Server → Client events (topic `mitm` via `SubscribeToTopic`)

| # | Event `type` | Trigger | Priority |
|---|--------------|---------|----------|
| E1 | `mitm.capabilityChanged` | Env var / build flag changed (rare; emitted on connect) | P1 |
| E2 | `mitm.interceptionToggled` | `MitmToggleInterception` succeeded | P0 |
| E3 | `mitm.ruleCreated` | `MitmCreateRule` succeeded | **P0** |
| E4 | `mitm.ruleUpdated` | `MitmUpdateRule` succeeded, or rule mutated server-side (TTL expiry, fireCount tick threshold) | **P0** |
| E5 | `mitm.ruleDeleted` | `MitmDeleteRule` succeeded, or session-owned rule auto-purged on disconnect | **P0** |
| E6 | `mitm.ruleMatched` | A non-breakpoint rule fired (block / forge / modify / delay) | **P0** |
| E7 | `mitm.breakpointHit` | A breakpoint rule paused a request — UI must surface and offer decision | **P0** |
| E8 | `mitm.breakpointResumed` | `MitmResumeBreakpoint` applied successfully (also fires on auto-resume) | **P0** |
| E9 | `mitm.breakpointTimedOut` | Breakpoint hit the configured timeout (R1 — `p0-foundation.md:504`); request proceeded untouched | **P0** |
| E10 | `mitm.breakpointCancelled` | Connection dropped or `MitmClearAll` resumed a paused intercept | P1 |
| E11 | `mitm.replayCompleted` | A `MitmReplayRequest` finished (success or HTTP error) | **P0** |
| E12 | `mitm.replayFailed` | Replay aborted (transport error, validation failure) | P1 |
| E13 | `mitm.cleared` | `MitmClearAll` succeeded — broadcast to ALL clients (safety-critical, per F24 pattern §1.2 `ChaosKillSwitch`) | **P0** |
| E14 | `mitm.rateLimitWarning` | Rule fire rate exceeded soft cap (e.g., >100 fires/s) — engine downgrades to log-only | P2 |

### 1.3 Enhanced `http` topic event

| Block | Status | Shape source |
|-------|--------|--------------|
| `data.mitm` | **new, optional** | §5.1 — same additive pattern as existing `data.chaos` (`p0-foundation.md:240–251`) |

No breaking change. Consumers (`tab-http.js:88–117`) read `entry.mitm` defensively (`if (entry.mitm) {...}`).

---

## 2. Wire-Level Conventions

These conventions apply to every section below. Stated once, not repeated.

| Convention | Value | Authority |
|---|---|---|
| Hub URL | `http://localhost:<port>/hub/playground` | ADR-006, `signalr-manager.js:57` |
| Protocol | JSON over WebSocket (MessagePack pending) | ADR-006 |
| RPC invocation | `connection.invoke('MitmXxx', arg1, arg2)` | `signalr-manager.js:186` style — direct invoke, no wrapper (`p0-foundation.md:186`) |
| Topic streaming | `connection.stream('SubscribeToTopic', 'mitm')` | `signalr-manager.js:194–224` |
| Result envelope | `{ success: bool, message?: string, validationErrors?: ValidationError[], ... }` | `Qa*` pattern (`EdogPlaygroundHub.cs:493`+) |
| Topic event envelope | `{ sequenceId, timestamp, topic: "mitm", data: { type, ...payload } }` | `TopicEvent.cs:17–30` |
| Field naming on wire | `camelCase` (default SignalR JSON serializer) | existing hub |
| Authorization header redaction | Always `"[redacted]"` in published events; raw value only inside *paused-breakpoint snapshots* delivered via the `mitm` topic, gated by capability flag | R2 (`p0-foundation.md:505`) |
| SAS-token URL redaction | Always applied to `url` in `http` topic events | `RedactUrl` (`EdogHttpPipelineHandler.cs:253–264`) |
| Body size cap (preview) | 4 KB for observation events | `MaxBodyPreviewBytes` (`EdogHttpPipelineHandler.cs:27`) |
| Body size cap (editor) | 10 MB for modify-and-forward / replay | `MaxBufferableBytes` (`EdogHttpPipelineHandler.cs:28`), R3 |
| Breakpoint default timeout | 30 000 ms | R1 |
| Connection-bound ownership | Every rule and every paused intercept is owned by the SignalR `Context.ConnectionId` that created it. Auto-purged on `OnDisconnectedAsync`. | R6, R10 |
| Capability gate | `MitmCapabilityReport.enabled == false` unless `EDOG_MITM_INTERACTIVE=1` AND build flag `HttpChaosPipelineWired = true` | §2.2 of P0 (`p0-foundation.md:286`) |

### 2.1 Identifier shapes

| ID | Format | Owner | Lifetime |
|----|--------|-------|----------|
| `connectionId` | SignalR `Context.ConnectionId` (string) | hub | one SignalR connection |
| `sessionId` | `"mitm-" + 8-hex` | server, assigned on first MITM RPC for a connection | one connection (re-assigned on reconnect) |
| `ruleId` | client-supplied, `[a-z0-9-]{1,64}`; if omitted, server assigns `"rule-" + ulid` | client | until `MitmDeleteRule` / connection close / `MitmClearAll` |
| `interceptId` | server-assigned per breakpoint hit, `"int-" + ulid` | server | from `breakpointHit` to `breakpointResumed` / `breakpointTimedOut` / `breakpointCancelled` |
| `correlationId` | from `x-ms-correlation-id` header (or upstream HTTP correlation) | request | one HTTP round-trip |
| `replayId` | server-assigned, `"rpl-" + ulid` | server | from `MitmReplayRequest` call to `replayCompleted` |

> **Why `sessionId` exists separately from `connectionId`:** `sessionId` survives in client-side rule labels and audit logs even after the connection ends. `connectionId` is opaque SignalR state. Frontend never sends `connectionId`; the server reads it from `Context`.

### 2.2 Topic subscription lifecycle

```
client                               server
  |  invoke('Subscribe','mitm')         |    (group subscribe — legacy, optional)
  |  stream('SubscribeToTopic','mitm')  |
  |------------------------------------>|
  |                                     | Phase 1: yields ring snapshot (up to 1000)
  |<------------------------------------|
  |                                     | Phase 2: yields live events
  |<------------------------------------|
  |                                     |
  |  stream.dispose() / disconnect      |
  |------------------------------------>|
  |                                     | CancellationToken fires; channel closes
```

The frontend MUST subscribe to `mitm` early (recommended: on `HttpPipelineTab` construct, alongside the existing `http` subscription at `tab-http.js:56–59`) so that breakpoint hits are visible even when the HTTP tab is hidden.

---

## 3. Capability Discovery

### 3.1 `MitmGetCapabilities`

Discover whether the in-process MITM service is enabled, what actions are supported, and what limits apply. Must be called **before** any other `Mitm*` method; UI gates itself on the result.

**Parameters:** none.

**Returns:** `MitmCapabilityReport`

```json
{
  "enabled": true,
  "sessionId": "mitm-7f3a2c1d",
  "reason": null,
  "supportedActions": ["block", "forge", "modify", "delay", "breakpoint"],
  "supportedBreakpointPhases": ["request", "response"],
  "supportedMatchers": {
    "url": ["substring", "regex", "exact"],
    "method": ["set"],
    "headers": ["equals", "contains", "regex", "exists"],
    "body": ["jsonpath", "regex"],
    "httpClientName": ["set"]
  },
  "limits": {
    "maxRulesPerSession": 100,
    "maxConcurrentBreakpoints": 16,
    "maxBodyEditorBytes": 10485760,
    "breakpointTimeoutMs": 30000,
    "maxRulesGlobal": 500
  },
  "flags": {
    "revealAuthHeader": false,
    "allowProductionUrls": true,
    "replayEnabled": true
  },
  "serverVersion": "f28-p1-2026.08"
}
```

| Field | Type | Notes |
|---|---|---|
| `enabled` | bool | `false` when `EDOG_MITM_INTERACTIVE != "1"` or `HttpChaosPipelineWired == false`. When false, all other `Mitm*` methods return `{ success:false, message:"MITM disabled" }`. |
| `sessionId` | string | Server-assigned for the current connection. Stable until disconnect. |
| `reason` | string\|null | When `enabled:false`, human-readable explanation: `"EDOG_MITM_INTERACTIVE not set"`, `"Build constant HttpChaosPipelineWired is false"`. |
| `supportedActions` | string[] | Subset of `["block","forge","modify","delay","breakpoint","passthrough"]`. |
| `supportedMatchers` | object | Capability matrix the UI consumes to enable/disable matcher inputs. |
| `limits.maxRulesPerSession` | int | Per-connection hard cap. Exceeding it on `MitmCreateRule` → `validationErrors:[{field:"rule",message:"Per-session rule limit reached"}]`. |
| `limits.maxConcurrentBreakpoints` | int | Pending paused intercepts above this cap → new matches auto-bypass with a `breakpointCancelled` event (`reason:"capacity"`). |
| `limits.breakpointTimeoutMs` | int | Default; per-rule override allowed up to 2× this value. |
| `flags.revealAuthHeader` | bool | When `true`, paused-intercept snapshots include real `Authorization` header. Off by default (R2). Requires explicit env `EDOG_MITM_REVEAL_AUTH=1`. |
| `flags.replayEnabled` | bool | When `false`, `MitmReplayRequest` returns `{success:false,message:"Replay disabled by policy"}`. |
| `serverVersion` | string | Wire-protocol revision tag for the UI to detect mismatch. |

**Error codes:** none. `MitmGetCapabilities` always succeeds — it is the canary call.

**Sequence:**

```
UI (HttpPipelineTab.activate)        EdogPlaygroundHub          MitmCoordinator (C01)
   |  invoke('MitmGetCapabilities')      |                          |
   |------------------------------------>|                          |
   |                                     |  GetCapabilities()       |
   |                                     |------------------------->|
   |                                     |   reads env + flags      |
   |                                     |<-------------------------|
   |             MitmCapabilityReport    |                          |
   |<------------------------------------|                          |
   |  if (!enabled) gray-out UI          |                          |
   |  else show Intercept toggle, etc.   |                          |
```

**Edge cases:**
- **Reconnect:** Client MUST re-invoke after every `onreconnected` because `sessionId` is re-assigned per connection.
- **Concurrent calls:** Idempotent; safe to call N times.
- **Capability changed mid-session:** Server emits `mitm.capabilityChanged` event (E1). UI re-fetches.

**Interactions:**
- **C01 (Coordinator):** Owns the capability struct; reads env vars at startup; tracks `sessionId` per `connectionId`.
- **C02 (Rule Engine):** Reports `maxRulesGlobal` from its store config.
- **C04 (UI):** Branches the entire HTTP tab on `enabled` — `true` exposes Intercept toggle + per-row right-click MITM items; `false` hides everything.

---

## 4. Rule CRUD

### 4.0 `MitmRuleInput` shape

The shared rule shape for `MitmCreateRule` and `MitmUpdateRule`. **Lifted from `chaos-mitm-capabilities.md:42–113` with F28-specific simplifications** (`p0-foundation.md:198`). C02 owns full validation semantics; the wire shape is:

```json
{
  "id": "block-onelake-503",
  "name": "Block OneLake reads with 503",
  "description": "Returns service unavailable for all OneLake list calls during chaos test.",
  "enabled": true,
  "priority": 100,

  "match": {
    "url": { "op": "regex", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com/.*/Tables" },
    "method": { "op": "in", "values": ["GET"] },
    "httpClientName": { "op": "in", "values": ["OneLakeRestClient"] },
    "headers": [
      { "name": "x-ms-version", "op": "exists" }
    ],
    "body": null
  },

  "action": {
    "type": "forge",
    "forge": {
      "statusCode": 503,
      "headers": { "Retry-After": "30", "Content-Type": "application/json" },
      "body": "{\"error\":{\"code\":\"ServiceUnavailable\",\"message\":\"Forged.\"}}"
    }
  },

  "limits": {
    "maxFirings": 50,
    "ttlSeconds": 600,
    "ratePerSecond": null
  },

  "ownership": {
    "scope": "session",
    "ownerSessionId": "mitm-7f3a2c1d"
  },

  "tags": ["onelake", "503-storm"]
}
```

**Field summary** (full per-field validation is C02's spec):

| Field | Type | Notes |
|---|---|---|
| `id` | string? | Client may supply (must be unique within session); else server assigns. |
| `name` | string | Required, 1–120 chars. |
| `enabled` | bool | Default `true`. `false` = rule exists but engine ignores it (draft state). |
| `priority` | int | 0–1000. Lower = evaluated first. Default 500. |
| `match.url` | `{op, value}` | `op ∈ {substring, regex, exact}`. Required. |
| `match.method` | `{op:"in", values:string[]}` | Optional; default = any method. |
| `match.httpClientName` | `{op:"in", values:string[]}` | Optional; named-client filter (R7 fast-path benefit). |
| `match.headers` | `[{name, op, value?}]` | `op ∈ {equals, contains, regex, exists, missing}`. Optional. |
| `match.body` | `{op, value}?` | `op ∈ {jsonpath, regex}`. Optional. Costly; engine evaluates last. |
| `action.type` | string | `breakpoint \| block \| forge \| modify \| delay \| passthrough`. Required. |
| `action.breakpoint` | `{ phase: "request"\|"response"\|"both", timeoutMs?: int }` | when `type=breakpoint` |
| `action.block` | `{ statusCode?: int, body?: string, abortConnection?: bool }` | when `type=block` |
| `action.forge` | `{ statusCode, headers?, body? }` | when `type=forge` |
| `action.modify` | `{ request?: ModifySpec, response?: ModifySpec }` | when `type=modify`. ModifySpec = `{ setHeaders?, removeHeaders?, replaceBody?, rewriteUrl? }`. |
| `action.delay` | `{ requestMs?: int, responseMs?: int }` | when `type=delay`. Each 0–600 000. |
| `limits.maxFirings` | int? | Auto-disable after N fires. |
| `limits.ttlSeconds` | int? | Auto-delete after N seconds. |
| `limits.ratePerSecond` | int? | Soft cap; over-limit fires emit `mitm.rateLimitWarning` (E14) and pass through. |
| `ownership.scope` | string | `session` (default — F28 interactive) or `global` (admin-only; rejected unless `EDOG_MITM_GLOBAL=1`). |

> **Coexistence with F27 P5 fault store and F24:** ownership scopes are disjoint. The F28 store (C02) holds `scope:"session"` rules only. F27's `EdogHttpFaultStore` continues to own `scope:"scenario"`. F24, when shipped, owns `scope:"global"`. Match precedence: breakpoint (any scope) > scenario > session > global (R8, `p0-foundation.md:511`).

### 4.1 `MitmCreateRule`

Create a new rule owned by the calling connection's MITM session.

**Returns:** `MitmRuleResult`

```json
{
  "success": true,
  "rule": { /* full MitmRule with server-assigned ids + lifecycle */ },
  "validationErrors": []
}
```

**Validation errors** (returned as `{success:false, validationErrors:[...]}`):

| Field | Code | When |
|---|---|---|
| `id` | `duplicate` | Rule ID already exists in this session |
| `id` | `format` | Doesn't match `[a-z0-9-]{1,64}` |
| `match.url` | `invalidRegex` | Regex compilation failed |
| `match.url` | `missing` | URL matcher absent |
| `match.body` | `invalidJsonPath` | JSONPath parse failed |
| `action` | `unsupported` | Action type not in `supportedActions` capability |
| `action.forge.statusCode` | `outOfRange` | Not 100–599 |
| `action.delay.requestMs` | `outOfRange` | Not 0–600 000 |
| `rule` | `sessionLimit` | Per-session cap reached |
| `rule` | `mitmDisabled` | Capability gate closed |

**Side effects:**
- Atomic snapshot swap in C02 store (FrozenDictionary pattern, `EdogHttpFaultStore.cs:109–136`).
- Emits `mitm.ruleCreated` (E3) on the `mitm` topic.
- Appends audit entry (server-side log only; not on the wire).

**Sequence:**

```
UI                EdogPlaygroundHub      C02 Rule Engine    EdogTopicRouter
 |  MitmCreateRule(rule)|                      |                   |
 |---------------------->|                      |                   |
 |                       |  Validate + insert   |                   |
 |                       |--------------------->|                   |
 |                       |    rule + revision   |                   |
 |                       |<---------------------|                   |
 |                       |                      |  Publish("mitm",  |
 |                       |                      |    ruleCreated)   |
 |                       |--------------------- + ----------------> |
 |    MitmRuleResult     |                      |                   |
 |<----------------------|                      |                   |
 |                                              |                   |
 |  (other clients subscribed to mitm get E3)   |                   |
```

**Edge cases:**
- **Reconnect after create:** The connection that owned the rule is gone → server purges it on `OnDisconnectedAsync` (R6). Client MUST recreate after reconnect using cached state (frontend keeps a local mirror; reconciles via `MitmListRules`).
- **Concurrent create with same id:** Second call returns `duplicate` (no race — write path is `_writeLock`-serialized, `EdogHttpFaultStore.cs:109` pattern).
- **Body too large:** `match.body` regex/jsonpath against bodies >10 MB is silently skipped at evaluation time. The rule still installs.

**Interactions:**
- **C01 (Coordinator):** None — coordinator doesn't see rules until they fire.
- **C02 (Rule Engine):** Owns shape, validation, store. This RPC is a thin façade.
- **C04 (UI):** On success, optimistically adds to local rules list; reconciles on `mitm.ruleCreated` echo.

### 4.2 `MitmUpdateRule`

Replace an existing rule's definition. Preserves `lifecycle.fireCount` and `lifecycle.createdAt`. Cannot update a rule owned by a different session.

**Parameters / Returns:** identical to `MitmCreateRule`.

**Additional validation errors:**

| Field | Code |
|---|---|
| `id` | `notFound` |
| `id` | `notOwnedByCaller` |
| `lifecycle.state` | `invalidTransition` — e.g., attempting to update a `deleted` rule |

**Side effects:** `mitm.ruleUpdated` (E4).

**Edge cases:**
- **Update while a request is mid-evaluation against the old rule:** in-flight evaluation uses the snapshot it started with (R5). Next request sees the new rule.
- **Update enabled→false:** all currently-paused breakpoints created by this rule are auto-resumed with `decision:"forward"` and emit `breakpointCancelled` (E10) with `reason:"ruleDisabled"`.

### 4.3 `MitmDeleteRule`

Remove a rule. Idempotent — deleting a non-existent rule returns `success:true, message:"Already absent"`.

**Parameters:** `ruleId: string`.

**Returns:** `MitmOperationResult`

```json
{ "success": true, "message": "Rule 'block-onelake-503' deleted." }
```

**Error cases:**

| Condition | Behavior |
|---|---|
| Caller doesn't own the rule (different session) | `success:false, message:"Rule owned by another session"` |
| MITM disabled | `success:false, message:"MITM disabled"` |

**Side effects:**
- Removes from C02 active snapshot atomically.
- **Auto-resumes any paused intercepts created by this rule** with `decision:"forward"`; emits `breakpointCancelled` (E10) `reason:"ruleDeleted"` for each.
- Emits `mitm.ruleDeleted` (E5).

**Edge cases:**
- **Delete during paused breakpoint:** the in-flight request continues with the original (un-modified) `base.SendAsync` call. The user sees the row appear in the `http` table with `mitm.action="passthrough-tagged"` and a small "rule deleted while paused" note (UI concern, C04).

### 4.4 `MitmListRules`

Return all rules owned by the calling session (or all rules if `filter.includeOtherSessions=true` and caller is admin — admin-only flag, not in P1 scope).

**Parameters:** `filter?: MitmRuleFilter`

```json
{
  "states": ["enabled", "disabled"],
  "actionTypes": ["breakpoint", "forge"],
  "tags": ["onelake"],
  "includeOtherSessions": false
}
```

All filter fields optional. Empty arrays / nulls → no filter on that dimension.

**Returns:** `MitmRule[]` — array of full rule objects with lifecycle metadata. Sorted by `priority` ascending then `lifecycle.createdAt` ascending.

**Error cases:** none. Returns `[]` if nothing matches.

**Edge cases:**
- **Reconnect reconciliation (R10):** UI calls `MitmListRules()` on every `onreconnected`. Compare to local cache; for each rule in local cache not on server, prompt user (toast: "5 MITM rules cleared on reconnect — re-arm?") with one-click batch recreate.
- **Large result set:** capped at `limits.maxRulesPerSession` server-side, so no pagination needed in P1.

### 4.5 `MitmGetRule` (P1)

Fetch a single rule by ID. Used by the rule editor open-existing flow. Returns the full `MitmRule` object or `null` if not found.

---

## 5. The Breakpoint Pause/Resume Protocol

This is the heart of F28 — the one wire pattern that does not exist in F24 or F27.

### 5.0 Architecture in one diagram

```
   HTTP request enters EdogHttpPipelineHandler.SendAsync
                        |
                        v
   C02.TryMatch(request) → MitmRule (action=breakpoint)
                        |
                        v
   C01.AwaitDecisionAsync(interceptId, snapshot, connectionId, ct)
                        |  TaskCompletionSource<MitmBreakpointDecision>
                        |  registered in coordinator dictionary
                        v
                  (request thread parked)
                        |
   Coordinator emits Publish("mitm", { type: "breakpointHit", ... })
                        |
                        v
   Frontend stream delivers event → UI offers Forward/Drop/Modify/Forge
                        |
                        v
   User clicks; frontend invokes MitmResumeBreakpoint(decision)
                        |
                        v
   Hub looks up TCS by interceptId; SetResult(decision)
                        |
                        v
   AwaitDecisionAsync returns; handler proceeds per decision
                        |
                        v
   Publish("mitm", { type: "breakpointResumed", ... })
   Publish("http", { ...request/response..., mitm: {...} })
```

### 5.1 `breakpointHit` event (E7) — published BY the server

The single richest event in the protocol. Carries the **paused snapshot** the UI needs to render its decision panel.

```json
{
  "sequenceId": 88421,
  "timestamp": "2026-08-12T17:42:11.123Z",
  "topic": "mitm",
  "data": {
    "type": "breakpointHit",
    "interceptId": "int-01HF8M7G3X...",
    "sessionId": "mitm-7f3a2c1d",
    "ruleId": "pause-onelake-list",
    "ruleName": "Pause OneLake List",
    "phase": "request",
    "timeoutMs": 30000,
    "timeoutAt": "2026-08-12T17:42:41.123Z",
    "correlationId": "abc-123",
    "request": {
      "method": "GET",
      "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?sig=[redacted]",
      "headers": {
        "Authorization": "[redacted]",
        "x-ms-correlation-id": "abc-123",
        "User-Agent": "FabricLiveTable/1.0"
      },
      "body": null,
      "bodyBytes": 0,
      "httpClientName": "OneLakeRestClient"
    },
    "response": null,
    "secrets": {
      "revealAvailable": false,
      "revealToken": null
    }
  }
}
```

When `phase="response"`, the same envelope carries a populated `response` block AND the original `request` block (so the user can see both):

```json
"response": {
  "statusCode": 200,
  "headers": { "Content-Type": "application/json", "x-ms-request-id": "def-456" },
  "body": "{ \"value\": [ ... ] }",
  "bodyBytes": 8421,
  "durationMs": 142.37
}
```

When `phase="both"`, **two** `breakpointHit` events fire — one with `phase="request"`, then on resume-forward a second with `phase="response"` and the same `interceptId`.

**Secrets reveal (R2):** When `capabilities.flags.revealAuthHeader == true` AND the rule's `action.breakpoint.allowRevealAuth == true`, the event includes:

```json
"secrets": {
  "revealAvailable": true,
  "revealToken": "rvl-xxx"
}
```

The UI calls a separate RPC `MitmRevealSecret(revealToken)` (P2; not in v1 catalog) to fetch the un-redacted `Authorization` value. Default off.

### 5.2 `MitmResumeBreakpoint`

Send a decision for a paused intercept.

**Parameters:** `decision: MitmBreakpointDecision`

```json
{
  "interceptId": "int-01HF8M7G3X...",
  "verdict": "forward",
  "modifications": null,
  "forge": null,
  "block": null,
  "noteForAudit": "Looks correct; forwarding."
}
```

**Verdict-specific shapes:**

`verdict: "forward"` — proceed unmodified.
```json
{ "interceptId": "int-...", "verdict": "forward" }
```

`verdict: "modify"` — forward with edits. On request-phase, mutates the outbound request; on response-phase, mutates the response delivered to the caller.
```json
{
  "interceptId": "int-...",
  "verdict": "modify",
  "modifications": {
    "method": "POST",
    "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?$top=10",
    "headers": {
      "set": { "X-Custom": "edited" },
      "remove": ["x-ms-version"]
    },
    "body": "{\"edited\":true}"
  }
}
```

`verdict: "block"` — drop without calling base. Synthesize a response (request-phase only) or replace it (response-phase).
```json
{
  "interceptId": "int-...",
  "verdict": "block",
  "block": { "statusCode": 503, "body": "{\"forged\":true}", "headers": {"Content-Type":"application/json"} }
}
```

`verdict: "forge"` — alias for `block` with stronger UI semantics; same wire shape under `forge` instead of `block`.

`verdict: "drop"` — abort the request entirely. C# handler throws `TaskCanceledException` (matches the existing `timeout` fault behavior, `EdogHttpPipelineHandler.cs:74–103`). Caller sees a transport error.

**Returns:** `MitmOperationResult` (`{ success, message }`).

**Error cases:**

| Condition | Behavior |
|---|---|
| `interceptId` not found | `success:false, message:"Intercept not found (already resumed or expired)"` |
| Intercept owned by different connection | `success:false, message:"Intercept not owned by caller"` |
| Verdict requires shape that's missing (e.g., `modify` without `modifications`) | `success:false, validationErrors:[...]` |
| Body in modifications exceeds 10 MB | `success:false, validationErrors:[{field:"modifications.body",code:"tooLarge"}]` |

**Side effects:**
- Resolves the TCS in C01; the parked request thread proceeds.
- Emits `mitm.breakpointResumed` (E8).
- Eventually emits the normal `http` event with `data.mitm = { interceptId, ruleId, sessionId, action: "modify"|"forged"|"blocked"|"passthrough-tagged", modifications:[...] }`.

**Sequence (request-phase modify):**

```
Pipeline thread     Coordinator(C01)    Hub        Topic   UI
  |  evaluate rule       |               |          |       |
  |  -> breakpoint       |               |          |       |
  |  AwaitDecisionAsync  |               |          |       |
  |--------------------->|               |          |       |
  |                      |  registerTCS  |          |       |
  |                      |  Publish E7   |          |       |
  |                      |---------------+--------->|       |
  |   (parked)           |               |          |--E7-->|
  |                      |               |          |       | user edits body
  |                      |  MitmResumeBreakpoint    |       |
  |                      |<-----------------------|         |
  |                      | SetResult(decision)    |         |
  |  resumes; rebuild req|                        |         |
  |  base.SendAsync(req')|                        |         |
  |  Publish E8 + http   |                        |         |
  |----------------------+----------------------->+-E8/http>|
```

**Edge cases:**
- **Connection drops before resume (R6):** `OnDisconnectedAsync` walks the coordinator's per-connection intercept set; resolves each TCS with `verdict:"forward"`; emits `breakpointCancelled` (E10) `reason:"disconnect"`. Request proceeds untouched.
- **Timeout (R1):** Coordinator's per-intercept `CancellationTokenSource(timeoutMs)` fires; resolves TCS with `verdict:"forward"`; emits `breakpointTimedOut` (E9). Request proceeds untouched.
- **Double resume:** Second call returns `notFound` because TCS is removed on resolution. Idempotent failure.
- **Resume from a different connection than the one that hit the breakpoint:** Rejected (`notOwnedByCaller`). Prevents two UIs racing on the same intercept.
- **Phase=both, response-phase resume fails after request-phase forward:** the response is delivered to the caller untouched; emits `breakpointResumed` for response phase with `verdict:"forward (auto)"`.

**Interactions:**
- **C01 (Coordinator):** Owns the TCS dictionary, the timeout CTS, the connection-id index.
- **C02 (Rule Engine):** Updates `fireCount` on resume.
- **C04 (UI):** The Intercept tab editor builds the decision payload from form state.

### 5.3 Auxiliary breakpoint events

#### `mitm.breakpointResumed` (E8)
```json
{
  "type": "breakpointResumed",
  "interceptId": "int-...",
  "verdict": "modify",
  "appliedBy": "user",
  "modificationsSummary": [
    { "target": "request.body", "op": "replace", "summary": "rewrote $.query" }
  ],
  "durationMsPaused": 4123
}
```
`appliedBy ∈ {"user","timeout","disconnect","ruleDisabled","ruleDeleted","clearAll"}`.

#### `mitm.breakpointTimedOut` (E9)
```json
{
  "type": "breakpointTimedOut",
  "interceptId": "int-...",
  "ruleId": "pause-onelake-list",
  "timeoutMs": 30000
}
```

#### `mitm.breakpointCancelled` (E10)
```json
{
  "type": "breakpointCancelled",
  "interceptId": "int-...",
  "reason": "disconnect"
}
```
`reason ∈ {"disconnect","ruleDeleted","ruleDisabled","capacity","clearAll"}`.

---

## 6. Non-Breakpoint Rule Firing

### 6.1 `mitm.ruleMatched` (E6)

Emitted when a non-breakpoint rule fires (block / forge / modify / delay). One event per match, **before** the corresponding `http` topic event. UI uses this to:
1. Update the per-rule fire counter in the Rules pane (live).
2. Pre-mark the upcoming `http` row as "intercepted" before it arrives, eliminating flicker.

```json
{
  "type": "ruleMatched",
  "ruleId": "block-onelake-503",
  "ruleName": "Block OneLake reads with 503",
  "sessionId": "mitm-7f3a2c1d",
  "correlationId": "abc-123",
  "action": "forge",
  "phase": "request",
  "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?sig=[redacted]",
  "method": "GET",
  "synthesized": true,
  "modificationsSummary": [
    { "target": "response.statusCode", "op": "replace", "from": null, "to": 503 }
  ],
  "fireCount": 7,
  "ruleStateAfter": "enabled"
}
```

`ruleStateAfter` may be `"autoDisabled"` if `limits.maxFirings` was hit on this fire.

**Edge cases:**
- **High-frequency match:** at >100 fires/s the engine emits `mitm.rateLimitWarning` (E14) once per second and stops emitting per-fire `ruleMatched` events; the `http` events still publish with their `mitm` block intact. UI displays "Rule X: 142 fires/s — live ruleMatched events suppressed."

---

## 7. Replay

### 7.1 `MitmReplayRequest`

Replay a captured (or hand-crafted) request through the live pipeline. The request is dispatched via the same `HttpClient` and the same `EdogHttpPipelineHandler` instance so rules + observability apply (per `p0-foundation.md:160–163`).

**Parameters:** `request: MitmReplayInput`

```json
{
  "replayId": null,
  "sourceCorrelationId": "abc-123",
  "httpClientName": "OneLakeRestClient",
  "method": "GET",
  "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables",
  "headers": {
    "x-ms-correlation-id": "abc-123-replay",
    "x-ms-version": "2021-12-02"
  },
  "body": null,
  "options": {
    "bypassMitmRules": false,
    "timeoutMs": 60000,
    "confirmedNonIdempotent": false
  }
}
```

| Field | Notes |
|---|---|
| `replayId` | Client may supply; else server assigns `"rpl-" + ulid`. |
| `sourceCorrelationId` | Original request's correlationId for audit traceability. Optional. |
| `httpClientName` | Must match a registered named `HttpClient`; else `validationErrors:[{field:"httpClientName",code:"unknown"}]`. |
| `headers` | Caller-provided. Server adds standard internal headers; never includes the original `Authorization` unless `flags.revealAuthHeader` opt-in path was used. |
| `options.bypassMitmRules` | When `true`, the replay skips C02 rule evaluation (still publishes `http` event). Useful for "I want to see what the real service returns without my rules". |
| `options.confirmedNonIdempotent` | Required `true` for `POST/PUT/PATCH/DELETE` (R9). Otherwise server returns `validationErrors:[{field:"options.confirmedNonIdempotent",code:"requiredForNonIdempotent"}]`. |

**Returns:** `MitmReplayResult` (RPC returns immediately on acceptance; the full result arrives via `replayCompleted` event)

```json
{
  "success": true,
  "replayId": "rpl-01HF8...",
  "accepted": true,
  "message": "Replay queued."
}
```

The final outcome is delivered via:

#### `mitm.replayCompleted` (E11)
```json
{
  "type": "replayCompleted",
  "replayId": "rpl-01HF8...",
  "sourceCorrelationId": "abc-123",
  "newCorrelationId": "abc-123-replay",
  "statusCode": 200,
  "durationMs": 187.4,
  "matchedRuleIds": [],
  "httpEventSequenceId": 88555
}
```

#### `mitm.replayFailed` (E12)
```json
{
  "type": "replayFailed",
  "replayId": "rpl-01HF8...",
  "errorClass": "transport",
  "message": "DNS resolution failed: no such host"
}
```
`errorClass ∈ {"transport","timeout","validation","cancelled"}`.

**Sequence:**

```
UI                 Hub        ReplayService    Pipeline Handler   Topic
  |  MitmReplayRequest  |          |              |              |
  |-------------------->|          |              |              |
  |  result(accepted)   |          |              |              |
  |<--------------------|          |              |              |
  |                     |  enqueue |              |              |
  |                     |--------->|              |              |
  |                     |          |  HttpClient.SendAsync       |
  |                     |          |------------->|              |
  |                     |          |              |  Publish     |
  |                     |          |              |   http event |
  |                     |          |<-------------|              |
  |                     |          |  Publish replayCompleted    |
  |                     |          |---------------------------->|
  |   E11               |          |                             |
  |<----------------------------------------------------------- (E11)
```

**Edge cases:**
- **Replay during a paused breakpoint of the same rule:** the replayed request is itself a candidate for rule match. If a breakpoint rule matches, the replay also pauses (separate `interceptId`). UI shows them side-by-side. This is intentional — it lets you single-step interactively.
- **Replay storm:** rate-limited to 10/sec/connection. Exceeding → `success:false, validationErrors:[{code:"rateLimited"}]`.
- **Connection drops mid-replay:** the in-flight `HttpClient.SendAsync` is allowed to complete; the `replayCompleted` event still publishes to the topic (other subscribers see it), but no client receives it directly.

**Interactions:**
- **C01:** Acts as the replay dispatcher. Maintains the per-connection rate-limit token bucket.
- **C02:** Evaluated unless `bypassMitmRules:true`.
- **C04:** Replay editor is `RequestBuilder` (`api-playground.js:442`) embedded in the Intercept detail tab.

---

## 8. Kill Switch & Toggle

### 8.1 `MitmClearAll`

The nuclear option. Removes every rule, resumes every paused intercept with `forward`, cancels every in-flight replay belonging to the caller's session.

**Parameters:** none.

**Returns:** `MitmOperationResult`

```json
{
  "success": true,
  "message": "Cleared 6 rules, resumed 2 breakpoints, cancelled 1 replay."
}
```

**Error cases:** none. Like `ChaosKillSwitch`, this RPC ALWAYS succeeds; a thrown exception is a bug.

**Side effects:**
- C02 atomically clears the session-owned rule snapshot.
- C01 resolves every TCS owned by this session's connection with `verdict:"forward"`; emits `breakpointCancelled` (E10) `reason:"clearAll"` for each.
- Emits `mitm.cleared` (E13) — **broadcast to ALL clients on the hub** (not just the caller's session), matching `ChaosKillSwitch`'s safety semantics. Even other tabs/users see "MITM was cleared by session mitm-7f3a2c1d".
- Audit entry.

#### `mitm.cleared` (E13)
```json
{
  "type": "cleared",
  "clearedBy": "mitm-7f3a2c1d",
  "rulesRemoved": 6,
  "breakpointsResumed": 2,
  "replaysCancelled": 1,
  "timestamp": "2026-08-12T17:50:00Z"
}
```

**Redundancy (matching F24 §1.2 `ChaosKillSwitch`):**
1. Keyboard shortcut `Ctrl+Shift+K` in the frontend → invokes this method.
2. `edog.py` HTTP endpoint `POST http://localhost:5556/mitm/clear` → calls coordinator directly (out-of-process safety valve when SignalR is wedged).
3. File-based trigger: writing any content to `.edog-command/mitm-clear` → `edog.py` watcher fires it.

### 8.2 `MitmToggleInterception`

Global on/off **for the calling session**. Rules remain in the store; the engine evaluates them only when interception is on. Useful for "I want to stop intercepting for a moment, run something, then resume without re-arming all my rules."

**Parameters:** `enabled: bool`.

**Returns:** `MitmOperationResult`.

**Side effects:**
- C02 flips a session-scoped enable flag (volatile bool). Lock-free read in handler hot path (R7 fast-path benefit).
- Currently-paused breakpoints are NOT resumed when toggling OFF (the user can still resume them; new requests just stop being paused). When toggling OFF, no new rules will match.
- Emits `mitm.interceptionToggled` (E2).

#### `mitm.interceptionToggled` (E2)
```json
{ "type": "interceptionToggled", "sessionId": "mitm-7f3a2c1d", "enabled": false }
```

**Edge cases:**
- **Toggle off while a long modify is in progress:** the modify completes (verdict already sent); the next request is pass-through.
- **Toggle on/off rapid-fire:** debounced server-side at 100ms; only the final state is broadcast.

---

## 9. The Enhanced `http` Topic Event

Backward-compatible additive change. The current envelope (`p0-foundation.md:211–238`) gains an optional `data.mitm` block. Consumers MUST treat the block as optional; absence means no MITM activity on this request.

### 9.1 Shape

```json
{
  "sequenceId": 88556,
  "timestamp": "2026-08-12T17:42:11.567Z",
  "topic": "http",
  "data": {
    "method": "GET",
    "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?sig=[redacted]",
    "statusCode": 503,
    "durationMs": 12.4,
    "requestHeaders": { "Authorization": "[redacted]" },
    "responseHeaders": { "Content-Type": "application/json", "Retry-After": "30" },
    "requestBodyPreview": null,
    "responseBodyPreview": "{\"error\":{\"code\":\"ServiceUnavailable\",\"message\":\"Forged.\"}}",
    "requestSizeBytes": 0,
    "responseSizeBytes": 65,
    "httpClientName": "OneLakeRestClient",
    "correlationId": "abc-123",

    "mitm": {
      "sessionId": "mitm-7f3a2c1d",
      "interceptId": null,
      "ruleId": "block-onelake-503",
      "action": "forged",
      "breakpoint": null,
      "modifications": [
        { "target": "response.statusCode", "op": "replace", "from": null, "to": 503 },
        { "target": "response.body", "op": "replace", "summary": "synthesized" }
      ],
      "synthesized": true,
      "replayOf": null
    }
  }
}
```

### 9.2 `data.mitm` field reference

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | Owning MITM session. |
| `interceptId` | string\|null | Populated when this request flowed through a breakpoint. |
| `ruleId` | string\|null | Null for ad-hoc one-shot intercepts (e.g., interactive "block this row once"). |
| `action` | string | `forged \| modified \| blocked \| delayed \| replayed \| passthrough-tagged`. `passthrough-tagged` = a rule matched but its action was `passthrough` (observation-only). |
| `breakpoint` | string\|null | `"request"` / `"response"` / `"both"` / null. |
| `modifications` | object[] | Each: `{ target, op, from?, to?, summary? }`. `target` examples: `request.headers.X-Foo`, `request.body`, `request.url`, `response.statusCode`, `response.body`. |
| `synthesized` | bool | `true` when `base.SendAsync` was NOT called (block / forge). |
| `replayOf` | string\|null | When this event was the result of `MitmReplayRequest`, the original `correlationId`. UI uses this to draw a "↻ replayed from abc-123" badge. |

### 9.3 Coexistence with `data.chaos`

A single request may have **both** `data.chaos` and `data.mitm` blocks when (a) a QA scenario fault matched AND (b) a F28 interactive rule also matched. Precedence (R8) determines which one actually mutated the response. Both blocks describe what *they* did; UI renders both badges.

---

## 10. Cross-Cutting Edge-Case Catalog

Single table covering edges already mentioned plus a few more, indexed by component interaction.

| # | Scenario | Behavior | Owner |
|---|----------|----------|-------|
| EC1 | SignalR disconnect with 5 paused breakpoints | Coordinator resolves all 5 TCSs with `forward`; emits 5 × E10 (`reason:"disconnect"`); deletes all session-owned rules | C01 |
| EC2 | Reconnect after disconnect | New `connectionId`, new `sessionId`; client must re-create rules and re-subscribe to `mitm` topic; the auto-reconnect schedule in `signalr-manager.js:61` covers transport | C01 + C04 |
| EC3 | Two tabs from the same browser open EDOG | Two `connectionId`s, two `sessionId`s, independent rule sets. `mitm.cleared` (E13) broadcasts cross-session for safety | C01 |
| EC4 | Backend restart | All in-process state lost; on reconnect `MitmListRules` returns `[]`; UI prompts to re-arm from local cache | C04 |
| EC5 | Breakpoint hit while UI is on a different tab | Toast notification (Runtime View-level) shows "MITM breakpoint hit on /Tables — 28s remaining"; clicking takes user to HTTP tab → Intercept detail | C04 |
| EC6 | 16+ concurrent breakpoints | New matches auto-bypass with E10 `reason:"capacity"`; published `http` event has `mitm.action="passthrough-tagged"` | C01 |
| EC7 | Modify body that becomes >10 MB after edit | `MitmResumeBreakpoint` returns validation error; request remains paused; user can edit again | C01 |
| EC8 | Rule TTL expires during paused breakpoint | Breakpoint NOT auto-resumed (the pause already happened pre-expiry); rule is deleted; future matches stop | C02 |
| EC9 | `MitmClearAll` from session A clears only session A's rules | E13 broadcasts to all but only A's state changes. Other sessions' rules survive | C01 |
| EC10 | Concurrent `MitmResumeBreakpoint` and timeout race | First wins (TCS.TrySetResult); the loser sees `notFound`; only one E8/E9 fires | C01 |
| EC11 | Update rule that is currently in use evaluating a request | The in-flight request uses the pre-update snapshot (R5); next request uses new rule | C02 |
| EC12 | Replay with a captured `Authorization: [redacted]` | The replayed request has no auth header; will fail authentication. UI MUST warn user before send. P2 enhancement: revealable original auth via reveal token | C04 |
| EC13 | Hub throws on a non-MITM RPC, partial state from a `MitmCreateRule` | Create is atomic (snapshot swap); throw before swap = no state; throw after swap = rule installed but RPC returned error; client reconciles via `MitmListRules` | C02 |
| EC14 | `EDOG_MITM_INTERACTIVE` unset at connect time | All `Mitm*` methods return `{success:false, message:"MITM disabled"}` except `MitmGetCapabilities` | Hub |
| EC15 | Frontend stops streaming `mitm` topic but keeps `http` | `breakpointHit` not delivered; pause still happens server-side; timeout fires after 30s; request proceeds. Lesson: UI MUST own the `mitm` subscription as long as MITM is enabled | C04 |
| EC16 | Server emits E7 but client never invokes `MitmResumeBreakpoint` | Timeout fires; E9 published; request proceeds; the dangling Intercept tab in UI shows "timed out — request forwarded" | C01 |
| EC17 | Rule with `action.delay.requestMs=600000` paused for 10min, then disconnect | Disconnect triggers `Task.Delay` cancellation via the request's `CancellationToken`; the in-flight `HttpClient` call gets `TaskCanceledException`. This is acceptable per R1 — no infinite waits | C01 |

---

## 11. Component Interaction Matrix

A pivot table of which RPCs and events touch which components. Rows = wire elements, columns = components. ✓ = touches, ◐ = aware (reads metadata only), — = no involvement.

| Wire element | C01 Coordinator | C02 Rule Engine | C04 UI |
|---|:---:|:---:|:---:|
| `MitmGetCapabilities` | ✓ | ◐ | ✓ |
| `MitmCreateRule` | — | ✓ | ✓ |
| `MitmUpdateRule` | ◐ (resume on disable) | ✓ | ✓ |
| `MitmDeleteRule` | ◐ (resume on delete) | ✓ | ✓ |
| `MitmListRules` | — | ✓ | ✓ |
| `MitmGetRule` | — | ✓ | ✓ |
| `MitmResumeBreakpoint` | ✓ | ◐ (fireCount tick) | ✓ |
| `MitmReplayRequest` | ✓ (dispatch + rate limit) | ◐ (optional bypass) | ✓ |
| `MitmClearAll` | ✓ | ✓ | ✓ |
| `MitmToggleInterception` | — | ✓ | ✓ |
| E2 `interceptionToggled` | — | ✓ | ✓ |
| E3 `ruleCreated` | — | ✓ | ✓ |
| E4 `ruleUpdated` | — | ✓ | ✓ |
| E5 `ruleDeleted` | ◐ | ✓ | ✓ |
| E6 `ruleMatched` | — | ✓ | ✓ |
| E7 `breakpointHit` | ✓ | ◐ | ✓ |
| E8 `breakpointResumed` | ✓ | ◐ | ✓ |
| E9 `breakpointTimedOut` | ✓ | — | ✓ |
| E10 `breakpointCancelled` | ✓ | — | ✓ |
| E11 `replayCompleted` | ✓ | — | ✓ |
| E12 `replayFailed` | ✓ | — | ✓ |
| E13 `cleared` | ✓ | ✓ | ✓ |
| E14 `rateLimitWarning` | — | ✓ | ✓ |
| `http.data.mitm` block | ◐ | ✓ | ✓ |

---

## 12. Priority Roadmap

| Tier | Wire elements | Rationale |
|------|---------------|-----------|
| **P0 — v1 must-ship** | 1, 2, 3, 4, 5, 7, 8, 9, 10 + E2, E3, E4, E5, E6, E7, E8, E9, E11, E13 + `http.mitm` block | Complete loop: capabilities → CRUD → breakpoint pause/resume/timeout → replay → kill switch |
| **P1 — v1.1** | 6 (`MitmGetRule`), E1 (capability change), E10 (cancellation reason richness), E12 (replay failure surface) | UX polish — single-rule fetch, mid-session capability flip, richer telemetry |
| **P2 — backlog** | `MitmRevealSecret` (auth header reveal flow), E14 (`rateLimitWarning`), admin-only `MitmListRules({includeOtherSessions:true})` | Power-user / multi-user concerns. Defer until v1 ships and we know whether anyone asks. |

---

## 13. Naming & Versioning

### 13.1 Hub-method naming

All F28 hub methods are prefixed `Mitm`. The existing `EdogPlaygroundHub` has no `Mitm*` methods today (`p0-foundation.md:115`); this is the first allocation of the namespace. **`Chaos*`** is reserved for F24's eventual implementation; **`Qa*`** is taken (`EdogPlaygroundHub.cs:493`+).

### 13.2 Topic namespacing

The new topic `mitm` is registered in `EdogTopicRouter.Initialize` (size 1000, matching the F24 spec's `chaos` topic budget). Event `type` values inside payloads are `mitm.*` strings to keep them grep-able across logs. (Frontend dispatches on `event.data.type`.)

### 13.3 Wire-protocol version

`MitmCapabilityReport.serverVersion = "f28-p1-2026.08"`. Bump format: `f28-p<N>-<YYYY.MM>`. Frontend warns when major mismatch (different `pN`) is detected. Minor mismatch (different `<YYYY.MM>`) is silent — additive change is assumed safe.

### 13.4 Backward compatibility contract

For the lifetime of the `mitm` topic:
- **Additive only.** New fields may appear in any event payload without bumping `serverVersion`'s `p` digit.
- **Never reuse a field name with a new meaning.** If semantics change, introduce a new field and deprecate the old.
- **`http.data.mitm` block is optional forever.** Consumers MUST default to "no MITM activity" when absent.

---

## 14. Open Questions (Resolved at C01/C02/C04 time)

These are deliberately deferred to the corresponding component specs:

| # | Question | Resolves in |
|---|----------|-------------|
| OQ1 | Exact storage of `MitmRule` (extend `EdogHttpFaultStore` vs. parallel `MitmRuleStore`) — see `p0-foundation.md:446` option (a)/(b) | **C02** |
| OQ2 | Coordinator's pause-snapshot allocation budget — keep N most-recent paused snapshots in-memory; older ones spill where? | **C01** |
| OQ3 | The body-editor UX above 4 KB — tree view, raw text, two-pane diff? | **C04** |
| OQ4 | Whether `phase:"both"` is delivered as one event with two phases or two sequential events (this spec mandates two; revisit if C04 finds it confusing) | C04 review |
| OQ5 | The `MitmRevealSecret` flow (P2) — wire shape and the consent-confirmation modal | **C04** + security review |
| OQ6 | Per-rule audit history (`lifecycle.auditLog`) exposed via a `MitmGetAuditLog` RPC, or only server-side? | **C02** |

---

## 15. Examples — End-to-End

### 15.1 "Block the next OneLake list call, see what FLT does"

```
1. UI: invoke('MitmGetCapabilities') → enabled:true
2. UI: invoke('MitmCreateRule', {
       id: "blk-1",
       name: "Block next list",
       match: { url:{op:"substring",value:"/Tables"}, method:{op:"in",values:["GET"]} },
       action: { type:"block", block:{ statusCode:503, body:"{}" } },
       limits: { maxFirings: 1 }
   })
   → success, rule installed
   → topic emits E3 ruleCreated
3. (FLT issues GET /Tables)
   → topic emits E6 ruleMatched (action="forged", fireCount=1, ruleStateAfter="autoDisabled")
   → topic emits http event with data.mitm.action="forged", synthesized:true
4. UI shows 503 row with red badge
5. UI: invoke('MitmDeleteRule','blk-1') → cleanup
   → topic emits E5 ruleDeleted
```

### 15.2 "Pause every Spark status call so I can inspect"

```
1. UI: invoke('MitmCreateRule', {
       name: "Pause spark status",
       match: { url:{op:"regex",value:"sparkjobs/.*/status"} },
       action: { type:"breakpoint", breakpoint:{ phase:"request", timeoutMs: 30000 } },
       limits: { maxFirings: 100 }
   })
2. (FLT calls sparkjobs/abc/status)
   → topic emits E7 breakpointHit (interceptId="int-1", phase="request", timeoutAt=...)
3. UI shows Intercept detail panel with Forward/Modify/Drop/Forge buttons
4. User clicks "Forward"
   UI: invoke('MitmResumeBreakpoint', { interceptId:"int-1", verdict:"forward" })
   → success
   → topic emits E8 breakpointResumed (appliedBy="user", durationMsPaused=4123)
   → topic emits http event with data.mitm.interceptId="int-1", action="passthrough-tagged"
```

### 15.3 "Replay this failed request"

```
1. UI: user right-clicks an http row that failed with 503
2. UI: invoke('MitmReplayRequest', {
       sourceCorrelationId:"abc-123",
       httpClientName:"OneLakeRestClient", method:"GET",
       url:"https://onelake.dfs.fabric.microsoft.com/.../Tables",
       headers:{ "x-ms-correlation-id": "abc-123-replay" },
       options:{ bypassMitmRules: true, timeoutMs: 60000, confirmedNonIdempotent: false }
   })
   → { success:true, replayId:"rpl-9", accepted:true }
3. (real HttpClient call happens)
   → topic emits http event with data.mitm.action="replayed", replayOf:"abc-123"
   → topic emits E11 replayCompleted (statusCode:200, durationMs:187)
4. UI shows a new row tagged "↻ replayed from abc-123" linked to the original
```

### 15.4 "Panic — kill everything"

```
1. User presses Ctrl+Shift+K (or clicks Kill Switch button)
2. UI: invoke('MitmClearAll') → success, "Cleared 6 rules, resumed 2 breakpoints, cancelled 1 replay."
3. Topic emits E13 cleared, broadcast to ALL clients
4. UI clears Rules pane and any open Intercept detail
5. (any other browser tab sees the same E13 and updates its UI too)
```

---

## 16. Summary

The protocol surface is 10 RPC methods, 14 topic event types, and one additive block on the existing `http` topic. Every shape derives from established patterns:

- **RPC envelope** = `Qa*` family (`EdogPlaygroundHub.cs:493`+).
- **Topic streaming** = `SubscribeToTopic` (`EdogPlaygroundHub.cs:419`).
- **Rule shape** = adapted from F24's `ChaosRuleInput` (`F24-chaos-engineering/signalr-protocol.md:42`+) per `p0-foundation.md:198`.
- **Kill-switch broadcast** = F24's `ChaosKillSwitch` safety semantics (`F24/signalr-protocol.md:346`).
- **Auto-cleanup on disconnect** = SignalR `OnDisconnectedAsync` + `Context.ConnectionId` ownership index.

The only novel construct is the **breakpoint pause/resume RPC pair** — a normal `invoke()` for `MitmResumeBreakpoint` is coupled with a `TaskCompletionSource` parked inside the pipeline handler. No new SignalR primitive, no new transport, no polling. This is the minimum viable wire surface that delivers interactive MITM while staying additive to every existing contract.

Ready for C01 (Coordinator) and C02 (Rule Engine) specs to bind their internal state shapes to this protocol.
