"""Tests for SF-002: framework endpoints loader in scripts/flt_catalog.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import flt_catalog  # noqa: E402
from flt_catalog import (  # noqa: E402
    VALID_ENDPOINT_KINDS,
    VALID_ENDPOINT_SOURCES,
    _load_framework_endpoints,
    framework_endpoints_mtime,
)


def _write_framework_file(tmp_path: Path, payload: dict) -> Path:
    p = tmp_path / "framework-endpoints.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    return p


class TestRealFile:
    """The committed data/framework-endpoints.json must always be loadable."""

    def test_committed_file_loads(self):
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints, "data/framework-endpoints.json should contain endpoints"
        # The file ships with at least swagger spec + swagger UI.
        assert any(e["kind"] == "spec" for e in endpoints)
        assert any(e["kind"] == "ui" for e in endpoints)
        # No warnings on the canonical file.
        assert warnings == []

    def test_committed_file_every_endpoint_passes_taxonomy(self):
        endpoints, _ = _load_framework_endpoints()
        for ep in endpoints:
            assert ep["source"] == "framework"
            assert ep["kind"] in VALID_ENDPOINT_KINDS
            assert ep["id"]
            assert ep["urlTemplate"]


class TestMissingFile:
    def test_missing_file_returns_empty_with_warning(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", tmp_path / "does-not-exist.json"
        )
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints == []
        assert any("not found" in w.lower() for w in warnings)


class TestMalformedFile:
    def test_invalid_json_returns_empty_with_warning(self, tmp_path, monkeypatch):
        bad = tmp_path / "framework-endpoints.json"
        bad.write_text("{not valid json", encoding="utf-8")
        monkeypatch.setattr(flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", bad)
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints == []
        assert any("not valid json" in w.lower() for w in warnings)

    def test_missing_endpoints_key(self, tmp_path, monkeypatch):
        f = _write_framework_file(tmp_path, {"version": 1})
        monkeypatch.setattr(flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", f)
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints == []
        assert any("endpoints" in w.lower() for w in warnings)

    def test_endpoint_missing_required_keys_skipped(self, tmp_path, monkeypatch):
        f = _write_framework_file(
            tmp_path,
            {
                "version": 1,
                "endpoints": [
                    {"id": "broken", "name": "Broken", "kind": "spec"},  # missing many keys
                ],
            },
        )
        monkeypatch.setattr(flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", f)
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints == []
        assert any("missing keys" in w.lower() for w in warnings)

    def test_invalid_kind_skipped(self, tmp_path, monkeypatch):
        f = _write_framework_file(
            tmp_path,
            {
                "version": 1,
                "endpoints": [
                    {
                        "id": "x",
                        "name": "X",
                        "method": "GET",
                        "urlTemplate": "/x",
                        "fullPath": "/x",
                        "group": "g",
                        "tokenType": "mwc",
                        "controller": "c",
                        "description": "",
                        "queryParams": [],
                        "dangerLevel": "safe",
                        "bodyTemplate": None,
                        "kind": "websocket",  # invalid
                        "source": "framework",
                    }
                ],
            },
        )
        monkeypatch.setattr(flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", f)
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints == []
        assert any("invalid kind" in w.lower() for w in warnings)

    def test_invalid_source_skipped(self, tmp_path, monkeypatch):
        f = _write_framework_file(
            tmp_path,
            {
                "version": 1,
                "endpoints": [
                    {
                        "id": "x",
                        "name": "X",
                        "method": "GET",
                        "urlTemplate": "/x",
                        "fullPath": "/x",
                        "group": "g",
                        "tokenType": "mwc",
                        "controller": "c",
                        "description": "",
                        "queryParams": [],
                        "dangerLevel": "safe",
                        "bodyTemplate": None,
                        "kind": "spec",
                        "source": "controller",  # invalid for framework file
                    }
                ],
            },
        )
        monkeypatch.setattr(flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", f)
        endpoints, warnings = _load_framework_endpoints()
        assert endpoints == []
        assert any("must have source='framework'" in w for w in warnings)


class TestMtimeHelper:
    def test_returns_float_when_file_exists(self):
        mt = framework_endpoints_mtime()
        assert mt is not None
        assert isinstance(mt, float)
        assert mt > 0

    def test_returns_none_when_file_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            flt_catalog, "_FRAMEWORK_ENDPOINTS_PATH", tmp_path / "missing.json"
        )
        assert framework_endpoints_mtime() is None


class TestTaxonomyConstants:
    """Belt-and-braces — SF-001 constants are part of the public surface."""

    def test_kinds(self):
        assert VALID_ENDPOINT_KINDS == frozenset({"rest", "spec", "ui", "signalr"})

    def test_sources(self):
        assert VALID_ENDPOINT_SOURCES == frozenset(
            {"controller", "framework", "runtime"}
        )
