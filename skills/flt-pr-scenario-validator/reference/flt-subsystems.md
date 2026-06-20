# FLT Subsystem Map — Just-in-Time Blast-Radius Index

This is the **second knowledge layer** (the first is `flt-model.md`, always loaded). It is **not** loaded whole. When the PR diff touches a subsystem, load **only that section**: it tells you where to read in the FLT source, what to observe, the known traps, and what a change there can break.

## How to use

1. From `qa_pr_diff`, map each changed file to a subsystem via the **Routing Table** below.
2. Open that section. **Read the listed FLT source yourself** (the changed symbols + their callers/callees) — do not reason from the diff alone.
3. Use the section's **Traps** and **A PR here can break** to drive scenario generation and to avoid false verdicts.

## Cardinal rule (learned the hard way)

**The `docs/design/*.md` files drift from the code** — wrong column counts, wrong error strings, aspirational schemes that never shipped. **Cite the C# that emits a value, never the doc.** Each section names its design doc as a *lead to verify*, not a source of truth.

> Citations are `file:line` under `Service/Microsoft.LiveTable.Service/` in `workload-fabriclivetable`. **Line numbers drift; symbols don't** — prefer the symbol, confirm the line. Lines marked ✓ were verified directly this session.

---

## Routing Table — changed path → section(s)

| Changed path (under `Service/Microsoft.LiveTable.Service/`) | Read section |
|---|---|
| `Core/V2/*`, `DataModel/Dag/{DagExecutionInstance,NodeExecutor,*Status}.cs` | §1 Engine · §3 Locking |
| `Core/RefreshTrigger/*`, `Controllers/LiveTable{SchedulerRun,Maintenance,RefreshTriggers}Controller.cs` | §2 Triggers & Scheduling · §3 Locking |
| `Catalog/*`, `CodeParser/*`, `DataModel/Dag/Node.cs` (`GetCode`), `Utils/DagUtils.cs` | §4 Catalog→DAG & node code-gen |
| `Core/CdfEnablement/*`, anything reading `RefreshPolicy`/`delta.enableChangeDataFeed` | §5 CDF / incremental correctness |
| `Core/FileIngestion/*`, `DataModel/FileIngestion/*` | §6 File ingestion |
| `DagExecutionHooks/Insights/*`, `Trends/*`, anything writing `_mlv_system` / `sys_*` | §7 Insights & metrics (the receipts) |
| `DataQuality/*`, `DqCheckResult`, `sys_dq_metrics` | §8 Data quality |
| `Throttling/*`, `RetryPolicy/*`, `SparkHttp/GTSBasedSparkClient.cs` | §9 Throttling / capacity / retry |
| `TokenManagement/*`, `Authorization/*`, `Initialization/ControllersConfig.cs` | §10 Tokens & auth |
| `DataModel/MLVExecutionDefinition.cs`, `*Persistence*`, recovery paths | §11 Execution-definition & recovery |

Cross-cutting truths that apply to **any** subsystem are in `flt-model.md` (manager-not-worker, Failed≠Skipped cascade, translated status, −1 row sentinel, the three refresh policies, only-local-MLVs-run). Don't re-derive them per section.

---

## §1 — DAG execution engine

**Owns:** turning a `runDAG` call into ordered node execution to a terminal state.

**Read first:**
- `Core/V2/DagExecutionHandlerV2.cs` — `ExecuteAsync` (entry, wrapped in `LiveTableRunCodeMarker.RunDAG` ✓:126; `iterationId = metadata.OpId` ✓:128), `ExecuteInternalAsync` (the node fan-out/fan-in loop ✓:912), `CheckDagExecCanContinueAsync` (failover/idempotency guard ✓:850), completion poll loop (✓:420-525).
- `Core/V2/NodeExecutor.cs` — `ExecuteNodeAsync` / `ExecuteNodeWithRetryAsync` (per-node submit + retry).
- `DataModel/Dag/{NodeExecutionStatus,DagExecutionStatus}.cs` ✓, `DataModel/Dag/DagExecutionInstance.cs` (`OnDagExecutionBegin/End/SkipAsync`, `OnNodeExecutionSkipAsync`).

**Oracles:** node/run status; `NodeExecutionMetrics`; the receipts (§7).

**Traps & known issues (verified in code):**
- **Cascade-skip:** a `Failed`/`Skipped` parent marks the child `Skipped` (✓:939-944). A skip is upstream collateral, not the change's fault.
- **Fire-and-forget parallelism:** nodes run on `Task.Run` (✓:987), capped by `ParallelNodeLimit` (default 5 ✓:969), coordinated by `visiting/visited/failed` concurrent collections + a per-iteration `AsyncLock` (✓:925). The engine itself flags the orchestration as not clean layer-by-layer (TODO ✓:910).
- **Admitted gaps:** non-terminal "limbo" after a failover/lock-delete race (TODO ✓:885, WI 1673947) — this is what the "every run terminates" invariant guards; run-level error code **not propagated** (TODO ✓:448) → read failures per-node; `ParallelNodeLimit` may be stored as default 5 even when set (TODO ✓:1168).
- **ReliableOperation:** retry regenerates context from the store (✓:148); don't mistake a reliable-ops retry for a flaky failure.

**A PR here can break:** node ordering (missed/extra runs), the cascade rule (wrong skip propagation), termination (new hang paths), parallelism (capacity pressure), status correctness. Concurrency/scheduling PRs → **re-run critical passes N times** (real nondeterminism here).

**Design doc:** `docs/design/{DagExecutionFlow,DagExecutionRefactoring,DevSpec_ParallelNodeLimit_Experiment}.md` (V2-only; refactoring doc is historical).

---

## §2 — Triggers & scheduling

**Owns:** the two ways a refresh starts, and the run-control API.

**Read first:**
- `Controllers/LiveTableSchedulerRunController.cs` — `RunDagAsync` (the `runDAG/{iterationId}` entry, returns **202**), `getDAGExecStatus`, `cancelDAG`.
- `Controllers/LiveTableMaintenanceController.cs` — `updateExecutionStatus` (maintenance **force-terminal** override for stuck runs).
- `Core/RefreshTrigger/RefreshTriggersHandler.cs` — trigger CRUD → Reflex/Activator provisioning.
- `DataModel/Dag/SchedulerRunStatus.cs` — `MappingForScheduler` ✓:84-97.

**Oracles:** `getDAGExecStatus` → `SchedulerRunStatus`; the receipts (§7).

**Traps & known issues (verified):**
- **Polled status is translated:** `Skipped → Cancelled`, `Cancelling → Running` (✓:94-95). A run blocked by another shows as "Cancelled." Read the raw status / receipts for attribution.
- **Schedule vs trigger:** schedule = platform JobScheduler (cron lives **outside** this repo) → `runDAG`. Trigger = event-driven via a Reflex "FMLV Refresh Activator" → notebook → `RunDAG`; gated by `FLTEnableRefreshTriggers`. Both converge on `runDAG` + the same lock (§3).
- **Trigger lost-update race:** concurrent delete/update on the same Reflex overwrite each other — no ETag/optimistic concurrency (TODO ✓ `RefreshTriggersHandler.cs:254`, WI 5054194).

**A PR here can break:** missed/double-fired refreshes, the status mapping (silently misreports to the scheduler → false alerts or missed refresh), trigger CRUD (orphaned shared Reflex entities break all triggers on the lakehouse).

**Design doc:** `docs/design/{FMLVTriggerSchedulingDesign,trigger,LiveTableSchedulerRunControllerGuide}.md` (the controller guide is ~145KB; section it).

---

## §3 — Concurrency & locking

**Owns:** ensuring one DAG runs per schedule, and serializing competing runs.

**Read first:**
- `Persistence/FileSystemBasedDagExecutionPersistenceManager.cs` — `{DagName}.lock` create/acquire/expiry (`CreateEmptyFileIfNotExistsAsync` compare-and-set).
- `Store/DagExecutionStore.cs` — `TryLockDagTypeForExecutionAsync` (lock held by another iteration → false → `Skipped`), unlock.
- `Utils/DagUtils.cs` — `GetDagName` (DagName = `mlvExecutionDefinitionId` if present, else `artifactId`), moniker construction.

**Traps & known issues (verified/reported):**
- **Second run is `Skipped`, not queued.** Two `runDAG` on the same `{DagName}` → the later one is `Skipped` (the FLT-side reason the skill's single-validation lock is correct).
- Different schedules (`mlvExecutionDefinitionId`) → different lock files → run in parallel.
- Lock self-heals via expiry (`maxDagExecutionTime + delta`).
- **Design-vs-code lie:** `ConcurrentSchedulesLockingDesign.md` says `{displayName}.lock`; code uses `{DagName}.lock`.
- Moniker omits DagName (reported `DagUtils.cs:143-149`) → possible cross-schedule serialization.

**A PR here can break:** lock keying (collapse schedules → missed refresh, or split a schedule → double-fire), the no-unlock-on-skip branch (lock leak → stuck schedule), expiry handling.

**Design doc:** `docs/design/ConcurrentSchedulesLockingDesign.md` (aspirational naming — verify).

---

## §4 — Catalog → DAG construction & node code-gen

**Owns:** building the DAG from catalog MV objects, and generating each node's executable code.

**Read first:**
- `Utils/DagUtils.cs` — `GetDagFromCatalogAsync`, `PerformTopologicalSort`.
- `Catalog/*` — listing databases (bronze/silver/gold), MVs, source entities.
- `DataModel/Dag/Node.cs` — `IsExecutable()` ✓:237-256 (only local MLV, not shortcut/external — sources are ordering scaffolding), **`GetCode()`** ✓:331-558 (the PySpark wrapper).

**Traps & known issues (verified):**
- **The PySpark wrapper is high-blast-radius.** A node's SQL is wrapped in PySpark **only** when one of these flags is on: `FLTMLVWarnings`, `FLTEnableDqChecks`, `FLTDqMetricsBatchWrite`, `FLTDqMetricsSetTableLogRetentionDays`, `FLTIRDeletesDisabled` (✓:368-379). The wrapper carries **warning capture, DQ, IR-deletes, and metrics at once** — a change to this one block (✓:374-382) can silently affect all of them. No flag → raw SQL → **warnings/DQ never captured even if real**.
- Refresh mode → conf: `RefreshMode.Full` sets the refresh-policy conf True/False (✓:552).
- `Node.IsExecutable` has a failover/deserialization edge for nodes serialized by older code (✓:243-252, WI 1789760).

**A PR here can break:** which nodes run (executability), dependency edges (wrong order/cycles), the generated SQL/PySpark (wrong data, lost warnings/DQ), `REFRESH MATERIALIZED VIEW` statement shape.

**Design doc:** `docs/design/JobGraphFlow.md` (DAG-from-MV model).

---

## §5 — CDF / incremental correctness (normal path)

**Owns:** enabling Change Data Feed so **Spark** can do incremental refresh on Delta-sourced MLVs. (FLT does not run IR itself here.)

**Read first:**
- `Core/CdfEnablement/CdfEnablementExecutor.cs` — `enableCdf` (ALTER TABLE SET `delta.enableChangeDataFeed=true` per source).
- `Common/Constants.cs` — `{Incremental,Full,No}RefreshPolicyValue` ✓:125/132/139.
- `DataModel/Dag/Node.cs` — `RefreshPolicy` (filled from Spark/GTS response ✓:211-215).

**Oracles:** per-node `refreshPolicy` (`INCREMENTALREFRESH`/`FULLREFRESH`/**`NOREFRESH`**); `CDFDisabled` warning (§7).

**Traps & known issues (verified):**
- **Spark owns the incremental decision; FLT records it.** The convergence check (materialized output == full recompute of the SELECT) is the validator's real oracle for this path.
- **`NOREFRESH` is success** (nothing changed). Never flag it.
- Source lacks CDF → Spark falls back to FULL → `CDFDisabled` warning (only visible if the warnings flag wrapped the SQL — see §4). Rows are identical; the warning is the only signal.

**A PR here can break:** correctness (incremental drifting from full — the worst, silent bug), the CDF-enable ALTER path, the refresh-policy reporting.

**Design doc:** `docs/design/CDFEnableAPISpec.md` (~50KB).

---

## §6 — File ingestion (file-sourced MLV)

**Owns:** MLVs over raw OneLake files (CSV/Parquet). Here **FLT itself** detects changes (no Delta CDF exists).

**Read first:**
- `Core/FileIngestion/*` — change-detection pipeline (list → hash-bucket → per-bucket diff → `changes.json` → manifest), `FileIngestionNodeHandler.IsFileSourcedNode` (table prop `fabric.source.sourceType = OneLake_Files`).
- `Core/V2/DagExecutionHandlerV2.cs` — `IsFileSourcedIngestionEnabled` ✓:1265, `ExecuteFileSourcedNodeAsync` ✓:1338.
- `DataModel/FileIngestion/{CheckpointStatus,DriftClassification}.cs` ✓.

**Traps & known issues (verified):**
- **`changes.json` is file-ingestion ONLY** — not the normal path. The normal path is Spark IR via CDF (§5).
- **Drift detector is the correctness guard** (✓ `DriftClassification`): `NoDrift` / `MetadataOnly` (OPTIMIZE/ZORDER/VACUUM — safe skip) / `ExtensionManaged` (reconcilable) / **`CatastrophicDrift`** (unrecognized user writes → **refresh must FAIL immediately; correctness cannot be guaranteed**).
- **Checkpoint lifecycle** (✓ `CheckpointStatus`): `ListingInProgress → DiffInProgress → DiffComplete → RefreshInProgress → Completed`/`Failed`. A distributed lock + manifest enable crash recovery (stale-checkpoint recovery).
- System-space (`System/.../_file_ingestion/`) is FLT-private; user-space (`Tables/.../_file_ingestion/`) is the FLT↔Spark contract (`changes.json` out, `summary.json` in).

**A PR here can break:** change detection (missed/duplicated files → wrong data), drift classification (treating catastrophic drift as safe → silent corruption), checkpoint recovery (stuck/orphaned ingestion).

**Design doc:** `docs/design/{FileSourcedFMLV_ComponentDesign,FileIngestion_RunDetails_API_Design,IndexFileMetadataAndEndTimeEnhancements}.md`.

---

## §7 — Insights & metrics (the receipts)

**Owns:** recording what every run did. **This is the validator's primary evidence surface.**

**Read first:**
- `DagExecutionHooks/Insights/*` — `InsightsMetricsWriteHook`, `RunMetricsTableWriter`, `NodeMetricsTableWriter` (PySpark MERGE into Delta).
- `DataModel/Dag/NodeExecutionMetrics.cs` — the per-node oracle object; row-count math `SetMetricFields` ✓:579-610, `-1` defaults ✓:49-50.
- `DataModel/Dag/NodeWarning.cs` — `WarningType` ✓:20,25.
- `SparkHttp/Model/MLVRefreshOutput.cs` — what Spark returns (parsed into the metrics).

**Oracles (cite these):**
- **Synchronous JSON on OneLake** — `node_metrics.json`, `dag_metrics.json` (DAG-critical, always written). **Prefer this.**
- **`_mlv_system` Delta tables** (best-effort ~99%): `sys_run_metrics`, `sys_node_metrics`, `sys_error_metrics` (cascade via `upstream_mlv_id`). `sys_dq_metrics` is in `dbo` (§8).
- Key fields: `status`, `refreshPolicy`, `warnings` (closed set of 2), `addedRowsCount`/`droppedRowsCount` (`-1`=not reported; `0`≠no rows), `errorCode`, `errorSource` (System/User).

**Traps & known issues (verified):**
- **Docs lie about columns** (doc says 19/22; code emits 20/25). Cite the writer/emitter, not the doc.
- `0` is a real zero; `-1`/null is "unknown." Never conflate.
- Warning is authoritative from Spark output at execution-end (`MLVRefreshOutput.Warnings`), not FLT's DAG-build guess.

**A PR here can break:** the receipts themselves (wrong/missing metrics → the validator's evidence is corrupted), the row-count math, the warning capture, schema evolution of `_mlv_system`.

**Design doc:** `docs/design/{mlv-system-schema,add-warnings-to-sys-node-metrics,DagExecMetrics_InsightsFieldEnrichment,InsightsAndTrends_API_Spec,InsightsSchemaEvolutionAndMigration}.md` (all drift — verify).

---

## §8 — Data quality

**Owns:** per-node DQ checks and their results.

**Read first:**
- `DataQuality/*` — DQ check execution + result model.
- `DataModel/Dag/NodeExecutionMetrics.cs` — `DqCheckResults`, `TotalViolations`, `ViolationsPerConstraint`.

**Traps & known issues (verified/reported):**
- `sys_dq_metrics` lives in **`dbo`**, not `_mlv_system`; written by a separate hook.
- **Violations ≠ dropped rows** — distinct fields. Don't equate.
- DQ is gated by `FLTEnableDqChecks` and rides the PySpark wrapper (§4).
- Error code surfaces as e.g. `MLV_COLUMN_DQ_CHECK_FAILED` (`errorSource = User` — change-attributable).

**A PR here can break:** DQ check correctness (false pass/fail on data), violation counting, where results land.

**Design doc:** `docs/design/{DataQualityReport,dq-checks-in-dag-execution,dq-checks-low-level-design}.md` (camelCase/enum drift — verify).

---

## §9 — Throttling / capacity / retry

**Owns:** keeping FLT and the capacity stable under load. **All signals here are INFRA, never a verdict on the change.**

**Read first:**
- `SparkHttp/GTSBasedSparkClient.cs` — GTS submit + status mapping: **HTTP 430 → `MLV_SPARK_JOB_CAPACITY_THROTTLING`** (Retriable) ✓:497-503; **429 → `MLV_TOO_MANY_REQUESTS`** ✓:488.
- `RetryPolicy/V2/Strategies/CapacityRetryStrategy.cs` — admission window `20/40/60/90/90/90s`, then extended `60/90s` until DAG timeout if any node still running, else fail-fast.
- `Throttling/Services/HierarchicalThrottlingService.cs` — token-bucket inbound throttling; **fail-open** (any exception → request allowed).

**Traps & known issues (verified):**
- **No `404 capacity_routing_not_ready` exists in FLT** (grep = 0). The capacity signal is **430**.
- Throttling is fail-open → a 429 almost never *causes* a refresh failure; it's client pacing.
- Doc says throttle code `FLT_TOO_MANY_REQUESTS`; code default is `MLV_TOO_MANY_REQUESTS` — match both strings if scanning logs.
- Extended retry is **430-only** — a 430 run can legitimately take a long time before succeeding or failing.

**A PR here can break:** the retry strategy (premature fail or runaway retry), throttle limits, the fail-open guarantee (a throttle bug that fails *closed* would block real refreshes).

**Design doc:** `docs/design/{ThrottlingDesign,CAPACITY_RETRY_SPEC,DevSpec_ParallelNodeLimit_Experiment}.md`.

---

## §10 — Tokens & auth

**Owns:** the MWC/bearer tokens a refresh needs, and (in EDOG) the disabled auth surface.

**Read first:**
- `TokenManagement/*` — `TokenManager.GetTokenAsync` (waits for scheduler-poll refresh, then throws — does **not** mint on demand), `DagExecutionTokenProvider`.
- `Authorization/{MwcV2RequirePermissionsFilter,RequiresPermissionFilter}.cs`, `Initialization/ControllersConfig.cs` — the auth surface.

**Traps & known issues (verified/grounded):**
- **EDOG disables auth wholesale** (`DisableFLTAuth` → `GetNoAuthenticationAuthenticator()`; permission filters short-circuit). So a runtime auth test is a **manufactured false PASS — forbidden.** Auth-relevant diffs are **detect-and-flag for human review only**.
- `GetTokenAsync` waiting-then-throwing means token absence is a **precondition failure (infra)**, not a change verdict.
- Bearer ~1h (5-min buffer, auto-refresh only if a session is saved); MWC ~15-min buffer.

**A PR here can break:** (validatable) token lifetime/refresh timing on long DAGs → observe the token-vs-write timing gap (Phase 1: SUSPECTED only). (Not validatable) authorization posture → static-flag.

**Design doc:** `docs/design/{TokenFlow,FLTServiceAuthFlow}.md`.

---

## §11 — Execution-definition & recovery

**Owns:** named execution profiles and crash recovery.

**Read first:**
- `DataModel/MLVExecutionDefinition.cs` — the entity (`SelectedMLVs`, `ExecutionMode` {CurrentLakehouse, FullLineage, SelectedOnly}, `DagSettings`, `DqScheduleSettings`).
- The persistence/handler for `MLVExecutionDefinition` (CRUD + `EffectiveSettings`), and `{id}-recovery.json` tombstone.

**Traps & known issues (reported):**
- **Optional for `runDAG`.** Absent → global lakehouse run (lock = `artifactId`). Present → isolated named schedule (own `{mlvDefinitionId}.lock` + index folder) → enables concurrent schedules.
- Recovery uses persisted store state + tombstones; a reliable-ops retry regenerates context (§1).

**A PR here can break:** which MLVs a schedule runs (selection/lineage mode), per-schedule settings, recovery of orphaned runs.

**Design doc:** `docs/design/{MLVExecutionDefinition_API_Spec,Recovery-MLVExecutionDefinition}.md`.
