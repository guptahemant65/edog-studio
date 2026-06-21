# API Knowledge — the EDOG / FLT / OneLake surfaces (for crafting & validating scenarios)

This is the skill's map of what it can call, and **through which door**. Use it in Beat 2 (understand), Beat 3 (craft scenarios), Beat 4 (seed/inspect infra), and Beat 5 (exercise + read the data back). It is pointer-based: discover the live surface at runtime, load the deep references only when a change needs them.

**The single most important thing to internalise:** EDOG's dev-server (`scripts/dev-server.py`, on `:5555`) is a *proxy in front of three different upstreams*, each with its **own token audience**. Calling the right path through the wrong door is the #1 source of wasted round-trips (a `400 invalid_path`, a `404`, or a wrong-target read). Know the door before you knock.

---

## The three surfaces (grounded in `dev-server.py`)

| # | Surface | Door (EDOG path) | Token / audience | Real upstream | What lives here |
|---|---|---|---|---|---|
| 1 | **Fabric control-plane** | `/api/fabric/*` (handler `_proxy_fabric`); `/api/fabric/capacities` | Power BI **bearer** (`_ensure_bearer`) | `REDIRECT_HOST` (= `https://biazure-int-edog-redirect.analysis-df.windows.net`) — the EDOG **int** redirect fronting the Fabric/PBI public APIs | workspaces, lakehouses, **capacities** (upstream `/v1.0/myorg/capacities`), notebooks, items. **Infra** — used in Beat 4 to pick/seed/inspect a target. |
| 2 | **FLT workload** (the thing under test) | `POST /api/playground/dispatch` with `tokenType:"mwc"`; handler `_proxy_to_flt` | **mwc** service token (encodes ws+lh routing) | `localhost:5557` (`FLT_INTERNAL_PORT`) | insights, DAG runs, iteration listing, maintenance, CDF, triggers. **The PR changes this.** Most scenarios are dispatch calls here. |
| 3 | **OneLake / data (the receipts)** | `/api/onelake/*`, `/api/mwc/tables`, `/api/mwc/table-stats`, `/api/mwc/table-details` | OneLake **storage** bearer, aud `https://storage.azure.com` (`ONELAKE_RESOURCE`, `_ensure_onelake_bearer`) — **a different audience from surface 1's bearer** | `ONELAKE_HOST` (= `https://onelake-int-edog.dfs.pbidedicated.windows-int.net`) + MWC `/schemas/{name}/tables` | the actual stored data: list tables, **read rows back**, table metadata, row counts. **This is how you prove data is correct** (Beat 5 / `qa_mlv_convergence`). |

**Do not conflate two things that share the letters "mwc":** the **mwc *token*** (surface 2, the FLT service token used by `dispatch`) is unrelated to the **`/api/mwc/*` *endpoints*** (surface 3, EDOG's own lakehouse-data explorer that reads OneLake with a PBI bearer + a storage bearer). Different concept, same three letters.

---

## Reading the data and infra back (surface 3 — the receipts)

A scenario is not validated by an API status. For anything that writes or reads an MLV, **read the stored data back through surface 3** and compare. Exact endpoints (all `GET` unless noted), grounded:

- **List tables in the locked lakehouse** — `/api/mwc/tables?wsId={GUID}&lhId={GUID}&capId={GUID}` (`_serve_mwc_tables`). **All three params required** or it returns `400 missing_params`. Returns `{data:[{name, location, tableFormat, tableType, itemType, schemaName, …}], schemas:[…], continuationToken}` — **the table list is in `data[]`, not `tables[]`** (verified live). (This is the endpoint to use — *not* a guessed `/api/onelake/tables`, which does not exist and returns 404.)
- **Read the first N rows of a Delta table** — `/api/onelake/table-preview-rows?wsId={GUID}&lhId={GUID}&schema={schema}&table={table}&limit={N≤100}` (`_serve_onelake_table_rows`). The data-correctness oracle: read the materialized rows, compare to an independent recompute. **Params are `wsId/lhId/schema/table/limit`** — *not* `workspaceId/lakehouseId/tableName/maxRows` (those `400`).
- **Table catalog metadata** — `/api/onelake/table-metadata?wsId={GUID}&lhId={GUID}&schema={schema}&table={table}` (`_serve_onelake_table_metadata`) reads `{lh}/Tables/{schema}/{table}/_metadata/table.json.gz` from OneLake DFS (plain JSON in PPE despite the `.gz` name; a `502` is the shared int host, a harness condition).
- **Row count & size from the delta log** — `/api/mwc/table-stats`.
- **Filesystem timestamps** — `/api/onelake/item-timestamps` (`_serve_onelake_item_timestamps`) — to confirm *when* a write landed.

For the FLT-native receipts (`_mlv_system.sys_run_metrics`, `node_metrics.json`, warnings, row-count deltas), see `reference/flt-subsystems.md §7` — read those via surface 2 (the insights endpoints) or the synchronous JSON on OneLake (surface 3).

---

## Discover the COMPLETE FLT surface at runtime (do this first, Beat 2/3)

Never assume the endpoint list — read it live from the deployed FLT:

- **`GET /api/playground/swagger/spec`** — the live runtime swagger (Swashbuckle). The **complete** FLT endpoint list, including PublicAPI/MLV controllers the curated catalog omits. Each path entry carries its method, params (name, `in`, `required`), and response codes. Use it to pull a changed endpoint's full input space.
- **`GET /api/playground/catalog`** — a curated subset (from `scripts/flt_catalog.py`). Convenience for grouping by controller; **not** the coverage boundary — the swagger is.

---

## Token + path rules (the trap that costs round-trips)

A `dispatch` call fails fast if the token type and path prefix don't match (`dev-server.py` prefixes `_PLAYGROUND_BEARER_PATH_PREFIXES` / `_PLAYGROUND_MWC_PATH_PREFIXES`, verified):

- **`mwc`** (surface 2) → path must start with `/liveTable`, `/liveTableSchedule`, or `/liveTableMaintanance`, and be **FLT-relative**. Strip the `/v1/workspaces/{ws}/lakehouses/{lh}` prefix the swagger shows — the mwc token already encodes ws+lh routing. Swagger `…/liveTable/insights/cards` → dispatch `/liveTable/insights/cards`. (Sending the full `/v1/…` path with `mwc` → `400 invalid_path`.)
- **`bearer`** (surface 1) → path must start with `/v1/`, `/v1.0/`, `/metadata/`, or `/workspaces`.
- The dispatch returns an envelope `{status, statusText, headers, body}` — **assert the INNER `status`/`body`**, not the dispatch HTTP 200. A `400`/`500` from FLT still arrives inside a `200` envelope.

**Surface-3 endpoints are NOT dispatched** — call them directly on `:5555` (e.g. `curl "http://localhost:5555/api/mwc/tables?wsId=…&lhId=…&capId=…"`). They mint their own storage bearer internally.

**Environment errors on shared int hosts are harness conditions, not verdicts.** Surface 1 (the EDOG int redirect) and surface 3 (OneLake int) are shared infra; a `502 Bad Gateway` / `503` from them is the *environment*, not the PR. Surface it honestly, retry once, then move on or use a cached value — never chase it as a bug and never let it stall the run.

---

## The deep references (load on demand, by change type)

| Change touches | Read this | For |
|---|---|---|
| Fabric infra (workspace/lakehouse/capacity/notebook) | `docs/fabric-api-reference.md` (EDOG repo, ~50KB — grep the `# Fxx` section) | exact hosts, token types, request/response shapes for the surface-1 calls |
| FLT controller/endpoint internals | `scripts/flt_catalog.py` + the FLT repo `Service/.../Controllers/*.cs` | the real routes and `tokenType` |
| FLT subsystem behaviour (engine, triggers, insights, CDF, …) | `reference/flt-subsystems.md` | blast-radius index: read-first files, oracles, traps per subsystem |
| The contract the change alters | the two-spec swagger diff (`qa_contract_diff`) | additive vs breaking |

`docs/fabric-api-reference.md` is organised by EDOG feature area (`# F01` Fabric APIs, `# F02` logs, `# F03` DAG studio, `# F04` Spark inspector, `# F05` maintenance + feature flags, `# F06` IPC/command). Grep for the section your change needs; do not load it whole.

---

## From surface to scenarios (the crafting loop)

1. **Map the change to its endpoints.** From the diff (Beat 2), find every endpoint the change touches — directly (a changed controller action) and indirectly (an endpoint that calls the changed code). Pull each one's full shape from the live swagger.
2. **Pull the full input space per endpoint.** Params (required/optional), body, response codes, caps read from the code (e.g. `MaxRelatedIterationIds = 500`). Each meaningful input class — valid, boundary, missing, disallowed, the flag-on/flag-off pair — is a candidate scenario.
3. **Add the cross-cutting scenarios** the surface implies: a contract-diff for controller/DTO changes; a flag-on/off pair for flag-gated paths; a **data-correctness** check (`qa_mlv_convergence`, read back via surface 3) for anything that writes an MLV; an **execution-proof** check (`qa_execution_proof`) for any changed symbol.
4. **Pick the right door + token** per the rules above, and validate with the **full signal stack** (Beat 5) — inner response body, the data that landed (surface 3), FLT-native receipts, traces, execution proof — **never the API status alone.**
