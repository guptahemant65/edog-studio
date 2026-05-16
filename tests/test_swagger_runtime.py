"""Tests for SF-003: scripts/swagger_runtime.py runtime fetcher."""

from __future__ import annotations

import io
import json
import sys
import urllib.error
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_runtime import (  # noqa: E402
    MAX_SWAGGER_BYTES,
    compose_swagger_url,
    fetch_runtime_swagger,
)


def _ok_token_provider(*_args, **_kwargs):
    return ("mwc-tok-123", "https://fabric.example.com")


def _make_http_get(body: bytes, status: int = 200, headers: dict | None = None):
    captured = {}

    def _get(url, hdrs, timeout):
        captured["url"] = url
        captured["headers"] = hdrs
        captured["timeout"] = timeout
        return body, status, headers or {}

    return _get, captured


class TestComposeUrl:
    def test_url_uses_capacity_and_workload(self):
        url = compose_swagger_url("https://fabric.example.com", "cap-abc")
        assert url == (
            "https://fabric.example.com/webapi/capacities/cap-abc/workloads/"
            "LiveTable/LiveTableService/automatic/swagger/v1/swagger.json"
        )


class TestHappyPath:
    def test_fetches_and_parses_swagger(self):
        spec = {"openapi": "3.0.1", "paths": {"/foo": {"get": {}}}}
        http_get, captured = _make_http_get(json.dumps(spec).encode("utf-8"))
        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=http_get,
        )
        assert err is None
        assert doc == spec
        assert "swagger/v1/swagger.json" in captured["url"]
        assert captured["headers"]["Authorization"] == "MwcToken mwc-tok-123"


class TestConfigErrors:
    def test_missing_ws_id_returns_missing_config(self):
        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
        )
        assert doc is None
        assert err["error"] == "missing-config"
        assert err["status"] == 503

    def test_missing_bearer_returns_unauthenticated(self):
        doc, err = fetch_runtime_swagger(
            bearer=None,
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
        )
        assert doc is None
        assert err["error"] == "unauthenticated"
        assert err["status"] == 401


class TestTokenErrors:
    def test_token_provider_raises_returns_mwc_token_failed(self):
        def boom(*_args, **_kwargs):
            raise RuntimeError("AADSTS500: expired")

        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=boom,
        )
        assert doc is None
        assert err["error"] == "mwc-token-failed"
        assert "AADSTS500" in err["message"]
        assert err["status"] == 502


class TestNetworkErrors:
    def test_url_error_returns_flt_not_running(self):
        def fail(*_args, **_kwargs):
            raise urllib.error.URLError("connection refused")

        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=fail,
        )
        assert doc is None
        assert err["error"] == "flt-not-running"
        assert err["status"] == 503

    def test_timeout_returns_flt_not_running(self):
        def fail(*_args, **_kwargs):
            raise TimeoutError("read timed out")

        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=fail,
        )
        assert doc is None
        assert err["error"] == "flt-not-running"

    def test_http_500_returns_spec_http_error(self):
        def fail(*_args, **_kwargs):
            raise urllib.error.HTTPError("url", 500, "Internal Server Error", {}, io.BytesIO(b"boom"))

        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=fail,
        )
        assert doc is None
        assert err["error"] == "spec-http-error"
        assert err["status"] == 500
        assert "boom" in err.get("detail", "")


class TestPayloadErrors:
    def test_non_json_body_returns_spec_not_json(self):
        http_get, _ = _make_http_get(b"<html>nope</html>")
        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=http_get,
        )
        assert doc is None
        assert err["error"] == "spec-not-json"

    def test_array_root_returns_spec_not_json(self):
        http_get, _ = _make_http_get(b"[]")
        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=http_get,
        )
        assert doc is None
        assert err["error"] == "spec-not-json"

    def test_too_large_payload_returns_spec_too_large(self):
        def fail(*_args, **_kwargs):
            raise ValueError("Swagger response exceeds limit")

        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=fail,
        )
        assert doc is None
        assert err["error"] == "spec-too-large"

    def test_non_2xx_status_returns_spec_http_error(self):
        http_get, _ = _make_http_get(b"{}", status=404)
        doc, err = fetch_runtime_swagger(
            bearer="ey",
            ws_id="ws",
            art_id="art",
            cap_id="cap",
            token_provider=_ok_token_provider,
            http_get=http_get,
        )
        assert doc is None
        assert err["error"] == "spec-http-error"
        assert err["status"] == 404


class TestSanityChecks:
    def test_max_swagger_bytes_is_sensible(self):
        # If someone bumps this to 1KB, swagger will mysteriously stop loading.
        assert MAX_SWAGGER_BYTES >= 1 * 1024 * 1024
