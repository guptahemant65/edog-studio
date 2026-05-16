# P0 — Foundation Research

> **Purpose:** For every datapoint and action in the mock (`mocks/environment-shell.html`), map to its ground-truth source. Where the source doesn't exist yet, name the gap and the design decision required.
> **Verdict on the mock:** Cards 1, 4, 5 are mostly feedable from existing endpoints. Card 2 has a real bearer-expiry gap. **Card 3 (Feature Flags) is the one with structural unknowns — the "7-ring matrix" is fiction without new plumbing.**

---

## 1. Data-Source Map (per card)

### Card 1 — Config Snapshot

| Field | Source | Endpoint / File | Status | Notes |
|---|---|---|---|---|
| `workspace_id` | `edog-config.json` → `workspace_id` | `GET /api/flt/config` → `workspaceId` | ✅ wired | `dev-server.py:2025` |
| `capacity_id` | `edog-config.json` → `capacity_id` | `GET /api/flt/config` → `capacityId` | ✅ wired | `dev-server.py:2027` |
| `artifact_id` (lakehouse) | `edog-config.json` → `artifact_id` | `GET /api/flt/config` → `artifactId` | ✅ wired | `dev-server.py:2026` |
| `lakehouse_name` | `_studio_state["deployTarget"]["lakehouseName"]` (set at deploy `dev-server.py:2548`) | currently NOT in `/api/flt/config` | 🟡 collected, not exposed; volatile (lost on dev-server restart) | Frontend sends `workspaceName`/`lakehouseName`/(`capacityName`) on deploy. Persist to `edog-config.json` on successful deploy, expose via `/api/flt/config`. One-line additions. |
| `workspace_name` | same — `_studio_state["deployTarget"]["workspaceName"]` (`dev-server.py:2549`) | currently NOT in `/api/flt/config` | 🟡 same as above | |
| `capacity_name` | same flow (frontend sends on deploy) | not in `/api/flt/config` | 🟡 same as above | |
| `FLT port` | `_studio_state["fltPort"]` (set at deploy `dev-server.py:1707`) | `GET /api/flt/config` → `fltPort` | ✅ wired | Null pre-deploy. |
| `branch` | `repo_discovery.validate_repo()` → `gitBranch` | `GET /api/edog/health` → `gitBranch` | ✅ wired | `dev-server.py:3448` |
| `SHA` | — | — | ❌ NOT collected | `validate_repo()` doesn't capture SHA today (`repo_discovery.py:156`). Add `gitSha` via `git rev-parse --short HEAD`. |
| `deploy timestamp` | — | — | ❌ NOT collected | `_studio_state["deployStartTime"]` exists (`dev-server.py:196`) but only during deploy; no "last successful deploy" persisted. Add `lastDeployedAt` to studio state and persist via `.edog-session.json`. |
| `studioPhase` (running / deploying / crashed / idle) | `_studio_state["phase"]` | `GET /api/studio/status` → `phase` | ✅ wired | Drives the disconnected-mode badge in the mock. |

### Card 2 — Token State

| Field | Source | Endpoint / File | Status | Notes |
|---|---|---|---|---|
| `bearer present` | `.edog-bearer-cache` (`BEARER_CACHE`) | `GET /api/edog/health` → `hasBearerToken` | ✅ wired | `dev-server.py:3468` |
| `bearer expires in` | `_read_cache(BEARER_CACHE)` returns `(token, exp_time)` | `GET /api/edog/health` → `bearerExpiresIn` (seconds) | ✅ wired | `dev-server.py:3469` — already exposed. The mock's "expires in 38m" countdown is feedable. |
| `MWC availability` | Computed from bearer + workspace/capacity present | `GET /api/flt/config` → `mwcToken: "proxy-managed" \| null` | ✅ wired | `dev-server.py:2030`. Not an actual token, just a presence signal. |
| `last refresh timestamp` | — | — | ❌ NOT collected | `_get_mwc_token()` does `_write_cache()` but doesn't expose write time. Add `mwcLastRefresh` field returned alongside; backed by `MWC_CACHE` mtime. |
| `last MWC refresh source` (auto vs manual) | — | — | ❌ Could add | Optional. Background refresh runs every 50min (`dev-server.py:1845`). |

### Card 3 — Feature Flags ⚠️ STRUCTURAL GAP

| Field | Source | Endpoint / File | Status | Notes |
|---|---|---|---|---|
| `flag list` (all known names) | **FeatureManagement repo** at `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement` — branch `master`, path `Features/**/*.json`. 13,326 flags. | New: `GET /api/edog/feature-flags/catalog` (fetched on first request, refreshed hourly, force-refresh button) | ❌ NOT wired | See §2 below. Definitive source. |
| `per-env state` (15 envs: 7 main rings + 8 sovereign) | Same — `Environments.<env>` object per flag | same endpoint | ❌ NOT wired | See §2 — 3 distinct state shapes (`{}`, `{Enabled:bool}`, `{Targets:...}`). |
| `FLT-relevant subset` | Parse `Service/Microsoft.LiveTable.Service/FeatureFlightProvider/FeatureNames.cs` in the configured FLT repo — `public const string {c#Name} = "{flagValue}"` declarations + `<summary>` doc-comments. ~36 flags. | New: `GET /api/edog/feature-flags/flt-names` | ❌ NOT wired | See §2. Single canonical source — no grep needed. C# name is display; string value is FM lookup key. |
| `live evaluation stream` | `EdogFeatureFlighterWrapper.IsEnabled` publishes `{flagName, result, tenantId, capacityId, workspaceId, durationMs, overridden?}` to topic `"flag"` via `EdogTopicRouter` | SignalR `flag` topic (already streaming) | ✅ wired (passive) | `EdogFeatureFlighterWrapper.cs:33-56`. |
| `local override` (per-flag force-on/force-off) | — | — | ❌ **MECHANIC DOES NOT EXIST** | See §3 below. Current wrapper is pass-through; doesn't consult any override map. |
| `reset all overrides` | — | — | ❌ Depends on §3 | |

### Card 4 — Build & Patch

| Field | Source | Endpoint / File | Status | Notes |
|---|---|---|---|---|
| `FLT SHA` | — | — | ❌ NOT collected (same gap as Card 1) | One field, both cards. |
| `FLT branch` | `validate_repo()` → `gitBranch` | `GET /api/edog/health` | ✅ wired | |
| `edog.py version` | — | — | ❌ NOT exposed | No `__version__` constant in `edog.py`. Need to add one (e.g., `__version__ = "0.4.2"`) and surface via a new `/api/edog/version` or in `/api/edog/health`. |
| `.edog-changes.patch hash` | — | — | ❌ NOT computed | `EDOG_PATCH_FILE = ".edog-changes.patch"` exists (`repo_discovery.py:26`). Need `sha256(open(EDOG_PATCH_FILE,'rb').read())`. Trivial; add to health endpoint. |
| `patch file count` | `_edog_patched_paths()` parses the patch and returns the set | already used internally for dirty filtering | 🟡 internal-only | Just needs to be exposed: `len(_edog_patched_paths())`. |
| `dirty (non-EDOG) count` | `validate_repo()` → `gitDirty` (non-EDOG only) | `GET /api/edog/health` → `gitDirtyFiles` | ✅ wired | `dev-server.py:3472`. This is the "+7 dirty" topbar number minus EDOG-managed. |
| `dirty (EDOG) count` | `gitDirtyEdog` | same endpoint → `gitDirtyEdogFiles` | ✅ wired | The +7 we discussed earlier. |
| `total dirty` | `gitDirtyTotal` | same endpoint | ✅ wired | |
| `patchWarnings` (pattern_not_found) | `_studio_state["patchWarnings"]` | `GET /api/edog/patch-warnings` | ✅ wired | `dev-server.py:3271`. Should surface on this card — answers "did all my patches apply?". |
| `Copy diagnostic line` (action) | — | client-side concat | ✅ trivial JS | Formats `FLT@{sha} · patch@{hash} · edog@{version}` from the above fields. |

### Card 5 — Auth Mode & Overrides

| Field | Source | Endpoint / File | Status | Notes |
|---|---|---|---|---|
| `DisableFLTAuth (ParametersManifest.json)` | Read FLT file, regex `"DisableFLTAuth":\s*true\|false` | — | ❌ NOT yet exposed | `edog.py:2761` already does this in `verify` command. Lift the logic into a `/api/edog/auth-mode` endpoint. |
| `DisableFLTAuth (Test.json)` | Read FLT file, same regex | — | ❌ NOT yet exposed | `edog.py:2768`. Same as above. Two locations, both shown separately in the mock. |
| `file:line ref` for each | grep for the line number at parse time | — | 🟡 trivial | Add to the endpoint payload. |
| `env overrides` (`EDOG_*` env vars) | `os.environ` filter | — | ❌ Add | One-line scan. |
| `appsettings diff count` | — | — | ❌ Decision needed | A "default appsettings" baseline doesn't exist as a file we can diff against. Either build the baseline (snapshot pristine FLT `appsettings.json` at deploy time, diff later) or **drop the row from the card**. V1 is terminal — no "coming soon" hedge. Recommendation: **drop the row**; the patch-warnings + DisableFLTAuth lines already cover the meaningful auth/config drift. |

---

## 2. The Feature Flags Ring Question (the meaty problem)

The mock has 28 flags × 7 rings = 196 cells. **`IFeatureFlighter` does not give us this matrix — but the canonical source IS a remote git repo we can fetch.**

### What `IFeatureFlighter` actually is

```csharp
// From FLT: Microsoft.LiveTable.Service.FeatureFlightProvider.IFeatureFlighter
bool IsEnabled(string featureName, Guid? tenantId, Guid? capacityId, Guid? workspaceId);
```

One method. No enumeration. No "ring" parameter. The implementation consults flag definitions baked into the deploy from the FeatureManagement repo.

### The canonical source: `FeatureManagement` repo (FMv2)

- **URL:** `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement`
- **Default branch:** `master` (not `main`)
- **Auth:** Windows credential manager — `git clone` works with cached creds on Microsoft dev boxes, no PAT setup needed. Verified by probe.
- **Scale:** **13,326 flag JSON files** across 4 root dirs under `Features/`: `5256710/`, `Configuration/`, `Tools/`, `Validation/`. Whole repo `--depth=1 --filter=blob:none` ≈ 15 MB.
- **README:** points at FMv2 wiki — this is "FeatureManagement v2". There are also `Exp/` (experiments), `ConfigOverrides/` (non-flag config), and Geneva Actions for runtime overrides (out of scope for V1).

### Per-flag schema (verified by reading sample + complex flags)

```jsonc
{
  "Id": "AccessProtection_GetAppMetadata",
  "Description": "Feature switch to redirect GetAppMetadata request...",
  "Environments": {
    "<envName>": { /* state — 3 shapes, see below */ }
  }
}
```

### 15 environments (not 7 — mock is wrong)

`onebox`, `test`, `daily`, `cst`, `dxt`, `msit`, `prod`, `mc`, `gcc`, `gcchigh`, `dod`, `usnat`, `ussec`, `bleu`, `usgovcanary`

The last 8 are sovereign / national clouds — most flags leave these as `{}`. Mock should show the **7 mainline rings as columns**, fold the 8 sovereigns into a single `sov` column (expandable on row click).

### 3 state shapes (mock's `✓ ✗ ◐` is close but incomplete)

| Shape | Mock glyph | Meaning |
|---|---|---|
| `{}` (empty) | `–` (em-dash) NOT `✗` | Not deployed to this env — distinct from explicit-off. Visually neutral. |
| `{"Enabled": true}` | `✓` (accent) | Enabled for the whole env. |
| `{"Enabled": false}` | `✗` (muted) | Explicitly disabled for the whole env. |
| `{"Targets": { ... }}` | `◐` (warning-tint) | Partial — targeted rollout. Tooltip: list of target groups (e.g., `canary-1-test-tenants`, `Prod-test-tenants`) with their pivots (`RegionName`, `TenantObjectId`, `MemberOf`). |
| (override in session) | `!` (accent fill) overlay | Overridden by the dev — value forced by `EdogFeatureFlighterWrapper`. Real underlying glyph still readable beneath. |

### The scale problem (13K flags) and the answer

A naive table of 13K rows is hostile — and unnecessary. **FLT declares every flag it consults in one file.**

**Source:** `Service\Microsoft.LiveTable.Service\FeatureFlightProvider\FeatureNames.cs` in the FLT repo. It's a single static class of `public const string` declarations, header-commented with a direct pointer at the FM repo path: `/Features/Configuration/Features/`. As of probe: **~36 flags.**

**Parse:** trivial regex over the file body — `public const string (\w+)\s*=\s*"([^"]+)"`. Captures both the C# name (display) and the flag value (lookup key).

**Critical nuance — they often differ:**
```csharp
public const string FLTIRQMAPartitionPruningEnabled = "EnableFMLVQMAPartitionPruning";
public const string FLTIRMinMaxAggregationsEnabled  = "EnableFMLVMinMaxSAMAggregations";
```
The C# const NAME is a developer alias; the **string VALUE** is what the FeatureFlighter API receives and what the FM repo keys on. The matrix must display the C# name (readable, FLT-conceptual) and **resolve the row to the FM JSON by value** (the wire key).

**Implementation flow:**
1. Read `FeatureNames.cs` from configured FLT repo → list of `(c#Name, flagValue, xmlDocSummary)` tuples.
2. For each value, look up `Features/Configuration/Features/{value}.json` from FM cache. (Fall back to recursive walk if path varies for some.)
3. Render: ~36 rows × 7 mainline + sov-fold columns.

**Edge cases:**
- **Flag declared in FLT but missing in FM repo** (typo, pending FM PR) → row renders with `?` cells + "missing in FM" badge linking to the would-be FM path.
- **Flag in FM repo but not in FeatureNames.cs** → invisible by design (FLT doesn't consult it).
- **The C# `<summary>` doc-comment is gold** — capture it as the row's tooltip / expand-row description. FM's `Description` field as backup.

The mock's 28-flag estimate was close — actual is ~36, well within the same UX envelope.

The "Show all 13K flags" mode I proposed earlier is now **cut**. We only need FLT-relevant. Period.

### Fetch strategy

| Step | Command | Cost |
|---|---|---|
| First-time bootstrap | `git clone --depth=1 --filter=blob:none --sparse <url> ~/.edog-cache/feature-management` then `git sparse-checkout set Features` | ~5-10s, ~15MB |
| Refresh (background, on first /api/edog/feature-flags/catalog call after TTL expires) | `git -C ~/.edog-cache/feature-management fetch origin master --depth=1 && git -C ... reset --hard origin/master` | ~1-2s, incremental |
| TTL | 1 hour | — |
| Force refresh | "Refresh" button on the card → POST `/api/edog/feature-flags/catalog/refresh` → re-fetch + re-index | <2s |
| Parse | Walk `Features/**/*.json`, build index keyed by `Id`. | <1s for all 13K |
| Storage | `~/.edog-cache/feature-management/` (purged by `edog cache clear`) | ~15MB |

### Auth confirmed

Probe successful: `git clone --depth=1 --filter=blob:none --no-checkout https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement` worked with **no auth prompt** — Windows credential manager handles it. The dev-server invokes `git` as a subprocess, inherits the same credentials. Same pattern that already validates `flt_repo_path`. **No new auth code, no PAT, no special setup.**

If a user lacks ADO access (rare on Microsoft dev boxes), the card shows a clear "Cannot reach FeatureManagement repo — run `git clone <url>` once to cache credentials" hint with the URL pre-filled.

---

## 3. Override Mechanic (does not exist; must be designed)

The current wrapper at `src/backend/DevMode/EdogFeatureFlighterWrapper.cs:33-56` is **purely observational** — it calls `_inner.IsEnabled` and publishes the result. It never short-circuits.

### 3a. UI model: two binary toggle buttons per row (NOT a tri-state)

```
flag name              …matrix cells…    [ ON ]  [ OFF ]
```

| Button state | Meaning | Click behavior |
|---|---|---|
| Neither pressed | No override — MWC truth | Click either to override |
| `[ON]` pressed | Forced `true`; row gets `!` glyph | Click ON again = clear · Click OFF = flip direction |
| `[OFF]` pressed | Forced `false`; row gets `!` glyph | Click OFF again = clear · Click ON = flip direction |

Two binary controls, three meaningful states. Standard toggle-button-group pattern (`aria-pressed`). Per-row clear = re-click the active button; global "Reset all overrides" covers bulk.

Tri-state (`Off · MWC · On`) was overengineering. The dict has no "passthrough" sentinel by design — "no entry" IS the unset state. UI matches the storage model directly.

### 3b. New override store in dev-server

```python
# In dev-server.py
_feature_overrides: dict[str, bool] = {}  # flagName -> forced value
_feature_overrides_lock = threading.Lock()

# POST   /api/edog/feature-flags/overrides         {flag, value}
# DELETE /api/edog/feature-flags/overrides/{flag}
# POST   /api/edog/feature-flags/overrides/reset
# GET    /api/edog/feature-flags/overrides         → current map
```

State is in-memory in dev-server. **dev-server is the durable source of truth across FLT restarts** — on wrapper reconnect, dev-server replays the map via SignalR. Reset on dev-server restart is expected behavior.

### 3c. Wrapper enhancement

> **Superseded:** The illustrative snippet below has been replaced by the locked design in `architecture.md` §3.3–3.4. Highlights of the correction:
> - Storage moved from `ConcurrentDictionary<string,bool>` inside the wrapper to a dedicated `EdogFeatureOverrideStore` static class using `volatile FrozenDictionary<string,bool>` for snapshot-atomic reads.
> - Bulk writes use snapshot replacement (`Volatile.Write`), never `Clear()+foreach` — rubber-duck P2 critique §1.
> - Force-ON only: store schema is `bool` to match the underlying `IFeatureFlighter` contract; every write path rejects `value === false` at the HTTP layer. Force-OFF is cut, not deferred — F11 is V1-terminal.
> Keep the snippet here as historical record only.

```csharp
public class EdogFeatureFlighterWrapper : IFeatureFlighter
{
    private readonly IFeatureFlighter _inner;
    private static readonly ConcurrentDictionary<string, bool> _overrides = new();

    public bool IsEnabled(string name, Guid? t, Guid? c, Guid? w)
    {
        if (_overrides.TryGetValue(name, out var forced))
        {
            EdogTopicRouter.Publish("flag", new {
                flagName = name, result = forced, overridden = true, ...
            });
            return forced;                            // ← short-circuit, never calls MWC
        }
        // existing pass-through path...
    }

    // Called by the SignalR subscriber on flag-overrides messages.
    // Atomic replace; empty `next` == reset all.
    public static void Apply(IReadOnlyDictionary<string, bool> next)
    {
        _overrides.Clear();
        foreach (var kv in next) _overrides[kv.Key] = kv.Value;
    }
}
```

### 3d. Sync mechanic: ~~SignalR push~~ HTTP control plane

> **Superseded by architecture.md §3.** The original "SignalR `flag-overrides` topic" plan is architecturally invalid: `EdogTopicRouter` is publish-only (FLT → browser); there is no subscriber-side hook for FLT code to receive control messages. The locked design uses an HTTP control plane on `EdogLogServer:5557` instead. See `architecture.md` §3.1 for the rationale and §3.2–3.8 for the corrected topology.

dev-server posts override changes to FLT via a new `flag-overrides` topic on the existing `EdogTopicRouter` hub. Wrapper subscribes on startup; on each message calls `Apply(next)`. <100ms latency. On wrapper reconnect after FLT redeploy, dev-server replays the current map. Reset = empty-map message.

Polling was attractive when V2 could "tighten it later." Without V2, the tooling deserves the right answer the first time.

### 3e. Cached-at-startup detection (Gotcha #1 — empirical + actionable)

Some FLT code paths call `IsEnabled` once during init and cache the result. The override won't affect cached values — dev would see no effect. **We detect this from the wrapper's existing publish stream** and surface a one-click fix inline; we do NOT just leave a doc note.

dev-server aggregates per flag:
- `firstSeenMs` — first eval timestamp this session
- `lastSeenMs` — most recent eval timestamp
- `evalCount` — total evals observed
- `fltStartupMs` — already tracked in `_studio_state`

Classification rule:

| Pattern | Class | UI on override toggle |
|---|---|---|
| `evalCount ≥ 5` OR (`lastSeenMs > fltStartupMs + 60s` AND `lastSeenMs > now − 60s`) | `live` | Toggle = clean action, no warning |
| `evalCount ≤ 2` AND all observations within `[fltStartupMs, fltStartupMs + 60s]` | `cached` | Toggle pulses amber + inline `[ Restart FLT to apply ]` button |
| `evalCount == 0` | `unknown` | Toggle works; if no observation within 5s, soft-prompt to restart |

The restart action is **safe** because override persistence across redeploy (§3d) means dev-server replays the map automatically — dev never has to re-apply. `POST /api/studio/deploy`, then wait for wrapper reconnect, then SignalR push.

### 3f. UI mechanic summary

- ON/OFF press → `POST /api/edog/feature-flags/overrides {flag, value}`
- Re-click active button → `DELETE /api/edog/feature-flags/overrides/{flag}`
- "Reset all overrides" → `POST /api/edog/feature-flags/overrides/reset`
- Active override: `!` glyph on row name; relevant cell filled with accent
- Cached classification: amber dot on row; inline restart button when toggle activated
- Cell glyphs unchanged: `–` empty · `✓` true · `✗` false · `◐` Targets · `?` missing in FM

### 3g. Catalog row enrichment

```json
// GET /api/edog/feature-flags/catalog row:
{
  "csharpName": "FLTEnableDqChecks",
  "flagValue": "FLTEnableDqChecks",
  "summary": "Feature switch to enable Data Quality (DQ) checks...",
  "environments": { "onebox": {...}, "test": {...}, ... },
  "override": null | true | false,
  "observation": {
    "evalCount": 47,
    "firstSeenMs": 1715833010000,
    "lastSeenMs": 1715833209000,
    "classification": "live"
  }
}
```

---

## 4. Endpoints to add (summary)

| New endpoint | Replaces / extends | Owner |
|---|---|---|
| `GET /api/edog/version` (or fold into `/api/edog/health`) | — | Vex (Py) |
| `GET /api/edog/auth-mode` | Lifts `edog.py:2761-2773` verify logic | Vex (Py) |
| `GET /api/edog/build-info` (sha, branch, patchHash, patchFileCount, lastDeployedAt, edogVersion) | Augments `/api/edog/health` | Vex (Py) |
| `GET /api/edog/feature-flags/catalog` (parses FLT rollout JSON files, returns matrix) | — | Vex (Py) |
| `GET /api/edog/feature-flags/observed` (live evaluations seen by wrapper) | — | Vex (Py) — projection from SignalR stream |
| `GET /api/edog/feature-flags/overrides` | — | Vex (Py) |
| `POST /api/edog/feature-flags/overrides` `{flag,value}` | — | Vex (Py) + Vex (C# wrapper) |
| `DELETE /api/edog/feature-flags/overrides/{flag}` | — | Vex (Py) |
| `POST /api/edog/feature-flags/overrides/reset` | — | Vex (Py) |
| (existing) `GET /api/studio/status` | Already returns `fltPort`, `phase`, `patchWarnings` | — |
| (existing) `GET /api/flt/config` | Already returns workspace / capacity / artifact / fltPort / bearer presence | — |

### Endpoints to extend

- `GET /api/edog/health` — add `mwcLastRefresh`, `gitSha`, `edogVersion`, `patchHash`, `patchFileCount`, `lastDeployedAt`.
- `EdogFeatureFlighterWrapper.cs` — read from `EdogFeatureOverrideStore` snapshot before delegating; publish `overridden:true` field on the existing `flag` topic. ~~Subscribe to `flag-overrides` SignalR topic~~ — **superseded; control plane is HTTP, not SignalR — see `architecture.md` §3.**
- `EdogFeatureOverrideStore.cs` (new) — static class, `volatile FrozenDictionary<string,bool>` snapshot, `ReplaceAll(map, revision)` for atomic write.
- `EdogLogServer.cs` — add `/api/edog/feature-flags/overrides{,/bulk}` routes with `X-EDOG-Control-Token` middleware.

---

## 5. Disconnected-mode contract (what each card does pre-deploy)

| Card | With FLT running | Pre-deploy / disconnected |
|---|---|---|
| 1 Config | Full data | Workspace/capacity/artifact still shown (from `edog-config.json`); FLT port `—`; branch/SHA still shown (from local git). Deploy timestamp shows `not deployed`. |
| 2 Token | Bearer countdown + MWC ok | Bearer countdown still shown (cache file is local); MWC `—`; "Deploy FLT to enable MWC" hint. |
| 3 Flags | Full matrix + overrides | **Host-parameter matrix still shown** (it's file-parsed from FLT repo, no FLT process required). Observed-code-flags section is empty with "Deploy FLT to start observing". Overrides disabled. |
| 4 Build & Patch | Full data | All data available pre-deploy (this card is 100% local-disk-derived). |
| 5 Auth | Full data | All data available pre-deploy (file parse of ParametersManifest + Test.json). |

**Net:** Three out of five cards work pre-deploy. The mock's disconnected toggle is over-aggressive — it greys out too much. Will refine in component specs.

---

## 6. Action → Mechanism Map (complete inventory)

| User action (from mock) | Wire to | Persistence |
|---|---|---|
| Click copy ⧉ on any monospace value | `navigator.clipboard.writeText(value)` + toast | — |
| Click "Regenerate" on bearer | Re-run silent-CBA flow: `POST /api/edog/auth {username}` | `.edog-bearer-cache` rewritten |
| Click "Refresh" on MWC | `POST /api/edog/mwc-token` (already exists, `dev-server.py:1971`) | `MWC_CACHE` (in-memory + on-disk) rewritten |
| Toggle flag override | `POST /api/edog/feature-flags/overrides {flag, value}` | dev-server in-memory map; pushed to FLT `EdogLogServer:5557` via HTTP `POST /api/edog/feature-flags/overrides/bulk` (snapshot-atomic, control-token authenticated) — see `architecture.md` §3 |
| Reset all overrides | `POST /api/edog/feature-flags/overrides/reset` | dev-server map cleared; empty snapshot pushed to FLT via HTTP `/bulk` |
| Search / group filter in flags table | Client-side filter, no backend | localStorage for last query |
| Collapse/expand any card | Client-side, `localStorage["edog.env.card.{id}"]` | localStorage |
| Toggle disconnected demo (mock-only) | Client-side state | — (this is a mock affordance, not a real feature) |
| Copy "diagnostic line" | Client-side concat → clipboard | — |
| Click `Test.json:14` file:line ref | Opens in VS Code via `vscode://file/<abs-path>:<line>` URI handler | — |

---

## 7. Risks confirmed / mitigated

- ✅ **`IFeatureFlighter` enumeration:** Confirmed no API exists. Going with rollout JSON parse (Option A above).
- ✅ **Ring metadata:** Confirmed rings = rollout JSON files, not API parameter. Per-ring view requires file enumeration.
- ✅ **Late DI registration:** Wrapper already exists (`EdogFeatureFlighterWrapper.cs`), already in `EdogInterceptorRegistry.cs:39-43` catalog. No DI timing risk for the wrapper itself.
- ✅ **Override sync mechanism:** SignalR push via existing `EdogTopicRouter` hub. <100ms latency. No "tighten later" — V1 is terminal, ship the right design now. **(Superseded by architecture.md §3 — control plane is HTTP, not SignalR.)**
- ⚠️ **`Test.json` schema drift:** The parse logic in `edog.py:2768` is regex-based — tolerant. Mitigation already in place.

---

## 8. Mock vs reality — what to change before implementation

This research **changes the mock contract** in three places. Document so we don't ship the mock as-is:

1. **Card 3 is now two surfaces, not one.** Top: host-parameter matrix (file-truth, per-ring). Bottom: observed-code-flags list (runtime-truth, no rings). The current mock conflates these.
2. **Override glyph needed.** Cell needs an `!` (or accent-colored variant) to indicate "this is overridden in this session" vs the underlying config value.
3. **Disconnected mode is too aggressive.** Only Card 2 (MWC half) and the bottom of Card 3 (observed-flags) actually need FLT running. Cards 1, 4, 5, and the host-parameter half of Card 3 work fully without FLT.

These changes inform the next mock iteration (and the P1 component spec for `C03-feature-flags.md`).

---

## 9. Out-of-scope items (cut, not deferred — V1 is terminal)

The legacy spec mentioned several "moonshot" items. Without a V2, each must be **built now or cut now**:

| Item | Decision | Why |
|---|---|---|
| Flag experiment mode (per-request header override) | **Cut.** | Global override already covers the dev-tool need. Per-request is a chaos/A-B testing feature, different problem. |
| Flag dependency graph (static analysis of `IsEnabled` call sites) | **Cut.** | Adjacent feature (code intelligence), not "what is true about this env right now". |
| One-click "Create rollout PR" | **Cut.** | Out-of-tool action; the diagnostic line + clipboard copy is enough — engineer pastes into their own PR. |
| Time-travel (diff config snapshot vs previous deploy) | **Cut.** | Would require persisting all deploys' config; high cost, low frequency of need. |
| `appsettings.json` diff | **Cut** (see Card 5 row). | No pristine baseline exists; building one is its own feature. |

