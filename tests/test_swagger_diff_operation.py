"""Tests for SF-008: scripts/swagger_diff_operation.py.

Operation-level diff. Given two operation dicts (already merged with
path-level params by the normalizer), produce a list of typed sub-changes:

    [{subType: "parameter-added" | "parameter-removed" | "parameter-modified"
              | "request-body-added" | "request-body-removed" | "request-body-modified"
              | "response-added" | "response-removed" | "response-modified"
              | "metadata-changed",
      detail: "<in>.<name>" | "<status>" | "<field>",
      [oldValue]: ...,
      [newValue]: ...}, ...]

Pure function. Output sorted by (subType, detail) for stable snapshots.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_diff_operation import diff_operation  # noqa: E402


def _op(parameters=None, request_body=None, responses=None, **meta):
    out = {"parameters": parameters or [], "responses": responses or {}}
    if request_body is not None:
        out["requestBody"] = request_body
    out.update(meta)
    return out


class TestNoChanges:
    def test_identical_ops(self):
        op = _op(parameters=[{"name": "id", "in": "query"}], responses={"200": {"description": "ok"}})
        assert diff_operation(op, dict(op)) == []


class TestParameters:
    def test_parameter_added(self):
        left = _op()
        right = _op(parameters=[{"name": "verbose", "in": "query"}])
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "parameter-added",
                "detail": "query.verbose",
                "newValue": {"name": "verbose", "in": "query"},
            }
        ]

    def test_parameter_removed(self):
        left = _op(parameters=[{"name": "id", "in": "path", "required": True}])
        right = _op()
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "parameter-removed",
                "detail": "path.id",
                "oldValue": {"name": "id", "in": "path", "required": True},
            }
        ]

    def test_parameter_modified_required_flip(self):
        left = _op(parameters=[{"name": "id", "in": "query", "required": False}])
        right = _op(parameters=[{"name": "id", "in": "query", "required": True}])
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "parameter-modified",
                "detail": "query.id",
                "oldValue": {"name": "id", "in": "query", "required": False},
                "newValue": {"name": "id", "in": "query", "required": True},
            }
        ]

    def test_parameter_modified_schema_changed(self):
        left = _op(parameters=[{"name": "id", "in": "query", "schema": {"type": "string"}}])
        right = _op(parameters=[{"name": "id", "in": "query", "schema": {"type": "integer"}}])
        changes = diff_operation(left, right)
        assert len(changes) == 1
        assert changes[0]["subType"] == "parameter-modified"
        assert changes[0]["detail"] == "query.id"

    def test_multiple_parameter_changes(self):
        left = _op(
            parameters=[
                {"name": "id", "in": "query"},
                {"name": "old", "in": "header"},
            ]
        )
        right = _op(
            parameters=[
                {"name": "id", "in": "query", "required": True},
                {"name": "new", "in": "query"},
            ]
        )
        changes = diff_operation(left, right)
        sub_types = sorted((c["subType"], c["detail"]) for c in changes)
        assert sub_types == [
            ("parameter-added", "query.new"),
            ("parameter-modified", "query.id"),
            ("parameter-removed", "header.old"),
        ]


class TestRequestBody:
    def test_request_body_added(self):
        left = _op()
        right = _op(request_body={"content": {"application/json": {"schema": {}}}})
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "request-body-added",
                "detail": "requestBody",
                "newValue": {"content": {"application/json": {"schema": {}}}},
            }
        ]

    def test_request_body_removed(self):
        left = _op(request_body={"content": {"application/json": {"schema": {}}}})
        right = _op()
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "request-body-removed",
                "detail": "requestBody",
                "oldValue": {"content": {"application/json": {"schema": {}}}},
            }
        ]

    def test_request_body_modified(self):
        left = _op(
            request_body={
                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/A"}}},
            }
        )
        right = _op(
            request_body={
                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/B"}}},
            }
        )
        changes = diff_operation(left, right)
        assert len(changes) == 1
        assert changes[0]["subType"] == "request-body-modified"
        assert changes[0]["detail"] == "requestBody"


class TestResponses:
    def test_response_added(self):
        left = _op(responses={"200": {"description": "ok"}})
        right = _op(
            responses={
                "200": {"description": "ok"},
                "404": {"description": "not found"},
            }
        )
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "response-added",
                "detail": "404",
                "newValue": {"description": "not found"},
            }
        ]

    def test_response_removed(self):
        left = _op(
            responses={
                "200": {"description": "ok"},
                "500": {"description": "boom"},
            }
        )
        right = _op(responses={"200": {"description": "ok"}})
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "response-removed",
                "detail": "500",
                "oldValue": {"description": "boom"},
            }
        ]

    def test_response_modified(self):
        left = _op(
            responses={"200": {"description": "ok", "content": {"application/json": {"schema": {"type": "object"}}}}}
        )
        right = _op(
            responses={"200": {"description": "ok", "content": {"application/json": {"schema": {"type": "array"}}}}}
        )
        changes = diff_operation(left, right)
        assert len(changes) == 1
        assert changes[0]["subType"] == "response-modified"
        assert changes[0]["detail"] == "200"


class TestMetadata:
    def test_summary_change_emits_metadata(self):
        left = _op(summary="old")
        right = _op(summary="new")
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "metadata-changed",
                "detail": "summary",
                "oldValue": "old",
                "newValue": "new",
            }
        ]

    def test_deprecated_flip(self):
        left = _op(deprecated=False)
        right = _op(deprecated=True)
        changes = diff_operation(left, right)
        assert {"subType": "metadata-changed", "detail": "deprecated", "oldValue": False, "newValue": True} in changes

    def test_tags_change(self):
        left = _op(tags=["a"])
        right = _op(tags=["a", "b"])
        changes = diff_operation(left, right)
        assert changes == [
            {
                "subType": "metadata-changed",
                "detail": "tags",
                "oldValue": ["a"],
                "newValue": ["a", "b"],
            }
        ]

    def test_operation_id_change(self):
        changes = diff_operation(_op(operationId="x"), _op(operationId="y"))
        assert changes == [
            {
                "subType": "metadata-changed",
                "detail": "operationId",
                "oldValue": "x",
                "newValue": "y",
            }
        ]

    def test_description_change_is_metadata(self):
        changes = diff_operation(_op(description="old"), _op(description="new"))
        assert any(c["detail"] == "description" for c in changes)


class TestStability:
    def test_output_sorted_by_subtype_then_detail(self):
        left = _op(
            parameters=[{"name": "z", "in": "query"}],
            responses={"200": {"description": "ok"}, "500": {"description": "ok"}},
        )
        right = _op(parameters=[{"name": "a", "in": "query"}], responses={"201": {"description": "new"}})
        changes = diff_operation(left, right)
        keys = [(c["subType"], c["detail"]) for c in changes]
        assert keys == sorted(keys)

    def test_does_not_mutate_inputs(self):
        left = _op(parameters=[{"name": "id", "in": "query"}])
        right = _op(parameters=[{"name": "id", "in": "query", "required": True}])
        left_snap = {"params": list(left["parameters"])}
        diff_operation(left, right)
        assert left["parameters"] == left_snap["params"]


class TestMixed:
    def test_param_and_response_and_meta_together(self):
        left = _op(
            summary="old summary",
            parameters=[{"name": "id", "in": "path", "required": True}],
            responses={"200": {"description": "ok"}},
        )
        right = _op(
            summary="new summary",
            parameters=[
                {"name": "id", "in": "path", "required": True},
                {"name": "verbose", "in": "query"},
            ],
            responses={"200": {"description": "ok"}, "404": {"description": "nf"}},
        )
        changes = diff_operation(left, right)
        types = {(c["subType"], c["detail"]) for c in changes}
        assert types == {
            ("parameter-added", "query.verbose"),
            ("response-added", "404"),
            ("metadata-changed", "summary"),
        }
