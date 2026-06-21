"""Beat 2 flag tool: WHICH flags gate the changed code, and their REAL EDOG state.

The skill kept conflating two different questions and guessing both:

  1. WHICH flags gate the changed code?  -> a CODE question. Answered by the
     Roslyn ``FlagGateTracer`` (walks from a changed symbol up to its enclosing
     ``IsEnabled(FeatureNames.X)`` guard). The guard often lives on an UNCHANGED
     context line in the CALLER, so reading the diff alone misses it.

  2. What is each flag's REAL state?      -> a DATA question. Read from the FM
     repo cache, never from memory. **EDOG == the FM ``test`` environment**
     (user-confirmed 2026-06-21), so a flag's EDOG default is its ``test`` entry,
     classified with the same ``classify_env`` the rest of EDOG uses.

Server-free: this runs in Beat 2, before any FLT server is up. The authoritative
effective state (overrides + workspace targeting) is confirmed from the live
catalog in Beat 5 before any flag is flipped.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

try:  # dev-server runs with scripts/ on sys.path; tests import as a package
    from feature_manager_cache import classify_env  # DRY: identical on/off/partial semantics
except ModuleNotFoundError:  # pragma: no cover - import-context shim
    from scripts.feature_manager_cache import classify_env

#: EDOG runs against the FM ``test`` environment (user-confirmed 2026-06-21).
#: A flag's EDOG default is therefore its ``test`` entry in the FM JSON.
EDOG_ENV = "test"

PROJECT_DIR = Path(__file__).parent.parent
_TRACER_DLL = (
    PROJECT_DIR / "scripts" / "qa_codegraph" / "ChangeScanner"
    / "bin" / "Release" / "net9.0" / "ChangeScanner.dll"
)
_FM_CACHE = Path.home() / ".edog-cache" / "feature-management"


# ── the CODE question: which flags gate the changed symbols ────────────────

def run_tracer(files: list[str], symbols: list[str], *, dll: Path = _TRACER_DLL) -> dict:
    """Run the Roslyn tracer over ``files`` for ``symbols``.

    Returns the parsed JSON with an ``available`` flag. When the tracer isn't
    built or fails, returns ``available: False`` with a reason -- an honest
    degraded result, never a fabricated answer.
    """
    if not dll.exists():
        return {"available": False, "reason": "tracer not built (run dotnet build)",
                "filesScanned": 0, "sites": []}
    if not files or not symbols:
        return {"available": True, "filesScanned": 0, "sites": []}
    try:
        proc = subprocess.run(
            ["dotnet", str(dll), "--files", ";".join(files), "--symbols", ",".join(symbols)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "reason": str(exc)[:200], "filesScanned": 0, "sites": []}
    if proc.returncode != 0:
        return {"available": False, "reason": (proc.stderr or "tracer failed").strip()[:200],
                "filesScanned": 0, "sites": []}
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"available": False, "reason": "tracer emitted non-JSON", "filesScanned": 0, "sites": []}
    data["available"] = True
    return data


def gating_flags(tracer_out: dict) -> dict[str, list[dict]]:
    """Map each gating flag -> the changed-code sites that prove it gates them."""
    out: dict[str, list[dict]] = {}
    for site in tracer_out.get("sites", []):
        for g in site.get("gatedBy", []):
            out.setdefault(g["flag"], []).append({
                "symbol": site["symbol"],
                "file": Path(site["file"]).name,
                "line": site["line"],
                "via": g["via"],
            })
    return out


# ── the DATA question: the flag's REAL EDOG state ──────────────────────────

def _find_flag_json(wire_key: str, *, fm_cache: Path = _FM_CACHE) -> dict | None:
    """Find a flag's FM JSON by its ``Id`` (not its filename).

    Fast name-glob first -- covers the common ``<Id>.json`` case. Verifies the
    ``Id`` field matches (filenames can differ from Ids in the FM repo). Returns
    None rather than running a slow full-tree content scan; the rare
    filename!=Id case defers to the authoritative Beat-5 catalog.
    """
    features = fm_cache / "Features"
    if not features.is_dir():
        return None
    for path in features.rglob(f"{wire_key}.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("Id") == wire_key:
            return data
    return None


def edog_state(wire_key: str, *, env: str = EDOG_ENV, fm_cache: Path = _FM_CACHE) -> dict:
    """Resolve a flag's REAL default state for EDOG (the FM ``test`` env).

    ``state`` is one of ``on`` / ``off`` / ``empty`` / ``partial`` / ``unknown``.
    ``partial`` (Targets/Requires) means it depends on the workspace -> must be
    confirmed live in Beat 5.
    """
    data = _find_flag_json(wire_key, fm_cache=fm_cache)
    if data is None:
        return {"found": False, "state": "unknown", "env": env, "perEnv": {},
                "note": "flag file not found by Id in the FM cache; confirm live in Beat 5"}
    envs = data.get("Environments") or {}
    per_env = {e: classify_env(v) for e, v in envs.items()}
    state = per_env.get(env, "empty")
    note = "depends on the workspace (targeted rollout) — confirm live in Beat 5" if state == "partial" else ""
    return {"found": True, "state": state, "env": env, "perEnv": per_env,
            "description": data.get("Description", ""), "note": note}


def new_flags_in_diff(parsed_diff: dict) -> list[str]:
    """Flags introduced by this PR (added, not merely referenced)."""
    return list(parsed_diff.get("feature_flags_added", []))


# ── the consolidated Beat-2 flag picture ───────────────────────────────────

def build_picture(tracer_out: dict, parsed_diff: dict, *,
                  env: str = EDOG_ENV, fm_cache: Path = _FM_CACHE) -> dict:
    """Combine: which flags gate the change, which are new, and their EDOG state."""
    gates = gating_flags(tracer_out)
    new = set(new_flags_in_diff(parsed_diff))
    flags = []
    for flag in sorted(set(gates) | new):
        st = edog_state(flag, env=env, fm_cache=fm_cache)
        flags.append({
            "flag": flag,
            "gatesChangedCode": flag in gates,
            "sites": gates.get(flag, []),
            "newInPr": flag in new,
            "edogState": st["state"],
            "stateFound": st["found"],
            "perEnv": st["perEnv"],
            "note": st.get("note", ""),
        })
    return {
        "tracerAvailable": tracer_out.get("available", False),
        "filesScanned": tracer_out.get("filesScanned", 0),
        "edogEnv": env,
        "flags": flags,
        "caveat": (
            "EDOG state shown is the FM-repo default for the test environment. "
            "Overrides + workspace targeting are confirmed live from the catalog in Beat 5 "
            "before any flag is flipped. Manifest/rule-level gating (e.g. ParametersManifest keys) "
            "is not checked here."
        ),
    }


# ── thin I/O helper + CLI (for the demo / skill invocation) ────────────────

def candidate_files(repo: str, symbols: list[str], *, ref: str | None = None) -> list[str]:
    """Use ``git grep`` to find files in the FLT repo that reference any symbol
    (so the trace covers use-sites in UNCHANGED files, not only the diff)."""
    if not symbols:
        return []
    cmd = ["git", "-C", repo, "--no-pager", "grep", "-l", "-E", "|".join(symbols)]
    if ref:
        cmd.append(ref)
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    files = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        # git grep with a ref prefixes "ref:path"; strip it back to a repo path
        path = line.split(":", 1)[1] if ref and line.startswith(f"{ref}:") else line
        if path.endswith(".cs"):
            files.append(str(Path(repo) / path))
    return files


def _main() -> int:
    import argparse

    try:
        from qa_io import ensure_utf8
    except ModuleNotFoundError:
        from scripts.qa_io import ensure_utf8
    ensure_utf8()

    ap = argparse.ArgumentParser(description="Beat 2 flag tool: gating flags + real EDOG state")
    ap.add_argument("--files", default="", help="semicolon-separated .cs files to scan")
    ap.add_argument("--symbols", default="", help="comma-separated changed symbols")
    ap.add_argument("--added-flags", default="", help="comma-separated flags newly added in the PR")
    args = ap.parse_args()

    files = [f for f in args.files.split(";") if f]
    symbols = [s for s in args.symbols.split(",") if s]
    added = [f for f in args.added_flags.split(",") if f]

    tracer = run_tracer(files, symbols)
    picture = build_picture(tracer, {"feature_flags_added": added})
    print(json.dumps(picture, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
