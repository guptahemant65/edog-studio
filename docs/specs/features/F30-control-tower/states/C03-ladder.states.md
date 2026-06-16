# C03 Promotion Ladder — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Rollout Ladder — distribution overview + per-flag ladder detail
> **Canonical data model:** [`data-model.md`](../data-model.md) — 6-rung ladder: test → cst → daily → dxt → msit → prod
> **Component spec:** [`C03-ladder.md`](../components/C03-ladder.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoints:** `GET /api/ct/ladder/distribution` → `LadderDistributionResponse`; `GET /api/ct/ladder/flag/:flagId` → `PerFlagLadderResponse`
> **Route:** `/ladder` | Filter params: `flag`, `rung`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Distribution Sub-View (default when no `?flag=` param)

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C03-S00` | Distribution loading | Navigate to `/ladder`; `GET /api/ct/ladder/distribution` in flight | Skeleton: spine with 6 shimmer rung nodes + shimmer cohort cards. Stats area shimmer. | Disabled: cohort click, rung click, search. Enabled: nav, Cmd-K | `G-DATA-NONE` | API returns → `C03-S01`; error → `C03-S05` | C03 §4.1 `dist-loading` |
| `C03-S01` | Distribution populated | API returned `LadderDistributionData` | Spine visualization: 6 rung nodes (test→prod) with counts. Cohort cards below each rung showing flag chips. Summary stats: total flags, fully promoted count, median TTP. | All controls enabled: click cohort, click rung, search, refresh | `G-DATA-FULL` | Click flag chip → `C03-S10`; filter; navigate | C03 §4.1 `dist-populated` |
| `C03-S02` | Distribution stale | API returned with `stale: true` | Same as `C03-S01` + amber stale indicator (inherits `G-STALE`). | All controls enabled | `G-DATA-FULL` (stale) | Refresh → `C03-S00`; stale timer continues | C03 §4.1 `dist-stale` |
| `C03-S03` | Distribution empty | API returned `totalFlags === 0` | Message: "No FLT flags found in scope." No spine visualization. | Refresh, nav | `G-DATA-FULL` (empty) | Refresh with flags → `C03-S01` | C03 §4.1 `dist-empty`; `G-EMPTY-NO-FLAGS` |

### A.2 Distribution Error States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C03-S05` | Distribution error — no cache | API failed (5xx/network); no stale data | Error card: "[message]" + Retry button. No spine. | Retry, nav | `G-DATA-NONE` | Retry → `C03-S00` | C03 §4.1 `dist-error` |
| `C03-S06` | Distribution error — stale fallback | API failed; `staleData` available in response | Stale distribution rendered + red error banner: "Could not refresh — showing cached data from [time]." | All controls on stale data; Retry | `G-DATA-FULL` (stale) | Retry → `C03-S00` | C03 §4.1 `dist-error-stale` |

### A.3 Per-Flag Ladder Sub-View (when `?flag=` present)

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C03-S10` | Per-flag loading | Navigate to `/ladder?flag=:flagId`; API in flight | Skeleton: spine with 6 shimmer rung nodes. Flag name in breadcrumb: "Ladder ▸ [flagId]". | Disabled: rung expand, dwell hover. Enabled: back, nav | `G-DATA-NONE` | API returns → `C03-S11`; error → `C03-S15` | C03 §4.2 `flag-loading` |
| `C03-S11` | Per-flag — fully attributed | API returned `PerFlagLadderData` with `attributionQuality === 'full'` | Spine: 6 rung nodes. Each non-off rung shows CellState chip + reached date + attribution (author, PR). Dwell segments between consecutive rungs with day count. Off rungs show grey node + "Not reached". `testToProdMs` summary if fully promoted. Off-ladder envs listed separately. | All controls: expand rung for transition history, hover dwell, click PR links, back to distribution | `G-DATA-FULL` | Expand rung → `C03-S11.a`; back → `C03-S01`; navigate | C03 §4.2 `flag-populated-full` |
| `C03-S12` | Per-flag — partial attribution | `attributionQuality === 'partial'` | Same as `C03-S11` but some rungs lack author/PR info. Attribution lines absent for those rungs (not "Unknown"). Amber banner: "Some attribution data unavailable." | All controls enabled | `G-DATA-PARTIAL` | Refresh → full; back | C03 §4.2 `flag-populated-partial` |
| `C03-S13` | Per-flag — state only | `attributionQuality === 'state-only'` (cold-load) | Spine: rung nodes show CellState only (on/off/conditional/targeted). No dates, no attribution, no dwell. Banner: "Attribution history loading…" | Rung expansion disabled (no history to show). Back, nav enabled. | `G-DATA-STATE-ONLY` | Attribution arrives → `C03-S11` or `C03-S12` | C03 §4.2 `flag-populated-state-only` |

### A.4 Per-Flag Domain Variants

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C03-S11.a` | Rung transition expanded | User clicked/Enter on a non-off rung node | Expanded section: transition history for that rung. Shows state changes with dates + authors. Diff link (lazy-loaded). | Only one rung expanded at a time? (C03 spec doesn't restrict) | C03 §3.3.2 |
| `C03-S11.b` | Skipped rung | A ladder rung is `'off'` while a later rung is non-off | Rung node: grey with "Skipped" label. No dwell to this rung. Dwell gap rendered as dashed line. | Unusual but valid (e.g. `test: on, cst: off, daily: on`) | C03 §3.3.2 |
| `C03-S11.c` | Same-day advance | `dwellDays === 0` between consecutive rungs | Dwell segment shows "same day" label instead of "0d". | data-model.md §7 | C03 §3.3.2 |
| `C03-S11.d` | Fully promoted | `isFullyPromoted === true` (all 6 ladder rungs are `'on'`) | Summary card: "Fully promoted — test to prod in [N] days". Green completion badge on spine endpoint. | Only when ALL 6 are `'on'`, not `'conditional'`/`'targeted'` | C03 §1.3; C03 §2.2 |
| `C03-S11.e` | Graduation rendering | A rung transitioned from `'targeted'` → `'on'` or `'conditional'` → `'on'` | Timeline entry in rung expansion shows both events: initial enable (e.g. `targeted` at date X) and graduation (`on` at date Y) as separate entries. | Graduation is a separate timeline event, NOT folded into dwell | data-model.md §7; C03 §3.3.2 |
| `C03-S11.f` | Off-ladder envs section | Flag has non-off state in off-ladder envs (onebox, bleu, sovereigns) | "Off-ladder environments" section below spine: lists non-off envs with their CellState. `bleu` labelled "(non-sovereign regional)"; `onebox` labelled "(pre-ladder dev)". | Never included in ladder/dwell/TTP calc | C03 §1.2; C03 §3.4; data-model.md §2.3 |
| `C03-S11.g` | Conditional/targeted on ladder rung | A ladder rung state is `'conditional'` or `'targeted'` (not `'on'`) | Rung node shows CellState chip with appropriate colour. "Reached" date uses first-non-off rule. Not counted as "fully promoted". | First-non-off dwell rule applies | data-model.md §7 |
| `C03-S11.j` | Regression badge | A rung was previously non-off but is now `'off'` (e.g. `prod: on → prod: off`) | Rung node shows: "Reached [date] · now OFF" regression badge. `firstEnabledDate` is immutable — promotion history preserved. `isFullyPromoted` becomes `false`. Regression event appears in rung expansion timeline as its own entry. | `firstEnabledDate` never resets (P3 gate ruling GAP-05) | P3 gate ruling GAP-05; C03 §5 Q4 |
| `C03-S11.h` | Diff — rung transition | User expands a rung and clicks diff for a specific transition | Lazy-loaded diff panel within expanded rung. Inline spinner → `EnvsDiff` or error. | Same 256 KB limit (OQ-04) | C03 §3.3.3 |
| `C03-S11.i` | Diff too large (rung) | Diff > 256 KB | "Diff exceeds 256 KB — View raw in repo ↗" | Identical to C02-S04 behaviour | OQ-04; C03 §3.3.3 |

### A.5 Per-Flag Error States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C03-S15` | Per-flag error | API failed (5xx/network) | Error card: "[message]" + Retry. Breadcrumb still works. | Retry → `C03-S10`; back to distribution | C03 §4.2 `flag-error` |
| `C03-S16` | Per-flag error — partial | API returned partial data (some history unavailable) | Spine renders with available data. Amber banner: "Some transition history unavailable." | Refresh; back | C03 §4.2 `flag-error-partial` |
| `C03-S17` | Per-flag not found | API returned 404 (`flagNotFound`) | Message: "Flag '[flagId]' not found." + back to distribution link. | Back → `C03-S01`; correct URL | C03 §4.2 `flag-not-found` |
| `C03-S18` | Cold-load interstitial | Navigated to `/ladder` while `G-BOOT-PROGRESSIVE`; attribution data not yet available | Interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s. Nav enabled. | Data arrives → `C03-S00`; navigate away | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |

### A.6 Interaction / Focus States

| State ID | Name | Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C03-S20` | Rung node hover | Mouse over rung node (distribution) | Tooltip: rung name + flag count + median dwell from previous rung. | C03 §3.2.4 |
| `C03-S21` | Dwell segment hover | Mouse over dwell track segment (per-flag) | Tooltip: "[N] calendar days from [rungA] to [rungB]". | C03 §3.2.4 |
| `C03-S22` | Cohort card hover | Mouse over flag chip in cohort | Chip highlight. Tooltip: flag name + current highest rung. | C03 §3.2.4 |
| `C03-S23` | Search focused | User types in search bar | Flag chips across cohorts filtered. Non-matching chips hidden. | C03 §3.2.4 |
| `C03-S24` | `?rung=` auto-expand | URL contains `?rung=msit` | Target cohort card auto-scrolled into view and expanded. | C03 §3.5 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any) | Navigate to `/ladder` | `C03-S00` | Distribution fetch |
| (any) | Navigate to `/ladder?flag=X` | `C03-S10` | Per-flag fetch |
| `C03-S00` | API returns OK | `C03-S01` | Spine + cohorts render |
| `C03-S00` | API returns stale | `C03-S02` | Stale indicator |
| `C03-S00` | API returns empty | `C03-S03` | Empty message |
| `C03-S00` | API returns error, no cache | `C03-S05` | Error card |
| `C03-S00` | API returns error, stale available | `C03-S06` | Stale render + error banner |
| `C03-S00` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C03-S01` | Click flag chip | `C03-S10` | Per-flag fetch |
| `C03-S01` | Click rung node | `C03-S24` (if deep-link) or scroll | Cohort expanded |
| `C03-S01` | Search typed | `C03-S23` → `C03-S01` (filtered) | Chips filtered |
| `C03-S01` | Stale timer | `C03-S02` | Amber indicator |
| `C03-S01` | Refresh clicked | `C03-S00` | Re-fetch distribution |
| `C03-S05` | Retry | `C03-S00` | Re-fetch |
| `C03-S06` | Retry | `C03-S00` | Re-fetch |
| `C03-S10` | API returns full | `C03-S11` | Full per-flag view |
| `C03-S10` | API returns partial | `C03-S12` | Partial attribution |
| `C03-S10` | API returns state-only | `C03-S13` | State-only view |
| `C03-S10` | API returns 404 | `C03-S17` | Not found |
| `C03-S10` | API returns error | `C03-S15` | Error card |
| `C03-S10` | API returns error, partial data | `C03-S16` | Partial + amber banner |
| `C03-S11` | Expand rung node | `C03-S11.a` | Transition history shown |
| `C03-S11.a` | Click diff link | `C03-S11.h` | Diff fetch fires |
| `C03-S11.h` | Diff succeeds | `C03-S11.a` (with diff) | Diff panel visible |
| `C03-S11.h` | Diff 413 | `C03-S11.i` | "View raw" link |
| `C03-S11.h` | Diff error | `C03-S11.h` (error) | Inline error + Retry |
| `C03-S11` | Click Back | `C03-S01` | Return to distribution |
| `C03-S13` | Attribution arrives | `C03-S11` or `C03-S12` | Full/partial render |
| `C03-S15` | Retry | `C03-S10` | Re-fetch per-flag |
| `C03-S17` | Back | `C03-S01` | Return to distribution |
| (any) | Navigate to `/ladder` during `G-BOOT-PROGRESSIVE` | `C03-S18` | Cold-load interstitial; 3s auto-retry |
| `C03-S18` | Attribution data arrives (`G-DATA-FULL`) | `C03-S00` | Distribution fetch fires |
| `C03-S18` | Navigate away | (target view) | Interstitial dismissed |

---

## C. URL / Filter-State Coupling

| State | URL | Params |
|---|---|---|
| Distribution (default) | `/ladder` | — |
| Distribution with rung focused | `/ladder?rung=msit` | `rung` |
| Distribution with search | `/ladder?flags=FLT` | `flags` (search string) |
| Per-flag view | `/ladder?flag=FLTArtifactBasedThrottling` | `flag` |

### C.1 Deep-link cold-load

1. `/ladder?flag=FLTArtifactBasedThrottling` → auth if needed → `C03-S10` → per-flag fetch.
2. If warm store cold → API may trigger cold-load → `C03-S13` (state-only) → progressive fill.
3. If flagId invalid → `C03-S17` (not found).

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C03-S00–S06` | C03 §4.1 distribution states |
| `C03-S10–S17` | C03 §4.2 per-flag states |
| `C03-S11.a–j` | C03 §3.3.2–3.3.3; data-model.md §7; P3 gate ruling GAP-05 (regression: S11.j) |
| `C03-S18` | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |
| `C03-S20–S24` | C03 §3.2.4; C03 §3.5 |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| ~~Rung regression semantics undefined~~ | ~~MEDIUM~~ | **RESOLVED (P3 gate ruling GAP-05):** `firstEnabledDate` is immutable. Regression renders "Reached [date] · now OFF" badge (`C03-S11.j`). `isFullyPromoted` becomes `false`. |
| `RegionName` / `MemberOf` predicates not evaluable locally | LOW | C03 §3.5.3: conditional rungs with these predicates can't be resolved. Shown as `'conditional'` with "Cannot evaluate locally" tooltip. |
| Multiple rung expansion policy | LOW | C03 spec doesn't restrict whether multiple rung transition panels can be open simultaneously. Defaulting to allow-multiple. |

---

**State count:** 30 distinct states (12 primary + 10 domain variants + 1 cold-load interstitial + 5 interaction + 1 rung auto-expand + 1 regression badge)

*Sana — C03 Ladder state matrix.*
