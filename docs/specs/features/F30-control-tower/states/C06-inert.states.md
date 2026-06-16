# C06 Inert Detection — State Matrix

> **Status:** P3 — State Matrices
> **Owner:** Sana (states), Pixel (rendering)
> **View:** Inert/Stale Intelligence — surfaces flags likely inert (prerequisite OFF) or stale (lifecycle patterns)
> **Canonical data model:** [`data-model.md`](../data-model.md) — StaleReason type
> **Component spec:** [`C06-inert.md`](../components/C06-inert.md)
> **Global states:** [`_global.md`](./_global.md)
> **API endpoint:** `GET /api/ct/inert` → `InertIntelligencePayload`
> **Route:** `/inert` | Filter params: `reason`
> **Last updated:** 2026-06-13

---

## A. State Inventory

### A.1 Boot / Loading States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C06-S00` | Inert loading | Navigate to `/inert`; `GET /api/ct/inert` in flight | Skeleton: KPI card area shows "Analyzing…" with shimmer. Findings list: shimmer cards. Stale observations: shimmer cards. Filter panel: disabled. | Disabled: filters, card expand. Enabled: nav, Cmd-K | `G-DATA-NONE` | API returns → `C06-S01`/`C06-S02`/`C06-S03`; error → `C06-S05` | C06 §7.1 `loading` |

### A.2 Populated States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|---|
| `C06-S01` | Populated — findings exist | API returned with non-empty `findings[]` and/or `staleObservations[]` | **KPI cards:** total findings, high-confidence count, stale count, flags analyzed. **Findings section:** cards per finding (flag name, affected env, prerequisite chain, confidence badge, `InertFinding` detail). **Stale section:** cards per observation (`StaleReason`, days since last change, posture summary). **Filter panel:** active with Confidence/Env/StaleLabel dropdowns. | All: expand/collapse finding cards, filter, keyboard nav (Up/Down/Enter/f/Escape), click flag → C02 | `G-DATA-FULL` | Filter → `C06-S01`; empty filter → `C06-S03a`; navigate | C06 §7.1 `populated` |
| `C06-S02` | Populated — low confidence only | All findings are `INFORMATIONAL` (no definitive inert claims) | Same layout as `C06-S01` but with banner: "No definitive inert flags found — showing informational observations only." All finding cards have low-confidence badge. | All controls enabled | `G-DATA-FULL` | Change confidence filter; refresh | C06 §7.1 `low-confidence` |

### A.3 Domain-Specific Finding Variants

| State ID | Name | Precondition / Trigger | What's rendered | Notes | Source |
|---|---|---|---|---|---|
| `C06-S01.a` | High-confidence inert finding | Prerequisite verified OFF in target env | Card: "Flag [X] may be inert in [env] — prerequisite [Y] is OFF." Confidence: HIGH. Chain visualization if depth > 1. | Core hero feature | C06 §3.1–3.2 |
| `C06-S01.b` | Medium-confidence finding | Prerequisite state partially known or chain depth > 1 | Card: confidence badge MEDIUM. Chain visualization with dashed edges for uncertain links. | C06 §3.2 |
| `C06-S01.c` | INFORMATIONAL — prerequisite unknown | Prerequisite flag not found in FM repo | Card: "Prerequisite [Y] could not be verified — INFORMATIONAL." Blue-grey badge. **Never claims inert.** | R1, R5: false-positive prevention | C06 §2.2.2, §3.3; R1, R5 |
| `C06-S01.d` | INFORMATIONAL — negated dependency | Prose contains negation ("without requiring", "does not depend on") | Card: "Dependency negated — not a prerequisite." INFORMATIONAL badge. | Negation detection in parser | C06 §2.4, §3.3 |
| `C06-S01.e` | INFORMATIONAL — conditional×conditional | Both flags are `'conditional'` — overlap ambiguous | Card: "Both flags conditional — dependency unresolvable." INFORMATIONAL badge. Downgraded from inert claim. | C06 §3.3 Q5 |
| `C06-S01.f` | Chain depth warning | Dependency chain depth > 3 | Card shows chain up to depth 3 with warning: "Chain depth exceeds 3 — deeper analysis not rendered." | C06 §2.3; R5 |
| `C06-S01.g` | Cycle detected | Dependency chain contains a cycle | Card: "Circular dependency detected — analysis stopped." Data-quality observation. Chain visualization shows cycle indicator (↺). | C06 §2.3 |
| `C06-S01.h` | Stale — PROBABLY_LAUNCHED | All mainline envs `'on'` for > 30 days | Stale card: "`PROBABLY_LAUNCHED` — ON across all mainline environments for [N] days (threshold: 30d). Flag code may be removable." | OQ-05: 30d threshold | C06 §4.3; data-model.md §4 |
| `C06-S01.i` | Stale — PROBABLY_DEAD | All 15 envs `'off'` for > 180 days | Stale card: "`PROBABLY_DEAD` — OFF everywhere for [N] days (threshold: 180d). Flag and code may be removable." | OQ-05: 180d threshold | C06 §4.3; data-model.md §4 |
| `C06-S01.j` | Stale — PROBABLY_FORGOTTEN | Not fully rolled out + no changes for > 90 days | Stale card: "`PROBABLY_FORGOTTEN` — last changed [N] days ago, rollout appears stalled." | OQ-05: 90d threshold | C06 §4.3; data-model.md §4 |
| `C06-S01.k` | Stale — ACTIVE_ROLLOUT | Partial rollout with recent activity | Stale card: "`ACTIVE_ROLLOUT` — recent changes detected, rollout in progress." This is NOT a stale finding — it's a positive signal. | Null StaleReason = STABLE (no label) | C06 §4.3; data-model.md §4 |
| `C06-S01.l` | Sovereign gaps in PROBABLY_LAUNCHED | All mainline `'on'` but some sovereign envs still `'off'` | Stale card annotation: "Sovereign gaps exist — medium confidence." Links to C07 sovereign lens for details. | C06 §4.4 Q4 |
| `C06-S01.m` | OFF cell — not applicable | Flag is `'off'` in target env | Finding card does NOT appear for OFF cells — inert analysis only applies to enabled cells. | C06 §3.1 |

### A.4 Empty States

| State ID | Name | Precondition / Trigger | What's rendered | Interactive vs disabled | Exit conditions | Source |
|---|---|---|---|---|---|---|
| `C06-S03` | None detected | API returned empty `findings[]` and empty `staleObservations[]` | Message: "No inert flags detected." + analysis basis line: "Analyzed [N] flags across [M] environments using [P] dependency edges." | Refresh, nav | Refresh; new flags | C06 §7.1 `none-detected`; `G-EMPTY-NO-INERT` |
| `C06-S03a` | Filter-empty | Filters produce zero results | "No findings match your current filters." + "Clear filters" link. KPI cards show filtered counts (all zero). | Change/clear filters | Adjust filters | `G-EMPTY-FILTER` |

### A.5 Partial / Degraded States

| State ID | Name | Precondition / Trigger | What's rendered | Data completeness | Exit conditions | Source |
|---|---|---|---|---|---|---|
| `C06-S04` | Partial data | External prerequisite fetch failed for some flags | FLT-internal findings shown normally. Banner: "Some external prerequisites could not be verified — results may be incomplete." Affected findings downgraded to INFORMATIONAL. | `G-DATA-PARTIAL` | Refresh | C06 §7.1 `partial-data` |
| `C06-S04a` | Parser failure on some flags | Description prose unparseable for some flags | Those flags excluded from inert analysis. Banner: "Parser could not analyze [N] flag descriptions." KPI adjusts "flags analyzed" count. | `G-DATA-PARTIAL` | Refresh; FM repo description fix | C06 §4.4; R1 |

### A.6 Error States

| State ID | Name | Precondition / Trigger | What's rendered | Exit conditions | Source |
|---|---|---|---|---|---|
| `C06-S05` | Error | `GET /api/ct/inert` failed or parser threw unrecoverable error | Error card: "[message]" + Retry. No findings shown. | Retry → `C06-S00` | C06 §7.1 `error` |
| `C06-S05a` | Auth error | 401/403 | Standard auth handling | `G-AUTH-EXPIRED` / `G-AUTH-FORBIDDEN` | — |

### A.7 Stale / Refresh States

| State ID | Name | Precondition / Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C06-S08` | Refresh in progress | Global refresh active | Findings remain visible. Shell refresh indicator. Re-analysis runs on refresh completion. | `G-REFRESH-IN-PROGRESS` |
| `C06-S09` | Stale | Data > 60 min old | Inherits `G-STALE`. Findings shown with stale indicator. | `G-STALE` |
| `C06-S10` | Cold-load interstitial | Navigated to `/inert` while `G-BOOT-PROGRESSIVE`; attribution data not yet available | Interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s. Nav enabled. | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |

### A.8 Interaction / Focus States

| State ID | Name | Trigger | What's rendered | Source |
|---|---|---|---|---|
| `C06-S20` | Finding card expand | Click or Enter on finding card | Card expands to show full dependency chain, affected environments, prerequisite states. `aria-expanded="true"`. Only one chain view at a time (previous collapses). | C06 §6.3, §7.2 |
| `C06-S21` | Filter focused | `f` pressed or filter bar clicked | Filter bar receives focus. Dropdown(s) open on Enter/Space. | C06 §7.2 |
| `C06-S22` | Keyboard card navigation | Up/Down arrows | Focus moves between finding/stale cards. `Enter` toggles expand. `Escape` returns to Grid. | C06 §7.2 |
| `C06-S23` | Grid inert-overlay click | User clicks inert badge on C01 grid cell | Navigates to `/inert` and scrolls to / expands the relevant finding card for that flag. | C06 §6.6, §7.2 |

---

## B. Transition Table

| From State | Event | To State | Side effect |
|---|---|---|---|
| (any) | Navigate to `/inert` | `C06-S00` | Inert fetch |
| `C06-S00` | API returns findings | `C06-S01` | Findings render |
| `C06-S00` | API returns low-confidence only | `C06-S02` | Low-confidence banner |
| `C06-S00` | API returns empty | `C06-S03` | None-detected message |
| `C06-S00` | API returns partial | `C06-S04` | Partial data banner |
| `C06-S00` | API returns error | `C06-S05` | Error card |
| `C06-S00` | 401 | `G-AUTH-EXPIRED` | Redirect |
| `C06-S01` | Apply filter → results | `C06-S01` (filtered) | Re-filter |
| `C06-S01` | Apply filter → empty | `C06-S03a` | Filter-empty |
| `C06-S01` | Expand finding card | `C06-S20` | Chain view opens |
| `C06-S01` | Click flag name | C02 loads | Navigate to dossier |
| `C06-S01` | Click sovereign gap link | C07 loads | Navigate to sovereign lens |
| `C06-S01` | Refresh starts | `C06-S08` | Shell indicator |
| `C06-S01` | Stale timer | `C06-S09` | Stale indicator |
| `C06-S03a` | Clear filters | `C06-S01` | All findings visible |
| `C06-S04` | Refresh succeeds | `C06-S01` or `C06-S03` | Re-analysis |
| `C06-S05` | Retry | `C06-S00` | Re-fetch |
| `C06-S08` | Refresh completes | `C06-S00` → `C06-S01`/`C06-S03` | Re-analysis |
| `C06-S20` | Collapse card | `C06-S01` | Card collapses |
| `C06-S22` | Escape | C01 (grid) | Navigate back |
| `C06-S23` | (from C01) | `C06-S01` (scrolled) | Finding highlighted |
| (any) | Navigate to `/inert` during `G-BOOT-PROGRESSIVE` | `C06-S10` | Cold-load interstitial; 3s auto-retry |
| `C06-S10` | Attribution data arrives (`G-DATA-FULL`) | `C06-S00` | Inert fetch fires |
| `C06-S10` | Navigate away | (target view) | Interstitial dismissed |

---

## C. URL / Filter-State Coupling

| State | URL | Params |
|---|---|---|
| Default | `/inert` | — |
| Filtered by reason | `/inert?reason=PROBABLY_LAUNCHED` | `reason` |
| Filtered by confidence | `/inert?confidence=high` | `confidence` |
| Filtered by env | `/inert?env=prod` | `env` |

### C.1 Deep-link cold-load

1. `/inert?reason=PROBABLY_DEAD` → auth → fetch → `C06-S01` with filter pre-applied.
2. If warm store cold → API may return partial or delayed data → `C06-S04` or retry.

### C.2 Grid cross-link

When navigating from C01 inert badge to C06, the URL may include a `?flag=` param to auto-scroll to the relevant finding card.

---

## D. Source Trace

| State ID | Primary source |
|---|---|
| `C06-S00` | C06 §7.1 `loading` |
| `C06-S01` | C06 §7.1 `populated` |
| `C06-S02` | C06 §7.1 `low-confidence` |
| `C06-S01.a–m` | C06 §2.2–2.4, §3.1–3.3, §4.3–4.4; data-model.md §4; R1, R5 |
| `C06-S03` | C06 §7.1 `none-detected` |
| `C06-S04` | C06 §7.1 `partial-data` |
| `C06-S05` | C06 §7.1 `error` |
| `C06-S08–09` | `G-REFRESH-IN-PROGRESS`; `G-STALE` |
| `C06-S10` | P3 gate ruling R1; `G-BOOT-INTERSTITIAL` |
| `C06-S20–23` | C06 §6.3, §6.6, §7.2 |

### D.1 Gaps identified

| Gap | Severity | Notes |
|---|---|---|
| INFORMATIONAL vs INERT UI distinction underspecified | MEDIUM | C06 §3.3 defines the boundary but C06 spec doesn't specify how the card visuals differ (same card type with different badge? different card template?). P4 must decide. |
| Parser metadata display not specified | LOW | `parserMeta` in the payload includes pattern counts, match quality, etc. Spec doesn't say whether this is shown to users or is debug-only. Recommend: collapsed "Analysis details" section. |
| `ACTIVE_ROLLOUT` stale reason is a positive signal | LOW | Including it in the "stale" section may confuse PMs. Consider separate "active rollouts" section or excluding from stale list. |
| ~~C06 ↔ C01 cross-navigation param (`?flag=`) not in data-model.md route table~~ | ~~LOW~~ | **RESOLVED (P3 gate ruling GAP-03):** `/inert` gains a `flag` filter param in data-model route table. C06→C01 nav state retained. |

---

**State count:** 28 distinct states (6 primary + 13 domain variants + 2 partial + 2 error + 1 cold-load interstitial + 4 interaction)

*Sana — C06 Inert state matrix.*
