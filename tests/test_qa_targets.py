from scripts import qa_targets as t

RAW = {
    "value": [
        {
            "id": "ws-a",
            "displayName": "robust_goodfellow_18",
            "capacitySku": "F4",
            "lakehouses": [{"id": "lh1", "displayName": "rg_lh", "hasData": False}],
        },
        {
            "id": "ws-b",
            "displayName": "prod-mirror-eastus",
            "capacitySku": "F64",
            "lakehouses": [{"id": "lh2", "displayName": "pm_lh", "hasData": True}],
        },
    ]
}


def test_risk_flags():
    by = {m["workspace"]: m for m in t.build_menu(RAW)}
    assert by["robust_goodfellow_18"]["risk"] == "safe"
    assert by["prod-mirror-eastus"]["risk"] == "prod_like"


def test_lock_addressability():
    locked = t.lock_target(workspace="ws-a", lakehouse="lh1", capacity="c", created=False)
    assert t.is_addressable(locked, "ws-a", "lh1") and not t.is_addressable(locked, "ws-b", "lh2")


# The live /api/fabric/workspaces returns NO inline lakehouses — they must be
# fetched per workspace via /api/fabric/workspaces/{id}/lakehouses.
WS_NO_LH = {"value": [
    {"id": "ws-a", "displayName": "robust_goodfellow_18", "capacitySku": "F4"},
    {"id": "ws-b", "displayName": "prod-mirror-eastus", "capacitySku": "F64"},
]}


def test_build_menu_enriches_lakehouses_via_callback():
    fetched = {
        "ws-a": {"value": [{"id": "lh1", "displayName": "rg_lh", "hasData": False}]},
        "ws-b": {"value": [{"id": "lh2", "displayName": "pm_lh", "hasData": True}]},
    }
    menu = t.build_menu(WS_NO_LH, fetch_lakehouses=lambda wsid: fetched[wsid])
    by = {m["workspace"]: m for m in menu}
    assert by["robust_goodfellow_18"]["lakehouseId"] == "lh1"
    assert by["prod-mirror-eastus"]["risk"] == "prod_like"


def test_build_menu_empty_without_callback_when_no_inline_lakehouses():
    # The old behaviour (silent empty menu) is what the bug was — guard it:
    # without a fetcher and without inline lakehouses, the menu is empty, not crashing.
    assert t.build_menu(WS_NO_LH) == []


def test_build_menu_callback_failure_is_survived():
    def boom(_):
        raise RuntimeError("lakehouse fetch 500")
    assert t.build_menu(WS_NO_LH, fetch_lakehouses=boom) == []
