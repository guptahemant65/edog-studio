"""Global single-validation lock for the FLT PR Scenario Validator.

Heartbeat-based: the skill orchestrates across turns and is not a single
persistent process, so liveness is tracked by a heartbeat timestamp the
holder refreshes each turn. A lock whose heartbeat is older than
``stale_after`` seconds is considered abandoned and may be reclaimed.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
LOCK_PATH = PROJECT_DIR / ".edog-qa" / "run.lock"
DEFAULT_STALE_AFTER = 1800  # 30 minutes


def _read() -> dict | None:
    try:
        return json.loads(LOCK_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _write(record: dict) -> None:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(json.dumps(record))


def status() -> dict | None:
    """Return the current lock holder record, or None if free."""
    return _read()


def acquire(run_id: str, pr: str, *, stale_after: int = DEFAULT_STALE_AFTER) -> tuple[bool, dict]:
    """Try to acquire the validation lock.

    Returns (True, our_record) on success, or (False, current_holder) if a
    non-stale lock is already held by a different run.
    """
    now = time.time()
    held = _read()
    if held and held.get("runId") != run_id:
        age = now - float(held.get("heartbeat", 0.0))
        if age < stale_after:
            return False, held
    record = {"runId": run_id, "pr": pr, "startedAt": now, "heartbeat": now}
    _write(record)
    return True, record


def heartbeat(run_id: str) -> bool:
    """Refresh the heartbeat if we hold the lock. Returns True if refreshed."""
    held = _read()
    if not held or held.get("runId") != run_id:
        return False
    held["heartbeat"] = time.time()
    _write(held)
    return True


def release(run_id: str) -> None:
    """Release the lock, but only if we are the holder."""
    held = _read()
    if held and held.get("runId") == run_id:
        LOCK_PATH.unlink(missing_ok=True)
