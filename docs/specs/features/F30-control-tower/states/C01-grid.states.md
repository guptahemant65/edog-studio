# C01 Grid — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Rollout Posture Grid — the default landing view
> **Canonical data model:** [`data-model.md`](../data-model.md) — CellState, 15-env model, Attribution
> **Component spec:** [`C01-grid.md`](../components/C01-grid.md)
> **Global states:** [`_global.md`](./_global.md) — all `G-*` IDs defined there
> **API endpoint:** `GET /api/ct/grid` → `ControlTowerGridResponse`
> **Route:** `/` | Filter params: `q`, `state`, `envs`, `layer`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C01-S00` | Initial skeleton | Auth complete; `GET /api/ct/grid` in flight; warm store cold | 42 skeleton rows with shimmer animation. Column headers visible (env names). Sort/filter controls visible but disabled. Stats bar: "Loading…" | Disabled: sort, filter, search, cell click. Enabled: nav, theme toggle, sign-out | `G-DATA-NONE` | Grid API returns data → `C01-S01` or `C01-S02`; API error → `C01-S05`/`C01-S06` | C01 §4 `loading`; `G-BOOT-SKELETON` |
| `C01-S01` | Progressive — state only | Grid API returned with `G-DATA-STATE-ONLY` (cold-load phase 1 complete, ~4s) | 42 rows with CellState colour chips rendered. Attribution columns show shimmer. Stale/dwell columns show "—". Stats bar shows flag count. Shell progress: "Building attribution history…" | Enabled: sort by env state, filter by state, search by flag name, cell click → C02. Disabled: sort by attribution columns | `G-DATA-STATE-ONLY` | Attribution arrives → `C01-S02`; partial attribution → `C01-S04`; 401 → `G-AUTH-EXPIRED` | C01 §4 (inferred from OQ-03); `G-BOOT-PROGRESSIVE` |
| `C01-S02` | Fully hydrated | All data loaded; warm store warm | 42 rows fully rendered: CellState chips, attribution (author, PR link, date), stale reason badges, prerequisite indicators, rollout breadth. Stats bar: "[N] flags across 15 environments". Freshness chip green. | All controls enabled: sort, filter, search, cell click, sovereign expand/collapse, keyboard nav | `G-DATA-FULL` | Filter applied → `C01-S02` (same state, filtered subset); navigate away; refresh starts → `C01-S08` | C01 §4 `populated` |

### A.2 Empty States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C01-S03` | Filter-empty | Filters/search applied; zero matching rows | Empty illustration area: "No flags match your current filters" + "Clear all filters" link. Stats bar: "0 of [N] flags". Column headers still visible. Filter controls show active state. | Enabled: change/clear filters, search, nav, Cmd-K | `G-DATA-FULL` | Clear filters → `C01-S02`; change filter → `C01-S03` or `C01-S02` | C01 §3.9; C01 §4 `filter-empty`; `G-EMPTY-FILTER` |
| `C01-S03a` | Corpus-empty | API returned `flags: []` (no FLT flags in FM@master) | Full-width message: "No FLT flags found in FeatureManagement@master." No grid rendered. | Enabled: refresh, nav, sign-out | `G-DATA-FULL` (but empty) | Refresh succeeds with flags → `C01-S02` | C01 §4 `empty`; `G-EMPTY-NO-FLAGS` |

### A.3 Populated Variants (Domain-Specific)

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C01-S02.a` | All-on row | A flag has `CellState === 'on'` across all 15 envs | Row: 15 green chips. RolloutBreadth: "15/15". Badge: "Fully rolled out" if applicable. StaleReason may show `PROBABLY_LAUNCHED`. | Candidate for inert detection | C01 §3.6; C06 §4.3 |
| `C01-S02.b` | All-off row | A flag has `CellState === 'off'` across all 15 envs | Row: 15 grey/empty chips. RolloutBreadth: "0/15". StaleReason may show `PROBABLY_DEAD`. | May indicate a dead flag | C01 §3.6 |
| `C01-S02.c` | Mixed-state row | A flag has varying CellStates across envs | Row: mix of green (`on`), grey (`off`), blue (`conditional`), purple (`targeted`) chips. Normal for active rollouts. | Most common row type | C01 §3.6 |
| `C01-S02.d` | Conditional-only cell | Cell state is `'conditional'` | Cell chip: blue with `Requires` indicator. Hover tooltip shows predicate count (e.g. "2 conditions"). Click → C02 dossier with condition detail. | Reveal raw condition block in C02, never in grid | C01 §3.6; data-model.md §1 |
| `C01-S02.e` | Targeted-only cell | Cell state is `'targeted'` | Cell chip: purple with `Targets` indicator. Hover tooltip shows target type hint. Click → C02 dossier. | Reveal raw target block in C02, never in grid | C01 §3.6; data-model.md §1 |
| `C01-S02.f` | Single-env-only flag | A flag is non-off in exactly 1 environment | Row: 1 coloured chip, 14 grey. RolloutBreadth: "1/15". Could be `onebox` (pre-ladder dev) or sovereign-only. | Edge case for velocity/ladder views | C01 §3.6 |
| `C01-S02.g` | Sovereign expand | User toggled sovereign column group open | 7 sovereign env columns visible inline (mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary). Horizontal scroll may be needed. Sort/filter controls persist. | Collapse/expand toggle in header | C01 §3.11 |
| `C01-S02.h` | Removed-from-master flag | A flag existed in a previous commit but its file was deleted from master HEAD; flag retained in warm store | Row rendered with special badge: "Removed from master". All cells show `'off'`. StaleReason: `PROBABLY_DEAD`. Badge is informational only — no delete action. | Retained in warm store per GAP-10 resolution; removal from warm store is a separate admin action | P3 gate ruling GAP-10; C01 §4.2 (inferred) |
| `C01-S02.i` | Stale-reason badge variants | `StaleReason` is non-null | Badge next to flag name: `PROBABLY_LAUNCHED` (green-tinted), `PROBABLY_DEAD` (grey-tinted), `PROBABLY_FORGOTTEN` (amber-tinted), `ACTIVE_ROLLOUT` (blue-tinted). Null = no badge. | Badge colour must not rely on colour alone (text label always present) | C06 §4.3; data-model.md §4 |
| `C01-S02.j` | Prerequisite indicator | `prerequisiteIds` is non-empty array | Small dependency icon on cell or row. Tooltip: "Depends on: [flagNames]". If all prerequisites are non-FLT, icon still appears. | Never says "inert" in grid — that's C06's domain | C01 §4.2 |

### A.4 Partial / Degraded States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C01-S04` | Partial data | Some flags failed to mine (429 exhausted / timeout); rest succeeded | Grid renders available rows fully. Failed flags: CellState values shown, attribution columns show "—", no stale badge, no prerequisite info. Amber banner: "Some flag data incomplete — refresh to retry." | All controls enabled; failed rows are clickable (navigate to C02 which may also be partial) | `G-DATA-PARTIAL` | Refresh succeeds fully → `C01-S02` | architecture.md §6.5; C01 §4 `partial-error` |
| `C01-S04a` | Attribution absent for cell | Attribution is `null` for a specific cell | CellState chip renders normally. No "Last enabled by" / "Last modified by" line in tooltip. No "Unknown" placeholder. | Normal interactivity | `G-DATA-FULL` or `G-DATA-PARTIAL` | Attribution arrives (progressive fill) → populated | `G-ATTR-ABSENT`; C01 §4.2 |
| `C01-S04b` | Parse error cell | Flag JSON doesn't match any of the 4 CellState shapes | Cell shows `?` glyph. Tooltip: "Unexpected flag format — could not parse." Row otherwise renders normally. | Cell is not clickable to C02 (nothing to show) | `G-DATA-FULL` | FM repo corrected + refresh → normal cell | C01 §4.2 `G-ERR-PARSE` |
| `C01-S04c` | Integrity mismatch | `meta.flagCount !== flags.length` in API response | Amber banner: "Data integrity warning — expected [N] flags, received [M]." Grid renders received flags. | All controls enabled | `G-DATA-PARTIAL` | Refresh may resolve | C01 §4.2 |

### A.5 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C01-S05` | Error — no cache | `GET /api/ct/grid` failed (5xx/network); no warm store data | Full-width error card: "[Error message]" + Retry button. No grid rendered. | Enabled: Retry, nav, sign-out. Disabled: sort, filter, search | `G-DATA-NONE` | Retry succeeds → `C01-S00`; 401 → `G-AUTH-EXPIRED` | C01 §4 `error`; `G-ERR-5XX` |
| `C01-S06` | Error — with stale cache | `GET /api/ct/grid` failed; warm store has stale data (served with `stale: true`) | Grid renders stale data. Top banner: "Data may be outdated — last synced [time]. Retry" (red). Error badge on freshness chip. | All controls enabled on stale data; Retry button in banner | `G-DATA-FULL` (stale) | Retry/refresh succeeds → `C01-S02` | C01 §4 `error-with-cache`; architecture.md §7.2 |
| `C01-S07` | Rate limited | 429 received during grid fetch | If first load: banner "Rate limited — retrying in [N]s" with countdown + auto-retry. If stale data available: show stale grid + banner. Max 3 retries. | If showing stale data: controls enabled. If first load: only nav/sign-out | `G-DATA-NONE` or `G-DATA-FULL` (stale) | Auto-retry succeeds → `C01-S02`; retries exhausted → `C01-S04` or `C01-S05` | `G-ERR-429`; architecture.md §6.5 |

### A.6 Stale / Refresh States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C01-S08` | Refresh in progress | User clicked Refresh; `POST /api/ct/refresh` in flight | Grid remains visible with current data. Refresh button shows spinner + disabled. Freshness chip: "Refreshing…". No overlay blocks grid. | Grid fully interactive (sort, filter, search, click). Refresh button disabled. | `G-DATA-FULL` (stale-while-refresh) | Refresh completes → `C01-S09` or `C01-S10`; 401 → `G-AUTH-EXPIRED` | C01 §4 `refreshing`; `G-REFRESH-IN-PROGRESS` |
| `C01-S09` | Refresh success | Refresh completed; new data available | Grid re-renders with fresh data. Toast: "Data refreshed". Freshness chip resets. Stats bar may update if flag count changed. | All controls enabled. Refresh button re-enables after 3s cooldown. | `G-DATA-FULL` | Cooldown expires → `C01-S02` | `G-REFRESH-SUCCESS` |
| `C01-S10` | Refresh failed — atomic rollback | Refresh API returned ANY partial or full failure | **Atomic rollback: grid retains ALL pre-refresh data at last-good vintage. No mixed-vintage rows.** Toast: "Refresh incomplete — showing last-good data from {time}. Retry." Freshness chip: red. Refresh button re-enables. | All controls enabled on last-good data. Retry available. | `G-DATA-FULL` (stale) | Retry refresh → `C01-S08` | `G-REFRESH-FAILED`; P3 gate ruling R2 |
| `C01-S11` | Stale indicator | `syncedAt > 60 min` and no refresh in progress | Grid renders normally. Amber freshness chip: "Data as of [time] — Refresh". Optional: amber top-border on grid container. | All controls enabled. | `G-DATA-FULL` (stale) | User starts refresh → `C01-S08`; stale timer continues ticking | `G-STALE`; `G-REFRESH-STALE-IDLE` |

### A.7 Selection / Focus / Keyboard States

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C01-S20` | Row hover | Mouse enters a grid row | Row background highlight (subtle). Cell tooltips show on 300ms delay. | Hover exits on mouse-leave | C01 §3.6 |
| `C01-S21` | Cell hover tooltip | Mouse hovers over a cell for ≥300ms | Tooltip: CellState label + attribution summary (if available). For `conditional`/`targeted`: predicate/target count. | Tooltip dismissed on mouse-leave or `Escape` | C01 §3.6 |
| `C01-S22` | Focus-visible cell | Keyboard focus moves to a cell (arrow keys / Tab) | Focus ring (2px, ≥3:1 contrast) around cell. Cell tooltip does NOT auto-show on keyboard focus (tooltip is mouse-only; screen readers use `aria-label`). | `G-A11Y-FOCUS-VISIBLE` | C01 §5.1, §5.4 |
| `C01-S23` | Row selected (focused row) | Arrow Up/Down moves focus to a row | Row receives focus indicator. `Enter`/`Space` navigates to C02 for that flag. | Only one row focused at a time | C01 §5.1 |
| `C01-S24` | Search focused | User presses `/` or clicks search input | Search input receives focus. Typing filters grid in real-time. `Escape` clears search and returns focus to grid. | `/` shortcut only works when no input is focused | C01 §5.1; C01 §3.9 |
| `C01-S25` | Sort active | User clicks a column header to sort | Header shows sort direction indicator (▲/▼). Grid re-sorts. Clicking again cycles: unsorted → asc → desc. Last-activated sort wins. | Multiple sort not supported; last click wins | C01 §3.2; C01 §4.2 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| `C01-S00` | Grid API returns state-only data | `C01-S01` | Render grid with CellState chips; shimmer for attribution |
| `C01-S00` | Grid API returns full data | `C01-S02` | Render fully hydrated grid |
| `C01-S00` | Grid API returns 401 | `G-AUTH-EXPIRED` | Toast + redirect |
| `C01-S00` | Grid API returns 403 | `G-AUTH-FORBIDDEN` | Access denied page |
| `C01-S00` | Grid API returns 5xx / network error, no cache | `C01-S05` | Error card |
| `C01-S00` | Grid API returns 5xx, stale cache available | `C01-S06` | Stale grid + error banner |
| `C01-S00` | Grid API returns 429 | `C01-S07` | Rate-limited; auto-retry |
| `C01-S00` | Grid API returns `flags: []` | `C01-S03a` | Corpus-empty message |
| `C01-S01` | Attribution + derivations arrive | `C01-S02` | Fill attribution/stale/prereq columns; dismiss progress |
| `C01-S01` | Attribution partially fails | `C01-S04` | Fill available; "—" for failed; amber banner |
| `C01-S01` | 401 during attribution walk | `G-AUTH-EXPIRED` | Session expired |
| `C01-S01` | User applies filter | `C01-S01` (filtered) | Filter on state-only data; some filters may be limited |
| `C01-S01` | User clicks cell → navigate to C02 | C02 loads | Grid state preserved in URL |
| `C01-S02` | User applies filter → zero results | `C01-S03` | Filter-empty message |
| `C01-S02` | User applies filter → some results | `C01-S02` (filtered) | Grid shows matching subset |
| `C01-S02` | User clears all filters | `C01-S02` (unfiltered) | Full grid |
| `C01-S02` | User clicks cell/row → navigate to C02 | C02 loads | Push to `/flag/:flagId`; grid state in URL preserved |
| `C01-S02` | User clicks column header (sort) | `C01-S25` → `C01-S02` | Grid re-sorts |
| `C01-S02` | User presses `/` | `C01-S24` | Search input focused |
| `C01-S02` | User clicks Refresh | `C01-S08` | Refresh flow starts |
| `C01-S02` | Stale timer fires (>60 min) | `C01-S11` | Amber freshness chip |
| `C01-S02` | User expands sovereign columns | `C01-S02.g` | 7 additional columns visible |
| `C01-S02` | 401 on any subsequent API call | `G-AUTH-EXPIRED` | Toast + redirect |
| `C01-S03` | User clears filters | `C01-S02` | Full grid restored |
| `C01-S03` | User changes filter → results exist | `C01-S02` (filtered) | Grid shows results |
| `C01-S03a` | User clicks Refresh | `C01-S08` | Refresh attempt |
| `C01-S04` | User clicks Refresh | `C01-S08` | Full refresh attempt |
| `C01-S05` | User clicks Retry | `C01-S00` | Re-fetch grid |
| `C01-S06` | User clicks Retry/Refresh | `C01-S08` | Refresh attempt on stale data |
| `C01-S07` | Auto-retry succeeds | `C01-S02` | Grid renders |
| `C01-S07` | Retries exhausted, no cache | `C01-S05` | Error card |
| `C01-S07` | Retries exhausted, stale cache | `C01-S06` | Stale grid + error |
| `C01-S08` | Refresh succeeds | `C01-S09` | Toast; grid re-renders |
| `C01-S08` | Refresh fails (any partial or full failure) | `C01-S10` | Atomic rollback; error toast; last-good data kept |
| `C01-S08` | 401 during refresh | `G-AUTH-EXPIRED` | Session expired |
| `C01-S08` | User navigates away mid-refresh | (destination view) | Refresh continues in background; grid state preserved |
| `C01-S09` | 3s cooldown expires | `C01-S02` | Refresh button re-enables |
| `C01-S10` | User clicks Retry | `C01-S08` | Retry refresh |
| `C01-S11` | User clicks Refresh or freshness chip | `C01-S08` | Refresh starts |
| `C01-S20` | Mouse leaves row | `C01-S02` | Row highlight removed |
| `C01-S21` | Mouse leaves cell or Escape | `C01-S02` | Tooltip dismissed |
| `C01-S24` | Escape pressed | `C01-S02` | Search cleared; focus returns to grid |
| `C01-S24` | Typing produces results | `C01-S02` (filtered) | Grid filters in real-time |
| `C01-S24` | Typing produces zero results | `C01-S03` | Filter-empty |

---

## C. URL / Filter-State Coupling

### C.1 URL structure

| State | URL example | Filter params in URL |
|---|---|---|
| Default (unfiltered, unsorted) | `/` | (none) |
| Search active | `/?q=Throttling` | `q=Throttling` |
| State filter | `/?state=conditional` | `state=conditional` |
| Stale filter | `/?stale=1` | `stale=1` |
| Ladder filter | `/?ladder=1` | `ladder=1` |
| Sort | `/?sort=breadth-desc` | `sort=breadth-desc` |
| Combined | `/?q=FLT&state=on&sort=breadth-desc` | `q=FLT&state=on&sort=breadth-desc` |
| Env filter | `/?envs=prod,msit,dxt` | `envs=prod,msit,dxt` |
| Layer filter | `/?layer=ladder` or `/?layer=sovereign` | `layer=ladder` or `layer=sovereign` |

### C.2 Deep-link cold-load behaviour

1. User opens `/?q=Throttling&state=on` directly (no prior session).
2. If no session → `G-AUTH-PENDING` → `G-AUTH-REDIRECT` → auth flow → return to same URL.
3. `C01-S00` (skeleton) with URL params preserved.
4. Grid API returns data → `C01-S01` or `C01-S02`.
5. Filter params applied client-side to the response.
6. If filter produces zero results → `C01-S03`.

### C.3 URL ↔ state sync

- **Filter changes use `router.replace()`** — no history entry per keystroke.
- **Navigation to C02 uses `router.push()`** — creates history entry; back returns to grid with filters.
- **Sovereign expand is NOT in URL** — it's a visual toggle, not a filter.
- **Sort is in URL** — allows sharing sorted views.
- **Malformed params silently ignored** — unknown params stripped; invalid `state` value treated as no filter.

---

## D. Source Trace

| State ID | Primary source | Secondary source |
|---|---|---|
| `C01-S00` | C01 §4 `loading` | `G-BOOT-SKELETON` |
| `C01-S01` | OQ-03 progressive rendering | C01 §4 (inferred); architecture.md §8.1 |
| `C01-S02` | C01 §4 `populated` | — |
| `C01-S03` | C01 §4 `filter-empty`; C01 §3.9 | `G-EMPTY-FILTER` |
| `C01-S03a` | C01 §4 `empty` | `G-EMPTY-NO-FLAGS` |
| `C01-S02.a–j` | C01 §3.6; C01 §4.2; data-model.md §1, §3, §4 | C06 §4.3 (stale reason) |
| `C01-S04` | C01 §4 `partial-error` | architecture.md §6.5 |
| `C01-S04a` | C01 §4.2; data-model.md §3 | `G-ATTR-ABSENT` |
| `C01-S04b` | C01 §4.2 parse error `?` | `G-ERR-PARSE` |
| `C01-S04c` | C01 §4.2 integrity mismatch | — |
| `C01-S05` | C01 §4 `error` | `G-ERR-5XX` |
| `C01-S06` | C01 §4 `error-with-cache` | architecture.md §7.2 |
| `C01-S07` | architecture.md §6.5 (429 handling) | `G-ERR-429` |
| `C01-S08` | C01 §4 `refreshing` | `G-REFRESH-IN-PROGRESS` |
| `C01-S09` | C01 §6 refresh cooldown | `G-REFRESH-SUCCESS` |
| `C01-S10` | (inferred from refresh machine) | `G-REFRESH-FAILED` |
| `C01-S11` | architecture.md §6.3 | `G-STALE` |
| `C01-S20` | C01 §3.6 hover | — |
| `C01-S21` | C01 §3.6 tooltip (300ms) | — |
| `C01-S22` | C01 §5.1, §5.4 | `G-A11Y-FOCUS-VISIBLE` |
| `C01-S23` | C01 §5.1 keyboard nav | — |
| `C01-S24` | C01 §5.1 `/` shortcut; C01 §3.9 | — |
| `C01-S25` | C01 §3.2 sort | C01 §4.2 sort conflict |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| C01 spec does not explicitly define `C01-S01` (progressive state-only) | LOW | OQ-03 mandates progressive rendering, but C01 §4 does not list a separate state for state-only data. This matrix fills the gap. |
| ~~Deleted-from-master flag (`C01-S02.h`) behaviour not specified~~ | ~~LOW~~ | **RESOLVED (P3 gate ruling GAP-10):** Deleted-from-master flags retained in warm store with "Removed from master" badge. Architecture §3 confirms retention. |
| Sovereign expand state not URL-encoded | INFO | Intentional per C01 §3.11 — not a filter, just a visual toggle. Confirmed acceptable. |
| Long description (>500 chars) tooltip truncation threshold not in data-model.md | LOW | C01 §4.2 mentions it but the threshold should be in data-model.md. |

---

**State count:** 25 distinct states (12 primary + 10 populated variants + 3 interaction sub-states)

*Sana — C01 Grid state matrix. Every state ID traces to a spec section or a gap.*
