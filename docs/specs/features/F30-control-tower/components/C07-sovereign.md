# C07 — Sovereign Compliance Lens: Component Deep Spec

> **Component:** Sovereign Compliance Lens
> **Feature:** F30 — EDOG Control Tower
> **View number:** ⑧ (Layer 3 — Intelligence)
> **Owner:** Pixel (JS/CSS), Vex (data contract implementation), Sana (architecture + sovereign model)
> **Complexity:** MEDIUM — focused sub-matrix of C01 data with parity overlay; no new data primitives
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13
> **Depends on:** C01 (main Grid) for cell-state glyph vocabulary; P2 data engine for ADO REST backend and gap pre-computation
> **Blocked by:** P2 (`architecture.md` — sovereign-lens endpoint must be declared there)

---

## Table of Contents

1. [Overview — Problem & Role](#1-overview--problem--role)
2. [Data Contract](#2-data-contract)
3. [Layout & Interaction Model](#3-layout--interaction-model)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Keyboard & Accessibility](#6-keyboard--accessibility)
7. [Error Handling](#7-error-handling)
8. [Performance](#8-performance)
9. [Implementation Notes](#9-implementation-notes)
10. [Open Questions for P2](#10-open-questions-for-p2)

---

## 1. Overview — Problem & Role

### The question this component answers

FabricLiveTable ships flags across 15 environments. Seven of those environments are sovereign cloud deployments with independent Azure tenancies, compliance postures, and separate approval gates: **Mooncake (mc), GCC (gcc), GCC-High (gcchigh), DoD (dod), USNat (usnat), USSec (ussec), and USGovCanary (usgovcanary)**. A flag approved and rolled out to commercial `prod` does not automatically appear in any sovereign cloud.

Today, answering even a basic sovereign rollout question requires multiple manual steps:

| Question | Today's answer location |
|---|---|
| Which FLT flags are on in prod but not yet deployed to GCC? | Open 42 JSON files, filter by FLT prefix, manually compare `gcc` block vs `prod` block per file |
| Is `FLTArtifactBasedThrottling` active in Mooncake? | Find the file; read the `mc` block — `{}` means absent; no aggregate view |
| Why is a flag gated in DoD when it is fully on in prod? | Read the raw `Requires` block in the `dod` environment block; parse the predicate list by hand |
| How many FLT flags are live in any given sovereign cloud? | No aggregate exists |

C07 answers all four classes of question from a single read-only surface, reconstructed live from the `FeatureManagement` git repo via ADO REST.

### Role within Control Tower

C07 is Layer 3 — Intelligence component ⑧. It does **not** replace the main 42×15 Grid (C01), which covers all 15 environments. C07 is a **focused lens** that:

1. Narrows the environment columns to the 7 sovereign clouds.
2. Pins the commercial `prod` state as a visible reference column.
3. Adds **parity analysis**: per-flag, per-sovereign-cloud gap classification that surfaces where commercial rollout has not yet reached a given sovereign.
4. Explains conditional (`Requires`) and targeted (`Targets`) states that are common in sovereign gating — e.g. a flag might be conditionally gated in DoD by a specific region predicate, while fully on in commercial prod.

### What C07 is NOT

- **Not a compliance enforcement tool.** The FM pipeline enforces ring order; C07 never asserts that a flag "should" be in a sovereign cloud by any deadline. It is an observation instrument.
- **Not a drift detector.** Drift detection was explicitly killed (spec.md §3 — "ring-skip is structurally impossible"). C07 shows the current snapshot; no ring-order assertions.
- **Not a write surface.** Purely read-only. No toggle, no approval action, no PR creation anywhere in this component.
- **Not a runtime view.** Data is git-derived (FM repo `master` via ADO REST). No live evaluation counts, no SDK check frequency, no telemetry.
- **Not a `bleu` lens.** The `bleu` environment is not in the sovereign set (`sovereignEnvs` in the seed data confirms 7 members). Bleu is handled by the main Grid (C01).

---

## 2. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

P2 owns the ADO REST client, commit-diff engine, and cache (see `architecture.md`). C07 **declares the shape it consumes**; P2 decides how to compute and serve it. Nothing in this section implies a specific P2 implementation strategy — that is P2's domain.

### 2.1 Endpoint

```
GET /api/ct/sovereign-lens
```

Query parameters (all optional):

| Param | Type | Default | Meaning |
|---|---|---|---|
| `flagId` | `string` | — | Filter to a single flag (used by Flag Dossier deep-link to open C07 pre-filtered) |
| `cloud` | `SovereignEnvKey` | — | Filter response to a single sovereign cloud (used for per-cloud deep-links) |

### 2.2 Type definitions

```typescript
type SovereignEnvKey =
  | 'mc'           // Mooncake
  | 'gcc'          // GCC
  | 'gcchigh'      // GCC-High
  | 'dod'          // DoD
  | 'usnat'        // USNat
  | 'ussec'        // USSec
  | 'usgovcanary'; // USGovCanary

/** The 4 env-state shapes from the FM JSON schema (p0-foundation §P0.2). */
type CellState = 'on' | 'off' | 'conditional' | 'targeted';
// 'on'          → {"Enabled": true}                — fully enabled, no conditions
// 'off'         → {} or key absent                 — not deployed / explicitly disabled
// 'conditional' → {"Requires": [...]}              — conditionally gated (predicate AND-list)
// 'targeted'    → {"Targets": {...}}               — targeted at specific tenant GUIDs / regions

/**
 * Git-commit attribution for the last semantic change to a given env block.
 * Derived by P2 via the semantic Environments-diff strategy (p0-foundation §P0.2 step 5).
 * Label is always "Last enabled by" — never "Owner" (no such field exists in FM JSON).
 */
interface Attribution {
  author: string | null;   // Git author display name (from commit metadata, not invented)
  commitId: string;        // full 40-char SHA; UI truncates to 7 for display
  prNumber: number | null; // Extracted from "Merged PR NNNNNNN" in merge-commit subject
  changedAt: string;       // ISO 8601
}

/**
 * Decoded condition block present when state is 'conditional' (Requires) or 'targeted' (Targets).
 * Common in sovereign gating: e.g. a flag may have Requires = [{Name: "PowerBI.RegionName",
 * Values: ["UK South"]}] in commercial prod, or a region-specific predicate in DoD.
 */
interface ConditionDetail {
  kind: 'Requires' | 'Targets';
  /**
   * One-line human summary synthesised by P2 for fast reading in the cell tooltip.
   * Examples:
   *   Requires: "UK South region only"
   *   Targets:  "2 tenant groups · 47 tenants"
   */
  summary: string;
  /**
   * Raw JSON block from the FM file (the Requires array or Targets object).
   * Included in the response so C07 can offer an expandable "Show raw" gated reveal
   * without a second fetch. Screenshot-safe: hidden until user clicks "Show raw".
   * Omit (and set rawTruncated) when the block exceeds 4 KB.
   */
  raw: unknown;
  rawTruncated?: boolean; // true if the raw block was truncated before serialisation
}

interface SovereignCell {
  state: CellState;
  condition?: ConditionDetail;  // present iff state ∈ {'conditional', 'targeted'}
  lastEnabledBy?: Attribution;  // present iff state ∈ {'on', 'conditional', 'targeted'}
  lastChangedBy?: Attribution;  // most recent commit touching this env block; present always
}

/**
 * Pre-computed gap kinds for the parity analysis.
 * P2 computes these server-side; C07 only renders them.
 * "Gap" = a meaningful divergence between commercial prod state and sovereign state.
 * Both off/off and both on/on are NOT gaps.
 */
type GapKind =
  | 'prod_on_cloud_off'      // Prod fully on; sovereign absent — the dominant rollout gap pattern
  | 'prod_on_cloud_cond'     // Prod fully on; sovereign conditionally gated — partial progress
  | 'prod_on_cloud_target'   // Prod fully on; sovereign targeting specific tenants — scoped progress
  | 'prod_cond_cloud_off'    // Prod conditional; sovereign absent — sovereign not even gated yet
  | 'prod_target_cloud_off'  // Prod targeted; sovereign absent
  | 'cloud_on_prod_off'      // Sovereign on, prod off — unusual; sovereign-specific or forward-deployed
  | 'cloud_on_prod_cond'     // Sovereign fully on; prod only conditional — sovereign ahead of commercial
  | 'cloud_cond_prod_off';   // Sovereign conditional; prod off — unusual gating without prod basis

interface SovereignFlagRow {
  flagId: string;                // e.g. "FLTArtifactBasedThrottling"
  description: string;           // from FM JSON; empty string if field absent
  prodState: CellState;          // commercial prod reference state
  prodCondition?: ConditionDetail;
  prodLastEnabledBy?: Attribution;
  sovereigns: Record<SovereignEnvKey, SovereignCell>;
  /**
   * Pre-computed gap map. Key = SovereignEnvKey, value = GapKind when a gap exists.
   * Absent key = no gap for that cloud.
   * Both 'off'/'off' is not a gap. Both 'on'/'on' is not a gap.
   */
  gaps: Partial<Record<SovereignEnvKey, GapKind>>;
  hasAnyGap: boolean; // true iff gaps has ≥ 1 entry — for fast client-side filtering
}

interface SovereignCloudSummary {
  cloud: SovereignEnvKey;
  label: string;        // "Mooncake", "GCC", "GCC-High", "DoD", "USNat", "USSec", "USGovCanary"
  onCount: number;           // flags with state 'on' in this cloud
  condCount: number;         // flags with state 'conditional' in this cloud
  targetCount: number;       // flags with state 'targeted' in this cloud
  offCount: number;     // flags with state 'off' in this cloud
  gapCount: number;     // flags where gaps[cloud] is defined (any GapKind)
}

interface SovereignLensResponse {
  generatedAt: string;                    // ISO timestamp of this response
  sourceCommitId: string;                 // FM repo master HEAD commitId at fetch time
  fetchedAt: string;                      // ISO timestamp of last successful FM cache fetch
  stale: boolean;                         // true if cache is older than TTL (P2 decides TTL)
  error?: string;                         // human-readable reason present on degraded responses
  flags: SovereignFlagRow[];              // 42 rows, alpha-sorted by flagId
  cloudSummaries: SovereignCloudSummary[]; // 7 entries, in sovereignEnvs canonical order
  prodReference: 'prod';                  // always literal 'prod'; locked by spec — never changes
}
```

### 2.3 Parity gap semantics

The `gaps` field is pre-computed by P2. C07 never derives gap algebra on the client — it only reads `gaps` and `hasAnyGap`. Gap kinds are ordered below by operational frequency:

| Gap kind | Typical reading | Frequency in seed data |
|---|---|---|
| `prod_on_cloud_off` | Flag fully rolled out commercially; sovereign deployment not started | Dominant — ~13 flags × all 7 sovereigns in seed |
| `prod_on_cloud_cond` | Fully on commercially; sovereign is conditionally gated | Less common — sovereign may have region-specific Requires |
| `prod_on_cloud_target` | Fully on commercially; targeted in sovereign | Rare |
| `prod_cond_cloud_off` | Conditional in prod; sovereign absent — sovereign not even started gating | Occasional |
| `prod_target_cloud_off` | Targeted in prod; sovereign absent | Rare |
| `cloud_on_prod_off` | Sovereign on, prod off — unusual; sovereign-specific or forward-deployed | Very rare; surface prominently when seen |
| `cloud_on_prod_cond` | Sovereign ahead of commercial conditional | Very rare |
| `cloud_cond_prod_off` | Sovereign gating without commercial prod basis | Rare |

> **Neutral observation principle (non-negotiable):** C07 does NOT use red/danger color for gaps. Gaps are factual observations about deployment state — not compliance violations. The FM pipeline is the compliance enforcement layer; C07 is read-only intelligence. Color guidance for P4: amber for "pending rollout" indicators; purple for "sovereign ahead"; muted neutrals for everything else. **Never red for missing-in-sovereign.**

### 2.4 Explicit exclusions from P2

C07 does not need and P2 must not include in this endpoint:

- Runtime evaluation counts or SDK check frequency (no telemetry source).
- Prerequisite flag resolution — that belongs to C06 Inert-Flag Detection (⑦).
- The `onebox`, `test`, `cst`, `daily`, `dxt`, `msit` environments — mainline ladder data; C01 owns those.
- The `bleu` environment — not in the 7-cloud sovereign set per `sovereignEnvs` in seed data.
- Any write token, approval state, or action endpoint.

---

## 3. Layout & Interaction Model

### 3.1 Top-level structure

C07 renders as a full-page view within the Control Tower navigation:

- **Nav entry:** "Sovereign Lens" in the Control Tower sidebar
- **Direct URL:** `/sovereign` (filter state URL-encoded — see OQ-3)
- **Cmd-K palette:** "Open Sovereign Lens" · "Sovereign compliance lens"
- **Cross-link:** Flag Dossier (C02) can deep-link to C07 pre-filtered to a single flag via `?flagId=<id>`

The page contains two vertical zones:

```
┌──────────────────────────────────────────────────────────────────┐
│  Zone A — Cloud Summary Bar (7 cards in a horizontal flex row)   │
│  [mc card] [gcc card] [gcchigh card] [dod card] ...              │
├──────────────────────────────────────────────────────────────────┤
│  Zone B — Sovereign Matrix                                       │
│  Toolbar: [search] [gap filter] [cloud filter]  [Refresh] [age]  │
│  ─────────────────────────────────────────────────────────────── │
│  Header: Flag Name │ Prod ▸ │ mc │ gcc │ gcchigh │ dod │ ...     │
│          (sticky)    (ref)                                       │
│  ─────────────────────────────────────────────────────────────── │
│  Flag rows (42, filtered by toolbar)                             │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Zone A — Cloud Summary Bar

Seven equal-width cards in a horizontal flex row (wraps to 2 rows on narrow viewports). Each card:

```
┌───────────────────────┐
│  Mooncake             │
│  ───────────────────  │
│  ● 0   enabled        │
│  ◑ 0   conditional    │
│  ◎ 0   targeted       │
│  ───────────────────  │
│  13 prod gaps         │
└───────────────────────┘
```

Fields map directly to `SovereignCloudSummary`:
- **enabled** = `onCount`
- **conditional** = `condCount`
- **targeted** = `targetCount`
- **prod gaps** = `gapCount`

Interactivity:
- Click a card → highlight that cloud's column in the matrix (accent left-border on the column header) and scroll Zone B to the first non-off row for that cloud.
- Clicking an already-active card deselects it (returns to all-clouds view).
- The active card receives `--accent` border. No card is active by default.

Cards intentionally do NOT express "good vs bad" posture — the gap count is a neutral count, not a red alert. A cloud with 0 enabled and 13 gaps is not labeled "non-compliant"; it simply shows the current state.

### 3.3 Zone B — Sovereign Matrix

#### Toolbar

Three controls left-to-right, then a spacer, then Refresh and sync-age indicator:

| Control | Type | Default | Behavior |
|---|---|---|---|
| Search | Text input | empty | Filters flag rows by `flagId` substring; case-insensitive; debounced 150 ms; cleared by Escape |
| Gap filter | Segmented control | `Gaps only` | `All` · `Gaps only` · `Prod on, cloud off` · `Cloud ahead of prod` |
| Cloud filter | Multi-select dropdown | `All clouds` | Select 1–7 clouds to hide unselected columns; when all are hidden it resets to `All clouds` |
| Refresh | Button | — | Re-triggers P2 FM fetch; transitions Zone B to loading skeleton; updates sync-age label on success |
| Sync age | Read-only text | — | "Synced 2 min ago" (relative); amber prefix "⚠" when `stale: true` |

**Default view** is **Gaps only** with all 7 clouds visible. This surfaces the most actionable signal immediately — the flags where commercial prod is deployed but one or more sovereign clouds are not.

#### Matrix columns

| Col | Label | Sticky | Notes |
|---|---|---|---|
| 1 | Flag Name | Sticky left | Truncate at 36 chars; full name in `title` attribute and accessible name |
| 2 | Prod ▸ | Not sticky | Commercial prod state — the parity reference; always visible; labeled "Prod ▸" in header to signal reference role |
| 3 | mc | — | Mooncake |
| 4 | gcc | — | GCC |
| 5 | gcchigh | — | GCC-High |
| 6 | dod | — | DoD |
| 7 | usnat | — | USNat |
| 8 | ussec | — | USSec |
| 9 | usgovcanary | — | USGovCanary |

Each sovereign column header has a two-line layout:
- Line 1: cloud label (e.g. "GCC")
- Line 2 (secondary, `--text-3`, 11px): "N enabled · M gaps"

The matrix horizontally scrolls when all 9 columns exceed viewport width. Flag Name remains sticky-left throughout.

#### Cell rendering

Reuses the **same 4-state glyph vocabulary** established by C01 (main Grid). C07 does not introduce new glyphs — only the parity-gap overlay dot is additive.

| State | Glyph | Token | Semantic |
|---|---|---|---|
| `off` | `–` (en dash) | `--text-3` | Not deployed or explicitly disabled |
| `on` | `●` (filled circle) | `--green` | Fully enabled |
| `cond` | `◑` (left half circle) | `--amber` | Conditionally gated; tooltip with `condition.summary` |
| `target` | `◎` (bullseye) | `--accent` | Targeted at specific tenants/regions; tooltip with `condition.summary` |

**Gap-dot overlay** (visual semantics defined here; precise rendering left to P4):

- When `gaps[cloud]` is `prod_on_cloud_off`, `prod_cond_cloud_off`, or `prod_target_cloud_off` → the `off` sovereign cell carries a small **amber dot** at the upper-right corner: "prod is ahead here, sovereign has not deployed."
- When `gaps[cloud]` is `cloud_on_prod_off` or `cloud_on_prod_cond` → the sovereign cell carries a small **purple dot** at the upper-right corner: "sovereign is ahead of commercial."
- The dot is an overlay; it does not replace the cell's primary glyph. The glyph always reflects the cell's actual state.

> **Deviation from main Grid (C01):** C01 does not include a parity-indicator dot because its 15-column layout makes the cross-env story self-evident by inspection. C07 adds the dot overlay because the explicit purpose is parity comparison — dots make the ~91 expected gaps in the seed dataset scannable without reading every cell.

#### Cell tooltip / popover

Triggered by hover or keyboard focus (`Enter`). Tooltips are non-modal; dismissed by mouse-leave or Escape.

**`cond` or `target` cell:**
```
◑  Conditional — Requires
───────────────────────────
[condition.summary]

▸ Show raw condition
```
The "Show raw condition" toggle expands inline to the pretty-printed `condition.raw` JSON. Collapsed by default (screenshot-safe). When `rawTruncated: true`, the expanded section appends: `... (truncated — view in FM repo ↗)`.

**`off` cell with amber gap dot:**
```
–  Not deployed
───────────────────────────
Prod is on.
Last enabled in prod:
  [actor] · [relative timestamp]
  PR #NNNNNNN ↗
```

**`on` cell in a sovereign cloud:**
```
●  Enabled
───────────────────────────
Last enabled by: [actor]
[relative timestamp] · PR #NNNNNNN ↗
```

When `lastEnabledBy` is absent (P2 could not attribute), the attribution section is omitted entirely — never show a placeholder or "Unknown".

#### Flag parity detail panel (slide-in)

Clicking a **flag name** opens a slide-in panel from the right edge. This is an in-context detail — it does not navigate away from C07 and does not disrupt the matrix scroll position.

Content:
```
FLTArtifactBasedThrottling
[description from FM JSON]

Prod (reference)     ●  Enabled
                     Last enabled by: Ayush Singhal · 2026-02-04
                     PR #1234567 ↗

Sovereign parity:
  Mooncake        –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
  GCC             –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
  GCC-High        –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
  DoD             –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
  USNat           –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
  USSec           –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
  USGovCanary     –  Not deployed   [gap: prod ahead · prod_on_cloud_off]
```

For sovereign rows with `cond` or `target` state, the condition summary is shown inline with a "▸ Show raw" toggle (same gated-reveal pattern as the cell tooltip).

The panel has a single close action (✕ button top-right or Escape). **No write actions anywhere in the panel.** No "Force ON", no "Create PR", no approval button.

### 3.4 "Nothing to show" state (full parity)

When gap filter is `Gaps only` (default) and `flags.every(f => !f.hasAnyGap)`, Zone B renders an empty state:

```
◆  All sovereign clouds are at parity with commercial prod.
   42 flags · 7 clouds · 0 gaps

   [View full matrix →]
```

"View full matrix" switches the gap filter to `All`, revealing all 42 rows in the full 42×7 matrix. This is the only action in this state.

### 3.5 Refresh and data freshness

C07 does not auto-refresh on a timer. The toolbar shows a persistent "Synced [relative time]" label derived from `fetchedAt`. When `stale: true`, the label gains an amber `⚠` prefix (see §4 for the stale sub-state).

C07 and C01 (the main Grid) share the same FM repo cache. A Refresh in C07 refreshes C01's underlying data and vice versa. The `sourceCommitId` field lets both views detect whether they are showing the same cache generation.

---

## 4. State Machine

| State | Entry condition | Zone A | Zone B | Toolbar |
|---|---|---|---|---|
| `loading` | Component mounted; `/api/ct/sovereign-lens` in flight | 7 cards with shimmer placeholder counts | 42 shimmer skeleton rows; columns present but cells shimmer | Search + filters disabled; Refresh disabled; sync-age shows `–` |
| `populated` | API success; `!stale`; `flags.length > 0` | 7 summary cards with live counts | Full matrix; gap filter defaults `Gaps only`; rows filtered accordingly | All controls enabled; Refresh enabled; sync-age shows relative time |
| `stale` | API success; `stale: true` | Same as `populated` | Same as `populated` | Amber "⚠ Synced [time] — data may be outdated · Refresh" prepended to sync-age label |
| `full-parity` | API success; `flags.every(f => !f.hasAnyGap)` AND gap filter is `Gaps only` | 7 summary cards populated | Empty state message (§3.4); no rows | All controls enabled; gap filter shows `Gaps only` (user can switch to `All`) |
| `error` | API error or network failure with no cached response | Replaced by error card | Replaced by error card | Refresh is the primary CTA |

`stale` is a **modifier on `populated`**, not a separate branch: the matrix is fully functional; only the sync-age label changes. There is no separate stale state in the state transitions table.

State transitions:

```
         mount
           │
           ▼
       [loading] ──── API error, no cache available ────► [error]
           │                                                  │
           │  API success                                     │  Refresh
           │                                                  ▼
           ├──── stale: false, hasAnyGap ──────────────► [populated]
           │                                                  │
           ├──── stale: true  ──────────────────────────► [stale]
           │       (modifier on populated rendering)          │  Refresh
           │                                                  ▼
           └──── stale: false, !hasAnyGap                 [loading]
                 AND gap filter = Gaps only
                       │
                       ▼
                 [full-parity]
                       │
                       │  gap filter → All
                       ▼
                 [populated]
```

Refresh (any button click in any state that triggers a new fetch) always transitions to `loading` first.

---

## 5. Scenarios

| ID | Scenario | Data condition | Expected behavior | Priority |
|---|---|---|---|---|
| C07-S01 | Flag fully on in prod, absent from all 7 sovereigns (e.g. `FLTArtifactBasedThrottling` per seed) | `prodState='on'`, all `sovereigns[*].state='off'`, all `gaps[*]='prod_on_cloud_off'` | Row visible in default `Gaps only` view; each sovereign cell shows `–` with amber gap dot; cloud summary bar: all 7 clouds show 0 enabled, 1 added to their `gapCount`; slide-in detail shows 7 gap lines each noting "prod ahead" | High |
| C07-S02 | Partial sovereign deployment — flag on in one sovereign, off in the rest | `sovereigns.mc.state='on'`, remaining `'off'` with `prod_on_cloud_off` gap | mc cell shows `●` (no amber dot — no gap); remaining cells show `–` with amber dot; row visible in `Gaps only` view; mc summary card shows 1 enabled | High |
| C07-S03 | Conditional in sovereign (Requires) — e.g. flag gated by a region predicate in DoD | `sovereigns.dod.state='conditional'`, `gaps.dod='prod_on_cloud_cond'`, prod `'on'` | DoD cell shows `◑`; amber dot present (gap kind `prod_on_cloud_cond`); cell tooltip shows `condition.summary`; "▸ Show raw condition" reveals Requires array; slide-in detail shows condition summary for DoD row | High |
| C07-S04 | Targeted in sovereign (Targets) — flag targeting specific GCC tenants | `sovereigns.gcc.state='targeted'`, `gaps.gcc='prod_on_cloud_target'`, prod `'on'` | GCC cell shows `◎`; amber dot; tooltip shows "N tenant groups · M tenants"; gated reveal shows raw Targets block; gap classified as `prod_on_cloud_target` | High |
| C07-S05 | Sovereign-only flag — on in USNat but off in prod (unusual direction) | `sovereigns.usnat.state='on'`, `prodState='off'`, `gaps.usnat='cloud_on_prod_off'` | Row hidden in default `Gaps only` view (which targets prod-ahead gaps); visible in `All` and `Cloud ahead of prod` filter views; USNat cell shows `●` with purple dot; prod cell shows `–`; slide-in notes "Sovereign ahead of prod" | Medium |
| C07-S06 | Full parity — all prod-on flags also on in all sovereigns | `flags.every(f => !f.hasAnyGap)` with gap filter `Gaps only` | Transitions to `full-parity` state; empty state message rendered; Zone A still shows accurate cloud summaries; "View full matrix" link switches gap filter to `All` | Medium |
| C07-S07 | Flag conditional in commercial prod, absent in all sovereigns | `prodState='conditional'`, all `sovereigns[*].state='off'`, gaps `'prod_cond_cloud_off'` | Row visible in `Gaps only` view; prod cell shows `◑` with condition tooltip; sovereign cells show `–` with amber dot; gap label in slide-in reads "Conditional in prod — not in sovereign" | High |
| C07-S08 | Targeted in prod, absent in all sovereigns | `prodState='targeted'`, all sovereign `'off'`, gaps `'prod_target_cloud_off'` | Row visible in `Gaps only`; prod cell shows `◎` with condition tooltip; sovereign cells show `–` with amber dot | Medium |
| C07-S09 | Stale cache served | API response `stale: true` | Transitions to `stale` sub-state; amber "⚠" prefix in toolbar sync-age; matrix fully functional; Refresh CTA prominent | Medium |
| C07-S10 | User clicks a cloud summary card | User interaction in Zone A | Clicked cloud's column highlighted in Zone B (accent border on column header); matrix scrolls to first non-`off` row for that cloud; cloud filter chip updated | Medium |
| C07-S11 | Flag description empty | `description === ''` | Flag name only rendered in the row (no sub-line); slide-in detail shows "No description available" in muted text; no placeholder invented | Low |
| C07-S12 | Raw condition block truncated | `conditionDetail.rawTruncated = true` | "▸ Show raw condition" expand shows the truncated block followed by "... (truncated — view in FM repo ↗)"; link opens the FM repo item page for the flag file | Low |
| C07-S13 | Single flag deep-link (`?flagId=FLTArtifactBasedThrottling`) | URL param present | C07 loads with search pre-filled to `FLTArtifactBasedThrottling` AND slide-in panel auto-opens for that flag; gap filter defaults to `All` (single-flag view has no filtering value) | Low |

---

## 6. Keyboard & Accessibility

The matrix uses **roving focus** (same model as C01 main Grid):

| Key | Action |
|---|---|
| `Arrow Up / Down` | Move row focus within the matrix |
| `Arrow Left / Right` | Move between column cells when a row has focus |
| `Enter` | Open slide-in parity detail for the focused flag row |
| `Escape` | Close slide-in panel (if open) → then clear search (if non-empty) → then return focus to toolbar |
| `/` | Jump focus to the search input |
| `Tab` | Move through toolbar controls (search → gap filter → cloud filter → Refresh), then into the matrix |

**Grid cells:** `role="gridcell"` with `aria-label` encoding flag name, cloud name, state, and gap status:
- `"FLTArtifactBasedThrottling, Mooncake, not deployed, gap: prod is on"`
- `"FLTParallelNodeLimit10, DoD, conditional, requires UK South region, gap: prod fully on"`
- `"FLTSkipShortcutExecution, GCC, not deployed, no gap"` (when prod is also off)

**Cloud summary cards:** `role="button"` with `aria-pressed` (true when column is highlighted). Accessible name encodes cloud label and gap count: `"Mooncake: 0 enabled, 13 prod gaps. Click to highlight column."` The `aria-pressed` attribute is `false` by default.

**Slide-in panel:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the flag name heading. Focus moves into the panel on open (first interactive element or the close button). Escape returns focus to the triggering flag-name cell.

**Gap dot overlay:** The visual dot is `aria-hidden="true"`. The gap information is embedded in the parent cell's `aria-label` (see above) — it is not a duplicate; the dot has no accessible role of its own.

**"Show raw condition" toggle:** `role="button"`, `aria-expanded` reflects open/closed state.

**Stale banner:** `role="status"` (polite) so screen readers announce it without interrupting the current task.

---

## 7. Error Handling

| Error | UI behavior | P2 backend requirement |
|---|---|---|
| ADO REST fetch failure (network or 5xx), no cache available | Transitions to `error` state; error card replaces both zones; message: "Could not load sovereign data — FeatureManagement repo unreachable."; Refresh is the sole CTA | Must return structured error distinguishing "no cache" from "stale cache available" |
| Degraded cache (ADO unreachable but stale cache on hand) | Transitions to `stale` sub-state; amber banner in toolbar; matrix rendered from cache with `error` field shown below banner as secondary text (e.g. "ADO rate-limited — last successful fetch 4h ago") | `stale: true` + `error` field in response body; HTTP 200 (not 5xx — data is available) |
| ADO 401 / session token expired | Error card: "Session expired — reload the page to re-authenticate."; no Refresh button (reload required because token refresh is server-side) | Surface as HTTP 401 on the route; C07 detects 401 and shows the reload message |
| Zero flags returned (`flags.length === 0`) | Error card: "No FLT flags found — FM repo may be misconfigured or the FLT filter produced no results."; distinct from `full-parity` | P2 must never return zero flags under normal conditions; treat as a data-integrity alert |
| `rawTruncated: true` | "▸ Show raw" expand shows truncated block + "... (truncated — view in FM repo ↗)" | Set flag when raw block ≥ 4 KB; include all bytes up to the limit |
| `lastEnabledBy` absent for an on/conditional/targeted cell | Attribution section omitted silently from tooltip and slide-in | P2 must not fabricate attribution; absent is correct when P2 cannot determine the semantic-change commit |

---

## 8. Performance

**Dataset size:** 42 flags × 7 sovereign columns = 294 cells. No virtualization required; a 294-cell table renders within a single paint frame.

**Server-side pre-computation (P2 requirement):** `gaps`, `hasAnyGap`, and `cloudSummaries` are pre-computed by P2 and included in the response. C07 does not perform gap algebra on the client. This is a hard requirement: the client must not derive business logic from raw state comparisons.

**Client-side filtering:** Gap filter, cloud filter, and search are applied client-side to the 42-row array. No round-trips for filter changes. Search is debounced at 150 ms.

**Response payload estimate:** 42 flags × (2 cell states + optional condition + optional attribution) ≈ ~50–80 KB uncompressed. Acceptable for a portal product on a managed network; gzip brings it to ~10–15 KB.

**Shared cache:** C07 and C01 share the P2 FM repo cache. A Refresh from either view refreshes both. P2 must expose `sourceCommitId` so both components can detect cache-generation alignment without re-fetching.

**Slide-in panel:** Opens immediately from already-loaded `SovereignFlagRow` data. No secondary fetch required for the initial panel render (condition detail and attribution are in the primary response — see OQ-2 for the attribution on-demand alternative).

---

## 9. Implementation Notes

**Frontend module (Control Tower web app — Vercel/Next.js):**

- `sovereign-lens.js` owns Zone A card rendering, Zone B matrix rendering, gap-filter logic, cloud-filter column hiding, search, slide-in panel lifecycle, gap-dot overlay, and all state transitions.
- Reuses cell-state glyph helpers from `grid-cells.js` (shared with C01). The gap-dot overlay is an additive helper in `sovereign-lens.js`; it does not modify `grid-cells.js`.
- No `override-strip.js` equivalent — read-only; no override state anywhere.

**URL filter state:** `gapFilter`, `cloudFilter[]`, and `search` are URL query-string parameters so the view is deep-linkable and shareable (P0.3 Idea #5, adopted by CEO ruling). Exact encoding scheme deferred to P2/P4 coordination (OQ-3).

**No write path, anywhere.** The slide-in detail panel has no toggle, no Force-ON, no "Create PR" button, no approval action. The only interactive elements in the panel beyond navigation are the "▸ Show raw condition" collapse/expand and the ✕ close button.

---

## 10. Open Questions for P2

| ID | Question | Impact | Priority |
|---|---|---|---|
| OQ-1 | **Dedicated endpoint vs shared endpoint.** Should `/api/ct/sovereign-lens` be a dedicated route, or should C07 consume the same all-environments `/api/ct/flags` endpoint and filter client-side? Dedicated route allows P2 to pre-compute `gaps` and `cloudSummaries` server-side and return only 7-cloud data. Shared endpoint avoids a second cache path but forces gap algebra onto the client (violates the pre-computation requirement in §8). **Recommend: dedicated endpoint.** | P2 implementation scope; data contract shape | HIGH |
| OQ-2 | **Attribution in bulk vs on-demand.** Should `lastEnabledBy` and `lastChangedBy` be included in the bulk response for all 294 cells, or fetched on-demand when the slide-in panel opens? Bulk attribution requires P2 to traverse per-file commit history for all 42 FLT files (294 semantic-diff lookups); on-demand defers cost until the user opens a panel. Bulk is simpler for the client; on-demand is kinder to ADO. **Recommend: include for cells with state ∈ {on, conditional, targeted} only; omit for off cells (no "last enabled" to show).** This covers ~13 prod-on flags × 7 = 91 cells, most of which are off in sovereigns — so attribution is sparse in practice. | Response latency; ADO rate-limit impact | HIGH |
| OQ-3 | **URL-encoded filter state schema.** C07 needs `gapFilter`, `cloudFilter[]`, and `search` in the URL for deep-linking (P0.3 Idea #5). P2 and P4 must agree on the exact query-string encoding (e.g. `?gap=gaps-only&cloud=mc,gcc&q=FLTArtifact`). Decide in P2 architecture.md. | Deep-link UX; Cmd-K palette integration | MEDIUM |
| OQ-4 | **Cache TTL for sovereign data.** Sovereign flag state changes far less frequently than mainline ladder state (sovereign approvals require separate compliance review). A longer TTL (e.g. 4–6 hours vs the nightly default) may be appropriate. Or should C07 always share the exact same cache generation as C01? | Data freshness; ADO API call budget | MEDIUM |
| OQ-5 | **`bleu` exclusion confirmation.** The `sovereignEnvs` array in the seed data explicitly excludes `bleu`. This spec treats `bleu` as not a sovereign cloud. P2 should confirm this is intentional (not an oversight in the seed) before implementing the endpoint. If `bleu` is reclassified, C07 scope expands to 8 columns. | Scope | MEDIUM |
| OQ-6 | **Raw condition block size cap.** The spec uses 4 KB as the `rawTruncated` threshold. Sovereign `Requires` blocks are typically small (a few predicates); the truncation case may be theoretical. P2 should confirm whether any real FLT sovereign condition exceeds 4 KB and adjust or remove the cap accordingly. | Payload size; edge-case UX | LOW |
| OQ-7 | **Gap urgency ordering for P4.** Should `prod_on_cloud_off` (the dominant gap kind) be visually distinguished from `prod_on_cloud_cond` / `prod_on_cloud_target`? The latter two represent partial-but-active sovereign deployment. A two-level urgency scale (amber-solid for "not started" vs amber-ring for "in progress") may improve scannability. This is a P4 visual decision; C07 exposes the `GapKind` discriminant to support it. | P4 visual design | LOW |
