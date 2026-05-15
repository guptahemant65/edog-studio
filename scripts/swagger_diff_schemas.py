"""SF-009: Schemas-level diff.

Compares the ``schemas`` dict between two normalized specs.

Top-level change shape:

    {type: "schema-added" | "schema-removed" | "schema-modified",
     key: "<schema name>",
     [oldValue]: <schema>,
     [newValue]: <schema>,
     [subChanges]: [...]}     # only when type == "schema-modified"

Sub-change shape (within ``schema-modified``):

    {subType: "property-added" | "property-removed" | "property-modified"
            | "required-changed" | "type-changed" | "field-changed",
     detail: "<property name>" | "required" | "type" | "<field name>",
     [oldValue]: ..., [newValue]: ...}

Pure function. Output sorted by ``key`` at the top level and by
``(subType, detail)`` within ``subChanges``.
"""

from __future__ import annotations

from typing import Any


def diff_schemas(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    """Return schema-level changes between two normalized specs."""
    left_schemas = left.get("schemas") or {}
    right_schemas = right.get("schemas") or {}

    changes: list[dict[str, Any]] = []
    for key in left_schemas.keys() - right_schemas.keys():
        changes.append({
            "type": "schema-removed",
            "key": key,
            "oldValue": left_schemas[key],
        })
    for key in right_schemas.keys() - left_schemas.keys():
        changes.append({
            "type": "schema-added",
            "key": key,
            "newValue": right_schemas[key],
        })
    for key in left_schemas.keys() & right_schemas.keys():
        if left_schemas[key] != right_schemas[key]:
            changes.append({
                "type": "schema-modified",
                "key": key,
                "oldValue": left_schemas[key],
                "newValue": right_schemas[key],
                "subChanges": _diff_one_schema(left_schemas[key], right_schemas[key]),
            })

    changes.sort(key=lambda c: c["key"])
    return changes


def _diff_one_schema(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    """Drill into a single schema pair and emit sub-changes.

    Only meaningful when both inputs are dict-shaped. Non-dict schemas
    (rare, e.g. boolean schemas in 3.1) fall back to no sub-changes —
    the caller already carries old/new full values.
    """
    if not isinstance(left, dict) or not isinstance(right, dict):
        return []

    subs: list[dict[str, Any]] = []
    subs.extend(_diff_properties(left.get("properties") or {},
                                 right.get("properties") or {}))
    subs.extend(_diff_required(left.get("required"), right.get("required")))
    subs.extend(_diff_type(left.get("type"), right.get("type")))
    subs.extend(_diff_other_fields(left, right))

    subs.sort(key=lambda c: (c["subType"], c.get("detail", "")))
    return subs


def _diff_properties(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name in left.keys() - right.keys():
        out.append({
            "subType": "property-removed",
            "detail": name,
            "oldValue": left[name],
        })
    for name in right.keys() - left.keys():
        out.append({
            "subType": "property-added",
            "detail": name,
            "newValue": right[name],
        })
    for name in left.keys() & right.keys():
        if left[name] != right[name]:
            out.append({
                "subType": "property-modified",
                "detail": name,
                "oldValue": left[name],
                "newValue": right[name],
            })
    return out


def _diff_required(left: Any, right: Any) -> list[dict[str, Any]]:
    if left is None and right is None:
        return []
    if left == right:
        return []
    entry: dict[str, Any] = {
        "subType": "required-changed",
        "detail": "required",
    }
    if left is not None:
        entry["oldValue"] = left
    if right is not None:
        entry["newValue"] = right
    return [entry]


def _diff_type(left: Any, right: Any) -> list[dict[str, Any]]:
    if left == right:
        return []
    entry: dict[str, Any] = {
        "subType": "type-changed",
        "detail": "type",
    }
    if left is not None:
        entry["oldValue"] = left
    if right is not None:
        entry["newValue"] = right
    return [entry]


_HANDLED_TOP_FIELDS = {"properties", "required", "type"}


def _diff_other_fields(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    """Emit a 'field-changed' for any other top-level field that differs."""
    out: list[dict[str, Any]] = []
    keys = (set(left.keys()) | set(right.keys())) - _HANDLED_TOP_FIELDS
    for key in keys:
        if left.get(key) == right.get(key):
            continue
        entry: dict[str, Any] = {
            "subType": "field-changed",
            "detail": key,
        }
        if key in left:
            entry["oldValue"] = left[key]
        if key in right:
            entry["newValue"] = right[key]
        out.append(entry)
    return out
