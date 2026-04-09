# EDOG Studio — Phased Implementation Plan

> **Author:** Nadia Kovács, Senior Technical Program Manager
> **Status:** ACTIVE — Living document
> **Source of Truth:** `docs/specs/design-spec-v2.md`
> **Team:** 9-agent hivemind (see `hivemind/agents/ROSTER.md`)
> **Last Updated:** 2026-04-09

---

## Part 1: Executive Summary

### Vision

EDOG Studio is a localhost developer cockpit at `http://localhost:5555` for FabricLiveTable (FLT) engineers. It replaces a fragmented workflow — separate terminal windows for logs, browser tabs for Fabric portal, manual config editing, ad-hoc cURL commands — with a single unified interface used 8+ hours/day.

The cockpit operates in two phases:

1. **Disconnected (Browse & Explore):** Bearer token → Fabric APIs → browse workspaces, lakehouses, tables. Manage feature flags. Test APIs. No FLT service required.
2. **Connected (Full DevTools):** Deploy to a lakehouse → MWC token → real-time logs, DAG Studio, Spark Inspector, API Playground with FLT endpoints.

### Scope

23 features across 3 phases, built on an existing foundation of C# interceptors (EdogLogServer, EdogApiProxy, EdogLogInterceptor, EdogTelemetryInterceptor), a Python CLI (edog.py), and a full mock-up prototype (19 JS modules, 19 CSS modules, single-file HTML build).

### Phase Timeline (Relative)

| Phase | Features | Dependency Gate |
|-------|----------|-----------------|
| **MVP** | 7 features | Enables core new workflow: browse → deploy → work |
| **V1.1** | 6 features | Completes the cockpit with all 6 views fully functional |
| **V2** | 10 features | Advanced features requiring new interceptors or partially-confirmed APIs |

No calendar dates. Ordering is by dependency chain and value delivered.

### Key Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Fabric API scopes insufficient for EDOG's cert-based token | Workspace Explorer, Deploy flow blocked | Medium | Runtime-verify all ⚠️ APIs early in MVP. Fallback: request scope changes from Fabric team. |
| Single-file HTML grows too large for maintainability | Build times, developer experience | Low | build-html.py already handles 19+19 modules. Monitor output size. |
| IPC channel reliability (file-based polling) | Restart, token refresh commands delayed | Medium | Implement file-based first (proven). If latency unacceptable, upgrade to edog.py HTTP server on :5556. |
| SVG DAG rendering performance for large graphs | DAG Studio unusable for complex DAGs | Medium | Virtual viewport + level-based layout. Test with 50+ node DAGs early. |
| Mock flag (`?mock=true`) adds dead code to production build | Bundle size, maintenance | Low | Mock modules are gated at runtime. No production code path references mock data without the flag check. |

---

## Part 2: Architecture Overview

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Developer's Machine                             │
│                                                                        │
│  ┌─────────────┐         ┌──────────────────────────────────────────┐  │
│  │  edog.py     │         │  FLT Service Process (dotnet)           │  │
│  │  (Python CLI)│         │                                          │  │
│  │             ├──patch──>│  ┌─────────────────────────────────┐    │  │
│  │  • Auth     │  +build  │  │  EdogLogServer (Kestrel :5555)  │    │  │
│  │  • Token    │  +launch │  │  • GET  /api/flt/config         │    │  │
│  │  • Patch    │          │  │  • GET  /api/logs               │    │  │
│  │  • Build    │          │  │  • GET  /api/telemetry           │    │  │
│  │  • Launch   │          │  │  • WS   /ws (log streaming)     │    │  │
│  │  • Watch    │          │  │  • POST /api/command/* (IPC)     │    │  │
│  │             │          │  └──────────┬──────────────────────┘    │  │
│  │  Port 5556  │◄─IPC────>│             │                           │  │
│  │  (control)  │  (.edog- │  ┌──────────┴──────────────────────┐    │  │
│  └─────────────┘  command)│  │  Interceptors (DI-injected)     │    │  │
│        │                  │  │  • EdogLogInterceptor           │    │  │
│        │ Playwright       │  │  • EdogTelemetryInterceptor     │    │  │
│        │ auth             │  │  • EdogFeatureFlighterWrapper   │ V1.1│  │
│        ▼                  │  │  • EdogTracingSparkClient       │ V2 │  │
│  ┌──────────┐             │  └─────────────────────────────────┘    │  │
│  │ Browser  │             └──────────────────────────────────────────┘  │
│  │ (cert    │                                                          │
│  │  login)  │                                                          │
│  └──────────┘                                                          │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Browser: EDOG Studio UI (localhost:5555)                       │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │  Single HTML file (built by build-html.py)                │   │   │
│  │  │  19 CSS modules + 19 JS modules inlined                  │   │   │
│  │  │                                                           │   │   │
│  │  │  Views: Workspace | Logs | DAG | Spark | API | Env        │   │   │
│  │  │                                                           │   │   │
│  │  │  WebSocket ──→ EdogLogServer (log stream)                 │   │   │
│  │  │  fetch()   ──→ EdogLogServer (REST APIs)                  │   │   │
│  │  │  fetch()   ──→ api.fabric.microsoft.com (Fabric APIs)     │   │   │
│  │  │  fetch()   ──→ FLT service endpoints (MWC token)          │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: Token Serving

```
1. edog.py launches Playwright → cert-based login → AAD/Entra bearer token
2. Bearer token cached to .edog-token-cache (gitignored)
3. EdogApiProxy reads token → serves via GET /api/flt/config
4. Browser JS reads /api/flt/config on init → stores bearer token in memory
5. Browser uses bearer token for Fabric API calls (api.fabric.microsoft.com/v1/*)

On Deploy:
6. edog.py calls fetch_mwc_token(workspace_id) using bearer token
7. MWC token written to edog-config.json
8. edog.py patches FLT code with MWC token → builds → launches
9. EdogApiProxy now serves BOTH tokens via /api/flt/config
10. Browser uses MWC token for FLT service endpoints
```

### Data Flow: Log Streaming

```
FLT service → EdogLogInterceptor → captures Tracer.Write calls
  → EdogLogServer.AddLog(entry) → 10K ring buffer
  → WebSocket broadcast (150ms batched) → Browser
  → renderer.js → virtual scroll DOM → user sees live logs
```

### Data Flow: IPC (edog.py ↔ EdogLogServer)

```
Browser → POST /api/command/{action} → EdogLogServer
  → writes .edog-command/{action}.json to disk
  → edog.py polls .edog-command/ every 2-5s
  → executes command (restart, refresh-token, etc.)
  → writes .edog-command/{action}-result.json
  → EdogLogServer reads result → optional WebSocket notification
```

### New Components Per Phase

| Phase | Frontend (JS) | Frontend (CSS) | Backend (C#) | Python | Build |
|-------|---------------|----------------|--------------|--------|-------|
| **MVP** | `workspace-tree.js`, `deploy-flow.js`, `favorites.js`, `breakpoints.js`, `bookmarks.js` | Updates to existing modules | POST endpoints in EdogLogServer, bearer token in EdogApiProxy | Fabric API proxy in edog.py, favorites persistence | build-html.py module order updates |
| **V1.1** | `dag-graph.js`, `dag-gantt.js`, `api-playground.js`, `token-inspector.js`, `feature-flags.js`, `error-decoder.js`, `file-watcher-ui.js` | Updates to existing modules | `EdogFeatureFlighterWrapper.cs` | File watcher (watchdog), IPC command server, flag file parsing | Error code JSON generation script |
| **V2** | `spark-list.js`, `spark-detail.js`, `execution-compare.js`, `env-wizard.js`, `session-timeline.js` | Updates to existing modules | `EdogTracingSparkClient.cs`, `EdogTracingSparkClientFactory.cs` | Notebook API integration, environment cloning | — |

---

## Part 3: MVP Spec Cards (7 Features)

---

## Feature 1: Workspace Explorer

### Problem

FLT engineers currently browse workspaces through the Fabric portal web UI — a separate browser tab, separate login context, no integration with their dev environment. Finding a lakehouse to deploy to requires memorizing workspace IDs, manually copying them into config files.

### Objective

Build a three-panel master-detail-inspector view that lets engineers browse their Fabric tenants, workspaces, and lakehouses in a tree hierarchy, view item details, and take actions — all without leaving EDOG.

### Owner

**Primary:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
**Reviewers:** Kael Andersen (UX), Dev Patel (Fabric API correctness), Elena Voronova (token flow)

### Inputs

- **Bearer token** from `/api/flt/config` (served by EdogApiProxy, obtained by edog.py)
- **Fabric APIs** (all confirmed ✅):
  - `GET /v1/workspaces` → list workspaces
  - `GET /v1/workspaces/{id}/items` → all items in a workspace
  - `GET /v1/workspaces/{id}/lakehouses` → lakehouses specifically
  - `GET /v1/workspaces/{id}/lakehouses/{id}/tables` → tables in a lakehouse
  - `PATCH /v1/workspaces/{id}` → rename workspace
  - `DELETE /v1/workspaces/{id}` → delete workspace
  - `PATCH /v1/workspaces/{id}/lakehouses/{id}` → rename lakehouse
  - `DELETE /v1/workspaces/{id}/lakehouses/{id}` → delete lakehouse
- **HTML structure** in `index.html`: `#view-workspace` container with `ws-tree-panel`, `ws-content-panel`, `ws-inspector-panel` already exist

### Outputs

- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` — Complete rewrite from mock to real Fabric API integration
  - `src/frontend/js/api-client.js` — Add Fabric API methods (`listWorkspaces()`, `listItems()`, `listTables()`, etc.)
  - `src/frontend/css/workspace.css` — Refinements for tree interactions, context menus
  - `src/frontend/js/state.js` — Add workspace/lakehouse selection state, phase tracking
- **Files created:** None — existing files are updated
- **New REST calls from browser:** Direct `fetch()` to `api.fabric.microsoft.com` with bearer token header

### Technical Design

**Frontend JS — `workspace-explorer.js`:**

Refactor the existing `WorkspaceExplorer` class with real API integration:

```
class WorkspaceExplorer {
  constructor(containerEl, apiClient, stateManager)

  // Tree operations
  async loadWorkspaces()           // GET /v1/workspaces → populate tree
  async expandWorkspace(wsId)      // GET /v1/workspaces/{id}/items → show children
  async expandLakehouse(wsId, lhId) // GET /v1/workspaces/{id}/lakehouses/{id}/tables
  selectNode(nodeEl)               // Highlight + populate center panel

  // Center panel rendering
  renderWorkspaceContent(workspace)  // Item table, sorted by type (lakehouses first)
  renderLakehouseContent(lakehouse)  // Tables section + MLV placeholder + Deploy button
  renderItemContent(item)            // Generic item metadata + "Open in Fabric"

  // Inspector panel
  renderTableInspector(table)        // TABLE INFO: Name, Type, Format, Location
  renderWorkspaceInspector(workspace) // Capacity info, item counts

  // Context menu
  showContextMenu(e, nodeType, nodeData) // Right-click actions
  handleRename(nodeType, id)
  handleDelete(nodeType, id)             // With confirmation dialog
  handleCopyId(id)
  handleOpenInFabric(url)

  // Private
  _buildTreeNode(item, depth)       // Returns DOM element for tree item
  _bindEvents()
}
```

**Frontend JS — `api-client.js`:**

Add a `FabricApiClient` section to the existing `ApiClient` class:

```
// New methods on ApiClient:
async fabricGet(path)                    // GET api.fabric.microsoft.com/v1/{path}
async fabricPost(path, body)             // POST with JSON body
async fabricPatch(path, body)            // PATCH with JSON body
async fabricDelete(path)                 // DELETE with confirmation
async listWorkspaces()                   // → [{id, displayName, capacityId, ...}]
async listItems(workspaceId)             // → [{id, displayName, type, ...}]
async listLakehouses(workspaceId)        // → [{id, displayName, ...}]
async listTables(workspaceId, lhId)      // → [{name, type, format, location}]
async renameWorkspace(wsId, newName)
async deleteWorkspace(wsId)
async renameLakehouse(wsId, lhId, name)
async deleteLakehouse(wsId, lhId)
```

**Frontend CSS — `workspace.css`:**

Existing module updated for:
- Context menu styles (position: fixed, `--shadow-lg`, `--z-dropdown`)
- Tree node hover/active/selected states per design system
- Lakehouse highlighting (brighter text, green dot indicator)
- Non-lakehouse dimming (`--text-muted` color)
- 28px row height, ▸/▾ toggle arrows

**Backend — `EdogApiProxy.cs`:**

Extend `/api/flt/config` response to include:
- `bearerToken` field (the AAD/Entra token for Fabric API calls)
- `phase` field (`"disconnected"` or `"connected"`)
- Existing `mwcToken`, `workspaceId`, `artifactId`, `capacityId` fields

### Acceptance Criteria

- [ ] Tree loads workspaces from Fabric API on page load (not mock data)
- [ ] Expanding a workspace shows child items (lakehouses, notebooks, pipelines, etc.)
- [ ] Lakehouses are visually distinguished (brighter text + green dot) from other item types
- [ ] Non-lakehouse items are dimmed with `--text-muted` color
- [ ] Clicking a workspace populates center panel with item table sorted by type
- [ ] Clicking a lakehouse populates center panel with tables section
- [ ] Clicking a table populates inspector panel with table metadata (name, type, format, location)
- [ ] Right-click context menu works on tree nodes with Rename, Delete, Copy ID, Open in Fabric
- [ ] Rename calls PATCH API and updates tree node text inline
- [ ] Delete shows confirmation dialog, calls DELETE API, removes node from tree
- [ ] "Open in Fabric" opens correct Fabric portal URL in a new browser tab
- [ ] Tree retains expanded/collapsed state during the session
- [ ] Error states shown when API calls fail (toast notification with error message)
- [ ] When `?mock=true`, existing mock data renders instead of calling Fabric APIs

### Dependencies

- EdogApiProxy must serve bearer token via `/api/flt/config` (minor C# change)
- edog.py must successfully authenticate and cache bearer token (already works)

### Risks

| Risk | Mitigation |
|------|------------|
| Fabric API rate limiting (10 req/sec) | Lazy-load tree: only fetch children on expand. Cache workspace list for session. |
| Token scope insufficient for some operations (delete workspace) | Verify scopes at runtime. Disable unavailable actions gracefully with tooltip explanation. |
| Large workspace count (>50) makes tree unwieldy | Virtual scroll for tree panel if >100 nodes. Initially render collapsed. |

### Moonshot Vision

V2+: Inline SQL editor for tables. Data preview (first 5 rows via SQL endpoint). Schema browser with column-level lineage. Cross-workspace search. Drag-and-drop lakehouse organization.

---

## Feature 2: Deploy to Lakehouse

### Problem

Deploying to a lakehouse today is a 6-step manual process: edit edog-config.json → copy workspace/artifact/capacity IDs → run edog.py → wait for auth → wait for build → verify service starts. Engineers do this 3-5 times per day, every time they switch lakehouses.

### Objective

One-click deployment from the Workspace Explorer: select a lakehouse, click "Deploy to this Lakehouse", and EDOG handles config update → token fetch → code patching → build → service launch with live progress UI.

### Owner

**Primary:** Elena Voronova (Python deploy flow) + Zara Okonkwo (JS progress UI)
**Reviewers:** Sana Reeves (architecture), Arjun Mehta (C# server lifecycle), Dev Patel (FLT build correctness)

### Inputs

- Selected lakehouse object from Workspace Explorer (workspaceId, artifactId, capacityId)
- Bearer token (already available from Phase 1 auth)
- edog.py deploy pipeline: `fetch_mwc_token()` → `patch_code()` → `build_service()` → `launch_service()`
- IPC channel: browser → EdogLogServer → `.edog-command/` → edog.py

### Outputs

- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` — Add Deploy button handler, progress rendering
  - `src/frontend/css/workspace.css` — Deploy progress bar styles
  - `src/backend/DevMode/EdogLogServer.cs` — Add `POST /api/command/deploy` endpoint
  - `edog.py` — Add `.edog-command/` polling loop, deploy-from-command handler
  - `src/frontend/js/state.js` — Phase transition: disconnected → deploying → connected
  - `src/frontend/js/sidebar.js` — Enable/disable views based on phase
  - `src/frontend/js/topbar.js` — Update service status during deploy
- **New IPC command:** `deploy` with payload `{workspaceId, artifactId, capacityId}`
- **New WebSocket messages:** `{ type: 'deploy_progress', step: 1, total: 5, message: '...' }`

### Technical Design

**Deploy flow (5 steps):**

```
Step 1: Update config
  Browser → POST /api/command/deploy {workspaceId, artifactId, capacityId}
  → EdogLogServer writes .edog-command/deploy.json
  → edog.py reads command → updates edog-config.json

Step 2: Fetch MWC token
  → edog.py calls fetch_mwc_token(workspace_id) using bearer token
  → Writes MWC token to edog-config.json
  → Sends progress via .edog-command/deploy-progress.json

Step 3: Patch FLT code
  → edog.py applies EDOG DevMode patches
  → Updates deploy-progress.json

Step 4: Build
  → edog.py runs dotnet build
  → Updates deploy-progress.json

Step 5: Launch service
  → edog.py starts the FLT process
  → Waits for service ready (health check)
  → Updates deploy-progress.json with final status
```

**Frontend — Deploy progress UI (in workspace-explorer.js):**

```
class DeployFlow {
  constructor(contentPanel, wsClient, stateManager)

  async startDeploy(lakehouse)       // Initiates deploy via IPC
  renderProgress(step, total, msg)   // Inline progress bar in center panel
  onDeployComplete()                 // Transition phase → connected
  onDeployFailed(error)              // Show error with retry option
  pollProgress()                     // Poll /api/command/deploy-status every 500ms

  _renderProgressBar(step, total)    // 5-segment horizontal bar
  _renderStepMessage(msg)            // "Step 2/5: Fetching MWC token..."
}
```

**Backend — `EdogLogServer.cs`:**

Add IPC command endpoints:

```csharp
// New POST endpoints
POST /api/command/deploy         // Write deploy.json to .edog-command/
GET  /api/command/deploy-status  // Read deploy-progress.json
POST /api/command/restart        // Write restart.json
POST /api/command/refresh-token  // Write refresh-token.json
```

**Python — `edog.py`:**

Add command polling loop:

```python
async def poll_commands(command_dir: Path) -> None:
    """Poll .edog-command/ for new commands every 2 seconds."""
    while True:
        for cmd_file in command_dir.glob("*.json"):
            if cmd_file.stem.endswith("-progress") or cmd_file.stem.endswith("-result"):
                continue
            command = json.loads(cmd_file.read_text())
            await execute_command(cmd_file.stem, command, command_dir)
            cmd_file.unlink()
        await asyncio.sleep(2)

async def execute_deploy(payload: dict, command_dir: Path) -> None:
    """Execute deploy flow: config → token → patch → build → launch."""
    progress_file = command_dir / "deploy-progress.json"
    # Step 1-5 with progress updates written to progress_file
```

### Acceptance Criteria

- [ ] "Deploy to this Lakehouse" button appears only for lakehouse items in center panel
- [ ] Clicking Deploy shows inline 5-step progress bar (not a modal)
- [ ] Each step shows progress text: "Step N/5: {description}..."
- [ ] Successful deploy transitions UI phase from disconnected → connected
- [ ] After deploy: sidebar tabs 2-4 (Logs, DAG, Spark) become enabled
- [ ] After deploy: top bar service status changes from gray/stopped → green/running
- [ ] After deploy: token countdown appears in top bar
- [ ] Failed deploy shows error message with "Retry" button
- [ ] Config file (edog-config.json) is correctly updated with workspace/artifact/capacity IDs
- [ ] Re-deploying to a different lakehouse stops the current service first
- [ ] Deploy progress survives a browser refresh (polling-based, not WebSocket-only)

### Dependencies

- **Feature 1 (Workspace Explorer):** Lakehouse selection must work before deploy
- **Feature 5 (Top Bar):** Service status and token health must render correctly
- **Feature 6 (Sidebar):** Phase-aware enable/disable must work

### Risks

| Risk | Mitigation |
|------|------------|
| edog.py command polling adds latency (2-5s per step) | Start with 2s polling. If too slow, implement edog.py HTTP control server on :5556. |
| Build step takes 60+ seconds | Show animated progress. Consider caching builds (skip rebuild if only config changed). |
| MWC token fetch fails (cert issue, scope) | Clear error message with retry. Suggest manual auth steps. |

### Moonshot Vision

V2+: Instant hot-deploy (no rebuild for config-only changes). Parallel deployment to multiple lakehouses. Deploy history with one-click rollback. Deploy presets saved as favorites.

---

## Feature 3: Favorites / Named Environments

### Problem

Engineers work with 3-5 lakehouses regularly (dev, staging, team-shared, experiment-specific). Each lakehouse requires remembering workspace IDs, artifact IDs, and capacity IDs. Switching between them means navigating the full tree every time.

### Objective

Persistent named-environment bookmarks with one-click deploy. Favorites survive session restarts, stored as JSON on disk.

### Owner

**Primary:** Zara Okonkwo (JS) + Elena Voronova (Python persistence)
**Reviewers:** Kael Andersen (UX placement), Sana Reeves (config schema)

### Inputs

- Lakehouse selection from Workspace Explorer (workspaceId, artifactId, capacityId, displayName)
- Persistence file: `~/.edog/favorites.json` (or `edog-favorites.json` alongside edog-config.json)
- EdogApiProxy serves favorites via `/api/flt/config` or new `/api/favorites` endpoint

### Outputs

- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` — "Save as Favorite" in context menu, favorites section in tree
  - `src/frontend/js/api-client.js` — Add `getFavorites()`, `saveFavorite()`, `deleteFavorite()` methods
  - `src/backend/DevMode/EdogLogServer.cs` — Add `GET /api/favorites`, `POST /api/favorites`, `DELETE /api/favorites/{name}` endpoints
  - `src/frontend/css/workspace.css` — Favorites section styles (star icon, one-click deploy pill)
- **Files created:**
  - `edog-favorites.json` — Persisted favorites (gitignored)

### Technical Design

**Favorites data model:**

```json
{
  "favorites": [
    {
      "name": "My Dev Lakehouse",
      "workspaceId": "guid",
      "workspaceName": "EDOG-Dev-Workspace",
      "artifactId": "guid",
      "artifactName": "TestLakehouse-01",
      "capacityId": "guid",
      "tenantId": "guid",
      "createdAt": "2026-04-09T14:00:00Z"
    }
  ]
}
```

**Frontend — Tree panel favorites section:**

```
// In workspace-explorer.js
renderFavorites(favorites)           // Render FAVORITES section at top of tree
handleSaveAsFavorite(lakehouse)      // Prompt for name → POST /api/favorites
handleRemoveFavorite(name)           // DELETE /api/favorites/{name}
handleDeployFavorite(favorite)       // One-click deploy (same as Feature 2)
```

**Backend — `EdogLogServer.cs`:**

```csharp
GET  /api/favorites                  // Read edog-favorites.json
POST /api/favorites                  // Append to favorites array
DELETE /api/favorites/{name}         // Remove by name
```

File location: same directory as `edog-config.json`. EdogLogServer reads config path on startup.

### Acceptance Criteria

- [ ] Right-click context menu on lakehouses shows "Save as Favorite"
- [ ] Saving prompts for a display name (pre-filled with lakehouse name)
- [ ] FAVORITES section appears at top of the workspace tree with star (★) icon
- [ ] Each favorite shows: name, workspace name (dimmed), one-click Deploy button
- [ ] Clicking Deploy on a favorite triggers the full deploy flow (Feature 2)
- [ ] Favorites persist across browser refreshes and service restarts
- [ ] Favorites stored in `edog-favorites.json` on disk (not localStorage)
- [ ] Duplicate names are rejected with inline validation message
- [ ] Delete favorite with right-click → "Remove from Favorites" (no confirmation needed)
- [ ] Maximum 20 favorites (UI shows message if limit reached)

### Dependencies

- **Feature 1 (Workspace Explorer):** Tree panel must exist
- **Feature 2 (Deploy to Lakehouse):** Deploy flow must work for one-click deploy from favorites

### Risks

| Risk | Mitigation |
|------|------------|
| Favorites file gets corrupted | Validate JSON on read. If corrupt, rename to `.bak` and start fresh. |
| Stale favorites (lakehouse deleted) | Graceful error on deploy attempt. Offer to remove the favorite. |

### Moonshot Vision

V2+: Shared team favorites via git-tracked file. Favorite groups (dev / staging / prod). Auto-detect most-used lakehouses and suggest saving as favorite.

---

## Feature 4: Enhanced Logs (Breakpoints + Bookmarks)

### Problem

FLT produces thousands of log entries per DAG execution. Engineers can filter by level/component, but they cannot visually mark patterns they're hunting for (e.g., "highlight all SparkSession logs") or save specific entries for later comparison.

### Objective

Add regex-based log breakpoints (visual highlighting, no auto-pause) and log bookmarks (pin entries, export, navigate) to the existing Logs view.

### Owner

**Primary:** Zara Okonkwo (JS breakpoints + bookmarks)
**Reviewers:** Kael Andersen (UX for breakpoint/bookmark UI), Mika Tanaka (CSS for highlight strip + drawer)

### Inputs

- Existing `renderer.js` — renders log entries in virtual scroll
- Existing `filters.js` — level/component/text filtering
- Existing `#breakpoints-bar` and `#bookmarks-drawer` containers in `index.html`

### Outputs

- **Files modified:**
  - `src/frontend/js/renderer.js` — Add breakpoint matching per entry, bookmark gutter star
  - `src/frontend/css/logs.css` — Breakpoint highlight strip, bookmark star styles
  - `src/frontend/css/detail.css` — Bookmarks drawer refinements
  - `src/frontend/js/main.js` — Wire breakpoint and bookmark keyboard shortcuts

### Technical Design

**Breakpoints — `renderer.js` additions:**

```
class BreakpointManager {
  constructor()

  breakpoints: Map<id, {regex: RegExp, color: string, label: string}>

  addBreakpoint(regexStr, color)      // Compile regex, assign color, add to map
  removeBreakpoint(id)
  matchEntry(logText)                 // Returns matching breakpoint or null
  renderBreakpointBar(barEl)          // Pill per breakpoint with × remove button
  renderAddForm()                     // Inline: regex input + color picker + Add btn
}

// In renderer.renderLogEntry():
const bp = breakpointManager.matchEntry(entry.message);
if (bp) {
  rowEl.style.borderLeft = `3px solid ${bp.color}`;
  rowEl.classList.add('breakpoint-hit');
}
```

**Bookmarks — `renderer.js` additions:**

```
class BookmarkManager {
  constructor(drawerEl)

  bookmarks: Map<entryId, LogEntry>

  toggleBookmark(entry)               // Pin/unpin
  isBookmarked(entryId)               // Check state
  renderDrawerList()                   // Populate #bm-list
  scrollToEntry(entryId)              // Scroll main log view to bookmarked entry
  exportBookmarks(format)             // 'json' or 'html'

  renderGutterStar(entryId)           // ★ (filled) or ☆ (empty) in gutter column
}
```

**CSS — Breakpoint highlight:**

```css
.log-entry.breakpoint-hit {
  border-left: 3px solid var(--breakpoint-color);  /* dynamic per breakpoint */
  background: rgba(var(--breakpoint-color-rgb), 0.04);
}

.breakpoints-bar .bp-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
```

### Acceptance Criteria

- [ ] "+" button in breakpoints bar opens inline form (regex input + color picker)
- [ ] Adding a breakpoint applies visual highlight to all matching existing log entries
- [ ] New log entries arriving via WebSocket are checked against active breakpoints
- [ ] Breakpoint pills shown in bar with × button to remove
- [ ] Maximum 10 active breakpoints (UI shows limit message)
- [ ] Breakpoints persist for the session (not across restarts)
- [ ] Each log row has a star gutter icon (☆ empty, ★ filled on click)
- [ ] Bookmarked entries appear in the right-side bookmarks drawer
- [ ] Clicking a bookmarked entry in the drawer scrolls the main log to that entry
- [ ] "Export Bookmarks" generates JSON file with all bookmarked entries
- [ ] Bookmarks survive log clearing but not session restart
- [ ] Invalid regex shows inline validation error (no crash)
- [ ] Performance: breakpoint matching adds < 1ms overhead per log entry

### Dependencies

- None — Logs view and renderer already exist and work

### Risks

| Risk | Mitigation |
|------|------------|
| Complex regex causes performance regression | Pre-compile regex. If match takes >5ms, warn user. Limit regex complexity. |
| Too many bookmarks causes drawer slowness | Cap at 200 bookmarks. Oldest auto-removed with warning. |

### Moonshot Vision

V2+: Conditional breakpoints (match + level filter). Break-on-first-match mode (auto-pause stream). Share breakpoint sets as importable JSON. Bookmark annotations (user comments on entries).

---

## Feature 5: Top Bar

### Problem

Engineers need persistent status information visible at all times: Is the service running? When does the token expire? What git branch am I on? How many patches are applied? Currently this information requires switching to terminal windows.

### Objective

A 44px persistent top bar showing service status, token health countdown, git branch, patch count, restart button, and theme toggle.

### Owner

**Primary:** Zara Okonkwo (JS topbar logic) + Mika Tanaka (CSS topbar styles)
**Reviewers:** Kael Andersen (UX layout), Elena Voronova (status data sources)

### Inputs

- `/api/flt/config` — provides service status, token expiry, workspace/artifact info
- Git status — `git branch --show-current` and `git status --porcelain` (via edog.py or EdogLogServer)
- Patch count — from edog.py's patch tracking
- HTML structure: `#topbar` already exists in `index.html`

### Outputs

- **Files modified:**
  - `src/frontend/js/topbar.js` — Rewrite from mock rendering to live data polling
  - `src/frontend/css/topbar.css` — Refinements for status colors, countdown animation
  - `src/frontend/js/api-client.js` — Add `getConfig()` polling (every 10s)
  - `src/backend/DevMode/EdogApiProxy.cs` — Extend config response with phase, git info, patch count

### Technical Design

**Frontend — `topbar.js`:**

```
class TopBar {
  constructor(topbarEl, apiClient, stateManager)

  async init()                        // Initial config fetch + start polling
  startPolling(intervalMs)            // Poll /api/flt/config every 10s
  updateServiceStatus(status)         // green=Running, gray=Stopped, amber=Building
  updateTokenHealth(expiresAt)        // Countdown timer, color by time remaining
  updateGitInfo(branch, dirtyCount)   // Branch name + badge
  updatePatchCount(count)             // "6 patches" pill
  handleRestartClick()                // POST /api/command/restart via IPC
  handleThemeToggle()                 // Toggle data-theme on body, persist to localStorage

  _startTokenCountdown(expiresAt)     // setInterval every 1s, format as "Xm Ys"
  _getTokenHealthColor(remaining)     // green >10min, amber 5-10min, red <5min
}
```

**Token countdown logic:**

```javascript
_startTokenCountdown(expiresAt) {
  if (this._countdownInterval) clearInterval(this._countdownInterval);
  this._countdownInterval = setInterval(() => {
    const remaining = Math.max(0, expiresAt - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    this.tokenCountdownEl.textContent = `${minutes}m ${seconds}s`;
    this.tokenHealthEl.className = `token-health ${this._getTokenHealthColor(remaining)}`;
    if (remaining <= 0) {
      this.tokenCountdownEl.textContent = 'Expired';
      // Trigger Token Inspector drawer auto-open (V1.1)
    }
  }, 1000);
}
```

**Backend — `EdogApiProxy.cs` config response:**

```json
{
  "phase": "connected",
  "serviceStatus": "running",
  "serviceUptime": 3600,
  "bearerToken": "eyJ...",
  "bearerTokenExpiry": 1712678400,
  "mwcToken": "eyJ...",
  "mwcTokenExpiry": 1712678400,
  "workspaceId": "guid",
  "artifactId": "guid",
  "capacityId": "guid",
  "gitBranch": "feature/dag-studio",
  "gitDirtyCount": 3,
  "patchCount": 6
}
```

### Acceptance Criteria

- [ ] Top bar renders on page load with correct initial state
- [ ] Service status shows colored dot: green (Running), gray (Stopped), amber (Building)
- [ ] Service status text shows uptime when running (e.g., "Running 1h 23m")
- [ ] Token countdown updates every second in format "Xm Ys"
- [ ] Token health color: green (>10min), amber (5-10min), red (<5min)
- [ ] "No token" shown when disconnected (no token available)
- [ ] Git branch name displayed (e.g., "feature/dag-studio")
- [ ] Dirty file count badge shown next to branch name (e.g., "3" in small badge)
- [ ] Patch count pill shows "N patches" (e.g., "6 patches")
- [ ] Restart button sends IPC command and shows loading state
- [ ] Theme toggle switches between light and dark themes
- [ ] Theme preference persists across refreshes via localStorage
- [ ] Top bar is exactly 44px height per design system

### Dependencies

- **Feature 2 (Deploy):** Phase transition triggers top bar updates
- EdogApiProxy must serve extended config response

### Risks

| Risk | Mitigation |
|------|------------|
| Polling /api/flt/config every 10s adds request overhead | 10s is acceptable. Response is small JSON. Reduce to 30s if needed. |
| Git info requires subprocess call from EdogLogServer | Cache git info on startup + on file change. Don't call git on every config request. |

### Moonshot Vision

V2+: CPU/memory sparkline in top bar. Notification bell with action queue. Multi-service status (when running multiple FLT instances). Token auto-refresh with countdown reset.

---

## Feature 6: Sidebar Navigation

### Problem

The current mock sidebar has 6 view tabs but no phase awareness — connected-only views (Logs, DAG, Spark) are clickable even when no service is running, leading to empty/broken states.

### Objective

Phase-aware sidebar that enables/disables views based on connection state, with keyboard shortcuts (1-6) and active view indicator.

### Owner

**Primary:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
**Reviewers:** Kael Andersen (UX interaction)

### Inputs

- State manager with phase tracking (from Feature 2's deploy flow)
- HTML structure: `#sidebar` with `data-phase` attributes on each button already exists
- Design system: sidebar icon specs (36×36 hit area, `--radius-md`, active/disabled states)

### Outputs

- **Files modified:**
  - `src/frontend/js/sidebar.js` — Add phase-aware enable/disable, keyboard binding
  - `src/frontend/css/sidebar.css` — Disabled state styles, active indicator refinements

### Technical Design

**Frontend — `sidebar.js`:**

```
class Sidebar {
  constructor(sidebarEl, stateManager)

  init()                              // Bind keyboard shortcuts, read initial phase
  switchView(viewId)                  // Hide current view, show target, update active state
  updatePhase(phase)                  // 'disconnected' | 'deploying' | 'connected'
  _enableView(viewId)                 // Remove disabled class, add click handler
  _disableView(viewId)               // Add disabled class, remove click handler

  _bindKeyboardShortcuts()
  // Key 1 → workspace, 2 → logs, 3 → dag, 4 → spark, 5 → api, 6 → environment
  // Only fire if no input/textarea is focused
}
```

**Phase logic:**

```
disconnected:
  View 1 (Workspace): enabled, default active
  View 2 (Logs): disabled → shows "Connect to enable" empty state
  View 3 (DAG): disabled → shows "Connect to enable" empty state
  View 4 (Spark): disabled → shows "Connect to enable" empty state
  View 5 (API): enabled (uses bearer token)
  View 6 (Environment): enabled

connected:
  All views enabled
  Logs view starts receiving WebSocket data
```

**CSS — Disabled state:**

```css
.sidebar-icon[disabled] {
  opacity: 0.3;
  pointer-events: none;
  cursor: not-allowed;
}
```

### Acceptance Criteria

- [ ] Sidebar shows 6 icon buttons in correct order per spec
- [ ] Keyboard shortcuts 1-6 switch views (when no input is focused)
- [ ] Active view has accent-colored left border indicator
- [ ] In disconnected phase: views 2, 3, 4 are visually disabled (opacity 0.3)
- [ ] Disabled views show "Connect to a Lakehouse to enable this view" empty state
- [ ] Empty state includes a link/button to navigate to Workspace Explorer
- [ ] After deploy completes, disabled views transition to enabled
- [ ] View switch is instant (0ms, no animation per design system)
- [ ] Bottom of sidebar shows token status dot (green/amber/red/gray)
- [ ] Sidebar width is exactly 52px per design system

### Dependencies

- **Feature 2 (Deploy):** Phase transitions drive enable/disable logic
- **Feature 5 (Top Bar):** Token status dot mirrors top bar token health

### Risks

| Risk | Mitigation |
|------|------------|
| Keyboard shortcuts conflict with browser shortcuts | Only use number keys 1-6 (not Ctrl+N). Check for focus state before handling. |

### Moonshot Vision

V2+: Sidebar badges showing notification counts per view. Collapsible sidebar with labels. Custom view ordering via drag-and-drop.

---

## Feature 7: Command Palette (Ctrl+K)

### Problem

Power users (senior engineers) want keyboard-first navigation. Finding a specific lakehouse, running a DAG command, or jumping to a feature flag currently requires mouse-clicking through the UI.

### Objective

A floating command palette (Ctrl+K) with fuzzy search across workspaces, lakehouses, tables, commands, and feature flags. Arrow-key navigable, Enter to select.

### Owner

**Primary:** Zara Okonkwo (JS command matching + rendering)
**Reviewers:** Kael Andersen (UX interaction), Mika Tanaka (CSS overlay)

### Inputs

- In-memory state: workspace tree data, loaded log entries, command registry
- HTML structure: `#command-palette` container exists in `index.html`
- Existing `command-palette.js` and `command-palette.css` modules

### Outputs

- **Files modified:**
  - `src/frontend/js/command-palette.js` — Full implementation with fuzzy matching
  - `src/frontend/css/command-palette.css` — Refinements for result grouping, active highlight

### Technical Design

**Frontend — `command-palette.js`:**

```
class CommandPalette {
  constructor(overlayEl, stateManager, workspaceExplorer)

  open()                              // Show overlay, focus input, populate initial results
  close()                             // Hide overlay, clear input
  toggle()                            // Open if closed, close if open

  registerCommand(id, label, category, action, condition)
  // condition: () => boolean — whether command is available in current phase

  search(query)                       // Fuzzy match across all sources
  renderResults(matches)              // Grouped by category: Workspaces, Commands, Flags...
  selectResult(index)                 // Execute action for selected result
  navigateResults(direction)          // Arrow up/down

  _fuzzyMatch(query, text)            // Simple substring + initial-letter matching
  _getWorkspaceResults(query)         // Match against loaded workspace/lakehouse names
  _getCommandResults(query)           // Match against registered commands
  _getLogResults(query)               // Match against log messages (connected mode)

  // Keyboard handling
  _onKeydown(e)                       // Arrow keys, Enter, Escape
}
```

**Built-in commands registry:**

```javascript
const COMMANDS = [
  { id: 'run-dag',       label: 'Run DAG',             category: 'Commands', phase: 'connected' },
  { id: 'cancel-dag',    label: 'Cancel DAG',           category: 'Commands', phase: 'connected' },
  { id: 'restart',       label: 'Restart Service',      category: 'Commands', phase: 'connected' },
  { id: 'force-unlock',  label: 'Force Unlock DAG',     category: 'Commands', phase: 'connected' },
  { id: 'refresh-dag',   label: 'Refresh DAG',          category: 'Commands', phase: 'connected' },
  { id: 'refresh-token', label: 'Refresh Token',        category: 'Commands', phase: 'both' },
  { id: 'export-logs',   label: 'Export Logs to JSON',  category: 'Commands', phase: 'connected' },
  { id: 'clear-logs',    label: 'Clear Logs',           category: 'Commands', phase: 'connected' },
  { id: 'toggle-theme',  label: 'Toggle Theme',         category: 'Commands', phase: 'both' },
  { id: 'go-workspace',  label: 'Go to Workspace Explorer', category: 'Navigation', phase: 'both' },
  { id: 'go-logs',       label: 'Go to Logs',           category: 'Navigation', phase: 'connected' },
  { id: 'go-dag',        label: 'Go to DAG Studio',     category: 'Navigation', phase: 'connected' },
  { id: 'go-spark',      label: 'Go to Spark Inspector', category: 'Navigation', phase: 'connected' },
  { id: 'go-api',        label: 'Go to API Playground',  category: 'Navigation', phase: 'both' },
  { id: 'go-env',        label: 'Go to Environment',     category: 'Navigation', phase: 'both' },
];
```

### Acceptance Criteria

- [ ] Ctrl+K opens command palette overlay (centered, ~520px wide)
- [ ] Ctrl+K toggles (opens if closed, closes if open)
- [ ] Escape closes the palette
- [ ] Clicking backdrop closes the palette
- [ ] Input field auto-focused on open
- [ ] Results grouped by category: Workspaces, Lakehouses, Commands, Navigation
- [ ] Arrow up/down navigates results with visual highlight
- [ ] Enter executes selected result action
- [ ] Fuzzy matching works (typing "dag" matches "Go to DAG Studio" and "Run DAG")
- [ ] Connected-only commands hidden when disconnected
- [ ] Workspace/lakehouse results navigate to that item in the tree
- [ ] Command results execute the command (e.g., "Toggle Theme" toggles theme)
- [ ] Results render within 50ms of keystroke (client-side matching only)
- [ ] Maximum 20 visible results (scrollable if more)
- [ ] Command palette respects z-index hierarchy (above all other UI elements)

### Dependencies

- **Feature 1 (Workspace Explorer):** Workspace data needed for search results
- **Feature 6 (Sidebar):** Navigation commands trigger view switches

### Risks

| Risk | Mitigation |
|------|------------|
| Ctrl+K conflicts with browser's address bar shortcut in some browsers | Test in Edge and Chrome. If conflict, fall back to Ctrl+Shift+K or Ctrl+P (with note). |
| Large dataset (many workspaces) makes fuzzy search slow | Search is in-memory string matching. Even 1000 items is < 1ms. No concern. |

### Moonshot Vision

V2+: Recent commands history. Custom user shortcuts. Plugin commands (extensions can register commands). Inline preview of results (show lakehouse details on hover). Multi-step commands (wizards triggered from palette).

---

## Part 4: V1.1 Spec Cards (6 Features)

---

## Feature 8: DAG Studio

### Problem

DAG execution is the core FLT operation, but engineers currently have no visual representation of the DAG structure, no interactive way to trigger/cancel runs, and must read raw telemetry logs to understand node-level execution state.

### Objective

An interactive SVG-based DAG graph with execution controls, Gantt timeline, and run history comparison.

### Owner

**Primary:** Zara Okonkwo (JS graph rendering + controls)
**Reviewers:** Dev Patel (DAG data model), Kael Andersen (UX layout), Sana Reeves (architecture)

### Inputs

- `GET /liveTable/getLatestDag?showExtendedLineage=true` → nodes, edges, types
- `POST /liveTableSchedule/runDAG/{iterationId}` → trigger execution
- `POST /liveTableSchedule/cancelDAG/{iterationId}` → cancel execution
- Telemetry stream via WebSocket (`ActivityName === 'RunDAG'`) → execution state
- Existing `#view-dag` container with `control-panel` already wired

### Outputs

- **Files created:**
  - `src/frontend/js/dag-graph.js` — SVG DAG renderer with topological layout
  - `src/frontend/js/dag-gantt.js` — Gantt chart for per-node execution timing
- **Files modified:**
  - `src/frontend/js/control-panel.js` — Integrate with DAG graph, add run/cancel buttons
  - `src/frontend/css/dag.css` — Graph node styles, edge rendering, execution animation
  - `src/frontend/js/api-client.js` — Add `getLatestDag()`, `runDag()`, `cancelDag()` methods

### Technical Design

**JS — `dag-graph.js`:**

```
class DagGraph {
  constructor(containerEl, apiClient)

  async loadDag()                     // GET /liveTable/getLatestDag → parse nodes + edges
  renderGraph(nodes, edges)           // SVG render with topological layout
  updateNodeState(nodeId, state)      // Update node border color during execution
  selectNode(nodeId)                  // Highlight + show node detail panel
  fitToScreen()                       // Zoom to fit all nodes
  zoomIn() / zoomOut() / resetZoom()

  _topologicalSort(nodes, edges)      // Assign levels for layout
  _layoutNodes(sortedNodes)           // X/Y positions based on level + parallel count
  _renderNode(node, x, y)            // SVG rect + text + status badge
  _renderEdge(fromNode, toNode)      // SVG path with direction arrow
  _animateRunningNode(nodeEl)        // Pulsing border animation on running nodes
}
```

**JS — `dag-gantt.js`:**

```
class DagGantt {
  constructor(containerEl)

  renderGantt(executionData)          // Horizontal bars on time axis
  highlightNode(nodeId)               // Cross-highlight between graph and Gantt
  renderComparison(run1, run2)        // Side-by-side diff of two executions

  _calculateTimeScale(startTime, endTime)
  _renderBar(node, startTime, duration, status)
}
```

### Acceptance Criteria

- [ ] DAG graph renders as SVG from `getLatestDag` API response
- [ ] Nodes show name, type badge (SQL/PySpark), status-colored border
- [ ] Edges show dependency direction with arrows
- [ ] During execution: running nodes have animated/pulsing border
- [ ] Clicking a node shows detail panel (metrics, timing, error info)
- [ ] "Run DAG" button generates UUID and triggers execution
- [ ] "Cancel DAG" button cancels the active execution
- [ ] Gantt chart shows per-node execution timing as horizontal bars
- [ ] History table shows last 10 executions with click-to-load
- [ ] Zoom/pan controls work on the SVG graph
- [ ] Fit-to-screen button centers and scales the graph
- [ ] Graph handles 50+ nodes without performance degradation

### Dependencies

- **Feature 2 (Deploy):** Must be in connected phase to access FLT APIs
- **Feature 5 (Top Bar):** Service status must show "running"

### Risks

| Risk | Mitigation |
|------|------------|
| SVG rendering is slow for large DAGs (>50 nodes) | Level-based layout (no force simulation). Lazy render off-screen nodes. |
| No framework for graph layout (dagre-d3 can't be imported) | Custom topological sort + level assignment. Simple but effective. |
| Node SQL code unavailable from DAG response | Show "Code available in V2" placeholder. `codeReference` has notebook IDs for future use. |

### Moonshot Vision

V2+: Side-by-side execution comparison (Feature 15). Inline SQL viewer via Notebook API (Feature 21). DAG definition diff (show what changed between runs). DAG node right-click → "Re-run from here" (partial execution).

---

## Feature 9: API Playground

### Problem

Engineers constantly run cURL commands against Fabric and FLT APIs — testing endpoints, debugging responses, checking DAG state. They maintain personal notes of endpoint URLs and have to manually manage token headers.

### Objective

A built-in API playground with request builder, response viewer, pre-configured FLT/Fabric endpoint library, history, and batch runner.

### Owner

**Primary:** Zara Okonkwo (JS)
**Reviewers:** Dev Patel (API endpoint catalog), Kael Andersen (UX), Mika Tanaka (CSS)

### Inputs

- Bearer token (Phase 1) and MWC token (Phase 2) from `/api/flt/config`
- Template variables: `{workspaceId}`, `{artifactId}`, `{capacityId}` from config
- Pre-configured endpoint catalog (Fabric APIs + FLT APIs + Maintenance APIs)

### Outputs

- **Files modified:**
  - `src/frontend/js/api-playground.js` — New class (replacing empty-state placeholder)
  - `src/frontend/css/api-playground.css` — Request builder, response viewer, history panel
  - `src/frontend/index.html` — Replace `#view-api` placeholder content

### Technical Design

**JS — `api-playground.js`:**

```
class ApiPlayground {
  constructor(viewEl, apiClient, stateManager)

  // Request builder
  setMethod(method)                    // GET/POST/PUT/PATCH/DELETE
  setUrl(url)                          // With template variable expansion
  setHeaders(headers)                  // Key-value, auto-fill Authorization
  setBody(jsonStr)                     // For POST/PUT/PATCH
  async sendRequest()                  // fetch() with timing measurement

  // Response viewer
  renderResponse(status, headers, body, duration)
  renderJsonTree(jsonObj)              // Collapsible JSON with syntax coloring

  // History + saved
  addToHistory(request, response)     // localStorage, max 50 entries
  saveRequest(name, request)          // Named request in localStorage
  loadFromHistory(index)              // Re-populate builder
  copyAsCurl()                        // Generate cURL command string

  // Endpoint catalog
  loadCatalog()                       // Pre-configured FLT + Fabric endpoints
  selectEndpoint(endpoint)            // Auto-populate method, URL, headers

  // Batch runner (future)
  queueRequest(request)
  async runBatch()
}
```

### Acceptance Criteria

- [ ] Method selector dropdown with GET/POST/PUT/PATCH/DELETE
- [ ] URL field with template variable auto-expansion (`{workspaceId}` etc.)
- [ ] Pre-configured endpoint dropdown with common FLT and Fabric APIs
- [ ] Authorization header auto-filled with current token
- [ ] "Send" button executes request and shows response below
- [ ] Response shows status badge (color-coded), timing, headers, JSON body
- [ ] JSON body is collapsible with syntax coloring
- [ ] "Copy as cURL" generates valid cURL command to clipboard
- [ ] Request history stored in localStorage (last 50 requests)
- [ ] Click history entry to re-populate request builder
- [ ] Works in disconnected mode (bearer token for Fabric APIs)
- [ ] Switches to MWC token for FLT-specific endpoints when connected

### Dependencies

- **Feature 5 (Top Bar):** Token health visible to know which token is available
- EdogApiProxy must serve both tokens

### Risks

| Risk | Mitigation |
|------|------------|
| CORS issues calling Fabric APIs from localhost | Fabric APIs may require proxy through edog.py/EdogLogServer. Add proxy endpoint if needed. |
| Large response bodies slow down JSON renderer | Truncate at 500KB. Show "Response too large — download as file" link. |

### Moonshot Vision

V2+: Batch runner for sequential API calls. Request chaining (use response of A as input to B). WebSocket testing mode. GraphQL explorer for Fabric APIs.

---

## Feature 10: Token Inspector

### Problem

Token expiry causes cryptic failures. Engineers currently decode JWTs manually (jwt.ms) to check scopes, expiry, and audience. When a token expires mid-session, they lose context on what went wrong.

### Objective

A right-side drawer (320px) showing decoded JWT claims, expiry progress bar, scope pills, with force-refresh and copy actions. Auto-opens when token expires.

### Owner

**Primary:** Zara Okonkwo (JS JWT decoding + drawer)
**Reviewers:** Elena Voronova (token refresh flow), Mika Tanaka (CSS drawer)

### Inputs

- Tokens from `/api/flt/config` (bearer + MWC when connected)
- IPC command: `POST /api/command/refresh-token`

### Outputs

- **Files modified:**
  - `src/frontend/js/topbar.js` — Token countdown click → open drawer
  - `src/frontend/css/token-inspector.css` — Drawer slide-in, JWT section styling
  - `src/frontend/index.html` — Add token inspector drawer markup (or build dynamically)

### Technical Design

**JS — in `topbar.js` or new `token-inspector.js`:**

```
class TokenInspector {
  constructor(drawerEl, apiClient)

  open()                               // Slide drawer in from right
  close()                              // Slide drawer out
  renderToken(tokenStr, type)          // Decode + display: header, payload, signature
  renderClaims(claims)                 // Key-value table from payload
  renderExpiryBar(exp, iat)            // Progress bar green → amber → red
  renderScopes(scp)                    // Scope pills
  handleRefresh()                      // POST /api/command/refresh-token
  handleCopy()                         // Copy raw token to clipboard

  _decodeJwt(token)                    // base64url decode header + payload (no verification)
}
```

### Acceptance Criteria

- [ ] Clicking token countdown in top bar opens Token Inspector drawer from right
- [ ] Drawer shows JWT sections: header (dimmed), payload (highlighted), signature (dimmed)
- [ ] Claims table shows: sub, aud, iss, exp, iat, name, roles/scopes
- [ ] Expiry progress bar with color: green (>10min), amber (5-10min), red (<5min)
- [ ] Scope list displayed as small pills
- [ ] "Refresh Token" button triggers force refresh via IPC
- [ ] "Copy Token" button copies raw token string to clipboard
- [ ] When connected: shows both Bearer and MWC tokens with tab selector
- [ ] When token expires: drawer auto-opens with warning state (red background tint)
- [ ] Drawer closes on Escape key or clicking outside
- [ ] Drawer width is 320px per spec

### Dependencies

- **Feature 5 (Top Bar):** Token countdown must exist as click target
- **Feature 2 (Deploy):** IPC channel needed for refresh command

### Risks

Minimal. JWT decoding is client-side base64, well-understood. Refresh command uses existing IPC channel.

### Moonshot Vision

V2+: Token diff (show what changed after refresh). Token timeline (history of all tokens this session). Scope-to-feature mapping (show which UI features each scope enables).

---

## Feature 11: Environment Panel

### Problem

Feature flags are managed through a separate PowerShell tool (FeatureTool.ps1), lock state requires manual API calls, and orphaned resources accumulate silently. Three separate workflows that should be in one place.

### Objective

A unified Environment view with three sections: Feature Flags (rollout visibility + local override + PR creation), Lock Monitor, and Orphaned Resources.

### Owner

**Primary:** Elena Voronova (Python flag parsing + git/PR), Zara Okonkwo (JS UI)
**Reviewers:** Dev Patel (flag behavior), Arjun Mehta (C# IFeatureFlighter wrapper), Sana Reeves (architecture)

### Inputs

- **Feature Flags:** 28 FLT flag JSON files from local FeatureManagement repo clone
- **Lock Monitor:** `GET /liveTableMaintenance/getLockedDAGExecutionIteration`, `POST /liveTableMaintenance/forceUnlockDAGExecution`
- **Orphaned Resources:** `GET /liveTableMaintenance/listOrphanedIndexFolders`, `POST /liveTableMaintenance/deleteOrphanedIndexFolders`
- **C# Interceptor:** `EdogFeatureFlighterWrapper.cs` (new) for local overrides

### Outputs

- **Files created:**
  - `src/backend/DevMode/EdogFeatureFlighterWrapper.cs` — IFeatureFlighter decorator with override + logging
  - `src/frontend/js/feature-flags.js` — Flag table renderer, override toggles, PR wizard
- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` (or new module) — Environment view content
  - `src/frontend/css/environment.css` — Flag table, lock monitor, orphaned resources styles
  - `edog.py` — Flag file parsing, git operations for PR creation
  - `src/backend/DevMode/EdogLogServer.cs` — Feature override endpoints, flag data serving

### Technical Design

**C# — `EdogFeatureFlighterWrapper.cs`:**

```csharp
public class EdogFeatureFlighterWrapper : IFeatureFlighter
{
    private readonly IFeatureFlighter _inner;
    private readonly EdogLogServer _logServer;
    private Dictionary<string, bool> _overrides;

    // Registered in RunAsync() callback (~line 196) where workloadContext exists
    public bool IsEnabled(string featureName, Guid? tenantId, Guid? capacityId, Guid? workspaceId)
    {
        if (_overrides.TryGetValue(featureName, out var overrideValue))
        {
            _logServer.AddLog($"Feature '{featureName}' → {overrideValue} (OVERRIDE)");
            return overrideValue;
        }
        var result = _inner.IsEnabled(featureName, tenantId, capacityId, workspaceId);
        _logServer.AddLog($"Feature '{featureName}' → {result}");
        return result;
    }
}
```

### Acceptance Criteria

- [ ] Feature flags table shows all 28 FLT flags with per-ring rollout state
- [ ] Cells show: ✓ (enabled), ✕ (disabled), ◐ (conditional) with tooltip on hover
- [ ] Click a flag row → expands to show full JSON definition
- [ ] Search/filter by flag name works
- [ ] Group by rollout state: "Fully rolled out", "Partially rolled out", "Not enabled"
- [ ] Override toggle shown per flag (connected mode only)
- [ ] Override changes take effect immediately via IFeatureFlighter wrapper
- [ ] "Create PR" button opens inline editor with rollout controls per environment
- [ ] Lock monitor shows current lock state with age timer
- [ ] "Force Unlock" button with confirmation dialog
- [ ] Orphaned resources list with individual and bulk delete buttons
- [ ] Connected-only sections (overrides, lock, orphaned) show appropriate empty states when disconnected

### Dependencies

- **Feature 2 (Deploy):** Connected mode needed for overrides, lock monitor, orphaned resources
- **Feature 2 (Deploy):** IPC channel needed for feature override updates

### Risks

| Risk | Mitigation |
|------|------------|
| IFeatureFlighter timing — late DI registration at RunAsync | Pattern confirmed in feasibility research (Appendix D). Test thoroughly. |
| FeatureManagement repo path not auto-detected | Configurable in edog-config.json. Default: search sibling directories. |

### Moonshot Vision

V2+: Flag experiment mode (A/B testing locally). Flag dependency graph (which flags affect which code paths). Automatic PR templates with approval chains.

---

## Feature 12: Error Code Decoder

### Problem

FLT error codes like `MLV_SPARK_SESSION_ACQUISITION_FAILED` appear in logs but engineers must grep the FLT codebase to find what they mean, whether they're user vs system errors, and what to try.

### Objective

Inline tooltips on known FLT error codes in log entries, showing human-readable description, error classification, and suggested fix. Error code lookup table generated at build time from `ErrorRegistry.cs`.

### Owner

**Primary:** Zara Okonkwo (JS tooltip rendering) + Ren Aoki (build script for JSON generation)
**Reviewers:** Dev Patel (error code accuracy)

### Inputs

- `ErrorRegistry.cs` from FLT repo — contains all error codes with message templates
- Build-time: Python script to parse C# file → generate `error-codes.json`
- Runtime: `renderer.js` matches error code patterns in log messages

### Outputs

- **Files created:**
  - `scripts/generate-error-codes.py` — Parse ErrorRegistry.cs → JSON lookup
  - `src/frontend/js/error-decoder.js` — Runtime error code matching + tooltip rendering
- **Files modified:**
  - `src/frontend/js/renderer.js` — Call error decoder on each log entry
  - `scripts/build-html.py` — Include error codes JSON in build output

### Acceptance Criteria

- [ ] Known FLT error codes in log messages are underlined/highlighted
- [ ] Hovering shows tooltip: error message, user/system classification, suggested fix
- [ ] Error codes work in both log entries and detail panel
- [ ] Build script generates `error-codes.json` from `ErrorRegistry.cs`
- [ ] Error codes JSON included in the single HTML file output
- [ ] Gracefully handles unknown error codes (no highlighting, no crash)

### Dependencies

- Access to FLT repo's `ErrorRegistry.cs` at build time

### Risks

Minor. ErrorRegistry.cs is static. Parsing is straightforward regex.

### Moonshot Vision

V2+: Link error codes to runbooks. Show error frequency trends. Suggest code changes based on error patterns.

---

## Feature 13: File Change Detection

### Problem

Engineers edit FLT C# code in VS, then must remember to rebuild and restart the service. They often test against stale code because they forgot to re-deploy.

### Objective

Python file watcher monitors the FLT repo for C# file changes (excluding EDOG patches), shows a notification bar in the UI with changed file names and a one-click "Re-deploy" button.

### Owner

**Primary:** Elena Voronova (Python watchdog watcher)
**Reviewers:** Sana Reeves (IPC design), Zara Okonkwo (UI notification bar)

### Inputs

- FLT repo `Service/` directory path
- Known EDOG patch files (to exclude from detection)
- Initial file state at session start (baseline for comparison)
- `watchdog` Python library for file system events

### Outputs

- **Files modified:**
  - `edog.py` — Add `FileWatcher` class using `watchdog` library
  - `src/frontend/js/topbar.js` — Render file change notification bar
  - `src/frontend/css/topbar.css` — Notification bar styles
  - `src/backend/DevMode/EdogLogServer.cs` — New WebSocket message type `file_changed`

### Acceptance Criteria

- [ ] File watcher detects .cs, .json, .csproj changes in FLT Service/ directory
- [ ] EDOG DevMode patch files are excluded from detection
- [ ] Build output directories excluded
- [ ] Notification bar shows: "Files changed: [list] — [Re-deploy] [Dismiss]"
- [ ] "Re-deploy" triggers full rebuild + relaunch
- [ ] "Dismiss" hides the bar (re-appears on next change)
- [ ] Changes debounced (2 second delay to batch rapid saves)
- [ ] Works alongside the regular deploy flow

### Dependencies

- **Feature 2 (Deploy):** Uses same deploy flow for re-deploy
- IPC channel for edog.py → browser communication

### Risks

| Risk | Mitigation |
|------|------------|
| `watchdog` adds a pip dependency | Already in requirements. Acceptable for CLI tool. |
| False positives from IDE temp files | Filter by extension (.cs, .json, .csproj only). Exclude bin/, obj/. |

### Moonshot Vision

V2+: Incremental rebuild (only rebuild changed assemblies). Hot-reload for config-only changes without full rebuild.

---

## Part 5: V2 Roadmap (10 Features)

### Feature 14: Spark Inspector

Full two-panel Spark HTTP request inspector. **Requires new C# interceptor:** `EdogTracingSparkClient` subclassing `GTSBasedSparkClient`, overriding `protected virtual SendHttpRequestAsync()` to capture all Spark HTTP traffic. `EdogTracingSparkClientFactory` wraps the original factory for DI swap. New WebSocket message type `spark_request`. Left panel: request list with method/endpoint/status/duration/retry badges. Right panel: tabbed view (Request, Response, Timing, Retry Chain). Key decision: capture must add <1ms overhead per request since it runs inside the FLT process hot path.

### Feature 15: Execution Comparison

Side-by-side diff of two DAG executions. Builds on Feature 8 (DAG Studio) history table. User selects two runs → shows which nodes changed status (was green, now red), timing differences (node X: 2s → 45s), new errors. Rendered as a split view with color-coded diff indicators. All data available from existing execution telemetry — no new APIs needed.

### Feature 16: New Test Environment Wizard

Inline horizontal stepper (not modal) at the bottom of Workspace Explorer. 6 steps: Create Workspace → Assign Capacity → Create Lakehouse → Create Notebook + Write MLV SQL → Run Notebook → Verify DAG. **API concerns:** Notebook creation/content/execution APIs have ⚠️ status — require runtime verification. Capacity assignment scope unclear. Fallback: skip steps with manual instructions if APIs unavailable.

### Feature 17: Service Restart from UI

Top bar "Restart" button. Uses IPC channel: browser → POST `/api/command/restart` → EdogLogServer writes `.edog-command/restart.json` → edog.py kills service → rebuilds → relaunches. Same infrastructure as Feature 2 (Deploy) and Feature 13 (File Change Detection). Simple once IPC exists.

### Feature 18: Session History / Timeline

Persistent log of EDOG actions: deploys, DAG runs, token refreshes, error events. Stored in localStorage with timestamps. Displayed as a vertical timeline in a collapsible bottom panel or drawer. Like `git reflog` for EDOG sessions. Client-side only, no backend changes.

### Feature 19: Capacity Health Indicator

Before deploying, check target capacity for throttling. `GET api.fabric.microsoft.com/v1/capacities/{id}` — **scope may require admin access**. If available: show CU usage %, throttling state. If unavailable: infer from 429/430 responses in Spark Inspector after connecting. Show as color-coded badge in Workspace Explorer inspector panel.

### Feature 20: Quick Environment Clone

"Clone this lakehouse setup to a new workspace" — automated multi-step wizard. Create workspace + assign capacity + create lakehouse + copy notebooks. **Notebook copy API has ⚠️ status.** Fallback: create empty workspace/lakehouse, provide manual instructions for notebook copying. Uses same APIs as Feature 16.

### Feature 21: DAG Definition Viewer

View MLV SQL definitions per DAG node. `codeReference` in DAG response has notebook IDs + cell indices, not actual SQL. **Requires:** `GET /v1/workspaces/{id}/notebooks/{id}/content` → extract cells at specified indices. For SQL-type nodes (`kind="sql"`): query catalog or SQL endpoint. Displayed as syntax-highlighted read-only code panel when a DAG node is selected in Feature 8.

### Feature 22: Table Schema + Preview + Stats

In Workspace Explorer inspector panel (right panel), show: column schema (name, type, nullable), first 5 data rows preview, row count, file count, total size, partition info. **Requires SQL endpoint connection or Delta metadata reading** — not available via standard Fabric REST APIs. Research: SQL analytics endpoint (`{lakehouse}.dfs.fabric.microsoft.com`) with bearer token.

### Feature 23: CRUD Operations on All Fabric Items

Extend Workspace Explorer to support create/rename/delete for all item types (not just workspaces and lakehouses). Notebooks, Pipelines, KQL DBs, Reports. Each type uses its specific Fabric API endpoint. Context menu actions per item type. "New Item" button with type selector dropdown.

---

## Part 6: Cross-Cutting Concerns

### Mock Flag: How `?mock=true` Works

**Principle:** Mock data stays in the build but never executes in production mode.

```
On page load (main.js init):
  const useMock = new URLSearchParams(window.location.search).get('mock') === 'true';

  if (useMock) {
    MockRenderer.init();   // Renders mock data into all views
  } else {
    App.init();            // Real API connections, WebSocket, live data
  }
```

- `mock-data.js` — Static data objects for all views (workspaces, logs, DAG nodes, etc.)
- `mock-renderer.js` — Populates UI using mock data objects
- Both files remain in `build-html.py` module list, always included in output
- Real modules (workspace-explorer.js, renderer.js, etc.) are also always included
- The mock flag determines which initialization path runs — both code paths exist but only one executes
- Testing: `make test-mock` opens browser with `?mock=true` for visual verification

### Testing Strategy

| Layer | Framework | What to Test | How |
|-------|-----------|-------------|-----|
| **Python** | pytest | Token parsing, config management, build script, favorites I/O, flag file parsing, IPC command handling | `make test` (runs pytest) |
| **C#** | MSTest | EdogFeatureFlighterWrapper behavior, log model serialization, API proxy response format | `dotnet test` in FLT solution |
| **JavaScript** | Manual browser | All 6 views render, keyboard shortcuts work, WebSocket streaming, filter controls, command palette | Browser testing checklist per ENGINEERING_STANDARDS.md |
| **Integration** | End-to-end manual | Deploy flow, token refresh, phase transitions, IPC commands | Launch edog, walk through full workflow |
| **Build** | Automated | `build-html.py` produces valid single-file HTML, no external resources | `make build` + validate output |

**Per-feature test requirements:**

- Every Python function gets a pytest test
- Every C# public method gets an MSTest test
- Every new JS view gets a browser testing checklist entry
- No feature ships without passing `make lint && make test && make build`

### Build Pipeline Evolution

**Current (`build-html.py`):**

```
CSS modules (19) + JS modules (19) + index.html → single edog-logs.html
```

**MVP additions:**

- No new modules — existing modules updated in place
- Module order may need adjustment if new JS classes have dependencies

**V1.1 additions:**

New JS modules added to `JS_MODULES` list in `build-html.py`:
- `js/dag-graph.js` (after `control-panel.js`)
- `js/dag-gantt.js` (after `dag-graph.js`)
- `js/api-playground.js` (after `command-palette.js`)
- `js/token-inspector.js` (after `topbar.js`)
- `js/feature-flags.js` (after `workspace-explorer.js`)
- `js/error-decoder.js` (after `error-intel.js`)
- `js/file-watcher-ui.js` (after `topbar.js`)

Error codes JSON inlined as a `<script>` block or embedded in `error-decoder.js`.

**V2 additions:**

- `js/spark-list.js`, `js/spark-detail.js`
- `js/execution-compare.js`
- `js/env-wizard.js`
- `js/session-timeline.js`

**Build ownership:** Ren Aoki. All module order changes must be approved by Ren.

### IPC Architecture: edog.py ↔ EdogLogServer

**File-based command channel (MVP implementation):**

```
Directory: .edog-command/ (in project root, gitignored)

Command flow:
  Browser → POST /api/command/{action} → EdogLogServer
    → writes .edog-command/{action}.json with payload
    → edog.py polls .edog-command/ every 2 seconds
    → reads command file, executes, deletes command file
    → writes .edog-command/{action}-result.json
    → EdogLogServer reads result on next poll or via WebSocket notification

Commands:
  deploy          {workspaceId, artifactId, capacityId}
  restart         {}
  refresh-token   {}
  set-overrides   {overrides: {flagName: bool, ...}}
```

**Alternative (V1.1 upgrade if latency unacceptable):**

```
edog.py runs HTTP server on port 5556
  POST :5556/command/restart
  POST :5556/command/refresh-token
  POST :5556/command/deploy

EdogLogServer proxies /api/command/* to :5556
Browser still talks to :5555 only
```

### Token Flow

| Phase | Token | Source | Used For |
|-------|-------|--------|----------|
| **Disconnected** | AAD/Entra Bearer | Playwright cert-based login → edog.py → EdogApiProxy → browser | Fabric public APIs (`api.fabric.microsoft.com/v1/*`) |
| **Connected** | Bearer + MWC | Bearer (same) + `fetch_mwc_token()` for specific workspace | Bearer: Fabric APIs. MWC: FLT service endpoints. |

**Token lifecycle:**

1. edog.py authenticates via Playwright → caches bearer token
2. On deploy: edog.py calls `fetch_mwc_token(workspace_id)` using bearer token → caches MWC token
3. EdogApiProxy reads both cached tokens → serves via `/api/flt/config`
4. Browser JS stores tokens in memory (never localStorage)
5. Token countdown in top bar tracks nearest expiry
6. On expiry: Token Inspector auto-opens. "Refresh" triggers IPC → edog.py re-authenticates.

**Security rules:**
- Tokens never logged (even in debug mode)
- Token cache file (`.edog-token-cache`) is gitignored, user-read-only permissions
- API proxy validates requests are from localhost only

### Error Handling Philosophy

**Three tiers:**

1. **User-facing errors (UI):** Toast notifications with clear message + suggested action. Example: "Cannot list workspaces — token may have expired. [Refresh Token]"

2. **Operational errors (logs):** Specific exception types, never bare `except`. Example:
   ```python
   except FabricApiError as e:
       log.error(f"Fabric API {e.endpoint} returned {e.status}: {e.message}")
       notify_ui("api_error", {"endpoint": e.endpoint, "status": e.status})
   ```

3. **Infrastructure errors (build/deploy):** Clear step-level failure with context. Example: "Deploy failed at Step 3/5: Build error — see terminal output"

**Never:**
- Swallow exceptions silently
- Show raw stack traces to users
- Retry indefinitely without backoff
- Show "Something went wrong" without actionable next steps

---

## Part 7: Dependency Graph

### Feature Dependencies

```
                    ┌──────────────────┐
                    │  EdogApiProxy    │
                    │  (bearer token   │
                    │   in config)     │
                    └────────┬─────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
               ▼             ▼             ▼
    ┌──────────────┐  ┌────────────┐  ┌────────────┐
    │ F1: Workspace│  │ F5: Top Bar│  │ F6: Sidebar│
    │    Explorer  │  │            │  │            │
    └──────┬───────┘  └─────┬──────┘  └─────┬──────┘
           │                │               │
           │    ┌───────────┼───────────────┘
           │    │           │
           ▼    ▼           ▼
    ┌──────────────┐  ┌────────────┐
    │ F2: Deploy   │  │ F7: Command│
    │ to Lakehouse │  │   Palette  │
    └──────┬───────┘  └────────────┘
           │
           ▼
    ┌──────────────┐
    │ F3: Favorites│
    └──────────────┘

    ┌──────────────┐
    │ F4: Enhanced │   (independent — no feature dependencies)
    │    Logs      │
    └──────────────┘
```

### MVP Execution Order

```
Wave 1 (parallel — no dependencies between them):
  ├── F1: Workspace Explorer  (Zara + Mika + Dev)
  ├── F4: Enhanced Logs       (Zara + Mika)
  ├── F5: Top Bar             (Zara + Mika + Elena)
  └── F6: Sidebar             (Zara + Mika)

Wave 2 (depends on Wave 1):
  ├── F2: Deploy to Lakehouse (Elena + Zara + Arjun)  ← needs F1, F5, F6
  └── F7: Command Palette     (Zara)                  ← needs F1, F6

Wave 3 (depends on Wave 2):
  └── F3: Favorites           (Zara + Elena)          ← needs F1, F2
```

### V1.1 Execution Order

```
Wave 4 (parallel — all depend on MVP being complete):
  ├── F8:  DAG Studio          (Zara + Dev)         ← needs connected phase
  ├── F9:  API Playground      (Zara + Dev)         ← needs token serving
  ├── F10: Token Inspector     (Zara + Elena)       ← needs token serving
  └── F12: Error Code Decoder  (Zara + Ren + Dev)   ← needs build script

Wave 5 (depends on Wave 4):
  ├── F11: Environment Panel   (Elena + Zara + Arjun + Dev)  ← needs IPC + connected phase
  └── F13: File Change Detect  (Elena + Zara)                ← needs IPC channel
```

### V2 Execution Order

```
Wave 6 (parallel):
  ├── F14: Spark Inspector     (Arjun + Zara)       ← new C# interceptor
  ├── F17: Service Restart     (Elena + Zara)        ← uses existing IPC
  ├── F18: Session Timeline    (Zara)                ← client-side only
  └── F19: Capacity Health     (Zara + Dev)          ← API research needed

Wave 7 (depends on Wave 6):
  ├── F15: Execution Compare   (Zara)                ← needs F8 (DAG Studio)
  ├── F21: DAG Definition      (Zara + Dev)          ← needs F8 + Notebook API
  └── F22: Table Schema        (Zara + Dev)          ← needs SQL endpoint research

Wave 8 (depends on Wave 7):
  ├── F16: Test Env Wizard     (Elena + Zara)        ← needs API research complete
  ├── F20: Quick Env Clone     (Elena + Zara)        ← needs F16 research
  └── F23: CRUD Operations     (Zara + Dev)          ← extends F1
```

### Parallelization Summary

| Phase | Max Parallel Streams | Bottleneck |
|-------|---------------------|------------|
| MVP Wave 1 | 4 features | Zara is on all 4 — stagger starts |
| MVP Wave 2 | 2 features | Elena needed for Deploy + IPC setup |
| MVP Wave 3 | 1 feature | Sequential after deploy flow works |
| V1.1 Wave 4 | 4 features | Zara is on all 4 — stagger by complexity |
| V1.1 Wave 5 | 2 features | Arjun needed for C# interceptor |

**Agent utilization across MVP:**

| Agent | Wave 1 | Wave 2 | Wave 3 |
|-------|--------|--------|--------|
| Zara (JS) | F1, F4, F5, F6 | F2 (UI), F7 | F3 |
| Mika (CSS) | F1, F4, F5, F6 | — | — |
| Elena (Python) | F5 (config) | F2 (deploy) | F3 (persistence) |
| Arjun (C#) | — | F2 (endpoints) | — |
| Dev (FLT) | F1 (API review) | — | — |
| Kael (UX) | Review all | Review all | Review all |
| Sana (Arch) | — | F2 (IPC review) | — |
| Ines (QA) | Test all | Test all | Test all |
| Ren (Build) | — | — | — |

---

*"A plan is not a schedule. It's a dependency map with named owners and testable exit criteria. Everything else is noise."*

— Nadia Kovács
