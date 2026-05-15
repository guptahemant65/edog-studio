"""Pure FLT repo discovery utilities — no print/input, no CLI coupling.

Used by both edog.py (CLI UX) and dev-server.py (JSON API).
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

# Signature: FLT repo must contain this path
FLT_MARKER = Path("Service") / "Microsoft.LiveTable.Service"

# EDOG-managed paths inside the FLT repo. Used to filter out edog's own
# DEVMODE changes from the "dirty files" count we show on the topbar —
# those edits are tooling artifacts, not user changes.
#
# DevMode/ is entirely owned by edog (we drop ~40 new .cs files there on
# every deploy). Patched files (WorkloadApp.cs, Test.json, etc.) are
# discovered dynamically from .edog-changes.patch when present, so this
# stays in sync automatically as edog.py adds/removes patch sites.
EDOG_DEVMODE_DIRS = (
    "Service/Microsoft.LiveTable.Service/DevMode/",
)
EDOG_PATCH_FILE = Path(__file__).resolve().parents[1] / ".edog-changes.patch"


def _edog_patched_paths() -> set[str]:
    """Parse .edog-changes.patch for the list of FLT files edog modifies.

    Returns the set of forward-slash repo-relative paths. Empty set if the
    patch file is missing (no deploy yet) — in which case nothing is
    filtered and all dirty entries surface, which is the safe default.
    """
    if not EDOG_PATCH_FILE.exists():
        return set()
    paths: set[str] = set()
    try:
        for line in EDOG_PATCH_FILE.read_text(encoding="utf-8").splitlines():
            if line.startswith("diff --git a/"):
                rest = line[len("diff --git a/"):]
                sep = rest.find(" b/")
                if sep > 0:
                    paths.add(rest[:sep])
    except (OSError, UnicodeDecodeError):
        pass
    return paths


def _is_edog_managed(path: str, patched: set[str]) -> bool:
    """True if *path* (forward-slash, repo-relative) is owned by edog."""
    if path in patched:
        return True
    return any(path.startswith(d) for d in EDOG_DEVMODE_DIRS)


def _parse_porcelain_path(line: str) -> str | None:
    """Extract the new path from a single `git status --porcelain` line.

    Format: ``XY PATH`` or ``XY PATH -> NEWPATH`` (renames). Paths with
    special characters are wrapped in double-quotes by git; we strip
    those for matching.
    """
    if len(line) < 4:
        return None
    path = line[3:].strip()
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    if path.startswith('"') and path.endswith('"'):
        path = path[1:-1]
    return path.replace("\\", "/") or None

SKIP_DIRS = frozenset(
    {
        ".git",
        ".vs",
        ".vscode",
        "node_modules",
        "__pycache__",
        "bin",
        "obj",
        "packages",
        "AppData",
        ".nuget",
        ".dotnet",
        ".azure",
        "OneDrive",
    }
)


def is_flt_repo(path: Path) -> bool:
    """Check if *path* contains the FLT repo marker."""
    try:
        return (path / FLT_MARKER).exists()
    except (PermissionError, OSError):
        return False


def validate_repo(path: str | Path) -> dict:
    """Validate a path as an FLT repo.

    Returns dict with keys: valid, path, reason, gitBranch, gitDirty.
    """
    p = Path(path).expanduser().resolve()
    if not p.exists():
        return {"valid": False, "path": str(p), "reason": "path_not_found"}
    if not p.is_dir():
        return {"valid": False, "path": str(p), "reason": "not_a_directory"}
    if not is_flt_repo(p):
        return {"valid": False, "path": str(p), "reason": "missing_flt_marker"}

    git_branch = ""
    git_dirty = 0
    git_dirty_edog = 0
    git_dirty_total = 0
    has_git = (p / ".git").exists()
    if has_git:
        try:
            git_branch = (
                subprocess.check_output(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=str(p),
                    timeout=3,
                    stderr=subprocess.DEVNULL,
                )
                .decode()
                .strip()
            )
            porcelain = subprocess.check_output(
                ["git", "status", "--porcelain", "-uall"],
                cwd=str(p),
                timeout=3,
                stderr=subprocess.DEVNULL,
            ).decode()
            patched = _edog_patched_paths()
            for raw in porcelain.splitlines():
                if not raw:
                    continue
                path = _parse_porcelain_path(raw)
                if path is None:
                    continue
                git_dirty_total += 1
                if _is_edog_managed(path, patched):
                    git_dirty_edog += 1
                else:
                    git_dirty += 1
        except Exception:
            pass

    return {
        "valid": True,
        "path": str(p),
        "reason": None,
        "gitBranch": git_branch,
        "gitDirty": git_dirty,
        "gitDirtyEdog": git_dirty_edog,
        "gitDirtyTotal": git_dirty_total,
        "hasGit": has_git,
    }


def get_configured_repo(config: dict) -> dict | None:
    """Check config for flt_repo_path and validate it.

    Returns validate_repo() result if configured, None if not configured.
    """
    flt_path = config.get("flt_repo_path", "")
    if not flt_path:
        return None
    return validate_repo(flt_path)


def find_flt_repos(
    *,
    max_depth: int = 4,
    limit: int = 10,
    timeout_sec: float = 5.0,
) -> dict:
    """Scan home directory for FLT repos.

    Returns dict: {found: [str], partial: bool, timedOut: bool}
    """
    home = Path.home()
    found: list[str] = []
    timed_out = False
    deadline = time.monotonic() + timeout_sec

    def _search(start: Path, depth: int = 0) -> None:
        nonlocal timed_out
        if depth > max_depth or len(found) >= limit:
            return
        if time.monotonic() > deadline:
            timed_out = True
            return
        try:
            for entry in start.iterdir():
                if timed_out or len(found) >= limit:
                    return
                try:
                    if not entry.is_dir():
                        continue
                except (PermissionError, OSError):
                    continue
                if entry.name.startswith(".") or entry.name in SKIP_DIRS:
                    continue
                if is_flt_repo(entry):
                    found.append(str(entry.resolve()))
                    continue
                _search(entry, depth + 1)
        except (PermissionError, OSError):
            pass

    # Prioritize common dev directories before broad home scan
    priority_dirs = [
        home / "source" / "repos",
        home / "repos",
        home / "work",
        home / "dev",
        home / "projects",
        home / "code",
        Path.cwd(),
    ]
    for d in priority_dirs:
        if d.exists() and d.is_dir():
            _search(d)
        if found or timed_out:
            break

    # If nothing found in priority dirs, scan home (broader)
    if not found and not timed_out:
        _search(home)

    return {
        "found": found,
        "partial": len(found) >= limit,
        "timedOut": timed_out,
    }
