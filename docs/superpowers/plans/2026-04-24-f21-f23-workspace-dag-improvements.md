# F21 + F23 — DAG Definition Viewer & Workspace Creation Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQL/code definition viewer to DAG Studio node detail panel (F21), add capacity picker to workspace creation and "Create Notebook" context menu action (F23).

**Architecture:** Three focused changes: (1) Extend api-client.js with 3 new API methods, (2) Enhance workspace creation flow with capacity dropdown + notebook creation, (3) Extend DAG node detail panel to fetch and display code definitions. Each task is independent after Task 1 (API methods are prerequisites).

**Tech Stack:** Vanilla JS (var, function(){}, string concatenation), CSS custom properties, Fabric REST APIs.

---

## JS Convention Reminder

All **new code** in existing files must use:
- `var` — NO `const`, NO `let`
- `function(){}` — NO arrow functions
- String concatenation (`+`) — NO template literals
- NO optional chaining (`?.`), NO nullish coalescing (`??`)
- NO emoji — Unicode symbols only (● ▸ ◆ ✕ ⋯)

**Exception:** When adding code _inside_ an existing arrow function callback or block that already uses const/let (e.g., adding a line inside an existing `const commit = async () => {` block), match the surrounding style to avoid jarring inconsistency. Only new standalone functions/methods must use the conventions above.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/frontend/js/api-client.js` | Modify (lines ~209-220) | Add `listCapacities()`, `createNotebook()`, `assignToCapacity()` |
| `src/frontend/js/workspace-explorer.js` | Modify (lines 175-209, 476-540) | Capacity picker in create workspace, "Create Notebook" context menu |
| `src/frontend/js/dag-studio.js` | Modify (lines 762-810) | Code definition section in node detail panel |
| `src/frontend/js/mock-data.js` | Modify (lines 129-138) | Add `codeReference` to DAG nodes, add mock capacities |
| `src/frontend/css/dag.css` | Modify (append) | Code definition panel CSS |
| `src/frontend/css/workspace.css` | Modify (append) | Capacity picker CSS |

---

### Task 1: API Client Extensions

**Files:**
- Modify: `src/frontend/js/api-client.js:209-220` (after `createWorkspace`)

This task adds three new API methods that Tasks 2-4 depend on.

- [ ] **Step 1: Add `listCapacities()` method**

Insert after the `createLakehouse` method (line 220) in `api-client.js`:

```javascript
  /**
   * List available capacities the user has access to.
   * @returns {Promise<{value: Array}>} Array of capacity objects.
   */
  async listCapacities() {
    return this._fabricGet('/capacities');
  }
```

- [ ] **Step 2: Add `createNotebook()` method**

Insert immediately after `listCapacities`:

```javascript
  /**
   * Create a new notebook inside a workspace.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} name - Display name for the new notebook.
   */
  async createNotebook(workspaceId, name) {
    return this._fabricPost('/workspaces/' + workspaceId + '/notebooks', { displayName: name });
  }
```

- [ ] **Step 3: Add `assignToCapacity()` method**

Insert immediately after `createNotebook`:

```javascript
  /**
   * Assign a workspace to a specific capacity.
   * @param {string} workspaceId - Workspace GUID.
   * @param {string} capacityId - Capacity GUID to assign.
   */
  async assignToCapacity(workspaceId, capacityId) {
    return this._fabricPost('/workspaces/' + workspaceId + '/assignToCapacity', { capacityId: capacityId });
  }
```

- [ ] **Step 4: Add `createWorkspace` overload with capacityId**

Modify the existing `createWorkspace` method (line 209-211) to accept an optional `capacityId`:

```javascript
  /**
   * Create a new workspace, optionally in a specific capacity.
   * @param {string} name - Display name for the new workspace.
   * @param {string} [capacityId] - Optional capacity GUID.
   */
  async createWorkspace(name, capacityId) {
    var body = { displayName: name };
    if (capacityId) body.capacityId = capacityId;
    return this._fabricPost('/workspaces', body);
  }
```

- [ ] **Step 5: Build verification**

Run: `python scripts/build-html.py`
Expected: Build succeeds, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/api-client.js
git commit -m "feat(F21/F23): add listCapacities, createNotebook, assignToCapacity API methods"
```

---

### Task 2: Mock Data — Capacities and Code References

**Files:**
- Modify: `src/frontend/js/mock-data.js:129-138` (DAG nodes section)

This task enriches mock data so Tasks 3 and 4 work in mock mode.

- [ ] **Step 1: Add mock capacities data**

Insert a capacities array **before** the `dagNodes` array (around line 128):

```javascript
  // ── Capacities ──
  var capacities = [
    { id: 'cap-001', displayName: 'Dev Capacity F2', sku: 'F2', region: 'West US', state: 'Active' },
    { id: 'cap-002', displayName: 'Staging Capacity F4', sku: 'F4', region: 'East US', state: 'Active' },
    { id: 'cap-003', displayName: 'Production Capacity F64', sku: 'F64', region: 'West US', state: 'Active' },
  ];
```

- [ ] **Step 2: Add `codeReference` to DAG nodes**

Replace the existing `dagNodes` array (lines 129-138) with codeReference fields:

```javascript
  // ── DAG Nodes ──
  var dagNodes = [
    { nodeId: 'n1', name: 'RefreshSalesData', kind: 'sql', parents: [], children: ['n3', 'n4'], status: 'completed', duration: 2300, errorMessage: null, codeReference: { notebookId: 'nb-001', cellIndex: 0 } },
    { nodeId: 'n2', name: 'RefreshCustomerRaw', kind: 'sql', parents: [], children: ['n3'], status: 'completed', duration: 1800, errorMessage: null, codeReference: { notebookId: 'nb-001', cellIndex: 1 } },
    { nodeId: 'n3', name: 'TransformCustomerDim', kind: 'sql', parents: ['n1', 'n2'], children: ['n5', 'n6'], status: 'completed', duration: 4700, errorMessage: null, codeReference: { notebookId: 'nb-002', cellIndex: 0 } },
    { nodeId: 'n4', name: 'AggregateMetrics', kind: 'pyspark', parents: ['n1'], children: ['n7'], status: 'failed', duration: 12400, errorMessage: 'DeltaTableWriteException: Concurrent write conflict', codeReference: { notebookId: 'nb-003', cellIndex: 0 } },
    { nodeId: 'n5', name: 'BuildSalesSummary', kind: 'sql', parents: ['n3'], children: ['n8'], status: 'completed', duration: 3200, errorMessage: null, codeReference: { notebookId: 'nb-002', cellIndex: 1 } },
    { nodeId: 'n6', name: 'RefreshProductJoin', kind: 'sql', parents: ['n3'], children: ['n8'], status: 'completed', duration: 2100, errorMessage: null, codeReference: { notebookId: 'nb-002', cellIndex: 2 } },
    { nodeId: 'n7', name: 'WriteMetricsOutput', kind: 'pyspark', parents: ['n4'], children: [], status: 'skipped', duration: 0, errorMessage: 'Skipped: parent node failed', codeReference: null },
    { nodeId: 'n8', name: 'FinalizeViews', kind: 'sql', parents: ['n5', 'n6'], children: [], status: 'running', duration: null, errorMessage: null, codeReference: { notebookId: 'nb-004', cellIndex: 0 } },
  ];
```

- [ ] **Step 3: Add mock notebook code definitions**

Insert a code definitions lookup object after `dagHistory` (around line 154):

```javascript
  // ── Mock notebook code (keyed by "notebookId:cellIndex") ──
  var mockCodeDefinitions = {
    'nb-001:0': 'CREATE OR REPLACE MATERIALIZED VIEW RefreshSalesData AS\nSELECT\n    s.region,\n    s.product_id,\n    p.product_name,\n    SUM(s.quantity) AS total_qty,\n    SUM(s.amount)   AS total_amount\nFROM sales_transactions s\nJOIN products p ON s.product_id = p.id\nGROUP BY s.region, s.product_id, p.product_name;',
    'nb-001:1': 'CREATE OR REPLACE MATERIALIZED VIEW RefreshCustomerRaw AS\nSELECT\n    customer_id,\n    first_name,\n    last_name,\n    email,\n    signup_date,\n    region\nFROM raw_customers\nWHERE is_active = 1;',
    'nb-002:0': 'CREATE OR REPLACE MATERIALIZED VIEW TransformCustomerDim AS\nSELECT\n    c.customer_id,\n    c.first_name || \' \' || c.last_name AS full_name,\n    c.email,\n    c.region,\n    COUNT(s.order_id)   AS order_count,\n    SUM(s.amount)       AS lifetime_value\nFROM RefreshCustomerRaw c\nLEFT JOIN RefreshSalesData s ON c.customer_id = s.customer_id\nGROUP BY c.customer_id, c.first_name, c.last_name, c.email, c.region;',
    'nb-002:1': 'CREATE OR REPLACE MATERIALIZED VIEW BuildSalesSummary AS\nSELECT\n    region,\n    DATE_TRUNC(\'month\', order_date) AS month,\n    COUNT(*)    AS order_count,\n    SUM(amount) AS revenue\nFROM TransformCustomerDim\nGROUP BY region, DATE_TRUNC(\'month\', order_date);',
    'nb-002:2': 'CREATE OR REPLACE MATERIALIZED VIEW RefreshProductJoin AS\nSELECT\n    p.product_id,\n    p.product_name,\n    p.category,\n    COALESCE(s.total_qty, 0)    AS units_sold,\n    COALESCE(s.total_amount, 0) AS revenue\nFROM products p\nLEFT JOIN RefreshSalesData s ON p.product_id = s.product_id;',
    'nb-003:0': '# PySpark: AggregateMetrics\nfrom pyspark.sql import functions as F\n\ndf = spark.table("TransformCustomerDim")\nagg = (\n    df.groupBy("region")\n      .agg(\n          F.count("customer_id").alias("customer_count"),\n          F.sum("lifetime_value").alias("total_ltv"),\n          F.avg("order_count").alias("avg_orders")\n      )\n)\nagg.write.format("delta").mode("overwrite").saveAsTable("aggregated_metrics")',
    'nb-004:0': 'CREATE OR REPLACE MATERIALIZED VIEW FinalizeViews AS\nSELECT\n    s.region,\n    s.month,\n    s.order_count,\n    s.revenue,\n    p.category,\n    p.units_sold\nFROM BuildSalesSummary s\nJOIN RefreshProductJoin p ON s.region = p.product_id;',
  };
```

- [ ] **Step 4: Export new data from MockEdogData**

Find the return object at the bottom of mock-data.js and add `capacities` and `mockCodeDefinitions`:

```javascript
    capacities,
    mockCodeDefinitions,
```

Add these two lines alongside the existing exports (after `dagHistory,`).

- [ ] **Step 5: Build verification**

Run: `python scripts/build-html.py`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/mock-data.js
git commit -m "feat(F21/F23): add mock capacities, codeReference, and code definitions"
```

---

### Task 3: Workspace Creation with Capacity Picker (F23)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js:476-540` (replace `_showCreateWorkspaceInput`)
- Modify: `src/frontend/css/workspace.css` (append capacity picker styles)

**Context:** The current `_showCreateWorkspaceInput()` shows a simple text input for workspace name only. The improved version shows a two-field inline form: name input + capacity dropdown. After workspace creation, if a capacity is selected, it calls `assignToCapacity` to assign it.

The existing `_showCreateWorkspaceInput()` is at lines 476-540 of `workspace-explorer.js`. The pattern: creates a `.ws-create-row` div, appends an input, inserts at top of tree, handles Enter/Escape/blur events.

The existing workspace data already has `capacityId` per workspace (from dev-server metadata endpoint). Mock mode needs to use `MockEdogData.capacities`.

- [ ] **Step 1: Add capacity picker CSS**

Append to `src/frontend/css/workspace.css`:

```css
/* Capacity picker in workspace creation */
.ws-create-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--accent);
  margin-bottom: var(--space-1);
}
.ws-create-form .ws-create-row {
  padding: 0;
  height: auto;
}
.ws-create-select {
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: inherit;
  font-size: var(--text-sm);
  padding: var(--space-1);
  outline: none;
  flex: 1;
  height: 22px;
  box-sizing: border-box;
  cursor: pointer;
}
.ws-create-select:focus {
  border-color: var(--accent);
}
.ws-create-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 1px;
}
.ws-create-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-top: var(--space-1);
}
```

- [ ] **Step 2: Replace `_showCreateWorkspaceInput()` with capacity-aware version**

Replace the entire `_showCreateWorkspaceInput()` method (lines 476-540) in `workspace-explorer.js` with:

```javascript
  /** Show inline form at top of tree for creating a new workspace with optional capacity. */
  _showCreateWorkspaceInput() {
    if (!this._treeEl) return;
    if (this._treeEl.querySelector('.ws-create-form')) return;

    var self = this;
    var form = document.createElement('div');
    form.className = 'ws-create-form';

    // -- Name row --
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-create-label';
    nameLabel.textContent = 'WORKSPACE NAME';
    form.appendChild(nameLabel);

    var nameRow = document.createElement('div');
    nameRow.className = 'ws-create-row';
    var nameInput = document.createElement('input');
    nameInput.className = 'ws-create-input';
    nameInput.type = 'text';
    nameInput.placeholder = 'Enter workspace name';
    nameInput.setAttribute('aria-label', 'New workspace name');
    nameRow.appendChild(nameInput);
    form.appendChild(nameRow);

    // -- Capacity row --
    var capLabel = document.createElement('div');
    capLabel.className = 'ws-create-label';
    capLabel.textContent = 'CAPACITY (OPTIONAL)';
    form.appendChild(capLabel);

    var capRow = document.createElement('div');
    capRow.className = 'ws-create-row';
    var capSelect = document.createElement('select');
    capSelect.className = 'ws-create-select';
    capSelect.setAttribute('aria-label', 'Select capacity');
    // Default option
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default capacity';
    capSelect.appendChild(defaultOpt);
    capRow.appendChild(capSelect);
    form.appendChild(capRow);

    // Hint
    var hint = document.createElement('div');
    hint.className = 'ws-create-hint';
    hint.textContent = 'Enter \u2193 Tab to select capacity, Enter to create, Esc to cancel';
    form.appendChild(hint);

    this._treeEl.insertBefore(form, this._treeEl.firstChild);
    nameInput.focus();

    // Load capacities async
    self._loadCapacityOptions(capSelect);

    var committed = false;
    var commit = function() {
      var name = nameInput.value.trim();
      var capacityId = capSelect.value || null;
      cleanup();
      if (!name) return;
      self._createWorkspaceWithCapacity(name, capacityId);
    };

    var cleanup = function() {
      if (form.parentNode) form.remove();
    };

    var onKey = function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (document.activeElement === nameInput && nameInput.value.trim()) {
          // If name has value, move focus to capacity select
          capSelect.focus();
        } else if (document.activeElement === capSelect) {
          committed = true;
          commit();
        } else if (nameInput.value.trim()) {
          committed = true;
          commit();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        cleanup();
      }
    };

    nameInput.addEventListener('keydown', onKey);
    capSelect.addEventListener('keydown', onKey);
  }
```

- [ ] **Step 3: Add `_loadCapacityOptions()` helper**

Insert a new method after `_showCreateWorkspaceInput`:

```javascript
  /** Fetch capacities and populate a select element. */
  _loadCapacityOptions(selectEl) {
    var self = this;
    if (this._isMock) {
      var caps = window.MockEdogData ? window.MockEdogData.capacities : [];
      for (var i = 0; i < caps.length; i++) {
        var opt = document.createElement('option');
        opt.value = caps[i].id;
        opt.textContent = caps[i].displayName + ' (' + caps[i].sku + ')';
        selectEl.appendChild(opt);
      }
      return;
    }
    this._api.listCapacities().then(function(resp) {
      var caps = (resp && resp.value) ? resp.value : [];
      for (var i = 0; i < caps.length; i++) {
        var opt = document.createElement('option');
        opt.value = caps[i].id;
        var label = caps[i].displayName || caps[i].id;
        if (caps[i].sku) label = label + ' (' + caps[i].sku + ')';
        opt.textContent = label;
        selectEl.appendChild(opt);
      }
    }).catch(function() {
      // Silently degrade — user can still create with default capacity
    });
  }
```

- [ ] **Step 4: Add `_createWorkspaceWithCapacity()` helper**

Insert after `_loadCapacityOptions`:

```javascript
  /** Create workspace and optionally assign to capacity. */
  _createWorkspaceWithCapacity(name, capacityId) {
    var self = this;
    this._api.createWorkspace(name, capacityId).then(function(result) {
      self._toast('Created workspace "' + name + '"', 'success');
      return self.loadWorkspaces().then(function() {
        if (result && result.id) {
          self._expanded.add(result.id);
          self._renderTree();
        }
      });
    }).catch(function(err) {
      self._toast('Create failed: ' + err.message, 'error');
    });
  }
```

- [ ] **Step 5: Build verification**

Run: `python scripts/build-html.py`
Expected: Build succeeds. Test in browser: click "+", see name input + capacity dropdown.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/css/workspace.css
git commit -m "feat(F23): workspace creation with capacity picker dropdown"
```

---

### Task 4: Create Notebook Context Menu Action (F23)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js:193-201` (context menu), `~543+` (new method)

**Context:** The workspace context menu (lines 193-201) currently has "Create Lakehouse" as the only creation action. We add "Create Notebook" below it. The `_ctxCreateLakehouse()` method (lines 543-645) is the exact pattern to follow: expand workspace, find insertion point, show inline input with dot icon, commit on Enter.

- [ ] **Step 1: Add "Create Notebook" to workspace context menu**

In the context menu builder (line 193-201 area of `workspace-explorer.js`), find the workspace menu section:

```javascript
    } else if (nodeData.isWorkspace) {
      items.push({ label: 'Create Lakehouse', action: () => this._ctxCreateLakehouse() });
```

Add the notebook option right after "Create Lakehouse":

```javascript
    } else if (nodeData.isWorkspace) {
      items.push({ label: 'Create Lakehouse', action: () => this._ctxCreateLakehouse() });
      items.push({ label: 'Create Notebook', action: () => this._ctxCreateNotebook() });
```

- [ ] **Step 2: Add `_ctxCreateNotebook()` method**

Insert a new method after the end of `_ctxCreateLakehouse` (after line 647, after the closing brace). This follows the exact same pattern as `_ctxCreateLakehouse`, but uses a notebook dot class and calls `createNotebook` API:

```javascript
  /** Context menu action: create notebook inside selected workspace. */
  async _ctxCreateNotebook() {
    var t = this._ctxTarget;
    if (!t || !t.isWorkspace) return;

    // Expand workspace so children are visible
    if (!this._expanded.has(t.workspace.id)) {
      await this._toggleWorkspace(t.workspace);
    }

    if (!this._treeEl) return;
    // Find insertion point: after workspace's last child in tree
    var allRows = Array.from(this._treeEl.querySelectorAll('.ws-tree-item'));
    var insertAfter = null;
    var foundWs = false;
    for (var i = 0; i < allRows.length; i++) {
      var row = allRows[i];
      var nameEl = row.querySelector('.ws-tree-name');
      if (nameEl && nameEl.textContent === t.workspace.displayName && !foundWs) {
        foundWs = true;
        insertAfter = row;
        continue;
      }
      if (foundWs) {
        var pl = parseInt(row.style.paddingLeft, 10) || 0;
        if (pl > 12) {
          insertAfter = row;
        } else {
          break;
        }
      }
    }

    // Avoid duplicates
    if (this._treeEl.querySelector('.ws-create-row')) return;

    var createRow = document.createElement('div');
    createRow.className = 'ws-create-row';
    createRow.style.paddingLeft = '28px';

    var dot = document.createElement('span');
    dot.className = 'ws-tree-dot notebook';
    createRow.appendChild(dot);

    var input = document.createElement('input');
    input.className = 'ws-create-input';
    input.type = 'text';
    input.placeholder = 'New notebook name';
    input.setAttribute('aria-label', 'New notebook name');
    createRow.appendChild(input);

    if (insertAfter && insertAfter.nextSibling) {
      this._treeEl.insertBefore(createRow, insertAfter.nextSibling);
    } else {
      this._treeEl.appendChild(createRow);
    }
    input.focus();

    var self = this;
    var committed = false;
    var commit = function() {
      var name = input.value.trim();
      cleanup();
      if (!name) return;
      self._api.createNotebook(t.workspace.id, name).then(function() {
        self._toast('Created notebook "' + name + '"', 'success');
        // Refresh children
        delete self._children[t.workspace.id];
        self._expanded.add(t.workspace.id);
        return self._toggleWorkspace(t.workspace).then(function() {
          if (!self._expanded.has(t.workspace.id)) {
            return self._toggleWorkspace(t.workspace);
          }
        });
      }).catch(function(err) {
        self._toast('Create failed: ' + err.message, 'error');
      });
    };

    var cleanup = function() {
      if (createRow.parentNode) createRow.remove();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
    };

    var onKey = function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        committed = true;
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        cleanup();
      }
    };
    var onBlur = function() {
      if (!committed) {
        committed = true;
        commit();
      }
    };

    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }
```

- [ ] **Step 3: Verify notebook dot CSS exists**

Check if `.ws-tree-dot.notebook` exists in `workspace.css`. If not, add:

```css
.ws-tree-dot.notebook { background: var(--status-info, #5b9bd5); }
```

The tree already renders notebook items with dot classes. If the class exists, skip this step.

- [ ] **Step 4: Build verification**

Run: `python scripts/build-html.py`
Expected: Build succeeds. Right-click workspace → "Create Notebook" appears below "Create Lakehouse".

- [ ] **Step 5: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/css/workspace.css
git commit -m "feat(F23): add Create Notebook context menu action for workspaces"
```

---

### Task 5: DAG Node Definition Viewer (F21)

**Files:**
- Modify: `src/frontend/js/dag-studio.js:762-810` (extend `_renderNodeDetail`)
- Modify: `src/frontend/css/dag.css` (append code panel styles)

**Context:** The `_renderNodeDetail(nodeId)` method (lines 762-810 of `dag-studio.js`) renders the bottom slide-up panel when a DAG node is clicked. Currently shows: name, status, type, node ID, timing, errors. We add a "Definition" section that:

1. Checks if the node has a `codeReference` field
2. Shows a "Load Definition" button if codeReference exists
3. On click: fetches notebook content, extracts the cell, displays as read-only code block
4. In mock mode: looks up from `MockEdogData.mockCodeDefinitions`
5. Caches fetched code to avoid re-fetching on re-select

The DagStudio class needs a reference to the API client and workspace ID for fetching. Check the constructor — it already has `this._api` (set during `init()`). For workspace ID, the DAG is loaded from the current target workspace which is available via `window.edogApp` or can be passed through.

The `_dag` object contains nodes with the structure from `mock-data.js`. Each node may have `codeReference: { notebookId, cellIndex }`.

- [ ] **Step 1: Add code panel CSS**

Append to `src/frontend/css/dag.css`:

```css
/* DAG node definition viewer (F21) */
.dag-detail-divider {
  height: 1px;
  background: var(--border);
  margin: var(--space-3) 0;
}
.dag-detail-section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-bottom: var(--space-2);
}
.dag-code-block {
  background: var(--surface-2, var(--bg));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  tab-size: 2;
}
.dag-code-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.dag-code-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: var(--text-xs);
  padding: 2px 8px;
  cursor: pointer;
  font-family: inherit;
}
.dag-code-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.dag-code-load {
  color: var(--accent);
  border-color: var(--accent);
  cursor: pointer;
}
.dag-code-load:hover {
  background: var(--accent-dim, rgba(109,92,255,0.1));
}
.dag-code-empty {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-style: italic;
}
```

- [ ] **Step 2: Add code definition cache to DagStudio**

In `dag-studio.js`, find the DagStudio constructor (search for `class DagStudio`). Add a cache map to the constructor body:

```javascript
    /** @type {Map<string, string>} Cached code definitions keyed by "notebookId:cellIndex" */
    this._codeCache = new Map();
```

Also confirm `this._api` exists (should already be set from init). The workspace ID for API calls comes from the deploy target. Check if `this._workspaceId` is available. If not, add it:

```javascript
    this._workspaceId = null;
```

And set it during DAG load (in whichever method loads the DAG — look for where `this._dag` is set, e.g., `_loadDag` or similar).

- [ ] **Step 3: Extend `_renderNodeDetail` with definition section**

Replace the `_renderNodeDetail` method (lines 762-810) with an extended version. The existing content stays the same, but before the closing `</div>` of `dag-detail-body`, add the definition section:

Find this block at the end of `_renderNodeDetail` (around line 798):

```javascript
    html += '</div>';
    this._nodeDetail.innerHTML = html;
```

Replace it with:

```javascript
    // ── Definition section (F21) ──
    if (node.codeReference) {
      html += '<div class="dag-detail-divider"></div>';
      html += '<div class="dag-detail-section-title">Definition</div>';
      var cacheKey = node.codeReference.notebookId + ':' + node.codeReference.cellIndex;
      var cached = self._codeCache.get(cacheKey);
      if (cached) {
        html += '<div class="dag-code-block">' + self._escapeHtml(cached) + '</div>';
        html += '<div class="dag-code-actions">';
        html += '<button class="dag-code-btn" id="dagCodeCopy" title="Copy to clipboard">Copy</button>';
        html += '</div>';
      } else {
        html += '<button class="dag-code-btn dag-code-load" id="dagCodeLoad" data-node="' + nodeId + '">Load Definition</button>';
      }
    } else {
      html += '<div class="dag-detail-divider"></div>';
      html += '<div class="dag-detail-section-title">Definition</div>';
      html += '<div class="dag-code-empty">No code reference available</div>';
    }
    html += '</div>';
    this._nodeDetail.innerHTML = html;
```

- [ ] **Step 4: Wire up button event handlers**

After the existing close button handler (around line 809), add handlers for the new buttons:

```javascript
    // Load definition button
    var loadBtn = document.getElementById('dagCodeLoad');
    if (loadBtn) {
      loadBtn.addEventListener('click', function() {
        var nid = this.getAttribute('data-node');
        self._loadNodeDefinition(nid);
      });
    }
    // Copy button
    var copyBtn = document.getElementById('dagCodeCopy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var codeBlock = self._nodeDetail.querySelector('.dag-code-block');
        if (codeBlock && navigator.clipboard) {
          navigator.clipboard.writeText(codeBlock.textContent);
        }
      });
    }
```

- [ ] **Step 5: Add `_loadNodeDefinition()` method**

Insert a new method after `_renderNodeDetail`:

```javascript
  /** Fetch and display code definition for a DAG node. */
  _loadNodeDefinition(nodeId) {
    var node = null;
    for (var i = 0; i < this._dag.nodes.length; i++) {
      if (this._dag.nodes[i].nodeId === nodeId) {
        node = this._dag.nodes[i];
        break;
      }
    }
    if (!node || !node.codeReference) return;

    var ref = node.codeReference;
    var cacheKey = ref.notebookId + ':' + ref.cellIndex;
    var self = this;

    // Show loading state
    var loadBtn = document.getElementById('dagCodeLoad');
    if (loadBtn) {
      loadBtn.textContent = 'Loading...';
      loadBtn.disabled = true;
    }

    var isMock = new URLSearchParams(window.location.search).has('mock');
    if (isMock) {
      // Use mock code definitions
      var mockCode = (window.MockEdogData && window.MockEdogData.mockCodeDefinitions)
        ? window.MockEdogData.mockCodeDefinitions[cacheKey]
        : null;
      if (mockCode) {
        self._codeCache.set(cacheKey, mockCode);
      } else {
        self._codeCache.set(cacheKey, '-- No definition found for cell ' + ref.cellIndex);
      }
      self._renderNodeDetail(nodeId);
      return;
    }

    // Real mode: fetch notebook content
    var wsId = self._workspaceId;
    if (!wsId) {
      // Fallback: try to get from the app
      var app = window.edogApp;
      if (app && app._deployTarget) wsId = app._deployTarget.workspaceId;
    }
    if (!wsId || !self._api) {
      self._codeCache.set(cacheKey, '-- Cannot load: no workspace context');
      self._renderNodeDetail(nodeId);
      return;
    }

    self._api.getNotebookContent(wsId, ref.notebookId).then(function(resp) {
      var content = (resp && resp.content) ? resp.content : '';
      // Extract cell at index — notebook-content.sql uses cell separators
      var cells = content.split(/\n--\s*CELL\s+SEPARATOR\s*\n|\n#{2,}\s/);
      var cellCode = (ref.cellIndex < cells.length) ? cells[ref.cellIndex].trim() : content.trim();
      self._codeCache.set(cacheKey, cellCode);
      self._renderNodeDetail(nodeId);
    }).catch(function(err) {
      self._codeCache.set(cacheKey, '-- Failed to load: ' + err.message);
      self._renderNodeDetail(nodeId);
    });
  }
```

- [ ] **Step 6: Add `_escapeHtml()` helper**

Insert a small utility method (if not already present in the class):

```javascript
  /** Escape HTML entities for safe insertion. */
  _escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }
```

- [ ] **Step 7: Increase node detail panel max-height**

The current `.dag-node-detail` has `max-height: 240px` (dag.css line 116). With the definition section, this is too small. Update to `320px`:

In `dag.css`, change line 116:
```css
  max-height: 320px; overflow-y: auto; padding: var(--space-4);
```

- [ ] **Step 8: Build verification**

Run: `python scripts/build-html.py`
Expected: Build succeeds. In mock mode: click DAG node → detail panel shows "Definition" section with "Load Definition" button → click → shows SQL/code.

- [ ] **Step 9: Commit**

```bash
git add src/frontend/js/dag-studio.js src/frontend/css/dag.css
git commit -m "feat(F21): add DAG node definition viewer with lazy code loading"
```

---

### Task 6: Final Verification and Polish

**Files:**
- All modified files from Tasks 1-5

- [ ] **Step 1: Run full test suite**

Run: `python -m pytest tests/ -q`
Expected: All tests pass (103+ existing tests, no new test files for these frontend-only changes).

- [ ] **Step 2: Run linter**

Run: `python -m ruff check`
Expected: Clean, no warnings.

- [ ] **Step 3: Full build**

Run: `python scripts/build-html.py`
Expected: Build succeeds, output file generated.

- [ ] **Step 4: Verify all changes are committed**

Run: `git status`
Expected: Clean working tree, all changes committed.

- [ ] **Step 5: Check commit history**

Run: `git log --oneline -6`
Expected: 5 commits from this plan, all with `feat(F21)` or `feat(F23)` prefix.
