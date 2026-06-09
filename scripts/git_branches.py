"""Pure git operations for the FLT branch switcher.

No HTTP, no studio state. Every git call is best-effort with a timeout and
never raises. The HTTP layer (dev-server.py) owns the phase guard and config
resolution; this module owns the git mechanics.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

# Phases during which the working tree is bound to a running/deploying FLT
# build. Switching the branch under it would make the displayed branch lie
# about what is executing, so we refuse.
LOCKED_PHASES = frozenset({"deploying", "running"})
# Phases where switching is safe (pre-deploy or torn down).
ALLOWED_PHASES = frozenset({"idle", "stopped", "crashed"})


def phase_allows_switch(phase: str | None) -> bool:
    """True only for explicitly-allowed pre-deploy phases. Fails closed."""
    return phase in ALLOWED_PHASES


def _run_git(
    repo_path: str, args: list[str], timeout: int = 15
) -> tuple[int, str, str]:
    """Run ``git <args>`` in *repo_path*. Returns (code, stdout, stderr).

    Never raises: transport/timeout failures return (1, "", "<reason>").
    """
    if not repo_path or not Path(repo_path).is_dir():
        return (1, "", "invalid repo path")
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
        return (result.returncode, result.stdout, result.stderr)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return (1, "", str(exc))


def get_current_branch(repo_path: str) -> tuple[str, bool]:
    """Return (name, detached). On detached HEAD, name is the short SHA."""
    code, out, _ = _run_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    name = out.strip()
    if code != 0:
        return ("", False)
    if name == "HEAD":
        _, sha, _ = _run_git(repo_path, ["rev-parse", "--short", "HEAD"])
        return (sha.strip(), True)
    return (name, False)
