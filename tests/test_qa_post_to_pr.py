"""F27 P6 — Post-to-PR endpoint tests.

The studio's QA Results stage POSTs a markdown payload to the dev-server
proxy endpoint ``/api/ado-proxy/pr-comment``; the proxy in turn calls the
Azure DevOps "threads" REST API. These tests exercise the proxy
end-to-end against an in-process mock ADO server so we don't need a real
PAT or network access.

Coverage:
  - shape guards: missing ``prUrl`` / ``markdown`` → 400.
  - oversize body → 413.
  - bad PR URL → 400 from the parser.
  - happy path: dev-server forwards ``{ comments, status }`` to the ADO
    Threads API and translates the response into ``{ threadId,
    commentId, threadUrl, prId }``.
  - ADO 4xx propagates as ``ado_http_<code>`` with status 401/502.

The dev-server's ``_get_ado_token`` is monkey-patched to return a fixed
fake token so we never shell out to ``az``.
"""

from __future__ import annotations

import importlib.util
import json
import socket
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
DEV_SERVER_PATH = SCRIPTS_DIR / "dev-server.py"


# ── Helpers ──────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def dev_server_module():
    """Import scripts/dev-server.py as a module (it has helpers we exercise)."""
    if not DEV_SERVER_PATH.exists():
        pytest.fail(f"dev-server.py missing at {DEV_SERVER_PATH}")
    # dev-server imports sibling modules (feature_flags_catalog etc.) by
    # bare name; put scripts/ on sys.path first.
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location("devserver_under_test", DEV_SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _MockAdoHandler(BaseHTTPRequestHandler):
    """In-process ADO stand-in. The dev-server proxy will hit this."""

    # Class-level switches so tests can re-program responses.
    response_status: ClassVar[int] = 200
    response_body: ClassVar[dict] = {
        "id": 9999,
        "comments": [{"id": 7777}],
    }

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        # Stash the last request body on the class so the test can assert
        # on what the dev-server forwarded.
        _MockAdoHandler.last_request_path = self.path
        _MockAdoHandler.last_request_body = payload
        _MockAdoHandler.last_auth_header = self.headers.get("Authorization", "")

        status = type(self).response_status
        body = json.dumps(type(self).response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args, **kwargs):  # silence test noise
        pass


@pytest.fixture
def mock_ado_server(monkeypatch, dev_server_module):
    """Spin up a mock ADO server and redirect the dev-server's POST to it.

    The dev-server builds the ADO threads URL itself
    (``https://dev.azure.com/<org>/.../threads``); we monkey-patch
    ``urllib.request.urlopen`` *inside the dev-server module* to swap
    that target with our local server, while keeping all other request
    handling identical.
    """
    port = _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _MockAdoHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # Reset class state between tests.
    _MockAdoHandler.response_status = 200
    _MockAdoHandler.response_body = {"id": 9999, "comments": [{"id": 7777}]}
    _MockAdoHandler.last_request_path = None
    _MockAdoHandler.last_request_body = None
    _MockAdoHandler.last_auth_header = None

    real_urlopen = dev_server_module.urllib.request.urlopen

    def fake_urlopen(req, *args, **kwargs):
        # The dev-server passes a urllib.request.Request whose host
        # points at dev.azure.com. Rewrite to our mock.
        if isinstance(req, urllib.request.Request) and "dev.azure.com" in req.full_url:
            new_url = f"http://127.0.0.1:{port}/_mock_ado"
            new_req = urllib.request.Request(
                new_url,
                data=req.data,
                method=req.get_method(),
                headers=dict(req.header_items()),
            )
            return real_urlopen(new_req, *args, **kwargs)
        return real_urlopen(req, *args, **kwargs)

    monkeypatch.setattr(dev_server_module.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(dev_server_module, "_get_ado_token", lambda: "FAKE-TOKEN")

    try:
        yield {"server": server, "port": port, "handler": _MockAdoHandler}
    finally:
        server.shutdown()
        server.server_close()


def _start_dev_server(dev_server_module):
    """Start the dev-server's HTTP handler on a free port and return base URL."""
    handler_cls = dev_server_module.EdogDevHandler
    port = _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Give it a beat to bind.
    time.sleep(0.05)
    return server, f"http://127.0.0.1:{port}"


# ── Tests ────────────────────────────────────────────────────────────────


def test_endpoint_handler_exists_in_source():
    """A regression guard so the endpoint can never be deleted without
    failing this test even before the integration tests run."""
    src = DEV_SERVER_PATH.read_text(encoding="utf-8")
    assert "_serve_ado_pr_comment" in src
    assert "/api/ado-proxy/pr-comment" in src
    # Reuses the existing PAT acquisition path.
    assert "_get_ado_token()" in src
    # Defensive guard on payload size.
    assert "150_000" in src
    # Uses ADO Threads API v7.1.
    assert "/threads?api-version=7.1" in src


def test_post_to_pr_happy_path(dev_server_module, mock_ado_server):
    server, base = _start_dev_server(dev_server_module)
    try:
        req = urllib.request.Request(
            base + "/api/ado-proxy/pr-comment",
            data=json.dumps(
                {
                    "prUrl": "https://dev.azure.com/microsoft/Fabric/_git/Workload/pullrequest/42",
                    "markdown": "## QA Results\n\nAll passed.\n",
                }
            ).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())

        assert body["threadId"] == 9999
        assert body["commentId"] == 7777
        assert body["prId"] == 42
        assert body["threadUrl"].startswith(
            "https://dev.azure.com/microsoft/Fabric/_git/Workload/pullrequest/42?discussionId="
        )

        # The dev-server must have forwarded the markdown in the
        # ADO-expected envelope.
        sent = _MockAdoHandler.last_request_body
        assert sent["status"] == 1
        assert len(sent["comments"]) == 1
        assert sent["comments"][0]["content"] == "## QA Results\n\nAll passed.\n"
        assert sent["comments"][0]["commentType"] == 1
        assert _MockAdoHandler.last_auth_header == "Bearer FAKE-TOKEN"
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize(
    "body,expected_status,expected_error_substring",
    [
        ({}, 400, "prUrl"),
        ({"prUrl": "https://dev.azure.com/o/p/_git/r/pullrequest/1"}, 400, "markdown"),
        (
            {"prUrl": "not-an-ado-url", "markdown": "hi"},
            400,
            "invalid_pr_url",
        ),
    ],
)
def test_post_to_pr_validates_inputs(
    dev_server_module, mock_ado_server, body, expected_status, expected_error_substring
):
    server, base = _start_dev_server(dev_server_module)
    try:
        req = urllib.request.Request(
            base + "/api/ado-proxy/pr-comment",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            pytest.fail("Expected HTTPError but got 200")
        except urllib.error.HTTPError as e:
            assert e.code == expected_status
            err_body = json.loads(e.read())
            err_text = json.dumps(err_body).lower()
            assert expected_error_substring.lower() in err_text, err_body
        # The mock ADO must NOT have been called on a validation failure.
        assert _MockAdoHandler.last_request_body is None
    finally:
        server.shutdown()
        server.server_close()


def test_post_to_pr_rejects_oversize_markdown(dev_server_module, mock_ado_server):
    server, base = _start_dev_server(dev_server_module)
    try:
        body = {
            "prUrl": "https://dev.azure.com/o/p/_git/r/pullrequest/1",
            "markdown": "x" * 160_000,  # over the 150K guard
        }
        req = urllib.request.Request(
            base + "/api/ado-proxy/pr-comment",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            pytest.fail("Expected 413 but got 200")
        except urllib.error.HTTPError as e:
            assert e.code == 413
            err_body = json.loads(e.read())
            assert "150KB" in err_body.get("message", "") or err_body.get("error") == "comment_too_large"
        assert _MockAdoHandler.last_request_body is None
    finally:
        server.shutdown()
        server.server_close()


def test_post_to_pr_propagates_ado_auth_failure(dev_server_module, mock_ado_server):
    """If ADO returns 401, the dev-server must surface it as a 401 with a
    typed error code, not collapse it into a generic 500."""
    _MockAdoHandler.response_status = 401
    _MockAdoHandler.response_body = {"message": "TF400813: not authorized"}

    server, base = _start_dev_server(dev_server_module)
    try:
        req = urllib.request.Request(
            base + "/api/ado-proxy/pr-comment",
            data=json.dumps(
                {
                    "prUrl": "https://dev.azure.com/o/p/_git/r/pullrequest/1",
                    "markdown": "hi",
                }
            ).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            pytest.fail("Expected HTTPError")
        except urllib.error.HTTPError as e:
            assert e.code == 401
            err_body = json.loads(e.read())
            assert err_body["error"] == "ado_http_401"
            assert "ADO returned 401" in err_body["message"]
    finally:
        server.shutdown()
        server.server_close()
