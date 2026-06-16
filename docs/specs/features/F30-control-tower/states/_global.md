# F30 Control Tower — Global State Machine

> **Status:** P3 — State Matrices
> **Phase:** P0 ✅ → P1 ✅ → P2 ✅ → **P3** → P4 → P5
> **Owner:** Sana (state architecture), Pixel (loading & error rendering)
> **Canonical data model:** [`data-model.md`](../data-model.md)
> **Architecture:** [`architecture.md`](../architecture.md)
> **Last updated:** 2026-06-13

---

## 1. Purpose

This file defines the **cross-cutting state machine** that every view inherits. Per-view state files (`C01-grid.states.md` … `C09-shell.states.md`) reference IDs defined here — they do not redefine them. If a per-view state references `G-AUTH-EXPIRED`, it means *exactly* what this file specifies.

---

## 2. Auth Lifecycle Machine

Every API call runs under the signed-in user's delegated Entra token (architecture.md §2.1). The browser never holds an ADO access token.

### 2.1 State inventory

| State ID | Name | Description | What the app shell shows | Interactive? | Source |
|---|---|---|---|---|---|
| `G-AUTH-PENDING` | Auth check in progress | App has loaded; session cookie being validated server-side | Full-screen skeleton — no nav, no content, no palette | No | architecture.md §2.2 step 1–2; C09 §8.1 `auth-pending` |
| `G-AUTH-REDIRECT` | Redirecting to Entra | No valid session found; 302 to Entra authorize endpoint | Brief blank or branded splash; browser navigates away | No | architecture.md §2.2 steps 3–5 |
| `G-AUTH-CALLBACK` | Processing auth callback | Entra redirected back with `code=`; server exchanging for tokens | Loading spinner or "Signing in…" interstitial | No | architecture.md §2.2 steps 6–8 |
| `G-AUTH-SIGNED-IN` | Authenticated | Valid session cookie set; MSAL cache has user's ADO token | Shell renders: nav, top bar, user avatar, content area | Yes | architecture.md §2.2 steps 9+; C09 §8.1 `populated` |
| `G-AUTH-TOKEN-REFRESH` | Silent token refresh | ADO access token (~1h) expired; MSAL `acquireTokenSilent` in progress on server | **Transparent to user** — no visible indicator; in-flight API calls queue behind refresh | Yes (UI stays interactive) | architecture.md §2.5 |
| `G-AUTH-EXPIRED` | Session expired | Auth.js session >8h or MSAL refresh token (~24h) expired or revoked (CAE); next API call returns 401 | Toast: "Session expired — sign in again" → after 3s, redirect to Entra login | No (content frozen pending redirect) | architecture.md §2.5; C09 §6.4, §10 |
| `G-AUTH-FORBIDDEN` | No FM repo access | User authenticates but 403 from ADO — lacks FM repo read permission | Full-page message: "You don't have access to the FeatureManagement repository. Contact your ADO org admin." + Sign out button | Sign-out only | architecture.md §7.2 `UNAUTHORIZED` |

### 2.2 Transition table

| From | Event | To | Side effect |
|---|---|---|---|
| `G-AUTH-PENDING` | Session cookie valid | `G-AUTH-SIGNED-IN` | Shell renders, first API call fires |
| `G-AUTH-PENDING` | No session cookie | `G-AUTH-REDIRECT` | 302 to Entra `/authorize` |
| `G-AUTH-REDIRECT` | User completes Entra login | `G-AUTH-CALLBACK` | Browser follows redirect to `/api/auth/callback` |
| `G-AUTH-REDIRECT` | User cancels / closes tab | (app unloaded) | — |
| `G-AUTH-CALLBACK` | Token exchange succeeds | `G-AUTH-SIGNED-IN` | `Set-Cookie: session`; MSAL cache populated |
| `G-AUTH-CALLBACK` | Token exchange fails | `G-AUTH-REDIRECT` | Retry auth flow (with error flash) |
| `G-AUTH-SIGNED-IN` | ADO access token expires (~1h) | `G-AUTH-TOKEN-REFRESH` | MSAL `acquireTokenSilent` called server-side |
| `G-AUTH-TOKEN-REFRESH` | Refresh succeeds | `G-AUTH-SIGNED-IN` | New access token in MSAL cache; queued calls proceed |
| `G-AUTH-TOKEN-REFRESH` | Refresh fails (token revoked / expired) | `G-AUTH-EXPIRED` | 401 returned to browser |
| `G-AUTH-SIGNED-IN` | Auth.js session expires (>8h) | `G-AUTH-EXPIRED` | Next API call returns 401 |
| `G-AUTH-EXPIRED` | 3s timer fires | `G-AUTH-REDIRECT` | Redirect to Entra login |
| `G-AUTH-SIGNED-IN` | User clicks Sign Out | `G-AUTH-REDIRECT` | Session destroyed; redirect to Entra login |
| `G-AUTH-SIGNED-IN` | 403 on first ADO call | `G-AUTH-FORBIDDEN` | Full-page access-denied message |

---

## 3. App Boot / Cold-Load Machine

On first visit after server restart (or server-side warm store empty), the cold-load fetches ~2,185 ADO requests over ~30s (architecture.md §6.4). Per OQ-03, the grid renders in ~4s with state-only data; attribution fills asynchronously.

### 3.1 State inventory

| State ID | Name | Precondition | What's rendered | Data completeness | Source |
|---|---|---|---|---|---|
| `G-BOOT-UNAUTH` | Unauthenticated shell | Page loaded, no session | `G-AUTH-PENDING` or `G-AUTH-REDIRECT` state (§2 above) | none | architecture.md §8.1 step 1–3 |
| `G-BOOT-SKELETON` | Authenticated skeleton | Session valid, first `/api/ct/grid` in flight | Shell chrome (nav, top bar, user avatar). Content area: 42 skeleton rows with shimmer. Progress indicator: "Loading Control Tower…" | none | architecture.md §8.1 step 9; C09 §8.1 `data-loading`; C01 §4 |
| `G-BOOT-PROGRESSIVE` | Progressive hydration — state only | Grid API returned state-only data (~4s). Historical walk in progress on server. | Grid renders with CellState values. Attribution columns show shimmer placeholders. Shell progress: "Building attribution history… N/42 flags complete." Stale/dwell/velocity columns show "—". | state-only | architecture.md §8.1 steps 10b–11; OQ-03 |
| `G-BOOT-WARM` | Fully hydrated | Historical walk + all derivations complete. Warm store populated. | Grid fully rendered with attribution, stale hints, prerequisite indicators. All views navigable. Progress indicator dismissed. Freshness chip shows "Data as of [time]". | full | architecture.md §8.1 steps 12–15 |
| `G-BOOT-INTERSTITIAL` | Attribution still loading — non-grid view | User navigated to a non-grid view (C03/C05/C06/C07/C08) while `G-BOOT-PROGRESSIVE` is active | View-specific interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s. Nav remains enabled. | state-only (attribution pending) | P3 gate ruling R1 |

### 3.2 Transition table

| From | Event | To | Side effect |
|---|---|---|---|
| `G-BOOT-UNAUTH` | Auth completes | `G-BOOT-SKELETON` | `GET /api/ct/grid` fires |
| `G-BOOT-SKELETON` | Grid API returns state-only data | `G-BOOT-PROGRESSIVE` | Grid renders CellState values; server continues historical walk |
| `G-BOOT-SKELETON` | Grid API returns full data (warm store already populated from another user) | `G-BOOT-WARM` | Grid renders fully; skip progressive phase |
| `G-BOOT-SKELETON` | Grid API fails (5xx / network) | `G-ERR-HARD` | Hard error screen (§6) |
| `G-BOOT-SKELETON` | Grid API returns 401 | `G-AUTH-EXPIRED` | Session expired redirect |
| `G-BOOT-SKELETON` | Grid API returns 403 | `G-AUTH-FORBIDDEN` | Access denied screen |
| `G-BOOT-PROGRESSIVE` | Attribution + derivations arrive (server signals completion) | `G-BOOT-WARM` | Columns fill in; progress indicator dismissed; freshness chip set |
| `G-BOOT-PROGRESSIVE` | Attribution fetch partially fails (some flags 429'd) | `G-BOOT-WARM` | Grid renders available data; failed flags show "—" for attribution. Amber banner: "Some flag histories unavailable. Refresh to retry." |
| `G-BOOT-PROGRESSIVE` | User navigates to a non-grid view before warm | `G-BOOT-INTERSTITIAL` | View shows interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retry 3s. (P3 gate ruling R1) |
| `G-BOOT-PROGRESSIVE` | 401 during historical walk | `G-AUTH-EXPIRED` | Session expired; partial data lost |

### 3.3 Progress indicator behaviour

| Phase | Shell progress text | Shell progress bar | Source |
|---|---|---|---|
| `G-BOOT-SKELETON` | "Loading Control Tower…" | Indeterminate | C09 §8.1 |
| `G-BOOT-PROGRESSIVE` | "Building attribution history… {n}/42 flags" | Determinate ({n}/42) | architecture.md §6.4 |
| `G-BOOT-WARM` | (dismissed) | (dismissed) | — |

---

## 4. Refresh Machine

Refresh mutates the warm store **atomically** — on ANY partial failure the server rolls back to the last-good vintage. The user triggers a refresh explicitly (C09 Refresh button, Cmd-K action, or freshness-chip click). A **passive freshness poll** (§4.4) detects when `master` HEAD has advanced and surfaces a banner; the poll never mutates data.

### 4.1 State inventory

| State ID | Name | Precondition | What's rendered | Interactive? | Source |
|---|---|---|---|---|---|
| `G-REFRESH-IDLE` | No refresh in progress | Warm store populated; last sync within 60 min | Freshness chip: green "Data as of [time]". Refresh button enabled. | Yes — full interactivity | C09 §7.2 |
| `G-REFRESH-STALE-IDLE` | Stale, no refresh in progress | `(now - syncedAt) > 60 min` | Freshness chip: amber "Data as of [time] — Refresh". Refresh button enabled. | Yes — full interactivity; amber banner optional | C09 §7.2; architecture.md §6.3 |
| `G-REFRESH-IN-PROGRESS` | Refresh in flight | User clicked Refresh or Cmd-K action | Freshness chip: spinner + "Refreshing…". Refresh button disabled (3s cooldown after completion). Current data remains visible. Navigation allowed. | Yes — views show stale data; navigation allowed | C09 §7.4; architecture.md §8.2 |
| `G-REFRESH-SUCCESS` | Refresh succeeded | `POST /api/ct/refresh` returned 200; all flags synced | Toast: "Data refreshed — [N] new commits found". Freshness chip resets to green. All derived caches invalidated and rebuilt. Active view re-fetches. | Yes | C09 §7.4 |
| `G-REFRESH-FAILED` | Refresh failed (atomic rollback) | `POST /api/ct/refresh` returned error OR any partial failure (e.g. 30/42 flags succeeded but 12 failed) | Server rolls back to last-good vintage — **no mixed-vintage data ever committed**. Toast: "Refresh incomplete — showing last-good data from [time]. Retry." Freshness chip: red "Last refresh failed — Retry". All prior data retained intact. Refresh button re-enables. | Yes — last-good data still shown | C09 §8.1 `stale-error`; architecture.md §7.2; P3 gate ruling R2 |

### 4.2 Transition table

| From | Event | To | Side effect |
|---|---|---|---|
| `G-REFRESH-IDLE` | Stale timer fires (>60 min) | `G-REFRESH-STALE-IDLE` | Freshness chip turns amber |
| `G-REFRESH-IDLE` | User clicks Refresh / Cmd-K action | `G-REFRESH-IN-PROGRESS` | `POST /api/ct/refresh` fires |
| `G-REFRESH-STALE-IDLE` | User clicks Refresh / freshness chip | `G-REFRESH-IN-PROGRESS` | `POST /api/ct/refresh` fires |
| `G-REFRESH-IN-PROGRESS` | Refresh API returns 200, all flags OK | `G-REFRESH-SUCCESS` | Toast; invalidate derived caches; re-derive |
| `G-REFRESH-IN-PROGRESS` | Refresh API returns 200 but some flags failed (partial) | `G-REFRESH-FAILED` | **Atomic rollback:** server discards partial results; warm store retains last-good vintage. Toast: "Refresh incomplete — showing last-good data from [time]. Retry." (P3 gate ruling R2) |
| `G-REFRESH-IN-PROGRESS` | Refresh API returns error (5xx/network) | `G-REFRESH-FAILED` | Atomic rollback; error toast; chip turns red |
| `G-REFRESH-IN-PROGRESS` | 401 during refresh | `G-AUTH-EXPIRED` | Session expired redirect |
| `G-REFRESH-IN-PROGRESS` | User navigates to another view | `G-REFRESH-IN-PROGRESS` | Refresh continues; new view loads from current (stale) data |
| `G-REFRESH-SUCCESS` | 3s cooldown expires | `G-REFRESH-IDLE` | Refresh button re-enables |
| `G-REFRESH-SUCCESS` | Stale timer fires (should not happen immediately) | `G-REFRESH-STALE-IDLE` | — |
| `G-REFRESH-FAILED` | User clicks Retry | `G-REFRESH-IN-PROGRESS` | `POST /api/ct/refresh` fires again |

### 4.3 Mid-refresh navigation ruling

**Navigation is allowed during refresh.** The refresh is a server-side operation; the browser polls for completion or receives a response. View transitions work normally — the new view loads from the current warm store (which may be stale). When the refresh completes, a system event triggers re-fetch for the active view.

### 4.4 Freshness Poll Machine (V1 — P3 gate ruling GAP-06)

The client runs a **passive freshness poll**: `GET /api/ct/updates` every 60s. This makes one cheap ADO `$top=1` HEAD-check and returns `{ newerHeadAvailable, pendingCommitCount, remoteHeadCommitId, checkedAt }`. **The poll never mutates the warm store** — it is detection-only. The actual data refresh remains user-triggered and atomic (§4.1). Note: `/api/ct/freshness` is metadata-only (last sync time, flag count) and cannot detect remote advances — the poll must use `/api/ct/updates`.

#### 4.4.1 State inventory

| State ID | Name | Precondition | What's rendered | Source |
|---|---|---|---|---|
| `G-POLL-IDLE` | Poll idle | Poll timer not yet fired, or last poll showed HEAD unchanged | No indicator — freshness chip remains in its current state (`G-FRESH` or `G-STALE`) | P3 gate ruling GAP-06 |
| `G-POLL-NEWER-HEAD` | Newer HEAD detected | `GET /api/ct/updates` returned `newerHeadAvailable: true` | Freshness chip gains a blue dot / "{pendingCommitCount} new changes available — Refresh" text. On C04: banner "{pendingCommitCount} new events available — Refresh" (`C04-S01h`). On C09: chip transitions to `C09-S19`. | P3 gate ruling GAP-06 |

#### 4.4.2 Transition table

| From | Event | To | Side effect |
|---|---|---|---|
| `G-POLL-IDLE` | 60s timer fires | (poll in-flight) | `GET /api/ct/updates` fires silently |
| (poll in-flight) | Response: `newerHeadAvailable: false` | `G-POLL-IDLE` | No visible change; timer resets |
| (poll in-flight) | Response: `newerHeadAvailable: true` | `G-POLL-NEWER-HEAD` | Freshness chip updated; C04 banner shown; timer continues (subsequent polls may show further advances) |
| (poll in-flight) | Response: error / offline | `G-POLL-IDLE` | Silent failure; retry on next timer tick |
| `G-POLL-NEWER-HEAD` | User clicks Refresh | `G-REFRESH-IN-PROGRESS` | Atomic refresh fires; poll indicator cleared on success |
| `G-POLL-NEWER-HEAD` | Refresh succeeds | `G-POLL-IDLE` | Poll indicator dismissed; HEAD now matches |
| `G-POLL-NEWER-HEAD` | Refresh fails | `G-POLL-NEWER-HEAD` | Indicator remains; user can retry |
| `G-POLL-IDLE` | App enters `G-NET-OFFLINE` | `G-POLL-IDLE` | Poll timer paused; resumes on reconnect |

---

## 5. Freshness Indicator States

The freshness chip lives in C09's top bar (C09 §7.2, §5.4). All views inherit its visual state.

| State ID | Chip colour | Chip text | Chip icon | Source |
|---|---|---|---|---|
| `G-FRESH` | Green | "Data as of [relative time]" | ● | C09 §7.2 |
| `G-FRESH-NEWER-HEAD` | Blue-green | "New changes available — Refresh" | ● + blue dot | P3 gate ruling GAP-06; §4.4 `G-POLL-NEWER-HEAD` |
| `G-STALE` | Amber | "Data as of [relative time] — Refresh" | ● | C09 §7.2; architecture.md §6.3 |
| `G-REFRESHING` | Neutral | "Refreshing…" | Spinner | C09 §7.4 |
| `G-FRESH-ERROR` | Red | "Last refresh failed — Retry" | ◆ | C09 §8.1 `stale-error` |

**Relative time format:** "2 min ago", "47 min ago", "3 hours ago". Hover tooltip shows absolute ISO-8601 timestamp.

---

## 6. Global Error Boundary

### 6.1 State inventory

| State ID | Name | Trigger | What's rendered | Recovery | Source |
|---|---|---|---|---|---|
| `G-ERR-401` | Unauthorized / session expired | Any API returns 401 | Toast: "Session expired — sign in again" → 3s redirect | Redirect to Entra login | architecture.md §2.5; C09 §6.4 |
| `G-ERR-403` | Forbidden — no FM access | Any API returns 403 | Full-page: "You don't have access to the FeatureManagement repository." + Sign out | Contact ADO admin; sign out | architecture.md §7.2 |
| `G-ERR-429` | Rate limited | Any API returns 429 | Per-view: inline banner "Rate limited — retrying in [N]s". Auto-retry with `Retry-After` header. Max 3 retries → partial data. | Automatic retry; if exhausted → partial data with amber banner | architecture.md §6.5 |
| `G-ERR-5XX` | Server error | Any API returns 500/502/503 | Per-view: error card with message + Retry button. If stale data exists in warm store, it is served alongside the error indicator. | Retry button; if stale data available, it remains visible | architecture.md §7.2 |
| `G-ERR-NETWORK` | Network unreachable | `fetch` throws `TypeError` (no response) | Per-view: "Unable to connect. Check your network and try again." + Retry button | Retry button | (inferred from standard web app patterns) |
| `G-ERR-HARD` | Unrecoverable error | Server start fails; warm store cannot be built at all; no stale data | Full-page error: "Something went wrong. Control Tower could not load data from the FeatureManagement repository." + Retry (full page reload) + "Open FM repo in ADO ↗" link | Full page reload | C09 §8.1 `hard-error` |
| `G-ERR-PARSE` | Parse error | A flag file's JSON is unparseable (not one of the 4 known shapes) | Per-cell `?` indicator in grid; per-view graceful handling. Not a full-page error. | Refresh may fix if the parse error was transient; otherwise it persists until FM repo is corrected | C01 §4.2; architecture.md §7.2 `PARSE_ERROR` |
| `G-ERR-TIMEOUT` | Per-endpoint timeout | Individual API call exceeds client-side timeout | Per-view: inline error with Retry. Same as `G-ERR-5XX` visually but with "Request timed out" message. | Retry button | (inferred from §6.5 concurrency model) |

### 6.2 Error escalation hierarchy

```
Per-cell (G-ERR-PARSE)           → cell shows `?`, row still usable
Per-panel (diff error)           → inline error in expandable section
Per-view (G-ERR-5XX, G-ERR-429) → view-level error card, stale data if available
Per-app (G-ERR-HARD)             → full-page error, no data shown
Auth (G-ERR-401, G-ERR-403)      → redirect or full-page access denied
```

---

## 7. Network / Connectivity States

| State ID | Name | Detection | Behaviour | Source |
|---|---|---|---|---|
| `G-NET-ONLINE` | Normal connectivity | Default | All API calls proceed normally | — |
| `G-NET-OFFLINE` | Browser offline | `navigator.onLine === false` or `offline` event | Banner: "You are offline. Data shown may be outdated." All API calls deferred. Refresh button disabled. | (standard web pattern) |
| `G-NET-SLOW` | Degraded connectivity | API calls exceeding 10s timeout threshold | No explicit indicator beyond per-view loading states. If multiple calls timeout, falls to `G-ERR-TIMEOUT`. | architecture.md §6.4 |
| `G-NET-NAV-CANCEL` | Navigation cancels in-flight requests | User navigates to another view while API calls are in flight | Previous view's pending requests are aborted (`AbortController`). New view initiates its own fetches. Refresh (if in progress) is NOT cancelled by navigation. | (standard SPA pattern; §4.3 ruling) |

---

## 8. Cross-Cutting Data Tokens

These tokens are referenced by per-view state files to avoid redefinition.

### 8.1 Data-completeness tokens

| Token ID | Meaning | Columns available | Columns unavailable | Source |
|---|---|---|---|---|
| `G-DATA-NONE` | No data loaded yet | — | All | — |
| `G-DATA-STATE-ONLY` | CellState values available; no attribution, no derivations | CellState per env, flag name, description, rolloutBreadth | Attribution (author, PR, date), stale reason, dwell, velocity, inert signal, prerequisite details | OQ-03; architecture.md §8.1 step 11 |
| `G-DATA-FULL` | All data available | All columns | — | architecture.md §8.1 step 12 |
| `G-DATA-PARTIAL` | Most data available; some flags missing attribution or derivations | CellState for all flags; attribution/derivations for successfully mined flags | Attribution/derivations for failed flags (show "—") | architecture.md §6.5 |

### 8.2 Empty-state tokens

| Token ID | Meaning | Message template | Source |
|---|---|---|---|
| `G-EMPTY-NO-FLAGS` | Zero FLT flags found in FM@master | "No FLT flags found in FeatureManagement@master" | C01 §4 |
| `G-EMPTY-FILTER` | Active filters exclude all results | "No flags match your current filters" + clear-filters link | C01 §3.9; C04 §5.3 |
| `G-EMPTY-DATE-RANGE` | No activity in selected date range | "No FLT flag activity in this date range" + widen/clear | C04 §6.8 |
| `G-EMPTY-NO-GAPS` | Zero sovereign gaps found | "All sovereign clouds are at parity with commercial prod" + view full matrix link | C07 §3.4 |
| `G-EMPTY-NO-INERT` | Zero inert findings | "No inert flags detected" + analysis basis | C06 §7.1 |
| `G-EMPTY-INSUFFICIENT` | Too few data points for meaningful analysis | "Not enough rollout history to compute velocity metrics" | C08 §5 |

### 8.3 Stale-data tokens

| Token ID | Meaning | Visual | Source |
|---|---|---|---|
| `G-STALE-BANNER` | Data older than 60 min | Amber banner across top of content area: "Data may be outdated — last synced [time]. Refresh" | architecture.md §6.3 |
| `G-STALE-SERVED` | API returned stale data with `stale: true` in response metadata | Per-view amber indicator; exact position varies by view | architecture.md §7.2 |

### 8.4 Attribution-absence tokens

| Token ID | Meaning | Display rule | Source |
|---|---|---|---|
| `G-ATTR-ABSENT` | Attribution is null for a cell (no commit history mined yet or mining failed) | **Silently omit** — render the CellState value; do not show "Unknown" or placeholder. The attribution line simply doesn't appear. | data-model.md §3; C01 §4.2; architecture.md OQ-03 |
| `G-ATTR-NO-PR` | `prNumber === null` in Attribution | No PR link rendered. Author + commit hash + date still shown. | data-model.md §3.1 |

---

## 9. Accessibility Cross-Cuts

These apply to ALL views. Per-view files add view-specific ARIA contracts on top.

| ID | Concern | Specification | Source |
|---|---|---|---|
| `G-A11Y-REDUCED-MOTION` | `prefers-reduced-motion: reduce` | All animations (shimmer, spinners, progress bars, toasts) replaced with static equivalents. Shimmer → solid placeholder colour. Spinners → static icon with `aria-busy`. Toasts appear without slide-in. | C09 §9.5 |
| `G-A11Y-FOCUS-TRAP` | Modal / dialog focus containment | Cmd-K palette, slide-in panels (C07), and any future modal must trap focus. `Tab` cycles within; `Escape` closes. Focus returns to trigger element on close. | C09 §9.4; C07 §6 |
| `G-A11Y-LIVE-REGION` | Async content announcements | Toast messages use `role="alert"`. Freshness chip uses `role="status"` + `aria-live="polite"`. Progress indicator uses `aria-live="polite"`. Error banners use `role="alert"`. | C09 §9.3; C01 §5.3 |
| `G-A11Y-FOCUS-VISIBLE` | Keyboard focus indicators | All interactive elements must show a visible focus ring (`:focus-visible`). Never suppressed. Minimum 2px offset, contrast ≥3:1 against adjacent. | C01 §5.4 |
| `G-A11Y-SKIP-LINK` | Skip-to-content link | First focusable element: "Skip to main content" link that jumps past nav to content area. | (WCAG 2.1 standard) |

---

## 10. Theme States

| State ID | Description | Persistence | Source |
|---|---|---|---|
| `G-THEME-LIGHT` | Light theme (default) | `localStorage` key `ct_theme` | C09 §7.6 |
| `G-THEME-DARK` | Dark theme (opt-in) | `localStorage` key `ct_theme` | C09 §7.6 |
| `G-THEME-FOUC-GUARD` | Inline `<script>` reads `localStorage` before first paint to prevent flash of wrong theme | Runs synchronously in `<head>` | C09 §7.6, §10 |

---

## 11. Global State Composition Rules

1. **Auth is outermost.** No other state machine runs until `G-AUTH-SIGNED-IN` is reached.
2. **Boot runs once per server cold-start.** If the warm store is already populated (another user triggered the cold-load), `G-BOOT-SKELETON` transitions directly to `G-BOOT-WARM`.
3. **Refresh is orthogonal to view states.** A refresh can occur while any view is active. The view continues showing stale data; when refresh completes, the view re-fetches.
4. **Freshness is derived.** `G-FRESH` / `G-STALE` / `G-REFRESHING` / `G-FRESH-ERROR` are computed from `syncedAt` and refresh state, not set independently.
5. **Error states are scoped.** `G-ERR-401` and `G-ERR-403` are global (affect entire app). `G-ERR-429`, `G-ERR-5XX`, `G-ERR-NETWORK`, `G-ERR-TIMEOUT` are per-view or per-endpoint. `G-ERR-PARSE` is per-cell.
6. **Per-view states compose with global states.** A view in its `populated` state can simultaneously show `G-STALE-BANNER` or experience `G-ERR-429` on a sub-request.

---

*Sana — P3 global state machine. Per-view files reference these IDs.*
