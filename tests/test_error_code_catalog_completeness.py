"""
Structural test: every ErrorCode enum member in the FLT repo must have
a corresponding entry in EdogErrorCodeCatalog.cs.
"""
from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
FLT_ERRORCODE = (
    REPO.parent
    / "workload-fabriclivetable"
    / "Service"
    / "Microsoft.LiveTable.Service"
    / "ErrorMapping"
    / "ErrorCode.cs"
)
CATALOG = REPO / "src" / "backend" / "DevMode" / "EdogErrorCodeCatalog.cs"


@pytest.fixture(scope="module")
def flt_enum_members():
    if not FLT_ERRORCODE.exists():
        pytest.skip("FLT repo not present")
    src = FLT_ERRORCODE.read_text(encoding="utf-8")
    return set(
        re.findall(
            r"^\s+((?:MLV|FMLV|FLT|DAG|DELTA)_\w+)",
            src,
            re.MULTILINE,
        )
    )


@pytest.fixture(scope="module")
def catalog_source():
    assert CATALOG.exists(), "EdogErrorCodeCatalog.cs missing"
    return CATALOG.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def catalog_entries(catalog_source):
    return set(re.findall(r'"((?:MLV|FMLV|FLT|DAG|DELTA)_\w+)"', catalog_source))


class TestErrorCodeCatalogCompleteness:
    def test_every_flt_enum_has_catalog_entry(self, flt_enum_members, catalog_entries):
        """Every ErrorCode enum member must appear in the catalog."""
        canonical = set()
        for m in flt_enum_members:
            if m.startswith("FMLV_"):
                canonical.add("MLV_" + m[5:])
            elif m.startswith("FLT_"):
                canonical.add("MLV_" + m[4:])
            else:
                canonical.add(m)
        missing = canonical - catalog_entries
        assert not missing, (
            f"ErrorCode members missing from EdogErrorCodeCatalog: {sorted(missing)}"
        )

    def test_catalog_has_required_fields(self, catalog_source):
        """Each catalog entry must have phase, channel, errorSource, category, description."""
        for field in ("Phase", "Channel", "ErrorSource", "Category", "Description"):
            assert field in catalog_source, (
                f"EdogErrorCodeCatalog must define '{field}' field in entries"
            )

    def test_catalog_has_node_kinds(self, catalog_source):
        """Each catalog entry must specify applicable node kinds."""
        assert "NodeKinds" in catalog_source, (
            "EdogErrorCodeCatalog must define 'NodeKinds' field for node-kind filtering"
        )

    def test_catalog_has_json_method(self, catalog_source):
        """Catalog must expose a method to serialize to JSON for frontend."""
        assert "GetCatalogJson" in catalog_source or "ToCatalogJson" in catalog_source, (
            "EdogErrorCodeCatalog must have a GetCatalogJson/ToCatalogJson method"
        )

    def test_no_duplicate_codes(self, catalog_source):
        """No duplicate error code entries in the catalog."""
        codes = re.findall(r'Code\s*=\s*"(MLV_\w+|DAG_\w+|DELTA_\w+)"', catalog_source)
        dupes = [c for c in codes if codes.count(c) > 1]
        assert not dupes, f"Duplicate error codes in catalog: {sorted(set(dupes))}"
