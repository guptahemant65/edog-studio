"""Install this repo skill into user-global ~/.copilot/skills/.

Prefers a symlink so the installed skill stays in sync with the repo (and its
``scripts/qa_*`` primitive dependencies). Falls back to a directory copy on
platforms/accounts where symlink creation is not permitted (e.g. Windows
without Developer Mode), printing a note that a copy will not auto-update.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _clear(dst: Path) -> None:
    if dst.is_symlink():
        try:
            dst.unlink()
        except OSError:
            os.rmdir(dst)
    elif dst.is_dir():
        shutil.rmtree(dst)
    elif dst.exists():
        dst.unlink()


def _build_codegraph_tools(repo_root: Path) -> None:
    """Build the Roslyn code-graph tools the skill's Beat 2 uses.

    They are committed as source (not binaries); this builds their Release DLLs so
    Beat 2 works immediately. Best-effort: a missing dotnet just prints a note and
    the tools build lazily on first use instead.
    """
    builder = repo_root / "scripts" / "qa_codegraph_build.py"
    if not builder.exists():
        return
    try:
        out = subprocess.run(
            [sys.executable, str(builder)],
            capture_output=True, text=True, timeout=900, check=False,
        )
        print(f"  Code-graph tools: {out.stdout.strip() or out.stderr.strip()[:200]}")
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"  (code-graph tools will build on first use — {exc})")


def main() -> None:
    src = Path(__file__).parent.resolve()
    dst = Path.home() / ".copilot" / "skills" / "flt-pr-scenario-validator"
    dst.parent.mkdir(parents=True, exist_ok=True)
    _clear(dst)
    try:
        os.symlink(src, dst, target_is_directory=True)
        print(f"  Linked {dst} -> {src}")
    except OSError:
        shutil.copytree(src, dst)
        print(f"  Copied {src} -> {dst}")
        print("  (copy will not auto-update; re-run install.py after changing the skill)")

    # The skill's qa_* primitives + Roslyn tools live in the edog-studio repo
    # (scripts/). Build the code-graph tools so Beat 2 is ready out of the box.
    # src = <repo>/skills/flt-pr-scenario-validator -> parents[1] is the repo root.
    repo_root = src.parents[1]
    _build_codegraph_tools(repo_root)


if __name__ == "__main__":
    main()
