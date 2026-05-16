"""Feature-flag catalog (dev-server side).

Parses the FLT repo's ``FeatureNames.cs`` and emits the row set consumed by
Card 3 (Feature Flags) of the Environment Panel. FM-cache enrichment (per-env
shape, target groups, lock evaluation) is wired but degrades gracefully when
the FM cache is unavailable — rows still render with cell state ``missing``
and the catalog response surfaces ``fm.stale = true`` + ``fm.error``.

Sources of truth
----------------
- ``Service\\Microsoft.LiveTable.Service\\FeatureFlightProvider\\FeatureNames.cs``
  for declared flags. Regex: ``public const string (\\w+) = "([^"]+)"``.
- ``FeatureManagement`` git clone (per architecture §4) for per-env JSON shapes.
  Path: ``Features/Configuration/Features/{wireKey}.json``.

Per F11 spec §2.4, this module never hard-codes the flag list. The current
declaration in FLT is authoritative.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Wire-key regex captures the FLT C# const declarations.
# Tolerates leading whitespace, comments after the line, and string content
# containing any non-quote character.
_CONST_RE = re.compile(
    r'^\s*public\s+const\s+string\s+(?P<name>\w+)\s*=\s*"(?P<wire>[^"]+)"',
    re.MULTILINE,
)

# XML doc-comment regex for the immediately preceding ``<summary>`` block.
# FLT consistently uses StyleCop-style multi-line ``///`` summaries.
_SUMMARY_RE = re.compile(
    r"///\s*<summary>\s*(?P<body>.*?)\s*///\s*</summary>",
    re.DOTALL,
)

# Mainline rings rendered as separate columns. The folded "Sovereign(8)"
# column rolls up the remainder. Order matters — UI uses index for column slot.
MAINLINE_ENVS: tuple[str, ...] = (
    "onebox",
    "test",
    "daily",
    "cst",
    "dxt",
    "msit",
    "prod",
)
SOVEREIGN_ENVS: tuple[str, ...] = (
    "mc",
    "gcc",
    "gcchigh",
    "dod",
    "usnat",
    "ussec",
    "bleu",
    "usgovcanary",
)
ALL_ENVS: tuple[str, ...] = MAINLINE_ENVS + SOVEREIGN_ENVS

# Home ring for lock evaluation. CST is the canonical V1 choice (spec §2.1).
HOME_ENV = "cst"


def _find_feature_names_file(flt_repo: Path) -> Path | None:
    """Locate ``FeatureNames.cs`` inside an FLT repo clone."""
    candidate = flt_repo / "Service" / "Microsoft.LiveTable.Service" / "FeatureFlightProvider" / "FeatureNames.cs"
    if candidate.exists():
        return candidate
    # Fallback: recursive search (slow but defensive).
    for path in flt_repo.rglob("FeatureNames.cs"):
        return path
    return None


def _extract_summary(source: str, decl_pos: int) -> str:
    """Return the trimmed text of the ``<summary>`` immediately preceding
    ``decl_pos`` in ``source``, or an empty string when none is found."""
    head = source[:decl_pos]
    matches = list(_SUMMARY_RE.finditer(head))
    if not matches:
        return ""
    body = matches[-1].group("body")
    # Strip ``/// `` line prefixes and collapse whitespace.
    lines = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            stripped = stripped[3:].strip()
        if stripped:
            lines.append(stripped)
    return " ".join(lines)


def parse_feature_names(flt_repo: Path) -> list[dict[str, Any]]:
    """Parse ``FeatureNames.cs`` and return one entry per declared flag.

    Each entry has ``name`` (C# const identifier), ``wireKey`` (string literal),
    and ``summary`` (XML doc text, possibly empty). Order matches source.

    Raises:
        FileNotFoundError: when ``FeatureNames.cs`` can't be found in the repo.
    """
    src_path = _find_feature_names_file(flt_repo)
    if src_path is None:
        raise FileNotFoundError(f"FeatureNames.cs not found under {flt_repo}; is flt_repo_path configured correctly?")
    source = src_path.read_text(encoding="utf-8")
    entries: list[dict[str, Any]] = []
    for match in _CONST_RE.finditer(source):
        name = match.group("name")
        wire = match.group("wire")
        summary = _extract_summary(source, match.start())
        entries.append({"name": name, "wireKey": wire, "summary": summary})
    return entries


def _empty_per_env(missing_reason: str = "stale-cache") -> dict[str, Any]:
    """Generate ``perEnv`` placeholder when FM cache is unavailable.

    All cells map to ``missing`` so the UI renders the row as
    ``override-staged-unobserved`` until FM enrichment lands.
    """
    return {env: {"state": "missing"} for env in ALL_ENVS}


def build_catalog(
    flt_repo: Path,
    *,
    workspace_id: str | None = None,
    capacity_id: str | None = None,
    tenant_id: str | None = None,
    fm_cache_dir: Path | None = None,
    overrides_snapshot: dict[str, bool] | None = None,
) -> dict[str, Any]:
    """Build the full ``GET /api/edog/feature-flags/catalog`` response.

    FM cache enrichment is deferred — when ``fm_cache_dir`` is None or the
    directory is missing, ``fm.stale = true`` and per-env cells default to
    ``missing``. Rows still render with declared name + wireKey + summary.

    Args:
        flt_repo: Path to the FLT git clone.
        workspace_id, capacity_id, tenant_id: Identifiers for ``myWsTargeted``
            evaluation. When None, target membership is treated as unknown and
            the row's ``myWsTargeted`` is False.
        fm_cache_dir: Local clone of the FeatureManagement repo. None disables
            FM enrichment (catalog still returns 200 with ``stale=true``).
        overrides_snapshot: Current force-ON map. Used for ``observationClass``
            seeding — overridden flags start at ``unknown`` until the wrapper
            stream confirms ``live`` or ``cached``.

    Returns:
        Dict matching :class:`FeatureFlagsCatalogResponse` from C03 spec §3.1.
    """
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    flags = parse_feature_names(flt_repo)

    fm_stale = True
    fm_error: str | None = "FM cache not yet implemented (Phase 2.1 follow-up)"
    fm_synced_at: str | None = None
    fm_age: int | None = None
    if fm_cache_dir is not None and fm_cache_dir.is_dir():
        # Placeholder — full enrichment lands in a follow-up commit.
        # For now we only note that the directory exists, so a future
        # implementation has a hint that the cache is there.
        fm_stale = True
        fm_error = "FM enrichment not implemented; using declared-only rows"

    overrides_snapshot = overrides_snapshot or {}

    rows: list[dict[str, Any]] = []
    for entry in flags:
        name = entry["name"]
        wire_key = entry["wireKey"]
        summary = entry["summary"]
        per_env = _empty_per_env()
        is_overridden = wire_key in overrides_snapshot
        rows.append(
            {
                "name": name,
                "wireKey": wire_key,
                "summary": summary,
                # Classification heuristic deferred — default "Behavioral".
                "classification": "Behavioral",
                "cachedAtStartup": False,
                # `observationClass`: dev-server tracks this via the wrapper
                # event stream (Phase 3 work). Default unknown.
                "observationClass": "unknown",
                "perEnv": per_env,
                "myWsTargeted": False,
                "effectiveForMyWorkspace": False,
                "locked": False,
                "missingReason": "stale-cache" if fm_stale else None,
                "isOverridden": is_overridden,
            }
        )

    return {
        "generatedAt": generated_at,
        "fltRepoPath": str(flt_repo),
        "fm": {
            "repoUrl": "https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement",
            "branch": "master",
            "syncedAt": fm_synced_at,
            "cacheAgeSeconds": fm_age,
            "stale": fm_stale,
            "error": fm_error,
        },
        "workspace": {
            "tenantId": tenant_id,
            "capacityId": capacity_id,
            "workspaceId": workspace_id,
            "homeEnv": HOME_ENV,
        },
        "rows": rows,
        "rowCount": len(rows),
    }


__all__ = [
    "ALL_ENVS",
    "HOME_ENV",
    "MAINLINE_ENVS",
    "SOVEREIGN_ENVS",
    "build_catalog",
    "parse_feature_names",
]
