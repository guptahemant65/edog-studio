"""Tests for ``repo_discovery.get_configured_swagger_path`` — the resolver
that points the F09 swagger baseline at the FLT repo's committed
``Service/Microsoft.LiveTable.Service/Swagger/Swagger.json``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import repo_discovery


@pytest.fixture
def fake_flt_repo(tmp_path: Path) -> Path:
    """Build a minimum repo with the FLT marker layout."""
    repo = tmp_path / "flt"
    (repo / "Service" / "Microsoft.LiveTable.Service" / "Swagger").mkdir(parents=True)
    return repo


def test_get_flt_swagger_path_appends_relpath(fake_flt_repo: Path):
    got = repo_discovery.get_flt_swagger_path(fake_flt_repo)
    expected = fake_flt_repo / "Service" / "Microsoft.LiveTable.Service" / "Swagger" / "Swagger.json"
    assert got == expected


def test_get_flt_swagger_path_does_not_require_existence(tmp_path: Path):
    # No repo on disk — path resolution still works, existence is the
    # caller's responsibility.
    got = repo_discovery.get_flt_swagger_path(tmp_path / "doesnt-exist")
    assert got.name == "Swagger.json"
    assert got.parent.name == "Swagger"


def test_get_configured_swagger_path_unconfigured():
    assert repo_discovery.get_configured_swagger_path({}) is None
    assert repo_discovery.get_configured_swagger_path({"flt_repo_path": ""}) is None


def test_get_configured_swagger_path_invalid_path(tmp_path: Path):
    # Configured path doesn't have the FLT marker — invalid.
    cfg = {"flt_repo_path": str(tmp_path / "not-a-flt-repo")}
    assert repo_discovery.get_configured_swagger_path(cfg) is None


def test_get_configured_swagger_path_valid_repo(fake_flt_repo: Path):
    cfg = {"flt_repo_path": str(fake_flt_repo)}
    got = repo_discovery.get_configured_swagger_path(cfg)
    assert got is not None
    assert got == fake_flt_repo.resolve() / "Service" / "Microsoft.LiveTable.Service" / "Swagger" / "Swagger.json"


def test_get_configured_swagger_path_file_not_required(fake_flt_repo: Path):
    """Resolver returns the path even when Swagger.json is absent — the
    consumer decides whether to treat the missing file as 'no baseline'."""
    cfg = {"flt_repo_path": str(fake_flt_repo)}
    got = repo_discovery.get_configured_swagger_path(cfg)
    assert got is not None
    assert not got.exists()


def test_get_configured_swagger_path_with_real_swagger_file(fake_flt_repo: Path):
    """Resolver returns a usable Path that points at an actual file."""
    swagger_file = fake_flt_repo / "Service" / "Microsoft.LiveTable.Service" / "Swagger" / "Swagger.json"
    swagger_file.write_text(json.dumps({"openapi": "3.0.1"}), encoding="utf-8")
    cfg = {"flt_repo_path": str(fake_flt_repo)}
    got = repo_discovery.get_configured_swagger_path(cfg)
    assert got is not None
    assert got.exists()
    assert json.loads(got.read_text())["openapi"] == "3.0.1"
