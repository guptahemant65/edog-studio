# C04: Security Probing — Auth Boundary Testing

> **Author:** Sana Reeves (Architect)
> **Status:** DEEP SPEC — READY FOR REVIEW
> **Date:** 2025-07-25
> **Depends On:** `interceptor-audit.md` §1.1–1.3, `engine-design.md` §2–4
> **FLT Source:** `CLEAN` at `C:\Users\guptahemant\newrepo\workload-fabriclivetable\Service\Microsoft.LiveTable.Service\`

---

## 1. Purpose

FLT has **four distinct authentication paths**, **two authorization filters**, and a **dev-mode auth bypass** (`DisableFLTAuth`). These paths are exercised by production traffic but never deliberately stress-tested for boundary conditions:

- What happens when a MWC V2 token carries a workspace claim that mismatches the URL?
- What happens when the S2S `x-ms-s2s-actor-authorization` header is present but carries a user-audience token?
- What happens when `DisableFLTAuth` is toggled at runtime while requests are in flight?
- Does FLT properly reject a token whose `exp` claim is in the past but whose signature is valid?
- The V2 authenticator has a **commented-out workload type validation** and a **TODO for artifact ID validation** — what would break if those checks were enforced?

Security Probing lets engineers **inject precise auth mutations** through the chaos panel — rewriting tokens, stripping headers, swapping audiences, injecting cross-tenant claims — and observe FLT's response at each layer. This is not a pentest tool; it's a **developer cockpit for hardening auth code paths.**

---

## 2. FLT Authentication Architecture (Reference)

### 2.1 Token Types

| Token Type | Header | Scheme | Issuer | Used By |
|-----------|--------|--------|--------|---------|
| MWC V1 | `Authorization` | `MwcToken` | Fabric Platform | `LiveTableController`, `LiveTableRefreshTriggersController`, `LiveTableMaintenanceController` |
| MWC V2 | `Authorization` | `MwcToken` | Fabric Platform (V2) | `LiveTablePublicController`, `MLVExecutionDefinitionPublicController` |
| S2S (AAD) | `x-ms-s2s-actor-authorization` | `Bearer` | AAD | `LiveTableSchedulerRunController` (2nd factor alongside MWC V2) |
| User AAD | `Authorization` | `Bearer` | AAD | `PublicAadProtectedController` |
| Service Principal AAD | `Authorization` | `Bearer` | AAD (app identity) | `InternalServiceController` |

### 2.2 Authenticator Chain

```
ControllersConfig.SetupAndGetAuthenticators()
  → Initialization/ControllersConfig.cs:33–89
    ├─ disableFltAuth check (line 57) → GetNoAuthenticationAuthenticator()
    ├─ WorkloadMwcTokenV1Authenticator
    │   → Authorization/WorkloadMwcTokenV1Authenticator.cs
    │   → Validates: JWT format, signature, workloadType == "LiveTable",
    │     workspaceId claim vs URL, artifactId claim vs URL
    ├─ WorkloadMwcTokenV2Authenticator
    │   → Authorization/WorkloadMwcTokenV2Authenticator.cs
    │   → Validates: JWT format, signature, PlatformClaims.WorkspaceObjectId vs URL
    │   → COMMENTED OUT: workloadType validation (line 50–59)
    │   → TODO: artifactId validation (line 76)
    ├─ UserMwcAndS2STokenAuthenticator
    │   → Authorization/UserMwcAndS2STokenAuthenticator.cs
    │   → Two-factor: MWC V2 from Authorization + S2S from x-ms-s2s-actor-authorization
    │   → Header swap trick (lines 85–96): copies S2S header to Authorization for platform validator
    └─ RequiresPermissionFilter / MwcV2RequirePermissionsFilter
        → Authorization/RequiresPermissionFilter.cs
        → Authorization/MwcV2RequirePermissionsFilter.cs
        → Both check DisableFLTAuth (lines 53/44) → skip authz if true
```

### 2.3 Token Lifecycle (Outbound)

```
TokenManager.CacheToken()       → TokenManagement/TokenManager.cs:103
  → Extracts UserObjectId from MWC workload claims
  → Keyed by "{lakehouseId}_{iterationId}"
  → Expiry from JWT exp claim

BaseTokenProvider.GetTokenAsync() → TokenManagement/BaseTokenProvider.cs:58
  → Double-check locking with AsyncLock
  → Buffer: refresh N minutes before exp (configurable)

SystemTokenProvider.RefreshTokenAsync() → TokenManagement/SystemTokenProvider.cs:60
  → Gets service MWC token via ITridentAuthorityProvider.GetServiceMwcToken()
  → audience = TridentLakeOboTokenResourceId

S2STokenProvider.GetS2STokenForOneLakeAsync() → TridentIntegration/PartnerAuthorization/S2STokenProvider.cs:66
  → Two paths: IsTridentLakeStorageS2SAudienceSupported → storage audience vs MWC rollout audience
```

### 2.4 Key Constants

```csharp
// TridentIntegration/PartnerAuthorization/MwcTokenConstants.cs
WorkloadId = "LiveTable"
StorageAudience = "https://storage.azure.com"
LiveTableArtifactType = "LiveTable"

// Common/Constants.cs (referenced)
LiveTableWorkloadType  // Used in V1 workloadType claim validation
WorkloadApiArtifactPathRegex  // Matches workspace/artifact from URL path
```

---

## 3. Interception Strategy

Security probing operates at **two layers**:

### Layer 1: Outbound Token Mutation (EdogTokenInterceptor position)

The `EdogTokenInterceptor` sits first in the `DelegatingHandler` chain. Today it's read-only. For security probing, the upgraded handler can:

1. **Read** the `Authorization` header before `base.SendAsync()`
2. **Decode** the JWT payload (base64, no signature verification needed for mutation)
3. **Modify** specific claims (aud, exp, tid, workspace, artifact permissions)
4. **Re-encode** the token (preserving the original signature — this means the receiving service should reject the modified token if it validates signatures properly)
5. **Replace** the header with the mutated token

**Critical safety note:** Modified tokens will have **invalid signatures** because we change the payload without re-signing. This is intentional — it tests whether downstream services properly validate signatures. If they accept the modified token, that's a finding.

### Layer 2: Inbound Auth Header Mutation (EdogHttpPipelineHandler position)

For testing FLT's own auth validation (inbound requests), EDOG can intercept at the `EdogApiProxy` level (the Kestrel server that serves the EDOG Studio UI and proxies some operations). However, inbound auth testing is more naturally done by crafting requests through the API Playground or using the chaos rule to modify headers on outbound calls that circle back (e.g., FLT calling itself via scheduler).

---

## 4. Scenarios

### SP-01: Token Downgrade (MWC → Bearer)

**What:** Replace the `MwcToken` scheme with `Bearer` on outbound requests, simulating a token type confusion attack.

**Why:** Tests whether downstream services distinguish between MWC tokens and standard Bearer tokens. MWC tokens carry embedded workload claims that Bearer tokens don't — accepting a Bearer where MWC is expected could skip authorization checks.

**FLT Code Paths Affected:**
- `Authorization/RequiresPermissionFilter.cs:72` — Checks `authorizationScheme == HttpConstants.MwcTokenHeader`; if scheme is `Bearer`, throws `AuthenticationFailedException`
- `Authorization/WorkloadMwcTokenV1Authenticator.cs:48` — `MwcTokenAuthenticator<GenericMwcTokenWorkloadClaims>` expects MWC token format
- `Authorization/WorkloadMwcTokenV2Authenticator.cs:45` — `MwcTokenV2AadAuthenticator` expects MWC V2 format
- `TokenManagement/TokenManager.cs:107` — `HttpTokenUtils.GetUserObjectIdFromMwcTokenWorkloadClaims()` will fail if token lacks workload claims

**ChaosRule JSON:**
```json
{
  "id": "sp-01-token-downgrade",
  "name": "Token Downgrade: MWC → Bearer",
  "description": "Replaces MwcToken auth scheme with Bearer on outbound requests",
  "enabled": true,
  "priority": 100,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "requestHeader", "key": "Authorization", "op": "contains", "value": "MwcToken " }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "set",
        "name": "Authorization",
        "value": "Bearer ${token_value}",
        "transform": "replace_scheme"
      }
    }
  ],
  "safety": {
    "maxFirings": 10,
    "ttlSeconds": 120
  }
}
```

**C# Mechanism:**
```csharp
// In upgraded EdogHttpPipelineHandler.SendAsync(), request-phase action:
if (action.Type == "modifyRequestHeader" && action.Config.Transform == "replace_scheme")
{
    var authHeader = request.Headers.Authorization;
    if (authHeader?.Scheme?.Equals("MwcToken", StringComparison.OrdinalIgnoreCase) == true)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", authHeader.Parameter);
        // Parameter (the token body) is preserved — only the scheme word changes
    }
}
```

**Edge Cases:**
- Token body is identical, only scheme changes — downstream may parse it as JWT regardless
- Some FLT-internal calls use `MwcToken` scheme as a signal to extract workload claims; changing to `Bearer` breaks `RequiresPermissionFilter` early (line 72–80)
- `x-ms-s2s-actor-authorization` header is unaffected — only `Authorization` is modified

**Revert:** Disable rule. Next request uses original scheme. No persistent state change.

---

### SP-02: Token Expiry Injection

**What:** Modify the `exp` claim in outbound JWT tokens to a timestamp in the past, simulating expired token delivery.

**Why:** Tests the token-expiry validation in every downstream service FLT talks to, and tests FLT's own retry logic when a 401 comes back due to an expired token. Critically, this probes `BaseTokenProvider.CheckTokenValidity()` (line 155–168) — the buffer-minutes logic that's supposed to pre-emptively refresh tokens.

**FLT Code Paths Affected:**
- `TokenManagement/BaseTokenProvider.cs:155–168` — `CheckTokenValidity()` compares `DateTime.UtcNow < tokenExpiry.AddMinutes(-bufferMinutes)`. If token already in cache with future expiry, it won't re-fetch.
- `TokenManagement/TokenManager.cs:74–83` — `GetTokenAsync()` loop checks `timeDifference.TotalMinutes > beforeExpiryTime`. An already-cached token with a tampered exp won't be detected here because the cache stores the *original* expiry.
- `TokenManagement/TokenManager.cs:216–227` — `CalculateExpiryTime()` calls `HttpTokenUtils.TryGetExpiryFromJwtToken()` — but only at cache-time, not per-use.
- `TridentIntegration/PartnerAuthorization/AadTokenProvider.cs:48–54` — OBO flow passes the (now-expired) user token; AAD will reject it.

**ChaosRule JSON:**
```json
{
  "id": "sp-02-token-expiry",
  "name": "Token Expiry: Force Expired",
  "description": "Rewrites JWT exp claim to 1 hour in the past on outbound Authorization headers",
  "enabled": true,
  "priority": 100,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "requestHeader", "key": "Authorization", "op": "exists" },
      { "field": "url", "op": "not_contains", "value": "/health" }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "set",
        "name": "Authorization",
        "value": null,
        "transform": "jwt_mutate",
        "jwtMutation": {
          "claims": {
            "exp": { "op": "subtract", "seconds": 3600 }
          }
        }
      }
    }
  ],
  "safety": {
    "maxFirings": 5,
    "ttlSeconds": 60
  }
}
```

**C# Mechanism:**
```csharp
// JWT claim mutation — decode payload, modify, re-encode (signature becomes invalid)
private static string MutateJwtClaims(string token, JwtMutationConfig mutation)
{
    var parts = token.Split('.');
    if (parts.Length != 3) return token; // Not a JWT, skip

    var payloadJson = Base64UrlDecode(parts[1]);
    var payload = JObject.Parse(payloadJson);

    foreach (var (claimName, op) in mutation.Claims)
    {
        if (op.Op == "subtract" && payload.ContainsKey(claimName))
        {
            var currentExp = payload[claimName].Value<long>();
            payload[claimName] = currentExp - op.Seconds;
        }
        else if (op.Op == "set")
        {
            payload[claimName] = op.Value;
        }
    }

    parts[1] = Base64UrlEncode(payload.ToString(Formatting.None));
    return string.Join(".", parts);
    // Signature (parts[2]) is now invalid — intentional
}
```

**Edge Cases:**
- MWC tokens are JWTs but may have nested tokens (the embedded user AAD token inside workload claims). Mutation only affects the outer JWT `exp`, not the inner token.
- `TokenManager` caches tokens by `{lakehouseId}_{iterationId}` — a cached token with original expiry will continue being served from cache. This rule only affects *outbound* headers, not the cached copy.
- If downstream returns 401, FLT's retry logic in `GetTokenAsync()` (polling loop) will keep retrying with the same cached token — revealing the lack of proactive refresh on 401 response.

**Revert:** Disable rule. Cached tokens retain original expiry; next outbound call uses unmodified token.

---

### SP-03: Cross-Tenant Token Injection

**What:** Modify the `tid` (tenant ID) claim in outbound JWT tokens to a different tenant's ID.

**Why:** Tests tenant isolation boundaries. FLT operates in a multi-tenant environment where tenant ID is embedded in tokens and validated against URL path parameters. This probes:
1. Whether OneLake rejects cross-tenant storage access
2. Whether the Fabric platform rejects workspace operations with mismatched tenant
3. Whether FLT's own `SecurityAuditContextManager` (line 41) detects the mismatch

**FLT Code Paths Affected:**
- `TridentIntegration/PartnerAuthorization/AadTokenProvider.cs:50` — Extracts `tid` from JWT to determine which tenant to request OBO token for. Tampered `tid` → OBO request to wrong tenant → AAD rejects or returns token for wrong tenant.
- `TridentIntegration/PartnerAuthorization/S2STokenProvider.cs:95–103` — `GetS2STokenForTargetAudienceAndTenantAsync()` takes explicit tenantId parameter (not from token), but callers extract tenantId from the token.
- `SecurityAuditing/SecurityAuditContextManager.cs:41` — Extracts MWC token from headers for audit logging; a tampered tid creates misleading audit trail.
- `Authorization/WorkloadMwcTokenV2Authenticator.cs:46` — `PlatformClaims` include tenant context; tampered tid may cause workspace validation to fail.

**ChaosRule JSON:**
```json
{
  "id": "sp-03-cross-tenant",
  "name": "Cross-Tenant Token Injection",
  "description": "Replaces tid claim with a known-different tenant ID",
  "enabled": true,
  "priority": 100,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "requestHeader", "key": "Authorization", "op": "exists" },
      { "field": "httpClientName", "op": "not_equals", "value": "EdogStudioClient" }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "set",
        "name": "Authorization",
        "value": null,
        "transform": "jwt_mutate",
        "jwtMutation": {
          "claims": {
            "tid": { "op": "set", "value": "00000000-0000-0000-0000-000000000001" }
          }
        }
      }
    }
  ],
  "safety": {
    "maxFirings": 5,
    "ttlSeconds": 60
  }
}
```

**C# Mechanism:** Same `MutateJwtClaims()` as SP-02, but targeting the `tid` claim with a `set` operation.

**Edge Cases:**
- Nested MWC token: the inner AAD user token also has a `tid` claim. If only the outer is modified, the inner tenant still matches. Thorough testing should also mutate the inner token (requires extracting it from workload claims, mutating, re-embedding).
- `TokenManager.UpdateCachedToken()` (line 150–155) logs when a different user updates a token but does NOT log tenant mismatches — this rule can reveal that gap.
- Multi-tenant S2S calls: `S2STokenProvider.GetS2STokenForTargetAudienceAndTenantAsync()` validates `tenantId` is not null/empty but doesn't cross-check against the request's tenant context.

**Revert:** Disable rule. No server-side state change; subsequent tokens use real tid.

---

### SP-04: Scope / Permission Reduction

**What:** Remove or downgrade permission claims from outbound MWC tokens, simulating a least-privilege violation test.

**Why:** FLT's `RequiresPermissionFilter` (V1) and `MwcV2RequirePermissionsFilter` (V2) check permissions from MWC token claims against per-endpoint requirements. Reducing permissions tests whether:
1. The permission bitmask check in `PbiPermissionsExtensions.HasPermission()` correctly rejects insufficient permissions
2. The V2 `MwcV2PermissionsValidator.ValidateArtifactPermissions()` rejects missing artifact permissions
3. Any code path silently succeeds without proper permission validation

**FLT Code Paths Affected:**
- `Authorization/RequiresPermissionFilter.cs:99–120` — Deserializes `GenericMwcTokenWorkloadClaims`, extracts `WorkspacePermissions` and `ArtifactPermissions`, calls `HasPermission()`. Reduced bitmask → `HasPermission()` returns false → `AuthenticationFailedException`.
- `Authorization/MwcV2RequirePermissionsFilter.cs:64` — Calls `validator.ValidateArtifactPermissions(platformClaims, artifactId, requiredPermissions)`. If artifact permissions array doesn't contain required strings → returns false.
- `Authorization/MwcV2PermissionsValidator.cs:20–40` — `ValidateArtifactPermissions()` uses `ImmutableHashSet.Contains()` on artifact permission strings. Removing entries → validation fails.
- `SparkCore.Workload.Toolkit/Authorization/PbiPermissionsExtensions.cs:22` — Bitmask AND: `(permissions & permissionsToCheck) == permissionsToCheck`. Clearing bits → check fails.

**ChaosRule JSON:**
```json
{
  "id": "sp-04-scope-reduction",
  "name": "Permission Reduction: Strip Execute",
  "description": "Removes Execute permission from MWC token workload claims, leaving only Read",
  "enabled": true,
  "priority": 100,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "requestHeader", "key": "Authorization", "op": "contains", "value": "MwcToken " },
      { "field": "url", "op": "matches", "value": ".*/workloadTypes/LiveTable/workspaces/.*" }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "set",
        "name": "Authorization",
        "value": null,
        "transform": "jwt_mutate",
        "jwtMutation": {
          "claims": {
            "workloadClaims.WorkspacePermissions": { "op": "set", "value": 1 },
            "workloadClaims.Artifacts[0].Permissions": { "op": "set", "value": 1 }
          }
        }
      }
    }
  ],
  "safety": {
    "maxFirings": 10,
    "ttlSeconds": 120
  }
}
```

**C# Mechanism:**
```csharp
// WorkloadClaims are a JSON string inside the JWT payload, under the "workloadClaims" claim.
// For V1: must deserialize, modify, re-serialize back into the claim.
private static string MutateWorkloadClaims(JObject payload, WorkloadClaimsMutation mutation)
{
    var wlClaimsJson = payload["workloadClaims"]?.ToString();
    if (wlClaimsJson == null) return payload.ToString();

    var wlClaims = JObject.Parse(wlClaimsJson);

    if (mutation.WorkspacePermissions.HasValue)
        wlClaims["WorkspacePermissions"] = mutation.WorkspacePermissions.Value;

    if (mutation.ArtifactPermissions.HasValue && wlClaims["Artifacts"] is JArray artifacts)
    {
        foreach (var artifact in artifacts)
            artifact["Permissions"] = mutation.ArtifactPermissions.Value;
    }

    payload["workloadClaims"] = wlClaims.ToString(Formatting.None);
    return payload.ToString(Formatting.None);
}
```

**Edge Cases:**
- V1 permissions are bitmask integers; V2 permissions are string arrays. The mutation config must handle both formats.
- `DisableFLTAuth == true` (line 53/44 in RequiresPermissionFilter/MwcV2RequirePermissionsFilter) bypasses permission checks entirely — permission reduction has no effect when auth is disabled. The rule should detect this and log a warning.
- Some endpoints don't have `[RequiresPermissionFilter]` or `[MwcV2RequirePermissionsFilter]` attributes — permission reduction has no effect on those endpoints (the authenticator still validates token format, but not permissions).

**Revert:** Disable rule. Original permissions flow through.

---

### SP-05: Access Matrix Builder (Automated Probe)

**What:** Automatically probe every FLT API endpoint with every token type and permission combination, building a matrix of what's accepted and what's rejected.

**Why:** FLT has 9 controller types (see `ControllersConfig.cs:69–80`) with different authenticator requirements. The access matrix reveals:
1. Which endpoints accept which token types (MWC V1, V2, S2S, AAD, NoAuth)
2. Which permission levels are required per endpoint
3. Whether `DisableFLTAuth` correctly disables ALL auth checks
4. Whether there are any endpoints that accept tokens they shouldn't

**FLT Code Paths Affected:**
- `Initialization/ControllersConfig.cs:69–80` — Complete controller → authenticator mapping
- Every controller in `Controllers/` — Each endpoint's `[RequiresPermissionFilter]` or `[MwcV2RequirePermissionsFilter]` attributes
- `Authorization/RequiresPermissionFilter.cs:53` and `Authorization/MwcV2RequirePermissionsFilter.cs:44` — `DisableFLTAuth` bypass

**ChaosRule JSON:**

This is a **composite rule** — it's actually a **rule template** that generates N rules, one per (endpoint × tokenType) combination.

```json
{
  "id": "sp-05-access-matrix",
  "name": "Access Matrix Builder",
  "description": "Automated probe: tests every endpoint with every token type. Generates a permission matrix.",
  "enabled": true,
  "priority": 50,
  "type": "composite",
  "template": {
    "endpoints": [
      { "path": "/workloadTypes/LiveTable/workspaces/{wid}/artifacts/{aid}/runDagAsync", "method": "POST", "controller": "LiveTableSchedulerRun" },
      { "path": "/workloadTypes/LiveTable/workspaces/{wid}/artifacts/{aid}/tables", "method": "GET", "controller": "LiveTable" },
      { "path": "/v1/workspaces/{wid}/livetables/{aid}", "method": "GET", "controller": "LiveTablePublic" }
    ],
    "tokenTypes": ["mwc_v1", "mwc_v2", "s2s_bearer", "user_aad", "no_auth", "malformed"],
    "permissionLevels": ["full", "read_only", "no_permissions"],
    "captureMode": "matrix"
  },
  "actions": [
    {
      "type": "tagRequest",
      "config": {
        "tags": { "probe": "access-matrix", "endpoint": "${endpoint}", "tokenType": "${tokenType}" }
      }
    }
  ],
  "safety": {
    "maxFirings": 500,
    "ttlSeconds": 300,
    "maxRatePerSecond": 5
  }
}
```

**C# Mechanism:**
```csharp
// The Access Matrix Builder is a specialized action, not a simple header mutation.
// It generates test requests through the EDOG API proxy (port 5556) against
// the FLT service endpoints, varying the Authorization header for each probe.

public class AccessMatrixProbe
{
    private readonly Dictionary<(string Endpoint, string TokenType, string Permission), ProbeResult> _matrix;

    public async Task RunProbeAsync(AccessMatrixConfig config, CancellationToken ct)
    {
        foreach (var endpoint in config.Endpoints)
        foreach (var tokenType in config.TokenTypes)
        foreach (var permLevel in config.PermissionLevels)
        {
            var token = GenerateTestToken(tokenType, permLevel, endpoint);
            var request = BuildRequest(endpoint, token);
            var response = await SendProbeRequest(request, ct);

            _matrix[(endpoint.Path, tokenType, permLevel)] = new ProbeResult
            {
                StatusCode = (int)response.StatusCode,
                Accepted = response.IsSuccessStatusCode,
                ErrorMessage = response.IsSuccessStatusCode ? null : await response.Content.ReadAsStringAsync(),
                Timestamp = DateTime.UtcNow
            };
        }
    }
}
```

**Output:** A table rendered in the Chaos Panel UI:

```
Endpoint                              │ MWC V1 │ MWC V2 │ S2S    │ AAD    │ NoAuth │ Malformed
──────────────────────────────────────┼────────┼────────┼────────┼────────┼────────┼──────────
POST /runDagAsync (SchedulerRun)      │ 401    │ 200    │ 200    │ 401    │ 401    │ 401
GET  /tables (LiveTable)              │ 200    │ 401    │ 401    │ 401    │ 401    │ 401
GET  /v1/livetables (Public)          │ 401    │ 200    │ 401    │ 401    │ 401    │ 401
```

**Edge Cases:**
- `DisableFLTAuth == true` → the entire matrix flips to 200 for all token types — this IS the finding, and the matrix should highlight it in red.
- Self-referential calls: probing the EDOG API itself (port 5555/5556) must be excluded.
- Rate limiting: `maxRatePerSecond: 5` prevents overwhelming FLT. Each probe is a real HTTP request.
- The matrix doesn't test POST body validation — only authentication/authorization. Body validation is C01/C02 territory.

**Revert:** Disable rule. Matrix data persists in the UI session for review.

---

### SP-06: Auth Header Fuzzing

**What:** Send malformed Authorization headers to test parser resilience.

**Why:** FLT parses Authorization headers at multiple layers: `RequiresPermissionFilter.TryParseAuthorizationHeader()` (line 125–143), `AuthenticationHeaderValue.Parse()` (system), JWT deserialization via `JsonWebToken` constructor (line 90), and the platform `MwcTokenAuthenticator`. Malformed headers can cause:
1. Unhandled exceptions (500 instead of 401)
2. Parser differential (one layer accepts, another rejects)
3. Memory issues (extremely long headers)

**FLT Code Paths Affected:**
- `Authorization/RequiresPermissionFilter.cs:125–143` — `TryParseAuthorizationHeader()` wraps `AuthenticationHeaderValue.Parse()` in try/catch. Returns false on failure.
- `Authorization/RequiresPermissionFilter.cs:61–68` — `StringValues.IsNullOrEmpty(authorizationHeaders)` check.
- `Authorization/RequiresPermissionFilter.cs:90` — `new JsonWebToken(authorizationHeaderValue.Parameter)` — raw JWT constructor, could throw on malformed input.
- `Authorization/WorkloadMwcTokenAuthenticatorBase.cs:35–38` — `HandleInvalidMwcTokenClaim()` throws `AuthenticationFailedException` — but only reached if JWT parsing succeeds with wrong claims. Malformed JWT never reaches this.

**ChaosRule JSON:**
```json
{
  "id": "sp-06-auth-fuzzing",
  "name": "Auth Header Fuzzing",
  "description": "Cycles through malformed Authorization headers: empty, too long, invalid scheme, non-JWT, truncated JWT",
  "enabled": true,
  "priority": 100,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "requestHeader", "key": "Authorization", "op": "exists" },
      { "field": "httpClientName", "op": "not_equals", "value": "EdogStudioClient" }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "set",
        "name": "Authorization",
        "value": null,
        "transform": "fuzz_cycle",
        "fuzzPatterns": [
          "",
          "MwcToken ",
          "MwcToken not-a-jwt",
          "Bearer eyJhbGciOiJSUzI1NiJ9.",
          "MwcToken eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.",
          "FakeScheme eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.fake",
          "MwcToken ${'A'.repeat(100000)}"
        ]
      }
    }
  ],
  "safety": {
    "maxFirings": 7,
    "ttlSeconds": 60
  }
}
```

**C# Mechanism:**
```csharp
// Fuzz cycle: each firing uses the next pattern in the list
private int _fuzzIndex = 0;

private string GetNextFuzzValue(string[] patterns)
{
    var pattern = patterns[Interlocked.Increment(ref _fuzzIndex) % patterns.Length];

    // Handle template expressions
    if (pattern.Contains("${'A'.repeat("))
    {
        var match = Regex.Match(pattern, @"\$\{'A'\.repeat\((\d+)\)\}");
        if (match.Success)
        {
            var count = int.Parse(match.Groups[1].Value);
            count = Math.Min(count, 200_000); // Safety cap
            pattern = pattern.Replace(match.Value, new string('A', count));
        }
    }

    return pattern;
}
```

**Edge Cases:**
- The 100KB header fuzz tests whether `AuthenticationHeaderValue.Parse()` has quadratic behavior or OOM risk. Safety cap at 200KB.
- Empty Authorization header: `StringValues.IsNullOrEmpty()` returns true, so `AuthenticationFailedException(MessageClass.Message2)` is thrown — should be a clean 401, not 500.
- Truncated JWT (2 parts instead of 3): `JsonWebToken` constructor throws `ArgumentException` — caught by platform layer, should produce 401.
- Each fuzz pattern fires once, then the rule exhausts `maxFirings: 7`. The results (status codes) appear in the Traffic Monitor, allowing the engineer to see which patterns produce 401 vs 500.

**Revert:** Disable rule. Stateless — next request sends normal header.

---

### SP-07: DisableFLTAuth Toggle Probe

**What:** Simulate the behavior of the `DisableFLTAuth` parameter being set to `true` by observing FLT's auth behavior before and after, and testing what happens at the boundary (toggle during in-flight requests).

**Why:** `DisableFLTAuth` is a **nuclear switch** — when true, ALL controllers use `NoAuthenticationAuthenticator` (via `ControllersConfig.cs:57–64`), AND both `RequiresPermissionFilter` and `MwcV2RequirePermissionsFilter` skip authorization (lines 53/44). This is used in TestOnebox environments. This probe verifies:
1. That toggling DisableFLTAuth is NOT hot-reloadable (it's read once at startup in `ControllersConfig`)
2. That even with DisableFLTAuth, the authorization *filters* check it per-request (they do — they resolve `IParametersProvider` and check on each call)
3. The inconsistency: authentication is startup-configured, but authorization is per-request — creating a window where authentication is enforced but authorization isn't (or vice versa)

**FLT Code Paths Affected:**
- `Initialization/ControllersConfig.cs:57–64` — `disableFltAuth` read once, used to select authenticator for each controller. NOT re-read on subsequent requests.
- `Authorization/RequiresPermissionFilter.cs:47–57` — `parametersProvider` is resolved in constructor (`WireUp.Resolve<IParametersProvider>()`), `GetHostParameter<bool>("DisableFLTAuth")` called per-request.
- `Authorization/MwcV2RequirePermissionsFilter.cs:38–48` — Same pattern: constructor-resolved provider, per-request check.
- `WorkloadParameters/ParametersManifest.json:163` — Default: `"DisableFLTAuth": false`
- `WorkloadParameters/Rollouts/TestOnebox.json:52` — Override: `"DisableFLTAuth": true`

**ChaosRule JSON:**

This is a **diagnostic rule** — it doesn't modify tokens but uses the feature flag chaos capability (from `EdogFeatureFlighterWrapper`) in combination with parameter monitoring.

```json
{
  "id": "sp-07-disable-auth-probe",
  "name": "DisableFLTAuth Toggle Probe",
  "description": "Sends requests with no auth headers to detect whether DisableFLTAuth is active. Reports finding if requests succeed.",
  "enabled": true,
  "priority": 90,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "url", "op": "matches", "value": ".*/workloadTypes/LiveTable/.*" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "remove",
        "name": "Authorization"
      }
    },
    {
      "type": "tagRequest",
      "config": {
        "tags": { "probe": "disable-auth-check", "expected": "401" }
      }
    }
  ],
  "safety": {
    "maxFirings": 3,
    "ttlSeconds": 30
  }
}
```

**C# Mechanism:**
```csharp
// Strip Authorization header entirely.
// If the response is 200, DisableFLTAuth is active (finding!).
// If the response is 401, auth is properly enforced (expected).
if (action.Type == "modifyRequestHeader" && action.Config.Operation == "remove")
{
    request.Headers.Remove(action.Config.Name);
}

// Post-response evaluation (in response phase):
if (response.IsSuccessStatusCode && request.Properties["probe"] == "disable-auth-check")
{
    PublishFinding(new SecurityFinding
    {
        Severity = "HIGH",
        Title = "DisableFLTAuth is ACTIVE",
        Detail = $"Request to {request.RequestUri} succeeded with no Authorization header",
        Recommendation = "Ensure DisableFLTAuth=false in production. This parameter disables ALL authentication."
    });
}
```

**Edge Cases:**
- The authentication vs authorization split: `ControllersConfig` may have selected the `NoAuthenticationAuthenticator` at startup, so stripping the header is redundant. But the *authorization filters* independently check `DisableFLTAuth` per-request — meaning even if we supply a valid auth header, the authz filters may skip permission validation.
- `DisableFLTAuth` is read from `IParametersProvider` which wraps the rollout parameter system. If EDOG could intercept `IParametersProvider.GetHostParameter<bool>("DisableFLTAuth")` and return false, it could "re-enable" auth at the authorization filter level even while authentication is still in NoAuth mode — creating an incoherent state.
- In TestOnebox, this probe always finds DisableFLTAuth=true. The value is in detecting it in non-onebox environments.

**Revert:** Disable rule. Authorization headers flow normally.

---

### SP-08: Workspace / Artifact Claim Mismatch

**What:** Modify the workspace ID or artifact ID claims in MWC tokens to mismatch the URL path, testing FLT's claim-vs-URL validation.

**Why:** This directly targets the **active validation** in `WorkloadMwcTokenV1Authenticator` (workspace + artifact check) and `WorkloadMwcTokenV2Authenticator` (workspace check only, artifact TODO). The V2 authenticator has a **known gap**: artifact ID validation is deferred (line 76: `"TODO Artifact id will be checked when the platform sends the artifact claims"`). This probe quantifies the blast radius of that gap.

**FLT Code Paths Affected:**
- `Authorization/WorkloadMwcTokenV1Authenticator.cs:64–85` — V1 validates both workspace AND artifact:
  - Line 67–74: `wlClaims.WorkspaceObjectId` vs `workspaceIdFromUrl`
  - Line 76–84: `wlClaims.Artifacts[].ArtifactObjectId` vs `artifactIdInUrl`
  - Both call `HandleInvalidMwcTokenClaim()` → `AuthenticationFailedException`
- `Authorization/WorkloadMwcTokenV2Authenticator.cs:62–74` — V2 validates workspace only:
  - Line 66–73: `PlatformClaims.WorkspaceObjectId` vs `workspaceIdFromUrl`
  - Line 76: **TODO** — artifact ID NOT validated
- `Authorization/WorkloadMwcTokenV2Authenticator.cs:49–59` — **Commented-out** workload type validation:
  - V2 does NOT validate that `PlatformClaims.WorkloadId == "LiveTable"` — any workload's MWC V2 token would pass

**ChaosRule JSON:**
```json
{
  "id": "sp-08-claim-mismatch",
  "name": "Workspace/Artifact Claim Mismatch",
  "description": "Replaces workspaceObjectId in MWC token claims with a different workspace, testing claim-vs-URL validation",
  "enabled": true,
  "priority": 100,
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "requestHeader", "key": "Authorization", "op": "contains", "value": "MwcToken " },
      { "field": "url", "op": "matches", "value": ".*/workspaces/[0-9a-f-]+/artifacts/.*" }
    ]
  },
  "actions": [
    {
      "type": "modifyRequestHeader",
      "config": {
        "operation": "set",
        "name": "Authorization",
        "value": null,
        "transform": "jwt_mutate",
        "jwtMutation": {
          "claims": {
            "workloadClaims.WorkspaceObjectId": {
              "op": "set",
              "value": "00000000-0000-0000-0000-000000000099"
            }
          }
        }
      }
    }
  ],
  "safety": {
    "maxFirings": 10,
    "ttlSeconds": 120
  }
}
```

**Sub-variants:**

| Variant | Claim Modified | Expected V1 Behavior | Expected V2 Behavior |
|---------|---------------|---------------------|---------------------|
| SP-08a | WorkspaceObjectId → wrong GUID | 401 (line 68–74) | 401 (line 66–73) |
| SP-08b | Artifacts[0].ArtifactObjectId → wrong GUID | 401 (line 76–84) | **200 — BUG** (artifact not validated in V2) |
| SP-08c | WorkloadType → "Lakehouse" | 401 (line 56–62) | **200 — BUG** (workload type check commented out, line 49–59) |
| SP-08d | Both workspace AND artifact → wrong | 401 | 401 (workspace caught first) |

**C# Mechanism:**

Same `MutateJwtClaims()` infrastructure. For V1, the workload claims are in a JSON string under the `workloadClaims` claim key. For V2, they're in `PlatformClaims` which is a structured object in the token's claims.

```csharp
// V1: Mutate workloadClaims JSON string
var wlClaims = JObject.Parse(payload["workloadClaims"].ToString());
wlClaims["WorkspaceObjectId"] = mutation.Value;
payload["workloadClaims"] = wlClaims.ToString(Formatting.None);

// V2: Mutate platformClaims (different claim key, different structure)
// PlatformClaims are handled by MwcTokenV2AadAuthenticator and extracted
// via IMwcTokenV2AuthenticationContext.PlatformClaims — the claim key is
// different from V1's "workloadClaims"
```

**Edge Cases:**
- **SP-08b is the critical finding**: V2 endpoints (Public API, MLV controller) do NOT validate artifact ID. An attacker with a valid MWC V2 token for workspace W, artifact A, could call an API targeting artifact B in the same workspace — and the authenticator would not reject it. The `RequiresPermissionFilter` might still catch it if artifact-level permissions are set, but many V2 endpoints use `MwcV2RequirePermissionsFilter` which depends on `PlatformClaims.Artifacts` matching — and if the platform doesn't send artifact claims (per the TODO), permissions validation may also be skipped.
- **SP-08c reveals commented-out code**: The V2 authenticator (line 49–59) has workload type validation COMMENTED OUT with a note about auto-population. This means a Lakehouse workload's MWC V2 token could authenticate against FLT's LiveTable API endpoints.
- The `WorkloadApiArtifactPathRegex` is the gatekeeper for which URLs trigger claim validation. URLs not matching this regex skip workspace/artifact checks entirely.

**Revert:** Disable rule. Token claims revert to original values.

---

## 5. Shared Infrastructure

### 5.1 JWT Mutation Engine

All SP-01 through SP-04, SP-06, SP-08 scenarios use a shared JWT mutation engine:

```csharp
/// <summary>
/// Mutates JWT token claims without re-signing.
/// Modified tokens have INVALID signatures — intentional for security probing.
/// </summary>
internal static class JwtMutationEngine
{
    /// <summary>
    /// Modifies claims in a JWT token string.
    /// Returns the modified token with original header, modified payload, original signature.
    /// </summary>
    public static string MutateClaims(string token, JwtMutationConfig config)
    {
        var parts = token.Split('.');
        if (parts.Length != 3) return token;

        var payload = JObject.Parse(Base64UrlDecode(parts[1]));

        foreach (var mutation in config.Claims)
        {
            ApplyMutation(payload, mutation.Key, mutation.Value);
        }

        parts[1] = Base64UrlEncode(payload.ToString(Formatting.None));
        return string.Join(".", parts);
    }

    private static void ApplyMutation(JObject payload, string path, ClaimMutation mutation)
    {
        // Supports dotted paths: "workloadClaims.WorkspaceObjectId"
        // Supports array indexing: "workloadClaims.Artifacts[0].Permissions"
        var segments = ParsePath(path);
        var target = NavigateToParent(payload, segments);

        switch (mutation.Op)
        {
            case "set":
                target[segments.Last().Name] = JToken.FromObject(mutation.Value);
                break;
            case "subtract":
                var current = target[segments.Last().Name]?.Value<long>() ?? 0;
                target[segments.Last().Name] = current - mutation.Seconds;
                break;
            case "remove":
                (target as JObject)?.Remove(segments.Last().Name);
                break;
        }
    }
}
```

### 5.2 Security Findings Collector

SP-05 and SP-07 produce **findings** — structured observations about security posture:

```csharp
public class SecurityFinding
{
    public string Severity { get; set; }    // "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"
    public string Title { get; set; }
    public string Detail { get; set; }
    public string Recommendation { get; set; }
    public string Endpoint { get; set; }
    public string RuleId { get; set; }
    public DateTime Timestamp { get; set; }
}
```

Findings are published to the `"chaos.security"` SignalR topic and displayed in a dedicated Security Findings panel within the Chaos UI.

### 5.3 Action Type Extensions

Security probing requires these action types beyond the base engine:

| Action Type | Config | Description |
|------------|--------|-------------|
| `jwt_mutate` | `{ "claims": { "path": { "op": "set|subtract|remove", "value": any } } }` | Modify JWT claims in Authorization header |
| `fuzz_cycle` | `{ "fuzzPatterns": string[] }` | Cycle through fuzz values per firing |
| `access_matrix_probe` | `{ "endpoints": [], "tokenTypes": [], "permissionLevels": [] }` | Automated endpoint probing |

These extend the base action types defined in `engine-design.md §4`.

---

## 6. Safety Constraints

### 6.1 C04-Specific Safety Rules

| Rule | Rationale |
|------|-----------|
| **Low default maxFirings** (3–10) | Auth mutations cause 401s that can cascade. Limit blast radius. |
| **Short TTL** (30–120s) | Security probes are point-in-time checks, not sustained chaos. |
| **Auto-disable on 500 cascade** | If 3+ consecutive requests return 500 (not 401), the rule auto-disables. 401 is expected; 500 means the auth mutation caused an unhandled exception — a finding itself. |
| **Exclude EDOG traffic** | Predicate `httpClientName != "EdogStudioClient"` prevents probing EDOG's own endpoints. |
| **No token exfiltration** | The JWT mutation engine NEVER logs or transmits raw token values. Only claim names and mutation operations are logged. Token bodies appear only in-memory during the mutation. |
| **Audit trail** | Every security probe firing is logged: rule ID, target URL, mutation type, response status code. This enables post-hoc security review. |

### 6.2 Interaction with Other Categories

| Interaction | Risk | Mitigation |
|-------------|------|------------|
| SP-02 (expired token) + TC-05 (429 storm) | FLT retries with expired token → 429 → retry → loop | maxFirings cap on both rules |
| SP-01 (token downgrade) + RS-05 (auth header strip) | Both modify Authorization header — last-writer-wins | Rule priority ordering; higher priority executes first |
| SP-04 (scope reduction) + RF-01 (status flip 401→200) | Scope reduction triggers 401, response forgery flips to 200 — hides the finding | Rules in different phases (request vs response) — document the interaction |

---

## 7. Implementation Priority

| Scenario | Priority | Rationale |
|----------|----------|-----------|
| SP-01: Token Downgrade | **P0** | Simple header mutation, high diagnostic value |
| SP-02: Token Expiry | **P0** | Tests critical refresh logic, simple JWT mutation |
| SP-08: Claim Mismatch | **P0** | Directly tests known V2 gaps (commented-out validation, missing artifact check) |
| SP-04: Scope Reduction | **P1** | Important but requires workload claims mutation infrastructure |
| SP-06: Auth Fuzzing | **P1** | Important for resilience, needs fuzz-cycle action type |
| SP-07: DisableFLTAuth Probe | **P1** | Diagnostic-only, valuable for environment verification |
| SP-03: Cross-Tenant | **P1** | Critical finding potential but needs careful safety controls |
| SP-05: Access Matrix | **P2** | Most complex (composite rule + UI), highest long-term value |

---

## 8. Known FLT Auth Gaps (Discovered During Research)

These are not bugs to fix — they're **known architectural decisions** documented here for transparency:

| # | Gap | Location | Severity | Status |
|---|-----|----------|----------|--------|
| 1 | V2 authenticator: workloadType validation COMMENTED OUT | `WorkloadMwcTokenV2Authenticator.cs:49–59` | Medium | Noted; comment says auto-populated as callee workload |
| 2 | V2 authenticator: artifact ID validation is TODO | `WorkloadMwcTokenV2Authenticator.cs:76` | High | Tracked: AB#2720953 |
| 3 | `DisableFLTAuth` split: authentication is startup-config, authorization is per-request | `ControllersConfig.cs:57` vs `RequiresPermissionFilter.cs:53` | Low | By design but creates incoherent intermediate states |
| 4 | `TokenManager.UpdateCachedToken()` logs different-user update but doesn't block it | `TokenManager.cs:150–155` | Medium | Security comment in code: "just log" |
| 5 | `RequiresPermissionFilter` catches all `Exception` in header parsing (line 139) | `RequiresPermissionFilter.cs:139` | Low | Returns false, which triggers 401 — safe but noisy |
| 6 | `UserMwcAndS2STokenAuthenticator` header swap trick is fragile | `UserMwcAndS2STokenAuthenticator.cs:85–96` | Medium | TODO in code: replace with platform-provided custom header authenticator (AB#3749199) |

---

## 9. Dependencies

| Dependency | Required For | Provided By |
|-----------|-------------|-------------|
| JWT mutation engine (`JwtMutationEngine`) | SP-01, SP-02, SP-03, SP-04, SP-08 | New C# class in `src/backend/DevMode/Chaos/` |
| Fuzz cycle action type | SP-06 | Extension to `ChaosRuleEngine` action system |
| Access matrix probe | SP-05 | New composite rule type + EDOG API proxy integration |
| Security findings collector | SP-05, SP-07 | New SignalR topic + UI panel |
| `modifyRequestHeader` action | All scenarios | Base engine (from `engine-design.md`) |
| `tagRequest` action | SP-05, SP-07 | Base engine (from `engine-design.md`) |
