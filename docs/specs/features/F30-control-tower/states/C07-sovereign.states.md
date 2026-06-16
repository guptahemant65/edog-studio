# C07 Sovereign Lens — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Sovereign Compliance Lens — prod vs sovereign cloud parity matrix
> **Canonical data model:** [`data-model.md`](../data-model.md) — 7 sovereign envs: mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary
> **Component spec:** [`C07-sovereign.md`](../components/C07-sovereign.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoint:** `GET /api/ct/sovereign-lens` → `SovereignLensResponse`
> **Route:** `/sovereign` | Filter params: `flags`, `envs`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C07-S00` | Sovereign loading | Navigate to `/sovereign`; `GET /api/ct/sovereign-lens` in flight | Skeleton: cloud summary cards (7 shimmer cards). Matrix area: shimmer rows. Search bar disabled. Gap filter disabled. | Disabled: cloud card click, matrix cell click, search, gap filter. Enabled: nav, Cmd-K | `G-DATA-NONE` | API returns → `C07-S01`; error → `C07-S05` | C07 §4 `loading` |

### A.2 Populated States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C07-S01` | Populated — gaps exist | API returned with `hasAnyGap === true` for at least one flag | **Cloud summary cards** (7): one per sovereign env, showing gap count + parity percentage. **Matrix:** rows = flags, columns = sovereign envs. Cells show CellState chip + gap indicator dot if gap exists. **Prod reference column** on left. **Search bar** enabled. **Gap filter** (`All` / `Gaps only`). | All: cloud card click (highlight column), cell hover/click, search, gap filter, slide-in panel (Enter on cell), keyboard matrix nav | `G-DATA-FULL` | Filter; navigate to dossier; slide-in open | C07 §4 `populated` |
| `C07-S01a` | Populated — stale | API returned with `stale: true` | Same as `C07-S01` + amber sync label in header area. Fully functional. | All controls enabled | `G-DATA-FULL` (stale) | Refresh → `C07-S00` | C07 §4 `stale` |

### A.3 Domain-Specific Variants (Gap Types)

| State ID | Name | GapKind | What the cell shows | Notes | Source |
|---|---|---|---|---|---|
| `C07-S01.a` | Prod ON, cloud OFF | `prod_on_cloud_off` | Prod cell: green `on`. Sovereign cell: grey `off`. Gap dot: high severity. | Most critical gap — feature available commercially but not in sovereign. | C07 §2.3 |
| `C07-S01.b` | Prod ON, cloud CONDITIONAL | `prod_on_cloud_cond` | Prod: green. Sovereign: blue `conditional`. Gap dot: medium. Hover: "Conditionally enabled — not at full parity." | C07 §2.3 |
| `C07-S01.c` | Prod ON, cloud TARGETED | `prod_on_cloud_target` | Prod: green. Sovereign: purple `targeted`. Gap dot: medium. | C07 §2.3 |
| `C07-S01.d` | Prod CONDITIONAL, cloud OFF | `prod_cond_cloud_off` | Prod: blue. Sovereign: grey. Gap dot: medium-low. | C07 §2.3 |
| `C07-S01.e` | Prod TARGETED, cloud OFF | `prod_target_cloud_off` | Prod: purple. Sovereign: grey. Gap dot: medium-low. | C07 §2.3 |
| `C07-S01.f` | Cloud ON, prod OFF | `cloud_on_prod_off` | Prod: grey `off`. Sovereign: green `on`. Gap dot: unusual (neutral parity — not red). Tooltip: "Enabled in sovereign but not in commercial prod — unusual." | Sovereign-ahead scenario; neutral visual per neutral parity principle | C07 §2.3 |
| `C07-S01.g` | Cloud ON, prod CONDITIONAL | `cloud_on_prod_cond` | Prod: blue. Sovereign: green. Gap dot: unusual/neutral. | C07 §2.3 |
| `C07-S01.h` | Cloud CONDITIONAL, prod OFF | `cloud_cond_prod_off` | Prod: grey. Sovereign: blue. Gap dot: unusual/neutral. | C07 §2.3 |
| `C07-S01.i` | At parity | No gap (same CellState) | Both cells same colour/state. No gap dot. | Normal/good state | C07 §2.3 |
| `C07-S01.j` | Conditional raw reveal | User clicks "Show raw condition" on a `'conditional'` cell | Expandable section: raw `Requires` JSON block. Screenshot-safe (collapsed by default). `aria-expanded` toggle. | Same pattern as C02 | C07 §3.3, §6 |
| `C07-S01.k` | Targeted raw reveal | User clicks "Show raw targets" on a `'targeted'` cell | Expandable section: raw `Targets` JSON block. Screenshot-safe. | Same pattern as C02 | C07 §3.3 |
| `C07-S01.l` | Raw truncated (>4 KB) | `rawTruncated === true` in cell data | "Condition block exceeds 4 KB — View in FM repo ↗" link. No inline display. | C07-specific threshold (vs 256 KB for diffs) | C07 §2.2, §7 |
| `C07-S01.m` | Attribution absent on cell | `lastEnabledBy` is null | CellState shown; attribution line absent. No "Unknown" placeholder. | `G-ATTR-ABSENT` | C07 §2.2, §7 |
| `C07-S01.n` | Description empty | `description === ''` for a flag row | Flag name shown; description area blank (no placeholder). | C07 §5 S11 |
| `C07-S01.o` | Prod OFF, all sovereign OFF | Entire row is OFF everywhere | No gaps (both OFF = parity). Row appears grey. Hidden if "Gaps only" filter active. | Not a gap | C07 §2.3 |

### A.4 Empty States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C07-S02` | Full parity | No gaps exist across all flags × all sovereign envs AND gap filter is "Gaps only" | Message: "All sovereign clouds are at parity with commercial prod." + "View full matrix →" link (switches filter to "All"). | Click "View full matrix" → `C07-S01`; change filter | C07 §3.4, §4; `G-EMPTY-NO-GAPS` |
| `C07-S02a` | Search-empty | Search produces zero matching flag rows | "No flags match '[query]'." + "Clear search" link. Matrix header visible. | Clear search; change query | `G-EMPTY-FILTER` |

### A.5 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C07-S05` | Error — no cache | API failed; no stale data | Error card: "[message]" + Retry. No matrix. | Retry → `C07-S00` | C07 §7 |
| `C07-S05a` | Error — stale fallback | API failed; stale response available | Stale matrix rendered + red error text: "Could not refresh — showing cached data." | Retry → `C07-S00` | C07 §7 |
| `C07-S05b` | Error — zero flags | API returned `flags.length === 0` | Error card (not empty state): "No FLT flags found — this may indicate a data issue." | Retry; verify FM repo | C07 §7 |
| `C07-S05c` | Auth error | 401/403 | Reload prompt (401) or access denied | `G-AUTH-EXPIRED`; `G-AUTH-FORBIDDEN` | C07 §7 |
| `C07-S06` | Cold-load interstitial | Navigated to `/sovereign` while `G-BOOT-PROGRESSIVE`; attribution data not yet available | Interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s. Nav enabled. | Data arrives → `C07-S00`; navigate away | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |

### A.6 Slide-In Panel States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C07-S10` | Parity slide-in open | User pressed Enter on a matrix cell or clicked cell | `role="dialog"`, `aria-modal="true"`. Shows: flag name, prod state vs sovereign state, gap kind, attribution for both sides, raw condition/target blocks (collapsed). Focus trapped in panel. | C07 §6 |
| `C07-S10a` | Slide-in close | User clicks ✕ or presses Escape | Panel closes. Focus returns to the cell that triggered it. | C07 §3.3, §6 |

### A.7 Interaction / Focus States

| State ID | Name | Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C07-S20` | Cloud card click — column highlight | Click on a cloud summary card | Matrix column for that sovereign env highlighted. Scrolls to first non-parity row. Clicking again deselects. `aria-pressed="true"` on card. | C07 §3.2 |
| `C07-S21` | Cell hover / popover | Mouse hover or keyboard focus on matrix cell | Popover: CellState, attribution (if available), gap kind (if gap). Dismissed on mouse-leave or Escape. | C07 §3.3 |
| `C07-S22` | Matrix keyboard navigation | Arrow keys when matrix has focus | Roving focus: arrows move between cells. Enter opens slide-in. Escape closes slide-in or clears search. | C07 §6 |
| `C07-S23` | Search debounce | User types in search bar | 150ms debounce. Matrix filters to matching flag rows. Non-matching rows hidden. | C07 §3.3, §8 |
| `C07-S24` | Gap filter toggle | User switches "All" ↔ "Gaps only" | Matrix re-filters. If "Gaps only" and no gaps → `C07-S02`. | C07 §3.4 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any) | Navigate to `/sovereign` | `C07-S00` | Sovereign fetch |
| (any) | Navigate to `/sovereign` during `G-BOOT-PROGRESSIVE` | `C07-S06` | Cold-load interstitial; 3s auto-retry |
| `C07-S06` | Attribution data arrives (`G-DATA-FULL`) | `C07-S00` | Sovereign fetch fires |
| `C07-S06` | Navigate away | (target view) | Interstitial dismissed |
| `C07-S00` | API returns with gaps | `C07-S01` | Matrix renders |
| `C07-S00` | API returns stale | `C07-S01a` | Matrix + stale indicator |
| `C07-S00` | API returns zero gaps (all parity) | `C07-S01` or `C07-S02` | Depends on gap filter |
| `C07-S00` | API error, no cache | `C07-S05` | Error card |
| `C07-S00` | API error, stale available | `C07-S05a` | Stale matrix + error |
| `C07-S00` | API returns zero flags | `C07-S05b` | Error (not empty) |
| `C07-S00` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C07-S01` | Click cloud card | `C07-S20` → `C07-S01` (highlighted) | Column highlight |
| `C07-S01` | Click/Enter matrix cell | `C07-S10` | Slide-in opens |
| `C07-S10` | Close (✕ / Escape) | `C07-S10a` → `C07-S01` | Focus returns |
| `C07-S01` | Type in search → results | `C07-S23` → `C07-S01` (filtered) | Matrix filters |
| `C07-S01` | Type in search → no results | `C07-S02a` | Search-empty |
| `C07-S01` | Toggle "Gaps only" → no gaps | `C07-S02` | Parity message |
| `C07-S02` | "View full matrix" | `C07-S01` | Filter → "All" |
| `C07-S02a` | Clear search | `C07-S01` | Full matrix |
| `C07-S01` | "Show raw condition" | `C07-S01.j` | Raw block expands |
| `C07-S01` | Refresh starts | `C07-S00` | Re-fetch (always full reload for sovereign) |
| `C07-S05` | Retry | `C07-S00` | Re-fetch |
| `C07-S05a` | Retry | `C07-S00` | Re-fetch |

---

## C. URL / Filter-State Coupling

| State | URL | Params |
|---|---|---|
| Default | `/sovereign` | — |
| Flag filter | `/sovereign?flags=FLTArtifact` | `flags` |
| Env filter | `/sovereign?envs=gcc,dod` | `envs` |
| Gap filter | `/sovereign?gapFilter=gaps-only` | `gapFilter` |
| Cloud filter | `/sovereign?cloud=gcc` | `cloud` (highlights column) |

### C.1 Deep-link cold-load

1. `/sovereign?cloud=gcc` → auth → `C07-S00` → API → `C07-S01` with gcc column auto-highlighted.
2. Malformed params silently ignored.

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C07-S00` | C07 §4 `loading` |
| `C07-S01` | C07 §4 `populated` |
| `C07-S01a` | C07 §4 `stale` |
| `C07-S01.a–o` | C07 §2.2–2.3, §3.3, §5, §7 |
| `C07-S02` | C07 §3.4, §4 `full-parity` |
| `C07-S05–05c` | C07 §7 |
| `C07-S06` | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |
| `C07-S10` | C07 §6 slide-in |
| `C07-S20–24` | C07 §3.2, §3.3, §6, §8 |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| `bleu` exclusion from sovereign set not enforced in API response | LOW | data-model.md §2.2 says `bleu` is not sovereign. C07 §2.1 confirms. But API must exclude it — no spec defines the server-side filter. Architecture.md §5 should clarify. |
| ~~`rawTruncated` threshold (4 KB) not in data-model.md~~ | ~~LOW~~ | **RESOLVED (P3 gate ruling GAP-02):** 4 KB inline-condition truncation is a distinct, valid threshold; will be catalogued in data-model.md. |
| Neutral parity principle visual treatment | MEDIUM | C07 §2.3 says "never red for missing-in-sovereign" but doesn't specify the exact visual for sovereign-ahead gaps. P4 mock must define (grey? blue? dotted?). |
| `usgovcanary` gap significance | LOW | Is a gap in `usgovcanary` (a canary env) as significant as `dod`? Same visual treatment per spec, but PMs may want to differentiate. |

---

**State count:** 28 distinct states (4 primary + 15 domain variants + 2 empty + 4 error + 1 cold-load interstitial + 2 slide-in + 5 interaction)

*Sana — C07 Sovereign state matrix.*
