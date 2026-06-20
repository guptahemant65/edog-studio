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
| **Generic stimulus (primary)** | **`POST /api/playground/dispatch`** — dispatches ANY well-formed path (validation is well-formedness only, `dev-server.py:676`; **not catalog-limited**) → the **entire FLT API surface** is reachable. Envelope `{tokenType, method, path, headers, body, timeout}`. | Exists |
| **Complete API discovery** | **`GET /api/playground/swagger/spec`** → the live `/swagger/v1/swagger.json` (Swashbuckle runtime spec) — the *complete* endpoint list, including PublicAPI/MLV controllers the static catalog omits | Exists |
| Stimulus discovery (curated) | `GET /api/playground/catalog`, `/api/contract/capabilities` — UI-curated subset (liveTable-prefixed); convenience only, NOT the coverage boundary | Exists |
| Provision infra | `/api/fabric/workspaces`, `/workspaces/{id}/assignToCapacity`, `/workspaces/{id}/lakehouses`, `/notebooks` | Exists |
| **Seed tables + MLVs** | Workspace → assignToCapacity → **schema-enabled** lakehouse → **notebook artifact** → `/api/notebook/create-session` → `execute-cell` running **Python** `spark.sql("CREATE TABLE …")` and `spark.sql("CREATE MATERIALIZED LAKE VIEW silver.<n> AS …")` → `close-session`. Audited: session is notebook-artifact-bound; kernel is `synapse_pyspark` and `language` is ignored; cold-start ≤10min; outputs give ok/error. A SQL-created MLV is catalog-registered and runnable via runDAG with no separate MLVExecutionDefinition (FLT-owner verified). | Exists |
| Deploy FLT | `POST /api/command/deploy` + SSE `/api/command/deploy-stream`; completion = `event: complete`, phase `running`, `deployMessage:"Deploy complete"`. **Audited:** deploy is config-driven (patches `flt_repo_path` in place, no repo-path arg, no checkout) → worktree flow must repoint `flt_repo_path`. | Exists |
| Trigger DAG | `POST /api/flt-proxy/liveTableSchedule/runDAG/{iterationId}` — **the skill generates a fresh GUID `iterationId` (= OpId)**; body optional (`MLVExecutionDefinitionId` not required) → poll `getDAGExecStatus/{id}` (states: running/completed/failed/cancelled/…) | Exists |
| Run API | `/api/flt-proxy/*`, `/api/fabric/*` | Exists |
| Spark cell | `/api/notebook/create-session` → `execute-cell` → `close-session` | Exists |
| Flip feature flag | `POST /api/edog/feature-flags/overrides` (+ `/overrides/bulk`), `DELETE .../overrides/{flag}` — **synchronous push to FLT:5557 with `X-EDOG-Control-Token`; success requires hash+revision echo (`applied`).** **Flag STATE is NOT in `FeatureNames.cs`** (that holds only the C# const + its wire-key literal); it lives in the **FM repo** (FMv2 — sparse-cloned to `~/.edog-cache/feature-management/`, `Features/**/*.json`, the `Id` field = the real wire key, per-env `Enabled`/`Targets` pivot-evaluated). The catalog (`/api/edog/feature-flags/catalog`) resolves it → `wireKey/effectiveForMyWorkspace/locked/isOverridden/overrideValue`. Override takes a **bool** (force-ON *or* force-OFF). **CRITICAL false-PASS traps:** (1) override the **wire key/FM Id**, not the C# const name — they can differ, and a wrong key silently no-ops; (2) a flag-gated change is NOT exercised unless flipped — VERIFY the new `effectiveForMyWorkspace` after the POST; `locked`/`missing` flags can't be forced (harness limitation, not a verdict). See §7. | Exists |
| Inject fault | F24 chaos `ErrorSimAddRule` / `ErrorSimRemoveRule` — **SignalR-only, no REST** → Phase 2 needs a REST shim or a SignalR client | Exists (SignalR) |
| Observe (raw) | `/api/logs`, `/api/telemetry`, `/api/executions` — **AUDITED: transparent proxies to the FLT log server; query params + response shapes are FLT-DEFINED, not EDOG's.** The skill discovers the real contract at runtime (do NOT assume `?since=&level=`). Plus `/api/edog/interceptors-status` (proxies FLT). | Exists |
| **Verify output landed** | `/api/onelake/table-preview-rows`, `/api/onelake/table-metadata`, `/api/mwc/table-details` — reads **live Delta parquet rows**; confirm a DAG wrote the *right data*, not just "it ran" | Exists |
| Schema validation | `GET /api/playground/swagger/spec` → OpenAPI for the response-schema invariant | Exists |
| Endpoint / flag catalog | `GET /api/playground/catalog`, `/api/edog/feature-flags/catalog` | Exists |
| Read PR diff | `GET /api/ado-proxy/pr-diff` — returns `{prId, title, author, diff, sourceCommit, commonCommit, …}` (audited; `sourceCommit` feeds HEAD-match) | Exists |
| **API-contract diff (deterministic grounding)** | Generate the swagger **from main and from the PR branch with `dotnet swagger tofile`** (Swashbuckle CLI) on each branch's *built assembly*, then diff the two (`qa_contract_diff.diff`). Both specs via the **same** generator = apples-to-apples (no runtime-vs-tofile formatting noise); main needs only a **build, not a deploy** (PR is built by Beat 5 anyway). **The committed `Swagger/Swagger.json` is NOT used as a baseline — it drifts**, so `/api/playground/swagger/diff` (runtime-vs-committed) is not trusted. The two-spec diff yields stable `ch-NNN` change IDs; removed/signature-changed endpoints = breaking. Requires the `Swashbuckle.AspNetCore.Cli` tool + a loadable assembly (setup note in plan). | NEW |
| **Deterministic failure attribution** | `src/frontend/js/error-sim-catalog.js` (115 codes tagged `errorSource` User/System · `category` · `httpStatus` · `fltCodePath`) + `error-decoder.js` (regex-scans logs for `MLV_/FLT_/SPARK_/GTS_` codes → O(1) lookup w/ severity, retryable, suggestedFix). Lets the skill classify a failure as **change-attributable** (`User`+validation/auth) vs **infra** (`System`+throttling/execution) *mechanically*, not by LLM guess (feeds §9.B attribution + harness-vs-test split). | Exists |
| **Token-expiry / health check** | `GET /api/edog/health` → `bearerExpiresIn`, `tokenExpired`, `mwcToken` state; `/api/flt/config` reports `bearerToken`/MWC availability. Bearer (~1h, 5-min buffer) **auto-refreshes mid-run iff a username/session is saved**; MWC has a 15-min refresh buffer. 401/403 → re-auth required; 404 → `capacity_routing_not_ready` (retryable). The skill checks `bearerExpiresIn` before long ops. | Exists |

### The one new piece of product work

**`GET /api/qa/trace-bundle?since={T0}&correlationId={id}`** — a unified observation endpoint returning logs + telemetry + all 11 interceptor streams + DAG state in **one correlated snapshot**, every event carrying a **stable ID** and **unsampled** for the run window.

It is load-bearing for two reasons: (1) correlation is a single call returning a time-ordered, correlation-ID-joined event stream instead of stitching 5+ endpoints; (2) it is the **citable evidence ledger** — every assertion in the verdict cites a stable event ID that exists in the bundle (see §9.B). Unsampled coverage is what makes absence claims ("no error occurred") provable. **This is the highest-leverage thing to build** — everything else the skill composes from existing APIs.

> **Audited evidence reality (what's citable when).** Real stable IDs exist *today*: every interceptor event carries a monotonic `TopicEvent.SequenceId` (per topic — `log/telemetry/http/retry/dag/token/spark/fileop/cache/catalog/flt-ops/…`) plus payload IDs (`IterationId`, `CorrelationId`, `RootActivityId`, `dagId`, `nodeId`, `sessionTrackingId`). **But** the rich topic-event stream is **SignalR-primary**; over plain REST the skill gets `/api/logs`, `/api/telemetry`, `/api/stats`, `/api/executions`, `/api/edog/interceptors-status`. So **Phase 1 grounds on logs + telemetry + onelake rows + http responses + swagger-diff `ch-NNN` + error-codes** (all REST-citable); full topic-event citation (e.g. `retry:#1851`, `dag:#1847` SequenceIds) is exactly what the **Phase-3 trace-bundle** exposes over REST. Also audited: **interceptors do NOT capture method return values** — only status/duration/errors/counts — so grounded claims must cite *captured fields*, never "the method returned X." The trace-bundle additionally mints a single canonical cross-topic trace ID (current IDs are topic-local).

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
  • PR confirmed → START the edog server HEADLESS (launch scripts/dev-server.py
    directly, or `edog --no-browser`) — NO EDOG Studio webpage auto-opens;
    the skill drives the API on :5555 only. await :5555 healthy
  • GET /api/flt/config + /api/edog/health                  [EXISTING]
  • check health.bearerExpiresIn; ensure a saved username/session so the
    bearer auto-refreshes across a long run

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
    · PRECONDITIONS · (optional) SUB-SCENARIOS
  • PRECONDITIONS = scenario-specific setup beyond infra counts. Real
    grounded example — to fire the CDFDisabled warning, ALL THREE:
      - FLAG: FLTMLVWarnings = ON  (else warnings are never parsed from
        GTS output — Node.cs only PySpark-wraps the SQL when this is on)
      - FLAG: FLTIRDeltaPhysicalCDFEnabled = OFF (physical CDF would
        synthesize CDF and suppress the source-CDF-missing warning)
      - TABLE PROP: source table created with delta.enableChangeDataFeed
        = false — at SEED time, not patched after
    → MLV refresh detects source lacks CDF → falls back to FULL refresh
      → NodeWarning{CDFDisabled, relatedSourceEntities:[ws.lh.schema.tbl]}.
      OBSERVE on node.warnings (DAG status) / node_exec_metrics.json /
      sys_node_metrics.warnings — NOT on the output rows (data is identical
      with or without the warning; the warning IS the signal).
  • SUB-SCENARIOS: one scenario can fan out into several (e.g. "CDF
    insights card" → many cases) sharing infra, and may need a COMPLEX
    MULTI-NODE DAG to exercise every path. infra-needs carries the DAG
    SHAPE, not just counts.
  • Categories Phase 1: happy · edge · config-bound performance
    (failure-injection scenarios: Phase N — timing TBD)
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
  • NEW → skill-SEEDED provisioning (AUDITED step order):
      1. create workspace + assignToCapacity (Fabric API)
      2. create a SCHEMA-ENABLED lakehouse — pass the Fabric schema flag;
         default creation is NON-schema and silver.<name> MLVs REQUIRE
         schemas (audited).
      3. create a NOTEBOOK artifact (/notebooks) — the Jupyter session is
         artifact-bound; no notebook → no session (audited).
      4. create-session → execute-cell (kernel = synapse_pyspark; the
         `language` field is ignored, so DDL is wrapped as Python):
           spark.sql("CREATE TABLE …")                         (seed tables)
           spark.sql("CREATE MATERIALIZED LAKE VIEW silver.<n> AS …") (MLVs)
         Cold-start polls up to 10 min; outputs give status ok/error.
      5. close-session.  Each create → ledger.record (auto-cleaned). [NEW]
      Note: a SQL-created MLV is catalog-registered and runnable via runDAG
      with NO separate MLVExecutionDefinition (verified by FLT domain owner).
  • qa_targets.lock_target → tuple frozen for the run         [NEW]
  ┌─ GATE: "Use existing rg_18 / spin fresh (~$X)?" ──────┐
  └───────────────────────────────────────────────────────┘

BEAT 5 — DEPLOY & RUN
  • PR code onto FLT via a SEPARATE GIT WORKTREE at the PR commit
    (.edog-qa/worktrees/{runId}) — never touches your working tree.
    AUDITED: deploy is config-driven (patches flt_repo_path in place; no
    repo-path arg, no checkout). So the worktree flow is:
      create worktree → REPOINT config.flt_repo_path → worktree
      (ledger: config_restore w/ old value) → deploy → restore config
      → remove worktree on cleanup.                             [NEW]
  • ledger.record("deploy") → POST /api/command/deploy → poll SSE
    deploy-stream; completion = `event: complete` with phase "running"
    + deployMessage "Deploy complete"                          [EXISTING]
  • qa_head_match.compare — deployed commit == PR commit, minus the AUDITED
    injection set (FILES: GTSBasedSparkClient, Program, WorkloadApp,
    DagExecutionHandlerV2, … + DevMode/*)                       [NEW]
  • qa_run_lock.heartbeat each turn                            [NEW]
  • CONTRACT DIFF (controller/DTO PRs): generate swagger from main +
    from the PR branch via `dotnet swagger tofile` on each BUILT assembly
    (main = base-commit worktree, BUILD only — no deploy), diff via
    qa_contract_diff.diff → cite ch-NNN; removed/modified = breaking.
    (Do NOT use the stale committed Swagger.json baseline.)         [NEW]
  • FLAG-GATED change: flip the flag ON (feature-flags/overrides) BEFORE
    exercising — else you validate the OLD path (false PASS); run ON+OFF.
  • Scenarios run HAPPY → EDGE → PERF, sequential, self-cleaning:
      enforce PRECONDITIONS first (flag overrides + table props e.g. CDF=false)
      stimulus: /api/playground/dispatch (any path) or runDAG
        — runDAG: the skill GENERATES a fresh GUID iterationId (= OpId);
          body optional; poll getDAGExecStatus/{guid}
      observe (grounded): (1) the API RESPONSE BODY/output of the stimulus
        call itself — assert + cite it, not just the status code;
        (2) FLT-NATIVE STRUCTURED OUTPUTS — the real semantic oracles:
        node.warnings (e.g. CDFDisabled), refresh_policy, NodeExecutionMetrics
        (added/dropped row counts, status, error_code/source), and the sys_*
        insights tables (sys_node_metrics / sys_run_metrics). These carry FLT
        semantics that raw rows + logs do NOT (a CDF change leaves the output
        rows identical — the warning is the only signal);
        (3) logs / telemetry / executions — AUDITED: transparent proxies to
        the FLT log server; query params + shapes are FLT-DEFINED, so the
        skill DISCOVERS the contract at runtime (do NOT assume ?since=&level=).
      verify-output: /api/onelake/table-preview-rows (reads live Delta
        parquet — confirms the DAG wrote the RIGHT rows, not just "ran")
      classify any failure via qa_error_classify (change vs infra)
      qa_invariants.* over the observation window             [NEW]
  ┌─ GATE: "Deploy PR + run 4 scenarios? ~6min" ──────────┐
  └───────────────────────────────────────────────────────┘

BEAT 6 — INVESTIGATE  (lighter in Phase 1)
  • Phase 1: retry-once on infra-shaped failures (429/503),
    flag ON-vs-OFF rerun, deeper signal correlation.
  • Cannot confirm a cause without fault injection → say honestly
    "SUSPECTED — could not confirm without fault injection (Phase N, TBD)".
  • Full chaos-augmented confirmation = Phase N (timing TBD).
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
| API controller / endpoint | Happy (valid → 2xx + schema valid + **assert response body**); Edge (null / boundary / missing params → graceful 4xx); **Contract-diff** (diff main-vs-PR swagger via `dotnet swagger tofile` → assert each `ch-NNN` change is intended, flag removed/modified endpoints as breaking) | lakehouse; maybe 1 table |
| DAG node / scheduling | Trigger DAG → verify node transitions → final `Completed` | an MLV with a multi-node DAG over ≥1 table |
| Retry / resilience policy | P1: observe the path under normal stimulus · P2: inject fault → backoff ≤ `maxRetries` | depends on path |
| Token / auth flow | Long-running DAG → observe token lifetime across the write | a longer MLV DAG |
| Spark client / session | session → trivial query → close → pool health | lakehouse + notebook |
| Cache / DI / file-system | exercise via the nearest entry point, observe the interceptor | varies |

**Every generated scenario carries eight fields:** `title · category · stimulus (tool + args) · observations to collect · invariants to check · infra requirements · preconditions · sub-scenarios`.
- **infra requirements** feeds Beat 4's required-infra spec (`qa_infra_spec`) — and carries not just counts but **table/MLV properties** (e.g. a source table with `CDF = false`) and **DAG shape** (a multi-node DAG when the scenario needs to exercise many paths).
- **preconditions** are scenario-specific setup the env step must enforce *before* stimulus: required **flag state** and required **table/MLV properties** (set at seed time, not patched after). Grounded example — to fire a `CDFDisabled` warning you need **all three**: `FLTMLVWarnings` **ON** (else warnings are never parsed), `FLTIRDeltaPhysicalCDFEnabled` **OFF** (physical CDF would suppress the source-CDF-missing warning), and the **source table seeded with `delta.enableChangeDataFeed=false`** — then the MLV falls back to full refresh and emits `NodeWarning{CDFDisabled}`, observed on `node.warnings` (not on the output rows).
- **sub-scenarios** let one scenario (e.g. "CDF insights card") fan out into several cases that **share infra** but each have their own stimulus/observations — so a single complex DAG is seeded once and exercised many ways.

**Observations are grounded on real evidence**, including the **API response body** of the stimulus call itself (asserted + cited), not only logs/telemetry. Categories reuse the existing `ScenarioCategory` taxonomy (`HappyPath, ErrorPath, EdgeCase, Regression, Performance`); failure-injection scenarios are generated but **deferred to Phase N (timing TBD)** until chaos is ready. Execution uses existing tools:


| Change type | Category | Derived scenario (plain English) | Stimulus tool |
|-------------|----------|----------------------------------|---------------|
| Retry policy | Failure | "Inject a transient 429, confirm backoff stays within `maxRetries`=3 and eventually succeeds" | chaos + DAG/API |
| Token flow | Failure | "Run a long DAG; watch for mid-run token expiry" | runDAG + trace-bundle |
| New endpoint | Happy / Edge | "Call with valid + boundary inputs; assert schema + no 5xx" | playground |
| DAG node logic | Happy | "Trigger DAG, verify node transitions and final state Completed" | runDAG + getDAGExecStatus |
| Any hot path | Performance | "Run under load; assert completion within the config/SLA bound read from code" | runDAG / playground |
| Spark client | Happy | "Create session, run trivial query, verify pool responsive" | notebook session |
| Feature flag | Edge | "Detect `FeatureNames.` refs in the diff; **flip the flag ON to exercise the new path**, then run ON and OFF and verify each behaves per its contract" | flag override + re-run |

The applicable categories are chosen by the LLM from the blast radius — a retry-policy change pulls in failure-injection scenarios; a new endpoint pulls in happy + boundary + **contract-diff**; a hot-path change pulls in performance.

**Two non-negotiable generation rules (audited):**
- **Flag-gating is a correctness gate, not an edge case.** If the diff references `FeatureNames.<X>`, the changed code path is *dormant until the flag is in the right state*. The skill **must** set it to exercise the PR's actual behavior; the wrong state silently produces a **false PASS** — the most dangerous outcome the validator can emit. The grounded four-step protocol: **(1) Detect** — grep the diff for `FeatureNames.<X>` (const name). **(2) Resolve** — const name → **wire key** → **FM `Id`** (the catalog gives `name`+`wireKey`; the FM repo's `Features/**/*.json` `Id` is what the FeatureFlighter consults, and `Id` ≠ filename ≠ const name — override the **wire key/Id**, never the const name, or it no-ops). **(3) Read effective state** — `GET /api/edog/feature-flags/catalog` resolves the FM repo (FMv2 clone) against the test env + locked-target GUIDs → `effectiveForMyWorkspace/locked/isOverridden`, telling the skill whether the path is on/off/partial/`missing` *by default*. **(4) Set + verify** — `set_override(wireKey, bool)` (force-ON *or* force-OFF), confirm the `applied` hash+revision echo, then **re-read the catalog to confirm `effectiveForMyWorkspace` actually changed** (don't trust the POST). A `locked`/`missing` flag that can't be forced is a **harness limitation**, surfaced honestly. Flag *direction* comes from the scenario (read the FLT code) — e.g. the CDF-warning scenario needs `FLTMLVWarnings` **on** but `FLTIRDeltaPhysicalCDFEnabled` **off**.
- **Contract changes are grounded by a main-vs-PR swagger diff, not by reading the diff and not by the committed baseline.** Any controller/DTO change → generate the swagger from the base-commit (main) worktree and the PR branch with **`dotnet swagger tofile`** on each built assembly (same generator both sides; main needs only a build), diff via `qa_contract_diff.diff`, and cite the `ch-NNN` entries. **The committed `Swagger/Swagger.json` is unreliable (rarely updated, drifts)** so `/api/playground/swagger/diff` (runtime-vs-committed) is not trusted. A removed or signature-changed endpoint is a **breaking-change** finding regardless of test outcome.

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

> **Audited: pin GUIDs, never names.** FLT's name-based resolution fallback can *silently resolve the wrong lakehouse* when GUIDs are absent (it logs a "backward compatibility mode" line). The locked tuple is therefore `(workspaceId, lakehouseId, capacityId)` **GUIDs**; the boundary check compares GUIDs, and any name-based-resolution log during the run is surfaced as a locked-target violation, not ignored.
>
> **Audited: the worktree config-repoint must not nuke tokens or clobber state.** Deploy is config-driven (reads `flt_repo_path` from `edog-config.json`), so the worktree flow repoints it — but saving config **via `--config` deletes `.edog-token-cache`**, forcing a mid-run MWC re-mint. The repoint therefore **edits `edog-config.json` directly** (restored by the `config_restore` ledger reverser) and never via `--config`. State files the run must preserve untouched: `edog-config.json`, `.edog-session.json`, `.edog-bearer-cache`, `.edog-token-cache`, `.edog-onelake-bearer-cache`, and the worktree's own `workload-dev-mode.json` (whose `CapacityGuid` must match the locked target).

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

**6. Failure attribution is catalog-grounded, not guessed.**
Deciding *whose fault a failure is* (the change vs the environment) is the highest-stakes inference the validator makes — so it is anchored to a deterministic source, not the model's intuition. The skill decodes every failure through `error-decoder.js` (regex → known `MLV_/FLT_/SPARK_/GTS_` code) and the 115-entry `error-sim-catalog.js` (each code tagged `errorSource` User/System · `category` · `httpStatus` · `fltCodePath`). The mapping is mechanical: `User`+validation/auth → **change-attributable**; `System`+throttling/execution/deploy → **infra / harness**. The LLM may *narrate* the failure, but the attribution tier (and thus whether it routes to §9.B-5's harness vs test bucket) is set by the catalog. Token-related faults are read off `/api/edog/health` (`bearerExpiresIn`, `tokenExpired`) and `capacity_routing_not_ready` (404) — both classified infra, never a verdict on the change.

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
- **Python primitives** (`scripts/qa_*.py`, TDD'd): `qa_run_lock`, `qa_teardown_ledger`, `qa_cleanup`, `qa_pr_diff`, `qa_head_match`, `qa_targets`, `qa_infra_spec` (required-vs-available infra diff), `qa_invariants`, `qa_verdict`, `qa_contract_diff` (main-vs-PR swagger diff), `qa_error_classify` (catalog-grounded attribution)
- **Headless server start** — the skill launches `scripts/dev-server.py` directly (it has no browser-open), so **no EDOG Studio webpage** appears; an optional `edog --no-browser` flag is a nicety. The default `python edog.py` opens the Studio webpage and is NOT used by the skill.
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
4. Root causes are *confirmed* by follow-up experiments (Phase N, fault injection — timing TBD); in Phase 1, unconfirmable causes are honestly marked "suspected".
5. Harness failures never masquerade as test failures.
6. The HTML report is good enough to paste into a design review as evidence.
7. **No orphaned state ever** — a killed/crashed run leaves zero billing capacities, zero lingering chaos rules, zero leaked flag overrides; `edog qa --cleanup` fully reverses the ledger even with the skill process gone.
8. **The agent cannot address any target outside the locked tuple**, and never deletes anything it did not create.

---

## 14. Open Questions / Phasing

Guardrails are **not** a late phase. The locked target, teardown ledger, phase allowlist, and evidence-cited verdict are **foundational** — they ship with the first thing that can mutate state or emit a claim.

- **Phase 1 (MVP):** run-lock → PR resolution (direct git/ADO) → **start server HEADLESS after PR (no Studio webpage)** → skill-native code understanding (diff + repo grep, incl. **`FeatureNames.` flag-gating detection**) → scenario generation (`reference/scenarios.md`) with infra needs, **preconditions (flag state + table props e.g. CDF=false)**, and **composite sub-scenarios / complex DAG shapes** → **scenario-aware environment** (user picks existing/new; existing fitness-check; new = skill-seeded, tailored, preconditions enforced at seed time) → **worktree** PR checkout (config-repoint via direct `edog-config.json` edit, not `--config`) → deploy + HEAD-match → **happy/edge/perf + main-vs-PR contract-diff** scenarios, **flag-ON exercise of flag-gated changes** (self-cleaning) → grounding on **API response body + logs/telemetry/onelake/http/two-swagger-diff/error-codes** (REST-citable) + **catalog-grounded failure attribution** + evidence-cited verdict (`qa_verdict.verify`) → **token-expiry guard** (`/api/edog/health bearerExpiresIn`) + **GUID-pinned locked target** → **markdown PR comment** → cleanup (auto on pass, **offer-keep on fail**) + `edog --qa-cleanup`. **No failure injection, no chaos investigation.**
- **Phase N (timing TBD — fault injection):** **failure-injection scenarios** (once chaos/error-sim matures) + auto-investigation (chaos-augmented confirmation; upgrades Phase-1 "suspected" to "confirmed") + destructive-op gating on reused-with-data.
- **Phase 3:** trace-bundle endpoint (exposes the **SignalR-primary topic-event stream over REST** with the `TopicEvent.SequenceId` + canonical cross-topic trace ID; unsampled) + verification pass over the unified bundle + full cross-signal correlation + rich HTML causal-board report (richer PR comment links to it).
- **Phase 4:** infra auto-provisioning polish + independent dead-man's-switch watchdog.

**To resolve during planning:** how the skill self-spins OmniSharp on demand (binary discovery, warm-up cost, when it's worth it vs plain code-reading); how cross-turn run state is persisted (session store vs a file EDOG owns); trace-bundle retention window and the unsampled-window cost; concurrency (single-validation lock, like `EdogQaExecutionEngine._runLock`); how the verification pass handles claims whose shape isn't mechanically checkable (semantic interpretation → forced into the inference tier); the repo `skills/` → user-global symlink install step.
