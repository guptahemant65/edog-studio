# P2 — Backend Execution Engine & Persistence Architecture

> **Feature:** F16 — New Infra Wizard
> **Owner:** Vex (Backend Systems Engineer)
> **Status:** Draft
> **Version:** 1.0.0
> **Last Updated:** 2025-07-19
> **Depends On:** P0 (Code Audit), P1 (C10-ExecutionPipeline, C12-TemplateManager, C08-CodePreviewPanel, C06-DagNode)
> **Consumes:** `docs/fabric-api-reference.md` (tested API endpoints), `scripts/dev-server.py` (proxy patterns)

---

## Table of Contents

1. [Execution Engine Architecture](#1-execution-engine-architecture)
2. [API Integration Layer](#2-api-integration-layer)
3. [Notebook Cell Construction](#3-notebook-cell-construction)
4. [Retry & Rollback Engine](#4-retry--rollback-engine)
5. [Template Persistence](#5-template-persistence)
6. [Frontend-Backend Communication](#6-frontendbackend-communication)
7. [Error Handling & Logging](#7-error-handling--logging)
8. [Security](#8-security)
9. [Testing Strategy](#9-testing-strategy)

---

## 1. Execution Engine Architecture

### 1.1 Architecture Decision: Client-Orchestrated Pipeline

The F16 execution pipeline is **client-orchestrated** — the browser JS (C10-ExecutionPipeline) drives the sequential API calls, NOT the Python dev-server. This was a deliberate P1 design decision documented in C10 §1.5:

> "Does NOT use SSE/WebSocket — unlike the existing `DeployFlow` class which uses Server-Sent Events, the execution pipeline is **client-orchestrated**. Each step is a sequential `fetch()` call. The browser IS the orchestrator."

**Why client-orchestrated, not server-driven?**

| Factor | Client-Orchestrated (chosen) | Server-Driven (rejected) |
|--------|------------------------------|--------------------------|
| Simplicity | Frontend `async/await` chain | SSE stream + Python async + state sync |
| Step artifacts | Available in memory immediately | Must serialize through event stream |
| Retry | Reset state + re-call | Complex server-side state machine |
| Minimize/restore | DOM show/hide, execution continues in JS event loop | Must maintain progress channel while wizard is hidden |
| Browser refresh | Execution lost (acceptable — resources are in rollback manifest) | Server could resume, but adds massive complexity |
| Token management | Bearer token already in `FabricApiClient` | Must pass token to server or share cache |

**The Python backend's role is limited to:**
1. **Proxy**: Forward `/api/fabric/*` requests to the redirect host with Bearer token injection (existing pattern)
2. **Template CRUD**: 4 new REST routes for template file I/O
3. **Wizard execution trigger**: 1 new POST route that validates the execution context and returns OK (letting the client proceed with direct API calls through the proxy)

### 1.2 Pipeline Executor — Client-Side Class Design

The execution engine lives in C10-ExecutionPipeline (frontend JS). Here is the full pipeline executor architecture with Python backend integration points:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (C10-ExecutionPipeline)                                     │
│                                                                      │
│  ExecutionPipeline                                                   │
│    ├── _context: ExecutionContext (frozen, from Pages 1-4)           │
│    ├── _state: PipelineState (mutable, drives UI rendering)         │
│    ├── _stepDefinitions: StepDefinition[6] (static registry)        │
│    ├── _apiClient: FabricApiClient (injected)                       │
│    └── _artifacts: ExecutionArtifacts (grows step-by-step)          │
│                                                                      │
│  Execution Flow:                                                     │
│    start() → for each step in [0..5]:                                │
│      1. _executeStep(i)                                              │
│         a. prepare: build URL + body from context + artifacts        │
│         b. execute: fetch() through FabricApiClient proxy            │
│         c. poll (if LRO): _pollLRO() with exponential backoff       │
│         d. validate: check HTTP status against expectedStatus        │
│         e. record: extractArtifacts() → merge into _artifacts        │
│         f. track: _trackResource() → add to rollback manifest        │
│      2. On success → advance to step i+1                             │
│      3. On failure → auto-retry (up to N) or transition to failed   │
│                                                                      │
│  ┌─────────── fetch() ──────────────────────────────────────┐       │
│  │                                                           │       │
│  │  FabricApiClient._fabricFetch(path, options)             │       │
│  │    → GET/POST/DELETE http://localhost:5555/api/fabric/*   │       │
│  │    → Authorization: Bearer {token} injected server-side   │       │
│  │                                                           │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                         │                            │
└─────────────────────────────────────────┼────────────────────────────┘
                                          │ HTTP
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Python dev-server.py (port 5555)                                    │
│                                                                      │
│  do_GET / do_POST / do_DELETE / do_PATCH                             │
│    ├── /api/fabric/*  → _proxy_fabric(method)                       │
│    │     ├── Reads Bearer token from .edog-bearer-cache              │
│    │     ├── Injects Authorization header                            │
│    │     ├── Forwards to REDIRECT_HOST                               │
│    │     └── Returns response to browser                             │
│    │                                                                 │
│    ├── GET  /api/templates/list   → _handle_templates_list()        │
│    ├── GET  /api/templates/load   → _handle_templates_load()        │
│    ├── POST /api/templates/save   → _handle_templates_save()        │
│    └── POST /api/templates/delete → _handle_templates_delete()      │
│                                                                      │
│  All Fabric API calls are PROXIED — the Python server does NOT       │
│  make Fabric API calls itself for the execution pipeline.            │
└─────────────────────────────────────────────────────────────────────┘
                                          │ HTTPS
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Fabric Redirect Host                                                │
│  https://biazure-int-edog-redirect.analysis-df.windows.net          │
│                                                                      │
│  Routes to:                                                          │
│    /metadata/*  → Metadata service (workspace creation)              │
│    /v1/*        → Fabric v1 REST API (all other operations)          │
│    /v1.0/*      → Power BI REST API (capacities)                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 Step Registry — All 6 Steps

The step registry is a static configuration array defining every pipeline step. Each entry specifies the exact API endpoint, method, payload construction, artifact extraction, and retry/rollback behavior.

| # | Step ID | Name | Method | Endpoint | Expected Status | Is LRO | Creates Resource | Timeout | Auto-Retries |
|---|---------|------|--------|----------|-----------------|---------|-----------------|---------|-------------|
| 0 | `create-workspace` | Create Workspace | POST | `/metadata/folders` | 200, 201 | No | Yes (`workspace`) | 30s | 2 |
| 1 | `assign-capacity` | Assign Capacity | POST | `/v1/workspaces/{workspaceId}/assignToCapacity` | 200, 202 | No | No | 30s | 2 |
| 2 | `create-lakehouse` | Create Lakehouse | POST | `/v1/workspaces/{workspaceId}/lakehouses` | 200, 201 | No | Yes (`lakehouse`) | 60s | 2 |
| 3 | `create-notebook` | Create Notebook | POST | `/v1/workspaces/{workspaceId}/notebooks` | 201 | No | Yes (`notebook`) | 30s | 2 |
| 4 | `write-cells` | Write Notebook Cells | POST | `/v1/workspaces/{wsId}/notebooks/{nbId}/updateDefinition` | 200 | No | No | 30s | 2 |
| 5 | `execute-notebook` | Execute Notebook | POST | `/v1/workspaces/{wsId}/items/{nbId}/jobs/instances?jobType=RunNotebook` | 202 | Yes | No | 300s | 1 |

### 1.4 Step Execution Lifecycle

Every step follows the same lifecycle: **prepare → execute → poll (if LRO) → validate → record artifact → track resource**.

```python
# Pseudocode — runs in the browser as JS, shown here in Python-style for Vex's reference

async def execute_step(step_index: int) -> None:
    step_def = STEP_REGISTRY[step_index]
    step_state = pipeline_state.steps[step_index]

    # ── 1. PREPARE ──────────────────────────────────────────
    update_step(step_index, status='running', started_at=now())
    add_log(step_index, 'info', f"Starting: {step_def.name}...")

    url = interpolate_url(step_def.url_template, artifacts)
    body = step_def.build_body(context, artifacts)

    # ── 2. EXECUTE ──────────────────────────────────────────
    for attempt in range(step_def.auto_retries + 1):
        try:
            response = await api_call(
                method=step_def.method,
                url=url,
                body=body,
                timeout_ms=step_def.timeout_ms
            )

            # ── 3. VALIDATE ─────────────────────────────────
            if response.status not in step_def.expected_status:
                raise StepError(
                    f"Unexpected status {response.status}",
                    http_status=response.status
                )

            # ── 4. POLL (if LRO) ────────────────────────────
            if step_def.is_lro:
                result = await poll_lro(response, step_def.lro_config, step_state)
                if not result.succeeded:
                    raise StepError(result.error_message, category='lro_failed')
                response_data = result.payload
            else:
                response_data = await response.json()

            # ── 5. RECORD ARTIFACT ──────────────────────────
            new_artifacts = step_def.extract_artifacts(response_data)
            merge_into(artifacts, new_artifacts)
            add_log(step_index, 'success',
                     f"Completed in {format_elapsed(step_state.elapsed_ms)}")

            # ── 6. TRACK RESOURCE (for rollback) ────────────
            if step_def.creates_resource:
                track_resource(
                    type=step_def.resource_type,
                    id=new_artifacts.get(f'{step_def.resource_type}Id'),
                    name=context.get(f'{step_def.resource_type}Name'),
                    step_id=step_def.id
                )

            update_step(step_index, status='succeeded')
            return  # Success — exit retry loop

        except StepError as e:
            if attempt < step_def.auto_retries:
                delay = step_def.retry_delay_ms * (2 ** attempt)
                add_log(step_index, 'warning',
                         f"Attempt {attempt + 1} failed ({e.message}). "
                         f"Retrying in {delay}ms...")
                await sleep(delay)
            else:
                # Retries exhausted — fail the step
                update_step(step_index, status='failed', error=e)
                raise PipelineFailure(step_index, e)
```

### 1.5 Artifact Chain

Artifacts flow forward through the pipeline. Each step may produce artifacts consumed by subsequent steps. The artifact chain is:

```
Step 0: Create Workspace
  → produces: workspaceId, workspaceObjectId
  → consumed by: Steps 1, 2, 3, 4, 5

Step 1: Assign Capacity
  → produces: (none — capacityId already in context)
  → consumed by: (none)

Step 2: Create Lakehouse
  → produces: lakehouseId
  → consumed by: (not directly — lakehouse is set as default for notebook)

Step 3: Create Notebook
  → produces: notebookId
  → consumed by: Steps 4, 5

Step 4: Write Cells
  → produces: (none)
  → consumed by: (none)

Step 5: Execute Notebook
  → produces: jobInstanceId, notebookRunStatus
  → consumed by: (none — terminal step)
```

**Artifact Object Shape:**

```python
@dataclass
class ExecutionArtifacts:
    """Grows as the pipeline progresses. None values = not yet populated."""
    workspace_id: str | None = None          # From Step 0
    workspace_object_id: str | None = None   # From Step 0 (metadata API variant)
    capacity_id: str | None = None           # From context (confirmed by Step 1)
    lakehouse_id: str | None = None          # From Step 2
    notebook_id: str | None = None           # From Step 3
    job_instance_id: str | None = None       # From Step 5
    notebook_run_status: str | None = None   # From Step 5 LRO polling
    workspace_url: str | None = None         # Computed: /groups/{workspaceId}
```

### 1.6 Concurrency Control

**Rule: One execution at a time.**

The frontend enforces this via the PipelineState state machine. The `start()` method is guarded:

```javascript
async start() {
    if (this._state.status !== 'idle' && this._state.status !== 'retrying') {
        throw new Error(
            `Cannot start pipeline: current status is '${this._state.status}'. `
            + `Only 'idle' or 'retrying' states allow start().`
        );
    }
    // ...
}
```

On the backend, no mutex is needed because the Python server does not execute the pipeline — it only proxies individual API calls. Each proxied request is stateless.

For template file operations, a `threading.Lock` in `dev-server.py` guards against concurrent reads/writes to `edog-templates.json` (see §5).

---

## 2. API Integration Layer

### 2.1 Proxy Architecture

All Fabric API calls from the F16 wizard flow through the existing proxy in `dev-server.py`:

```
Browser fetch('/api/fabric/v1/workspaces')
  → dev-server.py do_GET('/api/fabric/v1/workspaces')
    → _proxy_fabric('GET')
      → strips '/api/fabric' prefix
      → reads Bearer token from .edog-bearer-cache
      → sends request to REDIRECT_HOST with Authorization header
      → returns response to browser
```

**Key insight from `fabric-api-reference.md`:** The PBI-audience bearer token works against the **redirect host** (`biazure-int-edog-redirect.analysis-df.windows.net`) but **NOT** against the public Fabric API (`api.fabric.microsoft.com`). All F16 calls MUST go through the redirect host via the dev-server proxy.

### 2.2 FabricApiClient Extensions

The existing `FabricApiClient` class in `api-client.js` needs 3 new methods. These follow the established `_fabricFetch()` pattern.

#### 2.2.1 listCapacities()

```javascript
/**
 * List available capacities for the authenticated user.
 *
 * @returns {Promise<Array<{id: string, displayName: string, sku: string,
 *           region: string, state: string}>>}
 *
 * API: GET /v1.0/myorg/capacities
 * Host: redirect (via proxy)
 * Auth: Bearer (PBI audience)
 * Response: { value: [{ id, displayName, sku, region, state, ... }] }
 *
 * Test status: ⚠️ NOT TESTED in PPE — endpoint may require admin scope.
 * Fallback: If 403, try GET /v1/capacities (standard Fabric v1 path).
 */
async listCapacities() {
    // Primary: Power BI REST API path (returns richer data including SKU)
    try {
        const data = await this._fabricFetch('/v1.0/myorg/capacities');
        return (data.value || []).map(cap => ({
            id: cap.id,
            displayName: cap.displayName,
            sku: cap.sku,
            region: cap.region,
            state: cap.state,
        }));
    } catch (e) {
        // Fallback: Fabric v1 path
        if (e.status === 403 || e.status === 401) {
            const data = await this._fabricFetch('/v1/capacities');
            return (data.value || []).map(cap => ({
                id: cap.id,
                displayName: cap.displayName,
                sku: cap.sku || 'unknown',
                region: cap.region || 'unknown',
                state: cap.state || 'Active',
            }));
        }
        throw e;
    }
}
```

#### 2.2.2 assignCapacity()

```javascript
/**
 * Assign a capacity to a workspace.
 *
 * @param {string} workspaceId - Workspace GUID
 * @param {string} capacityId - Capacity GUID
 * @returns {Promise<void>}
 *
 * API: POST /v1/workspaces/{wsId}/assignToCapacity
 * Host: redirect (via proxy)
 * Auth: Bearer (PBI audience)
 * Body: { "capacityId": "{capacityId}" }
 * Response: 200 OK (immediate) or 202 Accepted (async, but completes fast)
 *
 * The 202 response does NOT need LRO polling — capacity assignment
 * completes within seconds. We treat 202 as success.
 *
 * Test status: ⚠️ NOT TESTED — marked for verification in test env.
 */
async assignCapacity(workspaceId, capacityId) {
    await this._fabricFetch(`/v1/workspaces/${workspaceId}/assignToCapacity`, {
        method: 'POST',
        body: JSON.stringify({ capacityId }),
    });
    // No return value — 200/202 both indicate success.
    // On error, _fabricFetch throws with status + body.
}
```

#### 2.2.3 createNotebook()

```javascript
/**
 * Create an empty notebook in a workspace.
 *
 * @param {string} workspaceId - Workspace GUID
 * @param {string} displayName - Notebook name
 * @param {string} [description] - Optional description
 * @returns {Promise<{id: string, type: string, displayName: string,
 *           workspaceId: string}>}
 *
 * API: POST /v1/workspaces/{wsId}/notebooks
 * Host: redirect (via proxy)
 * Auth: Bearer (PBI audience)
 * Body: { "displayName": "name", "description": "optional" }
 * Response: 201 Created
 *   { id, type: "Notebook", displayName, description, workspaceId }
 *
 * Test status: ✅ VERIFIED — returns 201 with notebook GUID.
 */
async createNotebook(workspaceId, displayName, description = '') {
    return await this._fabricFetch(`/v1/workspaces/${workspaceId}/notebooks`, {
        method: 'POST',
        body: JSON.stringify({
            displayName,
            description: description || 'Auto-generated by EDOG Studio Infra Wizard',
        }),
    });
}
```

### 2.3 Request Construction — All 6 Steps

Each of the 6 pipeline steps requires specific request construction. Below is the exact endpoint, method, headers, and payload for each, sourced from `docs/fabric-api-reference.md`.

#### Step 0: Create Workspace

```
POST /metadata/folders
Host: biazure-int-edog-redirect.analysis-df.windows.net
Authorization: Bearer {pbiToken}
Content-Type: application/json

{
  "capacityObjectId": "{capacityId}",
  "displayName": "{workspaceName}",
  "description": "{workspaceDescription}",
  "isServiceApp": false,
  "datasetStorageMode": 1
}
```

**Response (200 OK):**
```json
[
  {
    "id": 12345,
    "displayName": "brave_turing_42",
    "objectId": "65e22bd4-92a1-4de6-8bfc-af813eccff3e",
    "capacityObjectId": "dd01a7f3-4198-4439-aae3-4eaf902281bb"
  }
]
```

**Artifact extraction:**
```javascript
extractArtifacts: (response) => ({
    workspaceId: response[0]?.objectId ?? response[0]?.id,
    workspaceObjectId: response[0]?.objectId,
})
```

**CRITICAL: The metadata API returns an ARRAY, not an object.** `response[0].objectId` is the workspace GUID. The numeric `id` is an internal metadata ID — do NOT use it for v1 API calls.

**Error modes:**
- 409 Conflict: Workspace name already exists → categorize as `conflict`, suggest renaming
- 400 Bad Request: Invalid name characters → categorize as `validation`
- 401 Unauthorized: Token expired → categorize as `auth`

---

#### Step 1: Assign Capacity

```
POST /v1/workspaces/{workspaceId}/assignToCapacity
Host: biazure-int-edog-redirect.analysis-df.windows.net
Authorization: Bearer {pbiToken}
Content-Type: application/json

{
  "capacityId": "{capacityId}"
}
```

**Response:** 200 OK (immediate) or 202 Accepted (completes quickly, no polling needed).

**Artifact extraction:** None — capacityId is already in the ExecutionContext.

**CRITICAL:** The `capacityId` in the body is the GUID from the capacities list, NOT the `capacityObjectId` from the workspace metadata. These may differ in format. The wizard's Page 1 CapacityPicker provides the correct GUID.

**Error modes:**
- 400: Invalid capacity ID or workspace ID
- 404: Workspace not found (shouldn't happen — we just created it)
- 409: Workspace already assigned (possible race condition — treat as success)

---

#### Step 2: Create Lakehouse

```
POST /v1/workspaces/{workspaceId}/lakehouses
Host: biazure-int-edog-redirect.analysis-df.windows.net
Authorization: Bearer {pbiToken}
Content-Type: application/json

{
  "displayName": "{lakehouseName}",
  "enableSchemas": true
}
```

**Response (200/201):**
```json
{
  "id": "8453bb5e-c2ae-474d-a8e3-983b28ead8ba",
  "type": "Lakehouse",
  "displayName": "my_lakehouse",
  "description": "",
  "workspaceId": "65e22bd4-92a1-4de6-8bfc-af813eccff3e"
}
```

**Artifact extraction:**
```javascript
extractArtifacts: (response) => ({
    lakehouseId: response.id,
})
```

**NON-NEGOTIABLE:** `enableSchemas: true` is ALWAYS set. This is hardcoded in the step definition. FLT requires schema-enabled lakehouses — without this, materialized lake views cannot be created. See `fabric-api-reference.md` §"Key Insight: FLT Requires Schema-Enabled Lakehouses".

**Error modes:**
- 400: Invalid name, or `enableSchemas` not supported (unlikely)
- 409: Lakehouse name already exists in workspace
- Test status: ⚠️ NOT TESTED — marked for verification with `enableSchemas: true`

---

#### Step 3: Create Notebook

```
POST /v1/workspaces/{workspaceId}/notebooks
Host: biazure-int-edog-redirect.analysis-df.windows.net
Authorization: Bearer {pbiToken}
Content-Type: application/json

{
  "displayName": "{notebookName}",
  "description": "Auto-generated by EDOG Studio Infra Wizard"
}
```

**Response (201 Created):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "Notebook",
  "displayName": "setup_tables",
  "description": "Auto-generated by EDOG Studio Infra Wizard",
  "workspaceId": "65e22bd4-92a1-4de6-8bfc-af813eccff3e"
}
```

**Artifact extraction:**
```javascript
extractArtifacts: (response) => ({
    notebookId: response.id,
})
```

**Test status:** ✅ VERIFIED — returns 201 with notebook GUID.

---

#### Step 4: Write Notebook Cells

```
POST /v1/workspaces/{workspaceId}/notebooks/{notebookId}/updateDefinition
Host: biazure-int-edog-redirect.analysis-df.windows.net
Authorization: Bearer {pbiToken}
Content-Type: application/json

{
  "definition": {
    "parts": [
      {
        "path": "notebook-content.py",
        "payloadType": "InlineBase64",
        "payload": "{base64EncodedNotebookContent}"
      }
    ]
  }
}
```

**Payload Construction:**

The `payload` field is a base64-encoded Fabric notebook content string. The notebook content format uses a custom cell-based format (NOT Jupyter `.ipynb`). Based on reverse-engineering from `getDefinition` responses:

```python
def build_notebook_payload(cells: list[NotebookCell]) -> str:
    """Build the base64-encoded notebook content for updateDefinition.

    The Fabric notebook format uses a custom cell delimiter structure.
    Each cell has metadata markers and source content.
    """
    parts = []
    for i, cell in enumerate(cells):
        cell_type = 'code' if cell.language == 'pyspark' else 'code'
        # Fabric notebooks use '# METADATA' and '# CELL' markers
        # to delimit cells within the notebook-content.py file.
        #
        # Cell format (reverse-engineered from getDefinition):
        #   # METADATA **{"language":"sparksql"}**
        #   # CELL **{"cell_type":"code"}**
        #   %%sql
        #   CREATE TABLE ...
        #
        # For PySpark cells:
        #   # METADATA **{"language":"python"}**
        #   # CELL **{"cell_type":"code"}**
        #   import fmlv
        #   ...

        language = 'sparksql' if cell.language == 'sparksql' else 'python'

        metadata_line = f'# METADATA **{{"language":"{language}"}}**'
        cell_line = f'# CELL **{{"cell_type":"code"}}**'

        parts.append(metadata_line)
        parts.append(cell_line)
        parts.append(cell.code)

        # Blank line between cells (except after last)
        if i < len(cells) - 1:
            parts.append('')

    content = '\n'.join(parts)
    return base64.b64encode(content.encode('utf-8')).decode('ascii')
```

**Response:** 200 OK (no body) or 202 Accepted (LRO for large notebooks).

**Artifact extraction:** None — the notebook definition is written in-place.

**CRITICAL:** If the body is empty or missing the `definition` field, the API returns 400: `"Definition field is required"`. The build function must NEVER produce an empty payload.

**Test status:** ✅ API verified (400 on empty body proves the endpoint exists and validates). Full payload format needs integration testing.

---

#### Step 5: Execute Notebook (LRO)

```
POST /v1/workspaces/{workspaceId}/items/{notebookId}/jobs/instances?jobType=RunNotebook
Host: biazure-int-edog-redirect.analysis-df.windows.net
Authorization: Bearer {pbiToken}
Content-Type: application/json

(no body)
```

**Response (202 Accepted):**
```
HTTP/1.1 202 Accepted
Location: https://powerbiapi.analysis-df.windows.net/v1/workspaces/{wsId}/items/{nbId}/jobs/instances/{jobId}
Retry-After: 10
```

**LRO Polling:**

```
GET /v1/workspaces/{workspaceId}/items/{notebookId}/jobs/instances/{jobId}
Host: (may need to use the Location header's host, OR the redirect host)
Authorization: Bearer {pbiToken}
```

**Poll Response:**
```json
{
  "id": "job-instance-guid",
  "itemId": "notebook-guid",
  "jobType": "RunNotebook",
  "invokeType": "Manual",
  "status": "InProgress",
  "failureReason": null,
  "rootActivityId": "activity-guid",
  "startTimeUtc": "2025-01-15T10:30:00Z",
  "endTimeUtc": null
}
```

**Status values:** `NotStarted`, `InProgress`, `Completed`, `Failed`, `Cancelled`

**LRO Polling Strategy:**

```python
@dataclass
class LROConfig:
    poll_interval_ms: int = 3000        # Poll every 3 seconds
    max_poll_duration_ms: int = 300_000  # 5 minutes max
    backoff_multiplier: float = 1.0      # No backoff (fixed interval for notebook runs)
    max_poll_interval_ms: int = 10_000   # Cap at 10s if using backoff

async def poll_lro(initial_response, config, step_state):
    """Poll an LRO endpoint until terminal state or timeout."""
    poll_url = extract_poll_url(initial_response, artifacts)
    start_time = now()
    interval = config.poll_interval_ms

    while (now() - start_time) < config.max_poll_duration_ms:
        await sleep(interval)

        poll_response = await api_call('GET', poll_url)
        result = check_completion(poll_response)

        if result is not None:
            return result  # Terminal state (succeeded or failed)

        # Log progress
        status = poll_response.get('status', 'Unknown')
        elapsed = format_elapsed(now() - start_time)
        add_log(step_state.index, 'info', f"Status: {status} ({elapsed})")

        # Optional: exponential backoff for long-running jobs
        interval = min(
            int(interval * config.backoff_multiplier),
            config.max_poll_interval_ms
        )

    # Timeout
    raise StepError(
        f"Notebook execution did not complete within "
        f"{config.max_poll_duration_ms // 1000}s",
        category='lro_timeout'
    )
```

**CRITICAL:** The Location header in the 202 response may point to `powerbiapi.analysis-df.windows.net`, which is a different host than the redirect host. The frontend should extract the `jobId` from the Location URL and construct the poll URL using the redirect host path:

```javascript
extractPollUrl: (_response, artifacts) =>
    `/v1/workspaces/${artifacts.workspaceId}/items/${artifacts.notebookId}` +
    `/jobs/instances/${artifacts.jobInstanceId}`
```

The `jobInstanceId` is extracted from the Location header:
```javascript
// Location: https://.../{wsId}/items/{nbId}/jobs/instances/{jobId}
const locationUrl = response.headers.get('Location');
const jobId = locationUrl.split('/jobs/instances/')[1];
```

### 2.4 Auth: Bearer Token for All Wizard API Calls

**ALL F16 wizard API calls use Bearer token authentication, NOT MwcToken.**

The wizard creates workspace-level resources (workspace, lakehouse, notebook) using the Fabric public API via the redirect host. These endpoints require the PBI-audience Bearer token, which is already managed by the dev-server:

| Token Type | Auth Header | Used By | Wizard Use |
|------------|------------|---------|------------|
| Bearer (PBI) | `Authorization: Bearer {token}` | Fabric v1/v1.0 APIs via redirect | ALL 6 pipeline steps |
| MwcToken | `Authorization: MwcToken {token}` | FLT capacity host APIs | NOT used in wizard |

The dev-server's `_proxy_fabric()` method injects the Bearer token from `.edog-bearer-cache` on every proxied request. The frontend does NOT send the token directly — it is injected server-side to avoid CORS issues and token exposure in browser dev tools.

**Token expiry handling:** If the Bearer token expires mid-pipeline (unlikely — tokens last ~1 hour), the proxy returns 401. The step's auto-retry will fail with the same 401. The error is categorized as `auth` and the user is prompted to refresh their token (via the existing auth flow) before retrying.

---

## 3. Notebook Cell Construction

### 3.1 DAG Topology to Cell Mapping

The wizard's DAG canvas (Page 3) defines a directed acyclic graph of data assets. Each node becomes one or more notebook cells. The mapping is:

```
DAG Topology          →  Notebook Cells
─────────────────────────────────────────────
[PySpark MLV exists]  →  Cell 0: !pip install fmlv    (conditional)
[SQL Table nodes]     →  Cells 1..N: CREATE TABLE + INSERT 10 rows
[MLV nodes, topo-sorted] → Cells N+1..M: CREATE MATERIALIZED LAKE VIEW (SQL)
                                          or @fmlv.materialized_lake_view (PySpark)
```

### 3.2 Topological Sort — Kahn's Algorithm

Cells must be ordered so that parent tables/views are defined before their children. We use Kahn's algorithm (BFS-based) for deterministic, stable topological ordering:

```python
def topological_sort(nodes: list[DagNode], edges: list[DagEdge]) -> list[DagNode]:
    """Sort DAG nodes in topological order using Kahn's algorithm.

    Args:
        nodes: All nodes on the DAG canvas.
        edges: All connections (source → target means source is parent of target).

    Returns:
        Nodes in topological order (parents before children).

    Raises:
        CyclicDependencyError: If the DAG contains a cycle (should be
            prevented by ConnectionManager, but we check defensively).
    """
    from collections import deque

    # Build adjacency list and in-degree map
    in_degree: dict[str, int] = {n.id: 0 for n in nodes}
    children: dict[str, list[str]] = {n.id: [] for n in nodes}

    for edge in edges:
        children[edge.source_id].append(edge.target_id)
        in_degree[edge.target_id] += 1

    # Initialize queue with all nodes that have zero in-degree (roots/sources)
    queue = deque()
    for node in nodes:
        if in_degree[node.id] == 0:
            queue.append(node.id)

    # BFS — process nodes in order of resolution
    sorted_ids: list[str] = []
    while queue:
        node_id = queue.popleft()
        sorted_ids.append(node_id)

        for child_id in children[node_id]:
            in_degree[child_id] -= 1
            if in_degree[child_id] == 0:
                queue.append(child_id)

    # Cycle detection
    if len(sorted_ids) != len(nodes):
        visited = set(sorted_ids)
        cycle_nodes = [n.name for n in nodes if n.id not in visited]
        raise CyclicDependencyError(
            f"Circular dependency detected involving: {', '.join(cycle_nodes)}"
        )

    # Return nodes in sorted order
    node_map = {n.id: n for n in nodes}
    return [node_map[nid] for nid in sorted_ids]
```

**Tiebreaking:** When multiple nodes have zero in-degree simultaneously (e.g., multiple root SQL tables), they are ordered by `createdAt` timestamp (earlier first). This gives deterministic output.

### 3.3 Cell Format — updateDefinition Payload

The Fabric notebook `updateDefinition` API expects a `definition.parts` array where the primary part is `notebook-content.py` (base64-encoded). The content uses a custom cell delimiter format:

```python
# METADATA **{"language":"sparksql"}**
# CELL **{"cell_type":"code"}**
%%sql
CREATE TABLE IF NOT EXISTS dbo.orders (
    order_id INT,
    customer_id INT,
    ...
);

# METADATA **{"language":"python"}**
# CELL **{"cell_type":"code"}**
import fmlv
...
```

**Complete payload builder (Python pseudocode):**

```python
import base64
import json
from typing import TypedDict


class NotebookCell(TypedDict):
    id: str
    code: str
    language: str  # 'sparksql' | 'pyspark'
    label: str
    depends_on: list[str]


def build_update_definition_payload(cells: list[NotebookCell]) -> dict:
    """Build the complete updateDefinition request body.

    Returns the JSON body to POST to:
      /v1/workspaces/{wsId}/notebooks/{nbId}/updateDefinition

    The payload structure matches what getDefinition returns:
      { definition: { parts: [{ path, payloadType, payload }] } }
    """
    # Build notebook content string
    content_lines: list[str] = []

    for i, cell in enumerate(cells):
        # Determine language metadata
        if cell['language'] == 'sparksql':
            lang_meta = 'sparksql'
        else:
            lang_meta = 'python'

        # Cell metadata header
        content_lines.append(
            f'# METADATA **{json.dumps({"language": lang_meta})}**'
        )
        content_lines.append(
            f'# CELL **{json.dumps({"cell_type": "code"})}**'
        )

        # Cell source code
        content_lines.append(cell['code'])

        # Blank line separator between cells
        if i < len(cells) - 1:
            content_lines.append('')

    content = '\n'.join(content_lines)
    encoded = base64.b64encode(content.encode('utf-8')).decode('ascii')

    return {
        "definition": {
            "parts": [
                {
                    "path": "notebook-content.py",
                    "payloadType": "InlineBase64",
                    "payload": encoded,
                }
            ]
        }
    }
```

### 3.4 Cell Templates by Node Type

#### Plain SQL Table Cell

```sql
%%sql
CREATE TABLE IF NOT EXISTS {schema}.{table_name} (
    {column_definitions}
);
INSERT INTO {schema}.{table_name} VALUES
    {row_1},
    {row_2},
    ...
    {row_10};
```

**Rules:**
- Schema is always fully qualified: `dbo.orders`, `bronze.customers`
- Column definitions come from the theme registry (see §3.5)
- 10 sample rows, themed to the user's selection
- `CREATE TABLE IF NOT EXISTS` — idempotent for retries

#### SQL MLV Cell

```sql
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{mlv_name} AS
SELECT
    p1.*
FROM {parent_schema_1}.{parent_name_1} p1
```

**With multiple parents (JOIN):**
```sql
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{mlv_name} AS
SELECT
    p1.*,
    p2.{qualifying_column} AS {alias}
FROM {parent_schema_1}.{parent_name_1} p1
JOIN {parent_schema_2}.{parent_name_2} p2
    ON p1.id = p2.id
```

**CRITICAL:** It is `MATERIALIZED LAKE VIEW`, NOT `MATERIALIZED VIEW`. This is a Fabric-specific DDL extension. Getting this wrong means the generated code will fail at runtime. See C06 §1.4, Rule 1.

**Rules:**
- All parent table references are fully qualified: `{schema}.{name}`
- Multiple parents use `JOIN` syntax with auto-generated ON clauses
- JOIN columns use the first common column name, or `id` as default
- No `IF NOT EXISTS` — MLVs don't support this syntax

#### PySpark MLV Cell

```python
import fmlv
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DecimalType, TimestampType
from datetime import datetime

@fmlv.materialized_lake_view(name="{schema}.{mlv_name}")
def {mlv_name}():
    schema = StructType([
        StructField("{col_1}", {type_1}(), {nullable_1}),
        StructField("{col_2}", {type_2}(), {nullable_2}),
        # ... themed columns
    ])
    data = [
        ({val_1_1}, {val_1_2}, ...),
        ({val_2_1}, {val_2_2}, ...),
        # ... 10 rows, themed
    ]
    df = spark.createDataFrame(data, schema=schema)
    return df
```

**Rules:**
- `@fmlv.materialized_lake_view(name="{schema}.{mlv_name}")` — fully qualified name
- Function name matches the MLV name (must be valid Python identifier)
- 10 sample rows with themed data
- Each PySpark MLV is self-contained (includes its own schema + data)

#### Pip Install Cell (Conditional)

```python
!pip install fmlv
```

**Rules:**
- ONLY generated if at least one PySpark MLV node exists
- ALWAYS the first cell (index 0) when present
- If only SQL nodes exist, this cell is omitted entirely

### 3.5 Theme Data Registry

Each of the 6 themes provides column definitions and sample data for auto-generated cells.

```python
THEME_REGISTRY: dict[str, ThemeConfig] = {
    "ecommerce": {
        "display_name": "E-Commerce",
        "tables": {
            "orders": {
                "columns": [
                    {"name": "order_id", "sql_type": "INT", "pyspark_type": "IntegerType", "nullable": False},
                    {"name": "customer_id", "sql_type": "INT", "pyspark_type": "IntegerType", "nullable": False},
                    {"name": "product_id", "sql_type": "INT", "pyspark_type": "IntegerType", "nullable": False},
                    {"name": "quantity", "sql_type": "INT", "pyspark_type": "IntegerType", "nullable": True},
                    {"name": "unit_price", "sql_type": "DECIMAL(10,2)", "pyspark_type": "DecimalType", "nullable": True},
                    {"name": "total_amount", "sql_type": "DECIMAL(10,2)", "pyspark_type": "DecimalType", "nullable": True},
                    {"name": "order_date", "sql_type": "TIMESTAMP", "pyspark_type": "TimestampType", "nullable": True},
                    {"name": "status", "sql_type": "STRING", "pyspark_type": "StringType", "nullable": True},
                    {"name": "shipping_address", "sql_type": "STRING", "pyspark_type": "StringType", "nullable": True},
                    {"name": "payment_method", "sql_type": "STRING", "pyspark_type": "StringType", "nullable": True},
                ],
                "sample_rows": [
                    "(1001, 1, 101, 2, 29.99, 59.98, '2024-01-15T10:30:00', 'completed', '123 Main St, Seattle, WA', 'credit_card')",
                    "(1002, 2, 102, 1, 49.99, 49.99, '2024-01-15T11:45:00', 'completed', '456 Oak Ave, Portland, OR', 'paypal')",
                    # ... 8 more rows
                ],
            },
            "customers": { "...": "..." },
            "products": { "...": "..." },
            "categories": { "...": "..." },
            "reviews": { "...": "..." },
        },
        "mlv_templates": {
            "order_summary": {
                "type": "sql-mlv",
                "select": "SELECT o.*, c.name AS customer_name FROM {parent_0} o JOIN {parent_1} c ON o.customer_id = c.customer_id",
            },
            "customer_360": {
                "type": "pyspark-mlv",
                # PySpark MLV uses self-contained data, themed
            },
        },
    },
    "sales": { "...": "..." },
    "iot": { "...": "..." },
    "hr": { "...": "..." },
    "finance": { "...": "..." },
    "healthcare": { "...": "..." },
}
```

### 3.6 Cell Ordering in the Notebook

The complete cell ordering in the final notebook:

```
Position    Cell Type           Condition
────────────────────────────────────────────────────────
0           !pip install fmlv   Only if PySpark MLV nodes exist
1..N        SQL Table cells     All sql-table nodes, topologically sorted
N+1..M      MLV cells           All sql-mlv and pyspark-mlv nodes,
                                 topologically sorted (parents before children)
```

Within each tier (SQL tables, MLVs), nodes with the same topological depth are ordered by `createdAt` timestamp for determinism.

---

## 4. Retry & Rollback Engine

### 4.1 Retry Strategy

The retry engine operates at two levels:

**Level 1: Auto-retry (per-step, transparent to user)**

Each step has a configurable `autoRetries` count (typically 2). On failure, the step is automatically retried with exponential backoff before declaring failure:

```
Attempt 1: Execute step
  → Fails (e.g., 500)
  → Wait 1000ms × 2^0 = 1000ms

Attempt 2: Re-execute step
  → Fails (e.g., 500)
  → Wait 1000ms × 2^1 = 2000ms

Attempt 3: Re-execute step
  → Fails (e.g., 500)
  → Retries exhausted → Step declared FAILED
```

**Level 2: User-initiated retry (retry from failed step)**

After a step fails with retries exhausted, the user can click "Retry from Failed Step". This:
1. Marks all succeeded steps as `skipped` (preserves their artifacts)
2. Resets the failed step to `pending`
3. Re-executes from the failed step index forward
4. Uses the same artifact chain — workspaceId, lakehouseId, etc. are still valid

```python
async def retry_from_failed() -> None:
    """Resume pipeline execution from the failed step."""
    if pipeline_state.status != 'failed':
        raise Error("Can only retry from 'failed' state")

    failed_index = pipeline_state.error.failed_step_index

    # Mark completed steps as skipped (preserve artifacts)
    for i in range(failed_index):
        if pipeline_state.steps[i].status == 'succeeded':
            update_step(i, status='skipped')

    # Reset the failed step
    update_step(failed_index, status='pending', error=None, retry_count=0)

    # Update pipeline state
    pipeline_state.status = 'retrying'  # → immediately transitions to 'executing'
    pipeline_state.retry_count += 1

    # Resume execution from failed step
    for i in range(failed_index, 6):
        await execute_step(i)
```

**How "completed" is determined:**

A step is considered completed (and skippable on retry) if and only if:
1. Its `status` is `'succeeded'`
2. Its artifacts have been extracted and merged into the artifact chain
3. Its resource (if any) has been tracked in the rollback manifest

The artifact chain is the proof — if `artifacts.workspaceId` is non-null, Step 0 succeeded. If `artifacts.notebookId` is non-null, Step 3 succeeded. The retry engine checks these values, not just the status flags.

### 4.2 Rollback Procedure

Rollback deletes created resources in **REVERSE** creation order. This is critical because child resources may block parent resource deletion.

```
ROLLBACK ORDER (reverse of creation):
  1. Delete notebook    (if notebookId exists)  — DELETE /v1/workspaces/{wsId}/notebooks/{nbId}
  2. Delete lakehouse   (if lakehouseId exists)  — DELETE /v1/workspaces/{wsId}/lakehouses/{lhId}
  3. Delete workspace   (if workspaceId exists)  — DELETE /v1/workspaces/{wsId}

NOTE: Capacity assignment (Step 1) does NOT need explicit rollback.
  Deleting the workspace implicitly un-assigns the capacity.
```

**Complete rollback implementation:**

```python
async def rollback() -> RollbackManifest:
    """Delete all created resources in reverse order.

    Returns the rollback manifest with results for each deletion attempt.
    This is a best-effort operation — individual delete failures do NOT
    stop the rollback from proceeding to the next resource.
    """
    if pipeline_state.status not in ('failed', 'rollback_failed'):
        raise Error("Can only rollback from 'failed' or 'rollback_failed' state")

    manifest = pipeline_state.rollback_manifest
    manifest.rollback_attempted = True
    pipeline_state.status = 'rolling_back'

    # Reverse the resource list (LIFO order)
    resources = list(reversed(manifest.resources))

    all_succeeded = True
    for resource in resources:
        result = await delete_resource(resource)
        manifest.rollback_results.append(result)

        if result.succeeded:
            add_log(-1, 'success', f"Deleted {resource.type} '{resource.display_name}'")
        else:
            add_log(-1, 'error',
                     f"Failed to delete {resource.type} '{resource.display_name}': "
                     f"{result.error_message}")
            all_succeeded = False

    pipeline_state.status = 'rolled_back' if all_succeeded else 'rollback_failed'
    return manifest


async def delete_resource(resource: RollbackResource) -> RollbackResult:
    """Delete a single resource. Returns result, never throws."""
    start = now()
    try:
        if resource.type == 'workspace':
            # Deleting workspace cascades to all contents
            await api_call('DELETE', f'/v1/workspaces/{resource.id}')
        elif resource.type == 'lakehouse':
            await api_call('DELETE',
                f'/v1/workspaces/{resource.parent_workspace_id}/lakehouses/{resource.id}')
        elif resource.type == 'notebook':
            await api_call('DELETE',
                f'/v1/workspaces/{resource.parent_workspace_id}/notebooks/{resource.id}')

        return RollbackResult(
            resource=resource,
            succeeded=True,
            http_status=200,
            elapsed_ms=now() - start,
        )
    except Exception as e:
        return RollbackResult(
            resource=resource,
            succeeded=False,
            http_status=getattr(e, 'status', None),
            error_message=str(e),
            elapsed_ms=now() - start,
        )
```

### 4.3 Rollback Decision Matrix

| Failed Step | Resources Created | Rollback Actions | Notes |
|-------------|-------------------|-----------------|-------|
| Step 0 (Create Workspace) | None | No rollback needed | Nothing was created |
| Step 1 (Assign Capacity) | Workspace | Delete workspace | Capacity assignment is implicit |
| Step 2 (Create Lakehouse) | Workspace | Delete workspace | Workspace deletion cascades to lakehouse if it was partially created |
| Step 3 (Create Notebook) | Workspace, Lakehouse | Delete lakehouse → Delete workspace | Reverse order |
| Step 4 (Write Cells) | Workspace, Lakehouse, Notebook | Delete notebook → Delete lakehouse → Delete workspace | |
| Step 5 (Execute Notebook) | Workspace, Lakehouse, Notebook | Delete notebook → Delete lakehouse → Delete workspace | Notebook job may still be running — deletion cancels it |

### 4.4 Partial Rollback Failure

If rollback itself fails (e.g., the DELETE call returns 500), the pipeline transitions to `rollback_failed` state. The UI shows:

1. A warning panel listing which resources were successfully deleted and which failed
2. Manual cleanup instructions: "Open Fabric portal → Workspaces → {name} → Delete"
3. A "Try Rollback Again" button (retries only the failed deletions)
4. The rollback manifest is preserved — the user can attempt cleanup later

**Orphan resource detection:**

There is no automatic orphan detection. If the browser is closed mid-execution (before rollback), resources may be orphaned in Fabric. The audit trail (§7) records all created resources so the user can manually clean up via the Fabric portal.

**Future enhancement:** A "Check for Orphans" button on the wizard start screen that checks if any previously-created wizard resources still exist (by querying workspaces with the naming pattern).

### 4.5 Workspace Deletion Cascade

Deleting a Fabric workspace cascades to all its contents — lakehouses, notebooks, SQL endpoints, etc. This means:

- If workspace deletion succeeds, we do NOT need to individually delete lakehouse/notebook
- The reverse-order deletion (notebook → lakehouse → workspace) is a defense-in-depth strategy
- If individual item deletion fails, workspace deletion as the final step will clean everything

However, we still attempt individual deletions first because:
1. Workspace deletion may be slow (it deletes many resources)
2. Individual deletions provide per-resource status in the UI
3. If workspace deletion is blocked (e.g., 403), individual deletions may still succeed

---

## 5. Template Persistence

### 5.1 Storage Location

Templates are stored in a project-local file: `{project_root}/edog-templates.json`.

**NOT** in `edog-config.json` — templates are separate from project configuration (ADR: C12 §1.4, Principle 3).

### 5.2 JSON Schema

```json
{
  "$schema": "https://edog-studio.dev/schemas/templates-v1.json",
  "version": 1,
  "templates": [
    {
      "id": "tmpl_1720000000000_a1b2c3",
      "name": "Production 3-Tier Layout",
      "description": "Standard bronze-silver-gold medallion architecture",
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
              "name": "orders",
              "type": "sql-table",
              "schema": "bronze",
              "position": { "x": 100, "y": 200 },
              "sequenceNumber": 1,
              "createdAt": 1720000000001
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
          "viewport": {
            "x": 0,
            "y": 0,
            "zoom": 1.0
          }
        }
      }
    }
  ]
}
```

### 5.3 Template Name Validation

Validated both frontend (immediate feedback) and backend (authoritative):

```python
import re

FORBIDDEN_CHARS = re.compile(r'[/\\:*?"<>|]')
MAX_NAME_LENGTH = 64
CURRENT_TEMPLATE_VERSION = 1


def validate_template_name(
    name: str,
    existing_templates: list[dict] | None = None,
    current_template_id: str | None = None,
) -> list[str]:
    """Validate a template name. Returns list of error strings (empty = valid).

    Rules (from C12 §2.3):
      - Non-empty after trim
      - Max 64 characters
      - No filesystem-unsafe characters: / \\ : * ? " < > |
      - No leading/trailing dots
      - Unique within file (case-insensitive)
    """
    errors: list[str] = []
    trimmed = name.strip()

    if len(trimmed) == 0:
        errors.append("Template name cannot be empty")
        return errors  # No point checking further

    if len(trimmed) > MAX_NAME_LENGTH:
        errors.append(f"Template name must be {MAX_NAME_LENGTH} characters or fewer")

    if FORBIDDEN_CHARS.search(trimmed):
        errors.append("Template name contains invalid characters")

    if trimmed.startswith('.') or trimmed.endswith('.'):
        errors.append("Template name cannot start or end with a dot")

    # Uniqueness check (case-insensitive)
    if existing_templates:
        for tmpl in existing_templates:
            if (tmpl["name"].lower() == trimmed.lower()
                    and tmpl.get("id") != current_template_id):
                errors.append(
                    f"A template named '{tmpl['name']}' already exists"
                )
                break

    return errors
```

### 5.4 Backend REST Routes

Four new routes added to `dev-server.py`, following the existing action-based path convention:

#### Route 1: GET /api/templates/list

**Purpose:** List all saved templates (metadata only, no `state` blob).

```python
def _handle_templates_list(self):
    """GET /api/templates/list — returns template summaries."""
    templates_path = Path(PROJECT_DIR) / "edog-templates.json"

    if not templates_path.exists():
        self._json_response(200, {"ok": True, "templates": []})
        return

    try:
        data = json.loads(templates_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # Corrupt file — backup and report
        backup = templates_path.with_suffix(".json.bak")
        import shutil
        shutil.copy2(str(templates_path), str(backup))
        self._json_response(500, {
            "ok": False,
            "error": "TEMPLATE_FILE_CORRUPT",
            "message": f"Template file corrupted. Backup created at {backup.name}",
        })
        return

    # Strip `state` from each template (too large for list display)
    summaries = []
    for tmpl in data.get("templates", []):
        summary = {k: v for k, v in tmpl.items() if k != "state"}
        summaries.append(summary)

    self._json_response(200, {"ok": True, "templates": summaries})
```

#### Route 2: GET /api/templates/load?name={encodedName}

**Purpose:** Load a single template by name, including full `state` for wizard restoration.

```python
def _handle_templates_load(self):
    """GET /api/templates/load?name=... — returns full template with state."""
    from urllib.parse import parse_qs, urlparse
    parsed = urlparse(self.path)
    params = parse_qs(parsed.query)
    name = params.get("name", [None])[0]

    if not name:
        self._json_response(400, {
            "ok": False,
            "error": "MISSING_PARAMETER",
            "message": "Query parameter 'name' is required",
        })
        return

    templates_path = Path(PROJECT_DIR) / "edog-templates.json"
    if not templates_path.exists():
        self._json_response(404, {
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found",
        })
        return

    data = json.loads(templates_path.read_text(encoding="utf-8"))
    template = next(
        (t for t in data.get("templates", [])
         if t["name"].lower() == name.lower()),
        None,
    )

    if template is None:
        self._json_response(404, {
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found",
        })
        return

    # Version compatibility check
    tmpl_version = template.get("version", 1)
    if tmpl_version > CURRENT_TEMPLATE_VERSION:
        self._json_response(409, {
            "ok": False,
            "error": "TEMPLATE_VERSION_TOO_NEW",
            "message": (
                f"This template was created with a newer version of "
                f"EDOG Studio (v{tmpl_version}). Please update."
            ),
            "templateVersion": tmpl_version,
            "currentVersion": CURRENT_TEMPLATE_VERSION,
        })
        return

    self._json_response(200, {"ok": True, "template": template})
```

#### Route 3: POST /api/templates/save

**Purpose:** Save a new template or overwrite an existing one.

```python
def _handle_templates_save(self):
    """POST /api/templates/save — create or overwrite a template."""
    import secrets

    content_length = int(self.headers.get("Content-Length", 0))
    body = json.loads(self.rfile.read(content_length).decode("utf-8"))

    name = body.get("name", "").strip()
    description = body.get("description", "")[:256]
    overwrite = body.get("overwrite", False)
    state = body.get("state")

    # Validate name
    templates_path = Path(PROJECT_DIR) / "edog-templates.json"

    # Load existing templates
    if templates_path.exists():
        data = json.loads(templates_path.read_text(encoding="utf-8"))
    else:
        data = {"version": CURRENT_TEMPLATE_VERSION, "templates": []}

    templates = data.get("templates", [])

    errors = validate_template_name(name, templates)
    if errors:
        self._json_response(400, {
            "ok": False,
            "error": "VALIDATION_ERROR",
            "message": errors[0],
            "details": errors,
        })
        return

    if not state:
        self._json_response(400, {
            "ok": False,
            "error": "VALIDATION_ERROR",
            "message": "Template state is required",
        })
        return

    # Check for name conflict
    existing_idx = next(
        (i for i, t in enumerate(templates)
         if t["name"].lower() == name.lower()),
        None,
    )

    now_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")

    # Compute metadata from state
    dag = state.get("dag", {})
    metadata = {
        "nodeCount": len(dag.get("nodes", [])),
        "connectionCount": len(dag.get("connections", [])),
        "themeId": state.get("theme", {}).get("id", "default"),
        "schemaNames": _extract_schema_names(state),
        "wizardVersion": "0.1.0",
    }

    if existing_idx is not None and not overwrite:
        existing = templates[existing_idx]
        self._json_response(409, {
            "ok": False,
            "error": "TEMPLATE_NAME_EXISTS",
            "message": f"A template named '{existing['name']}' already exists. "
                       "Set overwrite=true to replace it.",
            "existingTemplate": {
                "id": existing["id"],
                "name": existing["name"],
                "updatedAt": existing.get("updatedAt"),
            },
        })
        return

    if existing_idx is not None:
        # Overwrite existing
        existing = templates[existing_idx]
        template = {
            "id": existing["id"],
            "name": name,
            "description": description,
            "createdAt": existing["createdAt"],
            "updatedAt": now_str,
            "version": CURRENT_TEMPLATE_VERSION,
            "metadata": metadata,
            "state": state,
        }
        templates[existing_idx] = template
        created = False
    else:
        # New template
        template_id = f"tmpl_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
        template = {
            "id": template_id,
            "name": name,
            "description": description,
            "createdAt": now_str,
            "updatedAt": now_str,
            "version": CURRENT_TEMPLATE_VERSION,
            "metadata": metadata,
            "state": state,
        }
        templates.append(template)
        created = True

    data["templates"] = templates

    # Atomic write to prevent corruption
    with _templates_lock:
        _atomic_write(templates_path, json.dumps(data, indent=2))

    # Strip state from response (caller already has it)
    response_template = {k: v for k, v in template.items() if k != "state"}
    self._json_response(201 if created else 200, {
        "ok": True,
        "template": response_template,
        "created": created,
    })


def _extract_schema_names(state: dict) -> list[str]:
    """Extract all schema names from wizard state."""
    schemas = state.get("schemas", {})
    names = [schemas.get("primary", "dbo")]
    names.extend(schemas.get("medallion", []))
    return sorted(set(names))
```

#### Route 4: POST /api/templates/delete

**Purpose:** Delete a template by name.

```python
def _handle_templates_delete(self):
    """POST /api/templates/delete — remove a template by name."""
    content_length = int(self.headers.get("Content-Length", 0))
    body = json.loads(self.rfile.read(content_length).decode("utf-8"))
    name = body.get("name", "").strip()

    if not name:
        self._json_response(400, {
            "ok": False,
            "error": "MISSING_PARAMETER",
            "message": "Template name is required",
        })
        return

    templates_path = Path(PROJECT_DIR) / "edog-templates.json"
    if not templates_path.exists():
        self._json_response(404, {
            "ok": False,
            "error": "TEMPLATE_NOT_FOUND",
            "message": f"No template named '{name}' was found",
        })
        return

    with _templates_lock:
        data = json.loads(templates_path.read_text(encoding="utf-8"))
        templates = data.get("templates", [])
        original_count = len(templates)

        templates = [
            t for t in templates
            if t["name"].lower() != name.lower()
        ]

        if len(templates) == original_count:
            self._json_response(404, {
                "ok": False,
                "error": "TEMPLATE_NOT_FOUND",
                "message": f"No template named '{name}' was found",
            })
            return

        data["templates"] = templates
        _atomic_write(templates_path, json.dumps(data, indent=2))

    self._json_response(200, {
        "ok": True,
        "deleted": True,
        "name": name,
    })
```

### 5.5 File Locking Strategy

The template file is accessed from a threaded HTTP server (`ThreadingMixIn`). Multiple concurrent requests could read/write the file simultaneously. We use a module-level `threading.Lock`:

```python
# Module-level lock for template file operations
_templates_lock = threading.Lock()
```

**Lock scope:** The lock is held only during the critical section (read → modify → write). It is NOT held during request parsing, validation, or response sending.

**Deadlock prevention:** The lock is never held across I/O operations other than file read/write. No nested locks.

**Atomic write:** All file mutations use the existing `_atomic_write()` pattern from `dev-server.py`:

```python
def _atomic_write(path: Path, data: str):
    """Write data atomically: write to temp file, then os.replace()."""
    import tempfile as _tf
    fd, tmp = _tf.mkstemp(dir=str(path.parent), suffix='.tmp')
    try:
        os.write(fd, data.encode('utf-8'))
        os.close(fd)
        os.replace(tmp, str(path))  # Atomic on POSIX and Windows (NTFS)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
```

### 5.6 Template Versioning and Migration

The `version` field at both file level and template level enables forward compatibility:

```python
CURRENT_TEMPLATE_VERSION = 1

MIGRATIONS: dict[int, callable] = {
    # Example: version 1 → 2 migration
    # 2: lambda tmpl: {
    #     **tmpl,
    #     "version": 2,
    #     "state": {
    #         **tmpl["state"],
    #         "newField": "default_value",
    #     },
    # },
}


def migrate_template(template: dict) -> dict:
    """Apply sequential migrations to bring a template up to current version."""
    current = dict(template)
    while current.get("version", 1) < CURRENT_TEMPLATE_VERSION:
        next_version = current["version"] + 1
        migrator = MIGRATIONS.get(next_version)
        if migrator is None:
            raise ValueError(
                f"No migration path from v{current['version']} to v{next_version}"
            )
        current = migrator(current)
    return current
```

**Migration rules:**
- Migrations are pure functions: `(old_template) → new_template`
- Migrations never delete user data — they only add/restructure fields
- If template version > code version → reject with clear error (409)
- Templates are always saved at `CURRENT_TEMPLATE_VERSION`

### 5.7 Route Registration in dev-server.py

The 4 template routes are added to the existing `do_GET`/`do_POST` routing:

```python
def do_GET(self):
    if self.path == "/api/flt/config":
        self._serve_config()
    elif self.path == "/api/templates/list":
        self._handle_templates_list()           # ← NEW
    elif self.path.startswith("/api/templates/load"):
        self._handle_templates_load()           # ← NEW
    elif self.path.startswith("/api/fabric/"):
        self._proxy_fabric("GET")
    # ... existing routes ...

def do_POST(self):
    if self.path.startswith("/api/fabric/"):
        self._proxy_fabric("POST")
    elif self.path == "/api/templates/save":
        self._handle_templates_save()           # ← NEW
    elif self.path == "/api/templates/delete":
        self._handle_templates_delete()         # ← NEW
    # ... existing routes ...
```

---

## 6. Frontend-Backend Communication

### 6.1 Execution Trigger

The frontend triggers execution via a simple HTTP POST to validate readiness, then orchestrates the pipeline client-side:

```
Frontend (Page 5)                    Backend (dev-server.py)
─────────────────                    ─────────────────────────
1. User clicks "Lock In & Create"
2. POST /api/wizard/validate         → Validates bearer token exists
   { context: {...} }                ← { ok: true, bearerAvailable: true }
3. Pipeline.start()
4. For each step:
   fetch('/api/fabric/...')          → _proxy_fabric() → Fabric API
   ← Response                       ← Proxied response
5. Pipeline succeeds/fails
```

The `/api/wizard/validate` route is a lightweight pre-flight check:

```python
def _handle_wizard_validate(self):
    """POST /api/wizard/validate — pre-flight check before pipeline execution."""
    bearer, _ = _read_cache(BEARER_CACHE)

    if not bearer:
        self._json_response(401, {
            "ok": False,
            "error": "NO_BEARER_TOKEN",
            "message": "Bearer token not available. Please authenticate first.",
        })
        return

    self._json_response(200, {
        "ok": True,
        "bearerAvailable": True,
    })
```

### 6.2 Progress Reporting

The pipeline does **NOT** use SSE or WebSocket for progress reporting. Each step is a sequential `fetch()` call from the browser. Progress is reported via:

1. **Direct state mutation** — `_updateStep()` and `_updateState()` update the PipelineState object
2. **Callback invocation** — `callbacks.onUpdate(state)` is called after every state change
3. **DOM re-render** — `_renderStep()` updates the specific step's DOM elements
4. **EventBus emission** — `_emitEvent('pipeline:step:complete', ...)` for external consumers

```
Step execution flow:

  execute_step(2)
    ├── _updateStep(2, {status: 'running'})
    │     ├── callbacks.onUpdate(state)          // Parent notified
    │     ├── _renderStep(2)                      // DOM updated
    │     └── _emitEvent('pipeline:step:start')   // External listeners
    │
    ├── fetch('/api/fabric/v1/workspaces/{id}/lakehouses')
    │     └── (waiting for response...)
    │
    └── _updateStep(2, {status: 'succeeded'})
          ├── callbacks.onUpdate(state)
          ├── _renderStep(2)
          └── _emitEvent('pipeline:step:complete')
```

### 6.3 Event/Message Format

All pipeline events follow this structure (from C10 §2.9):

```typescript
interface PipelineEvent {
    type: PipelineEventType;  // e.g., 'pipeline:step:complete'
    state: PipelineState;      // Full state snapshot
    timestamp: number;         // Date.now()
    detail?: Record<string, any>;  // Step-specific data
}
```

**Event types:**
- `pipeline:start` — Pipeline execution begins
- `pipeline:step:start` — A step begins executing
- `pipeline:step:complete` — A step succeeds
- `pipeline:step:failed` — A step fails (after retries)
- `pipeline:step:retry` — A step auto-retries
- `pipeline:success` — All 6 steps complete
- `pipeline:failed` — Pipeline enters failed state
- `pipeline:rollback:start` — Rollback begins
- `pipeline:rollback:complete` — Rollback finishes (success or failure)
- `pipeline:minimize` — Wizard minimized to badge
- `pipeline:restore` — Wizard restored from badge

### 6.4 Error Reporting Format

Errors are structured for UI rendering:

```typescript
interface PipelineError {
    failedStepId: StepId;        // 'create-lakehouse'
    failedStepIndex: number;     // 2
    message: string;             // "Lakehouse name already exists"
    rawError: string;            // Full API response body
    httpStatus: number | null;   // 409
    isRetryable: boolean;        // true
    shouldRollback: boolean;     // false (409 is not worth rollback)
    suggestedAction: 'retry' | 'rollback' | 'manual';
    retryAttempts: number;       // 3
    occurredAt: number;          // Date.now()
    category: ErrorCategory;     // 'conflict'
}
```

### 6.5 Minimize/Restore Behavior

Minimizing the wizard does NOT interrupt the backend pipeline:

- The pipeline runs in the browser's JS event loop (async/await chain)
- `minimize()` hides the wizard DOM (`display: none`) and shows the FloatingBadge
- `restore()` shows the wizard DOM and hides the badge
- The pipeline's `_state` object continues updating in the background
- Timer intervals continue counting
- Fetch calls continue executing

**No backend involvement.** The Python server sees the same proxied API calls whether the wizard is visible or minimized. The minimize/restore is purely a UI concern.

---

## 7. Error Handling & Logging

### 7.1 Error Classification

Every API error is classified into a category that determines retry behavior, suggested user action, and UI messaging:

```python
class ErrorClassifier:
    """Classify API errors into actionable categories."""

    @staticmethod
    def classify(error: Exception, http_status: int | None = None) -> ErrorCategory:
        # Network failures (fetch() rejects, no HTTP status)
        if http_status is None:
            if 'Failed to fetch' in str(error) or 'TypeError' in type(error).__name__:
                return 'network'
            if 'AbortError' in type(error).__name__:
                return 'network'  # Timeout via AbortController
            return 'unknown'

        # HTTP status-based classification
        if http_status == 401 or http_status == 403:
            return 'auth'
        if http_status == 404:
            return 'not_found'
        if http_status == 409:
            return 'conflict'
        if http_status == 429:
            return 'rate_limit'
        if http_status == 400:
            return 'validation'
        if 500 <= http_status <= 599:
            return 'server_error'

        return 'unknown'
```

**Category behavior matrix:**

| Category | Retryable | Auto-Retry | User Action | Rollback Recommended |
|----------|-----------|------------|-------------|---------------------|
| `network` | Yes | Yes (with backoff) | Check connection, retry | No (transient) |
| `auth` | No | No | Re-authenticate | No (fixable) |
| `conflict` | Conditional | Yes (once) | Change name, retry | No (fixable) |
| `not_found` | No | No | Check dependency | Yes (dependency broken) |
| `rate_limit` | Yes | Yes (with long backoff) | Wait, retry | No (transient) |
| `server_error` | Yes | Yes (with backoff) | Retry or rollback | After 3 retries |
| `validation` | No | No | Fix input | No (fixable) |
| `lro_timeout` | Yes | Yes (once) | Retry or check Fabric portal | Conditional |
| `lro_failed` | Conditional | No | Check notebook, rollback | Yes |
| `unknown` | Yes | Yes (once) | Retry or rollback | After 1 retry |

### 7.2 Structured Error Response Format

All error responses from the dev-server follow this shape:

```json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable error description",
  "details": ["optional", "array", "of", "detail", "strings"]
}
```

HTTP status codes:
- 400: Validation error, missing parameter
- 401: Authentication required
- 404: Resource not found
- 409: Conflict (name exists, version mismatch)
- 500: Internal server error, file corruption

### 7.3 Frontend Logging

Each pipeline step maintains its own log buffer (array of `LogEntry` objects). Logs are:

1. **Displayed in the step detail panel** — expandable monospace log area under each step
2. **Available via `getState().steps[i].logs`** — for programmatic access
3. **Included in error reports** — when a step fails, all its logs are in the error context

**What gets logged per step:**

| Event | Level | Example |
|-------|-------|---------|
| Step starts | `info` | "Creating workspace 'brave_turing_42'..." |
| Request sent | `debug` | "POST /metadata/folders (body: 142 bytes)" |
| Response received | `info` | "HTTP 200 (1.2s)" |
| Artifact extracted | `success` | "Workspace ID: 65e22bd4-..." |
| Resource tracked | `info` | "Tracked workspace for rollback" |
| Auto-retry | `warning` | "Server error (500). Retrying in 2s... (attempt 2/3)" |
| Step succeeds | `success` | "Completed in 2.1s" |
| Step fails | `error` | "Failed: Workspace name already exists (409)" |
| LRO polling | `info` | "Notebook status: InProgress (elapsed: 15s)" |
| LRO complete | `success` | "Notebook execution completed (17.2s)" |
| Rollback action | `info` | "Deleting lakehouse 'SalesLH'..." |
| Rollback result | `success`/`error` | "Lakehouse deleted" or "Failed to delete workspace" |

### 7.4 Server-Side Logging

The dev-server logs template operations and proxy errors to stdout:

```python
def _log(level: str, message: str) -> None:
    """Log with timestamp and level prefix."""
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{level.upper():5s}] {message}", flush=True)

# Usage:
_log("info", f"Template saved: '{name}' (id: {template_id})")
_log("error", f"Template file corrupt: {e}")
_log("warn", f"Bearer token expired during proxy to {path}")
```

### 7.5 Audit Trail

The pipeline maintains an audit trail of all created resources in the `RollbackManifest`:

```python
@dataclass
class AuditEntry:
    resource_type: str     # 'workspace' | 'lakehouse' | 'notebook'
    resource_id: str       # GUID
    display_name: str      # User-visible name
    created_by_step: str   # Step ID (e.g., 'create-workspace')
    created_at: float      # Timestamp
    workspace_id: str      # Parent workspace (for sub-resources)
```

This audit trail is available in the UI post-failure for manual cleanup. It is NOT persisted to disk — if the browser tab closes, the audit trail is lost. Resources may be orphaned.

**Mitigation:** The wizard names follow a predictable pattern. Users can search for orphaned workspaces in the Fabric portal by name.

---

## 8. Security

### 8.1 Token Handling

**Hard rules:**
- Bearer tokens are NEVER logged (not in console, not in step logs, not in error messages)
- Bearer tokens are NEVER persisted in template files or wizard state
- Bearer tokens are NEVER sent to the frontend in API response bodies — they are injected server-side by the proxy
- The `.edog-bearer-cache` file is base64-encoded (not encryption, but prevents casual reading)

**Token flow:**
```
Playwright → captures PBI Bearer token → writes .edog-bearer-cache
dev-server.py → reads .edog-bearer-cache → injects into proxied requests
Browser → never sees the raw token (server-side injection)
```

**Log sanitization:**

```javascript
function sanitizeForLog(data) {
    if (typeof data !== 'object' || data === null) return data;
    const sanitized = { ...data };
    const sensitiveKeys = ['authorization', 'token', 'bearer', 'mwctoken', 'password'];
    for (const key of Object.keys(sanitized)) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
            sanitized[key] = '[REDACTED]';
        }
    }
    return sanitized;
}
```

### 8.2 Input Validation

All user-provided names are sanitized before being sent to Fabric APIs:

**Workspace name validation:**
```python
def validate_workspace_name(name: str) -> list[str]:
    """Validate workspace name for Fabric API compatibility."""
    errors = []
    if not name or not name.strip():
        errors.append("Workspace name cannot be empty")
    if len(name) > 256:
        errors.append("Workspace name must be 256 characters or fewer")
    # Fabric allows underscores but not most special characters
    if re.search(r'[<>:"/\\|?*]', name):
        errors.append("Workspace name contains invalid characters")
    return errors
```

**Lakehouse name validation:**
```python
def validate_lakehouse_name(name: str) -> list[str]:
    """Validate lakehouse name. Must be a valid Fabric item name."""
    errors = []
    if not name or not name.strip():
        errors.append("Lakehouse name cannot be empty")
    if len(name) > 256:
        errors.append("Lakehouse name must be 256 characters or fewer")
    if not re.match(r'^[a-zA-Z][a-zA-Z0-9_]*$', name):
        errors.append("Lakehouse name must start with a letter and contain "
                       "only letters, numbers, and underscores")
    return errors
```

**Table/MLV name validation (from C06 §2.5):**
- Length: 1-63 characters
- Pattern: `[a-z][a-z0-9_]*` (lowercase, starts with letter)
- No SQL reserved words as bare names (prefixed with schema, so this is defensive)

### 8.3 Rate Limiting

The wizard does NOT implement client-side rate limiting. Fabric API rate limits are handled reactively:

1. If a 429 response is received, the error is classified as `rate_limit`
2. The `Retry-After` header value (if present) is used as the backoff delay
3. Auto-retry respects the backoff: `delay = max(retry_after_seconds * 1000, base_delay)`
4. After retries exhausted, the user sees "Fabric API rate limit reached. Please wait and retry."

**Practical risk:** Low. The wizard makes exactly 6 API calls (or 7 with capacity list). This is well within Fabric's rate limits.

---

## 9. Testing Strategy

### 9.1 Unit Tests for Step Executors

Each of the 6 step definitions should have unit tests verifying:

```python
# tests/test_wizard_steps.py

class TestStepRegistry:
    """Verify step definition registry integrity."""

    def test_all_six_steps_defined(self):
        assert len(STEP_REGISTRY) == 6

    def test_step_ids_are_unique(self):
        ids = [s['id'] for s in STEP_REGISTRY]
        assert len(ids) == len(set(ids))

    def test_step_indices_sequential(self):
        for i, step in enumerate(STEP_REGISTRY):
            assert step['index'] == i

    def test_create_workspace_body(self):
        step = STEP_REGISTRY[0]
        context = make_test_context(workspace_name='test_ws', capacity_id='cap-123')
        body = step['build_body'](context, {})
        assert body['displayName'] == 'test_ws'
        assert body['capacityObjectId'] == 'cap-123'
        assert body['isServiceApp'] is False
        assert body['datasetStorageMode'] == 1

    def test_create_lakehouse_always_enables_schemas(self):
        step = STEP_REGISTRY[2]
        context = make_test_context(lakehouse_name='my_lh')
        body = step['build_body'](context, {})
        assert body['enableSchemas'] is True  # NON-NEGOTIABLE

    def test_create_notebook_body(self):
        step = STEP_REGISTRY[3]
        context = make_test_context(notebook_name='setup_tables')
        body = step['build_body'](context, {})
        assert body['displayName'] == 'setup_tables'
        assert 'EDOG Studio' in body['description']

    def test_write_cells_payload_is_base64(self):
        step = STEP_REGISTRY[4]
        cells = [make_test_cell(code='%%sql\nSELECT 1', language='sparksql')]
        context = make_test_context(notebook_cells=cells)
        body = step['build_body'](context, {})
        payload = body['definition']['parts'][0]['payload']
        # Verify it's valid base64
        import base64
        decoded = base64.b64decode(payload).decode('utf-8')
        assert '%%sql' in decoded
        assert 'SELECT 1' in decoded

    def test_execute_notebook_no_body(self):
        step = STEP_REGISTRY[5]
        body = step['build_body'](make_test_context(), {})
        assert body is None

    def test_workspace_artifact_extraction(self):
        step = STEP_REGISTRY[0]
        response = [{"objectId": "ws-guid-123", "id": 42, "displayName": "test"}]
        artifacts = step['extract_artifacts'](response)
        assert artifacts['workspaceId'] == 'ws-guid-123'

    def test_lakehouse_artifact_extraction(self):
        step = STEP_REGISTRY[2]
        response = {"id": "lh-guid-456", "type": "Lakehouse"}
        artifacts = step['extract_artifacts'](response)
        assert artifacts['lakehouseId'] == 'lh-guid-456'

    def test_notebook_artifact_extraction(self):
        step = STEP_REGISTRY[3]
        response = {"id": "nb-guid-789", "type": "Notebook"}
        artifacts = step['extract_artifacts'](response)
        assert artifacts['notebookId'] == 'nb-guid-789'
```

### 9.2 Integration Tests with Mock Fabric API

```python
# tests/test_wizard_integration.py

class TestWizardPipelineIntegration:
    """End-to-end pipeline tests using mock Fabric API responses."""

    @pytest.fixture
    def mock_server(self):
        """Start a mock HTTP server that simulates Fabric API responses."""
        responses = {
            'POST /metadata/folders': (200, [{"objectId": "ws-1", "displayName": "test"}]),
            'POST /v1/workspaces/ws-1/assignToCapacity': (202, {}),
            'POST /v1/workspaces/ws-1/lakehouses': (201, {"id": "lh-1", "type": "Lakehouse"}),
            'POST /v1/workspaces/ws-1/notebooks': (201, {"id": "nb-1", "type": "Notebook"}),
            'POST /v1/workspaces/ws-1/notebooks/nb-1/updateDefinition': (200, {}),
            'POST /v1/workspaces/ws-1/items/nb-1/jobs/instances': (202, {},
                {'Location': '/v1/workspaces/ws-1/items/nb-1/jobs/instances/job-1'}),
            'GET /v1/workspaces/ws-1/items/nb-1/jobs/instances/job-1': (200,
                {"id": "job-1", "status": "Completed"}),
        }
        return MockFabricServer(responses)

    async def test_happy_path_all_six_steps(self, mock_server):
        """All 6 steps succeed in sequence."""
        context = make_full_context()
        pipeline = Pipeline(context)
        artifacts = await pipeline.start()
        assert artifacts.workspace_id == 'ws-1'
        assert artifacts.lakehouse_id == 'lh-1'
        assert artifacts.notebook_id == 'nb-1'
        assert pipeline.state.status == 'succeeded'

    async def test_failure_at_step_3_then_retry(self, mock_server):
        """Step 3 fails, user retries, pipeline completes."""
        mock_server.set_response('POST /v1/workspaces/ws-1/notebooks', 500, {}, count=3)
        mock_server.set_response('POST /v1/workspaces/ws-1/notebooks', 201,
                                  {"id": "nb-1"}, from_attempt=4)

        context = make_full_context()
        pipeline = Pipeline(context)

        with pytest.raises(PipelineFailure):
            await pipeline.start()

        assert pipeline.state.status == 'failed'
        assert pipeline.state.error.failed_step_index == 3

        # Retry succeeds
        artifacts = await pipeline.retry_from_failed()
        assert artifacts.notebook_id == 'nb-1'
        assert pipeline.state.status == 'succeeded'

    async def test_rollback_deletes_in_reverse_order(self, mock_server):
        """Rollback deletes notebook, lakehouse, workspace in reverse."""
        mock_server.set_response('POST /v1/workspaces/ws-1/notebooks/nb-1/updateDefinition',
                                  500, {})
        mock_server.set_response('DELETE /v1/workspaces/ws-1/notebooks/nb-1', 200, {})
        mock_server.set_response('DELETE /v1/workspaces/ws-1/lakehouses/lh-1', 200, {})
        mock_server.set_response('DELETE /v1/workspaces/ws-1', 200, {})

        context = make_full_context()
        pipeline = Pipeline(context)

        with pytest.raises(PipelineFailure):
            await pipeline.start()

        manifest = await pipeline.rollback()
        assert manifest.rollback_results[0].resource.type == 'notebook'
        assert manifest.rollback_results[1].resource.type == 'lakehouse'
        assert manifest.rollback_results[2].resource.type == 'workspace'
        assert all(r.succeeded for r in manifest.rollback_results)
```

### 9.3 Rollback Testing

```python
class TestRollback:
    """Test rollback behavior in various failure scenarios."""

    async def test_no_rollback_when_step_0_fails(self):
        """No resources to clean up when workspace creation fails."""
        pipeline = make_failing_pipeline(fail_at_step=0)
        with pytest.raises(PipelineFailure):
            await pipeline.start()
        assert len(pipeline.state.rollback_manifest.resources) == 0

    async def test_rollback_after_step_2_failure(self):
        """Workspace exists, rollback should delete it."""
        pipeline = make_failing_pipeline(fail_at_step=2, ws_created=True)
        with pytest.raises(PipelineFailure):
            await pipeline.start()
        manifest = await pipeline.rollback()
        assert len(manifest.resources) == 1
        assert manifest.resources[0].type == 'workspace'

    async def test_partial_rollback_failure(self):
        """One rollback deletion fails."""
        pipeline = make_pipeline_with_rollback_failure()
        with pytest.raises(PipelineFailure):
            await pipeline.start()
        manifest = await pipeline.rollback()
        assert pipeline.state.status == 'rollback_failed'
        assert any(not r.succeeded for r in manifest.rollback_results)

    async def test_rollback_retry(self):
        """Retry rollback after partial failure."""
        pipeline = make_pipeline_with_rollback_failure()
        # First rollback: one deletion fails
        manifest = await pipeline.rollback()
        assert pipeline.state.status == 'rollback_failed'
        # Fix the mock, retry
        fix_mock_server()
        manifest = await pipeline.rollback()  # Retries only failed deletions
        assert pipeline.state.status == 'rolled_back'
```

### 9.4 Template CRUD Tests

```python
# tests/test_templates.py

class TestTemplateRoutes:
    """Test template CRUD routes on dev-server."""

    def test_list_empty(self, client):
        """GET /api/templates/list returns empty array when no file exists."""
        resp = client.get('/api/templates/list')
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "templates": []}

    def test_save_new_template(self, client):
        """POST /api/templates/save creates a new template."""
        resp = client.post('/api/templates/save', json={
            "name": "Test Layout",
            "description": "A test",
            "state": make_test_state(),
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["ok"] is True
        assert data["created"] is True
        assert data["template"]["name"] == "Test Layout"
        assert data["template"]["id"].startswith("tmpl_")

    def test_save_duplicate_name_rejected(self, client):
        """POST /api/templates/save rejects duplicate name."""
        client.post('/api/templates/save', json={
            "name": "Dup",
            "state": make_test_state(),
        })
        resp = client.post('/api/templates/save', json={
            "name": "dup",  # Case-insensitive match
            "state": make_test_state(),
        })
        assert resp.status_code == 409
        assert resp.json()["error"] == "TEMPLATE_NAME_EXISTS"

    def test_save_overwrite(self, client):
        """POST /api/templates/save with overwrite=true replaces existing."""
        client.post('/api/templates/save', json={
            "name": "Overwrite Me",
            "state": make_test_state(),
        })
        resp = client.post('/api/templates/save', json={
            "name": "Overwrite Me",
            "overwrite": True,
            "state": make_test_state(node_count=5),
        })
        assert resp.status_code == 200
        assert resp.json()["created"] is False

    def test_load_template(self, client):
        """GET /api/templates/load?name=... returns full template."""
        client.post('/api/templates/save', json={
            "name": "Load Me",
            "state": make_test_state(),
        })
        resp = client.get('/api/templates/load?name=Load%20Me')
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert "state" in data["template"]

    def test_load_not_found(self, client):
        """GET /api/templates/load?name=... returns 404 for missing template."""
        resp = client.get('/api/templates/load?name=NoExist')
        assert resp.status_code == 404
        assert resp.json()["error"] == "TEMPLATE_NOT_FOUND"

    def test_delete_template(self, client):
        """POST /api/templates/delete removes template."""
        client.post('/api/templates/save', json={
            "name": "Delete Me",
            "state": make_test_state(),
        })
        resp = client.post('/api/templates/delete', json={"name": "Delete Me"})
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

        # Verify deleted
        resp = client.get('/api/templates/load?name=Delete%20Me')
        assert resp.status_code == 404

    def test_invalid_name_rejected(self, client):
        """POST /api/templates/save rejects invalid characters."""
        resp = client.post('/api/templates/save', json={
            "name": "Bad/Name",
            "state": make_test_state(),
        })
        assert resp.status_code == 400
        assert resp.json()["error"] == "VALIDATION_ERROR"

    def test_empty_name_rejected(self, client):
        """POST /api/templates/save rejects empty name."""
        resp = client.post('/api/templates/save', json={
            "name": "   ",
            "state": make_test_state(),
        })
        assert resp.status_code == 400

    def test_concurrent_save_safety(self, client, thread_pool):
        """Two concurrent saves with different names both succeed."""
        import concurrent.futures
        futures = [
            thread_pool.submit(client.post, '/api/templates/save',
                               json={"name": f"Concurrent-{i}", "state": make_test_state()})
            for i in range(10)
        ]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]
        assert all(r.status_code in (200, 201) for r in results)

        # All 10 templates saved
        resp = client.get('/api/templates/list')
        assert len(resp.json()["templates"]) == 10

    def test_corrupt_file_creates_backup(self, client, templates_path):
        """Corrupt template file is backed up and reported."""
        templates_path.write_text("not valid json{{{", encoding="utf-8")
        resp = client.get('/api/templates/list')
        assert resp.status_code == 500
        assert resp.json()["error"] == "TEMPLATE_FILE_CORRUPT"
        assert templates_path.with_suffix(".json.bak").exists()
```

### 9.5 Notebook Cell Construction Tests

```python
class TestCellConstruction:
    """Test topological sort and cell generation."""

    def test_topological_sort_linear_chain(self):
        """A → B → C sorts as [A, B, C]."""
        nodes = [node('A'), node('B'), node('C')]
        edges = [edge('A', 'B'), edge('B', 'C')]
        result = topological_sort(nodes, edges)
        assert [n.name for n in result] == ['A', 'B', 'C']

    def test_topological_sort_diamond(self):
        """A → B, A → C, B → D, C → D sorts A first, D last."""
        nodes = [node('A'), node('B'), node('C'), node('D')]
        edges = [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')]
        result = topological_sort(nodes, edges)
        assert result[0].name == 'A'
        assert result[-1].name == 'D'

    def test_topological_sort_multiple_roots(self):
        """Multiple root nodes (no parents) are all sorted first."""
        nodes = [node('A'), node('B'), node('C', parents=['A', 'B'])]
        edges = [edge('A', 'C'), edge('B', 'C')]
        result = topological_sort(nodes, edges)
        assert set(n.name for n in result[:2]) == {'A', 'B'}
        assert result[2].name == 'C'

    def test_cycle_detection(self):
        """A → B → A raises CyclicDependencyError."""
        nodes = [node('A'), node('B')]
        edges = [edge('A', 'B'), edge('B', 'A')]
        with pytest.raises(CyclicDependencyError):
            topological_sort(nodes, edges)

    def test_pip_install_only_when_pyspark_exists(self):
        cells = generate_cells(
            nodes=[sql_table_node('orders')],
            edges=[],
            theme='ecommerce',
        )
        assert not any('pip install' in c.code for c in cells)

        cells = generate_cells(
            nodes=[sql_table_node('orders'), pyspark_mlv_node('summary')],
            edges=[edge('orders', 'summary')],
            theme='ecommerce',
        )
        assert cells[0].code == '!pip install fmlv'

    def test_mlv_uses_materialized_lake_view(self):
        """CRITICAL: Must be LAKE VIEW, not just VIEW."""
        cells = generate_cells(
            nodes=[sql_table_node('t1'), sql_mlv_node('m1')],
            edges=[edge('t1', 'm1')],
            theme='ecommerce',
        )
        mlv_cell = next(c for c in cells if 'MATERIALIZED' in c.code)
        assert 'MATERIALIZED LAKE VIEW' in mlv_cell.code
        assert 'MATERIALIZED VIEW' not in mlv_cell.code.replace('LAKE VIEW', '')

    def test_base64_payload_construction(self):
        """updateDefinition payload is valid base64."""
        cells = [make_cell('%%sql\nSELECT 1', 'sparksql')]
        payload = build_update_definition_payload(cells)
        parts = payload['definition']['parts']
        assert len(parts) == 1
        assert parts[0]['path'] == 'notebook-content.py'
        assert parts[0]['payloadType'] == 'InlineBase64'
        decoded = base64.b64decode(parts[0]['payload']).decode('utf-8')
        assert '%%sql' in decoded

    def test_sql_table_cell_has_10_rows(self):
        """Each SQL table cell generates exactly 10 sample rows."""
        cells = generate_cells(
            nodes=[sql_table_node('orders')],
            edges=[],
            theme='ecommerce',
        )
        table_cell = cells[0]
        row_count = table_cell.code.count('),\n') + table_cell.code.count(');')
        assert row_count == 10

    def test_schema_prefix_always_present(self):
        """All table/view references use {schema}.{name} format."""
        cells = generate_cells(
            nodes=[
                sql_table_node('t1', schema='bronze'),
                sql_mlv_node('m1', schema='silver'),
            ],
            edges=[edge('t1', 'm1')],
            theme='ecommerce',
        )
        for cell in cells:
            if 'CREATE TABLE' in cell.code:
                assert 'bronze.t1' in cell.code
            if 'MATERIALIZED LAKE VIEW' in cell.code:
                assert 'silver.m1' in cell.code
                assert 'bronze.t1' in cell.code  # Parent reference
```

---

## Appendix A: Python Backend File Changes Summary

| File | Change | Scope |
|------|--------|-------|
| `scripts/dev-server.py` | Add 4 template routes + 1 wizard validate route to `do_GET`/`do_POST` | ~200 LOC |
| `scripts/dev-server.py` | Add `_templates_lock`, `validate_template_name()`, `_extract_schema_names()` | ~80 LOC |
| `scripts/dev-server.py` | Add `CURRENT_TEMPLATE_VERSION`, `MIGRATIONS`, `migrate_template()` | ~30 LOC |
| `tests/test_templates.py` | New file — template CRUD tests | ~200 LOC |
| `tests/test_wizard_steps.py` | New file — step registry and cell construction tests | ~250 LOC |

**Total new Python code:** ~760 LOC

## Appendix B: Frontend File Changes Summary

| File | Change | Scope |
|------|--------|-------|
| `src/frontend/js/api-client.js` | Add `listCapacities()`, `assignCapacity()`, `createNotebook()` | ~60 LOC |
| `src/frontend/js/execution-pipeline.js` | New file — C10 implementation (client-orchestrated pipeline) | ~1200 LOC |
| `src/frontend/js/template-manager.js` | New file — C12 frontend (save/load/delete via backend routes) | ~300 LOC |
| `src/frontend/js/notebook-cell-builder.js` | New file — topological sort + cell generation | ~600 LOC |

**Total new frontend code:** ~2160 LOC

## Appendix C: API Endpoint Verification Checklist

| # | Endpoint | Tested | Action Needed |
|---|----------|--------|--------------|
| 1 | POST /metadata/folders (create workspace) | ✅ Verified | — |
| 2 | POST /v1/workspaces/{id}/assignToCapacity | ⚠️ NOT TESTED | Test in PPE with known capacity |
| 3 | GET /v1.0/myorg/capacities (list capacities) | ⚠️ NOT TESTED | Test — may need admin scope |
| 4 | POST /v1/workspaces/{id}/lakehouses | ⚠️ NOT TESTED | Test with `enableSchemas: true` |
| 5 | POST /v1/workspaces/{id}/notebooks | ✅ Verified | — |
| 6 | POST .../notebooks/{id}/updateDefinition | ✅ Partially | Test with real cell payload |
| 7 | POST .../items/{id}/jobs/instances?jobType=RunNotebook | ✅ Verified | — |
| 8 | GET .../items/{id}/jobs/instances/{jobId} (LRO poll) | ✅ Verified | — |
| 9 | DELETE /v1/workspaces/{id} | ⚠️ NOT TESTED | Test in dedicated env (destructive) |
| 10 | DELETE /v1/workspaces/{id}/lakehouses/{id} | ⚠️ NOT TESTED | Test in dedicated env |
| 11 | DELETE /v1/workspaces/{id}/notebooks/{id} | ✅ Verified | — |

**Pre-implementation action:** Run manual tests against PPE for endpoints #2, #3, #4, #9, #10 before writing integration tests.
