"""Tests for SF-006: scripts/swagger_normalize.py.

Local-only normalizer (no network, no validation). Lifts Swagger 2.0 and
OpenAPI 3.x specs to a single canonical shape suitable for diffing:

    {
        "version": "openapi-3.0" | "openapi-3.1" | "swagger-2.0",
        "info": {"title": ..., "version": ...},
        "operations": {"METHOD /path": {operation_obj}},
        "schemas": {"Name": {schema_obj}},
    }

$refs are kept as-is (not inlined). External $refs are flagged with
{"$unsupported": "external-$ref", "$ref": <original>}. No network calls.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_normalize import (  # noqa: E402
    SCHEMAS_REF_PREFIX,
    UNSUPPORTED_EXTERNAL_REF,
    normalize,
)


def _v3_spec(paths=None, schemas=None, info=None, openapi_version="3.0.1"):
    return {
        "openapi": openapi_version,
        "info": info or {"title": "T", "version": "1.0"},
        "paths": paths or {},
        "components": {"schemas": schemas or {}},
    }


def _v2_spec(paths=None, definitions=None, info=None, base_path=None):
    spec = {
        "swagger": "2.0",
        "info": info or {"title": "T", "version": "1.0"},
        "paths": paths or {},
        "definitions": definitions or {},
    }
    if base_path is not None:
        spec["basePath"] = base_path
    return spec


class TestVersionDetection:
    def test_openapi_30(self):
        out = normalize(_v3_spec(openapi_version="3.0.1"))
        assert out["version"] == "openapi-3.0"

    def test_openapi_31(self):
        out = normalize(_v3_spec(openapi_version="3.1.0"))
        assert out["version"] == "openapi-3.1"

    def test_swagger_20(self):
        out = normalize(_v2_spec())
        assert out["version"] == "swagger-2.0"

    def test_unknown_version_raises(self):
        with pytest.raises(ValueError, match="version"):
            normalize({"foo": "bar"})


class TestOperationKeys:
    def test_method_path_keys(self):
        spec = _v3_spec(paths={
            "/users": {
                "get": {"operationId": "listUsers", "responses": {"200": {"description": "ok"}}},
                "post": {"operationId": "createUser", "responses": {"201": {"description": "ok"}}},
            },
        })
        ops = normalize(spec)["operations"]
        assert set(ops.keys()) == {"GET /users", "POST /users"}
        assert ops["GET /users"]["operationId"] == "listUsers"
        assert ops["POST /users"]["operationId"] == "createUser"

    def test_methods_uppercased(self):
        spec = _v3_spec(paths={"/x": {"get": {"responses": {"200": {"description": "ok"}}}}})
        assert "GET /x" in normalize(spec)["operations"]

    def test_skips_non_http_keys(self):
        spec = _v3_spec(paths={
            "/x": {
                "parameters": [{"name": "id", "in": "query"}],
                "summary": "path summary",
                "get": {"responses": {"200": {"description": "ok"}}},
            },
        })
        ops = normalize(spec)["operations"]
        assert list(ops.keys()) == ["GET /x"]


class TestPathLevelParameterMerge:
    def test_path_params_merged_into_each_op(self):
        spec = _v3_spec(paths={
            "/users/{id}": {
                "parameters": [{"name": "id", "in": "path", "required": True}],
                "get": {
                    "parameters": [{"name": "verbose", "in": "query"}],
                    "responses": {"200": {"description": "ok"}},
                },
                "delete": {"responses": {"204": {"description": "ok"}}},
            },
        })
        ops = normalize(spec)["operations"]
        get_params = ops["GET /users/{id}"]["parameters"]
        delete_params = ops["DELETE /users/{id}"]["parameters"]
        get_names = [p["name"] for p in get_params]
        del_names = [p["name"] for p in delete_params]
        assert "id" in get_names and "verbose" in get_names
        assert "id" in del_names

    def test_op_param_overrides_path_param_on_same_in_name(self):
        spec = _v3_spec(paths={
            "/x": {
                "parameters": [{"name": "id", "in": "query", "required": False}],
                "get": {
                    "parameters": [{"name": "id", "in": "query", "required": True}],
                    "responses": {"200": {"description": "ok"}},
                },
            },
        })
        params = normalize(spec)["operations"]["GET /x"]["parameters"]
        ids = [p for p in params if p["name"] == "id"]
        assert len(ids) == 1
        assert ids[0]["required"] is True


class TestParameterSorting:
    def test_params_sorted_by_in_then_name(self):
        spec = _v3_spec(paths={
            "/x": {
                "get": {
                    "parameters": [
                        {"name": "z", "in": "query"},
                        {"name": "a", "in": "query"},
                        {"name": "h", "in": "header"},
                        {"name": "p", "in": "path", "required": True},
                    ],
                    "responses": {"200": {"description": "ok"}},
                },
            },
        })
        params = normalize(spec)["operations"]["GET /x"]["parameters"]
        keys = [(p["in"], p["name"]) for p in params]
        assert keys == sorted(keys)


class TestRefHandling:
    def test_local_component_ref_preserved_inline(self):
        spec = _v3_spec(
            paths={
                "/x": {
                    "get": {
                        "responses": {
                            "200": {
                                "description": "ok",
                                "content": {
                                    "application/json": {
                                        "schema": {"$ref": "#/components/schemas/User"},
                                    },
                                },
                            },
                        },
                    },
                },
            },
            schemas={"User": {"type": "object"}},
        )
        out = normalize(spec)
        op = out["operations"]["GET /x"]
        schema = op["responses"]["200"]["content"]["application/json"]["schema"]
        assert schema == {"$ref": "#/components/schemas/User"}

    def test_external_ref_marked_unsupported(self):
        spec = _v3_spec(paths={
            "/x": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "https://example.com/u.json#/User"},
                                },
                            },
                        },
                    },
                },
            },
        })
        out = normalize(spec)
        schema = out["operations"]["GET /x"]["responses"]["200"][
            "content"]["application/json"]["schema"]
        assert schema == {
            "$unsupported": UNSUPPORTED_EXTERNAL_REF,
            "$ref": "https://example.com/u.json#/User",
        }

    def test_file_ref_marked_unsupported(self):
        spec = _v3_spec(
            schemas={"Wrapper": {"$ref": "./shared.yaml#/Common"}},
        )
        out = normalize(spec)
        assert out["schemas"]["Wrapper"] == {
            "$unsupported": UNSUPPORTED_EXTERNAL_REF,
            "$ref": "./shared.yaml#/Common",
        }


class TestSchemasCollection:
    def test_v3_schemas_passthrough(self):
        schemas = {
            "User": {"type": "object", "properties": {"id": {"type": "string"}}},
            "Table": {"type": "object", "properties": {"name": {"type": "string"}}},
        }
        out = normalize(_v3_spec(schemas=schemas))
        assert out["schemas"] == schemas

    def test_empty_schemas(self):
        out = normalize(_v3_spec(schemas={}))
        assert out["schemas"] == {}


class TestV2Lift:
    def test_definitions_become_schemas(self):
        spec = _v2_spec(definitions={"User": {"type": "object"}})
        out = normalize(spec)
        assert out["schemas"] == {"User": {"type": "object"}}

    def test_base_path_prepended_to_paths(self):
        spec = _v2_spec(
            base_path="/api/v1",
            paths={"/users": {"get": {"responses": {"200": {"description": "ok"}}}}},
        )
        out = normalize(spec)
        assert "GET /api/v1/users" in out["operations"]

    def test_base_path_trailing_slash_stripped(self):
        spec = _v2_spec(
            base_path="/api/v1/",
            paths={"/users": {"get": {"responses": {"200": {"description": "ok"}}}}},
        )
        out = normalize(spec)
        assert "GET /api/v1/users" in out["operations"]

    def test_v2_definitions_ref_rewritten(self):
        spec = _v2_spec(
            paths={
                "/x": {
                    "get": {
                        "responses": {
                            "200": {
                                "description": "ok",
                                "schema": {"$ref": "#/definitions/User"},
                            },
                        },
                    },
                },
            },
            definitions={"User": {"type": "object"}},
        )
        out = normalize(spec)
        # After lift, response schema $ref points at components.schemas.User
        resp = out["operations"]["GET /x"]["responses"]["200"]
        assert resp["schema"] == {"$ref": f"{SCHEMAS_REF_PREFIX}User"}

    def test_v2_body_parameter_lifted_to_request_body(self):
        spec = _v2_spec(
            paths={
                "/users": {
                    "post": {
                        "parameters": [
                            {"name": "body", "in": "body",
                             "schema": {"$ref": "#/definitions/User"}},
                            {"name": "verbose", "in": "query"},
                        ],
                        "responses": {"201": {"description": "ok"}},
                    },
                },
            },
            definitions={"User": {"type": "object"}},
        )
        out = normalize(spec)
        op = out["operations"]["POST /users"]
        # Body parameter removed from parameters list
        param_names = [p["name"] for p in op["parameters"]]
        assert "body" not in param_names
        assert "verbose" in param_names
        # And lifted onto requestBody (with rewritten $ref)
        rb = op["requestBody"]
        assert rb["content"]["application/json"]["schema"] == {
            "$ref": f"{SCHEMAS_REF_PREFIX}User",
        }


class TestInfoAndEdgeCases:
    def test_info_passthrough(self):
        info = {"title": "FLT", "version": "1.2.3", "description": "FabricLiveTable"}
        out = normalize(_v3_spec(info=info))
        assert out["info"] == info

    def test_missing_paths_yields_empty_operations(self):
        out = normalize({"openapi": "3.0.0", "info": {"title": "T", "version": "1"}})
        assert out["operations"] == {}
        assert out["schemas"] == {}

    def test_does_not_mutate_input_spec(self):
        spec = _v3_spec(
            paths={"/x": {"get": {"responses": {"200": {"description": "ok"}}}}},
            schemas={"User": {"type": "object"}},
        )
        original = {
            "paths_keys": list(spec["paths"].keys()),
            "components": spec["components"].copy(),
        }
        normalize(spec)
        assert list(spec["paths"].keys()) == original["paths_keys"]
        assert spec["components"] == original["components"]

    def test_does_not_hit_network_with_external_refs(self, monkeypatch):
        """If we made a real HTTP call, this monkeypatch would crash the test."""
        import socket

        def boom(*_args, **_kwargs):
            raise AssertionError("normalizer attempted a network call")

        monkeypatch.setattr(socket, "socket", boom)
        spec = _v3_spec(
            paths={
                "/x": {
                    "get": {
                        "responses": {
                            "200": {
                                "description": "ok",
                                "content": {
                                    "application/json": {
                                        "schema": {"$ref": "http://example.com/u.json#/U"},
                                    },
                                },
                            },
                        },
                    },
                },
            },
        )
        out = normalize(spec)
        # No exception, external ref marked, no socket call.
        schema = out["operations"]["GET /x"]["responses"]["200"][
            "content"]["application/json"]["schema"]
        assert schema["$unsupported"] == UNSUPPORTED_EXTERNAL_REF
