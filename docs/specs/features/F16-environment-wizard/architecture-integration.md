# P2 Integration Protocol — F16 New Infra Wizard

> **Feature:** F16 — New Infrastructure Wizard
> **Document Type:** P2 Architecture — Frontend/Backend Integration Contract
> **Status:** Draft
> **Version:** 1.0.0
> **Owners:** Vex (Python backend) + Pixel (JS frontend)
> **Last Updated:** 2025-07-21
> **Depends On:** P0 Code Audit, P1 Component Specs (C01, C02, C10, C12)
> **Audience:** Any developer building frontend OR backend for F16 — independently.

---

## Table of Contents

1. [Communication Architecture Overview](#1-communication-architecture-overview)
2. [REST API Contract](#2-rest-api-contract)
3. [Server-Sent Events Protocol](#3-server-sent-events-protocol)
4. [Data Schemas](#4-data-schemas)
5. [Sequence Diagrams](#5-sequence-diagrams)
6. [Error Contract](#6-error-contract)
7. [Versioning and Compatibility](#7-versioning-and-compatibility)

---

## 1. Communication Architecture Overview

### 1.1 Transport Architecture

The F16 wizard uses a **dual-transport** architecture:

```
+-------------------------------------------------------------------------+
|  BROWSER (Frontend)                                                     |
|                                                                         |
|  +---------------------+   HTTP REST (CRUD)   +----------------------+ |
|  |  InfraWizardDialog   | ------------------->  |  localhost:5555      | |
|  |  (C01)               |                      |  Python HTTP Server  | |
|  |                      | <-------------------  |  (edog.py)           | |
|  |  +-- InfraSetupPage  |   JSON responses     |                      | |
|  |  +-- TemplateManager |                      |  Routes:             | |
|  |  +-- ExecutionPipe   |   SSE (real-time)    |  /api/wizard/*       | |
|  |      line (C10)      | <====================|  /api/templates/*    | |
|  +---------------------+   EventSource         +------+---------------+ |
|                                                        |                 |
+--------------------------------------------------------+-----------------+
                                                         |
                                                         | Bearer Token
                                                         | (proxied)
                                                         v
                                              +----------------------+
                                              |  Fabric APIs         |
                                              |  (redirect host)     |
                                              |  biazure-int-edog-   |
                                              |  redirect...         |
                                              +----------------------+
```

| Transport | Use Case | Direction | Format |
|-----------|----------|-----------|--------|
| **HTTP REST** | CRUD operations: templates, capacities, validation, execution trigger | Request/Response | JSON |
| **Server-Sent Events (SSE)** | Real-time execution progress streaming | Server to Client (unidirectional) | `text/event-stream` |

### 1.2 Why SSE Over WebSocket

The execution pipeline streams progress events from backend to frontend. We chose **SSE** over **WebSocket** for these reasons:

| Factor | SSE | WebSocket |
|--------|-----|-----------|
| **Direction** | Server to Client only (exactly what we need) | Bidirectional (overkill) |
| **Reconnection** | Built-in auto-reconnect with `Last-Event-ID` | Manual reconnect logic required |
| **Protocol** | Standard HTTP, works through proxies and firewalls | Upgrade handshake can be blocked |
| **Complexity** | `EventSource` API, 5 lines of code | `WebSocket` + heartbeat + reconnect = 50+ lines |
| **Existing pattern** | `deploy-flow.js` already uses `EventSource` | Would require new infrastructure |
| **Browser support** | All modern browsers | All modern browsers |
| **Scalability** | One connection per wizard execution | Same |

**Decision:** SSE for execution progress. REST for everything else.

### 1.3 Base URL and Routing Conventions

All wizard API routes are served by the EDOG Studio Python HTTP server on `localhost:5555`.

```
Base URL:  http://localhost:5555

Route prefixes:
  /api/wizard/*       -- Wizard-specific operations (capacities, execution, validation)
  /api/templates/*    -- Template CRUD (existing pattern from C12 spec)
  /api/fabric/*       -- Proxied Fabric API calls (existing, used by api-client.js)
```

**Routing convention:** Action-based paths matching the existing codebase `if/elif` routing pattern in `do_GET()` / `do_POST()`:

```python
# Existing pattern in edog.py:
if self.path.startswith('/api/fabric/'):
    self._proxy_fabric(self.path[len('/api/fabric/'):])
elif self.path.startswith('/api/flt/config'):
    self._handle_flt_config()

# New F16 routes follow the same pattern:
elif self.path.startswith('/api/wizard/'):
    self._handle_wizard_route()
elif self.path.startswith('/api/templates/'):
    self._handle_template_route()
```

### 1.4 Authentication Model

The frontend does NOT talk to Fabric APIs directly. All Fabric calls are **proxied** through the Python backend, which injects the Bearer token.

```
+--------------+  fetch('/api/wizard/capacities')  +----------------+  GET /v1/capacities  +--------------+
|  Frontend    | ---------------------------------> | Python Server  | -------------------> | Fabric API   |
|  (browser)   |  No auth header needed            | (edog.py)      |  Authorization:      | (redirect    |
|              |                                    |                |  Bearer {token}      |  host)       |
|              | <--------------------------------- |                | <------------------- |              |
|              |  JSON response                     |                |  JSON response       |              |
+--------------+                                    +----------------+                      +--------------+
```

**Token lifecycle:**
1. Bearer token is acquired at app startup via Playwright browser automation
2. Token is stored in `.edog-bearer-cache` (file-based, managed by Python backend)
3. Backend reads token from cache on each proxied request
4. Frontend sends requests to `/api/wizard/*` with NO `Authorization` header
5. Backend injects `Authorization: Bearer {token}` before forwarding to Fabric

**Token refresh:** If a Fabric call returns `401`, the backend returns the error to the frontend. The frontend displays an "Authentication expired" error with instructions to re-run token acquisition.

**Template routes** (`/api/templates/*`) do NOT require any token; they are local file I/O only.

### 1.5 Error Envelope Format

ALL API responses from the Python backend use a consistent JSON envelope:

**Success envelope:**
```json
{
  "ok": true,
  "...": "endpoint-specific fields"
}
```

**Error envelope:**
```json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable description of what went wrong",
  "detail": "Optional technical detail (stack trace, raw API response)",
  "retryable": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ok` | `boolean` | Always | `true` for 2xx responses, `false` for 4xx/5xx |
| `error` | `string` | On error | Machine-readable error code (SCREAMING_SNAKE_CASE) |
| `message` | `string` | On error | Human-readable error message for UI display |
| `detail` | `string or object or null` | Optional | Technical detail (raw API error body, stack trace) |
| `retryable` | `boolean` | On error | Whether the frontend should offer a Retry button |

### 1.6 Content-Type Conventions

| Direction | Content-Type | Notes |
|-----------|-------------|-------|
| Request body (POST) | `application/json` | All POST bodies are JSON |
| Response body (success) | `application/json` | Always JSON |
| Response body (error) | `application/json` | Error envelope is also JSON |
| SSE stream | `text/event-stream` | Standard SSE content type |

### 1.7 CORS

Not applicable. Frontend and backend are on the same origin (`localhost:5555`). The Python server serves both the static HTML and the API routes.

---

## 2. REST API Contract

### 2.1 Capacity Endpoints

#### 2.1.1 List Available Capacities

Lists all Fabric capacities the user has access to. Used by the InfraSetupPage (C02) capacity dropdown.

**Endpoint:** `GET /api/wizard/capacities`

**Request:**
```http
GET /api/wizard/capacities HTTP/1.1
Host: localhost:5555
```

No query parameters. No request body. No auth header (backend handles token).

**Response (200 OK):**
```json
{
  "ok": true,
  "capacities": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "displayName": "MyDevCapacity",
      "sku": "F4",
      "region": "eastus",
      "state": "Active",
      "admins": ["user@contoso.com"]
    },
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "displayName": "TeamTestCapacity",
      "sku": "F8",
      "region": "westus2",
      "state": "Active",
      "admins": ["admin@contoso.com", "user@contoso.com"]
    }
  ]
}
```

**Response (401 Unauthorized -- token expired/missing):**
```json
{
  "ok": false,
  "error": "AUTH_TOKEN_EXPIRED",
  "message": "Bearer token has expired. Please re-authenticate.",
  "detail": "Fabric API returned 401: InvalidToken",
  "retryable": false
}
```

**Response (500 Internal Server Error -- Fabric API unreachable):**
```json
{
  "ok": false,
  "error": "FABRIC_API_ERROR",
  "message": "Failed to fetch capacities from Fabric API",
  "detail": "ConnectionError: Unable to reach biazure-int-edog-redirect...",
  "retryable": true
}
```

**Backend implementation notes:**
- Calls `GET /v1.0/myorg/capacities` on the redirect host (Power BI REST API format)
- Response from Fabric: `{ value: [{ id, displayName, sku, region, state, admins }] }`
- Backend normalizes and filters: only returns capacities with `state: "Active"` or `state: "Provisioning"`
- Caches result for 60 seconds to avoid repeated API calls during wizard navigation

**Example curl:**
```bash
curl -s http://localhost:5555/api/wizard/capacities | python -m json.tool
```

---

### 2.2 Template Endpoints

Template routes follow the **action-based path convention** established in the C12 spec. Templates are stored in `edog-templates.json` in the project root.

#### 2.2.1 List Templates

Returns all saved templates with metadata (no full state, too large for listing).

**Endpoint:** `GET /api/templates/list`

**Request:**
```http
GET /api/templates/list HTTP/1.1
Host: localhost:5555
```

No query parameters. No request body.

**Response (200 OK):**
```json
{
  "ok": true,
  "templates": [
    {
      "id": "tmpl_1720000000000_a1b2c3",
      "name": "My Production Layout",
      "description": "Standard 3-tier medallion architecture with 12 nodes",
      "createdAt": "2025-07-15T10:30:00.000Z",
      "updatedAt": "2025-07-15T14:22:00.000Z",
      "version": 1,
      "metadata": {
        "nodeCount": 12,
        "connectionCount": 11,
        "themeId": "ecommerce",
        "schemaNames": ["dbo", "bronze", "silver", "gold"],
        "wizardVersion": "0.1.0"
      }
    }
  ]
}
```

**Response (200 OK -- empty, no templates saved yet):**
```json
{
  "ok": true,
  "templates": []
}
```

**Response (500 -- template file corrupt):**
```json
{
  "ok": false,
  "error": "TEMPLATE_FILE_CORRUPT",
  "message": "The template file is corrupted and could not be parsed. A backup has been created at edog-templates.json.bak",
  "detail": "JSONDecodeError: Expecting value: line 42 column 3",
  "retryable": false
}
```

**Example curl:**
```bash
curl -s http://localhost:5555/api/templates/list | python -m json.tool
```

---

#### 2.2.2 Load Template

Returns a single template by name, INCLUDING the full `state` object for wizard restoration.

**Endpoint:** `GET /api/templates/load?name={encodedName}`

**Request:**
```http
GET /api/templates/load?name=My%20Production%20Layout HTTP/1.1
Host: localhost:5555
```

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `name` | Query string | `string` | Yes | URL-encoded template name (case-insensitive match) |

**Response (200 OK):**
```json
{
  "ok": true,
  "template": {
    "id": "tmpl_1720000000000_a1b2c3",
    "name": "My Production Layout",
    "description": "Standard 3-tier medallion architecture",
    "createdAt": "2025-07-15T10:30:00.000Z",
    "updatedAt": "2025-07-15T14:22:00.000Z",
    "version": 1,
    "metadata": {
      "nodeCount": 12,
      "connectionCount": 11,
      "themeId": "ecommerce",
      "schemaNames": ["dbo", "bronze", "silver", "gold"],
      "wizardVersion": "0.1.0"
    },
    "state": {
      "infrastructure": {
        "workspaceName": "analytics-ws",
        "lakehouseName": "main-lakehouse",
        "notebookName": "etl-notebook"
      },
      "schemas": {
        "primary": "dbo",
        "medallion": ["bronze", "silver", "gold"]
      },
      "theme": {
        "id": "ecommerce",
        "customOverrides": {}
      },
      "dag": {
        "nodes": [
          {
            "id": "node_1720000000001",
            "name": "customers",
            "type": "sql-table",
            "schema": "dbo",
            "position": { "x": 100, "y": 200 },
            "config": {}
          }
        ],
        "connections": [
          {
            "id": "conn_1720000000001",
            "sourceNodeId": "node_1720000000001",
            "targetNodeId": "node_1720000000002",
            "sourcePort": "output",
            "targetPort": "input"
          }
        ],
        "viewport": { "x": 0, "y": 0, "zoom": 1.0 }
      }
    }
  }
}
```

**Response (400 -- missing parameter):**
```json
{
  "ok": false,
  "error": "MISSING_PARAMETER",
  "message": "Query parameter 'name' is required",
  "detail": null,
  "retryable": false
}
```

**Response (404 -- template not found):**
```json
{
  "ok": false,
  "error": "TEMPLATE_NOT_FOUND",
  "message": "No template named 'My Production Layout' was found",
  "detail": null,
  "retryable": false
}
```

**Response (409 -- template version too new):**
```json
{
  "ok": false,
  "error": "TEMPLATE_VERSION_TOO_NEW",
  "message": "This template was created with a newer version of EDOG Studio (v3). Please update to load it.",
  "detail": { "templateVersion": 3, "currentVersion": 1 },
  "retryable": false
}
```

**Example curl:**
```bash
curl -s "http://localhost:5555/api/templates/load?name=My%20Production%20Layout" \
  | python -m json.tool
```

---

#### 2.2.3 Save Template

Saves a new template or overwrites an existing one.

**Endpoint:** `POST /api/templates/save`

**Request:**
```http
POST /api/templates/save HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "name": "My Production Layout",
  "description": "Standard 3-tier medallion architecture",
  "overwrite": false,
  "state": {
    "infrastructure": {
      "workspaceName": "analytics-ws",
      "lakehouseName": "main-lakehouse",
      "notebookName": "etl-notebook"
    },
    "schemas": {
      "primary": "dbo",
      "medallion": ["bronze", "silver", "gold"]
    },
    "theme": {
      "id": "ecommerce",
      "customOverrides": {}
    },
    "dag": {
      "nodes": [],
      "connections": [],
      "viewport": { "x": 0, "y": 0, "zoom": 1.0 }
    }
  }
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `name` | `string` | Yes | 1-64 chars, filesystem-safe, unique | Template display name |
| `description` | `string` | No | Max 256 chars | Optional description |
| `overwrite` | `boolean` | No | Default: `false` | If `true`, overwrites existing template with same name |
| `state` | `object` | Yes | Must conform to TemplateState schema (see section 4) | Complete wizard state snapshot |

**Response (201 Created -- new template):**
```json
{
  "ok": true,
  "template": {
    "id": "tmpl_1720000000000_a1b2c3",
    "name": "My Production Layout",
    "description": "Standard 3-tier medallion architecture",
    "createdAt": "2025-07-15T10:30:00.000Z",
    "updatedAt": "2025-07-15T10:30:00.000Z",
    "version": 1,
    "metadata": {
      "nodeCount": 0,
      "connectionCount": 0,
      "themeId": "ecommerce",
      "schemaNames": ["dbo", "bronze", "silver", "gold"],
      "wizardVersion": "0.1.0"
    }
  },
  "created": true
}
```

**Response (200 OK -- overwrite existing):**
```json
{
  "ok": true,
  "template": {
    "id": "tmpl_1720000000000_a1b2c3",
    "name": "My Production Layout",
    "description": "Updated description",
    "createdAt": "2025-07-15T10:30:00.000Z",
    "updatedAt": "2025-07-16T09:00:00.000Z",
    "version": 1,
    "metadata": {
      "nodeCount": 12,
      "connectionCount": 11,
      "themeId": "ecommerce",
      "schemaNames": ["dbo", "bronze", "silver", "gold"],
      "wizardVersion": "0.1.0"
    }
  },
  "created": false
}
```

**Response (400 -- validation error):**
```json
{
  "ok": false,
  "error": "VALIDATION_ERROR",
  "message": "Template name contains invalid characters",
  "detail": ["Template name contains invalid characters: /", "Template name must be 64 characters or fewer"],
  "retryable": false
}
```

**Response (409 -- name conflict, overwrite=false):**
```json
{
  "ok": false,
  "error": "TEMPLATE_NAME_EXISTS",
  "message": "A template named 'My Production Layout' already exists. Set overwrite=true to replace it.",
  "detail": {
    "existingTemplate": {
      "id": "tmpl_1720000000000_a1b2c3",
      "name": "My Production Layout",
      "updatedAt": "2025-07-15T10:30:00.000Z"
    }
  },
  "retryable": false
}
```

**Example curl:**
```bash
curl -s -X POST http://localhost:5555/api/templates/save \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Quick Test",
    "description": "Minimal 2-node DAG for testing",
    "overwrite": false,
    "state": {
      "infrastructure": { "workspaceName": "test-ws", "lakehouseName": "test-lh", "notebookName": "test-nb" },
      "schemas": { "primary": "dbo", "medallion": [] },
      "theme": { "id": "ecommerce", "customOverrides": {} },
      "dag": { "nodes": [], "connections": [], "viewport": { "x": 0, "y": 0, "zoom": 1.0 } }
    }
  }' | python -m json.tool
```

---

#### 2.2.4 Delete Template

Deletes a template by name. Uses POST (not HTTP DELETE) to match the existing codebase pattern of action-based paths with POST bodies.

**Endpoint:** `POST /api/templates/delete`

**Request:**
```http
POST /api/templates/delete HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "name": "My Production Layout"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Name of template to delete (case-insensitive match) |

**Response (200 OK):**
```json
{
  "ok": true,
  "deleted": true,
  "name": "My Production Layout"
}
```

**Response (400 -- missing name):**
```json
{
  "ok": false,
  "error": "MISSING_PARAMETER",
  "message": "Template name is required",
  "detail": null,
  "retryable": false
}
```

**Response (404 -- not found):**
```json
{
  "ok": false,
  "error": "TEMPLATE_NOT_FOUND",
  "message": "No template named 'My Production Layout' was found",
  "detail": null,
  "retryable": false
}
```

**Example curl:**
```bash
curl -s -X POST http://localhost:5555/api/templates/delete \
  -H "Content-Type: application/json" \
  -d '{"name": "Quick Test"}' | python -m json.tool
```

---

### 2.3 Execution Endpoints

#### 2.3.1 Start Execution Pipeline

Starts the 6-step environment creation pipeline. The backend validates the request, generates an execution ID, and begins executing pipeline steps sequentially. Progress is streamed via SSE (see section 3).

**Endpoint:** `POST /api/wizard/execute`

**Request:**
```http
POST /api/wizard/execute HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "workspaceName": "brave_turing_42",
  "workspaceDescription": "Auto-generated test environment",
  "capacityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "lakehouseName": "brave_turing_42_lakehouse",
  "enableSchemas": true,
  "notebookName": "brave_turing_42_notebook",
  "notebookDescription": "Auto-generated by EDOG Studio",
  "theme": "ecommerce",
  "schemas": {
    "primary": "dbo",
    "medallion": ["bronze", "silver", "gold"]
  },
  "dag": {
    "nodes": [
      {
        "id": "node_1",
        "name": "customers",
        "type": "sql-table",
        "schema": "dbo",
        "position": { "x": 100, "y": 100 }
      },
      {
        "id": "node_2",
        "name": "orders",
        "type": "sql-table",
        "schema": "dbo",
        "position": { "x": 100, "y": 250 }
      },
      {
        "id": "node_3",
        "name": "customer_orders",
        "type": "sql-mlv",
        "schema": "bronze",
        "position": { "x": 300, "y": 175 }
      }
    ],
    "connections": [
      { "id": "conn_1", "sourceNodeId": "node_1", "targetNodeId": "node_3" },
      { "id": "conn_2", "sourceNodeId": "node_2", "targetNodeId": "node_3" }
    ]
  },
  "notebookCells": [
    {
      "id": "cell-0-pip-install",
      "order": 0,
      "code": "%pip install fmlv",
      "language": "pyspark",
      "label": "Install fmlv package",
      "dependsOn": []
    },
    {
      "id": "cell-1-customers",
      "order": 1,
      "code": "%%sql\nCREATE TABLE IF NOT EXISTS dbo.customers (\n  id INT, name STRING, email STRING\n);\nINSERT INTO dbo.customers VALUES (1, 'Alice', 'alice@example.com');",
      "language": "sparksql",
      "label": "Create customers table",
      "dependsOn": []
    },
    {
      "id": "cell-2-orders",
      "order": 2,
      "code": "%%sql\nCREATE TABLE IF NOT EXISTS dbo.orders (\n  id INT, customer_id INT, total DECIMAL(10,2)\n);\nINSERT INTO dbo.orders VALUES (101, 1, 299.99);",
      "language": "sparksql",
      "label": "Create orders table",
      "dependsOn": []
    },
    {
      "id": "cell-3-customer-orders",
      "order": 3,
      "code": "%%sql\nCREATE MATERIALIZED LAKE VIEW bronze.customer_orders AS\nSELECT c.id, c.name, o.total\nFROM dbo.customers c\nJOIN dbo.orders o ON c.id = o.customer_id;",
      "language": "sparksql",
      "label": "Create customer_orders MLV",
      "dependsOn": ["cell-1-customers", "cell-2-orders"]
    }
  ]
}
```

See section 4.1 for the complete `WizardExecutionRequest` JSON schema.

**Response (202 Accepted):**
```json
{
  "ok": true,
  "executionId": "exec_1720000000000_f7e8d9",
  "status": "started",
  "message": "Execution pipeline started. Connect to SSE stream for progress.",
  "sseUrl": "/api/wizard/execute/exec_1720000000000_f7e8d9/events",
  "statusUrl": "/api/wizard/execute/exec_1720000000000_f7e8d9/status",
  "steps": [
    { "index": 0, "id": "create-workspace", "name": "Create Workspace" },
    { "index": 1, "id": "assign-capacity", "name": "Assign Capacity" },
    { "index": 2, "id": "create-lakehouse", "name": "Create Lakehouse" },
    { "index": 3, "id": "create-notebook", "name": "Create Notebook" },
    { "index": 4, "id": "write-cells", "name": "Write Notebook Cells" },
    { "index": 5, "id": "execute-notebook", "name": "Execute Notebook" }
  ]
}
```

**Response (400 -- validation error):**
```json
{
  "ok": false,
  "error": "VALIDATION_ERROR",
  "message": "Invalid execution request",
  "detail": [
    "workspaceName is required",
    "capacityId must be a valid UUID",
    "dag.nodes must contain at least 1 node"
  ],
  "retryable": false
}
```

**Response (401 -- not authenticated):**
```json
{
  "ok": false,
  "error": "AUTH_TOKEN_EXPIRED",
  "message": "Bearer token has expired. Please re-authenticate before executing.",
  "detail": null,
  "retryable": false
}
```

**Response (409 -- concurrent execution):**
```json
{
  "ok": false,
  "error": "EXECUTION_ALREADY_RUNNING",
  "message": "Another wizard execution is already in progress. Only one execution can run at a time.",
  "detail": {
    "activeExecutionId": "exec_1720000000000_a1b2c3",
    "startedAt": "2025-07-15T10:30:00.000Z"
  },
  "retryable": false
}
```

**Example curl:**
```bash
curl -s -X POST http://localhost:5555/api/wizard/execute \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceName": "test_env_01",
    "workspaceDescription": "",
    "capacityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "lakehouseName": "test_env_01_lakehouse",
    "enableSchemas": true,
    "notebookName": "test_env_01_notebook",
    "notebookDescription": "Auto-generated by EDOG Studio",
    "theme": "ecommerce",
    "schemas": { "primary": "dbo", "medallion": [] },
    "dag": {
      "nodes": [{"id":"n1","name":"t1","type":"sql-table","schema":"dbo","position":{"x":0,"y":0}}],
      "connections": []
    },
    "notebookCells": [{"id":"c1","order":0,"code":"SELECT 1","language":"sparksql","label":"Test","dependsOn":[]}]
  }' | python -m json.tool
```

---

#### 2.3.2 Execution Progress Stream (SSE)

Streams real-time execution progress events. See section 3 for the complete SSE protocol.

**Endpoint:** `GET /api/wizard/execute/:executionId/events`

**Request:**
```http
GET /api/wizard/execute/exec_1720000000000_f7e8d9/events HTTP/1.1
Host: localhost:5555
Accept: text/event-stream
Cache-Control: no-cache
Last-Event-ID: 7
```

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `executionId` | Path | `string` | Yes | Execution ID from the `/execute` response |
| `Last-Event-ID` | Header | `string` | No | Last received event ID for reconnection |

**Response (200 OK -- text/event-stream):**
```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

retry: 3000

id: 1
event: step:start
data: {"stepIndex":0,"stepId":"create-workspace","stepName":"Create Workspace","timestamp":1720000000000}

id: 2
event: step:progress
data: {"stepIndex":0,"message":"Creating workspace 'brave_turing_42'...","detail":null}

id: 3
event: step:complete
data: {"stepIndex":0,"stepId":"create-workspace","artifact":{"type":"workspace","id":"ws-guid-123","displayName":"brave_turing_42","url":"/groups/ws-guid-123"},"durationMs":2100}

```

**Response (404 -- execution not found):**
```json
{
  "ok": false,
  "error": "EXECUTION_NOT_FOUND",
  "message": "No execution found with ID 'exec_invalid'",
  "detail": null,
  "retryable": false
}
```

**Response (410 Gone -- execution already completed/expired):**
```json
{
  "ok": false,
  "error": "EXECUTION_EXPIRED",
  "message": "Execution has already completed. Use the status endpoint for final state.",
  "detail": null,
  "retryable": false
}
```

**Example curl (SSE stream):**
```bash
curl -N -s http://localhost:5555/api/wizard/execute/exec_1720000000000_f7e8d9/events \
  -H "Accept: text/event-stream" \
  -H "Cache-Control: no-cache"
```

---

#### 2.3.3 Poll Execution Status (Fallback)

Returns the current execution state as a single JSON snapshot. Use this as a fallback when SSE is unavailable or after reconnection to get full state.

**Endpoint:** `GET /api/wizard/execute/:executionId/status`

**Request:**
```http
GET /api/wizard/execute/exec_1720000000000_f7e8d9/status HTTP/1.1
Host: localhost:5555
```

**Response (200 OK):**
```json
{
  "ok": true,
  "execution": {
    "id": "exec_1720000000000_f7e8d9",
    "status": "executing",
    "startedAt": "2025-07-15T10:30:00.000Z",
    "completedAt": null,
    "elapsedMs": 12500,
    "activeStepIndex": 3,
    "retryCount": 0,
    "steps": [
      {
        "index": 0,
        "id": "create-workspace",
        "name": "Create Workspace",
        "status": "succeeded",
        "durationMs": 2100,
        "artifact": { "type": "workspace", "id": "ws-guid-123", "displayName": "brave_turing_42" },
        "error": null,
        "skipped": false
      },
      {
        "index": 1,
        "id": "assign-capacity",
        "name": "Assign Capacity",
        "status": "succeeded",
        "durationMs": 1200,
        "artifact": null,
        "error": null,
        "skipped": false
      },
      {
        "index": 2,
        "id": "create-lakehouse",
        "name": "Create Lakehouse",
        "status": "succeeded",
        "durationMs": 3400,
        "artifact": { "type": "lakehouse", "id": "lh-guid-456", "displayName": "brave_turing_42_lakehouse" },
        "error": null,
        "skipped": false
      },
      {
        "index": 3,
        "id": "create-notebook",
        "name": "Create Notebook",
        "status": "running",
        "durationMs": null,
        "artifact": null,
        "error": null,
        "skipped": false
      },
      {
        "index": 4,
        "id": "write-cells",
        "name": "Write Notebook Cells",
        "status": "pending",
        "durationMs": null,
        "artifact": null,
        "error": null,
        "skipped": false
      },
      {
        "index": 5,
        "id": "execute-notebook",
        "name": "Execute Notebook",
        "status": "pending",
        "durationMs": null,
        "artifact": null,
        "error": null,
        "skipped": false
      }
    ],
    "artifacts": {
      "workspaceId": "ws-guid-123",
      "workspaceObjectId": "ws-guid-123",
      "capacityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "lakehouseId": "lh-guid-456",
      "notebookId": null,
      "jobInstanceId": null,
      "notebookRunStatus": null,
      "workspaceUrl": null
    },
    "rollbackManifest": {
      "resources": [
        { "type": "workspace", "id": "ws-guid-123", "displayName": "brave_turing_42", "createdByStep": "create-workspace" },
        { "type": "lakehouse", "id": "lh-guid-456", "displayName": "brave_turing_42_lakehouse", "createdByStep": "create-lakehouse" }
      ]
    },
    "error": null
  }
}
```

**Response (404 -- execution not found):**
```json
{
  "ok": false,
  "error": "EXECUTION_NOT_FOUND",
  "message": "No execution found with ID 'exec_invalid'",
  "detail": null,
  "retryable": false
}
```

**Example curl:**
```bash
curl -s http://localhost:5555/api/wizard/execute/exec_1720000000000_f7e8d9/status \
  | python -m json.tool
```

---

#### 2.3.4 Retry from Failed Step

Resumes execution from the failed step. All previously completed steps are preserved (skipped). Only the failed step and subsequent steps are re-executed.

**Endpoint:** `POST /api/wizard/execute/:executionId/retry`

**Request:**
```http
POST /api/wizard/execute/exec_1720000000000_f7e8d9/retry HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "fromStepIndex": 3
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromStepIndex` | `integer` | Yes | The step index to retry from (0-5). Must match the failed step. |

**Response (202 Accepted):**
```json
{
  "ok": true,
  "executionId": "exec_1720000000000_f7e8d9",
  "status": "retrying",
  "retryFromStep": 3,
  "retryCount": 1,
  "message": "Retrying from step 3 (Create Notebook). Connect to SSE stream for progress.",
  "sseUrl": "/api/wizard/execute/exec_1720000000000_f7e8d9/events"
}
```

**Response (400 -- invalid retry):**
```json
{
  "ok": false,
  "error": "INVALID_RETRY",
  "message": "Cannot retry: pipeline is not in failed state (current: executing)",
  "detail": null,
  "retryable": false
}
```

**Response (400 -- step index mismatch):**
```json
{
  "ok": false,
  "error": "STEP_INDEX_MISMATCH",
  "message": "Cannot retry from step 2: the failed step is 3 (Create Notebook)",
  "detail": { "failedStepIndex": 3 },
  "retryable": false
}
```

**Response (429 -- retry limit exceeded):**
```json
{
  "ok": false,
  "error": "RETRY_LIMIT_EXCEEDED",
  "message": "Maximum retry attempts (3) reached. Consider rolling back and starting over.",
  "detail": { "maxRetries": 3, "currentRetryCount": 3 },
  "retryable": false
}
```

**Example curl:**
```bash
curl -s -X POST http://localhost:5555/api/wizard/execute/exec_1720000000000_f7e8d9/retry \
  -H "Content-Type: application/json" \
  -d '{"fromStepIndex": 3}' | python -m json.tool
```

---

#### 2.3.5 Rollback Execution

Triggers cleanup of all resources created during a failed execution. Resources are deleted in reverse creation order.

**Endpoint:** `POST /api/wizard/execute/:executionId/rollback`

**Request:**
```http
POST /api/wizard/execute/exec_1720000000000_f7e8d9/rollback HTTP/1.1
Host: localhost:5555
```

No request body.

**Response (202 Accepted):**
```json
{
  "ok": true,
  "executionId": "exec_1720000000000_f7e8d9",
  "status": "rolling_back",
  "message": "Rollback started. 2 resources will be deleted. Connect to SSE stream for progress.",
  "resourcesToDelete": [
    { "type": "lakehouse", "id": "lh-guid-456", "displayName": "brave_turing_42_lakehouse" },
    { "type": "workspace", "id": "ws-guid-123", "displayName": "brave_turing_42" }
  ],
  "sseUrl": "/api/wizard/execute/exec_1720000000000_f7e8d9/events"
}
```

**Response (400 -- invalid state):**
```json
{
  "ok": false,
  "error": "INVALID_ROLLBACK",
  "message": "Cannot rollback: pipeline is not in failed state (current: executing)",
  "detail": null,
  "retryable": false
}
```

**Response (400 -- nothing to rollback):**
```json
{
  "ok": false,
  "error": "NOTHING_TO_ROLLBACK",
  "message": "No resources were created during this execution. Nothing to roll back.",
  "detail": null,
  "retryable": false
}
```

**Example curl:**
```bash
curl -s -X POST http://localhost:5555/api/wizard/execute/exec_1720000000000_f7e8d9/rollback \
  | python -m json.tool
```

---

### 2.4 Validation Endpoints

#### 2.4.1 Validate Workspace Name

Checks if a workspace name is available (no collision with existing workspaces).

**Endpoint:** `POST /api/wizard/validate/workspace-name`

**Request:**
```http
POST /api/wizard/validate/workspace-name HTTP/1.1
Host: localhost:5555
Content-Type: application/json

{
  "name": "brave_turing_42"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Workspace name to validate |

**Response (200 OK -- name available):**
```json
{
  "ok": true,
  "available": true,
  "name": "brave_turing_42"
}
```

**Response (200 OK -- name taken):**
```json
{
  "ok": true,
  "available": false,
  "name": "brave_turing_42",
  "conflictingWorkspace": {
    "id": "ws-guid-999",
    "displayName": "brave_turing_42"
  }
}
```

**Response (200 OK -- invalid format):**
```json
{
  "ok": true,
  "available": false,
  "name": "  ",
  "validationErrors": [
    "Workspace name cannot be empty or whitespace-only",
    "Workspace name must be between 1 and 256 characters"
  ]
}
```

**Example curl:**
```bash
curl -s -X POST http://localhost:5555/api/wizard/validate/workspace-name \
  -H "Content-Type: application/json" \
  -d '{"name": "brave_turing_42"}' | python -m json.tool
```

---

### 2.5 Endpoint Summary Table

| # | Method | Path | Purpose | Request Body | Success Code | Error Codes |
|---|--------|------|---------|-------------|-------------|-------------|
| 1 | GET | `/api/wizard/capacities` | List available capacities | None | 200 | 401, 500 |
| 2 | GET | `/api/templates/list` | List saved templates | None | 200 | 500 |
| 3 | GET | `/api/templates/load?name=` | Load template by name | None | 200 | 400, 404, 409 |
| 4 | POST | `/api/templates/save` | Save or overwrite template | JSON | 201/200 | 400, 409 |
| 5 | POST | `/api/templates/delete` | Delete template by name | JSON | 200 | 400, 404 |
| 6 | POST | `/api/wizard/execute` | Start execution pipeline | JSON | 202 | 400, 401, 409 |
| 7 | GET | `/api/wizard/execute/:id/events` | SSE execution progress | None | 200 (SSE) | 404, 410 |
| 8 | GET | `/api/wizard/execute/:id/status` | Poll execution status | None | 200 | 404 |
| 9 | POST | `/api/wizard/execute/:id/retry` | Retry from failed step | JSON | 202 | 400, 429 |
| 10 | POST | `/api/wizard/execute/:id/rollback` | Rollback created resources | None | 202 | 400 |
| 11 | POST | `/api/wizard/validate/workspace-name` | Check workspace name | JSON | 200 | -- |

---

## 3. Server-Sent Events Protocol

### 3.1 Overview

The SSE stream provides real-time progress updates for execution and rollback operations. One SSE connection per execution. The frontend opens it immediately after receiving the `202` from `POST /api/wizard/execute` and holds it open until the pipeline reaches a terminal state.

### 3.2 Connection Setup

**Frontend code:**
```javascript
const executionId = response.executionId;
const eventSource = new EventSource(
  `/api/wizard/execute/${executionId}/events`
);

eventSource.addEventListener('step:start', (e) => {
  const data = JSON.parse(e.data);
  pipeline.handleStepStart(data);
});

eventSource.addEventListener('step:progress', (e) => {
  const data = JSON.parse(e.data);
  pipeline.handleStepProgress(data);
});

eventSource.addEventListener('step:complete', (e) => {
  const data = JSON.parse(e.data);
  pipeline.handleStepComplete(data);
});

eventSource.addEventListener('step:failed', (e) => {
  const data = JSON.parse(e.data);
  pipeline.handleStepFailed(data);
});

eventSource.addEventListener('pipeline:complete', (e) => {
  const data = JSON.parse(e.data);
  pipeline.handlePipelineComplete(data);
  eventSource.close();
});

eventSource.addEventListener('pipeline:failed', (e) => {
  const data = JSON.parse(e.data);
  pipeline.handlePipelineFailed(data);
  eventSource.close();
});

// Rollback events (same stream, only emitted during rollback)
eventSource.addEventListener('rollback:start', (e) => { /* ... */ });
eventSource.addEventListener('rollback:step', (e) => { /* ... */ });
eventSource.addEventListener('rollback:complete', (e) => { /* ... */ });

eventSource.onerror = () => {
  // Browser auto-reconnects with Last-Event-ID
  // If 3+ consecutive errors, show "Connection lost" in UI
};
```

### 3.3 Event Types -- Execution

#### 3.3.1 `step:start`

Emitted when a pipeline step begins execution.

```
id: 1
event: step:start
data: {"stepIndex":0,"stepId":"create-workspace","stepName":"Create Workspace","timestamp":1720000000000}

```

| Field | Type | Description |
|-------|------|-------------|
| `stepIndex` | `integer` | Step index (0-5) |
| `stepId` | `string` | Step identifier |
| `stepName` | `string` | Human-readable step name |
| `timestamp` | `integer` | Unix timestamp (ms) when step started |

#### 3.3.2 `step:progress`

Emitted for intermediate progress updates within a step (LRO polling, retry attempts).

```
id: 4
event: step:progress
data: {"stepIndex":5,"message":"Notebook running... (polling attempt 3)","detail":{"pollingStatus":"InProgress","elapsedMs":9000},"timestamp":1720000009000}

```

| Field | Type | Description |
|-------|------|-------------|
| `stepIndex` | `integer` | Step index (0-5) |
| `message` | `string` | Human-readable progress message for log display |
| `detail` | `object or null` | Optional structured data (polling status, retry count) |
| `timestamp` | `integer` | Unix timestamp (ms) |

#### 3.3.3 `step:complete`

Emitted when a pipeline step completes successfully.

```
id: 5
event: step:complete
data: {"stepIndex":0,"stepId":"create-workspace","artifact":{"type":"workspace","id":"ws-guid-123","displayName":"brave_turing_42","url":"/groups/ws-guid-123"},"durationMs":2100,"timestamp":1720000002100}

```

| Field | Type | Description |
|-------|------|-------------|
| `stepIndex` | `integer` | Step index (0-5) |
| `stepId` | `string` | Step identifier |
| `artifact` | `ExecutionArtifact or null` | Resource created by this step |
| `durationMs` | `integer` | Step duration in milliseconds |
| `timestamp` | `integer` | Unix timestamp (ms) when step completed |

#### 3.3.4 `step:failed`

Emitted when a pipeline step fails (after all auto-retries are exhausted).

```
id: 8
event: step:failed
data: {"stepIndex":3,"stepId":"create-notebook","error":{"code":"FABRIC_API_ERROR","message":"Failed to create notebook. Fabric API returned 500.","detail":"Internal Server Error","httpStatus":500,"category":"server_error","retryable":true},"durationMs":13200,"retryAttempts":3,"timestamp":1720000013200}

```

| Field | Type | Description |
|-------|------|-------------|
| `stepIndex` | `integer` | Step index (0-5) |
| `stepId` | `string` | Step identifier |
| `error` | `StepError` | Error details (see section 4.6) |
| `durationMs` | `integer` | Total step duration including retries |
| `retryAttempts` | `integer` | Number of auto-retry attempts made |
| `timestamp` | `integer` | Unix timestamp (ms) when failure was declared |

#### 3.3.5 `pipeline:complete`

Emitted when all 6 steps complete successfully. This is a terminal event.

```
id: 14
event: pipeline:complete
data: {"totalDurationMs":25300,"artifacts":{"workspaceId":"ws-guid-123","workspaceObjectId":"ws-guid-123","capacityId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","lakehouseId":"lh-guid-456","notebookId":"nb-guid-789","jobInstanceId":"job-guid-012","notebookRunStatus":"Completed","workspaceUrl":"/groups/ws-guid-123"},"steps":[{"index":0,"id":"create-workspace","durationMs":2100},{"index":1,"id":"assign-capacity","durationMs":1200},{"index":2,"id":"create-lakehouse","durationMs":3400},{"index":3,"id":"create-notebook","durationMs":1100},{"index":4,"id":"write-cells","durationMs":900},{"index":5,"id":"execute-notebook","durationMs":16600}],"timestamp":1720000025300}

```

| Field | Type | Description |
|-------|------|-------------|
| `totalDurationMs` | `integer` | Total pipeline execution time |
| `artifacts` | `ExecutionArtifacts` | All resource IDs created |
| `steps` | `StepSummary[]` | Summary of each step |
| `timestamp` | `integer` | Unix timestamp (ms) |

#### 3.3.6 `pipeline:failed`

Emitted when the pipeline enters a failed state. This is a terminal event.

```
id: 10
event: pipeline:failed
data: {"failedStepIndex":3,"failedStepId":"create-notebook","error":{"code":"FABRIC_API_ERROR","message":"Failed to create notebook","httpStatus":500,"category":"server_error","retryable":true},"completedSteps":[0,1,2],"pendingSteps":[4,5],"totalDurationMs":13200,"canRetry":true,"canRollback":true,"rollbackResources":["workspace:ws-guid-123","lakehouse:lh-guid-456"],"timestamp":1720000013200}

```

| Field | Type | Description |
|-------|------|-------------|
| `failedStepIndex` | `integer` | Index of the step that failed |
| `failedStepId` | `string` | ID of the step that failed |
| `error` | `StepError` | Error details |
| `completedSteps` | `integer[]` | Indices of completed steps |
| `pendingSteps` | `integer[]` | Indices of steps never started |
| `totalDurationMs` | `integer` | Total elapsed time |
| `canRetry` | `boolean` | Whether retry is available |
| `canRollback` | `boolean` | Whether rollback is available |
| `rollbackResources` | `string[]` | Summary of rollback targets |
| `timestamp` | `integer` | Unix timestamp (ms) |

### 3.4 Event Types -- Rollback

Rollback events are emitted on the **same SSE stream** as execution events. They only appear after the user triggers a rollback via `POST /api/wizard/execute/:id/rollback`.

#### 3.4.1 `rollback:start`

```
id: 15
event: rollback:start
data: {"reason":"User requested rollback after step 3 failure","resourceCount":2,"timestamp":1720000015000}

```

| Field | Type | Description |
|-------|------|-------------|
| `reason` | `string` | Why rollback was triggered |
| `resourceCount` | `integer` | Number of resources to delete |
| `timestamp` | `integer` | Unix timestamp (ms) |

#### 3.4.2 `rollback:step`

Emitted for each resource deletion attempt during rollback.

```
id: 16
event: rollback:step
data: {"resourceIndex":0,"resourceType":"lakehouse","resourceId":"lh-guid-456","resourceName":"brave_turing_42_lakehouse","status":"deleting","timestamp":1720000015100}

id: 17
event: rollback:step
data: {"resourceIndex":0,"resourceType":"lakehouse","resourceId":"lh-guid-456","resourceName":"brave_turing_42_lakehouse","status":"deleted","durationMs":1200,"timestamp":1720000016300}

```

| Field | Type | Description |
|-------|------|-------------|
| `resourceIndex` | `integer` | Index in rollback sequence (reverse creation order) |
| `resourceType` | `string` | `workspace`, `lakehouse`, or `notebook` |
| `resourceId` | `string` | Resource GUID |
| `resourceName` | `string` | Resource display name |
| `status` | `string` | `deleting`, `deleted`, or `failed` |
| `durationMs` | `integer or null` | Duration of delete call (null while deleting) |
| `error` | `string or null` | Error message if status is `failed` |
| `timestamp` | `integer` | Unix timestamp (ms) |

#### 3.4.3 `rollback:complete`

Terminal event for rollback. Stream closes after this.

```
id: 20
event: rollback:complete
data: {"success":true,"totalDurationMs":2200,"cleanedUp":[{"type":"lakehouse","id":"lh-guid-456","name":"brave_turing_42_lakehouse","deleted":true},{"type":"workspace","id":"ws-guid-123","name":"brave_turing_42","deleted":true}],"failed":[],"timestamp":1720000017200}

```

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | `true` if all resources deleted |
| `totalDurationMs` | `integer` | Total rollback duration |
| `cleanedUp` | `RollbackSummary[]` | Successfully deleted resources |
| `failed` | `RollbackSummary[]` | Resources that failed to delete |
| `timestamp` | `integer` | Unix timestamp (ms) |

### 3.5 Heartbeat

The server sends a comment line every 15 seconds to keep the connection alive:

```
: heartbeat 1720000015000

```

This is a standard SSE comment (line starting with `:`) that the `EventSource` API ignores, but keeps the TCP connection alive through proxies and firewalls.

### 3.6 Reconnection Strategy

SSE has built-in reconnection via the `Last-Event-ID` mechanism:

1. **Every event has a monotonically increasing `id` field** (1, 2, 3, ...)
2. If the connection drops, the browser **automatically reconnects** after a delay
3. The browser sends the `Last-Event-ID` header with the last received event ID
4. The server **replays all events after that ID** from its in-memory buffer
5. The server sets `retry: 3000` (3-second reconnect delay) in the initial stream

**Server-side buffer:** The server keeps the last 100 events per execution in memory. If the client reconnects after more than 100 events have been missed, the server responds with `410 Gone` and the client falls back to the polling endpoint (`GET /api/wizard/execute/:id/status`).

**Frontend reconnection handling:**
```javascript
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

eventSource.onerror = () => {
  reconnectAttempts++;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    eventSource.close();
    // Fall back to polling
    startPollingFallback(executionId);
  }
};

eventSource.onmessage = () => {
  reconnectAttempts = 0; // Connection is healthy
};
```

### 3.7 Stream Lifecycle

```
Frontend                              Backend
   |                                     |
   |  POST /api/wizard/execute           |
   | ----------------------------------> |
   |                                     |  Start pipeline
   |  202 { executionId, sseUrl }        |
   | <---------------------------------- |
   |                                     |
   |  GET /api/wizard/execute/:id/events |
   | ==================================> |  (SSE connection opened)
   |                                     |
   |  id:1  event:step:start             |
   | <================================== |
   |  id:2  event:step:progress          |
   | <================================== |
   |  id:3  event:step:complete          |
   | <================================== |
   |  ...                                |
   |  : heartbeat (every 15s)            |
   | <================================== |
   |  ...                                |
   |  id:14 event:pipeline:complete      |  (terminal event)
   | <================================== |
   |                                     |
   |  eventSource.close()                |  (client closes connection)
   | ==================================> |
   |                                     |
```

---

## 4. Data Schemas

All data schemas are defined using TypeScript-style interfaces for clarity. The actual implementation uses vanilla JS (per ADR-002) and Python dicts, but these interfaces define the canonical shape of all data.

### 4.1 WizardExecutionRequest

The complete payload sent to `POST /api/wizard/execute`.

```typescript
interface WizardExecutionRequest {
  /** Display name for the new workspace. 1-256 chars. */
  workspaceName: string;

  /** Optional workspace description. Max 4000 chars. */
  workspaceDescription: string;

  /** Capacity GUID to assign to the workspace. Must be a valid UUID. */
  capacityId: string;

  /** Display name for the lakehouse. 1-256 chars. */
  lakehouseName: string;

  /** Always true. Lakehouses are always created with schema support. */
  enableSchemas: true;

  /** Display name for the notebook. 1-256 chars. */
  notebookName: string;

  /** Optional notebook description. Max 4000 chars. */
  notebookDescription: string;

  /** Selected data theme for code generation. */
  theme: 'ecommerce' | 'sales' | 'iot' | 'hr' | 'finance' | 'healthcare';

  /** Schema configuration. */
  schemas: {
    /** Primary schema. Always "dbo". */
    primary: 'dbo';
    /** Optional medallion schemas. Subset of ["bronze", "silver", "gold"]. */
    medallion: ('bronze' | 'silver' | 'gold')[];
  };

  /** DAG topology from the canvas. */
  dag: {
    /** All nodes on the canvas. At least 1 required. Max 100. */
    nodes: DagNodePayload[];
    /** All connections between nodes. */
    connections: DagConnectionPayload[];
  };

  /** Topologically sorted notebook cells. Generated from DAG + theme. */
  notebookCells: NotebookCellPayload[];
}

interface DagNodePayload {
  /** Unique node ID within the DAG. */
  id: string;
  /** User-visible node name (table/MLV name). */
  name: string;
  /** Node type. */
  type: 'sql-table' | 'sql-mlv' | 'pyspark-mlv';
  /** Schema this node belongs to. */
  schema: 'dbo' | 'bronze' | 'silver' | 'gold';
  /** Canvas position (for template restoration; not used by backend). */
  position: { x: number; y: number };
}

interface DagConnectionPayload {
  /** Unique connection ID. */
  id: string;
  /** Source node ID (parent). */
  sourceNodeId: string;
  /** Target node ID (child). */
  targetNodeId: string;
}

interface NotebookCellPayload {
  /** Unique cell identifier. */
  id: string;
  /** Cell execution order (0-based, topological sort). */
  order: number;
  /** Spark SQL or PySpark code for this cell. */
  code: string;
  /** Cell language. */
  language: 'sparksql' | 'pyspark';
  /** Human-readable label for log display. */
  label: string;
  /** Cell IDs this cell depends on. */
  dependsOn: string[];
}
```

### 4.2 ExecutionStatus

The status object returned by `GET /api/wizard/execute/:id/status`.

```typescript
interface ExecutionStatus {
  /** Execution ID. */
  id: string;
  /** Current pipeline status. */
  status: 'started' | 'executing' | 'succeeded' | 'failed'
        | 'retrying' | 'rolling_back' | 'rolled_back' | 'rollback_failed';
  /** ISO 8601 timestamp when execution started. */
  startedAt: string;
  /** ISO 8601 timestamp when completed (null if running). */
  completedAt: string | null;
  /** Total elapsed milliseconds. */
  elapsedMs: number;
  /** Index of currently executing step (0-5), or null. */
  activeStepIndex: number | null;
  /** Number of user-initiated retry attempts. */
  retryCount: number;
  /** Per-step status array. Always 6 elements. */
  steps: StepStatusEntry[];
  /** Accumulated execution artifacts. */
  artifacts: ExecutionArtifacts;
  /** Rollback manifest. */
  rollbackManifest: { resources: RollbackResource[] };
  /** Error details if failed. Null otherwise. */
  error: PipelineError | null;
}

interface StepStatusEntry {
  /** Step index (0-5). */
  index: number;
  /** Step identifier. */
  id: 'create-workspace' | 'assign-capacity' | 'create-lakehouse'
    | 'create-notebook' | 'write-cells' | 'execute-notebook';
  /** Human-readable step name. */
  name: string;
  /** Current step status. */
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  /** Step duration in ms (null if not started or still running). */
  durationMs: number | null;
  /** Resource created by this step (null if none). */
  artifact: ExecutionArtifact | null;
  /** Error details if step failed. */
  error: StepError | null;
  /** Whether this step was skipped during a retry. */
  skipped: boolean;
}
```

### 4.3 TemplateData

The save/load format for wizard templates. Stored in `edog-templates.json`.

```typescript
interface TemplateData {
  /** Unique template ID. Pattern: tmpl_{timestamp}_{random6hex}. */
  id: string;
  /** User-visible template name. 1-64 chars, filesystem-safe. */
  name: string;
  /** Optional description. Max 256 chars. */
  description: string;
  /** ISO 8601 UTC timestamp of creation. */
  createdAt: string;
  /** ISO 8601 UTC timestamp of last update. */
  updatedAt: string;
  /** Template schema version (current: 1). */
  version: number;
  /** Denormalized summary for list display. */
  metadata: TemplateMetadata;
  /** Complete wizard state snapshot. Only in load response, stripped from list. */
  state: TemplateState;
}

interface TemplateMetadata {
  /** Total DAG node count. */
  nodeCount: number;
  /** Total DAG connection count. */
  connectionCount: number;
  /** Selected theme ID. */
  themeId: string;
  /** Schema names used. */
  schemaNames: string[];
  /** Wizard version that created this template. */
  wizardVersion: string;
}

interface TemplateState {
  infrastructure: {
    workspaceName: string;
    lakehouseName: string;
    notebookName: string;
  };
  schemas: {
    primary: string;
    medallion: string[];
  };
  theme: {
    id: string;
    customOverrides: Record<string, any>;
  };
  dag: {
    nodes: DagNodePayload[];
    connections: DagConnectionPayload[];
    viewport: { x: number; y: number; zoom: number };
  };
}
```

### 4.4 CapacityInfo

A single capacity item returned by `GET /api/wizard/capacities`.

```typescript
interface CapacityInfo {
  /** Capacity GUID. */
  id: string;
  /** User-defined display name. */
  displayName: string;
  /** SKU tier: F2, F4, F8, F16, F32, F64. */
  sku: string;
  /** Azure region. */
  region: string;
  /** Current state. */
  state: 'Active' | 'Provisioning' | 'Paused' | 'Deleting' | 'ProvisionFailed';
  /** Admin users (array of UPNs). */
  admins: string[];
}
```

### 4.5 ExecutionArtifacts

Resource IDs accumulated during pipeline execution.

```typescript
interface ExecutionArtifacts {
  /** Workspace GUID from Step 0. */
  workspaceId: string | null;
  /** Workspace object ID. */
  workspaceObjectId: string | null;
  /** Capacity GUID confirmed by Step 1. */
  capacityId: string | null;
  /** Lakehouse GUID from Step 2. */
  lakehouseId: string | null;
  /** Notebook GUID from Step 3. */
  notebookId: string | null;
  /** Job instance ID from Step 5 (LRO polling). */
  jobInstanceId: string | null;
  /** Final notebook run status. */
  notebookRunStatus: string | null;
  /** Workspace URL for post-success navigation. */
  workspaceUrl: string | null;
}
```

### 4.6 StepError

Error details for a failed step.

```typescript
interface StepError {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Technical detail. */
  detail: string | null;
  /** HTTP status code (null for network errors). */
  httpStatus: number | null;
  /** Error category. */
  category: ErrorCategory;
  /** Whether retryable. */
  retryable: boolean;
}

type ErrorCategory =
  | 'network'       // Fetch error, DNS, timeout
  | 'auth'          // 401/403
  | 'conflict'      // 409
  | 'not_found'     // 404
  | 'rate_limit'    // 429
  | 'server_error'  // 5xx
  | 'validation'    // 400
  | 'lro_timeout'   // LRO polling exceeded max duration
  | 'lro_failed'    // LRO completed with Failed status
  | 'unknown';
```

### 4.7 ExecutionArtifact

A single resource created by a step (used in SSE `step:complete` events).

```typescript
interface ExecutionArtifact {
  /** Resource type. */
  type: 'workspace' | 'lakehouse' | 'notebook' | 'capacity-assignment'
      | 'notebook-content' | 'notebook-job';
  /** Resource GUID. */
  id: string;
  /** Resource display name. */
  displayName: string;
  /** Resource URL (for navigation). */
  url: string | null;
}
```

### 4.8 RollbackResource

A resource tracked in the rollback manifest for cleanup on failure.

```typescript
interface RollbackResource {
  /** Resource type determines the DELETE endpoint. */
  type: 'workspace' | 'lakehouse' | 'notebook';
  /** Resource GUID. */
  id: string;
  /** Human-readable name for log output. */
  displayName: string;
  /** The pipeline step that created this resource. */
  createdByStep: 'create-workspace' | 'create-lakehouse' | 'create-notebook';
  /** Parent workspace ID (needed for sub-resource DELETE URLs). */
  parentWorkspaceId?: string;
}
```

### 4.9 ErrorEnvelope

Standard error format used across ALL endpoints.

```typescript
interface ErrorEnvelope {
  /** Always false for errors. */
  ok: false;
  /** Machine-readable error code (SCREAMING_SNAKE_CASE). */
  error: string;
  /** Human-readable error message for UI display. */
  message: string;
  /** Optional technical detail. */
  detail: string | object | string[] | null;
  /** Whether the frontend should offer a Retry button. */
  retryable: boolean;
}
```

### 4.10 Template File Schema

The on-disk `edog-templates.json` file format.

```typescript
interface TemplateFile {
  /** Optional JSON schema URL. */
  $schema?: string;
  /** File-level schema version. Current: 1. */
  version: number;
  /** Array of saved templates. May be empty []. */
  templates: TemplateData[];
}
```

---

## 5. Sequence Diagrams

### 5.1 Happy Path -- Wizard Completion to Navigation

```
  User               Frontend (Browser)                Python Backend               Fabric API
   |                       |                                |                          |
   |  Click "New Env"      |                                |                          |
   |---------------------->|                                |                          |
   |                       |                                |                          |
   |                       |  GET /api/wizard/capacities    |                          |
   |                       |------------------------------->|                          |
   |                       |                                |  GET /v1.0/myorg/caps    |
   |                       |                                |------------------------->|
   |                       |                                |  200 { value: [...] }    |
   |                       |                                |<-------------------------|
   |                       |  200 { capacities: [...] }     |                          |
   |                       |<-------------------------------|                          |
   |                       |                                |                          |
   |  Fill Pages 1-4       |                                |                          |
   |  Click "Lock In"      |                                |                          |
   |---------------------->|                                |                          |
   |                       |                                |                          |
   |                       |  POST /api/wizard/execute      |                          |
   |                       |  { workspaceName, capacityId,  |                          |
   |                       |    lakehouseName, dag, cells }  |                          |
   |                       |------------------------------->|                          |
   |                       |                                |  (validate request)      |
   |                       |  202 { executionId, sseUrl }   |                          |
   |                       |<-------------------------------|                          |
   |                       |                                |                          |
   |                       |  GET .../events (SSE open)     |                          |
   |                       |===============================>|                          |
   |                       |                                |                          |
   |  See Step 0 running   |  <== step:start {0}           |                          |
   |<----------------------|                                |  POST /metadata/folders  |
   |                       |                                |------------------------->|
   |                       |                                |  200 [{ objectId }]      |
   |                       |                                |<-------------------------|
   |  See Step 0 done      |  <== step:complete {0, ws-id}  |                          |
   |<----------------------|                                |                          |
   |                       |                                |  POST .../assignToCapac  |
   |  See Step 1 running   |  <== step:start {1}           |------------------------->|
   |<----------------------|                                |  202                     |
   |                       |  <== step:complete {1}         |<-------------------------|
   |                       |                                |                          |
   |  ... steps 2-4 ...    |  ... SSE events ...            |  ... Fabric calls ...    |
   |                       |                                |                          |
   |  See Step 5 running   |  <== step:start {5}           |  POST .../RunNotebook    |
   |<----------------------|                                |------------------------->|
   |                       |                                |  202 (LRO)               |
   |                       |  <== step:progress             |<-------------------------|
   |                       |    "Polling... InProgress"     |  GET .../jobs/:id        |
   |                       |                                |------------------------->|
   |                       |                                |  200 {status:InProgress} |
   |                       |                                |<-------------------------|
   |                       |  <== step:progress             |  GET .../jobs/:id        |
   |                       |    "Polling... InProgress"     |------------------------->|
   |                       |                                |  200 {status:Completed}  |
   |                       |                                |<-------------------------|
   |                       |  <== step:complete {5}         |                          |
   |  See all steps done   |                                |                          |
   |<----------------------|  <== pipeline:complete          |                          |
   |                       |    { totalDurationMs, etc. }   |                          |
   |                       |                                |                          |
   |                       |  eventSource.close()           |                          |
   |                       |                                |                          |
   |  Click "Navigate"     |                                |                          |
   |---------------------->|  Navigate to workspace         |                          |
   |                       |  in explorer panel             |                          |
```

### 5.2 Failure at Step 3 + User Retry

```
  User               Frontend (Browser)                Python Backend               Fabric API
   |                       |                                |                          |
   |                       |  (Steps 0-2 complete OK)       |                          |
   |                       |  <== step:start {3}            |                          |
   |  See Step 3 running   |                                |  POST .../notebooks      |
   |<----------------------|                                |------------------------->|
   |                       |                                |  500 Internal Error      |
   |                       |                                |<-------------------------|
   |                       |  <== step:progress             |                          |
   |                       |    "Retrying in 1s (1/3)"      |                          |
   |                       |                                |  POST .../notebooks      |
   |                       |                                |------------------------->|
   |                       |                                |  500 Internal Error      |
   |                       |                                |<-------------------------|
   |                       |  <== step:progress             |                          |
   |                       |    "Retrying in 2s (2/3)"      |                          |
   |                       |                                |  POST .../notebooks      |
   |                       |                                |------------------------->|
   |                       |                                |  500 Internal Error      |
   |                       |                                |<-------------------------|
   |                       |                                |                          |
   |  See error panel      |  <== step:failed {3, 500}     |                          |
   |<----------------------|  <== pipeline:failed            |                          |
   |                       |    { canRetry: true }          |                          |
   |                       |                                |                          |
   |  Click "Retry"        |                                |                          |
   |---------------------->|                                |                          |
   |                       |  POST .../retry                |                          |
   |                       |  { fromStepIndex: 3 }          |                          |
   |                       |------------------------------->|                          |
   |                       |  202 { status: "retrying" }    |                          |
   |                       |<-------------------------------|                          |
   |                       |                                |                          |
   |                       |  GET .../events (reconnect)    |                          |
   |                       |===============================>|                          |
   |                       |                                |                          |
   |  Steps 0-2 dimmed     |  <== step:start {3}           |  POST .../notebooks      |
   |  Step 3 retrying      |                                |------------------------->|
   |<----------------------|                                |  201 { id: nb-guid }     |
   |                       |                                |<-------------------------|
   |  Step 3 now done!     |  <== step:complete {3}        |                          |
   |<----------------------|                                |                          |
   |                       |  (Steps 4-5 continue...)      |                          |
   |                       |  <== pipeline:complete          |                          |
   |  All steps done!      |                                |                          |
   |<----------------------|                                |                          |
```

### 5.3 Minimize During Execution + Restore

```
  User               Frontend (Browser)                Python Backend
   |                       |                                |
   |                       |  (Execution in progress,       |
   |                       |   Step 2 running)              |
   |                       |                                |
   |  Click X (close)      |                                |
   |---------------------->|                                |
   |                       |  Dialog hides (display:none)   |
   |                       |  FloatingBadge appears:        |
   |  See floating badge:  |  "3/6 Creating Lakehouse..."  |
   |  "3/6 Creating LH"   |                                |
   |<----------------------|                                |
   |                       |  SSE stream CONTINUES          |
   |                       |  <== step:complete {2}         |
   |                       |  <== step:start {3}            |
   |  Badge updates:       |  Badge text updates on each    |
   |  "4/6 Creating NB"   |  SSE event                     |
   |<----------------------|                                |
   |                       |                                |
   |  (User works in       |                                |
   |   explorer panel)     |  <== step:complete {3}         |
   |                       |  <== step:start {4}            |
   |                       |  <== step:complete {4}         |
   |                       |  <== step:start {5}            |
   |                       |  <== step:progress (polling)   |
   |                       |  <== step:complete {5}         |
   |  Badge turns green:   |  <== pipeline:complete          |
   |  "Done! Click to      |                                |
   |   view workspace"     |                                |
   |<----------------------|                                |
   |                       |                                |
   |  Click badge          |                                |
   |---------------------->|                                |
   |                       |  FloatingBadge hides           |
   |                       |  Dialog restores (display:flex)|
   |  See success page     |  Shows completion summary:     |
   |  with all green       |  all 6 steps done, "Navigate"  |
   |<----------------------|                                |
```

### 5.4 Template Save + Load Flow

```
  User               Frontend (Browser)                Python Backend           Filesystem
   |                       |                                |                       |
   |  === SAVE TEMPLATE ===|                                |                       |
   |                       |                                |                       |
   |  Click "Save as       |                                |                       |
   |  Template" (Page 4)   |                                |                       |
   |---------------------->|                                |                       |
   |                       |  Collect wizard state:         |                       |
   |  Type name:           |  infrastructure + schemas +    |                       |
   |  "My Layout"          |  theme + dag topology          |                       |
   |---------------------->|                                |                       |
   |                       |  POST /api/templates/save      |                       |
   |                       |  { name, state, overwrite }    |                       |
   |                       |------------------------------->|                       |
   |                       |                                |  Read templates file   |
   |                       |                                |--------------------->|
   |                       |                                |  <---------------------  |
   |                       |                                |  Validate name         |
   |                       |                                |  Compute metadata      |
   |                       |                                |  Generate tmpl_id      |
   |                       |                                |  Atomic write          |
   |                       |                                |--------------------->|
   |                       |                                |  <---------------------  |
   |                       |  201 { template, created }     |                       |
   |  See "Saved!" toast   |<-------------------------------|                       |
   |<----------------------|                                |                       |
   |                       |                                |                       |
   |  === LOAD TEMPLATE ===|                                |                       |
   |                       |                                |                       |
   |  Open wizard          |                                |                       |
   |  Click "Load Template"|                                |                       |
   |---------------------->|                                |                       |
   |                       |  GET /api/templates/list       |                       |
   |                       |------------------------------->|                       |
   |                       |                                |  Read templates file   |
   |                       |                                |--------------------->|
   |                       |                                |  <---------------------  |
   |                       |  200 { templates: [...] }      |                       |
   |  See template list    |<-------------------------------|                       |
   |<----------------------|                                |                       |
   |                       |                                |                       |
   |  Click "My Layout"    |                                |                       |
   |---------------------->|                                |                       |
   |                       |  GET /api/templates/load       |                       |
   |                       |  ?name=My%20Layout             |                       |
   |                       |------------------------------->|                       |
   |                       |                                |  Read + find template  |
   |                       |                                |  Apply migrations      |
   |                       |  200 { template: { state } }   |                       |
   |                       |<-------------------------------|                       |
   |                       |                                |                       |
   |  Wizard pre-fills     |  wizardShell.setState(state)   |                       |
   |  all 4 pages from     |  dagCanvas.importTopology()    |                       |
   |  template data        |                                |                       |
   |<----------------------|                                |                       |
```

### 5.5 SSE Reconnection After Network Blip

```
  Frontend (Browser)                   Python Backend
   |                                        |
   |  GET .../events (SSE connection open)  |
   |=======================================>|
   |                                        |
   |  id:1  event:step:start {0}           |
   |<=======================================|
   |  id:2  event:step:complete {0}        |
   |<=======================================|
   |  id:3  event:step:start {1}           |
   |<=======================================|
   |                                        |
   |  === NETWORK BLIP ===                 |
   |  Connection drops                      |
   |  x--------------x                     |
   |                                        |
   |  (Backend continues execution,         |
   |   buffers events in memory)            |
   |                                        |  id:4  step:complete {1}  -> buffer
   |                                        |  id:5  step:start {2}    -> buffer
   |                                        |  id:6  step:complete {2} -> buffer
   |                                        |
   |  Browser auto-reconnects (3s delay)    |
   |  GET .../events                        |
   |  Last-Event-ID: 3                      |
   |=======================================>|
   |                                        |
   |  Server replays events 4, 5, 6         |
   |  id:4  event:step:complete {1}        |
   |<=======================================|
   |  id:5  event:step:start {2}           |
   |<=======================================|
   |  id:6  event:step:complete {2}        |
   |<=======================================|
   |                                        |
   |  Then continues with live events:      |
   |  id:7  event:step:start {3}           |
   |<=======================================|
   |                                        |
   |  Frontend catches up seamlessly.       |
   |  No events lost. UI consistent.        |
```

### 5.6 Full Rollback After Failure

```
  User               Frontend (Browser)                Python Backend               Fabric API
   |                       |                                |                          |
   |  (Pipeline failed     |  <== pipeline:failed           |                          |
   |   at Step 3)          |   { canRollback: true }       |                          |
   |                       |                                |                          |
   |  Click "Rollback      |                                |                          |
   |  & Start Over"        |                                |                          |
   |---------------------->|                                |                          |
   |                       |  POST .../rollback             |                          |
   |                       |------------------------------->|                          |
   |                       |  202 { rolling_back }          |                          |
   |                       |<-------------------------------|                          |
   |                       |                                |                          |
   |                       |  (SSE stream for rollback)     |                          |
   |                       |  <== rollback:start            |                          |
   |  "Rolling back..."    |   { resourceCount: 2 }        |                          |
   |<----------------------|                                |                          |
   |                       |  <== rollback:step             |  DELETE .../lh/:id       |
   |  "Deleting LH..."     |   { 0, lakehouse, deleting }  |------------------------->|
   |<----------------------|                                |  200 OK                  |
   |                       |  <== rollback:step             |<-------------------------|
   |  "LH deleted"         |   { 0, lakehouse, deleted }   |                          |
   |<----------------------|                                |                          |
   |                       |  <== rollback:step             |  DELETE /v1/ws/:id       |
   |  "Deleting WS..."     |   { 1, workspace, deleting }  |------------------------->|
   |<----------------------|                                |  200 OK                  |
   |                       |  <== rollback:step             |<-------------------------|
   |  "WS deleted"         |   { 1, workspace, deleted }   |                          |
   |<----------------------|                                |                          |
   |                       |  <== rollback:complete          |                          |
   |  "All cleaned up"     |   { success: true }           |                          |
   |  + "Start Over" btn   |                                |                          |
   |<----------------------|                                |                          |
   |                       |                                |                          |
   |  Click "Start Over"   |  Reset wizard to Page 1       |                          |
   |---------------------->|  Clear all state               |                          |
```

---

## 6. Error Contract

### 6.1 Error Code Catalog

Every error code that can be returned by the wizard backend, with meaning and recommended UI handling.

| Error Code | HTTP | Category | Retryable | UI Handling |
|-----------|------|----------|-----------|-------------|
| `AUTH_TOKEN_EXPIRED` | 401 | `auth` | No | Show "Authentication expired. Re-run token acquisition." Disable all actions. |
| `AUTH_INSUFFICIENT_PERMISSIONS` | 403 | `auth` | No | Show "You don't have permission for this action." |
| `FABRIC_API_ERROR` | 502 | `server_error` | Yes | Show error + "Retry" button. |
| `FABRIC_API_TIMEOUT` | 504 | `network` | Yes | Show "Fabric API not responding." + "Retry". |
| `FABRIC_API_RATE_LIMITED` | 429 | `rate_limit` | Yes | Show "Too many requests. Wait and retry." Auto-retry after `Retry-After`. |
| `NETWORK_ERROR` | 0 | `network` | Yes | Show "Network error. Check connection." + "Retry". |
| `VALIDATION_ERROR` | 400 | `validation` | No | Show validation errors inline on form fields. |
| `MISSING_PARAMETER` | 400 | `validation` | No | Show "Required field missing." |
| `WORKSPACE_NAME_CONFLICT` | 409 | `conflict` | No | Show "Name exists. Choose different name." + navigate to Page 1. |
| `EXECUTION_ALREADY_RUNNING` | 409 | `conflict` | No | Show "Another execution in progress." Disable execute button. |
| `EXECUTION_NOT_FOUND` | 404 | `not_found` | No | Show "Execution session expired." |
| `EXECUTION_EXPIRED` | 410 | `not_found` | No | Redirect to status endpoint for final state. |
| `INVALID_RETRY` | 400 | `validation` | No | Show "Cannot retry: pipeline not in failed state." |
| `STEP_INDEX_MISMATCH` | 400 | `validation` | No | Show "Step index does not match failed step." |
| `RETRY_LIMIT_EXCEEDED` | 429 | `rate_limit` | No | Show "Max retries reached. Consider rollback." |
| `INVALID_ROLLBACK` | 400 | `validation` | No | Show "Cannot rollback: pipeline not in failed state." |
| `NOTHING_TO_ROLLBACK` | 400 | `validation` | No | Show "No resources to clean up." |
| `ROLLBACK_PARTIAL_FAILURE` | 207 | `server_error` | Yes | Show which deletions succeeded/failed + manual cleanup instructions. |
| `TEMPLATE_FILE_CORRUPT` | 500 | `server_error` | No | Show "Template file corrupted. Backup created." |
| `TEMPLATE_NOT_FOUND` | 404 | `not_found` | No | Show "Template not found." Remove from list. |
| `TEMPLATE_NAME_EXISTS` | 409 | `conflict` | No | Show "Template exists. Overwrite?" with confirm dialog. |
| `TEMPLATE_VERSION_TOO_NEW` | 409 | `conflict` | No | Show "Template needs newer EDOG Studio version." |
| `LRO_TIMEOUT` | 504 | `lro_timeout` | Yes | Show "Notebook execution timed out." + "Retry" + Fabric portal link. |
| `LRO_FAILED` | 500 | `lro_failed` | Yes | Show "Notebook execution failed: {reason}." + "Retry" + "Rollback". |
| `INTERNAL_ERROR` | 500 | `unknown` | Yes | Show "Unexpected error." + raw detail in collapsible panel. |

### 6.2 HTTP Status Code Mapping

| HTTP Status | Meaning | Envelope |
|------------|---------|----------|
| 200 | Success | `{ ok: true, ... }` |
| 201 | Created | `{ ok: true, created: true, ... }` |
| 202 | Accepted (async) | `{ ok: true, executionId: "...", ... }` |
| 400 | Bad Request | `{ ok: false, error: "VALIDATION_ERROR", ... }` |
| 401 | Unauthorized | `{ ok: false, error: "AUTH_TOKEN_EXPIRED", ... }` |
| 403 | Forbidden | `{ ok: false, error: "AUTH_INSUFFICIENT_PERMISSIONS", ... }` |
| 404 | Not Found | `{ ok: false, error: "*_NOT_FOUND", ... }` |
| 409 | Conflict | `{ ok: false, error: "*_CONFLICT" or "*_EXISTS", ... }` |
| 410 | Gone | `{ ok: false, error: "EXECUTION_EXPIRED", ... }` |
| 429 | Too Many Requests | `{ ok: false, error: "*_RATE_LIMITED" or "RETRY_LIMIT_EXCEEDED", ... }` |
| 500 | Internal Error | `{ ok: false, error: "INTERNAL_ERROR", ... }` |
| 502 | Bad Gateway | `{ ok: false, error: "FABRIC_API_ERROR", ... }` |
| 504 | Gateway Timeout | `{ ok: false, error: "FABRIC_API_TIMEOUT", ... }` |

### 6.3 Retry Guidance Per Error Category

| Category | Auto-Retry | User-Retry | Backoff | Max Retries |
|----------|-----------|------------|---------|-------------|
| `network` | Yes | Yes | Exponential: 1s, 2s, 4s | 3 |
| `auth` | No | No | N/A | 0 |
| `conflict` | No | No | N/A | 0 |
| `not_found` | No | No | N/A | 0 |
| `rate_limit` | Yes | Yes | Respect `Retry-After`, else 5s, 10s, 20s | 3 |
| `server_error` | Yes | Yes | Exponential: 1s, 2s, 4s | 3 |
| `validation` | No | No | N/A | 0 |
| `lro_timeout` | No (auto) | Yes | N/A | 1 |
| `lro_failed` | No (auto) | Yes | 5s fixed | 1 |
| `unknown` | Yes | Yes | 2s, 4s, 8s | 2 |

### 6.4 Frontend Error Handling Pattern

```javascript
async function callWizardApi(path, options = {}) {
  try {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });

    const data = await response.json();

    if (!data.ok) {
      const error = new WizardApiError(data.error, data.message, {
        httpStatus: response.status,
        detail: data.detail,
        retryable: data.retryable,
      });
      throw error;
    }

    return data;
  } catch (err) {
    if (err instanceof WizardApiError) throw err;

    // Network error (fetch failed entirely)
    throw new WizardApiError('NETWORK_ERROR', 'Network error. Check your connection.', {
      httpStatus: 0,
      detail: err.message,
      retryable: true,
    });
  }
}
```

---

## 7. Versioning and Compatibility

### 7.1 API Versioning Strategy

The wizard API uses **path-prefix versioning** for future-proofing, but starts unversioned.

**Current (v1, implicit):**
```
/api/wizard/capacities
/api/wizard/execute
/api/templates/list
```

**Future (if breaking changes needed):**
```
/api/v2/wizard/capacities
/api/v2/wizard/execute
/api/v2/templates/list
```

**Rationale:** Since EDOG Studio is a local development tool (not a public API), the overhead of header-based versioning is not justified. Path prefixing is simpler and more debuggable with curl.

**Transition rules:**
- Old paths continue to work (never removed)
- New paths are introduced with `v2` prefix
- Frontend detection: if `GET /api/v2/wizard/capacities` returns 404, fall back to `/api/wizard/capacities`

### 7.2 Template Format Versioning

Templates use an **integer version field** with sequential migration functions.

```
edog-templates.json:
{
  "version": 1,             <-- File-level version
  "templates": [
    { "version": 1, ... }   <-- Per-template version
  ]
}
```

**Version rules:**
1. The `version` field is incremented when the template state schema changes
2. Migrations are pure functions: `(v1_template) => v2_template`
3. Migrations NEVER delete user data, only add/restructure fields
4. Loading a template with version > current code => reject with `TEMPLATE_VERSION_TOO_NEW`
5. Loading a template with version < current => apply migrations sequentially
6. Saving always writes at the current version

**Migration registry pattern:**
```python
CURRENT_TEMPLATE_VERSION = 1

MIGRATIONS = {
    # 2: lambda t: { **t, "version": 2, "state": { **t["state"], "newField": "default" } },
}
```

### 7.3 SSE Event Versioning

SSE events are versioned via the event type name. If a payload schema changes in a breaking way:

**Non-breaking (additive):** Add new fields to existing event payloads. Frontend ignores unknown fields.
```
# Before:
event: step:complete
data: {"stepIndex":0,"durationMs":2100}

# After (additive, non-breaking):
event: step:complete
data: {"stepIndex":0,"durationMs":2100,"newMetric":"value"}
```

**Breaking:** Introduce a new event type with a version suffix.
```
# Old (kept for backward compatibility):
event: step:complete
data: {"stepIndex":0,"durationMs":2100}

# New:
event: step:complete:v2
data: {"stepIndex":0,"timing":{"durationMs":2100,"startedAt":1720000000000}}
```

### 7.4 Execution ID Format

Execution IDs follow the pattern `exec_{timestamp}_{random6hex}`:
```
exec_1720000000000_f7e8d9
^^^^  ^^^^^^^^^^^^^  ^^^^^^
|     |              |
|     |              +-- 6 random hex chars
|     +-- Unix timestamp in milliseconds
+-- Prefix
```

This format is stable and will not change across versions.

### 7.5 Forward Compatibility Rules

| Component | Rule |
|-----------|------|
| **REST responses** | Frontend MUST ignore unknown fields. Backend MAY add new fields. |
| **REST requests** | Backend MUST ignore unknown fields. Frontend MAY send extra fields. |
| **SSE events** | Frontend MUST ignore unknown event types. Backend MAY add new types. |
| **SSE payloads** | Frontend MUST ignore unknown fields in event data. |
| **Templates** | Frontend MUST reject templates with version > CURRENT. Backend migrates version < CURRENT. |
| **Error codes** | Frontend MUST handle unknown error codes gracefully (display message, treat as non-retryable). |

### 7.6 Backward Compatibility Rules

| Change Type | Allowed? | Migration Required? |
|------------|----------|-------------------|
| Add new REST endpoint | Yes | No |
| Add new field to response | Yes | No |
| Remove field from response | No | Yes (version bump) |
| Rename field | No | Yes (version bump) |
| Change field type | No | Yes (version bump) |
| Add new SSE event type | Yes | No |
| Add field to SSE payload | Yes | No |
| Add new error code | Yes | No |
| Remove error code | No | Document deprecation first |

---

## Appendix A: Backend Route Registration

Complete list of routes to add to `edog.py`:

```python
# --- do_GET additions ---
elif self.path == '/api/wizard/capacities':
    self._handle_wizard_capacities()
elif self.path == '/api/templates/list':
    self._handle_templates_list()
elif self.path.startswith('/api/templates/load'):
    self._handle_templates_load()
elif self.path.startswith('/api/wizard/execute/') and self.path.endswith('/events'):
    self._handle_execution_sse()
elif self.path.startswith('/api/wizard/execute/') and self.path.endswith('/status'):
    self._handle_execution_status()

# --- do_POST additions ---
elif self.path == '/api/wizard/execute':
    self._handle_wizard_execute()
elif self.path.startswith('/api/wizard/execute/') and self.path.endswith('/retry'):
    self._handle_execution_retry()
elif self.path.startswith('/api/wizard/execute/') and self.path.endswith('/rollback'):
    self._handle_execution_rollback()
elif self.path == '/api/templates/save':
    self._handle_templates_save()
elif self.path == '/api/templates/delete':
    self._handle_templates_delete()
elif self.path == '/api/wizard/validate/workspace-name':
    self._handle_validate_workspace_name()
```

## Appendix B: Fabric API Calls Made by Backend

The Python backend proxies these Fabric API calls during execution. Listed in pipeline order.

| Step | Fabric Endpoint | Method | Body | Expected Response |
|------|----------------|--------|------|-------------------|
| 0: Create Workspace | `/metadata/folders` | POST | `{ capacityObjectId, displayName, description, isServiceApp: false, datasetStorageMode: 1 }` | `200 [{ id, displayName, objectId }]` |
| 1: Assign Capacity | `/v1/workspaces/{wsId}/assignToCapacity` | POST | `{ capacityId }` | `200` or `202` |
| 2: Create Lakehouse | `/v1/workspaces/{wsId}/lakehouses` | POST | `{ displayName, enableSchemas: true }` | `201 { id, displayName }` |
| 3: Create Notebook | `/v1/workspaces/{wsId}/notebooks` | POST | `{ displayName, description }` | `201 { id, displayName }` |
| 4: Write Cells | `/v1/workspaces/{wsId}/notebooks/{nbId}/updateDefinition` | POST | `{ definition: { parts: [{ path, payloadType, payload }] } }` | `200` |
| 5: Run Notebook | `/v1/workspaces/{wsId}/items/{nbId}/jobs/instances?jobType=RunNotebook` | POST | (empty) | `202` + Location header |
| 5: Poll Job | `/v1/workspaces/{wsId}/items/{nbId}/jobs/instances/{jobId}` | GET | -- | `200 { status, failureReason }` |
| Rollback: Delete NB | `/v1/workspaces/{wsId}/notebooks/{nbId}` | DELETE | -- | `200` |
| Rollback: Delete LH | `/v1/workspaces/{wsId}/lakehouses/{lhId}` | DELETE | -- | `200` |
| Rollback: Delete WS | `/v1/workspaces/{wsId}` | DELETE | -- | `200` |
| Validate: List WS | `/v1.0/myorg/groups` | GET | -- | `200 { value: [...] }` |
| Capacities: List | `/v1.0/myorg/capacities` | GET | -- | `200 { value: [...] }` |

## Appendix C: Frontend Integration Checklist

```
[ ] Import WizardApiClient (new class wrapping fetch calls to /api/wizard/*)
[ ] Wire InfraSetupPage capacity dropdown to GET /api/wizard/capacities
[ ] Wire InfraSetupPage workspace name blur to POST /api/wizard/validate/workspace-name
[ ] Wire TemplateManager.listTemplates() to GET /api/templates/list
[ ] Wire TemplateManager.loadTemplate(name) to GET /api/templates/load?name=
[ ] Wire TemplateManager.saveTemplate(name, state) to POST /api/templates/save
[ ] Wire TemplateManager.deleteTemplate(name) to POST /api/templates/delete
[ ] Wire ExecutionPipeline.start() to POST /api/wizard/execute
[ ] Wire ExecutionPipeline to open EventSource on /api/wizard/execute/:id/events
[ ] Handle all 10 SSE event types (step:start, step:progress, step:complete,
    step:failed, pipeline:complete, pipeline:failed, rollback:start,
    rollback:step, rollback:complete, heartbeat)
[ ] Wire retry button to POST /api/wizard/execute/:id/retry
[ ] Wire rollback button to POST /api/wizard/execute/:id/rollback
[ ] Implement SSE reconnection with Last-Event-ID
[ ] Implement polling fallback (GET .../status) for SSE failure
[ ] Handle all error codes from section 6.1 with appropriate UI messaging
[ ] Ignore unknown fields in all responses (forward compatibility)
[ ] Ignore unknown SSE event types (forward compatibility)
```

## Appendix D: Backend Implementation Checklist

```
[ ] Add all route handlers to edog.py do_GET() and do_POST()
[ ] Implement /api/wizard/capacities (proxy to Fabric + cache 60s)
[ ] Implement /api/wizard/validate/workspace-name (check against workspace list)
[ ] Implement /api/wizard/execute (validate, generate execId, start pipeline thread)
[ ] Implement /api/wizard/execute/:id/events (SSE stream with event buffer)
[ ] Implement /api/wizard/execute/:id/status (JSON snapshot of execution state)
[ ] Implement /api/wizard/execute/:id/retry (validate state, resume from failed step)
[ ] Implement /api/wizard/execute/:id/rollback (reverse-order resource deletion)
[ ] Implement /api/templates/list (read edog-templates.json, strip state)
[ ] Implement /api/templates/load (read by name, version check, migration)
[ ] Implement /api/templates/save (validate name, atomic write, compute metadata)
[ ] Implement /api/templates/delete (remove by name, atomic write)
[ ] Implement SSE heartbeat (comment line every 15 seconds)
[ ] Implement SSE event buffer (last 100 events per execution for reconnection)
[ ] Implement Last-Event-ID replay on SSE reconnection
[ ] Use consistent error envelope format for ALL responses
[ ] Proxy all Fabric API calls with Bearer token injection
[ ] Implement execution state machine (idle -> executing -> succeeded/failed)
[ ] Implement step auto-retry with exponential backoff
[ ] Implement LRO polling for notebook execution (step 5)
[ ] Implement rollback manifest tracking (add on each resource creation)
[ ] Implement reverse-order deletion for rollback
[ ] Thread-safe execution state (only one execution at a time)
```
