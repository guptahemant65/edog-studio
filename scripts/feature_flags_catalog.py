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

from feature_manager_cache import FeatureManagementCache, build_per_env_cells

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

# Default home ring used when edog-config.json doesn't override. EDOG Studio
# typically runs against the test ring (`*.ccsctp.net` aka PPE), so 'test' is
# the safe default. Override with edog-config.json :: ``edog_env``.
DEFAULT_HOME_ENV = "test"
# Back-compat alias — some callers still import HOME_ENV. Kept as the default.
HOME_ENV = DEFAULT_HOME_ENV


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


def _empty_per_env() -> dict[str, Any]:
    """Generate ``perEnv`` placeholder when FM cache is unavailable.

    All cells map to ``missing`` so the UI renders the row as
    ``missing in FM`` until FM enrichment completes.
    """
    return {env: {"state": "missing"} for env in ALL_ENVS}


def build_catalog(
    flt_repo: Path,
    *,
    workspace_id: str | None = None,
    capacity_id: str | None = None,
    tenant_id: str | None = None,
    fm_cache: FeatureManagementCache | None = None,
    overrides_snapshot: dict[str, bool] | None = None,
    home_env: str | None = None,
) -> dict[str, Any]:
    """Build the full ``GET /api/edog/feature-flags/catalog`` response.

    Args:
        flt_repo: Path to the FLT git clone.
        workspace_id, capacity_id, tenant_id: Identifiers for ``myWsTargeted``
            evaluation. When None, partial cells render with ``includesMyWorkspace``
            False and the row's ``myWsTargeted`` is False.
        fm_cache: Optional :class:`FeatureManagementCache`. When None or not yet
            synced, every row's cells are ``missing`` and ``fm.stale = true``.
        overrides_snapshot: Current force-ON map. Used to mark rows as
            ``isOverridden``.
        home_env: Environment whose per-env state determines ``locked`` and
            ``effectiveForMyWorkspace``. Falls back to :data:`DEFAULT_HOME_ENV`
            (``test``) when not provided or unknown to :data:`ALL_ENVS`.

    Returns:
        Dict matching :class:`FeatureFlagsCatalogResponse` from C03 spec §3.1.
    """
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    flags = parse_feature_names(flt_repo)

    if home_env not in ALL_ENVS:
        home_env = DEFAULT_HOME_ENV

    fm_block: dict[str, Any]
    fm_synced = False
    if fm_cache is None:
        fm_block = {
            "repoUrl": "https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement",
            "branch": "master",
            "syncedAt": None,
            "cacheAgeSeconds": None,
            "stale": True,
            "syncInProgress": False,
            "error": "FM cache disabled",
            "indexedCount": 0,
        }
    else:
        fm_block = fm_cache.status()
        fm_synced = fm_block.get("syncedAt") is not None

    overrides_snapshot = overrides_snapshot or {}

    rows: list[dict[str, Any]] = []
    for entry in flags:
        name = entry["name"]
        wire_key = entry["wireKey"]
        summary = entry["summary"]

        fm_doc = fm_cache.get(wire_key) if (fm_cache and fm_synced) else None

        if fm_doc is None:
            per_env = _empty_per_env()
            my_ws_targeted = False
            missing_reason: str | None = "missing-in-fm" if fm_synced else "stale-cache"
            fm_description = None
            classification = "Behavioral"
        else:
            per_env, my_ws_targeted = build_per_env_cells(
                fm_doc,
                env_keys=ALL_ENVS,
                tenant_id=tenant_id,
                capacity_id=capacity_id,
                workspace_id=workspace_id,
            )
            missing_reason = None
            fm_description = fm_doc.get("Description")
            classification = _classify_flag(fm_doc)

        home_cell = per_env.get(home_env, {"state": "missing"})
        home_state = home_cell.get("state", "missing")
        if home_state == "on":
            effective = True
            locked = True
        elif home_state == "partial":
            effective = bool(home_cell.get("includesMyWorkspace"))
            locked = effective
        else:
            effective = False
            locked = False

        is_overridden = wire_key in overrides_snapshot
        # Force-ON overrides flip the effective value to True regardless of
        # underlying state (asymmetric model — V1 only supports force-ON).
        if is_overridden and overrides_snapshot.get(wire_key) is True:
            effective = True

        rows.append(
            {
                "name": name,
                "wireKey": wire_key,
                "summary": summary or (fm_description or ""),
                "fmDescription": fm_description,
                "classification": classification,
                "cachedAtStartup": False,
                "observationClass": "unobserved",
                "perEnv": per_env,
                "myWsTargeted": my_ws_targeted,
                "effectiveForMyWorkspace": effective,
                "locked": locked,
                "missingReason": missing_reason,
                "isOverridden": is_overridden,
                "overrideValue": overrides_snapshot.get(wire_key),
            }
        )

    return {
        "generatedAt": generated_at,
        "fltRepoPath": str(flt_repo),
        "fm": fm_block,
        "workspace": {
            "tenantId": tenant_id,
            "capacityId": capacity_id,
            "workspaceId": workspace_id,
            "homeEnv": home_env,
            "mainlineEnvs": list(MAINLINE_ENVS),
            "sovereignEnvs": list(SOVEREIGN_ENVS),
        },
        "rows": rows,
        "rowCount": len(rows),
    }


def _classify_flag(fm_doc: dict[str, Any]) -> str:
    """Best-effort classification (Behavioral vs Cached-at-startup).

    The FM JSON sometimes has a top-level ``Tags`` / ``Category`` block; when
    absent, default to ``Behavioral``. V1 is permissive — UI doesn't make
    correctness decisions on classification.
    """
    tags = fm_doc.get("Tags")
    if isinstance(tags, list):
        for tag in tags:
            if isinstance(tag, str) and "cache" in tag.lower():
                return "Cached"
    category = fm_doc.get("Category")
    if isinstance(category, str) and "cache" in category.lower():
        return "Cached"
    return "Behavioral"


__all__ = [
    "ALL_ENVS",
    "DEFAULT_HOME_ENV",
    "HOME_ENV",
    "MAINLINE_ENVS",
    "SOVEREIGN_ENVS",
    "build_catalog",
    "parse_feature_names",
]
