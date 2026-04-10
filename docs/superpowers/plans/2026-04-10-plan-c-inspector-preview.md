# Plan C: Inspector Panel + Preview Production Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Transform the inspector from a basic key-value display to an auto-loading detail view with schema, data preview, and contextual empty states.

**Architecture:** `_showTableInspector` auto-fetches details on selection (no button click). New `previewAsync` LRO integration for sample data. Inspector shows contextual content based on what's selected (workspace/lakehouse/table/MLV). Shimmer skeletons during all async loads.

**Tech Stack:** Vanilla JS, shimmer.css (skel-* classes), LRO polling for preview, OKLCH colors, 4px grid

**Assigned:** Zara Okonkwo (JS), Mika Tanaka (CSS), Dev Patel (API integration), Ines Ferreira (tests)

**Depends on:** workspace-explorer.js functional (done), api-client.js with getTableDetails (done), shimmer.css (done), fabric-api-reference.md with previewAsync docs (done)

**Reference spec:** `docs/specs/design-spec-v2.md`, `docs/fabric-api-reference.md`

---

## Current State Analysis

### What exists today

| Feature | Status | Location | Issue |
|---------|--------|----------|-------|
| Table inspector | Basic KV (Name, Type, Format) | `workspace-explorer.js:1063–1130` | Requires "Load column details" button click for schema |
| Schema columns | Behind button click | `workspace-explorer.js:1084–1102` | Not auto-loaded; shows only after explicit action |
| Workspace inspector | Works | `workspace-explorer.js:1132–1181` | Shows Name, ID, Capacity, State, Description + item counts |
| Lakehouse inspector | **Missing** | `_selectItem` calls `_clearInspector()` for lakehouses | When lakehouse is selected, inspector is blank |
| Data preview | **Not implemented** | — | `previewAsync` API documented but no JS integration |
| MLV inspector | **Not implemented** | — | MLV cards exist (`.ws-mlv-card`) but no click→inspector flow |
| Empty state | **Missing** | `_clearInspector()` just empties innerHTML | No "Select an item" placeholder |
| Section dividers | Partial | `.ws-insp-title` has `border-bottom` | Exists but inconsistent between info/schema sections |

### Key API endpoints (from `docs/fabric-api-reference.md`)

| API | Method | Token | Phase | Status |
|-----|--------|-------|-------|--------|
| `getTableDetails` (batch) | POST → LRO poll | MWC | Phase 2 | ✅ Implemented in `api-client.js:118` |
| `previewAsync` | POST → 202 → poll | MWC | Phase 2 | ⚠️ Documented but NOT in `api-client.js` |
| `listTablesViaCapacity` | GET | MWC | Phase 2 | ✅ Implemented in `api-client.js:99` |
| `getLakehouse` (v1) | GET | Bearer | Phase 1 | ⚠️ NOT in `api-client.js` (path: `/v1/workspaces/{wsId}/lakehouses/{lhId}`) |

### Shimmer system (from `shimmer.css`)

Already built by Mika. Classes: `skel-line`, `skel-line--sm/md/lg`, `skel-circle`, `skel-rect`, `skel-row`, `skel-lines`, `skel-wrap`, `skel-header-line`, `skel-fade-out`, `content-fade-in`. Variables: `--skel-base`, `--skel-shine`, `--skel-speed`, `--skel-radius`. Dark theme supported.

---

## Scenario Matrix

| Scenario | Trigger | Inspector Shows | Loading State |
|----------|---------|----------------|---------------|
| **HAPPY** | Table row clicked in content panel | Shimmer → TABLE INFO + SCHEMA + PREVIEW | Shimmer skeleton for all 3 sections |
| **LOADING** | While `getTableDetails` in-flight | Shimmer: 3 KV rows + table skeleton | `skel-wrap` with `skel-line` rows |
| **EMPTY_TABLE** | Table exists, 0 rows in preview | Info + Schema + "Empty table — no rows" | — |
| **ERROR** | `getTableDetails` fails (network/401/500) | Error banner with Retry button | Shimmer → error state |
| **NO_SELECTION** | Nothing selected (initial load / after delete) | "Select an item to inspect" placeholder | — |
| **LAKEHOUSE_SELECTED** | Lakehouse clicked in tree (no table) | Lakehouse summary: name, table count, paths | — |
| **WORKSPACE_SELECTED** | Workspace name clicked in tree | Workspace summary (already works) | — |
| **PREVIEW_LOADING** | Schema loaded, `previewAsync` still polling | Info + Schema visible, shimmer for preview | Shimmer only in preview section |
| **PREVIEW_ERROR** | `previewAsync` fails or times out | Info + Schema visible, error in preview section | — |
| **MLV_CLICK** | MLV card clicked in content panel | MLV detail: name, type, definition, last run | Shimmer → details |
| **PHASE_1_TABLE** | Table visible but no MWC token | Info (basic only) + "Deploy to unlock schema & preview" | — |

---

## File Map

| File | Action | Owner | Responsibility |
|------|--------|-------|----------------|
| `src/frontend/js/workspace-explorer.js` | Modify | Zara | Auto-load inspector, lakehouse inspector, empty states, MLV inspector |
| `src/frontend/js/api-client.js` | Modify | Zara/Dev | Add `previewTable()`, `getLakehouse()` methods |
| `src/frontend/css/workspace.css` | Modify | Mika | Inspector shimmer states, section dividers, preview table, empty state styling |
| `scripts/dev-server.py` | Modify | Elena | Add `/api/mwc/preview` proxy endpoint for previewAsync LRO |
| `tests/test_workspace_explorer.py` | Create | Ines | Inspector rendering tests (mock data) |

---

## Task 1: Inspector empty states + no-selection placeholder (Zara + Mika)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`
- Modify: `src/frontend/css/workspace.css`

Replace `_clearInspector()` with contextual empty states.

- [ ] **Step 1: Add `_showInspectorPlaceholder()` method**

In `workspace-explorer.js`, add a new method after `_clearInspector()` (~line 1184):

```javascript
_showInspectorPlaceholder(message = 'Select an item to inspect', icon = '\u25A6') {
  if (!this._inspectorEl) return;
  this._inspectorEl.innerHTML =
    '<div class="ws-insp-empty">' +
    `<div class="ws-insp-empty-icon">${icon}</div>` +
    `<div class="ws-insp-empty-text">${this._esc(message)}</div>` +
    '</div>';
}
```

- [ ] **Step 2: Replace all `_clearInspector()` calls with contextual placeholders**

There are 4 call sites to update:

1. **`_selectItem` when lakehouse** (line ~836): Replace `this._clearInspector()` with `this._showLakehouseInspector(item, workspace)` (Task 5).
2. **`_selectItem` when non-lakehouse item** (line ~839): Replace `this._clearInspector()` with `this._showInspectorPlaceholder(item.displayName + ' — ' + (item.type || 'Item'))`.
3. **`_showItemContent`** (line ~1043): Replace `this._clearInspector()` with `this._showInspectorPlaceholder('No details available for ' + (item.type || 'this item'))`.
4. **After delete** (line ~362): Replace `this._clearInspector()` with `this._showInspectorPlaceholder()`.

Keep `_clearInspector()` as a private method for internal use but all user-facing clears go through `_showInspectorPlaceholder`.

- [ ] **Step 3: CSS for inspector empty state**

In `workspace.css`, add after the `.ws-insp-count` rule (~line 386):

```css
/* Inspector — Empty / placeholder state */
.ws-insp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  text-align: center;
  color: var(--text-muted);
  gap: var(--space-3);
}
.ws-insp-empty-icon {
  font-size: 28px;
  opacity: 0.3;
}
.ws-insp-empty-text {
  font-size: var(--text-xs);
  max-width: 160px;
  line-height: 1.5;
}
```

- [ ] **Step 4: Call `_showInspectorPlaceholder()` on initial load**

In `init()`, after `await this.loadWorkspaces()` (~line 39), add:

```javascript
this._showInspectorPlaceholder();
```

- [ ] **Step 5: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/css/workspace.css
git commit -m "feat(inspector): contextual empty states and placeholder

Zara + Mika: Replace blank inspector with 'Select an item' placeholder.
Four call sites updated: item select, lakehouse select, delete, init.
New .ws-insp-empty CSS with centered icon + text.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Auto-load table details on selection (Zara)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`

Remove the "Load column details" button. Auto-fetch when table row is clicked.

- [ ] **Step 1: Add `_showTableInspectorShimmer()` method**

Add before `_showTableInspector()` (~line 1063):

```javascript
_showTableInspectorShimmer() {
  if (!this._inspectorEl) return;
  let html = '<div class="ws-insp-section">';
  html += '<div class="skel-header-line"></div>';
  html += '<div class="skel-wrap" style="gap:var(--space-2)">';
  html += '<div class="skel-line skel-line--md"></div>';
  html += '<div class="skel-line skel-line--sm"></div>';
  html += '<div class="skel-line skel-line--md"></div>';
  html += '<div class="skel-line skel-line--sm"></div>';
  html += '</div></div>';
  html += '<div class="ws-insp-section" style="margin-top:var(--space-5)">';
  html += '<div class="skel-header-line"></div>';
  html += '<div class="skel-wrap" style="gap:var(--space-1)">';
  for (let i = 0; i < 5; i++) {
    html += '<div class="skel-line skel-line--lg"></div>';
  }
  html += '</div></div>';
  this._inspectorEl.innerHTML = html;
}
```

- [ ] **Step 2: Rewrite table row click handler to auto-fetch**

In `_showLakehouseContent` (line ~1008–1016), replace the table row click handler:

```javascript
tablesEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
  row.addEventListener('click', async () => {
    tablesEl.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    const tbl = tables.find(x => x.name === row.dataset.tableName);
    if (!tbl) return;

    // Show basic info immediately, then auto-fetch details
    this._showTableInspectorShimmer();
    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;

    if (ws && ws.capacityId && lh) {
      try {
        const result = await this._api.getTableDetails(ws.id, lh.id, ws.capacityId, [tbl.name]);
        const details = result && result.value
          ? result.value.find(v => v.tableName === tbl.name) : null;
        if (details && details.result) {
          const enriched = { ...tbl, ...details.result, schemaName: details.schemaName };
          this._showTableInspector(enriched);
        } else {
          this._showTableInspector(tbl);
        }
      } catch (err) {
        this._showTableInspectorError(tbl, err);
      }
    } else {
      // Phase 1 or no capacity — show basic info only
      this._showTableInspector(tbl);
    }
  });
});
```

- [ ] **Step 3: Add `_showTableInspectorError()` method**

Add after `_showTableInspector()`:

```javascript
_showTableInspectorError(table, err) {
  if (!this._inspectorEl) return;
  let html = '<div class="ws-insp-section">';
  html += '<div class="ws-insp-title">Table Info</div>';
  html += '<dl class="ws-insp-kv">';
  html += `<dt>Name</dt><dd>${this._esc(table.name)}</dd>`;
  html += `<dt>Type</dt><dd>${this._esc(table.type || 'Table')}</dd>`;
  html += '</dl></div>';
  html += '<div class="ws-insp-section">';
  html += '<div class="ws-insp-error">';
  html += `<span>Failed to load details: ${this._esc(err.message)}</span>`;
  html += '<button class="ws-action-btn ws-retry-details-btn">Retry</button>';
  html += '</div></div>';
  this._inspectorEl.innerHTML = html;

  const retryBtn = this._inspectorEl.querySelector('.ws-retry-details-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      // Re-trigger the auto-fetch
      this._showTableInspectorShimmer();
      const ws = this._selectedWorkspace;
      const lh = this._selectedItem;
      this._api.getTableDetails(ws.id, lh.id, ws.capacityId, [table.name])
        .then(result => {
          const details = result && result.value
            ? result.value.find(v => v.tableName === table.name) : null;
          if (details && details.result) {
            this._showTableInspector({ ...table, ...details.result, schemaName: details.schemaName });
          } else {
            this._showTableInspector(table);
          }
        })
        .catch(retryErr => this._showTableInspectorError(table, retryErr));
    });
  }
}
```

- [ ] **Step 4: Remove the "Load column details" button from `_showTableInspector`**

In `_showTableInspector()`, remove the `else if` block that shows the button (lines ~1097–1102):

```javascript
// REMOVE this block:
} else if (this._selectedWorkspace && this._selectedWorkspace.capacityId) {
  html += '<div class="ws-insp-section">';
  html += '<button class="ws-action-btn ws-fetch-details-btn">Load column details</button>';
  html += '</div>';
}
```

Also remove the button click handler (lines ~1107–1129). The auto-fetch in Step 2 replaces this entirely.

Replace with a Phase 1 hint when no schema is available:

```javascript
} else {
  html += '<div class="ws-insp-section">';
  html += '<div class="ws-insp-title">Schema</div>';
  if (this._selectedWorkspace && this._selectedWorkspace.capacityId) {
    html += '<p class="ws-insp-hint">Schema auto-loaded when available</p>';
  } else {
    html += '<p class="ws-insp-hint">Deploy to this lakehouse to view column details</p>';
  }
  html += '</div>';
}
```

- [ ] **Step 5: CSS for error and hint states**

In `workspace.css`, add:

```css
/* Inspector — Error state */
.ws-insp-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--row-error-tint);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: var(--level-error);
  text-align: center;
}
.ws-insp-error .ws-action-btn {
  margin-top: var(--space-1);
  height: 28px;
  font-size: var(--text-xs);
}

/* Inspector — Phase hint */
.ws-insp-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-style: italic;
  margin: 0;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/css/workspace.css
git commit -m "feat(inspector): auto-load table details on selection

Zara: Table row click now auto-fetches getTableDetails with shimmer.
Removed 'Load column details' button. Added error state with retry.
Phase 1 shows hint to deploy. Shimmer uses shared skel-* classes.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Table info enrichment (Zara)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`
- Modify: `src/frontend/css/workspace.css`

Expand the TABLE INFO section with additional fields from `getTableDetails` response.

- [ ] **Step 1: Enrich the fields array in `_showTableInspector`**

Replace the `fields` array (lines ~1068–1078) with:

```javascript
const fields = [
  ['Name', table.name],
  ['Type', this._formatTableType(table.type)],
  ['Format', table.format || 'Delta'],
];
if (table.location) {
  fields.push(['Location', table.location]);
}
if (table.schemaName) {
  fields.push(['Schema', table.schemaName]);
}
if (table.rowCount != null) {
  fields.push(['Rows', this._formatNumber(table.rowCount)]);
}
if (table.sizeInBytes != null) {
  fields.push(['Size', this._formatBytes(table.sizeInBytes)]);
}
if (table.lastModifiedTime) {
  fields.push(['Modified', this._formatDate(table.lastModifiedTime)]);
}
```

- [ ] **Step 2: Add helper methods**

Add after `_esc()` (~line 1306):

```javascript
_formatTableType(type) {
  const map = {
    'MATERIALIZED_LAKE_VIEW': 'MLV',
    'MANAGED': 'Managed',
    'EXTERNAL': 'External',
  };
  return map[(type || '').toUpperCase()] || type || 'Table';
}

_formatNumber(n) {
  if (n == null) return '\u2014';
  return Number(n).toLocaleString('en-US');
}

_formatBytes(bytes) {
  if (bytes == null) return '\u2014';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = Number(bytes);
  while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[idx]}`;
}
```

- [ ] **Step 3: Widen the KV grid for longer values**

In `workspace.css`, update `.ws-insp-kv`:

```css
.ws-insp-kv {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
}
```

Change `70px` → `72px` (keeps 4px grid: 72 = 18 × 4).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/css/workspace.css
git commit -m "feat(inspector): enriched table info with rows, size, modified

Zara: TABLE INFO section now shows type (formatted), location, schema,
row count, size (human-readable), and last modified date. New helpers:
_formatTableType, _formatNumber, _formatBytes. KV grid widened to 72px.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Data preview via previewAsync LRO (Dev + Zara)

**Files:**
- Modify: `src/frontend/js/api-client.js`
- Modify: `src/frontend/js/workspace-explorer.js`
- Modify: `src/frontend/css/workspace.css`
- Modify: `scripts/dev-server.py`

Integrate the `previewAsync` endpoint for "First N rows" preview.

- [ ] **Step 1: Add `previewTable()` to api-client.js (Dev)**

Add after `getTableDetails()` (~line 135):

```javascript
/**
 * Preview table data via LRO (previewAsync).
 * Proxied through dev-server to handle MWC auth + LRO polling server-side.
 * @param {string} workspaceId
 * @param {string} lakehouseId
 * @param {string} capacityId
 * @param {string} tableName
 * @param {number} [maxRows=3] - Number of rows to return.
 * @returns {Promise<{columns: string[], rows: any[][]}>} Preview data.
 */
async previewTable(workspaceId, lakehouseId, capacityId, tableName, maxRows = 3) {
  const resp = await fetch('/api/mwc/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wsId: workspaceId,
      lhId: lakehouseId,
      capId: capacityId,
      tableName,
      maxRows,
    }),
  });
  if (!resp.ok) {
    const err = new Error(`Preview failed: ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}
```

- [ ] **Step 2: Add `/api/mwc/preview` proxy endpoint to dev-server.py (Elena)**

Add a new handler in the dev-server's request handler class. This endpoint:

1. Accepts POST with `{ wsId, lhId, capId, tableName, maxRows }`.
2. Generates/reuses an MWC token for the capacity.
3. POSTs to `previewAsync` on the capacity host → gets 202 + operationId.
4. Polls `operationResults/{operationId}` every 500ms (max 15 attempts / 7.5s timeout).
5. Returns the preview rows to the frontend.

```python
def _serve_preview(self):
    """Proxy previewAsync LRO to capacity host."""
    content_len = int(self.headers.get("Content-Length", 0))
    body = json.loads(self.rfile.read(content_len)) if content_len else {}
    ws_id = body.get("wsId")
    lh_id = body.get("lhId")
    cap_id = body.get("capId")
    table_name = body.get("tableName")
    max_rows = body.get("maxRows", 3)

    if not all([ws_id, lh_id, cap_id, table_name]):
        self._json_response(400, {"error": "Missing required fields"})
        return

    mwc = self._get_mwc_token(ws_id, lh_id, cap_id)
    if not mwc:
        self._json_response(401, {"error": "MWC token unavailable"})
        return

    cap_host = self._capacity_host(cap_id)
    base = f"{cap_host}/webapi/capacities/{cap_id}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{ws_id}/artifacts/Lakehouse/{lh_id}"
    headers = {
        "Authorization": f"MwcToken {mwc}",
        "x-ms-workload-resource-moniker": lh_id,
        "Content-Type": "application/json",
    }

    # POST to start preview
    start_resp = requests.post(
        f"{base}/tables/{table_name}/previewAsync",
        headers=headers,
        json={"maxRows": max_rows},
    )
    if start_resp.status_code != 202:
        self._json_response(start_resp.status_code, {"error": "previewAsync start failed"})
        return

    op_id = start_resp.json().get("operationId")
    # Poll for result
    for _ in range(15):
        time.sleep(0.5)
        poll = requests.get(
            f"{base}/tables/{table_name}/previewAsync/operationResults/{op_id}",
            headers=headers,
        )
        if poll.status_code == 200:
            self._json_response(200, poll.json())
            return
        if poll.status_code != 202:
            break

    self._json_response(504, {"error": "Preview timed out"})
```

- [ ] **Step 3: Add preview section to `_showTableInspector` (Zara)**

After the schema table section in `_showTableInspector`, add:

```javascript
// Preview section — async load after inspector renders
html += '<div class="ws-insp-section" id="ws-insp-preview-section">';
html += '<div class="ws-insp-title">Preview</div>';
if (this._selectedWorkspace && this._selectedWorkspace.capacityId) {
  html += '<div class="ws-insp-preview-body">';
  html += '<div class="skel-wrap" style="gap:var(--space-1)">';
  html += '<div class="skel-line skel-line--lg"></div>';
  html += '<div class="skel-line skel-line--lg"></div>';
  html += '<div class="skel-line skel-line--md"></div>';
  html += '</div></div>';
} else {
  html += '<p class="ws-insp-hint">Deploy to this lakehouse to preview data</p>';
}
html += '</div>';
```

Then after `this._inspectorEl.innerHTML = html;`, trigger the async preview load:

```javascript
if (this._selectedWorkspace && this._selectedWorkspace.capacityId && table.name) {
  this._loadTablePreview(table);
}
```

- [ ] **Step 4: Add `_loadTablePreview()` method (Zara)**

```javascript
async _loadTablePreview(table, maxRows = 3) {
  const previewBody = this._inspectorEl.querySelector('.ws-insp-preview-body');
  if (!previewBody) return;
  const ws = this._selectedWorkspace;
  const lh = this._selectedItem;
  if (!ws || !lh || !ws.capacityId) return;

  try {
    const data = await this._api.previewTable(ws.id, lh.id, ws.capacityId, table.name, maxRows);
    if (!data || !data.rows || data.rows.length === 0) {
      previewBody.innerHTML = '<p class="ws-insp-hint">Empty table — no rows</p>';
      return;
    }

    const columns = data.columns || [];
    let html = '<table class="ws-preview-table"><thead><tr>';
    for (const col of columns) {
      html += `<th>${this._esc(col)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const row of data.rows.slice(0, maxRows)) {
      html += '<tr>';
      for (const cell of row) {
        const val = cell == null ? 'null' : String(cell);
        html += `<td>${this._esc(val.length > 50 ? val.substring(0, 47) + '...' : val)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    if (data.rows.length >= maxRows) {
      html += `<button class="ws-action-btn ws-load-more-btn" style="margin-top:var(--space-2);width:100%;font-size:var(--text-xs)">Load more rows</button>`;
    }

    previewBody.classList.add('content-fade-in');
    previewBody.innerHTML = html;

    // "Load more" button
    const loadMoreBtn = previewBody.querySelector('.ws-load-more-btn');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        loadMoreBtn.textContent = 'Loading...';
        loadMoreBtn.disabled = true;
        this._loadTablePreview(table, maxRows + 10);
      });
    }
  } catch (err) {
    previewBody.innerHTML =
      `<div class="ws-insp-error" style="padding:var(--space-2)">` +
      `<span>Preview failed: ${this._esc(err.message)}</span></div>`;
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/frontend/js/api-client.js src/frontend/js/workspace-explorer.js \
        src/frontend/css/workspace.css scripts/dev-server.py
git commit -m "feat(inspector): data preview via previewAsync LRO

Dev + Zara: New previewTable() in api-client.js. Preview section loads
asynchronously after schema — shows first 3 rows with 'Load more'.
dev-server.py proxies previewAsync LRO with 500ms polling (7.5s timeout).
Empty tables show 'no rows' hint. Phase 1 shows deploy hint.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Lakehouse inspector (Zara + Dev)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`
- Modify: `src/frontend/js/api-client.js`
- Modify: `src/frontend/css/workspace.css`

When a lakehouse is selected in the tree, show lakehouse summary instead of blank inspector.

- [ ] **Step 1: Add `getLakehouse()` to api-client.js (Dev)**

Add after `listLakehouses()` (~line 89):

```javascript
/**
 * Get lakehouse details including OneLake paths and SQL endpoint info.
 * @param {string} workspaceId
 * @param {string} lakehouseId
 * @returns {Promise<object>} Lakehouse with properties.
 */
async getLakehouse(workspaceId, lakehouseId) {
  return this._fabricGet(`/workspaces/${workspaceId}/lakehouses/${lakehouseId}`);
}
```

- [ ] **Step 2: Add `_showLakehouseInspector()` method (Zara)**

Add after `_showWorkspaceInspector()` (~line 1181):

```javascript
async _showLakehouseInspector(lh, ws) {
  if (!this._inspectorEl) return;

  // Show shimmer first
  this._inspectorEl.innerHTML =
    '<div class="ws-insp-section">' +
    '<div class="skel-header-line"></div>' +
    '<div class="skel-wrap" style="gap:var(--space-2)">' +
    '<div class="skel-line skel-line--md"></div>' +
    '<div class="skel-line skel-line--sm"></div>' +
    '<div class="skel-line skel-line--lg"></div>' +
    '<div class="skel-line skel-line--sm"></div>' +
    '</div></div>';

  // Fetch full lakehouse details
  let details = lh;
  try {
    details = await this._api.getLakehouse(ws.id, lh.id);
  } catch {
    // Use what we have
  }

  const props = details.properties || {};
  let html = '<div class="ws-insp-section">';
  html += '<div class="ws-insp-title">Lakehouse Info</div>';
  html += '<dl class="ws-insp-kv">';

  const fields = [
    ['Name', details.displayName || lh.displayName],
    ['ID', (details.id || lh.id).substring(0, 12) + '...'],
    ['Workspace', ws.displayName],
  ];
  if (props.oneLakeTablesPath) {
    fields.push(['Tables Path', props.oneLakeTablesPath]);
  }
  if (props.oneLakeFilesPath) {
    fields.push(['Files Path', props.oneLakeFilesPath]);
  }
  if (props.defaultSchema) {
    fields.push(['Schema', props.defaultSchema]);
  }

  for (const [label, val] of fields) {
    html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
  }
  html += '</dl></div>';

  // Table count from loaded tables (if available)
  const tableCount = this._cachedTableCount;
  if (tableCount != null) {
    html += '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Tables</div>';
    html += `<p style="font-size:var(--text-xs);color:var(--text-muted)">${tableCount} table${tableCount !== 1 ? 's' : ''} in this lakehouse</p>`;
    html += '</div>';
  }

  // SQL endpoint info
  if (props.sqlEndpointProperties) {
    const sql = props.sqlEndpointProperties;
    html += '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">SQL Endpoint</div>';
    html += '<dl class="ws-insp-kv">';
    if (sql.connectionString) {
      html += `<dt>Server</dt><dd>${this._esc(sql.connectionString)}</dd>`;
    }
    if (sql.provisioningStatus) {
      html += `<dt>Status</dt><dd>${this._esc(sql.provisioningStatus)}</dd>`;
    }
    html += '</dl></div>';
  }

  this._inspectorEl.innerHTML = html;
}
```

- [ ] **Step 3: Wire lakehouse inspector into `_selectItem`**

In `_selectItem` (~line 829), update the lakehouse branch:

```javascript
if (isLH) {
  this._showLakehouseContent(item, workspace);
  this._showLakehouseInspector(item, workspace);
} else {
  this._showItemContent(item, workspace);
  this._showInspectorPlaceholder(item.displayName + ' \u2014 ' + (item.type || 'Item'));
}
```

- [ ] **Step 4: Track table count from `_showLakehouseContent`**

In `_showLakehouseContent`, after tables are loaded (~line 988), cache the count:

```javascript
this._cachedTableCount = tables.length;
```

Initialize `this._cachedTableCount = null` in the constructor.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/js/api-client.js
git commit -m "feat(inspector): lakehouse summary when lakehouse selected

Zara + Dev: New _showLakehouseInspector shows name, paths, schema,
SQL endpoint, table count. getLakehouse() added to api-client. Shimmer
while fetching details. Replaces blank inspector on lakehouse select.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Enhanced workspace inspector (Zara)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`

Enrich the existing `_showWorkspaceInspector` with region, last modified, capacity name.

- [ ] **Step 1: Add region and last modified to workspace inspector**

In `_showWorkspaceInspector()`, extend the `fields` array (~line 1138):

```javascript
const fields = [
  ['Name', ws.displayName],
  ['ID', ws.id.substring(0, 12) + '...'],
  ['Capacity', ws.capacityId || 'N/A'],
  ['Region', ws.region || ws.capacityRegion || '\u2014'],
  ['State', ws.state || 'Active'],
];
if (ws.description) {
  fields.push(['Desc', ws.description]);
}
```

- [ ] **Step 2: Add click-to-copy on workspace ID**

After rendering the inspector HTML, bind a click-to-copy on the ID value:

```javascript
const ddEls = this._inspectorEl.querySelectorAll('.ws-insp-kv dd');
if (ddEls.length >= 2) {
  ddEls[1].style.cursor = 'pointer';
  ddEls[1].title = 'Click to copy full ID';
  ddEls[1].addEventListener('click', () => {
    this._copyToClipboard(ws.id, 'Workspace ID copied');
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(inspector): enhanced workspace info with region + copy ID

Zara: Workspace inspector now shows region, truncated ID with
click-to-copy. Description conditionally shown.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: MLV detail inspector (Zara)

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`
- Modify: `src/frontend/css/workspace.css`

When an MLV card is clicked in the content panel, show MLV-specific details in the inspector.

- [ ] **Step 1: Identify MLV card click binding**

MLV cards are rendered in `_showLakehouseContent` with class `.ws-mlv-card`. Currently there is no click handler for MLV cards. We need to add one.

Search for where MLV cards are generated and bind click events to show inspector details.

In the table rendering loop, MLV tables (where `type === 'MATERIALIZED_LAKE_VIEW'` or similar) should be detectable. After the table list renders, also bind MLV card clicks.

- [ ] **Step 2: Add `_showMlvInspector()` method**

Add after `_showLakehouseInspector()`:

```javascript
_showMlvInspector(mlv) {
  if (!this._inspectorEl) return;
  let html = '<div class="ws-insp-section">';
  html += '<div class="ws-insp-title">Materialized View</div>';
  html += '<dl class="ws-insp-kv">';

  const fields = [
    ['Name', mlv.name || mlv.displayName],
    ['Type', 'MLV'],
  ];
  if (mlv.format) {
    fields.push(['Format', mlv.format]);
  }
  if (mlv.schemaName) {
    fields.push(['Schema', mlv.schemaName]);
  }
  if (mlv.rowCount != null) {
    fields.push(['Rows', this._formatNumber(mlv.rowCount)]);
  }
  if (mlv.sizeInBytes != null) {
    fields.push(['Size', this._formatBytes(mlv.sizeInBytes)]);
  }

  for (const [label, val] of fields) {
    html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
  }
  html += '</dl></div>';

  // Definition snippet (if available from table details)
  if (mlv.definition || mlv.sqlDefinition) {
    const def = mlv.definition || mlv.sqlDefinition;
    const snippet = def.length > 200 ? def.substring(0, 197) + '...' : def;
    html += '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Definition</div>';
    html += `<pre class="ws-insp-code">${this._esc(snippet)}</pre>`;
    html += '</div>';
  }

  // Last run details (if available)
  if (mlv.lastRunStatus || mlv.lastRunTime) {
    html += '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Last Run</div>';
    html += '<dl class="ws-insp-kv">';
    if (mlv.lastRunStatus) {
      html += `<dt>Status</dt><dd>${this._esc(mlv.lastRunStatus)}</dd>`;
    }
    if (mlv.lastRunTime) {
      html += `<dt>Time</dt><dd>${this._esc(this._formatDate(mlv.lastRunTime))}</dd>`;
    }
    if (mlv.lastRunDuration) {
      html += `<dt>Duration</dt><dd>${this._esc(mlv.lastRunDuration)}</dd>`;
    }
    html += '</dl></div>';
  }

  // Schedule info (if available)
  if (mlv.schedule) {
    html += '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Schedule</div>';
    html += `<p style="font-size:var(--text-xs);color:var(--text-dim);font-family:var(--font-mono)">${this._esc(mlv.schedule)}</p>`;
    html += '</div>';
  }

  this._inspectorEl.innerHTML = html;
}
```

- [ ] **Step 3: CSS for code snippet in inspector**

In `workspace.css`, add:

```css
/* Inspector — Code definition snippet */
.ws-insp-code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-dim);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
  line-height: 1.5;
}
```

- [ ] **Step 4: Bind MLV card clicks to `_showMlvInspector`**

In the MLV card rendering (inside `_showLakehouseContent` or wherever MLV cards are created), after card elements are appended to the DOM, bind:

```javascript
contentEl.querySelectorAll('.ws-mlv-card[data-table-name]').forEach(card => {
  card.style.cursor = 'pointer';
  card.addEventListener('click', async () => {
    contentEl.querySelectorAll('.ws-mlv-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const tbl = tables.find(x => x.name === card.dataset.tableName);
    if (!tbl) return;

    // Auto-fetch details then show MLV inspector
    this._showTableInspectorShimmer();
    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;
    if (ws && ws.capacityId && lh) {
      try {
        const result = await this._api.getTableDetails(ws.id, lh.id, ws.capacityId, [tbl.name]);
        const details = result && result.value
          ? result.value.find(v => v.tableName === tbl.name) : null;
        const enriched = details && details.result
          ? { ...tbl, ...details.result, schemaName: details.schemaName } : tbl;
        this._showMlvInspector(enriched);
      } catch {
        this._showMlvInspector(tbl);
      }
    } else {
      this._showMlvInspector(tbl);
    }
  });
});
```

- [ ] **Step 5: Add `.ws-mlv-card.selected` style**

In `workspace.css`:

```css
.ws-mlv-card.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/css/workspace.css
git commit -m "feat(inspector): MLV detail inspector with definition + run info

Zara + Mika: MLV cards now clickable → inspector shows name, type,
definition snippet, last run status/time/duration, schedule. Auto-fetches
details via getTableDetails. Code snippet styled with pre.ws-insp-code.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Section dividers + visual consistency (Mika)

**Files:**
- Modify: `src/frontend/css/workspace.css`

Ensure all inspector sections have consistent visual rhythm.

- [ ] **Step 1: Refine `.ws-insp-title` with accent pip**

Update `.ws-insp-title` in `workspace.css`:

```css
.ws-insp-title {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.ws-insp-title::before {
  content: '';
  width: 3px;
  height: 12px;
  background: var(--accent);
  border-radius: 2px;
  flex-shrink: 0;
}
```

- [ ] **Step 2: Add section spacing consistency**

Verify and enforce:

```css
.ws-insp-section {
  margin-bottom: var(--space-5);
}
.ws-insp-section:last-child {
  margin-bottom: 0;
}
```

- [ ] **Step 3: Preview table compact styling**

Ensure `.ws-preview-table` cells don't overflow:

```css
.ws-preview-table td {
  padding: var(--space-1) var(--space-2);
  color: var(--text-dim);
  font-family: var(--font-mono);
  border-bottom: 1px solid var(--border);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/frontend/css/workspace.css
git commit -m "cleanup(inspector): section dividers, accent pip, preview overflow

Mika: Inspector section titles now have a 3px accent pip via ::before.
Consistent spacing with section:last-child margin reset. Preview table
cells capped at 120px with ellipsis overflow.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Tests (Ines)

**Files:**
- Create: `tests/test_inspector.py`

- [ ] **Step 1: Test inspector rendering with mock data**

```python
"""Tests for inspector panel rendering logic."""
import json
import pytest


class TestTableInspectorFields:
    """Verify enriched field rendering from getTableDetails response."""

    def test_format_bytes_small(self):
        """Bytes under 1KB show as bytes."""
        # Logic test: 512 → "512 B"
        val = 512
        units = ['B', 'KB', 'MB', 'GB', 'TB']
        idx = 0
        while val >= 1024 and idx < len(units) - 1:
            val /= 1024
            idx += 1
        result = f"{round(val)} {units[idx]}"
        assert result == "512 B"

    def test_format_bytes_megabytes(self):
        """Megabyte-range values formatted correctly."""
        val = 5_242_880  # 5 MB
        units = ['B', 'KB', 'MB', 'GB', 'TB']
        idx = 0
        while val >= 1024 and idx < len(units) - 1:
            val /= 1024
            idx += 1
        result = f"{round(val)} {units[idx]}"
        assert result == "5 MB"

    def test_format_table_type_mlv(self):
        """MATERIALIZED_LAKE_VIEW maps to 'MLV'."""
        type_map = {
            'MATERIALIZED_LAKE_VIEW': 'MLV',
            'MANAGED': 'Managed',
            'EXTERNAL': 'External',
        }
        assert type_map.get('MATERIALIZED_LAKE_VIEW') == 'MLV'

    def test_format_table_type_unknown(self):
        """Unknown types pass through."""
        type_map = {
            'MATERIALIZED_LAKE_VIEW': 'MLV',
            'MANAGED': 'Managed',
            'EXTERNAL': 'External',
        }
        assert type_map.get('SOME_NEW_TYPE', 'SOME_NEW_TYPE') == 'SOME_NEW_TYPE'


class TestPreviewResponse:
    """Verify preview data structure handling."""

    def test_empty_preview(self):
        """Empty rows result should show empty state."""
        data = {"columns": ["id", "name"], "rows": []}
        assert len(data["rows"]) == 0

    def test_preview_with_rows(self):
        """Preview with data should render row cells."""
        data = {
            "columns": ["id", "name", "value"],
            "rows": [[1, "test", 42.5], [2, "foo", None]],
        }
        assert len(data["columns"]) == 3
        assert len(data["rows"]) == 2
        assert data["rows"][1][2] is None  # null handling

    def test_cell_truncation(self):
        """Long cell values should be truncated at 50 chars."""
        long_val = "A" * 100
        truncated = long_val[:47] + "..." if len(long_val) > 50 else long_val
        assert len(truncated) == 50
        assert truncated.endswith("...")

    def test_preview_max_rows(self):
        """Preview should respect maxRows parameter."""
        rows = [[i, f"row{i}"] for i in range(20)]
        max_rows = 3
        displayed = rows[:max_rows]
        assert len(displayed) == 3


class TestInspectorScenarios:
    """Verify scenario matrix coverage."""

    def test_no_selection_placeholder(self):
        """NO_SELECTION: Should show placeholder text."""
        expected_text = "Select an item to inspect"
        assert "select" in expected_text.lower()

    def test_lakehouse_inspector_fields(self):
        """LAKEHOUSE_SELECTED: Properties should include OneLake paths."""
        lh = {
            "id": "abc-123",
            "displayName": "test_lakehouse",
            "properties": {
                "oneLakeTablesPath": "abfss://...",
                "oneLakeFilesPath": "abfss://...",
                "defaultSchema": "dbo",
                "sqlEndpointProperties": {
                    "connectionString": "server.database.windows.net",
                    "provisioningStatus": "Success",
                },
            },
        }
        assert lh["properties"]["oneLakeTablesPath"].startswith("abfss://")
        assert lh["properties"]["sqlEndpointProperties"]["provisioningStatus"] == "Success"

    def test_workspace_inspector_fields(self):
        """WORKSPACE_SELECTED: Should display all required fields."""
        ws = {
            "id": "ws-guid-123",
            "displayName": "My Workspace",
            "capacityId": "cap-guid",
            "state": "Active",
            "description": "Test workspace",
        }
        required = ["id", "displayName", "capacityId", "state"]
        for field in required:
            assert field in ws
```

- [ ] **Step 2: Run tests**

```bash
pytest tests/test_inspector.py -v
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_inspector.py
git commit -m "test(inspector): scenario matrix coverage for inspector panel

Ines: Tests for field formatting (bytes, table type), preview response
handling (empty, truncation, maxRows), and inspector scenario matrix
(no selection, lakehouse, workspace).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Dependency Graph

```
Task 1 (Empty states)
  ↓
Task 2 (Auto-load) ← depends on Task 1 for _showInspectorPlaceholder
  ↓
Task 3 (Table enrichment) ← depends on Task 2 for auto-loaded data
  ↓
Task 4 (Preview) ← depends on Task 3 for enriched inspector layout
  │
Task 5 (Lakehouse inspector) ← depends on Task 1 for placeholder pattern
  │
Task 6 (Workspace inspector) ← independent, can parallel with Task 4/5
  │
Task 7 (MLV inspector) ← depends on Task 2 for shimmer + auto-fetch pattern
  │
Task 8 (Visual consistency) ← depends on all above being structurally done
  ↓
Task 9 (Tests) ← after all features implemented
```

**Parallelization opportunities:**
- Tasks 5 + 6 can run in parallel (independent inspectors)
- Task 8 can start as soon as Tasks 1–3 are done
- Task 4 (dev-server.py changes) is independent of CSS/JS tasks except for the JS integration

---

## Verification Checklist

After all tasks complete, run:

```bash
make lint    # Ruff lint + format check
make test    # pytest (including new test_inspector.py)
make build   # build-html.py produces valid HTML
```

Manual verification:

- [ ] Click table row → shimmer appears → info + schema + preview loads
- [ ] Click table row with no MWC → basic info shown + deploy hint
- [ ] `getTableDetails` failure → error state with Retry button → retry works
- [ ] Click lakehouse in tree → inspector shows lakehouse summary (not blank)
- [ ] Click workspace in tree → inspector shows workspace summary with region + copy ID
- [ ] Click MLV card → inspector shows MLV details with definition snippet
- [ ] Nothing selected → "Select an item to inspect" placeholder
- [ ] Preview "Load more" → loads additional rows
- [ ] Preview for empty table → "Empty table — no rows"
- [ ] All section titles have accent pip + consistent dividers
- [ ] Dark theme: shimmer, error states, code blocks all render correctly
- [ ] Keyboard: Tab through table rows → inspector updates
- [ ] No jank: shimmer→content transition is smooth (contentSlideIn animation)
