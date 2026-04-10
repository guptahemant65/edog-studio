# Plan B: Content Panel + Tables Production Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Transform the content panel into a data-dense lakehouse view with enriched tables (rows, size, type), MLV definitions, health status, and proper loading states.

**Architecture:** WorkspaceExplorer._showLakehouseContent gets rewritten. New MLVDefinitions component. batchGetTableDetails auto-called after table list. Capacity metadata joined for region/SKU.

**Tech Stack:** Vanilla JS, shared shimmer.css, MWC proxy endpoints

**Affected Files:**
| File | Owner | Changes |
|------|-------|---------|
| `src/frontend/js/workspace-explorer.js` | Zara | Rewrite `_showLakehouseContent`, new sort/enrich/MLV methods, tree icon overhaul |
| `src/frontend/js/api-client.js` | Zara | Add `batchGetTableDetails`, `getMLVDefinitions`, `getCapacityInfo` methods |
| `src/frontend/js/mock-data.js` | Zara | Add MLV definitions, capacity metadata, table details mock data |
| `src/frontend/css/workspace.css` | Mika | Table zebra/hover/sort styles, MLV cards, header badges, shimmer table cells |
| `scripts/dev-server.py` | Elena | Add `/api/mwc/mlv-definitions` proxy endpoint, `/api/fabric/capacities` |

**Dependencies:** shimmer.css (exists), variables.css (exists), api-client.js (exists)

---

## Scenario Matrix

All content panel rendering MUST handle these scenarios. Every task below references which scenarios it covers.

| Scenario | Condition | What to show |
|----------|-----------|--------------|
| `HAPPY` | Tables loaded, details enriched | Full table with name/type/rows/size, sorted |
| `LOADING` | Fetching table list | Shimmer skeleton table (3 rows × 5 cols) |
| `EMPTY` | Table list returned 0 items | "No tables in this lakehouse" + helpful hint |
| `ERROR` | Table fetch threw (network, 502, etc.) | "Could not load tables" + retry button + error msg |
| `PHASE_1` | Phase=disconnected AND schema-enabled lakehouse (400 from v1) | "Deploy to this lakehouse to view tables" placeholder |
| `PARTIAL` | Table list loaded but batchGetTableDetails still in flight | Table shows name/type immediately, shimmer in rows/size cells |
| `MLV_HAPPY` | Phase=connected, MLV defs loaded | MLV cards grid |
| `MLV_PHASE1` | Phase=disconnected | "Deploy to view MLV definitions" placeholder |
| `MLV_EMPTY` | Connected but 0 MLV definitions | "No MLV definitions found" |
| `MLV_ERROR` | MLV fetch failed | "Could not load MLV definitions" + retry |

---

## Task 1: Rich Lakehouse Header Metadata

**Owner:** Zara (JS) + Mika (CSS)
**Items:** #1 (Rich metadata), #14 (Last modified), #15 (Region + SKU), #10 (Health badge)
**Scenarios:** HAPPY, LOADING
**Files:** `workspace-explorer.js`, `workspace.css`, `api-client.js`, `mock-data.js`

### What changes

The lakehouse content header currently shows: name, truncated ID, "Lakehouse" badge. We add: environment badge, region, last modified time, health dot. Data comes from three sources:
1. **Item metadata** — `lastUpdatedDate` from `/metadata/workspaces/{wsId}/artifacts` (already fetched for tree; needs to be carried to content)
2. **Capacity metadata** — region and SKU from capacity info on the workspace object
3. **Health** — derived from capacity state (green = Active, yellow = throttled)

### Step 1: Add metadata API method to api-client.js

In `src/frontend/js/api-client.js`, add after the `listTablesViaCapacity` method (line 108):

```js
  /**
   * Fetch enriched item metadata including lastUpdatedDate.
   * Uses the metadata artifacts endpoint which has fields v1 items don't.
   * @param {string} workspaceId
   * @returns {Promise<object[]>} Array of artifact metadata objects.
   */
  async listWorkspaceArtifacts(workspaceId) {
    const resp = await fetch(`${this._baseUrl}/metadata/workspaces/${workspaceId}/artifacts`);
    if (!resp.ok) {
      const err = new Error(`Artifact metadata failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }
```

**IMPORTANT:** This path needs a new proxy route in dev-server.py. The existing `_map_path` function prepends `/v1`, but `/metadata/...` paths should NOT get `/v1` prepended. Add this check to `_map_path`:

In `scripts/dev-server.py`, edit `_map_path` (around line 71):

```python
def _map_path(fabric_path: str) -> str:
    # Top-level workspace listing → use metadata endpoint
    if fabric_path == "/workspaces" or fabric_path.startswith("/workspaces?"):
        return fabric_path.replace("/workspaces", "/metadata/workspaces", 1)

    # Metadata paths pass through as-is (no /v1 prefix)
    if fabric_path.startswith("/metadata/"):
        return fabric_path

    # Everything else: forward v1 path as-is
    return "/v1" + fabric_path
```

### Step 2: Add capacity region/SKU helpers

The workspace objects from `/metadata/workspaces` already include `capacityObjectId`. We can derive environment and region from the capacity ID naming convention in PPE:
- Capacity IDs in PPE follow patterns like `cap-ppe-01`
- Region comes from capacity metadata

For now, extract environment from config or capacity naming. Add to `workspace-explorer.js`:

```js
  /**
   * Derive environment label from workspace/capacity context.
   * @param {object} ws - Workspace object with capacityId.
   * @returns {string} Environment label like "F2 PPE" or "F64 Prod".
   */
  _getEnvironmentLabel(ws) {
    const cap = ws.capacityId || '';
    if (cap.includes('ppe') || cap.includes('PPE')) return 'PPE';
    if (cap.includes('prod') || cap.includes('PROD')) return 'Prod';
    if (cap.includes('test') || cap.includes('TEST')) return 'Test';
    return cap ? cap.substring(0, 8) : 'Unknown';
  }

  /**
   * Derive health status from workspace/capacity state.
   * @param {object} ws - Workspace object.
   * @returns {{status: string, color: string}} Health status.
   */
  _getHealthStatus(ws) {
    const state = (ws.state || 'Active').toLowerCase();
    if (state === 'active') return { status: 'Healthy', color: 'var(--status-succeeded)' };
    if (state === 'throttled') return { status: 'Throttled', color: 'var(--level-warning)' };
    return { status: 'Unknown', color: 'var(--text-muted)' };
  }
```

### Step 3: Rewrite header HTML in _showLakehouseContent

Replace the header section of `_showLakehouseContent` (lines 950–955):

**BEFORE:**
```js
    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(lh.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-meta-id" data-copy-id="${this._esc(lh.id)}" title="Click to copy ID">${this._esc(lh.id.substring(0, 12))}...</span>`;
    html += '<span class="ws-meta-badge">Lakehouse</span>';
    html += '</div></div>';
```

**AFTER:**
```js
    const envLabel = this._getEnvironmentLabel(ws);
    const health = this._getHealthStatus(ws);
    const lastMod = lh.lastUpdatedDate ? this._formatDate(lh.lastUpdatedDate) : null;

    let html = '<div class="ws-content-header" style="padding-top:var(--space-4)">';
    html += `<div class="ws-content-name">${this._esc(lh.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-meta-id" data-copy-id="${this._esc(lh.id)}" title="Click to copy full ID">${this._esc(lh.id.substring(0, 12))}\u2026</span>`;
    html += `<span class="ws-meta-badge">${this._esc(envLabel)}</span>`;
    if (ws._region) {
      html += `<span class="ws-meta-region">${this._esc(ws._region)}</span>`;
    }
    if (lastMod) {
      html += `<span class="ws-meta-modified">${lastMod}</span>`;
    }
    html += `<span class="ws-health-dot" style="color:${health.color}" title="${this._esc(health.status)}">● ${this._esc(health.status)}</span>`;
    html += '</div></div>';
```

### Step 4: CSS for new header elements

Add to `src/frontend/css/workspace.css`:

```css
/* Header enrichment */
.ws-meta-region {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.ws-health-dot {
  font-size: var(--text-xs);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
```

### Step 5: Enrich items with metadata artifact data

In `_loadChildren` or `_toggleWorkspace`, after loading children via v1 API, merge `lastUpdatedDate` from metadata artifacts. This avoids adding a new API call per item selection — we fetch once per workspace expansion.

In `_toggleWorkspace`, after `this._children[ws.id] = items;` (around line 811), add:

```js
          // Enrich items with metadata (lastUpdatedDate, etc.)
          try {
            const artifacts = await this._api.listWorkspaceArtifacts(ws.id);
            if (Array.isArray(artifacts)) {
              const artMap = {};
              for (const a of artifacts) {
                artMap[a.objectId] = a;
              }
              for (const item of this._children[ws.id]) {
                const meta = artMap[item.id];
                if (meta) {
                  item.lastUpdatedDate = meta.lastUpdatedDate || null;
                  item.lastModified = meta.lastUpdatedDate || item.lastModified;
                  item.capacityObjectId = meta.capacityObjectId || null;
                }
              }
            }
          } catch { /* metadata enrichment is best-effort */ }
```

### Step 6: Mock data for metadata

In `mock-data.js`, the `_itemsForWorkspace` items already have `lastModified`. Add `capacityObjectId` and `region` to workspace objects:

```js
  // Add to each workspace object:
  // workspaces[0]._region = 'West US 2';
  // workspaces[1]._region = 'East US';
  // etc.
  workspaces[0]._region = 'West US 2';
  workspaces[1]._region = 'East US';
  workspaces[2]._region = 'West US 2';
  workspaces[3]._region = 'Central US';
```

---

## Task 2: Table Columns — Rows and Size

**Owner:** Zara (JS) + Mika (CSS)
**Items:** #2 (Table columns), #13 (Row count + size)
**Scenarios:** HAPPY, PARTIAL
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

Current table has columns: Name, Type, Format. New table: Name, Type, Rows, Size. Format moves to inspector only. Rows and Size come from batchGetTableDetails result (Task 3).

### Step 1: Update table HTML generation

Replace the table rendering in `_showLakehouseContent` (lines 994–1005):

**BEFORE:**
```js
      let tableHtml = '<table class="ws-table"><thead><tr>';
      tableHtml += '<th>Name</th><th>Type</th><th>Format</th>';
      tableHtml += '</tr></thead><tbody>';
      for (const t of tables) {
        tableHtml += `<tr class="ws-table-row" data-table-name="${this._esc(t.name)}">`;
        tableHtml += `<td class="ws-table-name">${this._esc(t.name)}</td>`;
        tableHtml += `<td><span class="ws-type-badge">${this._esc(t.type || 'Delta')}</span></td>`;
        tableHtml += `<td>${this._esc(t.format || 'delta')}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table>';
```

**AFTER:**
```js
      let tableHtml = '<table class="ws-table ws-table--sortable" id="ws-lakehouse-table"><thead><tr>';
      tableHtml += '<th class="ws-th-sortable" data-sort="name">Name</th>';
      tableHtml += '<th class="ws-th-sortable" data-sort="type">Type</th>';
      tableHtml += '<th class="ws-th-sortable ws-th-right" data-sort="rows">Rows</th>';
      tableHtml += '<th class="ws-th-sortable ws-th-right" data-sort="size">Size</th>';
      tableHtml += '</tr></thead><tbody>';
      for (let i = 0; i < tables.length; i++) {
        const t = tables[i];
        const rowCls = i % 2 === 1 ? 'ws-table-row ws-table-row--stripe' : 'ws-table-row';
        tableHtml += `<tr class="${rowCls}" data-table-name="${this._esc(t.name)}">`;
        tableHtml += `<td class="ws-table-name">${this._esc(t.name)}</td>`;
        tableHtml += `<td><span class="ws-type-badge">${this._esc(t.type || 'Delta')}</span></td>`;
        tableHtml += `<td class="ws-table-num" data-field="rows">${t.rowCount != null ? this._formatNumber(t.rowCount) : '<span class="skel-line skel-line--xs" style="display:inline-block;height:8px;width:48px;vertical-align:middle"></span>'}</td>`;
        tableHtml += `<td class="ws-table-num" data-field="size">${t.sizeBytes != null ? this._formatBytes(t.sizeBytes) : '<span class="skel-line skel-line--xs" style="display:inline-block;height:8px;width:56px;vertical-align:middle"></span>'}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody></table>';
```

### Step 2: Add formatting helpers

In `workspace-explorer.js`, add before the `_esc` method:

```js
  /**
   * Format a number with locale-aware comma grouping.
   * @param {number} n
   * @returns {string} e.g. "2,847,593"
   */
  _formatNumber(n) {
    if (n == null) return '\u2014';
    return n.toLocaleString('en-US');
  }

  /**
   * Format bytes into human-readable size.
   * @param {number} bytes
   * @returns {string} e.g. "156 MB", "2.1 GB"
   */
  _formatBytes(bytes) {
    if (bytes == null) return '\u2014';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
  }
```

### Step 3: CSS for right-aligned numeric columns and zebra striping

Add to `workspace.css`:

```css
/* Right-aligned numeric columns */
.ws-th-right { text-align: right; }
.ws-table-num {
  font-family: var(--font-mono);
  color: var(--text-muted);
  text-align: right;
  white-space: nowrap;
}

/* Zebra striping */
.ws-table .ws-table-row--stripe { background: var(--row-stripe); }
.ws-table .ws-table-row--stripe:hover { background: var(--surface-2); }

/* Selected row */
.ws-table .ws-table-row.selected {
  background: var(--accent-dim);
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

/* Inline shimmer in table cells */
.ws-table-num .skel-line { margin: 0; }
```

---

## Task 3: Auto-Load Table Details (batchGetTableDetails)

**Owner:** Zara (JS) + Elena (dev-server proxy)
**Items:** #3 (Auto-load table details), #16 (Shimmer while loading)
**Scenarios:** PARTIAL, HAPPY, ERROR
**Files:** `workspace-explorer.js`, `api-client.js`, `scripts/dev-server.py`

### What changes

After tables load, automatically call `batchGetTableDetails` to get row counts, sizes, and schemas. The shimmer placeholders in rows/size cells (from Task 2) animate while this loads, then get replaced with real data.

### Step 1: Add batchGetTableDetails to api-client.js

The `getTableDetails` method already exists in api-client.js (line 118). However, it takes individual table names. We need a wrapper that handles the common case:

```js
  /**
   * Batch get details for all tables in a lakehouse.
   * Requires MWC token (Phase 2 only).
   * @param {string} workspaceId
   * @param {string} lakehouseId
   * @param {string} capacityId
   * @param {string[]} tableNames
   * @returns {Promise<object[]>} Array of table detail objects.
   */
  async batchGetTableDetails(workspaceId, lakehouseId, capacityId, tableNames) {
    const resp = await fetch('/api/mwc/table-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wsId: workspaceId,
        lhId: lakehouseId,
        capId: capacityId,
        tables: tableNames,
      }),
    });
    if (!resp.ok) {
      const err = new Error(`batchGetTableDetails failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }
```

**Note:** This is functionally identical to the existing `getTableDetails`. We keep the same name/endpoint but the caller pattern changes — it's now called automatically, not on button click.

### Step 2: Auto-enrich after table list loads

In `_showLakehouseContent`, after the table HTML is rendered and row clicks are bound (after line 1016), add the auto-enrich call:

```js
      // Auto-enrich tables with details (rows, size, schema) if we have capacity access
      if (ws.capacityId && tables.length > 0) {
        this._enrichTablesWithDetails(tables, ws, lh);
      }
```

### Step 3: New method _enrichTablesWithDetails

Add to `workspace-explorer.js`:

```js
  /**
   * Fetch batchGetTableDetails and update table rows in-place with row counts and sizes.
   * Shows shimmer in rows/size cells while loading (already placed by Task 2).
   * @param {object[]} tables - Array of table objects (mutated in place).
   * @param {object} ws - Workspace object.
   * @param {object} lh - Lakehouse object.
   */
  async _enrichTablesWithDetails(tables, ws, lh) {
    try {
      const tableNames = tables.map(t => t.name);
      const result = await this._api.batchGetTableDetails(ws.id, lh.id, ws.capacityId, tableNames);

      // Parse result — the operationResults shape has { value: [...] }
      const details = (result && result.value) || [];
      const detailMap = {};
      for (const d of details) {
        if (d.tableName && d.result) {
          detailMap[d.tableName] = d.result;
        }
      }

      // Merge details into table objects
      for (const t of tables) {
        const detail = detailMap[t.name];
        if (detail) {
          t.schema = detail.schema || t.schema;
          t.location = detail.location || t.location;
          t.rowCount = detail.rowCount ?? t.rowCount;
          t.sizeBytes = detail.sizeBytes ?? t.sizeBytes;
          t.type = detail.type || t.type;
        }
      }

      // Update DOM — find each row and replace shimmer with real data
      const tableEl = document.getElementById('ws-lakehouse-table');
      if (!tableEl) return;

      for (const t of tables) {
        const row = tableEl.querySelector(`tr[data-table-name="${CSS.escape(t.name)}"]`);
        if (!row) continue;

        const rowsCell = row.querySelector('td[data-field="rows"]');
        const sizeCell = row.querySelector('td[data-field="size"]');

        if (rowsCell) {
          rowsCell.innerHTML = t.rowCount != null ? this._formatNumber(t.rowCount) : '\u2014';
        }
        if (sizeCell) {
          sizeCell.innerHTML = t.sizeBytes != null ? this._formatBytes(t.sizeBytes) : '\u2014';
        }
      }
    } catch (err) {
      // Silently degrade — shimmer cells become dashes
      console.warn('Table detail enrichment failed:', err.message);
      const tableEl = document.getElementById('ws-lakehouse-table');
      if (!tableEl) return;
      tableEl.querySelectorAll('td[data-field="rows"] .skel-line, td[data-field="size"] .skel-line').forEach(el => {
        el.parentElement.textContent = '\u2014';
      });
    }
  }
```

### Step 4: Mock data support

In `mock-data.js`, the `tablesForLakehouse` array already has `rowCount` and `sizeBytes` fields. In mock mode, tables are returned with this data directly, so shimmer will flash briefly then fill. This is correct behavior.

For `batchGetTableDetails` mock support, add to mock-data.js at the end of the IIFE before the return:

```js
  const tableDetailsResult = {
    value: tablesForLakehouse.map(t => ({
      tableName: t.name,
      schemaName: 'dbo',
      result: {
        schema: [
          { name: 'id', type: 'long', nullable: false },
          { name: 'name', type: 'string', nullable: true },
          { name: 'created_at', type: 'timestamp', nullable: true },
        ],
        type: t.type,
        location: t.location,
        rowCount: t.rowCount,
        sizeBytes: t.sizeBytes,
      },
    })),
  };
```

And expose it: `tableDetailsResult,` in the return statement.

---

## Task 4: Table Count Badge + Section Title

**Owner:** Mika (CSS) + Zara (JS)
**Items:** #4 (Table count badge)
**Scenarios:** HAPPY, EMPTY, LOADING
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

Replace the plain "Tables" section title with "TABLES 7" (uppercase label + count badge).

### Step 1: Update section title in _showLakehouseContent

**BEFORE** (line 964):
```js
    html += '<div class="ws-section"><div class="ws-section-title">Tables</div>';
    html += '<div id="ws-tables-list">Loading tables...</div></div>';
```

**AFTER:**
```js
    html += '<div class="ws-section">';
    html += '<div class="ws-section-title">Tables <span class="ws-section-badge" id="ws-table-count"></span></div>';
    html += '<div id="ws-tables-list"></div></div>';
```

Then after tables load successfully, update the badge:

```js
      // Update table count badge
      const countBadge = document.getElementById('ws-table-count');
      if (countBadge) countBadge.textContent = tables.length;
```

### Step 2: CSS for count badge

Add to `workspace.css`:

```css
.ws-section-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  font-family: var(--font-mono);
  vertical-align: middle;
  margin-left: var(--space-1);
}
```

---

## Task 5: Table Row Styling — Sticky Header

**Owner:** Mika (CSS)
**Items:** #5 (Table row styling)
**Scenarios:** HAPPY
**Files:** `workspace.css`

### What changes

Zebra striping is handled in Task 2. Here we add: sticky header, hover highlight improvement, and selected state refinement.

### Step 1: CSS for sticky header and hover

Add/modify in `workspace.css`:

```css
/* Sortable table wrapper — enable sticky header */
.ws-table--sortable {
  border-collapse: separate;
  border-spacing: 0;
}

.ws-table--sortable thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-2);
}

/* Hover highlight — brighter than zebra stripe */
.ws-table .ws-table-row:hover {
  background: var(--surface-2);
}
.ws-table .ws-table-row:hover .ws-table-name {
  color: var(--accent);
}

/* Smooth row transitions */
.ws-table .ws-table-row td {
  transition: background var(--transition-fast);
}
```

---

## Task 6: Table Sorting

**Owner:** Zara (JS) + Mika (CSS)
**Items:** #6 (Table sorting)
**Scenarios:** HAPPY
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

Click column headers to sort name asc/desc, type asc/desc, rows asc/desc, size asc/desc. Sort state indicated by ▲/▼ indicator. Default: name ascending.

### Step 1: Add sort state tracking

Add to the constructor of WorkspaceExplorer:

```js
    this._tableSort = { field: 'name', dir: 'asc' };
    this._currentTables = []; // reference to current lakehouse tables for re-sorting
```

### Step 2: Sort method

Add to `workspace-explorer.js`:

```js
  /**
   * Sort the current tables array in-place and re-render the table body.
   * @param {string} field - 'name', 'type', 'rows', 'size'
   */
  _sortTables(field) {
    if (this._tableSort.field === field) {
      this._tableSort.dir = this._tableSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      this._tableSort.field = field;
      this._tableSort.dir = 'asc';
    }

    const dir = this._tableSort.dir === 'asc' ? 1 : -1;
    this._currentTables.sort((a, b) => {
      let av, bv;
      switch (field) {
        case 'name':
          return dir * (a.name || '').localeCompare(b.name || '');
        case 'type':
          return dir * (a.type || '').localeCompare(b.type || '');
        case 'rows':
          av = a.rowCount ?? -1;
          bv = b.rowCount ?? -1;
          return dir * (av - bv);
        case 'size':
          av = a.sizeBytes ?? -1;
          bv = b.sizeBytes ?? -1;
          return dir * (av - bv);
        default:
          return 0;
      }
    });

    this._rerenderTableBody();
  }

  /**
   * Re-render just the <tbody> of the lakehouse table without a full content rebuild.
   */
  _rerenderTableBody() {
    const tableEl = document.getElementById('ws-lakehouse-table');
    if (!tableEl) return;

    const tbody = tableEl.querySelector('tbody');
    if (!tbody) return;

    let html = '';
    for (let i = 0; i < this._currentTables.length; i++) {
      const t = this._currentTables[i];
      const rowCls = i % 2 === 1 ? 'ws-table-row ws-table-row--stripe' : 'ws-table-row';
      html += `<tr class="${rowCls}" data-table-name="${this._esc(t.name)}">`;
      html += `<td class="ws-table-name">${this._esc(t.name)}</td>`;
      html += `<td><span class="ws-type-badge">${this._esc(t.type || 'Delta')}</span></td>`;
      html += `<td class="ws-table-num" data-field="rows">${t.rowCount != null ? this._formatNumber(t.rowCount) : '\u2014'}</td>`;
      html += `<td class="ws-table-num" data-field="size">${t.sizeBytes != null ? this._formatBytes(t.sizeBytes) : '\u2014'}</td>`;
      html += '</tr>';
    }
    tbody.innerHTML = html;

    // Update sort indicators in header
    tableEl.querySelectorAll('.ws-th-sortable').forEach(th => {
      th.classList.remove('ws-sort-asc', 'ws-sort-desc');
      if (th.dataset.sort === this._tableSort.field) {
        th.classList.add(this._tableSort.dir === 'asc' ? 'ws-sort-asc' : 'ws-sort-desc');
      }
    });

    // Re-bind row clicks
    this._bindTableRowClicks(tableEl);
  }
```

### Step 3: Bind sort click handlers

After rendering the table in `_showLakehouseContent`, add:

```js
      // Store reference for sorting
      this._currentTables = tables;

      // Bind sort headers
      tablesEl.querySelectorAll('.ws-th-sortable').forEach(th => {
        th.addEventListener('click', () => {
          this._sortTables(th.dataset.sort);
        });
      });
```

### Step 4: Extract table row click binding

Extract the row click binding into a reusable method (called after sort re-renders):

```js
  /**
   * Bind click handlers on table rows for inspector display.
   * @param {HTMLElement} tableEl - The table container element.
   */
  _bindTableRowClicks(tableEl) {
    if (!tableEl) return;
    tableEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
      row.addEventListener('click', () => {
        tableEl.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        const tbl = this._currentTables.find(x => x.name === row.dataset.tableName);
        if (tbl) this._showTableInspector(tbl);
      });
    });
  }
```

Replace the existing inline row click binding (lines 1008–1016) with `this._bindTableRowClicks(tablesEl);`

### Step 5: CSS for sort indicators

Add to `workspace.css`:

```css
/* Sortable column headers */
.ws-th-sortable {
  cursor: pointer;
  user-select: none;
  position: relative;
  padding-right: calc(var(--space-3) + 10px) !important;
  transition: color var(--transition-fast);
}
.ws-th-sortable:hover {
  color: var(--text);
}
.ws-th-sortable::after {
  content: '\25B8'; /* ▸ neutral indicator */
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%) rotate(0deg);
  font-size: 8px;
  opacity: 0.3;
  transition: all var(--transition-fast);
}
.ws-th-sortable.ws-sort-asc::after {
  content: '\u25B4'; /* ▴ up */
  opacity: 1;
  color: var(--accent);
}
.ws-th-sortable.ws-sort-desc::after {
  content: '\u25BE'; /* ▾ down */
  opacity: 1;
  color: var(--accent);
}
```

---

## Task 7: Table Row Click — Visual Feedback

**Owner:** Zara (JS) + Mika (CSS)
**Items:** #7 (Table row click)
**Scenarios:** HAPPY
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

Currently clicking a table row calls `_showTableInspector` but the selected state is fragile. Task 2's CSS already adds `.selected` styling. Task 6 extracts the binding. This task ensures the selected row survives re-sorts and enrichment updates.

### Step 1: Track selected table name

Add to constructor:
```js
    this._selectedTableName = null;
```

### Step 2: Update _bindTableRowClicks

In the extracted `_bindTableRowClicks` method:

```js
  _bindTableRowClicks(tableEl) {
    if (!tableEl) return;
    tableEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
      // Restore selected state after re-render
      if (row.dataset.tableName === this._selectedTableName) {
        row.classList.add('selected');
      }
      row.addEventListener('click', () => {
        this._selectedTableName = row.dataset.tableName;
        tableEl.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        const tbl = this._currentTables.find(x => x.name === row.dataset.tableName);
        if (tbl) this._showTableInspector(tbl);
      });
    });
  }
```

### Step 3: Clear selection on lakehouse switch

In `_selectItem`:
```js
    this._selectedTableName = null;
```

---

## Task 8: MLV Definitions Section

**Owner:** Zara (JS) + Mika (CSS) + Dev (FLT API guidance)
**Items:** #8 (MLV cards)
**Scenarios:** MLV_HAPPY, MLV_PHASE1, MLV_EMPTY, MLV_ERROR
**Files:** `workspace-explorer.js`, `api-client.js`, `mock-data.js`, `workspace.css`

### What changes

Below the Tables section, show MLV (Materialized Lake View) definitions. Phase 1: placeholder. Phase 2: cards grid showing name, type, refresh mode, last run, status.

### Step 1: Add MLV definitions API method

In `api-client.js`, add:

```js
  /**
   * Fetch MLV execution definitions for a lakehouse (Phase 2 only).
   * @param {string} workspaceId
   * @param {string} lakehouseId
   * @param {string} capacityId
   * @returns {Promise<object[]>} Array of MLV definition objects.
   */
  async getMLVDefinitions(workspaceId, lakehouseId, capacityId) {
    const resp = await fetch('/api/mwc/mlv-definitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wsId: workspaceId,
        lhId: lakehouseId,
        capId: capacityId,
      }),
    });
    if (!resp.ok) {
      const err = new Error(`MLV definitions failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }
```

### Step 2: Add MLV proxy endpoint to dev-server.py

In `dev-server.py`, add to `do_POST` (after line 211):

```python
        elif self.path == "/api/mwc/mlv-definitions":
            self._serve_mwc_mlv_definitions()
```

Add the handler method:

```python
    def _serve_mwc_mlv_definitions(self):
        """POST /api/mwc/mlv-definitions — list MLV execution definitions."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        lh_id = body.get("lhId")
        cap_id = body.get("capId")

        if not all([ws_id, lh_id, cap_id]):
            self._json_response(400, {"error": "missing_params"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token"})
            return

        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
        except Exception as e:
            self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
            return

        base = _capacity_base_path(cap_id, ws_id)
        url = f"{host}{base}/artifacts/Lakehouse/{lh_id}/mlvExecutionDefinitions"
        mwc_headers = {
            "Authorization": f"MwcToken {token}",
            "x-ms-workload-resource-moniker": lh_id,
            "Content-Type": "application/json",
        }
        print(f"  [MWC] GET mlvExecutionDefinitions")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, headers=mwc_headers, method="GET")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self._json_response(502, {"error": "mwc_request_error", "message": str(e)})
```

### Step 3: Add MLV section to _showLakehouseContent

After the Tables section closing `</div>`, add:

```js
    // MLV Definitions section
    html += '<div class="ws-section">';
    html += '<div class="ws-section-title">MLV Definitions <span class="ws-section-badge" id="ws-mlv-count"></span></div>';
    html += '<div id="ws-mlv-list"></div></div>';
```

### Step 4: Load MLV definitions after content renders

After the tables loading try/catch block, add:

```js
    // Load MLV definitions
    this._loadMLVDefinitions(ws, lh);
```

### Step 5: MLV loading method

```js
  /**
   * Load and render MLV execution definitions.
   * Phase 1: show placeholder. Phase 2: fetch and render cards.
   */
  async _loadMLVDefinitions(ws, lh) {
    const mlvEl = document.getElementById('ws-mlv-list');
    if (!mlvEl) return;

    const phase = this._api.getPhase();
    if (phase !== 'connected' && !this._isMock) {
      mlvEl.innerHTML =
        '<div class="ws-phase-placeholder">' +
        '<span class="ws-phase-icon">\u25A6</span> ' +
        'Deploy to this lakehouse to view MLV definitions' +
        '</div>';
      return;
    }

    // Show shimmer while loading
    mlvEl.innerHTML =
      '<div class="ws-mlv-grid">' +
      '<div class="skel-rect skel-rect--card"></div>'.repeat(3) +
      '</div>';

    try {
      let definitions;
      if (this._isMock && typeof MockData !== 'undefined') {
        definitions = MockData.mlvDefinitions || [];
      } else {
        const result = await this._api.getMLVDefinitions(ws.id, lh.id, ws.capacityId);
        definitions = (result && (result.value || result.data || result)) || [];
        if (!Array.isArray(definitions)) definitions = [];
      }

      const countBadge = document.getElementById('ws-mlv-count');
      if (countBadge) countBadge.textContent = definitions.length;

      if (definitions.length === 0) {
        mlvEl.innerHTML =
          '<div class="ws-phase-placeholder">' +
          'No MLV definitions found in this lakehouse' +
          '</div>';
        return;
      }

      let html = '<div class="ws-mlv-grid">';
      for (const def of definitions) {
        const status = (def.lastRunStatus || def.status || 'Unknown').toLowerCase();
        const statusCls = status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : '';
        const lastRun = def.lastRunTime ? this._formatDate(def.lastRunTime) : '\u2014';

        html += `<div class="ws-mlv-card ${statusCls}">`;
        html += `<div class="ws-mlv-name">${this._esc(def.name || def.displayName || 'Unnamed')}</div>`;
        html += '<div class="ws-mlv-meta">';
        html += `<span class="ws-type-badge">${this._esc(def.type || def.kind || 'SQL')}</span>`;
        html += ` <span>${this._esc(def.refreshMode || 'Auto')}</span>`;
        html += '</div>';
        html += '<div class="ws-mlv-meta">';
        html += `Last run: ${lastRun}`;
        if (def.lastRunStatus || def.status) {
          const badgeCls = status === 'succeeded' ? 'ws-status-ok' : status === 'failed' ? 'ws-status-err' : '';
          html += ` <span class="ws-mlv-status ${badgeCls}">${this._esc(def.lastRunStatus || def.status)}</span>`;
        }
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
      mlvEl.innerHTML = html;
    } catch (err) {
      mlvEl.innerHTML =
        '<div class="ws-error-state">' +
        '<span>Could not load MLV definitions</span>' +
        '<button class="ws-action-btn ws-retry-btn" id="ws-mlv-retry">Retry</button>' +
        '</div>';
      const retryBtn = document.getElementById('ws-mlv-retry');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => this._loadMLVDefinitions(ws, lh));
      }
    }
  }
```

### Step 6: Mock MLV data

Add to `mock-data.js` before the return statement:

```js
  const mlvDefinitions = [
    { name: 'sales_summary', type: 'SQL', refreshMode: 'Auto', lastRunTime: _ts(15), lastRunStatus: 'Succeeded' },
    { name: 'customer_360', type: 'SQL', refreshMode: 'Auto', lastRunTime: _ts(15), lastRunStatus: 'Succeeded' },
    { name: 'inventory_agg', type: 'PySpark', refreshMode: 'Manual', lastRunTime: _ts(120), lastRunStatus: 'Failed' },
    { name: 'revenue_by_region', type: 'SQL', refreshMode: 'Auto', lastRunTime: _ts(45), lastRunStatus: 'Succeeded' },
  ];
```

And expose it: `mlvDefinitions,` in the return statement.

### Step 7: CSS for MLV status badges and phase placeholder

Add to `workspace.css`:

```css
/* MLV status badge */
.ws-mlv-status {
  display: inline-block;
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  font-size: 10px;
  font-weight: 600;
}
.ws-status-ok {
  background: rgba(24, 160, 88, 0.08);
  color: var(--status-succeeded);
}
.ws-status-err {
  background: rgba(229, 69, 59, 0.08);
  color: var(--status-failed);
}

/* Phase placeholder */
.ws-phase-placeholder {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--text-muted);
  font-size: var(--text-sm);
  background: var(--surface);
  border: 1px dashed var(--border-bright);
  border-radius: var(--radius-md);
  justify-content: center;
}
.ws-phase-icon {
  font-size: var(--text-lg);
  opacity: 0.5;
}

/* Error state with retry */
.ws-error-state {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  color: var(--level-error);
  font-size: var(--text-sm);
  background: var(--row-error-tint);
  border: 1px solid rgba(229, 69, 59, 0.15);
  border-radius: var(--radius-md);
}
.ws-error-state .ws-retry-btn {
  margin-left: auto;
  flex-shrink: 0;
}
```

---

## Task 9: Clone Environment Button

**Owner:** Zara (JS)
**Items:** #9 (Clone Environment button)
**Scenarios:** HAPPY
**Files:** `workspace-explorer.js`

### What changes

Add a "Clone Environment" button to the lakehouse content actions. Clicking it saves the current workspace/lakehouse/capacity as a named environment in favorites.

### Step 1: Add button to action bar

In `_showLakehouseContent`, add to the actions section (after the "Open in Fabric" button):

```js
    html += '<button class="ws-action-btn" data-action="clone-env">Clone Environment</button>';
```

### Step 2: Handle clone-env action

In `_bindContentActions`, add a case for `clone-env`:

```js
        } else if (action === 'clone-env') {
          const lh = this._selectedItem;
          if (lh) {
            const envName = prompt('Environment name:', `${lh.displayName} (${ws.displayName})`);
            if (envName) {
              this._saveFavorite({
                id: lh.id,
                displayName: envName,
                workspaceId: ws.id,
                workspaceName: ws.displayName,
              });
              this._toast(`Environment "${envName}" saved`, 'success');
            }
          }
        }
```

**Note:** `prompt()` is intentional for MVP simplicity. A future iteration will use the command palette for inline naming.

---

## Task 10: Improved Error and Empty States

**Owner:** Zara (JS) + Mika (CSS)
**Items:** #16 (Shimmer while loading), #17 (Content panel top padding)
**Scenarios:** LOADING, EMPTY, ERROR, PHASE_1
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

Replace the current "Loading tables..." text with proper shimmer skeleton. Replace "Could not load tables" with error state + retry. Add top padding to content panel.

### Step 1: Replace loading state with shimmer table

In `_showLakehouseContent`, replace the initial "Loading tables..." and the shimmer skeleton (lines 978–985) with a proper table-shaped skeleton:

```js
      if (tablesEl) {
        tablesEl.innerHTML =
          '<table class="ws-table"><thead><tr>' +
          '<th><div class="skel-line skel-line--sm" style="height:8px"></div></th>' +
          '<th><div class="skel-line skel-line--xs" style="height:8px"></div></th>' +
          '<th><div class="skel-line skel-line--xs" style="height:8px"></div></th>' +
          '<th><div class="skel-line skel-line--xs" style="height:8px"></div></th>' +
          '</tr></thead><tbody>' +
          ('<tr class="ws-table-row"><td><div class="skel-line skel-line--md" style="height:10px"></div></td>' +
           '<td><div class="skel-line skel-line--xs" style="height:10px"></div></td>' +
           '<td><div class="skel-line skel-line--xs" style="height:10px"></div></td>' +
           '<td><div class="skel-line skel-line--sm" style="height:10px"></div></td></tr>').repeat(3) +
          '</tbody></table>';
      }
```

### Step 2: Replace empty state

**BEFORE** (line 991):
```js
        tablesEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">No tables found</div>';
```

**AFTER:**
```js
        tablesEl.innerHTML =
          '<div class="ws-phase-placeholder">' +
          'No tables in this lakehouse. Tables appear after data is loaded via Spark or pipelines.' +
          '</div>';
```

### Step 3: Replace error state with retry

**BEFORE** (lines 1018–1020):
```js
      const errEl = document.getElementById('ws-tables-list');
      if (errEl) errEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Could not load tables</div>';
```

**AFTER:**
```js
      const errEl = document.getElementById('ws-tables-list');
      if (errEl) {
        // Phase 1 schema-enabled lakehouse → deploy placeholder
        if (err.status === 400) {
          errEl.innerHTML =
            '<div class="ws-phase-placeholder">' +
            '<span class="ws-phase-icon">\u25A6</span> ' +
            'Deploy to this lakehouse to view tables (schema-enabled lakehouses require MWC token)' +
            '</div>';
        } else {
          errEl.innerHTML =
            '<div class="ws-error-state">' +
            `<span>Could not load tables: ${this._esc(err.message)}</span>` +
            '<button class="ws-action-btn ws-retry-btn" id="ws-table-retry">Retry</button>' +
            '</div>';
          const retryBtn = document.getElementById('ws-table-retry');
          if (retryBtn) {
            retryBtn.addEventListener('click', () => this._showLakehouseContent(lh, ws));
          }
        }
      }
```

### Step 4: Content panel top padding

The `.ws-content-body` already has `padding: var(--space-5) var(--space-6)` (workspace.css line 124). The header inside it needs its own top padding added in the `_showLakehouseContent` rewrite (already done in Task 1's header with `style="padding-top:var(--space-4)"`).

If the overall content body needs more breathing room, update:

```css
.ws-content-body {
  padding: var(--space-6);
}
```

---

## Task 11: Tree Item Type Icons

**Owner:** Mika (CSS) + Zara (JS)
**Items:** #11 (Item type icons), #12 (Non-lakehouse items)
**Scenarios:** HAPPY
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

Replace the generic green/grey dots with type-specific colored dots. Lakehouses: green. Notebooks: blue. Pipelines: orange. MLExperiments: purple. Reports: grey. All other items: dimmed grey.

### Step 1: Map item types to dot classes

In `workspace-explorer.js`, add a type-to-style helper:

```js
  /**
   * Get CSS class for tree dot based on item type.
   * @param {string} type - Item type string from Fabric API.
   * @returns {string} CSS class name.
   */
  _getItemDotClass(type) {
    const t = (type || '').toLowerCase();
    if (t.includes('lakehouse')) return 'dot-lakehouse';
    if (t.includes('notebook')) return 'dot-notebook';
    if (t.includes('pipeline') || t.includes('datapipeline')) return 'dot-pipeline';
    if (t.includes('mlexperiment') || t.includes('ml')) return 'dot-ml';
    if (t.includes('report')) return 'dot-report';
    if (t.includes('warehouse')) return 'dot-warehouse';
    if (t.includes('kql')) return 'dot-kql';
    return 'dot-other';
  }
```

### Step 2: Update tree rendering

In `_renderTree`, where child items are rendered (around line 731–734):

**BEFORE:**
```js
          const itemEl = this._buildTreeNode({
            name: item.displayName,
            depth: 1,
            dot: isLH ? 'lakehouse' : 'other',
            dimmed: !isLH,
            selected: isItemSelected,
          });
```

**AFTER:**
```js
          const dotCls = this._getItemDotClass(item.type);
          const itemEl = this._buildTreeNode({
            name: item.displayName,
            depth: 1,
            dot: dotCls,
            dimmed: !isLH,
            selected: isItemSelected,
            typeLabel: !isLH ? (item.type || '') : null,
          });
```

### Step 3: Update _buildTreeNode to show type label

In `_buildTreeNode`, after the dot element, add an optional type label:

```js
    if (opts.typeLabel) {
      const typeEl = document.createElement('span');
      typeEl.className = 'ws-tree-type';
      typeEl.textContent = opts.typeLabel;
      el.appendChild(typeEl);
    }
```

**Note:** The `.ws-tree-type` class already exists in workspace.css (line 263).

### Step 4: CSS for type-specific dots

Replace the existing dot colors in `workspace.css`:

**BEFORE:**
```css
.ws-tree-dot.lakehouse { background: var(--status-succeeded); }
.ws-tree-dot.other { background: var(--text-muted); }
```

**AFTER:**
```css
/* Type-specific tree dots */
.ws-tree-dot.dot-lakehouse { background: var(--status-succeeded); }
.ws-tree-dot.dot-notebook { background: var(--comp-controller); }
.ws-tree-dot.dot-pipeline { background: var(--level-warning); }
.ws-tree-dot.dot-ml { background: var(--comp-dq); }
.ws-tree-dot.dot-report { background: var(--text-muted); }
.ws-tree-dot.dot-warehouse { background: var(--comp-onelake); }
.ws-tree-dot.dot-kql { background: var(--comp-dag); }
.ws-tree-dot.dot-other { background: var(--text-muted); opacity: 0.5; }
```

---

## Task 12: Tables Loading — Full Shimmer + Transition

**Owner:** Mika (CSS) + Zara (JS)
**Items:** #16 (Shimmer while loading)
**Scenarios:** LOADING → HAPPY transition
**Files:** `workspace-explorer.js`, `workspace.css`

### What changes

When the table list loads, use the `skel-fade-out` → `content-fade-in` transition classes from shimmer.css for a smooth loading experience.

### Step 1: Add transition class after content loads

In `_showLakehouseContent`, after `tablesEl.innerHTML = tableHtml;` (the real table), wrap with fade-in:

```js
      tablesEl.classList.add('content-fade-in');
```

### Step 2: Ensure shimmer table has proper sizing

The shimmer table from Task 10 Step 1 already uses proper table structure. No additional CSS needed — shimmer.css handles the animation.

---

## Implementation Order

Tasks have these dependencies:

```
Task 1  (Header)      ← standalone
Task 2  (Columns)     ← standalone
Task 4  (Count badge) ← standalone
Task 5  (Sticky)      ← standalone (CSS only)
Task 10 (States)      ← standalone
Task 11 (Tree icons)  ← standalone
Task 12 (Shimmer)     ← standalone (CSS only)
                          ↓
Task 3  (Auto-enrich) ← depends on Task 2 (columns exist to fill)
Task 6  (Sorting)     ← depends on Task 2 (columns to sort)
Task 7  (Row click)   ← depends on Task 6 (extracted binding)
Task 8  (MLV)         ← standalone but best after Task 10 (shared states CSS)
Task 9  (Clone env)   ← standalone (small)
```

**Recommended execution order for parallel agents:**

**Wave 1 (parallel — no dependencies):**
- Task 1 (Header metadata)
- Task 2 + Task 5 (Table columns + sticky header)
- Task 4 (Count badge)
- Task 10 (Error/empty states + padding)
- Task 11 (Tree icons)
- Task 12 (Shimmer transitions)

**Wave 2 (depends on Wave 1):**
- Task 3 (Auto-enrich — needs Task 2's column cells)
- Task 6 (Sorting — needs Task 2's column structure)
- Task 8 (MLV definitions — needs Task 10's CSS patterns)
- Task 9 (Clone env — small, standalone)

**Wave 3 (depends on Wave 2):**
- Task 7 (Row click persistence — needs Task 6's extracted binding)

---

## Verification Checklist

After all tasks complete, verify:

```bash
make lint    # Ruff + eslint pass
make test    # pytest pass
make build   # build-html.py produces valid HTML
```

**Manual verification (in browser):**
- [ ] Select a lakehouse → header shows truncated ID, env badge, health dot
- [ ] Tables section shows "TABLES N" with count badge
- [ ] Table has Name, Type, Rows, Size columns
- [ ] Shimmer appears in Rows/Size while batchGetTableDetails loads
- [ ] Shimmer resolves to actual numbers (or dashes if unavailable)
- [ ] Click column headers to sort (name, type, rows, size)
- [ ] Sort indicator (▴/▾) appears on active column
- [ ] Click table row → row highlights, inspector shows table info
- [ ] Selected row survives re-sort
- [ ] Tree shows colored dots per item type (green=LH, blue=Notebook, orange=Pipeline)
- [ ] Non-lakehouse items show dimmed with type label
- [ ] MLV section shows cards (mock mode) or placeholder (Phase 1)
- [ ] "Clone Environment" saves to favorites
- [ ] Empty lakehouse shows "No tables" message
- [ ] Network error shows error state with Retry button
- [ ] Schema-enabled error (400) shows deploy placeholder
- [ ] No jank in scroll or transitions
- [ ] Works in both light and dark theme

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| `batchGetTableDetails` returns different shape than expected | Rows/Size show dashes | Defensive parsing with fallbacks; log response for debugging |
| `listWorkspaceArtifacts` 404 on some workspaces | No lastModifiedDate | Best-effort enrichment, catch silently |
| MLV endpoint doesn't exist on all capacities | MLV section error | Catch and show "unavailable" state, not error |
| Sort re-render causes inspector flicker | UX regression | Track selectedTableName, restore after re-render |
| Metadata proxy path conflict with existing `/v1` prefix logic | Proxy returns 404 | Test `_map_path` change with both metadata and v1 paths |
| CSS specificity conflicts between new and existing table styles | Layout breaks | Use `.ws-table--sortable` class for new styles, test both workspace content and lakehouse content tables |
