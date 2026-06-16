# C01 — The Grid: Component Deep Spec

> **Component:** Control Tower Grid (42×15 posture matrix — home view)
> **Feature:** F30 — Control Tower
> **Owner:** Sana (architecture + data contract), Pixel (JS/CSS rendering), Vex (data engine — P2 phase), Sentinel (quality gates)
> **Complexity:** HIGH — headline component; every other surface is navigated to *from* the Grid
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Contract](#2-data-contract)
3. [Layout & Interaction Model](#3-layout--interaction-model)
4. [State Matrix](#4-state-matrix)
5. [Keyboard & Accessibility](#5-keyboard--accessibility)
6. [Performance](#6-performance)
7. [Open Questions for P2](#7-open-questions-for-p2)

---

## 1. Overview

C01 is the home view of Control Tower: a **42-row × 15-column read-only posture matrix** answering the PM's first question — "where is every FLT flag across every environment, right now?" — in a single glance. The flag `Id` (as found in the FM JSON file, e.g. `FLTArtifactBasedThrottling`) is the row key; the environment key is the column key; each cell encodes one of four FM-derived states.

### 1.1 Role in the feature

C01 is **Layer 1 — Posture** in the three-layer Control Tower model (spec.md §2). It is the portal's entry point. Every other surface — C02 Dossier, C03 Rollout Ladder, C04 Activity Stream, C05 Time Travel, C07 Inert-Flag Intelligence — is accessed *from* the Grid via a cell click, row click, or badge click. C01 never navigates away on its own.

### 1.2 What C01 is NOT

- **Not** F11/C03 (Feature Flags Matrix). That component force-ONs flags in a live local FLT process backed by `EdogFeatureOverrideStore`. C01 reads the FeatureManagement git repo and renders org-wide truth for all 15 environments. They share FM schema understanding but nothing else (spec.md §1 "Relationship to F11").
- **Not** a flag editor. No pencil icon, no inline description edit, no approval flow.
- **Not** a runtime view. Cell states derive from FM JSON at the last-fetched commit on `master`, not from live flag evaluations. There are no evaluation counters, no SDK calls.
- **Not** a write surface of any kind. The read-only constraint is architectural and unconditional (spec.md Hard Constraints). C01 declares zero POST/PUT/DELETE endpoints in its data contract (§2.3). Sentinel must reject any implementation that introduces a write path.

### 1.3 The 42 flags (source of truth)

The row set is derived from the FeatureManagement repo on `master`: all files under `Features/Configuration/Features/` whose name matches `/^FLT[^/]+\.json$/`. As of P0 research, this yields **42 flags** (the "FLT-42"). That number may drift by ±1–2 over time as flags are added or retired; the product is not hard-coded to 42. The non-FLT ~13,160 flags in the same monorepo are never fetched, never displayed, never mentioned.

---

## 2. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

C01 is a **pure consumer** of the P2 data engine. It makes exactly one GET call and renders the typed response below. P2 implements the ADO REST plumbing, semantic diff, attribution mining, stale-hint computation, and prerequisite parsing. C01 knows nothing of ADO REST internals. Anything P2 computes that is not listed here is invisible to C01.

### 2.1 Canonical types

```typescript
/**
 * The 15 environments in canonical display order.
 * This ordering drives column rendering (§3.2). P2 must return all 15 keys
 * in every flag's `cells` record; absent env blocks in FM JSON are normalised
 * to { state: 'off' }.
 */
type EnvKey =
  | 'onebox'                                                   // Group: Other
  | 'test' | 'cst' | 'daily' | 'dxt' | 'msit' | 'prod'       // Group: Ladder (6)
  | 'mc' | 'gcc' | 'gcchigh' | 'dod' | 'usnat' | 'ussec' | 'usgovcanary'  // Group: Sovereign (7)
  | 'bleu';                                                    // Group: Other

/**
 * The 4 FM-derived cell states.
 * Maps 1-to-1 to the 4 JSON shapes documented in p0-foundation.md §P0.2:
 *   off          → {} or key absent
 *   on           → { "Enabled": true }
 *   conditional  → { "Requires": [...] }
 *   targeted     → { "Targets": {...} }
 */
type CellState = 'off' | 'on' | 'conditional' | 'targeted';

/**
 * Git-derived attribution: who caused the cell to enter its current state.
 * MUST be labelled "Last enabled by" in the UI. Never "Owner" — no such
 * field exists in FM (spec.md Hard Constraints; p0-foundation.md §P0.2).
 */
interface CellAttribution {
  author: string | null;   // commit author display name
  prNumber: number | null;  // from "Merged PR NNNNNNN" in merge-commit message
  commitId: string;         // full 40-char SHA; UI truncates to 7 for display
  changedAt: string;        // ISO-8601
}

/**
 * Condition detail — present only when state === 'conditional'.
 * Derived by P2 from the flag's Requires array in FM JSON.
 */
interface ConditionSummary {
  requires: string[];     // prerequisite flag IDs; may include non-FLT IDs
  knownFLT: boolean[];    // parallel array: true if requires[i] is in the FLT-42 set
}

/**
 * Target detail — present only when state === 'targeted'.
 * One entry per Targets pivot (e.g. TenantObjectId, RegionName, MemberOf).
 * Raw values beyond previewValues[3] are NOT in this contract; the full list
 * lives only in C02 Dossier behind a gated reveal.
 */
interface TargetSummary {
  pivotKind: string;        // e.g. "TenantObjectId", "RegionName", "MemberOf"
  count: number;            // total number of values in this pivot list
  previewValues: string[];  // first 3 values (full GUIDs or names); C01 truncates for display
}

/** One cell in the 42×15 matrix. */
interface GridCell {
  state: CellState;
  attribution?: CellAttribution;        // present for 'on', 'conditional', 'targeted'
  conditionSummary?: ConditionSummary;  // present only for 'conditional'
  targetSummary?: TargetSummary[];      // present only for 'targeted'; one entry per pivot
}

/**
 * Staleness taxonomy adopted from P0.3 (Statsig-inspired, CEO-LOCKED 2026-06-13).
 * These are NEUTRAL OBSERVATIONS — never prescriptive "clean me up" nudges.
 * The question-mark treatment in the UI (§3.7) is intentional.
 */
type StaleReason =
  | 'PROBABLY_LAUNCHED'
  | 'PROBABLY_DEAD'
  | 'PROBABLY_FORGOTTEN'
  | 'ACTIVE_ROLLOUT'
  | null;  // STABLE — no label shown

// Derivation is canonical in C06 §4.3 — do not redefine.

interface StaleHint {
  reason: StaleReason;
  lastChangedAt: string;  // ISO-8601 of most recent env-state change across all 15 envs
  ageDays: number;        // (now - lastChangedAt) in whole days
}

/** One row in the grid — one FLT flag. */
interface FlagRow {
  /** FM flag Id. E.g. "FLTArtifactBasedThrottling". Primary display label and row key. */
  id: string;
  /**
   * From FM JSON `Description`. Fallback: FeatureNames.cs XML doc-comment.
   * P2 applies fallback server-side; C01 always receives a non-empty string.
   * E.g. "Set true if want to enable artifact-based throttling for FLT Service.
   *        EnableFMVServiceAPIThrottling must be enabled for this feature to take effect."
   */
  description: string;
  cells: Record<EnvKey, GridCell>;
  /**
   * Count of environments where state !== 'off'. Range 0–15.
   * Computed by P2. C01 uses this for sort order and the breadth bar (§3.7).
   */
  rolloutBreadth: number;
  /** True when ALL 6 ladder envs (test, cst, daily, dxt, msit, prod) are 'on'. */
  ladderComplete: boolean;
  /** ISO-8601 of the most recent cell state change across all 15 envs. */
  lastChangedAt: string;
  /**
   * Prerequisite flag IDs parsed by P2 from Description prose.
   * May include non-FLT IDs (e.g. "EnableFMVServiceAPIThrottling").
   * C01 renders the dependency indicator (§3.7) when present.
   * P2 marks unknown prereqs — C01 never asserts "inert" from this field alone.
   */
  prerequisiteIds?: string[];
  /** Present when staleness thresholds are exceeded. Absent otherwise. */
  staleHint?: StaleHint;
}

/** Grid-level metadata for the stats bar and freshness indicator. */
interface GridMeta {
  fetchedAt: string;            // ISO-8601; when this snapshot was assembled by P2
  branch: string;               // always "master" in V1
  commitSha: string;            // full HEAD SHA of master at fetch time (display as 7-char)
  flagCount: number;            // actual count of FLT-prefix flags found; should be ~42
  cacheAgeSeconds: number;      // age of the cached data; drives the freshness indicator
  staleThresholdSeconds: number; // the P2-configured TTL; C01 uses this for its own display
  stale: boolean;               // true when cacheAgeSeconds > staleThresholdSeconds
  error?: string;               // non-null only on partial-data / degraded responses
}

/** Root response — the single shape C01 consumes from GET /api/ct/grid. */
interface ControlTowerGridResponse {
  meta: GridMeta;
  flags: FlagRow[];
}
```

### 2.2 Endpoint (declared here; P2 implements)

```
GET /api/ct/grid
```

Returns `ControlTowerGridResponse`. C01 calls this on mount and on each **Refresh** action. The endpoint is server-side only (Next.js route handler); it calls ADO REST as the signed-in Entra user (p0-foundation.md §P0.2 delegated auth). The browser receives fully-resolved, typed rows — no ADO token, no FM JSON, no raw git data ever reaches the browser.

No query parameters in V1. Filtering and sorting are client-side operations on the in-memory `flags[]` array (42 rows is well within memory; §6).

### 2.3 No write endpoints — enforced contract boundary

C01 declares **zero** POST/PUT/DELETE endpoints. The phrase "write endpoint" includes: flag toggle, force-ON, force-OFF, description edit, annotation, tag, archive, dismiss, anything. Sentinel must block any implementation that introduces a write path in this component or in C01's code module.

### 2.4 Canonical environment ordering and group membership

C01 renders columns in this exact order. This is the **display order**, not the FM JSON key order.

| Display col | `EnvKey` | Group | Label shown in header |
|---|---|---|---|
| 1 | `onebox` | Other | Onebox |
| 2 | `test` | Ladder | Test |
| 3 | `cst` | Ladder | CST |
| 4 | `daily` | Ladder | Daily |
| 5 | `dxt` | Ladder | DXT |
| 6 | `msit` | Ladder | MSIT |
| 7 | `prod` | Ladder | Prod |
| 8 | `mc` | Sovereign | Mooncake |
| 9 | `gcc` | Sovereign | GCC |
| 10 | `gcchigh` | Sovereign | GCC-High |
| 11 | `dod` | Sovereign | DoD |
| 12 | `usnat` | Sovereign | USNat |
| 13 | `ussec` | Sovereign | USSec |
| 14 | `usgovcanary` | Sovereign | USGovCanary |
| 15 | `bleu` | Other | BLEU |

The Sovereign group (cols 8–14) is collapsible as a unit (§3.11). When collapsed, a single "Sovereign" summary column replaces all seven. Onebox (col 1) and BLEU (col 15) are single-column "Other" group entries; they do not collapse.

---

## 3. Layout & Interaction Model

### 3.1 Chrome zones

The page is divided into four horizontal zones. The top three are sticky; the grid body scrolls independently.

```
┌──────────────────────────────────────────────────────────────────┐
│  PAGE HEADER  (sticky z=30)                                      │
│  Control Tower  ·  FeatureManagement@master  ·  ↻ Refresh  ·   │
│  Last fetched: 3 min ago  ·  ⌘K  ·  ◑ Dark/Light toggle        │
├──────────────────────────────────────────────────────────────────┤
│  STATS BAR  (sticky z=20)                                        │
│  42 flags  ·  Prod ON: 28  ·  Sovereign gap: 14  ·  Stale: 2    │
│  abc1234 ↗  ·  Fetched 3 min ago                                │
├──────────────────────────────────────────────────────────────────┤
│  TOOLBAR  (sticky z=20)                                          │
│  [Search flags…]  Sort ▾  State ▾  [Stale]  [Ladder complete]   │
├──────────────────────────────────────────────────────────────────┤
│  GRID  (scrollable body)                                         │
│  ├─ Sticky col-group header row                                  │
│  ├─ Sticky env-label header row                                  │
│  └─ 42 flag rows                                                 │
└──────────────────────────────────────────────────────────────────┘
```

**Page header:**
- `Control Tower` — wordmark (links to `/control-tower`, reloads grid with filters cleared)
- `FeatureManagement@master` — repo + branch badge; deep-links to the ADO repo root
- `↻ Refresh` — triggers GET `/api/ct/grid`; spinner while in-flight; disabled for 3 s after a successful refresh (cooldown, §6)
- `Last fetched: N min ago` — renders `meta.fetchedAt` as relative time; absolute ISO timestamp on hover; turns amber when `meta.stale === true` with text "N min ago — may be stale"
- `⌘K` — opens Cmd-K palette (cross-feature; not scoped to C01)

**Stats bar** (all values computed client-side from `flags[]`):
- **42 flags** — `meta.flagCount`; if `meta.flagCount !== flags.length` shows amber "42 expected, 41 returned"
- **Prod ON: N** — count of rows where `cells.prod.state === 'on'`
- **Sovereign gap: N** — count of rows where `cells.prod.state === 'on'` AND all 7 sovereign env states are `'off'` (relevant for ⑧ Compliance lens)
- **Stale: N** — count of rows where `staleHint` is defined; clicking this applies the Stale filter
- **`abc1234 ↗`** — 7-char `meta.commitSha`, deep-linked to `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/commit/<sha>`

**Toolbar** (§3.8, §3.9):
- `[Search flags…]` — text input, live filter
- `Sort ▾` — sort menu (name / rollout breadth / last changed)
- `State ▾` — state filter chip group (All / On / Off / Conditional / Targeted)
- `[Stale]` — toggle; filters to rows with `staleHint` present
- `[Ladder complete]` — toggle; filters to rows where `ladderComplete === true`

### 3.2 Column groups and sticky headers

The column header zone occupies **two stacked sticky rows**:

**Row 1 — Group headers** (spanning):
```
[ Flag Name (pinned) ] [Onebox] [←— Promotion Ladder —→] [←————— Sovereign Clouds ▾ ————→] [BLEU]
                         col 1     cols 2–7                   cols 8–14 (collapsible)        col 15
```

- "Promotion Ladder" spans cols 2–7 and carries a `→` directional hint (implies left-to-right promotion order)
- "Sovereign Clouds" spans cols 8–14 and carries a `▾`/`▸` toggle (§3.11)
- "Onebox" and "BLEU" are single-column spans; no toggle
- Group dividers are rendered as 2 px vertical separators in `var(--border-bright)`

**Row 2 — Individual env headers:**
Each env label is a clickable sort trigger. Click cycles: unsorted → sort-asc → sort-desc (by that env's state, order: `on` → `targeted` → `conditional` → `off`). The active sort column shows `▲` or `▼`. A second click reverses; a third click clears.

**Sticky behaviour:**
- Both header rows pin to the top of the viewport as the grid body scrolls vertically (CSS `position: sticky; top: <zone-height>`)
- The Flag Name column (leftmost) is `position: sticky; left: 0` as the grid scrolls horizontally during sovereign expansion
- The top-left intersection cell (Flag Name header) correctly handles both axes simultaneously via `z-index` layering

### 3.3 Cell visual language — 4-state glyph contract

Each cell encodes state via **both** glyph (shape + Unicode) and fill color. Color is never the sole channel.

| State | Glyph | Fill | Glyph color | Semantic (FM source) |
|---|---|---|---|---|
| `off` | `–` (en-dash) | None | `var(--text-3)` | `{}` or key absent in FM JSON |
| `on` | `●` (black circle) | `var(--green)` at 15% opacity | `var(--green)` `#18a058` | `{ "Enabled": true }` |
| `conditional` | `◑` (left half-filled circle) | `var(--blue)` at 12% opacity | `var(--blue)` `#2d7ff9` | `{ "Requires": [...] }` |
| `targeted` | `◎` (bullseye circle) | `var(--purple)` at 12% opacity | `var(--purple)` `#a855f7` | `{ "Targets": {...} }` |

Real examples from seed data confirming each state appears in production:
- **on:** `FLTArtifactBasedThrottling` in `test` through `prod` and `bleu`
- **conditional:** `FLTParallelNodeLimit10` in `test, daily, dxt, msit, prod`; `FLTUserBasedThrottling` in `cst`
- **targeted:** `FLTDqMetricsBatchWrite` in `prod`; `FLTMlvExecutionDefinitionsPublicApiSupport` in `prod`
- **off:** `FLTArtifactBasedThrottling` in all sovereign envs (`mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary`)

**Cell dimensions — default density:**
- Width: 52 px (ladder/other cols); 48 px (sovereign cols — slightly narrower, group is wide)
- Height: 32 px
- Flag Name column: 240 px min-width; truncated with ellipsis; full name revealed on hover

**Compact density mode** (toolbar toggle):
- Cell width: 40 px; height: 24 px; flag name: 180 px; glyph font-size: 11 px

> **Design ceiling flag (for P4 — Phantom):** The glyph-in-cell model is the design-bible baseline. A more groundbreaking alternative worth P4's evaluation: **chromatic heat-map mode** — cells rendered as pure color blocks (no glyph, fill saturation encodes state intensity: full green = `on`, quarter-blue = `conditional`, etc.) with the glyph layer as an optional overlay toggle. A 42×15 = 630-cell heat map creates an immediate visual texture that reveals rollout patterns (e.g. a left-green-right-empty band = "ladder only, no sovereign") at a glance — faster than symbol scanning. This is above anything in the surveyed industry (LaunchDarkly, Unleash, Flagsmith all use tabular text). P4 should prototype both and test with PMs. The glyph approach is the safe baseline; heat-map mode is the ceiling. The data contract supports either rendering path.

### 3.4 Conditional cells — tooltip

A cell with `state === 'conditional'` has `conditionSummary`. On hover (300 ms delay), a floating tooltip appears:

```
┌─────────────────────────────────────────────────────┐
│  ◑  Conditional — Prod                              │
│  ─────────────────────────────────────────────────  │
│  Requires:                                          │
│    · FLTArtifactBasedThrottling           (FLT)     │
│    · EnableFMVServiceAPIThrottling   (non-FLT)      │
│                                                     │
│  Last enabled by: Ayush Singhal                     │
│  Feb 12, 2026 · PR #1234567 ↗                      │
└─────────────────────────────────────────────────────┘
```

Content rules:
- Header: state label + env display label
- `Requires:` list from `conditionSummary.requires[]`; for each entry append `(non-FLT)` when `conditionSummary.knownFLT[i] === false`
- Attribution block: "Last enabled by: `attribution.author`" + formatted `attribution.changedAt` + PR `#prNumber ↗` deep-link to ADO PR URL
- If `attribution` is absent: omit attribution block silently (never show "Owner"; never fabricate)

**Example:** `FLTParallelNodeLimit10` has `conditional` in `prod`. Its `Requires` block gating logic is surfaced here; full raw JSON is deferred to C02 Dossier.

### 3.5 Targeted cells — tooltip

A cell with `state === 'targeted'` has `targetSummary[]`. On hover:

```
┌─────────────────────────────────────────────────────┐
│  ◎  Targeted — Prod                                 │
│  ─────────────────────────────────────────────────  │
│  Targets:                                           │
│    · TenantObjectId  ×  3                           │
│      a3b2c1d4…  f9c1e200…  0e4d7fa8…               │
│                                                     │
│  Last enabled by: Jayaprakash Kupparaju             │
│  Mar 13, 2026 · PR #1235001 ↗                      │
└─────────────────────────────────────────────────────┘
```

Content rules:
- Per entry in `targetSummary[]`: `pivotKind  ×  count`, then `previewValues` joined by spaces (each value truncated to 8 chars + `…`)
- Attribution block: same pattern as §3.4
- Raw value lists beyond the 3-preview cap are NOT shown here; clicking opens C02 Dossier (§3.10) which has the gated full-reveal panel

**Example:** `FLTDqMetricsBatchWrite` is `targeted` in `prod` — tooltip shows its Targets pivot(s) and counts.

### 3.6 Hover affordances — all cells

| Cell state | Visual on hover | Tooltip content |
|---|---|---|
| `off` | `var(--bg-3)` fill | "Not deployed to `<EnvLabel>`" |
| `on` | Brightened green fill (`var(--green)` 25%) | Attribution: "Last enabled by: X · date · PR link" (if available) |
| `conditional` | Brightened blue fill (`var(--blue)` 22%) | Condition tooltip (§3.4) |
| `targeted` | Brightened purple fill (`var(--purple)` 22%) | Target tooltip (§3.5) |

All cells use `cursor: pointer`. Tooltip delay: 300 ms (avoids flicker during row scanning). Tooltip dismisses immediately on mouse-leave.

**Row highlight on hover:** hovering any cell in a row applies `var(--bg-2)` to the entire row (via row `:hover` CSS, not JS). The cell-level color fill is additive on top of the row highlight.

### 3.7 Flag Name column features

The Flag Name cell is not a plain label. From left to right:

```
[ ◇ dep? ]  FLTParallelNodeLimit10                    [ ████░░░░ ]  [ Forgotten? ]
  indicator  flag id (truncated at 240px, full on hover)  breadth bar   stale badge
```

**Prerequisite indicator (`◇`, `var(--text-3)`):**
Shown when `prerequisiteIds` is non-empty. On hover: "Depends on: `prerequisiteIds.join(', ')`". When a prerequisite ID is not in the FLT-42 set (most common case — e.g. `EnableFMVServiceAPIThrottling`), it is flagged as non-FLT but still shown. C01 does NOT assert "inert" — that analysis belongs to C07 (Layer 3 Intelligence). The indicator's only claim is "this flag has declared prerequisites."

**Rollout breadth bar:**
A miniature horizontal bar appended to the right edge of the flag name cell. Width is proportional to `rolloutBreadth / 15`. Color matches the dominant cell state in the row: green if mostly `on`, blue if mostly `conditional`, purple if the only on cells are `targeted`. Gives at-a-glance coverage signal without requiring the user to count cells.

**Stale badge:**
Present when `staleHint` is defined. Renders as a compact chip with `var(--text-3)` text and `var(--bg-3)` fill:
- `PROBABLY_LAUNCHED` → "Launched?"
- `PROBABLY_DEAD` → "Dead?"
- `PROBABLY_FORGOTTEN` → "Forgotten?"

These are **neutral observations**, not clean-up nudges (CEO ruling, P0 gate 2026-06-13). The question mark is intentional. On hover: "Enabled in N/15 envs — last changed `ageDays` days ago." Clicking the badge navigates to C02 Dossier (§3.10, scrolled to staleness section).

**Click target:** clicking the Flag Name cell (anywhere not covered by the breadth bar or stale badge click zones) navigates to C02 Dossier for that flag (default view, no pre-focused env).

### 3.8 Sort

Three sort axes are available from the `Sort ▾` dropdown in the toolbar:

| Sort | Directions | Tie-break |
|---|---|---|
| **Name** (default) | A→Z / Z→A | — (name is unique) |
| **Rollout breadth** | ↓ most→least / ↑ least→most | `id` A→Z |
| **Last changed** | Newest first / Oldest first | `id` A→Z |

**Column-header sort:** clicking an individual env-label header sorts rows by that env's cell state. Sort order for env state: `on` → `targeted` → `conditional` → `off`. Direction toggle: first click = asc, second = desc, third = clear (returns to toolbar sort). Active sort header shows `▲`/`▼`. Column-header sort and toolbar sort are mutually exclusive; last-activated wins.

### 3.9 Filter

Four filter mechanisms. All active filters are **AND-combined** (a row must satisfy every active filter to appear).

**1. Search (text input):**
- Matches `id` (primary) and `description` (secondary), case-insensitive substring
- Applied live, debounced 80 ms
- Matched substring highlighted in `var(--accent)` within the flag name cell
- Example: typing "Throttl" matches `FLTArtifactBasedThrottling`, `FLTCapacityThrottlingAsUserError`, `FLTUserBasedThrottling`

**2. State filter (chip group: All / On / Off / Conditional / Targeted):**
- Filters rows where **any** env cell matches the selected state
- Single-select; selecting the active chip returns to "All"

**3. Stale toggle:**
- Shows only rows where `staleHint` is defined
- Badge shows count (e.g. "2") to communicate how many stale flags exist before activating the filter

**4. Ladder-complete toggle:**
- Shows only rows where `ladderComplete === true`
- Useful PM query: "what is fully promoted through prod?"

**URL-encoded filter state (P0.3 adopted idea #5, CEO-LOCKED 2026-06-13):**
All active filter state is encoded in the URL query string so views are deep-linkable and bookmarkable:
```
/control-tower?q=Throttl&state=conditional
/control-tower?stale=1
/control-tower?ladder=1&sort=breadth-desc
```
On back-navigation from C02, the filter state is restored from the URL.

**Filter-empty state:** when all 42 rows are filtered out by active filters, render "No flags match your current filters" with a "Clear filters" link. This is distinct from the API-level empty state (§4).

### 3.10 Cell and row click — navigation to C02

| Click target | Destination |
|---|---|
| Flag Name cell | C02 Dossier for this flag, default view (full env table) |
| Any env cell (`off`, `on`, `conditional`, `targeted`) | C02 Dossier for this flag, with the clicked env **pre-focused** (C02 scrolls to and highlights that env's row) |
| Rollout breadth bar | C02 Dossier for this flag, default view |
| Stale badge | C02 Dossier for this flag, scrolled to the staleness section |

All navigation is deep-link compatible. Cell-click URL pattern:
```
/flag/FLTArtifactBasedThrottling
/flag/FLTArtifactBasedThrottling?env=prod
```

Back-navigation from C02 returns to the Grid at the same scroll position with all filters preserved (URL-driven state; no JS scroll position memory needed).

### 3.11 Sovereign group — collapse/expand

The 7 sovereign columns are **collapsible as a single group**.

**Collapsed state (default, 10 columns visible):**
The 7 individual sovereign columns are replaced by a single "Sovereign" summary column (width: 72 px). Per row, the summary cell shows the **worst-case state** across the 7 envs:
- Any `targeted` → `◎` (purple)
- Else any `conditional` → `◑` (blue)
- Else any `on` → `●` (green)
- All `off` → `–` (neutral)

Hover on the summary cell: tooltip shows the individual sovereign breakdown as a compact one-line list:
```
mc:●  gcc:–  gcchigh:–  dod:–  usnat:–  ussec:–  usgovcanary:–
```

The `▾` toggle in the "Sovereign Clouds" group header triggers expansion.

**Expanded state (16 columns visible, horizontal scroll enabled):**
All 7 individual sovereign columns are rendered. The Flag Name column remains sticky-left. The `▸` toggle in the group header collapses. Expansion state is persisted in the URL: `?sov=expanded`.

Expand/collapse is animated: CSS `width` transition at 200 ms `cubic-bezier(0.4, 0, 0.2, 1)`. The DOM cells for sovereign columns are always present (width 0 when collapsed, not `display: none`) to avoid layout reflow (§6).

> **Design ceiling flag (for P4 — Phantom):** Instead of a single worst-case glyph in the summary cell, a **micro-strip** of 7 × 4 px dots (spaced 2 px apart, colored by individual env state) gives immediate per-sovereign density information without expanding the group. For example: `● ● ─ ─ ─ ─ ─` in the summary tells the PM "GCC and GCC-High only, rest dark" in one blink. This is a genuinely novel pattern — no surveyed product (LD, Unleash, Flagsmith) ships this for multi-env rollout summaries. P4 should prototype the micro-strip against the worst-case glyph approach. The worst-case glyph is the baseline; micro-strip is the ceiling.

---

## 4. State Matrix

| State | Entry condition | Visual behaviour | User actions available | Exit |
|---|---|---|---|---|
| `loading` | Grid mounts; GET in-flight; no prior cache | 42 skeleton rows with shimmer cells; stats bar: "Fetching from FeatureManagement@master…"; toolbar disabled | None | → `populated` or `error` |
| `populated` | GET succeeds; `flags.length > 0`; `meta.error` absent; `meta.stale === false` | Full 42×15 grid; stats bar live; toolbar enabled | Sort, filter, search, hover cells, click to C02, Refresh, expand sovereign | → `refreshing` (Refresh), → `filter-empty` (search/filter) |
| `stale-populated` | GET succeeds; `meta.stale === true` | Full grid renders; page header timestamp badge turns amber: "Fetched Xm ago — may be stale"; stats bar shows amber dot | All grid interactions; Refresh | → `refreshing` |
| `refreshing` | User clicks Refresh while grid shows any populated state | Grid remains fully visible (no skeleton); Refresh button shows spinner and is disabled; stats bar: "Refreshing…" | All grid interactions except Refresh | → `populated`, `stale-populated`, or `error` |
| `error` | GET fails (network, auth, 5xx); no prior cached data | Error state (§4.1); grid body empty; error banner prominent | Retry, re-login (auth error) | → `loading` (Retry) |
| `error-with-cache` | GET fails; prior cached data exists | Full grid renders with amber overlay banner: "Showing data from Xh ago — live fetch failed · Retry" | All grid interactions; Retry | → `refreshing` (Retry) |
| `partial-error` | GET succeeds; `meta.error` present; some flags have parse failures | Full grid renders; amber top banner: "N flag(s) could not be fully parsed — data may be incomplete"; affected flag cells show `?` glyph in `var(--amber)` | All grid interactions; hover `?` cells for "Parse error" tooltip | Remains `populated` until next Refresh resolves the parse issue |
| `filter-empty` | All rows filtered out by active search/filter | "No flags match your current filters" + "Clear filters" link; stats bar count shows "0 of 42"; grid body empty | Clear filters | → `populated` |
| `empty` | GET succeeds; `flags.length === 0` | "No FLT flags found in FeatureManagement@master" + contact note; this is abnormal and implies a P2 configuration issue | Refresh | → `loading` |

### 4.1 Error state details

| Error type | Banner text | Recovery affordance |
|---|---|---|
| Network unreachable | "Cannot reach FeatureManagement. Check your network." | Retry button |
| Auth error (401/403) | "Your session has expired. Sign in again to continue." | "Sign in" → Entra login flow |
| ADO rate limit (429) | "ADO rate limit reached. Retrying in Ns." | Auto-retry with countdown; manual Retry also available |
| Server error (5xx) | "Control Tower data engine is unavailable." | Retry button; if stale cache exists, renders as `error-with-cache` |

### 4.2 Edge cases

| Edge case | Behaviour |
|---|---|
| `attribution` absent for an `on` cell | Cell renders `●` normally; tooltip attribution block is omitted silently. No "Owner" placeholder. No error indicator. |
| `prerequisiteIds` contains only non-FLT IDs | Prerequisite indicator shown (`◇`); hover tooltip: "Depends on: EnableFMVServiceAPIThrottling (non-FLT, state unknown in this view)". Never asserts inert. |
| `rolloutBreadth === 0` | All 15 cells show `–`; breadth bar empty; no stale badge unless `staleHint` present. |
| `rolloutBreadth === 15` | All 15 cells `●`; breadth bar full green; if `staleHint.reason === 'PROBABLY_LAUNCHED'` → "Launched?" badge. |
| `meta.flagCount !== flags.length` | Stats bar amber note: "`meta.flagCount` flags expected, `flags.length` returned — data may be incomplete". Data integrity signal for engineering. |
| Unexpected 5th JSON shape in a cell (P2 parse error) | P2 normalises to a `parse-error` sentinel state; C01 renders `?` in `var(--amber)`; tooltip: "Parse error — raw data could not be interpreted". |
| Sovereign expand + horizontal scroll + sort/filter | Horizontal scroll position is preserved across sort/filter operations. Sticky Flag Name column remains pinned at left throughout. |
| Column-header sort + active toolbar sort conflict | Most-recently activated wins. Both sources update the same `activeSortKey` state variable; there is no "stacked sort". |
| Search + all results filtered, then Refresh | Refresh applies to the full dataset; filter remains active; if the refreshed dataset also produces 0 results, remains in `filter-empty`. |
| Very long description (> 500 chars) | Tooltip truncates at 300 chars with "… (click for full details)". C02 Dossier shows the full description. |
| `FLTDqMetricsWriteDisabled` pattern (on in `onebox`, off everywhere else) | Renders correctly; `rolloutBreadth === 1`; breadth bar shows 1/15; no special treatment. Read-only; the unusual pattern is just data. |

---

## 5. Keyboard & Accessibility

The grid implements a **roving-focus table** (`role="grid"`). Tab moves focus into the grid; once inside, arrow keys navigate. Tab does not cycle through every cell.

### 5.1 Navigation keys

| Key | Action |
|---|---|
| `↑` / `↓` | Move focus to previous/next row (wraps at top and bottom) |
| `←` / `→` | Move focus to previous/next cell within the focused row |
| `Home` | Move focus to the Flag Name cell of the focused row |
| `End` | Move focus to the last visible env cell of the focused row |
| `Enter` or `Space` | Navigate to C02 Dossier (same as click) |
| `Escape` | If search input has text: clear search. If no search active: return focus to the page header Refresh button. |
| `/` | Focus the search input (from anywhere within the grid, without requiring Tab navigation) |
| `Tab` | Move focus out of the grid to the next element in the toolbar |

### 5.2 ARIA annotations

```
role="grid" aria-label="FLT flag rollout matrix, 42 flags, 15 environments"
  role="rowgroup" (thead)
    role="row"
      role="columnheader" aria-sort="ascending|descending|none"
        for sovereign summary header: aria-expanded="true|false"
  role="rowgroup" (tbody)
    role="row"
      role="rowheader"  → flag name cell
      role="gridcell"   → each env cell
```

**`aria-label` for env cells** (pattern):
```
"<flagId>, <envLabel>: <state>[, requires: <req1>, <req2>][, targets: <pivot> × <count>][, last enabled by <name> on <date>]"
```

Examples:
- `"FLTArtifactBasedThrottling, Prod: on, last enabled by Ayush Singhal on Feb 4, 2026"`
- `"FLTParallelNodeLimit10, Prod: conditional, requires EnableFMVServiceAPIThrottling (non-FLT)"`
- `"FLTDqMetricsBatchWrite, Prod: targeted, TenantObjectId × 3, last enabled by Jayaprakash Kupparaju on Mar 13, 2026"`
- `"FLTArtifactBasedThrottling, Mooncake: off"`

**Sovereign summary cell:**
```
aria-label="Sovereign clouds summary: <worst-state>. Expand to see per-cloud detail."
```

**Stale badge:**
```
aria-label="Staleness hint: <reason>. Last changed <ageDays> days ago."
```

**Prerequisite indicator:**
```
aria-label="Has prerequisites: <id1>, <id2>"
```

### 5.3 Live regions and dynamic announcements

- **Stats bar:** `aria-live="polite"` — announces count changes when filters are applied (e.g. "Showing 3 of 42 flags")
- **Refresh button during flight:** `aria-busy="true"` on the grid element; Refresh button `aria-disabled="true"`
- **Stale banner:** `role="alert"` on first render; announces once; does not re-announce on subsequent renders
- **Error banner:** `role="alert"` for error and partial-error states

### 5.4 Focus visibility

All interactive cells (gridcell, columnheader, buttons) use:
```css
outline: 2px solid var(--accent);
outline-offset: -2px;
```
Focus outlines are never suppressed for pointer-device users (`:focus-visible` is acceptable; `outline: none` is not).

---

## 6. Performance

**Row count and virtualization:** 42 rows in V1. All rows are rendered in the DOM directly — no virtualization needed and no virtualization complexity introduced. However, the virtualization path must be wired as an inactive code branch, guarded by a configurable constant:
```javascript
const GRID_VIRTUALIZATION_THRESHOLD = 100; // activate row virtualization above this count
```
When `flags.length > GRID_VIRTUALIZATION_THRESHOLD`, switch to windowed rendering (sticky headers, roving focus, and row count indicators must be preserved). This ensures FLT growth never creates layout jank without a code change.

**Client-side filtering and sort:** all operations on the in-memory `flags[]` array. No re-fetch. 42 items × any sort/filter is imperceptible; no debounce needed beyond the 80 ms search input debounce.

**Tooltip DOM:** one shared floating tooltip element, reused for all 630 cells. Content is swapped on each hover activation. No 630 pre-rendered hidden nodes.

**Sovereign collapse DOM:** sovereign column cells are always in the DOM (`width: 0; overflow: hidden` when collapsed, not `display: none`). CSS `width` transition at 200 ms handles the animation. This avoids layout reflow on expand and preserves cell accessibility tree presence for screen readers that navigate by cell.

**Refresh cooldown:** the Refresh button is disabled for 3 seconds after a successful refresh. During the 3-second window a countdown renders inside the button (e.g. "↻ 2s"). This prevents rapid-fire ADO REST calls.

**Image and icon budget:** zero external image fetches. All glyphs are Unicode characters (§3.3) or inline SVG. No icon font, no sprite sheet.

**Initial load:** C01 starts the GET `/api/ct/grid` fetch immediately on mount (not deferred). While in-flight, the skeleton grid (§4) provides perceived-instant content. The goal is < 200 ms time-to-first-meaningful-paint on a warm P2 cache.

---

## 7. Open Questions for P2

These questions cannot be resolved by the C01 spec alone. P2 (`architecture.md`) must answer each before implementation starts. Questions are ordered by blocking risk.

**Q1 — Stale-hint age thresholds.**
What are the `ageDays` thresholds for each `StaleReason`? p0-foundation.md §P0.3 uses "> 90 days" as a placeholder. P2 must confirm or tune these thresholds against real FLT flag lifecycle data (e.g. what is the median promotion time for a FLT flag?). C01 uses `staleHint.ageDays` and `reason` as given; it does not hardcode thresholds.

**Q2 — Attribution completeness guarantee.**
Can P2 guarantee `attribution` is present for every non-`off` cell? Very old flags (where the initial commit predates useful git history) may have no recoverable attribution. If this is common (> 5% of cells), P2 should add `attribution.unavailableReason: 'history-truncated' | 'parse-error'` so C01 can render a contextual note rather than silent omission.

**Q3 — `description` thinness heuristic.**
P0.2 specifies "fall back to FeatureNames.cs XML docs where FM JSON Description is thin." P2 must define "thin" server-side (e.g. `description.length < 30` or `description === id`) and apply the fallback so C01 always receives a populated, non-trivial `description`. C01 should not receive both sources and make the decision itself.

**Q4 — `cells` record key ordering.**
JavaScript object key enumeration order is insertion-order per the spec, but depends on P2 serialisation. P2 should either: (a) return `cells` as an ordered array `{ env: EnvKey, cell: GridCell }[]`, or (b) confirm that JSON serialisation preserves insertion order and that P2 inserts keys in canonical display order (§2.4). Option (a) is recommended. Alternatively, expose `meta.envOrder: EnvKey[]` so C01 can sort `cells` entries by that array.

**Q5 — `conditionSummary.requires` normalisation.**
Are there FM JSON `Requires` arrays that contain structured objects rather than plain ID strings? P2 must normalise all shapes to `string[]` before serving the C01 contract. C01 does not parse raw FM `Requires` structures.

**Q6 — `targetSummary.previewValues` format.**
P2 populates `previewValues` with up to 3 values. For GUID-pivot targets (e.g. `TenantObjectId`), are full GUIDs sent? C01 will truncate to 8 chars + `…` for tooltip display (e.g. `a3b2c1d4…`). P2 must send the full untruncated value so C01 can decide truncation, not receive pre-truncated strings it cannot expand in C02.

**Q7 — `FLTDqMetricsBatchWriteInsert` and similar partial-ladder flags.**
The seed data shows `FLTDqMetricsBatchWriteInsert` is `on` in `test`, `cst`, `daily`, `dxt` but `off` in `msit` and `prod` — a partial ladder without a conditional. Is this a deliberate rollout-in-progress, or a stale forgotten flag? P2's stale-hint should catch `PROBABLY_FORGOTTEN` here if `lastChangedAt` is old enough. Confirm the threshold is calibrated to distinguish "in-progress rollout" (recent `lastChangedAt`) from "forgotten" (stale `lastChangedAt`).

**Q8 — Prerequisite detection quality.**
`prerequisiteIds` is parsed from `description` prose (e.g. "EnableFMVServiceAPIThrottling must be enabled"). P2's parser must not produce false positives on flag names mentioned in passing (e.g. in comparison sentences). What is the intended recall/precision? If precision is low, the prerequisite indicator (§3.7) will fire on flags with no real dependency, degrading signal quality. P2 should expose a confidence field or suppress low-confidence parses before serving the contract.

---

*Spec authored by Sana. P4 (Phantom) owns pixel-level visual execution after P0–P3 gates pass. This spec defines WHAT the component does and WHAT it receives; it does not specify exact pixel values, animation curves, or colour-mixing ratios beyond the design token references above.*
