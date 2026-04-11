# Feature 1: Workspace Explorer

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
> **Spec:** docs/specs/features/F01-workspace-explorer.md
> **Design Ref:** docs/specs/design-spec-v2.md §1

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

