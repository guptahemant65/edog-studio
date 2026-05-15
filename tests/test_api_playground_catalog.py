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
    # Bundled fallback is intentionally minimal — the LIVE catalog comes from
    # /api/playground/catalog (auto-discovered from FLT C# source). The bundled
    # list is the safety net for when flt_repo_path is not configured.
    assert len(catalog) >= 8, f"Bundled fallback suspiciously small: {len(catalog)} entries"


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


def test_bundled_catalog_is_flt_only(catalog: list[dict]) -> None:
    """The bundled fallback must contain ONLY FLT routes (mwc tokenType, /liveTable* paths).

    Generic Fabric APIs (workspaces, items, lakehouses, notebooks, environments)
    were intentionally removed in favor of the auto-discovered catalog. Re-adding
    them here would clutter the FLT engineer's workflow.
    """
    flt_prefixes = ("/liveTable", "/liveTableSchedule", "/liveTableMaintanance")
    for entry in catalog:
        assert entry["tokenType"] == "mwc", (
            f"{entry['id']}: bundled fallback must be mwc-only "
            f"(generic Fabric APIs should be auto-discovered, not bundled)"
        )
        assert entry["urlTemplate"].startswith(flt_prefixes), (
            f"{entry['id']}: bundled URL {entry['urlTemplate']!r} is not an FLT route"
        )


def test_playground_fetches_dynamic_catalog() -> None:
    """The frontend must call /api/playground/catalog to auto-discover FLT routes."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "/api/playground/catalog" in src, (
        "Frontend must fetch /api/playground/catalog for dynamic FLT route discovery"
    )
    assert "_loadDynamic" in src, (
        "EndpointCatalog must implement _loadDynamic for runtime auto-discovery"
    )


def test_no_generic_fabric_groups() -> None:
    """ENDPOINT_GROUPS must not include workspace/items/lakehouse/notebooks/environment groups."""
    src = _read_groups_block()
    forbidden = ("'workspace'", "'items'", "'lakehouse'", "'notebooks'", "'environment'")
    for term in forbidden:
        assert term not in src, (
            f"ENDPOINT_GROUPS still references {term} \u2014 generic Fabric APIs were removed; "
            f"auto-discovery covers FLT-only groups now."
        )


def test_request_builder_consumes_documented_query_params() -> None:
    """setRequest must store endpoint.queryParams for the Params tab pre-fill."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "_documentedParams" in src, (
        "RequestBuilder must store documented queryParams as _documentedParams"
    )
    assert "queryParams: endpoint.queryParams" in src, (
        "Catalog onSelect handler must forward endpoint.queryParams to setRequest"
    )


def test_param_row_renders_type_badge_for_documented_params() -> None:
    """_paramRow must render a type badge when given documented param metadata."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "api-param-type" in src, (
        "_paramRow must add an api-param-type badge for documented params"
    )
    assert "meta.required" in src, (
        "_paramRow must check meta.required to mark the row visually"
    )


def test_param_row_renders_select_for_known_enums() -> None:
    """_paramRow must render <select> for single enums; chip picker for enum-list."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "enumValues" in src, "_paramRow must consume meta.enumValues"
    assert "createElement('select')" in src, (
        "_paramRow must render a <select> element for single-value enum params"
    )


def test_param_row_renders_chip_picker_for_enum_list() -> None:
    """enum-list params must render a chip picker (not a native multi-select listbox)."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "api-param-chips" in src, (
        "enum-list must render a chip picker container (.api-param-chips)"
    )
    assert "api-param-chip" in src, (
        "enum-list must render individual chips (.api-param-chip)"
    )


def test_sync_url_handles_chip_picker() -> None:
    """_syncUrlFromParams must read selected chips and emit ?key=A&key=B."""
    src = PLAYGROUND_JS.read_text(encoding="utf-8")
    assert "api-param-chip.selected" in src, (
        "_syncUrlFromParams must query selected chips to build the query string"
    )
    # Legacy select.multiple branch retained as safety net
    assert "v.multiple" in src


def test_kv_key_cell_is_flex_layout() -> None:
    """.kv-key must use flex layout so type badge does not overflow into the value column."""
    css_path = PLAYGROUND_JS.parent.parent / "css" / "api-playground.css"
    css = css_path.read_text(encoding="utf-8")
    # Find the .kv-key rule and verify it sets display: flex
    import re
    m = re.search(r"\.api-kv-table \.kv-key\s*\{([^}]+)\}", css)
    assert m is not None, ".kv-key rule must exist"
    body = m.group(1)
    assert "flex" in body, ".kv-key must use display:flex to prevent badge overflow"
    assert "white-space: nowrap" not in body, (
        ".kv-key must NOT use white-space:nowrap (caused the type badge to overflow into kv-val)"
    )


def test_chip_picker_styled() -> None:
    """.api-param-chip and selected state must be styled."""
    css_path = PLAYGROUND_JS.parent.parent / "css" / "api-playground.css"
    css = css_path.read_text(encoding="utf-8")
    assert ".api-param-chip" in css
    assert ".api-param-chip.selected" in css, "Selected chip state must be styled"
    assert ".api-param-chips" in css, "Chip picker container must be styled"
