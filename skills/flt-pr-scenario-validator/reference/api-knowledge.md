# API Knowledge — FLT + Fabric Surface (for crafting & validating scenarios)

This is the skill's map of what it can call. Use it in Beat 2 (understand) and Beat 3 (craft scenarios) so scenarios are **complete** — covering the real endpoints a change affects — not just the one path in the diff. It is pointer-based: discover the live surface at runtime, and load the deep references only when a change needs them.

There are **two API surfaces**, with different token types and path rules (see `tools.md` §1 for the dispatch prefix rules):

| Surface | Token | What it is | Where it's used |
|---|---|---|---|
| **FLT service** (`:5557`) | `mwc` | The materialized-view engine: DAG runs, iteration listing, maintenance, insights, CDF, triggers. Paths are FLT-relative (`/liveTable`, `/liveTableSchedule`, `/liveTableMaintanance`). | The thing under test — most scenarios |
| **Fabric control-plane** | `bearer` | Workspaces, lakehouses, capacities, notebooks, OneLake. Paths `/v1/…`, `/workspaces…`. | Seeding/inspecting infra (Beat 4) |

---

## 1. Discover the COMPLETE FLT surface at runtime (do this first)

Never assume the endpoint list — read it live from the deployed FLT:

- **`GET /api/playground/swagger/spec`** — the live runtime swagger (Swashbuckle). This is the **complete** FLT endpoint list, including PublicAPI/MLV controllers the curated catalog omits. Each path entry has its method, parameters (name, `in`, `required`), and responses. This is how Beat 5 found `/v1/workspaces/{ws}/lakehouses/{lh}/liveTable/listDAGExecutionIterationIds` and confirmed a new param was additive.
- **`GET /api/playground/catalog`** — a curated subset of FLT endpoints (from `scripts/flt_catalog.py`, which scans the FLT C# controllers). Convenience for grouping by controller; **not** the coverage boundary — the swagger spec is.

**Scenario-crafting use:** for a changed controller/endpoint, pull its full operation from the swagger (all params, all response codes), and craft scenarios that exercise each meaningful input class — valid, boundary, missing, and the flag-on/flag-off paths — not just the happy path the diff shows.

---

## 2. The deep references (load on demand, by change type)

| Change touches | Read this | For |
|---|---|---|
| Fabric infra (workspace/lakehouse/capacity/notebook/OneLake) | `docs/fabric-api-reference.md` (EDOG repo, ~50KB — grep the relevant `# Fxx` section) | exact hosts, token types, request/response shapes for the control-plane calls used to seed and inspect infra |
| FLT controller/endpoint internals | `scripts/flt_catalog.py` + the FLT repo's `Service/.../Controllers/*.cs` | how the curated catalog is built; the real controller routes and `tokenType` |
| FLT subsystem behavior (engine, triggers, insights, CDF, file ingestion, …) | `reference/flt-subsystems.md` | the blast-radius index — read-first files, oracles, traps per subsystem |
| The contract the change alters | the two-spec swagger diff (`qa_contract_diff`) | additive vs breaking |

`docs/fabric-api-reference.md` is organized by EDOG feature area (`# F01` Fabric APIs, `# F02` logs, `# F03` DAG studio, `# F04` Spark inspector, `# F05` maintenance + feature flags, `# F06` IPC/command). Grep for the section your change needs; do not load it whole.

---

## 3. Token-type rule (the trap that cost a round-trip)

A call fails fast if the token type and path prefix don't match (`dev-server.py:330-335`):
- **`mwc`** → path must start with `/liveTable`, `/liveTableSchedule`, `/liveTableMaintanance`, and be **FLT-relative** (NOT the full `/v1/workspaces/{ws}/lakehouses/{lh}/…` swagger path — the MWC token already encodes the routing). The swagger path `…/liveTable/listDAGExecutionIterationIds` is dispatched as just `/liveTable/listDAGExecutionIterationIds`.
- **`bearer`** → path must start with `/v1/`, `/v1.0/`, `/metadata/`, `/workspaces`.

When you read an endpoint from the swagger, strip the `/v1/workspaces/{ws}/lakehouses/{lh}` prefix and dispatch the FLT-relative remainder with `mwc`.

---

## 4. From surface to scenarios (the crafting loop)

1. **Map the change to its endpoints.** From the diff (Beat 2), find every endpoint the change touches — directly (a changed controller action) and indirectly (an endpoint that calls the changed code). Use the swagger to get each one's full shape.
2. **Pull the full input space per endpoint.** Params (required/optional), body, response codes, and any caps/limits read from the code (e.g. a `Max…Items = N`). Each is a candidate scenario.
3. **Add the cross-cutting scenarios** the surface implies: a contract-diff for controller/DTO changes; a flag-on/flag-off pair for flag-gated paths; a data-correctness check (`qa_mlv_convergence`) for anything that writes an MLV; an execution-proof check (`qa_execution_proof`) for any changed symbol.
4. **Pick the right token + path** per §3, and validate with the **full signal stack** (Beat 5) — response body, data that landed, FLT-native outputs, traces, execution proof — never the API status alone.
