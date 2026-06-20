"""Derive the required-infra spec from the scenario plan, and diff it against an
existing target's actual infra to produce the 'what is missing' list.

Beyond counts, scenarios may demand specific TABLE PROPERTIES (e.g.
enableChangeDataFeed=False), flag PRECONDITIONS (e.g. FLTMLVWarnings on +
FLTIRDeltaPhysicalCDFEnabled off), and a DAG SHAPE (node count) -- so a property
mismatch on a same-named table makes an existing target unfit even when the
table exists.
"""

from __future__ import annotations


def required(scenarios: list[dict]) -> dict:
    lakehouses = mlvs = dag_nodes = 0
    tables: set[str] = set()
    table_props: dict[str, dict] = {}
    flags: dict[str, bool] = {}
    for s in scenarios:
        infra = s.get("infra", {})
        lakehouses = max(lakehouses, int(infra.get("lakehouses", 0)))
        mlvs = max(mlvs, int(infra.get("mlvs", 0)))
        dag_nodes = max(dag_nodes, int(infra.get("dag_nodes", 0)))
        tables.update(infra.get("tables", []))
        for name, props in (infra.get("table_properties") or {}).items():
            table_props.setdefault(name, {}).update(props)
            tables.add(name)
        for flag, state in (s.get("preconditions", {}).get("flags") or {}).items():
            flags[flag] = bool(state)
    return {
        "lakehouses": lakehouses,
        "tables": sorted(tables),
        "mlvs": mlvs,
        "table_properties": table_props,
        "flags": flags,
        "dag_nodes": dag_nodes,
    }


def fitness(req: dict, have: dict) -> dict:
    have_tables = set(have.get("tables", []))
    missing_tables = [t for t in req["tables"] if t not in have_tables]
    missing_mlvs = max(0, req["mlvs"] - int(have.get("mlvs", 0)))
    missing_lh = max(0, req["lakehouses"] - int(have.get("lakehouses", 0)))
    dag_short = max(0, req.get("dag_nodes", 0) - int(have.get("dag_nodes", 0)))
    have_props = have.get("table_properties") or {}
    prop_mismatch = {}
    for name, props in req.get("table_properties", {}).items():
        if name in have_tables:
            bad = {k: val for k, val in props.items() if have_props.get(name, {}).get(k) != val}
            if bad:
                prop_mismatch[name] = bad
    fits = not missing_tables and missing_mlvs == 0 and missing_lh == 0 and not prop_mismatch and dag_short == 0
    return {
        "fits": fits,
        "missing": {
            "tables": missing_tables,
            "mlvs": missing_mlvs,
            "lakehouses": missing_lh,
            "property_mismatch": prop_mismatch,
            "dag_nodes": dag_short,
        },
        "required_flags": req.get("flags", {}),
    }
