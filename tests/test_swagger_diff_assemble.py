"""Tests for SF-010 assemble glue: scripts/swagger_diff_assemble.py.

Composes path-level, operation-level, and schema-level diffs into the
single response payload the frontend renders:

    {
      "summary": {
        "endpoints": {"added": N, "removed": N, "modified": N},
        "schemas":   {"added": N, "removed": N, "modified": N},
        "totalChanges": N
      },
      "changes": [
        {"id": "ch-001",
         "category": "endpoints" | "schemas",
         "type": "added" | "removed" | "modified",
         "key": "POST /api/v2/tables" | "User",
         [oldValue], [newValue], [subChanges]}
      ]
    }
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_diff_assemble import build_diff_payload  # noqa: E402


def _norm(operations=None, schemas=None, version="openapi-3.0"):
    return {
        "version": version,
        "info": {},
        "operations": operations or {},
        "schemas": schemas or {},
    }


class TestEmptyDiff:
    def test_identical_specs(self):
        spec = _norm(
            operations={"GET /x": {"responses": {"200": {"description": "ok"}}}},
            schemas={"User": {"type": "object"}},
        )
        payload = build_diff_payload(spec, spec)
        assert payload["summary"]["totalChanges"] == 0
        assert payload["summary"]["endpoints"] == {"added": 0, "removed": 0, "modified": 0}
        assert payload["summary"]["schemas"] == {"added": 0, "removed": 0, "modified": 0}
        assert payload["changes"] == []


class TestEndpointDiffs:
    def test_endpoint_added(self):
        left = _norm()
        right = _norm(operations={"GET /x": {"responses": {"200": {"description": "ok"}}}})
        payload = build_diff_payload(left, right)
        assert payload["summary"]["endpoints"] == {"added": 1, "removed": 0, "modified": 0}
        assert payload["summary"]["totalChanges"] == 1
        [change] = payload["changes"]
        assert change["category"] == "endpoints"
        assert change["type"] == "added"
        assert change["key"] == "GET /x"
        assert "newValue" in change
        assert "id" in change

    def test_endpoint_modified_carries_subchanges(self):
        left = _norm(operations={"GET /x": {
            "summary": "old",
            "parameters": [],
            "responses": {"200": {"description": "ok"}},
        }})
        right = _norm(operations={"GET /x": {
            "summary": "new",
            "parameters": [],
            "responses": {"200": {"description": "ok"}},
        }})
        payload = build_diff_payload(left, right)
        [change] = payload["changes"]
        assert change["type"] == "modified"
        assert change["subChanges"] == [{
            "subType": "metadata-changed",
            "detail": "summary",
            "oldValue": "old",
            "newValue": "new",
        }]


class TestSchemaDiffs:
    def test_schema_added(self):
        payload = build_diff_payload(_norm(), _norm(schemas={"User": {"type": "object"}}))
        assert payload["summary"]["schemas"] == {"added": 1, "removed": 0, "modified": 0}
        [change] = payload["changes"]
        assert change["category"] == "schemas"
        assert change["key"] == "User"

    def test_schema_modified_carries_subchanges(self):
        left = _norm(schemas={"User": {"type": "object",
                                        "properties": {"id": {"type": "string"}}}})
        right = _norm(schemas={"User": {"type": "object",
                                         "properties": {"id": {"type": "integer"}}}})
        payload = build_diff_payload(left, right)
        [change] = payload["changes"]
        assert change["category"] == "schemas"
        assert change["type"] == "modified"
        assert change["subChanges"] == [{
            "subType": "property-modified",
            "detail": "id",
            "oldValue": {"type": "string"},
            "newValue": {"type": "integer"},
        }]


class TestCombined:
    def test_endpoints_and_schemas_together(self):
        left = _norm(
            operations={"GET /a": {"responses": {"200": {"description": "ok"}}}},
            schemas={"Old": {"type": "object"}},
        )
        right = _norm(
            operations={
                "GET /a": {"responses": {"200": {"description": "ok"}}},
                "POST /b": {"responses": {"201": {"description": "ok"}}},
            },
            schemas={"New": {"type": "object"}},
        )
        payload = build_diff_payload(left, right)
        assert payload["summary"] == {
            "endpoints": {"added": 1, "removed": 0, "modified": 0},
            "schemas": {"added": 1, "removed": 1, "modified": 0},
            "totalChanges": 3,
        }
        assert len(payload["changes"]) == 3


class TestChangeIds:
    def test_ids_are_zero_padded_and_unique(self):
        left = _norm()
        ops = {f"GET /e{i}": {"responses": {"200": {"description": "ok"}}} for i in range(12)}
        right = _norm(operations=ops)
        ids = [c["id"] for c in build_diff_payload(left, right)["changes"]]
        assert len(set(ids)) == len(ids)
        assert all(i.startswith("ch-") for i in ids)
        # Width >= 3 so sort-by-id matches sort-by-numeric-order
        assert all(len(i) >= 6 for i in ids)

    def test_ids_are_sequential(self):
        right = _norm(operations={
            "GET /a": {"responses": {"200": {"description": "ok"}}},
            "GET /b": {"responses": {"200": {"description": "ok"}}},
        })
        ids = [c["id"] for c in build_diff_payload(_norm(), right)["changes"]]
        assert ids == ["ch-001", "ch-002"]


class TestOrdering:
    def test_endpoints_come_before_schemas(self):
        left = _norm()
        right = _norm(
            operations={"GET /a": {"responses": {"200": {"description": "ok"}}}},
            schemas={"User": {"type": "object"}},
        )
        cats = [c["category"] for c in build_diff_payload(left, right)["changes"]]
        assert cats == ["endpoints", "schemas"]
