# Feature 2: Deploy to Lakehouse

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Elena Voronova (Python) + Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F02-deploy-to-lakehouse.md
> **Design Ref:** docs/specs/design-spec-v2.md §2

### Problem

Deploying to a lakehouse today is a 6-step manual process: edit edog-config.json → copy workspace/artifact/capacity IDs → run edog.py → wait for auth → wait for build → verify service starts. Engineers do this 3-5 times per day, every time they switch lakehouses.

### Objective

One-click deployment from the Workspace Explorer: select a lakehouse, click "Deploy to this Lakehouse", and EDOG handles config update → token fetch → code patching → build → service launch with live progress UI.

### Owner

**Primary:** Elena Voronova (Python deploy flow) + Zara Okonkwo (JS progress UI)
**Reviewers:** Sana Reeves (architecture), Arjun Mehta (C# server lifecycle), Dev Patel (FLT build correctness)

### Inputs

- Selected lakehouse object from Workspace Explorer (workspaceId, artifactId, capacityId)
- Bearer token (already available from Phase 1 auth)
- edog.py deploy pipeline: `fetch_mwc_token()` → `patch_code()` → `build_service()` → `launch_service()`
- IPC channel: browser → EdogLogServer → `.edog-command/` → edog.py

### Outputs

- **Files modified:**
  - `src/frontend/js/workspace-explorer.js` — Add Deploy button handler, progress rendering
  - `src/frontend/css/workspace.css` — Deploy progress bar styles
  - `src/backend/DevMode/EdogLogServer.cs` — Add `POST /api/command/deploy` endpoint
  - `edog.py` — Add `.edog-command/` polling loop, deploy-from-command handler
  - `src/frontend/js/state.js` — Phase transition: disconnected → deploying → connected
  - `src/frontend/js/sidebar.js` — Enable/disable views based on phase
  - `src/frontend/js/topbar.js` — Update service status during deploy
- **New IPC command:** `deploy` with payload `{workspaceId, artifactId, capacityId}`
- **New WebSocket messages:** `{ type: 'deploy_progress', step: 1, total: 5, message: '...' }`

### Technical Design

**Deploy flow (5 steps):**

```
Step 1: Update config
  Browser → POST /api/command/deploy {workspaceId, artifactId, capacityId}
  → EdogLogServer writes .edog-command/deploy.json
  → edog.py reads command → updates edog-config.json

Step 2: Fetch MWC token
  → edog.py calls fetch_mwc_token(workspace_id) using bearer token
  → Writes MWC token to edog-config.json
  → Sends progress via .edog-command/deploy-progress.json

Step 3: Patch FLT code
  → edog.py applies EDOG DevMode patches
  → Updates deploy-progress.json

Step 4: Build
  → edog.py runs dotnet build
  → Updates deploy-progress.json

Step 5: Launch service
  → edog.py starts the FLT process
  → Waits for service ready (health check)
  → Updates deploy-progress.json with final status
```

**Frontend — Deploy progress UI (in workspace-explorer.js):**

```
class DeployFlow {
  constructor(contentPanel, wsClient, stateManager)

  async startDeploy(lakehouse)       // Initiates deploy via IPC
  renderProgress(step, total, msg)   // Inline progress bar in center panel
  onDeployComplete()                 // Transition phase → connected
  onDeployFailed(error)              // Show error with retry option
  pollProgress()                     // Poll /api/command/deploy-status every 500ms

  _renderProgressBar(step, total)    // 5-segment horizontal bar
  _renderStepMessage(msg)            // "Step 2/5: Fetching MWC token..."
}
```

**Backend — `EdogLogServer.cs`:**

Add IPC command endpoints:

```csharp
// New POST endpoints
POST /api/command/deploy         // Write deploy.json to .edog-command/
GET  /api/command/deploy-status  // Read deploy-progress.json
POST /api/command/restart        // Write restart.json
POST /api/command/refresh-token  // Write refresh-token.json
```

**Python — `edog.py`:**

Add command polling loop:

```python
async def poll_commands(command_dir: Path) -> None:
    """Poll .edog-command/ for new commands every 2 seconds."""
    while True:
        for cmd_file in command_dir.glob("*.json"):
            if cmd_file.stem.endswith("-progress") or cmd_file.stem.endswith("-result"):
                continue
            command = json.loads(cmd_file.read_text())
            await execute_command(cmd_file.stem, command, command_dir)
            cmd_file.unlink()
        await asyncio.sleep(2)

async def execute_deploy(payload: dict, command_dir: Path) -> None:
    """Execute deploy flow: config → token → patch → build → launch."""
    progress_file = command_dir / "deploy-progress.json"
    # Step 1-5 with progress updates written to progress_file
```

### Acceptance Criteria

- [ ] "Deploy to this Lakehouse" button appears only for lakehouse items in center panel
- [ ] Clicking Deploy shows inline 5-step progress bar (not a modal)
- [ ] Each step shows progress text: "Step N/5: {description}..."
- [ ] Successful deploy transitions UI phase from disconnected → connected
- [ ] After deploy: sidebar tabs 2-4 (Logs, DAG, Spark) become enabled
- [ ] After deploy: top bar service status changes from gray/stopped → green/running
- [ ] After deploy: token countdown appears in top bar
- [ ] Failed deploy shows error message with "Retry" button
- [ ] Config file (edog-config.json) is correctly updated with workspace/artifact/capacity IDs
- [ ] Re-deploying to a different lakehouse stops the current service first
- [ ] Deploy progress survives a browser refresh (polling-based, not WebSocket-only)

### Dependencies

- **Feature 1 (Workspace Explorer):** Lakehouse selection must work before deploy
- **Feature 5 (Top Bar):** Service status and token health must render correctly
- **Feature 6 (Sidebar):** Phase-aware enable/disable must work

### Risks

| Risk | Mitigation |
|------|------------|
| edog.py command polling adds latency (2-5s per step) | Start with 2s polling. If too slow, implement edog.py HTTP control server on :5556. |
| Build step takes 60+ seconds | Show animated progress. Consider caching builds (skip rebuild if only config changed). |
| MWC token fetch fails (cert issue, scope) | Clear error message with retry. Suggest manual auth steps. |

### Moonshot Vision

V2+: Instant hot-deploy (no rebuild for config-only changes). Parallel deployment to multiple lakehouses. Deploy history with one-click rollback. Deploy presets saved as favorites.

