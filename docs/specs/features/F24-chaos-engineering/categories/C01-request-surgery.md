# C01: Request Surgery — Deep Spec

> **Author:** Sana Reeves (Architect)
> **Status:** COMPLETE
> **Date:** 2025-07-23
> **Depends On:** `interceptor-audit.md` (P0.1+P0.2), `engine-design.md` (P0.3+P2)
> **Category:** Request Surgery — modify outbound HTTP requests before they leave FLT's process

---

## Category Overview

**Request Surgery** is the act of modifying an outbound HTTP request *after* FLT has constructed it but *before* it reaches the wire. The request is fully formed — URL, method, headers, body, auth token — and our `EdogHttpPipelineHandler.SendAsync()` gets to touch it in-flight.

This is the most tangible chaos category because the developer **sees the modification immediately** in the Traffic Monitor: the request they expect leaves the process with different parameters, and the external service reacts in whatever way those changes provoke. Unlike response forgery (where we lie to FLT about what came back), request surgery **lets the real service react** to the mutated request. This means the error messages, status codes, retry behavior, and logging that FLT produces are *authentic* — they come from OneLake, Spark, or Fabric rejecting something unexpected.

**Why this matters for FLT engineers:**

1. **Timeout testing** — inject latency before the request ships, see if FLT's `CancellationToken`, Polly retries, and monitored scopes handle it correctly
2. **Wrong-lakehouse testing** — rewrite the OneLake path and watch FLT attempt to read/write data it doesn't own, validating access control
3. **Auth boundary testing** — strip or swap authentication headers and observe how external services reject the call, and how FLT's error handling reports it
4. **Contract testing** — mutate request bodies to send unexpected payloads and verify external services return meaningful errors
5. **Regression detection** — compare traffic before and after a code change, with identical request mutations, to verify behavior parity

---

## Common Predicates — FLT Traffic Targeting

These URL patterns and HttpClient names come from `interceptor-audit.md § 2` (FLT HTTP Traffic Map). Use them in any RS scenario's predicate.

### By Named HttpClient

| HttpClient Name | Traffic Type | Intercepted? |
|-----------------|-------------|--------------|
| `OneLakeRestClient` | OneLake shortcut listing (REST API) | Yes |
| `DatalakeDirectoryClient` | OneLake file ops + catalog (DataLake SDK) | Yes |
| `PbiSharedApiClient` | Fabric public API (lakehouses, workspaces, semantic models, reports) | Yes |
| `FabricApiClient` | Fabric API (registered but traffic routes through `PbiSharedApiClient`) | Yes |

### By URL Pattern

| Target Service | URL Pattern (regex) | Example |
|---------------|-------------------|---------|
| OneLake DFS | `onelake\.dfs\.fabric\.microsoft\.com` | `https://onelake.dfs.fabric.microsoft.com/{workspaceId}?directory=...` |
| OneLake Regional | `[a-z]+-onelake\.dfs\.fabric\.microsoft\.com` | `https://westus-onelake.dfs.fabric.microsoft.com/...` |
| Fabric API | `api\.fabric\.microsoft\.com/v1` | `https://api.fabric.microsoft.com/v1/workspaces/{id}/lakehouses/{id}` |
| PBI Shared API | `wabi-.*\.analysis\.windows\.net` | Used by `PBIHttpClientFactory` for Fabric API calls |

### Coverage Gap Reminder

Spark/GTS calls (`GTSBasedSparkClient`), Notebook calls (`NotebookApiClient`), and Orchestrator calls (`LiveTableCommunicationClient`) bypass `IHttpClientFactory` and are **NOT reachable** by `EdogHttpPipelineHandler`. RS scenarios can only target OneLake and Fabric API traffic. See `interceptor-audit.md § 3` (GAP-1 through GAP-3) for the plan to close these gaps via `SendHttpRequestAsync()` subclass override.

---

## Safety Notes — Why Request Surgery Is Dangerous

Request surgery modifies what FLT sends to **real external services**. Unlike response forgery (which only affects FLT's in-process state), request surgery can have **side effects on external state**.

| Risk | Scenario | Mitigation |
|------|----------|------------|
| **Wrong lakehouse write** | RS-02 rewrites the OneLake path → FLT writes delta log to wrong lakehouse | OneLake enforces token-scoped access. The auth token is scoped to the original workspace/lakehouse. Write to wrong lakehouse will get 403 Forbidden — unless the token happens to have access to both. **Mitigation:** RS-02 defaults `probability: 0.1` and `maxFirings: 5`. |
| **Data corruption** | RS-03 mutates the request body → malformed delta log entry written to OneLake | The mutated body is written to OneLake if it passes validation. **Mitigation:** Require `probability < 1.0` for body mutations on PUT/POST. Show confirmation dialog. |
| **Auth escalation** | RS-06 swaps token type → might grant broader access | MWC tokens and Bearer tokens have different audiences. Swapping them will cause a 401 from the target service — not a privilege escalation. But if a valid token with broader scope is injected, access could expand. **Mitigation:** EDOG never generates tokens. It can only swap tokens already present in the request. |
| **Cascading failure** | RS-01 adds 30s delay → request times out → Polly retries 5 times with delay → 150+ seconds of thread-pool starvation | **Mitigation:** Engine caps `delayMs` at 30000ms (30s) by default. Safety guard auto-disables rule if HTTP error rate exceeds 50% over 10 seconds. |
| **Unbounded match** | Predicate matches ALL requests → every OneLake call, every Fabric API call gets mutated | **Mitigation:** Engine requires explicit confirmation for predicates with no `httpClientName` filter or URL pattern narrower than `.*`. Kill switch (Ctrl+Shift+K) always available. |

---

## Scenario RS-01: Latency Injection

### 1. Name + ID

**RS-01 — Latency Injection**

### 2. One-liner

Add N milliseconds of delay before forwarding any matching outbound request.

### 3. Detailed Description

Latency injection is the most common chaos scenario. FLT's OneLake writes, Fabric API calls, and DataLake operations all have timeouts, retry policies (Polly), and monitored scopes with duration tracking. By injecting artificial latency *before* the request ships, we test whether:

- `CancellationToken` propagation works correctly — does FLT respect its own cancellation when the operation takes too long?
- Polly retry policies kick in at the right thresholds — does `OneLakeRetryPolicyProvider` retry after a timeout, or does it treat a slow response as success?
- Monitored scope duration tracking (`CodeMarkers`) accurately reflects the added latency
- UI-visible metrics (execution time, node duration) surface the delay faithfully

This is the P0 scenario — it's the success criteria in `spec.md § 8`: "Creates a rule: Delay OneLake writes by 3 seconds → runs a DAG → sees the delay reflected."

### 4. ChaosRule JSON

```json
{
  "id": "rs-01-onelake-latency",
  "name": "Delay OneLake writes by 3s",
  "description": "Adds 3000ms delay before all PUT/POST requests to OneLake DFS. Tests timeout handling and retry logic in OnelakeBasedFileSystem.",
  "category": "request-surgery",
  "tags": ["onelake", "latency", "timeout", "dag"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "url", "op": "matches", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com" },
      {
        "operator": "or",
        "conditions": [
          { "field": "method", "op": "equals", "value": "PUT" },
          { "field": "method", "op": "equals", "value": "POST" }
        ]
      }
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
    "ttlSeconds": 300
  }
}
```

### 5. C# Mechanism

In `EdogHttpPipelineHandler.SendAsync()`, during the **request phase**:

```csharp
// ActionExecutor.ExecuteRequest() for type="delay":
case "delay":
    var cfg = action.Config.Deserialize<DelayConfig>();
    int jitter = cfg.JitterMs > 0
        ? Random.Shared.Next(-cfg.JitterMs, cfg.JitterMs + 1)
        : 0;
    int totalDelay = Math.Clamp(cfg.DelayMs + jitter, 0, MaxDelayMs); // MaxDelayMs = 30000
    await Task.Delay(totalDelay, ct);
    // Request is NOT modified — just delayed. Falls through to base.SendAsync().
    return ActionResult.Continue;
```

The `Task.Delay` is cancellation-aware. If FLT's cancellation token fires during the delay, the `OperationCanceledException` propagates up through `base.SendAsync()` and into FLT's calling code.

### 6. FLT Code Path Affected

**`OnelakeBasedFileSystem` (13 methods)** — `Persistence/Fs/OnelakeBasedFileSystem.cs`

All 13 `IFileSystem` methods (e.g., `CreateOrUpdateFileAsync`, `ReadFileAsStringAsync`) use the `DatalakeDirectoryClient` named HttpClient, which flows through `EdogHttpPipelineHandler`. Each method wraps calls in Polly retry with exponential backoff:

```
OnelakeBasedFileSystem:CreateOrUpdateFileAsync
  → DataLake SDK → DatalakeDirectoryClient (HttpClient)
    → EdogHttpPipelineHandler.SendAsync()  ← delay injected here
      → Task.Delay(3000 ± 500ms)
      → base.SendAsync() → OneLake DFS
```

The Polly retry policy in `OnelakeBasedFileSystem` (configured via `IOMaxRetryAttempts`, `MinDelayBetweenIOFailRetry`, `MaxDelayBetweenIOFailRetry` parameters) will retry on `RequestFailedException` with 429/408/5xx status codes. A pure delay (no error) will not trigger retries — FLT will just wait longer.

**`OneLakeRestClient:ListDirsAsync`** — `OneLake/OneLakeRestClient.cs:80`

Uses `OneLakeRestClient` named HttpClient. The `OneLakeRetryPolicyProvider.CreateOneLakeRetryPolicy()` wraps each request with Polly retries. A 3s delay before the request ships adds to the total Polly timeout budget, potentially causing timeout-related `TaskCanceledException`.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| `delayMs: 999999` | Engine clamps to `MaxDelayMs` (30000ms). Effective delay = 30s. | Hard cap in `ActionExecutor`. UI shows warning when user enters >30000. |
| `delayMs: 0, jitterMs: 5000` | Random delay between -5000 and +5000, clamped to [0, 30000]. Effective: 0–5000ms. | `Math.Clamp` ensures non-negative. |
| Delay exceeds FLT's `CancellationToken` timeout | `Task.Delay` throws `OperationCanceledException`. FLT code path catches it and logs cancellation. | Expected behavior — this is what we're testing. |
| Delay on every OneLake call during a large DAG | N nodes × M file operations × 3s delay = potentially hours. Thread pool may starve. | `maxFirings: 50` limits total delayed requests. Safety guard auto-disables if error rate spikes. |
| User stacks RS-01 (3s delay) with TC-01 (blackhole) on same URL | Delay fires first (priority 100), then blackhole fires (priority 100, creation order). Request is delayed 3s, then blocked. | Documented in § Interaction. User sees both rules matched in Traffic Monitor. |

### 8. Interaction with Other Rules

| Combo | Effect | Order |
|-------|--------|-------|
| RS-01 (delay) + RS-03 (body mutation) | Request is delayed, then body is mutated, then forwarded. | Priority-ordered, then creation-ordered. Both fire on request phase. |
| RS-01 (delay) + RF-01 (status code flip) | Request is delayed before sending, response status is flipped after receiving. No conflict — different phases. | Request phase first, response phase second. |
| RS-01 (delay) + RS-01 (another delay rule) | Both delays fire sequentially. Total delay = sum of both. | Sequential execution. Effectively additive. |
| RS-01 (delay) + TC-01 (blackhole) | Request is delayed, then blackhole short-circuits with `blockRequest`. The delay fires but the request never reaches the wire. | Delay fires first (request phase continues), blackhole returns canned response. |

### 9. Revert Mechanism

1. **Disable rule:** Toggle `enabled: false` in the Active Rules panel. Instant — next request passes through unmodified.
2. **Kill switch:** `Ctrl+Shift+K` disables ALL chaos rules atomically. `ChaosRuleStore.ClearAll()` swaps to empty snapshot.
3. **TTL expiry:** Rule auto-disables after `ttlSeconds: 300` (5 minutes from first activation).
4. **Max firings:** Rule auto-disables after 50 firings.
5. **No cleanup needed:** Latency injection has zero persistent side effects. Once disabled, all requests flow at normal speed.

### 10. Priority

**P0 — Must have for MVP.** This is the success criteria scenario from `spec.md § 8`.

---

## Scenario RS-02: URL Path Rewrite

### 1. Name + ID

**RS-02 — URL Path Rewrite**

### 2. One-liner

Change the OneLake path in the request URL — e.g., redirect from `/lakehouseA/` to `/lakehouseB/`.

### 3. Detailed Description

URL path rewriting tests what happens when FLT's file operations target a different OneLake location than intended. This simulates misconfigured deployment (wrong lakehouse ID in config), cross-workspace access attempts, and URL corruption scenarios.

When the OneLake DFS URL is rewritten, the real OneLake service receives the request for the wrong path. If the auth token is scoped to the original workspace/lakehouse, OneLake returns 403 Forbidden. If the token happens to have access (e.g., same workspace, different lakehouse), the operation proceeds against the wrong data — which is exactly the disaster scenario we want FLT engineers to test defensively against.

This scenario also validates that FLT's logging includes the *actual* URL that was requested (not just the intended URL from code), making debugging easier when URL mismatch occurs in production.

### 4. ChaosRule JSON

```json
{
  "id": "rs-02-onelake-path-rewrite",
  "name": "Rewrite OneLake path lakehouseA → lakehouseB",
  "description": "Rewrites the lakehouse GUID in OneLake DFS URLs. Tests access control, error handling for 403 Forbidden, and logging fidelity.",
  "category": "request-surgery",
  "tags": ["onelake", "url-rewrite", "access-control"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "url", "op": "matches", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com" },
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" }
    ]
  },
  "action": {
    "type": "rewriteUrl",
    "config": {
      "find": "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
      "replace": "$1/00000000-0000-0000-0000-000000000000",
      "regex": true
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 0.1,
  "limits": {
    "maxFirings": 5,
    "ttlSeconds": 120
  }
}
```

### 5. C# Mechanism

```csharp
// ActionExecutor.ExecuteRequest() for type="rewriteUrl":
case "rewriteUrl":
    var cfg = action.Config.Deserialize<RewriteUrlConfig>();
    var originalUrl = ctx.Request.RequestUri!.ToString();
    string newUrl;
    if (cfg.Regex)
    {
        var regex = RegexCache.GetOrCompile(cfg.Find);
        newUrl = regex.Replace(originalUrl, cfg.Replace, count: 1);
    }
    else
    {
        newUrl = originalUrl.Replace(cfg.Find, cfg.Replace);
    }
    if (newUrl != originalUrl)
    {
        ctx.Request.RequestUri = new Uri(newUrl);
        ctx.AddModification("url", originalUrl, newUrl);
    }
    return ActionResult.Continue;
```

### 6. FLT Code Path Affected

**`OnelakeBasedFileSystem` (all 13 methods)** — `Persistence/Fs/OnelakeBasedFileSystem.cs:47`

The `OnelakeBasedFileSystem` constructor builds the base path as `{workspaceId}/{lakehouseId}/{baseDirUnderLakehouse}`. Every file operation uses this path, flowing through the `DatalakeDirectoryClient` HttpClient. When the second GUID (lakehouseId) is rewritten to `00000000-...`, the DataLake SDK sends the request to a non-existent lakehouse.

Expected FLT behavior: `RequestFailedException` with status 403 or 404, caught by the Polly retry policy, retried (status is retriable for 429/5xx, but 403/404 are NOT retriable), then surfaced as an exception in the DAG node execution.

**`OneLakeRestClient:ListDirsAsync`** — `OneLake/OneLakeRestClient.cs:80`

The `CreateListPathsRequestAsync()` method (line 260) constructs the URL as `{baseAddress}/{workspaceId}?directory={artifactId}/...`. The regex in this rule matches the `{workspaceId}/{artifactId}` portion. OneLake returns 404 for the non-existent path, and `ThrowExceptionIfOLSRequestFailAsync()` (line 285) throws `InvalidOperationException` with `NotFoundErrorPrefix`.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Regex matches more than the GUID | If the regex is too greedy, it rewrites query parameters or other URL segments. | The regex is anchored to GUID patterns. UI provides a "Test" button to preview matches before enabling. |
| Rewritten URL points to a lakehouse the token has access to | FLT succeeds but operates on wrong data. Silent data corruption. | Default `probability: 0.1` and `maxFirings: 5`. Rule description warns about this risk. |
| URL rewrite creates an invalid URI | `new Uri(newUrl)` throws `UriFormatException`. | `ActionExecutor` catches `UriFormatException`, logs it, and passes the original URL through unmodified. Rule is NOT auto-disabled (may match other valid URLs). |
| Rewrite applied to SAS-token URLs | SAS tokens are in the query string. If the regex captures query params, the SAS token could be corrupted. | GUID regex `[0-9a-f]{8}-...` won't match SAS parameters. |

### 8. Interaction with Other Rules

| Combo | Effect |
|-------|--------|
| RS-02 (URL rewrite) + RS-04 (header injection) | URL is rewritten, then headers are modified. Both fire in request phase, priority-ordered. |
| RS-02 (URL rewrite) + RS-05 (auth strip) | URL rewritten to wrong lakehouse AND auth header removed. OneLake returns 401 (no auth) before even checking the path. |
| Two RS-02 rules with different rewrites | Both fire sequentially. Second rewrite operates on the already-rewritten URL. Order matters — lower priority number fires first. |

### 9. Revert Mechanism

1. **Disable rule / Kill switch** — immediate revert.
2. **Side effects may persist** — if a write succeeded against the wrong lakehouse before the rule was disabled, that data remains. EDOG cannot undo OneLake writes.
3. **Traffic Monitor shows the original and rewritten URLs** — `ctx.AddModification("url", old, new)` records the change, displayed in the Traffic Monitor detail panel.

### 10. Priority

**P1** — High value for testing deployment misconfiguration, but requires regex and URL rewrite engine maturity.

---

## Scenario RS-03: Body Mutation

### 1. Name + ID

**RS-03 — Body Mutation**

### 2. One-liner

Modify JSON body fields in the outbound request via find-replace (string or regex) before sending.

### 3. Detailed Description

Body mutation is the most powerful (and dangerous) request surgery scenario. It changes the *content* of what FLT sends — SQL statements in Spark job submissions, delta log entries in OneLake writes, metadata in Fabric API calls.

This tests whether external services validate request bodies rigorously, and how FLT handles unexpected rejection from services that received malformed payloads. It also validates that FLT doesn't blindly trust its own request construction — if an interceptor mutates the body, does FLT detect the mismatch (e.g., via content hash validation)?

Body mutation is fundamentally different from URL rewrite (RS-02) because the request arrives at the *correct* endpoint — only the payload is wrong. This means the service performs full authentication and routing before hitting the body validation layer.

### 4. ChaosRule JSON

```json
{
  "id": "rs-03-fabric-api-body-mutation",
  "name": "Mutate semantic model JSON payload",
  "description": "Replaces the displayName field in Fabric API create-semantic-model requests. Tests validation and error handling in FabricApiClient.CreateSemanticModelAsync.",
  "category": "request-surgery",
  "tags": ["fabric-api", "body-mutation", "validation"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "POST" },
      { "field": "url", "op": "contains", "value": "/semanticModels" }
    ]
  },
  "action": {
    "type": "modifyRequestBody",
    "config": {
      "find": "\"displayName\":\\s*\"[^\"]+\"",
      "replace": "\"displayName\": \"CHAOS_MUTATED_NAME\"",
      "regex": true
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": {
    "maxFirings": 3,
    "ttlSeconds": 180
  }
}
```

### 5. C# Mechanism

```csharp
// ActionExecutor.ExecuteRequest() for type="modifyRequestBody":
case "modifyRequestBody":
    var cfg = action.Config.Deserialize<ModifyBodyConfig>();
    if (ctx.Request.Content == null)
        return ActionResult.Continue; // No body to mutate

    var originalBody = await ctx.Request.Content.ReadAsStringAsync(ct);
    string newBody;
    if (cfg.Regex)
    {
        var regex = RegexCache.GetOrCompile(cfg.Find);
        newBody = regex.Replace(originalBody, cfg.Replace, count: 1);
    }
    else
    {
        newBody = originalBody.Replace(cfg.Find, cfg.Replace);
    }

    if (newBody != originalBody)
    {
        // Preserve original Content-Type and encoding
        var contentType = ctx.Request.Content.Headers.ContentType;
        ctx.Request.Content = new StringContent(newBody, Encoding.UTF8);
        if (contentType != null)
            ctx.Request.Content.Headers.ContentType = contentType;
        ctx.AddModification("requestBody", originalBody, newBody);
    }
    return ActionResult.Continue;
```

**Important:** Reading `request.Content` consumes the stream. We must replace it with a new `StringContent`. The original `Content-Type` header is preserved to avoid triggering content-type validation failures that aren't part of this test.

### 6. FLT Code Path Affected

**`FabricApiClient:CreateSemanticModelAsync`** — `DataQuality/FabricApiClient.cs:224`

The `ExecuteCreateSemanticModelAsync()` method (line 392) sends a POST with a JSON payload containing the semantic model definition. The `PbiSharedApiClient` HttpClient carries the request through `EdogHttpPipelineHandler`. If the `displayName` is mutated to a name that already exists, Fabric API returns 409 Conflict. If the name is invalid (too long, special characters), Fabric returns 400 Bad Request. `EnsureSuccessStatusCode()` throws `HttpRequestException`.

**`FabricApiClient:RunTableMaintenanceAsync`** — `DataQuality/FabricApiClient.cs:240`

POST with table maintenance JSON (`executionData`). Body mutation could corrupt the execution parameters, causing Fabric to reject the job or execute it with wrong parameters.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Request has no body (GET request matched) | `ctx.Request.Content == null` → action skipped silently. | Early return in action executor. |
| Binary body (Parquet, protobuf) | `ReadAsStringAsync()` produces garbage. Regex won't match. Original body returned. | Body mutation is designed for text bodies. Binary bodies pass through unmodified. |
| Regex replaces Content-Length | Body length changes after mutation. `StringContent` auto-sets `Content-Length`. | `StringContent` constructor handles this correctly. |
| Large body (>10MB) | `ReadAsStringAsync()` allocates a large string. | Engine limits body read to 10MB. Larger bodies pass through unmodified with a warning event. |
| Replace string creates invalid JSON | Service rejects with 400 Bad Request. | Expected — that's what we're testing. FLT should handle 400 gracefully. |

### 8. Interaction with Other Rules

| Combo | Effect |
|-------|--------|
| RS-03 (body mutation) + RS-01 (delay) | Body is mutated AND request is delayed. Order depends on priority. |
| RS-03 (body mutation) + RS-04 (header injection) | Both modify the same request. Body mutation and header injection are independent — no conflict. |
| RS-03 (body mutation) + RS-09 (content-type swap) | Body is mutated to valid JSON, but Content-Type says `text/plain`. Service may reject based on Content-Type before reading body. |
| Two RS-03 rules on same predicate | Both fire sequentially. Second mutation operates on the already-mutated body. |

### 9. Revert Mechanism

1. **Disable rule / Kill switch** — immediate revert.
2. **Side effects may persist** — if a mutated request caused a write to succeed (e.g., semantic model created with wrong name), the external resource exists. EDOG cannot undo Fabric API operations.
3. **Traffic Monitor shows diff** — `ctx.AddModification("requestBody", old, new)` records the before/after, displayed as a diff in the detail panel.

### 10. Priority

**P1** — High value for contract testing, but requires careful body read/replace implementation.

---

## Scenario RS-04: Header Injection

### 1. Name + ID

**RS-04 — Header Injection**

### 2. One-liner

Add, remove, or modify HTTP headers on outbound requests.

### 3. Detailed Description

Header injection is the Swiss Army knife of request surgery. HTTP headers control routing (`Host`), authentication (`Authorization`, `X-S2S-Authorization`), correlation (`x-ms-correlation-id`, `x-ms-client-request-id`), content negotiation (`Accept`, `Content-Type`), and caching (`If-Match`, `If-None-Match`).

FLT uses several custom headers: `X-S2S-Authorization` for service-to-service auth in Private Link workspaces, `PbiPreserveAuthorizationHeader` for MWC token passthrough, and standard correlation headers for distributed tracing. By injecting, removing, or modifying headers, we can test:

- Does OneLake reject requests missing `X-S2S-Authorization` in PLS workspaces?
- Does Fabric API honor `Retry-After` headers in 429 responses when we strip the client's `x-ms-client-request-id`?
- Does FLT's logging correctly capture injected custom headers for debugging?

### 4. ChaosRule JSON

```json
{
  "id": "rs-04-inject-debug-header",
  "name": "Inject X-EDOG-Chaos header on all requests",
  "description": "Adds a custom header to all outbound requests for tracing which requests were affected by chaos rules. Non-destructive.",
  "category": "request-surgery",
  "tags": ["headers", "tracing", "non-destructive"],
  "predicate": {
    "field": "url",
    "op": "matches",
    "value": ".*"
  },
  "action": {
    "type": "modifyRequestHeader",
    "config": {
      "operation": "add",
      "name": "X-EDOG-Chaos",
      "value": "rs-04-active"
    }
  },
  "phase": "request",
  "priority": 50,
  "enabled": false,
  "probability": 1.0,
  "limits": {
    "ttlSeconds": 600
  }
}
```

### 5. C# Mechanism

```csharp
// ActionExecutor.ExecuteRequest() for type="modifyRequestHeader":
case "modifyRequestHeader":
    var cfg = action.Config.Deserialize<ModifyHeaderConfig>();
    switch (cfg.Operation)
    {
        case "add":
            ctx.Request.Headers.TryAddWithoutValidation(cfg.Name, cfg.Value);
            break;
        case "set":
            // Remove existing then add — effectively a replace
            ctx.Request.Headers.Remove(cfg.Name);
            ctx.Request.Headers.TryAddWithoutValidation(cfg.Name, cfg.Value);
            break;
        case "remove":
            ctx.Request.Headers.Remove(cfg.Name);
            ctx.Request.Content?.Headers.Remove(cfg.Name); // Also check content headers
            break;
    }
    ctx.AddModification("requestHeader", cfg.Name,
        cfg.Operation == "remove" ? "[removed]" : cfg.Value);
    return ActionResult.Continue;
```

`TryAddWithoutValidation` is used instead of `Add` because some headers (e.g., custom `X-` headers) may not pass .NET's built-in header validation.

### 6. FLT Code Path Affected

**All intercepted HTTP calls** — every request flowing through `EdogHttpPipelineHandler`.

Specific high-value targets:
- **`OneLakeRestClient:CreateListPathsRequestAsync`** (line 260) — manually sets `Authorization` and `X-S2S-Authorization`. Injecting a conflicting `Authorization` header creates a duplicate header scenario.
- **`FabricApiClient:GetLakehouseDetailsAsync`** (line 48) — uses `PbiSharedApiClient` which sets headers via `PBIHttpClientFactory`. Header injection can add tracing headers before the request ships.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Add duplicate header name | HTTP allows multiple headers with the same name. Both values are sent. Service behavior varies. | `TryAddWithoutValidation` appends; use `set` operation to replace. |
| Remove `Host` header | .NET `HttpClient` auto-adds `Host` from the URI. Removing it may cause `HttpClient` to re-add it. | Document that `Host` removal is a no-op in practice. |
| Remove `Content-Length` | `HttpClient` recalculates `Content-Length` for `StringContent`. Removal is harmless. | Documented behavior. |
| Set `Authorization` to empty string | Service receives `Authorization: ` (empty). Behavior varies: some services return 401, others ignore. | Valid test case — tests how services handle empty auth headers. |

### 8. Interaction with Other Rules

Header injection has the lowest conflict potential because it operates on a different request dimension (headers) than URL rewrite (URL) or body mutation (body). Multiple header injection rules fire sequentially and can add/modify different headers.

The only conflict: two rules that both `set` the same header name. Last writer wins (higher priority number, or later creation order).

### 9. Revert Mechanism

Disable rule / Kill switch. No side effects — headers are per-request and leave no persistent state.

### 10. Priority

**P0 — Must have for MVP.** Header manipulation is the simplest action type and provides immediate diagnostic value (e.g., `X-EDOG-Chaos` tracing header).

---

## Scenario RS-05: Auth Header Strip

### 1. Name + ID

**RS-05 — Auth Header Strip**

### 2. One-liner

Remove the `Authorization` header entirely from outbound requests.

### 3. Detailed Description

Stripping the `Authorization` header simulates what happens when token acquisition fails silently — FLT constructs the request but the token is missing. This is a surprisingly common production failure mode: the token cache returns a stale entry, the token provider throws an exception that's caught and swallowed, or the `ITokenProvider.GetTokenAsync()` call returns null.

By stripping `Authorization`, we observe:
- Does OneLake return 401 or 403? (401 = "who are you?", 403 = "I know who you are but you can't do that")
- Does FLT retry after a 401? (`OneLakeRetryPolicyProvider` does not retry 401/403 — they're treated as terminal)
- Does FLT's error message correctly indicate "authentication failure" vs. a generic "request failed"?
- What about the `X-S2S-Authorization` header? If only `Authorization` is stripped but S2S remains, does OneLake accept the S2S token alone?

### 4. ChaosRule JSON

```json
{
  "id": "rs-05-strip-auth",
  "name": "Strip Authorization header from OneLake calls",
  "description": "Removes the Authorization header from all OneLake requests. Tests 401 handling, retry policy behavior for auth failures, and error message quality.",
  "category": "request-surgery",
  "tags": ["auth", "onelake", "401", "security"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "url", "op": "matches", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com" },
      { "field": "requestHeader", "key": "Authorization", "op": "exists" }
    ]
  },
  "action": {
    "type": "modifyRequestHeader",
    "config": {
      "operation": "remove",
      "name": "Authorization"
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 0.3,
  "limits": {
    "maxFirings": 10,
    "ttlSeconds": 120
  }
}
```

### 5. C# Mechanism

Same as RS-04, using `operation: "remove"` with `name: "Authorization"`. The `EdogHttpPipelineHandler` sits *after* `EdogTokenInterceptor` in the handler chain (chain: `EdogTokenInterceptor → EdogHttpPipelineHandler → original`), so the token has already been captured for observability before we strip it. The token metadata is preserved in the `"token"` topic — the removal only affects the outbound wire request.

### 6. FLT Code Path Affected

**`OneLakeRestClient:CreateListPathsRequestAsync`** — `OneLake/OneLakeRestClient.cs:264`

Sets `request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token)`. Our rule removes this header after FLT sets it but before `httpClient.SendAsync()` fires. OneLake returns 401. `ThrowExceptionIfOLSRequestFailAsync()` (line 285) catches it and throws `UnauthorizedAccessException` (line 330-332).

**`OnelakeBasedFileSystem`** — All methods use `FMVTokenCredential` which sets the `Authorization` header via the DataLake SDK's `TokenCredential` pipeline. Our handler strip runs after the SDK sets the header.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Request has no `Authorization` header | Predicate `exists` check fails → rule doesn't fire. | By design. |
| Both `Authorization` and `X-S2S-Authorization` present | Only `Authorization` is stripped. OneLake may accept the S2S token. | Create a separate rule for S2S, or use a compound rule with two remove actions. Currently one action per rule — would need two rules. |
| Token interceptor already captured the token | No conflict. Token metadata is captured in the `"token"` topic before the request reaches the pipeline handler. | By design — capture happens in `EdogTokenInterceptor.SendAsync()` which calls `base.SendAsync()` (our handler) AFTER extracting metadata. |

### 8. Interaction with Other Rules

| Combo | Effect |
|-------|--------|
| RS-05 (auth strip) + RS-06 (token swap) | If RS-05 fires first, RS-06 has nothing to swap. If RS-06 fires first, the swapped token is then stripped. Either way, no auth reaches the service. |
| RS-05 (auth strip) + RS-01 (delay) | Request is delayed AND unauthenticated. Service still returns 401 after the delay. |

### 9. Revert Mechanism

Disable rule / Kill switch. No persistent side effects — authentication is per-request.

### 10. Priority

**P0 — Must have for MVP.** Auth failure is the #1 production issue for FLT. Testing 401 handling is critical.

---

## Scenario RS-06: Auth Token Swap

### 1. Name + ID

**RS-06 — Auth Token Swap**

### 2. One-liner

Replace the Bearer token with the MWC token (or vice versa) in the `Authorization` header.

### 3. Detailed Description

FLT uses two primary authentication schemes: **Bearer** (AAD tokens for OneLake REST, Fabric API) and **MWC V1** (Fabric workload tokens for Spark/GTS). Each token has a specific audience (`aud` claim) — OneLake expects a token scoped to `https://storage.azure.com/`, while GTS expects a lakehouse-audience MWC token.

Token swap tests what happens when the wrong token type is sent to a service:
- Send a Bearer (OneLake) token to the Fabric API endpoint → does Fabric validate the audience or just accept any valid JWT?
- This is especially important because `PBIHttpClientFactory.CreateWithOriginalAadTokenAsync()` creates clients with a specific token — if the wrong token is injected, the service's response reveals audience validation behavior.

**Note:** EDOG cannot *generate* tokens. It can only swap tokens that are already present in the request. This limits the blast radius — the swapped token is still a valid JWT, just for the wrong audience.

### 4. ChaosRule JSON

```json
{
  "id": "rs-06-swap-bearer-audience",
  "name": "Replace OneLake Bearer token audience claim",
  "description": "Swaps the Authorization header value with a fabricated scheme marker. Tests audience validation on OneLake and Fabric API endpoints.",
  "category": "request-surgery",
  "tags": ["auth", "token-swap", "audience", "security"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "requestHeader", "key": "Authorization", "op": "contains", "value": "Bearer" }
    ]
  },
  "action": {
    "type": "modifyRequestHeader",
    "config": {
      "operation": "set",
      "name": "Authorization",
      "value": "Bearer INVALID_TOKEN_FOR_CHAOS_TESTING"
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 0.2,
  "limits": {
    "maxFirings": 5,
    "ttlSeconds": 60
  }
}
```

### 5. C# Mechanism

Same as RS-04 with `operation: "set"`. The existing `Authorization` header is removed and replaced with the new value. The token interceptor has already captured the original token metadata before this fires.

For a more sophisticated swap (Bearer ↔ S2S), the rule could use two actions — but the current schema supports one action per rule. Alternative: create two rules (one to remove `Authorization`, one to add it with the S2S value). Or extend the action model to support multi-step actions (P2 — see C06: Advanced).

### 6. FLT Code Path Affected

**`OneLakeRestClient:ListDirsAsync`** — `OneLake/OneLakeRestClient.cs:80`

The request's `Authorization` header is replaced. OneLake receives `Bearer INVALID_TOKEN_FOR_CHAOS_TESTING`, attempts JWT validation, and returns 401 Unauthorized. `ThrowExceptionIfOLSRequestFailAsync()` throws `UnauthorizedAccessException`.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Swapped value is a real token for a different audience | Service may accept the token if audience validation is lenient. Unlikely for OneLake (strict) but possible for test endpoints. | This is a valid security finding. |
| Token value is very long (>8KB) | Header size exceeds server limits. 431 Request Header Fields Too Large. | Unlikely in practice. Engine could validate header value length. |
| Swapping on a request with no `Authorization` header | Predicate `contains "Bearer"` check fails → rule doesn't fire. | By design. |

### 8. Interaction with Other Rules

RS-05 (auth strip) and RS-06 (token swap) conflict if both target the same header. If RS-05 fires first, the header is removed and RS-06's `set` operation re-adds it — effectively only a swap occurs. If RS-06 fires first, the header is set to the new value, then RS-05 removes it. **Order matters.** Use `priority` to control.

### 9. Revert Mechanism

Disable rule / Kill switch. No persistent side effects.

### 10. Priority

**P1** — Important for security testing but requires careful configuration to avoid confusion.

---

## Scenario RS-07: Method Override

### 1. Name + ID

**RS-07 — Method Override**

### 2. One-liner

Change the HTTP method of an outbound request — e.g., GET → POST, POST → PUT.

### 3. Detailed Description

Method override tests how external services handle unexpected HTTP methods for known endpoints. OneLake DFS uses specific methods for different operations: GET for reads, PUT for writes, DELETE for removals. Fabric API uses POST for creation, GET for reads.

Sending a POST to a GET endpoint (or vice versa) reveals:
- Does the service return 405 Method Not Allowed with an `Allow` header?
- Does the service accidentally process the request with the wrong method (e.g., a POST to a GET endpoint that creates a resource)?
- How does FLT handle 405 responses — are they treated as retriable or terminal?

### 4. ChaosRule JSON

```json
{
  "id": "rs-07-get-to-post",
  "name": "Override OneLake GET to POST",
  "description": "Changes GET requests to POST for OneLake REST client. Tests 405 Method Not Allowed handling.",
  "category": "request-surgery",
  "tags": ["method", "405", "onelake"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "action": {
    "type": "rewriteUrl",
    "config": {
      "find": "",
      "replace": "",
      "regex": false
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 0.5,
  "limits": {
    "maxFirings": 10,
    "ttlSeconds": 120
  }
}
```

**Note on action type:** The current engine-design schema does not include a dedicated `methodOverride` action type. The implementation would need either:
- A new action type: `{ "type": "methodOverride", "config": { "method": "POST" } }` (recommended)
- Or abuse `modifyRequestHeader` to set a non-standard `X-HTTP-Method-Override` header (not what we want — we need to change the actual HTTP method)

**Recommended schema addition:**

```json
{
  "action": {
    "type": "methodOverride",
    "config": {
      "method": "POST"
    }
  }
}
```

### 5. C# Mechanism

```csharp
// ActionExecutor.ExecuteRequest() for type="methodOverride":
case "methodOverride":
    var cfg = action.Config.Deserialize<MethodOverrideConfig>();
    var originalMethod = ctx.Request.Method;
    ctx.Request.Method = new HttpMethod(cfg.Method);
    ctx.AddModification("method", originalMethod.Method, cfg.Method);
    return ActionResult.Continue;
```

Simple property assignment. `HttpRequestMessage.Method` is mutable.

### 6. FLT Code Path Affected

**`OneLakeRestClient:ListDirsAsync`** — `OneLake/OneLakeRestClient.cs:80`

`ListDirsAsync` sends GET requests. Overriding to POST, OneLake DFS returns 405 or processes as an upload attempt (unexpected behavior). `ThrowExceptionIfOLSRequestFailAsync()` handles 405 under the general non-success branch.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| POST without body on an endpoint expecting body | Service returns 400 Bad Request or 411 Length Required. | Valid test — FLT should handle this. |
| GET with body (after override from POST) | HTTP spec says GET can have a body, but most servers ignore it. | Some servers return 400. Valid edge case. |
| DELETE on a creation endpoint | Service may delete the resource instead of creating it. | `probability: 0.5` and `maxFirings: 10` limit blast radius. |

### 8. Interaction with Other Rules

Method override is independent of URL, header, and body modifications. No conflicts expected.

### 9. Revert Mechanism

Disable rule / Kill switch. No persistent side effects (the wrong method request is rejected by the service).

### 10. Priority

**P2** — Niche testing scenario. 405 handling is rarely a production issue.

---

## Scenario RS-08: Query Parameter Injection

### 1. Name + ID

**RS-08 — Query Parameter Injection**

### 2. One-liner

Add or modify query parameters on outbound request URLs — e.g., append `?timeout=1ms` or `?maxResults=1`.

### 3. Detailed Description

Query parameter injection tests how external services handle unexpected or extreme parameter values. OneLake DFS uses query parameters for directory listing (`recursive`, `maxResults`, `continuation`). Fabric API uses them for job types and filters.

Key test scenarios:
- `maxResults=1` on OneLake listing → forces pagination, tests continuation token handling in `OneLakeRestClient.ListDirsAsync`'s pagination loop
- `timeout=1` on any call → tests if the service enforces server-side timeouts
- Adding unknown parameters → tests if services ignore unknown params or return 400

### 4. ChaosRule JSON

```json
{
  "id": "rs-08-onelake-force-pagination",
  "name": "Force OneLake single-item pagination",
  "description": "Appends maxResults=1 to OneLake listing calls, forcing one item per page. Tests pagination loop in OneLakeRestClient.ListDirsAsync.",
  "category": "request-surgery",
  "tags": ["onelake", "pagination", "query-params"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "url", "op": "contains", "value": "resource=filesystem" }
    ]
  },
  "action": {
    "type": "rewriteUrl",
    "config": {
      "find": "resource=filesystem",
      "replace": "resource=filesystem&maxResults=1",
      "regex": false
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": {
    "maxFirings": 20,
    "ttlSeconds": 300
  }
}
```

### 5. C# Mechanism

Uses `rewriteUrl` action type (same as RS-02). Simple string replacement on the URL. The `find` string is a literal substring of the query string; the `replace` string appends an additional parameter.

### 6. FLT Code Path Affected

**`OneLakeRestClient:ListDirsAsync`** — `OneLake/OneLakeRestClient.cs:80`

The pagination loop at line 115 (`do { ... } while (continuationToken != null)`) reads pages until no continuation token is returned. With `maxResults=1`, each page contains one item, causing the loop to execute once per directory entry. For a lakehouse with 500 tables, this means 500+ HTTP round trips instead of 1. This tests:
- Continuation token parsing (line 109)
- Page count logging (line 117-119)
- Memory accumulation in `allDirectoriesPaths` list (line 108)
- Total request duration vs. Polly timeout budget

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| `maxResults=0` | OneLake behavior undefined. May return empty response or 400. | Valid test — discovers service edge case handling. |
| `maxResults=1` on lakehouse with 10,000 items | 10,000+ HTTP calls. Slow but not dangerous. | `maxFirings: 20` limits the number of affected listing calls (each listing call triggers multiple paginated requests, but only the first request in each listing gets mutated due to the `resource=filesystem` pattern). |
| Parameter already exists in URL | Creates duplicate: `maxResults=5000&maxResults=1`. Server behavior varies — some take first, some take last. | Use regex to replace the existing parameter instead of appending. |

### 8. Interaction with Other Rules

Works well with RS-01 (delay) — inject latency on every paginated request, compounding the total listing duration. This combination stress-tests timeout handling under slow pagination.

### 9. Revert Mechanism

Disable rule / Kill switch. No persistent side effects.

### 10. Priority

**P1** — Pagination edge cases are a real production issue for FLT.

---

## Scenario RS-09: Content-Type Swap

### 1. Name + ID

**RS-09 — Content-Type Swap**

### 2. One-liner

Change the `Content-Type` header on outbound requests — e.g., `application/json` → `text/plain`.

### 3. Detailed Description

Content-Type defines how the receiving service parses the request body. Fabric API and OneLake expect `application/json` for JSON payloads. If the Content-Type is changed to `text/plain`, the service may:
- Reject the request immediately (400 Bad Request, "Unsupported Media Type")
- Attempt to parse the body as plain text, fail, and return a confusing error
- Accept the body anyway (some services ignore Content-Type)

This tests FLT's assumption that Content-Type is always set correctly by `HttpClient`'s `StringContent` class, and validates that services enforce content negotiation.

### 4. ChaosRule JSON

```json
{
  "id": "rs-09-content-type-swap",
  "name": "Swap Content-Type to text/plain on Fabric API POSTs",
  "description": "Changes Content-Type from application/json to text/plain on Fabric API POST requests. Tests 415 Unsupported Media Type handling.",
  "category": "request-surgery",
  "tags": ["content-type", "fabric-api", "415"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "POST" },
      { "field": "contentType", "op": "contains", "value": "json" }
    ]
  },
  "action": {
    "type": "modifyRequestHeader",
    "config": {
      "operation": "set",
      "name": "Content-Type",
      "value": "text/plain; charset=utf-8"
    }
  },
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 0.5,
  "limits": {
    "maxFirings": 5,
    "ttlSeconds": 120
  }
}
```

### 5. C# Mechanism

Same as RS-04 (`modifyRequestHeader`), but targeting a content header. Implementation note: `Content-Type` is a *content* header in .NET (`HttpContent.Headers`), not a request header (`HttpRequestMessage.Headers`). The action executor must check both:

```csharp
case "modifyRequestHeader" when cfg.Name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase):
    if (ctx.Request.Content != null)
    {
        ctx.Request.Content.Headers.ContentType =
            System.Net.Http.Headers.MediaTypeHeaderValue.Parse(cfg.Value);
    }
    break;
```

### 6. FLT Code Path Affected

**`FabricApiClient:CreateSemanticModelAsync`** — `DataQuality/FabricApiClient.cs:224`

POST request with JSON body. If Content-Type is `text/plain`, Fabric API may return 415 Unsupported Media Type or parse incorrectly. `EnsureSuccessStatusCode()` throws `HttpRequestException`.

**`FabricApiClient:RunTableMaintenanceAsync`** — `DataQuality/FabricApiClient.cs:240`

Same pattern — POST with JSON body for table maintenance job creation.

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Request has no Content-Type (GET request) | `contentType contains "json"` predicate fails → rule doesn't fire. | By design. |
| Setting Content-Type to `application/xml` | Service may attempt XML parsing, get garbage, return 400. | Valid test case. |
| Setting Content-Type with invalid charset | `MediaTypeHeaderValue.Parse()` throws `FormatException`. | Catch in action executor, log warning, skip this request. |

### 8. Interaction with Other Rules

Content-Type swap combines naturally with body mutation (RS-03): mutate the body to XML and swap the Content-Type to `application/xml` to test XML endpoint fallback behavior.

### 9. Revert Mechanism

Disable rule / Kill switch. No persistent side effects.

### 10. Priority

**P2** — Niche scenario. Content negotiation failures are uncommon in production.

---

## Scenario RS-10: Request Cloning (Shadow Traffic)

### 1. Name + ID

**RS-10 — Request Cloning (Shadow Traffic)**

### 2. One-liner

Forward the request to the real service AND simultaneously to a shadow endpoint for comparison.

### 3. Detailed Description

Request cloning (also called shadow traffic or traffic mirroring) sends a copy of the outbound request to a second endpoint without affecting the primary request/response flow. This enables:

- **A/B comparison:** Send the same request to production OneLake and a test OneLake instance, compare responses
- **Performance benchmarking:** Compare latency to two different Fabric API endpoints
- **Regression detection:** When migrating to a new service version, shadow traffic to both old and new endpoints validates behavioral parity

The primary request flows normally — FLT receives the real response. The shadow request is fire-and-forget, logged to the Traffic Monitor but not visible to FLT's code path.

### 4. ChaosRule JSON

```json
{
  "id": "rs-10-shadow-onelake",
  "name": "Shadow OneLake traffic to test endpoint",
  "description": "Clones all OneLake DFS requests to a test endpoint for comparison. Primary flow is unaffected.",
  "category": "request-surgery",
  "tags": ["shadow", "clone", "comparison", "onelake"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "url", "op": "matches", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "action": {
    "type": "redirectRequest",
    "config": {
      "targetUrl": "https://test-onelake.dfs.fabric.microsoft.com",
      "preserveHeaders": true
    }
  },
  "phase": "request",
  "priority": 200,
  "enabled": false,
  "probability": 0.1,
  "limits": {
    "maxFirings": 100,
    "ttlSeconds": 600
  }
}
```

**Note on schema:** True request cloning (send to BOTH endpoints) requires a new action type: `{ "type": "cloneRequest", "config": { "shadowUrl": "...", "preserveHeaders": true, "captureResponse": true } }`. The `redirectRequest` type above only redirects — it doesn't clone. Until `cloneRequest` is implemented, RS-10 can only redirect (not shadow).

**Recommended schema addition for P2:**

```json
{
  "type": "cloneRequest",
  "config": {
    "shadowUrl": "string — base URL for the shadow endpoint",
    "preserveHeaders": "bool — copy all headers to shadow request",
    "preserveBody": "bool — copy body to shadow request",
    "captureResponse": "bool — log shadow response in Traffic Monitor",
    "timeoutMs": "int — timeout for shadow request (default: 5000)"
  }
}
```

### 5. C# Mechanism

For `redirectRequest` (simpler, P1):

```csharp
case "redirectRequest":
    var cfg = action.Config.Deserialize<RedirectConfig>();
    var originalUri = ctx.Request.RequestUri!;
    var targetBase = new Uri(cfg.TargetUrl);
    // Preserve path and query from original, change host/scheme
    var newUri = new UriBuilder(targetBase.Scheme, targetBase.Host, targetBase.Port,
        originalUri.PathAndQuery).Uri;
    ctx.Request.RequestUri = newUri;
    if (!cfg.PreserveHeaders)
        ctx.Request.Headers.Remove("Authorization"); // Don't leak auth to shadow
    ctx.AddModification("url", originalUri.ToString(), newUri.ToString());
    return ActionResult.Continue;
```

For `cloneRequest` (full shadow, P2):

```csharp
case "cloneRequest":
    var cfg = action.Config.Deserialize<CloneConfig>();
    // Clone the request (deep copy headers, body)
    var shadowRequest = await CloneHttpRequest(ctx.Request, cfg, ct);
    // Fire and forget — don't block the primary flow
    _ = Task.Run(async () =>
    {
        try
        {
            using var shadowClient = new HttpClient { Timeout = TimeSpan.FromMilliseconds(cfg.TimeoutMs) };
            var shadowResponse = await shadowClient.SendAsync(shadowRequest, CancellationToken.None);
            if (cfg.CaptureResponse)
                TopicRouter.Publish("chaos", ChaosEvent.ShadowResponse(rule, shadowResponse));
        }
        catch (Exception ex)
        {
            TopicRouter.Publish("chaos", ChaosEvent.ShadowError(rule, ex));
        }
    });
    return ActionResult.Continue; // Primary flow continues immediately
```

### 6. FLT Code Path Affected

**All intercepted GET requests** — read operations are safe to shadow (no side effects on the shadow endpoint). Write operations (PUT/POST/DELETE) should NOT be shadowed without explicit confirmation (could create duplicate resources on the shadow endpoint).

### 7. Edge Cases

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| Shadow endpoint is down | Shadow request fails silently (fire-and-forget). Primary flow unaffected. | Shadow errors logged to `chaos` topic but don't affect FLT. |
| Shadow endpoint is slow | Shadow request times out after `timeoutMs`. Thread pool thread is briefly occupied. | Default `timeoutMs: 5000`. `Task.Run` prevents blocking the primary flow. |
| Auth tokens leak to shadow | `Authorization` header is copied to the shadow endpoint. | Default `preserveHeaders: false` for `Authorization` and `X-S2S-Authorization`. Explicit opt-in required. |
| Shadowing write operations | POST/PUT/DELETE to shadow creates real side effects (duplicate writes). | Predicate limits to GET methods by default. UI shows warning for non-GET shadow rules. |
| High probability on high-traffic endpoint | N shadow requests per second. Shadow endpoint may be overwhelmed. | `probability: 0.1` and `maxFirings: 100` limit volume. |

### 8. Interaction with Other Rules

Shadow/clone is independent of other request surgery rules. The primary flow executes all other rules normally. The shadow request is a copy made *after* other rules have already modified the primary request.

### 9. Revert Mechanism

Disable rule / Kill switch. Shadow requests that were already sent cannot be undone, but no state in the primary FLT flow is affected.

### 10. Priority

**P2** — Advanced scenario. Requires `cloneRequest` action type (not in current schema). `redirectRequest` provides partial value at P1.

---

## Execution Order — How Multiple Rules Fire

When multiple Request Surgery rules match the same request, they execute **in this order**:

1. **Priority** (ascending) — `priority: 50` fires before `priority: 100`
2. **Creation order** (ascending) — rules with the same priority fire in the order they were created

```
Request enters EdogHttpPipelineHandler.SendAsync()
  ↓
  For each rule where phase == "request" or "both" (sorted by priority, then creation):
    1. Evaluate predicate → match?
    2. Roll probability dice → pass?
    3. Check limits (maxFirings, rate, TTL) → allowed?
    4. Execute action → modify request / short-circuit / continue
    5. Record firing → increment counter, audit log, publish ChaosEvent
  ↓
  base.SendAsync(possibly-modified request) → real service
```

**Short-circuit rules** (`blockRequest`, `forgeResponse`) terminate the loop. Subsequent rules don't fire. To ensure delay fires before block, give the delay rule a lower priority number.

---

## Summary Table

| ID | Name | Action Type | Target | Priority | Key Value |
|----|------|------------|--------|----------|-----------|
| RS-01 | Latency Injection | `delay` | OneLake writes | **P0** | MVP success criteria |
| RS-02 | URL Path Rewrite | `rewriteUrl` | OneLake DFS paths | P1 | Deployment misconfiguration |
| RS-03 | Body Mutation | `modifyRequestBody` | Fabric API POSTs | P1 | Contract testing |
| RS-04 | Header Injection | `modifyRequestHeader` | All traffic | **P0** | Diagnostic tracing |
| RS-05 | Auth Header Strip | `modifyRequestHeader` | OneLake auth | **P0** | Auth failure #1 issue |
| RS-06 | Auth Token Swap | `modifyRequestHeader` | OneLake auth | P1 | Security boundary testing |
| RS-07 | Method Override | `methodOverride` (new) | OneLake REST | P2 | 405 handling |
| RS-08 | Query Param Injection | `rewriteUrl` | OneLake listing | P1 | Pagination edge cases |
| RS-09 | Content-Type Swap | `modifyRequestHeader` | Fabric API POSTs | P2 | Content negotiation |
| RS-10 | Request Cloning | `cloneRequest` (new) | OneLake GETs | P2 | Shadow traffic comparison |

**P0 total: 3 scenarios (RS-01, RS-04, RS-05)** — minimum for MVP.
**P1 total: 4 scenarios (RS-02, RS-03, RS-06, RS-08)** — high value, implement after MVP.
**P2 total: 3 scenarios (RS-07, RS-09, RS-10)** — advanced, implement after P1.

---

## Schema Additions Required

The current `engine-design.md` action type enum needs two additions for full RS coverage:

| New Action Type | Required By | Config Schema |
|----------------|------------|---------------|
| `methodOverride` | RS-07 | `{ "method": "string" }` |
| `cloneRequest` | RS-10 | `{ "shadowUrl": "string", "preserveHeaders": "bool", "preserveBody": "bool", "captureResponse": "bool", "timeoutMs": "int" }` |

These should be added to `engine-design.md § Action Types` when implementing the respective scenarios.

---

*"Request surgery is the scalpel. Response forgery is the mask. Together they let you test every failure mode FLT will ever encounter in production — before production encounters it."*

— Sana Reeves, EDOG Studio Architect
