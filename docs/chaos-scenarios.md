# FLT Chaos Engineering — Stealth & Hacky Scenarios

> **Classification:** RED TEAM — INTERNAL ONLY
> **Author:** Sana Reeves (Architect) + Sentinel (Adversarial QA)
> **Codebase:** `workload-fabriclivetable/Service/Microsoft.LiveTable.Service/`
> **Date:** 2025-07-24
> **Scenarios:** 30

Every scenario below is grounded in **real code patterns** found in the FLT codebase.
No hypotheticals. No imagination exercises. These are real.

---

## STEALTH SCENARIOS (S01–S15)

### S01: Token Cache Poisoning — The Identity Thief

**Type**: Stealth
**Evil Level**: ★★★★★
**Detection Time**: Days to weeks (until audit log correlation)

**The Setup**:
1. User A deploys to LakehouseX, creating a token entry keyed by `(LakehouseId, IterationId)`.
2. User B calls `UpdateCachedToken()` on the same `(LakehouseId, IterationId)` — perhaps via a concurrent deployment or shared iteration.
3. The `TokenManager` detects that `token.UserObjectId != userObjectId` (User B ≠ User A).
4. It **logs a message** and proceeds to overwrite User A's token with User B's token.

**What Looks Normal**: No exception. No error. Log says "User X attempted to update token created by User Y" — but this log is `Verbose` level and drowned in noise. Token refresh appears successful.

**What's Actually Happening**: Every subsequent DAG execution for LakehouseX runs under User B's identity. User B may have different permissions — either less (causing mysterious failures) or more (silent privilege escalation). Data written to OneLake is attributed to User B.

**The Reveal**: Security audit discovers operations attributed to User B on User A's lakehouse. Or: User A's DAG starts failing with permission errors weeks later when User B's token expires.

**Where in FLT**: `TokenManagement/TokenManager.cs` lines 132-179 — `UpdateCachedToken()` method. The comment literally says "For now, just log if different user updates the token."

**Why It Matters**: Impersonation bugs are the #1 most expensive security finding. This isn't injection — it's a feature that lets the wrong person's identity propagate silently.

**EDOG Panel Control**:
- Toggle: `[Inject token user mismatch]` — Overwrite token with a different userObjectId
- Monitor: Watch `[Token Manager] User X attempted to update token created by Y` log lines — count should be 0

---

### S02: Cross-Workspace Entity Misresolution — The Wrong Lakehouse

**Type**: Stealth
**Evil Level**: ★★★★★
**Detection Time**: Weeks to never (data silently comes from wrong source)

**The Setup**:
1. Create a materialized view in WorkspaceA referencing source table "SalesData" in LakehouseB.
2. Delete/rename LakehouseB.
3. Create a NEW lakehouse named "SalesData" in WorkspaceA (same workspace as the MLV).
4. Trigger DAG execution.

**What Looks Normal**: DAG executes successfully. Metrics show normal duration. No errors. Refresh completes. Data appears in the MLV.

**What's Actually Happening**: The catalog resolution in `CatalogHandler.cs` falls back to name-based lookup when GUIDs are missing from old VHD properties. The code at line ~960 sets `srcEntityWorkspaceId = workspaceId` (current workspace) because the old VHD lacks workspace ID. The name-based lookup at line ~1013 resolves "SalesData" to the WRONG lakehouse — the new one in WorkspaceA instead of the original one in a different workspace. The MLV now materializes data from a completely different source.

**The Reveal**: A data analyst notices that January's revenue numbers changed after a DAG refresh. Investigation takes days because the lineage graph looks correct — it's the entity resolution that silently resolved to a different physical lakehouse.

**Where in FLT**: `Catalog/CatalogHandler.cs` lines ~950-1070 — `GetConnectedCatalogObjectsAsync()`. The backward-compatibility fallback for old VHDs without workspace GUIDs assumes same-workspace.

**Why It Matters**: This is the data equivalent of DNS poisoning. Your materialized view is "correct" but reads from the wrong source. Every downstream report, dashboard, and ML model is silently corrupted.

**EDOG Panel Control**:
- Toggle: `[Force name-based entity resolution]` — Strip GUIDs from VHD properties
- Monitor: Watch for `"backward compatibility mode"` log messages — each one is a potential misresolution

---

### S03: The Immortal AsyncLock — Memory That Never Forgets

**Type**: Stealth
**Evil Level**: ★★★☆☆
**Detection Time**: Days to weeks (GC pressure, OOM in production)

**The Setup**:
1. Deploy MLVs to many lakehouses over weeks of development.
2. Each unique `LakehouseId` adds an `AsyncLock` to the `dagSaveLocks` dictionary.
3. Delete some lakehouses. Remove some workspaces. Clean up your dev environment.
4. The locks remain.

**What Looks Normal**: Service functions correctly. DAG saves succeed. No errors in any log. Memory usage chart shows a gentle upward slope that could be attributed to normal workload growth.

**What's Actually Happening**: `DagExecutionStore.dagSaveLocks` (line 37) uses `ConcurrentDictionary.GetOrAdd()` at lines 72 and 145, but there is **zero cleanup code**. No `Remove()`. No `Clear()`. No TTL. No eviction. Each `AsyncLock` wraps a `SemaphoreSlim` with native OS handles. After months of operation across hundreds of lakehouses, the dictionary holds thousands of entries for lakehouses that no longer exist.

**The Reveal**: Production OOM after 3-6 months. GC telemetry shows Gen2 collections increasing. Heap dump reveals thousands of `AsyncLock` objects for nonexistent lakehouses.

**Where in FLT**: `Store/DagExecutionStore.cs` lines 37, 72, 145

**Why It Matters**: Classic slow leak. The same pattern affects `checkDagNodesToExecuteLocks` in `DagExecutionHandlerV2.cs` — another `ConcurrentDictionary<Guid, AsyncLock>` that only grows.

**EDOG Panel Control**:
- Toggle: `[Accelerate lock accumulation]` — Generate synthetic LakehouseIds per request
- Slider: `[Lock accumulation rate]` — 1x to 1000x unique IDs per minute
- Monitor: `dagSaveLocks.Count` — should plateau, not grow linearly

---

### S04: The Per-Process Rate Limiter — Throttling Theater

**Type**: Stealth
**Evil Level**: ★★★★☆
**Detection Time**: Never (unless cross-instance analysis is performed)

**The Setup**:
1. Send requests that trigger rate limiting to Backend Instance A. Get throttled correctly.
2. Send identical requests to Backend Instance B (via load balancer).
3. Rate limiter on Instance B has a fresh cache — full token bucket.

**What Looks Normal**: Each backend instance reports correct throttling. Per-instance metrics show rate limiting working perfectly. Dashboards green.

**What's Actually Happening**: `TokenBucketRateLimiterCache` is a singleton per process (line 49: `public static Instance`). The comment at line 23-27 literally documents this: "This cache is IN-MEMORY and PROCESS-LOCAL... user-based throttling may NOT work correctly across artifacts when requests are routed to different backends." A user can bypass throttling by simply having requests routed to different instances — which happens naturally with any load balancer.

**The Reveal**: A cost anomaly investigation discovers a user who ran 100x the expected Spark operations. Per-instance throttling shows they were within limits on each backend. Aggregate analysis reveals the loophole.

**Where in FLT**: `Throttling/Policies/TokenBucketRateLimiterCache.cs` lines 23-50

**Why It Matters**: Rate limiting that only works per-instance is security theater. It stops accidents but not abuse.

**EDOG Panel Control**:
- Toggle: `[Simulate multi-instance bypass]` — Route requests to separate cache instances
- Monitor: Aggregate request rate across all instances vs. per-instance limits

---

### S05: DateTime.Now in a UTC World — The Timezone Drift

**Type**: Stealth
**Evil Level**: ★★☆☆☆
**Detection Time**: Hours (during cross-region log correlation)

**The Setup**:
1. Deploy FLT service across multiple Azure regions with different local timezones.
2. Trigger DAG execution that involves log events from multiple regions.
3. Attempt to correlate logs chronologically.

**What Looks Normal**: Each region's logs look internally consistent. Timestamps are formatted correctly. No parse errors.

**What's Actually Happening**: `ConsoleLogger.cs` line 188 uses `DateTime.Now.ToString("G")` — local time, not UTC. When a DAG execution involves operations across regions (catalog resolution, Spark execution, OneLake write), the log timestamps from different servers are offset by hours. Event A appears to happen "before" Event B in the logs, but actually happened after.

**The Reveal**: Debugging a production issue, an engineer notices that a Spark execution appears to have completed BEFORE it started — the catalog resolution log (UTC+5:30) shows a later timestamp than the Spark completion log (UTC-7).

**Where in FLT**: `Core/ConsoleLogger.cs` line 188

**Why It Matters**: Log correlation is the #1 debugging tool. When timestamps lie, debugging takes 10x longer.

**EDOG Panel Control**:
- Toggle: `[Inject timezone offset]` — Override DateTime.Now to return non-UTC time
- Slider: `[Timezone offset hours]` — -12 to +12
- Monitor: Compare ConsoleLogger timestamps vs. Tracer timestamps for same event

---

### S06: The Feature Flag That Won't Die

**Type**: Stealth
**Evil Level**: ★★★★☆
**Detection Time**: Days to weeks (until feature team investigates unexpected behavior)

**The Setup**:
1. The feature flight service correctly disables `FLTDqMetricsBatchWrite` for a tenant.
2. The tenant's DAG execution still writes DQ metrics in batch mode.
3. Feature team is confused — the flight says disabled, but behavior says enabled.

**What Looks Normal**: Feature flight dashboard shows feature disabled. No errors. The code path executes successfully. Metrics are being written.

**What's Actually Happening**: `FeatureFlighter.cs` lines 36-41 contain a dev override:
```csharp
if (featureName == FeatureNames.FLTDqMetricsBatchWrite ||
    featureName == FeatureNames.FLTInsightsMetrics)
{
    return true;  // Forces on regardless of flight configuration
}
```
This hardcoded override returns `true` before the actual feature flight check. Comment says "DEV OVERRIDE — remove before merging." It was not removed.

**The Reveal**: A feature team member notices batch write behavior for a tenant that should be in canary ring (disabled). They check the flight config — correct. They check the code — find the hardcoded override.

**Where in FLT**: `FeatureFlightProvider/FeatureFlighter.cs` lines 36-41

**Why It Matters**: This defeats the entire purpose of feature flights. Canary testing, gradual rollout, kill switches — all bypassed. If the batch write feature has a bug, there's no way to turn it off.

**EDOG Panel Control**:
- Toggle: `[Override feature flight]` — Force specific flags to always-on or always-off
- Monitor: Compare `FeatureFlighter.IsEnabled()` return value vs. actual flight service response

---

### S07: The Artifact ID That Nobody Checks

**Type**: Stealth
**Evil Level**: ★★★★★
**Detection Time**: Never (until a security audit)

**The Setup**:
1. Obtain a valid MWC token for WorkspaceA, ArtifactX.
2. Call the FLT API targeting WorkspaceA, ArtifactY (a different artifact in the same workspace).
3. The request succeeds.

**What Looks Normal**: Authentication succeeds (valid token). Authorization appears to succeed (workspace matches). API returns data for ArtifactY.

**What's Actually Happening**: `WorkloadMwcTokenV2Authenticator.cs` lines 62-77 validates the workspace ID from the URL against the token claims. But there's a TODO comment:
```csharp
// TODO Artifact id will be checked when the platform sends the artifact claims
// https://msdata.visualstudio.com/A365/_workitems/edit/2720953.
```
The artifact ID is **never validated**. Any token valid for a workspace grants access to ALL artifacts in that workspace, regardless of the token's intended artifact scope.

**The Reveal**: A security penetration test discovers that workspace-scoped tokens can access any artifact. Or: a multi-tenant audit shows cross-artifact access patterns.

**Where in FLT**: `Authorization/WorkloadMwcTokenV2Authenticator.cs` lines 62-77

**Why It Matters**: This is authorization bypass via missing validation. The spec says artifact-level isolation; the code provides only workspace-level.

**EDOG Panel Control**:
- Toggle: `[Cross-artifact access test]` — Use ArtifactX's token to access ArtifactY
- Monitor: Compare artifact ID in token claims vs. artifact ID in request URL

---

### S08: Double-Checked Locking Race in Token Provider

**Type**: Stealth
**Evil Level**: ★★★☆☆
**Detection Time**: Hours (manifests as sporadic NullReferenceException)

**The Setup**:
1. Multiple concurrent requests hit `BaseTokenProvider.GetTokenAsync()` when the cached token is near expiry.
2. Thread A passes the fast-path check (`CheckTokenValidity()` returns true at line 62).
3. Thread B acquires the lock, refreshes the token, nullifies the old reference.
4. Thread A returns the now-stale or null `cachedToken`.

**What Looks Normal**: 99.9% of requests work fine. Token caching provides excellent performance. The double-checked lock pattern looks textbook.

**What's Actually Happening**: The fast path at line 62 reads `cachedToken` without any lock. Between the validity check and the `return cachedToken` statement, another thread can set `cachedToken = null` (during refresh). The returned value is null or a stale token that's about to expire. Downstream code receives a null token and fails with a generic `NullReferenceException`.

**The Reveal**: Sporadic 500 errors during high-concurrency periods. Stack traces point to unrelated code (the consumer of the token, not the provider). Engineers chase the wrong bug for hours.

**Where in FLT**: `TokenManagement/BaseTokenProvider.cs` lines 58-89

**Why It Matters**: Classic TOCTOU. The fix is simple (`volatile` keyword or `Interlocked.CompareExchange`), but the bug is nearly impossible to reproduce in dev environments — it requires precise timing under load.

**EDOG Panel Control**:
- Toggle: `[Inject token refresh race]` — Add artificial delay between CheckTokenValidity() and return
- Monitor: Track null token returns from GetTokenAsync()

---

### S09: Insights Metrics Schema Cache Pollution

**Type**: Stealth
**Evil Level**: ★★★★☆
**Detection Time**: Days (missing metrics, no errors)

**The Setup**:
1. Parallel DAG nodes execute, sharing `DagExecutionContext.State`.
2. Node A starts schema creation for the insights metrics table.
3. Node A **fails** during schema creation (transient error) but the code path sets `SchemaCreationStateKey = true` before the error occurs, or the error occurs after the flag is set.
4. Node B checks the state, sees `SchemaCreationStateKey = true`, skips schema creation.
5. Node B attempts to write metrics to a table that doesn't exist.

**What Looks Normal**: DAG execution reports success. Most nodes complete. The insights metrics write "succeeds" (the error is caught and logged at Verbose level).

**What's Actually Happening**: `InsightsMetricsTableManager.cs` uses `DagExecutionContext.State` to cache schema creation results across parallel nodes. The `SemaphoreSlim` at line 78-95 protects creation but not the state read. If schema creation partially succeeds (table created but columns not added) and the state key is set to `true`, all subsequent parallel nodes skip creation and write to a malformed table. Writes silently fail or write incomplete data.

**The Reveal**: Data quality team notices missing metrics for specific DAG runs. The metrics table exists but has wrong schema. No error in the DAG execution summary.

**Where in FLT**: `DagExecutionHooks/Insights/InsightsMetricsTableManager.cs` lines 78-95, 162-167

**Why It Matters**: Shared mutable state across parallel tasks is the source of the subtlest bugs. This one corrupts observability data — the very data you'd use to detect other problems.

**EDOG Panel Control**:
- Toggle: `[Fail schema creation mid-flight]` — Inject error after state key is set but before schema is complete
- Monitor: Compare `SchemaCreationStateKey` value vs. actual table existence

---

### S10: Nullable Validation Bypass in ParallelNodeLimit

**Type**: Stealth
**Evil Level**: ★★★☆☆
**Detection Time**: Minutes to hours (NullReferenceException during execution)

**The Setup**:
1. Set `DagSettings.ParallelNodeLimit = null` via the settings API.
2. Trigger DAG execution.

**What Looks Normal**: Settings API accepts the value. Validation passes. DAG execution starts.

**What's Actually Happening**: `DagSettings.ValidateParallelNodeLimit(int? parallelNodeLimit)` at line 94-100 compares `null < MinParallelNodeLimit` and `null > MaxParallelNodeLimit`. In C#, comparing `null` with `<` or `>` evaluates to `false` for both — so validation PASSES. The null value propagates to `DagExecutionHandlerV2.cs` line ~2115 where `visiting.Count < dagExecInstance.DagExecutionMetrics.ParallelNodeLimit` compares an int with a null int? — this evaluates to `false`, meaning NO nodes are ever scheduled for execution.

**The Reveal**: DAG hangs forever (or until timeout). The main loop polls `visited.Count == sortedNodes.Count` but it never becomes true because no nodes are processed. Eventually times out with a generic timeout error.

**Where in FLT**: `DataModel/Dag/DagSettings.cs` lines 94-100, `Core/V2/DagExecutionHandlerV2.cs` line ~2115

**Why It Matters**: Null bypassing validation is one of the most common bugs in typed languages. The fix is one line: `if (parallelNodeLimit == null || ...)`.

**EDOG Panel Control**:
- Toggle: `[Set ParallelNodeLimit to null]`
- Monitor: Watch for DAG executions that start but never complete any nodes

---

### S11: Negative Duration Telemetry — The Time Traveler

**Type**: Stealth
**Evil Level**: ★★☆☆☆
**Detection Time**: Hours (anomalous telemetry values)

**The Setup**:
1. Start a DAG execution, recording `requestStartTime = DateTime.UtcNow`.
2. During execution, an NTP synchronization adjusts the system clock backward by a few seconds.
3. Execution completes. Duration is calculated: `DateTime.UtcNow.Subtract(requestStartTime).TotalMilliseconds`.

**What Looks Normal**: DAG execution succeeds. All nodes complete. Results are correct.

**What's Actually Happening**: `DagExecutionHandlerV2.cs` line 1042 calculates duration as `(long)DateTime.UtcNow.Subtract(requestStartTime).TotalMilliseconds`. If the clock moved backward, this produces a negative value. The `(long)` cast preserves the negative. Telemetry records execution duration as `-3600000` ms. Monitoring dashboards average in this negative value, skewing all latency metrics downward. SLA calculations report impossible performance.

**The Reveal**: P50 latency metric suddenly drops to impossible values. Investigation reveals negative duration entries in telemetry.

**Where in FLT**: `Core/V2/DagExecutionHandlerV2.cs` lines 127, 1042

**Why It Matters**: Use `Stopwatch.GetElapsedTime()` (monotonic clock) instead of `DateTime.UtcNow` subtraction. Every cloud VM is susceptible to NTP adjustments.

**EDOG Panel Control**:
- Toggle: `[Inject clock skew]` — Offset DateTime.UtcNow backward during execution
- Slider: `[Clock skew seconds]` — -3600 to +3600
- Monitor: Watch for negative or impossibly small durationMs values

---

### S12: CascadingCancellation Returns Null Silently

**Type**: Stealth
**Evil Level**: ★★★☆☆
**Detection Time**: Minutes (NullReferenceException on first cancellation attempt)

**The Setup**:
1. Start a DAG with multiple nodes executing in parallel.
2. One node encounters an error that should cascade-cancel its dependents.
3. `CascadingCancellation.AddOrGetAsync()` is called for a node that was already removed or never added.

**What Looks Normal**: Node execution appears to proceed normally. No error from AddOrGetAsync itself.

**What's Actually Happening**: `CascadingCancellation.cs` lines 62-63: `TryGetValue(nodeId, out var cts); return cts;` — if the key doesn't exist, `cts` is null, and null is returned without throwing. The caller at line ~2125 in `DagExecutionHandlerV2.cs` does `var cts = await cascadingCancellation.AddOrGetAsync(node.NodeId)` and then calls `cts.Token` — NullReferenceException.

**The Reveal**: Sporadic crashes during DAG cancellation. Stack trace points to an innocent-looking `.Token` access.

**Where in FLT**: `Cancellation/CascadingCancellation.cs` lines 62-63

**Why It Matters**: Cancellation paths are the least tested paths in any system. This bug only manifests during error recovery — when reliability matters most.

**EDOG Panel Control**:
- Toggle: `[Remove CTS before cancellation]` — Delete a node's CTS entry before cascade
- Monitor: Count null returns from `AddOrGetAsync()`

---

### S13: Rate Limiter Fast-Path TOCTOU — Double Bucket

**Type**: Stealth
**Evil Level**: ★★★☆☆
**Detection Time**: Never (appears as slightly relaxed rate limiting)

**The Setup**:
1. Two concurrent requests from the same user arrive simultaneously.
2. Both hit the fast-path cache check (line 98) — both see cache miss.
3. Both proceed to the slow path with lock acquisition.
4. First thread creates a new limiter and caches it.
5. Second thread's double-check finds the limiter — but its OWN fast-path already decided to create one.

**What Looks Normal**: Rate limiting appears to work. Users are occasionally throttled. No errors.

**What's Actually Happening**: The `TokenBucketRateLimiterCache.cs` fast path (lines 97-104) reads from `memoryCache.Get()` without a lock. Between the fast-path miss and the slow-path lock acquisition (line 107), another thread can create and cache a limiter. The double-check inside the lock (line 110-116) handles this case, BUT: during the race window, the first thread may return a DIFFERENT limiter instance than what ends up cached. Each limiter starts with a full token bucket. Two concurrent first-requests effectively double the rate limit.

**The Reveal**: Load testing shows burst capacity is 2x the configured limit during cold-start scenarios.

**Where in FLT**: `Throttling/Policies/TokenBucketRateLimiterCache.cs` lines 97-132

**Why It Matters**: In practice, this means rate limiting is slightly weaker than configured during traffic spikes — exactly when you need it most.

**EDOG Panel Control**:
- Toggle: `[Concurrent first-request burst]` — Send N simultaneous requests with cold cache
- Monitor: Compare actual permits granted vs. configured token bucket size

---

### S14: Token Expiry Precision Loss — The Off-By-One-Minute

**Type**: Stealth
**Evil Level**: ★★☆☆☆
**Detection Time**: Hours (manifests as unexpected token refresh or expiry)

**The Setup**:
1. EDOG DevMode reads a cached token from `.edog-token-cache`.
2. Token expiry is stored as Unix timestamp (double).
3. Expiry calculation: `Math.Floor((token.Value.ExpiryUtc - DateTime.UtcNow).TotalMinutes)` cast to `(int)`.

**What Looks Normal**: Token appears valid. Refresh timer seems to work.

**What's Actually Happening**: `EdogApiProxy.cs` lines 45-134. `double.TryParse` for the Unix timestamp, then `(long)expiryUnix` truncates the fractional seconds. `Math.Floor()` then `(int)` casts truncate the fractional minutes. A token that expires at 14:30:59 reports as expiring at 14:30:00. Combined with the 5-minute refresh buffer (`AddSeconds(-300)`), this can cause premature refresh or, worse, a 59-second window where the token is reported as valid but has actually expired.

**The Reveal**: Sporadic "token expired" errors during development that can't be reproduced.

**Where in FLT**: `DevMode/EdogApiProxy.cs` lines 45, 52, 63, 128, 134

**Why It Matters**: Precision loss in time calculations creates flaky behavior that's extremely hard to debug.

**EDOG Panel Control**:
- Toggle: `[Inject token near-expiry]` — Set token expiry to exactly buffer-boundary
- Monitor: Compare calculated `expiryMinutes` vs. actual remaining time

---

### S15: Sliding Expiration Never Evicts Active Abusers

**Type**: Stealth
**Evil Level**: ★★★☆☆
**Detection Time**: Days (rate limiter cache grows, throttling becomes inconsistent)

**The Setup**:
1. An abusive user sends sustained high-rate requests.
2. The `TokenBucketRateLimiterCache` creates a limiter with a 1-hour sliding expiration.
3. Each request "touches" the cache entry, resetting the 1-hour timer.

**What Looks Normal**: Rate limiting activates. Abuser is throttled per-request. System appears to be working.

**What's Actually Happening**: `TokenBucketRateLimiterCache.cs` line 125 uses `DefaultSlidingExpiration = TimeSpan.FromHours(1)`. Sliding expiration means the timer resets on every access. An active abuser's limiter NEVER expires because every throttled request resets the timer. The limiter accumulates state forever. Meanwhile, the `MemoryCache` grows with one entry per active abuser. There's no upper bound on cache size, no absolute expiration, and no LRU eviction.

**The Reveal**: Memory growth correlates with sustained abuse patterns. Cache holds entries for attackers who have long since stopped.

**Where in FLT**: `Throttling/Policies/TokenBucketRateLimiterCache.cs` line 125, `DefaultSlidingExpiration`

**Why It Matters**: The defense mechanism (rate limiting) becomes a resource consumption vector. The attacker's cost is one request per hour; the defender's cost is permanent memory allocation.

**EDOG Panel Control**:
- Toggle: `[Simulate sustained abuse]` — Send requests at exactly the sliding window boundary
- Monitor: `memoryCache` entry count over time (should plateau, will grow linearly)

---

## HACKY SCENARIOS (H01–H15)

### H01: Retry Amplification — One Request, A Thousand Executions

**Type**: Hacky
**Evil Level**: ★★★★★
**Detection Time**: Hours (Spark capacity exhaustion or cost spike)

**The Setup**:
1. Craft a request that triggers a retriable error (e.g., Spark session transient failure).
2. The `RetryExecutor.ExecuteAsync()` enters its `while (true)` loop.
3. Each retry re-executes the full operation (new Spark statement submission).
4. The retry strategy keeps returning `ShouldRetry = true` because the error category matches.

**What Looks Normal**: The request eventually succeeds after retries (or times out with a standard timeout error). Retry count is logged at Verbose level.

**What's Actually Happening**: `RetryPolicy/V2/Framework/RetryExecutor.cs` lines 143-213 has no absolute maximum retry count in the executor itself — it relies entirely on the strategy's `ShouldRetry()` to return false. If the strategy is misconfigured or the error oscillates between retriable categories, a single request can generate hundreds of Spark statement submissions. Each submission consumes Spark cluster resources, API rate limit tokens, and compute cost.

**The Reveal**: Monthly Azure bill is 10x expected. Investigation traces thousands of Spark sessions back to a single API call that retried 400 times over 2 hours.

**Where in FLT**: `RetryPolicy/V2/Framework/RetryExecutor.cs` lines 143-213

**Why It Matters**: Retry amplification is a classic DoS vector. AWS documented this pattern in their 2023 S3 outage postmortem. The fix is a hard circuit breaker: `if (context.TotalAttempts > AbsoluteMaxRetries) throw;`

**EDOG Panel Control**:
- Toggle: `[Trigger infinite retry loop]` — Return retriable error on every attempt
- Slider: `[Max retry count override]` — 1 to 10000
- Monitor: `context.TotalAttempts` per request — alert if > 10

---

### H02: The Multiple Decorator — Silent Table Drop

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Weeks (until someone notices a table is missing from the DAG)

**The Setup**:
1. Write a notebook cell with TWO `@Fabric.materialized_lake_view` decorators:
   ```python
   @Fabric.materialized_lake_view(name="important_metrics")
   @Fabric.materialized_lake_view(name="temp_scratch")
   def calculate():
       return spark.sql("SELECT ...")
   ```
2. Deploy and execute the DAG.

**What Looks Normal**: Notebook parses successfully. DAG is constructed. Execution completes. `temp_scratch` materialized view is created and populated.

**What's Actually Happening**: `NotebookExecutionContext.cs` lines 590-625 visits ALL decorators. `result.DecoratorCount` increments to 2, but the `MlvName` field is overwritten by the LAST decorator's name. `important_metrics` is silently dropped from the DAG. Only `temp_scratch` is materialized. No error. No warning in the execution summary. The `DecoratorCount` is tracked but never validated to be exactly 1.

**The Reveal**: An analyst asks "why hasn't the `important_metrics` table been refreshed in 3 weeks?" Investigation discovers the duplicate decorator silently dropped it.

**Where in FLT**: `Notebook/NotebookExecutionContext.cs` lines 590-625, 553-569

**Why It Matters**: Last-writer-wins on metadata silently destroys data. The Python decorator syntax makes this easy to do accidentally (copy-paste a cell, forget to remove the old decorator).

**EDOG Panel Control**:
- Toggle: `[Inject duplicate decorator]` — Add second decorator to notebook cells
- Monitor: `DecoratorCount > 1` — should be flagged as error, currently only counted

---

### H03: JSON Library Mismatch — The Duplicate Key Exploit

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Never (unless someone compares serialization output across paths)

**The Setup**:
1. Send a settings payload with duplicate JSON keys:
   ```json
   {
     "ParallelNodeLimit": 5,
     "ParallelNodeLimit": 25
   }
   ```
2. The payload is processed by two different code paths — one using `Newtonsoft.Json`, one using `System.Text.Json`.

**What Looks Normal**: If deserialized by Newtonsoft: `ParallelNodeLimit = 25` (last value wins). Settings appear valid and within range.

**What's Actually Happening**: The FLT codebase uses BOTH JSON libraries. `DataQuality/FabricApiClient.cs` uses `Newtonsoft.Json`; `DevMode/EdogLogServer.cs` uses `System.Text.Json`. If the same payload crosses both deserialization paths, the two libraries produce different values for the same input. Validation might pass in one path (seeing value 5) while execution uses the other path (seeing value 25). With carefully chosen values, you can bypass validation entirely.

**The Reveal**: A support ticket reports that DAG settings show one value in the UI but behave as if a different value is set.

**Where in FLT**: `DataQuality/FabricApiClient.cs` (Newtonsoft) vs. `DevMode/EdogLogServer.cs` (System.Text.Json) and various other files

**Why It Matters**: Mixed JSON library usage is a well-known source of semantic bugs. The same JSON produces different objects depending on which library deserializes it. This is not a bug in either library — it's a bug in using both.

**EDOG Panel Control**:
- Toggle: `[Inject duplicate JSON keys]` — Add duplicate keys to settings payloads
- Monitor: Compare deserialized values across Newtonsoft vs. System.Text.Json paths

---

### H04: The Empty DAG — Instant Success, Zero Work

**Type**: Hacky
**Evil Level**: ★★★☆☆
**Detection Time**: Days (until someone checks actual data freshness)

**The Setup**:
1. Create a materialized view definition with no actual table dependencies (empty DAG).
2. Trigger DAG execution.
3. Execution completes in <1ms with status "Success".

**What Looks Normal**: DAG execution reports success. Duration is near-zero (which might look like "very fast" rather than "did nothing"). No errors. Status is green.

**What's Actually Happening**: `DagExecutionHandlerV2.cs` lines 314-358. `sortedNodes.Count == 0` for an empty DAG. The check `visited.Count == sortedNodes.Count` evaluates to `0 == 0 = true` immediately. The execution loop exits on the first iteration. No nodes are processed. No data is refreshed. But the execution status is recorded as successful.

**The Reveal**: Data staleness alert fires (if one exists). Or: a user reports that their dashboard shows data from last month despite "successful" daily DAG runs.

**Where in FLT**: `Core/V2/DagExecutionHandlerV2.cs` lines 314-358

**Why It Matters**: "Success with no work done" should be a different status than "Success with work completed." The scheduler sees success and doesn't retry. Monitoring sees success and doesn't alert.

**EDOG Panel Control**:
- Toggle: `[Deploy empty DAG]` — Remove all nodes from DAG definition
- Monitor: Compare `sortedNodes.Count` with actual executed node count — alert on 0

---

### H05: Table Name Path Traversal — The Name That Lies

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Minutes to hours (depends on what the traversal reaches)

**The Setup**:
1. Write a notebook with a decorator containing a crafted table name:
   ```python
   @Fabric.materialized_lake_view(name="../../../system_table")
   def my_view():
       return spark.sql("SELECT 1")
   ```
2. Deploy the notebook.

**What Looks Normal**: Notebook parser extracts the table name. No validation error during parsing.

**What's Actually Happening**: `NotebookExecutionContext.cs` lines 686-731 — `ExtractTableNameFromArglist()` and `ExtractStringLiteralValue()` extract the decorator's name argument but perform ZERO validation on the result. No check for:
- Path separators (`/`, `\`)
- Directory traversal (`..`)
- Empty strings
- Excessively long names
- SQL-injection characters (`;`, `'`, `--`)
- Unicode normalization attacks

The name `"../../../system_table"` passes through. When `Node.cs` line 183 calls `Name.Split('.')`, it produces `["", "", "/", "", "/system_table"]` — potentially causing unexpected behavior in downstream catalog operations.

**The Reveal**: Error at DAG execution time (not parse time) — possibly hours later if the DAG is scheduled. The error message is cryptic: `MLV_INVALID_TABLE_NAME_FORMAT`.

**Where in FLT**: `Notebook/NotebookExecutionContext.cs` lines 686-731

**Why It Matters**: Input validation should happen at ingestion, not execution. The gap between "accepted at parse time" and "rejected at execution time" creates confusion, wastes resources, and potentially allows injection if any code path uses the unvalidated name in a SQL or filesystem operation.

**EDOG Panel Control**:
- Toggle: `[Inject malformed table name]` — Use path traversal, unicode, or SQL-injection characters
- Slider: `[Table name length]` — 0 to 100000 characters
- Monitor: Watch for table names containing `/`, `\`, `..`, `;`, or exceeding 256 chars

---

### H06: Guid.Empty — The Zero Identity

**Type**: Hacky
**Evil Level**: ★★★☆☆
**Detection Time**: Seconds to hours (NullReferenceException or wrong DAG name)

**The Setup**:
1. Pass `artifactId = Guid.Empty` (`00000000-0000-0000-0000-000000000000`) to a DAG creation API.
2. `DagUtils.GetDagName()` is called with this value.

**What Looks Normal**: The API accepts the request. Guid.Empty is a valid Guid value.

**What's Actually Happening**: `DagUtils.cs` lines 118-132: `GetDagName()` checks `if (artifactId != Guid.Empty) return artifactId.ToString()` — but when both GUIDs are empty, it returns `null`. The caller at `Dag.cs` line 60 assigns `this.Name = null`. The `Name` property (line 72) has a default of `string.Empty`, but the setter accepts null. Downstream code that calls `Name.Length`, `Name.Contains()`, or `Name.Split()` throws `NullReferenceException`.

**The Reveal**: Immediate crash during DAG construction. Stack trace points to a property access deep in the call chain, making the root cause (Guid.Empty input) non-obvious.

**Where in FLT**: `Utils/DagUtils.cs` lines 118-132, `DataModel/Dag/Dag.cs` lines 60, 72

**Why It Matters**: All-zeros GUID is the "null object" of the GUID world. Every system needs to explicitly handle it, and most don't.

**EDOG Panel Control**:
- Toggle: `[Inject Guid.Empty]` — Replace artifactId/lakehouseId with all zeros
- Monitor: Watch for `NullReferenceException` in DAG construction path

---

### H07: EDOG Token Exposure — The Debug Endpoint Left Open

**Type**: Both (Stealth + Hacky)
**Evil Level**: ★★★★★
**Detection Time**: Never (unless someone port-scans the server)

**The Setup**:
1. Accidentally enable EDOG DevMode in a production or staging environment (wrong config flag).
2. EDOG Kestrel server starts on its configured port.
3. Call `GET /edog/config` from any HTTP client.

**What Looks Normal**: The FLT service operates normally. No error indicators. EDOG endpoints respond with 200 OK.

**What's Actually Happening**: `DevMode/EdogApiProxy.cs` lines 110-150:
- `ReadToken()` reads `.edog-token-cache` file (base64-encoded, NOT encrypted)
- `HandleConfig()` returns the raw MWC token in the JSON response
- No authentication on the EDOG endpoint
- The token grants full user impersonation capabilities

A single HTTP GET to `/edog/config` returns: workspace config, lakehouse details, AND the user's MWC bearer token.

**The Reveal**: A security scanner flags the open port. Or: a penetration test discovers the unauthenticated token endpoint. Or: never, if nobody looks.

**Where in FLT**: `DevMode/EdogApiProxy.cs` lines 110-150

**Why It Matters**: Debug endpoints in production are a perennial top-10 security vulnerability. The token stored on disk in base64 (not encrypted) is the cherry on top.

**EDOG Panel Control**:
- Toggle: `[Enable/disable DevMode detection]` — Check if EDOG endpoints are accessible
- Monitor: HTTP response from `/edog/config` — should be 404/503 in non-dev environments

---

### H08: Parallelism=2 with Deep Dependencies — The Convoy

**Type**: Hacky
**Evil Level**: ★★★☆☆
**Detection Time**: Hours (DAG takes 10x longer than expected)

**The Setup**:
1. Set `ParallelNodeLimit = 2` (the minimum allowed value per `DagSettings.cs` line 45).
2. Create a DAG with 20 nodes in a wide, shallow dependency graph (all depend on a single root).
3. Execute the DAG.

**What Looks Normal**: DAG execution starts. Nodes process. No errors. Eventually completes.

**What's Actually Happening**: `DagExecutionHandlerV2.cs` line ~2115: `visiting.Count < dagExecInstance.DagExecutionMetrics.ParallelNodeLimit` gates scheduling to at most 2 concurrent nodes. With 20 nodes, they execute in pairs: nodes 1-2, then 3-4, then 5-6... The DAG that should take ~2 node-durations (all nodes parallel after root) takes ~10 node-durations (serialized in pairs). The recursive `ExecuteInternalAsync` call adds overhead between each pair.

Combined with the recursive lock pattern in `ExecuteInternalAsync`, setting parallelism to 2 maximizes lock contention and scheduling overhead while minimizing actual parallelism — potentially causing the execution loop to spend more time in lock acquisition than in node execution.

**The Reveal**: Users complain DAG takes 10x longer than it "should." Support investigates and finds `ParallelNodeLimit = 2` — technically valid per validation.

**Where in FLT**: `DataModel/Dag/DagSettings.cs` (validation), `Core/V2/DagExecutionHandlerV2.cs` line ~2115 (enforcement)

**Why It Matters**: Minimum valid != minimum useful. The validation allows a value that turns parallel execution into serial execution with overhead.

**EDOG Panel Control**:
- Toggle: `[Set minimum parallelism]` — Force `ParallelNodeLimit = 2`
- Monitor: Compare expected DAG duration (node count / parallelism * avg node time) vs. actual

---

### H09: Permission Bypass via Missing Artifact Claims

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Never (appears as legitimate access)

**The Setup**:
1. Obtain a token where the target `artifactId` is NOT in the `workloadClaims.Artifacts` list (e.g., token was issued for a different artifact in the same workspace).
2. Call an API that requires specific artifact permissions.

**What Looks Normal**: Request is authenticated (valid token). Request proceeds through the permission filter.

**What's Actually Happening**: `RequiresPermissionFilter.cs` lines 102-120:
```csharp
var artifactData = workloadClaims.Artifacts?.FirstOrDefault(
    a => string.Equals(a.ArtifactObjectId, artifactIdInUrl, ...));
if (artifactData != null)
{
    artifactPermissions = (Permissions)artifactData.Permissions;
}
```
If `artifactData` is null (artifact not found in claims), `artifactPermissions` stays `0`. Then `!artifactPermissions.HasPermission(requiredPermissions)` checks if permission `0` has the required permissions — which SHOULD fail. But the behavior depends entirely on the `HasPermission` implementation. If it uses bitwise AND: `(0 & requiredPermission) != requiredPermission` = `0 != X` = `true` (correctly fails). However, this is fragile and the error message says "workspace permissions" not "artifact permissions," indicating confusion about what's being checked.

**The Reveal**: Depends on `HasPermission` implementation. If correctly implemented, this is just a confusing error message. If not, it's a permission bypass.

**Where in FLT**: `Authorization/RequiresPermissionFilter.cs` lines 102-120

**Why It Matters**: The defense relies on an implicit behavior of bitwise operations rather than explicit validation ("artifact MUST exist in claims").

**EDOG Panel Control**:
- Toggle: `[Remove artifact from claims]` — Strip target artifact from token claims
- Monitor: Watch for "does not have the required workpace permissions" (note: typo "workpace" is in original code)

---

### H10: Simultaneous Deployment Race — The Two-Lakehouse Problem

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Days (wrong config applied to wrong lakehouse)

**The Setup**:
1. User clicks "Deploy to Lakehouse A" in EDOG Studio.
2. Before deployment A completes, user clicks "Deploy to Lakehouse B."
3. Both deployments race through the same `TokenManager` cache.

**What Looks Normal**: Both deployments report success. Both lakehouses appear configured.

**What's Actually Happening**: The `TokenManager` uses `(LakehouseId, IterationId)` as cache keys. During simultaneous deployment, both code paths call `UpdateCachedToken()` (the method from S01 that doesn't validate user identity). Depending on timing:
- Lakehouse A's token could be cached under Lakehouse B's key
- The DagExecutionContext could use the wrong token for the wrong lakehouse
- Config patching in `edog.py` could apply Lakehouse A's config to Lakehouse B's directory

The `DagExecutionStore.dagSaveLocks` uses `LakehouseId` as the lock key — but locks are per-method, not per-deployment-session. Two deployments can interleave their save operations.

**The Reveal**: Lakehouse B's DAG executes with Lakehouse A's token. Or: Lakehouse A's data appears in Lakehouse B's tables.

**Where in FLT**: `TokenManagement/TokenManager.cs`, `Store/DagExecutionStore.cs`, deployment flow

**Why It Matters**: Developers DO deploy to multiple lakehouses in quick succession during testing. This race condition is not hypothetical — it's the normal workflow.

**EDOG Panel Control**:
- Toggle: `[Concurrent deployment]` — Start two deployments simultaneously
- Slider: `[Deployment overlap %]` — 0% (sequential) to 100% (fully concurrent)
- Monitor: Compare token LakehouseId vs. actual lakehouse being operated on

---

### H11: Stack Trace Leak — The Information Gift

**Type**: Hacky
**Evil Level**: ★★★☆☆
**Detection Time**: Never (unless someone reads error responses carefully)

**The Setup**:
1. Send a malformed request that triggers an exception in the GTS parsing path.
2. Read the error response carefully.

**What Looks Normal**: API returns an error (expected for malformed input). Error message appears generic.

**What's Actually Happening**: `SparkHttp/Model/MLVRefreshOutput.cs` logs `ex.StackTrace` via `Tracer.LogSanitizedError()`. `SecurityAuditing/EmitSecurityAuditEventOnSuccessAttribute.cs` logs `resultExecutedContext.Exception.StackTrace`. While these are "sanitized" logs, if the error propagation chain includes any of this information in the API response (or if the tracing system is accessible), it reveals:
- Internal file paths (C# project structure)
- Method signatures (API surface)
- Line numbers (code version identification)
- Assembly versions (dependency fingerprinting)

**The Reveal**: A security audit finds internal stack traces in error responses or accessible trace logs.

**Where in FLT**: `SparkHttp/Model/MLVRefreshOutput.cs`, `SecurityAuditing/EmitSecurityAuditEventOnSuccessAttribute.cs`

**Why It Matters**: OWASP Top 10 — Information Exposure Through an Error Message. Stack traces are a roadmap for attackers.

**EDOG Panel Control**:
- Toggle: `[Trigger verbose error path]` — Send requests that cause exceptions with full stack traces
- Monitor: Scan API responses and trace output for file paths, method names, line numbers

---

### H12: The Incompatible Feature Flag Combination

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Days (unexpected behavior from code path combinations)

**The Setup**:
1. Enable `FLTDqMetricsBatchWrite` (forced on via the hardcoded override in S06).
2. Simultaneously enable a conflicting feature flag via the normal flight service — e.g., one that uses a different metrics write strategy.
3. Execute a DAG that triggers both code paths.

**What Looks Normal**: Feature flight service shows only one flag enabled. The hardcoded override is invisible to the flight dashboard.

**What's Actually Happening**: The hardcoded override in `FeatureFlighter.cs` always returns `true` for `FLTDqMetricsBatchWrite`, independent of the flight service. If another feature flag controls an incompatible code path (e.g., individual vs. batch writes), both paths execute. Metrics are written twice — once in batch, once individually. Or: one path expects state that the other path already consumed.

**The Reveal**: Duplicate metrics in the insights table. Or: one write path fails because the other already locked the resource.

**Where in FLT**: `FeatureFlightProvider/FeatureFlighter.cs` lines 36-41 (hardcoded override)

**Why It Matters**: Feature flags exist to ensure mutual exclusivity of code paths. Hardcoded overrides defeat this guarantee.

**EDOG Panel Control**:
- Toggle: `[Enable conflicting feature flags]` — Force-enable two mutually exclusive flags
- Monitor: Feature flag evaluation results — should never have two incompatible flags = true

---

### H13: The DAG Cycle That Wasn't Caught

**Type**: Hacky
**Evil Level**: ★★★★☆
**Detection Time**: Hours (DAG execution hangs or crashes)

**The Setup**:
1. Build a DAG incrementally:
   - Add nodes A, B, C, D, E
   - Add edge A→B (no cycle)
   - Add edge B→C (no cycle)
   - Add edge D→E (no cycle)
   - Add edge E→C (no cycle — checked from E, C is reachable but not a cycle)
   - Add edge C→D (CYCLE: C→D→E→C — but `HasCycle(C, D)` only checks if D is reachable from C)
2. Execute the DAG.

**What Looks Normal**: All individual `AddEdge` calls succeed. No cycle detected at any step.

**What's Actually Happening**: `Dag.cs` lines 424-458 — `HasCycle(start, target)` does DFS from `start` to detect if `target` creates a back-edge. But the check is `DFS(start)` without incorporating the NEW edge being added. The cycle detection traverses the graph AS-IS, not the graph AFTER the edge is added. Adding C→D: DFS from C follows C's existing children. If C has no children yet (the edge to D hasn't been added), C is a leaf — no cycle detected. But after the edge is added, the cycle C→D→E→C exists.

**The Reveal**: `DagUtils.PerformTopologicalSort()` either throws an exception (if it has cycle detection) or produces an infinite loop. DAG execution hangs.

**Where in FLT**: `DataModel/Dag/Dag.cs` lines 424-458

**Why It Matters**: Cycle detection is the most critical validation in a DAG. If it can be bypassed through incremental edge addition, the entire execution model breaks.

**EDOG Panel Control**:
- Toggle: `[Inject incremental cycle]` — Add edges that individually pass cycle detection but create a cycle together
- Monitor: Run independent cycle detection after all edges are added

---

### H14: The Shared State Dictionary Race — Parallel Node Collision

**Type**: Both (Stealth + Hacky)
**Evil Level**: ★★★★☆
**Detection Time**: Days (intermittent, non-reproducible failures)

**The Setup**:
1. Create a DAG with 10+ parallel nodes (no inter-dependencies).
2. Set `ParallelNodeLimit = 25` (maximum).
3. All nodes execute simultaneously.
4. Multiple nodes write to the same key in `DagExecutionContext.State`.

**What Looks Normal**: Most executions succeed. Occasionally a node fails with a cryptic error. Retry usually succeeds.

**What's Actually Happening**: `DagExecutionContext.State` is a `ConcurrentDictionary<string, object>` (line 79). While individual dictionary operations are thread-safe, compound operations are NOT. Pattern:
```csharp
if (!state.ContainsKey("key"))     // Thread A: false
{                                   // Thread B: also false (race)
    state["key"] = Initialize();    // Thread A: initializes
}                                   // Thread B: overwrites with second init
var value = state["key"];           // Both: use value, but it's B's init, not A's
```

Multiple hooks in `DagExecutionHooks/` (like `InsightsMetricsTableManager.cs`) use this pattern with state keys like `SchemaCreationStateKey`. Under high parallelism, two nodes can both "win" the check-then-act race, causing double initialization, lost state, or inconsistent schema.

**The Reveal**: Intermittent test failures that can't be reproduced locally (requires real parallelism). Production incidents that resolve on retry.

**Where in FLT**: `DataModel/Dag/Execution/DagExecutionContext.cs` line 79, all consumers of `.State`

**Why It Matters**: The most dangerous concurrency bug is the one that only manifests under production load. `ConcurrentDictionary` provides thread-safe individual operations but not thread-safe workflows.

**EDOG Panel Control**:
- Toggle: `[Maximize DAG parallelism]` — Set ParallelNodeLimit to max, create wide DAGs
- Monitor: Track `State` dictionary mutations — detect double-writes to same key

---

### H15: The Token Refresh Storm — Thundering Herd

**Type**: Hacky
**Evil Level**: ★★★☆☆
**Detection Time**: Minutes (spike in token refresh calls)

**The Setup**:
1. Set up a DAG with 20 parallel nodes, all requiring token access.
2. Wait until the cached token is near expiry (within the refresh buffer window).
3. Trigger DAG execution.

**What Looks Normal**: Token refreshes. Nodes execute. Everything succeeds (eventually).

**What's Actually Happening**: `BaseTokenProvider.cs` lines 58-89. All 20 parallel node tasks call `GetTokenAsync()` simultaneously. The fast-path check (line 62) sees the token as expired for ALL threads. All 20 threads attempt to acquire the `asyncLock` (line 67). One thread wins, refreshes the token. The other 19 threads then check again (double-check, line 70), see the fresh token, and return. But during the lock contention window:
- 19 threads are blocked, wasting their task slots
- If `RefreshTokenAsync` is slow (network call), all 20 threads are effectively serialized
- The lock is acquired with `CancellationToken.None` (line 67), meaning CANCELLATION IS IGNORED during token refresh
- A cancelled DAG node continues to hold the lock, blocking healthy nodes

**The Reveal**: DAG execution is 5x slower than expected. Profiling shows all time is spent waiting on `asyncLock`.

**Where in FLT**: `TokenManagement/BaseTokenProvider.cs` lines 58-89

**Why It Matters**: Thundering herd is a classic distributed systems problem. The fix is a single `SemaphoreSlim(1,1)` + `Task.WhenAll` with a shared task, not a lock.

**EDOG Panel Control**:
- Toggle: `[Trigger token refresh during parallel execution]` — Set token to expire mid-DAG
- Monitor: Count concurrent waiters on `asyncLock` — should be ≤1 for extended periods

---

## COMBINED SCENARIOS (C01–C02)

### C01: The Perfect Storm — Deploy + Race + Retry + Wrong Identity

**Type**: Both
**Evil Level**: ★★★★★
**Detection Time**: Weeks (requires forensic log correlation across 4 systems)

**The Setup**:
1. User A deploys to LakehouseX.
2. While deployment is in progress, User B deploys to LakehouseX (different iteration).
3. User B's token overwrites User A's in the cache (S01).
4. DAG execution starts with User B's token.
5. A Spark operation fails with a transient error.
6. Retry logic amplifies the failure (H01).
7. Each retry runs under User B's identity.
8. The catalog resolution falls back to name-based lookup (S02) due to missing GUIDs.
9. Name-based lookup resolves to the wrong lakehouse.
10. Data is written to the wrong lakehouse under the wrong identity, then retried 50 times.

**What Looks Normal**: After many retries, the operation "succeeds." User A sees their DAG as completed.

**What's Actually Happening**: 50 copies of corrupted data written to the wrong lakehouse under the wrong user's identity. The original lakehouse has stale data. User B's audit trail shows operations they never initiated.

**The Reveal**: Data quality check finds duplicates in an unexpected lakehouse. Security audit finds User B "accessed" lakehouses they never intended to. The investigation involves 4 different teams (token, retry, catalog, data quality) and takes 2 weeks to reconstruct.

**Where in FLT**: TokenManager + RetryExecutor + CatalogHandler + DagExecutionHandler

**Why It Matters**: Real production incidents are never single-cause. They're cascading failures where 4 "acceptable" bugs combine into a catastrophe.

**EDOG Panel Control**:
- Toggle: `[Perfect storm mode]` — Activate S01 + S02 + H01 simultaneously
- Monitor: Cross-correlation of token identity, retry count, catalog resolution, and data destination

---

### C02: The Observability Blackout — Metrics About Metrics Are Wrong

**Type**: Both
**Evil Level**: ★★★★☆
**Detection Time**: Never (the monitoring itself is compromised)

**The Setup**:
1. Insights metrics schema creation partially fails (S09).
2. The `SchemaCreationStateKey` is set to `true` despite the failure.
3. All subsequent metrics writes silently fail (table doesn't exist or has wrong schema).
4. Clock skew produces negative duration values (S11).
5. The rate limiter's `-1` telemetry values (from null stats coercion) pollute metrics.
6. Feature flag override (S06) enables metrics code paths that should be disabled.

**What Looks Normal**: The service operates. DAGs execute. The monitoring dashboard shows... nothing. Or wrong numbers. But who monitors the monitor?

**What's Actually Happening**: The observability pipeline itself is corrupted:
- Metrics writes fail silently (S09)
- Duration values are negative (S11)
- Rate limit stats show `-1` for missing data (nullable coercion)
- Metrics features are force-enabled when they should be in canary (S06)

The dashboard either shows no data (silent write failures), impossible data (negative durations), or misleading data (force-enabled features).

**The Reveal**: An incident investigation requires metrics data that simply isn't there. Or: the data exists but shows impossible values that are dismissed as "telemetry bugs."

**Where in FLT**: InsightsMetricsTableManager + DagExecutionHandler + TokenBucketRateLimiterCache + FeatureFlighter

**Why It Matters**: If your observability is broken, you can't detect anything else. This is the meta-failure that makes all other failures invisible.

**EDOG Panel Control**:
- Toggle: `[Corrupt observability pipeline]` — Activate S06 + S09 + S11 simultaneously
- Monitor: Run independent validation of metrics data (outside the corrupted pipeline)

---

## SCENARIO SUMMARY MATRIX

| ID | Name | Type | Evil | Detection | Primary File |
|----|------|------|------|-----------|--------------|
| S01 | Token Cache Poisoning | Stealth | ★★★★★ | Weeks | TokenManager.cs |
| S02 | Cross-Workspace Misresolution | Stealth | ★★★★★ | Weeks+ | CatalogHandler.cs |
| S03 | Immortal AsyncLock Leak | Stealth | ★★★☆☆ | Days-Weeks | DagExecutionStore.cs |
| S04 | Per-Process Rate Limiter Bypass | Stealth | ★★★★☆ | Never | TokenBucketRateLimiterCache.cs |
| S05 | DateTime.Now Timezone Drift | Stealth | ★★☆☆☆ | Hours | ConsoleLogger.cs |
| S06 | Hardcoded Feature Flag Override | Stealth | ★★★★☆ | Days-Weeks | FeatureFlighter.cs |
| S07 | Missing Artifact ID Validation | Stealth | ★★★★★ | Never | WorkloadMwcTokenV2Authenticator.cs |
| S08 | Token Provider TOCTOU Race | Stealth | ★★★☆☆ | Hours | BaseTokenProvider.cs |
| S09 | Schema Cache Pollution | Stealth | ★★★★☆ | Days | InsightsMetricsTableManager.cs |
| S10 | Nullable ParallelNodeLimit Bypass | Stealth | ★★★☆☆ | Minutes | DagSettings.cs |
| S11 | Negative Duration Telemetry | Stealth | ★★☆☆☆ | Hours | DagExecutionHandlerV2.cs |
| S12 | CascadingCancellation Null Return | Stealth | ★★★☆☆ | Minutes | CascadingCancellation.cs |
| S13 | Rate Limiter TOCTOU Double Bucket | Stealth | ★★★☆☆ | Never | TokenBucketRateLimiterCache.cs |
| S14 | Token Expiry Precision Loss | Stealth | ★★☆☆☆ | Hours | EdogApiProxy.cs |
| S15 | Sliding Expiration Never Evicts | Stealth | ★★★☆☆ | Days | TokenBucketRateLimiterCache.cs |
| H01 | Retry Amplification | Hacky | ★★★★★ | Hours | RetryExecutor.cs |
| H02 | Multiple Decorator Silent Drop | Hacky | ★★★★☆ | Weeks | NotebookExecutionContext.cs |
| H03 | JSON Library Mismatch | Hacky | ★★★★☆ | Never | Multiple |
| H04 | Empty DAG Instant Success | Hacky | ★★★☆☆ | Days | DagExecutionHandlerV2.cs |
| H05 | Table Name Path Traversal | Hacky | ★★★★☆ | Hours | NotebookExecutionContext.cs |
| H06 | Guid.Empty Null Name | Hacky | ★★★☆☆ | Seconds | DagUtils.cs |
| H07 | EDOG Token Exposure | Both | ★★★★★ | Never | EdogApiProxy.cs |
| H08 | Parallelism=2 Convoy | Hacky | ★★★☆☆ | Hours | DagExecutionHandlerV2.cs |
| H09 | Permission Bypass Missing Claims | Hacky | ★★★★☆ | Never | RequiresPermissionFilter.cs |
| H10 | Simultaneous Deployment Race | Hacky | ★★★★☆ | Days | TokenManager.cs + DagExecutionStore.cs |
| H11 | Stack Trace Information Leak | Hacky | ★★★☆☆ | Never | MLVRefreshOutput.cs |
| H12 | Incompatible Feature Flags | Hacky | ★★★★☆ | Days | FeatureFlighter.cs |
| H13 | Incremental Cycle Bypass | Hacky | ★★★★☆ | Hours | Dag.cs |
| H14 | Shared State Dictionary Race | Both | ★★★★☆ | Days | DagExecutionContext.cs |
| H15 | Token Refresh Thundering Herd | Hacky | ★★★☆☆ | Minutes | BaseTokenProvider.cs |
| C01 | The Perfect Storm | Both | ★★★★★ | Weeks | Multiple |
| C02 | Observability Blackout | Both | ★★★★☆ | Never | Multiple |

---

## EDOG STUDIO INTEGRATION PRIORITIES

### Must-Have Panels (Phase 2 - Connected Mode)

1. **Token Identity Monitor** — Show which user's token is cached for each lakehouse. Alert on mismatches. (S01, H10)
2. **Entity Resolution Audit** — Show how each catalog entity was resolved (ID-based vs. name-based). Flag name-based fallbacks. (S02)
3. **Feature Flag Truth Table** — Compare `FeatureFlighter.IsEnabled()` result vs. actual flight service state. Flag overrides. (S06, H12)
4. **Retry Amplification Counter** — Show retry count per request. Alert above threshold. (H01)
5. **Rate Limiter State Inspector** — Show cache size, per-key token counts, sliding expiration timers. (S04, S13, S15)

### Nice-to-Have Panels

6. **Memory Leak Tracker** — Show `dagSaveLocks.Count` and `checkDagNodesToExecuteLocks.Count` over time. (S03)
7. **Clock Drift Detector** — Compare DateTime.UtcNow vs. Stopwatch for same intervals. (S05, S11)
8. **Concurrency Visualizer** — Show parallel node execution, lock contention, thundering herd patterns. (H08, H14, H15)
9. **Input Validator** — Show all unvalidated inputs passing through the system. (S10, H05, H06)
10. **Decorator Analyzer** — Parse notebooks and flag cells with multiple decorators, malformed names. (H02, H05)

---

*"The scariest bugs are the ones that pass all your tests."*
— Sana Reeves, FLT Architect
