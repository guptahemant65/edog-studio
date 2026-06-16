# C05 — Time Travel: Component Deep Spec

> **Component:** Time Travel (date scrubber + as-of-date matrix reconstruction)
> **Feature:** F30 — Control Tower
> **Owner:** Sana (architecture + data contract), Pixel (JS/CSS implementation), Vex (P2 engine — see §6)
> **Complexity:** HIGH — feature differentiator; novel cross-env as-of-date posture matrix; P1 gate
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Problem & Role](#1-problem--role)
2. [Data Contract](#2-data-contract)
3. [Layout & Interaction Model](#3-layout--interaction-model)
4. [State Matrix](#4-state-matrix)
5. [Error Handling](#5-error-handling)
6. [Performance & Caching Requirements (handed to P2)](#6-performance--caching-requirements-handed-to-p2)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Implementation Notes](#8-implementation-notes)
9. [Open Questions for P2](#9-open-questions-for-p2)

---

## 1. Problem & Role

### 1.1 The question nobody can answer today

"What did the FLT rollout matrix look like on 2026-03-10?" There is no way to answer this without manual
`git log` archaeology across 42 files. PMs can now answer "where is flag X across all 15 envs right now"
with the C01 Grid (Layer 1 — Posture). But they also ask "when did it get there?" and "what did the matrix
look like before last week's prod push?" — those are Layer 2 (Motion) questions. C04 Activity Stream
answers "what moved and when." C05 Time Travel answers "reconstruct the entire posture as it was on any
past day."

Today's manual path for a PM:

| Question | Today |
|---|---|
| What was `FLTArtifactBasedThrottling`'s state in `prod` on 2026-03-10? | `git log --follow -- Features/.../FLTArtifactBasedThrottling.json` by hand |
| Which flags flipped the week of 2026-03-03? | No aggregate view exists |
| Did `prod` ever briefly have fewer flags than `msit` last month? | Impossible to answer without reconstructing each day manually |

### 1.2 What C05 is

C05 is a **date scrubber** — a timeline slider mounted above the C01 Grid — that, when activated, replaces
the Grid's live data with the full 42×15 matrix reconstructed **as it was on any selected date D**. Each
cell's state is determined by fetching the flag's FM JSON content at the most-recent commit whose
`authorDate ≤ D`, diffing it against the current master-HEAD state, and rendering the historical state with
an amber diff highlight on any cell that differs from today. When D ≠ today the Grid carries a persistent
**"AS OF YYYY-MM-DD"** header badge.

The underlying reconstruction mechanism is the one proven live in P0.2 §5: for each flag file, fetch
content at a specific `commitId` (immutable) via
`GET .../items?path=<flagPath>&versionDescriptor.version=<commitId>&versionDescriptor.versionType=commit`.
Content cached by `commitId` is correct forever. C05 is the UI surface that makes this mechanism
PM-accessible.

### 1.3 Why it is the differentiator

P0.3 surveyed LaunchDarkly, Statsig, Unleash, Vercel, Flagsmith, and Split. The research conclusion was
explicit: **"our ⑤ Time Travel is genuinely novel."** Flagsmith Feature Versioning v2 is the closest prior
art — it allows browsing past versions per-flag-per-env. C05 goes further: it reconstructs the **entire
42×15 matrix simultaneously**, so a PM can see the complete rollout landscape on any given day, compare it
to today in a single glance, and count regressions or unexpected roll-backs. No shipping product does this
at the cross-env matrix level.

**This surface must feel instant.** Warm-cache reconstruction latency ≥ 500 ms is a product failure, not
an engineering shortfall.

### 1.4 Role in the layer model and hard constraints

- **READ-ONLY. Always.** C05 has no write path, no toggle, no copy-to-force-enable. It inspects the FM
  repo's git history; it never modifies it.
- **FLT-scoped.** Only the ~42 `FLT*.json` flags. The other 13,160 flags in the repo are never touched.
- **No fabricated ownership.** Attribution uses **"Last enabled by"** (derived from the commit/PR author
  that established the state). Never "Owner" — no such field exists in FM.
- **Source of truth is the FM repo via ADO REST** (`versionDescriptor.versionType=commit`). No local clone;
  no browser-side ADO calls. All reconstruction happens server-side.
- **P2 owns the engine.** This spec declares the data contract. P2 `architecture.md` owns the ADO REST
  client, commitId cache, Environments-block diffing, and pre-warming strategy.

---

## 2. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

C05 declares what it needs. P2 builds the engine. This section is the only crossing point between them.

### 2.1 Shared type aliases

```typescript
type EnvKey =
  | 'onebox' | 'test' | 'cst' | 'daily' | 'dxt' | 'msit' | 'prod'
  | 'mc' | 'gcc' | 'gcchigh' | 'dod' | 'usnat' | 'ussec' | 'bleu' | 'usgovcanary';

/**
 * The four FM state shapes (from P0.2 §3) plus a C05-specific fifth.
 * 'not-yet-created' means the flag file did not exist in FM on date D.
 * P2 must never conflate 'not-yet-created' with 'off'.
 */
type TimeTravelCellState = 'on' | 'off' | 'conditional' | 'targeted' | 'not-yet-created';
```

The four FM shapes map directly from P0.2: `{}` → `'off'`; `{"Enabled":true}` → `'on'`;
`{"Requires":[…]}` → `'conditional'`; `{"Targets":{…}}` → `'targeted'`. `not-yet-created` is C05-only and arises
when `flag.createdAt > asOfDate`.

### 2.2 Scrubber bounds and change-points

Fetched once on Time Travel activation. Drives the track range and change-point dot positions.

```typescript
/**
 * A calendar date on which at least one FLT flag changed state in at least one env.
 * Derived by P2 from the per-flag commit histories via semantic Environments-block diffs.
 */
interface ChangePoint {
  /** yyyy-MM-dd (UTC). One entry per calendar day, regardless of commit count. */
  date: string;
  /** Total commits to any FLT flag file on this date. */
  commitCount: number;
  /** Distinct flag files touched — drives dot visual weight. */
  flagCount: number;
  /** Distinct envs whose state changed across all flags on this date. */
  envCount: number;
  /** Up to 3 flag IDs for hover tooltip preview. */
  flagPreview: string[];
}

interface TimeTravelBounds {
  /** yyyy-MM-dd of the first-ever FLT commit — left bound of scrubber. */
  earliest: string;
  /**
   * yyyy-MM-dd of the most-recent FLT commit — right bound of scrubber.
   * NOT wall-clock today. Prevents phantom reconstruction of commit-free recent days.
   * UI labels this "Today" only if latest === todayLocalDate.
   */
  latest: string;
  /** All ChangePoints in [earliest, latest], sorted ascending by date. */
  changePoints: ChangePoint[];
  /** ISO datetime of when P2 computed this. Used by UI to detect stale bounds. */
  resolvedAt: string;
}
```

### 2.3 Reconstruction request and response

Issued on every thumb-release or confirmed date-picker entry.

```typescript
interface TimeTravelRequest {
  /**
   * yyyy-MM-dd (inclusive). P2 uses the latest commit whose authorDate falls
   * on or before end-of-day UTC for this date.
   */
  asOfDate: string;
}

interface TimeTravelCell {
  state: TimeTravelCellState;
  /**
   * True iff this cell's state differs from the current master-HEAD state for
   * this flag+env at the time of reconstructedAt.
   */
  changedFromCurrent: boolean;
  /**
   * Present when state !== 'not-yet-created'.
   * The raw ADO commit SHA used to reconstruct this cell. Immutable — safe as
   * a permanent cache key. See P0.2 §5.
   */
  commitId?: string;
  /** ISO datetime of the commit that established this cell's state. */
  commitDate?: string;
  /**
   * Author of the commit that established this state.
   * Labeled "Last enabled by" in UI when state is 'on'. "Last modified by"
   * for any-state changes. Never "Owner" — no such field exists in FM.
   */
  author?: string;
}

interface TimeTravelFlagRow {
  flagId: string;
  /**
   * False when createdAt > asOfDate. When false, all 15 cells are
   * state='not-yet-created' and no diff highlighting is shown for this row
   * (the flag being absent is not a "change" — it is absence).
   */
  existsAtDate: boolean;
  /** ISO datetime of the flag's first commit. Present when existsAtDate=false. */
  createdAt?: string;
  /** Count of cells in this row with changedFromCurrent=true. */
  changedCellCount: number;
  cells: Record<EnvKey, TimeTravelCell>;
}

interface TimeTravelResponse {
  /** Echoed from request. */
  asOfDate: string;
  /** ISO datetime of server-side computation. */
  reconstructedAt: string;
  /** True if P2 served from a memoized result without re-computation. */
  cacheHit: boolean;
  /** Sum of changedCellCount across all rows. Drives diff badge in scrubber. */
  totalChangedCells: number;
  /** Count of rows where existsAtDate=false. */
  totalNonExistentFlags: number;
  /**
   * Exactly 42 rows, same flag order as the live C01 Grid.
   * Ordering is stable across reconstructions to avoid visual row-jumping.
   */
  rows: TimeTravelFlagRow[];
}
```

### 2.4 API surface (declared here; P2 implements)

| Method + Path | Purpose | Notes |
|---|---|---|
| `GET /api/ct/time-travel/bounds` | Returns `TimeTravelBounds`. | P2 caches until next `/refresh` cycle. |
| `POST /api/ct/time-travel/reconstruct` | Body: `TimeTravelRequest`. Returns `TimeTravelResponse`. | P2 memoizes per `asOfDate` + current commit-list hash. A `/refresh` invalidates memos but not the commitId content cache. |

Both endpoints honour the auth model from P0.2: delegated per-user Entra token (auth-code → ADO scope).
All ADO calls happen **server-side**; the token never reaches the browser.

### 2.5 Reconstruction invariants (P2 must guarantee)

1. The `state` for each cell is derived exclusively from the FM JSON content at the `commitId` whose
   `authorDate ≤ asOfDate` (end-of-day UTC) and is the most recent such commit for that flag file.
2. If no commit satisfies invariant 1 for a flag, `existsAtDate=false` for that row; all 15 cells carry
   `state='not-yet-created'` and `commitId` is absent.
3. `changedFromCurrent` is computed against the live master-HEAD state **at the time the response is
   built** (`reconstructedAt`), not against the bounds-fetch state. If the user reconstructs an old date
   and then another user pushes a prod change, the diff is correctly recalculated on the next request.
4. `commitId` values are raw ADO commit SHAs. They are immutable and must be usable as permanent cache
   keys with no TTL within the session.
5. The `rows` array must contain exactly 42 entries regardless of which flags existed on `asOfDate`.

---

## 3. Layout & Interaction Model

### 3.1 Anatomy overview

Time Travel mode consists of two regions. The Grid is **not** replaced or navigated away from. C05 inserts
a Scrubber Panel above it and applies a mode-layer to Grid cells.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SCRUBBER PANEL  (inserted between Grid toolbar and Grid header)        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  ◷  AS OF  [2026-03-10]   ●──────●─────────●──────────●─────●  ✕ │  │
│  │     ↑ editable date        change-point dots          Today close │  │
│  │  [ ] Show diff only    16 cells differ from current state         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  C01 GRID  (time-travel mode: AS OF banner + amber diff highlights)      │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  ⚑ AS OF 2026-03-10                   ↑ sort/filter still active  │  │
│  │  Flag                │ onebox│test│cst│daily│dxt│msit│prod│…     │  │
│  │  FLTArtifactBased…   │  on   │ on │ on│  on │ on│ on │[●]│…     │  │
│  │  (diff cell [●] has amber left-border + faint amber background)  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

The Grid's existing interactions — search, filter chips, sovereign expand/collapse, Flag Dossier click,
Activity Stream panel — all remain active while Time Travel mode is engaged.

### 3.2 Scrubber panel elements

| Element | Specification |
|---|---|
| Clock icon (◷) | Non-interactive; signals "time context active." Replaced by a spinner during `tt:reconstructing`. |
| "AS OF" label | Static text. |
| Date chip | Displays the current scrubber date in `--mono` font. Clicking it opens `<input type="date">` constrained to `[bounds.earliest, bounds.latest]`. Accepts keyboard input. Turns `--red` when out-of-range. |
| Track | Horizontal element spanning `[earliest, latest]` as a linear time axis. Fills available panel width. Backed by a hidden `<input type="range">` for accessible value binding. |
| Change-point dots | SVG `<circle>` elements at proportional positions. Diameter: `max(4, min(12, flagCount × 1.5))` px. Colour: `--accent`. Dots within 3 px of each other on the rendered track are merged into a grouped dot showing the aggregate `commitCount`. |
| Thumb | Draggable. Snaps to nearest change-point when ≤ 4 px away; hold `Alt` to suppress snap and scrub freely. Reconstruction fires on pointer-up (not on every drag move — too expensive). |
| Diff badge | "N cells differ from current state" in `--text-3`. Reads "Live" when `asOfDate === latest`. |
| "Show diff only" | Checkbox-pill. When checked, the Grid hides rows where `changedCellCount === 0`. Applies client-side; no re-fetch. |
| Today button | Jumps scrubber to `latest`, triggers reconstruction (fast — near-zero diff expected), then exits Time Travel mode after a 600 ms "Live" confirmation pulse. |
| Close (✕) | Exits Time Travel mode immediately; Grid restores live C01 state. |

### 3.3 Grid mode-layer in time-travel

When Time Travel mode is active the Grid changes in exactly these ways. Everything else is unchanged from
C01.

1. **AS OF header banner**: A full-width banner reading "⚑ AS OF YYYY-MM-DD" is prepended to the sticky
   column-header row. Background: `--amber` at 10% opacity. Text: `--amber`. Persists while the user
   scrolls horizontally through sovereign columns.

2. **Diff-highlighted cells** (`changedFromCurrent: true`): 2 px left-border in `--amber`; cell background
   tinted with `--amber` at 5% opacity. Cell glyph and text content are unchanged from C01's glyph
   contract.

3. **Not-yet-created cells** (`state: 'not-yet-created'`): Render the middle-dot glyph `·` in `--text-3`
   on a `--bg-3` background. This glyph is unique to C05 — it is explicitly lighter than `–` (off) to
   signal "absent from history" rather than "explicitly disabled." See §8.5 for the design-bible deviation
   note.

4. **Not-yet-existing rows** (`existsAtDate: false`): The flag name renders in `--text-3` italic. A tooltip
   reads "Flag created on \<createdAt date\> — did not exist on \<asOfDate\>." Diff highlighting is
   suppressed for these rows (absence is not a regression).

5. **No write affordances**: No STATE toggles, no force-ON buttons, no override affordances anywhere — not
   even in ghost/disabled state. Time Travel is purely observational.

### 3.4 Change-point dot interaction

- **Hover tooltip**: "YYYY-MM-DD · N flags changed across N envs" + `flagPreview` as a bullet list (max 3
  items, then "+ N more").
- **Click**: Snaps the thumb to this date and triggers reconstruction immediately (without waiting for
  pointer-up since this is a discrete click, not a drag).
- **Grouped dot tooltip**: "N change dates near here" with the N dates listed; clicking a listed date
  navigates to it.

### 3.5 Deep links

The URL param `?asOf=YYYY-MM-DD` activates Time Travel mode on page load. The page fetches bounds,
validates the date against `[earliest, latest]`, then issues an immediate reconstruction. Exiting Time
Travel clears the param via `history.replaceState`. This supports the CEO-locked saved-views affordance
(P0.3 new idea #5, adopted).

---

## 4. State Matrix

| State ID | Entry condition | Grid content | Scrubber state | Exit transitions |
|---|---|---|---|---|
| `tt:idle` | Time Travel not activated. | C01 live state. | Hidden. | User clicks calendar icon → `tt:loading-bounds`. |
| `tt:loading-bounds` | Bounds/change-points fetch in flight. | Remains live and fully interactive. | Panel visible with pulsing skeleton track (no dots). | Fetch succeeds → `tt:ready`. Fetch fails → `tt:bounds-error`. |
| `tt:ready` | Bounds loaded; thumb at `latest` position. | Live state. Diff badge reads "Live". No highlights. | Fully interactive. Dots rendered. Thumb at right end. | Drag thumb, click dot, or enter date → `tt:reconstructing`. Click ✕ or Today → `tt:idle`. |
| `tt:reconstructing` | Reconstruction request in flight after date change. | All data rows replaced by full-width skeleton shimmer rows (same row height as data; layout preserved). | Thumb and date chip are frozen (`pointer-events: none`). Date chip greyed. Spinner icon. | Fetch succeeds → `tt:populated`. Fetch fails → `tt:error`. |
| `tt:populated` | Reconstruction complete; `asOfDate < latest`. | `TimeTravelResponse.rows` rendered. Diff highlights on changed cells. AS OF banner visible. | Fully interactive. Diff badge shows `totalChangedCells`. | Drag thumb → `tt:reconstructing`. Click Today → `tt:reconstructing` at `latest` then → `tt:idle`. Click ✕ → `tt:idle`. |
| `tt:populated:at-today` | Reconstruction complete; `asOfDate === latest`. | Effective live state (diff count = 0, no highlights). AS OF banner absent (not a historical view). | Thumb at far right. Diff badge reads "Live". | Drag left → `tt:reconstructing`. Click ✕ → `tt:idle`. |
| `tt:before-first-commit` | Thumb dragged / date entered with value < `bounds.earliest`. | All 42 rows show `not-yet-created` cells. Empty-state message centre of grid area: "No FLT flags existed before \<earliest\>. This is before the first FM commit." | Thumb clamped at left edge. Date chip shows entered date in `--red` with "Before history" suffix. | Drag right past `earliest` → `tt:reconstructing`. |
| `tt:error` | Reconstruction fetch returned error or timed out. | Retains the last successfully reconstructed state (or live state if no prior success). Amber error banner inside scrubber panel. | Thumb stays at failed date. Retry button replaces spinner. | Click Retry → `tt:reconstructing` (same date). Drag to different date → `tt:reconstructing`. Click ✕ → `tt:idle`. |
| `tt:bounds-error` | Bounds fetch returned error. | Unaffected — stays live. | Inline error in panel: "Could not load change history — Retry." | Click Retry → `tt:loading-bounds`. |

---

## 5. Error Handling

| Error | User-visible message | Grid behaviour | Recovery |
|---|---|---|---|
| Bounds fetch network failure | "Could not load change history — check connection." (inline in scrubber panel) | Unaffected — stays live. | Retry button. |
| Bounds fetch 401/403 | "Access denied. Your session may have expired — re-sign-in." | Unaffected. | Re-authenticate; Retry. |
| Reconstruction network failure | "Reconstruction failed — showing last known state." (amber banner in scrubber) | Retains last good state (or live if none). | Retry button; or drag to a different date. |
| Reconstruction partial (some flag files 404 at `asOfDate`) | Not shown — per-row `existsAtDate=false` handles it silently. | Affected rows show `not-yet-created` state. P2 must not fail the whole response. | None needed — data is informative. |
| Date out of range | Date chip turns `--red`; tooltip "Date out of range — history begins \<earliest\>." | `tt:before-first-commit` state if < earliest; thumb clamped if > latest. | User corrects date. |
| Reconstruction timeout (> 2 s) | "Still loading — reconstruction is taking longer than expected." (scrubber banner). | Skeleton persists. | Automatic; auto-cancel at 10 s and enter `tt:error`. |
| `/refresh` fires mid-reconstruction | P2 must either complete the in-flight request with pre-refresh data (safer) or abort and retry with fresh data. | If aborted, re-enters `tt:reconstructing`. | Automatic. |

---

## 6. Performance & Caching Requirements (handed to P2)

This section is a **requirements specification** for P2's reconstruction engine. C05 declares the UX
contract; P2 must achieve it. See P0.2 §5 for the proven ADO REST mechanism.

### 6.1 Latency budget

| Operation | Target | Hard limit |
|---|---|---|
| Bounds load (`/bounds`, cold) | ≤ 800 ms | 3 s (show `tt:bounds-error`) |
| First reconstruction (cold, no cache) | ≤ 1 500 ms | 5 s (show timeout message) |
| Subsequent reconstruction (warm cache) | ≤ 200 ms | 500 ms |
| Reconstruction at `latest` (live equivalent) | ≤ 100 ms | 300 ms |

The "must feel instant" product requirement maps to the **warm-cache target (≤ 200 ms)**. Cold-first
latency is tolerable with the skeleton state; warm latency must not be perceptible as a load. If warm
latency exceeds 500 ms the feature loses its differentiator status.

### 6.2 Immutable commitId cache (P0.2 invariant — reiterated)

Per P0.2 §5: every `commitId` is immutable. P2 **must** cache FM JSON content by `commitId` for the full
session lifetime with no TTL. The ADO call
`GET .../items?path=<flagPath>&versionDescriptor.version=<commitId>&versionDescriptor.versionType=commit`
fetched once is correct forever. This cache is the primary performance lever for Time Travel.

A `/refresh` action **must not** invalidate the commitId content cache. It must only:
1. Re-fetch the commit-list for each of the 42 flag paths.
2. Diff against the cached list to identify new commits.
3. Fetch content for new commitIds only.
4. Invalidate `TimeTravelResponse` memos (the reconstruction outputs, not the raw content).
5. Update `TimeTravelBounds` (new change-points, possibly a new `latest`).

### 6.3 Pre-warming strategy

P2 **must** adopt an aggressive pre-warming approach so that warm-cache targets are reachable:

1. On initial Control Tower load (first page render), P2 immediately begins **background** pre-fetching
   commitId content for all 42 flags × their most-recent N commits, where N is defined by P2-Q3 (§9).
   This is non-blocking — it must not delay the initial Grid render or the bounds fetch.
2. Estimated volume: 42 flags × 6 commits (gold-sample baseline) = ~252 commitId fetches. At ADO's
   response size (~2–5 KB per flag JSON), this is < 2 MB total and should complete within 10–15 s on a
   corporate network.
3. P2 may expose pre-warm progress via an optional `warmthPercent: number` (0–100) on `/bounds`. When
   present, the scrubber panel renders a thin progress indicator below the track (invisible after 100%).
4. After pre-warm completes, all reconstructions within the pre-warmed date range are **pure in-memory
   computation** over cached content — no ADO calls, no I/O.

### 6.4 Memo granularity and invalidation

`TimeTravelResponse` memos are keyed by `(asOfDate, commitListHash)` where `commitListHash` is a hash of
the current commit-list snapshot for all 42 flag paths. Keying on date alone is insufficient: a `/refresh`
that lands a new commit must invalidate memos for all dates ≥ that commit's `authorDate`, which the hash
key handles naturally (the hash changes after refresh).

### 6.5 Volume estimates (P2 planning input)

| Item | Estimate |
|---|---|
| Change-points over 2 years | 100–300 distinct calendar dates |
| commitId fetches to pre-warm (N=6) | ~252 |
| `TimeTravelResponse` memo size | 42 rows × 15 cells × ~200 B ≈ 126 KB uncompressed |
| `TimeTravelBounds` response size | ~300 ChangePoints × ~100 B ≈ 30 KB |

---

## 7. Keyboard & Accessibility

### 7.1 Focus order

When the scrubber panel first becomes visible, focus moves to the track thumb. On `tt:idle` exit (any
close path), focus returns to the calendar icon button in the Grid toolbar.

### 7.2 Scrubber keyboard controls

| Key | Behaviour |
|---|---|
| `←` / `→` | Move thumb to previous / next change-point (snap-step through dots). |
| `Alt+←` / `Alt+→` | Move thumb by exactly 1 calendar day, ignoring snap. |
| `Home` | Jump to `bounds.earliest`. |
| `End` | Jump to `bounds.latest`. |
| `Enter` (thumb focused) | Open the date-picker chip for direct keyboard entry. |
| `Escape` (date picker open) | Close picker without committing. |
| `Escape` (scrubber focused, picker closed) | Exit Time Travel mode (identical to clicking ✕). |

Reconstruction fires on the trailing edge of keyboard navigation: after `←`/`→` no key has been pressed
for 400 ms, or on `Enter` / `Tab` from the date picker.

### 7.3 ARIA contract for the track

The track element uses `role="slider"` with:
- `aria-valuemin`: `bounds.earliest`
- `aria-valuemax`: `bounds.latest`
- `aria-valuenow`: current `asOfDate` (yyyy-MM-dd)
- `aria-valuetext`: e.g. "March 10, 2026 — 16 cells differ from current state"

During `tt:reconstructing`: `aria-disabled="true"` and `aria-busy="true"` on the slider.

### 7.4 Grid accessibility in time-travel mode

- The AS OF header banner carries `role="status"` and `aria-live="polite"`. Screen readers announce the
  date when reconstruction completes.
- Diff-highlighted cells append to their existing `aria-label`: ", changed from current state."
- Not-yet-created cells: `aria-label="<flagName>, <envKey>: flag did not exist on this date."`
- "Show diff only" checkbox announces: "Show only changed rows — N rows currently hidden."
- The scrubber panel itself is wrapped in a `<section aria-label="Time Travel controls">`.

---

## 8. Implementation Notes

### 8.1 C05 hooks into C01 Grid via a mode prop

The C01 Grid accepts an optional `timeTravelState: TimeTravelResponse | null` prop. When `null` (the
default), the Grid uses its live data source. When non-null, the Grid:
- Reads rows from `timeTravelState.rows` instead of the live cache.
- Reads each cell's state from `TimeTravelCell.state` and applies the `changedFromCurrent` overlay.
- Renders the AS OF banner in the sticky header.
- Suppresses the STATE-toggle column entirely (read-only in all modes, but the column header changes to
  "State at \<date\>" to avoid implying interactivity).
- Sorting and filtering operate **client-side on `timeTravelState.rows`** — no re-fetch needed when the
  user changes sort order or filter chips after a reconstruction.

### 8.2 Frontend module split

- `time-travel-scrubber.js` — scrubber panel DOM construction, track SVG dot rendering and proportional
  positioning, thumb drag/click handling, snap-to-change-point logic, date-chip picker binding,
  keyboard handler, deep-link `?asOf=` read and write via `history.replaceState`.
- `time-travel-api.js` — `/bounds` and `/reconstruct` fetch wrappers, in-memory response memo keyed by
  `asOfDate` string (browser-side memoisation as a fast path before the server-side memo), fetch
  cancellation via `AbortController` when user drags again before a request completes.

### 8.3 Track rendering detail

The track is a `<div>` with an absolutely-positioned SVG overlay for dots and an underlying
`<input type="range">` (visually hidden, `position: absolute; opacity: 0`) for accessible keyboard
binding and `role="slider"` semantics. Dot `x` positions are computed once on bounds load:
`x = (Date.parse(dot.date) - Date.parse(earliest)) / (Date.parse(latest) - Date.parse(earliest)) × trackWidth`.
On window resize, positions are recomputed and the SVG is redrawn.

### 8.4 In-flight request cancellation

When the user drags the thumb to a new position before the current reconstruction completes, the
in-flight fetch is cancelled via `AbortController.abort()` and a new request is issued. The Grid
skeleton remains visible throughout. This prevents stale responses from overwriting a newer selection.

### 8.5 Design bible deviations (flag to Pixel for P4)

The design bible (`design-bible-part1.html`) is the baseline and ceiling for standard components. C05
introduces two deliberate, named deviations:

1. **Amber as a persistent mode colour.** The design bible uses `--amber` (#e5940c) exclusively for
   warnings and transient alerts. C05 repurposes it as the persistent "not-live state" theme colour: the
   AS OF banner background, the diff-cell left border, and the out-of-range date chip. This choice is
   intentional — PMs must never confuse a historical view with live data, and amber carries exactly the
   "caution: this is not current" signal needed. **Do not substitute with `--accent` or a neutral.**
   P4 must maintain this amber persistence for the full duration of Time Travel mode.

2. **`not-yet-created` middle-dot glyph `·`.** The C01 Grid glyph contract defines `–` for off, `✓` for
   on, `◐` for conditional/targeted. The `·` glyph is new to C05. It is intentionally lighter and smaller than
   `–` to signal "this cell is empty because the flag did not exist yet" rather than "this flag was
   explicitly disabled." P4 must differentiate `·` and `–` clearly in the visual mock — colour, weight,
   and size should all differ.

---

## 9. Open Questions for P2

Answers required before P2 begins the reconstruction engine. Listed in priority order.

| # | Question | Options | Recommendation |
|---|---|---|---|
| P2-Q1 | **Date vs datetime granularity for `asOfDate`?** Date granularity is simpler for PMs. Datetime allows distinguishing two same-day merges (e.g. prod flip at 14:03; PM queries 13:00). | (a) Date-only — treat as end-of-day UTC. (b) Datetime with HH:MM picker. | **Start with (a).** Same-day multi-commit disambiguation is rare. Datetime picker increases interaction cost with low PM payoff. Revisit if specific PM feedback surfaces it. |
| P2-Q2 | **Which commit timestamp?** ADO returns `committerDate` and `authorDate`. These diverge on cherry-picks. | (a) `authorDate` — matches PR-merge date visible to PMs. (b) `committerDate` — git-canonical. | **Use `authorDate` (a).** PMs reason in PR-merge terms; `authorDate` matches what the Activity Stream (C04) shows. Consistency across surfaces matters. |
| P2-Q3 | **Pre-warm scope.** Gold sample is ~6 commits per flag; real history may be deeper for older flags. | (a) Most-recent 10 commits per flag. (b) All commits in last 2 years. (c) All history, no limit. | **Option (b).** Balances startup cost (~100–200 fetches, < 2 MB) against PM query coverage (most questions land in the last 12 months). Escalate to (c) only if P2 confirms total ADO call count < 500 after measuring real history depth. |
| P2-Q4 | **Memo invalidation key.** Keying on `asOfDate` alone allows serving stale memos after a `/refresh` that added a commit. | (a) Per `asOfDate` string (simple, potentially stale). (b) Per `(asOfDate, commitListHash)` (correct, slightly more complex). | **Option (b) is required.** A `/refresh` that adds a new commit changes the correct reconstruction for all dates ≥ that commit's `authorDate`. Option (a) would silently serve wrong data post-refresh. |
| P2-Q5 | **History depth / scrubber left bound.** ADO path-commits paginates for old flags; unbounded depth is expensive. | (a) No limit — fetch all pages. (b) Define `earliest` as `max(first-commit-date, today − 3 years)`. | **Option (b) as default.** Prevents unbounded ADO pagination. If CEO requests deeper history, the 3-year floor can be extended without a contract change. The `bounds.earliest` value communicates the actual left bound to the UI. |
| P2-Q6 | **Pre-warm progress visibility.** Should P2 expose `warmthPercent` on `/bounds` so the UI can show a progress bar during pre-warming? | (a) Yes — optional `warmthPercent: number` field (0–100). (b) No — pre-warm is silent; scrubber just works or spins. | **Option (a) recommended.** A thin sub-track bar reassures PMs that the scrubber will respond quickly as they explore the timeline. Minimal implementation cost; the field is optional so the UI degrades gracefully if absent. |
| P2-Q7 | **Change-point definition.** Is one ChangePoint one calendar date or one commit SHA? | (a) One calendar date — all commits on the same day produce one dot. (b) One commit SHA — one dot per commit, may overlap visually. | **Option (a).** Calendar-date grouping keeps the track readable. Hover tooltip already exposes per-flag detail. A date with 4 commits to 2 flags is one dot with `commitCount=4, flagCount=2`. |
| P2-Q8 | **`not-yet-created` vs `off` in reconstruction output.** Should P2 return `not-yet-created` in the cell, or should the UI infer it from `existsAtDate=false`? | (a) P2 sets each cell's state to `not-yet-created` explicitly. (b) P2 sets `existsAtDate=false` on the row; UI applies `not-yet-created` to all 15 cells. | **Option (a) is the contract as specified.** P2 must populate each cell explicitly to keep the UI stateless. Do not require the UI to derive cell state from row metadata. |

---

*Sana — Architecture agent, EDOG Studio hivemind*
*P1 gate: this spec must pass Sentinel review before P2 begins the reconstruction engine.*
