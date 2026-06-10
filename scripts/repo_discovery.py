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
EDOG_DEVMODE_DIRS = ("Service/Microsoft.LiveTable.Service/DevMode/",)
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
                rest = line[len("diff --git a/") :]
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


# Relative path inside an FLT repo to the swagger spec the team commits.
# This is the canonical baseline for the API playground diff feature — the
# source-of-truth Swagger.json that lives under source control, not a
# separately-captured snapshot in the edog-studio working tree.
FLT_SWAGGER_RELPATH = Path("Service") / "Microsoft.LiveTable.Service" / "Swagger" / "Swagger.json"


def get_flt_swagger_path(repo_root: Path | str) -> Path:
    """Return the absolute path to the FLT repo's committed Swagger.json.

    Does not check existence — that's the caller's job. Use this so the
    location stays consistent across diff/baseline endpoints and tests.
    """
    return Path(repo_root) / FLT_SWAGGER_RELPATH


def get_configured_swagger_path(config: dict) -> Path | None:
    """Resolve the committed swagger path from config, or None.

    Returns None when:
      - no ``flt_repo_path`` configured, or
      - the configured path fails ``validate_repo`` (missing/wrong layout).

    Existence of the Swagger.json file itself is NOT checked here — the
    caller decides whether absence is a hard error or a soft "no baseline"
    state.
    """
    repo_info = get_configured_repo(config)
    if not repo_info or not repo_info.get("valid"):
        return None
    return get_flt_swagger_path(repo_info["path"])


# Microsoft Dev Box guarantees a dedicated local dev drive mounted at Q:\ —
# devbox users clone repos there, not under C:\Users (the OS disk). The scan
# below is otherwise home-rooted (C:), so without this a devbox user gets an
# empty auto-scan and has to paste the path by hand. Existence-gated at search
# time, so on a non-devbox machine (no Q:\) it's a zero-cost no-op.
DEVBOX_DRIVE_ROOT = Path("Q:/")


def find_flt_repos(
    *,
    max_depth: int = 4,
    limit: int = 10,
    timeout_sec: float = 5.0,
) -> dict:
    """Scan for FLT repos under the home dir and the devbox Q:\\ drive.

    Returns dict: {found: [str], partial: bool, timedOut: bool}
    """
    home = Path.home()
    found: list[str] = []
    seen: set[str] = set()
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
                    # Dedup by resolved path: priority roots overlap (e.g. cwd
                    # can sit inside ~/source/repos, and the Q:\ root is rescanned
                    # in the fallback), so the same repo may be reached twice.
                    resolved = str(entry.resolve())
                    if resolved not in seen:
                        seen.add(resolved)
                        found.append(resolved)
                    continue
                _search(entry, depth + 1)
        except (PermissionError, OSError):
            pass

    # Prioritize common dev directories before the broad home scan. C:-home
    # roots come first so they dominate ordering on a laptop; the devbox Q:\
    # root is appended so a devbox — whose repos live on Q:, not C: — still
    # auto-detects.
    #
    # DO NOT break out of this loop on the first dir that yields a hit. Scanning
    # ALL priority dirs and aggregating (deduped above) is load-bearing: the old
    # break-on-first picked whichever dir matched earliest, so a decoy clone in
    # ~/source/repos silently hid the user's real repo in ~/work and the caller,
    # seeing a single result, auto-selected the wrong path. See
    # tests/test_repo_discovery_scan_all.py.
    priority_dirs = [
        home / "source" / "repos",
        home / "repos",
        home / "work",
        home / "dev",
        home / "projects",
        home / "code",
        Path.cwd(),
        DEVBOX_DRIVE_ROOT / "src",
        DEVBOX_DRIVE_ROOT,
    ]
    for d in priority_dirs:
        if d.exists() and d.is_dir():
            _search(d)
        if timed_out or len(found) >= limit:
            break

    # Only if the targeted priority dirs found nothing do we pay for the broad
    # home scan (keeps the common case fast), then — for a devbox whose layout
    # didn't match the priority roots — the Q:\ drive.
    if not found and not timed_out:
        _search(home)
    if not found and not timed_out and DEVBOX_DRIVE_ROOT.exists():
        _search(DEVBOX_DRIVE_ROOT)

    return {
        "found": found,
        "partial": len(found) >= limit,
        "timedOut": timed_out,
    }
