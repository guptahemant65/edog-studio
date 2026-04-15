# C03: Traffic Control — Deep Spec

> **Author:** Sana Reeves (Architect)
> **Status:** DRAFT
> **Date:** 2025-07-22
> **Category:** Traffic Control (delay, block, throttle, reorder)
> **Depends On:** `interceptor-audit.md` §1–§3, `engine-design.md` §2 (ChaosRule schema)

---

## Purpose

Traffic Control tests FLT's resilience to **flow-level** disruptions — without changing any request or response content. The question isn't "what happens if the response is wrong?" (that's C02) but "what happens if the response **never comes**, comes **too late**, or comes **in a flood**?"

This is the category that exposes FLT's timeout handling, retry amplification, circuit breaker gaps, and degraded-mode behavior. Every scenario maps directly to a production failure mode that FLT engineers have either experienced or will experience.

### FLT Retry Architecture Summary (CLEAN Source Reference)

FLT has **four distinct retry subsystems** and **zero circuit breakers**:

| Subsystem | File | Retry Count | Backoff | Handles |
|-----------|------|-------------|---------|---------|
| **OneLake Retry** | `RetryPolicy/OneLakeRetryPolicyProvider.cs` | `OneLakeMaxRetryAttempts` (config) | Exponential (`ExponentialBackoffStrategy`) capped at `OneLakeRetryMaxDelayInSeconds` | 408, 429, 5xx on OneLake DFS calls. Respects `Retry-After` header on 429. |
| **Standard HTTP Retry** (V2) | `RetryPolicy/V2/Strategies/StandardRetryStrategy.cs` | `HttpMaxRetryAttempts` (config) | Exponential (`ExponentialBackoffStrategy`) | 429, 5xx on Spark submit. Skips 430. Respects `RetryAfter` on response. |
| **Capacity Retry** (V2) | `RetryPolicy/V2/Strategies/CapacityRetryStrategy.cs` | Admission window (configurable array, default ~6 delays) + **unlimited** extended mode | Fixed arrays: admission `[20s, 40s, 60s, 90s, 90s, 90s]`, extended alternating `[60s, 90s]` | 430 (Spark capacity throttling). Fast-track on `NodeCompleted` event with jitter. |
| **Fabric API Polling** | `DataQuality/FabricApiClient.cs:HandleLongRunningOperationAsync` | Polling loop with 300s timeout | `Retry-After` header or 10s default; 5s on 502/503/429 | Long-running ops (semantic model creation, report creation). |

**Key insight:** FLT has **no circuit breaker pattern**. Every retry subsystem retries independently. A sustained 429 storm on OneLake triggers retry amplification — each original request spawns N retry attempts, each retry may itself trigger downstream retries.

**HttpClient.Timeout:** Inherited from `IHttpClientFactory` defaults (100s for .NET). `OneLakeRestClient` logs it at initialization (`this.httpClient.Timeout.TotalSeconds`). The `RequestTimeoutAttribute` sets a 1-minute default for incoming WCL requests (`RequestTimeoutInterval` from host params). There is no per-call timeout override for outbound calls.

---

## Scenarios

---

### TC-01: Blackhole

**One-liner:** Drop ALL matching requests — no response, no error, simulate total network partition.

**Description:**
Simulates a complete network failure to a target service. The request enters `EdogHttpPipelineHandler.SendAsync()` and never returns — instead, the handler throws `TaskCanceledException` after a configurable timeout (simulating `HttpClient.Timeout` expiry) or `HttpRequestException` (simulating connection refused). This is the harshest traffic control: the service simply doesn't exist.

**What this tests in FLT:**
- OneLake blackhole → tests `OneLakeRetryPolicyProvider`'s `TaskCanceledException` handling (line 60: `Or<TaskCanceledException>(ex => !cancellationToken.IsCancellationRequested)`) — the retry policy retries on HttpClient timeout but NOT on user cancellation. A blackhole-induced timeout triggers retries.
- Fabric API blackhole → tests `HandleLongRunningOperationAsync` timeout logic (300s default) — the polling loop will spin until timeout expires.
- **Retry amplification exposure:** With default settings, a blackholed OneLake write triggers `OneLakeMaxRetryAttempts` retries, each waiting for the full `HttpClient.Timeout` (100s default). Total wall time = `maxRetries × 100s` before failure surfaces.

**ChaosRule JSON:**
```json
{
  "id": "tc01-blackhole-onelake",
  "name": "Blackhole OneLake",
  "description": "Drop all OneLake requests. Simulates total network partition to OneLake DFS.",
  "category": "traffic-control",
  "tags": ["onelake", "network", "partition", "timeout"],
  "predicate": {
    "field": "httpClientName",
    "op": "equals",
    "value": "DatalakeDirectoryClient"
  },
  "action": {
    "type": "blockRequest",
    "config": {
      "statusCode": 0,
      "simulateTimeout": true,
      "timeoutMs": 30000,
      "errorMessage": "EDOG Chaos: Blackhole — simulated network timeout to OneLake"
    }
  },
  "phase": "request",
  "priority": 10,
  "probability": 1.0,
  "limits": { "ttlSeconds": 120 }
}
```

**C# Mechanism:**
```csharp
// In EdogHttpPipelineHandler.SendAsync(), when action.type == "blockRequest" && config.simulateTimeout:
if (action.Config.SimulateTimeout)
{
    // Simulate network timeout: delay then throw TaskCanceledException
    // (same exception type as HttpClient.Timeout)
    await Task.Delay(action.Config.TimeoutMs, cancellationToken);
    throw new TaskCanceledException(
        action.Config.ErrorMessage,
        new TimeoutException(action.Config.ErrorMessage));
}
```

**FLT Code Path (CLEAN):**
- `OneLake/OnelakeBasedFileSystem.cs` → all 13 `IFileSystem` methods → `DatalakeDirectoryClient` HttpClient
- `OneLake/OneLakeRestClient.cs:ListDirsAsync` → `OneLakeRestClient` HttpClient
- Both wrapped by `OneLakeRetryPolicyProvider.CreateOneLakeRetryPolicy()` → Polly `WaitAndRetryAsync`
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:60` — `Or<TaskCanceledException>(ex => !cancellationToken.IsCancellationRequested)` triggers retry

**Edge Cases:**
- If `timeoutMs` > `HttpClient.Timeout` (100s default), the real HttpClient timeout fires first — the chaos rule's delay is preempted by the framework timeout. Set `timeoutMs` < 100000.
- If the user also has a latency rule active, the delays stack (latency delay + blackhole delay).
- Blackholing `DatalakeDirectoryClient` also blocks catalog metadata reads (delta logs, table schema), not just file writes.

**Interactions:**
- **Conflicts with TC-02 (Selective Blackhole):** If both active, TC-01 (lower priority=10) fires first and blocks everything, making TC-02 redundant. UI should warn.
- **Stacks with TC-05 (429 Storm):** Contradictory — can't return 429 if the request is blackholed. First rule wins by priority.

**Revert:**
- Disable rule → immediate. Next request flows through normally.
- Kill switch (`Ctrl+Shift+K`) → clears all rules, traffic resumes instantly.
- No lingering state — blackhole is per-request, not connection-based.

**Priority:** P0 — This is the most fundamental chaos test. If FLT can't handle "service is gone", nothing else matters.

---

### TC-02: Selective Blackhole

**One-liner:** Drop requests matching a URL pattern while passing everything else — surgical network partition.

**Description:**
Unlike TC-01's scorched-earth approach, this targets specific URL paths or operations. Example: blackhole only OneLake **write** operations (`PUT` to the DFS endpoint) while allowing **reads** (`GET`). This simulates "OneLake is read-only" — a real production scenario during OneLake maintenance windows.

**What this tests in FLT:**
- Write-only blackhole → tests whether FLT's DAG execution can detect write failures while reads succeed. The `OnelakeBasedFileSystem.CreateOrUpdateFileAsync` path fails but `ReadFileAsStringAsync` works. Does the DAG node retry writes? Does it report a partial failure?
- List-only blackhole → tests whether FLT can handle successful file ops but failed directory listings. The `OneLakeRestClient.ListDirsAsync` fails but individual file reads work. Does the catalog refresh break?

**ChaosRule JSON:**
```json
{
  "id": "tc02-blackhole-onelake-writes",
  "name": "Blackhole OneLake Writes Only",
  "description": "Block PUT/POST to OneLake while allowing GET/HEAD. Simulates read-only OneLake.",
  "category": "traffic-control",
  "tags": ["onelake", "writes", "partial-failure"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      {
        "operator": "or",
        "conditions": [
          { "field": "method", "op": "equals", "value": "PUT" },
          { "field": "method", "op": "equals", "value": "POST" },
          { "field": "method", "op": "equals", "value": "DELETE" }
        ]
      }
    ]
  },
  "action": {
    "type": "blockRequest",
    "config": {
      "statusCode": 0,
      "simulateTimeout": true,
      "timeoutMs": 15000,
      "errorMessage": "EDOG Chaos: Selective blackhole — OneLake write operations blocked"
    }
  },
  "phase": "request",
  "priority": 20,
  "probability": 1.0,
  "limits": { "maxFirings": 50, "ttlSeconds": 300 }
}
```

**C# Mechanism:**
Same as TC-01 — `blockRequest` with `simulateTimeout: true`. The selectivity comes entirely from the compound predicate (AND of httpClientName + OR of methods).

**FLT Code Path (CLEAN):**
- `OneLake/OnelakeBasedFileSystem.cs:CreateOrUpdateFileAsync` → PUT → **blocked**
- `OneLake/OnelakeBasedFileSystem.cs:DeleteFileIfExistsAsync` → DELETE → **blocked**
- `OneLake/OnelakeBasedFileSystem.cs:ReadFileAsStringAsync` → GET → **passes through**
- `OneLake/OnelakeBasedFileSystem.cs:ExistsAsync` → HEAD → **passes through**
- Retry via `OneLakeRetryPolicyProvider` applies only to blocked requests

**Edge Cases:**
- Azure DataLake SDK uses `PUT` for file creates AND updates — blocking PUT blocks both new file creation and file overwrite.
- Some list operations use `GET` with query params, not `PUT` — they pass through the selective blackhole. This is correct behavior.
- `RenameFileAsync` in the DataLake SDK may use non-standard HTTP methods — verify at implementation time.

**Interactions:**
- **Combines with C02 RF-06 (Empty Body):** A write blackhole + empty body on read responses simulates "OneLake is up but data is gone."
- **Combines with TC-07 (Intermittent):** Adding probability < 1.0 to this rule creates "flaky writes" — more realistic than total write blackhole.

**Revert:** Same as TC-01. Disable rule → writes resume.

**Priority:** P0 — Partial service degradation is the most common production failure pattern. Total outages are rare; asymmetric failures are constant.

---

### TC-03: Bandwidth Throttle

**One-liner:** Limit response throughput to N KB/sec — simulate slow network or congested link.

**Description:**
Instead of blocking or delaying the entire request, this drip-feeds the response body at a controlled rate. A 10MB Parquet file response at 10 KB/s takes ~17 minutes. This tests whether FLT's timeouts are configured correctly and whether streaming consumers handle slow data gracefully.

**What this tests in FLT:**
- **HttpClient.Timeout interaction:** The default 100s `HttpClient.Timeout` measures time-to-first-byte for some operations, not total transfer time. If the response starts arriving but is slow, the timeout may or may not fire depending on the HTTP layer implementation. This scenario exposes that ambiguity.
- **Large delta log reads:** `LakeHouseMetastoreClientWithShortcutSupport` reads delta transaction logs, which can be large. Throttling these tests whether FLT has streaming timeouts or relies solely on connection-level timeouts.
- **Parquet preview reads:** `OnelakeBasedFileSystem.ReadFileBytesAsync` for binary file reads — at low bandwidth, the read takes minutes. Does FLT's `RequestTimeoutAttribute` (1-minute default) cancel the upstream request before the downstream read completes?

**ChaosRule JSON:**
```json
{
  "id": "tc03-throttle-onelake-10kbps",
  "name": "Throttle OneLake to 10 KB/s",
  "description": "Limit OneLake response throughput to 10 KB/sec. Tests timeout behavior on large reads.",
  "category": "traffic-control",
  "tags": ["onelake", "bandwidth", "slow-network", "timeout"],
  "predicate": {
    "field": "httpClientName",
    "op": "equals",
    "value": "DatalakeDirectoryClient"
  },
  "action": {
    "type": "throttleBandwidth",
    "config": {
      "bytesPerSecond": 10240,
      "direction": "response"
    }
  },
  "phase": "response",
  "priority": 50,
  "probability": 1.0,
  "limits": { "ttlSeconds": 180 }
}
```

**C# Mechanism:**
```csharp
// In EdogHttpPipelineHandler, after base.SendAsync():
// Replace the response content stream with a throttled wrapper.
if (action.Type == "throttleBandwidth")
{
    var originalContent = response.Content;
    var originalStream = await originalContent.ReadAsStreamAsync(cancellationToken);
    var throttledStream = new ThrottledReadStream(originalStream, action.Config.BytesPerSecond);
    response.Content = new StreamContent(throttledStream);
    // Copy original headers to new StreamContent
    foreach (var header in originalContent.Headers)
        response.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
}

// ThrottledReadStream: reads in chunks, inserting Task.Delay between chunks
// to maintain target bytes/sec throughput.
```

**FLT Code Path (CLEAN):**
- `OneLake/OnelakeBasedFileSystem.cs:ReadFileBytesAsync` → large binary reads
- `OneLake/OnelakeBasedFileSystem.cs:ReadFileAsStringAsync` → delta log reads
- `LakeHouseMetastoreClientWithShortcutSupport` → catalog metadata via DataLake SDK
- `MoveToWcl/RequestExecution/RequestTimeoutAttribute.cs:22` — `DefaultRequestTimeout = TimeSpan.FromMinutes(1)` — the upstream request may timeout before the slow downstream read completes

**Edge Cases:**
- If `bytesPerSecond` is very low (< 100), the throttled stream may hit the `HttpClient.Timeout` even for small responses. This is intentional — it's the test.
- The Azure DataLake SDK may buffer the entire response before returning to FLT. If so, throttling appears as a large initial delay rather than a slow drip. Must test with real SDK behavior.
- Response-phase throttling doesn't affect the request direction (uploads). For upload throttling, a separate request-phase action would be needed.
- Throttling a response that's already in the FLT content pipeline may not be cancellable by the upstream `RequestTimeoutAttribute` CancellationToken — depends on whether FLT passes the token through to stream reads.

**Interactions:**
- **Stacks with TC-01/TC-02 (Blackhole):** If a blackhole rule fires first (lower priority), the request never reaches the response phase where throttling applies.
- **Stacks with C02 RF-10 (Slow Drip):** RF-10 injects synthetic slow response content. TC-03 throttles any response. They differ: RF-10 replaces the response, TC-03 slows the real response.

**Revert:** Disable rule. Throttled streams in flight continue at their current rate until the read completes, but no new responses are throttled.

**Priority:** P1 — Important for understanding timeout behavior, but less common than total outages or 429 storms in production.

---

### TC-04: Connection Reset

**One-liner:** Throw `HttpRequestException` after N bytes to simulate TCP RST / connection drop mid-transfer.

**Description:**
The response starts arriving normally, then after N bytes the connection "drops" — FLT receives an `HttpRequestException` or `IOException` mid-read. This is nastier than a blackhole (which fails immediately) because FLT may have already begun processing partial data.

**What this tests in FLT:**
- **Partial read corruption:** If FLT reads half a JSON response body before the connection drops, does the deserializer throw a clean error or silently use partial data?
- **DataLake SDK resilience:** The Azure DataLake SDK may buffer internally. A mid-stream disconnect may surface as a `RequestFailedException` or as corrupted data depending on buffer state.
- **Retry behavior on connection errors:** `OneLakeRetryPolicyProvider` handles `HttpRequestException` (line 59) and retries. But the retry sends a fresh request — does FLT handle the state transition from "partial data received" to "full retry"?

**ChaosRule JSON:**
```json
{
  "id": "tc04-reset-after-1kb",
  "name": "Connection Reset After 1KB",
  "description": "Simulate TCP RST after transmitting first 1024 bytes of response. Tests partial read handling.",
  "category": "traffic-control",
  "tags": ["connection", "reset", "partial-data", "tcp"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "action": {
    "type": "dropConnection",
    "config": {
      "afterBytes": 1024,
      "errorMessage": "EDOG Chaos: Connection reset after 1024 bytes"
    }
  },
  "phase": "response",
  "priority": 50,
  "probability": 1.0,
  "limits": { "maxFirings": 10, "ttlSeconds": 120 }
}
```

**C# Mechanism:**
```csharp
// Replace response content stream with a LimitedReadStream that throws after N bytes:
if (action.Type == "dropConnection" && action.Config.AfterBytes > 0)
{
    var originalStream = await response.Content.ReadAsStreamAsync(ct);
    var limitedStream = new ConnectionResetStream(originalStream, action.Config.AfterBytes);
    response.Content = new StreamContent(limitedStream);
    // ConnectionResetStream.Read(): counts bytes read, throws IOException
    // ("Connection reset by peer") after limit reached.
}

// If afterBytes == 0, throw immediately (same as dropConnection without afterBytes):
throw new HttpRequestException(action.Config.ErrorMessage);
```

**FLT Code Path (CLEAN):**
- `OneLake/OnelakeBasedFileSystem.cs:ReadFileAsStringAsync` → reads full content into string, IOException mid-read
- `OneLake/OnelakeBasedFileSystem.cs:ReadFileBytesAsync` → reads bytes, IOException mid-read
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:59` — `Or<HttpRequestException>()` — retries on connection errors
- `OneLake/OneLakeRestClient.cs:ListDirsAsync` → JSON deserialization of partial response

**Edge Cases:**
- If `afterBytes` > actual response size, the connection "reset" never fires — the response completes normally. The rule is effectively a no-op for small responses.
- `afterBytes: 0` should throw before reading any bytes — equivalent to immediate connection refusal.
- Multiple concurrent requests may hit the same rule — each gets its own byte counter (rule is stateless per invocation).
- If the DataLake SDK reads the entire response into a buffer before returning to FLT, the IOException happens inside the SDK, not in FLT code. The SDK translates it to `RequestFailedException`.

**Interactions:**
- **Conflicts with TC-03 (Bandwidth Throttle):** Both replace the response content stream. If both active at the same priority, the later one overwrites the earlier one's stream wrapper. Solution: TC-04 should wrap TC-03's throttled stream, not replace it. The engine must compose stream wrappers.
- **Stacks with retry observation:** When the connection resets, FLT's retry policy kicks in. The `EdogRetryInterceptor` observes the retry attempt via log parsing. The Traffic Monitor shows the original request as "connection reset" and the retry as a new request.

**Revert:** Disable rule. In-flight streams that already have the `ConnectionResetStream` wrapper will still fire (the wrapper is already installed). New requests get clean streams.

**Priority:** P1 — Mid-transfer failures are harder to debug than clean failures. This scenario has caught real bugs in production SDKs.

---

### TC-05: 429 Storm

**One-liner:** Return HTTP 429 with configurable `Retry-After` for all calls to a target service — test retry amplification.

**Description:**
This is the **highest-value** traffic control scenario. Return 429 (Too Many Requests) for matching requests with a controlled `Retry-After` header. This directly exercises FLT's three retry subsystems simultaneously and exposes retry amplification — the most dangerous failure mode in distributed systems.

**What this tests in FLT:**
- **OneLake 429 handling:** `OneLakeRetryPolicyProvider.ShouldRetryOneLakeResponse()` returns `true` for 429 (line 124: `statusCode == 429`). The policy checks for `Retry-After` header (line 70). If present, it uses the server-specified delay. If absent, it falls back to exponential backoff. With chaos, we control exactly what `Retry-After` value the policy sees.
- **Retry amplification:** If a DAG has 10 nodes, each making 5 OneLake calls, and each call retries 3 times on 429 → 10 × 5 × 3 = 150 total requests instead of 50. With `Retry-After: 60s`, total wall time explodes to minutes per node.
- **Capacity retry (430) interaction:** If the 429 storm also triggers capacity constraints upstream, FLT enters the `CapacityRetryStrategy` admission window (20s, 40s, 60s, 90s, 90s, 90s) — ~6 minutes of waiting before extended mode.
- **Fabric API 429:** `FabricApiClient.HandleLongRunningOperationAsync` (line 208) retries on 429 with a 5-second delay — much shorter than OneLake's exponential backoff. Tests whether the two retry cadences interfere.

**ChaosRule JSON:**
```json
{
  "id": "tc05-429-storm-onelake",
  "name": "429 Storm — OneLake",
  "description": "Return 429 with Retry-After:30 for all OneLake calls. Tests retry amplification and backoff behavior.",
  "category": "traffic-control",
  "tags": ["429", "throttle", "retry", "onelake", "amplification"],
  "predicate": {
    "operator": "or",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" }
    ]
  },
  "action": {
    "type": "blockRequest",
    "config": {
      "statusCode": 429,
      "body": "{\"error\":{\"code\":\"TooManyRequests\",\"message\":\"EDOG Chaos: 429 storm active\"}}",
      "headers": {
        "Retry-After": "30",
        "Content-Type": "application/json"
      }
    }
  },
  "phase": "request",
  "priority": 10,
  "probability": 1.0,
  "limits": { "ttlSeconds": 180, "maxFirings": 100 }
}
```

**C# Mechanism:**
```csharp
// blockRequest with statusCode > 0: return a synthetic HttpResponseMessage
// instead of calling base.SendAsync()
if (action.Type == "blockRequest" && action.Config.StatusCode > 0)
{
    var response = new HttpResponseMessage((HttpStatusCode)action.Config.StatusCode);
    response.Content = new StringContent(action.Config.Body ?? "");

    foreach (var header in action.Config.Headers)
        response.Headers.TryAddWithoutValidation(header.Key, header.Value);

    // DO NOT call base.SendAsync() — short-circuit the pipeline
    return response;
}
```

**FLT Code Path (CLEAN):**
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:124` — `ShouldRetryOneLakeResponse`: `statusCode == 429` → returns true
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:67-78` — checks `Retry-After` header: `"30"` parsed to `TimeSpan.FromSeconds(30)`
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:62-85` — `WaitAndRetryAsync` sleepDurationProvider: returns 30s from Retry-After
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:93-96` — `onRetryAsync` logs `[ONELAKE_RETRY] Attempt N/M - HTTP 429 Rate Limited`
- After `OneLakeMaxRetryAttempts` retries, exception propagates to DAG node executor

**Edge Cases:**
- **Retry-After: 0** — FLT retries immediately with no delay. This creates a busy-loop of 429s until `maxRetryCount` is exhausted. CPU spike on the FLT process.
- **Retry-After as HTTP-date:** `OneLakeRetryPolicyProvider.GetRetryDelayFromResponse()` (line 162) parses both seconds and absolute dates. Test with `"Retry-After": "Thu, 01 Jan 2099 00:00:00 GMT"` — FLT waits billions of seconds (effectively hangs). The chaos rule should warn if Retry-After > TTL.
- **Missing Retry-After header:** If `headers` omits `Retry-After`, FLT falls back to exponential backoff (`ExponentialBackoffStrategy`). This is important to test — real 429s sometimes lack the header (line 78: "429 received without Retry-After header").
- **maxFirings < retryCount:** If `maxFirings: 3` but FLT retries 5 times, the first 3 attempts get 429, then the rule auto-expires and attempt 4 succeeds. This creates a "transient 429" scenario — useful for testing recovery.

**Interactions:**
- **Combines with TC-07 (Intermittent):** `probability: 0.3` + 429 → 30% of requests get throttled. More realistic than a 100% storm.
- **Conflicts with TC-01/TC-02 (Blackhole):** Can't return 429 if the request is blackholed. Priority resolves — lower priority number wins.
- **Observed by EdogRetryInterceptor:** The retry interceptor (`EdogRetryInterceptor.cs`) detects 429 via regex log parsing. Each retry shows up in the Retry Tab. The Traffic Monitor shows the original request + each retry attempt.

**Revert:** Disable rule. Pending retries (in `Task.Delay` waiting for `Retry-After`) continue with their current delay, but the next actual request goes to the real service.

**Priority:** P0 — 429 storms are the #1 cause of cascading failures in Fabric services. This is the single most valuable traffic control scenario.

---

### TC-06: 503 Outage

**One-liner:** Return HTTP 503 for all calls to a specific service — simulate complete service outage.

**Description:**
Returns 503 (Service Unavailable) for all requests matching a target service. Unlike a blackhole (which simulates network failure), 503 simulates "the service is up but refusing requests" — a different failure mode that produces a different response shape and triggers different retry behavior.

**What this tests in FLT:**
- **OneLake 503 handling:** `OneLakeRetryPolicyProvider.ShouldRetryOneLakeResponse()` returns `true` for all 5xx (line 124: `statusCode >= 500`). The retry policy uses exponential backoff (no `Retry-After` on 503 typically). Tests the backoff timing and max retry behavior.
- **Fabric API 503 handling:** `FabricApiClient.HandleLongRunningOperationAsync` (line 207) explicitly retries on `ServiceUnavailable` with a 5-second delay.
- **Error message propagation:** Does FLT surface the 503 error message to the user? Or does it swallow it and report a generic "operation failed"?

**ChaosRule JSON:**
```json
{
  "id": "tc06-503-fabric-api",
  "name": "503 Outage — Fabric API",
  "description": "Simulate Fabric API outage. All Fabric API calls return 503.",
  "category": "traffic-control",
  "tags": ["503", "outage", "fabric-api", "unavailable"],
  "predicate": {
    "field": "httpClientName",
    "op": "equals",
    "value": "PbiSharedApiClient"
  },
  "action": {
    "type": "blockRequest",
    "config": {
      "statusCode": 503,
      "body": "{\"error\":{\"code\":\"ServiceUnavailable\",\"message\":\"EDOG Chaos: Simulated Fabric API outage\"}}",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  },
  "phase": "request",
  "priority": 10,
  "probability": 1.0,
  "limits": { "ttlSeconds": 120 }
}
```

**C# Mechanism:**
Same as TC-05 — `blockRequest` with `statusCode: 503`. Short-circuits the pipeline, returns synthetic 503.

**FLT Code Path (CLEAN):**
- `DataQuality/FabricApiClient.cs:GetLakehouseDetailsAsync` → 503 → falls through to `EnsureSuccessStatusCode` → throws `HttpRequestException`
- `DataQuality/FabricApiClient.cs:HandleLongRunningOperationAsync:207` → 503 → retries with 5s delay in the polling loop
- `DataQuality/FabricApiClient.cs:RunTableMaintenanceAsync` → 503 → specific exception handling per status code
- `RetryPolicy/OneLakeRetryPolicyProvider.cs:124` — `statusCode >= 500` → retries with exponential backoff

**Edge Cases:**
- **503 with `Retry-After` header:** Some services return 503 with a `Retry-After` hint for planned maintenance. The current `OneLakeRetryPolicyProvider` only checks `Retry-After` on 429, not on 503 (line 67: `response?.StatusCode == HttpStatusCode.TooManyRequests`). Adding `Retry-After` to a 503 response tests whether FLT's retry uses exponential backoff even when the server says "try again in 5s."
- **Partial 503:** Not all endpoints of a service fail simultaneously. Combining TC-06 with a URL-based predicate (e.g., only `/workspaces/{id}/lakehouses` returns 503) creates a more realistic partial outage.

**Interactions:**
- **Combines with TC-05 (429 Storm):** 503 on Fabric API + 429 on OneLake = dual service degradation. Tests FLT's behavior when multiple dependencies fail simultaneously.
- **Combines with C01 RS-01 (Latency):** Slow Fabric API + 503 OneLake = compounding failures.

**Revert:** Disable rule. Immediate effect.

**Priority:** P0 — Service outages happen monthly. FLT must handle them gracefully, surface clear errors, and not hang indefinitely.

---

### TC-07: Intermittent Failure

**One-liner:** Fail N% of requests randomly — the most realistic chaos scenario.

**Description:**
Uses the `probability` field to randomly fail a percentage of matching requests. This is more realistic than total outages — in production, services don't go fully down, they become **flaky**. 10% failure rate is enough to cause cascading retries; 50% is catastrophic.

**What this tests in FLT:**
- **Retry policy effectiveness:** With 30% failure rate, most requests eventually succeed after 1-2 retries. But some hit 3 consecutive failures and exhaust the retry budget. What's the observed success rate after retries? Is it acceptable?
- **DAG execution resilience:** A DAG with 20 nodes, each making 5 OneLake calls, at 10% failure rate: ~10 of 100 total calls fail on first try. After 3 retries, expected success rate is `1 - 0.1^3 = 99.9%`. But at 50% failure rate: `1 - 0.5^3 = 87.5%` success — 12-13 calls fail permanently, potentially killing multiple DAG nodes.
- **Non-deterministic debugging:** Intermittent failures are the hardest to debug. This scenario lets the developer experience exactly what production looks like.

**ChaosRule JSON:**
```json
{
  "id": "tc07-intermittent-30pct-onelake",
  "name": "Intermittent 30% OneLake Failures",
  "description": "Randomly fail 30% of OneLake calls with 500. Tests retry effectiveness and DAG resilience.",
  "category": "traffic-control",
  "tags": ["intermittent", "flaky", "random", "onelake"],
  "predicate": {
    "operator": "or",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" }
    ]
  },
  "action": {
    "type": "blockRequest",
    "config": {
      "statusCode": 500,
      "body": "{\"error\":{\"code\":\"InternalServerError\",\"message\":\"EDOG Chaos: Intermittent failure (30% probability)\"}}",
      "headers": { "Content-Type": "application/json" }
    }
  },
  "phase": "request",
  "priority": 50,
  "probability": 0.3,
  "limits": { "ttlSeconds": 300 }
}
```

**C# Mechanism:**
The `probability` field is evaluated by the `ChaosRuleEngine` before executing the action:
```csharp
// In ChaosRuleEngine.EvaluateRequest():
if (rule.Probability < 1.0)
{
    if (Random.Shared.NextDouble() > rule.Probability)
    {
        // Probability check failed — skip this rule, pass through
        PublishSkipEvent(rule, "probability");
        continue;
    }
}
// Probability check passed — execute the action
```

**FLT Code Path (CLEAN):**
- Same as TC-05/TC-06 — `ShouldRetryOneLakeResponse()` returns `true` for 500
- Each failed request triggers retry; each retry independently rolls the probability dice
- A request that fails on attempt 1 has a 70% chance of succeeding on attempt 2 (independent probability)
- Expected retries per original request at 30% failure: `sum(0.3^n * n for n in 1..maxRetries)` ≈ 0.4 retries/request average

**Edge Cases:**
- **Probability applied per-attempt, not per-request:** When FLT's retry policy resends the request, it hits the chaos rule again. Each attempt independently evaluates probability. This is correct — it matches real-world flakiness where each call has independent failure probability.
- **Seed consistency:** `Random.Shared` is not deterministic. Two runs with the same rule produce different failure patterns. If deterministic replay is needed, a future enhancement could add a `seed` field to the rule.
- **Combined status codes:** The rule returns 500, but real intermittent failures have varied status codes (500, 502, 503, 504). A preset scenario (C06 AD-05) could combine multiple rules with different status codes at different probabilities.

**Interactions:**
- **Stacks with any other rule:** Probability is evaluated first, so this rule "gates" any action. A 30% intermittent + 429 response → 30% of requests get 429, 70% pass through.
- **Observed by EdogRetryInterceptor:** Each failure + retry cycle is visible. The Traffic Monitor shows which requests were "unlucky" (failed by probability) vs "lucky" (passed through).

**Revert:** Disable rule. Immediate effect — next request has 0% failure probability.

**Priority:** P0 — This is the chaos scenario closest to real production behavior. Every engineer should run this at least once.

---

### TC-08: Request Queue (Burst Release)

**One-liner:** Hold requests for N seconds then release all at once — simulate network partition recovery thundering herd.

**Description:**
When a network partition heals, all queued requests hit the downstream service simultaneously. This scenario collects matching requests for a configurable duration, holds them, then releases them all at once. The downstream service sees a burst of N concurrent requests instead of a steady trickle.

**What this tests in FLT:**
- **Connection pool behavior:** .NET's `HttpClient` has connection pool limits per endpoint (`ServicePointManager.DefaultConnectionLimit` or `SocketsHttpHandler.MaxConnectionsPerServer`). A burst of 50 concurrent requests to OneLake may exceed the connection pool, causing some to queue at the HTTP layer.
- **Concurrent write conflicts:** If multiple DAG nodes write to the same OneLake directory simultaneously, do they encounter write conflicts? Conditional access (`If-None-Match`) failures?
- **Token refresh storm:** All released requests need valid tokens. If tokens expired during the hold period, all requests trigger token refresh simultaneously.

**ChaosRule JSON:**
```json
{
  "id": "tc08-queue-release-onelake",
  "name": "Queue & Release — OneLake (30s hold)",
  "description": "Hold OneLake requests for 30 seconds, then release all simultaneously. Tests thundering herd.",
  "category": "traffic-control",
  "tags": ["queue", "burst", "thundering-herd", "onelake"],
  "predicate": {
    "field": "httpClientName",
    "op": "equals",
    "value": "DatalakeDirectoryClient"
  },
  "action": {
    "type": "delay",
    "config": {
      "delayMs": 30000,
      "jitterMs": 0,
      "mode": "synchronized"
    }
  },
  "phase": "request",
  "priority": 50,
  "probability": 1.0,
  "limits": { "ttlSeconds": 60, "maxFirings": 100 }
}
```

**C# Mechanism:**
```csharp
// "synchronized" mode delay: all requests arriving within a window are held
// until a shared barrier releases them simultaneously.
//
// Implementation: ChaosRuleEngine maintains a per-rule SemaphoreSlim or
// TaskCompletionSource. When mode == "synchronized":
//   1. First request arriving starts a timer (delayMs)
//   2. Subsequent requests await the same TaskCompletionSource
//   3. When timer fires, TCS.SetResult(true) — all waiters release simultaneously
//   4. New TCS created for next window

if (action.Config.Mode == "synchronized")
{
    var barrier = engine.GetOrCreateBarrier(rule.Id, action.Config.DelayMs);
    await barrier.WaitAsync(cancellationToken);
    // All requests released — proceed to base.SendAsync()
}
else
{
    // Standard delay mode (per-request, independent)
    var jitter = Random.Shared.Next(-action.Config.JitterMs, action.Config.JitterMs + 1);
    await Task.Delay(action.Config.DelayMs + jitter, cancellationToken);
}
```

**FLT Code Path (CLEAN):**
- All OneLake calls via `DatalakeDirectoryClient` are held
- During hold: `OneLakeRetryPolicyProvider`'s cancellation check — `Or<TaskCanceledException>(ex => !cancellationToken.IsCancellationRequested)` — if the upstream `RequestTimeoutAttribute` (1 min) fires during the 30s hold, the cancellation token triggers and the request is cancelled (NOT retried, because `cancellationToken.IsCancellationRequested` is true)
- After release: burst of N requests to OneLake simultaneously

**Edge Cases:**
- **Cancellation during hold:** If FLT's upstream timeout cancels the request while it's held, the request is dropped. The `await barrier.WaitAsync(cancellationToken)` throws `OperationCanceledException`, which propagates up as a cancellation (not a retry-eligible failure).
- **maxFirings interaction:** If `maxFirings: 100` and 50 requests are held, firing count increments to 50. If another 60 arrive, only the first 50 get the remaining firings; the last 10 pass through unheld (creating an asymmetric burst).
- **Memory pressure:** Holding 100 requests means 100 request objects + contexts in memory. For large request bodies, this could cause memory spikes. Set `maxFirings` conservatively.

**Interactions:**
- **Conflicts with TC-01 (Blackhole):** Blackhole fires at priority 10, queue at priority 50. If both active, requests are blackholed before they can be queued.
- **Combines with TC-05 (429 Storm):** Queue requests → release → all hit a 429-returning rule → all retry simultaneously → secondary thundering herd.

**Revert:** Disable rule. Held requests release immediately when the rule is disabled (the barrier TCS is completed on rule deactivation).

**Priority:** P2 — Thundering herd is a real production pattern, but less common than sustained failures. Important for capacity planning.

---

### TC-09: Reverse Priority (Latency Inversion)

**One-liner:** Slow down fast requests, speed up slow ones — invert expected latency ordering.

**Description:**
For requests that would normally be fast (small GET requests, health checks), inject high latency. For requests that are normally slow (large file uploads, batch operations), reduce or skip the delay. This creates a latency inversion that can confuse timeout tuning and expose hardcoded timeout assumptions.

**What this tests in FLT:**
- **Timeout configuration assumptions:** If FLT has different timeouts for "fast" vs "slow" operations, latency inversion may cause fast operations to timeout while slow operations succeed. This exposes whether timeouts are tuned per-operation or globally.
- **DAG scheduling assumptions:** The DAG scheduler may assume that listing operations (fast) complete before data operations (slow). Latency inversion reverses this ordering, potentially causing schedule violations.
- **Progress reporting:** If progress is based on completed operations, inverted latency makes progress bars go backward (fast ops that should complete first are delayed).

**ChaosRule JSON:**
```json
{
  "id": "tc09-inversion-fast-ops",
  "name": "Latency Inversion — Slow Down Fast Ops",
  "description": "Add 10s delay to GET requests on OneLake. Tests timeout tuning for read operations.",
  "category": "traffic-control",
  "tags": ["latency", "inversion", "timeout", "ordering"],
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "action": {
    "type": "delay",
    "config": {
      "delayMs": 10000,
      "jitterMs": 2000
    }
  },
  "phase": "request",
  "priority": 50,
  "probability": 1.0,
  "limits": { "ttlSeconds": 180 }
}
```

**C# Mechanism:**
```csharp
// Standard delay action — Task.Delay with optional jitter
if (action.Type == "delay")
{
    var jitter = action.Config.JitterMs > 0
        ? Random.Shared.Next(-action.Config.JitterMs, action.Config.JitterMs + 1)
        : 0;
    var totalDelay = Math.Max(0, action.Config.DelayMs + jitter);
    await Task.Delay(totalDelay, cancellationToken);
}
// Then proceed to base.SendAsync() — the real request is sent after the delay
```

**FLT Code Path (CLEAN):**
- `OneLake/OnelakeBasedFileSystem.cs:ExistsAsync` (HEAD) — normally ~50ms, now 10s+
- `OneLake/OnelakeBasedFileSystem.cs:ReadFileAsStringAsync` (GET) — normally ~200ms for small files, now 10s+
- `OneLake/OneLakeRestClient.cs:ListDirsAsync` (GET) — normally ~100ms, now 10s+
- DAG scheduler calls these in sequence — 10 GET operations = 100s+ of added delay
- `MoveToWcl/RequestExecution/RequestTimeoutAttribute.cs:22` — `DefaultRequestTimeout = TimeSpan.FromMinutes(1)` — may fire if enough delayed operations stack up within one request

**Edge Cases:**
- **Jitter sign:** `jitterMs: 2000` means delay ranges from 8s to 12s (10000 ± 2000). Ensure the engine doesn't produce negative total delays (clamped to 0).
- **Cancellation during delay:** If the upstream CancellationToken fires during `Task.Delay`, the request is cancelled. For a 10s delay, this is unlikely with a 60s request timeout — but if multiple delayed operations chain sequentially, cumulative delay exceeds the timeout.
- **Compound latency:** Delay is added BEFORE `base.SendAsync()`. The total request time = chaos delay + real network time. A 10s delay on a normally-200ms request = 10.2s total.

**Interactions:**
- **Pair with a second rule for "fast slow ops":** Create a companion rule that matches PUT/POST and applies `delayMs: 0` (no-op, effectively) to make the "inversion" explicit. The insight is that the inversion comes from slowing fast ops, not from speeding slow ones.
- **Stacks with TC-07 (Intermittent):** Delay + intermittent failure = some requests are delayed AND then fail. Double penalty.

**Revert:** Disable rule. Immediate — next request has no injected delay.

**Priority:** P2 — Useful for finding timeout bugs but less directly tied to production failure patterns than 429/503 scenarios.

---

### TC-10: Connection Pool Exhaustion

**One-liner:** Hold connections open without responding — exhaust the HTTP connection pool to simulate resource starvation.

**Description:**
Instead of blocking or delaying, this scenario holds the `SendAsync` call open indefinitely (or for a very long duration) without returning a response. This ties up an HTTP connection slot. With enough concurrent held connections, the `HttpClient`'s connection pool is exhausted — subsequent requests queue at the transport layer waiting for a free connection.

**What this tests in FLT:**
- **Connection pool limits:** .NET's `SocketsHttpHandler` defaults to `MaxConnectionsPerServer = int.MaxValue` (effectively unlimited). But if FLT or the DataLake SDK configures a lower limit, pool exhaustion causes all new requests to block waiting for a free connection.
- **Thread pool starvation:** Each held request occupies a thread (or async continuation). With enough held requests, the thread pool runs out, causing secondary failures in unrelated operations.
- **Cascading timeout:** If 10 connections are held to OneLake, and the 11th request waits for a free connection, the 11th request's timeout includes the wait time. If the pool wait exceeds `HttpClient.Timeout`, the 11th request fails with `TaskCanceledException` — even though the service is healthy.

**ChaosRule JSON:**
```json
{
  "id": "tc10-pool-drain-onelake",
  "name": "Connection Pool Drain — OneLake",
  "description": "Hold OneLake connections open for 120s without responding. Drains connection pool to test queuing.",
  "category": "traffic-control",
  "tags": ["connection-pool", "resource-starvation", "drain", "onelake"],
  "predicate": {
    "field": "httpClientName",
    "op": "equals",
    "value": "DatalakeDirectoryClient"
  },
  "action": {
    "type": "delay",
    "config": {
      "delayMs": 120000,
      "jitterMs": 0
    }
  },
  "phase": "request",
  "priority": 50,
  "probability": 1.0,
  "limits": { "maxFirings": 20, "ttlSeconds": 180 }
}
```

**C# Mechanism:**
```csharp
// This uses the standard delay action with a very long delay.
// The chaos happens not from the delay itself, but from multiple concurrent
// requests being held simultaneously — each consuming a connection slot.
//
// Key: The delay is applied BEFORE base.SendAsync(), so no real connection
// is established. The "drain" is actually thread/async-context drain, not
// TCP connection drain.
//
// For true connection-level drain (holding open TCP connections), we would need
// to call base.SendAsync() first (establishing the connection) and then hold
// the response stream open without reading it. This requires a response-phase
// action variant:

if (action.Type == "delay" && action.Phase == "response")
{
    // Real connection drain: send the request, get the response,
    // then delay before returning to FLT — holding the connection open
    var response = await base.SendAsync(request, ct);
    await Task.Delay(action.Config.DelayMs, ct);
    return response;
}
```

**FLT Code Path (CLEAN):**
- All 13 `IFileSystem` methods in `OnelakeBasedFileSystem.cs` go through `DatalakeDirectoryClient`
- `OneLakeRestClient.cs:ListDirsAsync` uses `OneLakeRestClient` (separate client, separate pool)
- With `maxFirings: 20`, 20 concurrent OneLake file operations are held — if a DAG has 5 parallel nodes each making 4 OneLake calls, that's all 20 slots consumed
- Subsequent OneLake calls (from other nodes or retry attempts) wait at the handler level

**Edge Cases:**
- **Pre-send vs post-send drain:** The JSON above uses a pre-send delay (`phase: request`), which doesn't actually establish a TCP connection — it drains async contexts, not connections. For true TCP connection drain, the action should be post-send (`phase: response`). The spec supports both, but the UI should clarify the difference.
- **maxFirings critical:** Without a `maxFirings` limit, every OneLake call gets held for 120s. This can crash the FLT process (OOM from accumulated request contexts). Always set conservative limits.
- **CancellationToken race:** The upstream `RequestTimeoutAttribute` (60s) fires before the 120s drain delay completes. The request is cancelled, freeing the async context. This means true pool drain requires `delayMs` < `RequestTimeoutInterval`.
- **Memory accumulation:** Each held request retains its `HttpRequestMessage`, headers, and body in memory. For POST/PUT requests with large bodies, 20 held requests could consume significant memory.

**Interactions:**
- **Amplified by TC-07 (Intermittent):** If 30% of requests fail AND the successful ones are held for 120s, the failed requests retry while the successful ones are still waiting. Retry attempts add to the drain count.
- **Conflicts with TC-01 (Blackhole):** Blackhole fires first (priority 10) and short-circuits — requests never reach the delay action (priority 50).

**Revert:** Disable rule. Held requests remain in `Task.Delay` until they complete or are cancelled by the upstream CancellationToken. No new requests are held.

**Priority:** P2 — Resource exhaustion is a real production failure mode, but harder to reproduce meaningfully in a single-process dev environment.

---

## Cross-Cutting Concerns

### Retry Amplification Calculator

The Traffic Monitor should include a **Retry Amplification** metric:

```
Amplification Factor = Total Requests Sent (including retries) / Original Requests Initiated
```

For TC-05 (429 Storm) with `maxRetries: 3`:
- Original requests: 50
- Retries: 50 × 3 = 150
- Total: 200
- Amplification factor: 4.0×

The UI should show this prominently when traffic control rules are active.

### Interaction with EdogRetryInterceptor

Every traffic control scenario that returns a retriable status code (429, 500, 503) will trigger FLT's retry policies. The `EdogRetryInterceptor` (`EdogRetryInterceptor.cs`) observes these retries via log parsing. The Traffic Monitor must correlate:
1. The original request (marked as "chaos-affected")
2. The FLT retry attempts (marked as "retry of request #N")
3. Which chaos rule caused the original failure
4. The final outcome (success after N retries, or permanent failure)

### Safety: Cascading Failure Prevention

Traffic control rules can create cascading failures:
- 429 storm → retry amplification → thread pool exhaustion → FLT process hang
- Connection drain → pool exhaustion → cascading timeouts → all operations fail

The engine's **FLT Health Guard** (from `engine-design.md §Safety`) must monitor:
- Response time P99 > 30s → auto-pause all traffic control rules
- Error rate > 80% for 30 seconds → auto-disable all rules
- FLT process memory > 2GB → auto-disable all rules
- Unhandled exception count > 5 in 60s → kill switch

### Coverage Gap: Spark/GTS Traffic

Per `interceptor-audit.md §3.1 GAP-1`: Spark calls via `GTSBasedSparkClient` bypass `IHttpClientFactory` and are **NOT intercepted** by `EdogHttpPipelineHandler`. Traffic control rules do not affect Spark traffic until the `SendHttpRequestAsync()` override is implemented (P0 from §3.5).

This means:
- TC-05 (429 Storm) does not affect Spark submit/status/cancel calls
- TC-06 (503 Outage) does not affect Spark calls
- FLT's `RetryPolicyProviderV2.CreateSparkTransformSubmitRetryPolicy()` and `CapacityRetryStrategy` (430 handling) cannot be tested via these rules

**Mitigation:** The Spark interception gap (GAP-1) is P0 for the chaos panel. Until resolved, Spark traffic control scenarios should be documented but flagged as "pending interceptor upgrade."

---

## Priority Summary

| ID | Name | Priority | Rationale |
|----|------|----------|-----------|
| TC-01 | Blackhole | P0 | Fundamental resilience test |
| TC-02 | Selective Blackhole | P0 | Most common production failure pattern |
| TC-05 | 429 Storm | P0 | #1 cause of cascading failures |
| TC-06 | 503 Outage | P0 | Monthly occurrence in Fabric |
| TC-07 | Intermittent Failure | P0 | Closest to real production behavior |
| TC-03 | Bandwidth Throttle | P1 | Important for timeout understanding |
| TC-04 | Connection Reset | P1 | Catches real SDK bugs |
| TC-08 | Request Queue | P2 | Thundering herd — real but infrequent |
| TC-09 | Reverse Priority | P2 | Timeout tuning tool |
| TC-10 | Connection Pool Drain | P2 | Resource exhaustion — harder to reproduce meaningfully |

**Implementation order:** TC-05 → TC-01 → TC-07 → TC-06 → TC-02 → TC-04 → TC-03 → TC-09 → TC-08 → TC-10

Rationale: 429 Storm (TC-05) tests the most critical FLT code path and uses the simplest mechanism (`blockRequest` with status code). Blackhole (TC-01) adds `simulateTimeout`. Intermittent (TC-07) adds probability. These three cover 80% of the value with the least implementation effort.

---

*"The network is reliable" is the first of the eight fallacies of distributed computing. Traffic Control makes that fallacy tangible.*

— Sana Reeves, EDOG Studio Architecture
