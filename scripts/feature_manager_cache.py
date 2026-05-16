"""FeatureManagement (FMv2) cache and per-flag resolver.

Maintains a local clone of ``https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement``
under ``~/.edog-cache/feature-management/`` and indexes per-flag JSON for Card 3.

Sync strategy (per F11/research/p0-foundation.md §2):
    First-time bootstrap:
        git clone --depth=1 --filter=blob:none --sparse <url> <dir>
        git -C <dir> sparse-checkout set Features
    Refresh (TTL 1h):
        git -C <dir> fetch origin master --depth=1
        git -C <dir> reset --hard origin/master

The sync runs on a daemon thread the first time the catalog is requested. The
catalog endpoint returns ``stale=true`` while the sync is in progress, so the
UI can render rows with declared-only data and re-fetch when complete.

Indexing:
    Walks ``Features/**/*.json`` once after each successful sync. Each JSON has
    an ``Id`` key — that is the wire key the FLT FeatureFlighter consults.
    Some flags' files are named after their Id (``EnableFMLVQMAPartitionPruning.json``),
    some are named differently (``FLTIRQMAPartitionPruningEnabled.json`` even
    though the Id is ``EnableFMLVQMAPartitionPruning``). We trust the ``Id``
    field, not the filename.

Per-env cell shapes (from the FM JSON ``Environments`` block):
    {}                          → ``empty``  (cell glyph: em-dash)
    { "Enabled": true }         → ``on``     (cell glyph: ✓)
    { "Enabled": false }        → ``off``    (cell glyph: ✗)
    { "Targets": [...] }        → ``partial`` (cell glyph: ◐)
    (flag declared but not in FM) → ``missing`` (rendered with badge)
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

FM_REPO_URL = "https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement"
FM_REPO_BRANCH = "master"
TTL_SECONDS = 3600  # 1 hour
SYNC_TIMEOUT_SECONDS = 300  # bounded — clone of ~15 MB is ~10s locally, slower on first init.

# Pivots we can evaluate without external context. ``RegionName`` and
# ``MemberOf`` are V1-out (we don't ship a region inference or group lookup).
_EVALUABLE_PIVOTS = ("TenantObjectId", "CapacityObjectId", "WorkspaceObjectId")


def _default_cache_dir() -> Path:
    """Return ``~/.edog-cache/feature-management``."""
    home = Path(os.path.expanduser("~"))
    return home / ".edog-cache" / "feature-management"


class FeatureManagementCache:
    """Owns the local FM clone and the parsed flag index.

    Thread-safe: a single ``_lock`` guards mutation of ``_index``,
    ``_synced_at``, and ``_last_error``. Reads after lock-release see a stable
    dict reference (assignment in Python is atomic).

    Lifecycle:
        - ``ensure_synced()`` — non-blocking; kicks off background sync if not
          already running and either no sync has succeeded yet OR the TTL has
          expired.
        - ``get(wire_key)`` — returns the parsed FM JSON for ``wire_key`` or
          None. Lock-free read (dict reference is replaced atomically).
        - ``status()`` — dict for the catalog response.
    """

    def __init__(
        self,
        cache_dir: Path | None = None,
        ttl_seconds: int = TTL_SECONDS,
    ) -> None:
        self._cache_dir = cache_dir or _default_cache_dir()
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._index: dict[str, dict[str, Any]] = {}
        self._synced_at: float | None = None
        self._last_error: str | None = None
        self._sync_in_progress = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """Return a UI-friendly dict for the catalog's ``fm`` block."""
        with self._lock:
            synced_at = self._synced_at
            error = self._last_error
            in_progress = self._sync_in_progress
            count = len(self._index)
        if synced_at is None:
            stale = True
            age = None
            synced_iso = None
        else:
            now = time.time()
            age = int(now - synced_at)
            stale = age > self._ttl_seconds
            synced_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(synced_at))
        return {
            "repoUrl": FM_REPO_URL,
            "branch": FM_REPO_BRANCH,
            "syncedAt": synced_iso,
            "cacheAgeSeconds": age,
            "stale": stale,
            "syncInProgress": in_progress,
            "error": error,
            "indexedCount": count,
        }

    def get(self, wire_key: str) -> dict[str, Any] | None:
        """Return the FM JSON dict for ``wire_key`` or None when missing."""
        if not wire_key:
            return None
        # Index assignment is atomic; reading via local reference is safe.
        return self._index.get(wire_key)

    def ensure_synced(self, force: bool = False) -> bool:
        """Kick off a background sync if needed. Returns True iff a sync was
        started by this call."""
        with self._lock:
            if self._sync_in_progress:
                return False
            now = time.time()
            if not force and self._synced_at is not None and (now - self._synced_at) < self._ttl_seconds:
                return False
            self._sync_in_progress = True
        thread = threading.Thread(
            target=self._sync_worker,
            name="fm-cache-sync",
            daemon=True,
        )
        thread.start()
        return True

    # ------------------------------------------------------------------
    # Sync worker (runs on a daemon thread)
    # ------------------------------------------------------------------

    def _sync_worker(self) -> None:
        try:
            self._do_sync()
        except Exception as e:
            logger.exception("FM cache sync failed")
            with self._lock:
                self._last_error = f"{type(e).__name__}: {e}"
        finally:
            with self._lock:
                self._sync_in_progress = False

    def _do_sync(self) -> None:
        repo_dir = self._cache_dir
        repo_dir.parent.mkdir(parents=True, exist_ok=True)

        if not (repo_dir / ".git").is_dir():
            logger.info("FM cache: cloning %s -> %s", FM_REPO_URL, repo_dir)
            # Plain depth=1 clone: the repo is ~15 MB. We deliberately AVOID
            # ``--filter=blob:none`` here — partial-clone defers blob fetches
            # until first read, which then thrashes the network when the
            # indexer reads 13K JSONs synchronously.
            self._run_git(
                [
                    "git",
                    "clone",
                    "--depth=1",
                    f"--branch={FM_REPO_BRANCH}",
                    "--single-branch",
                    FM_REPO_URL,
                    str(repo_dir),
                ],
                cwd=str(repo_dir.parent),
            )
        else:
            logger.info("FM cache: refreshing %s", repo_dir)
            self._run_git(
                ["git", "fetch", "origin", FM_REPO_BRANCH, "--depth=1"],
                cwd=str(repo_dir),
            )
            self._run_git(
                ["git", "reset", "--hard", f"origin/{FM_REPO_BRANCH}"],
                cwd=str(repo_dir),
            )

        index = self._build_index(repo_dir)

        with self._lock:
            self._index = index
            self._synced_at = time.time()
            self._last_error = None
        logger.info("FM cache: indexed %d flag definitions", len(index))

    def _run_git(self, cmd: list[str], cwd: str) -> None:
        """Run a git command with bounded timeout, raising on non-zero exit."""
        try:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=SYNC_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"git timed out after {SYNC_TIMEOUT_SECONDS}s: {' '.join(cmd)}") from e
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()[:500]
            raise RuntimeError(f"git failed (exit {result.returncode}): {' '.join(cmd)} :: {stderr}")

    def _build_index(self, repo_dir: Path) -> dict[str, dict[str, Any]]:
        features_dir = repo_dir / "Features"
        if not features_dir.is_dir():
            raise RuntimeError(f"Features/ directory missing in FM cache at {repo_dir}")
        index: dict[str, dict[str, Any]] = {}
        for path in features_dir.rglob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            wire_key = data.get("Id")
            if isinstance(wire_key, str) and wire_key:
                index[wire_key] = data
        return index


# ----------------------------------------------------------------------
# Per-cell evaluation helpers
# ----------------------------------------------------------------------


def classify_env(env_value: Any) -> str:
    """Map a per-env JSON value to ``EnvState``.

    Per spec §2.1:
        {}                      → 'empty'
        { Enabled: true }       → 'on'
        { Enabled: false }      → 'off'
        { Targets: [...] }      → 'partial'
        anything else           → 'empty'  (defensive)
    """
    if not isinstance(env_value, dict) or not env_value:
        return "empty"
    if "Enabled" in env_value and isinstance(env_value["Enabled"], bool):
        return "on" if env_value["Enabled"] else "off"
    if env_value.get("Targets"):
        return "partial"
    return "empty"


def _iter_target_entries(env_value: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield ``(group_name, entry_dict)`` pairs across both real and legacy
    ``Targets`` shapes.

    Real FM shape (observed in repo)::

        "Targets": {
            "PublicRollout": [{"Name": "PowerBI.MemberOf",
                               "Parameters": {"Pivot": "RegionName",
                                              "Values": ["UK South"]}}],
            "RunnerTenants": [...]
        }

    Legacy/defensive shape::

        "Targets": [{"Name": ..., "Pivot": ..., "Values": [...]}]
    """
    if not isinstance(env_value, dict):
        return
    targets = env_value.get("Targets")
    if isinstance(targets, dict):
        for group_name, entries in targets.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict):
                    yield (str(group_name), entry)
    elif isinstance(targets, list):
        for entry in targets:
            if isinstance(entry, dict):
                yield ("", entry)


def _entry_pivot(entry: dict[str, Any]) -> str:
    params = entry.get("Parameters") if isinstance(entry.get("Parameters"), dict) else {}
    pivot = params.get("Pivot") or entry.get("Pivot") or entry.get("PivotType") or ""
    return str(pivot) if pivot else ""


def _entry_values(entry: dict[str, Any]) -> list[Any]:
    params = entry.get("Parameters") if isinstance(entry.get("Parameters"), dict) else {}
    values = params.get("Values") or entry.get("Values") or entry.get("Members") or []
    return values if isinstance(values, list) else []


def extract_target_groups(env_value: Any) -> list[dict[str, Any]]:
    """Return a normalized list of target groups for the env-state ``partial``."""
    out: list[dict[str, Any]] = []
    for group, entry in _iter_target_entries(env_value):
        name = entry.get("Name") or entry.get("TargetName") or ""
        values = _entry_values(entry)
        out.append(
            {
                "group": group,
                "name": str(name) if name else "",
                "pivot": _entry_pivot(entry),
                "valuesPreview": [str(v) for v in values[:5]],
                "valueCount": len(values),
            }
        )
    return out


def evaluate_my_ws(
    env_value: Any,
    *,
    tenant_id: str | None,
    capacity_id: str | None,
    workspace_id: str | None,
) -> bool:
    """True iff the configured workspace falls into one of the cell's target
    groups via an evaluable pivot (TenantObjectId / CapacityObjectId /
    WorkspaceObjectId). RegionName and MemberOf are V1-out — they evaluate
    False but do not raise.
    """
    ids_by_pivot = {
        "TenantObjectId": (tenant_id or "").lower(),
        "CapacityObjectId": (capacity_id or "").lower(),
        "WorkspaceObjectId": (workspace_id or "").lower(),
    }
    for _group, entry in _iter_target_entries(env_value):
        pivot = _entry_pivot(entry)
        if pivot not in _EVALUABLE_PIVOTS:
            continue
        my_id = ids_by_pivot.get(pivot, "")
        if not my_id:
            continue
        for v in _entry_values(entry):
            if isinstance(v, str) and v.lower() == my_id:
                return True
    return False


def build_per_env_cells(
    fm_doc: dict[str, Any] | None,
    *,
    env_keys: tuple[str, ...],
    tenant_id: str | None,
    capacity_id: str | None,
    workspace_id: str | None,
) -> tuple[dict[str, dict[str, Any]], bool]:
    """Build the ``perEnv`` map for a single flag.

    Returns ``(per_env, my_ws_targeted_anywhere)``. When ``fm_doc`` is None,
    every cell is ``{"state":"missing"}`` and ``my_ws_targeted_anywhere`` is
    False.
    """
    per_env: dict[str, dict[str, Any]] = {}
    any_my_ws = False
    if fm_doc is None:
        for env in env_keys:
            per_env[env] = {"state": "missing"}
        return per_env, any_my_ws

    environments = fm_doc.get("Environments")
    if not isinstance(environments, dict):
        environments = {}

    for env in env_keys:
        env_value = environments.get(env, {})
        state = classify_env(env_value)
        cell: dict[str, Any] = {"state": state}
        if state == "partial":
            cell["targets"] = extract_target_groups(env_value)
            cell_my_ws = evaluate_my_ws(
                env_value,
                tenant_id=tenant_id,
                capacity_id=capacity_id,
                workspace_id=workspace_id,
            )
            if cell_my_ws:
                cell["includesMyWorkspace"] = True
                any_my_ws = True
            # Mark cells whose target groups are all unevaluable locally
            # (RegionName / MemberOf or unknown pivots). The matrix uses
            # this to render the cell with a hatch overlay; the Inspector
            # uses it to suppress the value-reveal affordance.
            cell["unevaluable"] = bool(cell["targets"]) and all(
                t.get("pivot") not in _EVALUABLE_PIVOTS for t in cell["targets"]
            )
        per_env[env] = cell
    return per_env, any_my_ws


__all__ = [
    "FM_REPO_BRANCH",
    "FM_REPO_URL",
    "FeatureManagementCache",
    "build_per_env_cells",
    "classify_env",
    "evaluate_my_ws",
    "extract_target_groups",
]
