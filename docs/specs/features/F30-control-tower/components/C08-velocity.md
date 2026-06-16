# C08 — Rollout Velocity: Component Deep Spec

> **Component:** Rollout Velocity (View ⑨, Layer 3 — Intelligence)
> **Feature:** F30 — Control Tower
> **Owner:** Sana (architecture + metric formulas), Vex (P2 data engine), Pixel (JS/CSS layout)
> **Complexity:** HIGH — multi-metric cohort analytics, git-derived timelines
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Overview](#1-overview)
2. [Metric Definitions](#2-metric-definitions)
3. [Data Contract](#3-data-contract)
4. [Layout & Interaction Model](#4-layout--interaction-model)
5. [State Matrix](#5-state-matrix)
6. [Error Handling](#6-error-handling)
7. [Open Questions for P2](#7-open-questions-for-p2)

---

## 1. Overview

**Role in the product.** Rollout Velocity is View ⑨ inside Layer 3 (Intelligence). Its single question is: *how fast do FLT feature flags move through the 6-rung promotion ladder, and how does any one flag compare to the cohort?*

The view is purely observational. Every metric derives from git commit timestamps in the `FeatureManagement` repo — the same per-file commit history that the P2 data engine walks for the Activity Stream (④) and Time Travel (⑤). There is **no runtime telemetry, no evaluation counts, no exposure data, and no usage rates**. All of this class of data is structurally unavailable (P0.3 "CANNOT replicate"). A flag that took 37 days to reach prod and a flag that is permanently stuck at `dxt` are both represented truthfully. Neither produces an action button, a warning badge, or a "clean this up" nudge — findings are neutral observations only (P0 CEO ruling 2026-06-13).

**What it answers (PM/TPM audience):**

| Question | Answer |
|---|---|
| How long did `FLTArtifactBasedThrottling` take to move from `test` to `prod`? | 37 days |
| What is the typical rollout time across FLT flags? | Median TTP |
| Which flags are currently stuck mid-ladder? | In-flight list |
| How long do flags usually sit in each stage before advancing? | Per-rung median dwell |
| Is rollout velocity improving over time? | Trend-by-quarter cohort |
| Are any flags fully deployed and untouched for months? | Stale-reason labels (PROBABLY_LAUNCHED) |

**What it cannot answer (hard non-scope — no runtime data):**

- Evaluation or hit counts; rollout percentage by traffic; A/B metric impact; user exposure rates; whether a flag *should* move faster.

**Data source.** Git commit history per FLT flag file, accessed via ADO REST `GET /commits?searchCriteria.itemPath=<path>&searchCriteria.itemVersion.version=master` (P0.2 §4, steps 4–5). Content at each commit is fetched and diffed semantically on the `Environments` block. P2 owns computation and caching; C08 declares the contract (§3) but not the implementation.

**Relationship to other views.** C08 shares the same `EnableEvent` primitives as the Activity Stream (④). The P2 engine should compute `EnableEvent` arrays once per flag per refresh cycle and serve them to both consumers. C08 is the analytics aggregation layer over that shared primitive.

---

## 2. Metric Definitions

All formulas work on **calendar days** (difference of the date portions of ISO-8601 timestamps, rounded to whole days — no hour or minute precision). The 6-rung promotion ladder is fixed: `test → cst → daily → dxt → msit → prod` (P0.2 §"15 environments"). The 9 remaining envs (`onebox`, `mc`, `gcc`, `gcchigh`, `dod`, `usnat`, `ussec`, `bleu`, `usgovcanary`) are off-ladder — they appear in the expanded-row supplemental section (§4.5) but are excluded from every TTP, dwell, and cohort formula.

### 2.1 Primitive: Enable Event

The atomic unit from which all velocity metrics are derived:

```
EnableEvent = {
  flagId      : string        // FM flag ID, e.g. "FLTArtifactBasedThrottling"
  env         : EnvKey        // one of the 15 envs
  fromState   : EnvState      // prior state: off | on | conditional | targeted | absent
  toState     : EnvState      // new state:   off | on | conditional | targeted
  commitDate  : date          // calendar date only (ISO-8601 date portion)
  commitId    : string        // immutable; used for content caching
  author      : string        // "Last enabled by" — from commit author display name
  prNumber?   : number        // parsed from "Merged PR <NNN>" in merge-commit message
}
```

- **"Enabled" event:** `toState ∈ {on, conditional, targeted}` — any transition away from `off` or `absent`.
- **"Disabled" event:** `toState = off` — tracked in the event log for completeness, but not used in any TTP or dwell formula.
- **`absent`:** `fromState = absent` on the very first commit for a file (no prior content to diff against).

### 2.2 Per-Flag Anchor Dates

For each flag, derive the following from its `EnableEvent` sequence. All fields are `null` if the corresponding event does not exist in the commit history.

| Derived field | Formula |
|---|---|
| `testFirstEnabledDate` | Earliest `commitDate` where `env = test` AND `toState ∈ {on, conditional, targeted}` |
| `prodFirstNonOffDate` | Earliest `commitDate` where `env = prod` AND `toState ∈ {on, conditional, targeted}` |
| `prodFirstFullyOnDate` | Earliest `commitDate` where `env = prod` AND `toState = on` |
| `createdDate` | `commitDate` of the first-ever commit in the flag file's path history (file creation) |

`testFirstEnabledDate` is the ladder entry point. A flag with `testFirstEnabledDate = null` has **no ladder entry** and is excluded from all TTP and dwell calculations. It appears in the per-flag list as "never started."

### 2.3 Time-to-Prod (TTP)

**Primary TTP (strict — full prod enable):**

```
TTP = prodFirstFullyOnDate − testFirstEnabledDate   [calendar days]
```

Defined only when both dates are non-null. This is the headline metric and the value used in all cohort statistics.

**Secondary TTP — partial (first prod non-off):**

```
TTP_partial = prodFirstNonOffDate − testFirstEnabledDate   [calendar days]
```

Defined when `prodFirstNonOffDate ≠ null` but `prodFirstFullyOnDate = null`. Applies to flags permanently in `conditional` or `targeted` state in prod — they have "arrived" in prod but not as a full blanket enable. Displayed as `{N}d partial` to distinguish from a strict TTP.

**Worked example — `FLTArtifactBasedThrottling` (P0 gold sample):**

| Event | Date | Author |
|---|---|---|
| `test` off → on | **2026-02-04** | Ayush Singhal |
| `cst` cond → on | 2026-02-12 | — |
| `daily` off → on | 2026-02-12 | — |
| `dxt` off → on | 2026-02-24 | — |
| `msit` off → on | 2026-03-03 | — |
| `prod` off → targeted | 2026-03-10 | — |
| `prod` targeted → on | **2026-03-13** | — |
| `bleu` off → on | 2026-05-05 | Jayaprakash Kupparaju |

```
testFirstEnabledDate   = 2026-02-04
prodFirstNonOffDate    = 2026-03-10   →  TTP_partial = 34 days
prodFirstFullyOnDate   = 2026-03-13   →  TTP         = 37 days  ← primary
```

`bleu` (2026-05-05) is an off-ladder non-sovereign regional env. It does not affect TTP and is shown only in the expanded-row supplemental section.

### 2.4 Per-Rung Dwell Time

For each consecutive rung pair `(R_n, R_{n+1})` in the ladder:

```
dwell(R_n) = firstEnabledDate(R_{n+1}) − firstEnabledDate(R_n)   [calendar days]
```

where `firstEnabledDate(R)` = earliest `commitDate` with `env = R` AND `toState ∈ {on, conditional, targeted}`.

**Dwell is `null` (and the reason is recorded) when:**

| Condition | `dwellDays` | Flags set |
|---|---|---|
| `R_n` was never enabled (rung skipped by this flag) | `null` | `skipped: true` |
| `R_{n+1}` has never been enabled (flag hasn't advanced yet) | `null` | `dwellPending: true` |
| Both `R_n` and `R_{n+1}` never enabled | `null` | `skipped: true` + `dwellPending: true` |

Zero-day dwell (both rungs enabled on the same calendar day) is valid and displayed as `0d` — it is **not** omitted or treated as a skip.

**Worked example — `FLTArtifactBasedThrottling`:**

| Rung | First Enabled | Dwell to Next Rung |
|---|---|---|
| `test` | 2026-02-04 | **8d** (to cst 2026-02-12) |
| `cst` | 2026-02-12 | **0d** (to daily, same day) |
| `daily` | 2026-02-12 | **12d** (to dxt 2026-02-24) |
| `dxt` | 2026-02-24 | **7d** (to msit 2026-03-03) |
| `msit` | 2026-03-03 | **7d** (to prod first-non-off 2026-03-10) |
| `prod` | 2026-03-10 | — (terminal rung) |

Note: `cst` and `daily` were enabled the same day → dwell = 0d. Prod follows the same `firstEnabledDate` formula as every other rung — first non-off state (targeted, 2026-03-10). The later `targeted → on` graduation (2026-03-13) is surfaced as its own timeline event, NOT folded into dwell or time-to-prod.

### 2.5 In-Flight Flags

A flag is **in flight** when:

```
testFirstEnabledDate ≠ null  AND  prodFirstFullyOnDate = null
```

Its current ladder position = the highest rung `R` for which `firstEnabledDate(R) ≠ null`. This is what the ladder pip visualization shows as the "frontier."

Elapsed time in flight (for display):
```
elapsedDays = today − testFirstEnabledDate   [calendar days]
```

This is **not** a TTP estimate — it is purely "how long this flag has been on the ladder without completing." It carries no implication about how much longer rollout should take.

### 2.6 Cohort Metrics

Computed over the FLT-42 set only. Never extrapolated to non-FLT flags.

| Metric | Formula | Null condition |
|---|---|---|
| `fullyRolledOut` | Count of flags with `ttpDays ≠ null` | — |
| `inFlight` | Count with `testFirstEnabledDate ≠ null` AND `ttpDays = null` | — |
| `neverStarted` | Count with `testFirstEnabledDate = null` | — |
| `medianTtpDays` | Median of `{ttpDays}` across `fullyRolledOut` flags | `null` if fewer than 3 qualifying flags |
| `p25TtpDays` / `p75TtpDays` | 25th / 75th percentile of the same set | `null` if fewer than 3 qualifying flags |
| `fastestFlagId` / `fastestTtpDays` | `argmin ttpDays` (ties broken alphabetically) | `null` if no fully-rolled-out flags |
| `slowestFlagId` / `slowestTtpDays` | `argmax ttpDays` (ties broken alphabetically) | `null` if no fully-rolled-out flags |
| `medianDwellByRung` | Per rung (test, cst, daily, dxt, msit): median of `{dwell(R)}` across all flags where dwell is defined | `null` per rung if fewer than 3 data points |

**Trend cohorts.** To show whether rollout velocity is improving, group fully-rolled-out flags by the calendar **quarter** of their `prodFirstFullyOnDate` (e.g., "2026-Q1"). Report `medianTtpDays` per quarter. With 42 flags, quarter granularity prevents the sparse bins that month granularity would produce. Empty quarters (zero completions) are **included** in the response so gaps are visible in the chart. The visual rendering of the trend chart is a P4 decision.

### 2.7 Stale-Reason Labels (adopted from P0.3 ruling #1)

Derived purely from git state + timestamps. **Observational only — no action buttons, no "clean up" affordances.** (CEO ruling 2026-06-13: stale/inert findings are neutral observations.)

Canonical type: `type StaleReason = 'PROBABLY_LAUNCHED' | 'PROBABLY_DEAD' | 'PROBABLY_FORGOTTEN' | 'ACTIVE_ROLLOUT' | null`. Derivation is canonical in C06 §4.3 — do not redefine.

`lastChangeDate` = most recent `commitDate` across all `EnableEvent`s for the flag in **any** of the 15 envs.

Flags meeting none of the C06 §4.3 conditions carry `staleReason: null`.

---

## 3. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

C08 declares the shape; P2 (`architecture.md`) owns computation and caching. All ADO REST calls happen server-side (Vercel route handlers per P0.2); the browser receives only the typed response below. Token lifecycle and incremental refresh strategy are deferred to P2.

### 3.1 Core Types

```typescript
type EnvKey =
  | 'onebox' | 'test' | 'cst' | 'daily' | 'dxt' | 'msit' | 'prod'
  | 'mc' | 'gcc' | 'gcchigh' | 'dod' | 'usnat' | 'ussec' | 'bleu' | 'usgovcanary';

type LadderRung = 'test' | 'cst' | 'daily' | 'dxt' | 'msit' | 'prod';

/** FM JSON env-state shapes (P0.2 §"4 env-state shapes") */
type EnvState = 'on' | 'off' | 'conditional' | 'targeted';

type StaleReason =
  | 'PROBABLY_LAUNCHED'
  | 'PROBABLY_DEAD'
  | 'PROBABLY_FORGOTTEN'
  | 'ACTIVE_ROLLOUT'
  | null;  // STABLE — no label shown

// Derivation is canonical in C06 §4.3 — do not redefine.

interface EnableEvent {
  flagId: string;
  env: EnvKey;
  fromState: EnvState | 'absent';  // 'absent' = no prior content (file creation commit)
  toState: EnvState;
  commitDate: string;              // ISO-8601 date portion only, e.g. "2026-02-04"
  commitId: string;                // immutable; cache content by this key forever
  author: string;                  // commit author display name — "Last enabled by"
  prNumber: number | null;         // parsed from "Merged PR <NNN>" in merge-commit message
}

interface LadderRungRecord {
  rung: LadderRung;
  firstEnabledDate: string | null; // null = never had a non-off state
  skipped: boolean;                // true if rung was never enabled (not merely pending)
  dwellDays: number | null;        // days from this rung's firstEnabledDate to next rung's;
                                   //   null if next rung not yet enabled OR this rung skipped
  dwellPending: boolean;           // true if next rung not yet enabled (flag hasn't advanced)
}

interface FlagVelocityRecord {
  flagId: string;
  description: string;              // FM JSON Description; empty string if blank

  // Creation
  createdDate: string | null;       // commitDate of the flag file's first-ever commit
  createdBy: string | null;         // author of that commit

  // Ladder entry
  testFirstEnabledDate: string | null;
  testFirstEnabledBy: string | null;

  // Prod arrival
  prodFirstNonOffDate: string | null;   // first prod non-off (conditional / targeted / on)
  prodFirstNonOffBy: string | null;
  prodFirstFullyOnDate: string | null;  // first prod=on
  prodFirstFullyOnBy: string | null;

  // Derived velocity metrics
  ttpDays: number | null;               // null until prodFirstFullyOnDate is known
  ttpPartialDays: number | null;        // days to prodFirstNonOffDate; non-null only when
                                        //   prodFirstNonOffDate≠null AND ttpDays=null
  inFlight: boolean;                    // testFirstEnabledDate≠null AND ttpDays=null
  currentHighestRung: LadderRung | null; // highest rung with a non-off event; null if off-ladder
  elapsedDaysInFlight: number | null;   // today − testFirstEnabledDate; null if not inFlight

  // Per-rung breakdown (exactly 6 entries, ladder order)
  ladderRungs: LadderRungRecord[];

  // Stale classification
  staleReason: StaleReason | null;
  lastChangeDate: string | null;        // most recent commitDate across all 15 envs

  // All non-off enable events (all 15 envs), newest-first
  // Includes off-ladder envs for Activity Stream integration (§7.7)
  enableEvents: EnableEvent[];

  // Data quality
  historyIncomplete: boolean;           // true if P2 could not retrieve full commit history
}
```

### 3.2 API Endpoint

```
GET /api/ct/velocity
```

**Response — success:**

```typescript
interface VelocityResponse {
  generatedAt: string;              // ISO-8601 full timestamp, server clock
  dataAsOf: string;                 // commitDate of master HEAD at fetch time
  masterHeadCommitId: string;       // for incremental-refresh cache validation

  cohort: {
    totalFlags: number;             // count of FLT flags discovered (≈ 42)
    fullyRolledOut: number;
    inFlight: number;
    neverStarted: number;           // testFirstEnabledDate == null
    hasIncompleteHistory: number;   // count of flags with historyIncomplete=true

    // TTP statistics (null if < 3 fully-rolled-out flags)
    medianTtpDays: number | null;
    p25TtpDays: number | null;
    p75TtpDays: number | null;
    fastestFlagId: string | null;
    fastestTtpDays: number | null;
    slowestFlagId: string | null;
    slowestTtpDays: number | null;

    // Per-rung medians (null per rung if < 3 data points; no entry for 'prod' — terminal rung)
    medianDwellByRung: {
      test: number | null;
      cst: number | null;
      daily: number | null;
      dxt: number | null;
      msit: number | null;
    };

    // Trend (empty array if < 2 quarters have any completions)
    trendByQuarter: {
      quarter: string;              // "2025-Q4", "2026-Q1", etc.
      completedCount: number;       // flags reaching prod=on in this quarter
      medianTtpDays: number | null; // null if completedCount < 3
    }[];
  };

  flags: FlagVelocityRecord[];
}
```

**Response — error:**

```typescript
interface VelocityError {
  error: true;
  code: 'ADO_UNREACHABLE' | 'RATE_LIMITED' | 'PARSE_ERROR' | 'PARTIAL' | 'NO_FLAGS_FOUND';
  message: string;
  retryAfterSeconds?: number;       // present when code='RATE_LIMITED'
  partialFlags?: FlagVelocityRecord[]; // present when code='PARTIAL'; contains resolved records
  partialCohort?: VelocityResponse['cohort']; // cohort stats computed over partialFlags only
}
```

### 3.3 Caching and Freshness

- **Cache key:** `masterHeadCommitId`. If the HEAD commit has not changed since the last fetch, P2 MAY return a cached `VelocityResponse` without re-walking commit history.
- **Incremental refresh:** P2 re-fetches per-file commit lists and diffs only commits newer than its last known HEAD. Content is cached immutably by `commitId` (P0.2 §4 — "immutable → cache content by `commitId` forever").
- **Stale indicator threshold:** if `now − generatedAt > 15 minutes`, the UI shows an amber "Data as of [date] — Refresh" note. This is a UI-only threshold; it does not trigger an automatic re-fetch.

### 3.4 Contract Anchor

`FLTArtifactBasedThrottling` is the P1 contract anchor. P2 integration tests MUST verify that this flag's `FlagVelocityRecord` satisfies:

```
testFirstEnabledDate   == "2026-02-04"
prodFirstNonOffDate    == "2026-03-10"
prodFirstFullyOnDate   == "2026-03-13"
ttpDays                == 37
ttpPartialDays         == 34
ladderRungs[0].rung == "test"  && ladderRungs[0].dwellDays == 8
ladderRungs[1].rung == "cst"   && ladderRungs[1].dwellDays == 0
ladderRungs[2].rung == "daily" && ladderRungs[2].dwellDays == 12
ladderRungs[3].rung == "dxt"   && ladderRungs[3].dwellDays == 7
ladderRungs[4].rung == "msit"  && ladderRungs[4].dwellDays == 7
```

If this anchor fails, the P2 commit-history pipeline has a bug — it is not a UI-layer "history incomplete" state.

---

## 4. Layout & Interaction Model

*This section defines WHAT is shown and HOW users interact. Visual execution — spacing, colors, chart aesthetics, typography — is deferred to P4. Design bible tokens (`--accent`, `--green`, `--amber`, `--text-2`, etc.) are the baseline; see §4.8 for flagged deviations.*

### 4.1 Page Structure

C08 is a single-pane view within the Control Tower shell — no split panels, no navigation to a sub-page.

```
┌─ KPI Strip ─────────────────────────────────────────────────────────────────────────┐
│  N/42 fully rolled out · N in flight · Median TTP: Nd · Fastest: Nd · [⟳ Refresh]  │
└─────────────────────────────────────────────────────────────────────────────────────┘
┌─ Cohort Panel (fixed height ~260px) ────────────────────────────────────────────────┐
│  ┌─ TTP Distribution (left ~55%) ──────────┐  ┌─ Rung Dwells + Trend (right ~45%) ─┐
│  │  Dot plot, X = TTP days                 │  │  Median-dwell bar chart (5 rungs)   │
│  │  Green=rolled, Amber=in-flight          │  │  Trend-by-quarter column chart      │
│  └─────────────────────────────────────────┘  └─────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────────────────┘
┌─ Toolbar ───────────────────────────────────────────────────────────────────────────┐
│  [Search by flag name]  [Status: All ▾]  [Stale: All ▾]  [Sort: TTP asc ▾]         │
└─────────────────────────────────────────────────────────────────────────────────────┘
┌─ Per-Flag Velocity List (scrollable) ───────────────────────────────────────────────┐
│  Row: flag name · stale badge · TTP · 6-pip ladder · last-advance attribution       │
│  └─ Expanded row (inline): full ladder timeline · dates · off-ladder envs           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 KPI Strip

A single row of stat pills, left-aligned, separated by `·`:

| Pill | Content | Null / zero handling |
|---|---|---|
| Rolled out | `{fullyRolledOut} / {totalFlags} rolled out` | Always shown |
| In flight | `{inFlight} in flight` | Hidden when `inFlight = 0` |
| Median TTP | `Median TTP: {medianTtpDays}d` | `Median TTP: —` when `null` |
| Fastest | `Fastest: {fastestTtpDays}d ({abbreviatedFlagId})` | Hidden when `null` |
| Slowest | `Slowest: {slowestTtpDays}d ({abbreviatedFlagId})` | Hidden when `null` |

Right-aligned: `Data as of {dataAsOf}` + `[⟳ Refresh]` button.

`abbreviatedFlagId` strips the `FLT` prefix and truncates at 20 chars with `…` to keep the strip scannable.

While a refresh is in progress with existing data visible: the Refresh button shows a spinner and is disabled; all other UI remains interactive (the existing data is not cleared — see `loading-refresh` state).

### 4.3 Cohort Panel

#### Left sub-panel — TTP Distribution (dot / strip chart)

- **X-axis:** TTP in calendar days, linear scale, 0 to `max(ttpDays) + buffer`.
- **Each dot = one flag.** Dot color conveys status:
  - Green (`--green`): fully rolled out — `ttpDays ≠ null`
  - Amber (`--amber`): in flight — dot plotted at `elapsedDaysInFlight` with a dashed right-hand rail to indicate the timeline is open
  - Gray (`--text-3`): never started — not plotted; counted in a legend entry below the chart
- **IQR band:** a horizontal `p25–p75` shaded region on the x-axis (uses design-bible `--bg-3`).
- **Interaction:** hover a dot → tooltip showing `flagId`, TTP value or "in flight since {date}". Click a dot → scroll-to and highlight the corresponding flag row in the per-flag list.
- **P4 deviation note:** the strip / dot plot is not a standard design-bible component. P4 should verify the chart aligns with F16 skin conventions or introduce a justified custom component.

#### Right sub-panel — two stacked compact charts

**Median-dwell bar chart (5 rungs):**
- Horizontal bars; Y-axis labels: `test→cst`, `cst→daily`, `daily→dxt`, `dxt→msit`, `msit→prod`.
- Bar length = median dwell days. A thin tick marks the p25/p75 range if ≥ 5 data points exist.
- If a rung has fewer than 3 data points: bar is absent; label reads "insufficient data" in `--text-3`.

**Trend-by-quarter column chart:**
- One bar per quarter; height = `medianTtpDays` for that quarter; count overlay.
- Hidden entirely when `trendByQuarter.length < 2` (not enough quarters to show a trend).
- Empty quarters (zero completions) render as zero-height bars — gaps are informative.

### 4.4 Per-Flag Velocity List

**Default sort:** TTP ascending (nulls last — in-flight flags appear after fully-rolled-out flags; never-started flags at the bottom).

**Columns:**

| Column | Content | Notes |
|---|---|---|
| Flag | `flagId` (full — no truncation on desktop) | Click to expand/collapse the row |
| Stale | Stale-reason badge: `PROBABLY_LAUNCHED` · `PROBABLY_DEAD` · `PROBABLY_FORGOTTEN` | Absent when `staleReason = null` |
| TTP | `{ttpDays}d` or `{ttpPartialDays}d partial` or `— in flight ({elapsedDays}d)` or `—` | `—` for never-started flags |
| Ladder | 6-pip inline visualization (see §4.5 A) | — |
| Last advance | `Last enabled by {author} in {rung}` (most recent ladder enable event) | `—` for never-started flags |

**Sort options:** TTP ascending · TTP descending · Flag name A→Z · Most recently active · In-flight first.

**Filter options:**

- *Status:* All · Fully rolled out · In flight · Never started
- *Stale:* All · PROBABLY_LAUNCHED · PROBABLY_DEAD · PROBABLY_FORGOTTEN · None (no label)
- *Completed in:* Last 30 days · Last 90 days · Last year · All time (filters on `prodFirstFullyOnDate`)

**Search:** prefix match on `flagId`, case-insensitive. Clears when `Escape` is pressed.

**URL state.** Filter, sort, search query, and the currently-expanded flag ID are serialized as URL query parameters (P0.3 adoption #5 — "URL-encoded filter state / saved views"). Sharing the URL restores the exact view state. Parameters:

| Parameter | Values |
|---|---|
| `filter` | `all` · `rolledOut` · `inFlight` · `neverStarted` |
| `staleFilter` | `all` · `PROBABLY_LAUNCHED` · `PROBABLY_DEAD` · `PROBABLY_FORGOTTEN` · `none` |
| `completedIn` | `30d` · `90d` · `1y` · `all` |
| `sort` | `ttpAsc` · `ttpDesc` · `nameAsc` · `recentFirst` · `inFlightFirst` |
| `q` | URL-encoded search string |
| `flag` | `flagId` to pre-expand on load |

### 4.5 Per-Flag Expanded Row

Triggered by clicking the flag name or the row disclosure chevron. Expands inline — no page navigation.

#### A. Inline 6-pip Ladder Visualization (list view — compact)

A horizontal sequence of 6 small circular pips connected by arrows, left-to-right:

```
● ──8d──▶ ● ──0d──▶ ● ──12d──▶ ● ──7d──▶ ● ──7d──▶ ●
test      cst       daily       dxt        msit       prod
```

Pip states:
- **Filled, green (`--green`):** rung is enabled (any non-off state)
- **Hollow, dashed border, gray (`--text-3`):** rung was never enabled (`skipped: true`)
- **Filled, amber (`--amber`):** highest rung reached by an in-flight flag (frontier)
- **Hollow, solid border, gray:** rung not yet reached (`dwellPending: true`)

Dwell numbers appear on the arrows. Zero-day dwell renders as `0d`. Pending dwell (frontier and beyond) renders a dashed arrow with no number.

#### B. Full Ladder Timeline (expanded row — detailed)

A larger horizontal timeline with dates and attribution below each rung node:

```
[test]  ──8d──▶  [cst]  ──0d──▶  [daily]  ──12d──▶  [dxt]  ──7d──▶  [msit]  ──7d──▶  [prod]
Feb 04             Feb 12           Feb 12             Feb 24          Mar 03             Mar 10
Ayush Singhal                                                                       (first non-off: Mar 10
                                                                                     full on: Mar 13)
```

For `prod` (and any rung) where `prodFirstNonOffDate ≠ prodFirstFullyOnDate`, show two sub-events stacked below the node:
- `first non-off: {prodFirstNonOffDate}` (conditional / targeted)
- `fully on: {prodFirstFullyOnDate}`

Hover on each node: tooltip shows full ISO date, author, PR deep-link (`Merged PR {prNumber}` → ADO PR URL), and the FM `Environments` JSON diff for that commit (P0.3 adoption #3 — "JSON-diff 'Details' on each Activity entry").

Skipped rung nodes: hollow circle, `—` below, connecting arrow is grayed.

#### C. Off-Ladder Envs (supplemental section)

Below the ladder timeline, a compact supplemental row:

- `onebox`: state badge (on / off / conditional / targeted) + date if non-off
- `bleu`: state badge + date if non-off (non-sovereign regional env — not grouped with sovereign)
- Sovereign envs (7): collapsed summary, e.g. `mc / gcc / gcchigh / dod / usnat / ussec / usgovcanary: off`. Click `[Show all sovereign envs]` to expand to individual rows.

#### D. Attribution Footer

`Created by {createdBy} on {createdDate}` — or `History incomplete — creation date unavailable` if `historyIncomplete: true`.

### 4.6 Keyboard & Accessibility

- Arrow Up / Down: navigate flag rows.
- `Enter` or `Space`: expand / collapse focused row.
- `/`: focus search input.
- Expanded ladder timeline nodes: focusable. `Enter` on a node opens the tooltip.
- Dot-plot dots: `role="img"` with `aria-label="FLTFlagX, 37 days to prod"` or `"FLTFlagX, in flight, 45 days elapsed"`.
- KPI pills: `role="status"` — screen readers announce updated values after a Refresh.
- Stale-reason badges: `aria-label="Stale — PROBABLY_FORGOTTEN"` (not just the label text, which is a code string).
- The cohort charts are supplemental / decorative for screen readers; they carry `role="img"` with a concise `aria-label` summarizing the key stats.

### 4.7 Deep-Link Example

```
/control-tower?view=velocity&filter=inFlight&sort=ttpAsc&flag=FLTArtifactBasedThrottling
```

On load, this URL: renders the velocity view, applies the `inFlight` filter, sorts TTP ascending, and pre-expands `FLTArtifactBasedThrottling`'s row.

### 4.8 Design Bible Deviations

The following patterns go beyond existing design-bible components and must be verified or introduced in P4:

1. **Dot / strip plot chart** (TTP Distribution): no existing chart component in the design bible. P4 must either use an approved charting primitive or justify and document the new component.
2. **Inline 6-pip ladder visualization** (compact, list-level): a new micro-component. P4 should verify it fits the existing pip/badge token vocabulary.
3. **Horizontal node-and-arrow timeline** (expanded row): also new. P4 should check whether the Activity Stream (④) uses a similar pattern and, if so, share the component.

All other elements (KPI pills, search, filter chips, sort dropdown, badges, tooltips) follow existing design-bible patterns.

---

## 5. State Matrix

| State | Entry condition | KPI Strip | Cohort Panel | Per-Flag List | Notes |
|---|---|---|---|---|---|
| `loading` | Initial page load; no cached data | 4 skeleton pills (pulsing) | Empty axes + skeleton bars | 6 skeleton rows | VelocityResponse in flight |
| `loading-refresh` | User clicks Refresh while data exists | Spinner on Refresh button; existing pills remain | Charts visible, unmodified | List remains interactive | Incremental P2 fetch; existing data is not cleared |
| `insufficient-history` | Response received; `fullyRolledOut + inFlight < 2` (almost no ladder events — likely shallow history retrieval or first-time fetch of a near-empty FM state) | Hidden | Hidden | Hidden | Full-page info state: icon + "Insufficient git history to compute velocity. This view requires complete commit history for each FLT flag file. Verify that the P2 engine is fetching `master` branch history without pagination cutoff." |
| `error` | P2 returns `VelocityError` with `code ≠ 'PARTIAL'`, or network failure | Red error banner with `[Retry]` | Hidden | Hidden | If prior data is cached from an earlier session load, show stale data with amber "Last updated {N} ago" below the error banner |
| `error-partial` | `VelocityError.code = 'PARTIAL'` | Amber banner: "Velocity data incomplete — {N} flags could not be analyzed. [Details]" | Rendered from `partialCohort` | Rendered from `partialFlags`; affected rows show "History incomplete" in TTP column | Non-blocking; the available data is shown |
| `populated` | Success response; `fullyRolledOut + inFlight ≥ 2` | 5 pills | Full charts | Full list | Standard operating state |
| `populated-stale` | `populated`, `now − generatedAt > 15 min` | Amber "Data as of {date} — Refresh" appended right | Visible | Visible | P2 not re-queried automatically; user-initiated Refresh only |

---

## 6. Error Handling

| Error | User-visible behavior | P2 responsibility |
|---|---|---|
| ADO REST unreachable | `error` state. Banner: "Cannot reach the FeatureManagement repo. Check your connection and confirm your session token is valid. [Retry]" | Return `VelocityError { code: 'ADO_UNREACHABLE' }` |
| Rate-limited (HTTP 429) | `error` state. Banner: "ADO rate limit reached — retry in {N}s." Auto-countdown; Retry button re-enables when countdown expires | Return `VelocityError { code: 'RATE_LIMITED', retryAfterSeconds: N }` |
| Some flags unresolvable | `error-partial` state. Affected flag rows show "History incomplete" in the TTP column; tooltip: "Could not retrieve full commit history for this flag." | Return `VelocityError { code: 'PARTIAL', partialFlags: [...], partialCohort: {...} }` |
| Individual flag commit-diff parse failure | That flag's `historyIncomplete: true`; its row shows `—` in TTP with tooltip "History incomplete" | Continue processing remaining flags; include flag in `partialFlags` |
| No FLT flags found | `error` state. Banner: "No FLT flags found in FeatureManagement at `master`. Expected ~42 files matching `FLT*.json`. This may indicate a scoping or authentication error." | Return `VelocityError { code: 'NO_FLAGS_FOUND' }` |
| Contract-anchor failure | `FLTArtifactBasedThrottling` MUST resolve. If it appears as `historyIncomplete: true` in any real fetch, surface a bug report to P2 — this is not an expected UX state | P2 MUST ensure this flag always resolves; it is used in contract verification tests |

---

## 7. Open Questions for P2

1. **Calendar-day precision vs. sub-day.** All formulas use date portions (no time component). When two rung enables occur on the same calendar day (e.g., `cst` and `daily` both 2026-02-12 for `FLTArtifactBasedThrottling`), dwell = 0 days. Is this always acceptable, or do PMs ever ask "was cst-to-daily hours or minutes?" Recommendation: keep days for V1; the audience is PMs, and sub-day precision adds noise.

2. **`fromState` for the file-creation commit.** The semantic diff for the very first commit has no prior `commitId` to fetch content from. P2 should record `fromState = 'absent'` for file-creation events and ensure the downstream metric formulas treat "absent → any non-off state" as an enable event. Confirm this is handled consistently across all 42 flags.

3. **Flag file renames.** If an FLT flag file is ever renamed in FM (e.g., `FLTOldName.json → FLTNewName.json`), the ADO `GET /commits?searchCriteria.itemPath` API does not follow the rename — history prior to the rename is severed. P2 should decide: (a) use only post-rename history and set `historyIncomplete: true` [recommended for V1]; (b) attempt to follow the rename via additional heuristics. Document the decision in `architecture.md`.

4. **Cohort minimum floor.** Median and percentile metrics are reported `null` when fewer than 3 fully-rolled-out flags exist. Is 3 the right floor, or should it be 5 to avoid misleadingly precise stats when only one or two outliers drive the numbers? C08 specifies 3 as a default constant; P2 should expose it as a named constant so it can be raised without a spec change.

5. **Trend quarter granularity — empty quarters.** The contract specifies that empty quarters (zero completions) must be included in `trendByQuarter` for calendar continuity. If a long gap exists (e.g., no prod rollouts for two consecutive quarters), the chart will show visible gaps. Confirm this is the desired behavior with product (RAM/Hemant); if gaps are misleading, the alternative is to emit only non-empty quarters and let P4 handle continuity.

6. **Stale threshold (90 days).** The 90-day default is common in industry but may not match FLT team norms. If FLT flags are expected to reach prod within 60 days, a 90-day threshold would suppress relevant "PROBABLY_FORGOTTEN" signals. Confirm the right threshold with the FLT team before the P2 constant is locked.

7. **Off-ladder env events in `enableEvents`.** The contract specifies that `enableEvents` includes all 15-env events (not just ladder events) for completeness and future Activity Stream integration. Confirm P2 is comfortable returning all-env events here — it approximately doubles the event payload for flags like `FLTArtifactBasedThrottling` (which has a `bleu` event). If payload size is a concern, P2 may split `ladderEvents` and `offLadderEvents` arrays; but this must be reflected in the contract before P2 implementation begins.

8. **ADO `/commits` pagination.** The ADO commits API is paginated (default 100 commits per page). Flags with long, active histories may exceed one page. P2 must handle multi-page traversal and confirm that `FLTArtifactBasedThrottling`'s full timeline (back to at least 2026-02-04) is captured in integration tests.
