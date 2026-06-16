# C02 Flag Dossier — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Flag Dossier — single-flag deep-dive (Zones A–D)
> **Canonical data model:** [`data-model.md`](../data-model.md)
> **Component spec:** [`C02-dossier.md`](../components/C02-dossier.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoints:** `GET /api/ct/flag/:flagId/dossier` → `DossierPayload`; `GET /api/ct/flag/:flagId/timeline/:commitId/diff` → `EnvsDiff`
> **Route:** `/flag/:flagId` | Filter params: `pinEnv`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C02-S00` | Dossier loading | Navigate to `/flag/:flagId`; `GET /api/ct/flag/:flagId/dossier` in flight | Full-page skeleton: Zone A (header) shimmer, Zone B (signals) shimmer, Zone C (env matrix) shimmer rows, Zone D (timeline) shimmer entries. Breadcrumb: "Grid ▸ [flagId]" (flagId visible even during load). | Disabled: pin, expand, diff toggle. Enabled: breadcrumb back, nav, Cmd-K | `G-DATA-NONE` | API returns → `C02-S01`; error → `C02-S05`/`C02-S06` | C02 §4 `loading` |
| `C02-S01` | Dossier loaded — populated | API returned `DossierPayload` with timeline entries | All zones rendered: Zone A (flag header + metadata), Zone B (inert/stale signals if applicable), Zone C (15-env matrix with pin/state/attribution), Zone D (timeline — grouped by default). | All interactions enabled: pin envs, expand chips, scroll timeline, toggle grouped/chrono, click PR links, open diffs | `G-DATA-FULL` | Navigate away; refresh; diff expand | C02 §4 `loaded-populated` |
| `C02-S01a` | Dossier — state-only (progressive) | API returned with attribution pending (cold-load in progress) | Zone A: flag name + description visible. Zone B: signals may be absent (derivation pending). Zone C: CellState values shown, attribution columns show shimmer. Zone D: "Timeline loading…" placeholder. | Partial: env matrix navigable, but attribution not clickable. Pin/unpin available. | `G-DATA-STATE-ONLY` | Attribution arrives → `C02-S01`; fails → `C02-S04b` | C02 §4 (inferred from OQ-03) |

### A.2 Empty States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C02-S02` | Never-changed flag | API returned; `timeline.length === 0` | Zone A: header visible. Zone B: signals (if any). Zone C: env matrix with current state. Zone D: "No recorded changes in the commit history for this flag." | Zones A–C interactive. Zone D static. | `G-DATA-FULL` | Refresh may reveal changes (new commits) | C02 §3.6.6; C02 §4 `loaded-never-changed` |
| `C02-S02a` | No inert/stale signals | `inertSignal === null && staleSignal === null` | Zone B is entirely absent (not rendered, not collapsed — absent from DOM). Zones A, C, D as normal. | Normal | `G-DATA-FULL` | Refresh may produce signals | C02 §3.4 |
| `C02-S02b` | File creator unknown | `fileCreator === null` | "Created by" line in Zone A is hidden entirely (not "Unknown"). | Normal | `G-DATA-FULL` | — | C02 §3.3 |

### A.3 Populated Variants (Domain-Specific)

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C02-S01.a` | Inert signal — prerequisite off | `inertSignal.kind === 'prerequisite_off'` | Zone B shows amber card: "Prerequisite [flagName] is OFF in [env]" with chain visualization. Confidence indicator. | High-confidence inert finding | C02 §3.4.1 |
| `C02-S01.b` | Inert signal — prerequisite unknown | `inertSignal.kind === 'prerequisite_unknown'` | Zone B shows blue-grey card: "Prerequisite [flagName] could not be verified — INFORMATIONAL" | Never claims inert; informational only (R1/R5) | C02 §3.4.1; `G-ATTR-ABSENT` semantics |
| `C02-S01.c` | Stale signal — PROBABLY_LAUNCHED | `staleSignal.reason === 'PROBABLY_LAUNCHED'` | Zone B shows green-tinted card: "`PROBABLY_LAUNCHED` — enabled across all mainline environments for [N] days (threshold: [T]d)" | data-model.md §4; C06 §4.3 | C02 §3.4.2 |
| `C02-S01.d` | Stale signal — PROBABLY_DEAD | `staleSignal.reason === 'PROBABLY_DEAD'` | Zone B shows grey-tinted card: "`PROBABLY_DEAD` — OFF across all environments for [N] days" | Threshold: 180 days (OQ-05) | C02 §3.4.2 |
| `C02-S01.e` | Stale signal — PROBABLY_FORGOTTEN | `staleSignal.reason === 'PROBABLY_FORGOTTEN'` | Zone B shows amber-tinted card: "`PROBABLY_FORGOTTEN` — no changes for [N] days, not fully rolled out" | Threshold: 90 days (OQ-05) | C02 §3.4.2 |
| `C02-S01.f` | Conditional cell — "Show raw" | User clicks "Show raw" on a `'conditional'` cell in Zone C | Expandable section reveals raw `Requires` JSON block. Screenshot-safe (collapsed by default). | `aria-expanded` toggle | C02 §3.5; C07 §3.3 |
| `C02-S01.g` | Targeted cell — "Show raw" | User clicks "Show raw" on a `'targeted'` cell in Zone C | Expandable section reveals raw `Targets` JSON block. Screenshot-safe (collapsed by default). | `aria-expanded` toggle | C02 §3.5 |
| `C02-S01.h` | PR link present | `prNumber !== null` in Attribution | "PR #[N]" rendered as link to ADO PR page. Opens in new tab. | — | data-model.md §3; C02 §2.3 |
| `C02-S01.i` | No PR link | `prNumber === null` | No PR link rendered. Author + commit hash + date still shown. No placeholder text. | `G-ATTR-NO-PR` | C02 §4.3 |
| `C02-S01.j` | Timeline — grouped view | Default or `?timeline=grouped` | Timeline entries grouped by affected environments. Each group collapsible. | Default mode | C02 §3.6.1 |
| `C02-S01.k` | Timeline — chronological view | `?timeline=chronological` | Timeline entries in reverse-chronological order. No grouping. | User-toggled mode | C02 §3.6.4 |
| `C02-S01.l` | Pinned environments | User pinned 1+ envs via Zone C toggle | Pinned env rows float to top of Zone C matrix with visual pin indicator. Persisted to sessionStorage + URL `?pinned=prod,bleu`. | Session-scoped persistence | C02 §3.5.4 |

### A.4 Partial / Degraded States

| State ID | Name | Precondition / Trigger | What's rendered | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|
| `C02-S04` | Diff too large | `GET /api/ct/flag/:flagId/timeline/:commitId/diff` returns 413 | Inline message in timeline entry: "Diff payload exceeds 256 KB — View raw in repo ↗" with link to FM repo at that commit. | `G-DATA-FULL` (diff just too large) | — (permanent for that commit) | OQ-04; C02 §2.8; C02 §3.6.3 |
| `C02-S04a` | Diff loading | User expanded a timeline entry; diff fetch in flight | Inline spinner within the expanded timeline section. Other sections remain interactive. | `G-DATA-FULL` (diff pending) | Diff arrives → `C02-S04c`; error → `C02-S04b` | C02 §4 `diff-loading` |
| `C02-S04b` | Diff error | Diff fetch failed (5xx/network, not 413) | Inline error in timeline entry: "Could not load diff — Retry" | `G-DATA-FULL` (diff unavailable) | User clicks Retry → `C02-S04a` | C02 §4 `diff-error` |
| `C02-S04c` | Diff loaded | Diff fetch succeeded | Inline diff panel showing `EnvsDiff`: before/after per environment in a key-value comparison view. | `G-DATA-FULL` | User collapses section; navigate away | C02 §4 `diff-loaded` |
| `C02-S04d` | Attribution partial | Some cells have `null` attribution (miner failed for those commits) | CellState values shown in Zone C; attribution lines absent for affected cells. Amber banner in Zone A: "Attribution fetch failed — showing state only." | `G-DATA-PARTIAL` | Refresh → full data | C02 §4 |

### A.5 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Exit conditions | Source |
|---|---|---|---|---|---|---|
| `C02-S05` | Fetch error | `GET /api/ct/flag/:flagId/dossier` failed (5xx/network) | Full-width error banner: "[Error message]" + Retry button. No dossier content. Breadcrumb still works. | Retry, breadcrumb back, nav, sign-out | Retry → `C02-S00` | C02 §4 `error-fetch` |
| `C02-S06` | Flag not found | `GET /api/ct/flag/:flagId/dossier` returns 404 (`flagNotFound`) | Full-page message: "Flag '[flagId]' not found in FeatureManagement@master." + suggestion: "Check the flag ID or return to the grid." + Back to grid link. | Back link, nav, sign-out | Navigate to grid; correct URL | C02 §4 `error-not-found` |
| `C02-S07` | Refreshing dossier | Global refresh in progress; dossier view active | Dossier content remains visible. Refresh indicator in shell. When refresh completes, dossier re-fetches and re-renders. | Fully interactive on current data | Refresh completes → re-fetch → `C02-S01` or `C02-S00` | C02 §4 `refreshing` |

### A.7 Historical Dossier States (P3 gate ruling GAP-04)

When C02 is entered with `?asOf=YYYY-MM-DD` (from C05 Time Travel or a direct deep-link), the dossier renders the flag's state at that historical date.

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C02-S08` | Historical dossier — populated | URL has `?asOf=YYYY-MM-DD`; API returned historical payload | **Banner:** "Viewing as of [date]" + "Exit to current ↗" link. **Zone A:** flag name + description (as of that date). **Zone C:** env states as-of that date (using reconstructed data, same as C05 `TimeTravelCellState`). Attribution shows last-change-before-asOf date. **Zone D:** timeline truncated — only entries with `changedAt ≤ asOf`. Grouped/chronological toggle still works on truncated set. | All controls on historical data: pin, expand chips, scroll timeline, toggle mode. "Exit to current" link. No Refresh (historical data is immutable). | `G-DATA-FULL` (historical) | Exit to current → `C02-S01`; navigate away | P3 gate ruling GAP-04; C02 §3.1 |
| `C02-S08a` | Historical dossier — flag not yet created | URL has `?asOf` with date before flag's first commit | **Banner:** "Viewing as of [date]" + "Exit to current ↗" link. **Zone C:** all 15 cells show `not-yet-created` (same visual as C05-S03.a). **Zone D:** "This flag did not exist on [date]." | Exit to current; navigate away | `G-DATA-FULL` (historical) | Exit to current → `C02-S01` | P3 gate ruling GAP-04 |
| `C02-S08b` | Exit to current | User clicks "Exit to current" link in historical banner | URL `?asOf` param removed. Dossier re-fetches current data. Brief loading → `C02-S01`. | Same as `C02-S00` during transition | `G-DATA-NONE` (re-fetching) | API returns → `C02-S01` | P3 gate ruling GAP-04 |

### A.8 Selection / Focus / Keyboard States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C02-S20` | Env row hover | Mouse over Zone C env row | Row highlight. Tooltip with cell detail on 300ms delay. | C02 §3.5 |
| `C02-S21` | Env row focused (keyboard) | Arrow Up/Down in Zone C | Focus ring on row. `Enter` expands conditional/targeted detail. `p` toggles pin. | C02 §3.5.5 |
| `C02-S22` | Timeline entry expanded | Click or `Enter` on timeline entry header | Expand/collapse chevron rotates. Diff content or loading spinner visible. `aria-expanded="true"`. | C02 §3.6.1; C02 §3.6.3 |
| `C02-S23` | Pin toggle | User presses `p` or clicks pin icon on an env row | Pin indicator appears. Row floats to top. URL and sessionStorage updated. | C02 §3.5.4 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any view) | Navigate to `/flag/:flagId` | `C02-S00` | Dossier fetch fires |
| `C02-S00` | API returns full payload | `C02-S01` | Zones A–D render |
| `C02-S00` | API returns state-only (cold-load) | `C02-S01a` | Partial render; attribution pending |
| `C02-S00` | API returns 404 | `C02-S06` | Flag-not-found page |
| `C02-S00` | API returns 5xx/network error | `C02-S05` | Error banner |
| `C02-S00` | API returns 401 | `G-AUTH-EXPIRED` | Session expired redirect |
| `C02-S01a` | Attribution arrives | `C02-S01` | Columns fill; shimmer replaced |
| `C02-S01a` | Attribution fails | `C02-S04d` | Amber banner; state shown |
| `C02-S01` | timeline.length === 0 | `C02-S02` | "No recorded changes" in Zone D |
| `C02-S01` | inertSignal === null && staleSignal === null | `C02-S02a` | Zone B absent |
| `C02-S01` | User clicks "Show raw" on conditional cell | `C02-S01.f` | Raw block revealed |
| `C02-S01` | User clicks "Show raw" on targeted cell | `C02-S01.g` | Raw block revealed |
| `C02-S01` | User expands timeline entry | `C02-S04a` | Diff fetch fires |
| `C02-S04a` | Diff fetch succeeds | `C02-S04c` | Diff panel renders |
| `C02-S04a` | Diff fetch returns 413 | `C02-S04` | "View raw in repo ↗" |
| `C02-S04a` | Diff fetch fails (5xx/network) | `C02-S04b` | Inline error + Retry |
| `C02-S04b` | User clicks Retry | `C02-S04a` | Re-fetch diff |
| `C02-S01` | User pins/unpins env | `C02-S23` → `C02-S01` | Pin state updated |
| `C02-S01` | User toggles grouped ↔ chronological | `C02-S01.j` ↔ `C02-S01.k` | Timeline re-renders |
| `C02-S01` | User clicks breadcrumb "Grid" | C01 loads | Grid state restored from URL |
| `C02-S01` | User clicks PR link | (new tab) | ADO PR page opens |
| `C02-S01` | Global refresh starts | `C02-S07` | Shell shows refresh indicator |
| `C02-S07` | Refresh completes | `C02-S00` → `C02-S01` | Dossier re-fetches |
| `C02-S05` | User clicks Retry | `C02-S00` | Re-fetch dossier |
| `C02-S06` | User clicks "Back to grid" | C01 loads | Navigate to `/` |
| `C02-S01` | 401 on any sub-request | `G-AUTH-EXPIRED` | Session expired |
| (any view) | Navigate to `/flag/:flagId?asOf=YYYY-MM-DD` | `C02-S00` | Historical dossier fetch (GAP-04) |
| `C02-S00` | API returns historical payload (`?asOf` present) | `C02-S08` | Historical dossier renders |
| `C02-S00` | API returns historical payload; flag not yet created at asOf date | `C02-S08a` | "Flag did not exist" message |
| `C02-S08` | User clicks "Exit to current" | `C02-S08b` → `C02-S00` → `C02-S01` | Re-fetch current dossier |
| `C02-S08a` | User clicks "Exit to current" | `C02-S08b` → `C02-S00` → `C02-S01` | Re-fetch current dossier |

---

## C. URL / Filter-State Coupling

### C.1 URL structure

| State | URL example | Params |
|---|---|---|
| Default dossier | `/flag/FLTArtifactBasedThrottling` | — |
| With pinned envs | `/flag/FLTArtifactBasedThrottling?pinned=prod,msit` | `pinned` |
| With timeline mode | `/flag/FLTArtifactBasedThrottling?timeline=chronological` | `timeline` |
| From Time Travel (C05) | `/flag/FLTArtifactBasedThrottling?asOf=2026-03-10` | `asOf` |
| Combined | `/flag/FLTArtifactBasedThrottling?pinned=prod&timeline=chronological` | `pinned`, `timeline` |

### C.2 Deep-link cold-load behaviour

1. User opens `/flag/FLTArtifactBasedThrottling` directly.
2. Auth flow if needed → `G-AUTH-PENDING` → redirect → return.
3. `C02-S00` (skeleton) — flagId extracted from URL path.
4. API call `GET /api/ct/flag/FLTArtifactBasedThrottling/dossier`.
5. If warm store is cold: API may trigger cold-load → progressive state (`C02-S01a`).
6. If flagId is invalid: 404 → `C02-S06`.
7. If `?pinned=prod` present: Zone C renders with prod pinned to top after data loads.

### C.3 Session persistence

- Pin state: dual-persisted to `sessionStorage` key `controlTower.dossier.{flagId}.pinnedEnvs` AND URL `?pinned=`.
- Timeline mode: URL-only (`?timeline=grouped|chronological`). Defaults to `grouped` if absent.
- `asOf` param from C05 → C02: if present, dossier shows "as of [date]" historical state rather than current.

---

## D. Source Trace

| State ID | Primary source | Secondary source |
|---|---|---|
| `C02-S00` | C02 §4 `loading` | — |
| `C02-S01` | C02 §4 `loaded-populated` | — |
| `C02-S01a` | OQ-03; C02 §4 (inferred) | `G-DATA-STATE-ONLY` |
| `C02-S02` | C02 §4 `loaded-never-changed`; C02 §3.6.6 | — |
| `C02-S02a` | C02 §3.4 | — |
| `C02-S02b` | C02 §3.3 | — |
| `C02-S01.a` | C02 §3.4.1 (inert prerequisite off) | C06 §3.3 |
| `C02-S01.b` | C02 §3.4.1 (inert prerequisite unknown) | R1, R5 |
| `C02-S01.c–e` | C02 §3.4.2; data-model.md §4 | OQ-05 thresholds |
| `C02-S01.f–g` | C02 §3.5 (conditional/targeted raw reveal) | — |
| `C02-S01.h–i` | C02 §2.3; data-model.md §3 | `G-ATTR-NO-PR` |
| `C02-S01.j–k` | C02 §3.6.1, §3.6.4 | — |
| `C02-S01.l` | C02 §3.5.4 | — |
| `C02-S04` | OQ-04; C02 §2.8 | — |
| `C02-S04a–c` | C02 §4 diff states | — |
| `C02-S04d` | C02 §4 (inferred) | `G-ATTR-ABSENT` |
| `C02-S05` | C02 §4 `error-fetch` | `G-ERR-5XX` |
| `C02-S06` | C02 §4 `error-not-found` | — |
| `C02-S07` | C02 §4 `refreshing` | `G-REFRESH-IN-PROGRESS` |
| `C02-S08–S08b` | P3 gate ruling GAP-04 (historical dossier) | C02 §3.1 |
| `C02-S20–23` | C02 §3.5, §3.5.5, §3.6.1, §3.5.4 | — |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| ~~`?asOf` param from C05 not fully specified in C02~~ | ~~MEDIUM~~ | **RESOLVED (P3 gate ruling GAP-04):** Historical dossier states `C02-S08`, `C02-S08a`, `C02-S08b` added. Zone C shows as-of-date state, Zone D truncates timeline, banner + exit affordance shown. |
| Diff expand/collapse state not URL-encoded | INFO | Intentional — per-entry expansion is ephemeral. Acceptable. |
| Stale dossier (data >60 min) not explicitly defined | LOW | Inherits from `G-STALE` global state. Dossier shows current data + global stale banner. No dossier-specific stale indicator beyond the shell chip. |

---

**State count:** 31 distinct states (7 primary + 12 populated/signal variants + 5 diff sub-states + 3 historical + 4 interaction states)

*Sana — C02 Dossier state matrix.*
