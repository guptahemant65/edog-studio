# F1-F4 Implementation Plan: Deploy Strip, Footer Bar, Toast System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new UI systems — a unified toast manager, a deploy context strip, and a footer status bar with feedback — to EDOG Studio.

**Architecture:** Toast system (F4) is built first since F1 and F3 depend on it for notifications. Deploy strip (F1+F2) renders in the existing notification-zone. Footer bar (F3) replaces the sidebar footer. All new JS/CSS files are registered in the build script for single-HTML output.

**Tech Stack:** Vanilla JS classes, CSS custom properties, existing EDOG design token system, `gh` CLI for feedback.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/frontend/js/toast.js` | Create | `ToastManager` class + `window.edogToast` global |
| `src/frontend/css/toast.css` | Create | Toast styles, animations, variants |
| `src/frontend/js/deploy-strip.js` | Create | `DeployContextStrip` class |
| `src/frontend/css/deploy-strip.css` | Create | Strip styles (from approved mockup) |
| `src/frontend/js/status-bar.js` | Create | `StatusBar` class (footer) |
| `src/frontend/css/status-bar.css` | Create | Footer bar styles |
| `src/frontend/index.html` | Modify | Add deploy strip div, footer bar HTML, remove sidebar footer |
| `src/frontend/js/main.js` | Modify | Remove old `showExportToast`, init new modules |
| `src/frontend/js/mock-renderer.js` | Modify | Replace `_showToast` with `window.edogToast` |
| `src/frontend/js/notebook-view.js` | Modify | Replace `_showToast` with `window.edogToast` |
| `src/frontend/js/tab-telemetry.js` | Modify | Replace `_showToast` with `window.edogToast` |
| `src/frontend/js/topbar.js` | Modify | Feed config data to deploy strip + status bar |
| `src/frontend/js/sidebar.js` | Modify | Remove sidebar footer phase/token logic |
| `scripts/build-html.py` | Modify | Register 6 new modules in CSS_MODULES + JS_MODULES |

---

### Task 1: Register New Modules in Build Script

**Files:**
- Modify: `scripts/build-html.py:24-63` (CSS_MODULES list), `scripts/build-html.py:71-134` (JS_MODULES list)

- [ ] **Step 1: Add CSS modules to build script**

In `scripts/build-html.py`, add 3 new CSS entries after `"css/file-watcher.css"` (line 38):

```python
    "css/file-watcher.css",
    "css/toast.css",
    "css/deploy-strip.css",
    "css/status-bar.css",
```

- [ ] **Step 2: Add JS modules to build script**

In `scripts/build-html.py`, add 3 new JS entries. Toast must come early (before modules that use it). Insert after `"js/state.js"` (line 74):

```python
    "js/state.js",
    "js/toast.js",
```

Insert `deploy-strip.js` and `status-bar.js` after `"js/topbar.js"` (line 94):

```python
    "js/topbar.js",
    "js/deploy-strip.js",
    "js/status-bar.js",
```

- [ ] **Step 3: Create empty placeholder files so build doesn't break**

Create these 6 empty files with a module header comment:
- `src/frontend/js/toast.js` → `/* ToastManager — unified notification system */`
- `src/frontend/css/toast.css` → `/* Toast notification styles */`
- `src/frontend/js/deploy-strip.js` → `/* DeployContextStrip — deploy context notification */`
- `src/frontend/css/deploy-strip.css` → `/* Deploy context strip styles */`
- `src/frontend/js/status-bar.js` → `/* StatusBar — footer status bar */`
- `src/frontend/css/status-bar.css` → `/* Status bar styles */`

- [ ] **Step 4: Verify build still passes**

Run: `python scripts/build-html.py`
Expected: "Building EDOG Log Viewer... Done." with no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-html.py src/frontend/js/toast.js src/frontend/css/toast.css src/frontend/js/deploy-strip.js src/frontend/css/deploy-strip.css src/frontend/js/status-bar.js src/frontend/css/status-bar.css
git commit -m "chore: register new F1-F4 modules in build script"
```

---

### Task 2: Implement Toast System — CSS

**Files:**
- Create: `src/frontend/css/toast.css`

- [ ] **Step 1: Write toast CSS**

Replace the placeholder in `src/frontend/css/toast.css` with:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Toast Notification System
   Unified toast manager — replaces all fragmented _showToast implementations.
   Position: fixed bottom-right, stacks upward. Max 3 visible.
   @author Pixel — EDOG Studio hivemind
   ═══════════════════════════════════════════════════════════════════════════ */

.toast-container {
  position: fixed;
  bottom: calc(var(--footer-height, 24px) + 12px);
  right: 16px;
  z-index: 900;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 320px;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--text);
  pointer-events: auto;
  animation: toastSlideIn 300ms ease-out forwards;
  border-left: 3px solid var(--accent);
}

.toast-item.variant-success { border-left-color: var(--status-success, #18a058); }
.toast-item.variant-warning { border-left-color: var(--status-warning, #e5940c); }
.toast-item.variant-error   { border-left-color: var(--status-error, #e5453b); }
.toast-item.variant-info    { border-left-color: var(--accent); }

.toast-item.exiting {
  animation: toastSlideOut 200ms ease-in forwards;
}

.toast-msg {
  flex: 1;
  line-height: 1.4;
  word-break: break-word;
}

.toast-action {
  background: none;
  border: none;
  color: var(--accent);
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
  transition: opacity 80ms ease-out;
}

.toast-action:hover { opacity: 0.7; }

.toast-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;
  transition: color 80ms ease-out;
  flex-shrink: 0;
}

.toast-dismiss:hover { color: var(--text); }

@keyframes toastSlideIn {
  from { opacity: 0; transform: translateX(100%); }
  to   { opacity: 1; transform: translateX(0); }
}

@keyframes toastSlideOut {
  from { opacity: 1; transform: translateX(0); }
  to   { opacity: 0; transform: translateX(100%); }
}
```

- [ ] **Step 2: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/css/toast.css
git commit -m "feat(F4): add toast notification CSS"
```

---

### Task 3: Implement Toast System — JS

**Files:**
- Create: `src/frontend/js/toast.js`

- [ ] **Step 1: Write ToastManager class**

Replace the placeholder in `src/frontend/js/toast.js` with:

```js
/**
 * ToastManager — unified notification system.
 *
 * Replaces all fragmented _showToast implementations.
 * API: window.edogToast(message, variant, options)
 *
 * @author Pixel — EDOG Studio hivemind
 */
class ToastManager {
  constructor() {
    this._container = null;
    this._toasts = new Map();
    this._queue = [];
    this._maxVisible = 3;
    this._init();
  }

  _init() {
    this._container = document.createElement('div');
    this._container.className = 'toast-container';
    document.body.appendChild(this._container);
  }

  /**
   * Show a toast notification.
   * @param {string} message — text content
   * @param {string} [variant='info'] — 'info' | 'success' | 'warning' | 'error'
   * @param {object} [opts] — { duration, action, id }
   * @returns {string} toast ID
   */
  show(message, variant, opts) {
    variant = variant || 'info';
    opts = opts || {};
    var duration = opts.duration !== undefined ? opts.duration : 4000;
    var id = opts.id || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));

    // Dedup: if same ID exists, update message and reset timer
    if (this._toasts.has(id)) {
      var existing = this._toasts.get(id);
      var msgEl = existing.el.querySelector('.toast-msg');
      if (msgEl) msgEl.textContent = message;
      if (existing.timer) clearTimeout(existing.timer);
      if (duration > 0) {
        existing.timer = setTimeout(this.dismiss.bind(this, id), duration);
      }
      return id;
    }

    // Queue if at max
    var visible = this._container.children.length;
    if (visible >= this._maxVisible) {
      this._queue.push({ message: message, variant: variant, opts: opts });
      return id;
    }

    this._render(id, message, variant, duration, opts.action || null);
    return id;
  }

  _render(id, message, variant, duration, action) {
    var self = this;
    var el = document.createElement('div');
    el.className = 'toast-item variant-' + variant;
    el.dataset.toastId = id;

    var msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    el.appendChild(msgSpan);

    if (action) {
      var btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', function() {
        if (action.onClick) action.onClick();
        self.dismiss(id);
      });
      el.appendChild(btn);
    }

    var dismiss = document.createElement('button');
    dismiss.className = 'toast-dismiss';
    dismiss.textContent = '\u2715';
    dismiss.addEventListener('click', function() { self.dismiss(id); });
    el.appendChild(dismiss);

    this._container.appendChild(el);

    var timer = null;
    if (duration > 0) {
      timer = setTimeout(function() { self.dismiss(id); }, duration);
    }

    this._toasts.set(id, { el: el, timer: timer });
  }

  /**
   * Dismiss a toast by ID.
   * @param {string} id
   */
  dismiss(id) {
    var entry = this._toasts.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.classList.add('exiting');
    var self = this;
    entry.el.addEventListener('animationend', function() {
      if (entry.el.parentNode) entry.el.remove();
      self._toasts.delete(id);
      self._drainQueue();
    }, { once: true });
    // Fallback if animationend doesn't fire
    setTimeout(function() {
      if (entry.el.parentNode) entry.el.remove();
      self._toasts.delete(id);
      self._drainQueue();
    }, 300);
  }

  /** Dismiss all toasts. */
  clear() {
    var self = this;
    this._toasts.forEach(function(_, id) { self.dismiss(id); });
    this._queue = [];
  }

  _drainQueue() {
    if (this._queue.length === 0) return;
    if (this._container.children.length >= this._maxVisible) return;
    var next = this._queue.shift();
    this.show(next.message, next.variant, next.opts);
  }
}

// Global singleton
window.edogToastManager = new ToastManager();

/**
 * Global toast function.
 * @param {string} message
 * @param {string} [variant='info']
 * @param {object} [opts]
 */
window.edogToast = function(message, variant, opts) {
  return window.edogToastManager.show(message, variant, opts);
};
```

- [ ] **Step 2: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/toast.js
git commit -m "feat(F4): add ToastManager class + window.edogToast API"
```

---

### Task 4: Migrate Existing Toast Implementations

**Files:**
- Modify: `src/frontend/js/main.js:1267-1297` (remove `showExportToast` body, replace with `window.edogToast`)
- Modify: `src/frontend/js/mock-renderer.js:1596-1612` (replace `_showToast` method)
- Modify: `src/frontend/js/notebook-view.js:1161-1185` (replace `_showToast` method)
- Modify: `src/frontend/js/tab-telemetry.js:1174-1198` (replace `_showToast` method)

- [ ] **Step 1: Replace showExportToast in main.js**

In `src/frontend/js/main.js`, replace the `showExportToast` method body (the method that creates `.export-toast` divs manually) so it delegates to `window.edogToast`:

```js
  showExportToast = (countOrMessage, formatOrType) => {
    const formatLabels = { json: 'JSON', csv: 'CSV', txt: 'Plain Text' };
    var message, variant;
    if (typeof countOrMessage === 'number') {
      message = 'Exported ' + countOrMessage.toLocaleString() + ' entries as ' + (formatLabels[formatOrType] || formatOrType);
      variant = 'success';
    } else {
      message = countOrMessage;
      variant = formatOrType || 'info';
    }
    window.edogToast(message, variant);
  }
```

- [ ] **Step 2: Replace _showToast in mock-renderer.js**

Find the `_showToast(msg)` method in `mock-renderer.js` (around line 1596) and replace the entire method body:

```js
  _showToast(msg) {
    window.edogToast(msg, 'info');
  }
```

- [ ] **Step 3: Replace _showToast in notebook-view.js**

Find `_showToast(message, type = 'info')` in `notebook-view.js` (around line 1161) and replace:

```js
  _showToast(message, type = 'info') {
    window.edogToast(message, type);
  }
```

- [ ] **Step 4: Replace _showToast in tab-telemetry.js**

Find `_showToast(msg, icon)` in `tab-telemetry.js` (around line 1174) and replace:

```js
  _showToast(msg, icon) {
    window.edogToast(msg, 'info');
  }
```

- [ ] **Step 5: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/main.js src/frontend/js/mock-renderer.js src/frontend/js/notebook-view.js src/frontend/js/tab-telemetry.js
git commit -m "feat(F4): migrate all toast implementations to window.edogToast"
```

---

### Task 5: Deploy Context Strip — CSS

**Files:**
- Create: `src/frontend/css/deploy-strip.css`

- [ ] **Step 1: Write deploy strip CSS**

Replace the placeholder in `src/frontend/css/deploy-strip.css` with the approved design from the mockup. This is the breadcrumb-style strip with green glow:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Deploy Context Strip
   Persistent notification bar showing deploy target info.
   Renders in .notification-zone above #file-change-bar.
   Green accent for connected state. Breadcrumb hierarchy pattern.
   @author Pixel — EDOG Studio hivemind
   ═══════════════════════════════════════════════════════════════════════════ */

.deploy-strip {
  display: none;
  align-items: center;
  gap: 14px;
  height: 38px;
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid rgba(24,160,88,0.15);
  font-size: 12px;
  font-family: var(--font-body);
  color: var(--text-dim);
  overflow: hidden;
  animation: dsSlideDown 360ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  position: relative;
}

.deploy-strip::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  background: var(--status-success, #18a058);
  box-shadow: 0 0 12px rgba(24,160,88,0.35), 4px 0 20px rgba(24,160,88,0.08);
}

.deploy-strip::after {
  content: '';
  position: absolute;
  left: 0; top: 0; right: 0; bottom: 0;
  background: linear-gradient(90deg, rgba(24,160,88,0.04) 0%, transparent 40%);
  pointer-events: none;
}

.deploy-strip.active { display: flex; }

/* Connected badge */
.deploy-strip .ds-badge {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 12px 4px 10px;
  background: rgba(24,160,88,0.08);
  border: 1px solid rgba(24,160,88,0.15);
  border-radius: 100px;
  flex-shrink: 0;
  z-index: 1;
}

.deploy-strip .ds-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--status-success, #18a058);
  box-shadow: 0 0 0 3px rgba(24,160,88,0.12), 0 0 8px rgba(24,160,88,0.4);
  animation: dsPulse 2.5s ease-in-out infinite;
  flex-shrink: 0;
}

.deploy-strip .ds-badge-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--status-success, #18a058);
  letter-spacing: 0.01em;
}

/* Breadcrumb path */
.deploy-strip .ds-path {
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 1;
}

.deploy-strip .ds-path-seg {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-dim);
}

.deploy-strip .ds-path-seg.bold {
  font-weight: 600;
  color: var(--text);
}

.deploy-strip .ds-chevron {
  font-size: 14px;
  color: var(--text-muted);
  opacity: 0.5;
}

/* Divider */
.deploy-strip .ds-divider {
  width: 1px;
  height: 18px;
  background: var(--border-alt, rgba(0,0,0,0.12));
  flex-shrink: 0;
  z-index: 1;
}

/* Commit chip */
.deploy-strip .ds-commit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 150ms ease-out;
  border: 1px solid transparent;
  z-index: 1;
}

.deploy-strip .ds-commit:hover {
  background: rgba(109,92,255,0.06);
  border-color: rgba(109,92,255,0.12);
  box-shadow: 0 2px 8px rgba(109,92,255,0.08);
}

.deploy-strip .ds-sha {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}

.deploy-strip .ds-msg {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-dim);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deploy-strip .ds-spacer { flex: 1; z-index: 1; }

.deploy-strip .ds-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  z-index: 1;
}

/* Commit tooltip */
.ds-tooltip {
  position: fixed;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border-alt, rgba(0,0,0,0.12));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
  z-index: 500;
  pointer-events: none;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 150ms ease, transform 150ms ease;
  max-width: 360px;
  font-size: 12px;
  font-family: var(--font-body);
}

.ds-tooltip.visible { opacity: 1; transform: translateY(0); }

.ds-tooltip .dt-sha {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
  margin-bottom: 4px;
}

.ds-tooltip .dt-msg {
  color: var(--text);
  line-height: 1.4;
  font-weight: 500;
}

.ds-tooltip .dt-author {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

@keyframes dsSlideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes dsPulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(24,160,88,0.12), 0 0 8px rgba(24,160,88,0.4); }
  50%      { box-shadow: 0 0 0 5px rgba(24,160,88,0.06), 0 0 12px rgba(24,160,88,0.25); }
}
```

- [ ] **Step 2: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/css/deploy-strip.css
git commit -m "feat(F1): add deploy context strip CSS"
```

---

### Task 6: Deploy Context Strip — JS + HTML

**Files:**
- Create: `src/frontend/js/deploy-strip.js`
- Modify: `src/frontend/index.html:56-62` (add strip div to notification zone)

- [ ] **Step 1: Add deploy strip div to index.html**

In `src/frontend/index.html`, insert a new div as the FIRST child of `.notification-zone` (before `#file-change-bar`):

```html
  <div class="notification-zone">
    <div id="deploy-context-strip" class="deploy-strip"></div>
    <div id="file-change-bar" class="file-change-bar"></div>
```

- [ ] **Step 2: Write DeployContextStrip class**

Replace the placeholder in `src/frontend/js/deploy-strip.js`:

```js
/**
 * DeployContextStrip — persistent deploy context notification.
 *
 * Shows tenant, capacity, workspace, lakehouse, commit SHA in a breadcrumb
 * strip when FLT is connected. Renders into #deploy-context-strip.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class DeployContextStrip {
  constructor() {
    this._el = document.getElementById('deploy-context-strip');
    this._tooltip = null;
    this._deployedAt = null;
    this._timeTimer = null;
    this._createTooltip();
  }

  /**
   * Update strip with deploy config data.
   * @param {object|null} status — from /api/studio/status
   */
  update(status) {
    if (!this._el) return;

    if (!status || !status.deployTarget || status.phase === 'idle' || status.phase === 'stopped') {
      this._el.classList.remove('active');
      if (this._timeTimer) { clearInterval(this._timeTimer); this._timeTimer = null; }
      return;
    }

    var t = status.deployTarget;
    var self = this;

    this._el.innerHTML = '';

    // Badge
    var badge = document.createElement('div');
    badge.className = 'ds-badge';
    badge.innerHTML = '<span class="ds-dot"></span><span class="ds-badge-label">Connected</span>';
    this._el.appendChild(badge);

    // Breadcrumb path: tenant › capacity › workspace › lakehouse
    var path = document.createElement('div');
    path.className = 'ds-path';
    var segments = [
      { text: t.tenantName || 'tenant', bold: false },
      { text: t.capacityId || 'capacity', bold: false },
      { text: t.workspaceName || t.workspaceId || 'workspace', bold: true },
      { text: t.lakehouseName || t.artifactId || 'lakehouse', bold: true },
    ];
    segments.forEach(function(seg, i) {
      if (i > 0) {
        var chev = document.createElement('span');
        chev.className = 'ds-chevron';
        chev.textContent = '\u203A';
        path.appendChild(chev);
      }
      var span = document.createElement('span');
      span.className = 'ds-path-seg' + (seg.bold ? ' bold' : '');
      span.textContent = seg.text;
      path.appendChild(span);
    });
    this._el.appendChild(path);

    // Divider
    var div = document.createElement('div');
    div.className = 'ds-divider';
    this._el.appendChild(div);

    // Commit chip
    if (t.commitSha) {
      var commit = document.createElement('div');
      commit.className = 'ds-commit';
      var sha = document.createElement('span');
      sha.className = 'ds-sha';
      sha.textContent = t.commitSha.substring(0, 7);
      commit.appendChild(sha);
      if (t.commitMessage) {
        var msg = document.createElement('span');
        msg.className = 'ds-msg';
        msg.textContent = t.commitMessage;
        commit.appendChild(msg);
      }
      commit.addEventListener('mouseenter', function(e) {
        self._showTooltip(e, t);
      });
      commit.addEventListener('mouseleave', function() {
        self._hideTooltip();
      });
      this._el.appendChild(commit);
    }

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'ds-spacer';
    this._el.appendChild(spacer);

    // Time
    this._deployedAt = this._deployedAt || Date.now();
    var time = document.createElement('span');
    time.className = 'ds-time';
    time.id = 'ds-time';
    this._el.appendChild(time);
    this._updateTime();
    if (!this._timeTimer) {
      this._timeTimer = setInterval(function() { self._updateTime(); }, 60000);
    }

    this._el.classList.add('active');
  }

  _updateTime() {
    var el = document.getElementById('ds-time');
    if (!el || !this._deployedAt) return;
    var sec = Math.floor((Date.now() - this._deployedAt) / 1000);
    if (sec < 60) el.textContent = 'just now';
    else if (sec < 3600) el.textContent = Math.floor(sec / 60) + 'm ago';
    else el.textContent = Math.floor(sec / 3600) + 'h ago';
  }

  _createTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'ds-tooltip';
    document.body.appendChild(this._tooltip);
  }

  _showTooltip(event, target) {
    if (!this._tooltip) return;
    this._tooltip.innerHTML =
      '<div class="dt-sha">' + this._esc(target.commitSha || '') + '</div>' +
      '<div class="dt-msg">' + this._esc(target.commitMessage || '') + '</div>' +
      '<div class="dt-author">' + this._esc(target.commitAuthor || '') + '</div>';
    var rect = event.currentTarget.getBoundingClientRect();
    this._tooltip.style.left = rect.left + 'px';
    this._tooltip.style.top = (rect.bottom + 6) + 'px';
    this._tooltip.classList.add('visible');
  }

  _hideTooltip() {
    if (this._tooltip) this._tooltip.classList.remove('visible');
  }

  _esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  /** Hide strip and stop timers. */
  hide() {
    if (this._el) this._el.classList.remove('active');
    if (this._timeTimer) { clearInterval(this._timeTimer); this._timeTimer = null; }
    this._deployedAt = null;
  }
}

window.edogDeployStrip = new DeployContextStrip();
```

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/deploy-strip.js src/frontend/index.html
git commit -m "feat(F1+F2): add deploy context strip with commit SHA"
```

---

### Task 7: Wire Deploy Strip to TopBar Config Polling

**Files:**
- Modify: `src/frontend/js/topbar.js:74-100` (add deploy strip update call)

- [ ] **Step 1: Add deploy strip update to fetchConfig**

In `src/frontend/js/topbar.js`, inside the `fetchConfig()` method, after the sidebar phase sync block (around line 100), add a call to feed the deploy strip. Insert after the `if (config.fltPort ...)` block:

```js
      // F1: Update deploy context strip
      if (window.edogDeployStrip) {
        fetch('/api/studio/status').then(function(r) {
          return r.ok ? r.json() : null;
        }).then(function(s) {
          if (s) window.edogDeployStrip.update(s);
        }).catch(function() {});
      }
```

Note: This piggybacks on the existing 30s config poll. The `/api/studio/status` endpoint is already called by the deploy tooltip on hover — now we call it on every poll to keep the strip current.

- [ ] **Step 2: Hide strip on disconnect**

In the same `fetchConfig()` method, in the error/stopped branches (around lines 49-51 and 81-87), add:

```js
        if (window.edogDeployStrip) window.edogDeployStrip.hide();
```

Add this line inside both the `if (!configResp.ok)` block and the `else if (config.studioPhase === 'crashed')` block.

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/topbar.js
git commit -m "feat(F1): wire deploy strip to topbar config polling"
```

---

### Task 8: Footer Status Bar — CSS

**Files:**
- Create: `src/frontend/css/status-bar.css`

- [ ] **Step 1: Write status bar CSS**

Replace the placeholder in `src/frontend/css/status-bar.css`:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Footer Status Bar
   VS Code-style 24px bar pinned to bottom. Phase, coverage, feedback.
   Replaces sidebar footer.
   @author Pixel — EDOG Studio hivemind
   ═══════════════════════════════════════════════════════════════════════════ */

.status-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 24px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--text-dim);
  z-index: 100;
}

.sb-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-phase-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.sb-phase-dot.connected { background: var(--status-success, #18a058); }
.sb-phase-dot.deploying { background: var(--status-warning, #e5940c); }
.sb-phase-dot.disconnected { background: var(--text-muted); }

.sb-phase-label {
  font-weight: 500;
  white-space: nowrap;
}

.sb-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.sb-coverage {
  background: none;
  border: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 80ms ease-out, color 80ms ease-out;
}

.sb-coverage:hover {
  background: var(--hover, rgba(0,0,0,0.04));
  color: var(--text);
}

.sb-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sb-feedback {
  background: none;
  border: none;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 80ms ease-out, color 80ms ease-out;
}

.sb-feedback:hover {
  background: var(--hover, rgba(0,0,0,0.04));
  color: var(--accent);
}

.sb-version {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
}

/* Adjust main content so it doesn't overlap the footer */
.cockpit-body {
  padding-bottom: 24px;
}
```

- [ ] **Step 2: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/css/status-bar.css
git commit -m "feat(F3): add footer status bar CSS"
```

---

### Task 9: Footer Status Bar — JS + HTML + Sidebar Cleanup

**Files:**
- Create: `src/frontend/js/status-bar.js`
- Modify: `src/frontend/index.html:93-103` (remove sidebar footer)
- Modify: `src/frontend/index.html:379` (add footer bar HTML before script tag)

- [ ] **Step 1: Add footer bar HTML to index.html**

In `src/frontend/index.html`, insert the footer bar HTML just before the `<script>` tag (before line 381):

```html
  <!-- Footer Status Bar (F3) -->
  <footer id="status-bar" class="status-bar">
    <div class="sb-left">
      <span class="sb-phase-dot disconnected" id="sb-phase-dot"></span>
      <span class="sb-phase-label" id="sb-phase-label">Disconnected</span>
    </div>
    <div class="sb-center">
      <button class="sb-coverage" id="sb-coverage" title="Coverage details">--</button>
    </div>
    <div class="sb-right">
      <button class="sb-feedback" id="sb-feedback" title="Send feedback">Feedback &#9670;</button>
      <span class="sb-version" id="sb-version"></span>
    </div>
  </footer>
```

- [ ] **Step 2: Remove sidebar footer from index.html**

Remove the entire `.sidebar-footer` div (lines 93-103):

```html
      <div class="sidebar-footer">
        <div class="phase-row">
          <div class="phase-dot-container"><div class="phase-dot disconnected" id="sidebar-phase-dot"></div></div>
          <span class="phase-label" id="sidebar-phase-label">Browsing</span>
        </div>
        <div class="sidebar-token-health">
          <div class="token-ring-container"><div class="token-ring"><svg viewBox="0 0 22 22"><circle class="ring-bg" cx="11" cy="11" r="8.5"/><circle class="ring-fg" id="sidebar-token-ring-fg" cx="11" cy="11" r="8.5" stroke-dasharray="53.4" stroke-dashoffset="53.4"/></svg></div></div>
          <span class="token-label">Token</span>
          <span class="token-time" id="sidebar-token-time"></span>
        </div>
      </div>
```

- [ ] **Step 3: Write StatusBar class**

Replace the placeholder in `src/frontend/js/status-bar.js`:

```js
/**
 * StatusBar — footer status bar.
 *
 * VS Code-style 24px bar at bottom of viewport.
 * Left: phase indicator. Center: coverage badge. Right: feedback + version.
 * Replaces sidebar footer.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class StatusBar {
  constructor() {
    this._phaseDot = document.getElementById('sb-phase-dot');
    this._phaseLabel = document.getElementById('sb-phase-label');
    this._coverageBtn = document.getElementById('sb-coverage');
    this._feedbackBtn = document.getElementById('sb-feedback');
    this._versionEl = document.getElementById('sb-version');
    this._bindEvents();
    this._fetchVersion();
  }

  _bindEvents() {
    var self = this;
    if (this._feedbackBtn) {
      this._feedbackBtn.addEventListener('click', function() { self._openFeedback(); });
    }
  }

  /**
   * Update phase indicator.
   * @param {string} phase — 'connected' | 'disconnected' | 'deploying'
   */
  setPhase(phase) {
    if (this._phaseDot) {
      this._phaseDot.className = 'sb-phase-dot ' + phase;
    }
    if (this._phaseLabel) {
      var labels = { connected: 'Connected', disconnected: 'Disconnected', deploying: 'Deploying' };
      this._phaseLabel.textContent = labels[phase] || phase;
    }
  }

  /**
   * Update coverage badge text.
   * @param {string} text — e.g., "72% L \u00B7 65% B \u00B7 80% M" or "--"
   */
  setCoverage(text) {
    if (this._coverageBtn) {
      this._coverageBtn.textContent = text || '--';
    }
  }

  _fetchVersion() {
    var self = this;
    fetch('/api/edog/health').then(function(r) {
      return r.ok ? r.json() : null;
    }).then(function(h) {
      if (h && h.version && self._versionEl) {
        self._versionEl.textContent = 'EDOG v' + h.version;
      }
    }).catch(function() {});
  }

  _openFeedback() {
    // Try backend gh-based feedback first
    var title = prompt('Feedback title:');
    if (!title) return;
    var body = prompt('Description (optional):') || '';

    fetch('/api/studio/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, body: body }),
    }).then(function(r) {
      if (r.ok) return r.json();
      throw new Error('Backend feedback failed');
    }).then(function(data) {
      window.edogToast('Feedback submitted' + (data.issueNumber ? ' \u2014 issue #' + data.issueNumber : ''), 'success');
    }).catch(function() {
      // Fallback: open GitHub issues in browser
      var url = 'https://github.com/guptahemant65/edog-studio/issues/new?title=' + encodeURIComponent('[Feedback] ' + title) + '&body=' + encodeURIComponent(body);
      window.open(url, '_blank');
      window.edogToast('Opened feedback form in browser', 'info');
    });
  }
}

window.edogStatusBar = new StatusBar();
```

- [ ] **Step 4: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/js/status-bar.js src/frontend/index.html
git commit -m "feat(F3): add footer status bar, remove sidebar footer"
```

---

### Task 10: Wire Status Bar to TopBar Config Polling + Fix Sidebar References

**Files:**
- Modify: `src/frontend/js/topbar.js:94-99` (update phase sync to use status bar)
- Modify: `src/frontend/js/sidebar.js` (remove/guard sidebar footer references)

- [ ] **Step 1: Update topbar.js to feed the status bar**

In `src/frontend/js/topbar.js`, find the sidebar phase sync block (around line 94-100):

```js
      // Sync sidebar phase and WebSocket port from studio state
      if (window.edogSidebar) {
        if (config.studioPhase === 'running') {
          window.edogSidebar.setPhase('connected');
        } else if (config.studioPhase === 'idle' || config.studioPhase === 'stopped') {
          window.edogSidebar.setPhase('disconnected');
        }
      }
```

Add status bar sync immediately after:

```js
      // F3: Sync footer status bar phase
      if (window.edogStatusBar) {
        if (config.studioPhase === 'running') {
          window.edogStatusBar.setPhase('connected');
        } else if (config.studioPhase === 'deploying') {
          window.edogStatusBar.setPhase('deploying');
        } else {
          window.edogStatusBar.setPhase('disconnected');
        }
      }
```

- [ ] **Step 2: Guard sidebar footer references**

In `src/frontend/js/sidebar.js`, search for any references to `sidebar-phase-dot`, `sidebar-phase-label`, `sidebar-token-ring-fg`, or `sidebar-token-time`. Guard them with null checks or remove them if the elements no longer exist. The key is that `getElementById` will return null since we removed the HTML — ensure no errors are thrown.

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Success.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/topbar.js src/frontend/js/sidebar.js
git commit -m "feat(F3): wire status bar to config polling, guard sidebar refs"
```

---

### Task 11: Final Build + Verification

- [ ] **Step 1: Run full build**

Run: `python scripts/build-html.py`
Expected: Success with no missing module warnings for the 6 new files.

- [ ] **Step 2: Run linter**

Run: `ruff check . && ruff format --check .`
Expected: Pass (only Python files affected by build script change).

- [ ] **Step 3: Run tests**

Run: `python -m pytest --cov --cov-report=term-missing -q`
Expected: All existing tests pass.

- [ ] **Step 4: Verify output HTML contains new modules**

Run: `Select-String -Path src/edog-logs.html -Pattern "ToastManager|DeployContextStrip|StatusBar" | Measure-Object`
Expected: At least 3 matches (one per class).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify F1-F4 build integration"
```
