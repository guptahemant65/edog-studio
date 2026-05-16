"""Tests for SF-007: scripts/swagger_diff_paths.py.

Paths-level diff walker. Takes two normalized specs (output of
swagger_normalize.normalize) and emits a typed change list at the
operations layer:

    [{type: "added" | "removed" | "modified",
      key: "METHOD /path",
      [oldValue]: {operation_obj},
      [newValue]: {operation_obj}}, ...]

"modified" means the key exists in both sides but the operation bodies
differ. SF-008 (operation-level diff) is responsible for explaining HOW
they differ. SF-007 stays at the path layer.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_diff_paths import diff_paths  # noqa: E402


def _normd(operations):
    """Build a minimal normalized spec wrapper for diff_paths."""
    return {
        "version": "openapi-3.0",
        "info": {},
        "operations": operations,
        "schemas": {},
    }


class TestNoChanges:
    def test_empty_both_sides(self):
        assert diff_paths(_normd({}), _normd({})) == []

    def test_identical_single_op(self):
        op = {"operationId": "x", "parameters": [], "responses": {"200": {"description": "ok"}}}
        left = _normd({"GET /x": op})
        right = _normd({"GET /x": dict(op)})
        assert diff_paths(left, right) == []


class TestAddedRemoved:
    def test_added_endpoint(self):
        right_op = {"operationId": "new", "responses": {"201": {"description": "ok"}}}
        changes = diff_paths(_normd({}), _normd({"POST /things": right_op}))
        assert changes == [
            {
                "type": "added",
                "key": "POST /things",
                "newValue": right_op,
            }
        ]

    def test_removed_endpoint(self):
        left_op = {"operationId": "gone", "responses": {"200": {"description": "ok"}}}
        changes = diff_paths(_normd({"GET /old": left_op}), _normd({}))
        assert changes == [
            {
                "type": "removed",
                "key": "GET /old",
                "oldValue": left_op,
            }
        ]


class TestModified:
    def test_modified_when_operation_body_differs(self):
        left_op = {"operationId": "x", "summary": "old", "parameters": [], "responses": {"200": {"description": "ok"}}}
        right_op = {"operationId": "x", "summary": "new", "parameters": [], "responses": {"200": {"description": "ok"}}}
        changes = diff_paths(_normd({"GET /x": left_op}), _normd({"GET /x": right_op}))
        assert changes == [
            {
                "type": "modified",
                "key": "GET /x",
                "oldValue": left_op,
                "newValue": right_op,
            }
        ]

    def test_not_modified_when_dicts_equal(self):
        # Same data, different object identity, different key order — still equal.
        left_op = {"operationId": "x", "summary": "s", "responses": {"200": {"description": "ok"}}}
        right_op = {"summary": "s", "responses": {"200": {"description": "ok"}}, "operationId": "x"}
        changes = diff_paths(_normd({"GET /x": left_op}), _normd({"GET /x": right_op}))
        assert changes == []


class TestMixed:
    def test_added_removed_modified_together(self):
        left = _normd(
            {
                "GET /a": {"operationId": "a"},
                "GET /b": {"operationId": "b", "summary": "old"},
                "DELETE /c": {"operationId": "c"},
            }
        )
        right = _normd(
            {
                "GET /a": {"operationId": "a"},  # unchanged
                "GET /b": {"operationId": "b", "summary": "new"},  # modified
                "POST /d": {"operationId": "d"},  # added
                # DELETE /c removed
            }
        )
        changes = diff_paths(left, right)
        types_by_key = {c["key"]: c["type"] for c in changes}
        assert types_by_key == {
            "GET /b": "modified",
            "POST /d": "added",
            "DELETE /c": "removed",
        }


class TestStability:
    def test_output_sorted_by_key(self):
        left = _normd({})
        right = _normd(
            {
                "POST /z": {"operationId": "z"},
                "GET /a": {"operationId": "a"},
                "PUT /m": {"operationId": "m"},
            }
        )
        keys = [c["key"] for c in diff_paths(left, right)]
        assert keys == sorted(keys)

    def test_does_not_mutate_inputs(self):
        left_op = {"operationId": "x", "summary": "old"}
        right_op = {"operationId": "x", "summary": "new"}
        left = _normd({"GET /x": left_op})
        right = _normd({"GET /x": right_op})
        left_snapshot = {"keys": list(left["operations"].keys()), "op": dict(left["operations"]["GET /x"])}
        diff_paths(left, right)
        assert list(left["operations"].keys()) == left_snapshot["keys"]
        assert left["operations"]["GET /x"] == left_snapshot["op"]


class TestMissingOperationsField:
    def test_left_missing_operations_treated_as_empty(self):
        right_op = {"operationId": "new"}
        changes = diff_paths(
            {"version": "openapi-3.0", "info": {}, "schemas": {}},
            _normd({"GET /x": right_op}),
        )
        assert changes == [{"type": "added", "key": "GET /x", "newValue": right_op}]

    def test_both_missing_operations_yields_no_changes(self):
        assert (
            diff_paths(
                {"version": "openapi-3.0", "info": {}, "schemas": {}},
                {"version": "openapi-3.0", "info": {}, "schemas": {}},
            )
            == []
        )
