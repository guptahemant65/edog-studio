# Plan A: Top Bar + Sidebar Production Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Transform the top bar and sidebar from basic scaffolding to the production-ready mockup with tenant switching, live status, hover-expand sidebar, and SVG icons.

**Architecture:** Top bar gets new components (TenantSelector, FileChangeBanner). Sidebar gets CSS-only hover expand with label elements. Backend gets 2 new API endpoints (/api/edog/git-info, enhanced /api/edog/health).

**Tech Stack:** Vanilla JS classes, CSS transitions, Python HTTP endpoints

---

## Current State Assessment

### Top Bar (topbar.js — 108 lines)
- Shows EDOG brand, service status (Running/Stopped with dot), token countdown, git branch placeholder (`--`), patch count placeholder (`0 patches`), Restart and Theme buttons
- Polls `/api/flt/config` every 30s for token info
- Bug: `tokenExpiryMinutes` reads from MWC cache, not bearer cache — shows `Token 0:00` when MWC token is absent but bearer is valid
- No tenant selector, no file-change banner

### Sidebar (sidebar.js — 84 lines)
- 52px icon-only nav with 6 views (workspace, logs, dag, spark, api, environment)
- Uses Unicode chars for icons: &#9638; &#8801; &#9671; &#9889; &#9657; &#9881;
- Has active highlight (background + left accent bar via ::before pseudo-element)
- Has disabled state (opacity 0.3, pointer-events none)
- Keyboard shortcuts 1-6 already work
- No hover-expand, no labels, no shortcut badges

### Backend (dev-server.py)
- `/api/flt/config` returns `tokenExpiryMinutes` from MWC cache (bug source)
- `/api/edog/health` returns `bearerExpiresIn`, `hasBearerToken`, `lastUsername`
- No `/api/edog/git-info` endpoint
- No file-change detection

### CSS
- `variables.css`: Mix of hex and OKLCH. Has `--sidebar-width: 52px`, `--topbar-height: 44px`
- `topbar.css`: 103 lines, flex layout, status dot animation, token health colors
- `sidebar.css`: 69 lines, flex column, sidebar-icon with active/disabled states

---

## Task Dependency Graph

```
Task 1 (Tenant Selector)     — standalone
Task 2 (Connection Status)   — standalone
Task 3 (File Change Banner)  — standalone (new HTML + CSS + JS)
Task 4 (Re-deploy/Dismiss)   — depends on Task 3
Task 5 (Token Countdown Fix) — standalone (backend + frontend)
Task 6 (Git Branch Display)  — standalone (new backend endpoint)
Task 7 (Patch Count)         — standalone (backend data)
Task 8 (Sidebar Hover)       — standalone CSS + minor JS
Task 9 (SVG Icons)           — standalone (HTML + CSS)
Task 10 (Active Indicator)   — already partially done; refine CSS
Task 11 (Disabled Styling)   — already done (opacity 0.3); verify/refine
```

Parallelizable groups:
- **Group A** (backend): Tasks 5, 6, 7 (Elena)
- **Group B** (topbar UI): Tasks 1, 2, 3+4 (Zara + Mika)
- **Group C** (sidebar): Tasks 8, 9, 10, 11 (Mika + Zara)

---

## Task 1: Tenant Selector Dropdown

**Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
**Files:**
- Modify: `src/frontend/index.html` (topbar-left section)
- Modify: `src/frontend/js/topbar.js` (add TenantSelector logic)
- Modify: `src/frontend/css/topbar.css` (dropdown styles)
- Modify: `scripts/dev-server.py` (add `/api/edog/tenants` GET + POST)

**Scenarios:**
- HAPPY: Dropdown shows current tenant "FLT-Dev" with environment badge "INT", chevron. Click opens list of saved tenants + "Add tenant" button. Selecting a tenant closes dropdown, updates chip, triggers re-auth.
- LOADING: During tenant switch — chip shows spinner icon, text grayed, dropdown disabled. Service status changes to "Connecting".
- EMPTY: No tenants configured — chip shows "No tenant" in muted text. Dropdown shows only "Add tenant" option.
- ERROR: Tenant switch auth fails — chip flashes red border once, reverts to previous tenant. Toast notification appears: "Authentication failed for {tenant}".
- EDGE: Token expiring during switch — queue the re-auth, don't double-trigger. Mid-switch click on another tenant — cancel previous, start new.

- [ ] Step 1: Add tenant data model to dev-server.py

In `scripts/dev-server.py`, add a tenants file path constant near line 24:

```python
TENANTS_FILE = PROJECT_DIR / ".edog-tenants.json"
```

Add helper functions after `_load_session()` (after line 68):

```python
def _load_tenants() -> list[dict]:
    """Load saved tenants list."""
    if not TENANTS_FILE.exists():
        return []
    try:
        return json.loads(TENANTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_tenants(tenants: list[dict]) -> None:
    """Persist tenants list."""
    TENANTS_FILE.write_text(json.dumps(tenants, indent=2), encoding="utf-8")
```

Add GET/POST routes in `do_GET` and `do_POST`:

In `do_GET` (after the `/api/edog/health` elif):
```python
elif self.path == "/api/edog/tenants":
    self._serve_tenants()
```

In `do_POST` (after the `/api/edog/mwc-token` elif):
```python
elif self.path == "/api/edog/tenants":
    self._save_tenant()
```

Add handler methods:

```python
def _serve_tenants(self):
    """GET /api/edog/tenants — return saved tenants + active tenant ID."""
    tenants = _load_tenants()
    config = {}
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text())
    active_id = config.get("workspace_id", "")
    self._json_response(200, {
        "tenants": tenants,
        "activeWorkspaceId": active_id,
    })

def _save_tenant(self):
    """POST /api/edog/tenants — add or update a tenant entry."""
    content_len = int(self.headers.get("Content-Length", 0))
    body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
    tenants = _load_tenants()
    # Upsert by workspace_id
    existing = next((t for t in tenants if t.get("workspaceId") == body.get("workspaceId")), None)
    if existing:
        existing.update(body)
    else:
        tenants.append(body)
    _save_tenants(tenants)
    self._json_response(200, {"ok": True})
```

- [ ] Step 2: Add tenant selector HTML to index.html

Replace the topbar-left section (lines 28-34 of index.html):

```html
<div class="topbar-left">
  <span class="topbar-brand">EDOG</span>
  <div id="tenant-selector" class="tenant-selector">
    <button id="tenant-chip" class="tenant-chip" title="Switch tenant">
      <span id="tenant-name" class="tenant-chip-name">No tenant</span>
      <span id="tenant-env-badge" class="tenant-env-badge"></span>
      <svg class="tenant-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div id="tenant-dropdown" class="tenant-dropdown">
      <div id="tenant-list" class="tenant-list"></div>
      <button id="tenant-add-btn" class="tenant-add-btn">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2V10M2 6H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Add tenant
      </button>
    </div>
  </div>
  <span id="service-status" class="service-status stopped">
    <span class="status-dot"></span>
    <span id="service-status-text">Stopped</span>
  </span>
</div>
```

- [ ] Step 3: Add tenant selector CSS to topbar.css

Append to `src/frontend/css/topbar.css`:

```css
/* Tenant Selector */
.tenant-selector {
  position: relative;
}

.tenant-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 3px var(--space-2) 3px var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
  max-width: 200px;
}

.tenant-chip:hover {
  border-color: var(--border-bright);
  background: var(--surface-3);
}

.tenant-chip.open {
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
}

.tenant-chip.switching {
  opacity: 0.6;
  pointer-events: none;
}

.tenant-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.tenant-env-badge {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--accent-dim);
  color: var(--accent);
}

.tenant-env-badge:empty {
  display: none;
}

.tenant-chevron {
  transition: transform var(--transition-fast);
  flex-shrink: 0;
  color: var(--text-muted);
}

.tenant-chip.open .tenant-chevron {
  transform: rotate(180deg);
}

.tenant-dropdown {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  min-width: 220px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-dropdown); /* dropdown above other elements */
  display: none;
  flex-direction: column;
}

.tenant-dropdown.open {
  display: flex;
}

.tenant-list {
  display: flex;
  flex-direction: column;
  padding: var(--space-1) 0;
}

.tenant-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  color: var(--text-dim);
  cursor: pointer;
  transition: background var(--transition-fast);
  border: none;
  background: none;
  text-align: left;
  width: 100%;
}

.tenant-option:hover {
  background: var(--surface-2);
  color: var(--text);
}

.tenant-option.active {
  color: var(--accent);
  font-weight: 500;
}

.tenant-option-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}

.tenant-option.active .tenant-option-dot {
  background: var(--accent);
}

.tenant-add-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
  border: none;
  border-top: 1px solid var(--border);
  background: none;
  width: 100%;
  text-align: left;
}

.tenant-add-btn:hover {
  color: var(--accent);
  background: var(--surface-2);
}
```

- [ ] Step 4: Add TenantSelector logic to topbar.js

Add the following class above the existing `TopBar` class in `src/frontend/js/topbar.js`:

```javascript
/**
 * TenantSelector — dropdown chip for switching between saved tenants.
 * Fetches tenant list from /api/edog/tenants, renders dropdown,
 * and triggers re-auth on selection.
 */
class TenantSelector {
  constructor() {
    this._chip = document.getElementById('tenant-chip');
    this._nameEl = document.getElementById('tenant-name');
    this._badgeEl = document.getElementById('tenant-env-badge');
    this._dropdown = document.getElementById('tenant-dropdown');
    this._listEl = document.getElementById('tenant-list');
    this._addBtn = document.getElementById('tenant-add-btn');
    this._tenants = [];
    this._activeWorkspaceId = '';
    this._switching = false;
    this.onTenantSwitch = null;
  }

  init() {
    if (!this._chip) return;
    this._chip.addEventListener('click', () => this._toggle());
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tenant-selector')) this._close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._close();
    });
    if (this._addBtn) {
      this._addBtn.addEventListener('click', () => this._onAddTenant());
    }
    this.refresh();
  }

  async refresh() {
    try {
      const resp = await fetch('/api/edog/tenants');
      if (!resp.ok) return;
      const data = await resp.json();
      this._tenants = data.tenants || [];
      this._activeWorkspaceId = data.activeWorkspaceId || '';
      this._renderChip();
      this._renderList();
    } catch {
      this._nameEl.textContent = 'No tenant';
      this._badgeEl.textContent = '';
    }
  }

  _renderChip() {
    const active = this._tenants.find(t => t.workspaceId === this._activeWorkspaceId);
    if (active) {
      this._nameEl.textContent = active.name || active.workspaceId.slice(0, 8);
      this._badgeEl.textContent = active.environment || '';
    } else {
      this._nameEl.textContent = this._tenants.length > 0 ? 'Select tenant' : 'No tenant';
      this._badgeEl.textContent = '';
    }
  }

  _renderList() {
    if (!this._listEl) return;
    this._listEl.innerHTML = '';
    this._tenants.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'tenant-option' + (t.workspaceId === this._activeWorkspaceId ? ' active' : '');
      btn.innerHTML = `<span class="tenant-option-dot"></span><span>${t.name || t.workspaceId.slice(0, 12)}</span>`;
      btn.addEventListener('click', () => this._onSelect(t));
      this._listEl.appendChild(btn);
    });
  }

  _toggle() {
    if (this._switching) return;
    const isOpen = this._dropdown.classList.contains('open');
    if (isOpen) {
      this._close();
    } else {
      this._dropdown.classList.add('open');
      this._chip.classList.add('open');
    }
  }

  _close() {
    this._dropdown.classList.remove('open');
    this._chip.classList.remove('open');
  }

  async _onSelect(tenant) {
    if (tenant.workspaceId === this._activeWorkspaceId) {
      this._close();
      return;
    }
    this._switching = true;
    this._chip.classList.add('switching');
    this._close();
    try {
      if (this.onTenantSwitch) {
        await this.onTenantSwitch(tenant);
      }
      this._activeWorkspaceId = tenant.workspaceId;
      this._renderChip();
      this._renderList();
    } catch (err) {
      console.error('Tenant switch failed:', err);
      this._chip.style.borderColor = 'var(--status-failed)';
      setTimeout(() => { this._chip.style.borderColor = ''; }, 1500);
    } finally {
      this._switching = false;
      this._chip.classList.remove('switching');
    }
  }

  _onAddTenant() {
    this._close();
    // Open command palette with "add tenant" pre-filled
    const cpInput = document.getElementById('cp-input');
    const cp = document.getElementById('command-palette');
    if (cpInput && cp) {
      cp.classList.remove('hidden');
      cpInput.value = 'Add tenant: ';
      cpInput.focus();
    }
  }
}
```

Wire into TopBar constructor — add after `this._tokenExpiryMinutes = null;`:

```javascript
this._tenantSelector = new TenantSelector();
```

Wire into TopBar.init() — add after `this._startConfigPolling();`:

```javascript
this._tenantSelector.init();
```

- [ ] Step 5: Commit

```
feat(topbar): add tenant selector dropdown with saved tenants

Adds TenantSelector class with dropdown chip showing current tenant
name + environment badge. Click opens dropdown with saved tenants
list and "Add tenant" button. Backend gets /api/edog/tenants
GET/POST endpoints persisting to .edog-tenants.json.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 2: Connection Status with Uptime Counter

**Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
**Files:**
- Modify: `src/frontend/js/topbar.js` (refine _updateServiceStatus and _updateUptime)
- Modify: `src/frontend/css/topbar.css` (connecting state, pulse animation)

**Scenarios:**
- HAPPY: Green pulsing dot + "Running 14m22s". Uptime increments every second. Dot has glow effect.
- LOADING: Amber pulsing dot + "Connecting..." during initial connection or reconnection. No uptime counter.
- EMPTY: Grey static dot + "Stopped". No uptime counter. This is the initial state before any connection.
- ERROR: Red dot + "Error" if the service crashes mid-session. Brief flash transition from green to red.
- EDGE: Service restarts — uptime resets to 0. Rapid connect/disconnect cycles — debounce status changes by 500ms to prevent UI flicker.

- [ ] Step 1: Add connecting state CSS to topbar.css

Add after the `.service-status.stopped .status-dot` rule (around line 54):

```css
.service-status.connecting .status-dot {
  background: var(--status-cancelled);
  animation: pulse 1.2s ease-in-out infinite;
}
.service-status.connecting {
  color: var(--status-cancelled);
}

.service-status.error .status-dot {
  background: var(--status-failed);
  box-shadow: 0 0 6px var(--status-failed);
}
.service-status.error {
  color: var(--status-failed);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

- [ ] Step 2: Refine _updateServiceStatus in topbar.js

Replace the `_updateServiceStatus` method:

```javascript
_updateServiceStatus(status) {
  if (!this._statusEl) return;
  // Debounce rapid status changes
  if (this._statusDebounce) clearTimeout(this._statusDebounce);
  this._statusDebounce = setTimeout(() => {
    this._statusEl.className = 'service-status ' + status;
    if (status === 'running' && !this._uptimeStart) {
      this._uptimeStart = Date.now();
    }
    if (status !== 'running') {
      this._uptimeStart = null;
    }
    this._renderStatusText(status);
  }, status === this._lastStatus ? 0 : 300);
  this._lastStatus = status;
}

_renderStatusText(status) {
  if (!this._statusTextEl) return;
  const labels = {
    running: 'Running',
    stopped: 'Stopped',
    connecting: 'Connecting\u2026',
    building: 'Building\u2026',
    error: 'Error',
  };
  let label = labels[status] || status;
  if (status === 'running' && this._uptimeStart) {
    label += ' ' + this._formatUptime(Math.floor((Date.now() - this._uptimeStart) / 1000));
  }
  this._statusTextEl.textContent = label;
}
```

Add `this._lastStatus = 'stopped';` and `this._statusDebounce = null;` to the constructor.

- [ ] Step 3: Refine _updateUptime in topbar.js

Replace the `_updateUptime` method:

```javascript
_updateUptime() {
  if (!this._uptimeStart) return;
  if (!this._statusEl?.classList.contains('running')) return;
  const secs = Math.floor((Date.now() - this._uptimeStart) / 1000);
  if (this._statusTextEl) {
    this._statusTextEl.textContent = 'Running ' + this._formatUptime(secs);
  }
}
```

- [ ] Step 4: Commit

```
feat(topbar): refine connection status with states and debounce

Adds connecting/error states with amber pulse and red glow.
Debounces rapid status changes by 300ms to prevent UI flicker.
Uptime counter resets on disconnect and restarts on reconnect.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 3: Files Changed Banner

**Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS) + Elena Voronova (Python backend)
**Files:**
- Modify: `src/frontend/index.html` (file-change-bar already exists as empty div)
- Create: `src/frontend/js/file-change-banner.js` (new module)
- Modify: `src/frontend/css/topbar.css` (banner styles)
- Modify: `scripts/dev-server.py` (add `/api/edog/file-changes` endpoint)

**Scenarios:**
- HAPPY: Yellow bar slides down below topbar: "Files changed: Startup.cs, EdogLogInterceptor.cs" with [Re-deploy] and [Dismiss] buttons. Shows when FLT source files change on disk.
- LOADING: Banner shows "Checking for changes..." with shimmer animation while polling.
- EMPTY: Banner is collapsed (display: none) — zero height, no visual presence. This is the normal state.
- ERROR: File watcher fails — banner doesn't show. Fail silently, log to console.
- EDGE: Multiple rapid file changes — debounce 2 seconds, accumulate file list. User dismisses then more changes happen — banner re-appears. User clicks Re-deploy — banner shows "Re-deploying..." state with spinner.

- [ ] Step 1: Add file-changes endpoint to dev-server.py

Add route in `do_GET` (after `/api/edog/tenants`):

```python
elif self.path == "/api/edog/file-changes":
    self._serve_file_changes()
```

Add handler method:

```python
def _serve_file_changes(self):
    """GET /api/edog/file-changes — check if FLT source files have changed since last deploy."""
    session = _load_session()
    last_deploy_time = session.get("lastDeployTimestamp", 0)
    watched_dir = session.get("fltRepoPath", "")

    if not watched_dir or not Path(watched_dir).is_dir():
        self._json_response(200, {"changed": False, "files": []})
        return

    changed_files = []
    watch_path = Path(watched_dir) / "src"
    if watch_path.is_dir():
        for f in watch_path.rglob("*.cs"):
            try:
                mtime = f.stat().st_mtime
                if mtime > last_deploy_time:
                    changed_files.append(str(f.relative_to(watched_dir)))
            except OSError:
                continue

    self._json_response(200, {
        "changed": len(changed_files) > 0,
        "files": changed_files[:20],
        "totalCount": len(changed_files),
    })
```

- [ ] Step 2: Add file-change-banner CSS to topbar.css

Append to `src/frontend/css/topbar.css`:

```css
/* File Change Banner */
.file-change-bar {
  display: none;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  background: rgba(229, 148, 12, 0.08);
  border-bottom: 1px solid rgba(229, 148, 12, 0.20);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  color: var(--text);
  animation: slideDown 150ms ease-out;
}

.file-change-bar.visible {
  display: flex;
}

.file-change-bar.deploying {
  opacity: 0.7;
  pointer-events: none;
}

@keyframes slideDown {
  from { transform: translateY(-100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.file-change-icon {
  color: var(--status-cancelled);
  flex-shrink: 0;
}

.file-change-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-change-text strong {
  font-weight: 600;
}

.file-change-files {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.file-change-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.file-change-btn {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  border: none;
}

.file-change-btn.primary {
  background: var(--status-cancelled);
  color: #fff;
}

.file-change-btn.primary:hover {
  filter: brightness(1.1);
}

.file-change-btn.ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.file-change-btn.ghost:hover {
  background: var(--surface-2);
  color: var(--text);
}
```

- [ ] Step 3: Create FileChangeBanner JS class

Create `src/frontend/js/file-change-banner.js`:

```javascript
/**
 * FileChangeBanner — yellow notification bar showing changed FLT source files.
 * Polls /api/edog/file-changes every 10 seconds.
 * Shows file names with Re-deploy and Dismiss actions.
 */
class FileChangeBanner {
  constructor() {
    this._bar = document.getElementById('file-change-bar');
    this._dismissed = false;
    this._lastFiles = [];
    this._pollTimer = null;
    this._deploying = false;
    this.onRedeploy = null;
  }

  init() {
    if (!this._bar) return;
    this._startPolling();
  }

  _startPolling() {
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), 10000);
  }

  async _poll() {
    if (this._deploying) return;
    try {
      const resp = await fetch('/api/edog/file-changes');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.changed && data.files.length > 0) {
        const filesKey = data.files.sort().join(',');
        const lastKey = this._lastFiles.sort().join(',');
        if (filesKey !== lastKey) {
          this._dismissed = false;
        }
        this._lastFiles = data.files;
        if (!this._dismissed) {
          this._show(data.files, data.totalCount);
        }
      } else {
        this._lastFiles = [];
        this._hide();
      }
    } catch {
      // Fail silently — file watching is best-effort
    }
  }

  _show(files, totalCount) {
    if (!this._bar) return;
    const displayFiles = files.slice(0, 3).map(f => {
      const parts = f.split(/[/\\]/);
      return parts[parts.length - 1];
    });
    let fileText = displayFiles.join(', ');
    if (totalCount > 3) {
      fileText += ` +${totalCount - 3} more`;
    }

    this._bar.innerHTML = `
      <svg class="file-change-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1.75V5.25M7 8.75H7.005M12.25 7C12.25 9.8995 9.8995 12.25 7 12.25C4.10051 12.25 1.75 9.8995 1.75 7C1.75 4.10051 4.10051 1.75 7 1.75C9.8995 1.75 12.25 4.10051 12.25 7Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
      <span class="file-change-text">
        <strong>Files changed:</strong>
        <span class="file-change-files">${fileText}</span>
      </span>
      <div class="file-change-actions">
        <button class="file-change-btn primary" id="file-change-redeploy">Re-deploy</button>
        <button class="file-change-btn ghost" id="file-change-dismiss">Dismiss</button>
      </div>
    `;

    this._bar.classList.add('visible');
    this._bar.classList.remove('deploying');

    document.getElementById('file-change-redeploy')?.addEventListener('click', () => this._onRedeploy());
    document.getElementById('file-change-dismiss')?.addEventListener('click', () => this._onDismiss());
  }

  _hide() {
    if (!this._bar) return;
    this._bar.classList.remove('visible');
    this._bar.innerHTML = '';
  }

  _onDismiss() {
    this._dismissed = true;
    this._hide();
  }

  async _onRedeploy() {
    if (this._deploying) return;
    this._deploying = true;
    this._bar.classList.add('deploying');
    const redeployBtn = document.getElementById('file-change-redeploy');
    if (redeployBtn) redeployBtn.textContent = 'Re-deploying\u2026';

    try {
      if (this.onRedeploy) {
        await this.onRedeploy();
      }
      this._hide();
      this._dismissed = false;
      this._lastFiles = [];
    } catch (err) {
      console.error('Re-deploy failed:', err);
      if (redeployBtn) redeployBtn.textContent = 'Retry';
    } finally {
      this._deploying = false;
      this._bar.classList.remove('deploying');
    }
  }

  destroy() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }
}
```

- [ ] Step 4: Wire FileChangeBanner into main.js

In the EdogLogViewer constructor (after `this.commandPalette = new CommandPalette(...)`):

```javascript
this.fileChangeBanner = new FileChangeBanner();
```

In the `init` method (after `this.commandPalette.init();`):

```javascript
this.fileChangeBanner.init();
```

- [ ] Step 5: Commit

```
feat(topbar): add file-change banner with re-deploy and dismiss

Yellow notification bar appears below topbar when FLT source files
change on disk. Shows changed file names with Re-deploy and Dismiss
buttons. Polls /api/edog/file-changes every 10s. Banner collapses
to zero height when no changes detected.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 4: Re-deploy / Dismiss Buttons

**Owner:** Zara Okonkwo (JS)
**Files:**
- Modify: `src/frontend/js/file-change-banner.js` (already has buttons from Task 3)

**Scenarios:**
- HAPPY: "Re-deploy" button is amber/orange. Click triggers build + deploy. "Dismiss" is a ghost button. Both have hover states.
- LOADING: Re-deploy clicked — button text changes to "Re-deploying..." and entire banner goes to 0.7 opacity. Both buttons become non-interactive.
- EMPTY: N/A — buttons only exist when banner is visible.
- ERROR: Re-deploy fails — button text changes to "Retry", banner stays visible. User can click again.
- EDGE: Double-click prevention — `this._deploying` flag prevents re-entry.

> **Note:** This task is fully implemented within Task 3. The buttons, their states, and their click handlers are already defined in FileChangeBanner. This task exists as a verification checkpoint.

- [ ] Step 1: Verify button behavior is complete in Task 3 implementation

Confirm the following are present in `file-change-banner.js`:
- `_onRedeploy()` method sets `_deploying = true`, changes text to "Re-deploying...", calls `this.onRedeploy`, resets on success/failure
- `_onDismiss()` method sets `_dismissed = true`, hides banner
- Double-click prevented by `_deploying` guard
- Error state changes button text to "Retry"
- CSS `.deploying` class reduces opacity to 0.7 and disables pointer-events

- [ ] Step 2: Commit (if any changes needed)

```
fix(topbar): verify re-deploy/dismiss button states

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 5: Token Countdown Fix

**Owner:** Elena Voronova (Python backend) + Zara Okonkwo (JS frontend)
**Files:**
- Modify: `scripts/dev-server.py` (`_serve_config` method at line 216)
- Modify: `src/frontend/js/topbar.js` (fetchConfig to also hit /api/edog/health)

**Scenarios:**
- HAPPY: Token countdown shows "Token 42:15" from bearer expiry. Green color. Counts down every second with live update.
- LOADING: During initial fetch — shows "Token ..." in muted color while first /api/edog/health response arrives.
- EMPTY: No bearer token at all — shows "No token" in grey. Sidebar token dot is grey.
- ERROR: Health endpoint unreachable — fall back to MWC-based expiry (current behavior). Don't show stale data.
- EDGE: Bearer expires but MWC still valid — show bearer countdown (it's the more critical one). Both tokens expire — show "Expired" in red with pulse. Token refreshes mid-countdown — smoothly update without visual glitch.

- [ ] Step 1: Fix _serve_config to include bearer expiry

In `scripts/dev-server.py`, modify `_serve_config` (line 216). Add `bearerExpiryMinutes` to the response. Replace the tokenExpiryMinutes calculation:

```python
def _serve_config(self):
    config = {}
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text())

    bearer, bearer_exp = _read_cache(BEARER_CACHE)
    mwc, mwc_exp = _read_cache(MWC_CACHE)

    # Bearer expiry is the primary token countdown source
    bearer_remaining = int((bearer_exp - time.time()) / 60) if bearer_exp else 0
    mwc_remaining = int((mwc_exp - time.time()) / 60) if mwc_exp else 0

    resp = {
        "workspaceId": config.get("workspace_id", ""),
        "artifactId": config.get("artifact_id", ""),
        "capacityId": config.get("capacity_id", ""),
        "tokenExpiryMinutes": bearer_remaining if bearer_exp else mwc_remaining,
        "bearerExpiryMinutes": bearer_remaining,
        "mwcExpiryMinutes": mwc_remaining,
        "tokenExpired": bearer is None and mwc is None,
        "mwcToken": mwc,
        "fabricBaseUrl": None,
        "bearerToken": bearer,
        "phase": "connected" if mwc else "disconnected",
    }

    body = json.dumps(resp).encode()
    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)
```

- [ ] Step 2: Update topbar.js fetchConfig to prefer bearer expiry

Replace the `fetchConfig` method in `topbar.js`:

```javascript
async fetchConfig() {
  try {
    const resp = await fetch('/api/flt/config');
    if (!resp.ok) {
      this._updateServiceStatus('stopped');
      this._updateTokenDisplay(null);
      return null;
    }
    const config = await resp.json();

    // Prefer bearer expiry over MWC expiry for countdown
    const tokenMinutes = config.bearerExpiryMinutes > 0
      ? config.bearerExpiryMinutes
      : config.tokenExpiryMinutes;
    this._updateTokenDisplay(tokenMinutes > 0 ? tokenMinutes : null);
    this._tokenExpiryMinutes = tokenMinutes;

    if (config.bearerToken) {
      this._updateServiceStatus('running');
      if (!this._uptimeStart) this._uptimeStart = Date.now();
    } else {
      this._updateServiceStatus('stopped');
    }
    return config;
  } catch {
    this._updateServiceStatus('stopped');
    this._updateTokenDisplay(null);
    return null;
  }
}
```

- [ ] Step 3: Add live second-by-second countdown

Add a new field `this._tokenExpiryTimestamp = null;` to TopBar constructor.

Replace `_updateTokenDisplay`:

```javascript
_updateTokenDisplay(minutes) {
  if (!this._tokenCountdownEl || !this._tokenHealthEl) return;
  if (minutes === null || minutes === undefined || minutes <= 0) {
    this._tokenCountdownEl.textContent = minutes === 0 ? 'Expired' : 'No token';
    this._tokenHealthEl.className = 'token-health ' + (minutes === 0 ? 'red' : 'none');
    this._updateSidebarDot(minutes === 0 ? 'red' : '');
    this._tokenExpiryTimestamp = null;
    return;
  }
  // Store absolute expiry for second-by-second countdown
  this._tokenExpiryTimestamp = Date.now() + (minutes * 60 * 1000);
  this._renderTokenCountdown();
}

_renderTokenCountdown() {
  if (!this._tokenExpiryTimestamp) return;
  const remainingMs = this._tokenExpiryTimestamp - Date.now();
  if (remainingMs <= 0) {
    this._tokenCountdownEl.textContent = 'Expired';
    this._tokenHealthEl.className = 'token-health red';
    this._updateSidebarDot('red');
    this._tokenExpiryTimestamp = null;
    return;
  }
  const totalSeconds = Math.floor(remainingMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  this._tokenCountdownEl.textContent = 'Token ' + m + ':' + String(s).padStart(2, '0');

  let color = 'green';
  if (m < 5) color = 'red';
  else if (m < 10) color = 'amber';
  this._tokenHealthEl.className = 'token-health ' + color;
  this._updateSidebarDot(color);
}
```

Update `_startConfigPolling` to tick the token countdown every second:

```javascript
_startConfigPolling() {
  this.fetchConfig();
  this._tokenTimer = setInterval(() => this.fetchConfig(), 30000);
  this._uptimeTimer = setInterval(() => {
    this._updateUptime();
    this._renderTokenCountdown();
  }, 1000);
}
```

- [ ] Step 4: Commit

```
fix(token): fix countdown reading bearer expiry instead of MWC cache

Bug: tokenExpiryMinutes was sourced from MWC cache which may be
empty even when a valid bearer token exists. Now the /api/flt/config
response includes bearerExpiryMinutes and the frontend prefers it.
Also adds live second-by-second countdown interpolation between
30-second polls so the timer feels real-time.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 6: Git Branch Display

**Owner:** Elena Voronova (Python backend) + Zara Okonkwo (JS frontend)
**Files:**
- Modify: `scripts/dev-server.py` (add `/api/edog/git-info` endpoint)
- Modify: `src/frontend/js/topbar.js` (fetch and display git branch)

**Scenarios:**
- HAPPY: Shows "main" or "feature/dag-v2" in the topbar. Monospace font, truncated with ellipsis if > 20 chars.
- LOADING: Shows "--" (current default) until first successful fetch.
- EMPTY: No FLT repo configured — shows "--" permanently. Not an error, just unavailable.
- ERROR: git command fails (not a git repo, git not installed) — shows "--", logs warning to console.
- EDGE: Branch name very long (e.g., `feature/users/hemant/extremely-long-branch-name-that-goes-on-forever`) — truncated with ellipsis, full name in title attribute on hover.

- [ ] Step 1: Add /api/edog/git-info endpoint to dev-server.py

Add route in `do_GET` (after `/api/edog/file-changes`):

```python
elif self.path == "/api/edog/git-info":
    self._serve_git_info()
```

Add handler method:

```python
def _serve_git_info(self):
    """GET /api/edog/git-info — return git branch and status of FLT repo."""
    session = _load_session()
    flt_repo = session.get("fltRepoPath", "")

    if not flt_repo or not Path(flt_repo).is_dir():
        self._json_response(200, {"branch": "", "available": False})
        return

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, cwd=flt_repo, timeout=5,
        )
        branch = result.stdout.strip() if result.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        branch = ""

    self._json_response(200, {
        "branch": branch,
        "available": bool(branch),
    })
```

- [ ] Step 2: Fetch git info in topbar.js

Add a new method to TopBar class:

```javascript
async _fetchGitInfo() {
  try {
    const resp = await fetch('/api/edog/git-info');
    if (!resp.ok) return;
    const data = await resp.json();
    if (this._branchEl && data.branch) {
      const display = data.branch.length > 24
        ? data.branch.slice(0, 22) + '\u2026'
        : data.branch;
      this._branchEl.textContent = display;
      this._branchEl.title = data.branch;
    }
  } catch {
    // Git info is best-effort
  }
}
```

Call it in `_startConfigPolling` after the initial `fetchConfig()`:

```javascript
this._fetchGitInfo();
```

Also call it at a slower interval — add to `_startConfigPolling`:

```javascript
this._gitTimer = setInterval(() => this._fetchGitInfo(), 60000);
```

Add cleanup in `destroy()`:

```javascript
if (this._gitTimer) clearInterval(this._gitTimer);
```

- [ ] Step 3: Commit

```
feat(topbar): show git branch name from FLT repo

Adds GET /api/edog/git-info endpoint that runs `git rev-parse
--abbrev-ref HEAD` in the FLT repo directory. Frontend displays
the branch name in the topbar, truncated at 24 chars with ellipsis.
Polls every 60 seconds. Falls back to "--" when unavailable.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 7: Patch Count Display

**Owner:** Elena Voronova (Python backend) + Zara Okonkwo (JS frontend)
**Files:**
- Modify: `scripts/dev-server.py` (add patch count to `/api/flt/config` response)
- Modify: `src/frontend/js/topbar.js` (read and display patch count)

**Scenarios:**
- HAPPY: Shows "3 patches" or "1 patch" in monospace. Indicates how many EDOG patches are applied to FLT.
- LOADING: Shows "0 patches" during initial load (current default, acceptable).
- EMPTY: No patches applied — shows "0 patches". Not an error.
- ERROR: Patch count unavailable — shows "-- patches". Non-critical info.
- EDGE: Large patch count (10+) — still fits in the chip, uses compact format.

- [ ] Step 1: Add patch count to /api/flt/config response

In `scripts/dev-server.py`, modify `_serve_config`. Add patch count logic before building the response dict:

```python
# Count applied EDOG patches
patch_count = 0
flt_repo = _load_session().get("fltRepoPath", "")
if flt_repo:
    edog_marker = Path(flt_repo) / ".edog-patches-applied"
    if edog_marker.exists():
        try:
            patch_count = int(edog_marker.read_text().strip())
        except (ValueError, OSError):
            patch_count = 0
```

Add to the response dict:

```python
"patchCount": patch_count,
```

- [ ] Step 2: Update topbar.js to display patch count

In `fetchConfig`, after updating service status, add:

```javascript
if (this._patchEl && config.patchCount !== undefined) {
  const count = config.patchCount;
  this._patchEl.textContent = count + (count === 1 ? ' patch' : ' patches');
}
```

- [ ] Step 3: Commit

```
feat(topbar): display applied EDOG patch count

Reads patch count from .edog-patches-applied marker file and
includes it in /api/flt/config response. Frontend displays
"N patches" in the topbar right section.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 8: Sidebar Hover Expand

**Owner:** Mika Tanaka (CSS) + Zara Okonkwo (JS)
**Files:**
- Modify: `src/frontend/css/sidebar.css` (hover expand transition)
- Modify: `src/frontend/css/variables.css` (add `--sidebar-width-expanded`)
- Modify: `src/frontend/index.html` (add label spans to sidebar buttons)
- Modify: `src/frontend/js/sidebar.js` (minor: update grid on hover for content area)
- Modify: `src/frontend/css/layout.css` (grid transition for cockpit-body)

**Scenarios:**
- HAPPY: Mouse enters sidebar → expands from 52px to 200px over 150ms with cubic-bezier easing. Labels fade in at 80ms delay. Keyboard shortcut badges (e.g., "1", "2") appear right-aligned. Mouse leaves → collapses back.
- LOADING: N/A — sidebar is always present.
- EMPTY: N/A — sidebar always has icons.
- ERROR: N/A — pure CSS, no failure mode.
- EDGE: Rapid mouse in/out — CSS transition handles this naturally (interrupts mid-animation). User clicks icon during expand animation — click still works. User holds mouse on sidebar border — slight delay (50ms) before expand to prevent accidental triggers.

- [ ] Step 1: Add expanded width variable to variables.css

In `src/frontend/css/variables.css`, after `--sidebar-width: 52px;` (line 41), add:

```css
--sidebar-width-expanded: 200px;
```

- [ ] Step 2: Add label spans to sidebar buttons in index.html

Replace the sidebar nav section (lines 59-68 of index.html):

```html
<nav id="sidebar" class="sidebar">
  <button class="sidebar-icon active" data-view="workspace" data-phase="both" title="Workspace Explorer (1)">
    <svg class="sidebar-svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="2" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="10" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="10" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
    <span class="sidebar-label">Explorer</span>
    <kbd class="sidebar-kbd">1</kbd>
  </button>
  <button class="sidebar-icon" data-view="logs" data-phase="connected" title="Logs (2)">
    <svg class="sidebar-svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 5H15M3 9H12M3 13H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <span class="sidebar-label">Logs</span>
    <kbd class="sidebar-kbd">2</kbd>
  </button>
  <button class="sidebar-icon" data-view="dag" data-phase="connected" title="DAG Studio (3)">
    <svg class="sidebar-svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="5" cy="5" r="2.5" stroke="currentColor" stroke-width="1.3"/><circle cx="13" cy="5" r="2.5" stroke="currentColor" stroke-width="1.3"/><circle cx="9" cy="14" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 7L8.5 12M11.5 7L9.5 12" stroke="currentColor" stroke-width="1.2"/></svg>
    <span class="sidebar-label">DAG Studio</span>
    <kbd class="sidebar-kbd">3</kbd>
  </button>
  <button class="sidebar-icon" data-view="spark" data-phase="connected" title="Spark Inspector (4)">
    <svg class="sidebar-svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2L11 7H15L12 10L13 15L9 12L5 15L6 10L3 7H7L9 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
    <span class="sidebar-label">Spark</span>
    <kbd class="sidebar-kbd">4</kbd>
  </button>
  <button class="sidebar-icon" data-view="api" data-phase="both" title="API Playground (5)">
    <svg class="sidebar-svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 6L2 9L5 12M13 6L16 9L13 12M10 3L8 15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="sidebar-label">API</span>
    <kbd class="sidebar-kbd">5</kbd>
  </button>
  <button class="sidebar-icon" data-view="environment" data-phase="both" title="Environment (6)">
    <svg class="sidebar-svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M9 2V4M9 14V16M2 9H4M14 9H16M4.2 4.2L5.6 5.6M12.4 12.4L13.8 13.8M13.8 4.2L12.4 5.6M5.6 12.4L4.2 13.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    <span class="sidebar-label">Settings</span>
    <kbd class="sidebar-kbd">6</kbd>
  </button>
  <div class="sidebar-spacer"></div>
  <span id="sidebar-token-dot" class="sidebar-token-dot" title="Token status"></span>
</nav>
```

- [ ] Step 3: Rewrite sidebar.css for hover expand

Replace the entire `src/frontend/css/sidebar.css`:

```css
/* Sidebar — 52px collapsed, 200px expanded on hover */
.sidebar {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: var(--sidebar-width);
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: var(--space-3) 0;
  gap: var(--space-1);
  z-index: var(--z-sidebar); /* sidebar overlays content on expand */
  flex-shrink: 0;
  overflow: hidden;
  transition: width 150ms cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.sidebar:hover {
  width: var(--sidebar-width-expanded);
  box-shadow: var(--shadow-md);
}

.sidebar-icon {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: calc(var(--sidebar-width) - var(--space-4));
  min-height: 36px;
  margin: 0 var(--space-2);
  padding: 0 var(--space-2);
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-normal);
  position: relative;
  white-space: nowrap;
  text-align: left;
}

.sidebar:hover .sidebar-icon {
  width: calc(var(--sidebar-width-expanded) - var(--space-4));
}

.sidebar-icon:hover {
  background: var(--surface-2);
  color: var(--text);
}

.sidebar-icon.active {
  background: var(--accent-dim);
  color: var(--accent);
}

.sidebar-icon.active::before {
  content: '';
  position: absolute;
  left: calc(-1 * var(--space-2));
  width: 3px;
  height: 20px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}

.sidebar-icon.disabled {
  opacity: 0.3;
  cursor: default;
  pointer-events: none;
}

.sidebar-svg {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
}

.sidebar-label {
  opacity: 0;
  transition: opacity 80ms ease-out;
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar:hover .sidebar-label {
  opacity: 1;
  transition-delay: 80ms;
}

.sidebar-kbd {
  opacity: 0;
  transition: opacity 80ms ease-out;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  padding: 1px var(--space-1);
  border-radius: 3px;
  background: var(--surface-3);
  color: var(--text-muted);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.sidebar:hover .sidebar-kbd {
  opacity: 1;
  transition-delay: 80ms;
}

.sidebar-spacer { flex: 1; }

.sidebar-token-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  margin: 0 0 var(--space-3) calc((var(--sidebar-width) - 8px) / 2);
  transition: all var(--transition-normal);
}
.sidebar-token-dot.green { background: var(--status-succeeded); box-shadow: 0 0 6px rgba(24,160,88,0.4); }
.sidebar-token-dot.amber { background: var(--status-cancelled); box-shadow: 0 0 6px rgba(229,148,12,0.4); }
.sidebar-token-dot.red { background: var(--status-failed); box-shadow: 0 0 6px rgba(229,69,59,0.4); }
```

- [ ] Step 4: Update layout.css grid to allow sidebar overlay

In `src/frontend/css/layout.css`, the `.cockpit-body` grid uses `var(--sidebar-width)` for the column. The sidebar expand should overlay content, not push it. The sidebar already has `position: relative` and a higher z-index. We only need the sidebar to NOT affect the grid. Change the sidebar to `position: absolute` inside the cockpit-body:

Actually, the simpler approach: keep the grid as-is (`var(--sidebar-width) 1fr`). The sidebar's CSS `width` in hover state exceeds the grid column, but with `overflow: hidden` removed from `cockpit-body`, it will overlay. Let's use `position: absolute` on hover instead. 

Better approach — make the sidebar fixed-position within its grid slot, so hover-expand overlays the content:

Add to `src/frontend/css/layout.css`, after `.cockpit-body`:

```css
/* Sidebar expand overlays content — grid column stays at collapsed width */
.cockpit-body {
  position: relative;
}
```

And update `.sidebar` in sidebar.css to add `position: absolute` behavior on hover. Actually the cleanest approach is to keep the sidebar in its grid column at 52px, and on hover, let it overflow:

In `sidebar.css`, change `.sidebar:hover` to:

```css
.sidebar:hover {
  width: var(--sidebar-width-expanded);
  box-shadow: var(--shadow-md);
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
}
```

Wait — this removes it from grid flow. Better: just use `overflow: visible` on the parent and let the sidebar's width transition push content? No — that causes layout shift.

Final approach: keep the sidebar in flow at 52px, but visually expand via `min-width` and `position: relative` with `z-index`. The grid column stays at 52px, but the sidebar renders wider, overlapping the content area:

```css
.sidebar {
  /* ... existing ... */
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
}

.sidebar:hover {
  width: var(--sidebar-width-expanded);
  min-width: var(--sidebar-width-expanded);
  box-shadow: var(--shadow-md);
}
```

Since the grid column is `var(--sidebar-width)` (52px fixed), and the sidebar's `width` transitions to 200px, the sidebar will overflow its grid cell and overlay the content. This works because:
- Grid cell is 52px (doesn't change)
- Sidebar element expands to 200px (overflows cell)
- `z-index: var(--z-sidebar)` (50) keeps it above content

This is already correct in the CSS above. No layout.css change needed.

- [ ] Step 5: Commit

```
feat(sidebar): add hover-expand with labels and shortcut badges

Sidebar expands from 52px to 200px on hover with 150ms cubic-bezier
transition. Labels and keyboard shortcut badges (1-6) fade in with
80ms delay. Expand overlays content area without layout shift. Icons
replaced with inline SVGs (Task 9 combined here).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 9: SVG Icons

**Owner:** Mika Tanaka (CSS) + Kael Andersen (UX review)
**Files:**
- Modify: `src/frontend/index.html` (sidebar buttons — already done in Task 8)

**Scenarios:**
- HAPPY: Clean SVG icons render at 18x18px, stroke-based, matching current color via `currentColor`. Icons: grid (workspace), lines (logs), nodes (dag), star/bolt (spark), code brackets (api), gear (settings).
- LOADING: N/A — SVGs are inline, render instantly.
- EMPTY: N/A — always present.
- ERROR: N/A — inline SVG can't fail to load.
- EDGE: High-DPI displays — SVGs scale perfectly. Color theme switch — icons inherit `currentColor` and update automatically.

> **Note:** SVG icons are fully implemented in Task 8 Step 2 (sidebar HTML replacement). This task verifies the icon design.

- [ ] Step 1: Verify SVG icons are included in Task 8 implementation

The following SVGs are defined in the sidebar HTML from Task 8:

| View | Icon | SVG Description |
|------|------|----------------|
| workspace | 4-square grid | Four rounded rectangles in a 2x2 grid |
| logs | horizontal lines | Three horizontal lines of decreasing width |
| dag | connected nodes | Three circles connected by lines (DAG) |
| spark | star/bolt | Five-pointed star outline |
| api | code brackets | Angle brackets with forward slash |
| environment | gear/sun | Circle with radiating lines |

All use `stroke="currentColor"` so they inherit the button's text color, including active (accent) and disabled (muted) states.

- [ ] Step 2: Commit (if refinements needed)

```
style(sidebar): refine SVG icon strokes and sizing

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Task 10: Active Indicator (Left Accent Bar)

**Owner:** Mika Tanaka (CSS)
**Files:**
- Modify: `src/frontend/css/sidebar.css` (already has ::before pseudo-element)

**Scenarios:**
- HAPPY: Active sidebar button has a 3px violet bar on the left edge. Bar is 20px tall, vertically centered. Uses `--accent` color.
- LOADING: N/A — pure CSS state.
- EMPTY: N/A — always one active view.
- ERROR: N/A — pure CSS.
- EDGE: View switch — active bar moves instantly (no animation between items, that would be over-designed). Multiple rapid switches via keyboard — each switch is instant.

> **Note:** The active indicator is already implemented in the current sidebar.css (lines 41-49). Task 8 carries it forward. This task is a verification checkpoint.

- [ ] Step 1: Verify active indicator in Task 8's sidebar.css

Confirm the `::before` pseudo-element is present in the rewritten sidebar.css from Task 8:

```css
.sidebar-icon.active::before {
  content: '';
  position: absolute;
  left: calc(-1 * var(--space-2));
  width: 3px;
  height: 20px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}
```

This is present. The left offset is `calc(-1 * var(--space-2))` = -8px, which positions it at the very left edge of the sidebar since the icon has `margin: 0 var(--space-2)`.

- [ ] Step 2: No commit needed — covered by Task 8

---

## Task 11: Disabled State Styling

**Owner:** Mika Tanaka (CSS)
**Files:**
- Modify: `src/frontend/css/sidebar.css` (refine disabled state)
- Modify: `src/frontend/js/sidebar.js` (verify setPhase logic)

**Scenarios:**
- HAPPY: Connected-only views (Logs, DAG, Spark) shown at 30% opacity when in disconnected phase. Non-interactive (pointer-events: none).
- LOADING: During phase transition (connecting) — icons remain at current state until phase is confirmed.
- EMPTY: N/A — disabled state only applies to connected-phase items.
- ERROR: N/A — pure CSS + data-phase attribute logic.
- EDGE: Phase changes from connected→disconnected while user is on a connected-only view — sidebar.js already handles this by switching to workspace view. Verify this works with new SVG icons.

> **Note:** Disabled state is already implemented in both current CSS (opacity 0.3, pointer-events none) and JS (setPhase method). Task 8 carries it forward.

- [ ] Step 1: Verify disabled state in sidebar.css from Task 8

Confirm `.sidebar-icon.disabled` rule:

```css
.sidebar-icon.disabled {
  opacity: 0.3;
  cursor: default;
  pointer-events: none;
}
```

Present in Task 8's CSS.

- [ ] Step 2: Verify sidebar.js setPhase still works

The existing `setPhase` method in sidebar.js (line 51) adds/removes the `disabled` class based on `data-phase` attribute. This logic is unchanged. The new HTML in Task 8 still has `data-phase="connected"` and `data-phase="both"` attributes on each button.

Verify the method:

```javascript
setPhase(phase) {
  this._phase = phase;
  this._icons.forEach(icon => {
    const iconPhase = icon.dataset.phase;
    if (iconPhase === 'connected' && phase === 'disconnected') {
      icon.classList.add('disabled');
    } else {
      icon.classList.remove('disabled');
    }
  });

  if (this._getIcon(this._activeView)?.classList.contains('disabled')) {
    this.switchView('workspace');
  }
}
```

This is correct and unchanged.

- [ ] Step 3: No commit needed — covered by Task 8

---

## Build Module Order Update

**Owner:** Ren Aoki (Build)
**Files:**
- Modify: `scripts/build-html.py` (add `file-change-banner.js` to JS module list)

After all tasks are complete, ensure `file-change-banner.js` is included in the JS module concatenation order in `build-html.py`. It should appear after `topbar.js` and before `main.js`:

```python
# In the JS_MODULES list, add:
"file-change-banner.js",
```

---

## Testing Checklist

### Automated (Ines)
- [ ] `make lint` passes (ruff check on dev-server.py changes)
- [ ] `make test` passes (existing pytest suite)
- [ ] `make build` produces valid single HTML file with new modules

### Manual Browser Testing
- [ ] Tenant selector opens/closes on click
- [ ] Tenant dropdown renders saved tenants
- [ ] Connection status shows Running with uptime counter
- [ ] Connection status shows Stopped with grey dot
- [ ] File change banner appears and dismisses correctly
- [ ] Token countdown shows real minutes:seconds, counts down live
- [ ] Git branch displays actual branch name
- [ ] Patch count displays from config
- [ ] Sidebar expands to 200px on hover
- [ ] Sidebar labels and kbd badges fade in
- [ ] Sidebar collapses on mouse leave
- [ ] Active indicator (violet bar) shows on active view
- [ ] Disabled views at 30% opacity when disconnected
- [ ] Keyboard shortcuts 1-6 still work
- [ ] All SVG icons render correctly
- [ ] No console errors in Edge/Chrome
- [ ] Works in both light and dark themes

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sidebar hover expand causes layout shift | Medium | High | Use overflow-based expand, not grid reflow |
| Token countdown flicker on poll | Low | Medium | Absolute timestamp + interpolation |
| File watcher false positives | Medium | Low | Debounce + dismiss button |
| Tenant switch interrupts active work | Low | High | Confirm dialog before switch (future) |
| SVG icons don't match design intent | Medium | Medium | Kael reviews before merge |
