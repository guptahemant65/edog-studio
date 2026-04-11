# F02 Deploy to Lakehouse — Complete UX State Matrix

> **Feature:** F02 Deploy to Lakehouse
> **Status:** Specification complete
> **Owner:** Elena (CLI/IPC) + Arjun (C#) + Zara (JS) + Kael (UX)
> **Last Updated:** 2026-04-12
> **States Documented:** 120+

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by phase of the deploy lifecycle. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates DEPLOY-042").

### Pipeline Step Reference

| Step | Label | What Happens |
|------|-------|--------------|
| 1 | Fetch MWC token | Bearer token → `fetch_mwc_token()` for workspace/lakehouse/capacity |
| 2 | Patch code | Inject EDOG DevMode interceptors into FLT source |
| 3 | Build | `dotnet build` the patched FLT service |
| 4 | Launch | Start the FLT service process |
| 5 | Ready check | Health-check ping until service responds |

---

## 1. PRE-DEPLOY STATES

### 1.1 Button Visibility & Readiness

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-001 | No lakehouse selected | No tree item selected, or workspace/notebook selected | Deploy button absent from content panel header. No deploy affordance anywhere. Context menu on non-lakehouse items has no deploy option | DEPLOY-002 |
| DEPLOY-002 | Lakehouse selected (Phase 1) | Lakehouse clicked in workspace explorer tree | Content panel header shows [▶ Deploy to this Lakehouse] button, accent-filled, left-aligned in action row. Tooltip: "Patch, build, and launch FLT connected to this lakehouse". Context menu includes "▶ Deploy to this Lakehouse" as first item | DEPLOY-010, DEPLOY-020, DEPLOY-030 |
| DEPLOY-003 | Deploy button hover | Mouse enters deploy button | Background intensifies (oklch lightness +5%). Cursor: pointer. Subtle translateY(-1px) lift | DEPLOY-002 |
| DEPLOY-004 | Deploy button disabled (no bearer) | Bearer token expired and re-auth failed | Button shows muted/disabled state: 40% opacity, cursor: not-allowed. Tooltip: "Sign in required — bearer token expired" | TOKEN-005 → re-auth → DEPLOY-002 |
| DEPLOY-005 | Deploy button disabled (deploy in progress) | Deploy already running for any lakehouse | Button disabled with spinner icon replacing ▶. Label: "Deploying..." Tooltip: "A deployment is already in progress" | DEPLOY-100 (pipeline states) |
| DEPLOY-006 | Deploy keyboard focus | Tab reaches deploy button | Focus ring: 2px solid var(--accent) with glow. Screen reader: "Deploy to this Lakehouse button. Patches, builds, and launches the FLT service." | DEPLOY-010 (Enter) |

### 1.2 Config Validation (Pre-flight)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-010 | Pre-flight check | User clicks [▶ Deploy] or presses Enter on focused button | Button immediately shows spinner. Label: "Validating..." (200ms minimum display). System checks: workspace ID valid, capacity reachable, FLT source path exists, no conflicting edog-config.json lock | DEPLOY-011, DEPLOY-012, DEPLOY-013, DEPLOY-014, DEPLOY-015, DEPLOY-100 |
| DEPLOY-011 | Pre-flight: workspace invalid | Workspace ID in config doesn't match any known workspace | Error toast: "Workspace not found — the workspace may have been deleted or you lack access." Deploy aborted. Button reverts to ready state | DEPLOY-002 |
| DEPLOY-012 | Pre-flight: capacity unreachable | Capacity host returns 5xx or connection refused | Warning dialog (inline, not modal): "Capacity '{name}' is not responding. Deploy may fail at token step." [Deploy Anyway] [Cancel]. Yellow border | DEPLOY-100 (deploy anyway), DEPLOY-002 (cancel) |
| DEPLOY-013 | Pre-flight: FLT source not found | FLT repo path configured in edog-config.json doesn't exist | Error toast: "FLT source directory not found at '{path}'. Update edog-config.json → flt_source_path." Deploy aborted | DEPLOY-002 |
| DEPLOY-014 | Pre-flight: config locked | Another edog.py instance has a lock on edog-config.json | Error toast: "Config file locked by another EDOG instance (PID {pid}). Close it or run: edog unlock" [Force Unlock] [Cancel] | DEPLOY-002 |
| DEPLOY-015 | Pre-flight: bearer expiring soon | Bearer token has <5 min remaining | Warning inline: "Bearer token expires in {mm}:{ss}. Deploy may fail mid-pipeline." [Refresh Token First] [Deploy Anyway]. If refresh chosen: silent CBA → then deploy | DEPLOY-100 (deploy anyway), TOKEN-004 (refresh) → DEPLOY-100 |

### 1.3 Already-Deployed Confirmations

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-020 | Re-deploy same lakehouse | Click deploy on lakehouse that is currently deployed (Phase 2 active) | Confirmation dialog (inline card below header, not modal): "Already deployed to '{name}'. Re-deploy will restart the service." Timer shows current uptime: "Running for 1h 23m". [Re-deploy] (accent) [Cancel] (ghost). Escape dismisses | DEPLOY-100 (re-deploy), DEPLOY-002 (cancel) |
| DEPLOY-021 | Re-deploy same — service crashed | Click deploy on same lakehouse but service is in crashed state | Different dialog: "Service crashed. Re-deploy to restart?" No "Running for" timer. [Re-deploy] [Cancel] | DEPLOY-100, DEPLOY-002 |
| DEPLOY-030 | Switch deployment target | Click deploy on a DIFFERENT lakehouse while currently deployed to another | Confirmation dialog: "Currently deployed to '{currentName}'. Switch to '{newName}'?" with side-by-side comparison: Current (workspace, lakehouse, capacity) → New (workspace, lakehouse, capacity). Warning: "The current service will be stopped." [Switch] (amber) [Cancel] | DEPLOY-040, DEPLOY-002 (cancel) |
| DEPLOY-031 | Switch with unsaved state | Switch deployment while logs have bookmarks or unsaved filters | Additional line in DEPLOY-030 dialog: "⚠ You have {n} bookmarked log entries. They will be preserved but may not apply to the new deployment." | DEPLOY-040, DEPLOY-002 |

### 1.4 Undeploy (Stop Current)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-040 | Undeploy starting | Switch confirmed, or explicit "Undeploy" from top bar context menu | Progress indicator in top bar: "Stopping service..." (amber pulse). Content panel shows inline progress: Step 1/2: "Stopping FLT process..." | DEPLOY-041, DEPLOY-043 |
| DEPLOY-041 | Undeploy: process stopped | FLT process terminated (SIGTERM → 5s → SIGKILL if needed) | Step 1: green ✓. Step 2/2: "Reverting patches..." | DEPLOY-042, DEPLOY-044 |
| DEPLOY-042 | Undeploy: patches reverted | All patched files restored to original | Both steps ✓. Toast: "Service stopped and patches reverted." Phase 1 transition: sidebar Logs/DAG/Spark icons dim with cascade animation. Top bar status → gray "Disconnected". MWC token countdown removed. Uptime counter stops | DEPLOY-002 (if switching → DEPLOY-100), DEPLOY-001 (if explicit undeploy) |
| DEPLOY-043 | Undeploy: process kill failed | Process didn't respond to SIGTERM and SIGKILL failed | Error: "Could not stop FLT process (PID {pid}). Kill manually: taskkill /PID {pid} /F" [Retry] [Force Continue] | DEPLOY-041 (retry), DEPLOY-044 (force) |
| DEPLOY-044 | Undeploy: revert failed | Patch revert couldn't restore original files | Error card: "Could not revert patched files. Manual cleanup needed:" + list of files with paths. [Open Folder] [Copy Paths] [Skip & Continue]. Red border | DEPLOY-002 (skip), manual cleanup |
| DEPLOY-045 | Undeploy: partial (skip revert) | User chose "Skip & Continue" on revert failure | Warning banner persists at top of content panel: "⚠ FLT source has unreverted patches. Run: edog clean-patches" [Dismiss] [Clean Now] | DEPLOY-002 |

---

## 2. DEPLOY PIPELINE STATES

### 2.0 Pipeline Container

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-100 | Pipeline started | Pre-flight passed (or undeploy completed for switch) | Deploy button changes to "Deploying..." with spinner, disabled. Content panel: 5-step horizontal stepper appears below lakehouse header. Each step: numbered circle (1-5) + label + connecting line. All circles: gray outline. Linear progress bar below stepper (0%). Top bar status: gray → amber pulse "Deploying...". [Cancel] button (ghost, right-aligned) | DEPLOY-110 |
| DEPLOY-101 | Pipeline container — expanded view | User clicks "Show details ▾" below stepper | Terminal-style output area expands below stepper (dark bg: oklch(15% 0 0), monospace, 200px max-height, scrollable). Shows timestamped log lines for each step. Resize handle at bottom edge | DEPLOY-102 |
| DEPLOY-102 | Pipeline container — collapsed view | User clicks "Hide details ▴" | Terminal area collapses with slide animation (200ms). Only stepper + progress bar visible | DEPLOY-100 |
| DEPLOY-103 | Pipeline slow overall | Total pipeline time exceeds 120s | Text below progress bar: "This is taking longer than usual..." (amber, fade-in at 120s) | — |

### 2.1 Step 1 — Fetch MWC Token

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-110 | Step 1 starting | Pipeline begins | Step 1 circle: accent fill with pulse ring animation. Label: "Fetching MWC token..." Progress bar: indeterminate shimmer (0-20% range). Terminal log: "[HH:MM:SS] Requesting MWC token for workspace {id}..." | DEPLOY-111, DEPLOY-112 |
| DEPLOY-111 | Step 1 succeeded | `fetch_mwc_token()` returns valid token | Step 1 circle: green fill + ✓ checkmark (pop animation, 300ms, cubic-bezier bounce). Progress bar: 20% solid green. Terminal: "[HH:MM:SS] ✓ MWC token acquired (expires in {mm}m)" | DEPLOY-120 |
| DEPLOY-112 | Step 1 failed: capacity throttled | Capacity returns 429 / admission window delay | Step 1 circle: red fill + ✕. Label: "Capacity throttled". Detail text: "Capacity '{name}' is rate-limiting requests. Retry in {n}s." Auto-retry countdown shown. Progress bar: red. Terminal: "[HH:MM:SS] ✕ 429 Too Many Requests — capacity throttled" [Retry Now] [Cancel] | DEPLOY-110 (retry/auto-retry), DEPLOY-190 (cancel) |
| DEPLOY-113 | Step 1 failed: bearer expired | Bearer token expired during MWC fetch | Step 1 circle: red ✕. Label: "Bearer token expired". Detail: "Your session token expired. Re-authenticating..." Silent CBA auto-triggered. If CBA succeeds: auto-retry step 1. If fails: show [Sign In] | DEPLOY-110 (auto-retry after CBA), DEPLOY-002 (sign-in needed) |
| DEPLOY-114 | Step 1 failed: wrong audience | Token audience mismatch (wrong tenant/resource) | Step 1 circle: red ✕. Label: "Token audience mismatch". Detail: "MWC token was issued for a different resource. Check workspace configuration." [Retry] [Cancel] | DEPLOY-110 (retry), DEPLOY-190 (cancel) |
| DEPLOY-115 | Step 1 failed: network error | Connection refused, DNS failure, timeout | Step 1 circle: red ✕. Label: "Network error". Detail: "Could not reach token service. Check network connection." Terminal: "[HH:MM:SS] ✕ ConnectionError: {detail}" [Retry] [Cancel] | DEPLOY-110 (retry), DEPLOY-190 (cancel) |
| DEPLOY-116 | Step 1 failed: forbidden (403) | Insufficient permissions for workspace | Step 1 circle: red ✕. Label: "Access denied". Detail: "You don't have permission to deploy to this workspace. Contact workspace admin." [Cancel] — no retry (won't help) | DEPLOY-190 (cancel) |
| DEPLOY-117 | Step 1 failed: capacity offline | Capacity host unreachable (not throttled, just down) | Step 1 circle: red ✕. Label: "Capacity offline". Detail: "Capacity '{name}' is not responding. It may be paused or deleted." [Retry] [Check Capacity in Fabric] [Cancel] | DEPLOY-110 (retry), DEPLOY-190 (cancel) |
| DEPLOY-118 | Step 1 failed: generic | Any other unexpected error | Step 1 circle: red ✕. Label: "Token acquisition failed". Detail: "{error.message}" + error code if available. Terminal: full error stack. [Retry] [Cancel] | DEPLOY-110 (retry), DEPLOY-190 (cancel) |
| DEPLOY-119 | Step 1 slow (>10s) | Token fetch taking longer than expected | Step 1 label appends: "(taking longer than usual...)" — amber text. Pulse ring slows to indicate waiting, not stuck | DEPLOY-111, DEPLOY-112+ |

### 2.2 Step 2 — Patch Code

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-120 | Step 2 starting | Step 1 succeeded | Step 2 circle: accent + pulse. Label: "Patching code..." Progress: 20→40% animated. Terminal: "[HH:MM:SS] Patching FLT source at {path}..." + file list as each file is patched | DEPLOY-121, DEPLOY-122 |
| DEPLOY-121 | Step 2 in progress | Files being patched one by one | Label: "Patching code — {n}/{total} files..." Each patched file appears in terminal: "[HH:MM:SS]   ✓ EdogLogInterceptor.cs patched" Progress bar advances incrementally within 20-40% range | DEPLOY-125, DEPLOY-126 |
| DEPLOY-122 | Step 2 file banner | First file is patched | File-change banner slides in below stepper (above terminal): "Modified: EdogLogInterceptor.cs, EdogApiProxy.cs, EdogTelemetryInterceptor.cs" with file count badge. Banner is informational, no action required | DEPLOY-125 |
| DEPLOY-125 | Step 2 succeeded | All files patched | Step 2 circle: green ✓ (pop). Progress: 40%. Terminal: "[HH:MM:SS] ✓ {n} files patched successfully" File banner persists | DEPLOY-130 |
| DEPLOY-126 | Step 2 failed: patch conflict | FLT source code changed since last known version; patch hunks don't apply | Step 2 circle: red ✕. Label: "Patch conflict". Detail: "'{filename}' has changed since last patch template. The interceptor insertion point has moved." File diff snippet in terminal (3-line context). [Force Re-patch] [Open in VS Code] [Cancel] | DEPLOY-120 (force), DEPLOY-190 (cancel) |
| DEPLOY-127 | Step 2 failed: file not found | Expected source file missing from FLT repo | Step 2 circle: red ✕. Label: "File not found". Detail: "'{filename}' does not exist at '{path}'. FLT repo may be on a different branch." [Cancel] | DEPLOY-190 (cancel) |
| DEPLOY-128 | Step 2 failed: permission denied | OS file permission error (read-only, locked by IDE) | Step 2 circle: red ✕. Label: "Permission denied". Detail: "Cannot write to '{filename}'. File may be locked by another process (VS, Rider)." [Retry] [Cancel] | DEPLOY-120 (retry), DEPLOY-190 (cancel) |
| DEPLOY-129 | Step 2 failed: generic | Unexpected I/O error | Step 2 circle: red ✕. Label: "Patch failed". Detail: "{error.message}" Terminal: full error. Partial patches auto-reverted. [Retry] [Cancel] | DEPLOY-120 (retry), DEPLOY-190 (cancel) |

### 2.3 Step 3 — Build

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-130 | Step 3 starting | Step 2 succeeded | Step 3 circle: accent + pulse. Label: "Building FLT service..." Progress: 40→60% range. Terminal: "[HH:MM:SS] dotnet build started..." Terminal auto-expands if collapsed (build output is important). [Cancel] available | DEPLOY-131, DEPLOY-135 |
| DEPLOY-131 | Step 3 in progress | Build producing output | Terminal shows live `dotnet build` output (streaming, last 30 lines visible, auto-scroll pinned to bottom). Each line prefixed with timestamp. Warning lines: amber. Error lines: red. Label updates: "Building... {elapsed}s" Progress: indeterminate within 40-60% | DEPLOY-135, DEPLOY-136 |
| DEPLOY-132 | Step 3 NuGet restore | Build starts with package restore phase | Label: "Restoring NuGet packages..." Terminal shows restore progress. This is a sub-phase — no separate step circle | DEPLOY-131 |
| DEPLOY-133 | Step 3 build warnings | Build produces warnings but no errors | Terminal: warning lines shown in amber. Counter appears: "⚠ {n} warnings". Warnings don't block success | DEPLOY-135 |
| DEPLOY-134 | Step 3 build scroll control | User scrolls up in terminal during build | Auto-scroll pauses. "↓ Auto-scroll paused" chip appears at bottom-right of terminal. Click chip or press End to re-enable auto-scroll | DEPLOY-131 |
| DEPLOY-135 | Step 3 succeeded | `dotnet build` exits with code 0 | Step 3 circle: green ✓. Progress: 60%. Terminal: "[HH:MM:SS] ✓ Build succeeded ({elapsed}s)" + warning count if any. Label: "Build succeeded" (green text, 2s, then moves to step 4) | DEPLOY-140 |
| DEPLOY-136 | Step 3 failed: compiler errors | `dotnet build` exits non-zero with CS* errors | Step 3 circle: red ✕. Label: "Build failed". Terminal: full error output with red-highlighted error lines. First error extracted and shown in detail text: "{file}({line},{col}): error {code}: {message}". [Open in VS Code] (opens file at line) [Retry Build] [Cancel] | DEPLOY-130 (retry), DEPLOY-190 (cancel) |
| DEPLOY-137 | Step 3 failed: NuGet restore failed | Package restore fails (network, missing feed, auth) | Step 3 circle: red ✕. Label: "NuGet restore failed". Detail: "Could not restore packages: {error}. Check NuGet.config and network." [Retry] [Cancel] | DEPLOY-130 (retry), DEPLOY-190 (cancel) |
| DEPLOY-138 | Step 3 failed: timeout | Build exceeds 300s (5 min) | Step 3 circle: red ✕. Label: "Build timed out". Detail: "Build did not complete in 5 minutes. Large project or resource contention?" [Retry with Extended Timeout] [Cancel]. Extended timeout = 600s | DEPLOY-130 (retry), DEPLOY-190 (cancel) |
| DEPLOY-139 | Step 3 failed: generic | Unexpected build error (MSBuild crash, disk full) | Step 3 circle: red ✕. Label: "Build error". Detail: "{error.message}" Terminal: full output. [Retry] [Cancel] | DEPLOY-130 (retry), DEPLOY-190 (cancel) |

### 2.4 Step 4 — Launch Service

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-140 | Step 4 starting | Step 3 succeeded | Step 4 circle: accent + pulse. Label: "Launching service..." Progress: 60→80%. Terminal: "[HH:MM:SS] Starting FLT service process..." | DEPLOY-145, DEPLOY-146 |
| DEPLOY-141 | Step 4 process spawned | Process started, PID assigned | Terminal: "[HH:MM:SS] FLT service started (PID {pid})" Label: "Service starting (PID {pid})..." | DEPLOY-145, DEPLOY-146 |
| DEPLOY-145 | Step 4 succeeded | Process running and initial stdout looks healthy | Step 4 circle: green ✓. Progress: 80%. Terminal: "[HH:MM:SS] ✓ Service process running" | DEPLOY-150 |
| DEPLOY-146 | Step 4 failed: port in use | Bind exception — another process on the target port | Step 4 circle: red ✕. Label: "Port {port} in use". Detail: "Port {port} is occupied by process '{name}' (PID {pid})." [Kill Process & Retry] [Use Different Port] [Cancel]. If user clicks Kill: terminate blocking process → auto-retry | DEPLOY-140 (retry after kill), DEPLOY-190 (cancel) |
| DEPLOY-147 | Step 4 failed: crash on start | Process exits within 2s of launch | Step 4 circle: red ✕. Label: "Service crashed on startup". Detail: "FLT exited with code {code} immediately after launch." Terminal shows last 20 lines of process stderr. [View Full Output] [Retry] [Cancel] | DEPLOY-140 (retry), DEPLOY-190 (cancel) |
| DEPLOY-148 | Step 4 failed: missing config | Process starts but logs "Configuration missing" and exits | Step 4 circle: red ✕. Label: "Missing configuration". Detail: "FLT could not find required config: '{configKey}'. Check edog-config.json." [Open Config] [Retry] [Cancel] | DEPLOY-140 (retry), DEPLOY-190 (cancel) |
| DEPLOY-149 | Step 4 failed: generic | Unexpected launch failure | Step 4 circle: red ✕. Label: "Launch failed". Detail: "{error.message}" [Retry] [Cancel] | DEPLOY-140 (retry), DEPLOY-190 (cancel) |

### 2.5 Step 5 — Ready Check

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-150 | Step 5 starting | Step 4 succeeded | Step 5 circle: accent + pulse. Label: "Waiting for service ready..." Progress: 80→100% range. Terminal: "[HH:MM:SS] Pinging health endpoint..." Ping animation: 3 dots cycling (●○○ → ○●○ → ○○●) next to label | DEPLOY-155, DEPLOY-156 |
| DEPLOY-151 | Step 5 pinging | Health check attempts in progress | Label: "Pinging... attempt {n}/{max}" (max = 30, interval = 1s). Each failed ping: terminal shows "[HH:MM:SS] Ping {n}: no response" (dimmed). Progress bar: slowly advancing 80→95% | DEPLOY-155, DEPLOY-156 |
| DEPLOY-152 | Step 5 partial response | Service responds but returns 5xx or unhealthy status | Label: "Service responding but not healthy (HTTP {code})..." Terminal: "[HH:MM:SS] Ping {n}: HTTP {code} — {body}". Continues pinging — some services need warm-up | DEPLOY-155, DEPLOY-156 |
| DEPLOY-155 | Step 5 succeeded (service ready) | Health endpoint returns 200 | Step 5 circle: green ✓ (pop). Progress: 100% green, brief pulse animation. Label: "Service ready!" (green, bold). Terminal: "[HH:MM:SS] ✓ Service healthy — HTTP 200" | DEPLOY-200 |
| DEPLOY-156 | Step 5 failed: timeout | 30 pings (30s) with no healthy response | Step 5 circle: red ✕. Label: "Health check timed out". Detail: "Service did not become healthy within 30s. It may still be starting up." [Wait 30s More] [Check Logs] [Retry Step] [Cancel]. "Wait 30s More" resets ping counter | DEPLOY-150 (retry/wait), DEPLOY-190 (cancel) |
| DEPLOY-157 | Step 5 failed: process died | FLT process exited during health check | Step 5 circle: red ✕. Label: "Service crashed during startup". Detail: "FLT process (PID {pid}) exited with code {code} while waiting for ready." Terminal: last 20 lines stderr. [View Logs] [Retry from Step 4] [Cancel] | DEPLOY-140 (retry from 4), DEPLOY-190 (cancel) |
| DEPLOY-158 | Step 5 failed: partial startup | Some endpoints respond but /health returns degraded | Step 5 circle: amber ◆. Label: "Service partially ready". Detail: "Health endpoint reports degraded: {reason}. Some features may not work." [Accept & Continue] [Wait More] [Cancel]. Accept transitions to Phase 2 with degraded indicator | DEPLOY-200 (accept degraded), DEPLOY-150 (wait), DEPLOY-190 (cancel) |

---

## 3. PIPELINE CANCEL & ROLLBACK

### 3.1 Cancel Flow

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-190 | Cancel requested | Click [Cancel] at any step, or press Escape → confirm | If step 1: immediate cancel, no rollback. If step 2+: cancel dialog: "Cancel deployment? Patches will be reverted." [Cancel Deploy] (red) [Continue Deploy]. Escape from dialog = continue | DEPLOY-191, DEPLOY-100 (continue) |
| DEPLOY-191 | Cancel: during step 1 | Cancel while fetching token | Immediate stop. Token request aborted. Progress resets. Terminal: "[HH:MM:SS] ✕ Deploy cancelled by user". Button reverts: [▶ Deploy to this Lakehouse]. Toast: "Deploy cancelled" | DEPLOY-002 |
| DEPLOY-192 | Cancel: during step 2 | Cancel while patching | Patch operation halted. Rollback starts: "Reverting {n} patched files..." Terminal shows each file being reverted. Progress bar: amber, moving backward animation | DEPLOY-196, DEPLOY-197 |
| DEPLOY-193 | Cancel: during step 3 | Cancel while building | Build process killed (SIGTERM). Then rollback patches. Terminal: "[HH:MM:SS] Build cancelled. Reverting patches..." | DEPLOY-196, DEPLOY-197 |
| DEPLOY-194 | Cancel: during step 4 | Cancel while launching | Service process killed. Then rollback patches. Terminal: "[HH:MM:SS] Service stopped (PID {pid}). Reverting patches..." | DEPLOY-196, DEPLOY-197 |
| DEPLOY-195 | Cancel: during step 5 | Cancel while health-checking | Service process killed. Then rollback patches. Same as DEPLOY-194 | DEPLOY-196, DEPLOY-197 |
| DEPLOY-196 | Cancel: rollback succeeded | All patched files reverted successfully | All step circles reset to gray. Progress bar: 0%. Terminal: "[HH:MM:SS] ✓ Rollback complete — all files restored". Button reverts. Toast: "Deploy cancelled — all changes reverted" | DEPLOY-002 |
| DEPLOY-197 | Cancel: rollback failed | Could not revert one or more files | Error card: "Deploy cancelled but rollback incomplete. These files need manual cleanup:" + file list with paths. [Open Folder] [Copy Paths] [Dismiss]. Warning banner persists (same as DEPLOY-045) | DEPLOY-045 |

### 3.2 Retry from Failed Step

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-180 | Retry step N | Click [Retry] on a failed step | Failed step circle resets to accent + pulse. Steps before it keep green ✓. Pipeline resumes from the failed step, not from step 1. Terminal: "[HH:MM:SS] Retrying step {n}..." Progress bar resumes from the step's starting percentage | DEPLOY-1N0 (step N starting) |
| DEPLOY-181 | Retry with force | Click [Force Re-patch] on step 2 conflict | Step 2 retries with `--force` flag: overwrites conflicted files entirely with EDOG template instead of trying to merge. Terminal: "[HH:MM:SS] Force re-patching (overwrite mode)..." | DEPLOY-120 |
| DEPLOY-182 | Retry with kill | Click [Kill & Retry] on step 4 port conflict | Blocking process killed first. Terminal: "[HH:MM:SS] Killed process {pid}". Then step 4 retries | DEPLOY-140 |
| DEPLOY-183 | Retry with extended timeout | Click [Retry with Extended Timeout] on step 3 timeout | Build restarts with 600s timeout. Label shows "(extended timeout)". Terminal: "[HH:MM:SS] Retrying build with 10m timeout..." | DEPLOY-130 |
| DEPLOY-184 | Retry count limit | Same step has failed 3 times | After 3rd failure, [Retry] button label changes to "Retry (attempt 4)" with amber text. After 5th failure: "Retry (attempt 6) — consider checking logs" and hint text appears: "This step has failed {n} times. There may be a persistent issue." | DEPLOY-1N0 |

---

## 4. POST-DEPLOY: PHASE 2 TRANSITION

### 4.1 Success Transition

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-200 | Deploy complete | Step 5 returns healthy (or user accepted degraded) | All 5 step circles: green ✓. Progress: 100% with green pulse. Large label: "Deployed successfully" (accent, bold). Terminal: final summary: "Deployed to {lakehouse} in {elapsed}s". Deploy stepper begins fade-out after 3s | DEPLOY-201 |
| DEPLOY-201 | Phase 2 transition animation | 1s after deploy complete | Coordinated animation sequence (total ~1.5s): 1) Top bar status badge: gray → amber flash → green "Running 0m01s" (slide-in). 2) MWC token countdown appears next to bearer countdown. 3) Sidebar icons cascade-enable: Logs (200ms) → DAG (400ms) → Spark (600ms) — each icon: grayscale → color + subtle scale bounce. 4) Deploy stepper fades out (300ms), replaced by "Connected to {lakehouse}" banner with green left-border. 5) [▶ Deploy] button label changes to [⟳ Re-deploy] | DEPLOY-202 |
| DEPLOY-202 | Phase 2 active (steady state) | Transition complete | Content panel: lakehouse header unchanged but gains green "● Connected" badge. Deploy button: [⟳ Re-deploy] + [■ Stop] (ghost) button pair. Top bar: green status with uptime counter (ticks every second: "Running 1m 23s"). Sidebar: all tabs enabled and ready. MWC token countdown running | DEPLOY-210+, DEPLOY-020 (re-deploy), DEPLOY-250 (stop) |
| DEPLOY-203 | Phase 2 active (degraded) | User accepted degraded service (DEPLOY-158) | Same as DEPLOY-202 but: status badge is amber "● Degraded" instead of green. Tooltip on badge: "{reason}". Top bar: amber status. Periodic health re-check every 30s — if service recovers, silently transition to DEPLOY-202 | DEPLOY-202 (recovery), DEPLOY-210+ |
| DEPLOY-204 | First-run Phase 2 hint | First time user reaches Phase 2 (localStorage flag) | One-time callout pointing to sidebar: "Logs, DAG, and Spark views are now active →" with dismiss [✕]. Arrow animation pointing right. Auto-dismiss after 8s | DEPLOY-202 |

### 4.2 Running Service Monitoring

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-210 | Service healthy | Health check (background, every 30s) returns 200 | Top bar: green dot + "Running {uptime}". No user interruption. Status dot has subtle breathe animation (opacity 0.7→1.0, 3s cycle) | DEPLOY-211, DEPLOY-220 |
| DEPLOY-211 | Service unhealthy | Background health check returns non-200 | Top bar: green → amber transition. Status: "● Unhealthy ({code})" with pulse. Toast: "Service health check failed: HTTP {code}". Auto-retry every 10s. If 3 consecutive failures → DEPLOY-212 | DEPLOY-210 (recovery), DEPLOY-212 |
| DEPLOY-212 | Service unresponsive | 3 consecutive health check failures | Top bar: amber → red. Status: "● Unresponsive" with fast pulse. Banner in content panel: "FLT service is not responding. It may have crashed." [Check Logs] [Restart Service] [Stop & Undeploy] | DEPLOY-220, DEPLOY-100 (restart), DEPLOY-250 (stop) |

### 4.3 Service Crash Recovery

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-220 | Service crashed | FLT process exits unexpectedly (exit code != 0) | Immediate transition — no waiting for health check. Top bar: red "● Crashed" with fast pulse. Content panel: inline error card: "FLT service crashed (exit code {code})." + last 10 lines stderr. [Restart] [View Full Logs] [Undeploy]. Sidebar Logs/DAG/Spark icons: color → grayscale + red dot overlay | DEPLOY-221, DEPLOY-100 (restart), DEPLOY-250 (undeploy) |
| DEPLOY-221 | Crash: restart requested | User clicks [Restart] | Quick restart: skip steps 1-2 (token still valid, patches still applied). Only steps 3-4-5 re-run. Stepper re-appears with steps 1-2 pre-checked, step 3 active. Label: "Restarting service..." | DEPLOY-130 (step 3) |
| DEPLOY-222 | Crash: auto-restart (optional) | Config has `auto_restart: true` in edog-config.json | Toast: "Service crashed — auto-restarting in 5s..." with countdown. [Cancel Auto-restart]. If cancelled: stays at DEPLOY-220. If not cancelled: triggers DEPLOY-221 after 5s. Max 3 auto-restarts, then stops: "Auto-restart limit reached" | DEPLOY-221 (auto), DEPLOY-220 (cancel/limit) |
| DEPLOY-223 | Crash: repeated | Service crashes 3+ times in 5 minutes | After 3rd crash, error card changes: "Service has crashed {n} times in {elapsed}. This may indicate a persistent issue." [View Crash Patterns] [Undeploy] link instead of simple [Restart]. Auto-restart disabled | DEPLOY-250 (undeploy) |

### 4.4 Token Lifecycle During Phase 2

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-230 | MWC token healthy | MWC token has >10 min remaining | MWC token chip in top bar: green dot + countdown. Service continues normally | DEPLOY-231 |
| DEPLOY-231 | MWC token expiring | MWC token <10 min remaining | MWC token chip: amber dot + countdown. Background: silent refresh triggered (fetch new MWC using bearer token). If refresh succeeds: seamless → DEPLOY-230. If bearer also expired: chain → bearer refresh → MWC refresh | DEPLOY-230 (refreshed), DEPLOY-232 |
| DEPLOY-232 | MWC token refresh failed | Silent MWC refresh fails (capacity down, bearer expired + CBA failed) | MWC token chip: red dot + "Expired". Top banner: "MWC token expired — service will lose access to lakehouse APIs." [Refresh Token] [Continue Without]. If Continue: service runs but FLT API calls will fail with 401 | DEPLOY-230 (manual refresh), DEPLOY-233 |
| DEPLOY-233 | MWC token expired (service running) | MWC TTL reaches 0, refresh failed | Token chip: red "● Expired". Service still runs but API calls to lakehouse will fail. Toast: "MWC token expired. FLT service is running but lakehouse operations will fail." [Re-authenticate & Refresh] | DEPLOY-230 (re-auth chain success) |

---

## 5. UNDEPLOY (EXPLICIT STOP)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-250 | Undeploy requested | Click [■ Stop] button, or top bar "Stop Service" context menu, or Ctrl+Shift+S | Confirmation: "Stop FLT service and revert patches?" Uptime shown: "Running for {uptime}". [Stop & Revert] (red) [Cancel] | DEPLOY-040 (confirmed), DEPLOY-202 (cancelled) |
| DEPLOY-251 | Undeploy in progress | Confirmed | Same flow as DEPLOY-040 through DEPLOY-042. Top bar: amber "Stopping..." | DEPLOY-042 |
| DEPLOY-252 | Undeploy complete | Process stopped + patches reverted | Full Phase 1 restoration. All Phase 2 UI elements transition back: sidebar icons dim (reverse cascade), top bar → gray "Disconnected", MWC countdown removed, uptime counter stops. Deploy button: [▶ Deploy to this Lakehouse]. Toast: "Service stopped. Returned to browse mode." Content panel: lakehouse header loses "● Connected" badge | DEPLOY-002 |

---

## 6. CONCURRENT & RE-DEPLOY SCENARIOS

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-260 | Deploy while deploying | User somehow triggers deploy while pipeline is active (shouldn't happen — button is disabled) | No-op. Button already shows "Deploying..." disabled. If triggered via API/shortcut: toast: "Deploy already in progress" | DEPLOY-100 (current) |
| DEPLOY-261 | Re-deploy (Phase 2) | Click [⟳ Re-deploy] while service running | Confirmation dialog (DEPLOY-020). If confirmed: DEPLOY-040 (undeploy) → DEPLOY-100 (fresh pipeline). Stepper shows full 5 steps again | DEPLOY-040 → DEPLOY-100 |
| DEPLOY-262 | Switch target (Phase 2) | Select different lakehouse + click Deploy | Switch dialog (DEPLOY-030). If confirmed: current service stopped → undeploy → new deploy. Two-phase: undeploy progress → then deploy progress. Stepper shows: "Stopping current → Deploying new" | DEPLOY-040 → DEPLOY-100 |
| DEPLOY-263 | Another user same lakehouse | Concurrent deploy detected (file lock on lakehouse config) | Warning during step 2: "Another EDOG instance may be deploying to this lakehouse (lock file found, PID {pid})." [Continue Anyway] [Cancel]. No hard block — lakehouses are user-local | DEPLOY-120 (continue), DEPLOY-190 (cancel) |
| DEPLOY-264 | Stale config detected | edog-config.json changed externally between step 1 and step 2 | Warning toast: "Config file changed since deploy started. Using original values." No block — deploy uses in-memory config snapshot from step 1 start | DEPLOY-120 |

---

## 7. NETWORK & EDGE CASES

### 7.1 Network Failures

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-270 | Network drops: step 1 | Network lost during token fetch | Step 1 fails with DEPLOY-115 (network error). [Retry] available. No rollback needed | DEPLOY-115 |
| DEPLOY-271 | Network drops: step 2 | Network lost during patch (local operation) | No effect — patching is local disk I/O. Step continues normally. Network loss only affects terminal output streaming to browser | DEPLOY-125 |
| DEPLOY-272 | Network drops: step 3 | Network lost during build | Build continues (local operation). If NuGet restore needed: fails → DEPLOY-137. If already restored: build completes locally | DEPLOY-135, DEPLOY-137 |
| DEPLOY-273 | Network drops: step 4 | Network lost during launch | Launch is local — continues normally. WebSocket to browser may disconnect: reconnect banner appears | DEPLOY-145 |
| DEPLOY-274 | Network drops: step 5 | Network lost during health check | Health check pings are localhost → still works. Browser WebSocket may disconnect. If WS lost: "Connection to EDOG server lost. Reconnecting..." overlay. Deploy continues on server side | DEPLOY-155, DEPLOY-280 |
| DEPLOY-275 | Network restored mid-deploy | Connection returns during pipeline | Auto-reconnect WebSocket. Terminal output catches up (server buffers last 500 lines). Progress bar syncs to actual step. Toast: "Connection restored — deploy still in progress" | Current step |

### 7.2 Browser & Session Edge Cases

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| DEPLOY-280 | Browser closed during deploy | User closes tab/browser mid-pipeline | Deploy continues server-side (edog.py manages the pipeline, not the browser). On re-open: browser queries /api/deploy/status. If still running: stepper resumes at current step with progress. If completed: shows success state. If failed: shows error state | DEPLOY-100 (resume), DEPLOY-200 (completed), DEPLOY-1N2+ (failed) |
| DEPLOY-281 | Browser re-open: deploy running | Page load while deploy is active on server | Stepper appears at current step. Previous steps show green ✓. Terminal catches up with buffered output (last 100 lines). [Cancel] available. Smooth fade-in of stepper at correct state | DEPLOY-1N0 (current step) |
| DEPLOY-282 | Browser re-open: deploy completed | Page load after deploy finished while tab was closed | Phase 2 active state. Brief "Deploy completed while you were away — service running for {uptime}" info toast. All Phase 2 UI elements already in correct state | DEPLOY-202 |
| DEPLOY-283 | Browser re-open: deploy failed | Page load after deploy failed while tab was closed | Error state for the failed step. "[Deploy failed at step {n} while you were away] {error}" banner. [Retry] [Dismiss] available | DEPLOY-1N2+ (error state) |
| DEPLOY-284 | Multiple browser tabs | Second tab opened while deploy running in first | Second tab sees same state via /api/deploy/status. Both tabs update in real-time via WebSocket. Actions (cancel, retry) work from either tab — no conflicts | DEPLOY-100 (synced) |
| DEPLOY-285 | Capacity goes offline mid-pipeline | Capacity reachable at step 1 but goes down before step 5 | Step 5 health check may still pass (service is local). If service depends on capacity for startup: step 5 returns degraded → DEPLOY-158. MWC token already acquired — service can run but lakehouse calls may fail | DEPLOY-155, DEPLOY-158 |

---

## 8. TOP BAR INTEGRATION

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TOPBAR-D01 | Pre-deploy | Phase 1, no deploy active | Service status area: gray dot + "Disconnected". No uptime. No MWC token chip. Clicking status area: tooltip "Deploy to a lakehouse to connect" | — |
| TOPBAR-D02 | Deploying | Pipeline active | Status: amber dot + pulse + "Deploying..." text with step indicator "({n}/5)". Clicking: scrolls to deploy stepper if not visible. MWC token chip: hidden until step 1 succeeds | — |
| TOPBAR-D03 | Deploy step detail | Each step transition | Status text updates: "Deploying (1/5)..." → "Deploying (2/5)..." etc. Subtle text transition (crossfade 150ms) | — |
| TOPBAR-D04 | Deploy complete | Service ready | Status: green dot + "Running {uptime}". Uptime ticks every second. MWC token chip: green + countdown. Click status: dropdown with PID, uptime, lakehouse name, [Stop] [Restart] | — |
| TOPBAR-D05 | Deploy failed | Any step fails | Status: red dot + "Deploy Failed". Click: scrolls to error in content panel. Persists until dismissed or new deploy attempted | — |
| TOPBAR-D06 | Service degraded | Degraded health (DEPLOY-203) | Status: amber dot + "Degraded {uptime}". Tooltip: degradation reason. Click: same dropdown as TOPBAR-D04 with additional "Health: Degraded" line | — |
| TOPBAR-D07 | Service crashed | Process exited unexpectedly | Status: red dot + fast pulse + "Crashed". Click: scrolls to crash card in content panel. Persists until restart or undeploy | — |
| TOPBAR-D08 | Undeploy in progress | Stopping service | Status: amber dot + "Stopping..." No uptime counter. No click action | — |

---

## 9. BUILD OUTPUT TERMINAL

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TERM-001 | Terminal hidden | Deploy not started or stepper collapsed | No terminal visible. Content panel shows normal lakehouse content | TERM-002 |
| TERM-002 | Terminal visible | Deploy starts or user clicks "Show details ▾" | Dark terminal area (oklch(15% 0 0)): monospace font, 12px, line-height 1.4. Max-height 200px, scrollable. Header: "BUILD OUTPUT" label + [Copy All] + [Clear] + "Hide details ▴" link. Scrollbar: thin, accent-colored | TERM-003 |
| TERM-003 | Terminal streaming | Build output arriving | Lines append with slide-in animation (50ms). Auto-scroll locked to bottom. Each line: `[HH:MM:SS] content`. Colors: default (var(--text-1)), warnings (oklch(80% 0.15 85)), errors (oklch(70% 0.2 25)), success (oklch(75% 0.15 145)) | TERM-004, TERM-005 |
| TERM-004 | Terminal scroll unlocked | User scrolls up during output | Auto-scroll pauses. Chip: "↓ New output below" fixed at bottom of terminal. Badge shows count of new lines since scroll. Click chip: scroll to bottom + re-engage auto-scroll | TERM-003 |
| TERM-005 | Terminal complete | Pipeline finishes (success or fail) | Final summary line: "✓ Deploy complete in {elapsed}s" or "✕ Deploy failed at step {n}". No more streaming. Terminal remains visible for review. [Copy All] copies full log | TERM-002 |
| TERM-006 | Terminal copy | Click [Copy All] | All terminal content copied to clipboard. Toast: "Build output copied ({n} lines)". Button briefly shows "Copied ✓" (2s) | TERM-002 |
| TERM-007 | Terminal resize | Drag resize handle at bottom edge | Terminal height changes (100px min, 600px max). Cursor: ns-resize during drag. Height persisted to localStorage | TERM-002 |

---

## 10. FILE CHANGE BANNER

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| BANNER-001 | Files being patched | Step 2 starts modifying files | Slide-in banner below stepper: "Modifying files:" + file chips (e.g., "EdogLogInterceptor.cs", "EdogApiProxy.cs"). Each chip has file icon. Banner has subtle amber left-border | BANNER-002 |
| BANNER-002 | Files patched | Step 2 complete | Banner updates: amber → green left-border. "Modified {n} files" + chips. Persists through build + launch steps as context | BANNER-003, BANNER-004 |
| BANNER-003 | Files reverted (cancel/undeploy) | Rollback restores originals | Banner: "Reverted {n} files" + green check per chip. Fades out after 3s | — |
| BANNER-004 | Files revert failed | Rollback couldn't restore some files | Banner: red left-border. "Could not revert:" + red-highlighted file chips. [Open Folder] [Copy Paths] persist until dismissed | — |

---

## 11. KEYBOARD & ACCESSIBILITY

### 11.1 Keyboard Shortcuts (F02-specific)

| Key | Action | Context |
|-----|--------|---------|
| `Enter` | Start deploy | Deploy button focused |
| `Escape` | Cancel confirmation | During deploy pipeline |
| `Escape` (in dialog) | Dismiss confirmation dialog | Re-deploy / switch dialog |
| `Ctrl+Shift+D` | Quick deploy to last-used lakehouse | Global (not in input) |
| `Ctrl+Shift+S` | Stop/undeploy service | Global, Phase 2 only |
| `Ctrl+Shift+R` | Restart service (re-deploy) | Global, Phase 2 only |
| `r` | Retry failed step | Deploy failed, focus on stepper |
| `c` | Copy terminal output | Terminal focused |
| `End` | Scroll terminal to bottom + re-engage auto-scroll | Terminal focused |

### 11.2 Screen Reader Announcements

| Event | Announcement |
|-------|-------------|
| Deploy button focused | "Deploy to this Lakehouse. Patches, builds, and launches the FLT service." |
| Deploy started | "Deployment started. Step 1 of 5, fetching MWC token." |
| Step N started | "Deploy step {n} of 5: {step label}." |
| Step N succeeded | "Step {n} complete: {step label}. Moving to step {n+1}." |
| Step N failed | "Step {n} failed: {error summary}. Retry and cancel buttons available." |
| Deploy complete | "Deployment complete. FLT service is running and connected to {lakehouse}." |
| Deploy cancelled | "Deployment cancelled. All changes reverted." |
| Cancel confirmation | "Cancel deployment? Patches will be reverted. Confirm or continue buttons available." |
| Re-deploy confirmation | "Already deployed. Re-deploy will restart the service. Confirm or cancel." |
| Switch confirmation | "Switch deployment from {current} to {new}. Current service will be stopped." |
| Service crashed | "Alert: FLT service has crashed. Restart and undeploy options available." |
| Token expiring | "Warning: MWC token expires in {time}." |
| Undeploy complete | "Service stopped. Returned to browse mode." |
| Terminal output | Live region: new lines announced at reduced verbosity (every 5th line or on error/warning) |
| Retry step | "Retrying step {n} of 5: {step label}." |
| Phase 2 active | "FLT service connected. Logs, DAG, and Spark views are now available." |

### 11.3 Focus Management

| Event | Focus Moves To |
|-------|---------------|
| Deploy button clicked | First [Cancel] button in stepper |
| Step fails | [Retry] button for that step |
| Deploy complete | "Connected to {lakehouse}" banner (then user can Tab to sidebar) |
| Cancel confirmed | [▶ Deploy] button |
| Dialog opens (re-deploy/switch) | First action button in dialog |
| Dialog dismissed | Deploy button |
| Service crash banner | [Restart] button |

---

## 12. ANIMATION TIMING REFERENCE (F02-specific)

| Animation | Duration | Easing | Use |
|-----------|----------|--------|-----|
| Stepper appear | 300ms | ease-out | Deploy container slide-in |
| Step circle pulse | 1.5s cycle | ease-in-out | Active step indicator |
| Step circle succeed | 300ms | cubic-bezier(0.34,1.56,0.64,1) | Green ✓ pop with overshoot |
| Step circle fail | 200ms | ease-out | Red ✕ appear |
| Progress bar fill | 500ms per segment | ease-out | 0→20→40→60→80→100% transitions |
| Progress bar pulse | 2s cycle | ease-in-out | Indeterminate shimmer within range |
| Progress bar error | 300ms | ease | Green/amber → red color transition |
| Terminal slide-in | 250ms | ease-out | Show/hide details |
| Terminal line append | 50ms | ease-out | New line slide-in from left |
| Phase 2 sidebar cascade | 200ms per icon, 200ms stagger | ease-out | Logs → DAG → Spark enable |
| Phase 2 status transition | 400ms | ease | Gray → amber → green badge |
| File banner slide-in | 200ms | ease-out | Patch notification |
| Cancel dialog appear | 150ms | cubic-bezier(0.34,1.56,0.64,1) | Scale from button origin |
| Cancel dialog dismiss | 100ms | ease-in | Fade out |
| Crash banner | 200ms | ease-out | Slide-in from top |
| Uptime counter tick | 0ms | instant | Number update (no animation) |
| Token countdown tick | 0ms | instant | Number update |
| Ping dots cycle | 500ms per dot | linear | ●○○ → ○●○ → ○○● health check |
| Deploy complete pulse | 1s, once | ease-out | Progress bar green pulse on 100% |
| Degraded badge pulse | 2s cycle | ease-in-out | Amber pulse on degraded status |
| Crash badge pulse | 800ms cycle | ease-in-out | Red fast pulse |

---

## 13. RESPONSIVE BEHAVIOR

| Breakpoint | Layout Change |
|------------|--------------|
| >1400px | Stepper: full horizontal 5-step layout. Terminal: 200px max. Side-by-side stepper + cancel button |
| 1000-1400px | Stepper: compact — circles + abbreviated labels. Terminal: 150px max. Cancel button below stepper |
| <1000px | Stepper: vertical stack (step circle + label per row). Terminal: full-width, 200px max. Cancel button at bottom |
| <768px | Not supported — same message as F01 |

---

## 14. STATE FLOW DIAGRAMS (Text)

### 14.1 Happy Path
```
DEPLOY-002 (button visible)
  → DEPLOY-010 (pre-flight)
  → DEPLOY-100 (pipeline started)
  → DEPLOY-110 → DEPLOY-111 (step 1 ✓)
  → DEPLOY-120 → DEPLOY-125 (step 2 ✓)
  → DEPLOY-130 → DEPLOY-135 (step 3 ✓)
  → DEPLOY-140 → DEPLOY-145 (step 4 ✓)
  → DEPLOY-150 → DEPLOY-155 (step 5 ✓)
  → DEPLOY-200 (complete)
  → DEPLOY-201 (Phase 2 transition)
  → DEPLOY-202 (steady state)
```

### 14.2 Failure + Retry
```
DEPLOY-002 → DEPLOY-010 → DEPLOY-100
  → DEPLOY-110 → DEPLOY-111 (step 1 ✓)
  → DEPLOY-120 → DEPLOY-125 (step 2 ✓)
  → DEPLOY-130 → DEPLOY-136 (build failed!)
  → DEPLOY-180 (retry step 3)
  → DEPLOY-130 → DEPLOY-135 (step 3 ✓ on retry)
  → DEPLOY-140 → ...
```

### 14.3 Cancel + Rollback
```
DEPLOY-100 → DEPLOY-110 → DEPLOY-111 (step 1 ✓)
  → DEPLOY-120 → ... user presses Escape
  → DEPLOY-190 (cancel requested)
  → DEPLOY-192 (cancel during step 2)
  → DEPLOY-196 (rollback succeeded)
  → DEPLOY-002 (back to ready)
```

### 14.4 Switch Deployment
```
DEPLOY-202 (running, lakehouse A)
  → user selects lakehouse B → DEPLOY-030 (switch dialog)
  → DEPLOY-040 (undeploy A) → DEPLOY-042 (undeploy done)
  → DEPLOY-100 (deploy B) → ... → DEPLOY-202 (running, lakehouse B)
```

### 14.5 Crash + Auto-Restart
```
DEPLOY-202 (running) → DEPLOY-220 (crash detected)
  → DEPLOY-222 (auto-restart countdown)
  → DEPLOY-221 (restart: steps 3-4-5)
  → DEPLOY-130 → ... → DEPLOY-202 (recovered)
```

---

*"120+ states. Every step, every failure, every edge case. The deploy button is 5 steps and 120 ways it can go."*

— F02 Deploy to Lakehouse UX Specification
