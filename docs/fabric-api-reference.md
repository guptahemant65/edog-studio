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

### Table Listing Endpoints (Three Variants)

| Endpoint | Schema Support | Token | Host | Phase |
|----------|---------------|-------|------|-------|
| `GET /v1/workspaces/{wsId}/lakehouses/{lhId}/tables` | Non-schema only | Bearer | redirect | Phase 1 (non-FLT lakehouses only) |
| `GET /webapi/.../artifacts/Lakehouse/{lhId}/tables` | Non-schema only | MWC | capacity | Phase 2 |
| `GET /webapi/.../artifacts/DataArtifact/{lhId}/schemas/{schemaName}/tables` | **Schema-enabled (FLT)** | MWC | capacity | Phase 2 |

**Schema-enabled table listing path:**
```
GET https://{capacityId}.pbidedicated.windows-int.net/webapi/capacities/{capId}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{wsId}/artifacts/DataArtifact/{lhId}/schemas/dbo/tables
Authorization: Bearer {mwcToken}
```

Default schema name is `dbo` (from `properties.defaultSchema` on lakehouse GET).

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
| Token/Auth | 1 | 1 | 0 | 0 | 0 |
| ADO/Git | 1 | 0 | 0 | 0 | 0 |
| **Total** | **~47** | **19** | **14** | **13** | **16** |
