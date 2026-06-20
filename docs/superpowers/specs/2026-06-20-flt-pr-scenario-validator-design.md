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
| **Assertions** | Pattern-match engine guessing oracles | Skill correlates raw signals into a verdict |
| **Where it runs** | In the FLT process | Copilot CLI, driving EDOG over HTTP |

### Why a skill, why now

1. **Opus 4.8 is the brain.** Vastly stronger reasoning than the in-product GPT-class model F27 caged. No schema gymnastics needed to keep it safe.
2. **Scenarios in plain language.** No typed stimulus contracts. The skill expresses intent ("inject a transient 429, confirm backoff fires and eventually succeeds") and executes it through tools.
3. **Cross-signal correlation** — the killer capability. A skill can ingest logs + telemetry + all 11 interceptor streams + DAG state *at once* and write the causal narrative no rule engine ever could.

---

## 2. Core Thesis: Correlation Over Oracles

Every testing tool needs an **oracle** — someone who knows what "correct" is and encodes it as an assertion. F27 made the LLM the oracle (read the code, guess "retry fires 3 times," write a matcher). That is irreducibly non-deterministic. You cannot make a guessing machine deterministic by adding schema.

EDOG's superpower is that it **sits inside the FLT process and witnesses the complete internal causal chain** — every SQL query, retry with backoff, DI resolution, token mint, file write, DAG node transition, telemetry event. 11 interceptors, real time. No external tool (Postman, Playwright, integration tests) can see this.

That changes what's possible. When you can observe *everything*, you replace the oracle with two stronger primitives:

### Primitive A — Differential behavioral fingerprinting (deterministic)

Don't assert what the code *should* do. Capture what it *actually does* — completely — and diff it across versions.

```
1. Skill reads the diff → identifies blast radius (changed code paths)
2. Deploys BASE (pre-change) → exercises blast radius → captures full fingerprint
3. Deploys HEAD (the change) → exercises the SAME paths → captures fingerprint
4. Diffs the two fingerprints
```

Verdict logic is mechanical — **no LLM judgment of "correct":**

| Code path | Behavior changed? | Verdict |
|-----------|-------------------|---------|
| **Unchanged** by PR | Yes | 🔴 Regression — broke something elsewhere |
| **Unchanged** by PR | No | ✅ Safe |
| **Changed** by PR | Yes | 🟡 Expected — here's the delta, confirm intent |
| **Changed** by PR | No | ⚠️ Suspicious — changed code, identical behavior (dead/untested path) |

### Primitive B — Opus 4.8 correlation (the diagnosis)

The deterministic diff says *what* changed. Opus 4.8 says *why it matters*, by correlating across all signal streams:

> *"Your change moved the token mint earlier in the pipeline. `EdogTokenInterceptor` shows a 15-min MWC token minted at T+2.3s. The Spark write phase didn't reach `OneLakeWriter` until T+14.1s. `EdogRetryInterceptor` then shows three 401 retries; telemetry confirms `EndpointNotFound`; the log says 'token rejected.' This is a token-lifetime regression — long-running DAGs will now fail their final write."*

The LLM's job is narrowed to what it's genuinely good at: **selecting stimuli** (code reasoning) and **narrating correlated signals** (diagnosis). Neither requires guessing absolute truth.

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
│   MEMORY:  EdogQaRunStore (fingerprint baselines)         │
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
| Provision infra | `/api/fabric/workspaces`, `/workspaces/{id}/assignToCapacity`, `/workspaces/{id}/lakehouses`, `/notebooks` | Exists |
| Deploy FLT | `POST /api/command/deploy` + SSE `/api/command/deploy-stream` until `phase:running` | Exists |
| Trigger DAG | `POST /api/flt-proxy/liveTableSchedule/runDAG/{iterationId}` + poll `getDAGExecStatus/{id}` | Exists |
| Run API | `/api/flt-proxy/*`, `/api/fabric/*` (Playground surface) | Exists |
| Spark cell | `/api/notebook/create-session` → `execute-cell` → `close-session` | Exists |
| Flip feature flag | `POST /api/edog/feature-flags/overrides`, `DELETE .../overrides/{flag}` | Exists |
| Inject fault | F24 chaos `ErrorSimAddRule` / `ErrorSimRemoveRule` | Exists |
| Observe (raw) | `/api/logs`, `/api/telemetry`, `/api/edog/interceptors-status`, error decode | Exists |
| Endpoint catalog | `GET /api/playground/catalog` | Exists |
| Flag catalog | `GET /api/edog/feature-flags/catalog` | Exists |
| Read PR diff | `GET /api/ado-proxy/pr-diff` or local `git diff` | Exists |
| Fingerprint baselines | `EdogQaRunStore` compare-by-hash | Exists |

### The one new piece of product work

**`GET /api/qa/trace-bundle?since={T0}&correlationId={id}`** — a unified observation endpoint returning logs + telemetry + all 11 interceptor streams + DAG state in **one correlated snapshot**, every event carrying a **stable ID** and **unsampled** for the run window.

It is load-bearing for two reasons: (1) correlation is a single call returning a time-ordered, correlation-ID-joined event stream instead of stitching 5+ endpoints; (2) it is the **citable evidence ledger** — every assertion in the verdict cites a stable event ID that exists in the bundle (see §9.B). Unsampled coverage is what makes absence claims ("no error occurred") provable. **This is the highest-leverage thing to build** — everything else the skill composes from existing APIs.

---

## 5. Knowledge Strategy

The skill does not preload 400K lines of FLT or every doc. Two layers, mirroring EDOG's own Context Loading Protocol:

- **Always-loaded mental model** (~2 pages baked into the skill): what a DAG / iteration-ID / MWC token / capacity routing is; the deploy lifecycle; the 11-interceptor catalog; the FLT port/proxy topology.
- **Just-in-time retrieval**: PR touches `TokenManager.cs` → the skill greps the FLT repo and reads only the relevant docs on demand (`hivemind/DEBUGGING.md`, `docs/reference/runDAG-lifecycle.md`, the relevant ADRs).

---

## 6. End-to-End Flow (the agentic loop)

Phase-gated per the UX decisions: the skill **confirms at every phase boundary**, runs in the **background** with **checkpoint updates**, and **auto-investigates** anomalies.

```
PHASE 0 — ORIENT
  • Auto-detect target: open PR on this branch → validate PR;
    else uncommitted/local changes → validate local diff
  • Read diff, map blast radius (grep FLT repo + JIT docs)
  • Derive candidate scenarios in plain English
  ┌─ GATE: present editable plan ─────────────────────────┐
  │ "I'll run these 6 scenarios: [plain-language list].   │
  │  Affected: token flow, retry policy. Proceed?"        │
  │ User can: approve / drop #3 / add a null-capacity test│
  └───────────────────────────────────────────────────────┘

PHASE 1 — ENVIRONMENT
  • Reuse existing lakehouse/capacity if present & healthy,
    else provision fresh via wizard APIs
  ┌─ GATE: "Spin up F2 capacity (~$X/hr) + lakehouse? ~3min"┐
  └───────────────────────────────────────────────────────┘

PHASE 2 — BASELINE (compute on demand)
  • Deploy BASE commit → exercise blast radius → capture
    fingerprint via trace-bundle
  ┌─ GATE: "Deploy base branch for diff baseline? ~4min"  ─┐
  └───────────────────────────────────────────────────────┘

PHASE 3 — CANDIDATE
  • Deploy HEAD → run the curated scenarios → capture fingerprints
  ┌─ GATE: "Deploy your change and run scenarios? ~6min"  ─┐
  └───────────────────────────────────────────────────────┘

PHASE 4 — CORRELATE & INVESTIGATE
  • Diff HEAD vs BASE fingerprints
  • Run invariant suite (deterministic ground truth)
  • Opus correlates logs+telemetry+traces per scenario
  • AUTO-INVESTIGATE: on a suspicious signal, design and run
    a follow-up experiment (inject the fault, flip the flag,
    re-run) to CONFIRM root cause before reporting
  ┌─ GATE: "Found a suspected retry regression — run a    ─┐
  │  confirming chaos experiment? ~2min"                   │
  └───────────────────────────────────────────────────────┘

PHASE 5 — REPORT
  • Terminal: concise behavioral-diff verdict
  • HTML report auto-opens (correlated causal timeline)
  • PR comment auto-posted to ADO
```

Background execution means each gate posts a checkpoint and waits; the user can step away and return to confirm.

---

## 7. Scenario Model

No schema, ever. Scenarios are **plain-language intents the skill derives from the diff** and executes through tools:

| Change type | Derived scenario (plain English) | Stimulus tool |
|-------------|----------------------------------|---------------|
| Retry policy | "Inject a transient 429, confirm backoff fires N times and eventually succeeds" | chaos + DAG/API |
| Token flow | "Run a long DAG; watch for mid-run token expiry" | runDAG + trace-bundle |
| New endpoint | "Call with valid + boundary inputs; assert schema + no 5xx" | playground |
| DAG node logic | "Trigger DAG, verify node transitions and final state" | runDAG + getDAGExecStatus |
| Spark client | "Create session, run trivial query, verify pool responsive" | notebook session |
| Feature flag | "Run with flag ON and OFF, diff the behavior" | flag override + re-run |

---

## 8. Verdict Model

**Behavioral-diff-centric** — not a bare PASS/FAIL. Leads with *what changed and whether it was intended*:

```
FLT PR Scenario Validator — 3 behaviors changed vs baseline

  🟡 INTENDED (2)
    • New endpoint /insights/summary returns 200 with valid schema
    • Retry backoff now caps at 30s (matches your stated change)

  🔴 REGRESSION (1)
    • Retry count rose 3→5 on the UNCHANGED OneLakeWriter path
      Root cause (confirmed via chaos re-run): your timeout change
      in HttpClientFactory lowered the per-attempt deadline, so the
      same transient now triggers 2 extra retries.
      Evidence: [trace timeline link]

  Confidence: high (root cause confirmed by follow-up experiment)
```

Ground truth (deterministic): differential diff + invariant suite. Diagnosis (Opus): the correlated narrative. A confidence signal rides alongside, raised when a follow-up experiment confirmed the cause.

### Invariant suite (always-true properties, deterministic)
- No 5xx responses
- Every response validates against its OpenAPI schema
- No secrets (token/bearer patterns) in logs
- Every DAG run that starts terminates (no hangs)
- No new ERROR/FATAL log lines vs baseline
- No interceptor exceptions
- Latency within Nx of baseline

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

**5. Phase action allowlist.**
The per-phase confirmation gate is not just "proceed Y/N" — each phase declares the **exact set of mutating operations it is permitted**. PHASE 2 (baseline) may deploy + trigger + observe; it **cannot** create infra or post to a PR. An out-of-phase action is refused at the tool boundary, not by asking the model nicely.

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
| Invocation | Auto-detect (PR if on PR branch, else local changes) |
| Confirmation | Confirm at every phase boundary |
| Run rhythm | Background + checkpoint updates |
| Investigation | Auto-investigate & confirm root cause |
| Curation | Editable plan before run (conversational) |
| Verdict | Behavioral-diff-centric |
| Harness vs test failure | Clearly separated |
| Output | Terminal + HTML (auto-open) + PR comment (auto-post) |
| Safety | Fully autonomous, gated at phase boundaries |
| Baseline | Compute on demand |
| Location | User-global (`~/.copilot/skills/`) |

---

## 11. HTML Report

Dark, Palantir aesthetic (per EDOG design bible). The **hero is the correlated causal timeline** — a single time-axis showing all signal streams (logs, telemetry, interceptor events, DAG transitions) aligned, with the regression highlighted and its causal chain traced. Sections:

1. **Verdict banner** — behavioral-diff summary (intended vs regression counts)
2. **Causal timeline** (hero) — multi-stream, correlation-ID-joined, regression path highlighted
3. **Scenario cards** — each with stimulus, observed behavior, base-vs-head diff
4. **Evidence** — raw trace bundles, expandable
5. **Environment provenance** — capacity, commit SHAs, deploy timing

---

## 12. Migration from F27

### Reused
- `EdogQaStimulusDispatcher` — optional, for advanced stimuli (DI invocation, SignalR broadcast)
- `flt_catalog.py` + `/api/playground/catalog` — endpoint knowledge
- `EdogQaRunStore` — fingerprint baseline library (compare-by-hash)
- ADO proxy, deploy pipeline, infra wizard APIs, chaos engine, flag override — all as tools
- The 11 interceptors — the fingerprint source

### Retired
- `EdogQaScenarioOrchestrator`, `EdogQaLlmClient`, `EdogQaAssertionEngine` (the caged-LLM pipeline)
- The typed stimulus/matcher contract schemas (P10) — replaced by plain-language intent
- Curation stage UI, analysis UI, scenario editor — replaced by conversational curation
- `qa-panel.js` and all frontend QA modules — replaced by the skill + HTML report

### New
- The skill itself (`~/.copilot/skills/flt-pr-scenario-validator/`)
- `GET /api/qa/trace-bundle` unified observation endpoint (stable IDs, unsampled) — correlation source + citable evidence ledger
- Invariant suite (deterministic property checks)
- Differential fingerprint diff engine (or extend `EdogQaRunStore.Compare`)
- **Teardown ledger** + `edog qa --cleanup` standalone reverser (EDOG-owned, survives skill death)
- **Locked-target enforcement** + created-vs-reused gating at the tool boundary
- **Verification pass** — deterministic checker that confirms every cited assertion against the trace bundle
- Independent dead-man's-switch watchdog (budget + silence teardown)

---

## 13. Success Criteria

1. Engineer says "validate my change" → gets a confirmed, plain-language verdict end-to-end.
2. Zero hallucinated assertions — every claim cites a verified trace-bundle event; the verification pass rejects or downgrades anything it can't confirm.
3. Catches a real blast-radius regression an engineer would have missed (the OneLakeWriter-three-layers-away case).
4. Root causes are *confirmed* by follow-up experiments, not guessed.
5. Harness failures never masquerade as test failures.
6. The HTML report is good enough to paste into a design review as evidence.
7. **No orphaned state ever** — a killed/crashed run leaves zero billing capacities, zero lingering chaos rules, zero leaked flag overrides; `edog qa --cleanup` fully reverses the ledger even with the skill process gone.
8. **The agent cannot address any target outside the locked tuple**, and never deletes anything it did not create.

---

## 14. Open Questions / Phasing

Guardrails are **not** a late phase. The locked target, teardown ledger, phase allowlist, and evidence-cited verdict are **foundational** — they ship with the first thing that can mutate state or emit a claim.

- **Phase 1 (MVP):** skill skeleton + auto-detect + locked-target selection + teardown ledger + `edog qa --cleanup` + deploy + invariant suite + **evidence-cited** terminal verdict. No differential, no chaos.
- **Phase 2:** trace-bundle endpoint (stable IDs, unsampled) + verification pass + correlation + HTML report.
- **Phase 3:** differential fingerprinting (base vs head).
- **Phase 4:** auto-investigation (chaos-augmented follow-up experiments) + destructive-op gating on reused-with-data.
- **Phase 5:** PR auto-post + infra auto-provisioning + independent dead-man's-switch watchdog.

**To resolve during planning:** exact fingerprint canonicalization (what's signal vs noise in a trace — timestamps, GUIDs, and ordering must be normalized before diffing); trace-bundle retention window and the unsampled-window cost; concurrency (one validation run at a time, like `EdogQaExecutionEngine._runLock`); how the verification pass handles claims whose shape isn't mechanically checkable (semantic interpretation → forced into the inference tier).
