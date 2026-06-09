"""Guardrail for the FeatureManagement-cache warm-up wiring.

The dev-server warms the FM-repo cache at boot (and lazily on first
Environment-tab open) via the shared ``_seed_and_sync_fm_cache`` helper.
Its contract: seed the FLT-declared wire keys into the cache FIRST (so the
index is capped to ~30-50 flags instead of the full ~13K-file FM repo), THEN
kick a non-blocking sync. Both steps are best-effort — a parse failure must
not crash the caller (boot thread / HTTP handler).

dev-server.py is hyphenated and can't be ``import``ed normally, so we load it
via importlib (mirroring how the running server executes it).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _load_dev_server():
    spec = importlib.util.spec_from_file_location("dev_server_under_test", SCRIPTS_DIR / "dev-server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DEV_SERVER = _load_dev_server()


class _StubCache:
    """Records seed/sync calls so we can assert ordering and arguments."""

    def __init__(self):
        self.calls: list[tuple[str, object]] = []

    def set_declared_keys(self, keys):
        self.calls.append(("seed", frozenset(keys)))

    def ensure_synced(self, force: bool = False):
        self.calls.append(("sync", force))
        return True


def _write_feature_names(repo: Path, wire_keys: list[str]) -> None:
    fn = repo / "Service" / "Microsoft.LiveTable.Service" / "FeatureFlightProvider"
    fn.mkdir(parents=True, exist_ok=True)
    lines = ["namespace X {", "  public static class FeatureNames {"]
    for i, wk in enumerate(wire_keys):
        lines.append(f'    public const string Flag{i} = "{wk}";')
    lines.append("  }")
    lines.append("}")
    (fn / "FeatureNames.cs").write_text("\n".join(lines), encoding="utf-8")


@pytest.fixture
def _stub(monkeypatch):
    stub = _StubCache()
    monkeypatch.setattr(DEV_SERVER, "_FM_CACHE", stub)
    return stub


def test_seed_runs_before_sync(_stub, tmp_path):
    """Declared keys must be seeded BEFORE the sync kicks — otherwise the first
    index build scans the entire FM repo instead of the ~30-50 declared flags.

    Mutation check: swap the two calls in the helper and the ordering assert
    below fails.
    """
    _write_feature_names(tmp_path, ["FltAlpha", "FltBeta"])
    DEV_SERVER._seed_and_sync_fm_cache(str(tmp_path))

    kinds = [c[0] for c in _stub.calls]
    assert kinds == ["seed", "sync"], f"expected seed-then-sync, got {kinds}"
    assert _stub.calls[0][1] == frozenset({"FltAlpha", "FltBeta"})


def test_parse_failure_is_swallowed_and_sync_still_kicks(_stub, tmp_path):
    """No FeatureNames.cs (e.g. half-cloned repo) must NOT crash the boot
    thread or HTTP handler. Seeding is skipped; the sync is still attempted so
    a later, complete repo can recover."""
    # tmp_path has no FeatureNames.cs → parse_feature_names raises FileNotFound,
    # which the helper must swallow.
    DEV_SERVER._seed_and_sync_fm_cache(str(tmp_path))

    kinds = [c[0] for c in _stub.calls]
    assert "sync" in kinds, "sync must still be attempted after a seed failure"
    assert kinds == ["sync"], f"seed must be skipped on parse failure, got {kinds}"
