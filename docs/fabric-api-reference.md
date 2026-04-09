# Fabric API Endpoint Reference — EDOG Studio

> **Status:** 🟢 TESTED against live PPE environment (FabricFMLV08PPE tenant)
> **Date:** 2026-04-09
> **Token:** Bearer token (PBI audience: `analysis.windows-int.net/powerbi/api`)
> **Last Tested By:** Elena Voronova + Dev Patel

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

#### Tables Workaround Options
1. **Create a lakehouse WITHOUT schemas enabled** — then `/v1/.../tables` should work
2. **Use OneLake path** — lakehouse `properties.oneLakeTablesPath` gives the ADLS path; could list files via OneLake API
3. **Use SQL endpoint** — connect to `properties.sqlEndpointProperties.connectionString` and query `INFORMATION_SCHEMA.TABLES`
4. **Use metadata from DAG** — in connected mode, `getLatestDag` response contains table/MLV definitions

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

## Action Items

- [ ] Switch proxy to forward v1 paths directly (no rewriting to metadata paths) — eliminates normalization bugs
- [ ] Only use metadata path for workspace listing (for `capacityObjectId` and `lastUpdatedDate` not in v1)
- [ ] Handle tables 400 gracefully — show "Tables not available (schemas enabled)" in UI
- [ ] Test table listing with a non-schema lakehouse
- [ ] Consider Fabric-audience token acquisition for full public API access
