# C09 Shell + Command Palette — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** App Shell — nav, top bar, freshness indicator, Cmd-K palette, routing, theme
> **Canonical data model:** [`data-model.md`](../data-model.md) — route table (§5)
> **Component spec:** [`C09-shell.md`](../components/C09-shell.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoints:** `GET /api/ct/freshness` → `FreshnessPayload` (metadata/chip); `GET /api/ct/updates` → `{ newerHeadAvailable, pendingCommitCount, remoteHeadCommitId, checkedAt }` (poll); `POST /api/ct/refresh` → `RefreshResponse`
> **Route:** (all routes) — shell wraps every view
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Top-Level App States

These are the outermost states of the entire application. Only one is active at a time.

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C09-S00` | Auth pending | App loaded; session validation in progress | Full-screen skeleton: no nav, no content, no top bar, no palette. Branded loading screen. | Nothing interactive | `G-DATA-NONE` | Session valid → `C09-S02`; no session → `C09-S01` | C09 §8.1 `auth-pending`; `G-AUTH-PENDING` |
| `C09-S01` | Signed out | No valid session; Entra login needed | Sign-in screen: app logo + "Sign in with Microsoft" button. No nav, no content. | Sign-in button only | `G-DATA-NONE` | User signs in → `C09-S00` → `C09-S02` | C09 §8.1 `signed-out`; `G-AUTH-REDIRECT` |
| `C09-S02` | Data loading | Authenticated; warm store being built (cold-load) | Shell visible: nav rail, top bar (user avatar, theme toggle), freshness chip "Loading…". Content area: view-specific skeleton. Palette: FLAGS category shows "Loading flag index…" | Nav: enabled (can switch views, though other views may also be loading). Palette: open/close enabled; flag search limited to view/action categories. | `G-DATA-NONE` or `G-DATA-STATE-ONLY` | Data arrives → `C09-S03`; hard error → `C09-S06` | C09 §8.1 `data-loading`; `G-BOOT-SKELETON` / `G-BOOT-PROGRESSIVE` |
| `C09-S03` | Populated | Warm store fully populated; data available | Shell fully rendered: nav rail with all 8 view items + active indicator, top bar (freshness chip green, user avatar, theme toggle, Cmd-K button, Refresh button). Content: active view. | Full interactivity: all nav items, all top bar controls, palette fully functional, all view interactions | `G-DATA-FULL` | Navigate; refresh; stale; error; sign out | C09 §8.1 `populated`; `G-BOOT-WARM` |
| `C09-S04` | Stale-loading | Data stale (>60 min); refresh in progress | Same as `C09-S03` but freshness chip: spinner "Refreshing…". Refresh button disabled. Content: current (stale) data remains interactive. | Full interactivity except Refresh button | `G-DATA-FULL` (stale) | Refresh succeeds → `C09-S03`; fails → `C09-S05` | C09 §8.1 `stale-loading`; `G-REFRESH-IN-PROGRESS` |
| `C09-S05` | Stale-error (atomic rollback) | Last refresh failed; **atomic rollback applied — ALL data reverted to last-good vintage** | Same layout as `C09-S03` but freshness chip: red "Refresh incomplete — showing last-good data from {time}. Retry." Content: last-good data (pre-refresh) shown in full. **No mixed-vintage data; no per-row staleness indicators.** | Full interactivity; Retry button in freshness chip or top bar | `G-DATA-FULL` (stale) | Retry → `C09-S04`; sign out | C09 §8.1 `stale-error`; `G-REFRESH-FAILED`; P3 gate ruling R2 |
| `C09-S06` | Hard error | First load failed entirely; no warm store; no stale data | Shell nav visible. Content area: error panel: "Something went wrong. Control Tower could not load data." + Retry (full reload) + "Open FM repo ↗" link. Palette: unavailable (no flag index). | Retry (page reload), nav (other views will also fail), sign-out | `G-DATA-NONE` | Retry → `C09-S00` | C09 §8.1 `hard-error`; `G-ERR-HARD` |

### A.2 Navigation States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C09-S10` | View transition | User clicks nav item or Cmd-K result | Brief transition: content area replaces with new view's loading state. Nav active indicator moves. URL updates via `router.push()`. Previous view's pending requests aborted. | C09 §4.1 |
| `C09-S10a` | Dossier nav — no current flag | No flag currently viewed; Dossier nav item present | Dossier nav item: muted/disabled appearance. Click does nothing or shows tooltip: "Open a flag from the grid first." | C09 §2.2, §9.2 |
| `C09-S10b` | Dossier nav — flag active | Currently viewing `/flag/:flagId` | Dossier nav item: active indicator + flag name truncated in label. | C09 §2.3 |

### A.3 Freshness Indicator States

Inherits from `_global.md` §5. Shell-specific rendering:

| State ID | Name | Chip | Top bar behaviour | Source |
|---|---|---|---|---|
| `C09-S15` | Fresh | Green ● + "2 min ago" | Hover: tooltip with absolute timestamp + commit SHA (7-char truncated) + "N flags tracked" | C09 §7.2; `G-FRESH` |
| `C09-S16` | Stale | Amber ● + "47 min ago — Refresh" | Chip is clickable (triggers refresh). Hover: same tooltip. | C09 §7.2; `G-STALE` |
| `C09-S17` | Refreshing | Spinner + "Refreshing…" | Refresh button disabled. Chip not clickable. | C09 §7.4; `G-REFRESHING` |
| `C09-S18` | Refresh failed | Red ◆ + "Last refresh failed — Retry" | Chip clickable (triggers retry). Hover: error detail. | C09 §8.1; `G-FRESH-ERROR` |
| `C09-S19` | Newer head detected | Blue ● + "New changes available — Refresh" | **Update poll (`GET /api/ct/updates`) returned `newerHeadAvailable: true`.** Chip is clickable (triggers manual atomic refresh). Banner may also show in active view (C04 feeds `C04-S01h`). No data mutation until user clicks. Poll continues in background. | P3 gate ruling GAP-06; `G-FRESH-NEWER-HEAD`; `G-POLL-NEWER-HEAD` |

### A.4 Command Palette (Cmd-K) States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive | Source |
|---|---|---|---|---|---|
| `C09-S30` | Palette closed | Default | No palette visible. `Ctrl-K` / `Cmd-K` button in top bar. | Ctrl-K opens palette | C09 §3.1, §9.1 |
| `C09-S31` | Palette open — empty input | User pressed Ctrl-K; no query typed | Modal overlay: search input (empty) + category groups: VIEWS (8 items), FLAGS (42 items), ACTIONS (Refresh, Theme, Sign out), RECENT (last 5 used, from `ct_palette_recents`). Focus trapped in palette. | Type to search; arrow keys to navigate; Enter to select; Escape to close | C09 §3.1, §3.8 |
| `C09-S31a` | Palette — no history | First use; `ct_palette_recents` empty | Same as `C09-S31` but RECENT section absent. Hint: "Type to search flags, jump to a view, or run an action." | Same as `C09-S31` | C09 §3.8 |
| `C09-S32` | Palette — query results | User typed; matching results found | Search results grouped by category. Highlighted current item. Results update as user types (debounced). | Arrow keys, Enter, Escape. Click result. | C09 §3.2 |
| `C09-S33` | Palette — no results | User typed; zero matches | Message: "No results for '[query]'." Optional: "Did you mean '[suggestion]'?" if fuzzy match exists. | Continue typing; Escape to close; clear input | C09 §3.9 |
| `C09-S34` | Palette — flags loading | Palette opened during `C09-S02` (data-loading) | FLAGS category: "Loading flag index…" with shimmer. VIEWS and ACTIONS categories available. | VIEWS/ACTIONS work; FLAGS unavailable until data loads | C09 §10 |
| `C09-S35` | Palette — action executing | User selected "Refresh data" action | Palette closes. Refresh fires. Toast: "Refreshing…" | — | C09 §3.6, §5.3 |

### A.5 Saved Views States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C09-S40` | Save current view | User clicks save icon in palette search bar | Inline dialog within palette: "Save as: [input]" with OK/Cancel. Name defaults to view name + filter summary. | C09 §4.4, §7.5 |
| `C09-S41` | Saved views list | Palette SAVED VIEWS section (if any exist) | List of saved views (max 20): name + view route preview. Inline ✕ to delete (no confirmation). | C09 §3.7, §4.4 |
| `C09-S42` | Delete saved view | User clicks ✕ on a saved view | View removed from `localStorage` key `ct_saved_views`. No confirmation dialog. Live-region announcement: "Saved view '[name]' deleted." | C09 §3.7, §4.4 |
| `C09-S43` | localStorage unavailable | `localStorage` throws on access | Saved views feature silently disabled. No error shown. "Save" icon hidden. SAVED VIEWS section absent from palette. MRU (recent) also disabled. | C09 §4.4, §10 |
| `C09-S43a` | Saved views maximum reached | User clicks "Save current view" when 20 saved views already exist | Toast/inline message: "Maximum saved views reached — delete one first." Save action does NOT fire. No data loss. | P3 gate ruling GAP-12; C09 §4.4 |

### A.6 Theme States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C09-S50` | Light theme (default) | `localStorage ct_theme === 'light'` or absent | Light colour tokens applied. Theme toggle: sun icon. | C09 §7.6; `G-THEME-LIGHT` |
| `C09-S51` | Dark theme | `localStorage ct_theme === 'dark'` | Dark colour tokens applied. Theme toggle: moon icon. | C09 §7.6; `G-THEME-DARK` |
| `C09-S52` | Theme FOUC guard | Inline `<script>` in `<head>` | Reads `localStorage` synchronously; applies `data-theme` attribute before first paint. No visible flash. | C09 §7.6, §10; `G-THEME-FOUC-GUARD` |

### A.7 Auth / Session States (Shell-Specific)

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C09-S60` | User avatar menu open | Click on user avatar in top bar | Dropdown (`role="menu"`): user display name, email, "Sign out" item. `aria-expanded="true"` on trigger. | C09 §9.3 |
| `C09-S61` | Session expiry toast | 401 received during session | Toast: "Session expired — sign in again." After 3s → redirect to sign-in. | C09 §6.4, §10; `G-AUTH-EXPIRED` |
| `C09-S62` | Sign out in progress | User clicked Sign Out | Brief "Signing out…" then redirect to sign-in screen. Session cookie cleared. | C09 §6.4 |

### A.8 Error / Edge-Case States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C09-S70` | Invalid flag ID in URL | URL `/flag/nonexistent` with invalid flagId | Shell renders; content delegates to C02 which shows `C02-S06` (flag not found). Shell nav shows Dossier as active. | C09 §10 |
| `C09-S71` | Unknown route | URL path doesn't match any view route | Redirect to `/` (grid). No 404 page (SPA redirect). | C09 §4.2 |
| `C09-S72` | Malformed query params | URL contains unrecognized or malformed params | Unknown params silently stripped. Malformed values for known params treated as absent (use defaults). No error shown. | C09 §4.2, §10 |
| `C09-S73` | Refresh failed — atomic rollback | `POST /api/ct/refresh` returned ANY partial failure (e.g. 30/42 succeed) | **Atomic rollback to last-good vintage. No mixed-vintage data committed.** Banner: "Refresh incomplete — showing last-good data from {time}. Retry." All prior data retained intact. No per-row amber indicator. No per-flag staleness. | C09 §7.4, §10; P3 gate ruling R2 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (page load) | App loaded | `C09-S00` | Session validation |
| `C09-S00` | Session valid | `C09-S02` | Shell renders; first API call |
| `C09-S00` | No session | `C09-S01` | Sign-in screen |
| `C09-S01` | User signs in | `C09-S00` | Auth flow |
| `C09-S02` | Data fully loaded | `C09-S03` | All views available |
| `C09-S02` | Data load fails | `C09-S06` | Hard error |
| `C09-S03` | Stale timer fires | `C09-S16` (freshness) | Amber chip |
| `C09-S03` | User clicks Refresh | `C09-S04` | Refresh fires |
| `C09-S04` | Refresh succeeds | `C09-S03` | Toast; fresh chip |
| `C09-S04` | Refresh fails (any partial failure) | `C09-S05` + `C09-S73` | Atomic rollback; red chip; "Refresh incomplete — showing last-good data from {time}. Retry." |
| `C09-S05` | User clicks Retry | `C09-S04` | Retry refresh |
| `C09-S03` | Update poll detects newer HEAD | `C09-S19` | Blue chip: "New changes available — Refresh" |
| `C09-S19` | User clicks chip/Refresh | `C09-S04` | Manual atomic refresh fires |
| `C09-S03` | User clicks nav item | `C09-S10` → (view loading) | View transition |
| `C09-S03` | Ctrl-K pressed | `C09-S31` | Palette opens |
| `C09-S31` | User types query | `C09-S32` or `C09-S33` | Results or no-results |
| `C09-S31` | Escape pressed (empty input) | `C09-S30` | Palette closes |
| `C09-S32` | Enter on result (view) | `C09-S10` → (view) | Navigate to view |
| `C09-S32` | Enter on result (flag) | `C09-S10` → C02 | Navigate to dossier |
| `C09-S32` | Enter on result (action) | `C09-S35` | Action executes |
| `C09-S32` | Escape (with input) | `C09-S31` | Input cleared (first Escape clears, second closes) |
| `C09-S33` | Continue typing | `C09-S32` or `C09-S33` | Results update |
| `C09-S33` | Escape | `C09-S31` or `C09-S30` | Clear / close |
| `C09-S31` | Click backdrop | `C09-S30` | Palette closes |
| `C09-S03` | User clicks avatar | `C09-S60` | Menu opens |
| `C09-S60` | Click Sign Out | `C09-S62` → `C09-S01` | Session destroyed |
| `C09-S60` | Click outside / Escape | `C09-S03` | Menu closes |
| `C09-S03` | Theme toggle | `C09-S50` ↔ `C09-S51` | Theme switches |
| `C09-S03` | 401 on any API | `C09-S61` → `C09-S01` | Toast then redirect |
| `C09-S06` | Retry (reload) | (page reload) → `C09-S00` | Full restart |
| `C09-S40` | OK pressed | `C09-S41` (updated) | View saved to localStorage |
| `C09-S40` | Cancel | `C09-S31` | Back to palette |
| `C09-S42` | Delete ✕ | `C09-S41` (updated) | View removed; live-region announcement |

---

## C. URL / Filter-State Coupling

### C.1 Route table (canonical from data-model.md §5)

| View | Path | Required segment | Filter params |
|---|---|---|---|
| Grid | `/` | — | `q`, `state`, `envs`, `layer` |
| Dossier | `/flag/:flagId` | `:flagId` | `pinEnv` |
| Ladder | `/ladder` | — | `flags` |
| Activity | `/activity` | — | `from`, `to`, `flags`, `envs` |
| Time Travel | `/travel` | — | `date`, `flags`, `envs` |
| Inert | `/inert` | — | `reason` |
| Sovereign | `/sovereign` | — | `flags`, `envs` |
| Velocity | `/velocity` | — | `window`, `flags` |

### C.2 URL ownership rules

- **Filter changes** use `router.replace()` (no history entry). C09 §4.1.
- **View navigation** uses `router.push()` (creates history entry). C09 §3.4.
- **Saved view `href`** is `pathname + search` only (no hash). C09 §4.4.
- **Unknown routes** redirect to `/`. C09 §4.2.

### C.3 Deep-link cold-load

Any URL can be the entry point. The shell always goes through:
`C09-S00` (auth) → `C09-S02` (data-loading) → `C09-S03` (populated) → route to requested view with params.
If the URL includes filter params, they are applied after data loads.

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C09-S00–S06` | C09 §8.1 top-level states |
| `C09-S10–S10b` | C09 §4.1, §2.2, §2.3 |
| `C09-S15–S18` | C09 §7.2; `_global.md` §5 |
| `C09-S19` | P3 gate ruling GAP-06; `G-FRESH-NEWER-HEAD`; `G-POLL-NEWER-HEAD` |
| `C09-S30–S35` | C09 §3.1–3.9 |
| `C09-S40–S43` | C09 §4.4, §7.5 |
| `C09-S43a` | P3 gate ruling GAP-12; C09 §4.4 |
| `C09-S50–S52` | C09 §7.6 |
| `C09-S60–S62` | C09 §6.4, §9.3 |
| `C09-S70–S73` | C09 §4.2, §7.4, §10; P3 gate ruling R2 (atomic rollback) |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| ~~Saved views max (20) enforcement UX not specified~~ | ~~LOW~~ | **RESOLVED (P3 gate ruling GAP-12):** "Maximum saved views reached — delete one first." (`C09-S43a`). |
| MRU (recent) max (5) eviction not specified | INFO | C09 §7.5 says max 5. Implicit FIFO is fine. |
| Palette keyboard shortcut conflict with browser | LOW | `Ctrl-K` may conflict with browser address-bar focus in some browsers. C09 §9.1 doesn't address. Recommend: check `event.defaultPrevented` before handling. |
| Offline mode not deeply specified | LOW | `G-NET-OFFLINE` in global handles it, but C09 §10 doesn't specify shell behaviour for offline (banner? greyed controls?). Recommend: amber banner + disable Refresh. |
| `Alt-8`, `Alt-9` keyboard shortcuts for cloud labels | INFO | C09 §9.1 mentions these but their purpose is unclear. Not a state — more of a keyboard shortcut mapping. |

---

**State count:** 35 distinct states (7 top-level + 3 nav + 5 freshness + 6 palette + 5 saved views + 3 theme + 3 auth + 4 error/edge)

*Sana — C09 Shell state matrix.*
