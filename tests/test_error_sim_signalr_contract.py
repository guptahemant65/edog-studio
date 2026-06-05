"""
EdogPlaygroundHub — structural test for Error Simulator SignalR methods.
"""
from __future__ import annotations

import pathlib

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
HUB = REPO / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"


@pytest.fixture(scope="module")
def hub_source():
    assert HUB.exists()
    return HUB.read_text(encoding="utf-8")


class TestErrorSimHubMethods:
    def test_get_catalog(self, hub_source):
        assert "ErrorSimGetCatalog" in hub_source

    def test_add_rule(self, hub_source):
        assert "ErrorSimAddRule" in hub_source

    def test_remove_rule(self, hub_source):
        assert "ErrorSimRemoveRule" in hub_source

    def test_clear_all(self, hub_source):
        assert "ErrorSimClearAll" in hub_source

    def test_get_active_rules(self, hub_source):
        assert "ErrorSimGetActiveRules" in hub_source

    def test_get_blast_radius(self, hub_source):
        assert "ErrorSimGetBlastRadius" in hub_source

    def test_delegates_to_engine(self, hub_source):
        assert "EdogErrorSimEngine" in hub_source, \
            "Hub methods must delegate to EdogErrorSimEngine"
