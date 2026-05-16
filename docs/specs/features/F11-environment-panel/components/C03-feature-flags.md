# C03 — Feature Flags Matrix: Component Deep Spec

> **Component:** Feature Flags Matrix (Card 3, Environment Panel)  
> **Feature:** F11 — Environment Panel  
> **Owner:** Sana (architecture + FLT contract), Vex (Python/C# endpoints), Pixel (JS/CSS implementation)  
> **Complexity:** HIGH — headline component  
> **Status:** P1 — DRAFT  
> **Last Updated:** 2025-07-20

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Spec](#6-visual-spec)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)
11. [Open Questions](#11-open-questions)

---

## 1. Overview

The Feature Flags Matrix is the Environment Panel headline. It answers the question every FLT developer asks before debugging anything else: "what feature-flag universe is this workspace actually running in?" P0 is explicit that `IFeatureFlighter` is not a matrix API; it is one method, `IsEnabled(string featureName, Guid? tenantId, Guid? capacityId, Guid? workspaceId)`, with no enumeration and no ring parameter. So C03 builds the matrix by joining four facts: the FLT-declared flag list, FeatureManagement per-environment JSON, the current workspace targeting context, and live evaluations emitted by the DevMode wrapper.

This component must not become a generic FeatureManagement browser. P0 cuts that scope: "A naive table of 13K rows is hostile — and unnecessary" and "We only need FLT-relevant. Period." The row set therefore comes from `Service\Microsoft.LiveTable.Service\FeatureFlightProvider\FeatureNames.cs`, parsed as `public const string (\w+) = "([^"]+)"`. The C# const name is the display name; the const value is the wire key passed to MWC and used to resolve the FM JSON. P0 calls out the critical nuance that these often differ, for example `FLTIRQMAPartitionPruningEnabled = "EnableFMLVQMAPartitionPruning"`.

C03 also makes local experimentation reversible. P0 §3 says the existing `EdogFeatureFlighterWrapper` is "purely observational" and "never short-circuits." This spec changes that: dev-server owns an in-memory override map, pushes it to FLT via HTTP POST to `EdogLogServer:5557` (control-token authenticated; see `architecture.md` §3), and the wrapper reads from `EdogFeatureOverrideStore`'s snapshot before delegating — short-circuiting when an override exists. Phantom v3 narrows the UI to the asymmetric model: one silky sliding STATE toggle whose only write is **force ON**. No force-off is exposed in V1. If FM already enables the flag for this workspace, the row is locked because there is no useful override to set.

---

## 2. Data Model

### 2.1 Canonical flag row

```typescript
type EnvKey =
  | 'onebox' | 'test' | 'daily' | 'cst' | 'dxt' | 'msit' | 'prod'
  | 'mc' | 'gcc' | 'gcchigh' | 'dod' | 'usnat' | 'ussec' | 'bleu' | 'usgovcanary';

type EnvState = 'on' | 'off' | 'partial' | 'empty' | 'missing';
type FlagClassification = 'Operational' | 'Behavioral' | 'Internal';
type ObservationClass = 'live' | 'cached' | 'unknown';

interface TargetGroup {
  name: string;
  pivot: 'RegionName' | 'TenantObjectId' | 'WorkspaceObjectId' | 'CapacityObjectId' | 'MemberOf' | string;
  valuesPreview: string[];
  includesMyWorkspace?: boolean;
}

interface FlagEnvCell {
  state: EnvState;
  targets?: TargetGroup[];
}

interface FlagRow {
  /** C# const name from FeatureNames.cs; primary display label. */
  name: string;
  /** String value passed to IFeatureFlighter and used as the FM JSON key. */
  wireKey: string;
  summary: string;
  classification: FlagClassification;
  cachedAtStartup: boolean;
  observationClass: ObservationClass;
  perEnv: Record<EnvKey, FlagEnvCell>;
  myWsTargeted: boolean;
  effectiveForMyWorkspace: boolean;
  locked: boolean;
  fmPath?: string;
  fmDescription?: string;
  missingReason?: 'not-found' | 'parse-error' | 'stale-cache';
}
```

The 15 environments are exactly the P0 set: `onebox`, `test`, `daily`, `cst`, `dxt`, `msit`, `prod`, plus the eight sovereign/national clouds `mc`, `gcc`, `gcchigh`, `dod`, `usnat`, `ussec`, `bleu`, `usgovcanary`. The table renders seven mainline columns and a folded Sovereign(8) column. Cell states map P0's FM shapes directly: `{}` becomes `empty`; `{ "Enabled": true }` becomes `on`; `{ "Enabled": false }` becomes `off`; `{ "Targets": ... }` becomes `partial`; a declared FLT flag with no FM JSON becomes `missing`.

Locking is computed for the current workspace, not for the global environment. The home ring is whichever environment EDOG Studio is actually pointed at — configurable via `edog-config.json :: edog_env` and defaulting to `test` (PPE). A row is locked when the home env is fully `on`, or it is `partial` and `myWsTargeted === true`. In either case, FM already evaluates true for this workspace, so the STATE toggle is read-only and announced as locked.

### 2.2 Override map

```typescript
interface Override {
  flag: string;          // wireKey, not display name
  forcedTo: true;        // asymmetric model: force ON only
  setAt: string;         // ISO timestamp
  source: 'ui' | 'replay' | 'dev-server';
}

type OverrideMap = Record<string, Override>;
```

P0's storage principle still holds: "no entry IS the unset state." Dev-server is "the durable source of truth across FLT restarts" while the dev-server process lives. Reset on dev-server restart is expected.

### 2.3 Evaluation event

```typescript
interface EvalEvent {
  flag: string;
  value: boolean;
  ctx: {
    tenantId?: string;
    capacityId?: string;
    workspaceId?: string;
    overridden?: boolean;
    durationMs?: number;
  };
  ts: string;
}
```

The current wrapper already publishes `flagName`, `tenantId`, `capacityId`, `workspaceId`, `result`, and `durationMs` on the `flag` topic. C03 keeps that shape but normalizes it for the browser.

### 2.4 Canonical FLT flag set

The first implementation must parse the current `FeatureNames.cs`, not hard-code this table. As of this spec, the source declares 36 flags:

| Display name | Wire key |
|---|---|
| GtsTransformation | GtsTransformation |
| FLTDagSettings | FLTDagSettings |
| EnablePySparkFMVService | EnablePySparkFMVService |
| EnableFMVServiceNodeSubmissionJitter | EnableFMVServiceNodeSubmissionJitter |
| EnableFMVServiceAPIThrottling | EnableFMVServiceAPIThrottling |
| FLTUserBasedThrottling | FLTUserBasedThrottling |
| FLTArtifactBasedThrottling | FLTArtifactBasedThrottling |
| FLTMLVWarnings | FLTMLVWarnings |
| FLTRefreshPolicy | FLTRefreshPolicy |
| FLTDqMetricsBatchWrite | FLTDqMetricsBatchWrite |
| FLTInsightsMetrics | FLTInsightsMetrics |
| FLTTableMaintenanceHook | FLTTableMaintenanceHook |
| FLTUseOneLakeRegionalEndpoint | FLTUseOneLakeRegionalEndpoint |
| FLTEnableMaxParallelMLVsSettings | FLTEnableMaxParallelMLVsSettings |
| FLTEnableOneLakeS2STokenForPLS | FLTEnableOneLakeS2STokenForPLS |
| FLTLimitConcurrentOneLakeCatalogCalls | FLTLimitConcurrentOneLakeCatalogCalls |
| FLTUseLakeHouseMetastoreClientV2 | FLTUseLakeHouseMetastoreClientV2 |
| FLTResilientCatalogListing | FLTResilientCatalogListing |
| FLTListPathOptimization | FLTListPathOptimization |
| FLTDqMetricsSetTableLogRetentionDays | FLTDqMetricsSetTableLogRetentionDays |
| FLTIRDeletesDisabled | FLTIRDeletesDisabled |
| FLTIRDeltaPhysicalCDFEnabled | FLTIRDeltaPhysicalCDFEnabled |
| FLTIRQuickMergeEnabled | FLTIRQuickMergeEnabled |
| FLTIRQMAPartitionPruningEnabled | EnableFMLVQMAPartitionPruning |
| FLTIRQMAStatPruningEnabled | EnableFMLVQMAStatPruning |
| FLTMLVAutoDVDuringRefreshEnabled | FLTMLVAutoDVDuringRefreshEnabled |
| FLTIRMinMaxAggregationsEnabled | EnableFMLVMinMaxSAMAggregations |
| FLTDqMetricsWriteDisabled | FLTDqMetricsWriteDisabled |
| FLTEnableRefreshTriggers | FLTEnableRefreshTriggers |
| FLTParallelNodeLimit10 | FLTParallelNodeLimit10 |
| FLTParallelNodeLimit15 | FLTParallelNodeLimit15 |
| FLTParallelNodeLimit20 | FLTParallelNodeLimit20 |
| FLTTokenManagerSkipClearOnDagCompletion | FLTTokenManagerSkipClearOnDagCompletion |
| FLTListDagAPIPagination | FLTListDagAPIPagination |
| FLTEnableDqChecks | FLTEnableDqChecks |
| FLTEnableFileSourcedFMLV | FLTEnableFileSourcedFMLV |

Source references: `FeatureNames.cs:7-12` points directly at the FM repo path; declarations run through `FeatureNames.cs:14-239`. `IFeatureFlighter.cs:23-27` defines the one-method runtime contract.

---

## 3. API Surface

### 3.1 `GET /api/edog/feature-flags/catalog`

Returns enriched rows, FM cache status, current workspace identifiers, and observation classes.

```typescript
interface FeatureFlagsCatalogResponse {
  generatedAt: string;
  fltRepoPath: string;
  fm: {
    repoUrl: 'https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement';
    branch: string;
    syncedAt: string | null;
    cacheAgeSeconds: number | null;
    stale: boolean;
    error?: string;
  };
  workspace: {
    tenantId?: string;
    capacityId?: string;
    workspaceId?: string;
    homeEnv: string;       // env name from edog-config.json `edog_env` (default 'test')
  };
  rows: FlagRow[];
}
```

The dev-server reads `FeatureNames.cs`, resolves each wire key against the local FM cache, evaluates target membership for `myWsTargeted`, and merges observation data from the wrapper stream. FM sync is local: no browser call to ADO.

### 3.2 Override endpoints

| Endpoint | Body | Result |
|---|---|---|
| `GET /api/edog/feature-flags/overrides` | — | Current `OverrideMap`. |
| `POST /api/edog/feature-flags/overrides` | `{ "flag": "FLTEnableDqChecks", "value": true }` | Sets force-ON override and pushes full map to FLT. Rejects `false`. |
| `DELETE /api/edog/feature-flags/overrides/{flag}` | — | Clears one entry and pushes full map. |
| `POST /api/edog/feature-flags/overrides/reset` | — | Clears all entries and pushes `{}`. |

After every mutation, dev-server pushes the full snapshot to FLT via HTTP `POST /api/edog/feature-flags/overrides/bulk` on `EdogLogServer:5557` (the FLT-side Kestrel host). The control plane is plain HTTP with an `X-EDOG-Control-Token` header; SignalR remains data-plane only. See `architecture.md` §3 for the full corrected control-plane design and rationale for replacing P0's original SignalR-topic-based push.

### 3.3 SignalR push from FLT (data plane only)

FLT publishes flag evaluation events on topic `flag`. The browser receives normalized `EvalEvent` objects through the existing EDOG live channel. Override pushes do **not** travel through SignalR — they use the HTTP control plane (§3.2 above and `architecture.md` §3).

---

## 4. State Machine

| State | Entry condition | User action | Backend action | Exit |
|---|---|---|---|---|
| `loading` | Catalog or overrides request in flight. | Search/filter disabled; table skeleton. | Read FLT repo, FM cache, override map. | `loaded-locked` or `loaded-unlocked`. |
| `loaded-locked` | CST fully ON, or CST partial + workspace targeted. | Toggle rejects with lock explanation. | No write. | Remains locked unless catalog refresh changes FM truth. |
| `loaded-unlocked` | FM effective state is false for this workspace. | Space/click STATE toggle. | POST force-ON override. | `override-pending`. |
| `override-pending` | Optimistic toggle awaiting POST response. | Row is disabled; spinner in thumb. | Persist in dev-server, push full snapshot to FLT `EdogLogServer:5557` via HTTP `/bulk`. | `override-applied` or error rollback. |
| `override-applied` | Override exists for wire key. | Toggle again or reset glyph. | DELETE one override. | `override-clearing`. |
| `override-clearing` | Clear request in flight. | Row disabled. | Delete from map, push SignalR map. | `loaded-unlocked` or error rollback. |
| `cached-needs-restart` | Override applied to cached-at-startup flag. | Click `Restart FLT to apply`. | `POST /api/studio/deploy`; replay overrides on reconnect. | `override-applied` after reconnect. |

Cached classification follows P0 §3e exactly: `evalCount >= 5`, or a recent observation after startup+60s, is `live`; `evalCount <= 2` with all observations in the first 60s is `cached`; `evalCount == 0` is `unknown`.

---

## 5. Scenarios

| ID | Scenario | Mechanism | Edge cases / interactions | Revert | Priority |
|---|---|---|---|---|---|
| C03-S01 | Fully-on flag. CST cell is `✓`; STATE is ON and locked. | `perEnv.cst.state === 'on'` → `locked=true`. Source: P0 lock rule + mock `isLocked`. | User may still search, inspect sovereigns, and watch eval stream. Toggle click produces "already enabled" message. | None needed; FM owns truth. | P0 |
| C03-S02 | Fully-off with override. CST cell is `✗`; STATE starts OFF. User toggles ON. | POST `{flag,value:true}`; wrapper short-circuits before MWC. P0 says wrapper must return forced result. | If POST fails, rollback visual toggle and toast. If FLT disconnected, store override but mark "pending replay." | Toggle again, row reset button, or Reset all. | P0 |
| C03-S03 | Partial CST and my workspace targeted. CST cell is `◐`; STATE is ON and locked. | Target evaluation sees current tenant/capacity/workspace in FM target groups. | Tooltip lists groups and pivots, e.g. `TenantObjectId` or `MemberOf`. No override needed. | None. | P0 |
| C03-S04 | Partial CST and my workspace not targeted. CST cell is `◐`; STATE starts OFF but is interactive. | `myWsTargeted=false`; force-ON override creates local divergence. | The partial glyph remains because FM truth is still partial; override dot and `!` mark session divergence. | Clear override. | P0 |
| C03-S05 | Cached-at-startup override. | Observation class `cached`; when override is active, row pulses amber and shows `Restart FLT to apply`. | P0 warns some FLT paths call `IsEnabled` once during init and cache the result; do not claim immediate effect. | Clear override or restart FLT; replay preserves override across redeploy. | P0 |
| C03-S06 | Missing-in-FM flag. | FLT declares wire key but FM cache has no JSON. Render `?` in cells and `missing in FM` badge. | Could be typo, pending FM PR, or stale cache. Refresh is offered. | None in UI; fix FM or FLT source. | P0 |
| C03-S07 | FM sync stale. | Catalog returns `fm.stale=true` or cache age past TTL. KPI strip says synced X ago. | Table remains usable with stale badge; refresh button refetches/re-indexes. | Refresh; if unreachable, keep last good cache. | P1 |
| C03-S08 | FLT disconnected. | Catalog still renders from FLT repo + FM cache; eval stream shows "FLT not connected — deploy to start observing." | Override writes stay in dev-server and replay when wrapper connects. Cached/live classification may be `unknown`. | Delete/reset overrides before deploy. | P0 |

---

## 6. Visual Spec

Follow `environment-shell.html` Card 3. The override strip sits above Card 3 and appears only when overrides exist: `{count} overrides active in this session · last set Xs ago · Reset all`. The card badge shows `{n} FLT flags`; the KPI strip shows FLT flag count, total FM scale context, live/cached/unknown counts, and FM repo sync age with Refresh.

The toolbar has search, classification chips (`Operational`, `Behavioral`, `Internal`), and state chips (`All`, `Enabled`, `Disabled`, `Partial`, `Overridden`, `Missing`). Search matches both display name and wire key. The matrix columns are `Flag Name`, `onebox`, `test`, `daily`, `cst`, `dxt`, `msit`, `prod`, folded `Sovereign (8)`, and `STATE`.

Glyph contract:

| Glyph | Meaning |
|---|---|
| `✓` | Fully enabled in that environment. |
| `✗` | Explicitly disabled. |
| `–` | Empty `{}`; not deployed to that environment. |
| `?` | Declared by FLT but missing in FM. |
| `◐` | Partial rollout; tooltip lists target groups. |

The STATE toggle is a single sliding pill. Locked rows show ON with reduced opacity and a lock icon. Unlocked rows show OFF until force-ON override is active. Override-active rows get an accent left border, a small dot beside the toggle, and `!` beside the flag name. Cached override rows get an amber dot and inline `Restart FLT to apply` action.

Sovereign expansion is column-level, not row-level: collapsed summary shows `◐` if any sovereign is partial, else `✓` if any is on, else `–`; expanded mode reveals all eight columns and horizontally scrolls to them.

---

## 7. Keyboard & Accessibility

The table uses roving focus. Arrow Up/Down moves row focus; Arrow Left/Right moves between cells when the table has focus. `/` focuses flag search. `Space` toggles the STATE switch for the focused row; `Enter` opens the row detail/tooltip for target groups. `Escape` clears search first, then exits table focus.

Each switch uses `role="switch"`, `aria-checked`, and `aria-disabled` when locked. The accessible name includes display name, effective state, override status, and lock reason: "FLTEnableDqChecks, on, locked, enabled in CST for this workspace." Cached rows append "restart FLT to apply changes." Partial cells use `aria-label="partial rollout, 2 target groups, current workspace not targeted"` rather than announcing only the glyph.

The override strip is `aria-live="polite"` so screen readers hear count changes. Eval stream updates are not live-announced by default because they can be noisy; the stream exposes a "pause updates" control if implementation sees sustained event volume.

---

## 8. Error Handling

| Error | UI behavior | Backend behavior |
|---|---|---|
| FM repo unreachable | Keep last good cache; show amber banner: "Cannot reach FeatureManagement repo." | Return catalog with `fm.error`, `stale=true`. Include P0 hint to run `git clone <url>` once if credentials are missing. |
| Override write fails | Roll back optimistic toggle; toast error; preserve previous override map. | Do not push partial map. Return structured error with flag and reason. |
| SignalR push fails | Row shows pending replay. | Keep dev-server map; retry on wrapper reconnect. P0 requires replay after redeploy. |
| Cached flag warning | Amber dot + restart prompt. | Use observation aggregation: firstSeen, lastSeen, evalCount, fltStartupMs. |
| Missing `my_ws` / workspace ID | Lock only fully-on rows; partial rows become unlocked with "targeting unknown" warning. | Return `workspace.workspaceId=null`; never guess target membership. |
| FM JSON parse error | Row cells `?`; badge says `FM parse error`. | Capture file path and exception; continue indexing other flags. |

---

## 9. Performance

The normal table is 36 rows and does not need virtualization. Still, the component must switch to row virtualization at >100 flags because the parser is source-driven and future FLT growth should not create layout jank. Virtualization preserves sticky headers, roving focus, and visible-row counts.

FM sync is cached server-side. P0's fetch strategy is a sparse, shallow clone of FeatureManagement into the EDOG cache, followed by incremental fetch/reset and a JSON index keyed by `Id`. This spec uses a nightly refresh plus on-demand Refresh button; catalog requests never synchronously clone unless no cache exists. The repo URL is fixed, but branch is configurable because P0 names `master` while some docs say mainline; dev-server defaults to the known FM default and can be changed without frontend code.

Eval stream backpressure is mandatory. Keep only the newest 50 events in the DOM, aggregate counts by flag offscreen, and coalesce bursts into animation frames. If more than 20 events arrive per second, pause DOM insertion and show "stream throttled" while preserving cached-at-startup classification counters.

---

## 10. Implementation Notes

Frontend split:

- `flags-matrix.js` owns catalog loading, table rendering, filters, roving focus, sovereign expansion, glyphs, and row state transitions.
- `override-strip.js` owns override count, last-set time, Reset all confirmation, and mutation calls.
- `eval-stream.js` owns SignalR event subscription, capped tail rendering, backpressure, and observation updates.

Dev-server split:

- `feature_flags_catalog.py` parses `FeatureNames.cs`, extracts XML summaries, indexes FM JSON, classifies rows, and computes `myWsTargeted`.
- `feature_overrides.py` owns the in-memory map, lock, mutation endpoints, and SignalR replay.
- Existing C# `EdogFeatureFlighterWrapper` changes from observational decorator to short-circuiting decorator with a static concurrent override dictionary. It must still publish every evaluation, including `overridden=true` when forced.

FM integration contract: EDOG never clones FeatureManagement from the browser. Dev-server maintains a local cache under the EDOG cache directory, refreshes nightly or on demand, parses locally, and serves enriched rows. Do not clone during this spec-writing phase.

Testing belongs to Sentinel in P2/P5: parser tests for const-name vs wire-key mismatch, FM shape mapping, partial target membership, override mutation/replay, cached classification, disconnected behavior, and eval stream backpressure.

---

## 11. Open Questions

1. Should the FM cache branch be exposed in Settings, or remain a hidden dev-server config defaulting to the current FeatureManagement default branch?
2. ~~Should target group detail reveal raw target values, or only group names and pivots, to avoid leaking large tenant lists into screenshots?~~ **Resolved (2026-05-16):** Gated reveal. Default state is summary-only (`pivot · N values`); raw values are revealed behind an explicit `Show values` click in the Flag Inspector. Screenshot-safe by default.
3. ~~Should locked partial rows distinguish "targeted by tenant" vs "targeted by workspace" in the main row, or only in tooltip/detail?~~ **Resolved (2026-05-16):** The cell-level purple dot stays the only row-level affordance ("your workspace matches"). Pivot kind (Tenant / Workspace / Capacity / Region / Member) is surfaced inside the Flag Inspector, not the matrix row.
4. Should Reset all require confirmation when only one override exists? Phantom v3 confirms globally; CEO may prefer one-click for low count.

## 12. Flag Inspector (v2 add-on, 2026-05-16)

Resolved Q2/Q3 above expand into a dedicated **Flag Inspector** view that swaps in over the matrix when the user clicks a flag name. Trigger is the flag name only — the STATE toggle in the matrix row keeps its independent click target.

**Sections (top-to-bottom):**

| Section | Content | Notes |
|---|---|---|
| Breadcrumb | `Environment › Feature Flags › <flagName>`  +  `← Back` | Restores matrix scroll position |
| Overview | Name, wire key, summary, "effective for your workspace" (`ON` / `OFF` / `FORCED`), source path (`Features/.../*.json`), `Open in repo ↗` link |  |
| Per-env targeting | One row per env (mainline first, sov-rollup, then expand-to-8). Each row: state label + target-group sub-list with `pivot · N values  [Show values]` gated reveal. | Sub-list capped at 100 values per group, with "+M more"; raw values stay hidden until clicked. |
| Override | Current override state + `Force ON` / `Clear override` primary button; shows the timestamp when the override was first stored. | No history timeline in V1 — only current state. |
| Raw FM definition | Collapsed `[Show raw definition]`. When expanded, pretty-printed JSON with syntax coloring (read-only). |  |

**Unevaluable cells:** target groups whose pivot is `RegionName` or `MemberOf` cannot be evaluated locally. In the matrix the cell renders `◐` with a diagonal-stripe hatch overlay (a `repeating-linear-gradient`) and a tooltip `"Cannot evaluate locally"`. In the Inspector the same row shows `Partial — cannot evaluate (RegionName, MemberOf)` instead of a target-group sub-list.

**Backend additions:** one new endpoint, `GET /api/edog/feature-flags/raw/{wireKey}`, returning `_FM_CACHE.get_definition(wireKey)` or 404. Catalog already supplies every other field.

**Out-of-scope for V1 (explicit):** override history / audit log, editing the FM definition, inline diff against another env.

