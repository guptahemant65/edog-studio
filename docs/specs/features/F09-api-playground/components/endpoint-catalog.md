# Endpoint Catalog — Component Spec

> **Feature:** F09 API Playground — Phase 1, Component P1.3
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend) + Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `spec.md` §3, `research/p0-foundation.md` §3 (API catalog), `variables.css`, `api-playground.css`
> **Feeds Into:** `states/endpoint-catalog.md`, `architecture.md` §2, `api-playground.js`

---

## 1. Component Overview

The Endpoint Catalog is a **searchable combobox dropdown** that provides instant access to 37 pre-configured FLT and Fabric API endpoints. It sits in the Request Builder toolbar, left of the URL input. When an endpoint is selected, it auto-populates the Request Builder with the correct HTTP method, URL (with template variables), authorization headers, and body template.

**Design decision (D4 from P0):** Searchable dropdown with group headers — NOT a separate modal or sidebar. Quick access without losing context.

**Key behaviors:**

- Closed state: compact button showing current selection or placeholder
- Open state: full-height dropdown with search field, grouped endpoint list, keyboard navigation
- Fuzzy search across endpoint name, URL path, and group name
- Matching text highlighted in search results
- Destructive endpoints (DELETE, Force Unlock) marked with red danger indicator
- Selection auto-populates method, URL, headers, body template in Request Builder
- Keyboard-driven: arrow keys navigate, Enter selects, Escape closes, typing filters

**Endpoint count:** 37 endpoints across 10 groups.

---

## 2. Visual Specification

### 2.1 Closed State (Trigger Button)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────────┐ ┌─────────────────────────────────┐ ┌──────┐ │
│ │ ▸ Select endpoint...         ▾ │ │ /v1/workspaces/{workspaceId}    │ │ Send │ │
│ └──────────────────────────────────┘ └─────────────────────────────────┘ └──────┘ │
│   Endpoint Catalog trigger              URL input                       Send btn  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**With selection:**

```
┌──────────────────────────────────┐
│ GET  Get Workspace            ▾ │
│ ▏▏▏▏                            │
│  ↑ method pill (green)           │
└──────────────────────────────────┘
```

- **Width:** 260px
- **Height:** 32px (8 × `--space-1`)
- **Background:** `var(--surface-2)`
- **Border:** 1px solid `var(--border-bright)`
- **Border-radius:** `var(--radius-sm)` (4px)
- **Font:** `var(--font-body)`, `var(--text-sm)` (12px)
- **Padding:** `var(--space-1)` vertical, `var(--space-2)` horizontal
- **Chevron (▾):** Right-aligned, `var(--text-muted)`, 10px
- **Cursor:** `pointer`

### 2.2 Open State (Dropdown Panel)

```
┌──────────────────────────────────┐
│ GET  Get Workspace            ▾ │  ← trigger (highlighted border)
├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │
│ │ ◇ Search endpoints...       │ │  ← search input
│ └──────────────────────────────┘ │
│                                  │
│ WORKSPACE (5)                    │  ← group header + count badge
│ ├ GET  List Workspaces           │
│ ├ GET  Get Workspace         ◀── │  ← active/focused item
│ ├ POST Create Workspace          │
│ ├ PATCH Rename Workspace         │
│ └ DEL  Delete Workspace      ◆  │  ← danger indicator (red ◆)
│                                  │
│ ITEMS (3)                        │
│ ├ GET  List Items                │
│ ├ PATCH Rename Item              │
│ └ DEL  Delete Item           ◆  │
│                                  │
│ LAKEHOUSE (5)                    │
│ ├ GET  List Lakehouses           │
│ ├ GET  Get Lakehouse             │
│ ├ POST Create Lakehouse          │
│ ├ PATCH Rename Lakehouse         │
│ └ DEL  Delete Lakehouse      ◆  │
│                                  │
│ TABLES (4)                       │
│ ├ GET  List Tables               │
│ ├ GET  List Tables (Schema)      │
│ ├ POST Batch Table Details       │
│ └ POST Table Preview             │
│                                  │
│ ... (remaining groups scroll)    │
│                                  │
└──────────────────────────────────┘
```

- **Width:** 340px (wider than trigger to show full endpoint names)
- **Max height:** `min(480px, calc(100vh - 120px))` — never taller than viewport minus topbar + padding
- **Background:** `var(--surface)`
- **Border:** 1px solid `var(--border-bright)`
- **Border-radius:** `var(--radius-md)` (6px)
- **Shadow:** `var(--shadow-lg)`
- **Z-index:** `var(--z-dropdown)` (200)
- **Overflow-y:** `auto` (vertical scroll for long list)
- **Position:** absolute, anchored below trigger, left-aligned
- **Animation:** scale + fade in from top (see §5.3)

### 2.3 Search State (Filtered Results)

```
┌──────────────────────────────────┐
│ ┌──────────────────────────────┐ │
│ │ ◇ dag                       │ │  ← search query "dag"
│ └──────────────────────────────┘ │
│                                  │
│ DAG (6)                          │
│ ├ GET  Get Latest [DAG]          │  ← matched text highlighted
│ ├ POST Run [DAG]                 │
│ ├ POST Cancel [DAG]              │
│ ├ GET  Get [DAG] Exec Status     │
│ ├ GET  [DAG] Settings            │
│ └ PATCH Patch [DAG] Settings     │
│                                  │
│ MAINTENANCE (1)                  │  ← group filtered, count updated
│ └ POST Force Unlock [DAG]... ◆  │
│                                  │
│ 7 results                        │  ← result count footer
└──────────────────────────────────┘
```

### 2.4 Empty Search State

```
┌──────────────────────────────────┐
│ ┌──────────────────────────────┐ │
│ │ ◇ xyznonexistent            │ │
│ └──────────────────────────────┘ │
│                                  │
│         No endpoints found       │
│     Try a different search term  │
│                                  │
└──────────────────────────────────┘
```

---

## 3. Data Model

### 3.1 Endpoint Definition Schema

```jsonc
{
  "id": "string",               // unique kebab-case identifier (e.g. "get-workspace")
  "name": "string",             // display name (e.g. "Get Workspace")
  "method": "GET|POST|PUT|PATCH|DELETE",
  "url": "string",              // URL with template variables (e.g. "/v1/workspaces/{workspaceId}")
  "group": "string",            // group identifier (e.g. "Workspace")
  "token": "bearer|mwc|none",   // auth scheme
  "bodyTemplate": null | {},    // JSON body template for POST/PUT/PATCH; null for GET/DELETE
  "description": "string",      // short explanation of what the endpoint does
  "responseHint": "string",     // expected response shape description
  "dangerLevel": "safe|caution|destructive"  // visual indicator level
}
```

### 3.2 Group Definition

```jsonc
{
  "id": "string",         // kebab-case (e.g. "workspace")
  "label": "string",      // display label (e.g. "Workspace")
  "order": 0,             // sort order in catalog
  "collapsed": false       // default collapsed state (runtime)
}
```

### 3.3 Complete Endpoint Catalog — All 37 Endpoints

```jsonc
[
  // ═══════════════════════════════════════════════════
  // GROUP: Workspace (5 endpoints) — Fabric APIs, Bearer token
  // ═══════════════════════════════════════════════════
  {
    "id": "list-workspaces",
    "name": "List Workspaces",
    "method": "GET",
    "url": "/v1.0/myorg/groups",
    "group": "Workspace",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List all workspaces accessible to the current user",
    "responseHint": "{ value: [{ id, name, type, state }] }",
    "dangerLevel": "safe"
  },
  {
    "id": "get-workspace",
    "name": "Get Workspace",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}",
    "group": "Workspace",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Get details of a specific workspace by ID",
    "responseHint": "{ id, displayName, description, type, state, capacityId }",
    "dangerLevel": "safe"
  },
  {
    "id": "create-workspace",
    "name": "Create Workspace",
    "method": "POST",
    "url": "/metadata/folders",
    "group": "Workspace",
    "token": "bearer",
    "bodyTemplate": {
      "displayName": "My Workspace",
      "description": ""
    },
    "description": "Create a new workspace",
    "responseHint": "{ id, displayName, description, type, state }",
    "dangerLevel": "caution"
  },
  {
    "id": "rename-workspace",
    "name": "Rename Workspace",
    "method": "PATCH",
    "url": "/v1/workspaces/{workspaceId}",
    "group": "Workspace",
    "token": "bearer",
    "bodyTemplate": {
      "displayName": "New Workspace Name"
    },
    "description": "Rename an existing workspace",
    "responseHint": "{ id, displayName }",
    "dangerLevel": "caution"
  },
  {
    "id": "delete-workspace",
    "name": "Delete Workspace",
    "method": "DELETE",
    "url": "/v1/workspaces/{workspaceId}",
    "group": "Workspace",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Permanently delete a workspace and all its contents",
    "responseHint": "204 No Content",
    "dangerLevel": "destructive"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Items (3 endpoints) — Fabric APIs, Bearer token
  // ═══════════════════════════════════════════════════
  {
    "id": "list-items",
    "name": "List Items",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/items",
    "group": "Items",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List all items in a workspace",
    "responseHint": "{ value: [{ id, displayName, type, description }] }",
    "dangerLevel": "safe"
  },
  {
    "id": "rename-item",
    "name": "Rename Item",
    "method": "PATCH",
    "url": "/v1/workspaces/{workspaceId}/items/{itemId}",
    "group": "Items",
    "token": "bearer",
    "bodyTemplate": {
      "displayName": "New Item Name"
    },
    "description": "Rename an item in a workspace",
    "responseHint": "{ id, displayName, type }",
    "dangerLevel": "caution"
  },
  {
    "id": "delete-item",
    "name": "Delete Item",
    "method": "DELETE",
    "url": "/v1/workspaces/{workspaceId}/items/{itemId}",
    "group": "Items",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Permanently delete an item from a workspace",
    "responseHint": "204 No Content",
    "dangerLevel": "destructive"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Lakehouse (5 endpoints) — Fabric APIs, Bearer token
  // ═══════════════════════════════════════════════════
  {
    "id": "list-lakehouses",
    "name": "List Lakehouses",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/lakehouses",
    "group": "Lakehouse",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List all lakehouses in a workspace",
    "responseHint": "{ value: [{ id, displayName, description, properties }] }",
    "dangerLevel": "safe"
  },
  {
    "id": "get-lakehouse",
    "name": "Get Lakehouse",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}",
    "group": "Lakehouse",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Get details of a specific lakehouse",
    "responseHint": "{ id, displayName, description, properties: { oneLakeTablesPath, oneLakeFilesPath, sqlEndpointProperties } }",
    "dangerLevel": "safe"
  },
  {
    "id": "create-lakehouse",
    "name": "Create Lakehouse",
    "method": "POST",
    "url": "/v1/workspaces/{workspaceId}/lakehouses",
    "group": "Lakehouse",
    "token": "bearer",
    "bodyTemplate": {
      "displayName": "My Lakehouse",
      "description": ""
    },
    "description": "Create a new lakehouse in a workspace",
    "responseHint": "{ id, displayName, description, type }",
    "dangerLevel": "caution"
  },
  {
    "id": "rename-lakehouse",
    "name": "Rename Lakehouse",
    "method": "PATCH",
    "url": "/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}",
    "group": "Lakehouse",
    "token": "bearer",
    "bodyTemplate": {
      "displayName": "New Lakehouse Name"
    },
    "description": "Rename an existing lakehouse",
    "responseHint": "{ id, displayName }",
    "dangerLevel": "caution"
  },
  {
    "id": "delete-lakehouse",
    "name": "Delete Lakehouse",
    "method": "DELETE",
    "url": "/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}",
    "group": "Lakehouse",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Permanently delete a lakehouse and all its data",
    "responseHint": "204 No Content",
    "dangerLevel": "destructive"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Tables (4 endpoints) — Mixed token types
  // ═══════════════════════════════════════════════════
  {
    "id": "list-tables",
    "name": "List Tables",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables",
    "group": "Tables",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List all tables in a lakehouse (Fabric REST API)",
    "responseHint": "{ value: [{ name, format, location }] }",
    "dangerLevel": "safe"
  },
  {
    "id": "list-tables-schema",
    "name": "List Tables (Schema)",
    "method": "GET",
    "url": "{fabricBaseUrl}/DataArtifact/{lakehouseId}/schemas/dbo/tables",
    "group": "Tables",
    "token": "mwc",
    "bodyTemplate": null,
    "description": "List all tables with schema details via capacity host",
    "responseHint": "[{ name, schema, columns: [{ name, dataType, isNullable }] }]",
    "dangerLevel": "safe"
  },
  {
    "id": "batch-table-details",
    "name": "Batch Table Details",
    "method": "POST",
    "url": "{fabricBaseUrl}/DataArtifact/{lakehouseId}/schemas/dbo/batchGetTableDetails",
    "group": "Tables",
    "token": "mwc",
    "bodyTemplate": {
      "tableNames": ["table1", "table2"]
    },
    "description": "Get detailed metadata for multiple tables in a single request",
    "responseHint": "[{ name, rowCount, sizeBytes, lastModified, columns }]",
    "dangerLevel": "safe"
  },
  {
    "id": "table-preview",
    "name": "Table Preview",
    "method": "POST",
    "url": "{fabricBaseUrl}/Lakehouse/{lakehouseId}/tables/{tableName}/previewAsync",
    "group": "Tables",
    "token": "mwc",
    "bodyTemplate": {
      "maxRows": 100
    },
    "description": "Preview rows from a lakehouse table",
    "responseHint": "{ schema: { columns }, data: [[row values]] }",
    "dangerLevel": "safe"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Notebooks (5 endpoints) — Fabric APIs, Bearer token
  // ═══════════════════════════════════════════════════
  {
    "id": "list-notebooks",
    "name": "List Notebooks",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/notebooks",
    "group": "Notebooks",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List all notebooks in a workspace",
    "responseHint": "{ value: [{ id, displayName, description }] }",
    "dangerLevel": "safe"
  },
  {
    "id": "get-notebook",
    "name": "Get Notebook",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/notebooks/{notebookId}",
    "group": "Notebooks",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Get details of a specific notebook",
    "responseHint": "{ id, displayName, description, properties }",
    "dangerLevel": "safe"
  },
  {
    "id": "create-notebook",
    "name": "Create Notebook",
    "method": "POST",
    "url": "/v1/workspaces/{workspaceId}/notebooks",
    "group": "Notebooks",
    "token": "bearer",
    "bodyTemplate": {
      "displayName": "My Notebook",
      "description": ""
    },
    "description": "Create a new notebook in a workspace",
    "responseHint": "{ id, displayName, description, type }",
    "dangerLevel": "caution"
  },
  {
    "id": "delete-notebook",
    "name": "Delete Notebook",
    "method": "DELETE",
    "url": "/v1/workspaces/{workspaceId}/notebooks/{notebookId}",
    "group": "Notebooks",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "Permanently delete a notebook",
    "responseHint": "204 No Content",
    "dangerLevel": "destructive"
  },
  {
    "id": "run-notebook",
    "name": "Run Notebook",
    "method": "POST",
    "url": "/v1/workspaces/{workspaceId}/items/{notebookId}/jobs/instances?jobType=RunNotebook",
    "group": "Notebooks",
    "token": "bearer",
    "bodyTemplate": {
      "executionData": {}
    },
    "description": "Trigger a notebook execution job",
    "responseHint": "202 Accepted — Location header with job status URL",
    "dangerLevel": "caution"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Environment (1 endpoint) — Fabric APIs, Bearer token
  // ═══════════════════════════════════════════════════
  {
    "id": "list-environments",
    "name": "List Environments",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/environments",
    "group": "Environment",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List all Spark environments in a workspace",
    "responseHint": "{ value: [{ id, displayName, description, properties }] }",
    "dangerLevel": "safe"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: DAG (6 endpoints) — FLT Service APIs, MWC token
  // ═══════════════════════════════════════════════════
  {
    "id": "get-latest-dag",
    "name": "Get Latest DAG",
    "method": "GET",
    "url": "{fabricBaseUrl}/liveTable/getLatestDag?showExtendedLineage=true",
    "group": "DAG",
    "token": "mwc",
    "bodyTemplate": null,
    "description": "Retrieve the latest DAG definition with full lineage",
    "responseHint": "{ dagVersion, nodes: [{ id, name, type, status, dependencies }], edges }",
    "dangerLevel": "safe"
  },
  {
    "id": "run-dag",
    "name": "Run DAG",
    "method": "POST",
    "url": "{fabricBaseUrl}/liveTableSchedule/runDAG/{iterationId}",
    "group": "DAG",
    "token": "mwc",
    "bodyTemplate": {},
    "description": "Trigger a full DAG execution with the given iteration ID",
    "responseHint": "202 Accepted",
    "dangerLevel": "caution"
  },
  {
    "id": "cancel-dag",
    "name": "Cancel DAG",
    "method": "POST",
    "url": "{fabricBaseUrl}/liveTableSchedule/cancelDAG/{iterationId}",
    "group": "DAG",
    "token": "mwc",
    "bodyTemplate": {},
    "description": "Cancel a running DAG execution",
    "responseHint": "200 OK",
    "dangerLevel": "caution"
  },
  {
    "id": "get-dag-exec-status",
    "name": "Get DAG Exec Status",
    "method": "GET",
    "url": "{fabricBaseUrl}/liveTableSchedule/getDAGExecStatus/{iterationId}",
    "group": "DAG",
    "token": "mwc",
    "bodyTemplate": null,
    "description": "Get execution status and node-level progress for a DAG run",
    "responseHint": "{ iterationId, status, nodeStatuses: [{ nodeId, status, startTime, endTime }] }",
    "dangerLevel": "safe"
  },
  {
    "id": "dag-settings",
    "name": "DAG Settings",
    "method": "GET",
    "url": "{fabricBaseUrl}/liveTable/settings",
    "group": "DAG",
    "token": "mwc",
    "bodyTemplate": null,
    "description": "Retrieve current DAG configuration settings",
    "responseHint": "{ refreshInterval, maxConcurrency, retryPolicy, timeoutMinutes }",
    "dangerLevel": "safe"
  },
  {
    "id": "patch-dag-settings",
    "name": "Patch DAG Settings",
    "method": "PATCH",
    "url": "{fabricBaseUrl}/liveTable/patchDagSettings",
    "group": "DAG",
    "token": "mwc",
    "bodyTemplate": {
      "refreshInterval": "PT1H",
      "maxConcurrency": 5
    },
    "description": "Update DAG configuration settings (partial update)",
    "responseHint": "200 OK — updated settings object",
    "dangerLevel": "caution"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Maintenance (2 endpoints) — MWC token
  // ═══════════════════════════════════════════════════
  {
    "id": "force-unlock-dag",
    "name": "Force Unlock DAG",
    "method": "POST",
    "url": "{fabricBaseUrl}/liveTableMaintenance/forceUnlockDAGExecution",
    "group": "Maintenance",
    "token": "mwc",
    "bodyTemplate": {},
    "description": "Force-release the DAG execution lock. USE WITH EXTREME CAUTION — may cause data corruption if a DAG is actually running",
    "responseHint": "200 OK — { unlocked: true }",
    "dangerLevel": "destructive"
  },
  {
    "id": "list-orphaned-folders",
    "name": "List Orphaned Folders",
    "method": "GET",
    "url": "{fabricBaseUrl}/liveTableMaintenance/listOrphanedIndexFolders",
    "group": "Maintenance",
    "token": "mwc",
    "bodyTemplate": null,
    "description": "List OneLake index folders that are no longer referenced by any MLV",
    "responseHint": "[{ path, sizeBytes, lastModified }]",
    "dangerLevel": "safe"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Spark (2 endpoints) — Mixed token types
  // ═══════════════════════════════════════════════════
  {
    "id": "spark-settings",
    "name": "Spark Settings",
    "method": "GET",
    "url": "{fabricBaseUrl}/SparkCoreService/v2.0/workspaces/{workspaceId}/sparkSettings",
    "group": "Spark",
    "token": "mwc",
    "bodyTemplate": null,
    "description": "Get Spark pool configuration settings for the workspace",
    "responseHint": "{ automaticLog, environment, pool: { name, type, nodeFamily, nodeSize } }",
    "dangerLevel": "safe"
  },
  {
    "id": "list-livy-sessions",
    "name": "List Livy Sessions",
    "method": "GET",
    "url": "/v1/workspaces/{workspaceId}/spark/livySessions",
    "group": "Spark",
    "token": "bearer",
    "bodyTemplate": null,
    "description": "List active Spark Livy sessions in the workspace",
    "responseHint": "{ value: [{ id, name, state, appId, livyId, submittedAt }] }",
    "dangerLevel": "safe"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Auth/EDOG (3 endpoints) — Mixed
  // ═══════════════════════════════════════════════════
  {
    "id": "generate-mwc-token",
    "name": "Generate MWC Token",
    "method": "POST",
    "url": "/metadata/v201606/generatemwctoken",
    "group": "Auth/EDOG",
    "token": "bearer",
    "bodyTemplate": {
      "resourceId": "{capacityId}"
    },
    "description": "Generate a new MWC (Mid-tier Web Client) token for capacity host access",
    "responseHint": "{ token, expiresOn }",
    "dangerLevel": "safe"
  },
  {
    "id": "get-config",
    "name": "Get Config",
    "method": "GET",
    "url": "/api/flt/config",
    "group": "Auth/EDOG",
    "token": "none",
    "bodyTemplate": null,
    "description": "Get EDOG runtime configuration — workspace ID, artifact ID, tokens, phase",
    "responseHint": "{ workspaceId, artifactId, capacityId, mwcToken, bearerToken, phase }",
    "dangerLevel": "safe"
  },
  {
    "id": "health-check",
    "name": "Health Check",
    "method": "GET",
    "url": "/api/edog/health",
    "group": "Auth/EDOG",
    "token": "none",
    "bodyTemplate": null,
    "description": "Check EDOG server health — token status, git info, uptime",
    "responseHint": "{ hasBearerToken, bearerExpiresIn, lastUsername, gitBranch, gitDirtyFiles }",
    "dangerLevel": "safe"
  },

  // ═══════════════════════════════════════════════════
  // GROUP: Health (1 endpoint) — FLT ping
  // ═══════════════════════════════════════════════════
  {
    "id": "ping-flt",
    "name": "Ping FLT",
    "method": "GET",
    "url": "{fabricBaseUrl}/publicUnprotected/ping",
    "group": "Health",
    "token": "none",
    "bodyTemplate": null,
    "description": "Health check ping to FLT service — no auth required",
    "responseHint": "\"pong\" (text/plain)",
    "dangerLevel": "safe"
  }
]
```

### 3.4 Group Registry

| Order | Group ID       | Label        | Count | Token Type(s)  |
|-------|----------------|--------------|-------|----------------|
| 0     | `workspace`    | Workspace    | 5     | bearer         |
| 1     | `items`        | Items        | 3     | bearer         |
| 2     | `lakehouse`    | Lakehouse    | 5     | bearer         |
| 3     | `tables`       | Tables       | 4     | bearer, mwc    |
| 4     | `notebooks`    | Notebooks    | 5     | bearer         |
| 5     | `environment`  | Environment  | 1     | bearer         |
| 6     | `dag`          | DAG          | 6     | mwc            |
| 7     | `maintenance`  | Maintenance  | 2     | mwc            |
| 8     | `spark`        | Spark        | 2     | bearer, mwc    |
| 9     | `auth-edog`    | Auth/EDOG    | 3     | bearer, none   |
| 10    | `health`       | Health       | 1     | none           |

### 3.5 Danger Level Classification

| Level        | Endpoints                                                         | Count | Visual Treatment                 |
|--------------|-------------------------------------------------------------------|-------|----------------------------------|
| `safe`       | All GET endpoints, Generate MWC Token, Batch Table Details, Table Preview | 24    | No indicator                     |
| `caution`    | Create/Rename/PATCH endpoints, Run/Cancel DAG, Run Notebook       | 8     | None (method color suffices)     |
| `destructive`| Delete Workspace, Delete Item, Delete Lakehouse, Delete Notebook, Force Unlock DAG | 5 | Red ◆ danger indicator |

---

## 4. DOM Structure

### 4.1 Complete HTML Structure

```html
<div class="ec"
     role="combobox"
     aria-expanded="false"
     aria-haspopup="listbox"
     aria-owns="ec-listbox"
     aria-label="Endpoint catalog">

  <!-- Trigger button -->
  <button class="ec-trigger"
          type="button"
          aria-controls="ec-listbox"
          aria-activedescendant="">
    <span class="ec-trigger-method">
      <!-- method pill rendered when endpoint selected -->
    </span>
    <span class="ec-trigger-label">Select endpoint...</span>
    <span class="ec-trigger-chevron" aria-hidden="true">▾</span>
  </button>

  <!-- Dropdown panel (hidden when closed) -->
  <div class="ec-dropdown" role="dialog" aria-label="Endpoint search">

    <!-- Search input -->
    <div class="ec-search-wrap">
      <span class="ec-search-icon" aria-hidden="true">◇</span>
      <input class="ec-search"
             type="text"
             role="searchbox"
             aria-label="Search endpoints"
             placeholder="Search endpoints..."
             autocomplete="off"
             spellcheck="false" />
      <button class="ec-search-clear" aria-label="Clear search" hidden>✕</button>
    </div>

    <!-- Endpoint list -->
    <ul class="ec-list" role="listbox" id="ec-listbox" aria-label="Endpoints">

      <!-- Group: Workspace -->
      <li class="ec-group" role="presentation">
        <button class="ec-group-header"
                role="presentation"
                aria-expanded="true"
                data-group="workspace">
          <span class="ec-group-chevron" aria-hidden="true">▸</span>
          <span class="ec-group-label">Workspace</span>
          <span class="ec-group-count">5</span>
        </button>
        <ul class="ec-group-items" role="group" aria-label="Workspace endpoints">
          <li class="ec-item"
              role="option"
              id="ec-opt-list-workspaces"
              data-endpoint-id="list-workspaces"
              aria-selected="false">
            <span class="ec-item-method method-pill get">GET</span>
            <span class="ec-item-name">List Workspaces</span>
          </li>
          <li class="ec-item"
              role="option"
              id="ec-opt-get-workspace"
              data-endpoint-id="get-workspace"
              aria-selected="false">
            <span class="ec-item-method method-pill get">GET</span>
            <span class="ec-item-name">Get Workspace</span>
          </li>
          <li class="ec-item"
              role="option"
              id="ec-opt-create-workspace"
              data-endpoint-id="create-workspace"
              aria-selected="false">
            <span class="ec-item-method method-pill post">POST</span>
            <span class="ec-item-name">Create Workspace</span>
          </li>
          <li class="ec-item"
              role="option"
              id="ec-opt-rename-workspace"
              data-endpoint-id="rename-workspace"
              aria-selected="false">
            <span class="ec-item-method method-pill patch">PATCH</span>
            <span class="ec-item-name">Rename Workspace</span>
          </li>
          <li class="ec-item ec-item--destructive"
              role="option"
              id="ec-opt-delete-workspace"
              data-endpoint-id="delete-workspace"
              aria-selected="false">
            <span class="ec-item-method method-pill delete">DEL</span>
            <span class="ec-item-name">Delete Workspace</span>
            <span class="ec-item-danger" aria-label="Destructive operation" title="Destructive — cannot be undone">◆</span>
          </li>
        </ul>
      </li>

      <!-- (Remaining groups follow identical structure) -->
      <!-- Groups: Items, Lakehouse, Tables, Notebooks, Environment, -->
      <!--         DAG, Maintenance, Spark, Auth/EDOG, Health        -->

    </ul>

    <!-- Footer (visible during search) -->
    <div class="ec-footer" aria-live="polite">
      <span class="ec-result-count">37 endpoints</span>
    </div>

    <!-- Empty state -->
    <div class="ec-empty" hidden>
      <span class="ec-empty-text">No endpoints found</span>
      <span class="ec-empty-hint">Try a different search term</span>
    </div>

  </div>
</div>
```

### 4.2 Class Name Index

| Class                   | Element     | Purpose                                    |
|-------------------------|-------------|--------------------------------------------|
| `.ec`                   | `div`       | Root combobox container                    |
| `.ec-trigger`           | `button`    | Dropdown trigger button                    |
| `.ec-trigger-method`    | `span`      | Method pill in trigger (when selected)     |
| `.ec-trigger-label`     | `span`      | Endpoint name or placeholder text          |
| `.ec-trigger-chevron`   | `span`      | Dropdown arrow indicator                   |
| `.ec-dropdown`          | `div`       | Dropdown panel container                   |
| `.ec-search-wrap`       | `div`       | Search input wrapper                       |
| `.ec-search-icon`       | `span`      | Search icon (◇)                            |
| `.ec-search`            | `input`     | Search text input                          |
| `.ec-search-clear`      | `button`    | Clear search button (✕)                    |
| `.ec-list`              | `ul`        | Scrollable endpoint list                   |
| `.ec-group`             | `li`        | Group container                            |
| `.ec-group-header`      | `button`    | Collapsible group header                   |
| `.ec-group-chevron`     | `span`      | Group expand/collapse arrow (▸/▾)          |
| `.ec-group-label`       | `span`      | Group name text                            |
| `.ec-group-count`       | `span`      | Endpoint count badge                       |
| `.ec-group-items`       | `ul`        | Group's endpoint list                      |
| `.ec-item`              | `li`        | Single endpoint row                        |
| `.ec-item--destructive` | modifier    | Destructive endpoint variant               |
| `.ec-item-method`       | `span`      | Method pill (reuses `.method-pill`)        |
| `.ec-item-name`         | `span`      | Endpoint display name                      |
| `.ec-item-danger`       | `span`      | Danger indicator (◆)                       |
| `.ec-footer`            | `div`       | Result count footer                        |
| `.ec-result-count`      | `span`      | "N results" / "N endpoints" text           |
| `.ec-empty`             | `div`       | Empty search state container               |
| `.ec-empty-text`        | `span`      | "No endpoints found" message               |
| `.ec-empty-hint`        | `span`      | "Try a different search term" hint         |

### 4.3 Data Attributes

| Attribute               | On            | Values                           | Purpose                        |
|-------------------------|---------------|----------------------------------|--------------------------------|
| `data-endpoint-id`      | `.ec-item`    | endpoint `id` from catalog       | Links DOM to data model        |
| `data-group`            | `.ec-group-header` | group `id`                  | Group identity for collapse    |
| `data-danger`           | `.ec-item`    | `"destructive"` or absent        | Danger level flag              |
| `data-active`           | `.ec-item`    | `""` (boolean attribute)         | Keyboard-focused item          |

---

## 5. CSS Specification

### 5.1 Trigger Button

```css
.ec {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.ec-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 260px;
  height: 32px;
  padding: 0 var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--text);
  cursor: pointer;
  transition: border-color var(--transition-fast);
  user-select: none;
}

.ec-trigger:hover {
  border-color: var(--accent);
}

.ec-trigger:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
}

[aria-expanded="true"] > .ec-trigger {
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
}

.ec-trigger-method {
  flex-shrink: 0;
}

.ec-trigger-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.ec-trigger-label:empty::before {
  content: "Select endpoint...";
  color: var(--text-muted);
}

.ec-trigger-chevron {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

[aria-expanded="true"] .ec-trigger-chevron {
  transform: rotate(180deg);
}
```

### 5.2 Dropdown Panel

```css
.ec-dropdown {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  width: 340px;
  max-height: min(480px, calc(100vh - 120px));
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-dropdown);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Hidden state (default) */
.ec:not([aria-expanded="true"]) .ec-dropdown {
  display: none;
}

/* Entrance animation (see §5.3) */
.ec-dropdown[data-entering] {
  animation: ec-slide-in 120ms ease-out;
}

.ec-dropdown[data-exiting] {
  animation: ec-slide-out 80ms ease-in;
}
```

### 5.3 Dropdown Animation

```css
@keyframes ec-slide-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes ec-slide-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}

/* Respect reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  .ec-dropdown[data-entering],
  .ec-dropdown[data-exiting] {
    animation: none;
  }
}
```

### 5.4 Search Input

```css
.ec-search-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.ec-search-icon {
  flex-shrink: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.ec-search {
  flex: 1;
  border: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--text);
  outline: none;
}

.ec-search::placeholder {
  color: var(--text-muted);
}

.ec-search-clear {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  line-height: 1;
}

.ec-search-clear:hover {
  color: var(--text);
  background: var(--surface-2);
}
```

### 5.5 Endpoint List and Scroll

```css
.ec-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-1) 0;
  list-style: none;
  overscroll-behavior: contain;
}

/* Scrollbar styling */
.ec-list::-webkit-scrollbar {
  width: 6px;
}

.ec-list::-webkit-scrollbar-track {
  background: transparent;
}

.ec-list::-webkit-scrollbar-thumb {
  background: var(--border-bright);
  border-radius: 3px;
}
```

### 5.6 Group Headers

```css
.ec-group {
  list-style: none;
}

.ec-group + .ec-group {
  margin-top: var(--space-1);
}

.ec-group-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-3);
  background: none;
  border: none;
  cursor: pointer;
  user-select: none;
}

.ec-group-header:hover {
  background: var(--surface-2);
}

.ec-group-chevron {
  flex-shrink: 0;
  font-size: 8px;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
  width: 12px;
  text-align: center;
}

.ec-group-header[aria-expanded="true"] .ec-group-chevron {
  transform: rotate(90deg);
}

.ec-group-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.ec-group-count {
  font-size: 9px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--surface-3);
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  min-width: 16px;
  text-align: center;
  line-height: 16px;
}

.ec-group-items {
  list-style: none;
  overflow: hidden;
}

.ec-group-header[aria-expanded="false"] + .ec-group-items {
  display: none;
}
```

### 5.7 Endpoint Items

```css
.ec-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  padding-left: var(--space-6);
  cursor: pointer;
  transition: background var(--transition-fast);
  min-height: var(--row-height);
}

.ec-item:hover,
.ec-item[data-active] {
  background: var(--accent-hover);
}

.ec-item[data-active] {
  background: var(--accent-dim);
}

.ec-item[aria-selected="true"] {
  background: var(--accent-dim);
  font-weight: 500;
}

.ec-item-method {
  flex-shrink: 0;
  width: 42px;
  text-align: center;
}

.ec-item-name {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ec-item-danger {
  flex-shrink: 0;
  color: var(--level-error);
  font-size: 8px;
  margin-left: auto;
}
```

### 5.8 Method Pill Colors

Reuses the existing `.method-pill` class from `spark.css`, plus adds PATCH:

```css
/* Already defined in spark.css — reused here: */
/* .method-pill.get   → green  (--status-succeeded bg) */
/* .method-pill.post  → blue   (--comp-controller bg)  */
/* .method-pill.put   → orange (--level-warning bg)    */
/* .method-pill.delete → red   (--level-error bg)      */

/* NEW: PATCH pill — yellow */
.method-pill.patch {
  background: rgba(217, 119, 6, 0.12);
  color: var(--level-warning);
}

/* Destructive item row tint */
.ec-item--destructive {
  border-left: 2px solid var(--level-error);
}
```

**Method → CSS class mapping:**

| Method   | Class           | Background                          | Text Color              |
|----------|-----------------|-------------------------------------|-------------------------|
| `GET`    | `.method-pill.get`    | `rgba(5,150,105,0.12)`        | `var(--status-succeeded)` |
| `POST`   | `.method-pill.post`   | `rgba(37,99,235,0.12)`        | `var(--comp-controller)`  |
| `PUT`    | `.method-pill.put`    | `rgba(217,119,6,0.12)`        | `var(--level-warning)`    |
| `PATCH`  | `.method-pill.patch`  | `rgba(217,119,6,0.12)`        | `var(--level-warning)`    |
| `DELETE` | `.method-pill.delete` | `rgba(220,38,38,0.12)`        | `var(--level-error)`      |

**Method → Display text mapping:**

| Method   | Pill Text |
|----------|-----------|
| `GET`    | `GET`     |
| `POST`   | `POST`    |
| `PUT`    | `PUT`     |
| `PATCH`  | `PATCH`   |
| `DELETE` | `DEL`     |

### 5.9 Search Highlight

```css
.ec-item-name mark {
  background: var(--accent-dim);
  color: var(--accent);
  border-radius: 2px;
  padding: 0 1px;
  font-weight: 600;
}
```

### 5.10 Footer and Empty State

```css
.ec-footer {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.ec-result-count {
  font-variant-numeric: tabular-nums;
}

.ec-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-8) var(--space-4);
}

.ec-empty-text {
  font-size: var(--text-sm);
  color: var(--text-dim);
  font-weight: 500;
}

.ec-empty-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
}
```

---

## 6. Search Behavior

### 6.1 Search Algorithm

**Type:** Case-insensitive substring match across multiple fields. NOT fuzzy — exact substring matching with multi-field OR logic.

**Fields searched (priority order):**

1. `name` — endpoint display name (e.g., "Get Workspace")
2. `url` — endpoint URL path (e.g., "/v1/workspaces")
3. `group` — group label (e.g., "Workspace")
4. `description` — endpoint description text

**Match logic:** An endpoint matches if the search query appears as a substring in ANY of the four fields. The match is case-insensitive.

```javascript
_matchesSearch(endpoint, query) {
  const q = query.toLowerCase();
  return (
    endpoint.name.toLowerCase().includes(q) ||
    endpoint.url.toLowerCase().includes(q) ||
    endpoint.group.toLowerCase().includes(q) ||
    endpoint.description.toLowerCase().includes(q)
  );
}
```

### 6.2 Search Input Behavior

| Event             | Action                                                |
|-------------------|-------------------------------------------------------|
| `input` (typing)  | Filter list after 0ms debounce (instant)              |
| Clear button (✕)  | Clear search, show all endpoints, refocus input       |
| Escape            | If search has text: clear search. If empty: close dropdown |

### 6.3 Highlight Matched Text

When a search query is active, matched substrings in the endpoint `name` field are wrapped in `<mark>` tags:

```javascript
_highlightMatch(name, query) {
  if (!query) return name;
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return name;
  const before = name.slice(0, idx);
  const match = name.slice(idx, idx + query.length);
  const after = name.slice(idx + query.length);
  return `${before}<mark>${match}</mark>${after}`;
}
```

**Example:** Query `"dag"` on "Get Latest DAG" produces:

```html
<span class="ec-item-name">Get Latest <mark>DAG</mark></span>
```

### 6.4 Group Filtering During Search

- Groups with zero matching endpoints are **hidden entirely** (not shown with empty state)
- Group count badges update to show filtered count (e.g., "DAG (4)" → "DAG (2)" when filtered)
- All groups are forced **expanded** during active search (collapsed state is ignored)
- When search is cleared, groups return to their previous collapsed/expanded state

### 6.5 Result Count Footer

- **No search active:** `"37 endpoints"` (total count)
- **Search active with results:** `"7 results"` (filtered count)
- **Search active with no results:** Footer hidden; empty state shown instead

### 6.6 Performance

The catalog has only 37 entries — no virtualization or debounce needed. Full DOM filter on every keystroke is acceptable at this scale.

---

## 7. Selection Behavior

### 7.1 Selection Trigger

An endpoint can be selected by:

1. **Click** on an `.ec-item` row
2. **Enter key** when an item has keyboard focus (`[data-active]`)
3. **No double-click** — single interaction selects

### 7.2 Auto-Populate Sequence

When endpoint `E` is selected, the following fields in the Request Builder are populated in order:

| #  | Request Builder Field | Source                              | Example                                            |
|----|-----------------------|-------------------------------------|-----------------------------------------------------|
| 1  | Method selector       | `E.method`                          | `GET`, `POST`, `PATCH`, `DELETE`                    |
| 2  | URL input             | `E.url` (raw, with template vars)   | `/v1/workspaces/{workspaceId}`                      |
| 3  | Authorization header  | Derived from `E.token`              | `Bearer {bearerToken}` or `MwcToken {mwcToken}`     |
| 4  | Content-Type header   | Derived from `E.bodyTemplate`       | `application/json` if body exists, omit if null     |
| 5  | Body editor           | `JSON.stringify(E.bodyTemplate, null, 2)` | Pretty-printed JSON template                  |
| 6  | Body section visible  | `E.bodyTemplate !== null`           | Show body editor for POST/PUT/PATCH, hide for GET/DELETE |

### 7.3 Token Resolution

| `E.token` Value | Auth Header Value                              | Phase Required     |
|------------------|-------------------------------------------------|--------------------|
| `"bearer"`       | `Authorization: Bearer {bearerToken}`           | Any (P1 or P2)     |
| `"mwc"`          | `Authorization: MwcToken {mwcToken}`            | Connected (P2)     |
| `"none"`         | No Authorization header added                   | Any                |

**Template variable expansion:** `{bearerToken}` and `{mwcToken}` are left as literal template strings in the header value. The Template Variable Resolver (separate component) expands them from the config before sending. This lets users see and override the token.

### 7.4 URL Template Variables

Template variables in the URL are **NOT auto-expanded** on selection. They remain as `{workspaceId}`, `{artifactId}`, etc. The Template Variable Resolver shows them in accent color and expands them on Send. This matches the design decision from P0 §2.2.

**Supported variables in URLs:**

| Variable           | Source Field           | Example Value                              |
|--------------------|------------------------|--------------------------------------------|
| `{workspaceId}`    | `config.workspaceId`   | `12345678-1234-1234-1234-123456789abc`     |
| `{artifactId}`     | `config.artifactId`    | `87654321-4321-4321-4321-cba987654321`     |
| `{lakehouseId}`    | `config.artifactId`    | Same as artifactId (lakehouse IS the artifact) |
| `{capacityId}`     | `config.capacityId`    | `ABCDEF12`                                 |
| `{fabricBaseUrl}`   | `config.fabricBaseUrl`  | Full capacity host URL                     |
| `{iterationId}`    | User-provided          | DAG iteration GUID (no auto-fill)          |
| `{itemId}`         | User-provided          | Generic item GUID (no auto-fill)           |
| `{notebookId}`     | User-provided          | Notebook GUID (no auto-fill)               |
| `{tableName}`      | User-provided          | Table name string (no auto-fill)           |

### 7.5 Post-Selection UI Updates

1. **Dropdown closes** immediately after selection
2. **Trigger button updates** to show selected endpoint: method pill + name
3. **URL input receives focus** so user can edit template variables
4. **Search query is cleared** (ready for next search)
5. **Announce to screen reader:** `"Selected: GET Get Workspace"` via `aria-live` region

### 7.6 Event Dispatch

Selection fires a custom DOM event for the Request Builder to consume:

```javascript
this._container.dispatchEvent(new CustomEvent('endpoint-selected', {
  bubbles: true,
  detail: {
    endpoint: { /* full endpoint object from catalog */ },
    source: 'catalog'  // distinguishes from history/saved selection
  }
}));
```

---

## 8. Group Rendering

### 8.1 Group Order

Groups are rendered in fixed order (see §3.4 Group Registry). The order is not alphabetical — it follows a logical progression from general Fabric APIs to specific FLT/Maintenance/EDOG APIs:

```
Workspace → Items → Lakehouse → Tables → Notebooks → Environment
  → DAG → Maintenance → Spark → Auth/EDOG → Health
```

### 8.2 Group Header Rendering

Each group header displays:

```
▸ WORKSPACE (5)
│   │            │
│   │            └── count badge: number of endpoints in group
│   └── label: uppercase, letter-spaced, muted color
└── chevron: rotates 90deg when expanded
```

### 8.3 Collapse/Expand Behavior

| Action                              | Result                                           |
|-------------------------------------|--------------------------------------------------|
| Click group header                  | Toggle collapsed/expanded state                  |
| All groups default                  | Expanded on first open                           |
| Collapse state persists             | Stored in component instance (not localStorage)  |
| Search active                       | All groups forced expanded, collapse state saved  |
| Search cleared                      | Groups return to saved collapse state             |
| Keyboard: ArrowRight on collapsed   | Expand group                                     |
| Keyboard: ArrowLeft on expanded     | Collapse group                                   |

### 8.4 Group Count Badge Update

The count badge reflects the current visible endpoint count:

- **No search:** Shows total endpoints in group (e.g., "5")
- **Search active:** Shows matched endpoints count (e.g., "2"). If 0, entire group is hidden.

### 8.5 Single-Endpoint Groups

Groups with only 1 endpoint (Environment, Health) render normally — no special treatment. The group header is still collapsible.

---

## 9. Danger Indicators

### 9.1 Destructive Endpoints

Five endpoints are classified as `dangerLevel: "destructive"`:

| Endpoint              | Group        | Why Destructive                                   |
|-----------------------|--------------|---------------------------------------------------|
| Delete Workspace      | Workspace    | Permanently deletes workspace + all contents      |
| Delete Item           | Items        | Permanently deletes an artifact                    |
| Delete Lakehouse      | Lakehouse    | Permanently deletes lakehouse + all table data     |
| Delete Notebook       | Notebooks    | Permanently deletes notebook                       |
| Force Unlock DAG      | Maintenance  | Can cause data corruption if DAG is actually running |

### 9.2 Visual Treatment

Destructive endpoints have three visual signals:

1. **Red left border:** 2px solid `var(--level-error)` on the `.ec-item` row
2. **Red ◆ indicator:** Small red diamond at the right edge of the row
3. **DELETE method pill:** Already red via `.method-pill.delete` styling

```
├ DEL  Delete Workspace      ◆ │
│  │                          │ │
│  └── red method pill        │ │
│                             └── red ◆ (8px, var(--level-error))
│
└── 2px red left border (var(--level-error))
```

### 9.3 Tooltip on Danger Indicator

The `◆` indicator has `title="Destructive — cannot be undone"` for hover tooltip and `aria-label="Destructive operation"` for screen readers.

### 9.4 Force Unlock Special Case

Force Unlock DAG is `POST` (blue method pill) but `destructive` danger level. The red ◆ and left border distinguish it from safe POST endpoints. Its description explicitly warns: "USE WITH EXTREME CAUTION — may cause data corruption if a DAG is actually running."

### 9.5 Caution-Level Endpoints

`caution` endpoints (Create, Rename, PATCH, Run, Cancel) receive **no special visual indicator** beyond their method color. The method color (blue for POST, orange for PATCH) is sufficient to signal "this modifies data." Only truly irreversible operations get the red treatment.

---

## 10. Keyboard Navigation

### 10.1 Key Bindings

| Key              | State              | Action                                           |
|------------------|--------------------|--------------------------------------------------|
| `Enter`          | Trigger focused    | Open dropdown, focus search input                |
| `Space`          | Trigger focused    | Open dropdown, focus search input                |
| `ArrowDown`      | Trigger focused    | Open dropdown, focus first endpoint item         |
| `Enter`          | Item focused       | Select focused item, close dropdown              |
| `ArrowDown`      | Dropdown open      | Move focus to next visible item                  |
| `ArrowUp`        | Dropdown open      | Move focus to previous visible item              |
| `ArrowRight`     | Group header focused | Expand group (if collapsed)                    |
| `ArrowLeft`      | Group header focused | Collapse group (if expanded)                   |
| `Home`           | Dropdown open      | Focus first visible item                         |
| `End`            | Dropdown open      | Focus last visible item                          |
| `Escape`         | Search has text    | Clear search text, keep dropdown open            |
| `Escape`         | Search empty       | Close dropdown, return focus to trigger          |
| `Tab`            | Dropdown open      | Close dropdown, move focus to next element       |
| Any printable    | Dropdown open      | Type into search input (auto-focus search)       |

### 10.2 Focus Management

**Active item tracking:** Exactly one item has `[data-active]` attribute at any time when the dropdown is open. This is the "virtual focus" — the item that will be selected on Enter.

**Focus flow:**

```
Trigger [focused]
  ↓ Enter/Space/ArrowDown
Search input [focused] ← typing filters list
  ↓ ArrowDown
First visible item [data-active]
  ↓ ArrowDown
Next visible item [data-active]
  ↓ ArrowDown (at last item)
Wraps to first visible item
  ↑ ArrowUp (at first item)
Wraps to last visible item
```

### 10.3 Skip Logic

Arrow keys skip:

- Hidden groups (filtered out by search)
- Items in collapsed groups
- Group headers (arrows move between items only; groups expand/collapse via ArrowRight/Left when header is focused)

### 10.4 Type-Ahead

When the dropdown is open and the user types any printable character, focus moves to the search input and the character is appended. No separate type-ahead mode — the search input handles all text input.

### 10.5 Screen Reader Navigation

The `aria-activedescendant` on the trigger button is updated to match the `id` of the currently focused item. This lets screen readers announce the focused item without moving DOM focus away from the search input.

---

## 11. Accessibility

### 11.1 ARIA Pattern

The Endpoint Catalog implements the **ARIA Combobox pattern** (WAI-ARIA 1.2) with a listbox popup containing grouped options.

### 11.2 Role Assignment

| Element                | Role         | Purpose                                         |
|------------------------|--------------|--------------------------------------------------|
| `.ec` (root)           | `combobox`   | Composite widget with popup listbox              |
| `.ec-trigger`          | implicit button | Trigger for the popup                         |
| `.ec-search`           | `searchbox`  | Search input within the combobox                 |
| `.ec-list`             | `listbox`    | List of selectable options                       |
| `.ec-group`            | `presentation` | Structural grouping (no semantic role)        |
| `.ec-group-items`      | `group`      | Logical group of related options                 |
| `.ec-item`             | `option`     | Selectable endpoint                              |

### 11.3 ARIA States and Properties

| Attribute               | Element        | Dynamic Values                                 |
|--------------------------|----------------|-------------------------------------------------|
| `aria-expanded`          | `.ec` root     | `"true"` / `"false"` — dropdown open/closed    |
| `aria-expanded`          | `.ec-group-header` | `"true"` / `"false"` — group expanded/collapsed |
| `aria-haspopup`          | `.ec` root     | `"listbox"` (constant)                          |
| `aria-owns`              | `.ec` root     | `"ec-listbox"` (constant)                       |
| `aria-controls`          | `.ec-trigger`  | `"ec-listbox"` (constant)                       |
| `aria-activedescendant`  | `.ec-trigger`  | ID of currently focused item (e.g., `"ec-opt-get-workspace"`) |
| `aria-selected`          | `.ec-item`     | `"true"` on currently selected endpoint         |
| `aria-label`             | `.ec` root     | `"Endpoint catalog"` (constant)                 |
| `aria-label`             | `.ec-search`   | `"Search endpoints"` (constant)                 |
| `aria-label`             | `.ec-group-items` | `"{Group name} endpoints"` (e.g., "Workspace endpoints") |
| `aria-label`             | `.ec-item-danger` | `"Destructive operation"` (constant)          |
| `aria-live`              | `.ec-footer`   | `"polite"` — announces result count changes    |

### 11.4 Screen Reader Announcements

| Event                    | Announcement (via `aria-live="polite"`)         |
|--------------------------|--------------------------------------------------|
| Dropdown opens           | `"Endpoint catalog open, 37 endpoints available"` |
| Search filters results   | `"7 results"` (from `.ec-result-count`)          |
| Search yields no results | `"No endpoints found"`                           |
| Item receives focus      | `"{Method} {Name}"` — e.g., `"GET Get Workspace"` (via `aria-activedescendant`) |
| Destructive item focused | `"{Method} {Name}, Destructive operation"` (via item label + danger indicator label) |
| Endpoint selected        | `"Selected: {Method} {Name}"` — announced by live region |
| Dropdown closes          | Focus returns to trigger — no announcement needed |

### 11.5 Focus Trap

The dropdown does **NOT** implement a full focus trap. Tab moves focus out of the dropdown and closes it. This matches the combobox pattern — the dropdown is a transient popup, not a modal.

### 11.6 Color Contrast Requirements

All text and interactive elements must meet WCAG 2.1 AA contrast ratios (4.5:1 for normal text, 3:1 for large text):

| Element                  | Foreground              | Background        | Minimum Ratio |
|--------------------------|-------------------------|--------------------|---------------|
| Endpoint name            | `var(--text)`           | `var(--surface)`   | 4.5:1         |
| Group label              | `var(--text-muted)`     | `var(--surface)`   | 4.5:1         |
| Method pill text         | Status/level colors     | Tinted background  | 4.5:1         |
| Danger indicator (◆)     | `var(--level-error)`    | `var(--surface)`   | 3:1           |
| Search placeholder       | `var(--text-muted)`     | `var(--surface)`   | 4.5:1         |
| Focused item background  | `var(--text)`           | `var(--accent-dim)`| 4.5:1         |

### 11.7 Motion Accessibility

The dropdown entrance/exit animation is suppressed when `prefers-reduced-motion: reduce` is active (see §5.3).

---

## Appendix A: State Summary

| State                         | Trigger Appearance       | Dropdown    | Search    | Notes                        |
|-------------------------------|--------------------------|-------------|-----------|------------------------------|
| Idle (no selection)           | "Select endpoint..."     | Hidden      | —         | Initial state                |
| Idle (with selection)         | "GET Get Workspace"      | Hidden      | —         | After selecting an endpoint  |
| Open (no search)              | Highlighted border       | Visible     | Empty     | All 37 endpoints shown       |
| Open (search active)          | Highlighted border       | Visible     | Has text  | Filtered results             |
| Open (search, no results)     | Highlighted border       | Visible     | Has text  | Empty state shown            |
| Open (keyboard navigating)    | Highlighted border       | Visible     | Any       | One item has `[data-active]` |
| Disabled                      | Dimmed, cursor default   | Blocked     | —         | When Request Builder is sending |

Full state matrix to be defined in `states/endpoint-catalog.md`.

---

## Appendix B: Integration Points

| Component               | Direction | What Is Exchanged                                       |
|--------------------------|-----------|--------------------------------------------------------|
| Request Builder          | Out →     | `endpoint-selected` event with full endpoint object     |
| Request Builder          | ← In     | Disable catalog during in-flight request                |
| Template Variable Resolver | Out →   | URL and header values containing `{variable}` tokens    |
| Config API (`/api/flt/config`) | ← In | Token values, workspace/artifact/capacity IDs           |
| History & Saved          | Peer      | Both can populate Request Builder (different `source`)  |

---

## Appendix C: File Dependencies

| File                           | Relationship      |
|--------------------------------|--------------------|
| `src/frontend/css/variables.css` | CSS custom properties consumed |
| `src/frontend/css/spark.css`    | `.method-pill` base class reused |
| `src/frontend/css/api-playground.css` | Parent layout context |
| `src/frontend/js/api-client.js` | Token and config data source |
| `src/frontend/js/api-playground.js` | Parent module (to be created) |
