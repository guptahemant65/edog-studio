"""Runtime swagger.json fetcher for the FLT workload.

SF-003: server-side helper that retrieves the live OpenAPI spec from a
running FLT instance via the Fabric capacity endpoint. The swagger document
is served at the workload root (`/swagger/v1/swagger.json`), NOT under the
workspace/lakehouse path — so we cannot reuse `_proxy_to_flt` directly.

Module is import-safe (no I/O at module load) and pure-function: every
helper takes its dependencies as arguments. dev-server.py composes them.

Typical call:

    payload, error = fetch_runtime_swagger(
        bearer="ey...",
        ws_id=cfg["workspace_id"],
        art_id=cfg["artifact_id"],
        cap_id=cfg["capacity_id"],
        token_provider=_get_mwc_token,
        http_get=_http_get_json,
    )
    if error:
        ...
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Any, Callable

SWAGGER_RELATIVE_PATH = "/swagger/v1/swagger.json"
WORKLOAD_NAME = "LiveTable"
WORKLOAD_SERVICE = "LiveTableService"

# Bound the swagger document we'll accept — Swashbuckle output for a workload
# the size of FLT is typically 200-800 KB. 16 MB is "no way this is right."
MAX_SWAGGER_BYTES = 16 * 1024 * 1024


def compose_swagger_url(host: str, cap_id: str) -> str:
    """Return the full URL to the FLT swagger.json on the Fabric capacity edge.

    The path matches what Fabric advertises externally:
        {host}/webapi/capacities/{cap_id}/workloads/LiveTable/LiveTableService
        /automatic/swagger/v1/swagger.json
    """
    return (
        f"{host}/webapi/capacities/{cap_id}/workloads/{WORKLOAD_NAME}"
        f"/{WORKLOAD_SERVICE}/automatic{SWAGGER_RELATIVE_PATH}"
    )


def _default_http_get_json(url: str, headers: dict, timeout: float = 30.0) -> tuple[bytes, int, dict]:
    """Default fetcher used when callers don't inject one.

    Returns (body_bytes, status_code, headers_dict). Raises on transport error.
    Kept simple — TLS context is default, no proxy, no retries (callers handle).
    """
    req = urllib.request.Request(url, method="GET")
    for k, v in headers.items():
        req.add_header(k, v)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        body = resp.read(MAX_SWAGGER_BYTES + 1)
        if len(body) > MAX_SWAGGER_BYTES:
            raise ValueError(
                f"Swagger response exceeds {MAX_SWAGGER_BYTES} bytes — refusing to load"
            )
        return body, resp.status, dict(resp.headers.items())


def fetch_runtime_swagger(
    bearer: str | None,
    ws_id: str,
    art_id: str,
    cap_id: str,
    *,
    token_provider: Callable[[str, str, str, str], tuple[str, str]],
    http_get: Callable[[str, dict, float], tuple[bytes, int, dict]] | None = None,
    timeout: float = 30.0,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Fetch the live swagger.json from the running FLT instance.

    Args:
        bearer: AAD bearer token (used to mint an MWC token). If empty, returns
            an `unauthenticated` error.
        ws_id, art_id, cap_id: Fabric identifiers used to scope the MWC token.
        token_provider: function(bearer, ws_id, art_id, cap_id) -> (token, host).
            Injected so tests don't need real Fabric. Production passes
            dev-server's `_get_mwc_token`.
        http_get: function(url, headers, timeout) -> (body, status, headers).
            Defaults to urllib over TLS. Injected for tests.
        timeout: per-request timeout in seconds.

    Returns:
        (swagger_dict, None) on success.
        (None, {"error": ..., "message": ..., "status": ...}) on failure.
        Errors:
          - "missing-config":       ws/art/cap empty
          - "unauthenticated":      no bearer token cached
          - "mwc-token-failed":     token_provider raised
          - "flt-not-running":      connection refused / timeout
          - "spec-http-error":      non-2xx from swagger endpoint
          - "spec-not-json":        body wasn't parseable JSON
          - "spec-too-large":       body exceeded MAX_SWAGGER_BYTES
    """
    if not ws_id or not art_id or not cap_id:
        return None, {
            "error": "missing-config",
            "message": "workspace_id / artifact_id / capacity_id missing from config",
            "status": 503,
        }
    if not bearer:
        return None, {
            "error": "unauthenticated",
            "message": "No bearer token cached — sign in first",
            "status": 401,
        }

    try:
        mwc_token, host = token_provider(bearer, ws_id, art_id, cap_id)
    except Exception as exc:  # noqa: BLE001 — surface as structured error
        return None, {
            "error": "mwc-token-failed",
            "message": str(exc),
            "status": 502,
        }

    url = compose_swagger_url(host, cap_id)
    fetcher = http_get or _default_http_get_json
    headers = {"Authorization": f"MwcToken {mwc_token}", "Accept": "application/json"}

    try:
        body, status, _resp_headers = fetcher(url, headers, timeout)
    except ValueError as exc:
        return None, {
            "error": "spec-too-large",
            "message": str(exc),
            "status": 502,
        }
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return None, {
            "error": "spec-http-error",
            "message": f"swagger endpoint returned {exc.code}: {exc.reason}",
            "detail": err_body,
            "status": exc.code,
        }
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return None, {
            "error": "flt-not-running",
            "message": f"could not reach swagger endpoint: {exc}",
            "status": 503,
        }

    if status < 200 or status >= 300:
        return None, {
            "error": "spec-http-error",
            "message": f"swagger endpoint returned status {status}",
            "status": status,
        }

    try:
        text = body.decode("utf-8", errors="replace")
        doc = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, {
            "error": "spec-not-json",
            "message": f"swagger response was not valid JSON: {exc}",
            "status": 502,
        }

    if not isinstance(doc, dict):
        return None, {
            "error": "spec-not-json",
            "message": "swagger response was JSON but not an object",
            "status": 502,
        }

    return doc, None
