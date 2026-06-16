# C06 — Inert-Flag Detection: Component Deep Spec

> **Component:** Inert-Flag Detection (Layer 3 — Intelligence, hero component)
> **Feature:** F30 — EDOG Control Tower
> **Owner:** Sana (architecture + dependency model), Vex (extraction engine + data contract), Pixel (visualization + interaction)
> **Complexity:** CRITICAL — headline differentiator; no industry analog
> **Status:** P1 — DRAFT
> **Last Updated:** 2026-06-13

---

## Table of Contents

1. [Problem & Role](#1-problem--role)
2. [Dependency-Extraction Model](#2-dependency-extraction-model)
3. [Inert Evaluation Rules](#3-inert-evaluation-rules)
4. [Stale-Reason Taxonomy & Derivation](#4-stale-reason-taxonomy--derivation)
5. [Data Contract](#5-data-contract)
6. [Layout & Interaction Model](#6-layout--interaction-model)
7. [State Matrix](#7-state-matrix)
8. [Open Questions & Risks for P2](#8-open-questions--risks-for-p2)

---

## 1. Problem & Role

### 1.1 The problem

A feature flag that is `Enabled` in an environment but whose declared prerequisite is OFF in that same environment is **inert** — the code checks the flag, sees "enabled," but the prerequisite gate upstream evaluates false, so the feature does nothing. The flag creates the illusion of rollout with zero actual effect. Today, discovering this requires a human to:

1. Read the flag's `Description` prose and notice the prerequisite clause.
2. Locate the prerequisite flag's JSON file (which may not be FLT-prefixed and thus lives among 13,000+ other flags).
3. Manually check the prerequisite's state in the same environment.
4. Repeat for all 15 environments.
5. Repeat for all 42 FLT flags.

This is 42 × 15 = 630 cells, each requiring cross-file prose reading. Nobody does it.

### 1.2 Role of C06

C06 is the **hero intelligence component** of Control Tower — the feature that elevates the portal from a "read-only FM browser" to an insight engine. It answers a question no other product in the industry answers: *"Which of our flags are on-but-doing-nothing, and why?"*

**What C06 is:**
- A read-only analytical lens that surfaces inert flags as **neutral observations**, not prescriptive cleanup nudges. The UI says "Enabled in prod, but prerequisite EnableFMVServiceAPIThrottling is OFF in prod" — it does not say "clean this up."
- A confidence-aware system that distinguishes high-confidence inert findings (known prerequisite, known state) from low-confidence ones (prerequisite outside the FLT-42, state unknown).

**What C06 is not:**
- A cleanup tool. There is no write path, no "resolve" button, no nudge language. CEO ruling: neutral observations only.
- A runtime evaluator. We derive everything from git-committed JSON + Description prose. We never claim to know runtime evaluation counts.

### 1.3 Prior art & differentiation

| Product | Nearest feature | Gap C06 fills |
|---|---|---|
| LaunchDarkly | Prerequisite flags block archival; UI shows blocking chain | LD only blocks deletion — never surfaces "on-but-doing-nothing" |
| Statsig | Stale-reason labels (PROBABLY_LAUNCHED, etc.) | Statsig relies on SDK evaluation telemetry we don't have |
| Unleash | Age-based staleness (`now - createdAt >= expectedLifetime`) | No prerequisite awareness at all |

C06 combines LaunchDarkly's blocking-chain visualization with Statsig's stale-reason taxonomy, derived entirely from git state — no runtime telemetry.

---

## 2. Dependency-Extraction Model

### 2.1 Source signal: Description prose

Dependencies between flags are declared in the `Description` field of the FM JSON, written as free-form English prose. There is no structured `depends_on` field. This is a parsing problem, not a schema lookup.

**Real examples from the FLT-42 (verified 2026-06-13):**

| Flag | Description excerpt | Extracted prerequisite |
|---|---|---|
| `FLTArtifactBasedThrottling` | "EnableFMVServiceAPIThrottling **must be enabled** for this feature to take effect." | `EnableFMVServiceAPIThrottling` |
| `FLTUserBasedThrottling` | "EnableFMVServiceAPIThrottling **must be enabled** for this feature to take effect." | `EnableFMVServiceAPIThrottling` |
| `FLTInsightsEngine` | "…without requiring **FLTInsightsMetrics**. Allows independent rollout: **FLTInsightsMetrics** ON + FLTInsightsEngine OFF = Delta writes only…" | `FLTInsightsMetrics` (soft/informational — see §2.3) |

**Observation from real data:** Of the 42 FLT flags, exactly **2** declare a hard prerequisite using "must be enabled" phrasing (`FLTArtifactBasedThrottling`, `FLTUserBasedThrottling`), both pointing to the same non-FLT flag (`EnableFMVServiceAPIThrottling`). One flag (`FLTInsightsEngine`) describes an informational relationship with another FLT flag. The remaining 39 flags have no detectable dependency language. **Dependencies are rare but high-value when present.**

### 2.2 Extraction strategy (P2 builds the parser; this section defines requirements)

The extraction model operates at **parse time** (when flag JSON is fetched/cached) and produces a `DependencyEdge[]` per flag. P2 owns the parser implementation; this spec defines what the parser must detect and how confidence is assigned.

#### 2.2.1 Pattern tiers

The parser MUST support the following pattern tiers, ordered by confidence:

| Tier | Pattern family | Regex sketch | Confidence | Example |
|---|---|---|---|---|
| T1 — Hard gate | `<FlagName> must be enabled` | `(\w+)\s+must\s+be\s+enabled` | `high` | "EnableFMVServiceAPIThrottling must be enabled for this feature to take effect." |
| T2 — Prerequisite language | `requires <FlagName>` / `depends on <FlagName>` / `prerequisite: <FlagName>` | `(?:requires|depends\s+on|prerequisite[:\s]+)(\w+)` | `high` | (Not yet observed in FLT-42 but a standard FM convention) |
| T3 — Conditional reference | `when <FlagName> is enabled` / `if <FlagName> is on` / `only works with <FlagName>` | `(?:when|if|only\s+works?\s+with)\s+(\w+)\s+(?:is\s+)?(?:enabled|on|true)` | `medium` | (Not yet observed in FLT-42) |
| T4 — Informational mention | Another known flag name appears in the Description but without gate/prerequisite language | Token overlap with known flag IDs | `low` | "Allows independent rollout: FLTInsightsMetrics ON + FLTInsightsEngine OFF = …" |

**Parser rules:**
1. Apply T1–T3 regex patterns against the full `Description` string (case-insensitive).
2. For T4: tokenize the Description and match against the full set of known flag IDs (all ~13,200 in FM, not just FLT-42). A T4 match is **never** promoted to inert — it is informational only.
3. A single Description can yield multiple edges (multi-prerequisite). Each edge gets its own confidence tier.
4. Self-references (flag mentions itself) are discarded.
5. Flag IDs are case-sensitive for matching but case-insensitive for the surrounding prose patterns.

#### 2.2.2 The "unknown prerequisite" problem

A prerequisite flag extracted from prose may fall into one of three resolution classes:

| Class | Condition | Example | Treatment |
|---|---|---|---|
| **Resolved-FLT** | Prerequisite ID matches a flag in our FLT-42 set | `FLTInsightsMetrics` | Full state known across all 15 envs. Inert evaluation proceeds normally. |
| **Resolved-external** | Prerequisite ID matches a non-FLT flag in the FM repo (we fetch its state) | `EnableFMVServiceAPIThrottling` | State is fetchable via ADO REST (same API, different path). P2 must decide whether to fetch on-demand or pre-cache. See §8 risk R2. |
| **Unresolved** | Prerequisite ID is not found in FM at all, or is ambiguous | (hypothetical) `SomeInternalConfigFlag` | State is **unknown**. Surface the dependency edge but mark the prerequisite state as `unknown`. Never claim inert. |

**Hard rule:** An inert finding REQUIRES the prerequisite's actual state in the target environment. If the prerequisite state is unknown, the finding is downgraded to an **informational observation** ("FLTArtifactBasedThrottling declares a dependency on SomeFlag, whose state is unknown"), never "inert."

### 2.3 Multi-prerequisite chains

A flag may depend on prerequisite A, which itself depends on prerequisite B. This creates a **blocking chain**: `Flag → A → B`. The chain is inert if *any* link in the chain is OFF in the target environment.

**Chain construction rules:**
1. Walk the dependency graph from each FLT flag, following `DependencyEdge` links.
2. Stop at depth 3 (flag → prereq → prereq's prereq). Deeper chains are theoretically possible but never observed in FM and would indicate a misparse. Surface a warning if depth > 3.
3. Cycle detection: if the walk encounters the origin flag, mark the cycle and stop. Surface as a data-quality observation, not an inert finding.
4. Chain confidence = minimum confidence of any edge in the chain. A chain containing a T4 (informational) edge is never marked inert.

### 2.4 The FLTInsightsEngine case (informational vs. gate)

`FLTInsightsEngine`'s Description says: "…without requiring FLTInsightsMetrics. Allows independent rollout…" The word "without requiring" is an **explicit negation** of a dependency — it says the two can roll out independently. The parser must:

1. Detect negation patterns (`without requiring`, `does not depend on`, `independent of`, `no dependency on`).
2. When a negation is detected, emit a T4 edge with `negated: true` and confidence `low`.
3. A negated edge never produces an inert finding. It is rendered as an informational note: "Describes independent rollout from FLTInsightsMetrics."

---

## 3. Inert Evaluation Rules

### 3.1 Per-cell evaluation

For each `(flag, env)` cell in the 42×15 matrix, the inert evaluator runs:

```
function evaluateInert(flag, env, dependencyEdges, resolvedStates):
  if flag.state(env) NOT IN {Enabled, Requires-conditional, Targets-targeted}:
    return NOT_APPLICABLE  // flag is OFF — cannot be inert

  for each edge in dependencyEdges where edge.confidence >= medium:
    prereqState = resolvedStates[edge.prerequisiteId][env]

    if prereqState == UNKNOWN:
      yield INFORMATIONAL(edge, "prerequisite state unknown")
      continue

    if prereqState == OFF:
      yield INERT(edge, confidence=edge.confidence)

    if prereqState IN {Enabled, Requires-conditional, Targets-targeted}:
      // prereq is on — check transitive chain
      recurse into prereq's own edges (depth-limited)

  if no INERT findings:
    return EFFECTIVE
```

### 3.2 Inert classification

| Classification | Condition | UI treatment |
|---|---|---|
| `EFFECTIVE` | Flag is on AND all known prerequisites are on in this env | No annotation. Default state. |
| `INERT` | Flag is on AND at least one high/medium-confidence prerequisite is OFF in this env | Inert badge on the cell; detail in the Inert panel |
| `INERT_CHAIN` | Flag is on AND its prerequisite is on, but the prerequisite's own prerequisite is OFF | Chain badge; full chain shown in blocking-chain view |
| `INFORMATIONAL` | Flag has a dependency edge but prerequisite state is unknown, OR edge confidence is low, OR edge is negated | Subtle informational icon; no inert claim |
| `NOT_APPLICABLE` | Flag is OFF in this env | No annotation |

### 3.3 False-positive avoidance — the credibility contract

Credibility is everything. A single false-positive "inert" claim destroys trust in the entire Intelligence layer. The following rules are non-negotiable:

1. **Never claim inert without the prerequisite's verified state.** If we cannot fetch or resolve the prerequisite, the finding is `INFORMATIONAL`, period.
2. **Never promote T4 (informational mention) to inert.** A flag name appearing in prose without gate language is not a dependency.
3. **Never claim inert for conditional/targeted cells without analyzing the condition.** If a flag is `Requires-conditional` in prod and the prerequisite is also `Requires-conditional` in prod, they may or may not overlap. In this case, downgrade to `INFORMATIONAL` with "both flags are conditional — effective overlap cannot be determined from config alone."
4. **Negation trumps proximity.** "without requiring X" is NOT a dependency on X.
5. **Surface confidence visibly.** Every inert finding shows its source: the exact Description sentence that declared the dependency, the parser tier that matched, and the prerequisite's current state. The user can always audit the reasoning.
6. **Err toward silence.** If the parser is uncertain, emit nothing rather than a low-confidence inert claim. The portal's value comes from the findings it *does* surface being rock-solid.

### 3.4 Worked examples (grounded in real data)

**Example 1 — FLTArtifactBasedThrottling in `dxt`:**
- Flag state in `dxt`: `Enabled` (on).
- Description: "EnableFMVServiceAPIThrottling must be enabled for this feature to take effect."
- Parser: T1 match → `EnableFMVServiceAPIThrottling`, confidence `high`.
- Prerequisite resolution: `EnableFMVServiceAPIThrottling` is a non-FLT flag → `Resolved-external`.
- P2 fetches `EnableFMVServiceAPIThrottling.json` from FM. Suppose env `dxt` shows `{"Enabled": true}`.
- Result: `EFFECTIVE`. No inert finding.
- Suppose instead `dxt` shows `{}` (OFF): Result: `INERT`, confidence `high`. Display: "Enabled in dxt, but prerequisite EnableFMVServiceAPIThrottling is OFF in dxt."

**Example 2 — FLTInsightsEngine in `test`:**
- Flag state in `test`: `Enabled` (on).
- Description: "…without requiring FLTInsightsMetrics…"
- Parser: negation detected → T4 edge, `negated: true`, confidence `low`.
- Result: `NOT_APPLICABLE` for inert (negated). Informational note: "Describes independent rollout from FLTInsightsMetrics."

**Example 3 — Hypothetical chain: FlagC → FlagB → FlagA:**
- FlagC is `Enabled` in `prod`. Description says "FlagB must be enabled."
- FlagB is `Enabled` in `prod`. Description says "FlagA must be enabled."
- FlagA is `OFF` in `prod`.
- Result: `INERT_CHAIN`. Display: "FlagC is enabled in prod, but its dependency chain is broken: FlagC → FlagB (on) → FlagA (OFF)."

---

## 4. Stale-Reason Taxonomy & Derivation

### 4.1 Rationale

CEO ruling (2026-06-13): adopt Statsig-style stale-reason labels as **neutral observations**, not cleanup nudges. These labels answer "what is probably true about this flag's lifecycle phase?" using only the 42×15 state matrix + git commit dates. No runtime telemetry.

### 4.2 Terminology

Labels are **observations**, not recommendations. The UI presents them as factual annotations — "Enabled 15/15, unchanged 247 days" — not as "you should clean this up." The word "stale" is never user-facing; internally these are "lifecycle observations."

### 4.3 Derivation rules

Each label is derived from two inputs:

- **Posture:** the flag's state across all 15 environments (how many on/off/conditional/targeted).
- **Recency:** `daysSinceLastChange` = calendar days since the most recent commit that modified this flag's `Environments` block in any environment. Sourced from git commit history per the P0.2 extraction mechanism.

| Label | Posture condition | Recency condition | Interpretation | Confidence |
|---|---|---|---|---|
| `PROBABLY_LAUNCHED` | `Enabled` in ALL 7 mainline envs (onebox through prod) | `daysSinceLastChange >= 90` | Flag has been fully rolled out across the promotion ladder and untouched for 3+ months. Likely a completed launch that could be hardcoded. | `high` when all 15 envs are on; `medium` when mainline-7 are on but some sovereign envs are off |
| `PROBABLY_DEAD` | `OFF` in ALL 15 envs | `daysSinceLastChange >= 90` | Flag is off everywhere and hasn't been touched in 3+ months. Likely abandoned or superseded. | `high` |
| `PROBABLY_FORGOTTEN` | `Enabled` in >= 1 mainline env AND `OFF` in >= 1 mainline env (partial rollout) | `daysSinceLastChange >= 180` | Flag is mid-rollout but hasn't advanced in 6+ months. Likely stalled or forgotten. | `medium` |
| `ACTIVE_ROLLOUT` | `Enabled` in >= 1 env AND `OFF` in >= 1 mainline env | `daysSinceLastChange < 30` | Recent changes detected — rollout is actively progressing. | `high` |
| `STABLE` | Any posture | `30 <= daysSinceLastChange < 90` | No recent changes but within a normal quiet period. | N/A (no label shown — this is the default/silent state) |

**Derivation priority (first match wins):**
1. If `daysSinceLastChange < 30` AND partial rollout → `ACTIVE_ROLLOUT`
2. If all 15 envs OFF AND `daysSinceLastChange >= 90` → `PROBABLY_DEAD`
3. If all 7 mainline envs `Enabled` AND `daysSinceLastChange >= 90` → `PROBABLY_LAUNCHED`
4. If partial mainline rollout AND `daysSinceLastChange >= 180` → `PROBABLY_FORGOTTEN`
5. Otherwise → `STABLE` (no label; silent)

### 4.4 Edge cases & nuances

| Case | Handling |
|---|---|
| Flag is `Requires-conditional` or `Targets-targeted` in prod | Counts as "enabled" for posture analysis. A flag that is targeted in prod and enabled everywhere else is still `PROBABLY_LAUNCHED` if unchanged 90+ days. |
| Flag is on in all mainline but off in all sovereign | `PROBABLY_LAUNCHED` at `medium` confidence. Sovereign rollout may be intentionally deferred for compliance. Annotation: "Mainline complete; sovereign envs off." |
| Flag has no commit history (edge case: parser failure) | No label. Surface "Lifecycle data unavailable." |
| `daysSinceLastChange` is 0 (changed today) | `ACTIVE_ROLLOUT` if partial; no label if fully on/off (just deployed). |
| Flag description is empty (13 of 42 have non-trivial Descriptions; some are terse) | No impact on stale-reason — these labels use posture + dates only, not Description content. |

### 4.5 Presentation language (neutral, never prescriptive)

| Label | User-facing text | NOT this |
|---|---|---|
| `PROBABLY_LAUNCHED` | "Enabled 15/15 envs, unchanged 247 days" | "Ready for cleanup" |
| `PROBABLY_DEAD` | "Off in all envs, unchanged 312 days" | "Should be deleted" |
| `PROBABLY_FORGOTTEN` | "Enabled in 4/7 mainline envs, unchanged 194 days" | "Stalled — needs attention" |
| `ACTIVE_ROLLOUT` | "Last changed 3 days ago" | "In progress" |
| (no label) | (nothing shown) | "Healthy" / "OK" |

---

## 5. Data Contract

> **Shared types & conventions: see [data-model.md](../data-model.md) (canonical).**

### 5.1 Dependency edge (parser output → FE)

```typescript
interface DependencyEdge {
  /** ID of the flag that declares the dependency. */
  sourceId: string;
  /** ID of the prerequisite flag referenced in prose. */
  prerequisiteId: string;
  /** Parser tier that produced this edge. */
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  /** Confidence derived from tier. */
  confidence: 'high' | 'medium' | 'low';
  /** True if the prose negates the dependency ("without requiring"). */
  negated: boolean;
  /** The exact sentence or clause from Description that was matched. */
  sourceExcerpt: string;
  /** The regex pattern that matched (for auditability). */
  matchPattern: string;
}
```

### 5.2 Prerequisite resolution

```typescript
type PrereqResolution = 'resolved-flt' | 'resolved-external' | 'unresolved';

interface ResolvedPrerequisite {
  id: string;
  resolution: PrereqResolution;
  /** Per-env state; only populated for resolved prerequisites. */
  envStates: Record<EnvKey, EnvState> | null;
  /** If resolved-external, the FM repo path. */
  fmPath?: string;
}
```

### 5.3 Inert finding (per flag × env)

```typescript
type InertClassification =
  | 'EFFECTIVE'
  | 'INERT'
  | 'INERT_CHAIN'
  | 'INFORMATIONAL'
  | 'NOT_APPLICABLE';

interface InertFinding {
  flagId: string;
  env: EnvKey;
  classification: InertClassification;
  /** The edge(s) that produced this finding. */
  edges: DependencyEdge[];
  /** For INERT/INERT_CHAIN: the blocking chain, ordered root→leaf. */
  blockingChain?: BlockingChainNode[];
  /** Human-readable summary sentence. */
  summary: string;
}

interface BlockingChainNode {
  flagId: string;
  stateInEnv: EnvState;
  /** True if this is the node that breaks the chain (OFF). */
  isBlocker: boolean;
}
```

### 5.4 Stale-reason observation (per flag)

```typescript
type StaleLabel =
  | 'PROBABLY_LAUNCHED'
  | 'PROBABLY_DEAD'
  | 'PROBABLY_FORGOTTEN'
  | 'ACTIVE_ROLLOUT'
  | null;  // STABLE — no label

interface StaleObservation {
  flagId: string;
  label: StaleLabel;
  confidence: 'high' | 'medium' | null;
  /** Calendar days since last Environments change. */
  daysSinceLastChange: number;
  /** ISO date of the last change. */
  lastChangeDate: string;
  /** Posture summary for transparency. */
  posture: {
    mainlineOnCount: number;   // out of 7
    sovereignOnCount: number;  // out of 7
    totalOnCount: number;      // out of 15
    totalCondCount: number;
    totalTargetCount: number;
  };
  /** User-facing neutral description. */
  displayText: string;
}
```

### 5.5 Aggregate response (server → browser)

```typescript
interface InertIntelligencePayload {
  /** ISO timestamp of computation. */
  computedAt: string;
  /** All dependency edges discovered by the parser. */
  edges: DependencyEdge[];
  /** Resolved prerequisites (FLT + external). */
  prerequisites: ResolvedPrerequisite[];
  /** Per (flag, env) inert findings — only non-NOT_APPLICABLE entries. */
  findings: InertFinding[];
  /** Per-flag stale observations — only non-null labels. */
  staleObservations: StaleObservation[];
  /** Parser metadata for transparency. */
  parserMeta: {
    flagsAnalyzed: number;
    edgesExtracted: number;
    prerequisitesResolved: number;
    prerequisitesUnresolved: number;
    externalFlagsFetched: number;
  };
}
```

### 5.6 Data-contract boundary (P1 declares, P2 implements)

This spec defines the **shape** of the data contract. P2 (`architecture.md`) owns:
- The ADO REST fetch strategy for external prerequisites (on-demand vs. batch).
- Cache invalidation for external prerequisite state.
- The parser implementation (regex engine, NLP fallback if any, test harness).
- The server-side endpoint that computes and serves `InertIntelligencePayload`.

---

## 6. Layout & Interaction Model

### 6.1 Integration point

C06 is a **panel within the Control Tower view**, not a standalone page. It appears in the Intelligence layer (Layer 3) and is accessible via:
- A dedicated tab/section in the Control Tower navigation ("Intelligence → Inert Detection").
- Cross-links from the Grid (C01): clicking an inert-badged cell navigates to C06 with that flag pre-focused.
- Cross-links from the Flag Dossier (C02): the dossier's dependency section deep-links to C06.

### 6.2 Panel structure (top-to-bottom)

| Section | Content | Notes |
|---|---|---|
| **Header** | "Inert Detection" + summary KPI strip | KPI: `{n} inert findings · {m} flags with dependencies · {k} unknown prerequisites` |
| **Filter bar** | Confidence filter (`High` / `Medium` / `All`) · Env filter (multi-select, default: all mainline) · Stale-label filter (`PROBABLY_LAUNCHED` / `PROBABLY_DEAD` / `PROBABLY_FORGOTTEN` / `ACTIVE_ROLLOUT` / `All`) | Filters compose with AND. URL-encoded for shareability (CEO ruling #5). |
| **Findings list** | One card per inert finding, grouped by flag | See §6.3 |
| **Blocking-chain viewer** | Expands inline when a finding card is selected | See §6.4 |
| **Stale observations** | Separate sub-section below findings, listing flags with lifecycle labels | See §6.5 |

### 6.3 Finding card

Each finding card displays:

```
┌─────────────────────────────────────────────────────────────────┐
│ ◆ INERT   FLTArtifactBasedThrottling  ·  prod                  │
│                                                                 │
│ Enabled in prod, but prerequisite EnableFMVServiceAPIThrottling  │
│ is OFF in prod.                                                 │
│                                                                 │
│ Source: "EnableFMVServiceAPIThrottling must be enabled for this  │
│ feature to take effect."                                        │
│ Parser: T1 (hard gate) · Confidence: high                       │
│                                                                 │
│ [View in Grid]  [View blocking chain ▸]                         │
└─────────────────────────────────────────────────────────────────┘
```

- The `◆` glyph color encodes classification: `INERT` = `var(--amber)`, `INERT_CHAIN` = `var(--red)`, `INFORMATIONAL` = `var(--text-3)`.
- The card is a `<details>` element; collapsed state shows flag ID + env + one-line summary. Expanded state shows source excerpt, parser tier, and chain link.
- INFORMATIONAL findings are collapsed by default and visually subdued (muted badge).

### 6.4 Blocking-chain visualization (LD-inspired)

When a user expands "View blocking chain" on an `INERT` or `INERT_CHAIN` finding:

```
FLTArtifactBasedThrottling          EnableFMVServiceAPIThrottling
      ┌────────┐                         ┌────────┐
      │Enabled │  ── depends on ──▸      │  OFF   │
      │  prod  │                         │  prod  │
      └────────┘                         └────────┘
         on                                 off
```

Design rules:
- Horizontal left-to-right flow: dependent → prerequisite(s). Matches reading direction.
- Each node shows: flag ID (truncated with tooltip if long), state in the target env, colored by state (`var(--green)` for on, `var(--text-3)` / empty for off, `var(--amber)` for conditional).
- The blocking node (the one that is OFF) gets a `var(--red)` border and a `✕` glyph.
- For chains deeper than 2, the visualization extends horizontally with connectors.
- Non-FLT prerequisites show a small external-link icon (`↗`) since they're outside the FLT-42 scope.
- Maximum rendered chain depth: 3 nodes. If the chain is deeper (should not occur in practice), show `⋯` with a tooltip.

### 6.5 Stale-observation sub-section

Below the findings list, a separate sub-section shows flags with lifecycle labels:

```
┌─────────────────────────────────────────────────────────────────┐
│ Lifecycle Observations                                          │
│                                                                 │
│ PROBABLY_LAUNCHED (3)                                            │
│   FLTSkipShortcutExecution    Enabled 8/15 envs, unchanged 247d │
│   FLTUnresolvedEntitySupport  Enabled 8/15 envs, unchanged 183d │
│   FLTDagSettings              Enabled 8/15 envs, unchanged 312d │
│                                                                 │
│ PROBABLY_FORGOTTEN (1)                                           │
│   FLTRefreshPolicy            Enabled 4/7 mainline, unchanged   │
│                               194d                              │
│                                                                 │
│ ACTIVE_ROLLOUT (2)                                               │
│   FLTInsightsMetrics          Last changed 3 days ago            │
│   FLTIRDeletesEnabled         Last changed 12 days ago           │
└─────────────────────────────────────────────────────────────────┘
```

- Each label group is collapsible.
- Within each group, flags are sorted by `daysSinceLastChange` descending (oldest first for PROBABLY_* labels, newest first for ACTIVE_ROLLOUT).
- The posture fraction (e.g. "8/15 envs") counts `Enabled` + `Requires-conditional` + `Targets-targeted` as "on."
- `PROBABLY_DEAD` flags (all off) are displayed with fully muted styling.

### 6.6 Grid integration (cross-component)

The main Grid (C01) shows inert status per cell:

- An `INERT` cell gets a small `◆` overlay (amber) in the top-right corner of the cell glyph. Tooltip: "Inert — prerequisite OFF. Click for details."
- An `INFORMATIONAL` cell gets a small `?` overlay (muted). Tooltip: "Dependency detected — prerequisite state unknown."
- Clicking the overlay navigates to C06 with the finding pre-focused.

Stale labels appear as a subtle badge in the flag's row header in the Grid, positioned after the flag name: `FLTDagSettings` `PROBABLY_LAUNCHED`. The badge uses the `.badge.muted` design-bible token for PROBABLY_LAUNCHED and PROBABLY_DEAD, `.badge.amber` for PROBABLY_FORGOTTEN, and `.badge.accent` for ACTIVE_ROLLOUT.

---

## 7. State Matrix

### 7.1 Component states

| State | Entry condition | Visual | Transitions to |
|---|---|---|---|
| `loading` | Initial fetch of `InertIntelligencePayload` in flight | Skeleton cards (3 placeholder cards with shimmer). KPI strip shows "Analyzing…" | `populated`, `none-detected`, `error` |
| `populated` | Payload received; `findings.length > 0` OR `staleObservations.length > 0` | Full findings list + stale observations. KPI strip shows counts. | `loading` (on refresh), `error` (on re-fetch failure) |
| `none-detected` | Payload received; `findings.length === 0` AND `staleObservations.length === 0` | Empty-state illustration: "No inert flags detected. All dependencies are satisfied across all environments." Below: "This analysis is based on {n} flags with {m} detected dependency edges." | `loading` (on refresh), `populated` (on data change) |
| `error` | Fetch failed or parser threw | Error banner: "Could not analyze flag dependencies. [Retry]". If partial data is available (e.g., stale observations computed but inert analysis failed), show partial data with degraded badge. | `loading` (on retry) |
| `low-confidence` | All findings are `INFORMATIONAL` (no high/medium-confidence inert findings) | Populated view but with a header note: "All detected dependencies have low or unknown confidence. No definitive inert flags found." KPI strip shows `0 inert · {n} informational`. | Same as `populated` |
| `partial-data` | External prerequisites could not be fetched (ADO auth/network failure) but FLT-internal analysis succeeded | Findings from FLT-internal dependencies shown normally. A banner: "External prerequisite states could not be fetched. {k} findings are marked informational." | `populated` (on successful re-fetch) |

### 7.2 Interaction states

| Interaction | Behavior |
|---|---|
| Filter change | Findings list re-filters in-place (no server round-trip). URL updates to reflect filter state. |
| Card expand/collapse | `<details>` toggle. Only one blocking-chain visualization is rendered at a time (expanding a new one collapses the previous). |
| Grid cell click (inert overlay) | Navigates to C06 panel, scrolls to and expands the relevant finding card. |
| Refresh (Control Tower-wide) | Re-fetches flag data → re-runs parser → re-evaluates inert + stale. Transitions through `loading` → `populated`/`none-detected`/`error`. |
| Keyboard | Arrow Up/Down navigates finding cards. Enter expands/collapses. `f` focuses the filter bar. `Escape` returns to Grid. |

### 7.3 Data freshness

Inert analysis is computed server-side from the same cached flag data that powers the Grid (C01). It does not have its own fetch cycle. When the Control Tower refreshes (`master` re-pull + diff), the inert analysis is recomputed from the new data. There is no independent "re-analyze" button — freshness is tied to the overall data refresh.

---

## 8. Open Questions & Risks for P2

### 8.1 Open questions

| # | Question | Context | Recommendation |
|---|---|---|---|
| Q1 | Should P2 pre-fetch ALL external prerequisites referenced by FLT-42, or fetch on-demand when a dependency edge points outside the set? | Currently only `EnableFMVServiceAPIThrottling` is referenced (by 2 flags). Pre-fetching 1 extra file is trivial; on-demand is simpler. But the number could grow. | **Recommend on-demand with cache.** Fetch external prerequisites only when a T1/T2 edge references them. Cache by commitId (immutable). Keeps the initial fetch small. |
| Q2 | Should the parser support NLP-based extraction (e.g., sentence embeddings) as a fallback for prose that doesn't match regex tiers? | Current FLT-42 Descriptions are simple enough that regex covers all real cases. NLP adds complexity and latency for zero observed benefit today. | **Recommend regex-only for V1.** Monitor parser miss rate (Descriptions with flag-name tokens that don't match T1–T3). Revisit NLP only if miss rate > 10%. |
| Q3 | What `daysSinceLastChange` thresholds are correct for stale labels? | Spec uses 30/90/180 days. These are initial values based on FLT's observed rollout cadence (flags typically progress through the ladder in 2–4 weeks). | **Ship with 30/90/180. Make configurable in P2.** Surface the thresholds in a config object so PMs can tune without code changes. |
| Q4 | Should `PROBABLY_LAUNCHED` require sovereign env coverage, or only mainline? | Some flags are intentionally mainline-only (sovereign clouds have different compliance cycles). Requiring all-15 would suppress valid PROBABLY_LAUNCHED findings. | **Require mainline-7 only.** Annotate sovereign gap as "Mainline complete; {n} sovereign envs off" at `medium` confidence. |
| Q5 | How should conditional×conditional overlap be handled for inert detection? | If both flag and prerequisite are `Requires-conditional` in the same env, their conditions may or may not overlap. Config alone cannot determine this. | **Downgrade to INFORMATIONAL.** "Both flags are conditional — effective overlap cannot be determined from config alone." |

### 8.2 Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **False-positive inert claims** destroy portal credibility | CRITICAL | Credibility contract (§3.3): never claim inert without verified prerequisite state; never promote T4; surface confidence visibly. Sentinel must test every edge case. |
| R2 | **External prerequisite fetch** adds ADO REST calls outside the FLT-42 set | MEDIUM | On-demand + commitId cache (§8.1 Q1). Currently only 1 external flag is referenced. If the count grows, batch into the initial fetch. |
| R3 | **Description prose changes** (FM PRs reword Descriptions) could break regex patterns | LOW | Patterns are intentionally broad ("must be enabled" / "requires" / "depends on"). Monitor parse results on each refresh; log Descriptions that contain flag-name tokens but match no T1–T3 pattern (potential misses). |
| R4 | **Stale-reason thresholds** may not fit all flags (some flags are intentionally long-lived operational gates) | MEDIUM | CEO ruling: no "permanent" marker in V1. Stale labels are neutral observations, not cleanup pressure. If PMs report noise, revisit Option B (side-annotation file) per the CEO's directive. |
| R5 | **Chain depth > 3** could indicate a misparse or an unusual FM pattern | LOW | Hard-cap chain walk at depth 3. Log and surface a warning if exceeded. Do not render chains deeper than 3. |
| R6 | **FLTInsightsEngine negation** is the only observed negation pattern; parser may miss novel negation phrasings | LOW | Ship with the known negation patterns. Log T4 edges that contain flag names near words like "not," "without," "independent" for human review. |

### 8.3 Dependency-extraction requirements for P2 (summary)

P2's parser implementation MUST:

1. Implement T1–T4 pattern tiers as specified in §2.2.1.
2. Handle negation detection as specified in §2.4.
3. Resolve prerequisites into the three classes (§2.2.2) and fetch external prerequisites via ADO REST.
4. Walk dependency chains to depth 3 with cycle detection (§2.3).
5. Produce `DependencyEdge[]` and `ResolvedPrerequisite[]` conforming to §5.1–5.2.
6. Compute `InertFinding[]` per the evaluation rules in §3.1–3.2.
7. Compute `StaleObservation[]` per the derivation rules in §4.3.
8. Serve the aggregate `InertIntelligencePayload` (§5.5) as part of the Control Tower data response.
9. Log parser diagnostics: Descriptions containing flag-name tokens that matched no T1–T3 pattern, negation patterns detected, chain depth warnings.
10. Include a test harness covering all worked examples in §3.4 and all edge cases in §4.4.

---

*Pixel owns visual refinement in P4 (mock). Sentinel owns test coverage in P5. This spec is the architectural contract — deviations require Sana sign-off.*
