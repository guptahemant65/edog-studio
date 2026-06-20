# Scenario Generation Protocol

This document is the authoritative protocol for generating scenarios. Every scenario the skill produces must follow this protocol. Generation is repeatable, not improvised — the change-type drives the pattern catalog, the pattern drives the eight fields, and the eight fields drive execution.

---

## 1. Change-Type → Scenario-Pattern Catalog

| Change touches | Scenarios generated | Infra needed |
|---|---|---|
| API controller / endpoint | Happy (valid input → 2xx + schema valid + assert response body); Edge (null / boundary / missing params → graceful 4xx); Contract-diff (diff main-vs-PR swagger via `dotnet swagger tofile` → assert each `ch-NNN` change is intended; removed/modified endpoints = breaking) | lakehouse; maybe 1 table |
| DAG node / scheduling logic | Trigger DAG → verify node transitions → final `completed` state; assert `NodeExecutionMetrics` and `node.warnings` | MLV with a multi-node DAG over ≥1 source table |
| Retry / resilience policy | P1: observe the changed path under normal stimulus (retry interceptor + timing); P2 (Phase N, fault injection): inject fault → confirm backoff ≤ `maxRetries`, eventual success | depends on the changed path |
| Token / auth flow | Long-running DAG → observe token lifetime across the write via `token` interceptor timing; Phase 1 marks gap as SUSPECTED if it cannot confirm expiry | a longer-running MLV DAG |
| Spark client / session | create-session → trivial query → close-session → check pool health | lakehouse + notebook artifact |
| Cache / DI / file-system | Exercise via the nearest entry point that reaches the changed code; observe via the relevant interceptor | varies |
| Feature flag | Detect `FeatureNames.<X>` in diff; resolve wire key; run the scenario with flag ON and flag OFF; verify each behaves per its contract | depends on what the flag gates |
| Any hot path | Performance: run under realistic load; assert completion within the SLA bound read from the FLT code. No invented thresholds — if no bound is declared in code, timing is reported as observation only | multi-node DAG or repeated API calls |

Applicable categories are chosen from the blast radius: a retry-policy change pulls in failure-injection scenarios (deferred Phase N); a new endpoint pulls in happy + boundary + contract-diff; a hot-path change pulls in performance.

**The count is derived, never chosen.** `scripts/qa_scenario_plan.derive(features)` turns the parsed change into the scenario skeleton: each change-feature maps to a risk-dimension (a **category**, m) and to the input classes it makes meaningful (the **cases**, n). So m and n are a *function of the diff* — a one-line default flip yields `m=1, n=1`; a docs-only PR yields `m=0` (honestly no scenarios); a multi-feature PR yields more. The agent grounds each derived stub (the exact stimulus, the cited checks, the honest caveat); it never invents the count or pads to a template. The derivation guarantees completeness — loosening an allow-set automatically emits the `Input still rejected` guard and the `Limits` (cap+1) case; a controller/DTO change automatically emits the `API contract` diff — so coverage classes can never be silently dropped.

| Change-feature (from `qa_pr_diff` + the Beat-2 read) | Emits category | Cases (input classes) |
|---|---|---|
| `param_enum_added` (a value added to an accepted set) | `Newly accepted input` + `Input still rejected` + `Limits` (if a cap) | newly-allowed (per value) · differential (it really filters) · multi-value (if a list) · negative (a still-disallowed value) · message (lists the new set) · boundary-over (cap+1) |
| `default_changed` | `Default behaviour` | the no-arg result equals the new default and differs from the alternative |
| `dto_breaking` (a field removed/renamed/retyped) | `API contract` | before-vs-after swagger diff · runtime-shape (if a cap on the new field) |
| `flag` (a `FeatureNames.<X>` ref) | `Feature flag` | ON vs OFF (one per flag) |
| `mlv_write` | `Data correctness` | stored output equals a fresh recompute (read back via the OneLake surface) |
| `auth_posture` | `Security — needs a human` | detect-only finding, never tested |
| `no_surface` (a changed symbol with no observable surface) | `Did the changed code run` | report not-provably-exercised |

Identical behaviour across sibling endpoints (e.g. the same `statuses` param on `summary`/`runs`/`trends`/`errors`) collapses to **one representative case** that names the others as covered by the same binding — so n reflects distinct risk, not endpoint count.

**Failure-injection scenarios** (chaos, fault injection) are generated but **deferred to Phase N** — not executed in Phase 1.

---

## 2. The Eight Scenario Fields

Every generated scenario declares exactly these eight fields:

| Field | What it contains |
|---|---|
| `title` | Short descriptive label, plain English |
| `category` | `HappyPath` · `ErrorPath` · `EdgeCase` · `Regression` · `Performance` |
| `stimulus` | The tool call(s) that exercise the change: endpoint, method, body |
| `observations` | What to read after the stimulus: which endpoints, which fields, what to correlate |
| `invariants` | The always-true properties to assert (see §5) |
| `infra_requirements` | `qa_infra_spec` payload: N lakehouses, table names + properties, M MLVs, DAG shape (not just counts), flag states |
| `preconditions` | Setup enforced BEFORE stimulus: required flag state + table/MLV properties. Enforced at seed time, not patched after |
| `sub_scenarios` | Optional: child scenarios sharing this scenario's infra but each with their own stimulus/observations |

---

## 3. Worked Examples by Pattern

### 3.1 API Endpoint Change — Happy + Edge + Contract-Diff

**Change:** New controller action `GET /api/liveTable/insights/summary`.

```yaml
title: "GET /insights/summary — happy path"
category: HappyPath
stimulus:
  tool: POST /api/playground/dispatch
  body:
    tokenType: bearer
    method: GET
    path: /api/liveTable/insights/summary
    headers: {}
    body: null
    timeout: 30
observations:
  - Assert HTTP 200
  - Assert response body validates against /api/playground/swagger/spec schema for this path
  - Assert body fields computable from inputs (e.g. echoed workspaceId, status enum set unconditionally by controller)
  - Check /api/logs for no ERROR lines during the window
invariants:
  - No 5xx response
  - Response validates against OpenAPI schema
  - No secrets in logs
  - No new ERROR/FATAL log lines
infra_requirements:
  lakehouses: 1
  tables:
    - name: bronze.orders
      properties: {}
  mlvs: []
  dag_nodes: []
preconditions:
  flags: {}
  table_properties: {}
sub_scenarios:
  - title: "GET /insights/summary — missing required param → 400"
    category: EdgeCase
    stimulus:
      tool: POST /api/playground/dispatch
      body:
        tokenType: bearer
        method: GET
        path: /api/liveTable/insights/summary
        headers: {}
        body: null
        timeout: 30
    observations:
      - Assert HTTP 400 (graceful rejection, not 500)
      - Assert error body is schema-valid
    invariants:
      - No 5xx
      - No unhandled exceptions in logs
```

**Contract-diff scenario** (run once per PR touching a controller or DTO):

```bash
# On the PR branch worktree (already built by BEAT 5):
dotnet swagger tofile path/to/FLT.dll v1 --output pr-spec.json

# On the main base-commit worktree (build only, no deploy):
dotnet swagger tofile path/to/main-FLT.dll v1 --output main-spec.json

# Diff:
python -c "import qa_contract_diff; qa_contract_diff.diff('main-spec.json', 'pr-spec.json')"
```

Each `ch-NNN` entry must be traced to an intended change. Removed or signature-changed endpoints are **breaking-change findings** regardless of test outcome. Requires `Swashbuckle.AspNetCore.Cli` installed and a loadable assembly.

The committed `Swagger/Swagger.json` is NOT used — it drifts. `/api/playground/swagger/diff` (runtime-vs-committed) is NOT trusted.

---

### 3.2 DAG Node / Scheduling Change

**Change:** Modified `DagExecutionHandlerV2` node-transition logic.

```yaml
title: "DAG run — node transitions and final Completed"
category: HappyPath
stimulus:
  tool: POST /api/flt-proxy/liveTableSchedule/runDAG/{iterationId}
  note: "iterationId = str(uuid.uuid4()) generated by the skill"
  body: {}
observations:
  - Poll getDAGExecStatus/{iterationId} until terminal state
  - Assert final status == "completed"
  - Assert each node in the DAG reached "Completed" state (not "Failed" or stuck "Running")
  - Read NodeExecutionMetrics: added/dropped row counts, status, error_code
  - Read node.warnings for NodeWarning values
  - Read refresh_policy per node (INCREMENTALREFRESH / FULLREFRESH / NOREFRESH; NOREFRESH = nothing changed = success)
  - Verify output via GET /api/onelake/table-preview-rows — confirm data landed
  - Read /api/executions (discover real query params at runtime) for timing
invariants:
  - Every DAG run that starts terminates (no hang)
  - No interceptor exceptions
  - No 5xx responses
  - MLV refresh convergence: run the MLV's defining SELECT in a fresh notebook session; assert output == materialized rows (schema + row count + values for deterministic views over quiesced sources)
infra_requirements:
  lakehouses: 1
  tables:
    - name: bronze.orders
      properties:
        delta.enableChangeDataFeed: "true"
  mlvs:
    - name: silver.orders_agg
      sql: "SELECT id, SUM(amount) AS total FROM bronze.orders GROUP BY id"
  dag_nodes:
    - silver.orders_agg
preconditions:
  flags: {}
  table_properties:
    bronze.orders:
      delta.enableChangeDataFeed: "true"
sub_scenarios: []
```

---

### 3.3 Feature Flag — CDFDisabled Warning (Verified FLT Example)

This is the grounded reference example verified against FLT. A CDF change leaves output rows identical — only `node.warnings` shows it.

**Preconditions (all three required):**

1. `FLTMLVWarnings` = ON — without this flag, warnings are never parsed from GTS output; `Node.cs` only wraps the PySpark SQL for warning extraction when this flag is on.  
2. `FLTIRDeltaPhysicalCDFEnabled` = OFF — physical CDF would synthesize CDF and suppress the source-CDF-missing warning.  
3. Source table seeded at creation time with `delta.enableChangeDataFeed=false` — cannot be patched after creation.

With all three: MLV refresh detects source lacks CDF → falls back to full refresh → emits `NodeWarning{CDFDisabled, relatedSourceEntities:[ws.lh.schema.tbl]}`.

```yaml
title: "CDFDisabled warning fires when source table lacks CDF"
category: EdgeCase
stimulus:
  tool: POST /api/flt-proxy/liveTableSchedule/runDAG/{iterationId}
  body: {}
observations:
  - Assert node.warnings contains NodeWarning with type "CDFDisabled"
  - Assert relatedSourceEntities includes the source table
  - Assert refresh_policy == "FULLREFRESH" (fell back from incremental; not INCREMENTALREFRESH)
  - Check sys_node_metrics.warnings for the warning record
  - NOTE: output rows are IDENTICAL with or without CDF — do NOT assert row content as the oracle here
invariants:
  - No 5xx responses
  - DAG terminates
  - No interceptor exceptions
infra_requirements:
  lakehouses: 1
  tables:
    - name: bronze.orders
      properties:
        delta.enableChangeDataFeed: "false" # MUST be false — set at seed time
  mlvs:
    - name: silver.orders_agg
      sql: "SELECT id, SUM(amount) AS total FROM bronze.orders GROUP BY id"
  dag_nodes:
    - silver.orders_agg
preconditions:
  flags:
    FLTMLVWarnings:
      wire_key: "<resolve from /api/edog/feature-flags/catalog>"
      required_state: true
    FLTIRDeltaPhysicalCDFEnabled:
      wire_key: "<resolve from catalog>"
      required_state: false
  table_properties:
    bronze.orders:
      delta.enableChangeDataFeed: "false"
sub_scenarios:
  - title: "CDFDisabled — with FLTIRDeltaPhysicalCDFEnabled=ON (physical CDF suppresses warning)"
    category: EdgeCase
    preconditions:
      flags:
        FLTMLVWarnings: {required_state: true}
        FLTIRDeltaPhysicalCDFEnabled: {required_state: true}
      table_properties:
        bronze.orders:
          delta.enableChangeDataFeed: "false"
    observations:
      - Assert node.warnings does NOT contain CDFDisabled (physical CDF synthesizes it)
      - Assert refresh_policy may be Incremental (physical CDF path taken)
```

---

### 3.4 Spark Client / Session

```yaml
title: "Notebook session — create, trivial query, close"
category: HappyPath
stimulus:
  sequence:
    - POST /api/notebook/create-session {workspaceId, notebookId, kernel: synapse_pyspark}
    - POST /api/notebook/execute-cell {sessionId, code: "spark.sql('SELECT 1 AS alive').show()"}
    - POST /api/notebook/close-session {sessionId}
observations:
  - create-session: assert sessionId returned, no error
  - execute-cell: assert status == "ok", output contains "alive"
  - close-session: assert success
  - Check /api/edog/interceptors-status for spark interceptor — assert session events recorded
invariants:
  - No 5xx
  - Session closes without hang
infra_requirements:
  lakehouses: 1
  notebook_artifact: required
preconditions:
  flags: {}
sub_scenarios: []
```

---

## 4. AUDITED Infra-Seeding Recipe

Seed in this exact order. Record each create to the teardown ledger **before** issuing the create call.

```
1. GET /api/fabric/capacities
   → select capacity ID

2. POST /api/fabric/workspaces
   → ledger.record("workspace", id=WS_ID)
   → workspaceId = WS_ID

3. POST /api/fabric/workspaces/{WS_ID}/assignToCapacity
   body: {"capacityId": "CAP_ID"}

4. POST /api/fabric/workspaces/{WS_ID}/lakehouses
   body: {"displayName":"qa-lh-01","creationPayload":{"enableSchemas":true}}
   ↑ SCHEMA FLAG IS REQUIRED — default is non-schema; MLVs with silver.<name> need schemas
   → ledger.record("lakehouse", id=LH_ID)
   → lakehouseId = LH_ID

5. POST /api/fabric/workspaces/{WS_ID}/notebooks
   body: {"displayName":"qa-seed-nb"}
   → ledger.record("notebook", id=NB_ID)
   → notebookId = NB_ID

6. POST /api/notebook/create-session
   body: {"workspaceId":WS_ID,"notebookId":NB_ID,"kernel":"synapse_pyspark"}
   ↑ language field is ignored
   → sessionId = SESSION_ID
   Cold-start: poll until ready, up to 10 minutes

7. POST /api/notebook/execute-cell (seed tables with required properties)
   code: |
     spark.sql("""
       CREATE TABLE bronze.orders (
         id BIGINT,
         amount DOUBLE
       ) USING DELTA
       TBLPROPERTIES ('delta.enableChangeDataFeed'='true')
     """)

8. POST /api/notebook/execute-cell (create SQL MLV)
   code: |
     spark.sql("""
       CREATE MATERIALIZED LAKE VIEW silver.orders_agg
       AS SELECT id, SUM(amount) AS total FROM bronze.orders GROUP BY id
     """)
   ↑ SQL MLV is catalog-registered and runnable via runDAG.
     No separate MLVExecutionDefinitionId required. FLT-owner verified.

9. POST /api/notebook/close-session
   body: {"sessionId": SESSION_ID}

10. ledger.record("session_closed")
```

Each `execute-cell` response has `status: "ok"` or `status: "error"`. Treat `"error"` as a blocking seed failure — do not proceed.

---

## 5. runDAG Protocol

```python
import uuid, requests

iteration_id = str(uuid.uuid4()) # fresh GUID for this run

# Trigger
requests.post(
    f"http://localhost:5555/api/flt-proxy/liveTableSchedule/runDAG/{iteration_id}",
    json={}
)

# Poll until terminal
import time
while True:
    r = requests.get(
        f"http://localhost:5555/api/flt-proxy/liveTableSchedule/getDAGExecStatus/{iteration_id}"
    ).json()
    if r["status"] in ("completed", "failed", "cancelled"):
        break
    time.sleep(5)
```

Body is optional. `iterationId` is the OpId that flows through every interceptor event for this run.

---

## 6. Output Verification and FLT-Native Oracles

Three layers of verification, in order:

### Layer A — API Response Body

Assert the stimulus call's response body itself. Not a guessed exact body — check:
- HTTP status code in expected range
- Response validates against OpenAPI schema (`GET /api/playground/swagger/spec`)
- Values computable from code and inputs: echoed IDs, unconditionally-set status enums, counts derivable from seeded data

Never hallucinate an expected payload. Schema + computable invariants = grounded assertion.

### Layer B — FLT-Native Structured Outputs (the real semantic oracles)

Read from the `getDAGExecStatus` response, the synchronous OneLake JSON (`node_metrics.json` / `dag_metrics.json` — the DAG-critical source of truth, always written), and the `_mlv_system` insights tables (best-effort ~99%). **Cite the JSON or the metrics object, not the design docs — they drift from the code.**

| Oracle | Location | What it tells you (code-verified) |
|---|---|---|
| `warnings` | per-node metrics · `sys_node_metrics.warnings` | A **closed set of exactly two** (`NodeWarning.cs`): `CDFDisabled` (a source lacks CDF → node fell back to full) and `DeleteWithoutHints` (delete ran without pruning hints). On node metadata, **never on output rows**. Authoritative value comes from Spark at execution-end, and is only captured when the SQL is PySpark-wrapped (`FLTMLVWarnings` etc., `Node.cs`) — **no flag → no captured warning even if the condition is real**. |
| `refreshPolicy` | per-node | One of `INCREMENTALREFRESH` / `FULLREFRESH` / `NOREFRESH` (`Constants.cs/132/139`). **`NOREFRESH` = nothing changed = success — never flag it.** Distinct from the run-level `RefreshMode` (`Optimal`/`Full`, the upfront request). |
| `addedRowsCount` / `droppedRowsCount` | per-node | `long`; **`-1` = "not reported"** (default, → SQL `null`). **`0` ≠ "no rows" — `0` is a real zero.** `added = processed − dropped`. Drops ≠ violations. |
| `status` + `errorCode` + `errorSource` | per-node | `errorSource` is `System` or `User` (the catalog-grounded attribution); `errorCode` e.g. `MLV_COLUMN_DQ_CHECK_FAILED`. |
| `sys_run_metrics` / `sys_node_metrics` / `sys_error_metrics` | `_mlv_system` (Spark query) | Run/node aggregates; `sys_error_metrics.upstream_mlv_id` gives the failure cascade chain. `sys_dq_metrics` lives in `dbo`, not `_mlv_system`. |

**Two traps that will fool a naive read (code-verified):**
- **`Failed` ≠ `Skipped`.** A failed node marks everything downstream `Skipped` (`DagExecutionHandlerV2.cs`). A `Skipped` node is normally upstream collateral — trace it to the failed ancestor (`upstream_mlv_id`); never blame the change for a skip.
- **The polled status is translated.** `getDAGExecStatus` maps `Skipped → Cancelled` and `Cancelling → Running` (`SchedulerRunStatus.cs`). A run blocked by another run shows as "Cancelled." Read the raw status / receipts when attribution matters.

### Layer C — OneLake Rows (data landed)

```bash
curl -s "http://localhost:5555/api/onelake/table-preview-rows?workspaceId=WS&lakehouseId=LH&tableName=silver.orders_agg&maxRows=100"
```

**MLV convergence oracle:** run the MLV's defining SELECT in a fresh notebook Spark session and assert the materialized output equals the full-refresh result. Catches IR/CDF drift. Incremental and full refresh must converge.

Degrade to schema + row count + `NodeExecutionMetrics` checks when:
- View SQL is non-deterministic (`current_timestamp`, `rand`, `ORDER BY ... LIMIT`)
- Data sources are live (not skill-quiesced)

---

## 7. Observation Discovery

`/api/logs`, `/api/telemetry`, and `/api/executions` are **transparent proxies to the FLT log server**. Their query interface is FLT-defined. The skill discovers the real contract at runtime:

```bash
# Step 1: discover available params and response shape
curl -s http://localhost:5555/api/logs
curl -s http://localhost:5555/api/executions

# Step 2: use the observed params — e.g. if the response includes a cursor:
curl -s "http://localhost:5555/api/logs?since=<cursor>&iterationId=<id>"
```

Do NOT assume `?since=` or `?level=` are valid params — inspect first.

---

## 8. Flag-Gating Rule (Correctness Gate)

Flag-gated changes are DORMANT until the flag is in the right state. Running a flag-gated scenario without flipping the flag produces a **false PASS** — the most dangerous outcome.

**Four-step protocol:**

```
1. DETECT
   Grep the diff for FeatureNames.<X> (C# const name).

2. RESOLVE
   GET /api/edog/feature-flags/catalog
   Find the entry for const name <X>.
   Read wireKey (= FM Id = what to override).
   Read effectiveForMyWorkspace (current default state).

   CRITICAL: wireKey/FM Id ≠ filename ≠ const name in many cases.
   Override the wireKey, never the const name — wrong key = silent no-op.

3. SET + VERIFY
   POST /api/edog/feature-flags/overrides
   Header: X-EDOG-Control-Token: <token>
   Body: {"flag": "<wireKey>", "value": true} // or false for force-OFF

   Success response echoes: {"applied": {"hash": "...", "revision": N}}

   Then: GET /api/edog/feature-flags/catalog again.
   Assert effectiveForMyWorkspace flipped.
   If it did not flip: wrong key was used — investigate.

4. RUN
   Execute the scenario in the required flag state (read FLT code to determine direction).
   Run ON and OFF for flag-gated scenarios.
   Clean up: DELETE /api/edog/feature-flags/overrides/<wireKey>
   Re-read catalog to confirm override removed.
```

`locked` or `missing` flags cannot be forced. Surface as harness limitation, not a verdict on the change.

---

## 9. Contract-Diff Scenario

For any PR touching a controller or DTO:

```bash
# PR branch (already built at BEAT 5):
dotnet swagger tofile .edog-qa/worktrees/<runId>/path/to/FLT.dll v1 \
  --output .edog-qa/runs/<runId>/pr-spec.json

# Main base-commit worktree (build only, no deploy):
dotnet swagger tofile .edog-qa/worktrees/main/path/to/FLT.dll v1 \
  --output .edog-qa/runs/<runId>/main-spec.json

# Diff:
python -c "
import qa_contract_diff
result = qa_contract_diff.diff('.edog-qa/runs/<runId>/main-spec.json',
                               '.edog-qa/runs/<runId>/pr-spec.json')
print(result)
"
```

Each `ch-NNN` entry must be traced to an intended change in the diff. Rules:
- Added endpoint (additive) → non-breaking
- Removed endpoint → **breaking change finding** regardless of scenario outcome
- Signature-changed endpoint (param removed/renamed, response schema narrowed) → **breaking change finding**

Requires `Swashbuckle.AspNetCore.Cli` tool installed and a loadable assembly. Both sides use the same generator — no formatting noise between them.

---

## 10. Failure Attribution

Decode every failure through `qa_error_classify` before attributing:

```python
# error-decoder.js: regex-scans logs for MLV_/FLT_/SPARK_/GTS_ codes → O(1) lookup
# error-sim-catalog.js: 115 codes tagged errorSource (User/System), category, httpStatus, fltCodePath

# Classification:
# User + validation/auth → change-attributable
# System + throttling/execution/deploy → infra / harness

# Token-related attribution:
# Read GET /api/edog/health: bearerExpiresIn, tokenExpired
# Capacity saturation: HTTP 430 -> MLV_SPARK_JOB_CAPACITY_THROTTLING (Retriable) -> infra, never a change verdict.
# There is NO "404 capacity_routing_not_ready" in FLT. FLT auto-retries 430 (~6min admission window, then extended).
# Inbound/GTS throttle: HTTP 429 -> MLV_TOO_MANY_REQUESTS; throttling is fail-open, so a 429 rarely causes a refresh failure.
```

Never attribute a failure by LLM guess. Attribution tier is set mechanically by the catalog.

**Retry-once on infra-shaped failures:** a transient 429 (`MLV_TOO_MANY_REQUESTS`) or 430 (`MLV_SPARK_JOB_CAPACITY_THROTTLING`) is environment noise. Retry the scenario once; only a reproducible failure counts.

---

## 11. Preconditions and Composite Scenarios

A scenario's `preconditions` are enforced **before** stimulus, every time the scenario runs:

```python
# Before stimulus:
# 1. Set required flag overrides (POST /api/edog/feature-flags/overrides)
# 2. Verify effectiveForMyWorkspace flipped (GET catalog)
# 3. Confirm table properties are as required (GET table-metadata)
# — properties that require seed-time creation (like CDF=false) cannot be patched here;
# — they must have been set in the seeding step
```

`qa_infra_spec` carries:
- `table_properties` — required Delta table properties at seed time
- `flags` — required flag states (resolved wire keys + required bool)
- `dag_nodes` — DAG shape (list of node names in dependency order)

`sub_scenarios` share one seeded infra (possibly a multi-node DAG) but each have their own `stimulus` and `observations`. Seed once; exercise many times. A single complex DAG seeded to exercise all paths is valid infra for a family of sub-scenarios.

---

## 12. Non-Negotiable Generation Rules

1. **Flag-gating is a correctness gate, not an edge case.** If the diff references `FeatureNames.<X>`, the changed path is dormant without the flag. Not flipping it = false PASS. Run both ON and OFF.

2. **Contract changes are grounded by `dotnet swagger tofile`, not by reading the diff and not by the committed baseline.** Any controller/DTO change generates the contract-diff scenario.

3. **Authorization changes are DETECTED and flagged, never validated.** EDOG disables auth wholesale (`DisableFLTAuth`). A no-token request always succeeds in EDOG. The skill detects auth-relevant diffs — controller base class changes (`PublicUnprotectedController`, `PublicAadProtectedController`, `BaseApiController`), added/removed `[MwcV2RequirePermissionsFilter]`, authenticator wiring edits in `ControllersConfig.cs` — and emits a security-sensitive finding routed to human/security review. It never runs an auth scenario and reports PASS.

4. **Execution proof, not declaration.** A changed symbol counts as TESTED only if its enclosing `CodeMarker` (`CurrentCodeMarkerName`) or an interceptor surface (http/dag/retry/token/spark) or a named log line appears in the trace during the run. A change with no marker/interceptor/log surface is reported as "not provably exercised" — never fabricate a scenario to look thorough.

5. **Absence claims require complete evidence.** "No error occurred" is only provable if the observation window is complete. In Phase 1 (before the trace-bundle endpoint is available), absence claims over `/api/logs` degrade to "not observed (coverage may be incomplete)" unless the log stream is demonstrably unsampled for the window.
