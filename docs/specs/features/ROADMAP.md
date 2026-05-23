# Feature Roadmap

Implementation status for all EDOG Studio feature specs.

## Implemented

| Feature | Spec | Implementation |
|---------|------|---------------|
| F00 Onboarding | `F00-onboarding/` | `onboarding.js` |
| F01 Workspace Explorer | `F01-workspace-explorer/` | `workspace-explorer.js` |
| F02 Deploy to Lakehouse | `F02-deploy-to-lakehouse/` | `deploy-flow.js`, `deploy-strip.js` |
| F04 Runtime View | `F04-runtime-view/` | `runtime-view.js` + 11 tab modules |
| F05 Top Bar | `F05-top-bar/` | `topbar.js` |
| F06 Sidebar | `F06-sidebar/` | `sidebar.js` |
| F07 Command Palette | `F07-command-palette/` | `command-palette.js` |
| F08 DAG Studio | `F08-dag-studio/` | `dag-studio.js`, `dag-gantt.js`, `dag-graph.js`, `dag-layout.js`, `control-panel.js` |
| F09 API Playground | `F09-api-playground/` | `api-playground.js` |
| F10 Token Inspector | `F10-token-inspector/` | Token Inspector drawer in `topbar.js` — JWT decode, claims, scopes, expiry bar, refresh, copy, auto-open on expire |
| F11 Environment Panel | `F11-environment-panel/` | `environment-cards.js`, `feature-flags-matrix.js`, `flag-inspector.js` |
| F12 Error Intelligence | `F12-error-intelligence/` | `error-intel.js`, `error-decoder.js`, `error-timeline.js` |
| F13 File Change Detection | `F13-file-change-detection.md` | `file-watcher.js` (frontend) + `FileWatcher` in dev-server (backend) — polls for .cs changes, notification bar with Re-deploy |
| F16 Environment Wizard | `F16-environment-wizard/` | `infra-wizard.js` + 14 `wizard-*.js` modules — 5-page wizard, DAG canvas, import from lakehouse, code gen |
| F26 Nexus Dependency Graph | `F26-nexus-dependency-graph/` | `tab-nexus.js` + 4 C# backend files |
| F27 QA Testing | `F27-qa-testing/` | 8 `qa-*.js` frontend + 20+ C# backend — LLM scenario gen, execution engine, assertion engine |
| F28 HTTP MITM | `F28-http-mitm/` | `tab-http.js` (extended), `http-row-menu.js` + 5 C# backend — intercept, edit, forward/block/forge, Send to Playground |
| Session Guard | (no spec) | `EdogSessionRegistry.cs`, `EdogSessionController.cs` + frontend — deploy collision detection, user identity |

## Planned (V1.1+)

| Feature | Spec | Priority | Notes |
|---------|------|----------|-------|
| F03 Favorites & Environments | `F03-favorites-environments/` | V1.1 | Save/recall workspace+LH combos |
| F15 Execution Comparison | `F15-execution-comparison.md` | V1.1 | Side-by-side DAG run diff |
| F17 Service Restart from UI | `F17-service-restart-from-ui.md` | V1.1 | Button to restart FLT from Studio |
| F18 Session History Timeline | `F18-session-history-timeline.md` | V1.1 | Timeline of all EDOG sessions |
| F20 Quick Environment Clone | `F20-quick-environment-clone.md` | V1.1 | Clone a lakehouse config |
| F21 DAG Definition Viewer | `F21-dag-definition-viewer.md` | V1.1 | Read-only DAG JSON viewer |
| F22 Table Schema Preview | `F22-table-schema-preview-stats.md` | V1.1 | Show table columns/types/stats |
| F23 CRUD Operations | `F23-crud-operations-fabric-items.md` | V2.0 | Create/rename/delete Fabric items |
| F24 Chaos Engineering | `F24-chaos-engineering/` | V2.0 | Full chaos panel (F28 MITM is a subset) |

## Meta / Process

| Feature | Spec | Notes |
|---------|------|-------|
| F25 Tech Debt | `F25-tech-debt/` | Tracking spec, not a deliverable feature |
