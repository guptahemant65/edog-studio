"""Tests for EDOG interceptor observability — Phase 1 fixes.

Covers:
  • `_is_edog_patch_warning` — line classifier for capturing edog.py
    "pattern not found" warnings out of the deploy subprocess stdout.
  • `_studio_state` initial shape — the new `patchWarnings` field must be
    present and start empty, otherwise the topbar banner and `/api/edog/patch-warnings`
    endpoint will crash on first read.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEV_SERVER = PROJECT_DIR / "scripts" / "dev-server.py"


@pytest.fixture(scope="module")
def srv():
    """Load dev-server.py as an importable module (its filename has a dash)."""
    spec = importlib.util.spec_from_file_location("edog_dev_server_ix", DEV_SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(DEV_SERVER.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


# ── _is_edog_patch_warning ────────────────────────────────────────────────


def test_pattern_not_found_lowercase_detected(srv):
    assert srv._is_edog_patch_warning("Telemetry interceptor: pattern not found")


def test_pattern_not_found_mixed_case_detected(srv):
    assert srv._is_edog_patch_warning("WorkloadApp.cs Pattern Not Found at anchor")


def test_warning_glyph_detected(srv):
    # U+26A0 is the warning sign emitted by edog.py
    assert srv._is_edog_patch_warning("\u26a0  Token interceptor skipped")


def test_normal_info_line_ignored(srv):
    assert not srv._is_edog_patch_warning("Patched WorkloadApp.cs successfully")
    assert not srv._is_edog_patch_warning("Build succeeded")
    assert not srv._is_edog_patch_warning("[FLT] FLT_PORT=5557")


def test_empty_string_ignored(srv):
    assert not srv._is_edog_patch_warning("")


def test_none_treated_as_falsy(srv):
    # Defensive — the parser splits proc.stdout so empty falsy values must
    # not raise.
    assert not srv._is_edog_patch_warning(None)


# ── _studio_state initial shape ──────────────────────────────────────────


def test_studio_state_has_patch_warnings_field(srv):
    """Banner + endpoint read this field on every poll. Must exist + be a list."""
    assert "patchWarnings" in srv._studio_state
    assert isinstance(srv._studio_state["patchWarnings"], list)


# ── /api/edog/patch-warnings response shape ──────────────────────────────


class _Recorder:
    """Capture what BaseHTTPRequestHandler-style _json_response writes."""

    def __init__(self):
        self.status = None
        self.body = None


def _make_handler_double(srv, recorded: _Recorder):
    """Build a minimal duck-typed object with the methods _serve_patch_warnings
    needs. Avoids spinning up an HTTP server for a pure-shape test."""

    class _H:
        def _json_response(self, status, body):
            recorded.status = status
            recorded.body = body

    h = _H()
    # Bind the unbound method onto the double.
    h._serve_patch_warnings = srv.EdogDevHandler._serve_patch_warnings.__get__(h)
    return h


def test_patch_warnings_endpoint_empty_state(srv):
    # Reset to a known state. Test does NOT touch _studio_lock because we own
    # the module in single-threaded test execution.
    original = list(srv._studio_state.get("patchWarnings") or [])
    original_phase = srv._studio_state.get("phase", "idle")
    try:
        srv._studio_state["patchWarnings"] = []
        srv._studio_state["phase"] = "idle"
        rec = _Recorder()
        h = _make_handler_double(srv, rec)
        h._serve_patch_warnings()
        assert rec.status == 200
        assert rec.body == {"warnings": [], "count": 0, "deployPhase": "idle"}
    finally:
        srv._studio_state["patchWarnings"] = original
        srv._studio_state["phase"] = original_phase


def test_patch_warnings_endpoint_populated_state(srv):
    original = list(srv._studio_state.get("patchWarnings") or [])
    original_phase = srv._studio_state.get("phase", "idle")
    try:
        srv._studio_state["patchWarnings"] = [
            "\u26a0  Telemetry interceptor: pattern not found",
            "Token interceptor: pattern not found",
        ]
        srv._studio_state["phase"] = "running"
        rec = _Recorder()
        h = _make_handler_double(srv, rec)
        h._serve_patch_warnings()
        assert rec.status == 200
        assert rec.body["count"] == 2
        assert rec.body["deployPhase"] == "running"
        assert len(rec.body["warnings"]) == 2
        assert "Telemetry" in rec.body["warnings"][0]
    finally:
        srv._studio_state["patchWarnings"] = original
        srv._studio_state["phase"] = original_phase
