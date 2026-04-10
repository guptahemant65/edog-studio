# Plan D: CRUD Operations Production Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Make all workspace/lakehouse CRUD operations production-ready with inline editing, toast confirmations, proper error handling, and keyboard support.

**Architecture:** Refactor _ctxRename/_ctxDelete with inline editing pattern. Add loading/error/success states to all operations. Toast-based confirmation replaces window.confirm.

**Tech Stack:** Vanilla JS, CSS transitions for animations, existing toast system

**Date:** 2026-04-10
**Plan ID:** plan-d
**Status:** READY

---

## Current State Assessment

### What Exists (from workspace-explorer.js, lines 1–1311)

| Feature | Status | Issues |
|---------|--------|--------|
| Create Workspace | `_showCreateWorkspaceInput()` L444–508 | No loading state, no validation feedback, no duplicate name handling |
| Create Lakehouse | `_ctxCreateLakehouse()` L511–615 | Same issues + clunky toggle logic (collapse/expand/expand) |
| Rename (all types) | `_ctxRename()` L233–314 | No "Saving..." state, no input disable, `_findTreeRow` fragile (text match) |
| Delete (all types) | `_ctxDelete()` L332–368 | No "Deleting..." state, no children warning, no fade-out |
| Open in Fabric | `_ctxOpenInFabric()` L370–376 | Only workspace URL, no lakehouse deep-link |
| Copy ID | `_ctxCopyId()` L378–383 | Works fine — keep as-is |
| Copy Name | `_ctxCopyName()` L385–390 | Works fine — keep as-is |
| Favorites | `_ctxSaveFavorite()` L392–402 | No remove, no navigate, no deploy from list |
| Toast system | `_toast()` L57–70, `_toastConfirm()` L76–121 | Works — extend for loading states |

### What the API Client Provides (api-client.js, lines 137–212)

All CRUD methods exist and throw on failure with `.status` and `.body` on the error object:
- `createWorkspace(name)` → POST `/workspaces`
- `createLakehouse(workspaceId, name)` → POST `/workspaces/{id}/lakehouses`
- `renameWorkspace(workspaceId, newName)` → PATCH `/workspaces/{id}`
- `renameLakehouse(workspaceId, lakehouseId, newName)` → PATCH `/workspaces/{id}/lakehouses/{lhId}`
- `renameItem(workspaceId, itemId, newName)` → PATCH `/workspaces/{id}/items/{itemId}`
- `deleteWorkspace(workspaceId)` → DELETE `/workspaces/{id}`
- `deleteLakehouse(workspaceId, lakehouseId)` → DELETE `/workspaces/{id}/lakehouses/{lhId}`
- `deleteItem(workspaceId, itemId)` → DELETE `/workspaces/{id}/items/{itemId}`

### What the Dev Server Proxies (dev-server.py, lines 252–298)

All methods (GET/POST/PATCH/DELETE) proxy `/api/fabric/*` → redirect host. Error responses from Fabric are forwarded with status code intact. 401 = no bearer cached. 502 = proxy error.

---

## Dependency Graph

```
T1 (Error Parser) ──┬──→ T3 (Create WS)
                     ├──→ T4 (Create LH)
T2 (Loading States)  ├──→ T5 (Rename)
         │           ├──→ T6 (Delete)
         └───────────┘
                     │
T7 (Tree Animations) ←── T3, T4, T6
T8 (Keyboard)        ←── T3, T4, T5
T9 (Open in Fabric)  (independent)
T10 (Copy ID Click)  (independent)
T11 (Favorites)      (independent)
T12 (Network/Token)  ←── T1
```

**Parallelizable:** T9, T10, T11 can run in parallel with everything.
**Sequential:** T1 → T2 → T3/T4/T5/T6 → T7/T8 → T12

---

## Tasks

---

### T1: Error Classification Helper

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Why:** Every CRUD operation currently shows the raw error message. We need a shared helper that classifies Fabric API errors into user-friendly messages and determines if they're retryable.

**Context:** The `_fabricFetch` method in api-client.js (L274–304) throws errors with `.status` (HTTP code), `.body` (raw text), and `.path`. The dev-server proxy (L290–296) forwards Fabric error bodies verbatim. Fabric's error body is JSON: `{"error":{"code":"...","message":"..."}}`.

#### SCENARIOS

**HAPPY — Known error codes classified:**
```
Input: err.status=409, err.body='{"error":{"code":"WorkspaceNameConflict","message":"..."}}'
Output: { userMessage: "A workspace with this name already exists", retryable: false, code: 'duplicate_name' }

Input: err.status=429, err.body='{"error":{"code":"TooManyRequests",...}}'
Output: { userMessage: "Too many requests — retrying in 5s", retryable: true, retryAfterMs: 5000, code: 'rate_limited' }

Input: err.status=401
Output: { userMessage: "Session expired — please re-authenticate", retryable: false, code: 'auth_expired' }

Input: err.status=403
Output: { userMessage: "Insufficient permissions for this operation", retryable: false, code: 'forbidden' }

Input: err.status=404
Output: { userMessage: "Item not found — it may have been deleted", retryable: false, code: 'not_found' }
```

**ERROR — Unparseable body:**
```
Input: err.status=500, err.body='Internal Server Error'
Output: { userMessage: "Server error (500) — try again", retryable: true, retryAfterMs: 2000, code: 'server_error' }
```

**EDGE — Network error (no status):**
```
Input: err (no .status property), err.message='Failed to fetch'
Output: { userMessage: "Network error — check your connection", retryable: true, retryAfterMs: 3000, code: 'network' }
```

#### CODE

In `workspace-explorer.js`, add this method to the class (after the `_esc` helper, before the closing brace):

```javascript
// ────────────────────────────────────────────
// Error classification
// ────────────────────────────────────────────

/**
 * Classify an API error into a user-friendly message.
 * @param {Error} err - Error from FabricApiClient (may have .status, .body).
 * @returns {{ userMessage: string, retryable: boolean, retryAfterMs?: number, code: string }}
 */
_classifyError(err) {
  // Network-level failure (no HTTP status)
  if (!err.status) {
    if (!navigator.onLine) {
      return { userMessage: 'You are offline — check your connection', retryable: true, retryAfterMs: 3000, code: 'offline' };
    }
    return { userMessage: 'Network error — check your connection', retryable: true, retryAfterMs: 3000, code: 'network' };
  }

  // Try to parse Fabric error body for specific code
  let fabricCode = '';
  let fabricMsg = '';
  try {
    const parsed = JSON.parse(err.body || '{}');
    const inner = parsed.error || parsed;
    fabricCode = (inner.code || '').toLowerCase();
    fabricMsg = inner.message || '';
  } catch { /* body not JSON — use status code only */ }

  switch (err.status) {
    case 400:
      if (fabricCode.includes('invalid') || fabricCode.includes('validation')) {
        return { userMessage: fabricMsg || 'Invalid request — check the name', retryable: false, code: 'validation' };
      }
      return { userMessage: fabricMsg || 'Bad request', retryable: false, code: 'bad_request' };

    case 401:
      return { userMessage: 'Session expired — please re-authenticate', retryable: false, code: 'auth_expired' };

    case 403:
      return { userMessage: 'Insufficient permissions for this operation', retryable: false, code: 'forbidden' };

    case 404:
      return { userMessage: 'Item not found — it may have been deleted', retryable: false, code: 'not_found' };

    case 409:
      if (fabricCode.includes('name') || fabricCode.includes('conflict') || fabricCode.includes('duplicate')) {
        return { userMessage: 'A resource with this name already exists', retryable: false, code: 'duplicate_name' };
      }
      return { userMessage: 'Conflict — the item was modified by someone else', retryable: false, code: 'conflict' };

    case 429: {
      const retryAfter = parseInt(err.headers?.get?.('Retry-After') || '5', 10);
      return { userMessage: `Too many requests — retrying in ${retryAfter}s`, retryable: true, retryAfterMs: retryAfter * 1000, code: 'rate_limited' };
    }

    default:
      if (err.status >= 500) {
        return { userMessage: `Server error (${err.status}) — try again`, retryable: true, retryAfterMs: 2000, code: 'server_error' };
      }
      return { userMessage: fabricMsg || `Request failed (${err.status})`, retryable: false, code: 'unknown' };
  }
}
```

#### VERIFICATION

After this task, all subsequent CRUD tasks use `_classifyError(err)` instead of `err.message` directly.

---

### T2: Loading/Saving State Utilities

**Owner:** Zara Okonkwo (Frontend) + Mika Tanaka (CSS)
**Files:** `src/frontend/js/workspace-explorer.js`, `src/frontend/css/workspace.css`
**Why:** No CRUD operation currently shows a loading indicator. Users click and get no feedback until success or failure toast.

#### SCENARIOS

**HAPPY — Inline input shows "Saving..." during API call:**
```
1. User types name, presses Enter
2. Input becomes disabled, text changes to "Saving..."
3. API returns success → input removed, toast shows
```

**HAPPY — Delete shows "Deleting..." in toast:**
```
1. User confirms delete
2. Toast text changes to "Deleting 'MyWorkspace'..."
3. API returns success → toast changes to "Deleted 'MyWorkspace'"
```

**ERROR — API fails during saving state:**
```
1. Input shows "Saving..."
2. API returns 409
3. Input re-enables, shows original text, error toast appears
```

#### CODE — CSS

Append to `workspace.css` (after the `.ws-tree-add:hover` rule):

```css
/* ── CRUD loading states ── */

.ws-inline-rename.saving,
.ws-create-input.saving {
  opacity: 0.55;
  pointer-events: none;
  color: var(--text-muted);
}

.ws-tree-item.deleting {
  opacity: 0.4;
  pointer-events: none;
  transition: opacity 200ms ease-out;
}

/* Spinner for inline operations */
.ws-inline-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--text-muted);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ws-spin 0.6s linear infinite;
  flex-shrink: 0;
}

@keyframes ws-spin {
  to { transform: rotate(360deg); }
}

/* Toast loading variant */
.edog-toast.loading {
  border-color: var(--accent);
  pointer-events: none;
}
```

#### CODE — JS Helpers

Add these utility methods to the class body (after `_classifyError`, before the closing brace):

```javascript
// ────────────────────────────────────────────
// Loading state helpers
// ────────────────────────────────────────────

/**
 * Set an input to saving state (disabled, shows saving text).
 * @param {HTMLInputElement} input
 * @param {string} text - e.g. "Saving..."
 */
_setInputSaving(input, text = 'Saving...') {
  input.classList.add('saving');
  input.disabled = true;
  input.dataset.originalValue = input.value;
  input.value = text;
}

/**
 * Restore an input from saving state.
 * @param {HTMLInputElement} input
 */
_restoreInput(input) {
  input.classList.remove('saving');
  input.disabled = false;
  if (input.dataset.originalValue !== undefined) {
    input.value = input.dataset.originalValue;
    delete input.dataset.originalValue;
  }
  input.focus();
}

/**
 * Show a non-dismissible loading toast.
 * @param {string} msg - e.g. "Deleting 'MyWorkspace'..."
 */
_toastLoading(msg) {
  if (!this._toastEl) return;
  clearTimeout(this._toastTimer);
  this._toastEl.classList.remove('visible', 'error', 'success', 'has-actions');
  this._toastEl.textContent = '';

  const spinner = document.createElement('span');
  spinner.className = 'ws-inline-spinner';
  this._toastEl.appendChild(spinner);

  const text = document.createElement('span');
  text.style.marginLeft = 'var(--space-2)';
  text.textContent = ' ' + msg;
  this._toastEl.appendChild(text);

  this._toastEl.classList.add('loading');
  void this._toastEl.offsetWidth;
  this._toastEl.classList.add('visible');
}

/** Dismiss the loading toast (call before showing success/error toast). */
_toastDismissLoading() {
  if (!this._toastEl) return;
  this._toastEl.classList.remove('visible', 'loading');
}
```

#### VERIFICATION

These helpers are used by T3–T6. Verify:
- `.saving` class disables pointer-events and lowers opacity
- `.deleting` class fades the tree row
- Spinner animates at 60fps (CSS-only, no JS jank)
- Loading toast stays visible until explicitly dismissed

---

### T3: Create Workspace — Production Quality

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** T1, T2
**Why:** Current `_showCreateWorkspaceInput()` has no validation, no loading state, and no error classification.

#### SCENARIOS

**HAPPY — Create with valid name:**
```
1. User clicks "+" in tree header
2. Inline input appears at top of tree, focused
3. User types "Analytics WS", presses Enter
4. Input shows "Creating..." (disabled)
5. API returns { id: "abc-123", displayName: "Analytics WS" }
6. Tree refreshes, new workspace auto-expands
7. Toast: "Created workspace 'Analytics WS'"
```

**LOADING — Shows saving state during API call:**
```
1. User presses Enter with name "Test WS"
2. Input text → "Creating...", input.disabled = true
3. API call takes 2s
4. On return → cleanup + toast
```

**ERROR — Duplicate name (409):**
```
1. User types "Existing WS", presses Enter
2. Input → "Creating..."
3. API returns 409 / WorkspaceNameConflict
4. Input restores to "Existing WS", re-enabled, re-focused
5. Toast (error): "A resource with this name already exists"
```

**ERROR — Empty name:**
```
1. User presses Enter with empty/whitespace input
2. Nothing happens (existing behavior preserved — input removed quietly)
```

**EDGE — Escape cancels:**
```
1. User presses Escape
2. Input removed, no API call
```

**EDGE — Blur commits (unchanged behavior):**
```
1. User clicks elsewhere
2. If name non-empty → creates (existing behavior)
3. If name empty → input removed
```

#### CODE

Replace `_showCreateWorkspaceInput()` (lines 444–508) with:

```javascript
/** Show inline input at top of tree for creating a new workspace. */
_showCreateWorkspaceInput() {
  if (!this._treeEl) return;
  if (this._treeEl.querySelector('.ws-create-row')) return;

  const row = document.createElement('div');
  row.className = 'ws-create-row';
  row.style.paddingLeft = '12px';

  const input = document.createElement('input');
  input.className = 'ws-create-input';
  input.type = 'text';
  input.placeholder = 'New workspace name';
  input.setAttribute('aria-label', 'New workspace name');
  row.appendChild(input);

  this._treeEl.insertBefore(row, this._treeEl.firstChild);
  input.focus();

  let committed = false;
  const commit = async () => {
    const name = input.value.trim();
    if (!name) { cleanup(); return; }

    this._setInputSaving(input, 'Creating...');

    try {
      const result = await this._api.createWorkspace(name);
      cleanup();
      this._toast(`Created workspace "${name}"`, 'success');
      await this.loadWorkspaces();
      if (result && result.id) {
        this._expanded.add(result.id);
        this._renderTree();
      }
    } catch (err) {
      const classified = this._classifyError(err);
      if (classified.retryable && classified.code === 'rate_limited') {
        this._toast(classified.userMessage, 'error');
        setTimeout(() => this._restoreInput(input), classified.retryAfterMs);
      } else {
        this._restoreInput(input);
        this._toast(classified.userMessage, 'error');
      }
    }
  };

  const cleanup = () => {
    if (row.parentNode) row.remove();
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
  };

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.disabled) return;
      committed = true;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      cleanup();
    }
  };
  const onBlur = () => {
    if (!committed && !input.disabled) {
      committed = true;
      commit();
    }
  };

  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
}
```

#### VERIFICATION

1. "+" click → input appears, focused
2. Type name → Enter → "Creating..." shown → success toast + tree refresh
3. Duplicate name → input restores, error toast with specific message
4. Empty name → input removed silently
5. Escape → input removed, no API call

---

### T4: Create Lakehouse — Production Quality

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** T1, T2
**Why:** Current `_ctxCreateLakehouse()` has clunky toggle logic and no loading/error classification.

#### SCENARIOS

**HAPPY — Create lakehouse in workspace:**
```
1. User right-clicks workspace → "Create Lakehouse"
2. Workspace expands (if collapsed)
3. Inline input appears after workspace's last child, with green dot
4. User types "silver_lakehouse", presses Enter
5. Input → "Creating..."
6. API returns success
7. Children refresh, new lakehouse visible
8. Toast: "Created lakehouse 'silver_lakehouse'"
```

**ERROR — Duplicate name (409):**
```
1. Input → "Creating..."
2. API returns 409
3. Input restores, error: "A resource with this name already exists"
```

**LOADING — Shows saving state:**
```
Input disabled, text changes to "Creating..." during API call.
```

**EDGE — Workspace has no children yet:**
```
Input appears right after the workspace row (depth 1 indentation).
```

#### CODE

Replace `_ctxCreateLakehouse()` (lines 511–615) with:

```javascript
/** Context menu action: create lakehouse inside selected workspace. */
async _ctxCreateLakehouse() {
  const t = this._ctxTarget;
  if (!t || !t.isWorkspace) return;

  // Expand workspace so children are visible
  if (!this._expanded.has(t.workspace.id)) {
    await this._toggleWorkspace(t.workspace);
  }

  if (!this._treeEl) return;
  if (this._treeEl.querySelector('.ws-create-row')) return;

  // Find insertion point: after workspace's last child in tree
  const allRows = Array.from(this._treeEl.querySelectorAll('.ws-tree-item'));
  let insertAfter = null;
  let foundWs = false;
  for (const row of allRows) {
    const nameEl = row.querySelector('.ws-tree-name');
    if (nameEl && nameEl.textContent === t.workspace.displayName && !foundWs) {
      foundWs = true;
      insertAfter = row;
      continue;
    }
    if (foundWs) {
      const pl = parseInt(row.style.paddingLeft, 10) || 0;
      if (pl > 12) {
        insertAfter = row;
      } else {
        break;
      }
    }
  }

  const row = document.createElement('div');
  row.className = 'ws-create-row';
  row.style.paddingLeft = '28px';

  const dot = document.createElement('span');
  dot.className = 'ws-tree-dot lakehouse';
  row.appendChild(dot);

  const input = document.createElement('input');
  input.className = 'ws-create-input';
  input.type = 'text';
  input.placeholder = 'New lakehouse name';
  input.setAttribute('aria-label', 'New lakehouse name');
  row.appendChild(input);

  if (insertAfter && insertAfter.nextSibling) {
    this._treeEl.insertBefore(row, insertAfter.nextSibling);
  } else {
    this._treeEl.appendChild(row);
  }
  input.focus();

  let committed = false;
  const commit = async () => {
    const name = input.value.trim();
    if (!name) { cleanup(); return; }

    this._setInputSaving(input, 'Creating...');

    try {
      await this._api.createLakehouse(t.workspace.id, name);
      cleanup();
      this._toast(`Created lakehouse "${name}"`, 'success');
      // Refresh children — clear cache and reload
      delete this._children[t.workspace.id];
      if (!this._expanded.has(t.workspace.id)) {
        this._expanded.add(t.workspace.id);
      }
      // Re-render triggers child load via _toggleWorkspace path
      this._renderTree();
      // Force child reload since we cleared cache and tree shows "Loading..."
      const items = await this._loadChildren(t.workspace);
      const filtered = items.filter(i => {
        const tp = (i.type || '').toLowerCase();
        return !tp.includes('sqlanalyticsendpoint') && !tp.includes('kqlquerysetoverride');
      });
      filtered.sort((a, b) => {
        const aLH = this._isLakehouse(a) ? 0 : 1;
        const bLH = this._isLakehouse(b) ? 0 : 1;
        return aLH - bLH || (a.displayName || '').localeCompare(b.displayName || '');
      });
      this._children[t.workspace.id] = filtered;
      this._renderTree();
    } catch (err) {
      const classified = this._classifyError(err);
      if (classified.retryable && classified.code === 'rate_limited') {
        this._toast(classified.userMessage, 'error');
        setTimeout(() => this._restoreInput(input), classified.retryAfterMs);
      } else {
        this._restoreInput(input);
        this._toast(classified.userMessage, 'error');
      }
    }
  };

  const cleanup = () => {
    if (row.parentNode) row.remove();
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
  };

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.disabled) return;
      committed = true;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      cleanup();
    }
  };
  const onBlur = () => {
    if (!committed && !input.disabled) {
      committed = true;
      commit();
    }
  };

  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
}
```

#### VERIFICATION

1. Right-click workspace → "Create Lakehouse" → input appears under children
2. Type name → Enter → "Creating..." → success toast + children refresh
3. Duplicate name → input restores with error toast
4. Works when workspace has 0 children (input below workspace row)
5. Escape cancels cleanly

---

### T5: Rename — Production Quality with Loading State

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** T1, T2
**Why:** Current `_ctxRename()` has no saving indicator, no input disable during API call, and fragile tree-row lookup. Also doesn't update the content panel title live.

#### SCENARIOS

**HAPPY — Rename workspace:**
```
1. Right-click workspace → Rename
2. Name becomes inline input, pre-filled and selected
3. User types "Analytics v2", presses Enter
4. Input → "Saving..." (disabled)
5. API returns success
6. Tree re-renders with new name
7. If workspace is selected, content panel title updates
8. Toast: "Renamed workspace to 'Analytics v2'"
```

**HAPPY — Rename lakehouse:**
```
Same UX. API call uses renameLakehouse(). Content panel title updates if lakehouse is displayed.
```

**HAPPY — Rename other item (Notebook, Pipeline):**
```
Same UX. API call uses renameItem().
```

**NO-OP — Same name:**
```
User presses Enter without changing name → input removed, no API call.
```

**ERROR — Duplicate name (409):**
```
1. Input → "Saving..."
2. API returns 409
3. Input restores to user's typed name, re-focused
4. Toast: "A resource with this name already exists"
```

**ERROR — Empty name:**
```
User clears input and presses Enter → input removed, no API call (same as cancel).
```

**EDGE — Rename via content panel button (workspace or lakehouse):**
```
Content panel "Rename" button triggers same _ctxRename() flow — works because
_ctxTarget is set before calling _ctxRename() in _bindContentActions().
```

#### CODE

Replace `_ctxRename()` (lines 233–314) and `_findTreeRow()` (lines 321–330) with:

```javascript
async _ctxRename() {
  const t = this._ctxTarget;
  if (!t) return;

  const id = t.isWorkspace ? t.workspace.id : t.item.id;
  const oldName = t.isWorkspace ? t.workspace.displayName : t.item.displayName;

  const treeRow = this._findTreeRow(t);
  if (!treeRow) {
    this._toast('Could not locate tree node', 'error');
    return;
  }

  treeRow.classList.add('editing');
  const input = document.createElement('input');
  input.className = 'ws-inline-rename';
  input.type = 'text';
  input.value = oldName;
  treeRow.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      cleanup();
      return;
    }

    this._setInputSaving(input, 'Saving...');

    try {
      if (t.isWorkspace) {
        await this._api.renameWorkspace(t.workspace.id, newName);
        t.workspace.displayName = newName;
      } else if (this._isLakehouse(t.item)) {
        await this._api.renameLakehouse(t.workspace.id, t.item.id, newName);
        t.item.displayName = newName;
      } else {
        await this._api.renameItem(t.workspace.id, t.item.id, newName);
        t.item.displayName = newName;
      }

      cleanup();
      this._toast(`Renamed to "${newName}"`, 'success');
      this._renderTree();

      // Update content panel if this item is currently displayed
      const selectedId = this._selectedItem?.id || (this._selectedWorkspace?.id);
      if (selectedId === id) {
        if (t.isWorkspace) {
          this._showWorkspaceContent(t.workspace);
          this._showWorkspaceInspector(t.workspace);
        } else {
          this._selectItem(t.item, t.workspace);
        }
      }
    } catch (err) {
      const classified = this._classifyError(err);
      this._restoreInput(input);
      input.value = newName; // Keep what user typed so they can edit
      this._toast(classified.userMessage, 'error');
    }
  };

  const cleanup = () => {
    treeRow.classList.remove('editing');
    if (input.parentNode) input.remove();
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
  };

  let committed = false;
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.disabled) return;
      committed = true;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      cleanup();
    }
  };
  const onBlur = () => {
    if (!committed && !input.disabled) {
      committed = true;
      commit();
    }
  };

  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
}

/**
 * Locate the tree row DOM element for a given context-menu target.
 * Uses data attribute matching by ID for reliability (not text content).
 * Falls back to text-based lookup for backwards compatibility.
 * @param {object} t - Context target { workspace, item, isWorkspace }
 * @returns {HTMLElement|null}
 */
_findTreeRow(t) {
  if (!this._treeEl) return null;
  const targetId = t.isWorkspace ? t.workspace.id : t.item.id;
  const targetName = t.isWorkspace ? t.workspace.displayName : t.item.displayName;

  // Prefer data-id attribute if we add it in _buildTreeNode
  const byId = this._treeEl.querySelector(`.ws-tree-item[data-node-id="${targetId}"]`);
  if (byId) return byId;

  // Fallback: text-based match
  const nodes = this._treeEl.querySelectorAll('.ws-tree-item');
  for (const node of nodes) {
    const nameEl = node.querySelector('.ws-tree-name');
    if (nameEl && nameEl.textContent === targetName) return node;
  }
  return null;
}
```

**Also update `_buildTreeNode()` to set `data-node-id`** (more reliable than text matching):

In `_buildTreeNode()` (around line 758), after `el.className = cls;`, add:

```javascript
if (opts.id) el.dataset.nodeId = opts.id;
```

And update the two call sites in `_renderTree()`:

For workspace nodes (around line 688):
```javascript
const wsEl = this._buildTreeNode({
  name: ws.displayName,
  id: ws.id,
  depth: 0,
  toggle: isExpanded ? '\u25BE' : '\u25B8',
  selected: isSelected,
});
```

For child item nodes (around line 731):
```javascript
const itemEl = this._buildTreeNode({
  name: item.displayName,
  id: item.id,
  depth: 1,
  dot: isLH ? 'lakehouse' : 'other',
  dimmed: !isLH,
  selected: isItemSelected,
});
```

#### VERIFICATION

1. Right-click → Rename → inline input appears, pre-selected
2. Type new name → Enter → "Saving..." → success toast + tree re-rendered
3. Content panel title updates if item is selected
4. Duplicate name → input restores with typed text, error toast
5. Same name → no-op, input removed
6. Escape → cancel, no API call
7. Content panel "Rename" button triggers same flow

---

### T6: Delete — Production Quality with Confirmation and Loading

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** T1, T2
**Why:** Current `_ctxDelete()` lacks a "Deleting..." state, doesn't warn about workspace children, and doesn't clear content panel properly.

#### SCENARIOS

**HAPPY — Delete empty workspace:**
```
1. Right-click workspace → Delete
2. Toast confirmation: "Delete workspace 'Analytics WS'?" [Confirm] [Cancel]
3. User clicks Confirm
4. Toast: spinner + "Deleting 'Analytics WS'..."
5. API returns success
6. Workspace removed from tree (with fade-out per T7)
7. Toast: "Deleted workspace 'Analytics WS'"
8. Content panel shows empty state if workspace was selected
```

**HAPPY — Delete lakehouse:**
```
Same flow. If lakehouse was displayed in content, content panel clears to empty state.
```

**HAPPY — Delete other item:**
```
Same flow with deleteItem() API.
```

**ERROR — Workspace has children (extra warning):**
```
1. Right-click workspace with 5 items → Delete
2. Toast: "Delete workspace 'Analytics WS' and its 5 items?" [Confirm] [Cancel]
3. On confirm → proceed as normal
```

**ERROR — API fails (403 Forbidden):**
```
1. Toast: spinner + "Deleting..."
2. API returns 403
3. Toast (error): "Insufficient permissions for this operation"
4. Tree item stays (not removed)
```

**ERROR — Item already deleted (404):**
```
1. Toast: spinner + "Deleting..."
2. API returns 404
3. Remove from tree anyway (it's gone) + toast: "Item not found — it may have been deleted"
4. Refresh tree to sync state
```

**EDGE — Cancel delete:**
```
User clicks Cancel → nothing happens. Toast auto-dismisses after timeout.
```

#### CODE

Replace `_ctxDelete()` (lines 332–368) with:

```javascript
async _ctxDelete() {
  const t = this._ctxTarget;
  if (!t) return;

  const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
  const kind = t.isWorkspace ? 'workspace' : (this._isLakehouse(t.item) ? 'lakehouse' : 'item');
  const id = t.isWorkspace ? t.workspace.id : t.item.id;

  // Warn about children if workspace has loaded items
  let confirmMsg = `Delete ${kind} "${name}"?`;
  if (t.isWorkspace) {
    const children = this._children[t.workspace.id];
    if (children && children.length > 0) {
      confirmMsg = `Delete workspace "${name}" and its ${children.length} item${children.length > 1 ? 's' : ''}?`;
    }
  }

  const ok = await this._toastConfirm(confirmMsg);
  if (!ok) return;

  // Mark tree row as deleting (visual feedback)
  const treeRow = this._findTreeRow(t);
  if (treeRow) treeRow.classList.add('deleting');

  this._toastLoading(`Deleting "${name}"...`);

  try {
    if (t.isWorkspace) {
      await this._api.deleteWorkspace(t.workspace.id);
      this._workspaces = this._workspaces.filter(w => w.id !== t.workspace.id);
      delete this._children[t.workspace.id];
      this._expanded.delete(t.workspace.id);
    } else if (this._isLakehouse(t.item)) {
      await this._api.deleteLakehouse(t.workspace.id, t.item.id);
      const children = this._children[t.workspace.id];
      if (children) {
        this._children[t.workspace.id] = children.filter(c => c.id !== t.item.id);
      }
    } else {
      await this._api.deleteItem(t.workspace.id, t.item.id);
      const children = this._children[t.workspace.id];
      if (children) {
        this._children[t.workspace.id] = children.filter(c => c.id !== t.item.id);
      }
    }

    this._toastDismissLoading();
    this._toast(`Deleted "${name}"`, 'success');
    this._renderTree();

    // Clear content/inspector if deleted item was displayed
    const selectedId = this._selectedItem?.id || (this._selectedWorkspace && !this._selectedItem ? this._selectedWorkspace.id : null);
    if (selectedId === id) {
      this._selectedItem = null;
      this._selectedWorkspace = null;
      this._showEmptyContent();
      this._clearInspector();
    }
  } catch (err) {
    this._toastDismissLoading();
    const classified = this._classifyError(err);

    // If 404, item was already deleted — remove from tree and refresh
    if (classified.code === 'not_found') {
      if (t.isWorkspace) {
        this._workspaces = this._workspaces.filter(w => w.id !== t.workspace.id);
        delete this._children[t.workspace.id];
        this._expanded.delete(t.workspace.id);
      } else {
        const children = this._children[t.workspace.id];
        if (children) {
          this._children[t.workspace.id] = children.filter(c => c.id !== t.item.id);
        }
      }
      this._renderTree();
      this._toast('Item was already deleted — tree refreshed', 'info');
    } else {
      // Restore tree row appearance
      if (treeRow) treeRow.classList.remove('deleting');
      this._toast(classified.userMessage, 'error');
    }
  }
}
```

#### VERIFICATION

1. Right-click → Delete → toast confirmation with Confirm/Cancel buttons
2. Workspace with children shows count in confirmation
3. Confirm → "Deleting..." spinner toast → "Deleted" success toast
4. Tree row fades during delete (`.deleting` class)
5. Content panel clears if deleted item was displayed
6. 404 → remove from tree, show "already deleted" info toast
7. 403 → error toast, tree row stays
8. Cancel → nothing happens

---

### T7: Tree Animations (Create Expand + Delete Fade)

**Owner:** Mika Tanaka (CSS)
**Files:** `src/frontend/css/workspace.css`
**Depends on:** T3, T4, T6 (uses `.deleting` class from T6)
**Why:** Visual polish — smooth expand on create, fade-out on delete.

#### SCENARIOS

**HAPPY — New workspace appears with subtle animation:**
```
Tree row slides in from height 0 → 30px over 150ms.
```

**HAPPY — Deleted item fades out:**
```
Tree row opacity fades 1 → 0 over 200ms, then removed from DOM.
```

#### CODE

Append to `workspace.css`:

```css
/* ── Tree animations ── */

/* Fade-out for deleted items */
.ws-tree-item.fade-out {
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity 200ms ease-out, transform 200ms ease-out;
  pointer-events: none;
}

/* Slide-in for newly created items */
.ws-tree-item.slide-in {
  animation: ws-slide-in 150ms ease-out;
}

@keyframes ws-slide-in {
  from {
    opacity: 0;
    max-height: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    max-height: 30px;
    transform: translateY(0);
  }
}

/* Create row entrance */
.ws-create-row {
  animation: ws-slide-in 150ms ease-out;
}
```

**Note:** The `.deleting` class from T2 handles the in-progress state. The `.fade-out` class here is for the final removal animation. T6's delete code should add `.fade-out` class and wait 200ms before calling `_renderTree()`. Update T6's success path:

In the T6 code, after the API succeeds and before calling `_renderTree()`, insert:

```javascript
// Animate fade-out before re-render
if (treeRow) {
  treeRow.classList.remove('deleting');
  treeRow.classList.add('fade-out');
  await new Promise(r => setTimeout(r, 200));
}
```

#### VERIFICATION

1. Create workspace → new row slides in smoothly
2. Delete → row fades out, then tree re-renders without it
3. Animations are 150–200ms (per STYLE_GUIDE.md: no animations over 150ms for transitions)
4. No jank in tree scroll during animations

---

### T8: Keyboard Support Enhancements

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** T3, T4, T5
**Why:** Enter/Escape already work in inline inputs. Need: Tab between toast Confirm/Cancel buttons, F2 to rename selected item.

#### SCENARIOS

**HAPPY — F2 to rename selected:**
```
1. User clicks a workspace/lakehouse in tree
2. Presses F2
3. Inline rename activates (same as right-click → Rename)
```

**HAPPY — Tab navigates toast confirmation buttons:**
```
1. Delete confirmation toast appears
2. Focus moves to Cancel button (safe default)
3. Tab → focus moves to Confirm button
4. Enter → activates focused button
```

**EDGE — F2 with nothing selected:**
```
Nothing happens (no-op).
```

#### CODE

Update `_bindGlobalKeys()` (line 617) to add F2 support:

```javascript
_bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') this._hideContextMenu();

    // F2 to rename selected item
    if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const activeTag = document.activeElement?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (this._selectedItem) {
        e.preventDefault();
        this._ctxTarget = {
          workspace: this._selectedWorkspace,
          item: this._selectedItem,
          isWorkspace: false,
          isLakehouse: this._isLakehouse(this._selectedItem),
        };
        this._ctxRename();
      } else if (this._selectedWorkspace) {
        e.preventDefault();
        this._ctxTarget = {
          workspace: this._selectedWorkspace,
          item: null,
          isWorkspace: true,
          isLakehouse: false,
        };
        this._ctxRename();
      }
    }
  });
}
```

Update `_toastConfirm()` to auto-focus Cancel button and support Tab:

In the existing `_toastConfirm()` method (line 76), after `this._toastEl.classList.add('visible');` (line 105), add:

```javascript
// Focus Cancel button (safe default) — user must Tab to Confirm
cancelBtn.focus();
```

The browser's native Tab key navigation handles moving between buttons since they're standard `<button>` elements.

#### VERIFICATION

1. Select workspace → F2 → inline rename activates
2. Select lakehouse → F2 → inline rename activates
3. No selection → F2 → nothing
4. Delete confirm toast → Cancel is focused → Tab → Confirm focused → Enter activates
5. F2 doesn't trigger when typing in an input

---

### T9: Open in Fabric — Deep Links

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** None (independent)
**Why:** Current `_ctxOpenInFabric()` only links to the workspace level. Lakehouse and items should deep-link to their specific Fabric portal page.

#### SCENARIOS

**HAPPY — Open workspace:**
```
URL: https://app.fabric.microsoft.com/groups/{workspaceId}
```

**HAPPY — Open lakehouse:**
```
URL: https://app.fabric.microsoft.com/groups/{workspaceId}/lakehouses/{lakehouseId}
```

**HAPPY — Open other item:**
```
URL: https://app.fabric.microsoft.com/groups/{workspaceId}
(Generic items don't have a type-specific deep link — workspace page is best we can do)
```

#### CODE

Replace `_ctxOpenInFabric()` (lines 370–376) with:

```javascript
_ctxOpenInFabric() {
  const t = this._ctxTarget;
  if (!t) return;

  const wsId = t.workspace.id;
  let url = `https://app.fabric.microsoft.com/groups/${wsId}`;

  if (!t.isWorkspace && t.item) {
    if (this._isLakehouse(t.item)) {
      url += `/lakehouses/${t.item.id}`;
    }
    // Non-lakehouse items: stay at workspace level (no generic deep link)
  }

  window.open(url, '_blank');
}
```

Also update the content panel "Open in Fabric" button for lakehouses. In `_bindContentActions()` (around line 927), update the `open-fabric-lh` handler:

```javascript
} else if (action === 'open-fabric-lh') {
  const lh = this._selectedItem;
  if (lh && this._isLakehouse(lh)) {
    window.open(`https://app.fabric.microsoft.com/groups/${ws.id}/lakehouses/${lh.id}`, '_blank');
  } else {
    window.open(`https://app.fabric.microsoft.com/groups/${ws.id}`, '_blank');
  }
}
```

#### VERIFICATION

1. Right-click workspace → "Open in Fabric" → opens `/groups/{wsId}`
2. Right-click lakehouse → "Open in Fabric" → opens `/groups/{wsId}/lakehouses/{lhId}`
3. Content panel "Open in Fabric" button for lakehouse → deep link
4. Non-lakehouse item → workspace-level link

---

### T10: Copy ID — Click-to-Copy with Tooltip

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`, `src/frontend/css/workspace.css`
**Depends on:** None (independent)
**Why:** The truncated ID in the content panel header already has click-to-copy (via `_bindContentActions`). Need to add a "Copied!" tooltip that appears briefly instead of relying only on the toast.

#### SCENARIOS

**HAPPY — Click truncated ID:**
```
1. User clicks "abc12345..." in content header
2. Full GUID copied to clipboard
3. Small "Copied!" tooltip appears above the ID for 1.5s
4. Toast also shows "ID copied" (existing behavior preserved)
```

#### CODE — CSS

Append to `workspace.css`:

```css
/* ── Copy tooltip ── */
.ws-meta-id {
  position: relative;
}
.ws-copy-tip {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-3);
  color: var(--text);
  font-size: 10px;
  font-family: var(--font-body);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease-out;
}
.ws-copy-tip.visible {
  opacity: 1;
}
```

#### CODE — JS

Update `_copyToClipboard()` (lines 408–417) to accept an optional anchor element for tooltip placement:

```javascript
/**
 * Copy text to clipboard with toast notification and optional tooltip.
 * @param {string} text - Text to copy.
 * @param {string} successMsg - Toast message on success.
 * @param {HTMLElement} [anchorEl] - If provided, show "Copied!" tooltip on this element.
 */
_copyToClipboard(text, successMsg, anchorEl) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => {
        this._toast(successMsg || 'Copied', 'success');
        if (anchorEl) this._showCopyTip(anchorEl);
      },
      () => this._toast('Copy failed', 'error')
    );
  } else {
    this._toast('Clipboard not available', 'error');
  }
}

/** Show a brief "Copied!" tooltip above an element. */
_showCopyTip(el) {
  // Remove any existing tip
  const old = el.querySelector('.ws-copy-tip');
  if (old) old.remove();

  const tip = document.createElement('span');
  tip.className = 'ws-copy-tip';
  tip.textContent = 'Copied!';
  el.appendChild(tip);
  void tip.offsetWidth;
  tip.classList.add('visible');

  setTimeout(() => {
    tip.classList.remove('visible');
    setTimeout(() => tip.remove(), 150);
  }, 1500);
}
```

Update ID click binding in `_bindContentActions()` (line 901–906) to pass the anchor element:

```javascript
const idEl = this._contentEl.querySelector('.ws-meta-id');
if (idEl) {
  idEl.addEventListener('click', () => {
    this._copyToClipboard(idEl.dataset.copyId || '', 'ID copied', idEl);
  });
}
```

#### VERIFICATION

1. Click truncated ID → "Copied!" tooltip appears above for 1.5s
2. Full GUID is in clipboard
3. Toast also shows "ID copied"
4. Tooltip disappears cleanly without layout shift

---

### T11: Favorites — Navigate, Remove, Deploy

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** None (independent)
**Why:** Current favorites only display. Clicking should navigate to the lakehouse. Need remove and deploy actions.

#### SCENARIOS

**HAPPY — Click favorite to navigate:**
```
1. User clicks "silver_lakehouse" in FAVORITES section
2. Parent workspace expands in tree
3. Lakehouse is selected + content panel shows it
```

**HAPPY — Remove favorite:**
```
1. User hovers favorite → "✕" button appears
2. Click "✕" → removed from list and localStorage
3. Toast: "Removed from favorites"
```

**HAPPY — Deploy from favorite:**
```
1. User hovers favorite → deploy icon ("▸") appears
2. Click → triggers deploy flow for that lakehouse
```

#### CODE

Replace `_renderFavorites()` (lines 1256–1281) with:

```javascript
_renderFavorites() {
  if (!this._favoritesEl) return;
  this._favoritesEl.innerHTML = '';
  if (this._favorites.length === 0) {
    this._favoritesEl.innerHTML = '<div class="ws-tree-item dimmed" style="font-size:var(--text-xs)">No favorites yet</div>';
    return;
  }
  for (const fav of this._favorites) {
    const el = document.createElement('div');
    el.className = 'ws-fav-item';

    const dot = document.createElement('span');
    dot.className = 'ws-tree-dot lakehouse';
    el.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ws-fav-name';
    nameSpan.textContent = fav.name;
    el.appendChild(nameSpan);

    if (fav.workspaceName) {
      const detail = document.createElement('span');
      detail.className = 'ws-fav-detail';
      detail.textContent = fav.workspaceName;
      el.appendChild(detail);
    }

    // Deploy button
    const deployBtn = document.createElement('button');
    deployBtn.className = 'ws-fav-deploy';
    deployBtn.textContent = '\u25B8'; // ▸
    deployBtn.title = 'Deploy to this lakehouse';
    deployBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._deployFavorite(fav);
    });
    el.appendChild(deployBtn);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'ws-fav-deploy';
    removeBtn.textContent = '\u2715'; // ✕
    removeBtn.title = 'Remove from favorites';
    removeBtn.style.marginLeft = 'var(--space-1)';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._removeFavorite(fav.id);
    });
    el.appendChild(removeBtn);

    // Click to navigate
    el.addEventListener('click', () => this._navigateToFavorite(fav));

    this._favoritesEl.appendChild(el);
  }
}

/** Navigate to a favorited lakehouse in the tree. */
async _navigateToFavorite(fav) {
  // Find the workspace
  const ws = this._workspaces.find(w => w.id === fav.workspaceId);
  if (!ws) {
    this._toast('Workspace not found — it may have been deleted', 'error');
    return;
  }

  // Expand workspace if needed
  if (!this._expanded.has(ws.id)) {
    await this._toggleWorkspace(ws);
  }

  // Find the lakehouse in children
  const children = this._children[ws.id] || [];
  const lh = children.find(c => c.id === fav.id);
  if (lh) {
    this._selectItem(lh, ws);
  } else {
    this._toast('Lakehouse not found in workspace', 'error');
  }
}

/** Remove a favorite by ID. */
_removeFavorite(id) {
  this._favorites = this._favorites.filter(f => f.id !== id);
  this._saveFavorites();
  this._renderFavorites();
  this._toast('Removed from favorites', 'info');
}

/** Deploy from a favorite entry. */
_deployFavorite(fav) {
  const ws = this._workspaces.find(w => w.id === fav.workspaceId);
  if (!ws) {
    this._toast('Workspace not found', 'error');
    return;
  }
  const mockLh = { id: fav.id, displayName: fav.name, type: 'Lakehouse' };
  this._selectItem(mockLh, ws);
}
```

#### VERIFICATION

1. Click favorite → workspace expands, lakehouse selected
2. Hover favorite → deploy (▸) and remove (✕) buttons appear
3. Click remove → removed from list + localStorage
4. Click deploy → navigates to lakehouse content (deploy button visible)
5. Favorite for deleted workspace → error toast

---

### T12: Network/Token Error Resilience

**Owner:** Zara Okonkwo (Frontend)
**Files:** `src/frontend/js/workspace-explorer.js`
**Depends on:** T1
**Why:** Need to handle offline state, token expiry during operations, and rate limiting with auto-retry.

#### SCENARIOS

**HAPPY — Network goes offline during operation:**
```
1. User starts rename
2. Network drops (navigator.onLine = false)
3. _classifyError detects offline
4. Toast: "You are offline — check your connection"
```

**HAPPY — Token expires during operation (401):**
```
1. User starts create workspace
2. API returns 401
3. _classifyError returns code 'auth_expired'
4. Toast: "Session expired — please re-authenticate"
```

**HAPPY — Rate limited (429) with auto-retry:**
```
1. User creates workspace
2. API returns 429
3. Toast: "Too many requests — retrying in 5s"
4. After 5s, operation retries automatically
```

**HAPPY — Concurrent modification (409 on rename):**
```
1. User renames lakehouse
2. API returns 409 (conflict, not duplicate name)
3. Toast: "Conflict — the item was modified by someone else"
4. Tree auto-refreshes to sync state
```

#### CODE

Add a retry wrapper for CRUD operations. Insert after the loading state helpers:

```javascript
/**
 * Execute an async operation with automatic retry on rate-limit (429).
 * @param {Function} fn - Async function to execute.
 * @param {number} maxRetries - Maximum number of retries for rate-limiting.
 * @returns {Promise<*>} Result of fn().
 */
async _withRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const classified = this._classifyError(err);
      if (classified.code === 'rate_limited' && attempt < maxRetries) {
        const waitMs = classified.retryAfterMs || 5000;
        this._toast(`Too many requests — retrying in ${Math.ceil(waitMs / 1000)}s`, 'info');
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err; // Not retryable or max retries exceeded
    }
  }
}
```

Add an online/offline listener in `init()`, after `this._bindGlobalKeys();`:

```javascript
// Monitor online/offline state
window.addEventListener('offline', () => {
  this._toast('You are offline — check your connection', 'error');
});
window.addEventListener('online', () => {
  this._toast('Connection restored', 'success');
});
```

#### Usage

Update T3/T4/T5/T6 API calls to use `_withRetry` for rate-limit resilience:

```javascript
// In T3 _showCreateWorkspaceInput commit():
const result = await this._withRetry(() => this._api.createWorkspace(name));

// In T4 _ctxCreateLakehouse commit():
await this._withRetry(() => this._api.createLakehouse(t.workspace.id, name));

// In T5 _ctxRename commit() — wrap the appropriate API call:
if (t.isWorkspace) {
  await this._withRetry(() => this._api.renameWorkspace(t.workspace.id, newName));
}

// In T6 _ctxDelete — wrap the appropriate API call:
if (t.isWorkspace) {
  await this._withRetry(() => this._api.deleteWorkspace(t.workspace.id));
}
```

#### VERIFICATION

1. Disable network → any operation → "You are offline" toast
2. Simulate 401 → "Session expired" toast
3. Simulate 429 → toast with countdown → auto-retry after delay
4. Reconnect → "Connection restored" toast
5. Rate-limit retry succeeds on second attempt → operation completes

---

## Implementation Order

```
Phase 1: Foundation (do first)
  T1  Error Classification Helper
  T2  Loading/Saving State Utilities (CSS + JS)

Phase 2: Core CRUD (can be parallel after Phase 1)
  T3  Create Workspace
  T4  Create Lakehouse
  T5  Rename (all types)
  T6  Delete (all types)

Phase 3: Polish (after Phase 2)
  T7  Tree Animations
  T8  Keyboard Support (F2, Tab in toast)

Phase 4: Independent (any time)
  T9  Open in Fabric deep links
  T10 Copy ID tooltip
  T11 Favorites navigation/remove/deploy

Phase 5: Resilience (after T1)
  T12 Network/Token Error Handling
```

## Files Modified (Summary)

| File | Tasks | Changes |
|------|-------|---------|
| `src/frontend/js/workspace-explorer.js` | T1–T12 | Error classifier, loading helpers, retry wrapper, refactored CRUD methods, keyboard/favorites/deep-links |
| `src/frontend/css/workspace.css` | T2, T7, T10 | Loading states, tree animations, copy tooltip |

## Quality Gate

```bash
make lint    # Ruff lint + format check
make test    # pytest suite
make build   # build-html.py produces valid single-file HTML
```

Plus manual verification:
- All 20 scenarios from the task description pass
- Keyboard: Enter/Escape/F2/Tab all work correctly
- No console errors in browser DevTools
- Toast notifications dismiss properly (no stuck toasts)
- Tree state is consistent after all CRUD operations
- Content panel updates when displayed item is renamed/deleted
- Favorites persist across page reloads (localStorage)
