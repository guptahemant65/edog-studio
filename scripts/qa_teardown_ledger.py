"""Append-before-act teardown ledger.

Every mutating action is appended here *before* it executes, so cleanup can
reverse it even after a crash. JSONL, one entry per line, owned by EDOG and
replayable by ``edog --qa-cleanup`` independent of the skill process.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
QA_ROOT = PROJECT_DIR / ".edog-qa"


def _ledger_path(run_id: str) -> Path:
    return QA_ROOT / "runs" / run_id / "ledger.jsonl"


def record(run_id: str, action: str, detail: dict, *, reverse: dict) -> str:
    """Append a mutating action and how to reverse it. Returns the entry id."""
    path = _ledger_path(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "ts": time.time(),
        "action": action,
        "detail": detail,
        "reverse": reverse,
        "reversed": False,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")
    return entry["id"]


def _load(run_id: str) -> list[dict]:
    path = _ledger_path(run_id)
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _rewrite(run_id: str, entries: list[dict]) -> None:
    path = _ledger_path(run_id)
    path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")


def pending(run_id: str) -> list[dict]:
    """Return entries not yet successfully reversed, in record order."""
    return [e for e in _load(run_id) if not e["reversed"]]


def reverse_all(run_id: str, handler: Callable[[dict], bool]) -> dict:
    """Reverse all pending entries LIFO. ``handler(reverse_spec) -> bool``.

    Marks each reversed on success; leaves failures pending for retry.
    Returns {"reversed": int, "failed": int}.
    """
    entries = _load(run_id)
    if not entries:
        # Nothing recorded (missing or empty ledger) -> nothing to reverse and
        # nothing to persist. Returning early also avoids creating a stray
        # ledger dir/file for a bogus or already-clean run id.
        return {"reversed": 0, "failed": 0}
    reversed_n = failed_n = 0
    for entry in reversed(entries):  # LIFO
        if entry["reversed"]:
            continue
        ok = False
        try:
            ok = handler(entry["reverse"])
        except Exception:
            ok = False
        if ok:
            entry["reversed"] = True
            reversed_n += 1
        else:
            failed_n += 1
    _rewrite(run_id, entries)
    return {"reversed": reversed_n, "failed": failed_n}
