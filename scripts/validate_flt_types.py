"""Validate that FLT interface types referenced by EDOG DevMode interceptors
still exist in the FLT repository source code.

Scans C# files under the FLT repo for ``interface IFoo`` declarations and
checks them against ``data/flt-type-manifest.json``. Fails with a clear
report if any referenced type is missing — catching renames/removals at
build time rather than at runtime.

Usage:
    python scripts/validate_flt_types.py              # uses edog-config.json
    python scripts/validate_flt_types.py /path/to/flt  # explicit repo path
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MANIFEST_PATH = Path(__file__).parent.parent / "data" / "flt-type-manifest.json"

# Matches: "interface IFoo" or "class TokenManager" (public/internal/etc)
_TYPE_DECL_RE = re.compile(
    r"(?:public|internal|private|protected)?\s*(?:sealed\s+|abstract\s+|static\s+|partial\s+)*"
    r"(?:interface|class)\s+(?P<name>\w+)",
    re.MULTILINE,
)


def _load_config() -> Path | None:
    """Try to resolve flt_repo_path from edog-config.json."""
    config_file = Path(__file__).parent.parent / "edog-config.json"
    if not config_file.exists():
        return None
    try:
        data = json.loads(config_file.read_text(encoding="utf-8"))
        raw = data.get("flt_repo_path", "")
        if raw:
            return Path(raw)
    except (json.JSONDecodeError, KeyError):
        pass
    return None


def _scan_declared_types(flt_repo: Path) -> set[str]:
    """Scan all .cs files under the FLT repo and return declared type short names."""
    declared: set[str] = set()
    service_root = flt_repo / "Service"
    search_root = service_root if service_root.is_dir() else flt_repo
    for cs_file in search_root.rglob("*.cs"):
        try:
            content = cs_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in _TYPE_DECL_RE.finditer(content):
            declared.add(match.group("name"))
    return declared


def validate(flt_repo: Path) -> list[dict[str, str]]:
    """Validate manifest types against FLT repo. Returns list of missing types."""
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    declared = _scan_declared_types(flt_repo)

    missing: list[dict[str, str]] = []

    # Prefixes that indicate platform NuGet packages, not FLT source types
    _EXTERNAL_PREFIXES = (
        "System.",
        "Microsoft.PowerBI.ServicePlatform.",
        "Microsoft.ServicePlatform.",
        "Microsoft.MWC.",
        "Microsoft.Extensions.",
    )

    for entry in manifest.get("interceptors", []):
        short = entry["shortName"]
        flt_type = entry["fltInterface"]
        if entry.get("external"):
            continue
        if any(flt_type.startswith(p) for p in _EXTERNAL_PREFIXES):
            continue
        if short not in declared:
            missing.append(
                {
                    "interceptor": entry["name"],
                    "type": flt_type,
                    "shortName": short,
                }
            )

    for entry in manifest.get("additionalDependencies", []):
        short = entry["shortName"]
        flt_type = entry.get("fltType", entry.get("fltInterface", ""))
        if entry.get("external"):
            continue
        if any(flt_type.startswith(p) for p in _EXTERNAL_PREFIXES):
            continue
        if short not in declared:
            missing.append(
                {
                    "dependency": entry["name"],
                    "type": flt_type,
                    "shortName": short,
                }
            )

    return missing


def main() -> int:
    # Resolve FLT repo path
    flt_repo = Path(sys.argv[1]) if len(sys.argv) > 1 else _load_config()

    if flt_repo is None or not flt_repo.is_dir():
        print("SKIP: FLT repo not configured or not found — cannot validate types")
        print("  Set flt_repo_path in edog-config.json or pass as argument")
        return 0  # non-fatal skip

    print(f"Validating FLT types against: {flt_repo}")

    missing = validate(flt_repo)

    if not missing:
        print(
            f"OK: All {len(json.loads(MANIFEST_PATH.read_text(encoding='utf-8')).get('interceptors', []))} interceptor types found in FLT repo"
        )
        return 0

    print(f"\nFAILED: {len(missing)} type(s) not found in FLT repo:\n")
    for item in missing:
        label = item.get("interceptor") or item.get("dependency", "?")
        print(f"  {label}")
        print(f"    Type:  {item['type']}")
        print(f"    Short: {item['shortName']}")
        print("    → FLT may have renamed or removed this interface.\n")

    print("Fix: Update data/flt-type-manifest.json and the corresponding")
    print("     EdogDevModeRegistrar.cs / EdogInterceptorRegistry.cs references.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
