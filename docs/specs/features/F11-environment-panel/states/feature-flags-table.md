# Feature Flags Table — State Matrix

> **Feature:** F11 — Environment Panel
> **Component:** Card 3 — Feature Flags Matrix (`flags-matrix.js`, `override-strip.js`, `eval-stream.js`)
> **Companion:** `components/C03-feature-flags.md` (deep component spec) + `architecture.md` §3.5/§3.9 (override control plane + per-flag classification)
> **Owner:** Pixel (List/Table UX specialist) — in collaboration with Sana (state model) and Vex (endpoint shapes)
> **Total states:** 22 (4 lifecycle, 3 filter/search, 10 row states, 1 informational, 3 panel overlays, 1 modal)
> **Status:** SPEC COMPLETE (P3 deliverable, feeds P5 implementation)

---

## Table of Contents

1. [State Inventory](#1-state-inventory)
2. [State Transition Diagram](#2-state-transition-diagram)
3. [State Matrix Table](#3-state-matrix-table)
4. [Compound States (Overlay Composition)](#4-compound-states-overlay-composition)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Transition Summary Table](#6-transition-summary-table)

---

## 1. State Inventory

The component splits into **three layers** that operate independently:

- **Table-level lifecycle** (S01–S07): one of these is active at a time and governs whether the table is rendering, filtering, refreshing, or showing an empty state.
- **Row-level states** (S08–S18): each row sits in exactly one of these. The same table can show every row state simultaneously.
- **Panel-wide overlays** (S19–S21): coexist with any table state. Compose with row states rather than replacing them.
- **Modal** (S22): the partial-cell tooltip / target-groups dialog. Pre-empts focus but does not change table state.

| # | State ID | Layer | Description |
|---|----------|-------|-------------|
| S01 | `table.loading` | lifecycle | Catalog + overrides fetch in flight. Skeleton rows, search/filter disabled. |
| S02 | `table.error-catalog` | lifecycle | `GET /api/edog/feature-flags/catalog` failed. Inline error card with Retry. |
| S03 | `table.loaded` | lifecycle | Default rendered state. Rows visible, filters available, no input focus. |
| S04 | `table.refreshing-catalog` | lifecycle | User clicked Refresh in the KPI strip. Existing rows stay rendered (stale-while-revalidate); sync badge spins. |
| S05 | `table.searching` | filter | Search input has text. Rows filter live as user types (debounced 80 ms). |
| S06 | `table.filtered-empty` | filter | Search query or chip filter yields zero rows. Empty-state copy + "Clear filter" button. |
| S07 | `table.sovereign-expanded` | filter | User clicked the Sovereign(8) column header. All 8 sovereign columns visible; horizontal scroll active. Coexists with any other table state. |
| S08 | `row.locked` | row | CST is fully ON, or CST is partial AND `myWsTargeted === true`. STATE toggle renders ON with reduced opacity and a lock icon; cannot be operated. |
| S09 | `row.unlocked-idle` | row | FM evaluates false for this workspace. Toggle interactive, no override active. STATE shows OFF. Default resting state for a writable row. |
| S10 | `row.override-pending` | row | User toggled ON. Optimistic UI: thumb in the ON position with spinner; row disabled. POST `/overrides` in flight. |
| S11 | `row.override-applied-live` | row | `fltSync=applied` AND `evalClass=live`. Solid amber thumb; eval-count pulses confirm hits. Clean apply. |
| S12 | `row.override-applied-cached` | row | `fltSync=applied` AND `evalClass=cached`. Amber thumb + inline **[Restart FLT to apply]** chip. Override is in `EdogFeatureOverrideStore` but downstream FLT consumers cached the boolean at startup and won't re-evaluate. |
| S13 | `row.override-staged-unobserved` | row | `fltSync=applied` AND `evalClass=unobserved`. Amber thumb + watching indicator. No `IsEnabled()` evaluations observed yet; we can't disambiguate "code path not exercised" from "consumer captured pre-wrap reference" (see architecture §3.9). |
| S14 | `row.override-cached-local` | row | `fltSync=not-connected`. Amber thumb + "Will apply on FLT start" pill. Override stored in dev-server map; queued for replay when wrapper reconnects. |
| S15 | `row.override-wrapper-off` | row | `fltSync=wrapper-inactive`. Amber thumb + **[Restart FLT]** CTA in the row. POSTed to FLT, but `interceptors/status` reports `FeatureFlighter.Wrapped === false` — no `IsEnabled` call this session can hit our store. |
| S16 | `row.override-failed` | row | `fltSync=failed`. Red dot + Retry button + truncated `warning` reason. Map still has the entry; user must Retry or Clear. |
| S17 | `row.override-clearing` | row | User clicked the reset glyph or hit the override strip's Reset all. DELETE in flight; row disabled with spinner. |
| S18 | `row.missing-fm` | row | FLT declares the wire key but FM cache has no JSON. All env cells render `?`. Toggle is disabled; "missing in FM" badge shown. Informational only — no override is meaningful until FM defines the flag. |
| S19 | `panel.disconnected` | overlay | `GET /api/studio/status` reports `phase=disconnected`. Overlay banner at panel top: "FLT not connected — deploy to start observing." Row interactions still write to dev-server (→ `override-cached-local`). |
| S20 | `panel.wrapper-inactive` | overlay | Connected but `interceptors/status` reports wrapper not wired. Amber top banner: "Interceptor inactive — Restart FLT for overrides to take effect." Toggle still works; all override rows transition to `row.override-wrapper-off`. |
| S21 | `panel.fm-stale` | overlay | FM cache age past TTL OR `fm.error=true` in the last catalog response. Amber inline strip in the KPI row: "FM data last synced Nh ago — Refresh." Does not disable any interaction. |
| S22 | `cell.partial-tooltip-open` | modal | User pressed `Enter` on a partial (`◐`) cell or clicked it. Popover-style dialog lists target groups, pivots, and `includesMyWorkspace`. Focus trapped; `Escape` closes. |

---

## 2. State Transition Diagram

The diagram below shows the **table-level** lifecycle. Row states and panel overlays are described separately in §3 because they layer on top of any lifecycle state.

```
                ┌──────────────────────────────────────────┐
                │              page nav / Card open         │
                └────────────────────┬──────────────────────┘
                                     │
                                     ▼
                          ┌────────────────────┐
                          │   table.loading    │
                          │       (S01)        │
                          └─────────┬──────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  │                 │                 │
            catalog 5xx /     catalog 200 /     catalog 200 /
            network error     rows > 0          rows == 0
                  │                 │                 │
                  ▼                 ▼                 ▼
        ┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐
        │table.error-catalog│ │  table.loaded  │ │table.filtered-   │
        │      (S02)       │ │     (S03)      │ │     empty        │
        │                  │ │                │ │     (S06)        │
        │  [Retry]──────┐  │ │                │ │  [Clear filter]──┐
        └──────────────┼──┘ └────┬──────┬─────┘ └──────────────────┼┘
                       │         │      │                          │
                       └─────────┘      │                          │
                          retry         │ /  filter chip /         │ matching
                                        │ catalog refresh          │ rows appear
                                        │                          │
                                        ▼                          ▼
                              ┌──────────────────┐         ┌────────────────┐
                              │ table.searching  │◂───────▸│  table.loaded  │
                              │     (S05)        │  text   │     (S03)      │
                              └────────┬─────────┘  cleared└────────────────┘
                                       │
                       query yields 0  │  query yields ≥1
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ table.filtered-  │
                              │ empty (S06)      │
                              └──────────────────┘

                              ┌─────────────────────┐
                              │ table.refreshing-   │   Refresh button
        loaded ◂──────────────│ catalog (S04)       │◂──── (any state with
                              └─────────────────────┘     rows visible)

                              ┌─────────────────────┐
                              │ table.sovereign-    │   click Sovereign(8)
                              │ expanded (S07)      │◂──── header
                              └─────────────────────┘
                              (coexists with any other state — column overlay)
```

### Row state transitions (per row)

```
                                ┌────────────────┐
                                │  row.locked    │  CST=on, OR
                                │     (S08)      │  CST=partial & myWsTargeted
                                └────────────────┘
                                (terminal until catalog refresh)

         ┌────────────────────────────────────┐
         │       row.unlocked-idle  (S09)     │◂───┐
         └────────────────┬───────────────────┘    │
                          │                        │
              Space/click on toggle                │
              POST /overrides {flag, value:true}   │
                          ▼                        │
                ┌───────────────────────┐          │
                │ row.override-pending  │          │
                │       (S10)           │          │
                └──────┬────────────────┘          │
                       │                           │
   ┌───────────────────┴──────────────────────┐    │
   │           response received               │   │
   │       (fltSync × evalClass routing)        │   │
   └──┬───────┬───────┬─────────┬────────┬────┘    │
      │       │       │         │        │         │
      ▼       ▼       ▼         ▼        ▼         │
   ┌─────┐┌─────┐┌─────┐  ┌─────────┐┌────────┐    │
   │S11  ││S12  ││S13  │  │ S14     ││ S16    │    │
   │live ││cach ││unob │  │not-conn ││failed  │    │
   └──┬──┘└──┬──┘└──┬──┘  └────┬────┘└────┬───┘    │
      │     │       │           │          │        │
      │     │  evals seen       │   Retry  │        │
      │     │  ───────▸ S11     │ ─────────┘        │
      │     │                   │  Clear            │
      │     │  Restart FLT ──┐  │ ──────────────────┤
      │     │                │  │                   │
      │     └─────────────▸ S15 │                   │
      │            (after Restart, wrapper off)     │
      │                        │                   │
      │  reset glyph / Reset all (override-clearing)│
      └────────────────────────┴───────────────────▸│
                          ┌───────────────────────┐ │
                          │ row.override-clearing │ │
                          │       (S17)           │─┘
                          └───────────────────────┘
                          DELETE /overrides/{flag}
```

### Key Transition Rules

- **Lifecycle is mutually exclusive.** Exactly one of S01/S02/S03/S04/S05/S06 is active at any time. S07 (sovereign expansion) is a column-level overlay and may coexist with any of them.
- **Each row independently chooses one of S08–S18.** Different rows can be in different states simultaneously. The override strip count is `count(S10) + count(S11..S16) + count(S17 in flight)` minus pending clears.
- **Panel overlays S19–S21 are additive.** They don't prevent row interactions; they recolor the surrounding chrome and gate certain affordances (e.g., S19 forces every new override into S14 because there's nowhere to POST it).
- **`row.locked` is sticky during a session.** The only way out is a catalog refresh (S04) that changes FM truth for this workspace.
- **`row.missing-fm` is sticky until the FM cache is refreshed and the JSON appears.** The toggle is permanently disabled while in this state.
- **`override-pending → override-failed` does not roll back the optimistic UI immediately.** The thumb stays in the ON position with a red dot so the user understands what they tried to do — the state communicates "your write didn't land," not "we reverted you."
- **`override-pending → override-cached-local`** happens when dev-server detected `not-connected` during the POST. No actual HTTP round-trip to FLT was attempted; the override was queued for replay.

---

## 3. State Matrix Table

Each state is documented with the eight SOP fields: entry conditions, exit conditions, visual description, keyboard shortcuts, data requirements, transitions, error recovery, and notes where applicable.

---

### S01: `table.loading`

Initial fetch in flight. The table renders skeleton rows.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) Card 3 first becomes visible in the Environment Panel. (2) User triggered a full re-render (rare — e.g., FLT repo path changed in Settings, causing the catalog cache to invalidate). (3) Recovery transition from `table.error-catalog` after Retry. |
| **Exit conditions** | (1) `GET /api/edog/feature-flags/catalog` resolves with `rows.length > 0` → `table.loaded`. (2) `GET /api/edog/feature-flags/catalog` resolves with `rows.length === 0` and FLT repo is configured but empty → `table.filtered-empty` with synthetic "no flags declared" copy. (3) `GET` fails (network error, 5xx, or `>10s` timeout) → `table.error-catalog`. |
| **Visual description** | KPI strip renders with `…` placeholders for FLT count, FM count, live/cached/unknown counts, and sync age. Toolbar (search, classification chips, state chips) is rendered but `pointer-events: none` and reduced opacity (0.4). Five skeleton rows: each is a full-width `var(--surface-2)` block, 44 px tall, with a subtle `linear-gradient` shimmer animation (`prefers-reduced-motion: reduce` disables the gradient). No glyphs, no toggles. |
| **Keyboard shortcuts** | All shortcuts inert. `/` does nothing; arrow keys do nothing. `Escape` is reserved for the panel itself (not handled by Card 3 in this state). |
| **Data requirements** | One in-flight fetch: `GET /api/edog/feature-flags/catalog`. No SignalR subscription active yet. `_studio_state.phase` (from `GET /api/studio/status`) is required to know whether to also fetch `GET /api/edog/interceptors/status` in parallel. |
| **Transitions** | `→ table.loaded` (success, rows > 0). `→ table.filtered-empty` (success, rows === 0). `→ table.error-catalog` (failure). |
| **Error recovery** | A fetch timeout at 10 s aborts the request and transitions to `table.error-catalog` with `code: 'timeout'`. A 5xx returns the body's `error.message` as the recovery hint. A network error (no response) surfaces "Could not reach dev-server" copy. |
| **Notes** | The skeleton row count is **5**, not the eventual ~36, to keep the loading state perceptually short. If the catalog response is slower than ~150 ms we transition straight to the full table from S03; the skeleton exists for cold-cache loads only. |

---

### S02: `table.error-catalog`

Catalog endpoint failed. Inline error block replaces the table.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) Catalog fetch returned 4xx or 5xx. (2) Network error (DNS, connection refused, TLS). (3) 10 s timeout from `table.loading`. (4) JSON parse error on the response body. |
| **Exit conditions** | (1) User clicks **[Retry]** → `table.loading`. (2) Catalog auto-retry succeeds on its own (every 30 s up to 3 attempts) → `table.loaded`. (3) User navigates away from the panel; the state is held but not re-fetched until panel re-opens. |
| **Visual description** | Full card area replaced with an inline error block: 24 px `var(--level-error)` glyph (warning triangle), `text` title "Could not load FLT flag catalog", `text-dim` body containing `error.message` (truncated to 200 chars), and a primary `[Retry]` button + secondary `[Open dev-server logs]` link. KPI strip remains visible with stale values if any (otherwise zeros). Toolbar hidden entirely. |
| **Keyboard shortcuts** | `Tab` cycles between Retry and Open logs. `Enter` activates the focused button. Other shortcuts inert. |
| **Data requirements** | Holds the last error response in memory (`_lastCatalogError`). No fetch in flight in this state. The auto-retry timer is owned by `flags-matrix.js`. |
| **Transitions** | `→ table.loading` (user retry, or auto-retry attempt). After 3 failed auto-retries, the auto-retry timer stops; the user must Retry manually. |
| **Error recovery** | Same surface IS the recovery surface. After 3 failed auto-retries we change the title to "Repeated failures loading FLT flag catalog" and the body adds "Check that dev-server is running and the FLT repo path is configured." |
| **Notes** | Auto-retry uses exponential backoff: 2 s, 5 s, 15 s. The Retry button bypasses the backoff. |

---

### S03: `table.loaded`

Default resting state. Rows visible, no input focus, no in-flight mutations on visible rows.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) Catalog fetch succeeded with rows > 0 (from `table.loading`). (2) Search input cleared from `table.searching`. (3) Filter chip deselected. (4) `table.refreshing-catalog` completed. (5) The last in-flight per-row mutation resolved (the row itself transitions independently — see row states). |
| **Exit conditions** | (1) User types in search → `table.searching`. (2) User clicks a chip → filter applied; either remain in `table.loaded` (filtered subset shown) or transition to `table.filtered-empty`. (3) Refresh button → `table.refreshing-catalog`. (4) User clicks any row's toggle → that row transitions to `row.override-pending`. (5) Catalog auto-refresh on dev-server file watcher signal → `table.refreshing-catalog`. |
| **Visual description** | Full table rendered. KPI strip shows current counts (e.g., `36 FLT flags · 12,847 FM total · 18 live · 3 cached · 15 unobserved · synced 4m ago`). Toolbar shows search input (placeholder "Search flags…"), classification chips (`Operational`, `Behavioral`, `Internal`), state chips (`All`, `Enabled`, `Disabled`, `Partial`, `Overridden`, `Missing`). Each row shows: flag name, summary truncated to 60 chars, 7 mainline env cells, folded Sovereign(8) cell, STATE toggle. Override strip above the table is hidden unless `overrides.length > 0`. |
| **Keyboard shortcuts** | `/` focuses search → `keyboard.search-focused` interaction. Arrow Up/Down moves row focus (roving). Arrow Left/Right within a focused row moves cell focus. `Space` on a focused row toggles STATE. `Enter` on a partial cell opens `cell.partial-tooltip-open`. `r` triggers Refresh. `Escape` clears focus from the table. |
| **Data requirements** | (1) `_catalog` from `GET /api/edog/feature-flags/catalog` (rows + wire-key→FlagRow index). (2) `_overrides` from `GET /api/edog/feature-flags/overrides` (initial seed + SignalR `override-state` topic updates). (3) `_observed` per-flag eval aggregates streamed via SignalR `flag` topic. (4) `_fltConfig.workspaceId` from `GET /api/flt/config` (drives lock evaluation). (5) `_studioStatus.phase` and `_wrapperStatus.featureFlighterWrapped` (drive S19/S20 overlays). |
| **Transitions** | See exit conditions. Note that any row transition (S08–S18 changes) does not cause the table lifecycle to change. |
| **Error recovery** | If a SignalR update produces a malformed event, drop it silently (defensive parse) and continue. If the dev-server `/overrides` GET response drifts from local optimistic state, accept the server response as truth (server is authoritative — see architecture §3.6 write ordering). |
| **Notes** | This is the only state where the override strip can appear. It renders as a sticky row above the table when `overrides.length > 0`, showing `{count} overrides active · last set {relTime} · [Reset all]`. |

---

### S04: `table.refreshing-catalog`

Catalog re-fetch in flight. Existing rows remain visible (stale-while-revalidate).

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) User clicked **Refresh** in the KPI strip. (2) Dev-server signaled (via SignalR `catalog-invalidate` event) that the FM cache was updated by the nightly job or a manual `git fetch`. (3) User pressed `r` keyboard shortcut. (4) Catalog auto-refresh on FLT redeploy (`POST /api/studio/deploy` succeeded). |
| **Exit conditions** | (1) Refresh succeeds with rows > 0 → `table.loaded` (overrides preserved if their wire keys still exist; orphaned overrides logged to console and dropped). (2) Refresh succeeds with rows === 0 → `table.filtered-empty`. (3) Refresh fails → remain in `table.loaded` with a toast: "Refresh failed — showing last good data." |
| **Visual description** | Identical to `table.loaded` except: KPI sync badge is replaced with a spinning indicator + "Refreshing FM cache (this can take ~2 s)…". The Refresh button is disabled and shows a spinner. The rest of the table is fully interactive — user can still search, filter, toggle. Overrides issued during refresh queue and post once the new catalog is in. |
| **Keyboard shortcuts** | Same as `table.loaded`. `r` is a no-op while refresh is in flight. |
| **Data requirements** | One in-flight `GET /api/edog/feature-flags/catalog?force=1`. SignalR remains subscribed. `_overrides` and `_observed` continue to update through SignalR independently. |
| **Transitions** | `→ table.loaded` (success). `→ table.filtered-empty` (success but empty — rare). Stays in `table.loaded` on failure with toast. |
| **Error recovery** | A failed refresh leaves the previously-loaded catalog intact. The toast contains a "Retry" action. If three consecutive refreshes fail, the toast adds "Run `git fetch` manually in `<edog-cache>/featuremgmt` if FM repo became unreachable." |
| **Notes** | Performance budget per architecture §7: 2 s p95 for `force=1`. If a refresh exceeds 5 s, dev-server cancels the underlying `git fetch` subprocess and returns 504; we surface this as a "FM repo unreachable" toast that bridges into S21. |

---

### S05: `table.searching`

Search input has text. Live filter (80 ms debounce) applies to flag name AND wire key.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) User typed any character in the search input. (2) `/` keyboard shortcut focused the input and the user began typing. (3) Search input was paste-populated programmatically (e.g., a deep link from a Logs page error message — `?focus-flag=FLTEnableX`). |
| **Exit conditions** | (1) Input fully cleared (zero chars) → `table.loaded`. (2) `Escape` while input is focused → input clears → `table.loaded`. (3) Query yields zero matches → `table.filtered-empty`. (4) Query yields ≥ 1 match — remain in `table.searching`. |
| **Visual description** | Identical to `table.loaded` plus: search input has a subtle accent-color border (`var(--accent)` at 50% opacity), inline ✕ "clear" icon appears at right edge of input. Rows that don't match the query are removed from the DOM (not just hidden — keeps virtualization budget low). Match highlighting on `<mark>` within the flag name and wire key (substring case-insensitive). Match count displayed inline above the table: "Showing 4 of 36 flags." |
| **Keyboard shortcuts** | `Escape` clears input and returns to `table.loaded`. Arrow Up/Down move row focus within the filtered subset. `Enter` while the input is focused moves focus to the first matching row. `Tab` moves out of the input to the first chip. Typing continues to update the query. |
| **Data requirements** | `_catalog` rows in memory; no extra fetch. The match function is `row.name.toLowerCase().includes(q) \|\| row.wireKey.toLowerCase().includes(q)`. |
| **Transitions** | `→ table.loaded` (input cleared). `→ table.filtered-empty` (zero matches). Remains in `S05` as user types. |
| **Error recovery** | Defensive: if the search query produces a regex-style character that we don't escape correctly, the highlighter falls back to plain rendering without `<mark>` wrapping. |
| **Notes** | Debounce is 80 ms — short enough to feel live, long enough that fast typing doesn't trigger 10 re-renders. Match highlighting limited to **first occurrence** in each of `name` and `wireKey` to avoid mark stacking. |

---

### S06: `table.filtered-empty`

Search query or chip filter produces zero matching rows.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `table.searching`: user typed a query with no matches. (2) From `table.loaded`: user selected a chip combination that matches zero rows. (3) From `table.loading`: catalog returned `rows === 0` (synthetic empty — the FLT repo path is configured but no flags parsed). |
| **Exit conditions** | (1) Search input cleared OR query updated to match ≥ 1 row → `table.loaded` or `table.searching`. (2) Filter chip deselected → re-evaluate; if ≥ 1 row, `table.loaded`. (3) User clicked **[Clear filter]** button in the empty-state card → all filters reset → `table.loaded`. (4) Catalog refresh (S04) that returns rows → `table.loaded`. |
| **Visual description** | Toolbar remains visible and interactive (so user can fix the filter). Where the table rows would be, an empty-state card: 24 px `var(--text-dim)` glyph (magnifier or filter icon based on entry path), title "No flags match this filter", body in `text-dim` describing the active filter (e.g., "Search: 'FLTOldDecommissioned' · Classification: Internal"), primary `[Clear filter]` button. If the entry path was "catalog returned zero rows," title becomes "No FLT flags declared" and body becomes "Check that `FeatureNames.cs` exists in the FLT repo at the configured path." |
| **Keyboard shortcuts** | Same as `table.loaded` — search and chips remain interactive. `Tab` reaches the Clear filter button. |
| **Data requirements** | Same as `table.loaded`. No extra fetches. |
| **Transitions** | `→ table.searching` (user keeps typing, matches appear). `→ table.loaded` (filter cleared, rows visible). Remains in S06 until filter changes. |
| **Error recovery** | None — this is itself a recovery surface from over-filtering. |
| **Notes** | The "catalog returned zero rows" variant is conceptually different from "filter produced zero rows" but uses the same state to keep the UI surface predictable. The variant is disambiguated only in the copy. |

---

### S07: `table.sovereign-expanded`

Sovereign column expanded from folded summary to all 8 sovereign columns. Coexists with any lifecycle state.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) User clicked the `Sovereign (8)` column header. (2) User pressed `Enter` on the focused folded sovereign cell. (3) Persisted across panel re-open via `localStorage` (`f11.c03.sovereignExpanded === true`). |
| **Exit conditions** | (1) User clicked the column header again. (2) User pressed `Escape` while the table has focus. (3) Container width drops below the threshold for sovereign columns (responsive collapse — but per F11 §13 we cut responsive design; this is documented as a hard cut and the columns horizontally scroll instead). |
| **Visual description** | The folded `Sovereign (8)` column expands rightward into 8 columns labelled `mc`, `gcc`, `gcchigh`, `dod`, `usnat`, `ussec`, `bleu`, `usgovcanary`. The table container becomes horizontally scrollable. Sticky positioning is preserved for the flag-name column on the left and the STATE column on the right. The expand chevron in the header rotates 90°. |
| **Keyboard shortcuts** | Arrow Left/Right with a row focused now moves between the additional sovereign cells. The order: `name → onebox → test → daily → cst → dxt → msit → prod → mc → gcc → gcchigh → dod → usnat → ussec → bleu → usgovcanary → STATE`. |
| **Data requirements** | Same as the underlying lifecycle state. No additional fetches. |
| **Transitions** | None within the table's lifecycle. Toggling S07 does not affect any other state. |
| **Error recovery** | None applicable. |
| **Notes** | Expansion state persists in `localStorage` to honor user preference across sessions. Per architecture §5 cross-card contracts, S07 is internal to C03 and never read by other cards. |

---

### S08: `row.locked`

Row is locked because FM already evaluates true for this workspace.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) `perEnv.cst.state === 'on'` (CST is fully on globally). (2) `perEnv.cst.state === 'partial' && myWsTargeted === true` (CST partial AND current workspace is in the target groups). (3) Lock is computed once per catalog load; subsequent SignalR override events do NOT change lock state. |
| **Exit conditions** | (1) Catalog refresh (S04) produces a new `locked === false` for this row → `row.unlocked-idle`. (2) Workspace ID changed in Settings → catalog re-evaluates → row may become unlocked. |
| **Visual description** | CST cell shows `✓` (or `◐` for partial-targeted). STATE toggle thumb is in the ON position with `opacity: 0.55`, a `🔒` (lock) icon overlaid on the toggle track at 75% size. Row background uses `var(--surface)` with no override accent. Hovering the toggle shows a tooltip: "Enabled in CST for this workspace — no override needed." |
| **Keyboard shortcuts** | `Space` on the toggle produces no state change but ANNOUNCES the lock reason via `aria-live=polite`. `Enter` on the CST cell (if partial) opens `cell.partial-tooltip-open`. Other keys behave normally for navigation. |
| **Data requirements** | `_catalog[wireKey].perEnv.cst`, `_catalog[wireKey].myWsTargeted`, `_catalog[wireKey].locked`. `_fltConfig.workspaceId` must have been non-null at catalog computation time, OR `locked === false` is forced (P0: "never guess target membership"). |
| **Transitions** | `→ row.unlocked-idle` (catalog refresh changes FM truth). |
| **Error recovery** | If `workspaceId` is null AND CST is partial, the row is NOT locked (degrade to `row.unlocked-idle`) — see C03 §8 "Missing my_ws" rule. |
| **Notes** | The lock is per-workspace, not global. A teammate evaluating the same flag in a different workspace may see the row as `unlocked-idle`. This is correct: the lock reflects "is this flag's effective truth for *my workspace* already ON." |

---

### S09: `row.unlocked-idle`

Toggle is interactive, no override is active. Default writable resting state.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) `locked === false` AND no entry for `wireKey` in `_overrides`. (2) Override was cleared from this row via reset glyph (from `row.override-clearing`). (3) Override was bulk-cleared via Reset all in the override strip. (4) Catalog refresh produced a now-unlocked row from a previously-locked one. |
| **Exit conditions** | (1) User clicks/presses Space on the STATE toggle → `row.override-pending`. (2) Catalog refresh changes FM truth such that the row becomes locked → `row.locked`. |
| **Visual description** | STATE toggle thumb in the OFF position, full opacity. CST cell shows `✗`, `–`, or `◐` (partial, my workspace NOT targeted). Row background `var(--surface)`. No override accent border. Hovering the toggle shows a tooltip describing the wire key and "Force ON for this dev session." |
| **Keyboard shortcuts** | `Space` toggles. `Enter` on a partial cell opens its tooltip. Standard nav with arrows. |
| **Data requirements** | `_catalog[wireKey]`, absence of `_overrides[wireKey]`. |
| **Transitions** | `→ row.override-pending` (toggle activated). `→ row.locked` (catalog change). |
| **Error recovery** | None applicable in this state. |
| **Notes** | This is the only writable state from which a fresh override can be issued. All override-active row states (S10–S16) exit back through `row.override-clearing` to reach S09 again. |

---

### S10: `row.override-pending`

User toggled ON. Optimistic UI; POST `/overrides` in flight.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) `Space` or click on toggle while in `row.unlocked-idle`. (2) A failed override was retried via the Retry button in `row.override-failed`. |
| **Exit conditions** | (1) Response with `fltSync=applied`, `evalClass=live` → `row.override-applied-live`. (2) Response with `fltSync=applied`, `evalClass=cached` → `row.override-applied-cached`. (3) Response with `fltSync=applied`, `evalClass=unobserved` → `row.override-staged-unobserved`. (4) Response with `fltSync=not-connected` → `row.override-cached-local`. (5) Response with `fltSync=wrapper-inactive` → `row.override-wrapper-off`. (6) Response with `fltSync=failed` → `row.override-failed`. (7) Request error (5xx, network) → `row.override-failed` with synthetic `warning`. (8) Request timeout at 5 s → `row.override-failed` with `code=timeout`. |
| **Visual description** | Toggle thumb is in the ON position (optimistic). A 12 px spinner replaces the toggle thumb's status dot. Row is `pointer-events: none` to prevent double-clicks; opacity unchanged. Override strip count increments by 1 immediately (optimistic). |
| **Keyboard shortcuts** | All shortcuts on this row are inert during the pending state. Other rows remain navigable. |
| **Data requirements** | In-flight `POST /api/edog/feature-flags/overrides` with body `{ flag: wireKey, value: true }`. Local map updated optimistically with the new entry (will be reconciled with server response). |
| **Transitions** | See exit conditions — six possible terminal row states based on response payload. |
| **Error recovery** | On network error or 5xx, route to `row.override-failed` with the response body's `error.message` as the `warning` reason. The local map's entry stays (server's authoritative `GET /overrides` reconciliation will correct it within 5 s if needed). |
| **Notes** | The 5 s timeout matches the architecture §7 budget for `POST /overrides → response` p95 of 200 ms with a 25× cushion. Anything longer indicates dev-server or FLT trouble worth surfacing. |

---

### S11: `row.override-applied-live`

Override succeeded; FLT is evaluating the flag continuously via the wrapper. Clean state.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `row.override-pending`: response `fltSync=applied`, `evalClass=live`. (2) From `row.override-staged-unobserved` or `row.override-applied-cached`: SignalR `flag` topic event arrives that flips `evalClass` to `live` (e.g., evalCount crosses 5, or a fresh post-startup eval arrives). |
| **Exit conditions** | (1) User clicks the row's reset glyph → `row.override-clearing`. (2) User clicked Reset all in the override strip → `row.override-clearing`. (3) FLT disconnects (`phase` changes to `disconnected` via SignalR) → `row.override-cached-local` (override survives in dev-server). (4) Wrapper status changes to `wrapped=false` (rare — restart mid-session) → `row.override-wrapper-off`. (5) Eval pattern shifts such that no new evals arrive for > 60 s → `evalClass=cached` re-classification → `row.override-applied-cached`. |
| **Visual description** | STATE toggle thumb is in the ON position with `var(--accent)` (amber). A 6 px amber dot is rendered to the right of the toggle. Eval count badge to the right pulses with `transform: scale(1.0 → 1.15 → 1.0)` over 200 ms when a new event arrives (debounced 100 ms to prevent epileptic strobe on hot flags). Row has a 2 px left border accent in `var(--accent)`. A `!` glyph appears to the left of the flag name to signal override divergence. Reset glyph (`✕`) appears on hover in the rightmost gutter of the STATE cell. |
| **Keyboard shortcuts** | `Space` toggles → `row.override-clearing` (force-OFF is not a state, so clearing is the only exit). `Delete` / `Backspace` on the focused row also clears. `Enter` on the eval badge opens an eval detail tooltip (occurrence count, last seen, durations). |
| **Data requirements** | `_overrides[wireKey] = { value: true, evalClass: 'live' }`. `_observed[wireKey] = { evalCount, lastSeenMs, firstSeenMs }`. SignalR `flag` topic subscription active. |
| **Transitions** | See exit conditions. |
| **Error recovery** | If SignalR connection drops mid-session, the row stays in `applied-live` until the next reconcile — which may transition it to `override-cached-local` if dev-server reports disconnect, or to `override-applied-cached` if evals stop. |
| **Notes** | This is the goal state — the user toggled, FLT is observing the override, and we can prove it. The amber color is intentional (not green) per Phantom v3: ON-with-override is divergent from production truth, and the user should never forget that. |

---

### S12: `row.override-applied-cached`

Override applied to FLT, but consumers cached the value at startup; toggle requires restart.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `row.override-pending`: response `fltSync=applied`, `evalClass=cached`. (2) From `row.override-applied-live` or `row.override-staged-unobserved`: eval pattern aggregates to `cached` (evalCount ∈ [1, 2] AND all observations within FLT startup + 60 s window — see architecture §3.9). (3) From `row.override-cached-local`: replayed override hit FLT but evalClass evaluated as cached on first ping. |
| **Exit conditions** | (1) User clicks the inline **[Restart FLT to apply]** chip → triggers `POST /api/studio/deploy` → row transitions to `row.override-cached-local` during disconnect, then back to `row.override-applied-live` after replay (assuming the new FLT process now sees the override before the cached-at-startup consumer runs). (2) User clears the override → `row.override-clearing`. (3) A fresh eval arrives outside the cached window → `evalClass=live` re-classification → `row.override-applied-live`. (4) FLT disconnects → `row.override-cached-local`. |
| **Visual description** | Same as `row.override-applied-live` (amber thumb, accent border, `!` glyph), plus an inline chip rendered to the right of the toggle: `[↻ Restart FLT to apply]`. Chip uses `var(--surface-2)` background with `var(--text-dim)` text and an accent-color rotating icon. Tooltip on hover: "This flag's value was cached at FLT startup. Restart FLT to make the override take effect." |
| **Keyboard shortcuts** | `Space` clears the override (does NOT trigger restart — restart is a deliberate user action). `r` while the row is focused triggers the Restart FLT chip (must be paired with `shift`: `Shift+R` — to avoid collision with the global Refresh shortcut). `Enter` on the chip activates it. |
| **Data requirements** | Same as `row.override-applied-live`. Plus: `_observed[wireKey].fltStartupMs` and `_observed[wireKey].firstSeenMs` to confirm the cached classification. |
| **Transitions** | See exit conditions. |
| **Error recovery** | If the Restart FLT action fails (the redeploy errors out), the row stays in `override-applied-cached` and a toast surfaces the redeploy error with a "Try again" action. |
| **Notes** | The Restart FLT chip is **not** a force action — it's a hint. The user may legitimately decide they don't care about the cached value (e.g., they were just exploring) and clear the override instead. Both paths are equally valid. |

---

### S13: `row.override-staged-unobserved`

Override applied; no `IsEnabled` evaluations seen yet. Honest "we don't know" state.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `row.override-pending`: response `fltSync=applied`, `evalClass=unobserved` (`evalCount === 0` AND not within the cached-window heuristic). (2) From any other row override state: aggregate falls back to `unobserved` due to absence of new evals. |
| **Exit conditions** | (1) A `flag` topic event for this `wireKey` arrives → `evalClass` re-classifies → `row.override-applied-live` (if post-startup) or `row.override-applied-cached` (if within startup window). (2) User clears → `row.override-clearing`. (3) FLT disconnects → `row.override-cached-local`. (4) User clicks Restart FLT (proactively, if they suspect a pre-captured reference) → `POST /api/studio/deploy`. |
| **Visual description** | Same chrome as `row.override-applied-live` (amber thumb, accent border, `!` glyph) plus a **watching** indicator: small `~` glyph in `var(--text-dim)` to the right of the toggle, with a tooltip on hover: "No evaluations observed yet. The override will apply on the next call. If you expect this flag to be evaluated continuously and this watcher stays empty, try restarting FLT." The text is direct quote from architecture §3.9 UI mapping. No restart chip in this state by default (less alarming than `cached`), but a `[Restart FLT]` action is available in the row's overflow menu (`⋯`). |
| **Keyboard shortcuts** | Same as `row.override-applied-live`. |
| **Data requirements** | Same as `row.override-applied-live`. `_observed[wireKey].evalCount === 0` (or low + outside cached window). |
| **Transitions** | See exit conditions. |
| **Error recovery** | None applicable — this state IS the "we don't know" recovery from `applied`-without-`live` certainty. |
| **Notes** | The architecture §3.9 commitment to honesty over false promises is encoded here. We deliberately do **not** claim "the wrapper is bypassed" because we can't disambiguate that from "the code path hasn't run yet." See architecture §3.9 "Why we do not claim per-flag 'wrapper bypassed'." |

---

### S14: `row.override-cached-local`

Override stored in dev-server's map only. FLT is disconnected; replay will fire on reconnect.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `row.override-pending`: response `fltSync=not-connected`. (2) From any override-applied state (S11/S12/S13): FLT disconnects mid-session (`phase` becomes `disconnected`). (3) User issues a toggle while panel is in `panel.disconnected` overlay (S19). |
| **Exit conditions** | (1) FLT reconnects, dev-server replays the bulk override map, replay succeeds → `row.override-pending` briefly, then a terminal applied state based on `evalClass`. (2) User clears → `row.override-clearing` (clears the local map even though FLT can't be told). |
| **Visual description** | Same as `row.override-applied-live` (amber thumb, accent border, `!` glyph) plus a pill labeled **"Will apply on FLT start"** with `var(--surface-2)` background and `var(--text-dim)` text. The eval count badge is hidden (no evals to count yet). |
| **Keyboard shortcuts** | `Space` clears. Other keys behave normally. |
| **Data requirements** | `_overrides[wireKey] = { value: true, evalClass: <last known, may be stale> }`. `_studioStatus.phase === 'disconnected'`. |
| **Transitions** | `→ row.override-pending` (FLT reconnects and replay POST starts). `→ row.override-clearing` (user clears). |
| **Error recovery** | If the dev-server fails to replay on reconnect (FLT rejects the bulk POST), the row routes to `row.override-failed` after the replay attempt. |
| **Notes** | This state preserves a clean writable surface while FLT is offline — the user can stage many overrides and they all apply atomically on the next deploy. |

---

### S15: `row.override-wrapper-off`

Override POSTed successfully but the FLT-side wrapper is not wired into DI. No `IsEnabled` call this session can hit our store.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `row.override-pending`: response `fltSync=wrapper-inactive` (POST returned 200, but `interceptors/status` returned `featureFlighterWrapped=false`). (2) From any applied row state: `interceptors/status` change detected mid-session (rare). |
| **Exit conditions** | (1) User clicks **[Restart FLT]** CTA → `POST /api/studio/deploy` → row transitions to `override-cached-local` during disconnect, replay attempts to land into a wrapped session. (2) User clears → `row.override-clearing`. |
| **Visual description** | Same chrome as `row.override-applied-live` plus an inline **[Restart FLT]** CTA button (larger than the chip in S12 — this is a stronger ask). The accent color leans more orange than amber (`var(--level-warning)` instead of `var(--accent)`) to communicate "this isn't working." Tooltip: "Wrapper not in resolved DI chain. Restart FLT for overrides to take effect." Panel-level overlay S20 is typically also active and reinforces the message at the top of the card. |
| **Keyboard shortcuts** | `Space` clears. `Enter` on the focused CTA button activates Restart FLT. |
| **Data requirements** | `_wrapperStatus.featureFlighterWrapped === false`. Otherwise same as `override-applied-live`. |
| **Transitions** | See exit conditions. |
| **Error recovery** | If Restart FLT fails, the row stays in this state and a toast surfaces the redeploy error. |
| **Notes** | If `panel.wrapper-inactive` overlay is active, EVERY override-applied row is in this state. The per-row CTA is redundant with the panel banner, but per-row visibility is still important so a user scrolling through rows after a stuck deploy understands the impact. |

---

### S16: `row.override-failed`

Override write returned a non-2xx, or POST-then-verify detected a hash/revision mismatch.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) From `row.override-pending`: response `fltSync=failed` with a populated `warning`. (2) Network error or 5xx on POST → synthetic failure. (3) From any applied row state: a subsequent replay detected divergence (rare). |
| **Exit conditions** | (1) User clicks **Retry** → `row.override-pending`. (2) User clicks **Clear** → `row.override-clearing`. (3) An out-of-band write from another tool (e.g., curl) succeeds and SignalR `override-state` arrives → reconcile to the appropriate applied state. |
| **Visual description** | Toggle thumb stays in the ON position to communicate intent. A `var(--level-error)` (red) 6 px dot replaces the green/amber accent dot. To the right of the toggle: `[↻ Retry]` and `[✕ Clear]` buttons, both inline (not in overflow). Inline truncated `warning` reason in `var(--text-dim)` below the flag summary: "FLT control-token mismatch (401)" or similar. |
| **Keyboard shortcuts** | `r` retries (no shift needed in this state). `Backspace` / `Delete` clears. `Enter` on the focused row opens an expanded error detail dialog (full `warning` text + recent dev-server logs). |
| **Data requirements** | `_overrides[wireKey].value === true`, plus the most recent failed-response payload kept in `_overrideFailures[wireKey]` for the error detail dialog. |
| **Transitions** | `→ row.override-pending` (Retry). `→ row.override-clearing` (Clear). |
| **Error recovery** | This is the recovery surface. The error detail dialog includes copy-paste-able dev-server log lines so the user can debug or escalate. |
| **Notes** | Three consecutive failures on the same wire key surface a sticky toast suggesting the most common cause (control-token rotation, FLT crashed, dev-server restarted without FLT restart). |

---

### S17: `row.override-clearing`

DELETE in flight. Row is disabled while the server confirms.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) User clicked the reset glyph (`✕`) on the row. (2) User clicked Reset all in the override strip (every override-active row transitions to this state simultaneously). (3) User hit `Backspace` or `Delete` on the focused row while in an override-active state. (4) User toggled `Space` while in an applied state (toggle off behavior is to clear, since force-OFF is not exposed). |
| **Exit conditions** | (1) DELETE returns 200 → `row.unlocked-idle`. (2) DELETE returns non-2xx or times out → roll back to the previous state with a toast. (3) FLT disconnects during DELETE → still completes locally → `row.unlocked-idle` (dev-server is authoritative). |
| **Visual description** | Toggle thumb visibly slides from ON to OFF position over 150 ms with a small spinner replacing the status dot. Row is `pointer-events: none`. Override strip count decrements optimistically. |
| **Keyboard shortcuts** | All inert. Other rows remain navigable. |
| **Data requirements** | In-flight `DELETE /api/edog/feature-flags/overrides/{wireKey}`. Local map entry queued for removal pending response. |
| **Transitions** | `→ row.unlocked-idle` (success or local-only completion). Rollback to the previous override-applied state on failure. |
| **Error recovery** | On failure, the row reverts to its previous state (`override-applied-live`, `-cached`, etc.) and the toast surfaces the error with a Retry option. |
| **Notes** | Multiple rows can be in `override-clearing` simultaneously when Reset all is triggered. The override strip remains visible (showing decreasing count) until the last clear resolves. |

---

### S18: `row.missing-fm`

FLT declares the wire key but FM cache has no JSON for it. Informational; toggle disabled.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) Catalog load: `_catalog[wireKey].missingReason === 'not-found'` OR `'parse-error'` OR `'stale-cache'`. (2) Catalog refresh that newly drops this wire key from FM (e.g., FM JSON was deleted upstream). |
| **Exit conditions** | (1) Catalog refresh (S04) finds the JSON → row transitions to `row.locked` or `row.unlocked-idle` depending on FM truth. (2) `missingReason` flips from `parse-error` to `not-found` (different error, same state). |
| **Visual description** | All env cells render `?` glyph in `var(--text-dim)`. A `[missing in FM]` chip badge appears next to the flag name in `var(--level-warning)` background. STATE toggle thumb stays at OFF position with `opacity: 0.4` and `cursor: not-allowed`. The summary row shows the missing reason: "Declared in `FeatureNames.cs` but not found in FM JSON" or "Parse error: <truncated>". |
| **Keyboard shortcuts** | `Space` produces no state change; announces "Cannot override — flag missing in FeatureManagement" via `aria-live`. `Enter` on the badge opens a detail dialog with the wire key, expected FM path (if known), and a "Refresh FM cache" CTA. |
| **Data requirements** | `_catalog[wireKey].missingReason` populated. |
| **Transitions** | `→ row.locked` or `→ row.unlocked-idle` (catalog refresh resolves the missing entry). |
| **Error recovery** | The detail dialog's "Refresh FM cache" CTA triggers S04. If three consecutive refreshes don't resolve the missing entry, the dialog adds "This flag may be deployed only locally; check the FM repo at `<branch>` for `<id>`." |
| **Notes** | Per C03 §8: "Could be typo, pending FM PR, or stale cache." We surface the path to the FM file we *expected* based on the wire key conventions (when `fmPath` was populated by the parser), to help the user check upstream. |

---

### S19: `panel.disconnected` (overlay)

FLT is not connected. Panel-wide banner; row interactions still write but stage locally.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) `GET /api/studio/status` returns `phase === 'disconnected'`. (2) SignalR connection drops (heartbeat timeout > 30 s). (3) `POST /api/studio/undeploy` succeeds and `phase` becomes `disconnected`. |
| **Exit conditions** | (1) SignalR reconnects AND `phase === 'connected'` → overlay dismisses. (2) `POST /api/studio/deploy` completes → overlay dismisses. |
| **Visual description** | Sticky banner at the top of Card 3 with `var(--surface-2)` background and a `var(--text-dim)` left border indicator. Copy: "FLT not connected — deploy to start observing." Includes a primary `[Deploy FLT]` button on the right that bridges to C04. Below the banner the table renders normally; row interactions still work but every new override routes to `row.override-cached-local` (S14). Eval count badges across the table show `–` instead of numbers. KPI strip's live/cached/unknown all show `–`. |
| **Keyboard shortcuts** | `Tab` reaches the Deploy FLT button. Other shortcuts behave normally on the underlying table. |
| **Data requirements** | `_studioStatus.phase`. SignalR `studio-status` subscription. |
| **Transitions** | Dismisses when `phase` changes. Does not block any other transition. |
| **Error recovery** | Three consecutive failed reconnect attempts add "Check that dev-server is running" to the banner copy. |
| **Notes** | Compose with row states: every override-active row visually retains its accent border, but its right-side affordance is the "Will apply on FLT start" pill from S14 rather than the eval badge. |

---

### S20: `panel.wrapper-inactive` (overlay)

FLT is connected but the wrapper is not wired into DI. Panel banner; every override-applied row routes to S15.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) `phase === 'connected'` AND `GET /api/edog/interceptors/status` returns `featureFlighterWrapped === false`. (2) Mid-session change detected via SignalR `interceptor-status` event. |
| **Exit conditions** | (1) `interceptors/status` reports `featureFlighterWrapped === true` (typically after FLT redeploy). (2) FLT disconnects → S19 overlay supersedes this one. |
| **Visual description** | Sticky banner at the top of Card 3 with `var(--level-warning)` accent. Copy: "Interceptor inactive — Restart FLT for overrides to take effect." Includes a primary `[Restart FLT]` button. Distinguished from S19 by color (warning orange vs. neutral dim). Table remains fully rendered and interactive. |
| **Keyboard shortcuts** | `Tab` reaches Restart FLT. Underlying table shortcuts unchanged. |
| **Data requirements** | `_wrapperStatus.featureFlighterWrapped === false`. |
| **Transitions** | Dismisses when wrapper status becomes `true`. Superseded by S19 if FLT disconnects. |
| **Error recovery** | If Restart FLT is clicked twice and the wrapper is still inactive afterwards, the banner adds "Wrapper registration may have failed — check dev-server logs for ADR-005 timing window violations." |
| **Notes** | This overlay reinforces the per-row `override-wrapper-off` (S15) state for every override-active row. The user can still issue new overrides — they will all route to S15 immediately. |

---

### S21: `panel.fm-stale` (overlay)

FM cache age past TTL or FM repo unreachable. Inline strip; no interaction gating.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) Catalog response includes `fm.stale === true` (cache age exceeds 24 h). (2) Catalog response includes `fm.error` (last `git fetch` failed). (3) A user-triggered S04 refresh fails. |
| **Exit conditions** | (1) S04 refresh succeeds and clears `stale` and `error` flags. (2) Dev-server's nightly cron successfully updates the cache (SignalR `catalog-refresh` event). |
| **Visual description** | Inline strip inside the KPI row (not a top banner). `var(--surface-2)` background, dim text: "FM data last synced 2d ago — [Refresh]" or "Could not reach FM repo — [Retry]" depending on `error` vs. `stale`. Does not gate any interaction; rows render with stale truth but every cell glyph remains accurate to the cache contents. |
| **Keyboard shortcuts** | `Tab` reaches the Refresh / Retry button. |
| **Data requirements** | `_catalog.fm.stale`, `_catalog.fm.error`, `_catalog.fm.syncedAtMs`. |
| **Transitions** | Dismisses when refresh resolves both flags. |
| **Error recovery** | If Refresh fails three times in a row, the strip copy adds "Run `git clone <url>` once if credentials are missing" (per architecture §3.3 / C03 §8). |
| **Notes** | S21 is the only overlay that can coexist with S19 or S20 simultaneously. The order of banners top-to-bottom: S19 > S20 > S21 (most-blocking first). |

---

### S22: `cell.partial-tooltip-open` (modal)

User opened the target-groups dialog from a partial (`◐`) cell. Focus trapped.

| Aspect | Detail |
|--------|--------|
| **Entry conditions** | (1) User pressed `Enter` on a focused cell with `state === 'partial'`. (2) User clicked a partial cell. (3) Pressed `?` keyboard shortcut while a partial cell is focused. |
| **Exit conditions** | (1) `Escape` → dialog closes, focus returns to the originating cell. (2) Click outside the dialog → dialog closes. (3) `Tab` past the last focusable element wraps within the dialog (focus trap). (4) User clicks a target-group's "filter to this group" action → dialog closes, search input pre-populates with the group name. |
| **Visual description** | Popover-style dialog anchored to the cell with `var(--shadow-dialog)`, max-width 320 px. Header: env name (e.g., "CST") + cell state ("partial"). Body: ordered list of target groups, each row showing pivot type (e.g., `TenantObjectId`, `WorkspaceObjectId`, `MemberOf`), values preview (truncated to 3, "+ N more"), and `includesMyWorkspace` indicator (✓ in `var(--accent)` if true). Footer: secondary `[Filter to these groups]` button. |
| **Keyboard shortcuts** | `Escape` closes. `Tab` / `Shift+Tab` cycles through actionable elements within the dialog. `Enter` on a target group expands its values preview. |
| **Data requirements** | `_catalog[wireKey].perEnv[envKey].targets[]` (TargetGroup objects). |
| **Transitions** | `→ table.searching` (if user activates "Filter to these groups"). Otherwise returns to whatever lifecycle state was active before. |
| **Error recovery** | If the targets array is malformed (defensive parse fails), the dialog shows "Could not parse target group data" with a "Report bug" link instead of throwing. |
| **Notes** | Per C03 §11 open question 2: this dialog deliberately does NOT reveal raw target values for groups with > 3 entries — it shows pivot + preview only. The "+ N more" hint exists to give the user a sense of group size without leaking large tenant lists into screenshots. |

---

## 4. Compound States (Overlay Composition)

The table lifecycle (S01–S07), row states (S08–S18), and panel overlays (S19–S21) compose independently. Below is the legal-combination matrix.

### Compatibility Matrix

| | S19 disconnected | S20 wrapper-inactive | S21 fm-stale |
|---|---|---|---|
| **S01 loading** | ✓ (banner under skeleton) | ✓ (banner under skeleton) | rare — no catalog yet to be stale |
| **S03 loaded** | ✓ | ✓ | ✓ |
| **S04 refreshing** | ✓ (refresh attempts continue) | ✓ | ✓ (refresh is the exit path from S21) |
| **S05 searching** | ✓ | ✓ | ✓ |
| **S06 filtered-empty** | ✓ | ✓ | ✓ |
| **S07 sovereign-expanded** | ✓ (column overlay composes with everything) | ✓ | ✓ |

| Row state | Allowed with S19 | Allowed with S20 | Allowed with S21 |
|---|---|---|---|
| **S08 locked** | ✓ (FM truth still valid) | ✓ | ✓ (truth is stale, but locked is still meaningful) |
| **S09 unlocked-idle** | ✓ | ✓ | ✓ |
| **S10 override-pending** | ✗ (S10 → S14 immediately on disconnect) | ✓ | ✓ |
| **S11 override-applied-live** | ✗ (forced to S14) | ✗ (forced to S15) | ✓ |
| **S12 override-applied-cached** | ✗ (forced to S14) | ✗ (forced to S15) | ✓ |
| **S13 override-staged-unobserved** | ✗ (forced to S14) | ✗ (forced to S15) | ✓ |
| **S14 override-cached-local** | ✓ (this is its natural state) | ✓ (if reconnect later finds wrapper inactive, transitions to S15) | ✓ |
| **S15 override-wrapper-off** | ✗ (S15 → S14 on disconnect, since not even POST works) | ✓ (its natural state) | ✓ |
| **S16 override-failed** | ✓ (failed reason will indicate disconnect) | ✓ | ✓ |
| **S17 override-clearing** | ✓ (clears local-only) | ✓ | ✓ |
| **S18 missing-fm** | ✓ | ✓ | ✓ (frequent — stale FM data often means missing entries) |

### Impossible Combinations

- **S19 + S20 simultaneously.** They are mutually exclusive: S19 means FLT is disconnected (we can't check wrapper status); S20 means FLT is connected but wrapper is off. The transition is sequential: deploy starts → S19 with deploy spinner → S19 dismisses → S20 may appear → S20 dismisses on wrapper wire-up.
- **S08 locked + any override-applied row state (S11–S16).** Locked rows can't accept writes; their toggles are disabled before any POST.
- **S18 missing-fm + any override-applied row state.** Missing FM entries can't accept writes (the toggle is disabled at S18 entry).
- **S22 partial-tooltip-open while in S01 loading.** Skeleton rows have no cells with target data; the open-tooltip path is unreachable.

---

## 5. Cross-Cutting Concerns

### 5.1 FLT Redeploy Mid-Session

When the user clicks Restart FLT (from S12, S15, or S20), the panel goes through a deterministic sequence:

1. `POST /api/studio/deploy` begins → `phase` becomes `deploying` momentarily → SignalR signals `studio-status` change.
2. All override-applied rows transition to `row.override-cached-local` (S14) for the duration of the FLT downtime.
3. Panel overlay S19 appears (disconnected) with a "Restarting FLT…" subtitle.
4. FLT comes up → `phase` becomes `connected` → dev-server replays the override map via `POST /overrides/bulk`.
5. SignalR `interceptor-status` event arrives. If wrapped: overlay S19 dismisses, rows transition through `override-pending` (replay) and land on appropriate applied states based on `evalClass`. If unwrapped: overlay S20 appears, rows route to S15.

### 5.2 Theme Change

Light/dark theme switches must preserve every row's state. Specifically:
- Accent colors swap (`var(--accent)` resolves to amber-light or amber-dark).
- Override accent border, ! glyph, and red dot in S16 must remain at least 4.5:1 contrast in both themes per C03 §7 accessibility.
- The transition is instant; no animation suppression needed because no state changes.
- The override strip's `aria-live="polite"` does NOT re-announce on theme change.

### 5.3 Reset All

When the user clicks **Reset all** in the override strip:
1. A confirmation toast appears: "Clear N overrides? [Yes, clear all]". Per C03 §11 open question 4, V1 always confirms (no special-case for N=1).
2. On confirmation, every override-active row transitions to `row.override-clearing` (S17) simultaneously.
3. Dev-server issues a single `POST /api/edog/feature-flags/overrides/reset` (not N individual DELETEs).
4. On success, all rows transition to `row.unlocked-idle` (S09); the override strip hides.
5. On failure, rows revert to their prior states; toast shows the error.

### 5.4 Reduced Motion (`prefers-reduced-motion: reduce`)

- Skeleton shimmer (S01) is replaced by static `var(--surface-2)` blocks.
- Eval count pulse animation (S11) is disabled — counter updates instantly.
- Toggle thumb slide (any transition involving toggle) is replaced by an instant swap.
- Override strip slide-in is replaced by an instant appearance.
- S22 dialog open/close animations are instant (no fade).

### 5.5 Container Resize (Panel Width Change)

Per F11 §13, the panel is desktop-only. Container resize is bounded by the parent Environment Panel layout. Within that bound:
- Sovereign expansion (S07): horizontally scrolls cleanly.
- KPI strip values: numeric truncation with tooltips at narrow widths.
- The override strip stays sticky; if it exceeds the row width, last-set timestamp drops first, then "Reset all" collapses into an overflow menu.

### 5.6 Override Strip Visibility

The override strip (sticky row above the table) is visible if and only if `_overrides.length > 0`. It updates **optimistically** on row state changes:
- Increment on entry to S10 (`override-pending`).
- Decrement on exit to S09 (after S17 completes).
- Last-set timestamp comes from the most recently POSTed override's response.
- The strip's eval-count chips (live/cached/unobserved) update via SignalR `flag` topic events and re-classification.

### 5.7 SignalR Disconnect While Override-Applied Rows Exist

If SignalR connection drops but the underlying `phase` remains `connected` (transient SignalR issue), eval counters freeze but row states do not transition. A `var(--text-dim)` italic `(offline)` badge appears next to each eval count badge. On SignalR reconnect, a batch backfill of recent events repopulates the aggregates.

### 5.8 Catalog Refresh Affects Lock State

A successful S04 refresh can change `locked` for any row (e.g., if the FM JSON was updated to add the current workspace's tenant to a partial target group). When this happens:
- A row in S09 may become S08 → toggle disables; any in-flight pending override on that row resolves through the normal POST/response path even if the row will become locked (we don't cancel in-flight writes).
- A row in S08 may become S09 → toggle re-enables.
- No row state below S08 (S10–S18) is affected by lock recomputation.

### 5.9 Roving Focus Across Row State Changes

The table uses roving `tabindex` focus (one element per row receives `tabindex=0`, others `tabindex=-1`). When a row's state changes:
- If the focused element within the row is the toggle and the row becomes locked or missing-fm, the focus moves to the row's `<tr>` so keyboard navigation still works.
- If a row leaves the visible filtered set (search transitions to S05), focus moves to the next visible row.
- If the entire table re-renders (S01 → S03 after refresh), focus restores to the row with the same `wireKey` if it still exists, otherwise the first row.

---

## 6. Transition Summary Table

A flat reference of every documented transition.

| From | Trigger | To |
|---|---|---|
| S01 loading | catalog 200, rows > 0 | S03 loaded |
| S01 loading | catalog 200, rows === 0 | S06 filtered-empty (synthetic) |
| S01 loading | catalog 4xx/5xx/timeout | S02 error-catalog |
| S02 error-catalog | Retry click or auto-retry | S01 loading |
| S03 loaded | type in search | S05 searching |
| S03 loaded | chip click yields 0 rows | S06 filtered-empty |
| S03 loaded | chip click yields ≥1 row | S03 loaded (filtered subset) |
| S03 loaded | Refresh button | S04 refreshing-catalog |
| S03 loaded | row toggle activated | row → S10 (table stays S03) |
| S04 refreshing | refresh success | S03 loaded |
| S04 refreshing | refresh success, 0 rows | S06 filtered-empty |
| S04 refreshing | refresh fail | S03 loaded + toast |
| S05 searching | input cleared | S03 loaded |
| S05 searching | query yields 0 matches | S06 filtered-empty |
| S05 searching | query yields ≥1 match | S05 searching (subset) |
| S06 filtered-empty | filter cleared, rows visible | S03 loaded |
| S06 filtered-empty | typing produces matches | S05 searching |
| S07 sovereign-expanded | header click or `Escape` | (collapse — overlay dismiss) |
| S08 locked | catalog refresh changes FM truth | S09 unlocked-idle |
| S09 unlocked-idle | Space/click toggle | S10 override-pending |
| S09 unlocked-idle | catalog refresh locks row | S08 locked |
| S10 override-pending | response applied + live | S11 override-applied-live |
| S10 override-pending | response applied + cached | S12 override-applied-cached |
| S10 override-pending | response applied + unobserved | S13 override-staged-unobserved |
| S10 override-pending | response not-connected | S14 override-cached-local |
| S10 override-pending | response wrapper-inactive | S15 override-wrapper-off |
| S10 override-pending | response failed / 5xx / timeout | S16 override-failed |
| S11 override-applied-live | reset glyph or Reset all | S17 override-clearing |
| S11 override-applied-live | FLT disconnects | S14 override-cached-local |
| S11 override-applied-live | wrapper turns off mid-session | S15 override-wrapper-off |
| S11 override-applied-live | eval pattern shifts to cached | S12 override-applied-cached |
| S12 override-applied-cached | Restart FLT chip clicked | (deploy → S14 → S11 or S15) |
| S12 override-applied-cached | clear | S17 override-clearing |
| S12 override-applied-cached | fresh eval, evalClass = live | S11 override-applied-live |
| S13 override-staged-unobserved | first eval observed (post-startup) | S11 override-applied-live |
| S13 override-staged-unobserved | first eval observed (within startup window) | S12 override-applied-cached |
| S13 override-staged-unobserved | clear | S17 override-clearing |
| S14 override-cached-local | FLT reconnect, replay starts | S10 override-pending |
| S14 override-cached-local | clear | S17 override-clearing |
| S15 override-wrapper-off | Restart FLT clicked | (deploy → S14 → S11/S12/S13 or S15) |
| S15 override-wrapper-off | wrapper becomes wired mid-session | S11/S12/S13 (per evalClass) |
| S15 override-wrapper-off | clear | S17 override-clearing |
| S16 override-failed | Retry | S10 override-pending |
| S16 override-failed | Clear | S17 override-clearing |
| S16 override-failed | out-of-band success via SignalR | S11/S12/S13 (per evalClass) |
| S17 override-clearing | DELETE success | S09 unlocked-idle |
| S17 override-clearing | DELETE fail | previous override-applied state + toast |
| S18 missing-fm | catalog refresh resolves FM entry | S09 unlocked-idle (or S08 locked) |
| S19 panel.disconnected | reconnect + phase = connected | (overlay dismiss) |
| S20 panel.wrapper-inactive | wrapper wired | (overlay dismiss) |
| S20 panel.wrapper-inactive | FLT disconnects | S19 panel.disconnected (supersede) |
| S21 panel.fm-stale | S04 refresh succeeds | (overlay dismiss) |
| S22 cell.partial-tooltip-open | Escape or outside-click | (return to underlying state) |
| S22 cell.partial-tooltip-open | "Filter to these groups" click | S05 searching (with prefilled query) |

---

**End of F11 C03 state matrix.** This document feeds:
- **P4 (Visual Mocks):** every state needs a mock or annotated screenshot. Phantom v3 already covers ~10 of 22; the remaining ~12 need to be added.
- **P5 (Implementation):** `flags-matrix.js`, `override-strip.js`, and `eval-stream.js` are the three frontend modules that own these transitions. Each function in each module should be traceable to at least one state row in §3.
- **P6 (Tests):** Sentinel will write integration tests covering every transition row in §6 (cardinality: 47). Each panel overlay also needs a snapshot test for its banner copy.
