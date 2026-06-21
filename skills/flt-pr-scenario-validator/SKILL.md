---
name: flt-pr-scenario-validator
description: "Validate an FLT (FabricLiveTable) pull request end-to-end against a live EDOG environment. Use when asked to validate, QA, test, or 'run scenarios' on an FLT PR. Resolves the PR, understands the change, locks a target, deploys, runs grounded scenarios, cites every claim to a verified trace event, posts to the PR, and cleans up after itself."
---

# FLT PR Scenario Validator

You are the brain. EDOG (the dev-server on `http://localhost:5555`) is the body — your sensory and motor system over the live FLT service. You read the change, reason about what it implies, drive EDOG with `curl`, correlate every signal stream, and narrate a verdict in which **every factual claim cites a real trace event**.

This is not a rules engine. You reason. But you never *guess* a fact: facts are read from code, configuration, and captured trace events; inferences chain facts together and are labeled as inferences.

## When to use

Use this skill when the user asks to validate / QA / test / "run scenarios on" an FLT pull request, or to confirm a change behaves correctly against a real environment. Do **not** use it for static code review alone (no deploy needed) or for non-FLT repos.

## Operating model

- The **skill** (you) owns reasoning: blast radius, scenario design, signal correlation, verdict.
- **EDOG** owns capability: deploy, stimulus, observation, infra. Every capability is an HTTP endpoint — see `reference/tools.md`.
- **Python primitives** (`scripts/qa_*.py`) own the dangerous, must-be-deterministic parts. You call them; you do not re-implement their logic in prose. They are the guardrails enforced at the tool boundary:
  - `qa_run_lock` — single-validation lock (heartbeat-based).
  - `qa_teardown_ledger` — append-before-act ledger; reverse-replays on cleanup.
  - `qa_pr_diff` — clean PR diff → files, symbols, config facts, feature-flag refs.
  - `qa_change_understanding` — **Beat 2's grounded "understand the change" engine.** Ties the diff + the Roslyn code-graph (ChangeScanner: feature-flag gates + the **signal footprint** across the evidence streams; PreciseEngine: *what reaches the changed code*) + `qa_flag_gates` into one structured understanding plus the Beat-5 **watch-checklist**. Call it instead of guessing flags, callers, or signals. Server-free. See `reference/code-understanding.md`.
  - `qa_flag_gates` — which feature flags gate the changed code (found by walking the code to its `IsEnabled(FeatureNames.X)` guard, even in the *caller*; never grepped from the diff) + each flag's **real EDOG state** (EDOG == the FM `test` environment, so a flag's EDOG default is its `test` entry).
  - `qa_targets` — enriched target menu + GUID-locked target record.
  - `qa_head_match` — deployed-commit == PR-commit (ignoring EDOG's injection set).
  - `qa_infra_spec` — required-vs-available infra diff (counts, table props, flags, DAG shape).
  - `qa_contract_diff` — two-spec (main vs PR) OpenAPI diff with stable `ch-NNN` ids.
  - `qa_error_classify` — catalog-grounded failure attribution (`change` / `infra` / `unknown`).
  - `qa_invariants` — deterministic absolute-truth checks with cited evidence.
  - `qa_execution_proof` — did the changed code actually run? Maps changed symbols → their code-marker/log/interceptor surface and checks the trace; returns `proven` / `not_exercised` / `no_surface`. Coverage is measured, never declared.
  - `qa_mlv_convergence` — did the data come out correct? Compares the materialized MLV output to an independent recompute of its SELECT (incremental must converge to full); degrades to schema+rowcount for non-deterministic SQL.
  - `qa_verdict` — claim/verdict model + the evidence-verification wall.
  - `qa_evidence` — per-case raw-output store: `save(runId, ref, block, kind=…)` as each case runs; `show(runId, ref)` replays it verbatim on demand (the citation is the key), or says plainly nothing ran. Quiet by default; the expandable proof behind every claim.
  - `qa_render` — the deterministic TUI renderer: structured run-state → the exact terminal blocks the presentation contract specifies (Unicode marks, no emoji, aligned). `headline` · `action` · `gate` · `change_summary` · `plan` · `results` · `verdict` · `locked_target` · `menu`. **Print its output verbatim — do not hand-compose terminal blocks.**
  - `qa_scenario_plan` — derives the scenario skeleton **from the change**: `derive(features)` → the categories (m) and cases (n) the change actually triggers; `case_count(plan)`. The count is a function of the diff, never a hand-picked template — you ground each derived stub's stimulus/checks, you do not invent the count.
  - `qa_cleanup` — standalone ledger reverser (also `python edog.py --qa-cleanup {runId}`).

Read `reference/flt-model.md` (DAG, iteration ID, tokens, capacity routing, the 11 interceptors, deploy lifecycle, ports) before Beat 1. Read `reference/tools.md` for every endpoint. Read `reference/scenarios.md` for the generation protocol and the audited infra-seeding recipe. **`reference/api-knowledge.md` is the map of the three EDOG surfaces — Fabric control-plane (`bearer`, infra), the FLT workload under test (`mwc` dispatch, `:5557`), and OneLake/data (the receipts: `/api/mwc/tables`, `/api/onelake/table-preview-rows`). Read it in Beat 2/3 to craft *complete* scenarios and to know which door + token each call needs; read the data back through the OneLake surface in Beat 5 — never validate on an API status alone.** **`reference/flt-subsystems.md` is the just-in-time blast-radius index — do not read it whole; in Beat 2 load only the section(s) for the subsystem the PR touches.** **`reference/presentation.md` is the rendering contract — every beat's terminal output (symbols, boxes, gates, the verdict, and the per-beat state matrix) must follow it. Honor it on every run.** **`reference/code-understanding.md` is the Beat 2 code-graph guide — how to call `qa_change_understanding`, what the two Roslyn tools (ChangeScanner, PreciseEngine) answer, the EDOG==`test` flag-state fact, the signal vocabulary, and the *static-surfaces / the-run-is-the-judge* honesty rule. Read it in Beat 2.**

## The Journey

Seven beats. Each names its **gate** (what must be true to proceed), the **primitives/tools** it calls, and stops at a human checkpoint where marked. Persist state after every beat; heartbeat the lock every turn.

### Beat 1 — Acquire & resolve
- Acquire the lock: `qa_run_lock.acquire(runId, pr)`. If refused, report the current holder and STOP — another validation is live.
- Resolve the PR: `GET /api/ado-proxy/pr-diff?prUrl=<full PR URL>` → `{prId, title, author, diff, sourceCommit, commonCommit}` (the param is `prUrl`, not `prId`; fallback: `az repos pr show` + `git diff origin/main...<sourceCommit>`). Pin `sourceCommit` as the commit under validation.
- Start the server **headless**: launch `python scripts/dev-server.py` directly (it does **not** open a browser). Do **not** run `python edog.py` — its default opens the EDOG Studio webpage, which this skill must not do. API-only on `:5555`. **Record the server start to the ledger** (`qa_teardown_ledger.record(runId, "server_start", {"pid": <pid>}, reverse={"op":"server_stop","pid":<pid>})`) so teardown — or a crash-recovery `qa_cleanup` — stops the exact process the skill spawned. **Exception:** if `:5555` was *already healthy* when you arrived (someone else's server), do NOT record/stop it — you didn't start it; just use it.
- Check `GET /api/edog/health` → `bearerExpiresIn`, `tokenExpired`, `mwcToken`. Ensure a username/session is saved so the bearer auto-refreshes across a long run.
- **Gate:** lock held, PR resolved, server answering on `:5555`. Resolve the PR *before* starting the server — never spin up infra for a PR that doesn't exist.

### Beat 2 — Understand the change
- **Run the change-understanding engine first — `qa_change_understanding` (server-free).** Feed it the changed `.cs` files + changed symbols (from `qa_pr_diff`), and the changed project's `.csproj` when you want the entry points. It returns, every fact grounded in code — never guessed:
  - **Gates** — the feature flags that gate the changed code (walked to the `IsEnabled(FeatureNames.X)` guard, even when it lives on an unchanged line in the *caller*), each with its **real EDOG state** (EDOG == the FM `test` environment).
  - **The signal footprint → the Beat-5 watch-checklist** — which evidence streams the change touches (log · telemetry · http · spark · fileop/OneLake · token · retry · capacity · cache · catalog · dag). This is *what to watch* in Beat 5; an expected-but-absent signal there is a **finding**, not a pass.
  - **What reaches the changed code** — the callers / entry point (the door to trigger it in Beat 5), via the precise Roslyn engine.
  Surface it as the plain-language change summary (`qa_render.change_summary` / the engine's `render_plain`). Call `qa_pr_diff.fetch_and_parse(...)` to get the parsed diff you feed it (files, symbols, `config_facts`, `feature_flags_added/removed`).
- **Honesty rule (the engine is built for it — hold to it):** the static understanding is **never complete**. It surfaces the gates and signals it can see and labels the rest as *unknown*; the **Beat 5 run is the judge**. A change can be gated by more than a feature flag — a `ParametersManifest`/config key, an internal check, a capacity/tenant condition — so surface those as honest unknowns and **never silently assume the changed code runs**; the execution-proof in Beat 5 confirms it actually fired.
- **Route via `reference/flt-subsystems.md`:** map each changed file to its subsystem(s) using that doc's Routing Table, then **load only those sections**. Each gives you the real files to read, the oracles, the known traps/races, and what a PR there can break.
- **Uncovered / novel area (the map has a gap):** if no Routing Table section matches the changed path, do **not** guess and do **not** stop. The engine already gives you precise callers/references and the signal footprint; read the changed files yourself on top of that to confirm behaviour, treating `docs/design/*.md` only as a *lead* to verify in code. Ground every fact at `file:line`; if no runtime-observable surface exists for the change, say **"no runtime surface found / not provably exercised"** honestly — never fabricate. Note the gap so the subsystem map (and the signal vocabulary) can be extended.
- Note every `feature_flags` ref — a flag-gated change is dormant until the flag is in the right state (Beat 5).
- **No-runtime-surface gate:** if the diff is docs / build / IaC / test-only with no runtime-validatable surface, say so plainly and STOP. Do not deploy or fabricate scenarios.
- **Security gate (detect-only):** EDOG disables FLT auth wholesale, so a runtime auth test is a manufactured false PASS — forbidden. If the diff touches controller posture (`PublicUnprotectedController` / `PublicAadProtectedController` / `BaseApiController`), `[MwcV2RequirePermissionsFilter]`, or `ControllersConfig.cs` authenticator wiring, **statically flag it for human review** — never claim it "passed."

### Beat 3 — Derive scenarios (editable)
- **Derive the scenario skeleton from the change, never by taste.** Translate the parsed diff (Beat 2) into change-features, then call `qa_scenario_plan.derive(features)` — it returns the categories (m) and cases (n) the change actually triggers. The count *falls out of the diff*: a one-line PR yields a couple of cases, a sprawling one yields many, a docs-only PR yields zero. Do not pad to a template or trim to a number. Each derived case carries an `input_class` so coverage is auditable (a loosened allow-set automatically pulls in the "still-rejected" guard and the cap+1 case — you cannot forget them).
- **Ground each derived stub, then render via `qa_render.plan`.** Use `reference/api-knowledge.md` to find the complete surface the change touches — discover the live swagger, pull each affected endpoint's full input space (params, caps, response codes) — and attach each stub's real `stimulus`/`checks`/honest caveat. The skeleton guarantees completeness; you guarantee grounding. Each scenario carries the eight fields: `title`, `category`, `stimulus`, `observations`, `invariants`, `infra requirements`, `preconditions`, `sub_scenarios`.
- Controller/DTO changes get a **main-vs-PR contract-diff** scenario (auto-emitted by `derive` as the `API contract` category). Flag-gated changes get a flag-in-required-state scenario. Scenarios may declare `preconditions` (flag state + table/MLV properties) and share infra via `sub_scenarios`.
- Present the scenario plan to the user as an **editable** list. **Gate:** user approves/edits before any infra is touched.

### Beat 4 — Lock the target
- Derive required infra: `qa_infra_spec.required(scenarios)` — counts plus `table_properties`, `flags`, `dag_nodes`.
- List candidates: `GET /api/fabric/workspaces` (+ lakehouses) → `qa_targets.build_menu(raw)`. Present the risk-annotated menu (`safe` / `has_data` / `prod_like`).
- User picks **existing** or **new**:
  - Existing → `qa_infra_spec.fitness(req, have)`; show exactly what's missing (incl. `property_mismatch`, e.g. a CDF flag on a table). A property mismatch makes a same-named target unfit.
  - New → seed tailored infra per the audited recipe in `reference/scenarios.md`, **recording every create to the ledger** (`qa_teardown_ledger.record`), enforcing preconditions at seed time (table properties).
- Lock it: `qa_targets.lock_target(workspace=<GUID>, lakehouse=<GUID>, capacity=<GUID>, created=...)`. **Store GUIDs, never display names.**
- **Gate:** a locked GUID tuple exists. From here on, never address a target outside it.

### Beat 5 — Deploy & exercise
- Repoint the FLT repo by **editing `edog-config.json` directly** (`flt_repo_path` → the PR worktree). Do **not** use `--config` — it deletes the token cache. Record the original path to the ledger as `config_restore`. Record the worktree checkout to the ledger (`worktree_remove`).
- Deploy: `POST /api/command/deploy` + watch SSE `/api/command/deploy-stream` to `event: complete`, phase `running`.
- Confirm you ran the PR: `qa_head_match.compare(pr_commit, deployed_commit, dirty_files, injected)`. A mismatch is a **harness failure**, not a verdict — fix it or abort, never "fail" the PR for it.
- Enforce preconditions: for each required flag, resolve **const name → wire key → FM `Id`** (the FM repo `Features/**/*.json` `Id` is the real key, and may differ from the C# const name — overriding the wrong key silently no-ops → false PASS). Read effective state via `GET /api/edog/feature-flags/catalog`, `set_override(wireKey, bool)` via `POST /api/edog/feature-flags/overrides` (`X-EDOG-Control-Token`, success = `applied` echo), then **re-read the catalog to confirm `effectiveForMyWorkspace` flipped**. `locked`/`missing` flags = harness limitation, not a verdict.
- Run the scenarios: stimulus via `POST /api/playground/dispatch` (any well-formed path — the whole FLT API surface is reachable; for `mwc` use the FLT-relative path `/liveTable/...`, assert the INNER status/body in the envelope, not the outer 200); for DAG scenarios generate a fresh GUID `iterationId` and `runDAG`.
- **Use EVERY signal, not just the API response.** The API status/body is the *thinnest* evidence — a scenario is only validated when the relevant streams agree. For each scenario, collect and cite across **all** of these (whichever apply):
  1. **The API response body** — assert it (schema + invariants + computable values).
  2. **The data that landed** — `GET /api/onelake/table-preview-rows` + `table-metadata` for the live Delta rows, and for any DAG/MLV change run **`qa_mlv_convergence`** (recompute the SELECT in a notebook Spark session, compare to the materialized output). A change that leaves the API green but the data wrong is the exact bug this catches.
  3. **The FLT-native outputs** — `node.warnings`, `refresh_policy`, `NodeExecutionMetrics` (added/dropped rows), and the `sys_run_metrics`/`sys_node_metrics`/`sys_error_metrics` tables (query via a Spark cell or the executions endpoint).
  4. **The traces** — `/api/logs`, `/api/telemetry`, `/api/executions`, `/api/edog/interceptors-status` (discover each query interface at runtime). These are the citable event stream.
  5. **Execution proof** — feed the changed symbols + the collected trace to **`qa_execution_proof.prove`**; a symbol that never shows its code-marker/surface in the trace is `not_exercised` / `no_surface`, reported honestly — never counted as covered.
  Run `qa_invariants` checks on each response/log/DAG snapshot. **Do not report a scenario as passed on the API response alone** when a data, trace, or execution-proof signal is available and unchecked.
- Enforce preconditions (flags + table props) before each scenario's stimulus — see Beat 5 preconditions above.
- For controller/DTO PRs, generate the swagger from the PR assembly and the base-commit (main) assembly with `dotnet swagger tofile` (main is **build-only**, no deploy) and `qa_contract_diff.diff(main, pr)`; assert each `ch-NNN` is intended; flag removed/modified as breaking.
- Re-check `bearerExpiresIn` before any multi-minute operation.
- **Persist each ran case's full raw output** with `qa_evidence.save(runId, ref, block, kind=…, summary=…)` as it happens (the citation — `request #1455`, `run #1402` — is the key): the dispatch reply with the **inner** status, the DAG node states + the stored-vs-recompute data check, the matched log lines, the contract diff, the flag catalog before/after. This is the "expandable" evidence the verdict offers via `show #<ref>` (see `reference/presentation.md` §8). Save the captured bytes — never re-fabricate them later.

### Beat 6 — Correlate & attribute
- For each suspicious signal, write the causal narrative across streams (logs + telemetry + interceptors + DAG state + the data/convergence result), citing event ids.
- Run **`qa_execution_proof.summary`** over the changed symbols + collected trace and state the coverage honestly (`proven` / `not_exercised` / `no_surface`) — a green scenario whose changed code was never proven to run is reported as such, not as full coverage.
- Classify every failure through `qa_error_classify.classify(meta)` so `change` vs `infra` is **catalog-grounded, never guessed**. An `infra`/`unknown` failure is a harness condition, not a verdict on the change.
- Where you cannot confirm a root cause without fault injection, say **"suspected"** and name what would confirm it — fault-injection confirmation is Phase N (not available yet). Do not overclaim.
- For concurrency/trigger-touching changes, re-run a critical pass N times; a non-reproducible pass is `flaky`, not `pass`.

### Beat 7 — Verdict, post, clean up
- Build the verdict: assemble `qa_verdict.Claim`s, run `qa_verdict.verify(claims, bundle)` — **any claim whose evidence is not in the bundle is dropped.** Set `attribution` from `qa_error_classify`, not by hand. Render the per-scenario verdicts + a PR-level risk synthesis (the reviewer's 30-second read: blast radius, change type, security flag, flag-gating, coverage).
- State the validated `sourceCommit`. Re-query the PR's current source commit; if HEAD advanced, mark the verdict **STALE**.
- **Offer the raw output, quiet by default.** After the per-case results, print one standing line — `▸ Want the full output of any case? say  show #1455  ·  or open .edog-qa/runs/4471/evidence/` — never a per-case dump. On `show #<ref>`, print `qa_evidence.show(runId, ref)` — that case's saved block, tool-shaped (presentation §8); a case that never ran replays the honest no-output line.
- **Author-approval gate:** post to the PR (`POST /api/ado-proxy/pr-comment` — creates a real thread) **only after the author confirms.** Never post silently.
- Clean up: on pass, auto-run `qa_cleanup.run(runId)` (reverses the ledger LIFO, releases the lock). On fail, offer to keep infra for debugging. **Always tear down what the skill itself started**, in reverse order: clear flag overrides → revert the deploy injections (`edog --revert`) → remove the worktree → **stop the headless dev-server the skill spawned in Beat 1** (the `server_stop` ledger op — kill the recorded PID; never stop a server you did not start). Confirm zero orphans: `git worktree list` clean, no leftover flag overrides, FLT repo `git status` clean, and `:5555` down (unless the env was pre-existing). The run is not complete until the environment is exactly as the skill found it.

## Guardrails

- **Single-validation lock.** `qa_run_lock` — the FLT env is a singleton on `:5557`. Never run two validations at once. Heartbeat every turn; a stale lock (no heartbeat past `stale_after`) is reclaimable, so a crashed run never blocks the env forever.
- **Append-before-act ledger.** `qa_teardown_ledger.record(...)` **before** any mutating action (flag override, infra create, worktree checkout, config repoint). Cleanup is `qa_cleanup` / `edog --qa-cleanup {runId}`, replayable even if you crash.
- **Locked GUID target.** Address only the locked `(workspaceId, lakehouseId, capacityId)` tuple, by GUID. Treat a "backward compatibility mode" / name-based-resolution log line as a **locked-target violation** — name resolution can silently hit the wrong lakehouse.
- **Evidence-first.** No claim ships unless it cites a real trace event (or the asserted response body) and survives `qa_verdict.verify`.
- **Harness ≠ verdict.** HEAD mismatch, token expiry, capacity throttling (HTTP 430 `MLV_SPARK_JOB_CAPACITY_THROTTLING`) or inbound throttling (429 `MLV_TOO_MANY_REQUESTS`), `infra`-classified errors, locked/missing flags — all harness conditions, surfaced honestly, never a PASS or FAIL *on the change*.
- **Detect-only for auth.** Never run a runtime auth/authz "test" — EDOG disables auth, so it always falsely passes. Static-flag only.

## Grounding Protocol

Every factual sub-claim is grounded or it does not exist:

1. **Code/config facts** are read (PR diff via `qa_pr_diff`; constants; static DI bindings; flag wire keys from the FM repo). Reading is not guessing.
2. **Captured-event facts** cite a real event id from the observation streams. Interceptors capture status/duration/errors/counts — **never method return values** — so cite only captured fields.
3. **Invariants** (`qa_invariants`) are absolute truths needing no baseline (no 5xx, DAG terminates, no secret in logs, response validates against its OpenAPI schema, perf within a declared bound).
4. **Inferences** chain kept facts and are labeled as inferences. `qa_verdict.verify` enforces this in code: a fact must cite a bundle id; an inference must chain to a kept fact; everything else is dropped.

When you cannot prove a changed symbol was exercised, say **"not provably exercised"** — coverage is measured (did its code-marker / interceptor surface / log line appear in the trace), not declared.

## Tool Surface

The complete EDOG HTTP surface — every endpoint, with `curl` examples and response fields — is in **`reference/tools.md`**. Highlights:

- **Primary stimulus:** `POST /api/playground/dispatch` — dispatches any well-formed path; the whole FLT API surface is reachable (not catalog-limited).
- **Complete discovery:** `GET /api/playground/swagger/spec` (live runtime swagger). The curated `/api/playground/catalog` is convenience only, not the coverage boundary.
- **Contract diff** uses `dotnet swagger tofile` per branch (main vs PR) — **not** the runtime swagger endpoint and **not** the committed `Swagger.json` (which drifts).
- Observe via `/api/logs`, `/api/telemetry`, `/api/executions`, `/api/edog/interceptors-status`; verify output landed via `/api/onelake/table-preview-rows` + `table-metadata`.

You have `bash` and `curl`. Reach for a primitive (`scripts/qa_*.py`) for anything that must be deterministic; reach for `curl` for stimulus and observation.

## Presentation

The terminal conversation **is** the product. **Render every beat by calling `scripts/qa_render.py` and printing its output verbatim — never hand-compose the boxes, status rows, or marks in prose.** The renderer is the deterministic bridge from run-state to the design in `reference/presentation.md` (the UX source of truth) and `docs/design/mocks/flt-pr-scenario-validator-tui-v3.html`; hand-typing is what let raw JSON leak into past runs. Map each beat to a renderer call: Beat 2 → `change_summary`; Beat 3 → `plan` (+ `gate`); Beat 4 → `menu` / `locked_target`; Beat 5/7 → `results` / `verdict`; every step header → `headline`; every action → `action`; every decision → `gate`. Raw tool output (JSON, curl dumps, tracebacks) is never shown to the user — it is captured via `qa_evidence` and surfaced only through the `show #<ref>` affordance. Non-negotiables the renderer already enforces, and you must preserve when feeding it state:

- **Plain language always.** The reader is a smart engineer who does not know FLT internals. Write what they read in plain English — "couldn't check this", "the running build doesn't match your PR", "nothing needed refreshing" — never internal jargon. Only `DAG` and `MLV` are allowed, each glossed on first use.
- **Restraint is the default.** Healthy/expected states are plain; reserve the marks `▲` (needs attention) and `✕` (broken by the change) for genuine exceptions. Color is never the signal (terminal can't be trusted to render it) — **symbol + word + layout** carry state.
- **Unicode marks only — no emoji.** `◆` headline · `▸` doing/asking · `✓` good/pass · `✕` broken · `▲` needs attention · `◇` side note/coverage · `▣` locked · `◌` never-ran.
- **Status words are a fixed plain set:** `PASS · BROKEN · SUSPECTED · COULDN'T CHECK · NEVER RAN`.
- **Every fact trails its source** (`retry fired 5 times  (retry #1851)`); uncited claims do not render.
- **Each beat has a full state matrix** in `presentation.md` — render the *right* state (no-PR, already-running, nothing-runs, deploy-failed, wrong-build, nothing-to-refresh, skipped-after-failure, suspected, out-of-date, …), not just the happy path.
- **Honest about confidence:** test-setup problems render as `▲ COULDN'T CHECK` (never pass/fail); causes we can't reproduce are `▲ SUSPECTED` (never "confirmed"); steps skipped after an earlier failure are `◇` side notes, not `✕`.

## Cross-turn state

You orchestrate across many turns and are not one persistent process. After every beat, persist run state to `.edog-qa/runs/{runId}/state.json` (current beat, locked target, scenario plan, pinned `sourceCommit`, pending evidence), and write each ran case's full raw output to `.edog-qa/runs/{runId}/evidence/{ref}.json` (Beat 5, via `qa_evidence.save`). On each new turn: re-read state, `qa_run_lock.heartbeat(runId)`, and continue. Prefer fire-and-poll for long operations (deploy, DAG, Spark cold-start ≤10 min) — kick off, persist the handle, poll on subsequent turns rather than blocking.
