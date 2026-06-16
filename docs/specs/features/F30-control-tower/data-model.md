# F30 Control Tower — Canonical Data Model

> **Status:** P1→P2 bridge document
> **Authority:** This file is the **single source of truth** for shared types, enums, environment groupings, routes, and naming conventions across all nine component specs (C01–C09). Where any component spec diverges from a definition below, **this file supersedes.**
> **Last updated:** 2026-06-13

---

## 1. CellState Enum & State Shapes

```typescript
type CellState = 'off' | 'on' | 'conditional' | 'targeted';
```

| CellState       | FM JSON shape             | Meaning                                      |
|-----------------|---------------------------|----------------------------------------------|
| `'off'`         | `{}` or key absent        | Not enabled                                  |
| `'on'`          | `{"Enabled": true}`       | Fully enabled                                |
| `'conditional'` | `{"Requires": [...]}`     | Conditionally gated (predicate AND-list)     |
| `'targeted'`    | `{"Targets": {...}}`      | Targeted at specific tenant GUIDs / regions  |

**No abbreviated tokens.** All specs must use `'conditional'` and `'targeted'` — never `'cond'` or `'target'`.

---

## 2. Environment Model

### 2.1 Full set (15 environments, canonical order)

```
onebox, test, cst, daily, dxt, msit, prod, mc, gcc, gcchigh, dod, usnat, ussec, bleu, usgovcanary
```

### 2.2 Groupings

| Group              | Count | Environments                                              | Notes |
|--------------------|-------|------------------------------------------------------------|-------|
| **Ladder**         | 6     | `test, cst, daily, dxt, msit, prod`                       | The promotion spine. `onebox` is **not** on the ladder. |
| **Sovereign**      | 7     | `mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary`        | `bleu` is **not** sovereign. |
| **Mainline**       | 7     | `onebox, test, cst, daily, dxt, msit, prod`                | onebox through prod. Used by C06 stale-reason derivation. |
| **Other**          | 2     | `onebox` (pre-ladder dev), `bleu` (non-sovereign regional) | Neither ladder nor sovereign. |

### 2.3 Key rulings

- `onebox` is a pre-ladder development environment; it is **not** a ladder rung.
- `bleu` is a non-sovereign regional environment; it is **not** a sovereign cloud.
- "Mainline (7)" = onebox through prod. C06 §4.3 PROBABLY_LAUNCHED checks all 7 mainline envs.

---

## 3. Attribution Interface

```typescript
interface Attribution {
  author: string | null;      // git commit author display name; null when unknown
  prNumber: number | null;    // from "Merged PR NNNNNNN" in merge-commit message
  commitId: string;           // full 40-char SHA; UI truncates to 7 for display
  changedAt: string;          // ISO-8601
}
```

### 3.1 Display-label rules (UI, not field names)

| Condition | Label |
|-----------|-------|
| Transition INTO a non-off state (`on`, `conditional`, `targeted`) | **"Last enabled by"** |
| Any other transition (e.g. `targeted → on`, `conditional → on`, state content change) | **"Last modified by"** |
| The file-creation commit only | **"Created by"** |

**Never use "Owner" or "Maintainer"** — no such field exists in FM.

---

## 4. StaleReason Type

```typescript
type StaleReason =
  | 'PROBABLY_LAUNCHED'
  | 'PROBABLY_DEAD'
  | 'PROBABLY_FORGOTTEN'
  | 'ACTIVE_ROLLOUT'
  | null;  // STABLE — no label shown
```

**Derivation is canonical in C06 §4.3 — do not redefine.** Component specs that consume `StaleReason` must reference C06 for derivation rules and thresholds, not inline their own definitions.

---

## 5. Route Table (canonical, from C09)

| View        | Base path       | Required path segment          | Filter params                 |
|-------------|-----------------|--------------------------------|-------------------------------|
| Grid        | `/`             | —                              | `q`, `state`, `envs`, `layer` |
| Dossier     | `/flag/:flagId` | `:flagId` — flag ID string     | `pinEnv`, `asOf`              |
| Ladder      | `/ladder`       | —                              | `flags`                       |
| Activity    | `/activity`     | —                              | `from`, `to`, `flags`, `envs` |
| Time Travel | `/travel`       | —                              | `date`, `flags`, `envs`       |
| Inert       | `/inert`        | —                              | `reason`, `flag`              |
| Sovereign   | `/sovereign`    | —                              | `flags`, `envs`               |
| Velocity    | `/velocity`     | —                              | `window`, `flags`             |

**Pinned routes:** Flag Dossier = `/flag/:flagId` (singular, no extra prefix). Sovereign Lens = `/sovereign`.

- `asOf` (Dossier) — ISO date; when present, the dossier renders the flag's historical state as of that date (env states at `asOf`, timeline truncated to `asOf`), entered from Time Travel. Absent = current state.
- `flag` (Inert) — flag ID; deep-links the Inert view to a specific finding (e.g. from a C01 grid inert badge).

---

## 6. API Prefix

All server-side route handlers use the prefix:

```
/api/ct/
```

Never `/api/control-tower/`. Examples: `/api/ct/grid`, `/api/ct/sovereign-lens`, `/api/ct/velocity`.

### 6.1 Payload size thresholds

| Threshold | Value | Applies to | Behavior when exceeded |
|-----------|-------|------------|------------------------|
| **Diff payload cap** | 256 KB | C02/C04 diff detail panels (`/api/ct/flag/:flagId/timeline/:commitId/diff`, `/api/ct/activity/diff/:eventId`) | Server omits the inline diff; UI shows a "View raw in repo ↗" link instead. |
| **Inline condition block** | 4 KB | C07 Sovereign / C02 raw `Requires`/`Targets` reveal | Block is truncated and `rawTruncated: true` is set; UI offers a gated "Show raw" / repo link. |

---

## 7. Dwell Rule

A ladder rung is **reached** at the **first non-off state** (CEO ruling, first-non-off):

```
firstEnabledDate(env) = earliest commit where new state ∈ {on, conditional, targeted}
```

Dwell between consecutive rungs:

```
dwell(R_n) = firstEnabledDate(R_{n+1}) − firstEnabledDate(R_n)   [calendar DAYS]
```

- Units are whole calendar **days** everywhere (`dwellDays`, not `dwellMs`).
- Prod follows the same `firstEnabledDate` formula as every other rung — no special-case.
- A later graduation (e.g. `targeted → on`) is surfaced as its own timeline event, **not** folded into dwell or time-to-prod.

**Worked example — FLTArtifactBasedThrottling:** msit reached 2026-03-03, prod first non-off 2026-03-10 (targeted) → msit→prod dwell = **7 days**. The later `targeted → on` (2026-03-13) is a separate timeline event.
