# C02: Response Forgery — Deep Spec

> **Author:** Sana Reeves (Architect)
> **Status:** COMPLETE
> **Date:** 2025-07-22
> **Depends On:** `interceptor-audit.md` (P0.1+P0.2), `engine-design.md` (P0.3+P2)
> **Category:** Response Forgery — modifying what FLT receives from external services before FLT's code processes it

---

## 1. Category Purpose

Response Forgery intercepts HTTP responses **after** the real service has replied (or **instead of** calling the real service) and mutates the response before FLT's code deserializes it. The goal: exercise every failure mode in FLT's response-handling code — deserialization, null handling, type checking, error branching, retry logic, and recovery paths — without needing a broken external service.

### Why This Is Critical

FLT's response handling is the **most vulnerable surface** we have. The audit reveals:

| Vulnerability | Where | Severity |
|---|---|---|
| `dynamic` deserialization without schema validation | `FabricApiClient` lines 130, 181, 191, 364, 413 | **HIGH** — `NullReferenceException` on missing fields |
| No null/empty body check before `JsonConvert.DeserializeObject` | `FabricApiClient` lines 181, 191, 364, 413 | **HIGH** — unhandled `JsonException` |
| `[Required]` attributes on Spark models that Newtonsoft may allow null | `TransformExecutionSubmitResponse.ComputeInfo`, `TransformExecutionResponse.State` | **MEDIUM** — partial object returned |
| Status code branching has gaps (e.g., 408, 409 not handled) | `FabricApiClient`, `OneLakeRestClient` | **MEDIUM** — falls to generic handler |
| Polling logic trusts `operationResult.status` from dynamic deserialize | `FabricApiClient.HandleLongRunningOperationAsync` line 183 | **HIGH** — forgeable loop/crash |

Every RF scenario below targets a real, audited code path.

### Mechanism Overview

All response-phase actions execute in `EdogHttpPipelineHandler.SendAsync()` **after** `base.SendAsync()` returns:

```
FLT code → EdogHttpPipelineHandler.SendAsync()
  → base.SendAsync() → real service responds
  → ChaosRuleEngine.EvaluateResponse(response)  ← RF rules fire here
  → mutated response returned to FLT code
```

The `forgeResponse` action skips `base.SendAsync()` entirely — it fires in the **request phase** as a short-circuit, returning a fabricated response without contacting the real service.

### Interceptor Coverage

| FLT Call Path | Intercepted? | Named Client | RF Applicable? |
|---|---|---|---|
| OneLake REST (ListDirs) | **Yes** | `OneLakeRestClient` | ✅ |
| OneLake FileSystem (13 methods) | **Yes** | `DatalakeDirectoryClient` | ✅ |
| Fabric API (Lakehouse, Workspace, LRO) | **Yes** | `PbiSharedApiClient` | ✅ |
| Spark/GTS (Submit, Status, Cancel) | **No** — GAP-1 | WCL SDK | ❌ (needs `SendHttpRequestAsync` override) |
| Notebook (Content fetch) | **No** — GAP-2 | WCL SDK | ❌ |
| Orchestrator (Communication) | **No** — GAP-3 | WCL SDK | ❌ |

**Scope:** RF-01 through RF-10 target **intercepted** traffic only. Spark/Notebook/Orchestrator response forgery requires GAP-1/2/3 resolution (separate spec).

---

## 2. Scenarios

---

### RF-01: Status Code Flip

**One-liner:** Rewrite the HTTP status code returned to FLT, turning successes into failures or vice versa.

**Description:**
FLT branches on status codes before attempting deserialization. `FabricApiClient.GetLakehouseDetailsAsync` checks for 401, 404, 400, 500 in sequence (lines 63–86), then falls through to `EnsureSuccessStatusCode()`. `OneLakeRestClient.ListDirsAsync` uses a switch expression (lines 328–353) mapping codes to specific exception types. `GTSBasedSparkClient` branches on 200/202, 429/430, and ≥500 (lines 439–487).

Flipping the status code exercises:
- **200→500**: Does FLT log the error body? Or does it try to deserialize a success-shaped body as an error?
- **500→200**: Does FLT try to deserialize an error body as a success type? `JsonConvert.DeserializeObject<LakehouseDetails>` on `{"error":"Internal Server Error"}` returns a `LakehouseDetails` with all-null properties.
- **200→429**: Does FLT's retry logic kick in? `OneLakeRestClient` throws `InvalidOperationException("rate limit exceeded")`. `GTSBasedSparkClient` sets `Retriable = true` with `MLV_TOO_MANY_REQUESTS`.
- **200→401**: Forces auth-failure paths. `FabricApiClient` throws `UnauthorizedAccessException`. `OneLakeRestClient` also throws `UnauthorizedAccessException`.

**ChaosRule JSON:**
```json
{
  "id": "rf01-status-flip-onelake-500",
  "name": "OneLake 200→500",
  "description": "Flip OneLake success responses to 500 to test FLT error handling when OneLake appears to fail",
  "category": "response-forgery",
  "tags": ["onelake", "error-handling", "status-code"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 10, "ttlSeconds": 300 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "statusCode", "op": "equals", "value": 200 }
    ]
  },
  "action": {
    "type": "modifyResponseStatus",
    "config": { "statusCode": 500 }
  }
}
```

**C# Mechanism:**
```csharp
// In ActionExecutor.ExecuteResponse():
case "modifyResponseStatus":
    var newCode = (HttpStatusCode)config.StatusCode;
    response.StatusCode = newCode;
    response.ReasonPhrase = newCode.ToString();
    // Note: Body is NOT modified — FLT receives the original success body
    // with a 500 status code. This is the interesting test case.
    break;
```

`HttpResponseMessage.StatusCode` is a settable property. No need to clone the response. The original response body, headers, and content remain unchanged — only the status code is overwritten.

**FLT Code Paths Affected:**

| File | Line(s) | What Happens |
|---|---|---|
| `FabricApiClient.cs` | 63–88 | 200→500: Hits `InternalServerError` branch (line 82), throws `InvalidOperationException("Internal server error: {body}")` with the *success* body as error text |
| `FabricApiClient.cs` | 63–88 | 500→200: Skips all error branches, hits `EnsureSuccessStatusCode()` (line 88) which passes, then deserializes error body as `LakehouseDetails` — returns partial/null object |
| `OneLakeRestClient.cs` | 287, 328–353 | 200→500: `!response.IsSuccessStatusCode` is true, enters switch, throws `InvalidOperationException("internal error: {success_body}")` |
| `OneLakeRestClient.cs` | 153–167 | 500→200: Bypasses error check, attempts `JsonConvert.DeserializeObject<PathList>()` on error body — `JsonException` caught at line 156 |
| `FabricApiClient.cs` | 206–215 | 200→429 in LRO polling: Hits intermittent-error branch (line 206), retries after 5 seconds — **infinite retry if every response is flipped** |

**Edge Cases:**
- **200→429 on polling endpoints**: `HandleLongRunningOperationAsync` retries 502/503/429 indefinitely until the 300-second timeout. If all polling responses are flipped, FLT burns 5 minutes then throws `TimeoutException`.
- **Body mismatch**: Flipping status without modifying body creates an inconsistent response. FLT code paths that deserialize based on status may throw unexpected exceptions.
- **Content-Type header preserved**: The body still claims `application/json` even if the status code says error. Some FLT code reads the body regardless of status.

**Rule Interactions:**
- **Conflicts with RF-03 (Full Response Forge):** If both match the same request, `forgeResponse` short-circuits in request phase before `modifyResponseStatus` runs. No conflict — RF-03 wins.
- **Stacks with RF-02 (Body Mutation):** Status flip + body mutation together = FLT receives a 500 with mutated success body. Valid combination.

**Revert:** Disable the rule. Next response returns with original status code. No persistent side effects — status code is only modified in the in-flight response object.

**Priority:** **P0** — Fundamental building block. Required for every other response-phase scenario.

---

### RF-02: Body Field Mutation

**One-liner:** Modify specific JSON fields in the response body via find-replace or regex substitution before FLT deserializes.

**Description:**
This scenario mutates individual fields inside the response JSON without replacing the entire body. It targets FLT's field-level assumptions: "this field is always a positive integer," "this array always has elements," "this GUID is always valid."

Key targets identified from the deserialization audit:

| Field | Where | Current Assumption | Mutation |
|---|---|---|---|
| `PathList.Paths` (array) | `OneLakeRestClient` line 158 | Array of `PathObject` | Set to `[]` or `null` |
| `PathObject.Name` (string) | `OneLakeRestClient` line 167 | Non-null filename | Set to `""` or extremely long string |
| `LakehouseDetails.Properties` (object) | `FabricApiClient` line 95 | Has `OneLakeTablesPath` | Set nested fields to `null` |
| `operationResult.status` (dynamic) | `FabricApiClient` line 183 | `"Succeeded"` or `"Failed"` | Set to `"Unknown"` or `""` — polling loops forever |
| `result.id` (dynamic) | `FabricApiClient` line 193 | Valid GUID | Set to `"not-a-guid"` — `Guid.Parse` throws |
| `TransformExecutionSubmitResponse.ComputeInfo` | `GTSBasedSparkClient` line 444 | Not null (checked line 445) | Currently GAP-1 — document for future |

**ChaosRule JSON:**
```json
{
  "id": "rf02-mutate-pathlist-empty",
  "name": "OneLake Empty PathList",
  "description": "Mutate OneLake directory listing to return empty Paths array — tests empty-state handling in workspace explorer",
  "category": "response-forgery",
  "tags": ["onelake", "deserialization", "empty-state"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 5, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "contains", "value": "resource=filesystem" }
    ]
  },
  "action": {
    "type": "modifyResponseBody",
    "config": {
      "find": "\"paths\":\\s*\\[.*?\\]",
      "replace": "\"paths\":[]",
      "regex": true
    }
  }
}
```

**C# Mechanism:**
```csharp
// In ActionExecutor.ExecuteResponse():
case "modifyResponseBody":
    var bodyStr = await response.Content.ReadAsStringAsync();
    string modified;
    if (config.Regex)
    {
        // Compiled regex cached per rule ID
        var rx = RegexCache.GetOrCompile(rule.Id, config.Find, RegexOptions.Singleline);
        modified = rx.Replace(bodyStr, config.Replace);
    }
    else
    {
        modified = bodyStr.Replace(config.Find, config.Replace);
    }
    // Replace response content, preserving Content-Type and encoding
    response.Content = new StringContent(modified,
        response.Content.Headers.ContentType?.CharSet != null
            ? Encoding.GetEncoding(response.Content.Headers.ContentType.CharSet)
            : Encoding.UTF8,
        response.Content.Headers.ContentType?.MediaType ?? "application/json");
    break;
```

**Important:** `ReadAsStringAsync()` consumes the response stream. The replacement creates a new `StringContent`. The original `Content-Type` and charset are preserved. `Content-Length` is automatically recalculated by `StringContent`.

**FLT Code Paths Affected:**

| Mutation | File | Line(s) | What Happens |
|---|---|---|---|
| `"paths":[]` | `OneLakeRestClient.cs` | 167 | `pathList?.Paths` is empty array — `Paths != null` but `.Length == 0`. Loop at line 169 iterates zero times. Returns empty list. **Safe — but workspace explorer shows empty.** |
| `"paths":null` | `OneLakeRestClient.cs` | 167 | `pathList?.Paths` is `null`. Null check at line 169 (`if (paths != null)`) skips loop. Returns empty list. **Safe.** |
| `"status":"Unknown"` in LRO | `FabricApiClient.cs` | 183–197 | `operationResult.status` is `"Unknown"`. Not `"Succeeded"`, not `"Failed"`. Falls through to retry delay. **Loops until timeout (300s).** |
| `"id":"not-a-guid"` in LRO result | `FabricApiClient.cs` | 193 | `result.id` returns `"not-a-guid"`. Line 193 returns this as `dynamic` — but caller expects `Guid`. **Implicit conversion fails → `RuntimeBinderException`.** |
| `"displayName":null` | `FabricApiClient.cs` | 131 | `workspaceResponse.displayName` is null. Returned directly. Caller receives null workspace name. **Silent null propagation.** |

**Edge Cases:**
- **Regex greedy matching**: The `"paths":\s*\[.*?\]` pattern uses non-greedy `*?` but with `Singleline` mode. Nested arrays inside `PathObject` could cause over-matching. Use `"paths":\s*\[[^\]]*\]` for safety.
- **Binary response bodies**: Regex on binary content (Parquet files via `DatalakeDirectoryClient`) produces garbage. Predicate should filter by `Content-Type: application/json`.
- **Multi-byte encoding**: If response is UTF-16 (rare but possible from some Azure APIs), `ReadAsStringAsync()` handles it, but `StringContent` defaults to UTF-8 unless we preserve the original charset.
- **Empty body**: If `ReadAsStringAsync()` returns `""`, regex returns `""`. `StringContent("")` creates a valid empty response.

**Rule Interactions:**
- **After RF-01 (Status Flip):** Body mutation happens regardless of status code. Mutating body + flipping status = double corruption. Engine evaluates rules in priority order — both fire if both match.
- **Multiple RF-02 rules:** Multiple body mutations stack. Rule A changes `"paths"`, Rule B changes `"Name"`. Both apply in priority order. **Risk:** Rule B's regex may not match if Rule A already changed the body.

**Revert:** Disable the rule. Next response returns with unmodified body.

**Priority:** **P0** — Core mutation primitive used by testers to explore field-level assumptions.

---

### RF-03: Full Response Forge

**One-liner:** Return a completely fabricated response without contacting the real service — FLT receives whatever JSON/status/headers we provide.

**Description:**
This is the nuclear option. Instead of mutating a real response, the engine short-circuits `base.SendAsync()` entirely and returns a synthetic `HttpResponseMessage`. The real service is never contacted.

Use cases:
- **Offline development**: Return canned lakehouse metadata when OneLake is unavailable
- **Error simulation**: Return exact error payloads that are hard to reproduce (e.g., a specific `ErrorCode` from Spark)
- **Schema testing**: Return JSON with extra fields, missing fields, or wrong types to test FLT's deserialization robustness

**ChaosRule JSON:**
```json
{
  "id": "rf03-forge-lakehouse-details",
  "name": "Forge Lakehouse Details",
  "description": "Return fabricated LakehouseDetails response to test FLT deserialization with controlled payload",
  "category": "response-forgery",
  "tags": ["fabric-api", "lakehouse", "offline", "deserialization"],
  "phase": "request",
  "priority": 50,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 20, "ttlSeconds": 600 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "matches", "value": ".*/v1/workspaces/.*/lakehouses/.*" }
    ]
  },
  "action": {
    "type": "forgeResponse",
    "config": {
      "statusCode": 200,
      "contentType": "application/json",
      "headers": {
        "x-ms-request-id": "edog-forged-00000000-0000-0000-0000-000000000000"
      },
      "body": "{\"id\":\"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\",\"displayName\":\"Forged Lakehouse\",\"description\":\"EDOG chaos-forged response\",\"type\":\"Lakehouse\",\"workspaceId\":\"11111111-2222-3333-4444-555555555555\",\"properties\":{\"oneLakeTablesPath\":\"https://onelake.dfs.fabric.microsoft.com/ws/lh/Tables\",\"oneLakeFilesPath\":\"https://onelake.dfs.fabric.microsoft.com/ws/lh/Files\",\"sqlEndpointProperties\":{\"connectionString\":\"forged-connection\",\"id\":\"sql-ep-id\",\"provisioningStatus\":\"Success\"},\"defaultSchema\":\"dbo\"}}"
    }
  }
}
```

**C# Mechanism:**
```csharp
// In ActionExecutor.ExecuteRequest() — fires BEFORE base.SendAsync():
case "forgeResponse":
    var forged = new HttpResponseMessage((HttpStatusCode)config.StatusCode)
    {
        Content = new StringContent(
            config.Body ?? "",
            Encoding.UTF8,
            config.ContentType ?? "application/json"),
        RequestMessage = request, // Link back to original request for diagnostics
    };
    forged.ReasonPhrase = ((HttpStatusCode)config.StatusCode).ToString();

    // Apply custom headers
    if (config.Headers != null)
    {
        foreach (var (key, val) in config.Headers)
            forged.Headers.TryAddWithoutValidation(key, val);
    }

    // Mark as forged for traffic monitor
    forged.Headers.TryAddWithoutValidation("X-Edog-Forged", "true");

    return ActionResult.ShortCircuit(forged);
    // base.SendAsync() is NEVER called
```

**Key implementation detail:** `forgeResponse` is classified as a **request-phase** action with `ShortCircuit = true`. When the engine encounters a short-circuit result, it skips `base.SendAsync()` and jumps directly to the response-phase evaluation. This means response-phase rules (RF-01, RF-02) can **still** modify the forged response.

**FLT Code Paths Affected:**

| Forged Response | File | Line(s) | What Happens |
|---|---|---|---|
| Valid `LakehouseDetails` JSON | `FabricApiClient.cs` | 89–95 | `ReadAsStringAsync()` returns forged body. `JsonConvert.DeserializeObject<LakehouseDetails>()` succeeds. FLT continues as if real. |
| `LakehouseDetails` with `properties: null` | `FabricApiClient.cs` | 95 | Deserialization succeeds. `Properties` is null. Any code accessing `Properties.OneLakeTablesPath` → `NullReferenceException`. |
| `PathList` with 10,000 paths | `OneLakeRestClient.cs` | 158–193 | Deserialization succeeds. Loop iterates 10K times. Tests pagination logic and UI rendering performance. |
| Empty JSON `{}` | `FabricApiClient.cs` | 95 | `LakehouseDetails` deserialized with all-null properties. `Id` is null, `DisplayName` is null. Silent failure propagation. |
| Valid JSON, wrong schema | `FabricApiClient.cs` | 95 | Extra fields ignored (Newtonsoft default). Missing fields become null/default. No exception. |

**Edge Cases:**
- **Content-Length mismatch**: `StringContent` auto-calculates `Content-Length`. No risk.
- **Missing RequestMessage**: If `request` is null (shouldn't happen in pipeline), `forged.RequestMessage = null` is safe — FLT code doesn't typically access `response.RequestMessage`.
- **X-Edog-Forged header**: Added for diagnostics. If FLT code reads this header, it would see `"true"`. Low risk — FLT has no known check for this header.
- **Auth header on forged response**: The original request's auth headers are preserved in `request`. If FLT reads auth metadata from the response (unusual), it gets nothing — forged responses have no auth headers unless explicitly added.
- **Double forge**: If two `forgeResponse` rules match the same request (different priorities), the first one (lower priority number) short-circuits. The second rule's predicate evaluates against the forged response in the response phase — if it matches, it could **re-forge** the response.

**Rule Interactions:**
- **Pre-empts all response-phase rules for the same request**: Since `forgeResponse` short-circuits `base.SendAsync()`, no real response exists. However, response-phase rules still evaluate against the forged response.
- **Overrides RF-01, RF-02**: Those rules modify the real response. If `forgeResponse` fires first (lower priority), they modify the forged body/status instead.
- **Compatible with C01 (Request Surgery)**: Request-phase rules that modify the request URL/headers fire before `forgeResponse`. If `forgeResponse` matches the *modified* URL, it still works.

**Revert:** Disable the rule. Next matching request goes to the real service.

**Priority:** **P0** — The most powerful chaos capability. Enables offline development and arbitrary failure simulation.

---

### RF-04: Schema Surprise

**One-liner:** Add unexpected fields, remove expected fields, or change field types to test FLT's deserialization robustness.

**Description:**
External service APIs evolve. A new field appears in the response. A field changes from `string` to `int`. A required field disappears. FLT must handle all of these gracefully. This scenario deliberately breaks the implicit contract between FLT and the external service.

Three sub-modes:
1. **Field injection**: Add fields that don't exist in FLT's DTO (e.g., `"newField": "surprise"`)
2. **Field removal**: Remove fields FLT expects (e.g., strip `"id"` from `LakehouseDetails`)
3. **Type mutation**: Change field types (e.g., `"id": "guid-string"` → `"id": 42`)

**ChaosRule JSON (Field Removal):**
```json
{
  "id": "rf04-remove-id-field",
  "name": "Strip ID from Lakehouse Response",
  "description": "Remove the 'id' field from Fabric API lakehouse response — tests FLT behavior when required fields are missing",
  "category": "response-forgery",
  "tags": ["fabric-api", "schema", "missing-field", "deserialization"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 5, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "url", "op": "matches", "value": ".*/v1/workspaces/.*/lakehouses/.*" },
      { "field": "statusCode", "op": "equals", "value": 200 }
    ]
  },
  "action": {
    "type": "modifyResponseBody",
    "config": {
      "find": "\"id\":\\s*\"[^\"]*\",?",
      "replace": "",
      "regex": true
    }
  }
}
```

**ChaosRule JSON (Type Mutation):**
```json
{
  "id": "rf04-type-mutate-id-to-int",
  "name": "Change ID Type to Integer",
  "description": "Replace GUID string 'id' with integer — tests type mismatch handling",
  "category": "response-forgery",
  "tags": ["fabric-api", "schema", "type-mismatch"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 5, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "url", "op": "matches", "value": ".*/v1/workspaces/.*/lakehouses/.*" },
      { "field": "statusCode", "op": "equals", "value": 200 }
    ]
  },
  "action": {
    "type": "modifyResponseBody",
    "config": {
      "find": "\"id\":\\s*\"[a-f0-9-]+\"",
      "replace": "\"id\": 99999",
      "regex": true
    }
  }
}
```

**C# Mechanism:** Uses `modifyResponseBody` with regex — same mechanism as RF-02. No new action type needed.

**FLT Code Paths Affected:**

| Mutation | File | Line(s) | What Happens |
|---|---|---|---|
| **Remove `id` field** from LakehouseDetails | `FabricApiClient.cs` | 95 | `LakehouseDetails.Id` is `null` (default for `string` with `init` setter). Callers using `details.Id` receive null. **Silent failure.** |
| **Remove `id` field** from LRO result | `FabricApiClient.cs` | 193 | `result.id` on dynamic returns `null`. `return result.id` returns null to caller expecting `Guid`. **`RuntimeBinderException` or null Guid at caller.** |
| **Remove `state` field** from TransformExecutionResponse | N/A (GAP-1) | N/A | `[Required]` attribute + `[JsonConverter(typeof(StringEnumConverter))]`. Newtonsoft.Json deserializes `State` to default `TransformationState.Unknown` (enum default = 0). **No exception — silent wrong state.** |
| **`"id": 42`** (int instead of string) | `FabricApiClient.cs` | 95 | `LakehouseDetails.Id` is `string`. Newtonsoft.Json auto-coerces int 42 → string `"42"`. **No exception — but ID is wrong type.** |
| **`"id": 42`** (int instead of Guid, typed model) | `TransformExecutionResponse` | N/A | `Guid Id { get; init; }` — Newtonsoft.Json throws `JsonSerializationException`: cannot convert int to Guid. **Caught by try/catch.** |
| **Add `"unexpectedField": "value"`** | Any typed model | Any | Newtonsoft.Json **ignores** unknown properties by default (`MissingMemberHandling.Ignore`). **No exception.** Extra fields silently dropped. |
| **Remove `paths` field** from PathList | `OneLakeRestClient.cs` | 158 | `PathList.Paths` is `null` (not `[]`). Line 167: `pathList?.Paths` returns null. Line 169: `if (paths != null)` skips loop. **Returns empty list.** |

**Edge Cases:**
- **Regex stripping leaves invalid JSON**: Removing `"id":"...",` might leave a trailing comma before `}` → `{"displayName":"x",}`. **Invalid JSON.** Newtonsoft.Json throws `JsonReaderException`. The regex should handle the trailing comma: `"id":\s*"[^"]*",?` with the optional `,`.
- **Removing the only field**: If the response is `{"id":"abc"}` and we strip `id`, we get `{}`. Deserialization succeeds — all properties null/default.
- **Nested field removal**: Regex `"id":\s*"[^"]*"` matches the first `id` in the JSON. If the response has nested objects with `id` fields, the wrong one might be stripped. Use JSONPath-based mutation for precision (future enhancement — see C06 Advanced).

**Rule Interactions:**
- **Multiple RF-04 rules**: Can combine field removal + type mutation + field injection. Each applies its regex in priority order. Ensure regexes don't conflict.
- **After RF-01**: Status flip + schema surprise = FLT receives 200 with broken schema. Both fire.

**Revert:** Disable rules. No persistent effects.

**Priority:** **P0** — Directly tests the vulnerabilities identified in the deserialization audit.

---

### RF-05: Pagination Loop

**One-liner:** Modify the `nextLink` / continuation token in paginated responses to create infinite loops, skip pages, or jump to invalid pages.

**Description:**
FLT uses pagination for OneLake directory listings (`OneLakeRestClient.ListDirsAsync`) and Fabric API long-running operations (`HandleLongRunningOperationAsync` polls until `status == "Succeeded"`). Manipulating pagination tokens tests:

- **Infinite loop**: Set `nextLink` back to page 1
- **Missing continuation**: Remove `nextLink` to truncate results
- **Invalid continuation**: Set `nextLink` to a malformed URL

OneLake pagination: The `continuation` header is sent by OneLake if more results exist. `OneLakeRestClient` checks for this header (line ~180) and re-requests with the continuation token. If we forge the continuation header to point to the original URL, FLT loops forever.

Fabric LRO polling: `HandleLongRunningOperationAsync` polls until `operationResult.status == "Succeeded"`. If we mutate the status to always be `"Running"`, FLT polls until the 300-second timeout.

**ChaosRule JSON (LRO Infinite Poll):**
```json
{
  "id": "rf05-lro-infinite-poll",
  "name": "LRO Never Completes",
  "description": "Mutate Fabric LRO status to 'Running' — FLT polls until timeout to test timeout handling",
  "category": "response-forgery",
  "tags": ["fabric-api", "lro", "pagination", "timeout"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 100, "ttlSeconds": 600 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "statusCode", "op": "equals", "value": 200 },
      { "field": "responseBody", "op": "contains", "value": "\"status\":" }
    ]
  },
  "action": {
    "type": "modifyResponseBody",
    "config": {
      "find": "\"status\":\\s*\"Succeeded\"",
      "replace": "\"status\":\"Running\"",
      "regex": true
    }
  }
}
```

**ChaosRule JSON (OneLake Continuation Loop):**
```json
{
  "id": "rf05-onelake-continuation-loop",
  "name": "OneLake Infinite Pagination",
  "description": "Inject continuation header on every OneLake listing response — tests pagination termination",
  "category": "response-forgery",
  "tags": ["onelake", "pagination", "infinite-loop"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 50, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "contains", "value": "resource=filesystem" }
    ]
  },
  "action": {
    "type": "modifyResponseHeader",
    "config": {
      "operation": "set",
      "name": "x-ms-continuation",
      "value": "forged-continuation-token-loop"
    }
  }
}
```

**C# Mechanism:** LRO polling uses `modifyResponseBody` (same as RF-02). Continuation loop uses `modifyResponseHeader`:

```csharp
case "modifyResponseHeader":
    switch (config.Operation)
    {
        case "set":
            response.Headers.Remove(config.Name);
            response.Headers.TryAddWithoutValidation(config.Name, config.Value);
            break;
        case "add":
            response.Headers.TryAddWithoutValidation(config.Name, config.Value);
            break;
        case "remove":
            response.Headers.Remove(config.Name);
            break;
    }
    break;
```

**FLT Code Paths Affected:**

| Mutation | File | Line(s) | What Happens |
|---|---|---|---|
| LRO `"status":"Running"` forever | `FabricApiClient.cs` | 183–197 | `operationResult.status` is never `"Succeeded"` or `"Failed"`. Falls to retry delay (Retry-After or 10s default). Loops until 300s timeout → `TimeoutException`. |
| LRO `"status":""` (empty string) | `FabricApiClient.cs` | 183 | Not `"Succeeded"`, not `"Failed"`. Same as above — loops until timeout. |
| OneLake forged continuation header | `OneLakeRestClient.cs` | ~180 | FLT sees continuation header, makes another request with the forged token. OneLake returns results (or error) for the invalid token. **If OneLake returns another valid page, FLT processes duplicate data.** |

**Edge Cases:**
- **maxFirings as loop breaker**: Set `maxFirings: 50` to allow 50 continuation-header injections. After 50, the rule auto-disables and OneLake's real response (without continuation) terminates pagination.
- **OneLake rejecting forged continuation**: OneLake may return 400 for an invalid token. `OneLakeRestClient` handles 400 as `ArgumentException`. The pagination loop breaks.
- **Memory growth**: Infinite pagination accumulates results in memory. 50 pages × 1000 paths = 50K `PathObject` instances. Not a crash, but tests memory pressure.

**Rule Interactions:**
- **RF-05 + RF-06 (Empty Body)**: Forging continuation + empty body = FLT requests next page, gets empty body, throws `JsonException`. Loop breaks on error.

**Revert:** Disable rule. Next request/response uses real continuation behavior.

**Priority:** **P1** — Important for testing timeout and pagination robustness, but less fundamental than status/body mutation.

---

### RF-06: Empty Body

**One-liner:** Return a 200 OK with an empty body, `null`, or just whitespace — testing FLT's null-handling before deserialization.

**Description:**
This is the single most revealing chaos test. The deserialization audit shows that `FabricApiClient` has **no null/empty body check** before `JsonConvert.DeserializeObject` at lines 181, 191, 364, and 413. A 200 OK with an empty body bypasses all status-code error branches and goes straight to deserialization — where it crashes.

**ChaosRule JSON:**
```json
{
  "id": "rf06-empty-body-fabric-api",
  "name": "Fabric API Empty Body",
  "description": "Return 200 OK with empty body for Fabric API calls — exposes missing null-body validation in FabricApiClient",
  "category": "response-forgery",
  "tags": ["fabric-api", "null-handling", "deserialization", "empty-body"],
  "phase": "request",
  "priority": 50,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 5, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "action": {
    "type": "forgeResponse",
    "config": {
      "statusCode": 200,
      "contentType": "application/json",
      "headers": {},
      "body": ""
    }
  }
}
```

**ChaosRule JSON (Null JSON):**
```json
{
  "id": "rf06-null-json-body",
  "name": "Fabric API Null JSON Body",
  "description": "Return 200 OK with literal 'null' JSON — tests JsonConvert.DeserializeObject on null token",
  "category": "response-forgery",
  "tags": ["fabric-api", "null-handling", "deserialization"],
  "phase": "request",
  "priority": 50,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 5, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "GET" }
    ]
  },
  "action": {
    "type": "forgeResponse",
    "config": {
      "statusCode": 200,
      "contentType": "application/json",
      "headers": {},
      "body": "null"
    }
  }
}
```

**C# Mechanism:** Uses `forgeResponse` (same as RF-03) with empty or `"null"` body.

**FLT Code Paths Affected:**

| Body Content | File | Line(s) | What Happens |
|---|---|---|---|
| `""` (empty string) | `FabricApiClient.cs` | 95 | `ReadAsStringAsync()` returns `""`. `JsonConvert.DeserializeObject<LakehouseDetails>("")` → `null`. If caller doesn't null-check, **`NullReferenceException`**. |
| `""` (empty string) | `FabricApiClient.cs` | 130 | `JsonConvert.DeserializeObject("")` → `null`. `workspaceResponse.displayName` → **`NullReferenceException` on dynamic null.** |
| `""` (empty string) | `FabricApiClient.cs` | 181 | `JsonConvert.DeserializeObject("")` → `null`. `operationResult.status == "Succeeded"` → **`NullReferenceException` on dynamic null.** |
| `"null"` (JSON null literal) | `FabricApiClient.cs` | 95 | `JsonConvert.DeserializeObject<LakehouseDetails>("null")` → `null`. Same as empty. |
| `"null"` (JSON null literal) | `FabricApiClient.cs` | 130 | `JsonConvert.DeserializeObject("null")` → `null` as `dynamic`. `.displayName` → **`RuntimeBinderException`: 'Cannot perform runtime binding on a null reference'.** |
| `""` (empty string) | `OneLakeRestClient.cs` | 158 | `JsonConvert.DeserializeObject<PathList>("")` → `null`. Line 167: `pathList?.Paths` → `null` (null-conditional on null). **Safe — returns empty list.** |
| `" "` (whitespace) | `FabricApiClient.cs` | 95 | `JsonConvert.DeserializeObject<LakehouseDetails>(" ")` → `null`. Same as empty string. |
| `"{}"` (empty object) | `FabricApiClient.cs` | 95 | `LakehouseDetails` with all-null properties. Deserialization **succeeds**. All fields null. **Silent failure.** |

**Edge Cases:**
- **Content-Length: 0 vs empty StringContent**: `new StringContent("")` sets `Content-Length: 0`. `ReadAsStringAsync()` returns `""`. Some HTTP libraries might set `Content` to `null` for empty responses — but `StringContent` always creates a non-null stream.
- **Whitespace-only body**: `"   \n\t  "` — `JsonConvert.DeserializeObject` returns `null` for whitespace. Same as empty.
- **`"undefined"`**: Not valid JSON. `JsonException` thrown. If caller has try/catch, it handles it. If not (FabricApiClient lines 181, 191), **unhandled exception propagates**.

**Rule Interactions:**
- **RF-06 vs RF-02**: Empty body + body mutation = mutation regex finds nothing to match. Body stays empty.
- **RF-06 vs RF-01**: Empty body + status flip = empty body with wrong status code. Status-code branches fire first, may throw before deserialization is attempted.

**Revert:** Disable rule. Next request gets real response.

**Priority:** **P0** — Directly exposes the highest-severity vulnerabilities found in the deserialization audit.

---

### RF-07: Truncated Response

**One-liner:** Return only the first N bytes of the response body, then complete the HTTP response normally — producing invalid JSON that breaks deserialization.

**Description:**
Unlike a real network truncation (which would cause a `TaskCanceledException` or `IOException`), this scenario returns a **complete HTTP response** with a truncated body. The `Content-Length` header matches the truncated length, and the HTTP transaction completes successfully. FLT sees status 200, sees `Content-Type: application/json`, reads the body — and gets `{"id":"aaaa-bb` (cut mid-field).

This is different from RF-06 (Empty Body) because the body is non-empty and starts with valid JSON structure but is incomplete. The `JsonConvert.DeserializeObject` call throws `JsonReaderException` (a subclass of `JsonException`) with "Unexpected end of content."

**ChaosRule JSON:**
```json
{
  "id": "rf07-truncate-onelake-listing",
  "name": "Truncated OneLake Listing",
  "description": "Return first 128 bytes of OneLake directory listing — tests JSON parse error handling",
  "category": "response-forgery",
  "tags": ["onelake", "truncation", "json-error", "deserialization"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 0.3,
  "limits": { "maxFirings": 10, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "contains", "value": "resource=filesystem" }
    ]
  },
  "action": {
    "type": "modifyResponseBody",
    "config": {
      "find": "^(.{128}).*$",
      "replace": "$1",
      "regex": true
    }
  }
}
```

**C# Mechanism:**
Uses `modifyResponseBody` with regex. The pattern `^(.{128}).*$` captures the first 128 characters (with `Singleline` flag so `.` matches newlines) and discards the rest. The replacement `$1` outputs only the captured group.

```csharp
// Regex with Singleline so . matches \n
var rx = new Regex(@"^(.{128}).*$", RegexOptions.Singleline | RegexOptions.Compiled);
modified = rx.Replace(bodyStr, "$1");
// Result: first 128 chars of the original JSON, potentially mid-token
```

**FLT Code Paths Affected:**

| File | Line(s) | What Happens |
|---|---|---|
| `OneLakeRestClient.cs` | 158 | `JsonConvert.DeserializeObject<PathList>(truncatedBody)` → `JsonReaderException`: "Unexpected end when deserializing object." **Caught** by try/catch at line 156. Throws `InvalidOperationException("OneLake parsing failure")`. **SAFE.** |
| `FabricApiClient.cs` | 95 | `JsonConvert.DeserializeObject<LakehouseDetails>(truncatedBody)` → `JsonReaderException`. **Caught** by try/catch around deserialization. Re-throws as logged error. **SAFE.** |
| `FabricApiClient.cs` | 130 | `JsonConvert.DeserializeObject(truncatedBody)` → `JsonReaderException`. **Caught** at operation level. **SAFE.** |
| `FabricApiClient.cs` | 181, 191 | `JsonConvert.DeserializeObject(truncatedBody)` → `JsonReaderException`. **NOT caught** at these specific lines — propagates up. **VULNERABLE** — unhandled exception in polling loop. |

**Edge Cases:**
- **N > body length**: If body is shorter than 128 bytes, regex matches entire body. No truncation. Rule fires but has no effect.
- **Truncation at UTF-8 boundary**: If byte 128 falls in the middle of a multi-byte UTF-8 character, `ReadAsStringAsync()` already decoded to string — truncation is character-based, not byte-based. Safe.
- **Binary responses**: Truncating a Parquet file produces a shorter Parquet file. The DataLake SDK would fail at the reader level, not JSON level.
- **Very small N (1-2 bytes)**: `"{"` or `"["` — `JsonReaderException` immediately. Maximum impact, minimum data.

**Rule Interactions:**
- **After RF-01 (Status Flip)**: Truncated body + wrong status code. If status flipped to 500, FLT reads error body (which is truncated JSON) — may or may not parse depending on error handling path.
- **After RF-02 (Body Mutation)**: Mutation runs first (higher priority), then truncation runs. Mutation output gets truncated.

**Revert:** Disable rule. Full response returns.

**Priority:** **P1** — Tests a realistic failure mode (network issues, proxy truncation) against FLT's error handling.

---

### RF-08: Encoding Mangling

**One-liner:** Return a response body encoded in UTF-16 (or Latin-1) while the `Content-Type` header still claims UTF-8 — testing FLT's encoding handling.

**Description:**
Most Azure services return UTF-8. FLT's code calls `ReadAsStringAsync()`, which uses `Content-Type`'s charset to decode. If the actual encoding doesn't match the declared charset, the string contains garbage characters — and JSON parsing fails or produces corrupted field values.

Scenario variants:
1. **UTF-16 body, UTF-8 header**: `ReadAsStringAsync()` decodes UTF-16 bytes as UTF-8 → mojibake
2. **Latin-1 body, UTF-8 header**: Accented characters corrupt → JSON field values garbled
3. **UTF-8 BOM (Byte Order Mark)**: Prepend `\xEF\xBB\xBF` to body → some parsers treat it as part of the JSON

**ChaosRule JSON:**
```json
{
  "id": "rf08-encoding-utf16-as-utf8",
  "name": "UTF-16 Body with UTF-8 Header",
  "description": "Forge response with UTF-16 encoded body but UTF-8 Content-Type — tests encoding mismatch handling",
  "category": "response-forgery",
  "tags": ["encoding", "utf-16", "deserialization"],
  "phase": "request",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 5, "ttlSeconds": 120 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "matches", "value": ".*/v1/workspaces/.*" }
    ]
  },
  "action": {
    "type": "forgeResponse",
    "config": {
      "statusCode": 200,
      "contentType": "application/json; charset=utf-8",
      "headers": {},
      "body": "__ENCODING_MISMATCH_UTF16__"
    }
  }
}
```

**C# Mechanism:**
The `forgeResponse` action needs a special case for encoding mismatch. We introduce a sentinel in the body string and handle it in the action executor:

```csharp
case "forgeResponse" when config.Body?.StartsWith("__ENCODING_MISMATCH_") == true:
    // Parse encoding directive
    var encoding = config.Body switch
    {
        "__ENCODING_MISMATCH_UTF16__" => Encoding.Unicode,      // UTF-16 LE
        "__ENCODING_MISMATCH_LATIN1__" => Encoding.Latin1,
        "__ENCODING_MISMATCH_UTF8BOM__" => new UTF8Encoding(encoderShouldEmitUTF8Identifier: true),
        _ => Encoding.UTF8
    };

    // Create a valid JSON string, encode it wrong
    var jsonPayload = "{\"id\":\"test\",\"displayName\":\"Encoding Test ñ é ü\"}";
    var encodedBytes = encoding.GetBytes(jsonPayload);

    // But declare Content-Type as UTF-8
    var wrongContent = new ByteArrayContent(encodedBytes);
    wrongContent.Headers.ContentType = new MediaTypeHeaderValue("application/json")
    {
        CharSet = "utf-8"  // LIE — actual encoding is different
    };

    var forgedResponse = new HttpResponseMessage(HttpStatusCode.OK) { Content = wrongContent };
    return ActionResult.ShortCircuit(forgedResponse);
```

**FLT Code Paths Affected:**

| Encoding | File | Line(s) | What Happens |
|---|---|---|---|
| UTF-16 body, UTF-8 header | `FabricApiClient.cs` | 89 | `ReadAsStringAsync()` decodes UTF-16 bytes as UTF-8. Result: `"\xFF\xFE{\"...` or mojibake. `JsonConvert.DeserializeObject` → `JsonReaderException`: unexpected character. |
| UTF-16 body, UTF-8 header | `OneLakeRestClient.cs` | 153 | Same — `ReadAsStringAsync()` returns garbage. `JsonException` caught at line 156. **SAFE.** |
| Latin-1 body, UTF-8 header | `FabricApiClient.cs` | 130 | Characters > 127 decoded wrong. If field values are ASCII-only, no corruption. If they contain accented characters (workspace names), field values corrupted silently. |
| UTF-8 BOM + body | `FabricApiClient.cs` | 95 | BOM bytes `\xEF\xBB\xBF` prepended. `ReadAsStringAsync()` should strip BOM. Newtonsoft.Json handles BOM gracefully. **SAFE — but worth verifying.** |

**Edge Cases:**
- **ReadAsStringAsync auto-detection**: `HttpContent.ReadAsStringAsync()` uses the `Content-Type` charset to select a decoder. If charset is `utf-8`, it uses UTF-8 decoder on UTF-16 bytes → garbage. It does NOT auto-detect encoding.
- **Null charset**: If `Content-Type` has no charset, `ReadAsStringAsync()` defaults to UTF-8 (per RFC 7231). Same result.
- **Streaming responses**: Large file downloads via `DatalakeDirectoryClient` use `ReadAsStreamAsync()` — encoding mismatch would corrupt the stream differently.

**Rule Interactions:**
- **RF-08 is a `forgeResponse` variant**: Pre-empts response-phase rules. RF-01/RF-02 on the forged response would operate on the garbled string.

**Revert:** Disable rule. Real service returns correctly encoded responses.

**Priority:** **P2** — Edge case that's unlikely in production but catastrophic when it happens. Useful for hardening.

---

### RF-09: Stale Response

**One-liner:** Return a cached/recorded response from a previous call instead of the live response — testing FLT's handling of out-of-date data.

**Description:**
This scenario captures a response from an earlier request and replays it for a later request to the same endpoint. FLT receives valid, well-formed JSON — but the data is stale. A lakehouse that was renamed still shows the old name. A DAG node that completed still shows `InProgress`. An operation that succeeded still shows `Running`.

This tests FLT's implicit assumption that responses are fresh and reflect the current state.

**ChaosRule JSON:**
```json
{
  "id": "rf09-stale-lakehouse-details",
  "name": "Stale Lakehouse Metadata",
  "description": "Record the next Lakehouse GET response and replay it for all subsequent calls — tests FLT behavior with stale data",
  "category": "response-forgery",
  "tags": ["fabric-api", "stale-data", "caching", "replay"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 1.0,
  "limits": { "maxFirings": 50, "ttlSeconds": 600 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "matches", "value": ".*/v1/workspaces/.*/lakehouses/.*" },
      { "field": "statusCode", "op": "equals", "value": 200 }
    ]
  },
  "action": {
    "type": "forgeResponse",
    "config": {
      "statusCode": 200,
      "contentType": "application/json",
      "headers": {
        "x-edog-stale": "true",
        "x-edog-captured-at": "2025-07-22T10:00:00Z"
      },
      "body": "{\"id\":\"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\",\"displayName\":\"Old Lakehouse Name\",\"description\":\"This was the name 2 hours ago\",\"type\":\"Lakehouse\",\"workspaceId\":\"11111111-2222-3333-4444-555555555555\",\"properties\":{\"oneLakeTablesPath\":\"https://onelake.dfs.fabric.microsoft.com/ws/lh/Tables\",\"oneLakeFilesPath\":\"https://onelake.dfs.fabric.microsoft.com/ws/lh/Files\",\"sqlEndpointProperties\":{\"connectionString\":\"old-connection\",\"id\":\"sql-old\",\"provisioningStatus\":\"InProgress\"},\"defaultSchema\":\"dbo\"}}"
    }
  }
}
```

**C# Mechanism:**
Phase 1 implementation uses `forgeResponse` with a manually captured body (the user pastes a previous response into the rule builder).

Phase 2 enhancement: A `captureAndReplay` action type that:
1. On first firing: captures the real response body, stores it in a ring buffer keyed by rule ID
2. On subsequent firings: returns the captured body instead of the real response

```csharp
// Phase 2 — captureAndReplay action
case "captureAndReplay":
    if (!ReplayStore.HasCapture(rule.Id))
    {
        // First firing: capture and pass through
        var body = await response.Content.ReadAsStringAsync();
        ReplayStore.Capture(rule.Id, response.StatusCode, body, response.Headers);
        return response; // unmodified — this is the "recording" call
    }
    else
    {
        // Subsequent firings: replay the captured response
        var (code, capturedBody, capturedHeaders) = ReplayStore.Get(rule.Id);
        var replayed = new HttpResponseMessage(code)
        {
            Content = new StringContent(capturedBody, Encoding.UTF8, "application/json"),
            RequestMessage = request,
        };
        foreach (var (k, v) in capturedHeaders)
            replayed.Headers.TryAddWithoutValidation(k, v);
        return replayed;
    }
```

**FLT Code Paths Affected:**

| Stale Data | File | Line(s) | What Happens |
|---|---|---|---|
| Old lakehouse name | `FabricApiClient.cs` | 95 | Deserialization succeeds. FLT uses stale `DisplayName`. UI shows wrong name. **No crash — but incorrect behavior.** |
| Old `provisioningStatus: "InProgress"` | `FabricApiClient.cs` | 95 | `LakehouseDetails.Properties.SqlEndpointProperties.ProvisioningStatus` is `"InProgress"` even though SQL endpoint is ready. FLT may skip SQL operations. |
| Old LRO `status: "Running"` | `FabricApiClient.cs` | 183 | Replay always returns `"Running"`. Polling loops until timeout. Same as RF-05. |

**Edge Cases:**
- **Stale auth tokens in response headers**: If the captured response contains `Set-Cookie` or auth-related response headers, replaying them could confuse token management.
- **Stale `x-ms-request-id`**: Every response has a unique request ID. Replaying a stale request ID means log correlation breaks — multiple FLT log entries point to the same (old) request.
- **ETag changes**: OneLake responses may include ETags. Replaying a stale ETag could cause conditional-request failures (304 Not Modified when data has actually changed).

**Rule Interactions:**
- **RF-09 as `forgeResponse`**: Pre-empts other response-phase rules when using Phase 1 (`forgeResponse`). Compatible with RF-01/RF-02 when using Phase 2 (`captureAndReplay`) — response-phase rules can still mutate the replayed response.

**Revert:** Disable rule. Live responses resume. ReplayStore cleared on rule disable.

**Priority:** **P2** — Valuable for testing data staleness, but requires more infrastructure (ReplayStore). Phase 1 (manual paste) is P1.

---

### RF-10: Slow Drip

**One-liner:** Trickle the response body to FLT at a controlled rate (e.g., 1 KB/sec) — testing timeout handling and streaming behavior.

**Description:**
Unlike RF-07 (Truncation) which returns a short response instantly, Slow Drip returns the **complete** response body but delivers it slowly. FLT's `ReadAsStringAsync()` blocks until the full body arrives. If FLT has a `CancellationToken` with a timeout, the slow drip may trigger it. If FLT has no timeout, it hangs.

The key question: Does FLT set `HttpClient.Timeout` or pass `CancellationToken` timeouts on `ReadAsStringAsync()`?

From the audit:
- `FabricApiClient`: Uses `CancellationToken` parameter → `ReadAsStringAsync(cancellationToken)`. If the token has a timeout, slow drip triggers cancellation.
- `OneLakeRestClient`: Uses `ReadAsStringAsync().ConfigureAwait(false)` — **no CancellationToken**. Slow drip blocks indefinitely until `HttpClient.Timeout` (default: 100 seconds).
- `GTSBasedSparkClient`: Not intercepted (GAP-1).

**ChaosRule JSON:**
```json
{
  "id": "rf10-slow-drip-onelake",
  "name": "OneLake Slow Drip 1KB/s",
  "description": "Trickle OneLake directory listing at 1KB/sec — tests whether FLT has read timeouts on OneLake calls",
  "category": "response-forgery",
  "tags": ["onelake", "latency", "timeout", "streaming"],
  "phase": "response",
  "priority": 100,
  "enabled": false,
  "probability": 0.5,
  "limits": { "maxFirings": 5, "ttlSeconds": 300 },
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
      { "field": "method", "op": "equals", "value": "GET" },
      { "field": "url", "op": "contains", "value": "resource=filesystem" }
    ]
  },
  "action": {
    "type": "throttleBandwidth",
    "config": {
      "bytesPerSecond": 1024
    }
  }
}
```

**C# Mechanism:**
The `throttleBandwidth` action replaces the response's `Content` with a throttled stream wrapper:

```csharp
case "throttleBandwidth":
    var originalContent = response.Content;
    var originalBytes = await originalContent.ReadAsByteArrayAsync();
    var throttledStream = new ThrottledStream(
        new MemoryStream(originalBytes),
        bytesPerSecond: config.BytesPerSecond);

    var throttledContent = new StreamContent(throttledStream);
    // Preserve original Content-Type and Content-Length
    throttledContent.Headers.ContentType = originalContent.Headers.ContentType;
    if (originalContent.Headers.ContentLength.HasValue)
        throttledContent.Headers.ContentLength = originalContent.Headers.ContentLength;

    response.Content = throttledContent;
    break;

// ThrottledStream: reads N bytes per second by inserting Task.Delay between reads
internal class ThrottledStream : Stream
{
    private readonly Stream _inner;
    private readonly int _bytesPerSecond;
    private readonly Stopwatch _sw = Stopwatch.StartNew();
    private long _totalBytesRead;

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        // Calculate how many bytes we're allowed to have read by now
        var elapsed = _sw.Elapsed.TotalSeconds;
        var allowedBytes = (long)(elapsed * _bytesPerSecond);
        var deficit = _totalBytesRead - allowedBytes;

        if (deficit > 0)
        {
            var delayMs = (int)(deficit * 1000.0 / _bytesPerSecond);
            await Task.Delay(delayMs, ct);
        }

        var bytesRead = await _inner.ReadAsync(buffer, offset, Math.Min(count, _bytesPerSecond), ct);
        _totalBytesRead += bytesRead;
        return bytesRead;
    }

    // ... other Stream members delegate to _inner
}
```

**FLT Code Paths Affected:**

| Target | File | Line(s) | What Happens |
|---|---|---|---|
| OneLake directory listing (10KB body at 1KB/s) | `OneLakeRestClient.cs` | 153 | `ReadAsStringAsync()` takes ~10 seconds. No `CancellationToken` passed. **Blocks for 10s.** If `HttpClient.Timeout` is 100s (default), no timeout triggered. FLT hangs for 10s then continues. |
| OneLake directory listing (100KB body at 1KB/s) | `OneLakeRestClient.cs` | 153 | `ReadAsStringAsync()` takes ~100 seconds. Hits default `HttpClient.Timeout` (100s) → `TaskCanceledException`. FLT must handle this. **Does it?** |
| Fabric API response (5KB at 1KB/s) | `FabricApiClient.cs` | 89 | `ReadAsStringAsync(cancellationToken)` — depends on `CancellationToken` timeout. If no timeout set, blocks for 5 seconds. If token has timeout, may cancel. |
| Fabric LRO polling (2KB at 1KB/s) | `FabricApiClient.cs` | 180 | Each poll iteration takes 2s extra. 30 iterations × 2s = 60s added to polling time. May push past 300s timeout → `TimeoutException`. |

**Edge Cases:**
- **Drip rate vs Content-Length**: The `Content-Length` header still reports the full size. FLT (or `ReadAsStringAsync`) knows how many bytes to expect — the drip just slows delivery. No Content-Length mismatch.
- **CancellationToken propagation**: If the `CancellationToken` is cancelled during drip, `ThrottledStream.ReadAsync` throws `OperationCanceledException`. The response read is aborted cleanly.
- **0 bytes/second**: `bytesPerSecond: 0` would cause division by zero. Engine validates `bytesPerSecond > 0` before activating.
- **Very high rate (e.g., 100MB/s)**: No practical throttling — delay is < 1ms. Rule fires but has no observable effect.

**Rule Interactions:**
- **RF-10 + RF-02**: Body mutation runs first (reads full body into string), then slow drip replaces `Content` with throttled version. **But**: mutation already read the full body — the throttled stream wraps the already-read data. **Net effect**: Mutation runs at full speed, then the *mutated* body is dripped slowly to FLT. Correct behavior.
- **RF-10 + RF-07**: Truncation + slow drip = short body dripped slowly. Compatible.

**Revert:** Disable rule. Responses return at full speed.

**Priority:** **P1** — Realistic failure mode (slow network, overloaded proxy). Important for timeout verification.

---

## 3. Priority Summary

| ID | Name | Priority | Rationale |
|---|---|---|---|
| RF-01 | Status Code Flip | **P0** | Fundamental primitive, affects all code paths |
| RF-02 | Body Field Mutation | **P0** | Core mutation, exposes field-level assumptions |
| RF-03 | Full Response Forge | **P0** | Most powerful capability, enables offline dev |
| RF-04 | Schema Surprise | **P0** | Directly tests deserialization audit findings |
| RF-05 | Pagination Loop | **P1** | Tests timeout/loop handling |
| RF-06 | Empty Body | **P0** | Exposes critical null-handling vulnerabilities |
| RF-07 | Truncated Response | **P1** | Realistic failure, tests JSON error paths |
| RF-08 | Encoding Mangling | **P2** | Edge case, useful for hardening |
| RF-09 | Stale Response | **P2** (Phase 1: P1) | Requires ReplayStore infrastructure |
| RF-10 | Slow Drip | **P1** | Tests timeout handling, realistic failure |

**Implementation order:** RF-01 → RF-06 → RF-03 → RF-02 → RF-04 → RF-07 → RF-10 → RF-05 → RF-08 → RF-09

This order builds capabilities bottom-up: status code manipulation → body manipulation → full replacement → field-level mutation → streaming control.

---

## 4. Action Type Summary

| Action Type | Phase | New? | Used By |
|---|---|---|---|
| `modifyResponseStatus` | Response | Defined in engine-design.md | RF-01 |
| `modifyResponseBody` | Response | Defined in engine-design.md | RF-02, RF-04, RF-05 (LRO), RF-07 |
| `modifyResponseHeader` | Response | Defined in engine-design.md | RF-05 (continuation) |
| `forgeResponse` | Request (short-circuit) | Defined in engine-design.md | RF-03, RF-06, RF-08, RF-09 (Phase 1) |
| `throttleBandwidth` | Response | Defined in engine-design.md | RF-10 |
| `captureAndReplay` | Response | **NEW — Phase 2** | RF-09 (Phase 2) |

All action types except `captureAndReplay` are already defined in `engine-design.md`. The `captureAndReplay` action requires a `ReplayStore` component — spec deferred to C06 Advanced.

---

## 5. Cross-Category Interactions

| RF Scenario | C01 (Request Surgery) | C03 (Traffic Control) | C04 (Security Probing) |
|---|---|---|---|
| RF-01 (Status Flip) | C01 modifies request, RF-01 modifies response. Compatible — both fire. | C03 delays request, RF-01 flips response status. Compatible. | SP-08 adds CORS headers to response — if RF-01 also fires, both apply. |
| RF-03 (Full Forge) | C01 modifies request URL → `forgeResponse` predicate evaluates against modified URL. Compatible. | C03 blackhole vs RF-03 forge: if `forgeResponse` has lower priority number, it short-circuits before C03 can blackhole. **`forgeResponse` wins.** | SP-01 (token downgrade) on request + RF-03 (forged response) = FLT sends downgraded token, gets forged success response. Tests whether FLT validates auth on the response side. |
| RF-06 (Empty Body) | C01 modifies request body, RF-06 returns empty response body. Independent — request body ≠ response body. | C03 throttle + RF-06 empty body = throttled empty body (no practical effect). | N/A |
| RF-10 (Slow Drip) | C01 adds latency to request + RF-10 adds latency to response = double latency. May exceed timeouts. **Intentional for stress testing.** | C03 bandwidth throttle + RF-10 bandwidth throttle: both apply. Effective rate = min(C03 rate, RF-10 rate). | N/A |

---

## 6. Safety Considerations Specific to Response Forgery

| Risk | Mitigation |
|---|---|
| **Forged response persists in FLT cache** | FLT's in-memory caches (TokenManager, CatalogCache, DagExecutionStore) may cache forged data. **After disabling a rule, these caches still contain forged data until they expire or are evicted.** Mitigation: Document in UI that "disabling a rule does not clear cached forged data — restart FLT for clean state." |
| **LRO infinite polling burns CPU** | RF-05 can cause FLT to poll for 300 seconds. `maxFirings` limit prevents indefinite loops, but the timeout still burns. Mitigation: `ttlSeconds` on the rule + kill switch (Ctrl+Shift+K). |
| **Forged response triggers downstream writes** | A forged `LakehouseDetails` response could cause FLT to write to a non-existent lakehouse. Mitigation: Response forgery only affects reads. Write operations use request data, not response data. However, `CreateSemanticModelAsync` uses `result.id` from the response to set up further resources — a forged `id` could point writes to the wrong resource. **Probability control is essential for write-path forgeries.** |
| **Encoding mismatch causes data corruption** | RF-08 can corrupt field values silently (Latin-1 decoded as UTF-8). If FLT writes corrupted values to storage, the corruption persists. Mitigation: RF-08 is P2 and should only be used with `maxFirings: 1` to observe the failure, not replicate it at scale. |
| **Slow drip blocks FLT thread** | RF-10 blocks `ReadAsStringAsync` — if FLT is single-threaded for this call, the entire pipeline stalls. Mitigation: `probability: 0.5` default for RF-10, plus `maxFirings` limit. |

---

## 7. FLT Deserialization Vulnerability Map

Cross-reference of every audited deserialization point with the RF scenario that tests it:

| File | Line(s) | Deserialization Target | Vulnerability | Tested By |
|---|---|---|---|---|
| `FabricApiClient.cs` | 95 | `LakehouseDetails` (typed) | Missing null-body check | RF-06 |
| `FabricApiClient.cs` | 130 | `dynamic` (workspace name) | `NullRefException` on missing `displayName` | RF-02, RF-04, RF-06 |
| `FabricApiClient.cs` | 181 | `dynamic` (LRO status) | No try/catch, `NullRefException` on null | RF-05, RF-06 |
| `FabricApiClient.cs` | 191 | `dynamic` (LRO result id) | `RuntimeBinderException` on null/wrong type | RF-04, RF-06 |
| `FabricApiClient.cs` | 364, 413 | `dynamic` (create result id) | No try/catch, unsafe `.id` access | RF-04, RF-06 |
| `OneLakeRestClient.cs` | 158 | `PathList` (typed) | ✅ Safe — try/catch + null-conditional | RF-02, RF-06, RF-07 |
| `OneLakeRestClient.cs` | 287–353 | Status code switch | Gap: 408, 409 not handled | RF-01 |
| `FabricApiClient.cs` | 63–88 | Status code chain | Falls to `EnsureSuccessStatusCode` for unknown codes | RF-01 |
| `FabricApiClient.cs` | 206–215 | LRO intermittent retry | Only handles 502/503/429 — misses 408, 409, 504 | RF-01 |

---

*"Every response your code trusts is a response your chaos engine should be able to forge."*

— Sana Reeves, EDOG Studio Architecture
