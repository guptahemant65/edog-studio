# EDOG Studio — Chaos Engineering & MITM Capabilities

> **Author:** Sana Reeves (Architect) + Vex (Backend)
> **Status:** DESIGN SPEC — Approved for planning
> **Date:** 2026-07-14
> **Scope:** Application-level HTTP interception engine for FLT outbound traffic
> **Depends On:** `EdogHttpPipelineHandler`, `EdogHttpClientFactoryWrapper`, `EdogTopicRouter`

---

## Executive Summary

EDOG already sits inside FLT's `HttpClient` pipeline via `EdogHttpClientFactoryWrapper`, which injects `DelegatingHandler` interceptors into every named HttpClient. Today these handlers are **passive observers** — they capture timing, headers, and body previews, then return the original response unmodified.

This spec upgrades the pipeline handler from passive observer to **active MITM engine** — a programmable rule engine that can modify, delay, redirect, block, forge, record, and replay any HTTP request or response flowing through FLT's outbound pipeline. Think Burp Suite, but running inside the service process with full access to the request pipeline, auth context, and DI container.

### What Flows Through the Pipeline

Every outbound HTTP call from FLT passes through our handler chain:

| Named Client | Target Service | Auth | Volume |
|---|---|---|---|
| `OneLakeRestClient` | OneLake DFS (list, metadata) | S2S + Bearer | High |
| `DatalakeDirectoryClient` | Azure Data Lake SDK (file ops) | S2S + AAD | High |
| `FabricApiClient` | Fabric Public API (workspace, lakehouse) | Bearer + S2S | Medium |
| `PbiSharedApiClient` | PBI Shared Services (reports) | Bearer + S2S | Low |
| `UnauthenticatedWithGeneralRetries` | General (unauthenticated) | None | Low |
| `UnauthenticatedWithGeneralRetriesBypassSsl` | General (test, SSL bypass) | None | Low |

Plus Spark/GTS traffic via `ISparkClientFactory` and OneLake file ops via `IFileSystemFactory`.

---

## Part 1: The ChaosRule Engine

### Design Philosophy

One well-designed rule engine makes all 30 capabilities trivial to add. Every chaos capability is just a `ChaosRule` — a predicate (when to fire) plus an action (what to do). The engine evaluates rules on every `SendAsync` call, applies matching rules in priority order, and publishes events to the `"chaos"` topic for the frontend.

### Core Data Model

```csharp
/// <summary>
/// A single chaos rule. Evaluated on every HTTP request passing through the pipeline.
/// Rules are hot-reloadable — the frontend pushes new rulesets via SignalR.
/// </summary>
public class ChaosRule
{
    /// <summary>Unique rule ID (e.g., "delay-onelake-writes").</summary>
    public string Id { get; set; }

    /// <summary>Human-readable name shown in the UI.</summary>
    public string Name { get; set; }

    /// <summary>Category for UI grouping (e.g., "RequestSurgery", "ResponseForgery").</summary>
    public string Category { get; set; }

    /// <summary>Whether this rule is currently active.</summary>
    public bool Enabled { get; set; }

    /// <summary>Priority — lower numbers execute first. Default: 100.</summary>
    public int Priority { get; set; } = 100;

    // ── MATCHING (when to fire) ──

    /// <summary>Regex pattern matched against the full request URL.</summary>
    public string UrlPattern { get; set; }

    /// <summary>HTTP method filter (GET, POST, PUT, DELETE, PATCH, or * for all).</summary>
    public string MethodFilter { get; set; } = "*";

    /// <summary>Named HttpClient filter (e.g., "OneLakeRestClient"). Null = all clients.</summary>
    public string HttpClientNameFilter { get; set; }

    /// <summary>Header presence/value filter. Key = header name, Value = regex for value.</summary>
    public Dictionary<string, string> HeaderFilters { get; set; }

    /// <summary>Regex matched against request body (for POST/PUT). Null = skip body matching.</summary>
    public string BodyPattern { get; set; }

    /// <summary>Response status code filter (for response-phase rules). 0 = any.</summary>
    public int ResponseStatusFilter { get; set; }

    // ── PROBABILISTIC CONTROL ──

    /// <summary>Probability this rule fires when matched (0.0–1.0). Default: 1.0 = always.</summary>
    public double Probability { get; set; } = 1.0;

    /// <summary>Maximum times this rule can fire total. 0 = unlimited.</summary>
    public int MaxFirings { get; set; }

    /// <summary>Maximum times per second. 0 = unlimited.</summary>
    public double MaxRatePerSecond { get; set; }

    // ── ACTION (what to do) ──

    /// <summary>The action type. See ChaosActionType enum.</summary>
    public ChaosActionType Action { get; set; }

    /// <summary>Action-specific configuration (JSON object, interpreted per action type).</summary>
    public Dictionary<string, object> ActionConfig { get; set; }

    // ── METADATA ──

    /// <summary>When this rule was created (UTC).</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Number of times this rule has fired.</summary>
    public long FireCount { get; set; }

    /// <summary>Timestamp of last firing.</summary>
    public DateTimeOffset? LastFiredAt { get; set; }
}

public enum ChaosActionType
{
    // ── REQUEST PHASE ──
    Delay,                  // Hold request for N ms before forwarding
    ModifyRequestHeader,    // Add/remove/replace request headers
    ModifyRequestBody,      // Regex replace on request body
    RewriteUrl,             // Change the target URL
    BlockRequest,           // Return a canned response without calling the real service
    RedirectRequest,        // Forward to a different URL entirely

    // ── RESPONSE PHASE ──
    ModifyResponseStatus,   // Change HTTP status code
    ModifyResponseHeader,   // Add/remove/replace response headers
    ModifyResponseBody,     // Regex replace or JSON field mutation on response body
    DelayResponse,          // Hold response for N ms before returning to FLT
    ForgeResponse,          // Return a completely fabricated response
    DropResponse,           // Simulate connection failure (throw HttpRequestException)

    // ── TRAFFIC CONTROL ──
    ThrottleBandwidth,      // Trickle response body at N bytes/sec
    DuplicateRequest,       // Clone request to a shadow endpoint
    CacheResponse,          // Serve cached response for matching requests

    // ── RECORDING ──
    RecordTraffic,          // Full request/response recording to a named session
    TagRequest,             // Add metadata tag for later filtering
}
```

### Engine Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    EdogHttpPipelineHandler.SendAsync()            │
│                                                                  │
│  1. Snapshot request (method, url, headers, body preview)        │
│  2. ─── REQUEST PHASE RULES ───                                  │
│     for each enabled rule matching this request (sorted by pri): │
│       - Check probability gate (Random < rule.Probability?)      │
│       - Check rate limit gate                                    │
│       - Check max firings gate                                   │
│       - Execute action (delay, modify, block, redirect...)       │
│       - Publish ChaosEvent to "chaos" topic                      │
│       - If action is BlockRequest → return canned response, skip │
│                                                                  │
│  3. base.SendAsync(request, ct) → real HTTP call                 │
│                                                                  │
│  4. ─── RESPONSE PHASE RULES ───                                 │
│     for each enabled rule matching this response:                │
│       - Execute action (modify status, body, headers, delay...)  │
│       - Publish ChaosEvent to "chaos" topic                      │
│                                                                  │
│  5. Return response (modified or original) to FLT                │
└──────────────────────────────────────────────────────────────────┘
```

### Rule Storage & Hot Reload

```csharp
/// <summary>
/// Thread-safe rule store. Rules are pushed from the frontend via SignalR
/// and evaluated on every HTTP request. Lock-free reads via immutable snapshot.
/// </summary>
public static class ChaosRuleStore
{
    // Immutable snapshot — swapped atomically on updates.
    // Readers never block. Writers (SignalR updates) are serialized.
    private static volatile IReadOnlyList<ChaosRule> _rules = Array.Empty<ChaosRule>();
    private static readonly object _writeLock = new();

    /// <summary>Current active rules (immutable snapshot — safe to iterate without locking).</summary>
    public static IReadOnlyList<ChaosRule> Rules => _rules;

    /// <summary>Replace all rules atomically. Called from SignalR hub.</summary>
    public static void SetRules(IReadOnlyList<ChaosRule> rules)
    {
        lock (_writeLock)
        {
            _rules = rules.OrderBy(r => r.Priority).ToList().AsReadOnly();
        }
    }

    /// <summary>Enable/disable a single rule by ID.</summary>
    public static void SetEnabled(string ruleId, bool enabled) { /* ... */ }

    /// <summary>Add a single rule (merge into current set).</summary>
    public static void AddRule(ChaosRule rule) { /* ... */ }

    /// <summary>Remove a rule by ID.</summary>
    public static void RemoveRule(string ruleId) { /* ... */ }

    /// <summary>Clear all rules (panic button).</summary>
    public static void ClearAll()
    {
        lock (_writeLock) { _rules = Array.Empty<ChaosRule>(); }
    }
}
```

### Rule Evaluation in the Handler

```csharp
// Inside EdogHttpPipelineHandler.SendAsync():

protected override async Task<HttpResponseMessage> SendAsync(
    HttpRequestMessage request, CancellationToken cancellationToken)
{
    var rules = ChaosRuleStore.Rules; // snapshot — lock-free read
    if (rules.Count == 0)
    {
        // Fast path — no rules active, zero overhead
        return await ExecuteWithTelemetry(request, cancellationToken);
    }

    var ctx = new ChaosContext(request, _httpClientName);

    // ── REQUEST PHASE ──
    foreach (var rule in rules.Where(r => r.Enabled && IsRequestPhase(r.Action)))
    {
        if (Matches(rule, ctx) && PassesGates(rule))
        {
            var result = await ExecuteRequestAction(rule, ctx, cancellationToken);
            PublishChaosEvent(rule, ctx, "request");
            if (result.ShortCircuit)
                return result.Response; // BlockRequest / ForgeResponse
        }
    }

    // ── FORWARD TO REAL SERVICE ──
    var sw = Stopwatch.StartNew();
    var response = await base.SendAsync(ctx.Request, cancellationToken);
    sw.Stop();
    ctx.Response = response;
    ctx.DurationMs = sw.Elapsed.TotalMilliseconds;

    // ── RESPONSE PHASE ──
    foreach (var rule in rules.Where(r => r.Enabled && IsResponsePhase(r.Action)))
    {
        if (Matches(rule, ctx) && PassesGates(rule))
        {
            response = await ExecuteResponseAction(rule, ctx, response, cancellationToken);
            PublishChaosEvent(rule, ctx, "response");
        }
    }

    // ── TELEMETRY (existing behavior) ──
    PublishHttpEvent(ctx, response, sw);

    return response;
}
```

### Performance Guarantees

| Scenario | Overhead | Mechanism |
|---|---|---|
| No rules active | **Zero** | `rules.Count == 0` fast path skips all evaluation |
| Rules active, no match | **< 0.05ms** | Regex is compiled, URL check is prefix-first |
| Rules active, match | **< 1ms** + action time | Action time is user-configured (delays are intentional) |
| 100+ rules | **< 0.5ms** scan | Linear scan is fine — HTTP latency dwarfs rule eval |

### SignalR Protocol (Frontend ↔ Engine)

New SignalR hub methods on `EdogPlaygroundHub`:

```csharp
// Frontend → Backend (rule management)
Task SetChaosRules(ChaosRule[] rules)        // Replace all rules
Task AddChaosRule(ChaosRule rule)             // Add single rule
Task RemoveChaosRule(string ruleId)           // Remove by ID
Task SetChaosRuleEnabled(string id, bool on) // Toggle
Task ClearAllChaosRules()                    // Panic button
Task<ChaosRule[]> GetChaosRules()            // Fetch current rules

// Backend → Frontend (events via "chaos" topic)
// Streamed via existing SubscribeToTopic("chaos") mechanism
```

New topic registered in `EdogTopicRouter.Initialize()`:
```csharp
RegisterTopic("chaos", 5000); // ChaosEvent ring buffer
```

### ChaosEvent (Published Per Rule Firing)

```csharp
// Published to "chaos" topic on every rule firing
new {
    ruleId,                    // Which rule fired
    ruleName,                  // Human-readable name
    action,                    // ChaosActionType
    phase,                     // "request" or "response"
    method,                    // HTTP method
    url,                       // Request URL (redacted)
    httpClientName,            // Named client
    statusCode,                // Response status (if response phase)
    durationMs,                // Time added by this rule
    modifications,             // Description of what changed
    timestamp                  // When it fired
}
```

---

## Part 2: The 30 Capabilities

Each capability maps to one or more `ChaosActionType` values and a specific `ActionConfig` schema.

---

### Category 1: REQUEST SURGERY

---

#### 1.1 Precision Latency Injection

**One-liner:** Delay outbound requests by an exact number of milliseconds before forwarding.

**The "Wow":** "I delayed every OneLake write by exactly 3 seconds and discovered FLT's DAG scheduler doesn't account for slow storage — it starves downstream nodes."

**How it works:** `ChaosActionType.Delay`. Before calling `base.SendAsync()`, the engine calls `await Task.Delay(delayMs, ct)`. The delay is configurable per-rule with URL/method filtering.

**Use case:** Test timeout handling, deadline propagation, Polly retry trigger thresholds. "Does FLT's 30-second Spark timeout actually fire at 30s, or does it silently hang?"

**ActionConfig schema:**
```json
{ "delayMs": 3000, "jitterMs": 500 }
```
Actual delay = `delayMs ± random(jitterMs)`.

**EDOG UI:** Slider (0–60s) with URL pattern input. Live counter shows "Delayed 47 requests, avg +3.2s."

**Difficulty:** Easy

---

#### 1.2 URL Rewriting

**One-liner:** Silently redirect requests to a different URL path, host, or query string.

**The "Wow":** "I rewrote `/lakehouseA/table1/` to `/lakehouseB/table1/` and FLT wrote to the wrong lakehouse. Silently. No validation, no error, no log. We just found a data corruption vector."

**How it works:** `ChaosActionType.RewriteUrl`. Regex replacement on `request.RequestUri`. Supports capture groups for surgical rewrites.

**Use case:** Test cross-lakehouse isolation, verify FLT validates workspace/artifact IDs in responses against what it requested. Test environment migration (route prod-like traffic to test endpoints).

**ActionConfig schema:**
```json
{
  "find": "/workspaces/([a-f0-9-]+)/lakehouses/([a-f0-9-]+)",
  "replace": "/workspaces/$1/lakehouses/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
}
```

**EDOG UI:** Find/replace fields with regex support. Live preview: "Would match 12 requests in last 5 minutes."

**Difficulty:** Easy

---

#### 1.3 Request Body Rewriting

**One-liner:** Intercept POST/PUT bodies and rewrite content before forwarding — SQL injection, JSON mutation, payload corruption.

**The "Wow":** "I rewrote the Spark SQL from `SELECT *` to `SELECT TOP 1` inside FLT's pipeline. FLT sent the modified SQL to Spark, got back 1 row, and its row-count validation passed anyway. The validator is checking `rows > 0`, not `rows == expected`."

**How it works:** `ChaosActionType.ModifyRequestBody`. Reads request body, applies regex or JSON-path mutations, creates new `StringContent` with modified body. Preserves original `Content-Type` and `Content-Length`.

**Use case:** Test SQL injection resilience in Spark transform submissions. Verify FLT validates transform payloads before sending. Test what happens when notebook content is corrupted mid-flight.

**ActionConfig schema:**
```json
{
  "mode": "regex",
  "find": "SELECT \\*",
  "replace": "SELECT TOP 1 *"
}
```
Or JSON-path mode:
```json
{
  "mode": "jsonpath",
  "path": "$.query",
  "value": "SELECT TOP 1 *"
}
```

**EDOG UI:** Side-by-side diff showing original vs. modified body. Syntax highlighting for SQL/JSON.

**Difficulty:** Medium

---

#### 1.4 Header Grafting

**One-liner:** Copy, inject, modify, or strip HTTP headers on outbound requests.

**The "Wow":** "I copied the S2S token from an OneLake request and injected it into a Fabric API call. The Fabric API accepted it. That's a cross-service auth isolation bug."

**How it works:** `ChaosActionType.ModifyRequestHeader`. Supports operations: `set` (add/replace), `remove`, `copy-from-last` (copies a header value from the last request matching a pattern).

**Use case:** Test that services reject tokens scoped for other audiences. Verify `x-ms-root-activity-id` propagation. Test Private Link by removing `x-ms-fabric-s2s-access-context`. Test what happens when `Content-Type` mismatches the body.

**ActionConfig schema:**
```json
{
  "operations": [
    { "op": "set", "header": "x-ms-test-header", "value": "chaos-injected" },
    { "op": "remove", "header": "x-ms-root-activity-id" },
    { "op": "set", "header": "Content-Type", "value": "application/xml" }
  ]
}
```

**EDOG UI:** Header editor table with add/remove/modify rows. Color-coded: green=added, red=removed, amber=modified.

**Difficulty:** Easy

---

#### 1.5 Request Blocking (Selective Blackhole)

**One-liner:** Drop matching requests entirely — return a canned error without ever calling the real service.

**The "Wow":** "I blocked all OneLake `/Tables/` calls but left `/Files/` working. FLT's table listing failed but file operations continued. I discovered that 4 components silently retry table listing failures, creating a retry storm of 200+ requests in 10 seconds."

**How it works:** `ChaosActionType.BlockRequest`. Returns a fabricated `HttpResponseMessage` without calling `base.SendAsync()`. Configurable status code, headers, and body.

**Use case:** Simulate service outages for individual dependencies. Test circuit breaker behavior. Verify graceful degradation when OneLake is down but Spark is up. Test what FLT does when catalog calls fail.

**ActionConfig schema:**
```json
{
  "statusCode": 503,
  "reasonPhrase": "Service Unavailable",
  "body": "{\"error\": \"chaos: service blocked by EDOG rule\"}",
  "headers": { "Retry-After": "30" }
}
```

**EDOG UI:** Toggle switch per service dependency. Shows blocked request count in real-time. Red flash on each blocked request.

**Difficulty:** Easy

---

#### 1.6 Request Redirect (Shadow Routing)

**One-liner:** Forward the request to a completely different host while preserving path, headers, and body.

**The "Wow":** "I redirected all Spark requests from production GTS to my local mock server. FLT ran a full DAG execution against fake Spark responses. Zero code changes, zero config changes."

**How it works:** `ChaosActionType.RedirectRequest`. Replaces `request.RequestUri` scheme+host+port while preserving path+query. Optionally preserves or strips auth headers.

**Use case:** Route traffic to mock services during development. A/B test different service versions. Redirect to a logging proxy for deep packet inspection.

**ActionConfig schema:**
```json
{
  "targetHost": "http://localhost:9999",
  "preservePath": true,
  "stripAuth": false
}
```

**EDOG UI:** Host redirect dropdown with preset targets (localhost:xxxx, staging, mock server). Shows redirected traffic volume.

**Difficulty:** Easy

---

### Category 2: RESPONSE FORGERY

---

#### 2.1 Status Code Flip

**One-liner:** Change the HTTP status code of a response before FLT sees it.

**The "Wow":** "I flipped a 200 to a 500 on every 10th Spark status-check response. FLT's retry logic kicked in and re-submitted the transform, creating duplicate work. The idempotency key wasn't being checked."

**How it works:** `ChaosActionType.ModifyResponseStatus`. Changes `response.StatusCode` after `base.SendAsync()` returns. Optionally modifies `ReasonPhrase`.

**Use case:** Test error handling paths that are hard to trigger naturally. Verify that FLT distinguishes between 429 (throttle) and 500 (server error) correctly. Test 401 → token refresh flow. Verify 404 handling for missing tables.

**ActionConfig schema:**
```json
{
  "fromStatus": 200,
  "toStatus": 500,
  "reasonPhrase": "Internal Server Error"
}
```

**EDOG UI:** Two dropdowns (from → to) with common status codes. Rate slider (every Nth request, or probability %).

**Difficulty:** Easy

---

#### 2.2 Response Body Mutation

**One-liner:** Surgically modify fields in JSON responses — change row counts, flip booleans, inject nulls, alter timestamps.

**The "Wow":** "I changed `rowCount: 1000` to `rowCount: 0` in OneLake's table metadata response. FLT saw an empty table, skipped the DAG execution entirely, and marked the iteration as 'succeeded with no work'. A customer with 1000 rows would see their materialized view go stale."

**How it works:** `ChaosActionType.ModifyResponseBody`. After `base.SendAsync()`, reads the response body, applies JSON-path mutations or regex replacements, creates a new `StringContent` with the modified body. Preserves `Content-Type`, recalculates `Content-Length`.

**Use case:** Test boundary conditions (zero rows, max int, null values, empty strings). Test schema evolution (add/remove/rename fields). Test deserialization robustness (wrong types, missing required fields). Verify FLT validates response data against expectations.

**ActionConfig schema:**
```json
{
  "mutations": [
    { "path": "$.rowCount", "value": 0 },
    { "path": "$.tables[0].name", "value": null },
    { "path": "$.status", "value": "UnknownNewStatus" }
  ]
}
```
Or regex mode:
```json
{
  "mode": "regex",
  "find": "\"rowCount\":\\s*\\d+",
  "replace": "\"rowCount\": 0"
}
```

**EDOG UI:** JSON tree editor showing the response structure. Click a field to set a mutation rule. Live diff preview.

**Difficulty:** Medium

---

#### 2.3 Response Forgery (Complete Fabrication)

**One-liner:** Return a completely fabricated response without calling the real service at all.

**The "Wow":** "I forged a Spark transform-status response showing `status: Succeeded` for a transform that hasn't run yet. FLT accepted it and moved to the next DAG node. The entire DAG completed 'successfully' without any Spark work being done."

**How it works:** `ChaosActionType.ForgeResponse`. Same as BlockRequest but with a richer response — full headers, JSON body, specific status code. The real service is never called.

**Use case:** Deterministic testing — return exact responses for exact requests. Simulate services that don't exist yet (mock a new API version). Test FLT behavior against specific error response formats.

**ActionConfig schema:**
```json
{
  "statusCode": 200,
  "headers": {
    "Content-Type": "application/json",
    "x-ms-request-id": "forged-by-edog"
  },
  "body": "{\"status\": \"Succeeded\", \"result\": {\"rowCount\": 42}}"
}
```

**EDOG UI:** Full response editor (status, headers, body) with JSON validation. "Forge from template" button loads the last real response for that URL as a starting point.

**Difficulty:** Easy

---

#### 2.4 Schema Evolution Simulator

**One-liner:** Automatically add unexpected fields, remove expected fields, or change field types in JSON responses to test deserialization robustness.

**The "Wow":** "I injected an unknown field `newFeatureFlag: true` into every Fabric API response. FLT's strict deserialization threw on 3 out of 7 response types. Those would break on the next Fabric API version bump."

**How it works:** `ChaosActionType.ModifyResponseBody` with a specialized `"mode": "schema-evolution"` config. Modes: `add-field` (inject random or specified fields), `remove-field` (strip fields by name or randomly), `change-type` (convert string→number, number→string, null→empty-string).

**Use case:** Proactively test forward compatibility. Catch strict deserialization before production API changes break FLT. Verify `[JsonExtensionData]` or lenient parsing is in place.

**ActionConfig schema:**
```json
{
  "mode": "schema-evolution",
  "mutations": [
    { "op": "add", "path": "$", "key": "unexpectedField", "value": true },
    { "op": "remove", "path": "$.metadata.etag" },
    { "op": "change-type", "path": "$.count", "to": "string" }
  ]
}
```

**EDOG UI:** "Schema Fuzzer" toggle with intensity slider (low = 1 mutation per response, high = 5). Live report: "Found 3 deserialization failures in 47 responses."

**Difficulty:** Medium

---

#### 2.5 Pagination Loop Injection

**One-liner:** Modify `nextLink` / continuation tokens in paginated responses to create infinite loops, skip pages, or reorder pages.

**The "Wow":** "I modified the `x-ms-continuation` header to loop back to page 1 after page 3. FLT entered an infinite pagination loop, consuming 100% CPU for 45 seconds before the cancellation token fired. The OneLake listing code has no cycle detection."

**How it works:** `ChaosActionType.ModifyResponseHeader` or `ModifyResponseBody` targeting continuation tokens. Modes: `loop` (point back to first page), `skip` (remove continuation token early), `corrupt` (invalid token value).

**Use case:** Test pagination termination logic. Verify FLT has max-page guards. Test behavior when continuation tokens are invalid or expired.

**ActionConfig schema:**
```json
{
  "mode": "pagination-loop",
  "target": "header:x-ms-continuation",
  "behavior": "loop-to-first",
  "afterPage": 3
}
```

**EDOG UI:** Pagination visualizer showing page sequence with injected loops highlighted. Counter: "Pages fetched: 47 (loop detected at page 4)."

**Difficulty:** Medium

---

#### 2.6 Response Delay (Precision Timing)

**One-liner:** Hold the response for exactly N milliseconds before returning it to FLT, simulating slow service responses.

**The "Wow":** "I added exactly 29.5 seconds of delay to Spark status-check responses. FLT's 30-second timeout fired 0.5 seconds later and cancelled the operation. But the cancellation handler had a bug — it didn't cancel the Spark transform, leaving an orphaned Spark session consuming cluster resources."

**How it works:** `ChaosActionType.DelayResponse`. After `base.SendAsync()` returns, `await Task.Delay(delayMs, ct)` before returning the response. The actual HTTP call completes normally — only the return to FLT is delayed.

**Use case:** Test timeout behavior with precision. Find the exact threshold where timeouts fire. Test cascading timeout behavior in DAG execution (node A delays → node B's deadline shrinks).

**ActionConfig schema:**
```json
{ "delayMs": 29500, "jitterMs": 0 }
```

**EDOG UI:** Precision slider (0–120s, 100ms increments). Histogram showing actual added latency distribution.

**Difficulty:** Easy

---

### Category 3: TRAFFIC CONTROL

---

#### 3.1 Bandwidth Throttle

**One-liner:** Trickle response bodies at a controlled byte rate, simulating slow networks or large payload transfers over constrained links.

**The "Wow":** "I throttled OneLake file reads to 1 KB/sec. FLT's `ReadFileAsStringAsync` timed out after 30 seconds on a 50KB file, but the timeout exception wasn't caught by the DAG scheduler — it propagated up and killed the entire iteration."

**How it works:** Custom `HttpContent` wrapper that overrides `SerializeToStreamAsync` to write the buffered response body in chunks with delays between them. The response status and headers arrive immediately; only the body transfer is throttled.

**Use case:** Simulate slow storage (OneLake under load), large response payloads, degraded network conditions. Test streaming response handling.

**ActionConfig schema:**
```json
{
  "bytesPerSecond": 1024,
  "chunkSize": 256
}
```

**EDOG UI:** Bandwidth slider (1 KB/s → 10 MB/s) with live throughput graph. Shows "Throttled 12 responses, avg transfer time +4.2s."

**Difficulty:** Hard

---

#### 3.2 Connection Failure Simulation

**One-liner:** Throw network-level exceptions (`HttpRequestException`, `TaskCanceledException`, `SocketException`) instead of returning a response.

**The "Wow":** "I simulated `SocketException: Connection refused` on 5% of OneLake calls. FLT's retry policy handled it — but then I simulated `TaskCanceledException` (not timeout-related) and discovered the retry policy treats ALL `TaskCanceledException` as timeouts, even user-initiated cancellations."

**How it works:** `ChaosActionType.DropResponse`. Instead of returning a response, throws a configurable exception type. This tests FLT's exception handling, not its HTTP status code handling — a fundamentally different code path.

**Use case:** Test network partition handling. Verify retry policies distinguish between timeout and cancellation. Test circuit breaker trip thresholds.

**ActionConfig schema:**
```json
{
  "exceptionType": "HttpRequestException",
  "message": "No connection could be made because the target machine actively refused it",
  "innerExceptionType": "SocketException"
}
```

**EDOG UI:** Exception type dropdown (HttpRequestException, TaskCanceledException, TimeoutException, SocketException, IOException). "Throw on N% of requests" slider.

**Difficulty:** Easy

---

#### 3.3 Rate Limiter (429/430 Injection)

**One-liner:** Inject HTTP 429 (Too Many Requests) or 430 (Capacity Throttling) responses at a configurable rate, with proper `Retry-After` headers.

**The "Wow":** "I injected 429 with `Retry-After: 60` on 30% of OneLake calls. FLT's retry policy respected the 60-second delay — but it was applied PER REQUEST, not per batch. A DAG with 50 nodes that each make 3 OneLake calls would take 50 × 3 × 60s = 2.5 hours to complete under this throttle scenario."

**How it works:** Combines `ChaosActionType.BlockRequest` with 429/430 status codes and `Retry-After` header. Configurable injection rate. Can simulate both OneLake-style 429 (with Retry-After) and Capacity-style 430 (with admission window delays).

**Use case:** Test retry policy behavior at scale. Verify Polly configuration matches FLT's `RetryPoliciesConfiguration`. Test exponential backoff. Verify `Retry-After` header is respected. Test capacity admission window delays (`20,40,60,90,90,90`).

**ActionConfig schema:**
```json
{
  "statusCode": 429,
  "retryAfterSeconds": 60,
  "headers": {
    "x-ms-ratelimit-remaining-subscription-reads": "0"
  }
}
```

**EDOG UI:** Preset buttons: "OneLake Throttle (429)", "Capacity Throttle (430)", "Custom". Rate control slider (0–100% of matching requests).

**Difficulty:** Easy

---

#### 3.4 Request Cloning (Shadow Traffic)

**One-liner:** Forward every matching request to BOTH the real service AND a shadow service. Compare responses. The shadow result is discarded — FLT only sees the real response.

**The "Wow":** "I cloned all Spark submit requests to our canary GTS endpoint. The canary returned different row counts on 3 out of 200 transforms. We caught a regression in the canary build before it hit production."

**How it works:** `ChaosActionType.DuplicateRequest`. Clones the `HttpRequestMessage` (deep copy of headers, body, URI). Fires `base.SendAsync()` for the real request and sends the clone to the shadow endpoint in parallel. Shadow response is captured and published to the `"chaos"` topic for comparison but never returned to FLT.

**Use case:** Shadow traffic testing against new service versions. Regression detection between environments. Load testing a canary without risking production traffic.

**ActionConfig schema:**
```json
{
  "shadowHost": "https://canary-gts.internal:443",
  "compareResponses": true,
  "captureBodyDiff": true,
  "timeout": 30000
}
```

**EDOG UI:** Shadow traffic panel showing side-by-side: real response vs. shadow response. Diff highlighting for body differences. Summary: "3/200 responses diverged."

**Difficulty:** Hard

---

#### 3.5 Response Caching (Offline Mode)

**One-liner:** Cache responses and serve them for identical subsequent requests. Turn external dependencies into deterministic mocks. Enable "offline development" — work on FLT code without any external services running.

**The "Wow":** "I ran a full DAG execution with caching enabled. Every request/response was captured. Then I disconnected from the network, enabled cache playback, and ran the same DAG. It completed identically — using cached responses. I can now develop DAG scheduler logic on an airplane."

**How it works:** `ChaosActionType.CacheResponse`. Computes a cache key from `{method}:{url}:{body-hash}`. On first request, forwards to real service and caches the response (status, headers, body). On subsequent matching requests, returns the cached response without calling the real service. Cache is stored in memory with optional file persistence.

**Use case:** Offline development. Deterministic test environments. Eliminating flaky tests caused by external service variability. Speeding up development iteration — cached responses return in <1ms vs. 50-500ms for real calls.

**ActionConfig schema:**
```json
{
  "keyStrategy": "method+url+bodyHash",
  "maxEntries": 10000,
  "ttlSeconds": 3600,
  "persistToFile": "chaos-cache-session-1.json"
}
```

**EDOG UI:** Cache panel showing hit/miss ratio, cached entries list (URL, age, hit count). "Save Session" / "Load Session" buttons for sharing cache snapshots between developers.

**Difficulty:** Hard

---

### Category 4: SECURITY PROBING

---

#### 4.1 Token Downgrade Attack

**One-liner:** Replace a strong auth token (MWC/S2S) with a weaker one (Bearer) or strip auth entirely, and see if the target service accepts the request.

**The "Wow":** "I replaced the S2S token on OneLake calls with the user's Bearer token. OneLake accepted it and returned data. That means a compromised user token can access OneLake directly, bypassing the S2S trust boundary."

**How it works:** `ChaosActionType.ModifyRequestHeader` targeting the `Authorization` and `x-ms-s2s-actor-authorization` headers. Modes: `downgrade` (replace S2S with Bearer), `strip` (remove auth entirely), `swap` (swap two tokens between requests).

**Use case:** Test that services enforce proper token scoping. Verify that S2S tokens are required where expected. Build an access matrix showing which tokens each endpoint accepts.

**ActionConfig schema:**
```json
{
  "operations": [
    { "op": "remove", "header": "x-ms-s2s-actor-authorization" },
    { "op": "set", "header": "Authorization", "value": "Bearer {{captured:last-bearer}}" }
  ]
}
```

**EDOG UI:** "Security Probe" panel with preset attack profiles. Results matrix: endpoint × token-type → accepted/rejected.

**Difficulty:** Medium

---

#### 4.2 Scope Probing (Access Matrix Builder)

**One-liner:** Systematically test every combination of token type × endpoint to automatically build a complete service access matrix.

**The "Wow":** "I ran the scope prober overnight. It tested 6 token types against 23 endpoints (138 combinations). The resulting matrix showed that 4 endpoints accept tokens they shouldn't — cross-service auth violations that have existed since launch."

**How it works:** Automated rule generation. For each discovered endpoint (from HTTP traffic), generates temporary rules that swap auth tokens and records whether each combination returns 200/401/403. Results are aggregated into a matrix and published to the UI.

**Use case:** Security audit automation. Regression testing after auth changes. Onboarding new engineers with a visual map of FLT's auth landscape.

**ActionConfig schema:**
```json
{
  "mode": "auto-probe",
  "tokenTypes": ["bearer", "s2s-onelake", "s2s-gts", "mwc-v1", "none", "expired"],
  "endpointDiscovery": "from-traffic",
  "concurrency": 1,
  "delayBetweenProbesMs": 500
}
```

**EDOG UI:** Heatmap matrix (endpoints × token types). Green = expected accept, Red = unexpected accept (security finding), Gray = expected reject. Export as CSV.

**Difficulty:** Hard

---

#### 4.3 TLS Certificate Probe

**One-liner:** Test whether FLT validates TLS certificates on its outbound connections by observing existing behavior patterns.

**The "Wow":** "The probe confirmed that `DatalakeDirectoryClient` has `ServerCertificateCustomValidationCallback = (msg, cert, chain, err) => true` — it accepts ANY certificate. If that client is ever used outside test environments, it's a MITM vulnerability."

**How it works:** Read-only analysis. Inspects the `HttpClientHandler` configuration for each named client via reflection. Reports which clients have certificate validation disabled. Does NOT modify TLS behavior — just exposes what's already there.

**Use case:** Security posture assessment. Verify that production-path clients have proper cert validation. Flag any client with `ServerCertificateCustomValidationCallback` that returns `true` unconditionally.

**ActionConfig schema:** Not rule-based — this is a one-shot diagnostic command triggered from the UI.

**EDOG UI:** "TLS Audit" button in the Security panel. Results table: client name → cert validation status → severity rating.

**Difficulty:** Easy

---

#### 4.4 Auth Header Leak Detector

**One-liner:** Monitor all outbound requests and flag any case where auth tokens are sent to unexpected destinations, leaked in query strings, or included in non-HTTPS requests.

**The "Wow":** "The leak detector found that during Notebook content retry, the OBO token was being logged in the retry exception message. `Tracer.LogSanitizedMessage` wasn't sanitizing the `Authorization` header value from the exception's HTTP response."

**How it works:** Passive analysis rule. On every request, checks: (1) auth headers present on non-HTTPS URLs, (2) tokens in query parameters, (3) auth headers sent to hostnames not in the allowlist, (4) tokens that appear in log messages (cross-references with "log" topic).

**Use case:** Continuous security monitoring. Detect token leaks in error messages, query strings, or redirects. Verify that EDOG's own token redaction is working.

**ActionConfig schema:**
```json
{
  "mode": "passive-monitor",
  "allowedHosts": ["*.fabric.microsoft.com", "*.onelake.dfs.*", "*.pbidedicated.windows-int.net"],
  "alertOnQueryStringTokens": true,
  "alertOnNonHttps": true,
  "crossReferenceLogTopic": true
}
```

**EDOG UI:** Security alerts panel. Red badges for critical findings (token leak). Feed of all auth events with risk classification.

**Difficulty:** Medium

---

### Category 5: OBSERVABILITY & RECORDING

---

#### 5.1 Full Traffic Recording (HAR Export)

**One-liner:** Record every HTTP request/response with full headers, body, and timing. Export as standard HAR (HTTP Archive) format for analysis in Chrome DevTools, Fiddler, or Charles.

**The "Wow":** "A DAG execution failed mysteriously. I enabled recording, reproduced it, exported the HAR file, and saw the exact sequence: OneLake returned 200 but with a stale ETag, Spark used the stale data, and the transform produced wrong results. A 3-hour debug session reduced to reading a HAR file."

**How it works:** `ChaosActionType.RecordTraffic`. Captures full request (method, URL, all headers, body) and full response (status, all headers, body) with precise timing. Stores in an in-memory ring buffer (configurable max entries). Exports to HAR 1.2 format.

**Use case:** Post-mortem analysis. Sharing reproduction steps (attach HAR to bug report). Comparing traffic before/after a code change. Training new engineers ("here's what a DAG execution looks like at the HTTP level").

**ActionConfig schema:**
```json
{
  "sessionName": "dag-debug-2026-07-14",
  "captureRequestBody": true,
  "captureResponseBody": true,
  "maxBodySize": 1048576,
  "maxEntries": 50000
}
```

**EDOG UI:** Record button (red dot) in the toolbar. Session list panel. "Export HAR" button. "Import HAR" for replay.

**Difficulty:** Medium

---

#### 5.2 Traffic Diff Mode

**One-liner:** Record a baseline traffic session, make a code change, record again, and diff the two sessions — show exactly what HTTP calls were added, removed, or changed.

**The "Wow":** "I recorded baseline traffic for a DAG execution, then applied my OneLake batching optimization. The diff showed: 47 OneLake calls reduced to 12, 3 new batch-list calls added, total latency down 62%. My PR review included this diff as proof."

**How it works:** Two recording sessions compared via matching algorithm. Matches requests by `{method}:{url-pattern}:{body-hash}`. Reports: new calls (in B but not A), removed calls (in A but not B), changed calls (same URL but different body/response), timing changes (latency delta).

**Use case:** Code change impact analysis. Performance regression detection. PR evidence ("my change reduces OneLake calls by 40%"). Verifying that a refactor doesn't change external behavior.

**ActionConfig schema:**
```json
{
  "baselineSession": "before-optimization",
  "compareSession": "after-optimization",
  "matchBy": "method+urlPattern+bodyHash",
  "ignoreHeaders": ["x-ms-request-id", "x-ms-correlation-id", "Date"]
}
```

**EDOG UI:** Side-by-side timeline. Green = new calls, Red = removed calls, Amber = changed calls. Summary stats at top: "+3 calls, -35 calls, 12 changed, -62% total latency."

**Difficulty:** Hard

---

#### 5.3 Dependency Graph Builder

**One-liner:** From intercepted traffic, automatically build a visual directed graph of all external services FLT communicates with, showing call frequency, average latency, error rate, and dependency chains.

**The "Wow":** "I ran a DAG execution and the dependency graph showed a surprise: FLT makes 3 calls to the Notebook service during table maintenance — nobody on the team knew about that dependency. It was added in a PR 6 months ago and never documented."

**How it works:** Passive analysis. Groups traffic by target host/service, computes statistics (call count, P50/P95/P99 latency, error rate, request size). Builds edges showing which FLT component calls which service (inferred from `httpClientName` + URL patterns). Outputs as a directed graph with edge weights.

**Use case:** Architecture documentation. Dependency discovery. Capacity planning ("OneLake gets 80% of our traffic"). Identifying unexpected dependencies. Latency budget analysis.

**ActionConfig schema:** Not rule-based — passive analysis of the "http" topic stream.

**EDOG UI:** Force-directed graph visualization. Nodes = services (sized by call volume). Edges = call relationships (colored by error rate: green→amber→red). Click a node to see detailed stats. Click an edge to see the specific requests.

**Difficulty:** Medium (backend), Hard (frontend visualization)

---

#### 5.4 Regression Detector (Traffic Pattern Baseline)

**One-liner:** Save a traffic pattern baseline, then continuously compare live traffic against it. Alert when patterns deviate beyond thresholds.

**The "Wow":** "I saved a baseline for 'normal DAG execution'. After a teammate's PR, the regression detector flagged: '40% more OneLake writes than baseline, new endpoint /metastore/v2/tables never seen before.' The PR accidentally switched from the cached catalog path to a direct metastore call."

**How it works:** Baseline is a statistical profile: {endpoint → expected call count range, expected latency range, expected error rate}. Live traffic is continuously compared. Deviations beyond configurable thresholds generate alerts on the "chaos" topic.

**Use case:** Catch performance regressions before they reach PR review. Verify that refactors don't change external behavior. Monitor for unexpected new dependencies.

**ActionConfig schema:**
```json
{
  "baselineProfile": "dag-execution-normal",
  "thresholds": {
    "callCountDeviation": 0.2,
    "latencyDeviationMs": 500,
    "newEndpointAlert": true,
    "missingEndpointAlert": true
  }
}
```

**EDOG UI:** Dashboard with baseline comparison. Green/amber/red indicators per endpoint. Alert feed when deviations detected.

**Difficulty:** Medium

---

#### 5.5 Traffic Heatmap

**One-liner:** Real-time visualization of all HTTP traffic as a heatmap — time on X-axis, endpoints on Y-axis, color intensity = request volume or latency.

**The "Wow":** "The heatmap showed a clear pattern: every 30 seconds, there's a burst of 20+ OneLake calls — that's the polling loop. But between bursts, there are 2-3 random OneLake calls from the catalog handler that we didn't know about."

**How it works:** Passive aggregation of the "http" topic. Bucketed by time window (configurable: 1s, 5s, 30s). Y-axis groups by hostname, URL path prefix, or httpClientName. Color encoding: blue (low) → yellow (medium) → red (high) for either volume or latency.

**Use case:** Spot traffic patterns. Identify polling loops, burst behavior, quiet periods. Visualize the impact of code changes on traffic distribution. Detect unexpected background traffic.

**ActionConfig schema:** Not rule-based — UI visualization config.

**EDOG UI:** Canvas-based heatmap. Time scrubber. Toggle between volume/latency/error coloring. Zoom to inspect individual cells.

**Difficulty:** Medium (backend aggregation), Hard (frontend heatmap)

---

### Category 6: ADVANCED CAPABILITIES

---

#### 6.1 Chaos Scripting DSL

**One-liner:** A mini domain-specific language where engineers write human-readable chaos rules that compile to `ChaosRule` objects.

**The "Wow":** "Instead of clicking through UI forms, I typed: `WHEN url ~ /spark/ AND method == POST THEN delay 5s AND set status 429 FOR 30%` — and it just worked. I can share chaos scripts in our team Slack."

**How it works:** Text parser that compiles a simple DSL to `ChaosRule[]`. Syntax designed for readability:

```
WHEN <predicate> [AND <predicate>...] THEN <action> [AND <action>...] [FOR <probability>%]
```

Predicates:
```
url ~ /regex/           URL regex match
url CONTAINS "string"   URL substring match
method == GET           HTTP method filter
client == "OneLake"     Named client filter
header "X-Name" ~ /re/  Header value match
status == 429           Response status (response-phase)
```

Actions:
```
delay <N>s|ms           Delay request or response
set status <code>       Change response status
set header "X" = "V"    Set header
remove header "X"       Remove header
block                   Return canned 503
block with <code>       Return canned response
replace body /find/rep/ Regex body replacement
forge response <json>   Return fabricated response
record                  Start recording
```

**Use case:** Rapid experimentation. Shareable chaos configurations. Reproducible chaos scenarios for bug reports. "Run this script to reproduce issue #4521."

**ActionConfig schema:** The DSL compiles to standard `ChaosRule[]` — no special engine support needed.

**EDOG UI:** Text editor panel with syntax highlighting and auto-complete. "Compile & Apply" button. Error highlighting for invalid rules. "Share" button copies rule text to clipboard.

**Difficulty:** Hard (parser), Easy (execution — it's just rules)

---

#### 6.2 Time Machine (Traffic Replay)

**One-liner:** Record all traffic during a session, then "rewind and replay" — send the same requests against the current codebase to test whether a code change fixes (or breaks) the recorded behavior.

**The "Wow":** "A customer reported a DAG failure. I recorded the exact traffic sequence from their session. Then I applied my fix, replayed the traffic, and confirmed: same requests, different outcome — the fix works. No manual reproduction needed."

**How it works:** Uses recorded traffic sessions (from capability 5.1). Replays requests in order, with original timing preserved (or compressed). Compares new responses against recorded responses. Reports: same/different status, body diff, latency delta.

**Use case:** Regression testing with real traffic. Fix verification without manual reproduction. Performance benchmarking (replay same traffic, compare timing).

**ActionConfig schema:**
```json
{
  "sessionName": "customer-failure-2026-07-10",
  "replaySpeed": 1.0,
  "compareResponses": true,
  "stopOnDivergence": false
}
```

**EDOG UI:** Timeline scrubber showing recorded requests. "Play" / "Pause" / "Step" buttons. Side-by-side comparison: recorded response vs. current response. Divergence markers on timeline.

**Difficulty:** Hard

---

#### 6.3 A/B Traffic Splitting

**One-liner:** Route a percentage of matching requests to an alternate endpoint and compare responses, enabling live A/B testing of service versions.

**The "Wow":** "We're testing a new OneLake endpoint. I set 20% of OneLake reads to go to the new endpoint. After 500 requests, the comparison showed: new endpoint is 15% faster on average but returns different ETag formats. We caught the ETag incompatibility before rollout."

**How it works:** Combination of `ChaosActionType.RedirectRequest` with probability control. For each matching request, randomly routes to endpoint A (original) or endpoint B (alternate) based on configured split ratio. Both responses are captured for comparison.

**Use case:** Service version migration testing. Performance comparison between endpoints. Gradual traffic shifting during migrations.

**ActionConfig schema:**
```json
{
  "splitRatio": 0.2,
  "alternateHost": "https://new-onelake-endpoint.fabric.microsoft.com",
  "compareResponses": true,
  "reportDifferences": true
}
```

**EDOG UI:** Split ratio slider (0–100%). Side-by-side stats: latency, error rate, response size. Divergence alerts.

**Difficulty:** Medium

---

#### 6.4 Idempotency Tester

**One-liner:** Automatically replay recent requests and verify that repeated calls produce identical results, testing service idempotency guarantees.

**The "Wow":** "I replayed 50 Spark transform-submit requests. 48 returned the same result. 2 returned different `transformationId` values — the Spark submit endpoint is NOT idempotent for transforms with dynamic parameters. We've been silently creating duplicate Spark jobs on every retry."

**How it works:** Captures recent requests matching a pattern, then replays them (with configurable delay between replays). Compares: response status code, key response body fields, side effects (check via follow-up GET requests). Reports discrepancies.

**Use case:** Verify that retry-able endpoints are actually idempotent. Test write operations for duplicate detection. Verify that cancellation + resubmit produces correct results.

**ActionConfig schema:**
```json
{
  "replayCount": 3,
  "delayBetweenReplaysMs": 1000,
  "compareFields": ["statusCode", "$.transformationId", "$.status"],
  "ignoreFields": ["$.timestamp", "$.requestId"]
}
```

**EDOG UI:** "Test Idempotency" button on any captured request. Results: "Replayed 3 times. Results: identical/diverged." Diff view for divergent responses.

**Difficulty:** Medium

---

#### 6.5 Cascading Failure Simulator

**One-liner:** Define a failure cascade scenario: "When OneLake fails, after 10 seconds Spark starts failing too, after 30 seconds Fabric API degrades." Test FLT's behavior under correlated multi-service outages.

**The "Wow":** "I simulated the 2026-03-15 production incident: OneLake 503 → 10s delay → Spark 429 → 30s delay → Fabric API timeout. FLT's behavior under cascade exactly matched the incident timeline. Now we can test our fix against the exact failure pattern."

**How it works:** A `CascadeScenario` is a timed sequence of rule activations. Each step enables/disables rules at specific timestamps. The engine runs a timer that activates/deactivates rules per the scenario timeline.

**ActionConfig schema:**
```json
{
  "scenario": "production-incident-2026-03-15",
  "steps": [
    { "atSeconds": 0, "enableRules": ["onelake-503"] },
    { "atSeconds": 10, "enableRules": ["spark-429"] },
    { "atSeconds": 30, "enableRules": ["fabric-timeout"] },
    { "atSeconds": 120, "disableRules": ["onelake-503", "spark-429", "fabric-timeout"] }
  ]
}
```

**EDOG UI:** Timeline editor where you drag-and-drop failure events onto a time axis. Play/pause/speed controls. Live view of which services are currently "failing."

**Difficulty:** Medium (engine), Hard (frontend timeline editor)

---

#### 6.6 Response Corruption (Bit-Flip Fuzzer)

**One-liner:** Randomly corrupt response bodies at the byte level — flip bits, truncate, insert garbage — to test FLT's data integrity validation.

**The "Wow":** "The fuzzer truncated a JSON response mid-object. FLT's deserializer threw `JsonException`, but the exception handler was catching `Exception` (not `JsonException`) and treating it as a transient error — retrying the same corrupt response in a loop."

**How it works:** `ChaosActionType.ModifyResponseBody` with a fuzzing mode. After `base.SendAsync()`, applies random corruption to the response body bytes. Modes: `bit-flip` (flip random bits), `truncate` (cut response short), `inject-garbage` (insert random bytes), `swap-bytes` (swap random byte pairs).

**Use case:** Test deserialization error handling. Verify data integrity checks (checksums, schema validation). Test graceful degradation under data corruption. Find exception handling bugs.

**ActionConfig schema:**
```json
{
  "mode": "truncate",
  "truncateAt": 0.5,
  "probability": 0.05
}
```

**EDOG UI:** Fuzzer intensity slider. Mode selector (bit-flip, truncate, garbage, swap). Live corruption event feed. "Bugs found" counter.

**Difficulty:** Easy

---

#### 6.7 Latency Budget Analyzer

**One-liner:** Passively analyze traffic to compute a latency budget breakdown — how much time FLT spends waiting on each external service, and where the bottlenecks are.

**The "Wow":** "The analyzer showed: of a 45-second DAG execution, 31 seconds (69%) was waiting on Spark, 8 seconds (18%) on OneLake, 4 seconds (9%) on catalog, and 2 seconds (4%) was FLT processing. The Spark P99 latency was 12 seconds — that's our bottleneck."

**How it works:** Passive analysis of the "http" topic. Groups requests by service, computes P50/P95/P99 latency per service, calculates cumulative wait time per execution (using correlation/activity IDs to group related requests). Identifies critical path.

**Use case:** Performance optimization prioritization. Capacity planning. SLA analysis. Identifying which service to optimize first for maximum impact.

**ActionConfig schema:** Not rule-based — passive analysis.

**EDOG UI:** Waterfall chart showing request timeline. Stacked bar chart: time spent per service. P50/P95/P99 table. "Which service should I optimize?" recommendation.

**Difficulty:** Medium

---

#### 6.8 Retry Storm Detector

**One-liner:** Detect and alert when retry behavior creates amplification — a single failure cascading into dozens or hundreds of retry requests.

**The "Wow":** "The detector caught it: one OneLake 503 triggered 3 retries from the OneLake client, each of which triggered 3 retries from the DAG scheduler, each of which triggered 2 retries from the catalog handler. One failure → 18 requests in 5 seconds. That's a 18x amplification factor."

**How it works:** Passive analysis combining "http" and "retry" topics. Detects: (1) request count spikes following errors, (2) exponential growth patterns in request volume, (3) retry attempts that themselves generate retries (amplification chains). Computes amplification factor.

**Use case:** Detect retry storms before they cause cascading outages. Verify that retry policies have proper jitter and backoff. Identify missing circuit breakers.

**ActionConfig schema:**
```json
{
  "mode": "passive-detect",
  "amplificationThreshold": 5,
  "windowSeconds": 10,
  "alertOnDetection": true
}
```

**EDOG UI:** Amplification gauge (1x = healthy, 5x = warning, 10x+ = critical). Timeline showing retry cascade tree. Alert notification when storm detected.

**Difficulty:** Medium

---

#### 6.9 Preset Chaos Scenarios

**One-liner:** One-click activation of pre-built chaos scenarios that model real-world failure patterns from FLT production incidents.

**The "Wow":** "I clicked 'Simulate Azure West US 2 Outage' and watched FLT try to handle it. The preset injected: OneLake regional → 503, OneLake global → 200 (failover), Spark → 430 (capacity throttle). FLT handled OneLake failover but crashed on the Spark throttle because `CapacityAdmissionWindowDelaysInSeconds` was misconfigured in dev."

**How it works:** Pre-built rule sets stored as JSON templates. Each scenario activates multiple rules simultaneously with coordinated timing. Scenarios derived from real production incidents and known failure modes.

**Built-in scenarios:**
- **OneLake Regional Outage**: Regional DFS returns 503, global endpoint works (tests failover via `FLTUseOneLakeRegionalEndpoint`)
- **Spark Capacity Exhaustion**: All Spark submits return 430 with admission window delays
- **Token Expiry Storm**: All tokens expire simultaneously (inject 401 on all authenticated calls)
- **Slow OneLake**: OneLake latency 10x normal (tests timeout cascading)
- **Catalog Unavailable**: Metastore returns 500 (tests table listing degradation)
- **Network Partition**: Random 50% of all requests fail with `SocketException`
- **Thursday Afternoon** (realistic load): 20% 429 on OneLake, 5% 430 on Spark, 2% timeout on Fabric API

**EDOG UI:** Scenario gallery with cards. Click to preview (shows which rules will be activated). "Activate" button. "Stop All Chaos" emergency button.

**Difficulty:** Easy (once the rule engine exists)

---

#### 6.10 Request Waterfall Timeline

**One-liner:** For a single FLT operation (e.g., one DAG node execution), show every HTTP request in a Chrome-DevTools-style waterfall timeline — with DNS, connect, TLS, request, and response phases.

**The "Wow":** "I clicked on a slow DAG node and saw the waterfall: 12 HTTP calls, 3 of them sequential when they could be parallel, and one OneLake call took 8 seconds because it was waiting for a Semaphore (MaxConcurrentOneLakeCatalogCalls). The optimization was obvious."

**How it works:** Groups HTTP events by correlation ID / activity ID. For each request, captures: queue time (time between FLT sending and handler receiving), total duration, and inter-request gaps. Renders as a Gantt-style waterfall chart.

**Use case:** Identify serialization bottlenecks (sequential calls that could be parallel). Find slow individual requests. Understand the request pattern for specific FLT operations. Compare waterfalls before/after optimization.

**ActionConfig schema:** Not rule-based — visualization of "http" topic data.

**EDOG UI:** Waterfall chart (rows = requests, X-axis = time). Color-coded by service. Hover for details. Click to inspect full request/response. Group by correlation ID.

**Difficulty:** Medium (backend grouping), Hard (frontend waterfall chart)

---

## Part 3: Architecture Integration

### Modified Files

| File | Change | Owner |
|---|---|---|
| `EdogHttpPipelineHandler.cs` | Add ChaosRule evaluation to `SendAsync()` | Vex |
| `EdogTopicRouter.cs` | Register `"chaos"` topic buffer | Vex |
| `EdogPlaygroundHub.cs` | Add SignalR methods for rule CRUD | Vex |
| `EdogDevModeRegistrar.cs` | Initialize `ChaosRuleStore` | Vex |
| New: `ChaosRule.cs` | Rule data model | Vex |
| New: `ChaosRuleStore.cs` | Thread-safe rule storage | Vex |
| New: `ChaosEngine.cs` | Rule evaluation + action execution | Vex |
| New: `ChaosRecorder.cs` | Traffic recording + HAR export | Vex |
| New: `ChaosDsl.cs` | DSL parser (capability 6.1) | Vex |
| New: `js/chaos-panel.js` | Frontend chaos panel | Pixel |
| New: `css/chaos-panel.css` | Chaos panel styles | Pixel |

### New C# Files in `src/backend/DevMode/`

```
EdogHttpPipelineHandler.cs  ← Modified (add rule evaluation)
ChaosRule.cs                ← New (data model)
ChaosRuleStore.cs           ← New (thread-safe store)
ChaosEngine.cs              ← New (evaluation + actions)
ChaosRecorder.cs            ← New (recording + HAR)
ChaosDsl.cs                 ← New (DSL parser)
```

### Safety Mechanisms

1. **Kill Switch**: `ChaosRuleStore.ClearAll()` — one SignalR call disables everything
2. **Zero-Rule Fast Path**: When no rules are active, the handler has zero overhead
3. **Never-Throw Guarantee**: All chaos rule evaluation is wrapped in try/catch — a buggy rule never crashes FLT
4. **Max Firings**: Every rule has an optional max firing count to prevent runaway rules
5. **Rate Limiting**: Per-rule rate limiter prevents accidental DDoS of external services
6. **Auto-Disable on Error**: If a rule's action throws 3 times, the rule is auto-disabled
7. **Session Scoping**: Rules are in-memory only — restarting FLT clears all chaos rules
8. **Audit Trail**: Every rule firing publishes to the "chaos" topic — full accountability

### Implementation Priority

| Phase | Capabilities | Rationale |
|---|---|---|
| **Phase 1: Core Engine** | Rule model, store, evaluation, SignalR CRUD | Foundation for everything |
| **Phase 2: Essential Actions** | 1.1 (Delay), 1.5 (Block), 2.1 (Status Flip), 2.6 (Response Delay), 3.2 (Connection Failure), 3.3 (Rate Limiter) | Cover 80% of chaos testing needs |
| **Phase 3: Surgery** | 1.2 (URL Rewrite), 1.3 (Body Rewrite), 1.4 (Header Graft), 2.2 (Body Mutation), 2.3 (Forge Response) | Deep request/response manipulation |
| **Phase 4: Recording** | 5.1 (HAR Recording), 5.3 (Dependency Graph), 5.5 (Heatmap), 6.10 (Waterfall) | Observability and analysis |
| **Phase 5: Advanced** | 3.4 (Shadow Traffic), 3.5 (Offline Cache), 5.2 (Traffic Diff), 6.2 (Time Machine), 6.5 (Cascade Simulator) | Power-user features |
| **Phase 6: Security** | 4.1 (Token Downgrade), 4.2 (Scope Prober), 4.3 (TLS Audit), 4.4 (Leak Detector) | Security audit tools |
| **Phase 7: DSL & Presets** | 6.1 (Chaos DSL), 6.9 (Preset Scenarios), 2.4 (Schema Fuzzer), 6.6 (Bit-Flip Fuzzer) | Automation and ease-of-use |
| **Phase 8: Analytics** | 5.4 (Regression Detector), 6.3 (A/B Split), 6.4 (Idempotency Tester), 6.7 (Latency Budget), 6.8 (Retry Storm Detector) | Deep analysis |

---

## Appendix A: Capability Summary Table

| # | Category | Capability | Action Type | Difficulty | Phase |
|---|---|---|---|---|---|
| 1.1 | Request Surgery | Precision Latency Injection | Delay | Easy | 2 |
| 1.2 | Request Surgery | URL Rewriting | RewriteUrl | Easy | 3 |
| 1.3 | Request Surgery | Request Body Rewriting | ModifyRequestBody | Medium | 3 |
| 1.4 | Request Surgery | Header Grafting | ModifyRequestHeader | Easy | 3 |
| 1.5 | Request Surgery | Request Blocking (Blackhole) | BlockRequest | Easy | 2 |
| 1.6 | Request Surgery | Request Redirect | RedirectRequest | Easy | 3 |
| 2.1 | Response Forgery | Status Code Flip | ModifyResponseStatus | Easy | 2 |
| 2.2 | Response Forgery | Response Body Mutation | ModifyResponseBody | Medium | 3 |
| 2.3 | Response Forgery | Response Forgery (Complete) | ForgeResponse | Easy | 3 |
| 2.4 | Response Forgery | Schema Evolution Simulator | ModifyResponseBody | Medium | 7 |
| 2.5 | Response Forgery | Pagination Loop Injection | ModifyResponseHeader | Medium | 3 |
| 2.6 | Response Forgery | Response Delay | DelayResponse | Easy | 2 |
| 3.1 | Traffic Control | Bandwidth Throttle | ThrottleBandwidth | Hard | 5 |
| 3.2 | Traffic Control | Connection Failure Simulation | DropResponse | Easy | 2 |
| 3.3 | Traffic Control | Rate Limiter (429/430) | BlockRequest | Easy | 2 |
| 3.4 | Traffic Control | Request Cloning (Shadow) | DuplicateRequest | Hard | 5 |
| 3.5 | Traffic Control | Response Caching (Offline) | CacheResponse | Hard | 5 |
| 4.1 | Security Probing | Token Downgrade Attack | ModifyRequestHeader | Medium | 6 |
| 4.2 | Security Probing | Scope Probing (Access Matrix) | Multiple | Hard | 6 |
| 4.3 | Security Probing | TLS Certificate Probe | Diagnostic | Easy | 6 |
| 4.4 | Security Probing | Auth Header Leak Detector | Passive Monitor | Medium | 6 |
| 5.1 | Observability | Full Traffic Recording (HAR) | RecordTraffic | Medium | 4 |
| 5.2 | Observability | Traffic Diff Mode | Analysis | Hard | 5 |
| 5.3 | Observability | Dependency Graph Builder | Passive Analysis | Medium | 4 |
| 5.4 | Observability | Regression Detector | Passive Analysis | Medium | 8 |
| 5.5 | Observability | Traffic Heatmap | Passive Analysis | Medium | 4 |
| 6.1 | Advanced | Chaos Scripting DSL | Multiple | Hard | 7 |
| 6.2 | Advanced | Time Machine (Replay) | Multiple | Hard | 5 |
| 6.3 | Advanced | A/B Traffic Splitting | RedirectRequest | Medium | 8 |
| 6.4 | Advanced | Idempotency Tester | Multiple | Medium | 8 |
| 6.5 | Advanced | Cascading Failure Simulator | Multiple | Medium | 5 |
| 6.6 | Advanced | Response Corruption Fuzzer | ModifyResponseBody | Easy | 7 |
| 6.7 | Advanced | Latency Budget Analyzer | Passive Analysis | Medium | 8 |
| 6.8 | Advanced | Retry Storm Detector | Passive Analysis | Medium | 8 |
| 6.9 | Advanced | Preset Chaos Scenarios | Multiple | Easy | 7 |
| 6.10 | Advanced | Request Waterfall Timeline | Visualization | Medium | 4 |

**Total: 35 capabilities across 6 categories.**

---

## Appendix B: Services Intercepted

For reference — every external dependency that flows through the MITM engine:

| Service | Named Client | Endpoint Pattern | Auth | Retry Policy |
|---|---|---|---|---|
| OneLake REST | `OneLakeRestClient` | `*.onelake.dfs.*/` | S2S + Bearer | Polly 429/5xx |
| OneLake DFS (SDK) | `DatalakeDirectoryClient` | `*.dfs.fabric.microsoft.com/` | S2S + AAD | SDK built-in |
| GTS / Spark | WCL `Get1PWorkloadHttpClient` | `*.pbidedicated.windows-int.net/*/customTransformExecution/*` | MWC V1 + S2S | Polly (custom) |
| Fabric Public API | `FabricApiClient` | `api.fabric.microsoft.com/v1/*` | Bearer + S2S | None |
| PBI Shared | `PbiSharedApiClient` | PBI Shared endpoints | Bearer + S2S | Standard |
| Notebook Service | WCL | Notebook `Data` endpoint | MWC Token | Polly |
| Trident Hive Metastore | Azure SDK | Metastore Base URI | OBO Token | SDK |
| Generic Job Service | Internal | Generic Job Base URI | S2S | Standard |

---

*"Every outbound byte is ours to control. Use it wisely."*

— Sana Reeves, EDOG Studio Architect
