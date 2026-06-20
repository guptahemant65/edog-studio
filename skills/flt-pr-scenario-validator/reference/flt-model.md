# FLT Mental Model — Always-Loaded Reference

Grounded in the FLT source (`workload-fabriclivetable`), not the design docs. The design docs under `docs/design/` are spec-stage drafts and **drift from the code** (wrong column counts, wrong error-code strings, aspirational lock schemes). Rule: **cite the C# that emits a value, never the doc.** Citations below are `file:line` in `Service/Microsoft.LiveTable.Service/`.

---

## 1. What FLT is — the manager, not the worker

FLT does **not** compute data. It builds an execution plan and tells **Spark (via GTS, the Generic Transform Service)** to do the actual refresh work. FLT orchestrates, observes, and records.

- A **Materialized Lake View (MLV)** is a saved query whose result is stored as a real Delta table and kept up to date. That stored result is the product.
- The plan is a **DAG**: each node is one table in the lineage; **only local MLVs actually run** — source tables and shortcuts are non-executable scaffolding that exist only for dependency ordering (`Node.IsExecutable()` → MLV && local && not shortcut, `Node.cs 520`).
- Nodes run in dependency order (topological sort, `DagUtils.PerformTopologicalSort`), bronze → silver → gold.

**The core promise:** the stored MLV output must equal what you'd get by recomputing its defining query from scratch — across the incremental path. The validator's correctness check (recompute-and-compare) protects exactly this.

---

## 2. Two ways a refresh starts (both converge on `runDAG`)

- **Schedule-based:** the Fabric platform JobScheduler (cron/interval lives in the platform, not this repo) POSTs `liveTableSchedule/runDAG/{iterationId}` → returns **202 Accepted** and runs in the background (`LiveTableSchedulerRunController.cs`).
- **Trigger-based:** event-driven via a Reflex/Activator ("FMLV Refresh Activator"); on a configured event it fires a notebook that calls `RunDAG`. Gated by flag `FLTEnableRefreshTriggers` (`LiveTableRefreshTriggersController.cs`).

Both serialize on a per-schedule lock file `{DagName}.lock` (`DagName` = `mlvExecutionDefinitionId` if present, else `artifactId`). **If the lock is held by another run, the second run is `Skipped` — not queued, not failed** (`DagExecutionStore.cs`). Different schedules use different lock files and can run in parallel.

---

## 3. Two ways the data refreshes incrementally

- **Normal MLV (source is Delta tables):** FLT does NOT detect changes. **Spark does incremental refresh itself, using the Delta Change Data Feed (CDF).** FLT only triggers it. CDF is just a table property (`delta.enableChangeDataFeed=true`) on the sources; FLT has an `enableCdf` API to turn it on. If a source lacks CDF, Spark cannot go incremental → falls back to FULL → emits the `CDFDisabled` warning.
- **File-sourced MLV (source is raw CSV/Parquet files in OneLake):** no Delta change feed exists, so **FLT itself** detects changed files and writes `changes.json` for Spark (`REFRESH MLV WITH CHANGES`). `changes.json` is **file-ingestion only** — not the normal path. A drift detector (NoDrift / MetadataOnly / ExtensionManaged / CatastrophicDrift) guards correctness if the Delta table was changed outside FLT.

The per-node **refresh policy** is the post-hoc truth Spark reports back: one of `INCREMENTALREFRESH` / `FULLREFRESH` / `NOREFRESH` (`Constants.cs/132/139`; populated from the GTS response, `Node.cs`). `NOREFRESH` means nothing changed → **a success, not a failure.** Do not flag it. This per-node policy is different from the run-level `RefreshMode` (`Optimal` / `Full`), which is the upfront request (`DagSettings.cs`).

---

## 4. The state machines (exact, verified)

- **Node** (`NodeExecutionStatus`): `None, Running, Completed, Failed, Cancelled, Skipped, Cancelling`.
- **Run** (`DagExecutionStatus`): `NotStarted, Running, Completed, Failed, Cancelled, NotFound, Skipped, Cancelling`. (Byte enum, **duplicated in workload-lakehouse** — order must match; reordering it is a silent cross-repo break, `DagExecutionStatus.cs`.)

Two things that will fool a naive check:

1. **Failed ≠ Skipped.** When a node fails, the engine marks every node **downstream of it `Skipped`** (`DagExecutionHandlerV2.cs`). A `Skipped` node is normally **upstream collateral, not a bug in that node.** Never blame the change for a skip; trace it to the failed ancestor (the `sys_error_metrics` cascade does this via `upstream_mlv_id`).
2. **The polled status is translated.** `getDAGExecStatus` returns a scheduler-facing status that **maps `Skipped → Cancelled` and `Cancelling → Running`** (`SchedulerRunStatus.cs`). So a run blocked by another run shows as **"Cancelled."** Read the raw internal status (or the receipts) when attribution matters.

The engine also admits it can land in a **non-terminal "limbo"** after a failover/lock-delete race (`DagExecutionHandlerV2.cs`, WI 1673947) — this is exactly what the "every run must terminate" invariant guards. And it **does not propagate a clean run-level error code** (`:448`) — so read failures **per-node**, not from a single run code.

---

## 5. The receipts (where to read what happened)

On reaching a terminal state, FLT writes (in order):

1. **JSON to OneLake, synchronously** — `dag_metrics.json`, `node_metrics.json`. This is the **DAG-critical source of truth** (always written). **Prefer citing this.**
2. **Delta system tables** (best-effort ~99%, fire-and-forget hook). Schema `_mlv_system`:
   - `sys_run_metrics` — 1 row/run: `status`, `refresh_mode` (Full/Optimal), `error_code/source`, `total/succeeded/failed/skipped_nodes`.
   - `sys_node_metrics` — 1 row/MLV/run: `node_id`, `status`, `added_rows_count`, `dropped_rows_count`, `session_id`, `warnings`, `mlv_name`.
   - `sys_error_metrics` — 1 row/error: `upstream_mlv_id` (the cascade chain), `error_category` System/User.
   - `sys_dq_metrics` lives in the **`dbo`** schema (not `_mlv_system`), written by a different hook.

### The real oracle fields (per node — `NodeExecutionMetrics`)

- **`status`** — Completed / Failed / Skipped / Cancelled (see §4).
- **`refreshPolicy`** — which path ran (INCREMENTAL/FULL/NOREFRESH).
- **`warnings`** — a **closed set of exactly two** (`NodeWarning.cs`): `CDFDisabled` (a source lacks CDF → fell back to full) and `DeleteWithoutHints` (a delete ran without pruning hints → slow scan). Warnings appear on **node metadata, never on the output rows.** The authoritative warning comes from **Spark's output at execution-end** (`MLVRefreshOutput.Warnings`), not FLT's upfront guess. Warnings are only captured when the node's SQL is PySpark-wrapped, which happens only when one of these flags is on: `FLTMLVWarnings`, `FLTEnableDqChecks`, `FLTDqMetricsBatchWrite`, `FLTDqMetricsSetTableLogRetentionDays`, `FLTIRDeletesDisabled` (`Node.cs`). **No flag → no captured warning, even if the condition is real.**
- **`addedRowsCount` / `droppedRowsCount`** — `long`, **default `-1` = "not reported"** (`NodeExecutionMetrics.cs`), written as SQL `null`. **`0` ≠ "no rows" — `0` is a real zero, `-1`/null is "unknown."** `added = totalRowsProcessed − totalRowsDropped` when both parse (`:607-608`). Drops ≠ violations (distinct fields).
- **`errorCode`** (e.g. `MLV_COLUMN_DQ_CHECK_FAILED`) and **`errorSource`** — `System` or `User`, computed from `NodeErrorDetails.FailureType`. This is the catalog-grounded attribution; not a guess.

### Verify the data landed
`/api/onelake/table-preview-rows` + `table-metadata` read the live Delta parquet — confirm a DAG wrote the **right rows**, then run the recompute-and-compare correctness check.

---

## 6. Infra signals = NOT a verdict on the change

These come from the environment, never the PR. Classify them as harness/infra:

- **HTTP 430 → `MLV_SPARK_JOB_CAPACITY_THROTTLING`** (Retriable) — Fabric capacity can't admit the Spark job (`GTSBasedSparkClient.cs`). This is the real capacity signal. (There is **no** `404 capacity_routing_not_ready` in FLT — that string does not exist.) FLT auto-retries: admission window `20/40/60/90/90/90s`, then extended `60/90s` until DAG timeout if any node is still running, else fail-fast (`CapacityRetryStrategy.cs`).
- **HTTP 429 → `MLV_TOO_MANY_REQUESTS`** — inbound API throttling (token bucket, 200/min per API per artifact, 250/min per user) OR GTS session throttling (`HierarchicalThrottlingService.cs`, `GTSBasedSparkClient.cs`). Throttling is **fail-open** (any error → request allowed), so a 429 is client-pacing, almost never the cause of a failed refresh.
- **Parallel node limit** — default 5, range 2-25, flights 10/15/20 (`ParametersManifest.json`). Bounds how many nodes run at once. (Engine TODO `:1168` notes a bug: it can be stored as the default 5 even when set otherwise.)

---

## 7. Identity, tokens, ports, deploy

- **Iteration ID** = the run's GUID, supplied by the caller, used as the reliable-op `OpId` and the single correlation key (`DagExecutionHandlerV2.cs`). The skill generates a fresh GUID per run.
- **Execution proof anchor:** `ExecuteAsync` runs inside the `LiveTableRunCodeMarker.RunDAG` code marker (`:126`) — the EDOG log interceptor surfaces it as `CurrentCodeMarkerName`, so the skill can prove RunDAG actually fired.
- **DAG execution is a ReliableOperation** — it can be retried/failed-over and resumes from persisted store state (`:148`). Don't mistake a reliable-ops retry for a flaky failure.
- **Tokens:** bearer (~1h, 5-min refresh buffer — check `GET /api/edog/health → bearerExpiresIn`; auto-refreshes only if a username/session is saved); MWC (~15-min buffer). `tokenManager.GetTokenAsync` waits for the scheduler poll to refresh and then throws — it does not mint on demand, so token absence is a precondition failure, not a change verdict.
- **Ports:** `5555` EDOG dev-server (the skill calls only this); `5557` FLT (EDOG proxies it). **Headless start:** launch `scripts/dev-server.py` directly (no browser); never `python edog.py` (opens the Studio webpage).
- **Deploy** is config-driven: it patches `flt_repo_path` in `edog-config.json` in place (no checkout). Worktree flow: create worktree at PR commit → repoint `flt_repo_path` (ledger `config_restore`) → `POST /api/command/deploy` + SSE `deploy-stream` to `event: complete` phase `running` (~4 min) → restore → remove worktree on cleanup.

---

## 8. The 11 interceptors (evidence source)

EDOG instruments the FLT process with 11 interceptor streams: `log, telemetry, http, retry, dag, token, spark, fileop, cache, catalog, flt-ops`. They capture **status, duration, errors, counts** — **not** method return values. Cite captured fields only; "the method returned X" is never supportable. Phase 1 reads them over REST (`/api/logs`, `/api/telemetry`, `/api/executions`, `/api/edog/interceptors-status`); the full stable-ID topic-event stream is a Phase-3 trace-bundle.
