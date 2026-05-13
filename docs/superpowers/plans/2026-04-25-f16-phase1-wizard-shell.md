# F16 Phase 1: Wizard Shell + Config Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Infra Wizard modal dialog (C01), Infrastructure Setup page (C02), and Theme/Schema page (C03) — the complete wizard shell with first two interactive pages, navigation, and validation.

**Architecture:** Single-file JS module (`infra-wizard.js`) containing `InfraWizardDialog`, `InfraSetupPage`, and `ThemeSchemaPage` classes. Single CSS file (`infra-wizard.css`) with `.iw-` prefix for all selectors. The wizard is a singleton modal appended to `document.body` with overlay, stepper, page container, and footer. Pages follow the `activate/deactivate/validate/collectState/destroy` lifecycle protocol. Phase 1 stubs Pages 3-5 as empty containers for future phases.

**Tech Stack:** Vanilla JS (class-based), CSS custom properties from EDOG design system (`variables.css`), Fabric REST API via existing `FabricApiClient`.

**JS Convention:** Use `var` everywhere, `function(){}` not arrows, string concatenation not template literals, NO optional chaining, NO `const`/`let`, NO emoji. Unicode symbols only (● ▸ ◆ ✕ ⋯).

**Reference mockup:** `docs/specs/features/F16-environment-wizard/mocks/infra-wizard.html` — this is the pixel-perfect visual contract.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/frontend/css/infra-wizard.css` | **Create** (~600 lines) | All wizard CSS: overlay, dialog, stepper, footer, form elements, theme cards, schema chips, animations |
| `src/frontend/js/infra-wizard.js` | **Create** (~1400 lines) | `InfraWizardDialog` + `InfraSetupPage` + `ThemeSchemaPage` classes, name generator, theme data |
| `scripts/build-html.py` | **Modify** (2 lines) | Register new CSS + JS files |
| `src/frontend/js/workspace-explorer.js` | **Modify** (~5 lines) | Add "New Infrastructure" context menu item |
| `src/frontend/js/main.js` | **Modify** (~3 lines) | Wire wizard singleton to global scope |
| `tests/test_build.py` | **Verify only** | Ensure existing 103 tests still pass |

---

## Task 1: CSS — Infra Wizard Styles

**Files:**
- Create: `src/frontend/css/infra-wizard.css`

This task creates all CSS for the wizard shell, form elements, theme cards, and schema chips. Every selector uses the `.iw-` prefix. All values reference design system tokens from `variables.css` where they exist, and define wizard-specific custom properties where needed.

- [ ] **Step 1: Create `src/frontend/css/infra-wizard.css`**

Create the file with the following complete content. The CSS is organized into sections matching the mockup at `docs/specs/features/F16-environment-wizard/mocks/infra-wizard.html` (lines 92-468 for reference).

```css
/* ═══════════════════════════════════════════════════════════════════
   F16 — Infra Wizard Dialog
   CSS prefix: .iw-
   Reference: docs/specs/features/F16-environment-wizard/mocks/infra-wizard.html
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Keyframes ─── */
@keyframes iw-overlay-in {
  from { backdrop-filter: blur(0px); background: rgba(0,0,0,0); }
  to   { backdrop-filter: blur(8px); background: rgba(0,0,0,0.18); }
}
@keyframes iw-overlay-out {
  from { backdrop-filter: blur(8px); background: rgba(0,0,0,0.18); }
  to   { backdrop-filter: blur(0px); background: rgba(0,0,0,0); }
}
@keyframes iw-dialog-in {
  from { opacity: 0; transform: scale(0.94) translateY(16px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes iw-dialog-out {
  from { opacity: 1; transform: scale(1) translateY(0); }
  to   { opacity: 0; transform: scale(0.94) translateY(16px); }
}
@keyframes iw-check-pop {
  0%   { transform: scale(0); }
  60%  { transform: scale(1.2); }
  100% { transform: scale(1); }
}
@keyframes iw-pulse-accent {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow, rgba(109,92,255,0.15)); }
  50%      { box-shadow: 0 0 0 6px transparent; }
}
@keyframes iw-slide-left {
  from { opacity: 0; transform: translateX(60px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes iw-slide-right {
  from { opacity: 0; transform: translateX(-60px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes iw-card-stagger {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes iw-spin {
  to { transform: translateY(-50%) rotate(360deg); }
}

/* ─── Overlay ─── */
.iw-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  background: rgba(0,0,0,0.18);
  animation: iw-overlay-in 400ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1)) both;
}
.iw-overlay.closing {
  animation: iw-overlay-out 300ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1)) both;
}

/* ─── Dialog ─── */
.iw-dialog {
  width: min(920px, 88vw);
  height: min(680px, 88vh);
  min-width: 640px;
  min-height: 480px;
  background: var(--surface, #ffffff);
  border-radius: var(--r-xl, 14px);
  box-shadow: 0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: iw-dialog-in 450ms var(--spring, cubic-bezier(0.34, 1.56, 0.64, 1)) both;
  border: 1px solid var(--border, rgba(0,0,0,0.06));
  position: absolute;
  z-index: 9001;
}
.iw-dialog.closing {
  animation: iw-dialog-out 300ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1)) both;
}
.iw-dialog.dragging {
  transition: none !important;
  user-select: none;
}

/* ─── Header / Title Bar ─── */
.iw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4, 16px) var(--sp-6, 24px);
  border-bottom: 1px solid var(--border, rgba(0,0,0,0.06));
  background: var(--surface, #ffffff);
  flex-shrink: 0;
  min-height: 56px;
  cursor: default;
  user-select: none;
  position: relative;
}
.iw-drag-hint {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3, #ebedf0);
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
}
.iw-title {
  font-size: var(--text-lg, 15px);
  font-weight: 700;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: var(--sp-2, 8px);
}
.iw-title svg {
  width: 18px;
  height: 18px;
  color: var(--accent, #6d5cff);
  flex-shrink: 0;
}
.iw-close-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--r-md, 6px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #8e95a5);
  font-size: 16px;
  cursor: pointer;
  border: none;
  background: none;
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.iw-close-btn:hover {
  background: var(--surface-3, #ebedf0);
  color: var(--text, #1a1d23);
}

/* ─── Stepper ─── */
.iw-stepper {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5, 20px) var(--sp-8, 32px);
  gap: 0;
  background: var(--surface, #ffffff);
  border-bottom: 1px solid var(--border, rgba(0,0,0,0.06));
  flex-shrink: 0;
}
.iw-step-group {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.iw-step-item {
  display: flex;
  align-items: center;
  gap: 0;
  cursor: default;
}
.iw-step-circle {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm, 12px);
  font-weight: 600;
  border: 2px solid var(--surface-3, #ebedf0);
  color: var(--text-muted, #8e95a5);
  background: var(--surface, #ffffff);
  transition: all 300ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  position: relative;
  flex-shrink: 0;
}
.iw-step-circle .iw-step-check { display: none; }
.iw-step-item.completed .iw-step-circle {
  border-color: var(--status-ok, #18a058);
  background: var(--status-ok, #18a058);
  color: white;
  cursor: pointer;
}
.iw-step-item.completed .iw-step-circle:hover {
  transform: scale(1.1);
}
.iw-step-item.completed .iw-step-circle .iw-step-num { display: none; }
.iw-step-item.completed .iw-step-circle .iw-step-check {
  display: block;
  animation: iw-check-pop 300ms var(--spring, cubic-bezier(0.34, 1.56, 0.64, 1)) both;
}
.iw-step-item.active .iw-step-circle {
  border-color: var(--accent, #6d5cff);
  color: var(--accent, #6d5cff);
  background: var(--accent-dim, rgba(109,92,255,0.07));
  animation: iw-pulse-accent 2s ease-in-out infinite;
}
.iw-step-label {
  font-size: var(--text-xs, 10px);
  color: var(--text-muted, #8e95a5);
  margin-top: 4px;
  text-align: center;
  font-weight: 500;
  letter-spacing: 0.02em;
  transition: color 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.iw-step-item.active ~ .iw-step-label,
.iw-step-group:has(.iw-step-item.active) .iw-step-label {
  color: var(--accent, #6d5cff);
  font-weight: 600;
}
.iw-step-group:has(.iw-step-item.completed) .iw-step-label {
  color: var(--status-ok, #18a058);
}
.iw-step-connector {
  width: 56px;
  height: 2px;
  background: var(--surface-3, #ebedf0);
  margin: 0 var(--sp-1, 4px);
  position: relative;
  overflow: hidden;
  border-radius: 1px;
  flex-shrink: 0;
}
.iw-step-connector .iw-conn-fill {
  position: absolute;
  inset: 0;
  background: var(--status-ok, #18a058);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 500ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.iw-step-connector.filled .iw-conn-fill {
  transform: scaleX(1);
}

/* ─── Page Container ─── */
.iw-page-container {
  flex: 1;
  overflow: hidden;
  position: relative;
}
.iw-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1)),
              transform 360ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  transform: translateX(60px);
  overflow-y: auto;
}
.iw-page.active {
  opacity: 1;
  pointer-events: all;
  transform: translateX(0);
}
.iw-page.exit-left {
  transform: translateX(-60px);
  opacity: 0;
}
.iw-page-content {
  flex: 1;
  padding: var(--sp-6, 24px) var(--sp-8, 32px);
}

/* ─── Footer ─── */
.iw-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4, 16px) var(--sp-6, 24px);
  border-top: 1px solid var(--border, rgba(0,0,0,0.06));
  background: var(--surface, #ffffff);
  flex-shrink: 0;
}
.iw-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2, 8px);
  padding: var(--sp-2, 8px) var(--sp-4, 16px);
  border-radius: var(--r-md, 6px);
  font-size: var(--text-md, 13px);
  font-weight: 600;
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  white-space: nowrap;
  cursor: pointer;
  border: none;
  background: none;
  font-family: inherit;
  color: inherit;
}
.iw-btn-primary {
  background: var(--accent, #6d5cff);
  color: white;
  padding: var(--sp-2, 8px) var(--sp-5, 20px);
  box-shadow: 0 1px 3px rgba(109,92,255,0.2);
}
.iw-btn-primary:hover {
  background: #5e4de6;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(109,92,255,0.3);
}
.iw-btn-primary:active { transform: translateY(0); }
.iw-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}
.iw-btn-ghost {
  color: var(--text-dim, #5a6070);
  border: 1px solid var(--border-bright, rgba(0,0,0,0.12));
}
.iw-btn-ghost:hover {
  background: var(--surface-2, #f8f9fb);
  color: var(--text, #1a1d23);
  border-color: rgba(0,0,0,0.18);
}
.iw-btn-create {
  background: var(--accent, #6d5cff);
  color: white;
  padding: var(--sp-3, 12px) var(--sp-6, 24px);
  font-size: var(--text-md, 13px);
  font-weight: 700;
  border-radius: var(--r-md, 6px);
  box-shadow: 0 2px 8px rgba(109,92,255,0.25);
}
.iw-btn-create:hover {
  background: #5e4de6;
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(109,92,255,0.35);
}
.iw-btn-create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

/* ─── Form Elements ─── */
.iw-form-group { margin-bottom: var(--sp-5, 20px); }
.iw-form-label {
  display: block;
  font-size: var(--text-xs, 10px);
  font-weight: 700;
  color: var(--text-muted, #8e95a5);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: var(--sp-2, 8px);
}
.iw-form-input {
  width: 100%;
  height: 40px;
  padding: 0 var(--sp-3, 12px);
  background: var(--surface-2, #f8f9fb);
  border: 1px solid var(--border-bright, rgba(0,0,0,0.12));
  border-radius: var(--r-md, 6px);
  font-size: var(--text-md, 13px);
  color: var(--text, #1a1d23);
  font-family: inherit;
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  outline: none;
}
.iw-form-input:focus {
  border-color: var(--accent, #6d5cff);
  box-shadow: 0 0 0 3px var(--accent-glow, rgba(109,92,255,0.15));
}
.iw-form-input::placeholder { color: var(--text-muted, #8e95a5); }
.iw-form-input.mono {
  font-family: var(--mono, 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace);
  font-size: var(--text-sm, 12px);
}
.iw-form-input.error {
  border-color: var(--status-fail, #e5453b);
  box-shadow: 0 0 0 3px var(--status-fail-dim, rgba(229,69,59,0.08));
}
.iw-form-input.valid {
  border-color: var(--status-ok, #18a058);
}
.iw-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}
.iw-input-wrapper .iw-form-input { padding-right: 36px; }
.iw-input-icon {
  position: absolute;
  right: var(--sp-2, 8px);
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #8e95a5);
  font-size: 14px;
  cursor: pointer;
  border: none;
  background: none;
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.iw-input-icon:hover {
  background: var(--surface-3, #ebedf0);
  color: var(--accent, #6d5cff);
}
.iw-input-icon.valid {
  color: var(--status-ok, #18a058);
  cursor: default;
}
.iw-input-icon.valid:hover { background: none; }
.iw-form-hint {
  font-size: var(--text-xs, 10px);
  color: var(--text-muted, #8e95a5);
  margin-top: var(--sp-1, 4px);
  display: flex;
  align-items: center;
  gap: var(--sp-1, 4px);
}
.iw-form-hint .iw-dot { color: var(--status-ok, #18a058); }
.iw-form-error {
  font-size: var(--text-xs, 10px);
  color: var(--status-fail, #e5453b);
  margin-top: var(--sp-1, 4px);
  display: none;
}
.iw-form-error.show { display: block; }
.iw-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-5, 20px);
}

/* Select / Dropdown */
.iw-select-wrapper { position: relative; }
.iw-form-select {
  width: 100%;
  height: 40px;
  padding: 0 var(--sp-3, 12px);
  background: var(--surface-2, #f8f9fb);
  border: 1px solid var(--border-bright, rgba(0,0,0,0.12));
  border-radius: var(--r-md, 6px);
  font-size: var(--text-md, 13px);
  color: var(--text, #1a1d23);
  appearance: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  outline: none;
}
.iw-form-select:focus {
  border-color: var(--accent, #6d5cff);
  box-shadow: 0 0 0 3px var(--accent-glow, rgba(109,92,255,0.15));
}
.iw-form-select.error {
  border-color: var(--status-fail, #e5453b);
}
.iw-select-arrow {
  position: absolute;
  right: var(--sp-3, 12px);
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted, #8e95a5);
  pointer-events: none;
  font-size: 11px;
}
.iw-coming-soon-link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2, 8px);
  font-size: var(--text-xs, 10px);
  color: var(--text-muted, #8e95a5);
  margin-top: var(--sp-2, 8px);
}
.iw-coming-soon-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: var(--r-full, 100px);
  background: var(--surface-3, #ebedf0);
  color: var(--text-muted, #8e95a5);
  letter-spacing: 0.06em;
}

/* ─── Theme Cards (Page 2) ─── */
.iw-theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-3, 12px);
}
.iw-theme-card {
  padding: var(--sp-4, 16px);
  border-radius: var(--r-lg, 10px);
  border: 2px solid var(--border-bright, rgba(0,0,0,0.12));
  background: var(--surface, #ffffff);
  cursor: pointer;
  transition: all 200ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  position: relative;
  overflow: hidden;
}
.iw-theme-card:hover {
  border-color: rgba(109,92,255,0.3);
  background: var(--accent-hover, rgba(109,92,255,0.04));
  transform: translateY(-2px);
  box-shadow: var(--shadow-md, 0 2px 8px rgba(0,0,0,0.06));
}
.iw-theme-card.selected {
  border-color: var(--accent, #6d5cff);
  background: var(--accent-dim, rgba(109,92,255,0.07));
  box-shadow: 0 0 0 3px var(--accent-glow, rgba(109,92,255,0.15));
}
.iw-theme-card.selected::after {
  content: '\2713';
  position: absolute;
  top: var(--sp-2, 8px);
  right: var(--sp-2, 8px);
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent, #6d5cff);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 11px;
  font-weight: 700;
}
.iw-theme-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--r-md, 6px);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  margin-bottom: var(--sp-2, 8px);
  background: var(--surface-2, #f8f9fb);
  color: var(--accent, #6d5cff);
}
.iw-theme-icon svg {
  width: 18px;
  height: 18px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.iw-theme-name {
  font-size: var(--text-md, 13px);
  font-weight: 600;
  margin-bottom: var(--sp-1, 4px);
}
.iw-theme-tables {
  font-family: var(--mono, 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace);
  font-size: var(--text-xs, 10px);
  color: var(--text-muted, #8e95a5);
  line-height: 1.6;
}

/* ─── Schema Section (Page 2) ─── */
.iw-schema-section { margin-top: var(--sp-6, 24px); }
.iw-schema-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3, 12px);
  margin-bottom: var(--sp-3, 12px);
}
.iw-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1, 4px);
  padding: var(--sp-1, 4px) var(--sp-3, 12px);
  border-radius: var(--r-full, 100px);
  font-size: var(--text-xs, 10px);
  font-weight: 600;
  font-family: var(--mono, 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace);
  letter-spacing: 0.02em;
}
.iw-chip-dbo {
  background: var(--dbo-dim, rgba(90,96,112,0.08));
  color: var(--dbo, #5a6070);
}
.iw-toggle-track {
  width: 38px;
  height: 22px;
  border-radius: 11px;
  background: var(--surface-3, #ebedf0);
  cursor: pointer;
  position: relative;
  transition: background 200ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  flex-shrink: 0;
  border: none;
}
.iw-toggle-track.on { background: var(--accent, #6d5cff); }
.iw-toggle-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  position: absolute;
  top: 2px;
  left: 2px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  transition: transform 200ms var(--spring, cubic-bezier(0.34, 1.56, 0.64, 1));
  pointer-events: none;
}
.iw-toggle-track.on .iw-toggle-thumb {
  transform: translateX(16px);
}
.iw-toggle-label {
  font-size: var(--text-sm, 12px);
  color: var(--text-dim, #5a6070);
  font-weight: 500;
}
.iw-medallion-chips {
  display: flex;
  gap: var(--sp-2, 8px);
  margin-top: var(--sp-3, 12px);
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition: all 300ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.iw-medallion-chips.show {
  max-height: 50px;
  opacity: 1;
}
.iw-medallion-chip {
  padding: var(--sp-2, 8px) var(--sp-3, 12px);
  border-radius: var(--r-md, 6px);
  font-size: var(--text-sm, 12px);
  font-weight: 500;
  cursor: pointer;
  border: 1.5px solid var(--border-bright, rgba(0,0,0,0.12));
  background: var(--surface, #ffffff);
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  display: flex;
  align-items: center;
  gap: var(--sp-2, 8px);
}
.iw-medallion-chip:hover { border-color: rgba(0,0,0,0.2); }
.iw-medallion-chip.active { border-color: currentColor; }
.iw-medallion-chip[data-schema="bronze"] { color: var(--bronze, #b87333); }
.iw-medallion-chip[data-schema="bronze"].active {
  background: var(--bronze-dim, rgba(184,115,51,0.08));
  border-color: var(--bronze, #b87333);
}
.iw-medallion-chip[data-schema="silver"] { color: var(--silver, #7b8794); }
.iw-medallion-chip[data-schema="silver"].active {
  background: var(--silver-dim, rgba(123,135,148,0.08));
  border-color: var(--silver, #7b8794);
}
.iw-medallion-chip[data-schema="gold"] { color: var(--gold, #c5a038); }
.iw-medallion-chip[data-schema="gold"].active {
  background: var(--gold-dim, rgba(197,160,56,0.08));
  border-color: var(--gold, #c5a038);
}
.iw-medallion-check {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  border: 1.5px solid currentColor;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  transition: all 80ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.iw-medallion-chip.active .iw-medallion-check {
  background: currentColor;
  color: white;
}

/* ─── Stub Pages (3-5) ─── */
.iw-stub-page {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted, #8e95a5);
  font-size: var(--text-sm, 12px);
}

/* ─── Close Confirmation ─── */
.iw-confirm-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: rgba(0,0,0,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-xl, 14px);
}
.iw-confirm-box {
  background: var(--surface, #ffffff);
  border-radius: var(--r-lg, 10px);
  padding: var(--sp-6, 24px);
  box-shadow: var(--shadow-lg, 0 4px 16px rgba(0,0,0,0.08));
  max-width: 360px;
  text-align: center;
}
.iw-confirm-title {
  font-size: var(--text-lg, 15px);
  font-weight: 700;
  margin-bottom: var(--sp-2, 8px);
}
.iw-confirm-text {
  font-size: var(--text-md, 13px);
  color: var(--text-dim, #5a6070);
  margin-bottom: var(--sp-5, 20px);
  line-height: 1.5;
}
.iw-confirm-actions {
  display: flex;
  gap: var(--sp-3, 12px);
  justify-content: center;
}
.iw-btn-danger {
  background: var(--status-fail, #e5453b);
  color: white;
  padding: var(--sp-2, 8px) var(--sp-5, 20px);
}
.iw-btn-danger:hover {
  background: #d03a31;
}

/* ─── Randomize spin animation ─── */
.iw-input-icon.spinning {
  animation: iw-spin 300ms var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}

/* ─── Capacity loading shimmer ─── */
.iw-form-select.loading {
  background: linear-gradient(90deg, var(--surface-2, #f8f9fb) 25%, var(--surface-3, #ebedf0) 50%, var(--surface-2, #f8f9fb) 75%);
  background-size: 200% 100%;
  animation: iw-shimmer 1.5s infinite;
}
@keyframes iw-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
```

- [ ] **Step 2: Register CSS in build script**

In `scripts/build-html.py`, add `"css/infra-wizard.css"` to the `CSS_FILES` list. Insert after the `"css/environment.css"` line (line 45):

Find this line:
```python
    "css/environment.css",
```
Add after it:
```python
    "css/infra-wizard.css",
```

- [ ] **Step 3: Verify build**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python scripts/build-html.py
```
Expected: Build succeeds, output to `src/edog-logs.html`.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/css/infra-wizard.css scripts/build-html.py
git commit -m "feat(F16): add Infra Wizard CSS for dialog, stepper, forms, theme cards, and schema chips"
```

---

## Task 2: JS — InfraWizardDialog Shell (Singleton, Stepper, Navigation)

**Files:**
- Create: `src/frontend/js/infra-wizard.js`
- Modify: `scripts/build-html.py` (register JS)

This task creates the core dialog class with overlay, stepper, page container, footer, drag, resize (basic), focus trap, escape handling, and close confirmation. Pages 1-2 are implemented in Tasks 3-4. Pages 3-5 are stubs.

- [ ] **Step 1: Create `src/frontend/js/infra-wizard.js` with dialog shell**

Create the file with the `InfraWizardDialog` class. This is a large file — here is the complete content for the dialog shell. The `InfraSetupPage` and `ThemeSchemaPage` classes will be appended in Tasks 3 and 4.

```javascript
/**
 * InfraWizardDialog — Modal wizard for creating Fabric infrastructure.
 *
 * 5-step wizard: Setup -> Theme -> Build -> Review -> Deploy
 * Phase 1 implements pages 1 (Setup) and 2 (Theme). Pages 3-5 are stubs.
 *
 * CSS prefix: .iw-
 * Singleton: Only one wizard can be open at a time.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   STEP DEFINITIONS
   ═══════════════════════════════════════════════════════════════════ */
var IW_STEPS = [
  { index: 0, id: 'setup',  label: 'Setup',  showBack: false, nextLabel: 'Next \u2192', nextClass: 'iw-btn-primary', showFooter: true },
  { index: 1, id: 'theme',  label: 'Theme',  showBack: true,  nextLabel: 'Next \u2192', nextClass: 'iw-btn-primary', showFooter: true },
  { index: 2, id: 'build',  label: 'Build',  showBack: true,  nextLabel: 'Next \u2192', nextClass: 'iw-btn-primary', showFooter: true },
  { index: 3, id: 'review', label: 'Review', showBack: true,  nextLabel: 'Lock In & Create \u25B6', nextClass: 'iw-btn-create', showFooter: true },
  { index: 4, id: 'deploy', label: 'Deploy', showBack: false, nextLabel: '',            nextClass: '',                showFooter: false },
];

/* ═══════════════════════════════════════════════════════════════════
   WIZARD STATE FACTORY
   ═══════════════════════════════════════════════════════════════════ */
function createWizardState() {
  return {
    workspaceName: '',
    capacityId: '',
    capacityDisplayName: '',
    lakehouseName: '',
    notebookName: '',
    lakehouseManuallyEdited: false,
    notebookManuallyEdited: false,
    theme: null,
    schemas: { dbo: true, bronze: false, silver: false, gold: false },
    nodes: [],
    connections: [],
    nextNodeId: 1,
    execution: null,
    createdAt: null,
    templateName: null,
    dirty: false
  };
}

/* ═══════════════════════════════════════════════════════════════════
   INFRA WIZARD DIALOG
   ═══════════════════════════════════════════════════════════════════ */
class InfraWizardDialog {

  /**
   * @param {FabricApiClient} apiClient
   * @param {object} [options]
   * @param {object} [options.initialState] — pre-fill (template/resume)
   * @param {number} [options.startPage] — page index (default: 0)
   * @param {Array}  [options.existingWorkspaces] — for name collision checking
   */
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._state = opts.initialState ? Object.assign(createWizardState(), opts.initialState) : createWizardState();
    this._startPage = opts.startPage || 0;
    this._existingWorkspaces = opts.existingWorkspaces || [];
    this._currentPage = this._startPage;
    this._transitioning = false;
    this._dialogState = 'closed';  // closed | open | minimized

    // DOM references
    this._overlayEl = null;
    this._dialogEl = null;
    this._stepperEl = null;
    this._pageContainerEl = null;
    this._footerEl = null;
    this._nextBtn = null;
    this._backBtn = null;

    // Page component instances
    this._pages = [null, null, null, null, null];

    // Drag state
    this._dragState = null;

    // Bound event handlers (for cleanup)
    this._boundEsc = null;
    this._boundResize = null;

    // Callbacks
    this.onComplete = null;
    this.onClose = null;
    this.onPageChange = null;
    this.onStateChange = null;
    this.onError = null;
  }

  /* ─── Singleton ─── */
  static _activeInstance = null;

  static isActive() {
    return InfraWizardDialog._activeInstance !== null;
  }

  static getActive() {
    return InfraWizardDialog._activeInstance;
  }

  /* ─── Public API ─── */

  open() {
    if (InfraWizardDialog._activeInstance) {
      InfraWizardDialog._activeInstance.restore();
      return;
    }
    if (!this._api || !this._api.hasBearerToken()) {
      if (window.edogToast) {
        window.edogToast('Authentication required \u2014 connect to Fabric first', 'error');
      }
      return;
    }
    InfraWizardDialog._activeInstance = this;
    this._state.createdAt = Date.now();
    this._createDOM();
    this._bindEvents();
    this._initializePages();
    this._goToPage(this._startPage, false);
    this._dialogState = 'open';
  }

  close() {
    if (this._dialogState === 'closed') return;
    // If executing, minimize instead
    if (this._currentPage === 4 && this._state.execution && this._state.execution.status === 'running') {
      this.minimize();
      return;
    }
    // If dirty, show confirmation
    if (this._state.dirty) {
      this._showCloseConfirmation();
      return;
    }
    this._performClose();
  }

  minimize() {
    // Phase 1 stub — will implement FloatingBadge in Phase 4
    this._dialogState = 'minimized';
    if (this._overlayEl) this._overlayEl.style.display = 'none';
    if (this._dialogEl) this._dialogEl.style.display = 'none';
  }

  restore() {
    if (this._dialogState !== 'minimized') return;
    this._dialogState = 'open';
    if (this._overlayEl) this._overlayEl.style.display = '';
    if (this._dialogEl) this._dialogEl.style.display = '';
  }

  getState() {
    return Object.assign({}, this._state);
  }

  goToPage(index) {
    this._goToPage(index, true);
  }

  destroy() {
    this._removeDOM();
    this._unbindEvents();
    this._destroyPages();
    InfraWizardDialog._activeInstance = null;
    this._dialogState = 'closed';
  }

  isOpen() {
    return this._dialogState === 'open';
  }

  isMinimized() {
    return this._dialogState === 'minimized';
  }

  isExecuting() {
    return this._state.execution && this._state.execution.status === 'running';
  }

  /* ─── DOM Creation ─── */

  _createDOM() {
    // Overlay
    var overlay = document.createElement('div');
    overlay.className = 'iw-overlay';
    overlay.id = 'iw-overlay';
    document.body.appendChild(overlay);
    this._overlayEl = overlay;

    // Dialog
    var dialog = document.createElement('div');
    dialog.className = 'iw-dialog';
    dialog.id = 'iw-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'New Infrastructure Wizard');
    dialog.tabIndex = -1;

    // Header
    var header = document.createElement('div');
    header.className = 'iw-header';
    header.innerHTML =
      '<div class="iw-drag-hint"></div>' +
      '<div class="iw-title">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' +
        '</svg>' +
        'New Infrastructure' +
      '</div>' +
      '<button class="iw-close-btn" title="Close">\u2715</button>';
    dialog.appendChild(header);
    this._headerEl = header;

    // Stepper
    var stepper = document.createElement('div');
    stepper.className = 'iw-stepper';
    stepper.id = 'iw-stepper';
    var stepperHtml = '';
    for (var s = 0; s < IW_STEPS.length; s++) {
      if (s > 0) {
        stepperHtml += '<div class="iw-step-connector" data-conn="' + (s - 1) + '"><div class="iw-conn-fill"></div></div>';
      }
      stepperHtml +=
        '<div class="iw-step-group">' +
          '<div class="iw-step-item" data-step="' + s + '">' +
            '<div class="iw-step-circle">' +
              '<span class="iw-step-num">' + (s + 1) + '</span>' +
              '<span class="iw-step-check">\u2713</span>' +
            '</div>' +
          '</div>' +
          '<div class="iw-step-label">' + IW_STEPS[s].label + '</div>' +
        '</div>';
    }
    stepper.innerHTML = stepperHtml;
    dialog.appendChild(stepper);
    this._stepperEl = stepper;

    // Page container
    var pageContainer = document.createElement('div');
    pageContainer.className = 'iw-page-container';
    pageContainer.id = 'iw-page-container';
    for (var p = 0; p < 5; p++) {
      var page = document.createElement('div');
      page.className = 'iw-page';
      page.id = 'iw-page-' + p;
      var content = document.createElement('div');
      content.className = 'iw-page-content';
      page.appendChild(content);
      pageContainer.appendChild(page);
    }
    dialog.appendChild(pageContainer);
    this._pageContainerEl = pageContainer;

    // Footer
    var footer = document.createElement('div');
    footer.className = 'iw-footer';
    footer.id = 'iw-footer';
    footer.innerHTML =
      '<button class="iw-btn iw-btn-ghost" id="iw-back-btn" style="visibility:hidden">\u2190 Back</button>' +
      '<div></div>' +
      '<button class="iw-btn iw-btn-primary" id="iw-next-btn">Next \u2192</button>';
    dialog.appendChild(footer);
    this._footerEl = footer;
    this._backBtn = footer.querySelector('#iw-back-btn');
    this._nextBtn = footer.querySelector('#iw-next-btn');

    overlay.appendChild(dialog);
    this._dialogEl = dialog;

    // Center dialog
    this._centerDialog();
  }

  _centerDialog() {
    if (!this._dialogEl) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(920, vw * 0.88);
    var h = Math.min(680, vh * 0.88);
    this._dialogEl.style.width = w + 'px';
    this._dialogEl.style.height = h + 'px';
    this._dialogEl.style.left = ((vw - w) / 2) + 'px';
    this._dialogEl.style.top = ((vh - h) / 2) + 'px';
  }

  _removeDOM() {
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
    }
    this._overlayEl = null;
    this._dialogEl = null;
    this._stepperEl = null;
    this._pageContainerEl = null;
    this._footerEl = null;
    this._nextBtn = null;
    this._backBtn = null;
    this._headerEl = null;
  }

  /* ─── Event Binding ─── */

  _bindEvents() {
    var self = this;

    // Close button
    var closeBtn = this._dialogEl.querySelector('.iw-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() { self.close(); });
    }

    // Next button
    this._nextBtn.addEventListener('click', function() { self._handleNext(); });

    // Back button
    this._backBtn.addEventListener('click', function() { self._handleBack(); });

    // Escape key
    this._boundEsc = function(e) {
      if (e.key === 'Escape' && self._dialogState === 'open') {
        self.close();
      }
    };
    document.addEventListener('keydown', this._boundEsc);

    // Ctrl+Enter shortcut
    this._dialogEl.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.key === 'Enter') {
        self._handleNext();
      }
    });

    // Window resize
    this._boundResize = function() {
      if (self._dialogState === 'open') {
        self._constrainToViewport();
      }
    };
    window.addEventListener('resize', this._boundResize);

    // Stepper click
    this._stepperEl.addEventListener('click', function(e) {
      var stepItem = e.target.closest('.iw-step-item');
      if (!stepItem) return;
      var stepIdx = parseInt(stepItem.getAttribute('data-step'), 10);
      if (isNaN(stepIdx)) return;
      // Only allow clicking completed steps to go back
      if (stepItem.classList.contains('completed') && stepIdx < self._currentPage) {
        self._goToPage(stepIdx, true);
      }
    });

    // Header drag
    this._headerEl.addEventListener('pointerdown', function(e) {
      if (e.target.closest('.iw-close-btn')) return;
      self._startDrag(e);
    });

    // Header double-click re-center
    this._headerEl.addEventListener('dblclick', function(e) {
      if (e.target.closest('.iw-close-btn')) return;
      self._centerDialog();
    });

    // Focus trap
    this._dialogEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        self._trapFocus(e);
      }
    });
  }

  _unbindEvents() {
    if (this._boundEsc) {
      document.removeEventListener('keydown', this._boundEsc);
      this._boundEsc = null;
    }
    if (this._boundResize) {
      window.removeEventListener('resize', this._boundResize);
      this._boundResize = null;
    }
  }

  /* ─── Page Initialization ─── */

  _initializePages() {
    // Page 0: Setup
    var page0Content = this._pageContainerEl.querySelector('#iw-page-0 .iw-page-content');
    var self = this;
    this._pages[0] = new InfraSetupPage({
      apiClient: this._api,
      existingWorkspaces: this._existingWorkspaces,
      containerEl: page0Content,
      onValidationChange: function(isValid) { self._onPageValidationChange(isValid); }
    });

    // Page 1: Theme & Schema
    var page1Content = this._pageContainerEl.querySelector('#iw-page-1 .iw-page-content');
    this._pages[1] = new ThemeSchemaPage({
      containerEl: page1Content,
      onValidationChange: function(isValid) { self._onPageValidationChange(isValid); }
    });

    // Pages 2-4: Stubs (Phase 2-4)
    for (var i = 2; i <= 4; i++) {
      var stubContent = this._pageContainerEl.querySelector('#iw-page-' + i + ' .iw-page-content');
      stubContent.innerHTML = '<div class="iw-stub-page">Phase ' + (i <= 2 ? '2' : i <= 3 ? '3' : '4') + ' \u2014 ' + IW_STEPS[i].label + ' (coming soon)</div>';
      this._pages[i] = {
        activate: function() {},
        deactivate: function() {},
        validate: function() { return null; },
        collectState: function() {},
        destroy: function() {},
        getElement: function() { return null; }
      };
    }
  }

  _destroyPages() {
    for (var i = 0; i < this._pages.length; i++) {
      if (this._pages[i] && this._pages[i].destroy) {
        this._pages[i].destroy();
      }
      this._pages[i] = null;
    }
  }

  /* ─── Navigation ─── */

  _goToPage(targetIndex, animate) {
    if (this._transitioning) return;
    if (targetIndex < 0 || targetIndex >= 5) return;
    if (targetIndex === this._currentPage && animate) return;

    var fromIndex = this._currentPage;
    var direction = targetIndex > fromIndex ? 'forward' : 'backward';

    // Deactivate current page
    if (this._pages[fromIndex] && this._pages[fromIndex].deactivate) {
      this._pages[fromIndex].deactivate();
    }

    // Collect state from current page before leaving
    if (this._pages[fromIndex] && this._pages[fromIndex].collectState) {
      this._pages[fromIndex].collectState(this._state);
    }

    // Update page visibility with transition
    var pages = this._pageContainerEl.querySelectorAll('.iw-page');
    var self = this;

    if (animate) {
      this._transitioning = true;

      // Exit current page
      pages[fromIndex].classList.remove('active');
      pages[fromIndex].classList.add(direction === 'forward' ? 'exit-left' : '');
      pages[fromIndex].style.transform = direction === 'forward' ? 'translateX(-60px)' : 'translateX(60px)';
      pages[fromIndex].style.opacity = '0';

      // Enter target page
      pages[targetIndex].style.transform = direction === 'forward' ? 'translateX(60px)' : 'translateX(-60px)';
      pages[targetIndex].style.opacity = '0';
      pages[targetIndex].classList.add('active');

      // Force reflow
      void pages[targetIndex].offsetHeight;

      pages[targetIndex].style.transform = '';
      pages[targetIndex].style.opacity = '';

      setTimeout(function() {
        pages[fromIndex].classList.remove('exit-left');
        pages[fromIndex].style.transform = '';
        pages[fromIndex].style.opacity = '';
        self._transitioning = false;
      }, 360);
    } else {
      for (var i = 0; i < pages.length; i++) {
        pages[i].classList.remove('active', 'exit-left');
        pages[i].style.transform = '';
        pages[i].style.opacity = '';
      }
      pages[targetIndex].classList.add('active');
    }

    this._currentPage = targetIndex;

    // Activate target page
    if (this._pages[targetIndex] && this._pages[targetIndex].activate) {
      this._pages[targetIndex].activate(this._state);
    }

    // Update stepper
    this._updateStepper();

    // Update footer
    this._updateFooter();

    // Fire callback
    if (this.onPageChange && animate) {
      this.onPageChange(fromIndex, targetIndex);
    }
  }

  _handleNext() {
    if (this._transitioning) return;
    var page = this._pages[this._currentPage];
    if (!page) return;

    // Validate current page
    var error = page.validate ? page.validate() : null;
    if (error) {
      // Validation failed — page component shows inline errors
      return;
    }

    // Collect state
    if (page.collectState) {
      page.collectState(this._state);
    }

    // Special case: Page 3 → Page 4 (Lock In & Create) needs confirmation
    if (this._currentPage === 3) {
      this._showLockInConfirmation();
      return;
    }

    // Move forward
    if (this._currentPage < 4) {
      this._goToPage(this._currentPage + 1, true);
    }
  }

  _handleBack() {
    if (this._transitioning) return;
    if (this._currentPage > 0) {
      this._goToPage(this._currentPage - 1, true);
    }
  }

  /* ─── Stepper Update ─── */

  _updateStepper() {
    var stepItems = this._stepperEl.querySelectorAll('.iw-step-item');
    var connectors = this._stepperEl.querySelectorAll('.iw-step-connector');

    for (var i = 0; i < stepItems.length; i++) {
      stepItems[i].classList.remove('active', 'completed');
      if (i < this._currentPage) {
        stepItems[i].classList.add('completed');
      } else if (i === this._currentPage) {
        stepItems[i].classList.add('active');
      }
    }

    for (var c = 0; c < connectors.length; c++) {
      if (c < this._currentPage) {
        connectors[c].classList.add('filled');
      } else {
        connectors[c].classList.remove('filled');
      }
    }
  }

  /* ─── Footer Update ─── */

  _updateFooter() {
    var step = IW_STEPS[this._currentPage];
    if (!step.showFooter) {
      this._footerEl.style.display = 'none';
      return;
    }
    this._footerEl.style.display = '';

    // Back button
    this._backBtn.style.visibility = step.showBack ? 'visible' : 'hidden';

    // Next button
    this._nextBtn.textContent = step.nextLabel;
    this._nextBtn.className = 'iw-btn ' + step.nextClass;
  }

  /* ─── Validation Callback ─── */

  _onPageValidationChange(isValid) {
    if (this._nextBtn) {
      this._nextBtn.disabled = !isValid;
    }
  }

  /* ─── Dirty Tracking ─── */

  _markDirty() {
    if (!this._state.dirty) {
      this._state.dirty = true;
      if (this.onStateChange) this.onStateChange(this._state);
    }
  }

  /* ─── Close Confirmation ─── */

  _showCloseConfirmation() {
    if (this._dialogEl.querySelector('.iw-confirm-overlay')) return;

    var self = this;
    var confirmEl = document.createElement('div');
    confirmEl.className = 'iw-confirm-overlay';
    confirmEl.innerHTML =
      '<div class="iw-confirm-box">' +
        '<div class="iw-confirm-title">Discard wizard?</div>' +
        '<div class="iw-confirm-text">All entered data will be lost. This action cannot be undone.</div>' +
        '<div class="iw-confirm-actions">' +
          '<button class="iw-btn iw-btn-ghost" id="iw-confirm-cancel">Cancel</button>' +
          '<button class="iw-btn iw-btn-danger" id="iw-confirm-discard">Discard</button>' +
        '</div>' +
      '</div>';
    this._dialogEl.appendChild(confirmEl);

    confirmEl.querySelector('#iw-confirm-cancel').addEventListener('click', function() {
      confirmEl.parentNode.removeChild(confirmEl);
    });
    confirmEl.querySelector('#iw-confirm-discard').addEventListener('click', function() {
      self._performClose();
    });
  }

  _showLockInConfirmation() {
    // Phase 4 will implement the full "Lock In & Create" flow
    // For Phase 1, just move to page 4 (stub)
    this._goToPage(4, true);
  }

  _performClose() {
    var self = this;
    // Play exit animation
    if (this._dialogEl) this._dialogEl.classList.add('closing');
    if (this._overlayEl) this._overlayEl.classList.add('closing');

    setTimeout(function() {
      self._removeDOM();
      self._unbindEvents();
      self._destroyPages();
      InfraWizardDialog._activeInstance = null;
      self._dialogState = 'closed';
      if (self.onClose) self.onClose();
    }, 300);
  }

  /* ─── Drag ─── */

  _startDrag(e) {
    if (!this._dialogEl) return;
    var rect = this._dialogEl.getBoundingClientRect();
    this._dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top
    };
    this._dialogEl.classList.add('dragging');
    this._dialogEl.style.position = 'fixed';
    this._dialogEl.style.left = rect.left + 'px';
    this._dialogEl.style.top = rect.top + 'px';

    var self = this;
    var onMove = function(ev) {
      if (!self._dragState) return;
      var dx = ev.clientX - self._dragState.startX;
      var dy = ev.clientY - self._dragState.startY;
      var newLeft = self._dragState.origLeft + dx;
      var newTop = self._dragState.origTop + dy;
      // Constrain: keep at least 48px of header visible
      newTop = Math.max(-self._dialogEl.offsetHeight + 48, newTop);
      newTop = Math.min(window.innerHeight - 48, newTop);
      newLeft = Math.max(-self._dialogEl.offsetWidth + 48, newLeft);
      newLeft = Math.min(window.innerWidth - 48, newLeft);
      self._dialogEl.style.left = newLeft + 'px';
      self._dialogEl.style.top = newTop + 'px';
    };
    var onUp = function() {
      self._dragState = null;
      self._dialogEl.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  _constrainToViewport() {
    if (!this._dialogEl) return;
    var rect = this._dialogEl.getBoundingClientRect();
    var changed = false;
    var left = rect.left;
    var top = rect.top;
    if (rect.right < 48) { left = 48 - rect.width; changed = true; }
    if (rect.left > window.innerWidth - 48) { left = window.innerWidth - 48; changed = true; }
    if (rect.bottom < 48) { top = 48 - rect.height; changed = true; }
    if (rect.top > window.innerHeight - 48) { top = window.innerHeight - 48; changed = true; }
    if (changed) {
      this._dialogEl.style.left = left + 'px';
      this._dialogEl.style.top = top + 'px';
    }
  }

  /* ─── Focus Trap ─── */

  _trapFocus(e) {
    var focusable = this._dialogEl.querySelectorAll(
      'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
```

- [ ] **Step 2: Register JS in build script**

In `scripts/build-html.py`, add `"js/infra-wizard.js"` to the `JS_MODULES` list. Insert before `"js/workspace-explorer.js"` (line 110):

Find this line:
```python
    "js/workspace-explorer.js",
```
Add before it:
```python
    "js/infra-wizard.js",
```

- [ ] **Step 3: Verify build**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python scripts/build-html.py
```
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/infra-wizard.js scripts/build-html.py
git commit -m "feat(F16): add InfraWizardDialog shell with stepper, navigation, drag, and focus trap"
```

---

## Task 3: JS — InfraSetupPage (Page 1: Workspace, Capacity, Lakehouse, Notebook)

**Files:**
- Modify: `src/frontend/js/infra-wizard.js` (append InfraSetupPage class)

This task appends the `InfraSetupPage` class to `infra-wizard.js`. It implements the 4-field form with Docker-style random name generation, auto-sync cascading, capacity dropdown from API, and Stripe-style validation.

- [ ] **Step 1: Append InfraSetupPage class to infra-wizard.js**

Add the following class at the end of `src/frontend/js/infra-wizard.js`:

```javascript

/* ═══════════════════════════════════════════════════════════════════
   NAME GENERATOR DATA — Docker-style random names
   ═══════════════════════════════════════════════════════════════════ */
var IW_ADJECTIVES = [
  'brave','calm','bold','keen','wise','fair','pure','warm','cool','kind',
  'glad','fond','mild','true','free','swift','quick','fast','brisk','agile',
  'fleet','rapid','lively','nimble','zippy','bright','sharp','clear','deep','smart',
  'lucid','astute','clever','witty','adept','tough','solid','steady','firm','stout',
  'hardy','robust','stable','deft','able','vivid','crisp','fresh','lush','sleek',
  'noble','prime','grand','neat','happy','jolly','merry','proud','eager','loyal'
];

var IW_NOUNS = [
  'turing','lovelace','hopper','dijkstra','knuth','ritchie','thompson','mccarthy','backus','liskov',
  'gosling','torvalds','pike','kernighan','stroustrup','hejlsberg','matsumoto','wozniak','cerf','berners_lee',
  'minsky','shannon','church','babbage','von_neumann','hamilton','boole','curry','haskell','erlang',
  'carmack','dean','norvig','hinton','lecun','bengio','goodfellow','sutskever','ng','pearl',
  'goldberg','lamport','wing','keller','shaw','bartik','holberton','sammet','allen','estrin',
  'moore','grove','noyce','kilby','engelbart','postel','metcalfe','baran','clark','floyd'
];

function iwGenerateRandomName() {
  var adj = IW_ADJECTIVES[Math.floor(Math.random() * IW_ADJECTIVES.length)];
  var noun = IW_NOUNS[Math.floor(Math.random() * IW_NOUNS.length)];
  var num = Math.floor(Math.random() * 90) + 10;
  return adj + '_' + noun + '_' + num;
}

function iwGenerateUniqueRandomName(existingWorkspaces) {
  var existingNames = {};
  for (var i = 0; i < existingWorkspaces.length; i++) {
    existingNames[existingWorkspaces[i].displayName.toLowerCase()] = true;
  }
  for (var attempt = 0; attempt < 5; attempt++) {
    var candidate = iwGenerateRandomName();
    if (!existingNames[candidate.toLowerCase()]) return candidate;
  }
  var base = iwGenerateRandomName();
  var suffix = Date.now().toString(36).slice(-4);
  return base + '_' + suffix;
}

/* ═══════════════════════════════════════════════════════════════════
   INFRA SETUP PAGE (Page 1)
   ═══════════════════════════════════════════════════════════════════ */
class InfraSetupPage {
  constructor(options) {
    this._api = options.apiClient;
    this._existingWorkspaces = options.existingWorkspaces || [];
    this._containerEl = options.containerEl;
    this._onValidationChange = options.onValidationChange;

    this._fields = {
      workspace: { value: '', valid: false, error: null, touched: false },
      capacity: { value: '', valid: false, error: null, touched: false },
      lakehouse: { value: '', valid: false, error: null, touched: false },
      notebook: { value: '', valid: false, error: null, touched: false }
    };
    this._lakehouseManual = false;
    this._notebookManual = false;
    this._capacities = null;
    this._capacityLoading = false;
    this._firstActivation = true;

    this._render();
    this._bindEvents();
  }

  activate(wizardState) {
    if (this._firstActivation) {
      this._firstActivation = false;
      // Generate initial random name
      var name = iwGenerateUniqueRandomName(this._existingWorkspaces);
      this._wsInput.value = name;
      this._fields.workspace.value = name;
      this._cascadeNames();
      // Load capacities
      this._loadCapacities();
    }
    // Restore state if navigating back
    if (wizardState && wizardState.workspaceName) {
      this._wsInput.value = wizardState.workspaceName;
      this._fields.workspace.value = wizardState.workspaceName;
      this._lhInput.value = wizardState.lakehouseName;
      this._fields.lakehouse.value = wizardState.lakehouseName;
      this._nbInput.value = wizardState.notebookName;
      this._fields.notebook.value = wizardState.notebookName;
      this._lakehouseManual = wizardState.lakehouseManuallyEdited || false;
      this._notebookManual = wizardState.notebookManuallyEdited || false;
      if (wizardState.capacityId && this._capSelect) {
        this._capSelect.value = wizardState.capacityId;
        this._fields.capacity.value = wizardState.capacityId;
      }
    }
    this._validateAllFields();
  }

  deactivate() {}

  validate() {
    this._validateAllFields();
    var allValid = this._fields.workspace.valid &&
                   this._fields.capacity.valid &&
                   this._fields.lakehouse.valid &&
                   this._fields.notebook.valid;
    if (!allValid) return 'Please fill in all required fields';
    return null;
  }

  collectState(state) {
    state.workspaceName = this._fields.workspace.value;
    state.capacityId = this._fields.capacity.value;
    state.capacityDisplayName = this._capSelect ? this._capSelect.options[this._capSelect.selectedIndex].text : '';
    state.lakehouseName = this._fields.lakehouse.value;
    state.notebookName = this._fields.notebook.value;
    state.lakehouseManuallyEdited = this._lakehouseManual;
    state.notebookManuallyEdited = this._notebookManual;
    state.dirty = true;
  }

  destroy() {
    this._containerEl.innerHTML = '';
  }

  getElement() {
    return this._containerEl;
  }

  randomize() {
    var name = iwGenerateUniqueRandomName(this._existingWorkspaces);
    this._wsInput.value = name;
    this._fields.workspace.value = name;
    this._lakehouseManual = false;
    this._notebookManual = false;
    this._cascadeNames();
    this._validateAllFields();
    // Spin animation on randomize button
    var btn = this._containerEl.querySelector('.iw-randomize-btn');
    if (btn) {
      btn.classList.add('spinning');
      setTimeout(function() { btn.classList.remove('spinning'); }, 300);
    }
  }

  /* ─── Render ─── */

  _render() {
    this._containerEl.innerHTML =
      '<div class="iw-form-group">' +
        '<label class="iw-form-label">Workspace Name</label>' +
        '<div class="iw-input-wrapper">' +
          '<input class="iw-form-input mono" id="iw-ws-name" spellcheck="false" placeholder="e.g. brave_turing_42">' +
          '<button class="iw-input-icon iw-randomize-btn" title="Randomize name">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="iw-form-hint"><span class="iw-dot">\u25CF</span> Unique name, underscores allowed</div>' +
        '<div class="iw-form-error" id="iw-ws-error"></div>' +
      '</div>' +

      '<div class="iw-form-group">' +
        '<label class="iw-form-label">Capacity</label>' +
        '<div class="iw-select-wrapper">' +
          '<select class="iw-form-select" id="iw-cap-select">' +
            '<option value="" disabled selected>Loading capacities\u2026</option>' +
          '</select>' +
          '<span class="iw-select-arrow">\u25BE</span>' +
        '</div>' +
        '<div class="iw-coming-soon-link">' +
          '<span>Create New Capacity</span>' +
          '<span class="iw-coming-soon-badge">Coming Soon</span>' +
        '</div>' +
        '<div class="iw-form-error" id="iw-cap-error"></div>' +
      '</div>' +

      '<div class="iw-form-row">' +
        '<div class="iw-form-group">' +
          '<label class="iw-form-label">Lakehouse Name</label>' +
          '<div class="iw-input-wrapper">' +
            '<input class="iw-form-input mono" id="iw-lh-name" spellcheck="false" placeholder="auto-generated">' +
            '<span class="iw-input-icon valid" id="iw-lh-icon" style="display:none">\u2713</span>' +
          '</div>' +
          '<div class="iw-form-hint"><span class="iw-dot">\u25CF</span> Schema-enabled (always)</div>' +
          '<div class="iw-form-error" id="iw-lh-error"></div>' +
        '</div>' +
        '<div class="iw-form-group">' +
          '<label class="iw-form-label">Notebook Name</label>' +
          '<div class="iw-input-wrapper">' +
            '<input class="iw-form-input mono" id="iw-nb-name" spellcheck="false" placeholder="auto-generated">' +
            '<span class="iw-input-icon valid" id="iw-nb-icon" style="display:none">\u2713</span>' +
          '</div>' +
          '<div class="iw-form-hint"><span class="iw-dot">\u25CF</span> Auto-generated from workspace</div>' +
          '<div class="iw-form-error" id="iw-nb-error"></div>' +
        '</div>' +
      '</div>';

    // Cache DOM refs
    this._wsInput = this._containerEl.querySelector('#iw-ws-name');
    this._capSelect = this._containerEl.querySelector('#iw-cap-select');
    this._lhInput = this._containerEl.querySelector('#iw-lh-name');
    this._nbInput = this._containerEl.querySelector('#iw-nb-name');
  }

  /* ─── Events ─── */

  _bindEvents() {
    var self = this;

    // Workspace name: sanitize + cascade
    this._wsInput.addEventListener('input', function() {
      var v = self._wsInput.value.replace(/[^a-zA-Z0-9_]/g, '');
      self._wsInput.value = v;
      self._fields.workspace.value = v;
      self._cascadeNames();
      if (self._fields.workspace.touched) self._validateField('workspace');
    });
    this._wsInput.addEventListener('blur', function() {
      self._fields.workspace.touched = true;
      self._validateField('workspace');
    });

    // Capacity select
    this._capSelect.addEventListener('change', function() {
      self._fields.capacity.value = self._capSelect.value;
      self._fields.capacity.touched = true;
      self._validateField('capacity');
    });

    // Lakehouse name: detect manual edit
    this._lhInput.addEventListener('input', function() {
      var v = self._lhInput.value.replace(/[^a-zA-Z0-9_]/g, '');
      self._lhInput.value = v;
      self._fields.lakehouse.value = v;
      self._lakehouseManual = true;
      if (self._fields.lakehouse.touched) self._validateField('lakehouse');
    });
    this._lhInput.addEventListener('blur', function() {
      self._fields.lakehouse.touched = true;
      self._validateField('lakehouse');
    });

    // Notebook name: detect manual edit
    this._nbInput.addEventListener('input', function() {
      var v = self._nbInput.value.replace(/[^a-zA-Z0-9_]/g, '');
      self._nbInput.value = v;
      self._fields.notebook.value = v;
      self._notebookManual = true;
      if (self._fields.notebook.touched) self._validateField('notebook');
    });
    this._nbInput.addEventListener('blur', function() {
      self._fields.notebook.touched = true;
      self._validateField('notebook');
    });

    // Randomize button
    var randBtn = this._containerEl.querySelector('.iw-randomize-btn');
    if (randBtn) {
      randBtn.addEventListener('click', function() { self.randomize(); });
    }
  }

  /* ─── Cascade ─── */

  _cascadeNames() {
    var base = this._fields.workspace.value;
    if (!this._lakehouseManual) {
      var lhVal = base ? base + '_lh' : '';
      this._lhInput.value = lhVal;
      this._fields.lakehouse.value = lhVal;
    }
    if (!this._notebookManual) {
      var nbVal = base ? base + '_nb' : '';
      this._nbInput.value = nbVal;
      this._fields.notebook.value = nbVal;
    }
  }

  /* ─── Validation ─── */

  _validateField(fieldName) {
    var field = this._fields[fieldName];
    var value = field.value;
    field.error = null;
    field.valid = false;

    if (fieldName === 'workspace') {
      if (!value) { field.error = 'Workspace name is required'; }
      else if (value.length < 3) { field.error = 'Must be at least 3 characters'; }
      else if (value.length > 64) { field.error = 'Must be 64 characters or fewer'; }
      else if (!/^[a-zA-Z]/.test(value)) { field.error = 'Must start with a letter'; }
      else {
        // Check collision
        var lower = value.toLowerCase();
        for (var i = 0; i < this._existingWorkspaces.length; i++) {
          if (this._existingWorkspaces[i].displayName.toLowerCase() === lower) {
            field.error = 'Workspace name already exists';
            break;
          }
        }
      }
      if (!field.error) field.valid = true;
    }

    if (fieldName === 'capacity') {
      if (!value) { field.error = 'Please select a capacity'; }
      else { field.valid = true; }
    }

    if (fieldName === 'lakehouse' || fieldName === 'notebook') {
      if (!value) { field.error = (fieldName === 'lakehouse' ? 'Lakehouse' : 'Notebook') + ' name is required'; }
      else if (value.length < 3) { field.error = 'Must be at least 3 characters'; }
      else if (value.length > 64) { field.error = 'Must be 64 characters or fewer'; }
      else if (!/^[a-zA-Z]/.test(value)) { field.error = 'Must start with a letter'; }
      else { field.valid = true; }
    }

    this._updateFieldUI(fieldName);
    this._emitValidation();
  }

  _validateAllFields() {
    this._validateField('workspace');
    this._validateField('capacity');
    this._validateField('lakehouse');
    this._validateField('notebook');
  }

  _updateFieldUI(fieldName) {
    var field = this._fields[fieldName];
    var inputEl, errorEl, iconEl;

    if (fieldName === 'workspace') {
      inputEl = this._wsInput;
      errorEl = this._containerEl.querySelector('#iw-ws-error');
    } else if (fieldName === 'capacity') {
      inputEl = this._capSelect;
      errorEl = this._containerEl.querySelector('#iw-cap-error');
    } else if (fieldName === 'lakehouse') {
      inputEl = this._lhInput;
      errorEl = this._containerEl.querySelector('#iw-lh-error');
      iconEl = this._containerEl.querySelector('#iw-lh-icon');
    } else if (fieldName === 'notebook') {
      inputEl = this._nbInput;
      errorEl = this._containerEl.querySelector('#iw-nb-error');
      iconEl = this._containerEl.querySelector('#iw-nb-icon');
    }

    if (!inputEl) return;

    inputEl.classList.remove('error', 'valid');
    if (field.touched && field.error) {
      inputEl.classList.add('error');
      if (errorEl) { errorEl.textContent = field.error; errorEl.classList.add('show'); }
      if (iconEl) iconEl.style.display = 'none';
    } else if (field.touched && field.valid) {
      inputEl.classList.add('valid');
      if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
      if (iconEl) iconEl.style.display = '';
    } else {
      if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
      if (iconEl) iconEl.style.display = 'none';
    }
  }

  _emitValidation() {
    var allValid = this._fields.workspace.valid &&
                   this._fields.capacity.valid &&
                   this._fields.lakehouse.valid &&
                   this._fields.notebook.valid;
    if (this._onValidationChange) this._onValidationChange(allValid);
  }

  /* ─── Capacity Loading ─── */

  _loadCapacities() {
    var self = this;
    this._capacityLoading = true;
    this._capSelect.classList.add('loading');

    var isMock = new URLSearchParams(window.location.search).has('mock');
    if (isMock) {
      // Mock data for development
      setTimeout(function() {
        self._capacities = [
          { id: 'f4-east',  displayName: 'F4 \u2014 East US', state: 'Active', sku: 'F4' },
          { id: 'f8-west',  displayName: 'F8 \u2014 West US 2', state: 'Active', sku: 'F8' },
          { id: 'f16-eu',   displayName: 'F16 \u2014 North Europe', state: 'Suspended', sku: 'F16' },
          { id: 'f2-sea',   displayName: 'F2 \u2014 Southeast Asia', state: 'Active', sku: 'F2' }
        ];
        self._renderCapacityOptions();
      }, 500);
      return;
    }

    this._api.listCapacities().then(function(data) {
      self._capacities = (data && data.value) || [];
      self._renderCapacityOptions();
    }).catch(function(err) {
      self._capacities = [];
      self._renderCapacityOptions();
      self._fields.capacity.error = 'Failed to load capacities: ' + err.message;
      self._updateFieldUI('capacity');
    });
  }

  _renderCapacityOptions() {
    this._capacityLoading = false;
    this._capSelect.classList.remove('loading');
    var html = '<option value="" disabled selected>Select capacity\u2026</option>';
    if (this._capacities && this._capacities.length > 0) {
      for (var i = 0; i < this._capacities.length; i++) {
        var cap = this._capacities[i];
        var stateLabel = cap.state === 'Active' ? 'Running' : cap.state === 'Suspended' ? 'Paused' : cap.state;
        html += '<option value="' + cap.id + '">' +
          (cap.sku || '') + ' \u2014 ' + cap.displayName + ' (' + stateLabel + ')' +
        '</option>';
      }
    } else {
      html = '<option value="" disabled selected>No capacities available</option>';
    }
    this._capSelect.innerHTML = html;
  }
}
```

- [ ] **Step 2: Verify build**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python scripts/build-html.py
```
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/infra-wizard.js
git commit -m "feat(F16): add InfraSetupPage with random names, auto-sync, capacity API, and validation"
```

---

## Task 4: JS — ThemeSchemaPage (Page 2: Theme Cards, Medallion Chips)

**Files:**
- Modify: `src/frontend/js/infra-wizard.js` (append ThemeSchemaPage class)

This task appends the `ThemeSchemaPage` class. It implements the 3x2 theme card grid, medallion schema toggle, and bronze/silver/gold chip selection.

- [ ] **Step 1: Append ThemeSchemaPage class to infra-wizard.js**

Add the following class at the end of `src/frontend/js/infra-wizard.js`:

```javascript

/* ═══════════════════════════════════════════════════════════════════
   THEME DEFINITIONS
   ═══════════════════════════════════════════════════════════════════ */
var IW_THEMES = [
  {
    id: 'ecommerce',
    name: 'E-Commerce',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
    tables: 'orders, customers, products, categories, reviews, inventory'
  },
  {
    id: 'sales',
    name: 'Sales Analytics',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    tables: 'opportunities, accounts, contacts, activities, pipeline, quotas'
  },
  {
    id: 'iot',
    name: 'IoT / Sensors',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    tables: 'sensors, readings, alerts, devices, maintenance, locations'
  },
  {
    id: 'hr',
    name: 'HR & People',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    tables: 'employees, departments, payroll, attendance, reviews, positions'
  },
  {
    id: 'finance',
    name: 'Finance',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    tables: 'transactions, accounts, invoices, payments, budgets, categories'
  },
  {
    id: 'healthcare',
    name: 'Healthcare',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    tables: 'patients, appointments, prescriptions, labs, providers, claims'
  }
];

/* ═══════════════════════════════════════════════════════════════════
   THEME SCHEMA PAGE (Page 2)
   ═══════════════════════════════════════════════════════════════════ */
class ThemeSchemaPage {
  constructor(options) {
    this._containerEl = options.containerEl;
    this._onValidationChange = options.onValidationChange;

    this._selectedTheme = null;
    this._medallionOn = false;
    this._schemas = { dbo: true, bronze: false, silver: false, gold: false };

    this._render();
    this._bindEvents();
  }

  activate(wizardState) {
    // Restore state if navigating back
    if (wizardState && wizardState.theme) {
      this._selectedTheme = wizardState.theme;
      this._schemas = Object.assign({ dbo: true, bronze: false, silver: false, gold: false }, wizardState.schemas);
      this._medallionOn = this._schemas.bronze || this._schemas.silver || this._schemas.gold;
      this._updateThemeUI();
      this._updateMedallionUI();
    }
    this._emitValidation();
  }

  deactivate() {}

  validate() {
    if (!this._selectedTheme) return 'Please select a data theme';
    return null;
  }

  collectState(state) {
    state.theme = this._selectedTheme;
    state.schemas = Object.assign({}, this._schemas);
    state.dirty = true;
  }

  destroy() {
    this._containerEl.innerHTML = '';
  }

  getElement() {
    return this._containerEl;
  }

  /* ─── Render ─── */

  _render() {
    var html =
      '<div class="iw-form-group">' +
        '<label class="iw-form-label">Data Theme</label>' +
        '<div class="iw-theme-grid" id="iw-theme-grid">';

    for (var i = 0; i < IW_THEMES.length; i++) {
      var t = IW_THEMES[i];
      html +=
        '<div class="iw-theme-card" data-theme="' + t.id + '">' +
          '<div class="iw-theme-icon">' + t.icon + '</div>' +
          '<div class="iw-theme-name">' + t.name + '</div>' +
          '<div class="iw-theme-tables">' + t.tables + '</div>' +
        '</div>';
    }

    html += '</div></div>';

    // Schema section
    html +=
      '<div class="iw-schema-section">' +
        '<label class="iw-form-label">Schemas</label>' +
        '<div class="iw-schema-row">' +
          '<span class="iw-chip iw-chip-dbo">\u25CF dbo</span>' +
          '<span style="font-size:10px;color:var(--text-muted,#8e95a5)">Always included</span>' +
        '</div>' +
        '<div class="iw-schema-row" style="margin-top:12px">' +
          '<button class="iw-toggle-track" id="iw-medallion-toggle">' +
            '<div class="iw-toggle-thumb"></div>' +
          '</button>' +
          '<span class="iw-toggle-label">Add medallion schemas</span>' +
        '</div>' +
        '<div class="iw-medallion-chips" id="iw-medallion-chips">' +
          '<div class="iw-medallion-chip" data-schema="bronze">' +
            '<div class="iw-medallion-check">\u2713</div>' +
            'Bronze' +
          '</div>' +
          '<div class="iw-medallion-chip" data-schema="silver">' +
            '<div class="iw-medallion-check">\u2713</div>' +
            'Silver' +
          '</div>' +
          '<div class="iw-medallion-chip" data-schema="gold">' +
            '<div class="iw-medallion-check">\u2713</div>' +
            'Gold' +
          '</div>' +
        '</div>' +
      '</div>';

    this._containerEl.innerHTML = html;
  }

  /* ─── Events ─── */

  _bindEvents() {
    var self = this;

    // Theme card clicks
    var grid = this._containerEl.querySelector('#iw-theme-grid');
    if (grid) {
      grid.addEventListener('click', function(e) {
        var card = e.target.closest('.iw-theme-card');
        if (!card) return;
        self._selectedTheme = card.getAttribute('data-theme');
        self._updateThemeUI();
        self._emitValidation();
      });
    }

    // Medallion toggle
    var toggle = this._containerEl.querySelector('#iw-medallion-toggle');
    if (toggle) {
      toggle.addEventListener('click', function() {
        self._medallionOn = !self._medallionOn;
        if (self._medallionOn) {
          // Enable all by default when toggling on
          self._schemas.bronze = true;
          self._schemas.silver = true;
          self._schemas.gold = true;
        } else {
          self._schemas.bronze = false;
          self._schemas.silver = false;
          self._schemas.gold = false;
        }
        self._updateMedallionUI();
      });
    }

    // Medallion chip clicks
    var chips = this._containerEl.querySelector('#iw-medallion-chips');
    if (chips) {
      chips.addEventListener('click', function(e) {
        var chip = e.target.closest('.iw-medallion-chip');
        if (!chip) return;
        var schema = chip.getAttribute('data-schema');
        if (!schema) return;
        self._schemas[schema] = !self._schemas[schema];
        // If all off, turn toggle off
        if (!self._schemas.bronze && !self._schemas.silver && !self._schemas.gold) {
          self._medallionOn = false;
        }
        self._updateMedallionUI();
      });
    }
  }

  /* ─── UI Updates ─── */

  _updateThemeUI() {
    var cards = this._containerEl.querySelectorAll('.iw-theme-card');
    for (var i = 0; i < cards.length; i++) {
      var isSelected = cards[i].getAttribute('data-theme') === this._selectedTheme;
      if (isSelected) {
        cards[i].classList.add('selected');
      } else {
        cards[i].classList.remove('selected');
      }
    }
  }

  _updateMedallionUI() {
    var toggle = this._containerEl.querySelector('#iw-medallion-toggle');
    var chipsContainer = this._containerEl.querySelector('#iw-medallion-chips');

    if (toggle) {
      if (this._medallionOn) {
        toggle.classList.add('on');
      } else {
        toggle.classList.remove('on');
      }
    }

    if (chipsContainer) {
      if (this._medallionOn) {
        chipsContainer.classList.add('show');
      } else {
        chipsContainer.classList.remove('show');
      }
    }

    // Update individual chips
    var chipEls = this._containerEl.querySelectorAll('.iw-medallion-chip');
    for (var i = 0; i < chipEls.length; i++) {
      var schema = chipEls[i].getAttribute('data-schema');
      if (this._schemas[schema]) {
        chipEls[i].classList.add('active');
      } else {
        chipEls[i].classList.remove('active');
      }
    }
  }

  _emitValidation() {
    var isValid = this._selectedTheme !== null;
    if (this._onValidationChange) this._onValidationChange(isValid);
  }
}
```

- [ ] **Step 2: Verify build**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python scripts/build-html.py
```
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/infra-wizard.js
git commit -m "feat(F16): add ThemeSchemaPage with 6 theme cards, medallion toggle, and schema chips"
```

---

## Task 5: Integration — Wire Wizard into Workspace Explorer + Main

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js` (~5 lines)
- Modify: `src/frontend/js/main.js` (~3 lines)

- [ ] **Step 1: Add "New Infrastructure" to workspace context menu**

In `src/frontend/js/workspace-explorer.js`, find the workspace context menu items block (around line 193-202). Find this code:

```javascript
    } else if (nodeData.isWorkspace) {
      items.push({ label: 'Create Lakehouse', action: () => this._ctxCreateLakehouse() });
      items.push({ label: 'Create Notebook', action: () => this._ctxCreateNotebook() });
```

Add after `Create Notebook`:

```javascript
      items.push({ sep: true });
      items.push({ label: 'New Infrastructure\u2026', cls: 'accent', action: () => this._ctxNewInfra() });
```

- [ ] **Step 2: Add `_ctxNewInfra()` method**

In `src/frontend/js/workspace-explorer.js`, find the `_ctxDeploy()` method (around line 248). Add the following method before it:

```javascript
  _ctxNewInfra() {
    if (InfraWizardDialog.isActive()) {
      InfraWizardDialog.getActive().restore();
      return;
    }
    var wizard = new InfraWizardDialog(this._api, {
      existingWorkspaces: this._workspaces
    });
    wizard.onClose = () => { this._refreshAll(); };
    wizard.onComplete = () => { this._refreshAll(); };
    wizard.open();
  }

```

- [ ] **Step 3: Expose workspace explorer for wizard access**

In `src/frontend/js/main.js`, find where the workspace explorer is initialized. We need to ensure the workspace list is accessible. Find the line that creates the workspace explorer (search for `new WorkspaceExplorer`) and add after its initialization:

```javascript
    window.edogWorkspaceExplorer = wsExplorer;
```

This allows the wizard to access the cached workspace list for name collision checking.

- [ ] **Step 4: Verify build + tests**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python scripts/build-html.py && python -m pytest tests/ -q
```
Expected: Build succeeds, 103/103 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/js/workspace-explorer.js src/frontend/js/main.js
git commit -m "feat(F16): wire Infra Wizard into workspace context menu and main.js"
```

---

## Task 6: Build Verification + Visual Audit

**Files:**
- All files from Tasks 1-5

- [ ] **Step 1: Full build**

```bash
cd C:\Users\guptahemant\newrepo\edog-studio
python scripts/build-html.py
```
Expected: Build succeeds, output to `src/edog-logs.html`.

- [ ] **Step 2: Run tests**

```bash
python -m pytest tests/ -q
```
Expected: 103/103 pass.

- [ ] **Step 3: Open dev server**

```bash
python scripts/dev-server.py
```
Open http://127.0.0.1:5555/edog-logs.html?mock in browser.

- [ ] **Step 4: Visual comparison against mockup**

Open `docs/specs/features/F16-environment-wizard/mocks/infra-wizard.html` alongside the running app. Compare pixel-by-pixel:

**Dialog shell:**
- [ ] Overlay with blur(8px) backdrop
- [ ] Dialog centered, 920x680 max, 14px border radius
- [ ] Header: layers icon (accent color) + "New Infrastructure" title + ✕ close button
- [ ] Drag hint (thin bar centered at top of header)
- [ ] 5-step stepper: Setup (active, accent pulse) → Theme → Build → Review → Deploy
- [ ] Step circles: 30px, numbered, active = accent + glow
- [ ] Step connectors: 56px horizontal lines between steps
- [ ] Footer: Back (hidden on page 1) + Next → button (accent primary)

**Page 1 (Setup):**
- [ ] Workspace Name input: mono font, randomize icon button (refresh SVG)
- [ ] Randomize click spins icon, generates adjective_noun_NN pattern
- [ ] Capacity dropdown: loads mock data, shows SKU — Region (State)
- [ ] "Create New Capacity" link with "Coming Soon" badge
- [ ] Lakehouse + Notebook side by side (2-column grid)
- [ ] Auto-sync: workspace name cascades to lakehouse + notebook
- [ ] Manual edit breaks sync for that field only
- [ ] Validation on blur: red border + error text for invalid, green ✓ for valid
- [ ] Next button disabled when form invalid

**Page 2 (Theme):**
- [ ] 3x2 grid of theme cards
- [ ] Each card: icon (SVG, accent color bg), name (bold), table list (mono, muted)
- [ ] Hover: purple border, lift -2px, shadow
- [ ] Selected: accent border, accent bg, checkmark circle (top-right)
- [ ] Single-select (clicking another deselects previous)
- [ ] Schema section: "dbo" chip (always included)
- [ ] Medallion toggle: slide track, on = accent, off = gray
- [ ] Toggle on: reveal bronze/silver/gold chips (animated slide-down)
- [ ] Chip click: toggle active/inactive, checkbox fill matches schema color
- [ ] Toggle off: all chips deactivate, collapse

**Navigation:**
- [ ] Next validates current page before advancing
- [ ] Page transition: slide-left (forward), slide-right (backward)
- [ ] Stepper updates: completed steps = green check, active = accent pulse
- [ ] Connectors fill green as steps complete
- [ ] Back button appears on page 2+
- [ ] Clicking completed step circle jumps back to that page
- [ ] Escape key closes wizard (with confirmation if dirty)
- [ ] Close ✕ shows confirmation dialog if form has been edited
- [ ] Ctrl+Enter triggers Next from any field

- [ ] **Step 5: Fix any visual discrepancies**

If any pixel-perfect issues are found, fix them in the CSS or JS and commit:

```bash
git add -A
git commit -m "fix(F16): visual polish for Infra Wizard Phase 1"
```

---

## Summary

| Task | Component | ~LOC | Files |
|------|-----------|------|-------|
| 1 | CSS styles | ~600 | infra-wizard.css |
| 2 | Dialog shell (singleton, stepper, nav, drag, focus trap) | ~500 | infra-wizard.js |
| 3 | InfraSetupPage (random names, capacity API, validation) | ~400 | infra-wizard.js |
| 4 | ThemeSchemaPage (theme cards, medallion chips) | ~300 | infra-wizard.js |
| 5 | Integration (context menu, main.js) | ~15 | workspace-explorer.js, main.js |
| 6 | Build verify + visual audit | — | all |
| **Total** | | **~1815** | **5 files** |
