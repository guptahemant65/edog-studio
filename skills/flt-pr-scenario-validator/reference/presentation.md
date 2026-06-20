# Presentation Contract — How the Skill Renders

This is the **UX source of truth**. The skill is a terminal conversation, so its UI *is* its output. Every beat must render to the layout, symbols, and **state matrix** below — consistently, on every run. The companion visual is `docs/design/mocks/flt-pr-scenario-validator-journey.html`.

The skill emits **Markdown + Unicode**. It cannot set arbitrary terminal colors, so **state is carried by symbol + label + structure**, never by color alone.

---

## 1. Design principles (Palantir-calm)

1. **Restraint is the default.** Healthy, expected states are plain — no decoration, no celebration. A passing scenario is a quiet `✓`, not a banner.
2. **Marks signal exceptions.** Reserve `▲` and `✕` for things that need attention (a regression, a needs-human-eyes item, a harness blockage). If everything is marked, nothing is.
3. **Honesty over polish.** A `SUSPECTED`, a `not provably exercised`, or a `COULD NOT VALIDATE` is shown plainly and never dressed up as a pass. Phase-1 confidence is stated, not implied.
4. **Every fact carries its citation.** Inline, dim, right after the claim: `retry fired 5× [retry #1851]`. No citation → the claim does not appear.
5. **The user is always oriented.** Each beat opens with one `▸` action line saying what is happening and why; each gate states exactly what will happen on `y`.
6. **No emoji, ever.** Unicode marks only (§2). (The current mock uses a `lock emoji` — do **not** reproduce it; use `▣`.)

---

## 2. Symbol vocabulary (Unicode only)

| Mark | Meaning | Use |
|---|---|---|
| `◆` | Headline / named block | Section titles, result boxes |
| `▸` | Action in progress | The one-line "what I'm doing" per beat |
| `✓` | Success / grounded fact | A passed check, a confirmed fact |
| `✕` | Failure / regression | A change-attributable failure |
| `▲` | Warning / needs human eyes | Security-sensitive, prod-like, suspected, harness limit |
| `◇` | Coverage / meta | The coverage line, run metadata |
| `▣` | Locked | The locked-target block (replaces the mock's emoji) |
| `▹` | Pending / queued sub-step | A step not yet run in a progress list |
| `…` | Working | Trailing an in-flight reasoning/step line |
| `·` | Separator | Inline metadata: `F4 · empty lh · safe` |

Emphasis: **bold** for the one number that matters in a line (`**3 of 4** behave as intended`); dim/parenthetical for citations and asides. Never bold a whole line.

---

## 3. Layout primitives

**Action line** (opens every beat):
```
▸ Understanding the change — reading the diff and the FLT repo myself
```

**Fact / result line** (indented two spaces, citation trailing):
```
  ✓ DAG completes, final state Completed            [dag #1402]
```

**Named box** (headline + key-value; for the structural map, locked target, root cause, verdict):
```
◆ Grounded structural map
  Subsystems    retry policy · token flow
  Entry points  runDAG · POST /insights/summary
  Config facts  maxRetries=3 · tokenTTL=15m
  Not reachable ComputeJitter() — private helper        ▲
```

**Menu** (selectable rows; marker · name · meta):
```
  +  Create fresh sandbox                  F2 · ~$0.36/hr · auto-torn-down
  a  robust_goodfellow_18                  F4 · empty lh · safe
  b  prod-mirror-eastus                    F64 · has data · ▲ prod-like
```

**Gate** (a decision; always state the consequence and the options):
```
▸ Run this plan?   edit / drop N / add … / y
```

**Progress** (long fire-and-poll op; percent + step rail):
```
▸ Deploy · 50%   3/6 dotnet build…
  ✓ fetch MWC token   ✓ patch FLT source   ✓ inject DevMode   ▹ dotnet build   ▹ launch FLT   ▹ await DevConnection
```

**Checkpoint** (before a multi-minute background phase):
```
▸ Running scenarios — checkpointing as I go, you can step away.
```

---

## 4. State matrices (per beat)

Each beat declares **every** state it can render — not just the happy path. `STOP` = end the run cleanly here. `harness` = a blockage that is never a verdict on the change.

### Beat 1 — Invoke

| State | When | Render |
|---|---|---|
| PR resolved | open PR on branch, or explicit `#/URL` | `✓ Found open PR #982144 — "title"` + repo · file/line counts |
| No PR | no open PR and none given | `STOP`: `▲ No open PR on this branch. Point me at one: edog qa <PR#\|URL>`. **Server not started.** |
| Lock held | another validation is live | `STOP`: `▲ A validation is already running (PR #X, started 4m ago). It finishes or times out before I can start.` |
| Lock reclaimed | prior holder's heartbeat is stale | proceed, dim note: `(reclaimed a stale lock from a crashed run)` |
| Server failed | `:5555` won't come up | `harness`: `▲ Couldn't start the EDOG server — <reason>. Not a verdict on your change.` |
| Bearer expiring | `bearerExpiresIn` low / no saved session | `▲ Bearer expires in Nm and no session is saved to auto-refresh — re-auth before the long run.` |

### Beat 2 — Orient

| State | When | Render |
|---|---|---|
| Structural map | runtime surface exists | the map box (§3) + `▸` reasoning lines, each `✓` cited to `file:line` |
| No runtime surface | docs/build/IaC/test-only diff | `STOP`: `No runtime-validatable surface in this PR — nothing to deploy or exercise.` |
| Security-sensitive | auth posture / permission filter / authenticator wiring changed | `▲ Authorization config changed — NOT validatable in EDOG (auth disabled in dev). Flagged for human/security review.` (detect-only, never "passed") |
| Novel area | no subsystem-map match | dim note: `(novel area — investigating the FLT source directly)` then proceed |
| Ambiguous wiring | dynamic/conditional DI | dim note: `(static read ambiguous — querying the runtime DI registry)` |

### Beat 3 — Plan gate

| State | When | Render |
|---|---|---|
| Plan proposed | scenarios derived | the scenario menu + `▸ Run this plan?` gate |
| Edited | user types `drop N` / `add …` / `edit` | `✓ Updated — dropped X, added "Y"` then the locked summary line |
| Contract-diff added | controller/DTO change | a `contract` scenario auto-listed |
| Flag scenario added | `FeatureNames.` in diff | a `flag ON/OFF` scenario auto-listed |
| Locked | user accepts (`y`) | `◆ N scenarios locked · 2 happy · 1 edge · 1 …` |

### Beat 4 — Environment

| State | When | Render |
|---|---|---|
| Menu | candidates listed | enriched workspace menu (cost · empty/has-data · prod flag) + select gate |
| Existing fits | `qa_infra_spec.fitness` ok | `✓ Reusing <name> (empty lakehouse — full freedom)` |
| Existing short | fitness gap | a "what's missing" box (`missing tables`, `mlvs`, `property_mismatch: cdf`) + offer fresh |
| Fresh seed | user picks `+` | seed progress: `▸ Seeding · schema lakehouse → notebook → tables → MLVs` (each step `✓`/`▹`) |
| Prod-like / has-data | risk `prod_like`/`has_data` chosen | extra gate: `▲ <name> holds real data. Writes/chaos touch it. Proceed?` |
| Locked | after selection | the `▣ Target locked` box (workspace/lakehouse/capacity GUIDs) + `No other target is addressable. I only destroy what I create.` |

### Beat 5 — Deploy & Run

| State | When | Render |
|---|---|---|
| Deploy | gate `y` | `▸ Deploy · %` progress rail; on done `✓ FLT running on :5557 (3m12s)` |
| Deploy failed | SSE error / build error | `harness`: `▲ COULD NOT VALIDATE — deploy failed at step N (<reason>). Environment problem, not a verdict.` |
| HEAD mismatch | deployed commit ≠ PR commit (minus injection set) | `harness`: `▲ Deployed commit ≠ PR commit — re-deploying / aborting. Not a verdict.` |
| Precondition set | flag forced + re-read confirms | dim: `✓ FLTMLVWarnings ON (effectiveForMyWorkspace confirmed)` |
| Flag unforceable | flag `locked`/`missing` | `▲ Flag <X> can't be forced (locked) — harness limitation, surfaced not failed.` |
| Scenario pass | invariants hold, asserted | `✓ <scenario>` + cited evidence |
| Scenario regression | reproduced, change-attributable | `✕ <scenario>` + the failing fact, cited |
| Infra-shaped | 429/430/503 | retry once; if it recurs `▲ infra (430 capacity throttling) — not your change`; else pass |
| NoRefresh | node policy `NOREFRESH` | `✓ <scenario> — nothing changed to refresh (NOREFRESH)` (a success) |
| Cascade skip | node `Skipped` from a failed parent | `◇ <node> skipped (upstream <parent> failed) — not attributed to this change` |
| Token expiring | `bearerExpiresIn` low mid-run | `▸ Re-checking token before the next long op…` then refresh/re-auth |

### Beat 6 — Investigate (Phase-1 honest)

| State | When | Render |
|---|---|---|
| Retry-once | transient infra-shaped failure | dim: `(retrying once — transient 430)` |
| Flag A/B | flag-gated path | re-run ON vs OFF, show both outcomes |
| Suspected | anomaly that needs fault injection to confirm | `▲ SUSPECTED` box: the code fact (cited) + the observed gap (cited) + the labeled inference + `could NOT confirm without fault injection (Phase N)` |
| Flaky | a pass that isn't reproducible | `▲ FLAKY — passed 2/3 re-runs; reported as flaky, not pass` |
| (Confirmed) | — | **Phase N only.** Do not render a "confirmed root cause" in Phase 1. |

### Beat 7 — Verdict

| State | When | Render |
|---|---|---|
| Risk synthesis | always, first | the `◆ Risk` block: *threatens · proven safe · needs your eyes* |
| Per-scenario | each scenario | `✓ PASS` / `✕ REGRESSION` / `▲ SUSPECTED` / `▲ COULD NOT VALIDATE` (harness) / `◌ NOT PROVABLY EXERCISED` |
| Coverage | always | `◇ coverage: 3 tested · 1 suspected · 1 not-reachable (named, honestly)` |
| Stale | PR HEAD advanced since validation | `▲ STALE — validated abc123; PR HEAD is now def456. Re-run.` |
| Approval gate | before any PR post | `▸ Post this to PR #982144?  y / edit / no` — never posts silently |
| Posted | author approves | `✓ Comment posted to PR #982144` |
| Cleanup (pass) | verdict clean | `✓ Cleaned up — 0 leaked rules, 0 flag overrides, sandbox released (ledger reversed)` |
| Cleanup (fail) | a real regression | `▸ Keep the environment for debugging?  keep / teardown` |

---

## 5. The verdict template (Phase-1-honest)

```
◆ FLT PR Scenario Validator — PR #982144 "retry policy + token mint reorder"
  validated commit abc1234 · run #4471 · 16.2s

◆ Risk
  threatens     token lifecycle (reliability) · 1 new endpoint (API contract)
  proven safe   contract additive · core-smoke green · data converges
  needs eyes    1 SUSPECTED token regression (unconfirmable in Phase 1)
                1 path not provably exercised

  ✓ PASS        DAG completes, final state Completed              [dag #1402]
  ✓ PASS        GET /insights/summary → 200, schema valid, body asserted [http #1455]
  ✓ PASS        Null capacity → graceful 400                      [http #1460]
  ▲ SUSPECTED   Token lifetime across a long DAG write
                  code:     mint moved earlier (TokenManager.cs:88)
                  observed: token minted T+2.3s [token #1203]; write reached T+14.1s [http #1881]
                  inference (suspected): a longer DAG could outlive the token before the final write.
                  could NOT confirm without fault injection (Phase N).

  ◌ NOT PROVABLY EXERCISED   ComputeJitter() — no stimulus reached it; manual check needed

  ◇ coverage: 3 tested · 1 suspected · 1 not-reachable
  ◇ confidence: data + contract HIGH (deterministic) · token regression SUSPECTED

▸ Post this to PR #982144?   y / edit / no
```

(`◌` = not-provably-exercised; a hollow mark, distinct from pass/fail.) The Phase-3 HTML "causal board" replaces nothing here — it links from the PR comment.

---

## 6. Cross-cutting honesty rules (Phase-1 boundaries)

- **Harness ≠ test.** A deploy failure, HEAD mismatch, capacity 430, token expiry, or unforceable flag renders as `▲ COULD NOT VALIDATE` / a surfaced limitation — **never** `✓` or `✕`.
- **Suspected ≠ confirmed.** Phase 1 cannot inject faults, so a cause it can't reproduce is `▲ SUSPECTED`, with the gap named. No "confirmed root cause" boxes (that is the mock's Phase-N state).
- **Skipped ≠ failed.** A cascade-skipped node is `◇` collateral, attributed to the failed ancestor, never `✕` against this change.
- **`0` ≠ unknown.** Render a real `0` plainly; render `-1`/null as `not reported`.
- **Output is markdown.** The Phase-3 rich HTML board is a *link* from the PR comment, not a replacement for this terminal verdict.
