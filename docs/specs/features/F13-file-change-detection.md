# Feature 13: File Change Detection

> **Phase:** V1.1
> **Status:** Not Started
> **Owner:** Elena Voronova (Python)
> **Spec:** docs/specs/features/F13-file-change-detection.md
> **Design Ref:** docs/specs/design-spec-v2.md §13

### Problem

Engineers edit FLT C# code in VS, then must remember to rebuild and restart the service. They often test against stale code because they forgot to re-deploy.

### Objective

Python file watcher monitors the FLT repo for C# file changes (excluding EDOG patches), shows a notification bar in the UI with changed file names and a one-click "Re-deploy" button.

### Owner

**Primary:** Elena Voronova (Python watchdog watcher)
**Reviewers:** Sana Reeves (IPC design), Zara Okonkwo (UI notification bar)

### Inputs

- FLT repo `Service/` directory path
- Known EDOG patch files (to exclude from detection)
- Initial file state at session start (baseline for comparison)
- `watchdog` Python library for file system events

### Outputs

- **Files modified:**
  - `edog.py` — Add `FileWatcher` class using `watchdog` library
  - `src/frontend/js/topbar.js` — Render file change notification bar
  - `src/frontend/css/topbar.css` — Notification bar styles
  - `src/backend/DevMode/EdogLogServer.cs` — New WebSocket message type `file_changed`

### Acceptance Criteria

- [ ] File watcher detects .cs, .json, .csproj changes in FLT Service/ directory
- [ ] EDOG DevMode patch files are excluded from detection
- [ ] Build output directories excluded
- [ ] Notification bar shows: "Files changed: [list] — [Re-deploy] [Dismiss]"
- [ ] "Re-deploy" triggers full rebuild + relaunch
- [ ] "Dismiss" hides the bar (re-appears on next change)
- [ ] Changes debounced (2 second delay to batch rapid saves)
- [ ] Works alongside the regular deploy flow

### Dependencies

- **Feature 2 (Deploy):** Uses same deploy flow for re-deploy
- IPC channel for edog.py → browser communication

### Risks

| Risk | Mitigation |
|------|------------|
| `watchdog` adds a pip dependency | Already in requirements. Acceptable for CLI tool. |
| False positives from IDE temp files | Filter by extension (.cs, .json, .csproj only). Exclude bin/, obj/. |

### Moonshot Vision

V2+: Incremental rebuild (only rebuild changed assemblies). Hot-reload for config-only changes without full rebuild.

