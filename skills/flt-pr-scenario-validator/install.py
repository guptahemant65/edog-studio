"""Install this repo skill into user-global ~/.copilot/skills/.

Prefers a symlink so the installed skill stays in sync with the repo (and its
``scripts/qa_*`` primitive dependencies). Falls back to a directory copy on
platforms/accounts where symlink creation is not permitted (e.g. Windows
without Developer Mode), printing a note that a copy will not auto-update.
"""

from __future__ import annotations

import os
import shutil
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


if __name__ == "__main__":
    main()
