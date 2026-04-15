# F09 API Playground — Architecture Document

> **Status:** COMPLETE
> **Authors:** Pixel (Class Design, Storage), Sana (Endpoint Data Model), Vex (Proxy Integration)
> **Date:** 2026-07-30
> **Depends On:** P1.1–P1.5 component specs (all complete)
> **Feeds Into:** P3.1–P3.5 state matrices, P4.1 interactive mock, P5 implementation

---

## Table of Contents

1. [ApiPlayground Class Design](#1-apiplayground-class-design)
2. [Endpoint Catalog Data Model](#2-endpoint-catalog-data-model)
3. [Proxy Integration](#3-proxy-integration)
4. [Storage Model](#4-storage-model)
5. [Module Dependency Graph](#5-module-dependency-graph)
6. [Module Wiring Diagram](#6-module-wiring-diagram)
7. [Event Flow Diagrams](#7-event-flow-diagrams)
8. [Error Propagation](#8-error-propagation)
9. [State Ownership Map](#9-state-ownership-map)

---

## §1. ApiPlayground Class Design

### 1.1 Class Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ApiPlayground                                   │
│─────────────────────────────────────────────────────────────────────────│
│  - _viewEl: HTMLElement           // #view-api container                │
│  - _apiClient: FabricApiClient    // injected, shared with main.js     │
│  - _stateManager: LogViewerState  // injected, shared with main.js     │
│  - _requestBuilder: RequestBuilder                                     │
│  - _responseViewer: ResponseViewer                                     │
│  - _endpointCatalog: EndpointCatalog                                   │
│  - _historySaved: HistorySaved                                         │
│  - _abortController: AbortController | null                            │
│  - _initialized: boolean                                               │
│─────────────────────────────────────────────────────────────────────────│
│  + constructor(viewEl, apiClient, stateManager)                        │
│  + init(): void                   // create DOM, wire children         │
│  + activate(): void               // called when sidebar selects 'api' │
│  + deactivate(): void             // called when leaving 'api' view    │
│  + destroy(): void                // teardown, remove listeners        │
│  - _buildDOM(): void              // scaffold .api-playground layout   │
│  - _wireEvents(): void            // connect child component callbacks │
│  - _handleSend(request): Promise  // orchestrate request lifecycle     │
│  - _handleEndpointSelect(ep): void                                     │
│  - _handleHistoryReplay(entry): void                                   │
│  - _resolveUrl(template): string  // expand template variables         │
│  - _determineRoute(url): 'proxy' | 'direct' | 'flt-proxy'             │
│  - _sanitizeForHistory(req, resp): object                              │
└─────────────────────────────────────────────────────────────────────────┘
          │ creates & owns           │ creates & owns
          ▼                          ▼
┌───────────────────┐  ┌───────────────────┐  ┌──────────────────────┐
│  RequestBuilder   │  │  ResponseViewer   │  │   HistorySaved       │
│───────────────────│  │───────────────────│  │──────────────────────│
│ - _el: HTMLElement│  │ - _el: HTMLElement│  │ - _el: HTMLElement   │
│ - _method: string │  │ - _jsonTree:      │  │ - _history: array    │
│ - _url: string    │  │     JsonTreeRender│  │ - _saved: array      │
│ - _headers: array │  │ - _activeTab:     │  │ - _storage: Storage  │
│ - _body: string   │  │     string        │  │ - _sidebarState: obj │
│ - _catalog:       │  │ - _response: obj  │  │──────────────────────│
│   EndpointCatalog │  │───────────────────│  │ + addHistoryEntry()  │
│───────────────────│  │ + showLoading()   │  │ + getHistory()       │
│ + getRequest(): {} │  │ + showResponse()  │  │ + clearHistory()     │
│ + setRequest(r)   │  │ + showError()     │  │ + saveRequest()      │
│ + validate(): bool│  │ + showEmpty()     │  │ + deleteSaved()      │
│ + generateCurl(): │  │ + clear()         │  │ + toggleSidebar()    │
│     string        │  │ + destroy()       │  │ + destroy()          │
│ + onSend: fn      │  └───────────────────┘  └──────────────────────┘
│ + destroy()       │          │ owns                                
└───────────────────┘          ▼                                      
        │ owns      ┌───────────────────┐
        ▼           │   JsonTree        │
┌─────────────────┐ │───────────────────│
│ EndpointCatalog │ │ - _container: El  │
│─────────────────│ │ - _data: object   │
│ - _endpoints: []│ │ - _options: {}    │
│ - _groups: []   │ │───────────────────│
│ - _searchQuery  │ │ + render(json)    │
│ - _isOpen: bool │ │ + expandAll()     │
│ - _focusIdx: int│ │ + collapseAll()   │
│─────────────────│ │ + search(q)       │
│ + open()        │ │ + destroy()       │
│ + close()       │ └───────────────────┘
│ + search(q)     │
│ + onSelect: fn  │
│ + destroy()     │
└─────────────────┘
```

### 1.2 Constructor Signature

```javascript
class ApiPlayground {
  /**
   * @param {HTMLElement} viewEl — the #view-api container element
   * @param {FabricApiClient} apiClient — shared instance from EdogLogViewer
   * @param {LogViewerState} stateManager — shared state (for config access)
   */
  constructor(viewEl, apiClient, stateManager) {
    this._viewEl = viewEl;
    this._apiClient = apiClient;
    this._stateManager = stateManager;
    this._initialized = false;
    this._abortController = null;

    // Children created in init()
    this._requestBuilder = null;
    this._responseViewer = null;
    this._endpointCatalog = null;
    this._historySaved = null;
  }
}
```

**Why these three parameters:** This matches the existing EDOG Studio pattern. Every view module receives `(viewEl, apiClient, stateManager)`. See `WorkspaceExplorer`, `RuntimeView`, `ControlPanel` in `main.js`. The `apiClient` provides token state and config; the `stateManager` is unused by the playground directly but passed for consistency and future use (e.g., log correlation).

### 1.3 Lifecycle

```
main.js                          ApiPlayground
  │                                    │
  │  new ApiPlayground(el, api, state) │
  │ ──────────────────────────────────>│  constructor: store refs only
  │                                    │
  │  sidebar.onViewChange('api')       │
  │ ──────────────────────────────────>│  activate()
  │                                    │    ├─ if !_initialized: init()
  │                                    │    │    ├─ _buildDOM()
  │                                    │    │    ├─ create child components
  │                                    │    │    ├─ _wireEvents()
  │                                    │    │    └─ _initialized = true
  │                                    │    └─ show view, refresh tokens
  │                                    │
  │  sidebar.onViewChange('runtime')   │
  │ ──────────────────────────────────>│  deactivate()
  │                                    │    ├─ abort in-flight request
  │                                    │    └─ close endpoint catalog dropdown
  │                                    │
  │  (page unload / view teardown)     │
  │ ──────────────────────────────────>│  destroy()
  │                                    │    ├─ destroy all children
  │                                    │    ├─ remove DOM
  │                                    │    └─ null all references
```

**Lazy initialization:** `init()` runs on first `activate()`, not on construction. This avoids rendering hidden DOM and matches the pattern used by `RuntimeView` tabs where `activate()` triggers first render.

### 1.4 Communication Model: Callbacks, Not Event Bus

**Decision: Direct callback wiring. No custom event bus.**

Rationale:
- The playground has exactly 6 components with well-defined relationships
- An event bus adds complexity (string-based event names, debugging difficulty, memory leaks from forgotten unsubscribes) without benefit for this module count
- Existing EDOG modules (Sidebar, RuntimeView, DeployFlow) all use direct callbacks (`onViewChange`, `onUpdate`, `onDetected`)
- Components communicate through 4 specific channels — each is a named callback property

**Callback wiring table:**

| Source | Callback | Consumer | Purpose |
|--------|----------|----------|---------|
| `RequestBuilder` | `onSend(request)` | `ApiPlayground._handleSend` | Trigger request execution |
| `EndpointCatalog` | `onSelect(endpoint)` | `ApiPlayground._handleEndpointSelect` | Populate builder from catalog |
| `HistorySaved` | `onReplay(entry)` | `ApiPlayground._handleHistoryReplay` | Replay a history/saved entry |
| `HistorySaved` | `onDelete(id)` | `ApiPlayground` (no-op, internal) | Delete saved request |

**ApiPlayground orchestrates all cross-component communication.** Children never reference each other directly. This keeps components testable in isolation and avoids circular dependencies.

```javascript
// In ApiPlayground._wireEvents():
_wireEvents() {
  this._requestBuilder.onSend = (request) => this._handleSend(request);

  this._endpointCatalog.onSelect = (endpoint) => {
    this._requestBuilder.setRequest({
      method: endpoint.method,
      url: endpoint.url,
      headers: this._buildHeaders(endpoint),
      body: endpoint.bodyTemplate
        ? JSON.stringify(endpoint.bodyTemplate, null, 2)
        : '',
    });
  };

  this._historySaved.onReplay = (entry) => {
    this._requestBuilder.setRequest({
      method: entry.method,
      url: entry.url,
      headers: entry.headers,
      body: entry.body || '',
    });
  };
}
```

### 1.5 Integration with main.js

The `ApiPlayground` is instantiated in `EdogLogViewer.constructor()` and wired into the sidebar view system:

```javascript
// In EdogLogViewer constructor (main.js):
this.apiPlayground = new ApiPlayground(
  document.getElementById('view-api'),
  this.apiClient,
  this.state
);

// In EdogLogViewer._onViewChange():
_onViewChange = (viewId) => {
  if (viewId === 'api') {
    this.apiPlayground.activate();
  } else {
    if (this.apiPlayground) this.apiPlayground.deactivate();
  }
  // ...existing runtime/workspace handling...
};
```

This is identical to how `WorkspaceExplorer` and `RuntimeView` are wired.

---

## §2. Endpoint Catalog Data Model

### 2.1 Endpoint Definition Schema

Each endpoint is a static object defined in `ENDPOINT_CATALOG` (a module-level constant in `api-playground.js`):

```jsonc
{
  "id": "string",                    // unique kebab-case (e.g. "get-workspace")
  "name": "string",                  // display name (e.g. "Get Workspace")
  "method": "GET|POST|PUT|PATCH|DELETE",
  "urlTemplate": "string",          // URL with template vars (e.g. "/v1/workspaces/{workspaceId}")
  "group": "string",                // group key (e.g. "Workspace")
  "tokenType": "bearer|mwc|none",   // determines auth header + routing
  "bodyTemplate": null | object,     // JSON body template; null for GET/DELETE
  "headers": [                       // additional headers beyond Authorization
    { "key": "string", "value": "string" }
  ],
  "description": "string",          // tooltip / status bar description
  "responseHint": "string",         // expected response shape
  "dangerLevel": "safe|caution|destructive"
}
```

### 2.2 Template Variable System

Template variables use `{varName}` syntax in URL templates. They resolve against the config object from `/api/flt/config`:

| Variable | Config Source | Example Value | Available |
|----------|-------------|---------------|-----------|
| `{workspaceId}` | `config.workspaceId` | `a1b2c3d4-...` | Phase 1+ |
| `{lakehouseId}` | `config.lakehouseId` | `e5f6g7h8-...` | Phase 1+ |
| `{artifactId}` | `config.artifactId` | `i9j0k1l2-...` | Phase 1+ |
| `{capacityId}` | `config.capacityId` | `m3n4o5p6-...` | Phase 1+ |
| `{fabricBaseUrl}` | `config.fabricBaseUrl` | `https://xyz.pbidedicated.windows.net` | Phase 2 only |
| `{iterationId}` | *(user-entered)* | `42` | Manual |
| `{tableName}` | *(user-entered)* | `customers` | Manual |
| `{notebookId}` | *(user-entered)* | `q7r8s9t0-...` | Manual |
| `{itemId}` | *(user-entered)* | `u1v2w3x4-...` | Manual |

**Resolution algorithm:**

```javascript
_resolveUrl(template) {
  const config = this._apiClient.getConfig() || {};
  const vars = {
    workspaceId:  config.workspaceId  || '{workspaceId}',
    lakehouseId:  config.lakehouseId  || '{lakehouseId}',
    artifactId:   config.artifactId   || '{artifactId}',
    capacityId:   config.capacityId   || '{capacityId}',
    fabricBaseUrl: config.fabricBaseUrl || '{fabricBaseUrl}',
    // User-entered vars are NOT auto-resolved — left as-is for user to fill
  };
  return template.replace(/\{(\w+)\}/g, (match, key) => vars[key] || match);
}
```

**Unresolved variables:** If a template variable has no config value and is not in the auto-resolve map, it stays as `{varName}` in the URL field. The URL input highlights unresolved variables with a distinct color (amber background per the request-builder spec) so the user can replace them manually before sending.

### 2.3 Group Definitions

10 groups, fixed order, defined as a constant:

```javascript
const ENDPOINT_GROUPS = [
  { id: 'workspace',   label: 'Workspace',   order: 0 },
  { id: 'items',       label: 'Items',       order: 1 },
  { id: 'lakehouse',   label: 'Lakehouse',   order: 2 },
  { id: 'tables',      label: 'Tables',      order: 3 },
  { id: 'notebooks',   label: 'Notebooks',   order: 4 },
  { id: 'environment', label: 'Environment', order: 5 },
  { id: 'dag',         label: 'DAG',         order: 6 },
  { id: 'execution',   label: 'Execution',   order: 7 },
  { id: 'spark',       label: 'Spark',       order: 8 },
  { id: 'maintenance', label: 'Maintenance', order: 9 },
];
```

### 2.4 Endpoint Count by Group

| # | Group | Bearer | MWC | Total | Has Destructive |
|---|-------|--------|-----|-------|-----------------|
| 0 | Workspace | 5 | 0 | 5 | Yes (Delete) |
| 1 | Items | 3 | 0 | 3 | Yes (Delete) |
| 2 | Lakehouse | 5 | 0 | 5 | Yes (Delete) |
| 3 | Tables | 1 | 3 | 4 | No |
| 4 | Notebooks | 4 | 0 | 4* | Yes (Delete) |
| 5 | Environment | 1 | 0 | 1 | No |
| 6 | DAG | 0 | 6 | 6 | No |
| 7 | Execution | 0 | 3 | 3 | No |
| 8 | Spark | 0 | 3 | 3 | No |
| 9 | Maintenance | 0 | 3 | 3 | Yes (Force Unlock) |
| | **Total** | **19** | **18** | **37** | |

*Notebooks: `run-notebook` uses bearer token but is a POST action.

### 2.5 Static Data — No Dynamic Endpoints

The catalog is a **frozen constant** in the JS source. Endpoints cannot be added at runtime.

**Rationale:**
- The 37 endpoints cover all known FLT and Fabric APIs used in development
- Users who need custom endpoints type them directly in the URL field or save them via the Saved Requests feature
- Dynamic endpoint loading would require a server-side registry with versioning, which is over-engineering for a localhost dev tool
- Future extension: if the catalog grows beyond 50 endpoints, extract to a JSON file loaded at init time

---

## §3. Proxy Integration

### 3.1 Request Routing Decision Tree

The API Playground must route requests through different paths depending on the target API and available tokens:

```
User clicks Send
       │
       ▼
┌─────────────────────┐
│ Inspect URL pattern  │
└─────┬───────────────┘
      │
      ├── URL starts with "/" or contains "api.fabric.microsoft.com"
      │   │
      │   ▼
      │  ┌──────────────────────────────────┐
      │  │ FABRIC API (Bearer token)         │
      │  │ Route: /api/playground/proxy      │
      │  │ Auth: Bearer token injected       │
      │  │   server-side by EdogLogServer    │
      │  └──────────────────────────────────┘
      │
      ├── URL starts with "{fabricBaseUrl}" or contains ".pbidedicated.windows.net"
      │   │
      │   ▼
      │  ┌──────────────────────────────────┐
      │  │ FLT API (MWC token)              │
      │  │ Route: /api/playground/proxy      │
      │  │ Auth: MwcToken injected           │
      │  │   server-side by EdogLogServer    │
      │  └──────────────────────────────────┘
      │
      └── URL is absolute (starts with "http")
          │
          ▼
         ┌──────────────────────────────────┐
         │ EXTERNAL URL                      │
         │ Route: /api/playground/proxy      │
         │ Auth: none (user-supplied headers)│
         └──────────────────────────────────┘
```

### 3.2 New Generic Proxy Endpoint

**Required:** A new endpoint on `EdogLogServer` to support arbitrary API calls from the playground:

```
POST /api/playground/proxy
```

**Request body:**

```jsonc
{
  "method": "GET|POST|PUT|PATCH|DELETE",
  "url": "https://api.fabric.microsoft.com/v1/workspaces",
  "headers": {
    "Content-Type": "application/json",
    "x-custom-header": "value"
  },
  "body": "{ ... }",          // string, null for GET/DELETE
  "tokenType": "bearer|mwc|none"
}
```

**Response body:**

```jsonc
{
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json",
    "x-ms-request-id": "abc-123"
  },
  "body": "{ \"value\": [...] }",   // raw response body as string
  "duration": 342,                   // server-measured duration in ms
  "bodySize": 12480                  // body byte count
}
```

**Why a new endpoint:**
- The existing `/api/fabric/*` proxy only supports Fabric REST API paths and always attaches the bearer token — it cannot route to capacity hosts or omit auth
- The existing `/api/mwc/*` proxy is limited to specific known endpoints (tables, table-details)
- The playground needs to call **any** URL with **any** token type — a generic proxy is the only clean solution
- Server-side proxying also solves CORS: the browser calls localhost, and the server makes the outbound request with no CORS restrictions

### 3.3 Server-Side Token Injection

The proxy endpoint **must inject tokens server-side**. The browser never sends raw tokens to the proxy — it sends `"tokenType": "bearer"` and the server looks up the token from its in-memory store.

```
Browser                          EdogLogServer                    Fabric API
  │                                   │                               │
  │ POST /api/playground/proxy        │                               │
  │ { method: "GET",                  │                               │
  │   url: "https://api.fabric.../",  │                               │
  │   tokenType: "bearer" }           │                               │
  │ ──────────────────────────────>   │                               │
  │                                   │ GET https://api.fabric.../    │
  │                                   │ Authorization: Bearer eyJ...  │
  │                                   │ ─────────────────────────────>│
  │                                   │                               │
  │                                   │ 200 OK { value: [...] }       │
  │                                   │ <─────────────────────────────│
  │                                   │                               │
  │ { status: 200, body: "..." }      │                               │
  │ <──────────────────────────────   │                               │
```

**Security implications:**
- Tokens never appear in browser DevTools network tab for proxy requests
- History entries store `tokenType: "bearer"` but never the raw token value
- The `Authorization` header in the request builder shows a masked value: `Bearer ●●●●●●●●`

### 3.4 Error Mapping

The proxy wraps all errors into a structured response. The playground never sees raw network errors from the upstream API — only structured proxy responses:

| Scenario | Proxy Response | Playground Display |
|----------|---------------|-------------------|
| API returns 4xx/5xx | `{ status: 401, body: "..." }` | Status badge (amber/red) + error body in response viewer |
| Network error (DNS, timeout) | `{ status: 0, statusText: "Network Error", body: "..." }` | Red "Network Error" badge + message |
| Token expired | `{ status: 401, body: "token expired" }` | 401 badge + "Token expired — refresh" action button |
| Token missing | `{ status: 0, statusText: "No Token", body: "No bearer token..." }` | Error state with "Configure token" link |
| Proxy itself fails | HTTP 500 from `/api/playground/proxy` | "Proxy Error" state with raw error message |
| Request timeout (30s) | `{ status: 0, statusText: "Timeout" }` | "Request timed out" message |

### 3.5 URL Resolution for Proxy

Before sending to the proxy, the playground resolves the URL into a fully qualified URL:

| URL Pattern in Builder | Resolved URL Sent to Proxy |
|----------------------|---------------------------|
| `/v1/workspaces` | `https://api.fabric.microsoft.com/v1/workspaces` |
| `/v1/workspaces/{workspaceId}` | `https://api.fabric.microsoft.com/v1/workspaces/a1b2c3d4-...` |
| `{fabricBaseUrl}/liveTable/...` | `https://xyz.pbidedicated.windows.net/liveTable/...` |
| `https://custom-url.com/api` | `https://custom-url.com/api` (passed through) |

Resolution order:
1. Expand template variables (`{workspaceId}` → config value)
2. If URL starts with `/` → prepend `https://api.fabric.microsoft.com`
3. If URL starts with `http` → use as-is
4. Otherwise → prepend `https://api.fabric.microsoft.com/` (treat as relative path)

### 3.6 Request Cancellation

The playground supports cancelling in-flight requests via `AbortController`:

```javascript
async _handleSend(request) {
  // Cancel any in-flight request
  if (this._abortController) {
    this._abortController.abort();
  }
  this._abortController = new AbortController();

  this._responseViewer.showLoading();

  try {
    const resp = await fetch('/api/playground/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: this._abortController.signal,
    });
    const result = await resp.json();
    this._responseViewer.showResponse(result);
    this._historySaved.addHistoryEntry(
      this._sanitizeForHistory(request, result)
    );
  } catch (e) {
    if (e.name === 'AbortError') return; // user cancelled
    this._responseViewer.showError(e);
  } finally {
    this._abortController = null;
  }
}
```

---

## §4. Storage Model

### 4.1 localStorage Key Map

| Key | Content | Max Size | Eviction |
|-----|---------|----------|----------|
| `edog-api-history` | Request/response history array | ~250KB (50 entries) | FIFO — oldest dropped when >50 |
| `edog-api-saved` | Saved/named requests array | ~100KB | Manual delete only |
| `edog-api-prefs` | UI preferences object | <1KB | None (overwritten) |

**Total budget:** ~351KB. Well within the 5MB localStorage limit per origin (localhost:5555 shares with other EDOG data).

### 4.2 History Entry Schema

```jsonc
// edog-api-history — Array, max 50 entries, newest first
// Schema version tracked in edog-api-prefs.schemaVersion
[
  {
    "id": "a1b2c3d4-...",              // crypto.randomUUID()
    "method": "GET",                   // HTTP method
    "url": "/v1/workspaces",           // URL as entered (template form, pre-resolution)
    "resolvedUrl": "https://api.fabric.microsoft.com/v1/workspaces",
    "headers": [                       // headers WITHOUT raw token values
      { "key": "Authorization", "value": "Bearer ●●●●" },
      { "key": "Content-Type", "value": "application/json" }
    ],
    "body": null,                      // request body string or null
    "tokenType": "bearer",             // which token was used (for replay)
    "response": {
      "status": 200,
      "statusText": "OK",
      "duration": 342,                 // ms
      "bodySize": 12480,               // bytes
      "bodyPreview": "{ \"value\": [...] }"  // first 500 chars
    },
    "timestamp": "2026-07-30T10:30:00.000Z"
  }
]
```

### 4.3 Token Sanitization — CRITICAL SECURITY RULE

**Raw tokens are NEVER stored in localStorage.** Period.

The sanitization step runs before any history entry is persisted:

```javascript
_sanitizeForHistory(request, response) {
  const sanitizedHeaders = request.headers.map(h => {
    if (h.key.toLowerCase() === 'authorization') {
      return { key: h.key, value: h.value.replace(/\s.+$/, ' ●●●●') };
    }
    return { ...h };
  });

  return {
    id: crypto.randomUUID(),
    method: request.method,
    url: request.url,                    // template URL, not resolved
    resolvedUrl: request.resolvedUrl,
    headers: sanitizedHeaders,
    body: request.body,
    tokenType: request.tokenType,        // "bearer" | "mwc" | "none"
    response: {
      status: response.status,
      statusText: response.statusText,
      duration: response.duration,
      bodySize: response.bodySize,
      bodyPreview: (response.body || '').substring(0, 500),
    },
    timestamp: new Date().toISOString(),
  };
}
```

**On replay:** The `tokenType` field tells the proxy which token to inject. The actual token is never in the history entry.

### 4.4 Saved Request Schema

```jsonc
// edog-api-saved — Array, ordered by group then position
[
  {
    "id": "f1e2d3c4-...",
    "name": "List Workspaces",           // user-visible name
    "group": "Fabric",                   // "Fabric" | "FLT" | "Maintenance" | "Custom"
    "method": "GET",
    "url": "/v1/workspaces",             // template URL
    "headers": [
      { "key": "Content-Type", "value": "application/json" }
    ],
    "body": null,
    "tokenType": "bearer",
    "isBuiltIn": true,                   // true = from catalog, false = user-created
    "createdAt": "2026-07-30T10:00:00Z"
  }
]
```

**Built-in entries:** On first load, if `edog-api-saved` is empty or missing, populate it with a curated subset of the endpoint catalog (most commonly used endpoints). Built-in entries have `isBuiltIn: true` and cannot be deleted (only hidden, tracked in prefs).

### 4.5 UI Preferences Schema

```jsonc
// edog-api-prefs
{
  "schemaVersion": 1,                    // for future migration
  "sidebarCollapsed": false,
  "sidebarWidth": 280,                   // px (if resizable in future)
  "historySectionExpanded": true,
  "savedSectionExpanded": true,
  "savedGroupsExpanded": {
    "Fabric": true,
    "FLT": true,
    "Maintenance": false,
    "Custom": true
  },
  "historyMethodFilter": "ALL",          // "ALL" | "GET" | "POST" | etc.
  "responseViewMode": "pretty",          // "pretty" | "raw"
  "responseActiveTab": "body",           // "body" | "headers" | "cookies"
  "jsonTreeDepth": 2,                    // default expand depth
  "lastMethod": "GET",                   // last used method (for empty state)
  "hiddenBuiltIns": []                   // IDs of hidden built-in saved entries
}
```

### 4.6 Size Management

**History (50 entries, ~250KB):**

```javascript
addHistoryEntry(entry) {
  const history = this._loadHistory();
  history.unshift(entry);                // newest first

  // Evict oldest entries beyond limit
  while (history.length > 50) {
    history.pop();
  }

  // Size safety: if serialized size > 300KB, drop entries until under
  let serialized = JSON.stringify(history);
  while (serialized.length > 300_000 && history.length > 10) {
    history.pop();
    serialized = JSON.stringify(history);
  }

  localStorage.setItem('edog-api-history', serialized);
  this._history = history;
  this._renderHistory();
}
```

**Response body preview:** Capped at 500 characters in history entries. Full response bodies are never stored in history — they are transient (shown in Response Viewer only for the current/last request).

### 4.7 Schema Migration Strategy

The `schemaVersion` field in `edog-api-prefs` enables future migrations:

```javascript
_migrateStorage() {
  const prefs = this._loadPrefs();
  const version = prefs.schemaVersion || 0;

  if (version < 1) {
    // v0 → v1: add tokenType field to history entries
    const history = this._loadHistory();
    for (const entry of history) {
      if (!entry.tokenType) {
        entry.tokenType = entry.url.includes('pbidedicated') ? 'mwc' : 'bearer';
      }
    }
    this._saveHistory(history);
    prefs.schemaVersion = 1;
    this._savePrefs(prefs);
  }

  // Future: if (version < 2) { ... }
}
```

**Migration runs once** in `HistorySaved.init()` before any read/write operations.

---

## §5. Module Dependency Graph

```
                    ┌──────────────────┐
                    │     main.js      │
                    │  EdogLogViewer   │
                    └────────┬─────────┘
                             │ creates
                             ▼
                    ┌──────────────────┐
                    │  ApiPlayground   │
                    │  (orchestrator)  │
                    └──┬──┬──┬──┬─────┘
          ┌────────────┘  │  │  └──────────────┐
          ▼               │  │                  ▼
  ┌───────────────┐       │  │        ┌──────────────────┐
  │RequestBuilder │       │  │        │   HistorySaved    │
  └──────┬────────┘       │  │        └──────────────────┘
         │ owns           │  │                  │
         ▼                │  │                  │ reads/writes
  ┌───────────────┐       │  │        ┌──────────────────┐
  │EndpointCatalog│       │  │        │   localStorage    │
  └───────────────┘       │  │        └──────────────────┘
                          │  │
                          ▼  ▼
                ┌──────────────────┐
                │  ResponseViewer  │
                └────────┬─────────┘
                         │ owns
                         ▼
                ┌──────────────────┐
                │    JsonTree      │
                └──────────────────┘

External dependencies (shared, not owned):
  ┌──────────────────┐     ┌──────────────────┐
  │  FabricApiClient  │     │  LogViewerState   │
  │  (api-client.js)  │     │    (state.js)     │
  └──────────────────┘     └──────────────────┘
          ▲                         ▲
          │ reads config/tokens     │ reads config
          └─────────┬───────────────┘
                    │
               ApiPlayground
```

**No circular dependencies.** The dependency graph is a strict DAG:
- `main.js` → `ApiPlayground` → `{RequestBuilder, ResponseViewer, HistorySaved}`
- `RequestBuilder` → `EndpointCatalog`
- `ResponseViewer` → `JsonTree`

### 5.1 File Organization

```
src/frontend/js/
  ├── api-playground.js        // ApiPlayground + RequestBuilder + ResponseViewer
  │                            //   + EndpointCatalog + HistorySaved (all in one file)
  ├── json-tree.js             // JsonTreeRenderer (standalone, reusable)
  ├── api-client.js            // FabricApiClient (existing, unchanged)
  └── main.js                  // EdogLogViewer (adds playground wiring)

src/frontend/css/
  ├── api-playground.css       // existing 122 lines + extensions
  └── json-tree.css            // new, standalone

src/backend/DevMode/
  └── EdogLogServer.cs         // add /api/playground/proxy endpoint
```

**Single-file decision:** All playground classes live in `api-playground.js` (estimated ~800–1000 lines). The alternative — 5 separate files — would add 5 `<script>` tags to the single-file HTML build, increase load order complexity, and break the existing pattern where each "view" is one file. If the file exceeds 1200 lines, extract `EndpointCatalog` or `HistorySaved` into their own files.

**Exception:** `JsonTree` is a separate file (`json-tree.js`) because it is a generic reusable component that could be used by other views (e.g., Runtime View detail panel for JSON payloads).

---

## §6. Module Wiring Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              #view-api                                     │
│                                                                             │
│  ┌──────────────────────────────────────────────────┐ ┌──────────────────┐ │
│  │              .api-main                            │ │  .api-sidebar    │ │
│  │                                                   │ │                  │ │
│  │  ┌─────────────────────────────────────────────┐  │ │ ┌──────────────┐│ │
│  │  │         RequestBuilder                      │  │ │ │  HISTORY     ││ │
│  │  │  ┌────────────────────┐                     │  │ │ │              ││ │
│  │  │  │ EndpointCatalog    │◄──── onSelect ──────┼──┼─┼─┤  onReplay   ││ │
│  │  │  └────────────────────┘                     │  │ │ │     │       ││ │
│  │  │                                             │  │ │ │     ▼       ││ │
│  │  │  [Method] [URL _______________] [Send]      │  │ │ │ history[]   ││ │
│  │  │  [Headers] [Body] [Params]                  │  │ │ │              ││ │
│  │  │                                  │          │  │ │ ├──────────────┤│ │
│  │  │                         onSend ──┘          │  │ │ │  SAVED       ││ │
│  │  └─────────────────────────────────────────────┘  │ │ │              ││ │
│  │         │                                         │ │ │  ▸ Fabric    ││ │
│  │         │ ApiPlayground._handleSend()             │ │ │  ▸ FLT       ││ │
│  │         ▼                                         │ │ │  ▸ Custom    ││ │
│  │  ┌─────────────────────────────────────────────┐  │ │ └──────────────┘│ │
│  │  │         ResponseViewer                      │  │ │                  │ │
│  │  │  [Status] [Timing] [Size]                   │  │ │ addHistoryEntry()│ │
│  │  │  [Body] [Headers] [Cookies]   [Pretty|Raw]  │  │ │       ▲         │ │
│  │  │  ┌───────────────────────────────────────┐  │  │ │       │         │ │
│  │  │  │         JsonTree                      │  │  │ └───────┼─────────┘ │
│  │  │  │  { "value": [...] }                   │  │  │         │           │
│  │  │  └───────────────────────────────────────┘  │  │         │           │
│  │  └─────────────────────────────────────────────┘  │         │           │
│  └──────────────────────────────────────┬────────────┘         │           │
│                                          │                      │           │
│                               ApiPlayground                     │           │
│                            (orchestrates all) ──────────────────┘           │
│                                    │                                        │
│                                    │ POST /api/playground/proxy             │
│                                    ▼                                        │
│                         ┌──────────────────┐                                │
│                         │  EdogLogServer   │                                │
│                         │  (C# backend)    │                                │
│                         └──────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## §7. Event Flow Diagrams

### 7.1 Request Lifecycle (Send)

```
User clicks [Send]
       │
       ▼
RequestBuilder.onSend(request)
       │  request = { method, url, headers, body }
       ▼
ApiPlayground._handleSend(request)
       │
       ├─ 1. Validate: RequestBuilder.validate()
       │     └─ FAIL → show validation error toast, return
       │
       ├─ 2. Resolve URL: _resolveUrl(request.url)
       │     └─ Expand {workspaceId}, {fabricBaseUrl}, etc.
       │
       ├─ 3. Determine route: _determineRoute(resolvedUrl)
       │     └─ Returns tokenType: "bearer" | "mwc" | "none"
       │
       ├─ 4. Cancel previous: _abortController.abort()
       │
       ├─ 5. Show loading: ResponseViewer.showLoading()
       │
       ├─ 6. Execute: fetch('/api/playground/proxy', { ... })
       │     │
       │     ├─ SUCCESS (proxy returns structured response)
       │     │     │
       │     │     ├─ ResponseViewer.showResponse(result)
       │     │     │     ├─ Update status badge
       │     │     │     ├─ Update timing display
       │     │     │     ├─ If body is JSON → JsonTree.render(body)
       │     │     │     └─ If body is non-JSON → show raw text
       │     │     │
       │     │     └─ HistorySaved.addHistoryEntry(sanitized)
       │     │           ├─ Sanitize tokens
       │     │           ├─ Prepend to history array
       │     │           ├─ Evict if >50
       │     │           ├─ Save to localStorage
       │     │           └─ Re-render history list
       │     │
       │     ├─ ABORT (user cancelled)
       │     │     └─ No-op (ResponseViewer stays in loading or reverts)
       │     │
       │     └─ ERROR (network/proxy failure)
       │           └─ ResponseViewer.showError(error)
       │
       └─ 7. Clear abort controller
```

### 7.2 Endpoint Selection

```
User opens EndpointCatalog dropdown
       │
       ▼
EndpointCatalog.open()
       │  Show dropdown, focus search input
       │
User types search query
       │
       ▼
EndpointCatalog._filterEndpoints(query)
       │  Fuzzy match against name, URL, group
       │  Re-render filtered list with highlights
       │
User selects endpoint (click or Enter)
       │
       ▼
EndpointCatalog.onSelect(endpoint)
       │
       ▼
ApiPlayground._handleEndpointSelect(endpoint)
       │
       ├─ RequestBuilder.setRequest({
       │     method: endpoint.method,
       │     url: _resolveUrl(endpoint.urlTemplate),
       │     headers: _buildHeaders(endpoint),
       │     body: endpoint.bodyTemplate ? JSON.stringify(...) : ''
       │  })
       │
       └─ EndpointCatalog.close()
```

### 7.3 History Replay

```
User clicks history entry
       │
       ▼
HistorySaved.onReplay(entry)
       │
       ▼
ApiPlayground._handleHistoryReplay(entry)
       │
       └─ RequestBuilder.setRequest({
              method: entry.method,
              url: entry.url,           // template URL (not resolved)
              headers: entry.headers,    // sanitized headers (token masked)
              body: entry.body || ''
          })
              │
              └─ Note: Authorization header is masked (●●●●).
                 When user clicks Send, the proxy injects the
                 CURRENT token (not the historical one).
                 This is correct behavior — old tokens are expired.
```

---

## §8. Error Propagation

### 8.1 Error Boundary Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        Error Zones                              │
│                                                                 │
│  Zone 1: Input Validation (RequestBuilder)                      │
│  ├─ Empty URL → inline error message under URL field            │
│  ├─ Invalid JSON body → inline error under body textarea        │
│  ├─ Unresolved template vars → amber highlight on {var}         │
│  └─ Caught BY: RequestBuilder.validate()                        │
│  └─ Surfaced AS: inline field-level error messages              │
│                                                                 │
│  Zone 2: Network / Proxy (ApiPlayground._handleSend)            │
│  ├─ Proxy unreachable → ResponseViewer.showError()              │
│  ├─ Proxy returns 500 → ResponseViewer.showError()              │
│  ├─ Request timeout → ResponseViewer.showError()                │
│  └─ Caught BY: try/catch in _handleSend                         │
│  └─ Surfaced AS: error state in Response Viewer panel           │
│                                                                 │
│  Zone 3: API Errors (structured response from proxy)            │
│  ├─ 4xx → ResponseViewer.showResponse() with amber badge        │
│  ├─ 5xx → ResponseViewer.showResponse() with red badge          │
│  ├─ 401 → badge + "Token expired — refresh" action              │
│  └─ Caught BY: proxy returns structured error response          │
│  └─ Surfaced AS: normal response display (status badge colored) │
│                                                                 │
│  Zone 4: Storage (HistorySaved)                                 │
│  ├─ localStorage full → drop oldest entries, retry              │
│  ├─ Corrupted data → reset to empty array, log warning          │
│  └─ Caught BY: try/catch in HistorySaved._load*()               │
│  └─ Surfaced AS: silent recovery (no user-facing error)         │
│                                                                 │
│  Zone 5: JSON Parsing (JsonTree)                                │
│  ├─ Invalid JSON → show raw text with "Invalid JSON" notice     │
│  ├─ Oversized JSON (>500KB) → truncate + download link          │
│  └─ Caught BY: JsonTree.render()                                │
│  └─ Surfaced AS: graceful fallback in Response Viewer           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 Error Propagation Rules

1. **Components catch their own errors.** No error propagates from a child to ApiPlayground uncaught.
2. **API errors are not exceptions.** A 404 response is a successful request that returned 404 — it is displayed normally with the appropriate status badge color.
3. **Only true failures use the error state:** network down, proxy crash, AbortError.
4. **Storage errors are silent.** If localStorage fails, the feature degrades gracefully (no history, no saved requests) but the core send/receive workflow continues.
5. **No `console.error` for expected states.** Token expiry is expected — don't pollute the console.

---

## §9. State Ownership Map

Every piece of mutable state has exactly one owner. No shared mutable state between components.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         STATE OWNERSHIP                                │
│                                                                         │
│  ApiPlayground (owns orchestration state)                               │
│  ├─ _abortController: AbortController | null    // in-flight request    │
│  ├─ _initialized: boolean                       // lazy init flag       │
│  └─ (no domain state — delegates to children)                           │
│                                                                         │
│  RequestBuilder (owns request composition state)                        │
│  ├─ _method: string            // current HTTP method                   │
│  ├─ _url: string               // current URL (may have template vars)  │
│  ├─ _headers: Array<{key,val}> // current header list                   │
│  ├─ _body: string              // current body text                     │
│  ├─ _activeTab: string         // "headers" | "body" | "params"         │
│  └─ _validationErrors: object  // field-level errors                    │
│                                                                         │
│  EndpointCatalog (owns dropdown UI state)                               │
│  ├─ _isOpen: boolean           // dropdown visibility                   │
│  ├─ _searchQuery: string       // current search text                   │
│  ├─ _focusIndex: number        // keyboard navigation position          │
│  ├─ _filteredEndpoints: array  // computed from search                  │
│  └─ _selectedId: string|null   // currently selected endpoint ID        │
│                                                                         │
│  ResponseViewer (owns response display state)                           │
│  ├─ _state: string             // "empty" | "loading" | "success" | "error"
│  ├─ _response: object | null   // current response data                 │
│  ├─ _activeTab: string         // "body" | "headers" | "cookies"        │
│  ├─ _viewMode: string          // "pretty" | "raw"                      │
│  └─ _jsonTree: JsonTree | null // owned child instance                  │
│                                                                         │
│  JsonTree (owns tree rendering state)                                   │
│  ├─ _data: object | null       // parsed JSON                           │
│  ├─ _expandedPaths: Set        // set of expanded node paths            │
│  ├─ _searchMatches: array      // current search highlights             │
│  └─ _matchIndex: number        // active match cursor                   │
│                                                                         │
│  HistorySaved (owns persistence state)                                  │
│  ├─ _history: array            // in-memory copy of edog-api-history    │
│  ├─ _saved: array              // in-memory copy of edog-api-saved      │
│  ├─ _prefs: object             // in-memory copy of edog-api-prefs      │
│  ├─ _sidebarCollapsed: boolean // sidebar visibility                    │
│  ├─ _historyFilter: string     // method filter                         │
│  └─ _expandedGroups: object    // per-group collapse state              │
│                                                                         │
│  FabricApiClient (external — READ-ONLY access by playground)            │
│  ├─ _config: object            // read via getConfig()                  │
│  ├─ _bearerToken: string       // never accessed directly               │
│  ├─ _mwcToken: string          // never accessed directly               │
│  └─ _phase: string             // read via getPhase()                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 9.1 State Flow Rules

1. **ApiPlayground reads config from FabricApiClient** (via `getConfig()`) to resolve template variables. It never modifies FabricApiClient state.
2. **RequestBuilder holds the current form state** — method, URL, headers, body. This state is ephemeral (not persisted). On endpoint select or history replay, ApiPlayground calls `setRequest()` which overwrites the form state.
3. **HistorySaved is the single source of truth for persisted data.** It loads from localStorage on init, keeps an in-memory copy, and writes back on mutation. No other component reads localStorage directly.
4. **ResponseViewer owns the current response** — it is set by ApiPlayground after a successful request. The previous response is discarded (not cached).
5. **EndpointCatalog is stateless w.r.t. persistent data.** Its endpoint list is a static constant. Only transient UI state (open/closed, search query, focus index) is held in memory.

---

## Appendix A: Implementation Sequence

Based on the dependency graph, the implementation order is:

```
1. JsonTree          — standalone, no deps, testable in isolation
2. EndpointCatalog   — standalone data + dropdown, needs only ENDPOINT_CATALOG const
3. ResponseViewer    — depends on JsonTree
4. RequestBuilder    — depends on EndpointCatalog
5. HistorySaved      — depends on localStorage, standalone
6. ApiPlayground     — orchestrator, depends on all above
7. EdogLogServer     — add /api/playground/proxy endpoint (C#)
8. main.js wiring    — instantiate ApiPlayground, wire into sidebar
```

Layers 1–5 can be built and tested without the backend proxy. Layer 6 (ApiPlayground) can be tested with a mock proxy. Layer 7 requires the C# endpoint.

---

## Appendix B: CSS Architecture

The playground extends the existing `api-playground.css` (122 lines) with additional styles for new components. All new CSS follows the existing patterns:

- **Variables from `variables.css`:** `--space-N`, `--text-sm`, `--font-mono`, `--accent`, `--border`, `--surface`, etc.
- **OKLCH colors:** All new color definitions use OKLCH (per project rules)
- **BEM-like naming:** `.api-{component}-{element}` (e.g., `.api-catalog-dropdown`, `.api-history-item`)
- **No new CSS files** for playground components — extend `api-playground.css`
- **One new CSS file:** `json-tree.css` for the standalone JSON tree renderer

---

## Appendix C: Keyboard Shortcuts

| Shortcut | Action | Scope |
|----------|--------|-------|
| `Ctrl+Enter` | Send request | Request Builder focused |
| `Ctrl+H` | Toggle sidebar | API Playground view |
| `Ctrl+L` | Clear response | API Playground view |
| `Escape` | Close endpoint catalog / Cancel request | Dropdown open / Request in-flight |
| `Ctrl+Shift+C` | Copy as cURL | Request Builder focused |
| `/` | Focus endpoint catalog search | API Playground view (no input focused) |
| `↑` / `↓` | Navigate catalog / history | Dropdown or sidebar focused |
| `Enter` | Select item | Dropdown or sidebar focused |
