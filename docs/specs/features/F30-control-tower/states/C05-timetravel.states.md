# C05 Time Travel — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Time Travel — reconstruct flag posture at any historical date
> **Canonical data model:** [`data-model.md`](../data-model.md)
> **Component spec:** [`C05-timetravel.md`](../components/C05-timetravel.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoints:** `GET /api/ct/time-travel/bounds` → `TimeTravelBounds`; `POST /api/ct/time-travel/reconstruct` → `TimeTravelResponse`
> **Route:** `/travel` | Filter params: `date`, `flags`, `envs`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C05-S00` | Bounds loading | Navigate to `/travel`; `GET /api/ct/time-travel/bounds` in flight | Skeleton: timeline track (grey shimmer). Grid area shows live grid (or skeleton if cold). Date chip: "Loading date range…" | Track: disabled. Grid: live grid remains interactive (Time Travel is an overlay). Nav, Cmd-K enabled. | `G-DATA-NONE` (for TT) | Bounds arrive → `C05-S01`; error → `C05-S05` | C05 §4 `tt:loading-bounds` |
| `C05-S01` | Bounds ready — thumb at latest | Bounds API returned; thumb positioned at `latest` (most recent FLT commit date) | Timeline track rendered: track line from `earliest` to `latest` with change-point dots. Thumb at rightmost position. Grid shows live data (no AS OF banner). Date chip: "[latest date]". | Track: enabled (drag, click, arrow keys). Grid: interactive. Change-point dots: hoverable/clickable. | Bounds loaded; grid live | User drags thumb → `C05-S02`; clicks change-point → `C05-S02`; enters date → `C05-S02` | C05 §4 `tt:ready` |

### A.2 Reconstruction States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C05-S02` | Reconstructing | User moved thumb or entered date ≠ latest; `POST /api/ct/time-travel/reconstruct` in flight | Timeline: thumb frozen at selected position. Date chip: "[selected date]". Grid area: full-width skeleton rows (replacing live grid). AS OF banner: "Reconstructing state as of [date]…" `aria-busy="true"` on grid. | Track: disabled (thumb frozen). Grid: not interactive. Change-points: disabled. "Show diff only" toggle: disabled. | `G-DATA-NONE` (reconstruction in progress) | API returns → `C05-S03`; timeout → `C05-S06`; error → `C05-S07` | C05 §4 `tt:reconstructing` |
| `C05-S03` | Reconstructed — populated | API returned `TimeTravelResponse` | Grid shows historical state at `asOfDate`. Cells coloured by `TimeTravelCellState`: `on`, `off`, `conditional`, `targeted`, `not-yet-created`. Diff highlighting: cells that differ from current live state highlighted. AS OF banner: "Showing state as of [date]. [N] cells differ from today." "Show diff only" toggle available. Flag rows may have `existsAtDate === false` → entire row shows `not-yet-created`. | All: track (drag to new date), sort/filter on reconstructed rows (client-side), "Show diff only", change-points, nav. | `G-DATA-FULL` (for selected date) | Drag thumb to new date → `C05-S02`; click Today → `C05-S04`; close ✕ → exit TT mode | C05 §4 `tt:populated` |
| `C05-S04` | Live-equivalent | User selected latest date or clicked "Today" button | Grid shows live data (identical to non-TT view). AS OF banner dismissed. 600ms confirmation pulse animation. Track thumb at rightmost. | Full interactivity. Track still visible (can drag backward). | `G-DATA-FULL` (live) | Drag thumb → `C05-S02`; close ✕ → exit mode | C05 §4 `tt:populated:at-today` |

### A.3 Domain-Specific Variants

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C05-S03.a` | Not-yet-created flag row | `existsAtDate === false` for a flag at selected date | All 15 cells show special `not-yet-created` state (distinct from `off`): muted/hatched indicator. Row label: flag name + "(not yet created)". | C05-only CellState extension | C05 §2.1, §3.3 |
| `C05-S03.b` | Before first commit | Selected date is before the earliest FLT flag commit | All 42 rows show `not-yet-created`. AS OF banner: "No FLT flags existed on [date]." Empty-state illustration. | Edge case: all rows are `not-yet-created` | C05 §4 `tt:before-first-commit` |
| `C05-S03.c` | "Show diff only" active | User toggles "Show diff only" | Grid hides rows/cells that are identical to current live state. Only cells with `changedFromCurrent === true` visible. Screen reader announcement: "[N] rows hidden, showing [M] with differences." | Client-side filter on reconstructed data | C05 §7.4 |
| `C05-S03.d` | Mid-rollout date | Selected date falls during an active rollout (e.g. `test: on, prod: off` on that date) | Ladder-like visualization within the reconstructed grid: shows partial rollout progress at that point in time. Diff highlighting shows which envs have since changed. | Interesting for flag history analysis | (inferred from C05 + C03 data model) |
| `C05-S03.e` | Change-point dot | Thumb snapped to a change-point date | Change-point dot highlighted. Tooltip: "[N] flags changed on [date]". Date chip shows exact date. | Change-points are day-level grouped | C05 §2.2, §3.4 |
| `C05-S03.f` | Diff from current: cell | `changedFromCurrent === true` for a specific cell | Cell has diff highlight (e.g. subtle border or background tint). Tooltip: "Was [historical state], now [current state]." | Comparison is against `master` HEAD at `reconstructedAt`. **`reconstructedAt` is pinned at TT entry and does NOT advance on mid-session refresh (P3 gate ruling R3).** To use a refreshed baseline, exit and re-enter TT. | C05 §2.3, invariant 3; P3 gate ruling R3 |
| `C05-S03.g` | Cache hit | `cacheHit === true` in response | No visual difference — reconstruction was served from memo cache. Performance benefit only. | Memoized by `asOfDate + commitListHash` | C05 §2.3; architecture.md §6.1 |

### A.4 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C05-S05` | Bounds error | `GET /api/ct/time-travel/bounds` failed | Track area shows error: "Could not load date range — Retry". Grid remains in live mode (Time Travel unavailable). | Retry → `C05-S00`; use live grid | C05 §4 `tt:bounds-error` |
| `C05-S06` | Reconstruction timeout | Reconstruction exceeds 2s (warning) or 10s (auto-cancel) | At 2s: warning indicator "Reconstruction taking longer than expected…" At 10s: auto-cancel. Error message: "Reconstruction timed out — try a more recent date." Last-good reconstructed state retained (if any). | Retry (same date or different); select different date | C05 §5 |
| `C05-S07` | Reconstruction error | `POST /api/ct/time-travel/reconstruct` failed (5xx/network) | Error banner in grid area: "Could not reconstruct state as of [date] — Retry". Track remains interactive (can select different date). Last-good reconstruction retained. | Retry → `C05-S02`; select different date | C05 §4 `tt:error` |
| `C05-S07a` | Auth error on bounds/reconstruction | 401/403 | Standard auth redirect | `G-AUTH-EXPIRED` / `G-AUTH-FORBIDDEN` | C05 §5 |
| `C05-S08` | Out-of-range date entered | User manually entered a date outside `[earliest, latest]` | Date input shows red validation error. Date is clipped to nearest bound. Tooltip: "Date must be between [earliest] and [latest]." | User corrects date | C05 §3.2, §5 |

### A.5 Track / Interaction States

| State ID | Name | Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C05-S20` | Thumb drag in progress | User is dragging thumb along track | Thumb follows cursor. Date chip updates in real-time. No reconstruction fires until drag ends (debounce). Change-point dots glow when thumb passes near. | C05 §3.2 |
| `C05-S21` | Thumb snap to change-point | Thumb dragged near a change-point; default snap behaviour | Thumb snaps to nearest change-point date. Haptic/visual snap indicator. Alt key suppresses snap. | C05 §3.2 |
| `C05-S22` | Date chip click — manual entry | User clicks date chip to type a date | Date chip transforms to date input field. Keyboard entry with validation. `Enter` confirms → `C05-S02`. `Escape` cancels. | C05 §3.2 |
| `C05-S23` | Change-point dot hover | Mouse over a change-point dot on track | Tooltip: "[N] flags changed on [date]". Dot enlarges. | C05 §3.4 |
| `C05-S24` | Change-point dot click | User clicks a change-point dot | Thumb jumps to that date. Reconstruction fires (`C05-S02`). | C05 §3.4 |
| `C05-S25` | Keyboard arrow on track | Arrow Left/Right when track has focus | Thumb moves one change-point at a time. Alt+Arrow moves by 1 day (unsapping). Home → earliest. End → latest. | C05 §7.2 |
| `C05-S26` | Today button click | User clicks "Today" button | Thumb jumps to latest. If already at latest → live-equivalent pulse. If not → reconstruction fires then `C05-S04`. | C05 §3.2 |
| `C05-S27` | Close ✕ click | User clicks close button on TT panel | Time Travel mode exits. Grid returns to live view. Track hides. Focus returns to calendar icon (trigger element). | C05 §3.2, §4 |
| `C05-S28` | Mid-refresh reconstruction | Global refresh starts while TT is in `C05-S03` | **Reconstruction in progress completes first; refresh is queued until reconstruction finishes (P3 gate ruling GAP-07).** After queued refresh runs, `commitListHash` may change → memo invalidation. Bounds may change (new `latest`). **`reconstructedAt` remains pinned at TT entry (R3) — refresh does NOT advance the diff baseline.** | C05 §5; P3 gate rulings GAP-07, R3 |
| `C05-S09` | Cold-load interstitial | Navigated to `/travel` while `G-BOOT-PROGRESSIVE`; attribution data not yet available | Interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s. Nav enabled. | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any) | Navigate to `/travel` | `C05-S00` | Bounds fetch |
| `C05-S00` | Bounds API returns OK | `C05-S01` | Track renders; thumb at latest |
| `C05-S00` | Bounds API error | `C05-S05` | Track error; live grid remains |
| `C05-S00` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C05-S01` | User drags thumb to new date | `C05-S20` → drag end → `C05-S02` | Reconstruction fires |
| `C05-S01` | User clicks change-point | `C05-S24` → `C05-S02` | Reconstruction fires |
| `C05-S01` | User enters date manually | `C05-S22` → confirm → `C05-S02` | Reconstruction fires |
| `C05-S01` | URL has `?date=` | `C05-S02` | Reconstruction fires from URL param |
| `C05-S02` | Reconstruction succeeds | `C05-S03` | Historical grid renders |
| `C05-S02` | Reconstruction succeeds, date === latest | `C05-S04` | Live-equivalent (pulse) |
| `C05-S02` | Reconstruction times out (10s) | `C05-S06` | Timeout error; retain last good |
| `C05-S02` | Reconstruction error | `C05-S07` | Error banner; retain last good |
| `C05-S02` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C05-S03` | User drags thumb to new date | `C05-S02` | New reconstruction |
| `C05-S03` | User clicks "Today" | `C05-S02` → `C05-S04` | Live-equivalent |
| `C05-S03` | User toggles "Show diff only" | `C05-S03.c` | Filter rows |
| `C05-S03` | User clicks close ✕ | (live grid) | Exit TT mode |
| `C05-S03.c` | User toggles "Show diff only" off | `C05-S03` | All rows visible |
| `C05-S04` | User drags thumb backward | `C05-S02` | New reconstruction |
| `C05-S04` | User clicks close ✕ | (live grid) | Exit TT mode |
| `C05-S05` | Retry | `C05-S00` | Re-fetch bounds |
| `C05-S06` | Retry same date | `C05-S02` | Re-attempt reconstruction |
| `C05-S06` | Select different date | `C05-S02` | Different reconstruction |
| `C05-S07` | Retry | `C05-S02` | Re-attempt |
| `C05-S08` | User corrects date | `C05-S02` | Reconstruction fires |
| `C05-S28` | Queued refresh completes | `C05-S01` (bounds may have changed) | Re-fetch bounds; memo invalidated if commits changed; `reconstructedAt` stays pinned (R3) |
| (any) | Navigate to `/travel` during `G-BOOT-PROGRESSIVE` | `C05-S09` | Cold-load interstitial; 3s auto-retry |
| `C05-S09` | Attribution data arrives (`G-DATA-FULL`) | `C05-S00` | Bounds fetch fires |
| `C05-S09` | Navigate away | (target view) | Interstitial dismissed |

---

## C. URL / Filter-State Coupling

| State | URL example | Params |
|---|---|---|
| TT at specific date | `/travel?date=2026-03-10` | `date` |
| TT with flag filter | `/travel?date=2026-03-10&flags=FLT` | `date`, `flags` |
| TT with env filter | `/travel?date=2026-03-10&envs=prod,msit` | `date`, `envs` |

### C.1 Deep-link cold-load

1. `/travel?date=2026-03-10` → auth → bounds fetch → reconstruction at that date.
2. If warm store cold: bounds API may trigger cold-load. Reconstruction waits for relevant commit content.
3. If `date` is outside bounds: `C05-S08` (clipped).
4. If `date` absent: `C05-S01` (thumb at latest, no reconstruction).

### C.2 `asOfDate` semantics

- **Date-only, inclusive, end-of-day UTC** (C05 §2.3 Q1). `2026-03-10` means "state as of end of 2026-03-10 UTC".
- **`latest` is most recent FLT commit date**, not wall-clock today (C05 §2.2).
- **`authorDate`** (not `committerDate`) is the timestamp basis (C05 Q2).

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C05-S00` | C05 §4 `tt:loading-bounds` |
| `C05-S01` | C05 §4 `tt:ready` |
| `C05-S02` | C05 §4 `tt:reconstructing` |
| `C05-S03` | C05 §4 `tt:populated` |
| `C05-S03.a–g` | C05 §2.1–2.3, §3.3, §3.4, §7.4 |
| `C05-S04` | C05 §4 `tt:populated:at-today` |
| `C05-S05` | C05 §4 `tt:bounds-error` |
| `C05-S06` | C05 §5 (timeout) |
| `C05-S07` | C05 §4 `tt:error` |
| `C05-S08` | C05 §3.2, §5 (out-of-range) |
| `C05-S09` | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |
| `C05-S20–28` | C05 §3.2, §3.4, §7.2; P3 gate rulings GAP-07, R3 |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| ~~Mid-refresh reconstruction handling underspecified~~ | ~~MEDIUM~~ | **RESOLVED (P3 gate ruling GAP-07):** Reconstruction completes; refresh queues until reconstruction finishes. `reconstructedAt` pinned at TT entry (R3). |
| `not-yet-created` visual treatment unspecified | LOW | C05 §2.1 defines the state but C05 spec doesn't specify the visual (muted/hatched/etc). P4 mock must decide. |
| Diff highlighting visual unspecified | LOW | C05 §2.3 defines `changedFromCurrent` but the visual treatment (border? background? icon?) is not specified. P4 mock decides. |
| Day-level change-point grouping edge case | LOW | C05 §2.2 Q7: if multiple commits on the same day, one dot. What if the last commit of the day reverts the first? Change-point should still show (net change may be zero, but activity happened). |

---

**State count:** 29 distinct states (8 primary + 7 domain variants + 4 error + 1 cold-load interstitial + 9 interaction/track states)

*Sana — C05 Time Travel state matrix.*
