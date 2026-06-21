"""Build the qa_codegraph C# tools on demand.

The skill's Roslyn tools (ChangeScanner, PreciseEngine) are committed as source,
not binaries — so after a fresh clone/install their Release DLLs don't exist yet.
This builds them lazily the first time they're needed (and the skill's install.py
builds them up front). If dotnet is unavailable the caller degrades honestly.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
CODEGRAPH = PROJECT_DIR / "scripts" / "qa_codegraph"
PROJECTS = ("ChangeScanner", "PreciseEngine")


def dll_path(project: str) -> Path:
    return CODEGRAPH / project / "bin" / "Release" / "net9.0" / f"{project}.dll"


def ensure_built(project: str) -> Path | None:
    """Return the project's Release DLL, building it once if missing.

    Returns None (never raises) when dotnet is unavailable or the build fails, so
    callers fall back to their honest degraded path.
    """
    dll = dll_path(project)
    if dll.exists():
        return dll
    proj_dir = CODEGRAPH / project
    if not proj_dir.is_dir() or shutil.which("dotnet") is None:
        return None
    try:
        subprocess.run(
            ["dotnet", "build", "-c", "Release", "--nologo", "-v", "quiet"],
            cwd=str(proj_dir), capture_output=True, text=True, timeout=600, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return dll if dll.exists() else None


def build_all() -> dict[str, bool]:
    """Build every codegraph tool (used by install.py). Returns project -> built?."""
    return {p: ensure_built(p) is not None for p in PROJECTS}


if __name__ == "__main__":
    import json
    print(json.dumps(build_all(), indent=2))
