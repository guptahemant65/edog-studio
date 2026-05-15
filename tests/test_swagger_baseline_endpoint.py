"""Integration tests for SF-011: /api/playground/swagger/baseline endpoints.

Exercises GET / POST / DELETE on the baseline endpoint by binding the
unbound methods to a FakeHandler. dev-server's runtime fetcher and
baseline path are patched per-test.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEV_SERVER = PROJECT_DIR / "scripts" / "dev-server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("edog_dev_server", DEV_SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(DEV_SERVER.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


class FakeHandler:
    def __init__(self):
        self.headers = {}
        self.rfile = io.BytesIO(b"")
        self.response_status = None
        self.response_payload = None

    def _json_response(self, status, payload):
        self.response_status = status
        self.response_payload = payload


def _call_get(srv):
    h = FakeHandler()
    srv.EdogDevHandler._serve_swagger_baseline_get(h)
    return h


def _call_post(srv):
    h = FakeHandler()
    srv.EdogDevHandler._serve_swagger_baseline_post(h)
    return h


def _call_delete(srv):
    h = FakeHandler()
    srv.EdogDevHandler._serve_swagger_baseline_delete(h)
    return h


def _write_config(tmp_path, cfg):
    p = tmp_path / "edog-config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return p


# ── GET ───────────────────────────────────────────────────────────


class TestBaselineGet:
    def test_returns_absent_metadata_for_missing_file(self, srv, tmp_path):
        with patch.object(srv, "SWAGGER_BASELINE_PATH", tmp_path / "ghost.json"):
            h = _call_get(srv)
        assert h.response_status == 200
        assert h.response_payload == {
            "exists": False, "savedAt": None, "size": None, "error": None,
        }

    def test_returns_metadata_for_present_file(self, srv, tmp_path):
        p = tmp_path / "baseline.json"
        p.write_text(json.dumps({"openapi": "3.0", "info": {}}), encoding="utf-8")
        with patch.object(srv, "SWAGGER_BASELINE_PATH", p):
            h = _call_get(srv)
        assert h.response_status == 200
        assert h.response_payload["exists"] is True
        assert h.response_payload["size"] > 0
        assert h.response_payload["error"] is None


# ── POST ──────────────────────────────────────────────────────────


class TestBaselinePost:
    def test_fetches_runtime_and_saves_baseline(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        baseline_path = tmp_path / "data" / "baseline.json"
        runtime_spec = {"openapi": "3.0.0", "info": {"title": "FLT"}, "paths": {}}
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "SWAGGER_BASELINE_PATH", baseline_path), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(runtime_spec, None)):
            h = _call_post(srv)
        assert h.response_status == 200
        assert h.response_payload["exists"] is True
        assert h.response_payload["size"] > 0
        # Round-trip on disk
        assert json.loads(baseline_path.read_text()) == runtime_spec

    def test_runtime_fetch_failure_surfaces_error(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        baseline_path = tmp_path / "baseline.json"
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "SWAGGER_BASELINE_PATH", baseline_path), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(None, {
                              "error": "flt-not-running",
                              "message": "no route",
                              "status": 503,
                          })):
            h = _call_post(srv)
        assert h.response_status == 503
        assert h.response_payload["error"] == "flt-not-running"
        assert not baseline_path.exists()

    def test_post_overwrites_existing_baseline(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        baseline_path = tmp_path / "baseline.json"
        baseline_path.write_text(json.dumps({"old": True}), encoding="utf-8")
        new_spec = {"openapi": "3.0.0", "paths": {"/y": {"get": {}}}}
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "SWAGGER_BASELINE_PATH", baseline_path), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(new_spec, None)):
            h = _call_post(srv)
        assert h.response_status == 200
        assert json.loads(baseline_path.read_text()) == new_spec


# ── DELETE ────────────────────────────────────────────────────────


class TestBaselineDelete:
    def test_removes_existing_baseline(self, srv, tmp_path):
        p = tmp_path / "baseline.json"
        p.write_text("{}", encoding="utf-8")
        with patch.object(srv, "SWAGGER_BASELINE_PATH", p):
            h = _call_delete(srv)
        assert h.response_status == 200
        assert h.response_payload == {"removed": True}
        assert not p.exists()

    def test_delete_missing_baseline_returns_false(self, srv, tmp_path):
        with patch.object(srv, "SWAGGER_BASELINE_PATH", tmp_path / "nope.json"):
            h = _call_delete(srv)
        assert h.response_status == 200
        assert h.response_payload == {"removed": False}
