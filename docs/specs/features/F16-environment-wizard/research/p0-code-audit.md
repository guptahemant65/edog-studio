# P0.1 — Code Audit: Existing Codebase Analysis

> **Feature:** F16 — New Infra Wizard
> **Auditors:** Vex (Python/C#) + Pixel (JS/CSS)
> **Date:** 2025-07-18
> **Status:** COMPLETE

---

## Executive Summary

The EDOG Studio codebase is **well-positioned** for F16 development. The existing modular class-based architecture provides strong foundations across all three layers — modal UI, API integration, and backend routing. Key findings:

**What's reusable (HIGH confidence):** The `FabricApiClient` class already provides every Fabric API method F16 needs for workspace, lakehouse, and notebook CRUD — including the token management (Bearer + MWC), proxy routing, and error handling patterns. The `DeployFlow` class provides a battle-tested SSE-based progress tracking pattern with step states, elapsed timers, and retry buttons that map directly to F16's execution pipeline. The command-palette and onboarding overlays provide proven modal/overlay patterns (backdrop click dismiss, keyboard handling, fade animations) that the `InfraWizardDialog` can follow.

**What's partially reusable (MEDIUM confidence):** The tab lifecycle pattern (`activate()`/`deactivate()` + SignalR subscription) maps well to wizard page lifecycle, but needs adaptation from single-tab to multi-page wizard navigation. The deploy-flow stepper CSS (`.deploy-step` with done/active/failed states, connectors, and glow animations) is directly applicable to the wizard step indicator, but needs width adjustment for 5 steps vs 5 deploy steps. The workspace-explorer's context menu and toast patterns work but aren't generic — F16 should extract shared utilities.

**What's missing (needs building):** Canvas rendering (SVG DAG nodes, arrow path routing, zoom/pan), drag-and-drop from palette to canvas, undo/redo state management, template file I/O (backend endpoints + frontend save/load), code generation engine (SQL/PySpark template literals), auto-layout algorithm (topological sort + Sugiyama-style positioning), and the minimizable floating badge pattern. No existing module does canvas-based visual editing.

---

## 1. Frontend JavaScript Audit

### 1.1 workspace-explorer.js

**File:** `src/frontend/js/workspace-explorer.js` (~2,646 lines)
**Class:** `WorkspaceExplorer`

#### Class Structure

```javascript
class WorkspaceExplorer {
  constructor(apiClient) {
    this._api = apiClient;                          // FabricApiClient instance
    this._treeEl = document.getElementById('ws-tree-content');
    this._contentEl = document.getElementById('ws-content-body');
    this._inspectorEl = document.getElementById('ws-inspector-content');
    this._favoritesEl = document.getElementById('ws-favorites-list');

    this._selectedItem = null;
    this._selectedWorkspace = null;
    this._workspaces = [];
    this._expanded = new Set();
    this._children = {};
    this._favorites = [];
    this._toastEl = null;
    this._ctxMenu = null;
    this._ctxTarget = null;
    this._isMock = new URLSearchParams(window.location.search).has('mock');
    this._tableSort = { col: null, dir: null };
    this._currentTables = null;
    this._notebookCache = {};
    this._environmentCache = {};
    this._activeNotebookView = null;
  }
}
```

#### Full Method Inventory

| Category | Method | Signature | Purpose |
|----------|--------|-----------|---------|
| **Init** | `init()` | `async init()` | Creates toast/context menu, loads workspaces, binds events |
| **Toast** | `_toast(msg, type)` | `_toast(msg, type='info')` | Show timed toast (2.5s auto-dismiss) |
| **Toast** | `_toastConfirm(msg, timeoutMs)` | `_toastConfirm(msg, 5000)` → `Promise<boolean>` | Confirm dialog with auto-dismiss |
| **Context Menu** | `_createContextMenu()` | `_createContextMenu()` | Attach global context menu DOM |
| **Context Menu** | `_showContextMenu(e, nodeData)` | `_showContextMenu(e, {item, workspace, isWorkspace, isLakehouse})` | Render context menu by node type |
| **Context Menu** | `_hideContextMenu()` | `_hideContextMenu()` | Hide and clear target |
| **Context Menu** | `_ctxDeploy()` | `_ctxDeploy()` | Trigger deploy flow |
| **Context Menu** | `_ctxRename()` | `async _ctxRename()` | Inline rename with API call |
| **Context Menu** | `_ctxDelete()` | `async _ctxDelete()` | Confirm delete via toast |
| **Context Menu** | `_ctxOpenInFabric()` | `_ctxOpenInFabric()` | Open in fabric.microsoft.com |
| **Context Menu** | `_ctxCopyId()` / `_ctxCopyName()` | — | Copy to clipboard |
| **Context Menu** | `_ctxSaveFavorite()` | — | Add lakehouse to favorites |
| **Context Menu** | `_ctxCreateLakehouse()` | `async _ctxCreateLakehouse()` | Create lakehouse with inline input |
| **Data** | `loadWorkspaces()` | `async loadWorkspaces()` | Fetch/mock workspaces, render tree |
| **Data** | `_loadChildren(ws)` | `async _loadChildren(ws)` | Fetch workspace items |
| **Data** | `_loadTables(wsId, lhId, capId)` | `async _loadTables(...)` | Fetch tables (public API or capacity host) |
| **Tree** | `_renderTree()` | `_renderTree()` | Full tree DOM rebuild |
| **Tree** | `_buildTreeNode(opts)` | `_buildTreeNode({name, depth, ...})` → `HTMLElement` | Single tree node with chevron + icon |
| **Tree** | `_toggleWorkspace(ws)` | `async _toggleWorkspace(ws)` | Expand/collapse + fetch children |
| **Selection** | `_selectWorkspace(ws)` | `_selectWorkspace(ws)` | Set selection, show content/inspector |
| **Selection** | `_selectItem(item, ws)` | `_selectItem(item, ws)` | Set item selection |
| **Content** | `_showItemContent(item, ws)` | `_showItemContent(item, ws)` | Dispatcher to type-specific views |
| **Content** | `_showLakehouseContent(lh, ws)` | `async _showLakehouseContent(lh, ws)` | Lakehouse details + **deploy button** |
| **Content** | `_showNotebookContent(item, ws)` | `async _showNotebookContent(item, ws)` | Notebook IDE launcher |
| **Content** | `_showEnvironmentContent(item, ws)` | `async _showEnvironmentContent(item, ws)` | Environment publish status |
| **Content** | `_showWorkspaceContent(ws)` | `_showWorkspaceContent(ws)` | Workspace items table |
| **Inspector** | `_showTableInspector(tbl)` | `_showTableInspector(tbl)` | Table schema + metadata |
| **Inspector** | `_showWorkspaceInspector(ws)` | `_showWorkspaceInspector(ws)` | Workspace detail |
| **Deploy** | `_deployToLakehouse(lh, ws)` | `async _deployToLakehouse(lh, ws)` | **Initiate deploy flow** |
| **Utility** | `_esc(s)` | → `string` | HTML escape |
| **Utility** | `_formatDate(date)` | → `string` | "Nov 12, 2024" format |
| **Utility** | `_isLakehouse(item)` | → `boolean` | Type check |
| **Utility** | `_formatSize(bytes)` | → `string` | "1.2 GB" format |

#### Event Patterns

**Context menu:** Right-click on tree node → `_showContextMenu(e, nodeData)` → stores `_ctxTarget` → renders menu items with action closures → each item click calls `_hideContextMenu()` then action. Dismissed on document click or Escape.

```javascript
// Pattern: Event delegation with closure-based actions
items.forEach(it => {
  const el = document.createElement('div');
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    this._hideContextMenu();
    it.action();
  });
});

// Escape + outside-click dismissal
document.addEventListener('click', () => this._hideContextMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') this._hideContextMenu();
});
```

**Tree node click:** `stopPropagation` on toggle, direct `_selectWorkspace` / `_selectItem` calls.

**Deploy button:** Direct `addEventListener('click')` on `#ws-deploy-btn`.

#### Integration Points for F16 Wizard Trigger

**Primary — Context menu (lakehouse right-click):**
```javascript
if (nodeData.isLakehouse) {
  items.push({ label: 'Deploy to this Lakehouse', cls: 'accent', action: () => this._ctxDeploy() });
  // ⭐ ADD HERE: { label: 'Create Infrastructure...', cls: 'accent', action: () => this._openInfraWizard() }
}
```

**Secondary — Workspace action bar:**
```javascript
// In _showWorkspaceContent(), add button next to existing actions:
// <button class="ws-btn-primary" id="ws-infra-wizard-btn">New Environment</button>
```

**Tertiary — Empty state (no workspaces):**
```javascript
// When no workspaces exist, show "Create your first test environment" CTA
```

**Data available at trigger point:**
```javascript
{
  workspaceId: ws.id,           // Current workspace (if selected)
  lakehouseId: lh.id,           // Current lakehouse (if selected)
  capacityId: ws.capacityId,    // Capacity from workspace metadata
  workspaceName: ws.displayName,
  tables: this._currentTables,  // Already loaded table list
}
```

#### State Management Approach

Distributed state with direct method calls (no event bus):

```javascript
_selectItem(item, ws) {
  this._selectedItem = { ...item, workspaceId: ws.id, workspaceName: ws.displayName };
  this._selectedWorkspace = ws;
  this._showItemContent(item, ws);  // Direct method call → synchronous
  this._renderTree();               // Full re-render
}
```

**Key insight:** No global event bus exists. Modules communicate via:
1. Direct method calls (`this.workspaceExplorer.loadWorkspaces()`)
2. Global window refs (`window.edogApp.runtimeView.switchTab()`)
3. Callback properties (`this.onUpdate = (state) => { ... }`)

F16 should use approach #3 (callback) for wizard-to-explorer communication.

---

### 1.2 api-client.js

**File:** `src/frontend/js/api-client.js` (~510 lines)
**Class:** `FabricApiClient`

#### Class Structure & Token Management

```javascript
class FabricApiClient {
  constructor() {
    this._bearerToken = null;       // Fabric public API token
    this._mwcToken = null;          // FLT service token (Phase 2)
    this._fabricBaseUrl = null;     // e.g. https://api.fabric.microsoft.com/v1
    this._config = null;            // Full config object
    this._phase = 'disconnected';   // 'disconnected' | 'connected'
    this._baseUrl = '/api/fabric';  // Proxy through dev-server
  }
}
```

#### Token Modes

| Mode | Header Format | When Used | Endpoints |
|------|--------------|-----------|-----------|
| **Bearer** | `Authorization: Bearer {token}` | Always (Phase 1 + 2) | `/api/fabric/*` (workspaces, lakehouses, notebooks) |
| **MWC** | `Authorization: MwcToken {token}` | Phase 2 only | `/api/mwc/*` (tables, DAG), FLT service direct |

**Token acquisition:**
```javascript
async fetchConfig() {
  const resp = await fetch('/api/flt/config');
  this._config = await resp.json();
  this._bearerToken = this._config.bearerToken || null;
  this._mwcToken = this._config.mwcToken || null;
  this._fabricBaseUrl = this._config.fabricBaseUrl || null;
  this._phase = this._config.phase || (this._mwcToken ? 'connected' : 'disconnected');
}
```

#### Full Method Inventory

**Initialization:**
| Method | Returns | F16 Use |
|--------|---------|---------|
| `init()` | `Promise<void>` | Init at app startup |
| `fetchConfig()` | `Promise<object\|null>` | Refresh tokens |
| `getPhase()` | `'connected'\|'disconnected'` | Check connection state |
| `getConfig()` | `object\|null` | Read full config |
| `hasBearerToken()` | `boolean` | Guard API calls |
| `getAuthState()` | `Promise<{authenticated, expiresIn}>` | Token health check |

**Workspace CRUD (F16 needs ALL of these):**
| Method | HTTP | Path | F16 Use |
|--------|------|------|---------|
| `listWorkspaces()` | GET | `/workspaces?$top=100` | Pre-fill check (name collision) |
| `createWorkspace(name)` | POST | `/workspaces` | **Step 1: Create workspace** |
| `renameWorkspace(id, name)` | PATCH | `/workspaces/{id}` | — |
| `deleteWorkspace(id)` | DELETE | `/workspaces/{id}` | **Rollback on failure** |

**Lakehouse CRUD:**
| Method | HTTP | Path | F16 Use |
|--------|------|------|---------|
| `listLakehouses(wsId)` | GET | `/workspaces/{id}/lakehouses` | — |
| `createLakehouse(wsId, name)` | POST | `/workspaces/{id}/lakehouses` | **Step 3: Create lakehouse** |
| `deleteLakehouse(wsId, lhId)` | DELETE | `/workspaces/{id}/lakehouses/{id}` | **Rollback** |

**Notebook CRUD:**
| Method | HTTP | Path | F16 Use |
|--------|------|------|---------|
| `listNotebooks(wsId)` | GET | `/workspaces/{id}/notebooks` | — |
| `getNotebookContent(wsId, nbId)` | GET | `/notebook/content` | — |
| `saveNotebookContent(wsId, nbId, content)` | POST | `/notebook/save` | **Step 5: Write cells** |
| `runNotebook(wsId, nbId)` | POST | `/notebook/run` | **Step 6: Run notebook** |
| `getNotebookRunStatus(locationUrl)` | GET | `/notebook/run-status` | **Poll execution** |
| `cancelNotebookRun(locationUrl)` | POST | `/notebook/cancel` | — |

**Environment:**
| Method | HTTP | Path | F16 Use |
|--------|------|------|---------|
| `listEnvironments(wsId)` | GET | `/workspaces/{id}/environments` | — |

**Table APIs:**
| Method | HTTP | Path | F16 Use |
|--------|------|------|---------|
| `listTables(wsId, lhId)` | GET | `/workspaces/{id}/lakehouses/{id}/tables` | Post-creation verification |
| `listTablesViaCapacity(wsId, lhId, capId)` | GET | `/mwc/tables` | Fallback |

**DAG APIs (Phase 2):**
| Method | HTTP | Path | F16 Use |
|--------|------|------|---------|
| `getLatestDag()` | GET | `{fabricBaseUrl}/liveTable/getLatestDag` | — |

#### Fetch Wrapper Implementation

**Fabric API (throws on error):**
```javascript
async _fabricFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (this._bearerToken) headers['Authorization'] = `Bearer ${this._bearerToken}`;

  const resp = await fetch(this._baseUrl + path, { ...options, headers });
  if (!resp.ok) {
    const err = new Error(`Fabric API error: ${resp.status}`);
    err.status = resp.status;
    err.body = await resp.text().catch(() => '');
    err.path = path;
    throw err;  // ← THROWS on non-2xx
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}
```

**FLT Service (returns null on error):**
```javascript
async _fltFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `MwcToken ${this._mwcToken}`,
  };
  const resp = await fetch(this._fabricBaseUrl + path, { ...options, headers });
  if (!resp.ok) return null;  // ← SILENT FAIL
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}
```

#### What F16 Needs That's Already There vs Missing

| Need | Status | Notes |
|------|--------|-------|
| Create workspace | ✅ `createWorkspace(name)` | Works, returns `{id, displayName}` |
| Assign capacity | ❌ **MISSING** | Need `assignCapacity(wsId, capId)` — POST `/workspaces/{id}/assignToCapacity` |
| List capacities | ❌ **MISSING** | Need `listCapacities()` — GET `/v1.0/myorg/capacities` |
| Create lakehouse | ✅ `createLakehouse(wsId, name)` | Need to verify `enableSchemas` body param |
| Create notebook | ❌ **MISSING** | Need `createNotebook(wsId, name)` — POST `/workspaces/{id}/notebooks` |
| Write notebook cells | ✅ `saveNotebookContent(wsId, nbId, content)` | May need updateDefinition format |
| Run notebook | ✅ `runNotebook(wsId, nbId)` | Returns location for polling |
| Poll notebook run | ✅ `getNotebookRunStatus(locationUrl)` | Returns status, failure reason |
| Delete workspace | ✅ `deleteWorkspace(wsId)` | For rollback |
| Delete lakehouse | ✅ `deleteLakehouse(wsId, lhId)` | For rollback |

**Gap: 3 new methods needed** in `api-client.js`:
1. `listCapacities()` — GET to Power BI capacities endpoint
2. `assignCapacity(wsId, capId)` — POST to assign capacity
3. `createNotebook(wsId, name)` — POST to create empty notebook

---

### 1.3 deploy-flow.js

**File:** `src/frontend/js/deploy-flow.js` (~480 lines)
**Class:** `DeployFlow`

#### Class Structure

```javascript
class DeployFlow {
  constructor(containerEl) {
    this._el = containerEl;
    this._es = null;           // EventSource (SSE)
    this._active = false;
    this._logs = [];
    this._startTime = null;
    this._state = {
      step: 0,         // Current step (0-4)
      total: 5,        // Total steps
      status: 'idle',  // 'idle' | 'deploying' | 'running' | 'stopped'
      message: '',
      error: null,
      fltPort: null,
    };
    this._elapsedTimer = null;
    this.onUpdate = null;      // Callback on state change
  }

  static STEPS = [
    { id: 0, label: 'Fetch token' },
    { id: 1, label: 'Update config' },
    { id: 2, label: 'Patch + Build' },
    { id: 3, label: 'Launch service' },
    { id: 4, label: 'Ready check' },
  ];
}
```

#### SSE-Based Progress Tracking (NOT traditional polling)

The deploy flow uses **Server-Sent Events**, not setInterval polling:

```javascript
_connectSSE() {
  this._es = new EventSource('/api/command/deploy-stream');

  this._es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    this._state.step = data.step;
    this._state.status = data.status;
    this._state.message = data.message || '';
    this._state.error = data.error != null ? data.error : null;

    if (data.log) {
      this._logs.push(data.log);
      if (!stepChanged) {
        this._appendLog(data.log);  // Incremental DOM append
        if (this.onUpdate) this.onUpdate(this._state);
        return;
      }
    }
    this._render();
    if (this.onUpdate) this.onUpdate(this._state);
  };

  this._es.addEventListener('complete', (e) => {
    // Terminal event — close SSE, stop timers
    this._closeSSE();
    this._stopElapsedTimer();
    this._active = false;
    this._render();
  });

  this._es.onerror = () => {
    this._sseErrors = (this._sseErrors || 0) + 1;
    if (this._sseErrors >= 3) {
      this._state.message = 'Connection lost — reconnecting...';
      this._render();
    }
  };
}
```

**SSE message format:**
```json
{ "step": 2, "status": "deploying", "message": "Building artifact", "error": null, "log": { "ts": "...", "msg": "...", "level": "info" } }
```

**F16 implications:** The execution pipeline (C10) can reuse this SSE pattern for step-by-step progress — BUT F16's pipeline is sequential API calls from the frontend (not backend-driven like deploy). F16 will likely use a **fetch-based sequential pipeline** rather than SSE, since each step is a discrete API call the frontend orchestrates.

#### State Machine

```
idle → deploying → running (success) OR stopped (error)
                           ↑
                      [user retry]
```

#### Progress Calculation

```javascript
const pct = status === 'running' ? 100
  : status === 'stopped' && !error ? 0
  : Math.min(((step + (status === 'deploying' ? 0.5 : 0)) / total) * 100, 100);
```

#### Elapsed Time Tracking

```javascript
_startElapsedTimer() {
  this._elapsedTimer = setInterval(() => {
    const el = this._el.querySelector('.deploy-elapsed');
    if (el && this._startTime) {
      el.textContent = Math.floor((Date.now() - this._startTime) / 1000) + 's';
    }
  }, 1000);
}
```

#### Retry Logic

```javascript
// On "Retry" button click:
// 1. Fetch /api/studio/status for persisted deploy target
// 2. Fallback: use this._pendingTarget (in-session cache)
// 3. Fallback: show error "No deploy target available"
```

No exponential backoff. No step-level retries. Manual user-initiated retry only.

#### Conflict Detection (409)

```javascript
if (resp.status === 409) {
  if (err.error === 'already_deployed') {
    this._showSwitchConfirm(err.currentTarget, newTarget);
    return;
  }
}
```

The `_showSwitchConfirm` creates a full-screen backdrop + centered card with "Switch & Deploy" / "Cancel" buttons — this is the closest existing pattern to a modal dialog.

#### What F16's Execution Pipeline Can Reuse

| Deploy Pattern | F16 Reuse | Adaptation Needed |
|---------------|-----------|-------------------|
| Step state machine (`idle→deploying→running/stopped`) | ✅ Direct reuse | Add per-step status (pending/running/done/failed/skipped) |
| `onUpdate` callback | ✅ Direct reuse | Same pattern for pipeline status updates |
| Elapsed timer (`setInterval` + `_startTime`) | ✅ Direct reuse | Per-step timers, not just global |
| Progress bar CSS (`.deploy-progress-fill`) | ✅ Direct reuse | Same styles work |
| Stepper CSS (`.deploy-step.done/.active/.failed`) | ✅ Direct reuse | Change from 5 deploy steps to 6 pipeline steps |
| Log buffer + incremental append | ✅ Direct reuse | Each pipeline step gets its own log buffer |
| Terminal display (`.deploy-terminal-*`) | ✅ Direct reuse | Show API response details per step |
| Retry button pattern | ✅ Direct reuse | "Retry from failed step" |
| Switch confirm dialog | ✅ Adapt for conflict handling | Workspace name collision dialog |
| SSE streaming | ❌ Not applicable | F16 pipeline is client-orchestrated, not server-push |
| `_pendingTarget` cache | ✅ Adapt | Cache wizard state for resume/retry |
| `resume(state)` pattern | ✅ Adapt | Resume after page refresh |

---

### 1.4 Other JS Modules

#### Modal/Dialog Patterns

**1. Command Palette (command-palette.js)** — Most complete modal pattern:
```javascript
class CommandPalette {
  constructor(sidebar, workspaceExplorer) {
    this._el = document.getElementById('command-palette');
    this._visible = false;
    this._selectedIndex = -1;
  }

  show() {
    this._el.classList.remove('hidden');
    this._visible = true;
    this._inputEl.focus();
  }

  hide() {
    this._el.classList.add('hidden');
    this._visible = false;
  }

  toggle() { this._visible ? this.hide() : this.show(); }
}
```

Keyboard: `Ctrl+K` to toggle, `Escape` to close, `ArrowUp/Down` for navigation, `Enter` to select.
Backdrop: Click to dismiss.

**2. Onboarding Overlay (onboarding.js)** — Full-screen overlay with fade animation:
```javascript
_createOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  document.body.appendChild(overlay);
}

dismiss() {
  this._overlay.classList.add('fade-out');
  setTimeout(() => {
    this._overlay.parentNode.removeChild(this._overlay);
    this._overlay = null;
  }, 400);
}
```

**3. Deploy Switch Confirm (deploy-flow.js)** — Centered card on backdrop:
```javascript
_showSwitchConfirm(currentTarget, newTarget) {
  // Full-screen backdrop + centered card
  // "Switch & Deploy" / "Cancel" buttons
  // data-open="true" attribute controls visibility
}
```

#### Form Validation Patterns

**Inline rename validation (workspace-explorer.js):**
```javascript
async _ctxRename() {
  const input = document.createElement('input');
  input.className = 'ws-inline-rename';
  input.value = currentName;
  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}
```

**Search with debounce (filters.js):**
```javascript
setSearch = (text) => {
  clearTimeout(this.searchTimeout);
  this.searchTimeout = setTimeout(() => {
    this.state.searchText = text.trim();
    this.applyFilters();
  }, 300);
}
```

No centralized form validation library exists. Each module validates inline.

#### State Management Patterns

**1. RingBuffer (state.js)** — Fixed-size circular buffer:
```javascript
class RingBuffer {
  constructor(capacity) { this.capacity = capacity; this.buffer = new Array(capacity); }
  push(item) { /* circular insert */ }
  getBySeq(seq) { /* O(1) lookup by sequence number */ }
}
```

**2. FilterIndex (state.js)** — Inverted index for fast log filtering:
```javascript
class FilterIndex {
  constructor() { this._byLevel = {}; this._byComponent = {}; }
  add(seq, entry) { /* index by level, component, correlationId */ }
  getByLevel(level) { /* returns Set of sequence numbers */ }
}
```

**3. LogViewerState (state.js)** — Central state with computed properties:
```javascript
class LogViewerState {
  constructor() {
    this.logBuffer = new RingBuffer(10000);
    this.activeLevels = new Set(['Message', 'Warning', 'Error']);
    this.autoScroll = true;
    this.paused = false;
  }
}
```

**4. Tab activate/deactivate lifecycle (all tab-*.js):**
```javascript
activate() {
  this._active = true;
  this._signalr.on('topic', this._onEvent);
  document.addEventListener('keydown', this._onKeyDown);
  this._render();
}

deactivate() {
  this._active = false;
  this._signalr.off('topic', this._onEvent);
  document.removeEventListener('keydown', this._onKeyDown);
}
```

#### Step/Wizard-like Patterns

**Onboarding showcase carousel (onboarding.js):**
```javascript
_goToSlide(idx) {
  this._showcaseCards.forEach((card, i) => card.classList.toggle('active', i === idx));
  this._showcaseDots.forEach((dot, i) => dot.classList.toggle('active', i === idx));
  this._showcaseIndex = idx;
}
```

This carousel pattern with dot indicators maps directly to wizard step navigation.

#### Keyboard Navigation

**Global shortcuts bound at document level (sidebar.js):**
```javascript
_onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;  // Skip in inputs
  const views = ['workspace', 'runtime', 'api', 'environment'];
  if (!e.altKey && !e.ctrlKey) {
    const num = parseInt(e.key);
    if (num >= 1 && num <= 4) this.switchView(views[num - 1]);
  }
}
```

**Arrow navigation in command palette:**
```javascript
if (e.key === 'ArrowDown') { this._selectedIndex = Math.min(this._selectedIndex + 1, max); }
if (e.key === 'ArrowUp')   { this._selectedIndex = Math.max(this._selectedIndex - 1, 0); }
if (e.key === 'Enter')     { this._executeIndex(this._selectedIndex); }
```

#### Canvas/SVG Rendering — ❌ NONE

No existing module renders SVG programmatically or uses `<canvas>`. The DAG canvas (C4) is entirely new territory.

#### Drag-and-Drop — ❌ NONE

No existing drag-and-drop implementation. The NodePalette (C5) drag-to-canvas interaction must be built from scratch using `dragstart`, `dragover`, `drop` events (or `pointerdown/move/up` for custom DnD).

#### Undo/Redo — ❌ NONE

No command pattern or history stack exists. UndoRedoManager (C14) is entirely new.

#### Notification/Toast Patterns (Multiple)

| Pattern | Location | Auto-dismiss | Actions |
|---------|----------|-------------|---------|
| `_toast(msg, type)` | workspace-explorer.js | 2.5s | None |
| `_toastConfirm(msg)` | workspace-explorer.js | 5s | Confirm/Cancel → `Promise<boolean>` |
| `showApiToast(call, raidId)` | smart-context.js | 12s | Dismiss button |
| `showAlert(exec, error)` | error-intel.js | Manual | "Jump to error" action |

#### Template Rendering

All modules use template literals for HTML generation:
```javascript
content.innerHTML = `
  <div class="detail-section">
    <h4>Properties</h4>
    <div class="detail-grid">
      <div class="detail-field">
        <label>Time</label>
        <span>${entry.timestamp || 'N/A'}</span>
      </div>
    </div>
  </div>
`;
```

No template engine — raw template literals with `innerHTML` assignment. This is the pattern F16 should follow.

---

### 1.5 CSS Patterns

#### Design Tokens (variables.css)

```css
:root {
  /* Colors */
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #f8f9fb;
  --surface-3: #ebedf0;
  --border: rgba(0,0,0,0.06);
  --border-bright: rgba(0,0,0,0.12);
  --text: #1a1d23;
  --text-dim: #5a6070;
  --text-muted: #8e95a5;
  --accent: #6d5cff;
  --accent-dim: rgba(109,92,255,0.07);

  /* Spacing (4px grid) */
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;
  --space-4: 16px;  --space-5: 20px;  --space-6: 24px;

  /* Z-index scale */
  --z-sidebar: 50;   --z-topbar: 100;   --z-dropdown: 200;
  --z-detail: 200;   --z-command-palette: 300;   --z-toast: 400;

  /* Transitions */
  --transition-fast: 80ms ease-out;
  --transition-normal: 150ms ease-out;

  /* Semantic */
  --status-succeeded: #18a058;
  --status-failed: #e5453b;
}

[data-theme="dark"] {
  --bg: #0c0e14;
  --surface: #14171f;
  --text: #e4e7ed;
  --accent: #8577ff;
}
```

**F16 needs:** `--z-wizard: 500` (above toast, below nothing) for modal overlay.

#### Modal/Overlay Styles

**Command Palette (highest-quality modal reference):**
```css
.command-palette {
  position: fixed;
  inset: 0;
  z-index: var(--z-command-palette);  /* 300 */
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 20vh;
}
.command-palette.hidden { display: none; }

.cp-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.3);
  backdrop-filter: blur(4px);
}

.cp-dialog {
  position: relative;
  width: 520px;
  max-height: 400px;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--space-3);
  box-shadow: 0 16px 48px rgba(0,0,0,0.2);
  animation: cpSlideDown 120ms ease-out;
}

@keyframes cpSlideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

**Deploy Switch Dialog (card-style modal):**
```css
.deploy-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: oklch(0.10 0 0 / 0.55);
  z-index: 1000;
  animation: deploy-dialog-fade 160ms ease-out;
}

.deploy-dialog-card {
  background: var(--surface);
  border-radius: 16px;
  padding: 28px 32px;
  max-width: 440px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.18);
  animation: deploy-dialog-scale 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

**Onboarding Full-Screen Overlay:**
```css
.onboarding-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  flex-direction: column;
  opacity: 1;
  transition: opacity 0.4s ease;
}
.onboarding-overlay.fade-out { opacity: 0; pointer-events: none; }
```

#### Stepper/Progress Styles (deploy.css)

```css
.deploy-steps { display: flex; align-items: flex-start; gap: 0; }
.deploy-step { display: flex; flex-direction: column; align-items: center; flex: 1; }

.deploy-step .step-icon-wrap {
  width: 36px; height: 36px; border-radius: 50%;
  border: 2px solid var(--border-bright);
  transition: all 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.deploy-step .step-connector {
  position: absolute; top: 18px;
  left: calc(50% + 20px); right: calc(-50% + 20px);
  height: 2px; background: var(--border-bright);
}

/* States */
.deploy-step.done .step-icon-wrap { border-color: var(--status-succeeded); background: var(--status-succeeded); }
.deploy-step.active .step-icon-wrap { border-color: var(--accent); animation: deploy-step-glow 1.6s infinite; }
.deploy-step.failed .step-icon-wrap { border-color: var(--status-failed); background: var(--status-failed); }
```

**Directly applicable to F16 wizard step indicator.** Just change step labels.

#### Button Variants

```css
/* Primary */
.deploy-dialog-btn.primary {
  background: var(--accent); color: var(--text-on-accent);
  border-color: var(--accent);
}

/* Ghost */
.deploy-dialog-btn.ghost {
  background: var(--surface); color: var(--text-dim);
}

/* Danger */
.deploy-cancel-btn:hover {
  color: var(--status-failed);
  background: rgba(229, 69, 59, 0.06);
}
```

#### Shimmer/Loading Animations

```css
@keyframes shimmerSweep {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.skel-line { height: 10px; border-radius: 5px; background: var(--skel-base); }
.skel-circle { width: 18px; height: 18px; border-radius: 50%; }
.skel-row { display: flex; gap: 14px; padding: var(--space-3) 14px; }
```

#### Animation Keyframes Inventory

| Keyframe | File | Duration | Purpose |
|----------|------|----------|---------|
| `cpSlideDown` | command-palette.css | 120ms | Modal entrance |
| `deploy-dialog-fade` | deploy.css | 160ms | Backdrop fade-in |
| `deploy-dialog-scale` | deploy.css | 200ms, spring | Card entrance with bounce |
| `deploy-step-glow` | deploy.css | 1.6s, infinite | Active step breathing glow |
| `deploy-step-icon-active` | deploy.css | 1s, infinite | Active step icon scale pulse |
| `deploy-pulse` | deploy.css | — | General accent pulse |
| `shimmerSweep` | shimmer.css | — | Skeleton loading sweep |
| `contentSlideIn` | shimmer.css | 300ms | Content reveal after skeleton |
| `slideUp` | detail.css | 200ms | Panel slide from bottom |
| `toastSlideIn` | smart.css | 200ms | Toast entrance from bottom |

---

## 2. Backend Audit

### 2.1 Server Architecture

**Framework:** Python standard library `http.server` (no Flask, no aiohttp)

**Class hierarchy:**
```python
class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class EdogDevHandler(SimpleHTTPRequestHandler):
    def do_GET(self): ...
    def do_POST(self): ...
    def do_PATCH(self): ...
    def do_DELETE(self): ...
```

**Port:** `5555` (respects `$EDOG_STUDIO_PORT`)

#### Route Handling Pattern

Routes are matched via simple `if/elif` chains in `do_GET()`, `do_POST()`, etc.:

```python
def do_GET(self):
    if self.path == "/api/flt/config":
        self._serve_config()
    elif self.path.startswith("/api/fabric/"):
        self._proxy_fabric("GET")
    elif self.path == "/api/edog/health":
        self._serve_health()
    elif self.path.startswith("/api/mwc/tables"):
        self._serve_mwc_tables()
    elif self.path == "/api/studio/status":
        self._serve_studio_status()
    elif self.path == "/api/command/deploy-stream":
        self._serve_deploy_stream()
    else:
        self.send_error(404)

def do_POST(self):
    if self.path.startswith("/api/fabric/"):
        self._proxy_fabric("POST")
    elif self.path == "/api/command/deploy":
        self._serve_deploy_start()
    elif self.path == "/api/notebook/save":
        self._serve_notebook_save()
    elif self.path == "/api/notebook/run":
        self._serve_notebook_run()
    else:
        self.send_error(404)
```

#### How to Add New F16 Endpoints

**Step 1:** Add route match in `do_GET()` or `do_POST()`:
```python
elif self.path == "/api/templates/list":
    self._serve_template_list()
elif self.path == "/api/templates/save":
    self._serve_template_save()
```

**Step 2:** Implement handler:
```python
def _serve_template_list(self):
    try:
        templates = load_templates()
        self._json_response(200, {"templates": templates})
    except Exception as e:
        self._json_response(500, {"error": str(e)})
```

**Step 3:** Use standard response helpers:
```python
self._json_response(200, {"key": "value"})   # JSON response
self._send_json(200, obj)                     # Alternative JSON
```

#### Proxy Mechanism

```
Browser → /api/fabric/* → dev-server → https://redirect-host/v1/* (+ Bearer token)
Browser → /api/mwc/*    → dev-server → capacity-host (+ MWC token)
Browser → /api/notebook/* → dev-server → backend handler (LRO management)
```

The Fabric API proxy adds Bearer token server-side and handles path mapping:
```python
def _map_path(fabric_path):
    if fabric_path == "/workspaces":
        return "/metadata/workspaces"  # Special case
    return "/v1" + fabric_path         # Default: prepend /v1
```

#### F16-Specific Routes Needed

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/templates/list` | GET | List saved templates |
| `/api/templates/save` | POST | Save template to disk |
| `/api/templates/delete` | POST | Delete template |
| `/api/templates/load` | GET | Load specific template |
| `/api/fabric/capacities` | GET | Proxy to Power BI capacities API (possibly different base URL) |
| `/api/fabric/workspaces/{id}/assignToCapacity` | POST | Already proxied via `/api/fabric/*` pattern |

### 2.2 Config Structure

**File:** `edog-config.json`

```json
{
  "username": "Admin1CBA@FabricFMLV08PPE.ccsctp.net",
  "workspace_id": "1b20c810-b067-4b98-b418-935456c1256f",
  "artifact_id": "b85cb239-82e2-4c62-ae2b-f749433640ce",
  "capacity_id": "19524206-8f8a-4e75-a89c-3df0de08cc7f",
  "flt_repo_path": "C:\\Users\\guptahemant\\newrepo\\workload-fabriclivetable"
}
```

**Template from `config/edog-config.template.json`** (extended schema):
```json
{
  "flt_repo_path": "",
  "feature_management_repo_path": "",
  "capacity_id": "",
  "workspace_id": "",
  "artifact_id": "",
  "username": "",
  "favorites": [],
  "control_port": 5556,
  "ui_port": 5555
}
```

**Where templates fit:** Templates should NOT go in edog-config.json. Use a separate file:
```
edog-templates.json       ← template index
templates/                ← (optional) individual template files
  e-commerce-dag.json
  iot-sensors-dag.json
```

#### File I/O Patterns

**Atomic write (existing pattern):**
```python
def _atomic_write(path: Path, data: str):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix='.tmp')
    try:
        os.write(fd, data.encode('utf-8'))
        os.close(fd)
        os.replace(tmp, str(path))
    except Exception:
        os.close(fd); os.unlink(tmp); raise
```

**Config read (existing pattern):**
```python
config = json.loads(CONFIG_PATH.read_text())
```

**Token cache (existing pattern):**
```python
def _read_cache(path: Path) -> tuple:
    raw = path.read_text().strip()
    decoded = base64.b64decode(raw.encode()).decode()
    expiry_str, token = decoded.split("|", 1)
    return token, float(expiry_str)
```

**Session state (merge pattern):**
```python
existing = json.loads(SESSION_FILE.read_text()) if SESSION_FILE.exists() else {}
existing.update(new_data)
SESSION_FILE.write_text(json.dumps(existing, indent=2))
```

### 2.3 Build System

**Build command:** `python scripts/build-html.py`

The build script:
1. Reads shell HTML from `src/frontend/index.html`
2. Inlines CSS modules (34 files in dependency order)
3. Inlines vendor libs (`lib/signalr.min.js`)
4. Inlines JS modules (34 files in dependency order)
5. Replaces `/* __CSS_MODULES__ */` and `/* __JS_MODULES__ */` placeholders
6. Outputs single file: `src/edog-logs.html`

**To add F16 files:**
1. Create `src/frontend/css/infra-wizard.css` → add to `CSS_MODULES` after `onboarding.css`
2. Create `src/frontend/js/infra-wizard.js` → add to `JS_MODULES` before `main.js`
3. Run `python scripts/build-html.py`

**Makefile targets:** `make build`, `make lint`, `make test`, `make all`

---

## 3. F08 DAG Studio Cross-Reference

### F08 Spec Summary

F08 (DAG Studio) is a **read-only visualization** of the running FLT DAG — showing nodes, edges, execution status, and metadata. It is a Phase 2 (connected mode) feature that renders the live DAG from `getLatestDag()`.

### Shared Patterns with F16 DAG Canvas

| F08 Element | F16 Element | Overlap | Reuse Potential |
|------------|-------------|---------|-----------------|
| DAG node rendering | DagNode (C6) | HIGH | Same visual appearance (rounded rect, icon, label) but F16 adds editable name/type/schema |
| Edge/arrow rendering | ConnectionManager (C7) | HIGH | Same SVG path drawing, but F16 adds interactive drag-to-connect |
| Layout algorithm | AutoLayoutEngine (C13) | HIGH | F08's topological layout applies to F16, but F16 allows manual override |
| Node type icons | DagNode (C6) | MEDIUM | SQL/PySpark distinction applies to both |
| Zoom/pan | DagCanvas (C4) | HIGH | Same viewport transform (translate + scale) |
| Node selection | DagCanvas (C4) | MEDIUM | F08 selects for inspection; F16 selects for editing |
| Status indicators | ExecutionPipeline (C10) | LOW | F08 shows runtime status; F16 shows design-time type |

### What F08 Has That F16 Can Reuse

1. **CSS for DAG visualization** — `src/frontend/css/dag.css` already has DAG-related styles
2. **Node shape styling** — Rounded rectangles with type-specific colors
3. **SVG arrow path routing** — Cubic Bézier curves between nodes
4. **Topological sort utility** — If implemented in F08, directly applicable to F16 cell ordering

### What F16 Needs Beyond F08

| Capability | F08 | F16 | Gap |
|-----------|-----|-----|-----|
| Node editing | Read-only labels | Rename, change type, change schema | Full edit UI |
| Node creation | From API data | Drag from palette | Palette + drop zone |
| Connection creation | From API data | Drag arrow from port | Port rendering + drag connect |
| Node deletion | None | Delete + cascade connections | Delete handler |
| Undo/redo | None | Full command history | Command pattern |
| Auto-layout | Fixed from API | User-triggered rearrange | Force-directed or Sugiyama |
| Zoom/pan | Viewport transform | Same | ✅ Shared |
| Code preview | None | Live code generation | Template engine |

### Recommendation

F16 should reference F08's DAG rendering approach for visual consistency but build its own interactive layer from scratch. The read-only nature of F08 means its code won't have the event handling, state management, or editing capabilities F16 needs.

**Shared utility opportunity:** Extract a `DagRenderer` base class (or utility module) that both F08 and F16 use for:
- SVG node rendering (shape, label, icon)
- SVG edge rendering (Bézier curves)
- Viewport transform (zoom/pan math)
- Topological sort

---

## 4. Reusability Matrix

| # | F16 Component | Existing Code | Reusability | Gap |
|---|--------------|---------------|-------------|-----|
| C1 | **InfraWizardDialog** | Command palette modal + onboarding overlay + deploy switch confirm | **HIGH** | Needs resize/drag (none exist), minimize-to-badge (new), multi-page navigation (carousel pattern exists in onboarding) |
| C2 | **InfraSetupPage** | Workspace-explorer inline create inputs + form validation patterns | **MEDIUM** | Needs capacity dropdown (API method missing), structured form layout (no existing form pages), name collision checking |
| C3 | **ThemeSchemaPage** | No grid-based picker exists; onboarding showcase carousel as partial pattern | **LOW** | Theme card grid (new), multi-select checkbox group (new), theme preview (new) |
| C4 | **DagCanvas** | dag.css exists; no interactive canvas code | **LOW** | SVG viewport with zoom/pan (new), node placement (new), click/drag interactions (new), virtual rendering for 100 nodes (new) |
| C5 | **NodePalette** | No drag-and-drop exists anywhere | **NONE** | Draggable items with preview ghost (entirely new), palette sidebar layout (new) |
| C6 | **DagNode** | F08 DAG node rendering concept (CSS) | **LOW** | Editable node with popover (new), port rendering for connections (new), type/schema dropdowns (new) |
| C7 | **ConnectionManager** | F08 edge rendering concept (CSS) | **LOW** | Interactive arrow creation via drag (new), path routing with collision avoidance (new), arrow selection/deletion (new) |
| C8 | **CodePreviewPanel** | Detail panel slide-up pattern + template literal rendering | **MEDIUM** | Code syntax highlighting (none exists), minimizable panel (new), auto-generated code from DAG state (new) |
| C9 | **ReviewSummary** | Workspace inspector pattern (3-column property display) | **MEDIUM** | Read-only mini DAG (needs DAG renderer), config summary cards (template literal patterns exist) |
| C10 | **ExecutionPipeline** | DeployFlow SSE + stepper CSS + elapsed timer + retry | **HIGH** | Change from SSE to sequential fetch calls, add per-step status, rollback logic (new), skip-completed-steps (new) |
| C11 | **FloatingBadge** | No minimizable UI pattern exists | **NONE** | Fixed-position pill (new), minimize/restore animation (new), background execution tracking (new) |
| C12 | **TemplateManager** | File I/O patterns from backend (_atomic_write, JSON read/write) | **MEDIUM** | Save/load/delete UI (new), template naming dialog (inline input pattern exists), backend endpoints (new routes needed) |
| C13 | **AutoLayoutEngine** | No layout algorithm exists | **NONE** | Topological sort (new), Sugiyama/force-directed positioning (new) |
| C14 | **UndoRedoManager** | No command pattern or history stack | **NONE** | Command pattern (new), state snapshots (new), Ctrl+Z/Y binding (keyboard pattern exists) |

### Summary Counts

| Reusability | Count | Components |
|-------------|-------|------------|
| **HIGH** | 2 | InfraWizardDialog (C1), ExecutionPipeline (C10) |
| **MEDIUM** | 4 | InfraSetupPage (C2), CodePreviewPanel (C8), ReviewSummary (C9), TemplateManager (C12) |
| **LOW** | 4 | ThemeSchemaPage (C3), DagCanvas (C4), DagNode (C6), ConnectionManager (C7) |
| **NONE** | 4 | NodePalette (C5), FloatingBadge (C11), AutoLayoutEngine (C13), UndoRedoManager (C14) |

---

## 5. Technical Recommendations

### 5.1 Integration Strategy

**Wizard trigger:** Add `_openInfraWizard()` method to `WorkspaceExplorer`:
```javascript
_openInfraWizard() {
  const wizard = new InfraWizardDialog(this._api);
  wizard.onComplete = (result) => {
    // Navigate explorer to newly created workspace
    this._selectWorkspace(result.workspace);
    this.loadWorkspaces();
  };
  wizard.open();
}
```

Wire trigger points:
1. Context menu on workspace → "Create Infrastructure..."
2. Empty state CTA → "Create your first test environment"
3. Command palette → "infra" fuzzy match → action

**Module initialization:** Add to `main.js` constructor AFTER `WorkspaceExplorer`:
```javascript
// In EdogLogViewer constructor:
this.infraWizard = null;  // Lazy-created on first open
```

### 5.2 Shared Utility Extraction Opportunities

| Utility | Currently In | Should Extract To | Used By |
|---------|-------------|-------------------|---------|
| `_esc(s)` (HTML escape) | workspace-explorer.js, deploy-flow.js | `shared-utils.js` | All modules |
| Toast notification | workspace-explorer.js | `toast.js` | Explorer, Wizard, any module |
| Modal overlay pattern | command-palette.js, onboarding.js | `modal-base.js` | Palette, Wizard, future dialogs |
| Stepper CSS | deploy.css | Shared via CSS classes | Deploy, Wizard pipeline |
| Elapsed timer | deploy-flow.js | `timer-utils.js` | Deploy, Wizard pipeline |
| Keyboard trap (focus management) | None exists | `focus-trap.js` | Wizard dialog (accessibility) |

### 5.3 New Files to Create

| File | Type | Purpose |
|------|------|---------|
| `src/frontend/js/infra-wizard.js` | JS | Main wizard class (InfraWizardDialog + all page components) |
| `src/frontend/js/dag-engine.js` | JS | DagCanvas + DagNode + ConnectionManager + AutoLayoutEngine |
| `src/frontend/js/undo-manager.js` | JS | UndoRedoManager (generic, could be reused) |
| `src/frontend/js/code-gen.js` | JS | Code generation engine (SQL/PySpark templates) |
| `src/frontend/css/infra-wizard.css` | CSS | All wizard styles |
| `src/frontend/css/dag-canvas.css` | CSS | DAG canvas and node styles |

### 5.4 API Client Extensions

Add to `FabricApiClient`:
```javascript
async listCapacities() {
  // GET /v1.0/myorg/capacities — may need different base URL
}

async assignCapacity(workspaceId, capacityId) {
  return this._fabricPost(`/workspaces/${workspaceId}/assignToCapacity`,
    { capacityId });
}

async createNotebook(workspaceId, name) {
  return this._fabricPost(`/workspaces/${workspaceId}/notebooks`,
    { displayName: name });
}
```

### 5.5 Backend Endpoints

Add 4 new routes to dev-server.py:
```python
# GET /api/templates/list
# POST /api/templates/save
# POST /api/templates/delete
# GET /api/templates/{name}
```

Template storage: `{project_root}/edog-templates.json` — single JSON file with all templates.

### 5.6 Risk Areas

| Risk | Severity | Mitigation |
|------|----------|------------|
| **No existing canvas/SVG rendering** — DAG canvas is entirely new code | HIGH | Start with simplest possible SVG (no virtual rendering), optimize later |
| **No drag-and-drop** — palette-to-canvas interaction | MEDIUM | Use native HTML5 DnD API first, custom pointer events if needed |
| **No undo/redo** — state management complexity | MEDIUM | Use simple state snapshot array (JSON.parse/stringify), optimize later |
| **Capacity listing API** — may use different base URL than Fabric v1 | MEDIUM | Verify `/v1.0/myorg/capacities` works through redirect host |
| **Lakehouse `enableSchemas` flag** — untested in create API | HIGH | Must test before implementation starts (P0.8 task) |
| **Notebook updateDefinition multi-cell format** — undocumented | HIGH | Must reverse-engineer from getDefinition (P0.3 task) |
| **100-node canvas performance** — DOM with 100 SVG groups + edges | MEDIUM | Batch DOM updates, use `requestAnimationFrame`, consider viewport culling |
| **Dialog resize/drag** — no existing implementation | LOW | Use `pointerdown`/`pointermove` on title bar, CSS `resize` for container |

### 5.7 Build Integration

Add to `scripts/build-html.py`:

**CSS_MODULES** — insert after `onboarding.css`:
```python
"css/infra-wizard.css",
"css/dag-canvas.css",
```

**JS_MODULES** — insert before `main.js`:
```python
"js/undo-manager.js",
"js/code-gen.js",
"js/dag-engine.js",
"js/infra-wizard.js",
```

### 5.8 HTML Structure Addition

Add wizard mount point to `src/frontend/index.html` (after command palette):
```html
<!-- INFRA WIZARD (F16) — dynamically created, mount point for z-index stacking -->
<div id="infra-wizard-root"></div>
```

Or create entirely in JS (like onboarding overlay) — no HTML shell needed since the wizard is modal and creates its own DOM tree. **Recommendation:** Create in JS like onboarding. Keeps HTML clean.
