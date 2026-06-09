# FLT Branch Switcher — Design Spec

**Date:** 2026-06-09
**Feature:** Change the FLT repo branch from the top bar — safely, searchably, and EDOG-aware.
**Status:** Approved (design). Pending spec review → implementation plan.

---

## 1. Problem

The top-bar branch chip is read-only. It displays `gitBranch`
(`git rev-parse --abbrev-ref HEAD`, surfaced via `validate_repo()` in
`scripts/repo_discovery.py` and rendered at `topbar.js:272`). There is **no**
checkout capability anywhere in the product.

Users want to switch the FLT repo branch from the top bar. The naive
implementation (a dropdown that runs `git checkout`) is a footgun because EDOG
does not sit beside the FLT repo — it lives *inside* the FLT working tree, and a
running FLT is built from a specific branch.

## 2. Grounding (verified against the codebase, not assumed)

- **Branch is read-only today.** `validate_repo()` already computes a *dirty
  split*: `gitDirty` (user files), `gitDirtyEdog` (EDOG-managed files),
  `gitDirtyTotal`. This split is the safety primitive this feature builds on.
- **EDOG patch lifecycle:**
  - **Deploy** (`_run_deploy_pipeline`, dev-server.py:2517) *applies* patches:
    drops `Service/Microsoft.LiveTable.Service/DevMode/` (~40 new `.cs`) and
    patches files like `WorkloadApp.cs`, `Program.cs`, `Test.json`.
  - **Undeploy** (`_serve_undeploy`, dev-server.py:4068) runs
    `edog.py --revert` → restores FLT source to a clean state, phase → `idle`.
  - **Consequence:** at `idle` the tree is normally clean of EDOG patches —
    there is nothing to clobber *pre-deploy*. Revert is **best-effort**
    (dev-server.py:4104), so `crashed`/failed-revert states can leave EDOG
    files dirty.
- **EDOG-patched file set is dynamic.** `_edog_patched_paths()`
  (repo_discovery.py:27) parses `.edog-changes.patch` for the exact files EDOG
  modifies; empty set when the patch file is absent (no deploy yet). This is the
  single source of truth for "EDOG surface" — the predictive check reuses it.
- **Phase signal exists.** `/api/studio/status` reports
  `phase ∈ {idle, deploying, running, stopped, crashed}` (consumed by
  `connection-supervisor.js`, `edog-health-chip.js`, `main.js`). This is the
  detectable lock signal — no new state needed.
- **Git diff plumbing exists.** `/api/edog/git-diff` (dev-server.py:5619)
  already shells git from `repo_path` with a hardened `_run_git` helper and an
  EDOG-ownership classifier. New endpoints follow the same pattern.

## 3. The one rule that makes it safe

**Branch switching is a pre-deploy-only action.**

| Phase | Switcher |
|-------|----------|
| `idle`, `stopped`, `crashed` | **Enabled** |
| `deploying`, `running` | **Disabled** — chip greyed, tooltip: *"Stop the running environment to change branch."* |

Enforced **twice** (defense in depth):
- **Client:** disables the control based on `studioStatus.phase`.
- **Server:** `POST /api/edog/git-checkout` re-checks phase and returns `409`
  if `deploying`/`running`. The client check is UX; the server check is truth.

## 4. UI (top bar — Pixel)

The existing `git-branch-name` chip becomes a click target opening a popover.
Visuals follow the design bible and existing chip tokens — no new visual
language, no emoji (Unicode marks / inline SVG only).

**Popover contents:**
- **Search box** at top — filters as you type (branch counts can be high).
- **Local branches** by default, current marked, ordered `-committerdate`
  (recent first).
- **Rich rows (enhancement A):** each row shows last-commit subject, relative
  time, author, and **ahead/behind** vs the current branch. Sourced from a
  single `git for-each-ref --format=...` call (no N+1 git invocations).
- **"Fetch remote branches"** action — on demand only, never auto-fetch on
  open. After fetch, remotes join the same searchable list (section header).
- **Out of scope:** create-branch, per-branch environment memory.

## 5. The switch flow

On selecting a target branch:

1. Server inspects the dirty split (`validate_repo`).
2. **EDOG-managed dirty files** → carried automatically; *not* part of the
   user prompt (branch-agnostic tooling artifacts). **Edge case
   (enhancement #2):** if EDOG files are dirty at `idle`/`crashed` (failed/no
   revert), surface a non-blocking hazard note — see §6.
3. **User (non-EDOG) changes exist** → **prompt**:
   `Stash` / `Carry` / `Discard` / `Cancel`.
4. `git checkout <branch>`. On conflict/failure → **abort cleanly**, working
   tree untouched, surface the real git error. No partial state.
5. On success: refresh branch chip + dirty badge + git-diff modal; show a
   confirmation toast.

### Stash mechanism

Use native `git stash` (reversible, clean) over a temp-commit hack.

**Enhancement E — named, recoverable stash:** when the user chooses `Stash`,
create it with a descriptive message
`edog-switch/<from>-><to>/<iso-timestamp>` and return the stash ref in the
response. The confirmation toast shows a **"stashed — restore"** link that pops
that specific stash. (Auto-restore-on-return is out of scope; per-branch memory
is off.)

## 6. EDOG-aware dimensions

### #2 — Don't-lose-work safety

On the branch being **left**, surface in the confirmation step:
- **N unpushed commits** — `git rev-list --count @{u}..HEAD`
  (0 / no upstream → omit).
- **N stashes** — `git stash list` count.
- **EDOG files still dirty** — from the dirty split; a one-line hazard note
  ("EDOG patch files are dirty from a prior session — they'll be carried")
  covering the failed-revert / `crashed` edge case.

These are informational and never block the switch; they prevent silent
abandonment of work.

### #1 (predictive) — patch-surface friction

Pre-deploy there are no in-tree EDOG patches to protect (see §2), so the value
is **predictive**: will EDOG's patch apply cleanly when the user *next* deploys
on the target branch?

- Compute `git diff --name-only <current> <target> -- <edog-patched-paths>`
  where the path set comes from `_edog_patched_paths()`.
- If non-empty, mark the row / confirmation with **"⚠ touches EDOG patch
  surface"** plus the file list, warning that the next deploy's patch step may
  need attention on this branch.
- **Degrades to no-op** when `.edog-changes.patch` is absent (never deployed) —
  empty set, no warning. No speculation, no false alarms.

### #4 — PR / review context (GATED, not designed blind)

Showing each branch's open PR + review state is a genuinely different
(collaboration) axis. But `workload-fabriclivetable` is hosted on Azure DevOps,
not necessarily GitHub — the API contract is **unverified**. Per project
discipline (the lakehouse-contract lesson), this is **gated behind a spike**:
verify host + auth + the "branch → PR + review state" query against the real
repo *before* any UI is designed. Not in the first implementation slice.

## 7. Server endpoints (Vex — dev-server.py)

Both follow the existing `_run_git` / `get_configured_repo` pattern; all git
calls best-effort with timeouts; invalid/no-git repo degrades gracefully.

### `GET /api/edog/git-branches?remote=0|1`
```
200 {
  configured, valid, detached: bool,
  current: "<branch>",
  local:  [ { name, subject, author, relativeDate, ahead, behind,
              touchesEdogSurface: bool, edogSurfaceFiles: [..] } ],
  remote: [ ... ]            // only when remote=1 (runs `git fetch` first)
}
```
- `local` always returned; `remote=1` triggers a fetch then lists remotes.
- ahead/behind computed vs `current`.
- `touchesEdogSurface` precomputed server-side (#1 predictive).

### `POST /api/edog/git-checkout`
```
body: { branch, onDirty: "stash" | "carry" | "discard" }
guards: valid repo  AND  phase ∉ {deploying, running}  AND  branch exists
200 { ok: true, branch, stashed: "<ref>"|null, leftBranch }
409 { ok: false, error: "phase_locked", phase }
409 { ok: false, error: "checkout_conflict", message }   // tree untouched
```

## 8. Edge cases

- **Detached HEAD:** show "detached"; allow switching *out* to a branch.
- **No git / invalid repo:** chip stays static (today's behavior); endpoints
  return `valid:false`.
- **Checkout conflict:** abort, report the real error, working tree unchanged.
- **Stash collision:** named stash avoids ambiguity; restore link targets the
  exact ref returned.
- **Phase races to `deploying` mid-flow:** server-side 409 is authoritative.
- **`.edog-changes.patch` absent:** #1 predictive degrades to no warning.

## 9. Testing (Sentinel gate)

- **Python** (temp-git-repo fixture, importlib pattern):
  - phase lock → `409` for `deploying`/`running`; allowed for
    `idle`/`stopped`/`crashed`.
  - dirty-prompt branching (stash / carry / discard).
  - checkout success and conflict (tree-unchanged assertion).
  - branches endpoint shape; `remote=1` fetch path.
  - #1 predictive: `touchesEdogSurface` true when target diverges in a patched
    file, false / no-op when `.edog-changes.patch` absent.
  - #2: unpushed-commit and stash counts.
- **JS** (`node:test` `.mjs`, like `test-import-lakehouse-capture.mjs`):
  - branch-list render + search filter.
  - disabled-state under each phase.
  - switch-flow prompt logic + stash-restore link wiring.
  - rich-row formatting (ahead/behind, relative time).

## 10. Scope summary

**In:** pre-deploy-only phase-locked switcher; searchable local list +
on-demand remote fetch; dirty prompt; rich rows (A); recoverable named stash
(E); don't-lose-work (#2); predictive patch-surface warning (#1).

**Gated (spike first):** PR/review context (#4).

**Out:** create-branch; per-branch environment memory; auto-restore-on-return;
chip motion/animation polish; switching while running.
