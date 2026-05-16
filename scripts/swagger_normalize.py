"""SF-006: OpenAPI/Swagger normalizer for semantic diff.

Lifts a raw Swagger 2.0 or OpenAPI 3.x spec into a single canonical shape
that the diff walkers can compare without dialect awareness:

    {
        "version": "openapi-3.0" | "openapi-3.1" | "swagger-2.0",
        "info":    {...},
        "operations": {"METHOD /path": {operation_obj}, ...},
        "schemas":    {"Name": {schema_obj}, ...},
    }

Design choices (locked):

- **Local-only, no network.** `$ref` values are inspected as strings only;
  no HTTP/file fetches. External refs are marked
  `{"$unsupported": "external-$ref", "$ref": <original>}` and left in place.
- **Refs not inlined.** Component schemas are kept as `{"$ref": "..."}` so
  the diff walker can recognize same-schema usage and surface schema-level
  changes once instead of duplicated everywhere it's referenced.
- **Parameter merge.** Path-level `parameters` are merged into each
  operation. Operation-level parameters override on `(in, name)` collision
  (per OpenAPI spec).
- **Parameter sort.** Final parameter list is sorted by `(in, name)` so that
  reordering in the source spec does not surface as a diff.
- **Swagger 2.0 lift.** `definitions` -> `components.schemas`. `basePath`
  prepended to paths. Body parameter (`in: body`) -> `requestBody` with
  `application/json` content. `$ref` rewrites from `#/definitions/X` to
  `#/components/schemas/X` everywhere they appear.

The module is pure: no I/O, no globals, no logging. Safe to import anywhere.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

SCHEMAS_REF_PREFIX = "#/components/schemas/"
DEFINITIONS_REF_PREFIX = "#/definitions/"
UNSUPPORTED_EXTERNAL_REF = "external-$ref"

_HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}


def normalize(spec: dict[str, Any]) -> dict[str, Any]:
    """Return the canonical shape for ``spec``.

    Raises:
        ValueError: if no recognizable OpenAPI/Swagger version key is present.
    """
    version = _detect_version(spec)
    working = deepcopy(spec)
    if version == "swagger-2.0":
        working = _lift_v2(working)
    working = _flag_external_refs(working)
    return {
        "version": version,
        "info": working.get("info", {}),
        "operations": _build_operations(working.get("paths") or {}),
        "schemas": (working.get("components") or {}).get("schemas") or {},
    }


def _detect_version(spec: dict[str, Any]) -> str:
    openapi = spec.get("openapi")
    if isinstance(openapi, str):
        if openapi.startswith("3.0"):
            return "openapi-3.0"
        if openapi.startswith("3.1"):
            return "openapi-3.1"
    swagger = spec.get("swagger")
    if isinstance(swagger, str) and swagger.startswith("2."):
        return "swagger-2.0"
    raise ValueError(
        "Unrecognized OpenAPI/Swagger version. Expected 'openapi' (3.x) or 'swagger' (2.0) key.",
    )


def _lift_v2(spec: dict[str, Any]) -> dict[str, Any]:
    """Transform a Swagger 2.0 doc into an OpenAPI-3-shaped doc.

    Only the structural pieces our normalizer reads are lifted; this is not a
    full v2->v3 converter. Everything else passes through unchanged.
    """
    base_path = (spec.get("basePath") or "").rstrip("/")
    paths = spec.get("paths") or {}
    if base_path:
        paths = {f"{base_path}{path}": item for path, item in paths.items()}

    paths = _lift_v2_path_items(paths)

    components = spec.get("components") or {}
    definitions = spec.get("definitions") or {}
    if definitions:
        existing = dict(components.get("schemas") or {})
        existing.update(definitions)
        components = {**components, "schemas": existing}

    lifted = {**spec, "paths": paths, "components": components}
    lifted.pop("definitions", None)
    lifted.pop("basePath", None)
    return _rewrite_definition_refs(lifted)


def _lift_v2_path_items(paths: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for path, item in paths.items():
        if not isinstance(item, dict):
            out[path] = item
            continue
        new_item = dict(item)
        for method, op in list(item.items()):
            if method.lower() not in _HTTP_METHODS or not isinstance(op, dict):
                continue
            new_item[method] = _lift_v2_operation(op)
        out[path] = new_item
    return out


def _lift_v2_operation(op: dict[str, Any]) -> dict[str, Any]:
    """Move v2 body parameter onto a v3-style ``requestBody`` field."""
    params = op.get("parameters") or []
    body_param = None
    remaining = []
    for p in params:
        if isinstance(p, dict) and p.get("in") == "body" and body_param is None:
            body_param = p
        else:
            remaining.append(p)
    if body_param is None:
        return op
    request_body = {
        "content": {
            "application/json": {
                "schema": body_param.get("schema") or {},
            },
        },
    }
    if body_param.get("required") is not None:
        request_body["required"] = body_param["required"]
    if body_param.get("description"):
        request_body["description"] = body_param["description"]
    new_op = dict(op)
    new_op["parameters"] = remaining
    new_op.setdefault("requestBody", request_body)
    return new_op


def _rewrite_definition_refs(node: Any) -> Any:
    """Rewrite ``#/definitions/X`` -> ``#/components/schemas/X`` everywhere."""
    if isinstance(node, dict):
        if "$ref" in node and isinstance(node["$ref"], str) and node["$ref"].startswith(DEFINITIONS_REF_PREFIX):
            new = dict(node)
            new["$ref"] = SCHEMAS_REF_PREFIX + node["$ref"][len(DEFINITIONS_REF_PREFIX) :]
            return new
        return {k: _rewrite_definition_refs(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_rewrite_definition_refs(item) for item in node]
    return node


def _flag_external_refs(node: Any) -> Any:
    """Replace ``{"$ref": "<non-local>"}`` with a marker dict.

    A local ref begins with ``#/``; anything else (http(s), file paths,
    bare filenames) is flagged. The original ``$ref`` value is preserved
    on the marker for visibility in the diff output.
    """
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and not ref.startswith("#/"):
            return {"$unsupported": UNSUPPORTED_EXTERNAL_REF, "$ref": ref}
        return {k: _flag_external_refs(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_flag_external_refs(item) for item in node]
    return node


def _build_operations(paths: dict[str, Any]) -> dict[str, Any]:
    """Flatten the ``paths`` block into a ``"METHOD /path" -> op`` map."""
    operations: dict[str, Any] = {}
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        path_params = item.get("parameters") or []
        for method, op in item.items():
            if method.lower() not in _HTTP_METHODS or not isinstance(op, dict):
                continue
            key = f"{method.upper()} {path}"
            operations[key] = _build_operation(op, path_params)
    return operations


def _build_operation(op: dict[str, Any], path_params: list[Any]) -> dict[str, Any]:
    merged_params = _merge_parameters(path_params, op.get("parameters") or [])
    out = dict(op)
    out["parameters"] = merged_params
    return out


def _merge_parameters(
    path_level: list[Any],
    op_level: list[Any],
) -> list[dict[str, Any]]:
    """Merge path-level params with op-level, then sort by (in, name).

    Op-level wins on ``(in, name)`` collisions per the OpenAPI specification.
    Non-dict entries (malformed input) are dropped quietly — this is a
    normalizer, not a validator.
    """
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for p in path_level:
        if isinstance(p, dict) and "in" in p and "name" in p:
            by_key[(p["in"], p["name"])] = p
    for p in op_level:
        if isinstance(p, dict) and "in" in p and "name" in p:
            by_key[(p["in"], p["name"])] = p
    return [by_key[k] for k in sorted(by_key.keys())]
