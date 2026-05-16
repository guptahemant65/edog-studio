"""Tests for F09 API Playground dispatcher — validators and sanitizers.

These tests target pure functions in scripts/dev-server.py with no urllib
dependency. The full dispatcher (with mocked urlopen) is tested separately.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEV_SERVER = PROJECT_DIR / "scripts" / "dev-server.py"


@pytest.fixture(scope="module")
def srv():
    """Load dev-server.py as an importable module (its filename has a dash)."""
    spec = importlib.util.spec_from_file_location("edog_dev_server", DEV_SERVER)
    mod = importlib.util.module_from_spec(spec)
    # dev-server.py imports sibling modules (file_watcher, repo_discovery)
    sys.path.insert(0, str(DEV_SERVER.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


# ── _sanitize_playground_headers ─────────────────────────────────────────


def test_sanitize_none_returns_empty(srv):
    ok, out = srv._sanitize_playground_headers(None)
    assert ok is True
    assert out == {}


def test_sanitize_empty_dict(srv):
    ok, out = srv._sanitize_playground_headers({})
    assert ok is True
    assert out == {}


def test_sanitize_strips_denylist_silently(srv):
    raw = {
        "Authorization": "Bearer xxx",
        "Cookie": "session=abc",
        "Connection": "keep-alive",
        "Host": "evil.com",
        "Content-Length": "999",
        "Origin": "http://x",
        "User-Agent": "ua",
        "Accept": "application/json",
    }
    ok, out = srv._sanitize_playground_headers(raw)
    assert ok is True
    # Only Accept survives.
    assert list(out.keys()) == ["Accept"]
    assert out["Accept"] == "application/json"


def test_sanitize_preserves_allowed_custom(srv):
    raw = {
        "If-Match": '"etag123"',
        "Prefer": "respond-async",
        "x-ms-client-request-id": "req-1",
        "Accept-Language": "en-US",
        "Cache-Control": "no-cache",
    }
    ok, out = srv._sanitize_playground_headers(raw)
    assert ok is True
    assert out == raw


def test_sanitize_rejects_crlf_injection(srv):
    raw = {"X-Custom": "ok\r\nX-Injected: bad"}
    ok, err = srv._sanitize_playground_headers(raw)
    assert ok is False
    assert err["error"] == "bad_header"
    assert "forbidden characters" in err["message"]


def test_sanitize_rejects_bare_lf_injection(srv):
    raw = {"X-Custom": "ok\nX-Injected: bad"}
    ok, err = srv._sanitize_playground_headers(raw)
    assert ok is False
    assert err["error"] == "bad_header"


def test_sanitize_rejects_invalid_name_with_space(srv):
    raw = {"Foo Bar": "value"}
    ok, err = srv._sanitize_playground_headers(raw)
    assert ok is False
    assert err["error"] == "bad_header"
    assert "invalid header name" in err["message"]


def test_sanitize_rejects_invalid_name_with_colon(srv):
    raw = {"X-Foo:Bar": "value"}
    ok, err = srv._sanitize_playground_headers(raw)
    assert ok is False
    assert err["error"] == "bad_header"


def test_sanitize_rejects_too_many_headers(srv):
    raw = {f"X-H-{i}": "v" for i in range(srv._PLAYGROUND_MAX_HEADERS + 1)}
    ok, err = srv._sanitize_playground_headers(raw)
    assert ok is False
    assert "too many headers" in err["message"]


def test_sanitize_rejects_oversized_value(srv):
    raw = {"X-Big": "a" * (srv._PLAYGROUND_MAX_HEADER_VALUE_BYTES + 1)}
    ok, err = srv._sanitize_playground_headers(raw)
    assert ok is False
    assert "exceeds" in err["message"]


def test_sanitize_case_insensitive_dedup_last_wins(srv):
    raw = {"Accept": "application/json", "ACCEPT": "application/xml"}
    ok, out = srv._sanitize_playground_headers(raw)
    assert ok is True
    # Last one wins; only one Accept entry remains
    assert len(out) == 1
    assert next(iter(out.values())) == "application/xml"


def test_sanitize_rejects_non_string_value(srv):
    raw = {"Accept": 123}
    ok, _err = srv._sanitize_playground_headers(raw)
    assert ok is False


def test_sanitize_rejects_non_dict_input(srv):
    ok, err = srv._sanitize_playground_headers(["Accept", "x"])
    assert ok is False
    assert "must be an object" in err["message"]


# ── _validate_playground_envelope ────────────────────────────────────────


def _ok_bearer():
    return {"tokenType": "bearer", "method": "GET", "path": "/v1/workspaces"}


def _ok_mwc():
    return {"tokenType": "mwc", "method": "GET", "path": "/liveTable/getLatestDag"}


def test_validate_happy_bearer(srv):
    ok, parsed = srv._validate_playground_envelope(_ok_bearer())
    assert ok is True
    assert parsed["tokenType"] == "bearer"
    assert parsed["method"] == "GET"
    assert parsed["path"] == "/v1/workspaces"
    assert parsed["body"] is None
    assert parsed["timeout"] == srv._PLAYGROUND_DEFAULT_TIMEOUT


def test_validate_happy_mwc(srv):
    ok, parsed = srv._validate_playground_envelope(_ok_mwc())
    assert ok is True
    assert parsed["tokenType"] == "mwc"


def test_validate_bad_token_type(srv):
    env = _ok_bearer()
    env["tokenType"] = "magic"
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "bad_request"


def test_validate_missing_token_type(srv):
    env = {"method": "GET", "path": "/v1/x"}
    ok, _err = srv._validate_playground_envelope(env)
    assert ok is False


def test_validate_bad_method(srv):
    env = _ok_bearer()
    env["method"] = "TRACE"
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert "method must be one of" in err["message"]


def test_validate_method_normalized_to_upper(srv):
    env = _ok_bearer()
    env["method"] = "get"
    ok, parsed = srv._validate_playground_envelope(env)
    assert ok is True
    assert parsed["method"] == "GET"


def test_validate_rejects_absolute_url(srv):
    env = _ok_bearer()
    env["path"] = "https://evil.com/x"
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "invalid_path"


def test_validate_rejects_scheme_anywhere(srv):
    env = _ok_bearer()
    env["path"] = "/v1/foo?redirect=https://evil.com/x"
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "invalid_path"
    assert "absolute URLs" in err["message"]


def test_validate_rejects_protocol_relative(srv):
    env = _ok_bearer()
    env["path"] = "//evil.com/x"
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "invalid_path"


def test_validate_rejects_no_leading_slash(srv):
    env = _ok_bearer()
    env["path"] = "v1/x"
    ok, _err = srv._validate_playground_envelope(env)
    assert ok is False


def test_validate_bearer_rejects_mwc_prefix(srv):
    env = {"tokenType": "bearer", "method": "GET", "path": "/liveTable/getLatestDag"}
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "invalid_path"


def test_validate_mwc_rejects_bearer_prefix(srv):
    env = {"tokenType": "mwc", "method": "GET", "path": "/v1/workspaces"}
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "invalid_path"


def test_validate_bearer_accepts_metadata_path(srv):
    env = {"tokenType": "bearer", "method": "GET", "path": "/metadata/workspaces"}
    ok, _parsed = srv._validate_playground_envelope(env)
    assert ok is True


def test_validate_bearer_accepts_workspaces_legacy_path(srv):
    env = {"tokenType": "bearer", "method": "GET", "path": "/workspaces"}
    ok, _parsed = srv._validate_playground_envelope(env)
    assert ok is True


def test_validate_mwc_accepts_maintenance_typo(srv):
    env = {
        "tokenType": "mwc",
        "method": "GET",
        "path": "/liveTableMaintanance/getLockedDAGExecutionIteration",
    }
    ok, _parsed = srv._validate_playground_envelope(env)
    assert ok is True


def test_validate_body_too_large(srv):
    env = _ok_bearer()
    env["method"] = "POST"
    env["body"] = "x" * (srv._PLAYGROUND_MAX_REQUEST_BODY_BYTES + 1)
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "body_too_large"


def test_validate_body_encoded_to_bytes(srv):
    env = _ok_bearer()
    env["method"] = "POST"
    env["body"] = "hello"
    ok, parsed = srv._validate_playground_envelope(env)
    assert ok is True
    assert parsed["body"] == b"hello"


def test_validate_body_non_string_rejected(srv):
    env = _ok_bearer()
    env["body"] = {"json": "not allowed at envelope layer"}
    ok, _err = srv._validate_playground_envelope(env)
    assert ok is False


def test_validate_timeout_clamped(srv):
    env = _ok_bearer()
    env["timeout"] = 9999
    ok, parsed = srv._validate_playground_envelope(env)
    assert ok is True
    assert parsed["timeout"] == srv._PLAYGROUND_MAX_TIMEOUT


def test_validate_timeout_floor(srv):
    env = _ok_bearer()
    env["timeout"] = 0
    ok, parsed = srv._validate_playground_envelope(env)
    assert ok is True
    assert parsed["timeout"] == 1


def test_validate_timeout_default(srv):
    env = _ok_bearer()
    env.pop("timeout", None)
    ok, parsed = srv._validate_playground_envelope(env)
    assert ok is True
    assert parsed["timeout"] == srv._PLAYGROUND_DEFAULT_TIMEOUT


def test_validate_timeout_non_int(srv):
    env = _ok_bearer()
    env["timeout"] = "soon"
    ok, _err = srv._validate_playground_envelope(env)
    assert ok is False


def test_validate_envelope_passes_sanitizer_error_through(srv):
    env = _ok_bearer()
    env["headers"] = {"X-Bad": "value\r\nX-Inject: yes"}
    ok, err = srv._validate_playground_envelope(env)
    assert ok is False
    assert err["error"] == "bad_header"


def test_validate_envelope_strips_auth_silently(srv):
    env = _ok_bearer()
    env["headers"] = {"Authorization": "Bearer fake", "Accept": "application/xml"}
    ok, parsed = srv._validate_playground_envelope(env)
    assert ok is True
    assert "Authorization" not in parsed["headers"]
    assert parsed["headers"]["Accept"] == "application/xml"


def test_validate_envelope_must_be_dict(srv):
    ok, err = srv._validate_playground_envelope("not a dict")
    assert ok is False
    assert err["error"] == "bad_request"


# ── _compose_playground_bearer_url ───────────────────────────────────────


def test_compose_v1_path_passes_through(srv):
    url = srv._compose_playground_bearer_url("/v1/workspaces/abc")
    assert url == srv.REDIRECT_HOST + "/v1/workspaces/abc"


def test_compose_v1_0_path_passes_through(srv):
    url = srv._compose_playground_bearer_url("/v1.0/admin/items")
    assert url == srv.REDIRECT_HOST + "/v1.0/admin/items"


def test_compose_metadata_path_passes_through(srv):
    url = srv._compose_playground_bearer_url("/metadata/workspaces")
    assert url == srv.REDIRECT_HOST + "/metadata/workspaces"


def test_compose_legacy_workspaces_uses_map_path(srv):
    # /workspaces (top level) should be rewritten to /metadata/workspaces via _map_path
    url = srv._compose_playground_bearer_url("/workspaces")
    assert url == srv.REDIRECT_HOST + "/metadata/workspaces"
