# P0 Foundation Research — F09 API Playground

> **Date:** 2026-04-14
> **Researchers:** Vex (backend audit), Sana (API catalog + industry), Pixel (UI patterns)
> **Status:** SPEC COMPLETE

---

## §1. Existing Code Audit

### 1.1 Frontend Assets

**`src/frontend/css/api-playground.css` — 122 lines (EXISTS)**

Basic layout scaffold. Covers:
- `.api-playground` — flexbox shell (main + sidebar)
- `.api-request-section` — method selector, URL input, send button
- `.api-response-section` — status badge, timing, response body
- `.api-sidebar` — saved requests + history items
- `.api-headers` — key-value header editor rows
- Method pills, hover states, focus rings

**Missing CSS coverage:**
- JSON tree renderer (collapsible nodes, syntax coloring)
- Endpoint catalog dropdown/modal
- Loading/error states
- Batch runner UI
- Empty states (no response yet, no history)
- Animation/transitions (entrance, accordion, toast)
- Template variable highlight in URL field
- Response tabs (Headers / Body / Raw)
- Keyboard focus management
- Resizable split pane

**`src/frontend/index.html` line 268 — Empty state placeholder**
```html
<div id="view-api" class="view-panel" data-view="api">
  <div class="view-empty-state">
    <span class="empty-icon">▷</span>
    <span class="empty-text">API Playground — coming in V1.1</span>
  </div>
</div>
```

**No JS module exists.** The class is defined in the feature spec but not implemented.

### 1.2 Backend Infrastructure

**`src/backend/DevMode/EdogApiProxy.cs` (343 lines)**
- Serves `/api/flt/config` — returns `{ workspaceId, artifactId, capacityId, tokenExpiryMinutes, tokenExpired, mwcToken, fabricBaseUrl, bearerToken, phase }`
- Serves `/api/edog/health` — returns `{ hasBearerToken, bearerExpiresIn, lastUsername, gitBranch, gitDirtyFiles }`
- Reads tokens from `.edog-token-cache` (MWC) and `.edog-bearer-cache` (Bearer)
- Both tokens encoded as `base64(timestamp|token)` with 5-minute expiry buffer
- **Key for API Playground:** Config endpoint provides all tokens + template variables the playground needs

**`src/frontend/js/api-client.js` (509 lines) — FabricApiClient class**
- Two-mode token management: `_bearerToken` (Fabric) and `_mwcToken` (FLT)
- `_fabricFetch()` — wraps fetch with Bearer token, throws on failure with `.status`, `.body`, `.path`
- `_fltFetch()` — wraps fetch with `MwcToken` auth scheme, returns null on failure (non-throwing)
- Proxy routing: browser calls `/api/fabric/*` → dev-server proxies to redirect host
- **Key insight for Playground:** The playground should NOT reuse FabricApiClient — it needs raw fetch with user-controllable method/URL/headers/body. But it SHOULD read tokens from FabricApiClient's config.

**`src/backend/DevMode/EdogLogServer.cs`**
- Serves static files + routes API requests
- Existing proxy routes: `/api/fabric/*`, `/api/mwc/*`, `/api/notebook/*`
- **Playground proxy consideration:** For FLT endpoints (capacity host), the browser can call directly with MwcToken. For Fabric redirect host endpoints, must proxy through `/api/fabric/*` due to CORS.

**`src/backend/DevMode/EdogTokenInterceptor.cs` (236 lines)**
- Captures auth header metadata (type, audience, expiry) from HTTP pipeline
- Does NOT capture raw tokens (security)
- **Not directly relevant to Playground** — interceptor is for telemetry, not request building

### 1.3 Mock Data (Already Defined)

**`src/frontend/js/mock-data.js` lines 187-206**
- `savedRequests` array with 9 pre-configured endpoints (3 Fabric, 3 FLT, 2 Maintenance, 1 table listing)
- `apiHistory` array with 5 sample history entries
- Groups: `Fabric`, `FLT`, `Maintenance`
- **This is the starting point for our endpoint catalog** — will be expanded significantly

---

## §2. Data Source Mapping

### 2.1 Token Lifecycle

| Token | Scheme | Obtained Via | Cached In | TTL | Audience |
|-------|--------|-------------|-----------|-----|----------|
| Bearer (PBI) | `Bearer {token}` | Playwright captures from browser auth flow | `.edog-bearer-cache` | ~60 min | `analysis.windows-int.net/powerbi/api` |
| MWC | `MwcToken {token}` | POST `/metadata/v201606/generatemwctoken` using Bearer | `.edog-token-cache` | ~60 min | Capacity-specific |

**Playground auto-fill logic:**
- Phase 1 (disconnected): Auto-fill `Authorization: Bearer {bearerToken}` for Fabric endpoints
- Phase 2 (connected): Auto-fill `Authorization: MwcToken {mwcToken}` for FLT/capacity endpoints
- User can override both — manual token entry supported

### 2.2 Config Response Schema (`/api/flt/config`)

```json
{
  "workspaceId": "guid",
  "artifactId": "guid",
  "capacityId": "guid",
  "tokenExpiryMinutes": 42,
  "tokenExpired": false,
  "mwcToken": "eyJ...",
  "fabricBaseUrl": "https://{capacityId}.pbidedicated.windows-int.net/webapi/...",
  "bearerToken": "eyJ...",
  "phase": "connected" | "disconnected"
}
```

**Template variable mapping:**
| Variable | Source | Example |
|----------|--------|---------|
| `{workspaceId}` | `config.workspaceId` | `12345678-1234-1234-1234-123456789abc` |
| `{artifactId}` | `config.artifactId` | `87654321-4321-4321-4321-cba987654321` |
| `{capacityId}` | `config.capacityId` | `ABCDEF12` |
| `{fabricBaseUrl}` | `config.fabricBaseUrl` | Full capacity host URL |
| `{iterationId}` | User-provided | DAG iteration GUID |
| `{bearerToken}` | `config.bearerToken` | JWT string |
| `{mwcToken}` | `config.mwcToken` | JWT string |

### 2.3 Proxy Architecture (CORS Handling)

```
┌─────────────────────────────────────────────────────────────────┐
│                      API Playground                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Fabric APIs (redirect host)                                    │
│  Browser → /api/fabric/* → EdogLogServer → redirect host        │
│  Auth: Bearer {token} (injected by proxy)                       │
│                                                                 │
│  FLT APIs (capacity host)                                       │
│  Browser → {fabricBaseUrl}/* → capacity host DIRECTLY            │
│  Auth: MwcToken {token} (set by browser, no CORS issue)         │
│  Note: Capacity host has CORS headers for localhost              │
│                                                                 │
│  EDOG Internal APIs                                             │
│  Browser → /api/flt/config, /api/edog/health → localhost:5555   │
│  Auth: None (local server)                                      │
│                                                                 │
│  NEW REQUIREMENT: Generic proxy endpoint                        │
│  Browser → /api/playground/proxy → ANY URL                      │
│  For endpoints not covered by existing proxies                  │
│  Auth: Pass-through from request headers                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Decision:** For V1, use existing proxy routes (`/api/fabric/*`) for Fabric APIs and direct calls for FLT APIs. A generic proxy endpoint (`/api/playground/proxy`) can be added in V2 if users need to call arbitrary URLs.

---

## §3. FLT + Fabric API Endpoint Catalog

### 3.1 Fabric APIs (Bearer Token, via proxy)

| # | Name | Method | Path | Group |
|---|------|--------|------|-------|
| 1 | List Workspaces | GET | `/v1.0/myorg/groups` | Workspace |
| 2 | Get Workspace | GET | `/v1/workspaces/{workspaceId}` | Workspace |
| 3 | Create Workspace | POST | `/metadata/folders` | Workspace |
| 4 | Rename Workspace | PATCH | `/v1/workspaces/{workspaceId}` | Workspace |
| 5 | Delete Workspace | DELETE | `/v1/workspaces/{workspaceId}` | Workspace |
| 6 | List Items | GET | `/v1/workspaces/{workspaceId}/items` | Items |
| 7 | Rename Item | PATCH | `/v1/workspaces/{workspaceId}/items/{itemId}` | Items |
| 8 | Delete Item | DELETE | `/v1/workspaces/{workspaceId}/items/{itemId}` | Items |
| 9 | List Lakehouses | GET | `/v1/workspaces/{workspaceId}/lakehouses` | Lakehouse |
| 10 | Get Lakehouse | GET | `/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}` | Lakehouse |
| 11 | Create Lakehouse | POST | `/v1/workspaces/{workspaceId}/lakehouses` | Lakehouse |
| 12 | Rename Lakehouse | PATCH | `/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}` | Lakehouse |
| 13 | Delete Lakehouse | DELETE | `/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}` | Lakehouse |
| 14 | List Tables | GET | `/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables` | Tables |
| 15 | List Notebooks | GET | `/v1/workspaces/{workspaceId}/notebooks` | Notebooks |
| 16 | Get Notebook | GET | `/v1/workspaces/{workspaceId}/notebooks/{notebookId}` | Notebooks |
| 17 | Create Notebook | POST | `/v1/workspaces/{workspaceId}/notebooks` | Notebooks |
| 18 | Delete Notebook | DELETE | `/v1/workspaces/{workspaceId}/notebooks/{notebookId}` | Notebooks |
| 19 | Run Notebook | POST | `/v1/workspaces/{workspaceId}/items/{notebookId}/jobs/instances?jobType=RunNotebook` | Notebooks |
| 20 | List Environments | GET | `/v1/workspaces/{workspaceId}/environments` | Environment |
| 21 | List Livy Sessions | GET | `/v1/workspaces/{workspaceId}/spark/livySessions` | Spark |

### 3.2 FLT Service APIs (MWC Token, direct to capacity host)

| # | Name | Method | Path (appended to fabricBaseUrl) | Group |
|---|------|--------|----------------------------------|-------|
| 22 | Get Latest DAG | GET | `/liveTable/getLatestDag?showExtendedLineage=true` | DAG |
| 23 | Run DAG | POST | `/liveTableSchedule/runDAG/{iterationId}` | DAG |
| 24 | Cancel DAG | POST | `/liveTableSchedule/cancelDAG/{iterationId}` | DAG |
| 25 | Get DAG Exec Status | GET | `/liveTableSchedule/getDAGExecStatus/{iterationId}` | DAG |
| 26 | DAG Settings | GET | `/liveTable/settings` | DAG |
| 27 | Patch DAG Settings | PATCH | `/liveTable/patchDagSettings` | DAG |
| 28 | Ping FLT | GET | `...publicUnprotected/ping` | Health |

### 3.3 Maintenance APIs (MWC Token)

| # | Name | Method | Path | Group |
|---|------|--------|------|-------|
| 29 | Force Unlock DAG | POST | `/liveTableMaintenance/forceUnlockDAGExecution` | Maintenance |
| 30 | List Orphaned Folders | GET | `/liveTableMaintenance/listOrphanedIndexFolders` | Maintenance |

### 3.4 Capacity Host APIs (MWC Token)

| # | Name | Method | Path | Group |
|---|------|--------|------|-------|
| 31 | List Tables (Schema) | GET | `.../DataArtifact/{lhId}/schemas/dbo/tables` | Tables |
| 32 | Batch Table Details | POST | `.../DataArtifact/{lhId}/schemas/dbo/batchGetTableDetails` | Tables |
| 33 | Table Preview | POST | `.../Lakehouse/{lhId}/tables/{tableName}/previewAsync` | Tables |
| 34 | Generate MWC Token | POST | `/metadata/v201606/generatemwctoken` | Auth |
| 35 | Spark Settings | GET | `.../SparkCoreService/.../sparkSettings` | Spark |

### 3.5 EDOG Internal APIs (No auth)

| # | Name | Method | Path | Group |
|---|------|--------|------|-------|
| 36 | Get Config | GET | `/api/flt/config` | EDOG |
| 37 | Health Check | GET | `/api/edog/health` | EDOG |

**Total: 37 pre-configured endpoints across 10 groups**

---

## §4. Industry Research — API Playground UX Patterns

### 4.1 Competitive Landscape

| Tool | Key UX Innovation | What We Should Steal |
|------|-------------------|---------------------|
| **Postman** | AI-assisted autocomplete, test assertions, code generation in 20+ languages | "Copy as Code" multi-language toggle, test assertion suggestions |
| **Insomnia** | OpenAPI schema-driven autocomplete, plugin architecture, clean split-pane | Schema-aware body editing, clean two-panel layout |
| **Hoppscotch** | Lightning-fast SPA, keyboard-first, table/graph response views | Keyboard shortcuts (Ctrl+Enter to send), response table mode |
| **Bruno** | Git-friendly local files, offline-first, minimal UI clutter | Local-first storage (we use localStorage), minimal chrome |
| **Thunder Client** | VS Code inline, "Quick Mode" for fast requests | Speed — minimal clicks to send a request |

### 4.2 Best Practices We're Adopting

1. **Ctrl+Enter to send** — universal keyboard shortcut across all tools
2. **Method color-coding** — GET=green, POST=blue, PUT=orange, PATCH=yellow, DELETE=red
3. **URL template highlighting** — `{variables}` rendered in accent color inline
4. **Response timing badge** — always visible, color-coded (green <500ms, yellow <2s, red >2s)
5. **Collapsible JSON tree** with depth controls (Expand All / Collapse All / Expand to Level N)
6. **Copy as cURL** — one-click, always available
7. **Tab-based request builder** — Headers | Body | Params as horizontal tabs
8. **Response toggle** — Pretty / Raw / Headers as tabs
9. **Search in response** — Ctrl+F within JSON body
10. **Request diff** — compare current response vs saved/previous (V2)

### 4.3 What Makes EDOG's Playground UNIQUE

Unlike generic API tools, we have domain-specific advantages:

1. **Pre-populated endpoint catalog** — 37 endpoints, all FLT-specific, with correct auth auto-injected
2. **Token auto-management** — bearer and MWC tokens auto-refreshed, no manual copy-paste
3. **Template variables from config** — `{workspaceId}`, `{artifactId}` auto-filled from live config
4. **Phase-aware auth** — automatically switches between Bearer and MwcToken based on endpoint type
5. **Integrated with live system** — can call real FLT endpoints while the service is running
6. **Response → other tabs** — view a DAG response, then switch to DAG Studio to visualize it

### 4.4 UX Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Our Alternative |
|-------------|-------------|-----------------|
| Modal dialogs for everything | Breaks flow, requires dismissal | Inline editors, slide-out panels |
| Separate page for history | Context switch, lose current request | Right sidebar, always visible |
| Raw token input field | Tokens are 2000+ chars, error-prone | Auto-fill from config, show "●●●●" with reveal toggle |
| No response truncation | 10MB JSON crashes the renderer | Truncate at 500KB, "Download as file" link |
| Missing keyboard shortcuts | Mouse-heavy workflow is slow | Ctrl+Enter send, Ctrl+S save, Ctrl+H history |

---

## §5. Design Decisions

### D1: Request Builder Layout
**Decision:** Horizontal tab bar (Headers | Body | Params) below the URL row — same as Postman/Insomnia.
**Rationale:** Vertical stacking makes the request section too tall. Tabs keep it compact.

### D2: Response Viewer Layout
**Decision:** Tab bar (Body | Headers | Cookies) with Pretty/Raw toggle within Body tab.
**Rationale:** Most users care about the body. Headers are secondary. Cookies are rare for API debugging.

### D3: JSON Tree Renderer
**Decision:** Custom collapsible tree with syntax coloring. NOT a third-party library.
**Rationale:** Must match our design system tokens. Libraries like `json-viewer` have their own styles. The tree is simple enough to build (recursive DOM construction, ~200 lines).

### D4: Endpoint Catalog UI
**Decision:** Searchable dropdown with group headers, NOT a separate modal or sidebar.
**Rationale:** Quick access without losing context. Group headers provide organization.

### D5: History Storage
**Decision:** localStorage with 50-entry circular buffer. Each entry: `{ method, url, headers, body, response: { status, duration, body }, timestamp }`.
**Rationale:** No server-side storage needed. 50 entries at ~5KB avg = ~250KB — well within localStorage limits.

### D6: Proxy Strategy
**Decision:** V1 uses existing `/api/fabric/*` proxy. Direct calls for FLT endpoints (capacity host allows CORS from localhost). No new proxy endpoint needed.
**Rationale:** Minimizes backend changes. FLT capacity host already sends `Access-Control-Allow-Origin: *` for localhost in dev mode.

---

## §6. Component Inventory (for P1)

| Component | Priority | Complexity | Depends On |
|-----------|----------|-----------|-----------|
| Request Builder | P0 (core) | Medium | Config API |
| Response Viewer | P0 (core) | Medium | Request Builder |
| JSON Tree Renderer | P0 (core) | Medium | — |
| Endpoint Catalog | P0 (core) | Low | API reference |
| History & Saved | P1 (essential) | Medium | localStorage |
| Template Variable Resolver | P1 (essential) | Low | Config API |
| cURL Generator | P1 (essential) | Low | Request Builder |
| Batch Runner | P2 (moonshot) | High | History, Queue |
| Response Diff | P2 (moonshot) | High | History |

---

## §7. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| CORS blocks Fabric API calls | High | Low (proxy exists) | Use existing `/api/fabric/*` proxy |
| Large JSON response crashes renderer | High | Medium | Truncate at 500KB, virtual scroll for tree |
| Token expires mid-request | Medium | Medium | Show clear error + "Refresh Token" action |
| FLT capacity host rejects CORS from localhost | Medium | Low (tested OK) | Fall back to proxy if needed |
| localStorage quota exceeded | Low | Low | 50-entry limit, warn at 4MB usage |

---

**P0 COMPLETE.** Ready for P1: Component Deep Specs.
