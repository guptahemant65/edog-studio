# F30 Control Tower — P3 State Matrices Index

> **Status:** P3 — State Matrices — COMPLETE
> **Phase:** P0 ✅ → P1 ✅ → P2 ✅ → **P3 ✅** → P4 → P5
> **Owner:** Sana (state architecture), Pixel (loading & error rendering)
> **Last updated:** 2026-06-13
> **Note:** P3-gate rulings are recorded in §3.4 below. All gap/risk dispositions are final.

---

## 1. File Index

| File | View / Scope | State count | Description |
|---|---|---|---|
| [`_global.md`](./_global.md) | Cross-cutting | 38 | Auth lifecycle, app boot/cold-load (incl. interstitial), refresh (atomic), freshness poll machine, freshness indicators, error boundary, network, accessibility, theme |
| [`C01-grid.states.md`](./C01-grid.states.md) | C01 Grid | 25 | Posture grid — 42 flags × 15 envs, progressive loading, filter/sort/search, sovereign expand, "Removed from master" badge |
| [`C02-dossier.states.md`](./C02-dossier.states.md) | C02 Flag Dossier | 31 | Single-flag deep-dive (Zones A–D), inert/stale signals, diff loading, pin/timeline modes, historical dossier (`?asOf`) |
| [`C03-ladder.states.md`](./C03-ladder.states.md) | C03 Promotion Ladder | 30 | Distribution view + per-flag spine, dwell, graduation, skipped rungs, off-ladder envs, regression badge, cold-load interstitial |
| [`C04-activity.states.md`](./C04-activity.states.md) | C04 Activity Stream | 29 | Chronological feed, timeline dot strip, detail diffs, date range, freshness-poll-driven "new events" banner, timeline-unavailable placeholder |
| [`C05-timetravel.states.md`](./C05-timetravel.states.md) | C05 Time Travel | 29 | Historical reconstruction, thumb/track interaction, `not-yet-created`, diff highlighting, pinned `reconstructedAt`, cold-load interstitial |
| [`C06-inert.states.md`](./C06-inert.states.md) | C06 Inert Detection | 28 | Dependency chain analysis, INFORMATIONAL vs inert, stale observations, confidence tiers, cold-load interstitial |
| [`C07-sovereign.states.md`](./C07-sovereign.states.md) | C07 Sovereign Lens | 28 | Prod vs 7 sovereign cloud parity, GapKind variants, slide-in panel, neutral parity, cold-load interstitial |
| [`C08-velocity.states.md`](./C08-velocity.states.md) | C08 Velocity | 27 | TTP metrics, dot plot, cohort charts, trend, dwell variants, insufficient history, cold-load interstitial |
| [`C09-shell.states.md`](./C09-shell.states.md) | C09 Shell + Cmd-K | 35 | Top-level app states, routing, freshness chip (incl. newer-head-detected), palette, saved views (incl. max overflow), theme, auth shell, atomic rollback |
| **Total** | | **300** | |

---

## 2. Exhaustiveness Checklist

For every view, this checklist confirms that each mandatory category was addressed. ✅ = covered in the state file, with specific state IDs.

| Category | C01 | C02 | C03 | C04 | C05 | C06 | C07 | C08 | C09 | Global |
|---|---|---|---|---|---|---|---|---|---|---|
| **Boot / initial loading** | ✅ S00 | ✅ S00 | ✅ S00, S10 | ✅ S00, S00a | ✅ S00 | ✅ S00 | ✅ S00 | ✅ S00 | ✅ S00–S02 | ✅ §3 |
| **Progressive (state-only → full)** | ✅ S01 | ✅ S01a | ✅ S13 | ✅ (via global) | ✅ (via global) | ✅ (via global) | ✅ (via global) | ✅ (via global) | ✅ S02 | ✅ §3.1 |
| **Fully hydrated / populated** | ✅ S02 | ✅ S01 | ✅ S01, S11 | ✅ S01 | ✅ S03 | ✅ S01 | ✅ S01 | ✅ S01 | ✅ S03 | ✅ §3.1 |
| **Empty — corpus** | ✅ S03a | ✅ (N/A — per-flag) | ✅ S03 | ✅ S03b | ✅ S03.b | ✅ S03 | ✅ S05b | ✅ S03 | ✅ (delegates) | ✅ §8.2 |
| **Empty — filter/search** | ✅ S03 | ✅ (N/A) | ✅ (search filter) | ✅ S03 | ✅ (N/A) | ✅ S03a | ✅ S02a | ✅ S03a | ✅ (palette S33) | ✅ §8.2 |
| **Empty — domain-specific** | ✅ (N/A) | ✅ S02 (never changed) | ✅ (off-ladder) | ✅ S03a (date range) | ✅ S03.b (before first commit) | ✅ S03 (none detected) | ✅ S02 (full parity) | ✅ S03 (insufficient) | ✅ (N/A) | ✅ §8.2 |
| **Partial / degraded data** | ✅ S04, S04a–c | ✅ S04, S04a–d | ✅ S12, S16 | ✅ S07 | ✅ (404s → not-yet-created) | ✅ S04, S04a | ✅ S01.m, S01.l | ✅ S01.j, S05b | ✅ S73 | ✅ §8.1 |
| **Attribution absent** | ✅ S04a | ✅ S04d | ✅ S12 | ✅ S01d, S01e | ✅ (N/A — no attrib in TT grid) | ✅ (via global) | ✅ S01.m | ✅ S01.j | ✅ (delegates) | ✅ §8.4 |
| **Error — 401 session expired** | ✅ (→ G-AUTH) | ✅ (→ G-AUTH) | ✅ (→ G-AUTH) | ✅ S05a | ✅ S07a | ✅ S05a | ✅ S05c | ✅ S05e | ✅ S61 | ✅ §6.1 |
| **Error — 403 forbidden** | ✅ (→ G-AUTH) | ✅ (→ G-AUTH) | ✅ (→ G-AUTH) | ✅ S05a | ✅ S07a | ✅ S05a | ✅ S05c | ✅ S05e | ✅ (→ G-AUTH) | ✅ §6.1 |
| **Error — 429 rate limit** | ✅ S07 | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ S05a | ✅ (→ G-ERR) | ✅ §6.1 |
| **Error — 5xx / network** | ✅ S05, S06 | ✅ S05 | ✅ S05, S06 | ✅ S05 | ✅ S07 | ✅ S05 | ✅ S05, S05a | ✅ S05 | ✅ S06 | ✅ §6.1 |
| **Error — per-endpoint timeout** | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ S06 | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ (→ G-ERR) | ✅ §6.1 |
| **Diff too large (>256 KB)** | ✅ (N/A) | ✅ S04 | ✅ S11.i | ✅ S12a | ✅ (N/A) | ✅ (N/A) | ✅ S01.l (4KB) | ✅ (N/A) | ✅ (N/A) | — |
| **Stale indicator (>60 min)** | ✅ S11 | ✅ (→ G-STALE) | ✅ S02 | ✅ S08a | ✅ (→ G-STALE) | ✅ S09 | ✅ S01a | ✅ S01a | ✅ S16 | ✅ §5 |
| **Refresh in progress** | ✅ S08 | ✅ S07 | ✅ (→ G-REFRESH) | ✅ S08 | ✅ S28 | ✅ S08 | ✅ (→ G-REFRESH) | ✅ S01b | ✅ S04 | ✅ §4 |
| **Refresh success** | ✅ S09 | ✅ (re-fetch) | ✅ (re-fetch) | ✅ (feed updated) | ✅ (bounds refresh) | ✅ (re-analysis) | ✅ (re-fetch) | ✅ (re-render) | ✅ (toast) | ✅ §4.1 |
| **Refresh failed** | ✅ S10 | ✅ (→ G-REFRESH) | ✅ (→ G-REFRESH) | ✅ S06 | ✅ (→ G-REFRESH) | ✅ (→ G-REFRESH) | ✅ (→ G-REFRESH) | ✅ (→ G-REFRESH) | ✅ S05 | ✅ §4.1 |
| **Domain edge cases** | ✅ S02.a–j | ✅ S01.a–l | ✅ S11.a–i | ✅ S01a–h | ✅ S03.a–g | ✅ S01.a–m | ✅ S01.a–o | ✅ S01.a–n | ✅ S70–73 | — |
| **Hover / tooltip** | ✅ S20, S21 | ✅ S20 | ✅ S20–22 | ✅ S22, S24 | ✅ S23 | ✅ (via cards) | ✅ S21 | ✅ S20 | ✅ (chip tooltip) | — |
| **Focus-visible / keyboard** | ✅ S22–25 | ✅ S21 | ✅ (keyboard nav) | ✅ S25–27 | ✅ S25 | ✅ S22 | ✅ S22 | ✅ S25 | ✅ §9.1–9.4 | ✅ §9 |
| **Accessibility (live regions)** | ✅ §5.3 ref | ✅ §3.5.5 ref | ✅ §3.3.5 ref | ✅ §6.7 ref | ✅ §7.3–7.4 ref | ✅ (via global) | ✅ §6 ref | ✅ §4.6 ref | ✅ §9.3 | ✅ §9 |
| **Reduced motion** | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ (→ G-A11Y) | ✅ §9.5 ref | ✅ §9 |
| **URL / deep-link** | ✅ §C | ✅ §C | ✅ §C | ✅ §C | ✅ §C | ✅ §C | ✅ §C | ✅ §C | ✅ §C | — |
| **Source trace** | ✅ §D | ✅ §D | ✅ §D | ✅ §D | ✅ §D | ✅ §D | ✅ §D | ✅ §D | ✅ §D | — |

---

## 3. Open Gaps for P3 Gate

These are contradictions, ambiguities, or missing specifications discovered during state enumeration. They must be resolved at the P3 gate before P4 mock begins.

### 3.1 Cross-Spec Contradictions

| # | Gap | Severity | Affected | Details |
|---|---|---|---|---|
| GAP-01 | C08 stale threshold (15 min) vs global (60 min) | MEDIUM | C08, `_global.md` | C08 §5 references `populated-stale` after 15 min but architecture.md §6.3 uses 60 min as the staleness threshold. These must be reconciled — does velocity have a more aggressive stale threshold, or is C08 spec in error? **Recommendation:** use global 60-min threshold everywhere for V1. |
| GAP-02 | C07 raw truncated threshold (4 KB) not in data-model.md | LOW | C07, data-model.md | C07 §2.2 uses 4 KB for inline condition block truncation. data-model.md §6/OQ-04 only defines 256 KB for diff payloads. These are distinct thresholds but both should be catalogued in data-model.md. |
| GAP-03 | C06 ↔ C01 cross-navigation `?flag=` param missing from route table | LOW | C06, C01, data-model.md §5 | data-model.md §5 doesn't list `flag` as a filter param for `/inert`. C06 §6.6 implies navigation from C01 inert badge to a specific finding. Add `flag` param to `/inert` route or use URL fragment. |

### 3.2 Under-Specified States

| # | Gap | Severity | Affected | Details |
|---|---|---|---|---|
| GAP-04 | `?asOf` param from C05 to C02 not fully specified | MEDIUM | C02, C05 | C02 §3.1 mentions entry from C05 with `asOf` date but doesn't specify what historical dossier rendering looks like. Does Zone C show state at that date? Does Zone D filter the timeline? Needs P3 ruling. |
| GAP-05 | Rung regression semantics undefined in C03 | MEDIUM | C03 | C03 §5 Q4: If `prod: on → prod: off` (regression), the ladder currently only tracks first-non-off. Should regression reset `isFullyPromoted`? How is it visualized? |
| GAP-06 | Auto-refresh detection mechanism unspecified in C04 | MEDIUM | C04 | ~~C04 §4.3 mentions "new events detected" banner but V1 is manual-refresh only (C09 §11). If auto-refresh is V2, the banner may be premature.~~ **RESOLVED — see §3.4.** V1 includes passive freshness polling (CEO override). |
| GAP-07 | Mid-refresh reconstruction handling in C05 | MEDIUM | C05 | C05 §5 says refresh must "complete or abort+retry" without choosing. Recommend: reconstruction completes; refresh queues. |
| GAP-08 | INFORMATIONAL vs INERT card visual distinction in C06 | MEDIUM | C06 | C06 §3.3 defines the semantic boundary but not the visual distinction. P4 mock must decide: same card type with different badge? Different card colour/template? |
| GAP-09 | Neutral parity visual treatment in C07 | MEDIUM | C07 | C07 §2.3 says "never red for sovereign-ahead" but doesn't specify what sovereign-ahead gaps look like visually. Grey? Blue? Dotted border? |
| GAP-10 | Deleted-from-master flag behaviour | LOW | C01 | If flag discovery only reads HEAD, deleted flags are invisible. If warm store retains history, they appear as `C01-S02.h`. Architecture.md §3 should clarify. |
| GAP-11 | `not-yet-created` visual treatment in C05 | LOW | C05 | C05 §2.1 defines the state but no visual spec (muted? hatched? special icon?). P4 mock decides. |
| GAP-12 | Saved views max-20 overflow UX | LOW | C09 | What happens when user tries to save view #21? Recommend: "Maximum saved views reached — delete one first." |
| GAP-13 | Timeline API independent failure in C04 | LOW | C04 | If `/activity/timeline` fails but `/activity` succeeds, should feed render without dot strip? Recommend yes, with "Timeline unavailable" placeholder. |

### 3.4 P3 Gate Rulings (RESOLVED 2026-06-13)

All gaps and risks from §3.1–3.2 and §4 have been dispositioned at the P3 gate. This table records every ruling.

| ID | Disposition | Resolution | State files modified |
|---|---|---|---|
| GAP-01 | **RESOLVED** | 60-min stale threshold everywhere. C08's 15-min was a spec error. | `C08-velocity.states.md` (`C08-S01a`) |
| GAP-02 | **RESOLVED** | 4 KB inline-condition truncation is a distinct, valid threshold; will be catalogued in data-model.md. | `C07-sovereign.states.md` (gap updated) |
| GAP-03 | **RESOLVED** | `/inert` gains a `flag` filter param in data-model route table. C06→C01 nav state retained. | `C06-inert.states.md` (gap updated) |
| GAP-04 | **RESOLVED** | Full historical dossier. `?asOf` renders Zone C as-of-date, Zone D truncated, "Viewing as of {date}" banner + exit. | `C02-dossier.states.md` (`C02-S08`, `C02-S08a`, `C02-S08b`) |
| GAP-05 | **RESOLVED** | Keep history. `firstEnabledDate` immutable. Regression renders "Reached [date] · now OFF" badge. | `C03-ladder.states.md` (`C03-S11.j`) |
| GAP-06 | **RESOLVED (CEO OVERRIDE)** | V1 keeps auto-refresh banner with lightweight update polling (60s, `GET /api/ct/updates`). Poll = detection only (`newerHeadAvailable` + `pendingCommitCount`); refresh = manual + atomic. Reverses NOTE-03. | `_global.md` (§4.4 poll machine), `C04-activity.states.md` (`C04-S01h`), `C09-shell.states.md` (`C09-S19`) |
| GAP-07 | **RESOLVED** | Reconstruction completes; refresh queues until reconstruction finishes. | `C05-timetravel.states.md` (`C05-S28`) |
| GAP-08 | **DEFERRED to P4** | Visual treatment for INFORMATIONAL vs INERT cards. Phantom decides. | — |
| GAP-09 | **DEFERRED to P4** | Neutral parity visual treatment. Phantom decides. | — |
| GAP-10 | **RESOLVED** | Deleted-from-master flags retained in warm store with "Removed from master" badge. | `C01-grid.states.md` (`C01-S02.h`) |
| GAP-11 | **DEFERRED to P4** | `not-yet-created` visual treatment. Phantom decides. | — |
| GAP-12 | **RESOLVED** | "Maximum saved views reached — delete one first." | `C09-shell.states.md` (`C09-S43a`) |
| GAP-13 | **RESOLVED** | Feed renders with "Timeline unavailable" placeholder on independent timeline API failure. | `C04-activity.states.md` (`C04-S07a`) |
| R1 | **RESOLVED** | Non-grid views during cold-load show interstitial: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." + 3s auto-retry. | `_global.md` (`G-BOOT-INTERSTITIAL`), `C03` (`C03-S18`), `C05` (`C05-S09`), `C06` (`C06-S10`), `C07` (`C07-S06`), `C08` (`C08-S06`) |
| R2 | **RESOLVED** | Atomic refresh. ANY partial failure → roll back to last-good vintage. No mixed-vintage. No per-row staleness. | `_global.md` (removed `G-REFRESH-PARTIAL`), `C01` (`C01-S10`), `C09` (`C09-S05`, `C09-S73`) |
| R3 | **RESOLVED** | Pin `reconstructedAt` at TT entry; do not advance on mid-session refresh. | `C05-timetravel.states.md` (`C05-S03.f`, `C05-S28`) |

| # | Note | Affected |
|---|---|---|
| NOTE-01 | All views inherit `G-ERR-401`, `G-ERR-403`, `G-ERR-429`, `G-ERR-5XX` from `_global.md`. Per-view files reference these by ID rather than redefining. | All |
| NOTE-02 | Attribution absence is always **silent omission** — never "Unknown", never placeholder. Defined once in `_global.md` §8.4 (`G-ATTR-ABSENT`). | All |
| NOTE-03 | **V1 includes passive update polling** (CEO override GAP-06). Client polls `GET /api/ct/updates` every 60s to detect that `master` HEAD advanced (`newerHeadAvailable: true`). When detected, surfaces "{pendingCommitCount} new changes available — Refresh" banner (`G-POLL-NEWER-HEAD`, `C09-S19`, `C04-S01h`). `/api/ct/freshness` is metadata-only (chip rendering) and cannot detect remote advances. Actual data refresh remains **manual + atomic** (user-triggered; no auto-mutation of warm store). Polling = detection only; refresh = user-triggered and atomic. | C04, C09, `_global.md` §4.4 |
| NOTE-04 | CellState tokens are always full: `'off'`, `'on'`, `'conditional'`, `'targeted'`. Never abbreviated. | All |
| NOTE-05 | "Owner" / "Maintainer" labels are **never used**. Only "Last enabled by" / "Last modified by" / "Created by" per data-model.md §3.1. | All |

---

## 4. Risk Assessment — 3 Most Overlooked States (ALL RESOLVED)

These were the three states that P3 surfaced which were **not explicitly anticipated** in any component spec. All have been resolved at the P3 gate.

### Risk 1: Progressive Grid During Cold-Load Navigation — **RESOLVED (R1)**

**What:** When a user arrives during a cold-load (~30s), the grid shows state-only data (no attribution). If they immediately navigate to C03 Ladder or C08 Velocity, those views require attribution/history data that hasn't arrived yet.

**Resolution:** Each non-grid view now has a cold-load interstitial state (`C03-S18`, `C05-S09`, `C06-S10`, `C07-S06`, `C08-S06`) inheriting from `G-BOOT-INTERSTITIAL`: "Attribution data is still loading ([N]/42 complete). This view will be available shortly." Auto-retries every 3s.

### Risk 2: Refresh Failure with Partial Success — **RESOLVED (R2: Atomic Rollback)**

**What:** A refresh updates 30 of 42 flags successfully but 12 fail (429/timeout). The warm store would have a mixed-vintage dataset.

**Resolution:** **Atomic refresh.** On ANY partial failure, roll back to last-good vintage. NEVER commit mixed-vintage data. `G-REFRESH-PARTIAL` removed entirely. All views show "Refresh incomplete — showing last-good data from {time}. Retry." No per-row amber indicator. No per-flag staleness. (`_global.md` §4, `C01-S10`, `C09-S05`, `C09-S73`)

### Risk 3: Time Travel Mid-Rollout + Diff From Current — **RESOLVED (R3: Pinned reconstructedAt)**

**What:** If a refresh occurs mid-TT-session, `reconstructedAt` changes, and the diff highlighting could shift without the user re-selecting a date.

**Resolution:** Pin `reconstructedAt` at TT entry. Do not update it on refresh. If the user wants the new baseline, they must exit and re-enter TT. (`C05-S03.f`, `C05-S28`)

---

*Sana — P3 state matrices complete. 300 states across 10 files. All 13 gaps and 3 risks dispositioned at P3 gate (10 RESOLVED, 3 DEFERRED to P4). Every state traces to a spec section, a P2 ruling, a P3 gate ruling, or is explicitly flagged as a gap.*
