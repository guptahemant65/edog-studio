# Presentation Contract — How the Skill Renders

This is the **UX source of truth**. The skill is a terminal conversation, so its UI *is* its output. The skill prints **plain Markdown + Unicode marks** into a chat-style CLI (it cannot redraw the screen, move the cursor, or set arbitrary colors). State is therefore carried by **symbol + word + layout**, never by color. Every beat must render to the symbols, layouts, and **state matrix** below — the same way, on every run. The companion visual is `docs/design/mocks/flt-pr-scenario-validator-tui-v3.html`.

**The reader is a smart engineer who does not know FLT's internals.** Every line they read must be plain English. No internal jargon (no "oracle", "blast radius", "harness", "idempotent", "attribution", "NOREFRESH", "cascade-skip", "fitness", "bearer", "stimulus", "invariant"). Two domain words are allowed because they have no short plain synonym — **DAG** and **MLV** — and each is glossed the first time it appears (see §7).

---

## 1. Design principles

Drawn from the output craft of the best terminal tools — Charm's `gum`/`lipgloss`/`glow` (restraint, whitespace, alignment), Claude Code & GitHub Copilot CLI (a leading glyph headline with dim, indented sub-results), Turborepo/Vercel CLI (aligned columns, dim secondary text, a final summary line with counts), and the Command Line Interface Guidelines (`clig.dev`: plain language, progressive disclosure, "never rely on color alone — pair every symbol with a word").

1. **Plain language always wins.** Say "couldn't check this" not "harness blockage"; "the running build doesn't match your PR" not "HEAD mismatch"; "nothing needed refreshing" not "NOREFRESH". If a reviewer would need an FLT glossary to parse a line, rewrite the line.
2. **Restraint is the default.** Healthy, expected states are quiet — no banners, no celebration. A passing check is a plain `✓`, nothing more. If everything is decorated, nothing stands out.
3. **Marks signal exceptions.** Reserve `▲` (needs attention) and `✕` (broken by the change) for things that genuinely need eyes. They should be rare on a clean run.
4. **Honesty over polish.** "Suspected", "couldn't check", and "never ran" are shown plainly and are never dressed up as a pass. We state our confidence; we never imply more than we proved.
5. **Every fact carries its source.** Trailing, dim, right after the claim: `retry fired 5 times  (retry #1851)`. No source → the claim does not print.
6. **The reader is always oriented.** Each step opens with a one-line headline saying what is happening and why. Each decision states plainly what will happen for each choice.
7. **Hierarchy by indent, not noise.** Headline at the margin; supporting facts indented two spaces; the source dim and trailing. Scannable top-to-bottom.
8. **No emoji, ever.** Unicode marks only (§2) — terminal-safe codepoints that never render as colour emoji.

---

## 2. Symbol vocabulary (Unicode only — no emoji)

| Mark | Name | Means | Used for |
|---|---|---|---|
| `◆` | headline | a section or result block | step headers, the map, the locked target, the verdict |
| `▸` | doing / asking | an action underway, or a decision prompt | the one-line "what I'm doing now"; every gate |
| `✓` | good | a check passed, or a confirmed fact | passes, grounded facts |
| `✕` | broken | this change makes it fail | a failure caused by the change |
| `▲` | needs attention | risky, suspected, needs a human, or couldn't be checked | the only "stop and look" mark |
| `◇` | side note | meta, coverage, or "not caused by your change" | the coverage line, skipped-by-an-earlier-failure |
| `▣` | locked | the one test target we're allowed to touch | the locked-target block |
| `◌` | never ran | a code path nothing reached during the run | "never ran" verdict rows (hollow — clearly not a pass or fail) |
| `▹` | queued | a sub-step not run yet | progress rails |
| `…` | working | trailing an in-flight line | live progress |
| `·` | separator | inline metadata | `4 files · 142 lines · by a.lee` |

Emphasis: **bold** only the single number that matters in a line (`**3 of 4** behaved as intended`); dim for sources and asides. Never bold a whole line. Status words are written in a small fixed set so they read the same every run: **PASS · BROKEN · SUSPECTED · COULDN'T CHECK · NEVER RAN** (see §5).

---

## 3. Layout primitives

**Step headline** (opens every beat — orient the reader):
```
◆ Step 2 of 7 · Understand the change
  Reading your PR and the FLT code it touches.
```

**Action line** (while working):
```
▸ Reading the diff and the code it changes…
```

**Fact / result line** (indented two spaces; source dim and trailing):
```
  ✓ The chain of steps finishes, ending in "Completed"        (run #1402)
```

**Named box** (a headline + grouped, aligned detail — for the change summary, the locked target, the verdict):
```
◆ What changed in this PR
  Feature flags
    +  New      FLTInsightsMetrics — turns on the new insights filter
    −  Removed  FLTLegacyRetryCap — old retry ceiling, no longer used
    ·  Uses     FLTMLVWarnings — existing, unchanged
  Files (4)
    LiveTableController.cs   +155 / −2    the insights-listing endpoint
    TokenManager.cs          +12 / −9     when the sign-in token is created
    RetryPolicy.cs           +8 / −1      retry count and backoff
    FeatureNames.cs          +3 / −1      flag definitions
  What the code does now
    · Adds GET /insights/summary — lists insights with an optional filter
    · Creates the sign-in token earlier in the request
    · Caps results at 200 items per request
  API change        safe — only adds GET /insights/summary (+ optional "filter"); nothing removed
  Who's allowed in  no change — safe
  Out of reach      ComputeJitter() — a private helper I can't trigger   ▲
```
Direction is always visible, never just a name: `+ New` · `− Removed` · `· Uses` for flags; `+155 / −2` for each file. The `API change` line says plainly whether it is **safe** (only adds) or **breaking** (removes/changes a shape). If sign-in / permission wiring changed, replace `Who's allowed in  no change` with the `▲ NEEDS A HUMAN` line (Beat 2).

**Category group** (several cases under one category — used in the plan and the verdict; the count rides the header, the status rides each case). **Every case carries two plain sub-fields, rendered on a dim line under it — `tool` (what checks it) and `checks` (the assertion points)** — so the reader sees *how* each case is validated and *against what*:
```
Edge cases (3)
  201 items is rejected with a clean 400
    tool: API call (oversized request) · checks: a 400 with the right "too many items" message
    (in practice the URL-length limit can reject it first — reported, not hidden)
  an empty filter lists everything
    tool: API call (no filter) · checks: returns the full list · nothing dropped
  a very long filter doesn't crash
    tool: API call (large but valid) · checks: no server error (no 5xx) · responds gracefully
```
A category can hold a mix of statuses. Counts always total across **every** case, not per category.

**Each case carries `tool` and `checks` (the scenario model's two presentation fields).**
- `tool` — which tool validates it, in plain words: *an API call*, *run the DAG and read the data back*, *build the API description from both versions and diff them*, *flip the flag and call the endpoint each way*. Plain — not an endpoint or class name.
- `checks` — the assertion points it verifies, `·`-separated: *status is 200* · *body matches its schema* · *the stored result matches a fresh recompute* · *no warnings* · *no 5xx* · *every change is an addition*.
- Both render as one dim `tool: … · checks: …` line under the case, in the plan and echoed under the case's status row in the verdict. They make visible that validation is **more than API calls** — it reads data back, recomputes expected values, diffs contracts, and toggles flags. Where a check is limited (e.g. it can only *observe* a timing gap, not force it), say so honestly in `checks` and let the case stay `SUSPECTED`.
- `evidence` — the **full raw output** of the tool that ran this case (the API reply, the chain-of-steps node states + data read-back, the log lines, the diff, the flag state). It is **not** printed inline by default; it is saved as the run goes and printed on demand. See §8 for how it is rendered and the per-tool shape.

**Raw evidence on demand** (the closing offer in the verdict — never per line):
```
▸ Want the full output of any case? say  show #1455  ·  or open .edog-qa/runs/4471/evidence/
```
One standing line, after the per-case results. The citation on each case (`request #1455`, `run #1402`) is the key; `show #<ref>` replays that case's saved raw block (§8). A terminal can't fold text, so "expandable" means *saved aside and printed on request* — never a wall of output by default.

**Menu** (selectable rows — letter/marker · name · plain meta):
```
  +  Create a fresh sandbox          new · ~$0.36/hr · deleted when done
  a  robust_goodfellow_18            empty · safe to use freely
  b  prod-mirror-eastus              has real data · looks like production   ▲
```

**Gate** (a decision — always state the choices and what each does):
```
▸ Run this plan?   edit · drop <n> · add "<your own>" · y to start
```

**Progress** (a long build/run — percent + step rail):
```
▸ Deploying your branch · 50%   building (3 of 6)…
  ✓ get token   ✓ point to your branch   ✓ turn on dev mode   ▹ build   ▹ launch   ▹ connect
```

**Checkpoint** (before a multi-minute background phase — let them step away):
```
▸ Running the checks now — I'll save progress as I go, so you can step away.
```

---

## 4. State matrices (per beat)

Each beat declares **every** state it can render — not just the happy path. The left columns are the skill's internal trigger (not shown to the user); the **Render** column is exactly what the user reads, and must be plain. `STOP` = end the run cleanly here. **Couldn't-check** = a limit of the test setup, never a verdict on the change.

### Beat 1 — Find the pull request

| State | When | Render (what the user sees) |
|---|---|---|
| PR found | open PR on the branch, or an explicit `#`/URL | `✓ Found open PR #982144 — "title"` + `repo · 4 files · 142 lines · by a.lee`, then `✓ Started a local test server on port 5555` |
| No PR | no open PR and none given | `STOP`: `▲ No open pull request on this branch.` + `Point me at one:  edog qa <PR number or URL>` + `Stopped — I didn't start anything, so there's nothing to clean up.` **(Server never started.)** |
| Already running | another validation is live | `STOP`: `▲ A validation is already running (PR #1004, started 4 min ago). Only one runs at a time — I'll wait for it to finish or time out.` |
| Cleared a stale lock | the previous run's heartbeat is dead | proceed, dim note: `(cleared a leftover lock from a run that crashed earlier)` |
| Server wouldn't start | `:5555` won't come up | **couldn't check**: `▲ COULDN'T CHECK — the local test server wouldn't start (<reason>). That's a test-setup problem, not a verdict on your change.` |
| Sign-in expiring | token nearly expired / no saved session | `▲ Your sign-in token expires in 6 min and nothing is saved to refresh it. Sign in again before the long run, or it may stop partway through.` |

### Beat 2 — Understand the change

| State | When | Render |
|---|---|---|
| Change summary | the change has something that runs | the `◆ What changed in this PR` box (§3): **feature flags introduced / removed / referenced** (with direction), **files with `+/−` line counts**, **key code touched** (in plain terms), **limits read from the code** (e.g. "200 items per request"), the **API change** line (safe vs breaking), and a **who's-allowed-in** line. Each fact cited to `file:line`. |
| Nothing runs | docs / build / config-file-only diff | `STOP`: `Nothing here runs at the FLT service — this PR only changes docs/build files. Stopped: there's nothing to deploy or try out.` |
| Touches who's allowed in | sign-in / permission / authorization wiring changed | in the box, the who's-allowed-in line becomes `▲ NEEDS A HUMAN — this change touches who's allowed in. The test environment turns sign-in checks off, so any test here would falsely pass. Flagged for security review — I won't claim this passed.` (detect-only, never "passed") |
| Breaking API change | an endpoint / param / shape was removed or changed | the `API change` line reads `▲ breaking — removes <x> / changes <y>` (not "safe"); a contract case is auto-added in Beat 3 |
| New area | the change is in code I haven't mapped | dim note: `(new area — not in my map yet; reading the FLT source directly)` then proceed |
| Wiring unclear | dynamic / conditional setup | dim note: `(couldn't tell how this is wired from the code alone — asking the running service)` |

### Beat 3 — Plan the tests

Checks are grouped by **category**; a category can hold **several cases**, each its own row. The locked summary counts cases across all categories.

| State | When | Render |
|---|---|---|
| Plan proposed | checks derived | category groups (§3), each `<Category> (N)` with one case per line **and a dim `tool: … · checks: …` line under each case**, then the `▸ Run this plan?` gate |
| Edited | user types `drop N` / `add …` / `edit` | `✓ Updated — dropped "201 items", added "filter with special characters"` then the locked summary line |
| API check added | a controller/DTO changed | an `API contract (1)` category appears: `Compare the API before and after — catch breaking changes   (added automatically)` |
| Toggle check added | a feature flag appears in the diff | a `Feature flag (1)` category appears: `run with FLTInsightsMetrics both ON and OFF   (added automatically)` |
| Locked in | user accepts (`y`) | `◆ 8 checks locked in across 5 categories · 2 happy · 3 edge · 1 risk · 1 contract · 1 flag` |

### Beat 4 — Pick where to test

| State | When | Render |
|---|---|---|
| Menu | candidate workspaces listed | the menu (§3): each row `cost · empty/has-data · risk`, then `▸ Which one?` |
| Reuse one | an existing one has what's needed | `✓ Reusing robust_goodfellow_18 — empty, so I have full freedom` |
| Missing pieces | an existing one is short | a `◆ … is missing what these tests need` box (`Missing tables`, `Missing MLVs`, `Wrong setting: change-tracking is off`) + offer a fresh sandbox |
| Building a sandbox | user picks `+` | a progress rail: `▸ Building the sandbox · 3/4   creating tables…` with `✓`/`▹` steps (workspace · storage · notebook · tables · MLVs) |
| Real data — confirm | a "has real data" / "production-like" target is chosen | extra gate: `▲ prod-mirror-eastus holds real data. Tests will write to it and may disrupt it.` + `▸ Use it anyway?   yes · pick another` |
| Locked | after the pick | the `▣ Test target locked` box (workspace · storage · capacity) + `I can only touch this one target, and I only delete what I create.` |

### Beat 5 — Build, deploy, and run the checks

| State | When | Render |
|---|---|---|
| Deploy | gate `y` | the `▸ Deploying your branch · %` rail; on done `✓ FLT is running with your change (took 3m 12s)` |
| Deploy failed | build / connect error | **couldn't check**: `▲ COULDN'T CHECK — the build/deploy failed at step 4 (<reason>). A test-setup problem, not a verdict on your change.` |
| Wrong build running | the running commit ≠ the PR commit | **couldn't check**: `▲ COULDN'T CHECK — the running build doesn't match your PR. Re-deploying with the exact commit before I trust any result.` |
| Setting applied | a required toggle was switched and re-checked | dim: `✓ Feature toggle "FLTMLVWarnings" is ON and confirmed active in this workspace` |
| Couldn't switch a toggle | a toggle is locked / missing here | `▲ Couldn't switch the "X" toggle — it's locked in this environment. A test-setup limit; I'm surfacing it, not guessing.` |
| Check passed | the rule held and was asserted | `✓ <check>` + the cited evidence |
| Evidence saved | any case ran | as each case runs, its **full raw output** is written to `.edog-qa/runs/{runId}/evidence/{ref}.{json\|log\|txt}` (the citation is the key) — nothing printed inline; available via `show #<ref>` in Beat 7 (§8) |
| Check broken | the change makes it fail | `✕ <check> — your change breaks this` + the failing fact, cited |
| Service was busy | a busy / capacity / rate-limit error | retry once; if it recurs `▲ Still busy after a retry (capacity limit) — that's the environment, not your change`; otherwise pass |
| Nothing to refresh | a step had nothing changed to refresh | `✓ <check> — nothing had changed, so nothing needed refreshing (correct)` (a success) |
| Skipped after an earlier failure | a step was skipped because an upstream step failed | `◇ "<step>" was skipped because an earlier step failed — not caused by your change` |
| Sign-in expiring mid-run | token nearly expired between steps | `▸ Checking the sign-in token before the next long step…` then refresh / re-auth |

### Beat 6 — Dig into anything suspicious (honest about what we can't prove)

| State | When | Render |
|---|---|---|
| Retry once | a one-off glitch | dim: `(retrying once — looked like a temporary glitch)` |
| Toggle on vs off | a toggle-gated path | `▸ Running the same check with the toggle ON, then OFF…` + both outcomes |
| Suspected | something looks risky but we can't force it to happen | a `▲ SUSPECTED` box: the code fact (cited) + what we saw (cited) + a clearly-labelled "my read" + `I couldn't prove it — that needs fault injection, which isn't available yet.` |
| Flaky | a pass that doesn't repeat | `▲ FLAKY — passed 2 of 3 re-runs. Reporting as flaky, not a clean pass.` |
| (Proven cause) | — | **Not in this phase.** We can't yet inject faults, so we never print a "proven root cause" — only `SUSPECTED`. |

### Beat 7 — Results, post, clean up

| State | When | Render |
|---|---|---|
| Reviewer summary | always, first | the `What this means for the reviewer` block: *watch · looks safe · your call* |
| Per-case result, grouped | each case under its category | `<Category> (N)` header, then one row per case: `✓ PASS` / `✕ BROKEN` / `▲ SUSPECTED` / `▲ COULDN'T CHECK` / `◌ NEVER RAN`, **with the same dim `tool: … · checks: …` line echoed under each**. A category may mix statuses. |
| What I tested | always | `What I tested   8 cases · 5 passed · 2 suspected · 1 never ran` — totals across **all** cases, not per category |
| Raw output on demand | always, after the per-case results | one standing offer: `▸ Want the full output of any case? say  show #1455  ·  or open .edog-qa/runs/4471/evidence/`. On `show #<ref>` the skill prints that case's saved raw block, tool-shaped (§8) — the captured bytes replayed, never re-fabricated. A case that never ran has no block (`nothing ran here, so there's no output to show`). |
| Out of date | the PR moved on since the run | `▲ OUT OF DATE — I checked commit abc1234, but the PR is now at def5678. Re-run before trusting this.` |
| Ask before posting | before any PR comment | `▸ Post this summary to PR #982144?   y · edit · no` — never posts silently |
| Posted | the author approves | `✓ Posted the summary to PR #982144` |
| Cleaned up (clean run) | results are clean | `✓ Cleaned up — removed everything I created, undid the deploy, stopped the server. Nothing left behind.` |
| Keep for debugging? | a real break was found | `▸ Keep the test environment so you can debug?   keep · tear down` (on `keep`, it says exactly what's left running) |

---

## 5. The results template (honest about confidence)

```
◆ Validation results — PR #982144 "insights filter + token mint reorder"
  checked commit abc1234 · run #4471 · took 24.6s

  What this means for the reviewer
    Watch         token lifetime (reliability) · 1 new endpoint · 1 new flag
    Looks safe    the API change only adds things · core checks green · data lines up
    Your call     2 suspected risks (couldn't prove them) · 1 path never ran

  Happy path (2)
    ✓ PASS        GET /insights/summary → 200, body valid              (request #1455)
                    tool: API call (GET the endpoint) · checks: status 200 · body matches its schema · computed values correct
    ✓ PASS        The chain of steps finishes, ending in "Completed"   (run #1402)
                    tool: run the DAG, then read the data back · checks: final state Completed · stored result matches a fresh recompute · no warnings
  Edge cases (3)
    ✓ PASS        201 items → clean 400, no crash                      (request #1460)
                    tool: API call (oversized request) · checks: 400 with the right "too many items" message (URL-length limit may reject first — reported)
    ✓ PASS        Empty filter lists everything                        (request #1462)
                    tool: API call (no filter) · checks: returns the full list · nothing dropped
    ▲ SUSPECTED   A very long filter may time out
                    tool: API call (large but valid) · checks: no server error (no 5xx) · responds gracefully
                    In the code:  the filter scans every row unbounded (LiveTableController.cs:212)
                    What I saw:    a 900-char filter took 9.4s         (request #1471)
                    My read:       a longer filter could cross the timeout.
                    Couldn't prove it without a bigger dataset (not set up here).
  Risk (1)
    ▲ SUSPECTED   The sign-in token may expire during a long write
                    tool: run a long DAG, watch token + write timing in the logs · checks: token still valid at the final write (Phase-1: only observes the gap → SUSPECTED)
                    In the code:  the token is created earlier now     (TokenManager.cs:88)
                    What I saw:    token created at 2.3s, write at 14.1s  (token #1203, request #1881)
                    My read:       a longer run could outlive the token before the last write.
                    Couldn't prove it without fault injection (not available yet).
  API contract (1)
    ✓ PASS        Only adds GET /insights/summary (+ optional "filter")  (nothing removed)
                    tool: build the API description from both versions and diff them · checks: every change is an addition · nothing removed or changed
  Feature flag (1)
    ◌ NEVER RAN   FLTInsightsMetrics OFF path — nothing I sent reached it; check this by hand
                    tool: flip the flag, then call the endpoint each way · checks: ON — filter applied · OFF — filter ignored (as designed)

  What I tested  8 cases · 5 passed · 2 suspected · 1 never ran
  How sure       data & API checks: high (repeatable) · the 2 risks: suspected only

▸ Post this summary to PR #982144?   y · edit · no
```

Cases are grouped by category; the count on each header is for that category, but the `What I tested` line totals across **all** cases (here `5 + 2 + 1 = 8`). A category may hold a mix of statuses (Edge above is 2 `PASS` + 1 `SUSPECTED`).

`◌` (never ran) is hollow on purpose — it is clearly neither a pass nor a fail. The rich Phase-3 HTML board does not replace this; it is *linked* from the PR comment.

---

## 6. Honesty rules (what we will and won't claim)

- **A test-setup problem is not a verdict.** A failed deploy, the wrong build running, a busy/capacity error, an expired sign-in, or a toggle we couldn't switch all print as `▲ COULDN'T CHECK` (or a surfaced limit) — **never** `✓` or `✕`.
- **Suspected is not confirmed.** We can't yet force a fault to happen, so a cause we can't reproduce is `▲ SUSPECTED`, with the gap named. We never print a "proven root cause".
- **Skipped is not broken.** A step skipped because an earlier step failed is a `◇` side note, blamed on the earlier failure — never `✕` against this change.
- **`0` is not unknown.** Print a real `0` plainly; print a missing/`-1` value as `not reported`.
- **It's just Markdown.** The rich HTML board is a *link* in the PR comment, not a replacement for this terminal summary.

---

## 7. The two allowed domain words (glossed on first use)

Everything else must be plain English. These two have no short plain synonym, so they may appear — each glossed the first time it shows in a run:

- **DAG** — the chain of steps FLT runs in order. Prefer "the chain of steps" in user-facing lines; use "DAG" only when the exact term matters, e.g. `the DAG (chain of steps) finished`.
- **MLV** — a managed table FLT keeps up to date automatically (a "materialized lake view"). First use: `Missing MLVs (managed tables FLT auto-refreshes): sales_summary`.

If a third domain term ever feels unavoidable, that's a signal to rewrite the line in plain language instead.

---

## 8. Raw evidence — quiet by default, one keystroke to expand

Every claim already trails a citation (`request #1455`, `run #1402`, `token #1203`). That citation is also the **key to the full, raw output** of the tool that produced it. The default stays quiet — status + result + the `tool: … · checks: …` line. The complete output is **saved, not dumped**: a terminal can't truly fold text, so "expandable" means *kept aside and printed on request*.

**How it works**
- Every case that runs writes its full tool output to `.edog-qa/runs/{runId}/evidence/{ref}.{json|log|txt}` as it happens. The citation *is* the filename key (`request #1455` → `evidence/1455.json`).
- The results block ends with **one** standing offer, not a line per case:
  `▸ Want the full output of any case? say  show #1455  ·  or open .edog-qa/runs/4471/evidence/`
- On `show #<ref>`, the skill prints that case's raw block inline — tool-shaped (below). It is the captured bytes replayed; nothing is re-derived or invented.
- In the rich HTML board (linked from the PR comment) the same block is a collapsed "show raw output" disclosure under each case. The mock (`flt-pr-scenario-validator-tui-v3.html`) demonstrates this with a native `<details>` element — no JavaScript.
- A case that never ran has no raw block: `show #<ref>` says `nothing ran here, so there's no output to show`.

The point: a reader trusts a `PASS` because the proof is one keystroke away, **in the tool's own words** — and seeing the blocks makes plain that the checks are *more than API calls* (they read data back, recompute, diff contracts, toggle flags). Honesty rules (§6) hold inside the raw block too: `-1` shows as "not reported", the 201→400 caveat is shown, the token risk stays `SUSPECTED`.

**What each tool's raw block looks like** (what `show #<ref>` prints):

*API call* — the request, the real **inner** status (FLT's own, read from inside the dispatch reply — not the wrapper), headers, body, then each check:
```
▸ show raw output · request #1455 · API call
  GET  …/liveTable/insights/summary?filter=
  ← 200 OK            (FLT's own status, read from inside the dispatch reply)
     content-type: application/json · x-ms-request-id: 7af3c1 · 240 ms
  body:
    { "items": [ {"name":"sales_daily","rows":1240,"policy":"INCREMENTALREFRESH"},
                 {"name":"sales_summary","rows":-1,"policy":"NOREFRESH"} ], "count": 2 }
  checks:
    ✓ inner status is 200
    ✓ body matches its schema
    ✓ count (2) equals items.length        (computed from the response)
  note: rows -1 means "not reported", shown as-is — never as 0.
```

*Run the chain of steps, then read the data back* — node states and the **stored-vs-recompute** proof (the data-correctness evidence — the most valuable block):
```
▸ show raw output · run #1402 · ran the chain of steps, then read the data back
  iteration 9c2f… · 2 steps
    sales_daily     Completed   incremental   1240 rows   2.1s
    sales_summary   Completed   full           312 rows   3.4s   no warnings
  final state: Completed
  data check — stored result vs a fresh recompute of the query:
    stored      312 rows
    recompute   312 rows
    ✓ exact match, row for row
  checks:
    ✓ final state Completed   ✓ stored equals recompute   ✓ no warnings
```

*Watch the logs* — the actual lines that were matched, with their ids and times:
```
▸ show raw output · request #1881 · watched the token + write timing in the logs
  00:02.3  sign-in token minted, valid 60m          [token #1203]
  00:14.1  final write begins                        [write #4012]
  00:14.9  final write ok                            [write #4012]
  checks:
    ✓ token still valid at the final write (large margin)
    ▲ Phase 1 can only watch the gap — it can't force a write long enough to
      actually expire the token. Stays SUSPECTED, not proven.
```

*Compare the API before and after* — the raw diff entries:
```
▸ show raw output · the API before vs after (built from both branches, then diffed)
  ch-001  added   GET /insights/summary
  ch-002  added   optional query param "filter" on /insights/summary
  — nothing removed · nothing changed —
  checks:
    ✓ every change is an addition   ✓ nothing removed or modified
```

*Flip the feature flag* — the flag state before/after and each path's result:
```
▸ show raw output · feature flag FLTInsightsMetrics, both ways
  before:  effective in this workspace = no
  set ON → applied (confirmed)
  after:   effective in this workspace = yes
  ON   GET …/insights/summary?filter=sales → filter applied, 1 item   [request #1466]
  OFF  no request in this run reached the OFF branch
       ◌ OFF path never ran — check by hand
  checks:
    ✓ ON applies the filter   ◌ OFF path not exercised
```

