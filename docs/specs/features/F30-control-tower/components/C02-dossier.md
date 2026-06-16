# C02 — Flag Dossier: Component Deep Spec

> **Component:** Flag Dossier (single-flag deep view)
> **Feature:** F30 — Control Tower
> **Owner:** Sana (architecture + data contract), Vex (ADO REST engine — P2 owns delivery; this spec declares the contract), Pixel (JS/CSS — P4)
> **Complexity:** HIGH — richest single-surface in Control Tower
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Problem / Role](#1-problem--role)
2. [Data Contract](#2-data-contract)
3. [Layout & Interaction Model](#3-layout--interaction-model)
4. [State Matrix](#4-state-matrix)
5. [Open Questions for P2](#5-open-questions-for-p2)

---

## 1. Problem / Role

The Control Tower Grid (C01) answers "where is every FLT flag across all 15 environments?" in a single 42×15 matrix. That gives breadth. The Flag Dossier gives depth: one flag, all environments decoded, full change history reconstructed from git, and every signal the platform can derive without runtime telemetry.

Without the Dossier, a PM who sees `FLTArtifactBasedThrottling` lit green in prod still cannot answer:

| Question | Today (before Control Tower) | With the Dossier |
|---|---|---|
| What exactly does this flag do? | Read raw JSON in a 13K-file repo | Description prose + FeatureNames.cs fallback, header zone |
| In prod, is it fully on or conditional on a region/tenant? | Decode `Requires`/`Targets` block by hand | Decoded predicate chips in the overview table |
| Who enabled it in bleu, when, and which PR? | `git log --follow` + PR search | Per-env timeline entry: author · date · "Merged PR NNNN ↗" |
| Did prod go through a targeted phase before full rollout? | Tedious commit archaeology | Two timeline entries: `– → ◆` then `◆ → ●` |
| Is this flag doing anything in prod if its prerequisite is off? | Manual cross-check across two flag files | Inert signal banner, cross-ref C06 |

The Dossier is **strictly read-only**. It has no toggles, no write paths, and no override affordances of any kind. These flags gate production across sovereign clouds; a write surface is a hard no (spec.md locked constraints). Its entire data supply flows from the `FeatureManagement` git repo via ADO REST API, reconstructed server-side. The browser never touches ADO; it renders what the server delivers.

---

## 2. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

This section declares WHAT the Dossier component receives. P2 (`architecture.md`) owns the engine that produces this payload — the ADO REST commit-walk, semantic env diffing, PR-number extraction, prerequisite parsing, and stale-reason classification. This spec defines only the shape the frontend depends on and the API surface boundary.

### 2.1 Type vocabulary

```typescript
/**
 * All 15 environments in ladder + sovereign order (P0.2 §"15 environments").
 * Ladder (promotion spine): test → cst → daily → dxt → msit → prod
 * Other: onebox (pre-ladder dev), bleu (non-sovereign regional)
 * Sovereign clouds: mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary
 */
type EnvKey =
  | 'onebox' | 'test'   | 'cst'     | 'daily' | 'dxt' | 'msit' | 'prod'
  | 'mc'     | 'gcc'    | 'gcchigh' | 'dod'   | 'usnat' | 'ussec' | 'bleu' | 'usgovcanary';

/**
 * The 4 FM env-block shapes (P0.2 §"4 env-state shapes").
 * 'off'         = empty {} or key absent.
 * 'on'          = { "Enabled": true }
 * 'conditional' = { "Requires": [...] }  — AND-predicate list
 * 'targeted'    = { "Targets": {...} }   — OR-allowlist of tenant/region/workspace entries
 */
type EnvStateShape = 'off' | 'on' | 'conditional' | 'targeted';
```

### 2.2 EnvSnapshot — decoded current state per environment

```typescript
/**
 * One (flag, env) intersection, fully decoded from the FM JSON.
 * `shape` drives the glyph in Zone C.
 * `requires` is present only when shape === 'conditional'.
 * `targets`  is present only when shape === 'targeted'.
 */
interface RequiresEntry {
  /** FM rule-kind name, e.g. "PowerBI.RegionName", "PowerBI.NotMemberOf". */
  name: string;
  /**
   * Predicate values; may be absent for zero-argument rules.
   * Server truncates to 20 items to keep the payload bounded.
   */
  values?: string[];
  /** Full count in the FM payload (values may be truncated server-side). */
  valuesCount: number;
}

interface TargetsEntry {
  /** Pivot kind, e.g. "RegionName", "TenantObjectId", "WorkspaceObjectId",
   *  "CapacityObjectId", "MemberOf". */
  pivot: string;
  /** Preview values, truncated to 20 server-side. */
  values: string[];
  /** Full count of values in the FM payload. */
  valuesCount: number;
}

interface EnvSnapshot {
  shape: EnvStateShape;
  /** All 15 envs always present in DossierPayload.currentState;
   *  shape 'off' is used for absent FM keys. */
  requires?: RequiresEntry[];  // iff shape === 'conditional'
  targets?: TargetsEntry[];    // iff shape === 'targeted'
}
```

### 2.3 TimelineEntry — one reconstructed change event

```typescript
/**
 * A single semantic state change for one env, derived by diffing consecutive
 * commit-snapshots of the FM file's Environments block (P0.2 §"Per-env change
 * attribution, reformat-proof"). One TimelineEntry per (env, commit) that
 * shows a change; whitespace-only or reorder commits produce no entry.
 *
 * Multiple envs may change in the same commit (e.g. cst+daily in one PR).
 * Each produces a separate TimelineEntry sharing the same commitId.
 */
interface TimelineEntry {
  /** Immutable ADO commit SHA. Permanently cacheable (P0.2 §"commitId cache"). */
  commitId: string;
  env: EnvKey;
  prevState: EnvStateShape;
  nextState: EnvStateShape;
  /**
   * Display name of the commit author (from ADO commit metadata).
   * UI label:
   *   "Last enabled by {author}"  — when nextState transitions INTO on/conditional/targeted
   *   "Last modified by {author}" — for any other transition (e.g. targeted→on, cond→on)
   * NEVER labeled "Owner" or "Maintainer" — no such field exists in FM (P0.2, P0.3).
   */
  author: string;
  /** ISO-8601 date string (date component; time is not surfaced). */
  date: string;
  /**
   * PR number from "Merged PR NNNNNNN" in the merge-commit message.
   * Null if commit predates the PR convention or was a direct push.
   */
  prNumber: number | null;
  /**
   * Deep-link to the ADO PR. Constructed as:
   * https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/{prNumber}
   * Present iff prNumber is non-null.
   */
  prUrl: string | null;
  /**
   * Full Environments-block diff for this commit (P0.3 adopted idea #3).
   * LAZY — not included in the initial DossierPayload; fetched on-demand when
   * the user expands a timeline entry via GET …/timeline/{commitId}/diff.
   * May be inlined by P2 for flags with small histories, but the Dossier
   * component must handle the absent case and issue the lazy fetch.
   */
  envsDiff?: EnvsDiff;
}

interface EnvsDiff {
  /** The full Environments block from the parent commit (before). */
  before: Record<string, unknown>;
  /** The full Environments block from this commit (after). */
  after: Record<string, unknown>;
}
```

### 2.4 FileCreatorAttribution

```typescript
/**
 * Who created the FM JSON file.
 * Derived from the first (oldest) commit in the ADO path-history for this file —
 * the git equivalent of --diff-filter=A (P0.2 §"File creator").
 * This is the creation event; it may or may not correspond to any env going 'on'.
 * Null only if history is structurally unavailable (should not occur in normal operation).
 */
interface FileCreatorAttribution {
  author: string;
  date: string;      // ISO-8601 date string
  commitId: string;
  prNumber: number | null;
  prUrl: string | null;
}
```

### 2.5 Inert signal

```typescript
/**
 * Present when the description prose declares a prerequisite flag AND that
 * prerequisite is off or unverifiable in at least one env where this flag
 * is on/conditional/targeted.
 *
 * This signal cross-references C06 (Inert-flag detection hero surface).
 * P0.2 §"Inert-flag detection": prerequisite flags may be outside FLT-42
 * (e.g. EnableFMVServiceAPIThrottling). In that case prerequisiteState
 * is 'unknown' and the assertion is softened to "cannot verify" — never
 * to a false-positive "inert" claim.
 *
 * Parsing strategy for the prerequisite ID (prose → flag name) is a P2
 * architecture decision. This spec only requires the parsed result.
 */
interface InertSignal {
  /** Prerequisite flag ID parsed from the description, e.g. "EnableFMVServiceAPIThrottling". */
  prerequisiteId: string;
  /** Envs where this flag is active but the prerequisite is off or unverifiable. */
  affectedEnvs: Array<{
    env: EnvKey;
    /**
     * 'off'     — prerequisite is definitively off in this env (it IS in FLT-42).
     * 'unknown' — prerequisite is outside FLT-42; state cannot be determined.
     */
    prerequisiteState: 'off' | 'unknown';
  }>;
}
```

### 2.6 Stale signal

```typescript
/**
 * Present when the flag matches a stale-reason classification derived from the
 * Statsig taxonomy (P0.3 adopted idea #1). Derived purely from 42×15 current
 * state + git timestamps — no runtime telemetry.
 *
 * CEO ruling (P0.3): these are NEUTRAL OBSERVATIONS, not prescriptive nudges.
 * The UI presents them as informational text with no "clean me up" CTA (V1).
 * Exact day thresholds are a P2 decision (OQ-06).
 */
type StaleReason =
  | 'PROBABLY_LAUNCHED'
  | 'PROBABLY_DEAD'
  | 'PROBABLY_FORGOTTEN'
  | 'ACTIVE_ROLLOUT'
  | null;  // STABLE — no label shown

// Derivation is canonical in C06 §4.3 — do not redefine.

interface StaleSignal {
  reason: StaleReason;
  /** ISO date of the most recent change across any env. */
  lastChangedAt: string;
  /** Days since lastChangedAt (at time of payload assembly). */
  unchangedDays: number;
}
```

### 2.7 DossierPayload — the full API response shape

```typescript
/**
 * GET /api/ct/flag/{flagId}/dossier
 *
 * All ADO REST calls are server-side. The access token (delegated per-user,
 * P0.2 §"Hosting & auth model") never reaches the browser. The server calls
 * ADO as the signed-in user; every read is audited under the real user identity.
 *
 * Caching contract (P2 to enforce):
 *   - commitId-keyed content: permanent / never expire (immutable).
 *   - Current state snapshot: TTL-based; re-fetched on explicit Refresh.
 *   - On Refresh, P2 only walks commits newer than the last cached commitId
 *     (incremental, not full re-walk).
 */
interface DossierPayload {
  /** FM flag Id, e.g. "FLTArtifactBasedThrottling". */
  flagId: string;

  /**
   * Human-authored description.
   * Primary source: FM JSON `Description` field.
   * Fallback: XML doc-comment from FeatureNames.cs (when FM description is absent or < 20 chars).
   * The source field drives a subtle "Source: FeatureNames.cs" badge in Zone A.
   */
  description: string;
  descriptionSource: 'fm-json' | 'feature-names-cs';

  /** Repo-relative path, e.g. "Features/Configuration/Features/FLTArtifactBasedThrottling.json". */
  fmPath: string;

  /**
   * ADO web URL to view the file, e.g.:
   * https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement?path=Features/…/FLTArtifactBasedThrottling.json&version=GBmaster
   */
  fmWebUrl: string;

  /** Who created the file. Null only on catastrophic history loss. */
  fileCreator: FileCreatorAttribution | null;

  /**
   * Current decoded state for all 15 environments.
   * All 15 EnvKey entries always present; shape 'off' for absent FM keys.
   */
  currentState: Record<EnvKey, EnvSnapshot>;

  /**
   * Full change history across all envs, oldest entry first.
   * Grouped by env in the UI (Zone D accordion) or displayed flat in chronological view.
   * Empty array: flag was created with its initial state and never semantically changed,
   * OR history predates the available ADO commit range.
   */
  timeline: TimelineEntry[];

  /** Null when no prerequisite is detected or all prerequisites are satisfied. */
  inertSignal: InertSignal | null;

  /** Null when the flag does not match any stale-reason criterion. */
  staleSignal: StaleSignal | null;

  /** ISO timestamp of when this payload was assembled. */
  fetchedAt: string;

  /** True if served from cache (commitId cache or TTL cache). */
  fromCache: boolean;

  /** Age of the cache in seconds; null when fromCache is false. */
  cacheAgeSeconds: number | null;
}
```

### 2.8 On-demand diff endpoint

```
GET /api/ct/flag/{flagId}/timeline/{commitId}/diff
→ 200 EnvsDiff  |  404 (commitId not in this flag's history)  |  413 (diff too large)
```

Called lazily when the user expands a timeline entry. Response is permanently cacheable by `commitId` (content is immutable). The 413 path must also return a `fmWebUrl` so the UI can offer a "View raw in repo ↗" fallback. P2 determines max response size (OQ-04 recommends 256 KB hard limit).

---

## 3. Layout & Interaction Model

### 3.1 Entry point and routing

The Dossier is a full-page view within the Control Tower Next.js application.

| Trigger | Behavior |
|---|---|
| Click flag name cell in C01 Grid | Navigate to `/flag/:flagId` |
| Click flag name in C04 Activity Stream | Navigate to `/flag/:flagId` |
| Click flag name in C05 Time Travel snapshot | Navigate to `/flag/:flagId` (date context forwarded as `?asOf=YYYY-MM-DD`; P2 decides whether Dossier uses it) |
| Direct URL `/flag/:flagId` | Deep-link; loads without Grid context |
| Cmd-K palette → select flag | Navigate to `/flag/:flagId` |

**Breadcrumb:** "← Control Tower" always present. When the previous page was the Grid, the crumb text is "← Grid" and navigation restores the Grid's scroll position and active filter state. Pin state and timeline view mode are URL-persisted (§3.5.4, §3.6.3) and survive deep-link share. This implements P0.3 adopted idea #5 (URL-encoded filter state).

### 3.2 Page zones

```
┌──────────────────────────────────────────────────────────────┐
│  [← Control Tower]                    [↺ Refresh]  [Open ↗]  │
│                                                               │
│  Zone A — Header                                              │
│    Flag ID · Description · File creator attribution           │
│                                                               │
│  Zone B — Signals strip  (conditional — absent when clean)   │
│    Inert signal banner(s) · Stale signal banner               │
│                                                               │
│  Zone C — Per-env overview table                              │
│    Pin-env-to-top · State glyph · Decoded Requires/Targets    │
│                                                               │
│  Zone D — Per-env change timeline                             │
│    Grouped-by-env accordion  ↔  Chronological toggle         │
│    Entry: transition · date · attribution · PR link · ▸ diff  │
└──────────────────────────────────────────────────────────────┘
```

Single fluid column, max-width consistent with the Control Tower shell (P4 executes). No sidebar.

### 3.3 Zone A — Header

| Element | Content | Detail |
|---|---|---|
| Page H1 | `flagId` | Monospaced or code-style typeface — this is a machine identifier, not a sentence. E.g. `FLTArtifactBasedThrottling`. |
| Description | `description` prose | Secondary text, `--text-2`. When `descriptionSource === 'feature-names-cs'`, an inline badge `Source: FeatureNames.cs` appears in `--text-3` after the description. |
| File creator line | "Created by {author} · {date}" + "· PR {prNumber} ↗" (if present) | Smallest text size, `--text-3`. PR link opens ADO in new tab. Absent entirely when `fileCreator === null`. |
| Cache/freshness indicator | "Live" or "Data from {N} min ago" | `fromCache ? "Data from {Math.round(cacheAgeSeconds/60)}m ago" : "Live"`. `--text-3`, right-aligned beside Refresh. |
| Refresh | "↺ Refresh" button | Re-fetches live from ADO `master`. Shows spinner during flight. READ-ONLY — no side-effect other than fetching new data. |
| Open in repo | "Open in repo ↗" | Opens `fmWebUrl` in new tab. External-link SVG icon. Right-aligned. |

**No "Owner" field anywhere in this zone.** Attribution is strictly file creator (creation event) and per-change author (timeline). See P0.2 §"'Last enabled by' / timestamps".

### 3.4 Zone B — Signals strip

Present **only** when `inertSignal !== null` OR `staleSignal !== null`. No empty placeholder. No divider line when Zone B is absent.

This is not an alert zone. Both signals are neutral observations (CEO ruling, P0.3). The visual treatment deliberately avoids error-severity colors.

#### 3.4.1 Inert signal

When `inertSignal` is non-null, render one banner. If `affectedEnvs.length > 2`, collapse to "N environments":

```
○  Possibly inert in prod, bleu — prerequisite EnableFMVServiceAPIThrottling
   is off in those environments.  ↗ View all inert flags
```

When `prerequisiteState === 'unknown'` for all affected envs:

```
○  Prerequisite EnableFMVServiceAPIThrottling is outside the FLT-42 scope
   in all active environments — cannot verify whether this flag is effective.
```

- **Icon:** hollow circle `○` (Unicode U+25CB). Communicates "on but status unclear" without alarm.
- **Color:** `--amber` when any affectedEnv has `prerequisiteState === 'off'`; `--text-2` when all are `'unknown'`.
- **"View all inert flags" link:** navigates to C06. Present in both variants.
- **No dismiss.** V1 per CEO ruling.

**Worked example — FLTArtifactBasedThrottling:**
Description states: *"EnableFMVServiceAPIThrottling must be enabled for this feature to take effect."*
→ Parsed prerequisite: `EnableFMVServiceAPIThrottling`
→ Not in FLT-42 → `prerequisiteState: 'unknown'` for all envs where the flag is `on`
→ Banner renders the `'unknown'` variant in `--text-2`.

#### 3.4.2 Stale signal

When `staleSignal` is non-null, render below the inert banner (or alone):

| `staleSignal.reason` | Banner text |
|---|---|
| `PROBABLY_LAUNCHED` | "Enabled across all environments · unchanged {N} days — probably fully launched" |
| `PROBABLY_DEAD` | "Off in all environments · unchanged {N} days — probably abandoned" |
| `PROBABLY_FORGOTTEN` | "Partially rolled out · unchanged {N} days — possibly forgotten" |

- **Color:** `--text-3`. Purely informational; no `--amber`, no `--red`.
- **No CTA.** No "archive", no "clean up" button.

### 3.5 Zone C — Per-env overview table

The single most important interactive zone. One row per environment, showing the decoded current state. READ-ONLY; no state-change affordance of any kind.

#### 3.5.1 Table structure

**Columns:** Env · State · Detail

**Row ordering:**

```
Group 1 — Ladder (mainline promotion spine)
  test · cst · daily · dxt · msit · prod

── thin horizontal divider ──────────────────────

Group 1b — Other (non-ladder, non-sovereign)
  onebox · bleu

── thin horizontal divider ──────────────────────

Group 2 — Sovereign clouds
  mc · gcc · gcchigh · dod · usnat · ussec · usgovcanary
```

Pinned rows always float above the group-1 first row (§3.5.4). The divider moves down to accommodate them; pinned rows from sovereign group retain their origin group label "(sovereign)" in small `--text-3` type.

#### 3.5.2 State column — glyph contract

| `shape` | Glyph (Unicode) | Semantic token | Notes |
|---|---|---|---|
| `off` | `–` (U+2013 en-dash) | `--text-3` | Absent from FM or `{}` block |
| `on` | `●` (U+25CF filled circle) | `--green` | `{"Enabled": true}` |
| `conditional` | `◑` (U+25D1 half-filled circle) | `--accent` | `{"Requires":[…]}` AND-predicate |
| `targeted` | `◆` (U+25C6 black diamond) | `--purple` | `{"Targets":{…}}` OR-allowlist |

These glyphs are the same 4-state vocabulary as the Grid (C01) for visual coherence. P4 may augment with inline SVG if Unicode rendering is inconsistent across OS/browser combinations, but the semantic mapping is locked.

#### 3.5.3 Detail column — Requires/Targets rendering

The Detail column is the Dossier's primary legibility contribution over raw JSON. It decodes the FM predicate payloads into readable inline chips without requiring the reader to understand FM's internal schema.

**`on`:** "Fully enabled" in `--text-3`, or empty (P4 decision on verbosity).

**`off`:** empty.

**`conditional` (Requires):** render each `RequiresEntry` as a chip. Multiple entries are separated by `AND` (matching FM's AND-semantics across the Requires array):

```
RegionName: "UK South", "East US"  (+2 more — Show all)
AND  NotMemberOf: "ExcludeGroup"
```

- Values truncated to 3 inline. "+ N more — Show all" triggers in-place expansion (no modal, no navigation) to reveal up to `valuesCount` values; if `valuesCount > 100`, cap at 100 and show "+ M more (raw in repo ↗)".
- Screenshot-safe by default — 3 values visible without action.
- "Show all" state is per-row, not global. Does not affect URL.

**`targeted` (Targets):** render each `TargetsEntry` as a chip with pivot label:

```
TenantObjectId: {abc…}, {def…}  (+47 more — Show all)
```

- OR-semantics across entries (FM Targets is an allowlist — any match enables).
- Same truncation and "Show all" interaction as Requires.
- For `pivot === 'RegionName'` or `'MemberOf'`: these cannot be evaluated locally. Append a `◌ Cannot evaluate locally` micro-badge in `--text-3` to set expectations (mirrors F11/C03 §12 unevaluable-cell treatment).

#### 3.5.4 Pin-env-to-top (LaunchDarkly pattern, P0.3)

This is a groundbreaking deviation from the design bible, which has no pin-row affordance. It is adopted directly from LaunchDarkly's "Overview across environments" cross-env table.

**Affordance:** a pin icon appears in the **Env column** on row hover (and on keyboard focus). It is subtle — `--text-3` at rest, `--text-2` on hover.

**Behavior:**
- Click/Enter: pins the row to the top of the table. The row gains a pinned indicator (filled pin icon) and floats above all other rows, above the group-1/group-2 divider.
- Multiple rows may be pinned simultaneously. Pinned rows maintain their relative order among themselves (order of pinning).
- Click filled pin / press `p` on focused pinned row: unpins, row returns to natural position.
- "Clear pins" link appears in the table header toolbar when any row is pinned.

**Persistence:**
- Session storage (`controlTower.dossier.{flagId}.pinnedEnvs`) — survives page reload within the session.
- URL query param: `?pinned=prod,bleu` (comma-separated env keys, URL-encoded) — deep-linkable and sharable. Adopted idea #5 (P0.3).

#### 3.5.5 Keyboard and accessibility

- `Tab` enters the table; `Arrow Up`/`Arrow Down` navigate rows; `Arrow Left`/`Arrow Right` move between columns.
- `p` on a focused row: pin/unpin.
- `Enter` on a focused row with `conditional` or `targeted` state: expands "Show all" inline detail.
- `Escape`: collapses any open "Show all"; second Escape exits table focus.
- `aria-label` per row: `"{envLabel} — {shape description}"`. Examples:
  - `"prod — fully enabled"`
  - `"bleu — fully enabled"`
  - `"cst — conditional — 1 predicate"`
  - `"gcc — off"`
- Conditional detail expansion: `aria-expanded` on the trigger; expanded content is adjacent in DOM for screen reader linearity.
- The table is `role="grid"` with `aria-rowcount={15}`. The Env column header is `scope="col"`.

### 3.6 Zone D — Per-env change timeline

The timeline reconstructs the complete state-change history for this flag across all 15 environments. Each `TimelineEntry` represents one semantic env-state transition in one commit.

This data is derived by P2's commit-walk engine: for each pair of consecutive commits in the FM file's path-history, the Environments blocks are semantically diffed (not line-diffed), and each env that changed produces one entry. This approach is reformat-proof (P0.2 §"Per-env change attribution").

#### 3.6.1 Default view: grouped by environment (accordion)

One collapsible section per env that has at least one timeline entry. Envs with zero entries are omitted from the accordion (their current state is already shown in Zone C). Section ordering mirrors Zone C: ladder first, then sovereign.

Section header (collapsed):

```
▸ prod   3 changes
```

Section header (expanded):

```
▾ prod   3 changes
```

All sections default to collapsed. The most-recently-changed env defaults to expanded (P2 determines from `max(timeline.filter(t => t.env).date)`). If the user came from C04 Activity Stream with a specific env highlighted, that env section auto-expands.

#### 3.6.2 Timeline entry anatomy (one row, collapsed)

| Column | Content | Notes |
|---|---|---|
| Transition chip | `{prevGlyph} → {nextGlyph}` | Uses same 4-glyph vocabulary as Zone C; e.g. `– → ●`, `◑ → ●`, `– → ◆`, `◆ → ●` |
| Date | `YYYY-MM-DD` | ISO date; time component not surfaced |
| Attribution | "Last enabled by {author}" or "Last modified by {author}" | "Last enabled by" when `nextState ∈ {on, conditional, targeted}`; "Last modified by" for all other transitions (e.g. `targeted → on`, `conditional → on`). Never "Owner." |
| PR link | "Merged PR {prNumber} ↗" | Opens ADO PR in new tab; absent (shown as `·`) when `prNumber === null` |
| Expand toggle | `▸` / `▾` | Right-most; clicking anywhere on the row also toggles; keyboard: Enter |

#### 3.6.3 Expanded entry — inline diff (P0.3 adopted idea #3)

Clicking/pressing Enter on a timeline entry expands an inline panel directly beneath the entry row:

```
▾ – → ●   2026-02-04   Last enabled by Ayush Singhal   Merged PR 1234567 ↗

   ┌─ Before ──────────────────────────────┐  ┌─ After ───────────────────────────────────┐
   │ "test": {}                             │  │ "test": { "Enabled": true }               │
   └────────────────────────────────────────┘  └───────────────────────────────────────────┘
```

- Side-by-side JSON blocks, syntax-highlighted, read-only, non-editable `<pre>`.
- Lazy-loaded from `GET …/timeline/{commitId}/diff` on first expand. Inline spinner during fetch.
- If `envsDiff` is already present in the `TimelineEntry` (P2 may inline it for small payloads), skip the fetch.
- On 413 (diff too large): show "Diff too large to display inline — [View raw in repo ↗]" linking to `fmWebUrl`.
- On network error: "Could not load diff" with a Retry link.
- Collapse by clicking the row again or pressing Enter on the focused row.

#### 3.6.4 Chronological view (secondary)

A toggle in the Zone D header switches from the grouped accordion to a flat list, oldest entry first (rollout story order). In this view:

- No env-grouping sections; all entries in one flat list.
- Each row prepends the env name as a small label chip before the transition chip: e.g. `test  – → ●  2026-02-04  …`
- Expand-diff behavior is identical to the grouped view.
- View mode URL-persisted: `?timeline=chronological` (default: `grouped`).

#### 3.6.5 Worked example — FLTArtifactBasedThrottling

This is the P2 and P4 gold test case. Source: p0-foundation.md §"Gold sample". Current state per seed data: `on` in onebox, test, cst, daily, dxt, msit, prod, bleu; `off` in all other sovereign clouds.

```
GROUPED VIEW — FLTArtifactBasedThrottling timeline
═══════════════════════════════════════════════════

▸ onebox   (no entries — currently 'on'; no change recorded in path-history)
[not shown in accordion — see OQ-02]

▾ test   1 change
   – → ●   2026-02-04   Last enabled by Ayush Singhal   Merged PR [P2 extracts] ↗

▾ cst    1 change
   ◑ → ●   2026-02-12   Last modified by [P2 extracts]  Merged PR [P2 extracts] ↗
   [NOTE: an earlier commit set cst to ◑ — that entry must also appear; see OQ-03]

▾ daily  1 change
   – → ●   2026-02-12   Last enabled by [P2 extracts]   Merged PR [P2 extracts] ↗

▾ dxt    1 change
   – → ●   2026-02-24   Last enabled by [P2 extracts]   Merged PR [P2 extracts] ↗

▾ msit   1 change
   – → ●   2026-03-03   Last enabled by [P2 extracts]   Merged PR [P2 extracts] ↗

▾ prod   2 changes
   – → ◆   2026-03-10   Last enabled by [P2 extracts]   Merged PR [P2 extracts] ↗
   ◆ → ●   2026-03-13   Last modified by [P2 extracts]  Merged PR [P2 extracts] ↗

▾ bleu   1 change
   – → ●   2026-05-05   Last enabled by Jayaprakash Kupparaju   Merged PR [P2 extracts] ↗

[mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary — all currently 'off', no timeline entries]
```

Notes on the gold example:
- Author names confirmed in p0-foundation.md: Ayush Singhal (test, 2026-02-04), Jayaprakash Kupparaju (bleu, 2026-05-05). All others: P2 extracts from ADO commit metadata.
- PR numbers: P2 extracts from "Merged PR NNNNNNN" in commit messages.
- `cst` went `cond → on` on 2026-02-12 per p0-foundation.md. This implies a prior `off → cond` commit for cst that must also appear in the timeline (OQ-03).
- `onebox` is currently `on` in seed data but has no confirmed change in the gold sample. P2 must clarify (OQ-02).
- `prod` had a two-stage rollout: first targeted (2026-03-10), then fully on (2026-03-13) — the clearest illustration of why a per-entry transition chip matters over a simple "when was it enabled" date.

#### 3.6.6 Empty timeline state

When `timeline.length === 0`:

Zone D renders a single message block instead of the accordion:

> "No recorded changes — this flag appears to have been set to its current state at file creation, or its history predates the available ADO commit range."

A Refresh button is offered inline to prompt a re-fetch in case of a cache miss.

#### 3.6.7 READ-ONLY enforcement in Zone D

The timeline is observation-only. No entry has an "undo", "revert", or "re-apply" action. PR links open ADO in a new tab (read); they do not trigger any action within Control Tower.

---

## 4. State Matrix

| State | Entry condition | Zones rendered | User actions | Exits to |
|---|---|---|---|---|
| `loading` | Component mounted; initial `DossierPayload` fetch in flight | All zones: full-page skeleton (header placeholder, 15 skeleton rows in Zone C, accordion skeleton in Zone D) | None (Refresh disabled; breadcrumb active) | `loaded-populated`, `loaded-never-changed`, `error-fetch`, `error-not-found` |
| `loaded-populated` | `timeline.length > 0`; fetch succeeded | All zones fully rendered | Pin envs (Zone C); expand/collapse sections (Zone D); expand diffs (Zone D); toggle grouped/chronological; Refresh; Open in repo; breadcrumb back | `refreshing` (Refresh click); `diff-loading` (diff expand) |
| `loaded-never-changed` | `timeline.length === 0`; flag exists in FM | Zone A, B, C fully rendered; Zone D shows empty-timeline message (§3.6.6) | Pin envs (Zone C); Refresh; Open in repo; breadcrumb back | `refreshing` |
| `refreshing` | Refresh clicked; re-fetch in flight | Current data remains visible; Refresh button shows spinner and is disabled; "Refreshing…" caption next to cache indicator | Breadcrumb back (navigate away mid-refresh) | `loaded-populated`, `loaded-never-changed`, `error-fetch` |
| `error-fetch` | ADO REST call failed (network error, auth expiry, ADO unavailable) | Zone A: flag ID from URL only; full-width error banner: "Could not load flag data — {errorMessage}. Try refreshing or check that your session is active." | Refresh (re-attempt full load); breadcrumb back | `loading` (Refresh click) |
| `error-not-found` | `flagId` from URL is not in FLT-42, or not a valid FM path | Full-page error: "'{flagId}' is not in the FLT-42 scope or does not exist in the FeatureManagement repo." + link back to Grid | Breadcrumb back only | — |
| `diff-loading` | User expanded a timeline entry; `envsDiff` not present; lazy fetch in flight | Entry row shows inline spinner in place of diff panel | Collapse the entry (cancels visual wait; fetch may complete in background and be cached) | `diff-loaded`, `diff-error` |
| `diff-loaded` | `EnvsDiff` successfully fetched | Inline before/after JSON panel rendered beneath the entry | Collapse; scroll; copy raw JSON (P4 decision) | `loaded-populated` (collapse) |
| `diff-error` | Diff lazy fetch failed or 413 too-large | Inline error message; 413 shows "View raw in repo ↗" fallback | Retry (re-issues fetch); collapse | `diff-loading` (retry) or `loaded-populated` (collapse) |

---

## 5. Open Questions for P2

| # | Question | Constraint / boundary |
|---|---|---|
| OQ-01 | **PR number coverage.** What fraction of the FLT-42 flag histories predates the "Merged PR NNNNNNN" commit-message convention? P2 must quantify and handle `prNumber: null` gracefully. | Contract already marks `prNumber` nullable. UI shows `·` (no link) when absent. No degradation. |
| OQ-02 | **onebox history gap.** `FLTArtifactBasedThrottling` is `on` in onebox per seed data but the gold sample documents no onebox change event. Three possibilities: (a) set at file creation (first commit, `--diff-filter=A` equivalent) — timeline should contain an `off → on` entry attributed to the file creator; (b) the path-history API returns no commit touching onebox because it was set at creation and the diff walk misses it; (c) the env was enabled in a batch commit that also touched many other files. P2 must handle all three and ensure creation-time env states produce a `TimelineEntry` rather than silently disappearing. | If the initial commit already sets an env, the first entry in the commit-walk is `{prevState:'off', nextState:envState, commitId:firstCommitId}`. FileCreatorAttribution and this TimelineEntry may share the same commitId. |
| OQ-03 | **cst "cond → on" missing predecessor.** p0-foundation.md records cst as `cond → on` (2026-02-12). This implies a prior `off → cond` commit for cst not mentioned in the gold sample summary. P2 must confirm: (a) that commit exists and the diff walk will find it; (b) that there is no cap on the number of commits returned by the ADO path-history endpoint. | If an implicit count cap exists in the ADO API, P2 must paginate to exhaustion. |
| OQ-04 | **Diff payload size for large Targets flags.** Some `Targets` blocks contain hundreds of tenant GUIDs. The `EnvsDiff` blob may exceed 100 KB. P2 must establish a hard response size limit and return 413 when exceeded, along with `fmWebUrl` so the UI can offer a raw-in-repo fallback. | Recommended hard limit: 256 KB per diff response. The Dossier component handles 413 per §3.6.3. |
| OQ-05 | **Prerequisite flag lookup (inert signal, FLT-in-scope case).** `InertSignal` correctly returns `prerequisiteState: 'unknown'` when the prerequisite is outside FLT-42. But if the prerequisite IS in FLT-42 (a future dependency between two FLT flags), P2 can return `'off'` with confidence. Should the prerequisite state check be bundled into the single `/dossier` response or issued as a second call? | Recommendation: bundle it. The prerequisite flag's current state is a single additional FM JSON read — the same data P2 already fetches per flag. A second round-trip adds latency with no benefit. |
| OQ-06 | **Stale signal thresholds.** `StaleSignal` thresholds (N days for each `StaleReason`) are not yet set. P2 proposes concrete values for team review. | Suggested starting values: `PROBABLY_LAUNCHED` / `PROBABLY_DEAD` = 90 days; `PROBABLY_FORGOTTEN` = 60 days. These are neutral-observation thresholds, not action triggers. Env-configurable via server config if needed. |
| OQ-07 | **Timeline sort order within an env.** The spec says oldest-first within each env section and for the chronological flat list. Confirm with P2 that this is the natural order from the ADO `/commits` path-history endpoint (newest-first from ADO → reversed server-side before returning to frontend). | Also confirm: can a single commit change the same env twice (should be impossible for one-file-per-flag FM structure, but verify)? If impossible, no deduplication needed. |
| OQ-08 | **Deep-link URL parameter shape.** Pin state (`?pinned=prod,bleu`) and timeline view mode (`?timeline=chronological`) must not conflict with the Next.js router or other Control Tower query params (e.g. `?asOf=` from Time Travel). | P2 confirms canonical query param names and encoding rules for the full Next.js router. Proposed: `pinned={env1},{env2}` (comma-joined, URL-encoded), `timeline=grouped|chronological`. |
| OQ-09 | **Timeline zone header vs per-entry attribution label.** "Last enabled by" is used at the entry level (one change event). The zone-level header could optionally surface a summary: "Last change: {date} by {author} in {env}." P2/Pixel decide whether this summary is derived from `timeline[timeline.length-1]` (newest-first after reversal) or computed separately. | If added, it must use `timeline` data — no separate API call. Mark as P4 decision if desired. |
| OQ-10 | **`bleu` classification — RESOLVED.** `bleu` is a non-sovereign regional environment (p0-foundation.md lists 7 sovereign envs: mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary — `bleu` is absent). `bleu` is placed in the "Other" group (between ladder and sovereign), not in the sovereign divider. See data-model.md §2. | Resolved — no further P2 action needed. |
