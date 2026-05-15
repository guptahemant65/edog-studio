"""SF-010/SF-011: Baseline swagger file management.

Tiny module that owns the on-disk baseline spec. Kept separate from
dev-server so the file IO is unit-testable and the read-side (SF-010
diff endpoint) and write-side (SF-011 baseline endpoints) share the
same canonical path.

The baseline is a plain JSON document — exactly what FLT returned from
its ``/swagger/v1/swagger.json`` at some past moment. Comparing the
runtime spec to it produces the diff the playground renders.

Path convention: ``edog-studio/data/swagger-baseline.json`` (committed to
the repo, per ADR-008 / plan §6).

All functions accept an explicit ``Path``: no module-level globals.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_baseline(path: Path) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Read the baseline spec at ``path``.

    Returns:
        (spec, metadata)

        spec     -- parsed JSON dict, or None if the file is absent,
                    empty, or unreadable as JSON.
        metadata -- {"exists": bool, "savedAt": ISO-string|None,
                     "size": int|None, "error": str|None}

    Never raises. Corrupt/empty baselines are surfaced via ``metadata.error``
    so callers can render a clear "re-save baseline" CTA.
    """
    if not path.exists():
        return None, {"exists": False, "savedAt": None, "size": None, "error": None}

    try:
        stat = path.stat()
    except OSError as exc:
        return None, {"exists": True, "savedAt": None, "size": None,
                      "error": f"stat-failed: {exc}"}

    size = stat.st_size
    saved_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

    if size == 0:
        # Empty placeholder (e.g. fresh checkout before first save) — treat as
        # baseline-absent so the frontend shows the save-CTA.
        return None, {"exists": True, "savedAt": saved_at, "size": 0, "error": None}

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, {"exists": True, "savedAt": saved_at, "size": size,
                      "error": f"read-failed: {exc}"}

    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, {"exists": True, "savedAt": saved_at, "size": size,
                      "error": f"baseline-corrupt: {exc}"}

    if not isinstance(spec, dict):
        return None, {"exists": True, "savedAt": saved_at, "size": size,
                      "error": "baseline-corrupt: top level is not an object"}

    # An empty object ``{}`` is the seed placeholder — same UX as missing.
    if not spec:
        return None, {"exists": True, "savedAt": saved_at, "size": size,
                      "error": None}

    return spec, {"exists": True, "savedAt": saved_at, "size": size, "error": None}


def save_baseline(path: Path, spec: dict[str, Any]) -> dict[str, Any]:
    """Write ``spec`` to ``path`` atomically. Returns metadata.

    Atomic-rename pattern: write to ``<path>.tmp``, then os.replace.
    Parent directory is created if missing.
    """
    if not isinstance(spec, dict):
        raise TypeError("baseline spec must be a dict")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(spec, indent=2, sort_keys=True)
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)
    stat = path.stat()
    return {
        "exists": True,
        "savedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "size": stat.st_size,
        "error": None,
    }


def remove_baseline(path: Path) -> bool:
    """Remove the baseline file if it exists. Returns True if removed."""
    if not path.exists():
        return False
    path.unlink()
    return True
