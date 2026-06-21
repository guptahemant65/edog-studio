# EDOG HTTP Tool Surface — Skill Reference

All endpoints are served by `scripts/dev-server.py` on `http://localhost:5555`. Endpoint presence is verified against dev-server.py route dispatch. Where an endpoint is declared in the spec but not found as an explicit route, it is marked **(spec-declared; verify at runtime)**.

---

## Headless Server Start

```bash
python scripts/dev-server.py
```

This does NOT open a browser. The default `python edog.py` opens the EDOG Studio webpage — the skill must NOT use it. The API is available on `:5555` as soon as the process is healthy.

---

## 1. PRIMARY STIMULUS — `POST /api/playground/dispatch`

**The default tool for all FLT API calls.** Dispatches ANY well-formed path to FLT:5557. Validation is well-formedness only (path must start with `/`; double-slash is rejected) — the entire FLT API surface is reachable, including PublicAPI and MLV controllers not in the curated catalog.

**Envelope:**
```json
{
  "tokenType": "mwc",
  "method": "GET",
  "path": "/liveTable/...",
  "headers": {},
  "body": null,
  "timeout": 30
}
```

`tokenType`: `"bearer"` or `"mwc"`, and **the path prefix MUST match the token type** (`dev-server.py`, verified at runtime):
- **`mwc`** (FLT service calls) — path must start with **`/liveTable`**, `/liveTableSchedule`, or `/liveTableMaintanance`. The path is **FLT-relative** — do NOT include `/v1/workspaces/{ws}/lakehouses/{lh}/...`; the MWC token already encodes the workspace/lakehouse routing. (Sending the full `/v1/...` path with `mwc` returns `400 invalid_path`.) So an endpoint whose swagger path is `/v1/workspaces/{ws}/lakehouses/{lh}/liveTable/listDAGExecutionIterationIds` is dispatched as just `/liveTable/listDAGExecutionIterationIds`.
- **`bearer`** (Fabric/control-plane calls) — path must start with `/v1/`, `/v1.0/`, `/metadata/`, or `/workspaces`.

**curl:**
```bash
curl -s -X POST http://localhost:5555/api/playground/dispatch \
  -H "Content-Type: application/json" \
  -d '{"tokenType":"mwc","method":"GET","path":"/liveTable/listDAGExecutionIterationIds","headers":{},"body":null,"timeout":30}'
```

**Key response fields:** the dispatch returns an envelope `{status, statusText, headers, body}` where `status` is the **inner** FLT HTTP status and `body` is the raw FLT response text. **Assert on the INNER `status`/`body`, not the dispatch HTTP 200** — a `400`/`500` from FLT still comes back inside a `200` dispatch envelope.

---

## 2. COMPLETE API DISCOVERY — `GET /api/playground/swagger/spec`

Returns the **live runtime Swagger JSON** (`/swagger/v1/swagger.json` from FLT:5557 via Swashbuckle). This is the complete endpoint list, including PublicAPI and MLV controllers that the static `/api/playground/catalog` omits.

Use this for response-schema invariant validation and for discovering endpoints not in the curated catalog.

**curl:**
```bash
curl -s http://localhost:5555/api/playground/swagger/spec | python -m json.tool | head -60
```

**Note — contract diff uses `dotnet swagger tofile`, NOT this endpoint.** The main-vs-PR contract diff generates swagger from each branch's built assembly using:
```bash
dotnet swagger tofile <built-assembly.dll> v1 --output spec.json
```
both for main (build-only, no deploy) and for the PR branch. `qa_contract_diff.diff(main_spec, pr_spec)` then yields stable `ch-NNN` change IDs. The committed `Swagger/Swagger.json` drifts and is NOT used as a baseline. `/api/playground/swagger/diff` (runtime-vs-committed) is NOT trusted for this purpose.

**Curated catalog** (`GET /api/playground/catalog`) is convenience-only, not the coverage boundary. Use it for entry-point mapping in BEAT 2; use `/swagger/spec` for completeness.

---

## 3. Health and Config

### `GET /api/edog/health`

Check bearer token status before long operations.

```bash
curl -s http://localhost:5555/api/edog/health
```

**Key fields:** `bearerExpiresIn` (seconds remaining), `tokenExpired` (bool), `mwcToken` (state). If `bearerExpiresIn` < 300 (5-minute buffer), do not start a long operation — re-auth is required.

### `GET /api/flt/config`

```bash
curl -s http://localhost:5555/api/flt/config
```

**Key fields:** `bearerToken` availability, MWC availability, `flt_repo_path` (current FLT repo pointer — this is what the worktree protocol reppoints).

---

## 4. ADO Proxy

### `GET /api/ado-proxy/pr-diff`

Fetch the PR diff and metadata. **The query param is `prUrl` (the full PR URL), NOT `prId`** (verified: `dev-server.py` reads `prUrl`; passing `prId` returns `400 "prUrl query parameter required"`).

```bash
curl -s "http://localhost:5555/api/ado-proxy/pr-diff?prUrl=https://dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable/pullrequest/985969"
```

**Key fields:** `prId`, `title`, `author`, `diff` (raw diff text), `sourceCommit` (HEAD-match anchor), `commonCommit`. **Fallback:** if the proxy is unavailable, resolve the PR with `az repos pr show --id <n> --org https://dev.azure.com/powerbi` and the diff with `git diff origin/main...<sourceCommit>` (the clean diff — never `git diff` on the deploy-patched tree).

### `POST /api/ado-proxy/pr-comment`

Posts a **real ADO thread** to the PR. Never called silently — the skill presents the markdown to the user for approval at the Beat-7 gate before posting.

```bash
curl -s -X POST http://localhost:5555/api/ado-proxy/pr-comment \
  -H "Content-Type: application/json" \
  -d '{"prUrl":"https://dev.azure.com/org/proj/_git/repo/pullRequest/1234","markdown":"## FLT PR Validator\n\nVERDICT: PASS"}'
```

**Key fields in request:** `prUrl`, `markdown`. Response confirms thread created.

---

## 5. Fabric Infrastructure

All Fabric API calls flow through the `/api/fabric/*` proxy, which translates to Fabric REST API calls with the bearer token.

### `GET /api/fabric/workspaces`

```bash
curl -s http://localhost:5555/api/fabric/workspaces
```

Lists all workspaces available to the authenticated user.

### `POST /api/fabric/workspaces/{id}/assignToCapacity`

```bash
curl -s -X POST "http://localhost:5555/api/fabric/workspaces/WS_GUID/assignToCapacity" \
  -H "Content-Type: application/json" \
  -d '{"capacityId":"CAP_GUID"}'
```

### `GET /api/fabric/workspaces/{id}/lakehouses`

```bash
curl -s "http://localhost:5555/api/fabric/workspaces/WS_GUID/lakehouses"
```

### `POST /api/fabric/workspaces/{id}/lakehouses`

Create a **schema-enabled** lakehouse. Pass the schema flag — default creation is non-schema and MLVs using `silver.<name>` require schemas. This cannot be patched after creation.

```bash
curl -s -X POST "http://localhost:5555/api/fabric/workspaces/WS_GUID/lakehouses" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"qa-lh-01","creationPayload":{"enableSchemas":true}}'
```

### `POST /api/fabric/workspaces/{id}/notebooks`

Create a notebook artifact. A Spark/Jupyter session is artifact-bound — no notebook artifact means no session.

```bash
curl -s -X POST "http://localhost:5555/api/fabric/workspaces/WS_GUID/notebooks" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"qa-seed-nb"}'
```

**Key field in response:** `id` (notebook artifact ID, used by create-session).

### `GET /api/fabric/capacities`

```bash
curl -s http://localhost:5555/api/fabric/capacities
```

Lists available capacities. Use to select a capacity for `assignToCapacity`.

---

## 6. Deploy

### `POST /api/command/deploy`

Trigger FLT deployment. Deploy is config-driven — it patches `flt_repo_path` in the config and builds/starts FLT. No `--repo-path` argument; the skill reppoints `flt_repo_path` in `edog-config.json` before calling this.

```bash
curl -s -X POST http://localhost:5555/api/command/deploy \
  -H "Content-Type: application/json" \
  -d '{}'
```

### `GET /api/command/deploy-stream` (SSE)

Poll the deploy stream for completion. This is a Server-Sent Events stream.

```bash
curl -s -N http://localhost:5555/api/command/deploy-stream
```

**Completion signal:** `event: complete` with a data payload containing `phase: "running"` and `deployMessage: "Deploy complete"`. The skill fires deploy, ends the turn, and polls this SSE on the next checkpoint.

---

## 7. DAG Execution

### `POST /api/flt-proxy/liveTableSchedule/runDAG/{iterationId}`

Trigger a DAG run. The skill generates a fresh GUID as `iterationId` for every run (`str(uuid.uuid4())`). Body is optional — no `MLVExecutionDefinitionId` is required for a catalog-registered SQL MLV.

```bash
ITER_ID=$(python -c "import uuid; print(uuid.uuid4())")
curl -s -X POST "http://localhost:5555/api/flt-proxy/liveTableSchedule/runDAG/${ITER_ID}" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### `GET /api/flt-proxy/liveTableSchedule/getDAGExecStatus/{iterationId}`

Poll for DAG status.

```bash
curl -s "http://localhost:5555/api/flt-proxy/liveTableSchedule/getDAGExecStatus/${ITER_ID}"
```

**Key fields:** `status` (`running` / `completed` / `failed` / `cancelled`), `nodes` array with per-node `state`, `warnings` (`NodeWarning` list), `refresh_policy`, `NodeExecutionMetrics`.

All `/api/flt-proxy/*` paths are proxied to FLT:5557 with bearer or MWC token as appropriate.

---

## 8. Notebook Session Trio — Table and MLV Seeding

This trio is the AUDITED infra-seeding path. Kernel is `synapse_pyspark`; the `language` field is ignored by EDOG. Cold-start polls up to 10 minutes. Cell outputs give `ok`/`error` status.

### `POST /api/notebook/create-session`

```bash
curl -s -X POST http://localhost:5555/api/notebook/create-session \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"WS_GUID","notebookId":"NB_GUID","kernel":"synapse_pyspark"}'
```

**Key field in response:** `sessionId`.

### `POST /api/notebook/execute-cell`

Execute a Python cell. Wrap SQL in `spark.sql(...)` — the cell code is Python even though it runs SQL.

```bash
curl -s -X POST http://localhost:5555/api/notebook/execute-cell \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "SESSION_ID",
    "code": "spark.sql(\"CREATE TABLE bronze.orders (id BIGINT, amount DOUBLE) USING DELTA TBLPROPERTIES (\\\"delta.enableChangeDataFeed\\\"=\\\"true\\\")\")"
  }'
```

To create a SQL-based MLV (catalog-registered, runnable via runDAG):
```bash
curl -s -X POST http://localhost:5555/api/notebook/execute-cell \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "SESSION_ID",
    "code": "spark.sql(\"CREATE MATERIALIZED LAKE VIEW silver.orders_agg AS SELECT id, SUM(amount) as total FROM bronze.orders GROUP BY id\")"
  }'
```

**Key fields in response:** `status` (`ok` or `error`), `output`.

### `POST /api/notebook/close-session`

```bash
curl -s -X POST http://localhost:5555/api/notebook/close-session \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"SESSION_ID"}'
```

Always close the session after seeding. Record each create operation to the teardown ledger before calling the create API.

---

## 9. Feature Flags

Flag state lives in the **FM repo** (FMv2, sparse-cloned to `~/.edog-cache/feature-management/`). The `Features/**/*.json` `Id` field is the real wire key. The wire key/FM `Id` is what EDOG's override API acts on — overriding by C# const name is a no-op if const name ≠ wire key.

### `GET /api/edog/feature-flags/catalog`

Resolve effective flag state against the test workspace. Use this before AND after every override.

```bash
curl -s http://localhost:5555/api/edog/feature-flags/catalog
```

**Response shape** (verified at runtime): a top-level object `{generatedAt, fltRepoPath, fm, workspace, rows[], rowCount}`. **The flags are in `rows[]` — NOT `flags[]`.** Reading `.flags` returns nothing (this bit the first live run). Check `fm.stale`/`fm.syncInProgress` first: right after a deploy the FM cache is cold and `rows` may be sparse with `stale:true` — re-poll until `fm.stale` is false (`fm.indexedCount`/`rowCount` then populate, ~35-40 flags).

**Key fields per row:** `name` (C# const name), `wireKey` (FM Id — what to override), `effectiveForMyWorkspace` (bool — the only truth that matters), `locked` (bool), `isOverridden` (bool), `overrideValue` (current forced value), `missingReason` (why a flag is `missing`), `perEnv` (per-env on/off/empty map).

> **Observed nuance (first run):** a flag can report `locked:true` yet still be force-overridden successfully (the override force-pushes to FLT:5557 and the change is observable in behavior). When in doubt, **trust the behavioral oracle** (did the gated code path actually change) over the catalog's `locked` flag — re-read after the override and, for correctness-critical scenarios, confirm via the FLT response, not just the catalog.

### `POST /api/edog/feature-flags/overrides`

Force a flag ON or OFF. Supply `X-EDOG-Control-Token` header. Use the **wire key/FM Id**, not the C# const name.

```bash
curl -s -X POST http://localhost:5555/api/edog/feature-flags/overrides \
  -H "Content-Type: application/json" \
  -H "X-EDOG-Control-Token: <token>" \
  -d '{"flag":"FLTMLVWarnings","value":true}'
```

**Success response:** echoes `applied` with `hash` and `revision`. A POST that returns success but where `effectiveForMyWorkspace` does not flip in the subsequent catalog read means the wrong key was used — silent no-op.

**CRITICAL:** always re-read `/api/edog/feature-flags/catalog` after a POST to confirm `effectiveForMyWorkspace` actually changed.

### Setting multiple flags (no bulk endpoint)

There is **no** `/overrides/bulk` route (verified against `dev-server.py` — the spec's `/overrides/bulk` reference is stale). To set several flags, call the single `POST /api/edog/feature-flags/overrides` once per flag, re-reading the catalog after each to confirm it flipped. To clear everything in one shot, use `POST /api/edog/feature-flags/overrides/reset`.

```bash
# clear ALL overrides (restore every flag to its FM-repo-resolved default)
curl -s -X POST http://localhost:5555/api/edog/feature-flags/overrides/reset \
  -H "X-EDOG-Control-Token: <token>"
```

### `DELETE /api/edog/feature-flags/overrides/{flag}`

Remove a specific override (restore to FM-repo-resolved default).

```bash
curl -s -X DELETE "http://localhost:5555/api/edog/feature-flags/overrides/FLTMLVWarnings" \
  -H "X-EDOG-Control-Token: <token>"
```

Matches `self.path.startswith("/api/edog/feature-flags/overrides/")` in dev-server.py.

---

## 10. Observation Endpoints

### `/api/logs`, `/api/telemetry`, `/api/executions`

These are **transparent proxies to the FLT log server**. Query parameters and response shapes are FLT-defined, not EDOG's. The skill **discovers the real query contract at runtime** — do NOT assume `?since=` or `?level=` are valid params. Issue a plain GET first and inspect the response to learn the available params.

```bash
# Discover the contract first
curl -s http://localhost:5555/api/logs | python -m json.tool | head -40
curl -s http://localhost:5555/api/executions | python -m json.tool | head -40
```

`/api/executions` exposes DAG run history and timing. `/api/telemetry` exposes telemetry events. `/api/logs` exposes structured log lines.

### `GET /api/edog/interceptors-status`

Current interceptor state — proxies FLT's internal interceptor health.

```bash
curl -s http://localhost:5555/api/edog/interceptors-status
```

**Key fields:** per-interceptor `connected`, `eventCount`, last event timestamp.

---

## 11. Output Verification — OneLake and MWC

### `GET /api/onelake/table-preview-rows`

Read live Delta parquet rows. Confirms a DAG wrote the correct data, not just that it ran.

**Params (verified live — all required): `wsId`, `lhId`, `schema`, `table`** (schema and table are **separate**, not a dotted `schema.table`). Optional `limit` (default 10, **max 100**). NOTE: these are **not** `workspaceId`/`lakehouseId`/`tableName`/`maxRows` — using those returns `400 missing_params`.

```bash
curl -s "http://localhost:5555/api/onelake/table-preview-rows?wsId=WS&lhId=LH&schema=silver&table=orders_agg&limit=50"
```

**Key fields:** `schemaName`, `tableName`, `columns` (`[{name,type,isPartition?}]`), `rows`, `rowsReturned`, `truncated`, `warnings`.

### `GET /api/onelake/table-metadata`

**Params (verified live — all required): `wsId`, `lhId`, `schema`, `table`** (same as above; wrong-schema or wrong-table → `404 metadata_not_found`).

```bash
curl -s "http://localhost:5555/api/onelake/table-metadata?wsId=WS&lhId=LH&schema=silver&table=orders_agg"
```

**Key fields:** `allColumns`, `partitionColumnNames`, `storage`, Delta `properties`. For MLVs: `viewText` (the SELECT) + `sourceEntities`. (The `_metadata/table.json.gz` file is read directly from OneLake DFS; in PPE it is plain JSON despite the `.gz` name. A `502` here is the shared OneLake int host — a harness condition, not a verdict.)

### `POST /api/mwc/table-details`

Batch fetch table details, grouped per schema.

```bash
curl -s -X POST http://localhost:5555/api/mwc/table-details \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"WS_GUID","lakehouseId":"LH_GUID","tables":["silver.orders_agg"]}'
```

**Key fields:** Delta log metadata, last modified timestamp, schema, properties.

---

## Endpoint Verification Summary

| Endpoint | Confirmed in dev-server.py |
|----------|---------------------------|
| `POST /api/playground/dispatch` | ✓ present |
| `GET /api/playground/swagger/spec` | ✓ present |
| `GET /api/playground/catalog` | ✓ present |
| `GET /api/edog/health` | ✓ present |
| `GET /api/flt/config` | ✓ present |
| `GET /api/ado-proxy/pr-diff` | ✓ present |
| `POST /api/ado-proxy/pr-comment` | ✓ present |
| `GET /api/fabric/capacities` | ✓ present |
| `GET/POST /api/fabric/*` (workspaces, lakehouses, notebooks) | ✓ present wildcard |
| `POST /api/command/deploy` | ✓ present |
| `GET /api/command/deploy-stream` (SSE) | ✓ present |
| `POST /api/flt-proxy/liveTableSchedule/runDAG/{id}` | ✓ present/3372/3380/3388 wildcard |
| `GET /api/flt-proxy/liveTableSchedule/getDAGExecStatus/{id}` | ✓ wildcard |
| `POST /api/notebook/create-session` | ✓ present |
| `POST /api/notebook/execute-cell` | ✓ present |
| `POST /api/notebook/close-session` | ✓ present |
| `GET /api/edog/feature-flags/catalog` | ✓ present |
| `POST /api/edog/feature-flags/overrides` | ✓ present |
| `DELETE /api/edog/feature-flags/overrides/{flag}` | ✓ present (startswith) |
| `POST /api/edog/feature-flags/overrides/reset` | ✓ present |
| `GET /api/logs` | ✓ present |
| `GET /api/telemetry` | ✓ present |
| `GET /api/executions` | ✓ present |
| `GET /api/edog/interceptors-status` | ✓ present |
| `GET /api/onelake/table-preview-rows` | ✓ present |
| `GET /api/onelake/table-metadata` | ✓ present |
| `POST /api/mwc/table-details` | ✓ present |
| `POST /api/edog/feature-flags/overrides/bulk` | DOES NOT EXIST — stale spec reference; loop the single POST or use `/overrides/reset` |
| **`GET /api/qa/trace-bundle`** | **NEW (Phase 3) — not yet built** |
