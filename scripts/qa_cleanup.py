"""Reverse a QA run's teardown ledger, independent of the skill process.

Unknown ops count as failures (left pending) rather than crashing, so a partial
catalog can never silently drop an orphaned resource.
"""

from __future__ import annotations

import os
import signal
import urllib.request

from scripts import qa_run_lock
from scripts import qa_teardown_ledger as ledger

# EDOG's dev-server binds this fixed address (dev-server.py, ThreadedHTTPServer
# on 127.0.0.1:5555). Single-sourced here so the control-plane base isn't a
# literal repeated per reverser.
EDOG_BASE = "http://127.0.0.1:5555"


def _flag_clear(s: dict) -> bool:
    req = urllib.request.Request(
        f"{EDOG_BASE}/api/edog/feature-flags/overrides/{s['flag']}",
        method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status < 400


def _capacity_delete(s: dict) -> bool:
    req = urllib.request.Request(
        f"{EDOG_BASE}/api/fabric/capacities/{s['capacityId']}",
        method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status < 400


def _worktree_remove(s: dict) -> bool:
    import subprocess

    return (
        subprocess.run(
            ["git", "worktree", "remove", "--force", s["path"]],
            capture_output=True,
            check=False,
        ).returncode
        == 0
    )


def _config_restore(s: dict) -> bool:
    """Restore flt_repo_path after a worktree deploy (deploy is config-driven)."""
    import json
    from pathlib import Path

    cfg_path = Path(__file__).parent.parent / "edog-config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["flt_repo_path"] = s["original"]
    cfg_path.write_text(json.dumps(cfg, indent=2))
    return True


def _server_stop(s: dict) -> bool:
    """Stop the headless dev-server the skill spawned in Beat 1 (by recorded PID).

    Idempotent: a process that is already gone counts as success, so cleanup is
    safe to retry. Only ever targets the exact PID the skill recorded — never a
    pre-existing server the skill did not start.
    """
    pid = s.get("pid")
    if not pid:
        return False
    try:
        os.kill(int(pid), signal.SIGTERM)
        return True
    except ProcessLookupError:
        return True  # already stopped
    except (OSError, ValueError):
        return False


REVERSERS = {
    "flag_clear": _flag_clear,
    "capacity_delete": _capacity_delete,
    "worktree_remove": _worktree_remove,
    "config_restore": _config_restore,  # restore flt_repo_path after worktree deploy
    "server_stop": _server_stop,  # stop the headless dev-server started in Beat 1
    "chaos_remove": lambda s: True,  # wired in Phase N (chaos is SignalR-only today)
    "lock_release": lambda s: True,
}


def run(run_id: str) -> dict:
    def handler(rev: dict) -> bool:
        fn = REVERSERS.get(rev.get("op"))
        return fn(rev) if fn else False

    result = ledger.reverse_all(run_id, handler)
    qa_run_lock.release(run_id)
    return result
