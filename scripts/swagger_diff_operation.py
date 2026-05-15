"""SF-008: Operation-level diff.

Compares two operation dicts (post-normalization, i.e. path-level params
already merged in) and produces a list of typed sub-changes:

    [{subType, detail, [oldValue], [newValue]}, ...]

Sub-categories:

  - parameter-added/removed/modified  (keyed by ``<in>.<name>``)
  - request-body-added/removed/modified
  - response-added/removed/modified  (keyed by HTTP status string)
  - metadata-changed  (summary, description, deprecated, tags, operationId)

Pure function. Output sorted by ``(subType, detail)`` for stable snapshots.
Never mutates inputs.
"""

from __future__ import annotations

from typing import Any

_METADATA_FIELDS = ("summary", "description", "deprecated", "tags", "operationId")


def diff_operation(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    """Return the sub-change list for a single operation pair."""
    changes: list[dict[str, Any]] = []
    changes.extend(_diff_parameters(left.get("parameters") or [],
                                    right.get("parameters") or []))
    changes.extend(_diff_request_body(left.get("requestBody"),
                                       right.get("requestBody")))
    changes.extend(_diff_responses(left.get("responses") or {},
                                    right.get("responses") or {}))
    changes.extend(_diff_metadata(left, right))
    changes.sort(key=lambda c: (c["subType"], c.get("detail", "")))
    return changes


def _param_key(p: dict[str, Any]) -> str:
    return f"{p.get('in', '?')}.{p.get('name', '?')}"


def _diff_parameters(
    left: list[Any],
    right: list[Any],
) -> list[dict[str, Any]]:
    left_map = {_param_key(p): p for p in left if isinstance(p, dict)}
    right_map = {_param_key(p): p for p in right if isinstance(p, dict)}
    out: list[dict[str, Any]] = []
    for key in left_map.keys() - right_map.keys():
        out.append({
            "subType": "parameter-removed",
            "detail": key,
            "oldValue": left_map[key],
        })
    for key in right_map.keys() - left_map.keys():
        out.append({
            "subType": "parameter-added",
            "detail": key,
            "newValue": right_map[key],
        })
    for key in left_map.keys() & right_map.keys():
        if left_map[key] != right_map[key]:
            out.append({
                "subType": "parameter-modified",
                "detail": key,
                "oldValue": left_map[key],
                "newValue": right_map[key],
            })
    return out


def _diff_request_body(
    left: Any,
    right: Any,
) -> list[dict[str, Any]]:
    if left is None and right is None:
        return []
    if left is None:
        return [{"subType": "request-body-added", "detail": "requestBody",
                 "newValue": right}]
    if right is None:
        return [{"subType": "request-body-removed", "detail": "requestBody",
                 "oldValue": left}]
    if left != right:
        return [{"subType": "request-body-modified", "detail": "requestBody",
                 "oldValue": left, "newValue": right}]
    return []


def _diff_responses(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for status in left.keys() - right.keys():
        out.append({
            "subType": "response-removed",
            "detail": str(status),
            "oldValue": left[status],
        })
    for status in right.keys() - left.keys():
        out.append({
            "subType": "response-added",
            "detail": str(status),
            "newValue": right[status],
        })
    for status in left.keys() & right.keys():
        if left[status] != right[status]:
            out.append({
                "subType": "response-modified",
                "detail": str(status),
                "oldValue": left[status],
                "newValue": right[status],
            })
    return out


def _diff_metadata(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for field in _METADATA_FIELDS:
        has_left = field in left
        has_right = field in right
        if not has_left and not has_right:
            continue
        if left.get(field) != right.get(field):
            entry: dict[str, Any] = {
                "subType": "metadata-changed",
                "detail": field,
            }
            if has_left:
                entry["oldValue"] = left[field]
            if has_right:
                entry["newValue"] = right[field]
            out.append(entry)
    return out
