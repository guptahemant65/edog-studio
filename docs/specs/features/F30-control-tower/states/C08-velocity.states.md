# C08 Rollout Velocity — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Rollout Velocity — time-to-prod metrics, dwell statistics, and cohort trends
> **Canonical data model:** [`data-model.md`](../data-model.md) — 6-rung ladder, dwell rule (first-non-off, calendar days)
> **Component spec:** [`C08-velocity.md`](../components/C08-velocity.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoint:** `GET /api/ct/velocity` → `VelocityResponse`
> **Route:** `/velocity` | Filter params: `window`, `flags`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C08-S00` | Velocity loading | Navigate to `/velocity`; `GET /api/ct/velocity` in flight | Skeleton: KPI pills shimmer. Dot plot area shimmer. Cohort chart area shimmer. Flag table shimmer rows. | Disabled: window selector, search, row expand. Enabled: nav, Cmd-K | `G-DATA-NONE` | API returns → `C08-S01`; error → `C08-S05` | C08 §5 `loading` |

### A.2 Populated States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C08-S01` | Populated | API returned `VelocityResponse` with sufficient data | **KPI pills:** median TTP, mean TTP, in-flight count, fully-rolled-out count (`role="status"`). **Dot plot:** one dot per flag on X-axis (TTP days), Y-axis (flag index). Hover/click dots for detail. **Cohort chart:** per-rung median dwell bars. Hidden if < 3 data points. **Trend chart:** quarterly TTP trend line. Hidden if `trendByQuarter.length < 2`. **Flag table:** rows with flag name, TTP, highest rung, stale reason, expand chevron. | All: window selector, search, dot hover/click, row expand/collapse, Enter/Space on row, `/` for search | `G-DATA-FULL` | Filter; expand row; navigate | C08 §5 `populated` |
| `C08-S01a` | Populated — stale | Data age exceeds 60-min global stale threshold | Same as `C08-S01` + stale badge on data timestamp. Stale badges have explicit `aria-label`. | All controls enabled | `G-DATA-FULL` (stale) | Refresh | C08 §5 `populated-stale`; P3 gate ruling GAP-01 |
| `C08-S01b` | Loading-refresh | Refresh in progress while data exists | Existing KPIs, charts, and table remain visible. Thin progress bar at top. Refresh button disabled. | All controls on existing data | `G-DATA-FULL` (stale-while-refresh) | Refresh completes → `C08-S01` | C08 §5 `loading-refresh` |

### A.3 Domain-Specific Variants

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C08-S01.a` | Zero-day dwell | `dwellDays === 0` between consecutive rungs | Dwell entry: "0d" (valid, not an error). Tooltip: "Same-day promotion from [rungA] to [rungB]." | data-model.md §7 | C08 §2.4 |
| `C08-S01.b` | Skipped rung | A rung was never enabled (`skipped: true`) | In expanded flag row: rung shows "Skipped" with dash instead of date. No dwell from or to this rung. | Rung may be bypassed | C08 §2.4 |
| `C08-S01.c` | Pending dwell | Next rung not yet enabled (`dwellPending: true`) | In expanded flag row: dwell shows "Pending" with elapsed days since current rung enable. No end date. | Flag is in-flight | C08 §2.4 |
| `C08-S01.d` | In-flight flag | test enabled but prod not yet fully `'on'` | Flag row: TTP shows "In flight" instead of days. Dot plot: dot at right edge with arrow indicator. Stale reason may be `ACTIVE_ROLLOUT`. | `inFlight === true` | C08 §2.5 |
| `C08-S01.e` | Partial TTP | Prod has non-off state but never fully `'on'` | Flag row: "TTP (partial) — [N] days to first non-off in prod." Dot shows with different marker (e.g. hollow). | `TTP_partial` | C08 §2.3 |
| `C08-S01.f` | No test entry | `testFirstEnabledDate === null` — flag was never enabled in test | Flag row: "Never entered ladder" / "No test enable." No TTP. Not included in cohort stats. | Off-ladder from velocity perspective | C08 §2.2 |
| `C08-S01.g` | Cohort bars insufficient | A rung has < 3 fully-promoted flags for median calculation | Bar absent for that rung in cohort chart. Tooltip: "< 3 data points — insufficient for median." | C08 §2.6; C08 §4.3 |
| `C08-S01.h` | Trend chart hidden | `trendByQuarter.length < 2` | Trend section not rendered (not collapsed — absent). | Need ≥ 2 quarters of data | C08 §2.6; C08 §4.3 |
| `C08-S01.i` | Empty quarter in trend | A quarter has zero fully-rolled-out flags | Trend line shows data point at zero / gap marker. Not omitted from X-axis. | C08 §2.6 |
| `C08-S01.j` | History incomplete | `historyIncomplete === true` for a flag | Flag row: amber indicator "Incomplete history". TTP may be approximate. KPI pills footnote: "* [N] flags with incomplete history." | Per-flag degradation | C08 §3.1, §6 |
| `C08-S01.k` | Stale reason badges | `staleReason` on a flag row | Badge: `PROBABLY_LAUNCHED` / `PROBABLY_DEAD` / `PROBABLY_FORGOTTEN` / `ACTIVE_ROLLOUT`. Null = no badge (STABLE). | data-model.md §4 | C08 §2.7 |
| `C08-S01.l` | Off-ladder envs in expanded row | Expanded flag row shows onebox, bleu, sovereign states | Section: "Off-ladder environments" — env name + CellState. Not included in TTP/dwell. | C08 §2 | C08 §2 |
| `C08-S01.m` | `fromState === 'absent'` | File-creation commit (no prior state) | In expanded row timeline: "Flag file created" → initial state. `fromState` shown as "(new)". | C08 §2.1 OQ-2 |
| `C08-S01.n` | `bleu` labelling | `bleu` appears in off-ladder section | Labelled "(non-sovereign regional)" to avoid confusion with sovereign envs. | data-model.md §2.3 |

### A.4 Empty States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C08-S03` | Insufficient history | `fullyRolledOut + inFlight < 2` across all flags | Full-page info state: "Not enough rollout history to compute velocity metrics. At least 2 flags must have entered the promotion ladder." | Refresh when more flags exist | C08 §5 `insufficient-history`; `G-EMPTY-INSUFFICIENT` |
| `C08-S03a` | Search-empty | Search produces zero matching flag rows | "No flags match '[query]'." + "Clear search" link. KPIs remain (unfiltered). | Clear search | `G-EMPTY-FILTER` |

### A.5 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C08-S05` | Error — ADO unreachable | `error: true, code: 'ADO_UNREACHABLE'` | Error card: "Cannot reach Azure DevOps — Retry" | Retry → `C08-S00` | C08 §6 |
| `C08-S05a` | Error — rate limited | `code: 'RATE_LIMITED'` | Banner: "Rate limited — retrying in [N]s" with countdown. Auto-retry. | Auto-retry or manual | C08 §6 |
| `C08-S05b` | Error — partial | `code: 'PARTIAL'` | Available data rendered. Amber banner: "[N] flags could not be analyzed." `partialFlags` and `partialCohort` used. KPI pills footnote. | Refresh for complete data | C08 §6 |
| `C08-S05c` | Error — no flags found | `code: 'NO_FLAGS_FOUND'` | Error card (not empty): "No FLT flags found — verify FM repository." | Retry; verify repo | C08 §6 |
| `C08-S05d` | Error — parse | `code: 'PARSE_ERROR'` | Error card: "Could not parse velocity data — Retry" | Retry | C08 §6 |
| `C08-S05e` | Auth error | 401/403 | Standard handling | `G-AUTH-EXPIRED` / `G-AUTH-FORBIDDEN` | — |
| `C08-S06` | Cold-load interstitial | Navigated to `/velocity` while `G-BOOT-PROGRESSIVE`; attribution data not yet available | Interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s. Nav enabled. | Data arrives → `C08-S00`; navigate away | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |

### A.6 Interaction / Focus States

| State ID | Name | Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C08-S20` | Dot hover | Mouse over dot in dot plot | Tooltip: flag name, TTP value, highest rung, stale reason. | C08 §4.3 |
| `C08-S21` | Dot click | Click dot in dot plot | Scrolls flag table to corresponding row. Highlights row. | C08 §4.3 |
| `C08-S22` | Row expand | Click flag row or Enter/Space | Expanded detail: per-rung enable dates, dwell values, off-ladder envs, timeline of transitions. Collapse on re-click/Enter. | C08 §4.4, §4.5 |
| `C08-S23` | Search focused | `/` pressed or search clicked | Flag table filters. KPI pills remain unfiltered. | C08 §4.4, §4.6 |
| `C08-S24` | Window selector | User selects 7d / 30d / 90d / 1y | API re-fetches with new window param. Re-renders all sections. | C08 §4.2 |
| `C08-S25` | Keyboard nav | Up/Down on flag table | Focus moves between rows. Enter/Space expands. Escape clears search. | C08 §4.6 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any) | Navigate to `/velocity` | `C08-S00` | Velocity fetch |
| (any) | Navigate to `/velocity` during `G-BOOT-PROGRESSIVE` | `C08-S06` | Cold-load interstitial; 3s auto-retry |
| `C08-S06` | Attribution data arrives (`G-DATA-FULL`) | `C08-S00` | Velocity fetch fires |
| `C08-S06` | Navigate away | (target view) | Interstitial dismissed |
| `C08-S00` | API returns full data | `C08-S01` | All sections render |
| `C08-S00` | API returns insufficient | `C08-S03` | Info state |
| `C08-S00` | API returns partial | `C08-S05b` | Partial render + banner |
| `C08-S00` | API returns error | `C08-S05` | Error card |
| `C08-S00` | API returns rate-limited | `C08-S05a` | Countdown + auto-retry |
| `C08-S00` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C08-S01` | Stale timer | `C08-S01a` | Stale badge |
| `C08-S01` | Refresh clicked | `C08-S01b` | Progress bar; data remains |
| `C08-S01b` | Refresh succeeds | `C08-S01` | Updated data |
| `C08-S01b` | Refresh fails | `C08-S01a` (stale) | Error toast; data retained |
| `C08-S01` | Search → results | `C08-S01` (filtered) | Table filters |
| `C08-S01` | Search → no results | `C08-S03a` | Search-empty |
| `C08-S03a` | Clear search / Escape | `C08-S01` | Full table |
| `C08-S01` | Window change | `C08-S00` | Re-fetch with new window |
| `C08-S01` | Dot click | `C08-S21` → `C08-S01` | Row scrolled + highlighted |
| `C08-S01` | Row expand | `C08-S22` → `C08-S01` | Detail panel visible |
| `C08-S05` | Retry | `C08-S00` | Re-fetch |
| `C08-S05a` | Auto-retry succeeds | `C08-S01` | Data renders |
| `C08-S05a` | Retries exhausted | `C08-S05` | Error card |
| `C08-S03` | Refresh with new data | `C08-S00` → `C08-S01` | New data arrives |

---

## C. URL / Filter-State Coupling

| State | URL | Params |
|---|---|---|
| Default | `/velocity` | — |
| Window filter | `/velocity?window=90d` | `window` |
| Flag search | `/velocity?flags=FLTArtifact` | `flags` |
| Deep-link to flag | `/velocity?flag=FLTArtifactBasedThrottling` | `flag` (scrolls to row) |
| Combined | `/velocity?window=1y&flags=FLT` | `window`, `flags` |

### C.1 Deep-link cold-load

1. `/velocity?window=90d` → auth → `C08-S00` → API with `window=90d`.
2. If warm store cold → may need cold-load; velocity requires full history.
3. Malformed `window` value → silently use default (all time).

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C08-S00` | C08 §5 `loading` |
| `C08-S01` | C08 §5 `populated` |
| `C08-S01a` | C08 §5 `populated-stale` |
| `C08-S01b` | C08 §5 `loading-refresh` |
| `C08-S01.a–n` | C08 §2.1–2.7, §3.1, §4.3 |
| `C08-S03` | C08 §5 `insufficient-history` |
| `C08-S05–05e` | C08 §6 |
| `C08-S06` | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |
| `C08-S20–25` | C08 §4.3–4.6 |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| ~~C08 uses 15-min stale threshold (§5) vs 60-min global threshold~~ | ~~MEDIUM~~ | **RESOLVED (P3 gate ruling GAP-01):** 60-min stale threshold everywhere. C08's 15-min reference was a spec error. `C08-S01a` now uses 60-min globally. |
| Contract anchor (`FLTArtifactBasedThrottling`) validation not a runtime state | INFO | C08 §3.4 mentions contract anchor for testing, not a UI state. Correctly excluded from state matrix. |
| Calendar-day precision for dwell (§2 OQ-1) | LOW | Confirmed: calendar days only, no sub-day math. Consistent with data-model.md §7. |
| ADO commit pagination (§6 OQ-8) | LOW | Implementation detail, not a UI state. Correctly excluded. |

---

**State count:** 27 distinct states (4 primary + 14 domain variants + 2 empty + 6 error + 1 cold-load interstitial + 6 interaction)

*Sana — C08 Velocity state matrix.*
