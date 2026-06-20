# FLT PR Scenario Validator — Design Spec

> **Date:** 2026-06-20
> **Author:** Donna (product + architecture), with Hemant Gupta
> **Status:** Draft — pending review
> **Supersedes:** F27 QA Testing (in-product LLM pipeline). See "Migration from F27."

---

## 1. The Reframe

F27 QA Testing was built as **product-as-brain**: a C# orchestrator (`EdogQaScenarioOrchestrator`) ran a caged Azure OpenAI model that emitted rigid, schema-validated JSON scenarios. An entire apparatus — `EdogQaLlmClient`, the Architect→Editor→Projector→Validator pipeline, strict-mode per-zone contracts (P10), a 7-type matcher vocabulary — existed for one reason: **to constrain a weak in-product LLM into producing safe output.**

This redesign inverts the architecture. The brain becomes a **Copilot CLI skill running Opus 4.8**. The entire cage is deleted.

| | F27 (old) | FLT PR Scenario Validator (new) |
|---|---|---|
| **Brain** | C# orchestrator + caged Azure LLM | Opus 4.8 skill, reasoning freely |
| **EDOG's role** | Does everything | **Tool provider** — sensory + motor system |
| **Scenarios** | Rigid typed JSON, schema-validated | Plain-language intents the skill executes |
| **Assertions** | Pattern-match engine guessing oracles | Invariants + grounded, cited evidence; correlation labeled as inference |
| **Where it runs** | In the FLT process | Copilot CLI, driving EDOG over HTTP |

### Why a skill, why now

The sharpest reason, in one line: **the old C# engine had no reasoning — it pattern-matched; the skill reasons.** Everything else follows from that.

1. **Opus 4.8 is the brain.** Vastly stronger reasoning than the in-product GPT-class model F27 caged. No schema gymnastics needed to keep it safe. It produces better scenarios and can actually *think* about what a change implies — the engine never could.
2. **Scenarios in plain language.** No typed stimulus contracts. The skill expresses intent ("inject a transient 429, confirm backoff fires and eventually succeeds") and executes it through tools.
3. **Cross-signal correlation** — the killer capability. A skill can ingest logs + telemetry + all 11 interceptor streams + DAG state *at once* and write the causal narrative no rule engine ever could.

---

## 2. Core Thesis: Grounded Scenarios, Not Guessed Oracles

Every testing tool needs an **oracle** — something that knows what "correct" is. F27 made the LLM the oracle (read the code, *guess* "retry fires 3 times," write a matcher). That is irreducibly non-deterministic. You cannot make a guessing machine deterministic by adding schema.

EDOG's superpower is that it **sits inside the FLT process and witnesses the complete internal causal chain** — every SQL query, retry with backoff, DI resolution, token mint, file write, DAG node transition, telemetry event. 11 interceptors, real time. No external tool (Postman, Playwright, integration tests) can see this.

We do **not** solve the oracle problem by diffing against a baseline (that path was considered and rejected — see below). We solve it with three grounded layers, none of which require the LLM to guess absolute truth:

### Layer 1 — Code understanding, done by the skill itself

The skill reads the **clean PR diff** (ADO API) and the **local FLT repo** (grep + file reads) to build the grounded structural map itself: *"your change to `ExponentialRetryPolicy.Execute` is reachable from `runDAG` via `OneLakeWriter`; the DI registration `services.AddSingleton<IRetryPolicy, ExponentialRetryPolicy>()` is right there in `Startup`; `maxRetries=3` per config."* Opus 4.8 reads code well — it does not need a caged engine to trace callers, resolve a statically-declared DI binding, or read a config constant. These are **facts it reads, not values it guesses.**

For the rare case where DI registration is *dynamic/conditional* and static reading is genuinely ambiguous, the skill has two escalations, in order: (1) query the **runtime DI registry** EDOG already captures (ground truth — what's actually wired); (2) if true semantic resolution is needed (generics, deep interface dispatch), the skill **spins up its own OmniSharp** as a tool it controls. Neither depends on the legacy C# `EdogQaCodeAnalyzer` — that engine is out of the critical path.

### Layer 2 — Invariants (absolute truths, no oracle, no baseline)

Properties that are correct or incorrect on their own terms, with nothing to compare against:
- No 5xx responses; no unhandled exceptions; no interceptor exceptions
- Every DAG run that starts terminates (no hangs)
- Every response validates against its OpenAPI schema
- No secrets (token/bearer patterns) in logs
- No new ERROR/FATAL log lines during the scenario

### Layer 3 — Evidence-grounded judgment (where Opus earns its keep)

For the nuanced calls invariants can't make, the LLM judges — but **every factual sub-claim is grounded.** It may say *"retry fired 5 times, which for a transient 429 with `maxRetries=3` is wrong"* because `maxRetries=3` came from Layer 1 (reading the code) and "fired 5 times" is cited to real trace events (§9.B). Fact + fact → a clearly-labeled inference. The diagnosis Opus is uniquely good at:

> *"Your change moved the token mint earlier in the pipeline. `EdogTokenInterceptor` shows a 15-min MWC token minted at T+2.3s [evt#1203]. The Spark write phase didn't reach `OneLakeWriter` until T+14.1s [evt#1881]. `EdogRetryInterceptor` then shows three 401 retries [evt#1882–84]; telemetry confirms `EndpointNotFound` [evt#1885]. **Inference:** token-lifetime regression — long-running DAGs will now fail their final write."*

### Rejected alternative — differential fingerprinting

An earlier draft proposed deploying the base branch, capturing a behavioral "fingerprint," deploying HEAD, and mechanically diffing the two. Rejected for three reasons: (1) it doubles deploy cost (~4 min base deploy *every run* — 40 min on a 10-PR day); (2) it requires **trace canonicalization** — reliably separating run-to-run noise (timestamps, GUIDs, concurrent ordering) from real signal, which is unsolved and fragile, and which itself fails exactly when timing *is* the signal (perf regressions); (3) it answers a narrower question ("did behavior change") than what an engineer actually wants ("does my change work, across happy/perf/failure paths"). Grounded scenarios subsume it without the cost.

---

## 3. Architecture: Brain + Body

```
┌─────────────────────────────────────────────────────────┐
│  FLT PR Scenario Validator (Copilot CLI skill, Opus 4.8) │
│  THE BRAIN                                                │
│   • reads diff, maps blast radius                         │
│   • derives plain-language scenarios                      │
│   • drives EDOG via HTTP tools                            │
│   • correlates all signal streams                         │
│   • designs follow-up experiments                         │
│   • narrates verdict                                      │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP (localhost:5555)
                            ▼
┌─────────────────────────────────────────────────────────┐
│  EDOG dev-server — THE BODY (tool provider)              │
│   EYES:    /api/logs, /api/telemetry,                    │
│            /api/edog/interceptors-status,                 │
│            /api/qa/trace-bundle (NEW)                     │
│   HANDS:   deploy, runDAG, playground, spark, infra       │
│   REFLEX:  chaos (F24), feature-flag overrides            │
│   MEMORY:  EdogQaRunStore (run history) + trace bundles   │
└───────────────────────────┬─────────────────────────────┘
                            │ in-process interceptors
                            ▼
                    FLT service (port 5557)
```

EDOG stops being the QA engine. It becomes the instrument the skill plays.

---

## 4. The Tool Surface

The skill has bash and `curl`s `localhost:5555`. Every capability already exists as a dev-server endpoint:

| Intent | Endpoint(s) | Status |
|--------|-------------|--------|
| **Generic stimulus (primary)** | **`POST /api/playground/dispatch`** + `GET /api/playground/catalog` — dispatch ANY catalogued FLT/Fabric endpoint with controlled method/body/headers, instead of hand-built URLs | Exists |
| Stimulus discovery | `GET /api/contract/capabilities`, `/api/contract/catalog/` — what stimuli are available at runtime | Exists |
| Provision infra | `/api/fabric/workspaces`, `/workspaces/{id}/assignToCapacity`, `/workspaces/{id}/lakehouses`, `/notebooks` | Exists |
| **Seed tables + MLVs** | `/api/notebook/create-session` → `execute-cell` running Spark SQL `CREATE TABLE …` and **`CREATE MATERIALIZED LAKE VIEW <schema>.<name> AS SELECT … FROM <table>`** → `close-session` (verified: FLT `CreateCSTCluster.md`, `MLV_ALREADY_EXISTS`) | Exists |
| Deploy FLT | `POST /api/command/deploy` + SSE `/api/command/deploy-stream` until `phase:running` | Exists |
| Trigger DAG | `POST /api/flt-proxy/liveTableSchedule/runDAG/{iterationId}` (skill mints the iteration GUID; `MLVExecutionDefinitionId` from the seeded MLV) + poll `getDAGExecStatus/{id}` | Exists |
| Run API | `/api/flt-proxy/*`, `/api/fabric/*` | Exists |
| Spark cell | `/api/notebook/create-session` → `execute-cell` → `close-session` | Exists |
| Flip feature flag | `POST /api/edog/feature-flags/overrides`, `DELETE .../overrides/{flag}` | Exists |
| Inject fault | F24 chaos `ErrorSimAddRule` / `ErrorSimRemoveRule` — **SignalR-only, no REST** → Phase 2 needs a REST shim or a SignalR client | Exists (SignalR) |
| Observe (raw) | `/api/logs`, `/api/telemetry`, `/api/executions` (DAG run history + timing), `/api/edog/interceptors-status`, error decode | Exists |
| **Verify output landed** | `/api/onelake/table-preview-rows`, `/api/onelake/table-metadata`, `/api/mwc/table-details` — confirm a DAG wrote the *right data*, not just "it ran" | Exists |
| Schema validation | `GET /api/playground/swagger/spec` → OpenAPI for the response-schema invariant | Exists |
| Endpoint / flag catalog | `GET /api/playground/catalog`, `/api/edog/feature-flags/catalog` | Exists |
| Read PR diff | `GET /api/ado-proxy/pr-diff` | Exists |
| Post PR comment | `POST /api/ado-proxy/pr-comment` (Beat 7) | Exists |

### The one new piece of product work

**`GET /api/qa/trace-bundle?since={T0}&correlationId={id}`** — a unified observation endpoint returning logs + telemetry + all 11 interceptor streams + DAG state in **one correlated snapshot**, every event carrying a **stable ID** and **unsampled** for the run window.

It is load-bearing for two reasons: (1) correlation is a single call returning a time-ordered, correlation-ID-joined event stream instead of stitching 5+ endpoints; (2) it is the **citable evidence ledger** — every assertion in the verdict cites a stable event ID that exists in the bundle (see §9.B). Unsampled coverage is what makes absence claims ("no error occurred") provable. **This is the highest-leverage thing to build** — everything else the skill composes from existing APIs.

---

## 5. Knowledge Strategy

The skill does not preload 400K lines of FLT or every doc. Two layers, mirroring EDOG's own Context Loading Protocol:

- **Always-loaded mental model** (~2 pages baked into the skill): what a DAG / iteration-ID / MWC token / capacity routing is; the deploy lifecycle; the 11-interceptor catalog; the FLT port/proxy topology.
- **Just-in-time retrieval**: PR touches `TokenManager.cs` → the skill greps the FLT repo and reads only the relevant docs on demand (`hivemind/DEBUGGING.md`, `docs/reference/runDAG-lifecycle.md`, the relevant ADRs).

---

## 6. End-to-End Flow (the seven-beat journey)

Phase-gated per the UX decisions: the skill **confirms at every phase boundary**, runs in the **background** with **checkpoint updates**, and (Phase 2) **auto-investigates** anomalies. The journey is mapped beat-by-beat to backend events below; **NEW** = a `qa_*` primitive or endpoint this project builds, **EXISTING** = already in EDOG.

```
BEAT 1 — INVOKE
  • Acquire single-validation lock (qa_run_lock)            [NEW]
  • Resolve the PR via DIRECT git + ADO REST (gh/az)        — no server yet
      open PR on current branch, or explicit "validate PR #1234"
  • NO PR → stop. Do not start the server.
  • PR confirmed → START the edog server (edog), await :5555 healthy
  • GET /api/flt/config + /api/edog/health                  [EXISTING]

BEAT 2 — ORIENT (the skill thinks out loud)
  • Blast radius from the CLEAN PR DIFF (ADO), never git diff on the
    deploy-patched tree (EDOG injects DevMode/Program.cs/etc.)
  • GET /api/ado-proxy/pr-diff → qa_pr_diff.parse_diff      [EXISTING/NEW]
  • Skill greps/reads the LOCAL FLT repo itself (no caged engine);
    escalate only if ambiguous: runtime DI registry → self-spun OmniSharp
  • GET /api/playground/catalog → entry-point mapping       [EXISTING]
  → grounded structural map (subsystems, entry points, config facts)

BEAT 3 — PLAN GATE  (no backend calls — pure reasoning)
  • Skill GENERATES scenarios per reference/scenarios.md protocol:
    change-type → scenario-pattern catalog. Each scenario declares
    title · category · stimulus · observations · invariants · INFRA NEEDS
  • Categories Phase 1: happy · edge · config-bound performance
    (failure-injection scenarios: Phase 2)
  ┌─ GATE: editable plan ─────────────────────────────────┐
  │ "Touches retry + token. I'll run 2 happy, 1 edge,     │
  │  1 perf. [list]. Proceed? edit / drop N / add …"      │
  └───────────────────────────────────────────────────────┘

BEAT 4 — ENVIRONMENT (scenario-aware)
  • Aggregate every scenario's infra needs → REQUIRED-INFRA SPEC
    (qa_infra_spec: N lakehouses, tables+schema, M MLVs+DAG shape) [NEW]
  • USER CHOOSES FIRST: existing infra  OR  new infra
  • EXISTING → probe (GET /api/fabric/workspaces, …/lakehouses) and
    DIFF against the required spec. If it falls short → show a CLEAR
    LIST of what's missing → user may switch to new.
  • NEW → skill-SEEDED, tailored provisioning, all via the notebook path:
      create lakehouse (/api/fabric/.../lakehouses)
      → notebook create-session → execute-cell:
          CREATE TABLE …                                   (seed tables)
          CREATE MATERIALIZED LAKE VIEW silver.<name> AS … (seed MLVs)
      → close-session.  Each create → ledger.record (auto-cleaned). [NEW]
  • qa_targets.lock_target → tuple frozen for the run         [NEW]
  ┌─ GATE: "Use existing rg_18 / spin fresh (~$X)?" ──────┐
  └───────────────────────────────────────────────────────┘

BEAT 5 — DEPLOY & RUN
  • PR code onto FLT via a SEPARATE GIT WORKTREE at the PR commit
    (.edog-qa/worktrees/{runId}) — never touches your working tree;
    worktree is a ledger entry, removed on cleanup.            [NEW]
  • ledger.record("deploy") → POST /api/command/deploy → poll SSE
    deploy-stream until phase:running                          [EXISTING]
  • qa_head_match.compare (deployed == PR commit, minus injections) [NEW]
  • qa_run_lock.heartbeat each turn                            [NEW]
  • Scenarios run HAPPY → EDGE → PERF, sequential, self-cleaning:
      stimulus: /api/playground/dispatch (generic) or runDAG / notebook
      observe: logs / telemetry / executions / interceptors-status
      verify-output: /api/onelake/table-preview-rows (DAG wrote right data)
      schema: /api/playground/swagger/spec
      qa_invariants.* over the observation window             [NEW]
  ┌─ GATE: "Deploy PR + run 4 scenarios? ~6min" ──────────┐
  └───────────────────────────────────────────────────────┘

BEAT 6 — INVESTIGATE  (lighter in Phase 1)
  • Phase 1: retry-once on infra-shaped failures (429/503),
    flag-flip-and-rerun, deeper signal correlation.
  • Cannot confirm a cause without fault injection → say honestly
    "SUSPECTED — could not confirm without fault injection (Phase 2)".
  • Full chaos-augmented confirmation = Phase 2.
  • qa_verdict.verify drops any un-cited / unverifiable claim   [NEW]

BEAT 7 — VERDICT
  • qa_verdict.Verdict.to_json per scenario                    [NEW]
  • PR comment: MARKDOWN in Phase 1 (rich causal-board HTML = Phase 3)
    → ADO REST (az rest / ado-proxy)                          [EXISTING]
  • CLEANUP: on PASS → auto-teardown; on FAIL → OFFER TO KEEP the
    environment for inspection (edog --qa-cleanup {runId} later).
  • qa_cleanup.run → reverse ledger LIFO → qa_run_lock.release [NEW]
```

Background execution means each gate posts a checkpoint and waits; the user can step away and return to confirm.

### Execution model — fire-and-poll across turns

EDOG's slow operations (deploy *minutes*, DAG runs *minutes*, optional OmniSharp warm-up) far exceed a single skill turn. The skill must **not block** a turn waiting. It **fires** an operation against EDOG's async surfaces — `POST /api/command/deploy` + the SSE `deploy-stream`, `runDAG` + `getDAGExecStatus` polling, studio-status — **ends the turn**, and **resumes on the next checkpoint**, persisting run state to `.edog-qa/runs/{runId}/state.json` (current beat, locked target, ledger ref, scenario progress) so it picks up exactly where it left off. This is what makes a 15–20-minute validation survivable inside a CLI skill rather than timing out mid-deploy.

---

## 7. Scenario Model & Generation Protocol

No schema, ever. Scenarios are **plain-language intents the skill generates from the grounded structural map**, following an explicit protocol in `reference/scenarios.md` — a **change-type → scenario-pattern catalog** so generation is repeatable, not improvised:

| Change touches | Scenarios generated | Infra it needs |
|----------------|--------------------|----------------|
| API controller / endpoint | Happy (valid → 2xx + schema valid); Edge (null / boundary / missing params → graceful 4xx) | lakehouse; maybe 1 table |
| DAG node / scheduling | Trigger DAG → verify node transitions → final `Completed` | an MLV with a multi-node DAG over ≥1 table |
| Retry / resilience policy | P1: observe the path under normal stimulus · P2: inject fault → backoff ≤ `maxRetries` | depends on path |
| Token / auth flow | Long-running DAG → observe token lifetime across the write | a longer MLV DAG |
| Spark client / session | session → trivial query → close → pool health | lakehouse + notebook |
| Cache / DI / file-system | exercise via the nearest entry point, observe the interceptor | varies |

**Every generated scenario carries six fields:** `title · category · stimulus (tool + args) · observations to collect · invariants to check · infra requirements`. The infra-requirements field is what feeds Beat 4's required-infra spec (`qa_infra_spec`). Categories reuse the existing `ScenarioCategory` taxonomy (`HappyPath, ErrorPath, EdgeCase, Regression, Performance`); failure-injection scenarios are generated but **deferred to Phase 2** until chaos is ready. Execution uses existing tools:


| Change type | Category | Derived scenario (plain English) | Stimulus tool |
|-------------|----------|----------------------------------|---------------|
| Retry policy | Failure | "Inject a transient 429, confirm backoff stays within `maxRetries`=3 and eventually succeeds" | chaos + DAG/API |
| Token flow | Failure | "Run a long DAG; watch for mid-run token expiry" | runDAG + trace-bundle |
| New endpoint | Happy / Edge | "Call with valid + boundary inputs; assert schema + no 5xx" | playground |
| DAG node logic | Happy | "Trigger DAG, verify node transitions and final state Completed" | runDAG + getDAGExecStatus |
| Any hot path | Performance | "Run under load; assert completion within the config/SLA bound read from code" | runDAG / playground |
| Spark client | Happy | "Create session, run trivial query, verify pool responsive" | notebook session |
| Feature flag | Edge | "Run with flag ON and OFF, verify each path behaves per its contract" | flag override + re-run |

The applicable categories are chosen by the LLM from the blast radius — a retry-policy change pulls in failure-injection scenarios; a new endpoint pulls in happy + boundary; a hot-path change pulls in performance.

---

## 8. Verdict Model

**Per-scenario, intent-framed** — not a bare PASS/FAIL, and not a baseline diff (there is no baseline). Each scenario gets a grounded verdict; the headline frames them against the change's intent:

```
FLT PR Scenario Validator — retry policy + token flow

  ✓ HAPPY PATH (2/2)
    • DAG completes, final state Completed          [evt#1402]
    • New endpoint /insights/summary → 200, schema valid [evt#1455]

  ✓ PERFORMANCE (1/1)
    • DAG completed in 4.2s, under the 30s config bound  [evt#1402,#1511]

  ✗ FAILURE INJECTION (2/3)
    • Transient 429 → backoff recovered                  [evt#1620–24]
    • Null capacity → handled gracefully, 400 returned   [evt#1701]
    • Retry overshoot: fired 5 times, but maxRetries=3
        Code fact: maxRetries=3 (RetryPolicy.cs:142)      [Layer-1]
        Observed:  5 retry events                         [evt#1847–51]
        Inference (confirmed via chaos re-run): your
        HttpClientFactory timeout change lowered the
        per-attempt deadline, so the same transient now
        triggers 2 extra retries.

  Confidence: high (root cause confirmed by follow-up experiment)
```

Ground truth: invariant suite + Layer-1 code facts. Diagnosis: Opus, with every factual sub-claim cited (§9.B). Confidence rises when a follow-up experiment confirmed the cause.

### Invariant suite (always-true properties, deterministic, no baseline)
- No 5xx responses
- Every response validates against its OpenAPI schema
- No secrets (token/bearer patterns) in logs
- Every DAG run that starts terminates (no hangs)
- No new ERROR/FATAL log lines during the scenario
- No interceptor exceptions
- Latency within the bound read from config/SLA, if one exists in code. **No invented thresholds** — if no bound is declared, timing is *reported as an observation*, not asserted (inventing a number is just the oracle problem with a stopwatch).

### Coverage honesty (untestable code)

Some changed code has no entry point any available stimulus can reach (an internal helper, a branch only reachable under conditions we can't induce). The skill **says so plainly** — *"this path isn't reachable by any available stimulus; manual verification needed"* — and never fabricates a weak scenario to look thorough. Coverage is reported as `tested / reported-only / not-reachable`, not inflated. Honest "can't test this" beats theater.

### Flakiness & severity (a FAIL is not always a block)

A failed scenario is not automatically a verdict-blocking FAIL. Two filters apply before anything is reported as the PR's fault:

1. **Retry-once on infra-shaped failures.** A transient INT-capacity 429, a deploy hiccup, a token-routing 503 — these are environment noise, not the change. The skill retries the scenario once; only a *reproducible* failure counts. (Single retry, not a retry storm — a flaky test that needs 5 retries is itself a signal.)
2. **Rank by attribution confidence.** A schema violation on an endpoint the PR touched is **high-confidence "your change."** A 503 from the capacity gateway is **low-confidence "probably infra."** The verdict surfaces failures ranked by how attributable they are to the diff, tying directly into the harness-vs-test separation (§9.B). The headline FAIL is reserved for high-confidence, change-attributable, reproduced failures.

---

## 9. Guardrails

The skill can do anything a user can do — provision capacities (real money), deploy code, trigger DAGs, inject chaos, override feature flags, post to PRs — and it is driven by a probabilistic model. The danger is not one catastrophic action; it is the **accumulation of plausible small ones**: an un-cleaned chaos rule, a capacity that keeps billing after the run dies, a flag override that leaks into the next session, a DAG triggered against the wrong lakehouse.

Two orthogonal guardrail families, each a wall **at the tool boundary** — never the model policing itself.

### 9.A Operational guardrails (protect the environment from the agent)

**Core principle: never trust the agent to be the source of truth for safety or cleanup.** The failure mode that hurts is the one where the agent *crashed* and never reached its own cleanup step.

**1. Locked target (interactive selection → frozen tuple).**
At PHASE 0 the skill lists workspaces (`/api/fabric/workspaces`) and lakehouses (`/workspaces/{id}/lakehouses`) **enriched with decision context** — capacity SKU + rough cost, a flag on anything production-ish, and whether each lakehouse is empty (safe) or holds data (handle with care). The menu's first option is **"create fresh sandbox."** The user picks `(workspace, lakehouse, capacity)` — or fresh.

That tuple is then **frozen for the entire run**. Every mutating tool call is checked against the locked target at the tool boundary. The agent physically cannot address a different lakehouse mid-run, no matter what an ID drift or hallucination suggests. Rejected alternative: trusting the model to "stay on the right environment" — that is asking the probabilistic thing to police its own probabilism.

**2. Created-vs-reused (only destroy what you created).**

| Target | Teardown | Destructive stimuli (DAG writes, file events, corrupting chaos) |
|--------|----------|------------------------------------------------------------------|
| **Fresh** (agent created) | Deleted on cleanup — recorded in the teardown ledger | Full freedom — nothing real to break |
| **Existing** (user's real lakehouse) | **Never deleted** — not in the ledger, only exercised | **Extra confirmation** before anything that writes or mutates data |

The rule underneath: **the agent may only destroy what it created.** A handed-over lakehouse is read, exercised, observed — never torn down. If it holds real data, a write-DAG or corrupting chaos rule is gated behind one more "this touches real data, proceed?" — the line between a test and an incident.

**3. Teardown ledger (reversibility, owned by EDOG not the agent).**
Every mutating action — flag override, chaos rule, created infra, deployed branch — is appended to a **persisted teardown ledger on disk** *before* it executes. Cleanup replays the ledger in reverse inside a `finally` that runs on normal completion, crash, Ctrl+C, or agent death. Critically, the ledger is owned by EDOG (the body) and replayable by a standalone `edog qa --cleanup` command that works **even if the skill process is gone.** Capacity that bills money after the agent died at 2am is the exact incident this prevents. (Extends the P10 `finally`-scoped disposal pattern into the spine.)

**4. Resource ceilings + independent dead-man's switch.**
Every run carries a hard budget: max wall-clock (default 30 min), max capacities created (default **0** — reuse-only unless explicitly told), max DAG triggers, max chaos rules, max tokens. A watchdog **independent of the agent loop** (the agent cannot be trusted to check its own budget) tears down everything via the ledger if the budget blows or the run goes silent. (Reuses the `EdogQaExecutionEngine._runLock` + 30-min ceiling pattern, made authoritative.)

**4-bis. Single-validation lock (the environment is a singleton).**
EDOG drives exactly one FLT instance (port 5557). Two concurrent validations would deploy competing branches onto the same FLT and clash on flag overrides and DAG runs — both verdicts garbage, silently. So **one validation runs at a time, globally.** A second invocation detects the lock and **refuses** with a clear message ("a validation is already running against this environment; wait for it to finish") rather than silently queueing a 20-minute job. The lock is held by EDOG (survives skill death) and released by the same teardown path as the ledger.

**5. Phase action allowlist.**
The per-phase confirmation gate is not just "proceed Y/N" — each phase declares the **exact set of mutating operations it is permitted**. PHASE 2 (deploy & run) may deploy + trigger + observe; it **cannot** create infra or post to a PR. An out-of-phase action is refused at the tool boundary, not by asking the model nicely.

**6. Confirmation gates (the last line, not the only line).**
The human-in-the-loop layer chosen in §10: confirm at every phase boundary. Necessary, but it protects only against *intended* expensive actions — layers 1–5 catch what a confirmation prompt never sees.

### 9.B Epistemic guardrails (protect the verdict from the agent)

This is the structural fix for the original disease: F27's assertions "didn't go right" because the LLM emitted claims with nothing underneath them. Prompt-level grounding ("please cite evidence") produces *citation-shaped text*, not grounding. Grounding is enforced **mechanically, after the model speaks.**

**1. No claim is free text — every assertion is a structured, cited object.**

```
{
  claim:      "Retry fired 5 times on the OneLakeWriter path",
  evidence:   ["evt:retry#1847", "evt:retry#1848", ..., "evt:retry#1851"],
  kind:       "grounded_fact",
  confidence: "high"
}
```

An `evidence` reference is a **stable pointer into the trace bundle** — an interceptor event sequence number, a log line ID, a telemetry event with correlation ID, a spark session event. **Empty `evidence` → the claim never reaches the report.** This is the second reason `/api/qa/trace-bundle` is load-bearing: it is both the correlation source and the **citable evidence ledger.** A claim can only cite an ID that exists in the bundle.

**2. The verification pass (the mutation-test of assertions).**
Before the verdict finalizes, a **deterministic checker — not the LLM** — re-reads every cited eventRef and confirms the claim's checkable shape against the actual events:

| Claim shape | Mechanically verified by |
|-------------|--------------------------|
| Count ("fired 5 times") | counting events with those IDs |
| Presence ("a 401 occurred") | event exists with that field value |
| Value ("returned Completed") | cited event's field equals the value |
| Order ("mint before write") | cited timestamps are in that order |
| Absence ("no error occurred") | query over the bundle returns zero — *see #4* |

Model says "5 times, #1847–1851"; checker counts 4 → claim **rejected or downgraded to unverified.** The model cannot lie about anything mechanically checkable because something that isn't the model checks it.

**3. Fact / inference split (keep Opus's correlation, never disguise it as fact).**
Correlation is the whole value (§1, the cross-signal narrative) — but correlation is *inference*. We separate it, visibly:
- **Grounded fact** — backed by ≥1 *verified* eventRef. Rendered plainly.
- **Model inference** — a hypothesis chaining grounded facts ("these indicate a token-lifetime regression"). Rendered distinctly, and it **must reference the grounded facts it reasons over.** An inference with no underlying facts is rejected. Opus earns its keep here, but never floats free of evidence and is never dressed up as fact. The reviewer sees exactly where observation ends and reasoning begins.

**4. Absence requires completeness (the trap that bites).**
"No error occurred" is provable *only* if the trace bundle is **complete** for the window. The P10 telemetry spec sampled high-volume events — under sampling, absence is unprovable and "no regression" becomes a lie of omission. Therefore the QA trace-bundle is **unsampled for the run window**, or every absence claim auto-downgrades to "not observed (coverage incomplete)." Grounded negatives demand complete evidence, not sampled evidence.

**5. Harness failure ≠ test failure (don't let the agent mislabel its own blockage).**
If the *environment* breaks, that is NOT a verdict on the change — the skill was *blocked*:

```
⚠ COULD NOT VALIDATE — deploy failed at step 3 (build error)
   Environment problem, not a verdict on your change. [deploy log link]
```
vs.
```
✗ YOUR CHANGE broke retry logic on the OneLakeWriter path
```

Conflating these erodes trust fast. They render in distinct categories everywhere (terminal, HTML, PR comment), and a harness failure can never be reported as a PASS or a FAIL.

### 9.C Why two families

Orthogonal walls catching different escapes. **Operational** protects the environment from the agent's *actions*; **epistemic** protects the verdict from the agent's *claims*. Neither trusts the model to police itself; both enforce at the boundary.

---

## 10. UX Decisions (locked)

| Dimension | Decision |
|-----------|----------|
| Name | **FLT PR Scenario Validator** |
| Invocation | PR-based only (open PR on branch, or explicit PR #/URL) |
| Server lifecycle | Skill starts the edog server **after** PR detection (no PR → no server) |
| Confirmation | Confirm at every phase boundary |
| Run rhythm | Background + checkpoint updates |
| Investigation | Auto-investigate (Phase 2 chaos); Phase 1 = retry/flag/correlate + honest "suspected" |
| Curation | Editable plan before run (conversational) |
| Scenario generation | Explicit protocol in `reference/scenarios.md`; each scenario declares infra needs |
| Infra | User picks existing/new first; existing → fitness-check + "what's missing"; new → skill-seeded, tailored |
| PR checkout | Separate git worktree at the PR commit (never touches the working tree) |
| Verdict | Per-scenario, intent-framed |
| Harness vs test failure | Clearly separated |
| Output | Terminal + PR comment (markdown P1; rich HTML board P3) |
| Cleanup | On pass → auto-teardown; on fail → offer to keep env for inspection |
| Safety | Fully autonomous, gated at phase boundaries |
| Location | Versioned in repo (`skills/`), symlinked to user-global `~/.copilot/skills/` |

---

## 11. HTML Report

Dark, Palantir aesthetic (per EDOG design bible). The **hero is the correlated causal timeline** — a single time-axis showing all signal streams (logs, telemetry, interceptor events, DAG transitions) aligned, with any failure highlighted and its causal chain traced. Sections:

1. **Verdict banner** — per-scenario summary (passed / failed by category)
2. **Causal timeline** (hero) — multi-stream, correlation-ID-joined, failure path highlighted
3. **Scenario cards** — each with stimulus, observed behavior, grounded verdict + cited evidence
4. **Evidence** — raw trace bundles, expandable, each claim links to its event ID
5. **Environment provenance** — capacity, commit SHA, deploy timing

---

## 12. Migration from F27

### Reused
- `EdogQaStimulusDispatcher` — optional, for advanced stimuli (DI invocation, SignalR broadcast)
- `flt_catalog.py` + `/api/playground/catalog` — endpoint knowledge
- The **runtime DI registry** data (`EdogDiRegistryCapture` via the `di` topic) — *optional* ground-truth input for dynamic-DI cases the skill can't resolve statically
- ADO proxy, deploy pipeline, infra wizard APIs, chaos engine, flag override — all as tools
- The 11 interceptors — the evidence/trace source

### Retired / not used
- **The entire legacy code-understanding engine** — `EdogQaCodeAnalyzer`, `EdogQaOmniSharpProvider`, `EdogQaGraphProvider`, `EdogQaInvariantExtractor`, `EdogQaScenarioOrchestrator`, `EdogQaLlmClient`, `EdogQaLlmProvider`, `EdogQaAssertionEngine`. The skill does code understanding itself (reads diff + repo; self-spins OmniSharp only if needed). Earlier draft proposed reusing the analyzer's pre-LLM half via a new endpoint — **dropped**: the skill reasons over code directly, so neither the engine nor a new analyzer endpoint is needed.
- The typed stimulus/matcher contract schemas (P10) — replaced by plain-language intent
- Curation stage UI, analysis UI, scenario editor — replaced by conversational curation
- `qa-panel.js` and all frontend QA modules — replaced by the skill + HTML report

### New
- The skill itself, versioned at `skills/flt-pr-scenario-validator/` → symlinked to user-global, with `reference/{flt-model,tools,scenarios}.md`
- **`reference/scenarios.md`** — the scenario-generation protocol (change-type → pattern catalog; each scenario declares infra needs)
- **Python primitives** (`scripts/qa_*.py`, TDD'd): `qa_run_lock`, `qa_teardown_ledger`, `qa_cleanup`, `qa_pr_diff`, `qa_head_match`, `qa_targets`, `qa_infra_spec` (required-vs-available infra diff), `qa_invariants`, `qa_verdict`
- `edog --qa-cleanup {runId}` standalone ledger reverser (EDOG-owned, survives skill death)
- Worktree-based PR checkout (`.edog-qa/worktrees/{runId}`) — never touches the working tree
- **Locked-target enforcement** + created-vs-reused gating at the tool boundary
- **Verification pass** (`qa_verdict.verify`) — deterministic checker that confirms every cited assertion against the trace bundle
- `GET /api/qa/trace-bundle` unified observation endpoint (stable IDs, unsampled) — *Phase 3*
- Independent dead-man's-switch watchdog (budget + silence teardown) — *Phase 4*

---

## 13. Success Criteria

1. Engineer says "validate my change" → gets a confirmed, plain-language verdict end-to-end.
2. Zero hallucinated assertions — every claim cites a verified trace-bundle event; the verification pass rejects or downgrades anything it can't confirm.
3. Catches a real blast-radius regression an engineer would have missed (the OneLakeWriter-three-layers-away case).
4. Root causes are *confirmed* by follow-up experiments (Phase 2); in Phase 1, unconfirmable causes are honestly marked "suspected".
5. Harness failures never masquerade as test failures.
6. The HTML report is good enough to paste into a design review as evidence.
7. **No orphaned state ever** — a killed/crashed run leaves zero billing capacities, zero lingering chaos rules, zero leaked flag overrides; `edog qa --cleanup` fully reverses the ledger even with the skill process gone.
8. **The agent cannot address any target outside the locked tuple**, and never deletes anything it did not create.

---

## 14. Open Questions / Phasing

Guardrails are **not** a late phase. The locked target, teardown ledger, phase allowlist, and evidence-cited verdict are **foundational** — they ship with the first thing that can mutate state or emit a claim.

- **Phase 1 (MVP):** run-lock → PR resolution (direct git/ADO) → **start server after PR** → skill-native code understanding (diff + repo grep) → scenario generation (`reference/scenarios.md`) with infra needs → **scenario-aware environment** (user picks existing/new; existing fitness-check; new = skill-seeded, tailored) → **worktree** PR checkout → deploy + HEAD-match → **happy/edge/perf** scenarios (self-cleaning) → invariant grounding + evidence-cited verdict (`qa_verdict.verify`) → **markdown PR comment** → cleanup (auto on pass, **offer-keep on fail**) + `edog --qa-cleanup`. **No failure injection, no chaos investigation.**
- **Phase 2:** **failure-injection scenarios** (once chaos/error-sim matures) + auto-investigation (chaos-augmented confirmation; upgrades Phase-1 "suspected" to "confirmed") + destructive-op gating on reused-with-data.
- **Phase 3:** trace-bundle endpoint (stable IDs, unsampled) + verification pass over the unified bundle + full cross-signal correlation + rich HTML causal-board report (richer PR comment links to it).
- **Phase 4:** infra auto-provisioning polish + independent dead-man's-switch watchdog.

**To resolve during planning:** how the skill self-spins OmniSharp on demand (binary discovery, warm-up cost, when it's worth it vs plain code-reading); how cross-turn run state is persisted (session store vs a file EDOG owns); trace-bundle retention window and the unsampled-window cost; concurrency (single-validation lock, like `EdogQaExecutionEngine._runLock`); how the verification pass handles claims whose shape isn't mechanically checkable (semantic interpretation → forced into the inference tier); the repo `skills/` → user-global symlink install step.
