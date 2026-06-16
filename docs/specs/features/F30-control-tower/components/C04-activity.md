# C04 — Activity Stream: Component Deep Spec

> **Component:** Activity Stream (Control Tower, Layer 2 — Motion)
> **Feature:** F30 — Control Tower
> **Owner:** Sana (architecture + data contract), Vex (data engine — ADO REST + event store), Pixel (JS/CSS implementation)
> **Complexity:** HIGH — reverse-chronological diff-mined event feed with timeline visualization
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13
> **Adopted ideas (CEO-locked 2026-06-13):** #3 JSON-diff Details · #4 env filter + grouped-dots timeline · #5 URL-encoded filter state

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [Layout & Interaction Model](#4-layout--interaction-model)
5. [State Matrix](#5-state-matrix)
6. [Scenarios](#6-scenarios)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)
11. [Open Questions for P2](#11-open-questions-for-p2)

---

## 1. Overview

The Activity Stream answers the question no current tooling can answer: *"What changed across FLT feature flags, in which environments, by whom, and when?"* Today the answer requires manually running `git log` over 42 JSON files, cross-referencing PR history, and reconstructing change sequences by hand. There is no aggregate view.

C04 is a **reverse-chronological feed** of every per-environment state change across all 42 FLT flags, reconstructed by P2's diff-mining engine from the `master` branch of the FeatureManagement repo. It is **Layer 2 — Motion** in the Control Tower's three-layer model: it shows how things move, never why, and makes no prescriptive recommendation. An entry that reads `off → on in msit` is an observation. It does not say "this rollout is on track."

### Role in the system

| Question | C04's answer |
|---|---|
| What changed across all FLT flags this week? | Reverse-chrono feed, date-range filter |
| Who enabled `FLTArtifactBasedThrottling` in `bleu`? | Entry: "Last enabled by Jayaprakash Kupparaju · 05 May 2026" |
| What PR flipped `prod` to fully on? | Entry → "Merged PR NNNN ↗" |
| What was the exact JSON state before the change? | Entry → expand Details → Environments block diff (adopted idea #3) |
| How does this week's rollout look visually? | Horizontal timeline with env-filtered grouped dots (adopted idea #4) |

C04 is **read-only**. It never exposes a write action. The only mutations are filter state (client-local) and an optional auto-refresh toggle (re-polls `master`).

### Relationship to other components

| Component | Relationship |
|---|---|
| C01 — Control Grid | Grid cells deep-link into C04 pre-filtered to that flag + env. C04 does not depend on the Grid being rendered. |
| C02 — Flag Dossier | Clicking a flag name in C04 navigates to the Dossier for that flag. C04 does not own the dossier view. |
| C03 — Rollout Ladder | Shares the 6-env promotion ladder concept. C04 is the time dimension of the same state data. |
| F11/C03 Feature Flags Matrix (EDOG Studio) | Unrelated. C04 never reads `EdogFeatureOverrideStore`. Different product, audience, and data source. |

---

## 2. Data Model

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

### 2.1 Core types

```typescript
type EnvKey =
  | 'onebox' | 'test' | 'cst' | 'daily' | 'dxt' | 'msit' | 'prod'
  | 'mc' | 'gcc' | 'gcchigh' | 'dod' | 'usnat' | 'ussec' | 'bleu' | 'usgovcanary';

/**
 * The four env-state shapes from P0 §P0.2.
 * 'off' covers both `{}` (empty block) and absent key.
 */
type EnvStateShape = 'off' | 'on' | 'conditional' | 'targeted';

/**
 * Direction of the state transition, used for badge styling and filter keys.
 * 'content-change' = same shape (e.g. Requires → Requires) but different block content.
 */
type TransitionKind =
  | 'off→on'
  | 'on→off'
  | 'off→conditional'
  | 'conditional→on'
  | 'off→targeted'
  | 'targeted→on'
  | 'on→conditional'
  | 'conditional→off'
  | 'targeted→off'
  | 'conditional→targeted'
  | 'targeted→conditional'
  | 'content-change';
```

### 2.2 ActivityEvent

```typescript
interface ActivityEvent {
  /**
   * Stable synthetic ID: `${flagId}::${env}::${newCommitId}`.
   * Used for React keys, deep-links, and diff-panel caching.
   */
  id: string;

  /** FM flag Id, e.g. "FLTArtifactBasedThrottling". */
  flagId: string;

  /** The environment whose state changed. */
  env: EnvKey;

  /** Classified transition for badge rendering and filtering. */
  transition: TransitionKind;

  /**
   * Raw FM JSON block for the changed env key at the older commit.
   * null when the env key was absent (state was 'off').
   */
  beforeBlock: Record<string, unknown> | null;

  /**
   * Raw FM JSON block for the changed env key at the newer commit.
   * null when the env key was removed (state became 'off').
   */
  afterBlock: Record<string, unknown> | null;

  /** Human-readable author name from the commit. Never fabricated; never "unknown" inferred. */
  author: string;

  /**
   * Attribution label. Rule:
   *   - transition ends in 'on' (off→on, conditional→on, targeted→on) → 'Last enabled by'
   *   - any other transition → 'Last modified by'
   * Never 'Owner', 'Maintainer', or 'Created by' unless the commit is the flag-creation commit
   * (--diff-filter=A equivalent), in which case 'Created by' is allowed for that single entry.
   */
  attributionLabel: 'Last enabled by' | 'Last modified by' | 'Created by';

  /** Commit SHA of the newer (post-change) commit. Immutable once stored. */
  commitId: string;

  /** Full commit message text. Used for PR extraction and the Details panel header. */
  commitMessage: string;

  /**
   * PR number parsed from "Merged PR NNNN" in the merge-commit message.
   * null if no PR reference is present (direct push to master, or non-standard message).
   */
  prNumber: number | null;

  /**
   * ADO PR deep-link:
   * "https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/{N}".
   * null when prNumber is null.
   */
  prUrl: string | null;

  /**
   * ISO 8601 commit author date, e.g. "2026-03-13T14:22:00Z".
   * Rendered as relative time in the feed; absolute on hover.
   */
  timestamp: string;
}
```

### 2.3 ActivityStreamQuery (filter parameters — all three LOCKED filters)

```typescript
interface ActivityStreamQuery {
  /** LOCKED FILTER: inclusive start date ("YYYY-MM-DD"). Default: 30 days ago. */
  dateFrom?: string;

  /** LOCKED FILTER: inclusive end date ("YYYY-MM-DD"). Default: today. */
  dateTo?: string;

  /**
   * LOCKED FILTER: flag filter. Zero or more FM flag Ids. Empty = all 42 FLT flags.
   * Must match FLT flag Ids exactly (e.g. "FLTArtifactBasedThrottling").
   */
  flagIds?: string[];

  /**
   * LOCKED FILTER (adopted idea #4): env filter. Zero or more env keys. Empty = all 15 envs.
   * Affects both the feed entries and the timeline dot display.
   */
  envs?: EnvKey[];

  /**
   * Optional transition filter. Empty = all transitions.
   * 'enablements' is a convenience alias for all transitions ending in 'on'.
   * 'disablements' is a convenience alias for all transitions ending in 'off'.
   */
  transitions?: TransitionKind[];

  /** 1-based page number. Default: 1. */
  page?: number;

  /** Events per page. Default: 50. Max: 200. */
  pageSize?: number;

  /**
   * Incremental refresh cursor. When provided, the server returns only events from
   * commits newer than this commitId (used by the auto-refresh path). The server
   * still applies all other filters to the new events.
   */
  since?: string;
}
```

### 2.4 ActivityStreamResponse

```typescript
interface ActivityStreamResponse {
  /** UTC ISO timestamp when the event store was last fully built or refreshed. */
  generatedAt: string;

  /**
   * The newest commitId scanned in the current store.
   * Passed as `?since=` on subsequent refresh calls to limit diff computation to new commits.
   */
  fetchedThroughCommit: string;

  /** Total event count in the store, with no filters applied. */
  totalEvents: number;

  /** Event count after applying the current query filters. */
  filteredCount: number;

  /** Filtered, sorted (newest-first), paginated events. */
  events: ActivityEvent[];

  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
  };

  /**
   * Flag-commitId pairs where diff computation failed (transient ADO REST error,
   * JSON parse failure). Surface as a non-blocking warning banner; never suppress
   * the rest of the feed.
   */
  gaps: Array<{
    flagId: string;
    oldCommitId: string;
    newCommitId: string;
    reason: string;
  }>;
}
```

### 2.5 EnvDiffDetail (Details panel payload — lazy-loaded on first expand)

```typescript
interface EnvDiffDetail {
  /** Mirrors ActivityEvent.id this detail belongs to. */
  eventId: string;

  /**
   * Full FM Environments object from the flag's JSON file at the old commitId (all 15 env keys).
   * null if the old commit was the flag-creation commit (no prior state).
   */
  beforeEnvironments: Record<string, Record<string, unknown>> | null;

  /**
   * Full FM Environments object from the flag's JSON file at the new commitId (all 15 env keys).
   */
  afterEnvironments: Record<string, Record<string, unknown>>;

  /**
   * All env keys whose block changed in this commit (may be more than one if a single
   * PR touched multiple envs for this flag). Used to highlight all changed keys in the
   * context pane.
   */
  allChangedEnvs: EnvKey[];

  /** Short commit SHA for display (first 7 chars of commitId). */
  shortCommitId: string;
}
```

> **P2 obligation:** `beforeEnvironments` and `afterEnvironments` must be the full 15-env `Environments` blocks fetched via `GET .../items?path=<path>&versionDescriptor.versionType=commit&versionDescriptor.version=<sha>`. Content is immutably cached by commitId — never re-fetched for a SHA already in cache. The diff panel is a pure client-side JSON comparison; P2 supplies raw objects only.

### 2.6 TimelineSummaryPoint (compact, for timeline painting)

```typescript
interface TimelineSummaryResponse {
  generatedAt: string;
  fetchedThroughCommit: string;

  /** One point per event in the filtered window. No full event blocks — timestamps and keys only. */
  points: Array<{
    timestamp: string;   // ISO 8601
    env: EnvKey;
    transition: TransitionKind;
    flagId: string;
    eventId: string;     // reference into the feed for scroll-to
  }>;
}
```

### 2.7 P2 data-engine obligations (declared here; implementation → `architecture.md`)

| Obligation | Constraint |
|---|---|
| Attribution mechanism | Consecutive-commit `Environments` diff (P0 §P0.2 step 5). Line-`blame` is explicitly disallowed (reformat-vulnerable per P0 risk R3). |
| PR linkage | Extract `Merged PR NNNN` from merge-commit message. Link: `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/{N}`. |
| commitId cache | Content keyed by commitId is **immutable** — cache forever; never re-fetch a SHA already stored. |
| Incremental refresh | Re-poll the path-commits list per flag; diff only commits newer than `fetchedThroughCommit`. |
| Author name | Use commit `author.name` verbatim. Never fabricate or normalize. |
| Attribution label | Computed server-side per event per the `attributionLabel` rule in §2.2. |
| Scope | Only the 42 FLT flags (path regex `/FLT[^/]+\.json$/`). Never emit events for other flags. |
| All ADO REST calls | Server-side only (Next.js route handlers). The access token never reaches the browser. |
| `content-change` detection | JSON deep-equality on the block. Whitespace-normalized before comparison (reformat-proof, per P0 R3). |

---

## 3. API Surface

### 3.1 `GET /api/ct/activity`

Returns the filtered, paginated event feed.

**Query params:** all fields of `ActivityStreamQuery` serialized as query string. Array params use repeated keys: `envs=test&envs=msit`.

**Response:** `ActivityStreamResponse`.

**Cache policy:** not cached by the browser. The server serves filtered slices from its warm in-memory event store without re-diffing on every request. `generatedAt` reflects when the store was last built or refreshed.

### 3.2 `GET /api/ct/activity/diff/{eventId}`

Returns `EnvDiffDetail` for a single event. Lazy-loaded by the Details panel on first expand.

**Path param:** `eventId` is the synthetic `flagId::env::commitId` value from `ActivityEvent.id`.

**Cache policy:** immutable. The browser may cache this response indefinitely (commitId-anchored content never changes).

### 3.3 `GET /api/ct/activity/timeline`

Returns compact point data for the timeline strip without full event payloads.

**Query params:** same as `ActivityStreamQuery` (all filters apply). Array params use repeated keys.

**Response:** `TimelineSummaryResponse`.

**Rationale for a separate endpoint:** the full event payload (including `beforeBlock`, `afterBlock`, `commitMessage`) is not needed to paint the timeline. Keeping the payloads separate allows the timeline to render independently and immediately while the feed loads its first page.

### 3.4 Refresh mechanism

No additional endpoint. Refresh re-calls `GET /api/ct/activity` with the current filters plus `?since={fetchedThroughCommit}`. The server merges new events into the warm store atomically and returns the updated head. The client prepends new events to its in-memory list without re-fetching existing pages. On refresh failure the merge is rolled back — no partial batch is committed; existing data is retained unchanged and the `error-refresh` banner is shown (§8).

---

## 4. Layout & Interaction Model

### 4.1 Top-level layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Activity Stream                     [Refresh ↺]  [Auto-refresh ○ / ●]   │
│  42 FLT flags · master · fetched 3m ago · 127 events in 30d              │
├──────────────────────────────────────────────────────────────────────────┤
│  FILTER BAR (sticky)                                                       │
│  [Date: 30d ▾]  [Flag: All ▾]  [Env: All ▾]  [Transition: All ▾]        │
│  (active filter chips)                                           [Clear]  │
├──────────────────────────────────────────────────────────────────────────┤
│  TIMELINE STRIP (sticky, fixed height ≤72px, horizontal scroll)           │
│  ●─────◉──────────●────●──◉──────●───────────────────────────●           │
│  Feb 04        Feb 12   Feb 24  Mar 03 Mar 10/13          May 05          │
├──────────────────────────────────────────────────────────────────────────┤
│  FEED (scrolls vertically)                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ [off → on]  bleu  FLTArtifactBasedThrottling       [PR 123456 ↗] │   │
│  │ Last enabled by Jayaprakash Kupparaju · 05 May 2026               │   │
│  │ ▸ Details                                                          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│  ...                                                                       │
│  [Load 50 more ▾]                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The filter bar and timeline strip are **sticky** (remain visible on feed scroll). The feed scrolls independently. The timeline scrolls horizontally within its strip when the date range is wide; the feed scrolls vertically.

### 4.2 Filter bar

Three LOCKED filters (spec mandate from P0/CEO sign-off) plus one optional transition filter:

| Filter | Control | Default | Behavior |
|---|---|---|---|
| **Date range** (LOCKED) | Dropdown with presets + custom date picker | 30d | Presets: Today, 7d, 30d, 90d, Custom. Custom opens a date-range picker; applied on close. Drives both feed and timeline. |
| **By flag** (LOCKED) | Multi-select popover, searchable | All (none selected) | 42 FLT flag Ids. Active selections appear as dismissible chips in the filter bar. Max 10 simultaneous flag selections (performance constraint — see §9). |
| **By env** (LOCKED, adopted idea #4) | Multi-select chips, 15 items | All (none selected) | Env keys rendered as small chips, grouped by ladder (6) / sovereign (7) / other (onebox, bleu). Click toggles. Affects both feed and timeline (dims unselected dots rather than removing them). |
| **By transition** (optional) | Dropdown | All | Options: All · Enablements (transitions ending in `on`) · Disablements (transitions ending in `off`) · Content changes. |

**Filter state is URL-encoded (adopted idea #5):** filter params are serialized into `URLSearchParams` using keys `from`, `to`, `flags` (repeatable), `envs` (repeatable), `transitions` (repeatable), `page`. Any deep-link into C04 (from the Grid, Dossier, or Rollout Ladder) pre-populates these params. The component applies URL params before the first API call — there is no intermediate "all filters" flash.

When any non-default filter is active, a **Clear all** link appears at the right of the filter bar.

### 4.3 Timeline visualization (adopted idea #4 — Unleash-style)

The timeline is a horizontal strip of fixed height (P4 decides exact pixels; spec mandates ≤72px) positioned between the filter bar and the feed. It spans the full selected date range.

#### Dot model

Each event in `TimelineSummaryResponse.points` produces one dot at the event's x-position on the time axis. Dots are color-coded by environment group:

- **Ladder envs** (test, cst, daily, dxt, msit, prod): one color family. Suggested: `--timeline-ladder` → `var(--accent)` (P4 decides exact hue).
- **Sovereign envs** (mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary): a distinct second color family. Suggested: `--timeline-sovereign` (new token — see §10).
- **Other envs** (onebox, bleu): neutral/muted treatment (see Q5 in §11).

> **Design constraint:** ladder vs sovereign vs other must be visually distinguishable at a glance without relying on red/green alone (colorblind-safe). Exact palette is P4's domain.

#### Grouping

When two or more dots fall within a **temporal proximity threshold**, they collapse into a single **cluster dot** showing the count (e.g., `3`).

The threshold auto-scales proportionally to the selected date range and the available timeline pixel width. As a reference: a 7-day view clusters same-hour events; a 30-day view clusters same-day events; a 90-day view clusters events within ±2 days. The exact threshold is: `(dateTo − dateFrom in ms) ÷ availableTimelineWidthPx × kClusterRadiusPx`, where `kClusterRadiusPx` is a layout constant (suggest 3px; P4 adjusts). The threshold recalculates on every window resize (debounced at 100ms).

**Cluster dot interactions:**
- Clicking a cluster dot: filters the feed to the events within that cluster's temporal window. A cluster chip appears in the filter bar (dismissible) showing `Cluster: N events near [date]`. The date range picker is not changed.
- Hovering a cluster dot: tooltip shows `N events · [date range] · Envs: [list]`.
- Clicking a non-clustered dot: scrolls the feed to the corresponding entry and applies a transient highlight (fades after 2s).

#### Env filter interaction (adopted idea #4 visual)

When env chips are active in the filter bar, timeline dots for un-selected envs are **dimmed** (reduced opacity, not hidden). Selected-env dots retain full opacity. This allows the user to see "only prod changes in context of all activity" without losing the broader picture.

#### Auto-refresh integration

When auto-refresh fires and new events arrive:
1. New dots are added to the timeline at their timestamps with a brief fade-in.
2. A non-blocking banner above the feed: `N new event(s) — show` (clicking prepends them to the feed and scrolls to top).
3. The feed is NOT auto-scrolled if the user has scrolled down.

### 4.4 Feed entries

Each entry is a card-row:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [TRANSITION BADGE]  [ENV CHIP]  [FLAG NAME (monospace)]      [PR LINK]  │
│  [ATTRIBUTION LABEL]: [author name]  ·  [relative time]                  │
│  ▸ Details                                                                │
└──────────────────────────────────────────────────────────────────────────┘
```

| Field | Content | Interaction |
|---|---|---|
| **Transition badge** | Text label: `off → on`, `targeted → on`, `conditional → on`, etc. Arrow is Unicode U+2192 (→). | Visual only. Styled by transition family (enablement / disablement / content-change). P4 decides colors; must not rely on red/green alone. |
| **Env chip** | Display label from `seed.envLabels` (e.g., "MSIT", "Bleu"). | Click → toggles that env in the filter bar (pre-populates the env chip). |
| **Flag name** | `flagId` in monospace (e.g., `FLTArtifactBasedThrottling`). | Click → navigates to C02 Flag Dossier for this flag. |
| **PR link** | `Merged PR NNNN ↗` if `prNumber` is non-null. | Opens ADO PR in new tab (`target="_blank" rel="noopener"`). Omitted (not shown) when `prNumber` is null. |
| **Attribution label** | `Last enabled by` or `Last modified by` or `Created by`. Never "Owner". | Visual only. |
| **Author** | `author` string verbatim from commit. If empty, renders `(unknown author)`. | Visual only. |
| **Timestamp** | Relative (`3 months ago`). | Hover → tooltip with absolute ISO 8601 date + time in UTC. |
| **▸ Details** | Collapsed toggle. `▸ Details` when closed; `▾ Details` when open. | Click → expands the JSON-diff panel (§4.5). |

Entries are sorted newest-first within the filter window. The sort is stable across "Load more" pages.

### 4.5 JSON-diff Details panel (adopted idea #3 — LaunchDarkly-style)

When the user expands `▾ Details` on a feed entry, a panel slides open inline below that entry. This is the canonical implementation of adopted idea #3: showing the exact `Environments` diff for a change.

The panel contains:

**1. Panel header**
```
Environments diff · FLTArtifactBasedThrottling · msit · 3 March 2026
Commit abc123f · [View on ADO ↗]  [Copy link]
```

**2. Side-by-side diff panes**

| Left pane: `Before (abc123f)` | Right pane: `After (def456a)` |
|---|---|
| The `Environments[env]` JSON block from the old commit. `(key absent)` when the env key was missing (off state). Rendered as pretty-printed JSON with syntax coloring (read-only `<pre>`). | The `Environments[env]` JSON block from the new commit. |

Minimum requirement: both panes visible simultaneously, scrollable independently within the panel. P4 may add line-level diff highlighting; this spec does not mandate it.

**3. Context pane** (`All envs in this commit` — collapsed by default)

When expanded, shows the full `afterEnvironments` object (all 15 env keys) from the newer commit. Changed env keys (from `allChangedEnvs`) are visually distinguished (bold, accent left-border, or similar — P4 decides). This answers "what was the full flag state at the moment of this change?"

**4. Per-pane controls**

A `Copy` icon in each pane copies the JSON block to clipboard. The context pane has a single `Copy all` action.

**Load behavior:** the panel calls `GET /api/ct/activity/diff/{eventId}` on first expand. A spinner appears in place of the panes. Subsequent opens of the same entry use the cached response (the eventId is immutable). Error handling: see §8.

> **Groundbreaking deviation from design bible baseline:** Inline JSON rendering (pre-formatted, syntax-colored) is not part of the existing design system token set. P4 must introduce `--font-mono` and `--code-bg` as new tokens and document them in `docs/DESIGN_SYSTEM.md`. See §10.

---

## 5. State Matrix

### 5.1 Top-level component states

| State | Entry condition | Display | Transition |
|---|---|---|---|
| `loading` | Initial mount; no data in memory. | Feed area: skeleton rows (3–5, shimmer). Timeline: empty grey bar. Filter bar: rendered but disabled. | → `populated` or `error` |
| `refreshing` | Manual Refresh or auto-refresh in progress; existing data already rendered. | Thin progress bar along component top. Existing feed + timeline remain fully interactive. No overlay. | → `populated` (new events merged) or `error-refresh` |
| `populated` | At least one event matches current filters. | Normal feed and timeline. | → `refreshing` on refresh; → `empty` if filter change yields zero results; → `error` on hard error |
| `empty` | Query returned zero events for the active filter combination. | Empty state message below filter bar + timeline strip. "No FLT flag activity in this date range for the selected filters." Timeline renders its axis but no dots. Active filter summary + secondary `Widen date range` / `Clear all filters` affordances. | → `populated` if filters are broadened |
| `error` | Hard fetch failure on initial load. | Error banner replaces feed: "Unable to load activity — [reason]. Retry ↺" Filter bar and timeline not rendered. | → `loading` on retry |
| `error-refresh` | Refresh failed; prior data available. | Non-blocking amber banner above existing feed: "Refresh failed — showing activity from [generatedAt]. Retry ↺" Feed and timeline remain interactive. | → `refreshing` on retry |

### 5.2 Entry-level states

| State | Condition | Display |
|---|---|---|
| `detail-closed` | Default for every entry. | `▸ Details` collapsed. |
| `detail-loading` | `▾ Details` clicked; awaiting diff endpoint. | Spinner inside the panel area below the entry. |
| `detail-open` | `EnvDiffDetail` received and rendered. | Inline diff panel expanded, all three sections available. |
| `detail-error` | Diff endpoint returned error. | Error message inside panel: "Details unavailable — [reason]. Retry ↺" |

### 5.3 Filter-induced states

| Filter state | Effect |
|---|---|
| Default (no filters) | 30-day window, all 42 flags, all 15 envs, all transitions. |
| Flag filter active | Feed: only events for selected flags. Timeline: dots for other flags dimmed (not removed). |
| Env filter active (adopted idea #4) | Feed: only events for selected envs. Timeline: dots for unselected envs dimmed to ~20% opacity. |
| Date range narrowed | Feed + timeline clipped to window. Empty state if no events exist in window. |
| Cluster selected | Feed filtered to cluster's temporal window. Cluster chip in filter bar. Date range picker unchanged. |
| URL pre-filter | Params applied before first API call; no "all filters" intermediate flash. |
| All filters combined | AND logic across filter dimensions. |

---

## 6. Scenarios

### C04-S01 — Default view, 30-day window

**Setup:** User navigates to the Activity Stream tab. No filters set, no URL params.

**Observation:**
- Loading skeleton renders; feed populates within the cold-load budget (see §9).
- The most recent 50 events across all FLT flags and all environments appear newest-first.
- Timeline dots color-code by env group; clusters form for same-day events.
- Header strip: `42 FLT flags · master · fetched Xs ago · N events in 30d`.

**Note:** If no FLT flag changed in 30 days (stable flags), the empty state renders. This is a neutral observation; C04 does not label the situation as a problem.

---

### C04-S02 — FLTArtifactBasedThrottling rollout reconstruction (worked example, gold sample)

**Setup:** User applies flag filter → `FLTArtifactBasedThrottling`. Date range → Custom: 2026-02-01 to 2026-06-01 (captures the full documented rollout).

**Expected feed, newest-first:**

| # | Transition | Env | Attribution label | Author | Date | PR |
|---|---|---|---|---|---|---|
| 1 | off → on | bleu | Last enabled by | Jayaprakash Kupparaju (LTIMindtree Limited) | 2026-05-05 | if available |
| 2 | targeted → on | prod | Last enabled by | (from commit) | 2026-03-13 | if available |
| 3 | off → targeted | prod | Last modified by | (from commit) | 2026-03-10 | if available |
| 4 | off → on | msit | Last enabled by | (from commit) | 2026-03-03 | if available |
| 5 | off → on | dxt | Last enabled by | (from commit) | 2026-02-24 | if available |
| 6 | conditional → on | cst | Last enabled by | (from commit) | 2026-02-12 | if available |
| 7 | off → on | daily | Last enabled by | (from commit) | 2026-02-12 | if available |
| 8 | off → on | test | Last enabled by | Ayush Singhal | 2026-02-04 | if available |

Attribution rule applied:
- Entry 3 (`off → targeted`): does not end in `on` → `Last modified by`.
- All others end in `on` → `Last enabled by`.

**Timeline observation:** entries 6 and 7 share date 2026-02-12 and cluster into a `2` badge on the timeline. Clicking the cluster pre-filters the feed to those two events and shows a cluster chip.

---

### C04-S03 — Env filter: prod-only rollout tracking (adopted idea #4)

**Setup:** User activates env filter chip → `prod`. Date range → 90d.

**Observation:**
- Feed shows only events where `env === 'prod'`.
- For `FLTArtifactBasedThrottling` this yields 2 entries: `off → targeted` (2026-03-10) and `targeted → on` (2026-03-13).
- Timeline dims all non-prod dots to ~20% opacity; prod dots remain at full opacity. The full historical context is preserved visually.
- The env chip `prod` appears in the filter bar as an active chip.

---

### C04-S04 — Details panel: viewing the prod targeted→on diff (adopted idea #3)

**Setup:** User finds the `FLTArtifactBasedThrottling · prod · targeted → on · 2026-03-13` entry and clicks `▸ Details`.

**Observation:**
- Panel slides open; spinner shows briefly while the diff endpoint loads.
- Left pane (Before, commit from 2026-03-10): `{ "Targets": { ... } }` — the targeted block.
- Right pane (After, commit from 2026-03-13): `{ "Enabled": true }` — full enablement.
- Context pane (collapsed): `All envs in this commit` — expanding shows all 15 env keys at the 2026-03-13 commit state; `prod` is highlighted as the changed key.
- PR link (if `prNumber` non-null) is repeated in the panel header.

---

### C04-S05 — Deep-link from Control Grid cell

**Setup:** User clicks a cell in C01 Control Grid for `FLTDagSettings · msit`. The Grid constructs a deep-link: `/?view=activity&flags=FLTDagSettings&envs=msit`.

**Observation:**
- C04 mounts with flag filter pre-set to `FLTDagSettings` and env filter pre-set to `msit`.
- Both chips appear in the filter bar immediately. No "all flags" intermediate state.
- Feed shows only `FLTDagSettings` state changes in `msit`.

---

### C04-S06 — Cluster dot interaction

**Setup:** Default 30-day view. A release cycle produced 5 events across cst, daily, and dxt within 2 days.

**Observation:**
- Those 5 events collapse into a `5` cluster dot on the timeline.
- Hover tooltip: `5 events · Feb 12 – Feb 14 · Envs: cst, daily, dxt`.
- Click: feed narrows to those 5 events; cluster chip appears in filter bar: `Cluster: 5 events near 12 Feb`.
- Dismissing the cluster chip restores the full filtered feed.

---

### C04-S07 — Auto-refresh: new events arrive

**Setup:** User has auto-refresh enabled (opt-in toggle, default OFF). The 60-second freshness poll detects that three new FLT flag changes have been merged to `master` since the last refresh.

**Observation:**
- At the interval, a thin progress bar runs along the component top (`refreshing` state).
- Three new timeline dots fade in at their positions.
- Banner: `3 new events — show`. Feed is not auto-scrolled.
- Clicking `show` scrolls to the feed top; new entries are transiently highlighted (fades after 3s).

---

### C04-S08 — Empty state: no activity in range

**Setup:** User narrows the date range to a single day when no FLT flag changed.

**Observation:**
- Feed shows: "No FLT flag activity on 12 Jun 2026."
- Timeline renders date axis but no dots.
- Secondary affordances: `Widen to 7d` preset shortcut + `Clear all filters` link.

---

### C04-S09 — Data gap warning

**Setup:** P2's background indexer failed to fetch the older commitId content for `FLTTableMaintenanceHook` during a transient ADO REST error.

**Observation:**
- Non-blocking warning banner above feed: `Activity for 1 flag may be incomplete — FLTTableMaintenanceHook · [details ▸]`.
- The rest of the feed renders normally with all available events.
- Expanding `[details ▸]` shows: affected flag, commitId pair, error reason, and `Retry with Refresh` suggestion.
- The `gaps` array in `ActivityStreamResponse` drives this banner.

---

## 7. Keyboard & Accessibility

The Activity Stream uses a feed pattern, not a table pattern. Standard DOM focus order (Tab) moves through the interactive elements within each entry: env chip, flag name, PR link, Details toggle. Arrow navigation is not required for feed rows.

| Shortcut | Action |
|---|---|
| `/` | Focus the Flag filter search input. |
| `Escape` | Collapse the open Details panel (if any); if none open, dismiss active cluster chip. |
| `Enter` / `Space` on `▸ Details` | Toggle Details panel open/close. |
| `Enter` on flag name | Navigate to Flag Dossier (C02). |
| `Enter` on PR link | Open PR in new tab. |
| `Enter` on env chip (filter bar) | Toggle that env filter. |
| `Enter` / `Space` on timeline dot | Trigger the same interaction as click (scroll-to-entry or cluster filter). |

**Entry details panel:** `aria-expanded` on the `▸ Details` toggle. The panel container: `role="region"` with `aria-label="Diff details: [flagId] [env] [date]"`. JSON panes: `<pre role="code" aria-label="Before state">` and `<pre role="code" aria-label="After state">`.

**Timeline dots:** each is keyboard-reachable (Tab sequence within the strip). Non-clustered dot: `role="button" aria-label="[flagId], [env], [transition], [date]"`. Cluster dot: `role="button" aria-label="[N] events near [date] — activate to filter"`.

**State transition badges:** text is always present (`off → on`). The arrow `→` (U+2192) carries `aria-label="to"` so screen readers announce "off to on". Badges do not rely on color alone to convey meaning.

**Live regions:** the "N new events — show" banner is `aria-live="polite"`. The data-gap warning banner is `aria-live="polite"`. Feed content updates (Load more) are not live-announced (scroll-triggered pagination is user-initiated).

---

## 8. Error Handling

| Error | UI response | Recovery |
|---|---|---|
| Initial load fails (auth, network, server error) | `error` state: error banner replaces feed. "Unable to load activity — [reason]. Retry ↺" Auth errors include "Session may have expired — re-login." | Retry button re-triggers load from `loading` state. |
| Refresh fails (auto or manual) | `error-refresh` state: atomic rollback — no partial merge. Amber non-blocking banner: `"Refresh incomplete — showing last-good data from {generatedAt}. ↻ Retry"`. Feed and timeline remain interactive with last-good data. | Retry link in banner. Auto-retry is suspended until user manually retries or toggles auto-refresh off/on. |
| Detail diff endpoint fails | `detail-error` state inside panel: "Details unavailable — [reason]. Retry ↺" | Retry link re-triggers `GET /api/ct/activity/diff/{eventId}`. |
| Partial data gap (P2 indexer error) | Non-blocking warning banner listing affected flags (from `gaps` array). Feed renders all available events. | Refresh may resolve transient gaps; banner persists until the gap is resolved or user dismisses. |
| PR URL construction fails (non-standard commit message) | PR link omitted from the entry. No error state. | None needed — observational tool. |
| `author` empty in commit | Display `(unknown author)` in attribution field. Never fabricate a name. | None needed. |
| `prNumber` present but PR URL unreachable | Link renders normally; 404 is a browser-side concern on click. | None at the component level. |
| Date range `dateTo` before `dateFrom` | Date picker prevents this client-side (enforces `min`/`max` constraints). | Picker validation only. |

---

## 9. Performance

### Feed
- Default page size: 50 events. "Load more" pattern (single button at feed bottom) — no pagination controls.
- No row virtualization at 50 rows. Switch to virtual list if DOM entry count exceeds 500 (approximately 10 loaded pages).
- Details panels expanded far off-screen (>3 viewport heights) are collapsed and their DOM nodes released. The `EnvDiffDetail` payload is retained in the JS event cache (keyed by `eventId`) so re-expansion is instantaneous.
- Maximum simultaneous flag selections: 10. Above this, the filter popover shows a count chip and disables additional selections with an inline note.

### Timeline
- All dots rendered as SVG elements (not individual DOM nodes). Target: ≤2ms paint time for 500 points.
- Clustering is computed client-side from `TimelineSummaryResponse` (compact, no block payloads). Recalculated on resize; debounced at 100ms.
- The timeline endpoint is separate from the feed endpoint so timeline paints before the full first page loads.

### Refresh
- Auto-refresh is opt-in; default off.
- `?since={commitId}` param limits server-side diff computation to new commits only.
- The client merges new events into its in-memory list without re-rendering existing entries.

### Cold load budget
- Target: ≥1 event visible within **3 seconds** on a standard corp network.
- P2 must warm its in-memory event store at server startup (not on first request). If the store is cold at request time, P2 returns `202 Accepted` with `Retry-After: N` (seconds). C04 handles `202` by staying in `loading` state and retrying after `Retry-After`.

---

## 10. Implementation Notes

### Frontend module split

| Module | Responsibility |
|---|---|
| `activity-feed.js` | Feed rendering, "Load more" pagination, entry cards, scroll restoration, "new events" banner flush, cluster chip management. |
| `activity-filters.js` | Filter bar state machine, date picker, flag multi-select popover, env chip row, transition dropdown, URL encode/decode (adopted idea #5). |
| `activity-timeline.js` | Timeline SVG rendering, dot placement, cluster algorithm, resize debounce, dot click/hover, env dim/highlight, auto-refresh dot injection. |
| `activity-detail.js` | Details panel lifecycle (open/close/loading/error), lazy-load `GET /api/ct/activity/diff/{eventId}`, diff payload cache by `eventId`, JSON pane rendering, context pane. |

### URL state keys

All filter state is serialized into `URLSearchParams`:

| Key | Maps to |
|---|---|
| `from` | `dateFrom` (YYYY-MM-DD) |
| `to` | `dateTo` (YYYY-MM-DD) |
| `flags` | `flagIds[]` (repeatable) |
| `envs` | `envs[]` (repeatable) |
| `transitions` | `transitions[]` (repeatable) |
| `page` | current page (reset to 1 on any filter change) |

Any deep-link from another component (C01 Grid, C02 Dossier, C03 Ladder) uses these same param names. The URL is the single source of truth for filter state on mount.

### New design tokens required (groundbreaking deviations from design bible)

The design bible (part 1) defines `--bg` through `--bg-4`, `--text` through `--text-3`, `--accent`, shadow levels, and `--border-bright`. C04 requires the following **new tokens** that P4 must introduce and document in `docs/DESIGN_SYSTEM.md`:

| Token | Semantic purpose | Suggested light | Suggested dark |
|---|---|---|---|
| `--font-mono` | JSON panes, commit SHAs, flag Ids in feed | `'Cascadia Code', 'Consolas', monospace` | same |
| `--code-bg` | Background surface for JSON panes | `var(--bg-3)` | `var(--bg-3)` |
| `--state-on` | `on` state indicator (badge, dot) | TBD by P4 | TBD by P4 |
| `--state-off` | `off` state indicator | TBD by P4 | TBD by P4 |
| `--state-cond` | `conditional` state indicator | TBD by P4 | TBD by P4 |
| `--state-targeted` | `targeted` state indicator | TBD by P4 | TBD by P4 |
| `--timeline-ladder` | Timeline dot color, ladder envs | `var(--accent)` | `var(--accent)` |
| `--timeline-sovereign` | Timeline dot color, sovereign envs | TBD by P4 | TBD by P4 |
| `--timeline-other` | Timeline dot color, onebox + bleu | `var(--text-3)` | `var(--text-3)` |

Exact values are P4's domain. This spec names the tokens and their semantic purpose only. P4 must add these to `docs/DESIGN_SYSTEM.md` before implementing C04 visuals.

### Observational language discipline

C04 is a read-only, observational tool. All UI copy must describe facts, not prescribe actions:

- **Correct:** `Enabled 14/15 envs, last changed 2026-03-13`
- **Incorrect:** `This flag is fully rolled out — consider archiving`
- **Correct:** `No activity in this date range`
- **Incorrect:** `No changes detected — flags may be stale`

Any stale-reason labeling (adopted idea #1 from Statsig taxonomy) belongs to C05/⑦ Inert Flag Detection, not to C04. C04 never surfaces staleness nudges.

---

## 11. Open Questions for P2

These are design decisions C04 cannot finalize without P2's architecture work. They are intentionally open — do not resolve them in P1.

| # | Question | Impact on C04 | Priority |
|---|---|---|---|
| Q1 | **Event store warm-up:** Is the in-memory event store built at Next.js cold start, or built lazily on first request? The 3-second cold-load budget assumes a warm store (§9). If lazy, C04 needs a `202 + Retry-After` handling path. | Cold load UX | High |
| Q2 | **Commit message normalization for PR extraction:** The `Merged PR NNNN` pattern is proven for recent ADO merges (P0 §P0.2). Are there historical commits (pre-policy) that use a different format? P2 must document the extraction regex and its false-negative rate on the gold dataset (`FLTArtifactBasedThrottling` change sequence). | PR link completeness | Medium |
| Q3 | **Direct push commits:** Some env changes may arrive via direct push to `master` (no PR merge, no `Merged PR NNNN` message). `prNumber` will be null. Is a `(direct push)` annotation in the attribution row useful to users, or should it simply be omitted? | Entry anatomy | Low |
| Q4 | **`content-change` detection threshold:** When the env shape stays the same (e.g., `Requires → Requires`) but block content differs, P2 emits a `content-change` event. How does P2 distinguish a semantic content change from a cosmetic whitespace reformat? P0 R3 says the semantic-diff approach is reformat-proof — confirm this extends to `content-change` detection and document the normalization step. | Feed noise | Medium |
| Q5 | **`bleu` env classification — RESOLVED.** `bleu` is a non-sovereign regional environment (see data-model.md §2). It is classified as "Other" alongside `onebox`. In the env filter, group it under "Other (onebox, bleu)". Use `--timeline-other` for timeline dot coloring. | Resolved — no further P2 action needed. | Low |
| Q6 | **Incremental refresh and flag deletions:** When `?since={commitId}` is passed and P2 re-polls path-commits, if a flag's JSON file has been removed from `master` since the last full refresh, should P2 emit a `flag-deleted` event? Should C04 render it as a terminal entry in that flag's history? | Edge case completeness | Low |
| Q7 | **Timeline endpoint latency guarantee:** `GET /api/ct/activity/timeline` (§3.3) must paint before the full feed page to be valuable. Can P2 serve this at ≤200ms from the warm store? If not, C04 should derive timeline points client-side from the already-paginated feed response (losing the "full window" picture but saving a round-trip). P2 must advise. | Load performance | Medium |
| Q8 | **Author display format:** The `authorPool` in seed data includes entries with parenthetical org suffixes (e.g., `"Jayaprakash Kupparaju (LTIMindtree Limited)"`). Should C04 display the raw commit author string verbatim, or should P2 normalize it (trim parenthetical)? The raw string is factual; trimming may reduce disambiguation. | Attribution display | Low |

---

*End of C04 Component Deep Spec — Activity Stream.*
*Sana · 2026-06-13 · P1 DRAFT*
