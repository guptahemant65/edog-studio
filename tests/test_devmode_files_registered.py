"""Guardrail: every C# file in src/backend/DevMode/ must be registered in
edog.py's DEVMODE_FILES dict, or the deploy pipeline silently skips it
and FLT fails to compile with "name does not exist in current context"
errors (CS0103).

This caught the Phase 1 → Phase 2c regression: EdogInterceptorRegistry.cs
was created in commit ff170f5 but never added to DEVMODE_FILES, so the
Phase 2c Record() calls failed to compile on first deploy.
"""

import importlib.util
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
EDOG_PY = PROJECT_DIR / "edog.py"
DEVMODE_SRC_DIR = PROJECT_DIR / "src" / "backend" / "DevMode"


def _load_edog():
    spec = importlib.util.spec_from_file_location("edog_devmode_files", EDOG_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(EDOG_PY.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


def test_every_devmode_cs_file_is_registered_for_deploy():
    """Each .cs file in src/backend/DevMode/ must appear in DEVMODE_FILES.

    Build failure mode if a file is missing:
        error CS0103: The name 'X' does not exist in the current context

    because the type is referenced by other DevMode files that DO get
    deployed but the type's defining file does not.
    """
    edog = _load_edog()

    on_disk = {p.name for p in DEVMODE_SRC_DIR.glob("*.cs")}
    listed = {Path(p).name for p in edog.DEVMODE_FILES.values() if str(p).endswith(".cs")}

    missing = on_disk - listed
    assert not missing, (
        "src/backend/DevMode/ contains C# files not registered in "
        "edog.py DEVMODE_FILES — they will NOT be deployed to FLT and "
        "any reference to types in them will fail to compile:\n  " + "\n  ".join(sorted(missing))
    )


def test_devmode_files_dict_points_at_existing_sources():
    """Every DEVMODE_FILES entry must have a matching source file under
    either src/backend/DevMode/ (primary) or src/ (fallback, used by
    apply_log_viewer_files in edog.py:1693-1701). Otherwise the deploy
    step prints a warning and silently skips the file."""
    edog = _load_edog()
    src_fallback = PROJECT_DIR / "src"

    missing_sources = []
    for name, rel_path in edog.DEVMODE_FILES.items():
        basename = Path(rel_path).name
        primary = DEVMODE_SRC_DIR / basename
        fallback = src_fallback / basename
        if not primary.exists() and not fallback.exists():
            missing_sources.append(f"{name} -> neither {primary} nor {fallback}")

    assert not missing_sources, (
        "DEVMODE_FILES references source files that exist in neither "
        "src/backend/DevMode/ nor src/:\n  " + "\n  ".join(missing_sources)
    )
