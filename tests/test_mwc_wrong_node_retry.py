"""Regression tests for the MWC priority-placement-wrong-node retry helper.

Background
----------
The Fabric capacity gateway (MWC's ScaleOutRoutingMiddleware) returns HTTP 400
with header ``x-ms-priority-placement-wrong-node: <core-service>`` when a
request lands on the wrong core-service pod. The fix is to retry with
``x-ms-routing-hint: <core-service>``.

These tests pin the helper's retry contract so the DAG Studio outage caused by
unhandled wrong-node 400s cannot regress silently.

Verified live 2026-05-26:
  - Bare GET /liveTable/getLatestDag → 400, ``wrong-node: host002_livetable-003``
  - Same GET + ``x-ms-routing-hint: host002_livetable-003`` → 200 (full DAG)
"""

from __future__ import annotations

import importlib.util
import io
import sys
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from unittest.mock import patch

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


# ---------------------------------------------------------------------------
# Helpers for building fake urllib responses
# ---------------------------------------------------------------------------


def _build_wrong_node_error(url, hint="host002_livetable-003"):
    """Return an HTTPError that mimics the live capacity-gateway wrong-node 400."""
    headers = Message()
    headers["Content-Length"] = "0"
    headers["Content-Type"] = "application/octet-stream"
    headers["x-ms-priority-placement-wrong-node"] = hint
    return urllib.error.HTTPError(url, 400, "Bad Request", headers, io.BytesIO(b""))


def _build_plain_400(url):
    """A 400 *without* the wrong-node header — must NOT trigger a retry."""
    headers = Message()
    headers["Content-Type"] = "application/json"
    return urllib.error.HTTPError(url, 400, "Bad Request", headers, io.BytesIO(b'{"error":"validation"}'))


class _FakeResponse:
    """Minimal context-manager that mimics ``http.client.HTTPResponse``."""

    def __init__(self, status=200, body=b'{"ok":true}', headers=None):
        self.status = status
        self.reason = "OK"
        self._body = body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, *_args, **_kwargs):
        return self._body


# ---------------------------------------------------------------------------
# Constants exist (drift guard — if these names change, every proxy breaks)
# ---------------------------------------------------------------------------


def test_constants_match_protocol(srv):
    """The header-name constants must match the wire protocol exactly."""
    assert srv.MWC_PRIORITY_PLACEMENT_WRONG_NODE_HEADER == "x-ms-priority-placement-wrong-node"
    assert srv.MWC_ROUTING_HINT_HEADER == "x-ms-routing-hint"


def test_helper_is_exported(srv):
    """The retry helper exists and is callable."""
    assert callable(srv._urlopen_with_mwc_retry)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_first_attempt_success_does_not_add_routing_hint(srv):
    """When upstream returns 200 on the first try, the hint header is never added."""
    req = urllib.request.Request("https://example/v1/foo", method="GET")
    req.add_header("Authorization", "MwcToken xyz")

    expected = _FakeResponse(status=200, body=b'{"name":"dag"}')

    with (
        patch.object(urllib.request, "urlopen", return_value=expected) as mock_open,
        srv._urlopen_with_mwc_retry(req, None, timeout=5, max_retries=3, label="t1") as resp,
    ):
        assert resp.read() == b'{"name":"dag"}'

    assert mock_open.call_count == 1
    assert "X-ms-routing-hint" not in req.headers  # urllib stores headers capitalize-folded


# ---------------------------------------------------------------------------
# Retry behavior on wrong-node 400
# ---------------------------------------------------------------------------


def test_wrong_node_400_triggers_retry_with_routing_hint(srv):
    """First call returns wrong-node 400; second call must include x-ms-routing-hint."""
    target_url = "https://capacity/v1/getLatestDag"
    req = urllib.request.Request(target_url, method="GET")
    req.add_header("Authorization", "MwcToken xyz")

    seen_routing_hints = []
    call_count = {"n": 0}

    def fake_urlopen(request, timeout=None, context=None):
        seen_routing_hints.append(request.headers.get("X-ms-routing-hint"))
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise _build_wrong_node_error(target_url, hint="host002_livetable-003")
        return _FakeResponse(status=200, body=b'{"dag":"ok"}')

    with (
        patch.object(urllib.request, "urlopen", side_effect=fake_urlopen),
        srv._urlopen_with_mwc_retry(req, None, timeout=5, max_retries=3, label="t2") as resp,
    ):
        assert resp.read() == b'{"dag":"ok"}'

    assert call_count["n"] == 2, "should have retried exactly once"
    assert seen_routing_hints == [None, "host002_livetable-003"]


def test_routing_hint_is_overwritten_not_duplicated_across_retries(srv):
    """A second wrong-node 400 must overwrite (not duplicate) the routing hint."""
    target_url = "https://capacity/v1/foo"
    req = urllib.request.Request(target_url, method="GET")
    req.add_header("Authorization", "MwcToken xyz")

    hints_in_order = ["host001_livetable-007", "host002_livetable-003"]
    seen_routing_hints = []
    call_count = {"n": 0}

    def fake_urlopen(request, timeout=None, context=None):
        seen_routing_hints.append(request.headers.get("X-ms-routing-hint"))
        call_count["n"] += 1
        if call_count["n"] <= 2:
            raise _build_wrong_node_error(target_url, hint=hints_in_order[call_count["n"] - 1])
        return _FakeResponse(status=200, body=b'{"ok":true}')

    with (
        patch.object(urllib.request, "urlopen", side_effect=fake_urlopen),
        srv._urlopen_with_mwc_retry(req, None, timeout=5, max_retries=3, label="t3") as resp,
    ):
        resp.read()

    assert call_count["n"] == 3
    assert seen_routing_hints == [None, hints_in_order[0], hints_in_order[1]]
    # Even after multiple retries there must be only one routing-hint header on the request
    assert sum(1 for k in req.headers if k.lower() == "x-ms-routing-hint") == 1


# ---------------------------------------------------------------------------
# Non-retryable failure paths
# ---------------------------------------------------------------------------


def test_400_without_wrong_node_header_is_not_retried(srv):
    """A plain 400 (validation error, missing param, etc.) must propagate immediately."""
    target_url = "https://capacity/v1/badreq"
    req = urllib.request.Request(target_url, method="POST", data=b"{}")

    call_count = {"n": 0}

    def fake_urlopen(request, timeout=None, context=None):
        call_count["n"] += 1
        raise _build_plain_400(target_url)

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            srv._urlopen_with_mwc_retry(req, None, timeout=5, max_retries=3, label="t4")
        assert exc_info.value.code == 400

    assert call_count["n"] == 1, "must NOT retry on 400 without wrong-node header"


def test_500_is_not_retried(srv):
    """A 500 from upstream is not a routing miss — it must propagate, not retry."""
    target_url = "https://capacity/v1/boom"
    req = urllib.request.Request(target_url, method="GET")

    headers = Message()
    headers["Content-Type"] = "application/json"

    def fake_urlopen(request, timeout=None, context=None):
        raise urllib.error.HTTPError(target_url, 500, "Internal Error", headers, io.BytesIO(b"boom"))

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen) as mock_open:
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            srv._urlopen_with_mwc_retry(req, None, timeout=5, max_retries=3, label="t5")
        assert exc_info.value.code == 500

    assert mock_open.call_count == 1


def test_retries_exhausted_raises_last_error(srv):
    """If wrong-node 400 persists, raise after ``max_retries`` attempts."""
    target_url = "https://capacity/v1/stubborn"
    req = urllib.request.Request(target_url, method="GET")

    call_count = {"n": 0}

    def fake_urlopen(request, timeout=None, context=None):
        call_count["n"] += 1
        raise _build_wrong_node_error(target_url, hint="host003_livetable-001")

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            srv._urlopen_with_mwc_retry(req, None, timeout=5, max_retries=2, label="t6")
        assert exc_info.value.code == 400

    # max_retries=2 means up to 3 attempts (initial + 2 retries)
    assert call_count["n"] == 3, f"expected 3 attempts, got {call_count['n']}"


# ---------------------------------------------------------------------------
# Call-site wiring — pin that _proxy_to_flt and friends actually use the helper
# (a future refactor that drops the retry must explicitly update these tests).
# ---------------------------------------------------------------------------


def test_proxy_to_flt_calls_retry_helper(srv):
    """``_proxy_to_flt`` must invoke ``_urlopen_with_mwc_retry`` — protects against
    a regression that re-introduces a bare ``urlopen`` on the DAG Studio path."""
    source = DEV_SERVER.read_text(encoding="utf-8")
    # locate the _proxy_to_flt body
    marker = "def _proxy_to_flt"
    idx = source.find(marker)
    assert idx >= 0, "_proxy_to_flt method not found in dev-server.py"
    # next def starts the next method — examine just this method's body
    next_idx = source.find("\n    def ", idx + len(marker))
    body = source[idx:next_idx if next_idx > 0 else None]
    assert "_urlopen_with_mwc_retry" in body, (
        "_proxy_to_flt must use _urlopen_with_mwc_retry to handle MWC priority-"
        "placement wrong-node 400s; otherwise DAG Studio breaks whenever the "
        "request lands on the wrong core-service pod."
    )
    # And the explicit bare urlopen on the LiveTable capacity path must be gone.
    # (The MWC token gen at /metadata/v201606/generatemwctoken still uses a bare
    # urlopen — that endpoint doesn't return wrong-node, only the capacity does.)
    assert "urllib.request.urlopen(req, timeout=30, context=ctx)" not in body, (
        "Bare urlopen detected in _proxy_to_flt — should go through _urlopen_with_mwc_retry"
    )
