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
