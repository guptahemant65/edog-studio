# Fabric API Endpoint Reference — EDOG Studio

> **Status:** 🟢 TESTED against live PPE environment (FabricFMLV08PPE tenant)
> **Date:** 2026-04-09
> **Token:** Bearer token (PBI audience: `analysis.windows-int.net/powerbi/api`)
> **Test Environment:** EDOG_Studio_TestEnv workspace + EDOG_Test_LH lakehouse
> **Sources:** design-spec-v2.md, FabricSparkCST POC (`users/guptahemant/devmodePOC`), live testing
> **Last Updated By:** Dev Patel + Elena Voronova

---

## Token Types

| Token | Audience | How Obtained | Cached In | Used For |
|-------|----------|-------------|-----------|----------|
| **Bearer (PBI)** | `https://analysis.windows-int.net/powerbi/api` | Playwright → navigate to `powerbi-df.analysis-df.windows.net` → capture from request headers | `.edog-bearer-cache` | Metadata APIs, v1 APIs via redirect host, MWC token generation |
| **Bearer (Fabric)** | `https://api.fabric.microsoft.com` | Would need to navigate to `app.fabric.microsoft.com` OR use MSAL with correct scope | NOT YET IMPLEMENTED | Direct calls to `api.fabric.microsoft.com` (NOT currently used) |
| **MWC** | Capacity-specific | `POST /metadata/v201606/generatemwctoken` using PBI bearer | `.edog-token-cache` | FLT service APIs (DAG, Spark, maintenance) |

### Key Insight
The PBI-audience bearer token works against the **redirect host** (`biazure-int-edog-redirect.analysis-df.windows.net`) but **NOT** against the public Fabric API (`api.fabric.microsoft.com`). All EDOG Studio Fabric API calls MUST go through the redirect host.

---

## Hosts

| Host | Purpose | Token Required |
|------|---------|---------------|
| `https://biazure-int-edog-redirect.analysis-df.windows.net` | Internal redirect gateway — routes to metadata and v1 APIs | PBI Bearer |
| `https://api.fabric.microsoft.com` | Public Fabric REST API | Fabric Bearer (NOT the PBI token!) |
| `https://{capacityId}.pbidedicated.windows-int.net` | Capacity-specific FLT service endpoint | MWC |

---

## Endpoint Matrix

### CATEGORY: Workspace Operations

| Endpoint | Method | Path | Host | Status | Response Shape | Notes |
|----------|--------|------|------|--------|---------------|-------|
| **List workspaces (metadata)** | GET | `/metadata/workspaces` | redirect | ✅ OK 200 | `{ folders: [{ id, displayName, objectId, capacityObjectId, ... }] }` | Returns numeric `id` AND GUID `objectId`. Use `objectId` as the workspace GUID. |
| **List workspaces (v1.0)** | GET | `/v1.0/myorg/groups` | redirect | ✅ OK 200 | `{ @odata.context, @odata.count, value: [{ id, name, type, capacityId, isOnDedicatedCapacity }] }` | Power BI REST API format. `name` not `displayName`. `id` is the GUID. |
| **List workspaces (v1 public)** | GET | `/v1/workspaces` | api.fabric | ❌ 401 | `{ errorCode: "InvalidToken" }` | Requires Fabric-audience token |
| **Create workspace** | POST | `/metadata/folders` | redirect | ✅ OK 200 | `[{ id, displayName, objectId, ... }]` | Body: `{ capacityObjectId, displayName, description, isServiceApp: false, datasetStorageMode: 1 }` |
| **Rename workspace** | PATCH | `/v1/workspaces/{wsId}` | redirect | ✅ OK 200 | `{ id, displayName, description, type, capacityId }` | Body: `{ displayName: "new name" }`. Returns updated workspace. |
| **Delete workspace** | DELETE | `/v1/workspaces/{wsId}` | redirect | ⚠️ NOT TESTED | — | Risk: destructive. Test in dedicated environment. |

### CATEGORY: Item Operations

| Endpoint | Method | Path | Host | Status | Response Shape | Notes |
|----------|--------|------|------|--------|---------------|-------|
| **List items in workspace (v1)** | GET | `/v1/workspaces/{wsId}/items` | redirect | ✅ OK 200 | `{ value: [{ id, type, displayName, description, workspaceId }] }` | Standard Fabric v1 shape. `type` values: `Lakehouse`, `Notebook`, `SQLEndpoint`, etc. **USE THIS for tree population.** |
| **List items (metadata)** | GET | `/metadata/workspaces/{wsId}/artifacts` | redirect | ✅ OK 200 | `[{ objectId, artifactType, displayName, description, folderObjectId, provisionState, lastUpdatedDate, capacityObjectId }]` | Raw array (not wrapped in `{ value }`). Uses `artifactType` not `type`, `objectId` not `id`. Includes `SqlAnalyticsEndpoint` artifacts. |
| **Get artifact by ID** | GET | `/metadata/artifacts/{artifactId}` | redirect | ✅ OK 200 | `{ objectId, artifactType, displayName, description, ... }` | Single artifact lookup. |

### CATEGORY: Lakehouse Operations

| Endpoint | Method | Path | Host | Status | Response Shape | Notes |
|----------|--------|------|------|--------|---------------|-------|
| **List lakehouses (v1)** | GET | `/v1/workspaces/{wsId}/lakehouses` | redirect | ✅ OK 200 | `{ value: [{ id, type, displayName, description, workspaceId, properties }] }` | Filtered to lakehouses only. `properties` has `oneLakeTablesPath`, `oneLakeFilesPath`, etc. |
| **Get lakehouse by ID (v1)** | GET | `/v1/workspaces/{wsId}/lakehouses/{lhId}` | redirect | ✅ OK 200 | `{ id, type, displayName, description, workspaceId, properties }` | `properties.oneLakeTablesPath`, `properties.oneLakeFilesPath`, `properties.sqlEndpointProperties` |
| **Rename lakehouse (v1)** | PATCH | `/v1/workspaces/{wsId}/lakehouses/{lhId}` | redirect | ✅ OK 200 | `{ id, type, displayName, description, workspaceId, properties }` | Body: `{ displayName: "new name" }` |
| **Delete lakehouse (v1)** | DELETE | `/v1/workspaces/{wsId}/lakehouses/{lhId}` | redirect | ⚠️ NOT TESTED | — | Destructive. |
| **Create lakehouse (v1)** | POST | `/v1/workspaces/{wsId}/lakehouses` | redirect | ⚠️ NOT TESTED | Expect: `{ id, ... }` | Body: `{ displayName: "name" }` |

### CATEGORY: Table Operations

| Endpoint | Method | Path | Host | Status | Response Shape | Notes |
|----------|--------|------|------|--------|---------------|-------|
| **List tables (v1)** | GET | `/v1/workspaces/{wsId}/lakehouses/{lhId}/tables` | redirect | ❌ 400 | `{ errorCode: "UnsupportedOperationForSchemasEnabledLakehouse" }` | **FAILS for schema-enabled lakehouses** (which all PPE lakehouses seem to be). Need to test with non-schema lakehouse OR use alternative endpoint. |
| **List tables (metadata)** | GET | `/metadata/artifacts/{lhId}/tables` | redirect | ❌ 404 | — | Endpoint does not exist on metadata API. |
| **Load table** | POST | `/v1/workspaces/{wsId}/lakehouses/{lhId}/tables/{tableName}/load` | redirect | ⚠️ NOT TESTED | LRO (202 + Location header) | From POC `ILakehousePublicApiClient`. |

### Key Insight: FLT Requires Schema-Enabled Lakehouses

FLT code **always** creates lakehouses with `{"enableSchemas": true}`. This means:

1. The public API table listing (`GET /v1/.../tables`) returns **400 UnsupportedOperationForSchemasEnabledLakehouse** for ALL FLT lakehouses
2. Tables for schema-enabled lakehouses must be listed via the **capacity host DataArtifact endpoint** which requires an MWC token (Phase 2 only)
3. In Phase 1 (disconnected), table listing is NOT available — the inspector should show "Deploy to view tables" placeholder

### CRITICAL: MWC Token Auth Scheme

**MWC tokens use `Authorization: MwcToken {token}` — NOT `Authorization: Bearer {token}`!**

This was found by decompiling `CreateHttpMWCTokenClient` from the PowerBI.Test.E2E DLL:

```csharp
// From SSMOperationTestsBase.cs and DirectApiAuthTokenHandler.cs:
httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("MwcToken", mwcToken.Token);
```

**Tested:** ✅ OK 200 — `Authorization: MwcToken` works against capacity host endpoints.

### Required Headers for Capacity Host Endpoints

| Header | Value | Required |
|--------|-------|----------|
| `Authorization` | `MwcToken {mwcToken}` | Always |
| `x-ms-workload-resource-moniker` | Lakehouse artifact ID (GUID) | Always |
| `x-ms-lakehouse-client-session-id` | Random UUID | For async operations |
| `x-ms-client-authorization` | `Bearer {gtsToken}` | For custom transforms only |
| `Content-Type` | `application/json` | Always |

### Table Listing Endpoints (Three Variants)

| Endpoint | Schema Support | Token | Host | Phase |
|----------|---------------|-------|------|-------|
| `GET /v1/workspaces/{wsId}/lakehouses/{lhId}/tables` | Non-schema only | Bearer | redirect | Phase 1 (non-FLT lakehouses only) |
| `GET /webapi/.../artifacts/Lakehouse/{lhId}/tables` | Non-schema only | MWC | capacity | Phase 2 |
| `GET /webapi/.../artifacts/DataArtifact/{lhId}/schemas/{schemaName}/tables` | **Schema-enabled (FLT)** | MWC | capacity | Phase 2 |

**Schema-enabled table listing path:**
```
GET https://{capacityId-no-dashes}.pbidedicated.windows-int.net/webapi/capacities/{capId}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{wsId}/artifacts/DataArtifact/{lhId}/schemas/dbo/tables
Authorization: MwcToken {mwcToken}
x-ms-workload-resource-moniker: {lhId}
```

Default schema name is `dbo` (from `properties.defaultSchema` on lakehouse GET).

**Response shape:** `{ "continuationToken": null, "data": [{ "name": "tableName" }] }`

**Tested:** ✅ OK 200 — Real tables returned across 10 workspaces, 17 lakehouses, 92+ tables total. The `data` array contains objects with `name` field. Additional fields (type, format, location) not present in schema-aware listing — use `batchGetTableDetails` for full metadata.

### Table Preview (Phase 2, capacity host, MWC token)
```
POST /webapi/.../artifacts/Lakehouse/{lhId}/tables/{tableName}/previewAsync
→ Returns operationId (async operation)
GET  /webapi/.../artifacts/Lakehouse/{lhId}/tables/{tableName}/previewAsync/operationResults/{operationId}
→ Returns table preview data
```

### Batch Table Details (Schema-enabled, Phase 2)
```
POST /webapi/.../artifacts/DataArtifact/{lhId}/schemas/{schemaName}/batchGetTableDetails
→ Returns operationId
GET  /webapi/.../artifacts/DataArtifact/{lhId}/schemas/{schemaName}/batchGetTableDetails/operationResults/{operationId}
→ Returns detailed table metadata
```

### CATEGORY: MWC Token & FLT Service

| Endpoint | Method | Path | Host | Status | Response Shape | Notes |
|----------|--------|------|------|--------|---------------|-------|
| **Generate MWC token** | POST | `/metadata/v201606/generatemwctoken` | redirect | ✅ OK 200 | `{ Token, TargetUriHost, CapacityObjectId, Expiration }` | Body: `{ type: "[Start] GetMWCToken", workloadType: "Lakehouse", workspaceObjectId, artifactObjectIds: [lhId], capacityObjectId }` |
| **Ping FLT service** | GET | `/webapi/capacities/{capId}/workloads/LiveTable/.../publicUnprotected/ping` | capacity host | ⚠️ NOT TESTED | `"pong core live table"` | Use dedicated capacity host, NOT redirect gateway |
| **Get latest DAG** | GET | `...LiveTableService/.../liveTable/getLatestDag?showExtendedLineage=true` | capacity host | ⚠️ Phase 2 | — | Requires MWC token |
| **Run DAG** | POST | `...liveTableSchedule/runDAG/{iterationId}` | capacity host | ⚠️ Phase 2 | — | Requires MWC token |
| **DAG settings** | GET | `...liveTable/settings` | capacity host | ⚠️ Phase 2 | — | Requires MWC token |
| **Patch DAG settings** | PATCH | `...liveTable/patchDagSettings` | capacity host | ⚠️ Phase 2 | — | Requires MWC token |

### CATEGORY: Other Endpoints

| Endpoint | Method | Path | Host | Status | Response Shape | Notes |
|----------|--------|------|------|--------|---------------|-------|
| **Workspace access** | GET | `/metadata/access/folders/{wsId}` | redirect | ❌ 404 | — | Does not exist |
| **List capacities** | GET | `/v1/capacities` | redirect | ⚠️ NOT TESTED | — | May need admin scope |
| **Assign to capacity** | POST | `/v1/workspaces/{wsId}/assignToCapacity` | redirect | ⚠️ NOT TESTED | — | Body: `{ capacityId }` |

---

## Response Shape Differences: Metadata vs v1 API

### Workspaces

| Field | Metadata (`/metadata/workspaces`) | v1 (`/v1/workspaces/{id}`) | v1.0 (`/v1.0/myorg/groups`) |
|-------|-----------------------------------|---------------------------|------------------------------|
| ID | `objectId` (GUID) | `id` (GUID) | `id` (GUID) |
| Name | `displayName` | `displayName` | `name` |
| Type | N/A | `type` | `type` |
| Capacity | `capacityObjectId` | `capacityId` | `capacityId` |

### Items/Artifacts

| Field | Metadata (`/metadata/.../artifacts`) | v1 (`/v1/.../items`) |
|-------|---------------------------------------|----------------------|
| ID | `objectId` | `id` |
| Type | `artifactType` (e.g., `Lakehouse`, `SynapseNotebook`, `SqlAnalyticsEndpoint`) | `type` (e.g., `Lakehouse`, `Notebook`, `SQLEndpoint`) |
| Name | `displayName` | `displayName` |
| Modified | `lastUpdatedDate` | N/A (not in v1 items) |
| Extra | `provisionState`, `capacityObjectId`, `folderObjectId` | `workspaceId`, `description` |

### Recommendation
**Use v1 API paths via the redirect host** for all frontend-facing calls. The v1 responses have cleaner shapes (`id`, `type`, `displayName`) that require no normalization. Only use metadata paths for operations not available in v1 (e.g., workspace creation via `/metadata/folders`, MWC token generation).

---

## Proxy Configuration (dev-server.py)

Since the browser cannot call the redirect host directly (CORS), the dev server proxies requests:

```
Browser → /api/fabric/* → dev-server.py → https://biazure-int-edog-redirect.analysis-df.windows.net/*
```

### Recommended Path Mapping

| Browser requests | Proxy forwards to | Normalization needed? |
|-----------------|-------------------|----------------------|
| `/api/fabric/workspaces` | `/v1.0/myorg/groups` OR `/metadata/workspaces` | Yes: `{ folders }` → `{ value }`, field renames |
| `/api/fabric/workspaces/{id}/items` | `/v1/workspaces/{id}/items` | **No** — already `{ value: [...] }` |
| `/api/fabric/workspaces/{id}/lakehouses` | `/v1/workspaces/{id}/lakehouses` | **No** — already `{ value: [...] }` |
| `/api/fabric/workspaces/{id}/lakehouses/{id}` | `/v1/workspaces/{id}/lakehouses/{id}` | **No** |
| `/api/fabric/workspaces/{id}/lakehouses/{id}/tables` | `/v1/workspaces/{id}/lakehouses/{id}/tables` | **No** (but may 400 for schema-enabled LH) |
| `PATCH /api/fabric/workspaces/{id}` | `PATCH /v1/workspaces/{id}` | **No** |
| `PATCH /api/fabric/workspaces/{id}/lakehouses/{id}` | `PATCH /v1/workspaces/{id}/lakehouses/{id}` | **No** |

**Key insight:** If we use v1 paths instead of metadata paths, we need NO normalization for items, lakehouses, or mutations. Only workspace listing needs normalization if using metadata path. **Simplest approach: use `/v1.0/myorg/groups` for workspace listing (returns `{ value }` natively).**

---

## Known Issues

1. **Tables 400 for schema-enabled lakehouses** — All PPE lakehouses appear to have schemas enabled, causing `GET .../tables` to fail with `UnsupportedOperationForSchemasEnabledLakehouse`. Need to either create a non-schema lakehouse for testing or find an alternative tables endpoint.

2. **`api.fabric.microsoft.com` requires Fabric-audience token** — Our Playwright-captured bearer token has PBI audience and cannot call the public Fabric API. All calls must go through the redirect host.

3. **`/metadata/artifacts/{id}/tables` does not exist** — The metadata API has no tables endpoint. Must use v1 path.

4. **Some workspaces return 404 on `/v1/workspaces/{id}/items`** — e.g., `psai_FLT_1` returned `EntityNotFound`. May be a permissions issue or workspace type incompatibility.

---

## Action Items (F01)

- [x] Switch proxy to forward v1 paths directly — **DONE** (dev-server.py rewritten)
- [x] Only use metadata path for workspace listing — **DONE**
- [x] Handle tables 400 gracefully — **DONE** (toast notification)
- [x] Test table listing with a non-schema lakehouse — **DONE** (EDOG_Test_LH: 0 tables, endpoint returns 200)
- [ ] Consider Fabric-audience token acquisition for full public API access

---

## Test Environment

Auto-provisioned by `scripts/provision-test-env.py`. Safe to delete.

```json
{
  "workspaceId": "65e22bd4-92a1-4de6-8bfc-af813eccff3e",
  "workspaceName": "EDOG_Studio_TestEnv",
  "lakehouseId": "8453bb5e-c2ae-474d-a8e3-983b28ead8ba",
  "lakehouseName": "EDOG_Test_LH",
  "capacityId": "dd01a7f3-4198-4439-aae3-4eaf902281bb",
  "redirectHost": "https://biazure-int-edog-redirect.analysis-df.windows.net"
}
```

**All F01 endpoints tested OK (11/11)** against this environment. Tables endpoint returns `{ data: [], continuationToken, continuationUri }` for non-schema lakehouses.

---

# F02: LOGS VIEW — WebSocket + REST

> **Phase:** Connected only (requires running FLT service)
> **Token:** Bearer (WebSocket upgrade), internal (REST endpoints served by EdogLogServer)

## WebSocket: Live Log Stream

| Endpoint | Protocol | Path | Purpose |
|----------|----------|------|---------|
| Log stream | WebSocket | `ws://localhost:5555/ws/logs` | Real-time log entries from FLT service |

**Message Types (JSON frames):**

```jsonc
// Log entry
{ "type": "log", "timestamp": "ISO8601", "level": "Verbose|Message|Warning|Error",
  "component": "string", "message": "string", "correlationId": "string",
  "properties": {} }

// Spark request capture (from EdogTelemetryInterceptor)
{ "type": "spark_request", "method": "GET|POST", "url": "string",
  "statusCode": 200, "duration": 150, "body": "SQL or PySpark",
  "retry": { "count": 0, "delays": [] } }

// File change notification (from Python watchdog)
{ "type": "file_change", "files": [{ "path": "string", "action": "created|modified|deleted" }] }
```

**Batching:** 150ms batch window, up to 10K entries in ring buffer.

## REST: Log History

| Method | Path | Purpose | Tested |
|--------|------|---------|--------|
| GET | `/api/logs` | Fetch recent log entries | ⚠️ Phase 2 |
| GET | `/api/telemetry` | Fetch SSR telemetry events | ⚠️ Phase 2 |
| GET | `/api/stats` | Log/telemetry statistics | ⚠️ Phase 2 |
| GET | `/api/spark-requests` | Query Spark request history with filters | ⚠️ Phase 2 |

> These endpoints are served by EdogLogServer (C# Kestrel). They don't exist yet — implementing them is part of the Logs view feature.

---

# F03: DAG STUDIO — FLT Service APIs

> **Phase:** Connected only
> **Token:** MWC token
> **Host:** `https://{capacityId}.pbidedicated.windows-int.net`
> **Base path:** `/webapi/capacities/{capId}/workloads/LiveTable/LiveTableService/automatic/v1/workspaces/{wsId}/lakehouses/{lhId}`

## Endpoints

| Method | Path (relative to base) | Purpose | Response Shape | Tested |
|--------|------------------------|---------|----------------|--------|
| GET | `/liveTable/getLatestDag?showExtendedLineage=true` | Fetch current DAG definition | `{ nodes: [{ nodeId, name, kind, parents[], children[], status, errorCode }], edges: [] }` | ❌ DNS fail (no FLT running) |
| GET | `/liveTable/listDAGExecutionIterationIds?historycount=10` | List recent DAG execution iterations | `[{ iterationId, displayName, status, startedAt }]` | ❌ DNS fail |
| GET | `/liveTable/getDAGExecMetrics/{iterationId}` | Execution metrics per node | `{ dagExecutionMetrics: { status, startedAt, endedAt }, nodeExecutionMetrices: { nodeName: { status } } }` | ❌ DNS fail |
| GET | `/liveTable/settings` | Get DAG settings | `{ refreshMode, parallelNodeLimit, environment: { environmentId, workspaceId } }` | ❌ DNS fail |
| PATCH | `/liveTable/patchDagSettings` | Update DAG settings | Same as GET response | ❌ DNS fail |
| GET | `/liveTable/mlvExecutionDefinitions` | List MLV execution definitions | `[{ id, name, ... }]` | ❌ DNS fail |
| POST | `/liveTable/mlvExecutionDefinitions/{id}` | Execute MLV definition | `{ iterationId, status }` | ⚠️ Not tested |
| POST | `/liveTableSchedule/runDAG/{iterationId}` | Trigger DAG execution | `{ iterationId, status }` | ⚠️ Not tested |
| POST | `/liveTableSchedule/cancelDAG/{iterationId}` | Cancel running DAG | `{ status }` | ⚠️ Not tested |

### DAG Settings Reset Payload (from POC)
```json
{
  "refreshMode": "Optimal",
  "parallelNodeLimit": 5,
  "environment": {
    "environmentId": "00000000-0000-0000-0000-000000000000",
    "workspaceId": "00000000-0000-0000-0000-000000000000"
  }
}
```

### Error Handling
- DAG settings lock errors (500): Retry with exponential backoff + jitter
- Error messages: "Failed to acquire DAG settings lock", "Failed to attach DAG settings lock", "Failed to merge DAG settings"

### Service Health

| Method | Path | Purpose | Auth | Tested |
|--------|------|---------|------|--------|
| GET | `/webapi/capacities/{capId}/workloads/LiveTable/LiveTableService/automatic/publicUnprotected/ping` | Health check | None | ❌ DNS fail |

**Expected response:** `"pong core live table"`
**Important:** Must use capacity host directly, NOT redirect gateway.

---

# F04: SPARK INSPECTOR — EdogLogServer APIs

> **Phase:** Connected only
> **Token:** Internal (served by EdogLogServer)
> **Host:** `localhost:5555`

| Method | Path | Purpose | Tested |
|--------|------|---------|--------|
| GET | `/api/spark-requests` | Filtered Spark request history | ⚠️ Not implemented yet |

Query params: `?method=GET&status=200&endpoint=/path&minDuration=100`

> Spark requests are captured by `EdogTelemetryInterceptor.cs` and sent via WebSocket. The REST endpoint provides historical query. Implementation pending.

---

# F05: ENVIRONMENT VIEW — Maintenance + Feature Flags

> **Phase:** Connected (maintenance) + Both (feature flags)

## Maintenance APIs (MWC token, capacity host)

| Method | Path (relative to base) | Purpose | Tested |
|--------|------------------------|---------|--------|
| GET | `/liveTableMaintenance/getLockedDAGExecutionIteration` | Check DAG execution lock state | ❌ DNS fail |
| POST | `/liveTableMaintenance/forceUnlockDAGExecution` | Force unlock stuck DAG | ⚠️ Not tested |
| GET | `/liveTableMaintenance/listOrphanedIndexFolders` | List orphaned OneLake folders | ⚠️ Not tested |
| POST | `/liveTableMaintenance/deleteOrphanedIndexFolders` | Cleanup orphaned folders | ⚠️ Not tested |

## Scheduled Jobs (Bearer token, redirect host)

| Method | Path | Purpose | Tested |
|--------|------|---------|--------|
| GET | `/metadata/artifacts/{lhId}/scheduledJobs` | List scheduled jobs | ⚠️ Not tested |
| POST | `/metadata/artifacts/{lhId}/scheduledJobs` | Create scheduled job | ⚠️ Not tested |
| PUT | `/metadata/artifacts/{lhId}/scheduledJobs` | Update scheduled job | ⚠️ Not tested |
| DELETE | `/metadata/artifacts/{lhId}/jobs/{jobInstanceId}` | Cancel running job | ⚠️ Not tested |

### Schedule Job Request Body (from POC)
```json
{
  "artifactJobType": "MaterializedLakeViews",
  "artifactObjectId": "lakehouse-guid",
  "jobDefinitionObjectId": null,
  "scheduleEnabled": true,
  "scheduleType": 2,
  "cronPeriod": 3,
  "scheduleStartTime": "2026-01-15T14:30:00.000Z",
  "scheduleEndTime": "2026-01-15T15:30:00.000Z",
  "scheduleHours": "[14:30]",
  "localTimeZoneId": "India Standard Time",
  "scheduleWeekIndex": 1,
  "scheduleWeekdays": 127,
  "parameters": [
    { "name": "mlvExecutionDefinitionId", "type": "Guid", "value": "exec-def-guid" }
  ]
}
```

**Rules:** POST when `jobDefinitionObjectId` is null (create), PUT when it has a value (update).

## Feature Flag APIs (EdogLogServer, localhost:5555)

| Method | Path | Purpose | Tested |
|--------|------|---------|--------|
| GET | `/api/edog/feature-overrides` | Get current feature flag overrides | ⚠️ Not implemented |
| POST | `/api/edog/feature-overrides` | Set feature flag overrides | ⚠️ Not implemented |

---

# F06: IPC / COMMAND CHANNEL

> **Phase:** Both
> **Architecture:** Browser → EdogLogServer → `.edog-command/` file → edog.py polls

## Command Endpoints (EdogLogServer, localhost:5555)

| Method | Path | Purpose | Tested |
|--------|------|---------|--------|
| POST | `/api/command/restart` | Restart FLT service | ⚠️ Not implemented |
| POST | `/api/command/refresh-token` | Force token refresh | ⚠️ Not implemented |
| POST | `/api/command/set-feature-overrides` | Set feature flags | ⚠️ Not implemented |

## Alternative: edog.py Control Server (port 5556)

| Method | Path | Purpose | Tested |
|--------|------|---------|--------|
| POST | `http://localhost:5556/command/restart` | Direct restart | ⚠️ Not implemented |
| POST | `http://localhost:5556/command/refresh-token` | Direct token refresh | ⚠️ Not implemented |

---

# TOKEN GENERATION

## MWC Token (from POC `LiveTableTestUtils.cs`)

| Method | Path | Host | Purpose |
|--------|------|------|---------|
| POST | `/metadata/v201606/generatemwctoken` | redirect | Generate MWC token for capacity APIs |

**Request:**
```json
{
  "type": "[Start] GetMWCToken",
  "workloadType": "Lakehouse",
  "workspaceObjectId": "ws-guid",
  "artifactObjectIds": ["lh-guid"],
  "capacityObjectId": "cap-guid"
}
```

**Response:**
```json
{
  "Token": "jwt-string",
  "TargetUriHost": "capId.pbidedicated.windows-int.net",
  "CapacityObjectId": "cap-guid",
  "Expiration": "ISO datetime"
}
```

**Tested:** ✅ OK 200 — MWC token generated successfully for test environment.

### Token Caching Strategy (from POC)
- Cache with 5-minute refresh buffer before expiry
- Fallback to 1-hour assumption if expiry can't be parsed from JWT
- Concurrent request limiting to prevent null token responses
- Max 3 consecutive failures before raising exception

### Bearer Token from MWC JWT (from POC `ExtractBearerTokenFromDevmodeCache`)
The MWC JWT contains the original bearer token in the `originalAuthorizationHeader` claim:
```python
# Parse MWC JWT → extract payload → get originalAuthorizationHeader → strip "Bearer "
claims = decode_jwt(mwc_token)
bearer = claims["originalAuthorizationHeader"].replace("Bearer ", "")
```

---

# ADO/GIT — Feature Flag PR Creation

| Method | Path | Purpose | Token |
|--------|------|---------|-------|
| POST | `dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests` | Create feature flag PR | ADO PAT |

Alternative: `az repos pr create` CLI

---

# ENDPOINT COUNT BY FEATURE

| Feature | Count | Bearer | MWC | Internal | Not Implemented |
|---------|-------|--------|-----|----------|-----------------|
| F01: Workspace Explorer | 14 | 14 | 0 | 0 | 0 |
| F02: Logs | 5 | 0 | 0 | 5 | 4 |
| F03: DAG Studio | 10 | 0 | 10 | 0 | 0 (need FLT running) |
| F04: Spark Inspector | 1 | 0 | 0 | 1 | 1 |
| F05: Environment | 10 | 4 | 4 | 2 | 6 |
| F06: IPC/Commands | 5 | 0 | 0 | 5 | 5 |
| Capacity Management | 15 | 15 | 0 | 0 | 0 |
| Portal Metadata | 10 | 10 | 0 | 0 | 0 |
| Token/Auth | 1 | 1 | 0 | 0 | 0 |
| ADO/Git | 1 | 0 | 0 | 0 | 0 |
| **Total** | **~72** | **44** | **14** | **13** | **16** |

---

# RENAME OPERATIONS

> **Tested:** 2026-04-09 | All using Bearer token on redirect host

| What | Method | Path | Status | Response |
|------|--------|------|--------|----------|
| Rename workspace | PATCH | `/v1/workspaces/{wsId}` | ✅ 200 | `{ id, displayName, description, type, capacityId }` |
| Rename lakehouse | PATCH | `/v1/workspaces/{wsId}/lakehouses/{lhId}` | ✅ 200 | `{ id, type, displayName, description, workspaceId, properties }` |
| Rename ANY item (notebook, etc.) | PATCH | `/v1/workspaces/{wsId}/items/{itemId}` | ✅ 200 | `{ id, type, displayName, description, workspaceId }` |
| Rename table | PATCH | `/v1/.../tables/{name}` | ❌ 404 | Tables have immutable names |

**Request body for all renames:** `{ "displayName": "new name" }`

**Key insight:** `PATCH /v1/workspaces/{wsId}/items/{itemId}` is the **universal rename** — works for any item type (notebooks, pipelines, etc.), not just lakehouses.

---

# CAPACITY MANAGEMENT (Internal APIs)

> **Tested:** 2026-04-09 | Bearer token + `x-powerbi-user-admin: true` header on redirect host
> **Host:** `https://biazure-int-edog-redirect.analysis-df.windows.net`

## Required Headers for Capacity Admin APIs

```
Authorization: Bearer {pbiToken}
x-powerbi-hostenv: Power BI Web App
x-powerbi-user-admin: true
origin: https://powerbi-df.analysis-df.windows.net
referer: https://powerbi-df.analysis-df.windows.net/
```

## Capacity Endpoints

| Method | Path | Status | Response | Notes |
|--------|------|--------|----------|-------|
| GET | `/capacities/listandgethealthbyrollouts` | ✅ 200 | `{ capacitiesMetadata[], rolloutErrors[], capacitiesHealth[] }` | **Master endpoint** — 46 entries (10 real + 36 SKU templates) |
| GET | `/capacities/{capId}` | ✅ 200 | `{ metadata, access, copilotAccess, isCopilotAllowed }` | Single capacity detail |
| GET | `/capacities/{capId}/workspaces` | ✅ 200 | `[{ workspaceObjectId, workspaceDisplayName, workspaceType }]` | Workspaces assigned to capacity |
| GET | `/capacities/{capId}/metrics` | ✅ 200 | `{ metrics, data }` | Utilization metrics |
| POST | `/capacities/new` | ✅ (from curl) | Creates capacity | Body: `{ displayName, adminsUpns: [upn], sku, region, mode: 1 }` |
| DELETE | `/capacities/{capId}` | ✅ 204 | Empty | Deletes capacity |

### NOT found (404) — may need different path patterns from portal sniffing:
`/capacities/{id}/settings`, `/capacities/{id}/delegates`, `/capacities/{id}/users`,
`/capacities/{id}/state`, `/capacities/{id}/resize`, `/capacities/{id}/suspend`, `/capacities/{id}/resume`

## Capacity Health Data Shape

From `capacitiesHealth[]` in the list+health response:

```json
{
  "timestamp": "2026-04-09T11:21:48Z",
  "capacityObjectId": "guid",
  "backgroundUtilization": 0.16,
  "interactiveUtilization": 0.0,
  "previewInteractiveUtilization": 0.0,
  "previewBackgroundUtilization": 0.0,
  "cumulativeCarryForward": 0.0,
  "interactiveDelayThrottlingPercentage": 0.0,
  "interactiveRejectionThrottlingPercentage": 0.0,
  "backgroundRejectionThrottlingPercentage": 0.0,
  "interactiveDelayRisk": false,
  "interactiveRejectionRisk": false,
  "backgroundRejectionRisk": false
}
```

## Capacity Metadata Shape

From `capacitiesMetadata[]`:

```json
{
  "capacityObjectId": "guid",
  "state": 1,
  "license": {
    "source": 1,
    "capacityPlan": "P1",
    "capacityNumberOfVCores": 8,
    "capacityMemoryInGB": 25,
    "region": "West Central US"
  },
  "configuration": {
    "displayName": "FMLVCapacity",
    "sku": "P1",
    "skuScale": 1,
    "mode": 1,
    "region": "West Central US"
  },
  "admins": [{ "displayName": "Admin1CBA", "userPrincipalName": "...", "objectId": "..." }],
  "creationDate": "ISO datetime",
  "cesClusterUrl": "...",
  "resourceGroup": "...",
  "subscriptionId": "..."
}
```

## SKU Catalog (from capacitiesMetadata — state=0 entries)

| SKU | vCores | Memory |
|-----|--------|--------|
| P1 | 8 | 25 GB |
| P2 | 16 | 50 GB |
| P3 | 32 | 100 GB |
| P4 | 64 | 200 GB |
| P5 | 128 | 400 GB |
| F2 | 1 | 1 GB |
| F4 | 1 | 2 GB |
| F8 | 1 | 3 GB |
| F16 | 2 | 3 GB |
| F32 | 4 | 5 GB |
| F64 | 8 | 25 GB |
| F128 | 16 | 50 GB |
| F256 | 32 | 100 GB |
| F512 | 64 | 200 GB |
| F1024 | 128 | 400 GB |
| F2048 | 256 | 400 GB |
| F4096 | 512 | 400 GB |
| F8192 | 1024 | 400 GB |
| FTL64 | 8 | 25 GB |

## v1.0 Capacity Endpoints (Power BI REST API)

| Method | Path | Status | Data |
|--------|------|--------|------|
| GET | `/v1.0/myorg/capacities` | ✅ 200 | 9 capacities with `id, displayName, admins, sku, state, region, users` |
| GET | `/v1.0/myorg/capacities/{id}/Workloads` | ✅ 200 | **64 workload configurations** per capacity |
| GET | `/v1.0/myorg/capacities/{id}/Refreshables` | ✅ 200 | Refresh/throttle data |
| GET | `/v1.0/myorg/capacities/refreshables` | ✅ 200 | All refreshables across capacities |
| GET | `/v1.0/myorg/admin/capacities` | ✅ 200 | Admin view of all capacities |
| POST | `/v1/workspaces/{wsId}/assignToCapacity` | ✅ 202 | Assign workspace to capacity. Body: `{ "capacityId": "guid" }` |
| POST | `/v1.0/myorg/groups/{wsId}/AssignToCapacity` | ✅ 200 | Same via v1.0 path |

---

# TABLE DETAILS & PREVIEW (Async LRO Pattern)

> **Tested:** 2026-04-09 | MwcToken on capacity host
> **Pattern:** POST → 202 with operationId → poll GET for result

## getTableDetails (single table schema/columns)

**Request:**
```
POST /webapi/.../artifacts/DataArtifact/{lhId}/getTableDetails
Authorization: MwcToken {mwcToken}
x-ms-workload-resource-moniker: {lhId}
x-ms-lakehouse-client-session-id: {uuid}

Body: { "relativePath": "Tables/dbo/{tableName}" }
```

**Response (202):** `{ "operationId": "guid" }`

**Poll result:**
```
GET /webapi/.../artifacts/DataArtifact/{lhId}/getTableDetails/operationResults/{operationId}
→ { "result": { "type": "MANAGED", "schema": [{ "name": "col", "type": "string", "nullable": true }] }, "status": "completed" }
```

## batchGetTableDetails (multiple tables)

**Request:**
```
POST /webapi/.../artifacts/DataArtifact/{lhId}/schemas/dbo/batchGetTableDetails
Body: { "tables": ["table1", "table2"] }
```
⚠️ Body must use `"tables"` NOT `"tableNames"` — the latter returns 400.

**Response:** 202 with operationId → poll for batch result.

## previewAsync (first N rows of data)

**Request:**
```
POST /webapi/.../artifacts/Lakehouse/{lhId}/schemas/dbo/tables/{tableName}/preview
Body: { "maxRows": 5 }
```

**Response (202):** `{ "operationId": "guid" }`
**Poll → result with actual row data.**

---

# SCHEDULED JOBS

> **Tested:** 2026-04-09 | Bearer token on redirect host

| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/metadata/artifacts/{lhId}/scheduledJobs` | ✅ 200 | FMLVWS TestLH has 5 scheduled jobs |
| POST | `/metadata/artifacts/{lhId}/scheduledJobs` | ✅ 200 | Created schedule on test LH |

**Schedule create body:**
```json
{
  "artifactJobType": "MaterializedLakeViews",
  "artifactObjectId": "lakehouse-guid",
  "scheduleEnabled": false,
  "scheduleType": 2,
  "cronPeriod": 3,
  "scheduleStartTime": "2026-04-09T14:00:00.000Z",
  "scheduleEndTime": "2026-04-10T14:00:00.000Z",
  "scheduleHours": "[14:00]",
  "localTimeZoneId": "India Standard Time",
  "scheduleWeekIndex": 1,
  "scheduleWeekdays": 127
}
```

**Rules:** POST when `jobDefinitionObjectId` is null (create new), PUT when it has a value (update existing).

---

# PORTAL METADATA APIs

> **Tested:** 2026-04-09 | Bearer token on redirect host
> **Source:** Network sniffing of Power BI admin portal

| Method | Path | Status | Data | Use In EDOG |
|--------|------|--------|------|-------------|
| GET | `/metadata/recent/?limit=100` | ✅ 200 | 56 items: `objectId, displayName, type, lastAccessedTime, ownerWorkspaceObjectId, ownerWorkspaceName` | Recent items in Workspace Explorer |
| GET | `/metadata/bootstrap/base` | ✅ 200 | `{ userSettings, branding, clientFeatureSwitches }` | Feature flags, user prefs |
| GET | `/metadata/notifications/summary` | ✅ 200 | `{ totalCount, unseenCount, notifications[] }` | Notification badge |
| GET | `/metadata/dataDomains` | ✅ 200 | `{ domains[] }` | Data organization |
| GET | `/metadata/trialcapacities` | ✅ 200 | `[{ capacityId, trialExpirationDateTime, sku }]` | Trial capacity info |
| GET | `/metadata/tenantsettings/selfserve/new` | ✅ 200 | `{ newSettings }` | Tenant config |
| GET | `/metadata/promoted` | ✅ 200 | `{ promotedDashboards, promotedReports, promotedApps }` | Promoted content |
| GET | `/metadata/recommendation` | ✅ 200 | `{ recommendedArtifacts }` | Recommendations |
| GET | `/metadata/licenseEligibility` | ✅/❌ | License info | — |
| GET | `/metadata/user/isModernCommerceAdmin` | ✅/❌ | Admin check | — |

### Recent Items Response Shape
```json
{
  "objectId": "guid",
  "displayName": "hodatestworkpsace",
  "type": 5,
  "url": "https://powerbi-df.../MobileRedirect.html?Action=OpenGroup&groupObjectId=...",
  "lastAccessedTime": "ISO datetime",
  "counOfAccesses": 12,
  "ownerWorkspaceObjectId": "guid",
  "ownerWorkspaceName": "workspace name"
}
```

---

# NOTEBOOK & ITEM CREATION

> **Tested:** 2026-04-09 | Bearer token on redirect host

| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/v1/workspaces/{wsId}/items` | ✅ 201 | Create any item type |

**Create notebook body:**
```json
{
  "displayName": "My Notebook",
  "type": "Notebook"
}
```

**Response:** `{ id, type, displayName, description, workspaceId }`

---

# DELETE OPERATIONS

> **Tested:** 2026-04-09

| Method | Path | Status | Notes |
|--------|------|--------|-------|
| DELETE | `/v1/workspaces/{wsId}/lakehouses/{lhId}` | ✅ 200 | Tested via create→delete cycle |
| DELETE | `/capacities/{capId}` | ✅ 204 | Deleted "aa" test capacity |
| DELETE | `/v1/workspaces/{wsId}` | ⚠️ Not tested | Destructive — tested rename instead |
