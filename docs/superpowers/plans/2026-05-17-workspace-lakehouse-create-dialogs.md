# Create Workspace & Lakehouse Dialogs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare inline creation forms with proper modal dialogs covering full state matrices — workspace creation (13 states) and lakehouse creation (12 states).

**Architecture:** Two new classes (`WorkspaceCreateDialog`, `LakehouseCreateDialog`) added to `workspace-explorer.js`. Shared validation logic extracted into a helper object. CSS added to `workspace.css` under `.ws-cd-*` prefix. API client updated to support lakehouse creation payload with schemas. Both dialogs follow the approved Phantom mockups (`workspace-create-dialog.html`, `lakehouse-create-dialog.html`).

**Tech Stack:** Vanilla JS (ADR-002), CSS custom properties, existing design token system.

**Mockups:** `docs/design/mocks/workspace-create-dialog.html`, `docs/design/mocks/lakehouse-create-dialog.html`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/frontend/css/workspace.css` | Modify (append) | All `.ws-cd-*` dialog styles, animations, capacity cards, schema pills |
| `src/frontend/js/workspace-explorer.js` | Modify | `WorkspaceCreateDialog` class, `LakehouseCreateDialog` class, rewire `_showCreateWorkspaceInput()` and `_ctxCreateLakehouse()` |
| `src/frontend/js/api-client.js` | Modify | Update `createLakehouse()` to accept description + schema options |
| `tests/test_build_integration.py` | Verify | Ensure build still passes with new code |

---

### Task 1: Add CSS — Dialog Shell, Overlay, Animations

**Files:**
- Modify: `src/frontend/css/workspace.css` (append after line ~2031)

- [ ] **Step 1: Add dialog overlay + shell styles**

Append to `src/frontend/css/workspace.css`:

```css
/* ═══════════════════════════════════════════════════════════════
   Create Dialog — shared by Workspace + Lakehouse creation
   Prefix: .ws-cd-
   ═══════════════════════════════════════════════════════════════ */

/* Overlay */
.ws-cd-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.35);
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: ws-cd-fadeIn 200ms ease;
}

/* Dialog shell */
.ws-cd-dialog {
  background: var(--surface);
  border-radius: var(--radius-lg, 12px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
  width: 480px;
  max-width: 90vw;
  max-height: 85vh;
  overflow-y: auto;
  animation: ws-cd-dialogIn 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
  position: relative;
}

/* Header */
.ws-cd-header {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: 20px 24px 0;
}
.ws-cd-header-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md, 8px);
  background: var(--accent-dim, rgba(109,92,255,0.07));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent, #6d5cff);
  flex-shrink: 0;
}
.ws-cd-header-icon svg { width: 20px; height: 20px; }
.ws-cd-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
}
.ws-cd-close {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: background 150ms, color 150ms;
}
.ws-cd-close:hover {
  background: var(--surface-hover, rgba(0,0,0,0.04));
  color: var(--text);
}

/* Body */
.ws-cd-body { padding: 16px 24px 0; }

/* Field group */
.ws-cd-field { margin-bottom: 16px; }
.ws-cd-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}
.ws-cd-label-opt {
  font-size: 10px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted);
  opacity: 0.7;
}

/* Text input */
.ws-cd-input {
  width: 100%;
  padding: 10px 12px;
  border: 1.5px solid var(--border, rgba(0,0,0,0.1));
  border-radius: var(--radius-sm, 6px);
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
  box-sizing: border-box;
}
.ws-cd-input:focus {
  border-color: var(--accent, #6d5cff);
  box-shadow: 0 0 0 3px var(--accent-dim, rgba(109,92,255,0.1));
}
.ws-cd-input.invalid {
  border-color: var(--status-fail, #e5453b);
  box-shadow: 0 0 0 3px rgba(229,69,59,0.08);
  animation: ws-cd-shakeX 400ms ease;
}
.ws-cd-input.valid {
  border-color: var(--status-ok, #18a058);
}

/* Textarea */
.ws-cd-textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1.5px solid var(--border, rgba(0,0,0,0.1));
  border-radius: var(--radius-sm, 6px);
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  resize: vertical;
  min-height: 56px;
  max-height: 120px;
  transition: border-color 150ms, box-shadow 150ms;
  box-sizing: border-box;
}
.ws-cd-textarea:focus {
  border-color: var(--accent, #6d5cff);
  box-shadow: 0 0 0 3px var(--accent-dim, rgba(109,92,255,0.1));
}

/* Input meta row (counter + validation icon) */
.ws-cd-input-wrap {
  position: relative;
}
.ws-cd-counter {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--text-muted);
  pointer-events: none;
}
.ws-cd-check {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--status-ok, #18a058);
  font-size: 14px;
  animation: ws-cd-checkPop 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Inline error */
.ws-cd-error {
  font-size: 12px;
  color: var(--status-fail, #e5453b);
  margin-top: 4px;
  animation: ws-cd-fadeSlideDown 200ms ease;
}

/* Context chip (parent workspace badge for lakehouse dialog) */
.ws-cd-context {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--accent-dim, rgba(109,92,255,0.07));
  border-radius: var(--radius-sm, 4px);
  font-size: 12px;
  color: var(--accent, #6d5cff);
  font-weight: 500;
  margin-bottom: 12px;
}
.ws-cd-context svg { width: 14px; height: 14px; }
```

- [ ] **Step 2: Add capacity card styles**

Continue appending to `workspace.css`:

```css
/* Capacity cards */
.ws-cd-cap-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ws-cd-cap-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1.5px solid var(--border, rgba(0,0,0,0.08));
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  transition: border-color 150ms, background 150ms, transform 80ms;
  animation: ws-cd-scaleSpring 300ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.ws-cd-cap-card:hover {
  border-color: var(--accent, #6d5cff);
  background: var(--accent-hover, rgba(109,92,255,0.03));
  transform: translateY(-1px);
}
.ws-cd-cap-card.selected {
  border-color: var(--accent, #6d5cff);
  background: var(--accent-dim, rgba(109,92,255,0.07));
}
.ws-cd-cap-radio {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-bright, rgba(0,0,0,0.15));
  border-radius: 50%;
  flex-shrink: 0;
  position: relative;
  transition: border-color 150ms;
}
.ws-cd-cap-card.selected .ws-cd-cap-radio {
  border-color: var(--accent, #6d5cff);
}
.ws-cd-cap-card.selected .ws-cd-cap-radio::after {
  content: '';
  position: absolute;
  inset: 3px;
  background: var(--accent, #6d5cff);
  border-radius: 50%;
}
.ws-cd-cap-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  flex: 1;
}
.ws-cd-cap-sku {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--accent-dim, rgba(109,92,255,0.08));
  color: var(--accent, #6d5cff);
}
.ws-cd-cap-region {
  font-size: 11px;
  color: var(--text-muted);
}

/* Capacity shimmer */
.ws-cd-shimmer {
  height: 46px;
  border-radius: var(--radius-sm, 6px);
  background: linear-gradient(90deg, var(--surface-hover, #f0f0f3) 25%, var(--surface, #fff) 50%, var(--surface-hover, #f0f0f3) 75%);
  background-size: 200% 100%;
  animation: ws-cd-shimmer 1.5s ease infinite;
}

/* Capacity error */
.ws-cd-cap-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1.5px dashed var(--status-fail, #e5453b);
  border-radius: var(--radius-sm, 6px);
  font-size: 12px;
  color: var(--status-fail, #e5453b);
}
.ws-cd-cap-error button {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--status-fail, #e5453b);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--status-fail);
  font-size: 11px;
  cursor: pointer;
}
```

- [ ] **Step 3: Add schema pill styles (lakehouse)**

Continue appending:

```css
/* Schema toggle */
.ws-cd-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ws-cd-toggle {
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--border-bright, rgba(0,0,0,0.15));
  border: none;
  cursor: pointer;
  position: relative;
  transition: background 200ms;
  flex-shrink: 0;
}
.ws-cd-toggle.on { background: var(--accent, #6d5cff); }
.ws-cd-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ws-cd-toggle.on::after { transform: translateX(16px); }
.ws-cd-toggle-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* Schema pills */
.ws-cd-schemas {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  overflow: hidden;
  transition: max-height 300ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 200ms;
}
.ws-cd-schemas.collapsed { max-height: 0; opacity: 0; margin-top: 0; }
.ws-cd-schemas.expanded { max-height: 200px; opacity: 1; }

.ws-cd-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 16px;
  border: 1.5px solid var(--border, rgba(0,0,0,0.08));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms;
  user-select: none;
}
.ws-cd-pill:hover:not(.locked) {
  border-color: var(--accent, #6d5cff);
}
.ws-cd-pill.selected {
  background: var(--accent-dim, rgba(109,92,255,0.1));
  border-color: var(--accent, #6d5cff);
  color: var(--accent, #6d5cff);
  animation: ws-cd-pillPop 250ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ws-cd-pill.locked {
  background: var(--accent, #6d5cff);
  border-color: var(--accent, #6d5cff);
  color: white;
  cursor: default;
}
.ws-cd-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
```

- [ ] **Step 4: Add footer, progress, success/error banner, animations**

Continue appending:

```css
/* Footer */
.ws-cd-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px 20px;
}
.ws-cd-btn {
  padding: 8px 18px;
  border-radius: var(--radius-sm, 6px);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1.5px solid var(--border, rgba(0,0,0,0.1));
  background: var(--surface);
  color: var(--text);
  transition: all 150ms;
}
.ws-cd-btn:hover { background: var(--surface-hover, rgba(0,0,0,0.03)); }
.ws-cd-btn-primary {
  background: var(--accent, #6d5cff);
  border-color: var(--accent, #6d5cff);
  color: white;
}
.ws-cd-btn-primary:hover { filter: brightness(1.1); }
.ws-cd-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  filter: none;
}
.ws-cd-btn-primary.ready {
  animation: ws-cd-pulseAccent 2s ease infinite;
}
.ws-cd-btn-primary .ws-cd-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: ws-cd-spin 600ms linear infinite;
  margin-right: 6px;
  vertical-align: middle;
}

/* Progress bar */
.ws-cd-progress {
  height: 3px;
  background: var(--accent-dim, rgba(109,92,255,0.1));
  overflow: hidden;
  border-radius: 0 0 var(--radius-lg, 12px) var(--radius-lg, 12px);
}
.ws-cd-progress-bar {
  height: 100%;
  background: var(--accent, #6d5cff);
  width: 0%;
  transition: width 300ms ease;
  animation: ws-cd-progressPulse 1.5s ease infinite;
}

/* Success state */
.ws-cd-success {
  text-align: center;
  padding: 32px 24px;
}
.ws-cd-success-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--status-ok-dim, rgba(24,160,88,0.08));
  color: var(--status-ok, #18a058);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  margin: 0 auto 12px;
  animation: ws-cd-checkPop 400ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ws-cd-success-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.ws-cd-success-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

/* Error banner */
.ws-cd-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  margin: 0 24px 8px;
  border-radius: var(--radius-sm, 6px);
  font-size: 12px;
  animation: ws-cd-fadeSlideDown 250ms ease;
}
.ws-cd-banner.error {
  background: var(--status-fail-dim, rgba(229,69,59,0.08));
  color: var(--status-fail, #e5453b);
}
.ws-cd-banner button {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid currentColor;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
}

/* No-auth overlay */
.ws-cd-noauth {
  position: absolute;
  inset: 0;
  background: rgba(255,255,255,0.85);
  border-radius: var(--radius-lg, 12px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  z-index: 1;
  animation: ws-cd-fadeIn 200ms ease;
}
.ws-cd-noauth-msg {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}

/* ─── Keyframes ─── */
@keyframes ws-cd-fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes ws-cd-dialogIn {
  from { opacity: 0; transform: translateY(16px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ws-cd-shakeX {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px); }
  40% { transform: translateX(5px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(2px); }
}
@keyframes ws-cd-checkPop {
  0% { transform: translateY(-50%) scale(0); }
  60% { transform: translateY(-50%) scale(1.3); }
  100% { transform: translateY(-50%) scale(1); }
}
@keyframes ws-cd-pillPop {
  0% { transform: scale(0.9); }
  60% { transform: scale(1.08); }
  100% { transform: scale(1); }
}
@keyframes ws-cd-scaleSpring {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes ws-cd-fadeSlideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes ws-cd-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes ws-cd-pulseAccent {
  0%, 100% { box-shadow: 0 0 0 0 rgba(109,92,255,0.3); }
  50% { box-shadow: 0 0 0 6px rgba(109,92,255,0); }
}
@keyframes ws-cd-spin {
  to { transform: rotate(360deg); }
}
@keyframes ws-cd-progressPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
```

- [ ] **Step 5: Build to verify CSS compiles into HTML**

Run: `python scripts/build-html.py`
Expected: Builds successfully, HTML file includes new `.ws-cd-*` styles.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/css/workspace.css
git commit -m "feat(workspace): add CSS for create workspace/lakehouse dialogs

Adds .ws-cd-* styles: dialog shell, overlay, capacity cards, schema
pills, progress bar, success/error states, 12 named keyframe animations.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Shared Validation Helper

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js` (add before `WorkspaceExplorer` class)

- [ ] **Step 1: Add validation helper object**

Add this BEFORE the `class WorkspaceExplorer` declaration in `workspace-explorer.js`:

```javascript
/* ═══════════════════════════════════════════════════════════════
   Create-dialog shared validation
   ═══════════════════════════════════════════════════════════════ */
var WsCreateValidation = {
  NAME_MIN: 3,
  NAME_MAX: 256,
  NAME_RE: /^[A-Za-z0-9][A-Za-z0-9 _-]*$/,

  /** Validate a workspace/lakehouse name. Returns {valid, error}. */
  validateName: function(name, existingNames) {
    var trimmed = (name || '').trim();
    if (!trimmed) return { valid: false, error: '' };
    if (trimmed.length < this.NAME_MIN) {
      return { valid: false, error: 'Name must be at least ' + this.NAME_MIN + ' characters' };
    }
    if (trimmed.length > this.NAME_MAX) {
      return { valid: false, error: 'Name must be at most ' + this.NAME_MAX + ' characters' };
    }
    if (!this.NAME_RE.test(trimmed)) {
      return { valid: false, error: 'Only letters, numbers, hyphens, underscores, spaces' };
    }
    var lower = trimmed.toLowerCase();
    for (var i = 0; i < existingNames.length; i++) {
      if ((existingNames[i] || '').toLowerCase() === lower) {
        return { valid: false, error: 'A workspace with this name already exists' };
      }
    }
    return { valid: true, error: '' };
  },

  /** Validate lakehouse name against workspace items. Returns {valid, error}. */
  validateLakehouseName: function(name, existingItemNames) {
    var result = this.validateName(name, []);
    if (!result.valid) return result;
    var trimmed = (name || '').trim().toLowerCase();
    for (var i = 0; i < existingItemNames.length; i++) {
      if ((existingItemNames[i] || '').toLowerCase() === trimmed) {
        return { valid: false, error: 'An item with this name already exists in this workspace' };
      }
    }
    return { valid: true, error: '' };
  }
};
```

- [ ] **Step 2: Build to verify no syntax errors**

Run: `python scripts/build-html.py`
Expected: Builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(workspace): add shared create-dialog validation helper

WsCreateValidation validates name length, character set, and
duplicate detection for both workspace and lakehouse creation.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: WorkspaceCreateDialog Class

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js` (add after `WsCreateValidation`, before `class WorkspaceExplorer`)

- [ ] **Step 1: Add WorkspaceCreateDialog class**

Add this after `WsCreateValidation` and before `class WorkspaceExplorer`:

```javascript
/* ═══════════════════════════════════════════════════════════════
   WorkspaceCreateDialog — modal for creating a Fabric workspace
   States: empty → valid/invalid → capacity-loading → ready → creating → success/failure
   ═══════════════════════════════════════════════════════════════ */
class WorkspaceCreateDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._existingNames = (opts.existingWorkspaces || []).map(function(w) { return w.displayName; });
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._counterEl = null;
    this._nameValidEl = null;
    this._capListEl = null;
    this._createBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._selectedCapacity = null;
    this._capacitiesLoaded = false;
    this._state = 'idle'; // idle | creating | success | failed
    this.onComplete = null;
    this.onClose = null;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    this._nameInput.focus();
    this._loadCapacities();
    this._boundEsc = this._onEsc.bind(this);
    document.addEventListener('keydown', this._boundEsc);
  }

  close() {
    if (!this._overlayEl) return;
    if (this._state === 'idle' && this._nameInput && this._nameInput.value.trim()) {
      if (!confirm('Discard workspace creation?')) return;
    }
    document.removeEventListener('keydown', this._boundEsc);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onEsc(e) {
    if (e.key === 'Escape') this.close();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Create workspace');
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    header.innerHTML =
      '<div class="ws-cd-header-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
      '</div>' +
      '<div class="ws-cd-title">Create Workspace</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner (hidden initially)
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'ws-cd-field';
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-cd-label';
    nameLabel.textContent = 'WORKSPACE NAME';
    nameField.appendChild(nameLabel);

    var nameWrap = document.createElement('div');
    nameWrap.className = 'ws-cd-input-wrap';
    this._nameInput = document.createElement('input');
    this._nameInput.className = 'ws-cd-input';
    this._nameInput.type = 'text';
    this._nameInput.placeholder = 'Enter workspace name';
    this._nameInput.maxLength = WsCreateValidation.NAME_MAX;
    this._nameInput.setAttribute('aria-label', 'Workspace name');
    this._nameInput.addEventListener('input', function() { self._validateName(); });
    nameWrap.appendChild(this._nameInput);

    this._counterEl = document.createElement('span');
    this._counterEl.className = 'ws-cd-counter';
    this._counterEl.textContent = '0 / ' + WsCreateValidation.NAME_MAX;
    nameWrap.appendChild(this._counterEl);

    nameField.appendChild(nameWrap);
    this._nameValidEl = document.createElement('div');
    this._nameValidEl.className = 'ws-cd-error';
    this._nameValidEl.style.display = 'none';
    nameField.appendChild(this._nameValidEl);
    body.appendChild(nameField);

    // Capacity field
    var capField = document.createElement('div');
    capField.className = 'ws-cd-field';
    var capLabel = document.createElement('div');
    capLabel.className = 'ws-cd-label';
    capLabel.innerHTML = 'CAPACITY <span class="ws-cd-label-opt">(optional)</span>';
    capField.appendChild(capLabel);
    this._capListEl = document.createElement('div');
    this._capListEl.className = 'ws-cd-cap-list';
    // Shimmer placeholders
    this._capListEl.innerHTML =
      '<div class="ws-cd-shimmer"></div>' +
      '<div class="ws-cd-shimmer" style="animation-delay:0.15s"></div>';
    capField.appendChild(this._capListEl);
    body.appendChild(capField);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._createBtn = document.createElement('button');
    this._createBtn.className = 'ws-cd-btn ws-cd-btn-primary';
    this._createBtn.textContent = 'Create Workspace';
    this._createBtn.disabled = true;
    this._createBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._createBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar (hidden)
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _validateName() {
    var name = this._nameInput.value;
    this._counterEl.textContent = name.length + ' / ' + WsCreateValidation.NAME_MAX;
    var result = WsCreateValidation.validateName(name, this._existingNames);

    // Remove previous state classes
    this._nameInput.classList.remove('valid', 'invalid');
    this._nameValidEl.style.display = 'none';
    // Remove any existing check icon
    var existing = this._nameInput.parentNode.querySelector('.ws-cd-check');
    if (existing) existing.remove();

    if (!name.trim()) {
      // Empty — neutral
      this._counterEl.style.display = '';
    } else if (result.valid) {
      this._nameInput.classList.add('valid');
      this._counterEl.style.display = 'none';
      var check = document.createElement('span');
      check.className = 'ws-cd-check';
      check.textContent = '\u2713';
      this._nameInput.parentNode.appendChild(check);
    } else {
      this._nameInput.classList.add('invalid');
      this._nameValidEl.textContent = result.error;
      this._nameValidEl.style.display = '';
    }

    this._updateCreateBtn();
  }

  _updateCreateBtn() {
    var nameValid = WsCreateValidation.validateName(this._nameInput.value, this._existingNames).valid;
    var ready = nameValid && this._capacitiesLoaded && this._state === 'idle';
    this._createBtn.disabled = !ready;
    if (ready) {
      this._createBtn.classList.add('ready');
    } else {
      this._createBtn.classList.remove('ready');
    }
  }

  _loadCapacities() {
    var self = this;
    this._api.listCapacities().then(function(resp) {
      var caps = (resp && resp.value) ? resp.value : [];
      self._capacitiesLoaded = true;
      self._renderCapacities(caps);
      self._updateCreateBtn();
    }).catch(function(err) {
      self._capacitiesLoaded = true;
      self._capListEl.innerHTML = '';
      var errCard = document.createElement('div');
      errCard.className = 'ws-cd-cap-error';
      errCard.innerHTML = '<span>\u2715 Could not load capacities</span>';
      var retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', function() {
        self._capListEl.innerHTML =
          '<div class="ws-cd-shimmer"></div><div class="ws-cd-shimmer" style="animation-delay:0.15s"></div>';
        self._capacitiesLoaded = false;
        self._loadCapacities();
      });
      errCard.appendChild(retryBtn);
      self._capListEl.appendChild(errCard);
      self._updateCreateBtn();
    });
  }

  _renderCapacities(caps) {
    var self = this;
    this._capListEl.innerHTML = '';

    // Default (no capacity) option
    var defaultCard = this._buildCapCard({ id: '', displayName: 'Default capacity', sku: '', region: '' });
    defaultCard.classList.add('selected');
    this._selectedCapacity = null;
    this._capListEl.appendChild(defaultCard);

    for (var i = 0; i < caps.length; i++) {
      var card = this._buildCapCard(caps[i]);
      card.style.animationDelay = ((i + 1) * 60) + 'ms';
      this._capListEl.appendChild(card);
    }
  }

  _buildCapCard(cap) {
    var self = this;
    var card = document.createElement('div');
    card.className = 'ws-cd-cap-card';
    card.dataset.capId = cap.id || '';

    var radio = document.createElement('div');
    radio.className = 'ws-cd-cap-radio';
    card.appendChild(radio);

    var name = document.createElement('div');
    name.className = 'ws-cd-cap-name';
    name.textContent = cap.displayName || cap.id || 'Unknown';
    card.appendChild(name);

    if (cap.sku) {
      var sku = document.createElement('span');
      sku.className = 'ws-cd-cap-sku';
      sku.textContent = cap.sku;
      card.appendChild(sku);
    }
    if (cap.region) {
      var region = document.createElement('span');
      region.className = 'ws-cd-cap-region';
      region.textContent = cap.region;
      card.appendChild(region);
    }

    card.addEventListener('click', function() {
      self._capListEl.querySelectorAll('.ws-cd-cap-card').forEach(function(c) {
        c.classList.remove('selected');
      });
      card.classList.add('selected');
      self._selectedCapacity = cap.id || null;
      self._updateCreateBtn();
    });
    return card;
  }

  _submit() {
    if (this._state !== 'idle') return;
    var nameResult = WsCreateValidation.validateName(this._nameInput.value, this._existingNames);
    if (!nameResult.valid) {
      this._nameInput.classList.add('invalid');
      return;
    }

    var self = this;
    var name = this._nameInput.value.trim();
    this._state = 'creating';
    this._createBtn.disabled = true;
    this._createBtn.classList.remove('ready');
    this._createBtn.innerHTML = '<span class="ws-cd-spinner"></span>Creating\u2026';
    this._nameInput.disabled = true;
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';

    this._api.createWorkspace(name, this._selectedCapacity).then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(name, result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Create failed');
    });
  }

  _showSuccess(name, result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-success-name">' + this._esc(name) + '</div>' +
        '<div class="ws-cd-success-sub">Workspace created successfully</div>' +
        '<button class="ws-cd-btn ws-cd-btn-primary">Open Workspace</button>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    body.querySelector('.ws-cd-btn-primary').addEventListener('click', function() {
      self._finish(result);
    });

    // Auto-close after 3s
    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(result);
    }, 3000);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundEsc);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._nameInput.disabled = false;
    this._createBtn.innerHTML = 'Create Workspace';
    this._createBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}
```

- [ ] **Step 2: Build to verify no syntax errors**

Run: `python scripts/build-html.py`
Expected: Builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(workspace): add WorkspaceCreateDialog class

Modal dialog with real-time validation, capacity card picker,
progress bar, success/error states, dirty-form confirmation.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: LakehouseCreateDialog Class

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js` (add after `WorkspaceCreateDialog`)

- [ ] **Step 1: Add LakehouseCreateDialog class**

Add after `WorkspaceCreateDialog`:

```javascript
/* ═══════════════════════════════════════════════════════════════
   LakehouseCreateDialog — modal for creating a lakehouse in a workspace
   States: empty → valid/invalid → schemas → creating → success/failure
   ═══════════════════════════════════════════════════════════════ */
class LakehouseCreateDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._workspaceId = opts.workspaceId;
    this._workspaceName = opts.workspaceName || '';
    this._existingItemNames = (opts.existingItems || []).map(function(it) { return it.displayName; });
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._descInput = null;
    this._counterEl = null;
    this._descCounterEl = null;
    this._nameValidEl = null;
    this._createBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._schemasEnabled = true;
    this._selectedSchemas = { dbo: true, bronze: false, silver: false, gold: false };
    this._state = 'idle';
    this.onComplete = null;
    this.onClose = null;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    this._nameInput.focus();
    this._boundEsc = this._onEsc.bind(this);
    document.addEventListener('keydown', this._boundEsc);
  }

  close() {
    if (!this._overlayEl) return;
    if (this._state === 'idle' && this._nameInput && this._nameInput.value.trim()) {
      if (!confirm('Discard lakehouse creation?')) return;
    }
    document.removeEventListener('keydown', this._boundEsc);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onEsc(e) {
    if (e.key === 'Escape') this.close();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Create lakehouse');
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    header.innerHTML =
      '<div class="ws-cd-header-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>' +
      '</div>' +
      '<div class="ws-cd-title">Create Lakehouse</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Context chip
    var ctx = document.createElement('div');
    ctx.className = 'ws-cd-context';
    ctx.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
      '<span>' + this._esc(this._workspaceName) + '</span>';
    body.appendChild(ctx);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'ws-cd-field';
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-cd-label';
    nameLabel.textContent = 'LAKEHOUSE NAME';
    nameField.appendChild(nameLabel);
    var nameWrap = document.createElement('div');
    nameWrap.className = 'ws-cd-input-wrap';
    this._nameInput = document.createElement('input');
    this._nameInput.className = 'ws-cd-input';
    this._nameInput.type = 'text';
    this._nameInput.placeholder = 'Enter lakehouse name';
    this._nameInput.maxLength = WsCreateValidation.NAME_MAX;
    this._nameInput.addEventListener('input', function() { self._validateName(); });
    nameWrap.appendChild(this._nameInput);
    this._counterEl = document.createElement('span');
    this._counterEl.className = 'ws-cd-counter';
    this._counterEl.textContent = '0 / ' + WsCreateValidation.NAME_MAX;
    nameWrap.appendChild(this._counterEl);
    nameField.appendChild(nameWrap);
    this._nameValidEl = document.createElement('div');
    this._nameValidEl.className = 'ws-cd-error';
    this._nameValidEl.style.display = 'none';
    nameField.appendChild(this._nameValidEl);
    body.appendChild(nameField);

    // Description field
    var descField = document.createElement('div');
    descField.className = 'ws-cd-field';
    var descLabel = document.createElement('div');
    descLabel.className = 'ws-cd-label';
    descLabel.innerHTML = 'DESCRIPTION <span class="ws-cd-label-opt">(optional)</span>';
    descField.appendChild(descLabel);
    this._descInput = document.createElement('textarea');
    this._descInput.className = 'ws-cd-textarea';
    this._descInput.placeholder = 'What is this lakehouse for?';
    this._descInput.maxLength = 256;
    this._descCounterEl = document.createElement('div');
    this._descCounterEl.className = 'ws-cd-counter';
    this._descCounterEl.style.position = 'static';
    this._descCounterEl.style.textAlign = 'right';
    this._descCounterEl.style.marginTop = '2px';
    this._descCounterEl.textContent = '0 / 256';
    this._descInput.addEventListener('input', function() {
      self._descCounterEl.textContent = self._descInput.value.length + ' / 256';
    });
    descField.appendChild(this._descInput);
    descField.appendChild(this._descCounterEl);
    body.appendChild(descField);

    // Enable Schemas toggle
    var schemaField = document.createElement('div');
    schemaField.className = 'ws-cd-field';
    var toggleRow = document.createElement('div');
    toggleRow.className = 'ws-cd-toggle-row';
    var schemaLabel = document.createElement('div');
    schemaLabel.className = 'ws-cd-label';
    schemaLabel.style.marginBottom = '0';
    schemaLabel.textContent = 'ENABLE SCHEMAS';
    toggleRow.appendChild(schemaLabel);
    this._toggleEl = document.createElement('button');
    this._toggleEl.className = 'ws-cd-toggle on';
    this._toggleEl.setAttribute('role', 'switch');
    this._toggleEl.setAttribute('aria-checked', 'true');
    this._toggleEl.addEventListener('click', function() { self._toggleSchemas(); });
    toggleRow.appendChild(this._toggleEl);
    schemaField.appendChild(toggleRow);
    var hint = document.createElement('div');
    hint.className = 'ws-cd-toggle-hint';
    hint.textContent = 'Enables multi-schema support (dbo, bronze, silver, gold). Required for FLT.';
    schemaField.appendChild(hint);

    // Schema pills
    this._schemasEl = document.createElement('div');
    this._schemasEl.className = 'ws-cd-schemas expanded';
    var SCHEMAS = [
      { id: 'dbo', label: 'dbo', color: 'var(--accent, #6d5cff)', locked: true },
      { id: 'bronze', label: 'bronze', color: '#cd7f32' },
      { id: 'silver', label: 'silver', color: '#a0a0a0' },
      { id: 'gold', label: 'gold', color: '#d4a017' }
    ];
    for (var i = 0; i < SCHEMAS.length; i++) {
      var s = SCHEMAS[i];
      var pill = document.createElement('div');
      pill.className = 'ws-cd-pill' + (s.locked ? ' locked selected' : '');
      pill.dataset.schema = s.id;
      var dot = document.createElement('span');
      dot.className = 'ws-cd-pill-dot';
      dot.style.background = s.color;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(s.label));
      if (s.locked) {
        var lock = document.createElement('span');
        lock.textContent = '\uD83D\uDD12';
        lock.style.fontSize = '10px';
        pill.appendChild(lock);
      }
      if (!s.locked) {
        pill.addEventListener('click', (function(schema, el) {
          return function() {
            self._selectedSchemas[schema] = !self._selectedSchemas[schema];
            el.classList.toggle('selected', self._selectedSchemas[schema]);
          };
        })(s.id, pill));
      }
      this._schemasEl.appendChild(pill);
    }
    schemaField.appendChild(this._schemasEl);
    body.appendChild(schemaField);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._createBtn = document.createElement('button');
    this._createBtn.className = 'ws-cd-btn ws-cd-btn-primary';
    this._createBtn.textContent = 'Create Lakehouse';
    this._createBtn.disabled = true;
    this._createBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._createBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _toggleSchemas() {
    this._schemasEnabled = !this._schemasEnabled;
    this._toggleEl.classList.toggle('on', this._schemasEnabled);
    this._toggleEl.setAttribute('aria-checked', String(this._schemasEnabled));
    this._schemasEl.classList.toggle('expanded', this._schemasEnabled);
    this._schemasEl.classList.toggle('collapsed', !this._schemasEnabled);
  }

  _validateName() {
    var name = this._nameInput.value;
    this._counterEl.textContent = name.length + ' / ' + WsCreateValidation.NAME_MAX;
    var result = WsCreateValidation.validateLakehouseName(name, this._existingItemNames);

    this._nameInput.classList.remove('valid', 'invalid');
    this._nameValidEl.style.display = 'none';
    var existing = this._nameInput.parentNode.querySelector('.ws-cd-check');
    if (existing) existing.remove();

    if (!name.trim()) {
      this._counterEl.style.display = '';
    } else if (result.valid) {
      this._nameInput.classList.add('valid');
      this._counterEl.style.display = 'none';
      var check = document.createElement('span');
      check.className = 'ws-cd-check';
      check.textContent = '\u2713';
      this._nameInput.parentNode.appendChild(check);
    } else {
      this._nameInput.classList.add('invalid');
      this._nameValidEl.textContent = result.error;
      this._nameValidEl.style.display = '';
    }

    this._updateCreateBtn();
  }

  _updateCreateBtn() {
    var nameValid = WsCreateValidation.validateLakehouseName(this._nameInput.value, this._existingItemNames).valid;
    var ready = nameValid && this._state === 'idle';
    this._createBtn.disabled = !ready;
    if (ready) {
      this._createBtn.classList.add('ready');
    } else {
      this._createBtn.classList.remove('ready');
    }
  }

  _submit() {
    if (this._state !== 'idle') return;
    var nameResult = WsCreateValidation.validateLakehouseName(this._nameInput.value, this._existingItemNames);
    if (!nameResult.valid) {
      this._nameInput.classList.add('invalid');
      return;
    }

    var self = this;
    var name = this._nameInput.value.trim();
    var description = this._descInput.value.trim();
    var schemas = [];
    if (this._schemasEnabled) {
      var keys = Object.keys(this._selectedSchemas);
      for (var i = 0; i < keys.length; i++) {
        if (this._selectedSchemas[keys[i]]) schemas.push(keys[i]);
      }
    }

    this._state = 'creating';
    this._createBtn.disabled = true;
    this._createBtn.classList.remove('ready');
    this._createBtn.innerHTML = '<span class="ws-cd-spinner"></span>Creating\u2026';
    this._nameInput.disabled = true;
    this._descInput.disabled = true;
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';

    this._api.createLakehouse(this._workspaceId, name, {
      description: description || undefined,
      enableSchemas: this._schemasEnabled,
      defaultSchemas: this._schemasEnabled ? schemas : undefined
    }).then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(name, result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Create failed');
    });
  }

  _showSuccess(name, result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-success-name">' + this._esc(name) + '</div>' +
        '<div class="ws-cd-success-sub">Lakehouse created in ' + this._esc(this._workspaceName) + '</div>' +
        '<button class="ws-cd-btn ws-cd-btn-primary">Select Lakehouse</button>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    body.querySelector('.ws-cd-btn-primary').addEventListener('click', function() {
      self._finish(result);
    });
    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(result);
    }, 3000);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundEsc);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._nameInput.disabled = false;
    this._descInput.disabled = false;
    this._createBtn.innerHTML = 'Create Lakehouse';
    this._createBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `python scripts/build-html.py`
Expected: Builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(workspace): add LakehouseCreateDialog class

Modal with name, description, enable-schemas toggle, medallion
schema pills (dbo/bronze/silver/gold), progress, success/error.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Update API Client — createLakehouse with Schema Options

**Files:**
- Modify: `src/frontend/js/api-client.js:326-333`

- [ ] **Step 1: Update createLakehouse signature**

Replace lines 326-333 in `api-client.js`:

```javascript
  /**
   * Create a new lakehouse inside a workspace.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} name - Display name for the new lakehouse.
   * @param {object} [options] - Optional creation options.
   * @param {string} [options.description] - Lakehouse description.
   * @param {boolean} [options.enableSchemas] - Enable multi-schema support.
   * @param {string[]} [options.defaultSchemas] - Default schemas to create.
   */
  async createLakehouse(workspaceId, name, options) {
    var body = { displayName: name };
    var opts = options || {};
    if (opts.description) body.description = opts.description;
    if (opts.enableSchemas !== undefined || opts.defaultSchemas) {
      body.creationPayload = {};
      if (opts.enableSchemas !== undefined) body.creationPayload.enableSchemas = opts.enableSchemas;
      if (opts.defaultSchemas) body.creationPayload.defaultSchemas = opts.defaultSchemas;
    }
    return this._fabricPost('/workspaces/' + workspaceId + '/lakehouses', body);
  }
```

- [ ] **Step 2: Build to verify**

Run: `python scripts/build-html.py`
Expected: Builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/api-client.js
git commit -m "feat(api): extend createLakehouse with description and schema options

Adds optional description, enableSchemas, and defaultSchemas to the
lakehouse creation payload. Backwards compatible — existing callers
still work with (workspaceId, name) only.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Rewire WorkspaceExplorer to Use New Dialogs

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js:506-691` (replace old inline form methods)
- Modify: `src/frontend/js/workspace-explorer.js:694-798` (replace old lakehouse inline form)

- [ ] **Step 1: Replace `_showCreateWorkspaceInput` (lines 559-647)**

Replace the entire `_showCreateWorkspaceInput` method with:

```javascript
  /** Open modal dialog for creating a new workspace. */
  _showCreateWorkspaceInput() {
    var self = this;
    var hasAuth = this._api.hasBearerToken();
    var dialog = new WorkspaceCreateDialog(this._api, {
      existingWorkspaces: this._workspaces
    });
    dialog.onComplete = function(result) {
      self.loadWorkspaces().then(function() {
        if (result && result.id) {
          self._expanded.add(result.id);
          self._renderTree();
        }
      });
    };
    dialog.open();
    if (!hasAuth) dialog._showNoAuth();
  }
```

- [ ] **Step 2: Remove old `_loadCapacityOptions` (lines 650-675) and `_createWorkspaceWithCapacity` (lines 678-691)**

Delete both methods entirely — the dialog handles everything internally.

- [ ] **Step 3: Replace `_ctxCreateLakehouse` (lines 694-798)**

Replace the entire method with:

```javascript
  /** Context menu action: create lakehouse inside selected workspace. */
  async _ctxCreateLakehouse() {
    var t = this._ctxTarget;
    if (!t || !t.isWorkspace) return;
    var ws = t.workspace;

    // Get existing items for duplicate name detection
    var children = this._children[ws.id] || [];
    var self = this;

    var dialog = new LakehouseCreateDialog(this._api, {
      workspaceId: ws.id,
      workspaceName: ws.displayName,
      existingItems: children
    });
    dialog.onComplete = function() {
      // Refresh workspace children
      delete self._children[ws.id];
      self._expanded.add(ws.id);
      self.loadWorkspaces().then(function() {
        self._renderTree();
      });
    };
    dialog.open();
  }
```

- [ ] **Step 4: Build and verify**

Run: `python scripts/build-html.py`
Expected: Builds successfully.

- [ ] **Step 5: Run full test + lint pipeline**

Run: `make lint && make test && make build`
Expected: All pass (the skipped `test_token_helper_silent_cba` is a pre-existing env issue).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(workspace): rewire explorer to use modal create dialogs

Replace inline forms with WorkspaceCreateDialog and
LakehouseCreateDialog. Remove _loadCapacityOptions,
_createWorkspaceWithCapacity, and old inline _ctxCreateLakehouse.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Clean Up Old CSS

**Files:**
- Modify: `src/frontend/css/workspace.css:1991-2031`

- [ ] **Step 1: Remove old `.ws-create-form` styles**

Delete lines 1990-2031 (`/* Capacity picker in workspace creation */` through `.ws-create-hint`). These are superseded by `.ws-cd-*` styles.

Keep `.ws-create-row` (line 1297) and `.ws-create-input` (line 1304) — they're still used by the notebook inline creation which isn't being changed.

- [ ] **Step 2: Build and verify**

Run: `make build`
Expected: Builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/css/workspace.css
git commit -m "chore(workspace): remove superseded .ws-create-form CSS

Old capacity picker styles replaced by .ws-cd-* dialog system.
Inline .ws-create-row/.ws-create-input kept for notebook creation.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full quality pipeline**

Run: `make lint && make test && make build`
Expected: All pass.

- [ ] **Step 2: Manual smoke test**

Open `src/edog-logs.html` in browser (or start dev server). Verify:
1. Click `+` in workspace header → workspace create dialog opens
2. Type name → validation works (too short, bad chars, valid)
3. Capacity cards load (or shimmer → error in disconnected mode)
4. Create button enables when valid
5. Right-click workspace → Create Lakehouse → lakehouse dialog opens
6. Parent workspace shown as chip
7. Schema toggle works, pills toggle
8. Escape closes with dirty-form confirmation

- [ ] **Step 3: Final commit if any fixes needed, then push**

```bash
git push
```
