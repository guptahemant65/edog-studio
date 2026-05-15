# Feature 11: Environment Panel

> **Status:** PHASE 0 — Research not started
> **Phase:** V1.1
> **Owner:** Pixel (JS/CSS), Vex (C# + Python), Sana (architecture), Sentinel (tests)
> **Design Ref:** `docs/specs/design-spec-v2.md` §11 (legacy three-tab design)
> **SOP:** `hivemind/FEATURE_DEV_SOP.md`
> **Supersedes:** `_legacy-flat-spec.md` (former three-tab design — Lock Monitor + Orphaned Resources moved out, see §10)

---

## 1. Problem

The sidebar exposes an **Environment** tab today, but clicking it lands on a "coming in V1.1" empty state (`src/frontend/index.html:294`). Meanwhile, the information a developer actually needs to answer *"what is true about this running system right now?"* is scattered across five surfaces:

| Question | Today's answer location |
|---|---|
| Is flag X enabled on `daily`? | grep C# flag provider, or `FeatureTool.ps1` |
| What's my MWC token state? | Topbar token chip (summary only) |
| What workspace/capacity/lakehouse am I deployed against? | Topbar settings popover |
| What SHA / patch hash am I on? | `git rev-parse HEAD` + manual hash of `.edog-changes.patch` |
| Is `DisableFLTAuth` active? | Read `Test.json`, eyeball the value |

Five surfaces, four manual steps, zero in one place. Worst of all, **feature flags are not visible at all without leaving the studio.**

## 2. Objective

A unified **Environment** view that answers *"what is true about this running system?"* on one screen, with five sections in priority order:

1. **Feature Flags** (P0 — headline) — ring-by-ring rollout matrix with local overrides via `EdogFeatureFlighterWrapper`. The one feature that doesn't exist anywhere today.
2. **Config Snapshot** (P0) — workspace/capacity/artifact/lakehouse IDs, FLT port, deployed branch + SHA, deploy timestamp.
3. **Token State** (P1) — bearer expiry, MWC availability, last refresh, regenerate action. Promotes the topbar chip's data to a detail surface.
4. **Build & Patch** (P1) — FLT git SHA, branch, edog.py version, `.edog-changes.patch` hash, dirty-file count breakdown. So "I'm on SHA X with patch hash Y" is one screenshot, not five commands.
5. **Auth Mode & Overrides** (P2) — DisableFLTAuth state, env var overrides, appsettings diff vs. FLT defaults.

### Out of scope (moved elsewhere)

- **Lock Monitor** → Runtime view as a 6th primary sub-tab (live operational state belongs next to Logs/Telemetry/Spark Inspector, not config). Tracked separately.
- **Orphaned Resources** → Workspace Explorer "Orphans only" filter chip (artifact lifecycle is already that view's domain). Tracked separately.

## 3. What User Sees

### Layout

Single scrollable panel inside the existing `#view-environment` shell. Vertical stack of five collapsible cards in priority order. No tabs — tabs hide siblings; this is a dashboard.

```
┌─ ENVIRONMENT ─────────────────────────────────────────┐
│                                                       │
│ ▾ CONFIG SNAPSHOT                            ● running│
│   workspace_id       brave_turing_42  ⧉              │
│   capacity_id        c-0a7…                  ⧉       │
│   lakehouse          lh_brave_turing          ⧉       │
│   FLT port           :7081                            │
│   branch / SHA       master @ 788ac41        ⧉       │
│   deployed           2 hrs ago                        │
│                                                       │
│ ▾ TOKEN STATE                                ● MWC ok│
│   bearer             ✓ valid · expires in 38m   ↻    │
│   MWC                ✓ available · proxy-managed      │
│   last refresh       00:18:42 IST                     │
│                                                       │
│ ▾ FEATURE FLAGS                          28 flags · 4│
│   [search...] [All] [Enabled] [Partial] [Disabled]   │
│   ┌──────────────────────────────────────────────┐   │
│   │ EnableMLVRefresh    onebox test ... prod  ↻ ●│   │
│   │ EnableShallowCopy   ✓ ✓ ✓ ✓ ◐ ✗ ✗      [on]│   │
│   │ ...                                          │   │
│   └──────────────────────────────────────────────┘   │
│   [Reset all overrides]                              │
│                                                       │
│ ▾ BUILD & PATCH                                       │
│   FLT SHA            af3e21c                  ⧉      │
│   edog.py version    v0.4.2                           │
│   patch hash         sha256:9d2a…  (9 files)  ⧉      │
│   dirty (non-EDOG)   0   ✓ clean                      │
│                                                       │
│ ▾ AUTH MODE & OVERRIDES                  DisableAuth ✓│
│   DisableFLTAuth     ON  (Test.json:14)               │
│   env overrides      —                                │
│   appsettings diff   2 keys differ from FLT default   │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### Key Interactions

- All cards collapsible; state persisted in `localStorage`.
- Copy-icon (⧉) on every monospace value copies to clipboard.
- Feature Flags is the only card with non-trivial interaction (table + overrides + ring grouping); other cards are read-with-copy.
- Disconnected-mode (no FLT running): cards 3 (token), 5 (auth) show "FLT not running — deploy first" empty state. Cards 1, 4 still render (workspace/config + git state are local-only).
- Connected-mode required only for Feature Flag overrides (need the wrapper running).

## 4. Existing Code

| Surface | File | Notes |
|---|---|---|
| Sidebar entry | `src/frontend/index.html:97,291` | `data-view="environment"` already wired |
| Mock implementation | `src/frontend/js/mock-renderer.js:858-1100` | Three-tab UI mock — Feature Flags row works, lock + orphans are static |
| Empty state | `src/frontend/index.html:291-296` | Shows "coming in V1.1" today |
| Feature flag wrapper (planned) | `src/backend/DevMode/EdogFeatureFlighterWrapper.cs` | Doesn't exist yet; in registry catalog at `src/backend/DevMode/EdogInterceptorRegistry.cs:40` |
| Config source | `dev-server.py::_serve_config` (line 2010) | Already returns workspace/capacity/artifactId + fltPort + studioPhase |
| Bearer cache | `BEARER_CACHE` in `dev-server.py` | Token state surface |
| Repo state | `repo_discovery.py` (this session) | Patch hash + dirty count already plumbed |
| FLT IFeatureFlighter | (FLT repo) `Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter` | DI interface to wrap |
| Mock CSS | `src/frontend/css/environment.css` | May or may not exist — verify in P0 |

## 5. Acceptance Criteria

### Card 1 — Config Snapshot
- [ ] Renders workspace_id, capacity_id, artifact_id, lakehouse name, FLT port, branch, SHA, deploy timestamp
- [ ] Copy-to-clipboard on every monospace value
- [ ] Updates when config changes (subscribes to studio status SSE or polls `/api/flt/config`)
- [ ] Disconnected mode: shows local config only, hides FLT port

### Card 2 — Token State
- [ ] Bearer: state (valid/expiring/expired), expiry countdown, regenerate button
- [ ] MWC: availability (proxy-managed), last refresh timestamp
- [ ] Regenerate triggers the same flow as the topbar token chip
- [ ] Disconnected (no FLT): card shows compact disconnected hint, not empty

### Card 3 — Feature Flags (headline)
- [ ] Table of all FLT feature flags discovered via `IFeatureFlighter` enumeration
- [ ] Per-ring columns: onebox, test, daily, cst, dxt, msit, prod
- [ ] Cell glyphs: ✓ (enabled), ✗ (disabled), ◐ (conditional — tooltip explains)
- [ ] Search by name; group filter (All / Enabled / Partial / Disabled)
- [ ] Local override toggle per flag — flows through `EdogFeatureFlighterWrapper`
- [ ] Overrides persist across reload (stored in dev-server, not localStorage — `IFeatureFlighter` needs them on next call)
- [ ] Reset-all-overrides button with confirmation
- [ ] Override changes take effect on next `IsEnabled` call (verified via log)
- [ ] Connected-only — when disconnected, shows static flag data (no overrides) with explanatory pill

### Card 4 — Build & Patch
- [ ] FLT git SHA + branch (read via repo_discovery)
- [ ] edog.py version (constant in edog.py)
- [ ] `.edog-changes.patch` sha256 hash + file count
- [ ] Non-EDOG dirty count (reuses logic shipped in `bf18539`)
- [ ] "Copy diagnostic line" button copies `FLT@SHA · patch@hash · edog@version` one-liner for tickets

### Card 5 — Auth Mode & Overrides
- [ ] DisableFLTAuth current value (from `Test.json` parse)
- [ ] Env var overrides (anything in `EDOG_*` env)
- [ ] appsettings diff (count only, expandable to full diff)
- [ ] Read-only — toggling these is out of scope for V1.1

### Cross-cutting
- [ ] Cards collapsible, state persists in `localStorage` (key `edog.env.cards.{cardId}`)
- [ ] No "coming in V1.1" empty state — every card renders or shows specific guidance
- [ ] Theme: dark mode works
- [ ] Keyboard: `4` switches to view (existing), `/` focuses Feature Flags search when card is open
- [ ] All Sentinel gates pass (build, tests, lint)

## 6. SOP Phase Plan

Following `hivemind/FEATURE_DEV_SOP.md`. Folder structure already created:

```
docs/specs/features/F11-environment-panel/
├── spec.md                  ← THIS FILE (master)
├── _legacy-flat-spec.md     ← Archived prior flat design
├── research/
│   └── p0-foundation.md     ← P0 (next)
├── components/
│   ├── C01-config-snapshot.md
│   ├── C02-token-state.md
│   ├── C03-feature-flags.md (the meaty one)
│   ├── C04-build-patch.md
│   └── C05-auth-mode.md
├── architecture.md          ← P2: IFeatureFlighter wrapper + overrides API
├── states/
│   └── feature-flags-table.md (C03 only — other cards are read-only)
└── mocks/
    └── environment-shell.html
```

| Phase | Owner | Output | Gate before next |
|---|---|---|---|
| P0 — Foundation Research | Vex + Sana | `research/p0-foundation.md` — FLT `IFeatureFlighter` API, ring metadata source, existing dev-server config endpoint shape, mock-renderer code to salvage | All `file:line` refs verified against `git show HEAD:` |
| P1 — Component Specs | Sana + Pixel (5 parallel) | `components/C0N-*.md` | Every scenario has a concrete impl path |
| P2 — Architecture | Sana (data) + Vex (proto) | `architecture.md` — wrapper design, overrides storage, config refresh strategy | Performance + error paths defined |
| P3 — State Matrix | Pixel | `states/feature-flags-table.md` — table is the only stateful surface | 10+ states; disconnected + error paths included |
| P4 — Mock | Pixel | `mocks/environment-shell.html` | CEO approval (you) |
| P5 — Implementation | Vex (C# + Py) + Pixel (JS/CSS), 1 file per agent | source files | `make build && make test` clean |
| P6 — Bug Hunt | 4 adversarial + 4 validation + 3 fix | bug list closed | All fixes verified |
| P7 — CEO Review | You | Sign-off | Ship |

## 7. Dependencies

- **F02 (Deploy):** Connected mode is required for feature-flag overrides (the wrapper is only loaded inside the FLT process).
- **`bf18539`:** Dirty-count fix (already shipped) — Card 4 reuses `gitDirtyEdogFiles` / `gitDirtyTotal` from `/api/studio/status`.
- **EdogInterceptorRegistry catalog:** Already lists `FeatureFlighter` at `EdogInterceptorRegistry.cs:40` — wrapper just needs to *exist* and register; registry already probes it.

## 8. Risks

| Risk | Mitigation |
|---|---|
| `IFeatureFlighter` flag enumeration API may not exist — `IsEnabled(name)` is callable but listing all flag names may require reflection over a config source | P0 verifies. Fallback: ship a static list from FLT repo's `FeatureManagement` JSON files, refresh on each deploy. |
| Ring metadata (which ring is current) isn't visible from `IsEnabled` alone — flags evaluate against tenant/capacity/workspace context | P0 reads the actual flag JSON shape. Each row's per-ring state may need to be computed by simulating with hardcoded ring tenant IDs (FLT repo has these constants). |
| Late DI registration timing (same risk that bit interceptor wrappers) | Reuse the `RunAsync()` callback pattern already used by `EdogTokenLifecycleInterceptor`. Verified in `EdogDevModeRegistrar.cs`. |
| Override persistence: localStorage isn't enough — wrapper needs them at request time, not page time | Store in dev-server state; wrapper polls `/api/edog/feature-overrides` on a debounce, or push via existing SignalR channel. P2 decides. |
| `Test.json` parse may break on schema drift | P0 confirms current schema. Tolerate missing key; surface as "unknown" not error. |

## 9. Moonshot Vision (V2+)

- **Flag experiment mode** — set overrides per-request via header, A/B locally without flipping global state.
- **Flag dependency graph** — show which code paths gate on which flag (static analysis over the FLT source).
- **One-click "Create rollout PR"** — pre-fills a PR against the FeatureManagement repo with the diff of current overrides vs. the prod ring.
- **Time-travel** — diff config snapshot against a previous deploy.

## 10. Related Specs (Spin-Offs)

These were in the legacy three-tab F11 design and have moved:

- **F11b — Lock Monitor** (Runtime view, sub-tab): live distributed-lock state. Endpoints `GET /liveTableMaintenance/getLockedDAGExecutionIteration` + `POST /liveTableMaintenance/forceUnlockDAGExecution`. To be specced as its own folder under `docs/specs/features/F11b-lock-monitor/` when scheduled.
- **F11c — Orphaned Resources Filter** (Workspace Explorer toggle, not new view): `GET /liveTableMaintenance/listOrphanedIndexFolders` + `POST /liveTableMaintenance/deleteOrphanedIndexFolders`. Adds an "Orphans only" chip to existing Workspace Explorer toolbar. To be specced under `F11c-orphan-filter/` when scheduled.

---

*"What is true about this running system right now?" — one view, one answer.*
