"""Integration tests for F09 API Playground dispatcher with mocked upstream.

These tests exercise _serve_playground_dispatch end-to-end by instantiating
a minimal fake handler and patching urllib.request.urlopen.
"""
import importlib.util
import io
import json
import sys
import urllib.error
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEV_SERVER = PROJECT_DIR / "scripts" / "dev-server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("edog_dev_server", DEV_SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(DEV_SERVER.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


class FakeHandler:
    """Minimal stand-in for EdogDevHandler exposing the surface the dispatcher uses."""

    def __init__(self, envelope):
        body = json.dumps(envelope).encode("utf-8")
        self.headers = {"Content-Length": str(len(body)), "Content-Type": "application/json"}
        self.rfile = io.BytesIO(body)
        self.response_status = None
        self.response_payload = None

    def _json_response(self, status, payload):
        self.response_status = status
        self.response_payload = payload


def _make_dispatcher(srv):
    """Return _serve_playground_dispatch bound to a FakeHandler instance."""
    # Bind the unbound method from EdogDevHandler to FakeHandler
    return srv.EdogDevHandler._serve_playground_dispatch


def call_dispatch(srv, envelope, captured_req=None):
    """Invoke the dispatcher with `envelope`, return the FakeHandler."""
    handler = FakeHandler(envelope)
    fn = _make_dispatcher(srv)
    fn(handler)
    return handler


@contextmanager
def patched_environment(srv, *, bearer="fake-bearer", config=None, mwc=("fake-mwc", "https://capacity.example")):
    """Patch token cache, config, MWC token resolution. Each patch applied lazily."""
    if config is None:
        config = {
            "workspace_id": "WS",
            "artifact_id": "AID",
            "capacity_id": "CAP",
        }
    fake_config_path = MagicMock()
    fake_config_path.exists.return_value = True
    fake_config_path.read_text.return_value = json.dumps(config)
    with patch.object(srv, "_read_cache", return_value=(bearer, 9999999999)), \
         patch.object(srv, "_get_mwc_token", return_value=mwc), \
         patch.object(srv, "CONFIG_PATH", fake_config_path):
        yield


def make_upstream_response(status=200, reason="OK", body=b'{"value":[]}', headers=None):
    """Build a context-manager mock matching urllib.response.addinfourl."""
    headers = headers or [("Content-Type", "application/json")]
    resp = MagicMock()
    resp.status = status
    resp.reason = reason
    resp.headers = MagicMock()
    resp.headers.items.return_value = list(headers)
    resp.read = MagicMock(side_effect=[body])
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=resp)
    cm.__exit__ = MagicMock(return_value=False)
    return cm


# ── Happy paths ──────────────────────────────────────────────────────────


def test_dispatch_bearer_happy_path(srv):
    captured = {}

    def fake_urlopen(req, timeout=30, context=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["headers"] = dict(req.header_items())
        captured["data"] = req.data
        return make_upstream_response(200, "OK", b'{"value":[{"id":"x"}]}')

    envelope = {
        "tokenType": "bearer",
        "method": "GET",
        "path": "/v1/workspaces",
        "headers": {"Accept": "application/json", "x-ms-client-request-id": "req-1"},
    }
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    assert h.response_status == 200
    payload = h.response_payload
    assert payload["status"] == 200
    assert payload["statusText"] == "OK"
    assert payload["headers"]["Content-Type"] == "application/json"
    assert payload["body"] == '{"value":[{"id":"x"}]}'
    assert payload["bodySize"] == len(b'{"value":[{"id":"x"}]}')
    assert payload["truncated"] is False
    assert payload["duration"] >= 0

    # Upstream URL composition
    assert captured["url"] == srv.REDIRECT_HOST + "/v1/workspaces"
    assert captured["method"] == "GET"
    # Custom headers forwarded; Authorization injected by dispatcher
    hdrs = {k.lower(): v for k, v in captured["headers"].items()}
    assert hdrs["accept"] == "application/json"
    assert hdrs["x-ms-client-request-id"] == "req-1"
    assert hdrs["authorization"] == "Bearer fake-bearer"


def test_dispatch_mwc_happy_path(srv):
    captured = {}

    def fake_urlopen(req, timeout=30, context=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        return make_upstream_response(200, "OK", b'{"dag":{}}')

    envelope = {
        "tokenType": "mwc",
        "method": "GET",
        "path": "/liveTable/getLatestDag?showExtendedLineage=true",
        "headers": {"Prefer": "respond-async"},
    }
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    assert h.response_status == 200
    assert h.response_payload["status"] == 200
    assert captured["url"].startswith("https://capacity.example/webapi/capacities/CAP/")
    assert captured["url"].endswith("/lakehouses/AID/liveTable/getLatestDag?showExtendedLineage=true")
    hdrs = {k.lower(): v for k, v in captured["headers"].items()}
    assert hdrs["authorization"] == "MwcToken fake-mwc"
    assert hdrs["prefer"] == "respond-async"


def test_dispatch_post_with_body(srv):
    captured = {}

    def fake_urlopen(req, timeout=30, context=None):
        captured["data"] = req.data
        captured["method"] = req.get_method()
        captured["headers"] = dict(req.header_items())
        return make_upstream_response(201, "Created", b'{"id":"abc"}')

    envelope = {
        "tokenType": "bearer",
        "method": "POST",
        "path": "/v1/workspaces",
        "headers": {"Content-Type": "application/json"},
        "body": '{"displayName":"new"}',
    }
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    assert h.response_payload["status"] == 201
    assert captured["data"] == b'{"displayName":"new"}'
    assert captured["method"] == "POST"
    hdrs = {k.lower(): v for k, v in captured["headers"].items()}
    assert hdrs["content-type"] == "application/json"


def test_dispatch_default_content_type_for_body(srv):
    """When body present but no Content-Type, dispatcher injects application/json."""
    captured = {}

    def fake_urlopen(req, timeout=30, context=None):
        captured["headers"] = dict(req.header_items())
        return make_upstream_response(200, "OK", b'{}')

    envelope = {
        "tokenType": "bearer",
        "method": "POST",
        "path": "/v1/workspaces",
        "body": "{}",
    }
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        call_dispatch(srv, envelope)

    hdrs = {k.lower(): v for k, v in captured["headers"].items()}
    assert hdrs.get("content-type") == "application/json"


# ── Header forwarding policy ─────────────────────────────────────────────


def test_denylist_headers_never_reach_upstream(srv):
    captured = {}

    def fake_urlopen(req, timeout=30, context=None):
        captured["headers"] = dict(req.header_items())
        return make_upstream_response()

    envelope = {
        "tokenType": "bearer",
        "method": "GET",
        "path": "/v1/workspaces",
        "headers": {
            "Authorization": "Bearer fake-evil",
            "Cookie": "session=stolen",
            "Connection": "keep-alive",
            "Host": "evil.com",
            "Content-Length": "999",
            "Origin": "http://localhost:5555",
            "User-Agent": "browser",
            "Accept-Encoding": "gzip",
            "Accept": "application/json",  # allowed, should survive
        },
    }
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        call_dispatch(srv, envelope)

    hdrs = {k.lower(): v for k, v in captured["headers"].items()}
    # Allowed
    assert hdrs["accept"] == "application/json"
    # Dispatcher's own auth, not client's
    assert hdrs["authorization"] == "Bearer fake-bearer"
    # Denylisted — none of these should be present
    for bad in ("cookie", "connection", "host", "origin", "user-agent", "accept-encoding"):
        assert bad not in hdrs, f"header {bad!r} leaked to upstream"
    # Content-Length is allowed to be re-emitted by urllib for body-bearing requests,
    # but the *client-supplied* value should be discarded. urllib adds its own based
    # on the actual body, which is None here, so it should not appear.
    assert "content-length" not in hdrs


def test_crlf_injection_rejected(srv):
    envelope = {
        "tokenType": "bearer",
        "method": "GET",
        "path": "/v1/x",
        "headers": {"X-Custom": "ok\r\nX-Injected: yes"},
    }
    with patched_environment(srv):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 400
    assert h.response_payload["error"] == "bad_header"


def test_invalid_header_name_rejected(srv):
    envelope = {
        "tokenType": "bearer",
        "method": "GET",
        "path": "/v1/x",
        "headers": {"Bad Name": "value"},
    }
    with patched_environment(srv):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 400
    assert h.response_payload["error"] == "bad_header"


# ── Path policy ──────────────────────────────────────────────────────────


def test_absolute_url_rejected(srv):
    envelope = {"tokenType": "bearer", "method": "GET", "path": "https://evil.com/x"}
    with patched_environment(srv):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 400
    assert h.response_payload["error"] == "invalid_path"


def test_wrong_prefix_for_bearer(srv):
    envelope = {"tokenType": "bearer", "method": "GET", "path": "/liveTable/x"}
    with patched_environment(srv):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 400
    assert h.response_payload["error"] == "invalid_path"


def test_wrong_prefix_for_mwc(srv):
    envelope = {"tokenType": "mwc", "method": "GET", "path": "/v1/workspaces"}
    with patched_environment(srv):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 400
    assert h.response_payload["error"] == "invalid_path"


# ── Body size ─────────────────────────────────────────────────────────────


def test_body_too_large_rejected(srv):
    envelope = {
        "tokenType": "bearer",
        "method": "POST",
        "path": "/v1/x",
        "body": "x" * (srv._PLAYGROUND_MAX_REQUEST_BODY_BYTES + 1),
    }
    with patched_environment(srv):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 413
    assert h.response_payload["error"] == "body_too_large"


def test_response_truncation(srv):
    huge = b"a" * (srv._PLAYGROUND_MAX_RESPONSE_BODY_BYTES + 1024)

    def fake_urlopen(req, timeout=30, context=None):
        return make_upstream_response(200, "OK", huge)

    envelope = {"tokenType": "bearer", "method": "GET", "path": "/v1/x"}
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    payload = h.response_payload
    assert payload["truncated"] is True
    assert payload["bodySize"] == srv._PLAYGROUND_MAX_RESPONSE_BODY_BYTES
    assert len(payload["body"]) == srv._PLAYGROUND_MAX_RESPONSE_BODY_BYTES


# ── Upstream failures vs dispatcher failures ─────────────────────────────


def test_upstream_500_is_data_not_error(srv):
    """Upstream non-2xx -> dispatcher HTTP 200, envelope status=500."""

    def fake_urlopen(req, timeout=30, context=None):
        raise urllib.error.HTTPError(
            req.full_url, 500, "Internal Server Error",
            hdrs=None, fp=io.BytesIO(b'{"error":"upstream broke"}'),
        )

    envelope = {"tokenType": "bearer", "method": "GET", "path": "/v1/x"}
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    assert h.response_status == 200, "dispatcher should return 200 for upstream non-2xx"
    assert h.response_payload["status"] == 500
    assert h.response_payload["statusText"] == "Internal Server Error"
    assert h.response_payload["body"] == '{"error":"upstream broke"}'


def test_upstream_401_envelope(srv):
    def fake_urlopen(req, timeout=30, context=None):
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized",
            hdrs=None, fp=io.BytesIO(b""),
        )

    envelope = {"tokenType": "bearer", "method": "GET", "path": "/v1/x"}
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    assert h.response_status == 200
    assert h.response_payload["status"] == 401


def test_upstream_timeout_returns_504(srv):
    def fake_urlopen(req, timeout=30, context=None):
        raise urllib.error.URLError("timed out")

    envelope = {"tokenType": "bearer", "method": "GET", "path": "/v1/x", "timeout": 5}
    with patched_environment(srv), patch.object(srv.urllib.request, "urlopen", side_effect=fake_urlopen):
        h = call_dispatch(srv, envelope)

    assert h.response_status == 504
    assert h.response_payload["error"] == "upstream_timeout"


def test_no_bearer_returns_401(srv):
    envelope = {"tokenType": "bearer", "method": "GET", "path": "/v1/x"}
    with patched_environment(srv, bearer=""):
        h = call_dispatch(srv, envelope)
    assert h.response_status == 401
    assert h.response_payload["error"] == "no_token"


def test_flt_not_configured_returns_503(srv):
    envelope = {"tokenType": "mwc", "method": "GET", "path": "/liveTable/x"}
    with patched_environment(srv, config={}):  # empty config
        h = call_dispatch(srv, envelope)
    assert h.response_status == 503
    assert h.response_payload["error"] == "flt_not_configured"


def test_mwc_token_error_returns_502(srv):
    envelope = {"tokenType": "mwc", "method": "GET", "path": "/liveTable/x"}
    fake_config_path = MagicMock()
    fake_config_path.exists.return_value = True
    fake_config_path.read_text.return_value = json.dumps({
        "workspace_id": "WS", "artifact_id": "AID", "capacity_id": "CAP",
    })
    with patch.object(srv, "_read_cache", return_value=("fake-bearer", 9999999999)), \
         patch.object(srv, "_get_mwc_token", side_effect=RuntimeError("token api down")), \
         patch.object(srv, "CONFIG_PATH", fake_config_path):
        h = call_dispatch(srv, envelope)

    assert h.response_status == 502
    assert h.response_payload["error"] == "mwc_token_error"


# ── Malformed envelope ───────────────────────────────────────────────────


def test_invalid_json_body_rejected(srv):
    handler = FakeHandler({})
    # Override with garbage
    raw = b"not json {"
    handler.rfile = io.BytesIO(raw)
    handler.headers = {"Content-Length": str(len(raw))}
    fn = _make_dispatcher(srv)
    fn(handler)
    assert handler.response_status == 400
    assert handler.response_payload["error"] == "bad_request"
