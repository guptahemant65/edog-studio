# Notebook Mini IDE + Item Type Views — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a notebook mini IDE inside the workspace explorer and type-specific content views for Notebooks, Environments, and generic items — production-grade, HIVEMIND standards.

**Architecture:** When a user clicks a Notebook in the tree, the content+inspector panels are replaced by a full notebook IDE showing parsed cells with editing, save, and run-all. Environments get a publish-status card view. Other items get clean info cards. Server-side LRO handling for notebook getDefinition/updateDefinition/run. Client-side notebook-content.sql parser.

**Tech Stack:** Vanilla JS (class-based modules), CSS custom properties (OKLCH + existing tokens), Python dev-server endpoints, 4px grid, no frameworks.

---

## API Audit — Every Component Verified

| Design Component | API / Data Source | Status | Notes |
|---|---|---|---|
| Notebook list + properties | `GET /v1/workspaces/{wsId}/notebooks` | ✅ Tested | Returns attachedEnvironment, defaultLakehouse, primaryWarehouse |
| Read notebook cells | `POST .../notebooks/{nbId}/getDefinition` → LRO | ✅ Tested | 202 → poll → base64 `notebook-content.sql` (5-8s) |
| Save notebook cells | `POST .../notebooks/{nbId}/updateDefinition` | ✅ Tested | Accepts definition payload |
| Run notebook (batch) | `POST .../items/{nbId}/jobs/instances?jobType=RunNotebook` | ✅ Tested | 202 LRO → poll status |
| Cancel notebook run | `POST .../jobs/instances/{jobId}/cancel` | ✅ Tested | 202 |
| Run status polling | `GET .../items/{nbId}/jobs/instances/{jobId}` | ✅ Tested | Returns status, failureReason, startTimeUtc, endTimeUtc |
| Environment list + publish status | `GET /v1/workspaces/{wsId}/environments` | ✅ Tested | publishDetails.state, componentPublishInfo, targetVersion |
| Generic item data | `GET /v1/workspaces/{wsId}/items` | ✅ Tested | displayName, id, type, description, workspaceId |
| Rename/Delete items | `PATCH/DELETE /v1/workspaces/{wsId}/items/{id}` | ✅ Exists | Already in api-client.js |
| Linked item resolution | Cross-ref notebook.properties → workspace children | ✅ Data available | Resolve from `_children[wsId]` cache |
| Per-cell execution output | Jupyter WebSocket protocol (MwcToken) | ⚠️ DEFERRED | Complex protocol — MVP uses Run All (batch) only |
| Environment switching | Update notebook attached env | ⚠️ DEFERRED | Read-only in MVP — show current, list available |
| Cell drag reorder | Pure frontend (no API) | ✅ Client-side | Array manipulation + DOM reorder |
| Dirty tracking / save | Client-side diff + updateDefinition | ✅ Available | Compare parsed vs current cells |

**MVP Scope Decision:** Per-cell Jupyter execution deferred to V2 (requires WebSocket + kernel protocol). Environment switching deferred (read-only display). Everything else ships.

---

## File Structure

### New Files

| File | Owner | Responsibility |
|---|---|---|
| `src/frontend/js/notebook-parser.js` | Zara | Parse/serialize `notebook-content.sql` ↔ cell array |
| `src/frontend/js/notebook-view.js` | Zara | NotebookView class — IDE UI, cell rendering, toolbar, run flow |
| `src/frontend/css/notebook.css` | Mika | All notebook IDE styles (cells, toolbar, status bar, between-cell) |

### Modified Files

| File | Owner | Changes |
|---|---|---|
| `src/frontend/js/api-client.js` | Zara | Add notebook + environment API methods (6 methods) |
| `src/frontend/js/workspace-explorer.js` | Zara | Type-specific content dispatching, linked item cards, environment view, generic view |
| `src/frontend/css/workspace.css` | Mika | Linked item card styles, environment publish status, generic item view |
| `scripts/dev-server.py` | Elena | Notebook LRO endpoints (content, save, run, status, cancel) |
| `scripts/build-html.py` | Ren | Add `notebook.css` + `notebook-parser.js` + `notebook-view.js` to build order |
| `tests/test_notebook_endpoints.py` | Ines | Server endpoint tests |

---

## Task 1: Server — Notebook Content LRO Endpoint

**Files:**
- Modify: `scripts/dev-server.py`
- Test: `tests/test_notebook_endpoints.py`

This endpoint handles the entire getDefinition LRO dance server-side so the client makes one call and gets cell content back.

- [ ] **Step 1: Add notebook content endpoint to dev-server.py**

In `do_GET`, add route. In `do_POST`, add routes for save/run/cancel. Add five handler methods:

```python
# In do_GET:
elif self.path.startswith("/api/notebook/content"):
    self._serve_notebook_content()
elif self.path.startswith("/api/notebook/run-status"):
    self._serve_notebook_run_status()

# In do_POST:
elif self.path == "/api/notebook/save":
    self._serve_notebook_save()
elif self.path == "/api/notebook/run":
    self._serve_notebook_run()
elif self.path == "/api/notebook/cancel":
    self._serve_notebook_cancel()
```

- [ ] **Step 2: Implement `_serve_notebook_content` (LRO handler)**

```python
def _serve_notebook_content(self):
    """GET /api/notebook/content?wsId=&nbId= — fetch notebook cells via LRO."""
    params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
    ws_id = params.get("wsId", [None])[0]
    nb_id = params.get("nbId", [None])[0]
    if not ws_id or not nb_id:
        self._json_error(400, "Missing wsId or nbId")
        return

    bearer = self._get_bearer()
    if not bearer:
        self._json_error(401, "No bearer token available")
        return

    base = REDIRECT_HOST
    headers = {
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
    }

    # Step 1: POST getDefinition → 202 + Location
    url = f"{base}/v1/workspaces/{ws_id}/notebooks/{nb_id}/getDefinition"
    req = urllib.request.Request(url, data=b'{}', headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        if e.code == 202:
            location = e.headers.get("Location", "")
            retry_after = int(e.headers.get("Retry-After", "2"))
        else:
            self._json_error(e.code, f"getDefinition failed: {e.read().decode()}")
            return

    # Step 2: Poll operation until Succeeded
    import time
    for attempt in range(30):  # Max 60 seconds
        time.sleep(retry_after if attempt == 0 else 2)
        poll_req = urllib.request.Request(location, headers=headers)
        try:
            poll_resp = urllib.request.urlopen(poll_req, timeout=15)
            poll_data = json.loads(poll_resp.read().decode())
            status = poll_data.get("status", "")
            if status == "Succeeded":
                break
            if status in ("Failed", "Undefined"):
                self._json_error(500, f"getDefinition failed: {poll_data.get('error', {})}")
                return
        except urllib.error.HTTPError as e:
            if e.code != 200:
                self._json_error(502, f"Poll error: {e.code}")
                return
    else:
        self._json_error(504, "getDefinition timed out after 60s")
        return

    # Step 3: GET result
    result_url = location + "/result"
    result_req = urllib.request.Request(result_url, headers=headers)
    result_resp = urllib.request.urlopen(result_req, timeout=15)
    result_data = json.loads(result_resp.read().decode())

    # Step 4: Decode base64 parts
    parts = result_data.get("definition", {}).get("parts", [])
    decoded = {}
    for part in parts:
        path = part.get("path", "")
        payload = part.get("payload", "")
        try:
            import base64
            decoded[path] = base64.b64decode(payload).decode("utf-8")
        except Exception:
            decoded[path] = payload

    self._json_response(200, {
        "content": decoded.get("notebook-content.sql", ""),
        "platform": decoded.get(".platform", ""),
        "allParts": [{"path": p["path"], "payloadType": p.get("payloadType")} for p in parts],
    })
```

- [ ] **Step 3: Implement `_serve_notebook_save`**

```python
def _serve_notebook_save(self):
    """POST /api/notebook/save — update notebook definition."""
    body = self._read_json_body()
    ws_id = body.get("wsId")
    nb_id = body.get("nbId")
    content = body.get("content", "")
    platform = body.get("platform", "")

    if not ws_id or not nb_id:
        self._json_error(400, "Missing wsId or nbId")
        return

    bearer = self._get_bearer()
    if not bearer:
        self._json_error(401, "No bearer token")
        return

    import base64
    parts = [
        {
            "path": "notebook-content.sql",
            "payload": base64.b64encode(content.encode("utf-8")).decode(),
            "payloadType": "InlineBase64",
        },
    ]
    if platform:
        parts.append({
            "path": ".platform",
            "payload": base64.b64encode(platform.encode("utf-8")).decode(),
            "payloadType": "InlineBase64",
        })

    payload = json.dumps({"definition": {"parts": parts}}).encode()
    url = f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/notebooks/{nb_id}/updateDefinition"
    headers = {
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        self._json_response(200, {"status": "saved"})
    except urllib.error.HTTPError as e:
        self._json_error(e.code, f"Save failed: {e.read().decode()[:500]}")
```

- [ ] **Step 4: Implement `_serve_notebook_run` and `_serve_notebook_run_status` and `_serve_notebook_cancel`**

```python
def _serve_notebook_run(self):
    """POST /api/notebook/run — start notebook execution via Job Scheduler."""
    body = self._read_json_body()
    ws_id = body.get("wsId")
    nb_id = body.get("nbId")
    if not ws_id or not nb_id:
        self._json_error(400, "Missing wsId or nbId")
        return

    bearer = self._get_bearer()
    if not bearer:
        self._json_error(401, "No bearer token")
        return

    url = f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/items/{nb_id}/jobs/instances?jobType=RunNotebook"
    headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=b'{}', headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        # 202 → extract job URL from Location header
        location = resp.headers.get("Location", "")
        self._json_response(202, {"location": location, "status": "started"})
    except urllib.error.HTTPError as e:
        if e.code == 202:
            location = e.headers.get("Location", "")
            self._json_response(202, {"location": location, "status": "started"})
        else:
            self._json_error(e.code, f"Run failed: {e.read().decode()[:500]}")

def _serve_notebook_run_status(self):
    """GET /api/notebook/run-status?location=<url> — poll job status."""
    params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
    location = params.get("location", [None])[0]
    if not location:
        self._json_error(400, "Missing location parameter")
        return

    bearer = self._get_bearer()
    if not bearer:
        self._json_error(401, "No bearer token")
        return

    headers = {"Authorization": f"Bearer {bearer}"}
    req = urllib.request.Request(location, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
        self._json_response(200, data)
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        self._json_error(e.code, f"Status check failed: {body}")

def _serve_notebook_cancel(self):
    """POST /api/notebook/cancel — cancel running notebook job."""
    body = self._read_json_body()
    location = body.get("location", "")
    if not location:
        self._json_error(400, "Missing location")
        return

    bearer = self._get_bearer()
    if not bearer:
        self._json_error(401, "No bearer token")
        return

    cancel_url = location.rstrip("/") + "/cancel"
    headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
    req = urllib.request.Request(cancel_url, data=b'{}', headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        self._json_response(200, {"status": "cancelled"})
    except urllib.error.HTTPError as e:
        if e.code == 202:
            self._json_response(200, {"status": "cancelled"})
        else:
            self._json_error(e.code, f"Cancel failed: {e.read().decode()[:500]}")
```

- [ ] **Step 5: Add helper methods `_get_bearer`, `_read_json_body`, `_json_response`, `_json_error`**

Check if these already exist in dev-server.py. If not, add:

```python
def _get_bearer(self):
    """Read bearer token from cache file."""
    bearer, _ = _read_cache(BEARER_CACHE)
    return bearer

def _read_json_body(self):
    """Read and parse JSON request body."""
    length = int(self.headers.get("Content-Length", 0))
    body = self.rfile.read(length).decode() if length else "{}"
    return json.loads(body)

def _json_response(self, code, data):
    """Send JSON response."""
    payload = json.dumps(data).encode()
    self.send_response(code)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(payload)))
    self.end_headers()
    self.wfile.write(payload)

def _json_error(self, code, message):
    """Send JSON error response."""
    self._json_response(code, {"error": message})
```

- [ ] **Step 6: Test server endpoints**

Run: `python scripts/dev-server.py` and verify the endpoints respond correctly.

- [ ] **Step 7: Commit**

```bash
git add scripts/dev-server.py
git commit -m "feat(server): notebook content/save/run LRO endpoints

Server-side handling of Fabric LRO dance for notebook getDefinition,
updateDefinition, job scheduler run/cancel/status polling.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: JS — Notebook Content Parser

**Files:**
- Create: `src/frontend/js/notebook-parser.js`

Pure-logic module. Parses `notebook-content.sql` format into a cell array and serializes back.

- [ ] **Step 1: Create NotebookParser class**

```javascript
/**
 * NotebookParser — Parse and serialize Fabric notebook-content.sql format.
 *
 * Format:
 *   -- Fabric notebook source
 *   -- METADATA **  (notebook-level)
 *   -- META { json }
 *   -- MARKDOWN **  (markdown cell)
 *   -- content lines (prefixed with "-- ")
 *   -- CELL **  (code cell)
 *   -- code lines (SQL default, or "-- MAGIC %%lang" prefix)
 *   -- METADATA **  (cell-level, follows cell)
 *   -- META { json }
 *
 * Returns: { notebookMeta: object, cells: [{type, language, content, meta}] }
 */
class NotebookParser {
  /**
   * Parse notebook-content.sql text into structured cell array.
   * @param {string} raw - Raw notebook-content.sql text.
   * @returns {{ notebookMeta: object, cells: Array<{type: string, language: string, content: string, meta: object}> }}
   */
  static parse(raw) {
    const lines = raw.split('\n');
    const result = { notebookMeta: {}, cells: [] };
    let currentBlock = null; // 'notebook-meta' | 'markdown' | 'cell' | 'cell-meta'
    let currentContent = [];
    let currentMeta = {};
    let currentType = null;
    let pendingCellForMeta = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect section boundaries
      if (line.startsWith('-- METADATA **')) {
        // Flush previous block
        if (currentBlock === 'markdown' || currentBlock === 'cell') {
          const cell = NotebookParser._flushCell(currentBlock, currentContent, currentMeta);
          result.cells.push(cell);
          pendingCellForMeta = cell;
          currentContent = [];
          currentMeta = {};
        }
        currentBlock = result.cells.length === 0 && !pendingCellForMeta ? 'notebook-meta' : 'cell-meta';
        continue;
      }

      if (line.startsWith('-- MARKDOWN **')) {
        if (currentBlock === 'markdown' || currentBlock === 'cell') {
          const cell = NotebookParser._flushCell(currentBlock, currentContent, currentMeta);
          result.cells.push(cell);
          pendingCellForMeta = null;
        }
        currentBlock = 'markdown';
        currentContent = [];
        currentMeta = {};
        continue;
      }

      if (line.startsWith('-- CELL **')) {
        if (currentBlock === 'markdown' || currentBlock === 'cell') {
          const cell = NotebookParser._flushCell(currentBlock, currentContent, currentMeta);
          result.cells.push(cell);
          pendingCellForMeta = null;
        }
        currentBlock = 'cell';
        currentContent = [];
        currentMeta = {};
        continue;
      }

      // Collect content based on current block
      if (currentBlock === 'notebook-meta' || currentBlock === 'cell-meta') {
        if (line.startsWith('-- META ')) {
          const jsonStr = line.substring('-- META '.length);
          try {
            const meta = JSON.parse(jsonStr);
            if (currentBlock === 'notebook-meta') {
              result.notebookMeta = meta;
            } else if (pendingCellForMeta) {
              pendingCellForMeta.meta = meta;
              // Extract language from meta
              if (meta.language) {
                pendingCellForMeta.language = meta.language;
              }
            }
          } catch (e) {
            // Malformed meta — skip
          }
        }
        continue;
      }

      if (currentBlock === 'markdown') {
        // Markdown lines are prefixed with "-- "
        currentContent.push(line.startsWith('-- ') ? line.substring(3) : line);
      } else if (currentBlock === 'cell') {
        currentContent.push(line);
      }
    }

    // Flush final block
    if (currentBlock === 'markdown' || currentBlock === 'cell') {
      result.cells.push(NotebookParser._flushCell(currentBlock, currentContent, currentMeta));
    }

    return result;
  }

  /** Flush accumulated lines into a cell object. */
  static _flushCell(type, contentLines, meta) {
    const cellType = type === 'markdown' ? 'markdown' : 'code';
    let language = 'sparksql'; // Default
    let content = '';

    if (cellType === 'code') {
      // Check first line for MAGIC language override
      const lines = contentLines.slice();
      if (lines.length > 0 && lines[0].startsWith('-- MAGIC %%')) {
        const langLine = lines.shift();
        language = langLine.replace('-- MAGIC %%', '').trim();
        // Remaining MAGIC lines: strip "-- MAGIC " prefix
        content = lines.map(l => l.startsWith('-- MAGIC ') ? l.substring('-- MAGIC '.length) : l).join('\n');
      } else {
        content = lines.join('\n');
      }
    } else {
      content = contentLines.join('\n');
    }

    // Trim trailing empty lines
    content = content.replace(/\n+$/, '');

    return { type: cellType, language, content, meta: meta || {} };
  }

  /**
   * Serialize structured cells back to notebook-content.sql format.
   * @param {{ notebookMeta: object, cells: Array }} notebook
   * @returns {string} Raw notebook-content.sql text.
   */
  static serialize(notebook) {
    const lines = ['-- Fabric notebook source'];

    // Notebook-level metadata
    lines.push('-- METADATA ********************');
    lines.push(`-- META ${JSON.stringify(notebook.notebookMeta)}`);
    lines.push('');

    for (const cell of notebook.cells) {
      if (cell.type === 'markdown') {
        lines.push('-- MARKDOWN ********************');
        for (const line of cell.content.split('\n')) {
          lines.push(`-- ${line}`);
        }
      } else {
        lines.push('-- CELL ********************');
        if (cell.language && cell.language !== 'sparksql') {
          lines.push(`-- MAGIC %%${cell.language}`);
          for (const line of cell.content.split('\n')) {
            lines.push(`-- MAGIC ${line}`);
          }
        } else {
          lines.push(cell.content);
        }
      }

      // Cell metadata
      if (cell.meta && Object.keys(cell.meta).length > 0) {
        lines.push('');
        lines.push('-- METADATA ********************');
        lines.push(`-- META ${JSON.stringify(cell.meta)}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}
```

- [ ] **Step 2: Verify parser handles the known format**

Open browser console with the built HTML and test:
```javascript
const raw = `-- Fabric notebook source
-- METADATA ********************
-- META {"kernel_info":{"name":"synapse_pyspark"}}

-- MARKDOWN ********************
-- # Create materialized lake views
-- Select Run all to run the notebook.

-- CELL ********************
CREATE MATERIALIZED lake VIEW dbo.mvFromOne
AS SELECT * from dbo.numTen;

-- METADATA ********************
-- META {"language":"sparksql","language_group":"synapse_pyspark"}

-- CELL ********************
-- MAGIC %%pyspark
-- MAGIC from notebookutils import mssparkutils
-- MAGIC import zlib, json

-- METADATA ********************
-- META {"language":"python","language_group":"synapse_pyspark"}`;

const result = NotebookParser.parse(raw);
console.log('Cells:', result.cells.length); // Expected: 3
console.log('Cell 0 type:', result.cells[0].type); // markdown
console.log('Cell 1 language:', result.cells[1].language); // sparksql
console.log('Cell 2 language:', result.cells[2].language); // pyspark

// Round-trip test
const serialized = NotebookParser.serialize(result);
const reparsed = NotebookParser.parse(serialized);
console.log('Round-trip cells:', reparsed.cells.length); // 3
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/notebook-parser.js
git commit -m "feat(notebook): content parser for notebook-content.sql format

Parses Fabric notebook-content.sql into structured cell array (type,
language, content, meta). Handles MARKDOWN, CELL, MAGIC prefix, and
META blocks. Round-trip serialize support for save flow.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: JS — API Client Extensions

**Files:**
- Modify: `src/frontend/js/api-client.js`

Add notebook and environment methods to FabricApiClient.

- [ ] **Step 1: Add notebook API methods**

Add after the existing CRUD section (after `createLakehouse`):

```javascript
  // --- Notebook APIs ---

  /**
   * List notebooks in a workspace with properties (defaultLakehouse, attachedEnvironment).
   * @param {string} workspaceId
   * @returns {Promise<{value: Array}>}
   */
  async listNotebooks(workspaceId) {
    return this._fabricGet(`/workspaces/${workspaceId}/notebooks`);
  }

  /**
   * Fetch notebook cell content via server-side LRO handler.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @returns {Promise<{content: string, platform: string}>}
   */
  async getNotebookContent(workspaceId, notebookId) {
    const params = `wsId=${workspaceId}&nbId=${notebookId}`;
    const resp = await fetch(`/api/notebook/content?${params}`);
    if (!resp.ok) {
      const err = new Error(`Notebook content fetch failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Save notebook cell content via server-side handler.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @param {string} content - Raw notebook-content.sql text.
   * @param {string} [platform] - Optional .platform JSON string.
   */
  async saveNotebookContent(workspaceId, notebookId, content, platform = '') {
    const resp = await fetch('/api/notebook/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId, content, platform }),
    });
    if (!resp.ok) {
      const err = new Error(`Notebook save failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Start notebook execution via Job Scheduler.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @returns {Promise<{location: string, status: string}>}
   */
  async runNotebook(workspaceId, notebookId) {
    const resp = await fetch('/api/notebook/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId }),
    });
    if (!resp.ok) {
      const err = new Error(`Notebook run failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Poll notebook run status.
   * @param {string} locationUrl - Job status URL from runNotebook response.
   * @returns {Promise<{status: string, failureReason?: string, startTimeUtc?: string, endTimeUtc?: string}>}
   */
  async getNotebookRunStatus(locationUrl) {
    const resp = await fetch(`/api/notebook/run-status?location=${encodeURIComponent(locationUrl)}`);
    if (!resp.ok) return { status: 'Unknown' };
    return resp.json();
  }

  /**
   * Cancel a running notebook job.
   * @param {string} locationUrl - Job status URL.
   */
  async cancelNotebookRun(locationUrl) {
    const resp = await fetch('/api/notebook/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: locationUrl }),
    });
    if (!resp.ok) {
      const err = new Error(`Cancel failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  // --- Environment APIs ---

  /**
   * List environments in a workspace with publish details.
   * @param {string} workspaceId
   * @returns {Promise<{value: Array}>}
   */
  async listEnvironments(workspaceId) {
    return this._fabricGet(`/workspaces/${workspaceId}/environments`);
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/js/api-client.js
git commit -m "feat(api): notebook + environment API methods

listNotebooks, getNotebookContent (LRO), saveNotebookContent,
runNotebook, getNotebookRunStatus, cancelNotebookRun, listEnvironments.
Server-side LRO handling keeps client simple.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: CSS — Notebook IDE Styles

**Files:**
- Create: `src/frontend/css/notebook.css`

All notebook cell, toolbar, status bar, and between-cell styles. Uses existing design tokens and extends the design bible §20b base.

- [ ] **Step 1: Create notebook.css with all component styles**

Create `src/frontend/css/notebook.css` with styles for:
- `.nb-ide` — IDE container (replaces content+inspector)
- `.nb-toolbar` — Toolbar bar with actions and context row
- `.nb-toolbar-title` — Editable notebook name
- `.nb-toolbar-actions` — Button row (Run All, Save, Add Cell, Refresh)
- `.nb-toolbar-context` — Context chips (lakehouse, environment, kernel)
- `.nb-context-chip` — Individual clickable chip
- `.nb-dirty-dot` — Orange dot next to title when modified
- `.nb-cells` — Scrollable cell container
- `.nb-cell` — Cell container (extends bible §20b)
- `.nb-cell.selected` — Selected cell state (accent left border)
- `.nb-cell-header` — Cell header with number, language badge, run button
- `.nb-lang-badge` — Language badge (SQL=amber, Python=green, Markdown=blue)
- `.nb-code-area` — Code editing area (textarea)
- `.nb-line-numbers` — Gutter with line numbers
- `.nb-output` — Output area below cell
- `.nb-output-table` — Table output formatting
- `.nb-output-error` — Error output with red tint
- `.nb-output-empty` — "Click Run to execute" prompt
- `.nb-between-cell` — Between-cell add button zone
- `.nb-add-cell-btn` — The "+" button
- `.nb-add-dropdown` — Cell type dropdown
- `.nb-cell-menu` — More menu (⋯)
- `.nb-status-bar` — Bottom status bar (run progress)
- `.nb-md-rendered` — Rendered markdown view
- `.nb-md-edit` — Markdown edit mode

Use `var(--space-*)` for all spacing, `var(--text-*)` for font sizes, existing semantic colors. No hardcoded values. No emoji.

Key measurements from design bible §20b:
- Cell header: 8px 12px padding, 11px font
- Code area: 12px 16px padding, 12px mono font, 1.6 line-height
- Output area: 12px 16px padding, 12px mono font
- Cell border-radius: var(--radius-md) (6px)
- Cell gap: 8px (var(--space-2))

- [ ] **Step 2: Commit**

```bash
git add src/frontend/css/notebook.css
git commit -m "feat(css): notebook IDE styles — cells, toolbar, status bar

Complete styling for notebook mini IDE: cell states (idle, selected,
running, success, error), toolbar with context chips, between-cell
add button, status bar, markdown rendered/edit modes.
4px grid, OKLCH-compatible, extends design bible §20b.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: CSS — Item Type View Styles

**Files:**
- Modify: `src/frontend/css/workspace.css`

Add styles for linked item cards, environment content view, and generic item views.

- [ ] **Step 1: Add linked item card styles**

Append to workspace.css:

```css
/* ── Linked Item Cards ── */
.ws-linked-cards {
  display: flex; gap: var(--space-3); flex-wrap: wrap;
  margin: var(--space-4) 0;
}
.ws-linked-card {
  flex: 0 1 220px; padding: var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  cursor: pointer; transition: all var(--transition-fast);
  background: var(--surface);
}
.ws-linked-card:hover {
  border-color: var(--accent); box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}
.ws-linked-card-header {
  display: flex; align-items: center; gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.ws-linked-card-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.ws-linked-card-name {
  font-size: var(--text-sm); font-weight: 600; color: var(--text);
}
.ws-linked-card-label {
  font-size: var(--text-xs); color: var(--text-muted); margin-bottom: var(--space-1);
}
.ws-linked-card-id {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-muted);
}
```

- [ ] **Step 2: Add environment publish status styles**

```css
/* ── Environment Content View ── */
.ws-env-publish {
  border: 1px solid var(--border); border-radius: var(--radius-md);
  overflow: hidden; margin: var(--space-4) 0;
}
.ws-env-publish-header {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
  font-size: var(--text-xs); font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.ws-env-publish-body { padding: var(--space-3) var(--space-4); }
.ws-status-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-1) 0; font-size: var(--text-sm);
}
.ws-status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.ws-status-dot.success { background: var(--status-succeeded); }
.ws-status-dot.running { background: var(--level-warning); animation: pulse-dot 1.5s infinite; }
.ws-status-dot.failed { background: var(--status-failed); }
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.ws-status-label { color: var(--text-dim); min-width: 120px; }
.ws-status-value { color: var(--text); font-weight: 500; }
.ws-status-value.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
```

- [ ] **Step 3: Add generic item view styles**

```css
/* ── Generic Item Info Card ── */
.ws-item-info {
  border: 1px solid var(--border); border-radius: var(--radius-md);
  margin: var(--space-4) 0; overflow: hidden;
}
.ws-item-info-header {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
  font-size: var(--text-xs); font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.ws-item-info-body { padding: var(--space-3) var(--space-4); }
.ws-item-info-row {
  display: flex; padding: var(--space-1) 0;
  font-size: var(--text-sm); border-bottom: 1px solid var(--border);
}
.ws-item-info-row:last-child { border-bottom: none; }
.ws-item-info-key {
  width: 140px; flex-shrink: 0; color: var(--text-muted); font-weight: 500;
}
.ws-item-info-val { color: var(--text); flex: 1; word-break: break-all; }
.ws-fabric-link {
  display: inline-flex; align-items: center; gap: var(--space-1);
  font-size: var(--text-xs); color: var(--text-muted);
  margin-top: var(--space-3); text-decoration: none;
}
.ws-fabric-link:hover { color: var(--accent); }
```

- [ ] **Step 4: Commit**

```bash
git add src/frontend/css/workspace.css
git commit -m "feat(css): linked item cards, environment status, generic item views

Styles for notebook→lakehouse/environment linked cards with hover lift,
environment publish status with component breakdown, generic item
info cards for SQLEndpoint/Report/SemanticModel/Pipeline.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: JS — Type-Specific Content Views in Workspace Explorer

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js`

Replace `_showItemContent()` with type-aware dispatcher. Add notebook, environment, and generic views.

- [ ] **Step 1: Add type caches to constructor**

In the constructor, after `this._currentTables = null;`, add:

```javascript
    /** @type {Object<string, object[]>} Notebook properties cache per workspace */
    this._notebookCache = {};
    /** @type {Object<string, object[]>} Environment properties cache per workspace */
    this._environmentCache = {};
    /** @type {string|null} Platform metadata for last fetched notebook */
    this._lastPlatform = null;
```

- [ ] **Step 2: Replace `_showItemContent` with type dispatcher**

Replace the existing `_showItemContent(item, ws)` method:

```javascript
  _showItemContent(item, ws) {
    if (!this._contentEl) return;
    const type = (item.type || '').toLowerCase();

    if (type === 'notebook') {
      this._showNotebookContent(item, ws);
    } else if (type === 'environment') {
      this._showEnvironmentContent(item, ws);
    } else if (type === 'lakehouse') {
      // Existing lakehouse logic — don't change
      this._showLakehouseContent(item, ws);
    } else {
      this._showGenericItemContent(item, ws);
    }
  }
```

Note: The existing lakehouse content rendering code stays as-is. We're adding new paths for Notebook, Environment, and generic items.

- [ ] **Step 3: Implement `_showNotebookContent`**

```javascript
  async _showNotebookContent(item, ws) {
    // Fetch notebook properties (cached per workspace)
    let nbData = null;
    if (!this._notebookCache[ws.id]) {
      try {
        const resp = await this._api.listNotebooks(ws.id);
        this._notebookCache[ws.id] = resp.value || [];
      } catch (e) {
        this._notebookCache[ws.id] = [];
      }
    }
    nbData = this._notebookCache[ws.id].find(n => n.id === item.id);

    const props = nbData?.properties || {};
    const defaultLH = props.defaultLakehouse;
    const attachedEnv = props.attachedEnvironment;

    // Build rich header
    let html = this._buildRichHeader(item, ws);

    // Action bar
    html += '<div class="ws-content-actions">';
    html += `<button class="ws-action-btn accent" data-action="open-notebook-ide">Open Notebook IDE</button>`;
    html += `<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>`;
    html += `<button class="ws-action-btn" data-action="rename-item" data-id="${this._esc(item.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-id="${this._esc(item.id)}">Delete</button>`;
    html += '</div>';

    // Linked items
    if (defaultLH || attachedEnv) {
      html += '<div class="ws-linked-cards">';
      if (defaultLH) {
        const lhName = this._resolveItemName(ws.id, defaultLH.itemId) || 'Lakehouse';
        html += this._buildLinkedCard(lhName, 'Default Lakehouse', 'LH', defaultLH.itemId, 'var(--status-succeeded)', defaultLH.itemId);
      }
      if (attachedEnv) {
        const envName = this._resolveItemName(ws.id, attachedEnv.itemId) || 'Environment';
        html += this._buildLinkedCard(envName, 'Attached Environment', 'ENV', attachedEnv.itemId, 'var(--comp-onelake)', attachedEnv.itemId);
      }
      html += '</div>';
    }

    // Notebook info card
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Notebook Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Default Lakehouse', defaultLH ? (this._resolveItemName(ws.id, defaultLH.itemId) || defaultLH.itemId) : '\u2014');
    html += this._infoRow('Attached Environment', attachedEnv ? (this._resolveItemName(ws.id, attachedEnv.itemId) || attachedEnv.itemId) : '\u2014');
    html += this._infoRow('Description', item.description || '\u2014');
    html += '</div></div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._bindLinkedCardClicks(ws);
    this._showItemInspector(item, ws, { defaultLH, attachedEnv });
  }
```

- [ ] **Step 4: Implement `_showEnvironmentContent`**

```javascript
  async _showEnvironmentContent(item, ws) {
    // Fetch environment properties (cached per workspace)
    if (!this._environmentCache[ws.id]) {
      try {
        const resp = await this._api.listEnvironments(ws.id);
        this._environmentCache[ws.id] = resp.value || [];
      } catch (e) {
        this._environmentCache[ws.id] = [];
      }
    }
    const envData = this._environmentCache[ws.id].find(e => e.id === item.id);
    const props = envData?.properties || {};
    const publish = props.publishDetails || {};
    const state = publish.state || 'Unknown';

    let html = this._buildRichHeader(item, ws);

    // Action bar
    html += '<div class="ws-content-actions">';
    html += `<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>`;
    html += `<button class="ws-action-btn" data-action="rename-item" data-id="${this._esc(item.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-id="${this._esc(item.id)}">Delete</button>`;
    html += '</div>';

    // Publish status card
    const stateClass = state === 'Success' ? 'success' : state === 'Running' ? 'running' : 'failed';
    html += '<div class="ws-env-publish"><div class="ws-env-publish-header">Publish Status</div>';
    html += '<div class="ws-env-publish-body">';
    html += `<div class="ws-status-row"><span class="ws-status-dot ${stateClass}"></span><span class="ws-status-label">State</span><span class="ws-status-value">${this._esc(state)}</span></div>`;

    if (publish.targetVersion) {
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:16px">Version</span><span class="ws-status-value mono">${this._esc(publish.targetVersion)}</span></div>`;
    }
    if (publish.startTime) {
      const start = new Date(publish.startTime);
      const end = publish.endTime ? new Date(publish.endTime) : null;
      const duration = end ? ((end - start) / 1000).toFixed(1) + 's' : 'In progress';
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:16px">Published</span><span class="ws-status-value">${start.toLocaleString()}</span></div>`;
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:16px">Duration</span><span class="ws-status-value">${duration}</span></div>`;
    }

    // Component breakdown
    const components = publish.componentPublishInfo || {};
    if (components.sparkLibraries || components.sparkSettings) {
      html += '<div style="margin-top:var(--space-3);font-size:var(--text-xs);font-weight:600;color:var(--text-muted)">Components</div>';
      for (const [name, comp] of Object.entries(components)) {
        const cState = comp?.state || 'Unknown';
        const cClass = cState === 'Success' ? 'success' : cState === 'Running' ? 'running' : 'failed';
        const label = name === 'sparkLibraries' ? 'Spark Libraries' : name === 'sparkSettings' ? 'Spark Settings' : name;
        html += `<div class="ws-status-row"><span class="ws-status-dot ${cClass}"></span><span class="ws-status-label">${label}</span><span class="ws-status-value">${this._esc(cState)}</span></div>`;
      }
    }
    html += '</div></div>';

    // Environment info
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Environment Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Description', item.description || '\u2014');
    html += this._infoRow('Workspace', ws.name || ws.displayName || ws.id);
    html += '</div></div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._showItemInspector(item, ws, { publish });
  }
```

- [ ] **Step 5: Implement `_showGenericItemContent`**

```javascript
  _showGenericItemContent(item, ws) {
    let html = this._buildRichHeader(item, ws);

    // Action bar
    html += '<div class="ws-content-actions">';
    html += `<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>`;
    html += `<button class="ws-action-btn" data-action="rename-item" data-id="${this._esc(item.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-id="${this._esc(item.id)}">Delete</button>`;
    html += '</div>';

    // Info card
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Item Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Type', item.type || 'Unknown');
    html += this._infoRow('Description', item.description || '\u2014');
    html += this._infoRow('Workspace', ws.name || ws.displayName || ws.id);
    html += this._infoRow('ID', item.id);
    html += '</div></div>';

    html += '<a class="ws-fabric-link" href="#" data-action="open-fabric-lh">More details available in Fabric \u2197</a>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._showItemInspector(item, ws, {});
  }
```

- [ ] **Step 6: Add helper methods**

```javascript
  /** Build a rich content header (name, type badge, GUID, description). */
  _buildRichHeader(item, ws) {
    const colors = this._getTypeColor(item.type);
    const badge = this._getTypeBadge(item.type);
    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(item.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-type-badge" style="color:${colors}">${badge}</span>`;
    html += ` <span class="ws-guid" title="Click to copy" data-copy-id="${this._esc(item.id)}">${this._esc(item.id)}</span>`;
    html += '</div>';
    if (item.description) {
      html += `<div style="font-size:var(--text-sm);color:var(--text-dim);margin-top:var(--space-1)">${this._esc(item.description)}</div>`;
    }
    html += '</div>';
    return html;
  }

  /** Build a linked item card. */
  _buildLinkedCard(name, label, typeBadge, id, dotColor, itemId) {
    return `<div class="ws-linked-card" data-navigate-item="${this._esc(itemId)}">
      <div class="ws-linked-card-header">
        <span class="ws-linked-card-dot" style="background:${dotColor}"></span>
        <span class="ws-linked-card-name">${this._esc(name)}</span>
      </div>
      <div class="ws-linked-card-label">${this._esc(label)}</div>
      <div class="ws-linked-card-id">${typeBadge} \u00b7 ${this._esc(id.substring(0, 8))}...</div>
    </div>`;
  }

  /** Build an info row for item info cards. */
  _infoRow(key, value) {
    return `<div class="ws-item-info-row"><span class="ws-item-info-key">${this._esc(key)}</span><span class="ws-item-info-val">${this._esc(value)}</span></div>`;
  }

  /** Resolve item name from workspace children cache. */
  _resolveItemName(wsId, itemId) {
    const children = this._children[wsId] || [];
    const found = children.find(c => c.id === itemId);
    return found ? found.displayName : null;
  }

  /** Bind click handlers for linked item cards — navigate to that item. */
  _bindLinkedCardClicks(ws) {
    if (!this._contentEl) return;
    this._contentEl.querySelectorAll('[data-navigate-item]').forEach(card => {
      card.addEventListener('click', () => {
        const targetId = card.dataset.navigateItem;
        const children = this._children[ws.id] || [];
        const target = children.find(c => c.id === targetId);
        if (target) {
          this._selectItem(target, ws);
          // Also highlight it in the tree
          this._highlightTreeItem(targetId);
        }
      });
    });
  }

  /** Highlight and scroll to a tree item. */
  _highlightTreeItem(itemId) {
    if (!this._treeEl) return;
    this._treeEl.querySelectorAll('.ws-tree-item.selected').forEach(el => el.classList.remove('selected'));
    const target = this._treeEl.querySelector(`[data-item-id="${itemId}"]`);
    if (target) {
      target.classList.add('selected');
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /** Populate inspector for any item type. */
  _showItemInspector(item, ws, extra) {
    if (!this._inspectorEl) return;
    let html = '<div class="ws-insp-section"><div class="ws-insp-title">Item Info</div>';
    html += '<dl class="ws-insp-kv">';
    html += `<dt>Name</dt><dd>${this._esc(item.displayName)}</dd>`;
    html += `<dt>Type</dt><dd>${this._esc(item.type || 'Unknown')}</dd>`;
    html += `<dt>ID</dt><dd style="font-family:var(--font-mono);font-size:10px;word-break:break-all">${this._esc(item.id)}</dd>`;
    html += `<dt>Workspace</dt><dd>${this._esc(ws.name || ws.displayName || ws.id)}</dd>`;
    if (item.description) {
      html += `<dt>Description</dt><dd>${this._esc(item.description)}</dd>`;
    }
    if (extra.defaultLH) {
      const lhName = this._resolveItemName(ws.id, extra.defaultLH.itemId) || extra.defaultLH.itemId;
      html += `<dt>Default LH</dt><dd>${this._esc(lhName)}</dd>`;
    }
    if (extra.attachedEnv) {
      const envName = this._resolveItemName(ws.id, extra.attachedEnv.itemId) || extra.attachedEnv.itemId;
      html += `<dt>Environment</dt><dd>${this._esc(envName)}</dd>`;
    }
    html += '</dl></div>';
    this._inspectorEl.innerHTML = html;
  }
```

- [ ] **Step 7: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(workspace): type-specific content views — notebook, environment, generic

Type dispatcher replaces bare _showItemContent. Notebooks show linked
lakehouse/environment cards with click-to-navigate. Environments show
publish status with component breakdown. Generic items show clean
info cards. Inspector populated for all types.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: JS — NotebookView Class (IDE)

**Files:**
- Create: `src/frontend/js/notebook-view.js`

The main IDE class. Renders cells, handles editing, toolbar, save, run.

- [ ] **Step 1: Create NotebookView class skeleton**

Create `src/frontend/js/notebook-view.js` with the full class implementing:

- `constructor(containerEl, apiClient, workspaceId, notebook)` — stores refs, creates DOM structure
- `async load()` — fetches content, parses cells, renders
- `_renderToolbar()` — notebook name, actions, context chips
- `_renderCells()` — iterates cells, creates cell DOM elements
- `_renderCell(cell, index)` — individual cell with header, code area, output area
- `_renderBetweenCellButton(index)` — "+" button between cells
- `_renderStatusBar()` — bottom bar with run status
- `_onCellEdit(index, newContent)` — marks dirty, updates cell
- `_onCellRun(index)` — for future per-cell, currently triggers Run All
- `async _onRunAll()` — save if dirty → run → poll → update status
- `async _onSave()` — serialize cells → save via API → clear dirty
- `_onAddCell(index, type)` — insert new cell at position
- `_onDeleteCell(index)` — remove cell (with confirm)
- `_onMoveCellUp(index)` / `_onMoveCellDown(index)` — reorder
- `_markDirty()` / `_clearDirty()` — dirty tracking
- `_bindKeyboard()` — Ctrl+S, Ctrl+Enter, Escape
- `destroy()` — cleanup, remove event listeners

Key implementation details:
- Uses `NotebookParser.parse()` and `NotebookParser.serialize()`
- Run All polls every 5 seconds, max 10 minutes
- Code cells use `<textarea>` with Tab=spaces handling
- Markdown cells have view/edit toggle
- Language badges: `sparksql`→amber, `python`/`pyspark`→green, `markdown`→blue
- No emoji — unicode symbols: ▶ (run), ■ (stop), ✕ (delete), ⋯ (more), ● (status)

- [ ] **Step 2: Wire "Open Notebook IDE" button**

In `workspace-explorer.js`, in the `_bindContentActions` method, add a handler for the `open-notebook-ide` action:

```javascript
if (action === 'open-notebook-ide') {
  this._openNotebookIDE(this._selectedItem, this._selectedWorkspace);
}
```

Add the method:

```javascript
  async _openNotebookIDE(item, ws) {
    if (!this._contentEl) return;
    // Hide inspector panel to give notebook full width
    const inspectorPanel = document.getElementById('ws-inspector-panel');
    if (inspectorPanel) inspectorPanel.style.display = 'none';

    // Create notebook view
    this._activeNotebookView = new NotebookView(
      this._contentEl, this._api, ws.id, item
    );
    await this._activeNotebookView.load();
  }
```

And a cleanup handler when navigating away from the notebook:

```javascript
  // In _selectItem, before showing new content:
  if (this._activeNotebookView) {
    this._activeNotebookView.destroy();
    this._activeNotebookView = null;
    const inspectorPanel = document.getElementById('ws-inspector-panel');
    if (inspectorPanel) inspectorPanel.style.display = '';
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/notebook-view.js src/frontend/js/workspace-explorer.js
git commit -m "feat(notebook): NotebookView IDE — cells, editing, save, run

Full notebook IDE class with cell rendering (code + markdown),
editing via textarea with Tab handling, dirty tracking, save flow
(serialize → updateDefinition), run all flow (save → job scheduler
→ poll → status display), keyboard shortcuts (Ctrl+S, Ctrl+Enter).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Build System — Add New Modules

**Files:**
- Modify: `scripts/build-html.py`

- [ ] **Step 1: Add new CSS and JS modules to build order**

In `CSS_MODULES` list, add after `"css/api-playground.css"`:
```python
    "css/notebook.css",
```

In `JS_MODULES` list, add before `"js/workspace-explorer.js"`:
```python
    "js/notebook-parser.js",
    "js/notebook-view.js",
```

Parser must come before notebook-view (dependency). Both must come before workspace-explorer (which references NotebookView).

- [ ] **Step 2: Run build and verify**

```bash
python scripts/build-html.py
```

Expected: Success, `src/edog-logs.html` produced. Verify the notebook modules appear in the output.

- [ ] **Step 3: Commit**

```bash
git add scripts/build-html.py
git commit -m "chore(build): add notebook-parser, notebook-view, notebook.css to build

Parser before view (dependency), both before workspace-explorer.
CSS after api-playground in component order.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Tests

**Files:**
- Create: `tests/test_notebook_parser.py`

- [ ] **Step 1: Write Python test that validates the notebook-content.sql format parsing logic**

Since the parser is in JS and we don't have a JS test runner, write a Python equivalent test that validates the parsing logic independently. This also serves as a specification test.

```python
"""Test notebook-content.sql parsing logic.

Tests the parsing rules for Fabric notebook format. These rules are
implemented in JS (NotebookParser) but validated here as a specification.
"""
import json
import pytest

SAMPLE_CONTENT = """-- Fabric notebook source
-- METADATA ********************
-- META {"kernel_info":{"name":"synapse_pyspark"},"dependencies":{"lakehouse":{"default_lakehouse":"a96fdc44"}}}

-- MARKDOWN ********************
-- # Create materialized lake views
-- Select Run all to run the notebook.

-- CELL ********************
CREATE MATERIALIZED lake VIEW dbo.mvFromOne
AS SELECT * from dbo.numTen;

-- METADATA ********************
-- META {"language":"sparksql","language_group":"synapse_pyspark"}

-- CELL ********************
-- MAGIC %%pyspark
-- MAGIC from notebookutils import mssparkutils
-- MAGIC import zlib, json

-- METADATA ********************
-- META {"language":"python","language_group":"synapse_pyspark"}
"""


def parse_notebook_content(raw: str) -> dict:
    """Python reference implementation of notebook-content.sql parser."""
    lines = raw.split("\n")
    result = {"notebookMeta": {}, "cells": []}
    current_block = None
    current_content = []
    pending_cell_for_meta = None

    for line in lines:
        if line.startswith("-- METADATA **"):
            if current_block in ("markdown", "cell"):
                cell = _flush_cell(current_block, current_content)
                result["cells"].append(cell)
                pending_cell_for_meta = cell
                current_content = []
            current_block = "notebook-meta" if not result["cells"] and not pending_cell_for_meta else "cell-meta"
            continue

        if line.startswith("-- MARKDOWN **"):
            if current_block in ("markdown", "cell"):
                cell = _flush_cell(current_block, current_content)
                result["cells"].append(cell)
                pending_cell_for_meta = None
            current_block = "markdown"
            current_content = []
            continue

        if line.startswith("-- CELL **"):
            if current_block in ("markdown", "cell"):
                cell = _flush_cell(current_block, current_content)
                result["cells"].append(cell)
                pending_cell_for_meta = None
            current_block = "cell"
            current_content = []
            continue

        if current_block in ("notebook-meta", "cell-meta"):
            if line.startswith("-- META "):
                meta = json.loads(line[len("-- META "):])
                if current_block == "notebook-meta":
                    result["notebookMeta"] = meta
                elif pending_cell_for_meta:
                    pending_cell_for_meta["meta"] = meta
                    if "language" in meta:
                        pending_cell_for_meta["language"] = meta["language"]
            continue

        if current_block == "markdown":
            current_content.append(line[3:] if line.startswith("-- ") else line)
        elif current_block == "cell":
            current_content.append(line)

    if current_block in ("markdown", "cell"):
        result["cells"].append(_flush_cell(current_block, current_content))

    return result


def _flush_cell(block_type: str, content_lines: list) -> dict:
    cell_type = "markdown" if block_type == "markdown" else "code"
    language = "sparksql"
    lines = list(content_lines)

    if cell_type == "code" and lines and lines[0].startswith("-- MAGIC %%"):
        language = lines.pop(0).replace("-- MAGIC %%", "").strip()
        content = "\n".join(
            l[len("-- MAGIC "):] if l.startswith("-- MAGIC ") else l for l in lines
        )
    else:
        content = "\n".join(lines)

    return {
        "type": cell_type,
        "language": language,
        "content": content.rstrip("\n"),
        "meta": {},
    }


def test_parse_cell_count():
    result = parse_notebook_content(SAMPLE_CONTENT)
    assert len(result["cells"]) == 3


def test_parse_notebook_meta():
    result = parse_notebook_content(SAMPLE_CONTENT)
    assert result["notebookMeta"]["kernel_info"]["name"] == "synapse_pyspark"


def test_parse_markdown_cell():
    result = parse_notebook_content(SAMPLE_CONTENT)
    cell = result["cells"][0]
    assert cell["type"] == "markdown"
    assert "Create materialized lake views" in cell["content"]


def test_parse_sql_cell():
    result = parse_notebook_content(SAMPLE_CONTENT)
    cell = result["cells"][1]
    assert cell["type"] == "code"
    assert cell["language"] == "sparksql"
    assert "CREATE MATERIALIZED" in cell["content"]


def test_parse_python_cell():
    result = parse_notebook_content(SAMPLE_CONTENT)
    cell = result["cells"][2]
    assert cell["type"] == "code"
    assert cell["language"] == "python"
    assert "from notebookutils" in cell["content"]
    # MAGIC prefix should be stripped
    assert "-- MAGIC" not in cell["content"]


def test_parse_empty_content():
    result = parse_notebook_content("")
    assert result["cells"] == []
    assert result["notebookMeta"] == {}
```

- [ ] **Step 2: Run tests**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python -m pytest tests/test_notebook_parser.py -v
```

Expected: All 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/test_notebook_parser.py
git commit -m "test(notebook): parser specification tests — 6 cases

Reference Python implementation validates notebook-content.sql parsing
rules: cell count, meta extraction, markdown cells, SQL cells, Python
cells with MAGIC prefix stripping, empty content handling.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: Integration — Quality Gates

- [ ] **Step 1: Run full lint**

```bash
make lint
```

Or if make not available:
```bash
python -m ruff check . --fix
python -m ruff format --check .
```

Fix any issues found.

- [ ] **Step 2: Run full tests**

```bash
make test
```

Or:
```bash
python -m pytest tests/ -v
```

All tests must pass.

- [ ] **Step 3: Run build**

```bash
python scripts/build-html.py
```

Verify `src/edog-logs.html` is produced without errors.

- [ ] **Step 4: Browser smoke test**

Launch dev-server and verify in browser:
1. Click a Notebook in the tree → see rich content view with linked cards
2. Click "Open Notebook IDE" → see cells rendered
3. Click an Environment → see publish status card
4. Click a SQLEndpoint → see generic info card
5. Click linked item card → navigates to that item
6. No console errors

- [ ] **Step 5: Final commit with all files**

```bash
git add -A
git commit -m "feat: notebook mini IDE + type-specific item views

Complete implementation of embedded notebook IDE with cell parsing,
editing, save, and run-all. Type-specific content views for Notebooks
(linked items), Environments (publish status), and generic items.

Server: LRO endpoints for notebook content/save/run/cancel
Parser: notebook-content.sql ↔ cell array (JS + Python spec tests)
API: 7 new methods (notebook CRUD + environment listing)
CSS: Notebook IDE styles + linked cards + environment status
UI: Type dispatcher in workspace explorer, NotebookView IDE class

13 design components, 11 verified APIs, 2 deferred to V2.
Tested: lint ✓ | pytest ✓ | build ✓ | browser ✓

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Deferred to V2

| Feature | Reason | Prerequisite |
|---|---|---|
| Per-cell Jupyter execution | Requires WebSocket + kernel protocol | MwcToken + capacity host WebSocket proxy |
| Environment switching | Needs API verification for notebook env update | Test PATCH notebook properties |
| Cell drag-and-drop reorder | Polish feature, keyboard reorder ships first | V1 working |
| Notebook diff view | Needs git integration or version tracking | V2 infrastructure |
