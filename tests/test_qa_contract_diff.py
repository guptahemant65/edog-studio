from scripts import qa_contract_diff as cd


def _op(params=None, responses=("200",), body=False):
    op = {"responses": {c: {} for c in responses}}
    if params:
        op["parameters"] = params
    if body:
        op["requestBody"] = {}
    return op


MAIN = {
    "paths": {
        "/a": {"get": _op()},
        "/legacy": {"post": _op(responses=("200",))},
        "/gone": {"delete": _op()},
    }
}
PR = {
    "paths": {
        "/a": {"get": _op()},
        "/legacy": {"post": _op(responses=("200", "400"))},
        "/new": {"get": _op()},
    }
}


def test_changed_true_with_three_changes():
    r = cd.diff(MAIN, PR)
    assert r["changed"] is True and r["totalChanges"] == 3


def test_added_removed_modified_classified():
    kinds = {c["endpoint"]: c["kind"] for c in cd.diff(MAIN, PR)["changes"]}
    assert kinds["GET /new"] == "added"
    assert kinds["DELETE /gone"] == "removed"
    assert kinds["POST /legacy"] == "modified"


def test_breaking_excludes_pure_additions():
    eps = {c["endpoint"] for c in cd.diff(MAIN, PR)["breaking"]}
    assert eps == {"DELETE /gone", "POST /legacy"}


def test_identical_specs_unchanged():
    r = cd.diff(MAIN, MAIN)
    assert r["changed"] is False and r["breaking"] == []


def test_ids_are_stable_and_contiguous():
    ids = [c["id"] for c in cd.diff(MAIN, PR)["changes"]]
    assert ids == ["ch-001", "ch-002", "ch-003"]


def test_param_change_is_modified():
    main = {"paths": {"/x": {"get": _op(params=[{"name": "id", "in": "query", "required": False}])}}}
    pr = {"paths": {"/x": {"get": _op(params=[{"name": "id", "in": "query", "required": True}])}}}
    assert cd.diff(main, pr)["changes"][0]["kind"] == "modified"
