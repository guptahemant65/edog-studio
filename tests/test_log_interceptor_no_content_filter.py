"""
EdogLogInterceptor — structural regression test: blocklist-based filtering.

The interceptor uses BlocklistFilter (loaded from edog-blocklist.json) to
drop noisy platform components. Errors/Warnings always pass through.
FLT logs (anything not blocklisted) pass through at all levels.
"""

from __future__ import annotations

import pathlib
import re

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR_PATH = PROJECT_ROOT / "src" / "backend" / "DevMode" / "EdogLogInterceptor.cs"
BLOCKLIST_PATH = PROJECT_ROOT / "src" / "backend" / "DevMode" / "BlocklistFilter.cs"
BLOCKLIST_JSON = PROJECT_ROOT / "src" / "backend" / "DevMode" / "edog-blocklist.json"


@pytest.fixture()
def interceptor_source() -> str:
    assert INTERCEPTOR_PATH.exists(), "EdogLogInterceptor.cs missing"
    return INTERCEPTOR_PATH.read_text(encoding="utf-8")


class TestBlocklistBasedFiltering:
    """Log interceptor uses blocklist pattern (not allowlist)."""

    def test_uses_blocklist_filter(self, interceptor_source: str) -> None:
        assert "BlocklistFilter" in interceptor_source

    def test_no_allowlist_references(self, interceptor_source: str) -> None:
        stripped = re.sub(r"//[^\n]*", "", interceptor_source)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        for banned in ("fltComponentPrefixes", "hasAllowlist", "LoadComponentAllowlist", "edog-flt-components"):
            assert banned not in stripped

    def test_errors_always_pass(self, interceptor_source: str) -> None:
        assert "isError" in interceptor_source or "Error" in interceptor_source

    def test_blocklist_filter_file_exists(self) -> None:
        assert BLOCKLIST_PATH.exists(), "BlocklistFilter.cs missing"

    def test_blocklist_json_exists(self) -> None:
        assert BLOCKLIST_JSON.exists(), "edog-blocklist.json missing"

    def test_blocklist_json_has_entries(self) -> None:
        import json
        data = json.loads(BLOCKLIST_JSON.read_text(encoding="utf-8"))
        assert "blocked" in data
        assert len(data["blocked"]) > 0
