"""SF-007: Paths-level diff walker.

Compares two normalized specs (see scripts/swagger_normalize.py) at the
operations layer and produces a typed change list:

    [{type: "added" | "removed" | "modified",
      key: "METHOD /path",
      [oldValue]: <op>,
      [newValue]: <op>}, ...]

"added"/"removed" mean the key is only present on one side. "modified"
means the key is on both sides but the operation bodies are not equal —
SF-008 (operation-level diff) is responsible for explaining HOW they
differ. We deliberately stay at the path layer here so the diff stays
composable.

Output is sorted by ``key`` for deterministic snapshots.
Pure function: no I/O, no globals, never mutates inputs.
"""

from __future__ import annotations

from typing import Any


def diff_paths(
    left: dict[str, Any],
    right: dict[str, Any],
) -> list[dict[str, Any]]:
    """Return the list of operation-level changes between ``left`` and ``right``.

    ``left`` is the baseline; ``right`` is the candidate (typically runtime).
    """
    left_ops = left.get("operations") or {}
    right_ops = right.get("operations") or {}

    changes: list[dict[str, Any]] = []
    for key in left_ops.keys() - right_ops.keys():
        changes.append({
            "type": "removed",
            "key": key,
            "oldValue": left_ops[key],
        })
    for key in right_ops.keys() - left_ops.keys():
        changes.append({
            "type": "added",
            "key": key,
            "newValue": right_ops[key],
        })
    for key in left_ops.keys() & right_ops.keys():
        if left_ops[key] != right_ops[key]:
            changes.append({
                "type": "modified",
                "key": key,
                "oldValue": left_ops[key],
                "newValue": right_ops[key],
            })

    changes.sort(key=lambda c: c["key"])
    return changes
