# C09 — Shell + Command Palette: Component Deep Spec

> **Component:** Shell + Command Palette (global app shell — connective tissue)
> **Feature:** F30 — EDOG Control Tower
> **Owner:** Sana (architecture + contracts), Pixel (JS/CSS), Vex (data engine — P2 delivers; C09 declares contract only)
> **Complexity:** HIGH — structural backbone; all 8 views depend on it
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Problem / Role](#1-problem--role)
2. [Navigation Model](#2-navigation-model)
3. [Cmd-K Command Palette Spec](#3-cmd-k-command-palette-spec)
4. [Deep-Link + URL Filter-State Scheme](#4-deep-link--url-filter-state-scheme)
5. [Refresh + Freshness Model](#5-refresh--freshness-model)
6. [Auth Chrome](#6-auth-chrome)
7. [Data Contract](#7-data-contract)
8. [State Matrix](#8-state-matrix)
9. [Keyboard & Accessibility](#9-keyboard--accessibility)
10. [Error Handling](#10-error-handling)
11. [Performance](#11-performance)
12. [Open Questions for P2](#12-open-questions-for-p2)

---

## 1. Problem / Role

Control Tower presents 8 surfaces across 3 layers. Without connective tissue each surface is an island — a URL with no entry point, filters with no persistence, views with no way to jump between them. **C09 — Shell** is the load-bearing frame that makes the product feel like one coherent application:

1. **Single navigable app.** One URL space, one top bar, one side nav, consistent chrome on every view. A user can arrive at any URL, sign in, and land exactly where the link pointed.
2. **Identity arbitration.** Microsoft Entra auth via NextAuth; delegated per-user tokens for ADO REST calls happen entirely server-side. The browser never receives or stores an access token. This is a hard rule inherited from P0.2 and is not negotiable.
3. **Repo freshness.** A persistent "data as of `master` commit `abc1234`" indicator on every view. A manual Refresh action that re-pulls `master` and diffs only new commits — never a full re-fetch.
4. **Cmd-K palette.** A single modal command surface for flag search, view navigation, and global actions (Refresh, theme toggle, copy link, sign-out). Aligns with F07 conventions; diverges where CT's read-only, web-hosted nature demands it.
5. **URL-encoded filter state + named saved views.** Every filter permutation is a shareable link. Named saved views are local-only aliases for URLs. Implements CEO-adopted Idea #5 (LD-style shareable dashboards, P0.3 §New ideas).
6. **Theme toggle.** Light mode on first load; preference persists in `localStorage`. Theme applied before first paint (no flash-of-wrong-theme).

**What C09 is not:** it does not own ADO REST calls, flag data, commit diffs, or attribution logic. Those belong to P2 (`architecture.md`). C09 declares the data contracts P2 must fulfill and wires the UI together.

### Relationship to other components

Every other view component (C01–C08, yet to be written) renders inside the content area C09 provides. They receive their data from their own route handlers. They may inject contextual palette actions into C09 via the action registry API (§7.3). C09 does not know the internals of any view.

---

## 2. Navigation Model

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

### 2.1 The 8 Views

| # | View ID | Route path | Display label | Layer |
|---|---------|------------|---------------|-------|
| ① | `grid` | `/` | Grid | Posture |
| ② | `dossier` | `/flag/:flagId` | Dossier | Posture |
| ③ | `ladder` | `/ladder` | Ladder | Motion |
| ④ | `activity` | `/activity` | Activity | Motion |
| ⑤ | `travel` | `/travel` | Time Travel | Motion |
| ⑦ | `inert` | `/inert` | Inert | Intelligence |
| ⑧ | `sovereign` | `/sovereign` | Sovereign | Intelligence |
| ⑨ | `velocity` | `/velocity` | Velocity | Intelligence |

> **Numbering gap:** View ⑥ (Drift Detection) is permanently cut (spec.md §3). The gap between ⑤ and ⑦ is intentional and must not be renumbered — it is referenced in ADR history and P0 research.

### 2.2 Shell Layout

Three persistent zones visible on all authenticated views:

```
┌──────────────────────────────────────────────────────────────────────┐
│  TOP BAR  (48px, position: sticky, z-index: 100)                     │
│  [logo]  [Cmd-K affordance]  ···  [freshness]  [↻]  [◗]  [avatar]   │
├──────────────┬───────────────────────────────────────────────────────┤
│  SIDE NAV    │  CONTENT AREA                                         │
│  (200px)     │  (view component renders here — each is a dynamic     │
│              │   import; shell owns no view-specific markup)         │
│  POSTURE     │                                                        │
│    Grid      │                                                        │
│    Dossier   │                                                        │
│  MOTION      │                                                        │
│    Ladder    │                                                        │
│    Activity  │                                                        │
│    Travel    │                                                        │
│  INTELL.     │                                                        │
│    Inert     │                                                        │
│    Sovereign │                                                        │
│    Velocity  │                                                        │
└──────────────┴───────────────────────────────────────────────────────┘
```

**Top bar (left to right):**
- App wordmark "Control Tower" — links to `/`; clicking from any view resets to Grid
- ◆ Cmd-K affordance button — label: `"Search or jump…  Ctrl-K"`; disabled (greyed, `pointer-events: none`) in `auth-pending` and `signed-out` states
- Spacer (`flex: 1`)
- Freshness chip (§5.2) — persistent, `role="status"`, `aria-live="polite"`
- Refresh button (`↻ Refresh`) — triggers re-pull (§5.3)
- Theme toggle (☀ light / ◗ dark icon-only button)
- Auth avatar chip (§6.2)

**Side nav:**
- Section groups: POSTURE · MOTION · INTELLIGENCE — uppercase labels, `color: var(--text-3)`, `font-size: 11px`, not interactive
- Dossier entry is always visible in the nav but renders muted (`opacity: 0.45`, `pointer-events: none`) when no flag is currently focused; it activates as soon as the user navigates to any `/flag/:flagId`
- Active view item: `color: var(--accent)`, left border `3px solid var(--accent)`, `background: color-mix(in srgb, var(--accent) 6%, var(--bg))`
- Side nav collapses to an icon-only rail at viewport ≤ 900px; layer section labels are replaced with layer-badge tooltips

**Content area:** full-height flex child; overflow-y managed per view; no shell-level scroll except on mobile

### 2.3 View Transitions

All view transitions are client-side (Next.js `router.push`). Content area cross-fades: outgoing view `opacity 1 → 0` (75ms), incoming view `opacity 0 → 1` (150ms), total ≤ 225ms. Previous view is unmounted after transition. `@media (prefers-reduced-motion: reduce)` collapses to instant swap.

When navigating to Dossier (`/flag/:flagId`), `:flagId` is required. If missing, redirect to `/`. Views that link to Dossier in context (Activity, Ladder, Inert, Sovereign, Velocity) always supply `:flagId`.

---

## 3. Cmd-K Command Palette Spec

### 3.1 Invocation

| Trigger | Behavior |
|---------|----------|
| `Ctrl-K` (Win/Linux) or `Cmd-K` (macOS) | Opens palette from anywhere; focus on input |
| Click "Search or jump…  Ctrl-K" in top bar | Same as keyboard |
| `Ctrl-K` while palette is open | Re-focuses input; selects all existing text |
| `Escape` while open and input has text | Clears input; shows recent items |
| `Escape` while open and input is empty | Closes palette |
| Two `Escape` presses when text was present | Closes palette (first press cleared, second press closes) |

Palette is unavailable (`auth-pending`, `signed-out`): the top-bar affordance renders with `pointer-events: none` and `opacity: 0.4`; `Ctrl-K` / `Cmd-K` is a no-op.

### 3.2 Visual Structure

| Property | Value |
|----------|-------|
| Backdrop | `background: rgba(0,0,0,0.25)`, fades in 150ms |
| Palette card | 520px wide, centered horizontally, `top: 20vh`; slides in from `scale(0.95) translateY(-8px)` → identity, 200ms ease-out spring; `border-radius: 12px`; `background: var(--bg)`; `border: 1px solid var(--border-bright)`; `box-shadow: var(--shadow-lg)` |
| Input | 44px height, 100% width within card padding; placeholder `"Search flags, views, actions…"`; magnifier icon (inline SVG) left; `×` clear icon right (appears when text is present) |
| Results area | `max-height: 420px`, scrollable; section headers sticky within scroll |
| Footer hint | `"↑↓ navigate · Enter select · Esc close"` — `color: var(--text-3)`, `font-size: 12px`; hidden when results area is empty and recents are empty |

Backdrop click = close palette (same animation reversed).

### 3.3 Result Categories

Result categories are displayed in the following order, with a `1px var(--border)` rule between each populated category.

**When query is empty (just opened):**

| Priority | Category | Header text | Shown when |
|----------|----------|-------------|-----------|
| 1 | SAVED VIEWS | "SAVED VIEWS" | `ct_saved_views` is non-empty |
| 2 | RECENT | "RECENT" | `ct_palette_recents` is non-empty |
| 3 | VIEWS | "VIEWS" | Always |
| 4 | ACTIONS | "ACTIONS" | Always |

FLAGS category is not shown when the query is empty — browsing the 42-flag corpus unprompted adds noise without utility.

**When query is non-empty:**

| Priority | Category | Header text | Condition |
|----------|----------|-------------|-----------|
| 1 | FLAGS | "FLAGS" | Any flag matches query |
| 2 | VIEWS | "VIEWS" | Any view name matches query |
| 3 | ACTIONS | "ACTIONS" | Any action label matches query |
| 4 | SAVED VIEWS | "SAVED VIEWS" | Any saved view name matches query |

Category headers: uppercase, `color: var(--text-3)`, `font-size: 11px`, `letter-spacing: 0.06em`, non-interactive, not focusable. Empty categories are silently omitted.

### 3.4 VIEWS Category

Each view result:
- Layer badge: `POSTURE` / `MOTION` / `INTELLIGENCE` — `color: var(--text-3)`, `font-size: 11px`
- View label — match characters bold + `color: var(--accent)`
- Keyboard shortcut (right-aligned `<kbd>` style) if one exists (see §9.1 `Alt-1`…`Alt-8`)

Selection: close palette → `router.push(viewPath)`. Filter state is not restored from saved views on bare VIEWS navigation — the user arrives at the view's default state. To restore a filter state, use SAVED VIEWS.

All 8 views are always listed (no max + "Show N more" expansion for views). Dossier appears in the list but is greyed and labelled "no flag selected" when no current flag exists; selecting it navigates to the last-visited flag dossier, or Grid if none.

### 3.5 FLAGS Category

**Search corpus:** all ~42 FLT flag IDs and their descriptions. Corpus is indexed client-side on first successful data load and kept in memory for the session.

**Match algorithm:** fuzzy substring, case-insensitive, against flag ID and description text. Matched characters rendered bold + `color: var(--accent)`. Ordered: exact prefix match > word-start match > substring match > description match.

**Each flag result shows:**
- Flag ID (matched chars highlighted)
- Compact per-env state summary: a row of coloured dots for the 6 promotion envs (`test cst daily dxt msit prod`). ● green = `on`; ○ grey = `off`; ◑ = conditional/targeted. Sovereign envs not shown in compact view.
- "Last enabled by `{name}`" in `var(--text-3)` if known from git attribution; `—` if unavailable
- `font-size: 12px` for the summary line

Max 5 results shown before "Show N more ▸" inline expander (expands to all matches, max 42, no virtualization needed at this scale).

Selection: close palette → `router.push('/flag/' + flagId)`. Flag added to `ct_palette_recents` (MRU, max 5).

### 3.6 ACTIONS Category

Global actions registered at app initialisation (always available unless `available === false`):

| Label | Icon | Keyboard shortcut hint | Behavior | `available` condition |
|-------|------|------------------------|----------|----------------------|
| Refresh — re-pull master | ↻ | — | Triggers engine refresh (§5) | `appState === 'populated'` or `appState === 'stale-error'` |
| Copy link to this view | ◆ | — | `navigator.clipboard.writeText(location.href)`; transient "Copied!" swap on the action label (1.5s) | Always |
| Save current view as… | ◇ | — | Opens inline name-entry within palette (see §4.4 save flow) | Always |
| Toggle theme | ◗/☀ | — | Light ↔ dark (§7.6) | Always |
| Sign out | ✕ | — | Calls NextAuth `signOut()` with `callbackUrl: '/'` | Signed-in only |

View-specific contextual actions injected by the active view via the action registry API (§7.3) appear after global actions, separated by a `1px var(--border)` rule. They are prefixed with the view name in `var(--text-3)`: e.g. `"GRID · Export to CSV"`.

### 3.7 SAVED VIEWS Category

Each saved view result shows:
- Saved view name (matched chars highlighted when query is non-empty)
- The target path + key params summarised (e.g. `/activity · prod, msit · 2026-01-01 – 2026-03-31`)
- ✕ delete button (right-aligned); clicking deletes without confirmation and removes the row inline

Selection: close palette → `router.push(savedView.href)`.

### 3.8 Empty State

No query, no history: full-width muted prompt `"Type to search flags, jump to a view, or run an action"`. No results list, no footer hint until a character is typed.

### 3.9 No-Results State

`"No results for '{query}'"` (query max 40 chars, ellipsized) + `"Try a different search."` below in `var(--text-3)`.

Fuzzy typo suggestion: if the query has a Levenshtein distance ≤ 2 from any known flag ID, show `"Did you mean '{suggestion}'?"` as a clickable link that replaces the input and re-runs the search.

### 3.10 Alignment with F07 (EDOG Command Palette)

Control Tower's Cmd-K adopts the same structural DNA as the F07 EDOG Studio palette to ensure familiarity for team members who use both tools.

**Shared conventions:**
- 520px width · `top: 20vh` · focus trap · Escape semantics · roving keyboard nav · category-grouped results with sticky headers · matched characters bold + accent · "↑↓ navigate · Enter select · Esc close" footer hint · "Show N more ▸" category expander · `aria-modal="true"` · MRU recents in `localStorage`

**Deliberate divergences:**

| Aspect | F07 (EDOG Studio) | C09 (Control Tower) |
|--------|-------------------|---------------------|
| Primary category | COMMANDS | FLAGS (when querying) |
| Write actions | Yes — Run DAG, Force Unlock, etc. | No — Refresh and navigation only; palette is read-only aligned |
| LOGS category | Phase 2 (absent in disconnected) | Not present — CT is git-derived |
| WORKSPACES / TABLES | Yes | Not present |
| Gate on auth | None (always open) | Disabled in `auth-pending` / `signed-out` |
| MRU key | `edog_palette_recents` | `ct_palette_recents` |
| Category order (empty) | RECENT → COMMANDS … | SAVED VIEWS → RECENT → VIEWS → ACTIONS |
| Category order (query) | COMMANDS → WORKSPACES … → FEATURE FLAGS | FLAGS → VIEWS → ACTIONS → SAVED VIEWS |

---

## 4. Deep-Link + URL Filter-State Scheme

### 4.1 URL as Complete State

Every filter permutation is a valid, shareable URL. There is no server-side view state. Copying the URL and opening it in another browser session, or sharing it with a colleague, produces the identical filtered surface (modulo live data updates since the URL was created). This is Idea #5 from P0.3, adopted by CEO decision on 2026-06-13.

`router.replace()` is used on every filter change (not `router.push()`) to avoid polluting browser history with every individual filter tweak. Navigation between views uses `router.push()`.

### 4.2 Route Table

| View | Base path | Required path segment | Filter params |
|------|-----------|-----------------------|---------------|
| Grid | `/` | — | `q`, `state`, `envs`, `layer` |
| Dossier | `/flag/:flagId` | `:flagId` — flag ID string | `pinEnv` |
| Ladder | `/ladder` | — | `flags` |
| Activity | `/activity` | — | `from`, `to`, `flags`, `envs` |
| Time Travel | `/travel` | — | `date`, `flags`, `envs` |
| Inert | `/inert` | — | `reason` |
| Sovereign | `/sovereign` | — | `flags`, `envs` |
| Velocity | `/velocity` | — | `window`, `flags` |

Unrecognised params are silently ignored. Malformed param values (wrong enum, invalid date) fall back to defaults without error UI.

### 4.3 Query Parameter Reference

| Param | Type | Legal values | Default (absent = default) | Used on views |
|-------|------|--------------|---------------------------|---------------|
| `q` | string | free text | `""` (no filter) | Grid |
| `state` | csv enum | `on`, `off`, `conditional`, `targeted`, `missing` | all states | Grid |
| `envs` | csv enum | any subset of the 15 env keys | all 15 envs | Grid, Activity, Time Travel, Sovereign |
| `layer` | enum | `posture`, `motion`, `intelligence` | — (cosmetic hint only) | Grid |
| `pinEnv` | csv enum | any subset of the 15 env keys | — (no pin) | Dossier |
| `flags` | csv string | flag ID strings | all flags | Ladder, Activity, Time Travel, Sovereign, Velocity |
| `from` | ISO date `YYYY-MM-DD` | any valid date | 30 days before `to` | Activity |
| `to` | ISO date `YYYY-MM-DD` | any valid date | today | Activity |
| `date` | ISO date `YYYY-MM-DD` | any valid date ≤ today | today | Time Travel |
| `reason` | csv enum | `on-prereq-off`, `probably-launched`, `probably-dead`, `probably-forgotten` | all reasons | Inert |
| `window` | enum | `7d`, `30d`, `90d`, `1y` | `30d` | Velocity |

CSV params use comma as delimiter with no spaces: `envs=test,cst,prod` not `envs=test, cst, prod`.

### 4.4 Named Saved Views

A saved view is a user-assigned name mapped to a URL stored in `localStorage` under key `ct_saved_views`.

```typescript
interface SavedView {
  id: string;      // UUID v4, stable across renames
  name: string;    // user label, max 80 chars
  href: string;    // pathname + search string only — no origin, no hash
  savedAt: string; // ISO 8601 timestamp
}
// localStorage value: JSON.stringify(SavedView[])
```

**Save flow:** user selects "Save current view as…" from the Cmd-K palette. The palette transitions inline to a name-entry state: a text input appears in place of the palette header with placeholder `"Name this view…"`, pre-focused. `Enter` or clicking "Save ◆" persists the entry and closes the palette. `Escape` cancels without saving and returns to the palette's previous state.

**Load flow:** saved views appear in the SAVED VIEWS palette category. Selecting one closes the palette and navigates to `router.push(savedView.href)`.

**Delete flow:** ✕ button on each saved view row in the palette. No confirmation required.

**Cap:** 20 entries. On overflow, the save prompt shows: `"You have 20 saved views — delete the oldest ('…') to save a new one?"` with [Delete oldest + save] and [Cancel].

**Sharing:** to share a saved view, copy the URL (the `href` is already the complete shareable state). The name is local only — the recipient does not see the name. Sharing = sharing the URL.

**localStorage unavailability (private/incognito):** saved views are silently disabled. No error is shown. The SAVED VIEWS palette category does not appear.

### 4.5 Deep-Linking Behaviour

**Valid deep link** (e.g. `/flag/FLTArtifactBasedThrottling?pinEnv=prod`): shell authenticates the user (if not already), loads data, renders Dossier with `prod` pinned. The full experience.

**Invalid flag ID** (e.g. `/flag/FLTFlagThatDoesNotExist`): Dossier renders a "Flag not found" state (§10). The flag ID in the URL is preserved so the user can see what they tried to link to.

**Cross-view context links:** views linking to a flag's Dossier append `?pinEnv=<env>` when the originating context is env-specific (e.g. clicking a prod-specific activity entry navigates to `/flag/:flagId?pinEnv=prod`).

---

## 5. Refresh + Freshness Model

### 5.1 What "Refresh" Means

Refresh is an incremental, targeted operation — not a full re-fetch of all 42 flags. The engine (P2) executes the following on every Refresh invocation:

1. **Discover new commits:** for each of the ~42 FLT flag paths in the engine's registry, call the ADO commits endpoint (`GET .../commits?searchCriteria.itemPath=<path>&searchCriteria.itemVersion.version=master`) and compare the returned top `commitId` against the engine's cached `lastSeenCommitId[path]`.
2. **Diff only changed files:** for paths where `topCommitId !== lastSeenCommitId`, fetch file content at both commitIds and diff the `Environments` blocks semantically. Commit content is cached immutably by `commitId` and never re-fetched.
3. **Update attribution:** extract author + PR linkage from new commit messages.
4. **Return delta:** `RefreshResponse` (§7.4) — `flagsUpdated`, `newCommits`, new `headCommitId`, `syncedAt`.

Only files with new commits are touched. Files whose `lastSeenCommitId` has not changed are served from the immutable `commitId` cache. This keeps refresh fast at 13K-file repo scale per P0.2 risk mitigation (R5).

### 5.2 Freshness Indicator

Persistent in the top bar, always visible in authenticated states.

**Format:** `◆ as of {shortSha} · {relativeTime}`
- `◆` = filled diamond (`U+25C6`), coloured per staleness threshold (below)
- `{shortSha}` = first 7 chars of `headCommitId`
- `{relativeTime}` = human-relative: `"just now"` / `"3 min ago"` / `"2 hours ago"` / `"1 day ago"` etc.

**Hover tooltip** (`title` + accessible `aria-describedby` tooltip): `"Last synced: {syncedAt formatted as 'YYYY-MM-DD HH:mm UTC'} — commit {headCommitId}: {headCommitMessage truncated to 72 chars}"`.

**Staleness thresholds:**

| Age since `syncedAt` | `◆` color | Text color | Meaning |
|----------------------|-----------|-----------|---------|
| < 15 min | `var(--green)` | `var(--text-2)` | Fresh |
| 15 min – 1 hr | `var(--amber)` | `var(--amber)` | Aging |
| > 1 hr, or last refresh failed | `var(--red)` | `var(--red)` | Stale — click Refresh |

When `appState === 'data-loading'` (cold first-load): `◆ Loading…` in `var(--text-3)`.
When `appState === 'stale-loading'` (refresh in progress): `◆ Refreshing… · {stale relativeTime}` — the stale `shortSha` is retained until the refresh completes.

### 5.3 Refresh Button States

| Button state | Visual | Behavior |
|---|---|---|
| Idle | `↻ Refresh` (icon + label) | Click triggers `POST /api/ct/refresh` |
| In-progress | Spinning `↻` icon + `"Refreshing…"` label | `disabled` attribute set; `aria-disabled="true"` |
| Succeeded | Returns to Idle; freshness chip updates immediately | Toast (if changes): `"Refreshed — {N} flag(s) updated"`. Toast (if no changes): `"Up to date"`. Auto-dismisses 4s. |
| Failed | Returns to Idle; freshness chip turns red | Toast: `"Refresh failed — {reason}. Showing data from {relativeTime} ago."` Stays until dismissed. |

Refresh is available from:
- Top-bar Refresh button
- Cmd-K palette ACTIONS → "Refresh — re-pull master"

Refresh is **not** available in `signed-out` or `auth-pending` states (ADO calls require a valid user session). The button and palette action are hidden in those states.

**Freshness polling (V1):** The shell runs a passive 60-second poll against `GET /api/ct/updates` (§7.2) — one cheap ADO `$top=1` HEAD-check — to detect whether `master` HEAD has advanced beyond the warm store's `headCommitId`. When `newerHeadAvailable` is true, a non-blocking banner surfaces: `"{pendingCommitCount} new events — Refresh"`. The poll never mutates the warm store. Polling is paused via the Page Visibility API when the tab is hidden. (The freshness chip itself is driven by `GET /api/ct/freshness`, which is metadata-only and never calls ADO.)

**Auto-refresh (V1):** C04's opt-in auto-refresh toggle (default OFF) piggybacks on the freshness poll. When enabled and a newer HEAD is detected, the shell automatically triggers `POST /api/ct/refresh` (atomic — all-or-nothing per §7.4). Explicit refresh via the Refresh button remains available at all times.

### 5.4 Initial Load Freshness

On first authenticated page load the shell calls `GET /api/ct/freshness`:
- **Warm cache (P2 has engine state):** freshness payload returns immediately; content area renders with `appState → populated`.
- **Cold cache (first deploy, cache evicted):** freshness returns `{ loading: true }` or equivalent signal; shell enters `data-loading` state; views render skeleton until full data is available.

The distinction between warm and cold belongs to P2 (`architecture.md`). C09 observes only the shape of the response.

---

## 6. Auth Chrome

### 6.1 Auth Model Summary (inherited from P0.2 — do not re-litigate)

- **Hosting:** Vercel, Next.js App Router.
- **Auth provider:** Microsoft Entra via NextAuth `AzureADProvider`. Auth-code flow requesting Azure DevOps scope (`499b84ac-1321-427f-aa17-267ca6975798/.default`).
- **Token lifecycle:** the NextAuth session is stored in an encrypted HTTP-only cookie (JWT strategy default). The ADO access token is held server-side. Refresh token is refreshed server-side as needed. **The access token never reaches the browser.**
- **All ADO REST calls:** Next.js server-side route handlers only. Browser receives rendered data.
- **Audience:** the full PM/TPM/eng audience already has FM-repo read access (confirmed by CEO) → no service principal, no client secret, no provisioning ask.
- **Tenant restriction:** enforced at Entra app registration level (deployment concern, P2/P7). C09 does not implement tenant checks.

C09 consumes the session via `useSession()` from `next-auth/react`. It does not implement auth logic.

### 6.2 Auth Chrome Layout

The auth chrome is the rightmost segment of the top bar. Three states:

**`authenticated`:**
```
[AV]
```
`[AV]` = avatar chip: 32px circle, `background: var(--accent)`, `color: #fff`, `font-weight: 600`, `font-size: 13px`. Initials derived from `session.user.name` (§6.3).

Click opens a downward dropdown (`box-shadow: var(--shadow-md)`, `border: 1px solid var(--border-bright)`, `border-radius: 8px`, `background: var(--bg)`):
- Display name (bold, `color: var(--text)`, `font-size: 14px`)
- Email (`color: var(--text-3)`, `font-size: 12px`)
- `1px var(--border)` rule
- "Sign out  ✕" — calls `signOut({ callbackUrl: '/' })`

**`loading` (NextAuth `status === "loading"`):**
- Skeleton circle: 32px, `background: var(--bg-3)`, pulse animation (opacity 1 → 0.4 → 1, 1.2s ease-in-out infinite). Reduced-motion: no pulse.

**`unauthenticated` (NextAuth `status === "unauthenticated"`):**
- "Sign in with Microsoft" button — `background: var(--accent)`, `color: #fff`, `border-radius: 6px`, `padding: 6px 14px`, `font-size: 13px`, `font-weight: 500`. Clicking calls `signIn('azure-ad', { callbackUrl: window.location.href })` to preserve the current URL as the post-sign-in redirect.

### 6.3 Avatar Initials

Derived from `session.user.name`:
- Multi-word name: uppercase first character of first word + uppercase first character of last word. Example: `"Ayush Singhal"` → `"AS"`.
- Single-word name: first two characters, uppercase. Example: `"Jayaprakash"` → `"JA"`.
- Name unavailable (`undefined` / empty): `"?"` with `background: var(--text-3)`.

If `session.user.image` is present (Entra profile photo URL), render it as the avatar background image and omit initials text. Fall back to initials on image load error.

### 6.4 Session Expiry During Active Use

When `useSession()` transitions from `authenticated` to `unauthenticated` mid-session (token expiry or explicit sign-out):
- Shell transitions to `signed-out` immediately (see §8).
- Any in-flight `fetch` with an `AbortController` is cancelled.
- The current URL (including filter state) is preserved as the `callbackUrl` for the sign-in flow, so the user returns to their exact view after re-signing in.
- A toast is shown before the transition: `"Your session expired. Signing you out…"` (1.5s, then sign-in screen).

---

## 7. Data Contract

C09 declares the contracts below. P2 (`architecture.md`) is solely responsible for fulfilling them. C09 does not make direct ADO REST calls and does not interpret raw FM JSON.

### 7.1 Session Context (NextAuth, client-side)

```typescript
// Source: useSession() from next-auth/react
// Available in browser. Does NOT contain access tokens.
interface CTSession {
  user: {
    name: string;
    email: string;
    image?: string;    // Entra profile photo URL; may be absent; fall back to initials
  };
  expires: string;     // ISO 8601 — when the NextAuth session cookie expires
}
```

### 7.2 Repo Freshness Payload (server-side, `GET /api/ct/freshness`)

```typescript
interface FreshnessPayload {
  headCommitId: string;        // full SHA of the most recent master commit touching any FLT flag
  headCommitMessage: string;   // first line of that commit message, truncated to 72 chars
  committedAt: string;         // ISO 8601 — when headCommitId was authored
  syncedAt: string;            // ISO 8601 — when the engine last fetched master
  flagsTracked: number;        // count of FLT flag paths in the engine's registry (~42)
  stale: boolean;              // true if (now - syncedAt) > 60 min, or last refresh failed
  staleReason?: 'age' | 'error';
  error?: string;              // human-readable error if last refresh failed; omitted on success
}
```

C09 calls this endpoint on mount and after every Refresh action. Response drives the freshness chip and `stale-error` state.

#### Updates check (passive poll, `GET /api/ct/updates`)

```typescript
interface UpdatesCheckPayload {
  newerHeadAvailable: boolean; // true if remote master HEAD (FLT scope) is ahead of the warm store's headCommitId
  pendingCommitCount: number;  // number of new commits on the FLT scope path since the warm store's headCommitId (0 when up to date)
  remoteHeadCommitId: string;  // the latest remote commit SHA observed by this check
  checkedAt: string;           // ISO 8601 — when this remote check ran
}
```

Unlike `/api/ct/freshness` (metadata-only, never calls ADO), `/api/ct/updates` makes **one** cheap ADO commit query (`$top=1` on the FLT scope path) to detect whether `master` advanced. C09 calls it on the **60-second passive poll** (paused on hidden tabs via the Page Visibility API). When `newerHeadAvailable` is true, the shell shows the non-blocking `"{pendingCommitCount} new events — Refresh"` banner. The poll never mutates the warm store; only an explicit (atomic) Refresh does.

### 7.3 Action Registry API (shell ↔ view component interface)

View components may inject contextual palette actions into the ACTIONS category via the shell's React context.

```typescript
interface ContextualAction {
  id: string;               // stable, unique within the view — e.g. "grid-export-csv"
  label: string;            // displayed in palette, max 48 chars
  icon: string;             // single Unicode symbol or inline SVG `<svg>` string
  shortcut?: string;        // display label only, e.g. "Shift-E" — shell does not register the shortcut
  execute: () => void | Promise<void>;
  available?: boolean;      // defaults to true; false = greyed-out with unavailableReason
  unavailableReason?: string;
}

// React context exported by the shell as ShellActionsContext
interface ShellActionsContext {
  registerActions: (viewId: string, actions: ContextualAction[]) => void;
  unregisterActions: (viewId: string) => void;
}
```

View components call `registerActions` on mount and `unregisterActions` on unmount. The shell merges view actions after global actions in the palette, separated by a `1px var(--border)` rule, prefixed with the view name: `"{VIEW LABEL} · {action label}"`.

View components must not call `registerActions` with side-effectful `execute` callbacks that mutate data outside the CT product (CT is read-only — no writes to FM or any external system).

### 7.4 Refresh Trigger Contract (`POST /api/ct/refresh`)

```typescript
// Request: no body required (empty POST)

interface RefreshResponse {
  flagsUpdated: number;  // FLT flag files that had new commits since last sync
  newCommits: number;    // total new commits across all updated files
  headCommitId: string;  // new head after refresh (unchanged on failure — no partial advance)
  syncedAt: string;      // ISO 8601 timestamp of this refresh run
  durationMs: number;    // server-side duration of the refresh
  error?: string;        // present on failure; warm store is UNCHANGED (atomic rollback)
}
```

Refresh is **atomic** (all-or-nothing). On success: `flagsUpdated ≥ 0`, new `headCommitId`, new `syncedAt`; freshness chip updates; toast: `"Refreshed — {N} flag(s) updated"` (or `"Up to date"`). On failure (`error` present): the warm store, `headCommitId`, and `syncedAt` are **unchanged** — no flags are committed. Freshness chip turns red; `appState → stale-error`; toast: `"Refresh incomplete — showing last-good data from {relativeTime}. ↻ Try again"`. There is no partial-success path.

### 7.5 Saved Views Storage (client-side only, `localStorage`)

```typescript
// localStorage key: 'ct_saved_views'
// Value: JSON.stringify(SavedView[])
interface SavedView {
  id: string;      // UUID v4; stable across renames
  name: string;    // user label, max 80 chars
  href: string;    // pathname + search string only — no origin, no fragment
  savedAt: string; // ISO 8601
}
```

Cap: 20 entries. On `localStorage` quota error: surface a toast `"Could not save view — storage full."` and do not truncate existing saved views silently.

### 7.6 Theme Preference (client-side only, `localStorage`)

```
localStorage key: 'ct_theme'
Legal values: 'light' | 'dark'
Absent key: default to 'light'
```

Applied to `<html data-theme="light|dark">` by an inline blocking script in `<head>` (the only inline script in the document, strictly for FOUC prevention). CSS custom properties follow the design-bible-part1.html token baseline:

```css
:root {
  --accent: #6d5cff;
  --green:  #18a058;
  --amber:  #e5940c;
  --red:    #e5453b;
  --purple: #a855f7;
  --bg:     #fff;      --bg-2: #f8f9fb;  --bg-3: #f4f5f7;  --bg-4: #ebedf0;
  --text:   #1a1d23;   --text-2: #5a6070;  --text-3: #8e95a5;
  --border: rgba(0,0,0,0.06);  --border-bright: rgba(0,0,0,0.12);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.06);
}
[data-theme="dark"] {
  --bg:     #0f1117;   --bg-2: #161923;  --bg-3: #1e2230;  --bg-4: #252a38;
  --text:   #e8eaf0;   --text-2: #9aa0b2;  --text-3: #5f6578;
  --border: rgba(255,255,255,0.06);  --border-bright: rgba(255,255,255,0.12);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.2);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.5), 0 4px 8px rgba(0,0,0,0.3);
}
```

> **Design-bible deviation note:** EDOG Studio (F16 skin) applies the same token set but defaults to dark. Control Tower defaults to **light** because its primary audience is PMs/TPMs in bright-screen office environments. Dark is opt-in. This is intentional; P4 must not override the light default.

---

## 8. State Matrix

### 8.1 Top-Level App States

| State | Entry condition | What the user sees | Views accessible | Cmd-K |
|-------|-----------------|-------------------|------------------|-------|
| `auth-pending` | Page load; NextAuth `status === "loading"` | Full-screen centred skeleton: app logo + `"Loading…"` (no nav, no content, no freshness). Auth chrome shows skeleton avatar. | None | Disabled |
| `signed-out` | `status === "unauthenticated"` | Full-screen sign-in page: logo + wordmark + one-line description + "Sign in with Microsoft" button. No nav, no content, no freshness chip. Top bar: logo + sign-in button only. | None | Disabled |
| `data-loading` | Authenticated; first load or cold engine cache | Top bar + side nav visible. Freshness chip: `"◆ Loading…"`. Content area: skeleton (shimmer rows). Refresh button: disabled (spinner). | Navigate (skeleton content) | Open; FLAGS empty |
| `populated` | Authenticated; engine data available (`FreshnessPayload` received, `stale: false`) | Full app. All 8 views accessible. Freshness chip: `"◆ as of {sha} · {relativeTime}"` in green/neutral. | All 8 | Fully functional |
| `stale-loading` | `populated`; Refresh in progress | Top bar and content remain populated (stale data). Freshness chip: `"◆ Refreshing… · as of {sha} · {relativeTime}"`. Refresh button: spinner + disabled. | All 8 (stale data) | Functional; Refresh action greyed |
| `stale-error` | Refresh failed; previous engine data still available | Content remains populated. Freshness chip red: `"◆ as of {sha} · {relativeTime} · stale"`. Amber top-bar banner: `"Last refresh failed — {reason}. Showing data from {relativeTime} ago.  ↻ Try again"` | All 8 (stale data) | Functional; Refresh available |
| `hard-error` | Authenticated; engine data unavailable (first load failed, no cache) | Error state in content area only: `"Could not load FeatureManagement data — {reason}"` + `"↻ Retry"` + link to troubleshooting. Side nav visible but every view link shows the same error panel. Freshness chip: `"◆ —"`. | Error panel only | Open; FLAGS empty |

### 8.2 State Transition Diagram

```
             Page load
                 │
         ┌───────▼────────┐
         │  auth-pending  │
         └───────┬────────┘
          session│resolved
        ┌────────┴────────┐
        ▼                 ▼
  signed-out         data-loading
        │                 │
  [sign-in]       engine data
        │           resolves
        │          ┌──────┴──────────────┐
        │          ▼                     ▼
        │      populated             hard-error
        │       │   │  ▲                 │
        │  [Refresh] │  │ success     [Retry]
        │       │   │  └──────────────────┘
        │       ▼   │
        │  stale-loading
        │       │   │
        │  failure  success
        │       │       │
        │       ▼       ▼
        │  stale-error  populated
        │       │
        │   [Retry]
        │       │
        │  stale-loading
        │
        └──── [session expires / sign-out] ──→ signed-out
```

### 8.3 Refresh Sub-State (within `populated`)

`populated` → `stale-loading` → (success) `populated` (freshness updated)
`populated` → `stale-loading` → (failure) `stale-error`
`stale-error` → [Try again] → `stale-loading`

### 8.4 Per-View State Extensions

Each view (C01–C08) has its own loading/error/populated states. The top-level `appState` is the **precondition** — `populated` (or `stale-loading`/`stale-error`) is required before any view component renders its own data states. Views must gracefully handle stale data (the data contract is valid; it may just be old).

---

## 9. Keyboard & Accessibility

### 9.1 Global Keyboard Shortcuts

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Ctrl-K` / `Cmd-K` | Open Cmd-K palette | Works anywhere; no-op if `signed-out` or `auth-pending` |
| `Escape` | Palette close / clear (per §3.1) | Handled by palette; shell does not intercept |
| `Alt-1` | Navigate to Grid (`/`) | Shell-level shortcut; works when palette is closed |
| `Alt-2` | Navigate to Dossier | Navigates to last-visited flagId, or no-ops (with tooltip) if none visited yet |
| `Alt-3` | Navigate to Ladder (`/ladder`) | |
| `Alt-4` | Navigate to Activity (`/activity`) | |
| `Alt-5` | Navigate to Time Travel (`/travel`) | |
| `Alt-7` | Navigate to Inert (`/inert`) | Note: `Alt-6` is intentionally unused (view ⑥ is cut) |
| `Alt-8` | Navigate to Sovereign (`/sovereign`) | |
| `Alt-9` | Navigate to Velocity (`/velocity`) | |
| `?` | Open keyboard shortcut reference | Only when focus is not inside a text input. Shows all shortcuts as a modal overlay. |

### 9.2 Side Nav

- Standard `<nav>` landmark with `aria-label="Main navigation"`.
- Nav items are `<a>` elements; roving Tab focus.
- Active view: `aria-current="page"`.
- Muted Dossier item (no flag selected): `aria-disabled="true"`, `tabindex="-1"`.
- Section group labels (`POSTURE` etc.): `role="group"` with `aria-label`.

### 9.3 Top Bar Accessibility

| Element | ARIA |
|---------|------|
| Logo link | `aria-label="Control Tower — home"` |
| Cmd-K affordance button | `role="button"`, `aria-keyshortcuts="Control+k Meta+k"`, `aria-label="Search or jump (Ctrl-K)"` |
| Freshness chip | `role="status"`, `aria-live="polite"`, `aria-label="Data freshness: {current freshness text}"` |
| Refresh button | `aria-label="Refresh — re-pull master"`. `aria-disabled="true"` + `disabled` when in-progress. |
| Theme toggle | `role="switch"`, `aria-checked` (`true` = dark), `aria-label="Dark theme"` |
| Auth avatar | `role="button"`, `aria-label="Account: {name}"`, `aria-haspopup="menu"`, `aria-expanded` set on open |
| Auth dropdown | `role="menu"` with `role="menuitem"` children |
| Sign-out item | `role="menuitem"` |

### 9.4 Palette Focus Trap

Full focus trap (mirrors F07 implementation):
- `aria-modal="true"` on palette card.
- `Tab` from last result wraps to input; `Shift-Tab` from input wraps to last result.
- On close, focus returns to the element that held focus immediately before the palette opened. If that element no longer exists, focus falls to `<main>`.

### 9.5 Reduced Motion

All shell-level animations (palette open/close scaling, view cross-fade, freshness chip colour transitions, avatar skeleton pulse) honour `@media (prefers-reduced-motion: reduce)` — all transitions collapse to instant `0ms` duration, no opacity animations.

### 9.6 Colour Contrast

All text must meet WCAG 2.1 AA (4.5:1 minimum) against its background. The freshness chip staleness colours (`var(--amber)` and `var(--red)`) must not rely solely on colour to communicate staleness — the `◆` symbol prefix and tooltip text provide a colour-independent channel.

---

## 10. Error Handling

| Error scenario | Top-bar behaviour | Content area behaviour | Recovery |
|----------------|------------------|----------------------|----------|
| ADO unreachable on first load | Freshness chip: `"◆ —"` | Hard-error state: `"Could not load FeatureManagement data — {reason}."` + `↻ Retry` | Retry re-triggers initial data load |
| ADO unreachable on Refresh | Freshness chip turns red + stale timestamp | Amber banner: `"Refresh failed — {reason}. Showing data from {relativeTime} ago.  ↻ Try again"` | `Try again` link in banner |
| Refresh failure (any cause, incl. partial ADO errors) | Freshness chip turns red + stale timestamp | Atomic rollback: warm store is unchanged. Banner: `"Refresh incomplete — showing last-good data from {relativeTime}. ↻ Try again"`. `appState → stale-error`. | `↻ Try again` retries the full refresh |
| Session expires mid-session | Toast: `"Your session expired."` (1.5s), then shell → `signed-out` | Sign-in screen replaces content area | Sign in; redirected to original URL via `callbackUrl` |
| Invalid flag ID in URL | — | Dossier: `"Flag '{flagId}' not found in the FLT registry."` + pre-filled search box + `"← Back to Grid"` | Search or navigate away |
| Invalid / unrecognised query params | — | Silently ignored; view renders with defaults | No action needed |
| `localStorage` unavailable | — | Saved views and palette MRU disabled silently; theme defaults to light | No action needed; no error shown |
| Cmd-K corpus not yet loaded | Palette FLAGS category shows `"Loading flag index…"` while `appState === 'data-loading'` | — | Resolves automatically on data load |
| Theme FOUC | Prevented by inline `<head>` script reading `localStorage ct_theme` before hydration | — | — |

---

## 11. Performance

- **Shell bundle:** no view-specific code in the shell bundle. Each view component is a Next.js dynamic import (`dynamic(() => import('./views/Grid'), { ssr: false, loading: () => <ViewSkeleton /> })`). Shell first-meaningful-paint targets < 200ms on a warm Vercel edge function.
- **Freshness endpoint (`GET /api/ct/freshness`):** must respond < 500ms server-side — reads from P2's warm engine cache, never calls ADO synchronously. C09 calls it on mount with an AbortController (5s timeout); if it times out, shell enters `hard-error`.
- **Cmd-K palette open latency:** all 42 flag entries indexed client-side in memory at first data load. Filter is synchronous (no debounce, no network). Palette must open and display results < 50ms from keypress. 8 view entries are hard-coded. Actions registered at mount-time.
- **URL filter-state sync:** `router.replace()` on every filter change (not `router.push()`). Batched: if multiple filter params change in one React render cycle, a single `router.replace()` call is made (not one per param).
- **Flag corpus index size:** ~42 flags, each entry ≤ ~500 bytes including description. Total ≤ ~21 KB uncompressed. No virtualization needed for palette results at this scale.
- **Theme FOUC:** the inline `<head>` script is the only blocking script. It reads one `localStorage` key and sets one attribute on `<html>`. Budget: < 1ms.
- **Memory:** palette MRU (`ct_palette_recents`) capped at 5 entries. Saved views (`ct_saved_views`) capped at 20. No unbounded `localStorage` growth.

---

## 12. Open Questions for P2

| # | Question | Owning phase | Impact on C09 |
|---|----------|-------------|---------------|
| OQ-1 | What is P2's server-side caching strategy for engine state? In-memory (per Vercel function invocation — evicted on cold start) or a persistent store (Vercel KV, Upstash)? | P2 `architecture.md` | Determines how often `data-loading` skeleton is shown. Frequent cold starts make `hard-error` recovery UX more prominent. |
| OQ-2 | Confirm: does `CTSession.expires` reflect the NextAuth session cookie expiry, not the ADO access token expiry? The two can differ because NextAuth can refresh the ADO token silently while the session cookie remains valid. | P2 `architecture.md` | Determines when C09 shows the "session expired" toast vs. silently refreshing. |
| OQ-3 | Is `POST /api/ct/refresh` coalesced server-side? If two browser tabs call it simultaneously, does the engine run one refresh or two? | P2 `architecture.md` | If not coalesced, C09 may need a client-side debounce / lock to avoid duplicate requests from the same user in multi-tab usage. |
| OQ-4 | ~~Should the shell implement a background auto-refresh timer in V1?~~ | **RESOLVED** — CEO ruling (P3 gate): V1 includes a 60-second passive poll (`GET /api/ct/updates`, one cheap ADO `$top=1` HEAD-check, detection-only) and C04's opt-in auto-refresh toggle (default OFF). The Page Visibility API pauses polling when the tab is hidden. The optional `"will auto-refresh in X"` UX hint is polish — not required for V1. See §5.3. | Implemented in §5.3. |
| OQ-5 | What is the canonical production URL? Deep links are only fully shareable from the deployed Vercel URL, not `localhost`. Is `localhost` a supported developer configuration? If yes, the saved-view `href` must not be treated as externally shareable when the origin is `localhost`. | P2 / P7 deployment | Determines whether C09 shows a "this link is only valid on production" hint when copying a URL from a `localhost` session. |
| OQ-6 | What is the deterministic flag count? P0.2 says "~42–43 FLT-prefix files." `flagsTracked` in the freshness payload shows this number in the UI. It should be a stable integer before P4 (mock). | P2 engine (flag registry finalisation) | Cosmetic: affects copy in the freshness chip tooltip and any "N flags tracked" UI surfaces. |
| OQ-7 | Should saved views persist server-side (tied to Entra identity) in a future V2 phase? V1 is `localStorage`-only. If V2 server-sync is planned, the saved-views menu slot in the palette should be designed with expansion capacity (e.g. a "Sync" affordance placeholder) rather than being treated as permanently local. | CEO / P2 (V2 scope) | If V2 sync is planned, add a placeholder "Sync saved views" action in V1 that leads to a "coming soon" toast rather than designing the UI to local-only constraints. |
