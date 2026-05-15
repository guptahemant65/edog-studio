"""Tests for scripts/swagger_baseline.py (SF-010 read + SF-011 write/delete)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_baseline import (  # noqa: E402
    load_baseline,
    remove_baseline,
    save_baseline,
)


class TestLoadAbsent:
    def test_missing_file(self, tmp_path):
        spec, meta = load_baseline(tmp_path / "missing.json")
        assert spec is None
        assert meta == {"exists": False, "savedAt": None, "size": None, "error": None}

    def test_empty_file_treated_as_absent(self, tmp_path):
        p = tmp_path / "empty.json"
        p.write_text("", encoding="utf-8")
        spec, meta = load_baseline(p)
        assert spec is None
        assert meta["exists"] is True
        assert meta["size"] == 0
        assert meta["error"] is None

    def test_empty_object_placeholder_treated_as_absent(self, tmp_path):
        p = tmp_path / "seed.json"
        p.write_text("{}", encoding="utf-8")
        spec, meta = load_baseline(p)
        assert spec is None
        assert meta["exists"] is True
        assert meta["error"] is None


class TestLoadHappyPath:
    def test_returns_parsed_spec(self, tmp_path):
        p = tmp_path / "baseline.json"
        original = {"openapi": "3.0", "paths": {"/x": {"get": {}}}}
        p.write_text(json.dumps(original), encoding="utf-8")
        spec, meta = load_baseline(p)
        assert spec == original
        assert meta["exists"] is True
        assert meta["size"] > 0
        assert meta["error"] is None
        # ISO 8601 timestamp
        assert "T" in meta["savedAt"] and meta["savedAt"].endswith("+00:00")


class TestLoadCorrupt:
    def test_invalid_json_returns_error_meta(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text("{not json", encoding="utf-8")
        spec, meta = load_baseline(p)
        assert spec is None
        assert meta["error"].startswith("baseline-corrupt")

    def test_non_object_returns_error(self, tmp_path):
        p = tmp_path / "array.json"
        p.write_text("[1, 2, 3]", encoding="utf-8")
        spec, meta = load_baseline(p)
        assert spec is None
        assert "baseline-corrupt" in meta["error"]


class TestSave:
    def test_writes_file_with_metadata(self, tmp_path):
        p = tmp_path / "data" / "baseline.json"
        meta = save_baseline(p, {"openapi": "3.0.0", "info": {"title": "T"}})
        assert p.exists()
        assert meta["exists"] is True
        assert meta["size"] > 0
        assert meta["error"] is None
        # Round-trip works
        assert json.loads(p.read_text(encoding="utf-8")) == {
            "openapi": "3.0.0",
            "info": {"title": "T"},
        }

    def test_save_is_atomic_overwrite(self, tmp_path):
        p = tmp_path / "baseline.json"
        save_baseline(p, {"v": 1})
        save_baseline(p, {"v": 2})
        assert json.loads(p.read_text()) == {"v": 2}
        # tmp sibling does not linger
        assert not p.with_suffix(p.suffix + ".tmp").exists()

    def test_rejects_non_dict(self, tmp_path):
        with pytest.raises(TypeError):
            save_baseline(tmp_path / "x.json", [])  # type: ignore[arg-type]


class TestRemove:
    def test_remove_existing(self, tmp_path):
        p = tmp_path / "baseline.json"
        p.write_text("{}", encoding="utf-8")
        assert remove_baseline(p) is True
        assert not p.exists()

    def test_remove_missing_returns_false(self, tmp_path):
        assert remove_baseline(tmp_path / "ghost.json") is False
