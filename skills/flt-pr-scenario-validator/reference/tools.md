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
  "tokenType": "bearer",
  "method": "GET",
  "path": "/api/liveTable/...",
  "headers": {},
  "body": null,
  "timeout": 30
}
```

`tokenType`: `"bearer"` or `"mwc"`. The correct type for each FLT path is constrained by EDOG path-prefix rules (bearer paths vs MWC paths are distinct prefix groups in dev-server.py:692-698).

**curl:**
```bash
curl -s -X POST http://localhost:5555/api/playground/dispatch \
  -H "Content-Type: application/json" \
  -d '{"tokenType":"bearer","method":"GET","path":"/api/liveTable/status","headers":{},"body":null,"timeout":30}'
```

**Key response fields:** the raw FLT response body (proxied), HTTP status code.

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

Fetch the PR diff and metadata. Accepts query params to identify the PR.

```bash
curl -s "http://localhost:5555/api/ado-proxy/pr-diff?prId=1234"
```

**Key fields:** `prId`, `title`, `author`, `diff` (raw diff text), `sourceCommit` (HEAD-match anchor), `commonCommit`.

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

**Key fields per flag:** `name` (C# const name), `wireKey` (FM Id — what to override), `effectiveForMyWorkspace` (bool — the only truth that matters), `locked` (can't be overridden), `isOverridden` (bool), `overrideValue` (current forced value).

`locked`/`missing` flags cannot be forced — this is a harness limitation, not a verdict on the change.

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

```bash
curl -s "http://localhost:5555/api/onelake/table-preview-rows?workspaceId=WS&lakehouseId=LH&tableName=silver.orders_agg&maxRows=50"
```

**Key fields:** `rows` (array of row objects), `schema`.

### `GET /api/onelake/table-metadata`

```bash
curl -s "http://localhost:5555/api/onelake/table-metadata?workspaceId=WS&lakehouseId=LH&tableName=silver.orders_agg"
```

**Key fields:** column schema, table properties (e.g. `delta.enableChangeDataFeed`), row count.

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
| `POST /api/playground/dispatch` | ✓ line 3458 |
| `GET /api/playground/swagger/spec` | ✓ line 3346 |
| `GET /api/playground/catalog` | ✓ line 3340 |
| `GET /api/edog/health` | ✓ line 3270 |
| `GET /api/flt/config` | ✓ line 3262 |
| `GET /api/ado-proxy/pr-diff` | ✓ line 3338 |
| `POST /api/ado-proxy/pr-comment` | ✓ line 3462 |
| `GET /api/fabric/capacities` | ✓ line 3264 |
| `GET/POST /api/fabric/*` (workspaces, lakehouses, notebooks) | ✓ line 3266 wildcard |
| `POST /api/command/deploy` | ✓ line 3442 |
| `GET /api/command/deploy-stream` (SSE) | ✓ line 3315 |
| `POST /api/flt-proxy/liveTableSchedule/runDAG/{id}` | ✓ line 3324/3372/3380/3388 wildcard |
| `GET /api/flt-proxy/liveTableSchedule/getDAGExecStatus/{id}` | ✓ wildcard |
| `POST /api/notebook/create-session` | ✓ line 3436 |
| `POST /api/notebook/execute-cell` | ✓ line 3438 |
| `POST /api/notebook/close-session` | ✓ line 3440 |
| `GET /api/edog/feature-flags/catalog` | ✓ line 3286 |
| `POST /api/edog/feature-flags/overrides` | ✓ line 3420 |
| `DELETE /api/edog/feature-flags/overrides/{flag}` | ✓ line 3394 (startswith) |
| `POST /api/edog/feature-flags/overrides/reset` | ✓ line 3422 |
| `GET /api/logs` | ✓ line 3318 |
| `GET /api/telemetry` | ✓ line 3319 |
| `GET /api/executions` | ✓ line 3321 |
| `GET /api/edog/interceptors-status` | ✓ line 3284 |
| `GET /api/onelake/table-preview-rows` | ✓ line 3301 |
| `GET /api/onelake/table-metadata` | ✓ line 3299 |
| `POST /api/mwc/table-details` | ✓ line 3428 |
| `POST /api/edog/feature-flags/overrides/bulk` | DOES NOT EXIST — stale spec reference; loop the single POST or use `/overrides/reset` |
| **`GET /api/qa/trace-bundle`** | **NEW (Phase 3) — not yet built** |
