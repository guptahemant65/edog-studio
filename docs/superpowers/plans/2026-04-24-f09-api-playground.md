# F09 API Playground — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully interactive API testing tool inside EDOG Studio that lets developers call Fabric and FLT REST APIs with pre-configured endpoints, template variables, history tracking, and JSON response rendering — all without leaving the dev tool.

**Architecture:** Single-file module (`api-playground.js`) with 6 classes following the orchestrator pattern: `ApiPlayground` (orchestrator) owns `RequestBuilder`, `EndpointCatalog`, `ResponseViewer`, `HistorySaved`, and `JsonTree`. Communication via direct callbacks — no event bus. Lazy init on first sidebar activation. Mock mode simulates responses locally; real mode routes through `/api/playground/proxy`.

**Tech Stack:** Vanilla JS (class syntax, var/function inside methods per codebase convention), CSS tokens from design system, localStorage for history/saved state.

**Spec Reference:** `docs/specs/features/F09-api-playground/` (spec.md, architecture.md, 5 component deep specs, Phantom v2 mockup approved by CEO)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/frontend/css/api-playground.css` | Extend with JSON tree, endpoint catalog, loading states, response tabs |
| Create | `src/frontend/js/api-playground.js` | All 6 classes: JsonTree, EndpointCatalog, RequestBuilder, ResponseViewer, HistorySaved, ApiPlayground |
| Modify | `src/frontend/js/main.js` | Wire ApiPlayground into `_onViewChange` + constructor |
| Modify | `scripts/build-html.py` | Register `js/api-playground.js` in JS_FILES |

**No mock-renderer changes.** The mock-renderer's `_renderApiPlayground()` fires at page load for visual scaffolding. Our module's `activate()` replaces the DOM on first sidebar switch to API view.

## Conventions (Non-Negotiable)

- `class` syntax for class declarations (matches codebase pattern)
- `var` inside methods — NO `const`, NO `let`
- `function(){}` for callbacks — NO arrow functions
- String concatenation — NO template literals
- No optional chaining (`?.`), no emoji — Unicode symbols only (● ▸ ✕ ⋯)
- **Exception:** When modifying existing code that uses const/arrow/template literals, match that file's style

## Dependency Order

```
T1 (CSS) → T2 (Data+JsonTree) → T3 (RequestBuilder+Catalog) → T4 (ResponseViewer+History) → T5 (Orchestrator) → T6 (Integration+Verify)
```

All tasks are sequential — each appends to the same `api-playground.js` file.

---

### Task 1: CSS Extensions

**Files:**
- Modify: `src/frontend/css/api-playground.css` (append after line 122)

**Context:** The existing CSS (122 lines) covers basic layout — `.api-playground`, `.api-main`, `.api-url-row`, `.api-send-btn`, `.api-response-section`, `.api-sidebar`, `.api-headers`. We need to add: JSON tree styles, endpoint catalog dropdown, loading/empty states, response tabs, method pill colors, and cancel button.

- [ ] **Step 1: Append JSON tree styles**

After the existing content (line 122), append:

```css
/* ── JSON Tree ── */
.json-tree { font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.7; }
.json-node { white-space: nowrap; }
.json-node-header { display: flex; align-items: center; cursor: pointer; }
.json-node-header:hover { background: var(--surface-2); border-radius: var(--radius-sm); }
.json-toggle {
  display: inline-block; width: 16px; text-align: center;
  color: var(--text-muted); font-size: 10px; user-select: none; flex-shrink: 0;
}
.json-toggle:hover { color: var(--accent); }
.json-children { padding-left: 16px; }
.json-key { color: var(--accent); }
.json-string { color: var(--status-succeeded); }
.json-number { color: var(--level-warning); }
.json-boolean { color: #c084fc; }
.json-null { color: var(--text-muted); font-style: italic; }
.json-bracket { color: var(--text-muted); }
.json-count { color: var(--text-muted); font-size: 10px; font-style: italic; }
.json-tree-controls {
  display: flex; gap: var(--space-2); padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.json-tree-btn {
  font-size: var(--text-xs); color: var(--text-muted); background: none;
  border: none; cursor: pointer; font-family: var(--font-body);
}
.json-tree-btn:hover { color: var(--accent); }
```

- [ ] **Step 2: Append endpoint catalog dropdown styles**

```css
/* ── Endpoint Catalog Dropdown ── */
.api-catalog-trigger {
  padding: var(--space-1) var(--space-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); background: var(--surface-2);
  color: var(--text-dim); font-size: var(--text-xs); cursor: pointer;
  font-family: var(--font-body); white-space: nowrap;
}
.api-catalog-trigger:hover { border-color: var(--border-bright); color: var(--text); }
.api-catalog-dropdown {
  position: absolute; top: 100%; left: 0; right: 0;
  background: var(--surface); border: 1px solid var(--border-bright);
  border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
  z-index: 100; max-height: 400px; overflow-y: auto;
  margin-top: var(--space-1);
}
.api-catalog-search {
  width: 100%; padding: var(--space-2) var(--space-3);
  border: none; border-bottom: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  font-family: var(--font-mono); font-size: var(--text-xs);
  outline: none;
}
.api-catalog-group { padding: var(--space-1) var(--space-3); }
.api-catalog-group-label {
  font-size: 10px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.08em;
  padding: var(--space-1) 0;
}
.api-catalog-item {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm);
  cursor: pointer; font-size: var(--text-xs);
}
.api-catalog-item:hover { background: var(--surface-2); }
.api-catalog-item .method-pill { font-size: 9px; padding: 0 var(--space-1); min-width: 36px; text-align: center; }
.api-catalog-item-name { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.api-catalog-item-url { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.api-catalog-empty { padding: var(--space-3); text-align: center; color: var(--text-muted); font-size: var(--text-xs); }
```

- [ ] **Step 3: Append loading, empty, response tabs, and method pill color styles**

```css
/* ── Loading & Empty States ── */
.api-loading {
  display: flex; align-items: center; justify-content: center;
  flex: 1; color: var(--text-muted); font-size: var(--text-sm);
  gap: var(--space-2);
}
.api-spinner {
  width: 16px; height: 16px; border: 2px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%;
  animation: api-spin 0.6s linear infinite;
}
@keyframes api-spin { to { transform: rotate(360deg); } }
.api-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; color: var(--text-muted); font-size: var(--text-sm); gap: var(--space-2);
  padding: var(--space-6);
}
.api-empty-hint { font-size: var(--text-xs); color: var(--text-muted); }

/* ── Response Tabs ── */
.api-resp-tabs {
  display: flex; gap: 0; border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.api-resp-tab {
  padding: var(--space-1) var(--space-3); border: none; background: none;
  color: var(--text-muted); font-size: var(--text-xs); font-family: var(--font-body);
  cursor: pointer; border-bottom: 2px solid transparent;
}
.api-resp-tab:hover { color: var(--text); }
.api-resp-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* ── Method Pill Colors ── */
.method-pill {
  padding: 1px var(--space-1); border-radius: 2px;
  font-family: var(--font-mono); font-weight: 600; font-size: 9px;
  text-transform: uppercase; letter-spacing: 0.02em;
}
.method-pill.get { background: rgba(5,150,105,0.15); color: var(--status-succeeded); }
.method-pill.post { background: rgba(59,130,246,0.15); color: #60a5fa; }
.method-pill.put { background: rgba(217,119,6,0.15); color: var(--level-warning); }
.method-pill.patch { background: rgba(168,85,247,0.15); color: #c084fc; }
.method-pill.delete { background: rgba(220,38,38,0.15); color: var(--level-error); }

/* ── Cancel Button ── */
.api-cancel-btn {
  padding: var(--space-1) var(--space-3);
  background: var(--surface-2); color: var(--level-error);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: var(--text-xs); cursor: pointer; display: none;
}
.api-cancel-btn.visible { display: inline-block; }

/* ── Danger Level ── */
.api-danger-caution { color: var(--level-warning); }
.api-danger-destructive { color: var(--level-error); }

/* ── URL Template Variable Highlight ── */
.api-tpl-var {
  background: rgba(217,119,6,0.12); color: var(--level-warning);
  padding: 0 2px; border-radius: 2px;
}

/* ── Request Section Position (for catalog dropdown) ── */
.api-request-section { position: relative; }

/* ── Response Headers Table ── */
.api-resp-headers-table { width: 100%; font-size: var(--text-xs); font-family: var(--font-mono); }
.api-resp-headers-table td {
  padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--border);
  color: var(--text-dim);
}
.api-resp-headers-table td:first-child { color: var(--accent); white-space: nowrap; width: 200px; }
```

- [ ] **Step 4: Verify build**

Run: `python scripts/build-html.py`
Expected: Builds successfully, CSS already registered in build at line 43.

- [ ] **Step 5: Commit**

```
git add src/frontend/css/api-playground.css
git commit -m "feat(F09): extend API Playground CSS with JSON tree, catalog, and state styles"
```

---

### Task 2: Create api-playground.js — Endpoint Data + JsonTree

**Files:**
- Create: `src/frontend/js/api-playground.js`
- Modify: `scripts/build-html.py` (register JS file)

**Context:** This task creates the new JS file with two foundational pieces: (1) the static endpoint catalog data (37 endpoints across 10 groups), and (2) the JsonTree class for rendering collapsible JSON. The JsonTree is the base dependency — ResponseViewer uses it for body display.

**Codebase conventions:** Use `class` keyword for class declarations. Inside methods: `var` (not const/let), `function(){}` (not arrow), string concatenation (not template literals).

- [ ] **Step 1: Create api-playground.js with file header and endpoint catalog data**

Create `src/frontend/js/api-playground.js`:

```javascript
/**
 * F09 — API Playground
 *
 * Interactive REST API testing tool for Fabric and FLT endpoints.
 * 6 classes: JsonTree, EndpointCatalog, RequestBuilder, ResponseViewer,
 * HistorySaved, ApiPlayground (orchestrator).
 *
 * Architecture: docs/specs/features/F09-api-playground/architecture.md
 */

/* ══════════════════════════════════════════════════════════════
 * §0  ENDPOINT CATALOG DATA
 * ══════════════════════════════════════════════════════════════ */

var ENDPOINT_GROUPS = [
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

var ENDPOINT_CATALOG = [
  // ── Workspace (bearer) ──
  { id: 'list-workspaces',   name: 'List Workspaces',   method: 'GET',    urlTemplate: '/v1/workspaces',                                    group: 'workspace', tokenType: 'bearer', bodyTemplate: null, description: 'List all accessible workspaces', dangerLevel: 'safe' },
  { id: 'get-workspace',     name: 'Get Workspace',     method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}',                      group: 'workspace', tokenType: 'bearer', bodyTemplate: null, description: 'Get workspace details by ID', dangerLevel: 'safe' },
  { id: 'create-workspace',  name: 'Create Workspace',  method: 'POST',   urlTemplate: '/v1/workspaces',                                    group: 'workspace', tokenType: 'bearer', bodyTemplate: { displayName: 'New Workspace' }, description: 'Create a new workspace', dangerLevel: 'caution' },
  { id: 'update-workspace',  name: 'Update Workspace',  method: 'PATCH',  urlTemplate: '/v1/workspaces/{workspaceId}',                      group: 'workspace', tokenType: 'bearer', bodyTemplate: { displayName: 'Updated Name' }, description: 'Update workspace properties', dangerLevel: 'caution' },
  { id: 'delete-workspace',  name: 'Delete Workspace',  method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}',                      group: 'workspace', tokenType: 'bearer', bodyTemplate: null, description: 'Permanently delete a workspace', dangerLevel: 'destructive' },

  // ── Items (bearer) ──
  { id: 'list-items',  name: 'List Items',  method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/items',               group: 'items', tokenType: 'bearer', bodyTemplate: null, description: 'List all items in a workspace', dangerLevel: 'safe' },
  { id: 'get-item',    name: 'Get Item',    method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/items/{itemId}',       group: 'items', tokenType: 'bearer', bodyTemplate: null, description: 'Get item details', dangerLevel: 'safe' },
  { id: 'delete-item', name: 'Delete Item', method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}/items/{itemId}',       group: 'items', tokenType: 'bearer', bodyTemplate: null, description: 'Delete an item from workspace', dangerLevel: 'destructive' },

  // ── Lakehouse (bearer) ──
  { id: 'list-lakehouses',  name: 'List Lakehouses',  method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses',                          group: 'lakehouse', tokenType: 'bearer', bodyTemplate: null, description: 'List all lakehouses', dangerLevel: 'safe' },
  { id: 'get-lakehouse',    name: 'Get Lakehouse',    method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}',             group: 'lakehouse', tokenType: 'bearer', bodyTemplate: null, description: 'Get lakehouse details', dangerLevel: 'safe' },
  { id: 'create-lakehouse', name: 'Create Lakehouse', method: 'POST',   urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses',                          group: 'lakehouse', tokenType: 'bearer', bodyTemplate: { displayName: 'New Lakehouse' }, description: 'Create a new lakehouse', dangerLevel: 'caution' },
  { id: 'update-lakehouse', name: 'Update Lakehouse', method: 'PATCH',  urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}',             group: 'lakehouse', tokenType: 'bearer', bodyTemplate: { displayName: 'Updated Lakehouse' }, description: 'Update lakehouse properties', dangerLevel: 'caution' },
  { id: 'delete-lakehouse', name: 'Delete Lakehouse', method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}',             group: 'lakehouse', tokenType: 'bearer', bodyTemplate: null, description: 'Delete a lakehouse', dangerLevel: 'destructive' },

  // ── Tables (mixed) ──
  { id: 'list-tables',      name: 'List Tables',       method: 'GET', urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables', group: 'tables', tokenType: 'bearer', bodyTemplate: null, description: 'List tables in a lakehouse', dangerLevel: 'safe' },
  { id: 'get-table-props',  name: 'Table Properties',  method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/tables/{tableName}/properties',      group: 'tables', tokenType: 'mwc',    bodyTemplate: null, description: 'Get table properties (FLT)', dangerLevel: 'safe' },
  { id: 'get-table-schema', name: 'Table Schema',      method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/tables/{tableName}/schema',          group: 'tables', tokenType: 'mwc',    bodyTemplate: null, description: 'Get table schema (FLT)', dangerLevel: 'safe' },
  { id: 'get-table-stats',  name: 'Table Stats',       method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/tables/{tableName}/stats',           group: 'tables', tokenType: 'mwc',    bodyTemplate: null, description: 'Get table statistics (FLT)', dangerLevel: 'safe' },

  // ── Notebooks (bearer) ──
  { id: 'list-notebooks',  name: 'List Notebooks',  method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/notebooks',                    group: 'notebooks', tokenType: 'bearer', bodyTemplate: null, description: 'List notebooks in workspace', dangerLevel: 'safe' },
  { id: 'get-notebook',    name: 'Get Notebook',    method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/notebooks/{notebookId}',       group: 'notebooks', tokenType: 'bearer', bodyTemplate: null, description: 'Get notebook details', dangerLevel: 'safe' },
  { id: 'create-notebook', name: 'Create Notebook', method: 'POST',   urlTemplate: '/v1/workspaces/{workspaceId}/notebooks',                    group: 'notebooks', tokenType: 'bearer', bodyTemplate: { displayName: 'New Notebook' }, description: 'Create a new notebook', dangerLevel: 'caution' },
  { id: 'delete-notebook', name: 'Delete Notebook', method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}/notebooks/{notebookId}',       group: 'notebooks', tokenType: 'bearer', bodyTemplate: null, description: 'Delete a notebook', dangerLevel: 'destructive' },

  // ── Environment (bearer) ──
  { id: 'get-environment', name: 'Get Environment', method: 'GET', urlTemplate: '/v1/workspaces/{workspaceId}/environments', group: 'environment', tokenType: 'bearer', bodyTemplate: null, description: 'Get workspace environment settings', dangerLevel: 'safe' },

  // ── DAG (mwc) ──
  { id: 'get-latest-dag', name: 'Get Latest DAG',  method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/latest',  group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Get the latest DAG definition', dangerLevel: 'safe' },
  { id: 'run-dag',        name: 'Run DAG',         method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/dag/run',     group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Trigger a DAG execution', dangerLevel: 'caution' },
  { id: 'cancel-dag',     name: 'Cancel DAG',      method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/dag/cancel',  group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Cancel running DAG execution', dangerLevel: 'caution' },
  { id: 'get-dag-status', name: 'DAG Status',      method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/status',  group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Get current DAG execution status', dangerLevel: 'safe' },
  { id: 'get-dag-history',name: 'DAG History',     method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/history', group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'List past DAG executions', dangerLevel: 'safe' },
  { id: 'get-dag-metrics',name: 'DAG Metrics',     method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/metrics', group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Get DAG execution metrics', dangerLevel: 'safe' },

  // ── Execution (mwc) ──
  { id: 'get-exec-status',  name: 'Execution Status',  method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/execution/status',  group: 'execution', tokenType: 'mwc', bodyTemplate: null, description: 'Get current execution status', dangerLevel: 'safe' },
  { id: 'get-exec-logs',    name: 'Execution Logs',    method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/execution/logs',    group: 'execution', tokenType: 'mwc', bodyTemplate: null, description: 'Get execution log entries', dangerLevel: 'safe' },
  { id: 'get-exec-metrics', name: 'Execution Metrics', method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/execution/metrics', group: 'execution', tokenType: 'mwc', bodyTemplate: null, description: 'Get execution performance metrics', dangerLevel: 'safe' },

  // ── Spark (mwc) ──
  { id: 'list-spark-sessions', name: 'Spark Sessions', method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/spark/sessions',       group: 'spark', tokenType: 'mwc', bodyTemplate: null, description: 'List active Spark sessions', dangerLevel: 'safe' },
  { id: 'get-spark-job',       name: 'Spark Job',      method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/spark/jobs/{jobId}',   group: 'spark', tokenType: 'mwc', bodyTemplate: null, description: 'Get Spark job details', dangerLevel: 'safe' },
  { id: 'get-spark-metrics',   name: 'Spark Metrics',  method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/spark/metrics',        group: 'spark', tokenType: 'mwc', bodyTemplate: null, description: 'Get Spark resource metrics', dangerLevel: 'safe' },

  // ── Maintenance (mwc) ──
  { id: 'force-unlock',     name: 'Force Unlock DAG',   method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/maintenance/unlock',   group: 'maintenance', tokenType: 'mwc', bodyTemplate: null, description: 'Force unlock a stuck DAG', dangerLevel: 'destructive' },
  { id: 'list-orphaned',    name: 'List Orphaned',      method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/maintenance/orphaned', group: 'maintenance', tokenType: 'mwc', bodyTemplate: null, description: 'Find orphaned index folders', dangerLevel: 'safe' },
  { id: 'cleanup-orphaned', name: 'Cleanup Orphaned',   method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/maintenance/cleanup',  group: 'maintenance', tokenType: 'mwc', bodyTemplate: null, description: 'Remove orphaned folders', dangerLevel: 'destructive' },
];
```

- [ ] **Step 2: Add JsonTree class below the endpoint data**

Append to `api-playground.js`:

```javascript
/* ══════════════════════════════════════════════════════════════
 * §1  JSON TREE RENDERER
 * ══════════════════════════════════════════════════════════════ */

class JsonTree {
  constructor(container) {
    this._container = container;
    this._data = null;
  }

  render(data) {
    this._data = data;
    this._container.innerHTML = '';
    if (data === undefined || data === null) {
      this._container.textContent = String(data);
      return;
    }
    var root = this._buildNode(data, '', 0);
    this._container.appendChild(root);
  }

  _buildNode(value, key, depth) {
    var el = document.createElement('div');
    el.className = 'json-node';
    var prefix = key !== '' ? '<span class="json-key">"' + this._esc(key) + '"</span>: ' : '';

    if (value === null) {
      el.innerHTML = prefix + '<span class="json-null">null</span>';
      return el;
    }
    var t = typeof value;
    if (t === 'string') {
      el.innerHTML = prefix + '<span class="json-string">"' + this._esc(value) + '"</span>';
      return el;
    }
    if (t === 'number') {
      el.innerHTML = prefix + '<span class="json-number">' + value + '</span>';
      return el;
    }
    if (t === 'boolean') {
      el.innerHTML = prefix + '<span class="json-boolean">' + value + '</span>';
      return el;
    }

    var isArr = Array.isArray(value);
    var keys = isArr ? null : Object.keys(value);
    var count = isArr ? value.length : keys.length;
    var open = isArr ? '[' : '{';
    var close = isArr ? ']' : '}';

    var header = document.createElement('div');
    header.className = 'json-node-header';
    var toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    var expanded = depth < 2;
    toggle.textContent = expanded ? '\u25BE' : '\u25B8';

    var label = document.createElement('span');
    label.innerHTML = prefix
      + '<span class="json-bracket">' + open + '</span>'
      + '<span class="json-count"> ' + count + (count === 1 ? ' item' : ' items') + ' </span>'
      + '<span class="json-bracket">' + close + '</span>';

    header.appendChild(toggle);
    header.appendChild(label);
    el.appendChild(header);

    var children = document.createElement('div');
    children.className = 'json-children';
    if (!expanded) children.style.display = 'none';

    var i;
    if (isArr) {
      for (i = 0; i < value.length; i++) {
        children.appendChild(this._buildNode(value[i], String(i), depth + 1));
      }
    } else {
      for (i = 0; i < keys.length; i++) {
        children.appendChild(this._buildNode(value[keys[i]], keys[i], depth + 1));
      }
    }
    el.appendChild(children);

    toggle.addEventListener('click', function() {
      var isOpen = children.style.display !== 'none';
      children.style.display = isOpen ? 'none' : '';
      toggle.textContent = isOpen ? '\u25B8' : '\u25BE';
    });

    return el;
  }

  expandAll() {
    var nodes = this._container.querySelectorAll('.json-children');
    var toggles = this._container.querySelectorAll('.json-toggle');
    for (var i = 0; i < nodes.length; i++) { nodes[i].style.display = ''; }
    for (var j = 0; j < toggles.length; j++) { toggles[j].textContent = '\u25BE'; }
  }

  collapseAll() {
    var nodes = this._container.querySelectorAll('.json-children');
    var toggles = this._container.querySelectorAll('.json-toggle');
    for (var i = 0; i < nodes.length; i++) { nodes[i].style.display = 'none'; }
    for (var j = 0; j < toggles.length; j++) { toggles[j].textContent = '\u25B8'; }
  }

  _esc(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  destroy() {
    this._container.innerHTML = '';
    this._data = null;
  }
}
```

- [ ] **Step 3: Register in build-html.py**

In `scripts/build-html.py`, find the JS_FILES array. Insert `"js/api-playground.js"` BEFORE `"js/mock-renderer.js"` (the playground module must be defined before mock-renderer references it). The approximate line is around line 111:

```python
    "js/api-playground.js",
    "js/mock-renderer.js",
```

- [ ] **Step 4: Verify build**

Run: `python scripts/build-html.py`
Expected: Builds successfully with new JS file included.

- [ ] **Step 5: Commit**

```
git add src/frontend/js/api-playground.js scripts/build-html.py
git commit -m "feat(F09): add endpoint catalog data and JsonTree renderer"
```

---

### Task 3: RequestBuilder + EndpointCatalog

**Files:**
- Modify: `src/frontend/js/api-playground.js` (append after JsonTree class)

**Context:** Append two classes to api-playground.js.

`EndpointCatalog` renders a searchable dropdown of the 37 pre-configured endpoints grouped by category. When the user selects one, it fires `onSelect(endpoint)`.

`RequestBuilder` renders the request form: method selector, URL input, headers editor, body textarea, Send/Cancel buttons. It owns the EndpointCatalog as a child. Has `onSend(request)` callback. Provides `setRequest(req)` for external population (from history replay or catalog selection). Provides `generateCurl()` for copy-as-cURL.

**Codebase conventions reminder:** `var` inside methods, `function(){}` for callbacks, string concatenation. NO const/let/arrow/template literals.

- [ ] **Step 1: Append EndpointCatalog class**

Append to `api-playground.js`:

```javascript
/* ══════════════════════════════════════════════════════════════
 * §2  ENDPOINT CATALOG
 * ══════════════════════════════════════════════════════════════ */

class EndpointCatalog {
  constructor(container) {
    this._container = container;
    this._isOpen = false;
    this._dropdown = null;
    this._searchInput = null;
    this.onSelect = null;
    this._boundClose = null;
    this._render();
  }

  _render() {
    this._container.innerHTML = '';
    var trigger = document.createElement('button');
    trigger.className = 'api-catalog-trigger';
    trigger.textContent = 'Endpoints \u25BE';
    this._container.appendChild(trigger);

    this._dropdown = document.createElement('div');
    this._dropdown.className = 'api-catalog-dropdown';
    this._dropdown.style.display = 'none';
    this._container.appendChild(this._dropdown);

    var self = this;
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      if (self._isOpen) { self.close(); } else { self.open(); }
    });
  }

  open() {
    this._isOpen = true;
    this._dropdown.style.display = '';
    this._dropdown.innerHTML = '';

    var searchWrap = document.createElement('div');
    this._searchInput = document.createElement('input');
    this._searchInput.className = 'api-catalog-search';
    this._searchInput.placeholder = 'Search endpoints...';
    this._searchInput.setAttribute('type', 'text');
    searchWrap.appendChild(this._searchInput);
    this._dropdown.appendChild(searchWrap);

    var listEl = document.createElement('div');
    this._dropdown.appendChild(listEl);
    this._renderList(listEl, '');

    var self = this;
    this._searchInput.addEventListener('input', function() {
      self._renderList(listEl, self._searchInput.value.toLowerCase());
    });
    this._searchInput.focus();

    this._boundClose = function(e) {
      if (!self._container.contains(e.target)) { self.close(); }
    };
    document.addEventListener('click', this._boundClose);
  }

  close() {
    this._isOpen = false;
    this._dropdown.style.display = 'none';
    if (this._boundClose) {
      document.removeEventListener('click', this._boundClose);
      this._boundClose = null;
    }
  }

  _renderList(listEl, filter) {
    listEl.innerHTML = '';
    var matched = 0;
    for (var g = 0; g < ENDPOINT_GROUPS.length; g++) {
      var group = ENDPOINT_GROUPS[g];
      var endpoints = [];
      for (var i = 0; i < ENDPOINT_CATALOG.length; i++) {
        var ep = ENDPOINT_CATALOG[i];
        if (ep.group !== group.id) continue;
        if (filter && ep.name.toLowerCase().indexOf(filter) === -1
            && ep.urlTemplate.toLowerCase().indexOf(filter) === -1
            && ep.method.toLowerCase().indexOf(filter) === -1) continue;
        endpoints.push(ep);
      }
      if (endpoints.length === 0) continue;

      var groupEl = document.createElement('div');
      groupEl.className = 'api-catalog-group';
      var label = document.createElement('div');
      label.className = 'api-catalog-group-label';
      label.textContent = group.label;
      groupEl.appendChild(label);

      for (var j = 0; j < endpoints.length; j++) {
        var item = this._createItem(endpoints[j]);
        groupEl.appendChild(item);
        matched++;
      }
      listEl.appendChild(groupEl);
    }
    if (matched === 0) {
      var empty = document.createElement('div');
      empty.className = 'api-catalog-empty';
      empty.textContent = 'No endpoints match "' + filter + '"';
      listEl.appendChild(empty);
    }
  }

  _createItem(ep) {
    var item = document.createElement('div');
    item.className = 'api-catalog-item';
    if (ep.dangerLevel === 'destructive') item.classList.add('api-danger-destructive');

    var pill = document.createElement('span');
    pill.className = 'method-pill ' + ep.method.toLowerCase();
    pill.textContent = ep.method;

    var name = document.createElement('span');
    name.className = 'api-catalog-item-name';
    name.textContent = ep.name;

    var url = document.createElement('span');
    url.className = 'api-catalog-item-url';
    url.textContent = ep.urlTemplate;

    item.appendChild(pill);
    item.appendChild(name);
    item.appendChild(url);

    var self = this;
    item.addEventListener('click', function() {
      if (self.onSelect) self.onSelect(ep);
      self.close();
    });
    return item;
  }

  destroy() {
    this.close();
    this._container.innerHTML = '';
    this.onSelect = null;
  }
}
```

- [ ] **Step 2: Append RequestBuilder class**

```javascript
/* ══════════════════════════════════════════════════════════════
 * §3  REQUEST BUILDER
 * ══════════════════════════════════════════════════════════════ */

class RequestBuilder {
  constructor(container) {
    this._container = container;
    this._methodEl = null;
    this._urlEl = null;
    this._bodyEl = null;
    this._bodySection = null;
    this._headersEl = null;
    this._sendBtn = null;
    this._cancelBtn = null;
    this._catalogWrap = null;
    this._catalog = null;
    this.onSend = null;
    this._render();
  }

  _render() {
    this._container.innerHTML = '';

    // URL row
    var urlRow = document.createElement('div');
    urlRow.className = 'api-url-row';

    this._methodEl = document.createElement('select');
    this._methodEl.className = 'api-method-select';
    var methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (var i = 0; i < methods.length; i++) {
      var opt = document.createElement('option');
      opt.value = methods[i];
      opt.textContent = methods[i];
      this._methodEl.appendChild(opt);
    }
    urlRow.appendChild(this._methodEl);

    this._urlEl = document.createElement('input');
    this._urlEl.className = 'api-url-input';
    this._urlEl.placeholder = 'Enter URL or select from endpoints...';
    urlRow.appendChild(this._urlEl);

    this._sendBtn = document.createElement('button');
    this._sendBtn.className = 'api-send-btn';
    this._sendBtn.textContent = 'Send';
    urlRow.appendChild(this._sendBtn);

    this._cancelBtn = document.createElement('button');
    this._cancelBtn.className = 'api-cancel-btn';
    this._cancelBtn.textContent = 'Cancel';
    urlRow.appendChild(this._cancelBtn);

    // cURL copy button
    var curlBtn = document.createElement('button');
    curlBtn.className = 'api-send-btn';
    curlBtn.style.cssText = 'background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border-bright)';
    curlBtn.textContent = 'Copy cURL';
    urlRow.appendChild(curlBtn);

    this._catalogWrap = document.createElement('div');
    this._catalogWrap.style.cssText = 'position:relative;display:inline-block';
    this._catalog = new EndpointCatalog(this._catalogWrap);
    urlRow.appendChild(this._catalogWrap);

    this._container.appendChild(urlRow);

    // Headers section
    var headersSection = document.createElement('div');
    headersSection.className = 'api-body-section';
    var headersLabel = document.createElement('span');
    headersLabel.className = 'api-body-label';
    headersLabel.textContent = 'Headers';
    headersSection.appendChild(headersLabel);

    this._headersEl = document.createElement('div');
    this._headersEl.className = 'api-headers';
    this._addHeaderRow('Authorization', 'Bearer \u25CF\u25CF\u25CF\u25CF', true);
    this._addHeaderRow('Content-Type', 'application/json', false);
    headersSection.appendChild(this._headersEl);

    var addHeaderBtn = document.createElement('button');
    addHeaderBtn.className = 'api-header-add';
    addHeaderBtn.textContent = '+ Add Header';
    headersSection.appendChild(addHeaderBtn);
    this._container.appendChild(headersSection);

    // Body section (hidden for GET/DELETE)
    this._bodySection = document.createElement('div');
    this._bodySection.className = 'api-body-section';
    this._bodySection.style.display = 'none';
    var bodyLabel = document.createElement('span');
    bodyLabel.className = 'api-body-label';
    bodyLabel.textContent = 'Request Body';
    this._bodySection.appendChild(bodyLabel);

    this._bodyEl = document.createElement('textarea');
    this._bodyEl.className = 'api-body-input';
    this._bodyEl.placeholder = '{"key": "value"}';
    this._bodySection.appendChild(this._bodyEl);
    this._container.appendChild(this._bodySection);

    // Wire events
    var self = this;
    this._methodEl.addEventListener('change', function() {
      var needsBody = self._methodEl.value === 'POST'
        || self._methodEl.value === 'PUT'
        || self._methodEl.value === 'PATCH';
      self._bodySection.style.display = needsBody ? '' : 'none';
    });

    this._sendBtn.addEventListener('click', function() {
      if (self.onSend) self.onSend(self.getRequest());
    });

    this._urlEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (self.onSend) self.onSend(self.getRequest());
      }
    });

    addHeaderBtn.addEventListener('click', function() {
      self._addHeaderRow('', '', false);
    });

    curlBtn.addEventListener('click', function() {
      var curl = self.generateCurl();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(curl);
      }
    });
  }

  _addHeaderRow(key, value, readonly) {
    var row = document.createElement('div');
    row.className = 'api-header-row';

    var keyInput = document.createElement('input');
    keyInput.className = 'api-header-key';
    keyInput.value = key;
    keyInput.placeholder = 'Header name';
    if (readonly) keyInput.readOnly = true;

    var valInput = document.createElement('input');
    valInput.className = 'api-header-val';
    valInput.value = value;
    valInput.placeholder = 'Value';
    if (readonly) valInput.readOnly = true;

    var rmBtn = document.createElement('button');
    rmBtn.className = 'api-header-rm';
    rmBtn.textContent = '\u2715';
    if (readonly) { rmBtn.disabled = true; }

    rmBtn.addEventListener('click', function() { row.remove(); });

    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(rmBtn);
    this._headersEl.appendChild(row);
  }

  getRequest() {
    var headers = [];
    var rows = this._headersEl.querySelectorAll('.api-header-row');
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].querySelector('.api-header-key');
      var v = rows[i].querySelector('.api-header-val');
      if (k && v && k.value.trim()) {
        headers.push({ key: k.value.trim(), value: v.value });
      }
    }

    var method = this._methodEl.value;
    var needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

    return {
      method: method,
      url: this._urlEl.value.trim(),
      headers: headers,
      body: needsBody ? this._bodyEl.value : null,
      tokenType: this._detectTokenType(this._urlEl.value)
    };
  }

  setRequest(req) {
    if (req.method) {
      this._methodEl.value = req.method;
      var needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
      this._bodySection.style.display = needsBody ? '' : 'none';
    }
    if (req.url !== undefined) this._urlEl.value = req.url;
    if (req.body !== undefined) this._bodyEl.value = req.body || '';

    if (req.headers) {
      // Keep the Authorization row, replace others
      var authRow = this._headersEl.querySelector('.api-header-row');
      this._headersEl.innerHTML = '';
      if (authRow) this._headersEl.appendChild(authRow);
      for (var i = 0; i < req.headers.length; i++) {
        var h = req.headers[i];
        if (h.key.toLowerCase() === 'authorization') continue;
        this._addHeaderRow(h.key, h.value, false);
      }
    }
  }

  setSending(sending) {
    this._sendBtn.style.display = sending ? 'none' : '';
    this._cancelBtn.classList.toggle('visible', sending);
    this._methodEl.disabled = sending;
    this._urlEl.disabled = sending;
  }

  getCancelBtn() { return this._cancelBtn; }

  generateCurl() {
    var req = this.getRequest();
    var parts = ['curl -X ' + req.method];
    parts.push('"' + req.url + '"');
    for (var i = 0; i < req.headers.length; i++) {
      parts.push('-H "' + req.headers[i].key + ': ' + req.headers[i].value + '"');
    }
    if (req.body) {
      parts.push("-d '" + req.body.replace(/'/g, "'\\''") + "'");
    }
    return parts.join(' \\\n  ');
  }

  _detectTokenType(url) {
    if (url.indexOf('pbidedicated') !== -1 || url.indexOf('{fabricBaseUrl}') !== -1) return 'mwc';
    if (url.indexOf('/v1/') !== -1 || url.indexOf('api.fabric') !== -1) return 'bearer';
    return 'none';
  }

  getCatalog() { return this._catalog; }

  destroy() {
    if (this._catalog) this._catalog.destroy();
    this._container.innerHTML = '';
    this.onSend = null;
  }
}
```

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Successful build.

- [ ] **Step 4: Commit**

```
git add src/frontend/js/api-playground.js
git commit -m "feat(F09): add RequestBuilder and EndpointCatalog classes"
```

---

### Task 4: ResponseViewer + HistorySaved

**Files:**
- Modify: `src/frontend/js/api-playground.js` (append after RequestBuilder class)

**Context:** Append two classes.

`ResponseViewer` shows API response: status badge (colored by 2xx/4xx/5xx), timing, size, response headers table, body as JSON tree (parsed) or raw text. Has tabs: Body | Headers. Uses `JsonTree` (defined in Task 2).

`HistorySaved` manages localStorage for request history (last 50) and saved requests. Renders a sidebar with two sections. History entries show method pill + URL + status. Fires `onReplay(entry)` when user clicks a history item. Security: tokens are NEVER stored — `Authorization` header values are masked before storage.

- [ ] **Step 1: Append ResponseViewer class**

```javascript
/* ══════════════════════════════════════════════════════════════
 * §4  RESPONSE VIEWER
 * ══════════════════════════════════════════════════════════════ */

class ResponseViewer {
  constructor(container) {
    this._container = container;
    this._jsonTree = null;
    this._activeTab = 'body';
    this._lastResponse = null;
    this._showEmpty();
  }

  _showEmpty() {
    this._container.innerHTML = '<div class="api-empty">'
      + '<span style="font-size:24px;opacity:0.3">\u25C7</span>'
      + '<span>Send a request to see the response</span>'
      + '<span class="api-empty-hint">Select an endpoint from the catalog or type a URL</span>'
      + '</div>';
  }

  showLoading() {
    this._container.innerHTML = '<div class="api-loading">'
      + '<div class="api-spinner"></div>'
      + '<span>Sending request...</span>'
      + '</div>';
  }

  showResponse(result) {
    this._lastResponse = result;
    this._container.innerHTML = '';

    // Status header
    var header = document.createElement('div');
    header.className = 'api-response-header';

    var statusClass = 's2xx';
    if (result.status >= 400 && result.status < 500) statusClass = 's4xx';
    if (result.status >= 500) statusClass = 's5xx';
    if (result.status === 0) statusClass = 's5xx';

    var statusEl = document.createElement('span');
    statusEl.className = 'api-response-status ' + statusClass;
    statusEl.textContent = result.status + ' ' + (result.statusText || '');
    header.appendChild(statusEl);

    if (result.duration !== undefined) {
      var timing = document.createElement('span');
      timing.className = 'api-response-timing';
      timing.textContent = result.duration + 'ms';
      header.appendChild(timing);
    }

    if (result.bodySize !== undefined) {
      var size = document.createElement('span');
      size.className = 'api-response-timing';
      size.textContent = this._formatSize(result.bodySize);
      header.appendChild(size);
    }

    this._container.appendChild(header);

    // Tabs
    var tabs = document.createElement('div');
    tabs.className = 'api-resp-tabs';
    var bodyTab = document.createElement('button');
    bodyTab.className = 'api-resp-tab active';
    bodyTab.textContent = 'Body';
    bodyTab.setAttribute('data-tab', 'body');
    var headersTab = document.createElement('button');
    headersTab.className = 'api-resp-tab';
    headersTab.textContent = 'Headers';
    headersTab.setAttribute('data-tab', 'headers');
    tabs.appendChild(bodyTab);
    tabs.appendChild(headersTab);
    this._container.appendChild(tabs);

    // Tab content container
    var content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow:auto';
    this._container.appendChild(content);

    // Render body tab content
    var bodyContent = document.createElement('div');
    bodyContent.setAttribute('data-panel', 'body');
    this._renderBody(bodyContent, result);
    content.appendChild(bodyContent);

    // Render headers tab content
    var headersContent = document.createElement('div');
    headersContent.setAttribute('data-panel', 'headers');
    headersContent.style.display = 'none';
    this._renderHeaders(headersContent, result.headers);
    content.appendChild(headersContent);

    // Tab switching
    var self = this;
    tabs.addEventListener('click', function(e) {
      var tab = e.target.getAttribute('data-tab');
      if (!tab) return;
      var allTabs = tabs.querySelectorAll('.api-resp-tab');
      for (var i = 0; i < allTabs.length; i++) {
        allTabs[i].classList.toggle('active', allTabs[i].getAttribute('data-tab') === tab);
      }
      var panels = content.querySelectorAll('[data-panel]');
      for (var j = 0; j < panels.length; j++) {
        panels[j].style.display = panels[j].getAttribute('data-panel') === tab ? '' : 'none';
      }
    });
  }

  _renderBody(container, result) {
    var bodyStr = result.body || '';

    // JSON tree controls
    var controls = document.createElement('div');
    controls.className = 'json-tree-controls';
    var expandBtn = document.createElement('button');
    expandBtn.className = 'json-tree-btn';
    expandBtn.textContent = 'Expand All';
    var collapseBtn = document.createElement('button');
    collapseBtn.className = 'json-tree-btn';
    collapseBtn.textContent = 'Collapse All';
    var rawBtn = document.createElement('button');
    rawBtn.className = 'json-tree-btn';
    rawBtn.textContent = 'Raw';
    controls.appendChild(expandBtn);
    controls.appendChild(collapseBtn);
    controls.appendChild(rawBtn);
    container.appendChild(controls);

    var treeWrap = document.createElement('div');
    treeWrap.className = 'json-tree';
    treeWrap.style.padding = 'var(--space-3)';
    container.appendChild(treeWrap);

    // Try to parse as JSON
    var parsed = null;
    try { parsed = JSON.parse(bodyStr); } catch (e) { parsed = null; }

    if (parsed !== null) {
      this._jsonTree = new JsonTree(treeWrap);
      this._jsonTree.render(parsed);

      var self = this;
      expandBtn.addEventListener('click', function() { self._jsonTree.expandAll(); });
      collapseBtn.addEventListener('click', function() { self._jsonTree.collapseAll(); });
      rawBtn.addEventListener('click', function() {
        var isRaw = treeWrap.getAttribute('data-raw') === 'true';
        if (isRaw) {
          treeWrap.setAttribute('data-raw', 'false');
          treeWrap.innerHTML = '';
          treeWrap.className = 'json-tree';
          self._jsonTree = new JsonTree(treeWrap);
          self._jsonTree.render(parsed);
          rawBtn.textContent = 'Raw';
        } else {
          treeWrap.setAttribute('data-raw', 'true');
          treeWrap.className = 'api-response-body';
          treeWrap.textContent = JSON.stringify(parsed, null, 2);
          rawBtn.textContent = 'Tree';
        }
      });
    } else {
      treeWrap.className = 'api-response-body';
      treeWrap.textContent = bodyStr;
      expandBtn.style.display = 'none';
      collapseBtn.style.display = 'none';
      rawBtn.style.display = 'none';
    }
  }

  _renderHeaders(container, headers) {
    if (!headers || Object.keys(headers).length === 0) {
      container.innerHTML = '<div class="api-empty" style="padding:var(--space-3)"><span>No response headers</span></div>';
      return;
    }
    var table = document.createElement('table');
    table.className = 'api-resp-headers-table';
    var headerKeys = Object.keys(headers);
    for (var i = 0; i < headerKeys.length; i++) {
      var row = document.createElement('tr');
      var keyCell = document.createElement('td');
      keyCell.textContent = headerKeys[i];
      var valCell = document.createElement('td');
      valCell.textContent = headers[headerKeys[i]];
      row.appendChild(keyCell);
      row.appendChild(valCell);
      table.appendChild(row);
    }
    container.appendChild(table);
  }

  showError(err) {
    this._container.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'api-response-header';
    var status = document.createElement('span');
    status.className = 'api-response-status s5xx';
    status.textContent = 'Error';
    header.appendChild(status);
    this._container.appendChild(header);

    var body = document.createElement('div');
    body.className = 'api-response-body';
    body.textContent = err.message || String(err);
    this._container.appendChild(body);
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  destroy() {
    if (this._jsonTree) this._jsonTree.destroy();
    this._container.innerHTML = '';
    this._lastResponse = null;
  }
}
```

- [ ] **Step 2: Append HistorySaved class**

```javascript
/* ══════════════════════════════════════════════════════════════
 * §5  HISTORY & SAVED REQUESTS
 * ══════════════════════════════════════════════════════════════ */

class HistorySaved {
  constructor(container) {
    this._container = container;
    this._history = [];
    this._saved = [];
    this.onReplay = null;
    this._maxHistory = 50;
    this._storageKeyHistory = 'edog-api-history';
    this._storageKeySaved = 'edog-api-saved';
    this._loadFromStorage();
    this._render();
  }

  _loadFromStorage() {
    try {
      var raw = localStorage.getItem(this._storageKeyHistory);
      this._history = raw ? JSON.parse(raw) : [];
    } catch (e) { this._history = []; }

    try {
      var rawS = localStorage.getItem(this._storageKeySaved);
      this._saved = rawS ? JSON.parse(rawS) : [];
    } catch (e) { this._saved = []; }
  }

  _render() {
    this._container.innerHTML = '';

    // Saved section
    var savedSection = document.createElement('div');
    savedSection.className = 'api-sidebar-section';
    var savedTitle = document.createElement('div');
    savedTitle.className = 'api-sidebar-title';
    savedTitle.textContent = 'Saved Requests';
    savedSection.appendChild(savedTitle);

    var savedList = document.createElement('div');
    savedList.className = 'api-saved-list';
    this._renderSaved(savedList);
    savedSection.appendChild(savedList);
    this._container.appendChild(savedSection);

    // History section
    var historySection = document.createElement('div');
    historySection.className = 'api-sidebar-section';
    var historyTitle = document.createElement('div');
    historyTitle.className = 'api-sidebar-title';
    historyTitle.textContent = 'History';
    historySection.appendChild(historyTitle);

    var historyList = document.createElement('div');
    historyList.className = 'api-history-list';
    this._renderHistory(historyList);
    historySection.appendChild(historyList);
    this._container.appendChild(historySection);
  }

  _renderSaved(listEl) {
    listEl.innerHTML = '';
    if (this._saved.length === 0) {
      var hint = document.createElement('div');
      hint.style.cssText = 'font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-1)';
      hint.textContent = 'No saved requests yet';
      listEl.appendChild(hint);
      return;
    }
    var lastGroup = '';
    for (var i = 0; i < this._saved.length; i++) {
      var entry = this._saved[i];
      if (entry.group && entry.group !== lastGroup) {
        var groupLabel = document.createElement('div');
        groupLabel.className = 'api-sidebar-group-label';
        groupLabel.textContent = entry.group;
        listEl.appendChild(groupLabel);
        lastGroup = entry.group;
      }
      listEl.appendChild(this._createSavedItem(entry, i));
    }
  }

  _createSavedItem(entry, index) {
    var item = document.createElement('div');
    item.className = 'api-saved-item';

    var pill = document.createElement('span');
    pill.className = 'method-pill ' + entry.method.toLowerCase();
    pill.textContent = entry.method;

    var name = document.createElement('span');
    name.textContent = entry.name || entry.url;

    item.appendChild(pill);
    item.appendChild(name);

    var self = this;
    item.addEventListener('click', function() {
      if (self.onReplay) self.onReplay(entry);
    });
    return item;
  }

  _renderHistory(listEl) {
    listEl.innerHTML = '';
    if (this._history.length === 0) {
      var hint = document.createElement('div');
      hint.style.cssText = 'font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-1)';
      hint.textContent = 'No history yet';
      listEl.appendChild(hint);
      return;
    }
    for (var i = 0; i < this._history.length; i++) {
      listEl.appendChild(this._createHistoryItem(this._history[i]));
    }
  }

  _createHistoryItem(entry) {
    var item = document.createElement('div');
    item.className = 'api-history-item';

    var pill = document.createElement('span');
    pill.className = 'method-pill ' + entry.method.toLowerCase();
    pill.textContent = entry.method;

    var url = document.createElement('span');
    var urlText = entry.url || '';
    url.textContent = urlText.length > 30 ? urlText.substring(0, 30) + '...' : urlText;

    item.appendChild(pill);
    item.appendChild(url);

    if (entry.response) {
      var statusEl = document.createElement('span');
      statusEl.className = 'api-history-status';
      var sCls = 's2xx';
      if (entry.response.status >= 400 && entry.response.status < 500) sCls = 's4xx';
      if (entry.response.status >= 500 || entry.response.status === 0) sCls = 's5xx';
      statusEl.className = 'api-history-status status-code ' + sCls;
      statusEl.textContent = entry.response.status;
      item.appendChild(statusEl);
    }

    var self = this;
    item.addEventListener('click', function() {
      if (self.onReplay) self.onReplay(entry);
    });
    return item;
  }

  addHistoryEntry(entry) {
    this._history.unshift(entry);
    while (this._history.length > this._maxHistory) {
      this._history.pop();
    }
    // Size safety: cap at 300KB serialized
    var serialized = JSON.stringify(this._history);
    while (serialized.length > 300000 && this._history.length > 10) {
      this._history.pop();
      serialized = JSON.stringify(this._history);
    }
    try { localStorage.setItem(this._storageKeyHistory, serialized); } catch (e) { /* quota */ }
    var historyList = this._container.querySelector('.api-history-list');
    if (historyList) this._renderHistory(historyList);
  }

  saveRequest(req) {
    var entry = {
      id: this._uuid(),
      name: req.name || req.url,
      group: 'Custom',
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      tokenType: req.tokenType,
      isBuiltIn: false,
      createdAt: new Date().toISOString()
    };
    this._saved.push(entry);
    try { localStorage.setItem(this._storageKeySaved, JSON.stringify(this._saved)); } catch (e) { /* quota */ }
    var savedList = this._container.querySelector('.api-saved-list');
    if (savedList) this._renderSaved(savedList);
  }

  clearHistory() {
    this._history = [];
    try { localStorage.removeItem(this._storageKeyHistory); } catch (e) { /* ignore */ }
    var historyList = this._container.querySelector('.api-history-list');
    if (historyList) this._renderHistory(historyList);
  }

  _uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  destroy() {
    this._container.innerHTML = '';
    this.onReplay = null;
  }
}
```

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Successful build.

- [ ] **Step 4: Commit**

```
git add src/frontend/js/api-playground.js
git commit -m "feat(F09): add ResponseViewer and HistorySaved classes"
```

---

### Task 5: ApiPlayground Orchestrator

**Files:**
- Modify: `src/frontend/js/api-playground.js` (append after HistorySaved class)

**Context:** The orchestrator class. Receives `(viewEl, apiClient, stateManager)` from main.js — same constructor signature as WorkspaceExplorer and RuntimeView. Lazy-initializes on first `activate()`. Builds DOM, creates child components, wires callbacks, handles Send/Cancel lifecycle.

**Mock mode:** When `?mock` is in the URL, `_handleSend` returns simulated responses instead of calling the proxy. This is detected via `new URLSearchParams(window.location.search).has('mock')`.

**Proxy routing:** Real mode POSTs to `/api/playground/proxy` with `{ method, url, headers, body, tokenType }`. The server resolves the token and forwards the request.

**URL resolution:** Before sending, template variables (`{workspaceId}`, etc.) are resolved from `apiClient.getConfig()`. Relative URLs (`/v1/...`) are prefixed with `https://api.fabric.microsoft.com`.

**Token sanitization:** Before storing in history, `Authorization` header values are masked to `Bearer ●●●●`.

- [ ] **Step 1: Append ApiPlayground class**

```javascript
/* ══════════════════════════════════════════════════════════════
 * §6  API PLAYGROUND ORCHESTRATOR
 * ══════════════════════════════════════════════════════════════ */

class ApiPlayground {
  constructor(viewEl, apiClient, stateManager) {
    this._viewEl = viewEl;
    this._apiClient = apiClient;
    this._stateManager = stateManager;
    this._initialized = false;
    this._abortController = null;
    this._isMock = new URLSearchParams(window.location.search).has('mock');

    this._requestBuilder = null;
    this._responseViewer = null;
    this._endpointCatalog = null;
    this._historySaved = null;
  }

  activate() {
    if (!this._initialized) this._init();
    this._viewEl.style.display = '';
  }

  deactivate() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    if (this._requestBuilder && this._requestBuilder.getCatalog()) {
      this._requestBuilder.getCatalog().close();
    }
  }

  _init() {
    this._initialized = true;
    this._buildDOM();
    this._wireEvents();
  }

  _buildDOM() {
    this._viewEl.innerHTML = '';

    var playground = document.createElement('div');
    playground.className = 'api-playground';

    // Main area
    var main = document.createElement('div');
    main.className = 'api-main';

    // Request section
    var requestSection = document.createElement('div');
    requestSection.className = 'api-request-section';
    this._requestBuilder = new RequestBuilder(requestSection);
    main.appendChild(requestSection);

    // Response section
    var responseSection = document.createElement('div');
    responseSection.className = 'api-response-section';
    this._responseViewer = new ResponseViewer(responseSection);
    main.appendChild(responseSection);

    playground.appendChild(main);

    // Sidebar
    var sidebar = document.createElement('div');
    sidebar.className = 'api-sidebar';
    this._historySaved = new HistorySaved(sidebar);
    playground.appendChild(sidebar);

    this._viewEl.appendChild(playground);
  }

  _wireEvents() {
    var self = this;

    // Send request
    this._requestBuilder.onSend = function(request) {
      self._handleSend(request);
    };

    // Endpoint catalog selection → populate builder
    this._requestBuilder.getCatalog().onSelect = function(endpoint) {
      var resolvedUrl = self._resolveUrl(endpoint.urlTemplate);
      var headers = [];
      if (endpoint.tokenType === 'bearer') {
        headers.push({ key: 'Authorization', value: 'Bearer \u25CF\u25CF\u25CF\u25CF' });
      } else if (endpoint.tokenType === 'mwc') {
        headers.push({ key: 'Authorization', value: 'MwcToken \u25CF\u25CF\u25CF\u25CF' });
      }
      headers.push({ key: 'Content-Type', value: 'application/json' });

      self._requestBuilder.setRequest({
        method: endpoint.method,
        url: resolvedUrl,
        headers: headers,
        body: endpoint.bodyTemplate ? JSON.stringify(endpoint.bodyTemplate, null, 2) : ''
      });
    };

    // History/saved replay → populate builder
    this._historySaved.onReplay = function(entry) {
      self._requestBuilder.setRequest({
        method: entry.method,
        url: entry.url,
        headers: entry.headers || [],
        body: entry.body || ''
      });
    };

    // Cancel button
    this._requestBuilder.getCancelBtn().addEventListener('click', function() {
      if (self._abortController) {
        self._abortController.abort();
        self._abortController = null;
      }
      self._requestBuilder.setSending(false);
      self._responseViewer.showError({ message: 'Request cancelled' });
    });
  }

  _handleSend(request) {
    var self = this;

    // Abort previous
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();

    // Resolve URL
    var resolvedUrl = this._resolveUrl(request.url);

    this._requestBuilder.setSending(true);
    this._responseViewer.showLoading();

    if (this._isMock) {
      this._mockSend(request, resolvedUrl);
      return;
    }

    // Build proxy request
    var proxyBody = JSON.stringify({
      method: request.method,
      url: resolvedUrl,
      headers: this._buildProxyHeaders(request.headers),
      body: request.body,
      tokenType: request.tokenType || this._detectTokenType(resolvedUrl)
    });

    var startTime = Date.now();
    fetch('/api/playground/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: proxyBody,
      signal: this._abortController.signal
    }).then(function(resp) {
      return resp.json();
    }).then(function(result) {
      if (!result.duration) result.duration = Date.now() - startTime;
      self._responseViewer.showResponse(result);
      self._historySaved.addHistoryEntry(
        self._sanitizeForHistory(request, resolvedUrl, result)
      );
      self._requestBuilder.setSending(false);
      self._abortController = null;
    }).catch(function(e) {
      if (e.name === 'AbortError') return;
      self._responseViewer.showError(e);
      self._requestBuilder.setSending(false);
      self._abortController = null;
    });
  }

  _mockSend(request, resolvedUrl) {
    var self = this;
    var delay = 100 + Math.floor(Math.random() * 400);
    setTimeout(function() {
      var mockResult = {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'x-ms-request-id': self._uuid()
        },
        body: JSON.stringify({
          status: 'ok',
          message: 'Mock response for ' + request.method + ' ' + request.url,
          timestamp: new Date().toISOString(),
          data: { items: [], count: 0 }
        }),
        duration: delay,
        bodySize: 128
      };
      self._responseViewer.showResponse(mockResult);
      self._historySaved.addHistoryEntry(
        self._sanitizeForHistory(request, resolvedUrl, mockResult)
      );
      self._requestBuilder.setSending(false);
      self._abortController = null;
    }, delay);
  }

  _resolveUrl(template) {
    var config = (this._apiClient && this._apiClient.getConfig) ? this._apiClient.getConfig() : null;
    config = config || {};
    var vars = {
      workspaceId: config.workspaceId || '{workspaceId}',
      lakehouseId: config.lakehouseId || '{lakehouseId}',
      artifactId: config.artifactId || '{artifactId}',
      capacityId: config.capacityId || '{capacityId}',
      fabricBaseUrl: config.fabricBaseUrl || '{fabricBaseUrl}'
    };
    var resolved = template.replace(/\{(\w+)\}/g, function(match, key) {
      return vars[key] || match;
    });

    // Prefix relative URLs
    if (resolved.charAt(0) === '/') {
      resolved = 'https://api.fabric.microsoft.com' + resolved;
    }
    return resolved;
  }

  _buildProxyHeaders(headers) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      // Skip the masked auth header — proxy handles token injection
      if (h.key.toLowerCase() === 'authorization') continue;
      if (h.key.trim()) obj[h.key] = h.value;
    }
    return obj;
  }

  _detectTokenType(url) {
    if (url.indexOf('pbidedicated') !== -1) return 'mwc';
    if (url.indexOf('api.fabric') !== -1) return 'bearer';
    return 'none';
  }

  _sanitizeForHistory(request, resolvedUrl, result) {
    var sanitizedHeaders = [];
    for (var i = 0; i < request.headers.length; i++) {
      var h = request.headers[i];
      if (h.key.toLowerCase() === 'authorization') {
        sanitizedHeaders.push({ key: h.key, value: h.value.replace(/\s.+$/, ' \u25CF\u25CF\u25CF\u25CF') });
      } else {
        sanitizedHeaders.push({ key: h.key, value: h.value });
      }
    }

    return {
      id: this._uuid(),
      method: request.method,
      url: request.url,
      resolvedUrl: resolvedUrl,
      headers: sanitizedHeaders,
      body: request.body,
      tokenType: request.tokenType || 'none',
      response: {
        status: result.status,
        statusText: result.statusText,
        duration: result.duration,
        bodySize: result.bodySize,
        bodyPreview: (result.body || '').substring(0, 500)
      },
      timestamp: new Date().toISOString()
    };
  }

  _uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  destroy() {
    if (this._abortController) this._abortController.abort();
    if (this._requestBuilder) this._requestBuilder.destroy();
    if (this._responseViewer) this._responseViewer.destroy();
    if (this._historySaved) this._historySaved.destroy();
    this._viewEl.innerHTML = '';
    this._initialized = false;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `python scripts/build-html.py`
Expected: Successful build.

- [ ] **Step 3: Commit**

```
git add src/frontend/js/api-playground.js
git commit -m "feat(F09): add ApiPlayground orchestrator with proxy routing and mock mode"
```

---

### Task 6: main.js Integration + Final Verification

**Files:**
- Modify: `src/frontend/js/main.js` (wire ApiPlayground into view system)

**Context:** Wire ApiPlayground into the EdogLogViewer class in main.js. The pattern matches DagStudio — lazy creation on first view switch, activate/deactivate on subsequent switches.

`main.js` uses `const/let/arrow functions` throughout. Match existing style when modifying this file (exception rule from conventions).

**Integration points:**
1. In `_onViewChange()` (line ~793): add `else if (viewId === 'api')` branch that creates and activates ApiPlayground
2. The `#view-api` element already exists in HTML
3. Sidebar already has 'api' as viewId at position 3 (line 299 of sidebar.js)

- [ ] **Step 1: Add ApiPlayground lazy creation to _onViewChange**

In `main.js`, find the `_onViewChange` method (around line 793). Currently it has:

```javascript
  } else if (viewId === 'dag') {
      if (!this.dagStudio) {
        this.dagStudio = new DagStudio(this.apiClient, this.ws, this.autoDetector);
      }
      this.dagStudio.activate();
      if (this.controlPanel) this.controlPanel.deactivate();
    } else {
      if (this.dagStudio) this.dagStudio.deactivate();
      if (this.controlPanel) this.controlPanel.deactivate();
    }
```

Replace the `} else {` block to add API playground handling:

```javascript
    } else if (viewId === 'api') {
      if (!this.apiPlayground) {
        this.apiPlayground = new ApiPlayground(
          document.getElementById('view-api'),
          this.apiClient,
          this.state
        );
      }
      this.apiPlayground.activate();
      if (this.dagStudio) this.dagStudio.deactivate();
      if (this.controlPanel) this.controlPanel.deactivate();
    } else {
      if (this.dagStudio) this.dagStudio.deactivate();
      if (this.apiPlayground) this.apiPlayground.deactivate();
      if (this.controlPanel) this.controlPanel.deactivate();
    }
```

Also add deactivation of apiPlayground in the `dag` and `runtime` branches. In the dag branch, after `this.dagStudio.activate();`, add:
```javascript
      if (this.apiPlayground) this.apiPlayground.deactivate();
```

In the runtime branch (top of `_onViewChange`), add alongside existing deactivations:
```javascript
      if (this.apiPlayground) this.apiPlayground.deactivate();
```

- [ ] **Step 2: Run build**

```
python scripts/build-html.py
```

Expected: Successful build. Output file includes api-playground.js content.

- [ ] **Step 3: Run lint**

```
python -m ruff check scripts/ tests/
```

Expected: No new errors in our files.

- [ ] **Step 4: Run tests**

```
python -m pytest tests/ -q
```

Expected: All existing tests pass (103+).

- [ ] **Step 5: Verify in browser**

Open `http://localhost:5555/?mock` → Click API Playground sidebar icon (icon #3).
Expected:
- Replaces mock-renderer's static HTML with interactive playground
- URL row with method selector, URL input, Send button, Copy cURL, Endpoints dropdown
- Click "Endpoints ▾" → grouped dropdown with search, all 37 endpoints
- Select an endpoint → populates method + URL
- Click Send → loading spinner → mock response with JSON tree
- JSON tree with collapsible nodes, Expand All/Collapse All/Raw toggle
- Body/Headers tabs in response
- History sidebar shows the request
- Click history item → replays into builder
- Copy cURL → clipboard has valid curl command

- [ ] **Step 6: Commit and push**

```
git add src/frontend/js/main.js
git commit -m "feat(F09): integrate ApiPlayground into main.js view system"
git push origin master
```

---

## Summary

| Task | Description | Files | Estimated Lines |
|------|-------------|-------|----------------|
| T1 | CSS extensions | api-playground.css | ~130 appended |
| T2 | Endpoint data + JsonTree | api-playground.js (create) + build-html.py | ~350 |
| T3 | RequestBuilder + EndpointCatalog | api-playground.js (append) | ~320 |
| T4 | ResponseViewer + HistorySaved | api-playground.js (append) | ~350 |
| T5 | ApiPlayground orchestrator | api-playground.js (append) | ~250 |
| T6 | main.js integration + verify | main.js | ~15 |
| **Total** | | | **~1415 lines** |

## Risk Mitigation

1. **Proxy endpoint missing:** The C# backend proxy (`/api/playground/proxy`) may not exist yet. Mock mode works fully. Real mode will show a connection error — gracefully handled by the error flow. The proxy is a separate backend task.

2. **CSS conflicts:** All new classes use the `api-` prefix or `json-` prefix. No risk of collision with existing styles.

3. **Mock-renderer coexistence:** The mock-renderer's `_renderApiPlayground()` fires at page load. Our `ApiPlayground.activate()` replaces the DOM. No conflict — same pattern as DagStudio.

4. **localStorage size:** History capped at 50 entries (~250KB) with size safety eviction. Well within 5MB per-origin limit.

5. **Token security:** Authorization headers masked before localStorage storage. Proxy handles real token injection server-side.
