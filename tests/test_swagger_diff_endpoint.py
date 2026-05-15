"""Integration tests for SF-010: /api/playground/swagger/diff endpoint.

Exercises _serve_swagger_diff by binding the unbound method to a FakeHandler
and patching the dev-server's runtime fetcher and baseline-path resolver.

After the F09 baseline-source change, the baseline lives at the FLT
repo's committed Swagger.json. Tests stub
``_resolve_swagger_baseline_path`` so they don't need to materialize a
fake FLT repo on disk.
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


def _resolver_ok(path: Path):
    def _impl(self):
        return path, None
    return _impl


def _resolver_unconfigured():
    def _impl(self):
        return None, {"error": "flt-repo-not-configured", "message": "no repo"}
    return _impl


def _attach(handler, resolver):
    handler._resolve_swagger_baseline_path = lambda: resolver(handler)
    return handler


def _call_diff(srv, resolver=None):
    handler = FakeHandler()
    if resolver is not None:
        _attach(handler, resolver)
    srv.EdogDevHandler._serve_swagger_diff(handler)
    return handler


def _write_config(tmp_path, cfg):
    p = tmp_path / "edog-config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return p


# ── Runtime not reachable ────────────────────────────────────────


class TestRuntimeNotReachable:
    def test_returns_503_when_flt_not_running(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "BEARER_CACHE", tmp_path / ".bearer-noop"), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(None, {
                              "error": "flt-not-running",
                              "message": "no route",
                              "status": 503,
                          })):
            handler = _call_diff(srv)
        assert handler.response_status == 503
        assert handler.response_payload["error"] == "flt-not-running"
        assert handler.response_payload["runtime"] is None

    def test_returns_503_when_config_missing(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {})  # no ids
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(None, {
                              "error": "missing-config",
                              "message": "ids missing",
                              "status": 503,
                          })):
            handler = _call_diff(srv)
        assert handler.response_status == 503
        assert handler.response_payload["error"] == "missing-config"


# ── No baseline yet ──────────────────────────────────────────────


class TestNoBaseline:
    def test_returns_200_with_runtime_and_null_diff(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        runtime = {
            "openapi": "3.0.0",
            "info": {"title": "FLT", "version": "1"},
            "paths": {"/x": {"get": {"responses": {"200": {"description": "ok"}}}}},
            "components": {"schemas": {}},
        }
        baseline_path = tmp_path / "baseline-missing.json"  # not created
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(runtime, None)):
            handler = _call_diff(srv, _resolver_ok(baseline_path))
        assert handler.response_status == 200
        payload = handler.response_payload
        assert payload["runtime"] == runtime
        assert payload["baselineExists"] is False
        assert payload["diff"] is None
        assert payload["baselineSource"] == "flt-repo"

    def test_returns_200_when_flt_repo_not_configured(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        runtime = {
            "openapi": "3.0.0", "info": {"title": "FLT", "version": "1"},
            "paths": {}, "components": {"schemas": {}},
        }
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(runtime, None)):
            handler = _call_diff(srv, _resolver_unconfigured())
        assert handler.response_status == 200
        payload = handler.response_payload
        assert payload["runtime"] == runtime
        assert payload["baselineExists"] is False
        assert payload["baselineError"] == "flt-repo-not-configured"
        assert payload["diff"] is None


# ── Baseline present ─────────────────────────────────────────────


class TestWithBaseline:
    def test_no_changes_yields_zero_total(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        spec = {
            "openapi": "3.0.0",
            "info": {"title": "FLT", "version": "1"},
            "paths": {"/x": {"get": {"responses": {"200": {"description": "ok"}}}}},
            "components": {"schemas": {}},
        }
        baseline_path = tmp_path / "baseline.json"
        baseline_path.write_text(json.dumps(spec), encoding="utf-8")
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(spec, None)):
            handler = _call_diff(srv, _resolver_ok(baseline_path))
        assert handler.response_status == 200
        payload = handler.response_payload
        assert payload["baselineExists"] is True
        assert payload["diff"]["summary"]["totalChanges"] == 0
        assert payload["diff"]["changes"] == []

    def test_added_endpoint_surfaces_in_diff(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        baseline_spec = {
            "openapi": "3.0.0",
            "info": {"title": "FLT", "version": "1"},
            "paths": {"/x": {"get": {"responses": {"200": {"description": "ok"}}}}},
            "components": {"schemas": {}},
        }
        runtime_spec = {
            **baseline_spec,
            "paths": {
                **baseline_spec["paths"],
                "/y": {"post": {"responses": {"201": {"description": "ok"}}}},
            },
        }
        baseline_path = tmp_path / "baseline.json"
        baseline_path.write_text(json.dumps(baseline_spec), encoding="utf-8")
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(runtime_spec, None)):
            handler = _call_diff(srv, _resolver_ok(baseline_path))
        assert handler.response_status == 200
        diff = handler.response_payload["diff"]
        assert diff["summary"]["endpoints"]["added"] == 1
        assert diff["summary"]["totalChanges"] == 1
        [change] = diff["changes"]
        assert change["type"] == "added"
        assert change["key"] == "POST /y"
        assert change["category"] == "endpoints"


class TestCorruptBaseline:
    def test_corrupt_baseline_surfaces_error_not_500(self, srv, tmp_path):
        cfg = _write_config(tmp_path, {
            "workspace_id": "w", "artifact_id": "a", "capacity_id": "c",
        })
        baseline_path = tmp_path / "baseline.json"
        baseline_path.write_text("{not json", encoding="utf-8")
        runtime = {
            "openapi": "3.0.0",
            "info": {"title": "FLT", "version": "1"},
            "paths": {}, "components": {"schemas": {}},
        }
        with patch.object(srv, "CONFIG_PATH", cfg), \
             patch.object(srv, "_read_cache", return_value=("tok", None)), \
             patch.object(srv, "_fetch_runtime_swagger",
                          return_value=(runtime, None)):
            handler = _call_diff(srv, _resolver_ok(baseline_path))
        # Frontend gets a clean signal to ask "re-save baseline" — not a 5xx.
        assert handler.response_status == 200
        payload = handler.response_payload
        assert payload["diff"] is None
        assert payload["baselineExists"] is True
        assert payload["baselineError"].startswith("baseline-corrupt")
