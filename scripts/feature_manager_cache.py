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
from collections.abc import Iterable, Iterator
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


def _strip_jsonc_comments(text: str) -> str:
    """Strip ``//`` line and ``/* */`` block comments from JSONC source.

    Preserves comment-like sequences that appear inside string literals (e.g.,
    a URL containing ``//`` is left intact). Implemented as a small char-level
    state machine — zero new dependencies, ~2x faster than a regex with
    string-aware lookaround for our file sizes.
    """
    out: list[str] = []
    i, n = 0, len(text)
    in_string = False
    escape = False
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "/":
                # Skip to end of line (keep the newline so line numbers in
                # parse errors still line up with the source).
                j = text.find("\n", i + 2)
                i = n if j < 0 else j
                continue
            if nxt == "*":
                j = text.find("*/", i + 2)
                i = n if j < 0 else j + 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


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
        # Filter applied by ``_build_index``. When None the indexer walks the
        # entire Features/ tree (~13K files, ~100s on Windows). In practice
        # the dev-server seeds this with the ~30-50 wire keys declared by
        # FLT's FeatureNames.cs, so we only json-parse the files we actually
        # need to render Card 3 — dropping FM sync from ~100s to <200ms.
        self._declared_keys: frozenset[str] | None = None

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

    def set_declared_keys(self, keys: Iterable[str]) -> None:
        """Set the wire-key allowlist for indexing.

        The cache only json-parses files whose wire key is in this set, which
        keeps sync time bounded to O(#FLT-declared-flags) rather than
        O(#files-in-FM-repo). Calling this with a changed set invalidates the
        in-memory index so the next ``ensure_synced`` re-runs ``_build_index``.

        Safe to call from any thread.
        """
        new_keys = frozenset(k for k in keys if isinstance(k, str) and k)
        with self._lock:
            if new_keys == self._declared_keys:
                return
            self._declared_keys = new_keys
            # Force a re-index — the previous index was built with a different
            # filter and may be missing newly-declared flags.
            self._synced_at = None
            self._index = {}

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

        index = self._build_index(repo_dir, self._declared_keys)

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

    def _build_index(
        self,
        repo_dir: Path,
        declared_keys: frozenset[str] | None,
    ) -> dict[str, dict[str, Any]]:
        """Build the wire-key → FM-JSON index.

        Strategy (filename-first):
            1. Walk ``Features/**/*.json`` once to build a stem → [paths] map.
               This is a name-only walk — no file content is read. ~0.1s for
               ~13K files on Windows.
            2. For each wire key in ``declared_keys``, look up candidate paths
               by filename stem and parse the first one whose ``Id`` matches.
               When ``declared_keys`` is None, parse every file (legacy
               behavior — ~100s on Windows).

        Files use JSONC (the FM repo contains ``//`` inline comments inside
        ``Values`` arrays); we strip comments before ``json.loads`` so flags
        like ``FLTUserBasedThrottling`` actually load instead of being
        silently dropped on a JSONDecodeError.
        """
        features_dir = repo_dir / "Features"
        if not features_dir.is_dir():
            raise RuntimeError(f"Features/ directory missing in FM cache at {repo_dir}")

        # Phase 1: cheap name-only walk.
        stem_to_paths: dict[str, list[Path]] = {}
        for path in features_dir.rglob("*.json"):
            stem_to_paths.setdefault(path.stem, []).append(path)

        # Phase 2: parse only the files we need.
        index: dict[str, dict[str, Any]] = {}
        keys_to_resolve: Iterable[str] = declared_keys if declared_keys is not None else stem_to_paths.keys()

        for wire_key in keys_to_resolve:
            candidates = stem_to_paths.get(wire_key)
            if not candidates:
                # Either the flag isn't in FM (correctly rendered as "missing")
                # or its file is named differently. Filename mismatches are
                # rare and historically were noise; if they become real we'll
                # add a content-indexed fallback here.
                continue
            for path in candidates:
                data = self._read_jsonc(path)
                if data is None:
                    continue
                if data.get("Id") == wire_key:
                    index[wire_key] = data
                    break

        return index

    @staticmethod
    def _read_jsonc(path: Path) -> dict[str, Any] | None:
        """Read a JSONC file (JSON + ``//`` and ``/* */`` comments)."""
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            logger.debug("FM cache: read failed for %s: %s", path, e)
            return None
        try:
            return json.loads(_strip_jsonc_comments(text))
        except ValueError as e:
            logger.warning("FM cache: parse failed for %s: %s", path, e)
            return None


# ----------------------------------------------------------------------
# Per-cell evaluation helpers
# ----------------------------------------------------------------------


def classify_env(env_value: Any) -> str:
    """Map a per-env JSON value to ``EnvState``.

    Per spec §2.1:
        {}                      → 'empty'
        { Enabled: true }       → 'on'
        { Enabled: false }      → 'off'
        { Targets: [...] }      → 'partial'  (OR-of-targets)
        { Requires: [...] }     → 'partial'  (AND-of-predicates)
        anything else           → 'empty'  (defensive)

    Both ``Targets`` and ``Requires`` produce ``partial`` — they're FM's two
    ways of expressing "conditionally on for some pivot subset". Targets is
    an allowlist (OR semantics across entries); Requires is a predicate list
    (AND semantics across entries). See ``evaluate_my_ws`` for how the
    distinction is honored when computing ``includesMyWorkspace``.
    """
    if not isinstance(env_value, dict) or not env_value:
        return "empty"
    if "Enabled" in env_value and isinstance(env_value["Enabled"], bool):
        return "on" if env_value["Enabled"] else "off"
    if env_value.get("Targets") or env_value.get("Requires"):
        return "partial"
    return "empty"


# FM rule names. ``PowerBI.MemberOf`` is the inclusion predicate; the
# ``Not``-variant inverts it. Everything else is treated as MemberOf for
# evaluation (existing forward-compat behavior).
_RULE_NOT_MEMBER_OF = "PowerBI.NotMemberOf"


def _iter_rule_entries(env_value: Any) -> Iterator[tuple[str, str, dict[str, Any]]]:
    """Yield ``(kind, group_name, entry)`` for every rule entry in this cell.

    ``kind`` is ``"Targets"`` or ``"Requires"``. ``group_name`` is the
    rollout-group label for Targets (``PublicRollout`` etc.) and an empty
    string for Requires (which has no group structure in FM).

    Targets shapes accepted (per FM repo observation):
        * Dict-of-groups: ``{"PublicRollout": [...], "RunnerTenants": [...]}``
        * Legacy flat list: ``[{Name, Parameters:{Pivot, Values}}, ...]``

    Requires shape:
        * Flat list: ``[{Name, Parameters:{Pivot, Values}}, ...]``
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
                    yield ("Targets", str(group_name), entry)
    elif isinstance(targets, list):
        for entry in targets:
            if isinstance(entry, dict):
                yield ("Targets", "", entry)
    requires = env_value.get("Requires")
    if isinstance(requires, list):
        for entry in requires:
            if isinstance(entry, dict):
                yield ("Requires", "", entry)


# Back-compat alias: callers that only needed Targets iteration can still use
# this name; behavior is identical to ``_iter_rule_entries`` since Targets is
# yielded first and exhaustively. Kept until external callers (none today)
# are migrated; remove once the codebase only uses ``_iter_rule_entries``.
def _iter_target_entries(env_value: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    for _kind, group, entry in _iter_rule_entries(env_value):
        yield (group, entry)


def _entry_rule_name(entry: dict[str, Any]) -> str:
    name = entry.get("Name") or entry.get("TargetName") or ""
    return str(name).strip()


def _entry_pivot(entry: dict[str, Any]) -> str:
    params = entry.get("Parameters") if isinstance(entry.get("Parameters"), dict) else {}
    pivot = params.get("Pivot") or entry.get("Pivot") or entry.get("PivotType") or ""
    return str(pivot) if pivot else ""


def _entry_values(entry: dict[str, Any]) -> list[Any]:
    params = entry.get("Parameters") if isinstance(entry.get("Parameters"), dict) else {}
    values = params.get("Values") or entry.get("Values") or entry.get("Members") or []
    return values if isinstance(values, list) else []


def extract_target_groups(env_value: Any) -> list[dict[str, Any]]:
    """Return a normalized list of rule entries for the env-state ``partial``.

    Each entry carries:
        * ``kind`` — ``"Targets"`` or ``"Requires"``
        * ``group`` — rollout-group name (Targets) or ``"Requires"`` so the
          frontend has a label to render in the rule pill. We deliberately
          stuff the kind into ``group`` for Requires entries so existing UI
          code (matrix tooltip, inspector list) shows the distinction without
          a frontend change.
        * ``name`` — the rule name from FM (e.g. ``PowerBI.MemberOf``,
          ``PowerBI.NotMemberOf``). The inspector displays this verbatim so
          ``Not``-variants are visible to humans.
        * ``pivot`` — pivot key (``WorkspaceObjectId`` etc.)
        * ``valuesPreview`` — first 5 string values
        * ``valueCount`` — total values declared
    """
    out: list[dict[str, Any]] = []
    for kind, group, entry in _iter_rule_entries(env_value):
        values = _entry_values(entry)
        display_group = group or ("Requires" if kind == "Requires" else "")
        out.append(
            {
                "kind": kind,
                "group": display_group,
                "name": _entry_rule_name(entry),
                "pivot": _entry_pivot(entry),
                "valuesPreview": [str(v) for v in values[:5]],
                "valueCount": len(values),
            }
        )
    return out


def _evaluate_entry(
    entry: dict[str, Any],
    ids_by_pivot: dict[str, str],
) -> bool | None:
    """Evaluate a single rule entry against the configured principal IDs.

    Returns:
        True   — principal matches the rule's predicate
        False  — principal definitively does NOT match
        None   — pivot is unknown / non-evaluable / principal ID not configured
                 → caller cannot conclude one way or the other
    """
    pivot = _entry_pivot(entry)
    if pivot not in _EVALUABLE_PIVOTS:
        return None
    my_id = ids_by_pivot.get(pivot, "")
    if not my_id:
        return None
    values_lower = {v.lower() for v in _entry_values(entry) if isinstance(v, str)}
    in_set = my_id in values_lower
    if _entry_rule_name(entry) == _RULE_NOT_MEMBER_OF:
        # Inclusion predicate inverted: principal matches when NOT in the set.
        return not in_set
    # All other rule names (PowerBI.MemberOf and unknown forward-compat names)
    # are treated as positive membership.
    return in_set


def evaluate_my_ws(
    env_value: Any,
    *,
    tenant_id: str | None,
    capacity_id: str | None,
    workspace_id: str | None,
) -> bool | None:
    """Tri-state evaluation of "is this cell's predicate true for my workspace".

    Returns:
        True   — principal satisfies the cell's predicate(s)
        False  — principal definitively does NOT satisfy
        None   — at least one relevant rule cannot be decided locally
                 (non-evaluable pivot, missing principal ID, etc.)

    Semantics:
        * ``Requires`` rules are AND-combined: every rule must evaluate True.
          Any ``None`` in Requires propagates to a ``None`` result because we
          cannot conclude the conjunction holds.
        * ``Targets`` rules are OR-combined: any rule evaluating True yields
          True for the Targets portion. Targets evaluating to None alone do
          NOT short-circuit to None — they only matter when no Targets rule
          conclusively matched.
        * When both ``Requires`` and ``Targets`` are present, the cell is on
          for the principal iff Requires AND Targets both hold.
        * When neither is present, the cell isn't ``partial`` in the first
          place and this function should not be called — callers guard via
          ``classify_env``.
    """
    if not isinstance(env_value, dict):
        return False
    ids_by_pivot = {
        "TenantObjectId": (tenant_id or "").lower(),
        "CapacityObjectId": (capacity_id or "").lower(),
        "WorkspaceObjectId": (workspace_id or "").lower(),
    }

    requires = env_value.get("Requires")
    has_requires = isinstance(requires, list) and bool(requires)
    has_targets = bool(env_value.get("Targets"))

    requires_result: bool | None = True
    if has_requires:
        for entry in requires:
            if not isinstance(entry, dict):
                continue
            r = _evaluate_entry(entry, ids_by_pivot)
            if r is None:
                requires_result = None
                break
            if not r:
                requires_result = False
                break

    if not has_targets:
        return requires_result

    targets_result: bool | None = False
    saw_unknown = False
    for kind, _group, entry in _iter_rule_entries(env_value):
        if kind != "Targets":
            continue
        r = _evaluate_entry(entry, ids_by_pivot)
        if r is True:
            targets_result = True
            break
        if r is None:
            saw_unknown = True
    if targets_result is False and saw_unknown:
        # Couldn't find a definite match; at least one Targets rule was
        # undecidable — escalate to None so the cell is marked unevaluable.
        targets_result = None

    if not has_requires:
        return targets_result

    # Both present: AND of the two component results, with tri-state rules.
    if requires_result is False or targets_result is False:
        return False
    if requires_result is None or targets_result is None:
        return None
    return True


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
            ws_result = evaluate_my_ws(
                env_value,
                tenant_id=tenant_id,
                capacity_id=capacity_id,
                workspace_id=workspace_id,
            )
            if ws_result is True:
                cell["includesMyWorkspace"] = True
                any_my_ws = True
            # ``unevaluable`` means "we cannot tell whether this cell is on
            # for the configured workspace". That's the case when either no
            # rule uses an evaluable pivot, OR a required rule was undecided
            # (``evaluate_my_ws`` returned None). The matrix paints these
            # with a hatch overlay; the inspector suppresses confident
            # claims like "EFFECTIVE: ON".
            cell["unevaluable"] = ws_result is None
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
