# C04 Activity Stream — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Activity Stream — chronological feed of all FLT flag changes
> **Canonical data model:** [`data-model.md`](../data-model.md)
> **Component spec:** [`C04-activity.md`](../components/C04-activity.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoints:** `GET /api/ct/activity` → `ActivityStreamResponse`; `GET /api/ct/activity/diff/:eventId` → `EnvDiffDetail`; `GET /api/ct/activity/timeline` → `TimelineSummaryResponse`
> **Route:** `/activity` | Filter params: `from`, `to`, `flags`, `envs`, `transitions`, `page`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C04-S00` | Activity loading | Navigate to `/activity`; API calls in flight (`/activity` + `/activity/timeline`) | Skeleton: timeline bar (grey shimmer) at top. Feed area: 6–8 skeleton event cards with shimmer. Date-range picker visible but disabled. Filter chips disabled. | Disabled: filters, detail expand, timeline dots. Enabled: nav, Cmd-K | `G-DATA-NONE` | APIs return → `C04-S01`; error → `C04-S05` | C04 §5.1 `loading` |
| `C04-S00a` | Cold-store accepted | API returns 202 Accepted (warm store still building) | Same skeleton as `C04-S00` + banner: "Data is being prepared — this may take a moment." Auto-retries after `Retry-After` header value. | Same as `C04-S00` | `G-DATA-NONE` | Retry succeeds → `C04-S01`; retry exhausted → `C04-S05` | C04 §9 |

### A.2 Populated States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C04-S01` | Activity populated | API returned events + timeline | Timeline dot strip at top (one dot per day with events). Event feed below: cards with flag name, env chip(s), transition arrow (e.g. `off → on`), author, timestamp, PR link. Pagination at bottom. Date-range picker active. Filter chips enabled. | All: date range, flag filter, env filter, transition filter, detail expand, timeline dot click, pagination, flag name → C02 | `G-DATA-FULL` | Filter → `C04-S01`; empty filter → `C04-S03`; detail expand → `C04-S10`; navigate | C04 §5.1 `populated` |
| `C04-S01a` | Content-change event | `transition === 'content-change'` (same shape, different block content) | Event card: "Content changed" label. Transition arrow: `conditional → conditional` or `targeted → targeted`. Detail diff shows actual JSON diff. | Same as `C04-S01` | `G-DATA-FULL` | — | C04 §2.1 |
| `C04-S01b` | Attribution label — "Last enabled by" | Transition ending in `'on'` from a non-on state | Event card shows: "Last enabled by [author]" | — | `G-DATA-FULL` | — | data-model.md §3.1 |
| `C04-S01c` | Attribution label — "Last modified by" | Any other transition | Event card shows: "Last modified by [author]" | — | `G-DATA-FULL` | — | data-model.md §3.1 |
| `C04-S01d` | Author unknown | `author === null` on an event | Event card: author shown as "(unknown author)". No link. | — | `G-DATA-FULL` | — | C04 §8 |
| `C04-S01e` | No PR link | `prNumber === null` | No PR link on event card. Author + commit hash + date still shown. | — | `G-DATA-FULL` | — | C04 §4.4; `G-ATTR-NO-PR` |
| `C04-S01f` | Multi-env event | A single commit changed a flag across multiple environments | Event card shows multiple env chips (e.g. `test`, `cst`, `daily`). Each chip coloured by transition type. | Click individual chip to filter? | `G-DATA-FULL` | — | C04 §2.1 |
| `C04-S01g` | Timeline cluster | Multiple events on the same day | Timeline dot strip: one dot per day. Dot size/intensity proportional to event count. Click dot → filters feed to that date. | Click dot, hover tooltip | `G-DATA-FULL` | — | C04 §2.6, §4.3, §6.6 |
| `C04-S01h` | New events detected (poll) | Update poll (`GET /api/ct/updates`) returned `newerHeadAvailable: true`; `G-POLL-NEWER-HEAD` active | Banner at top of feed: "{pendingCommitCount} new events available — Refresh". Timeline dot strip may show provisional new dot. Feed does NOT auto-scroll. **Fed by passive update poll (§4.4 of `_global.md`); no data mutation until user clicks Refresh.** | Click "Refresh" to trigger atomic refresh | `G-DATA-FULL` | User clicks "Refresh" → `G-REFRESH-IN-PROGRESS`; dismiss banner | P3 gate ruling GAP-06; C04 §4.3, §6.7 |

### A.3 Empty States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C04-S03` | Filter-empty | Filters produce zero results | Message: "No FLT flag activity matches your current filters." + "Widen date range" / "Clear filters" links. Timeline still shows full dot strip (unfiltered). | Change/clear filters, date range, nav | `G-DATA-FULL` | Change filters → `C04-S01`; clear → `C04-S01` | C04 §5.3; `G-EMPTY-FILTER` |
| `C04-S03a` | Date-range-empty | No events exist in the selected date range (even without other filters) | Message: "No FLT flag activity between [from] and [to]." + "Show all time" link. Timeline shows grey area for empty range. | Change date range, nav | `G-DATA-FULL` | Widen range → `C04-S01` | C04 §6.8; `G-EMPTY-DATE-RANGE` |
| `C04-S03b` | Corpus-empty | API returned zero events across all time (zero flags ever changed) | Message: "No FLT flag activity found in FeatureManagement@master." | Refresh, nav | `G-DATA-FULL` (empty) | Refresh with new data → `C04-S01` | `G-EMPTY-NO-FLAGS` (adapted) |

### A.4 Detail Sub-States (per event card)

| State ID | Name | Precondition / Trigger | What's rendered | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|
| `C04-S10` | Detail loading | User clicked "▸ Details" on an event card; `GET /api/ct/activity/diff/:eventId` in flight | Inline spinner within expanded card area. Card header remains visible. | `G-DATA-FULL` (detail pending) | Diff returns → `C04-S11`; error → `C04-S12` | C04 §5.2 `detail-loading` |
| `C04-S11` | Detail loaded | Diff API returned `EnvDiffDetail` | Expanded card shows: before/after JSON panels per env. `<pre role="code">` blocks. Commit hash link. | `G-DATA-FULL` | Collapse detail; navigate | C04 §5.2 `detail-loaded` |
| `C04-S12` | Detail error | Diff API failed | Inline error in expanded area: "Could not load diff — Retry" | `G-DATA-FULL` (detail failed) | Retry → `C04-S10` | C04 §5.2 `detail-error` |
| `C04-S12a` | Detail — diff too large | Diff API returns 413 | "Diff exceeds 256 KB — View raw in repo ↗" | `G-DATA-FULL` | — (permanent) | OQ-04 |

### A.5 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Exit conditions | Source |
|---|---|---|---|---|---|---|
| `C04-S05` | Feed error | Initial `GET /api/ct/activity` failed (5xx/network) | Error banner replaces feed area: "[message]" + Retry. Timeline may or may not render (depends on whether timeline API also failed). | Retry, nav, sign-out | Retry → `C04-S00` | C04 §5.1 `error` |
| `C04-S05a` | Feed error — auth | 401/403 on initial load | "Session expired" or "No access" message. | Sign-in / sign-out | Auth redirect or sign-out | C04 §8 |
| `C04-S06` | Refresh error | Refresh/auto-refresh failed while events already displayed | Non-blocking amber banner: "Refresh failed — showing previous data." Feed remains visible with stale events. | Dismiss banner, retry, all controls | Retry → `C04-S08`; dismiss | C04 §5.1 `error-refresh` |

### A.6 Data Gap / Degraded States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C04-S07` | Data gaps | Response includes `gaps[]` (diff computation failures) | Non-blocking amber banner: "Some event details could not be computed — [N] gaps." Feed renders available events; gap events show placeholder: "Details unavailable for this event." | C04 §2.4, §6.9 |
| `C04-S07a` | Timeline unavailable | `GET /api/ct/activity/timeline` failed independently while `/activity` succeeded | Feed renders normally without dot strip. Placeholder above feed: "Timeline unavailable." No blocking error. | P3 gate ruling GAP-13 |

### A.7 Stale / Refresh States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C04-S08` | Refreshing | Global refresh or auto-refresh in progress | Thin progress bar at top of feed. Existing events remain visible and interactive. New events (if any) will prepend on completion. | C04 §5.1 `refreshing` |
| `C04-S08a` | Stale | Data > 60 min old | Inherits `G-STALE`. Activity feed shows current data + shell stale indicator. | `G-STALE` |

### A.8 Interaction / Focus States

| State ID | Name | Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C04-S20` | Env chip click | User clicks env chip on event card | Toggles that env in the filter. Feed re-filters. | C04 §4.4 |
| `C04-S21` | Flag name click | User clicks flag name on event card | Navigates to C02: `/flag/:flagId` | C04 §4.4 |
| `C04-S22` | Timeline dot hover | Mouse over timeline dot | Tooltip: "[N] events on [date]" | C04 §4.3 |
| `C04-S23` | Timeline dot click | User clicks timeline dot | Feed filters to events on that date. Chip appears: "Showing [date]" with ✕ to clear. | C04 §4.3, §6.6 |
| `C04-S24` | Timestamp hover | Mouse over relative timestamp on event card | Tooltip: absolute UTC ISO-8601 timestamp | C04 §4.4 |
| `C04-S25` | Detail toggle (keyboard) | Enter/Space on focused "▸ Details" toggle | Same as click: expand/collapse. `aria-expanded` toggles. | C04 §6.7 |
| `C04-S26` | Search focused | `/` pressed or search clicked | Flag search input focused. Typing filters flag chips. `Escape` clears. | C04 §6.7 |
| `C04-S27` | Date picker validation | `dateTo < dateFrom` attempted | Picker blocks the invalid range. Visual error indicator on the invalid field. | C04 §8 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any) | Navigate to `/activity` | `C04-S00` | Activity + timeline fetch |
| `C04-S00` | APIs return data | `C04-S01` | Feed + timeline render |
| `C04-S00` | API returns 202 | `C04-S00a` | "Preparing data" banner; auto-retry |
| `C04-S00a` | Retry succeeds | `C04-S01` | Feed renders |
| `C04-S00a` | Retry exhausted | `C04-S05` | Error banner |
| `C04-S00` | API error | `C04-S05` | Error banner |
| `C04-S00` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C04-S01` | Apply filter → results exist | `C04-S01` (filtered) | Feed re-filters |
| `C04-S01` | Apply filter → zero results | `C04-S03` | Empty message |
| `C04-S01` | Change date range → no events | `C04-S03a` | Date-empty message |
| `C04-S01` | Click "▸ Details" | `C04-S10` | Diff fetch fires |
| `C04-S10` | Diff API succeeds | `C04-S11` | Diff panel renders |
| `C04-S10` | Diff API 413 | `C04-S12a` | "View raw" link |
| `C04-S10` | Diff API error | `C04-S12` | Inline error |
| `C04-S12` | Retry | `C04-S10` | Re-fetch diff |
| `C04-S01` | Click env chip | `C04-S20` → `C04-S01` | Filter toggled |
| `C04-S01` | Click flag name | `C04-S21` → C02 | Navigate to dossier |
| `C04-S01` | Click timeline dot | `C04-S23` → `C04-S01` | Feed filters to date |
| `C04-S23` | Click ✕ on date chip | `C04-S01` (unfiltered date) | Date filter cleared |
| `C04-S01` | Update poll detects newer HEAD | `C04-S01h` | "{pendingCommitCount} new events available — Refresh" banner |
| `C04-S01h` | Click "Refresh" | `C04-S08` | Atomic refresh fires; banner dismissed |
| `C04-S01` | Refresh starts | `C04-S08` | Progress bar |
| `C04-S08` | Refresh succeeds | `C04-S01` | Feed updated |
| `C04-S08` | Refresh fails | `C04-S06` | Amber banner; stale data |
| `C04-S01` | Stale timer | `C04-S08a` | Shell stale indicator |
| `C04-S03` | Clear filters | `C04-S01` | Full feed |
| `C04-S03a` | "Show all time" | `C04-S01` | Full date range |
| `C04-S05` | Retry | `C04-S00` | Re-fetch |
| `C04-S06` | Retry | `C04-S08` | Refresh retry |
| `C04-S27` | User corrects date | `C04-S01` or `C04-S03a` | Validation clears |

---

## C. URL / Filter-State Coupling

| State | URL example | Params |
|---|---|---|
| Default (last 30 days) | `/activity` | — |
| Date range | `/activity?from=2026-03-01&to=2026-03-31` | `from`, `to` |
| Flag filter | `/activity?flags=FLTArtifactBasedThrottling` | `flags` |
| Env filter | `/activity?envs=prod,msit` | `envs` |
| Transition filter | `/activity?transitions=off-on,targeted-on` | `transitions` |
| Pagination | `/activity?page=2` | `page` |
| Combined | `/activity?from=2026-01-01&to=2026-06-01&flags=FLT&envs=prod` | all |

### C.1 Deep-link cold-load

1. `/activity?from=2026-03-01&to=2026-03-31` → auth → `C04-S00` → API call with date params.
2. If warm store cold → 202 Accepted → `C04-S00a` → retry loop.
3. Malformed params (e.g. `from=xyz`) silently ignored; API uses defaults.

### C.2 Timeline dot → URL

Clicking a timeline dot sets `?from=DATE&to=DATE` (single-day filter) and adds a visual chip. Clearing the chip restores the previous date range.

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C04-S00` | C04 §5.1 `loading` |
| `C04-S00a` | C04 §9 (202 Accepted) |
| `C04-S01` | C04 §5.1 `populated` |
| `C04-S01a–h` | C04 §2.1, §2.2, §2.6, §4.3, §4.4, §6.6, §6.7, §8 |
| `C04-S03` | C04 §5.3; `G-EMPTY-FILTER` |
| `C04-S03a` | C04 §6.8 |
| `C04-S03b` | `G-EMPTY-NO-FLAGS` (adapted) |
| `C04-S05–06` | C04 §5.1, §8 |
| `C04-S07` | C04 §2.4, §6.9 |
| `C04-S07a` | P3 gate ruling GAP-13 |
| `C04-S08–08a` | C04 §5.1 `refreshing`; `G-STALE` |
| `C04-S10–12a` | C04 §5.2; OQ-04 |
| `C04-S20–27` | C04 §4.3, §4.4, §6.6, §6.7, §8 |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| Pagination default page size not specified | LOW | C04 §3.1 includes `pageSize` param but doesn't specify default. Recommend 25. |
| ~~Auto-refresh mechanism unspecified~~ | ~~MEDIUM~~ | **RESOLVED (P3 gate ruling GAP-06):** V1 includes passive update poll (60s interval, `GET /api/ct/updates`). Poll returns `newerHeadAvailable` + `pendingCommitCount` → surfaces "{pendingCommitCount} new events available — Refresh" banner (`C04-S01h`). Actual data refresh remains user-triggered + atomic. |
| ~~Timeline API failure independent from feed API~~ | ~~LOW~~ | **RESOLVED (P3 gate ruling GAP-13):** Feed renders with "Timeline unavailable" placeholder (`C04-S07a`). |

---

**State count:** 29 distinct states (8 primary + 8 populated variants + 4 detail sub-states + 1 timeline-unavailable + 8 interaction states)

*Sana — C04 Activity state matrix.*
