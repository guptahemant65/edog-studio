"""Tests for SF-009: scripts/swagger_diff_schemas.py.

Compares the ``schemas`` dict on two normalized specs and emits typed
changes. For modified schemas, sub-changes drill into properties,
required-list, type, and other fields:

    [{type: "schema-added" | "schema-removed" | "schema-modified",
      key: "<schema name>",
      [oldValue]: <schema>,
      [newValue]: <schema>,
      [subChanges]: [...]}, ...]

Sub-change shape (only on "schema-modified"):

    {subType: "property-added" | "property-removed" | "property-modified"
            | "required-changed" | "type-changed" | "field-changed",
     detail: "<field or property name>",
     [oldValue]: ..., [newValue]: ...}
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_diff_schemas import diff_schemas  # noqa: E402


def _normd(schemas):
    return {"version": "openapi-3.0", "info": {}, "operations": {}, "schemas": schemas}


class TestNoChanges:
    def test_empty(self):
        assert diff_schemas(_normd({}), _normd({})) == []

    def test_identical(self):
        s = {"User": {"type": "object", "properties": {"id": {"type": "string"}}}}
        assert diff_schemas(_normd(s), _normd(dict(s))) == []


class TestAddedRemoved:
    def test_schema_added(self):
        right = {"User": {"type": "object"}}
        changes = diff_schemas(_normd({}), _normd(right))
        assert changes == [
            {
                "type": "schema-added",
                "key": "User",
                "newValue": {"type": "object"},
            }
        ]

    def test_schema_removed(self):
        left = {"OldThing": {"type": "object"}}
        changes = diff_schemas(_normd(left), _normd({}))
        assert changes == [
            {
                "type": "schema-removed",
                "key": "OldThing",
                "oldValue": {"type": "object"},
            }
        ]


class TestModifiedSubChanges:
    def test_property_added(self):
        left = {"User": {"type": "object", "properties": {"id": {"type": "string"}}}}
        right = {"User": {"type": "object", "properties": {"id": {"type": "string"}, "email": {"type": "string"}}}}
        [change] = diff_schemas(_normd(left), _normd(right))
        assert change["type"] == "schema-modified"
        assert change["key"] == "User"
        assert change["subChanges"] == [
            {
                "subType": "property-added",
                "detail": "email",
                "newValue": {"type": "string"},
            }
        ]

    def test_property_removed(self):
        left = {"User": {"type": "object", "properties": {"id": {"type": "string"}, "legacy": {"type": "string"}}}}
        right = {"User": {"type": "object", "properties": {"id": {"type": "string"}}}}
        [change] = diff_schemas(_normd(left), _normd(right))
        assert change["subChanges"] == [
            {
                "subType": "property-removed",
                "detail": "legacy",
                "oldValue": {"type": "string"},
            }
        ]

    def test_property_modified(self):
        left = {"User": {"type": "object", "properties": {"id": {"type": "string"}}}}
        right = {"User": {"type": "object", "properties": {"id": {"type": "integer"}}}}
        [change] = diff_schemas(_normd(left), _normd(right))
        assert change["subChanges"] == [
            {
                "subType": "property-modified",
                "detail": "id",
                "oldValue": {"type": "string"},
                "newValue": {"type": "integer"},
            }
        ]

    def test_required_changed(self):
        left = {"User": {"type": "object", "required": ["id"]}}
        right = {"User": {"type": "object", "required": ["id", "email"]}}
        [change] = diff_schemas(_normd(left), _normd(right))
        assert change["subChanges"] == [
            {
                "subType": "required-changed",
                "detail": "required",
                "oldValue": ["id"],
                "newValue": ["id", "email"],
            }
        ]

    def test_type_changed(self):
        left = {"X": {"type": "object"}}
        right = {"X": {"type": "array"}}
        [change] = diff_schemas(_normd(left), _normd(right))
        assert change["subChanges"] == [
            {
                "subType": "type-changed",
                "detail": "type",
                "oldValue": "object",
                "newValue": "array",
            }
        ]

    def test_other_field_changed(self):
        left = {"X": {"type": "string", "format": "uuid"}}
        right = {"X": {"type": "string", "format": "email"}}
        [change] = diff_schemas(_normd(left), _normd(right))
        assert change["subChanges"] == [
            {
                "subType": "field-changed",
                "detail": "format",
                "oldValue": "uuid",
                "newValue": "email",
            }
        ]

    def test_multiple_sub_changes(self):
        left = {
            "User": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}, "legacy": {"type": "string"}},
            }
        }
        right = {
            "User": {
                "type": "object",
                "required": ["id", "email"],
                "properties": {"id": {"type": "integer"}, "email": {"type": "string"}},
            }
        }
        [change] = diff_schemas(_normd(left), _normd(right))
        subs = sorted((c["subType"], c["detail"]) for c in change["subChanges"])
        assert subs == [
            ("property-added", "email"),
            ("property-modified", "id"),
            ("property-removed", "legacy"),
            ("required-changed", "required"),
        ]


class TestStability:
    def test_top_level_sorted_by_key(self):
        right = {"Z": {"type": "object"}, "A": {"type": "object"}, "M": {"type": "object"}}
        keys = [c["key"] for c in diff_schemas(_normd({}), _normd(right))]
        assert keys == sorted(keys)

    def test_sub_changes_sorted(self):
        left = {"X": {"type": "object", "properties": {"z": {"type": "string"}, "a": {"type": "string"}}}}
        right = {"X": {"type": "object", "properties": {"m": {"type": "string"}}}}
        [change] = diff_schemas(_normd(left), _normd(right))
        keys = [(c["subType"], c["detail"]) for c in change["subChanges"]]
        assert keys == sorted(keys)

    def test_does_not_mutate(self):
        left = {"User": {"type": "object", "properties": {"id": {"type": "string"}}}}
        right = {"User": {"type": "object", "properties": {"id": {"type": "integer"}}}}
        l_snap = dict(left["User"])
        diff_schemas(_normd(left), _normd(right))
        assert left["User"] == l_snap


class TestMissingSchemas:
    def test_left_missing_schemas_field(self):
        right = {"User": {"type": "object"}}
        changes = diff_schemas(
            {"version": "openapi-3.0", "info": {}, "operations": {}},
            _normd(right),
        )
        assert changes == [
            {
                "type": "schema-added",
                "key": "User",
                "newValue": {"type": "object"},
            }
        ]
