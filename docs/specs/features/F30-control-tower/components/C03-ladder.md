# C03 — Rollout Ladder: Component Deep Spec

> **Component:** Rollout Ladder (Surface ③, Control Tower)
> **Feature:** F30 — EDOG Control Tower
> **Owner:** Sana (architecture + data contract), Vex (ADO REST engine — P2), Pixel (JS/CSS implementation — P4)
> **Complexity:** HIGH — dual-surface (distribution + per-flag); git-history-derived dwell; 6-rung ladder with off-ladder annotation
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Overview & Role](#1-overview--role)
2. [Data Contract](#2-data-contract)
3. [Layout & Interaction Model](#3-layout--interaction-model)
4. [State Matrix](#4-state-matrix)
5. [Open Questions for P2](#5-open-questions-for-p2)
6. [Appendix A — Seed Data Baseline](#appendix-a--seed-data-baseline-verified-2026-06-13)

---

## 1. Overview & Role

### 1.1 The problem this component solves

The Control Tower Grid (C01) answers *where* a flag sits across all 15 environments today. It does not answer *how far it has travelled*, *where the cohort is stuck*, or *who moved it and when*. A PM staring at 19 prod-enabled flags and 23 off cannot answer:

- "Is `FLTEnableFileSourcedFMLV` close to prod or just starting out?"
- "Why are 12 flags still at daily? Is that normal dwell or are they stuck?"
- "How long did `FLTArtifactBasedThrottling` sit in dxt before advancing?"
- "Who first enabled it in prod, and was that recently enough to trust?"

The Rollout Ladder answers all four by visualizing the **promotion spine** — the 6-rung sequence `test → cst → daily → dxt → msit → prod` — in two complementary modes rendered within the same component surface:

**(a) Distribution mode (default landing):** All 42 FLT flags mapped to the ladder simultaneously. Shows how many flags are enabled at each rung, surfaces "stuck cohorts" (flags whose highest rung is X, meaning they have not advanced past X), and makes the daily → dxt drop (35 → 23) visually obvious.

**(b) Per-flag mode (drill-down):** One flag selected; its 6-rung progression is shown in sequence with rung state, first-enablement dates, the author who triggered each transition ("Last enabled by"), and **dwell** — the elapsed time at each rung before the flag advanced to the next. The gold sample is `FLTArtifactBasedThrottling` (test 2026-02-04 → prod 2026-03-13, 37 days end-to-end).

This component is **read-only forever** (spec.md §3 hard constraint). No toggle, no enablement action, no remediation pathway. All signals are presented as neutral observations.

### 1.2 Ladder definition (locked, from P0.2)

The promotion spine is exactly **6 rungs** in this immutable order:

```
test  →  cst  →  daily  →  dxt  →  msit  →  prod
```

Three groups of environments sit **explicitly off this ladder**. The component must never include them in rung position, dwell, or "highest rung" calculations:

| Group | Envs | Why off-ladder | Handling |
|---|---|---|---|
| Pre-ladder | `onebox` | Developer sandbox; upstream of test; independent promotion decisions. 27/42 flags currently on. | Shown in the off-ladder annotation panel only. No dwell. |
| EU commercial | `bleu` | EU data-residency cloud; follows its own independent promotion track. Not a sovereign cloud. 10/42 flags currently on. | Shown in off-ladder annotation panel. Attribution shown if available. **Do not group with sovereign clouds.** |
| Sovereign clouds (7) | `mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary` | National-cloud deployments with separate compliance gates. | Collapsed group in the off-ladder annotation panel. Compliance analysis is C05's remit; C03 surfaces state only. |

### 1.3 Four rung states (from P0.2 schema)

Each rung carries one of four states, derived from the FM JSON for that environment. The seed JSON uses abbreviated tokens; the contract uses the canonical names:

| Seed token | Canonical name | FM JSON shape | Meaning | Is "enabled" for ladder purposes |
|---|---|---|---|---|
| `on` | `on` | `{"Enabled": true}` | Fully enabled | Yes |
| `cond` | `conditional` | `{"Requires": [...]}` | Conditional — gated by predicate (e.g., ring membership, region) | Yes |
| `target` | `targeted` | `{"Targets": {...}}` | Targeted — specific tenant/region/workspace GUIDs | Yes |
| `off` | `off` | `{}` or key absent | Not enabled | No |

`on`, `conditional`, and `targeted` all count as "enabled at a rung" for cohort assignment and highest-rung calculation. `off` is the only excluded state. `isFullyPromoted` is true only when **all 6 rungs are `on`** (not merely non-off).

### 1.4 Worked example: FLTArtifactBasedThrottling (real data — do not invent)

Source: p0-foundation.md §P0.2 gold sample. Use for P4 mock rendering, Sentinel fixture data, and P2 cache validation.

| Rung | State (current) | First enabled | Author ("Last enabled by") | Dwell at this rung before advancing |
|---|---|---|---|---|
| test | on | 2026-02-04 | Ayush Singhal | 8 days |
| cst | on | 2026-02-12 | (same PR as test) | 0 days (same-day advance) |
| daily | on | 2026-02-12 | (same PR) | 12 days |
| dxt | on | 2026-02-24 | — | 7 days |
| msit | on | 2026-03-03 | — | 7 days |
| prod | on | 2026-03-13 (via targeted 2026-03-10) | — | currently promoted |

Prod transition detail: `off → targeted` (2026-03-10, lag from msit: 7 days) → `targeted → on` (2026-03-13, 3 days later). Total test-to-prod elapsed: **37 days**. Note: the later `targeted → on` graduation (2026-03-13) is surfaced as its own timeline event, NOT folded into dwell or time-to-prod.

Off-ladder supplement: `bleu = on` (2026-05-05, Jayaprakash Kupparaju — 53 days after prod, independent promotion decision).

Current seed state: all 6 ladder rungs = `on`. `isFullyPromoted = true`. Highest rung: `prod`.

### 1.5 Design bible notes

This spec uses the design-bible-part1 token set as the baseline (colors: `--accent #6d5cff`, `--green #18a058`, `--amber #e5940c`, `--red #e5453b`; radii `--r4`, `--r6`, `--r10`; transitions `--transition 160ms cubic-bezier(0.4,0,0.2,1)`). The following two patterns **deviate from existing components and are flagged for Pixel's awareness during P4**:

1. **Dwell labels on track segments** — no existing component uses inline text on a connecting track. P4 must design the segment label affordance fresh; the design bible provides no template.
2. **Segment health coloring** (green / amber / red-amber based on count delta between adjacent rungs) — a new semantic color usage. The green/amber/red tokens are reused but the "health gradient on a track" pattern is novel. Phantom/P4 has full latitude here; this spec only defines the threshold logic (§3.2.2).

---

## 2. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**
>
> **P2 owns the implementation.** This section is the binding boundary: P1 defines WHAT, P2 defines HOW. The interfaces below are the contract that P2's ADO REST engine must fulfill. The "P2 implementation notes" subsections are non-binding guidance derived from P0.2 research; P2 may revise them.

### 2.1 Core types

```typescript
/** The 6 promotion ladder rungs, in fixed order. */
type LadderEnv = 'test' | 'cst' | 'daily' | 'dxt' | 'msit' | 'prod';

export const LADDER_ORDER: readonly LadderEnv[] = ['test', 'cst', 'daily', 'dxt', 'msit', 'prod'];

/** Off-ladder environments — never appear in rung state, dwell, or highest-rung calculations. */
type OffLadderEnv =
  | 'onebox'                                         // pre-ladder
  | 'bleu'                                           // EU commercial (NOT sovereign)
  | 'mc' | 'gcc' | 'gcchigh' | 'dod' | 'usnat' | 'ussec' | 'usgovcanary'; // sovereign (7)

/** 4 rung states derived from FM JSON shape (P0.2 §"4 env-state shapes"). */
type RungState = 'on' | 'conditional' | 'targeted' | 'off';

/**
 * Attribution for one rung's current non-off state.
 * Derived from the commit/PR that most recently changed the env to a non-off state.
 * Label in UI: "Last enabled by" — never "Owner" (no Owner field in FM).
 */
interface Attribution {
  /** Display name from commit author. */
  author: string | null;
  /** PR number extracted from merge-commit comment "Merged PR NNNNNNN". Null if no PR linkage found. */
  prNumber: number | null;
  /** Full 40-char SHA; UI truncates to 7 for display. */
  commitId: string;
  /** ISO 8601 timestamp of the commit that last changed this env to non-off state. */
  changedAt: string;
  /** Full ADO PR URL. Null if prNumber is null. */
  prUrl: string | null;
}

/** One state transition record for a rung, ordered oldest-first. */
interface StateTransition {
  /** Previous state. Null = initial commit creating the env block. */
  fromState: RungState | null;
  toState: RungState;
  at: string;             // ISO 8601
  author: string;         // commit author display name
  prNumber: number | null;
  prUrl: string | null;
}
```

### 2.2 Per-flag ladder data

```typescript
/**
 * Dwell: how long a flag spent at a rung before advancing to the next.
 * Only generated between two consecutively enabled rungs.
 * For the flag's current highest rung (not yet advanced), dwellDays = daysSince(changedAt)
 * and isCurrent = true.
 */
interface RungDwell {
  /** The rung being measured. */
  rung: LadderEnv;
  /** The rung it advanced to. Only present when isCurrent = false. */
  nextRung?: LadderEnv;
  dwellDays: number;
  /**
   * Human-readable label. P2 computes; client may recompute for isCurrent = true.
   * Examples: "8 days", "2h", "3 mo".
   */
  dwellLabel: string;
  /**
   * True when this rung is the flag's current highestRung and it has not yet advanced.
   * The UI renders this dwell label in amber to signal potential stagnation.
   */
  isCurrent: boolean;
}

/** Full record for one rung in a specific flag's ladder. */
interface RungRecord {
  env: LadderEnv;
  state: RungState;
  /**
   * Non-null when state !== 'off' AND attribution was successfully fetched.
   * Null for off rungs or when attribution fetch failed.
   */
  attribution: Attribution | null;
  /**
   * Full transition history for this rung, oldest-first.
   * Populated only in per-flag detail responses, not in distribution calls.
   * Example — FLTArtifactBasedThrottling prod:
   *   [{from:null, to:'off', ...}, {from:'off', to:'targeted', at:'2026-03-10',...}, {from:'targeted', to:'on', at:'2026-03-13',...}]
   */
  transitions: StateTransition[];
  /**
   * Raw condition or target summary from FM JSON. Non-null only when
   * state is 'conditional' or 'targeted'. Used for tooltip/expand content.
   * P2 extracts from the Requires[] or Targets{} block and formats as a short prose string.
   */
  conditionSummary: string | null;
}

interface PerFlagLadderData {
  flagId: string;
  /** Always length 6, one entry per rung in LADDER_ORDER sequence. */
  rungs: RungRecord[];
  /**
   * Rightmost rung with state !== 'off'. Null if off at all 6 ladder rungs.
   * Examples (seed): FLTArtifactBasedThrottling → 'prod';
   *                   FLTEnableFileSourcedFMLV → 'dxt';
   *                   FLTDqMetricsWriteDisabled → null (off entire ladder; only on in onebox).
   */
  highestRung: LadderEnv | null;
  /**
   * True only when ALL 6 rungs have state 'on' (not merely non-off).
   * A flag that is 'conditional' at prod is NOT fully promoted.
   */
  isFullyPromoted: boolean;
  /**
   * Dwell records. For a flag at rung R that has not advanced further,
   * exactly one entry has isCurrent = true with rung = R.
   * Skipped rungs (off between two enabled rungs) produce no dwell entry.
   */
  dwells: RungDwell[];
  /**
   * Total elapsed time from first-ever ladder enablement to first prod enablement (any non-off state).
   * Null if not yet in prod.
   * Example: FLTArtifactBasedThrottling: 37 days (2026-02-04 to 2026-03-13).
   */
  testToProdMs: number | null;
  testToProdLabel: string | null;
  /** Off-ladder env states. Supplementary only — never affect rung logic. */
  offLadder: OffLadderRecord[];
  /** Date + author of the flag file's first commit in the FM repo (file creation). */
  createdAt: string | null;
  createdBy: string | null;
  /**
   * Attribution completeness flag.
   * 'full'       — all non-off rungs have Attribution populated.
   * 'partial'    — some non-off rungs have Attribution: null (history fetch failed for those).
   * 'state-only' — no Attribution populated; state is known but git history not yet fetched.
   */
  attributionQuality: 'full' | 'partial' | 'state-only';
}

/** One off-ladder environment's state for a flag. */
interface OffLadderRecord {
  env: OffLadderEnv;
  state: RungState;
  attribution: Attribution | null;
  /** Category drives grouping in the annotation panel. */
  category: 'pre-ladder' | 'eu-commercial' | 'sovereign';
}
```

### 2.3 All-flags distribution data

```typescript
/** Breakdown of flag states at a single rung. */
interface RungBreakdown {
  env: LadderEnv;
  on: number;
  conditional: number;
  targeted: number;
  off: number;
  /** on + conditional + targeted. */
  totalEnabled: number;
}

/**
 * A cohort: flags that share the same highestRung.
 * highestRung = rightmost rung with any non-off state (on | conditional | targeted).
 * Null cohort = flags that are off at all 6 ladder rungs.
 *
 * Seed baseline (verified 2026-06-13):
 *   null: 3  |  cst: 4  |  daily: 12  |  dxt: 2  |  msit: 2  |  prod: 19  (total: 42)
 */
interface LadderCohort {
  highestRung: LadderEnv | null;
  flagIds: string[];
  count: number;
  /**
   * Breakdown of states within this cohort AT their highestRung.
   * E.g., the 'prod' cohort: { on: 13, conditional: 4, targeted: 2 }.
   */
  stateBreakdown: { on: number; conditional: number; targeted: number };
  /**
   * Median current dwell at the highestRung across flags in this cohort.
   * "How long, on median, have these flags been sitting at this rung?"
   * Null when attributionQuality is 'state-only' for most flags in the cohort.
   */
  medianDwellAtRungMs: number | null;
  medianDwellLabel: string | null;
}

interface LadderDistributionData {
  /** ISO 8601 timestamp when this snapshot was computed. */
  computedAt: string;
  totalFlags: number;  // always 42 for FLT scope
  /** 6 entries in LADDER_ORDER sequence. */
  rungBreakdown: RungBreakdown[];
  /** Up to 7 entries (null + 6 rungs); empty cohorts may be omitted. */
  cohorts: LadderCohort[];
}
```

### 2.4 API contract (declared by P1; implemented by P2)

All endpoints are Next.js server-side route handlers under `/api/ct/`. The browser never calls ADO directly (P0.2 auth model: delegated per-user, server-side only).

#### `GET /api/ct/ladder/distribution`

Returns the all-flags distribution snapshot. No path params. Response is cacheable; `syncedAt` tells the client when the FM repo was last read.

```typescript
// Success
interface LadderDistributionResponse {
  ok: true;
  data: LadderDistributionData;
  syncedAt: string;        // ISO 8601 of last successful FM repo sync
  stale: boolean;          // true if syncedAt is > 15 min ago
}

// Error (ADO unreachable, parse failure, etc.)
interface LadderDistributionErrorResponse {
  ok: false;
  error: 'adoUnreachable' | 'parseFailure' | 'noFlagData';
  message: string;
  /** Last known good data when available (stale fallback). */
  staleData?: LadderDistributionData;
  staleSyncedAt?: string;
}
```

#### `GET /api/ct/ladder/flag/:flagId`

Returns per-flag ladder data with full attribution history for the specified flag.
Path param `flagId` is the FM `Id` field (e.g., `FLTArtifactBasedThrottling`).

```typescript
// Success
interface PerFlagLadderResponse {
  ok: true;
  data: PerFlagLadderData;
  syncedAt: string;
  stale: boolean;
}

// Error
interface PerFlagLadderErrorResponse {
  ok: false;
  error: 'flagNotFound' | 'adoUnreachable' | 'historyFetchFailed' | 'parseFailure';
  message: string;
  /**
   * Partial data when state is known but attribution failed.
   * attributionQuality will be 'state-only' or 'partial'.
   */
  partialData?: PerFlagLadderData;
}
```

**P2 implementation notes (non-binding; from P0.2 research):**

- Current state (rung states) comes from the same FM file content fetch as C01 (Grid). Do not re-fetch raw file content for state alone if the Grid cache is warm.
- Attribution comes from `GET .../commits?searchCriteria.itemPath=<path>&searchCriteria.itemVersion.version=master`. Diff consecutive `commitId` pairs semantically on the `Environments` block — not line-level `git blame` — to isolate env-level changes and be immune to reformatting. Content at each `commitId` is immutable; cache forever by `commitId`. See P0.2 §"Extraction mechanism".
- `transitions[]` are required for non-`off` rungs. For `off` rungs, `transitions` may be empty.
- The `bleu` and `onebox` `OffLadderRecord.attribution` fields require the same commit-history path as ladder rungs. P2 must extend the history-fetch to include these two envs if attribution is desired.
- `testToProdMs` is measured from the first commit that set *any* ladder rung to non-`off` (i.e., first enablement anywhere on the ladder) to the first commit that set `prod` to non-`off`. Not from file creation.
- PR deep-link format: `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/{prNumber}` (confirmed ADO org from P0.2).

---

## 3. Layout & Interaction Model

### 3.1 Entry points

| Source | Target surface | URL / mechanism |
|---|---|---|
| Control Tower top-nav → "Rollout Ladder" | Distribution view | `/ct/ladder` (no params) |
| Distribution view → click a flag chip | Per-flag view | Updates to `/ct/ladder?flag=<flagId>` |
| Grid (C01) → flag row → ladder glyph (◇) | Per-flag view | `/ct/ladder?flag=<flagId>` |
| Flag Dossier (C02) → "Ladder" tab | Per-flag view (embedded) | In-Dossier tab, no URL change |
| Cmd-K → "Show ladder for <flag>" | Per-flag view | `/ct/ladder?flag=<flagId>` |
| Direct deep-link | Either surface | `/ct/ladder` or `/ct/ladder?flag=X` or `/ct/ladder?rung=dxt` |

### 3.2 Surface A: All-Flags Distribution View

This is the **default landing** for the Rollout Ladder. It renders the 6-rung spine with aggregate counts and a cohort panel below.

#### 3.2.1 Structure (layout directive for P4)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ROLLOUT LADDER                             [ ↻ Refresh ]  Synced 3m ago │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ◉ test   ◉ cst   ◉ daily   ◉ dxt   ◉ msit   ◉ prod                    │
│  38/42   36/42   35/42    23/42   21/42    19/42                          │
│  ══════════════════════════════════════════════════                        │
│       (track; segments colored by advancement health — see §3.2.2)        │
│                                                                            │
│  COHORTS ── flags grouped by highest rung                                 │
│                                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │  daily     │  │  prod      │  │  cst       │  │  (none)    │         │
│  │  12 flags  │  │  19 flags  │  │  4 flags   │  │  3 flags   │         │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘         │
│                                                                            │
│  [ dxt · 2 ]  [ msit · 2 ]   (smaller cohorts as inline chips)           │
└──────────────────────────────────────────────────────────────────────────┘
```

Cohort cards are ordered by descending count. Cohorts with ≤ 3 flags may render as compact inline chips rather than full cards. The null cohort (off entire ladder) is always shown, labeled "(none)" or "Off ladder".

#### 3.2.2 Rung node anatomy

Each rung node renders:

| Element | Content |
|---|---|
| Node glyph | Filled solid circle if `totalEnabled > 0`; hollow circle if 0 |
| Rung label | Short name: `test`, `cst`, `daily`, `dxt`, `msit`, `prod` |
| Count badge | `{totalEnabled}/42` — flags with state on + conditional + targeted at this rung |
| Hover tooltip | Sub-breakdown: `{n} on · {n} conditional · {n} targeted` (omit zero values) |

Connecting track segment between rung N and rung N+1:

| Condition | Color signal | Threshold |
|---|---|---|
| Downstream ≥ 90% of upstream | Healthy | e.g., test → cst: 38 → 36 (95%) |
| Downstream 50–89% of upstream | Caution — amber | e.g., daily → dxt: 35 → 23 (66%) |
| Downstream < 50% of upstream | Stalled — red-amber | (not present in current seed) |

The daily → dxt segment is the **primary amber signal** in the current seed population (35 → 23, 34% drop) and naturally draws attention to the 12-flag "stuck at daily" cohort. The amber color uses `--amber #e5940c`; the healthy green uses `--green #18a058`.

**Note:** the color signals are informational, not evaluative. The portal is read-only and does not prescribe action. The amber on daily → dxt is a neutral observation, not an alert.

#### 3.2.3 Cohort panel

Each cohort card (or chip):

- **Header:** rung name + count + state breakdown annotation (e.g., `prod · 19 flags — 13 on · 4 conditional · 2 targeted`)
- **Body:** flag name chips, clickable, alphabetically sorted within the cohort
- **Median dwell badge:** "Median wait: N days" when attribution is available for the majority of the cohort. Labeled "Loading…" or omitted if attribution quality is `state-only`.
- **Hover on card:** highlights the corresponding rung node on the spine above

The null cohort ("Off ladder" / "(none)") uses subdued styling (`--text-3`, `--bg-3`). The `dxt` cohort (2 flags) may be called out with a tooltip: "These 2 flags have not advanced past dxt" — it is the smallest named cohort and potentially interesting to PMs.

#### 3.2.4 Interactions (Distribution view)

| Action | Result |
|---|---|
| Click rung node | Expands/collapses the cohort card for that rung in the panel below |
| Click flag chip in a cohort | Navigates to per-flag view (Surface B) for that flag. URL updates. |
| Hover rung node | Tooltip: state sub-breakdown (n on / n conditional / n targeted) |
| Hover track segment | Tooltip: exact count delta + percentage. E.g., "daily 35 → dxt 23 (−34%)" |
| Click `Refresh` | Re-fetches `GET /api/ct/ladder/distribution`; spine + cohorts re-render |
| Search input (global top-bar) | Filters flag chips across all cohorts; non-matching chips dim. Rung node counts do not change. |
| URL param `?rung=dxt` | Auto-expands the `dxt` cohort card on load |

### 3.3 Surface B: Per-Flag Ladder View

This surface renders when a flag is selected (via cohort click, deep-link, or Cmd-K). It replaces the cohort panel below the spine with a single-flag detail view. The rung spine node at the top remains visible for context — the distribution counts are replaced with this flag's per-rung state.

#### 3.3.1 Header strip

Above the spine:

| Field | Source | Notes |
|---|---|---|
| Flag name | `flagId` | `var(--mono)`, monospace |
| Wire key | `flagId` (same unless names diverge — rare for FLT flags) | Show only if different from flagId |
| One-liner description | FM JSON `Description` field | Truncate at ~120 chars with expand |
| Status phrase | Derived from `highestRung` + `isFullyPromoted` | "Fully promoted — all 6 rungs on" / "At daily — not yet in dxt" / "Off ladder" |
| test-to-prod elapsed | `testToProdLabel` | e.g., "37 days" for FLTArtifactBasedThrottling. Hidden if `testToProdLabel` is null. |
| Inert warning (if applicable) | Prerequisite detection (P0.3 §Inert; spec.md §Inert) | "⚠ Prerequisite `EnableFMVServiceAPIThrottling` state unknown in prod — this flag may be inert." Passive observation; no write action. |
| `Open in FM repo ↗` | ADO file URL: `Features/Configuration/Features/<flagId>.json` | Opens in new tab |

#### 3.3.2 Promotion spine (per-flag rendering)

The same 6-rung horizontal spine, now showing a single flag's progression:

```
← Back to Rollout Ladder                    FLTArtifactBasedThrottling

  test         cst         daily         dxt         msit         prod
   ●─────(8d)────●───(0d)────●───(12d)────●───(7d)────●───(10d)────●
  [on]          [on]          [on]          [on]          [on]         [on]
  2026-02-04   2026-02-12   2026-02-12   2026-02-24   2026-03-03   2026-03-13
  Ayush S.

  test → prod: 37 days   ·   Fully promoted
```

Node rendering per state:

| State | Node glyph directive | Notes |
|---|---|---|
| `on` | Solid filled circle | Primary green (`--green`) |
| `conditional` | Half-filled circle | Accent (`--accent #6d5cff`); tooltip shows `conditionSummary` |
| `targeted` | Circle with inner target/crosshair marker | Accent; tooltip shows `conditionSummary` |
| `off` | Hollow circle, muted | `--text-3` |

**Dwell labels** appear on the track segment connecting two consecutive non-`off` rungs:

- Format: `{N}d` (days), `{N}h` (hours if < 1 day), `{N}mo` (months if > 90 days)
- When `isCurrent = true` (the flag is at this rung and has not advanced further): the label renders in `--amber` and reads `{N}d here` to signal the flag has been stagnant
- When a rung between two enabled rungs is `off` (a skip): the off-rung node renders hollow with a `—` label; no dwell is shown for the gap; a sub-label "never enabled" appears below the node
- Same-day advances (dwell = 0 or < 12h): label reads `same day` (e.g., cst and daily for FLTArtifactBasedThrottling)

**Transition detail (expandable per rung node):**

Clicking any non-`off` rung node expands an inline card beneath that node listing all `StateTransition[]` records:

```
prod:
  2026-03-10   off → targeted   Merged PR 1234567 ↗   (lag from msit: 7 days)
  2026-03-13   targeted → on    Merged PR 1234890 ↗   (3 days later)
```

This implements P0.3 CEO-adopted item #3 ("JSON-diff Details on each Activity entry" per LD pattern). The PR link opens ADO in a new tab.

When `attributionQuality` is `partial` or `state-only`, affected rung nodes show:
- Date field: `—` with tooltip `"Attribution unavailable for this rung"`
- Never a blank cell — absence is always explicit

#### 3.3.3 Off-ladder annotation panel

Below the promotion spine, a collapsible section. Collapsed by default.

```
  OFF-LADDER ENVIRONMENTS   ▸ expand

  Pre-ladder     onebox   [on]        (no attribution — dev ring)
  EU commercial  bleu     [on]   2026-05-05   Jayaprakash Kupparaju   · PR ↗
  Sovereign (7)  all off  [expand to see individual states]
```

Rules:
- `onebox`: state glyph only. No date, no author, no dwell. Tooltip: "Developer sandbox — not part of the promotion spine."
- `bleu`: state glyph + attribution if available. Attribution is shown because bleu follows an independent timeline from prod and the author may differ. **Not grouped with sovereign clouds.**
- **Sovereign (7)**: collapsed by default as a summary line. Expand reveals one row per sovereign env. No attribution is shown for sovereign clouds in V1 (C05 Compliance Lens owns that).
- This entire section is **never** factored into `highestRung`, `isFullyPromoted`, `testToProdMs`, or any dwell calculation.

#### 3.3.4 Interactions (per-flag view)

| Action | Result |
|---|---|
| Click `← Back` | Returns to Distribution view. Restores cohort panel scroll position. Previous cohort remains expanded. |
| Click `← →` navigation arrows | Navigate to previous/next flag within the same cohort (only when arrived from a cohort chip). |
| Click a non-`off` rung node | Expands/collapses the inline transition history card for that rung |
| Click `PR #NNNNNNN ↗` | Opens ADO PR URL in new tab |
| Hover dwell label | Tooltip: exact date range, e.g., "2026-02-12 → 2026-02-24" |
| Hover amber `{N}d here` label | Tooltip: "In {env} since {date} ({N} days)" |
| Hover conditional/targeted node | Tooltip: `conditionSummary` from FM JSON |
| Click `Open in FM repo ↗` | Opens the FM JSON file in ADO web UI in new tab |
| URL `?flag=<flagId>` | Direct deep-link — loads per-flag view immediately; bypasses Distribution view |

### 3.4 Off-ladder environment rules (hard constraints)

These are not implementation preferences; they are binding requirements derived from spec.md §3 and P0.2:

1. `onebox`, `bleu`, `mc`, `gcc`, `gcchigh`, `dod`, `usnat`, `ussec`, `usgovcanary` are **never included** in `highestRung`, `isFullyPromoted`, dwell, or any ladder calculation.
2. **`bleu` is not a sovereign cloud.** It must appear in its own "EU commercial" row in the off-ladder panel, separate from the 7 sovereign clouds. Do not merge it into the sovereign group.
3. **Sovereign cloud states are surfaced only in the off-ladder annotation panel** (state glyph, no attribution in V1). Sovereignty/compliance analysis is C05's remit.
4. When `bleu = on` while some sovereign clouds are `off`, this is factual and normal. Do not render it as a discrepancy or anomaly — no warning, no diff indicator.

### 3.5 URL state and deep-links (CEO-adopted P0.3 item #5)

| URL parameter | Values | Effect |
|---|---|---|
| *(no params)* | — | Distribution view; all cohort cards collapsed |
| `?rung=<LadderEnv>` | e.g., `?rung=dxt` | Distribution view; the specified cohort card auto-expanded |
| `?flag=<flagId>` | e.g., `?flag=FLTArtifactBasedThrottling` | Per-flag view loaded directly |

URL state updates on user navigation (cohort expansion does not update URL; flag drill-down does). Sharing the URL with a colleague opens the same view.

---

## 4. State Matrix

### 4.1 Distribution view states

| State ID | Entry condition | UI presentation | Transition |
|---|---|---|---|
| `dist-loading` | Initial page load, or after Refresh clicked. | Skeleton spine: 6 hollow nodes connected by dashed line, no counts. 3 skeleton cohort cards (grey blocks). Refresh button shows spinner, disabled. | → `dist-populated` on success; → `dist-error` on failure; → `dist-error-stale` on failure with prior data |
| `dist-populated` | `GET /api/ct/ladder/distribution` returns `ok: true`, `stale: false`. | Full spine with rung counts and health-colored segments. Cohort cards rendered. Refresh enabled. | → `dist-loading` on Refresh; → `dist-stale` if `stale` becomes true (client-side TTL check) |
| `dist-stale` | Response has `stale: true` (last sync > 15 min ago). | Amber info banner above spine: "Data may be outdated — last synced {relative time} · Refresh." Spine and cohorts render normally with stale data. | → `dist-loading` on Refresh click |
| `dist-error` | `ok: false`, no `staleData` available. | Error panel replaces spine: error icon, `message` text, Retry button. Cohort area blank. | → `dist-loading` on Retry |
| `dist-error-stale` | `ok: false` but `staleData` present in response. | Amber banner: "Could not refresh — showing data from {staleSyncedAt}." Spine and cohorts render from `staleData`. Retry enabled. | → `dist-loading` on Retry |
| `dist-empty` | `totalFlags: 0` (defensive — should not occur for FLT scope). | "No FLT flags found in scope." centered, with link to FM repo. | Manual investigation required |

### 4.2 Per-flag view states

| State ID | Entry condition | UI presentation | Transition |
|---|---|---|---|
| `flag-loading` | `GET /api/ct/ladder/flag/:flagId` in flight. | Skeleton spine: 6 nodes with state glyph placeholders but no dates/authors/dwell. Header strip shows `flagId` as placeholder text. Off-ladder panel hidden. | → `flag-populated-full`, `flag-populated-partial`, or `flag-populated-state-only` on success; → `flag-error` or `flag-error-partial` on failure |
| `flag-populated-full` | `ok: true`, `attributionQuality: 'full'`. | Full spine with all dates, authors, dwell labels, PR links, and transition history. Off-ladder panel populated. | — |
| `flag-populated-partial` | `ok: true`, `attributionQuality: 'partial'`. | Spine rendered; rungs with missing attribution show `—` for date/author with tooltip "Attribution unavailable for this rung". Dwell omitted for those segments. Off-ladder panel shown. No blank cells — absence always explicit. | — |
| `flag-populated-state-only` | `ok: true`, `attributionQuality: 'state-only'`. | Spine shows state glyphs and rung labels. All date/author fields show `—`. Dwell labels absent. Info banner: "Enablement history loading…" (if P2 uses lazy attribution — Q1). | → `flag-populated-partial` or `flag-populated-full` when attribution resolves (P2 Q1-B lazy strategy only) |
| `flag-error` | `ok: false`, no `partialData`. | Error panel replaces spine: error type, `message`, Retry. Back link always visible. | → `flag-loading` on Retry |
| `flag-error-partial` | `ok: false` but `partialData` present (`attributionQuality: 'state-only'`). | Amber banner: "Attribution fetch failed — showing state only." Spine renders from `partialData`. Retry enabled. | → `flag-loading` on Retry |
| `flag-not-found` | `error: 'flagNotFound'`. | "Flag `{flagId}` not found in FLT scope." Centered. Back link to Distribution view. Covers typos in deep-links or stale Cmd-K suggestions. | — |

### 4.3 State × affordance matrix

| State | Spine visible | Dwell labels | Attribution (dates/authors) | Off-ladder panel | Refresh/Retry |
|---|---|---|---|---|---|
| dist-loading | Skeleton | — | — | — | Disabled (spinner) |
| dist-populated | ✓ | n/a | n/a | n/a | Enabled |
| dist-stale | ✓ (stale) | n/a | n/a | n/a | Enabled (amber) |
| dist-error | ✗ | — | — | — | Retry |
| dist-error-stale | ✓ (stale) | n/a | n/a | n/a | Retry (amber) |
| dist-empty | ✗ | — | — | — | — |
| flag-loading | Skeleton | — | — | Hidden | Disabled |
| flag-populated-full | ✓ | ✓ | ✓ | ✓ | Enabled |
| flag-populated-partial | ✓ | Partial | Partial (`—` where null) | ✓ | Enabled |
| flag-populated-state-only | ✓ | ✗ | ✗ (`—` all) | Partial | Enabled |
| flag-error | ✗ | — | — | — | Retry |
| flag-error-partial | ✓ (state only) | ✗ | ✗ | Partial | Retry (amber) |
| flag-not-found | ✗ | — | — | — | — |

---

## 5. Open Questions for P2

These are unresolved design decisions that P2's architecture phase must answer. Each has a P1 recommendation; P2 must explicitly confirm or revise.

### Q1 — Attribution latency: eager vs lazy

Fetching per-flag git history for all 42 flags (commitId-pair semantic diffs) is expensive on cold load. Two strategies:

- **(A) Eager:** Prefetch all 42 histories on first Control Tower visit. Warm-up time estimated at 30–90s. Distribution view is blocked until complete (or can show `state-only` distribution while histories load in parallel).
- **(B) Lazy:** Fetch distribution state immediately (fast, batch current-state call). Fetch per-flag history only on demand (when the user navigates to per-flag view or a cohort's median dwell is requested). Per-flag view shows `flag-populated-state-only` briefly, then transitions to `full`.

**P1 recommendation: option B.** The Distribution view must load fast for PM self-service; blocking it on 42 history fetches defeats the purpose. P2 confirms.

### Q2 — Dwell computation: server vs client

Dwell values (`dwellDays`, `dwellLabel`) can be computed server-side (returned in the response) or client-side (from `attribution.changedAt` timestamps).

- Server-side: consistent, no timezone drift, simpler client code.
- Client-side: dynamic "current dwell" (`isCurrent = true`) can update every render without a re-fetch.

**P1 recommendation:** Compute `dwellDays` for historical dwells server-side. Compute `dwellLabel` and `isCurrent` dwell age client-side using `attribution.changedAt` of the `highestRung`, so "current dwell" shows real elapsed time without a re-fetch.

### Q3 — commitId cache bounds

P0.2 specifies commitId content is cached forever (immutable by design). P2 must determine worst-case cache size (42 flags × ~N commits per flag × ~2KB diff content) and whether to impose a per-flag cap (e.g., last 100 commits). Sentinel will need to know the eviction policy to write cache-exhaustion tests.

### Q4 — Rung regression semantics

P0.2 notes that the FM pipeline enforces ring order (test→…→prod), making a ring skip "structurally impossible." However, a flag could be `on` at daily, then explicitly disabled at cst via a later commit, while daily remains `on`. This is not a skip — it is a regression at cst. **P2 must clarify:** is a downstream-`on` / upstream-`off` pattern treated as a special `RungRecord.state` value (e.g., `'regressed'`)? If yes, P2 must add `'regressed'` to the `RungState` union and describe how the ladder renders it. P1 has no position; P2 decides.

### Q5 — bleu attribution priority in header strip

When `bleu = on` and `prod = on`, both have attribution. Which author appears in the header-strip "Last enabled by" label for the flag overall?

**P1 position: `prod` attribution wins the header summary.** `bleu` attribution is surfaced only in the off-ladder panel. P2 confirms this is the correct semantic (prod is the canonical rollout signal for a PM portal).

### Q6 — `flag-populated-state-only` → `full` transition mechanism

If P2 implements lazy attribution (Q1-B), the per-flag view transitions from `state-only` to `full` when history arrives. Mechanism options:

- **(A) Polling:** client re-fetches after a delay (e.g., 2s, then 5s back-off).
- **(B) Server-Sent Events (SSE):** route handler streams attribution as each env is computed.
- **(C) WebSocket:** reuse existing SignalR if Control Tower has it in scope.

**P1 position:** Option A (polling) is sufficient for a static read-only portal. Option B is acceptable if P2 finds SSE simpler to implement than polling. Option C (SignalR) is disproportionate — Control Tower has no live FLT process. P2 confirms mechanism and documents back-off strategy.

---

## Appendix A — Seed Data Baseline (verified 2026-06-13)

Source: `control-tower-seed.json` (42 real FLT flags, FM `master` branch). Provided as a fixture for P4 mock rendering and Sentinel test data. **The component must be fully data-driven — do not hard-code these counts.**

### Rung breakdown

| Rung | on | conditional | targeted | off | total enabled |
|---|---|---|---|---|---|
| test | 34 | 4 | 0 | 4 | **38** |
| cst | 35 | 1 | 0 | 6 | **36** |
| daily | 31 | 4 | 0 | 7 | **35** |
| dxt | 20 | 3 | 0 | 19 | **23** |
| msit | 18 | 3 | 0 | 21 | **21** |
| prod | 13 | 4 | 2 | 23 | **19** |

Key signal: the daily → dxt drop (35 → 23, −34%) is the largest step-down in the current population. This drives the amber segment between those rungs and corresponds to the 12-flag "stuck at daily" cohort.

### Cohort breakdown (highest rung = any non-off state)

| Highest rung | Count | Example flags |
|---|---|---|
| Off entire ladder (null) | **3** | `FLTDqMetricsWriteDisabled` (onebox-only), `FLTListPathOptimization` (onebox-only), `FLTPublicApiSupportOptOut` (off everywhere) |
| test | 0 | — |
| cst | **4** | `FLTGTSUserErrorClassification`, `FLTIRDeletesDisabled`, `FLTIRQuickMergeEnabled`, `FLTTableMaintenanceHook` |
| daily | **12** | `FLTEnableDqChecks`, `FLTEnforceWorkspacePrivateLinkAccessProtector` (cond@daily), `FLTEnableRefreshTriggers`, `FLTInsightsEngine`, `FLTInsightsMetrics`, `FLTInsightsReplCleanup`, `FLTIRCdfRatioOverloadPreventionEnabled`, `FLTIRDeletesEnabled`, `FLTIRDeltaPhysicalCDFEnabled`, `FLTMLVAutoDVDuringRefreshEnabled`, `FLTRefreshPolicy`, `FLTUserBasedThrottling` |
| dxt | **2** | `FLTDqMetricsBatchWriteInsert`, `FLTEnableFileSourcedFMLV` |
| msit | **2** | `FLTPublicApiSupport`, `FLTResilientCatalogListing` |
| prod | **19** | Includes 13 fully `on` (`FLTArtifactBasedThrottling`, `FLTDagExecutionHandlerV2`, `FLTDagSettings`, `FLTDqMetricsSetTableLogRetentionDays`, `FLTEnableOneLakeS2STokenForPLS`, `FLTLimitConcurrentOneLakeCatalogCalls`, `FLTListDagAPIPagination`, `FLTMLVWarnings`, `FLTSkipShortcutExecution`, `FLTSystemSpacePersistence`, `FLTUnresolvedEntitySupport`, `FLTUseLakeHouseMetastoreClientV2`, `FLTUseOneLakeRegionalEndpoint`) + 4 conditional (`FLTCapacityThrottlingAsUserError`, `FLTParallelNodeLimit10`, `FLTParallelNodeLimit15`, `FLTParallelNodeLimit20`) + 2 targeted (`FLTDqMetricsBatchWrite`, `FLTMlvExecutionDefinitionsPublicApiSupport`) |

**Total: 3 + 0 + 4 + 12 + 2 + 2 + 19 = 42 ✓**

### Off-ladder stats (supplementary)

| Env | Category | Flags enabled (seed) | Notes |
|---|---|---|---|
| onebox | Pre-ladder | 27 / 42 | Independent dev ring; no ladder relevance |
| bleu | EU commercial | 10 / 42 | Independent promotion; not sovereign |
| mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary | Sovereign (7) | varies | C05 scope; not analyzed here |
