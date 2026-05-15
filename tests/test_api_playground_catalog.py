"""Validate F09 API Playground endpoint catalog static data.

The catalog is hand-authored JS, but every entry must satisfy invariants the
proxy routing relies on. We parse the catalog block with regex (the format is
strictly regular) and assert each entry.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PLAYGROUND_JS = REPO_ROOT / "src" / "frontend" / "js" / "api-playground.js"

VALID_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
VALID_TOKEN_TYPES = {"bearer", "mwc", "none"}
VALID_DANGER = {"safe", "caution", "destructive"}


def _read_catalog_block() -> str:
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    match = re.search(r"var ENDPOINT_CATALOG\s*=\s*\[(.*?)\n\];", src, re.DOTALL)
    assert match, "ENDPOINT_CATALOG declaration not found"
    return match.group(1)


def _read_groups_block() -> str:
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    match = re.search(r"var ENDPOINT_GROUPS\s*=\s*\[(.*?)\n\];", src, re.DOTALL)
    assert match, "ENDPOINT_GROUPS declaration not found"
    return match.group(1)


def _parse_entries(block: str) -> list[dict]:
    entries: list[dict] = []
    field_re = re.compile(r"(\w+):\s*'([^']*)'")
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        fields = dict(field_re.findall(stripped))
        if fields:
            entries.append(fields)
    return entries


def _parse_group_ids(block: str) -> set[str]:
    return set(re.findall(r"id:\s*'([^']+)'", block))


@pytest.fixture(scope="module")
def catalog() -> list[dict]:
    return _parse_entries(_read_catalog_block())


@pytest.fixture(scope="module")
def group_ids() -> set[str]:
    return _parse_group_ids(_read_groups_block())


def test_catalog_not_empty(catalog: list[dict]) -> None:
    assert len(catalog) >= 20, f"Catalog suspiciously small: {len(catalog)} entries"


def test_every_entry_has_required_fields(catalog: list[dict]) -> None:
    required = {"id", "name", "method", "urlTemplate", "group", "tokenType", "dangerLevel"}
    for entry in catalog:
        missing = required - set(entry.keys())
        assert not missing, f"Entry {entry.get('id', '?')} missing fields: {missing}"


def test_ids_are_unique(catalog: list[dict]) -> None:
    ids = [e["id"] for e in catalog]
    duplicates = {x for x in ids if ids.count(x) > 1}
    assert not duplicates, f"Duplicate catalog ids: {duplicates}"


def test_methods_are_valid(catalog: list[dict]) -> None:
    for entry in catalog:
        assert entry["method"] in VALID_METHODS, f"{entry['id']}: invalid method {entry['method']!r}"


def test_token_types_are_valid(catalog: list[dict]) -> None:
    for entry in catalog:
        assert entry["tokenType"] in VALID_TOKEN_TYPES, f"{entry['id']}: invalid tokenType {entry['tokenType']!r}"


def test_danger_levels_are_valid(catalog: list[dict]) -> None:
    for entry in catalog:
        assert entry["dangerLevel"] in VALID_DANGER, f"{entry['id']}: invalid dangerLevel {entry['dangerLevel']!r}"


def test_groups_reference_existing_group_ids(catalog: list[dict], group_ids: set[str]) -> None:
    for entry in catalog:
        assert entry["group"] in group_ids, f"{entry['id']}: group {entry['group']!r} not in ENDPOINT_GROUPS"


def test_url_templates_are_relative_paths(catalog: list[dict]) -> None:
    """Every catalog URL must be a path the proxy can route — no external hosts."""
    for entry in catalog:
        url = entry["urlTemplate"]
        assert url.startswith("/"), f"{entry['id']}: urlTemplate {url!r} must start with '/' (proxy routes by path)"
        assert "://" not in url, f"{entry['id']}: urlTemplate must not contain a scheme"


def test_no_fabric_base_url_placeholder(catalog: list[dict]) -> None:
    """Legacy {fabricBaseUrl} prefix should be gone — proxy handles host resolution."""
    for entry in catalog:
        assert "{fabricBaseUrl}" not in entry["urlTemplate"], (
            f"{entry['id']}: urlTemplate still contains legacy {{fabricBaseUrl}} placeholder"
        )


def test_mwc_paths_target_flt_controllers(catalog: list[dict]) -> None:
    """MWC entries must hit the FLT controller paths the /api/flt-proxy backend serves."""
    flt_prefixes = ("/liveTable", "/liveTableSchedule", "/liveTableMaintanance")
    for entry in catalog:
        if entry["tokenType"] != "mwc":
            continue
        assert entry["urlTemplate"].startswith(flt_prefixes), (
            f"{entry['id']}: mwc urlTemplate {entry['urlTemplate']!r} must start with one of {flt_prefixes}"
        )


def test_bearer_paths_target_fabric_v1(catalog: list[dict]) -> None:
    """Bearer entries must target Fabric REST v1 routes the /api/fabric backend serves."""
    for entry in catalog:
        if entry["tokenType"] != "bearer":
            continue
        assert entry["urlTemplate"].startswith("/v1/"), (
            f"{entry['id']}: bearer urlTemplate {entry['urlTemplate']!r} must start with '/v1/'"
        )


def test_no_orphan_proxy_endpoint_in_source() -> None:
    """The phantom /api/playground/proxy was never implemented — guard against regression."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "/api/playground/proxy" not in src, (
        "Frontend still references /api/playground/proxy \u2014 that endpoint never existed; "
        "route via /api/playground/dispatch instead."
    )


def test_playground_uses_dispatcher_not_prefix_proxies() -> None:
    """Playground must POST to the dispatcher; never hit /api/fabric or /api/flt-proxy directly.

    Those are DAG Studio's prefix proxies and don't forward custom headers. The
    playground needs the dispatcher's allowlisted header forwarding.
    """
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "/api/playground/dispatch" in src, (
        "Playground frontend must call /api/playground/dispatch"
    )
    # The deprecated _buildProxyUrl helper has been removed; assert it
    # didn't sneak back in.
    assert "_buildProxyUrl" not in src, (
        "_buildProxyUrl was removed \u2014 routing happens server-side now"
    )
    assert "'/api/fabric'" not in src and '"/api/fabric"' not in src, (
        "Playground must not hard-code /api/fabric \u2014 dispatcher handles routing"
    )
    assert "'/api/flt-proxy'" not in src and '"/api/flt-proxy"' not in src, (
        "Playground must not hard-code /api/flt-proxy \u2014 dispatcher handles routing"
    )
