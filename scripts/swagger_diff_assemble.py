"""SF-010 (glue): Assemble the final diff payload.

Composes ``diff_paths``, ``diff_operation``, and ``diff_schemas`` outputs
into the single payload the frontend renders:

    {
      "summary": {
        "endpoints": {"added": N, "removed": N, "modified": N},
        "schemas":   {"added": N, "removed": N, "modified": N},
        "totalChanges": N
      },
      "changes": [
        {"id": "ch-001",
         "category": "endpoints" | "schemas",
         "type": "added" | "removed" | "modified",
         "key": "<METHOD /path>" | "<schema name>",
         [oldValue], [newValue], [subChanges]}, ...
      ]
    }

Endpoints come first, then schemas. Change IDs are zero-padded so a
lexical sort matches insertion order. Pure function: no I/O.
"""

from __future__ import annotations

from typing import Any

from swagger_diff_operation import diff_operation
from swagger_diff_paths import diff_paths
from swagger_diff_schemas import diff_schemas


def build_diff_payload(
    baseline_norm: dict[str, Any],
    runtime_norm: dict[str, Any],
) -> dict[str, Any]:
    """Build the diff response payload.

    Args:
        baseline_norm: Normalized baseline spec (the "old" side).
        runtime_norm: Normalized runtime spec (the "new" side).
    """
    endpoint_changes = _endpoint_changes(baseline_norm, runtime_norm)
    schema_changes = _schema_changes(baseline_norm, runtime_norm)

    all_changes: list[dict[str, Any]] = []
    all_changes.extend(endpoint_changes)
    all_changes.extend(schema_changes)

    for i, change in enumerate(all_changes, start=1):
        change["id"] = f"ch-{i:03d}"

    return {
        "summary": {
            "endpoints": _counts(endpoint_changes),
            "schemas": _counts(schema_changes),
            "totalChanges": len(all_changes),
        },
        "changes": all_changes,
    }


def _endpoint_changes(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in diff_paths(left, right):
        entry: dict[str, Any] = {
            "category": "endpoints",
            "type": raw["type"],
            "key": raw["key"],
        }
        if "oldValue" in raw:
            entry["oldValue"] = raw["oldValue"]
        if "newValue" in raw:
            entry["newValue"] = raw["newValue"]
        if raw["type"] == "modified":
            entry["subChanges"] = diff_operation(raw["oldValue"], raw["newValue"])
        out.append(entry)
    return out


def _schema_changes(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in diff_schemas(left, right):
        # raw["type"] is "schema-added"/"schema-removed"/"schema-modified".
        # Normalize the type label to the same vocabulary as endpoints so
        # the frontend can render both uniformly.
        short_type = raw["type"].split("-", 1)[1]  # added | removed | modified
        entry: dict[str, Any] = {
            "category": "schemas",
            "type": short_type,
            "key": raw["key"],
        }
        if "oldValue" in raw:
            entry["oldValue"] = raw["oldValue"]
        if "newValue" in raw:
            entry["newValue"] = raw["newValue"]
        if "subChanges" in raw:
            entry["subChanges"] = raw["subChanges"]
        out.append(entry)
    return out


def _counts(changes: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"added": 0, "removed": 0, "modified": 0}
    for change in changes:
        t = change["type"]
        if t in counts:
            counts[t] += 1
    return counts
