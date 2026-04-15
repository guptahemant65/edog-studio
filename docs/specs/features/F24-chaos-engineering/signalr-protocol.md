# Chaos Engineering Panel — SignalR Protocol Specification (P2.5)

> **Status:** SPEC — READY FOR REVIEW
> **Author:** Vex (Backend Engineer)
> **Date:** 2026-07-28
> **Authority:** `SIGNALR_PROTOCOL.md` (Runtime View patterns), ADR-006
> **Depends On:** `engine-design.md` (P0.3 rule model), `C05-observability.md` (recording model)
> **Applies To:** `EdogPlaygroundHub.cs`, `SignalRManager.js`, `ChaosRuleEngine`

---

## Overview

The Chaos Engineering Panel communicates with the `ChaosRuleEngine` via the **same** `/hub/playground` SignalR hub used by the Runtime View. All chaos methods are added to `EdogPlaygroundHub`. The protocol follows the same patterns established in `SIGNALR_PROTOCOL.md`:

- **JSON** over SignalR (same wire format)
- **`ChannelReader<T>` streaming** for live traffic events (snapshot + live, same as Runtime View topics)
- **`invoke()` RPC** for rule CRUD and control operations (request → response)
- **`connection.on()` push events** for rule state changes and system alerts (fire-and-forget broadcast)
- **Localhost-only CORS** (same security model as existing hub)
- **`TopicEvent` envelope** for streaming data (same `sequenceId` / `timestamp` / `topic` / `data` shape)

New topic: `chaos` — published to by `ChaosRuleEngine` for rule firings, state changes, and audit entries.

---

## Hub Method Naming Convention

All chaos methods are prefixed with `Chaos` to avoid collision with existing hub methods:

```
Existing:     Subscribe, Unsubscribe, SubscribeToTopic
Chaos:        ChaosCreateRule, ChaosEnableRule, ChaosSubscribeTraffic, ...
```

---

## 1. Hub Methods (Client → Server)

### 1.1 Rule CRUD

#### `ChaosCreateRule`

Creates a new chaos rule. The rule starts in `draft` state (not evaluated).

```
Name:        ChaosCreateRule
Parameters:  rule: ChaosRuleInput
Return:      ChaosRuleResult
Description: Create a new rule in DRAFT state. Validates predicate and action schema.
             The engine assigns `lifecycle.createdAt` and initializes `fireCount: 0`.
             Returns the full rule including server-assigned fields.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `rule` | `ChaosRuleInput` | Yes | Full rule object (see [ChaosRuleInput shape](#chaosruleinput)) |

**Return:** `ChaosRuleResult`

```json
{
  "success": true,
  "rule": { /* full ChaosRule with lifecycle fields populated */ },
  "validationErrors": []
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Invalid predicate (bad regex, unknown field) | `success: false`, `validationErrors` populated |
| Invalid action (missing required config) | `success: false`, `validationErrors` populated |
| Duplicate `id` | `success: false`, `validationErrors: [{ "field": "id", "message": "Rule ID already exists" }]` |
| Empty `id` or `name` | `success: false`, `validationErrors` populated |

**Side Effects:**
- Broadcasts `RuleCreated` event to all connected clients
- Appends audit entry: `{ "event": "created", "detail": "Rule created via SignalR" }`

---

#### `ChaosUpdateRule`

Updates an existing rule. Cannot update a rule that is currently `active` — pause it first.

```
Name:        ChaosUpdateRule
Parameters:  rule: ChaosRuleInput
Return:      ChaosRuleResult
Description: Replace rule definition. Only allowed in draft/paused/expired states.
             Lifecycle metadata (fireCount, createdAt) is preserved.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `rule` | `ChaosRuleInput` | Yes | Updated rule. `id` must match existing rule. |

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Rule not found | `success: false`, `validationErrors: [{ "field": "id", "message": "Rule not found" }]` |
| Rule is `active` | `success: false`, `validationErrors: [{ "field": "lifecycle.state", "message": "Cannot update active rule. Pause first." }]` |
| Rule is `deleted` | `success: false`, `validationErrors: [{ "field": "lifecycle.state", "message": "Cannot update deleted rule." }]` |
| Validation failures | Same as `ChaosCreateRule` |

**Side Effects:**
- Broadcasts `RuleUpdated` event to all connected clients
- Appends audit entry: `{ "event": "updated", "detail": "Rule updated via SignalR" }`

---

#### `ChaosDeleteRule`

Soft-deletes a rule. The rule remains in audit history for 24 hours (undelete window).

```
Name:        ChaosDeleteRule
Parameters:  ruleId: string
Return:      ChaosOperationResult
Description: Soft-delete a rule. If the rule is active, it is disabled first.
             Recoverable via ChaosUndeleteRule within 24 hours.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ruleId` | `string` | Yes | Rule ID to delete |

**Return:** `ChaosOperationResult`

```json
{
  "success": true,
  "message": "Rule 'delay-onelake-writes-3s' deleted."
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Rule not found | `success: false`, `message: "Rule not found"` |
| Rule already deleted | `success: false`, `message: "Rule already deleted"` |

**Side Effects:**
- If rule was `active`, transitions through `paused` → `deleted` (engine stops evaluating immediately)
- Broadcasts `RuleDeleted` event
- Appends audit entry: `{ "event": "deleted" }`

---

#### `ChaosGetAllRules`

Returns all rules (including deleted within 24h window, for undelete UI).

```
Name:        ChaosGetAllRules
Parameters:  filter?: ChaosRuleFilter
Return:      ChaosRule[]
Description: Retrieve all rules. Optional filter by state, category, or tags.
             Returns rules sorted by priority (ascending), then createdAt.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filter` | `ChaosRuleFilter` | No | Optional filter. `null` returns all non-deleted rules. |

**Filter shape:**

```json
{
  "states": ["active", "paused"],
  "categories": ["traffic-control"],
  "tags": ["onelake"],
  "includeDeleted": false
}
```

All filter fields are optional. Empty arrays and `null` mean "no filter on this dimension."

**Return:** `ChaosRule[]` — array of full rule objects.

**Error Cases:** None. Returns empty array if no rules match.

---

#### `ChaosGetRule`

Returns a single rule by ID.

```
Name:        ChaosGetRule
Parameters:  ruleId: string
Return:      ChaosRule | null
Description: Retrieve a single rule by ID. Returns null if not found.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ruleId` | `string` | Yes | Rule ID |

**Return:** Full `ChaosRule` object or `null`.

**Error Cases:** Returns `null` if rule not found (not an error — frontend handles gracefully).

---

### 1.2 Rule Control

#### `ChaosEnableRule`

Transitions a rule from `draft` or `paused` to `active`. The engine starts evaluating it against traffic.

```
Name:        ChaosEnableRule
Parameters:  ruleId: string
Return:      ChaosOperationResult
Description: Activate a rule. Validates that at least one limit is set
             (maxFirings > 0, ttlSeconds > 0, or expiresAt is set).
             Resets TTL timer on re-enable from paused.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ruleId` | `string` | Yes | Rule ID to enable |

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Rule not found | `success: false`, `message: "Rule not found"` |
| Rule already active | `success: false`, `message: "Rule is already active"` |
| Rule is `deleted` or `expired` | `success: false`, `message: "Cannot enable rule in '{state}' state"` |
| No limits set | `success: false`, `message: "Cannot activate rule without at least one limit (maxFirings, ttlSeconds, or expiresAt)"` |
| Invalid predicate (regex compilation failure) | `success: false`, `message: "Predicate compilation failed: {details}"` |

**Side Effects:**
- Atomically swaps the rule into the active snapshot (lock-free)
- If rule has `ttlSeconds`, starts the TTL countdown from NOW
- Broadcasts `RuleUpdated` event with new state
- Appends audit entry: `{ "event": "enabled", "detail": "limits: maxFirings=50, ttlSeconds=300" }`
- If this is a destructive action at `probability: 1.0`, also broadcasts a safety warning via `AuditEntry` event

---

#### `ChaosDisableRule`

Transitions a rule from `active` to `paused`.

```
Name:        ChaosDisableRule
Parameters:  ruleId: string
Return:      ChaosOperationResult
Description: Pause an active rule. Stops evaluation immediately.
             Preserves fireCount and audit history. TTL timer pauses.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ruleId` | `string` | Yes | Rule ID to disable |

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Rule not found | `success: false` |
| Rule not active | `success: false`, `message: "Rule is not active (current state: '{state}')"` |

**Side Effects:**
- Atomically removes rule from active snapshot
- Broadcasts `RuleUpdated` event
- Appends audit entry: `{ "event": "paused", "detail": "User paused" }`

---

#### `ChaosEnableAll`

Enables all rules in `draft` or `paused` state that have valid limits set.

```
Name:        ChaosEnableAll
Parameters:  (none)
Return:      ChaosOperationResult
Description: Batch-enable all draft/paused rules. Skips rules without limits.
             Returns count of enabled and skipped rules.
```

**Return:**

```json
{
  "success": true,
  "message": "Enabled 4 rules. Skipped 2 (no limits set)."
}
```

**Side Effects:**
- Broadcasts `RuleUpdated` for each enabled rule
- Single atomic snapshot swap (not one per rule — all-or-nothing)

---

#### `ChaosDisableAll`

Disables all active rules. Transitions each to `paused`.

```
Name:        ChaosDisableAll
Parameters:  (none)
Return:      ChaosOperationResult
Description: Pause all active rules. Non-destructive — rules can be re-enabled.
```

**Return:**

```json
{
  "success": true,
  "message": "Disabled 6 active rules."
}
```

**Side Effects:**
- Atomic snapshot swap to empty active set
- Broadcasts `RuleUpdated` for each disabled rule
- Appends audit entry to each rule: `{ "event": "paused", "detail": "Batch disable" }`

---

#### `ChaosKillSwitch`

Emergency disable — clears ALL active rules and prevents re-activation until explicitly reset. This is the nuclear option.

```
Name:        ChaosKillSwitch
Parameters:  (none)
Return:      ChaosOperationResult
Description: EMERGENCY. Disables all rules. Sets each active rule to 'disabled-by-safety'.
             Sets engine-level lockout flag. Rules cannot be re-enabled until
             ChaosResetKillSwitch is called. Designed to be callable even under
             high load or error conditions.
```

**Return:**

```json
{
  "success": true,
  "message": "Kill switch activated. 6 rules disabled. Engine locked."
}
```

**Error Cases:** None. Kill switch ALWAYS succeeds. If it throws, there's a bug in the engine.

**Side Effects:**
- Atomically clears the active snapshot
- Sets `ChaosRuleEngine.KillSwitchActive = true` (volatile flag)
- Transitions all `active` rules to `disabled-by-safety` with `disableReason: "Kill switch activated"`
- Broadcasts `KillSwitchActivated` event to ALL connected clients (not just chaos subscribers)
- Appends audit entry to every rule: `{ "event": "disabled-by-safety", "detail": "Kill switch" }`

**Redundancy:** Kill switch also works via:
1. Keyboard shortcut: `Ctrl+Shift+K` in frontend → calls this method
2. `edog.py` HTTP endpoint: `POST http://localhost:5556/chaos/killswitch` → calls engine directly
3. File-based trigger: write any content to `.edog-command/chaos-kill` → `edog.py` monitors and fires

---

#### `ChaosResetKillSwitch`

Unlocks the engine after a kill switch activation. Does NOT re-enable any rules.

```
Name:        ChaosResetKillSwitch
Parameters:  (none)
Return:      ChaosOperationResult
Description: Clear the kill switch lockout. Rules remain in 'disabled-by-safety' state.
             User must explicitly re-enable individual rules after investigation.
```

---

### 1.3 Recording

#### `ChaosStartRecording`

Starts capturing HTTP traffic to a named recording session.

```
Name:        ChaosStartRecording
Parameters:  config: RecordingConfig
Return:      RecordingResult
Description: Start a new recording session. If a recording is already active,
             stops it first (auto-named with '-auto' suffix). Only ONE recording
             can be active at a time.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `config` | `RecordingConfig` | Yes | Recording configuration |

**`RecordingConfig` shape:**

```json
{
  "name": "onelake-baseline-2026-07-28",
  "filter": {
    "httpClientName": "OneLakeRestClient",
    "urlPattern": null,
    "methods": ["GET", "PUT"],
    "statusCodeRange": { "min": 200, "max": 599 }
  },
  "maxEntries": 50000,
  "maxSizeMB": 100,
  "includeRequestBody": true,
  "includeResponseBody": true,
  "bodyPreviewMaxBytes": 4096
}
```

All filter fields are optional. `null` or omitted = no filter on that dimension.

**Return:** `RecordingResult`

```json
{
  "success": true,
  "sessionId": "rec-2026-07-28-onelake-baseline",
  "message": "Recording started.",
  "stoppedPreviousSession": null
}
```

If a previous session was auto-stopped:

```json
{
  "success": true,
  "sessionId": "rec-2026-07-28-new-session",
  "message": "Recording started. Previous session 'my-old-session' auto-stopped.",
  "stoppedPreviousSession": "rec-2026-07-28-my-old-session"
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Empty name | `success: false`, `message: "Recording name is required"` |
| Invalid filter regex | `success: false`, `message: "Invalid URL filter pattern: {details}"` |
| Disk write failure | `success: false`, `message: "Cannot create recording file: {details}"` |

**Side Effects:**
- Creates `.edog/recordings/{sessionId}.jsonl` and `.edog/recordings/{sessionId}.meta.json`
- Broadcasts `RecordingStarted` event
- `RecordingManager.IsActive` becomes `true`

---

#### `ChaosStopRecording`

Stops the active recording session.

```
Name:        ChaosStopRecording
Parameters:  (none)
Return:      RecordingResult
Description: Stop the active recording. Flushes pending writes to JSONL.
             Returns the final session metadata.
```

**Return:**

```json
{
  "success": true,
  "sessionId": "rec-2026-07-28-onelake-baseline",
  "message": "Recording stopped. 847 entries captured.",
  "session": {
    "id": "rec-2026-07-28-onelake-baseline",
    "name": "onelake-baseline-2026-07-28",
    "status": "completed",
    "entryCount": 847,
    "totalRequestBytes": 12400,
    "totalResponseBytes": 3847200,
    "startedAt": "2026-07-28T10:30:00Z",
    "stoppedAt": "2026-07-28T10:35:12Z",
    "durationSeconds": 312
  }
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| No active recording | `success: false`, `message: "No active recording"` |

**Side Effects:**
- Flushes `RecordingManager` write channel
- Closes JSONL file handle
- Finalizes `.meta.json` with `stoppedAt`, `entryCount`, `status: "completed"`
- Broadcasts `RecordingStopped` event

---

#### `ChaosGetRecordings`

Lists all recording sessions (completed, truncated, interrupted).

```
Name:        ChaosGetRecordings
Parameters:  (none)
Return:      RecordingSession[]
Description: List all recording sessions. Returns metadata only (not entries).
             Sorted by startedAt descending (newest first).
```

**Return:** Array of `RecordingSession` metadata objects (same shape as `session` in `ChaosStopRecording` return).

---

#### `ChaosExportRecording`

Exports a recording as HAR 1.2 JSON. Returns the HAR document as a string (frontend triggers download).

```
Name:        ChaosExportRecording
Parameters:  sessionId: string, format: string
Return:      ExportResult
Description: Export a completed recording. Reads JSONL, converts to HAR 1.2.
             For large recordings (>10K entries), this may take 1-2 seconds.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | `string` | Yes | Recording session ID |
| `format` | `string` | No | Export format. Default: `"har"`. Future: `"jsonl"` (raw). |

**Return:** `ExportResult`

```json
{
  "success": true,
  "format": "har",
  "filename": "onelake-baseline-2026-07-28.har",
  "content": "{ \"log\": { \"version\": \"1.2\", ... } }"
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Session not found | `success: false`, `message: "Recording not found"` |
| Session still recording | `success: false`, `message: "Cannot export active recording. Stop it first."` |
| JSONL file corrupted | `success: false`, `message: "Recording file is corrupted. {N} of {total} entries readable."` |

---

### 1.4 Traffic Streaming

#### `ChaosSubscribeTraffic`

Starts streaming live HTTP traffic events via `ChannelReader<T>`. Follows the **exact same** pattern as `SubscribeToTopic` in the existing protocol.

```
Name:        ChaosSubscribeTraffic
Parameters:  filter?: TrafficFilter, CancellationToken
Return:      ChannelReader<TopicEvent>  (streaming)
Description: Server-to-client stream of HTTP traffic events. Yields snapshot
             (buffered history from http topic) then live events.
             Filter narrows the stream to matching traffic only.
             Cancel the stream to stop (same as unsubscribing a Runtime View topic).
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filter` | `TrafficFilter` | No | Optional filter. `null` = all traffic. |
| `cancellationToken` | `CancellationToken` | Yes (injected by SignalR) | Stream cancellation |

**`TrafficFilter` shape:**

```json
{
  "httpClientNames": ["OneLakeRestClient", "DatalakeDirectoryClient"],
  "methods": ["PUT", "POST"],
  "urlPattern": "onelake\\.dfs\\.fabric",
  "statusCodeRange": { "min": 400, "max": 599 },
  "onlyMatchedByChaos": true
}
```

All fields optional. `null` = no filter on that dimension. `onlyMatchedByChaos: true` shows only traffic that matched at least one chaos rule.

**Return:** `ChannelReader<TopicEvent>` — streaming. Each event wraps a `ChaosTrafficEvent` (see [§3.1](#31-chaostrafficevent)).

**C# Implementation:**

```csharp
/// <summary>
/// Stream HTTP traffic to the Chaos Panel. Same ChannelReader pattern as SubscribeToTopic.
/// Yields snapshot from the http topic buffer, then live events, optionally filtered.
/// </summary>
public ChannelReader<TopicEvent> ChaosSubscribeTraffic(
    TrafficFilter filter,
    CancellationToken cancellationToken)
{
    var httpBuffer = EdogTopicRouter.GetBuffer("http");
    var chaosBuffer = EdogTopicRouter.GetBuffer("chaos");

    var channel = Channel.CreateBounded<TopicEvent>(
        new BoundedChannelOptions(2000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

    _ = Task.Run(async () =>
    {
        try
        {
            // Phase 1: Snapshot from http topic buffer
            foreach (var item in httpBuffer.GetSnapshot())
            {
                if (TrafficFilterEngine.Matches(filter, item))
                    await channel.Writer.WriteAsync(
                        EnrichWithChaosData(item), cancellationToken);
            }

            // Phase 2: Live events (merged from http + chaos topics)
            await foreach (var item in httpBuffer.ReadLiveAsync(cancellationToken))
            {
                if (TrafficFilterEngine.Matches(filter, item))
                    await channel.Writer.WriteAsync(
                        EnrichWithChaosData(item), cancellationToken);
            }
        }
        catch (OperationCanceledException) { /* Client unsubscribed — clean */ }
        finally
        {
            channel.Writer.Complete();
        }
    }, cancellationToken);

    return channel.Reader;
}
```

**Cancellation:** Client calls `stream.dispose()` in JS → `CancellationToken` fires on server → stream ends. Same behavior as `SubscribeToTopic`.

---

#### `ChaosUnsubscribeTraffic`

Not a hub method — cancellation is handled by disposing the `ChannelReader` stream on the JS client:

```javascript
// JS client
this._trafficStream.dispose();  // triggers CancellationToken on server
```

This follows the same pattern as `unsubscribeTopic()` in the existing `SignalRManager`.

---

### 1.5 Presets

#### `ChaosListPresets`

Returns all available preset scenarios (built-in + user-created).

```
Name:        ChaosListPresets
Parameters:  (none)
Return:      ChaosPresetSummary[]
Description: List all preset scenarios. Returns summary metadata (not full rule definitions).
```

**Return:**

```json
[
  {
    "id": "preset-onelake-outage",
    "name": "Simulate OneLake Outage",
    "description": "Full OneLake service outage affecting file ops, catalog, and directory listing.",
    "category": "infrastructure",
    "icon": "◆",
    "severity": "high",
    "estimatedDuration": "5m",
    "tags": ["onelake", "outage", "p0"],
    "ruleCount": 4,
    "isBuiltIn": true
  }
]
```

---

#### `ChaosLoadPreset`

Loads a preset — creates all rules from the preset in `draft` state.

```
Name:        ChaosLoadPreset
Parameters:  presetId: string, activate: bool
Return:      ChaosPresetLoadResult
Description: Create all rules defined in the preset. If activate=true, also
             enables all rules (subject to limit validation).
             If rules with matching IDs already exist, they are replaced.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `presetId` | `string` | Yes | Preset ID |
| `activate` | `bool` | No | Auto-enable rules after creation. Default: `false`. |

**Return:** `ChaosPresetLoadResult`

```json
{
  "success": true,
  "presetId": "preset-onelake-outage",
  "rulesCreated": 4,
  "rulesActivated": 4,
  "ruleIds": [
    "preset-onelake-outage--blackhole-writes",
    "preset-onelake-outage--slow-reads",
    "preset-onelake-outage--listing-fail",
    "preset-onelake-outage--token-expire"
  ],
  "message": "Loaded 'Simulate OneLake Outage' — 4 rules created and activated."
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Preset not found | `success: false`, `message: "Preset not found"` |
| Kill switch active | `success: false`, `message: "Cannot load preset — kill switch is active"` |
| Validation failure on a rule | `success: true` (partial), rules that pass validation are created, failures listed in `validationErrors` |

**Side Effects:**
- Broadcasts `RuleCreated` for each rule
- If `activate: true`, broadcasts `RuleUpdated` (state→active) for each enabled rule

---

## 2. Server → Client Events

Events pushed from the server to all connected clients. Clients register handlers via `connection.on('EventName', callback)`.

### Event Delivery Model

| Event Type | Delivery | Audience |
|------------|----------|----------|
| Rule events (`RuleCreated`, etc.) | Broadcast to `chaos` group | Clients subscribed to chaos topic |
| Traffic events (`ChaosTrafficEvent`) | Streamed via `ChannelReader` | Only the client that called `ChaosSubscribeTraffic` |
| Rule firing events (`RuleFired`) | Broadcast to `chaos` group | Clients subscribed to chaos topic |
| System events (`KillSwitchActivated`) | Broadcast to **ALL** clients | Every connected client (safety-critical) |
| Recording events | Broadcast to `chaos` group | Clients subscribed to chaos topic |
| Audit entries | Broadcast to `chaos` group | Clients subscribed to chaos topic |

**Subscribing to chaos events:** Client calls `connection.invoke('Subscribe', 'chaos')` — same group mechanism as existing topics. The Chaos Panel JS module calls this on activation.

---

### 2.1 Traffic Events

#### `ChaosTrafficEvent`

Delivered via `ChannelReader<TopicEvent>` stream (not broadcast). Each event is wrapped in the standard `TopicEvent` envelope.

**When it fires:** On every HTTP request/response intercepted by `EdogHttpPipelineHandler.SendAsync()`.

**Frequency:** 1 event per HTTP round-trip. During active FLT operations (e.g., DAG execution), expect 10–100 events/sec. During idle, 0–2 events/sec.

**Envelope:**

```json
{
  "sequenceId": 12345,
  "timestamp": "2026-07-28T10:30:01.234Z",
  "topic": "chaos-traffic",
  "data": {
    "method": "PUT",
    "url": "https://onelake.dfs.fabric.microsoft.com/ws-guid/lh-guid/Tables/mytable/part-0001.parquet",
    "statusCode": 503,
    "durationMs": 3045.2,
    "direction": "outbound",
    "httpClientName": "DatalakeDirectoryClient",
    "requestHeaders": {
      "Content-Type": "application/octet-stream",
      "Authorization": "[redacted]",
      "x-ms-client-request-id": "req-abc-123"
    },
    "responseHeaders": {
      "x-ms-request-id": "srv-def-456",
      "Content-Type": "application/json"
    },
    "requestBodyPreview": null,
    "requestBodySize": 1048576,
    "responseBodyPreview": "{\"error\":{\"code\":\"ServiceUnavailable\",\"message\":\"The service is temporarily unavailable.\"}}",
    "responseBodySize": 98,
    "httpVersion": "2.0",
    "correlationId": "req-abc-123",
    "matchedRules": [
      {
        "ruleId": "preset-onelake-outage--blackhole-writes",
        "ruleName": "[OneLake Outage] Blackhole all writes",
        "phase": "request",
        "actionType": "blockRequest"
      }
    ],
    "actionsApplied": [
      "blockRequest → 503 ServiceUnavailable"
    ],
    "chaosModified": true
  }
}
```

**Field Reference:**

| Field | Type | Description |
|-------|------|-------------|
| `method` | `string` | HTTP method |
| `url` | `string` | Full URL. SAS tokens redacted. |
| `statusCode` | `int` | HTTP response status code |
| `durationMs` | `double` | Total round-trip time in ms (includes any injected delays) |
| `direction` | `string` | Always `"outbound"` (FLT → external). Future: `"inbound"` for webhook-style. |
| `httpClientName` | `string` | Named `HttpClient` from `IHttpClientFactory` |
| `requestHeaders` | `object` | Request headers. `Authorization` value is ALWAYS `"[redacted]"`. |
| `responseHeaders` | `object` | Response headers (unredacted) |
| `requestBodyPreview` | `string?` | First 4KB of request body. `null` for binary. |
| `requestBodySize` | `long` | Request body size in bytes. `-1` if unknown. |
| `responseBodyPreview` | `string?` | First 4KB of response body. `null` for binary. |
| `responseBodySize` | `long` | Response body size in bytes. `-1` if unknown. |
| `httpVersion` | `string` | HTTP version: `"1.1"`, `"2.0"` |
| `correlationId` | `string?` | From `x-ms-correlation-id`, `x-ms-request-id`, or `x-ms-client-request-id` |
| `matchedRules` | `MatchedRule[]` | Chaos rules that fired on this request (empty array if none) |
| `actionsApplied` | `string[]` | Human-readable descriptions of actions applied |
| `chaosModified` | `bool` | `true` if any chaos rule modified this request or response |

**Security:**
- `Authorization` header value → `"[redacted]"` (same as existing `http` topic)
- SAS tokens in URLs (`sig=`, `se=`, `sv=`, `sp=`) → stripped
- `requestBodyPreview` / `responseBodyPreview` → any field matching `password|secret|key|connectionstring` is redacted
- Raw JWT tokens are NEVER included

---

### 2.2 Rule Events

#### `RuleCreated`

**When:** A new rule is created via `ChaosCreateRule` or `ChaosLoadPreset`.

```json
{
  "eventType": "RuleCreated",
  "timestamp": "2026-07-28T10:30:00Z",
  "rule": {
    "id": "delay-onelake-writes-3s",
    "name": "Delay OneLake Writes 3s",
    "category": "traffic-control",
    "lifecycle": {
      "state": "draft",
      "createdAt": "2026-07-28T10:30:00Z",
      "fireCount": 0
    }
  }
}
```

**Frequency:** Once per creation. Burst during preset loading (N events for N rules).

---

#### `RuleUpdated`

**When:** A rule's state or definition changes (enable, disable, pause, edit, TTL expiry).

```json
{
  "eventType": "RuleUpdated",
  "timestamp": "2026-07-28T10:31:00Z",
  "ruleId": "delay-onelake-writes-3s",
  "changes": {
    "lifecycle.state": { "from": "draft", "to": "active" },
    "lifecycle.activatedAt": { "from": null, "to": "2026-07-28T10:31:00Z" }
  },
  "rule": { /* full updated rule object */ }
}
```

**Frequency:** Once per state transition. Multiple rapid changes are NOT batched — each fires its own event.

---

#### `RuleDeleted`

**When:** A rule is soft-deleted via `ChaosDeleteRule`.

```json
{
  "eventType": "RuleDeleted",
  "timestamp": "2026-07-28T10:32:00Z",
  "ruleId": "delay-onelake-writes-3s",
  "ruleName": "Delay OneLake Writes 3s"
}
```

---

#### `RuleFired`

**When:** A chaos rule's predicate matches an HTTP request and its action is applied. This is the real-time indicator that a rule is affecting traffic.

```json
{
  "eventType": "RuleFired",
  "timestamp": "2026-07-28T10:31:05.123Z",
  "ruleId": "delay-onelake-writes-3s",
  "ruleName": "Delay OneLake Writes 3s",
  "fireCount": 7,
  "maxFirings": 50,
  "phase": "request",
  "actionType": "delay",
  "actionSummary": "delay:3000ms (jitter:±500ms)",
  "matchedUrl": "https://onelake.dfs.fabric.microsoft.com/ws-guid/lh-guid/Tables/...",
  "matchedMethod": "PUT",
  "matchedHttpClient": "DatalakeDirectoryClient"
}
```

**Frequency:** Once per rule firing. A busy DAG with an active OneLake delay rule may fire 5–20 times/second. Frontend should debounce UI updates for counter badges (throttle to 2/sec visual refresh).

---

#### `RuleAutoDisabled`

**When:** A rule is automatically disabled by the engine (max firings reached, TTL expired, or safety system triggered).

```json
{
  "eventType": "RuleAutoDisabled",
  "timestamp": "2026-07-28T10:36:00Z",
  "ruleId": "delay-onelake-writes-3s",
  "ruleName": "Delay OneLake Writes 3s",
  "reason": "ttlSeconds reached (300s)",
  "newState": "expired",
  "finalFireCount": 47
}
```

**Reasons:**

| Reason | New State |
|--------|-----------|
| `"maxFirings reached ({N})"` | `expired` |
| `"ttlSeconds reached ({N}s)"` | `expired` |
| `"expiresAt reached"` | `expired` |
| `"Safety: FLT error rate >50% for 10s"` | `disabled-by-safety` |
| `"Safety: unhandled exception in rule execution"` | `disabled-by-safety` |
| `"Kill switch activated"` | `disabled-by-safety` |

---

### 2.3 Recording Events

#### `RecordingStarted`

**When:** `ChaosStartRecording` succeeds.

```json
{
  "eventType": "RecordingStarted",
  "timestamp": "2026-07-28T10:30:00Z",
  "sessionId": "rec-2026-07-28-onelake-baseline",
  "name": "onelake-baseline-2026-07-28",
  "filter": {
    "httpClientName": "OneLakeRestClient",
    "methods": ["GET", "PUT"]
  }
}
```

---

#### `RecordingStopped`

**When:** Recording ends (user stop, size limit, entry limit, or FLT exit).

```json
{
  "eventType": "RecordingStopped",
  "timestamp": "2026-07-28T10:35:12Z",
  "sessionId": "rec-2026-07-28-onelake-baseline",
  "name": "onelake-baseline-2026-07-28",
  "status": "completed",
  "entryCount": 847,
  "durationSeconds": 312,
  "reason": "user"
}
```

**`reason` values:** `"user"`, `"size_limit"`, `"entry_limit"`, `"flt_exit"`, `"disk_full"`, `"new_recording_started"`

---

#### `RecordingEntry`

**When:** A new entry is captured during an active recording. Allows the frontend to show a real-time counter / live preview.

```json
{
  "eventType": "RecordingEntry",
  "timestamp": "2026-07-28T10:31:05.123Z",
  "sessionId": "rec-2026-07-28-onelake-baseline",
  "entryIndex": 42,
  "method": "PUT",
  "url": "https://onelake.dfs.fabric.microsoft.com/...",
  "statusCode": 201,
  "durationMs": 145.3,
  "httpClientName": "DatalakeDirectoryClient"
}
```

**Frequency:** One per captured request. This is a lightweight summary — not the full `RecordingEntry` (that goes to JSONL on disk). Frontend uses this only for the recording counter badge and live preview list. Throttle UI rendering to max 5 updates/sec.

---

### 2.4 System Events

#### `KillSwitchActivated`

**When:** Kill switch fires (from SignalR method, keyboard shortcut, or file-based trigger).

**CRITICAL:** This event is broadcast to ALL connected clients — not just chaos subscribers. The top bar kill-switch indicator must update regardless of which tab/panel is active.

```json
{
  "eventType": "KillSwitchActivated",
  "timestamp": "2026-07-28T10:31:30Z",
  "source": "keyboard",
  "rulesDisabled": 6,
  "message": "All chaos rules disabled. Engine locked."
}
```

**`source` values:** `"keyboard"` (Ctrl+Shift+K), `"signalr"` (ChaosKillSwitch method), `"file"` (.edog-command trigger), `"edog_http"` (edog.py endpoint), `"health_guard"` (auto-triggered)

---

#### `HealthGuardTriggered`

**When:** The FLT health guard detects anomalies and auto-disables chaos rules.

```json
{
  "eventType": "HealthGuardTriggered",
  "timestamp": "2026-07-28T10:31:30Z",
  "signal": "error_rate_spike",
  "detail": "HTTP 5xx rate exceeded 50% over 10s window (67% observed)",
  "rulesDisabled": 3,
  "ruleIds": ["delay-onelake-writes-3s", "block-spark-calls", "forge-401-response"]
}
```

**`signal` values:** `"error_rate_spike"`, `"flt_process_crash"`, `"unhandled_exception"`, `"cpu_threshold"`

---

#### `AuditEntry`

**When:** Any audit-worthy action occurs. This is the real-time feed of the rule audit log.

```json
{
  "eventType": "AuditEntry",
  "timestamp": "2026-07-28T10:31:00Z",
  "ruleId": "delay-onelake-writes-3s",
  "ruleName": "Delay OneLake Writes 3s",
  "event": "enabled",
  "detail": "User activated. limits: maxFirings=50, ttlSeconds=300",
  "severity": "info"
}
```

**`severity` values:** `"info"` (state changes), `"warning"` (safety notices), `"error"` (failures)

**`event` values:** `"created"`, `"updated"`, `"enabled"`, `"paused"`, `"expired"`, `"deleted"`, `"fired"`, `"disabled-by-safety"`, `"safety-warning"`, `"kill-switch"`, `"validation-error"`

**Frequency:** Audit entries for `"fired"` events can be high-frequency. The engine rate-limits `"fired"` audit broadcasts to max **5/sec per rule** — individual firing counts are tracked internally but not all broadcast. The `RuleFired` event is the high-frequency channel; `AuditEntry` with `event: "fired"` is the throttled summary.

---

## 3. Message Shapes — Complete JSON Reference

### 3.1 ChaosTrafficEvent

Full event shape as delivered through the `ChaosSubscribeTraffic` stream:

```json
{
  "sequenceId": 12345,
  "timestamp": "2026-07-28T10:31:05.123Z",
  "topic": "chaos-traffic",
  "data": {
    "method": "PUT",
    "url": "https://onelake.dfs.fabric.microsoft.com/ws-guid/lh-guid/Tables/mytable/part-0001.parquet",
    "statusCode": 503,
    "durationMs": 3045.2,
    "direction": "outbound",
    "httpClientName": "DatalakeDirectoryClient",
    "httpVersion": "2.0",
    "correlationId": "req-abc-123",
    "requestHeaders": {
      "Content-Type": "application/octet-stream",
      "Authorization": "[redacted]",
      "x-ms-client-request-id": "req-abc-123"
    },
    "responseHeaders": {
      "x-ms-request-id": "srv-def-456",
      "Content-Type": "application/json",
      "Retry-After": "30"
    },
    "requestBodyPreview": null,
    "requestBodySize": 1048576,
    "responseBodyPreview": "{\"error\":{\"code\":\"ServiceUnavailable\",\"message\":\"The service is temporarily unavailable. Please retry.\"}}",
    "responseBodySize": 98,
    "matchedRules": [
      {
        "ruleId": "preset-onelake-outage--blackhole-writes",
        "ruleName": "[OneLake Outage] Blackhole all writes",
        "phase": "request",
        "actionType": "blockRequest"
      }
    ],
    "actionsApplied": [
      "blockRequest → 503 ServiceUnavailable (forged response)"
    ],
    "chaosModified": true
  }
}
```

---

### 3.2 ChaosRuleInput

The shape sent by the client when creating or updating a rule. This is the editable subset of the full `ChaosRule` — server-managed fields (`lifecycle`, `audit`) are excluded.

```json
{
  "id": "delay-onelake-writes-3s",
  "name": "Delay OneLake Writes 3s",
  "description": "Tests timeout handling for OneLake write operations during DAG execution.",
  "category": "traffic-control",
  "tags": ["onelake", "latency", "dag"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "method", "op": "equals", "value": "PUT" }
    ]
  },
  "action": {
    "type": "delay",
    "config": {
      "delayMs": 3000,
      "jitterMs": 500
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": {
    "maxFirings": 50,
    "ttlSeconds": 300,
    "maxRatePerSecond": 0,
    "expiresAt": null
  }
}
```

---

### 3.3 ChaosRule (Full — Server Response)

The complete rule object returned by `ChaosGetRule` and `ChaosGetAllRules`. Includes server-managed lifecycle and audit fields.

```json
{
  "id": "delay-onelake-writes-3s",
  "name": "Delay OneLake Writes 3s",
  "description": "Tests timeout handling for OneLake write operations during DAG execution.",
  "category": "traffic-control",
  "tags": ["onelake", "latency", "dag"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "method", "op": "equals", "value": "PUT" }
    ]
  },
  "action": {
    "type": "delay",
    "config": {
      "delayMs": 3000,
      "jitterMs": 500
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": true,
  "probability": 1.0,
  "limits": {
    "maxFirings": 50,
    "maxRatePerSecond": 0,
    "ttlSeconds": 300,
    "expiresAt": null
  },
  "lifecycle": {
    "state": "active",
    "createdAt": "2026-07-28T10:30:00Z",
    "activatedAt": "2026-07-28T10:31:00Z",
    "lastFiredAt": "2026-07-28T10:31:05.123Z",
    "fireCount": 7,
    "disableReason": null
  },
  "audit": [
    { "timestamp": "2026-07-28T10:30:00Z", "event": "created", "detail": "Rule created via SignalR" },
    { "timestamp": "2026-07-28T10:31:00Z", "event": "enabled", "detail": "User activated. limits: maxFirings=50, ttlSeconds=300" },
    { "timestamp": "2026-07-28T10:31:05Z", "event": "fired", "detail": "Matched PUT onelake.dfs... (fire #7)" }
  ]
}
```

---

### 3.4 ChaosOperationResult

Generic result for control operations (enable, disable, delete, kill switch).

```json
{
  "success": true,
  "message": "Rule 'delay-onelake-writes-3s' enabled."
}
```

Error variant:

```json
{
  "success": false,
  "message": "Cannot activate rule without at least one limit (maxFirings, ttlSeconds, or expiresAt)"
}
```

---

### 3.5 ChaosRuleResult

Result for create/update operations. Includes validation details.

```json
{
  "success": true,
  "rule": { /* full ChaosRule */ },
  "validationErrors": []
}
```

Validation error variant:

```json
{
  "success": false,
  "rule": null,
  "validationErrors": [
    { "field": "predicate.conditions[0].value", "message": "Invalid regex: unmatched parenthesis at position 12" },
    { "field": "action.config.delayMs", "message": "Required field missing" }
  ]
}
```

---

### 3.6 ChaosPresetSummary

Preset listing entry (returned by `ChaosListPresets`).

```json
{
  "id": "preset-onelake-outage",
  "name": "Simulate OneLake Outage",
  "description": "Full OneLake service outage affecting file ops, catalog, and directory listing.",
  "category": "infrastructure",
  "icon": "◆",
  "severity": "high",
  "estimatedDuration": "5m",
  "tags": ["onelake", "outage", "p0"],
  "ruleCount": 4,
  "isBuiltIn": true
}
```

---

### 3.7 RecordingSession

Recording metadata (returned by `ChaosGetRecordings` and inside `ChaosStopRecording` result).

```json
{
  "id": "rec-2026-07-28-onelake-baseline",
  "name": "onelake-baseline-2026-07-28",
  "status": "completed",
  "startedAt": "2026-07-28T10:30:00Z",
  "stoppedAt": "2026-07-28T10:35:12Z",
  "durationSeconds": 312,
  "entryCount": 847,
  "totalRequestBytes": 12400,
  "totalResponseBytes": 3847200,
  "filter": {
    "httpClientName": "OneLakeRestClient",
    "methods": ["GET", "PUT"]
  },
  "metadata": {
    "fltVersion": "2026.07.15",
    "edogVersion": "1.2.0",
    "gitSha": "abc1234",
    "user": "hemant@microsoft.com"
  },
  "tags": ["baseline", "onelake", "dag-v2"]
}
```

**`status` values:** `"recording"`, `"completed"`, `"truncated"`, `"interrupted"`

---

## 4. Integration with Existing Hub

### 4.1 Hub Registration

All chaos methods are added to the **same** `EdogPlaygroundHub` class:

```csharp
public sealed class EdogPlaygroundHub : Hub
{
    // === Existing Methods (unchanged) ===
    public async Task Subscribe(string topic) { ... }
    public async Task Unsubscribe(string topic) { ... }
    public ChannelReader<TopicEvent> SubscribeToTopic(string topic, CancellationToken ct) { ... }

    // === Chaos: Rule CRUD ===
    public Task<ChaosRuleResult> ChaosCreateRule(ChaosRuleInput rule) { ... }
    public Task<ChaosRuleResult> ChaosUpdateRule(ChaosRuleInput rule) { ... }
    public Task<ChaosOperationResult> ChaosDeleteRule(string ruleId) { ... }
    public Task<ChaosRule[]> ChaosGetAllRules(ChaosRuleFilter filter) { ... }
    public Task<ChaosRule> ChaosGetRule(string ruleId) { ... }

    // === Chaos: Rule Control ===
    public Task<ChaosOperationResult> ChaosEnableRule(string ruleId) { ... }
    public Task<ChaosOperationResult> ChaosDisableRule(string ruleId) { ... }
    public Task<ChaosOperationResult> ChaosEnableAll() { ... }
    public Task<ChaosOperationResult> ChaosDisableAll() { ... }
    public Task<ChaosOperationResult> ChaosKillSwitch() { ... }
    public Task<ChaosOperationResult> ChaosResetKillSwitch() { ... }

    // === Chaos: Recording ===
    public Task<RecordingResult> ChaosStartRecording(RecordingConfig config) { ... }
    public Task<RecordingResult> ChaosStopRecording() { ... }
    public Task<RecordingSession[]> ChaosGetRecordings() { ... }
    public Task<ExportResult> ChaosExportRecording(string sessionId, string format) { ... }

    // === Chaos: Traffic Streaming ===
    public ChannelReader<TopicEvent> ChaosSubscribeTraffic(
        TrafficFilter filter, CancellationToken ct) { ... }

    // === Chaos: Presets ===
    public Task<ChaosPresetSummary[]> ChaosListPresets() { ... }
    public Task<ChaosPresetLoadResult> ChaosLoadPreset(string presetId, bool activate) { ... }
}
```

### 4.2 CORS & Security

Same configuration as existing hub — no changes needed:

```csharp
// In EdogLogServer.cs — CORS policy (unchanged)
builder.Services.AddCors(options =>
{
    options.AddPolicy("EdogCors", policy =>
    {
        policy.WithOrigins(
            "http://localhost:5555",
            "http://127.0.0.1:5555")
            .AllowAnyMethod()
            .AllowAnyHeader()
            .AllowCredentials();
    });
});
```

All chaos methods are protected by this same localhost-only CORS policy. The Kestrel server only binds to `localhost:5557` — no external network access.

### 4.3 Reconnection Behavior

Same as existing hub:

1. SignalR auto-reconnects: `[0, 1000, 2000, 5000, 10000, 30000]` ms backoff
2. On reconnect, client re-fetches rule state via `ChaosGetAllRules()`
3. If traffic stream was active, client re-calls `ChaosSubscribeTraffic()` (fresh snapshot + live)
4. Kill switch state persists server-side — client checks `ChaosRuleEngine.KillSwitchActive` on reconnect

**Kill switch resilience:** Even if SignalR is disconnected:
- Keyboard shortcut (Ctrl+Shift+K) sends HTTP POST to `edog.py` on port 5556
- `edog.py` calls `ChaosRuleEngine` directly (no SignalR needed)
- File-based trigger works even if both SignalR and HTTP are down

### 4.4 New Topic: `chaos`

Registered with `EdogTopicRouter`:

```csharp
EdogTopicRouter.RegisterTopic("chaos", 500);  // 500-event ring buffer for chaos audit/rule events
```

The `chaos` topic carries `RuleFired`, `RuleAutoDisabled`, `AuditEntry`, and `HealthGuardTriggered` events. Clients subscribe via `connection.invoke('Subscribe', 'chaos')`.

`KillSwitchActivated` is NOT published through the topic buffer — it's broadcast directly via `Clients.All.SendAsync()` for reliability.

---

## 5. JS Client Integration

### 5.1 SignalRManager Extensions

New methods added to `SignalRManager` (same class, same file):

```javascript
// === Chaos Rule CRUD ===
chaosCreateRule(rule)      { return this.connection.invoke('ChaosCreateRule', rule); }
chaosUpdateRule(rule)      { return this.connection.invoke('ChaosUpdateRule', rule); }
chaosDeleteRule(ruleId)    { return this.connection.invoke('ChaosDeleteRule', ruleId); }
chaosGetAllRules(filter)   { return this.connection.invoke('ChaosGetAllRules', filter || null); }
chaosGetRule(ruleId)       { return this.connection.invoke('ChaosGetRule', ruleId); }

// === Chaos Rule Control ===
chaosEnableRule(ruleId)    { return this.connection.invoke('ChaosEnableRule', ruleId); }
chaosDisableRule(ruleId)   { return this.connection.invoke('ChaosDisableRule', ruleId); }
chaosEnableAll()           { return this.connection.invoke('ChaosEnableAll'); }
chaosDisableAll()          { return this.connection.invoke('ChaosDisableAll'); }
chaosKillSwitch()          { return this.connection.invoke('ChaosKillSwitch'); }
chaosResetKillSwitch()     { return this.connection.invoke('ChaosResetKillSwitch'); }

// === Chaos Recording ===
chaosStartRecording(config)    { return this.connection.invoke('ChaosStartRecording', config); }
chaosStopRecording()           { return this.connection.invoke('ChaosStopRecording'); }
chaosGetRecordings()           { return this.connection.invoke('ChaosGetRecordings'); }
chaosExportRecording(id, fmt)  { return this.connection.invoke('ChaosExportRecording', id, fmt || 'har'); }

// === Chaos Presets ===
chaosListPresets()                     { return this.connection.invoke('ChaosListPresets'); }
chaosLoadPreset(presetId, activate)    { return this.connection.invoke('ChaosLoadPreset', presetId, activate || false); }
```

### 5.2 Traffic Streaming

Uses the same `ChannelReader` streaming pattern as `subscribeTopic()`:

```javascript
// Start streaming chaos traffic
chaosSubscribeTraffic(filter) {
  if (this._chaosTrafficStream) return;  // already streaming

  const stream = this.connection.stream('ChaosSubscribeTraffic', filter || null);
  this._chaosTrafficStream = stream;

  stream.subscribe({
    next: (event) => {
      const cbs = this._listeners.get('chaos-traffic');
      if (cbs) cbs.forEach(cb => {
        try { cb(event); } catch (e) { console.error('[chaos-traffic]', e); }
      });
    },
    error: (err) => {
      console.error('[chaos-traffic stream error]', err);
      this._chaosTrafficStream = null;
    },
    complete: () => {
      this._chaosTrafficStream = null;
    }
  });
}

// Stop streaming
chaosUnsubscribeTraffic() {
  if (this._chaosTrafficStream) {
    try { this._chaosTrafficStream.dispose(); } catch (e) { /* already closed */ }
    this._chaosTrafficStream = null;
  }
}
```

### 5.3 Event Handlers

Registered during chaos panel initialization:

```javascript
// Rule state change events (via chaos group broadcast)
this.connection.on('RuleCreated',       (e) => this._dispatch('chaos', e));
this.connection.on('RuleUpdated',       (e) => this._dispatch('chaos', e));
this.connection.on('RuleDeleted',       (e) => this._dispatch('chaos', e));
this.connection.on('RuleFired',         (e) => this._dispatch('chaos', e));
this.connection.on('RuleAutoDisabled',  (e) => this._dispatch('chaos', e));

// Recording events
this.connection.on('RecordingStarted',  (e) => this._dispatch('chaos', e));
this.connection.on('RecordingStopped',  (e) => this._dispatch('chaos', e));
this.connection.on('RecordingEntry',    (e) => this._dispatch('chaos', e));

// System events — registered GLOBALLY (not just for chaos panel)
this.connection.on('KillSwitchActivated',   (e) => this._dispatch('kill-switch', e));
this.connection.on('HealthGuardTriggered',  (e) => this._dispatch('health-guard', e));
this.connection.on('AuditEntry',            (e) => this._dispatch('chaos-audit', e));
```

`KillSwitchActivated` and `HealthGuardTriggered` handlers are registered in `connect()`, not in chaos panel activation — they must work regardless of which view is active.

### 5.4 Reconnection

On reconnect, the chaos panel module re-hydrates:

```javascript
async _onReconnected() {
  // Re-fetch all rule state (server is source of truth)
  const rules = await this._signalr.chaosGetAllRules();
  this._renderRuleList(rules);

  // Re-subscribe to chaos group
  this._signalr.subscribe('chaos');

  // Re-start traffic stream if it was active
  if (this._wasStreamingTraffic) {
    this._signalr.chaosSubscribeTraffic(this._currentTrafficFilter);
  }
}
```

---

## 6. Sequence Diagrams

### 6.1 Create and Enable a Rule

```
Browser                                  FLT Process
───────                                  ───────────
ChaosCreateRule(rule)          ────────► Validate → Store in draft
  ◄──── ChaosRuleResult { success, rule }
  ◄──── RuleCreated event (broadcast)

ChaosEnableRule(ruleId)        ────────► Validate limits → Activate
  ◄──── ChaosOperationResult { success }
  ◄──── RuleUpdated event (state: active)

                                         ... traffic flows ...

  ◄──── RuleFired event (each time rule matches)
  ◄──── ChaosTrafficEvent (via stream, shows matched rule)

                                         ... TTL expires ...

  ◄──── RuleAutoDisabled event (state: expired)
  ◄──── AuditEntry event (ttlSeconds reached)
```

### 6.2 Kill Switch Flow

```
Browser                       edog.py              FLT Process
───────                       ───────              ───────────
Ctrl+Shift+K pressed
  │
  ├─► ChaosKillSwitch()   ─────────────────────► ChaosRuleEngine.ActivateKillSwitch()
  │     (SignalR invoke)                           │ Clear active snapshot
  │                                                │ Set KillSwitchActive = true
  │                                                │ Transition all → disabled-by-safety
  │                                                │
  ◄───── ChaosOperationResult ◄────────────────────┘
  ◄───── KillSwitchActivated event (ALL clients)
  │
  │  OR if SignalR is down:
  │
  ├─► POST :5556/chaos/killswitch ──► edog.py ──► ChaosRuleEngine.ActivateKillSwitch()
  │     (HTTP fallback)                 (IPC)      (same result, no SignalR needed)
  │
  │  OR if both are down:
  │
  └─► Write to .edog-command/chaos-kill ──► edog.py file watcher ──► same engine call
```

### 6.3 Recording Flow

```
Browser                                  FLT Process
───────                                  ───────────
ChaosStartRecording(config)    ────────► RecordingManager.Start(config)
  ◄──── RecordingResult { success }        │ Create .jsonl + .meta.json
  ◄──── RecordingStarted event             │ Start background writer

                                         ... HTTP traffic flows ...
                                           │ Each request → RecordingManager.TryAppend()
  ◄──── RecordingEntry event (each entry)  │ → Background writer → JSONL line

ChaosStopRecording()           ────────► RecordingManager.Stop()
  ◄──── RecordingResult { session }        │ Flush channel, close file
  ◄──── RecordingStopped event             │ Finalize .meta.json

ChaosExportRecording(id, "har")────────► Read JSONL → Convert to HAR 1.2
  ◄──── ExportResult { content }
```

---

## 7. Performance Budget

| Metric | Target | Notes |
|--------|--------|-------|
| Rule CRUD latency (invoke round-trip) | < 50ms | Synchronous store operations |
| Kill switch activation latency | < 10ms | Atomic volatile write — must be near-instant |
| Traffic event latency (engine → browser) | < 100ms | Through ChannelReader stream |
| Traffic stream backpressure | 2000 event buffer | `BoundedChannelOptions(2000)`, `DropOldest` |
| Max chaos events/sec sustained | 500 | Rule firings + traffic events + audit entries |
| RuleFired broadcast throttle | 5/sec per rule | Higher frequency tracked internally, not broadcast |
| RecordingEntry broadcast throttle | 10/sec | Lightweight summary; full data goes to JSONL |
| ChaosGetAllRules response size (50 rules) | < 100KB | Full rule objects with audit arrays |
| Recording export (10K entries) | < 3 seconds | Streaming JSONL read → HAR conversion |

---

## 8. Error Handling

### Server-Side

All hub methods use structured error responses (`success: false` + `message`), NOT `HubException` throws. This ensures the frontend always gets a parseable response.

**Exception:** Only `ChaosSubscribeTraffic` throws `ArgumentException` for truly invalid arguments (following existing `SubscribeToTopic` pattern). All other methods return result objects.

### Client-Side

```javascript
try {
  const result = await signalr.chaosCreateRule(rule);
  if (!result.success) {
    this._showValidationErrors(result.validationErrors);
  }
} catch (err) {
  // SignalR transport error (disconnected, timeout)
  this._showConnectionError(err);
}
```

### Kill Switch Error Handling

The kill switch has three layers of redundancy to ensure it ALWAYS works:

| Layer | Transport | Failure Mode |
|-------|-----------|--------------|
| 1 | SignalR invoke | Fails if hub is disconnected |
| 2 | HTTP POST to edog.py (:5556) | Fails if edog.py is down |
| 3 | File write to `.edog-command/` | Fails only if filesystem is unavailable |

Frontend tries layer 1 first. If it fails (connection state ≠ Connected), falls through to layer 2 via `fetch()`. Layer 3 is a monitoring-side trigger, not initiated by the browser.

---

## 9. Migration Notes

### Existing Protocol Compatibility

All chaos methods are **additive** — no existing hub methods are modified or removed. Runtime View continues to work exactly as before:

- `Subscribe/Unsubscribe` — unchanged
- `SubscribeToTopic` — unchanged (all 11 existing topics)
- `LogEntry/TelemetryEvent` broadcast events — unchanged

### New Topic Registration

Add to `EdogLogServer.ConfigureServices()`:

```csharp
EdogTopicRouter.RegisterTopic("chaos", 500);
```

### Frontend: Global Event Handlers

`KillSwitchActivated` and `HealthGuardTriggered` handlers MUST be registered in `SignalRManager.connect()` (not lazy-loaded with the chaos panel). These are safety-critical events that affect the top bar status indicator regardless of active view.

---

## Appendix A: Method Quick Reference

### Client → Server (Hub Methods)

| Method | Parameters | Return | Category |
|--------|-----------|--------|----------|
| `ChaosCreateRule` | `rule: ChaosRuleInput` | `ChaosRuleResult` | CRUD |
| `ChaosUpdateRule` | `rule: ChaosRuleInput` | `ChaosRuleResult` | CRUD |
| `ChaosDeleteRule` | `ruleId: string` | `ChaosOperationResult` | CRUD |
| `ChaosGetAllRules` | `filter?: ChaosRuleFilter` | `ChaosRule[]` | CRUD |
| `ChaosGetRule` | `ruleId: string` | `ChaosRule?` | CRUD |
| `ChaosEnableRule` | `ruleId: string` | `ChaosOperationResult` | Control |
| `ChaosDisableRule` | `ruleId: string` | `ChaosOperationResult` | Control |
| `ChaosEnableAll` | — | `ChaosOperationResult` | Control |
| `ChaosDisableAll` | — | `ChaosOperationResult` | Control |
| `ChaosKillSwitch` | — | `ChaosOperationResult` | Control |
| `ChaosResetKillSwitch` | — | `ChaosOperationResult` | Control |
| `ChaosStartRecording` | `config: RecordingConfig` | `RecordingResult` | Recording |
| `ChaosStopRecording` | — | `RecordingResult` | Recording |
| `ChaosGetRecordings` | — | `RecordingSession[]` | Recording |
| `ChaosExportRecording` | `sessionId: string, format?: string` | `ExportResult` | Recording |
| `ChaosSubscribeTraffic` | `filter?: TrafficFilter, CancellationToken` | `ChannelReader<TopicEvent>` | Traffic |
| `ChaosListPresets` | — | `ChaosPresetSummary[]` | Presets |
| `ChaosLoadPreset` | `presetId: string, activate?: bool` | `ChaosPresetLoadResult` | Presets |

### Server → Client (Events)

| Event | Payload | Delivery | Audience |
|-------|---------|----------|----------|
| `ChaosTrafficEvent` | See §3.1 | `ChannelReader` stream | Requesting client |
| `RuleCreated` | `{ eventType, timestamp, rule }` | Group broadcast | `chaos` group |
| `RuleUpdated` | `{ eventType, timestamp, ruleId, changes, rule }` | Group broadcast | `chaos` group |
| `RuleDeleted` | `{ eventType, timestamp, ruleId, ruleName }` | Group broadcast | `chaos` group |
| `RuleFired` | `{ eventType, timestamp, ruleId, fireCount, ... }` | Group broadcast | `chaos` group |
| `RuleAutoDisabled` | `{ eventType, timestamp, ruleId, reason, newState }` | Group broadcast | `chaos` group |
| `RecordingStarted` | `{ eventType, timestamp, sessionId, name, filter }` | Group broadcast | `chaos` group |
| `RecordingStopped` | `{ eventType, timestamp, sessionId, status, entryCount }` | Group broadcast | `chaos` group |
| `RecordingEntry` | `{ eventType, timestamp, sessionId, entryIndex, ... }` | Group broadcast | `chaos` group |
| `KillSwitchActivated` | `{ eventType, timestamp, source, rulesDisabled }` | **ALL clients** | Everyone |
| `HealthGuardTriggered` | `{ eventType, timestamp, signal, detail, ruleIds }` | **ALL clients** | Everyone |
| `AuditEntry` | `{ eventType, timestamp, ruleId, event, detail, severity }` | Group broadcast | `chaos` group |
