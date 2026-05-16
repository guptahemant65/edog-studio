# C04 — Build & Patch State: Component Deep Spec

> **Component:** BuildPatchStateCard (Environment Panel Card 4)  
> **Feature:** F11 — Environment Panel  
> **Owner:** Sana (architecture) + Vex (Python API) + Pixel (card rendering)  
> **Complexity:** MEDIUM  
> **Depends On:** P0 foundation research §4, existing repo discovery, existing EDOG patch/revert plumbing  
> **Status:** P1 — DRAFT

---

## 1. Overview

BuildPatchStateCard is the Environment Panel's local-source truth card. P0 research defines Card 4 as **Build & Patch** and anchors its core payload to local FLT git state, EDOG patch metadata, dirty-file counts, and patch warnings (`docs/specs/features/F11-environment-panel/research/p0-foundation.md:47-60`). This card answers one operational question: "what FLT source tree am I looking at, and what did EDOG change to make DevMode work?"

This component is explicitly disconnected-safe. P0 states that Card 4 has full data pre-deploy because all of it is local-disk-derived (`docs/specs/features/F11-environment-panel/research/p0-foundation.md:314-321`). That means it must not depend on FLT process health, DevConnection, SignalR, or MWC token state. If EDOG Studio can locate the FLT repo, the card can render branch, commit, dirty state, in-flight patches, build metadata from the last local build, and any patch warnings captured during the last deploy attempt.

Architecturally, C04 is a boundary card between EDOG's reversible DevMode mutations and the developer's own source work. P0 already separates non-EDOG dirty files from EDOG-managed dirty files (`p0-foundation.md:55-58`), and `repo_discovery.validate_repo()` implements that split by parsing `git status --porcelain -uall`, comparing paths to `_edog_patched_paths()`, and returning `gitDirty`, `gitDirtyEdog`, and `gitDirtyTotal` (`scripts/repo_discovery.py:101-160`). The UI must preserve that separation; collapsing everything into one "dirty" badge would hide exactly the risk this card exists to expose.

---

## 2. Data Model

The card consumes one backend-owned projection:

```typescript
interface BuildPatchState {
  repo: {
    path: string;
    branch: string;
    sha: string;
    subject: string;
    isDirty: boolean;
    dirtyFiles?: DirtyFile[];
  };
  patches: AppliedPatch[];
  lastBuild: null | {
    ts: string;
    durationMs: number;
    sdkVersion: string;
    success: boolean;
  };
  warnings: PatchWarning[];
}
```

`repo.branch` is already available through `validate_repo()` and `/api/edog/health` (`p0-foundation.md:52`, `scripts/dev-server.py:3448-3495`). `repo.sha` and `repo.subject` close the P0 gap that FLT SHA was not collected (`p0-foundation.md:51`) by reusing existing commit capture: `_capture_git_head()` runs `git log -1 --pretty=format:%H%n%an%n%s%n%cI` and returns `commitSha` plus `commitMessage` (`scripts/dev-server.py:239-268`). `repo.isDirty` is true when `gitDirtyTotal > 0`; `dirtyFiles` is included only when the card is expanded or when dirty state exists, to avoid shipping a path list for the common clean case.

`AppliedPatch` describes EDOG-owned mutations, not arbitrary git changes:

```typescript
interface AppliedPatch {
  id: string;
  label: string;
  kind: 'source-edit' | 'created-devmode-file' | 'config-rewrite' | 'package-reference';
  status: 'applied' | 'missing' | 'partial' | 'clean';
  files: string[];
  source: 'patch-file' | 'status-scan';
}
```

The authoritative set comes from two existing mechanisms. First, `.edog-changes.patch` exists as `EDOG_PATCH_FILE` (`scripts/repo_discovery.py:24-26`), and `_edog_patched_paths()` parses `diff --git a/...` lines to identify patched FLT files (`scripts/repo_discovery.py:29-48`). Second, `edog.py check_status()` already scans specific DevMode markers: GTS token bypass, DevMode log viewer files, Program.cs registration, WorkloadApp telemetry interceptor, and DisableFLTAuth rewrites (`edog.py:2729-2804`). Patches must therefore report both "patch file says these files were edited" and "status scan says these DevMode capabilities are currently present." That distinction matters when a partial revert or manual edit leaves the patch file gone but source markers still present.

`PatchWarning` is the JSON version of the existing warning list:

```typescript
interface PatchWarning {
  id: string;
  severity: 'warning' | 'error';
  message: string;
  patchId?: string;
  file?: string;
}
```

P0 says `patchWarnings` is already wired through `_studio_state["patchWarnings"]` and `/api/edog/patch-warnings` (`p0-foundation.md:59`). The dev server initializes that list in studio state (`scripts/dev-server.py:185-198`), classifies warning lines via `_is_edog_patch_warning()` (`scripts/dev-server.py:174-182`), stores deploy-time warnings after the headless patch/build subprocess exits (`scripts/dev-server.py:1612-1648`), and exposes `warnings`, `count`, and `deployPhase` via `_serve_patch_warnings()` (`scripts/dev-server.py:3290-3308`).

---

## 3. API Surface

### 3.1 `GET /api/edog/repo-state` — NEW

Returns `BuildPatchState`. This endpoint replaces the proposed narrower `GET /api/edog/build-info` shape from P0 (`p0-foundation.md:294-309`) with a single card-specific projection that still includes the same P0 facts: SHA, branch, patch metadata, and last-deploy/build information (`p0-foundation.md:298-309`). It must be served by `scripts/dev-server.py`, because that file already owns `/api/edog/health`, `/api/edog/patch-warnings`, deploy logs, studio phase, and command routing (`scripts/dev-server.py:1884-1894`, `scripts/dev-server.py:2288-2318`).

The endpoint reuses existing plumbing rather than inventing a second repo scanner:

- Repo path and branch: `get_configured_repo()` / `validate_repo()` as used by `_serve_health()` (`scripts/dev-server.py:3456-3495`).
- Commit SHA and subject: `_capture_git_head()` (`scripts/dev-server.py:239-268`).
- Dirty counts and EDOG filtering: `repo_discovery.validate_repo()` and `_edog_patched_paths()` (`scripts/repo_discovery.py:29-48`, `scripts/repo_discovery.py:101-160`).
- Patch warnings: `_studio_state["patchWarnings"]` and `_serve_patch_warnings()` (`scripts/dev-server.py:1612-1648`, `scripts/dev-server.py:3290-3308`).
- Build result: the headless deploy build step currently executes `dotnet build <entrypoint> --no-incremental` and emits "Build succeeded" on success (`edog.py:3127-3169`). The dev server should record successful build timestamp and duration around that subprocess, and collect SDK version once with `dotnet --version`.

Example response:

```json
{
  "repo": {
    "path": "C:\\src\\FabricLiveTable",
    "branch": "user/hemant/edog-devmode",
    "sha": "af3e21c8b7d4",
    "subject": "Add materialized view diagnostics",
    "isDirty": true,
    "dirtyFiles": [
      { "path": "Service/.../WorkloadApp.cs", "owner": "edog", "status": "M" },
      { "path": "Service/.../SomeUserEdit.cs", "owner": "user", "status": "M" }
    ]
  },
  "patches": [
    { "id": "gts-token-bypass", "label": "GTSBasedSparkClient token bypass", "kind": "source-edit", "status": "applied", "files": ["Service/Microsoft.LiveTable.Service/SparkHttp/GTSBasedSparkClient.cs"], "source": "status-scan" }
  ],
  "lastBuild": { "ts": "2025-07-20T18:42:11Z", "durationMs": 84231, "sdkVersion": "8.0.403", "success": true },
  "warnings": []
}
```

### 3.2 Actions

`POST /api/edog/revert-patches` invokes the existing revert path: `python edog.py --revert`. This must call the same function used today by undeploy, where `_serve_undeploy()` runs `[sys.executable, edog.py, "--revert"]` and treats return code `0` as reverted (`scripts/dev-server.py:2590-2627`). `edog.py --revert` is already a documented CLI argument (`edog.py:3378-3395`) and dispatches to `revert_all_changes(repo_root)` (`edog.py:3444-3458`).

`POST /api/edog/open-repo` accepts `{ "target": "vscode" | "explorer" }` and no arbitrary path. The server resolves the configured FLT repo path from config, validates it through the same repo discovery path as `_serve_health()`, then launches either `code <repo>` or Windows Explorer for that repo. This endpoint is intentionally narrow: P0 says the card's facts are local-disk-derived (`p0-foundation.md:321`), and the action target must be that same configured repo, not a user-supplied filesystem escape hatch.

---

## 4. State Machine

```text
loading
  -> loaded-clean
  -> loaded-dirty
  -> loaded-with-warnings
  -> revert-failed

loaded-clean | loaded-dirty | loaded-with-warnings
  -- confirm revert --> reverting

reverting
  -> loading
  -> revert-failed
```

`loading` starts when the Environment Panel opens, when the card is expanded, after a deploy pipeline finishes, after a file watcher change, or after revert completes. `loaded-clean` means no non-EDOG dirty files, no EDOG dirty files, no applied patches, and no warnings. This state corresponds to P0's clean row where dirty non-EDOG is `0` and the mock badge reads clean (`environment-shell.html:1090-1127`).

`loaded-dirty` means `repo.isDirty === true` and warnings are empty. The badge label must distinguish "dirty: user" from "dirty: EDOG" using the `owner` field, because P0 explicitly splits non-EDOG, EDOG, and total dirty counts (`p0-foundation.md:55-58`). `loaded-with-warnings` overrides the clean/dirty visual severity when any `PatchWarning` exists, because P0 says patch warnings answer "did all my patches apply?" (`p0-foundation.md:59`) and dev-server warns that inactive interceptors can otherwise look green (`scripts/dev-server.py:3290-3297`).

`reverting` disables all action buttons except canceling the dialog close; the card shows "Reverting EDOG patches..." and streams no optimistic success. `revert-failed` holds the previous `BuildPatchState`, adds the revert error, and forces a refresh button. `edog.py` can report conflict-style partial failure when reverse apply or direct reverts cannot fully clean source (`edog.py:1044-1123`, `edog.py:2617-2726`), so the UI must not assume a failed revert leaves state unchanged.

---

## 5. Scenarios

| ID | Scenario | Mechanism | Source | Edge / Undo | Priority |
|---|---|---|---|---|---|
| C04-S01 | Clean repo, no patches. Shows branch, SHA/subject, clean badge, no warnings. | `GET /api/edog/repo-state`; `gitDirtyTotal = 0`; `patches = []`; `warnings = []`. | P0 branch and dirty fields (`p0-foundation.md:51-59`); health returns branch/dirty counts (`scripts/dev-server.py:3448-3495`). | Revert button disabled with tooltip "No EDOG patches detected." | P0 |
| C04-S02 | Dirty repo, no EDOG patches. User sees "has uncommitted changes" and expandable dirty files. | `git status --porcelain -uall`; dirty entries not in `_edog_patched_paths()` are `owner: "user"`. | Dirty split in P0 (`p0-foundation.md:55-58`); filtering implementation (`scripts/repo_discovery.py:137-148`). | Revert button disabled; EDOG must not discard user changes. | P0 |
| C04-S03 | Clean repo with EDOG patches applied. User sees DevMode patch list and EDOG dirty count. | Status scan detects marker strings and DevMode files; patch file paths fill affected files. | `edog.py check_status()` marker scan (`edog.py:2729-2804`); patch file parse (`scripts/repo_discovery.py:29-48`). | Revert all patches calls `edog.py --revert`. | P0 |
| C04-S04 | Dirty repo with EDOG patches and user edits. Badge shows mixed dirty; dirty list groups `EDOG-managed` and `user`. | Compare porcelain paths to patch file paths and DevMode dirs. | `_is_edog_managed()` includes patch paths and DevMode dirs (`scripts/repo_discovery.py:51-55`). | Confirm copy must warn: "User edits will be preserved where possible; conflicts may require manual resolution." | P0 |
| C04-S05 | Revert in flight. Card prevents duplicate reverts and refreshes state after completion. | `POST /api/edog/revert-patches` wraps existing `edog.py --revert` subprocess. | Existing undeploy revert subprocess (`scripts/dev-server.py:2609-2627`); CLI dispatch (`edog.py:3378-3458`). | On success, reload `repo-state`; on failure, enter `revert-failed`. | P0 |
| C04-S06 | Revert partial-fail. User sees mixed state, conflict message, and exact files if available. | Preserve previous state; re-query git; surface stderr/stdout. | Reverse patch failure modes (`edog.py:1044-1123`); direct revert returns `all_success` (`edog.py:2617-2726`). | Offer "Open in VS Code" and "Show in Explorer" for manual fix. | P0 |

---

## 6. Visual Spec

Card 4 follows the existing Environment Panel card shell from the mock: `.env-card[data-card="build"]`, clickable `.card-header`, chevron, title `Build & Patch`, and right-side status badge (`environment-shell.html:1090-1097`). The body uses the same `kv-table`, `kv-row`, `kv-label`, `kv-value`, and `kv-actions` pattern as the mock rows for FLT SHA, FLT branch, patch hash, and dirty count (`environment-shell.html:1098-1124`). Pixel may alter labels to match the final data model, but not the hierarchy: identity first, patch state second, build state third, warnings and actions last.

Recommended row order:

1. **FLT commit** — short SHA, subject, copy button for full SHA.
2. **FLT branch** — full branch, copy button.
3. **Working tree** — `clean`, `has uncommitted changes`, or `mixed: EDOG + user`.
4. **EDOG patches** — count pill; expandable list of `AppliedPatch` rows.
5. **Last build** — success/fail pill, timestamp, duration, SDK version.
6. **Patch warnings** — hidden when empty; warning panel when non-empty.

The footer action row contains `Revert all patches`, `Open in VS Code`, and `Show in Explorer`. Revert is destructive-adjacent and must be visually secondary until patches exist; when patches exist, it becomes enabled but still requires confirmation. Open actions are convenience buttons and never affect card state. The mock's diagnostic copy action demonstrates the established right-aligned footer action pattern (`environment-shell.html:1125-1127`); C04 reuses that area for the three actions.

---

## 7. Keyboard & Accessibility

The card header is a button-equivalent control with `aria-expanded`, `aria-controls`, and keyboard activation on Enter and Space. Status badge text must not rely on color: use visible strings such as `clean`, `dirty`, `warnings`, or `reverting`. P0's mock uses a badge with text `clean` (`environment-shell.html:1094-1096`); the implemented badge must keep that textual status for screen readers and color-blind users.

`Revert all patches` opens a confirmation dialog before calling the backend. The confirmation copy must mention whether user dirty files exist, because P0 separates non-EDOG dirty files from EDOG-managed dirty files (`p0-foundation.md:55-58`). Default focus starts on Cancel, not Confirm. Confirm has an accessible name like `Revert all EDOG patches`; Escape closes the dialog without side effects.

The dirty file list and patch list are expandable regions with button controls, not clickable divs. Each group announces count, for example `User changes, 3 files` and `EDOG-managed changes, 7 files`. File paths render in monospace, wrap safely, and expose copy buttons with `aria-label="Copy path <path>"`. When warnings exist, focus should not be stolen, but the warning region must be announced politely after refresh.

---

## 8. Error Handling

If git commands fail, `GET /api/edog/repo-state` returns HTTP 200 with partial data and `repo.error`, unless the configured repo itself is invalid. This matches existing tolerance: `validate_repo()` catches git exceptions and still returns a valid repo object with empty git fields (`scripts/repo_discovery.py:114-160`), while `_capture_git_head()` returns `None` when git is unavailable or the command fails (`scripts/dev-server.py:246-269`). The UI renders `unknown commit` and a small inline error instead of failing the whole Environment Panel.

If revert leaves the repo in a mixed state, the card must refresh from disk and show the mixed truth. `apply_patch_reverse()` has explicit conflict and failed-revert messages (`edog.py:1044-1123`), while `revert_all_changes()` attempts each mutation independently and returns `all_success` only after cleanup (`edog.py:2617-2726`). A partial failure is therefore not a modal-only error; it is a new persistent state until the user fixes files or reruns revert.

Patch warnings escalate to card-level warning severity when the deploy pipeline captured `pattern not found` or warning-symbol output. `_is_edog_patch_warning()` treats either signal as a patch warning (`scripts/dev-server.py:174-182`), and `_serve_patch_warnings()` exists because otherwise inactive interceptors can be hidden behind a green deploy (`scripts/dev-server.py:3290-3297`). If a warning maps to a mandatory patch such as DI registration or telemetry interception, the frontend may display severity `error`, but it must preserve the original backend message.

---

## 9. Performance

Repo state is local, but git status can still be expensive in a large FLT checkout. Cache the `BuildPatchState` response for 2 seconds in `dev-server.py`, keyed by repo path plus current `_studio_state["patchWarnings"]` count. This preserves responsiveness while avoiding repeated `git status --porcelain -uall` calls on every render. P0's Card 4 is local-disk-derived (`p0-foundation.md:321`), so a short cache is acceptable as long as explicit refresh bypasses it.

Refresh triggers:

- Environment Panel opens.
- Card expands.
- Deploy pipeline finishes patch/build; dev-server already logs patch/build success and failure (`scripts/dev-server.py:1649-1666`).
- Revert action completes.
- FileWatcher reports changes.

FileWatcher already polls every 3 seconds (`scripts/dev-server.py:207-215`), starts after deploy with `snapshot_deployed()` (`scripts/dev-server.py:218-225`), and exposes changed files through `/api/studio/file-changes` (`scripts/dev-server.py:2320-2326`). C04 should subscribe to the same frontend signal used for file-change UI and invalidate its cache rather than adding another watcher.

---

## 10. Implementation Notes

Vex owns `GET /api/edog/repo-state` in `scripts/dev-server.py`. Implement it next to `_serve_health()` and `_serve_patch_warnings()` so it can reuse config loading, repo validation, studio-state locking, and response helpers (`scripts/dev-server.py:1884-1894`, `scripts/dev-server.py:3448-3495`). Do not move repo logic into frontend code; the browser cannot safely run git, resolve Windows paths, or inspect `.edog-changes.patch`.

Backend extraction should be small and testable:

- `_build_repo_state(repo_info) -> repo` wraps branch, commit, dirty counts, and optional dirty files.
- `_list_applied_patches(repo_path) -> AppliedPatch[]` combines `_edog_patched_paths()` with a JSON-friendly version of `edog.py check_status()`.
- `_get_last_build_state() -> lastBuild | null` reads in-memory deploy/build metadata recorded around headless deploy.
- `_get_patch_warnings() -> PatchWarning[]` maps `_studio_state["patchWarnings"]`.

The existing patch-generation and deploy-log infrastructure remains the source of build and warning truth. `edog.py headless_deploy()` emits JSON progress for patch and build, applies code changes, installs the git hook, runs `dotnet build`, and auto-reverts on build failure (`edog.py:3057-3169`). `generate_patch()` writes `.edog-changes.patch` (`edog.py:985-1041`), `_deploy_log()` appends timestamped deploy log entries (`scripts/dev-server.py:1253-1255`), and the deploy parser captures patch warnings (`scripts/dev-server.py:1612-1666`). C04 exposes that state; it never runs a build, applies a patch, or infers success from UI state.

Pixel owns rendering inside the existing Card 4 shell. Keep the card operational in disconnected mode: no FLT port, no DevConnection, and no MWC token are required. That is not a graceful degradation; it is the contract P0 states for Card 4 (`p0-foundation.md:314-321`).
