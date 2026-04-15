# FLT Auth & Token Chaos Engineering Scenarios

> **Author:** Sana Reeves (Architect) — channeling Principal Security & Identity Engineer
> **Scope:** `Service/Microsoft.LiveTable.Service/` — all auth, token, and identity flows
> **Date:** 2025-07-17
> **Classification:** INTERNAL — EDOG Chaos Engineering Reference

---

## CHAOS CATEGORY: Token Lifecycle & Cache Manipulation

### Scenario 1: Token Expiry Mid-DAG Execution (The Silent Stale Token)

- **Inject**: Force the MWC token cached in `TokenManager.iterationTokens` to have an expiry 30 seconds in the future, then delay the next Spark HTTP call by 35 seconds
- **Where**: `TokenManagement/TokenManager.cs::GetTokenAsync()` (line 61–100) — the retry polling loop reads cached token; `SparkHttp/GTSBasedSparkClient.cs::GetMWCV1TokenForGTSWorkloadAsync()` (line 501) consumes it
- **Breaks**: The `GetTokenAsync` polling loop returns a token that passes the `MwcTokenFetchBeforeExpiryInMinutes` check (default 10 min threshold) but expires before the actual Spark HTTP request is built. `GTSBasedSparkClient` adds the stale MWC V1 token to the `Authorization` header (line 747). Spark GTS returns 401. Since 401 is **non-retriable** (line 652–654), the transform immediately fails with `TransformationState.Failed`
- **Real-world**: Long-running DAG with 50+ nodes. Token issued at DAG start has 1-hour validity. Node 48 starts at minute 55. Token fetched from cache passes the 10-min buffer check, but by the time Spark processes the request, it's expired
- **Revert**: Clear the token cache entry via `DeleteCachedToken()`, or inject a fresh token via `UpdateCachedToken()`
- **Difficulty**: Medium
- **Impact**: **Critical** — entire DAG execution fails at a late stage, wasting all prior compute

---

### Scenario 2: Token Cache Poisoning — Wrong Lakehouse Token

- **Inject**: Call `TokenManager.CacheToken(lakehouseId_A, iterationId_X, token_for_lakehouse_B)` — cache a valid but wrong-scope MWC token
- **Where**: `TokenManagement/TokenManager.cs::CacheToken()` (line 103–123). The key is `"{lakehouseId}_{iterationId}"` (line 244). There is **no validation** that the token's claims match the lakehouse ID being cached
- **Breaks**: When `GTSBasedSparkClient` fetches the token via `DagExecutionTokenProvider` → `TokenManager.GetTokenAsync()`, it gets a valid JWT that authenticates to Spark, but the MWC V1 token's `WorkspaceObjectId` claim doesn't match the target lakehouse. Spark rejects with 403 Forbidden. Non-retriable → transform fails
- **Real-world**: Multi-tenant service processing requests for different workspaces. Request routing error causes token for tenant A to be cached under tenant B's key
- **Revert**: `DeleteCachedToken(lakehouseId_A, iterationId_X)` and let the legitimate flow re-cache
- **Difficulty**: Easy
- **Impact**: **Critical** — potential cross-tenant data exposure if the audience happens to overlap

---

### Scenario 3: Token Refresh Race — Semaphore Contention Storm

- **Inject**: Delay `tokenSemaphore.Wait()` in `TokenManager.UpdateCachedToken()` (line 137) by 5 seconds. Simultaneously fire 20 DAG scheduler callbacks that each call `UpdateCachedToken()`
- **Where**: `TokenManagement/TokenManager.cs::UpdateCachedToken()` (line 132–179). Uses `SemaphoreSlim(1,1)` — only one thread can update at a time. All others queue. Note: `tokenSemaphore.Wait()` is **synchronous** (not `WaitAsync`), blocking the thread pool
- **Breaks**: 19 threads block on the semaphore. The `MwcTokenUpdateTimeBeforeExpiryInMinutes` check (line 141–148) re-evaluates after acquiring the lock. By the time thread #15 gets through, the token it's carrying may itself be expired
- **Real-world**: Burst of scheduled DAG completions at the same time (e.g., hourly batch). All scheduler callbacks hit `UpdateOrDeleteTokenInTokenManager` simultaneously
- **Revert**: Reduce concurrent DAG count or increase semaphore permits
- **Difficulty**: Easy
- **Impact**: **High** — thread pool starvation, cascading request timeouts across the service

---

### Scenario 4: Ghost Token — Dispose During Active Read

- **Inject**: Call `BaseTokenProvider.Dispose()` while another thread is in `GetTokenAsync()` between the fast-path validity check (line 61) and the return statement
- **Where**: `TokenManagement/BaseTokenProvider.cs::Dispose()` (line 115) sets `cachedToken = null`. The fast-path in `GetTokenAsync()` (line 61) reads `cachedToken` without the async lock
- **Breaks**: Thread A checks `CheckTokenValidity()` → returns true. Thread B calls `Dispose()` → sets `cachedToken = null`. Thread A returns `cachedToken` which is now null → `NullReferenceException` or empty auth header → 401
- **Real-world**: Service shutdown/restart while active requests are in flight. DI container disposes singletons while request pipeline is still draining
- **Revert**: Restart the service (token provider re-initialized)
- **Difficulty**: Hard
- **Impact**: **Medium** — affects in-flight requests during graceful shutdown

---

### Scenario 5: JWT Expiry Parsing Failure — The 1-Hour Fallback Bomb

- **Inject**: Return a token where `AADTokenInfo.ExpiresOn` is `DateTime.MinValue` AND the JWT `exp` claim is malformed (not a valid Unix timestamp)
- **Where**: `SparkHttp/GTSBasedSparkClient.cs::GenerateMWCV1TokenForGTSWorkloadAsync()` (lines 343–376). Three-tier fallback: (1) `ExpiresOn` field → (2) JWT `exp` claim → (3) hardcoded `DateTime.UtcNow + 1 hour`
- **Breaks**: Both primary paths fail silently. Falls to `UtcNow + 1 hour`. If the real token actually expires in 20 minutes (AAD short-lived token), the service believes it's valid for 1 hour. Requests succeed initially, then fail at minute 20 with no refresh trigger
- **Real-world**: AAD issues short-lived token during incident response. WCL library update changes `ExpiresOn` format. JWT has non-standard claims
- **Revert**: Force token regeneration by setting `currentMwcV1Token = null`
- **Difficulty**: Medium
- **Impact**: **High** — delayed auth failures that are extremely hard to diagnose

---

### Scenario 6: User Identity Confusion — Cross-User Token Update

- **Inject**: User A caches a token for `lakehouse_X/iteration_Y`. User B sends an `UpdateCachedToken` request for the same key with their own token
- **Where**: `TokenManagement/TokenManager.cs::UpdateCachedToken()` (line 150–158). The code compares `UserObjectId` from the new token to the cached token's. If they differ, it **only logs a warning** — does NOT reject the update
- **Breaks**: User B's token overwrites User A's. When User A's DAG next fetches the token, it gets User B's identity. Spark executes with User B's permissions
- **Real-world**: Shared workspace where multiple users trigger refreshes for the same lakehouse. Race condition in the scheduler callback
- **Revert**: Delete the poisoned cache entry; User A re-triggers their flow
- **Difficulty**: Easy
- **Impact**: **Critical** — identity confusion, potential privilege escalation or data leakage

---

## CHAOS CATEGORY: Authentication Bypass & Validation Gaps

### Scenario 7: DisableFLTAuth Kill Switch — Full Auth Bypass

- **Inject**: Set the host parameter `DisableFLTAuth = true`
- **Where**: `Initialization/ControllersConfig.cs` (line 57–64), `Authorization/MwcV2RequirePermissionsFilter.cs` (line 44), `Authorization/RequiresPermissionFilter.cs` (line 53)
- **Breaks**: ALL controllers switch to `GetNoAuthenticationAuthenticator()`. No MWC token validation. No S2S token validation. No permission checks. Affected: `LiveTableController`, `LiveTableRefreshTriggersController`, `LiveTableSchedulerRunController`, `LiveTableMaintenanceController`, `LiveTablePublicController`, `MLVExecutionDefinitionPublicController`
- **Real-world**: DevBox setting accidentally promoted to production. Config drift after service update
- **Revert**: Set `DisableFLTAuth = false` and restart
- **Difficulty**: Easy
- **Impact**: **Critical** — complete authentication bypass on ALL API endpoints

---

### Scenario 8: MWC V2 Workload Type Validation Disabled (TODO Exploit)

- **Inject**: Send a MWC V2 token issued for a different workload type (e.g., Lakehouse instead of LiveTable)
- **Where**: `Authorization/WorkloadMwcTokenV2Authenticator.cs` (lines 48–59). Workload type validation is **commented out** with a TODO
- **Breaks**: V2 authenticator accepts tokens for any Fabric workload. Cross-workload boundary violation
- **Real-world**: Compromised Lakehouse token grants access to LiveTable APIs in multi-workload Fabric
- **Revert**: Uncomment and fix the workload type validation
- **Difficulty**: Easy
- **Impact**: **High** — workload isolation boundary violation

---

### Scenario 9: V2 Artifact ID Validation Missing (TODO Exploit)

- **Inject**: Send a MWC V2 token with correct workspace but different artifact ID than the API endpoint targets
- **Where**: `Authorization/WorkloadMwcTokenV2Authenticator.cs` (line 76). Artifact ID check marked TODO pending platform support
- **Breaks**: V2 path validates workspace ID but NOT artifact ID. Token scoped to artifact A can access artifact B in the same workspace
- **Real-world**: User has access to one lakehouse in a workspace but not another
- **Revert**: Implement artifact ID validation when platform supports it
- **Difficulty**: Easy
- **Impact**: **High** — intra-workspace artifact access control bypass

---

### Scenario 10: S2S Authenticator Silent Failure Cascade

- **Inject**: Configure all trusted tenant/client ID pairs to fail with different exception types (timeout, invalid signature, expired)
- **Where**: `Authorization/UserMwcAndS2STokenAuthenticator.cs` (lines 132–163). Loops through ALL pairs, each failure **silently caught** (line 150) before trying next
- **Breaks**: With N trusted pairs × 2-second timeout each = 2N seconds per request before auth fails. Thread pool exhaustion under load
- **Real-world**: Network partition between FLT and identity provider. All S2S validations timeout without short-circuit
- **Revert**: Reduce trusted pairs or add circuit breaker
- **Difficulty**: Medium
- **Impact**: **High** — thread pool exhaustion, service-wide latency spike

---

## CHAOS CATEGORY: Token Type Confusion & Header Manipulation

### Scenario 11: MWC Token Where Bearer Expected (Header Scheme Confusion)

- **Inject**: Set `Authorization: MwcToken {jwt}` on the OneLake REST client path (expects `Bearer`)
- **Where**: `OneLake/OneLakeRestClient.cs` (line 264) sets `Bearer`. `SparkHttp/GTSBasedSparkClient.cs` (line 747) sets `MwcToken`. EDOG interceptor swaps the format
- **Breaks**: OneLake rejects → 401 → `UnauthorizedAccessException` (line 330–332). Non-retriable. All OneLake operations fail
- **Real-world**: Refactoring bug where auth header construction is shared between Spark and OneLake paths
- **Revert**: Fix header scheme to match target service
- **Difficulty**: Easy
- **Impact**: **High** — all OneLake operations fail, DAG cannot read/write data

---

### Scenario 12: S2S Token Header Swap — Wrong Header Key

- **Inject**: Put S2S token in `Authorization` instead of `x-ms-s2s-actor-authorization`, and vice versa
- **Where**: `UserMwcAndS2STokenAuthenticator.cs` (lines 63–77) expects specific headers. `GTSBasedSparkClient.cs` (lines 747–751) sets two different headers
- **Breaks**: MWC authenticator tries to validate S2S token as user token → fails. S2S authenticator tries to validate user token → fails. Both paths fail
- **Real-world**: HTTP proxy or load balancer normalizing/swapping authorization headers
- **Revert**: Restore correct header mapping
- **Difficulty**: Easy
- **Impact**: **Critical** — dual-token auth completely broken, all scheduler-triggered DAG executions fail

---

### Scenario 13: Corrupted JWT — Malformed Token Injection

- **Inject**: Replace JWT payload with `{"invalid": true}` while keeping header and signature
- **Where**: `Utils/HttpTokenUtils.cs::TryGetExpiryFromJwtToken()` (lines 138–163), `Authorization/RequiresPermissionFilter.cs` (line 90)
- **Breaks**: `ReadJwtToken()` succeeds (reads without signature validation) but `exp` claim missing → `ValidTo = DateTime.MinValue`. Expiry check returns false. WorkloadClaims deserialization fails → 401. In GTSBasedSparkClient, 1-hour fallback activates (compound with Scenario 5)
- **Real-world**: Token corruption in transit (bit flip). Encoding issue. Proxy re-encoding tokens
- **Revert**: Retry with valid token
- **Difficulty**: Easy
- **Impact**: **Medium** — auth failure with confusing error messages

---

## CHAOS CATEGORY: Downstream Service Auth Failures

### Scenario 14: OneLake S2S Token Provider Timeout — Cascade Stall

- **Inject**: Make `S2STokenProvider.GetS2STokenForOneLakeAsync()` hang for 30 seconds
- **Where**: `TridentIntegration/PartnerAuthorization/S2STokenProvider.cs` (line 66–83). Called per-request by `OneLake/OneLakeRestClient.cs` (line 267)
- **Breaks**: Every OneLake call blocks 30s. Retry policy adds exponential backoff on top. Thread pool saturates. Service becomes unresponsive
- **Real-world**: AAD regional outage. Identity provider rate limiting. DNS resolution failure
- **Revert**: Restore identity provider connectivity
- **Difficulty**: Medium
- **Impact**: **Critical** — complete service stall, all OneLake-dependent operations blocked

---

### Scenario 15: Private Link Auth Context Missing — Silent 403

- **Inject**: Remove `SyncToAsyncBridgeHandler` from HTTP handler chain or reorder after `FabricAccessContextHandler`
- **Where**: `HttpClients/HttpClientFactoryRegistry.cs` (lines 45–66). Handler order: `SyncToAsyncBridgeHandler` → `RootActivityIdCorrelationHandler` → `FabricAccessContextHandler` → `OneLakeRequestTracingHandler`
- **Breaks**: `x-ms-fabric-s2s-access-context` header never set for sync calls. OneLake Private Link returns 403 `DeniedByPolicy`. Only affects PL workspaces — non-PL works fine
- **Real-world**: Handler registration order changed during refactoring. New handler inserted at wrong position
- **Revert**: Restore correct handler chain order
- **Difficulty**: Medium
- **Impact**: **High** — silent failure in Private Link workspaces only (hard to detect in testing)

---

### Scenario 16: Certificate Validation Bypass Exploitation (MITM)

- **Inject**: Place a TLS-intercepting proxy between FLT and DatalakeDirectoryClient
- **Where**: `HttpClients/HttpClientFactoryRegistry.cs` (line 42): `ServerCertificateCustomValidationCallback = (msg, cert, chain, err) => true` — accepts ANY certificate
- **Breaks**: MITM proxy intercepts all DatalakeDirectoryClient traffic including tokens: `Authorization: Bearer {user_token}` and `x-ms-s2s-actor-authorization: Bearer {s2s_token}`. Attacker replays tokens
- **Real-world**: Corporate proxy with TLS inspection. Compromised network. Cloud provider misconfiguration
- **Revert**: Implement proper certificate validation
- **Difficulty**: Easy
- **Impact**: **Critical** — token theft, full data access with captured credentials

---

### Scenario 17: OBO Token Non-PBI Exception — Unhelpful 500

- **Inject**: Cause OBO token exchange to fail with `TaskCanceledException` (timeout)
- **Where**: `TridentIntegration/PartnerAuthorization/S2STokenProvider.cs::GetOboTokenForTargetAudienceAsync()` (lines 190–215). Only catches `PBIServiceException` (line 208). Other exceptions propagate unhandled
- **Breaks**: `TaskCanceledException` → unhandled → 500 Internal Server Error with no auth-specific context
- **Real-world**: Network timeout to AAD during OBO exchange. DNS failure
- **Revert**: Retry with valid connectivity
- **Difficulty**: Easy
- **Impact**: **Medium** — unhelpful 500 error, increased debugging time

---

## CHAOS CATEGORY: Feature Flag & Configuration Attacks

### Scenario 18: Token Cleanup Kill Switch — Memory Leak

- **Inject**: Enable `FLTTokenManagerSkipClearOnDagCompletion` feature flag
- **Where**: `Controllers/LiveTableSchedulerRunController.cs::UpdateOrDeleteTokenInTokenManager()`. When enabled, completed DAGs call `UpdateCachedToken()` instead of `DeleteCachedToken()`
- **Breaks**: Tokens for completed DAGs never cleaned up. `ConcurrentDictionary<string, Token>` grows unboundedly. Memory leak proportional to DAG count. Over hours/days: GC pauses → OOM
- **Real-world**: Flag enabled during incident, never reverted. "Temporary" flag becomes permanent
- **Revert**: Disable flag; restart service to clear cache
- **Difficulty**: Easy
- **Impact**: **High** — slow memory leak leading to service degradation

---

### Scenario 19: Token Expiry Buffer Manipulation

- **Inject**: Set `TokenExpiryBufferInMinutes` to 0 (no buffer) or 120 (2-hour buffer)
- **Where**: `TokenManagement/BaseTokenProvider.cs::GetTokenExpiryBufferMinutes()` (line 134–136)
- **Breaks**:
  - **Buffer = 0**: Tokens used until exact expiry second → high 401 rate on slow requests
  - **Buffer = 120**: For 1-hour token, `120 > 60` → token ALWAYS expired → every call triggers refresh → IDP rate limits → 401 cascade
- **Real-world**: Config drift. Operator sets value thinking it's in seconds
- **Revert**: Restore sensible buffer (~10 minutes)
- **Difficulty**: Easy
- **Impact**: **High** — either stale tokens or refresh storm

---

### Scenario 20: Tenant ID Resolution Failure — Auth Without Context

- **Inject**: Request with non-GUID `TenantId` in `CustomerCapacityAsyncLocalContext`
- **Where**: `Authorization/ResolveTenantIdForFabricAccessProtectionAttribute.cs` (lines 25–34). `Guid.TryParse()` fails → logs warning → does NOT set `HttpContext.Items[WorkspaceTenantID]`
- **Breaks**: Non-throwing. Downstream `FeatureFlighter.IsEnabled()` calls with `tenantId: null` → feature flags resolve without tenant context → may return wrong values. Tenant-specific auth policies don't apply
- **Real-world**: Malformed request from older client. Proxy strips/corrupts tenant headers
- **Revert**: Fix tenant ID format in request
- **Difficulty**: Easy
- **Impact**: **Medium** — silent tenant context loss, feature flags resolve incorrectly

---

## CHAOS CATEGORY: Compound & Cascade Scenarios

### Scenario 21: The Perfect Storm — Expiry + Semaphore + No Retry

- **Inject**: Combine: (1) MWC token 4 min from expiry (below 5-min `tokenExpiryThreshold`), (2) `mwcV1TokenAcquireSemaphore` held by slow refresh (3s), (3) 10 concurrent transform requests
- **Where**: `SparkHttp/GTSBasedSparkClient.cs` — semaphore (line 67), `IsNullOrExpiringSoon()` (line 549–551), non-retry on 401 (line 652–654)
- **Breaks**: Request 1 starts refresh. Requests 2–10 queue. If refresh fails (IDP transient error), all 10 get null token → 401 → non-retriable → all 10 transforms fail simultaneously
- **Real-world**: Burst of DAG activity + IDP degradation + network jitter
- **Revert**: Increase threshold, add 401 retry, implement token pre-fetch
- **Difficulty**: Hard
- **Impact**: **Critical** — mass DAG failure across the service

---

### Scenario 22: S2S Token Audience Mismatch — Wrong Target

- **Inject**: Make `GetS2STokenForTargetAudienceAsync()` return token with PBI Shared audience instead of GTS
- **Where**: `TridentIntegration/PartnerAuthorization/S2STokenProvider.cs` (lines 106–113). `GTSBasedSparkClient` calls with `GTSFirstPartyApplicationId` (line 403–404)
- **Breaks**: Spark GTS validates audience claim → rejects because audience is PBI Shared → 403 Forbidden. Token IS valid (just wrong audience), so debugging requires JWT claims inspection
- **Real-world**: Config error maps wrong audience. S2S token cache mismatch between regions
- **Revert**: Fix audience configuration or clear S2S token cache
- **Difficulty**: Medium
- **Impact**: **High** — all Spark operations fail with misleading 403

---

## Summary Matrix

| # | Scenario | Impact | Difficulty | Category |
|---|----------|--------|------------|----------|
| 1 | Token Expiry Mid-DAG | Critical | Medium | Token Lifecycle |
| 2 | Cache Poisoning — Wrong Lakehouse | Critical | Easy | Token Lifecycle |
| 3 | Semaphore Contention Storm | High | Easy | Token Lifecycle |
| 4 | Ghost Token — Dispose Race | Medium | Hard | Token Lifecycle |
| 5 | JWT Expiry Parse → 1hr Fallback | High | Medium | Token Lifecycle |
| 6 | Cross-User Token Update | Critical | Easy | Token Lifecycle |
| 7 | DisableFLTAuth Kill Switch | Critical | Easy | Auth Bypass |
| 8 | V2 Workload Type Disabled | High | Easy | Auth Bypass |
| 9 | V2 Artifact ID Missing | High | Easy | Auth Bypass |
| 10 | S2S Silent Failure Cascade | High | Medium | Auth Bypass |
| 11 | MWC/Bearer Scheme Confusion | High | Easy | Token Confusion |
| 12 | S2S Header Swap | Critical | Easy | Token Confusion |
| 13 | Corrupted JWT Injection | Medium | Easy | Token Confusion |
| 14 | OneLake S2S Timeout Cascade | Critical | Medium | Downstream |
| 15 | Private Link Auth Context Missing | High | Medium | Downstream |
| 16 | Cert Validation Bypass (MITM) | Critical | Easy | Downstream |
| 17 | OBO Non-PBI Exception | Medium | Easy | Downstream |
| 18 | Token Cleanup Kill Switch | High | Easy | Config Attack |
| 19 | Expiry Buffer Manipulation | High | Easy | Config Attack |
| 20 | Tenant ID Resolution Failure | Medium | Easy | Config Attack |
| 21 | Perfect Storm Compound | Critical | Hard | Compound |
| 22 | S2S Audience Mismatch | High | Medium | Compound |

---

## EDOG Implementation Priority

**Phase 1 — Quick Wins (Easy + Critical/High):**
Scenarios 2, 6, 7, 11, 12, 13, 16

**Phase 2 — Medium Effort, Critical Insight:**
Scenarios 1, 5, 10, 14, 15

**Phase 3 — Configuration Chaos:**
Scenarios 18, 19, 20, 8, 9

**Phase 4 — Advanced Compound:**
Scenarios 21, 4, 22
