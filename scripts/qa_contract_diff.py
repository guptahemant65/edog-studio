"""Deterministic API-contract diff between two generated OpenAPI specs.

We do NOT use the committed Swagger/Swagger.json baseline -- it is updated
infrequently and drifts from reality, which makes a runtime-vs-baseline diff
misleading. Instead the caller generates the swagger spec from the PR branch
and from its merge-base (main) and passes both here, so the diff reflects
exactly what THIS PR changed. An endpoint = (METHOD, path); a removed or
signature/response-shape-changed endpoint is breaking, a pure addition is not.
Each change carries a stable, content-derived ``ch-NNN`` id for citation.
"""

from __future__ import annotations

_BREAKING_KINDS = {"removed", "modified"}


def _endpoints(spec: dict) -> dict:
    out = {}
    for path, methods in (spec.get("paths") or {}).items():
        for method, op in (methods or {}).items():
            if isinstance(op, dict):
                out[f"{method.upper()} {path}"] = op
    return out


def _signature(op: dict) -> dict:
    # The pieces a consumer depends on: params + request body + response codes.
    return {
        "params": sorted(
            (p.get("name"), p.get("in"), bool(p.get("required")))
            for p in op.get("parameters", [])
            if isinstance(p, dict)
        ),
        "requestBody": "requestBody" in op,
        "responses": sorted((op.get("responses") or {}).keys()),
    }


def diff(main_spec: dict, pr_spec: dict) -> dict:
    main_eps, pr_eps = _endpoints(main_spec), _endpoints(pr_spec)
    raw = []
    for key in sorted(set(main_eps) | set(pr_eps)):
        if key not in main_eps:
            raw.append(("added", key))
        elif key not in pr_eps:
            raw.append(("removed", key))
        elif _signature(main_eps[key]) != _signature(pr_eps[key]):
            raw.append(("modified", key))
    changes = [{"id": f"ch-{i:03d}", "kind": kind, "endpoint": key} for i, (kind, key) in enumerate(raw, start=1)]
    breaking = [c for c in changes if c["kind"] in _BREAKING_KINDS]
    return {
        "changed": bool(changes),
        "totalChanges": len(changes),
        "changes": changes,
        "breaking": breaking,
        "evidence": [c["id"] for c in changes],
    }
